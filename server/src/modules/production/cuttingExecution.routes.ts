/**
 * Cutting execution (doc §7–§13):
 *   • Marker versions — immutable snapshots of CAD markers used by lays
 *   • Size-specific consumption master (source + version + effective date)
 *   • Lay execution — roll-wise before/after KG, losses, size-wise cut output
 *   • Lay approval and reversal (never a hard delete)
 *   • Bundle generation from cut output with allocated fabric KG
 */
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';
import {
  KG_EPS, assertPlanCuttable, assertPlanOpen, checkOverCut, generateBundlesFromOutput, hasPerm, lockPlan,
  markerSizeKg, nextUniqueDocNo, num, parseJson, refreshDcRollStatus, refreshPlanStatus, resolveKgPerPc, round,
} from './cuttingEngine.js';

export const cuttingExecutionRouter = Router();

const LOSS_TYPES = ['CUTTING_WASTE', 'END_LOSS', 'SELVEDGE_LOSS', 'REMNANT', 'OTHER'] as const;

/* ================================================================
   MARKER VERSIONS — doc §7
================================================================ */

interface MarkerContent {
  marker_no: string; marker_name: string | null; style_id: number | null; color_id: number | null;
  fabric_id: number | null; fabric_type: string | null; gsm: number | null; width_in: number | null;
  length_m: number | null; sizes: string[]; ratios: number[]; pieces_per_marker: number;
  marker_kg_per_ply: number | null; cad_kg_per_pc: number | null; size_consumption: Record<string, number> | null;
  uom: string; cad_file_ref: string | null;
}

function contentHash(c: MarkerContent): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}

function hydrateMv(mv: any) {
  if (!mv) return mv;
  return {
    ...mv,
    sizes: parseJson(mv.sizes, []), ratios: parseJson(mv.ratios, []),
    size_consumption: parseJson(mv.size_consumption, null),
    ratio_text: (parseJson<string[]>(mv.sizes, [])).map((sz, i) => `${sz}${(parseJson<number[]>(mv.ratios, []))[i] ?? 0}`).join(' '),
  };
}

