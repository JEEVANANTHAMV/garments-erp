import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

/**
 * Process master, operations and contractor bills (client review 24-Sep-2026).
 *
 *   Process (cfg_process_stage)  → operations (mst_process_operation) such as
 *   power table / singer / overlock under Stitching, each with a default rate;
 *   each contractor can have its own rate per operation (mst_contractor_op_rate).
 *   A DC picks the operations it is sent for and its rate / PCS is their sum.
 *
 *   Contractor bills pass process inwards for payment: good PCS (plus mistake
 *   PCS when the process pays for them) × the DC rate, less TDS / deductions.
 */
export const processMasterRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const reasonReq = z.string().trim().min(3, 'Give a reason (min 3 characters)').max(255);

// ============================================================
// Processes + operations
// ============================================================
processMasterRouter.get('/process-master', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const stages = await query<any>(
    `SELECT id, stage_code, stage_name, sort_order, is_outsourceable, bill_include_mistake, is_active
       FROM cfg_process_stage WHERE company_id = ? ORDER BY sort_order, id`, [cid]);
  const ops = await query<any>(
    `SELECT id, stage_id, op_code, op_name, default_rate, sort_order, is_active
       FROM mst_process_operation WHERE company_id = ? ORDER BY sort_order, op_name`, [cid]);
  res.json({ data: stages.map((st) => ({ ...st, operations: ops.filter((o) => Number(o.stage_id) === Number(st.id)) })) });
}));

const stageSchema = z.object({
  stage_code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase()),
  stage_name: z.string().trim().min(1).max(80),
  sort_order: z.coerce.number().int().min(0).max(9999).default(0),
  is_outsourceable: z.coerce.boolean().default(true),
  bill_include_mistake: z.coerce.boolean().default(false),
  is_active: z.coerce.boolean().default(true),
});

processMasterRouter.post('/process-master/stages', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = stageSchema.parse(req.body);
  const dup = await queryOne(`SELECT id FROM cfg_process_stage WHERE company_id = ? AND stage_code = ?`, [cid, b.stage_code]);
  if (dup) throw BadRequest(`Process code ${b.stage_code} already exists`);
  const r = await execute(
    `INSERT INTO cfg_process_stage (company_id, stage_code, stage_name, sort_order, is_outsourceable, bill_include_mistake, is_active)
     VALUES (?,?,?,?,?,?,?)`,
    [cid, b.stage_code, b.stage_name, b.sort_order, b.is_outsourceable ? 1 : 0, b.bill_include_mistake ? 1 : 0, b.is_active ? 1 : 0]);
  await audit(req, 'cfg_process_stage', r.insertId, 'INSERT', undefined, b);
  res.status(201).json({ data: { id: r.insertId } });
}));

processMasterRouter.put('/process-master/stages/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = stageSchema.parse(req.body);
  const before = await queryOne<any>(`SELECT * FROM cfg_process_stage WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!before) throw NotFound('Process not found');
  const dup = await queryOne(`SELECT id FROM cfg_process_stage WHERE company_id = ? AND stage_code = ? AND id <> ?`, [cid, b.stage_code, id]);
  if (dup) throw BadRequest(`Process code ${b.stage_code} already exists`);
  await execute(
    `UPDATE cfg_process_stage SET stage_code = ?, stage_name = ?, sort_order = ?, is_outsourceable = ?, bill_include_mistake = ?, is_active = ?
      WHERE id = ?`,
    [b.stage_code, b.stage_name, b.sort_order, b.is_outsourceable ? 1 : 0, b.bill_include_mistake ? 1 : 0, b.is_active ? 1 : 0, id]);
  await audit(req, 'cfg_process_stage', id, 'UPDATE', before, b);
  res.json({ data: { id } });
}));

const opSchema = z.object({
  stage_id: s.idReq(),
  op_code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase().replace(/\s+/g, '_')),
  op_name: z.string().trim().min(1).max(80),
  default_rate: z.coerce.number().min(0).max(100000).default(0),
  sort_order: z.coerce.number().int().min(0).max(9999).default(0),
  is_active: z.coerce.boolean().default(true),
});

async function opCheck(cid: number, b: z.infer<typeof opSchema>, id = 0) {
  const st = await queryOne(`SELECT id FROM cfg_process_stage WHERE id = ? AND company_id = ?`, [b.stage_id, cid]);
  if (!st) throw BadRequest('Process not found');
  const dup = await queryOne(`SELECT id FROM mst_process_operation WHERE company_id = ? AND op_code = ? AND id <> ?`, [cid, b.op_code, id]);
  if (dup) throw BadRequest(`Operation code ${b.op_code} already exists`);
}

processMasterRouter.post('/process-master/operations', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = opSchema.parse(req.body);
  await opCheck(cid, b);
  const r = await execute(
    `INSERT INTO mst_process_operation (company_id, stage_id, op_code, op_name, default_rate, sort_order, is_active) VALUES (?,?,?,?,?,?,?)`,
    [cid, b.stage_id, b.op_code, b.op_name, b.default_rate, b.sort_order, b.is_active ? 1 : 0]);
  await audit(req, 'mst_process_operation', r.insertId, 'INSERT', undefined, b);
  res.status(201).json({ data: { id: r.insertId } });
}));

processMasterRouter.put('/process-master/operations/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = opSchema.parse(req.body);
  const before = await queryOne<any>(`SELECT * FROM mst_process_operation WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!before) throw NotFound('Operation not found');
  await opCheck(cid, b, id);
  await execute(
    `UPDATE mst_process_operation SET stage_id = ?, op_code = ?, op_name = ?, default_rate = ?, sort_order = ?, is_active = ? WHERE id = ?`,
    [b.stage_id, b.op_code, b.op_name, b.default_rate, b.sort_order, b.is_active ? 1 : 0, id]);
  await audit(req, 'mst_process_operation', id, 'UPDATE', before, b);
  res.json({ data: { id } });
}));

