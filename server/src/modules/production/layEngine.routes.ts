/**
 * CAD marker → automatic lay calculation → roll allocation → cutting issue → spreading → cutting
 * (client developer doc "CAD Marker Automatic Lay Calculation Cutting" + voice notes 04-Oct-2026).
 *
 *   GET  /cutting-plans/job-program                the job's cutting program (CAD colour × size order / cut qty, markers)
 *   GET  /cutting-plans/:id/lay-workbench          everything the lay screen loads for a cut order
 *   POST /cutting-plans/:id/generate-lay           automatic lays from approved markers (preview or save)
 *   GET  /cutting-plans/:id/eligible-rolls         roll eligibility with reasons (doc §8)
 *   POST /lay-plans/:id/auto-allocate-rolls        same shade / lot, FIFO, partial roll (doc §9, §10)
 *   POST /lay-plans/:id/reserve | release-rolls    reservation — stock is not consumed at planning
 *   POST /lay-plans/:id/issue | receive            cutting DC from the reserved rolls; cutting receives it (doc §11)
 *   POST /spreading, PUT /spreading/:id/complete, POST /spreading/:id/verify      (doc §13)
 *   GET  /lay-plans/:id/execution-prefill          the cut entry pre-filled from spreading + marker
 *   GET  /lay-plans/:id/genealogy, /cutting/:id/traceability                       (doc §15)
 *   GET  /cutting-plans/:id/planned-vs-actual, /cutting-dashboard                  (doc §22, §25)
 *   /cutting-tables                                 table ply / length limits (doc §20)
 *
 * Execution (cut entry), lay approval and bundle generation stay in cuttingExecution.routes.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { resolveSoId, OPEN_ALLOC_SQL, rollTrace } from '../stock/jobStock.routes.js';
import {
  KG_EPS, RESERVED_KG_SQL, assertPlanOpen, lockPlan, nextUniqueDocNo, num, parseJson, q, q1,
  refreshFabricRollStatus, round,
} from './cuttingEngine.js';
import { allocateRolls, perPly, planLays, type CalcMarker } from './layCalc.js';

export const layEngineRouter = Router();
// a non-numeric id is a 404, not a database error
layEngineRouter.param('id', (_req, _res, next, v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? next() : next(NotFound('Not found'))));

const VIEW = requirePermission('PRODUCTION.VIEW');
const PLAN = requireAny('PRODUCTION.CREATE', 'CUTTING.PLAN');
const STORE = requireAny('PRODUCTION.CREATE', 'CUTTING.STORE');
const EXEC = requireAny('PRODUCTION.UPDATE', 'CUTTING.EXECUTE');
const SUPERVISE = requireAny('PRODUCTION.APPROVE', 'CUTTING.SUPERVISE');

const PRE_CUT = ['GENERATED', 'ROLL_RESERVED', 'PLAN_APPROVED', 'ISSUED', 'RECEIVED', 'SPREADING', 'READY_FOR_CUTTING'];
const OPEN_LAY = [...PRE_CUT, 'PLANNED', 'SPREAD'];
const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(',');
const norm = (x: unknown) => String(x ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const up = (x: unknown) => String(x ?? '').trim().toUpperCase();
const r3 = (v: number) => round(v, 3);

/* ------------------------------------------------------------------ settings */

export async function cutSettings(cid: number) {
  const rows = await query<any>(`SELECT setting_key k, setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key IN
    ('CUT_MAX_PLY','CUT_MIN_PLY','CUT_SIZE_TOLERANCE_PCT','CUT_MIN_REUSABLE_M','CUT_FABRIC_VARIANCE_PCT','CUT_REQUIRE_APPROVED_MARKER','ROLL_GSM_TOLERANCE_PCT')`, [cid]);
  const g = (k: string, d: number) => { const r = rows.find((x) => x.k === k); const x = Number(r?.v); return r && Number.isFinite(x) ? x : d; };
  return {
    max_ply: Math.max(1, g('CUT_MAX_PLY', 60)), min_ply: Math.max(1, g('CUT_MIN_PLY', 1)),
    size_tolerance_pct: Math.max(0, g('CUT_SIZE_TOLERANCE_PCT', 2)), min_reusable_m: Math.max(0, g('CUT_MIN_REUSABLE_M', 0.5)),
    fabric_variance_pct: Math.max(0, g('CUT_FABRIC_VARIANCE_PCT', 3)), require_approved_marker: g('CUT_REQUIRE_APPROVED_MARKER', 1) !== 0,
    gsm_tolerance_pct: Math.max(0, g('ROLL_GSM_TOLERANCE_PCT', 5)),
  };
}

async function kgUomId(tx: Tx): Promise<number> {
  const u = await txQueryOne<any>(tx, `SELECT id FROM cfg_uom WHERE code = 'KG' LIMIT 1`);
  return u?.id ?? 5;
}

/* ------------------------------------------------------------------ CAD of a job */

async function findCad(cid: number, ioNos: (string | null | undefined)[], styleId: number | null, cadReqId?: number | null) {
  if (cadReqId) return queryOne<any>(`SELECT * FROM trx_cad_requirement WHERE id = ? AND company_id = ?`, [cadReqId, cid]);
  const ios = ioNos.filter(Boolean) as string[];
  if (!ios.length || !styleId) return null;
  return queryOne<any>(
    `SELECT * FROM trx_cad_requirement WHERE company_id = ? AND internal_ir_no IN (${ios.map(() => '?').join(',')}) AND style_id = ? AND status <> 'OBSOLETE'
      ORDER BY (status = 'APPROVED') DESC, id DESC LIMIT 1`, [cid, ...ios, styleId]);
}

interface CadMarkerRow {
  id: number; marker_ref: string; marker_name: string | null; fabric_type: string | null; gsm: number | null; uom: string;
  sizes: string[]; ratios: number[]; ppm: number; length_m: number | null; kg_per_ply: number | null; width_in: number | null;
  colorways: { color_name: string; quantities: number[]; cut_quantities: number[] }[];
}

async function cadMarkers(cadId: number): Promise<CadMarkerRow[]> {
  const rows = await query<any>(`SELECT * FROM trx_cad_marker WHERE cad_req_id = ? ORDER BY sort_order, id`, [cadId]);
  return rows.map((m) => {
    const j = parseJson<any>(m.data_json, {});
    const sizes: string[] = Array.isArray(j.sizes) ? j.sizes.map((x: any) => String(x?.size_code ?? x?.code ?? x)) : [];
    const ratios: number[] = Array.isArray(j.ratios) ? j.ratios.map((x: any) => Number(x) || 0) : [];
    const sumRatio = ratios.reduce((a, b) => a + b, 0);
    const uom = m.uom === 'MTR' ? 'MTR' : 'KG';
    const lengthM = num(m.lay_length_cm) > 0 ? r3(num(m.lay_length_cm) / 100) : (num(m.length_mm) > 0 ? r3(num(m.length_mm) / 1000) : null);
    return {
      id: Number(m.id), marker_ref: m.marker_ref, marker_name: m.marker_name ?? null, fabric_type: m.fabric_type ?? null,
      gsm: m.gsm != null ? num(m.gsm) : null, uom, sizes, ratios, ppm: Math.max(Number(m.no_of_pcs_lay) || 0, sumRatio),
      length_m: lengthM, kg_per_ply: uom === 'KG' && num(m.fabric_wt_per_lay_g) > 0 ? round(num(m.fabric_wt_per_lay_g) / 1000, 5) : null,
      width_in: num(m.table_width_in) > 0 ? num(m.table_width_in) : (num(m.width_mm) > 0 ? round(num(m.width_mm) / 25.4, 2) : null),
      colorways: (Array.isArray(j.colorways) ? j.colorways : []).map((cw: any) => ({
        color_name: String(cw?.color_name ?? 'Solid'),
        quantities: sizes.map((_, i) => Number(cw?.quantities?.[i]) || 0),
        cut_quantities: sizes.map((_, i) => Number(cw?.cut_quantities?.[i] ?? cw?.quantities?.[i]) || 0),
      })),
    };
  });
}

/** The CAD's own "plies required" for one colour of a marker (the size needing the most plies decides). */
function cadPliesForColour(m: CadMarkerRow, colour: string | null | undefined) {
  const cw = m.colorways.find((c) => norm(c.color_name) === norm(colour)) ?? (m.colorways.length === 1 && !colour ? m.colorways[0] : null);
  if (!cw) return null;
  const pp = perPly({ sizes: m.sizes, ratios: m.ratios, pieces_per_marker: m.ppm });
  let need = 0;
  m.sizes.forEach((sz, i) => { const n = pp[up(sz)] ?? 0; if (n > 0) need = Math.max(need, Math.ceil((cw.cut_quantities[i] || 0) / n - 1e-9)); });
  return need;
}

async function fabricByName(cid: number, text: string | null, soId: number | null, styleId: number | null) {
  const t = norm(text);
  if (!t) return null;
  const bom = await query<any>(
    `SELECT DISTINCT fb.id, fb.fabric_name FROM trx_bom b JOIN trx_bom_line bl ON bl.bom_id = b.id JOIN mst_fabric fb ON fb.id = bl.fabric_id
      WHERE b.company_id = ? AND b.is_active = 1 AND bl.material_type = 'FABRIC' AND ((? IS NOT NULL AND b.so_id = ?) OR b.style_id = ?)`,
    [cid, soId, soId, styleId ?? 0]);
  const hit = bom.find((f) => norm(f.fabric_name).includes(t) || t.includes(norm(f.fabric_name)));
  if (hit) return { id: Number(hit.id), fabric_name: hit.fabric_name };
  const all = await query<any>(`SELECT id, fabric_name FROM mst_fabric WHERE company_id = ? AND is_deleted = 0 AND is_active = 1 ORDER BY id`, [cid]);
  const f = all.find((x) => norm(x.fabric_name) === t) ?? all.find((x) => norm(x.fabric_name).startsWith(t) || t.startsWith(norm(x.fabric_name)))
    ?? all.find((x) => norm(x.fabric_name).includes(t));
  return f ? { id: Number(f.id), fabric_name: f.fabric_name } : null;
}

/** Size master rows for size codes: the style's own SKUs first, then its size group, then any size with that code. */
async function sizeIdsFor(styleId: number, codes: string[]) {
  const out = new Map<string, { size_id: number; size_code: string; sort_order: number }>();
  if (!codes.length) return out;
  const want = [...new Set(codes.map(up))];
  const take = (rows: any[]) => rows.forEach((r) => { if (!out.has(up(r.size_code))) out.set(up(r.size_code), { size_id: Number(r.id), size_code: r.size_code, sort_order: Number(r.sort_order) || 0 }); });
  // the style's assigned sizes first (size doc §16–§17), then its SKUs
  take(await query<any>(`SELECT sz.id, sz.size_code, ss.sequence_no AS sort_order FROM mst_style_size ss JOIN mst_size sz ON sz.id = ss.size_id WHERE ss.style_id = ? AND ss.is_active = 1 ORDER BY ss.sequence_no`, [styleId]).catch(() => []));
  take(await query<any>(`SELECT DISTINCT sz.id, sz.size_code, sz.sort_order FROM mst_style_sku sk JOIN mst_size sz ON sz.id = sk.size_id WHERE sk.style_id = ?`, [styleId]));
  const left = want.filter((c) => !out.has(c));
  if (left.length) {
    take(await query<any>(`SELECT sz.id, sz.size_code, sz.sort_order FROM mst_style st JOIN mst_size sz ON sz.size_group_id = st.size_group_id
                            WHERE st.id = ? AND UPPER(sz.size_code) IN (${left.map(() => '?').join(',')})`, [styleId, ...left]).catch(() => []));
  }
  const left2 = want.filter((c) => !out.has(c));
  if (left2.length) take(await query<any>(`SELECT id, size_code, sort_order FROM mst_size WHERE UPPER(size_code) IN (${left2.map(() => '?').join(',')}) ORDER BY id`, left2));
  return out;
}

/* ------------------------------------------------------------------ job cutting program (audio 1) */

/**
 * GET /cutting-plans/job-program?so_id=|io_no=&style_id=
 * Picking the job on the cut plan screen loads the style, buyer PO and the whole cutting program: colour × size
 * order qty (sales order) and CAD order / cut qty (incl. rejection %), what other cut plans already hold, the CAD
 * markers with their ratio and plies, and the fabric(s) the markers are for.
 */
