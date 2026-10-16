import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { lockBundle, availAt, packingRequiresQc, TERMINAL } from '../production/bundleLedger.js';
import { fgMode } from '../production/fgReceipt.routes.js';
import {
  OPEN_ORDER, WORKING_ORDER, EDITABLE_CARTON, key, assertApprove, canApprove, resolveRule, ruleOf, expectedCartons, stdPolybags,
  loadOrder, lockJob, eligibility, jobKeyOf, openBagged, recalcOrder, cartonEvent, assertPackagingTrim, validateCarton,
  cartonLines, assertNotDownstream, lockCarton, orderVariance, postCarton, reverseCarton, jobBundles, setting,
} from './packingEngineCore.js';
import { packingReportsRouter } from './packingEngineReports.js';

/**
 * Packing engine API (doc §14), mounted at /api/packing:
 *   rules · orders (+ eligibility, approve, cancel, complete, post, reconciliation) · polybag entries
 *   cartons (create / edit / verify / seal / reopen / void / post / reverse / label / scan) · reports
 */
export const packingEngineRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const str = (max: number) => z.union([z.string().trim().max(max), z.literal(''), z.null()]).optional().transform((v) => (v ? v : null));
const idOpt = () => z.coerce.number().int().positive().nullish();
const bool = () => z.union([z.boolean(), z.coerce.number()]).optional().transform((v) => (v ? 1 : 0));
const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300) });

// ═══════════════════════════════════════════════════════════════ meta

packingEngineRouter.get('/meta', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const trims = await query(
    `SELECT t.id, t.trim_code, t.trim_name, t.trim_type, t.specification, u.code uom,
            COALESCE((SELECT SUM(ts.stock_qty - ts.allocated_qty) FROM trx_trim_stock ts WHERE ts.trim_id = t.id AND ts.company_id = t.company_id),0) AS stock_qty
       FROM mst_trim t LEFT JOIN cfg_uom u ON u.id = t.base_uom
      WHERE t.company_id = ? AND t.trim_type IN ('POLYBAG','CARTON') AND t.is_active = 1 AND t.is_deleted = 0
      ORDER BY t.trim_type, t.trim_name`, [cid]);
  const settings = await query<any>(
    `SELECT setting_key, setting_value FROM cfg_system_setting WHERE company_id = ?
        AND setting_key IN ('PACKING_ALLOW_NEGATIVE_PACKAGING','PACKING_VARIANCE_TOLERANCE_PCT','PACKING_REQUIRES_FINAL_QC')`, [cid]);
  res.json({ data: { trims, settings: Object.fromEntries(settings.map((s) => [s.setting_key, s.setting_value])), can_approve: canApprove(req) } });
}));

// ═══════════════════════════════════════════════════════════════ rules (§4)

const ruleSchema = z.object({
  rule_name: z.string().trim().min(2, 'Rule name is required').max(150),
  buyer_id: idOpt(), style_id: idOpt(), so_id: idOpt(),
  packing_mode: z.enum(['BUNDLE_QUANTITY', 'INDIVIDUAL_PIECE']).default('BUNDLE_QUANTITY'),
  pieces_per_polybag: z.coerce.number().int().min(1, 'Pieces per polybag must be at least 1').max(1000).default(1),
  polybag_trim_id: idOpt(), carton_trim_id: idOpt(),
  standard_pieces_per_carton: z.coerce.number().int().min(1, 'Pieces per carton must be at least 1').max(100000),
  allow_mixed_sizes: bool(), allow_mixed_colours: bool(), allow_partial_carton: bool(), allow_overpack: bool(),
  label_template: str(60), effective_from: str(10), effective_to: str(10), is_active: z.union([z.boolean(), z.coerce.number()]).optional(),
  remarks: str(300),
});

const RULE_SELECT = `SELECT r.*, b.party_name buyer_name, st.style_code, COALESCE(NULLIF(so.io_no,''), so.so_no) job_no, so.buyer_po_no,
       pt.trim_name polybag_trim_name, ct.trim_name carton_trim_name,
       (SELECT COUNT(*) FROM trx_packing p WHERE p.packing_rule_id = r.id) used_by
  FROM mst_packing_rule r
  LEFT JOIN mst_party b ON b.id = r.buyer_id LEFT JOIN mst_style st ON st.id = r.style_id
  LEFT JOIN trx_sales_order so ON so.id = r.so_id
  LEFT JOIN mst_trim pt ON pt.id = r.polybag_trim_id LEFT JOIN mst_trim ct ON ct.id = r.carton_trim_id`;

packingEngineRouter.get('/rules', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const active = req.query.active === '1' ? 'AND r.is_active = 1' : '';
  const rows = await query(`${RULE_SELECT} WHERE r.company_id = ? ${active}
     ORDER BY r.is_active DESC, (r.so_id IS NULL), (r.style_id IS NULL), (r.buyer_id IS NULL), r.rule_code`, [cid]);
  res.json({ data: rows });
}));

packingEngineRouter.get('/rules/resolve', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = Number(req.query.so_id); const styleId = Number(req.query.style_id) || null;
  const so = await queryOne<any>(`SELECT buyer_id FROM trx_sales_order WHERE id = ? AND company_id = ?`, [soId, cid]);
  if (!so) throw NotFound('Job not found');
  const rule = await transaction((tx) => resolveRule(tx, cid, soId, styleId, so.buyer_id));
  res.json({ data: rule });
}));

async function checkRuleRefs(tx: any, cid: number, b: z.infer<typeof ruleSchema>) {
  await assertPackagingTrim(tx, cid, b.polybag_trim_id, 'POLYBAG');
  await assertPackagingTrim(tx, cid, b.carton_trim_id, 'CARTON');
  if (b.effective_from && b.effective_to && b.effective_to < b.effective_from) throw BadRequest('Effective to is before effective from');
  if (b.so_id) {
    const so = await txQueryOne<any>(tx, `SELECT buyer_id FROM trx_sales_order WHERE id = ? AND company_id = ?`, [b.so_id, cid]);
    if (!so) throw BadRequest('Job / PO not found');
    if (b.buyer_id && Number(so.buyer_id) !== Number(b.buyer_id)) throw BadRequest('That PO belongs to a different buyer');
  }
}

packingEngineRouter.post('/rules', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = ruleSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    await checkRuleRefs(tx, cid, b);
    const code = await nextDocNumber(tx, cid, 'PACKING_RULE');
    const r = await txExecute(tx,
      `INSERT INTO mst_packing_rule (company_id, rule_code, rule_name, buyer_id, style_id, so_id, packing_mode, pieces_per_polybag, polybag_trim_id, carton_trim_id,
         standard_pieces_per_carton, allow_mixed_sizes, allow_mixed_colours, allow_partial_carton, allow_overpack, label_template, effective_from, effective_to,
         is_active, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, code, b.rule_name, b.buyer_id ?? null, b.style_id ?? null, b.so_id ?? null, b.packing_mode, b.pieces_per_polybag, b.polybag_trim_id ?? null,
       b.carton_trim_id ?? null, b.standard_pieces_per_carton, b.allow_mixed_sizes, b.allow_mixed_colours, b.allow_partial_carton, b.allow_overpack,
       b.label_template, b.effective_from, b.effective_to, b.is_active === undefined ? 1 : (b.is_active ? 1 : 0), b.remarks, req.user!.id]);
    const row = await txQueryOne(tx, `${RULE_SELECT} WHERE r.id = ?`, [r.insertId]);
    await audit(req, 'mst_packing_rule', r.insertId, 'INSERT', undefined, row, tx);
    return row;
  });
  res.status(201).json({ data: out });
}));

packingEngineRouter.put('/rules/:id', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = ruleSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const before = await txQueryOne<any>(tx, `SELECT * FROM mst_packing_rule WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!before) throw NotFound('Packing rule not found');
    await checkRuleRefs(tx, cid, b);
    // orders keep their snapshot; a change makes a new revision
    await txExecute(tx,
      `UPDATE mst_packing_rule SET rule_name=?, buyer_id=?, style_id=?, so_id=?, packing_mode=?, pieces_per_polybag=?, polybag_trim_id=?, carton_trim_id=?,
         standard_pieces_per_carton=?, allow_mixed_sizes=?, allow_mixed_colours=?, allow_partial_carton=?, allow_overpack=?, label_template=?, effective_from=?,
         effective_to=?, is_active=?, remarks=?, revision = revision + 1, updated_by=? WHERE id = ?`,
      [b.rule_name, b.buyer_id ?? null, b.style_id ?? null, b.so_id ?? null, b.packing_mode, b.pieces_per_polybag, b.polybag_trim_id ?? null, b.carton_trim_id ?? null,
       b.standard_pieces_per_carton, b.allow_mixed_sizes, b.allow_mixed_colours, b.allow_partial_carton, b.allow_overpack, b.label_template, b.effective_from,
       b.effective_to, b.is_active === undefined ? before.is_active : (b.is_active ? 1 : 0), b.remarks, req.user!.id, id]);
    const row = await txQueryOne(tx, `${RULE_SELECT} WHERE r.id = ?`, [id]);
    await audit(req, 'mst_packing_rule', id, 'UPDATE', before, row, tx);
    return row;
  });
  res.json({ data: out });
}));

