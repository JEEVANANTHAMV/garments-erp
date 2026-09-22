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


/* ================================================================
   Remaining doc §28 reports
   (Machine Utilization and Stripe/Feeder Allocation are intentionally
    absent — machine and feeder planning are out of scope per the
    business instruction that also excluded the dye recipe master.)
================================================================ */

/** Yarn Requirement vs Available Stock (doc §28). */
processReportsRouter.get('/reports/yarn-requirement-vs-stock', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT y.id AS yarn_id, y.yarn_code, y.yarn_name, y.count_value,
            COALESCE(req.required_kg, 0) AS required_kg,
            COALESCE(stk.on_hand_kg, 0)  AS on_hand_kg,
            ROUND(COALESCE(stk.on_hand_kg,0) - COALESCE(req.required_kg,0), 3) AS balance_kg,
            CASE WHEN COALESCE(stk.on_hand_kg,0) >= COALESCE(req.required_kg,0)
                 THEN 'SUFFICIENT' ELSE 'SHORT' END AS stock_status
       FROM mst_yarn y
       LEFT JOIN (
         -- everything currently demanding this yarn, across all three documents
         SELECT yarn_id, SUM(qty) AS required_kg FROM (
           SELECT yarn_id, input_qty_kg AS qty FROM trx_yarn_process
            WHERE company_id = ? AND status NOT IN ('COMPLETED','CANCELLED')
           UNION ALL
           SELECT kpy.yarn_id, kpy.planned_qty_kg FROM trx_knitting_program_yarns kpy
             JOIN trx_knitting_program kp ON kp.id = kpy.program_id
            WHERE kp.company_id = ? AND kp.status NOT IN ('COMPLETED','CANCELLED')
           UNION ALL
           SELECT yarn_id, planned_yarn_kg FROM trx_collar_program
            WHERE company_id = ? AND status NOT IN ('COMPLETED','CANCELLED')
         ) d WHERE yarn_id IS NOT NULL GROUP BY yarn_id
       ) req ON req.yarn_id = y.id
       LEFT JOIN (
         SELECT yarn_id, SUM(qty_in) - SUM(qty_out) AS on_hand_kg
           FROM trx_stock_ledger WHERE company_id = ? AND yarn_id IS NOT NULL
          GROUP BY yarn_id
       ) stk ON stk.yarn_id = y.id
      WHERE y.company_id = ? AND y.is_active = 1 AND y.is_deleted = 0
        AND (req.required_kg > 0 OR stk.on_hand_kg <> 0)
      ORDER BY balance_kg ASC, y.yarn_code`,
    [cid, cid, cid, cid, cid]);
  res.json({ success: true, data: rows });
}));

/** Yarn Reservation register (doc §28). */
processReportsRouter.get('/reports/yarn-reservations', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { src_type, status } = req.query;
  let where = 'WHERE r.company_id = ?';
  const params: any[] = [cid];
  if (src_type) { where += ' AND r.src_type = ?'; params.push(src_type); }
  if (status) { where += ' AND r.status = ?'; params.push(status); }
  const rows = await query(
    `SELECT r.*, y.yarn_code, y.yarn_name,
            ROUND(r.reserved_qty_kg - r.released_qty_kg, 3) AS outstanding_kg,
            COALESCE(yp.process_no, kp.program_no, cp.program_no) AS source_no,
            COALESCE(yp.status, kp.status, cp.status) AS source_status
       FROM trx_process_reservation r
       LEFT JOIN mst_yarn y ON y.id = r.yarn_id
       LEFT JOIN trx_yarn_process yp    ON r.src_type='YARN_PROCESS'     AND yp.id = r.src_id
       LEFT JOIN trx_knitting_program kp ON r.src_type='KNITTING_PROGRAM' AND kp.id = r.src_id
       LEFT JOIN trx_collar_program cp   ON r.src_type='COLLAR_PROGRAM'   AND cp.id = r.src_id
       ${where}
      ORDER BY r.id DESC LIMIT 1000`, params);
  res.json({ success: true, data: rows });
}));

/** Yarn Dyeing Batch report (doc §28). */
processReportsRouter.get('/reports/dyeing-batch', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { from_date, to_date } = req.query;
  let where = `WHERE yp.company_id = ? AND yp.process_type = 'YARN_DYEING'`;
  const params: any[] = [cid];
  if (from_date) { where += ' AND yp.process_date >= ?'; params.push(from_date); }
  if (to_date) { where += ' AND yp.process_date <= ?'; params.push(to_date); }
  const rows = await query(
    `SELECT yp.process_no, yp.process_date, yp.status,
            y.yarn_code, y.yarn_name,
            d.batch_no, d.colour_name, d.shade_code, d.temperature,
            d.duration_min, d.liquor_ratio,
            yp.input_qty_kg, yp.expected_output,
            COALESCE(SUM(rc.output_qty), 0)   AS actual_output,
            COALESCE(SUM(rc.loss_qty), 0)     AS loss_qty,
            COALESCE(SUM(rc.rejected_qty), 0) AS rejected_qty,
            GROUP_CONCAT(DISTINCT rc.output_lot_no) AS output_lots,
            GROUP_CONCAT(DISTINCT rc.qc_status)     AS qc_status
       FROM trx_yarn_process yp
       LEFT JOIN trx_yarn_process_dyeing d ON d.process_id = yp.id
       LEFT JOIN mst_yarn y ON y.id = yp.yarn_id
       LEFT JOIN trx_process_receipt rc ON rc.src_type='YARN_PROCESS' AND rc.src_id = yp.id
       ${where}
      GROUP BY yp.id
      ORDER BY yp.process_date DESC, yp.id DESC`, params);
  res.json({ success: true, data: rows });
}));

/** Winding Cone Production report (doc §28). */
processReportsRouter.get('/reports/winding-cones', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT yp.process_no, yp.process_date, yp.status,
            y.yarn_code, y.yarn_name,
            w.cone_type, w.target_cone_wt_kg, w.target_cone_count,
            w.operator, w.shift,
            yp.input_qty_kg,
            COALESCE(SUM(rc.output_qty), 0) AS output_kg,
            COALESCE(SUM(rc.loss_qty), 0)   AS wastage_kg,
            COALESCE((SELECT COUNT(*) FROM trx_winding_cone c
                       WHERE c.process_id = yp.id AND c.status = 'GOOD'), 0) AS good_cones,
            COALESCE((SELECT COUNT(*) FROM trx_winding_cone c
                       WHERE c.process_id = yp.id AND c.status = 'REJECTED'), 0) AS rejected_cones
       FROM trx_yarn_process yp
       LEFT JOIN trx_yarn_process_winding w ON w.process_id = yp.id
       LEFT JOIN mst_yarn y ON y.id = yp.yarn_id
       LEFT JOIN trx_process_receipt rc ON rc.src_type='YARN_PROCESS' AND rc.src_id = yp.id
      WHERE yp.company_id = ? AND yp.process_type = 'WINDING'
      GROUP BY yp.id
      ORDER BY yp.process_date DESC, yp.id DESC`, [cid]);
  res.json({ success: true, data: rows });
}));

