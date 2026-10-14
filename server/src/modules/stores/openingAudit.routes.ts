import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { MATS, stockRows, stockOf, moveStock, addGeneral, type Mat, type MoveCtx } from './stockPost.js';
import {
  n, r4, cidOf, uidOf, todayStr, idOpt, strOpt, dateStr, reasonSchema, idParam, listQuery, listWhere, mustGet, needStatus,
  can, SO_COLS, soJoins, ITEM_NAME, ITEM_TYPE, ITEM_JOINS, styleOfSo,
} from './common.js';

/**
 * Opening stock entry and stock audit (client tracker 14-Oct-2026).
 *   GET  /stores/stock-items                       stock per lot / roll / trim lot / general item (pickers, count sheet)
 *   /stores/opening-stock                          list · get · create (draft) · edit draft · post · cancel draft
 *   /stores/stock-audit                            list · get · create · edit · submit · approve (posts the difference) · reject · cancel
 *   GET  /stores/reports/opening-stock | stock-audit   the client's report sheets
 */
export const openingAuditRouter = Router();
const VIEW = requireAny('INVENTORY.VIEW', 'GRN.VIEW');
const CREATE = requireAny('INVENTORY.CREATE', 'INVENTORY.ADJUST');
const POST = requirePermission('INVENTORY.ADJUST');

openingAuditRouter.get('/stock-items', requireAny('INVENTORY.VIEW', 'ISSUE.VIEW', 'GRN.VIEW'), ah(async (req, res) => {
  const q = z.object({
    material_type: z.enum(MATS), warehouse_id: z.coerce.number().int().positive().optional(),
    so_id: z.coerce.number().int().positive().optional(), q: z.string().trim().max(80).optional(),
    include_zero: z.coerce.boolean().default(false),
  }).parse(req.query);
  res.json({ data: await stockRows(cidOf(req), q) });
}));

// ================================================================== OPENING STOCK
const openingLine = z.object({
  material_type: z.enum(MATS),
  yarn_id: idOpt, fabric_id: idOpt, trim_id: idOpt,
  item_description: strOpt(255), color_name: strOpt(80), sizes: strOpt(80), lot_no: strOpt(60), roll_no: strOpt(60),
  so_id: idOpt, style_id: idOpt, uom_id: z.coerce.number().int().positive(),
  qty: z.coerce.number().positive('Qty must be more than zero'), rate: z.coerce.number().min(0).default(0), remarks: strOpt(255),
}).superRefine((l, ctx) => {
  const need = { YARN: l.yarn_id, FABRIC: l.fabric_id, TRIM: l.trim_id, GENERAL: l.item_description }[l.material_type];
  if (!need) ctx.addIssue({ code: 'custom', message: l.material_type === 'GENERAL' ? 'General item: enter the item name' : `Select the ${l.material_type.toLowerCase()}` });
  if (l.material_type === 'FABRIC' && l.uom_id !== UOM_KG) ctx.addIssue({ code: 'custom', message: 'Fabric opening stock is kept as rolls in KG — choose UOM KG' });
});
const openingSchema = z.object({
  doc_date: dateStr.default(todayStr), party_id: idOpt, warehouse_id: z.coerce.number().int().positive(),
  process_name: strOpt(80), so_id: idOpt, style_id: idOpt, remarks: strOpt(500),
  lines: z.array(openingLine).min(1, 'Add at least one item'),
  post_now: z.coerce.boolean().default(false),
});

async function openingDoc(cid: number, id: number) {
  const h = await queryOne<any>(
    `SELECT h.*, p.party_name, w.warehouse_name, ${SO_COLS}, st.style_code, uc.full_name prepared_by, up.full_name posted_by_name
       FROM trx_opening_stock h LEFT JOIN mst_party p ON p.id = h.party_id LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id
       ${soJoins('h.so_id')} LEFT JOIN mst_style st ON st.id = h.style_id
       LEFT JOIN mst_user uc ON uc.id = h.created_by LEFT JOIN mst_user up ON up.id = h.posted_by
      WHERE h.id = ? AND h.company_id = ?`, [id, cid]);
  if (!h) return null;
  h.lines = await query<any>(
    `SELECT l.*, ${ITEM_NAME} item_name, ${ITEM_TYPE} item_type, u.code uom_code, COALESCE(NULLIF(lso.io_no, ''), lso.so_no) line_so_no, lst.style_code line_style_code
       FROM trx_opening_stock_line l ${ITEM_JOINS} LEFT JOIN trx_sales_order lso ON lso.id = l.so_id LEFT JOIN mst_style lst ON lst.id = l.style_id
      WHERE l.opening_id = ? ORDER BY l.id`, [id]);
  return h;
}

