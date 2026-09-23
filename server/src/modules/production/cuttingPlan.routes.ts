import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { txResolvePartName } from '../../core/partName.js';
import { lockBundle, assertActive, addMovement } from './bundleLedger.js';
import {
  PLAN_STATUSES, DERIVED_STATUSES, MANUAL_TRANSITIONS, checkOverCut, hasPerm, lockPlan,
  maxCutQty, nextUniqueDocNo, refreshPlanStatus, generateBundlesLegacy, computeConsumption, computeReconFigures, num,
} from './cuttingEngine.js';

export const cuttingPlanRouter = Router();

// ============================================================
// CUT ORDER (CUTTING PLAN) — doc §5
//   DRAFT → APPROVED / RELEASED → IN_PROGRESS → PARTIALLY_COMPLETED
//         → COMPLETED → CLOSED   (+ CANCELLED)
// IN_PROGRESS / PARTIALLY_COMPLETED / COMPLETED are derived from lay
// execution; CLOSED only comes from cutting reconciliation.
// ============================================================

const sizeLineSchema = z.object({
  size_id: s.idReq(),
  sku_id: s.id(),
  order_qty: z.coerce.number().int().min(0).default(0),
  planned_qty: z.coerce.number().int().min(0).default(0),
});

const cuttingPlanSchema = z.object({
  plan_no: s.nullableStr(40),
  plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.strReq(40),
  so_id: s.id(),
  so_line_id: s.id(),
  prod_order_id: s.id(),
  style_id: s.idReq(),
  color_id: s.id(),
  order_qty: z.coerce.number().int().min(0).default(0),
  planned_cut_qty: z.coerce.number().int().min(0).default(0),
  over_cut_pct: z.coerce.number().min(0).max(100).default(0),
  over_cut_reason: s.nullableStr(255),
  required_date: s.date(),
  cutting_location: s.nullableStr(80),
  marker_ref: s.nullableStr(60),
  marker_eff_pct: s.dec(),
  fabric_id: s.id(),
  fabric_req_kg: s.dec(),
  fabric_req_mtr: s.dec(),
  status: z.enum(PLAN_STATUSES).default('DRAFT'),
  status_reason: s.nullableStr(255),
  remarks: s.text(),
  part_name: z.string().trim().max(50).optional(),
  sizes: z.array(sizeLineSchema).default([]),
});
type PlanBody = z.infer<typeof cuttingPlanSchema>;

/** Planned qty + size lines must stay inside the authorised over-cut ceiling. */
function validatePlanQty(req: any, body: PlanBody): boolean {
  const ids = body.sizes.map((x) => x.size_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('Each size may appear only once in the size breakdown');
  const sizePlanned = body.sizes.reduce((a, x) => a + x.planned_qty, 0);
  const sizeOrder = body.sizes.reduce((a, x) => a + x.order_qty, 0);
  const plan = { order_qty: body.order_qty || sizeOrder, over_cut_pct: body.over_cut_pct };
  let override = checkOverCut(req, plan, body.planned_cut_qty, 'Planned cut qty', body.over_cut_reason);
  if (sizePlanned > 0) override = checkOverCut(req, plan, sizePlanned, 'Size-wise planned qty', body.over_cut_reason) || override;
  for (const x of body.sizes) {
    if (x.order_qty > 0) {
      override = checkOverCut(req, { order_qty: x.order_qty, over_cut_pct: body.over_cut_pct },
        x.planned_qty, `Size line (size id ${x.size_id}) planned qty`, body.over_cut_reason) || override;
    }
  }
  return override;
}

function assertManualTransition(req: any, from: string, to: string) {
  if (from === to) return;
  if (to === 'CLOSED') throw BadRequest('A cut order is closed through Cutting Reconciliation, not by editing its status');
  if (DERIVED_STATUSES.includes(to as any)) {
    throw BadRequest(`${to} is set automatically from lay execution and cannot be chosen by hand`);
  }
  const allowed = MANUAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to as any)) throw BadRequest(`Cut order cannot move from ${from} to ${to}`);
  if ((to === 'APPROVED' || to === 'RELEASED') && !hasPerm(req, 'PRODUCTION.APPROVE')) {
    throw Forbidden(`Moving a cut order to ${to} needs PRODUCTION.APPROVE`);
  }
}