/** Twisting Production report (doc §28). */
processReportsRouter.get('/reports/twisting-production', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT yp.process_no, yp.process_date, yp.status,
            y.yarn_code, y.yarn_name,
            t.twist_type, t.ply, t.target_count, t.tpi, t.spindle_speed, t.operator, t.shift,
            yp.input_qty_kg, yp.expected_output,
            COALESCE(SUM(rc.output_qty), 0) AS actual_output,
            COALESCE(SUM(rc.loss_qty), 0)   AS loss_qty,
            GROUP_CONCAT(DISTINCT rc.output_lot_no) AS output_lots
       FROM trx_yarn_process yp
       LEFT JOIN trx_yarn_process_twisting t ON t.process_id = yp.id
       LEFT JOIN mst_yarn y ON y.id = yp.yarn_id
       LEFT JOIN trx_process_receipt rc ON rc.src_type='YARN_PROCESS' AND rc.src_id = yp.id
      WHERE yp.company_id = ? AND yp.process_type = 'TWISTING'
      GROUP BY yp.id
      ORDER BY yp.process_date DESC, yp.id DESC`, [cid]);
  res.json({ success: true, data: rows });
}));

/**
 * Yarn Consumption Variance (doc §28).
 * Planned yarn per knitting program against what was actually issued and
 * actually consumed on the production entries.
 */
processReportsRouter.get('/reports/yarn-consumption-variance', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT kp.id, kp.program_no, kp.program_date, kp.status, kp.part_name,
            kp.knitting_type, kp.required_qty_kg,
            COALESCE((SELECT SUM(kpy.planned_qty_kg) FROM trx_knitting_program_yarns kpy
                       WHERE kpy.program_id = kp.id), 0) AS planned_yarn_kg,
            COALESCE((SELECT SUM(i.issued_qty_kg) FROM trx_process_issue i
                       WHERE i.src_type='KNITTING_PROGRAM' AND i.src_id = kp.id), 0)
              + COALESCE((SELECT SUM(ki.issued_qty_kg) FROM trx_knitting_program_yarn_issues ki
                           WHERE ki.program_id = kp.id), 0) AS issued_yarn_kg,
            COALESCE((SELECT SUM(py.used_qty_kg)
                        FROM trx_knitting_production_yarn py
                        JOIN trx_knitting_production p ON p.id = py.production_id
                       WHERE p.program_id = kp.id), 0) AS consumed_yarn_kg,
            COALESCE((SELECT SUM(p.production_qty_kg) FROM trx_knitting_production p
                       WHERE p.program_id = kp.id), 0) AS produced_fabric_kg
       FROM trx_knitting_program kp
      WHERE kp.company_id = ?
      ORDER BY kp.id DESC`, [cid]);

  // Variance is derived here so the SQL stays readable and the maths is explicit.
  const data = (rows as any[]).map((r) => {
    const planned = Number(r.planned_yarn_kg);
    const consumed = Number(r.consumed_yarn_kg);
    return {
      ...r,
      variance_kg: Math.round((consumed - planned) * 1000) / 1000,
      variance_pct: planned > 0 ? Math.round(((consumed - planned) / planned) * 100 * 1000) / 1000 : null,
    };
  });
  res.json({ success: true, data });
}));

