import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const productionStagesRouter = Router();

// ============================================================
// 1. FABRIC ISSUE
// ============================================================
const fabricRollSchema = z.object({
  lot_no: s.nullableStr(40),
  roll_no: s.nullableStr(40),
  shade: s.nullableStr(40),
  issue_mtr: s.dec(),
  issue_kg: s.dec(),
  gsm: s.dec(),
  width_cm: s.dec(),
});

const fabricIssueSchema = z.object({
  issue_no: s.nullableStr(40),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cutting_plan_id: s.idReq(),
  warehouse_id: s.id(),
  status: z.enum(['DRAFT','ISSUED','CONFIRMED','RETURNED']).default('ISSUED'),
  remarks: s.text(),
  rolls: z.array(fabricRollSchema).default([]),
});

/** GET /fabric-issues */
productionStagesRouter.get('/fabric-issues', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT fi.*,
            cp.plan_no,
            st.style_code, st.style_name,
            col.color_name,
            fab.fabric_name,
            wh.warehouse_name
       FROM trx_fabric_issue fi
       LEFT JOIN trx_cutting_plan cp ON cp.id = fi.cutting_plan_id
       LEFT JOIN mst_style st ON st.id = fi.style_id
       LEFT JOIN mst_color col ON col.id = fi.color_id
       LEFT JOIN mst_fabric fab ON fab.id = fi.fabric_id
       LEFT JOIN mst_warehouse wh ON wh.id = fi.warehouse_id
      WHERE fi.company_id = ?
      ORDER BY fi.issue_date DESC, fi.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /fabric-issues/:id */
productionStagesRouter.get('/fabric-issues/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(
    `SELECT fi.*,
            cp.plan_no,
            st.style_code, st.style_name,
            col.color_name,
            fab.fabric_name,
            wh.warehouse_name
       FROM trx_fabric_issue fi
       LEFT JOIN trx_cutting_plan cp ON cp.id = fi.cutting_plan_id
       LEFT JOIN mst_style st ON st.id = fi.style_id
       LEFT JOIN mst_color col ON col.id = fi.color_id
       LEFT JOIN mst_fabric fab ON fab.id = fi.fabric_id
       LEFT JOIN mst_warehouse wh ON wh.id = fi.warehouse_id
      WHERE fi.id = ? AND fi.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Fabric issue not found');

  const rolls = await query(
    `SELECT * FROM trx_fabric_issue_roll WHERE fabric_issue_id = ? ORDER BY id`, [id]);
  res.json({ data: { ...(row as any), rolls } });
}));

/** POST /fabric-issues */
productionStagesRouter.post('/fabric-issues', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = fabricIssueSchema.parse(req.body);

  // Inherit I/O, Style, Color, Fabric from Cutting Plan
  const plan = await queryOne<any>(
    `SELECT cp.* FROM trx_cutting_plan cp WHERE cp.id = ? AND cp.company_id = ?`,
    [body.cutting_plan_id, cid]);
  if (!plan) throw NotFound('Cutting Plan not found');

  const totalMtr = body.rolls.reduce((sum, r) => sum + Number(r.issue_mtr || 0), 0);
  const totalKg = body.rolls.reduce((sum, r) => sum + Number(r.issue_kg || 0), 0);

  const result = await transaction(async (tx) => {
    const issueNo = body.issue_no || await nextDocNumber(tx, cid, 'FAB_ISSUE');

    const r = await txExecute(tx,
      `INSERT INTO trx_fabric_issue
        (company_id, issue_no, issue_date, io_no, cutting_plan_id, style_id, color_id, fabric_id,
         warehouse_id, total_rolls, total_mtr, total_kg, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, issueNo, body.issue_date, plan.io_no, body.cutting_plan_id, plan.style_id, plan.color_id,
       plan.fabric_id, body.warehouse_id ?? null, body.rolls.length, totalMtr, totalKg,
       body.status, body.remarks ?? null, req.user!.id]);

    const issueId = r.insertId;
    for (const roll of body.rolls) {
      await txExecute(tx,
        `INSERT INTO trx_fabric_issue_roll
          (fabric_issue_id, lot_no, roll_no, shade, issue_mtr, issue_kg, gsm, width_cm)
         VALUES (?,?,?,?,?,?,?,?)`,
        [issueId, roll.lot_no ?? null, roll.roll_no ?? null, roll.shade ?? null,
         roll.issue_mtr ?? 0, roll.issue_kg ?? 0, roll.gsm ?? null, roll.width_cm ?? null]);
    }
    return txQueryOne(tx, `SELECT * FROM trx_fabric_issue WHERE id = ?`, [issueId]);
  });

  await audit(req, 'trx_fabric_issue', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));


