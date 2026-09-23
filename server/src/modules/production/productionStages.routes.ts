import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import {
  KG_EPS, assertPlanOpen, generateBundlesLegacy, lockPlan, nextUniqueDocNo, num, parseJson, refreshDcRollStatus,
  refreshFabricRollStatus, round,
} from './cuttingEngine.js';

export const productionStagesRouter = Router();

const dateStr = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

async function kgUomId(tx: any): Promise<number> {
  const u = await txQueryOne<any>(tx, `SELECT id FROM cfg_uom WHERE code = 'KG' LIMIT 1`);
  return u?.id ?? 5;
}

// ============================================================
// 1. FABRIC DC / FABRIC ISSUE — doc §6
//    Roll-wise, from real roll stock (trx_fabric_roll). Issued KG is
//    locked against the roll's available KG (weight − issued).
// ============================================================

const fabricRollSchema = z.object({
  fabric_roll_id: s.idReq(),
  /** KG to issue; defaults to the roll's whole available KG. */
  issue_kg: z.coerce.number().positive().optional(),
  issue_mtr: z.coerce.number().min(0).optional(),
  width_cm: z.coerce.number().positive().optional(),
});

const fabricIssueSchema = z.object({
  issue_no: s.nullableStr(40),
  issue_date: dateStr(),
  cutting_plan_id: s.idReq(),
  warehouse_id: s.id(),
  from_location: s.nullableStr(80),
  to_location: s.nullableStr(80),
  remarks: s.text(),
  rolls: z.array(fabricRollSchema).min(1, 'Select at least one fabric roll'),
});

const ISSUE_SELECT = `SELECT fi.*,
            cp.plan_no, cp.status AS plan_status,
            st.style_code, st.style_name,
            col.color_name,
            fab.fabric_name,
            wh.warehouse_name,
            (SELECT COALESCE(SUM(r.returned_kg),0) FROM trx_fabric_issue_roll r WHERE r.fabric_issue_id = fi.id) AS returned_kg,
            (SELECT COALESCE(SUM(r.consumed_kg),0) FROM trx_fabric_issue_roll r WHERE r.fabric_issue_id = fi.id) AS consumed_kg,
            'KG' AS uom
       FROM trx_fabric_issue fi
       LEFT JOIN trx_cutting_plan cp ON cp.id = fi.cutting_plan_id
       LEFT JOIN mst_style st ON st.id = fi.style_id
       LEFT JOIN mst_color col ON col.id = fi.color_id
       LEFT JOIN mst_fabric fab ON fab.id = fi.fabric_id
       LEFT JOIN mst_warehouse wh ON wh.id = fi.warehouse_id`;

/** GET /fabric-issues */
productionStagesRouter.get('/fabric-issues', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: any[] = [cid];
  let where = 'WHERE fi.company_id = ?';
  if (req.query.cutting_plan_id) { where += ' AND fi.cutting_plan_id = ?'; params.push(Number(req.query.cutting_plan_id)); }
  const rows = await query(`${ISSUE_SELECT} ${where} ORDER BY fi.issue_date DESC, fi.id DESC`, params);
  res.json({ data: rows });
}));

/** GET /fabric-issues/:id */
productionStagesRouter.get('/fabric-issues/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(`${ISSUE_SELECT} WHERE fi.id = ? AND fi.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Fabric issue not found');

  const rolls = await query(
    `SELECT fir.*, fr.grn_id, g.grn_no, fr.dia, fr.meters AS roll_meters, fr.weight_kg AS roll_weight_kg,
            fr.stock_status AS roll_stock_status,
            ROUND(COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg, 4) AS remaining_kg,
            fir.fabric_roll_id IS NULL AS is_legacy, 'KG' AS uom
       FROM trx_fabric_issue_roll fir
       LEFT JOIN trx_fabric_roll fr ON fr.id = fir.fabric_roll_id
       LEFT JOIN trx_grn g ON g.id = fr.grn_id
      WHERE fir.fabric_issue_id = ? ORDER BY fir.id`, [id]);
  const returns = await query(
    `SELECT rt.*, u.full_name AS created_by_name FROM trx_fabric_return rt
       LEFT JOIN mst_user u ON u.id = rt.created_by
      WHERE rt.fabric_issue_id = ? AND rt.company_id = ? ORDER BY rt.id`, [id, cid]);
  res.json({ data: { ...(row as any), rolls, returns } });
}));

