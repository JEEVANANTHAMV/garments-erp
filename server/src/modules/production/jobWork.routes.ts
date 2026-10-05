/**
 * External job work / subcontracting engine (client document "External Job Work Subcontracting" + voice note
 * 05-Oct-2026). One generic engine — the process is configuration, not code:
 *
 *   Job Work Order (process route) → Outward DC (bundle DC, or fabric DC for cutting + packing) → contractor stock
 *   → Inward (good / reject / shortage / loss / unprocessed return / rework) → QC → reconciliation → contractor bill
 *   → advance / debit / credit / payment → contractor statement
 *
 * Bundle DCs, inwards, returns, QC and bills live in processDc.routes.ts / processMaster.routes.ts; this module adds the
 * order, the fabric DC, contractor stock, dashboard, genealogy / ledger, process rates, credit notes, payments, statement.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { orderLineBalances, refreshJwOrder, resolveJwRate } from './jwOrderStatus.js';
import { postReceipt, DC_PENDING } from './processDc.routes.js';
import { RESERVED_KG_SQL, refreshFabricRollStatus } from './cuttingEngine.js';
import { resolveSoId } from '../stock/jobStock.routes.js';

export const jobWorkRouter = Router();
jobWorkRouter.param('id', (_req, _res, next, v) => (/^\d+$/.test(String(v)) ? next() : next(NotFound('Not found'))));

const VIEW = requirePermission('PRODUCTION.VIEW');
const PLAN = requireAny('PRODUCTION.CREATE', 'JOBWORK.PLAN');
const APPROVE = requireAny('PRODUCTION.APPROVE', 'JOBWORK.APPROVE');
const ACCOUNTS = requireAny('PRODUCTION.APPROVE', 'JOBWORK.ACCOUNTS');
const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const today = () => new Date().toISOString().slice(0, 10);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ================================================================ Job Work Order (doc §6, §23) */

const lineSchema = z.object({
  seq_no: z.coerce.number().int().min(1).max(999).optional(),
  stage_id: s.idReq(),
  input_kind: z.enum(['BUNDLE', 'GARMENT', 'FABRIC', 'OTHER']).default('BUNDLE'),
  input_desc: s.nullableStr(160),
  input_uom: z.enum(['PCS', 'KG', 'M']).default('PCS'),
  output_kind: z.enum(['GARMENT', 'PACKED', 'PANEL', 'FABRIC', 'OTHER']).default('GARMENT'),
  output_desc: s.nullableStr(160),
  output_uom: z.enum(['PCS', 'KG', 'M', 'CARTON']).default('PCS'),
  planned_input_qty: z.coerce.number().min(0),
  expected_output_qty: z.coerce.number().min(0).default(0),
  loss_tolerance_pct: z.coerce.number().min(0).max(100).nullish(),
  rate: z.coerce.number().min(0).nullish(),
  rate_basis: z.enum(['PCS', 'KG', 'M', 'BUNDLE', 'CARTON']).default('PCS'),
  remarks: s.nullableStr(255),
});
const orderSchema = z.object({
  so_id: s.id(),
  io_no: s.nullableStr(60),
  style_id: s.id(),
  vendor_id: s.idReq(),
  order_date: dateStr,
  expected_return_date: s.date(),
  currency_id: s.id(),
  remarks: s.nullableStr(500),
  lines: z.array(lineSchema).min(1, 'Add the process route (at least one process)').max(20),
});

const ORDER_SELECT = `SELECT o.*, v.party_name AS vendor_name, so.so_no, st.style_code, st.style_name, b.party_name AS buyer_name,
       ua.full_name AS approved_by_name
  FROM trx_jw_order o
  LEFT JOIN mst_party v ON v.id = o.vendor_id
  LEFT JOIN trx_sales_order so ON so.id = o.so_id
  LEFT JOIN mst_style st ON st.id = o.style_id
  LEFT JOIN mst_party b ON b.id = o.buyer_id
  LEFT JOIN mst_user ua ON ua.id = o.approved_by`;

async function checkOrder(cid: number, b: z.infer<typeof orderSchema>) {
  const v = await queryOne<any>(`SELECT id FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.vendor_id, cid]);
  if (!v) throw BadRequest('Contractor not found');
  const soId = await resolveSoId(cid, b.so_id ?? null, b.io_no ?? null);
  const so = soId ? await queryOne<any>(`SELECT id, so_no, io_no, buyer_id, buyer_po_no FROM trx_sales_order WHERE id = ? AND company_id = ?`, [soId, cid]) : null;
  if ((b.so_id || b.io_no) && !so) throw BadRequest('Job not found');
  if (so && b.style_id) {
    const onJob = await queryOne(`SELECT 1 x FROM trx_sales_order_line WHERE so_id = ? AND style_id = ? LIMIT 1`, [so.id, b.style_id]);
    if (!onJob) throw BadRequest('That style is not on the job');
  }
  for (const l of b.lines) {
    const st = await queryOne<any>(`SELECT id FROM cfg_process_stage WHERE id = ? AND company_id = ?`, [l.stage_id, cid]);
    if (!st) throw BadRequest(`Process #${l.stage_id} not found`);
    if (l.input_kind === 'FABRIC' && l.input_uom === 'PCS') throw BadRequest('A fabric input is counted in KG or metres');
  }
  return so;
}

