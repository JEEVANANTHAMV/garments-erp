import type { ResourceConfig } from '../../core/crud.js';
import { s, f } from './schemas.js';

/**
 * Declarative registry of master-data resources.
 * Each entry becomes a full REST resource: list/get/create/update/delete
 * with RBAC, tenant scoping, soft delete, search, filters and audit.
 */
export const masterResources: ResourceConfig[] = [
  // ------------------------------------------------ Organisation
  {
    path: 'branches', table: 'mst_branch', permission: 'BRANCH', label: 'Branch',
    searchable: ['branch_code', 'branch_name', 'city'],
    sortable: ['branch_code', 'branch_name', 'city', 'created_at'],
    defaultSort: 't.branch_name', filters: ['is_head_office'],
    fields: [
      f('branch_code', s.strReq(20)), f('branch_name', s.strReq(150)),
      f('gstin', s.nullableStr(15)), f('address_line1', s.nullableStr(200)),
      f('city', s.nullableStr(80)), f('state', s.nullableStr(80)),
      f('pincode', s.nullableStr(12)), f('phone', s.nullableStr(40)),
      f('is_head_office', s.bool()), f('is_active', s.bool()),
    ],
  },
  {
    path: 'units', table: 'mst_unit', permission: 'UNIT', label: 'Unit',
    searchable: ['unit_code', 'unit_name', 'city'],
    sortable: ['unit_code', 'unit_name', 'unit_type'],
    defaultSort: 't.unit_name', filters: ['unit_type', 'branch_id'],
    selectExtra: 'b.branch_name', joins: 'LEFT JOIN mst_branch b ON b.id = t.branch_id',
    fields: [
      f('branch_id', s.id()), f('unit_code', s.strReq(20)), f('unit_name', s.strReq(150)),
      f('unit_type', s.enumReq(['CUTTING','STITCHING','PRINTING','EMBROIDERY','WASHING','FINISHING','PACKING','INTEGRATED','WAREHOUSE'])),
      f('capacity_per_day', s.int()), f('address_line1', s.nullableStr(200)),
      f('city', s.nullableStr(80)), f('is_active', s.bool()),
    ],
  },
  {
    path: 'financial-years', table: 'mst_financial_year', permission: 'FINYEAR', label: 'Financial Year',
    searchable: ['fy_code'], sortable: ['fy_code', 'start_date'], defaultSort: 't.start_date',
    softDelete: false, hasIsActive: false, hasAuditCols: false,
    fields: [
      f('fy_code', s.strReq(12)), f('start_date', s.date()), f('end_date', s.date()),
      f('is_current', s.bool()), f('is_closed', s.bool()),
    ],
  },
  {
    path: 'number-series', table: 'cfg_number_series', permission: 'SETTINGS', label: 'Number Series',
    searchable: ['doc_type', 'prefix'], sortable: ['doc_type'], defaultSort: 't.doc_type',
    softDelete: false, hasIsActive: false, hasAuditCols: false, filters: ['doc_type', 'branch_id'],
    fields: [
      f('branch_id', s.id()), f('doc_type', s.strReq(40)), f('fy_id', s.id()),
      f('prefix', s.nullableStr(20)), f('suffix', s.nullableStr(20)),
      f('next_number', s.int()), f('padding', s.int()),
    ],
  },

  // ------------------------------------------------ Business partners
  {
    path: 'parties', table: 'mst_party', permission: 'PARTY', label: 'Business Partner',
    searchable: ['party_code', 'party_name', 'legal_name', 'email', 'gstin', 'pan', 'udyam_no'],
    sortable: ['party_code', 'party_name', 'created_at'], defaultSort: 't.party_name',
    filters: ['is_customer', 'is_buyer', 'is_supplier', 'is_vendor', 'is_agent', 'party_type', 'country_id'],
    selectExtra: 'c.name AS country_name, cur.code AS currency_code',
    joins: 'LEFT JOIN cfg_country c ON c.id = t.country_id LEFT JOIN cfg_currency cur ON cur.id = t.currency_id',
    children: [
      { key: 'addresses', table: 'mst_party_address', fk: 'party_id', fields: [
        f('address_name', s.nullableStr(100)),
        f('address_type', s.enumReq(['REGISTERED','BILLING','SHIPPING','FACTORY','WAREHOUSE'])),
        f('address_line1', s.strReq(200)), f('address_line2', s.nullableStr(200)),
        f('address_line3', s.nullableStr(200)),
        f('city', s.nullableStr(80)), f('district', s.nullableStr(80)),
        f('state', s.nullableStr(80)), f('country_id', s.id()),
        f('pincode', s.nullableStr(12)), f('phone', s.nullableStr(40)),
        f('mobile', s.nullableStr(20)), f('email', s.email()),
        f('remarks', s.nullableStr(255)),
        f('is_default', s.bool()), f('is_active', s.bool()),
      ]},
      { key: 'contacts', table: 'mst_party_contact', fk: 'party_id', fields: [
        f('contact_name', s.strReq(120)), f('designation', s.nullableStr(80)),
        f('department', s.nullableStr(80)),
        f('email', s.email()), f('phone', s.nullableStr(40)), f('mobile', s.nullableStr(20)),
        f('whatsapp_no', s.nullableStr(20)),
        f('is_primary', s.bool()),
        f('is_accounts_contact', s.bool()), f('is_purchase_contact', s.bool()),
        f('is_merchandising_contact', s.bool()),
        f('remarks', s.nullableStr(255)), f('is_active', s.bool()),
      ]},
      { key: 'banks', table: 'mst_party_bank', fk: 'party_id', fields: [
        f('bank_name', s.strReq(150)), f('branch_name', s.nullableStr(150)),
        f('account_name', s.nullableStr(150)),
        f('account_type', s.enum(['CURRENT','SAVINGS','EEFC','OD'])),
        f('account_no', s.nullableStr(40)), f('ifsc_code', s.nullableStr(15)),
        f('swift_code', s.nullableStr(15)), f('iban', s.nullableStr(40)),
        f('micr_code', s.nullableStr(20)),
        f('currency_id', s.id()),
        f('branch_address', s.nullableStr(255)), f('remarks', s.nullableStr(255)),
        f('is_default', s.bool()),
      ]},
    ],
    fields: [
      f('party_code', s.strReq(30)), f('party_name', s.strReq(200)),
      f('legal_name', s.nullableStr(200)), f('short_name', s.nullableStr(80)),
      f('is_customer', s.bool()), f('is_buyer', s.bool()), f('is_supplier', s.bool()),
      f('is_vendor', s.bool()), f('is_agent', s.bool()),
      f('party_type', s.enum(['DOMESTIC','EXPORT','BOTH'])),
      f('country_id', s.id()), f('currency_id', s.id()),
      f('gstin', s.nullableStr(15)), f('pan', s.nullableStr(10)),
      f('tan', s.nullableStr(15)), f('cin', s.nullableStr(30)),
      f('tax_id_foreign', s.nullableStr(40)),
      f('msme_type', s.enum(['MICRO','SMALL','MEDIUM','NA'])),
      f('udyam_no', s.nullableStr(30)), f('udyam_date', s.date()),
      f('iec_no', s.nullableStr(20)),
      f('tds_applicable', s.bool()), f('tds_section', s.nullableStr(30)), f('tds_rate', s.dec()),
      f('tcs_applicable', s.bool()), f('tcs_section', s.nullableStr(30)), f('tcs_rate', s.dec()),
      f('payment_terms', s.nullableStr(120)),
      f('default_incoterm', s.enum(['FOB','CIF','CFR','EXW','DDP','DAP','FCA'])),
      f('default_pol', s.nullableStr(80)), f('default_pod', s.nullableStr(80)),
      f('default_aql', s.nullableStr(10)),
      f('brand_name', s.nullableStr(100)), f('buyer_category', s.nullableStr(50)),
      f('season', s.nullableStr(40)), f('quality_standard', s.nullableStr(80)),
      f('lab_testing_required', s.bool()),
      f('compliance_certifications', s.nullableStr(255)),
      f('packing_instructions', s.text()), f('special_instructions', s.text()),
      // Supplier-specific
      f('supplier_category', s.nullableStr(50)), f('lead_time_days', s.int()),
      f('min_order_qty', s.dec()),
      f('supplier_rating', s.enum(['A','B','C','D','UNRATED'])),
      f('delivery_terms', s.nullableStr(120)), f('quality_agreement', s.bool()),
      f('supplier_remarks', s.nullableStr(500)),
      // Job worker / CMT-specific
      f('jobwork_process', s.nullableStr(120)), f('jobwork_capacity_day', s.int()),
      f('jobwork_rate_basis', s.enum(['PER_PIECE','PER_KG','PER_HOUR','PER_DOZEN','LUMPSUM'])),
      f('jobwork_rate', s.dec()), f('jobwork_gate_terms', s.nullableStr(120)),
      f('jobwork_remarks', s.nullableStr(500)),
      // Buying agent-specific
      f('commission_pct', s.dec()),
      f('commission_basis', s.enum(['FOB','ORDER_VALUE','QTY','INVOICE_VALUE'])),
      f('commission_payout', s.nullableStr(120)), f('agent_territory', s.nullableStr(120)),
      f('agent_remarks', s.nullableStr(500)),
      f('credit_limit', s.dec()), f('credit_days', s.int()),
      f('email', s.email()), f('phone', s.nullableStr(40)), f('website', s.nullableStr(120)),
      f('remarks', s.text()),
      f('is_draft', s.bool()),
      f('is_active', s.bool()),
    ],
  },
  {
    path: 'buyer-requirements', table: 'mst_buyer_requirement', permission: 'PARTY', label: 'Buyer Requirement',
    searchable: ['requirement_name'], sortable: ['requirement_type'], defaultSort: 't.id',
    companyScoped: false, softDelete: false, hasAuditCols: false, filters: ['party_id', 'requirement_type'],
    fields: [
      f('party_id', s.idReq()),
      f('requirement_type', s.enumReq(['COMPLIANCE_AUDIT','SOCIAL_AUDIT','LAB_TEST','PACKAGING','LABELLING','CARTON_MARK','CERTIFICATION'])),
      f('requirement_name', s.strReq(150)), f('description', s.text()),
      f('is_mandatory', s.bool()), f('is_active', s.bool()),
    ],
  },
  {
    path: 'agent-commissions', table: 'mst_agent_commission', permission: 'PARTY', label: 'Agent Commission',
    sortable: ['effective_from'], defaultSort: 't.id',
    companyScoped: false, softDelete: false, hasAuditCols: false, filters: ['party_id'],
    fields: [
      f('party_id', s.idReq()), f('commission_pct', s.decReq()),
      f('applies_to', s.enum(['ORDER_VALUE','FOB','QTY'])), f('currency_id', s.id()),
      f('effective_from', s.date()), f('effective_to', s.date()), f('is_active', s.bool()),
    ],
  },

  // ------------------------------------------------ Product masters
  {
    path: 'colors', table: 'mst_color', permission: 'COLOR', label: 'Color',
    searchable: ['color_code', 'color_name', 'pantone_ref'],
    sortable: ['color_code', 'color_name'], defaultSort: 't.color_name',
    softDelete: false, hasAuditCols: false,
    fields: [
      f('color_code', s.strReq(30)), f('color_name', s.strReq(80)),
      f('pantone_ref', s.nullableStr(40)), f('hex_value', s.nullableStr(7)), f('is_active', s.bool()),
    ],
  },
  {
    path: 'size-groups', table: 'mst_size_group', permission: 'SIZE', label: 'Size Group',
    searchable: ['group_code', 'group_name'], sortable: ['group_code'], defaultSort: 't.group_name',
    softDelete: false, hasIsActive: false, hasAuditCols: false,
    children: [
      { key: 'sizes', table: 'mst_size', fk: 'size_group_id', orderBy: 'sort_order, id', fields: [
        f('size_code', s.strReq(20)), f('size_label', s.strReq(40)),
        f('sort_order', s.int()), f('is_active', s.bool()),
      ]},
    ],
    fields: [f('group_code', s.strReq(30)), f('group_name', s.strReq(80))],
  },
  {
    path: 'sizes', table: 'mst_size', permission: 'SIZE', label: 'Size',
    searchable: ['size_code', 'size_label'], sortable: ['sort_order', 'size_code'],
    defaultSort: 't.sort_order', companyScoped: false, softDelete: false, hasAuditCols: false,
    filters: ['size_group_id'],
    fields: [
      f('size_group_id', s.idReq()), f('size_code', s.strReq(20)),
      f('size_label', s.strReq(40)), f('sort_order', s.int()), f('is_active', s.bool()),
    ],
  },
  {
    path: 'compositions', table: 'mst_composition', permission: 'MATERIAL', label: 'Composition',
    searchable: ['composition_code', 'description'], sortable: ['composition_code'],
    defaultSort: 't.composition_code', softDelete: false, hasAuditCols: false,
    children: [
      { key: 'details', table: 'mst_composition_detail', fk: 'composition_id', fields: [
        f('fibre_name', s.strReq(60)), f('percentage', s.decReq()),
      ]},
    ],
    fields: [
      f('composition_code', s.strReq(30)), f('description', s.strReq(150)), f('is_active', s.bool()),
    ],
  },
  {
    path: 'gsm', table: 'mst_gsm', permission: 'MATERIAL', label: 'GSM',
    sortable: ['gsm_value'], defaultSort: 't.gsm_value', softDelete: false, hasAuditCols: false,
    fields: [f('gsm_value', s.intReq()), f('tolerance', s.int()), f('is_active', s.bool())],
  },
  {
    path: 'material-categories', table: 'mst_material_category', permission: 'MATERIAL', label: 'Material Category',
    searchable: ['category_code', 'category_name'], sortable: ['category_code'],
    defaultSort: 't.category_name', softDelete: false, hasAuditCols: false,
    filters: ['material_type', 'parent_id'],
    fields: [
      f('parent_id', s.id()), f('category_code', s.strReq(30)), f('category_name', s.strReq(100)),
      f('material_type', s.enumReq(['YARN','FABRIC','TRIM','ACCESSORY','PACKING','CONSUMABLE'])),
      f('is_active', s.bool()),
    ],
  },
  {
    path: 'yarns', table: 'mst_yarn', permission: 'MATERIAL', label: 'Yarn',
    searchable: ['yarn_code', 'yarn_name', 'count_value'], sortable: ['yarn_code', 'yarn_name'],
    defaultSort: 't.yarn_name', filters: ['category_id', 'yarn_type', 'composition_id'],
    selectExtra: 'u.code AS uom_code, comp.description AS composition_desc, cat.category_name',
    joins: `LEFT JOIN cfg_uom u ON u.id = t.base_uom
            LEFT JOIN mst_composition comp ON comp.id = t.composition_id
            LEFT JOIN mst_material_category cat ON cat.id = t.category_id`,
    fields: [
      f('yarn_code', s.strReq(40)), f('yarn_name', s.strReq(150)), f('category_id', s.id()),
      f('count_value', s.nullableStr(20)), f('count_type', s.enum(['Ne','Nm','Denier','Tex'])),
      f('composition_id', s.id()), f('ply', s.int()),
      f('yarn_type', s.enum(['COMBED','CARDED','OE','COMPACT','MELANGE','SLUB','OTHER'])),
      f('hsn_code', s.nullableStr(10)), f('base_uom', s.idReq()),
      f('std_rate', s.dec()), f('is_active', s.bool()),
    ],
  },
  {
    path: 'fabrics', table: 'mst_fabric', permission: 'MATERIAL', label: 'Fabric',
    searchable: ['fabric_code', 'fabric_name', 'knit_structure'],
    sortable: ['fabric_code', 'fabric_name'], defaultSort: 't.fabric_name',
    filters: ['category_id', 'fabric_type', 'gsm_id', 'composition_id'],
    selectExtra: 'u.code AS uom_code, g.gsm_value, comp.description AS composition_desc, y.yarn_name',
    joins: `LEFT JOIN cfg_uom u ON u.id = t.base_uom
            LEFT JOIN mst_gsm g ON g.id = t.gsm_id
            LEFT JOIN mst_composition comp ON comp.id = t.composition_id
            LEFT JOIN mst_yarn y ON y.id = t.yarn_id`,
    fields: [
      f('fabric_code', s.strReq(40)), f('fabric_name', s.strReq(150)), f('category_id', s.id()),
      f('fabric_type', s.enumReq(['KNIT','WOVEN','NONWOVEN'])), f('knit_structure', s.nullableStr(60)),
      f('composition_id', s.id()), f('gsm_id', s.id()), f('width_cm', s.dec()), f('dia_inch', s.dec()),
      f('yarn_id', s.id()), f('finish_type', s.nullableStr(80)), f('hsn_code', s.nullableStr(10)),
      f('base_uom', s.idReq()), f('std_rate', s.dec()), f('is_active', s.bool()),
    ],
  },
  {
    path: 'trims', table: 'mst_trim', permission: 'MATERIAL', label: 'Trim',
    searchable: ['trim_code', 'trim_name', 'specification'], sortable: ['trim_code', 'trim_name'],
    defaultSort: 't.trim_name', filters: ['category_id', 'trim_type'],
    selectExtra: 'u.code AS uom_code, cat.category_name',
    joins: `LEFT JOIN cfg_uom u ON u.id = t.base_uom
            LEFT JOIN mst_material_category cat ON cat.id = t.category_id`,
    fields: [
      f('trim_code', s.strReq(40)), f('trim_name', s.strReq(150)), f('category_id', s.id()),
      f('trim_type', s.enumReq(['BUTTON','ZIPPER','LABEL','THREAD','ELASTIC','DRAWCORD','HANGTAG','STICKER','POLYBAG','CARTON','HANGER','TAPE','RIVET','VELCRO','LACE','OTHER'])),
      f('specification', s.nullableStr(200)), f('hsn_code', s.nullableStr(10)),
      f('base_uom', s.idReq()), f('std_rate', s.dec()), f('is_active', s.bool()),
    ],
  },
  {
    path: 'products', table: 'mst_product', permission: 'PRODUCT', label: 'Product',
    searchable: ['product_code', 'product_name'], sortable: ['product_code', 'product_name'],
    defaultSort: 't.product_name', filters: ['product_type', 'gender'],
    selectExtra: 'u.code AS uom_code', joins: 'LEFT JOIN cfg_uom u ON u.id = t.default_uom',
    fields: [
      f('product_code', s.strReq(40)), f('product_name', s.strReq(150)),
      f('product_type', s.enumReq(['TSHIRT','POLO','SWEATSHIRT','HOODIE','SHORTS','TRACKPANT','LEGGING','INNERWEAR','NIGHTWEAR','KIDSWEAR','JACKET','OTHER'])),
      f('gender', s.enum(['MEN','WOMEN','UNISEX','BOYS','GIRLS','INFANT'])),
      f('hsn_code', s.nullableStr(10)), f('default_uom', s.idReq()), f('is_active', s.bool()),
    ],
  },

  // ------------------------------------------------ Warehouse
  {
    path: 'warehouses', table: 'mst_warehouse', permission: 'WAREHOUSE', label: 'Warehouse',
    searchable: ['warehouse_code', 'warehouse_name'], sortable: ['warehouse_code', 'warehouse_name'],
    defaultSort: 't.warehouse_name', softDelete: false, hasAuditCols: false,
    filters: ['warehouse_type', 'unit_id'],
    selectExtra: 'un.unit_name', joins: 'LEFT JOIN mst_unit un ON un.id = t.unit_id',
    children: [
      { key: 'bins', table: 'mst_warehouse_bin', fk: 'warehouse_id', fields: [
        f('bin_code', s.strReq(30)), f('rack', s.nullableStr(20)), f('is_active', s.bool()),
      ]},
    ],
    fields: [
      f('unit_id', s.id()), f('warehouse_code', s.strReq(20)), f('warehouse_name', s.strReq(120)),
      f('warehouse_type', s.enumReq(['RAW_MATERIAL','WIP','FINISHED_GOODS','TRIMS','REJECTION','BONDED'])),
      f('is_active', s.bool()),
    ],
  },
  {
    path: 'warehouse-bins', table: 'mst_warehouse_bin', permission: 'WAREHOUSE', label: 'Bin',
    searchable: ['bin_code', 'rack'], sortable: ['bin_code'], defaultSort: 't.bin_code',
    companyScoped: false, softDelete: false, hasAuditCols: false, filters: ['warehouse_id'],
    selectExtra: 'w.warehouse_name', joins: 'LEFT JOIN mst_warehouse w ON w.id = t.warehouse_id',
    fields: [
      f('warehouse_id', s.idReq()), f('bin_code', s.strReq(30)),
      f('rack', s.nullableStr(20)), f('is_active', s.bool()),
    ],
  },
  {
    path: 'batches', table: 'mst_batch', permission: 'INVENTORY', label: 'Batch',
    searchable: ['batch_no', 'shade_lot'], sortable: ['batch_no', 'received_date'],
    defaultSort: 't.id', softDelete: false, hasIsActive: false, hasAuditCols: false,
    filters: ['material_type', 'supplier_id', 'yarn_id', 'fabric_id', 'trim_id'],
    fields: [
      f('batch_no', s.strReq(50)),
      f('material_type', s.enumReq(['YARN','FABRIC','TRIM','FINISHED'])),
      f('yarn_id', s.id()), f('fabric_id', s.id()), f('trim_id', s.id()), f('supplier_id', s.id()),
      f('mfg_date', s.date()), f('received_date', s.date()),
      f('shade_lot', s.nullableStr(40)), f('remarks', s.nullableStr(255)),
    ],
  },

  // ------------------------------------------------ Quality / process config
  {
    path: 'defects', table: 'mst_defect', permission: 'QC', label: 'Defect',
    searchable: ['defect_code', 'defect_name'], sortable: ['defect_code', 'defect_type'],
    defaultSort: 't.defect_name', softDelete: false, hasAuditCols: false,
    filters: ['defect_type', 'stage'],
    fields: [
      f('defect_code', s.strReq(30)), f('defect_name', s.strReq(120)),
      f('defect_type', s.enumReq(['CRITICAL','MAJOR','MINOR'])),
      f('stage', s.nullableStr(40)), f('is_active', s.bool()),
    ],
  },
  {
    path: 'process-stages', table: 'cfg_process_stage', permission: 'PRODUCTION', label: 'Process Stage',
    searchable: ['stage_code', 'stage_name'], sortable: ['sort_order', 'stage_code'],
    defaultSort: 't.sort_order', softDelete: false, hasAuditCols: false,
    fields: [
      f('stage_code', s.strReq(30)), f('stage_name', s.strReq(80)), f('sort_order', s.int()),
      f('is_outsourceable', s.bool()), f('is_active', s.bool()),
    ],
  },
  {
    path: 'certificate-types', table: 'mst_certificate_type', permission: 'EXPORT', label: 'Certificate Type',
    searchable: ['cert_code', 'cert_name'], sortable: ['cert_code'], defaultSort: 't.cert_name',
    softDelete: false, hasAuditCols: false,
    fields: [
      f('cert_code', s.strReq(30)), f('cert_name', s.strReq(120)),
      f('issuing_body', s.nullableStr(120)), f('is_active', s.bool()),
    ],
  },

  // ------------------------------------------------ Finance masters
  {
    path: 'ledger-accounts', table: 'mst_ledger_account', permission: 'FINANCE', label: 'Ledger Account',
    searchable: ['account_code', 'account_name'], sortable: ['account_code', 'account_name'],
    defaultSort: 't.account_code', softDelete: false, hasAuditCols: false,
    filters: ['account_group', 'parent_id', 'is_bank'],
    fields: [
      f('account_code', s.strReq(30)), f('account_name', s.strReq(150)),
      f('account_group', s.enumReq(['ASSET','LIABILITY','INCOME','EXPENSE','EQUITY'])),
      f('parent_id', s.id()), f('is_bank', s.bool()), f('is_active', s.bool()),
    ],
  },
  {
    path: 'tax-rates', table: 'cfg_tax_rate', permission: 'FINANCE', label: 'Tax Rate',
    searchable: ['hsn_code', 'description'], sortable: ['hsn_code'], defaultSort: 't.hsn_code',
    softDelete: false, hasAuditCols: false, filters: ['hsn_code'],
    fields: [
      f('hsn_code', s.strReq(10)), f('description', s.nullableStr(150)),
      f('igst_pct', s.dec()), f('cgst_pct', s.dec()), f('sgst_pct', s.dec()), f('cess_pct', s.dec()),
      f('effective_from', s.date()), f('effective_to', s.date()), f('is_active', s.bool()),
    ],
  },
];