const PLAN_SELECT = `SELECT cp.*,
            st.style_code, st.style_name,
            col.color_name,
            so.so_no,
            po.po_prod_no,
            fab.fabric_name,
            GREATEST(COALESCE(NULLIF(cp.planned_cut_qty,0), cp.order_qty, 0) - COALESCE(cp.actual_cut_qty,0), 0) AS balance_qty
       FROM trx_cutting_plan cp
       LEFT JOIN mst_style st ON st.id = cp.style_id
       LEFT JOIN mst_color col ON col.id = cp.color_id
       LEFT JOIN trx_sales_order so ON so.id = cp.so_id
       LEFT JOIN trx_production_order po ON po.id = cp.prod_order_id
       LEFT JOIN mst_fabric fab ON fab.id = cp.fabric_id`;

/** GET /cutting-plans — List all cutting plans */
cuttingPlanRouter.get('/cutting-plans', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: any[] = [cid];
  let where = 'WHERE cp.company_id = ?';
  if (req.query.status) { where += ' AND cp.status = ?'; params.push(String(req.query.status)); }
  if (req.query.io_no) { where += ' AND cp.io_no = ?'; params.push(String(req.query.io_no)); }
  const rows = await query(`${PLAN_SELECT} ${where} ORDER BY cp.plan_date DESC, cp.id DESC`, params);
  res.json({ data: rows });
}));

/** GET /cutting-plans/:id — Single cutting plan with size breakdown, lays, DCs and consumption */
cuttingPlanRouter.get('/cutting-plans/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(`${PLAN_SELECT} WHERE cp.id = ? AND cp.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Cutting plan not found');

  const [sizes, lays, dcs, consumption, reconciliation] = await Promise.all([
    query(
      `SELECT cps.*, sz.size_code, sz.size_label, sz.sort_order, k.sku_code
         FROM trx_cutting_plan_size cps
         LEFT JOIN mst_size sz ON sz.id = cps.size_id
         LEFT JOIN mst_style_sku k ON k.id = cps.sku_id
        WHERE cps.cutting_plan_id = ?
        ORDER BY sz.sort_order`, [id]),
    query(
      `SELECT lp.id, lp.lay_no, lp.lay_date, lp.status, lp.ply_count, lp.expected_pieces, lp.planned_kg,
              lp.actual_kg, lp.actual_cut_qty, lp.marker_ref, lp.marker_version_id, lp.executed_at
         FROM trx_lay_plan lp WHERE lp.cutting_plan_id = ? AND lp.company_id = ? ORDER BY lp.id`, [id, cid]),
    query(
      `SELECT fi.id, fi.issue_no, fi.issue_date, fi.status, fi.total_rolls, fi.total_kg
         FROM trx_fabric_issue fi WHERE fi.cutting_plan_id = ? AND fi.company_id = ? ORDER BY fi.id`, [id, cid]),
    computeConsumption(null, cid, id),
    computeReconFigures(null, cid, id),
  ]);

  res.json({
    data: {
      ...(row as any), sizes, lays, fabric_issues: dcs, consumption, reconciliation,
      max_cut_qty: maxCutQty(row as any),
    },
  });
}));

/** GET /cutting-plans/:id/consumption — Planned vs Marker vs Actual KG/PC (doc §17) */
cuttingPlanRouter.get('/cutting-plans/:id/consumption', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  res.json({ data: await computeConsumption(null, req.user!.companyId, Number(req.params.id)) });
}));