layEngineRouter.get('/cutting-plans/job-program', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const qy = z.object({ so_id: z.coerce.number().int().positive().optional(), io_no: z.string().trim().max(60).optional(),
    style_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const soId = await resolveSoId(cid, qy.so_id, qy.io_no);
  if (!soId) throw NotFound('Job not found');
  const job = await queryOne<any>(
    `SELECT so.id AS so_id, so.so_no, so.io_no, COALESCE(NULLIF(so.io_no,''), so.so_no) AS job_no, so.buyer_po_no, so.buyer_id, p.party_name AS buyer_name
       FROM trx_sales_order so LEFT JOIN mst_party p ON p.id = so.buyer_id WHERE so.id = ? AND so.company_id = ?`, [soId, cid]);
  if (!job) throw NotFound('Job not found');
  const styles = await query<any>(
    `SELECT sol.style_id, st.style_code, st.style_name, SUM(sol.order_qty) AS order_qty, SUM(sol.plan_cut_qty) AS plan_cut_qty
       FROM trx_sales_order_line sol JOIN mst_style st ON st.id = sol.style_id WHERE sol.so_id = ? GROUP BY sol.style_id, st.style_code, st.style_name`, [soId]);
  const styleId = qy.style_id ?? (styles.length === 1 ? Number(styles[0].style_id) : null);
  if (!styleId) { res.json({ data: { job, styles, style_id: null, needs_style: true } }); return; }
  if (!styles.some((x) => Number(x.style_id) === styleId)) throw BadRequest('That style is not on this job');

  // sales order colour × size
  const soRows = await query<any>(
    `SELECT COALESCE(sk.color_id, sol.color_id) AS color_id, c.color_name, sk.size_id, sz.size_code, sz.sort_order,
            SUM(COALESCE(sos.qty, 0)) AS qty, MAX(sol.excess_pct) AS excess_pct, SUM(DISTINCT sol.order_qty) AS line_qty
       FROM trx_sales_order_line sol
       LEFT JOIN trx_sales_order_sku sos ON sos.so_line_id = sol.id
       LEFT JOIN mst_style_sku sk ON sk.id = sos.sku_id
       LEFT JOIN mst_size sz ON sz.id = sk.size_id
       LEFT JOIN mst_color c ON c.id = COALESCE(sk.color_id, sol.color_id)
      WHERE sol.so_id = ? AND sol.style_id = ?
      GROUP BY COALESCE(sk.color_id, sol.color_id), c.color_name, sk.size_id, sz.size_code, sz.sort_order`, [soId, styleId]);

  const cad = await findCad(cid, [job.io_no, job.so_no], styleId);
  const markers = cad ? await cadMarkers(Number(cad.id)) : [];
  const warnings: string[] = [];
  if (!cad) warnings.push(`No CAD for job ${job.job_no} / this style — the cutting program shows sales order quantities only`);

  // colours: sales order colours + CAD colorways (colour-wise max over markers: body and rib are the same garments)
  type Cell = { so_qty: number; cad_order_qty: number; cad_cut_qty: number };
  const colours = new Map<string, { color_name: string; color_id: number | null; cells: Map<string, Cell>; excess_pct: number }>();
  const colourOf = (name: string | null, id: number | null) => {
    const k = norm(name) || `#${id ?? 0}`;
    if (!colours.has(k)) colours.set(k, { color_name: name ?? 'Solid', color_id: id, cells: new Map(), excess_pct: 0 });
    const c = colours.get(k)!; if (!c.color_id && id) c.color_id = id;
    return c;
  };
  const cell = (c: { cells: Map<string, Cell> }, sz: string) => {
    if (!c.cells.has(up(sz))) c.cells.set(up(sz), { so_qty: 0, cad_order_qty: 0, cad_cut_qty: 0 });
    return c.cells.get(up(sz))!;
  };
  for (const r of soRows) {
    const c = colourOf(r.color_name, r.color_id ? Number(r.color_id) : null);
    c.excess_pct = Math.max(c.excess_pct, num(r.excess_pct));
    if (r.size_code) cell(c, r.size_code).so_qty += num(r.qty);
  }
  for (const m of markers) {
    for (const cw of m.colorways) {
      const c = colourOf(cw.color_name, null);
      m.sizes.forEach((sz, i) => {
        const x = cell(c, sz);
        x.cad_order_qty = Math.max(x.cad_order_qty, cw.quantities[i] || 0);
        x.cad_cut_qty = Math.max(x.cad_cut_qty, cw.cut_quantities[i] || 0);
      });
    }
  }
  // colour ids for CAD-only colour names
  for (const c of colours.values()) {
    if (!c.color_id && c.color_name) {
      const hit = await queryOne<any>(`SELECT id, color_name FROM mst_color WHERE company_id = ? AND (UPPER(color_name) = ? OR UPPER(color_code) = ?) ORDER BY id LIMIT 1`, [cid, up(c.color_name), up(c.color_name)]);
      if (hit) { c.color_id = Number(hit.id); c.color_name = hit.color_name; }
    }
  }
  const allSizes = [...new Set([...soRows.filter((r) => r.size_code).sort((a, b) => num(a.sort_order) - num(b.sort_order)).map((r) => up(r.size_code)),
    ...markers.flatMap((m) => m.sizes.map(up))])];
  const sizeMap = await sizeIdsFor(styleId, allSizes);
  const sizeOrder = allSizes.sort((a, b) => (sizeMap.get(a)?.sort_order ?? 999) - (sizeMap.get(b)?.sort_order ?? 999));
  for (const sz of sizeOrder) if (!sizeMap.has(sz)) warnings.push(`Size ${sz} is not in the size master — add it before planning it`);

  // what the other cut plans of this job + style already hold, colour × size
  const plans = await query<any>(
    `SELECT cp.id, cp.plan_no, cp.status, cp.color_id, cp.fabric_id, cp.planned_cut_qty, cp.actual_cut_qty, cp.cad_req_id, col.color_name, fb.fabric_name
       FROM trx_cutting_plan cp LEFT JOIN mst_color col ON col.id = cp.color_id LEFT JOIN mst_fabric fb ON fb.id = cp.fabric_id
      WHERE cp.company_id = ? AND cp.style_id = ? AND (cp.so_id = ? OR cp.io_no IN (?, ?)) AND cp.status <> 'CANCELLED' ORDER BY cp.id`,
    [cid, styleId, soId, job.io_no ?? job.so_no, job.so_no]);
  const planSizes = plans.length ? await query<any>(
    `SELECT cps.cutting_plan_id, sz.size_code, cps.planned_qty, cps.actual_qty FROM trx_cutting_plan_size cps JOIN mst_size sz ON sz.id = cps.size_id
      WHERE cps.cutting_plan_id IN (${plans.map(() => '?').join(',')})`, plans.map((p) => p.id)) : [];

  const fabricsSeen = new Map<string, any>();
  for (const m of markers) {
    const k = norm(m.fabric_type);
    if (!fabricsSeen.has(k)) {
      const f = await fabricByName(cid, m.fabric_type, soId, styleId);
      fabricsSeen.set(k, { fabric_type: m.fabric_type, fabric_id: f?.id ?? null, fabric_name: f?.fabric_name ?? null, gsm: m.gsm, markers: [] as string[] });
    }
    fabricsSeen.get(k).markers.push(m.marker_ref);
  }

  const colourList = [...colours.values()].map((c) => {
    const myPlans = plans.filter((p) => (c.color_id && Number(p.color_id) === c.color_id) || norm(p.color_name) === norm(c.color_name));
    const sizes = sizeOrder.map((sz) => {
      const x = c.cells.get(sz) ?? { so_qty: 0, cad_order_qty: 0, cad_cut_qty: 0 };
      const planned = planSizes.filter((ps) => myPlans.some((p) => Number(p.id) === Number(ps.cutting_plan_id)) && up(ps.size_code) === sz);
      const soWithExcess = Math.ceil(x.so_qty * (1 + c.excess_pct / 100) - 1e-9);
      return {
        size_code: sizeMap.get(sz)?.size_code ?? sz, size_id: sizeMap.get(sz)?.size_id ?? null, so_qty: x.so_qty, cad_order_qty: x.cad_order_qty,
        cad_cut_qty: x.cad_cut_qty, order_qty: x.so_qty || x.cad_order_qty,
        // default plan qty: the CAD cut qty (order + rejection %), else the sales order qty + its excess %
        suggested_qty: x.cad_cut_qty || soWithExcess || x.cad_order_qty,
        planned_other: planned.reduce((a, p) => a + num(p.planned_qty), 0), cut_so_far: planned.reduce((a, p) => a + num(p.actual_qty), 0),
      };
    });
    return {
      color_name: c.color_name, color_id: c.color_id, excess_pct: c.excess_pct, sizes,
      totals: {
        so_qty: sizes.reduce((a, x) => a + x.so_qty, 0), cad_order_qty: sizes.reduce((a, x) => a + x.cad_order_qty, 0),
        cad_cut_qty: sizes.reduce((a, x) => a + x.cad_cut_qty, 0), suggested_qty: sizes.reduce((a, x) => a + x.suggested_qty, 0),
        planned_other: sizes.reduce((a, x) => a + x.planned_other, 0),
      },
      plans: myPlans.map((p) => ({ id: p.id, plan_no: p.plan_no, status: p.status, fabric_name: p.fabric_name, planned_cut_qty: p.planned_cut_qty, actual_cut_qty: p.actual_cut_qty })),
      marker_plies: markers.map((m) => ({ marker_ref: m.marker_ref, plies: cadPliesForColour(m, c.color_name) })),
    };
  });

  res.json({
    data: {
      job, styles, style_id: styleId,
      style: styles.find((x) => Number(x.style_id) === styleId) ?? null,
      cad: cad ? { id: Number(cad.id), req_no: cad.req_no, status: cad.status, uom: cad.uom, rejection_pct: num(cad.rejection_pct),
        fabric_allowance_pct: num(cad.fabric_allowance_pct), marker_efficiency: num(cad.marker_efficiency) } : null,
      sizes: sizeOrder.map((sz) => ({ size_code: sizeMap.get(sz)?.size_code ?? sz, size_id: sizeMap.get(sz)?.size_id ?? null })),
      colours: colourList,
      fabrics: [...fabricsSeen.values()],
      markers: markers.map((m) => ({ marker_ref: m.marker_ref, marker_name: m.marker_name, fabric_type: m.fabric_type, gsm: m.gsm, uom: m.uom,
        sizes: m.sizes, ratios: m.ratios, ppm: m.ppm, length_m: m.length_m, kg_per_ply: m.kg_per_ply, width_in: m.width_in })),
      plans,
      warnings,
    },
  });
}));

/* ------------------------------------------------------------------ requirement of a cut order */

async function loadPlan(tx: Tx | null, cid: number, planId: number) {
  const plan = await q1<any>(tx,
    `SELECT cp.*, st.style_code, st.style_name, col.color_name, fb.fabric_name, so.so_no, so.buyer_po_no AS so_buyer_po_no, p.party_name AS buyer_name
       FROM trx_cutting_plan cp
       LEFT JOIN mst_style st ON st.id = cp.style_id
       LEFT JOIN mst_color col ON col.id = cp.color_id
       LEFT JOIN mst_fabric fb ON fb.id = cp.fabric_id
       LEFT JOIN trx_sales_order so ON so.id = cp.so_id
       LEFT JOIN mst_party p ON p.id = so.buyer_id
      WHERE cp.id = ? AND cp.company_id = ?`, [planId, cid]);
  if (!plan) throw NotFound('Cut order not found');
  return plan;
}

/** Size-wise target, already cut, already on open lays and pending (doc §20: pending = order − already cut good). */
export async function planRequirement(tx: Tx | null, planId: number, excludeLayIds: number[] = []) {
  const sizes = await q<any>(tx,
    `SELECT cps.size_id, cps.order_qty, cps.planned_qty, cps.actual_qty, sz.size_code, sz.size_label, sz.sort_order
       FROM trx_cutting_plan_size cps JOIN mst_size sz ON sz.id = cps.size_id WHERE cps.cutting_plan_id = ? ORDER BY sz.sort_order, sz.id`, [planId]);
  const open = await q<any>(tx,
    `SELECT lp.id, lp.lay_no, lp.status, lp.ply_count, lp.size_output, mv.sizes, mv.ratios, mv.pieces_per_marker
       FROM trx_lay_plan lp LEFT JOIN trx_marker_version mv ON mv.id = lp.marker_version_id
      WHERE lp.cutting_plan_id = ? AND lp.status IN (${inList(OPEN_LAY)})`, [planId]);
  const openBy: Record<string, number> = {};
  for (const l of open) {
    if (excludeLayIds.includes(Number(l.id))) continue;
    let out = parseJson<Record<string, number> | null>(l.size_output, null);
    if (!out && l.sizes) {
      const pp = perPly({ sizes: parseJson(l.sizes, []), ratios: parseJson(l.ratios, []), pieces_per_marker: num(l.pieces_per_marker) });
      out = Object.fromEntries(Object.entries(pp).map(([k, n]) => [k, n * num(l.ply_count)]));
    }
    for (const [k, v] of Object.entries(out ?? {})) openBy[up(k)] = (openBy[up(k)] ?? 0) + num(v);
  }
  const rows = sizes.map((x) => {
    const target = num(x.planned_qty) > 0 ? num(x.planned_qty) : num(x.order_qty);
    const cut = num(x.actual_qty);
    const onLays = openBy[up(x.size_code)] ?? 0;
    return { size_id: Number(x.size_id), size_code: x.size_code, order_qty: num(x.order_qty), target, cut, on_open_lays: onLays,
      pending: Math.max(0, target - cut - onLays), to_cut: Math.max(0, target - cut) };
  });
  const sum = (k: 'target' | 'cut' | 'on_open_lays' | 'pending' | 'order_qty') => rows.reduce((a, r) => a + r[k], 0);
  return { sizes: rows, totals: { order_qty: sum('order_qty'), target: sum('target'), cut: sum('cut'), on_open_lays: sum('on_open_lays'), pending: sum('pending') }, open_lays: open.length };
}

const toCalcMarker = (mv: any): CalcMarker => ({
  marker_version_id: Number(mv.id), marker_no: mv.marker_no, version: Number(mv.version),
  sizes: parseJson<string[]>(mv.sizes, []).map(String), ratios: parseJson<number[]>(mv.ratios, []).map(Number),
  pieces_per_marker: num(mv.pieces_per_marker), length_m: mv.length_m != null ? num(mv.length_m) : null,
  kg_per_ply: (mv.uom ?? 'KG') === 'KG' && mv.marker_kg_per_ply != null ? num(mv.marker_kg_per_ply) : null,
});