// ============================================================
// 2. LAY PLAN & SPREADING
// ============================================================
const layPlanSchema = z.object({
  lay_no: s.nullableStr(40),
  lay_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cutting_plan_id: s.idReq(),
  marker_ref: s.nullableStr(60),
  marker_length_m: s.dec(),
  ply_count: z.coerce.number().int().min(0).default(0),
  fabric_roll_id: s.id(),
  shade: s.nullableStr(40),
  table_no: s.nullableStr(40),
  planned_cut_qty: z.coerce.number().int().min(0).default(0),
  status: z.enum(['PLANNED','SPREAD','CUT','CANCELLED']).default('PLANNED'),
  remarks: s.text(),
});

/** GET /lay-plans */
productionStagesRouter.get('/lay-plans', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT lp.*,
            cp.plan_no,
            st.style_code, st.style_name,
            col.color_name
       FROM trx_lay_plan lp
       LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
       LEFT JOIN mst_style st ON st.id = lp.style_id
       LEFT JOIN mst_color col ON col.id = lp.color_id
      WHERE lp.company_id = ?
      ORDER BY lp.lay_date DESC, lp.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /lay-plans/:id */
productionStagesRouter.get('/lay-plans/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(
    `SELECT lp.*,
            cp.plan_no,
            st.style_code, st.style_name,
            col.color_name
       FROM trx_lay_plan lp
       LEFT JOIN trx_cutting_plan cp ON cp.id = lp.cutting_plan_id
       LEFT JOIN mst_style st ON st.id = lp.style_id
       LEFT JOIN mst_color col ON col.id = lp.color_id
      WHERE lp.id = ? AND lp.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Lay Plan not found');

  const spreadings = await query(
    `SELECT * FROM trx_spreading WHERE lay_id = ? ORDER BY id DESC`, [id]);
  res.json({ data: { ...(row as any), spreadings } });
}));

/** POST /lay-plans */
productionStagesRouter.post('/lay-plans', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = layPlanSchema.parse(req.body);

  const plan = await queryOne<any>(
    `SELECT * FROM trx_cutting_plan WHERE id = ? AND company_id = ?`, [body.cutting_plan_id, cid]);
  if (!plan) throw NotFound('Cutting Plan not found');

  const result = await transaction(async (tx) => {
    const layNo = body.lay_no || await nextDocNumber(tx, cid, 'LAY_PLAN');

    const r = await txExecute(tx,
      `INSERT INTO trx_lay_plan
        (company_id, lay_no, lay_date, io_no, cutting_plan_id, style_id, color_id, marker_ref,
         marker_length_m, ply_count, fabric_roll_id, shade, table_no, planned_cut_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, layNo, body.lay_date, plan.io_no, body.cutting_plan_id, plan.style_id, plan.color_id,
       body.marker_ref ?? null, body.marker_length_m ?? null, body.ply_count, body.fabric_roll_id ?? null,
       body.shade ?? null, body.table_no ?? null, body.planned_cut_qty, body.status, body.remarks ?? null, req.user!.id]);

    return txQueryOne(tx, `SELECT * FROM trx_lay_plan WHERE id = ?`, [r.insertId]);
  });

  await audit(req, 'trx_lay_plan', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));

