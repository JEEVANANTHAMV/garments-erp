import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { requirePermission } from '../../middleware/auth.js';

export const wipRouter = Router();

/**
 * Real-time WIP summary by stage across all active production orders.
 * Returns cumulative input, output, rejected, rework, shortage and WIP per stage.
 */
wipRouter.get('/wip-summary', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;

  const stages = await query(
    `SELECT ps.id AS stage_id, ps.stage_code, ps.stage_name, ps.sort_order,
            COALESCE(SUM(pt.input_qty),  0) AS total_input,
            COALESCE(SUM(pt.output_qty), 0) AS total_output,
            COALESCE(SUM(pt.rejected_qty), 0) AS total_rejected,
            COALESCE(SUM(pt.rework_qty),   0) AS total_rework,
            COALESCE(SUM(pt.shortage_qty), 0) AS total_shortage,
            COALESCE(SUM(pt.input_qty),0) - COALESCE(SUM(pt.output_qty),0) - COALESCE(SUM(pt.rejected_qty),0) AS wip_qty
       FROM cfg_process_stage ps
       LEFT JOIN trx_process_transaction pt
         ON pt.stage_id = ps.id AND pt.company_id = ?
       LEFT JOIN trx_production_order po
         ON po.id = pt.prod_order_id AND po.approval_state IN ('APPROVED','IN_PROGRESS')
      WHERE ps.company_id = ? AND ps.is_active = 1
      GROUP BY ps.id, ps.stage_code, ps.stage_name, ps.sort_order
      ORDER BY ps.sort_order`, [cid, cid]);

  // Also compute direct stage-level from individual tables for orders in progress
  const [cutWip, printWip, embWip, sewWip, washWip, finishWip] = await Promise.all([
    queryOne(`SELECT COALESCE(SUM(total_pieces),0) - COALESCE(SUM(COALESCE(output_qty,total_pieces)),0) AS wip,
                     COALESCE(SUM(rework_qty),0) AS rework, COALESCE(SUM(shortage_qty),0) AS shortage
                FROM trx_cutting c JOIN trx_production_order po ON po.id = c.prod_order_id
               WHERE po.company_id = ? AND po.approval_state IN ('APPROVED','IN_PROGRESS')`, [cid]),
    queryOne(`SELECT COALESCE(SUM(input_qty - output_qty - rejected_qty),0) AS wip,
                     COALESCE(SUM(rework_qty),0) AS rework, COALESCE(SUM(shortage_qty),0) AS shortage
                FROM trx_printing p JOIN trx_production_order po ON po.id = p.prod_order_id
               WHERE po.company_id = ? AND po.approval_state IN ('APPROVED','IN_PROGRESS')`, [cid]),
    queryOne(`SELECT COALESCE(SUM(input_qty - output_qty - rejected_qty),0) AS wip,
                     COALESCE(SUM(rework_qty),0) AS rework, COALESCE(SUM(shortage_qty),0) AS shortage
                FROM trx_embroidery e JOIN trx_production_order po ON po.id = e.prod_order_id
               WHERE po.company_id = ? AND po.approval_state IN ('APPROVED','IN_PROGRESS')`, [cid]),
    queryOne(`SELECT COALESCE(SUM(input_qty - output_qty - rejected_qty),0) AS wip,
                     COALESCE(SUM(rework_qty),0) AS rework, COALESCE(SUM(shortage_qty),0) AS shortage
                FROM trx_stitching s JOIN trx_production_order po ON po.id = s.prod_order_id
               WHERE po.company_id = ? AND po.approval_state IN ('APPROVED','IN_PROGRESS')`, [cid]),
    queryOne(`SELECT COALESCE(SUM(input_qty - output_qty - rejected_qty),0) AS wip,
                     COALESCE(SUM(rework_qty),0) AS rework, COALESCE(SUM(shortage_qty),0) AS shortage
                FROM trx_washing w JOIN trx_production_order po ON po.id = w.prod_order_id
               WHERE po.company_id = ? AND po.approval_state IN ('APPROVED','IN_PROGRESS')`, [cid]),
    queryOne(`SELECT COALESCE(SUM(input_qty - output_qty - rejected_qty),0) AS wip,
                     COALESCE(SUM(rework_qty),0) AS rework, COALESCE(SUM(shortage_qty),0) AS shortage
                FROM trx_finishing f JOIN trx_production_order po ON po.id = f.prod_order_id
               WHERE po.company_id = ? AND po.approval_state IN ('APPROVED','IN_PROGRESS')`, [cid]),
  ]);

  res.json({
    data: {
      stageWip: stages,
      directWip: {
        cutting: cutWip, printing: printWip, embroidery: embWip,
        stitching: sewWip, washing: washWip, finishing: finishWip,
      },
    },
  });
}));

