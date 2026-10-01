import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { assertEditable } from '../../core/processEngine.js';
import { assertIssuable, insertProcessIssue } from './processFlow.routes.js';
import { assertJobLots } from '../stock/jobStock.routes.js';

/**
 * Yarn process DC — outward to the dyer / winder / twister and inward back
 * (client voice note: "like the knitting program has outward and inward, how
 * do we give outward and receive inward for yarn dyeing / winding?").
 *
 *   POST /yarn-process-dcs            outward DC: yarn KG (+ cones) leaves our store (stock ledger ISSUE)
 *   GET  /yarn-process-dcs            one row per DC: issued, received, pending at the processor
 *   GET  /yarn-process-dcs/:dcNo      DC lines + inwards received against it
 *   inward: POST /process-receipts with src_type YARN_PROCESS and ref_dc_no = the DC
 *           (checked against the DC's pending KG, QC → post stock as before)
 */
export const yarnProcessDcRouter = Router();

const num = (v: unknown) => Number(v ?? 0) || 0;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const PROC_LABEL: Record<string, string> = { YARN_DYEING: 'Yarn Dyeing', WINDING: 'Winding', TWISTING: 'Twisting' };

const dcLine = z.object({
  yarn_id: s.id(),
  /** Yarn GRN lot picked from the job's stock (PO → GRN traceability). */
  grn_line_id: s.id(),
  lot_no: s.nullableStr(80),
  yarn_po_no: s.nullableStr(80),
  issued_qty_kg: z.coerce.number().min(0).default(0),
  no_of_cones: z.coerce.number().int().min(0).default(0),
});
const dcSchema = z.object({
  /** One DC can carry several jobs (yarn processes) to the same processor. */
  jobs: z.array(z.object({ process_id: s.idReq(), lines: z.array(dcLine).default([]) })).optional(),
  process_id: s.id(),
  lines: z.array(dcLine).optional(),
  dc_no: s.nullableStr(60),
  dc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor_id: s.id(),
  vehicle_no: s.nullableStr(30),
  warehouse_id: s.id(),
  allow_override: z.coerce.boolean().default(false),
  override_reason: s.nullableStr(255),
  remarks: s.text(),
});