async function writeOpeningLines(tx: any, openingId: number, body: z.infer<typeof openingSchema>) {
  await txExecute(tx, 'DELETE FROM trx_opening_stock_line WHERE opening_id = ?', [openingId]);   // draft lines only
  for (const l of body.lines) {
    const soId = l.so_id ?? body.so_id;
    const styleId = l.style_id ?? (l.so_id ? await styleOfSo(l.so_id) : body.style_id);
    await txExecute(tx,
      `INSERT INTO trx_opening_stock_line (opening_id, material_type, yarn_id, fabric_id, trim_id, item_description, color_name, sizes, lot_no, roll_no,
                                           so_id, style_id, uom_id, qty, rate, amount, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [openingId, l.material_type, l.material_type === 'YARN' ? l.yarn_id : null, l.material_type === 'FABRIC' ? l.fabric_id : null,
       l.material_type === 'TRIM' ? l.trim_id : null, l.item_description, l.color_name, l.sizes, l.lot_no, l.roll_no,
       soId, styleId, l.uom_id, l.qty, l.rate, r4(l.qty * l.rate), l.remarks]);
  }
}

/** Posts every line of an opening stock document into stock. */
async function postOpening(tx: any, cid: number, userId: number, id: number) {
  const h = await txQueryOne<any>(tx, 'SELECT * FROM trx_opening_stock WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
  needStatus(h, ['DRAFT'], 'posted');
  const lines = await txQuery<any>(tx, 'SELECT * FROM trx_opening_stock_line WHERE opening_id = ? ORDER BY id', [id]);
  if (!lines.length) throw BadRequest('Add at least one item before posting');
  const date = String(h.doc_date).slice(0, 10);
  const ctx: MoveCtx = { cid, userId, tx, refType: 'OPENING_STOCK', refId: id, refNo: h.doc_no, date };
  let grnId: number | null = null;
  const grn = async () => {
    if (grnId) return grnId;
    if (!h.party_id) throw BadRequest('Select the party (supplier): yarn / fabric opening stock is kept as an opening GRN lot under that party');
    const r = await txExecute(tx,
      `INSERT INTO trx_grn (company_id, grn_no, grn_date, supplier_id, warehouse_id, qc_status, remarks, created_by) VALUES (?,?,?,?,?,'ACCEPTED',?,?)`,
      [cid, h.doc_no, date, h.party_id, h.warehouse_id, `Opening stock ${h.doc_no}`, userId]);
    grnId = r.insertId;
    return grnId;
  };
  let i = 0;
  for (const l of lines) {
    i += 1;
    const qty = n(l.qty); const rate = n(l.rate); const amt = r4(qty * rate);
    if (l.material_type === 'YARN' || l.material_type === 'FABRIC') {
      const g = await grn();
      let batchId: number | null = null;
      if (l.material_type === 'YARN') {
        const b = await txExecute(tx, `INSERT INTO mst_batch (company_id, batch_no, material_type, yarn_id, shade_lot, supplier_id, received_date, remarks) VALUES (?,?,?,?,?,?,?,?)`,
          [cid, `${h.doc_no}-${l.id}`, 'YARN', l.yarn_id, l.lot_no, h.party_id, date, `Opening stock ${h.doc_no}`]);
        batchId = b.insertId;
      }
      const lot = l.lot_no || `${h.doc_no}-${i}`;
      const gl = await txExecute(tx,
        `INSERT INTO trx_grn_line (grn_id, so_id, style_id, material_type, yarn_id, fabric_id, color_name, batch_id, lot_no, qc_status, balance_qty,
                                   rate, taxable_amount, total_amount, received_qty, accepted_qty, received_weight, no_of_rolls, uom_id)
         VALUES (?,?,?,?,?,?,?,?,?,'ACCEPTED',0,?,?,?,?,?,?,?,?)`,
        [g, l.so_id, l.style_id, l.material_type, l.yarn_id, l.fabric_id, l.color_name, batchId, lot, rate, amt, amt, qty, qty,
         l.uom_id === UOM_KG ? qty : null, l.material_type === 'FABRIC' ? 1 : null, l.uom_id]);
      let rollId: number | null = null;
      if (l.material_type === 'FABRIC') {
        const rr = await txExecute(tx,
          `INSERT INTO trx_fabric_roll (company_id, grn_id, grn_line_id, fabric_id, roll_no, lot_no, weight_kg, warehouse_id, qc_status, stock_status, color_name, so_id, remarks)
           VALUES (?,?,?,?,?,?,?,?,'ACCEPTED','AVAILABLE',?,?,?)`,
          [cid, g, gl.insertId, l.fabric_id, l.roll_no || `${h.doc_no}-R${i}`, l.lot_no, qty, h.warehouse_id, l.color_name, l.so_id, `Opening stock ${h.doc_no}`]);
        rollId = rr.insertId;
        await txExecute(tx,
          `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, qty_kg, so_id, remarks, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [cid, rollId, l.roll_no || `${h.doc_no}-R${i}`, 'OPENING_STOCK', 'OPENING_STOCK', id, h.doc_no, qty, l.so_id, 'Opening stock', userId]);
      }
      await postLedger(tx, { companyId: cid, warehouseId: h.warehouse_id, materialType: l.material_type, yarnId: l.yarn_id, fabricId: l.fabric_id, batchId,
        soId: l.so_id, txnType: 'ADJUST', refType: 'OPENING_STOCK', refId: id, qtyIn: qty, uomId: l.uom_id, rate, createdBy: userId });
      await txExecute(tx, 'UPDATE trx_opening_stock_line SET grn_line_id = ?, roll_id = ?, lot_no = ? WHERE id = ?', [gl.insertId, rollId, lot, l.id]);
    } else if (l.material_type === 'TRIM') {
      const lot = l.lot_no || h.doc_no;
      await txExecute(tx,
        `INSERT INTO trx_trim_stock (company_id, warehouse_id, trim_id, color_name, trim_size, internal_lot_no, stock_qty, uom_id, so_id, style_id, so_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE stock_qty = stock_qty + VALUES(stock_qty)`,
        [cid, h.warehouse_id, l.trim_id, l.color_name, l.sizes, lot, qty, l.uom_id, l.so_id, l.style_id, l.so_id || 0]);
      const ts = await txQueryOne<any>(tx, 'SELECT id FROM trx_trim_stock WHERE company_id = ? AND warehouse_id = ? AND trim_id = ? AND internal_lot_no = ? AND so_key = ?',
        [cid, h.warehouse_id, l.trim_id, lot, l.so_id || 0]);
      await postLedger(tx, { companyId: cid, warehouseId: h.warehouse_id, materialType: 'TRIM', trimId: l.trim_id, soId: l.so_id,
        txnType: 'ADJUST', refType: 'OPENING_STOCK', refId: id, qtyIn: qty, uomId: l.uom_id, rate, createdBy: userId });
      await txExecute(tx, 'UPDATE trx_opening_stock_line SET trim_stock_id = ?, lot_no = ? WHERE id = ?', [ts?.id ?? null, lot, l.id]);
    } else {
      await addGeneral(ctx, { warehouseId: h.warehouse_id, item: l.item_description, uomId: l.uom_id, soId: l.so_id, color: l.color_name, qty, rate });
    }
  }
  await txExecute(tx, `UPDATE trx_opening_stock SET status = 'POSTED', posted_by = ?, posted_at = NOW() WHERE id = ?`, [userId, id]);
}

