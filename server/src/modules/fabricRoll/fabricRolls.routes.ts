import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Forbidden, NotFound } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import {
  approveSplit, LIVE_ROLL_SQL, OUTPUT_TYPES, planSplit, rejectSplit, requestSplit, splitSettings, SPLIT_REASONS, transferRolls, r3, n, type RollCtx,
} from './rollEngine.js';

/**
 * Fabric roll inventory (client doc "C_ONE_ERP_Fabric_Roll_Management_Developer_Document", 23-Nov-2026) —
 * all under /inventory/fabric-rolls:
 *   GET  /summary                     received rolls / KG vs pieces now (a cut never changes the purchase figures)
 *   GET  /:id/split-info              the roll, KG left, reservations and the split tolerance (split dialog)
 *   POST /:id/split-preview           validate a split without posting
 *   POST /:id/split                   post a split (cutting loss above tolerance → waits for a store supervisor)
 *   GET  /splits, /splits/:id         split documents; POST /splits/:id/approve | /reject
 *   POST /transfer, GET /transfers    move rolls between stores / bins
 *   POST /labels                      label data for printing (first print / reprint with reason, audited)
 *   GET  /:id/family                  parent → child tree of a roll (all generations)
 *   GET  /reports/:key                grn-reconciliation · remnants · ageing · cut-loss · ledger-reconciliation · labels
 */
export const fabricRollsRouter = Router();
const VIEW = requireAny('INVENTORY.VIEW', 'PRODUCTION.VIEW', 'FABRIC_PROCESS.VIEW', 'PURCHASE.VIEW');
const EDIT = requireAny('INVENTORY.CREATE', 'PRODUCTION.CREATE', 'FABRIC_PROCESS.CREATE');
const APPROVE = requireAny('INVENTORY.ADJUST');
const BASE = '/inventory/fabric-rolls';
const has = (req: Request, code: string) => !!req.user!.isSuperAdmin || req.user!.permissions.has(code);
const ctxOf = (req: Request): RollCtx => ({ cid: req.user!.companyId, userId: req.user!.id, canApprove: has(req, 'INVENTORY.ADJUST') });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const idParam = (req: Request) => z.coerce.number().int().positive().parse(req.params.id);

const pieceSchema = z.object({
  kg: z.coerce.number().positive('Enter the KG of every piece'),
  meters: z.coerce.number().positive().nullish(),
  output_type: z.enum(OUTPUT_TYPES as [string, ...string[]]).default('STORE'),
  warehouse_id: z.coerce.number().int().positive().nullish(),
  location_bin: z.string().trim().max(50).nullish(),
  remarks: z.string().trim().max(255).nullish(),
});
const splitSchema = z.object({
  pieces: z.array(pieceSchema).min(2, 'Cut the roll into at least two pieces').max(20, 'At most 20 pieces'),
  reason_code: z.enum(SPLIT_REASONS as unknown as [string, ...string[]]).default('OTHER'),
  remarks: z.string().trim().max(255).nullish(),
  measurement_source: z.enum(['WEIGHING_SCALE', 'MANUAL']).default('WEIGHING_SCALE'),
});
const inputOf = (id: number, b: z.infer<typeof splitSchema>) => ({
  roll_id: id, reason_code: b.reason_code, remarks: b.remarks ?? null, measurement_source: b.measurement_source, source: 'MANUAL' as const,
  pieces: b.pieces.map((p) => ({ ...p, output_type: p.output_type as any })),
});
const shapePlan = (p: Awaited<ReturnType<typeof planSplit>>) => ({
  roll: { id: p.roll.id, roll_no: p.roll.roll_no, weight_kg: n(p.roll.weight_kg), issued_kg: n(p.roll.issued_kg) },
  input_kg: p.input_kg, output_kg: p.output_kg, variance_kg: p.variance_kg, tolerance_kg: p.tolerance_kg, needs_approval: p.needs_approval,
  input_m: p.input_m, output_m: p.output_m, problems: p.problems, warnings: p.warnings,
  pieces: p.pieces.map((x) => ({ line_no: x.line_no, kg: x.kg, meters: x.meters ?? null, output_type: x.output_type, warehouse_id: x.warehouse_id ?? null, carries: x.carries })),
});

// ------------------------------------------------------------------ summary (register KPIs)