/** A marker version may plan lays for this cut order (doc §23). Throws with the reason. */
function assertMarkerUsable(mv: any, plan: any, requireApproved: boolean) {
  if (['OBSOLETE', 'REJECTED'].includes(mv.status)) throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is ${mv.status} — it cannot create a new lay`);
  if (requireApproved && mv.status !== 'APPROVED') throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is ${mv.status} — only an APPROVED marker version can be used for production`);
  if (mv.style_id && Number(mv.style_id) !== Number(plan.style_id)) throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is for another style`);
  if (mv.fabric_id && plan.fabric_id && Number(mv.fabric_id) !== Number(plan.fabric_id)) throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is for another fabric`);
  if (mv.color_id && plan.color_id && Number(mv.color_id) !== Number(plan.color_id)) throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is for another colour`);
}

/* ------------------------------------------------------------------ roll eligibility (doc §8) */

export interface RollElig {
  id: number; roll_no: string; lot_no: string | null; shade: string | null; gsm: number | null; width_in: number | null;
  weight_kg: number; issued_kg: number; reserved_kg: number; quoted_kg: number; available_kg: number; available_m: number | null;
  kg_per_m: number | null; grn_no: string | null; grn_date: string | null; warehouse_id: number; warehouse_name: string | null;
  location_bin: string | null; roll_job: string | null; color_name: string | null; qc_status: string; eligible: boolean; reasons: string[]; fifo: string;
}

export async function eligibleRolls(tx: Tx | null, cid: number, plan: any, opts: { layId?: number; warehouseId?: number | null; mv?: any; rollIds?: number[]; lock?: boolean } = {}): Promise<RollElig[]> {
  const st = await cutSettings(cid);
  const params: any[] = [opts.layId ?? 0, cid];
  let where = `fr.company_id = ? AND fr.stock_status <> 'CLOSED' AND COALESCE(fr.weight_kg,0) - fr.issued_kg > ${KG_EPS}`;
  if (plan.fabric_id) { where += ' AND fr.fabric_id = ?'; params.push(plan.fabric_id); }
  if (opts.rollIds?.length) { where += ` AND fr.id IN (${opts.rollIds.map(() => '?').join(',')})`; params.push(...opts.rollIds); }
  const rows = await q<any>(tx,
    `SELECT fr.id, fr.roll_no, fr.lot_no, fr.shade, fr.gsm, fr.actual_gsm, fr.width_m, fr.meters, fr.weight_kg, fr.issued_kg, fr.qc_status,
            fr.so_id, fr.color_name, fr.warehouse_id, fr.location_bin, fr.created_at, g.grn_no, g.grn_date, wh.warehouse_name, so.io_no AS roll_job, so.so_no AS roll_so,
            ${RESERVED_KG_SQL('fr.id', '?')} AS reserved_kg, ${OPEN_ALLOC_SQL('fr.id', '0')} AS quoted_kg
       FROM trx_fabric_roll fr
       LEFT JOIN trx_grn g ON g.id = fr.grn_id
       LEFT JOIN mst_warehouse wh ON wh.id = fr.warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = fr.so_id
      WHERE ${where}
      ORDER BY COALESCE(g.grn_date, DATE(fr.created_at)), fr.id LIMIT 2000${opts.lock ? ' FOR UPDATE' : ''}`, params);
  const mvGsm = opts.mv?.gsm != null ? num(opts.mv.gsm) : null;
  const mvWidth = opts.mv?.width_in != null ? num(opts.mv.width_in) : null;
  return rows.map((r) => {
    const reasons: string[] = [];
    const weight = num(r.weight_kg);
    const available = r3(weight - num(r.issued_kg) - num(r.reserved_kg) - num(r.quoted_kg));
    const kgPerM = num(r.meters) > 0 && weight > 0 ? weight / num(r.meters) : null;
    const availM = kgPerM ? r3(available / kgPerM) : null;
    const gsm = num(r.actual_gsm) || num(r.gsm) || null;
    const widthIn = num(r.width_m) > 0 ? round(num(r.width_m) / 0.0254, 1) : null;
    if (r.qc_status !== 'ACCEPTED') reasons.push(`QC ${r.qc_status}`);
    if (plan.so_id) {
      if (!r.so_id) reasons.push('General stock — transfer it to the job first');
      else if (Number(r.so_id) !== Number(plan.so_id)) reasons.push(`Job ${r.roll_job || r.roll_so}`);
    }
    if (plan.color_name && r.color_name && norm(plan.color_name) !== norm(r.color_name)) reasons.push(`Colour ${r.color_name}`);
    if (mvGsm && gsm && Math.abs(gsm - mvGsm) / mvGsm * 100 > st.gsm_tolerance_pct + 1e-9) reasons.push(`GSM ${gsm} vs marker ${mvGsm} (> ${st.gsm_tolerance_pct}%)`);
    if (mvWidth && widthIn && widthIn + 0.5 < mvWidth) reasons.push(`Width ${widthIn}" narrower than marker ${mvWidth}"`);
    if (available <= KG_EPS) reasons.push(num(r.reserved_kg) > 0 ? 'Reserved for other lays' : num(r.quoted_kg) > 0 ? 'Held on a process quotation' : 'Nothing free');
    else if (availM != null && availM < st.min_reusable_m) reasons.push(`Balance ${availM} m below the ${st.min_reusable_m} m minimum`);
    if (opts.warehouseId && Number(r.warehouse_id) !== Number(opts.warehouseId)) reasons.push(`At ${r.warehouse_name ?? 'another store'}`);
    return {
      id: Number(r.id), roll_no: r.roll_no, lot_no: r.lot_no ?? null, shade: r.shade ?? null, gsm, width_in: widthIn, weight_kg: weight,
      issued_kg: num(r.issued_kg), reserved_kg: r3(num(r.reserved_kg)), quoted_kg: r3(num(r.quoted_kg)), available_kg: Math.max(0, available),
      available_m: availM != null ? Math.max(0, availM) : null, kg_per_m: kgPerM, grn_no: r.grn_no ?? null,
      grn_date: r.grn_date ? String(r.grn_date instanceof Date ? r.grn_date.toISOString() : r.grn_date).slice(0, 10) : null,
      warehouse_id: Number(r.warehouse_id), warehouse_name: r.warehouse_name ?? null, location_bin: r.location_bin ?? null,
      roll_job: r.roll_job ?? r.roll_so ?? null, color_name: r.color_name ?? null, qc_status: r.qc_status, eligible: reasons.length === 0, reasons,
      fifo: `${r.grn_date ? String(r.grn_date instanceof Date ? r.grn_date.toISOString() : r.grn_date).slice(0, 10) : '9999'}|${String(r.id).padStart(10, '0')}`,
    };
  });
}

function fabricSummary(rolls: RollElig[]) {
  const ok = rolls.filter((r) => r.eligible);
  return {
    eligible_rolls: ok.length, eligible_kg: r3(ok.reduce((a, r) => a + r.available_kg, 0)),
    eligible_m: ok.every((r) => r.available_m != null) ? r3(ok.reduce((a, r) => a + (r.available_m ?? 0), 0)) : null,
    ineligible_rolls: rolls.length - ok.length,
  };
}

/* ------------------------------------------------------------------ lay workbench (audio 1 + 3) */

async function planMarkers(cid: number, plan: any) {
  const cad = await findCad(cid, [plan.io_no, plan.so_no], Number(plan.style_id), plan.cad_req_id ? Number(plan.cad_req_id) : null);
  const markers = cad ? await cadMarkers(Number(cad.id)) : [];
  const pics = cad ? await query<any>(`SELECT marker_ref, image_url, file_url, kind FROM trx_cad_marker_file WHERE cad_req_id = ? AND is_active = 1 ORDER BY id DESC`, [cad.id]).catch(() => []) : [];
  const picOf = (ref: string) => pics.find((p) => p.marker_ref === ref && p.image_url)?.image_url ?? null;
  const reportOf = (ref: string) => pics.find((p) => p.marker_ref === ref && p.kind === 'REPORT')?.file_url ?? null;
  const versions = await query<any>(
    `SELECT mv.*, u.full_name AS approved_by_name FROM trx_marker_version mv LEFT JOIN mst_user u ON u.id = mv.approved_by
      WHERE mv.company_id = ? AND ((? IS NOT NULL AND mv.cad_req_id = ?) OR (mv.cad_req_id IS NULL AND mv.style_id = ?))
      ORDER BY mv.marker_no, mv.version DESC`, [cid, cad?.id ?? null, cad?.id ?? null, plan.style_id]);
  const shape = (v: any) => ({
    id: Number(v.id), marker_no: v.marker_no, version: Number(v.version), status: v.status, source: v.source, cad_source: v.cad_source,
    fabric_id: v.fabric_id ? Number(v.fabric_id) : null, color_id: v.color_id ? Number(v.color_id) : null,
    sizes: parseJson(v.sizes, []), ratios: parseJson(v.ratios, []), pieces_per_marker: num(v.pieces_per_marker),
    length_m: v.length_m != null ? num(v.length_m) : null, width_in: v.width_in != null ? num(v.width_in) : null, gsm: v.gsm != null ? num(v.gsm) : null,
    marker_kg_per_ply: v.marker_kg_per_ply != null ? num(v.marker_kg_per_ply) : null, uom: v.uom, efficiency_pct: v.efficiency_pct != null ? num(v.efficiency_pct) : null,
    cad_kg_per_pc: v.cad_kg_per_pc != null ? num(v.cad_kg_per_pc) : null, is_locked: !!v.is_locked, approved_at: v.approved_at, approved_by_name: v.approved_by_name ?? null,
    cad_file_ref: v.cad_file_ref ?? null, marker_image_url: v.marker_image_url ?? null,
  });
  const fits = (v: any) => (!v.fabric_id || !plan.fabric_id || Number(v.fabric_id) === Number(plan.fabric_id))
    && (!v.color_id || !plan.color_id || Number(v.color_id) === Number(plan.color_id));
  const planFabric = norm(plan.fabric_name);
  const out = markers.map((m) => {
    const vs = versions.filter((v) => v.cad_req_id && Number(v.cad_req_id) === Number(cad.id) && v.marker_no === m.marker_ref && fits(v)).map(shape);
    const ft = norm(m.fabric_type);
    return {
      key: `CAD:${m.marker_ref}`, source: 'CAD', marker_ref: m.marker_ref, marker_name: m.marker_name, fabric_type: m.fabric_type,
      fabric_match: !planFabric || !ft ? null : (planFabric.includes(ft) || ft.includes(planFabric)),
      has_colour: !plan.color_name || m.colorways.some((c) => norm(c.color_name) === norm(plan.color_name)),
      cad_plies: cadPliesForColour(m, plan.color_name), sizes: m.sizes, ratios: m.ratios, ppm: m.ppm, length_m: m.length_m,
      kg_per_ply: m.kg_per_ply, width_in: m.width_in, gsm: m.gsm, uom: m.uom,
      versions: vs, usable: vs.find((v) => v.status === 'APPROVED') ?? null, latest: vs[0] ?? null,
      image_url: picOf(m.marker_ref), report_url: reportOf(m.marker_ref),
    };
  });
  // imported / manual markers of the style (no CAD requirement)
  const loose = new Map<string, any[]>();
  for (const v of versions.filter((x) => !x.cad_req_id && fits(x))) loose.set(v.marker_no, [...(loose.get(v.marker_no) ?? []), shape(v)]);
  for (const [no, vs] of loose) {
    const l = vs[0];
    out.push({
      key: `MV:${no}`, source: l.cad_source || l.source || 'IMPORT', marker_ref: no, marker_name: null, fabric_type: null, fabric_match: null, has_colour: true,
      cad_plies: null, sizes: l.sizes, ratios: l.ratios, ppm: l.pieces_per_marker, length_m: l.length_m, kg_per_ply: l.uom === 'KG' ? l.marker_kg_per_ply : null,
      width_in: l.width_in, gsm: l.gsm, uom: l.uom, versions: vs, usable: vs.find((v) => v.status === 'APPROVED') ?? null, latest: l,
      image_url: l.marker_image_url ?? null, report_url: null,
    });
  }
  return { cad, markers: out };
}

const LAY_LIST_SQL = `SELECT lp.*, mv.marker_no, mv.version AS marker_version, mv.pieces_per_marker, mv.status AS marker_status, mv.length_m AS marker_len_m,
       fi.issue_no, fi.status AS dc_status,
       (SELECT COUNT(*) FROM trx_lay_roll_alloc a WHERE a.lay_id = lp.id AND a.status IN ('RESERVED','ISSUED','CONSUMED')) AS alloc_rolls,
       (SELECT COALESCE(SUM(a.alloc_kg),0) FROM trx_lay_roll_alloc a WHERE a.lay_id = lp.id AND a.status IN ('RESERVED','ISSUED','CONSUMED')) AS alloc_kg,
       (SELECT COALESCE(SUM(a.alloc_m),0) FROM trx_lay_roll_alloc a WHERE a.lay_id = lp.id AND a.status IN ('RESERVED','ISSUED','CONSUMED')) AS alloc_m,
       (SELECT GROUP_CONCAT(DISTINCT CONCAT_WS('/', NULLIF(a.shade,''), NULLIF(a.lot_no,'')) SEPARATOR ', ') FROM trx_lay_roll_alloc a WHERE a.lay_id = lp.id AND a.status IN ('RESERVED','ISSUED','CONSUMED')) AS shade_lots,
       (SELECT sp.id FROM trx_spreading sp WHERE sp.lay_id = lp.id ORDER BY sp.id DESC LIMIT 1) AS spreading_id,
       (SELECT sp.status FROM trx_spreading sp WHERE sp.lay_id = lp.id ORDER BY sp.id DESC LIMIT 1) AS spreading_status,
       (SELECT sp.actual_kg FROM trx_spreading sp WHERE sp.lay_id = lp.id ORDER BY sp.id DESC LIMIT 1) AS spread_kg,
       (SELECT sp.actual_used_mtr FROM trx_spreading sp WHERE sp.lay_id = lp.id ORDER BY sp.id DESC LIMIT 1) AS spread_m
  FROM trx_lay_plan lp
  LEFT JOIN trx_marker_version mv ON mv.id = lp.marker_version_id
  LEFT JOIN trx_fabric_issue fi ON fi.id = lp.fabric_issue_id`;

/** GET /cutting-plans/:id/lay-workbench */
layEngineRouter.get('/cutting-plans/:id/lay-workbench', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const plan = await loadPlan(null, cid, Number(req.params.id));
  const [requirement, mk, lays, settings, tables] = await Promise.all([
    planRequirement(null, plan.id), planMarkers(cid, plan),
    query<any>(`${LAY_LIST_SQL} WHERE lp.cutting_plan_id = ? AND lp.company_id = ? ORDER BY COALESCE(lp.gen_batch,''), COALESCE(lp.lay_seq, 0), lp.id`, [plan.id, cid]),
    cutSettings(cid),
    query<any>(`SELECT * FROM mst_cutting_table WHERE company_id = ? AND is_active = 1 ORDER BY table_code`, [cid]),
  ]);
  const rolls = await eligibleRolls(null, cid, plan, { mv: mk.markers.find((m) => m.usable)?.usable ?? null });
  const withCutting = await queryOne<any>(
    `SELECT COALESCE(SUM(fir.issue_kg - fir.consumed_kg - fir.returned_kg),0) kg FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
      WHERE fi.cutting_plan_id = ? AND fir.roll_status <> 'CLOSED'`, [plan.id]);
  const reserved = await queryOne<any>(`SELECT COALESCE(SUM(alloc_kg),0) kg FROM trx_lay_roll_alloc WHERE cutting_plan_id = ? AND status = 'RESERVED'`, [plan.id]);
  res.json({
    data: {
      plan: { ...plan, buyer_po_no: plan.buyer_po_no || plan.so_buyer_po_no || null },
      requirement, cad: mk.cad ? { id: Number(mk.cad.id), req_no: mk.cad.req_no, status: mk.cad.status, marker_efficiency: num(mk.cad.marker_efficiency),
        rejection_pct: num(mk.cad.rejection_pct), fabric_allowance_pct: num(mk.cad.fabric_allowance_pct) } : null,
      markers: mk.markers,
      lays: lays.map((l) => ({ ...l, size_output: parseJson(l.size_output, null) })),
      fabric: { ...fabricSummary(rolls), reserved_kg: r3(num(reserved?.kg)), with_cutting_kg: r3(num(withCutting?.kg)) },
      settings, tables,
    },
  });
}));

/* ------------------------------------------------------------------ automatic lay generation (doc §6, §7, §20) */

const generateSchema = z.object({
  preview: z.coerce.boolean().default(false),
  marker_version_ids: z.array(z.coerce.number().int().positive()).min(1, 'Choose at least one approved marker'),
  strategy: z.enum(['COVER', 'NO_OVER']).default('COVER'),
  max_ply: z.coerce.number().int().positive().max(1000).optional(),
  min_ply: z.coerce.number().int().positive().max(1000).optional(),
  table_id: s.id(),
  /** the user's edits: ply per lay, in order (replaces the automatic split) */
  lays: z.array(z.object({ marker_version_id: z.coerce.number().int().positive(), ply: z.coerce.number().int().min(0).max(1000) })).optional(),
  lay_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  override_reason: s.nullableStr(255),
  remarks: s.nullableStr(500),
});

layEngineRouter.post('/cutting-plans/:id/generate-lay', PLAN, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const planId = Number(req.params.id);
  const body = generateSchema.parse(req.body ?? {});
  const st = await cutSettings(cid);

  const compute = async (tx: Tx | null) => {
    const plan = tx ? await lockPlan(tx, cid, planId) : await loadPlan(null, cid, planId);
    const full = tx ? await loadPlan(tx, cid, planId) : plan;
    assertPlanOpen(plan, 'plan lays');
    const table = body.table_id ? await q1<any>(tx, `SELECT * FROM mst_cutting_table WHERE id = ? AND company_id = ?`, [body.table_id, cid]) : null;
    if (body.table_id && !table) throw NotFound('Cutting table not found');
    const maxPly = body.max_ply ?? (table ? num(table.max_ply) : st.max_ply);
    const minPly = body.min_ply ?? (table ? num(table.min_ply) : st.min_ply);
    if (table && num(table.max_ply) > 0 && maxPly > num(table.max_ply)) throw BadRequest(`Table ${table.table_code} takes at most ${table.max_ply} plies`);
    const ids = [...new Set(body.marker_version_ids)];
    const mvs = await q<any>(tx, `SELECT * FROM trx_marker_version WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [cid, ...ids]);
    if (mvs.length !== ids.length) throw NotFound('Marker version not found');
    const ordered = ids.map((id) => mvs.find((m) => Number(m.id) === id));
    const warnings: string[] = [];
    for (const mv of ordered) {
      assertMarkerUsable(mv, full, st.require_approved_marker);
      if (table && num(table.length_m) > 0 && num(mv.length_m) > num(table.length_m)) {
        throw BadRequest(`Marker ${mv.marker_no} (${num(mv.length_m)} m) is longer than table ${table.table_code} (${num(table.length_m)} m)`);
      }
      if (mv.status !== 'APPROVED') warnings.push(`Marker ${mv.marker_no} v${mv.version} is not approved (allowed by setting)`);
    }
    const reqm = await planRequirement(tx, planId);
    const requirement = Object.fromEntries(reqm.sizes.map((x) => [x.size_code, x.pending]));
    if (!reqm.sizes.length) throw BadRequest(`Cut order ${plan.plan_no} has no size breakdown — load the cutting program first`);
    const calc = planLays({
      requirement, markers: ordered.map(toCalcMarker), maxPly, minPly, strategy: body.strategy, tolerancePct: st.size_tolerance_pct,
      sizeOrder: reqm.sizes.map((x) => x.size_code), layPlies: body.lays ?? null,
    });
    // running balance per lay: garment pending and fabric available (audio 1: "how much each lay takes, the balance")
    const rolls = await eligibleRolls(tx, cid, full, { mv: ordered[0] });
    const fab = fabricSummary(rolls);
    let pcsLeft = reqm.totals.pending; let kgLeft = fab.eligible_kg; let mLeft = fab.eligible_m;
    const lays = calc.lays.map((l) => {
      pcsLeft -= l.output_pcs; if (l.kg != null) kgLeft -= l.kg; if (mLeft != null && l.length_m != null) mLeft -= l.length_m;
      return { ...l, balance_pcs: r3(pcsLeft), fabric_balance_kg: r3(kgLeft), fabric_balance_m: mLeft != null ? r3(mLeft) : null };
    });
    if (calc.totals.fabric_kg != null && calc.totals.fabric_kg > fab.eligible_kg + KG_EPS) {
      warnings.push(`Lays need ${calc.totals.fabric_kg} KG but only ${fab.eligible_kg} KG of eligible rolls are free for this cut order`);
    }
    return { plan: full, table, maxPly, minPly, reqm, calc: { ...calc, lays, warnings: [...warnings, ...calc.warnings] }, fabric: fab, mvs: ordered };
  };

  if (body.preview) {
    const r = await compute(null);
    res.json({ data: { requirement: r.reqm, ...r.calc, fabric: r.fabric, max_ply: r.maxPly, min_ply: r.minPly, strategy: body.strategy, settings: st } });
    return;
  }

  const created = await transaction(async (tx) => {
    const r = await compute(tx);
    if (!r.calc.lays.length) throw BadRequest('Nothing to plan — the cut order has no pending quantity for these markers');
    const overTol = r.calc.sizes.filter((x) => x.over_tolerance);
    if (overTol.length && !body.override_reason) {
      throw BadRequest(`Over-production beyond the ${st.size_tolerance_pct}% size tolerance (${overTol.map((x) => `${x.size} +${x.over}`).join(', ')}) — give a reason to plan it`);
    }
    if (r.calc.lays.some((l) => l.ply > r.maxPly)) throw BadRequest(`A lay has more than ${r.maxPly} plies — split it`);
    const batch = `G${Date.now().toString(36).toUpperCase()}`;
    const mvBy = new Map(r.mvs.map((m) => [Number(m.id), m]));
    const out: any[] = [];
    for (const l of r.calc.lays) {
      const mv = mvBy.get(l.marker_version_id)!;
      const layNo = await nextUniqueDocNo(tx, cid, 'LAY_PLAN', 'trx_lay_plan', 'lay_no');
      const widthCm = mv.width_in ? round(num(mv.width_in) * 2.54, 2) : null;
      const ins = await txExecute(tx,
        `INSERT INTO trx_lay_plan
          (company_id, lay_no, lay_date, io_no, cutting_plan_id, style_id, color_id, marker_ref, marker_version_id,
           marker_length_m, ply_count, expected_pieces, planned_kg, fabric_width_cm, fabric_id, table_no,
           planned_cut_qty, status, remarks, created_by, lay_seq, so_id, gen_batch, planned_length_m, size_output, table_id, override_reason, override_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'GENERATED',?,?,?,?,?,?,?,?,?,?)`,
        [cid, layNo, body.lay_date ?? new Date().toISOString().slice(0, 10), r.plan.io_no, r.plan.id, r.plan.style_id, r.plan.color_id ?? null,
         `${mv.marker_no} v${mv.version}`.slice(0, 60), mv.id, mv.length_m ?? null, l.ply, l.output_pcs, l.kg, widthCm, r.plan.fabric_id ?? null,
         r.table?.table_code ?? null, l.output_pcs, body.remarks ?? null, req.user!.id, l.seq, r.plan.so_id ?? null, batch, l.length_m,
         JSON.stringify(l.output), r.table?.id ?? null, overTol.length ? body.override_reason : null, overTol.length ? req.user!.id : null]);
      out.push({ id: ins.insertId, lay_no: layNo, seq: l.seq, marker: `${mv.marker_no} v${mv.version}`, ply: l.ply, output_pcs: l.output_pcs, kg: l.kg, length_m: l.length_m });
    }
    return { batch, lays: out, totals: r.calc.totals, sizes: r.calc.sizes, warnings: r.calc.warnings, override: overTol.length > 0 };
  });
  for (const l of created.lays) await audit(req, 'trx_lay_plan', l.id, 'INSERT', undefined, { ...l, gen_batch: created.batch, generated: true });
  if (created.override) await audit(req, 'trx_cutting_plan', planId, 'UPDATE', undefined, { size_tolerance_override: body.override_reason, sizes: created.sizes });
  res.status(201).json({ data: created });
}));