/**
 * GET /cutting-plans/:id/issuable-rolls — roll stock that may go on a DC for
 * this cut order: same fabric, QC accepted, not CLOSED, available KG > 0.
 * ?q= filters roll / lot / GRN no (barcode scan = exact roll no).
 */
productionStagesRouter.get('/cutting-plans/:id/issuable-rolls', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const plan = await queryOne<any>(`SELECT * FROM trx_cutting_plan WHERE id = ? AND company_id = ?`, [Number(req.params.id), cid]);
  if (!plan) throw NotFound('Cut order not found');
  const params: any[] = [cid];
  let where = `fr.company_id = ? AND fr.qc_status = 'ACCEPTED' AND fr.stock_status <> 'CLOSED'
               AND COALESCE(fr.weight_kg,0) - fr.issued_kg > ${KG_EPS}`;
  if (plan.fabric_id) { where += ' AND fr.fabric_id = ?'; params.push(plan.fabric_id); }
  if (req.query.q) {
    where += ' AND (fr.roll_no LIKE ? OR fr.lot_no LIKE ? OR g.grn_no LIKE ?)';
    const like = `%${String(req.query.q)}%`;
    params.push(like, like, like);
  }
  const rows = await query(
    `SELECT fr.id, fr.roll_no, fr.lot_no, fr.shade, fr.gsm, fr.dia, fr.meters, fr.weight_kg, fr.issued_kg,
            ROUND(COALESCE(fr.weight_kg,0) - fr.issued_kg, 3) AS available_kg,
            fr.stock_status, fr.qc_status, fr.fabric_id, fb.fabric_name, fr.warehouse_id, wh.warehouse_name,
            fr.location_bin, g.grn_no, g.grn_date, 'KG' AS uom
       FROM trx_fabric_roll fr
       LEFT JOIN trx_grn g ON g.id = fr.grn_id
       LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
       LEFT JOIN mst_warehouse wh ON wh.id = fr.warehouse_id
      WHERE ${where}
      ORDER BY fr.lot_no, fr.roll_no LIMIT 1000`, params);
  res.json({ data: rows, meta: { fabric_id: plan.fabric_id, plan_no: plan.plan_no } });
}));

/**
 * GET /cutting-plans/:id/dc-rolls — DC roll lines issued to this cut order
 * with their remaining KG, for lay execution roll selection.
 */