/** Insert a new version when content changed; otherwise return the latest one. */
async function saveMarkerVersion(tx: any, cid: number, userId: number, cadReqId: number | null,
  content: MarkerContent, source: 'CAD' | 'MANUAL') {
  const hash = contentHash(content);
  const latest = await txQueryOne<any>(tx,
    `SELECT * FROM trx_marker_version WHERE company_id = ? AND cad_req_id <=> ? AND marker_no = ?
      ORDER BY version DESC LIMIT 1 FOR UPDATE`, [cid, cadReqId, content.marker_no]);
  if (latest && latest.content_hash === hash) return { created: false, id: latest.id as number };
  const version = latest ? Number(latest.version) + 1 : 1;
  const r = await txExecute(tx,
    `INSERT INTO trx_marker_version
       (company_id, cad_req_id, marker_no, version, marker_name, style_id, color_id, fabric_id, fabric_type, gsm,
        width_in, length_m, sizes, ratios, pieces_per_marker, marker_kg_per_ply, cad_kg_per_pc, size_consumption,
        uom, content_hash, source, cad_file_ref, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, cadReqId, content.marker_no, version, content.marker_name, content.style_id, content.color_id,
     content.fabric_id, content.fabric_type, content.gsm, content.width_in, content.length_m,
     JSON.stringify(content.sizes), JSON.stringify(content.ratios), content.pieces_per_marker,
     content.marker_kg_per_ply, content.cad_kg_per_pc,
     content.size_consumption ? JSON.stringify(content.size_consumption) : null,
     content.uom, hash, source, content.cad_file_ref, userId]);
  return { created: true, id: r.insertId as number };
}

const MV_SELECT = `SELECT mv.*, st.style_code, col.color_name, fb.fabric_name, cr.req_no AS cad_req_no,
       (SELECT COUNT(*) FROM trx_lay_plan lp WHERE lp.marker_version_id = mv.id AND lp.status <> 'CANCELLED') AS lay_count
  FROM trx_marker_version mv
  LEFT JOIN mst_style st ON st.id = mv.style_id
  LEFT JOIN mst_color col ON col.id = mv.color_id
  LEFT JOIN mst_fabric fb ON fb.id = mv.fabric_id
  LEFT JOIN trx_cad_requirement cr ON cr.id = mv.cad_req_id`;

/** GET /marker-versions?style_id=&cad_req_id=&cutting_plan_id=&marker_no= */
cuttingExecutionRouter.get('/marker-versions', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['mv.company_id = ?'];
  const params: any[] = [cid];
  if (req.query.cutting_plan_id) {
    const plan = await queryOne<any>(`SELECT style_id, fabric_id FROM trx_cutting_plan WHERE id = ? AND company_id = ?`,
      [Number(req.query.cutting_plan_id), cid]);
    if (!plan) throw NotFound('Cut order not found');
    where.push('(mv.style_id = ? OR mv.style_id IS NULL)'); params.push(plan.style_id);
    if (plan.fabric_id) { where.push('(mv.fabric_id = ? OR mv.fabric_id IS NULL)'); params.push(plan.fabric_id); }
  }
  if (req.query.style_id) { where.push('mv.style_id = ?'); params.push(Number(req.query.style_id)); }
  if (req.query.cad_req_id) { where.push('mv.cad_req_id = ?'); params.push(Number(req.query.cad_req_id)); }
  if (req.query.marker_no) { where.push('mv.marker_no = ?'); params.push(String(req.query.marker_no)); }
  const rows = await query(`${MV_SELECT} WHERE ${where.join(' AND ')} ORDER BY mv.marker_no, mv.version DESC`, params);
  res.json({ data: rows.map(hydrateMv) });
}));

cuttingExecutionRouter.get('/marker-versions/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const row = await queryOne(`${MV_SELECT} WHERE mv.id = ? AND mv.company_id = ?`, [Number(req.params.id), req.user!.companyId]);
  if (!row) throw NotFound('Marker version not found');
  res.json({ data: hydrateMv(row) });
}));

/**
 * POST /marker-versions/snapshot { cad_req_id, marker_ref, fabric_id?, color_id? }
 * Snapshots a CAD marker's values (CAD markers are deleted/re-inserted on
 * every CAD save, so ids are never referenced). A new version is created only
 * when the content changed.
 */
cuttingExecutionRouter.post('/marker-versions/snapshot', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    cad_req_id: s.idReq(),
    marker_ref: s.strReq(50),
    fabric_id: s.id(),
    color_id: s.id(),
  }).parse(req.body);

  const cr = await queryOne<any>(`SELECT * FROM trx_cad_requirement WHERE id = ? AND company_id = ?`, [body.cad_req_id, cid]);
  if (!cr) throw NotFound('CAD requirement not found');
  if (cr.status === 'OBSOLETE') throw BadRequest(`CAD requirement ${cr.req_no} is OBSOLETE`);
  const cm = await queryOne<any>(
    `SELECT * FROM trx_cad_marker WHERE cad_req_id = ? AND marker_ref = ? ORDER BY sort_order, id LIMIT 1`,
    [cr.id, body.marker_ref]);
  if (!cm) throw NotFound(`Marker ${body.marker_ref} not found on CAD ${cr.req_no}`);

  const mj = parseJson<any>(cm.data_json, {});
  const sizes: string[] = Array.isArray(mj.sizes) ? mj.sizes.map((x: any) => String(x?.size_code ?? x?.code ?? x)) : [];
  const ratios: number[] = Array.isArray(mj.ratios) ? mj.ratios.map((x: any) => Number(x) || 0) : [];
  if (!sizes.length || sizes.length !== ratios.length) throw BadRequest(`Marker ${cm.marker_ref} has no size ratio (ratio patti) — complete it in CAD first`);
  const sumRatio = ratios.reduce((a, b) => a + b, 0);
  const ppm = Math.max(1, Number(cm.no_of_pcs_lay) || sumRatio);
  const layers = sumRatio > 0 ? ppm / sumRatio : 1;
  const uom = cm.uom === 'MTR' ? 'MTR' : 'KG';
  const lengthM = num(cm.lay_length_cm) > 0 ? round(num(cm.lay_length_cm) / 100, 3) : (num(cm.length_mm) > 0 ? round(num(cm.length_mm) / 1000, 3) : null);
  const perPly = uom === 'KG'
    ? (num(cm.fabric_wt_per_lay_g) > 0 ? round(num(cm.fabric_wt_per_lay_g) / 1000, 5) : null)
    : lengthM;
  const perPc = uom === 'KG'
    ? (num(cm.act_wt_per_pc_g) > 0 ? round(num(cm.act_wt_per_pc_g) / 1000, 5) : (perPly ? round(perPly / ppm, 5) : null))
    : (num(cm.req_length_per_pc_cm) > 0 ? round(num(cm.req_length_per_pc_cm) / 100, 5) : null);

  // Per-size consumption, derivable when the CAD pieces carry size-wise areas:
  // one ply's KG split across the sizes in proportion to their piece area.
  let sizeConsumption: Record<string, number> | null = null;
  if (uom === 'KG' && perPly) {
    const areas = await query<any>(
      `SELECT UPPER(TRIM(size_name)) AS sz, SUM(area_sqm * piece_qty) AS area
         FROM trx_cad_piece WHERE cad_req_id = ? AND material_type = 'FABRIC' AND size_name IS NOT NULL
          AND (marker_no IS NULL OR marker_no = '' OR marker_no = ?)
        GROUP BY UPPER(TRIM(size_name))`, [cr.id, cm.marker_ref]);
    const areaBy = new Map(areas.map((a) => [a.sz, num(a.area)]));
    if (sizes.every((sz) => (areaBy.get(sz.trim().toUpperCase()) ?? 0) > 0)) {
      const denom = sizes.reduce((a, sz, i) => a + ratios[i] * layers * (areaBy.get(sz.trim().toUpperCase()) ?? 0), 0);
      if (denom > 0) {
        sizeConsumption = {};
        for (const sz of sizes) sizeConsumption[sz] = round(perPly * (areaBy.get(sz.trim().toUpperCase()) ?? 0) / denom, 5);
      }
    }
  }

  const content: MarkerContent = {
    marker_no: cm.marker_ref, marker_name: cm.marker_name ?? null, style_id: Number(cr.style_id),
    color_id: body.color_id ?? null, fabric_id: body.fabric_id ?? null, fabric_type: cm.fabric_type ?? null,
    gsm: cm.gsm != null ? num(cm.gsm) : null,
    width_in: num(cm.table_width_in) > 0 ? num(cm.table_width_in) : (num(cm.width_mm) > 0 ? round(num(cm.width_mm) / 25.4, 2) : null),
    length_m: lengthM, sizes, ratios, pieces_per_marker: ppm, marker_kg_per_ply: perPly, cad_kg_per_pc: perPc,
    size_consumption: sizeConsumption, uom, cad_file_ref: cr.marker_file_name || cr.cad_file_name || null,
  };
  const saved = await transaction((tx) => saveMarkerVersion(tx, cid, req.user!.id, cr.id, content, 'CAD'));
  const row = await queryOne(`${MV_SELECT} WHERE mv.id = ?`, [saved.id]);
  if (saved.created) await audit(req, 'trx_marker_version', saved.id, 'INSERT', undefined, row);
  res.status(saved.created ? 201 : 200).json({ data: hydrateMv(row), created: saved.created });
}));

/** POST /marker-versions — manual marker (Marker Master, no CAD) */
cuttingExecutionRouter.post('/marker-versions', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    marker_no: s.strReq(60),
    marker_name: s.nullableStr(120),
    style_id: s.idReq(),
    color_id: s.id(),
    fabric_id: s.id(),
    fabric_type: s.nullableStr(80),
    gsm: z.coerce.number().positive().optional(),
    width_in: z.coerce.number().positive().optional(),
    length_m: z.coerce.number().positive().optional(),
    sizes: z.array(z.string().trim().min(1).max(20)).min(1),
    ratios: z.array(z.coerce.number().int().min(0)).min(1),
    pieces_per_marker: z.coerce.number().int().positive().optional(),
    marker_kg_per_ply: z.coerce.number().positive().optional(),
    cad_kg_per_pc: z.coerce.number().positive().optional(),
    size_consumption: z.record(z.string(), z.coerce.number().positive()).optional(),
    uom: z.enum(['KG', 'MTR']).default('KG'),
    cad_file_ref: s.nullableStr(255),
  }).parse(req.body);
  if (body.sizes.length !== body.ratios.length) throw BadRequest('Every size needs a ratio');
  if (new Set(body.sizes.map((x) => x.toUpperCase())).size !== body.sizes.length) throw BadRequest('A size appears twice in the ratio');
  const style = await queryOne(`SELECT id FROM mst_style WHERE id = ? AND company_id = ?`, [body.style_id, cid]);
  if (!style) throw NotFound('Style not found');
  const sumRatio = body.ratios.reduce((a, b) => a + b, 0);
  const ppm = body.pieces_per_marker ?? sumRatio;
  if (ppm <= 0) throw BadRequest('Pieces per marker must be greater than 0');
  const perPly = body.marker_kg_per_ply ?? null;
  const content: MarkerContent = {
    marker_no: body.marker_no, marker_name: body.marker_name ?? null, style_id: body.style_id,
    color_id: body.color_id ?? null, fabric_id: body.fabric_id ?? null, fabric_type: body.fabric_type ?? null,
    gsm: body.gsm ?? null, width_in: body.width_in ?? null, length_m: body.length_m ?? null,
    sizes: body.sizes, ratios: body.ratios, pieces_per_marker: ppm, marker_kg_per_ply: perPly,
    cad_kg_per_pc: body.cad_kg_per_pc ?? (perPly ? round(perPly / ppm, 5) : null),
    size_consumption: body.size_consumption ?? null, uom: body.uom, cad_file_ref: body.cad_file_ref ?? null,
  };
  const saved = await transaction((tx) => saveMarkerVersion(tx, cid, req.user!.id, null, content, 'MANUAL'));
  const row = await queryOne(`${MV_SELECT} WHERE mv.id = ?`, [saved.id]);
  if (saved.created) await audit(req, 'trx_marker_version', saved.id, 'INSERT', undefined, row);
  res.status(saved.created ? 201 : 200).json({ data: hydrateMv(row), created: saved.created });
}));

/** POST /marker-versions/:id/approve */
cuttingExecutionRouter.post('/marker-versions/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const mv = await txQueryOne<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!mv) throw NotFound('Marker version not found');
    if (mv.is_locked) throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is locked (used by an executed lay) and immutable`);
    if (mv.approved_at) throw BadRequest('Marker version is already approved');
    await txExecute(tx, `UPDATE trx_marker_version SET approved_by = ?, approved_at = NOW() WHERE id = ?`, [req.user!.id, id]);
  });
  await audit(req, 'trx_marker_version', id, 'UPDATE', undefined, { approved_by: req.user!.id });
  res.json({ data: hydrateMv(await queryOne(`${MV_SELECT} WHERE mv.id = ?`, [id])) });
}));