packingEngineRouter.post('/rules/:id/active', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { is_active } = z.object({ is_active: z.union([z.boolean(), z.coerce.number()]) }).parse(req.body);
  const r = await queryOne<any>(`SELECT is_active FROM mst_packing_rule WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!r) throw NotFound('Packing rule not found');
  await query(`UPDATE mst_packing_rule SET is_active = ?, updated_by = ? WHERE id = ?`, [is_active ? 1 : 0, req.user!.id, id]);
  await audit(req, 'mst_packing_rule', id, 'UPDATE', { is_active: r.is_active }, { is_active: is_active ? 1 : 0 });
  res.json({ data: { id, is_active: is_active ? 1 : 0 } });
}));

/** Only a rule no packing order ever used may be deleted; a used rule is deactivated instead. */
packingEngineRouter.delete('/rules/:id', requirePermission('PACKING.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const r = await queryOne<any>(`SELECT * FROM mst_packing_rule WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!r) throw NotFound('Packing rule not found');
  const used = await queryOne<any>(`SELECT pack_no FROM trx_packing WHERE packing_rule_id = ? LIMIT 1`, [id]);
  if (used) throw BadRequest(`Rule ${r.rule_code} is used by packing order ${used.pack_no} — deactivate it instead of deleting`);
  await query(`DELETE FROM mst_packing_rule WHERE id = ?`, [id]);
  await audit(req, 'mst_packing_rule', id, 'DELETE', r, undefined);
  res.json({ data: { id, deleted: true } });
}));

// ═══════════════════════════════════════════════════════════════ orders (§5)

const ORDER_SELECT = `SELECT p.*, so.so_no, COALESCE(NULLIF(so.io_no,''), so.so_no) job_no, so.buyer_po_no, so.order_qty so_order_qty,
       b.party_name buyer_name, st.style_code, st.style_name, w.warehouse_name, u.full_name approved_by_name,
       (SELECT COUNT(*) FROM trx_carton c WHERE c.packing_id = p.id AND c.carton_status <> 'VOID') cartons_total,
       (SELECT COUNT(*) FROM trx_carton c WHERE c.packing_id = p.id AND c.carton_status <> 'VOID' AND c.is_posted = 1) cartons_posted,
       CAST((SELECT COALESCE(SUM(c.pieces_total),0) FROM trx_carton c WHERE c.packing_id = p.id AND c.carton_status <> 'VOID' AND c.is_posted = 1) AS SIGNED) pieces_posted,
       CAST((SELECT COALESCE(SUM(c.pieces_total),0) FROM trx_carton c WHERE c.packing_id = p.id AND c.carton_status <> 'VOID' AND c.is_posted = 0) AS SIGNED) pieces_unposted
  FROM trx_packing p
  JOIN trx_sales_order so ON so.id = p.so_id
  LEFT JOIN mst_party b ON b.id = COALESCE(p.buyer_id, so.buyer_id)
  LEFT JOIN mst_style st ON st.id = p.style_id
  LEFT JOIN mst_warehouse w ON w.id = p.warehouse_id
  LEFT JOIN mst_user u ON u.id = p.approved_by`;

const orderSelect = async () => ORDER_SELECT;

packingEngineRouter.get('/orders', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where: string[] = ['p.company_id = ?', 'p.is_engine = 1']; const args: unknown[] = [cid];
  if (req.query.status) { where.push('p.order_status = ?'); args.push(String(req.query.status)); }
  if (req.query.so_id) { where.push('p.so_id = ?'); args.push(Number(req.query.so_id)); }
  if (req.query.open === '1') where.push(`p.order_status IN ('APPROVED','IN_PROGRESS')`);
  if (req.query.q) {
    where.push('(p.pack_no LIKE ? OR p.io_no LIKE ? OR so.so_no LIKE ? OR so.buyer_po_no LIKE ? OR st.style_code LIKE ?)');
    const q = `%${String(req.query.q)}%`; args.push(q, q, q, q, q);
  }
  const rows = await query(`${await orderSelect()} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 500`, args);
  res.json({ data: rows });
}));

/** Preview for a new order: rule + colour × size eligibility of a job / style. */
packingEngineRouter.get('/eligibility', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = Number(req.query.so_id); const styleId = Number(req.query.style_id);
  if (!soId || !styleId) throw BadRequest('Pick the job and style');
  const so = await queryOne<any>(`SELECT id, buyer_id, COALESCE(NULLIF(io_no,''), so_no) job_no FROM trx_sales_order WHERE id = ? AND company_id = ?`, [soId, cid]);
  if (!so) throw NotFound('Job not found');
  const part = req.query.part_name ? String(req.query.part_name) : null;
  const out = await transaction(async (tx) => {
    const rule = await resolveRule(tx, cid, soId, styleId, so.buyer_id);
    const rows = await eligibility(tx, { cid, io_no: so.job_no, style_id: styleId, part_name: part }, soId, null);
    return { rule, rows, strict_qc: await packingRequiresQc(tx, cid) };
  });
  res.json({ data: out });
}));

const orderLineSchema = z.object({ color_id: z.coerce.number().int().positive(), size_id: z.coerce.number().int().positive(), planned_qty: z.coerce.number().int().min(0) });
const orderSchema = z.object({
  so_id: z.coerce.number().int().positive('Pick the job'),
  style_id: z.coerce.number().int().positive('Pick the style'),
  part_name: str(50),
  packing_rule_id: idOpt(),
  packing_mode: z.enum(['BUNDLE_QUANTITY', 'INDIVIDUAL_PIECE']).nullish(),
  pack_date: str(10), target_date: str(10), warehouse_id: idOpt(), remarks: str(500),
  lines: z.array(orderLineSchema).optional(),
});

/** Validate planned lines against eligibility (planned never above eligible) and write them. */
async function writeOrderLines(tx: any, order: any, lines: z.infer<typeof orderLineSchema>[] | undefined, rule: any) {
  const elig = await eligibility(tx, jobKeyOf(order), Number(order.so_id), order.id);
  const plan = lines ?? elig.filter((e) => e.eligible > 0).map((e) => ({ color_id: e.color_id, size_id: e.size_id, planned_qty: e.eligible }));
  const seen = new Set<string>();
  for (const l of plan) {
    const k = key(l.color_id, l.size_id);
    if (seen.has(k)) throw BadRequest('A colour / size is listed twice');
    seen.add(k);
    const e = elig.find((x) => key(x.color_id, x.size_id) === k);
    const label = e ? `${e.color_name} / ${e.size_code}` : `colour #${l.color_id} / size #${l.size_id}`;
    const floor = (e?.posted ?? 0) + (e?.draft ?? 0);
    if (l.planned_qty < floor) throw BadRequest(`${label}: ${floor} pcs are already in cartons — the plan cannot go below that`);
    if (l.planned_qty > (e?.eligible ?? 0) + (e?.posted ?? 0)) {
      throw BadRequest(`${label}: planned ${l.planned_qty} pcs is more than the eligible ${(e?.eligible ?? 0) + (e?.posted ?? 0)}`
        + (e?.awaiting_fg !== undefined
          ? ` (in the FG store, not held by other orders)${e.awaiting_fg ? ` — ${e.awaiting_fg} finished PCS are waiting for an FG receipt` : ''}`
          : ' (QC-accepted, ready to pack, not held by other orders)'));
    }
  }
  const keep = plan.filter((l) => l.planned_qty > 0 || elig.find((e) => key(e.color_id, e.size_id) === key(l.color_id, l.size_id) && (e.posted || e.draft)));
  if (!keep.length) {
    throw BadRequest(elig.some((x) => x.awaiting_fg !== undefined)
      ? 'Nothing to pack: no PCS of this job / style are in the FG store — receive the finished PCS on an FG Receipt first'
      : 'Nothing to pack: no colour / size has eligible (finished, QC-accepted, unreserved) pieces for this job and style');
  }
  await txExecute(tx, `DELETE FROM trx_packing_order_line WHERE packing_id = ?`, [order.id]);
  for (const l of keep) {
    const e = elig.find((x) => key(x.color_id, x.size_id) === key(l.color_id, l.size_id));
    await txExecute(tx,
      `INSERT INTO trx_packing_order_line (packing_id, color_id, size_id, sku_id, order_qty, eligible_at_create, planned_qty) VALUES (?,?,?,?,?,?,?)`,
      [order.id, l.color_id, l.size_id, e?.sku_id ?? null, e?.order_qty ?? 0, e?.eligible ?? 0, l.planned_qty]);
  }
  const plannedQty = keep.reduce((a, l) => a + l.planned_qty, 0);
  const bags = keep.reduce((a, l) => a + stdPolybags(l.planned_qty, rule), 0);
  const ctns = expectedCartons(keep.map((l) => ({ color_id: l.color_id, size_id: l.size_id, qty: l.planned_qty })), rule);
  await txExecute(tx, `UPDATE trx_packing SET planned_qty = ?, planned_polybags = ?, planned_cartons = ?, updated_at = NOW() WHERE id = ?`, [plannedQty, bags, ctns, order.id]);
}

