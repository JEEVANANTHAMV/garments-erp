import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { stockOf, moveStock, type MoveCtx } from './stockPost.js';
import { n, r4, cidOf, uidOf, todayStr, idOpt, strOpt, dateStr, reasonSchema, idParam, listQuery, listWhere, mustGet, needStatus, ITEM_NAME, ITEM_JOINS, styleOfSo } from './common.js';

/**
 * Scrap entry and rejection entry at any stage (client tracker rows 88 / 89 / 91).
 *   SCRAP      — stock items leave stock; garment / WIP pieces at a production stage are recorded (no stock engine here).
 *   REJECTION  — stock items move into the rejection godown (a REJECTION-type location): trims / general items keep their
 *                lot there, a whole fabric roll moves (marked REJECTED), part rolls and yarn go out with a ledger transfer in.
 * Draft → post (Adjust Stock) · cancel draft with a reason. Posted entries are never edited or deleted.
 */
export const scrapRouter = Router();
const VIEW = requireAny('INVENTORY.VIEW', 'QC.VIEW', 'PRODUCTION.VIEW');
const CREATE = requireAny('INVENTORY.CREATE', 'QC.CREATE', 'PRODUCTION.CREATE', 'INVENTORY.ADJUST');
const POST = requirePermission('INVENTORY.ADJUST');

const line = z.object({
  material_type: z.enum(['YARN', 'FABRIC', 'TRIM', 'GENERAL', 'GARMENT']),
  source_ref: z.string().trim().max(255).nullish().transform((v) => v || null),
  item_description: strOpt(255), color_name: strOpt(80), sizes: strOpt(80), uom_id: idOpt,
  qty: z.coerce.number().positive('Qty must be more than zero'), rate: z.coerce.number().min(0).nullish(), reason: strOpt(255),
});
const schema = z.object({
  doc_date: dateStr.default(todayStr), entry_kind: z.enum(['SCRAP', 'REJECTION']), stage: z.string().trim().min(2, 'Select the stage').max(40),
  warehouse_id: z.coerce.number().int().positive(), rejection_warehouse_id: idOpt, so_id: idOpt, style_id: idOpt,
  process_name: strOpt(80), remarks: strOpt(500), lines: z.array(line).min(1, 'Add at least one item'), post_now: z.coerce.boolean().default(false),
});

async function resolve(cid: number, b: z.infer<typeof schema>) {
  const out: any[] = [];
  for (const l of b.lines) {
    if (l.material_type !== 'GARMENT') {
      if (!l.source_ref) throw BadRequest('Pick each stock item from the stock list (garment pieces are typed in)');
      const s = await stockOf(cid, l.source_ref);
      if (!s) throw BadRequest(`Stock item ${l.source_ref} not found`);
      if (s.material_type !== l.material_type) throw BadRequest(`${s.item_name}: not a ${l.material_type.toLowerCase()} item`);
      if (s.warehouse_id !== b.warehouse_id) throw BadRequest(`${s.item_name}${s.lot_no ? ` (${s.lot_no})` : ''} is in another location`);
      if (l.qty > s.stock_qty + 0.0005) throw BadRequest(`${s.item_name}${s.lot_no ? ` (${s.lot_no})` : ''}: stock ${s.stock_qty}, cannot take ${l.qty}`);
      const rate = l.rate ?? s.rate ?? 0;
      out.push({ ...l, yarn_id: s.yarn_id ?? null, fabric_id: s.fabric_id ?? null, trim_id: s.trim_id ?? null,
        item_description: s.material_type === 'GENERAL' ? s.item_name : (l.item_description ?? s.lot_no ?? null), color_name: l.color_name ?? s.color_name ?? null,
        so_id: s.so_id ?? b.so_id, uom_id: s.uom_id, rate });
    } else {
      if (!l.item_description || !l.uom_id) throw BadRequest('Garment / WIP line: enter the description and UOM');
      out.push({ ...l, source_ref: null, yarn_id: null, fabric_id: null, trim_id: null, so_id: b.so_id, rate: l.rate ?? 0 });
    }
  }
  return out;
}