/* ------------------------------------------------------------------ rolls: eligibility, allocation, reservation */

layEngineRouter.get('/cutting-plans/:id/eligible-rolls', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const plan = await loadPlan(null, cid, Number(req.params.id));
  const layId = req.query.lay_id ? Number(req.query.lay_id) : undefined;
  const lay = layId ? await queryOne<any>(`SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ?`, [layId, cid]) : null;
  const mv = lay?.marker_version_id ? await queryOne<any>(`SELECT * FROM trx_marker_version WHERE id = ?`, [lay.marker_version_id]) : null;
  const rolls = await eligibleRolls(null, cid, plan, { layId, warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null, mv });
  const list = req.query.all === '1' ? rolls : rolls.filter((r) => r.eligible);
  res.json({ data: list, summary: fabricSummary(rolls), meta: { plan_no: plan.plan_no, fabric_name: plan.fabric_name, color_name: plan.color_name } });
}));

async function layWithPlan(tx: Tx | null, cid: number, layId: number, lock = false) {
  const lay = await q1<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ?${lock ? ' FOR UPDATE' : ''}`, [layId, cid]);
  if (!lay) throw NotFound('Lay not found');
  if (!lay.cutting_plan_id) throw BadRequest('Lay is not linked to a cut order');
  const plan = await loadPlan(tx, cid, Number(lay.cutting_plan_id));
  const mv = lay.marker_version_id ? await q1<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ?`, [lay.marker_version_id]) : null;
  return { lay, plan, mv };
}

/** What a lay needs: KG when the marker is weighed, else metres. */
function layNeed(lay: any) {
  if (num(lay.planned_kg) > 0) return { basis: 'KG' as const, qty: num(lay.planned_kg) };
  const m = num(lay.planned_length_m) || num(lay.marker_length_m) * num(lay.ply_count);
  return { basis: 'M' as const, qty: r3(m) };
}

function proposeFor(lay: any, rolls: RollElig[]) {
  const need = layNeed(lay);
  const ok = rolls.filter((r) => r.eligible);
  if (need.basis === 'KG') {
    const a = allocateRolls(ok.map((r) => ({ id: r.id, roll_no: r.roll_no, lot_no: r.lot_no, shade: r.shade, available_kg: r.available_kg,
      kg_per_m: r.kg_per_m, fifo: r.fifo })), need.qty);
    return { need, ...a };
  }
  // metre basis: allocate metres, carry KG through each roll's own KG / m
  const withM = ok.filter((r) => r.kg_per_m && r.available_m != null);
  const a = allocateRolls(withM.map((r) => ({ id: r.id, roll_no: r.roll_no, lot_no: r.lot_no, shade: r.shade, available_kg: r.available_m!, kg_per_m: 1, fifo: r.fifo })), need.qty);
  const lines = a.lines.map((l) => {
    const r = withM.find((x) => x.id === l.fabric_roll_id)!;
    return { ...l, alloc_m: l.alloc_kg, alloc_kg: round(l.alloc_kg * (r.kg_per_m ?? 0), 4), balance_kg: round(l.balance_kg * (r.kg_per_m ?? 0), 4) };
  });
  return { need, ...a, lines, covered_kg: r3(lines.reduce((x, l) => x + l.alloc_kg, 0)) };
}