/* ================================================================
   SIZE-SPECIFIC CONSUMPTION — doc §13 (source + version + effective date)
================================================================ */

cuttingExecutionRouter.get('/size-consumptions', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['sc.company_id = ?'];
  const params: any[] = [cid];
  if (req.query.style_id) { where.push('sc.style_id = ?'); params.push(Number(req.query.style_id)); }
  if (req.query.active === '1') where.push('sc.is_active = 1');
  const rows = await query(
    `SELECT sc.*, st.style_code, sz.size_code, col.color_name, fb.fabric_name, 'KG/PC' AS uom
       FROM trx_size_consumption sc
       LEFT JOIN mst_style st ON st.id = sc.style_id
       LEFT JOIN mst_size sz ON sz.id = sc.size_id
       LEFT JOIN mst_color col ON col.id = sc.color_id
       LEFT JOIN mst_fabric fb ON fb.id = sc.fabric_id
      WHERE ${where.join(' AND ')}
      ORDER BY st.style_code, sz.sort_order, sc.source, sc.version DESC`, params);
  res.json({ data: rows });
}));

cuttingExecutionRouter.post('/size-consumptions', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    style_id: s.idReq(),
    color_id: s.id(),
    fabric_id: s.id(),
    size_id: s.idReq(),
    kg_per_pc: z.coerce.number().positive().max(10),
    source: z.enum(['COSTING', 'MARKER', 'ACTUAL', 'APPROVED']),
    source_ref: s.nullableStr(120),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).parse(req.body);
  if (body.source === 'APPROVED' && !hasPerm(req, 'PRODUCTION.APPROVE')) throw Forbidden('Only PRODUCTION.APPROVE can record APPROVED consumption');
  const style = await queryOne(`SELECT id FROM mst_style WHERE id = ? AND company_id = ?`, [body.style_id, cid]);
  if (!style) throw NotFound('Style not found');
  const id = await transaction(async (tx) => {
    const prev = await txQueryOne<any>(tx,
      `SELECT COALESCE(MAX(version),0) AS v FROM trx_size_consumption
        WHERE company_id = ? AND style_id = ? AND size_id = ? AND source = ? AND color_id <=> ? AND fabric_id <=> ? FOR UPDATE`,
      [cid, body.style_id, body.size_id, body.source, body.color_id ?? null, body.fabric_id ?? null]);
    // Older versions stay for history (doc §19) but stop being picked.
    await txExecute(tx,
      `UPDATE trx_size_consumption SET is_active = 0
        WHERE company_id = ? AND style_id = ? AND size_id = ? AND source = ? AND color_id <=> ? AND fabric_id <=> ?
          AND effective_from <= ?`,
      [cid, body.style_id, body.size_id, body.source, body.color_id ?? null, body.fabric_id ?? null, body.effective_from]);
    const r = await txExecute(tx,
      `INSERT INTO trx_size_consumption
         (company_id, style_id, color_id, fabric_id, size_id, kg_per_pc, source, source_ref, version, effective_from, is_active, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
      [cid, body.style_id, body.color_id ?? null, body.fabric_id ?? null, body.size_id, body.kg_per_pc, body.source,
       body.source_ref ?? null, num(prev?.v) + 1, body.effective_from, req.user!.id]);
    return r.insertId;
  });
  await audit(req, 'trx_size_consumption', id, 'INSERT', undefined, body);
  res.status(201).json({ data: await queryOne(`SELECT * FROM trx_size_consumption WHERE id = ?`, [id]) });
}));

cuttingExecutionRouter.post('/size-consumptions/:id/deactivate', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne<any>(`SELECT * FROM trx_size_consumption WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Size consumption not found');
  await query(`UPDATE trx_size_consumption SET is_active = 0 WHERE id = ?`, [id]);
  await audit(req, 'trx_size_consumption', id, 'UPDATE', { is_active: row.is_active }, { is_active: 0 });
  res.json({ data: { id, is_active: 0 } });
}));

