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
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';
import { resolveSoId } from '../stock/jobStock.routes.js';
import {
  KG_EPS, assertPlanCuttable, assertPlanOpen, checkOverCut, generateBundlesFromOutput, hasPerm, lockPlan,
  markerSizeKg, nextUniqueDocNo, num, parseJson, refreshDcRollStatus, refreshPlanStatus, resolveKgPerPc, round,
} from './cuttingEngine.js';

export const cuttingExecutionRouter = Router();
cuttingExecutionRouter.param('id', (_req, _res, next, v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? next() : next(NotFound('Not found'))));

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
    size_quantities: parseJson(mv.size_quantities, null),
    ratio_text: (parseJson<string[]>(mv.sizes, [])).map((sz, i) => `${sz}${(parseJson<number[]>(mv.ratios, []))[i] ?? 0}`).join(' '),
  };
}

/** Marker master fields that describe a version without changing what is cut (doc §4.2, §5). */
export interface MarkerMeta {
  status?: 'DRAFT' | 'IMPORTED'; so_id?: number | null; io_no?: string | null; buyer_po_no?: string | null;
  efficiency_pct?: number | null; cad_source?: string | null; import_hash?: string | null; import_batch?: string | null;
  size_quantities?: Record<string, number> | null;
}

/** Insert a new version when content changed; otherwise return the latest one. */
async function saveMarkerVersion(tx: any, cid: number, userId: number, cadReqId: number | null,
  content: MarkerContent, source: 'CAD' | 'MANUAL', meta: MarkerMeta = {}) {
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
  const consM = content.length_m && content.pieces_per_marker > 0 ? round(content.length_m / content.pieces_per_marker, 5) : null;
  await txExecute(tx,
    `UPDATE trx_marker_version SET status = ?, so_id = ?, io_no = ?, buyer_po_no = ?, efficiency_pct = ?, cad_source = ?,
            import_hash = ?, import_batch = ?, size_quantities = ?, consumption_m_per_pc = ? WHERE id = ?`,
    [meta.status ?? 'DRAFT', meta.so_id ?? null, meta.io_no ?? null, meta.buyer_po_no ?? null, meta.efficiency_pct ?? null,
     meta.cad_source ?? (source === 'CAD' ? 'ERP_CAD' : 'MANUAL'), meta.import_hash ?? null, meta.import_batch ?? null,
     meta.size_quantities ? JSON.stringify(meta.size_quantities) : null, consM, r.insertId]);
  return { created: true, id: r.insertId as number };
}

/** Versions a newer approved version replaces: same CAD (or none), marker no and fabric. */
const MV_FAMILY = `company_id = ? AND cad_req_id <=> ? AND marker_no = ? AND fabric_id <=> ? AND version < ?`;

/**
 * Approve a marker version (doc §5, §21: … → APPROVED → OBSOLETE). Older versions of the same marker become OBSOLETE —
 * lays already made from them keep them, but no new lay can use them (doc §23).
 */
