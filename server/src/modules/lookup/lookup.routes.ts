import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';

export const lookupRouter = Router();

/**
 * Read-only option lists for dropdowns. Authenticated but not permission-gated:
 * these are reference labels, and gating them would break every form whose user
 * can create the parent record but not manage the referenced master.
 */
type LookupDef = { sql: string; scoped: boolean };

const LOOKUPS: Record<string, LookupDef> = {
  countries:   { sql: `SELECT id, iso2, iso3, name AS label, dial_code FROM cfg_country WHERE is_active=1 ORDER BY name`, scoped: false },
  currencies:  { sql: `SELECT id, code, name AS label, symbol, decimal_place FROM cfg_currency WHERE is_active=1 ORDER BY code`, scoped: false },
  uoms:        { sql: `SELECT id, code, name AS label, uom_type FROM cfg_uom WHERE is_active=1 ORDER BY code`, scoped: false },

  branches:    { sql: `SELECT id, branch_code AS code, branch_name AS label FROM mst_branch WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY branch_name`, scoped: true },
  divisions:   { sql: `SELECT id, division_code AS code, division_name AS label, billing_name, process_type FROM mst_division WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY division_name`, scoped: true },
  units:       { sql: `SELECT id, unit_code AS code, unit_name AS label, unit_type FROM mst_unit WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY unit_name`, scoped: true },
  warehouses:  { sql: `SELECT id, warehouse_code AS code, warehouse_name AS label, warehouse_type FROM mst_warehouse WHERE company_id=? AND is_active=1 ORDER BY warehouse_name`, scoped: true },
  'financial-years': { sql: `SELECT id, fy_code AS code, fy_code AS label, start_date, end_date, is_current FROM mst_financial_year WHERE company_id=? ORDER BY start_date DESC`, scoped: true },

  buyers:      { sql: `SELECT id, party_code AS code, party_name AS label, legal_name, io_prefix, currency_id, country_id, payment_terms FROM mst_party WHERE company_id=? AND is_buyer=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  customers:   { sql: `SELECT id, party_code AS code, party_name AS label, legal_name, io_prefix, currency_id, country_id, payment_terms FROM mst_party WHERE company_id=? AND (is_buyer=1 OR is_vendor=1) AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  suppliers:   { sql: `SELECT id, party_code AS code, party_name AS label, currency_id FROM mst_party WHERE company_id=? AND is_supplier=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  vendors:     { sql: `SELECT id, party_code AS code, party_name AS label FROM mst_party WHERE company_id=? AND is_vendor=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  agents:      { sql: `SELECT id, party_code AS code, party_name AS label FROM mst_party WHERE company_id=? AND is_agent=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  merchandisers: { sql: `SELECT id, party_code AS code, party_name AS label, group_code FROM mst_party WHERE company_id=? AND is_merchandiser=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  parties:     { sql: `SELECT p.id, p.party_code AS code, p.party_name AS label, p.is_buyer, p.is_supplier, p.is_vendor, p.is_agent, p.is_merchandiser, p.gstin,
       (SELECT CONCAT_WS(', ', pa.address_line1, pa.address_line2, pa.city, pa.state, pa.pincode, pc.name)
          FROM mst_party_address pa
          LEFT JOIN cfg_country pc ON pc.id = pa.country_id
         WHERE pa.party_id = p.id AND pa.is_active = 1
         ORDER BY pa.is_default DESC, pa.id ASC LIMIT 1) AS default_address
  FROM mst_party p WHERE p.company_id=? AND p.is_active=1 AND p.is_deleted=0 ORDER BY p.party_name`, scoped: true },

  colors:      { sql: `SELECT id, color_code AS code, color_name AS label, hex_value FROM mst_color WHERE company_id=? AND is_active=1 ORDER BY color_name`, scoped: true },
  'size-groups': { sql: `SELECT id, group_code AS code, group_name AS label, category, gender, description, (SELECT COUNT(*) FROM mst_size s WHERE s.size_group_id = mst_size_group.id AND s.is_active=1) AS size_count FROM mst_size_group WHERE company_id=? AND is_active=1 ORDER BY group_name`, scoped: true },
  sizes:         { sql: `SELECT sz.id, sz.size_code AS code, sz.size_label AS label, sz.sort_order, sz.size_code, sz.size_label, sz.body_measurement, g.group_name, sz.size_group_id FROM mst_size sz JOIN mst_size_group g ON g.id=sz.size_group_id WHERE g.company_id=? AND sz.is_active=1 ORDER BY g.group_name, sz.sort_order, sz.id`, scoped: true },
  'sizes-all':   { sql: `SELECT sz.id, sz.size_code AS code, CONCAT(sz.size_label,' (',g.group_name,')') AS label, sz.sort_order, sz.size_code, sz.size_label, sz.body_measurement, g.group_name, sz.size_group_id FROM mst_size sz JOIN mst_size_group g ON g.id=sz.size_group_id WHERE g.company_id=? AND sz.is_active=1 ORDER BY g.group_name, sz.sort_order, sz.id`, scoped: true },
  compositions:{ sql: `SELECT id, composition_code AS code, description AS label FROM mst_composition WHERE company_id=? AND is_active=1 ORDER BY composition_code`, scoped: true },
  gsm:         { sql: `SELECT id, gsm_value AS code, CONCAT(gsm_value,' GSM') AS label FROM mst_gsm WHERE company_id=? AND is_active=1 ORDER BY gsm_value`, scoped: true },
  dias:        { sql: `SELECT id, dia_value AS code, CONCAT(dia_value,'\" Dia') AS label FROM mst_dia WHERE company_id=? AND is_active=1 ORDER BY dia_value`, scoped: true },
  'material-categories': { sql: `SELECT id, category_code AS code, category_name AS label, material_type FROM mst_material_category WHERE company_id=? AND is_active=1 ORDER BY category_name`, scoped: true },

  yarns:       { sql: `SELECT id, yarn_code AS code, yarn_name AS label, base_uom, std_rate, yarn_base_id, count_id, count_value, count_type, ply, twist FROM mst_yarn WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY yarn_name`, scoped: true },
  'yarn-counts': { sql: `SELECT id, count_value AS code, CONCAT(count_value, ' ', count_type) AS label, count_value, count_type, sort_order FROM mst_yarn_count WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY sort_order, count_value`, scoped: true },
  'yarn-bases':  { sql: `SELECT id, base_code AS code, base_name AS label, category_id, composition_id, yarn_type, certification, base_uom FROM mst_yarn_base WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY base_name`, scoped: true },
  fabrics:     { sql: `SELECT id, fabric_code AS code, fabric_name AS label, base_uom, std_rate, fabric_base_id, gsm_id, width_cm, dia_inch, gauge FROM mst_fabric WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY fabric_name`, scoped: true },
  'fabric-bases': { sql: `SELECT id, base_code AS code, base_name AS label, fabric_type, knit_structure, composition_id, finish_type, certification, base_uom FROM mst_fabric_base WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY base_name`, scoped: true },
  trims:       { sql: `SELECT id, trim_code AS code, trim_name AS label, base_uom, std_rate, trim_type FROM mst_trim WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY trim_name`, scoped: true },
  products:    { sql: `SELECT id, product_code AS code, product_name AS label, product_type, default_uom FROM mst_product WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY product_name`, scoped: true },
  styles:      { sql: `SELECT id, style_code AS code, style_name AS label, image_url, buyer_id, product_id, size_group_id, fabric_id FROM mst_style WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY style_code`, scoped: true },

  // a job = sales order; shown IO-first. Picking it fills IO / style / buyer PO on the screens that ask for them.
  'sales-orders': { sql: `SELECT so.id, so.so_no AS code,
      CONCAT(COALESCE(NULLIF(so.io_no, ''), so.so_no), IF(NULLIF(so.io_no, '') IS NULL, '', CONCAT(' (', so.so_no, ')')), IF(COALESCE(so.buyer_po_no, '') = '', '', CONCAT(' — ', so.buyer_po_no))) AS label,
      so.so_no, so.io_no, COALESCE(NULLIF(so.io_no, ''), so.so_no) AS job_no, so.buyer_po_no, so.buyer_id, so.currency_id,
      (SELECT sol.style_id FROM trx_sales_order_line sol WHERE sol.so_id = so.id ORDER BY sol.id LIMIT 1) AS style_id,
      (SELECT SUM(sol.order_qty) FROM trx_sales_order_line sol WHERE sol.so_id = so.id) AS order_qty
    FROM trx_sales_order so WHERE so.company_id=? AND so.is_deleted=0 ORDER BY so.so_date DESC, so.id DESC LIMIT 500`, scoped: true },
  // SO lines carry the garment part chosen next to the colour; downstream
  // screens use this to link a document to its line and prefill the part.
  'sales-order-lines': { sql: `SELECT sol.id, sol.id AS code,
      CONCAT(COALESCE(so.io_no, so.so_no), ' / ', COALESCE(st.style_code,''), COALESCE(CONCAT(' ', c.color_name),''),
             COALESCE(CONCAT(' [', sol.part_name, ']'),'')) AS label,
      sol.so_id, so.so_no, so.io_no, sol.style_id, sol.color_id, sol.part_name, sol.order_qty
    FROM trx_sales_order_line sol
    JOIN trx_sales_order so ON so.id = sol.so_id
    LEFT JOIN mst_style st ON st.id = sol.style_id
    LEFT JOIN mst_color c ON c.id = sol.color_id
   WHERE so.company_id=? AND so.is_deleted=0
   ORDER BY so.so_date DESC, sol.id LIMIT 500`, scoped: true },
  'production-orders': { sql: `SELECT p.id, p.po_prod_no AS code, CONCAT(p.po_prod_no, IF(so.id IS NULL, '', CONCAT(' · ', COALESCE(NULLIF(so.io_no, ''), so.so_no)))) AS label, p.so_id, p.style_id, p.order_qty,
      so.io_no, COALESCE(NULLIF(so.io_no, ''), so.so_no) AS job_no, so.buyer_po_no
    FROM trx_production_order p LEFT JOIN trx_sales_order so ON so.id = p.so_id WHERE p.company_id=? ORDER BY p.id DESC LIMIT 500`, scoped: true },
  'prod-orders': { sql: `SELECT id, po_prod_no AS code, po_prod_no AS label, so_id, style_id, order_qty FROM trx_production_order WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'purchase-orders': { sql: `SELECT id, po_no AS code, po_no AS label, supplier_id, currency_id FROM trx_purchase_order WHERE company_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 500`, scoped: true },
  'commercial-invoices': { sql: `SELECT id, invoice_no AS code, invoice_no AS label, buyer_id, currency_id, total_value FROM trx_commercial_invoice WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'export-invoices': { sql: `SELECT id, invoice_no AS code, invoice_no AS label, buyer_id, currency_id, total_value FROM trx_commercial_invoice WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  packings:    { sql: `SELECT id, pack_no AS code, pack_no AS label, so_id FROM trx_packing WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  dispatches:  { sql: `SELECT id, dispatch_no AS code, dispatch_no AS label, so_id FROM trx_dispatch WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'shipping-bills': { sql: `SELECT id, sb_no AS code, sb_no AS label, invoice_id FROM trx_shipping_bill WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  boms:        { sql: `SELECT id, bom_no AS code, CONCAT(bom_no,' v',version) AS label, style_id FROM trx_bom WHERE company_id=? AND is_active=1 ORDER BY id DESC LIMIT 500`, scoped: true },
  costings:    { sql: `SELECT id, costing_no AS code, costing_no AS label, style_id, fob_price FROM trx_costing WHERE company_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 500`, scoped: true },
  enquiries:   { sql: `SELECT id, enquiry_no AS code, enquiry_no AS label, buyer_id FROM trx_enquiry WHERE company_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 500`, scoped: true },
  quotations:  { sql: `SELECT id, quotation_no AS code, quotation_no AS label, buyer_id, currency_id FROM trx_quotation WHERE company_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 500`, scoped: true },
  'mrp-runs':  { sql: `SELECT id, mrp_no AS code, mrp_no AS label, so_id FROM trx_mrp_run WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'production-plans': { sql: `SELECT id, plan_no AS code, plan_no AS label, so_id FROM trx_production_plan WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'knitting-orders': { sql: `SELECT id, order_no AS code, order_no AS label, knitter_id AS supplier_id FROM trx_knitting_order WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'fabric-process-orders': { sql: `SELECT id, order_no AS code, order_no AS label, processor_id AS supplier_id FROM trx_fabric_process_order WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'daily-production-plans': { sql: `SELECT id, plan_no AS code, plan_no AS label, prod_order_id, line_id, shift_id FROM trx_daily_production_plan WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'daily-outputs': { sql: `SELECT id, output_no AS code, output_no AS label, prod_order_id, line_id, shift_id FROM trx_daily_output WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'line-allocations': { sql: `SELECT id, allocation_no AS code, allocation_no AS label, prod_order_id, line_id FROM trx_line_allocation WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'sewing-operations': { sql: `SELECT id, operation_no AS code, operation_no AS label, prod_order_id, operation_id FROM trx_sewing_operation WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },

  'jobwork-challans': { sql: `SELECT id, challan_no AS code, challan_no AS label, vendor_id, stage_id FROM trx_jobwork_challan WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'jobwork-receipts': { sql: `SELECT id, receipt_no AS code, receipt_no AS label, challan_id, vendor_id FROM trx_jobwork_receipt WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'jobwork-ins': { sql: `SELECT id, jwin_no AS code, jwin_no AS label, customer_id FROM trx_jobwork_in WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'jobwork-invoices': { sql: `SELECT id, invoice_no AS code, invoice_no AS label, party_id, invoice_type FROM trx_jobwork_invoice WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'purchase-returns': { sql: `SELECT id, return_no AS code, return_no AS label, supplier_id, grn_id FROM trx_purchase_return WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'supplier-bills': { sql: `SELECT id, bill_no AS code, bill_no AS label, supplier_id, po_id FROM trx_supplier_bill WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'stock-transfers': { sql: `SELECT id, transfer_no AS code, transfer_no AS label, from_warehouse, to_warehouse FROM trx_stock_transfer WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'fg-receipts': { sql: `SELECT id, COALESCE(receipt_no, fg_receipt_no) AS code, COALESCE(receipt_no, fg_receipt_no) AS label, prod_order_id, warehouse_id FROM trx_fg_receipt WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'production-costs': { sql: `SELECT id, cost_no AS code, cost_no AS label, prod_order_id, style_id FROM trx_production_cost WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },

  'sewing-lines': { sql: `SELECT id, line_code AS code, line_name AS label, unit_id, capacity_pcs, manpower, supervisor_name, floor_name FROM cfg_sewing_line WHERE company_id=? AND is_active=1 ORDER BY line_code`, scoped: true },
  'checking-lines': { sql: `SELECT id, line_code AS code, line_name AS label, unit_id, capacity_pcs, manpower, supervisor_name, floor_name FROM cfg_checking_line WHERE company_id=? AND is_active=1 ORDER BY line_code`, scoped: true },
  'ironing-lines': { sql: `SELECT id, line_code AS code, line_name AS label, unit_id, capacity_pcs, manpower, supervisor_name, floor_name FROM cfg_ironing_line WHERE company_id=? AND is_active=1 ORDER BY line_code`, scoped: true },
  'packing-lines': { sql: `SELECT id, line_code AS code, line_name AS label, unit_id, capacity_pcs, manpower, supervisor_name, floor_name FROM cfg_packing_line WHERE company_id=? AND is_active=1 ORDER BY line_code`, scoped: true },
  shifts: { sql: `SELECT id, shift_code AS code, shift_name AS label, start_time, end_time FROM cfg_shift WHERE company_id=? AND is_active=1 ORDER BY shift_code`, scoped: true },
  'delay-reasons': { sql: `SELECT id, reason_code AS code, reason_name AS label, category FROM cfg_delay_reason WHERE company_id=? AND is_active=1 ORDER BY reason_name`, scoped: true },
  'sewing-operation-masters': { sql: `SELECT id, operation_code AS code, operation_name AS label, smv FROM cfg_sewing_operation_master WHERE company_id=? AND is_active=1 ORDER BY sort_order, id`, scoped: true },

  'trim-grns': { sql: `SELECT id, grn_no AS code, grn_no AS label, po_id, supplier_id, net_amount FROM trx_trim_grn WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  grns: { sql: `SELECT id, grn_no AS code, grn_no AS label, po_id, supplier_id FROM trx_grn WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'gate-inwards': { sql: `SELECT id, entry_no AS code, entry_no AS label, party_id, vehicle_no, supplier_dc_no, supplier_inv_no, material_type, gross_weight_kg, package_count, warehouse_id, status FROM trx_gate_inward WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'gate-outwards': { sql: `SELECT id, pass_no AS code, pass_no AS label, party_id, vehicle_no FROM trx_gate_outward WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'qc-inspections': { sql: `SELECT id, qc_no AS code, qc_no AS label, prod_order_id, stage_id FROM trx_qc_inspection WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  vouchers: { sql: `SELECT id, voucher_no AS code, voucher_no AS label, voucher_date, total_amount FROM trx_voucher WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'bank-accounts': { sql: `SELECT id, account_code AS code, account_name AS label FROM mst_ledger_account WHERE company_id=? AND is_bank=1 AND is_active=1 ORDER BY account_name`, scoped: true },
  'cert-types': { sql: `SELECT id, cert_code AS code, cert_name AS label FROM mst_certificate_type WHERE company_id=? AND is_active=1 ORDER BY cert_name`, scoped: true },

  'process-stages': { sql: `SELECT id, stage_code AS code, stage_name AS label, sort_order FROM cfg_process_stage WHERE company_id=? AND is_active=1 ORDER BY sort_order`, scoped: true },
  defects:     { sql: `SELECT id, defect_code AS code, defect_name AS label, defect_type FROM mst_defect WHERE company_id=? AND is_active=1 ORDER BY defect_name`, scoped: true },
  'certificate-types': { sql: `SELECT id, cert_code AS code, cert_name AS label FROM mst_certificate_type WHERE company_id=? AND is_active=1 ORDER BY cert_name`, scoped: true },
  'ledger-accounts': { sql: `SELECT id, account_code AS code, account_name AS label, account_group FROM mst_ledger_account WHERE company_id=? AND is_active=1 ORDER BY account_code`, scoped: true },
  batches:     { sql: `SELECT id, batch_no AS code, CONCAT(batch_no, COALESCE(CONCAT(' / ',shade_lot),'')) AS label, material_type, yarn_id, fabric_id, trim_id FROM mst_batch WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  users:       { sql: `SELECT id, username AS code, full_name AS label FROM mst_user WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY full_name`, scoped: true },
  roles:       { sql: `SELECT id, role_code AS code, role_name AS label FROM mst_role WHERE company_id=? AND is_active=1 ORDER BY role_name`, scoped: true },
};

/** Sizes for one size group — dependent dropdown. */
lookupRouter.get('/sizes/:groupId', ah(async (req, res) => {
  const groupId = z.coerce.number().int().positive().parse(req.params.groupId);
  res.json({ data: await query(
    `SELECT id, size_code AS code, size_label AS label, sort_order
       FROM mst_size WHERE size_group_id = ? AND is_active = 1 ORDER BY sort_order, id`, [groupId]) });
}));

/** Statuses for one domain. */
lookupRouter.get('/statuses/:domain', ah(async (req, res) => {
  const domain = String(req.params.domain ?? '').trim();
  if (!domain) return res.json({ data: [] });
  res.json({ data: await query(
    `SELECT id, code, label, sort_order, is_terminal FROM cfg_status
      WHERE domain = ? AND is_active = 1 ORDER BY sort_order, id`, [domain]) });
}));

/** SKUs for one style — used by size grids and packing. */
lookupRouter.get('/style-skus/:styleId', ah(async (req, res) => {
  const styleId = z.coerce.number().int().positive().parse(req.params.styleId);
  res.json({ data: await query(
    `SELECT k.id, k.sku_code, k.barcode, k.color_id, k.size_id,
            c.color_name, c.hex_value, sz.size_code, sz.size_label, sz.sort_order
       FROM mst_style_sku k
       JOIN mst_color c ON c.id = k.color_id
       JOIN mst_size sz ON sz.id = k.size_id
      WHERE k.style_id = ? AND k.is_active = 1
      ORDER BY c.color_name, sz.sort_order`, [styleId]) });
}));

/** Colorways mapped to one style. */
lookupRouter.get('/style-colors/:styleId', ah(async (req, res) => {
  const styleId = z.coerce.number().int().positive().parse(req.params.styleId);
  res.json({ data: await query(
    `SELECT c.id, c.color_code AS code, c.color_name AS label, c.hex_value
       FROM map_style_color sc JOIN mst_color c ON c.id = sc.color_id
      WHERE sc.style_id = ? ORDER BY c.color_name`, [styleId]) });
}));

/**
 * Colours and sizes actually ordered on one sales order (optionally one style
 * of it) — drives size-/colour-wise BOM lines so only the order's own sizes
 * and colours are offered, never the whole master.
 */
lookupRouter.get('/so-size-colors/:soId', ah(async (req, res) => {
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const styleId = req.query.style_id ? z.coerce.number().int().positive().parse(req.query.style_id) : null;
  const so = await query<{ id: number }>(
    `SELECT id FROM trx_sales_order WHERE id = ? AND company_id = ? AND is_deleted = 0`,
    [soId, req.user!.companyId]);
  if (!so.length) throw NotFound('Sales order not found');

  const styleSql = styleId ? ' AND l.style_id = ?' : '';
  const p = styleId ? [soId, styleId] : [soId];
  const [colors, sizes] = await Promise.all([
    query(
      `SELECT c.id, c.color_code AS code, c.color_name AS label, c.hex_value
         FROM mst_color c
        WHERE c.id IN (
                SELECT k.color_id
                  FROM trx_sales_order_sku ss
                  JOIN trx_sales_order_line l ON l.id = ss.so_line_id
                  JOIN mst_style_sku k ON k.id = ss.sku_id
                 WHERE l.so_id = ?${styleSql} AND ss.qty > 0
                UNION
                SELECT l.color_id FROM trx_sales_order_line l
                 WHERE l.so_id = ?${styleSql} AND l.color_id IS NOT NULL)
        ORDER BY c.color_name`, [...p, ...p]),
    query(
      `SELECT sz.id, sz.size_code AS code, sz.size_label AS label, sz.sort_order
         FROM mst_size sz
        WHERE sz.id IN (
                SELECT k.size_id
                  FROM trx_sales_order_sku ss
                  JOIN trx_sales_order_line l ON l.id = ss.so_line_id
                  JOIN mst_style_sku k ON k.id = ss.sku_id
                 WHERE l.so_id = ?${styleSql} AND ss.qty > 0)
        ORDER BY sz.sort_order, sz.id`, p),
  ]);
  res.json({ data: { colors, sizes } });
}));

/** Open PO lines for multiple POs or single PO via query parameter ?poIds=1,2,3 */
lookupRouter.get('/po-lines', ah(async (req, res) => {
  const poIdsStr = String(req.query.poIds || '');
  const ids = poIdsStr.split(',').map(Number).filter((n) => n > 0);
  if (!ids.length) {
    return res.json({ data: [] });
  }
  const placeholders = ids.map(() => '?').join(',');
  const lines = await query(
    `SELECT pol.*, y.yarn_name, fb.fabric_name, tr.trim_name, c.color_name, u.code AS uom_code,
            pol.qty - pol.received_qty AS pending_qty, po.po_no
       FROM trx_purchase_order_line pol
       JOIN trx_purchase_order po ON po.id = pol.po_id
       LEFT JOIN mst_yarn y ON y.id = pol.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = pol.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = pol.trim_id
       LEFT JOIN mst_color c ON c.id = pol.color_id
       LEFT JOIN cfg_uom u ON u.id = pol.uom_id
      WHERE pol.po_id IN (${placeholders}) ORDER BY pol.po_id, pol.id`, ids);
  res.json({ data: lines });
}));

/** GRN lines for one or more GRNs (used by Bills Inward to auto-fill items) */
lookupRouter.get('/grn-lines', ah(async (req, res) => {
  const grnIdsStr = String(req.query.grnIds || '');
  const ids = grnIdsStr.split(',').map(Number).filter((n) => n > 0);
  if (!ids.length) {
    return res.json({ data: [] });
  }
  const placeholders = ids.map(() => '?').join(',');
  const companyId = req.user!.companyId;

  const standardLines = await query<any>(
    `SELECT gl.id AS grn_line_id, gl.grn_id, gl.po_id, gl.po_line_id, gl.material_type,
            gl.received_qty, gl.accepted_qty, gl.rate, gl.taxable_amount, gl.gst_rate, gl.total_amount,
            gl.lot_no, gl.no_of_rolls, gl.received_weight,
            gl.color_name, gl.shade_code, gl.pantone_spec,
            COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name, 'Material') AS description,
            gl.uom_id, u.code AS uom_code, COALESCE(y.hsn_code, fb.hsn_code, tr.hsn_code) AS hsn_code, gl.yarn_count_str,
            g.grn_no, g.supplier_id, g.supplier_dc_no, g.supplier_inv_no, g.po_id AS header_po_id, g.gate_inward_id, g.is_interstate,
            g.freight_charges AS grn_freight, g.other_charges AS grn_other, g.other_charges_label AS grn_other_label, g.other_charges_sign AS grn_other_sign,
            po.po_no
       FROM trx_grn_line gl
       JOIN trx_grn g ON g.id = gl.grn_id
       LEFT JOIN trx_purchase_order po ON po.id = gl.po_id OR po.id = g.po_id
       LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = gl.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = gl.trim_id
       LEFT JOIN cfg_uom u ON u.id = gl.uom_id
      WHERE g.company_id = ? AND gl.grn_id IN (${placeholders})
      ORDER BY gl.grn_id, gl.id`, [companyId, ...ids]
  );

  // trim GRNs are a separate table (their ids overlap trx_grn ids) — only when asked for with trim=1
  const trimLines = req.query.trim !== '1' ? [] : await query<any>(
    `SELECT tgl.id AS grn_line_id, tgl.grn_id, tgl.po_id, tgl.po_line_id, 'TRIM' AS material_type,
            tgl.received_qty, tgl.accepted_qty, tgl.rate, tgl.taxable_amount, tgl.gst_rate, tgl.total_amount,
            tgl.internal_lot_no AS lot_no, 0 AS no_of_rolls, 0 AS received_weight,
            tgl.color_name, '' AS shade_code, '' AS pantone_spec,
            COALESCE(tr.trim_name, tgl.specification, 'Trim') AS description,
            tgl.uom_id, u.code AS uom_code, tr.hsn_code,
            tg.grn_no, tg.supplier_id, tg.supplier_dc_no, tg.supplier_inv_no, tg.po_id AS header_po_id,
            tpo.po_no
       FROM trx_trim_grn_line tgl
       JOIN trx_trim_grn tg ON tg.id = tgl.grn_id
       LEFT JOIN trx_trim_po tpo ON tpo.id = tgl.po_id OR tpo.id = tg.po_id
       LEFT JOIN mst_trim tr ON tr.id = tgl.trim_id
       LEFT JOIN cfg_uom u ON u.id = tgl.uom_id
      WHERE tg.company_id = ? AND tgl.grn_id IN (${placeholders})
      ORDER BY tgl.grn_id, tgl.id`, [companyId, ...ids]
  );

  res.json({ data: [...standardLines, ...trimLines] });
}));

/**
 * GET /lookup/bill-grns?supplier_id=&bill_id= — GRNs a supplier bill may pull (client voice note 03-Oct-2026):
 * purchase GRNs (not job-work inward — knitting / fabric / yarn process GRNs are billed in their own process bills)
 * and trim GRNs, not already on another live supplier bill. `bill_id` keeps the bill's own GRNs while editing.
 */
lookupRouter.get('/bill-grns', ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ supplier_id: z.coerce.number().int().positive().optional(), bill_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const other = q.bill_id ?? 0;
  const grns = await query<any>(
    `SELECT g.id, 'GRN' AS kind, g.grn_no, g.grn_date, g.supplier_id, p.party_name AS supplier_name, g.supplier_inv_no, g.supplier_dc_no, po.po_no,
            (SELECT GROUP_CONCAT(DISTINCT gl.material_type) FROM trx_grn_line gl WHERE gl.grn_id = g.id) AS materials,
            (SELECT COALESCE(SUM(gl.accepted_qty * gl.rate), 0) FROM trx_grn_line gl WHERE gl.grn_id = g.id) AS value
       FROM trx_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      WHERE g.company_id = ? ${q.supplier_id ? 'AND g.supplier_id = ?' : ''}
        AND NOT EXISTS (SELECT 1 FROM trx_process_receipt pr WHERE pr.grn_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM trx_fabric_process_inward i WHERE i.grn_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM trx_yarn_process_inward i WHERE i.grn_id = g.id OR i.reject_grn_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM trx_supplier_bill b WHERE b.company_id = g.company_id AND b.id <> ? AND COALESCE(b.status, '') <> 'CANCELLED'
                          AND (b.grn_id = g.id OR IF(JSON_VALID(b.grn_ids), JSON_CONTAINS(b.grn_ids, CAST(g.id AS JSON)), 0)
                               OR EXISTS (SELECT 1 FROM trx_supplier_bill_line bl WHERE bl.bill_id = b.id AND bl.grn_id = g.id)))
      ORDER BY g.id DESC LIMIT 300`, [cid, ...(q.supplier_id ? [q.supplier_id] : []), other]);
  const trims = await query<any>(
    `SELECT g.id, 'TRIM_GRN' AS kind, g.grn_no, g.grn_date, g.supplier_id, p.party_name AS supplier_name, g.supplier_inv_no, g.supplier_dc_no, NULL AS po_no,
            'TRIM' AS materials, g.net_amount AS value
       FROM trx_trim_grn g LEFT JOIN mst_party p ON p.id = g.supplier_id
      WHERE g.company_id = ? ${q.supplier_id ? 'AND g.supplier_id = ?' : ''}
        AND NOT EXISTS (SELECT 1 FROM trx_supplier_bill b WHERE b.company_id = g.company_id AND b.id <> ? AND COALESCE(b.status, '') <> 'CANCELLED'
                          AND IF(JSON_VALID(b.trim_grn_ids), JSON_CONTAINS(b.trim_grn_ids, CAST(g.id AS JSON)), 0))
      ORDER BY g.id DESC LIMIT 300`, [cid, ...(q.supplier_id ? [q.supplier_id] : []), other]).catch(() => []);
  res.json({ data: [...grns, ...trims].map((g) => ({ ...g, label: `${g.grn_no} · ${String(g.grn_date ?? '').slice(0, 10)}${g.po_no ? ` · PO ${g.po_no}` : ''}${g.supplier_inv_no ? ` · inv ${g.supplier_inv_no}` : ''} · ${g.materials ?? ''}` })) });
}));

/** Open PO lines for a single PO — drives GRN entry. */
lookupRouter.get('/po-lines/:poId', ah(async (req, res) => {
  const poId = z.coerce.number().int().positive().parse(req.params.poId);
  res.json({ data: await query(
    `SELECT pol.*, y.yarn_name, fb.fabric_name, tr.trim_name, c.color_name, u.code AS uom_code,
            pol.qty - pol.received_qty AS pending_qty
       FROM trx_purchase_order_line pol
       LEFT JOIN mst_yarn y ON y.id = pol.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = pol.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = pol.trim_id
       LEFT JOIN mst_color c ON c.id = pol.color_id
       LEFT JOIN cfg_uom u ON u.id = pol.uom_id
      WHERE pol.po_id = ? ORDER BY pol.id`, [poId]) });
}));

/** Lines of a sales order — used when creating production orders. */
lookupRouter.get('/so-lines/:soId', ah(async (req, res) => {
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  res.json({ data: await query(
    `SELECT l.*, st.style_code, st.style_name, c.color_name
       FROM trx_sales_order_line l
       LEFT JOIN mst_style st ON st.id = l.style_id
       LEFT JOIN mst_color c ON c.id = l.color_id
      WHERE l.so_id = ? ORDER BY l.id`, [soId]) });
}));

/** Generic named-lookup catch-all — must stay LAST so specific routes above match first. */
lookupRouter.get('/:name', ah(async (req, res) => {
  const name = String(req.params.name);
  const def = LOOKUPS[name];
  if (!def) throw BadRequest(`Unknown lookup: ${name}`);
  const rows = await query(def.sql, def.scoped ? [req.user!.companyId] : []);
  res.json({ data: rows });
}));
