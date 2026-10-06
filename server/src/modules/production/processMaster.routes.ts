import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { effectiveBasis, billedQty, BillBasis, BILL_BASIS_LABEL } from './billBasis.js';

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

/**
 * GET /process-master/operations?stage_id=&vendor_id=&io_no= — operations with the rate that applies:
 * the job's rate card when io_no is given and the job has one, else the contractor's rate, else the default.
 */
processMasterRouter.get('/process-master/operations', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const qp = z.object({ stage_id: s.id(), vendor_id: s.id(), io_no: z.string().trim().max(40).optional() }).parse(req.query);
  const ops = await contractorRates(cid, qp.vendor_id ?? null, qp.stage_id ?? null);
  if (!qp.io_no) { res.json({ data: ops }); return; }
  const card = await query<any>(`SELECT operation_id, rate FROM trx_job_op_rate WHERE company_id = ? AND io_no = ?`, [cid, qp.io_no]);
  const byOp = new Map(card.map((c) => [Number(c.operation_id), n(c.rate)]));
  res.json({
    data: ops.map((o) => (byOp.has(Number(o.id))
      ? { ...o, rate: byOp.get(Number(o.id)), job_rate: byOp.get(Number(o.id)), in_job_card: true }
      : { ...o, in_job_card: false })),
    meta: { io_no: qp.io_no, job_card_ops: card.length },
  });
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
// Job rate card — per job (IO no) only the operations it needs, with its rate
// (client voice note 29-Sep-2026: power table / singer / flatlock rates fixed
//  job-wise; not every job uses every operation of the master)
// ============================================================

/** Job rate card of a job for a process: every operation of the process, with the job's rate where picked. */
async function jobRateCard(cid: number, ioNo: string, stageId: number) {
  const rows = await query<any>(
    `SELECT o.id AS operation_id, o.op_code, o.op_name, o.default_rate, o.sort_order,
            j.id AS card_id, j.rate AS job_rate, j.remarks
       FROM mst_process_operation o
       LEFT JOIN trx_job_op_rate j ON j.operation_id = o.id AND j.company_id = o.company_id AND j.io_no = ?
      WHERE o.company_id = ? AND o.stage_id = ? AND (o.is_active = 1 OR j.id IS NOT NULL)
      ORDER BY o.sort_order, o.op_name`, [ioNo, cid, stageId]);
  return rows.map((r) => ({ ...r, selected: !!r.card_id, job_rate: r.job_rate == null ? null : n(r.job_rate), default_rate: n(r.default_rate) }));
}

/** GET /job-rate-cards — jobs that have a rate card, per process, with the total rate / PCS. */
processMasterRouter.get('/job-rate-cards', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query<any>(
    `SELECT j.io_no, j.stage_id, ps.stage_name, MAX(j.style_id) AS style_id, MAX(st.style_code) AS style_code,
            COUNT(*) AS operations, SUM(j.rate) AS total_rate, MAX(COALESCE(j.updated_at, j.created_at)) AS updated_at
       FROM trx_job_op_rate j
       LEFT JOIN cfg_process_stage ps ON ps.id = j.stage_id
       LEFT JOIN mst_style st ON st.id = j.style_id
      WHERE j.company_id = ? ${req.query.io_no ? 'AND j.io_no = ?' : ''}
      GROUP BY j.io_no, j.stage_id, ps.stage_name ORDER BY updated_at DESC LIMIT 500`,
    req.query.io_no ? [cid, String(req.query.io_no)] : [cid]);
  res.json({ data: rows.map((r) => ({ ...r, total_rate: r2(n(r.total_rate)) })) });
}));

/** GET /job-rate-cards/card?io_no=&stage_id= — the card to edit. */
processMasterRouter.get('/job-rate-cards/card', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ io_no: z.string().trim().min(1).max(40), stage_id: s.idReq() }).parse(req.query);
  res.json({ data: await jobRateCard(req.user!.companyId, qp.io_no, qp.stage_id) });
}));