/** POST /lay-plans/:id/spreading */
productionStagesRouter.post('/lay-plans/:id/spreading', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const layId = Number(req.params.id);

  const lay = await queryOne<any>(`SELECT * FROM trx_lay_plan WHERE id = ? AND company_id = ?`, [layId, cid]);
  if (!lay) throw NotFound('Lay Plan not found');

  const body = z.object({
    spreading_no: s.nullableStr(40),
    spreading_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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

  const result = await transaction(async (tx) => {
    const sprdNo = body.spreading_no || await nextDocNumber(tx, cid, 'SPREADING');

    const r = await txExecute(tx,
      `INSERT INTO trx_spreading
        (company_id, spreading_no, spreading_date, lay_id, io_no, style_id, roll_no,
         start_mtr, end_mtr, actual_used_mtr, ply_count, fabric_width_cm, gsm, shade,
         operator_name, qc_status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, sprdNo, body.spreading_date, layId, lay.io_no, lay.style_id, body.roll_no ?? null,
       body.start_mtr ?? null, body.end_mtr ?? null, body.actual_used_mtr ?? null, body.ply_count,
       body.fabric_width_cm ?? null, body.gsm ?? null, body.shade ?? null, body.operator_name ?? null,
       body.qc_status, body.remarks ?? null, req.user!.id]);

    // Update lay status to SPREAD
    await txExecute(tx, `UPDATE trx_lay_plan SET status = 'SPREAD' WHERE id = ?`, [layId]);

    return txQueryOne(tx, `SELECT * FROM trx_spreading WHERE id = ?`, [r.insertId]);
  });

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
    qc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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

  const result = await transaction(async (tx) => {
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

  res.status(201).json({ data: result });
}));


// ============================================================
// 4. DETAILED BUNDLE GENERATION & SCAN
// ============================================================
productionStagesRouter.post('/bundles/generate-detailed', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    cutting_id: s.idReq(),
    io_no: s.strReq(40),
    style_id: s.idReq(),
    color_id: s.idReq(),
    size_id: s.idReq(),
    sku_id: s.id(),
    total_qty: z.coerce.number().int().positive(),
    bundle_size: z.coerce.number().int().positive(),
    components: z.array(z.string()).default(['FRONT', 'BACK', 'SLEEVE_L', 'SLEEVE_R', 'COLLAR', 'CUFF']),
    line_destination: s.nullableStr(40),
  }).parse(req.body);

  const [style, color, size] = await Promise.all([
    queryOne<any>(`SELECT style_code FROM mst_style WHERE id = ?`, [body.style_id]),
    queryOne<any>(`SELECT color_name FROM mst_color WHERE id = ?`, [body.color_id]),
    queryOne<any>(`SELECT size_code FROM mst_size WHERE id = ?`, [body.size_id]),
  ]);

  const styleCode = style?.style_code || 'ST';
  const colorName = color?.color_name?.slice(0, 3).toUpperCase() || 'COL';
  const sizeCode = size?.size_code || 'SZ';

  const bundleCount = Math.ceil(body.total_qty / body.bundle_size);
  let remaining = body.total_qty;

  const bundles = await transaction(async (tx) => {
    const created: any[] = [];
    for (let i = 1; i <= bundleCount; i++) {
      const qty = Math.min(body.bundle_size, remaining);
      remaining -= qty;

      const pad = String(i).padStart(3, '0');
      const bundleNo = `${styleCode}-${colorName}-${sizeCode}-B${pad}`;
      const barcode = `${body.io_no}-${bundleNo}`;

      const r = await txExecute(tx,
        `INSERT INTO trx_cutting_bundle
          (cutting_id, io_no, style_id, color_id, size_id, component, sku_id, bundle_no, qty, barcode, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [body.cutting_id, body.io_no, body.style_id, body.color_id, body.size_id,
         body.components.join(','), body.sku_id ?? null, bundleNo, qty, barcode, 'GENERATED']);

      const bundleId = r.insertId;

      // Insert component pieces
      for (const comp of body.components) {
        await txExecute(tx,
          `INSERT INTO trx_cutting_bundle_detail (bundle_id, component, piece_qty) VALUES (?,?,?)`,
          [bundleId, comp, qty]);
      }

      created.push({ id: bundleId, bundle_no: bundleNo, barcode, qty, status: 'GENERATED' });
    }
    return created;
  });

  res.status(201).json({ data: { bundles, count: bundles.length } });
}));

/** Scan bundle barcode or bundle number */
productionStagesRouter.get('/bundles/scan/:code', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const code = req.params.code;
  const bundle = await queryOne(
    `SELECT cb.*, c.cut_no, st.style_code, st.style_name, col.color_name, sz.size_code
       FROM trx_cutting_bundle cb
       JOIN trx_cutting c ON c.id = cb.cutting_id
       LEFT JOIN mst_style st ON st.id = cb.style_id
       LEFT JOIN mst_color col ON col.id = cb.color_id
       LEFT JOIN mst_size sz ON sz.id = cb.size_id
      WHERE cb.barcode = ? OR cb.bundle_no = ?`, [code, code]);
  if (!bundle) throw NotFound('Bundle barcode not recognized');

  const details = await query(
    `SELECT * FROM trx_cutting_bundle_detail WHERE bundle_id = ?`, [(bundle as any).id]);
  const history = await query(
    `SELECT bm.*, u.full_name AS moved_by_name
       FROM trx_bundle_movement bm
       LEFT JOIN mst_user u ON u.id = bm.moved_by
      WHERE bm.bundle_id = ? ORDER BY bm.moved_at`, [(bundle as any).id]);

  res.json({ data: { ...(bundle as any), components: details, history } });
}));