/* ================================================================
   LAY EXECUTION — doc §9, §10
================================================================ */

const executeSchema = z.object({
  operator_name: s.nullableStr(80),
  table_no: s.nullableStr(40),
  /** Actual plies laid; defaults to the planned ply count. */
  ply_count: z.coerce.number().int().positive().optional(),
  lay_length_m: z.coerce.number().positive().optional(),
  rolls: z.array(z.object({
    fabric_issue_roll_id: s.idReq(),
    before_kg: z.coerce.number().min(0),
    after_kg: z.coerce.number().min(0),
    plies: z.coerce.number().int().min(0).default(0),
    length_used_m: z.coerce.number().min(0).optional(),
    /** Operator marks the roll finished on this DC (any balance is remnant/loss). */
    close_roll: z.coerce.boolean().default(false),
  })).min(1, 'Record at least one roll used in the lay'),
  losses: z.array(z.object({
    loss_type: z.enum(LOSS_TYPES),
    qty_kg: z.coerce.number().positive(),
    reason: s.nullableStr(255),
  })).default([]),
  outputs: z.array(z.object({
    size_id: s.idReq(),
    good_qty: z.coerce.number().int().min(0),
    reject_qty: z.coerce.number().int().min(0).default(0),
    recut_qty: z.coerce.number().int().min(0).default(0),
  })).min(1, 'Record the size-wise cut output'),
  override_reason: s.nullableStr(255),
});

