/**
 * Cutting core engine — shared rules for the cut order, fabric DC, lay,
 * cut output, bundle generation and reconciliation screens
 * (Cutting to Shipment Fabric Traceability doc §5–§17, §20).
 *
 * Everything that changes a balance runs inside the caller's transaction and
 * locks the rows it decrements (SELECT … FOR UPDATE).
 */
import type { Request } from 'express';
import { query, txQuery, type Tx } from '../../config/db.js';
import { BadRequest, Forbidden, NotFound } from '../../core/errors.js';
import { nextDocNumber } from '../../core/numbering.js';

/* ------------------------------------------------------------------ utils */

export const KG_EPS = 0.0005;

export const round = (v: number, dp = 4) => {
  const f = 10 ** dp;
  return Math.round((Number(v) || 0) * f) / f;
};
export const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

/** Run a query on the transaction when given one, otherwise on the pool. */
export async function q<T = any>(tx: Tx | null | undefined, sql: string, params: unknown[] = []): Promise<T[]> {
  return tx ? txQuery<T>(tx, sql, params) : query<T>(sql, params);
}
export async function q1<T = any>(tx: Tx | null | undefined, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(tx, sql, params))[0] ?? null;
}

export function hasPerm(req: Request, code: string): boolean {
  return Boolean(req.user?.isSuperAdmin || req.user?.permissions.has(code));
}

/* -------------------------------------------------------- cut order status */

export const PLAN_STATUSES = [
  'DRAFT', 'APPROVED', 'RELEASED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'CLOSED', 'CANCELLED',
] as const;
export type PlanStatus = typeof PLAN_STATUSES[number];

/** Statuses derived from lay execution — never set by hand. */
export const DERIVED_STATUSES: PlanStatus[] = ['IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED'];
/** Statuses in which lays may be executed / bundles generated. */
export const CUTTABLE_STATUSES: PlanStatus[] = ['APPROVED', 'RELEASED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED'];

/** Manual transitions a user may request (derived ones come from lays, CLOSED from reconciliation). */
export const MANUAL_TRANSITIONS: Record<string, PlanStatus[]> = {
  DRAFT: ['APPROVED', 'RELEASED', 'CANCELLED'],
  APPROVED: ['DRAFT', 'RELEASED', 'CANCELLED'],
  RELEASED: ['APPROVED', 'CANCELLED'],
  IN_PROGRESS: [],
  PARTIALLY_COMPLETED: [],
  COMPLETED: [],
  CLOSED: [],
  CANCELLED: [],
};