async function writeLines(tx: any, id: number, lines: any[]) {
  await txExecute(tx, 'DELETE FROM trx_scrap_rejection_line WHERE entry_id = ?', [id]);   // draft lines only
  for (const l of lines) {
    await txExecute(tx,
      `INSERT INTO trx_scrap_rejection_line (entry_id, material_type, source_ref, yarn_id, fabric_id, trim_id, item_description, color_name, sizes, so_id, uom_id, qty, rate, amount, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, l.material_type, l.source_ref, l.yarn_id, l.fabric_id, l.trim_id, l.item_description, l.color_name, l.sizes, l.so_id, l.uom_id, l.qty, l.rate, r4(l.qty * l.rate), l.reason]);
  }
}

async function rejectionGodown(cid: number, given: number | null) {
  if (given) {
    const w = await queryOne<any>('SELECT id, warehouse_type FROM mst_warehouse WHERE id = ? AND company_id = ?', [given, cid]);
    if (!w) throw BadRequest('Rejection godown not found');
    return Number(w.id);
  }
  const w = await queryOne<any>(`SELECT id FROM mst_warehouse WHERE company_id = ? AND warehouse_type = 'REJECTION' AND is_active = 1 ORDER BY id LIMIT 1`, [cid]);
  if (!w) throw BadRequest('No rejection godown: add a location of type REJECTION (Masters › Warehouses) or pick one');
  return Number(w.id);
}

async function doc(cid: number, id: number) {
  const h = await queryOne<any>(
    `SELECT h.*, w.warehouse_name, rw.warehouse_name rejection_warehouse_name, COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, st.style_code,
            uc.full_name prepared_by, up.full_name posted_by_name
       FROM trx_scrap_rejection h LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id LEFT JOIN mst_warehouse rw ON rw.id = h.rejection_warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = h.so_id LEFT JOIN mst_style st ON st.id = h.style_id
       LEFT JOIN mst_user uc ON uc.id = h.created_by LEFT JOIN mst_user up ON up.id = h.posted_by
      WHERE h.id = ? AND h.company_id = ?`, [id, cid]);
  if (!h) return null;
  h.lines = await query<any>(`SELECT l.*, ${ITEM_NAME} item_name, u.code uom_code FROM trx_scrap_rejection_line l ${ITEM_JOINS} WHERE l.entry_id = ? ORDER BY l.id`, [id]);
  return h;
}

async function post(tx: any, cid: number, userId: number, id: number) {
  const h = await txQueryOne<any>(tx, 'SELECT * FROM trx_scrap_rejection WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
  needStatus(h, ['DRAFT'], 'posted');
  const lines = await txQuery<any>(tx, 'SELECT * FROM trx_scrap_rejection_line WHERE entry_id = ? ORDER BY id', [id]);
  const ctx: MoveCtx = { cid, userId, tx, refType: h.entry_kind === 'SCRAP' ? 'SCRAP_ENTRY' : 'REJECTION_ENTRY', refId: id, refNo: h.doc_no, date: String(h.doc_date).slice(0, 10) };
  for (const l of lines) {
    if (!l.source_ref) continue;   // garment / WIP pieces: recorded only
    await moveStock(ctx, l.source_ref, -n(l.qty), { txnType: h.entry_kind === 'SCRAP' ? 'ADJUST' : 'TRANSFER_OUT', label: h.entry_kind, rate: n(l.rate), soId: l.so_id,
      to: h.entry_kind === 'REJECTION' ? h.rejection_warehouse_id : null });
  }
  await txExecute(tx, `UPDATE trx_scrap_rejection SET status = 'POSTED', posted_by = ?, posted_at = NOW() WHERE id = ?`, [userId, id]);
}

scrapRouter.get('/scrap-rejections', VIEW, ah(async (req, res) => {
  const q = listQuery.extend({ kind: z.enum(['SCRAP', 'REJECTION']).optional() }).parse(req.query);
  const w = listWhere(cidOf(req), q, 'doc_date', ['h.doc_no', 'h.stage', 'h.remarks']);
  if (q.kind) { w.where += ' AND h.entry_kind = ?'; w.params.push(q.kind); }
  res.json({ data: await query<any>(
    `SELECT h.*, w.warehouse_name, rw.warehouse_name rejection_warehouse_name, COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, uc.full_name prepared_by,
            (SELECT COUNT(*) FROM trx_scrap_rejection_line l WHERE l.entry_id = h.id) line_count,
            (SELECT SUM(l.qty) FROM trx_scrap_rejection_line l WHERE l.entry_id = h.id) total_qty,
            (SELECT SUM(l.amount) FROM trx_scrap_rejection_line l WHERE l.entry_id = h.id) total_amount
       FROM trx_scrap_rejection h LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id LEFT JOIN mst_warehouse rw ON rw.id = h.rejection_warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = h.so_id LEFT JOIN mst_user uc ON uc.id = h.created_by
      WHERE ${w.where} ORDER BY h.doc_date DESC, h.id DESC LIMIT ${q.limit}`, w.params) });
}));

scrapRouter.get('/scrap-rejections/:id', VIEW, ah(async (req, res) => {
  const d = await doc(cidOf(req), idParam(req));
  if (!d) throw BadRequest('Entry not found');
  res.json({ data: d });
}));

scrapRouter.post('/scrap-rejections', CREATE, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = schema.parse(req.body);
  const lines = await resolve(cid, b);
  const rejWh = b.entry_kind === 'REJECTION' ? await rejectionGodown(cid, b.rejection_warehouse_id) : null;
  if (rejWh && rejWh === b.warehouse_id) throw BadRequest('The goods are already in the rejection godown');
  const id = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, b.entry_kind === 'SCRAP' ? 'SCRAP_ENTRY' : 'REJECTION_ENTRY');
    const r = await txExecute(tx,
      `INSERT INTO trx_scrap_rejection (company_id, doc_no, doc_date, entry_kind, stage, warehouse_id, rejection_warehouse_id, so_id, style_id, process_name, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.doc_date, b.entry_kind, b.stage, b.warehouse_id, rejWh, b.so_id, b.style_id ?? (await styleOfSo(b.so_id)), b.process_name, b.remarks, uidOf(req)]);
    await writeLines(tx, r.insertId, lines);
    if (b.post_now) await post(tx, cid, uidOf(req), r.insertId);
    return r.insertId as number;
  });
  const d = await doc(cid, id);
  await audit(req, 'trx_scrap_rejection', id, 'INSERT', undefined, d);
  res.status(201).json({ data: d, message: `${d.doc_no} ${b.post_now ? 'posted' : 'saved as draft'}` });
}));