/** POST /lay-plans/:id/execute — record actual consumption + cut output in one transaction */
cuttingExecutionRouter.post('/lay-plans/:id/execute', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const layId = Number(req.params.id);
  const body = executeSchema.parse(req.body);

  const rollIds = body.rolls.map((r) => r.fabric_issue_roll_id);
  if (new Set(rollIds).size !== rollIds.length) throw BadRequest('The same DC roll is listed twice in this lay');
  const sizeIds = body.outputs.map((o) => o.size_id);
  if (new Set(sizeIds).size !== sizeIds.length) throw BadRequest('Each size may appear only once in the cut output');
  for (const r of body.rolls) {
    if (r.after_kg > r.before_kg + KG_EPS) {
      throw BadRequest(`Remaining roll weight (${r.after_kg} KG) cannot exceed the weight before lay (${r.before_kg} KG) — consumption cannot be negative`);
    }
  }
  const goodTotal = body.outputs.reduce((a, o) => a + o.good_qty, 0);
  if (goodTotal <= 0) throw BadRequest('Good cut PCS must be greater than 0');

  const result = await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [layId, cid]);
    if (!lay) throw NotFound('Lay not found');
    if (!['PLANNED', 'SPREAD'].includes(lay.status)) throw BadRequest(`Lay ${lay.lay_no} is already ${lay.status}`);
    if (!lay.cutting_plan_id) throw BadRequest('Lay is not linked to a cut order');
    const plan = await lockPlan(tx, cid, lay.cutting_plan_id);
    assertPlanCuttable(plan);

    const mv = lay.marker_version_id
      ? await txQueryOne<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ? FOR UPDATE`, [lay.marker_version_id])
      : null;
    const ply = body.ply_count ?? num(lay.ply_count);
    const expected = mv ? num(mv.pieces_per_marker) * ply : num(lay.expected_pieces);

    // Sizes must belong to the cut order's size breakdown (when it has one).
    const planSizes = await txQuery<any>(tx,
      `SELECT cps.size_id, sz.size_code, sz.size_label FROM trx_cutting_plan_size cps
         LEFT JOIN mst_size sz ON sz.id = cps.size_id WHERE cps.cutting_plan_id = ?`, [plan.id]);
    const sizeInfo = new Map<number, any>(planSizes.map((p) => [Number(p.size_id), p]));
    for (const o of body.outputs) {
      if (planSizes.length && !sizeInfo.has(o.size_id)) throw BadRequest(`Size #${o.size_id} is not in cut order ${plan.plan_no}`);
      if (!sizeInfo.has(o.size_id)) {
        const sz = await txQueryOne<any>(tx, `SELECT id AS size_id, size_code, size_label FROM mst_size WHERE id = ?`, [o.size_id]);
        if (!sz) throw NotFound(`Size #${o.size_id} not found`);
        sizeInfo.set(o.size_id, sz);
      }
    }

    // Roll-wise consumption, locked against the DC roll balance.
    const rollRows: any[] = [];
    for (const r of body.rolls) {
      const line = await txQueryOne<any>(tx,
        `SELECT fir.*, fi.issue_no FROM trx_fabric_issue_roll fir
           JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
          WHERE fir.id = ? AND fi.company_id = ? AND fi.cutting_plan_id = ? FOR UPDATE`,
        [r.fabric_issue_roll_id, cid, plan.id]);
      if (!line) throw BadRequest(`DC roll #${r.fabric_issue_roll_id} was not issued to cut order ${plan.plan_no}`);
      if (line.roll_status === 'CLOSED') throw BadRequest(`Roll ${line.roll_no} is CLOSED (fully consumed/closed) and cannot be used`);
      const remaining = round(num(line.issue_kg) - num(line.consumed_kg) - num(line.returned_kg), 4);
      if (r.before_kg > remaining + KG_EPS) {
        throw BadRequest(`Roll ${line.roll_no}: weight before lay ${r.before_kg} KG exceeds the ${remaining} KG remaining on DC ${line.issue_no}`);
      }
      const consumed = round(r.before_kg - r.after_kg, 4);
      if (consumed < 0) throw BadRequest(`Roll ${line.roll_no}: consumption cannot be negative`);
      rollRows.push({ ...r, line, consumed });
    }
    const actualKg = round(rollRows.reduce((a, r) => a + r.consumed, 0), 4);
    if (actualKg <= 0) throw BadRequest('Lay actual consumption must be greater than 0 KG');

    // Authorised overrides (doc §20: cut qty beyond plan-supported qty).
    let overrideUsed = false;
    if (expected > 0 && goodTotal > expected) {
      const msg = `Good cut ${goodTotal} PCS exceeds the lay's expected ${expected} PCS (marker pieces × ply)`;
      if (!hasPerm(req, 'PRODUCTION.APPROVE')) throw Forbidden(`${msg}. Only PRODUCTION.APPROVE can authorise it.`);
      if (!body.override_reason) throw BadRequest(`${msg}. Give an override reason to authorise it.`);
      overrideUsed = true;
    }
    overrideUsed = checkOverCut(req, plan, num(plan.actual_cut_qty) + goodTotal, 'Cut order actual cut qty', body.override_reason) || overrideUsed;


    // Split lay KG over the size outputs: by marker size consumption when the
    // marker has it for every size, otherwise uniformly by good PCS.
    const weights = body.outputs.map((o) => {
      const sz = sizeInfo.get(o.size_id);
      return markerSizeKg(mv, sz?.size_code, sz?.size_label);
    });
    const bySize = mv && weights.every((w) => w != null && w > 0);
    const w = body.outputs.map((o, i) => o.good_qty * (bySize ? (weights[i] as number) : 1));
    const wSum = w.reduce((a, b) => a + b, 0);
    const outKg = w.map((x) => (wSum > 0 ? round(actualKg * x / wSum, 5) : 0));
    const drift = round(actualKg - outKg.reduce((a, b) => a + b, 0), 5);
    const lastIdx = outKg.map((k, i) => (k > 0 ? i : -1)).filter((i) => i >= 0).pop();
    if (lastIdx !== undefined) outKg[lastIdx] = round(outKg[lastIdx] + drift, 5);

    // Cutting header — bundles keep their cutting_id FK.
    const cutNo = await nextUniqueDocNo(tx, cid, 'CUTTING', 'trx_cutting', 'cut_no');
    const cut = await txExecute(tx,
      `INSERT INTO trx_cutting
         (company_id, cut_no, io_no, cut_date, prod_order_id, cutting_plan_id, lay_id, fabric_id, lay_length_m,
          ply_count, marker_ref, fabric_used_kg, total_pieces, rework_qty, created_by)
       VALUES (?,?,?,CURDATE(),?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, cutNo, plan.io_no, plan.prod_order_id ?? null, plan.id, lay.id, plan.fabric_id ?? lay.fabric_id ?? null,
       body.lay_length_m ?? lay.marker_length_m ?? null, ply, lay.marker_ref ?? null, actualKg, goodTotal,
       body.outputs.reduce((a, o) => a + o.recut_qty, 0), req.user!.id]);
    const cuttingId = cut.insertId;

    for (const r of rollRows) {
      await txExecute(tx,
        `INSERT INTO trx_lay_roll
           (company_id, lay_id, fabric_issue_roll_id, fabric_roll_id, roll_no, lot_no, plies, before_kg, after_kg,
            actual_consumed_kg, length_used_m, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, lay.id, r.line.id, r.line.fabric_roll_id ?? null, r.line.roll_no, r.line.lot_no, r.plies,
         r.before_kg, r.after_kg, r.consumed, r.length_used_m ?? null, req.user!.id]);
      await txExecute(tx, `UPDATE trx_fabric_issue_roll SET consumed_kg = consumed_kg + ? WHERE id = ?`, [r.consumed, r.line.id]);
      await refreshDcRollStatus(tx, r.line.id, { forceClose: r.close_roll });
    }
    for (const l of body.losses) {
      await txExecute(tx,
        `INSERT INTO trx_cutting_loss (company_id, cutting_plan_id, lay_id, loss_type, qty_kg, reason, created_by)
         VALUES (?,?,?,?,?,?,?)`, [cid, plan.id, lay.id, l.loss_type, l.qty_kg, l.reason ?? null, req.user!.id]);
    }
    const outputs: any[] = [];
    for (let i = 0; i < body.outputs.length; i++) {
      const o = body.outputs[i];
      const outputNo = await nextUniqueDocNo(tx, cid, 'CUT_OUTPUT', 'trx_cut_output', 'output_no');
      const kgPc = o.good_qty > 0 ? round(outKg[i] / o.good_qty, 6) : null;
      const ins = await txExecute(tx,
        `INSERT INTO trx_cut_output
           (company_id, output_no, lay_id, cutting_plan_id, cutting_id, io_no, style_id, color_id, size_id,
            good_qty, reject_qty, recut_qty, actual_kg, kg_per_pc, kg_basis, status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, outputNo, lay.id, plan.id, cuttingId, plan.io_no, plan.style_id, plan.color_id ?? null, o.size_id,
         o.good_qty, o.reject_qty, o.recut_qty, outKg[i], kgPc, bySize ? 'MARKER_SIZE' : 'PCS',
         o.good_qty > 0 ? 'OPEN' : 'COMPLETED', req.user!.id]);
      outputs.push({ id: ins.insertId, output_no: outputNo, size_id: o.size_id, size_code: sizeInfo.get(o.size_id)?.size_code,
        good_qty: o.good_qty, reject_qty: o.reject_qty, recut_qty: o.recut_qty, actual_kg: outKg[i], kg_per_pc: kgPc });
    }

    await txExecute(tx,
      `UPDATE trx_lay_plan SET status = 'CUT', actual_kg = ?, actual_cut_qty = ?, ply_count = ?, expected_pieces = ?,
              executed_at = NOW(), executed_by = ?, started_at = COALESCE(started_at, NOW()),
              operator_name = COALESCE(?, operator_name), table_no = COALESCE(?, table_no),
              marker_length_m = COALESCE(?, marker_length_m),
              override_reason = ?, override_by = ?, updated_by = ?, updated_at = NOW()
        WHERE id = ?`,
      [actualKg, goodTotal, ply, expected, req.user!.id, body.operator_name ?? null, body.table_no ?? null,
       body.lay_length_m ?? null, overrideUsed ? body.override_reason : null, overrideUsed ? req.user!.id : null,
       req.user!.id, lay.id]);
    if (mv && !mv.is_locked) {
      await txExecute(tx, `UPDATE trx_marker_version SET is_locked = 1, locked_at = NOW() WHERE id = ?`, [mv.id]);
    }
    const planState = await refreshPlanStatus(tx, plan.id);
    return {
      lay_id: lay.id, lay_no: lay.lay_no, cutting_id: cuttingId, cut_no: cutNo, status: 'CUT',
      actual_kg: actualKg, actual_cut_qty: goodTotal, expected_pieces: expected, planned_kg: lay.planned_kg,
      actual_kg_per_pc: round(actualKg / goodTotal, 5), kg_split_basis: bySize ? 'MARKER_SIZE' : 'PCS',
      override_used: overrideUsed, outputs, cut_order: planState,
    };
  });

  await audit(req, 'trx_lay_plan', layId, 'UPDATE', { status: 'PLANNED' }, { ...result, override_reason: body.override_reason, rolls: body.rolls, losses: body.losses });
  res.status(201).json({ data: result });
}));

/** POST /lay-plans/:id/approve — cutting supervisor approval of an executed lay */
cuttingExecutionRouter.post('/lay-plans/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ remarks: s.nullableStr(255) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!lay) throw NotFound('Lay not found');
    if (lay.status !== 'CUT') throw BadRequest(`Only an executed (CUT) lay can be approved — lay ${lay.lay_no} is ${lay.status}`);
    await txExecute(tx,
      `UPDATE trx_lay_plan SET status = 'APPROVED', approved_by = ?, approved_at = NOW(),
              remarks = COALESCE(?, remarks) WHERE id = ?`, [req.user!.id, body.remarks ?? null, id]);
  });
  await audit(req, 'trx_lay_plan', id, 'UPDATE', { status: 'CUT' }, { status: 'APPROVED', remarks: body.remarks });
  res.json({ data: { id, status: 'APPROVED' } });
}));

/**
 * POST /lay-plans/:id/cancel { reason } — cancel a planned lay, or reverse an
 * executed one (PRODUCTION.APPROVE). Reversal is blocked once any of its
 * bundles has moved beyond GENERATED.
 */
cuttingExecutionRouter.post('/lay-plans/:id/cancel', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});

  const result = await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!lay) throw NotFound('Lay not found');
    if (lay.status === 'CANCELLED') throw BadRequest(`Lay ${lay.lay_no} is already cancelled`);
    const plan = lay.cutting_plan_id ? await lockPlan(tx, cid, lay.cutting_plan_id) : null;
    if (plan) assertPlanOpen(plan, 'reverse a lay');
    const executed = ['CUT', 'APPROVED'].includes(lay.status);
    let reversed = { bundles: 0, outputs: 0, rolls: 0, losses: 0 };

    if (executed) {
      if (!hasPerm(req, 'PRODUCTION.APPROVE')) throw Forbidden('Reversing an executed lay needs PRODUCTION.APPROVE');
      const bundles = await txQuery<any>(tx, `SELECT * FROM trx_cutting_bundle WHERE lay_id = ? FOR UPDATE`, [id]);
      const moved = bundles.filter((b) => !['GENERATED', 'CANCELLED'].includes(b.status));
      if (moved.length) {
        throw BadRequest(`Lay ${lay.lay_no} cannot be reversed: ${moved.length} bundle(s) already moved beyond GENERATED (e.g. ${moved[0].bundle_no} is ${moved[0].status})`);
      }
      const live = bundles.filter((b) => b.status === 'GENERATED');
      if (live.length) {
        const ids = live.map((b) => b.id);
        const moves = await txQueryOne<any>(tx,
          `SELECT COUNT(*) AS n FROM trx_bundle_movement WHERE bundle_id IN (${ids.map(() => '?').join(',')})
             AND COALESCE(txn_type,'') NOT IN ('BUNDLE_CREATE')`, ids);
        if (num(moves?.n) > 0) throw BadRequest(`Lay ${lay.lay_no} cannot be reversed: its bundles already have floor movements`);
        const cartons = await txQueryOne<any>(tx,
          `SELECT COUNT(*) AS n FROM trx_carton_bundle WHERE bundle_id IN (${ids.map(() => '?').join(',')})`, ids);
        if (num(cartons?.n) > 0) throw BadRequest(`Lay ${lay.lay_no} cannot be reversed: its bundles are packed in cartons`);
        await txExecute(tx,
          `UPDATE trx_cutting_bundle SET status = 'CANCELLED', balance_qty = 0 WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
        for (const b of live) {
          await txExecute(tx,
            `INSERT INTO trx_bundle_movement (company_id, bundle_id, io_no, style_id, from_stage, to_stage, txn_type,
               moved_qty, moved_by, remarks, ref_table, ref_id)
             VALUES (?,?,?,?,?,'CANCELLED','LAY_REVERSAL',?,?,?,'trx_lay_plan',?)`,
            [cid, b.id, b.io_no, b.style_id, b.status, b.qty, req.user!.id, body.reason.slice(0, 255), id]);
        }
      }
      const outs = await txExecute(tx, `UPDATE trx_cut_output SET status = 'REVERSED' WHERE lay_id = ? AND status <> 'REVERSED'`, [id]);
      await txExecute(tx, `UPDATE trx_cutting SET is_cancelled = 1 WHERE lay_id = ?`, [id]);
      const rolls = await txQuery<any>(tx, `SELECT * FROM trx_lay_roll WHERE lay_id = ?`, [id]);
      for (const r of rolls) {
        if (!r.fabric_issue_roll_id) continue;
        await txQueryOne(tx, `SELECT id FROM trx_fabric_issue_roll WHERE id = ? FOR UPDATE`, [r.fabric_issue_roll_id]);
        await txExecute(tx, `UPDATE trx_fabric_issue_roll SET consumed_kg = GREATEST(consumed_kg - ?, 0) WHERE id = ?`,
          [r.actual_consumed_kg, r.fabric_issue_roll_id]);
        await refreshDcRollStatus(tx, r.fabric_issue_roll_id);
      }
      const losses = await txExecute(tx,
        `UPDATE trx_cutting_loss SET is_reversed = 1, reversed_by = ?, reversed_at = NOW(), reversal_reason = ?
          WHERE lay_id = ? AND is_reversed = 0`, [req.user!.id, body.reason, id]);
      reversed = { bundles: live.length, outputs: outs.affectedRows, rolls: rolls.length, losses: losses.affectedRows };
    }
    await txExecute(tx,
      `UPDATE trx_lay_plan SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`,
      [body.reason, req.user!.id, id]);
    const planState = plan ? await refreshPlanStatus(tx, plan.id) : null;
    return { id, lay_no: lay.lay_no, previous_status: lay.status, status: 'CANCELLED', reversed, cut_order: planState };
  });

  await audit(req, 'trx_lay_plan', id, 'UPDATE', { status: result.previous_status }, { ...result, reason: body.reason });
  res.json({ data: result });
}));

