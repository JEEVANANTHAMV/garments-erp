import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { stockOf, moveStock, type Mat, type MoveCtx } from './stockPost.js';
import {
  n, r4, cidOf, uidOf, todayStr, idOpt, strOpt, dateStr, reasonSchema, idParam, listQuery, listWhere, mustGet, needStatus,
  ITEM_NAME, ITEM_JOINS, styleOfSo,
} from './common.js';

/**
 * Stock delivery & general delivery (client tracker 14-Oct-2026, rows 105–109).
 *   STOCK delivery    — items picked from stock; approval takes them out of stock.
 *   GENERAL delivery  — the existing "General Delivery" (outward gate pass, header only) gains item lines, approval and
 *                       return entry: lines may be free items (machinery / tools, no stock) or general store stock.
 *   RETURNABLE        — outstanding until fully returned (return entry brings stock back) or short-closed with a reason.
 *   NON_RETURNABLE    — billable / non-billable (FOC).
 * Approval with a vehicle no makes the outward gate pass (trx_gate_outward, ref_type STOCK_DELIVERY); returns update it.
 */
export const deliveryRouter = Router();
const VIEW = requireAny('INVENTORY.VIEW', 'GATE_OUTWARD.VIEW', 'ISSUE.VIEW');
const CREATE = requireAny('INVENTORY.CREATE', 'ISSUE.CREATE', 'INVENTORY.ADJUST');
const APPROVE = requirePermission('INVENTORY.ADJUST');
const KIND_DOC = { STOCK: 'STOCK_DELIVERY', GENERAL: 'GENERAL_DELIVERY' } as const;

const deliveryLine = z.object({
  source_ref: z.string().trim().max(255).nullish().transform((v) => v || null),
  item_description: strOpt(255), color_name: strOpt(80), sizes: strOpt(80),
  uom_id: idOpt, qty: z.coerce.number().positive('Qty must be more than zero'), rate: z.coerce.number().min(0).nullish(), remarks: strOpt(255),
});
const deliverySchema = z.object({
  doc_date: dateStr.default(todayStr), delivery_kind: z.enum(['STOCK', 'GENERAL']).default('STOCK'),
  dc_type: z.enum(['RETURNABLE', 'NON_RETURNABLE']), is_billable: z.coerce.boolean().nullish(),
  warehouse_id: z.coerce.number().int().positive(), party_id: z.coerce.number().int().positive({ message: 'Select the party' }),
  party_dc_no: strOpt(60), so_id: idOpt, style_id: idOpt, purpose: strOpt(255), expected_return_date: dateStr.nullish(),
  vehicle_no: strOpt(30), remarks: strOpt(500), lines: z.array(deliveryLine).min(1, 'Add at least one item'),
}).superRefine((b, ctx) => {
  if (b.dc_type === 'NON_RETURNABLE' && (b.is_billable === null || b.is_billable === undefined)) ctx.addIssue({ code: 'custom', path: ['is_billable'], message: 'Non-returnable: choose billable or non-billable' });
});

