import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest } from '../../core/errors.js';

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
  units:       { sql: `SELECT id, unit_code AS code, unit_name AS label, unit_type FROM mst_unit WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY unit_name`, scoped: true },
  warehouses:  { sql: `SELECT id, warehouse_code AS code, warehouse_name AS label, warehouse_type FROM mst_warehouse WHERE company_id=? AND is_active=1 ORDER BY warehouse_name`, scoped: true },
  'financial-years': { sql: `SELECT id, fy_code AS code, fy_code AS label, start_date, end_date, is_current FROM mst_financial_year WHERE company_id=? ORDER BY start_date DESC`, scoped: true },

  buyers:      { sql: `SELECT id, party_code AS code, party_name AS label, currency_id, country_id, payment_terms FROM mst_party WHERE company_id=? AND is_buyer=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  suppliers:   { sql: `SELECT id, party_code AS code, party_name AS label, currency_id FROM mst_party WHERE company_id=? AND is_supplier=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  vendors:     { sql: `SELECT id, party_code AS code, party_name AS label FROM mst_party WHERE company_id=? AND is_vendor=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  agents:      { sql: `SELECT id, party_code AS code, party_name AS label FROM mst_party WHERE company_id=? AND is_agent=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  merchandisers: { sql: `SELECT id, party_code AS code, party_name AS label FROM mst_party WHERE company_id=? AND is_merchandiser=1 AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },
  parties:     { sql: `SELECT id, party_code AS code, party_name AS label, is_buyer, is_supplier, is_vendor, is_agent, is_merchandiser FROM mst_party WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY party_name`, scoped: true },

  colors:      { sql: `SELECT id, color_code AS code, color_name AS label, hex_value FROM mst_color WHERE company_id=? AND is_active=1 ORDER BY color_name`, scoped: true },
  'size-groups': { sql: `SELECT id, group_code AS code, group_name AS label FROM mst_size_group WHERE company_id=? ORDER BY group_name`, scoped: true },
  compositions:{ sql: `SELECT id, composition_code AS code, description AS label FROM mst_composition WHERE company_id=? AND is_active=1 ORDER BY composition_code`, scoped: true },
  gsm:         { sql: `SELECT id, gsm_value AS code, CONCAT(gsm_value,' GSM') AS label FROM mst_gsm WHERE company_id=? AND is_active=1 ORDER BY gsm_value`, scoped: true },
  'material-categories': { sql: `SELECT id, category_code AS code, category_name AS label, material_type FROM mst_material_category WHERE company_id=? AND is_active=1 ORDER BY category_name`, scoped: true },

  yarns:       { sql: `SELECT id, yarn_code AS code, yarn_name AS label, base_uom, std_rate FROM mst_yarn WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY yarn_name`, scoped: true },
  fabrics:     { sql: `SELECT id, fabric_code AS code, fabric_name AS label, base_uom, std_rate FROM mst_fabric WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY fabric_name`, scoped: true },
  trims:       { sql: `SELECT id, trim_code AS code, trim_name AS label, base_uom, std_rate, trim_type FROM mst_trim WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY trim_name`, scoped: true },
  products:    { sql: `SELECT id, product_code AS code, product_name AS label, product_type, default_uom FROM mst_product WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY product_name`, scoped: true },
  styles:      { sql: `SELECT id, style_code AS code, style_name AS label, image_url, buyer_id, product_id, size_group_id, fabric_id FROM mst_style WHERE company_id=? AND is_active=1 AND is_deleted=0 ORDER BY style_code`, scoped: true },

  'sales-orders': { sql: `SELECT id, so_no AS code, CONCAT(so_no,' — ',COALESCE(buyer_po_no,'')) AS label, buyer_id, currency_id FROM trx_sales_order WHERE company_id=? AND is_deleted=0 ORDER BY so_date DESC LIMIT 500`, scoped: true },
  'production-orders': { sql: `SELECT id, po_prod_no AS code, po_prod_no AS label, so_id, style_id, order_qty FROM trx_production_order WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'purchase-orders': { sql: `SELECT id, po_no AS code, po_no AS label, supplier_id, currency_id FROM trx_purchase_order WHERE company_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 500`, scoped: true },
  'commercial-invoices': { sql: `SELECT id, invoice_no AS code, invoice_no AS label, buyer_id, currency_id, total_value FROM trx_commercial_invoice WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  packings:    { sql: `SELECT id, pack_no AS code, pack_no AS label, so_id FROM trx_packing WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  dispatches:  { sql: `SELECT id, dispatch_no AS code, dispatch_no AS label, so_id FROM trx_dispatch WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'shipping-bills': { sql: `SELECT id, sb_no AS code, sb_no AS label, invoice_id FROM trx_shipping_bill WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  boms:        { sql: `SELECT id, bom_no AS code, CONCAT(bom_no,' v',version) AS label, style_id FROM trx_bom WHERE company_id=? AND is_active=1 ORDER BY id DESC LIMIT 500`, scoped: true },
  costings:    { sql: `SELECT id, costing_no AS code, costing_no AS label, style_id, fob_price FROM trx_costing WHERE company_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 500`, scoped: true },
  enquiries:   { sql: `SELECT id, enquiry_no AS code, enquiry_no AS label, buyer_id FROM trx_enquiry WHERE company_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 500`, scoped: true },
  quotations:  { sql: `SELECT id, quotation_no AS code, quotation_no AS label, buyer_id, currency_id FROM trx_quotation WHERE company_id=? AND is_deleted=0 ORDER BY id DESC LIMIT 500`, scoped: true },
  'mrp-runs':  { sql: `SELECT id, mrp_no AS code, mrp_no AS label, so_id FROM trx_mrp_run WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },
  'production-plans': { sql: `SELECT id, plan_no AS code, plan_no AS label, so_id FROM trx_production_plan WHERE company_id=? ORDER BY id DESC LIMIT 500`, scoped: true },

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

/** Open PO lines for a PO — drives GRN entry. */
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
