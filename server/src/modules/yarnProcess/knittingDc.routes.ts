import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute, txQueryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { assertEditable, postLedger, UOM_KG } from '../../core/processEngine.js';
import { assertIssuable, insertProcessIssue } from './processFlow.routes.js';
import { assertJobLots, resolveSoId } from '../stock/jobStock.routes.js';
import { checkDcQuotation, useGateEntry } from '../../core/inwardControls.js';
import { substituteOpen, bookSubstituteIssue } from '../stock/yarnSubstitution.routes.js';

/**
 * Knitting DC (yarn outward to the knitter) and grey fabric inward against it.
 *
 * Client review 27-Sep-2026: a released knitting program sends its yarn out on
 * one DC (many yarn lines), and grey fabric comes back against that DC with the
 * knitter's own DC number. The fabric lands in fabric roll stock so it can go
 * to fabric processing and cutting, and each program shows yarn given vs
 * fabric received, process loss and the balance still at the knitter.
 *
 * The DC reuses the shared process issue (trx_process_issue rows grouped by
 * dc_no), and the inward reuses the process receipt (trx_process_receipt) plus
 * a grey fabric GRN that holds the rolls, so no parallel tables are needed.
 */
export const knittingDcRouter = Router();

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Spread `consumed` KG over yarn lines in proportion to what each was given,
 * never charging a line more than it still had after its returns (overflow
 * moves to the other lines). With no returns this is the plain issued-share
 * split; with returns no line can go negative.
 */
export function allocateConsumed(consumed: number, lines: { issued: number; returned: number }[]): number[] {
  const out = lines.map(() => 0);
  let left = consumed;
  let active = lines.map((_, i) => i).filter((i) => lines[i].issued > 0);
  while (left > 1e-9 && active.length) {
    const weight = active.reduce((n, i) => n + lines[i].issued, 0);
    const capped = active.filter((i) =>
      out[i] + left * lines[i].issued / weight >= lines[i].issued - lines[i].returned - 1e-9);
    if (!capped.length) {
      for (const i of active) out[i] += left * lines[i].issued / weight;
      left = 0;
      break;
    }
    for (const i of capped) {
      const room = Math.max(0, lines[i].issued - lines[i].returned - out[i]);
      out[i] += room;
      left -= room;
    }
    active = active.filter((i) => !capped.includes(i));
  }
  // Anything still left (consumption beyond what was given) lands pro rata.
  if (left > 1e-9) {
    const all = lines.reduce((n, l) => n + l.issued, 0);
    lines.forEach((l, i) => { if (all > 0) out[i] += left * l.issued / all; });
  }
  return out.map(r3);
}

/**
 * Cones at the knitter. `cones_not_returned` is actual (given - returned).
 * Cones used for knitting come back empty or not at all, so the full cones
 * still there are only known when the line is closed (0) — otherwise
 * `cones_balance` is the KG-share estimate, capped by what is not returned.
 */
function conesAtKnitter(given: number, returned: number, issuedKg: number, balanceKg: number) {
  const notReturned = Math.max(0, given - returned);
  if (balanceKg <= 0.0005) return { cones_not_returned: notReturned, cones_balance: 0, cones_estimated: false };
  const est = issuedKg > 0 ? Math.round(given * Math.max(0, balanceKg) / issuedKg) : 0;
  return { cones_not_returned: notReturned, cones_balance: Math.min(est, notReturned), cones_estimated: true };
}

async function loadProgram(id: number, cid: number) {
  const prog = await queryOne<any>(
    `SELECT kp.*, st.style_code, st.style_name, fab.fabric_name, fab.fabric_code,
            p.party_name AS vendor_name, p.gstin AS vendor_gstin, p.phone AS vendor_phone,
            so.so_no
       FROM trx_knitting_program kp
       LEFT JOIN mst_style st ON st.id = kp.style_id
       LEFT JOIN mst_fabric fab ON fab.id = kp.fabric_id
       LEFT JOIN mst_party p ON p.id = kp.vendor_id
       LEFT JOIN trx_sales_order so ON so.id = kp.so_id
      WHERE kp.id = ? AND kp.company_id = ?`, [id, cid]);
  if (!prog) throw NotFound('Knitting program not found');
  return prog;
}

/** A program can go out to the knitter only once it has been released. */
const DC_READY = ['RELEASED', 'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED',
  'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED'];

/* ================================================================
   KNITTING DC — yarn outward
================================================================ */

const dcLine = z.object({
  program_yarn_id: s.id(),
  yarn_id: s.idReq(),
  /** Yarn GRN lot picked from the job's stock (PO → GRN traceability). */
  grn_line_id: s.id(),
  lot_no: s.nullableStr(80),
  yarn_po_no: s.nullableStr(80),
  issued_qty_kg: z.coerce.number().min(0).default(0),
  no_of_cones: z.coerce.number().int().min(0).default(0),
});
const dcSchema = z.object({
  /** One DC can carry several jobs (knitting programs) to the same knitter. */
  jobs: z.array(z.object({
    program_id: s.idReq(), lines: z.array(dcLine).default([]),
    /** The job's own approved knitting quotation (rates vary a little job to job); falls back to the DC-level one. */
    quotation_id: s.id(), quotation_line_id: s.id(), rate_per_kg: z.coerce.number().min(0).nullish(),
  })).optional(),
  program_id: s.id(),
  lines: z.array(dcLine).optional(),
  dc_no: s.nullableStr(60),
  dc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor_id: s.id(),
  vehicle_no: s.nullableStr(30),
  warehouse_id: s.idReq(),
  allow_override: z.coerce.boolean().default(false),
  override_reason: s.nullableStr(255),
  remarks: s.text(),
  /** Approved process (knitting) quotation of the knitter — used for any job that has no quotation of its own. */
  quotation_id: s.id(),
  quotation_line_id: s.id(),
  rate_per_kg: z.coerce.number().min(0).nullish(),
});