async function resolveLines(cid: number, b: z.infer<typeof deliverySchema>) {
  const out: any[] = [];
  for (const l of b.lines) {
    if (l.source_ref) {
      const s = await stockOf(cid, l.source_ref);
      if (!s) throw BadRequest(`Stock item ${l.source_ref} not found`);
      if (s.warehouse_id !== b.warehouse_id) throw BadRequest(`${s.item_name}${s.lot_no ? ` (${s.lot_no})` : ''} is in another location`);
      if (l.qty > s.stock_qty + 0.0005) throw BadRequest(`${s.item_name}${s.lot_no ? ` (${s.lot_no})` : ''}: stock ${s.stock_qty}, cannot deliver ${l.qty}`);
      const rate = l.rate ?? s.rate ?? 0;
      out.push({ mt: s.material_type, ref: l.source_ref, yarn_id: s.yarn_id ?? null, fabric_id: s.fabric_id ?? null, trim_id: s.trim_id ?? null,
        desc: s.material_type === 'GENERAL' ? s.item_name : (l.item_description ?? s.lot_no ?? null), color: l.color_name ?? s.color_name ?? null,
        sizes: l.sizes ?? s.sizes ?? null, so_id: s.so_id ?? b.so_id, style_id: s.style_id ?? b.style_id, uom_id: s.uom_id, stock: s.stock_qty, qty: l.qty, rate, remarks: l.remarks });
    } else {
      if (b.delivery_kind === 'STOCK') throw BadRequest('Stock delivery: pick each item from stock');
      if (!l.item_description || !l.uom_id) throw BadRequest('General delivery: enter the item and UOM of each line');
      const rate = l.rate ?? 0;
      out.push({ mt: 'GENERAL' as Mat, ref: null, yarn_id: null, fabric_id: null, trim_id: null, desc: l.item_description, color: l.color_name, sizes: l.sizes,
        so_id: b.so_id, style_id: b.style_id, uom_id: l.uom_id, stock: 0, qty: l.qty, rate, remarks: l.remarks });
    }
  }
  return out;
}

