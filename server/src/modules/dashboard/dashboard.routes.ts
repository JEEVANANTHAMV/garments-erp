import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { requirePermission } from '../../middleware/auth.js';

export const dashboardRouter = Router();

/** Executive summary tiles + charts for the landing dashboard. */
dashboardRouter.get('/summary', requirePermission('DASHBOARD.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;

  const [
    orderStats, prodStats, shipStats, qcStats,
    ordersByMonth, topBuyers, ordersByStatus, upcomingShipments,
    productionPipeline, stockValue, pendingApprovals, lowStockAlerts,
  ] = await Promise.all([
    queryOne(
      `SELECT COUNT(*) AS total_orders,
              COALESCE(SUM(order_qty),0)    AS total_qty,
              COALESCE(SUM(total_amount),0) AS total_value,
              COALESCE(SUM(CASE WHEN approval_state='APPROVED' THEN 1 ELSE 0 END),0) AS approved_orders,
              COALESCE(SUM(CASE WHEN approval_state='DRAFT'    THEN 1 ELSE 0 END),0) AS draft_orders
         FROM trx_sales_order WHERE company_id = ? AND is_deleted = 0`, [cid]),

    queryOne(
      `SELECT COUNT(*) AS total_prod_orders,
              COALESCE(SUM(order_qty),0)    AS planned_qty,
              COALESCE(SUM(produced_qty),0) AS produced_qty,
              COALESCE(SUM(CASE WHEN approval_state='IN_PROGRESS' THEN 1 ELSE 0 END),0) AS in_progress
         FROM trx_production_order WHERE company_id = ?`, [cid]),

    queryOne(
      `SELECT COUNT(*) AS total_shipments,
              COALESCE(SUM(CASE WHEN tracking_status IN ('SAILED','TRANSIT') THEN 1 ELSE 0 END),0) AS in_transit,
              COALESCE(SUM(CASE WHEN tracking_status='DELIVERED' THEN 1 ELSE 0 END),0) AS delivered
         FROM trx_shipment WHERE company_id = ?`, [cid]),

    queryOne(
      `SELECT COUNT(*) AS total_inspections,
              COALESCE(SUM(CASE WHEN result='PASS' THEN 1 ELSE 0 END),0) AS passed,
              COALESCE(SUM(CASE WHEN result='FAIL' THEN 1 ELSE 0 END),0) AS failed,
              COALESCE(SUM(inspected_qty),0) AS inspected_qty,
              COALESCE(SUM(major_defects + minor_defects + critical_defects),0) AS total_defects
         FROM trx_qc_inspection WHERE company_id = ?`, [cid]),

    query(
      `SELECT DATE_FORMAT(so_date,'%Y-%m') AS month,
              COUNT(*) AS orders,
              COALESCE(SUM(order_qty),0) AS qty,
              COALESCE(SUM(total_amount),0) AS value
         FROM trx_sales_order
        WHERE company_id = ? AND is_deleted = 0
          AND so_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
        GROUP BY month ORDER BY month`, [cid]),

    query(
      `SELECT b.id, b.party_name AS buyer_name, COUNT(so.id) AS orders,
              COALESCE(SUM(so.order_qty),0) AS qty,
              COALESCE(SUM(so.total_amount),0) AS value
         FROM trx_sales_order so
         JOIN mst_party b ON b.id = so.buyer_id
        WHERE so.company_id = ? AND so.is_deleted = 0
        GROUP BY b.id, b.party_name ORDER BY value DESC LIMIT 8`, [cid]),

    query(
      `SELECT approval_state AS status, COUNT(*) AS count,
              COALESCE(SUM(total_amount),0) AS value
         FROM trx_sales_order WHERE company_id = ? AND is_deleted = 0
        GROUP BY approval_state`, [cid]),

    query(
      `SELECT so.id, so.so_no, so.ship_date, so.order_qty, so.total_amount,
              b.party_name AS buyer_name, cur.code AS currency_code,
              DATEDIFF(so.ship_date, CURDATE()) AS days_remaining
         FROM trx_sales_order so
         LEFT JOIN mst_party b ON b.id = so.buyer_id
         LEFT JOIN cfg_currency cur ON cur.id = so.currency_id
        WHERE so.company_id = ? AND so.is_deleted = 0
          AND so.ship_date IS NOT NULL
          AND so.approval_state NOT IN ('CLOSED','CANCELLED')
          AND so.ship_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        ORDER BY so.ship_date LIMIT 10`, [cid]),

    query(
      `SELECT ps.stage_code, ps.stage_name, ps.sort_order,
              COALESCE(SUM(pt.input_qty),0)  AS input_qty,
              COALESCE(SUM(pt.output_qty),0) AS output_qty,
              COALESCE(SUM(pt.rejected_qty),0) AS rejected_qty
         FROM cfg_process_stage ps
         LEFT JOIN trx_process_transaction pt ON pt.stage_id = ps.id AND pt.company_id = ?
        WHERE ps.company_id = ? AND ps.is_active = 1
        GROUP BY ps.id, ps.stage_code, ps.stage_name, ps.sort_order
        ORDER BY ps.sort_order`, [cid, cid]),

    queryOne(
      `SELECT COALESCE(SUM((sl.qty_in - sl.qty_out) * sl.rate), 0) AS stock_value
         FROM trx_stock_ledger sl WHERE sl.company_id = ?`, [cid]),

    queryOne(
      `SELECT COUNT(*) AS pending FROM trx_approval a
        WHERE a.status = 'PENDING'
          AND a.workflow_id IN (SELECT id FROM cfg_workflow WHERE company_id = ?)`, [cid]),

    query(
      `SELECT * FROM (
         SELECT 'YARN' AS material_type, y.id AS item_id, y.yarn_name AS item_name, y.yarn_code AS item_code,
                COALESCE(SUM(sl.qty_in - sl.qty_out), 0) AS balance
           FROM mst_yarn y
           LEFT JOIN trx_stock_ledger sl ON sl.yarn_id = y.id AND sl.company_id = ?
          WHERE y.company_id = ? AND y.is_active = 1 AND y.is_deleted = 0
          GROUP BY y.id, y.yarn_name, y.yarn_code
         UNION ALL
         SELECT 'FABRIC', f.id, f.fabric_name, f.fabric_code,
                COALESCE(SUM(sl.qty_in - sl.qty_out), 0)
           FROM mst_fabric f
           LEFT JOIN trx_stock_ledger sl ON sl.fabric_id = f.id AND sl.company_id = ?
          WHERE f.company_id = ? AND f.is_active = 1 AND f.is_deleted = 0
          GROUP BY f.id, f.fabric_name, f.fabric_code
       ) x WHERE x.balance <= 0 ORDER BY x.balance LIMIT 10`, [cid, cid, cid, cid]),
  ]);

  res.json({
    data: {
      orders: orderStats, production: prodStats, shipments: shipStats, quality: qcStats,
      ordersByMonth, topBuyers, ordersByStatus, upcomingShipments,
      productionPipeline, stockValue, pendingApprovals, lowStockAlerts,
    },
  });
}));