/** WIP breakdown for a specific production order — stage by stage. */
wipRouter.get('/wip-by-order/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const orderId = Number(req.params.id);
  const cid = req.user!.companyId;

  const order = await queryOne(
    `SELECT po.*, st.style_code, st.style_name, so.so_no
       FROM trx_production_order po
       LEFT JOIN mst_style st ON st.id = po.style_id
       LEFT JOIN trx_sales_order so ON so.id = po.so_id
      WHERE po.id = ? AND po.company_id = ?`, [orderId, cid]);

  if (!order) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Production order not found' } });

  const [stageData, cutting, printing, embroidery, stitching, washing, finishing] = await Promise.all([
    query(`SELECT ps.stage_name, ps.sort_order,
                  COALESCE(SUM(pt.input_qty),0) AS input, COALESCE(SUM(pt.output_qty),0) AS output,
                  COALESCE(SUM(pt.rejected_qty),0) AS rejected, COALESCE(SUM(pt.rework_qty),0) AS rework,
                  COALESCE(SUM(pt.shortage_qty),0) AS shortage
             FROM cfg_process_stage ps
             LEFT JOIN trx_process_transaction pt ON pt.stage_id = ps.id AND pt.prod_order_id = ?
            WHERE ps.company_id = ? AND ps.is_active = 1
            GROUP BY ps.id, ps.stage_name, ps.sort_order ORDER BY ps.sort_order`, [orderId, cid]),
    query(`SELECT * FROM trx_cutting WHERE prod_order_id = ? ORDER BY cut_date`, [orderId]),
    query(`SELECT * FROM trx_printing WHERE prod_order_id = ? ORDER BY print_date`, [orderId]),
    query(`SELECT * FROM trx_embroidery WHERE prod_order_id = ? ORDER BY emb_date`, [orderId]),
    query(`SELECT * FROM trx_stitching WHERE prod_order_id = ? ORDER BY stitch_date`, [orderId]),
    query(`SELECT * FROM trx_washing WHERE prod_order_id = ? ORDER BY wash_date`, [orderId]),
    query(`SELECT * FROM trx_finishing WHERE prod_order_id = ? ORDER BY finish_date`, [orderId]),
  ]);

  res.json({ data: { order, stageData, cutting, printing, embroidery, stitching, washing, finishing } });
}));

/** Daily production dashboard KPIs — target vs actual, line efficiency. */
wipRouter.get('/daily-dashboard', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dateStr = String(req.query.date || new Date().toISOString().slice(0, 10));

  const [lineSummary, overall, plans, outputs] = await Promise.all([
    // Line-wise actual vs target
    query(
      `SELECT sl.line_code, sl.line_name, sl.capacity_pcs,
              COALESCE(SUM(do2.target_qty), 0) AS plan_target,
              COALESCE(SUM(do2.actual_good), 0) AS actual_good,
              COALESCE(SUM(do2.reject_qty),  0) AS reject_qty,
              COALESCE(SUM(do2.rework_qty),  0) AS rework_qty,
              CASE WHEN COALESCE(SUM(do2.target_qty),0) > 0
                THEN ROUND(COALESCE(SUM(do2.actual_good),0) / COALESCE(SUM(do2.target_qty),0) * 100, 1)
                ELSE 0 END AS achievement_pct
         FROM cfg_sewing_line sl
         LEFT JOIN trx_daily_output do2 ON do2.line_id = sl.id AND do2.output_date = ? AND do2.company_id = ?
        WHERE sl.company_id = ? AND sl.is_active = 1
        GROUP BY sl.id, sl.line_code, sl.line_name, sl.capacity_pcs
        ORDER BY sl.line_code`, [dateStr, cid, cid]),

    // Overall totals for the day
    queryOne(
      `SELECT COALESCE(SUM(target_qty), 0) AS total_plan,
              COALESCE(SUM(actual_good), 0) AS total_actual,
              COALESCE(SUM(reject_qty),  0) AS total_reject,
              COALESCE(SUM(rework_qty),  0) AS total_rework,
              CASE WHEN COALESCE(SUM(target_qty),0) > 0
                THEN ROUND(COALESCE(SUM(actual_good),0) / COALESCE(SUM(target_qty),0) * 100, 1)
                ELSE 0 END AS achievement_pct
         FROM trx_daily_output WHERE company_id = ? AND output_date = ?`, [cid, dateStr]),

    // Daily plans for date
    query(
      `SELECT dp.*, st.style_code, sl.line_name, sh.shift_name, po.po_prod_no
         FROM trx_daily_production_plan dp
         LEFT JOIN mst_style st ON st.id = dp.style_id
         LEFT JOIN cfg_sewing_line sl ON sl.id = dp.line_id
         LEFT JOIN cfg_shift sh ON sh.id = dp.shift_id
         LEFT JOIN trx_production_order po ON po.id = dp.prod_order_id
        WHERE dp.company_id = ? AND dp.plan_date = ?
        ORDER BY sl.line_code`, [cid, dateStr]),

    // Outputs for date
    query(
      `SELECT do2.*, st.style_code, sl.line_name, ps.stage_name, dr.reason_name AS delay_reason_name
         FROM trx_daily_output do2
         LEFT JOIN mst_style st ON st.id = do2.style_id
         LEFT JOIN cfg_sewing_line sl ON sl.id = do2.line_id
         LEFT JOIN cfg_process_stage ps ON ps.id = do2.stage_id
         LEFT JOIN cfg_delay_reason dr ON dr.id = do2.delay_reason_id
        WHERE do2.company_id = ? AND do2.output_date = ?
        ORDER BY sl.line_code, ps.sort_order`, [cid, dateStr]),
  ]);

  res.json({ data: { date: dateStr, lineSummary, overall, plans, outputs } });
}));

/** Actual production cost summary for a given production order. */
wipRouter.get('/production-cost-summary/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const orderId = Number(req.params.id);
  const cid = req.user!.companyId;

  const cost = await queryOne(
    `SELECT pc.*, po.po_prod_no, st.style_code
       FROM trx_production_cost pc
       LEFT JOIN trx_production_order po ON po.id = pc.prod_order_id
       LEFT JOIN mst_style st ON st.id = pc.style_id
      WHERE pc.prod_order_id = ? AND pc.company_id = ?
      ORDER BY pc.id DESC LIMIT 1`, [orderId, cid]);

  if (!cost) return res.json({ data: null });

  const lines = await query(
    `SELECT * FROM trx_production_cost_line WHERE cost_id = ? ORDER BY id`, [(cost as any).id]);

  res.json({ data: { ...(cost as any), lines } });
}));