packingEngineRouter.post('/orders', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = orderSchema.parse(req.body);
  const id = await transaction(async (tx) => {
    const so = await txQueryOne<any>(tx, `SELECT id, buyer_id, COALESCE(NULLIF(io_no,''), so_no) job_no FROM trx_sales_order WHERE id = ? AND company_id = ? FOR UPDATE`, [b.so_id, cid]);
    if (!so) throw BadRequest('Job not found');
    const st = await txQueryOne<any>(tx, `SELECT id FROM mst_style WHERE id = ? AND company_id = ?`, [b.style_id, cid]);
    if (!st) throw BadRequest('Style not found');
    let rule: any;
    if (b.packing_rule_id) {
      rule = await txQueryOne<any>(tx, `SELECT * FROM mst_packing_rule WHERE id = ? AND company_id = ? AND is_active = 1`, [b.packing_rule_id, cid]);
      if (!rule) throw BadRequest('That packing rule is not active');
      rule.scope = 'Chosen';
    } else {
      rule = await resolveRule(tx, cid, b.so_id, b.style_id, so.buyer_id);
      if (!rule) throw BadRequest('No active packing rule applies to this job — add one in Packing Rules (a company default rule with no buyer / style / PO is enough)');
    }
    const mode = b.packing_mode ?? rule.packing_mode;
    const no = await nextDocNumber(tx, cid, 'PACKING_ORDER');
    const r = await txExecute(tx,
      `INSERT INTO trx_packing (company_id, pack_no, io_no, style_id, pack_date, so_id, part_name, pack_method, packing_mode, order_status, is_engine,
         buyer_id, packing_rule_id, rule_revision, rule_snapshot, warehouse_id, target_date, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?, 'DRAFT', 1, ?,?,?,?,?,?,?,?)`,
      [cid, no, so.job_no, b.style_id, b.pack_date ?? new Date().toISOString().slice(0, 10), b.so_id, b.part_name,
       rule.allow_mixed_colours ? 'ASSORTED_COLOR_ASSORTED_SIZE' : rule.allow_mixed_sizes ? 'SOLID_COLOR_ASSORTED_SIZE' : 'SOLID_COLOR_SOLID_SIZE',
       mode, so.buyer_id, rule.id, rule.revision, JSON.stringify(rule), b.warehouse_id ?? null, b.target_date, b.remarks, req.user!.id]);
    const order = await txQueryOne<any>(tx, `SELECT * FROM trx_packing WHERE id = ?`, [r.insertId]);
    await writeOrderLines(tx, order, b.lines, rule);
    await audit(req, 'trx_packing', r.insertId, 'INSERT', undefined, { pack_no: no, rule: rule.rule_code, rule_revision: rule.revision, lines: b.lines ?? 'eligible' }, tx);
    return r.insertId;
  });
  res.status(201).json({ data: await orderDetail(cid, id) });
}));

packingEngineRouter.put('/orders/:id', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ target_date: str(10), warehouse_id: idOpt(), remarks: str(500), lines: z.array(orderLineSchema).optional() }).parse(req.body);
  await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id, true);
    if (!OPEN_ORDER.includes(o.order_status)) throw BadRequest(`Packing order is ${o.order_status}`);
    await lockJob(tx, Number(o.so_id));
    await txExecute(tx, `UPDATE trx_packing SET target_date = ?, warehouse_id = ?, remarks = ? WHERE id = ?`, [b.target_date, b.warehouse_id ?? null, b.remarks, id]);
    if (b.lines) await writeOrderLines(tx, o, b.lines, ruleOf(o));
    await audit(req, 'trx_packing', id, 'UPDATE', { target_date: o.target_date, remarks: o.remarks }, b, tx);
  });
  res.json({ data: await orderDetail(cid, id) });
}));

packingEngineRouter.post('/orders/:id/approve', requirePermission('PACKING.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id, true);
    if (o.order_status !== 'DRAFT') throw BadRequest(`Packing order is ${o.order_status}, not a draft`);
    if (!n(o.planned_qty)) throw BadRequest('The order has no planned quantity');
    await txExecute(tx, `UPDATE trx_packing SET order_status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [req.user!.id, id]);
    await audit(req, 'trx_packing', id, 'UPDATE', { order_status: 'DRAFT' }, { order_status: 'APPROVED' }, tx);
  });
  res.json({ data: await orderDetail(cid, id) });
}));

packingEngineRouter.post('/orders/:id/cancel', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = reasonSchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id, true);
    if (!OPEN_ORDER.includes(o.order_status)) throw BadRequest(`Packing order is ${o.order_status}`);
    if (o.order_status !== 'DRAFT') assertApprove(req, 'Cancelling an approved packing order');
    const posted = await txQueryOne<any>(tx, `SELECT COUNT(*) k FROM trx_carton WHERE packing_id = ? AND is_posted = 1 AND carton_status <> 'VOID'`, [id]);
    if (n(posted?.k)) throw BadRequest(`${posted.k} carton(s) are posted — reverse or void them first`);
    const open = await txQuery<any>(tx, `SELECT * FROM trx_carton WHERE packing_id = ? AND carton_status <> 'VOID' FOR UPDATE`, [id]);
    for (const c of open) {
      await txExecute(tx, `UPDATE trx_carton SET carton_status = 'VOID', void_reason = ? WHERE id = ?`, [`Order cancelled: ${reason}`, c.id]);
      await cartonEvent(tx, req, c, 'VOID', c.carton_status, 'VOID', `Order cancelled: ${reason}`);
    }
    await txExecute(tx, `UPDATE trx_packing_polybag SET status = 'VOID', void_reason = ? WHERE packing_id = ? AND status = 'OPEN' AND cartoned_qty = 0`, [`Order cancelled: ${reason}`, id]);
    await txExecute(tx, `UPDATE trx_packing SET order_status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
    await audit(req, 'trx_packing', id, 'UPDATE', { order_status: o.order_status }, { order_status: 'CANCELLED', reason, voided_cartons: open.length }, tx);
  });
  res.json({ data: await orderDetail(cid, id) });
}));

packingEngineRouter.post('/orders/:id/complete', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id, true);
    if (!WORKING_ORDER.includes(o.order_status)) throw BadRequest(`Packing order is ${o.order_status}`);
    const open = await txQueryOne<any>(tx, `SELECT COUNT(*) k FROM trx_carton WHERE packing_id = ? AND is_posted = 0 AND carton_status <> 'VOID'`, [id]);
    if (n(open?.k)) throw BadRequest(`${open.k} carton(s) are not posted yet — post or void them first`);
    await txExecute(tx, `UPDATE trx_packing SET order_status = 'COMPLETED', completed_at = NOW() WHERE id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_packing_polybag SET status = 'VOID', void_reason = 'Order completed (not cartoned)' WHERE packing_id = ? AND status = 'OPEN' AND cartoned_qty = 0`, [id]);
    await audit(req, 'trx_packing', id, 'UPDATE', { order_status: o.order_status }, { order_status: 'COMPLETED' }, tx);
  });
  res.json({ data: await orderDetail(cid, id) });
}));

packingEngineRouter.post('/orders/:id/approve-variance', requirePermission('PACKING.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { note } = z.object({ note: z.string().trim().min(3, 'Give a note for the variance approval').max(300) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id, true);
    await txExecute(tx, `UPDATE trx_packing SET variance_approved_by = ?, variance_approved_at = NOW(), variance_note = ? WHERE id = ?`, [req.user!.id, note, id]);
    await audit(req, 'trx_packing', id, 'UPDATE', { variance_approved_at: o.variance_approved_at }, { variance_approved: true, note }, tx);
  });
  res.json({ data: await orderDetail(cid, id) });
}));