/* ================================================================
   CUT OUTPUT & BUNDLE GENERATION — doc §10–§13
================================================================ */

const CO_SELECT = `SELECT co.*, (co.good_qty - co.bundled_qty) AS remaining_qty, sz.size_code, sz.sort_order,
       lp.lay_no, lp.status AS lay_status, lp.marker_version_id, cp.plan_no, cp.status AS plan_status, cp.part_name,
       st.style_code, col.color_name, c.cut_no, 'PCS' AS uom
  FROM trx_cut_output co
  JOIN trx_lay_plan lp ON lp.id = co.lay_id
  LEFT JOIN trx_cutting_plan cp ON cp.id = co.cutting_plan_id
  LEFT JOIN mst_size sz ON sz.id = co.size_id
  LEFT JOIN mst_style st ON st.id = co.style_id
  LEFT JOIN mst_color col ON col.id = co.color_id
  LEFT JOIN trx_cutting c ON c.id = co.cutting_id`;

/** GET /cut-outputs?lay_id=&cutting_plan_id=&open=1 */
cuttingExecutionRouter.get('/cut-outputs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['co.company_id = ?'];
  const params: any[] = [cid];
  if (req.query.lay_id) { where.push('co.lay_id = ?'); params.push(Number(req.query.lay_id)); }
  if (req.query.cutting_plan_id) { where.push('co.cutting_plan_id = ?'); params.push(Number(req.query.cutting_plan_id)); }
  if (req.query.open === '1') where.push(`co.status = 'OPEN' AND co.good_qty > co.bundled_qty`);
  const rows = await query(`${CO_SELECT} WHERE ${where.join(' AND ')} ORDER BY co.id DESC LIMIT 2000`, params);
  res.json({ data: rows });
}));