export async function approveMarkerVersion(tx: any, cid: number, userId: number, id: number) {
  const mv = await txQueryOne<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
  if (!mv) throw NotFound('Marker version not found');
  if (mv.status === 'APPROVED') throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is already approved`);
  if (['REJECTED', 'OBSOLETE'].includes(mv.status)) throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is ${mv.status} — import / snapshot a new version`);
  const newer = await txQueryOne<any>(tx,
    `SELECT version FROM trx_marker_version WHERE company_id = ? AND cad_req_id <=> ? AND marker_no = ? AND fabric_id <=> ? AND version > ? AND status = 'APPROVED' LIMIT 1`,
    [cid, mv.cad_req_id, mv.marker_no, mv.fabric_id, mv.version]);
  if (newer) throw BadRequest(`Marker ${mv.marker_no} already has a newer approved version (v${newer.version})`);
  await txExecute(tx, `UPDATE trx_marker_version SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [userId, id]);
  const obs = await txExecute(tx,
    `UPDATE trx_marker_version SET status = 'OBSOLETE', obsoleted_by = ?, obsoleted_at = NOW()
      WHERE ${MV_FAMILY} AND status NOT IN ('OBSOLETE','REJECTED')`, [userId, cid, mv.cad_req_id, mv.marker_no, mv.fabric_id, mv.version]);
  return { before: mv, obsoleted: obs.affectedRows };
}

const MV_SELECT = `SELECT mv.*, st.style_code, col.color_name, fb.fabric_name, cr.req_no AS cad_req_no, ua.full_name AS approved_by_name,
       (SELECT COUNT(*) FROM trx_lay_plan lp WHERE lp.marker_version_id = mv.id AND lp.status <> 'CANCELLED') AS lay_count
  FROM trx_marker_version mv
  LEFT JOIN mst_style st ON st.id = mv.style_id
  LEFT JOIN mst_color col ON col.id = mv.color_id
  LEFT JOIN mst_fabric fb ON fb.id = mv.fabric_id
  LEFT JOIN trx_cad_requirement cr ON cr.id = mv.cad_req_id
  LEFT JOIN mst_user ua ON ua.id = mv.approved_by`;

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
  if (req.query.status) { where.push('mv.status = ?'); params.push(String(req.query.status)); }
  if (req.query.pending === '1') where.push(`mv.status IN ('DRAFT','IMPORTED','REVIEW')`);
  if (req.query.io_no) { where.push('mv.io_no = ?'); params.push(String(req.query.io_no)); }
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
cuttingExecutionRouter.post('/marker-versions/snapshot', requireAny('PRODUCTION.CREATE', 'CAD_MARKER.IMPORT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    cad_req_id: s.idReq(),
    marker_ref: s.strReq(50),
    fabric_id: s.id(),
    color_id: s.id(),
    /** import and approve in one step (needs approval rights) */
    approve: z.coerce.boolean().default(false),
  }).parse(req.body);
  if (body.approve && !hasPerm(req, 'PRODUCTION.APPROVE') && !hasPerm(req, 'CAD_MARKER.APPROVE')) {
    throw Forbidden('Approving a marker needs CAD_MARKER.APPROVE or PRODUCTION.APPROVE');
  }

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
  // Job / PO / efficiency / size-wise output of the marker (doc §4.2) — the CAD is made for one job (internal IO)
  const soId = await resolveSoId(cid, null, cr.internal_ir_no);
  const so = soId ? await queryOne<any>(`SELECT buyer_po_no FROM trx_sales_order WHERE id = ?`, [soId]) : null;
  const sizeQty: Record<string, number> = {};
  for (const cw of Array.isArray(mj.colorways) ? mj.colorways : []) {
    sizes.forEach((sz, i) => { sizeQty[sz] = (sizeQty[sz] ?? 0) + (Number(cw?.cut_quantities?.[i] ?? cw?.quantities?.[i]) || 0); });
  }
  const meta: MarkerMeta = {
    status: 'IMPORTED', so_id: soId, io_no: cr.internal_ir_no ?? null, buyer_po_no: so?.buyer_po_no ?? null,
    efficiency_pct: num(cr.marker_efficiency) > 0 ? num(cr.marker_efficiency) : null, cad_source: 'ERP_CAD',
    size_quantities: Object.keys(sizeQty).length ? sizeQty : null,
  };
  const out = await transaction(async (tx) => {
    const saved = await saveMarkerVersion(tx, cid, req.user!.id, cr.id, content, 'CAD', meta);
    let approved = false;
    if (body.approve) {
      const cur = await txQueryOne<any>(tx, `SELECT status FROM trx_marker_version WHERE id = ?`, [saved.id]);
      if (!['APPROVED', 'REJECTED', 'OBSOLETE'].includes(cur?.status)) { await approveMarkerVersion(tx, cid, req.user!.id, saved.id); approved = true; }
    }
    return { ...saved, approved };
  });
  const row = await queryOne(`${MV_SELECT} WHERE mv.id = ?`, [out.id]);
  if (out.created) await audit(req, 'trx_marker_version', out.id, 'INSERT', undefined, row);
  if (out.approved) await audit(req, 'trx_marker_version', out.id, 'UPDATE', undefined, { status: 'APPROVED', approved_by: req.user!.id });
  res.status(out.created ? 201 : 200).json({ data: hydrateMv(row), created: out.created, approved: out.approved });
}));

/** POST /marker-versions — manual marker (Marker Master, no CAD) */
cuttingExecutionRouter.post('/marker-versions', requireAny('PRODUCTION.CREATE', 'CAD_MARKER.IMPORT'), ah(async (req, res) => {
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

const MARKER_APPROVE = requireAny('PRODUCTION.APPROVE', 'CAD_MARKER.APPROVE');

/** POST /marker-versions/:id/approve (alias POST /cad-markers/:id/approve) — doc §18 */
const approveHandler = ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const r = await transaction((tx) => approveMarkerVersion(tx, cid, req.user!.id, id));
  await audit(req, 'trx_marker_version', id, 'UPDATE', { status: r.before.status }, { status: 'APPROVED', approved_by: req.user!.id, obsoleted_older: r.obsoleted });
  res.json({ data: hydrateMv(await queryOne(`${MV_SELECT} WHERE mv.id = ?`, [id])), obsoleted: r.obsoleted });
});
cuttingExecutionRouter.post('/marker-versions/:id/approve', MARKER_APPROVE, approveHandler);
cuttingExecutionRouter.post('/cad-markers/:id/approve', MARKER_APPROVE, approveHandler);

/** POST /marker-versions/:id/review — DRAFT / IMPORTED → REVIEW */
cuttingExecutionRouter.post('/marker-versions/:id/review', requireAny('PRODUCTION.CREATE', 'CAD_MARKER.IMPORT', 'CAD_MARKER.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const before = await transaction(async (tx) => {
    const mv = await txQueryOne<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!mv) throw NotFound('Marker version not found');
    if (!['DRAFT', 'IMPORTED'].includes(mv.status)) throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is ${mv.status} — only a draft / imported version goes to review`);
    await txExecute(tx, `UPDATE trx_marker_version SET status = 'REVIEW', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`, [req.user!.id, id]);
    return mv;
  });
  await audit(req, 'trx_marker_version', id, 'UPDATE', { status: before.status }, { status: 'REVIEW' });
  res.json({ data: hydrateMv(await queryOne(`${MV_SELECT} WHERE mv.id = ?`, [id])) });
}));