/** PUT /job-rate-cards — replace a job's picked operations + rates for one process. */
processMasterRouter.put('/job-rate-cards', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    io_no: z.string().trim().min(1).max(40),
    style_id: s.id(),
    stage_id: s.idReq(),
    operations: z.array(z.object({
      operation_id: s.idReq(),
      rate: z.coerce.number().min(0).max(100000),
      remarks: s.nullableStr(255),
    })).max(200),
  }).parse(req.body);
  const so = await queryOne<any>(`SELECT id FROM trx_sales_order WHERE company_id = ? AND io_no = ? AND is_deleted = 0 LIMIT 1`, [cid, b.io_no]);
  const cut = await queryOne<any>(`SELECT id FROM trx_cutting_bundle WHERE company_id = ? AND io_no = ? LIMIT 1`, [cid, b.io_no]);
  if (!so && !cut) throw BadRequest(`Job ${b.io_no} not found (no sales order or cutting with that IO no)`);
  const ids = b.operations.map((o) => o.operation_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('An operation is listed twice');
  if (ids.length) {
    const ops = await query<any>(`SELECT id, stage_id FROM mst_process_operation WHERE company_id = ? AND id IN (?)`, [cid, ids]);
    if (ops.length !== ids.length) throw BadRequest('Operation not found');
    if (ops.some((o) => Number(o.stage_id) !== b.stage_id)) throw BadRequest('Every operation must belong to the chosen process');
  }
  await transaction(async (tx) => {
    const before = await txQuery<any>(tx, `SELECT operation_id, rate FROM trx_job_op_rate WHERE company_id = ? AND io_no = ? AND stage_id = ?`, [cid, b.io_no, b.stage_id]);
    await txExecute(tx, `DELETE FROM trx_job_op_rate WHERE company_id = ? AND io_no = ? AND stage_id = ?`, [cid, b.io_no, b.stage_id]);
    for (const o of b.operations) {
      await txExecute(tx,
        `INSERT INTO trx_job_op_rate (company_id, io_no, style_id, stage_id, operation_id, rate, remarks, created_by) VALUES (?,?,?,?,?,?,?,?)`,
        [cid, b.io_no, b.style_id ?? null, b.stage_id, o.operation_id, o.rate, o.remarks ?? null, req.user!.id]);
    }
    await audit(req, 'trx_job_op_rate', 0, 'UPDATE', { io_no: b.io_no, stage_id: b.stage_id, operations: before },
      { io_no: b.io_no, stage_id: b.stage_id, operations: b.operations }, tx);
  });
  res.json({ data: await jobRateCard(cid, b.io_no, b.stage_id) });
}));

/**
 * Our piece rate for PCS of a job on a DC: the job's rate card for the DC's
 * operations (or all the job's operations of that process when the DC names
 * none); operations the job card lacks keep the DC's own rate. No job card → DC rate.
 */
export async function jobPieceRates(cid: number, challanIds: number[], ioNos: string[]) {
  const out = new Map<string, number>(); // `${challanId}|${io}` → rate
  if (!challanIds.length) return out;
  const dcs = await query<any>(`SELECT id, stage_id, rate FROM trx_jobwork_challan WHERE id IN (?)`, [challanIds]);
  const dcOps = await query<any>(`SELECT challan_id, operation_id, rate FROM trx_jobwork_challan_op WHERE challan_id IN (?)`, [challanIds]);
  const ios = [...new Set(ioNos.filter(Boolean))];
  const cards = ios.length
    ? await query<any>(`SELECT io_no, stage_id, operation_id, rate FROM trx_job_op_rate WHERE company_id = ? AND io_no IN (?)`, [cid, ios])
    : [];
  for (const dc of dcs) {
    const ops = dcOps.filter((o) => Number(o.challan_id) === Number(dc.id));
    for (const io of ios) {
      const card = cards.filter((c) => c.io_no === io && Number(c.stage_id) === Number(dc.stage_id));
      if (!card.length) { out.set(`${dc.id}|${io}`, n(dc.rate)); continue; }
      const rate = ops.length
        ? ops.reduce((a, o) => a + (card.find((c) => Number(c.operation_id) === Number(o.operation_id))?.rate != null
          ? n(card.find((c) => Number(c.operation_id) === Number(o.operation_id))!.rate) : n(o.rate)), 0)
        : card.reduce((a, c) => a + n(c.rate), 0);
      out.set(`${dc.id}|${io}`, Math.round(rate * 10000) / 10000);
    }
  }
  return out;
}