/** Fabric Roll Production report (doc §28). */
processReportsRouter.get('/reports/fabric-roll-production', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { program_id, qc_status } = req.query;
  let where = 'WHERE r.company_id = ?';
  const params: any[] = [cid];
  if (program_id) { where += ' AND r.program_id = ?'; params.push(program_id); }
  if (qc_status) { where += ' AND r.qc_status = ?'; params.push(qc_status); }
  const rows = await query(
    `SELECT r.roll_no, r.receipt_date, r.gross_weight_kg, r.tare_kg, r.net_weight_kg,
            r.meters, r.actual_gsm, r.actual_dia, r.qc_status, r.is_stock_posted,
            kp.program_no, kp.part_name, kp.knitting_type,
            f.fabric_code, f.fabric_name, w.warehouse_name
       FROM trx_knitting_roll r
       LEFT JOIN trx_knitting_program kp ON kp.id = r.program_id
       LEFT JOIN mst_fabric f ON f.id = kp.fabric_id
       LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id
       ${where}
      ORDER BY r.receipt_date DESC, r.id DESC LIMIT 1000`, params);
  res.json({ success: true, data: rows });
}));

/** Collar Size-wise Planned vs Produced (doc §28). */
processReportsRouter.get('/reports/collar-size-wise', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { program_id } = req.query;
  let where = 'WHERE cp.company_id = ?';
  const params: any[] = [cid];
  if (program_id) { where += ' AND cp.id = ?'; params.push(program_id); }
  const rows = await query(
    `SELECT cp.program_no, cp.program_date, cp.status, st.style_code,
            s.size_code, s.std_weight_gm, s.planned_pcs, s.std_yarn_kg, s.produced_pcs,
            (s.produced_pcs - s.planned_pcs) AS pcs_variance,
            CASE WHEN s.planned_pcs > 0
                 THEN ROUND(s.produced_pcs / s.planned_pcs * 100, 2) END AS achieved_pct
       FROM trx_collar_program_size s
       JOIN trx_collar_program cp ON cp.id = s.program_id
       LEFT JOIN mst_style st ON st.id = cp.style_id
       ${where}
      ORDER BY cp.id DESC, s.id`, params);
  res.json({ success: true, data: rows });
}));