async function writeOrderLines(tx: Tx, orderId: number, lines: z.infer<typeof lineSchema>[]) {
  await txExecute(tx, `DELETE FROM trx_jw_order_line WHERE order_id = ?`, [orderId]);
  let seq = 0;
  for (const l of lines) {
    seq = l.seq_no ?? seq + 10;
    await txExecute(tx,
      `INSERT INTO trx_jw_order_line (order_id, seq_no, stage_id, input_kind, input_desc, input_uom, output_kind, output_desc, output_uom,
          planned_input_qty, expected_output_qty, loss_tolerance_pct, rate, rate_basis, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [orderId, seq, l.stage_id, l.input_kind, l.input_desc ?? null, l.input_uom, l.output_kind, l.output_desc ?? null, l.output_uom,
       l.planned_input_qty, l.expected_output_qty, l.loss_tolerance_pct ?? null, l.rate ?? null, l.rate_basis, l.remarks ?? null]);
  }
}

jobWorkRouter.get('/job-work/orders', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['o.company_id = ?']; const p: any[] = [cid];
  for (const k of ['vendor_id', 'so_id', 'style_id'] as const) if (req.query[k]) { where.push(`o.${k} = ?`); p.push(Number(req.query[k])); }
  if (req.query.status) { where.push('o.status = ?'); p.push(String(req.query.status)); }
  if (req.query.q) { where.push('(o.jw_no LIKE ? OR o.io_no LIKE ? OR v.party_name LIKE ?)'); const q = `%${req.query.q}%`; p.push(q, q, q); }
  const rows = await query<any>(`${ORDER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.order_date DESC, o.id DESC LIMIT 500`, p);
  const out = [];
  for (const o of rows) {
    const ls = await orderLineBalances(null, Number(o.id));
    out.push({ ...o, processes: ls.map((l) => l.stage_name).join(' → '),
      lines: ls.map((l) => ({ id: l.id, seq_no: l.seq_no, stage_id: l.stage_id, stage_name: l.stage_name, input_kind: l.input_kind, planned: l.planned, outward: l.outward, pending_outward: l.pending_outward, balance_uom: l.balance_uom, rate: l.rate })), planned: ls.reduce((a, l) => a + l.planned, 0),
      outward: ls.reduce((a, l) => a + l.outward, 0), good: ls.reduce((a, l) => a + l.good, 0),
      contractor_pcs: ls.reduce((a, l) => a + l.contractor_pcs, 0), contractor_kg: r3(ls.reduce((a, l) => a + l.contractor_kg, 0)),
      overdue: !!o.expected_return_date && String(o.expected_return_date).slice(0, 10) < today() && !['COMPLETED', 'CLOSED', 'CANCELLED', 'DRAFT'].includes(o.status) });
  }
  res.json({ data: out });
}));

async function loadOrder(cid: number, id: number) {
  const o = await queryOne<any>(`${ORDER_SELECT} WHERE o.id = ? AND o.company_id = ?`, [id, cid]);
  if (!o) throw NotFound('Job work order not found');
  const lines = await orderLineBalances(null, id);
  const dcs = await query<any>(
    `SELECT jc.id, jc.challan_no, jc.challan_date, jc.status, jc.dc_kind, jc.jw_order_line_id, jc.total_qty, jc.rate, jc.expected_return, ps.stage_name,
            COALESCE(SUM(jl.received_qty),0) good, COALESCE(SUM(jl.rejected_qty),0) reject, COALESCE(SUM(jl.shortage_qty + jl.loss_qty),0) loss,
            COALESCE(SUM(jl.returned_qty),0) returned, COALESCE(SUM(jl.rework_open_qty),0) rework_open,
            COALESCE(SUM(CASE WHEN jc.status IN ('ISSUED','PARTIAL_RECEIVED') THEN ${DC_PENDING('jl.')} ELSE 0 END),0) pending,
            (SELECT COALESCE(SUM(fi.issue_kg),0) FROM trx_jw_fabric_issue fi WHERE fi.challan_id = jc.id) fabric_kg,
            (SELECT COALESCE(SUM(fi.issue_kg - fi.consumed_kg - fi.returned_kg - fi.waste_kg),0) FROM trx_jw_fabric_issue fi WHERE fi.challan_id = jc.id) fabric_balance_kg
       FROM trx_jobwork_challan jc LEFT JOIN trx_jobwork_challan_line jl ON jl.challan_id = jc.id LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE jc.jw_order_id = ? GROUP BY jc.id ORDER BY jc.id`, [id]);
  const receipts = dcs.length ? await query<any>(
    `SELECT r.id, r.receipt_no, r.receipt_date, r.challan_id, r.received_qty, r.rejected_qty, r.shortage_qty, r.loss_qty, r.return_qty, r.rework_qty,
            r.qc_status, r.billable, r.contractor_bill_id, cb.bill_no, cb.status AS bill_status
       FROM trx_jobwork_receipt r LEFT JOIN trx_contractor_bill cb ON cb.id = r.contractor_bill_id
      WHERE r.challan_id IN (${dcs.map(() => '?').join(',')}) ORDER BY r.id`, dcs.map((d) => d.id)) : [];
  // financial (doc §23): rate × planned = estimated gross; advances / debit / credit of this contractor for the job
  const estGross = r2(lines.reduce((a, l) => a + n(l.rate) * n(l.expected_output_qty || l.planned_input_qty), 0));
  const billed = await queryOne<any>(
    `SELECT COALESCE(SUM(bl.amount),0) amt FROM trx_contractor_bill_line bl JOIN trx_contractor_bill cb ON cb.id = bl.bill_id
      WHERE cb.status <> 'CANCELLED' AND bl.receipt_id IN (SELECT r.id FROM trx_jobwork_receipt r JOIN trx_jobwork_challan jc ON jc.id = r.challan_id WHERE jc.jw_order_id = ?)`, [id]).catch(() => ({ amt: 0 }));
  const debit = await queryOne<any>(`SELECT COALESCE(SUM(amount),0) a FROM trx_contractor_debit_note WHERE company_id = ? AND vendor_id = ? AND status <> 'CANCELLED' AND io_no <=> ?`, [cid, o.vendor_id, o.io_no]);
  const credit = await queryOne<any>(`SELECT COALESCE(SUM(amount),0) a FROM trx_contractor_credit_note WHERE company_id = ? AND jw_order_id = ? AND status <> 'CANCELLED'`, [cid, id]);
  return { ...o, lines, dcs, receipts, financial: { estimated_gross: estGross, billed: r2(n(billed?.amt)), debit_notes: r2(n(debit?.a)), credit_notes: r2(n(credit?.a)),
    expected_net: r2(estGross - n(debit?.a) + n(credit?.a)) } };
}

jobWorkRouter.get('/job-work/orders/:id', VIEW, ah(async (req, res) => {
  res.json({ data: await loadOrder(req.user!.companyId, Number(req.params.id)) });
}));

jobWorkRouter.post('/job-work/orders', PLAN, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = orderSchema.parse(req.body ?? {});
  const so = await checkOrder(cid, b);
  const id = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'JW_ORDER');
    const r = await txExecute(tx,
      `INSERT INTO trx_jw_order (company_id, jw_no, so_id, io_no, buyer_po_no, style_id, buyer_id, vendor_id, order_date, expected_return_date, currency_id, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,
      [cid, no, so?.id ?? null, so ? (so.io_no || so.so_no) : (b.io_no ?? null), so?.buyer_po_no ?? null, b.style_id ?? null, so?.buyer_id ?? null, b.vendor_id,
       b.order_date, b.expected_return_date ?? null, b.currency_id ?? null, b.remarks ?? null, req.user!.id]);
    await writeOrderLines(tx, r.insertId, b.lines);
    return r.insertId as number;
  });
  await audit(req, 'trx_jw_order', id, 'INSERT', undefined, b);
  res.status(201).json({ data: await loadOrder(cid, id) });
}));

jobWorkRouter.put('/job-work/orders/:id', PLAN, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = orderSchema.parse(req.body ?? {});
  const so = await checkOrder(cid, b);
  const before = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, `SELECT * FROM trx_jw_order WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!o) throw NotFound('Job work order not found');
    if (o.status !== 'DRAFT') throw BadRequest(`Job work order ${o.jw_no} is ${o.status} — only a draft is edited`);
    await txExecute(tx,
      `UPDATE trx_jw_order SET so_id = ?, io_no = ?, buyer_po_no = ?, style_id = ?, buyer_id = ?, vendor_id = ?, order_date = ?, expected_return_date = ?, currency_id = ?, remarks = ?, updated_by = ? WHERE id = ?`,
      [so?.id ?? null, so ? (so.io_no || so.so_no) : (b.io_no ?? null), so?.buyer_po_no ?? null, b.style_id ?? null, so?.buyer_id ?? null, b.vendor_id, b.order_date,
       b.expected_return_date ?? null, b.currency_id ?? null, b.remarks ?? null, req.user!.id, id]);
    await writeOrderLines(tx, id, b.lines);
    return o;
  });
  await audit(req, 'trx_jw_order', id, 'UPDATE', before, b);
  res.json({ data: await loadOrder(cid, id) });
}));

jobWorkRouter.post('/job-work/orders/:id/approve', APPROVE, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, `SELECT * FROM trx_jw_order WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!o) throw NotFound('Job work order not found');
    if (o.status !== 'DRAFT') throw BadRequest(`Job work order ${o.jw_no} is already ${o.status}`);
    const lines = await txQuery<any>(tx, `SELECT * FROM trx_jw_order_line WHERE order_id = ?`, [id]);
    if (!lines.length) throw BadRequest('The order has no process');
    if (lines.some((l) => !(n(l.planned_input_qty) > 0))) throw BadRequest('Every process needs its planned input qty before approval');
    await txExecute(tx, `UPDATE trx_jw_order SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [req.user!.id, id]);
  });
  await audit(req, 'trx_jw_order', id, 'UPDATE', { status: 'DRAFT' }, { status: 'APPROVED' });
  res.json({ data: await loadOrder(cid, id) });
}));

/** Close (doc §30: never while contractor stock is unresolved — every DC received, returned or closed; fabric reconciled). */
jobWorkRouter.post('/job-work/orders/:id/close', APPROVE, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, `SELECT * FROM trx_jw_order WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!o) throw NotFound('Job work order not found');
    if (['CLOSED', 'CANCELLED', 'DRAFT'].includes(o.status)) throw BadRequest(`Job work order ${o.jw_no} is ${o.status}`);
    const lines = await orderLineBalances(tx, id);
    const open = lines.filter((l) => l.contractor_pcs > 0 || l.contractor_kg > 0.0005);
    if (open.length) {
      throw BadRequest(`Contractor still holds ${open.map((l) => `${l.stage_name}: ${l.contractor_pcs ? `${l.contractor_pcs} PCS` : ''}${l.contractor_kg > 0.0005 ? ` ${l.contractor_kg} KG fabric` : ''}`).join('; ')} — receive, return or close those DCs first`);
    }
    await txExecute(tx, `UPDATE trx_jw_order SET status = 'CLOSED', closed_by = ?, closed_at = NOW(), close_reason = ? WHERE id = ?`, [req.user!.id, b.reason, id]);
  });
  await audit(req, 'trx_jw_order', id, 'UPDATE', undefined, { status: 'CLOSED', reason: b.reason });
  res.json({ data: await loadOrder(cid, id) });
}));