async function writeLines(tx: any, deliveryId: number, lines: any[]) {
  await txExecute(tx, 'DELETE FROM trx_stock_delivery_line WHERE delivery_id = ?', [deliveryId]);   // draft lines only
  for (const l of lines) {
    await txExecute(tx,
      `INSERT INTO trx_stock_delivery_line (delivery_id, material_type, source_ref, yarn_id, fabric_id, trim_id, item_description, color_name, sizes,
                                            so_id, style_id, uom_id, stock_qty, qty, rate, amount, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [deliveryId, l.mt, l.ref, l.yarn_id, l.fabric_id, l.trim_id, l.desc, l.color, l.sizes, l.so_id, l.style_id, l.uom_id, l.stock, l.qty, l.rate, r4(l.qty * l.rate), l.remarks]);
  }
}

async function deliveryDoc(cid: number, id: number) {
  const h = await queryOne<any>(
    `SELECT h.*, p.party_name, w.warehouse_name, COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, st.style_code, uc.full_name prepared_by,
            ua.full_name approved_by_name, g.pass_no gate_pass_no
       FROM trx_stock_delivery h LEFT JOIN mst_party p ON p.id = h.party_id LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = h.so_id LEFT JOIN mst_style st ON st.id = h.style_id
       LEFT JOIN mst_user uc ON uc.id = h.created_by LEFT JOIN mst_user ua ON ua.id = h.approved_by LEFT JOIN trx_gate_outward g ON g.id = h.gate_outward_id
      WHERE h.id = ? AND h.company_id = ?`, [id, cid]);
  if (!h) return null;
  h.lines = await query<any>(
    `SELECT l.*, ${ITEM_NAME} item_name, u.code uom_code, l.qty - l.returned_qty balance_qty
       FROM trx_stock_delivery_line l ${ITEM_JOINS} WHERE l.delivery_id = ? ORDER BY l.id`, [id]);
  h.returns = await query<any>(
    `SELECT r.*, uc.full_name prepared_by, (SELECT SUM(rl.qty) FROM trx_stock_delivery_return_line rl WHERE rl.return_id = r.id) qty
       FROM trx_stock_delivery_return r LEFT JOIN mst_user uc ON uc.id = r.created_by WHERE r.delivery_id = ? ORDER BY r.id`, [id]);
  return h;
}

deliveryRouter.get('/deliveries', VIEW, ah(async (req, res) => {
  const q = listQuery.extend({ kind: z.enum(['STOCK', 'GENERAL']).optional(), dc_type: z.enum(['RETURNABLE', 'NON_RETURNABLE']).optional(),
    outstanding: z.coerce.boolean().default(false) }).parse(req.query);
  const w = listWhere(cidOf(req), q, 'doc_date', ['h.doc_no', 'p.party_name', 'h.party_dc_no', 'h.purpose']);
  if (q.kind) { w.where += ' AND h.delivery_kind = ?'; w.params.push(q.kind); }
  if (q.dc_type) { w.where += ' AND h.dc_type = ?'; w.params.push(q.dc_type); }
  if (q.outstanding) w.where += ` AND h.dc_type = 'RETURNABLE' AND h.status IN ('APPROVED', 'PARTIAL_RETURN')`;
  const rows = await query<any>(
    `SELECT h.*, p.party_name, w.warehouse_name, COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, uc.full_name prepared_by,
            (SELECT COUNT(*) FROM trx_stock_delivery_line l WHERE l.delivery_id = h.id) line_count,
            (SELECT SUM(l.qty) FROM trx_stock_delivery_line l WHERE l.delivery_id = h.id) total_qty,
            (SELECT SUM(l.returned_qty) FROM trx_stock_delivery_line l WHERE l.delivery_id = h.id) returned_qty,
            (SELECT SUM(l.amount) FROM trx_stock_delivery_line l WHERE l.delivery_id = h.id) total_amount
       FROM trx_stock_delivery h LEFT JOIN mst_party p ON p.id = h.party_id LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = h.so_id LEFT JOIN mst_user uc ON uc.id = h.created_by
      WHERE ${w.where} ORDER BY h.doc_date DESC, h.id DESC LIMIT ${q.limit}`, w.params);
  res.json({ data: rows });
}));

deliveryRouter.get('/deliveries/:id', VIEW, ah(async (req, res) => {
  const d = await deliveryDoc(cidOf(req), idParam(req));
  if (!d) throw BadRequest('Delivery not found');
  res.json({ data: d });
}));

deliveryRouter.post('/deliveries', CREATE, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = deliverySchema.parse(req.body);
  const lines = await resolveLines(cid, b);
  const id = await transaction(async (tx) => {
    const docNo = await nextDocNumber(tx, cid, KIND_DOC[b.delivery_kind]);
    const styleId = b.style_id ?? (await styleOfSo(b.so_id));
    const r = await txExecute(tx,
      `INSERT INTO trx_stock_delivery (company_id, doc_no, doc_date, delivery_kind, dc_type, is_billable, warehouse_id, party_id, party_dc_no, so_id, style_id,
                                       purpose, expected_return_date, vehicle_no, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, docNo, b.doc_date, b.delivery_kind, b.dc_type, b.dc_type === 'NON_RETURNABLE' ? (b.is_billable ? 1 : 0) : null, b.warehouse_id, b.party_id,
       b.party_dc_no, b.so_id, styleId, b.purpose, b.dc_type === 'RETURNABLE' ? b.expected_return_date ?? null : null, b.vehicle_no, b.remarks, uidOf(req)]);
    await writeLines(tx, r.insertId, lines);
    return r.insertId as number;
  });
  const d = await deliveryDoc(cid, id);
  await audit(req, 'trx_stock_delivery', id, 'INSERT', undefined, d);
  res.status(201).json({ data: d, message: `${d.doc_no} saved — awaiting approval` });
}));

deliveryRouter.put('/deliveries/:id', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = deliverySchema.parse(req.body);
  const before = await deliveryDoc(cid, id);
  if (!before) throw BadRequest('Delivery not found');
  needStatus(before, ['DRAFT'], 'edited');
  if (b.delivery_kind !== before.delivery_kind) throw BadRequest('The delivery kind cannot change');
  const lines = await resolveLines(cid, b);
  await transaction(async (tx) => {
    const styleId = b.style_id ?? (await styleOfSo(b.so_id));
    await txExecute(tx,
      `UPDATE trx_stock_delivery SET doc_date = ?, dc_type = ?, is_billable = ?, warehouse_id = ?, party_id = ?, party_dc_no = ?, so_id = ?, style_id = ?,
              purpose = ?, expected_return_date = ?, vehicle_no = ?, remarks = ? WHERE id = ? AND status = 'DRAFT'`,
      [b.doc_date, b.dc_type, b.dc_type === 'NON_RETURNABLE' ? (b.is_billable ? 1 : 0) : null, b.warehouse_id, b.party_id, b.party_dc_no, b.so_id, styleId,
       b.purpose, b.dc_type === 'RETURNABLE' ? b.expected_return_date ?? null : null, b.vehicle_no, b.remarks, id]);
    await writeLines(tx, id, lines);
  });
  const d = await deliveryDoc(cid, id);
  await audit(req, 'trx_stock_delivery', id, 'UPDATE', before, d);
  res.json({ data: d, message: `${d.doc_no} saved` });
}));