yarnProcessDcRouter.post('/yarn-process-dcs', requirePermission('PROCESS.ISSUE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = dcSchema.parse(req.body);
  const jobs = (body.jobs?.length ? body.jobs : (body.process_id ? [{ process_id: body.process_id, lines: body.lines ?? [] }] : []))
    .map((j) => ({ ...j, lines: j.lines.filter((l) => l.issued_qty_kg > 0) })).filter((j) => j.lines.length);
  if (!jobs.length) throw BadRequest('Enter the KG to send on at least one yarn line');
  if (new Set(jobs.map((j) => j.process_id)).size !== jobs.length) throw BadRequest('A job / process is on the DC twice');

  const procs = new Map<number, any>();
  for (const j of jobs) {
    const proc = await queryOne<any>(`SELECT * FROM trx_yarn_process WHERE id = ? AND company_id = ?`, [j.process_id, cid]);
    if (!proc) throw NotFound('Yarn process not found');
    assertEditable(proc.status, 'yarn process');
    if (proc.status === 'DRAFT') throw BadRequest(`Release process ${proc.process_no} before giving the outward DC`);
    procs.set(j.process_id, proc);
  }
  const first = procs.get(jobs[0].process_id);
  const types = new Set([...procs.values()].map((p) => p.process_type));
  if (types.size > 1) throw BadRequest('All jobs on one DC must be the same process (dyeing / winding / twisting)');
  const vendorId = body.vendor_id ?? first.vendor_id;
  if (!vendorId) throw BadRequest('Select the processor (supplier / vendor) the yarn is going to');
  const warehouseId = body.warehouse_id ?? first.warehouse_id;
  if (!warehouseId) throw BadRequest('Select the store the yarn is issued from');

  // yarn lots must belong to the job of the line (or general stock)
  await assertJobLots(cid, jobs.flatMap((j) => j.lines.map((l) => ({
    grn_line_id: l.grn_line_id, so_id: procs.get(j.process_id).so_id, yarn_id: Number(l.yarn_id ?? procs.get(j.process_id).yarn_id),
    issued_qty_kg: l.issued_qty_kg, label: `${procs.get(j.process_id).process_no} (${procs.get(j.process_id).io_no ?? 'stock'})` }))));

  // Stock check per line (earlier lines of this DC on the same yarn count),
  // with each process's own reservation covering its own issue.
  const plan: { proc: any; line: z.infer<typeof dcLine>; yarnId: number; reservationId: number | null; exceeds: boolean }[] = [];
  const taken = new Map<number, number>();
  for (const j of jobs) {
    const proc = procs.get(j.process_id);
    for (const l of j.lines) {
      const yarnId = l.yarn_id ?? proc.yarn_id;
      if (!yarnId) throw BadRequest('Each DC line needs a yarn');
      const resv = await queryOne<any>(
        `SELECT id, reserved_qty_kg - released_qty_kg AS open_kg FROM trx_process_reservation
          WHERE company_id = ? AND src_type = 'YARN_PROCESS' AND src_id = ? AND yarn_id = ? AND status IN ('ACTIVE','PARTIAL')
          ORDER BY id LIMIT 1`, [cid, j.process_id, yarnId]);
      const already = taken.get(yarnId) ?? 0;
      const exceeds = await assertIssuable(req.user!, {
        yarn_id: yarnId, warehouse_id: warehouseId, issued_qty_kg: l.issued_qty_kg,
        allow_override: body.allow_override, override_reason: body.override_reason,
        alreadyKg: already, ownReservationKg: Math.max(0, num(resv?.open_kg)),
      });
      taken.set(yarnId, already + l.issued_qty_kg);
      plan.push({ proc, line: l, yarnId, reservationId: resv ? Number(resv.id) : null, exceeds });
    }
  }

  const result = await transaction(async (tx) => {
    const dcNo = body.dc_no || await nextDocNumber(tx, cid, 'YARN_PROC_DC');
    const dup = await txQueryOne<any>(tx, `SELECT id FROM trx_process_issue WHERE company_id = ? AND dc_no = ? LIMIT 1`, [cid, dcNo]);
    if (dup) throw BadRequest(`DC number ${dcNo} is already used`);
    const issues = [];
    for (const p of plan) {
      const lot = p.line.grn_line_id ? await txQueryOne<any>(tx,
        `SELECT gl.lot_no, po.po_no FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
           LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) WHERE gl.id = ?`, [p.line.grn_line_id]) : null;
      issues.push(await insertProcessIssue(tx, cid, uid, {
        src_type: 'YARN_PROCESS', src_id: p.proc.id, src_line_id: null, reservation_id: p.reservationId,
        issue_no: null, issue_date: body.dc_date, yarn_id: p.yarnId, batch_id: null,
        lot_no: lot?.lot_no ?? p.line.lot_no ?? null, yarn_po_no: lot?.po_no ?? p.line.yarn_po_no ?? null,
        warehouse_id: warehouseId, issued_qty_kg: p.line.issued_qty_kg,
        allow_override: body.allow_override, override_reason: body.override_reason ?? null, remarks: body.remarks ?? null,
        dc_no: dcNo, vendor_id: vendorId, vehicle_no: body.vehicle_no ?? null, no_of_cones: p.line.no_of_cones,
        grn_line_id: p.line.grn_line_id ?? null, so_id: p.proc.so_id ?? null, io_no: p.proc.io_no ?? null,
      }, p.exceeds));
    }
    return { dc_no: dcNo, process_no: [...procs.values()].map((x) => x.process_no).join(', '), jobs: jobs.length,
             issued_kg: r3(plan.reduce((a, p) => a + p.line.issued_qty_kg, 0)), issues };
  });

  await audit(req, 'trx_process_issue', jobs[0].process_id, 'INSERT', undefined, { action: 'YARN_PROCESS_DC', ...result });
  res.status(201).json({ success: true, data: result });
}));