// ============================================================
// 5. SEWING INPUT & OUTPUT
// ============================================================
productionStagesRouter.get('/sewing/inputs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT si.*, cb.bundle_no, st.style_code, col.color_name, sz.size_code
       FROM trx_sewing_input si
       JOIN trx_cutting_bundle cb ON cb.id = si.bundle_id
       LEFT JOIN mst_style st ON st.id = si.style_id
       LEFT JOIN mst_color col ON col.id = si.color_id
       LEFT JOIN mst_size sz ON sz.id = si.size_id
      WHERE si.company_id = ?
      ORDER BY si.input_date DESC, si.id DESC`, [cid]);
  res.json({ data: rows });
}));

productionStagesRouter.post('/sewing/input', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    input_no: s.nullableStr(40),
    input_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    bundle_id: s.idReq(),
    line_name: z.string().trim().max(60),
    operator_name: s.nullableStr(80),
    remarks: s.text(),
  }).parse(req.body);

  const bundle = await queryOne<any>(
    `SELECT * FROM trx_cutting_bundle WHERE id = ?`, [body.bundle_id]);
  if (!bundle) throw NotFound('Bundle not found');

  const result = await transaction(async (tx) => {
    const inputNo = body.input_no || await nextDocNumber(tx, cid, 'SEW_IN');

    const r = await txExecute(tx,
      `INSERT INTO trx_sewing_input
        (company_id, input_no, input_date, io_no, style_id, color_id, size_id, bundle_id,
         line_name, operator_name, input_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, inputNo, body.input_date, bundle.io_no, bundle.style_id, bundle.color_id, bundle.size_id,
       body.bundle_id, body.line_name, body.operator_name ?? null, bundle.qty, 'OPEN', body.remarks ?? null, req.user!.id]);

    // Update bundle to IN_SEWING
    await txExecute(tx, `UPDATE trx_cutting_bundle SET status = 'IN_SEWING' WHERE id = ?`, [body.bundle_id]);

    await txExecute(tx,
      `INSERT INTO trx_bundle_movement (company_id, bundle_id, io_no, style_id, from_stage, to_stage, moved_qty, moved_by, destination)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [cid, body.bundle_id, bundle.io_no, bundle.style_id, bundle.status, 'IN_SEWING', bundle.qty, req.user!.id, body.line_name]);

    return txQueryOne(tx, `SELECT * FROM trx_sewing_input WHERE id = ?`, [r.insertId]);
  });

  res.status(201).json({ data: result });
}));

productionStagesRouter.post('/sewing/output', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    output_no: s.nullableStr(40),
    output_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sewing_input_id: s.idReq(),
    output_qty: z.coerce.number().int().min(0),
    reject_qty: z.coerce.number().int().min(0).default(0),
    rework_qty: z.coerce.number().int().min(0).default(0),
    remarks: s.text(),
  }).parse(req.body);

  const input = await queryOne<any>(
    `SELECT * FROM trx_sewing_input WHERE id = ? AND company_id = ?`, [body.sewing_input_id, cid]);
  if (!input) throw NotFound('Sewing Input not found');

  const result = await transaction(async (tx) => {
    const outNo = body.output_no || await nextDocNumber(tx, cid, 'SEW_OUT');

    const r = await txExecute(tx,
      `INSERT INTO trx_sewing_output
        (company_id, output_no, output_date, sewing_input_id, io_no, style_id, color_id, size_id,
         bundle_id, line_name, output_qty, reject_qty, rework_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, outNo, body.output_date, body.sewing_input_id, input.io_no, input.style_id, input.color_id,
       input.size_id, input.bundle_id, input.line_name, body.output_qty, body.reject_qty,
       body.rework_qty, 'COMPLETED', body.remarks ?? null, req.user!.id]);

    await txExecute(tx, `UPDATE trx_sewing_input SET status = 'COMPLETED' WHERE id = ?`, [body.sewing_input_id]);
    if (input.bundle_id) {
      await txExecute(tx, `UPDATE trx_cutting_bundle SET status = 'COMPLETED' WHERE id = ?`, [input.bundle_id]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_sewing_output WHERE id = ?`, [r.insertId]);
  });

  res.status(201).json({ data: result });
}));


// ============================================================
// 6. FINISHING & FINAL QC
// ============================================================
productionStagesRouter.post('/finishing/input', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    input_no: s.nullableStr(40),
    input_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sewing_output_id: s.idReq(),
    input_qty: z.coerce.number().int().positive(),
    remarks: s.text(),
  }).parse(req.body);

  const sewOut = await queryOne<any>(
    `SELECT * FROM trx_sewing_output WHERE id = ? AND company_id = ?`, [body.sewing_output_id, cid]);
  if (!sewOut) throw NotFound('Sewing Output not found');

  const result = await transaction(async (tx) => {
    const finNo = body.input_no || await nextDocNumber(tx, cid, 'FIN_IN');

    const r = await txExecute(tx,
      `INSERT INTO trx_finishing_input
        (company_id, input_no, input_date, io_no, style_id, color_id, size_id,
         sewing_output_id, input_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, finNo, body.input_date, sewOut.io_no, sewOut.style_id, sewOut.color_id, sewOut.size_id,
       body.sewing_output_id, body.input_qty, 'OPEN', body.remarks ?? null, req.user!.id]);

    return txQueryOne(tx, `SELECT * FROM trx_finishing_input WHERE id = ?`, [r.insertId]);
  });

  res.status(201).json({ data: result });
}));