async function orderDetail(cid: number, id: number) {
  const head = await queryOne<any>(`${await orderSelect()} WHERE p.id = ? AND p.company_id = ? AND p.is_engine = 1`, [id, cid]);
  if (!head) throw NotFound('Packing order not found');
  return transaction(async (tx) => {
    const lines = await eligibility(tx, jobKeyOf(head), Number(head.so_id), id);
    const cartons = await txQuery<any>(tx,
      `SELECT c.*, ct.trim_name carton_trim_name, pt.trim_name polybag_trim_name,
              (SELECT GROUP_CONCAT(CONCAT(col.color_name,'/',sz.size_code,':',cc.qty) ORDER BY col.color_name, sz.sort_order SEPARATOR ', ')
                 FROM trx_carton_content cc LEFT JOIN mst_color col ON col.id = cc.color_id LEFT JOIN mst_size sz ON sz.id = cc.size_id WHERE cc.carton_id = c.id) contents
         FROM trx_carton c LEFT JOIN mst_trim ct ON ct.id = c.carton_trim_id LEFT JOIN mst_trim pt ON pt.id = c.polybag_trim_id
        WHERE c.packing_id = ? ORDER BY c.carton_seq, c.id`, [id]);
    const variance = await orderVariance(tx, head);
    return { ...head, rule: ruleOf(head), lines, cartons, variance, variance_needs_approval: variance.beyond_tolerance && !head.variance_approved_at };
  });
}

packingEngineRouter.get('/orders/:id', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  res.json({ data: await orderDetail(req.user!.companyId, Number(req.params.id)) });
}));

/** Reconciliation (doc §9): eligible / planned / packed / balance, expected vs actual polybags & cartons, consumption. */
packingEngineRouter.get('/orders/:id/reconciliation', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const out = await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id);
    const r = ruleOf(o);
    const lines = await eligibility(tx, jobKeyOf(o), Number(o.so_id), id);
    const variance = await orderVariance(tx, o);
    const cartons = await txQuery<any>(tx,
      `SELECT carton_status, is_posted, is_partial, COUNT(*) k, COALESCE(SUM(pieces_total),0) q FROM trx_carton WHERE packing_id = ? GROUP BY carton_status, is_posted, is_partial`, [id]);
    const consumption = await txQuery<any>(tx,
      `SELECT pc.material_kind, t.trim_code, t.trim_name, SUM(CASE WHEN pc.reversed_at IS NULL THEN pc.qty ELSE 0 END) qty,
              SUM(CASE WHEN pc.reversed_at IS NOT NULL THEN pc.qty ELSE 0 END) reversed_qty
         FROM trx_packing_consumption pc JOIN mst_trim t ON t.id = pc.trim_id WHERE pc.packing_id = ? GROUP BY pc.material_kind, t.trim_code, t.trim_name`, [id]);
    const bags = await txQueryOne<any>(tx,
      `SELECT COALESCE(SUM(pieces),0) pieces, COALESCE(SUM(polybag_qty),0) bags, COALESCE(SUM(cartoned_qty),0) cartoned FROM trx_packing_polybag WHERE packing_id = ? AND status <> 'VOID'`, [id]);
    const tot = (k: keyof typeof lines[number]) => lines.reduce((a, l) => a + n(l[k]), 0);
    const live = cartons.filter((c) => c.carton_status !== 'VOID' && Number(c.is_posted));
    return {
      order: { id: o.id, pack_no: o.pack_no, order_status: o.order_status, packing_mode: o.packing_mode, variance_approved_at: o.variance_approved_at, variance_note: o.variance_note },
      rule: r, lines,
      totals: {
        order_qty: tot('order_qty'), ready: tot('ready'), eligible: tot('eligible'), planned: tot('planned'), posted: tot('posted'), unposted: tot('draft'),
        balance: tot('balance'), packing_balance: Math.max(tot('eligible') - tot('draft'), 0),
      },
      polybag_entries: { pieces: n(bags?.pieces), bags: n(bags?.bags), cartoned: n(bags?.cartoned) },
      cartons: {
        posted: live.reduce((a, c) => a + n(c.k), 0),
        full: live.filter((c) => !Number(c.is_partial)).reduce((a, c) => a + n(c.k), 0),
        partial: live.filter((c) => Number(c.is_partial)).reduce((a, c) => a + n(c.k), 0),
        unposted: cartons.filter((c) => c.carton_status !== 'VOID' && !Number(c.is_posted)).reduce((a, c) => a + n(c.k), 0),
        void: cartons.filter((c) => c.carton_status === 'VOID').reduce((a, c) => a + n(c.k), 0),
      },
      variance, variance_needs_approval: variance.beyond_tolerance && !o.variance_approved_at,
      consumption,
    };
  });
  res.json({ data: out });
}));

/** Bundles of the order's job / style with what can still be bagged (polybag screen picker). */
packingEngineRouter.get('/orders/:id/bundles', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  if (await fgMode(null, cid)) {
    // FG store packing (16-Oct-2026): what the store holds for the order, per colour / size
    const rows = await transaction(async (tx) => {
      const o = await loadOrder(tx, cid, id);
      const el = await eligibility(tx, jobKeyOf(o), Number(o.so_id), id);
      return el.filter((e) => e.planned > 0).map((e) => ({
        id: null, fg_store: true, color_id: e.color_id, size_id: e.size_id, color_name: e.color_name, size_code: e.size_code,
        in_fg: e.eligible, bagged_open: e.bagged_open, baggable: Math.max(e.eligible - e.bagged_open, 0), packed: e.posted,
        planned: e.planned, awaiting_fg: e.awaiting_fg ?? 0,
      }));
    });
    res.json({ data: rows, meta: { fg_mode: true } });
    return;
  }
  const out = await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id);
    const bs = await jobBundles(tx, jobKeyOf(o), Number(req.query.color_id) || null, Number(req.query.size_id) || null);
    const bag = await openBagged(tx, bs.map((b) => Number(b.id)));
    const plan = await txQuery<any>(tx, `SELECT color_id, size_id FROM trx_packing_order_line WHERE packing_id = ? AND planned_qty > 0`, [id]);
    const onPlan = new Set(plan.map((p) => key(p.color_id, p.size_id)));
    const cols = await txQuery<any>(tx, `SELECT id, color_name FROM mst_color WHERE company_id = ?`, [cid]);
    const sizes = await txQuery<any>(tx, `SELECT id, size_code FROM mst_size`);
    return bs.filter((b) => onPlan.has(key(b.color_id, b.size_id))).map((b) => ({
      id: b.id, bundle_no: b.bundle_no, barcode: b.barcode, color_id: b.color_id, size_id: b.size_id, status: b.status, qty: b.qty,
      color_name: cols.find((c) => Number(c.id) === Number(b.color_id))?.color_name, size_code: sizes.find((s) => Number(s.id) === Number(b.size_id))?.size_code,
      ready: b.ready, bagged_open: bag.get(Number(b.id)) ?? 0, baggable: Math.max(b.ready - (bag.get(Number(b.id)) ?? 0), 0), packed: b.packed, qc_pending: b.strict ? b.qc_pending : 0,
    }));
  });
  res.json({ data: out });
}));

// ═══════════════════════════════════════════════════════════════ polybag / piece entry (§6)

packingEngineRouter.get('/orders/:id/polybags', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const rows = await query(
    `SELECT pb.*, cb.bundle_no, cb.barcode, col.color_name, sz.size_code, t.trim_name polybag_trim_name
       FROM trx_packing_polybag pb LEFT JOIN trx_cutting_bundle cb ON cb.id = pb.bundle_id
       LEFT JOIN mst_color col ON col.id = pb.color_id LEFT JOIN mst_size sz ON sz.id = pb.size_id LEFT JOIN mst_trim t ON t.id = pb.polybag_trim_id
      WHERE pb.packing_id = ? AND pb.company_id = ? ORDER BY pb.id DESC`, [id, cid]);
  res.json({ data: rows });
}));

const polybagSchema = z.object({
  bundle_id: idOpt(), barcode: str(80),
  // FG store packing: garments without a bundle (job work, returns) are bagged by colour / size
  color_id: idOpt(), size_id: idOpt(),
  pieces: z.coerce.number().int().positive('Pieces must be a positive whole number').nullish(),
  polybag_qty: z.coerce.number().int().min(0).nullish(),
  polybag_trim_id: idOpt(), operator_name: str(100), remarks: str(300),
});