/** Received (purchase) rolls / KG never change after a cut; pieces now = live rolls of the same receipts. */
fabricRollsRouter.get(`${BASE}/summary`, VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ grn_id: z.coerce.number().int().positive().optional(), warehouse_id: z.coerce.number().int().positive().optional(),
    fabric_id: z.coerce.number().int().positive().optional(), so_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const w = ['fr.company_id = ?']; const p: unknown[] = [cid];
  if (q.grn_id) { w.push('fr.grn_id = ?'); p.push(q.grn_id); }
  if (q.fabric_id) { w.push('fr.fabric_id = ?'); p.push(q.fabric_id); }
  if (q.so_id) { w.push('fr.so_id = ?'); p.push(q.so_id); }
  const whereAll = w.join(' AND ');
  const whW = q.warehouse_id ? ' AND fr.warehouse_id = ?' : '';
  const whP = q.warehouse_id ? [q.warehouse_id] : [];
  const row = await queryOne<any>(`SELECT
      SUM(fr.roll_origin = 'RECEIPT') received_rolls,
      ROUND(COALESCE(SUM(IF(fr.roll_origin = 'RECEIPT', COALESCE(fr.original_weight_kg, fr.weight_kg), 0)), 0), 3) received_kg,
      SUM(${LIVE_ROLL_SQL()} AND fr.weight_kg - fr.issued_kg > 0.0005 ${whW}) pieces_in_store,
      ROUND(COALESCE(SUM(IF(${LIVE_ROLL_SQL()} ${whW}, GREATEST(fr.weight_kg - fr.issued_kg, 0), 0)), 0), 3) balance_kg,
      SUM(${LIVE_ROLL_SQL()} AND fr.issued_kg > 0.0005 AND fr.weight_kg - fr.issued_kg <= 0.0005) pieces_issued,
      SUM(fr.stock_status = 'SPLIT') split_rolls, SUM(fr.stock_status = 'MERGED') merged_rolls,
      SUM(fr.roll_origin = 'SPLIT') cut_pieces,
      SUM(fr.roll_origin IN ('SPLIT', 'RETURN') AND ${LIVE_ROLL_SQL()} AND fr.weight_kg - fr.issued_kg > 0.0005 ${whW}) remnants_in_store,
      SUM(fr.qc_status = 'HOLD' AND ${LIVE_ROLL_SQL()} ${whW}) on_hold
    FROM trx_fabric_roll fr WHERE ${whereAll}`, [...whP, ...whP, ...whP, ...whP, ...p]);
  const loss = await queryOne<any>(`SELECT ROUND(COALESCE(SUM(s.variance_kg), 0), 3) kg, ROUND(COALESCE(SUM(s.loss_value), 0), 2) value
      FROM trx_fabric_roll_split s JOIN trx_fabric_roll fr ON fr.id = s.parent_roll_id WHERE s.status = 'POSTED' AND ${whereAll}`, p);
  const pending = await queryOne<any>(`SELECT COUNT(*) c FROM trx_fabric_roll_split WHERE company_id = ? AND status = 'PENDING_APPROVAL'`, [cid]);
  res.json({ data: {
    received_rolls: n(row?.received_rolls), received_kg: n(row?.received_kg), pieces_in_store: n(row?.pieces_in_store), balance_kg: n(row?.balance_kg),
    pieces_issued: n(row?.pieces_issued), split_rolls: n(row?.split_rolls), merged_rolls: n(row?.merged_rolls), cut_pieces: n(row?.cut_pieces),
    remnants_in_store: n(row?.remnants_in_store), on_hold: n(row?.on_hold), cut_loss_kg: n(loss?.kg), cut_loss_value: n(loss?.value), pending_approvals: n(pending?.c),
  } });
}));

// ------------------------------------------------------------------ split