export async function lockPlan(tx: Tx, cid: number, planId: number) {
  const plan = await q1<any>(tx,
    `SELECT * FROM trx_cutting_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [planId, cid]);
  if (!plan) throw NotFound('Cut order (cutting plan) not found');
  return plan;
}

export function assertPlanOpen(plan: any, action = 'change this cut order') {
  if (plan.status === 'CLOSED') throw BadRequest(`Cut order ${plan.plan_no} is CLOSED and read-only — reopen the reconciliation to ${action}`);
  if (plan.status === 'CANCELLED') throw BadRequest(`Cut order ${plan.plan_no} is CANCELLED`);
}

export function assertPlanCuttable(plan: any) {
  assertPlanOpen(plan, 'cut');
  if (!CUTTABLE_STATUSES.includes(plan.status)) {
    throw BadRequest(`Cut order ${plan.plan_no} is ${plan.status} — approve/release it before executing lays`);
  }
}

/** Max PCS that may be cut without an authorised override (doc §5). 0 order qty = no ceiling. */
export function maxCutQty(plan: { order_qty: any; over_cut_pct: any }): number | null {
  const order = num(plan.order_qty);
  if (order <= 0) return null;
  return Math.floor(order * (1 + num(plan.over_cut_pct) / 100) + 1e-9);
}

/**
 * Enforce the over-cut ceiling. Returns true when an authorised override was
 * used (the caller must audit it). Throws when the ceiling is exceeded without
 * PRODUCTION.APPROVE + a reason.
 */
export function checkOverCut(req: Request, plan: any, qty: number, what: string, reason?: string | null): boolean {
  const max = maxCutQty(plan);
  if (max === null || qty <= max) return false;
  const msg = `${what} ${qty} PCS exceeds order qty ${num(plan.order_qty)} PCS + ${num(plan.over_cut_pct)}% over-cut allowance (max ${max} PCS)`;
  if (!hasPerm(req, 'PRODUCTION.APPROVE')) throw Forbidden(`${msg}. Only a user with PRODUCTION.APPROVE can authorise an over-cut.`);
  if (!reason || !reason.trim()) throw BadRequest(`${msg}. Give an over-cut reason to authorise it.`);
  return true;
}

/**
 * Re-derive actual_cut_qty and the lay-driven status of a cut order.
 *   first executed lay                 → IN_PROGRESS
 *   short of target, no lay pending    → PARTIALLY_COMPLETED
 *   actual ≥ planned (or order) qty    → COMPLETED
 *   every lay reversed                 → back to RELEASED
 * DRAFT / CLOSED / CANCELLED are never touched here.
 */
export async function refreshPlanStatus(tx: Tx, planId: number) {
  const plan = await q1<any>(tx, `SELECT * FROM trx_cutting_plan WHERE id = ? FOR UPDATE`, [planId]);
  if (!plan) return null;
  const agg = await q1<any>(tx,
    `SELECT COALESCE(SUM(co.good_qty),0) AS good
       FROM trx_cut_output co JOIN trx_lay_plan lp ON lp.id = co.lay_id
      WHERE co.cutting_plan_id = ? AND co.status <> 'REVERSED' AND lp.status IN ('CUT','APPROVED')`, [planId]);
  const lays = await q1<any>(tx,
    `SELECT SUM(status IN ('CUT','APPROVED')) AS executed, SUM(status IN ('PLANNED','SPREAD')) AS pending
       FROM trx_lay_plan WHERE cutting_plan_id = ?`, [planId]);
  const actual = num(agg?.good);
  const executed = num(lays?.executed);
  const pending = num(lays?.pending);

  let status: string = plan.status;
  if (!['DRAFT', 'CLOSED', 'CANCELLED'].includes(plan.status)) {
    const target = num(plan.planned_cut_qty) > 0 ? num(plan.planned_cut_qty) : num(plan.order_qty);
    if (executed === 0 || actual === 0) {
      if (DERIVED_STATUSES.includes(plan.status)) status = 'RELEASED';
    } else if (target > 0 && actual >= target) {
      status = 'COMPLETED';
    } else if (pending > 0) {
      status = 'IN_PROGRESS';
    } else {
      status = target > 0 ? 'PARTIALLY_COMPLETED' : 'IN_PROGRESS';
    }
  }
  await tx.execute(`UPDATE trx_cutting_plan SET actual_cut_qty = ?, status = ? WHERE id = ?`, [actual, status, planId]);
  // size-wise actuals
  await tx.execute(
    `UPDATE trx_cutting_plan_size cps
        SET cps.actual_qty = (SELECT COALESCE(SUM(co.good_qty),0)
                                FROM trx_cut_output co JOIN trx_lay_plan lp ON lp.id = co.lay_id
                               WHERE co.cutting_plan_id = cps.cutting_plan_id AND co.size_id = cps.size_id
                                 AND co.status <> 'REVERSED' AND lp.status IN ('CUT','APPROVED'))
      WHERE cps.cutting_plan_id = ?`, [planId]);
  return { actual_cut_qty: actual, status, previous_status: plan.status };
}

/* ---------------------------------------------------------- roll statuses */

/** trx_fabric_roll.stock_status from weight vs net issued KG. CLOSED is sticky unless `reopen`. */
export async function refreshFabricRollStatus(tx: Tx, rollId: number, opts: { close?: boolean; reopen?: boolean } = {}) {
  const r = await q1<any>(tx, `SELECT id, weight_kg, issued_kg, stock_status FROM trx_fabric_roll WHERE id = ? FOR UPDATE`, [rollId]);
  if (!r) return;
  if (r.stock_status === 'CLOSED' && !opts.reopen && !opts.close) return;
  const avail = num(r.weight_kg) - num(r.issued_kg);
  let st: string;
  if (num(r.issued_kg) <= KG_EPS) st = 'AVAILABLE';
  else if (avail <= KG_EPS) st = opts.close ? 'CLOSED' : 'ISSUED';
  else st = 'PARTIAL';
  if (r.stock_status === 'RESERVED' && st === 'AVAILABLE') st = 'RESERVED';
  await tx.execute(`UPDATE trx_fabric_roll SET stock_status = ? WHERE id = ?`, [st, rollId]);
}

/** DC roll line status from issue / consumed / returned KG. */
export async function refreshDcRollStatus(tx: Tx, dcRollId: number, opts: { forceClose?: boolean } = {}) {
  const r = await q1<any>(tx,
    `SELECT id, issue_kg, consumed_kg, returned_kg, roll_status FROM trx_fabric_issue_roll WHERE id = ? FOR UPDATE`, [dcRollId]);
  if (!r) return;
  const remaining = num(r.issue_kg) - num(r.consumed_kg) - num(r.returned_kg);
  let st = 'OPEN';
  if (opts.forceClose || remaining <= KG_EPS) st = 'CLOSED';
  else if (num(r.consumed_kg) > KG_EPS || num(r.returned_kg) > KG_EPS) st = 'PARTIALLY_USED';
  await tx.execute(`UPDATE trx_fabric_issue_roll SET roll_status = ? WHERE id = ?`, [st, dcRollId]);
}

/* ------------------------------------------------ consumption allocation */

export interface KgBasis {
  kgPerPc: number | null;
  method: 'SIZE_CONSUMPTION' | 'LAY_AVERAGE' | null;
  source: string | null;
}

export function parseJson<T = any>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

/** KG/PC for a size from a marker version's size_consumption JSON (keyed by size code). */
export function markerSizeKg(mv: any, sizeCode: string | null | undefined, sizeLabel?: string | null): number | null {
  if (!mv) return null;
  const map = parseJson<Record<string, number>>(mv.size_consumption, {});
  const keys = Object.keys(map || {});
  for (const c of [sizeCode, sizeLabel]) {
    if (!c) continue;
    const k = keys.find((x) => x.trim().toUpperCase() === String(c).trim().toUpperCase());
    if (k && num(map[k]) > 0) return num(map[k]);
  }
  return null;
}

/**
 * Allocation hierarchy for bundle KG (doc §12, §13):
 *   1. active trx_size_consumption (APPROVED > ACTUAL > MARKER > COSTING) × PCS → SIZE_CONSUMPTION
 *   2. marker version size_consumption × PCS                                    → SIZE_CONSUMPTION
 *   3. lay actual KG ÷ lay good PCS × PCS                                       → LAY_AVERAGE
 */
export async function resolveKgPerPc(tx: Tx | null, cid: number, p: {
  style_id: number | null; color_id: number | null; fabric_id: number | null; size_id: number | null;
  marker_version_id?: number | null; lay?: any | null; legacyCutting?: any | null;
}): Promise<KgBasis> {
  if (p.style_id && p.size_id) {
    const sc = await q1<any>(tx,
      `SELECT * FROM trx_size_consumption
        WHERE company_id = ? AND style_id = ? AND size_id = ? AND is_active = 1
          AND effective_from <= CURDATE()
          AND (color_id IS NULL OR color_id = ?)
          AND (fabric_id IS NULL OR fabric_id = ?)
        ORDER BY FIELD(source,'APPROVED','ACTUAL','MARKER','COSTING'),
                 (color_id IS NOT NULL) DESC, (fabric_id IS NOT NULL) DESC,
                 effective_from DESC, version DESC, id DESC
        LIMIT 1`, [cid, p.style_id, p.size_id, p.color_id ?? 0, p.fabric_id ?? 0]);
    if (sc && num(sc.kg_per_pc) > 0) {
      return {
        kgPerPc: num(sc.kg_per_pc), method: 'SIZE_CONSUMPTION',
        source: `SIZE_CONSUMPTION#${sc.id} ${sc.source} v${sc.version} eff ${String(sc.effective_from).slice(0, 10)}`,
      };
    }
  }
  if (p.marker_version_id && p.size_id) {
    const mv = await q1<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ?`, [p.marker_version_id]);
    const sz = await q1<any>(tx, `SELECT size_code, size_label FROM mst_size WHERE id = ?`, [p.size_id]);
    const kg = markerSizeKg(mv, sz?.size_code, sz?.size_label);
    if (mv && kg && (mv.uom ?? 'KG') === 'KG') {
      return { kgPerPc: kg, method: 'SIZE_CONSUMPTION', source: `MARKER ${mv.marker_no} v${mv.version} size ${sz?.size_code}` };
    }
  }
  if (p.lay && num(p.lay.actual_cut_qty) > 0 && num(p.lay.actual_kg) > 0) {
    return {
      kgPerPc: num(p.lay.actual_kg) / num(p.lay.actual_cut_qty), method: 'LAY_AVERAGE',
      source: `LAY ${p.lay.lay_no}: ${round(num(p.lay.actual_kg), 3)} KG / ${num(p.lay.actual_cut_qty)} PCS`,
    };
  }
  if (p.legacyCutting && num(p.legacyCutting.total_pieces) > 0 && num(p.legacyCutting.fabric_used_kg) > 0) {
    return {
      kgPerPc: num(p.legacyCutting.fabric_used_kg) / num(p.legacyCutting.total_pieces), method: 'LAY_AVERAGE',
      source: `CUTTING ${p.legacyCutting.cut_no}: ${round(num(p.legacyCutting.fabric_used_kg), 3)} KG / ${num(p.legacyCutting.total_pieces)} PCS`,
    };
  }
  return { kgPerPc: null, method: null, source: null };
}

/* ------------------------------------------------------- document numbers */

/**
 * nextDocNumber, skipping any number already present in `table.column` for
 * the company (series rows can lag behind data keyed in by hand or imported).
 */
export async function nextUniqueDocNo(tx: Tx, cid: number, docType: string, table: string, column: string): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const no = await nextDocNumber(tx, cid, docType);
    const clash = await q1<any>(tx, `SELECT id FROM ${table} WHERE company_id = ? AND ${column} = ? LIMIT 1`, [cid, no]);
    if (!clash) return no;
  }
  throw BadRequest(`Could not allocate a free ${docType} number — check the number series`);
}

/* --------------------------------------------------------- bundle numbers */

/**
 * Next company-wide bundle number + barcode. Numbers come from one locked
 * series (CUT_BUNDLE), so a number is never handed out twice; any collision
 * with a legacy/other-company barcode skips forward rather than reusing.
 */
export async function nextBundleIdentity(tx: Tx, cid: number): Promise<{ bundleNo: string; barcode: string }> {
  for (let i = 0; i < 200; i++) {
    const bundleNo = await nextDocNumber(tx, cid, 'CUT_BUNDLE');
    const barcode = bundleNo;
    const clash = await q1<any>(tx,
      `SELECT id FROM trx_cutting_bundle WHERE barcode = ? OR (company_id = ? AND bundle_no = ?) LIMIT 1`,
      [barcode, cid, bundleNo]);
    if (!clash) return { bundleNo, barcode };
  }
  throw BadRequest('Could not allocate a unique bundle number — check the CUT_BUNDLE number series');
}

/* --------------------------------------------------------- bundle generator */

export interface GenerateParams {
  cid: number;
  userId: number;
  bundleSize: number;
  /** PCS to bundle; defaults to the whole remaining balance. */
  qty?: number | null;
  partName?: string | null;
  components?: string[];
  lineDestination?: string | null;
}

/** Generate bundles from one cut output (doc §11). Caller owns the transaction. */
export async function generateBundlesFromOutput(tx: Tx, cutOutputId: number, p: GenerateParams) {
  const co = await q1<any>(tx,
    `SELECT * FROM trx_cut_output WHERE id = ? AND company_id = ? FOR UPDATE`, [cutOutputId, p.cid]);
  if (!co) throw NotFound('Cut output not found');
  if (co.status === 'REVERSED') throw BadRequest(`Cut output ${co.output_no} was reversed`);
  const plan = await q1<any>(tx, `SELECT * FROM trx_cutting_plan WHERE id = ?`, [co.cutting_plan_id]);
  if (plan) assertPlanOpen(plan, 'generate bundles');
  const lay = await q1<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ?`, [co.lay_id]);
  if (!lay || !['CUT', 'APPROVED'].includes(lay.status)) throw BadRequest('Bundles can only be generated from an executed lay');

  const remaining = num(co.good_qty) - num(co.bundled_qty);
  const qty = p.qty == null ? remaining : Number(p.qty);
  if (remaining <= 0) throw BadRequest(`Cut output ${co.output_no} is fully bundled (0 PCS remaining)`);
  if (!Number.isInteger(qty) || qty <= 0) throw BadRequest('Bundle quantity must be a positive whole number of PCS');
  if (qty > remaining) {
    throw BadRequest(`Bundle quantity ${qty} PCS exceeds cut output ${co.output_no} balance of ${remaining} PCS`);
  }

  const partTag = String(p.partName || plan?.part_name || 'TOP').toUpperCase();
  const basis = await resolveKgPerPc(tx, p.cid, {
    style_id: co.style_id, color_id: co.color_id, fabric_id: plan?.fabric_id ?? null, size_id: co.size_id,
    marker_version_id: lay.marker_version_id, lay,
  });
  const sku = co.style_id && co.color_id && co.size_id
    ? await q1<any>(tx, `SELECT id FROM mst_style_sku WHERE style_id = ? AND color_id = ? AND size_id = ? LIMIT 1`,
      [co.style_id, co.color_id, co.size_id])
    : null;
  const seqRow = await q1<any>(tx,
    `SELECT COALESCE(MAX(bundle_seq),0) AS s FROM trx_cutting_bundle WHERE cut_output_id = ?`, [co.id]);
  const startSeq = num(seqRow?.s);
  const count = Math.ceil(qty / p.bundleSize);
  const components = (p.components ?? []).map((c) => c.trim()).filter(Boolean);

  const created: any[] = [];
  let left = qty;
  for (let i = 1; i <= count; i++) {
    const bq = Math.min(p.bundleSize, left);
    left -= bq;
    const { bundleNo, barcode } = await nextBundleIdentity(tx, p.cid);
    const allocated = basis.kgPerPc != null ? round(basis.kgPerPc * bq, 5) : null;
    const [r]: any = await tx.execute(
      `INSERT INTO trx_cutting_bundle
         (company_id, cutting_id, lay_id, cut_output_id, marker_version_id, io_no, style_id, color_id, size_id,
          part_name, component, sku_id, bundle_no, bundle_seq, total_bundles, qty, allocated_kg,
          allocation_method, allocation_source, balance_qty, barcode, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'GENERATED',?)`,
      [p.cid, co.cutting_id, co.lay_id, co.id, lay.marker_version_id ?? null, co.io_no, co.style_id, co.color_id,
       co.size_id, partTag, components.length ? components.join(',').slice(0, 60) : null, sku?.id ?? null,
       bundleNo, startSeq + i, startSeq + count, bq, allocated, basis.method, basis.source, bq, barcode, p.userId]);
    for (const comp of components) {
      await tx.execute(`INSERT INTO trx_cutting_bundle_detail (bundle_id, component, piece_qty) VALUES (?,?,?)`,
        [r.insertId, comp.slice(0, 60), bq]);
    }
    await tx.execute(
      `INSERT INTO trx_bundle_movement
         (company_id, bundle_id, io_no, style_id, from_stage, to_stage, txn_type, moved_qty, good_qty,
          moved_by, destination, location, remarks, ref_table, ref_id)
       VALUES (?,?,?,?,'CUTTING','GENERATED','BUNDLE_CREATE',?,?,?,?,?,?,'trx_cut_output',?)`,
      [p.cid, r.insertId, co.io_no, co.style_id, bq, bq, p.userId, p.lineDestination ?? null,
       plan?.cutting_location ?? null, `Generated from ${co.output_no}`, co.id]);
    created.push({
      id: r.insertId, bundle_no: bundleNo, barcode, bundle_seq: startSeq + i, total_bundles: startSeq + count,
      qty: bq, allocated_kg: allocated, allocation_method: basis.method, allocation_source: basis.source,
      part_name: partTag, size_id: co.size_id, cut_output_id: co.id, status: 'GENERATED',
    });
  }
  const bundled = num(co.bundled_qty) + qty;
  await tx.execute(`UPDATE trx_cut_output SET bundled_qty = ?, status = ? WHERE id = ?`,
    [bundled, bundled >= num(co.good_qty) ? 'COMPLETED' : 'OPEN', co.id]);
  return { cut_output_id: co.id, output_no: co.output_no, bundles: created, basis, remaining_after: remaining - qty };
}