knittingDcRouter.post('/knitting-dcs', requirePermission('PROCESS.ISSUE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = dcSchema.parse(req.body);
  const jobs = (body.jobs?.length ? body.jobs : (body.program_id ? [{ program_id: body.program_id, lines: body.lines ?? [] }] : []))
    .map((j) => ({ ...j, lines: j.lines.filter((l) => l.issued_qty_kg > 0) })).filter((j) => j.lines.length);
  if (!jobs.length) throw BadRequest('Enter the KG to send on at least one yarn line');
  if (new Set(jobs.map((j) => j.program_id)).size !== jobs.length) throw BadRequest('A job / program is on the DC twice');

  // every program released, one knitter for the whole DC
  const progs = new Map<number, any>();
  for (const j of jobs) {
    const prog = await loadProgram(j.program_id, cid);
    assertEditable(prog.status, 'knitting program');
    if (!DC_READY.includes(prog.status)) {
      throw BadRequest(`Release program ${prog.program_no} before giving the knitting DC (it is ${prog.status.replace(/_/g, ' ').toLowerCase()})`);
    }
    prog.so_id = await resolveSoId(cid, prog.so_id, prog.io_no);
    progs.set(j.program_id, prog);
  }
  const vendorId = body.vendor_id ?? progs.get(jobs[0].program_id)?.vendor_id;
  if (!vendorId) throw BadRequest('Select the knitting vendor (supplier) the yarn is going to');
  // each job goes out on its own approved quotation (job-wise rate), else on the DC-level one
  const quotes = new Map<number, Awaited<ReturnType<typeof checkDcQuotation>>>();
  for (const j of jobs) {
    const prog = progs.get(j.program_id);
    const own = (j as any).quotation_id ? j as any : null;
    quotes.set(j.program_id, await checkDcQuotation(cid, {
      vendor_id: Number(vendorId), quotation_id: own?.quotation_id ?? body.quotation_id, quotation_line_id: own ? own.quotation_line_id : body.quotation_line_id,
      rate: (own ? own.rate_per_kg : body.rate_per_kg) ?? null, label: `Knitting DC — ${prog.program_no} (${prog.io_no ?? 'stock'})`,
      job: { io_no: prog.io_no ?? null, so_id: prog.so_id ?? null },
    }));
  }
  const qs = [...quotes.values()];
  // DC header keeps the quotation / rate only when every job has the same one
  const quote = qs.every((x) => x.quotation_id === qs[0].quotation_id && x.rate === qs[0].rate) ? qs[0] : { quotation_id: null, quotation_line_id: null, rate: null };

  // lines must belong to their program; yarn lots must belong to the line's job
  const lotChecks: any[] = [];
  const subUse = new Map<string, number>();
  for (const j of jobs) {
    const prog = progs.get(j.program_id);
    const progLines = await query<any>(`SELECT id, yarn_id FROM trx_knitting_program_yarns WHERE program_id = ?`, [j.program_id]);
    const lineIds = new Set(progLines.map((l) => Number(l.id)));
    for (const l of j.lines) {
      if (l.program_yarn_id && !lineIds.has(Number(l.program_yarn_id))) throw BadRequest(`A yarn line does not belong to program ${prog.program_no}`);
      // another yarn on the line = approved substitution only (posted, KG still open)
      const pl = progLines.find((x) => Number(x.id) === Number(l.program_yarn_id));
      if (pl && pl.yarn_id && Number(pl.yarn_id) !== Number(l.yarn_id)) {
        const k = `${l.program_yarn_id}|${l.yarn_id}`;
        const want = (subUse.get(k) ?? 0) + l.issued_qty_kg;
        const open = await substituteOpen(cid, Number(l.program_yarn_id), Number(l.yarn_id));
        if (want > open + 0.0005) {
          throw BadRequest(`${prog.program_no}: this yarn is not the program's yarn — ${open > 0 ? `only ${open} KG is approved as a substitute` : 'raise a yarn substitution request and get it approved first'}`);
        }
        subUse.set(k, want);
      }
      lotChecks.push({ grn_line_id: l.grn_line_id, so_id: prog.so_id, yarn_id: l.yarn_id, issued_qty_kg: l.issued_qty_kg, label: `${prog.program_no} (${prog.io_no ?? 'stock'})` });
    }
  }
  await assertJobLots(cid, lotChecks);

  // Stock check per line, counting earlier lines of this DC on the same yarn,
  // and letting the program's own reservation cover its own issue.
  const plan: { prog: any; line: z.infer<typeof dcLine>; reservationId: number | null; exceeds: boolean }[] = [];
  const taken = new Map<number, number>();
  for (const j of jobs) {
    for (const l of j.lines) {
      const resv = l.program_yarn_id ? await queryOne<any>(
        `SELECT id, reserved_qty_kg - released_qty_kg AS open_kg
           FROM trx_process_reservation
          WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ?
            AND src_line_id = ? AND yarn_id = ? AND status IN ('ACTIVE','PARTIAL')
          LIMIT 1`, [cid, j.program_id, l.program_yarn_id, l.yarn_id]) : null;
      const already = taken.get(l.yarn_id) ?? 0;
      const exceeds = await assertIssuable(req.user!, {
        yarn_id: l.yarn_id, warehouse_id: body.warehouse_id, issued_qty_kg: l.issued_qty_kg,
        allow_override: body.allow_override, override_reason: body.override_reason,
        alreadyKg: already, ownReservationKg: Math.max(0, Number(resv?.open_kg ?? 0)),
      });
      taken.set(l.yarn_id, already + l.issued_qty_kg);
      plan.push({ prog: progs.get(j.program_id), line: l, reservationId: resv ? Number(resv.id) : null, exceeds });
    }
  }

  const result = await transaction(async (tx) => {
    const dcNo = body.dc_no || await nextDocNumber(tx, cid, 'KNIT_DC');
    const dup = await txQueryOne<any>(tx,
      `SELECT id FROM trx_process_issue WHERE company_id = ? AND dc_no = ? LIMIT 1`, [cid, dcNo]);
    if (dup) throw BadRequest(`DC number ${dcNo} is already used`);

    const issues = [];
    for (const p of plan) {
      // lot / yarn PO come from the GRN lot when one is picked
      const lot = p.line.grn_line_id ? await txQueryOne<any>(tx,
        `SELECT gl.lot_no, po.po_no FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
           LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) WHERE gl.id = ?`, [p.line.grn_line_id]) : null;
      issues.push(await insertProcessIssue(tx, cid, uid, {
        src_type: 'KNITTING_PROGRAM', src_id: p.prog.id,
        src_line_id: p.line.program_yarn_id ?? null, reservation_id: p.reservationId,
        issue_no: null, issue_date: body.dc_date, yarn_id: p.line.yarn_id, batch_id: null,
        lot_no: lot?.lot_no ?? p.line.lot_no ?? null, yarn_po_no: lot?.po_no ?? p.line.yarn_po_no ?? null,
        warehouse_id: body.warehouse_id, issued_qty_kg: p.line.issued_qty_kg,
        allow_override: body.allow_override, override_reason: body.override_reason ?? null,
        remarks: body.remarks ?? null,
        dc_no: dcNo, vendor_id: vendorId, vehicle_no: body.vehicle_no ?? null,
        no_of_cones: p.line.no_of_cones,
        grn_line_id: p.line.grn_line_id ?? null, so_id: p.prog.so_id ?? null, io_no: p.prog.io_no ?? null,
      }, p.exceeds));
    }
    for (const [k, kg] of subUse) {
      const [pyid, yid] = k.split('|').map(Number);
      await bookSubstituteIssue(tx, cid, pyid, yid, kg);
    }
    await txExecute(tx,
      `INSERT INTO trx_knitting_dc (company_id, dc_no, dc_date, vendor_id, status, quotation_id, quotation_line_id, rate_per_kg) VALUES (?,?,?,?,'OPEN',?,?,?)
       ON DUPLICATE KEY UPDATE quotation_id = VALUES(quotation_id), quotation_line_id = VALUES(quotation_line_id), rate_per_kg = VALUES(rate_per_kg)`,
      [cid, dcNo, body.dc_date, vendorId, quote.quotation_id, quote.quotation_line_id, quote.rate]);
    for (const j of jobs) {
      const prog = progs.get(j.program_id); const jq = quotes.get(j.program_id)!;
      await txExecute(tx,
        `INSERT INTO trx_knitting_dc_job (company_id, dc_no, program_id, so_id, io_no, quotation_id, quotation_line_id, rate_per_kg, status, status_backfilled) VALUES (?,?,?,?,?,?,?,?, 'OPEN', 1)`,
        [cid, dcNo, j.program_id, prog.so_id ?? null, prog.io_no ?? null, jq.quotation_id, jq.quotation_line_id, jq.rate]);
    }
    return { dc_no: dcNo, jobs: jobs.length, issues, rate_per_kg: quote.rate,
      job_rates: jobs.map((j) => ({ program_id: j.program_id, program_no: progs.get(j.program_id).program_no, quotation_id: quotes.get(j.program_id)!.quotation_id, rate_per_kg: quotes.get(j.program_id)!.rate })) };
  });

  await audit(req, 'trx_process_issue', jobs[0].program_id, 'INSERT', undefined,
    { action: 'KNITTING_DC', ...result });
  res.status(201).json({ success: true, data: result });
}));

/** GET /knitting-dcs — one row per DC (all its jobs / programs). */
knittingDcRouter.get('/knitting-dcs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  let where = `WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.dc_no IS NOT NULL`;
  const params: any[] = [cid];
  if (req.query.program_id) {
    where += ` AND i.dc_no IN (SELECT dc_no FROM trx_process_issue WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ?)`;
    params.push(cid, req.query.program_id);
  }
  const rows = await query<any>(
    `SELECT i.dc_no, MIN(i.issue_date) AS dc_date, MIN(i.src_id) AS program_id,
            GROUP_CONCAT(DISTINCT kp.program_no ORDER BY kp.program_no SEPARATOR ', ') AS program_no,
            GROUP_CONCAT(DISTINCT kp.io_no ORDER BY kp.io_no SEPARATOR ', ') AS io_no,
            COUNT(DISTINCT i.src_id) AS job_count,
            MAX(i.vehicle_no) AS vehicle_no, MAX(p.party_name) AS vendor_name,
            COUNT(*) AS line_count, SUM(i.issued_qty_kg) AS total_kg, SUM(i.no_of_cones) AS total_cones,
            (SELECT COALESCE(SUM(m.fabric_kg), 0) FROM trx_knitting_inward_dc m JOIN trx_process_receipt r ON r.id = m.receipt_id
              WHERE r.company_id = i.company_id AND m.dc_no = i.dc_no) AS fabric_received_kg,
            (SELECT COALESCE(SUM(m.consumed_kg), 0) FROM trx_knitting_inward_dc m JOIN trx_process_receipt r ON r.id = m.receipt_id
              WHERE r.company_id = i.company_id AND m.dc_no = i.dc_no) AS yarn_consumed_kg,
            MAX(kd.status) AS dc_status, MAX(kd.rate_per_kg) AS rate_per_kg, MAX(q.quotation_no) AS quotation_no, MAX(kd.close_type) AS close_type,
            (SELECT GROUP_CONCAT(CONCAT(kp2.program_no, ':', COALESCE(j.rate_per_kg, ''), ':', COALESCE(q2.quotation_no, '')) ORDER BY kp2.program_no SEPARATOR '|')
               FROM trx_knitting_dc_job j JOIN trx_knitting_program kp2 ON kp2.id = j.program_id LEFT JOIN trx_quotation q2 ON q2.id = j.quotation_id
              WHERE j.company_id = i.company_id AND j.dc_no = i.dc_no) AS job_rates_raw,
            (SELECT COALESCE(SUM(yr.total_kg), 0) FROM trx_knitting_yarn_return yr
              WHERE yr.company_id = i.company_id AND yr.dc_no = i.dc_no AND yr.status <> 'CANCELLED') AS yarn_returned_kg,
            (SELECT COALESCE(SUM(yr.total_cones), 0) FROM trx_knitting_yarn_return yr
              WHERE yr.company_id = i.company_id AND yr.dc_no = i.dc_no AND yr.status <> 'CANCELLED') AS cones_returned
       FROM trx_process_issue i
       JOIN trx_knitting_program kp ON kp.id = i.src_id
       LEFT JOIN mst_party p ON p.id = i.vendor_id
       LEFT JOIN trx_knitting_dc kd ON kd.company_id = i.company_id AND kd.dc_no = i.dc_no
       LEFT JOIN trx_quotation q ON q.id = kd.quotation_id
       ${where}
      GROUP BY i.dc_no, i.company_id
      ORDER BY MIN(i.id) DESC LIMIT 500`, params);
  const forProgram = req.query.program_id ? Number(req.query.program_id) : null;
  const progNo = forProgram ? (await queryOne<any>('SELECT program_no FROM trx_knitting_program WHERE id = ?', [forProgram]))?.program_no : null;
  for (const r of rows) {
    // each job on the DC has its own quotation rate; a program's view shows its own job's rate
    r.job_rates = String(r.job_rates_raw ?? '').split('|').filter(Boolean).map((x: string) => { const [program_no, rate, quotation_no] = x.split(':'); return { program_no, rate_per_kg: rate === '' ? null : Number(rate), quotation_no: quotation_no || null }; });
    delete r.job_rates_raw;
    const mine = progNo ? r.job_rates.find((x: any) => x.program_no === progNo) : r.job_rates.length === 1 ? r.job_rates[0] : null;
    if (mine) { r.rate_per_kg = mine.rate_per_kg; r.quotation_no = mine.quotation_no; }
    if (forProgram && Number(r.job_count) > 1) {
      // a multi-job DC seen from one program: that job's own given / received / returned and status
      const k = await queryOne<any>(
        `SELECT (SELECT COALESCE(SUM(i.issued_qty_kg), 0) FROM trx_process_issue i WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.dc_no = ? AND i.src_id = ?) issued,
                (SELECT COALESCE(SUM(i.no_of_cones), 0) FROM trx_process_issue i WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.dc_no = ? AND i.src_id = ?) cones,
                (SELECT COALESCE(SUM(m.consumed_kg), 0) FROM trx_knitting_inward_dc m WHERE m.dc_no = ? AND m.program_id = ?) consumed,
                (SELECT COALESCE(SUM(m.fabric_kg), 0) FROM trx_knitting_inward_dc m WHERE m.dc_no = ? AND m.program_id = ?) fabric,
                (SELECT COALESCE(SUM(yr.total_kg), 0) FROM trx_knitting_yarn_return yr WHERE yr.company_id = ? AND yr.dc_no = ? AND yr.program_id = ? AND yr.status <> 'CANCELLED') returned`,
        [cid, r.dc_no, forProgram, cid, r.dc_no, forProgram, r.dc_no, forProgram, r.dc_no, forProgram, cid, r.dc_no, forProgram]);
      r.dc_total_kg = r.total_kg;
      Object.assign(r, { total_kg: k.issued, total_cones: k.cones, yarn_consumed_kg: k.consumed, fabric_received_kg: k.fabric, yarn_returned_kg: k.returned });
    }
    if (forProgram) {
      const js = await queryOne<any>('SELECT status, close_type FROM trx_knitting_dc_job WHERE company_id = ? AND dc_no = ? AND program_id = ?', [cid, r.dc_no, forProgram]);
      if (js) { r.dc_status_all = r.dc_status; r.dc_status = js.status; r.close_type = js.close_type; }
    }
    r.balance_yarn_kg = r3(Number(r.total_kg) - Number(r.yarn_consumed_kg) - Number(r.yarn_returned_kg));
    r.status = r.dc_status ?? (Number(r.yarn_consumed_kg) > 0 ? 'PARTIALLY_RECEIVED' : 'OPEN');
    // closed on the final receipt with yarn still at the knitter = to be returned
    r.yarn_to_return_kg = r.status === 'CLOSED' && r.close_type !== 'SHORT_CLOSE' ? Math.max(0, r.balance_yarn_kg) : 0;
  }
  const open = String(req.query.open ?? '') === '1';
  res.json({ success: true, data: open ? rows.filter((r) => r.status !== 'CLOSED') : rows });
}));