fabricRollsRouter.get(`${BASE}/:id/split-info`, VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = idParam(req);
  const r = await queryOne<any>(`SELECT fr.*, fb.fabric_name, fb.fabric_code, w.warehouse_name, g.grn_no, COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no,
      ROUND(fr.weight_kg - fr.issued_kg, 3) left_kg
     FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
     LEFT JOIN trx_sales_order so ON so.id = fr.so_id WHERE fr.id = ? AND fr.company_id = ?`, [id, cid]);
  if (!r) throw NotFound('Roll not found');
  const [lays, quotes, drafts, pending] = await Promise.all([
    query<any>(`SELECT a.alloc_kg, lp.lay_no FROM trx_lay_roll_alloc a LEFT JOIN trx_lay_plan lp ON lp.id = a.lay_id WHERE a.fabric_roll_id = ? AND a.status = 'RESERVED'`, [id]),
    query<any>(`SELECT q.quotation_no, ROUND(GREATEST(qr.qty_kg - COALESCE((SELECT SUM(ri.weight_kg) FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id
          WHERE ri.fabric_roll_id = qr.fabric_roll_id AND o.quotation_id = qr.quotation_id AND o.status <> 'CANCELLED'), 0), 0), 3) open_kg
        FROM trx_quotation_roll qr JOIN trx_quotation q ON q.id = qr.quotation_id LEFT JOIN cfg_status cs ON cs.id = q.status_id
       WHERE qr.fabric_roll_id = ? AND COALESCE(q.is_deleted, 0) = 0 AND COALESCE(cs.code, '') NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'LOST')`, [id]),
    query<any>(`SELECT DISTINCT o.fpo_no FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id WHERE ri.fabric_roll_id = ? AND ri.status = 'DRAFT' AND o.status = 'DRAFT'`, [id]),
    query<any>(`SELECT split_no FROM trx_fabric_roll_split WHERE parent_roll_id = ? AND status = 'PENDING_APPROVAL'`, [id]),
  ]);
  const st = await transaction(async (tx) => splitSettings(tx, cid));
  res.json({ data: {
    roll: r, left_kg: n(r.left_kg), reservations: { lays, quotes: quotes.filter((x) => n(x.open_kg) > 0.0005), drafts: drafts.map((d) => d.fpo_no), pending: pending.map((x) => x.split_no) },
    tolerance: { kg: st.tolKg, pct: st.tolPct, effective_kg: r3(Math.max(st.tolKg, n(r.left_kg) * st.tolPct / 100)) },
    can_approve: has(req, 'INVENTORY.ADJUST'), reasons: SPLIT_REASONS.filter((x) => x !== 'AUTO_DC'), output_types: OUTPUT_TYPES.filter((x) => x !== 'ISSUE'),
  } });
}));

fabricRollsRouter.post(`${BASE}/:id/split-preview`, EDIT, ah(async (req, res) => {
  const id = idParam(req);
  const b = splitSchema.parse(req.body ?? {});
  const plan = await transaction(async (tx) => planSplit(tx, ctxOf(req), inputOf(id, b)));
  res.json({ data: { ...shapePlan(plan), can_post: !plan.problems.length, will_wait_for_approval: plan.needs_approval && !ctxOf(req).canApprove } });
}));

fabricRollsRouter.post(`${BASE}/:id/split`, EDIT, ah(async (req, res) => {
  const id = idParam(req);
  const b = splitSchema.parse(req.body ?? {});
  const out = await transaction(async (tx) => requestSplit(tx, ctxOf(req), inputOf(id, b)));
  const data = { split_id: out.split_id, split_no: out.split_no, status: out.status, parent_roll_no: out.plan.roll.roll_no, variance_kg: out.plan.variance_kg, children: out.children };
  await audit(req, 'trx_fabric_roll_split', out.split_id, 'INSERT', undefined, { ...data, request: b });
  res.status(201).json({ data, message: out.status === 'POSTED'
    ? `${out.split_no}: ${out.plan.roll.roll_no} cut into ${out.children.map((c) => `${c.roll_no} (${c.weight_kg} KG)`).join(', ')}${out.plan.variance_kg > 0 ? ` · ${out.plan.variance_kg} KG cutting loss booked` : ''}`
    : `${out.split_no}: cutting loss ${out.plan.variance_kg} KG is above the ${out.plan.tolerance_kg} KG tolerance — sent to the store supervisor for approval` });
}));

fabricRollsRouter.get(`${BASE}/splits`, VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ status: z.string().max(20).optional(), roll_id: z.coerce.number().int().positive().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
  const w = ['s.company_id = ?']; const p: unknown[] = [cid];
  if (q.status) { w.push('s.status = ?'); p.push(q.status); }
  if (q.roll_id) { w.push('(s.parent_roll_id = ? OR EXISTS (SELECT 1 FROM trx_fabric_roll_split_line l2 WHERE l2.split_id = s.id AND l2.child_roll_id = ?))'); p.push(q.roll_id, q.roll_id); }
  if (q.from) { w.push('s.split_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('s.split_date <= ?'); p.push(q.to); }
  const rows = await query<any>(`SELECT s.*, ur.full_name requested_by_name, ua.full_name approved_by_name, fb.fabric_name, w.warehouse_name,
      (SELECT GROUP_CONCAT(CONCAT(COALESCE(l.child_roll_no, CONCAT('#', l.line_no)), ' ', TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM l.weight_kg)), ' KG') ORDER BY l.line_no SEPARATOR ', ')
         FROM trx_fabric_roll_split_line l WHERE l.split_id = s.id) pieces
     FROM trx_fabric_roll_split s JOIN trx_fabric_roll fr ON fr.id = s.parent_roll_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
     LEFT JOIN mst_user ur ON ur.id = s.requested_by LEFT JOIN mst_user ua ON ua.id = s.approved_by
    WHERE ${w.join(' AND ')} ORDER BY s.id DESC LIMIT 1000`, p);
  res.json({ data: rows });
}));