openingAuditRouter.get('/opening-stock', VIEW, ah(async (req, res) => {
  const q = listQuery.parse(req.query);
  const w = listWhere(cidOf(req), q, 'doc_date', ['h.doc_no', 'p.party_name', 'h.remarks']);
  const rows = await query<any>(
    `SELECT h.*, p.party_name, w.warehouse_name, ${SO_COLS}, uc.full_name prepared_by,
            (SELECT COUNT(*) FROM trx_opening_stock_line l WHERE l.opening_id = h.id) line_count,
            (SELECT SUM(l.qty) FROM trx_opening_stock_line l WHERE l.opening_id = h.id) total_qty,
            (SELECT SUM(l.amount) FROM trx_opening_stock_line l WHERE l.opening_id = h.id) total_amount
       FROM trx_opening_stock h LEFT JOIN mst_party p ON p.id = h.party_id LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id
       ${soJoins('h.so_id')} LEFT JOIN mst_user uc ON uc.id = h.created_by
      WHERE ${w.where} ORDER BY h.doc_date DESC, h.id DESC LIMIT ${q.limit}`, w.params);
  res.json({ data: rows });
}));

openingAuditRouter.get('/opening-stock/:id', VIEW, ah(async (req, res) => {
  const d = await openingDoc(cidOf(req), idParam(req));
  if (!d) throw BadRequest('Opening stock not found');
  res.json({ data: d });
}));