/** GET /knitting-dcs/:dcNo — printable DC: supplier / vendor, vehicle and the yarn lines grouped by job. */
knittingDcRouter.get('/knitting-dcs/:dcNo', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dcNo = String(req.params.dcNo);
  const lines = await query<any>(
    `SELECT i.*, y.yarn_code, y.yarn_name, y.count_value AS yarn_count,
            kpy.colour, kpy.count_value, w.warehouse_name, g.grn_no, g.supplier_inv_no
       FROM trx_process_issue i
       LEFT JOIN mst_yarn y ON y.id = i.yarn_id
       LEFT JOIN trx_knitting_program_yarns kpy ON kpy.id = i.src_line_id
       LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id
       LEFT JOIN trx_grn_line gl ON gl.id = i.grn_line_id LEFT JOIN trx_grn g ON g.id = gl.grn_id
      WHERE i.company_id = ? AND i.dc_no = ? AND i.src_type = 'KNITTING_PROGRAM'
      ORDER BY i.src_id, i.id`, [cid, dcNo]);
  if (!lines.length) throw NotFound('Knitting DC not found');
  const first = lines[0];
  const programIds = [...new Set(lines.map((l) => Number(l.src_id)))];
  const jobs = [];
  const jq = await query<any>(`SELECT j.program_id, j.quotation_id, j.quotation_line_id, j.rate_per_kg, j.status, j.close_type, q.quotation_no FROM trx_knitting_dc_job j LEFT JOIN trx_quotation q ON q.id = j.quotation_id
                                WHERE j.company_id = ? AND j.dc_no = ?`, [cid, dcNo]);
  for (const pid of programIds) {
    const prog = await loadProgram(pid, cid);
    const ls = lines.filter((l) => Number(l.src_id) === pid);
    const q = jq.find((x) => Number(x.program_id) === pid);
    jobs.push({
      quotation_id: q?.quotation_id ?? null, quotation_no: q?.quotation_no ?? null, rate_per_kg: q?.rate_per_kg != null ? Number(q.rate_per_kg) : null,
      status: q?.status ?? 'OPEN', close_type: q?.close_type ?? null,
      program_id: prog.id, program_no: prog.program_no, so_id: prog.so_id, io_no: prog.io_no, buyer_po_no: prog.buyer_po_no, so_no: prog.so_no,
      style_code: prog.style_code, style_name: prog.style_name, fabric_name: prog.fabric_name ?? prog.fabric_type, gsm: prog.gsm, dia: prog.dia,
      gauge: prog.gauge, part_name: prog.part_name, required_qty_kg: prog.required_qty_kg, lines: ls,
      total_kg: r3(ls.reduce((n, l) => n + Number(l.issued_qty_kg), 0)), total_cones: ls.reduce((n, l) => n + Number(l.no_of_cones || 0), 0),
    });
  }
  const main = jobs[0];
  const vendor = first.vendor_id ? await queryOne<any>(
    `SELECT party_name, gstin, phone FROM mst_party WHERE id = ?`, [first.vendor_id]) : null;
  const company = await queryOne<any>(
    `SELECT legal_name, trade_name, gstin, address_line1, address_line2, city, state, pincode, phone
       FROM mst_company WHERE id = ?`, [cid]);
  const hdr = await queryOne<any>(
    `SELECT kd.*, q.quotation_no, q.process_name FROM trx_knitting_dc kd LEFT JOIN trx_quotation q ON q.id = kd.quotation_id WHERE kd.company_id = ? AND kd.dc_no = ?`, [cid, dcNo]);
  const got = await queryOne<any>(
    `SELECT COALESCE(SUM(m.consumed_kg), 0) consumed, COALESCE(SUM(m.fabric_kg), 0) fabric, COUNT(DISTINCT m.receipt_id) grns
       FROM trx_knitting_inward_dc m JOIN trx_process_receipt r ON r.id = m.receipt_id WHERE r.company_id = ? AND m.dc_no = ?`, [cid, dcNo]);
  const retd = await queryOne<any>(`SELECT COALESCE(SUM(total_kg), 0) kg FROM trx_knitting_yarn_return WHERE company_id = ? AND dc_no = ? AND status <> 'CANCELLED'`, [cid, dcNo]);
  const issuedKg = r3(lines.reduce((n, l) => n + Number(l.issued_qty_kg), 0));
  res.json({
    success: true,
    data: {
      status: hdr?.status ?? 'OPEN', quotation_id: hdr?.quotation_id ?? null, quotation_no: hdr?.quotation_no ?? null, process_name: hdr?.process_name ?? null,
      rate_per_kg: hdr?.rate_per_kg != null ? Number(hdr.rate_per_kg) : null, close_type: hdr?.close_type ?? null, close_reason: hdr?.close_reason ?? null,
      consumed_kg: r3(Number(got?.consumed ?? 0)), fabric_received_kg: r3(Number(got?.fabric ?? 0)), grn_count: Number(got?.grns ?? 0), returned_kg: r3(Number(retd?.kg ?? 0)),
      balance_yarn_kg: r3(issuedKg - Number(got?.consumed ?? 0) - Number(retd?.kg ?? 0)),
      dc_no: dcNo, dc_date: first.issue_date, vehicle_no: first.vehicle_no,
      warehouse_name: first.warehouse_name, remarks: first.remarks,
      // first job kept at the top level for older screens; `jobs` has every job of the DC
      program_id: main.program_id, program_no: jobs.map((j) => j.program_no).join(', '), io_no: jobs.map((j) => j.io_no).filter(Boolean).join(', '),
      buyer_po_no: main.buyer_po_no, so_no: main.so_no, style_code: main.style_code, style_name: main.style_name,
      fabric_name: main.fabric_name, gsm: main.gsm, dia: main.dia, gauge: main.gauge, part_name: main.part_name, required_qty_kg: main.required_qty_kg,
      vendor_name: vendor?.party_name ?? null, vendor_gstin: vendor?.gstin ?? null,
      vendor_phone: vendor?.phone ?? null, company,
      jobs, lines,
      total_kg: r3(lines.reduce((n, l) => n + Number(l.issued_qty_kg), 0)),
      total_cones: lines.reduce((n, l) => n + Number(l.no_of_cones || 0), 0),
    },
  });
}));

/* ================================================================
   GREY FABRIC INWARD — against the knitting DC
================================================================ */

const inwardSchema = z.object({
  program_id: s.idReq(),
  /** Our knitting DCs this GRN is against (one GRN may consolidate several DCs of the program). */
  dc_nos: z.array(z.string().trim().min(1).max(60)).optional(),
  ref_dc_no: s.nullableStr(60),
  party_dc_no: s.strReq(60),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vehicle_no: s.nullableStr(30),
  warehouse_id: s.idReq(),
  gate_inward_id: s.id(),
  /** PARTIAL = more fabric to come on these DCs; FINAL = last receipt — the DCs close (yarn left is to be returned). */
  receipt_type: z.enum(['PARTIAL', 'FINAL']).default('PARTIAL'),
  fabric_id: s.id(),
  lot_no: s.nullableStr(60),
  // Yarn the knitter used for this fabric; defaults to fabric + rejected (no loss).
  yarn_consumed_kg: z.coerce.number().min(0).nullable().optional(),
  rejected_kg: z.coerce.number().min(0).default(0),
  remarks: s.text(),
  rolls: z.array(z.object({
    roll_no: s.nullableStr(60),
    weight_kg: z.coerce.number().positive(),
    meters: z.coerce.number().min(0).nullable().optional(),
    gsm: z.coerce.number().int().min(0).nullable().optional(),
    dia: s.nullableStr(30),
    shade: s.nullableStr(50),
  })).min(1, 'Add at least one roll'),
});