const RESERVABLE = ['GENERATED', 'ROLL_RESERVED', 'PLAN_APPROVED'];

/** Reserve rolls for a lay (replaces its current reservation). Locks the rolls and re-checks eligibility inside the transaction. */
async function reserveRolls(tx: Tx, req: any, layId: number, lines: { fabric_roll_id: number; alloc_kg: number }[], method: 'AUTO' | 'MANUAL') {
  const cid = req.user!.companyId;
  const { lay, plan, mv } = await layWithPlan(tx, cid, layId, true);
  if (!RESERVABLE.includes(lay.status)) throw BadRequest(`Lay ${lay.lay_no} is ${lay.status} — rolls can be (re)allocated only before fabric is issued`);
  assertPlanOpen(await lockPlan(tx, cid, plan.id), 'allocate rolls');
  const ids = lines.map((l) => l.fabric_roll_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('The same roll is listed twice');
  await txExecute(tx, `UPDATE trx_lay_roll_alloc SET status = 'RELEASED', released_by = ?, released_at = NOW(), release_reason = 'Re-allocated'
                        WHERE lay_id = ? AND status = 'RESERVED'`, [req.user!.id, lay.id]);
  const rolls = ids.length ? await eligibleRolls(tx, cid, plan, { layId: lay.id, mv, rollIds: ids, lock: true }) : [];
  const out: any[] = [];
  let seq = 0;
  for (const l of lines) {
    const r = rolls.find((x) => x.id === l.fabric_roll_id);
    if (!r) throw BadRequest(`Roll #${l.fabric_roll_id} is not stock of this cut order's fabric (or it is closed / empty)`);
    if (!r.eligible) throw BadRequest(`Roll ${r.roll_no} is not eligible: ${r.reasons.join('; ')}`);
    const kg = round(l.alloc_kg, 4);
    if (kg <= KG_EPS) continue;
    if (kg > r.available_kg + KG_EPS) throw BadRequest(`Roll ${r.roll_no}: ${kg} KG asked, only ${r.available_kg} KG free (reserved quantity cannot be allocated twice)`);
    const m = r.kg_per_m ? r3(kg / r.kg_per_m) : null;
    const ins = await txExecute(tx,
      `INSERT INTO trx_lay_roll_alloc (company_id, lay_id, cutting_plan_id, fabric_roll_id, roll_no, lot_no, shade, seq, alloc_kg, alloc_m, roll_balance_kg, status, method, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'RESERVED',?,?)`,
      [cid, lay.id, plan.id, r.id, r.roll_no, r.lot_no, r.shade, ++seq, kg, m, r3(r.available_kg - kg), method, req.user!.id]);
    await txExecute(tx,
      `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, qty_kg, so_id, remarks, user_id)
       VALUES (?,?,?,'CUT_RESERVE','LAY',?,?,?,?,?,?)`, [cid, r.id, r.roll_no, lay.id, lay.lay_no, kg, plan.so_id ?? null, `${method} allocation for cut order ${plan.plan_no}`, req.user!.id]);
    out.push({ id: ins.insertId, fabric_roll_id: r.id, roll_no: r.roll_no, lot_no: r.lot_no, shade: r.shade, alloc_kg: kg, alloc_m: m, roll_balance_kg: r3(r.available_kg - kg) });
  }
  const status = out.length ? 'ROLL_RESERVED' : 'GENERATED';
  await txExecute(tx, `UPDATE trx_lay_plan SET status = ?, plan_approved_by = NULL, plan_approved_at = NULL, updated_by = ?, updated_at = NOW() WHERE id = ?`,
    [status, req.user!.id, lay.id]);
  const need = layNeed(lay);
  const covered = need.basis === 'KG' ? out.reduce((a, x) => a + x.alloc_kg, 0) : out.reduce((a, x) => a + (x.alloc_m ?? 0), 0);
  return { lay_id: lay.id, lay_no: lay.lay_no, status, from: lay.status, lines: out, need, covered: r3(covered), short: r3(Math.max(0, need.qty - covered)),
    mixed_shade: new Set(out.map((x) => `${up(x.shade)}|${up(x.lot_no)}`)).size > 1 };
}

/** POST /lay-plans/:id/auto-allocate-rolls { warehouse_id?, reserve? } — proposal (and reservation when reserve = true) */
layEngineRouter.post('/lay-plans/:id/auto-allocate-rolls', PLAN, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({ warehouse_id: s.id(), reserve: z.coerce.boolean().default(false) }).parse(req.body ?? {});
  const { lay, plan, mv } = await layWithPlan(null, cid, Number(req.params.id));
  if (!RESERVABLE.includes(lay.status)) throw BadRequest(`Lay ${lay.lay_no} is ${lay.status} — rolls are allocated before fabric is issued`);
  const rolls = await eligibleRolls(null, cid, plan, { layId: lay.id, warehouseId: body.warehouse_id ?? null, mv });
  const p = proposeFor(lay, rolls);
  if (!body.reserve) { res.json({ data: { ...p, eligible: fabricSummary(rolls) } }); return; }
  if (!p.lines.length) throw BadRequest(`No eligible roll for lay ${lay.lay_no}: ${fabricSummary(rolls).ineligible_rolls} roll(s) of the fabric are not eligible — see Eligible rolls`);
  const r = await transaction((tx) => reserveRolls(tx, req, lay.id, p.lines.map((l) => ({ fabric_roll_id: l.fabric_roll_id, alloc_kg: l.alloc_kg })), 'AUTO'));
  await audit(req, 'trx_lay_plan', lay.id, 'UPDATE', { status: r.from }, { status: r.status, reservation: r.lines, short: r.short, method: 'AUTO' });
  res.status(201).json({ data: { ...p, reserved: r } });
}));

/** POST /lay-plans/:id/reserve { rolls: [{ fabric_roll_id, alloc_kg }] } — manual (re)allocation */
layEngineRouter.post('/lay-plans/:id/reserve', PLAN, ah(async (req, res) => {
  const body = z.object({
    rolls: z.array(z.object({ fabric_roll_id: s.idReq(), alloc_kg: z.coerce.number().positive() })).min(1, 'Pick at least one roll'),
    method: z.enum(['AUTO', 'MANUAL']).default('MANUAL'),
  }).parse(req.body ?? {});
  const r = await transaction((tx) => reserveRolls(tx, req, Number(req.params.id), body.rolls, body.method));
  await audit(req, 'trx_lay_plan', r.lay_id, 'UPDATE', { status: r.from }, { status: r.status, reservation: r.lines, short: r.short, method: body.method });
  res.status(201).json({ data: r });
}));

/** POST /lay-plans/:id/release-rolls { reason } */
layEngineRouter.post('/lay-plans/:id/release-rolls', PLAN, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});
  const r = await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [Number(req.params.id), cid]);
    if (!lay) throw NotFound('Lay not found');
    if (!['ROLL_RESERVED', 'PLAN_APPROVED'].includes(lay.status)) throw BadRequest(`Lay ${lay.lay_no} is ${lay.status} — nothing reserved to release`);
    const x = await txExecute(tx, `UPDATE trx_lay_roll_alloc SET status = 'RELEASED', released_by = ?, released_at = NOW(), release_reason = ? WHERE lay_id = ? AND status = 'RESERVED'`,
      [req.user!.id, body.reason, lay.id]);
    await txExecute(tx, `UPDATE trx_lay_plan SET status = 'GENERATED', plan_approved_by = NULL, plan_approved_at = NULL, updated_by = ?, updated_at = NOW() WHERE id = ?`, [req.user!.id, lay.id]);
    return { lay, released: x.affectedRows };
  });
  await audit(req, 'trx_lay_plan', r.lay.id, 'UPDATE', { status: r.lay.status }, { status: 'GENERATED', released: r.released, reason: body.reason });
  res.json({ data: { id: r.lay.id, status: 'GENERATED', released: r.released } });
}));

/** GET /lay-plans/:id/allocations */
layEngineRouter.get('/lay-plans/:id/allocations', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query<any>(
    `SELECT a.*, fr.weight_kg, fr.issued_kg, fr.meters, fr.gsm, fr.dia, g.grn_no, wh.warehouse_name, fr.location_bin, u.full_name AS created_by_name
       FROM trx_lay_roll_alloc a JOIN trx_fabric_roll fr ON fr.id = a.fabric_roll_id
       LEFT JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN mst_warehouse wh ON wh.id = fr.warehouse_id LEFT JOIN mst_user u ON u.id = a.created_by
      WHERE a.lay_id = ? AND a.company_id = ? ORDER BY a.status = 'RELEASED', a.seq, a.id`, [Number(req.params.id), cid]);
  res.json({ data: rows });
}));

/* ------------------------------------------------------------------ cutting issue / receive (doc §11) */

/** POST /lay-plans/:id/issue { issue_date, from_location?, to_location?, remarks? } — the cutting DC from the reserved rolls */
layEngineRouter.post('/lay-plans/:id/issue', STORE, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({ issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), from_location: s.nullableStr(80),
    to_location: s.nullableStr(80), warehouse_id: s.id(), remarks: s.nullableStr(500) }).parse(req.body ?? {});
  const result = await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [Number(req.params.id), cid]);
    if (!lay) throw NotFound('Lay not found');
    if (lay.status !== 'PLAN_APPROVED') throw BadRequest(`Lay ${lay.lay_no} is ${lay.status} — approve the lay plan (with its reserved rolls) before issuing fabric`);
    const plan = await lockPlan(tx, cid, lay.cutting_plan_id);
    assertPlanOpen(plan, 'issue fabric');
    const allocs = await txQuery<any>(tx, `SELECT * FROM trx_lay_roll_alloc WHERE lay_id = ? AND status = 'RESERVED' ORDER BY seq, id FOR UPDATE`, [lay.id]);
    if (!allocs.length) throw BadRequest(`Lay ${lay.lay_no} has no reserved rolls`);
    const color = plan.color_id ? await txQueryOne<any>(tx, `SELECT color_name FROM mst_color WHERE id = ?`, [plan.color_id]) : null;
    const issueNo = await nextUniqueDocNo(tx, cid, 'FAB_ISSUE', 'trx_fabric_issue', 'issue_no');
    const lines: any[] = [];
    for (const a of allocs) {
      const roll = await txQueryOne<any>(tx, `SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ? FOR UPDATE`, [a.fabric_roll_id, cid]);
      if (!roll) throw NotFound(`Roll ${a.roll_no} not found`);
      if (roll.qc_status !== 'ACCEPTED') throw BadRequest(`Roll ${roll.roll_no} is QC ${roll.qc_status} — it cannot be issued`);
      const others = await txQueryOne<any>(tx, `SELECT ${RESERVED_KG_SQL('?', '?')} AS kg`, [roll.id, lay.id]);
      const free = round(num(roll.weight_kg) - num(roll.issued_kg) - num(others?.kg), 4);
      if (num(a.alloc_kg) > free + KG_EPS) throw BadRequest(`Roll ${roll.roll_no}: reserved ${num(a.alloc_kg)} KG but only ${free} KG is left on the roll — re-allocate the lay`);
      lines.push({ a, roll });
    }
    const totalKg = round(lines.reduce((x, l) => x + num(l.a.alloc_kg), 0), 4);
    const totalM = round(lines.reduce((x, l) => x + num(l.a.alloc_m), 0), 3);
    const warehouseId = body.warehouse_id ?? lines[0].roll.warehouse_id ?? null;
    const ins = await txExecute(tx,
      `INSERT INTO trx_fabric_issue
        (company_id, issue_no, issue_date, io_no, cutting_plan_id, style_id, color_id, fabric_id, warehouse_id, from_location, to_location,
         total_rolls, total_mtr, total_kg, status, remarks, created_by, lay_id, marker_version_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ISSUED',?,?,?,?)`,
      [cid, issueNo, body.issue_date ?? new Date().toISOString().slice(0, 10), plan.io_no, plan.id, plan.style_id, plan.color_id,
       plan.fabric_id ?? lines[0].roll.fabric_id, warehouseId, body.from_location ?? null, body.to_location ?? plan.cutting_location ?? 'CUTTING',
       lines.length, totalM, totalKg, body.remarks ?? `Lay ${lay.lay_no}`, req.user!.id, lay.id, lay.marker_version_id ?? null]);
    const issueId = ins.insertId;
    const uom = await kgUomId(tx);
    for (const { a, roll } of lines) {
      const diaIn = parseFloat(String(roll.dia ?? '').replace(/[^0-9.]/g, ''));
      const fir = await txExecute(tx,
        `INSERT INTO trx_fabric_issue_roll (fabric_issue_id, fabric_roll_id, lot_no, roll_no, shade, color_name, issue_mtr, issue_kg, gsm, width_cm, roll_status, lay_alloc_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN',?)`,
        [issueId, roll.id, roll.lot_no, roll.roll_no, roll.shade, color?.color_name ?? null, a.alloc_m ?? null, a.alloc_kg, roll.gsm,
         Number.isFinite(diaIn) && diaIn > 0 ? round(diaIn * 2.54, 2) : null, a.id]);
      await txExecute(tx, `UPDATE trx_fabric_roll SET issued_kg = issued_kg + ? WHERE id = ?`, [a.alloc_kg, roll.id]);
      await refreshFabricRollStatus(tx, roll.id);
      await txExecute(tx,
        `INSERT INTO trx_stock_ledger (company_id, warehouse_id, material_type, fabric_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, created_by)
         VALUES (?,?,'FABRIC',?,'ISSUE','FAB_DC',?,0,?,?,?)`, [cid, roll.warehouse_id, roll.fabric_id, issueId, a.alloc_kg, uom, req.user!.id]);
      await txExecute(tx, `UPDATE trx_lay_roll_alloc SET status = 'ISSUED', fabric_issue_roll_id = ? WHERE id = ?`, [fir.insertId, a.id]);
      await txExecute(tx,
        `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, from_place, to_place, qty_kg, so_id, remarks, user_id)
         VALUES (?,?,?,'CUT_ISSUE','FAB_DC',?,?,?,?,?,?,?,?)`,
        [cid, roll.id, roll.roll_no, issueId, issueNo, body.from_location ?? 'STORE', body.to_location ?? 'CUTTING', a.alloc_kg, plan.so_id ?? null, `Lay ${lay.lay_no}`, req.user!.id]);
    }
    await txExecute(tx, `UPDATE trx_lay_plan SET status = 'ISSUED', fabric_issue_id = ?, issued_at = NOW(), updated_by = ?, updated_at = NOW() WHERE id = ?`, [issueId, req.user!.id, lay.id]);
    return { lay_id: lay.id, lay_no: lay.lay_no, fabric_issue_id: issueId, issue_no: issueNo, rolls: lines.length, total_kg: totalKg, total_m: totalM };
  });
  await audit(req, 'trx_fabric_issue', result.fabric_issue_id, 'INSERT', undefined, result);
  await audit(req, 'trx_lay_plan', result.lay_id, 'UPDATE', { status: 'PLAN_APPROVED' }, { status: 'ISSUED', issue_no: result.issue_no });
  res.status(201).json({ data: result });
}));

