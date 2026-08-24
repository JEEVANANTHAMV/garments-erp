import type { ResourceConfig } from '../../core/crud.js';
import { s, f } from './schemas.js';

const INCOTERM = ['FOB','CIF','CFR','EXW','DDP','DAP','FCA'] as const;

/** Transactional documents: headers with their detail lines. */
export const transactionResources: ResourceConfig[] = [
  // ------------------------------------------------ Pre-sales
  {
    path: 'enquiries', table: 'trx_enquiry', permission: 'ENQUIRY', label: 'Enquiry',
    searchable: ['enquiry_no', 'season', 'remarks'],
    sortable: ['enquiry_no', 'enquiry_date', 'created_at'], defaultSort: 't.enquiry_date',
    hasIsActive: false, filters: ['buyer_id', 'agent_id', 'status_id', 'merchandiser_id', 'branch_id'],
    autoNumber: { column: 'enquiry_no', docType: 'ENQUIRY' },
    selectExtra: 'b.party_name AS buyer_name, ag.party_name AS agent_name, st.label AS status_label, cur.code AS currency_code, u.full_name AS merchandiser_name',
    joins: `LEFT JOIN mst_party b   ON b.id  = t.buyer_id
            LEFT JOIN mst_party ag  ON ag.id = t.agent_id
            LEFT JOIN cfg_status st ON st.id = t.status_id
            LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
            LEFT JOIN mst_user u    ON u.id  = t.merchandiser_id`,
    children: [
      { key: 'lines', table: 'trx_enquiry_line', fk: 'enquiry_id', fields: [
        f('style_id', s.id()), f('product_id', s.id()), f('description', s.nullableStr(255)),
        f('qty', s.int()), f('target_price', s.dec()),
      ]},
    ],
    fields: [
      f('branch_id', s.id()), f('enquiry_no', s.nullableStr(40)), f('enquiry_date', s.date()),
      f('buyer_id', s.idReq()), f('agent_id', s.id()), f('merchandiser_id', s.id()),
      f('season', s.nullableStr(40)), f('target_price', s.dec()), f('currency_id', s.id()),
      f('expected_qty', s.int()), f('delivery_target', s.date()), f('status_id', s.id()),
      f('remarks', s.text()),
    ],
  },
  {
    path: 'samples', table: 'trx_sample', permission: 'SAMPLE', label: 'Sample',
    searchable: ['sample_no', 'courier_awb'], sortable: ['sample_no', 'request_date', 'target_date'],
    defaultSort: 't.request_date', hasIsActive: false,
    filters: ['style_id', 'buyer_id', 'sample_type', 'approval_status', 'status_id', 'enquiry_id'],
    autoNumber: { column: 'sample_no', docType: 'SAMPLE' },
    selectExtra: 'st.style_code, st.style_name, b.party_name AS buyer_name, cs.label AS status_label',
    joins: `LEFT JOIN mst_style st ON st.id = t.style_id
            LEFT JOIN mst_party b  ON b.id  = t.buyer_id
            LEFT JOIN cfg_status cs ON cs.id = t.status_id`,
    fields: [
      f('sample_no', s.nullableStr(40)), f('enquiry_id', s.id()), f('style_id', s.idReq()),
      f('buyer_id', s.id()),
      f('sample_type', s.enumReq(['PROTO','FIT','SMS','SIZE_SET','PP','TOP','SHIPMENT','PHOTO'])),
      f('request_date', s.date()), f('target_date', s.date()), f('submit_date', s.date()),
      f('qty', s.int()), f('status_id', s.id()),
      f('approval_status', s.enum(['PENDING','APPROVED','REJECTED','APPROVED_WITH_COMMENTS'])),
      f('buyer_comments', s.text()), f('courier_awb', s.nullableStr(60)),
    ],
  },
  {
    path: 'costings', table: 'trx_costing', permission: 'COSTING', label: 'Costing',
    searchable: ['costing_no'], sortable: ['costing_no', 'costing_date'], defaultSort: 't.costing_date',
    hasIsActive: false, filters: ['style_id', 'buyer_id', 'status_id', 'enquiry_id'],
    autoNumber: { column: 'costing_no', docType: 'COSTING' },
    selectExtra: 'st.style_code, st.style_name, b.party_name AS buyer_name, cur.code AS currency_code, cs.label AS status_label',
    joins: `LEFT JOIN mst_style st ON st.id = t.style_id
            LEFT JOIN mst_party b  ON b.id  = t.buyer_id
            LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
            LEFT JOIN cfg_status cs ON cs.id = t.status_id`,
    children: [
      { key: 'lines', table: 'trx_costing_line', fk: 'costing_id', fields: [
        f('cost_head', s.strReq(60)),
        f('material_type', s.enum(['YARN','FABRIC','TRIM','PROCESS','OTHER'])),
        f('ref_material_id', s.id()), f('quantity', s.dec()), f('uom_id', s.id()),
        f('rate', s.dec()), f('amount', s.dec()),
      ]},
    ],
    fields: [
      f('costing_no', s.nullableStr(40)), f('version', s.int()), f('enquiry_id', s.id()),
      f('style_id', s.idReq()), f('buyer_id', s.id()), f('costing_date', s.date()),
      f('currency_id', s.idReq()), f('order_qty', s.int()),
      f('fabric_cost', s.dec()), f('yarn_cost', s.dec()), f('trim_cost', s.dec()),
      f('knitting_cost', s.dec()), f('dyeing_cost', s.dec()), f('printing_cost', s.dec()),
      f('embroidery_cost', s.dec()), f('washing_cost', s.dec()), f('cutting_cost', s.dec()),
      f('stitching_cost', s.dec()), f('finishing_cost', s.dec()), f('packing_cost', s.dec()),
      f('overhead_cost', s.dec()), f('testing_cost', s.dec()), f('freight_cost', s.dec()),
      f('agent_commission', s.dec()), f('finance_cost', s.dec()),
      f('total_cost', s.dec()), f('margin_pct', s.dec()), f('fob_price', s.dec()),
      f('status_id', s.id()), f('remarks', s.text()),
    ],
  },
  {
    path: 'quotations', table: 'trx_quotation', permission: 'QUOTATION', label: 'Quotation',
    searchable: ['quotation_no'], sortable: ['quotation_no', 'quotation_date'],
    defaultSort: 't.quotation_date', hasIsActive: false,
    filters: ['buyer_id', 'agent_id', 'status_id', 'enquiry_id', 'branch_id'],
    autoNumber: { column: 'quotation_no', docType: 'QUOTATION' },
    selectExtra: 'b.party_name AS buyer_name, cur.code AS currency_code, cs.label AS status_label',
    joins: `LEFT JOIN mst_party b ON b.id = t.buyer_id
            LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
            LEFT JOIN cfg_status cs ON cs.id = t.status_id`,
    children: [
      { key: 'lines', table: 'trx_quotation_line', fk: 'quotation_id', fields: [
        f('style_id', s.idReq()), f('costing_id', s.id()), f('description', s.nullableStr(255)),
        f('qty', s.intReq()), f('unit_price', s.decReq()), f('amount', s.decReq()),
      ]},
    ],
    fields: [
      f('branch_id', s.id()), f('quotation_no', s.nullableStr(40)), f('version', s.int()),
      f('quotation_date', s.date()), f('buyer_id', s.idReq()), f('agent_id', s.id()),
      f('enquiry_id', s.id()), f('currency_id', s.idReq()), f('incoterm', s.enum(INCOTERM)),
      f('valid_until', s.date()), f('payment_terms', s.nullableStr(150)),
      f('total_amount', s.dec()), f('status_id', s.id()), f('remarks', s.text()),
    ],
  },

  // ------------------------------------------------ Procurement
  {
    path: 'purchase-orders', table: 'trx_purchase_order', permission: 'PURCHASE', label: 'Purchase Order',
    searchable: ['po_no', 'remarks'], sortable: ['po_no', 'po_date', 'delivery_date'],
    defaultSort: 't.po_date', hasIsActive: false,
    filters: ['supplier_id', 'po_type', 'status_id', 'approval_state', 'so_id', 'branch_id'],
    autoNumber: { column: 'po_no', docType: 'PURCHASE_ORDER' },
    selectExtra: 'sup.party_name AS supplier_name, cur.code AS currency_code, cs.label AS status_label, so.so_no',
    joins: `LEFT JOIN mst_party sup ON sup.id = t.supplier_id
            LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
            LEFT JOIN cfg_status cs ON cs.id = t.status_id
            LEFT JOIN trx_sales_order so ON so.id = t.so_id`,
    children: [
      { key: 'lines', table: 'trx_purchase_order_line', fk: 'po_id', fields: [
        f('material_type', s.enumReq(['YARN','FABRIC','TRIM','SERVICE'])),
        f('yarn_id', s.id()), f('fabric_id', s.id()), f('trim_id', s.id()), f('color_id', s.id()),
        f('description', s.nullableStr(255)), f('qty', s.decReq()), f('uom_id', s.idReq()),
        f('rate', s.decReq()), f('amount', s.decReq()), f('gst_rate', s.dec()),
      ]},
    ],
    fields: [
      f('branch_id', s.id()), f('po_no', s.nullableStr(40)), f('po_date', s.date()),
      f('supplier_id', s.idReq()),
      f('po_type', s.enum(['MATERIAL','JOBWORK','SERVICE','CAPEX'])),
      f('so_id', s.id()), f('mrp_id', s.id()), f('currency_id', s.idReq()),
      f('exchange_rate', s.dec()), f('delivery_date', s.date()),
      f('payment_terms', s.nullableStr(150)), f('total_amount', s.dec()),
      f('tax_amount', s.dec()), f('grand_total', s.dec()), f('status_id', s.id()),
      f('approval_state', s.enum(['DRAFT','PENDING','APPROVED','REJECTED','CLOSED','CANCELLED'])),
      f('remarks', s.text()),
    ],
  },

  // ------------------------------------------------ Production processes
  {
    path: 'production-plans', table: 'trx_production_plan', permission: 'PRODUCTION', label: 'Production Plan',
    searchable: ['plan_no'], sortable: ['plan_no', 'plan_date'], defaultSort: 't.plan_date',
    hasIsActive: false, softDelete: false, filters: ['so_id', 'unit_id', 'status_id'],
    autoNumber: { column: 'plan_no', docType: 'PROD_PLAN' },
    selectExtra: 'so.so_no, un.unit_name, cs.label AS status_label',
    joins: `LEFT JOIN trx_sales_order so ON so.id = t.so_id
            LEFT JOIN mst_unit un ON un.id = t.unit_id
            LEFT JOIN cfg_status cs ON cs.id = t.status_id`,
    children: [
      { key: 'milestones', table: 'trx_plan_milestone', fk: 'plan_id', fields: [
        f('milestone', s.strReq(80)), f('planned_date', s.date()), f('actual_date', s.date()),
        f('is_critical', s.bool()), f('status', s.enum(['PENDING','ON_TRACK','DELAYED','DONE'])),
      ]},
    ],
    fields: [
      f('plan_no', s.nullableStr(40)), f('plan_date', s.date()), f('so_id', s.idReq()),
      f('unit_id', s.id()), f('plan_start', s.date()), f('plan_end', s.date()),
      f('status_id', s.id()), f('remarks', s.nullableStr(500)),
    ],
  },
  {
    path: 'production-orders', table: 'trx_production_order', permission: 'PRODUCTION', label: 'Production Order',
    searchable: ['po_prod_no', 'remarks'], sortable: ['po_prod_no', 'prod_date'],
    defaultSort: 't.prod_date', hasIsActive: false, softDelete: false,
    filters: ['so_id', 'style_id', 'unit_id', 'status_id', 'approval_state', 'is_jobwork', 'vendor_id'],
    autoNumber: { column: 'po_prod_no', docType: 'PROD_ORDER' },
    selectExtra: `so.so_no, st.style_code, st.style_name, c.color_name, un.unit_name,
                  v.party_name AS vendor_name, cs.label AS status_label`,
    joins: `LEFT JOIN trx_sales_order so ON so.id = t.so_id
            LEFT JOIN mst_style st ON st.id = t.style_id
            LEFT JOIN mst_color c  ON c.id  = t.color_id
            LEFT JOIN mst_unit un  ON un.id = t.unit_id
            LEFT JOIN mst_party v  ON v.id  = t.vendor_id
            LEFT JOIN cfg_status cs ON cs.id = t.status_id`,
    fields: [
      f('po_prod_no', s.nullableStr(40)), f('prod_date', s.date()), f('so_id', s.idReq()),
      f('so_line_id', s.id()), f('plan_id', s.id()), f('style_id', s.idReq()), f('color_id', s.id()),
      f('unit_id', s.id()), f('order_qty', s.intReq()), f('planned_qty', s.int()),
      f('produced_qty', s.int()), f('is_jobwork', s.bool()), f('vendor_id', s.id()),
      f('status_id', s.id()),
      f('approval_state', s.enum(['DRAFT','APPROVED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED'])),
      f('remarks', s.nullableStr(500)),
    ],
  },
  {
    path: 'process-transactions', table: 'trx_process_transaction', permission: 'PRODUCTION', label: 'Process Transaction',
    searchable: ['txn_no', 'remarks'], sortable: ['txn_no', 'txn_date'], defaultSort: 't.txn_date',
    hasIsActive: false, softDelete: false,
    filters: ['prod_order_id', 'stage_id', 'vendor_id', 'status_id', 'from_unit', 'to_unit'],
    autoNumber: { column: 'txn_no', docType: 'PROCESS_TXN' },
    selectExtra: 'po.po_prod_no, ps.stage_name, v.party_name AS vendor_name',
    joins: `LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
            LEFT JOIN cfg_process_stage ps ON ps.id = t.stage_id
            LEFT JOIN mst_party v ON v.id = t.vendor_id`,
    fields: [
      f('prod_order_id', s.idReq()), f('stage_id', s.idReq()), f('txn_no', s.nullableStr(40)),
      f('txn_date', s.date()), f('from_unit', s.id()), f('to_unit', s.id()), f('vendor_id', s.id()),
      f('input_qty', s.int()), f('output_qty', s.int()), f('rejected_qty', s.int()),
      f('received_qty', s.int()), f('jobwork_rate', s.dec()), f('status_id', s.id()),
      f('remarks', s.nullableStr(500)),
    ],
  },
  {
    path: 'cuttings', table: 'trx_cutting', permission: 'PRODUCTION', label: 'Cutting',
    searchable: ['cut_no', 'marker_ref'], sortable: ['cut_no', 'cut_date'], defaultSort: 't.cut_date',
    hasIsActive: false, softDelete: false, filters: ['prod_order_id', 'fabric_id', 'status_id'],
    autoNumber: { column: 'cut_no', docType: 'CUTTING' },
    selectExtra: 'po.po_prod_no, fb.fabric_name',
    joins: `LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
            LEFT JOIN mst_fabric fb ON fb.id = t.fabric_id`,
    children: [
      { key: 'bundles', table: 'trx_cutting_bundle', fk: 'cutting_id', fields: [
        f('sku_id', s.idReq()), f('bundle_no', s.strReq(40)),
        f('qty', s.intReq()), f('barcode', s.nullableStr(80)),
      ]},
    ],
    fields: [
      f('cut_no', s.nullableStr(40)), f('cut_date', s.date()), f('prod_order_id', s.idReq()),
      f('fabric_id', s.id()), f('batch_id', s.id()), f('lay_length_m', s.dec()),
      f('ply_count', s.int()), f('marker_ref', s.nullableStr(60)), f('marker_eff_pct', s.dec()),
      f('fabric_used_kg', s.dec()), f('total_pieces', s.int()), f('status_id', s.id()),
    ],
  },
  {
    path: 'printings', table: 'trx_printing', permission: 'PRODUCTION', label: 'Printing',
    searchable: ['print_no', 'placement'], sortable: ['print_no', 'print_date'],
    defaultSort: 't.print_date', hasIsActive: false, softDelete: false,
    filters: ['prod_order_id', 'print_type', 'vendor_id', 'status_id'],
    autoNumber: { column: 'print_no', docType: 'PRINTING' },
    selectExtra: 'po.po_prod_no, v.party_name AS vendor_name',
    joins: `LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
            LEFT JOIN mst_party v ON v.id = t.vendor_id`,
    fields: [
      f('print_no', s.nullableStr(40)), f('print_date', s.date()), f('prod_order_id', s.idReq()),
      f('print_type', s.enumReq(['SCREEN','DIGITAL','SUBLIMATION','RUBBER','DISCHARGE','FOIL','PUFF','OTHER'])),
      f('placement', s.nullableStr(80)), f('no_of_colors', s.int()), f('vendor_id', s.id()),
      f('input_qty', s.int()), f('output_qty', s.int()), f('rejected_qty', s.int()),
      f('rate', s.dec()), f('status_id', s.id()),
    ],
  },
  {
    path: 'embroideries', table: 'trx_embroidery', permission: 'PRODUCTION', label: 'Embroidery',
    searchable: ['emb_no', 'design_ref', 'placement'], sortable: ['emb_no', 'emb_date'],
    defaultSort: 't.emb_date', hasIsActive: false, softDelete: false,
    filters: ['prod_order_id', 'vendor_id', 'status_id'],
    autoNumber: { column: 'emb_no', docType: 'EMBROIDERY' },
    selectExtra: 'po.po_prod_no, v.party_name AS vendor_name',
    joins: `LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
            LEFT JOIN mst_party v ON v.id = t.vendor_id`,
    fields: [
      f('emb_no', s.nullableStr(40)), f('emb_date', s.date()), f('prod_order_id', s.idReq()),
      f('design_ref', s.nullableStr(60)), f('stitch_count', s.int()), f('placement', s.nullableStr(80)),
      f('vendor_id', s.id()), f('input_qty', s.int()), f('output_qty', s.int()),
      f('rejected_qty', s.int()), f('rate', s.dec()), f('status_id', s.id()),
    ],
  },
  {
    path: 'washings', table: 'trx_washing', permission: 'PRODUCTION', label: 'Washing',
    searchable: ['wash_no'], sortable: ['wash_no', 'wash_date'], defaultSort: 't.wash_date',
    hasIsActive: false, softDelete: false, filters: ['prod_order_id', 'wash_type', 'vendor_id', 'status_id'],
    autoNumber: { column: 'wash_no', docType: 'WASHING' },
    selectExtra: 'po.po_prod_no, v.party_name AS vendor_name',
    joins: `LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
            LEFT JOIN mst_party v ON v.id = t.vendor_id`,
    fields: [
      f('wash_no', s.nullableStr(40)), f('wash_date', s.date()), f('prod_order_id', s.idReq()),
      f('wash_type', s.enumReq(['NORMAL','ENZYME','STONE','ACID','BLEACH','GARMENT_DYE','SILICON','OTHER'])),
      f('vendor_id', s.id()), f('input_qty', s.int()), f('output_qty', s.int()),
      f('rejected_qty', s.int()), f('shrinkage_pct', s.dec()), f('rate', s.dec()), f('status_id', s.id()),
    ],
  },
  {
    path: 'stitchings', table: 'trx_stitching', permission: 'PRODUCTION', label: 'Stitching',
    searchable: ['stitch_no', 'line_no'], sortable: ['stitch_no', 'stitch_date'],
    defaultSort: 't.stitch_date', hasIsActive: false, softDelete: false,
    filters: ['prod_order_id', 'unit_id', 'vendor_id', 'status_id'],
    autoNumber: { column: 'stitch_no', docType: 'STITCHING' },
    selectExtra: 'po.po_prod_no, un.unit_name, v.party_name AS vendor_name',
    joins: `LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
            LEFT JOIN mst_unit un ON un.id = t.unit_id
            LEFT JOIN mst_party v ON v.id = t.vendor_id`,
    children: [
      { key: 'outputs', table: 'trx_stitching_output', fk: 'stitching_id', fields: [
        f('sku_id', s.idReq()), f('bundle_id', s.id()), f('qty', s.intReq()),
      ]},
    ],
    fields: [
      f('stitch_no', s.nullableStr(40)), f('stitch_date', s.date()), f('prod_order_id', s.idReq()),
      f('unit_id', s.id()), f('line_no', s.nullableStr(20)), f('vendor_id', s.id()),
      f('input_qty', s.int()), f('output_qty', s.int()), f('rejected_qty', s.int()),
      f('smv', s.dec()), f('rate', s.dec()), f('status_id', s.id()),
    ],
  },
  {
    path: 'finishings', table: 'trx_finishing', permission: 'PRODUCTION', label: 'Finishing',
    searchable: ['finish_no'], sortable: ['finish_no', 'finish_date'], defaultSort: 't.finish_date',
    hasIsActive: false, softDelete: false, filters: ['prod_order_id', 'unit_id', 'status_id'],
    autoNumber: { column: 'finish_no', docType: 'FINISHING' },
    selectExtra: 'po.po_prod_no, un.unit_name',
    joins: `LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
            LEFT JOIN mst_unit un ON un.id = t.unit_id`,
    fields: [
      f('finish_no', s.nullableStr(40)), f('finish_date', s.date()), f('prod_order_id', s.idReq()),
      f('unit_id', s.id()),
      // SET column — accept a comma-joined list
      f('activity', s.nullableStr(120)),
      f('input_qty', s.int()), f('output_qty', s.int()), f('rejected_qty', s.int()),
      f('status_id', s.id()),
    ],
  },

  // ------------------------------------------------ Quality
  {
    path: 'qc-inspections', table: 'trx_qc_inspection', permission: 'QC', label: 'QC Inspection',
    searchable: ['qc_no', 'aql_level'], sortable: ['qc_no', 'qc_date'], defaultSort: 't.qc_date',
    hasIsActive: false, softDelete: false,
    filters: ['prod_order_id', 'stage_id', 'inspection_type', 'result', 'inspector_id', 'buyer_qc'],
    autoNumber: { column: 'qc_no', docType: 'QC' },
    selectExtra: 'po.po_prod_no, ps.stage_name, u.full_name AS inspector_name',
    joins: `LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
            LEFT JOIN cfg_process_stage ps ON ps.id = t.stage_id
            LEFT JOIN mst_user u ON u.id = t.inspector_id`,
    children: [
      { key: 'defects', table: 'trx_qc_defect_line', fk: 'qc_id', fields: [
        f('defect_id', s.idReq()), f('sku_id', s.id()),
        f('defect_qty', s.intReq()), f('remarks', s.nullableStr(255)),
      ]},
    ],
    fields: [
      f('qc_no', s.nullableStr(40)), f('qc_date', s.date()), f('prod_order_id', s.id()),
      f('stage_id', s.id()),
      f('inspection_type', s.enumReq(['INCOMING','INLINE','END_LINE','FINAL','PRE_FINAL','AQL','PACKING'])),
      f('aql_level', s.nullableStr(20)), f('lot_size', s.int()), f('sample_size', s.int()),
      f('inspected_qty', s.int()), f('passed_qty', s.int()),
      f('major_defects', s.int()), f('minor_defects', s.int()), f('critical_defects', s.int()),
      f('result', s.enum(['PASS','FAIL','PENDING','REINSPECT'])),
      f('inspector_id', s.id()), f('buyer_qc', s.bool()), f('remarks', s.text()),
    ],
  },

  // ------------------------------------------------ Packing & dispatch
  {
    path: 'packings', table: 'trx_packing', permission: 'PACKING', label: 'Packing',
    searchable: ['pack_no'], sortable: ['pack_no', 'pack_date'], defaultSort: 't.pack_date',
    hasIsActive: false, softDelete: false, filters: ['so_id', 'prod_order_id', 'status_id', 'pack_method'],
    autoNumber: { column: 'pack_no', docType: 'PACKING' },
    selectExtra: 'so.so_no, po.po_prod_no',
    joins: `LEFT JOIN trx_sales_order so ON so.id = t.so_id
            LEFT JOIN trx_production_order po ON po.id = t.prod_order_id`,
    fields: [
      f('pack_no', s.nullableStr(40)), f('pack_date', s.date()), f('so_id', s.idReq()),
      f('prod_order_id', s.id()),
      f('pack_method', s.enum(['SOLID_COLOR_SOLID_SIZE','SOLID_COLOR_ASSORTED_SIZE','ASSORTED_COLOR_ASSORTED_SIZE','RATIO_PACK'])),
      f('total_cartons', s.int()), f('total_qty', s.int()),
      f('net_weight_kg', s.dec()), f('gross_weight_kg', s.dec()), f('status_id', s.id()),
    ],
  },
  {
    path: 'dispatches', table: 'trx_dispatch', permission: 'DISPATCH', label: 'Dispatch',
    searchable: ['dispatch_no'], sortable: ['dispatch_no', 'dispatch_date'], defaultSort: 't.dispatch_date',
    hasIsActive: false, softDelete: false, filters: ['so_id', 'buyer_id', 'mode', 'status_id'],
    autoNumber: { column: 'dispatch_no', docType: 'DISPATCH' },
    selectExtra: 'so.so_no, b.party_name AS buyer_name',
    joins: `LEFT JOIN trx_sales_order so ON so.id = t.so_id
            LEFT JOIN mst_party b ON b.id = t.buyer_id`,
    fields: [
      f('dispatch_no', s.nullableStr(40)), f('dispatch_date', s.date()), f('so_id', s.idReq()),
      f('packing_id', s.id()), f('buyer_id', s.id()),
      f('mode', s.enum(['SEA','AIR','ROAD','COURIER'])),
      f('total_cartons', s.int()), f('total_qty', s.int()),
      f('gross_weight_kg', s.dec()), f('total_cbm', s.dec()), f('status_id', s.id()),
    ],
  },
  {
    path: 'containers', table: 'trx_container', permission: 'DISPATCH', label: 'Container',
    searchable: ['container_no', 'seal_no'], sortable: ['container_no', 'stuffing_date'],
    defaultSort: 't.id', hasIsActive: false, softDelete: false, hasAuditCols: false,
    filters: ['dispatch_id', 'container_type'],
    fields: [
      f('container_no', s.strReq(40)), f('dispatch_id', s.id()),
      f('container_type', s.enum(['20FT','40FT','40HC','45HC','LCL'])),
      f('seal_no', s.nullableStr(40)), f('line_seal_no', s.nullableStr(40)),
      f('tare_weight_kg', s.dec()), f('max_cbm', s.dec()), f('loaded_cbm', s.dec()),
      f('stuffing_date', s.date()), f('stuffing_type', s.enum(['FACTORY','CFS','ICD'])),
    ],
  },

  // ------------------------------------------------ Export documentation
  {
    path: 'commercial-invoices', table: 'trx_commercial_invoice', permission: 'EXPORT', label: 'Commercial Invoice',
    searchable: ['invoice_no', 'lc_no'], sortable: ['invoice_no', 'invoice_date'],
    defaultSort: 't.invoice_date', hasIsActive: false, softDelete: false,
    filters: ['so_id', 'buyer_id', 'dispatch_id', 'status_id'],
    autoNumber: { column: 'invoice_no', docType: 'INVOICE' },
    selectExtra: 'so.so_no, b.party_name AS buyer_name, cur.code AS currency_code',
    joins: `LEFT JOIN trx_sales_order so ON so.id = t.so_id
            LEFT JOIN mst_party b ON b.id = t.buyer_id
            LEFT JOIN cfg_currency cur ON cur.id = t.currency_id`,
    children: [
      { key: 'lines', table: 'trx_commercial_invoice_line', fk: 'invoice_id', fields: [
        f('style_id', s.id()), f('sku_id', s.id()), f('description', s.nullableStr(255)),
        f('hsn_code', s.nullableStr(10)), f('qty', s.intReq()),
        f('unit_price', s.decReq()), f('amount', s.decReq()),
      ]},
      { key: 'taxes', table: 'trx_invoice_tax', fk: 'invoice_id', fields: [
        f('hsn_code', s.nullableStr(10)), f('taxable_value', s.dec()),
        f('igst_pct', s.dec()), f('igst_amount', s.dec()),
        f('cgst_amount', s.dec()), f('sgst_amount', s.dec()),
        f('is_export_lut', s.bool()), f('gstr_reference', s.nullableStr(40)),
      ]},
    ],
    fields: [
      f('invoice_no', s.nullableStr(40)), f('invoice_date', s.date()), f('so_id', s.idReq()),
      f('dispatch_id', s.id()), f('buyer_id', s.idReq()), f('consignee_id', s.id()),
      f('currency_id', s.idReq()), f('exchange_rate', s.dec()), f('incoterm', s.enum(INCOTERM)),
      f('port_of_loading', s.nullableStr(80)), f('port_of_discharge', s.nullableStr(80)),
      f('final_destination', s.nullableStr(80)), f('country_origin', s.id()), f('country_dest', s.id()),
      f('fob_value', s.dec()), f('freight_value', s.dec()), f('insurance_value', s.dec()),
      f('total_value', s.dec()), f('lc_no', s.nullableStr(60)), f('status_id', s.id()),
    ],
  },
  {
    path: 'packing-lists', table: 'trx_packing_list', permission: 'EXPORT', label: 'Packing List',
    searchable: ['pl_no'], sortable: ['pl_no', 'pl_date'], defaultSort: 't.pl_date',
    hasIsActive: false, softDelete: false, filters: ['invoice_id', 'packing_id'],
    autoNumber: { column: 'pl_no', docType: 'PACKING_LIST' },
    selectExtra: 'ci.invoice_no', joins: 'LEFT JOIN trx_commercial_invoice ci ON ci.id = t.invoice_id',
    fields: [
      f('pl_no', s.nullableStr(40)), f('pl_date', s.date()), f('invoice_id', s.idReq()),
      f('packing_id', s.id()), f('total_cartons', s.int()), f('total_qty', s.int()),
      f('net_weight_kg', s.dec()), f('gross_weight_kg', s.dec()), f('total_cbm', s.dec()),
    ],
  },
  {
    path: 'shipping-bills', table: 'trx_shipping_bill', permission: 'EXPORT', label: 'Shipping Bill',
    searchable: ['sb_no', 'cha_name', 'port_code'], sortable: ['sb_no', 'sb_date'],
    defaultSort: 't.sb_date', hasIsActive: false, softDelete: false, filters: ['invoice_id', 'status_id'],
    autoNumber: { column: 'sb_no', docType: 'SHIPPING_BILL' },
    selectExtra: 'ci.invoice_no', joins: 'LEFT JOIN trx_commercial_invoice ci ON ci.id = t.invoice_id',
    fields: [
      f('sb_no', s.nullableStr(40)), f('sb_date', s.date()), f('invoice_id', s.idReq()),
      f('port_code', s.nullableStr(20)), f('cha_name', s.nullableStr(150)), f('cha_ref', s.nullableStr(60)),
      f('leo_date', s.date()), f('scheme_code', s.nullableStr(20)),
      f('drawback_amount', s.dec()), f('rodtep_amount', s.dec()), f('fob_inr', s.dec()),
      f('status_id', s.id()),
    ],
  },
  {
    path: 'certificates', table: 'trx_certificate', permission: 'EXPORT', label: 'Certificate',
    searchable: ['cert_no', 'issuing_body'], sortable: ['cert_no', 'issue_date'],
    defaultSort: 't.id', hasIsActive: false, softDelete: false, hasAuditCols: false,
    filters: ['cert_type_id', 'invoice_id', 'so_id', 'status_id'],
    selectExtra: 'ct.cert_name, ct.cert_code',
    joins: 'LEFT JOIN mst_certificate_type ct ON ct.id = t.cert_type_id',
    fields: [
      f('cert_type_id', s.idReq()), f('cert_no', s.strReq(60)), f('invoice_id', s.id()),
      f('so_id', s.id()), f('issue_date', s.date()), f('expiry_date', s.date()),
      f('issuing_body', s.nullableStr(120)), f('doc_id', s.id()), f('status_id', s.id()),
    ],
  },
  {
    path: 'shipments', table: 'trx_shipment', permission: 'EXPORT', label: 'Shipment',
    searchable: ['shipment_no', 'bl_no', 'vessel_name', 'shipping_line'],
    sortable: ['shipment_no', 'etd', 'eta'], defaultSort: 't.etd',
    hasIsActive: false, softDelete: false,
    filters: ['invoice_id', 'dispatch_id', 'tracking_status', 'forwarder_id', 'status_id'],
    autoNumber: { column: 'shipment_no', docType: 'SHIPMENT' },
    selectExtra: 'ci.invoice_no, fw.party_name AS forwarder_name',
    joins: `LEFT JOIN trx_commercial_invoice ci ON ci.id = t.invoice_id
            LEFT JOIN mst_party fw ON fw.id = t.forwarder_id`,
    children: [
      { key: 'events', table: 'trx_shipment_event', fk: 'shipment_id', orderBy: 'event_time DESC, id DESC', fields: [
        f('event_type', s.strReq(60)), f('event_location', s.nullableStr(120)),
        f('event_time', s.nullableStr(30)), f('remarks', s.nullableStr(255)),
      ]},
    ],
    fields: [
      f('shipment_no', s.nullableStr(40)), f('invoice_id', s.id()), f('dispatch_id', s.id()),
      f('shipping_bill_id', s.id()), f('forwarder_id', s.id()),
      f('shipping_line', s.nullableStr(120)), f('vessel_name', s.nullableStr(120)),
      f('voyage_no', s.nullableStr(40)), f('bl_no', s.nullableStr(60)), f('bl_date', s.date()),
      f('etd', s.date()), f('eta', s.date()), f('atd', s.date()), f('ata', s.date()),
      f('pol', s.nullableStr(80)), f('pod', s.nullableStr(80)),
      f('tracking_status', s.enum(['BOOKED','GATED_IN','LOADED','SAILED','TRANSIT','ARRIVED','DELIVERED'])),
      f('status_id', s.id()),
    ],
  },

  // ------------------------------------------------ Finance
  {
    path: 'vouchers', table: 'trx_voucher', permission: 'FINANCE', label: 'Voucher',
    searchable: ['voucher_no', 'narration'], sortable: ['voucher_no', 'voucher_date'],
    defaultSort: 't.voucher_date', hasIsActive: false, softDelete: false,
    filters: ['voucher_type', 'is_posted', 'fy_id', 'branch_id'],
    autoNumber: { column: 'voucher_no', docType: 'VOUCHER' },
    children: [
      { key: 'lines', table: 'trx_voucher_line', fk: 'voucher_id', fields: [
        f('account_id', s.idReq()), f('party_id', s.id()),
        f('debit', s.dec()), f('credit', s.dec()), f('narration', s.nullableStr(255)),
      ]},
    ],
    fields: [
      f('branch_id', s.id()), f('voucher_no', s.nullableStr(40)), f('voucher_date', s.date()),
      f('voucher_type', s.enumReq(['JOURNAL','RECEIPT','PAYMENT','CONTRA','SALES','PURCHASE','DEBIT_NOTE','CREDIT_NOTE'])),
      f('narration', s.nullableStr(500)), f('ref_type', s.nullableStr(40)), f('ref_id', s.id()),
      f('currency_id', s.id()), f('exchange_rate', s.dec()),
      f('total_debit', s.dec()), f('total_credit', s.dec()), f('fy_id', s.id()),
      f('is_posted', s.bool()),
    ],
  },
  {
    path: 'receipts', table: 'trx_receipt', permission: 'FINANCE', label: 'Receipt',
    searchable: ['receipt_no', 'bank_ref', 'brc_no'], sortable: ['receipt_no', 'receipt_date'],
    defaultSort: 't.receipt_date', hasIsActive: false, softDelete: false,
    filters: ['buyer_id', 'mode', 'is_advance'],
    autoNumber: { column: 'receipt_no', docType: 'RECEIPT' },
    selectExtra: 'b.party_name AS buyer_name, cur.code AS currency_code',
    joins: `LEFT JOIN mst_party b ON b.id = t.buyer_id
            LEFT JOIN cfg_currency cur ON cur.id = t.currency_id`,
    children: [
      { key: 'allocations', table: 'map_receipt_invoice', fk: 'receipt_id', fields: [
        f('invoice_id', s.idReq()), f('allocated_fc', s.decReq()), f('allocated_inr', s.decReq()),
      ]},
    ],
    fields: [
      f('receipt_no', s.nullableStr(40)), f('receipt_date', s.date()), f('buyer_id', s.idReq()),
      f('mode', s.enum(['TT','LC','ADVANCE','CHEQUE','ONLINE','OTHER'])),
      f('currency_id', s.idReq()), f('exchange_rate', s.dec()),
      f('amount_fc', s.decReq()), f('amount_inr', s.decReq()),
      f('bank_ref', s.nullableStr(60)), f('brc_no', s.nullableStr(60)),
      f('is_advance', s.bool()), f('voucher_id', s.id()), f('remarks', s.nullableStr(500)),
    ],
  },
  {
    path: 'payments', table: 'trx_payment', permission: 'FINANCE', label: 'Payment',
    searchable: ['payment_no', 'bank_ref'], sortable: ['payment_no', 'payment_date'],
    defaultSort: 't.payment_date', hasIsActive: false, softDelete: false,
    filters: ['supplier_id', 'mode'],
    autoNumber: { column: 'payment_no', docType: 'PAYMENT' },
    selectExtra: 'sup.party_name AS supplier_name, cur.code AS currency_code',
    joins: `LEFT JOIN mst_party sup ON sup.id = t.supplier_id
            LEFT JOIN cfg_currency cur ON cur.id = t.currency_id`,
    fields: [
      f('payment_no', s.nullableStr(40)), f('payment_date', s.date()), f('supplier_id', s.idReq()),
      f('mode', s.enum(['NEFT','RTGS','CHEQUE','CASH','LC','ONLINE'])),
      f('currency_id', s.idReq()), f('amount', s.decReq()), f('bank_ref', s.nullableStr(60)),
      f('voucher_id', s.id()), f('remarks', s.nullableStr(500)),
    ],
  },
  {
    path: 'export-incentives', table: 'trx_export_incentive', permission: 'FINANCE', label: 'Export Incentive',
    searchable: ['scrip_no'], sortable: ['claim_date', 'credit_date'], defaultSort: 't.id',
    hasIsActive: false, softDelete: false, hasAuditCols: false,
    filters: ['incentive_type', 'status', 'shipping_bill_id', 'invoice_id'],
    fields: [
      f('incentive_type', s.enumReq(['DUTY_DRAWBACK','RODTEP','ROSCTL','GST_REFUND','INTEREST_EQUAL','OTHER'])),
      f('shipping_bill_id', s.id()), f('invoice_id', s.id()), f('scrip_no', s.nullableStr(60)),
      f('claim_amount', s.dec()), f('received_amount', s.dec()),
      f('claim_date', s.date()), f('credit_date', s.date()),
      f('status', s.enum(['PENDING','CLAIMED','CREDITED','REJECTED'])),
      f('remarks', s.nullableStr(500)),
    ],
  },

  // ------------------------------------------------ Security & Gate Management
  {
    path: 'gate-inwards', table: 'trx_gate_inward', permission: 'GATE_INWARD', label: 'Inward Gate Entry',
    searchable: ['entry_no', 'vehicle_no', 'supplier_dc_no', 'supplier_inv_no', 'driver_name'],
    sortable: ['entry_no', 'entry_date', 'created_at'], defaultSort: 't.entry_date DESC, t.id DESC',
    hasIsActive: false, softDelete: false, hasAuditCols: false,
    filters: ['entry_type', 'party_id', 'material_type', 'status', 'warehouse_id'],
    autoNumber: { column: 'entry_no', docType: 'GATE_INWARD' },
    selectExtra: 'p.party_name, w.warehouse_name',
    joins: 'LEFT JOIN mst_party p ON p.id = t.party_id LEFT JOIN mst_warehouse w ON w.id = t.warehouse_id',
    fields: [
      f('entry_no', s.nullableStr(40)), f('entry_date', s.date()), f('entry_time', s.strReq(10)),
      f('entry_type', s.enum(['PURCHASE_INWARD','JOBWORK_RETURN','SAMPLE_INWARD','SALES_RETURN','GENERAL_INWARD'])),
      f('party_id', s.idReq()), f('supplier_dc_no', s.nullableStr(60)), f('supplier_dc_date', s.date()),
      f('supplier_inv_no', s.nullableStr(60)), f('supplier_inv_date', s.date()),
      f('vehicle_no', s.strReq(30)), f('driver_name', s.nullableStr(80)), f('driver_phone', s.nullableStr(30)),
      f('transporter_name', s.nullableStr(120)), f('lr_no', s.nullableStr(50)),
      f('material_type', s.enum(['FABRIC','YARN','TRIM','GARMENT','GENERAL','MACHINERY'])),
      f('package_count', s.int()), f('gross_weight_kg', s.dec()), f('tare_weight_kg', s.dec()), f('net_weight_kg', s.dec()),
      f('warehouse_id', s.id()),
      f('status', s.enum(['GATE_IN','INSPECTED','GRN_COMPLETED','REJECTED','CANCELLED'])),
      f('security_guard', s.nullableStr(80)), f('remarks', s.nullableStr(500)),
    ],
  },
  {
    path: 'gate-outwards', table: 'trx_gate_outward', permission: 'GATE_OUTWARD', label: 'Outward Gate Pass',
    searchable: ['pass_no', 'vehicle_no', 'driver_name', 'purpose', 'lr_no'],
    sortable: ['pass_no', 'pass_date', 'created_at'], defaultSort: 't.pass_date DESC, t.id DESC',
    hasIsActive: false, softDelete: false, hasAuditCols: false,
    filters: ['pass_type', 'party_id', 'to_unit_id', 'status', 'is_returned'],
    autoNumber: { column: 'pass_no', docType: 'GATE_OUTWARD' },
    selectExtra: 'p.party_name, u.unit_name AS to_unit_name, um.code AS uom_code',
    joins: 'LEFT JOIN mst_party p ON p.id = t.party_id LEFT JOIN mst_unit u ON u.id = t.to_unit_id LEFT JOIN cfg_uom um ON um.id = t.uom_id',
    fields: [
      f('pass_no', s.nullableStr(40)), f('pass_date', s.date()), f('pass_time', s.strReq(10)),
      f('pass_type', s.enum(['RETURNABLE_JOBWORK','RETURNABLE_GENERAL','NON_RETURNABLE_DISPATCH','NON_RETURNABLE_SCRAP','NON_RETURNABLE_SAMPLE'])),
      f('party_id', s.id()), f('to_unit_id', s.id()),
      f('vehicle_no', s.strReq(30)), f('driver_name', s.nullableStr(80)), f('driver_phone', s.nullableStr(30)),
      f('transporter_name', s.nullableStr(120)), f('lr_no', s.nullableStr(50)),
      f('purpose', s.nullableStr(255)), f('ref_type', s.nullableStr(40)), f('ref_id', s.id()),
      f('expected_return_date', s.date()), f('is_returned', s.bool()), f('returned_date', s.date()),
      f('package_count', s.int()), f('total_qty', s.dec()), f('uom_id', s.id()),
      f('status', s.enum(['DRAFT','APPROVED','GATE_OUT','RETURNED_PARTIAL','RETURNED_FULL','CLOSED'])),
      f('security_guard', s.nullableStr(80)), f('remarks', s.nullableStr(500)),
    ],
  },
];