fabricRollsRouter.get(`${BASE}/splits/:id`, VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const s = await queryOne<any>(`SELECT s.*, ur.full_name requested_by_name, ua.full_name approved_by_name FROM trx_fabric_roll_split s
     LEFT JOIN mst_user ur ON ur.id = s.requested_by LEFT JOIN mst_user ua ON ua.id = s.approved_by WHERE s.id = ? AND s.company_id = ?`, [idParam(req), cid]);
  if (!s) throw NotFound('Split not found');
  const lines = await query<any>(`SELECT l.*, w.warehouse_name FROM trx_fabric_roll_split_line l LEFT JOIN mst_warehouse w ON w.id = l.warehouse_id WHERE l.split_id = ? ORDER BY l.line_no`, [s.id]);
  res.json({ data: { ...s, lines } });
}));

fabricRollsRouter.post(`${BASE}/splits/:id/approve`, APPROVE, ah(async (req, res) => {
  const id = idParam(req);
  const remarks = z.string().trim().max(255).nullish().parse(req.body?.remarks) ?? null;
  const children = await transaction(async (tx) => approveSplit(tx, ctxOf(req), id, remarks));
  const s = await queryOne<any>('SELECT split_no, parent_roll_no, variance_kg FROM trx_fabric_roll_split WHERE id = ?', [id]);
  await audit(req, 'trx_fabric_roll_split', id, 'UPDATE', undefined, { action: 'APPROVE', remarks, children });
  res.json({ data: { children }, message: `${s.split_no} approved: ${s.parent_roll_no} cut into ${children.map((c) => `${c.roll_no} (${c.weight_kg} KG)`).join(', ')} · ${r3(s.variance_kg)} KG cutting loss booked` });
}));

fabricRollsRouter.post(`${BASE}/splits/:id/reject`, APPROVE, ah(async (req, res) => {
  const id = idParam(req);
  const remarks = z.string().trim().min(3, 'Give the reason').max(255).parse(req.body?.remarks);
  const s = await transaction(async (tx) => rejectSplit(tx, ctxOf(req), id, remarks));
  await audit(req, 'trx_fabric_roll_split', id, 'UPDATE', undefined, { action: 'REJECT', remarks });
  res.json({ message: `${s.split_no} rejected — ${s.parent_roll_no} is unchanged` });
}));

// ------------------------------------------------------------------ transfer