/**
 * Legacy entry point (/bundles/generate, /bundles/generate-detailed): a
 * cutting header + size + qty. Routed through the same validation — when
 * the cutting came from a lay it bundles the matching cut output, otherwise
 * it caps at the cutting's recorded pieces less what is already bundled.
 */
export async function generateBundlesLegacy(tx: Tx, p: GenerateParams & {
  cuttingId: number; sizeId: number; colorId: number | null; styleId: number; ioNo: string;
  skuId?: number | null; totalQty: number;
}) {
  const cutting = await q1<any>(tx,
    `SELECT c.*, po.part_name AS po_part_name, sol.part_name AS so_part_name, cp.part_name AS plan_part_name,
            cp.status AS plan_status, cp.plan_no, cp.fabric_id AS plan_fabric_id
       FROM trx_cutting c
       LEFT JOIN trx_production_order po ON po.id = c.prod_order_id
       LEFT JOIN trx_sales_order_line sol ON sol.id = po.so_line_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = c.cutting_plan_id
      WHERE c.id = ? AND c.company_id = ? FOR UPDATE`, [p.cuttingId, p.cid]);
  if (!cutting) throw NotFound('Cutting transaction not found');
  if (cutting.is_cancelled) throw BadRequest(`Cutting ${cutting.cut_no} is cancelled`);
  if (cutting.plan_status === 'CLOSED' || cutting.plan_status === 'CANCELLED') {
    throw BadRequest(`Cut order ${cutting.plan_no} is ${cutting.plan_status} — bundles cannot be generated`);
  }

  const co = await q1<any>(tx,
    `SELECT id FROM trx_cut_output WHERE cutting_id = ? AND size_id = ? AND status <> 'REVERSED' LIMIT 1`,
    [cutting.id, p.sizeId]);
  const partTag = String(cutting.so_part_name || cutting.po_part_name || cutting.plan_part_name || p.partName || 'TOP').toUpperCase();
  if (co) {
    return generateBundlesFromOutput(tx, co.id, { ...p, qty: p.totalQty, partName: partTag });
  }
  if (cutting.lay_id) throw BadRequest('This cutting has no cut output for the selected size');

  const used = await q1<any>(tx,
    `SELECT COALESCE(SUM(qty),0) AS q FROM trx_cutting_bundle
      WHERE cutting_id = ? AND part_name = ? AND status <> 'CANCELLED' AND parent_bundle_id IS NULL`,
    [cutting.id, partTag]);
  const available = num(cutting.total_pieces) - num(used?.q);
  if (num(cutting.total_pieces) <= 0) throw BadRequest(`Cutting ${cutting.cut_no} has no cut pieces recorded`);
  if (p.totalQty > available) {
    throw BadRequest(`Bundle quantity ${p.totalQty} PCS exceeds cutting ${cutting.cut_no} balance of ${Math.max(available, 0)} PCS for part ${partTag}`);
  }

  const basis = await resolveKgPerPc(tx, p.cid, {
    style_id: p.styleId, color_id: p.colorId, fabric_id: cutting.plan_fabric_id ?? cutting.fabric_id ?? null,
    size_id: p.sizeId, legacyCutting: cutting,
  });
  let skuId = p.skuId ?? null;
  if (!skuId && p.colorId) {
    const sku = await q1<any>(tx, `SELECT id FROM mst_style_sku WHERE style_id = ? AND color_id = ? AND size_id = ? LIMIT 1`,
      [p.styleId, p.colorId, p.sizeId]);
    skuId = sku?.id ?? null;
  }
  const seqRow = await q1<any>(tx,
    `SELECT COALESCE(MAX(bundle_seq),0) AS s FROM trx_cutting_bundle WHERE cutting_id = ? AND part_name = ?`,
    [cutting.id, partTag]);
  const startSeq = num(seqRow?.s);
  const count = Math.ceil(p.totalQty / p.bundleSize);
  const components = (p.components ?? []).map((c) => c.trim()).filter(Boolean);
  const created: any[] = [];
  let left = p.totalQty;
  for (let i = 1; i <= count; i++) {
    const bq = Math.min(p.bundleSize, left);
    left -= bq;
    const { bundleNo, barcode } = await nextBundleIdentity(tx, p.cid);
    const allocated = basis.kgPerPc != null ? round(basis.kgPerPc * bq, 5) : null;
    const [r]: any = await tx.execute(
      `INSERT INTO trx_cutting_bundle
         (company_id, cutting_id, io_no, style_id, color_id, size_id, part_name, component, sku_id,
          bundle_no, bundle_seq, total_bundles, qty, allocated_kg, allocation_method, allocation_source,
          balance_qty, barcode, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'GENERATED',?)`,
      [p.cid, cutting.id, p.ioNo, p.styleId, p.colorId, p.sizeId, partTag,
       components.length ? components.join(',').slice(0, 60) : null, skuId, bundleNo, startSeq + i,
       startSeq + count, bq, allocated, basis.method, basis.source, bq, barcode, p.userId]);
    for (const comp of components) {
      await tx.execute(`INSERT INTO trx_cutting_bundle_detail (bundle_id, component, piece_qty) VALUES (?,?,?)`,
        [r.insertId, comp.slice(0, 60), bq]);
    }
    created.push({
      id: r.insertId, bundle_no: bundleNo, barcode, part_name: partTag, bundle_seq: startSeq + i,
      total_bundles: startSeq + count, qty: bq, allocated_kg: allocated, allocation_method: basis.method, status: 'GENERATED',
    });
  }
  return { cut_output_id: null, bundles: created, basis, remaining_after: available - p.totalQty };
}