jobWorkRouter.post('/job-work/orders/:id/cancel', APPROVE, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, `SELECT * FROM trx_jw_order WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!o) throw NotFound('Job work order not found');
    if (['CLOSED', 'CANCELLED'].includes(o.status)) throw BadRequest(`Job work order ${o.jw_no} is ${o.status}`);
    const dc = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_jobwork_challan WHERE jw_order_id = ? AND status <> 'CANCELLED'`, [id]);
    if (n(dc?.c)) throw BadRequest('DCs exist on this order — cancel them, or close the order');
    await txExecute(tx, `UPDATE trx_jw_order SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?`, [req.user!.id, b.reason, id]);
  });
  await audit(req, 'trx_jw_order', id, 'UPDATE', undefined, { status: 'CANCELLED', reason: b.reason });
  res.json({ data: await loadOrder(cid, id) });
}));

/* ================================================================ fabric job work (doc §2, §27: fabric → cutting + packing) */

const fabricOutSchema = z.object({
  line_id: s.idReq(),
  dc_date: dateStr,
  expected_return: s.date(),
  vehicle_no: s.nullableStr(30),
  remarks: s.nullableStr(500),
  rolls: z.array(z.object({ fabric_roll_id: s.idReq(), issue_kg: z.coerce.number().positive() })).min(1, 'Pick the fabric rolls'),
  /** expected garments back, colour × size (what the contractor will deliver) */
  outputs: z.array(z.object({ color_id: s.id(), size_id: s.id(), qty: z.coerce.number().int().positive() })).min(1, 'Give the expected garment qty (colour × size)'),
  override_reason: s.nullableStr(255),
});