/**
 * Fabrics a knitting GRN of the program may receive: the program's fabric, the fabrics of the job's
 * other knitting programs and of the job's BOM (CAD → BOM fabric lines). Nothing else, so the store
 * cannot pick a wrong fabric (client voice note 02-Oct-2026).
 */
export async function allowedFabrics(cid: number, prog: any) {
  const ids = new Map<number, string>();
  if (prog.fabric_id) ids.set(Number(prog.fabric_id), 'Program');
  const soId = await resolveSoId(cid, prog.so_id, prog.io_no);
  const others = await query<any>(
    `SELECT DISTINCT fabric_id FROM trx_knitting_program WHERE company_id = ? AND fabric_id IS NOT NULL AND status <> 'CANCELLED'
        AND ((? IS NOT NULL AND so_id = ?) OR (? IS NOT NULL AND io_no = ?))`, [cid, soId, soId, prog.io_no ?? null, prog.io_no ?? null]);
  others.forEach((o) => { if (!ids.has(Number(o.fabric_id))) ids.set(Number(o.fabric_id), 'Job knitting program'); });
  const bom = await query<any>(
    `SELECT DISTINCT bl.fabric_id FROM trx_bom b JOIN trx_bom_line bl ON bl.bom_id = b.id
      WHERE b.company_id = ? AND b.is_active = 1 AND bl.material_type = 'FABRIC' AND bl.fabric_id IS NOT NULL
        AND ((? IS NOT NULL AND b.so_id = ?) OR (b.so_id IS NULL AND b.style_id = ?))`, [cid, soId, soId, prog.style_id ?? 0]);
  bom.forEach((o) => { if (!ids.has(Number(o.fabric_id))) ids.set(Number(o.fabric_id), 'Job BOM / CAD'); });
  if (!ids.size) return [];
  const rows = await query<any>(`SELECT id, fabric_code, fabric_name, min_gsm, max_gsm, dia_inch FROM mst_fabric WHERE id IN (?)`, [[...ids.keys()]]);
  return rows.map((r) => ({ ...r, source: ids.get(Number(r.id)) })).sort((a, b) => (a.source === 'Program' ? -1 : b.source === 'Program' ? 1 : 0));
}

knittingDcRouter.get('/knitting-programs/:id/fabrics', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const prog = await loadProgram(Number(req.params.id), cid);
  res.json({ success: true, data: await allowedFabrics(cid, prog) });
}));

/** What one program still has at the knitter on each of its DCs (issued − consumed − returned). */
async function programDcOpen(cid: number, programId: number) {
  const rows = await query<any>(
    `SELECT i.dc_no, MIN(i.id) seq, SUM(i.issued_qty_kg) issued,
            (SELECT COALESCE(SUM(m.consumed_kg), 0) FROM trx_knitting_inward_dc m WHERE m.program_id = i.src_id AND m.dc_no = i.dc_no) consumed,
            (SELECT COALESCE(SUM(yr.total_kg), 0) FROM trx_knitting_yarn_return yr WHERE yr.company_id = i.company_id AND yr.program_id = i.src_id AND yr.dc_no = i.dc_no AND yr.status <> 'CANCELLED') returned,
            MAX(COALESCE(j.status, kd.status)) status
       FROM trx_process_issue i LEFT JOIN trx_knitting_dc kd ON kd.company_id = i.company_id AND kd.dc_no = i.dc_no
       LEFT JOIN trx_knitting_dc_job j ON j.company_id = i.company_id AND j.dc_no = i.dc_no AND j.program_id = i.src_id
      WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.src_id = ? AND i.dc_no IS NOT NULL
      GROUP BY i.dc_no, i.src_id, i.company_id ORDER BY seq`, [cid, programId]);
  return rows.map((r) => ({ dc_no: r.dc_no, status: r.status ?? 'OPEN', issued: Number(r.issued), consumed: Number(r.consumed), returned: Number(r.returned),
    open: r3(Number(r.issued) - Number(r.consumed) - Number(r.returned)) }));
}

/**
 * After an inward: the receiving job's status on the DC (FINAL closes that job only; any receipt makes it part
 * received), then the DC header follows its jobs — CLOSED only when every job on the DC is closed.
 */
async function refreshDcStatus(tx: any, cid: number, dcNo: string, programId: number, final: boolean, uid: number) {
  if (final) {
    await txExecute(tx, `UPDATE trx_knitting_dc_job SET status = 'CLOSED', close_type = 'FINAL_RECEIPT', closed_by = ?, closed_at = NOW() WHERE company_id = ? AND dc_no = ? AND program_id = ? AND status <> 'CLOSED'`, [uid, cid, dcNo, programId]);
  } else {
    await txExecute(tx, `UPDATE trx_knitting_dc_job SET status = 'PARTIALLY_RECEIVED' WHERE company_id = ? AND dc_no = ? AND program_id = ? AND status = 'OPEN'`, [cid, dcNo, programId]);
  }
  await syncDcHeader(tx, cid, dcNo, uid);
}

/** DC header status from its jobs. */
async function syncDcHeader(tx: any, cid: number, dcNo: string, uid: number) {
  const x = await txQueryOne<any>(tx, `SELECT COUNT(*) n, SUM(status = 'CLOSED') c, SUM(status <> 'OPEN') moved, SUM(close_type = 'SHORT_CLOSE') short_n
                                         FROM trx_knitting_dc_job WHERE company_id = ? AND dc_no = ?`, [cid, dcNo]);
  if (!x || !Number(x.n)) return;
  if (Number(x.c) === Number(x.n)) {
    await txExecute(tx, `UPDATE trx_knitting_dc SET status = 'CLOSED', close_type = ?, closed_by = COALESCE(closed_by, ?), closed_at = COALESCE(closed_at, NOW()) WHERE company_id = ? AND dc_no = ?`,
      [Number(x.short_n) ? 'SHORT_CLOSE' : 'FINAL_RECEIPT', uid, cid, dcNo]);
  } else {
    await txExecute(tx, `UPDATE trx_knitting_dc SET status = ?, close_type = NULL, closed_at = NULL WHERE company_id = ? AND dc_no = ?`,
      [Number(x.moved) ? 'PARTIALLY_RECEIVED' : 'OPEN', cid, dcNo]);
  }
}