/** POST /cutting-plans — Create new cutting plan */
cuttingPlanRouter.post('/cutting-plans', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = cuttingPlanSchema.parse(req.body);
  if (!['DRAFT', 'APPROVED', 'RELEASED'].includes(body.status)) {
    throw BadRequest('A new cut order starts as DRAFT, APPROVED or RELEASED');
  }
  assertManualTransition(req, 'DRAFT', body.status);
  const override = validatePlanQty(req, body);

  const result = await transaction(async (tx) => {
    const planNo = body.plan_no || await nextUniqueDocNo(tx, cid, 'CUT_PLAN', 'trx_cutting_plan', 'plan_no');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_cutting_plan WHERE company_id = ? AND plan_no = ?`, [cid, planNo]);
    if (dup) throw BadRequest(`Cut order number ${planNo} already exists`);

    // The Sales Order line owns the part; fall back to TOP only when this plan
    // is not linked to a line (Audio 5 carry-forward).
    const partName = await txResolvePartName(tx, body.so_line_id, body.part_name, 'TOP');

    const r = await txExecute(tx,
      `INSERT INTO trx_cutting_plan
        (company_id, plan_no, plan_date, io_no, so_id, so_line_id, prod_order_id, style_id, color_id, part_name,
         order_qty, planned_cut_qty, over_cut_pct, over_cut_reason, over_cut_approved_by, required_date,
         cutting_location, marker_ref, marker_eff_pct,
         fabric_id, fabric_req_kg, fabric_req_mtr, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, planNo, body.plan_date, body.io_no, body.so_id ?? null, body.so_line_id ?? null, body.prod_order_id ?? null,
       body.style_id, body.color_id ?? null, partName, body.order_qty, body.planned_cut_qty,
       body.over_cut_pct, override ? body.over_cut_reason : (body.over_cut_reason ?? null), override ? req.user!.id : null,
       body.required_date ?? null, body.cutting_location ?? null, body.marker_ref ?? null, body.marker_eff_pct ?? null,
       body.fabric_id ?? null, body.fabric_req_kg ?? null, body.fabric_req_mtr ?? null,
       body.status, body.remarks ?? null, req.user!.id]);

    const planId = r.insertId;

    for (const sz of body.sizes) {
      await txExecute(tx,
        `INSERT INTO trx_cutting_plan_size (cutting_plan_id, size_id, sku_id, order_qty, planned_qty)
         VALUES (?,?,?,?,?)`,
        [planId, sz.size_id, sz.sku_id ?? null, sz.order_qty, sz.planned_qty]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_cutting_plan WHERE id = ?`, [planId]);
  });

  await audit(req, 'trx_cutting_plan', (result as any).id, 'INSERT', undefined,
    override ? { ...(result as any), over_cut_override: { by: req.user!.id, reason: body.over_cut_reason } } : result);
  res.status(201).json({ data: result });
}));

/** PUT /cutting-plans/:id — Update cutting plan */
cuttingPlanRouter.put('/cutting-plans/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = cuttingPlanSchema.parse(req.body);

  const { existing, override } = await transaction(async (tx) => {
    const existing = await lockPlan(tx, cid, id);
    if (existing.status === 'CLOSED') throw BadRequest(`Cut order ${existing.plan_no} is CLOSED and read-only — reopen its reconciliation first`);
    if (existing.status === 'CANCELLED') throw BadRequest(`Cut order ${existing.plan_no} is CANCELLED and read-only`);
    assertManualTransition(req, existing.status, body.status);
    if (body.status === 'CANCELLED') await assertCancellable(tx, existing, body.status_reason);

    const override = validatePlanQty(req, body);
    const actual = num(existing.actual_cut_qty);
    if (actual > 0) {
      if (body.style_id !== Number(existing.style_id) || (body.color_id ?? null) !== (existing.color_id ?? null)
        || (body.fabric_id ?? null) !== (existing.fabric_id ?? null)) {
        throw BadRequest('Style, colour and fabric cannot change once lays have been cut against this cut order');
      }
      checkOverCut(req, { order_qty: body.order_qty, over_cut_pct: body.over_cut_pct }, actual, 'Already cut qty', body.over_cut_reason);
    }

    // Size lines may only be replaced before release.
    const released = !['DRAFT', 'APPROVED'].includes(existing.status);
    const currentSizes = await txQuery<any>(tx,
      `SELECT size_id, sku_id, order_qty, planned_qty FROM trx_cutting_plan_size WHERE cutting_plan_id = ? ORDER BY size_id`, [id]);
    const norm = (arr: any[]) => JSON.stringify(arr.map((x) => [Number(x.size_id), Number(x.sku_id) || null, Number(x.order_qty), Number(x.planned_qty)])
      .sort((a, b) => (a[0] as number) - (b[0] as number)));
    const sizesChanged = norm(currentSizes) !== norm(body.sizes);
    if (released && sizesChanged) {
      throw BadRequest(`Size breakdown cannot be changed once the cut order is ${existing.status}`);
    }

    // Keep the part aligned with the linked Sales Order line on every save.
    const partName = await txResolvePartName(
      tx, body.so_line_id, body.part_name, (existing.part_name as any) || 'TOP');

    await txExecute(tx,
      `UPDATE trx_cutting_plan SET
        plan_date = ?, io_no = ?, so_id = ?, so_line_id = ?, prod_order_id = ?, style_id = ?, color_id = ?, part_name = ?,
        order_qty = ?, planned_cut_qty = ?, over_cut_pct = ?, over_cut_reason = ?,
        over_cut_approved_by = IF(?, ?, over_cut_approved_by), required_date = ?, cutting_location = ?,
        marker_ref = ?, marker_eff_pct = ?, fabric_id = ?, fabric_req_kg = ?, fabric_req_mtr = ?, status = ?,
        status_reason = COALESCE(?, status_reason), remarks = ?, updated_by = ?, updated_at = NOW()
       WHERE id = ?`,
      [body.plan_date, body.io_no, body.so_id ?? null, body.so_line_id ?? null, body.prod_order_id ?? null,
       body.style_id, body.color_id ?? null, partName, body.order_qty, body.planned_cut_qty,
       body.over_cut_pct, body.over_cut_reason ?? null, override ? 1 : 0, req.user!.id,
       body.required_date ?? null, body.cutting_location ?? null, body.marker_ref ?? null, body.marker_eff_pct ?? null,
       body.fabric_id ?? null, body.fabric_req_kg ?? null, body.fabric_req_mtr ?? null,
       body.status, body.status !== existing.status ? (body.status_reason ?? null) : null,
       body.remarks ?? null, req.user!.id, id]);

    if (!released && sizesChanged) {
      await txExecute(tx, `DELETE FROM trx_cutting_plan_size WHERE cutting_plan_id = ?`, [id]);
      for (const sz of body.sizes) {
        await txExecute(tx,
          `INSERT INTO trx_cutting_plan_size (cutting_plan_id, size_id, sku_id, order_qty, planned_qty)
           VALUES (?,?,?,?,?)`,
          [id, sz.size_id, sz.sku_id ?? null, sz.order_qty, sz.planned_qty]);
      }
    }
    // Planned qty may have changed the COMPLETED / PARTIALLY_COMPLETED boundary.
    if (actual > 0) await refreshPlanStatus(tx, id);
    return { existing, override };
  });

  const updated = await queryOne(`SELECT * FROM trx_cutting_plan WHERE id = ?`, [id]);
  await audit(req, 'trx_cutting_plan', id, 'UPDATE', existing,
    override ? { ...(updated as any), over_cut_override: { by: req.user!.id, reason: body.over_cut_reason } } : updated);
  res.json({ data: updated });
}));

/** A cut order can be cancelled only before anything was cut and with all fabric returned. */
async function assertCancellable(tx: any, plan: any, reason?: string | null) {
  if (!reason || !reason.trim()) throw BadRequest('A reason is required to cancel a cut order');
  const lays = await txQueryOne<any>(tx,
    `SELECT COUNT(*) AS n FROM trx_lay_plan WHERE cutting_plan_id = ? AND status IN ('CUT','APPROVED')`, [plan.id]);
  if (num(lays?.n) > 0) throw BadRequest('Cut order has executed lays — reverse them before cancelling');
  const open = await txQueryOne<any>(tx,
    `SELECT COALESCE(SUM(fir.issue_kg - fir.consumed_kg - fir.returned_kg),0) AS kg
       FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
      WHERE fi.cutting_plan_id = ?`, [plan.id]);
  if (num(open?.kg) > 0.0005) throw BadRequest(`${num(open?.kg).toFixed(3)} KG of issued fabric is still with cutting — return it to store before cancelling`);
}

/** POST /cutting-plans/:id/status — explicit transition { status, reason } */
cuttingPlanRouter.post('/cutting-plans/:id/status', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ status: z.enum(PLAN_STATUSES), reason: s.nullableStr(255) }).parse(req.body);
  const { before, after } = await transaction(async (tx) => {
    const plan = await lockPlan(tx, cid, id);
    if (plan.status === 'CLOSED') throw BadRequest('Cut order is CLOSED — reopen it from Cutting Reconciliation');
    if (plan.status === 'CANCELLED') throw BadRequest('Cut order is CANCELLED');
    assertManualTransition(req, plan.status, body.status);
    if (body.status === 'CANCELLED') await assertCancellable(tx, plan, body.reason);
    await txExecute(tx,
      `UPDATE trx_cutting_plan SET status = ?, status_reason = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [body.status, body.reason ?? null, req.user!.id, id]);
    return { before: plan, after: await txQueryOne(tx, `SELECT * FROM trx_cutting_plan WHERE id = ?`, [id]) };
  });
  await audit(req, 'trx_cutting_plan', id, 'UPDATE', { status: before.status }, { status: body.status, reason: body.reason });
  res.json({ data: after });
}));