/** POST /job-work/orders/:id/fabric-outward — fabric rolls out to the contractor on a fabric DC (roll stock reduced). */
jobWorkRouter.post('/job-work/orders/:id/fabric-outward', requireAny('PRODUCTION.CREATE', 'JOBWORK.PLAN'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = fabricOutSchema.parse(req.body ?? {});
  const ids = b.rolls.map((r) => r.fabric_roll_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('The same roll is listed twice');
  const out = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, `SELECT o.*, v.party_name AS vendor_name FROM trx_jw_order o LEFT JOIN mst_party v ON v.id = o.vendor_id WHERE o.id = ? AND o.company_id = ? FOR UPDATE`, [id, cid]);
    if (!o) throw NotFound('Job work order not found');
    if (!['APPROVED', 'PARTIAL_OUTWARD', 'IN_PROCESS', 'PARTIAL_INWARD', 'COMPLETED'].includes(o.status)) throw BadRequest(`Job work order ${o.jw_no} is ${o.status} — approve it first`);
    const line = await txQueryOne<any>(tx, `SELECT * FROM trx_jw_order_line WHERE id = ? AND order_id = ?`, [b.line_id, id]);
    if (!line) throw NotFound('Order line not found');
    if (line.input_kind !== 'FABRIC') throw BadRequest('That process does not take fabric — send bundles on a process DC');
    const totalKg = r3(b.rolls.reduce((a, r) => a + r.issue_kg, 0));
    const sent = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(fi.issue_kg),0) kg FROM trx_jw_fabric_issue fi JOIN trx_jobwork_challan jc ON jc.id = fi.challan_id WHERE jc.jw_order_line_id = ? AND jc.status <> 'CANCELLED'`, [line.id]);
    let override = false;
    if (n(line.planned_input_qty) > 0 && n(sent?.kg) + totalKg > n(line.planned_input_qty) + 0.0005) {
      const msg = `${totalKg} KG takes the order to ${r3(n(sent?.kg) + totalKg)} KG — over the planned ${n(line.planned_input_qty)} KG`;
      if (!(req.user!.isSuperAdmin || req.user!.permissions.has('PRODUCTION.APPROVE') || req.user!.permissions.has('JOBWORK.APPROVE'))) throw BadRequest(`${msg}. A manager must authorise it.`);
      if (!b.override_reason?.trim()) throw BadRequest(`${msg}. Give the override reason.`);
      override = true;
    }
    const rolls: any[] = [];
    for (const r of b.rolls) {
      const roll = await txQueryOne<any>(tx, `SELECT fr.*, ${RESERVED_KG_SQL('fr.id')} AS reserved_kg FROM trx_fabric_roll fr WHERE fr.id = ? AND fr.company_id = ? FOR UPDATE`, [r.fabric_roll_id, cid]);
      if (!roll) throw NotFound(`Roll #${r.fabric_roll_id} not found`);
      if (roll.qc_status !== 'ACCEPTED') throw BadRequest(`Roll ${roll.roll_no} is QC ${roll.qc_status}`);
      if (o.so_id && roll.so_id && Number(roll.so_id) !== Number(o.so_id)) throw BadRequest(`Roll ${roll.roll_no} belongs to another job`);
      const free = r3(n(roll.weight_kg) - n(roll.issued_kg) - n(roll.reserved_kg));
      if (r.issue_kg > free + 0.0005) throw BadRequest(`Roll ${roll.roll_no}: ${r.issue_kg} KG asked, ${free} KG free (doc §30: not more than the company stock)`);
      rolls.push({ roll, kg: r3(r.issue_kg), m: n(roll.meters) > 0 && n(roll.weight_kg) > 0 ? r3(n(roll.meters) * r.issue_kg / n(roll.weight_kg)) : null });
    }
    const challanNo = await nextDocNumber(tx, cid, 'JW_CHALLAN');
    const totalPcs = b.outputs.reduce((a, x) => a + x.qty, 0);
    const ins = await txExecute(tx,
      `INSERT INTO trx_jobwork_challan (company_id, challan_no, challan_date, vendor_id, stage_id, total_qty, rate, total_amount, expected_return, status, remarks,
          io_no, style_id, is_bundle_dc, vehicle_no, created_by, issued_by, issued_at, jw_order_id, jw_order_line_id, outward_override_reason, dc_kind)
       VALUES (?,?,?,?,?,?,?,?,?,'ISSUED',?,?,?,0,?,?,?,NOW(),?,?,?,'FABRIC')`,
      [cid, challanNo, b.dc_date, o.vendor_id, line.stage_id, totalPcs, line.rate ?? null, line.rate != null ? r2(n(line.rate) * totalPcs) : null,
       b.expected_return ?? o.expected_return_date ?? null, b.remarks ?? `Fabric ${totalKg} KG for ${o.jw_no}`, o.io_no, o.style_id, b.vehicle_no ?? null,
       req.user!.id, req.user!.id, o.id, line.id, override ? b.override_reason : null]);
    const dcId = ins.insertId;
    for (const x of b.outputs) {
      const sku = o.style_id && x.color_id && x.size_id ? await txQueryOne<any>(tx, `SELECT id FROM mst_style_sku WHERE style_id = ? AND color_id = ? AND size_id = ? LIMIT 1`, [o.style_id, x.color_id, x.size_id]) : null;
      await txExecute(tx,
        `INSERT INTO trx_jobwork_challan_line (challan_id, sku_id, io_no, description, qty, style_id, color_id, size_id, source_level, remarks)
         VALUES (?,?,?,?,?,?,?,?,'CUT',?)`,
        [dcId, sku?.id ?? null, o.io_no, `Garments from fabric (${line.output_desc ?? line.output_kind})`.slice(0, 255), x.qty, o.style_id, x.color_id ?? null, x.size_id ?? null, null]);
    }
    const uom = await txQueryOne<any>(tx, `SELECT id FROM cfg_uom WHERE code = 'KG' LIMIT 1`);
    for (const r of rolls) {
      await txExecute(tx, `INSERT INTO trx_jw_fabric_issue (company_id, challan_id, jw_order_line_id, fabric_roll_id, roll_no, lot_no, issue_kg, issue_m, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
        [cid, dcId, line.id, r.roll.id, r.roll.roll_no, r.roll.lot_no, r.kg, r.m, req.user!.id]);
      await txExecute(tx, `UPDATE trx_fabric_roll SET issued_kg = issued_kg + ? WHERE id = ?`, [r.kg, r.roll.id]);
      await refreshFabricRollStatus(tx, r.roll.id);
      await txExecute(tx,
        `INSERT INTO trx_stock_ledger (company_id, warehouse_id, material_type, fabric_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, created_by)
         VALUES (?,?,'FABRIC',?,'ISSUE','JW_FABRIC_DC',?,0,?,?,?)`, [cid, r.roll.warehouse_id, r.roll.fabric_id, dcId, r.kg, uom?.id ?? 5, req.user!.id]);
      await txExecute(tx,
        `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, from_place, to_place, qty_kg, so_id, remarks, user_id)
         VALUES (?,?,?,'JW_FABRIC_OUT','JW_DC',?,?,'STORE',?,?,?,?,?)`,
        [cid, r.roll.id, r.roll.roll_no, dcId, challanNo, o.vendor_name ?? 'Contractor', r.kg, o.so_id ?? null, `Job work ${o.jw_no}`, req.user!.id]);
    }
    await refreshJwOrder(tx, o.id);
    return { id: dcId, challan_no: challanNo, total_kg: totalKg, expected_pcs: totalPcs, rolls: rolls.length };
  });
  await audit(req, 'trx_jobwork_challan', out.id, 'INSERT', undefined, { ...out, jw_order_id: id, kind: 'FABRIC' });
  res.status(201).json({ data: out });
}));

const fabricInSchema = z.object({
  inward_date: dateStr,
  warehouse_id: s.id(),
  party_dc_no: s.nullableStr(60),
  remarks: s.nullableStr(500),
  /** garments delivered, per DC line (colour × size) */
  outputs: z.array(z.object({ line_id: s.idReq(), good_qty: z.coerce.number().int().min(0).default(0), reject_qty: z.coerce.number().int().min(0).default(0),
    reject_reason: s.nullableStr(255) })).default([]),
  /** fabric reconciliation per roll: used, returned (back to our stock), waste / loss */
  rolls: z.array(z.object({ fabric_issue_id: s.idReq(), consumed_kg: z.coerce.number().min(0).default(0), returned_kg: z.coerce.number().min(0).default(0),
    waste_kg: z.coerce.number().min(0).default(0) })).default([]),
  to_fg: z.coerce.boolean().default(true),
});

/**
 * POST /job-work/fabric-dcs/:id/inward — garments in + fabric back on a fabric DC (doc §14, §27): good / reject garments
 * go through the standard inward (billing, QC), packed / finished garments into FG stock, returned fabric back to its
 * roll (parent genealogy kept), waste recorded; the roll balance at the contractor = issued − used − returned − waste.
 */
jobWorkRouter.post('/job-work/fabric-dcs/:id/inward', requireAny('PRODUCTION.CREATE', 'JOBWORK.PLAN'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = fabricInSchema.parse(req.body ?? {});
  if (!b.outputs.some((x) => x.good_qty + x.reject_qty > 0) && !b.rolls.some((r) => r.consumed_kg + r.returned_kg + r.waste_kg > 0)) {
    throw BadRequest('Enter the garments received and / or the fabric used, returned or wasted');
  }
  const out = await transaction(async (tx) => {
    const dc = await txQueryOne<any>(tx,
      `SELECT jc.*, v.party_name AS vendor_name FROM trx_jobwork_challan jc LEFT JOIN mst_party v ON v.id = jc.vendor_id WHERE jc.id = ? AND jc.company_id = ? FOR UPDATE OF jc`, [id, cid]);
    if (!dc) throw NotFound('DC not found');
    if (dc.dc_kind !== 'FABRIC') throw BadRequest('Not a fabric DC — use the process inward');
    if (!['ISSUED', 'PARTIAL_RECEIVED', 'FULLY_RECEIVED'].includes(dc.status)) throw BadRequest(`DC ${dc.challan_no} is ${dc.status}`);
    const order = dc.jw_order_id ? await txQueryOne<any>(tx, `SELECT * FROM trx_jw_order WHERE id = ?`, [dc.jw_order_id]) : null;
    const line = dc.jw_order_line_id ? await txQueryOne<any>(tx, `SELECT * FROM trx_jw_order_line WHERE id = ?`, [dc.jw_order_line_id]) : null;
    let receipt: any = null;
    const outs = b.outputs.filter((x) => x.good_qty + x.reject_qty > 0);
    if (outs.length) {
      if (dc.status === 'FULLY_RECEIVED') throw BadRequest(`All garments of DC ${dc.challan_no} are already received`);
      receipt = await postReceipt(tx, req, dc, {
        receipt_date: b.inward_date, party_dc_no: b.party_dc_no ?? null, remarks: b.remarks ?? null, to_warehouse_id: b.warehouse_id ?? null,
        lines: outs.map((x) => ({ line_id: x.line_id, received_qty: x.good_qty, rejected_qty: x.reject_qty, shortage_qty: 0, loss_qty: 0, return_qty: 0, rework_qty: 0,
          excess_qty: 0, reject_reason: x.reject_reason ?? (x.reject_qty ? 'Rejected garments' : null) })),
      } as any, 'RECEIPT');
    }
    // fabric reconciliation per roll
    const uom = await txQueryOne<any>(tx, `SELECT id FROM cfg_uom WHERE code = 'KG' LIMIT 1`);
    let used = 0; let back = 0; let waste = 0;
    for (const r of b.rolls.filter((x) => x.consumed_kg + x.returned_kg + x.waste_kg > 0)) {
      const fi = await txQueryOne<any>(tx, `SELECT * FROM trx_jw_fabric_issue WHERE id = ? AND challan_id = ? FOR UPDATE`, [r.fabric_issue_id, id]);
      if (!fi) throw BadRequest(`Roll line #${r.fabric_issue_id} is not on DC ${dc.challan_no}`);
      const bal = r3(n(fi.issue_kg) - n(fi.consumed_kg) - n(fi.returned_kg) - n(fi.waste_kg));
      const take = r3(r.consumed_kg + r.returned_kg + r.waste_kg);
      if (take > bal + 0.0005) throw BadRequest(`Roll ${fi.roll_no}: ${take} KG accounted, only ${bal} KG is with the contractor`);
      await txExecute(tx, `UPDATE trx_jw_fabric_issue SET consumed_kg = consumed_kg + ?, returned_kg = returned_kg + ?, waste_kg = waste_kg + ? WHERE id = ?`,
        [r.consumed_kg, r.returned_kg, r.waste_kg, fi.id]);
      if (r.returned_kg > 0) {
        const roll = await txQueryOne<any>(tx, `SELECT * FROM trx_fabric_roll WHERE id = ? FOR UPDATE`, [fi.fabric_roll_id]);
        await txExecute(tx, `UPDATE trx_fabric_roll SET issued_kg = GREATEST(issued_kg - ?, 0) WHERE id = ?`, [r.returned_kg, fi.fabric_roll_id]);
        await refreshFabricRollStatus(tx, fi.fabric_roll_id);
        await txExecute(tx,
          `INSERT INTO trx_stock_ledger (company_id, warehouse_id, material_type, fabric_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, created_by)
           VALUES (?,?,'FABRIC',?,'RETURN','JW_FABRIC_RETURN',?,?,0,?,?)`, [cid, roll.warehouse_id, roll.fabric_id, id, r.returned_kg, uom?.id ?? 5, req.user!.id]);
      }
      await txExecute(tx,
        `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, from_place, to_place, qty_kg, so_id, remarks, user_id)
         VALUES (?,?,?,'JW_FABRIC_BACK','JW_DC',?,?,?,'STORE',?,?,?,?)`,
        [cid, fi.fabric_roll_id, fi.roll_no, id, dc.challan_no, dc.vendor_name ?? 'Contractor', r.returned_kg, order?.so_id ?? null,
         `Used ${r.consumed_kg} · returned ${r.returned_kg} · waste ${r.waste_kg} KG`, req.user!.id]);
      used += r.consumed_kg; back += r.returned_kg; waste += r.waste_kg;
    }
    // packed / finished garments go into FG stock (doc §27: packing inward creates packed FG after QC)
    let fgId: number | null = null;
    const goodTotal = outs.reduce((a, x) => a + x.good_qty, 0);
    if (b.to_fg && goodTotal > 0 && line && ['PACKED', 'GARMENT'].includes(line.output_kind) && dc.style_id && dc.io_no) {
      const lines = await txQuery<any>(tx, `SELECT * FROM trx_jobwork_challan_line WHERE challan_id = ?`, [id]);
      const fgNo = await nextDocNumber(tx, cid, 'FG_RECEIPT');
      const fr = await txExecute(tx,
        `INSERT INTO trx_fg_receipt (company_id, receipt_no, receipt_date, io_no, so_id, style_id, warehouse_id, source_stage, source_ref, total_qty, total_reject, status, remarks, created_by)
         VALUES (?,?,?,?,?,?,?,'JOBWORK',?,?,?,'RECEIVED',?,?)`,
        [cid, fgNo, b.inward_date, dc.io_no, order?.so_id ?? null, dc.style_id, b.warehouse_id ?? null, dc.challan_no, goodTotal,
         outs.reduce((a, x) => a + x.reject_qty, 0), `Job work ${order?.jw_no ?? ''} DC ${dc.challan_no}`, req.user!.id]);
      fgId = fr.insertId;
      for (const x of outs) {
        const l = lines.find((y) => Number(y.id) === x.line_id);
        if (!l?.color_id || !l?.size_id) continue;
        await txExecute(tx, `INSERT INTO trx_fg_receipt_line (fg_receipt_id, color_id, size_id, sku_id, good_qty, reject_qty) VALUES (?,?,?,?,?,?)`,
          [fgId, l.color_id, l.size_id, l.sku_id ?? null, x.good_qty, x.reject_qty]);
      }
    }
    const no = await nextDocNumber(tx, cid, 'JW_FAB_INWARD');
    const fin = await txExecute(tx,
      `INSERT INTO trx_jw_fabric_inward (company_id, inward_no, inward_date, challan_id, receipt_id, fg_receipt_id, good_qty, reject_qty, consumed_kg, returned_kg, waste_kg, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.inward_date, id, receipt?.receipt_id ?? null, fgId, goodTotal, outs.reduce((a, x) => a + x.reject_qty, 0), r3(used), r3(back), r3(waste), b.remarks ?? null, req.user!.id]);
    await refreshJwOrder(tx, dc.jw_order_id);
    return { id: fin.insertId, inward_no: no, receipt_no: receipt?.receipt_no ?? null, fg_receipt_id: fgId, good: goodTotal, used_kg: r3(used), returned_kg: r3(back), waste_kg: r3(waste) };
  });
  await audit(req, 'trx_jw_fabric_inward', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out });
}));

/** GET /job-work/orders/:id/fabric-options — free QC-accepted rolls of the job (or not yet on a job) + the style's colour × size. */
jobWorkRouter.get('/job-work/orders/:id/fabric-options', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const o = await queryOne<any>(`SELECT * FROM trx_jw_order WHERE id = ? AND company_id = ?`, [Number(req.params.id), cid]);
  if (!o) throw NotFound('Job work order not found');
  const rolls = await query<any>(
    `SELECT fr.id, fr.roll_no, fr.lot_no, fr.so_id, f.fabric_name, fr.color_name, fr.weight_kg, fr.issued_kg,
            ROUND(fr.weight_kg - fr.issued_kg - ${RESERVED_KG_SQL('fr.id')}, 3) AS free_kg
       FROM trx_fabric_roll fr LEFT JOIN mst_fabric f ON f.id = fr.fabric_id
      WHERE fr.company_id = ? AND fr.qc_status = 'ACCEPTED' AND (fr.so_id IS NULL OR fr.so_id <=> ?)
      HAVING free_kg > 0.0005 ORDER BY fr.so_id IS NULL, fr.id DESC LIMIT 500`, [cid, o.so_id]);
  const skus = o.style_id ? await query<any>(
    `SELECT DISTINCT k.color_id, k.size_id, col.color_name, sz.size_code, COALESCE(ss.sequence_no, sz.sort_order, 0) AS seq
       FROM mst_style_sku k JOIN mst_color col ON col.id = k.color_id JOIN mst_size sz ON sz.id = k.size_id
       LEFT JOIN mst_style_size ss ON ss.style_id = k.style_id AND ss.size_id = k.size_id
      WHERE k.style_id = ? AND k.is_active = 1 ORDER BY col.color_name, seq`, [o.style_id]) : [];
  res.json({ data: { rolls, skus } });
}));

jobWorkRouter.get('/job-work/fabric-dcs/:id', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dc = await queryOne<any>(`SELECT jc.*, v.party_name AS vendor_name, ps.stage_name FROM trx_jobwork_challan jc LEFT JOIN mst_party v ON v.id = jc.vendor_id
     LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id WHERE jc.id = ? AND jc.company_id = ?`, [Number(req.params.id), cid]);
  if (!dc) throw NotFound('DC not found');
  const [lines, rolls, inwards] = await Promise.all([
    query<any>(`SELECT jl.*, ${DC_PENDING('jl.')} AS pending_qty, col.color_name, sz.size_code FROM trx_jobwork_challan_line jl LEFT JOIN mst_color col ON col.id = jl.color_id
                LEFT JOIN mst_size sz ON sz.id = jl.size_id WHERE jl.challan_id = ? ORDER BY jl.id`, [dc.id]),
    query<any>(`SELECT fi.*, ROUND(fi.issue_kg - fi.consumed_kg - fi.returned_kg - fi.waste_kg, 4) AS balance_kg FROM trx_jw_fabric_issue fi WHERE fi.challan_id = ? ORDER BY fi.id`, [dc.id]),
    query<any>(`SELECT * FROM trx_jw_fabric_inward WHERE challan_id = ? ORDER BY id`, [dc.id]),
  ]);
  res.json({ data: { ...dc, lines, rolls, inwards } });
}));

/* ================================================================ contractor stock, dashboard, genealogy, ledger (doc §11, §29) */

/** GET /job-work/contractor-stock?vendor_id= — material held by contractors, separate from company stock (doc §11). */
jobWorkRouter.get('/job-work/contractor-stock', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const vid = req.query.vendor_id ? Number(req.query.vendor_id) : null;
  const pcs = await query<any>(
    `SELECT jc.vendor_id, v.party_name AS vendor_name, jc.id AS challan_id, jc.challan_no, jc.challan_date, jc.expected_return, jc.dc_kind, ps.stage_name,
            jc.jw_order_id, o.jw_no, jl.io_no, st.style_code, col.color_name, sz.size_code, cb.bundle_no,
            jl.qty, jl.received_qty, jl.rejected_qty, jl.shortage_qty, jl.loss_qty, jl.returned_qty, jl.rework_open_qty, ${DC_PENDING('jl.')} AS pending_qty,
            DATEDIFF(CURDATE(), jc.challan_date) AS days_out
       FROM trx_jobwork_challan jc JOIN trx_jobwork_challan_line jl ON jl.challan_id = jc.id
       LEFT JOIN mst_party v ON v.id = jc.vendor_id LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
       LEFT JOIN trx_jw_order o ON o.id = jc.jw_order_id LEFT JOIN mst_style st ON st.id = jl.style_id
       LEFT JOIN mst_color col ON col.id = jl.color_id LEFT JOIN mst_size sz ON sz.id = jl.size_id LEFT JOIN trx_cutting_bundle cb ON cb.id = jl.bundle_id
      WHERE jc.company_id = ? AND jc.status IN ('ISSUED','PARTIAL_RECEIVED') AND ${DC_PENDING('jl.')} > 0 ${vid ? 'AND jc.vendor_id = ?' : ''}
      ORDER BY v.party_name, jc.challan_date, jc.id LIMIT 3000`, vid ? [cid, vid] : [cid]);
  const fabric = await query<any>(
    `SELECT jc.vendor_id, v.party_name AS vendor_name, jc.id AS challan_id, jc.challan_no, jc.challan_date, fi.roll_no, fi.lot_no, fi.issue_kg, fi.consumed_kg, fi.returned_kg, fi.waste_kg,
            ROUND(fi.issue_kg - fi.consumed_kg - fi.returned_kg - fi.waste_kg, 4) AS balance_kg, o.jw_no
       FROM trx_jw_fabric_issue fi JOIN trx_jobwork_challan jc ON jc.id = fi.challan_id LEFT JOIN mst_party v ON v.id = jc.vendor_id LEFT JOIN trx_jw_order o ON o.id = jc.jw_order_id
      WHERE jc.company_id = ? AND jc.status <> 'CANCELLED' AND fi.issue_kg - fi.consumed_kg - fi.returned_kg - fi.waste_kg > 0.0005 ${vid ? 'AND jc.vendor_id = ?' : ''}
      ORDER BY v.party_name, jc.id`, vid ? [cid, vid] : [cid]);
  const byVendor = new Map<number, any>();
  for (const r of pcs) {
    const k = Number(r.vendor_id);
    if (!byVendor.has(k)) byVendor.set(k, { vendor_id: k, vendor_name: r.vendor_name, pcs: 0, rework_pcs: 0, kg: 0, dcs: new Set(), overdue_pcs: 0 });
    const x = byVendor.get(k); x.pcs += n(r.pending_qty); x.rework_pcs += n(r.rework_open_qty); x.dcs.add(r.challan_no);
    if (r.expected_return && String(r.expected_return).slice(0, 10) < today()) x.overdue_pcs += n(r.pending_qty);
  }
  for (const f of fabric) {
    const k = Number(f.vendor_id);
    if (!byVendor.has(k)) byVendor.set(k, { vendor_id: k, vendor_name: f.vendor_name, pcs: 0, rework_pcs: 0, kg: 0, dcs: new Set(), overdue_pcs: 0 });
    const x = byVendor.get(k); x.kg = r3(x.kg + n(f.balance_kg)); x.dcs.add(f.challan_no);
  }
  res.json({ data: { contractors: [...byVendor.values()].map((x) => ({ ...x, dcs: x.dcs.size })), lines: pcs, fabric } });
}));

/** GET /job-work/dashboard — pending / overdue, process-wise pending inward, QC pending, orders by status (doc §29). */
jobWorkRouter.get('/job-work/dashboard', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const [overdue, byProcess, orders, qc, unbilled, losses] = await Promise.all([
    query<any>(`SELECT jc.id, jc.challan_no, jc.challan_date, jc.expected_return, v.party_name AS vendor_name, ps.stage_name, DATEDIFF(CURDATE(), jc.expected_return) AS days_late,
                       COALESCE(SUM(${DC_PENDING('jl.')}),0) AS pending_pcs
                  FROM trx_jobwork_challan jc JOIN trx_jobwork_challan_line jl ON jl.challan_id = jc.id LEFT JOIN mst_party v ON v.id = jc.vendor_id LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
                 WHERE jc.company_id = ? AND jc.status IN ('ISSUED','PARTIAL_RECEIVED') AND jc.expected_return IS NOT NULL AND jc.expected_return < CURDATE()
                 GROUP BY jc.id HAVING pending_pcs > 0 ORDER BY jc.expected_return LIMIT 200`, [cid]),
    query<any>(`SELECT ps.stage_name, COUNT(DISTINCT jc.id) AS dcs, COALESCE(SUM(${DC_PENDING('jl.')}),0) AS pending_pcs, COALESCE(SUM(jl.rework_open_qty),0) AS rework_pcs
                  FROM trx_jobwork_challan jc JOIN trx_jobwork_challan_line jl ON jl.challan_id = jc.id LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
                 WHERE jc.company_id = ? AND jc.status IN ('ISSUED','PARTIAL_RECEIVED') GROUP BY ps.stage_name ORDER BY pending_pcs DESC`, [cid]),
    query<any>(`SELECT status, COUNT(*) AS n FROM trx_jw_order WHERE company_id = ? GROUP BY status`, [cid]),
    query<any>(`SELECT r.id, r.receipt_no, r.receipt_date, r.received_qty, v.party_name AS vendor_name, jc.challan_no FROM trx_jobwork_receipt r
                  JOIN trx_jobwork_challan jc ON jc.id = r.challan_id LEFT JOIN mst_party v ON v.id = r.vendor_id
                 WHERE r.company_id = ? AND r.qc_status = 'PENDING' ORDER BY r.id DESC LIMIT 100`, [cid]),
    queryOne<any>(`SELECT COUNT(*) AS n, COALESCE(SUM(r.received_qty),0) AS pcs FROM trx_jobwork_receipt r WHERE r.company_id = ? AND r.contractor_bill_id IS NULL
                     AND r.qc_status = 'ACCEPTED' AND r.billable = 1 AND r.received_qty > 0`, [cid]),
    queryOne<any>(`SELECT COALESCE(SUM(jl.qty),0) issued, COALESCE(SUM(jl.received_qty),0) good, COALESCE(SUM(jl.rejected_qty),0) rej, COALESCE(SUM(jl.shortage_qty),0) short,
                          COALESCE(SUM(jl.loss_qty),0) loss, COALESCE(SUM(jl.returned_qty),0) ret, COALESCE(SUM(jl.rework_qty),0) rework
                     FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id
                    WHERE jc.company_id = ? AND jc.status <> 'CANCELLED' AND jc.challan_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)`, [cid]),
  ]);
  res.json({ data: { overdue, by_process: byProcess, orders, qc_pending: qc, unbilled: { inwards: n(unbilled?.n), pcs: n(unbilled?.pcs) },
    last_90_days: { issued: n(losses?.issued), good: n(losses?.good), reject: n(losses?.rej), shortage: n(losses?.short), loss: n(losses?.loss), returned: n(losses?.ret), rework: n(losses?.rework) } } });
}));

/** GET /job-work/orders/:id/genealogy — order → processes → DCs → bundles / rolls → inwards → bills (doc §26). */
jobWorkRouter.get('/job-work/orders/:id/genealogy', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const o = await loadOrder(cid, Number(req.params.id));
  const dcIds = o.dcs.map((d: any) => Number(d.id));
  const [bundles, rolls, bills] = await Promise.all([
    dcIds.length ? query<any>(`SELECT jl.challan_id, cb.bundle_no, jl.qty, jl.received_qty, jl.rejected_qty, jl.loss_qty, jl.returned_qty, jl.rework_qty, sz.size_code, col.color_name
                                 FROM trx_jobwork_challan_line jl LEFT JOIN trx_cutting_bundle cb ON cb.id = jl.bundle_id LEFT JOIN mst_size sz ON sz.id = jl.size_id
                                 LEFT JOIN mst_color col ON col.id = jl.color_id WHERE jl.challan_id IN (${dcIds.map(() => '?').join(',')}) ORDER BY jl.challan_id, jl.id`, dcIds) : [],
    dcIds.length ? query<any>(`SELECT fi.*, fr.lot_no AS roll_lot, g.grn_no FROM trx_jw_fabric_issue fi JOIN trx_fabric_roll fr ON fr.id = fi.fabric_roll_id LEFT JOIN trx_grn g ON g.id = fr.grn_id
                                WHERE fi.challan_id IN (${dcIds.map(() => '?').join(',')})`, dcIds) : [],
    query<any>(`SELECT DISTINCT cb.id, cb.bill_no, cb.bill_date, cb.status, cb.net_amount FROM trx_contractor_bill cb JOIN trx_jobwork_receipt r ON r.contractor_bill_id = cb.id
                 JOIN trx_jobwork_challan jc ON jc.id = r.challan_id WHERE jc.jw_order_id = ?`, [o.id]),
  ]);
  res.json({ data: { order: { id: o.id, jw_no: o.jw_no, io_no: o.io_no, style_code: o.style_code, vendor_name: o.vendor_name, status: o.status },
    processes: o.lines.map((l: any) => ({ ...l, dcs: o.dcs.filter((d: any) => Number(d.jw_order_line_id) === Number(l.id)).map((d: any) => ({
      ...d, bundles: bundles.filter((b) => Number(b.challan_id) === Number(d.id)), rolls: rolls.filter((r) => Number(r.challan_id) === Number(d.id)),
      receipts: o.receipts.filter((r: any) => Number(r.challan_id) === Number(d.id)) })) })),
    bills } });
}));

/** GET /job-work/orders/:id/ledger — every movement of the order in date order (doc §20). */
jobWorkRouter.get('/job-work/orders/:id/ledger', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const o = await loadOrder(cid, Number(req.params.id));
  const rows: any[] = [];
  for (const d of o.dcs) rows.push({ date: d.challan_date, type: d.dc_kind === 'FABRIC' ? 'FABRIC OUTWARD' : 'OUTWARD', ref: d.challan_no, process: d.stage_name,
    qty_out: d.dc_kind === 'FABRIC' ? null : n(d.total_qty), kg_out: d.dc_kind === 'FABRIC' ? n(d.fabric_kg) : null, status: d.status });
  for (const r of o.receipts) rows.push({ date: r.receipt_date, type: 'INWARD', ref: r.receipt_no, good: n(r.received_qty), reject: n(r.rejected_qty),
    loss: n(r.shortage_qty) + n(r.loss_qty), returned: n(r.return_qty), rework: n(r.rework_qty), qc: r.qc_status, bill: r.bill_no });
  const fins = o.dcs.length ? await query<any>(`SELECT * FROM trx_jw_fabric_inward WHERE challan_id IN (${o.dcs.map(() => '?').join(',')})`, o.dcs.map((d: any) => d.id)) : [];
  for (const f of fins) rows.push({ date: f.inward_date, type: 'FABRIC RECONCILE', ref: f.inward_no, used_kg: n(f.consumed_kg), returned_kg: n(f.returned_kg), waste_kg: n(f.waste_kg) });
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  res.json({ data: rows });
}));

/* ================================================================ process rate master (doc §17) */

const rateSchema = z.object({
  vendor_id: s.idReq(), stage_id: s.idReq(), style_id: s.id(), buyer_id: s.id(), uom: z.enum(['PCS', 'KG', 'M', 'BUNDLE', 'CARTON']).default('PCS'),
  rate: z.coerce.number().min(0), effective_from: s.date(), effective_to: s.date(), is_active: z.coerce.boolean().default(true), remarks: s.nullableStr(255),
});
jobWorkRouter.get('/job-work/rates', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query<any>(
    `SELECT r.*, v.party_name AS vendor_name, ps.stage_name, st.style_code, b.party_name AS buyer_name FROM mst_jw_rate r
       LEFT JOIN mst_party v ON v.id = r.vendor_id LEFT JOIN cfg_process_stage ps ON ps.id = r.stage_id LEFT JOIN mst_style st ON st.id = r.style_id LEFT JOIN mst_party b ON b.id = r.buyer_id
      WHERE r.company_id = ? ${req.query.vendor_id ? 'AND r.vendor_id = ?' : ''} ORDER BY v.party_name, ps.stage_name, r.style_id IS NULL, r.buyer_id IS NULL, r.effective_from DESC`,
    req.query.vendor_id ? [cid, Number(req.query.vendor_id)] : [cid]);
  res.json({ data: rows });
}));
jobWorkRouter.get('/job-work/rates/resolve', VIEW, ah(async (req, res) => {
  const q = z.object({ vendor_id: s.idReq(), stage_id: s.idReq(), style_id: s.id(), buyer_id: s.id(), uom: z.string().default('PCS'), on: s.date() }).parse(req.query);
  res.json({ data: await resolveJwRate(req.user!.companyId, q as any) });
}));
jobWorkRouter.post('/job-work/rates', requireAny('PRODUCTION.APPROVE', 'JOBWORK.APPROVE', 'JOBWORK.ACCOUNTS'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = rateSchema.parse(req.body ?? {});
  if (b.effective_from && b.effective_to && b.effective_to < b.effective_from) throw BadRequest('Effective to is before effective from');
  const r: any = await query(`INSERT INTO mst_jw_rate (company_id, vendor_id, stage_id, style_id, buyer_id, uom, rate, effective_from, effective_to, is_active, remarks, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [cid, b.vendor_id, b.stage_id, b.style_id ?? null, b.buyer_id ?? null, b.uom, b.rate, b.effective_from ?? null, b.effective_to ?? null, b.is_active ? 1 : 0, b.remarks ?? null, req.user!.id]);
  await audit(req, 'mst_jw_rate', Number(r?.insertId ?? 0), 'INSERT', undefined, b);
  res.status(201).json({ data: { id: Number(r?.insertId ?? 0) } });
}));
jobWorkRouter.put('/job-work/rates/:id', requireAny('PRODUCTION.APPROVE', 'JOBWORK.APPROVE', 'JOBWORK.ACCOUNTS'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = rateSchema.parse(req.body ?? {});
  const before = await queryOne<any>(`SELECT * FROM mst_jw_rate WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!before) throw NotFound('Rate not found');
  await query(`UPDATE mst_jw_rate SET vendor_id = ?, stage_id = ?, style_id = ?, buyer_id = ?, uom = ?, rate = ?, effective_from = ?, effective_to = ?, is_active = ?, remarks = ? WHERE id = ?`,
    [b.vendor_id, b.stage_id, b.style_id ?? null, b.buyer_id ?? null, b.uom, b.rate, b.effective_from ?? null, b.effective_to ?? null, b.is_active ? 1 : 0, b.remarks ?? null, id]);
  await audit(req, 'mst_jw_rate', id, 'UPDATE', before, b);
  res.json({ data: { id } });
}));

/* ================================================================ credit notes, payments, statement (doc §16, §18) */

jobWorkRouter.get('/contractor-credit-notes', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  res.json({ data: await query(`SELECT c.*, v.party_name AS vendor_name, o.jw_no FROM trx_contractor_credit_note c LEFT JOIN mst_party v ON v.id = c.vendor_id
      LEFT JOIN trx_jw_order o ON o.id = c.jw_order_id WHERE c.company_id = ? ${req.query.vendor_id ? 'AND c.vendor_id = ?' : ''} ORDER BY c.id DESC LIMIT 500`,
    req.query.vendor_id ? [cid, Number(req.query.vendor_id)] : [cid]) });
}));
jobWorkRouter.post('/contractor-credit-notes', ACCOUNTS, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({ cn_date: dateStr, vendor_id: s.idReq(), jw_order_id: s.id(), io_no: s.nullableStr(60), reason: s.strReq(255),
    amount: z.coerce.number().positive(), tax: z.coerce.number().min(0).default(0) }).parse(req.body ?? {});
  const id = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'CONTR_CN');
    const r = await txExecute(tx, `INSERT INTO trx_contractor_credit_note (company_id, cn_no, cn_date, vendor_id, jw_order_id, io_no, reason, amount, tax, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.cn_date, b.vendor_id, b.jw_order_id ?? null, b.io_no ?? null, b.reason, b.amount, b.tax, req.user!.id]);
    return r.insertId as number;
  });
  await audit(req, 'trx_contractor_credit_note', id, 'INSERT', undefined, b);
  res.status(201).json({ data: await queryOne(`SELECT * FROM trx_contractor_credit_note WHERE id = ?`, [id]) });
}));
jobWorkRouter.post('/contractor-credit-notes/:id/cancel', ACCOUNTS, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});
  const r: any = await query(`UPDATE trx_contractor_credit_note SET status = 'CANCELLED', cancelled_by = ?, cancel_reason = ? WHERE id = ? AND company_id = ? AND status = 'OPEN'`,
    [req.user!.id, b.reason, Number(req.params.id), cid]);
  if (!r?.affectedRows) throw BadRequest('Credit note not found or not open');
  await audit(req, 'trx_contractor_credit_note', Number(req.params.id), 'UPDATE', undefined, { status: 'CANCELLED', reason: b.reason });
  res.json({ data: { id: Number(req.params.id), status: 'CANCELLED' } });
}));