productionStagesRouter.get('/cutting-plans/:id/dc-rolls', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT fir.id AS fabric_issue_roll_id, fir.fabric_roll_id, fir.roll_no, fir.lot_no, fir.shade, fir.gsm,
            fir.width_cm, fir.issue_kg, fir.consumed_kg, fir.returned_kg, fir.roll_status,
            ROUND(COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg, 4) AS remaining_kg,
            fi.issue_no, fi.issue_date, 'KG' AS uom
       FROM trx_fabric_issue_roll fir
       JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
      WHERE fi.company_id = ? AND fi.cutting_plan_id = ?
      ORDER BY fir.roll_status = 'CLOSED', fir.lot_no, fir.roll_no`, [cid, Number(req.params.id)]);
  res.json({ data: rows });
}));

/** POST /fabric-issues — roll-wise Fabric DC */
productionStagesRouter.post('/fabric-issues', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = fabricIssueSchema.parse(req.body);
  const ids = body.rolls.map((r) => r.fabric_roll_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('The same roll is listed twice on this DC');

  const result = await transaction(async (tx) => {
    const plan = await lockPlan(tx, cid, body.cutting_plan_id);
    assertPlanOpen(plan, 'issue fabric');
    const color = plan.color_id ? await txQueryOne<any>(tx, `SELECT color_name FROM mst_color WHERE id = ?`, [plan.color_id]) : null;

    const lines: any[] = [];
    for (const r of body.rolls) {
      const roll = await txQueryOne<any>(tx,
        `SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ? FOR UPDATE`, [r.fabric_roll_id, cid]);
      if (!roll) throw NotFound(`Fabric roll #${r.fabric_roll_id} not found`);
      if (plan.fabric_id && Number(roll.fabric_id) !== Number(plan.fabric_id)) {
        throw BadRequest(`Roll ${roll.roll_no} is a different fabric from the cut order`);
      }
      if (roll.qc_status !== 'ACCEPTED') throw BadRequest(`Roll ${roll.roll_no} is QC ${roll.qc_status} — only ACCEPTED rolls can be issued`);
      if (roll.stock_status === 'CLOSED') throw BadRequest(`Roll ${roll.roll_no} is CLOSED and cannot be issued`);
      const available = round(num(roll.weight_kg) - num(roll.issued_kg), 4);
      if (available <= KG_EPS) throw BadRequest(`Roll ${roll.roll_no} has no available KG`);
      const issueKg = round(r.issue_kg ?? available, 4);
      if (issueKg > available + KG_EPS) {
        throw BadRequest(`Roll ${roll.roll_no}: issue ${issueKg} KG exceeds available ${available} KG`);
      }
      const issueMtr = r.issue_mtr ?? (num(roll.meters) > 0 && num(roll.weight_kg) > 0
        ? round(num(roll.meters) * issueKg / num(roll.weight_kg), 3) : null);
      const diaIn = parseFloat(String(roll.dia ?? '').replace(/[^0-9.]/g, ''));
      const widthCm = r.width_cm ?? (Number.isFinite(diaIn) && diaIn > 0 ? round(diaIn * 2.54, 2) : null);
      lines.push({ roll, issueKg, issueMtr, widthCm });
    }

    const issueNo = body.issue_no || await nextUniqueDocNo(tx, cid, 'FAB_ISSUE', 'trx_fabric_issue', 'issue_no');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_fabric_issue WHERE company_id = ? AND issue_no = ?`, [cid, issueNo]);
    if (dup) throw BadRequest(`DC number ${issueNo} already exists`);
    const totalKg = round(lines.reduce((a, l) => a + l.issueKg, 0), 4);
    const totalMtr = round(lines.reduce((a, l) => a + num(l.issueMtr), 0), 4);
    const warehouseId = body.warehouse_id ?? lines[0].roll.warehouse_id ?? null;

    const r = await txExecute(tx,
      `INSERT INTO trx_fabric_issue
        (company_id, issue_no, issue_date, io_no, cutting_plan_id, style_id, color_id, fabric_id,
         warehouse_id, from_location, to_location, total_rolls, total_mtr, total_kg, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ISSUED',?,?)`,
      [cid, issueNo, body.issue_date, plan.io_no, plan.id, plan.style_id, plan.color_id,
       plan.fabric_id ?? lines[0].roll.fabric_id, warehouseId, body.from_location ?? null,
       body.to_location ?? plan.cutting_location ?? null, lines.length, totalMtr, totalKg,
       body.remarks ?? null, req.user!.id]);
    const issueId = r.insertId;
    const uomKg = await kgUomId(tx);

    for (const l of lines) {
      await txExecute(tx,
        `INSERT INTO trx_fabric_issue_roll
          (fabric_issue_id, fabric_roll_id, lot_no, roll_no, shade, color_name, issue_mtr, issue_kg, gsm, width_cm, roll_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN')`,
        [issueId, l.roll.id, l.roll.lot_no, l.roll.roll_no, l.roll.shade, color?.color_name ?? null,
         l.issueMtr, l.issueKg, l.roll.gsm, l.widthCm]);
      await txExecute(tx, `UPDATE trx_fabric_roll SET issued_kg = issued_kg + ? WHERE id = ?`, [l.issueKg, l.roll.id]);
      await refreshFabricRollStatus(tx, l.roll.id);
      await txExecute(tx,
        `INSERT INTO trx_stock_ledger
           (company_id, warehouse_id, material_type, fabric_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, created_by)
         VALUES (?,?,'FABRIC',?,'ISSUE','FAB_DC',?,0,?,?,?)`,
        [cid, l.roll.warehouse_id, l.roll.fabric_id, issueId, l.issueKg, uomKg, req.user!.id]);
    }
    return txQueryOne(tx, `SELECT * FROM trx_fabric_issue WHERE id = ?`, [issueId]);
  });

  await audit(req, 'trx_fabric_issue', (result as any).id, 'INSERT', undefined, { ...(result as any), rolls: body.rolls });
  res.status(201).json({ data: result });
}));