/** Order-to-shipment traceability for one sales order. */
dashboardRouter.get('/order-tracking/:soId', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const soId = Number(req.params.soId);
  const cid = req.user!.companyId;

  const so = await queryOne(
    `SELECT so.*, b.party_name AS buyer_name, cur.code AS currency_code
       FROM trx_sales_order so
       LEFT JOIN mst_party b ON b.id = so.buyer_id
       LEFT JOIN cfg_currency cur ON cur.id = so.currency_id
      WHERE so.id = ? AND so.company_id = ?`, [soId, cid]);
  if (!so) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Sales order not found' } });

  const [plans, prodOrders, cutting, stitching, qc, packing, dispatch, invoices, shipments] =
    await Promise.all([
      query(`SELECT p.*, (SELECT COUNT(*) FROM trx_plan_milestone m WHERE m.plan_id = p.id) AS milestone_count
               FROM trx_production_plan p WHERE p.so_id = ?`, [soId]),
      query(`SELECT po.*, st.style_code FROM trx_production_order po
               LEFT JOIN mst_style st ON st.id = po.style_id WHERE po.so_id = ?`, [soId]),
      query(`SELECT c.* FROM trx_cutting c
               JOIN trx_production_order po ON po.id = c.prod_order_id WHERE po.so_id = ?`, [soId]),
      query(`SELECT s.* FROM trx_stitching s
               JOIN trx_production_order po ON po.id = s.prod_order_id WHERE po.so_id = ?`, [soId]),
      query(`SELECT q.* FROM trx_qc_inspection q
               JOIN trx_production_order po ON po.id = q.prod_order_id WHERE po.so_id = ?`, [soId]),
      query(`SELECT * FROM trx_packing WHERE so_id = ?`, [soId]),
      query(`SELECT * FROM trx_dispatch WHERE so_id = ?`, [soId]),
      query(`SELECT * FROM trx_commercial_invoice WHERE so_id = ?`, [soId]),
      query(`SELECT sh.* FROM trx_shipment sh
               JOIN trx_commercial_invoice ci ON ci.id = sh.invoice_id WHERE ci.so_id = ?`, [soId]),
    ]);

  res.json({ data: { salesOrder: so, plans, productionOrders: prodOrders, cutting,
    stitching, qc, packing, dispatch, invoices, shipments } });
}));

/** Time & Action delay report — milestones at risk across live plans. */
dashboardRouter.get('/tna-alerts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const rows = await query(
    `SELECT m.*, p.plan_no, so.so_no, b.party_name AS buyer_name,
            DATEDIFF(CURDATE(), m.planned_date) AS days_overdue
       FROM trx_plan_milestone m
       JOIN trx_production_plan p ON p.id = m.plan_id
       JOIN trx_sales_order so ON so.id = p.so_id
       LEFT JOIN mst_party b ON b.id = so.buyer_id
      WHERE p.company_id = ?
        AND m.status <> 'DONE'
        AND m.planned_date IS NOT NULL
        AND m.planned_date < DATE_ADD(CURDATE(), INTERVAL 7 DAY)
      ORDER BY m.planned_date`, [req.user!.companyId]);
  res.json({ data: rows });
}));