knittingDcRouter.post('/knitting-inwards', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = inwardSchema.parse(req.body);

  const prog = await loadProgram(body.program_id, cid);
  assertEditable(prog.status, 'knitting program');
  // fabric: only the job's own fabrics (program / job programs / job BOM)
  const allowed = await allowedFabrics(cid, prog);
  const fabricId = body.fabric_id ?? prog.fabric_id ?? (allowed.length === 1 ? Number(allowed[0].id) : null);
  if (!fabricId) throw BadRequest('Select the grey fabric being received (the program has no fabric set)');
  if (allowed.length && !allowed.some((f) => Number(f.id) === Number(fabricId))) {
    throw BadRequest(`That fabric is not a fabric of job ${prog.io_no ?? prog.program_no} — pick ${allowed.map((f) => f.fabric_name).join(' / ')}`);
  }

  const dcNos = [...new Set([...(body.dc_nos ?? []), ...(body.ref_dc_no ? [body.ref_dc_no] : [])])];
  const dcOpen = await programDcOpen(cid, body.program_id);
  for (const d of dcNos) {
    const row = dcOpen.find((x) => x.dc_no === d);
    if (!row) throw BadRequest(`DC ${d} was not given against program ${prog.program_no}`);
    if (row.status === 'CLOSED') throw BadRequest(`DC ${d} is closed for job ${prog.io_no ?? prog.program_no} (final receipt done) — nothing more can be received on it`);
  }
  let vendorId = prog.vendor_id;
  if (dcNos.length) {
    const dc = await queryOne<any>(`SELECT MAX(vendor_id) AS vendor_id FROM trx_process_issue WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND dc_no IN (?)`, [cid, dcNos]);
    vendorId = dc?.vendor_id ?? vendorId;
  }
  if (!vendorId) throw BadRequest('The program has no knitting vendor to receive from');

  const fabricKg = r3(body.rolls.reduce((n, r) => n + r.weight_kg, 0));
  const consumed = r3(body.yarn_consumed_kg ?? (fabricKg + body.rejected_kg));
  if (consumed + 1e-9 < fabricKg + body.rejected_kg) {
    throw BadRequest('Yarn consumed cannot be less than the fabric received plus rejected');
  }
  // Fabric cannot come back for more yarn than was given (on the selected DCs, else on the program).
  const recon = await reconcile(body.program_id, cid);
  const open = dcNos.length ? r3(dcNos.reduce((a, d) => a + Math.max(0, dcOpen.find((x) => x.dc_no === d)!.open), 0))
    : r3(Number(recon.totals.issued_kg) - Number(recon.totals.consumed_kg) - Number(recon.totals.returned_kg));
  if (consumed > open + 1e-9) {
    throw BadRequest(`Only ${open} KG of yarn is still with the knitter${dcNos.length ? ` on DC ${dcNos.join(', ')}` : ''}; this inward accounts for ${consumed} KG`);
  }
  const loss = r3(consumed - fabricKg - body.rejected_kg);
  // yarn used is booked on the DCs in DC order, up to what each still had
  let left = consumed;
  const split = dcNos.map((d) => { const o = Math.max(0, dcOpen.find((x) => x.dc_no === d)!.open); const take = r3(Math.min(o, left)); left = r3(left - take); return { dc_no: d, consumed: take }; });
  if (split.length && left > 1e-9) split[split.length - 1].consumed = r3(split[split.length - 1].consumed + left);

  const result = await transaction(async (tx) => {
    const gate = await useGateEntry(tx, cid, { gate_inward_id: body.gate_inward_id, party_id: vendorId, label: 'Knitting inward' });
    const receiptNo = await nextDocNumber(tx, cid, 'KNIT_INWARD');
    const lotNo = body.lot_no || `${prog.program_no}-${receiptNo}`;
    const note = `Knitting inward — program ${prog.program_no}` +
      (dcNos.length ? `, our DC ${dcNos.join(', ')}` : '') + `, party DC ${body.party_dc_no}` + (body.receipt_type === 'FINAL' ? ' (final receipt)' : ' (partial)');

    // Grey fabric GRN: the rolls live in trx_fabric_roll, which hangs off a GRN,
    // so roll stock, fabric processing and cutting all see them unchanged.
    const g = await txExecute(tx,
      `INSERT INTO trx_grn
         (company_id, grn_no, internal_ir_no, grn_date, style_id, supplier_id, warehouse_id,
          supplier_dc_no, vehicle_no, gate_inward_id, qc_status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, prog.io_no ?? null, body.receipt_date, prog.style_id ?? null, vendorId,
       body.warehouse_id, body.party_dc_no, body.vehicle_no ?? gate?.vehicle_no ?? null, gate?.id ?? null, 'ACCEPTED', note, uid]);
    const grnId = g.insertId;

    const gl = await txExecute(tx,
      `INSERT INTO trx_grn_line
         (grn_id, so_id, style_id, material_type, fabric_id, fabric_category, lot_no, qc_status,
          received_qty, received_weight, no_of_rolls, accepted_qty, rejected_qty, balance_qty, uom_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [grnId, prog.so_id ?? null, prog.style_id ?? null, 'FABRIC', fabricId, 'Grey Fabric', lotNo,
       'ACCEPTED', fabricKg, fabricKg, body.rolls.length, fabricKg, body.rejected_kg, 0, UOM_KG]);
    const grnLineId = gl.insertId;

    const rolls = [];
    for (let i = 0; i < body.rolls.length; i++) {
      const r = body.rolls[i];
      const rollNo = r.roll_no || `${receiptNo}-${String(i + 1).padStart(2, '0')}`;
      const fr = await txExecute(tx,
        `INSERT INTO trx_fabric_roll
           (company_id, grn_id, grn_line_id, fabric_id, roll_no, lot_no, meters, weight_kg,
            gsm, dia, shade, warehouse_id, qc_status, stock_status, remarks, so_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, grnId, grnLineId, fabricId, rollNo, lotNo, r.meters ?? null, r.weight_kg,
         r.gsm ?? (Number.parseInt(String(prog.gsm ?? ''), 10) || null),
         r.dia ?? prog.dia ?? null, r.shade ?? null, body.warehouse_id, 'ACCEPTED', 'AVAILABLE',
         `Grey from knitting ${prog.program_no}`, prog.so_id ?? null]);
      rolls.push({ id: fr.insertId, roll_no: rollNo, weight_kg: r.weight_kg });
    }

    const rc = await txExecute(tx,
      `INSERT INTO trx_process_receipt
         (company_id, receipt_no, receipt_date, party_dc_no, ref_dc_no, vehicle_no,
          src_type, src_id, input_qty, output_qty, output_uom_id, loss_qty, rejected_qty,
          output_lot_no, warehouse_id, grn_id, no_of_rolls, qc_status, is_stock_posted,
          remarks, created_by, receipt_type, gate_inward_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, body.receipt_date, body.party_dc_no, dcNos[0] ?? null,
       body.vehicle_no ?? gate?.vehicle_no ?? null, 'KNITTING_PROGRAM', body.program_id, consumed, fabricKg, UOM_KG,
       loss, body.rejected_kg, lotNo, body.warehouse_id, grnId, body.rolls.length, 'PASSED', 1,
       body.remarks ?? null, uid, body.receipt_type, gate?.id ?? null]);
    const receiptId = rc.insertId;
    for (const sp of split) {
      await txExecute(tx, 'INSERT INTO trx_knitting_inward_dc (receipt_id, program_id, dc_no, consumed_kg, fabric_kg) VALUES (?,?,?,?,?)',
        [receiptId, body.program_id, sp.dc_no, sp.consumed, consumed > 0 ? r3(fabricKg * sp.consumed / consumed) : 0]);
      await refreshDcStatus(tx, cid, sp.dc_no, body.program_id, body.receipt_type === 'FINAL', uid);
    }

    await postLedger(tx, {
      companyId: cid, warehouseId: body.warehouse_id, materialType: 'FABRIC',
      fabricId, soId: prog.so_id ?? null, txnType: 'PRODUCTION_IN', refType: 'PROCESS_RECEIPT', refId: receiptId,
      qtyIn: fabricKg, uomId: UOM_KG, createdBy: uid,
    });

    await txExecute(tx,
      `UPDATE trx_knitting_program SET status = 'STOCK_POSTED'
        WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED')`, [body.program_id]);

    return { id: receiptId, receipt_no: receiptNo, grn_id: grnId, lot_no: lotNo, receipt_type: body.receipt_type, dcs: split,
             fabric_kg: fabricKg, yarn_consumed_kg: consumed, loss_kg: loss, rolls, gate_entry_no: gate?.entry_no ?? null };
  });

  await audit(req, 'trx_process_receipt', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/**
 * POST /knitting-dcs/:dcNo/close — close a DC: `write_off` books the yarn still at the knitter as
 * process loss (short close); otherwise it stays as "yarn to return" until the knitter returns it.
 */
knittingDcRouter.post('/knitting-dcs/:dcNo/close', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const dcNo = String(req.params.dcNo);
  const b = z.object({ reason: z.string().trim().min(3, 'Give the reason').max(255), write_off: z.coerce.boolean().default(false),
    /** Close only this job (program) of the DC; without it every job on the DC is closed. */
    program_id: z.coerce.number().int().positive().optional() }).parse(req.body);
  const allProg = (await query<any>(`SELECT DISTINCT src_id FROM trx_process_issue WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND dc_no = ?`, [cid, dcNo])).map((r) => Number(r.src_id));
  if (!allProg.length) throw NotFound('Knitting DC not found');
  if (b.program_id && !allProg.includes(b.program_id)) throw BadRequest(`That program is not on DC ${dcNo}`);
  const jobsSt = await query<any>('SELECT program_id, status, close_type FROM trx_knitting_dc_job WHERE company_id = ? AND dc_no = ?', [cid, dcNo]);
  const stOf = (pid: number) => jobsSt.find((x) => Number(x.program_id) === pid);
  // a closed job can still get its leftover yarn written off once (final receipt done, yarn not coming back)
  const progIds = (b.program_id ? [b.program_id] : allProg).filter((pid) => stOf(pid)?.status !== 'CLOSED' || (b.write_off && stOf(pid)?.close_type !== 'SHORT_CLOSE'));
  if (!progIds.length) throw BadRequest(`DC ${dcNo}${b.program_id ? ' (this job)' : ''} is already closed`);
  const hdr = await queryOne<any>('SELECT * FROM trx_knitting_dc WHERE company_id = ? AND dc_no = ?', [cid, dcNo]);
  const out = await transaction(async (tx) => {
    let written = 0;
    if (b.write_off) {
      for (const pid of progIds) {
        const o = (await programDcOpen(cid, pid)).find((x) => x.dc_no === dcNo);
        if (!o || o.open <= 0.0005) continue;
        const no = await nextDocNumber(tx, cid, 'KNIT_INWARD');
        const rc = await txExecute(tx,
          `INSERT INTO trx_process_receipt (company_id, receipt_no, receipt_date, party_dc_no, ref_dc_no, src_type, src_id, input_qty, output_qty, output_uom_id, loss_qty,
             rejected_qty, qc_status, is_stock_posted, remarks, created_by, receipt_type) VALUES (?,?,CURDATE(),?,?, 'KNITTING_PROGRAM', ?, ?, 0, ?, ?, 0, 'PASSED', 1, ?, ?, 'ADJUST')`,
          [cid, no, 'SHORT-CLOSE', dcNo, pid, o.open, UOM_KG, o.open, `DC ${dcNo} short closed — yarn at the knitter written off: ${b.reason}`, uid]);
        await txExecute(tx, 'INSERT INTO trx_knitting_inward_dc (receipt_id, program_id, dc_no, consumed_kg, fabric_kg) VALUES (?,?,?,?,0)', [rc.insertId, pid, dcNo, o.open]);
        written += o.open;
      }
    }
    for (const pid of progIds) {
      await txExecute(tx,
        `INSERT INTO trx_knitting_dc_job (company_id, dc_no, program_id, status, close_type, close_reason, closed_by, closed_at, status_backfilled) VALUES (?,?,?, 'CLOSED', ?, ?, ?, NOW(), 1)
         ON DUPLICATE KEY UPDATE status = 'CLOSED', close_type = VALUES(close_type), close_reason = VALUES(close_reason), closed_by = VALUES(closed_by), closed_at = NOW()`,
        [cid, dcNo, pid, b.write_off ? 'SHORT_CLOSE' : 'FINAL_RECEIPT', b.reason, uid]);
    }
    await txExecute(tx, `INSERT IGNORE INTO trx_knitting_dc (company_id, dc_no, status) VALUES (?,?, 'OPEN')`, [cid, dcNo]);
    await txExecute(tx, 'UPDATE trx_knitting_dc SET close_reason = ? WHERE company_id = ? AND dc_no = ?', [b.reason, cid, dcNo]);
    await syncDcHeader(tx, cid, dcNo, uid);
    const h2 = await txQueryOne<any>(tx, 'SELECT status FROM trx_knitting_dc WHERE company_id = ? AND dc_no = ?', [cid, dcNo]);
    return { dc_no: dcNo, written_off_kg: r3(written), jobs_closed: progIds.length, dc_status: h2?.status };
  });
  await audit(req, 'trx_knitting_dc', 0, 'UPDATE', { status: hdr?.status }, { close: out, reason: b.reason });
  res.json({ success: true, data: out, message: `DC ${dcNo}${b.program_id ? ' — this job' : ''} closed${out.written_off_kg ? ` — ${out.written_off_kg} KG yarn written off as loss` : ''}${out.dc_status !== 'CLOSED' ? ' (other jobs on the DC stay open)' : ''}` });
}));

/** GET /knitting-inwards — grey fabric inwards with their rolls. */
knittingDcRouter.get('/knitting-inwards', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  let where = `WHERE r.company_id = ? AND r.src_type = 'KNITTING_PROGRAM' AND r.grn_id IS NOT NULL`;
  const params: any[] = [cid];
  if (req.query.program_id) { where += ' AND r.src_id = ?'; params.push(req.query.program_id); }
  const rows = await query<any>(
    `SELECT r.*, kp.program_no, kp.io_no, w.warehouse_name, g.grn_no, gi.entry_no AS gate_entry_no,
            (SELECT GROUP_CONCAT(DISTINCT m.dc_no ORDER BY m.dc_no SEPARATOR ', ') FROM trx_knitting_inward_dc m WHERE m.receipt_id = r.id) AS dc_nos
       FROM trx_process_receipt r
       LEFT JOIN trx_gate_inward gi ON gi.id = r.gate_inward_id
       JOIN trx_knitting_program kp ON kp.id = r.src_id
       LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id
       LEFT JOIN trx_grn g ON g.id = r.grn_id
       ${where} ORDER BY r.id DESC LIMIT 500`, params);
  for (const r of rows) {
    r.rolls = await query(
      `SELECT id, roll_no, lot_no, weight_kg, meters, gsm, dia, shade, stock_status, issued_kg
         FROM trx_fabric_roll WHERE grn_id = ? ORDER BY id`, [r.grn_id]);
  }
  res.json({ success: true, data: rows });
}));