// ============================================================
// Contractor bills (pass process inwards for payment)
//   our rate  = job rate card (else DC rate) per job on the inward
//   bill rate = rate on the contractor's invoice; excess over ours must be
//               ALLOWed, kept as ADVANCE (paid, recovered later) or REVISEd
//   net       = payable + GST − TDS − % deduction − other − advance − debit notes
// ============================================================
async function unbilledReceipts(cid: number, vendorId: number, from?: string, to?: string, includeBillId?: number, overrideBasis?: string | null) {
  // only QC-accepted, billable inward (job work doc §16: billing from approved output, never from outward)
  const where = ['r.company_id = ?', 'r.vendor_id = ?', includeBillId ? '(r.contractor_bill_id IS NULL OR r.contractor_bill_id = ?)' : 'r.contractor_bill_id IS NULL',
    `(r.contractor_bill_id IS NOT NULL OR (COALESCE(r.qc_status, 'ACCEPTED') = 'ACCEPTED' AND COALESCE(r.billable, 1) = 1))`];
  const params: unknown[] = includeBillId ? [cid, vendorId, includeBillId] : [cid, vendorId];
  if (from) { where.push('r.receipt_date >= ?'); params.push(from); }
  if (to) { where.push('r.receipt_date <= ?'); params.push(to); }
  const rows = await query<any>(
    `SELECT r.id AS receipt_id, r.receipt_no, r.receipt_date, r.party_dc_no, r.received_qty, r.rejected_qty,
            COALESCE(r.shortage_qty, 0) AS shortage_qty, COALESCE(r.loss_qty, 0) AS loss_qty,
            jc.id AS challan_id, jc.challan_no, jc.rate AS dc_rate, jc.bill_basis AS dc_bill_basis,
            p.jw_bill_basis AS party_bill_basis, ps.stage_name, ps.bill_include_mistake,
            (SELECT GROUP_CONCAT(DISTINCT jl.io_no ORDER BY jl.io_no SEPARATOR ', ')
               FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
              WHERE rl.receipt_id = r.id) AS io_list,
            (SELECT GROUP_CONCAT(o.op_name ORDER BY o.sort_order SEPARATOR ', ')
               FROM trx_jobwork_challan_op co JOIN mst_process_operation o ON o.id = co.operation_id
              WHERE co.challan_id = jc.id) AS operations
       FROM trx_jobwork_receipt r
       JOIN trx_jobwork_challan jc ON jc.id = r.challan_id
       LEFT JOIN mst_party p ON p.id = r.vendor_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.receipt_date, r.id`, params);
  if (!rows.length) return [];
  // Billed PCS per job on each inward, priced with the job's rate card.
  const perIo = await query<any>(
    `SELECT rl.receipt_id, jl.io_no, SUM(rl.received_qty) AS good, SUM(rl.rejected_qty) AS mistake,
            SUM(COALESCE(rl.shortage_qty, 0)) AS short, SUM(COALESCE(rl.loss_qty, 0)) AS loss
       FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
      WHERE rl.receipt_id IN (?) GROUP BY rl.receipt_id, jl.io_no`, [rows.map((r) => r.receipt_id)]);
  const rates = await jobPieceRates(cid, [...new Set(rows.map((r) => Number(r.challan_id)))], perIo.map((p) => p.io_no));
  return rows.map((r) => {
    const basis = effectiveBasis({
      override: overrideBasis,
      dc: r.dc_bill_basis,
      party: r.party_bill_basis,
      stageInclMistake: r.bill_include_mistake,
    });
    const billed = billedQty(basis, {
      good: r.received_qty,
      mistake: r.rejected_qty,
      short: r.shortage_qty,
      loss: r.loss_qty,
    });
    const parts = perIo.filter((p) => Number(p.receipt_id) === Number(r.receipt_id));
    let amount = 0; let qty = 0;
    const jobs = parts.map((p) => {
      const q = billedQty(basis, {
        good: p.good,
        mistake: p.mistake,
        short: p.short,
        loss: p.loss,
      });
      const rate = rates.get(`${r.challan_id}|${p.io_no}`) ?? n(r.dc_rate);
      amount += q * rate; qty += q;
      return { io_no: p.io_no, qty: q, rate };
    });
    // Inwards without per-bundle lines fall back to the DC rate.
    const ourRate = qty > 0 ? Math.round((amount / qty) * 10000) / 10000 : n(r.dc_rate);
    return {
      ...r,
      bill_basis: basis,
      bill_basis_label: BILL_BASIS_LABEL[basis],
      dc_rate: n(r.dc_rate),
      rate: ourRate,
      our_rate: ourRate,
      jobs,
      billed_qty: billed,
      amount: r2(billed * ourRate),
    };
  });
}

processMasterRouter.get('/contractor-bills/unbilled', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  // bill_id: also return the inwards already on that draft (to revise it).
  const qp = z.object({ vendor_id: s.idReq(), from: dateStr.optional(), to: dateStr.optional(), bill_id: s.id(), basis: z.enum(['ISSUED', 'GOOD', 'GOOD_MISTAKE']).nullish() }).parse(req.query);
  res.json({ data: await unbilledReceipts(req.user!.companyId, qp.vendor_id, qp.from, qp.to, qp.bill_id ?? undefined, qp.basis) });
}));