// ============================================================
// BUNDLE MANAGEMENT
// ============================================================

/**
 * POST /bundles/generate — legacy generator (cutting + size + qty). Routed
 * through the validated generator: qty ≤ cut balance, company-wide unique
 * bundle numbers / barcodes, allocated KG.
 */
cuttingPlanRouter.post('/bundles/generate', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    cutting_id: s.idReq(),
    io_no: s.strReq(40),
    style_id: s.idReq(),
    color_id: s.id(),
    size_id: s.idReq(),
    sku_id: s.id(),
    part_name: z.string().trim().max(50).default('TOP'),
    total_qty: z.coerce.number().int().positive(),
    bundle_size: z.coerce.number().int().positive().max(1000),
    component: z.string().trim().max(60).default('BODY'),
    line_destination: s.nullableStr(40),
  }).parse(req.body);

  const result = await transaction((tx) => generateBundlesLegacy(tx, {
    cid, userId: req.user!.id, bundleSize: body.bundle_size, partName: body.part_name,
    components: body.component ? [body.component] : [], lineDestination: body.line_destination,
    cuttingId: body.cutting_id, sizeId: body.size_id, colorId: body.color_id ?? null, styleId: body.style_id,
    ioNo: body.io_no, skuId: body.sku_id ?? null, totalQty: body.total_qty,
  }));
  await audit(req, 'trx_cutting_bundle', result.bundles[0]?.id ?? 0, 'INSERT', undefined,
    { cutting_id: body.cutting_id, size_id: body.size_id, qty: body.total_qty, bundles: result.bundles.map((b: any) => b.bundle_no) });
  res.status(201).json({ data: { bundles: result.bundles, count: result.bundles.length, allocation: result.basis } });
}));