// ============================================================
// Contractor rates per operation
// ============================================================
/** Current rate per operation for a contractor (latest effective, active row). */
export async function contractorRates(cid: number, vendorId: number | null, stageId?: number | null) {
  const where = ['o.company_id = ?', 'o.is_active = 1'];
  const params: unknown[] = [vendorId ?? 0, cid];
  if (stageId) { where.push('o.stage_id = ?'); params.push(stageId); }
  return query<any>(
    `SELECT o.id, o.stage_id, o.op_code, o.op_name, o.default_rate, o.sort_order,
            (SELECT r.rate FROM mst_contractor_op_rate r
              WHERE r.company_id = o.company_id AND r.vendor_id = ? AND r.operation_id = o.id AND r.is_active = 1
                AND (r.effective_from IS NULL OR r.effective_from <= CURDATE())
              ORDER BY r.effective_from DESC, r.id DESC LIMIT 1) AS contractor_rate
       FROM mst_process_operation o
      WHERE ${where.join(' AND ')}
      ORDER BY o.sort_order, o.op_name`, params).then((rows) => rows.map((o) => ({
    ...o, rate: o.contractor_rate != null ? n(o.contractor_rate) : n(o.default_rate),
  })));
}

/** GET /process-master/operations?stage_id=&vendor_id= — operations with the rate that applies. */
processMasterRouter.get('/process-master/operations', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ stage_id: s.id(), vendor_id: s.id() }).parse(req.query);
  res.json({ data: await contractorRates(req.user!.companyId, qp.vendor_id ?? null, qp.stage_id ?? null) });
}));

processMasterRouter.put('/process-master/contractor-rates', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    vendor_id: s.idReq(),
    rates: z.array(z.object({ operation_id: s.idReq(), rate: z.coerce.number().min(0).max(100000).nullable() })).max(500),
  }).parse(req.body);
  const v = await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.vendor_id, cid]);
  if (!v) throw BadRequest('Contractor not found');
  await transaction(async (tx) => {
    for (const r of b.rates) {
      const op = await txQueryOne(tx, `SELECT id FROM mst_process_operation WHERE id = ? AND company_id = ?`, [r.operation_id, cid]);
      if (!op) throw BadRequest('Operation not found');
      // One active rate per contractor + operation: blank clears it (falls back to the default rate).
      await txExecute(tx,
        `UPDATE mst_contractor_op_rate SET is_active = 0 WHERE company_id = ? AND vendor_id = ? AND operation_id = ? AND is_active = 1`,
        [cid, b.vendor_id, r.operation_id]);
      if (r.rate != null) {
        await txExecute(tx,
          `INSERT INTO mst_contractor_op_rate (company_id, vendor_id, operation_id, rate, effective_from) VALUES (?,?,?,?,CURDATE())`,
          [cid, b.vendor_id, r.operation_id, r.rate]);
      }
    }
    await audit(req, 'mst_contractor_op_rate', b.vendor_id, 'UPDATE', undefined, { rates: b.rates }, tx);
  });
  res.json({ data: await contractorRates(cid, b.vendor_id) });
}));

