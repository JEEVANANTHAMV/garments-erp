import { Router } from 'express';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';

/**
 * Traceability (doc §27) and process reports (doc §28).
 */
export const processReportsRouter = Router();

/**
 * End-to-end traceability for a yarn.
 *
 * Walks the chain the document describes: yarn -> process (dyeing / winding /
 * twisting) -> issues and receipts -> cones -> knitting programs -> rolls, and
 * for collars yarn -> collar program -> production.
 */
processReportsRouter.get('/process-traceability/:yarnId', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const yarnId = Number(req.params.yarnId);

  const yarn = await queryOne(
    `SELECT id, yarn_code, yarn_name, count_value FROM mst_yarn WHERE id = ?`, [yarnId]);
  if (!yarn) throw NotFound('Yarn not found');

  const processes = await query(
    `SELECT yp.id, yp.process_no, yp.process_type, yp.process_date, yp.status,
            yp.input_qty_kg, yp.expected_output, yp.io_no, yp.buyer_po_no, yp.part_name
       FROM trx_yarn_process yp
      WHERE yp.company_id = ? AND yp.yarn_id = ?
      ORDER BY yp.id`, [cid, yarnId]);

  for (const p of processes as any[]) {
    p.issues = await query(
      `SELECT id, issue_no, issue_date, lot_no, yarn_po_no, issued_qty_kg
         FROM trx_process_issue
        WHERE src_type = 'YARN_PROCESS' AND src_id = ?`, [p.id]);
    p.receipts = await query(
      `SELECT id, receipt_no, output_qty, loss_qty, rejected_qty, output_lot_no, qc_status
         FROM trx_process_receipt
        WHERE src_type = 'YARN_PROCESS' AND src_id = ?`, [p.id]);
    for (const rc of p.receipts as any[]) {
      rc.cones = await query(
        `SELECT cone_no, source_lot_no, weight_kg, status FROM trx_winding_cone
          WHERE receipt_id = ?`, [rc.id]);
    }
  }

  const knittingPrograms = await query(
    `SELECT DISTINCT kp.id, kp.program_no, kp.program_date, kp.status, kp.part_name,
            kp.knitting_type, kp.required_qty_kg
       FROM trx_knitting_program kp
       JOIN trx_knitting_program_yarns kpy ON kpy.program_id = kp.id
      WHERE kp.company_id = ? AND kpy.yarn_id = ?`, [cid, yarnId]);

  for (const kp of knittingPrograms as any[]) {
    kp.rolls = await query(
      `SELECT roll_no, net_weight_kg, meters, actual_gsm, qc_status
         FROM trx_knitting_roll WHERE program_id = ?`, [kp.id]);
  }

  const collarPrograms = await query(
    `SELECT cp.id, cp.program_no, cp.program_date, cp.status, cp.expected_pcs,
            cp.planned_yarn_kg,
            COALESCE((SELECT SUM(pr.produced_pcs) FROM trx_collar_production pr
                       WHERE pr.program_id = cp.id),0) AS produced_pcs,
            COALESCE((SELECT SUM(pr.actual_yarn_kg) FROM trx_collar_production pr
                       WHERE pr.program_id = cp.id),0) AS actual_yarn_kg
       FROM trx_collar_program cp
      WHERE cp.company_id = ? AND cp.yarn_id = ?`, [cid, yarnId]);

  res.json({
    success: true,
    data: { yarn, processes, knitting_programs: knittingPrograms, collar_programs: collarPrograms },
  });
}));

/** Process register — every process with its progress (doc §28). */
processReportsRouter.get('/reports/process-register', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { process_type, status, from_date, to_date } = req.query;
  let where = 'WHERE yp.company_id = ?';
  const params: any[] = [cid];
  if (process_type) { where += ' AND yp.process_type = ?'; params.push(process_type); }
  if (status) { where += ' AND yp.status = ?'; params.push(status); }
  if (from_date) { where += ' AND yp.process_date >= ?'; params.push(from_date); }
  if (to_date) { where += ' AND yp.process_date <= ?'; params.push(to_date); }

  const rows = await query(
    `SELECT yp.process_no, yp.process_type, yp.process_date, yp.status,
            y.yarn_code, y.yarn_name, yp.input_qty_kg, yp.expected_output,
            COALESCE(SUM(DISTINCT i.issued_qty_kg), 0) AS issued_kg,
            COALESCE((SELECT SUM(rc.output_qty) FROM trx_process_receipt rc
                       WHERE rc.src_type='YARN_PROCESS' AND rc.src_id=yp.id), 0) AS output_qty,
            COALESCE((SELECT SUM(rc.loss_qty) FROM trx_process_receipt rc
                       WHERE rc.src_type='YARN_PROCESS' AND rc.src_id=yp.id), 0) AS loss_qty
       FROM trx_yarn_process yp
       LEFT JOIN mst_yarn y ON y.id = yp.yarn_id
       LEFT JOIN trx_process_issue i ON i.src_type='YARN_PROCESS' AND i.src_id=yp.id
       ${where}
      GROUP BY yp.id
      ORDER BY yp.process_date DESC, yp.id DESC`, params);
  res.json({ success: true, data: rows });
}));