/* ================================================================
   UNUSED YARN RETURN — from the knitter, against the knitting DC
================================================================ */

const lotKey = (yarnId: number, lot: string | null | undefined) => `${yarnId}|${(lot ?? '').trim().toUpperCase()}`;

/**
 * What of one DC is still with the knitter, per yarn + lot. Consumption is
 * booked per DC (grey inward against the DC), so it is spread over the DC's
 * lines by allocateConsumed; returns are actual per line.
 */
async function dcYarnBalances(cid: number, dcNo: string) {
  const issues = await query<any>(
    `SELECT i.id, i.src_id, i.src_line_id, i.yarn_id, i.batch_id, i.lot_no, i.yarn_po_no,
            i.issued_qty_kg, i.no_of_cones, i.vendor_id, i.warehouse_id, i.issue_date,
            y.yarn_code, y.yarn_name, kpy.colour, kpy.count_value
       FROM trx_process_issue i
       LEFT JOIN mst_yarn y ON y.id = i.yarn_id
       LEFT JOIN trx_knitting_program_yarns kpy ON kpy.id = i.src_line_id
      WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.dc_no = ?
      ORDER BY i.id`, [cid, dcNo]);
  if (!issues.length) throw NotFound('Knitting DC not found');
  const programId = Number(issues[0].src_id);

  const groups = new Map<string, any>();
  for (const i of issues) {
    const k = lotKey(Number(i.yarn_id), i.lot_no);
    const g = groups.get(k) ?? {
      key: k, issue_id: Number(i.id), program_yarn_id: i.src_line_id ? Number(i.src_line_id) : null,
      yarn_id: Number(i.yarn_id), batch_id: i.batch_id ? Number(i.batch_id) : null,
      lot_no: i.lot_no ?? null, yarn_po_no: i.yarn_po_no ?? null,
      yarn: `${i.yarn_code ?? ''} — ${i.yarn_name ?? ''}`, colour: i.colour ?? null,
      count_value: i.count_value ?? null, issued_kg: 0, cones_issued: 0, returned_kg: 0, cones_returned: 0,
    };
    g.issued_kg = r3(g.issued_kg + Number(i.issued_qty_kg));
    g.cones_issued += Number(i.no_of_cones || 0);
    groups.set(k, g);
  }

  const ret = await query<any>(
    `SELECT rl.yarn_id, rl.lot_no, SUM(rl.return_kg) AS kg, SUM(rl.no_of_cones) AS cones
       FROM trx_knitting_yarn_return_line rl
       JOIN trx_knitting_yarn_return rt ON rt.id = rl.return_id
      WHERE rt.company_id = ? AND rt.dc_no = ? AND rt.status <> 'CANCELLED' GROUP BY rl.yarn_id, rl.lot_no`, [cid, dcNo]);
  for (const r of ret) {
    const g = groups.get(lotKey(Number(r.yarn_id), r.lot_no));
    if (g) { g.returned_kg = r3(g.returned_kg + Number(r.kg)); g.cones_returned += Number(r.cones); }
  }

  const rc = await queryOne<any>(
    `SELECT COALESCE(SUM(m.consumed_kg), 0) AS consumed FROM trx_knitting_inward_dc m JOIN trx_process_receipt r ON r.id = m.receipt_id
      WHERE r.company_id = ? AND m.program_id = ? AND m.dc_no = ?`,
    [cid, programId, dcNo]);
  const consumed = r3(Number(rc?.consumed ?? 0));
  const lines = [...groups.values()];
  const alloc = allocateConsumed(consumed, lines.map((g) => ({ issued: g.issued_kg, returned: g.returned_kg })));
  lines.forEach((g, i) => {
    g.consumed_kg = alloc[i];
    g.balance_kg = Math.max(0, r3(g.issued_kg - g.consumed_kg - g.returned_kg));
    // Cone cap for a return: cones sent on this line and not yet returned.
    g.cones_not_returned = Math.max(0, g.cones_issued - g.cones_returned);
  });
  const issued = r3(lines.reduce((n, g) => n + g.issued_kg, 0));
  const returned = r3(lines.reduce((n, g) => n + g.returned_kg, 0));
  return {
    program_id: programId, dc_no: dcNo, dc_date: issues[0].issue_date,
    vendor_id: issues[0].vendor_id ? Number(issues[0].vendor_id) : null,
    warehouse_id: issues[0].warehouse_id ? Number(issues[0].warehouse_id) : null,
    issued_kg: issued, consumed_kg: consumed, returned_kg: returned,
    balance_kg: r3(issued - consumed - returned), lines,
  };
}

/** Rate of the lot the yarn went out from: the issue's own ledger rate, else the lot's latest priced inward. */
async function issueLotRate(cid: number, issueId: number, yarnId: number, batchId: number | null) {
  const own = await queryOne<any>(
    `SELECT rate FROM trx_stock_ledger
      WHERE company_id = ? AND ref_type = 'PROCESS_ISSUE' AND ref_id = ? AND yarn_id = ? LIMIT 1`,
    [cid, issueId, yarnId]);
  if (Number(own?.rate) > 0) return Number(own.rate);
  const inward = await queryOne<any>(
    `SELECT rate FROM trx_stock_ledger
      WHERE company_id = ? AND material_type = 'YARN' AND yarn_id = ? AND (batch_id <=> ?)
        AND qty_in > 0 AND rate > 0
      ORDER BY id DESC LIMIT 1`, [cid, yarnId, batchId]);
  return Number(inward?.rate ?? 0);
}

const yarnReturnSchema = z.object({
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  party_dc_no: s.strReq(60),
  vehicle_no: s.nullableStr(30),
  warehouse_id: s.idReq(),
  gate_inward_id: s.id(),
  remarks: s.text(),
  lines: z.array(z.object({
    yarn_id: s.idReq(),
    lot_no: s.nullableStr(80),
    return_kg: z.coerce.number().min(0).default(0),
    no_of_cones: z.coerce.number().int().min(0).default(0),
  })).min(1, 'Add at least one yarn line'),
});

/** GET /knitting-dcs/:dcNo/yarn-returns — what is still with the knitter per yarn/lot, and the returns so far. */
knittingDcRouter.get('/knitting-dcs/:dcNo/yarn-returns', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dcNo = String(req.params.dcNo);
  const bal = await dcYarnBalances(cid, dcNo);
  const returns = await listYarnReturns(cid, { dc_no: dcNo });
  res.json({ success: true, data: { ...bal, returns } });
}));