packingEngineRouter.post('/orders/:id/polybags', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = polybagSchema.parse(req.body);
  if (await fgMode(null, cid)) {
    const row = await transaction((tx) => bagFromFgStore(tx, req, id, b));
    res.status(201).json({ data: row });
    return;
  }
  if (!b.bundle_id && !b.barcode) throw BadRequest('Scan a bundle barcode or pick a bundle');
  const row = await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id, true);
    if (!WORKING_ORDER.includes(o.order_status)) throw BadRequest(`Packing order ${o.pack_no} is ${o.order_status} — approve it before entering polybags`);
    const r = ruleOf(o);
    await lockJob(tx, Number(o.so_id));
    const bd = await lockBundle(tx, cid, { id: b.bundle_id ?? null, code: b.barcode ?? null });
    if (bd.io_no !== o.io_no || Number(bd.style_id) !== Number(o.style_id)) {
      throw BadRequest(`Wrong job: bundle ${bd.bundle_no} is ${bd.io_no ?? 'no job'} — packing order ${o.pack_no} is ${o.io_no}`);
    }
    if (o.part_name && bd.part_name && bd.part_name !== o.part_name) throw BadRequest(`Bundle ${bd.bundle_no} is part ${bd.part_name}; this order packs ${o.part_name}`);
    if (TERMINAL.includes(bd.status)) throw BadRequest(`Bundle ${bd.bundle_no} is ${bd.status} — on hold / closed, it cannot be packed`);
    const plan = await txQueryOne<any>(tx, `SELECT planned_qty FROM trx_packing_order_line WHERE packing_id = ? AND color_id = ? AND size_id = ?`, [id, bd.color_id, bd.size_id]);
    if (!plan || !n(plan.planned_qty)) throw BadRequest(`Bundle ${bd.bundle_no}'s colour / size is not on packing order ${o.pack_no}`);
    const strict = await packingRequiresQc(tx, cid);
    const ready = availAt(bd, 'PACK', strict);
    const bagged = (await openBagged(tx, [bd.id])).get(bd.id) ?? 0;
    const baggable = Math.max(ready - bagged, 0);
    if (!baggable) {
      const qcPending = strict ? Math.max(n(bd.fin_good_qty) - n(bd.qc_pass_qty) - n(bd.qc_reject_qty), 0) : 0;
      throw BadRequest(`Bundle ${bd.bundle_no}: nothing left to pack`
        + (bagged ? ` (${bagged} pcs already bagged)` : '') + (n(bd.packed_qty) ? ` (${bd.packed_qty} pcs already packed)` : '')
        + (qcPending ? ` — QC hold: ${qcPending} pcs waiting for Final QC` : !n(bd.fin_good_qty) ? ' — no finished (ironed) pieces yet' : ''));
    }
    const ppp = Math.max(n(r.pieces_per_polybag), 1);
    const pieces = b.pieces ?? (o.packing_mode === 'INDIVIDUAL_PIECE' ? Math.min(ppp, baggable) : baggable);
    if (pieces > baggable) throw BadRequest(`Bundle ${bd.bundle_no}: only ${baggable} pcs can be bagged (ready ${ready}, already bagged ${bagged}) — ${pieces} entered`);
    const onOrder = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(pieces),0) q FROM trx_packing_polybag WHERE packing_id = ? AND color_id = ? AND size_id = ? AND status <> 'VOID'`, [id, bd.color_id, bd.size_id]);
    if (n(onOrder?.q) + pieces > n(plan.planned_qty) && !Number(r.allow_overpack)) {
      throw BadRequest(`Bundle ${bd.bundle_no}: ${n(onOrder?.q) + pieces} pcs would be bagged for this colour / size — planned ${plan.planned_qty}`);
    }
    const trim = b.polybag_trim_id ?? r.polybag_trim_id ?? null;
    await assertPackagingTrim(tx, cid, trim, 'POLYBAG');
    const bags = b.polybag_qty ?? Math.ceil(pieces / ppp);
    const ins = await txExecute(tx,
      `INSERT INTO trx_packing_polybag (company_id, packing_id, entry_mode, bundle_id, io_no, style_id, color_id, size_id, pieces, pieces_per_polybag, polybag_qty,
         polybag_trim_id, operator_name, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, id, o.packing_mode, bd.id, bd.io_no, bd.style_id, bd.color_id, bd.size_id, pieces, ppp, bags, trim, b.operator_name, b.remarks, req.user!.id]);
    if (o.order_status === 'APPROVED') await txExecute(tx, `UPDATE trx_packing SET order_status = 'IN_PROGRESS' WHERE id = ?`, [id]);
    const row = await txQueryOne<any>(tx,
      `SELECT pb.*, cb.bundle_no, col.color_name, sz.size_code FROM trx_packing_polybag pb JOIN trx_cutting_bundle cb ON cb.id = pb.bundle_id
         LEFT JOIN mst_color col ON col.id = pb.color_id LEFT JOIN mst_size sz ON sz.id = pb.size_id WHERE pb.id = ?`, [ins.insertId]);
    await audit(req, 'trx_packing_polybag', ins.insertId, 'INSERT', undefined, row, tx);
    return { ...row, std_polybags: Math.ceil(pieces / ppp), variance: bags - Math.ceil(pieces / ppp) };
  });
  res.status(201).json({ data: row });
}));

/**
 * Polybag / individual piece entry from the FG store (PACKING_FROM_FG_RECEIPT, client call 16-Oct-2026): only PCS
 * received into the FG store can be bagged. A bundle scan fills colour / size and is capped by that bundle's PCS in
 * the store; colour / size alone bags FG garments with no bundle. Both are capped by the store PCS the order may take.
 */
async function bagFromFgStore(tx: any, req: any, id: number, b: z.infer<typeof polybagSchema>) {
  const cid = req.user!.companyId;
  const o = await loadOrder(tx, cid, id, true);
  if (!WORKING_ORDER.includes(o.order_status)) throw BadRequest(`Packing order ${o.pack_no} is ${o.order_status} — approve it before entering polybags`);
  const r = ruleOf(o);
  await lockJob(tx, Number(o.so_id));
  let bd: any = null;
  let colorId = b.color_id ?? null; let sizeId = b.size_id ?? null;
  if (b.bundle_id || b.barcode) {
    bd = await lockBundle(tx, cid, { id: b.bundle_id ?? null, code: b.barcode ?? null });
    if (bd.io_no !== o.io_no || Number(bd.style_id) !== Number(o.style_id)) {
      throw BadRequest(`Wrong job: bundle ${bd.bundle_no} is ${bd.io_no ?? 'no job'} — packing order ${o.pack_no} is ${o.io_no}`);
    }
    if (o.part_name && bd.part_name && bd.part_name !== o.part_name) throw BadRequest(`Bundle ${bd.bundle_no} is part ${bd.part_name}; this order packs ${o.part_name}`);
    colorId = Number(bd.color_id); sizeId = Number(bd.size_id);
  }
  if (!colorId || !sizeId) throw BadRequest('Scan a bundle, or pick the colour and size of the FG garments to bag');
  const plan = await txQueryOne<any>(tx, `SELECT planned_qty FROM trx_packing_order_line WHERE packing_id = ? AND color_id = ? AND size_id = ?`, [id, colorId, sizeId]);
  if (!plan || !n(plan.planned_qty)) throw BadRequest(`This colour / size is not on packing order ${o.pack_no}`);
  const e = (await eligibility(tx, jobKeyOf(o), Number(o.so_id), id)).find((x) => x.color_id === colorId && x.size_id === sizeId);
  const storeFree = Math.max(n(e?.eligible) - n(e?.bagged_open), 0);
  let baggable = storeFree;
  let bundleFree: number | null = null;
  if (bd) {
    const openOnBundle = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(pieces - cartoned_qty),0) q FROM trx_packing_polybag WHERE bundle_id = ? AND status = 'OPEN'`, [bd.id]);
    bundleFree = Math.max(n(bd.fg_qty) - n(openOnBundle?.q), 0);
    baggable = Math.min(baggable, bundleFree);
  }
  if (!baggable) {
    throw BadRequest(bd
      ? `Bundle ${bd.bundle_no}: no PCS of it are in the FG store to bag (${n(bd.fg_qty)} in the store, already bagged ${n(bd.fg_qty) - (bundleFree ?? 0)}) — receive them on an FG Receipt first`
      : `Nothing of this colour / size is in the FG store to bag (in store for this order ${n(e?.eligible)}, already bagged ${n(e?.bagged_open)})`
        + (n(e?.awaiting_fg) ? ` — ${e!.awaiting_fg} PCS finished ironing are waiting for an FG receipt` : ''));
  }
  const ppp = Math.max(n(r.pieces_per_polybag), 1);
  const pieces = b.pieces ?? (o.packing_mode === 'INDIVIDUAL_PIECE' ? Math.min(ppp, baggable) : baggable);
  if (pieces > baggable) throw BadRequest(`Only ${baggable} PCS can be bagged from the FG store${bd ? ` for bundle ${bd.bundle_no}` : ''} — ${pieces} entered`);
  const onOrder = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(pieces),0) q FROM trx_packing_polybag WHERE packing_id = ? AND color_id = ? AND size_id = ? AND status <> 'VOID'`, [id, colorId, sizeId]);
  if (n(onOrder?.q) + pieces > n(plan.planned_qty) && !Number(r.allow_overpack)) {
    throw BadRequest(`${n(onOrder?.q) + pieces} PCS would be bagged for this colour / size — planned ${plan.planned_qty}`);
  }
  const trim = b.polybag_trim_id ?? r.polybag_trim_id ?? null;
  await assertPackagingTrim(tx, cid, trim, 'POLYBAG');
  const bags = b.polybag_qty ?? Math.ceil(pieces / ppp);
  const ins = await txExecute(tx,
    `INSERT INTO trx_packing_polybag (company_id, packing_id, entry_mode, bundle_id, io_no, style_id, color_id, size_id, pieces, pieces_per_polybag, polybag_qty,
       polybag_trim_id, operator_name, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, id, o.packing_mode, bd?.id ?? null, o.io_no, o.style_id, colorId, sizeId, pieces, ppp, bags, trim, b.operator_name, b.remarks, req.user!.id]);
  if (o.order_status === 'APPROVED') await txExecute(tx, `UPDATE trx_packing SET order_status = 'IN_PROGRESS' WHERE id = ?`, [id]);
  const row = await txQueryOne<any>(tx,
    `SELECT pb.*, cb.bundle_no, col.color_name, sz.size_code FROM trx_packing_polybag pb LEFT JOIN trx_cutting_bundle cb ON cb.id = pb.bundle_id
       LEFT JOIN mst_color col ON col.id = pb.color_id LEFT JOIN mst_size sz ON sz.id = pb.size_id WHERE pb.id = ?`, [ins.insertId]);
  await audit(req, 'trx_packing_polybag', ins.insertId, 'INSERT', undefined, row, tx);
  return { ...row, from_fg_store: true, std_polybags: Math.ceil(pieces / ppp), variance: bags - Math.ceil(pieces / ppp) };
}

packingEngineRouter.post('/polybags/:id/void', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = reasonSchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const pb = await txQueryOne<any>(tx, `SELECT * FROM trx_packing_polybag WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!pb) throw NotFound('Polybag entry not found');
    if (pb.status === 'VOID') throw BadRequest('Already void');
    if (n(pb.cartoned_qty)) throw BadRequest(`${pb.cartoned_qty} pcs of this entry are in a posted carton — reverse that carton first`);
    await txExecute(tx, `UPDATE trx_packing_polybag SET status = 'VOID', void_reason = ? WHERE id = ?`, [reason, id]);
    await audit(req, 'trx_packing_polybag', id, 'UPDATE', { status: pb.status }, { status: 'VOID', reason }, tx);
  });
  res.json({ data: { id, status: 'VOID' } });
}));