/* ------------------------------------------ reconciliation & consumption */

export async function reconTolerancePct(tx: Tx | null, cid: number): Promise<number> {
  const row = await q1<any>(tx,
    `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'CUTTING_RECON_TOLERANCE_PCT' LIMIT 1`, [cid]);
  const v = Number(row?.setting_value);
  return Number.isFinite(v) && v >= 0 ? v : 0.5;
}

/** Issued vs consumed vs losses for one cut order (doc §16). */
export async function computeReconFigures(tx: Tx | null, cid: number, planId: number) {
  const issued = await q1<any>(tx,
    `SELECT COALESCE(SUM(fir.issue_kg),0) AS issue_kg, COALESCE(SUM(fir.returned_kg),0) AS returned_kg,
            COALESCE(SUM(fir.consumed_kg),0) AS dc_consumed_kg, COUNT(*) AS rolls
       FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
      WHERE fi.company_id = ? AND fi.cutting_plan_id = ?`, [cid, planId]);
  const consumed = await q1<any>(tx,
    `SELECT COALESCE(SUM(lr.actual_consumed_kg),0) AS kg
       FROM trx_lay_roll lr JOIN trx_lay_plan lp ON lp.id = lr.lay_id
      WHERE lp.company_id = ? AND lp.cutting_plan_id = ? AND lp.status IN ('CUT','APPROVED')`, [cid, planId]);
  const losses = await q<any>(tx,
    `SELECT cl.loss_type, COALESCE(SUM(cl.qty_kg),0) AS kg
       FROM trx_cutting_loss cl LEFT JOIN trx_lay_plan lp ON lp.id = cl.lay_id
      WHERE cl.company_id = ? AND cl.cutting_plan_id = ? AND cl.is_reversed = 0
        AND (cl.lay_id IS NULL OR lp.status IN ('CUT','APPROVED'))
      GROUP BY cl.loss_type`, [cid, planId]);
  const L: Record<string, number> = { CUTTING_WASTE: 0, END_LOSS: 0, SELVEDGE_LOSS: 0, REMNANT: 0, OTHER: 0 };
  for (const l of losses) L[l.loss_type] = round(num(l.kg));
  const issueKg = round(num(issued?.issue_kg));
  const returnedKg = round(num(issued?.returned_kg));
  const netIssued = round(issueKg - returnedKg);
  const consumedKg = round(num(consumed?.kg));
  const lossTotal = round(Object.values(L).reduce((a, b) => a + b, 0));
  const unaccounted = round(netIssued - consumedKg - lossTotal);
  const tolPct = await reconTolerancePct(tx, cid);
  const tolKg = round(netIssued * tolPct / 100);
  return {
    issue_kg: issueKg, returned_kg: returnedKg, net_issued_kg: netIssued, consumed_kg: consumedKg,
    waste_kg: L.CUTTING_WASTE, end_loss_kg: L.END_LOSS, selvedge_kg: L.SELVEDGE_LOSS, remnant_kg: L.REMNANT,
    other_loss_kg: L.OTHER, total_loss_kg: lossTotal, unaccounted_kg: unaccounted,
    tolerance_pct: tolPct, tolerance_kg: tolKg,
    within_tolerance: Math.abs(unaccounted) <= tolKg + KG_EPS,
    dc_rolls: num(issued?.rolls), uom: 'KG',
  };
}