openingAuditRouter.post('/opening-stock', CREATE, ah(async (req, res) => {
  const body = openingSchema.parse(req.body);
  const cid = cidOf(req);
  if (body.post_now && !can(req, 'INVENTORY.ADJUST')) throw BadRequest('You can save the draft; posting into stock needs the Adjust Stock permission');
  const id = await transaction(async (tx) => {
    const docNo = await nextDocNumber(tx, cid, 'OPENING_STOCK');
    const styleId = body.style_id ?? (await styleOfSo(body.so_id));
    const r = await txExecute(tx,
      `INSERT INTO trx_opening_stock (company_id, doc_no, doc_date, party_id, warehouse_id, process_name, so_id, style_id, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [cid, docNo, body.doc_date, body.party_id, body.warehouse_id, body.process_name, body.so_id, styleId, body.remarks, uidOf(req)]);
    await writeOpeningLines(tx, r.insertId, { ...body, style_id: styleId });
    if (body.post_now) await postOpening(tx, cid, uidOf(req), r.insertId);
    return r.insertId as number;
  });
  const d = await openingDoc(cid, id);
  await audit(req, 'trx_opening_stock', id, 'INSERT', undefined, d);
  res.status(201).json({ data: d, message: `${d.doc_no} ${body.post_now ? 'posted into stock' : 'saved as draft'}` });
}));

openingAuditRouter.put('/opening-stock/:id', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const body = openingSchema.parse(req.body);
  const before = await openingDoc(cid, id);
  if (!before) throw BadRequest('Opening stock not found');
  needStatus(before, ['DRAFT'], 'edited');
  await transaction(async (tx) => {
    const styleId = body.style_id ?? (await styleOfSo(body.so_id));
    await txExecute(tx, `UPDATE trx_opening_stock SET doc_date = ?, party_id = ?, warehouse_id = ?, process_name = ?, so_id = ?, style_id = ?, remarks = ? WHERE id = ? AND status = 'DRAFT'`,
      [body.doc_date, body.party_id, body.warehouse_id, body.process_name, body.so_id, styleId, body.remarks, id]);
    await writeOpeningLines(tx, id, { ...body, style_id: styleId });
  });
  const d = await openingDoc(cid, id);
  await audit(req, 'trx_opening_stock', id, 'UPDATE', before, d);
  res.json({ data: d, message: `${d.doc_no} saved` });
}));

openingAuditRouter.post('/opening-stock/:id/post', POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  await mustGet('trx_opening_stock', cid, id, 'Opening stock');
  await transaction((tx) => postOpening(tx, cid, uidOf(req), id));
  const d = await openingDoc(cid, id);
  await audit(req, 'trx_opening_stock', id, 'UPDATE', { status: 'DRAFT' }, { status: 'POSTED' });
  res.json({ data: d, message: `${d.doc_no} posted into stock` });
}));

openingAuditRouter.post('/opening-stock/:id/cancel', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const h = await mustGet<any>('trx_opening_stock', cid, id, 'Opening stock');
  if (h.status === 'POSTED') throw BadRequest(`${h.doc_no} is posted into stock and cannot be cancelled — correct the stock with a Stock Audit`);
  needStatus(h, ['DRAFT'], 'cancelled');
  await query(`UPDATE trx_opening_stock SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`, [reason, uidOf(req), id]);
  await audit(req, 'trx_opening_stock', id, 'UPDATE', { status: h.status }, { status: 'CANCELLED', reason });
  res.json({ data: await openingDoc(cid, id), message: `${h.doc_no} cancelled` });
}));

// ================================================================== STOCK AUDIT
const auditLine = z.object({
  source_ref: z.string().trim().max(255).nullish(),
  /** General item counted that is not in the system yet. */
  item_description: strOpt(255), uom_id: idOpt, so_id: idOpt,
  physical_qty: z.coerce.number().min(0), process_name: strOpt(80), remarks: strOpt(255),
});
const auditSchema = z.object({
  doc_date: dateStr.default(todayStr), audit_type: z.enum(MATS), warehouse_id: z.coerce.number().int().positive(),
  remarks: strOpt(500), lines: z.array(auditLine).min(1, 'Add at least one counted item'),
  submit: z.coerce.boolean().default(false),
});

async function auditDoc(cid: number, id: number) {
  const h = await queryOne<any>(
    `SELECT h.*, w.warehouse_name, uc.full_name prepared_by, ua.full_name approved_by_name, us.full_name submitted_by_name
       FROM trx_stock_audit h LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id LEFT JOIN mst_user uc ON uc.id = h.created_by
       LEFT JOIN mst_user ua ON ua.id = h.approved_by LEFT JOIN mst_user us ON us.id = h.submitted_by
      WHERE h.id = ? AND h.company_id = ?`, [id, cid]);
  if (!h) return null;
  h.lines = await query<any>(
    `SELECT l.*, ${ITEM_NAME} item_name, u.code uom_code, COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, st.style_code
       FROM trx_stock_audit_line l ${ITEM_JOINS} LEFT JOIN trx_sales_order so ON so.id = l.so_id LEFT JOIN mst_style st ON st.id = l.style_id
      WHERE l.audit_id = ? ORDER BY l.id`, [id]);
  return h;
}

/** Resolves each counted line against current stock (ERP qty, item, lot, GRN, rate). */
async function resolveAuditLines(cid: number, body: z.infer<typeof auditSchema>) {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const l of body.lines) {
    let ref = l.source_ref ?? null;
    if (!ref) {
      if (body.audit_type !== 'GENERAL' || !l.item_description || !l.uom_id) throw BadRequest('Pick each counted item from the stock list (only a general item can be typed in)');
      ref = `G:${body.warehouse_id}|${l.so_id || 0}|${l.uom_id}|${l.item_description.trim()}`;
    }
    if (seen.has(ref)) throw BadRequest('The same stock item is counted twice — keep one line per lot / roll / item');
    seen.add(ref);
    const kind = { Y: 'YARN', F: 'FABRIC', T: 'TRIM', G: 'GENERAL' }[ref[0]] as Mat | undefined;
    if (kind !== body.audit_type) throw BadRequest(`Line ${ref}: not a ${body.audit_type.toLowerCase()} item`);
    const s = await stockOf(cid, ref);
    if (!s && kind !== 'GENERAL') throw BadRequest(`Stock item ${ref} not found`);
    if (s && s.warehouse_id !== body.warehouse_id) throw BadRequest(`${s.item_name}${s.lot_no ? ` (${s.lot_no})` : ''} is in another location`);
    const sys = s?.stock_qty ?? 0;
    const rate = s?.rate ?? 0;
    const diff = r4(l.physical_qty - sys);
    out.push({ ref, mt: kind, yarn_id: s?.yarn_id ?? null, fabric_id: s?.fabric_id ?? null, trim_id: s?.trim_id ?? null,
      item_description: kind === 'GENERAL' ? (s?.item_name ?? l.item_description) : null, color_name: s?.color_name ?? null,
      lot_no: s?.lot_no ?? null, grn_no: s?.grn_no ?? null, so_id: s?.so_id ?? l.so_id ?? null, style_id: s?.style_id ?? null,
      uom_id: s?.uom_id ?? l.uom_id, sys, phys: l.physical_qty, diff, rate, amount: r4(diff * rate), process_name: l.process_name, remarks: l.remarks });
  }
  return out;
}

async function writeAuditLines(tx: any, auditId: number, lines: any[]) {
  await txExecute(tx, 'DELETE FROM trx_stock_audit_line WHERE audit_id = ?', [auditId]);   // unapproved lines only
  for (const l of lines) {
    await txExecute(tx,
      `INSERT INTO trx_stock_audit_line (audit_id, material_type, source_ref, yarn_id, fabric_id, trim_id, item_description, color_name, lot_no, grn_no, process_name,
                                         so_id, style_id, uom_id, system_qty, physical_qty, diff_qty, rate, amount, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [auditId, l.mt, l.ref, l.yarn_id, l.fabric_id, l.trim_id, l.item_description, l.color_name, l.lot_no, l.grn_no, l.process_name,
       l.so_id, l.style_id, l.uom_id, l.sys, l.phys, l.diff, l.rate, l.amount, l.remarks]);
  }
}

openingAuditRouter.get('/stock-audit', VIEW, ah(async (req, res) => {
  const q = listQuery.parse(req.query);
  const w = listWhere(cidOf(req), q, 'doc_date', ['h.doc_no', 'h.remarks']);
  const rows = await query<any>(
    `SELECT h.*, w.warehouse_name, uc.full_name prepared_by,
            (SELECT COUNT(*) FROM trx_stock_audit_line l WHERE l.audit_id = h.id) line_count,
            (SELECT COUNT(*) FROM trx_stock_audit_line l WHERE l.audit_id = h.id AND ABS(l.diff_qty) > 0.0005) diff_lines,
            (SELECT SUM(l.amount) FROM trx_stock_audit_line l WHERE l.audit_id = h.id) diff_amount
       FROM trx_stock_audit h LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id LEFT JOIN mst_user uc ON uc.id = h.created_by
      WHERE ${w.where} ORDER BY h.doc_date DESC, h.id DESC LIMIT ${q.limit}`, w.params);
  res.json({ data: rows });
}));

openingAuditRouter.get('/stock-audit/:id', VIEW, ah(async (req, res) => {
  const d = await auditDoc(cidOf(req), idParam(req));
  if (!d) throw BadRequest('Stock audit not found');
  res.json({ data: d });
}));

openingAuditRouter.post('/stock-audit', CREATE, ah(async (req, res) => {
  const cid = cidOf(req);
  const body = auditSchema.parse(req.body);
  const lines = await resolveAuditLines(cid, body);
  const id = await transaction(async (tx) => {
    const docNo = await nextDocNumber(tx, cid, 'STOCK_AUDIT');
    const r = await txExecute(tx,
      `INSERT INTO trx_stock_audit (company_id, doc_no, doc_date, audit_type, warehouse_id, remarks, status, submitted_by, submitted_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,${body.submit ? 'NOW()' : 'NULL'},?)`,
      [cid, docNo, body.doc_date, body.audit_type, body.warehouse_id, body.remarks, body.submit ? 'SUBMITTED' : 'DRAFT', body.submit ? uidOf(req) : null, uidOf(req)]);
    await writeAuditLines(tx, r.insertId, lines);
    return r.insertId as number;
  });
  const d = await auditDoc(cid, id);
  await audit(req, 'trx_stock_audit', id, 'INSERT', undefined, d);
  res.status(201).json({ data: d, message: `${d.doc_no} ${body.submit ? 'submitted for approval' : 'saved as draft'}` });
}));

openingAuditRouter.put('/stock-audit/:id', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const body = auditSchema.parse(req.body);
  const before = await auditDoc(cid, id);
  if (!before) throw BadRequest('Stock audit not found');
  needStatus(before, ['DRAFT', 'REJECTED'], 'edited');
  const lines = await resolveAuditLines(cid, body);
  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_stock_audit SET doc_date = ?, audit_type = ?, warehouse_id = ?, remarks = ?, status = ?, submitted_by = ?, submitted_at = ${body.submit ? 'NOW()' : 'NULL'} WHERE id = ?`,
      [body.doc_date, body.audit_type, body.warehouse_id, body.remarks, body.submit ? 'SUBMITTED' : 'DRAFT', body.submit ? uidOf(req) : null, id]);
    await writeAuditLines(tx, id, lines);
  });
  const d = await auditDoc(cid, id);
  await audit(req, 'trx_stock_audit', id, 'UPDATE', before, d);
  res.json({ data: d, message: `${d.doc_no} ${body.submit ? 'submitted for approval' : 'saved'}` });
}));

openingAuditRouter.post('/stock-audit/:id/submit', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const h = await mustGet<any>('trx_stock_audit', cid, id, 'Stock audit');
  needStatus(h, ['DRAFT', 'REJECTED'], 'submitted');
  await query(`UPDATE trx_stock_audit SET status = 'SUBMITTED', submitted_by = ?, submitted_at = NOW() WHERE id = ?`, [uidOf(req), id]);
  await audit(req, 'trx_stock_audit', id, 'UPDATE', { status: h.status }, { status: 'SUBMITTED' });
  res.json({ data: await auditDoc(cid, id), message: `${h.doc_no} submitted for approval` });
}));

/** Approval re-reads the ERP stock (it may have moved since the count) and posts physical − ERP per line. */
openingAuditRouter.post('/stock-audit/:id/approve', POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const h = await mustGet<any>('trx_stock_audit', cid, id, 'Stock audit');
  needStatus(h, ['SUBMITTED'], 'approved');
  let posted = 0;
  await transaction(async (tx) => {
    const lock = await txQueryOne<any>(tx, 'SELECT status FROM trx_stock_audit WHERE id = ? FOR UPDATE', [id]);
    needStatus({ ...lock, doc_no: h.doc_no }, ['SUBMITTED'], 'approved');
    const lines = await txQuery<any>(tx, 'SELECT * FROM trx_stock_audit_line WHERE audit_id = ? ORDER BY id', [id]);
    const ctx: MoveCtx = { cid, userId: uidOf(req), tx, refType: 'STOCK_AUDIT', refId: id, refNo: h.doc_no, date: todayStr() };
    for (const l of lines) {
      const s = await stockOf(cid, l.source_ref);
      const sys = s?.stock_qty ?? 0;
      const diff = r4(n(l.physical_qty) - sys);
      const rate = s?.rate ?? n(l.rate);
      await txExecute(tx, 'UPDATE trx_stock_audit_line SET system_qty = ?, diff_qty = ?, rate = ?, amount = ? WHERE id = ?', [sys, diff, rate, r4(diff * rate), l.id]);
      if (Math.abs(diff) <= 0.0005) continue;
      if (!s) {
        // a general item found that the system did not have
        await addGeneral(ctx, { warehouseId: h.warehouse_id, item: l.item_description, uomId: l.uom_id, soId: l.so_id, qty: diff, rate });
      } else {
        await moveStock(ctx, l.source_ref, diff, { txnType: 'ADJUST', label: 'STOCK_AUDIT', rate });
      }
      posted += 1;
    }
    await txExecute(tx, `UPDATE trx_stock_audit SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [uidOf(req), id]);
  });
  await audit(req, 'trx_stock_audit', id, 'UPDATE', { status: 'SUBMITTED' }, { status: 'APPROVED', posted_lines: posted });
  res.json({ data: await auditDoc(cid, id), message: `${h.doc_no} approved — ${posted} difference${posted === 1 ? '' : 's'} posted to stock` });
}));