// ═══════════════════════════════════════════════════════════════ cartons (§7, §8)

const lineSchema = z.object({
  color_id: z.coerce.number().int().positive(), size_id: z.coerce.number().int().positive(),
  qty: z.coerce.number().int('Pieces must be whole numbers').positive('Pieces must be greater than zero'),
  polybag_qty: z.coerce.number().int().min(0).nullish(), bundle_id: idOpt(),
});
const nonNeg = () => z.coerce.number().min(0, 'Must not be negative').nullish();
const cartonSchema = z.object({
  carton_no: str(40),
  carton_trim_id: idOpt(), polybag_trim_id: idOpt(),
  lines: z.array(lineSchema).min(1, 'Add at least one colour / size line'),
  polybag_qty: z.coerce.number().int().min(0).nullish(),
  net_weight_kg: nonNeg(), gross_weight_kg: nonNeg(),
  length_cm: nonNeg(), width_cm: nonNeg(), height_cm: nonNeg(),
  seal_no: str(60), remarks: str(300),
  save_as_draft: z.boolean().optional(),
}).refine((b) => b.gross_weight_kg == null || b.net_weight_kg == null || b.gross_weight_kg >= b.net_weight_kg,
  { message: 'Gross weight must be at least the net weight', path: ['gross_weight_kg'] });

const cbmOf = (l?: number | null, w?: number | null, h?: number | null) => (l && w && h ? Number(((l * w * h) / 1_000_000).toFixed(5)) : null);

async function writeCartonLines(tx: any, cartonId: number, order: any, lines: z.infer<typeof lineSchema>[]) {
  const r = ruleOf(order);
  await txExecute(tx, `DELETE FROM trx_carton_content WHERE carton_id = ?`, [cartonId]);
  for (const l of lines) {
    const sku = await txQueryOne<any>(tx, `SELECT id FROM mst_style_sku WHERE style_id = ? AND color_id = ? AND size_id = ? LIMIT 1`, [order.style_id, l.color_id, l.size_id]);
    await txExecute(tx,
      `INSERT INTO trx_carton_content (carton_id, sku_id, qty, part_name, io_no, style_id, color_id, size_id, polybag_qty, bundle_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [cartonId, sku?.id ?? null, l.qty, order.part_name ?? null, order.io_no, order.style_id, l.color_id, l.size_id, l.polybag_qty ?? stdPolybags(l.qty, r), l.bundle_id ?? null]);
  }
}

async function cartonDetail(cid: number, id: number) {
  const c = await queryOne<any>(
    `SELECT c.*, p.pack_no, p.io_no, p.so_id, p.style_id, p.order_status, p.packing_mode, p.rule_snapshot, so.so_no, so.buyer_po_no,
            b.party_name buyer_name, st.style_code, st.style_name, ct.trim_name carton_trim_name, pt.trim_name polybag_trim_name,
            (SELECT COUNT(*) FROM trx_carton x WHERE x.packing_id = c.packing_id AND x.carton_status <> 'VOID') carton_count
       FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id JOIN trx_sales_order so ON so.id = p.so_id
       LEFT JOIN mst_party b ON b.id = so.buyer_id LEFT JOIN mst_style st ON st.id = p.style_id
       LEFT JOIN mst_trim ct ON ct.id = c.carton_trim_id LEFT JOIN mst_trim pt ON pt.id = c.polybag_trim_id
      WHERE c.id = ? AND p.company_id = ?`, [id, cid]);
  if (!c) throw NotFound('Carton not found');
  const rule = typeof c.rule_snapshot === 'string' ? JSON.parse(c.rule_snapshot) : c.rule_snapshot;
  delete c.rule_snapshot;
  c.rule = rule;
  c.lines = await query(
    `SELECT cc.*, col.color_name, sz.size_code, sz.sort_order, cb.bundle_no FROM trx_carton_content cc
       LEFT JOIN mst_color col ON col.id = cc.color_id LEFT JOIN mst_size sz ON sz.id = cc.size_id LEFT JOIN trx_cutting_bundle cb ON cb.id = cc.bundle_id
      WHERE cc.carton_id = ? ORDER BY col.color_name, sz.sort_order`, [id]);
  c.bundles = await query(
    `SELECT ctb.bundle_id, ctb.qty, cb.bundle_no, cb.barcode, cb.io_no, col.color_name, sz.size_code, cb.cutting_id
       FROM trx_carton_bundle ctb JOIN trx_cutting_bundle cb ON cb.id = ctb.bundle_id
       LEFT JOIN mst_color col ON col.id = cb.color_id LEFT JOIN mst_size sz ON sz.id = cb.size_id WHERE ctb.carton_id = ? ORDER BY cb.bundle_no`, [id]);
  c.events = await query(`SELECT e.* FROM trx_carton_event e WHERE e.carton_id = ? ORDER BY e.id`, [id]);
  c.consumption = await query(
    `SELECT pc.*, t.trim_name FROM trx_packing_consumption pc JOIN mst_trim t ON t.id = pc.trim_id WHERE pc.carton_id = ? ORDER BY pc.id`, [id]);
  const cap = n(rule?.standard_pieces_per_carton);
  c.capacity = { standard: cap, actual: n(c.pieces_total), diff: n(c.pieces_total) - cap, status: !cap ? 'n/a' : n(c.pieces_total) === cap ? 'FULL' : n(c.pieces_total) < cap ? 'PARTIAL' : 'OVERPACK' };
  c.polybag_variance = n(c.polybag_qty) - n(c.std_polybag_qty);
  return c;
}

packingEngineRouter.get('/orders/:id/cartons', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const d = await orderDetail(req.user!.companyId, Number(req.params.id));
  res.json({ data: d.cartons });
}));

packingEngineRouter.post('/orders/:id/cartons', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = cartonSchema.parse(req.body);
  const cartonId = await transaction(async (tx) => {
    const o = await loadOrder(tx, cid, id, true);
    if (!WORKING_ORDER.includes(o.order_status)) throw BadRequest(`Packing order ${o.pack_no} is ${o.order_status} — cartons are packed on an approved order`);
    await lockJob(tx, Number(o.so_id));
    const r = ruleOf(o);
    const ctnTrim = b.carton_trim_id ?? r.carton_trim_id ?? null; const bagTrim = b.polybag_trim_id ?? r.polybag_trim_id ?? null;
    await assertPackagingTrim(tx, cid, ctnTrim, 'CARTON');
    await assertPackagingTrim(tx, cid, bagTrim, 'POLYBAG');
    const v = await validateCarton(tx, o, b.lines, { stage: 'save' });
    const cartonNo = (b.carton_no ?? await nextDocNumber(tx, cid, 'PACKING_CARTON')).toUpperCase();
    try {
      await txExecute(tx, `INSERT INTO trx_carton_no_registry (company_id, carton_no) VALUES (?,?)`, [cid, cartonNo]);
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') throw BadRequest(`Carton no ${cartonNo} is already used — carton numbers are never reused`);
      throw e;
    }
    const seq = await txQueryOne<any>(tx, `SELECT COALESCE(MAX(carton_seq),0) + 1 s FROM trx_carton WHERE packing_id = ?`, [id]);
    const bags = b.polybag_qty ?? b.lines.reduce((a, l) => a + (l.polybag_qty ?? stdPolybags(l.qty, r)), 0);
    const status = b.save_as_draft ? 'DRAFT' : 'OPEN';
    const ins = await txExecute(tx,
      `INSERT INTO trx_carton (packing_id, carton_no, carton_type, length_cm, width_cm, height_cm, net_weight_kg, gross_weight_kg, cbm, barcode,
         carton_status, is_posted, company_id, carton_seq, pieces_total, polybag_qty, std_polybag_qty, carton_trim_id, polybag_trim_id, is_partial, seal_no, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, cartonNo, ctnTrim ? (await txQueryOne<any>(tx, `SELECT trim_code FROM mst_trim WHERE id = ?`, [ctnTrim]))?.trim_code ?? null : null,
       b.length_cm ?? null, b.width_cm ?? null, b.height_cm ?? null, b.net_weight_kg ?? null, b.gross_weight_kg ?? null, cbmOf(b.length_cm, b.width_cm, b.height_cm),
       cartonNo, status, cid, n(seq?.s), v.total, bags, v.std_polybags, ctnTrim, bagTrim, v.is_partial, b.seal_no, b.remarks, req.user!.id]);
    await txExecute(tx, `UPDATE trx_carton_no_registry SET carton_id = ? WHERE company_id = ? AND carton_no = ?`, [ins.insertId, cid, cartonNo]);
    await writeCartonLines(tx, ins.insertId, o, b.lines);
    if (o.order_status === 'APPROVED') await txExecute(tx, `UPDATE trx_packing SET order_status = 'IN_PROGRESS' WHERE id = ?`, [id]);
    await cartonEvent(tx, req, { id: ins.insertId, packing_id: id }, 'CREATE', null, status, null, { lines: b.lines, polybags: bags });
    await audit(req, 'trx_carton', ins.insertId, 'INSERT', undefined, { carton_no: cartonNo, lines: b.lines, polybag_qty: bags }, tx);
    return ins.insertId;
  });
  res.status(201).json({ data: await cartonDetail(cid, cartonId) });
}));