/** Job Work Pending / Return report (doc §28). */
processReportsRouter.get('/reports/job-work-pending', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT src_type, doc_no, doc_date, status, vendor_name, required_date,
            sent_qty, received_qty, ROUND(sent_qty - received_qty, 3) AS pending_qty
       FROM (
         SELECT 'YARN_PROCESS' AS src_type, yp.process_no AS doc_no, yp.process_date AS doc_date,
                yp.status, p.party_name AS vendor_name, yp.required_date,
                COALESCE((SELECT SUM(i.issued_qty_kg) FROM trx_process_issue i
                           WHERE i.src_type='YARN_PROCESS' AND i.src_id=yp.id), 0) AS sent_qty,
                COALESCE((SELECT SUM(rc.output_qty) FROM trx_process_receipt rc
                           WHERE rc.src_type='YARN_PROCESS' AND rc.src_id=yp.id), 0) AS received_qty
           FROM trx_yarn_process yp
           LEFT JOIN mst_party p ON p.id = yp.vendor_id
          WHERE yp.company_id = ? AND yp.job_work_type = 'JOB_WORK'
            AND yp.status NOT IN ('COMPLETED','CANCELLED')
         UNION ALL
         SELECT 'COLLAR_PROGRAM', cp.program_no, cp.program_date, cp.status,
                p.party_name, cp.required_date,
                COALESCE((SELECT SUM(i.issued_qty_kg) FROM trx_process_issue i
                           WHERE i.src_type='COLLAR_PROGRAM' AND i.src_id=cp.id), 0),
                COALESCE((SELECT SUM(pr.actual_yarn_kg) FROM trx_collar_production pr
                           WHERE pr.program_id = cp.id), 0)
           FROM trx_collar_program cp
           LEFT JOIN mst_party p ON p.id = cp.vendor_id
          WHERE cp.company_id = ? AND cp.job_work_type = 'JOB_WORK'
            AND cp.status NOT IN ('COMPLETED','CANCELLED')
       ) j
      ORDER BY required_date IS NULL, required_date, doc_no`, [cid, cid]);
  res.json({ success: true, data: rows });
}));

/**
 * Complete Process Traceability report (doc §28 / §27).
 * One flat row per movement so the whole chain can be searched, exported and
 * filtered, complementing the nested per-yarn view above.
 */
processReportsRouter.get('/reports/complete-traceability', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, lot_no, yarn_id } = req.query;

  let where = 'WHERE 1=1';
  const params: any[] = [cid, cid, cid, cid];
  if (io_no) { where += ' AND io_no LIKE ?'; params.push(`%${io_no}%`); }
  if (lot_no) { where += ' AND lot_ref LIKE ?'; params.push(`%${lot_no}%`); }
  if (yarn_id) { where += ' AND yarn_id = ?'; params.push(yarn_id); }

  const rows = await query(
    `SELECT * FROM (
       SELECT 'PROCESS' AS stage, yp.process_type AS stage_detail, yp.process_no AS doc_no,
              yp.process_date AS doc_date, yp.io_no, yp.buyer_po_no, yp.part_name,
              yp.yarn_id, y.yarn_code, NULL AS lot_ref, yp.input_qty_kg AS qty, 'KG' AS uom,
              yp.status
         FROM trx_yarn_process yp LEFT JOIN mst_yarn y ON y.id = yp.yarn_id
        WHERE yp.company_id = ?
       UNION ALL
       SELECT 'ISSUE', i.src_type, i.issue_no, i.issue_date,
              NULL, i.yarn_po_no, NULL, i.yarn_id, y.yarn_code, i.lot_no,
              i.issued_qty_kg, 'KG', CASE WHEN i.is_override THEN 'OVERRIDE' ELSE 'OK' END
         FROM trx_process_issue i LEFT JOIN mst_yarn y ON y.id = i.yarn_id
        WHERE i.company_id = ?
       UNION ALL
       SELECT 'RECEIPT', rc.src_type, rc.receipt_no, rc.receipt_date,
              NULL, NULL, NULL, NULL, NULL, rc.output_lot_no,
              rc.output_qty, u.code, rc.qc_status
         FROM trx_process_receipt rc LEFT JOIN cfg_uom u ON u.id = rc.output_uom_id
        WHERE rc.company_id = ?
       UNION ALL
       SELECT 'ROLL', 'KNITTING', r.roll_no, r.receipt_date,
              kp.io_no, kp.buyer_po_no, kp.part_name, NULL, NULL, NULL,
              r.net_weight_kg, 'KG', r.qc_status
         FROM trx_knitting_roll r LEFT JOIN trx_knitting_program kp ON kp.id = r.program_id
        WHERE r.company_id = ?
     ) t
     ${where}
     ORDER BY doc_date DESC, doc_no
     LIMIT 2000`, params);
  res.json({ success: true, data: rows });
}));

export default processReportsRouter;