async function receiveDc(tx: Tx, req: any, issueId: number) {
  const cid = req.user!.companyId;
  const dc = await txQueryOne<any>(tx, `SELECT * FROM trx_fabric_issue WHERE id = ? AND company_id = ? FOR UPDATE`, [issueId, cid]);
  if (!dc) throw NotFound('Cutting DC not found');
  if (dc.status === 'RECEIVED') throw BadRequest(`DC ${dc.issue_no} is already received`);
  if (!['ISSUED', 'CONFIRMED'].includes(dc.status)) throw BadRequest(`DC ${dc.issue_no} is ${dc.status}`);
  await txExecute(tx, `UPDATE trx_fabric_issue SET status = 'RECEIVED', received_by = ?, received_at = NOW() WHERE id = ?`, [req.user!.id, dc.id]);
  let layNo: string | null = null;
  if (dc.lay_id) {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? FOR UPDATE`, [dc.lay_id]);
    if (lay && lay.status === 'ISSUED') {
      await txExecute(tx, `UPDATE trx_lay_plan SET status = 'RECEIVED', received_by = ?, received_at = NOW(), updated_by = ?, updated_at = NOW() WHERE id = ?`, [req.user!.id, req.user!.id, lay.id]);
      layNo = lay.lay_no;
    }
  }
  return { fabric_issue_id: dc.id, issue_no: dc.issue_no, lay_id: dc.lay_id ?? null, lay_no: layNo, status: 'RECEIVED' };
}

/** POST /lay-plans/:id/receive — cutting receives the lay's DC (doc §3 Cutting Receive) */
layEngineRouter.post('/lay-plans/:id/receive', EXEC, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const lay = await queryOne<any>(`SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ?`, [Number(req.params.id), cid]);
  if (!lay) throw NotFound('Lay not found');
  if (lay.status !== 'ISSUED' || !lay.fabric_issue_id) throw BadRequest(`Lay ${lay.lay_no} is ${lay.status} — only an issued lay is received`);
  const r = await transaction((tx) => receiveDc(tx, req, Number(lay.fabric_issue_id)));
  await audit(req, 'trx_lay_plan', lay.id, 'UPDATE', { status: 'ISSUED' }, { status: 'RECEIVED', dc: r.issue_no });
  res.json({ data: r });
}));

/** POST /fabric-issues/:id/receive — cutting receives any fabric DC */
layEngineRouter.post('/fabric-issues/:id/receive', EXEC, ah(async (req, res) => {
  const r = await transaction((tx) => receiveDc(tx, req, Number(req.params.id)));
  await audit(req, 'trx_fabric_issue', r.fabric_issue_id, 'UPDATE', { status: 'ISSUED' }, { status: 'RECEIVED' });
  res.json({ data: r });
}));

/* ------------------------------------------------------------------ spreading (doc §13) */

const SPREAD_SELECT = `SELECT sp.*, lp.lay_no, lp.status AS lay_status, lp.ply_count AS lay_ply, lp.planned_kg AS lay_planned_kg, lp.planned_length_m AS lay_planned_m,
       uc.full_name AS completed_by_name, uv.full_name AS verified_by_name
  FROM trx_spreading sp JOIN trx_lay_plan lp ON lp.id = sp.lay_id
  LEFT JOIN mst_user uc ON uc.id = sp.completed_by LEFT JOIN mst_user uv ON uv.id = sp.verified_by`;

layEngineRouter.get('/spreading', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['sp.company_id = ?']; const params: any[] = [cid];
  if (req.query.lay_id) { where.push('sp.lay_id = ?'); params.push(Number(req.query.lay_id)); }
  if (req.query.status) { where.push('sp.status = ?'); params.push(String(req.query.status)); }
  res.json({ data: await query(`${SPREAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY sp.id DESC LIMIT 500`, params) });
}));

layEngineRouter.get('/spreading/:id', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sp = await queryOne<any>(`${SPREAD_SELECT} WHERE sp.id = ? AND sp.company_id = ?`, [Number(req.params.id), cid]);
  if (!sp) throw NotFound('Spreading not found');
  const rolls = await query<any>(
    `SELECT r.*, ROUND(COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg, 4) AS dc_remaining_kg, fir.issue_kg, fir.issue_mtr
       FROM trx_spreading_roll r LEFT JOIN trx_fabric_issue_roll fir ON fir.id = r.fabric_issue_roll_id WHERE r.spreading_id = ? ORDER BY r.id`, [sp.id]);
  res.json({ data: { ...sp, rolls } });
}));

/** POST /spreading { lay_id, operator_name?, table_no?, start_time? } — starts spreading with the issued rolls pre-filled (planned) */
layEngineRouter.post('/spreading', EXEC, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({ lay_id: s.idReq(), spreading_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), operator_name: s.nullableStr(80),
    table_no: s.nullableStr(40), start_time: s.nullableStr(25) }).parse(req.body ?? {});
  const r = await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [body.lay_id, cid]);
    if (!lay) throw NotFound('Lay not found');
    if (lay.status !== 'RECEIVED') throw BadRequest(`Lay ${lay.lay_no} is ${lay.status} — cutting must receive the issued fabric before spreading (doc §14)`);
    const dcRolls = await txQuery<any>(tx,
      `SELECT fir.*, ROUND(COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg, 4) AS remaining_kg FROM trx_fabric_issue_roll fir
        WHERE fir.fabric_issue_id = ? ORDER BY fir.id`, [lay.fabric_issue_id]);
    const no = await nextDocNumber(tx, cid, 'SPREADING');
    const start = body.start_time ? body.start_time.replace('T', ' ').slice(0, 19) : null;
    const ins = await txExecute(tx,
      `INSERT INTO trx_spreading (company_id, spreading_no, spreading_date, lay_id, io_no, style_id, ply_count, operator_name, qc_status, status,
          ply_planned, planned_length_m, planned_kg, start_time, table_no, remarks, created_by)
       VALUES (?,?,?,?,?,?,0,?,'PASS','IN_PROGRESS',?,?,?,COALESCE(?, NOW()),?,?,?)`,
      [cid, no, body.spreading_date ?? new Date().toISOString().slice(0, 10), lay.id, lay.io_no, lay.style_id, body.operator_name ?? lay.operator_name ?? null,
       lay.ply_count, lay.planned_length_m ?? null, lay.planned_kg ?? null, start, body.table_no ?? lay.table_no ?? null, null, req.user!.id]);
    for (const d of dcRolls) {
      await txExecute(tx,
        `INSERT INTO trx_spreading_roll (company_id, spreading_id, lay_id, fabric_roll_id, fabric_issue_roll_id, roll_no, lot_no, shade, planned_m, planned_kg)
         VALUES (?,?,?,?,?,?,?,?,?,?)`, [cid, ins.insertId, lay.id, d.fabric_roll_id, d.id, d.roll_no, d.lot_no, d.shade, d.issue_mtr ?? null, d.remaining_kg]);
    }
    await txExecute(tx, `UPDATE trx_lay_plan SET status = 'SPREADING', started_at = COALESCE(started_at, NOW()), operator_name = COALESCE(?, operator_name), updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [body.operator_name ?? null, req.user!.id, lay.id]);
    return { id: ins.insertId, spreading_no: no, lay_id: lay.id, lay_no: lay.lay_no, rolls: dcRolls.length };
  });
  await audit(req, 'trx_spreading', r.id, 'INSERT', undefined, r);
  res.status(201).json({ data: r });
}));

const completeSchema = z.object({
  actual_ply: z.coerce.number().int().positive(),
  measured_length_m: z.coerce.number().positive().optional(),
  end_time: s.nullableStr(25),
  operator_name: s.nullableStr(80),
  rolls: z.array(z.object({
    id: s.idReq(),
    plies: z.coerce.number().int().min(0).default(0),
    actual_m: z.coerce.number().min(0).optional().nullable(),
    actual_kg: z.coerce.number().min(0),
    end_loss_m: z.coerce.number().min(0).default(0),
    splice_loss_m: z.coerce.number().min(0).default(0),
  })).min(1),
  variance_reason: s.nullableStr(255),
  remarks: s.nullableStr(500),
});

/** PUT /spreading/:id/complete — actual ply / metres / KG / end + splice loss per roll; the lay becomes READY_FOR_CUTTING */
layEngineRouter.put('/spreading/:id/complete', EXEC, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = completeSchema.parse(req.body ?? {});
  const st = await cutSettings(cid);
  const r = await transaction(async (tx) => {
    const sp = await txQueryOne<any>(tx, `SELECT * FROM trx_spreading WHERE id = ? AND company_id = ? FOR UPDATE`, [Number(req.params.id), cid]);
    if (!sp) throw NotFound('Spreading not found');
    if (sp.status !== 'IN_PROGRESS') throw BadRequest(`Spreading ${sp.spreading_no} is ${sp.status}`);
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? FOR UPDATE`, [sp.lay_id]);
    if (lay.status !== 'SPREADING') throw BadRequest(`Lay ${lay.lay_no} is ${lay.status}`);
    const lines = await txQuery<any>(tx,
      `SELECT r.*, ROUND(COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg, 4) AS dc_remaining_kg, fir.issue_kg, fir.issue_mtr
         FROM trx_spreading_roll r LEFT JOIN trx_fabric_issue_roll fir ON fir.id = r.fabric_issue_roll_id WHERE r.spreading_id = ? FOR UPDATE`, [sp.id]);
    let kg = 0; let m = 0; let mKnown = true; let endLoss = 0; let splice = 0; let plies = 0;
    for (const x of body.rolls) {
      const line = lines.find((l) => Number(l.id) === x.id);
      if (!line) throw BadRequest(`Roll line #${x.id} is not on spreading ${sp.spreading_no}`);
      // doc §23: actual consumption beyond the issued quantity needs an authorised adjustment — issue more fabric first
      if (x.actual_kg > num(line.dc_remaining_kg) + KG_EPS) {
        throw BadRequest(`Roll ${line.roll_no}: ${x.actual_kg} KG spread but only ${num(line.dc_remaining_kg)} KG was issued — issue more fabric to the lay first`);
      }
      kg += x.actual_kg; plies += x.plies; endLoss += x.end_loss_m; splice += x.splice_loss_m;
      if (x.actual_m != null) m += x.actual_m; else if (x.actual_kg > 0) mKnown = false;
    }
    if (kg <= KG_EPS) throw BadRequest('Enter the KG spread from the rolls');
    if (plies > 0 && plies !== body.actual_ply) throw BadRequest(`Roll plies add up to ${plies}, not the ${body.actual_ply} actual plies`);
    // doc §23: ply / fabric usage changes need a reason + user + timestamp
    const plyChanged = body.actual_ply !== num(lay.ply_count);
    const plannedKg = num(lay.planned_kg);
    const overFabric = plannedKg > 0 && kg > plannedKg * (1 + st.fabric_variance_pct / 100) + KG_EPS;
    if ((plyChanged || overFabric) && !body.variance_reason) {
      throw BadRequest([plyChanged ? `actual ply ${body.actual_ply} ≠ planned ${num(lay.ply_count)}` : null,
        overFabric ? `fabric ${r3(kg)} KG is over plan ${plannedKg} KG by more than ${st.fabric_variance_pct}%` : null].filter(Boolean).join('; ') + ' — give the variance reason');
    }
    for (const x of body.rolls) {
      await txExecute(tx, `UPDATE trx_spreading_roll SET plies = ?, actual_m = ?, actual_kg = ?, end_loss_m = ?, splice_loss_m = ? WHERE id = ?`,
        [x.plies, x.actual_m ?? null, x.actual_kg, x.end_loss_m, x.splice_loss_m, x.id]);
    }
    const actualM = mKnown ? r3(m) : null;
    const measured = body.measured_length_m ?? (actualM != null ? r3((actualM - endLoss - splice) / body.actual_ply) : null);
    const end = body.end_time ? body.end_time.replace('T', ' ').slice(0, 19) : null;
    await txExecute(tx,
      `UPDATE trx_spreading SET status = 'COMPLETED', ply_count = ?, actual_used_mtr = ?, actual_length_m = ?, actual_kg = ?, end_loss_m = ?, splice_loss_m = ?,
              end_time = COALESCE(?, NOW()), operator_name = COALESCE(?, operator_name), completed_by = ?, completed_at = NOW(), variance_reason = ?, remarks = COALESCE(?, remarks)
        WHERE id = ?`,
      [body.actual_ply, actualM, measured, r3(kg), r3(endLoss), r3(splice), end, body.operator_name ?? null, req.user!.id, body.variance_reason ?? null, body.remarks ?? null, sp.id]);
    const variance = plyChanged || overFabric;
    await txExecute(tx,
      `UPDATE trx_lay_plan SET status = 'READY_FOR_CUTTING', actual_ply = ?, actual_length_m = ?, end_loss_m = ?, splice_loss_m = ?,
              variance_reason = IF(?, ?, variance_reason), variance_by = IF(?, ?, variance_by), variance_at = IF(?, NOW(), variance_at), updated_by = ?, updated_at = NOW()
        WHERE id = ?`,
      [body.actual_ply, measured, r3(endLoss), r3(splice), variance ? 1 : 0, body.variance_reason ?? null, variance ? 1 : 0, req.user!.id, variance ? 1 : 0, req.user!.id, lay.id]);
    return { id: sp.id, spreading_no: sp.spreading_no, lay_id: lay.id, lay_no: lay.lay_no, actual_ply: body.actual_ply, planned_ply: num(lay.ply_count),
      actual_kg: r3(kg), planned_kg: plannedKg || null, actual_m: actualM, planned_m: lay.planned_length_m != null ? num(lay.planned_length_m) : null,
      measured_length_m: measured, end_loss_m: r3(endLoss), splice_loss_m: r3(splice), variance, variance_reason: body.variance_reason ?? null };
  });
  await audit(req, 'trx_spreading', r.id, 'UPDATE', { status: 'IN_PROGRESS' }, { ...r, status: 'COMPLETED', rolls: body.rolls });
  if (r.variance) await audit(req, 'trx_lay_plan', r.lay_id, 'UPDATE', { ply_count: r.planned_ply, planned_kg: r.planned_kg }, { actual_ply: r.actual_ply, actual_kg: r.actual_kg, variance_reason: r.variance_reason });
  res.json({ data: r });
}));