knittingDcRouter.post('/knitting-dcs/:dcNo/yarn-returns', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const dcNo = String(req.params.dcNo);
  const body = yarnReturnSchema.parse(req.body);
  const want = body.lines.filter((l) => l.return_kg > 0);
  if (!want.length) throw BadRequest('Enter the KG returned on at least one yarn line');

  const bal = await dcYarnBalances(cid, dcNo);
  const prog = await loadProgram(bal.program_id, cid);
  assertEditable(prog.status, 'knitting program');

  // Several request lines may hit the same yarn + lot: judge them together.
  const asked = new Map<string, { kg: number; cones: number; lot: string | null }>();
  for (const l of want) {
    const k = lotKey(l.yarn_id, l.lot_no);
    const a = asked.get(k) ?? { kg: 0, cones: 0, lot: l.lot_no ?? null };
    a.kg = r3(a.kg + l.return_kg); a.cones += l.no_of_cones;
    asked.set(k, a);
  }
  const plan: { g: any; kg: number; cones: number }[] = [];
  for (const [k, a] of asked) {
    const g = bal.lines.find((x) => x.key === k);
    if (!g) {
      throw BadRequest(`That yarn${a.lot ? ` / lot ${a.lot}` : ''} did not go out on DC ${dcNo}`);
    }
    const label = `${g.yarn.trim()}${g.lot_no ? ` lot ${g.lot_no}` : ''}`;
    if (a.kg > g.balance_kg + 1e-9) {
      throw BadRequest(`Only ${g.balance_kg} KG of ${label} is still with the knitter on DC ${dcNo}; ` +
        `the return is ${a.kg} KG`);
    }
    if (g.cones_issued > 0 && a.cones > g.cones_not_returned) {
      throw BadRequest(`Only ${g.cones_not_returned} cones of ${label} went out on DC ${dcNo} and are not yet returned; ` +
        `the return is ${a.cones} cones`);
    }
    plan.push({ g, kg: a.kg, cones: a.cones });
  }
  const totalKg = r3(plan.reduce((n, p) => n + p.kg, 0));
  const totalCones = plan.reduce((n, p) => n + p.cones, 0);
  if (totalKg > bal.balance_kg + 1e-9) {
    throw BadRequest(`Only ${bal.balance_kg} KG of yarn is still with the knitter on DC ${dcNo}; the return is ${totalKg} KG`);
  }
  // Fabric received without a DC reference still used this program's yarn.
  const recon = await reconcile(bal.program_id, cid);
  if (totalKg > recon.totals.balance_yarn_kg + 1e-9) {
    throw BadRequest(`Only ${recon.totals.balance_yarn_kg} KG of yarn is still with the knitter on program ` +
      `${prog.program_no}; the return is ${totalKg} KG`);
  }
  for (const p of plan) p.g.rate = await issueLotRate(cid, p.g.issue_id, p.g.yarn_id, p.g.batch_id);

  const result = await transaction(async (tx) => {
    const gate = await useGateEntry(tx, cid, { gate_inward_id: body.gate_inward_id, party_id: bal.vendor_id ?? prog.vendor_id, label: 'Yarn return' });
    const returnNo = await nextDocNumber(tx, cid, 'KNIT_YARN_RETURN');
    const h = await txExecute(tx,
      `INSERT INTO trx_knitting_yarn_return
         (company_id, return_no, return_date, program_id, dc_no, party_dc_no, vendor_id, vehicle_no,
          warehouse_id, total_kg, total_cones, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, returnNo, body.return_date, bal.program_id, dcNo, body.party_dc_no,
       bal.vendor_id ?? prog.vendor_id ?? null, body.vehicle_no ?? null, body.warehouse_id,
       totalKg, totalCones, body.remarks ?? null, uid]);
    const returnId = h.insertId;
    if (gate) await txExecute(tx, 'UPDATE trx_knitting_yarn_return SET gate_inward_id = ? WHERE id = ?', [gate.id, returnId]);
    const lines = [];
    for (const p of plan) {
      const l = await txExecute(tx,
        `INSERT INTO trx_knitting_yarn_return_line
           (return_id, issue_id, program_yarn_id, yarn_id, batch_id, lot_no, return_kg, no_of_cones, rate)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [returnId, p.g.issue_id, p.g.program_yarn_id, p.g.yarn_id, p.g.batch_id, p.g.lot_no,
         p.kg, p.cones, p.g.rate]);
      // Back into the same yarn + lot so it can go out again.
      await postLedger(tx, {
        companyId: cid, warehouseId: body.warehouse_id, materialType: 'YARN',
        yarnId: p.g.yarn_id, batchId: p.g.batch_id, txnType: 'RETURN',
        refType: 'KNIT_YARN_RETURN', refId: l.insertId, qtyIn: p.kg, uomId: UOM_KG,
        rate: p.g.rate, createdBy: uid,
      });
      lines.push({ id: l.insertId, yarn_id: p.g.yarn_id, lot_no: p.g.lot_no, return_kg: p.kg,
                   no_of_cones: p.cones, rate: p.g.rate });
    }
    return { id: returnId, return_no: returnNo, dc_no: dcNo, program_id: bal.program_id,
             total_kg: totalKg, total_cones: totalCones, lines };
  });

  await audit(req, 'trx_knitting_yarn_return', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/**
 * POST /knitting-yarn-returns/:returnNo/cancel — reverse a yarn return posted by
 * mistake: the returned KG go back out of stock (refused if that yarn has been
 * used since) and count as with the knitter again. The return stays on record.
 */
knittingDcRouter.post('/knitting-yarn-returns/:returnNo/cancel', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Give a reason (min 3 characters)').max(255) }).parse(req.body);
  const out = await transaction(async (tx) => {
    const rt = await txQueryOne<any>(tx,
      `SELECT * FROM trx_knitting_yarn_return WHERE company_id = ? AND return_no = ? FOR UPDATE`, [cid, String(req.params.returnNo)]);
    if (!rt) throw NotFound('Yarn return not found');
    if (rt.status === 'CANCELLED') throw BadRequest(`Yarn return ${rt.return_no} is already cancelled`);
    const lines = await query<any>(`SELECT * FROM trx_knitting_yarn_return_line WHERE return_id = ? ORDER BY id`, [rt.id]);
    for (const l of lines) {
      const onHand = await txQueryOne<any>(tx,
        `SELECT COALESCE(SUM(qty_in - qty_out), 0) AS q FROM trx_stock_ledger
          WHERE company_id = ? AND warehouse_id = ? AND material_type = 'YARN' AND yarn_id = ? AND (batch_id <=> ?)`,
        [cid, rt.warehouse_id, l.yarn_id, l.batch_id ?? null]);
      if (Number(onHand?.q ?? 0) + 1e-9 < Number(l.return_kg)) {
        throw BadRequest(`Only ${Number(onHand?.q ?? 0)} KG of the returned yarn${l.lot_no ? ` (lot ${l.lot_no})` : ''} is still in stock — ` +
          'it has been issued again, so the return cannot be cancelled');
      }
      await postLedger(tx, {
        companyId: cid, warehouseId: rt.warehouse_id, materialType: 'YARN', yarnId: l.yarn_id, batchId: l.batch_id,
        txnType: 'RETURN', refType: 'KNIT_YARN_RETURN_CANCEL', refId: l.id, qtyOut: Number(l.return_kg), uomId: UOM_KG,
        rate: l.rate ?? 0, createdBy: uid,
      });
    }
    await txExecute(tx,
      `UPDATE trx_knitting_yarn_return SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`,
      [reason, uid, rt.id]);
    return { id: rt.id, return_no: rt.return_no, status: 'CANCELLED', lines: lines.length };
  });
  await audit(req, 'trx_knitting_yarn_return', out.id, 'UPDATE', { status: 'ACTIVE' }, { status: 'CANCELLED', reason });
  res.json({ success: true, data: out });
}));

async function listYarnReturns(cid: number, f: { program_id?: unknown; dc_no?: unknown; return_no?: string }) {
  let where = 'WHERE rt.company_id = ?';
  const params: any[] = [cid];
  if (f.return_no) { where += ' AND rt.return_no = ?'; params.push(f.return_no); }
  if (f.program_id) { where += ' AND rt.program_id = ?'; params.push(f.program_id); }
  if (f.dc_no) { where += ' AND rt.dc_no = ?'; params.push(f.dc_no); }
  const rows = await query<any>(
    `SELECT rt.*, kp.program_no, kp.io_no, w.warehouse_name, p.party_name AS vendor_name
       FROM trx_knitting_yarn_return rt
       JOIN trx_knitting_program kp ON kp.id = rt.program_id
       LEFT JOIN mst_warehouse w ON w.id = rt.warehouse_id
       LEFT JOIN mst_party p ON p.id = rt.vendor_id
       ${where} ORDER BY rt.id DESC LIMIT 500`, params);
  for (const r of rows) {
    r.lines = await query(
      `SELECT rl.*, y.yarn_code, y.yarn_name, kpy.colour, kpy.count_value
         FROM trx_knitting_yarn_return_line rl
         LEFT JOIN mst_yarn y ON y.id = rl.yarn_id
         LEFT JOIN trx_knitting_program_yarns kpy ON kpy.id = rl.program_yarn_id
        WHERE rl.return_id = ? ORDER BY rl.id`, [r.id]);
  }
  return rows;
}

/** GET /knitting-yarn-returns — returns with their lines (filter by program_id / dc_no). */
knittingDcRouter.get('/knitting-yarn-returns', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  res.json({ success: true, data: await listYarnReturns(req.user!.companyId, req.query) });
}));

/** GET /knitting-yarn-returns/:returnNo — printable return note. */
knittingDcRouter.get('/knitting-yarn-returns/:returnNo', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const [rt] = await listYarnReturns(cid, { return_no: String(req.params.returnNo) });
  if (!rt) throw NotFound('Yarn return not found');
  const prog = await loadProgram(Number(rt.program_id), cid);
  const vendor = rt.vendor_id ? await queryOne<any>(
    `SELECT party_name, gstin, phone FROM mst_party WHERE id = ?`, [rt.vendor_id]) : null;
  const company = await queryOne<any>(
    `SELECT legal_name, trade_name, gstin, address_line1, address_line2, city, state, pincode, phone
       FROM mst_company WHERE id = ?`, [cid]);
  res.json({
    success: true,
    data: {
      ...rt, program_no: prog.program_no, io_no: prog.io_no, buyer_po_no: prog.buyer_po_no,
      style_code: prog.style_code, style_name: prog.style_name,
      vendor_name: vendor?.party_name ?? prog.vendor_name, vendor_gstin: vendor?.gstin ?? null, company,
    },
  });
}));

/* ================================================================
   RECONCILIATION — yarn given vs grey fabric received
================================================================ */