/**
 * GET /cut-outputs/:id/allocation-preview?bundle_size=10&qty= — what the
 * generator would create, with the allocated (calculated) fabric KG.
 */
cuttingExecutionRouter.get('/cut-outputs/:id/allocation-preview', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const co = await queryOne<any>(`${CO_SELECT} WHERE co.id = ? AND co.company_id = ?`, [Number(req.params.id), cid]);
  if (!co) throw NotFound('Cut output not found');
  const bundleSize = Math.max(1, Math.floor(Number(req.query.bundle_size) || 10));
  const remaining = num(co.remaining_qty);
  const qty = req.query.qty ? Math.min(Math.floor(Number(req.query.qty)), remaining) : remaining;
  const lay = await queryOne<any>(`SELECT * FROM trx_lay_plan WHERE id = ?`, [co.lay_id]);
  const plan = await queryOne<any>(`SELECT fabric_id FROM trx_cutting_plan WHERE id = ?`, [co.cutting_plan_id]);
  const basis = await resolveKgPerPc(null, cid, {
    style_id: co.style_id, color_id: co.color_id, fabric_id: plan?.fabric_id ?? null, size_id: co.size_id,
    marker_version_id: lay?.marker_version_id, lay,
  });
  const full = Math.floor(qty / bundleSize);
  const rest = qty % bundleSize;
  res.json({
    data: {
      cut_output_id: co.id, output_no: co.output_no, remaining_qty: remaining, qty, bundle_size: bundleSize,
      bundle_count: full + (rest ? 1 : 0), last_bundle_qty: rest || (full ? bundleSize : 0),
      kg_per_pc: basis.kgPerPc != null ? round(basis.kgPerPc, 6) : null,
      allocated_kg_per_full_bundle: basis.kgPerPc != null ? round(basis.kgPerPc * bundleSize, 5) : null,
      allocated_kg_total: basis.kgPerPc != null ? round(basis.kgPerPc * qty, 5) : null,
      allocation_method: basis.method, allocation_source: basis.source,
      note: 'Allocated / calculated fabric KG — not a physical bundle weight',
    },
  });
}));