/** Yarn requirement vs available stock, and shortage (doc §28). */
processReportsRouter.get('/reports/yarn-shortage', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT y.id AS yarn_id, y.yarn_code, y.yarn_name,
            COALESCE(r.required_kg, 0)  AS required_kg,
            COALESCE(r.reserved_kg, 0)  AS reserved_kg,
            COALESCE(l.on_hand_kg, 0)   AS on_hand_kg,
            COALESCE(l.on_hand_kg, 0) - COALESCE(r.reserved_kg, 0) AS available_kg,
            GREATEST(0, COALESCE(r.required_kg, 0)
                        - (COALESCE(l.on_hand_kg, 0) - COALESCE(r.reserved_kg, 0))) AS shortage_kg
       FROM mst_yarn y
       LEFT JOIN (
         SELECT yarn_id,
                SUM(required_qty_kg) AS required_kg,
                SUM(reserved_qty_kg - released_qty_kg) AS reserved_kg
           FROM trx_process_reservation
          WHERE company_id = ? AND status IN ('ACTIVE','PARTIAL')
          GROUP BY yarn_id
       ) r ON r.yarn_id = y.id
       LEFT JOIN (
         SELECT yarn_id, SUM(qty_in) - SUM(qty_out) AS on_hand_kg
           FROM trx_stock_ledger WHERE company_id = ? AND yarn_id IS NOT NULL
          GROUP BY yarn_id
       ) l ON l.yarn_id = y.id
      WHERE y.company_id = ? AND y.is_active = 1 AND y.is_deleted = 0
        AND (r.required_kg > 0 OR l.on_hand_kg <> 0)
      ORDER BY shortage_kg DESC, y.yarn_code`, [cid, cid, cid]);
  res.json({ success: true, data: rows });
}));

/** Process wastage and rejection (doc §28). */
processReportsRouter.get('/reports/process-wastage', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT yp.process_type,
            COUNT(DISTINCT yp.id) AS process_count,
            COALESCE(SUM(rc.input_qty), 0)    AS total_input,
            COALESCE(SUM(rc.output_qty), 0)   AS total_output,
            COALESCE(SUM(rc.loss_qty), 0)     AS total_loss,
            COALESCE(SUM(rc.rejected_qty), 0) AS total_rejected,
            CASE WHEN SUM(rc.input_qty) > 0
                 THEN ROUND(SUM(rc.loss_qty) / SUM(rc.input_qty) * 100, 3)
                 ELSE 0 END AS loss_pct
       FROM trx_yarn_process yp
       JOIN trx_process_receipt rc ON rc.src_type='YARN_PROCESS' AND rc.src_id=yp.id
      WHERE yp.company_id = ?
      GROUP BY yp.process_type`, [cid]);
  res.json({ success: true, data: rows });
}));

/**
 * Collar KG-to-PCS consumption variance (doc §28).
 * Compares the standard weight used for planning against the weight actually
 * achieved, which is what the dual-UOM rule in §17 exists to expose.
 */
processReportsRouter.get('/reports/collar-variance', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT cp.id, cp.program_no, cp.program_date, cp.status,
            st.style_code, y.yarn_code,
            cp.expected_pcs, cp.planned_yarn_kg,
            COALESCE(SUM(pr.produced_pcs), 0)   AS produced_pcs,
            COALESCE(SUM(pr.good_pcs), 0)       AS good_pcs,
            COALESCE(SUM(pr.actual_yarn_kg), 0) AS actual_yarn_kg,
            CASE WHEN cp.expected_pcs > 0
                 THEN ROUND(cp.planned_yarn_kg * 1000 / cp.expected_pcs, 3) END AS std_gm_pc,
            CASE WHEN SUM(pr.produced_pcs) > 0
                 THEN ROUND(SUM(pr.actual_yarn_kg) * 1000 / SUM(pr.produced_pcs), 3) END AS actual_gm_pc,
            ROUND(COALESCE(SUM(pr.actual_yarn_kg),0) - cp.planned_yarn_kg, 3) AS yarn_variance_kg
       FROM trx_collar_program cp
       LEFT JOIN trx_collar_production pr ON pr.program_id = cp.id
       LEFT JOIN mst_style st ON st.id = cp.style_id
       LEFT JOIN mst_yarn y ON y.id = cp.yarn_id
      WHERE cp.company_id = ?
      GROUP BY cp.id
      ORDER BY cp.id DESC`, [cid]);
  res.json({ success: true, data: rows });
}));

/** Knitting program vs actual production (doc §28). */
processReportsRouter.get('/reports/knitting-vs-production', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT kp.id, kp.program_no, kp.program_date, kp.status, kp.part_name,
            kp.knitting_type, kp.required_qty_kg,
            COALESCE((SELECT SUM(p.production_qty_kg) FROM trx_knitting_production p
                       WHERE p.program_id = kp.id), 0) AS produced_kg,
            COALESCE((SELECT SUM(p.wastage_kg) FROM trx_knitting_production p
                       WHERE p.program_id = kp.id), 0) AS wastage_kg,
            COALESCE((SELECT SUM(r.net_weight_kg) FROM trx_knitting_roll r
                       WHERE r.program_id = kp.id), 0) AS roll_net_kg,
            COALESCE((SELECT COUNT(*) FROM trx_knitting_roll r
                       WHERE r.program_id = kp.id), 0) AS roll_count
       FROM trx_knitting_program kp
      WHERE kp.company_id = ?
      ORDER BY kp.id DESC`, [cid]);
  res.json({ success: true, data: rows });
}));

/** Lot-wise yarn traceability (doc §28). */
processReportsRouter.get('/reports/lot-traceability', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { lot_no } = req.query;
  let where = `WHERE i.company_id = ?`;
  const params: any[] = [cid];
  if (lot_no) { where += ' AND i.lot_no LIKE ?'; params.push(`%${lot_no}%`); }
  const rows = await query(
    `SELECT i.lot_no, i.yarn_po_no, i.issue_no, i.issue_date, i.issued_qty_kg,
            i.src_type, i.src_id, y.yarn_code, y.yarn_name
       FROM trx_process_issue i
       LEFT JOIN mst_yarn y ON y.id = i.yarn_id
       ${where}
      ORDER BY i.lot_no, i.id DESC LIMIT 1000`, params);
  res.json({ success: true, data: rows });
}));

export default processReportsRouter;