deliveryRouter.post('/deliveries/:id/approve', APPROVE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const h = await mustGet<any>('trx_stock_delivery', cid, id, 'Delivery');
  needStatus(h, ['DRAFT'], 'approved');
  await transaction(async (tx) => {
    const lock = await txQueryOne<any>(tx, 'SELECT status FROM trx_stock_delivery WHERE id = ? FOR UPDATE', [id]);
    needStatus({ ...lock, doc_no: h.doc_no }, ['DRAFT'], 'approved');
    const lines = await txQuery<any>(tx, 'SELECT * FROM trx_stock_delivery_line WHERE delivery_id = ? ORDER BY id', [id]);
    const ctx: MoveCtx = { cid, userId: uidOf(req), tx, refType: 'STOCK_DELIVERY', refId: id, refNo: h.doc_no, date: todayStr() };
    for (const l of lines) {
      if (!l.source_ref) continue;   // free general-delivery item: no stock
      await moveStock(ctx, l.source_ref, -n(l.qty), { txnType: 'ISSUE', label: 'DELIVERY', rate: n(l.rate), soId: l.so_id });
    }
    let gateId: number | null = null;
    if (h.vehicle_no) {
      const passNo = await nextDocNumber(tx, cid, 'GATE_OUTWARD');
      const passType = h.dc_type === 'RETURNABLE' ? 'RETURNABLE_GENERAL' : h.is_billable ? 'NON_RETURNABLE_DISPATCH' : 'NON_RETURNABLE_SAMPLE';
      const g = await txExecute(tx,
        `INSERT INTO trx_gate_outward (company_id, pass_no, pass_date, pass_time, pass_type, party_id, vehicle_no, purpose, ref_type, ref_id, ref_no,
                                       expected_return_date, total_qty, uom_id, status, remarks, created_by)
         VALUES (?,?,CURDATE(),CURTIME(),?,?,?,?,'STOCK_DELIVERY',?,?,?,?,?,'APPROVED',?,?)`,
        [cid, passNo, passType, h.party_id, h.vehicle_no, (h.purpose || `${h.delivery_kind === 'GENERAL' ? 'General' : 'Stock'} delivery ${h.doc_no}`).slice(0, 255),
         id, h.doc_no, h.expected_return_date, lines.reduce((a, l) => a + n(l.qty), 0), lines[0]?.uom_id ?? null, `From ${h.doc_no}`, uidOf(req)]);
      gateId = g.insertId;
    }
    await txExecute(tx, `UPDATE trx_stock_delivery SET status = 'APPROVED', approved_by = ?, approved_at = NOW(), gate_outward_id = ? WHERE id = ?`, [uidOf(req), gateId, id]);
  });
  const d = await deliveryDoc(cid, id);
  await audit(req, 'trx_stock_delivery', id, 'UPDATE', { status: 'DRAFT' }, { status: 'APPROVED', gate_pass: d.gate_pass_no });
  res.json({ data: d, message: `${h.doc_no} approved${h.dc_type === 'RETURNABLE' ? ' — outstanding until returned' : ''}${d.gate_pass_no ? `; gate pass ${d.gate_pass_no}` : ''}` });
}));