fabricRollsRouter.post(`${BASE}/transfer`, EDIT, ah(async (req, res) => {
  const b = z.object({
    roll_ids: z.array(z.coerce.number().int().positive()).min(1, 'Pick the rolls to move').max(500),
    to_warehouse_id: z.coerce.number().int().positive({ message: 'Pick the store' }),
    to_location_bin: z.string().trim().max(50).nullish().transform((v) => v || null),
    reason: z.string().trim().min(3, 'Give the reason').max(255),
    transfer_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).parse(req.body ?? {});
  if (b.transfer_date && b.transfer_date > today()) throw BadRequest('The transfer date cannot be in the future');
  const out = await transaction(async (tx) => transferRolls(tx, ctxOf(req), { roll_ids: b.roll_ids, to_warehouse_id: b.to_warehouse_id, to_location_bin: b.to_location_bin, reason: b.reason, date: b.transfer_date ?? today() }));
  await audit(req, 'trx_fabric_roll_transfer', out.id, 'INSERT', undefined, { ...out, roll_ids: b.roll_ids });
  res.status(201).json({ data: out, message: `${out.transfer_no}: ${out.rolls} roll(s), ${out.total_kg} KG moved to ${out.to}${b.to_location_bin ? ` / ${b.to_location_bin}` : ''}` });
}));

fabricRollsRouter.get(`${BASE}/transfers`, VIEW, ah(async (req, res) => {
  const rows = await query<any>(`SELECT t.*, w.warehouse_name to_warehouse, u.full_name created_by_name,
      (SELECT GROUP_CONCAT(l.roll_no ORDER BY l.id SEPARATOR ', ') FROM trx_fabric_roll_transfer_line l WHERE l.transfer_id = t.id) rolls
     FROM trx_fabric_roll_transfer t LEFT JOIN mst_warehouse w ON w.id = t.to_warehouse_id LEFT JOIN mst_user u ON u.id = t.created_by
    WHERE t.company_id = ? ORDER BY t.id DESC LIMIT 500`, [req.user!.companyId]);
  res.json({ data: rows });
}));

// ------------------------------------------------------------------ labels

/** POST /labels { roll_ids, reprint_reason? } — label data. A roll printed before is a reprint: needs the right + a reason. */
fabricRollsRouter.post(`${BASE}/labels`, EDIT, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({ roll_ids: z.array(z.coerce.number().int().positive()).min(1, 'Pick the rolls').max(500), reprint_reason: z.string().trim().max(255).nullish() }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const rows = await txQuery<any>(tx, `SELECT fr.id, fr.roll_no, fr.supplier_roll_no, fr.lot_no, fr.shade, fr.gsm, fr.actual_gsm, fr.dia, fr.color_name, fr.process_state, fr.stock_status,
        fr.qc_status, fr.roll_origin, fr.weight_kg, fr.issued_kg, ROUND(fr.weight_kg - fr.issued_kg, 3) balance_kg, fr.meters, fr.location_bin, fb.fabric_name, fb.fabric_code,
        w.warehouse_name, g.grn_no, g.grn_date, COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, p.roll_no parent_roll_no,
        (SELECT COUNT(*) FROM trx_fabric_roll_label l WHERE l.roll_id = fr.id) prints
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = fr.so_id LEFT JOIN trx_fabric_roll p ON p.id = fr.parent_roll_id
      WHERE fr.company_id = ? AND fr.id IN (?) ORDER BY fr.roll_no`, [cid, b.roll_ids]);
    if (rows.length !== new Set(b.roll_ids).size) throw NotFound('A roll was not found');
    const dead = rows.filter((r) => ['SPLIT', 'MERGED', 'CLOSED'].includes(r.stock_status));
    if (dead.length) throw BadRequest(`${dead.map((r) => r.roll_no).join(', ')} ${dead.length > 1 ? 'are' : 'is'} no longer a roll in stock (${dead.map((r) => r.stock_status.toLowerCase()).join(', ')}) — print its pieces`);
    const re = rows.filter((r) => n(r.prints) > 0);
    if (re.length) {
      if (!has(req, 'INVENTORY.UPDATE')) throw Forbidden(`${re.map((r) => r.roll_no).join(', ')} already printed — reprinting needs the Inventory Update right`);
      if (!b.reprint_reason || b.reprint_reason.length < 3) throw BadRequest(`${re.map((r) => r.roll_no).join(', ')} already printed — give the reprint reason`);
    }
    for (const r of rows) {
      const again = n(r.prints) > 0;
      if (again) await txExecute(tx, `UPDATE trx_fabric_roll_label SET status = 'VOID' WHERE roll_id = ? AND status = 'ACTIVE'`, [r.id]);
      await txExecute(tx, `INSERT INTO trx_fabric_roll_label (company_id, roll_id, roll_no, print_kind, reprint_reason, balance_kg, printed_by) VALUES (?,?,?,?,?,?,?)`,
        [cid, r.id, r.roll_no, again ? 'REPRINT' : 'FIRST', again ? b.reprint_reason : null, r3(r.balance_kg), req.user!.id]);
    }
    return rows;
  });
  await audit(req, 'trx_fabric_roll_label', out[0].id, 'INSERT', undefined, { rolls: out.map((r) => r.roll_no), reprint_reason: b.reprint_reason ?? null });
  res.json({ data: out });
}));

// ------------------------------------------------------------------ family tree