/**
 * POST /fabric-issues/:id/returns — return unused fabric from cutting to
 * store. Returned KG goes back onto the roll's available stock.
 */
productionStagesRouter.post('/fabric-issues/:id/returns', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const issueId = Number(req.params.id);
  const body = z.object({
    return_date: dateStr(),
    to_location: s.nullableStr(80),
    rolls: z.array(z.object({
      fabric_issue_roll_id: s.idReq(),
      return_kg: z.coerce.number().positive(),
      return_mtr: z.coerce.number().min(0).optional(),
      reason: s.nullableStr(255),
    })).min(1),
  }).parse(req.body);

  const created = await transaction(async (tx) => {
    const issue = await txQueryOne<any>(tx,
      `SELECT * FROM trx_fabric_issue WHERE id = ? AND company_id = ? FOR UPDATE`, [issueId, cid]);
    if (!issue) throw NotFound('Fabric DC not found');
    if (issue.cutting_plan_id) {
      const plan = await lockPlan(tx, cid, issue.cutting_plan_id);
      assertPlanOpen(plan, 'return fabric');
    }
    const uomKg = await kgUomId(tx);
    const out: any[] = [];
    for (const r of body.rolls) {
      const line = await txQueryOne<any>(tx,
        `SELECT * FROM trx_fabric_issue_roll WHERE id = ? AND fabric_issue_id = ? FOR UPDATE`, [r.fabric_issue_roll_id, issueId]);
      if (!line) throw NotFound(`DC roll line #${r.fabric_issue_roll_id} is not on this DC`);
      if (line.roll_status === 'CLOSED') throw BadRequest(`Roll ${line.roll_no} is CLOSED on this DC`);
      const remaining = round(num(line.issue_kg) - num(line.consumed_kg) - num(line.returned_kg), 4);
      if (r.return_kg > remaining + KG_EPS) {
        throw BadRequest(`Roll ${line.roll_no}: return ${r.return_kg} KG exceeds the ${remaining} KG still with cutting`);
      }
      const returnNo = await nextUniqueDocNo(tx, cid, 'FAB_RETURN', 'trx_fabric_return', 'return_no');
      const ins = await txExecute(tx,
        `INSERT INTO trx_fabric_return
           (company_id, return_no, return_date, fabric_issue_id, fabric_issue_roll_id, fabric_roll_id, cutting_plan_id,
            return_kg, return_mtr, to_location, reason, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, returnNo, body.return_date, issueId, line.id, line.fabric_roll_id, issue.cutting_plan_id,
         r.return_kg, r.return_mtr ?? null, body.to_location ?? issue.from_location ?? null, r.reason ?? null, req.user!.id]);
      await txExecute(tx, `UPDATE trx_fabric_issue_roll SET returned_kg = returned_kg + ? WHERE id = ?`, [r.return_kg, line.id]);
      await refreshDcRollStatus(tx, line.id);
      if (line.fabric_roll_id) {
        const roll = await txQueryOne<any>(tx, `SELECT * FROM trx_fabric_roll WHERE id = ? FOR UPDATE`, [line.fabric_roll_id]);
        await txExecute(tx, `UPDATE trx_fabric_roll SET issued_kg = GREATEST(issued_kg - ?, 0) WHERE id = ?`, [r.return_kg, line.fabric_roll_id]);
        await refreshFabricRollStatus(tx, line.fabric_roll_id);
        await txExecute(tx,
          `INSERT INTO trx_stock_ledger
             (company_id, warehouse_id, material_type, fabric_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, created_by)
           VALUES (?,?,'FABRIC',?,'RETURN','FAB_RETURN',?,?,0,?,?)`,
          [cid, roll.warehouse_id, roll.fabric_id, ins.insertId, r.return_kg, uomKg, req.user!.id]);
      }
      out.push({ id: ins.insertId, return_no: returnNo, roll_no: line.roll_no, return_kg: r.return_kg });
    }
    return out;
  });

  for (const c of created) await audit(req, 'trx_fabric_return', c.id, 'INSERT', undefined, c);
  res.status(201).json({ data: created });
}));

/** GET /fabric-returns */
productionStagesRouter.get('/fabric-returns', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: any[] = [cid];
  let where = 'WHERE rt.company_id = ?';
  if (req.query.cutting_plan_id) { where += ' AND rt.cutting_plan_id = ?'; params.push(Number(req.query.cutting_plan_id)); }
  const rows = await query(
    `SELECT rt.*, fi.issue_no, fir.roll_no, fir.lot_no, cp.plan_no, 'KG' AS uom
       FROM trx_fabric_return rt
       JOIN trx_fabric_issue fi ON fi.id = rt.fabric_issue_id
       JOIN trx_fabric_issue_roll fir ON fir.id = rt.fabric_issue_roll_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = rt.cutting_plan_id
      ${where} ORDER BY rt.id DESC`, params);
  res.json({ data: rows });
}));


// ============================================================
// 2. LAY PLAN & SPREADING — doc §8
//    (execution / approval / reversal live in cuttingExecution.routes.ts)
// ============================================================
const layPlanSchema = z.object({
  lay_no: s.nullableStr(40),
  lay_date: dateStr(),
  cutting_plan_id: s.idReq(),
  marker_version_id: s.id(),
  marker_ref: s.nullableStr(60),
  marker_length_m: s.dec(),
  ply_count: z.coerce.number().int().min(0).default(0),
  planned_kg: z.coerce.number().min(0).optional(),
  fabric_width_cm: z.coerce.number().positive().optional(),
  fabric_roll_id: s.id(),
  shade: s.nullableStr(40),
  table_no: s.nullableStr(40),
  operator_name: s.nullableStr(80),
  planned_cut_qty: z.coerce.number().int().min(0).default(0),
  remarks: s.text(),
});

const LAY_SELECT = `SELECT lp.*,
            cp.plan_no, cp.status AS plan_status,
            st.style_code, st.style_name,
            col.color_name,
            mv.marker_no, mv.version AS marker_version, mv.pieces_per_marker, mv.marker_kg_per_ply,
            mv.cad_kg_per_pc, mv.is_locked AS marker_locked,
            CASE WHEN lp.actual_cut_qty > 0 THEN ROUND(lp.actual_kg / lp.actual_cut_qty, 5) END AS actual_kg_per_pc,
            'KG' AS kg_uom, 'PCS' AS pcs_uom
       FROM trx_lay_plan lp
       LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
       LEFT JOIN mst_style st ON st.id = lp.style_id
       LEFT JOIN mst_color col ON col.id = lp.color_id
       LEFT JOIN trx_marker_version mv ON mv.id = lp.marker_version_id`;

/** GET /lay-plans */
productionStagesRouter.get('/lay-plans', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: any[] = [cid];
  let where = 'WHERE lp.company_id = ?';
  if (req.query.cutting_plan_id) { where += ' AND lp.cutting_plan_id = ?'; params.push(Number(req.query.cutting_plan_id)); }
  if (req.query.status) { where += ' AND lp.status = ?'; params.push(String(req.query.status)); }
  const rows = await query(`${LAY_SELECT} ${where} ORDER BY lp.lay_date DESC, lp.id DESC`, params);
  res.json({ data: rows });
}));

/** GET /lay-plans/:id — lay with spreading, rolls, losses, size-wise output */
productionStagesRouter.get('/lay-plans/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne<any>(`${LAY_SELECT} WHERE lp.id = ? AND lp.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Lay Plan not found');

  const [spreadings, rolls, losses, outputs, markerVersion] = await Promise.all([
    query(`SELECT * FROM trx_spreading WHERE lay_id = ? ORDER BY id DESC`, [id]),
    query(
      `SELECT lr.*, fi.issue_no, 'KG' AS uom FROM trx_lay_roll lr
         LEFT JOIN trx_fabric_issue_roll fir ON fir.id = lr.fabric_issue_roll_id
         LEFT JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
        WHERE lr.lay_id = ? ORDER BY lr.id`, [id]),
    query(`SELECT *, 'KG' AS uom FROM trx_cutting_loss WHERE lay_id = ? ORDER BY id`, [id]),
    query(
      `SELECT co.*, sz.size_code, sz.sort_order, (co.good_qty - co.bundled_qty) AS remaining_qty, 'PCS' AS uom
         FROM trx_cut_output co LEFT JOIN mst_size sz ON sz.id = co.size_id
        WHERE co.lay_id = ? ORDER BY sz.sort_order, co.id`, [id]),
    row.marker_version_id ? queryOne<any>(`SELECT * FROM trx_marker_version WHERE id = ?`, [row.marker_version_id]) : null,
  ]);
  const mv = markerVersion
    ? { ...markerVersion, sizes: parseJson(markerVersion.sizes, []), ratios: parseJson(markerVersion.ratios, []),
        size_consumption: parseJson(markerVersion.size_consumption, null) }
    : null;
  res.json({ data: { ...row, spreadings, rolls, losses, outputs, marker_version: mv } });
}));

/** POST /lay-plans */
productionStagesRouter.post('/lay-plans', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = layPlanSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const plan = await lockPlan(tx, cid, body.cutting_plan_id);
    assertPlanOpen(plan, 'plan lays');

    let mv: any = null;
    if (body.marker_version_id) {
      mv = await txQueryOne<any>(tx, `SELECT * FROM trx_marker_version WHERE id = ? AND company_id = ?`, [body.marker_version_id, cid]);
      if (!mv) throw NotFound('Marker version not found');
      if (mv.style_id && Number(mv.style_id) !== Number(plan.style_id)) {
        throw BadRequest(`Marker ${mv.marker_no} v${mv.version} belongs to a different style`);
      }
      if (mv.fabric_id && plan.fabric_id && Number(mv.fabric_id) !== Number(plan.fabric_id)) {
        throw BadRequest(`Marker ${mv.marker_no} v${mv.version} is for a different fabric`);
      }
    }
    const ppm = mv ? num(mv.pieces_per_marker) : 0;
    const expected = ppm * body.ply_count;
    const plannedKg = body.planned_kg ?? (mv && mv.marker_kg_per_ply != null && (mv.uom ?? 'KG') === 'KG'
      ? round(num(mv.marker_kg_per_ply) * body.ply_count, 4) : null);
    const widthCm = body.fabric_width_cm ?? (mv?.width_in ? round(num(mv.width_in) * 2.54, 2) : null);

    const layNo = body.lay_no || await nextUniqueDocNo(tx, cid, 'LAY_PLAN', 'trx_lay_plan', 'lay_no');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_lay_plan WHERE company_id = ? AND lay_no = ?`, [cid, layNo]);
    if (dup) throw BadRequest(`Lay number ${layNo} already exists`);

    const r = await txExecute(tx,
      `INSERT INTO trx_lay_plan
        (company_id, lay_no, lay_date, io_no, cutting_plan_id, style_id, color_id, marker_ref, marker_version_id,
         marker_length_m, ply_count, expected_pieces, planned_kg, fabric_width_cm, fabric_roll_id, fabric_id, shade,
         table_no, operator_name, planned_cut_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PLANNED',?,?)`,
      [cid, layNo, body.lay_date, plan.io_no, plan.id, plan.style_id, plan.color_id,
       mv ? `${mv.marker_no} v${mv.version}`.slice(0, 60) : (body.marker_ref ?? null), mv?.id ?? null,
       body.marker_length_m ?? mv?.length_m ?? null, body.ply_count, expected, plannedKg, widthCm,
       body.fabric_roll_id ?? null, plan.fabric_id ?? null, body.shade ?? null, body.table_no ?? null,
       body.operator_name ?? null, expected || body.planned_cut_qty, body.remarks ?? null, req.user!.id]);

    return txQueryOne(tx, `SELECT * FROM trx_lay_plan WHERE id = ?`, [r.insertId]);
  });

  await audit(req, 'trx_lay_plan', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));