/** POST /marker-versions/:id/reject { reason } — a version not yet approved */
cuttingExecutionRouter.post('/marker-versions/:id/reject', MARKER_APPROVE, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});
  const before = await transaction(async (tx) => {
    const mv = await txQueryOne<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!mv) throw NotFound('Marker version not found');
    if (!['DRAFT', 'IMPORTED', 'REVIEW'].includes(mv.status)) throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is ${mv.status} — an approved version is retired with Obsolete, not rejected`);
    await txExecute(tx, `UPDATE trx_marker_version SET status = 'REJECTED', rejected_by = ?, rejected_at = NOW(), reject_reason = ? WHERE id = ?`, [req.user!.id, body.reason, id]);
    return mv;
  });
  await audit(req, 'trx_marker_version', id, 'UPDATE', { status: before.status }, { status: 'REJECTED', reason: body.reason });
  res.json({ data: hydrateMv(await queryOne(`${MV_SELECT} WHERE mv.id = ?`, [id])) });
}));

/** POST /marker-versions/:id/obsolete { reason } — retire an approved version; lays made from it keep it */
cuttingExecutionRouter.post('/marker-versions/:id/obsolete', MARKER_APPROVE, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});
  const before = await transaction(async (tx) => {
    const mv = await txQueryOne<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!mv) throw NotFound('Marker version not found');
    if (mv.status === 'OBSOLETE') throw BadRequest('Marker version is already obsolete');
    await txExecute(tx, `UPDATE trx_marker_version SET status = 'OBSOLETE', obsoleted_by = ?, obsoleted_at = NOW(), reject_reason = COALESCE(reject_reason, ?) WHERE id = ?`, [req.user!.id, body.reason, id]);
    return mv;
  });
  await audit(req, 'trx_marker_version', id, 'UPDATE', { status: before.status }, { status: 'OBSOLETE', reason: body.reason });
  res.json({ data: hydrateMv(await queryOne(`${MV_SELECT} WHERE mv.id = ?`, [id])) });
}));

/** GET /cad-markers/:id — marker detail + size ratio + version history (doc §18, §24) */
cuttingExecutionRouter.get('/cad-markers/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const row = await queryOne<any>(`${MV_SELECT} WHERE mv.id = ? AND mv.company_id = ?`, [Number(req.params.id), cid]);
  if (!row) throw NotFound('Marker version not found');
  const history = await query(`${MV_SELECT} WHERE mv.company_id = ? AND mv.cad_req_id <=> ? AND mv.marker_no = ? ORDER BY mv.version DESC`,
    [cid, row.cad_req_id, row.marker_no]);
  const lays = await query(`SELECT id, lay_no, status, ply_count, expected_pieces FROM trx_lay_plan WHERE marker_version_id = ? ORDER BY id`, [row.id]);
  res.json({ data: { ...hydrateMv(row), history: history.map(hydrateMv), lays } });
}));

/* ---------------------------------------------------------------- CAD marker import (doc §4, Phase 1: CSV / Excel / XML) */

/** "S2/M4/L4/XL2", "S:2, M:4", "S-2 M-4" → sizes + ratios */
export function parseSizeRatio(txt: unknown): { sizes: string[]; ratios: number[] } | null {
  const parts = String(txt ?? '').split(/[\/,;|\s]+/).map((x) => x.trim()).filter(Boolean);
  const sizes: string[] = []; const ratios: number[] = [];
  for (const p of parts) {
    const m = p.match(/^([A-Za-z0-9]+?)[:=\-]?(\d+)$/);
    if (!m) return null;
    sizes.push(m[1].toUpperCase()); ratios.push(Number(m[2]));
  }
  return sizes.length ? { sizes, ratios } : null;
}

const importRowSchema = z.object({
  marker_no: z.string().trim().min(1).max(60),
  marker_version: z.string().trim().max(20).optional().nullable(),
  marker_name: z.string().trim().max(120).optional().nullable(),
  job_no: z.string().trim().min(1).max(60),
  po_no: z.string().trim().max(60).optional().nullable(),
  style_no: z.string().trim().min(1).max(60),
  colour: z.string().trim().max(80).optional().nullable(),
  fabric: z.string().trim().max(120).optional().nullable(),
  fabric_id: z.coerce.number().int().positive().optional().nullable(),
  fabric_width: z.coerce.number().positive(),
  marker_length_m: z.coerce.number().positive(),
  efficiency_pct: z.coerce.number().min(0).max(100),
  pieces_per_marker: z.coerce.number().int().positive(),
  size_ratio: z.string().trim().min(1).max(200),
  size_quantities: z.string().trim().max(400).optional().nullable(),
  gsm: z.coerce.number().positive().optional().nullable(),
  cad_file: z.string().trim().max(255).optional().nullable(),
  cad_source: z.string().trim().max(40).optional().nullable(),
  import_hash: z.string().trim().max(64).optional().nullable(),
});

/**
 * POST /marker-versions/import (alias POST /cad-markers/import) { rows, file_name?, file_url?, cad_source?, dry_run? }
 * Parsed CAD marker rows (the screen reads the CSV / Excel / XML) → validated → IMPORTED marker versions
 * (CadMarkerImportService + CadMarkerValidationService, doc §19). A row already imported (same import hash) is skipped.
 */
const importHandler = ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    rows: z.array(z.record(z.string(), z.any())).min(1).max(500),
    file_name: s.nullableStr(255), file_url: s.nullableStr(255), cad_source: s.nullableStr(40),
    dry_run: z.coerce.boolean().default(false),
  }).parse(req.body);
  const batch = createHash('sha256').update(`${cid}|${Date.now()}|${body.file_name ?? ''}`).digest('hex').slice(0, 16);
  const norm = (x: unknown) => String(x ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const results: any[] = [];
  let allFabrics: any[] | undefined;
  const valid: { idx: number; content: MarkerContent; meta: MarkerMeta }[] = [];
  for (let i = 0; i < body.rows.length; i++) {
    const raw = Object.fromEntries(Object.entries(body.rows[i]).map(([k, v]) => [k.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'), v === '' ? null : v]));
    const errors: string[] = [];
    const parsed = importRowSchema.safeParse(raw);
    if (!parsed.success) {
      results.push({ row: i + 1, marker_no: raw.marker_no ?? null, status: 'ERROR', errors: parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`) });
      continue;
    }
    const r = parsed.data;
    const ratio = parseSizeRatio(r.size_ratio);
    if (!ratio) errors.push(`size_ratio "${r.size_ratio}" is not like S2/M4/L4/XL2`);
    if (ratio && new Set(ratio.sizes).size !== ratio.sizes.length) errors.push('a size appears twice in size_ratio');
    const sumRatio = ratio ? ratio.ratios.reduce((a, b) => a + b, 0) : 0;
    if (ratio && sumRatio > 0 && r.pieces_per_marker % sumRatio !== 0) errors.push(`pieces_per_marker ${r.pieces_per_marker} is not a multiple of the ratio total ${sumRatio}`);
    let sizeQty: Record<string, number> | null = null;
    if (r.size_quantities) {
      const q = parseSizeRatio(r.size_quantities);
      if (!q) errors.push(`size_quantities "${r.size_quantities}" is not like S10/M20/L20/XL10`);
      else sizeQty = Object.fromEntries(q.sizes.map((sz, k) => [sz, q.ratios[k]]));
    }
    const soId = await resolveSoId(cid, null, r.job_no);
    const so = soId ? await queryOne<any>(`SELECT id, so_no, io_no, buyer_po_no FROM trx_sales_order WHERE id = ?`, [soId]) : null;
    if (!so) errors.push(`job ${r.job_no} not found`);
    if (so && r.po_no && so.buyer_po_no && norm(so.buyer_po_no) !== norm(r.po_no)) errors.push(`po_no ${r.po_no} is not job ${r.job_no}'s buyer PO (${so.buyer_po_no})`);
    const style = await queryOne<any>(`SELECT id, style_code FROM mst_style WHERE company_id = ? AND (style_code = ? OR style_name = ?) ORDER BY id LIMIT 1`, [cid, r.style_no, r.style_no]);
    if (!style) errors.push(`style ${r.style_no} not found`);
    if (so && style) {
      const onJob = await queryOne<any>(`SELECT 1 x FROM trx_sales_order_line WHERE so_id = ? AND style_id = ? LIMIT 1`, [so.id, style.id]);
      if (!onJob) errors.push(`style ${r.style_no} is not on job ${r.job_no}`);
    }
    let colorId: number | null = null;
    if (r.colour) {
      const col = await queryOne<any>(`SELECT id FROM mst_color WHERE company_id = ? AND (color_name = ? OR color_code = ?) ORDER BY id LIMIT 1`, [cid, r.colour, r.colour]);
      if (!col) errors.push(`colour ${r.colour} not found`); else colorId = Number(col.id);
    }
    let fabricId: number | null = r.fabric_id ?? null;
    if (fabricId) {
      const f = await queryOne<any>(`SELECT id FROM mst_fabric WHERE id = ? AND company_id = ?`, [fabricId, cid]);
      if (!f) errors.push(`fabric_id ${fabricId} not found`);
    } else if (r.fabric) {
      // CAD exports name the fabric loosely: code, id, exact name, then the name ignoring spacing / punctuation
      let f = await queryOne<any>(`SELECT id FROM mst_fabric WHERE company_id = ? AND (fabric_code = ? OR fabric_name = ? OR id = ?) ORDER BY id LIMIT 1`,
        [cid, r.fabric, r.fabric, /^\d+$/.test(r.fabric) ? Number(r.fabric) : 0]);
      if (!f) {
        allFabrics ??= await query<any>(`SELECT id, fabric_name, fabric_code FROM mst_fabric WHERE company_id = ? AND COALESCE(is_deleted,0) = 0 ORDER BY id`, [cid]);
        const t = norm(r.fabric);
        f = allFabrics.find((x) => norm(x.fabric_name) === t || norm(x.fabric_code) === t)
          ?? allFabrics.find((x) => norm(x.fabric_name).startsWith(t) || t.startsWith(norm(x.fabric_name)));
      }
      if (!f) errors.push(`fabric ${r.fabric} not found`); else fabricId = Number(f.id);
    } else errors.push('fabric (name / code) or fabric_id is required');
    const hash = r.import_hash || createHash('sha256').update(JSON.stringify([r.marker_no, r.marker_version ?? '', r.job_no, r.style_no, r.colour ?? '',
      fabricId, r.fabric_width, r.marker_length_m, r.efficiency_pct, r.pieces_per_marker, r.size_ratio, r.gsm ?? ''])).digest('hex');
    const dup = await queryOne<any>(`SELECT id, marker_no, version FROM trx_marker_version WHERE company_id = ? AND import_hash = ? LIMIT 1`, [cid, hash]);
    if (dup) { results.push({ row: i + 1, marker_no: r.marker_no, status: 'DUPLICATE', id: dup.id, message: `already imported as ${dup.marker_no} v${dup.version}` }); continue; }
    if (errors.length || !ratio || !style || !so) { results.push({ row: i + 1, marker_no: r.marker_no, status: 'ERROR', errors }); continue; }
    // KG for one ply (open width, one layer per ratio set): length × width × GSM
    const layers = r.pieces_per_marker / sumRatio;
    const kgPerPly = r.gsm ? round(r.marker_length_m * r.fabric_width * 0.0254 * r.gsm / 1000 * layers, 5) : null;
    const content: MarkerContent = {
      marker_no: r.marker_no, marker_name: r.marker_name ?? (r.marker_version ? `${r.marker_no} ${r.marker_version}` : null),
      style_id: Number(style.id), color_id: colorId, fabric_id: fabricId, fabric_type: null, gsm: r.gsm ?? null,
      width_in: r.fabric_width, length_m: r.marker_length_m, sizes: ratio.sizes, ratios: ratio.ratios,
      pieces_per_marker: r.pieces_per_marker, marker_kg_per_ply: kgPerPly ?? r.marker_length_m,
      cad_kg_per_pc: kgPerPly ? round(kgPerPly / r.pieces_per_marker, 5) : round(r.marker_length_m / r.pieces_per_marker, 5),
      size_consumption: null, uom: kgPerPly ? 'KG' : 'MTR', cad_file_ref: r.cad_file ?? body.file_url ?? body.file_name ?? null,
    };
    valid.push({ idx: i, content, meta: {
      status: 'IMPORTED', so_id: Number(so.id), io_no: so.io_no ?? so.so_no, buyer_po_no: r.po_no ?? so.buyer_po_no ?? null,
      efficiency_pct: r.efficiency_pct, cad_source: r.cad_source ?? body.cad_source ?? 'CAD_IMPORT', import_hash: hash, import_batch: batch,
      size_quantities: sizeQty,
    } });
    results.push({ row: i + 1, marker_no: r.marker_no, status: 'VALID', kg_per_ply: kgPerPly });
  }
  if (!body.dry_run && valid.length) {
    const saved = await transaction(async (tx) => {
      const out: any[] = [];
      for (const v of valid) out.push({ idx: v.idx, ...(await saveMarkerVersion(tx, cid, req.user!.id, null, v.content, 'MANUAL', v.meta)) });
      return out;
    });
    for (const sv of saved) {
      const res0 = results.find((x) => x.row === sv.idx + 1)!;
      const row = await queryOne<any>(`SELECT id, marker_no, version FROM trx_marker_version WHERE id = ?`, [sv.id]);
      Object.assign(res0, { status: sv.created ? 'IMPORTED' : 'UNCHANGED', id: sv.id, version: row?.version });
      if (sv.created) await audit(req, 'trx_marker_version', sv.id, 'INSERT', undefined, { import_batch: batch, file: body.file_name, row: sv.idx + 1 });
    }
  }
  const count = (st: string) => results.filter((x) => x.status === st).length;
  res.status(body.dry_run ? 200 : 201).json({ data: { batch, dry_run: body.dry_run, file_name: body.file_name ?? null, rows: results,
    imported: count('IMPORTED'), valid: count('VALID'), duplicates: count('DUPLICATE'), errors: count('ERROR'), unchanged: count('UNCHANGED') } });
});
cuttingExecutionRouter.post('/marker-versions/import', requireAny('PRODUCTION.CREATE', 'CAD_MARKER.IMPORT'), importHandler);
cuttingExecutionRouter.post('/cad-markers/import', requireAny('PRODUCTION.CREATE', 'CAD_MARKER.IMPORT'), importHandler);

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