/** GET /:id/family — the root roll of the family and every piece made from it (split / merge / return / transfer), as a tree. */
fabricRollsRouter.get(`${BASE}/:id/family`, VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  let id = idParam(req);
  const cols = `fr.id, fr.roll_no, fr.parent_roll_id, fr.roll_origin, fr.stock_status, fr.qc_status, fr.weight_kg, fr.issued_kg, ROUND(fr.weight_kg - fr.issued_kg, 3) balance_kg,
    COALESCE(fr.original_weight_kg, fr.weight_kg) original_weight_kg, fr.created_at, w.warehouse_name, fr.split_id, s.split_no`;
  const one = (rid: number) => queryOne<any>(`SELECT ${cols} FROM trx_fabric_roll fr LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id LEFT JOIN trx_fabric_roll_split s ON s.id = fr.split_id WHERE fr.id = ? AND fr.company_id = ?`, [rid, cid]);
  let cur = await one(id);
  if (!cur) throw NotFound('Roll not found');
  // walk up while the parent link is a split / return / transfer / merge (process outputs start a new family)
  for (let i = 0; i < 30 && cur.parent_roll_id && cur.roll_origin !== 'RECEIPT'; i++) { const p = await one(Number(cur.parent_roll_id)); if (!p) break; cur = p; id = p.id; }
  const nodes: any[] = [cur];
  let frontier = [Number(cur.id)];
  for (let depth = 0; depth < 30 && frontier.length; depth++) {
    const kids = await query<any>(`SELECT ${cols} FROM trx_fabric_roll fr LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id LEFT JOIN trx_fabric_roll_split s ON s.id = fr.split_id
        WHERE fr.company_id = ? AND fr.parent_roll_id IN (?) AND fr.roll_origin <> 'RECEIPT' ORDER BY fr.id`, [cid, frontier]);
    nodes.push(...kids);
    frontier = kids.map((k) => Number(k.id));
  }
  const live = nodes.filter((x) => !['SPLIT', 'MERGED', 'CLOSED'].includes(x.stock_status) && n(x.balance_kg) > 0.0005);
  res.json({ data: { root_id: Number(cur.id), nodes, pieces_in_store: live.length, balance_kg: r3(live.reduce((a, x) => a + n(x.balance_kg), 0)) } });
}));

// ------------------------------------------------------------------ reports

