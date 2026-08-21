import { Router, type Response } from 'express';
import { z } from 'zod';
import { query } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { requirePermission } from '../../middleware/auth.js';

export const reportsRouter = Router();

const range = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  buyer_id: z.coerce.number().int().optional(),
  format: z.string().optional(),
});

function sendReport(res: Response, filename: string, rows: any[], format?: string) {
  if (format === 'csv') {
    if (!rows || !rows.length) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return res.send('No data available\r\n');
    }
    const headers = Object.keys(rows[0]);
    const csvLines = [
      headers.map((h) => `"${h}"`).join(','),
      ...rows.map((r) =>
        headers
          .map((h) => {
            const v = r[h];
            if (v === null || v === undefined) return '""';
            const s = String(v).replace(/"/g, '""');
            return `"${s}"`;
          })
          .join(','),
      ),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(csvLines.join('\r\n'));
  }
  return res.json({ data: rows });
}

/** 1. Order Status / Order Book */
const handleOrderStatus = ah(async (req, res) => {
  const q = range.parse(req.query);
  const where = ['so.company_id = ?', 'so.is_deleted = 0'];
  const params: unknown[] = [req.user!.companyId];
  if (q.dateFrom) { where.push('so.so_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo)   { where.push('so.so_date <= ?'); params.push(q.dateTo); }
  if (q.buyer_id) { where.push('so.buyer_id = ?'); params.push(q.buyer_id); }

  const rows = await query(
    `SELECT so.id, so.so_no, so.so_date, so.ship_date, so.order_qty, so.total_amount,
            so.approval_state, b.party_name AS buyer_name, cur.code AS currency_code,
            COALESCE(prod.produced, 0)  AS produced_qty,
            COALESCE(packed.packed, 0)  AS packed_qty,
            COALESCE(shipped.shipped,0) AS shipped_qty,
            so.order_qty - COALESCE(shipped.shipped,0) AS balance_qty
       FROM trx_sales_order so
       LEFT JOIN mst_party b ON b.id = so.buyer_id
       LEFT JOIN cfg_currency cur ON cur.id = so.currency_id
       LEFT JOIN (SELECT so_id, SUM(produced_qty) AS produced
                    FROM trx_production_order GROUP BY so_id) prod ON prod.so_id = so.id
       LEFT JOIN (SELECT so_id, SUM(total_qty) AS packed
                    FROM trx_packing GROUP BY so_id) packed ON packed.so_id = so.id
       LEFT JOIN (SELECT so_id, SUM(total_qty) AS shipped
                    FROM trx_dispatch GROUP BY so_id) shipped ON shipped.so_id = so.id
      WHERE ${where.join(' AND ')}
      ORDER BY so.so_date DESC`, params);
  sendReport(res, 'order-status-report', rows, q.format);
});
reportsRouter.get('/order-status', requirePermission('REPORT.VIEW'), handleOrderStatus);
reportsRouter.get('/order-book', requirePermission('REPORT.VIEW'), handleOrderStatus);

/** 2. Production efficiency by stage. */
reportsRouter.get('/production-efficiency', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = range.parse(req.query);
  const where = ['pt.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  if (q.dateFrom) { where.push('pt.txn_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo)   { where.push('pt.txn_date <= ?'); params.push(q.dateTo); }

  const rows = await query(
    `SELECT ps.stage_code, ps.stage_name,
            COUNT(pt.id) AS transactions,
            COALESCE(SUM(pt.input_qty),0)    AS input_qty,
            COALESCE(SUM(pt.output_qty),0)   AS output_qty,
            COALESCE(SUM(pt.rejected_qty),0) AS rejected_qty,
            CASE WHEN SUM(pt.input_qty) > 0
                 THEN ROUND(SUM(pt.output_qty) / SUM(pt.input_qty) * 100, 2) ELSE 0 END AS efficiency_pct,
            CASE WHEN SUM(pt.input_qty) > 0
                 THEN ROUND(SUM(pt.rejected_qty) / SUM(pt.input_qty) * 100, 2) ELSE 0 END AS rejection_pct
       FROM trx_process_transaction pt
       JOIN cfg_process_stage ps ON ps.id = pt.stage_id
      WHERE ${where.join(' AND ')}
      GROUP BY ps.id, ps.stage_code, ps.stage_name, ps.sort_order
      ORDER BY ps.sort_order`, params);
  sendReport(res, 'production-efficiency-report', rows, q.format);
}));

/** 3. Stock summary by warehouse & material. */
reportsRouter.get('/stock-summary', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = range.parse(req.query);
  const rows = await query(
    `SELECT wh.warehouse_code, wh.warehouse_name,
            l.material_type,
            COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name, 'Finished Goods') AS material_name,
            COALESCE(y.yarn_code, fb.fabric_code, tr.trim_code, 'FG') AS material_code,
            u.code AS uom_code,
            SUM(l.qty_in - l.qty_out) AS stock_on_hand,
            AVG(l.rate) AS avg_rate,
            SUM((l.qty_in - l.qty_out) * l.rate) AS total_valuation
       FROM trx_stock_ledger l
       JOIN mst_warehouse wh ON wh.id = l.warehouse_id
       LEFT JOIN mst_yarn y ON y.id = l.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = l.trim_id
       LEFT JOIN cfg_uom u ON u.id = l.uom_id
      WHERE l.company_id = ?
      GROUP BY wh.id, wh.warehouse_code, wh.warehouse_name, l.material_type, material_name, material_code, u.code
      HAVING stock_on_hand > 0
      ORDER BY wh.warehouse_name, l.material_type, material_name`, [req.user!.companyId]);
  sendReport(res, 'stock-summary-report', rows, q.format);
}));