/** POST /lay-plans/:id/spreading — spreading record (metres); keeps the lay's plan until execution */
productionStagesRouter.post('/lay-plans/:id/spreading', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const layId = Number(req.params.id);

  const body = z.object({
    spreading_no: s.nullableStr(40),
    spreading_date: dateStr(),
    roll_no: s.nullableStr(40),
    start_mtr: s.dec(),
    end_mtr: s.dec(),
    actual_used_mtr: s.dec(),
    ply_count: z.coerce.number().int().min(0).default(0),
    fabric_width_cm: s.dec(),
    gsm: s.dec(),
    shade: s.nullableStr(40),
    operator_name: s.nullableStr(80),
    qc_status: z.enum(['PASS','HOLD','REJECT']).default('PASS'),
    remarks: s.text(),
  }).parse(req.body);
  if (body.start_mtr != null && body.end_mtr != null && body.end_mtr > body.start_mtr) {
    throw BadRequest('End metres cannot exceed start metres');
  }
  if (body.actual_used_mtr != null && body.actual_used_mtr < 0) throw BadRequest('Used metres cannot be negative');

  const result = await transaction(async (tx) => {
    const lay = await txQueryOne<any>(tx, `SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ? FOR UPDATE`, [layId, cid]);
    if (!lay) throw NotFound('Lay Plan not found');
    if (!['PLANNED', 'SPREAD'].includes(lay.status)) throw BadRequest(`Lay ${lay.lay_no} is ${lay.status} — spreading can no longer be recorded`);
    const sprdNo = body.spreading_no || await nextDocNumber(tx, cid, 'SPREADING');
    const used = body.actual_used_mtr ?? (body.start_mtr != null && body.end_mtr != null ? round(body.start_mtr - body.end_mtr, 3) : null);

    const r = await txExecute(tx,
      `INSERT INTO trx_spreading
        (company_id, spreading_no, spreading_date, lay_id, io_no, style_id, roll_no,
         start_mtr, end_mtr, actual_used_mtr, ply_count, fabric_width_cm, gsm, shade,
         operator_name, qc_status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, sprdNo, body.spreading_date, layId, lay.io_no, lay.style_id, body.roll_no ?? null,
       body.start_mtr ?? null, body.end_mtr ?? null, used, body.ply_count,
       body.fabric_width_cm ?? null, body.gsm ?? null, body.shade ?? null, body.operator_name ?? null,
       body.qc_status, body.remarks ?? null, req.user!.id]);

    await txExecute(tx,
      `UPDATE trx_lay_plan SET status = 'SPREAD', started_at = COALESCE(started_at, NOW()) WHERE id = ?`, [layId]);

    return txQueryOne(tx, `SELECT * FROM trx_spreading WHERE id = ?`, [r.insertId]);
  });

  await audit(req, 'trx_spreading', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));


// ============================================================
// 3. CUT PIECE QC
// ============================================================
productionStagesRouter.get('/cut-piece-qc', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT qc.*, c.cut_no, st.style_code, col.color_name, sz.size_code
       FROM trx_cut_piece_qc qc
       LEFT JOIN trx_cutting c ON c.id = qc.cutting_id
       LEFT JOIN mst_style st ON st.id = qc.style_id
       LEFT JOIN mst_color col ON col.id = qc.color_id
       LEFT JOIN mst_size sz ON sz.id = qc.size_id
      WHERE qc.company_id = ?
      ORDER BY qc.qc_date DESC, qc.id DESC`, [cid]);
  res.json({ data: rows });
}));