const BUNDLE_COMPANY = `(cb.company_id = ? OR (cb.company_id IS NULL AND c.company_id = ?))`;

/** GET /bundles — List bundles with filtering */
cuttingPlanRouter.get('/bundles', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const f = (k: string) => (req.query[k] ? String(req.query[k]) : null);

  let sql = `SELECT cb.*, c.cut_no, lp.lay_no, co.output_no, cp.plan_no, cp.id AS cutting_plan_id,
                    mv.marker_no, mv.version AS marker_version,
                    st.style_code, col.color_name, sz.size_code, 'PCS' AS uom
       FROM trx_cutting_bundle cb
       LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
       LEFT JOIN trx_lay_plan lp ON lp.id = cb.lay_id
       LEFT JOIN trx_cut_output co ON co.id = cb.cut_output_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = COALESCE(co.cutting_plan_id, c.cutting_plan_id)
       LEFT JOIN trx_marker_version mv ON mv.id = cb.marker_version_id
       LEFT JOIN mst_style st ON st.id = cb.style_id
       LEFT JOIN mst_color col ON col.id = cb.color_id
       LEFT JOIN mst_size sz ON sz.id = cb.size_id
      WHERE ${BUNDLE_COMPANY}`;
  const params: any[] = [cid, cid];

  if (f('io_no')) { sql += ` AND cb.io_no = ?`; params.push(f('io_no')); }
  if (f('status')) { sql += ` AND cb.status = ?`; params.push(f('status')); }
  if (f('part_name')) { sql += ` AND cb.part_name = ?`; params.push(f('part_name')); }
  if (f('lay_id')) { sql += ` AND cb.lay_id = ?`; params.push(Number(f('lay_id'))); }
  if (f('cut_output_id')) { sql += ` AND cb.cut_output_id = ?`; params.push(Number(f('cut_output_id'))); }
  if (f('cutting_plan_id')) { sql += ` AND cp.id = ?`; params.push(Number(f('cutting_plan_id'))); }
  sql += ` ORDER BY cb.id DESC LIMIT 5000`;

  const rows = await query(sql, params);
  res.json({ data: rows });
}));