/** 4. Buyer-wise sales summary. */
const handleBuyerSales = ah(async (req, res) => {
  const q = range.parse(req.query);
  const where = ['so.company_id = ?', 'so.is_deleted = 0'];
  const params: unknown[] = [req.user!.companyId];
  if (q.dateFrom) { where.push('so.so_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo)   { where.push('so.so_date <= ?'); params.push(q.dateTo); }

  const rows = await query(
    `SELECT b.id, b.party_code, b.party_name, c.name AS country_name,
            COUNT(so.id) AS order_count,
            COALESCE(SUM(so.order_qty),0) AS total_qty,
            COALESCE(SUM(so.total_amount),0) AS total_value,
            COALESCE(AVG(so.total_amount),0) AS avg_order_value,
            MAX(so.so_date) AS last_order_date
       FROM mst_party b
       JOIN trx_sales_order so ON so.buyer_id = b.id
       LEFT JOIN cfg_country c ON c.id = b.country_id
      WHERE ${where.join(' AND ')}
      GROUP BY b.id, b.party_code, b.party_name, c.name
      ORDER BY total_value DESC`, params);
  sendReport(res, 'buyer-wise-sales-report', rows, q.format);
});
reportsRouter.get('/buyer-wise-sales', requirePermission('REPORT.VIEW'), handleBuyerSales);
reportsRouter.get('/buyer-summary', requirePermission('REPORT.VIEW'), handleBuyerSales);

/** 5. MRP Requirements report. */
reportsRouter.get('/mrp-requirements', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = range.parse(req.query);
  const rows = await query(
    `SELECT r.mrp_no, r.run_date, so.so_no,
            req.material_type,
            COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name) AS material_name,
            COALESCE(y.yarn_code, fb.fabric_code, tr.trim_code) AS material_code,
            c.color_name,
            u.code AS uom_code,
            req.gross_required,
            req.in_stock,
            req.on_order,
            req.net_required,
            req.required_by
       FROM trx_mrp_requirement req
       JOIN trx_mrp_run r ON r.id = req.mrp_id
       LEFT JOIN trx_sales_order so ON so.id = req.so_id
       LEFT JOIN mst_yarn y ON y.id = req.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = req.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = req.trim_id
       LEFT JOIN mst_color c ON c.id = req.color_id
       LEFT JOIN cfg_uom u ON u.id = req.uom_id
      WHERE r.company_id = ?
      ORDER BY r.id DESC, req.material_type, material_name`, [req.user!.companyId]);
  sendReport(res, 'mrp-requirements-report', rows, q.format);
}));

/** 6. QC defect Pareto analysis. */
const handleQcDefects = ah(async (req, res) => {
  const q = range.parse(req.query);
  const where = ['q.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  if (q.dateFrom) { where.push('q.qc_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo)   { where.push('q.qc_date <= ?'); params.push(q.dateTo); }

  const rows = await query(
    `SELECT d.defect_code, d.defect_name, d.defect_type,
            SUM(dl.defect_qty) AS total_qty, COUNT(DISTINCT q.id) AS inspections
       FROM trx_qc_defect_line dl
       JOIN trx_qc_inspection q ON q.id = dl.qc_id
       JOIN mst_defect d ON d.id = dl.defect_id
      WHERE ${where.join(' AND ')}
      GROUP BY d.id, d.defect_code, d.defect_name, d.defect_type
      ORDER BY total_qty DESC`, params);
  sendReport(res, 'qc-defect-analysis', rows, q.format);
});
reportsRouter.get('/qc-defects', requirePermission('REPORT.VIEW'), handleQcDefects);
reportsRouter.get('/defect-analysis', requirePermission('REPORT.VIEW'), handleQcDefects);

/** 7. T&A Milestone tracker. */
reportsRouter.get('/ta-milestone', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = range.parse(req.query);
  const rows = await query(
    `SELECT p.plan_no, so.so_no, b.party_name AS buyer_name,
            m.milestone, m.planned_date, m.actual_date,
            m.is_critical, m.status,
            DATEDIFF(COALESCE(m.actual_date, CURRENT_DATE), m.planned_date) AS days_variance
       FROM trx_plan_milestone m
       JOIN trx_production_plan p ON p.id = m.plan_id
       JOIN trx_sales_order so ON so.id = p.so_id
       LEFT JOIN mst_party b ON b.id = so.buyer_id
      WHERE p.company_id = ?
      ORDER BY p.id DESC, m.planned_date`, [req.user!.companyId]);
  sendReport(res, 'ta-milestone-tracker', rows, q.format);
}));