productionStagesRouter.post('/cut-piece-qc', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    qc_no: s.nullableStr(40),
    qc_date: dateStr(),
    cutting_id: s.idReq(),
    io_no: s.strReq(40),
    style_id: s.idReq(),
    color_id: s.id(),
    size_id: s.id(),
    component: z.string().trim().max(60).default('BODY'),
    cut_qty: z.coerce.number().int().min(0).default(0),
    accepted_qty: z.coerce.number().int().min(0).default(0),
    reject_qty: z.coerce.number().int().min(0).default(0),
    recut_qty: z.coerce.number().int().min(0).default(0),
    reject_reason: s.nullableStr(120),
    qc_status: z.enum(['APPROVED','REJECTED','CONDITIONAL']).default('APPROVED'),
    inspector_name: s.nullableStr(80),
    remarks: s.text(),
  }).parse(req.body);
  if (body.accepted_qty + body.reject_qty > body.cut_qty) {
    throw BadRequest('Accepted + rejected PCS cannot exceed the cut PCS inspected');
  }

  const result = await transaction(async (tx) => {
    const cutting = await txQueryOne(tx, `SELECT id FROM trx_cutting WHERE id = ? AND company_id = ?`, [body.cutting_id, cid]);
    if (!cutting) throw NotFound('Cutting record not found');
    const qcNo = body.qc_no || await nextDocNumber(tx, cid, 'CUT_QC');

    const r = await txExecute(tx,
      `INSERT INTO trx_cut_piece_qc
        (company_id, qc_no, qc_date, cutting_id, io_no, style_id, color_id, size_id, component,
         cut_qty, accepted_qty, reject_qty, recut_qty, reject_reason, qc_status, inspector_name, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, qcNo, body.qc_date, body.cutting_id, body.io_no, body.style_id, body.color_id ?? null,
       body.size_id ?? null, body.component, body.cut_qty, body.accepted_qty, body.reject_qty,
       body.recut_qty, body.reject_reason ?? null, body.qc_status, body.inspector_name ?? null,
       body.remarks ?? null, req.user!.id]);

    return txQueryOne(tx, `SELECT * FROM trx_cut_piece_qc WHERE id = ?`, [r.insertId]);
  });

  await audit(req, 'trx_cut_piece_qc', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));


// ============================================================
// 4. DETAILED BUNDLE GENERATION (legacy screen contract)
//    Routed through the validated generator in cuttingEngine.ts.
// ============================================================
productionStagesRouter.post('/bundles/generate-detailed', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
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
    components: z.array(z.string().trim().max(60)).default(['FRONT', 'BACK', 'SLEEVE_L', 'SLEEVE_R', 'COLLAR', 'CUFF']),
    line_destination: s.nullableStr(40),
  }).parse(req.body);

  const result = await transaction((tx) => generateBundlesLegacy(tx, {
    cid, userId: req.user!.id, bundleSize: body.bundle_size, partName: body.part_name,
    components: body.components, lineDestination: body.line_destination,
    cuttingId: body.cutting_id, sizeId: body.size_id, colorId: body.color_id ?? null, styleId: body.style_id,
    ioNo: body.io_no, skuId: body.sku_id ?? null, totalQty: body.total_qty,
  }));
  await audit(req, 'trx_cutting_bundle', result.bundles[0]?.id ?? 0, 'INSERT', undefined,
    { cutting_id: body.cutting_id, size_id: body.size_id, qty: body.total_qty, bundles: result.bundles.map((b: any) => b.bundle_no) });
  res.status(201).json({ data: { bundles: result.bundles, count: result.bundles.length, allocation: result.basis } });
}));