const returnSchema = z.object({
  return_date: dateStr.default(todayStr), party_dc_no: strOpt(60), remarks: strOpt(500),
  lines: z.array(z.object({ delivery_line_id: z.coerce.number().int().positive(), qty: z.coerce.number().min(0) })).min(1),
});

deliveryRouter.post('/deliveries/:id/returns', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = returnSchema.parse(req.body);
  const h = await mustGet<any>('trx_stock_delivery', cid, id, 'Delivery');
  if (h.dc_type !== 'RETURNABLE') throw BadRequest(`${h.doc_no} is non-returnable`);
  needStatus(h, ['APPROVED', 'PARTIAL_RETURN'], 'received back');
  const want = b.lines.filter((l) => l.qty > 0);
  if (!want.length) throw BadRequest('Enter the returned qty of at least one item');
  let retNo = '';
  await transaction(async (tx) => {
    await txQueryOne(tx, 'SELECT id FROM trx_stock_delivery WHERE id = ? FOR UPDATE', [id]);
    retNo = await nextDocNumber(tx, cid, 'DELIVERY_RETURN');
    const r = await txExecute(tx, `INSERT INTO trx_stock_delivery_return (company_id, delivery_id, return_no, return_date, party_dc_no, remarks, created_by) VALUES (?,?,?,?,?,?,?)`,
      [cid, id, retNo, b.return_date, b.party_dc_no, b.remarks, uidOf(req)]);
    const ctx: MoveCtx = { cid, userId: uidOf(req), tx, refType: 'DELIVERY_RETURN', refId: r.insertId, refNo: retNo, date: b.return_date };
    for (const l of want) {
      const dl = await txQueryOne<any>(tx, 'SELECT * FROM trx_stock_delivery_line WHERE id = ? AND delivery_id = ? FOR UPDATE', [l.delivery_line_id, id]);
      if (!dl) throw BadRequest('Return line does not belong to this delivery');
      const bal = r4(n(dl.qty) - n(dl.returned_qty));
      if (l.qty > bal + 0.0005) throw BadRequest(`Line ${dl.item_description ?? dl.id}: only ${bal} is outstanding`);
      await txExecute(tx, 'INSERT INTO trx_stock_delivery_return_line (return_id, delivery_line_id, qty) VALUES (?,?,?)', [r.insertId, dl.id, l.qty]);
      await txExecute(tx, 'UPDATE trx_stock_delivery_line SET returned_qty = returned_qty + ? WHERE id = ?', [l.qty, dl.id]);
      if (dl.source_ref) await moveStock(ctx, dl.source_ref, l.qty, { txnType: 'RETURN', label: 'DELIVERY_RETURN', rate: n(dl.rate), soId: dl.so_id });
    }
    const left = await txQueryOne<any>(tx, 'SELECT SUM(qty - returned_qty) bal FROM trx_stock_delivery_line WHERE delivery_id = ?', [id]);
    const full = n(left?.bal) <= 0.0005;
    await txExecute(tx, 'UPDATE trx_stock_delivery SET status = ? WHERE id = ?', [full ? 'RETURNED' : 'PARTIAL_RETURN', id]);
    if (h.gate_outward_id) {
      await txExecute(tx, 'UPDATE trx_gate_outward SET status = ?, is_returned = ?, returned_date = ? WHERE id = ?',
        [full ? 'RETURNED_FULL' : 'RETURNED_PARTIAL', full ? 1 : 0, b.return_date, h.gate_outward_id]);
    }
  });
  const d = await deliveryDoc(cid, id);
  await audit(req, 'trx_stock_delivery_return', id, 'INSERT', undefined, { return_no: retNo, ...b });
  res.status(201).json({ data: d, message: `${retNo}: return entered against ${h.doc_no}${d.status === 'RETURNED' ? ' — fully returned' : ''}` });
}));