/** 8. Export realization / incentives. */
const handleExportRealisation = ah(async (req, res) => {
  const q = range.parse(req.query);
  const where = ['ci.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  if (q.dateFrom) { where.push('ci.invoice_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo)   { where.push('ci.invoice_date <= ?'); params.push(q.dateTo); }
  if (q.buyer_id) { where.push('ci.buyer_id = ?'); params.push(q.buyer_id); }

  const rows = await query(
    `SELECT ci.id, ci.invoice_no, ci.invoice_date, ci.total_value,
            cur.code AS currency_code, b.party_name AS buyer_name,
            COALESCE(alloc.received, 0) AS received_fc,
            ci.total_value - COALESCE(alloc.received, 0) AS outstanding_fc,
            sb.sb_no, sb.drawback_amount, sb.rodtep_amount
       FROM trx_commercial_invoice ci
       LEFT JOIN mst_party b ON b.id = ci.buyer_id
       LEFT JOIN cfg_currency cur ON cur.id = ci.currency_id
       LEFT JOIN (SELECT invoice_id, SUM(allocated_fc) AS received
                    FROM map_receipt_invoice GROUP BY invoice_id) alloc ON alloc.invoice_id = ci.id
       LEFT JOIN trx_shipping_bill sb ON sb.invoice_id = ci.id
      WHERE ${where.join(' AND ')}
      ORDER BY ci.invoice_date DESC`, params);
  sendReport(res, 'export-realisation-report', rows, q.format);
});
reportsRouter.get('/export-realisation', requirePermission('REPORT.VIEW'), handleExportRealisation);
reportsRouter.get('/export-realization', requirePermission('REPORT.VIEW'), handleExportRealisation);

/** 9. Material consumption: planned vs actual. */
reportsRouter.get('/material-consumption', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = range.parse(req.query);
  const rows = await query(
    `SELECT il.material_type,
            COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name) AS material_name,
            COALESCE(y.yarn_code, fb.fabric_code, tr.trim_code) AS material_code,
            u.code AS uom_code,
            SUM(il.issued_qty) AS issued_qty,
            COUNT(DISTINCT i.id) AS issue_count
       FROM trx_material_issue_line il
       JOIN trx_material_issue i ON i.id = il.issue_id
       LEFT JOIN mst_yarn y ON y.id = il.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = il.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = il.trim_id
       LEFT JOIN cfg_uom u ON u.id = il.uom_id
      WHERE i.company_id = ?
      GROUP BY il.material_type, material_name, material_code, u.code
      ORDER BY il.material_type, material_name`, [req.user!.companyId]);
  sendReport(res, 'material-consumption-report', rows, q.format);
}));

/** 10. Style-wise costing vs actual FOB achieved. */
reportsRouter.get('/costing-analysis', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const q = range.parse(req.query);
  const rows = await query(
    `SELECT st.style_code, st.style_name, b.party_name AS buyer_name,
            c.costing_no, c.total_cost, c.fob_price, c.margin_pct,
            cur.code AS currency_code,
            CASE WHEN c.fob_price > 0
                 THEN ROUND((c.fob_price - c.total_cost) / c.fob_price * 100, 2) ELSE 0 END AS actual_margin_pct
       FROM trx_costing c
       JOIN mst_style st ON st.id = c.style_id
       LEFT JOIN mst_party b ON b.id = c.buyer_id
       LEFT JOIN cfg_currency cur ON cur.id = c.currency_id
      WHERE c.company_id = ? AND c.is_deleted = 0
      ORDER BY c.costing_date DESC`, [req.user!.companyId]);
  sendReport(res, 'costing-analysis-report', rows, q.format);
}));

/** Audit trail viewer. */
reportsRouter.get('/audit-log', requirePermission('AUDIT.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    table_name: z.string().optional(),
    record_id: z.coerce.number().int().optional(),
    action: z.enum(['INSERT','UPDATE','DELETE']).optional(),
    changed_by: z.coerce.number().int().optional(),
  }).parse(req.query);

  const where = ['a.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  for (const k of ['table_name','record_id','action','changed_by'] as const) {
    if ((q as any)[k]) { where.push(`a.${k} = ?`); params.push((q as any)[k]); }
  }
  const offset = (q.page - 1) * q.pageSize;

  const rows = await query(
    `SELECT a.*, u.full_name AS changed_by_name
       FROM log_audit a
       LEFT JOIN mst_user u ON u.id = a.changed_by
      WHERE ${where.join(' AND ')}
      ORDER BY a.changed_at DESC
      LIMIT ${q.pageSize} OFFSET ${offset}`, params);
  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize } });
}));