packingEngineRouter.put('/cartons/:id', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = cartonSchema.parse(req.body);
  await transaction(async (tx) => {
    const c = await lockCarton(tx, cid, id);
    const o = await loadOrder(tx, cid, Number(c.packing_id), true);
    if (Number(c.is_posted) || !EDITABLE_CARTON.includes(c.carton_status)) {
      throw BadRequest(`Carton ${c.carton_no} is ${c.is_posted ? 'posted' : c.carton_status} — reopen it (supervisor, with a reason) to change it`);
    }
    if (!WORKING_ORDER.includes(o.order_status)) throw BadRequest(`Packing order is ${o.order_status}`);
    await lockJob(tx, Number(o.so_id));
    const r = ruleOf(o);
    const ctnTrim = b.carton_trim_id ?? c.carton_trim_id ?? r.carton_trim_id ?? null; const bagTrim = b.polybag_trim_id ?? c.polybag_trim_id ?? r.polybag_trim_id ?? null;
    await assertPackagingTrim(tx, cid, ctnTrim, 'CARTON');
    await assertPackagingTrim(tx, cid, bagTrim, 'POLYBAG');
    if (b.carton_no && b.carton_no.toUpperCase() !== c.carton_no) throw BadRequest('The carton number cannot be changed — void the carton and make a new one');
    const v = await validateCarton(tx, o, b.lines, { cartonId: id, stage: 'save' });
    const before = { lines: await cartonLines(tx, id), polybag_qty: c.polybag_qty, gross: c.gross_weight_kg, net: c.net_weight_kg };
    const bags = b.polybag_qty ?? b.lines.reduce((a, l) => a + (l.polybag_qty ?? stdPolybags(l.qty, r)), 0);
    const status = b.save_as_draft ? 'DRAFT' : 'OPEN';
    await txExecute(tx,
      `UPDATE trx_carton SET length_cm=?, width_cm=?, height_cm=?, net_weight_kg=?, gross_weight_kg=?, cbm=?, carton_status=?, pieces_total=?, polybag_qty=?, std_polybag_qty=?,
         carton_trim_id=?, polybag_trim_id=?, is_partial=?, seal_no=?, remarks=?, updated_at=NOW() WHERE id = ?`,
      [b.length_cm ?? null, b.width_cm ?? null, b.height_cm ?? null, b.net_weight_kg ?? null, b.gross_weight_kg ?? null, cbmOf(b.length_cm, b.width_cm, b.height_cm),
       status, v.total, bags, v.std_polybags, ctnTrim, bagTrim, v.is_partial, b.seal_no, b.remarks, id]);
    await writeCartonLines(tx, id, o, b.lines);
    await cartonEvent(tx, req, c, 'UPDATE', c.carton_status, status, null, { lines: b.lines, polybags: bags });
    await audit(req, 'trx_carton', id, 'UPDATE', before, { lines: b.lines, polybag_qty: bags }, tx);
  });
  res.json({ data: await cartonDetail(cid, id) });
}));

packingEngineRouter.get('/cartons/:id', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  res.json({ data: await cartonDetail(req.user!.companyId, Number(req.params.id)) });
}));

/** Scan a carton barcode / carton no → exact contents + bundles (traceability, verification screen). */
packingEngineRouter.get('/scan/:code', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const code = String(req.params.code).trim();
  const c = await queryOne<any>(
    `SELECT c.id FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id
      WHERE p.company_id = ? AND (c.barcode = ? OR c.carton_no = ?) ORDER BY (c.barcode = ?) DESC, c.id DESC LIMIT 1`, [cid, code, code, code]);
  if (!c) throw NotFound(`No carton with barcode / number ${code}`);
  res.json({ data: await cartonDetail(cid, c.id) });
}));

const verifySchema = z.object({ net_weight_kg: nonNeg(), gross_weight_kg: nonNeg(), labels_ok: z.boolean().optional() })
  .refine((b) => b.gross_weight_kg == null || b.net_weight_kg == null || b.gross_weight_kg >= b.net_weight_kg,
    { message: 'Gross weight must be at least the net weight', path: ['gross_weight_kg'] });

packingEngineRouter.post('/cartons/:id/verify', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = verifySchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const c = await lockCarton(tx, cid, id);
    const o = await loadOrder(tx, cid, Number(c.packing_id), true);
    if (!EDITABLE_CARTON.includes(c.carton_status)) throw BadRequest(`Carton ${c.carton_no} is ${c.carton_status} — only a draft / open carton is verified`);
    if (!WORKING_ORDER.includes(o.order_status)) throw BadRequest(`Packing order is ${o.order_status}`);
    await lockJob(tx, Number(o.so_id));
    const lines = await cartonLines(tx, id);
    const v = await validateCarton(tx, o, lines, { cartonId: id, stage: 'verify' });
    if (v.total !== n(c.pieces_total)) throw BadRequest(`Carton total ${c.pieces_total} does not match its lines (${v.total})`);
    const net = b.net_weight_kg ?? c.net_weight_kg; const gross = b.gross_weight_kg ?? c.gross_weight_kg;
    if (net != null && gross != null && Number(gross) < Number(net)) throw BadRequest('Gross weight must be at least the net weight');
    await txExecute(tx, `UPDATE trx_carton SET carton_status = 'VERIFIED', verified_by = ?, verified_at = NOW(), net_weight_kg = ?, gross_weight_kg = ?, is_partial = ? WHERE id = ?`,
      [req.user!.id, net ?? null, gross ?? null, v.is_partial, id]);
    await cartonEvent(tx, req, c, 'VERIFY', c.carton_status, 'VERIFIED', null, { pieces: v.total, capacity: v.cap, polybags: c.polybag_qty, std_polybags: v.std_polybags, labels_ok: b.labels_ok ?? null });
    await audit(req, 'trx_carton', id, 'UPDATE', { carton_status: c.carton_status }, { carton_status: 'VERIFIED' }, tx);
  });
  res.json({ data: await cartonDetail(cid, id) });
}));