processMasterRouter.get('/contractor-bills', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['b.company_id = ?'];
  const params: unknown[] = [cid];
  if (req.query.vendor_id) { where.push('b.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.status) { where.push('b.status = ?'); params.push(String(req.query.status)); }
  const rows = await query(
    `SELECT b.*, p.party_name AS vendor_name, p.is_contractor,
            (SELECT COUNT(*) FROM trx_contractor_bill_line l WHERE l.bill_id = b.id) AS line_count,
            (SELECT COUNT(*) FROM trx_contractor_bill_line l WHERE l.bill_id = b.id AND l.variance_action = 'REVISE' AND l.bill_rate > l.our_rate) AS to_revise
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
  bill.debit_notes = await query<any>(`SELECT * FROM trx_contractor_debit_note WHERE bill_id = ? AND status <> 'CANCELLED' ORDER BY id`, [id]);
  return bill;
}

processMasterRouter.get('/contractor-bills/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const bill = await loadBill(cid, Number(req.params.id));
  const company = await queryOne(
    `SELECT legal_name, trade_name, address_line1, address_line2, city, state, pincode, gstin, phone FROM mst_company WHERE id = ?`, [cid]);
  res.json({ data: { ...bill, company } });
}));

const VARIANCE = ['NONE', 'ALLOW', 'ADVANCE', 'REVISE'] as const;
const billSchema = z.object({
  bill_no: s.nullableStr(40),
  bill_date: dateStr,
  vendor_id: s.idReq(),
  period_from: s.date(),
  period_to: s.date(),
  bill_basis: z.enum(['ISSUED', 'GOOD', 'GOOD_MISTAKE']).nullish(),
  receipt_ids: z.array(s.idReq()).min(1, 'Pick at least one process inward').max(1000),
  // Contractor's invoice rate per inward and what to do with any excess over our rate.
  lines: z.array(z.object({
    receipt_id: s.idReq(),
    bill_rate: z.coerce.number().min(0).max(100000).nullish(),
    bill_basis: z.enum(['ISSUED', 'GOOD', 'GOOD_MISTAKE']).nullish(),
    variance_action: z.enum(VARIANCE).default('NONE'),
  })).max(1000).default([]),
  tds_pct: z.coerce.number().min(0).max(30).default(0),
  gst_pct: z.coerce.number().min(0).max(28).default(0),      // job work GST (e.g. 5 / 12 / 18) — optional
  is_interstate: z.coerce.boolean().default(false),
  deduction_pct: z.coerce.number().min(0).max(50).default(0),   // e.g. retention / quality %
  deduction_label: s.nullableStr(80),
  other_deduction_label: s.nullableStr(80),
  other_deduction: z.coerce.number().min(0).default(0),
  advance_adjust: z.coerce.number().min(0).default(0),
  debit_note_ids: z.array(s.idReq()).max(200).default([]),
  remarks: s.nullableStr(500),
});
type BillBody = z.infer<typeof billSchema>;

/** Open advance of a contractor: advances given − advances already adjusted on live bills. */
async function advanceBalance(runner: 'q' | any, cid: number, vendorId: number, excludeBillId = 0) {
  const run = (sql: string, p: unknown[]) => (runner === 'q' ? query<any>(sql, p) : txQuery<any>(runner, sql, p));
  const [a] = await run(`SELECT COALESCE(SUM(amount),0) AS amt FROM trx_contractor_advance WHERE company_id = ? AND vendor_id = ? AND status = 'ACTIVE'`, [cid, vendorId]);
  const [u] = await run(`SELECT COALESCE(SUM(advance_adjusted),0) AS amt FROM trx_contractor_bill WHERE company_id = ? AND vendor_id = ? AND status IN ('DRAFT','APPROVED') AND id <> ?`, [cid, vendorId, excludeBillId]);
  return { advanced: r2(n(a?.amt)), adjusted: r2(n(u?.amt)), balance: r2(n(a?.amt) - n(u?.amt)) };
}

/** Validate + price a bill (create or edit). Inwards and debit notes are locked by the caller's transaction. */
async function buildBill(tx: any, cid: number, b: BillBody, billId = 0) {
  const ids = [...new Set(b.receipt_ids)].sort((x, y) => x - y);
  const locked = await txQuery<any>(tx,
    `SELECT id, receipt_no, vendor_id, contractor_bill_id FROM trx_jobwork_receipt WHERE company_id = ? AND id IN (?) FOR UPDATE`, [cid, ids]);
  if (locked.length !== ids.length) throw BadRequest('Some process inwards were not found');
  const wrong = locked.find((r) => Number(r.vendor_id) !== b.vendor_id);
  if (wrong) throw BadRequest(`Inward ${wrong.receipt_no} belongs to another contractor`);
  const billedAlready = locked.find((r) => r.contractor_bill_id && Number(r.contractor_bill_id) !== billId);
  if (billedAlready) throw BadRequest(`Inward ${billedAlready.receipt_no} is already on a contractor bill`);

  const input = new Map(b.lines.map((l) => [l.receipt_id, l]));
  const priced = (await unbilledReceipts(cid, b.vendor_id, undefined, undefined, billId || undefined, b.bill_basis)).filter((r) => ids.includes(Number(r.receipt_id)));
  const lines = priced.map((r) => {
    const inp = input.get(Number(r.receipt_id));
    const basis = (inp?.bill_basis || b.bill_basis || r.bill_basis) as BillBasis;
    const billed = basis !== r.bill_basis ? billedQty(basis, { good: r.received_qty, mistake: r.rejected_qty, short: r.shortage_qty, loss: r.loss_qty }) : r.billed_qty;
    const billRate = inp?.bill_rate != null ? n(inp.bill_rate) : r.our_rate;
    const over = billRate > r.our_rate + 0.00005;
    const action = over ? (inp?.variance_action ?? 'NONE') : 'NONE';
    // Pay the lower of the two unless the excess is allowed / kept as advance.
    const payRate = over && (action === 'ALLOW' || action === 'ADVANCE') ? billRate : Math.min(billRate, r.our_rate);
    const excess = over ? r2((billRate - r.our_rate) * billed) : 0;
    return { ...r, bill_basis: basis, billed_qty: billed, bill_rate: billRate, variance_action: action, pay_rate: payRate, excess, amount: r2(billed * payRate) };
  });
  const qty = lines.reduce((a, l) => a + l.billed_qty, 0);
  const gross = r2(lines.reduce((a, l) => a + l.amount, 0));
  const excessTotal = r2(lines.reduce((a, l) => a + l.excess, 0));
  const excessAsAdvance = r2(lines.filter((l) => l.variance_action === 'ADVANCE').reduce((a, l) => a + l.excess, 0));

  // Debit notes of this contractor, open (or already on this bill).
  const dnIds = [...new Set(b.debit_note_ids)];
  const dns = dnIds.length
    ? await txQuery<any>(tx, `SELECT * FROM trx_contractor_debit_note WHERE company_id = ? AND id IN (?) FOR UPDATE`, [cid, dnIds])
    : [];
  for (const d of dns) {
    if (Number(d.vendor_id) !== b.vendor_id) throw BadRequest(`Debit note ${d.dn_no} belongs to another contractor`);
    if (d.status === 'CANCELLED') throw BadRequest(`Debit note ${d.dn_no} is cancelled`);
    if (d.status === 'ADJUSTED' && Number(d.bill_id) !== billId) throw BadRequest(`Debit note ${d.dn_no} is already deducted on another bill`);
  }
  if (dns.length !== dnIds.length) throw BadRequest('Debit note not found');
  const dnAmount = r2(dns.reduce((a, d) => a + n(d.amount), 0));

  const adv = await advanceBalance(tx, cid, b.vendor_id, billId);
  if (b.advance_adjust > adv.balance + 0.005) throw BadRequest(`Only ₹${adv.balance} advance is open for this contractor — ₹${b.advance_adjust} cannot be adjusted`);

  // GST on the job-work value; TDS (194C) and the % deduction on the value before GST.
  const gst = r2(gross * b.gst_pct / 100);
  const tds = r2(gross * b.tds_pct / 100);
  const pctDed = r2(gross * b.deduction_pct / 100);
  const beforeRound = gross + gst - tds - pctDed - b.other_deduction - b.advance_adjust - dnAmount;
  if (beforeRound < 0) throw BadRequest('Deductions exceed the bill amount');
  const net = Math.round(beforeRound);
  return { ids, lines, qty, gross, gst, tds, pctDed, dnAmount, dns, excessTotal, excessAsAdvance, beforeRound, net };
}

async function writeBillLines(tx: any, billId: number, lines: any[]) {
  for (const l of lines) {
    await txExecute(tx,
      `INSERT INTO trx_contractor_bill_line
         (bill_id, receipt_id, challan_id, good_qty, mistake_qty, short_loss_qty, billed_qty, bill_basis, rate, our_rate, bill_rate, variance_action, excess_amount, amount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [billId, l.receipt_id, l.challan_id, n(l.received_qty), n(l.rejected_qty), n(l.shortage_qty) + n(l.loss_qty), l.billed_qty,
       l.bill_basis ?? null, l.pay_rate, l.our_rate, l.bill_rate, l.variance_action, l.excess, l.amount]);
  }
}

processMasterRouter.post('/contractor-bills', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = billSchema.parse(req.body);
  const id = await transaction(async (tx) => {
    const x = await buildBill(tx, cid, b);
    const billNo = b.bill_no || await nextDocNumber(tx, cid, 'CONTRACTOR_BILL');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_contractor_bill WHERE company_id = ? AND bill_no = ?`, [cid, billNo]);
    if (dup) throw BadRequest(`Bill no ${billNo} already exists`);
    const r = await txExecute(tx,
      `INSERT INTO trx_contractor_bill
         (company_id, bill_no, bill_date, vendor_id, period_from, period_to, billed_qty, gross_amount, gst_pct, gst_amount,
          is_interstate, tds_pct, tds_amount, other_deduction_label, other_deduction, deduction_pct, deduction_label, deduction_amount,
          advance_adjusted, debit_note_amount, excess_amount, excess_as_advance, round_off, net_amount, status, remarks, bill_basis, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?)`,
      [cid, billNo, b.bill_date, b.vendor_id, b.period_from ?? null, b.period_to ?? null, x.qty, x.gross, b.gst_pct, x.gst,
       b.is_interstate ? 1 : 0, b.tds_pct, x.tds, b.other_deduction_label ?? null, b.other_deduction,
       b.deduction_pct, b.deduction_label ?? null, x.pctDed, b.advance_adjust, x.dnAmount, x.excessTotal, x.excessAsAdvance,
       r2(x.net - x.beforeRound), x.net, b.remarks ?? null, b.bill_basis ?? null, req.user!.id]);
    await writeBillLines(tx, r.insertId, x.lines);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = ? WHERE id IN (${x.ids.map(() => '?').join(',')})`, [r.insertId, ...x.ids]);
    if (x.dns.length) {
      await txExecute(tx, `UPDATE trx_contractor_debit_note SET status = 'ADJUSTED', bill_id = ? WHERE id IN (${x.dns.map(() => '?').join(',')})`,
        [r.insertId, ...x.dns.map((d: any) => Number(d.id))]);
    }
    await audit(req, 'trx_contractor_bill', r.insertId, 'INSERT', undefined,
      { bill_no: billNo, inwards: x.ids.length, gross: x.gross, gst: x.gst, tds: x.tds, deduction: x.pctDed, advance: b.advance_adjust, debit_notes: x.dnAmount, net: x.net }, tx);
    return r.insertId;
  });
  res.status(201).json({ data: await loadBill(cid, id) });
}));