/** POST /spreading/:id/verify — supervisor (doc §21: COMPLETED → VERIFIED) */
layEngineRouter.post('/spreading/:id/verify', SUPERVISE, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sp = await queryOne<any>(`SELECT * FROM trx_spreading WHERE id = ? AND company_id = ?`, [Number(req.params.id), cid]);
  if (!sp) throw NotFound('Spreading not found');
  if (sp.status !== 'COMPLETED') throw BadRequest(`Spreading ${sp.spreading_no} is ${sp.status} — only a completed spreading is verified`);
  await query(`UPDATE trx_spreading SET status = 'VERIFIED', verified_by = ?, verified_at = NOW() WHERE id = ?`, [req.user!.id, sp.id]);
  await audit(req, 'trx_spreading', sp.id, 'UPDATE', { status: 'COMPLETED' }, { status: 'VERIFIED' });
  res.json({ data: { id: sp.id, status: 'VERIFIED' } });
}));

/**
 * GET /lay-plans/:id/execution-prefill — the cut entry filled from the CAD marker and spreading (audio 3: what comes
 * automatically is filled; the user keys only what differs): rolls with before / after KG from the spread actuals,
 * the actual ply, size-wise good PCS = marker ratio × actual ply, end / splice loss converted to KG.
 */
layEngineRouter.get('/lay-plans/:id/execution-prefill', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { lay, plan, mv } = await layWithPlan(null, cid, Number(req.params.id));
  const sp = await queryOne<any>(`SELECT * FROM trx_spreading WHERE lay_id = ? AND status IN ('COMPLETED','VERIFIED') ORDER BY id DESC LIMIT 1`, [lay.id]);
  const spRolls = sp ? await query<any>(`SELECT * FROM trx_spreading_roll WHERE spreading_id = ?`, [sp.id]) : [];
  const dcRolls = lay.fabric_issue_id ? await query<any>(
    `SELECT fir.id AS fabric_issue_roll_id, fir.fabric_roll_id, fir.roll_no, fir.lot_no, fir.roll_status, fir.issue_kg, fir.issue_mtr,
            ROUND(COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg, 4) AS remaining_kg, fi.issue_no
       FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id WHERE fir.fabric_issue_id = ? ORDER BY fir.id`, [lay.fabric_issue_id]) : [];
  const ply = num(lay.actual_ply) || num(sp?.ply_count) || num(lay.ply_count);
  let endKg = 0; let spliceKg = 0;
  const rolls = dcRolls.map((d) => {
    const s0 = spRolls.find((x) => Number(x.fabric_issue_roll_id) === Number(d.fabric_issue_roll_id));
    const used = s0 ? num(s0.actual_kg) : null;
    const kgPerM = num(d.issue_mtr) > 0 ? num(d.issue_kg) / num(d.issue_mtr) : (s0 && num(s0.actual_m) > 0 ? num(s0.actual_kg) / num(s0.actual_m) : null);
    if (s0 && kgPerM) { endKg += num(s0.end_loss_m) * kgPerM; spliceKg += num(s0.splice_loss_m) * kgPerM; }
    return { ...d, before_kg: num(d.remaining_kg), after_kg: used != null ? r3(Math.max(0, num(d.remaining_kg) - used)) : null,
      plies: s0 ? num(s0.plies) : 0, length_used_m: s0?.actual_m != null ? num(s0.actual_m) : null };
  });
  const sizes = await query<any>(`SELECT cps.size_id, sz.size_code FROM trx_cutting_plan_size cps JOIN mst_size sz ON sz.id = cps.size_id WHERE cps.cutting_plan_id = ? ORDER BY sz.sort_order`, [plan.id]);
  const pp = mv ? perPly(toCalcMarker(mv)) : {};
  const outputs = sizes.map((x) => ({ size_id: Number(x.size_id), size_code: x.size_code, good_qty: Math.round((pp[up(x.size_code)] ?? 0) * ply) }));
  const losses = [
    ...(endKg > KG_EPS ? [{ loss_type: 'END_LOSS', qty_kg: r3(endKg), reason: 'Spreading end loss' }] : []),
    ...(spliceKg > KG_EPS ? [{ loss_type: 'OTHER', qty_kg: r3(spliceKg), reason: 'Spreading splice loss' }] : []),
  ];
  res.json({ data: { lay_id: lay.id, lay_no: lay.lay_no, status: lay.status, ply, planned_ply: num(lay.ply_count), spreading: sp ? { id: sp.id, spreading_no: sp.spreading_no, status: sp.status } : null,
    rolls, outputs, losses, operator_name: sp?.operator_name ?? lay.operator_name ?? null, measured_length_m: lay.actual_length_m != null ? num(lay.actual_length_m) : null } });
}));

/* ------------------------------------------------------------------ genealogy / traceability (doc §15) */

async function layGenealogy(cid: number, layId: number) {
  const { lay, plan, mv } = await layWithPlan(null, cid, layId);
  const [allocs, dc, dcRolls, spreads, spRolls, cuttings, outputs, bundles, losses, cad] = await Promise.all([
    query<any>(`SELECT a.*, g.grn_no, fr.lot_no AS roll_lot, fr.so_id AS roll_so_id FROM trx_lay_roll_alloc a JOIN trx_fabric_roll fr ON fr.id = a.fabric_roll_id LEFT JOIN trx_grn g ON g.id = fr.grn_id WHERE a.lay_id = ? ORDER BY a.seq, a.id`, [lay.id]),
    lay.fabric_issue_id ? queryOne<any>(`SELECT fi.*, ur.full_name AS received_by_name FROM trx_fabric_issue fi LEFT JOIN mst_user ur ON ur.id = fi.received_by WHERE fi.id = ?`, [lay.fabric_issue_id]) : null,
    lay.fabric_issue_id ? query<any>(`SELECT fir.*, ROUND(COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg, 4) AS remaining_kg FROM trx_fabric_issue_roll fir WHERE fir.fabric_issue_id = ? ORDER BY fir.id`, [lay.fabric_issue_id]) : [],
    query<any>(`SELECT * FROM trx_spreading WHERE lay_id = ? ORDER BY id`, [lay.id]),
    query<any>(`SELECT * FROM trx_spreading_roll WHERE lay_id = ? ORDER BY id`, [lay.id]),
    query<any>(`SELECT * FROM trx_cutting WHERE lay_id = ? ORDER BY id`, [lay.id]),
    query<any>(`SELECT co.*, sz.size_code FROM trx_cut_output co LEFT JOIN mst_size sz ON sz.id = co.size_id WHERE co.lay_id = ? ORDER BY sz.sort_order, co.id`, [lay.id]),
    query<any>(`SELECT cb.id, cb.bundle_no, cb.barcode, cb.qty, cb.balance_qty, cb.status, cb.size_id, sz.size_code, cb.allocated_kg,
                       (SELECT COUNT(*) FROM trx_bundle_movement bm WHERE bm.bundle_id = cb.id AND COALESCE(bm.txn_type,'') NOT IN ('BUNDLE_CREATE','CUT_VERIFY')) AS floor_moves,
                       (SELECT bm.to_stage FROM trx_bundle_movement bm WHERE bm.bundle_id = cb.id ORDER BY bm.id DESC LIMIT 1) AS last_stage
                  FROM trx_cutting_bundle cb LEFT JOIN mst_size sz ON sz.id = cb.size_id WHERE cb.lay_id = ? ORDER BY cb.id`, [lay.id]),
    query<any>(`SELECT * FROM trx_cutting_loss WHERE lay_id = ? ORDER BY id`, [lay.id]),
    mv?.cad_req_id ? queryOne<any>(`SELECT id, req_no, status, internal_ir_no FROM trx_cad_requirement WHERE id = ?`, [mv.cad_req_id]) : null,
  ]);
  return {
    job: { so_id: plan.so_id, so_no: plan.so_no, io_no: plan.io_no, buyer_name: plan.buyer_name, buyer_po_no: plan.buyer_po_no || plan.so_buyer_po_no },
    cutting_plan: { id: plan.id, plan_no: plan.plan_no, status: plan.status, style_code: plan.style_code, color_name: plan.color_name, fabric_name: plan.fabric_name,
      order_qty: plan.order_qty, planned_cut_qty: plan.planned_cut_qty, actual_cut_qty: plan.actual_cut_qty },
    cad,
    marker: mv ? { id: mv.id, marker_no: mv.marker_no, version: mv.version, status: mv.status, sizes: parseJson(mv.sizes, []), ratios: parseJson(mv.ratios, []),
      pieces_per_marker: mv.pieces_per_marker, length_m: mv.length_m, width_in: mv.width_in, efficiency_pct: mv.efficiency_pct, cad_file_ref: mv.cad_file_ref,
      image_url: mv.marker_image_url ?? (mv.cad_req_id ? (await queryOne<any>(`SELECT image_url FROM trx_cad_marker_file WHERE cad_req_id = ? AND marker_ref = ? AND is_active = 1 AND image_url IS NOT NULL ORDER BY id DESC LIMIT 1`, [mv.cad_req_id, mv.marker_no]).catch(() => null))?.image_url ?? null : null),
      is_locked: !!mv.is_locked, approved_at: mv.approved_at } : null,
    lay: { ...lay, size_output: parseJson(lay.size_output, null) },
    allocations: allocs, fabric_issue: dc ? { ...dc, rolls: dcRolls } : null,
    spreading: spreads.map((x) => ({ ...x, rolls: spRolls.filter((r) => Number(r.spreading_id) === Number(x.id)) })),
    cutting: cuttings, outputs, losses, bundles,
    totals: { bundles: bundles.length, bundle_qty: bundles.reduce((a, b) => a + num(b.qty), 0), in_sewing_or_beyond: bundles.filter((b) => num(b.floor_moves) > 0).length },
  };
}

layEngineRouter.get('/lay-plans/:id/genealogy', VIEW, ah(async (req, res) => {
  res.json({ data: await layGenealogy(req.user!.companyId, Number(req.params.id)) });
}));

/** GET /cutting/:id/traceability — the cutting (trx_cutting) forward to bundles and back to the rolls' yarn lineage */
layEngineRouter.get('/cutting/:id/traceability', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const cut = await queryOne<any>(`SELECT * FROM trx_cutting WHERE id = ? AND company_id = ?`, [Number(req.params.id), cid]);
  if (!cut) throw NotFound('Cutting not found');
  if (!cut.lay_id) throw BadRequest(`Cutting ${cut.cut_no} was not made from a lay — no roll genealogy`);
  const g = await layGenealogy(cid, Number(cut.lay_id));
  const rollIds = [...new Set([...g.allocations.map((a: any) => Number(a.fabric_roll_id)),
    ...(await query<any>(`SELECT DISTINCT fabric_roll_id FROM trx_lay_roll WHERE lay_id = ? AND fabric_roll_id IS NOT NULL`, [cut.lay_id])).map((r) => Number(r.fabric_roll_id))])].slice(0, 25);
  const lineage = [];
  for (const id of rollIds) lineage.push({ fabric_roll_id: id, trace: await rollTrace(cid, id).catch(() => null) });
  const lay_rolls = await query<any>(`SELECT * FROM trx_lay_roll WHERE lay_id = ? ORDER BY id`, [cut.lay_id]);
  res.json({ data: { ...g, cut, lay_rolls, roll_lineage: lineage } });
}));

/* ------------------------------------------------------------------ planned vs actual (doc §22) */