/** Lay statuses before cutting in the CAD lay flow (doc §21), in order. */
export const LAY_FLOW_PRE_CUT = ['GENERATED', 'ROLL_RESERVED', 'PLAN_APPROVED', 'ISSUED', 'RECEIVED', 'SPREADING', 'READY_FOR_CUTTING'] as const;
/** Statuses a lay can be cut from: the CAD flow's READY_FOR_CUTTING, or a manual lay (PLANNED / SPREAD). */
export const LAY_EXECUTABLE = ['PLANNED', 'SPREAD', 'READY_FOR_CUTTING'];

/** POST /lay-plans/:id/execute (alias POST /cutting { lay_id }) — record actual consumption + cut output in one transaction */
const executeHandler = ah(async (req, res) => {
  const cid = req.user!.companyId;
  const layId = Number(req.params.id ?? req.body?.lay_id);
  if (!Number.isInteger(layId) || layId <= 0) throw BadRequest('lay_id is required');
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
    if (!LAY_EXECUTABLE.includes(lay.status)) {
      if ((LAY_FLOW_PRE_CUT as readonly string[]).includes(lay.status)) {
        throw BadRequest(`Lay ${lay.lay_no} is ${lay.status.replace(/_/g, ' ')} — reserve rolls, approve, issue, receive and complete spreading before cutting (doc §14)`);
      }
      throw BadRequest(`Lay ${lay.lay_no} is already ${lay.status}`);
    }
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

    // a CAD-flow lay keeps its planned ply / pieces (planned vs actual, doc §22); the actual ply goes to actual_ply
    const keepPlan = lay.status === 'READY_FOR_CUTTING';
    await txExecute(tx,
      `UPDATE trx_lay_plan SET status = 'CUT', actual_kg = ?, actual_cut_qty = ?, ply_count = IF(${keepPlan ? 1 : 0}, ply_count, ?),
              expected_pieces = IF(${keepPlan ? 1 : 0}, expected_pieces, ?), actual_ply = ?,
              executed_at = NOW(), executed_by = ?, started_at = COALESCE(started_at, NOW()),
              operator_name = COALESCE(?, operator_name), table_no = COALESCE(?, table_no),
              marker_length_m = COALESCE(?, marker_length_m),
              override_reason = ?, override_by = ?, updated_by = ?, updated_at = NOW()
        WHERE id = ?`,
      [actualKg, goodTotal, ply, expected, ply, req.user!.id, body.operator_name ?? null, body.table_no ?? null,
       body.lay_length_m ?? null, overrideUsed ? body.override_reason : null, overrideUsed ? req.user!.id : null,
       req.user!.id, lay.id]);
    if (mv && !mv.is_locked) {
      await txExecute(tx, `UPDATE trx_marker_version SET is_locked = 1, locked_at = NOW() WHERE id = ?`, [mv.id]);
    }
    // the lay's issued roll allocations are now consumed (doc §9 → §14)
    await txExecute(tx, `UPDATE trx_lay_roll_alloc SET status = 'CONSUMED' WHERE lay_id = ? AND status = 'ISSUED'`, [lay.id]);
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
});
const EXECUTE = requireAny('PRODUCTION.UPDATE', 'CUTTING.EXECUTE');
cuttingExecutionRouter.post('/lay-plans/:id/execute', EXECUTE, executeHandler);
cuttingExecutionRouter.post('/cutting', EXECUTE, executeHandler);