/** PUT /contractor-bills/:id — revise a draft (contractor's rates, variance actions, deductions). */
processMasterRouter.put('/contractor-bills/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = billSchema.parse(req.body);
  await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, `SELECT * FROM trx_contractor_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Contractor bill not found');
    if (bill.status !== 'DRAFT') throw BadRequest(`Bill ${bill.bill_no} is ${bill.status} — only a draft can be revised`);
    if (Number(bill.vendor_id) !== b.vendor_id) throw BadRequest('The contractor of a bill cannot be changed');
    const x = await buildBill(tx, cid, b, id);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = NULL WHERE contractor_bill_id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_contractor_debit_note SET status = 'OPEN', bill_id = NULL WHERE bill_id = ? AND status = 'ADJUSTED'`, [id]);
    await txExecute(tx, `DELETE FROM trx_contractor_bill_line WHERE bill_id = ?`, [id]);
    await txExecute(tx,
      `UPDATE trx_contractor_bill SET bill_date = ?, period_from = ?, period_to = ?, billed_qty = ?, gross_amount = ?, gst_pct = ?, gst_amount = ?,
              is_interstate = ?, tds_pct = ?, tds_amount = ?, other_deduction_label = ?, other_deduction = ?, deduction_pct = ?, deduction_label = ?,
              deduction_amount = ?, advance_adjusted = ?, debit_note_amount = ?, excess_amount = ?, excess_as_advance = ?, round_off = ?,
              net_amount = ?, remarks = ?, bill_basis = ?
        WHERE id = ?`,
      [b.bill_date, b.period_from ?? null, b.period_to ?? null, x.qty, x.gross, b.gst_pct, x.gst, b.is_interstate ? 1 : 0, b.tds_pct, x.tds,
       b.other_deduction_label ?? null, b.other_deduction, b.deduction_pct, b.deduction_label ?? null, x.pctDed, b.advance_adjust, x.dnAmount,
       x.excessTotal, x.excessAsAdvance, r2(x.net - x.beforeRound), x.net, b.remarks ?? null, b.bill_basis ?? null, id]);
    await writeBillLines(tx, id, x.lines);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = ? WHERE id IN (${x.ids.map(() => '?').join(',')})`, [id, ...x.ids]);
    if (x.dns.length) {
      await txExecute(tx, `UPDATE trx_contractor_debit_note SET status = 'ADJUSTED', bill_id = ? WHERE id IN (${x.dns.map(() => '?').join(',')})`,
        [id, ...x.dns.map((d: any) => Number(d.id))]);
    }
    await audit(req, 'trx_contractor_bill', id, 'UPDATE', { net: bill.net_amount }, { net: x.net, gross: x.gross }, tx);
  });
  res.json({ data: await loadBill(cid, id) });
}));

processMasterRouter.post('/contractor-bills/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, `SELECT * FROM trx_contractor_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Contractor bill not found');
    if (bill.status !== 'DRAFT') throw BadRequest(`Bill ${bill.bill_no} is ${bill.status}`);
    // The contractor's rate may not exceed ours unless the excess was allowed or kept as advance.
    const open = await txQuery<any>(tx,
      `SELECT l.*, r.receipt_no FROM trx_contractor_bill_line l JOIN trx_jobwork_receipt r ON r.id = l.receipt_id
        WHERE l.bill_id = ? AND l.bill_rate > l.our_rate + 0.00005 AND l.variance_action NOT IN ('ALLOW','ADVANCE')`, [id]);
    if (open.length) {
      throw BadRequest(`Revise the bill first — ${open.map((l) => `${l.receipt_no}: billed ₹${n(l.bill_rate)} vs our ₹${n(l.our_rate)} (${l.variance_action === 'REVISE' ? 'to revise' : 'no decision'})`).join('; ')}`);
    }
    if (n(bill.advance_adjusted) > 0) {
      const adv = await advanceBalance(tx, cid, Number(bill.vendor_id), id);
      if (n(bill.advance_adjusted) > adv.balance + 0.005) throw BadRequest(`Only ₹${adv.balance} advance is open — revise the advance adjusted on this bill`);
    }
    // Excess paid but kept as advance becomes a recoverable advance to the contractor.
    if (n(bill.excess_as_advance) > 0) {
      const no = await nextDocNumber(tx, cid, 'CONTRACTOR_ADVANCE');
      await txExecute(tx,
        `INSERT INTO trx_contractor_advance (company_id, advance_no, advance_date, vendor_id, amount, source, bill_id, remarks, created_by)
         VALUES (?,?,?,?,?,'BILL_EXCESS',?,?,?)`,
        [cid, no, String(bill.bill_date).slice(0, 10), bill.vendor_id, n(bill.excess_as_advance), id,
         `Excess rate on bill ${bill.bill_no} kept as advance`, req.user!.id]);
    }
    await txExecute(tx, `UPDATE trx_contractor_bill SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [req.user!.id, id]);
    await audit(req, 'trx_contractor_bill', id, 'UPDATE', { status: 'DRAFT' }, { status: 'APPROVED', excess_as_advance: n(bill.excess_as_advance) }, tx);
  });
  res.json({ data: await loadBill(cid, id) });
}));

/** Cancel a bill: its inwards become billable again, debit notes reopen, excess advance is cancelled. */
processMasterRouter.post('/contractor-bills/:id/cancel', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, `SELECT status, bill_no FROM trx_contractor_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Contractor bill not found');
    if (bill.status === 'CANCELLED') throw BadRequest(`Bill ${bill.bill_no} is already cancelled`);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = NULL WHERE contractor_bill_id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_contractor_debit_note SET status = 'OPEN', bill_id = NULL WHERE bill_id = ? AND status = 'ADJUSTED'`, [id]);
    await txExecute(tx, `UPDATE trx_contractor_advance SET status = 'CANCELLED', cancel_reason = ? WHERE bill_id = ? AND source = 'BILL_EXCESS' AND status = 'ACTIVE'`,
      [`Bill ${bill.bill_no} cancelled`, id]);
    await txExecute(tx, `UPDATE trx_contractor_bill SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
    await audit(req, 'trx_contractor_bill', id, 'UPDATE', { status: bill.status }, { status: 'CANCELLED', reason }, tx);
  });
  res.json({ data: await loadBill(cid, id) });
}));