/**
 * POST /bundles/:id/move — cutting-room verification only (GENERATED → CHECKED).
 * Issue to sewing, sewing, finishing and packing move bundle quantities
 * through the bundle ledger endpoints (productionFloor / job-work DC), which
 * keep balance and stage counters consistent; those stages are rejected here.
 */
const CUTTING_MOVES: Record<string, string[]> = { GENERATED: ['CHECKED'] };
cuttingPlanRouter.post('/bundles/:id/move', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const bundleId = Number(req.params.id);
  const body = z.object({
    to_stage: z.string().trim().toUpperCase(),
    destination: s.nullableStr(80),
    remarks: s.nullableStr(255),
  }).parse(req.body);

  const bundle = await transaction(async (tx) => {
    const bundle = await lockBundle(tx, cid, { id: bundleId });
    assertActive(bundle);
    const allowed = CUTTING_MOVES[bundle.status] ?? [];
    if (!allowed.includes(body.to_stage)) {
      throw BadRequest(`Bundle ${bundle.bundle_no} is ${bundle.status}: this screen only verifies GENERATED bundles (→ CHECKED). `
        + 'Issue / sewing / finishing / packing moves are posted from the sewing-finishing floor and DC screens.');
    }
    await txExecute(tx, `UPDATE trx_cutting_bundle SET status = ? WHERE id = ?`, [body.to_stage, bundleId]);
    await addMovement(tx, req, bundle, {
      txn_type: 'CUT_VERIFY', from_stage: bundle.status, to_stage: body.to_stage,
      qty: Number(bundle.balance_qty ?? bundle.qty), destination: body.destination ?? null, remarks: body.remarks ?? null,
    });
    return bundle;
  });

  await audit(req, 'trx_cutting_bundle', bundleId, 'UPDATE', { status: bundle.status }, { status: body.to_stage });
  res.json({ data: { id: bundleId, status: body.to_stage } });
}));

/** GET /bundles/:id/history — Bundle movement history */
cuttingPlanRouter.get('/bundles/:id/history', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT bm.*, u.full_name AS moved_by_name
       FROM trx_bundle_movement bm
       LEFT JOIN mst_user u ON u.id = bm.moved_by
      WHERE bm.bundle_id = ? AND bm.company_id = ?
      ORDER BY bm.moved_at, bm.id`, [Number(req.params.id), cid]);
  res.json({ data: rows });
}));


// ============================================================
// FG RECEIPT
// ============================================================

const fgLineSchema = z.object({
  color_id: s.idReq(),
  size_id: s.idReq(),
  sku_id: s.id(),
  good_qty: z.coerce.number().int().min(0).default(0),
  reject_qty: z.coerce.number().int().min(0).default(0),
  batch_no: s.nullableStr(40),
});

const fgReceiptSchema = z.object({
  receipt_no: s.nullableStr(40),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.strReq(40),
  so_id: s.id(),
  prod_order_id: s.id(),
  style_id: s.idReq(),
  warehouse_id: s.id(),
  source_stage: z.string().trim().max(40).default('FINISHING'),
  source_ref: s.nullableStr(60),
  status: z.enum(['DRAFT','RECEIVED','CONFIRMED','CLOSED']).default('DRAFT'),
  remarks: s.text(),
  lines: z.array(fgLineSchema).default([]),
});

/** GET /fg-receipts — List all FG receipts */
cuttingPlanRouter.get('/fg-receipts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT fg.*, st.style_code, st.style_name, so.so_no, wh.warehouse_name
       FROM trx_fg_receipt fg
       LEFT JOIN mst_style st ON st.id = fg.style_id
       LEFT JOIN trx_sales_order so ON so.id = fg.so_id
       LEFT JOIN mst_warehouse wh ON wh.id = fg.warehouse_id
      WHERE fg.company_id = ?
      ORDER BY fg.receipt_date DESC, fg.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /fg-receipts/:id — Single FG receipt with lines */
cuttingPlanRouter.get('/fg-receipts/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(
    `SELECT fg.*, st.style_code, st.style_name, so.so_no, wh.warehouse_name
       FROM trx_fg_receipt fg
       LEFT JOIN mst_style st ON st.id = fg.style_id
       LEFT JOIN trx_sales_order so ON so.id = fg.so_id
       LEFT JOIN mst_warehouse wh ON wh.id = fg.warehouse_id
      WHERE fg.id = ? AND fg.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('FG receipt not found');

  const lines = await query(
    `SELECT l.*, col.color_name, sz.size_code, sz.size_label, sz.sort_order, k.sku_code
       FROM trx_fg_receipt_line l
       LEFT JOIN mst_color col ON col.id = l.color_id
       LEFT JOIN mst_size sz ON sz.id = l.size_id
       LEFT JOIN mst_style_sku k ON k.id = l.sku_id
      WHERE l.fg_receipt_id = ?
      ORDER BY col.color_name, sz.sort_order`, [id]);

  res.json({ data: { ...(row as any), lines } });
}));