async function reconcile(programId: number, cid: number) {
  const yarnLines = await query<any>(
    `SELECT kpy.id, kpy.seq_no, kpy.yarn_id, kpy.colour, kpy.count_value, kpy.planned_qty_kg,
            kpy.issued_qty_kg, y.yarn_code, y.yarn_name, kpy.yarn_name_manual,
            (SELECT COALESCE(SUM(i.no_of_cones), 0) FROM trx_process_issue i
              WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.src_id = kpy.program_id
                AND i.src_line_id = kpy.id) AS cones_issued,
            (SELECT COALESCE(SUM(rl.return_kg), 0) FROM trx_knitting_yarn_return_line rl
               JOIN trx_knitting_yarn_return rt ON rt.id = rl.return_id
              WHERE rt.company_id = ? AND rt.program_id = kpy.program_id AND rt.status <> 'CANCELLED'
                AND rl.program_yarn_id = kpy.id) AS returned_kg,
            (SELECT COALESCE(SUM(rl.no_of_cones), 0) FROM trx_knitting_yarn_return_line rl
               JOIN trx_knitting_yarn_return rt ON rt.id = rl.return_id
              WHERE rt.company_id = ? AND rt.program_id = kpy.program_id AND rt.status <> 'CANCELLED'
                AND rl.program_yarn_id = kpy.id) AS cones_returned
       FROM trx_knitting_program_yarns kpy
       LEFT JOIN mst_yarn y ON y.id = kpy.yarn_id
      WHERE kpy.program_id = ? ORDER BY kpy.seq_no`, [cid, cid, cid, programId]);

  // Issues from the generic screen without a program line still count as yarn given.
  const unlinked = await queryOne<any>(
    `SELECT COALESCE(SUM(issued_qty_kg), 0) AS kg, COALESCE(SUM(no_of_cones), 0) AS cones
       FROM trx_process_issue
      WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ? AND src_line_id IS NULL`,
    [cid, programId]);
  const unlinkedRet = await queryOne<any>(
    `SELECT COALESCE(SUM(rl.return_kg), 0) AS kg, COALESCE(SUM(rl.no_of_cones), 0) AS cones
       FROM trx_knitting_yarn_return_line rl
       JOIN trx_knitting_yarn_return rt ON rt.id = rl.return_id
      WHERE rt.company_id = ? AND rt.program_id = ? AND rl.program_yarn_id IS NULL AND rt.status <> 'CANCELLED'`, [cid, programId]);

  const rc = await queryOne<any>(
    `SELECT COALESCE(SUM(input_qty), 0) AS consumed, COALESCE(SUM(output_qty), 0) AS fabric,
            COALESCE(SUM(rejected_qty), 0) AS rejected, COALESCE(SUM(loss_qty), 0) AS loss,
            COALESCE(SUM(no_of_rolls), 0) AS rolls, COUNT(*) AS inwards
       FROM trx_process_receipt
      WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ?`, [cid, programId]);

  const unlinkedKg = Number(unlinked?.kg ?? 0);
  const unlinkedRetKg = Number(unlinkedRet?.kg ?? 0);
  const issuedKg = r3(yarnLines.reduce((n, l) => n + Number(l.issued_qty_kg), 0) + unlinkedKg);
  const conesIssued = yarnLines.reduce((n, l) => n + Number(l.cones_issued), 0) + Number(unlinked?.cones ?? 0);
  const returnedKg = r3(yarnLines.reduce((n, l) => n + Number(l.returned_kg), 0) + unlinkedRetKg);
  const conesReturned = yarnLines.reduce((n, l) => n + Number(l.cones_returned), 0) + Number(unlinkedRet?.cones ?? 0);
  const consumed = r3(Number(rc?.consumed ?? 0));
  const balance = r3(issuedKg - consumed - returnedKg);

  // Line-wise: consumption is apportioned by each line's share of the yarn
  // given, capped at what the line still had after its returns. Unlinked
  // issues take part as one extra (hidden) line.
  const alloc = allocateConsumed(consumed, [
    ...yarnLines.map((l) => ({ issued: Number(l.issued_qty_kg), returned: Number(l.returned_kg) })),
    { issued: unlinkedKg, returned: unlinkedRetKg },
  ]);
  const lines = yarnLines.map((l, i) => {
    const issued = Number(l.issued_qty_kg);
    const returned = Number(l.returned_kg);
    const used = alloc[i];
    const bal = r3(issued - used - returned);
    return {
      program_yarn_id: l.id, seq_no: l.seq_no,
      yarn: l.yarn_code ? `${l.yarn_code} — ${l.yarn_name}` : (l.yarn_name_manual || '—'),
      colour: l.colour, count_value: l.count_value,
      planned_kg: Number(l.planned_qty_kg), issued_kg: issued, consumed_kg: used,
      returned_kg: returned, balance_kg: bal, to_issue_kg: r3(Number(l.planned_qty_kg) - issued),
      cones_issued: Number(l.cones_issued), cones_returned: Number(l.cones_returned),
      ...conesAtKnitter(Number(l.cones_issued), Number(l.cones_returned), issued, bal),
    };
  });
  const unlinkedBal = r3(unlinkedKg - alloc[yarnLines.length] - unlinkedRetKg);
  const unlinkedCones = conesAtKnitter(Number(unlinked?.cones ?? 0), Number(unlinkedRet?.cones ?? 0),
    unlinkedKg, unlinkedBal);

  const dcRows = await query<any>(
    `SELECT i.dc_no, MIN(i.issue_date) AS dc_date, SUM(i.issued_qty_kg) AS issued_kg,
            SUM(i.no_of_cones) AS cones
       FROM trx_process_issue i
      WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.src_id = ? AND i.dc_no IS NOT NULL
      GROUP BY i.dc_no ORDER BY MIN(i.id)`, [cid, programId]);
  const dcRc = await query<any>(
    `SELECT m.dc_no AS ref_dc_no, SUM(m.consumed_kg) AS consumed, SUM(m.fabric_kg) AS fabric, MAX(kd.status) AS status, MAX(kd.close_type) AS close_type
       FROM trx_knitting_inward_dc m JOIN trx_process_receipt r ON r.id = m.receipt_id
       LEFT JOIN trx_knitting_dc kd ON kd.company_id = r.company_id AND kd.dc_no = m.dc_no
      WHERE r.company_id = ? AND m.program_id = ? GROUP BY m.dc_no`, [cid, programId]);
  const dcHdr = await query<any>(`SELECT kd.dc_no, COALESCE(j.status, kd.status) status, COALESCE(j.close_type, kd.close_type) close_type, COALESCE(j.rate_per_kg, kd.rate_per_kg) rate_per_kg FROM trx_knitting_dc kd
      LEFT JOIN trx_knitting_dc_job j ON j.company_id = kd.company_id AND j.dc_no = kd.dc_no AND j.program_id = ?
     WHERE kd.company_id = ? AND kd.dc_no IN (SELECT DISTINCT dc_no FROM trx_process_issue WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ?)`, [programId, cid, cid, programId]);
  const dcRet = await query<any>(
    `SELECT dc_no, SUM(total_kg) AS kg, SUM(total_cones) AS cones
       FROM trx_knitting_yarn_return WHERE company_id = ? AND program_id = ? AND status <> 'CANCELLED' GROUP BY dc_no`,
    [cid, programId]);
  const dcs = dcRows.map((d) => {
    const got = dcRc.find((x) => x.ref_dc_no === d.dc_no);
    const ret = dcRet.find((x) => x.dc_no === d.dc_no);
    const issued = Number(d.issued_kg);
    const used = Number(got?.consumed ?? 0);
    const returned = Number(ret?.kg ?? 0);
    return {
      dc_no: d.dc_no, dc_date: d.dc_date, issued_kg: issued, cones: Number(d.cones),
      consumed_kg: used, fabric_kg: Number(got?.fabric ?? 0),
      returned_kg: returned, cones_returned: Number(ret?.cones ?? 0),
      balance_kg: r3(issued - used - returned),
      status: dcHdr.find((x) => x.dc_no === d.dc_no)?.status ?? (used > 0 ? 'PARTIALLY_RECEIVED' : 'OPEN'),
      close_type: dcHdr.find((x) => x.dc_no === d.dc_no)?.close_type ?? null,
      rate_per_kg: dcHdr.find((x) => x.dc_no === d.dc_no)?.rate_per_kg ?? null,
    };
  });

  const fabric = r3(Number(rc?.fabric ?? 0));
  const loss = r3(Number(rc?.loss ?? 0));
  return {
    totals: {
      required_fabric_kg: Number((await queryOne<any>(
        `SELECT required_qty_kg FROM trx_knitting_program WHERE id = ?`, [programId]))?.required_qty_kg ?? 0),
      planned_yarn_kg: r3(yarnLines.reduce((n, l) => n + Number(l.planned_qty_kg), 0)),
      issued_kg: issuedKg,
      consumed_kg: consumed,
      returned_kg: returnedKg,
      fabric_received_kg: fabric,
      rejected_kg: r3(Number(rc?.rejected ?? 0)),
      loss_kg: loss,
      loss_pct: consumed > 0 ? Math.round((loss / consumed) * 10000) / 100 : 0,
      balance_yarn_kg: balance,
      cones_issued: conesIssued,
      cones_returned: conesReturned,
      cones_not_returned: Math.max(0, conesIssued - conesReturned),
      cones_balance: lines.reduce((n, l) => n + l.cones_balance, 0) + unlinkedCones.cones_balance,
      cones_estimated: lines.some((l) => l.cones_estimated && l.cones_balance > 0) ||
        (unlinkedCones.cones_estimated && unlinkedCones.cones_balance > 0),
      rolls_received: Number(rc?.rolls ?? 0),
      inward_count: Number(rc?.inwards ?? 0),
    },
    lines,
    dcs,
  };
}

knittingDcRouter.get('/knitting-programs/:id/reconciliation', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const prog = await loadProgram(id, cid);
  const data = await reconcile(id, cid);
  res.json({
    success: true,
    data: {
      program: {
        id: prog.id, program_no: prog.program_no, io_no: prog.io_no, status: prog.status,
        style_code: prog.style_code, style_name: prog.style_name, fabric_id: prog.fabric_id,
        fabric_name: prog.fabric_name ?? prog.fabric_type, gsm: prog.gsm, dia: prog.dia,
        vendor_id: prog.vendor_id, vendor_name: prog.vendor_name,
      },
      ...data,
    },
  });
}));

export default knittingDcRouter;