const variance = (actual: number | null, planned: number | null) => {
  if (actual == null || planned == null || planned === 0) return { variance: null, variance_pct: null };
  const v = actual - planned;
  return { variance: round(v, 5), variance_pct: round((v / planned) * 100, 2) };
};

/**
 * Planned (costing/BOM) vs Marker (CAD) vs Cutting Actual vs Final Actual
 * KG/PC for a cut order (doc §17). Each figure is computed from its own
 * source and none overwrites another.
 */
export async function computeConsumption(tx: Tx | null, cid: number, planId: number) {
  const plan = await q1<any>(tx, `SELECT * FROM trx_cutting_plan WHERE id = ? AND company_id = ?`, [planId, cid]);
  if (!plan) throw NotFound('Cut order not found');

  // 1. Planned: BOM fabric line (per piece), falling back to the latest costing fabric line.
  let planned: { kg_per_pc: number | null; source: string | null; uom: string | null } = { kg_per_pc: null, source: null, uom: null };
  const bomSql = `SELECT b.bom_no, b.version, b.approval_state, bl.consumption, bl.consumption_basis, bl.wastage_pct, u.code AS uom
       FROM trx_bom b JOIN trx_bom_line bl ON bl.bom_id = b.id LEFT JOIN cfg_uom u ON u.id = bl.uom_id
      WHERE b.company_id = ? AND b.style_id = ? AND b.is_active = 1 AND bl.material_type = 'FABRIC'
        AND b.approval_state NOT IN ('CANCELLED','SUPERSEDED') __FAB__
      ORDER BY (b.so_id <=> ?) DESC, FIELD(b.approval_state,'APPROVED','SUBMITTED','DRAFT'), b.version DESC, bl.id
      LIMIT 1`;
  let bom = plan.fabric_id
    ? await q1<any>(tx, bomSql.replace('__FAB__', 'AND bl.fabric_id = ?'), [cid, plan.style_id, plan.fabric_id, plan.so_id])
    : null;
  if (!bom) bom = await q1<any>(tx, bomSql.replace('__FAB__', ''), [cid, plan.style_id, plan.so_id]);
  if (bom) {
    let c = num(bom.consumption);
    if (String(bom.consumption_basis).toUpperCase().includes('DOZEN')) c = c / 12;
    const uom = String(bom.uom || 'KG').toUpperCase();
    if (uom === 'GM') c = c / 1000;
    planned = { kg_per_pc: round(c, 5), source: `BOM ${bom.bom_no} v${bom.version} (${bom.approval_state})`, uom: uom === 'GM' ? 'KG' : uom };
  } else {
    const cl = await q1<any>(tx,
      `SELECT c.costing_no, c.version, l.quantity, u.code AS uom
         FROM trx_costing c JOIN trx_costing_line l ON l.costing_id = c.id LEFT JOIN cfg_uom u ON u.id = l.uom_id
        WHERE c.company_id = ? AND c.style_id = ? AND c.is_deleted = 0 AND l.material_type = 'FABRIC'
        ORDER BY c.version DESC, c.id DESC, l.id LIMIT 1`, [cid, plan.style_id]);
    if (cl && num(cl.quantity) > 0) {
      planned = { kg_per_pc: round(num(cl.quantity), 5), source: `COSTING ${cl.costing_no} v${cl.version}`, uom: String(cl.uom || 'KG').toUpperCase() };
    }
  }

  // 2. Marker (CAD) consumption of the marker versions the executed lays used, weighted by good PCS.
  const lays = await q<any>(tx,
    `SELECT lp.id, lp.lay_no, lp.status, lp.actual_kg, lp.actual_cut_qty, lp.planned_kg, lp.expected_pieces,
            mv.id AS marker_version_id, mv.marker_no, mv.version AS marker_version, mv.cad_kg_per_pc, mv.uom AS marker_uom
       FROM trx_lay_plan lp LEFT JOIN trx_marker_version mv ON mv.id = lp.marker_version_id
      WHERE lp.company_id = ? AND lp.cutting_plan_id = ? AND lp.status IN ('CUT','APPROVED')
      ORDER BY lp.id`, [cid, planId]);
  let mNum = 0, mDen = 0, aKg = 0, aPcs = 0;
  const perLay = lays.map((l) => {
    const good = num(l.actual_cut_qty);
    const actual = good > 0 ? num(l.actual_kg) / good : null;
    const marker = l.cad_kg_per_pc != null && (l.marker_uom ?? 'KG') === 'KG' ? num(l.cad_kg_per_pc) : null;
    if (marker != null && good > 0) { mNum += marker * good; mDen += good; }
    aKg += num(l.actual_kg); aPcs += good;
    return {
      lay_id: l.id, lay_no: l.lay_no, marker: l.marker_no ? `${l.marker_no} v${l.marker_version}` : null,
      good_pcs: good, actual_kg: round(num(l.actual_kg)), planned_kg: l.planned_kg != null ? round(num(l.planned_kg)) : null,
      marker_kg_per_pc: marker != null ? round(marker, 5) : null,
      actual_kg_per_pc: actual != null ? round(actual, 5) : null,
      ...variance(actual, marker),
    };
  });
  const markerKgPc = mDen > 0 ? mNum / mDen : null;
  const actualKgPc = aPcs > 0 ? aKg / aPcs : null;

  // 3. Final actual — issued fabric fully accounted after reconciliation.
  const recon = await computeReconFigures(tx, cid, planId);
  const finalKgPc = aPcs > 0 ? (recon.consumed_kg + recon.total_loss_kg) / aPcs : null;
  const plannedKgPc = planned.kg_per_pc;

  return {
    cutting_plan_id: planId, uom: 'KG/PC', good_pcs: aPcs,
    planned: { kg_per_pc: plannedKgPc, source: planned.source, uom: planned.uom },
    marker: { kg_per_pc: markerKgPc != null ? round(markerKgPc, 5) : null, source: 'Marker versions used by executed lays (PCS-weighted)' },
    cutting_actual: { kg_per_pc: actualKgPc != null ? round(actualKgPc, 5) : null, total_kg: round(aKg), source: 'Σ lay actual KG ÷ Σ good cut PCS' },
    final_actual: {
      kg_per_pc: finalKgPc != null ? round(finalKgPc, 5) : null,
      is_final: plan.status === 'CLOSED',
      source: '(lay consumption + recorded losses) ÷ good cut PCS; final once the cut order is reconciled and CLOSED',
    },
    variances: {
      marker_vs_planned: variance(markerKgPc, plannedKgPc),
      actual_vs_planned: variance(actualKgPc, plannedKgPc),
      actual_vs_marker: variance(actualKgPc, markerKgPc),
      final_vs_planned: variance(finalKgPc, plannedKgPc),
    },
    lays: perLay,
  };
}