packingEngineRouter.post('/cartons/:id/seal', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ seal_no: str(60) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const c = await lockCarton(tx, cid, id);
    if (c.carton_status !== 'VERIFIED') throw BadRequest(`Carton ${c.carton_no} is ${c.carton_status} — verify it before sealing`);
    await txExecute(tx, `UPDATE trx_carton SET carton_status = 'SEALED', sealed_by = ?, sealed_at = NOW(), seal_no = COALESCE(?, seal_no) WHERE id = ?`, [req.user!.id, b.seal_no, id]);
    await cartonEvent(tx, req, c, 'SEAL', 'VERIFIED', 'SEALED', null, { seal_no: b.seal_no ?? c.seal_no });
    await audit(req, 'trx_carton', id, 'UPDATE', { carton_status: 'VERIFIED' }, { carton_status: 'SEALED', seal_no: b.seal_no }, tx);
  });
  res.json({ data: await cartonDetail(cid, id) });
}));

/** Reopen a verified / sealed carton (supervisor + reason). A posted carton is reversed first (stock back, bundles un-packed). */
packingEngineRouter.post('/cartons/:id/reopen', requirePermission('PACKING.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = reasonSchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const c = await lockCarton(tx, cid, id);
    if (!['VERIFIED', 'SEALED'].includes(c.carton_status)) throw BadRequest(`Carton ${c.carton_no} is ${c.carton_status} — only a verified / sealed carton is reopened`);
    const o = await loadOrder(tx, cid, Number(c.packing_id), true);
    if (!WORKING_ORDER.includes(o.order_status)) throw BadRequest(`Packing order is ${o.order_status}`);
    await assertNotDownstream(tx, c);
    await lockJob(tx, Number(o.so_id));
    const rev = await reverseCarton(tx, req, c, `Reopen: ${reason}`);
    await txExecute(tx, `UPDATE trx_carton SET carton_status = 'OPEN', verified_by = NULL, verified_at = NULL, sealed_by = NULL, sealed_at = NULL WHERE id = ?`, [id]);
    await cartonEvent(tx, req, c, 'REOPEN', c.carton_status, 'OPEN', reason, { reversed: rev.reversed });
    await recalcOrder(tx, o.id);
    await audit(req, 'trx_carton', id, 'UPDATE', { carton_status: c.carton_status }, { carton_status: 'OPEN', reason }, tx);
  });
  res.json({ data: await cartonDetail(cid, id) });
}));

/** Void a carton (reason). A posted carton needs PACKING.APPROVE and is reversed first. The number is never reused. */
packingEngineRouter.post('/cartons/:id/void', requireAny('PACKING.UPDATE', 'PACKING.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = reasonSchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const c = await lockCarton(tx, cid, id);
    if (c.carton_status === 'VOID') throw BadRequest('Carton is already void');
    await assertNotDownstream(tx, c);
    if (Number(c.is_posted) || ['VERIFIED', 'SEALED'].includes(c.carton_status)) assertApprove(req, 'Voiding a verified / sealed / posted carton');
    const o = await loadOrder(tx, cid, Number(c.packing_id), true);
    await lockJob(tx, Number(o.so_id));
    const rev = await reverseCarton(tx, req, c, `Void: ${reason}`);
    await txExecute(tx, `UPDATE trx_carton SET carton_status = 'VOID', void_reason = ? WHERE id = ?`, [reason, id]);
    await cartonEvent(tx, req, c, 'VOID', c.carton_status, 'VOID', reason, { reversed: rev.reversed });
    await recalcOrder(tx, o.id);
    await audit(req, 'trx_carton', id, 'UPDATE', { carton_status: c.carton_status }, { carton_status: 'VOID', reason }, tx);
  });
  res.json({ data: await cartonDetail(cid, id) });
}));

/** Authorised reversal of a posted carton (stock returned, bundles un-packed); the carton stays VERIFIED / SEALED, unposted. */
packingEngineRouter.post('/cartons/:id/reverse', requirePermission('PACKING.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = reasonSchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const c = await lockCarton(tx, cid, id);
    if (!Number(c.is_posted)) throw BadRequest(`Carton ${c.carton_no} is not posted`);
    const o = await loadOrder(tx, cid, Number(c.packing_id), true);
    await lockJob(tx, Number(o.so_id));
    await reverseCarton(tx, req, c, reason);
    await recalcOrder(tx, o.id);
    if (o.order_status === 'COMPLETED') await txExecute(tx, `UPDATE trx_packing SET order_status = 'IN_PROGRESS', completed_at = NULL WHERE id = ?`, [o.id]);
  });
  res.json({ data: await cartonDetail(cid, id) });
}));

async function postMany(req: any, orderId: number, cartonIds: number[] | null) {
  const cid = req.user!.companyId;
  return transaction(async (tx) => {
    const o = await loadOrder(tx, cid, orderId, true);
    if (!WORKING_ORDER.includes(o.order_status)) throw BadRequest(`Packing order ${o.pack_no} is ${o.order_status} — only approved / in-progress orders post`);
    await lockJob(tx, Number(o.so_id));
    const ids = cartonIds ?? (await txQuery<any>(tx,
      `SELECT id FROM trx_carton WHERE packing_id = ? AND is_posted = 0 AND carton_status IN ('VERIFIED','SEALED') ORDER BY carton_seq, id`, [orderId])).map((r) => Number(r.id));
    const toPost = ids.length ? (await txQuery<any>(tx, `SELECT id FROM trx_carton WHERE id IN (?) AND is_posted = 0`, [ids])).map((r) => Number(r.id)) : [];
    if (toPost.length) {
      const v = await orderVariance(tx, o, toPost);
      if (v.beyond_tolerance && !o.variance_approved_at) {
        throw BadRequest(`Packaging variance is beyond the ${v.tolerance_pct}% tolerance (polybags ${v.polybags.actual} vs ${v.polybags.expected} expected, `
          + `cartons ${v.cartons.actual} vs ${v.cartons.expected}) — a supervisor must approve the variance before posting`);
      }
    }
    const results = [];
    for (const id of ids) results.push(await postCarton(tx, req, o, id));
    await recalcOrder(tx, orderId);
    if (o.order_status === 'APPROVED' && results.some((r) => !r.skipped)) await txExecute(tx, `UPDATE trx_packing SET order_status = 'IN_PROGRESS' WHERE id = ?`, [orderId]);
    await audit(req, 'trx_packing', orderId, 'UPDATE', undefined, { action: 'POST', cartons: results.map((r) => ({ carton_no: r.carton_no, skipped: r.skipped })) }, tx);
    return { posted: results.filter((r) => !r.skipped).length, skipped: results.filter((r) => r.skipped).length, cartons: results };
  });
}

/** POST all verified / sealed unposted cartons of the order — one transaction; already posted ones are skipped. */
packingEngineRouter.post('/orders/:id/post', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const out = await postMany(req, Number(req.params.id), null);
  res.json({ data: out });
}));

packingEngineRouter.post('/cartons/:id/post', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const c = await queryOne<any>(`SELECT c.id, c.packing_id FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id WHERE c.id = ? AND p.company_id = ?`, [Number(req.params.id), cid]);
  if (!c) throw NotFound('Carton not found');
  const out = await postMany(req, Number(c.packing_id), [Number(c.id)]);
  res.json({ data: { ...out, carton: await cartonDetail(cid, Number(c.id)) } });
}));

/** Label data — always from the carton's actual detail lines, never the plan (doc §17). */
packingEngineRouter.get('/cartons/:id/label', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const c = await cartonDetail(cid, Number(req.params.id));
  if (c.carton_status === 'VOID') throw BadRequest(`Carton ${c.carton_no} is void`);
  res.json({
    data: {
      carton_no: c.carton_no, barcode: c.barcode || c.carton_no, seq: c.carton_seq, of: c.carton_count, pack_no: c.pack_no,
      buyer: c.buyer_name, buyer_po: c.buyer_po_no, job: c.io_no, style: c.style_code, style_name: c.style_name,
      lines: c.lines.map((l: any) => ({ color: l.color_name, size: l.size_code, qty: l.qty })), pieces: c.pieces_total,
      net_weight_kg: c.net_weight_kg, gross_weight_kg: c.gross_weight_kg, dims: [c.length_cm, c.width_cm, c.height_cm], status: c.carton_status, is_posted: c.is_posted,
    },
  });
}));

packingEngineRouter.post('/cartons/:id/label-printed', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const c = await txQueryOne<any>(tx, `SELECT c.id, c.packing_id, c.carton_status FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id WHERE c.id = ? AND p.company_id = ?`, [id, cid]);
    if (!c) throw NotFound('Carton not found');
    await cartonEvent(tx, req, c, 'PRINT', c.carton_status, c.carton_status);
  });
  res.json({ data: { id } });
}));

// ═══════════════════════════════════════════════════════════════ reports (§18)
packingEngineRouter.use('/', packingReportsRouter);

export { setting };
