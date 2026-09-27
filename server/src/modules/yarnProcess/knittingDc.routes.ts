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

const dcSchema = z.object({
  program_id: s.idReq(),
  dc_no: s.nullableStr(60),
  dc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendor_id: s.id(),
  vehicle_no: s.nullableStr(30),
  warehouse_id: s.idReq(),
  allow_override: z.coerce.boolean().default(false),
  override_reason: s.nullableStr(255),
  remarks: s.text(),
  lines: z.array(z.object({
    program_yarn_id: s.id(),
    yarn_id: s.idReq(),
    lot_no: s.nullableStr(80),
    yarn_po_no: s.nullableStr(80),
    issued_qty_kg: z.coerce.number().min(0).default(0),
    no_of_cones: z.coerce.number().int().min(0).default(0),
  })).min(1, 'Add at least one yarn line'),
});

knittingDcRouter.post('/knitting-dcs', requirePermission('PROCESS.ISSUE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = dcSchema.parse(req.body);
  const lines = body.lines.filter((l) => l.issued_qty_kg > 0);
  if (!lines.length) throw BadRequest('Enter the KG to send on at least one yarn line');

  const prog = await loadProgram(body.program_id, cid);
  assertEditable(prog.status, 'knitting program');
  if (!DC_READY.includes(prog.status)) {
    throw BadRequest(`Release the program before giving the knitting DC (it is ${prog.status.replace(/_/g, ' ').toLowerCase()})`);
  }
  const vendorId = body.vendor_id ?? prog.vendor_id;
  if (!vendorId) throw BadRequest('Select the knitting vendor the yarn is going to');

  const progLines = await query<any>(
    `SELECT id, yarn_id FROM trx_knitting_program_yarns WHERE program_id = ?`, [body.program_id]);
  const lineIds = new Set(progLines.map((l) => Number(l.id)));
  for (const l of lines) {
    if (l.program_yarn_id && !lineIds.has(Number(l.program_yarn_id))) {
      throw BadRequest('A yarn line does not belong to this program');
    }
  }

  // Stock check per line, counting earlier lines of this DC on the same yarn,
  // and letting the program's own reservation cover its own issue.
  const plan: { line: typeof lines[number]; reservationId: number | null; exceeds: boolean }[] = [];
  const taken = new Map<number, number>();
  for (const l of lines) {
    const resv = l.program_yarn_id ? await queryOne<any>(
      `SELECT id, reserved_qty_kg - released_qty_kg AS open_kg
         FROM trx_process_reservation
        WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ?
          AND src_line_id = ? AND yarn_id = ? AND status IN ('ACTIVE','PARTIAL')
        LIMIT 1`, [cid, body.program_id, l.program_yarn_id, l.yarn_id]) : null;
    const already = taken.get(l.yarn_id) ?? 0;
    const exceeds = await assertIssuable(req.user!, {
      yarn_id: l.yarn_id, warehouse_id: body.warehouse_id, issued_qty_kg: l.issued_qty_kg,
      allow_override: body.allow_override, override_reason: body.override_reason,
      alreadyKg: already, ownReservationKg: Math.max(0, Number(resv?.open_kg ?? 0)),
    });
    taken.set(l.yarn_id, already + l.issued_qty_kg);
    plan.push({ line: l, reservationId: resv ? Number(resv.id) : null, exceeds });
  }

  const result = await transaction(async (tx) => {
    const dcNo = body.dc_no || await nextDocNumber(tx, cid, 'KNIT_DC');
    const dup = await txQueryOne<any>(tx,
      `SELECT id FROM trx_process_issue WHERE company_id = ? AND dc_no = ? LIMIT 1`, [cid, dcNo]);
    if (dup) throw BadRequest(`DC number ${dcNo} is already used`);

    const issues = [];
    for (const p of plan) {
      issues.push(await insertProcessIssue(tx, cid, uid, {
        src_type: 'KNITTING_PROGRAM', src_id: body.program_id,
        src_line_id: p.line.program_yarn_id ?? null, reservation_id: p.reservationId,
        issue_no: null, issue_date: body.dc_date, yarn_id: p.line.yarn_id, batch_id: null,
        lot_no: p.line.lot_no ?? null, yarn_po_no: p.line.yarn_po_no ?? null,
        warehouse_id: body.warehouse_id, issued_qty_kg: p.line.issued_qty_kg,
        allow_override: body.allow_override, override_reason: body.override_reason ?? null,
        remarks: body.remarks ?? null,
        dc_no: dcNo, vendor_id: vendorId, vehicle_no: body.vehicle_no ?? null,
        no_of_cones: p.line.no_of_cones,
      }, p.exceeds));
    }
    return { dc_no: dcNo, issues };
  });

  await audit(req, 'trx_process_issue', body.program_id, 'INSERT', undefined,
    { action: 'KNITTING_DC', ...result });
  res.status(201).json({ success: true, data: result });
}));