productionStagesRouter.post('/finishing/output', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    output_no: s.nullableStr(40),
    output_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    finishing_input_id: s.idReq(),
    output_qty: z.coerce.number().int().min(0),
    reject_qty: z.coerce.number().int().min(0).default(0),
    rework_qty: z.coerce.number().int().min(0).default(0),
    remarks: s.text(),
  }).parse(req.body);

  const finIn = await queryOne<any>(
    `SELECT * FROM trx_finishing_input WHERE id = ? AND company_id = ?`, [body.finishing_input_id, cid]);
  if (!finIn) throw NotFound('Finishing Input not found');

  const result = await transaction(async (tx) => {
    const outNo = body.output_no || await nextDocNumber(tx, cid, 'FIN_OUT');

    const r = await txExecute(tx,
      `INSERT INTO trx_finishing_output
        (company_id, output_no, output_date, finishing_input_id, io_no, style_id, color_id, size_id,
         output_qty, reject_qty, rework_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, outNo, body.output_date, body.finishing_input_id, finIn.io_no, finIn.style_id,
       finIn.color_id, finIn.size_id, body.output_qty, body.reject_qty, body.rework_qty,
       'COMPLETED', body.remarks ?? null, req.user!.id]);

    await txExecute(tx, `UPDATE trx_finishing_input SET status = 'COMPLETED' WHERE id = ?`, [body.finishing_input_id]);

    return txQueryOne(tx, `SELECT * FROM trx_finishing_output WHERE id = ?`, [r.insertId]);
  });

  res.status(201).json({ data: result });
}));

productionStagesRouter.post('/final-qc', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    qc_no: s.nullableStr(40),
    qc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    finishing_output_id: s.idReq(),
    inspected_qty: z.coerce.number().int().positive(),
    passed_qty: z.coerce.number().int().min(0),
    reject_qty: z.coerce.number().int().min(0).default(0),
    rework_qty: z.coerce.number().int().min(0).default(0),
    qc_status: z.enum(['PASS','HOLD','REJECT']).default('PASS'),
    inspector_name: s.nullableStr(80),
    remarks: s.text(),
  }).parse(req.body);

  const finOut = await queryOne<any>(
    `SELECT * FROM trx_finishing_output WHERE id = ? AND company_id = ?`, [body.finishing_output_id, cid]);
  if (!finOut) throw NotFound('Finishing Output not found');

  const result = await transaction(async (tx) => {
    const qcNo = body.qc_no || await nextDocNumber(tx, cid, 'FINAL_QC');

    const r = await txExecute(tx,
      `INSERT INTO trx_final_qc
        (company_id, qc_no, qc_date, finishing_output_id, io_no, style_id, color_id, size_id,
         inspected_qty, passed_qty, reject_qty, rework_qty, qc_status, inspector_name, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, qcNo, body.qc_date, body.finishing_output_id, finOut.io_no, finOut.style_id,
       finOut.color_id, finOut.size_id, body.inspected_qty, body.passed_qty, body.reject_qty,
       body.rework_qty, body.qc_status, body.inspector_name ?? null, body.remarks ?? null, req.user!.id]);

    return txQueryOne(tx, `SELECT * FROM trx_final_qc WHERE id = ?`, [r.insertId]);
  });

  res.status(201).json({ data: result });
}));