/** POST /fg-receipts — Create FG receipt */
cuttingPlanRouter.post('/fg-receipts', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = fgReceiptSchema.parse(req.body);

  const totalGood = body.lines.reduce((sum, l) => sum + l.good_qty, 0);
  const totalReject = body.lines.reduce((sum, l) => sum + l.reject_qty, 0);

  const result = await transaction(async (tx) => {
    const receiptNo = body.receipt_no || await nextDocNumber(tx, cid, 'FG_RECEIPT');

    const r = await txExecute(tx,
      `INSERT INTO trx_fg_receipt
        (company_id, receipt_no, receipt_date, io_no, so_id, prod_order_id, style_id,
         warehouse_id, source_stage, source_ref, total_qty, total_reject, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, body.receipt_date, body.io_no, body.so_id ?? null, body.prod_order_id ?? null,
       body.style_id, body.warehouse_id ?? null, body.source_stage, body.source_ref ?? null,
       totalGood, totalReject, body.status, body.remarks ?? null, req.user!.id]);

    const fgId = r.insertId;

    for (const line of body.lines) {
      await txExecute(tx,
        `INSERT INTO trx_fg_receipt_line (fg_receipt_id, color_id, size_id, sku_id, good_qty, reject_qty, batch_no)
         VALUES (?,?,?,?,?,?,?)`,
        [fgId, line.color_id, line.size_id, line.sku_id ?? null, line.good_qty, line.reject_qty, line.batch_no ?? null]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_fg_receipt WHERE id = ?`, [fgId]);
  });

  await audit(req, 'trx_fg_receipt', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));

/** PUT /fg-receipts/:id — Update FG receipt */
cuttingPlanRouter.put('/fg-receipts/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = fgReceiptSchema.parse(req.body);

  const existing = await queryOne(`SELECT * FROM trx_fg_receipt WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('FG receipt not found');

  const totalGood = body.lines.reduce((sum, l) => sum + l.good_qty, 0);
  const totalReject = body.lines.reduce((sum, l) => sum + l.reject_qty, 0);

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_fg_receipt SET
        receipt_date = ?, io_no = ?, so_id = ?, prod_order_id = ?, style_id = ?,
        warehouse_id = ?, source_stage = ?, source_ref = ?, total_qty = ?, total_reject = ?,
        status = ?, remarks = ?
       WHERE id = ?`,
      [body.receipt_date, body.io_no, body.so_id ?? null, body.prod_order_id ?? null,
       body.style_id, body.warehouse_id ?? null, body.source_stage, body.source_ref ?? null,
       totalGood, totalReject, body.status, body.remarks ?? null, id]);

    await txExecute(tx, `DELETE FROM trx_fg_receipt_line WHERE fg_receipt_id = ?`, [id]);
    for (const line of body.lines) {
      await txExecute(tx,
        `INSERT INTO trx_fg_receipt_line (fg_receipt_id, color_id, size_id, sku_id, good_qty, reject_qty, batch_no)
         VALUES (?,?,?,?,?,?,?)`,
        [id, line.color_id, line.size_id, line.sku_id ?? null, line.good_qty, line.reject_qty, line.batch_no ?? null]);
    }
  });

  const updated = await queryOne(`SELECT * FROM trx_fg_receipt WHERE id = ?`, [id]);
  await audit(req, 'trx_fg_receipt', id, 'UPDATE', existing, updated);
  res.json({ data: updated });
}));