openingAuditRouter.post('/stock-audit/:id/reject', POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const h = await mustGet<any>('trx_stock_audit', cid, id, 'Stock audit');
  needStatus(h, ['SUBMITTED'], 'rejected');
  await query(`UPDATE trx_stock_audit SET status = 'REJECTED', cancel_reason = ? WHERE id = ?`, [reason, id]);
  await audit(req, 'trx_stock_audit', id, 'UPDATE', { status: h.status }, { status: 'REJECTED', reason });
  res.json({ data: await auditDoc(cid, id), message: `${h.doc_no} sent back for recount` });
}));

openingAuditRouter.post('/stock-audit/:id/cancel', CREATE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const h = await mustGet<any>('trx_stock_audit', cid, id, 'Stock audit');
  needStatus(h, ['DRAFT', 'SUBMITTED', 'REJECTED'], 'cancelled');
  await query(`UPDATE trx_stock_audit SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`, [reason, uidOf(req), id]);
  await audit(req, 'trx_stock_audit', id, 'UPDATE', { status: h.status }, { status: 'CANCELLED', reason });
  res.json({ data: await auditDoc(cid, id), message: `${h.doc_no} cancelled` });
}));

// ================================================================== REPORTS
openingAuditRouter.get('/reports/opening-stock', requireAny('INVENTORY.VIEW', 'REPORT.VIEW'), ah(async (req, res) => {
  const q = listQuery.parse(req.query);
  const w = listWhere(cidOf(req), { ...q, status: q.status ?? 'POSTED' }, 'doc_date', ['h.doc_no', 'p.party_name']);
  const rows = await query<any>(
    `SELECT h.doc_no, h.doc_date, p.party_name, w.warehouse_name location, h.process_name, ${SO_COLS}, st.style_code style_no,
            ${ITEM_NAME} item_name, ${ITEM_TYPE} item_type, l.color_name, l.sizes, l.item_description description, l.lot_no, u.code uom,
            l.qty, l.rate, l.amount, uc.full_name prepared_by, COALESCE(l.remarks, h.remarks) remarks, l.material_type, h.status
       FROM trx_opening_stock h JOIN trx_opening_stock_line l ON l.opening_id = h.id
       LEFT JOIN mst_party p ON p.id = h.party_id LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id
       ${soJoins('COALESCE(l.so_id, h.so_id)')} LEFT JOIN mst_style st ON st.id = COALESCE(l.style_id, h.style_id)
       ${ITEM_JOINS} LEFT JOIN mst_user uc ON uc.id = h.created_by
      WHERE ${w.where} ORDER BY h.doc_date, h.id, l.id LIMIT 5000`, w.params);
  res.json({ data: rows });
}));