layEngineRouter.get('/cutting-plans/:id/planned-vs-actual', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const plan = await loadPlan(null, cid, Number(req.params.id));
  const cad = await findCad(cid, [plan.io_no, plan.so_no], Number(plan.style_id), plan.cad_req_id ? Number(plan.cad_req_id) : null);
  const lays = await query<any>(
    `SELECT lp.*, mv.marker_no, mv.version AS marker_version, mv.length_m AS cad_length_m, mv.pieces_per_marker, mv.cad_kg_per_pc, mv.efficiency_pct,
            (SELECT COALESCE(SUM(sp.actual_used_mtr),0) FROM trx_spreading sp WHERE sp.lay_id = lp.id AND sp.status IN ('COMPLETED','VERIFIED')) AS spread_m,
            (SELECT COALESCE(SUM(cl.qty_kg),0) FROM trx_cutting_loss cl WHERE cl.lay_id = lp.id AND cl.is_reversed = 0) AS loss_kg,
            (SELECT COALESCE(SUM(co.reject_qty),0) FROM trx_cut_output co WHERE co.lay_id = lp.id AND co.status <> 'REVERSED') AS reject_qty
       FROM trx_lay_plan lp LEFT JOIN trx_marker_version mv ON mv.id = lp.marker_version_id
      WHERE lp.cutting_plan_id = ? AND lp.status <> 'CANCELLED' ORDER BY COALESCE(lp.lay_seq,0), lp.id`, [plan.id]);
  const cadEff = cad ? num(cad.marker_efficiency) : null;
  const rows = lays.map((l) => {
    const cut = ['CUT', 'APPROVED', 'CLOSED'].includes(l.status);
    const plannedPly = num(l.ply_count);
    const actualPly = cut ? (num(l.actual_ply) || plannedPly) : (num(l.actual_ply) || null);
    const eff = l.efficiency_pct != null ? num(l.efficiency_pct) : cadEff;
    const cadPc = num(l.cad_kg_per_pc);
    const netGarmentKg = cadPc > 0 && eff ? cadPc * eff / 100 : null;
    const actualKg = num(l.actual_kg);
    const good = num(l.actual_cut_qty);
    return {
      lay_id: l.id, lay_no: l.lay_no, status: l.status, marker: l.marker_no ? `${l.marker_no} v${l.marker_version}` : l.marker_ref,
      garment_qty: { planned: num(l.expected_pieces), actual: cut ? good : null },
      marker_length_m: { planned: l.cad_length_m != null ? num(l.cad_length_m) : (l.marker_length_m != null ? num(l.marker_length_m) : null), actual: l.actual_length_m != null ? num(l.actual_length_m) : null },
      ply: { planned: plannedPly, actual: actualPly },
      fabric_m: { planned: l.planned_length_m != null ? num(l.planned_length_m) : null, actual: num(l.spread_m) > 0 ? r3(num(l.spread_m)) : null },
      fabric_kg: { planned: l.planned_kg != null ? num(l.planned_kg) : null, actual: cut ? actualKg : null },
      // waste: planned = the marker's non-garment share; actual = fabric used − garment net fabric of the good pieces
      waste_kg: { planned: l.planned_kg != null && eff ? r3(num(l.planned_kg) * (1 - eff / 100)) : null,
        actual: cut && netGarmentKg != null ? r3(actualKg - good * netGarmentKg) : null, recorded_losses: r3(num(l.loss_kg)), reject_pcs: num(l.reject_qty) },
      efficiency_pct: { planned: eff, actual: cut && netGarmentKg != null && actualKg > 0 ? round(good * netGarmentKg / actualKg * 100, 2) : null },
      end_loss_m: l.end_loss_m != null ? num(l.end_loss_m) : null, splice_loss_m: l.splice_loss_m != null ? num(l.splice_loss_m) : null,
      variance_reason: l.variance_reason ?? null,
    };
  });
  const sum = (f: (r: any) => number | null) => { const v = rows.map(f).filter((x) => x != null) as number[]; return v.length ? r3(v.reduce((a, b) => a + b, 0)) : null; };
  res.json({
    data: {
      plan: { id: plan.id, plan_no: plan.plan_no, io_no: plan.io_no, style_code: plan.style_code, color_name: plan.color_name, order_qty: plan.order_qty, actual_cut_qty: plan.actual_cut_qty },
      cad: cad ? { req_no: cad.req_no, marker_efficiency: cadEff } : null,
      lays: rows,
      totals: {
        garment_planned: sum((r) => r.garment_qty.planned), garment_actual: sum((r) => r.garment_qty.actual),
        ply_planned: sum((r) => r.ply.planned), ply_actual: sum((r) => r.ply.actual),
        fabric_m_planned: sum((r) => r.fabric_m.planned), fabric_m_actual: sum((r) => r.fabric_m.actual),
        fabric_kg_planned: sum((r) => r.fabric_kg.planned), fabric_kg_actual: sum((r) => r.fabric_kg.actual),
        waste_kg_planned: sum((r) => r.waste_kg.planned), waste_kg_actual: sum((r) => r.waste_kg.actual),
      },
      notes: 'Waste planned = planned fabric × (1 − CAD efficiency). Actual efficiency = good PCS × garment net fabric (CAD KG/PC × efficiency) ÷ actual fabric used.',
    },
  });
}));

/* ------------------------------------------------------------------ dashboard (doc §25) */

layEngineRouter.get('/cutting-dashboard', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const one = async (sql: string, p: any[] = []) => (await queryOne<any>(sql, [cid, ...p])) ?? {};
  const [plans, cad, lays, bundles, fab, rollsPending, losses, spreadLoss] = await Promise.all([
    one(`SELECT COUNT(*) n, COALESCE(SUM(GREATEST(COALESCE(NULLIF(planned_cut_qty,0), order_qty) - actual_cut_qty, 0)),0) pcs
           FROM trx_cutting_plan WHERE company_id = ? AND status IN ('DRAFT','APPROVED','RELEASED','IN_PROGRESS','PARTIALLY_COMPLETED')`),
    one(`SELECT COUNT(*) n FROM trx_marker_version WHERE company_id = ? AND status IN ('DRAFT','IMPORTED','REVIEW')`),
    query<any>(`SELECT status, COUNT(*) n, COALESCE(SUM(expected_pieces),0) pcs FROM trx_lay_plan WHERE company_id = ? AND status <> 'CANCELLED' GROUP BY status`, [cid]),
    one(`SELECT COUNT(*) n, COALESCE(SUM(COALESCE(balance_qty, qty)),0) pcs FROM trx_cutting_bundle WHERE company_id = ? AND status IN ('GENERATED','CHECKED')`),
    one(`SELECT COALESCE(SUM(planned_kg),0) planned_kg, COALESCE(SUM(actual_kg),0) actual_kg, COUNT(*) n FROM trx_lay_plan WHERE company_id = ? AND status IN ('CUT','APPROVED') AND planned_kg IS NOT NULL`),
    one(`SELECT COUNT(*) n, COALESCE(SUM(fir.issue_kg - fir.consumed_kg - fir.returned_kg),0) kg
           FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
           LEFT JOIN trx_lay_plan lp ON lp.id = fi.lay_id
          WHERE fi.company_id = ? AND fir.roll_status <> 'CLOSED' AND fir.issue_kg - fir.consumed_kg - fir.returned_kg > ${KG_EPS}
            AND (lp.id IS NULL OR lp.status IN ('CUT','APPROVED','CLOSED','CANCELLED'))`),
    query<any>(`SELECT loss_type, COALESCE(SUM(qty_kg),0) kg FROM trx_cutting_loss WHERE company_id = ? AND is_reversed = 0 GROUP BY loss_type`, [cid]),
    one(`SELECT COALESCE(SUM(end_loss_m),0) end_m, COALESCE(SUM(splice_loss_m),0) splice_m FROM trx_spreading WHERE company_id = ? AND status IN ('COMPLETED','VERIFIED')`),
  ]);
  const lay = (st: string[]) => lays.filter((l) => st.includes(l.status)).reduce((a, l) => a + num(l.n), 0);
  const sizeBalance = await query<any>(
    `SELECT cp.id, cp.plan_no, cp.io_no, st.style_code, col.color_name, sz.size_code,
            COALESCE(NULLIF(cps.planned_qty,0), cps.order_qty) AS target, cps.actual_qty AS cut
       FROM trx_cutting_plan cp JOIN trx_cutting_plan_size cps ON cps.cutting_plan_id = cp.id JOIN mst_size sz ON sz.id = cps.size_id
       LEFT JOIN mst_style st ON st.id = cp.style_id LEFT JOIN mst_color col ON col.id = cp.color_id
      WHERE cp.company_id = ? AND cp.status IN ('APPROVED','RELEASED','IN_PROGRESS','PARTIALLY_COMPLETED')
      ORDER BY cp.id DESC, sz.sort_order LIMIT 300`, [cid]);
  const pending = await query<any>(
    `SELECT lp.id, lp.lay_no, lp.status, lp.ply_count, lp.expected_pieces, lp.planned_kg, cp.plan_no, cp.io_no
       FROM trx_lay_plan lp JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
      WHERE lp.company_id = ? AND lp.status IN (${inList(PRE_CUT)}) ORDER BY lp.id DESC LIMIT 50`, [cid]);
  res.json({
    data: {
      tiles: {
        cutting_plans_pending: { count: num(plans.n), pcs: num(plans.pcs) },
        cad_approval_pending: { count: num(cad.n) },
        lay_plans_pending: { count: lay(['GENERATED', 'ROLL_RESERVED', 'PLANNED']) },
        roll_reservation_pending: { count: lay(['GENERATED']) },
        lay_approval_pending: { count: lay(['ROLL_RESERVED']) },
        fabric_issue_pending: { count: lay(['PLAN_APPROVED']) },
        cutting_receive_pending: { count: lay(['ISSUED']) },
        spreading_in_progress: { count: lay(['RECEIVED', 'SPREADING', 'SPREAD']) },
        cutting_in_progress: { count: lay(['READY_FOR_CUTTING']) },
        bundles_ready_for_sewing: { count: num(bundles.n), pcs: num(bundles.pcs) },
        fabric_planned_vs_actual: { lays: num(fab.n), planned_kg: r3(num(fab.planned_kg)), actual_kg: r3(num(fab.actual_kg)),
          variance_pct: num(fab.planned_kg) > 0 ? round((num(fab.actual_kg) - num(fab.planned_kg)) / num(fab.planned_kg) * 100, 2) : null },
        roll_balance_pending_return: { rolls: num(rollsPending.n), kg: r3(num(rollsPending.kg)) },
        waste: { by_type: losses.map((l) => ({ loss_type: l.loss_type, kg: r3(num(l.kg)) })), end_loss_m: r3(num(spreadLoss.end_m)), splice_loss_m: r3(num(spreadLoss.splice_m)) },
      },
      lay_status: lays.map((l) => ({ status: l.status, count: num(l.n), pcs: num(l.pcs) })),
      size_balance: sizeBalance.map((x) => ({ ...x, target: num(x.target), cut: num(x.cut), balance: num(x.target) - num(x.cut) })).filter((x) => x.balance !== 0),
      pending_lays: pending,
    },
  });
}));

/* ------------------------------------------------------------------ cutting tables */

const tableSchema = z.object({
  table_code: s.strReq(30), table_name: s.nullableStr(80), length_m: z.coerce.number().positive().optional().nullable(),
  width_in: z.coerce.number().positive().optional().nullable(), max_ply: z.coerce.number().int().positive().max(1000),
  min_ply: z.coerce.number().int().positive().max(1000).default(1), is_active: z.coerce.boolean().default(true),
});
layEngineRouter.get('/cutting-tables', VIEW, ah(async (req, res) => {
  res.json({ data: await query(`SELECT * FROM mst_cutting_table WHERE company_id = ? ORDER BY is_active DESC, table_code`, [req.user!.companyId]) });
}));
layEngineRouter.post('/cutting-tables', PLAN, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = tableSchema.parse(req.body ?? {});
  if (b.min_ply > b.max_ply) throw BadRequest('Min ply cannot be more than max ply');
  const dup = await queryOne(`SELECT id FROM mst_cutting_table WHERE company_id = ? AND table_code = ?`, [cid, b.table_code]);
  if (dup) throw BadRequest(`Table ${b.table_code} already exists`);
  const r: any = await query(`INSERT INTO mst_cutting_table (company_id, table_code, table_name, length_m, width_in, max_ply, min_ply, is_active, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [cid, b.table_code, b.table_name ?? null, b.length_m ?? null, b.width_in ?? null, b.max_ply, b.min_ply, b.is_active ? 1 : 0, req.user!.id]);
  const row = await queryOne(`SELECT * FROM mst_cutting_table WHERE company_id = ? AND table_code = ?`, [cid, b.table_code]);
  await audit(req, 'mst_cutting_table', (row as any)?.id ?? r?.insertId ?? 0, 'INSERT', undefined, row);
  res.status(201).json({ data: row });
}));
layEngineRouter.put('/cutting-tables/:id', PLAN, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = tableSchema.parse(req.body ?? {});
  if (b.min_ply > b.max_ply) throw BadRequest('Min ply cannot be more than max ply');
  const before = await queryOne<any>(`SELECT * FROM mst_cutting_table WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!before) throw NotFound('Cutting table not found');
  const dup = await queryOne(`SELECT id FROM mst_cutting_table WHERE company_id = ? AND table_code = ? AND id <> ?`, [cid, b.table_code, id]);
  if (dup) throw BadRequest(`Table ${b.table_code} already exists`);
  await query(`UPDATE mst_cutting_table SET table_code = ?, table_name = ?, length_m = ?, width_in = ?, max_ply = ?, min_ply = ?, is_active = ? WHERE id = ?`,
    [b.table_code, b.table_name ?? null, b.length_m ?? null, b.width_in ?? null, b.max_ply, b.min_ply, b.is_active ? 1 : 0, id]);
  const row = await queryOne(`SELECT * FROM mst_cutting_table WHERE id = ?`, [id]);
  await audit(req, 'mst_cutting_table', id, 'UPDATE', before, row);
  res.json({ data: row });
}));