/** GET /knitting-dcs — one row per DC (issue lines grouped by dc_no). */
knittingDcRouter.get('/knitting-dcs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  let where = `WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.dc_no IS NOT NULL`;
  const params: any[] = [cid];
  if (req.query.program_id) { where += ' AND i.src_id = ?'; params.push(req.query.program_id); }
  const rows = await query<any>(
    `SELECT i.dc_no, MIN(i.issue_date) AS dc_date, i.src_id AS program_id, kp.program_no,
            kp.io_no, MAX(i.vehicle_no) AS vehicle_no, MAX(p.party_name) AS vendor_name,
            COUNT(*) AS line_count, SUM(i.issued_qty_kg) AS total_kg, SUM(i.no_of_cones) AS total_cones,
            (SELECT COALESCE(SUM(r.output_qty), 0) FROM trx_process_receipt r
              WHERE r.company_id = i.company_id AND r.src_type = 'KNITTING_PROGRAM'
                AND r.src_id = i.src_id AND r.ref_dc_no = i.dc_no) AS fabric_received_kg,
            (SELECT COALESCE(SUM(r.input_qty), 0) FROM trx_process_receipt r
              WHERE r.company_id = i.company_id AND r.src_type = 'KNITTING_PROGRAM'
                AND r.src_id = i.src_id AND r.ref_dc_no = i.dc_no) AS yarn_consumed_kg
       FROM trx_process_issue i
       JOIN trx_knitting_program kp ON kp.id = i.src_id
       LEFT JOIN mst_party p ON p.id = i.vendor_id
       ${where}
      GROUP BY i.dc_no, i.src_id, kp.program_no, kp.io_no, i.company_id
      ORDER BY MIN(i.id) DESC LIMIT 500`, params);
  for (const r of rows) r.balance_yarn_kg = r3(Number(r.total_kg) - Number(r.yarn_consumed_kg));
  res.json({ success: true, data: rows });
}));