/** A returnable DC that will not come back in full (lost / consumed) is closed with a reason; the rest stays out of stock. */
deliveryRouter.post('/deliveries/:id/close', APPROVE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const h = await mustGet<any>('trx_stock_delivery', cid, id, 'Delivery');
  needStatus(h, ['APPROVED', 'PARTIAL_RETURN'], 'closed');
  if (h.dc_type !== 'RETURNABLE') throw BadRequest(`${h.doc_no} is non-returnable — nothing is outstanding`);
  await query(`UPDATE trx_stock_delivery SET status = 'CLOSED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`, [reason, uidOf(req), id]);
  if (h.gate_outward_id) await query(`UPDATE trx_gate_outward SET status = 'CLOSED' WHERE id = ?`, [h.gate_outward_id]);
  await audit(req, 'trx_stock_delivery', id, 'UPDATE', { status: h.status }, { status: 'CLOSED', reason });
  res.json({ data: await deliveryDoc(cid, id), message: `${h.doc_no} closed` });
}));

deliveryRouter.post('/deliveries/:id/cancel', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const h = await mustGet<any>('trx_stock_delivery', cid, id, 'Delivery');
  needStatus(h, ['DRAFT'], 'cancelled');
  await query(`UPDATE trx_stock_delivery SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`, [reason, uidOf(req), id]);
  await audit(req, 'trx_stock_delivery', id, 'UPDATE', { status: h.status }, { status: 'CANCELLED', reason });
  res.json({ data: await deliveryDoc(cid, id), message: `${h.doc_no} cancelled` });
}));

// ================================================================== REPORTS
const rq = listQuery.extend({ dc_type: z.enum(['RETURNABLE', 'NON_RETURNABLE']).optional(), outstanding: z.coerce.boolean().default(false) });

deliveryRouter.get('/reports/stock-delivery', requireAny('INVENTORY.VIEW', 'REPORT.VIEW'), ah(async (req, res) => {
  const q = rq.parse(req.query);
  const w = listWhere(cidOf(req), q, 'doc_date', ['h.doc_no', 'p.party_name']);
  if (q.dc_type) { w.where += ' AND h.dc_type = ?'; w.params.push(q.dc_type); }
  if (q.outstanding) w.where += ` AND h.dc_type = 'RETURNABLE' AND h.status IN ('APPROVED', 'PARTIAL_RETURN') AND l.qty - l.returned_qty > 0.0005`;
  const rows = await query<any>(
    `SELECT COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, st.style_code style_no, h.doc_no dc_no, h.doc_date dc_date, w.warehouse_name location,
            p.party_name, ${ITEM_NAME} item_name, h.dc_type, h.is_billable, u.code uom, l.stock_qty, l.qty delivered_qty, l.returned_qty,
            CASE WHEN h.dc_type = 'RETURNABLE' AND h.status <> 'CLOSED' THEN l.qty - l.returned_qty ELSE 0 END balance_qty, l.rate, l.amount, h.status
       FROM trx_stock_delivery h JOIN trx_stock_delivery_line l ON l.delivery_id = h.id
       LEFT JOIN mst_party p ON p.id = h.party_id LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = COALESCE(l.so_id, h.so_id) LEFT JOIN mst_style st ON st.id = COALESCE(l.style_id, h.style_id)
       ${ITEM_JOINS}
      WHERE ${w.where} AND h.delivery_kind = 'STOCK' AND h.status NOT IN ('DRAFT', 'CANCELLED') ORDER BY h.doc_date, h.id, l.id LIMIT 5000`, w.params);
  res.json({ data: rows });
}));