scrapRouter.put('/scrap-rejections/:id', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = schema.parse(req.body);
  const before = await doc(cid, id);
  if (!before) throw BadRequest('Entry not found');
  needStatus(before, ['DRAFT'], 'edited');
  if (b.entry_kind !== before.entry_kind) throw BadRequest('Scrap / rejection kind cannot change');
  const lines = await resolve(cid, b);
  const rejWh = b.entry_kind === 'REJECTION' ? await rejectionGodown(cid, b.rejection_warehouse_id) : null;
  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_scrap_rejection SET doc_date = ?, stage = ?, warehouse_id = ?, rejection_warehouse_id = ?, so_id = ?, style_id = ?, process_name = ?, remarks = ? WHERE id = ? AND status = 'DRAFT'`,
      [b.doc_date, b.stage, b.warehouse_id, rejWh, b.so_id, b.style_id ?? (await styleOfSo(b.so_id)), b.process_name, b.remarks, id]);
    await writeLines(tx, id, lines);
  });
  const d = await doc(cid, id);
  await audit(req, 'trx_scrap_rejection', id, 'UPDATE', before, d);
  res.json({ data: d, message: `${d.doc_no} saved` });
}));

scrapRouter.post('/scrap-rejections/:id/post', POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  await mustGet('trx_scrap_rejection', cid, id, 'Entry');
  await transaction((tx) => post(tx, cid, uidOf(req), id));
  const d = await doc(cid, id);
  await audit(req, 'trx_scrap_rejection', id, 'UPDATE', { status: 'DRAFT' }, { status: 'POSTED' });
  res.json({ data: d, message: `${d.doc_no} posted${d.entry_kind === 'REJECTION' ? ` — moved to ${d.rejection_warehouse_name}` : ''}` });
}));

scrapRouter.post('/scrap-rejections/:id/cancel', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const h = await mustGet<any>('trx_scrap_rejection', cid, id, 'Entry');
  needStatus(h, ['DRAFT'], 'cancelled');
  await query(`UPDATE trx_scrap_rejection SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`, [reason, uidOf(req), id]);
  await audit(req, 'trx_scrap_rejection', id, 'UPDATE', { status: h.status }, { status: 'CANCELLED', reason });
  res.json({ data: await doc(cid, id), message: `${h.doc_no} cancelled` });
}));

scrapRouter.get('/reports/scrap-rejections', requireAny('INVENTORY.VIEW', 'REPORT.VIEW', 'QC.VIEW'), ah(async (req, res) => {
  const q = listQuery.extend({ kind: z.enum(['SCRAP', 'REJECTION']).optional() }).parse(req.query);
  const w = listWhere(cidOf(req), { ...q, status: q.status ?? 'POSTED' }, 'doc_date', ['h.doc_no', 'h.stage', 'h.remarks', 'l.item_description']);
  if (q.kind) { w.where += ' AND h.entry_kind = ?'; w.params.push(q.kind); }
  res.json({ data: await query<any>(
    `SELECT h.entry_kind, h.doc_no, h.doc_date, h.stage, h.process_name, w.warehouse_name location, rw.warehouse_name rejection_godown,
            COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, st.style_code, ${ITEM_NAME} item_name, l.material_type, l.color_name, l.sizes, u.code uom,
            l.qty, l.rate, l.amount, COALESCE(l.reason, h.remarks) reason, uc.full_name prepared_by
       FROM trx_scrap_rejection h JOIN trx_scrap_rejection_line l ON l.entry_id = h.id
       LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id LEFT JOIN mst_warehouse rw ON rw.id = h.rejection_warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = COALESCE(l.so_id, h.so_id) LEFT JOIN mst_style st ON st.id = h.style_id ${ITEM_JOINS}
       LEFT JOIN mst_user uc ON uc.id = h.created_by
      WHERE ${w.where} ORDER BY h.doc_date, h.id, l.id LIMIT 5000`, w.params) });
}));