// ============================================================
// Contractor bills (pass process inwards for payment)
// ============================================================
/** Process inwards of a contractor not yet on a live bill. */
async function unbilledReceipts(cid: number, vendorId: number, from?: string, to?: string) {
  const where = ['r.company_id = ?', 'r.vendor_id = ?', 'r.contractor_bill_id IS NULL'];
  const params: unknown[] = [cid, vendorId];
  if (from) { where.push('r.receipt_date >= ?'); params.push(from); }
  if (to) { where.push('r.receipt_date <= ?'); params.push(to); }
  const rows = await query<any>(
    `SELECT r.id AS receipt_id, r.receipt_no, r.receipt_date, r.party_dc_no, r.received_qty, r.rejected_qty,
            jc.id AS challan_id, jc.challan_no, jc.rate, ps.stage_name, ps.bill_include_mistake,
            (SELECT GROUP_CONCAT(DISTINCT jl.io_no ORDER BY jl.io_no SEPARATOR ', ')
               FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
              WHERE rl.receipt_id = r.id) AS io_list,
            (SELECT GROUP_CONCAT(o.op_name ORDER BY o.sort_order SEPARATOR ', ')
               FROM trx_jobwork_challan_op co JOIN mst_process_operation o ON o.id = co.operation_id
              WHERE co.challan_id = jc.id) AS operations
       FROM trx_jobwork_receipt r
       JOIN trx_jobwork_challan jc ON jc.id = r.challan_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.receipt_date, r.id`, params);
  return rows.map((r) => {
    const billed = n(r.received_qty) + (n(r.bill_include_mistake) ? n(r.rejected_qty) : 0);
    return { ...r, rate: n(r.rate), billed_qty: billed, amount: r2(billed * n(r.rate)) };
  });
}

processMasterRouter.get('/contractor-bills/unbilled', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ vendor_id: s.idReq(), from: dateStr.optional(), to: dateStr.optional() }).parse(req.query);
  res.json({ data: await unbilledReceipts(req.user!.companyId, qp.vendor_id, qp.from, qp.to) });
}));