/** One row per DC (all its jobs) with issued / received / pending at the processor. */
yarnProcessDcRouter.get('/yarn-process-dcs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = [`i.company_id = ?`, `i.src_type = 'YARN_PROCESS'`, `i.dc_no IS NOT NULL`];
  const params: unknown[] = [cid];
  if (req.query.process_id) {
    where.push(`i.dc_no IN (SELECT dc_no FROM trx_process_issue WHERE company_id = ? AND src_type = 'YARN_PROCESS' AND src_id = ?)`);
    params.push(cid, Number(req.query.process_id));
  }
  if (req.query.vendor_id) { where.push('i.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  const rows = await query<any>(
    `SELECT i.dc_no, MIN(i.issue_date) AS dc_date, MIN(i.src_id) AS process_id,
            GROUP_CONCAT(DISTINCT yp.process_no ORDER BY yp.process_no SEPARATOR ', ') AS process_no, MAX(yp.process_type) AS process_type,
            GROUP_CONCAT(DISTINCT yp.io_no ORDER BY yp.io_no SEPARATOR ', ') AS io_no, COUNT(DISTINCT i.src_id) AS job_count,
            MAX(i.vendor_id) AS vendor_id, MAX(p.party_name) AS vendor_name, MAX(i.vehicle_no) AS vehicle_no,
            COUNT(*) AS line_count, SUM(i.issued_qty_kg) AS issued_kg, SUM(i.no_of_cones) AS cones,
            (SELECT COALESCE(SUM(r.input_qty), 0) FROM trx_process_receipt r WHERE r.company_id = i.company_id AND r.src_type = 'YARN_PROCESS' AND r.ref_dc_no = i.dc_no) AS received_kg,
            (SELECT COALESCE(SUM(r.output_qty), 0) FROM trx_process_receipt r WHERE r.company_id = i.company_id AND r.src_type = 'YARN_PROCESS' AND r.ref_dc_no = i.dc_no) AS output_kg
       FROM trx_process_issue i
       JOIN trx_yarn_process yp ON yp.id = i.src_id
       LEFT JOIN mst_party p ON p.id = i.vendor_id
      WHERE ${where.join(' AND ')}
      GROUP BY i.dc_no, i.company_id
      ORDER BY dc_date DESC, i.dc_no DESC LIMIT 500`, params);
  const data = rows.map((r) => {
    const pending = r3(num(r.issued_kg) - num(r.received_kg));
    return { ...r, process_label: PROC_LABEL[r.process_type] ?? r.process_type, issued_kg: r3(num(r.issued_kg)),
      received_kg: r3(num(r.received_kg)), output_kg: r3(num(r.output_kg)), pending_kg: pending,
      status: num(r.received_kg) <= 0 ? 'ISSUED' : pending > 0 ? 'PARTIAL_RECEIVED' : 'RECEIVED' };
  });
  const open = String(req.query.status ?? '') === 'OPEN';
  res.json({ success: true, data: open ? data.filter((d) => d.pending_kg > 0) : data });
}));

/** DC detail: lines grouped by job with each job's receipts and pending KG (inward is job-wise). */
yarnProcessDcRouter.get('/yarn-process-dcs/:dcNo', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dcNo = String(req.params.dcNo);
  const lines = await query<any>(
    `SELECT i.*, y.yarn_code, y.yarn_name, w.warehouse_name, p.party_name AS vendor_name, g.grn_no, g.supplier_inv_no
       FROM trx_process_issue i
       LEFT JOIN mst_yarn y ON y.id = i.yarn_id
       LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id
       LEFT JOIN mst_party p ON p.id = i.vendor_id
       LEFT JOIN trx_grn_line gl ON gl.id = i.grn_line_id LEFT JOIN trx_grn g ON g.id = gl.grn_id
      WHERE i.company_id = ? AND i.dc_no = ? AND i.src_type = 'YARN_PROCESS' ORDER BY i.src_id, i.id`, [cid, dcNo]);
  if (!lines.length) throw NotFound(`Yarn process DC ${dcNo} not found`);
  const ids = [...new Set(lines.map((l) => Number(l.src_id)))];
  const procs = await query<any>(`SELECT id, process_no, process_type, so_id, io_no, status FROM trx_yarn_process WHERE id IN (?)`, [ids]);
  const receipts = await query<any>(
    `SELECT r.* FROM trx_process_receipt r WHERE r.company_id = ? AND r.ref_dc_no = ? AND r.src_type = 'YARN_PROCESS' ORDER BY r.id`, [cid, dcNo]);
  const jobs = ids.map((pid) => {
    const proc = procs.find((x) => Number(x.id) === pid);
    const ls = lines.filter((l) => Number(l.src_id) === pid);
    const rc = receipts.filter((r) => Number(r.src_id) === pid);
    const iss = r3(ls.reduce((a, l) => a + num(l.issued_qty_kg), 0));
    const rec = r3(rc.reduce((a, r) => a + num(r.input_qty), 0));
    return { process_id: pid, process_no: proc?.process_no, io_no: proc?.io_no, so_id: proc?.so_id, status: proc?.status, lines: ls, receipts: rc,
      issued_kg: iss, received_kg: rec, pending_kg: r3(iss - rec) };
  });
  const issued = r3(lines.reduce((a, l) => a + num(l.issued_qty_kg), 0));
  const received = r3(receipts.reduce((a, r) => a + num(r.input_qty), 0));
  const p0 = procs.find((x) => Number(x.id) === ids[0]);
  res.json({
    success: true,
    data: {
      dc_no: dcNo, dc_date: lines[0].issue_date, vendor_id: lines[0].vendor_id, vendor_name: lines[0].vendor_name,
      vehicle_no: lines[0].vehicle_no, process: p0 ? { ...p0, process_label: PROC_LABEL[p0.process_type] } : null,
      jobs, lines, receipts, issued_kg: issued, received_kg: received, pending_kg: r3(issued - received),
      cones: lines.reduce((a, l) => a + num(l.no_of_cones), 0),
    },
  });
}));