/** GET /knitting-dcs/:dcNo — printable DC: program, job, style, vendor, vehicle, yarn lines. */
knittingDcRouter.get('/knitting-dcs/:dcNo', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dcNo = String(req.params.dcNo);
  const lines = await query<any>(
    `SELECT i.*, y.yarn_code, y.yarn_name, y.count_value AS yarn_count,
            kpy.colour, kpy.count_value, w.warehouse_name
       FROM trx_process_issue i
       LEFT JOIN mst_yarn y ON y.id = i.yarn_id
       LEFT JOIN trx_knitting_program_yarns kpy ON kpy.id = i.src_line_id
       LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id
      WHERE i.company_id = ? AND i.dc_no = ? AND i.src_type = 'KNITTING_PROGRAM'
      ORDER BY i.id`, [cid, dcNo]);
  if (!lines.length) throw NotFound('Knitting DC not found');
  const first = lines[0];
  const prog = await loadProgram(Number(first.src_id), cid);
  const vendor = first.vendor_id ? await queryOne<any>(
    `SELECT party_name, gstin, phone FROM mst_party WHERE id = ?`, [first.vendor_id]) : null;
  const company = await queryOne<any>(
    `SELECT legal_name, trade_name, gstin, address_line1, address_line2, city, state, pincode, phone
       FROM mst_company WHERE id = ?`, [cid]);
  res.json({
    success: true,
    data: {
      dc_no: dcNo, dc_date: first.issue_date, vehicle_no: first.vehicle_no,
      warehouse_name: first.warehouse_name, remarks: first.remarks,
      program_id: prog.id, program_no: prog.program_no, io_no: prog.io_no,
      buyer_po_no: prog.buyer_po_no, so_no: prog.so_no,
      style_code: prog.style_code, style_name: prog.style_name,
      fabric_name: prog.fabric_name ?? prog.fabric_type, gsm: prog.gsm, dia: prog.dia,
      gauge: prog.gauge, part_name: prog.part_name, required_qty_kg: prog.required_qty_kg,
      vendor_name: vendor?.party_name ?? prog.vendor_name, vendor_gstin: vendor?.gstin ?? null,
      vendor_phone: vendor?.phone ?? null, company,
      lines,
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
  ref_dc_no: s.nullableStr(60),
  party_dc_no: s.strReq(60),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vehicle_no: s.nullableStr(30),
  warehouse_id: s.idReq(),
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

knittingDcRouter.post('/knitting-inwards', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = inwardSchema.parse(req.body);

  const prog = await loadProgram(body.program_id, cid);
  assertEditable(prog.status, 'knitting program');
  const fabricId = body.fabric_id ?? prog.fabric_id;
  if (!fabricId) throw BadRequest('Select the grey fabric being received (the program has no fabric set)');

  let vendorId = prog.vendor_id;
  if (body.ref_dc_no) {
    const dc = await queryOne<any>(
      `SELECT MAX(vendor_id) AS vendor_id, COUNT(*) AS n FROM trx_process_issue
        WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ? AND dc_no = ?`,
      [cid, body.program_id, body.ref_dc_no]);
    if (!Number(dc?.n)) throw BadRequest(`DC ${body.ref_dc_no} was not given against this program`);
    vendorId = dc.vendor_id ?? vendorId;
  }
  if (!vendorId) throw BadRequest('The program has no knitting vendor to receive from');

  const fabricKg = r3(body.rolls.reduce((n, r) => n + r.weight_kg, 0));
  const consumed = r3(body.yarn_consumed_kg ?? (fabricKg + body.rejected_kg));
  if (consumed + 1e-9 < fabricKg + body.rejected_kg) {
    throw BadRequest('Yarn consumed cannot be less than the fabric received plus rejected');
  }

  // Fabric cannot come back for more yarn than was given (program or DC level).
  const recon = await reconcile(body.program_id, cid);
  const scope = body.ref_dc_no ? recon.dcs.find((d: any) => d.dc_no === body.ref_dc_no) : recon.totals;
  const open = r3(Number(scope?.issued_kg ?? 0) - Number(scope?.consumed_kg ?? 0));
  if (consumed > open + 1e-9) {
    throw BadRequest(
      `Only ${open} KG of yarn is still with the knitter${body.ref_dc_no ? ` on DC ${body.ref_dc_no}` : ''}; ` +
      `this inward accounts for ${consumed} KG`);
  }
  const loss = r3(consumed - fabricKg - body.rejected_kg);

  const result = await transaction(async (tx) => {
    const receiptNo = await nextDocNumber(tx, cid, 'KNIT_INWARD');
    const lotNo = body.lot_no || `${prog.program_no}-${receiptNo}`;
    const note = `Knitting inward — program ${prog.program_no}` +
      (body.ref_dc_no ? `, our DC ${body.ref_dc_no}` : '') + `, party DC ${body.party_dc_no}`;

    // Grey fabric GRN: the rolls live in trx_fabric_roll, which hangs off a GRN,
    // so roll stock, fabric processing and cutting all see them unchanged.
    const g = await txExecute(tx,
      `INSERT INTO trx_grn
         (company_id, grn_no, internal_ir_no, grn_date, style_id, supplier_id, warehouse_id,
          supplier_dc_no, vehicle_no, qc_status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, prog.io_no ?? null, body.receipt_date, prog.style_id ?? null, vendorId,
       body.warehouse_id, body.party_dc_no, body.vehicle_no ?? null, 'ACCEPTED', note, uid]);
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
            gsm, dia, shade, warehouse_id, qc_status, stock_status, remarks)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, grnId, grnLineId, fabricId, rollNo, lotNo, r.meters ?? null, r.weight_kg,
         r.gsm ?? (Number.parseInt(String(prog.gsm ?? ''), 10) || null),
         r.dia ?? prog.dia ?? null, r.shade ?? null, body.warehouse_id, 'ACCEPTED', 'AVAILABLE',
         `Grey from knitting ${prog.program_no}`]);
      rolls.push({ id: fr.insertId, roll_no: rollNo, weight_kg: r.weight_kg });
    }

    const rc = await txExecute(tx,
      `INSERT INTO trx_process_receipt
         (company_id, receipt_no, receipt_date, party_dc_no, ref_dc_no, vehicle_no,
          src_type, src_id, input_qty, output_qty, output_uom_id, loss_qty, rejected_qty,
          output_lot_no, warehouse_id, grn_id, no_of_rolls, qc_status, is_stock_posted,
          remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, body.receipt_date, body.party_dc_no, body.ref_dc_no ?? null,
       body.vehicle_no ?? null, 'KNITTING_PROGRAM', body.program_id, consumed, fabricKg, UOM_KG,
       loss, body.rejected_kg, lotNo, body.warehouse_id, grnId, body.rolls.length, 'PASSED', 1,
       body.remarks ?? null, uid]);
    const receiptId = rc.insertId;

    await postLedger(tx, {
      companyId: cid, warehouseId: body.warehouse_id, materialType: 'FABRIC',
      fabricId, txnType: 'PRODUCTION_IN', refType: 'PROCESS_RECEIPT', refId: receiptId,
      qtyIn: fabricKg, uomId: UOM_KG, createdBy: uid,
    });

    await txExecute(tx,
      `UPDATE trx_knitting_program SET status = 'STOCK_POSTED'
        WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED')`, [body.program_id]);

    return { id: receiptId, receipt_no: receiptNo, grn_id: grnId, lot_no: lotNo,
             fabric_kg: fabricKg, yarn_consumed_kg: consumed, loss_kg: loss, rolls };
  });

  await audit(req, 'trx_process_receipt', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** GET /knitting-inwards — grey fabric inwards with their rolls. */
knittingDcRouter.get('/knitting-inwards', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  let where = `WHERE r.company_id = ? AND r.src_type = 'KNITTING_PROGRAM' AND r.grn_id IS NOT NULL`;
  const params: any[] = [cid];
  if (req.query.program_id) { where += ' AND r.src_id = ?'; params.push(req.query.program_id); }
  const rows = await query<any>(
    `SELECT r.*, kp.program_no, kp.io_no, w.warehouse_name, g.grn_no
       FROM trx_process_receipt r
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
   RECONCILIATION — yarn given vs grey fabric received
================================================================ */

async function reconcile(programId: number, cid: number) {
  const yarnLines = await query<any>(
    `SELECT kpy.id, kpy.seq_no, kpy.yarn_id, kpy.colour, kpy.count_value, kpy.planned_qty_kg,
            kpy.issued_qty_kg, y.yarn_code, y.yarn_name, kpy.yarn_name_manual,
            (SELECT COALESCE(SUM(i.no_of_cones), 0) FROM trx_process_issue i
              WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.src_id = kpy.program_id
                AND i.src_line_id = kpy.id) AS cones_issued
       FROM trx_knitting_program_yarns kpy
       LEFT JOIN mst_yarn y ON y.id = kpy.yarn_id
      WHERE kpy.program_id = ? ORDER BY kpy.seq_no`, [cid, programId]);

  // Issues from the generic screen without a program line still count as yarn given.
  const unlinked = await queryOne<any>(
    `SELECT COALESCE(SUM(issued_qty_kg), 0) AS kg, COALESCE(SUM(no_of_cones), 0) AS cones
       FROM trx_process_issue
      WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ? AND src_line_id IS NULL`,
    [cid, programId]);

  const rc = await queryOne<any>(
    `SELECT COALESCE(SUM(input_qty), 0) AS consumed, COALESCE(SUM(output_qty), 0) AS fabric,
            COALESCE(SUM(rejected_qty), 0) AS rejected, COALESCE(SUM(loss_qty), 0) AS loss,
            COALESCE(SUM(no_of_rolls), 0) AS rolls, COUNT(*) AS inwards
       FROM trx_process_receipt
      WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ?`, [cid, programId]);

  const issuedKg = r3(yarnLines.reduce((n, l) => n + Number(l.issued_qty_kg), 0) + Number(unlinked?.kg ?? 0));
  const conesIssued = yarnLines.reduce((n, l) => n + Number(l.cones_issued), 0) + Number(unlinked?.cones ?? 0);
  const consumed = r3(Number(rc?.consumed ?? 0));
  const balance = r3(issuedKg - consumed);
  // Share of the issued yarn still at the knitter; cones follow the same share.
  const openShare = issuedKg > 0 ? Math.max(0, balance) / issuedKg : 0;

  // Line-wise: consumption is apportioned by each line's share of the yarn given.
  const lines = yarnLines.map((l) => {
    const issued = Number(l.issued_qty_kg);
    const used = issuedKg > 0 ? r3(consumed * issued / issuedKg) : 0;
    return {
      program_yarn_id: l.id, seq_no: l.seq_no,
      yarn: l.yarn_code ? `${l.yarn_code} — ${l.yarn_name}` : (l.yarn_name_manual || '—'),
      colour: l.colour, count_value: l.count_value,
      planned_kg: Number(l.planned_qty_kg), issued_kg: issued, consumed_kg: used,
      balance_kg: r3(issued - used), to_issue_kg: r3(Number(l.planned_qty_kg) - issued),
      cones_issued: Number(l.cones_issued),
      cones_balance: Math.round(Number(l.cones_issued) * openShare),
    };
  });

  const dcRows = await query<any>(
    `SELECT i.dc_no, MIN(i.issue_date) AS dc_date, SUM(i.issued_qty_kg) AS issued_kg,
            SUM(i.no_of_cones) AS cones
       FROM trx_process_issue i
      WHERE i.company_id = ? AND i.src_type = 'KNITTING_PROGRAM' AND i.src_id = ? AND i.dc_no IS NOT NULL
      GROUP BY i.dc_no ORDER BY MIN(i.id)`, [cid, programId]);
  const dcRc = await query<any>(
    `SELECT ref_dc_no, SUM(input_qty) AS consumed, SUM(output_qty) AS fabric
       FROM trx_process_receipt
      WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id = ? AND ref_dc_no IS NOT NULL
      GROUP BY ref_dc_no`, [cid, programId]);
  const dcs = dcRows.map((d) => {
    const got = dcRc.find((x) => x.ref_dc_no === d.dc_no);
    const issued = Number(d.issued_kg);
    const used = Number(got?.consumed ?? 0);
    return {
      dc_no: d.dc_no, dc_date: d.dc_date, issued_kg: issued, cones: Number(d.cones),
      consumed_kg: used, fabric_kg: Number(got?.fabric ?? 0), balance_kg: r3(issued - used),
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
      fabric_received_kg: fabric,
      rejected_kg: r3(Number(rc?.rejected ?? 0)),
      loss_kg: loss,
      loss_pct: consumed > 0 ? Math.round((loss / consumed) * 10000) / 100 : 0,
      balance_yarn_kg: balance,
      cones_issued: conesIssued,
      cones_balance: Math.round(conesIssued * openShare),
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