processMasterRouter.get('/contractor-bills', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['b.company_id = ?'];
  const params: unknown[] = [cid];
  if (req.query.vendor_id) { where.push('b.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.status) { where.push('b.status = ?'); params.push(String(req.query.status)); }
  const rows = await query(
    `SELECT b.*, p.party_name AS vendor_name, p.is_contractor,
            (SELECT COUNT(*) FROM trx_contractor_bill_line l WHERE l.bill_id = b.id) AS line_count
       FROM trx_contractor_bill b LEFT JOIN mst_party p ON p.id = b.vendor_id
      WHERE ${where.join(' AND ')} ORDER BY b.bill_date DESC, b.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

async function loadBill(cid: number, id: number) {
  const bill = await queryOne<any>(
    `SELECT b.*, p.party_name AS vendor_name, p.party_code AS vendor_code, p.gstin AS vendor_gstin, p.is_contractor,
            u.full_name AS created_by_name, ua.full_name AS approved_by_name
       FROM trx_contractor_bill b LEFT JOIN mst_party p ON p.id = b.vendor_id
       LEFT JOIN mst_user u ON u.id = b.created_by LEFT JOIN mst_user ua ON ua.id = b.approved_by
      WHERE b.id = ? AND b.company_id = ?`, [id, cid]);
  if (!bill) throw NotFound('Contractor bill not found');
  bill.lines = await query<any>(
    `SELECT l.*, r.receipt_no, r.receipt_date, r.party_dc_no, jc.challan_no, ps.stage_name,
            (SELECT GROUP_CONCAT(DISTINCT jl.io_no ORDER BY jl.io_no SEPARATOR ', ')
               FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
              WHERE rl.receipt_id = r.id) AS io_list,
            (SELECT GROUP_CONCAT(o.op_name ORDER BY o.sort_order SEPARATOR ', ')
               FROM trx_jobwork_challan_op co JOIN mst_process_operation o ON o.id = co.operation_id
              WHERE co.challan_id = jc.id) AS operations
       FROM trx_contractor_bill_line l
       JOIN trx_jobwork_receipt r ON r.id = l.receipt_id
       JOIN trx_jobwork_challan jc ON jc.id = l.challan_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE l.bill_id = ? ORDER BY r.receipt_date, r.id`, [id]);
  return bill;
}

processMasterRouter.get('/contractor-bills/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const bill = await loadBill(cid, Number(req.params.id));
  const company = await queryOne(
    `SELECT legal_name, trade_name, address_line1, address_line2, city, state, pincode, gstin, phone FROM mst_company WHERE id = ?`, [cid]);
  res.json({ data: { ...bill, company } });
}));

const billSchema = z.object({
  bill_no: s.nullableStr(40),
  bill_date: dateStr,
  vendor_id: s.idReq(),
  period_from: s.date(),
  period_to: s.date(),
  receipt_ids: z.array(s.idReq()).min(1, 'Pick at least one process inward').max(1000),
  tds_pct: z.coerce.number().min(0).max(30).default(0),
  other_deduction_label: s.nullableStr(80),
  other_deduction: z.coerce.number().min(0).default(0),
  remarks: s.nullableStr(500),
});

processMasterRouter.post('/contractor-bills', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = billSchema.parse(req.body);
  const id = await transaction(async (tx) => {
    const ids = [...new Set(b.receipt_ids)].sort((x, y) => x - y);
    // Lock the inwards so one inward can only ever be passed on one bill.
    const locked = await txQuery<any>(tx,
      `SELECT id, receipt_no, vendor_id, contractor_bill_id FROM trx_jobwork_receipt WHERE company_id = ? AND id IN (?) FOR UPDATE`, [cid, ids]);
    if (locked.length !== ids.length) throw BadRequest('Some process inwards were not found');
    const wrong = locked.find((r) => Number(r.vendor_id) !== b.vendor_id);
    if (wrong) throw BadRequest(`Inward ${wrong.receipt_no} belongs to another contractor`);
    const billedAlready = locked.find((r) => r.contractor_bill_id);
    if (billedAlready) throw BadRequest(`Inward ${billedAlready.receipt_no} is already on a contractor bill`);

    const lines = (await unbilledReceipts(cid, b.vendor_id)).filter((r) => ids.includes(Number(r.receipt_id)));
    const qty = lines.reduce((a, l) => a + l.billed_qty, 0);
    const gross = r2(lines.reduce((a, l) => a + l.amount, 0));
    const tds = r2(gross * b.tds_pct / 100);
    const beforeRound = gross - tds - b.other_deduction;
    if (beforeRound < 0) throw BadRequest('Deductions exceed the bill amount');
    const net = Math.round(beforeRound);
    const billNo = b.bill_no || await nextDocNumber(tx, cid, 'CONTRACTOR_BILL');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_contractor_bill WHERE company_id = ? AND bill_no = ?`, [cid, billNo]);
    if (dup) throw BadRequest(`Bill no ${billNo} already exists`);
    const r = await txExecute(tx,
      `INSERT INTO trx_contractor_bill
         (company_id, bill_no, bill_date, vendor_id, period_from, period_to, billed_qty, gross_amount, tds_pct, tds_amount,
          other_deduction_label, other_deduction, round_off, net_amount, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,
      [cid, billNo, b.bill_date, b.vendor_id, b.period_from ?? null, b.period_to ?? null, qty, gross, b.tds_pct, tds,
       b.other_deduction_label ?? null, b.other_deduction, r2(net - beforeRound), net, b.remarks ?? null, req.user!.id]);
    for (const l of lines) {
      await txExecute(tx,
        `INSERT INTO trx_contractor_bill_line (bill_id, receipt_id, challan_id, good_qty, mistake_qty, billed_qty, rate, amount)
         VALUES (?,?,?,?,?,?,?,?)`,
        [r.insertId, l.receipt_id, l.challan_id, n(l.received_qty), n(l.rejected_qty), l.billed_qty, l.rate, l.amount]);
    }
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [r.insertId, ...ids]);
    await audit(req, 'trx_contractor_bill', r.insertId, 'INSERT', undefined, { bill_no: billNo, inwards: ids.length, gross, net }, tx);
    return r.insertId;
  });
  res.status(201).json({ data: await loadBill(cid, id) });
}));

processMasterRouter.post('/contractor-bills/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const bill = await queryOne<any>(`SELECT status, bill_no FROM trx_contractor_bill WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!bill) throw NotFound('Contractor bill not found');
  if (bill.status !== 'DRAFT') throw BadRequest(`Bill ${bill.bill_no} is ${bill.status}`);
  await execute(`UPDATE trx_contractor_bill SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [req.user!.id, id]);
  await audit(req, 'trx_contractor_bill', id, 'UPDATE', { status: 'DRAFT' }, { status: 'APPROVED' });
  res.json({ data: await loadBill(cid, id) });
}));

/** Cancel a bill: its inwards become billable again. */
processMasterRouter.post('/contractor-bills/:id/cancel', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, `SELECT status, bill_no FROM trx_contractor_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Contractor bill not found');
    if (bill.status === 'CANCELLED') throw BadRequest(`Bill ${bill.bill_no} is already cancelled`);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = NULL WHERE contractor_bill_id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_contractor_bill SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
    await audit(req, 'trx_contractor_bill', id, 'UPDATE', { status: bill.status }, { status: 'CANCELLED', reason }, tx);
  });
  res.json({ data: await loadBill(cid, id) });
}));
