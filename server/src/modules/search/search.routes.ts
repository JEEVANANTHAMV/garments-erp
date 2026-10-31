import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';

export const searchRouter = Router();

interface Hit { id: number; label: string; sub: string | null; kind?: string | null }
interface Source {
  type: string; permission: string; sql: string; params: number;
  to: (h: Hit) => string;
}

// Header "Search anything": document numbers, styles, jobs, fabrics, parties. Each source is scoped to the
// user's company and only searched when the user can view that module. `?` = the LIKE pattern (repeated).
const SOURCES: Source[] = [
  { type: 'Sales Order', permission: 'SALES_ORDER.VIEW', params: 3,
    sql: `SELECT so.id, so.so_no AS label, CONCAT_WS(' · ', b.party_name, CONCAT('IO ', so.io_no), CONCAT('PO ', so.buyer_po_no)) AS sub
            FROM trx_sales_order so LEFT JOIN mst_party b ON b.id = so.buyer_id
           WHERE so.company_id = ? AND so.is_deleted = 0 AND (so.so_no LIKE ? OR so.io_no LIKE ? OR so.buyer_po_no LIKE ?)
           ORDER BY so.id DESC LIMIT 5`,
    to: (h) => `/sales/orders/${h.id}` },
  { type: 'Job / Work Order', permission: 'PRODUCTION.VIEW', params: 2,
    sql: `SELECT p.id, p.po_prod_no AS label, CONCAT_WS(' · ', CONCAT('IO ', p.io_no), st.style_code) AS sub
            FROM trx_production_order p LEFT JOIN mst_style st ON st.id = p.style_id
           WHERE p.company_id = ? AND (p.po_prod_no LIKE ? OR p.io_no LIKE ?)
           ORDER BY p.id DESC LIMIT 5`,
    to: (h) => `/production/orders?q=${encodeURIComponent(h.label)}` },
  { type: 'Style', permission: 'STYLE.VIEW', params: 2,
    sql: `SELECT st.id, st.style_code AS label, CONCAT_WS(' · ', st.style_name, b.party_name) AS sub
            FROM mst_style st LEFT JOIN mst_party b ON b.id = st.buyer_id
           WHERE st.company_id = ? AND st.is_deleted = 0 AND (st.style_code LIKE ? OR st.style_name LIKE ?)
           ORDER BY st.id DESC LIMIT 5`,
    to: (h) => `/masters/styles/${h.id}` },
  { type: 'Purchase Order', permission: 'PURCHASE.VIEW', params: 1,
    sql: `SELECT po.id, po.po_no AS label, sup.party_name AS sub,
                 CASE WHEN EXISTS (SELECT 1 FROM trx_purchase_order_line l WHERE l.po_id = po.id AND l.material_type = 'YARN') THEN 'YARN'
                      WHEN EXISTS (SELECT 1 FROM trx_purchase_order_line l WHERE l.po_id = po.id AND l.material_type = 'FABRIC') THEN 'FABRIC'
                      ELSE 'GENERAL' END AS kind
            FROM trx_purchase_order po LEFT JOIN mst_party sup ON sup.id = po.supplier_id
           WHERE po.company_id = ? AND po.is_deleted = 0 AND po.po_no LIKE ?
           ORDER BY po.id DESC LIMIT 5`,
    to: (h) => h.kind === 'YARN' ? `/procurement/yarn/orders/${h.id}` : h.kind === 'FABRIC' ? `/procurement/fabric/orders/${h.id}` : `/procurement/general-orders/${h.id}` },
  { type: 'Trim PO', permission: 'PURCHASE.VIEW', params: 2,
    sql: `SELECT po.id, po.po_no AS label, CONCAT_WS(' · ', sup.party_name, CONCAT('IO ', po.io_no)) AS sub
            FROM trx_trim_po po LEFT JOIN mst_party sup ON sup.id = po.supplier_id
           WHERE po.company_id = ? AND (po.po_no LIKE ? OR po.io_no LIKE ?)
           ORDER BY po.id DESC LIMIT 5`,
    to: (h) => `/procurement/trim/orders/${h.id}` },
  { type: 'General Purchase', permission: 'PURCHASE.VIEW', params: 2,
    sql: `SELECT gp.id, gp.purchase_no AS label, sup.party_name AS sub
            FROM trx_general_purchase gp LEFT JOIN mst_party sup ON sup.id = gp.supplier_id
           WHERE gp.company_id = ? AND gp.is_deleted = 0 AND (gp.purchase_no LIKE ? OR gp.grn_no LIKE ?)
           ORDER BY gp.id DESC LIMIT 5`,
    to: (h) => `/procurement/general-purchases/${h.id}` },
  { type: 'GRN', permission: 'GRN.VIEW', params: 3,
    sql: `SELECT g.id, g.grn_no AS label, CONCAT_WS(' · ', sup.party_name, CONCAT('DC ', g.supplier_dc_no)) AS sub,
                 CASE WHEN EXISTS (SELECT 1 FROM trx_grn_line l WHERE l.grn_id = g.id AND l.material_type = 'YARN') THEN 'YARN'
                      WHEN EXISTS (SELECT 1 FROM trx_grn_line l WHERE l.grn_id = g.id AND l.material_type = 'FABRIC') THEN 'FABRIC'
                      ELSE 'OTHER' END AS kind
            FROM trx_grn g LEFT JOIN mst_party sup ON sup.id = g.supplier_id
           WHERE g.company_id = ? AND (g.grn_no LIKE ? OR g.supplier_dc_no LIKE ? OR g.supplier_inv_no LIKE ?)
           ORDER BY g.id DESC LIMIT 5`,
    to: (h) => h.kind === 'YARN' ? `/procurement/yarn/grn/${h.id}` : h.kind === 'FABRIC' ? `/procurement/fabric/grn/${h.id}` : `/procurement/grns?q=${encodeURIComponent(h.label)}` },
  { type: 'Trim GRN', permission: 'GRN.VIEW', params: 2,
    sql: `SELECT g.id, g.grn_no AS label, sup.party_name AS sub
            FROM trx_trim_grn g LEFT JOIN mst_party sup ON sup.id = g.supplier_id
           WHERE g.company_id = ? AND (g.grn_no LIKE ? OR g.supplier_dc_no LIKE ?)
           ORDER BY g.id DESC LIMIT 5`,
    to: (h) => `/procurement/trim/grn/${h.id}` },
  { type: 'Fabric', permission: 'MATERIAL.VIEW', params: 2,
    sql: `SELECT f.id, f.fabric_name AS label, f.fabric_code AS sub FROM mst_fabric f
           WHERE f.company_id = ? AND f.is_deleted = 0 AND (f.fabric_code LIKE ? OR f.fabric_name LIKE ?)
           ORDER BY f.id DESC LIMIT 5`,
    to: (h) => `/masters/fabrics/${h.id}` },
  { type: 'Yarn', permission: 'MATERIAL.VIEW', params: 2,
    sql: `SELECT y.id, y.yarn_name AS label, y.yarn_code AS sub FROM mst_yarn y
           WHERE y.company_id = ? AND y.is_deleted = 0 AND (y.yarn_code LIKE ? OR y.yarn_name LIKE ?)
           ORDER BY y.id DESC LIMIT 5`,
    to: (h) => `/masters/yarns/${h.id}` },
  { type: 'Business Partner', permission: 'PARTY.VIEW', params: 3,
    sql: `SELECT p.id, p.party_name AS label, p.party_code AS sub FROM mst_party p
           WHERE p.company_id = ? AND p.is_deleted = 0 AND (p.party_name LIKE ? OR p.party_code LIKE ? OR p.short_name LIKE ?)
           ORDER BY p.party_name LIMIT 5`,
    to: (h) => `/masters/parties/${h.id}` },
  { type: 'Quotation', permission: 'QUOTATION.VIEW', params: 2,
    sql: `SELECT q.id, q.quotation_no AS label, COALESCE(b.party_name, q.buyer_name_override) AS sub
            FROM trx_quotation q LEFT JOIN mst_party b ON b.id = q.buyer_id
           WHERE q.company_id = ? AND q.is_deleted = 0 AND (q.quotation_no LIKE ? OR q.job_no LIKE ?)
           ORDER BY q.id DESC LIMIT 5`,
    to: (h) => `/sales/quotations/${h.id}` },
  { type: 'Sample', permission: 'SAMPLE.VIEW', params: 1,
    sql: `SELECT s.id, s.sample_no AS label, CONCAT_WS(' · ', b.party_name, st.style_code) AS sub
            FROM trx_sample s LEFT JOIN mst_party b ON b.id = s.buyer_id LEFT JOIN mst_style st ON st.id = s.style_id
           WHERE s.company_id = ? AND s.is_deleted = 0 AND s.sample_no LIKE ?
           ORDER BY s.id DESC LIMIT 5`,
    to: (h) => `/sales/samples/${h.id}` },
  { type: 'Packing List', permission: 'PACKING.VIEW', params: 3,
    sql: `SELECT pl.id, pl.pl_no AS label, CONCAT_WS(' · ', b.party_name, CONCAT('IO ', pl.io_no)) AS sub
            FROM trx_packing_list pl LEFT JOIN mst_party b ON b.id = pl.buyer_id
           WHERE pl.company_id = ? AND (pl.pl_no LIKE ? OR pl.io_no LIKE ? OR pl.invoice_no LIKE ?)
           ORDER BY pl.id DESC LIMIT 5`,
    to: (h) => `/logistics/packing-lists/${h.id}` },
  { type: 'Dispatch', permission: 'PACKING.VIEW', params: 2,
    sql: `SELECT d.id, d.dispatch_no AS label, CONCAT_WS(' · ', b.party_name, d.vehicle_no) AS sub
            FROM trx_dispatch d LEFT JOIN mst_party b ON b.id = d.buyer_id
           WHERE d.company_id = ? AND (d.dispatch_no LIKE ? OR d.io_no LIKE ?)
           ORDER BY d.id DESC LIMIT 5`,
    to: (h) => `/logistics/dispatches/${h.id}` },
  { type: 'Commercial Invoice', permission: 'EXPORT.VIEW', params: 1,
    sql: `SELECT ci.id, ci.invoice_no AS label, b.party_name AS sub
            FROM trx_commercial_invoice ci LEFT JOIN mst_party b ON b.id = ci.buyer_id
           WHERE ci.company_id = ? AND ci.invoice_no LIKE ?
           ORDER BY ci.id DESC LIMIT 5`,
    to: (h) => `/export/invoices/${h.id}` },
];

/** GET /search?q= — records matching the text, grouped by type, each with the screen that opens it. */
searchRouter.get('/', ah(async (req, res) => {
  const q = z.string().trim().min(2).max(60).safeParse(req.query.q);
  if (!q.success) return res.json({ data: [] });
  const user = req.user!;
  const like = `%${q.data.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const sources = SOURCES.filter((s) => user.isSuperAdmin || user.permissions.has(s.permission));
  const results = await Promise.all(sources.map(async (s) => {
    const rows = await query<Hit>(s.sql, [user.companyId, ...Array(s.params).fill(like)]);
    return rows.map((h) => ({ type: s.type, id: h.id, label: h.label, sub: h.sub || null, to: s.to(h) }));
  }));
  res.json({ data: results.flat() });
}));