/**
 * POST /lay-plans/:id/approve — two approvals share the doc's endpoint (§18):
 *   ROLL_RESERVED → PLAN_APPROVED   the lay plan with its reserved rolls, before fabric is issued (§21)
 *   CUT           → APPROVED        the supervisor's verification of an executed lay
 */
cuttingExecutionRouter.post('/lay-plans/:id/approve', requireAny('PRODUCTION.APPROVE', 'CUTTING.SUPERVISE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ remarks: s.nullableStr(255) }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!lay) throw NotFound('Lay not found');
    if (lay.status === 'ROLL_RESERVED') {
      const plan = await lockPlan(tx, cid, lay.cutting_plan_id);
      assertPlanCuttable(plan);
      const held = await txQueryOne<any>(tx, `SELECT COUNT(*) n, COALESCE(SUM(alloc_kg),0) kg FROM trx_lay_roll_alloc WHERE lay_id = ? AND status = 'RESERVED'`, [id]);
      if (!num(held?.n)) throw BadRequest(`Lay ${lay.lay_no} has no reserved rolls — reserve rolls before approving`);
      await txExecute(tx, `UPDATE trx_lay_plan SET status = 'PLAN_APPROVED', plan_approved_by = ?, plan_approved_at = NOW(),
                remarks = COALESCE(?, remarks), updated_by = ?, updated_at = NOW() WHERE id = ?`, [req.user!.id, body.remarks ?? null, req.user!.id, id]);
      return { from: lay.status, status: 'PLAN_APPROVED', reserved_kg: round(num(held?.kg), 3) };
    }
    if (lay.status !== 'CUT') throw BadRequest(`Lay ${lay.lay_no} is ${lay.status} — a lay is approved after its rolls are reserved (plan) or after it is cut`);
    await txExecute(tx,
      `UPDATE trx_lay_plan SET status = 'APPROVED', approved_by = ?, approved_at = NOW(),
              remarks = COALESCE(?, remarks) WHERE id = ?`, [req.user!.id, body.remarks ?? null, id]);
    return { from: 'CUT', status: 'APPROVED' };
  });
  await audit(req, 'trx_lay_plan', id, 'UPDATE', { status: out.from }, { ...out, remarks: body.remarks });
  res.json({ data: { id, ...out } });
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
    // reserved rolls go back to stock; fabric already issued stays with cutting on its DC (return it from the DC)
    const released = await txExecute(tx,
      `UPDATE trx_lay_roll_alloc SET status = 'RELEASED', released_by = ?, released_at = NOW(), release_reason = ?
        WHERE lay_id = ? AND status = 'RESERVED'`, [req.user!.id, `Lay cancelled: ${body.reason}`.slice(0, 255), id]);
    await txExecute(tx,
      `UPDATE trx_lay_plan SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`,
      [body.reason, req.user!.id, id]);
    (reversed as any).released_reservations = released.affectedRows;
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

/** POST /lay-plans/:id/bundles { bundle_size } (alias POST /cutting/:id/bundles, :id = the cutting) — bundle every open output of a lay */
const layBundlesHandler = ah(async (req, res) => {
  const cid = req.user!.companyId;
  let layId = Number(req.params.id);
  if (req.path.startsWith('/cutting/')) {
    const cut = await queryOne<any>(`SELECT lay_id FROM trx_cutting WHERE id = ? AND company_id = ?`, [layId, cid]);
    if (!cut?.lay_id) throw NotFound('Cutting not found (or not made from a lay)');
    layId = Number(cut.lay_id);
  }
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
});
cuttingExecutionRouter.post('/lay-plans/:id/bundles', requirePermission('PRODUCTION.CREATE'), layBundlesHandler);
cuttingExecutionRouter.post('/cutting/:id/bundles', requirePermission('PRODUCTION.CREATE'), layBundlesHandler);