const bundleGenSchema = z.object({
  bundle_size: z.coerce.number().int().positive().max(1000),
  qty: z.coerce.number().int().positive().optional(),
  part_name: s.nullableStr(50),
  components: z.array(z.string().trim().max(60)).default([]),
  line_destination: s.nullableStr(40),
});

/** POST /cut-outputs/:id/bundles { bundle_size, qty? } */
cuttingExecutionRouter.post('/cut-outputs/:id/bundles', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = bundleGenSchema.parse(req.body);
  const result = await transaction((tx) => generateBundlesFromOutput(tx, Number(req.params.id), {
    cid, userId: req.user!.id, bundleSize: body.bundle_size, qty: body.qty ?? null,
    partName: body.part_name ?? null, components: body.components, lineDestination: body.line_destination ?? null,
  }));
  await audit(req, 'trx_cut_output', result.cut_output_id, 'UPDATE', undefined,
    { bundles_generated: result.bundles.map((b: any) => b.bundle_no), allocation: result.basis });
  res.status(201).json({ data: result });
}));

/** POST /lay-plans/:id/bundles { bundle_size } — bundle every open output of a lay */
cuttingExecutionRouter.post('/lay-plans/:id/bundles', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const layId = Number(req.params.id);
  const body = bundleGenSchema.omit({ qty: true }).parse(req.body);
  const results = await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [layId, cid]);
    if (!lay) throw NotFound('Lay not found');
    const outs = await txQuery<any>(tx,
      `SELECT id FROM trx_cut_output WHERE lay_id = ? AND status = 'OPEN' AND good_qty > bundled_qty ORDER BY id`, [layId]);
    if (!outs.length) throw BadRequest(`Lay ${lay.lay_no} has no cut output left to bundle`);
    const out: any[] = [];
    for (const o of outs) {
      out.push(await generateBundlesFromOutput(tx, o.id, {
        cid, userId: req.user!.id, bundleSize: body.bundle_size, qty: null,
        partName: body.part_name ?? null, components: body.components, lineDestination: body.line_destination ?? null,
      }));
    }
    return out;
  });
  await audit(req, 'trx_lay_plan', layId, 'UPDATE', undefined,
    { bundles_generated: results.flatMap((r) => r.bundles.map((b: any) => b.bundle_no)) });
  res.status(201).json({
    data: { outputs: results, count: results.reduce((a, r) => a + r.bundles.length, 0) },
  });
}));