openingAuditRouter.get('/reports/stock-audit', requireAny('INVENTORY.VIEW', 'REPORT.VIEW'), ah(async (req, res) => {
  const q = listQuery.parse(req.query);
  const w = listWhere(cidOf(req), q, 'doc_date', ['h.doc_no']);
  const rows = await query<any>(
    `SELECT h.audit_type type, h.doc_no, h.doc_date, w.warehouse_name location, COALESCE(NULLIF(so.io_no, ''), so.so_no) so_no, st.style_code style,
            l.grn_no, l.process_name, ${ITEM_NAME} item_name, l.lot_no, l.color_name, u.code uom, l.system_qty, l.physical_qty, l.diff_qty,
            l.rate, l.amount, COALESCE(l.remarks, h.remarks) remarks, uc.full_name prepared_by, h.status
       FROM trx_stock_audit h JOIN trx_stock_audit_line l ON l.audit_id = h.id
       LEFT JOIN mst_warehouse w ON w.id = h.warehouse_id LEFT JOIN trx_sales_order so ON so.id = l.so_id LEFT JOIN mst_style st ON st.id = l.style_id
       ${ITEM_JOINS} LEFT JOIN mst_user uc ON uc.id = h.created_by
      WHERE ${w.where} AND h.status <> 'CANCELLED' ORDER BY h.doc_date, h.id, l.id LIMIT 5000`, w.params);
  res.json({ data: rows });
}));