jobWorkRouter.get('/contractor-payments', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  res.json({ data: await query(`SELECT p.*, v.party_name AS vendor_name, cb.bill_no FROM trx_contractor_payment p LEFT JOIN mst_party v ON v.id = p.vendor_id
      LEFT JOIN trx_contractor_bill cb ON cb.id = p.bill_id WHERE p.company_id = ? ${req.query.vendor_id ? 'AND p.vendor_id = ?' : ''} ORDER BY p.id DESC LIMIT 500`,
    req.query.vendor_id ? [cid, Number(req.query.vendor_id)] : [cid]) });
}));
jobWorkRouter.post('/contractor-payments', ACCOUNTS, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({ payment_date: dateStr, vendor_id: s.idReq(), bill_id: s.id(), amount: z.coerce.number().positive(), mode: s.nullableStr(20),
    reference_no: s.nullableStr(60), remarks: s.nullableStr(255) }).parse(req.body ?? {});
  if (b.bill_id) {
    const bill = await queryOne<any>(`SELECT id, vendor_id, status FROM trx_contractor_bill WHERE id = ? AND company_id = ?`, [b.bill_id, cid]);
    if (!bill || Number(bill.vendor_id) !== b.vendor_id) throw BadRequest('That bill is not this contractor\'s');
    if (bill.status !== 'APPROVED') throw BadRequest('Only an approved bill is paid');
  }
  const id = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'CONTR_PAY');
    const r = await txExecute(tx, `INSERT INTO trx_contractor_payment (company_id, payment_no, payment_date, vendor_id, bill_id, amount, mode, reference_no, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.payment_date, b.vendor_id, b.bill_id ?? null, b.amount, b.mode ?? null, b.reference_no ?? null, b.remarks ?? null, req.user!.id]);
    return r.insertId as number;
  });
  await audit(req, 'trx_contractor_payment', id, 'INSERT', undefined, b);
  res.status(201).json({ data: await queryOne(`SELECT * FROM trx_contractor_payment WHERE id = ?`, [id]) });
}));
jobWorkRouter.post('/contractor-payments/:id/cancel', ACCOUNTS, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});
  const r: any = await query(`UPDATE trx_contractor_payment SET status = 'CANCELLED', cancelled_by = ?, cancel_reason = ? WHERE id = ? AND company_id = ? AND status = 'POSTED'`,
    [req.user!.id, b.reason, Number(req.params.id), cid]);
  if (!r?.affectedRows) throw BadRequest('Payment not found or already cancelled');
  await audit(req, 'trx_contractor_payment', Number(req.params.id), 'UPDATE', undefined, { status: 'CANCELLED', reason: b.reason });
  res.json({ data: { id: Number(req.params.id), status: 'CANCELLED' } });
}));

/**
 * GET /job-work/contractor-statement?vendor_id=&from=&to= — Opening + Bills + Credits − Advances − Debits − Payments = Closing
 * (doc §18). A bill counts before its advance / debit note adjustment (those are counted once, as their own entries).
 */
jobWorkRouter.get('/job-work/contractor-statement', requireAny('PRODUCTION.VIEW', 'JOBWORK.ACCOUNTS'), ah(async (req: Request, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ vendor_id: s.idReq(), from: dateStr.default('2000-01-01'), to: dateStr.default(today()) }).parse(req.query);
  const p = [cid, q.vendor_id];
  const [bills, advances, debits, credits, payments] = await Promise.all([
    query<any>(`SELECT bill_date d, bill_no ref, net_amount + COALESCE(advance_adjusted,0) + COALESCE(debit_note_amount,0) amt FROM trx_contractor_bill WHERE company_id = ? AND vendor_id = ? AND status = 'APPROVED'`, p),
    query<any>(`SELECT advance_date d, advance_no ref, amount amt FROM trx_contractor_advance WHERE company_id = ? AND vendor_id = ? AND status = 'ACTIVE' AND source = 'PAYMENT'`, p),
    query<any>(`SELECT dn_date d, dn_no ref, amount amt, reason FROM trx_contractor_debit_note WHERE company_id = ? AND vendor_id = ? AND status <> 'CANCELLED'`, p),
    query<any>(`SELECT cn_date d, cn_no ref, amount + tax amt, reason FROM trx_contractor_credit_note WHERE company_id = ? AND vendor_id = ? AND status <> 'CANCELLED'`, p),
    query<any>(`SELECT payment_date d, payment_no ref, amount amt, mode FROM trx_contractor_payment WHERE company_id = ? AND vendor_id = ? AND status = 'POSTED'`, p),
  ]);
  const ds = (x: any) => String(x.d instanceof Date ? x.d.toISOString() : x.d).slice(0, 10);
  const entries = [
    ...bills.map((x) => ({ date: ds(x), type: 'BILL', ref: x.ref, credit: n(x.amt), debit: 0 })),
    ...credits.map((x) => ({ date: ds(x), type: 'CREDIT NOTE', ref: x.ref, credit: n(x.amt), debit: 0, note: x.reason })),
    ...advances.map((x) => ({ date: ds(x), type: 'ADVANCE', ref: x.ref, credit: 0, debit: n(x.amt) })),
    ...debits.map((x) => ({ date: ds(x), type: 'DEBIT NOTE', ref: x.ref, credit: 0, debit: n(x.amt), note: x.reason })),
    ...payments.map((x) => ({ date: ds(x), type: 'PAYMENT', ref: x.ref, credit: 0, debit: n(x.amt), note: x.mode })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  const opening = r2(entries.filter((e) => e.date < q.from).reduce((a, e) => a + e.credit - e.debit, 0));
  let bal = opening;
  const lines = entries.filter((e) => e.date >= q.from && e.date <= q.to).map((e) => { bal = r2(bal + e.credit - e.debit); return { ...e, balance: bal }; });
  const sum = (t: string, k: 'credit' | 'debit') => r2(lines.filter((l) => l.type === t).reduce((a, l) => a + l[k], 0));
  const v = await queryOne<any>(`SELECT party_name FROM mst_party WHERE id = ?`, [q.vendor_id]);
  res.json({ data: { vendor_id: q.vendor_id, vendor_name: v?.party_name ?? null, from: q.from, to: q.to, opening,
    bills: sum('BILL', 'credit'), credits: sum('CREDIT NOTE', 'credit'), advances: sum('ADVANCE', 'debit'), debits: sum('DEBIT NOTE', 'debit'), payments: sum('PAYMENT', 'debit'),
    closing: bal, lines, note: 'Closing = opening + bills + credit notes − advances − debit notes − payments (what we owe the contractor)' } });
}));