// ============================================================
// Contractor advances (recovered on bills)
// ============================================================
processMasterRouter.get('/contractor-advances/balance', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ vendor_id: s.idReq(), bill_id: s.id() }).parse(req.query);
  res.json({ data: await advanceBalance('q', req.user!.companyId, qp.vendor_id, qp.bill_id ?? 0) });
}));

processMasterRouter.get('/contractor-advances', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['a.company_id = ?']; const params: unknown[] = [cid];
  if (req.query.vendor_id) { where.push('a.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  const rows = await query(
    `SELECT a.*, p.party_name AS vendor_name, b.bill_no FROM trx_contractor_advance a
       LEFT JOIN mst_party p ON p.id = a.vendor_id LEFT JOIN trx_contractor_bill b ON b.id = a.bill_id
      WHERE ${where.join(' AND ')} ORDER BY a.advance_date DESC, a.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

processMasterRouter.post('/contractor-advances', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    advance_date: dateStr, vendor_id: s.idReq(), amount: z.coerce.number().positive().max(10000000),
    pay_mode: s.nullableStr(30), ref_no: s.nullableStr(60), remarks: s.nullableStr(255),
  }).parse(req.body);
  const v = await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.vendor_id, cid]);
  if (!v) throw BadRequest('Contractor not found');
  const row = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'CONTRACTOR_ADVANCE');
    const r = await txExecute(tx,
      `INSERT INTO trx_contractor_advance (company_id, advance_no, advance_date, vendor_id, amount, source, pay_mode, ref_no, remarks, created_by)
       VALUES (?,?,?,?,?,'PAYMENT',?,?,?,?)`,
      [cid, no, b.advance_date, b.vendor_id, b.amount, b.pay_mode ?? null, b.ref_no ?? null, b.remarks ?? null, req.user!.id]);
    await audit(req, 'trx_contractor_advance', r.insertId, 'INSERT', undefined, { advance_no: no, ...b }, tx);
    return { id: r.insertId, advance_no: no };
  });
  res.status(201).json({ data: { ...row, balance: await advanceBalance('q', cid, b.vendor_id) } });
}));

processMasterRouter.post('/contractor-advances/:id/cancel', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  await transaction(async (tx) => {
    const a = await txQueryOne<any>(tx, `SELECT * FROM trx_contractor_advance WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!a) throw NotFound('Advance not found');
    if (a.status !== 'ACTIVE') throw BadRequest(`Advance ${a.advance_no} is already ${a.status}`);
    if (a.source === 'BILL_EXCESS') throw BadRequest('This advance comes from a bill — cancel the bill instead');
    const bal = await advanceBalance(tx, cid, Number(a.vendor_id));
    if (bal.balance - n(a.amount) < -0.005) throw BadRequest(`₹${r2(n(a.amount) - bal.balance)} of this advance is already adjusted on bills — it cannot be cancelled`);
    await txExecute(tx, `UPDATE trx_contractor_advance SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
    await audit(req, 'trx_contractor_advance', id, 'UPDATE', { status: 'ACTIVE' }, { status: 'CANCELLED', reason }, tx);
  });
  res.json({ data: { id, status: 'CANCELLED' } });
}));

// ============================================================
// Contractor debit notes (defective work), deducted on a bill
// ============================================================
processMasterRouter.get('/contractor-debit-notes', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['d.company_id = ?']; const params: unknown[] = [cid];
  if (req.query.vendor_id) { where.push('d.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.status) { where.push('d.status = ?'); params.push(String(req.query.status)); }
  const rows = await query(
    `SELECT d.*, p.party_name AS vendor_name, b.bill_no, r.receipt_no FROM trx_contractor_debit_note d
       LEFT JOIN mst_party p ON p.id = d.vendor_id LEFT JOIN trx_contractor_bill b ON b.id = d.bill_id
       LEFT JOIN trx_jobwork_receipt r ON r.id = d.receipt_id
      WHERE ${where.join(' AND ')} ORDER BY d.dn_date DESC, d.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

processMasterRouter.post('/contractor-debit-notes', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    dn_date: dateStr, vendor_id: s.idReq(), receipt_id: s.id(), io_no: s.nullableStr(40),
    reason: z.string().trim().min(3, 'Give the reason (e.g. wrong stitching)').max(255),
    qty: z.coerce.number().int().min(0).default(0), rate: z.coerce.number().min(0).default(0),
    amount: z.coerce.number().min(0).optional(),
  }).parse(req.body);
  const amount = r2(b.amount ?? b.qty * b.rate);
  if (!(amount > 0)) throw BadRequest('Enter the amount, or qty × rate');
  if (b.receipt_id) {
    const r = await queryOne<any>(`SELECT vendor_id FROM trx_jobwork_receipt WHERE id = ? AND company_id = ?`, [b.receipt_id, cid]);
    if (!r) throw BadRequest('Process inward not found');
    if (Number(r.vendor_id) !== b.vendor_id) throw BadRequest('That process inward belongs to another contractor');
  }
  const row = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'CONTRACTOR_DN');
    const r = await txExecute(tx,
      `INSERT INTO trx_contractor_debit_note (company_id, dn_no, dn_date, vendor_id, receipt_id, io_no, reason, qty, rate, amount, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.dn_date, b.vendor_id, b.receipt_id ?? null, b.io_no ?? null, b.reason, b.qty, b.rate, amount, req.user!.id]);
    await audit(req, 'trx_contractor_debit_note', r.insertId, 'INSERT', undefined, { dn_no: no, ...b, amount }, tx);
    return { id: r.insertId, dn_no: no, amount };
  });
  res.status(201).json({ data: row });
}));

processMasterRouter.post('/contractor-debit-notes/:id/cancel', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  const d = await queryOne<any>(`SELECT * FROM trx_contractor_debit_note WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!d) throw NotFound('Debit note not found');
  if (d.status !== 'OPEN') throw BadRequest(`Debit note ${d.dn_no} is ${d.status}${d.status === 'ADJUSTED' ? ' on a bill — remove it from the bill first' : ''}`);
  await execute(`UPDATE trx_contractor_debit_note SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
  await audit(req, 'trx_contractor_debit_note', id, 'UPDATE', { status: 'OPEN' }, { status: 'CANCELLED', reason });
  res.json({ data: { id, status: 'CANCELLED' } });
}));