/** General deliveries: general delivery DCs (with lines) + legacy header-only outward gate passes of the general kinds. */
deliveryRouter.get('/reports/general-deliveries', requireAny('INVENTORY.VIEW', 'REPORT.VIEW', 'GATE_OUTWARD.VIEW'), ah(async (req, res) => {
  const q = rq.parse(req.query);
  const cid = cidOf(req);
  const w = listWhere(cid, q, 'doc_date', ['h.doc_no', 'p.party_name', 'h.party_dc_no']);
  if (q.dc_type) { w.where += ' AND h.dc_type = ?'; w.params.push(q.dc_type); }
  if (q.outstanding) w.where += ` AND h.dc_type = 'RETURNABLE' AND h.status IN ('APPROVED', 'PARTIAL_RETURN') AND l.qty - l.returned_qty > 0.0005`;
  const dcs = await query<any>(
    `SELECT h.doc_no dc_no, h.doc_date dc_date, h.dc_type, w.warehouse_name from_location, p.party_name, h.party_dc_no pdc_no,
            ${ITEM_NAME} item_name, l.item_description description, l.color_name, l.sizes, u.code uom, l.qty, l.returned_qty rec_qty,
            CASE WHEN h.dc_type = 'RETURNABLE' AND h.status <> 'CLOSED' THEN l.qty - l.returned_qty ELSE 0 END bal_qty, uc.full_name prepared_by, h.status, 'DC' source
       FROM trx_stock_delivery h JOIN trx_stock_delivery_line l ON l.delivery_id = h.id
       LEFT JOIN mst_party p ON p.id = h.party_id LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id ${ITEM_JOINS}
       LEFT JOIN mst_user uc ON uc.id = h.created_by
      WHERE ${w.where} AND h.delivery_kind = 'GENERAL' AND h.status NOT IN ('DRAFT', 'CANCELLED') ORDER BY h.doc_date, h.id, l.id LIMIT 5000`, w.params);
  // legacy outward gate passes (no item lines) of the general kinds, not made from a DC of this screen
  const gp: unknown[] = [cid];
  let gw = `g.company_id = ? AND g.pass_type IN ('RETURNABLE_GENERAL', 'NON_RETURNABLE_SCRAP', 'NON_RETURNABLE_SAMPLE') AND COALESCE(g.ref_type, '') <> 'STOCK_DELIVERY'`;
  if (q.from) { gw += ' AND g.pass_date >= ?'; gp.push(q.from); }
  if (q.to) { gw += ' AND g.pass_date <= ?'; gp.push(q.to); }
  if (q.dc_type) gw += q.dc_type === 'RETURNABLE' ? ` AND g.pass_type LIKE 'RETURNABLE%'` : ` AND g.pass_type LIKE 'NON_RETURNABLE%'`;
  if (q.outstanding) gw += ` AND g.pass_type LIKE 'RETURNABLE%' AND g.is_returned = 0`;
  if (q.q) { gw += ' AND (g.pass_no LIKE ? OR p.party_name LIKE ?)'; gp.push(`%${q.q}%`, `%${q.q}%`); }
  const passes = await query<any>(
    `SELECT g.pass_no dc_no, g.pass_date dc_date, IF(g.pass_type LIKE 'RETURNABLE%', 'RETURNABLE', 'NON_RETURNABLE') dc_type, NULL from_location,
            COALESCE(p.party_name, un.unit_name) party_name, g.ref_no pdc_no, g.purpose item_name, g.remarks description, NULL color_name, NULL sizes,
            um.code uom, g.total_qty qty, IF(g.is_returned = 1, g.total_qty, 0) rec_qty,
            IF(g.pass_type LIKE 'RETURNABLE%' AND g.is_returned = 0, g.total_qty, 0) bal_qty, uc.full_name prepared_by, g.status, 'GATE_PASS' source
       FROM trx_gate_outward g LEFT JOIN mst_party p ON p.id = g.party_id LEFT JOIN mst_unit un ON un.id = g.to_unit_id
       LEFT JOIN cfg_uom um ON um.id = g.uom_id LEFT JOIN mst_user uc ON uc.id = g.created_by
      WHERE ${gw} ORDER BY g.pass_date, g.id LIMIT 5000`, gp);
  const rows = [...dcs, ...passes].sort((a, b) => String(a.dc_date).localeCompare(String(b.dc_date)));
  res.json({ data: rows });
}));