type F = { from?: string; to?: string; grn_id?: number; warehouse_id?: number; fabric_id?: number };
const REPORTS: Record<string, (cid: number, f: F) => Promise<any[]>> = {
  /** Per GRN line: rolls / KG received (never change) vs pieces now, in store, issued, cut loss. */
  'grn-reconciliation': async (cid, f) => (await query<any>(
    `SELECT ANY_VALUE(g.grn_no) grn_no, ANY_VALUE(g.grn_date) grn_date, ANY_VALUE(sup.party_name) supplier, ANY_VALUE(fb.fabric_name) fabric_name, ANY_VALUE(gl.lot_no) lot_no, ANY_VALUE(g.id) grn_id,
            SUM(fr.roll_origin = 'RECEIPT') received_rolls, ROUND(SUM(IF(fr.roll_origin = 'RECEIPT', COALESCE(fr.original_weight_kg, fr.weight_kg), 0)), 3) received_kg,
            SUM(${LIVE_ROLL_SQL()}) pieces_now, SUM(${LIVE_ROLL_SQL()} AND fr.weight_kg - fr.issued_kg > 0.0005) pieces_in_store,
            ROUND(SUM(IF(${LIVE_ROLL_SQL()}, GREATEST(fr.weight_kg - fr.issued_kg, 0), 0)), 3) in_store_kg,
            SUM(fr.stock_status = 'SPLIT') cut_rolls, SUM(fr.roll_origin = 'SPLIT') cut_pieces,
            ROUND(COALESCE((SELECT SUM(s.variance_kg) FROM trx_fabric_roll_split s JOIN trx_fabric_roll p ON p.id = s.parent_roll_id WHERE p.grn_line_id = gl.id AND s.status = 'POSTED'), 0), 3) cut_loss_kg
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
       LEFT JOIN mst_party sup ON sup.id = g.supplier_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
      WHERE fr.company_id = ? ${f.grn_id ? 'AND fr.grn_id = ?' : ''} ${f.fabric_id ? 'AND fr.fabric_id = ?' : ''} ${f.from ? 'AND g.grn_date >= ?' : ''} ${f.to ? 'AND g.grn_date <= ?' : ''}
      GROUP BY gl.id ORDER BY ANY_VALUE(g.grn_date) DESC, ANY_VALUE(g.id) DESC, gl.id LIMIT 2000`,
    [cid, ...(f.grn_id ? [f.grn_id] : []), ...(f.fabric_id ? [f.fabric_id] : []), ...(f.from ? [f.from] : []), ...(f.to ? [f.to] : [])]))
    // out of store = on DCs / with contractors / consumed / adjusted: received − in store − cutting loss
    .map((r) => ({ ...r, out_of_store_kg: r3(n(r.received_kg) - n(r.in_store_kg) - n(r.cut_loss_kg)) })),

  /** Remnants: pieces left in store after a cut / a return, with age and where they came from. */
  remnants: async (cid, f) => query<any>(
    `SELECT fr.id, fr.roll_no, p.roll_no parent_roll_no, fr.roll_origin, fb.fabric_name, fr.lot_no, fr.color_name, fr.gsm, fr.dia, w.warehouse_name, fr.location_bin,
            COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no, ROUND(fr.weight_kg - fr.issued_kg, 3) balance_kg, fr.qc_status, DATE(fr.created_at) created_on,
            DATEDIFF(CURDATE(), DATE(fr.created_at)) age_days
       FROM trx_fabric_roll fr LEFT JOIN trx_fabric_roll p ON p.id = fr.parent_roll_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
       LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id LEFT JOIN trx_sales_order so ON so.id = fr.so_id
      WHERE fr.company_id = ? AND fr.roll_origin IN ('SPLIT', 'RETURN') AND ${LIVE_ROLL_SQL()} AND fr.weight_kg - fr.issued_kg > 0.0005
        ${f.warehouse_id ? 'AND fr.warehouse_id = ?' : ''} ${f.fabric_id ? 'AND fr.fabric_id = ?' : ''}
      ORDER BY age_days DESC, fr.id LIMIT 3000`, [cid, ...(f.warehouse_id ? [f.warehouse_id] : []), ...(f.fabric_id ? [f.fabric_id] : [])]),

  /** Ageing of every roll in store: days since received (GRN) and since its last movement. */
  ageing: async (cid, f) => {
    const rows = await query<any>(
      `SELECT fr.id, fr.roll_no, fr.roll_origin, fb.fabric_name, fr.lot_no, fr.color_name, w.warehouse_name, fr.location_bin, COALESCE(NULLIF(so.io_no, ''), so.so_no) job_no,
              ROUND(fr.weight_kg - fr.issued_kg, 3) balance_kg, g.grn_no, g.grn_date, DATEDIFF(CURDATE(), g.grn_date) days_in_store,
              (SELECT MAX(h.event_time) FROM trx_fabric_roll_history h WHERE h.roll_id = fr.id) last_movement
         FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
         LEFT JOIN trx_sales_order so ON so.id = fr.so_id
        WHERE fr.company_id = ? AND ${LIVE_ROLL_SQL()} AND fr.weight_kg - fr.issued_kg > 0.0005 ${f.warehouse_id ? 'AND fr.warehouse_id = ?' : ''} ${f.fabric_id ? 'AND fr.fabric_id = ?' : ''}
        ORDER BY days_in_store DESC LIMIT 5000`, [cid, ...(f.warehouse_id ? [f.warehouse_id] : []), ...(f.fabric_id ? [f.fabric_id] : [])]);
    const bucket = (d: number) => (d <= 30 ? '0–30' : d <= 60 ? '31–60' : d <= 90 ? '61–90' : d <= 180 ? '91–180' : '180+');
    return rows.map((r) => ({ ...r, bucket: bucket(n(r.days_in_store)), days_since_movement: r.last_movement ? Math.floor((Date.now() - new Date(r.last_movement).getTime()) / 86400000) : null }));
  },

  /** Cutting loss / variance per posted split: input vs pieces, loss KG and value, who approved. */
  'cut-loss': async (cid, f) => query<any>(
    `SELECT s.split_no, s.split_date, s.parent_roll_no, fb.fabric_name, s.reason_code, s.source, s.source_ref_no, s.input_kg, s.output_kg, s.variance_kg, s.tolerance_kg,
            s.cost_per_kg, s.loss_value, s.status, ur.full_name requested_by, ua.full_name approved_by, s.remarks
       FROM trx_fabric_roll_split s JOIN trx_fabric_roll fr ON fr.id = s.parent_roll_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
       LEFT JOIN mst_user ur ON ur.id = s.requested_by LEFT JOIN mst_user ua ON ua.id = s.approved_by
      WHERE s.company_id = ? AND s.status IN ('POSTED', 'PENDING_APPROVAL', 'REJECTED') ${f.from ? 'AND s.split_date >= ?' : ''} ${f.to ? 'AND s.split_date <= ?' : ''}
      ORDER BY s.id DESC LIMIT 3000`, [cid, ...(f.from ? [f.from] : []), ...(f.to ? [f.to] : [])]),

  /** Roll book balance vs the stock ledger, per fabric and store. A difference means a movement posted only one side. */
  'ledger-reconciliation': async (cid, f) => {
    const rolls = await query<any>(`SELECT fr.fabric_id, fr.warehouse_id, fb.fabric_name, w.warehouse_name, COUNT(*) pieces, ROUND(SUM(GREATEST(fr.weight_kg - fr.issued_kg, 0)), 3) roll_kg
        FROM trx_fabric_roll fr LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
       WHERE fr.company_id = ? AND ${LIVE_ROLL_SQL()} AND fr.weight_kg - fr.issued_kg > 0.0005 ${f.warehouse_id ? 'AND fr.warehouse_id = ?' : ''}
       GROUP BY fr.fabric_id, fr.warehouse_id`, [cid, ...(f.warehouse_id ? [f.warehouse_id] : [])]);
    const led = await query<any>(`SELECT l.fabric_id, l.warehouse_id, ROUND(SUM(l.qty_in - l.qty_out), 3) ledger_kg FROM trx_stock_ledger l
       WHERE l.company_id = ? AND l.material_type = 'FABRIC' ${f.warehouse_id ? 'AND l.warehouse_id = ?' : ''} GROUP BY l.fabric_id, l.warehouse_id`, [cid, ...(f.warehouse_id ? [f.warehouse_id] : [])]);
    const key = (a: any) => `${a.fabric_id ?? 0}|${a.warehouse_id ?? 0}`;
    const lm = new Map(led.map((l) => [key(l), n(l.ledger_kg)]));
    const out = rolls.map((r) => ({ ...r, ledger_kg: r3(lm.get(key(r)) ?? 0), difference_kg: r3(n(r.roll_kg) - (lm.get(key(r)) ?? 0)) }));
    for (const l of led) if (!rolls.some((r) => key(r) === key(l)) && Math.abs(n(l.ledger_kg)) > 0.0005) out.push({ fabric_id: l.fabric_id, warehouse_id: l.warehouse_id, fabric_name: null, warehouse_name: null, pieces: 0, roll_kg: 0, ledger_kg: n(l.ledger_kg), difference_kg: r3(-n(l.ledger_kg)) });
    return out.sort((a, b) => Math.abs(b.difference_kg) - Math.abs(a.difference_kg));
  },

  /** Label prints and reprints (who, when, why). */
  labels: async (cid, f) => query<any>(
    `SELECT l.printed_at, l.roll_no, l.print_kind, l.reprint_reason, l.balance_kg, l.status, u.full_name printed_by
       FROM trx_fabric_roll_label l LEFT JOIN mst_user u ON u.id = l.printed_by
      WHERE l.company_id = ? ${f.from ? 'AND DATE(l.printed_at) >= ?' : ''} ${f.to ? 'AND DATE(l.printed_at) <= ?' : ''} ORDER BY l.id DESC LIMIT 3000`,
    [cid, ...(f.from ? [f.from] : []), ...(f.to ? [f.to] : [])]),
};

fabricRollsRouter.get(`${BASE}/reports/:key`, VIEW, ah(async (req, res) => {
  const fn = REPORTS[String(req.params.key)];
  if (!fn) throw NotFound('Unknown report');
  const f = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    grn_id: z.coerce.number().int().positive().optional(), warehouse_id: z.coerce.number().int().positive().optional(), fabric_id: z.coerce.number().int().positive().optional() })
    .parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '' && v != null)));
  res.json({ data: await fn(req.user!.companyId, f) });
}));

/** GET /inventory/fabric-rolls/split-history/:id — all split documents touching a roll (for the roll detail). */
fabricRollsRouter.get(`${BASE}/:id/splits`, VIEW, ah(async (req, res) => {
  const id = idParam(req);
  const rows = await query<any>(`SELECT s.id, s.split_no, s.split_date, s.status, s.parent_roll_no, s.input_kg, s.output_kg, s.variance_kg FROM trx_fabric_roll_split s
     WHERE s.company_id = ? AND (s.parent_roll_id = ? OR s.id = (SELECT split_id FROM trx_fabric_roll WHERE id = ? AND roll_origin = 'SPLIT')) ORDER BY s.id`, [req.user!.companyId, id, id]);
  res.json({ data: rows });
}));

