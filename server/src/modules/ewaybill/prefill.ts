import { query, queryOne } from '../../config/db.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { computeValues, defaultGstRate, stateName, type EwbItemIn } from './ewbRules.js';

/**
 * A draft e-way bill from the document that moves the goods. Everything is editable on the screen before
 * generating; values the document does not carry (goods value of a job-work DC, HSN of a gate pass) are
 * suggested where we can (approved pre-costing, item masters) and otherwise left for the user.
 */
export const SOURCE_TYPES = ['DISPATCH', 'PROCESS_DC', 'PURCHASE_RETURN', 'GATE_OUTWARD', 'STOCK_DELIVERY'] as const;
export type SourceType = typeof SOURCE_TYPES[number];
export const SOURCE_LABEL: Record<string, string> = {
  DISPATCH: 'Dispatch', PROCESS_DC: 'Process / job-work DC', PURCHASE_RETURN: 'Purchase return', GATE_OUTWARD: 'Gate outward', STOCK_DELIVERY: 'Stock delivery', MANUAL: 'Manual',
};

const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (x: number) => Math.round(x * 100) / 100;
const iso = (d: unknown) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : new Date().toISOString().slice(0, 10));
const docNo = (v: unknown) => String(v ?? '').replace(/[^A-Za-z0-9/-]/g, '').slice(-16);

async function consignor(cid: number) {
  const c = await queryOne<any>(`SELECT * FROM mst_company WHERE id = ?`, [cid]);
  return {
    from_gstin: c?.gstin ?? '', from_name: (c?.legal_name || c?.company_name || c?.trade_name || '').slice(0, 100),
    from_address1: c?.address_line1 ?? null, from_address2: c?.address_line2 ?? null, from_place: c?.city ?? null,
    from_pincode: c?.pincode ?? null, from_state: stateName(c?.state) || stateName(c?.gstin), dispatch_state: stateName(c?.state) || stateName(c?.gstin),
  };
}

async function consignee(cid: number, partyId: number | null) {
  if (!partyId) return { to_party_id: null, to_gstin: 'URP', to_name: '', to_address1: null, to_address2: null, to_place: null, to_pincode: null, to_state: '', ship_state: '' };
  const p = await queryOne<any>(`SELECT id, party_name, legal_name, gstin, party_type FROM mst_party WHERE id = ? AND company_id = ?`, [partyId, cid]);
  if (!p) throw NotFound('Party not found');
  const a = await queryOne<any>(`SELECT * FROM mst_party_address WHERE party_id = ? AND is_active = 1 ORDER BY is_default DESC, id LIMIT 1`, [partyId]);
  const st = stateName(a?.state) || stateName(p.gstin);
  return {
    to_party_id: Number(p.id), to_gstin: p.gstin && String(p.gstin).length === 15 ? String(p.gstin).toUpperCase() : 'URP',
    to_name: String(p.legal_name || p.party_name).slice(0, 100), to_address1: a?.address_line1 ?? null, to_address2: a?.address_line2 ?? null,
    to_place: a?.city ?? null, to_pincode: a?.pincode ?? null, to_state: st, ship_state: st, party_type: p.party_type,
  };
}

async function transporterOf(cid: number, partyId: number | null, name: string | null) {
  if (partyId) {
    const t = await queryOne<any>(`SELECT id, party_name, gstin FROM mst_party WHERE id = ? AND company_id = ?`, [partyId, cid]);
    if (t) return { transporter_party_id: Number(t.id), transporter_id: t.gstin ?? null, transporter_name: t.party_name };
  }
  return { transporter_party_id: null, transporter_id: null, transporter_name: name ?? null };
}

/** Standard cost / PC of a style: latest approved pre-costing (the job-work goods value). */
async function styleCost(cid: number, styleId: number | null) {
  if (!styleId) return 0;
  const c = await queryOne<any>(
    `SELECT c.total_cost FROM trx_costing c LEFT JOIN cfg_status st ON st.id = c.status_id
      WHERE c.company_id = ? AND c.style_id = ? AND c.is_deleted = 0 AND c.costing_type = 'PRE_COSTING' AND st.code = 'APPROVED'
      ORDER BY c.approved_at DESC, c.id DESC LIMIT 1`, [cid, styleId]);
  return n(c?.total_cost);
}
async function styleInfo(styleId: number | null) {
  if (!styleId) return null;
  return queryOne<any>(`SELECT st.style_code, st.style_name, pr.hsn_code, pr.product_name FROM mst_style st LEFT JOIN mst_product pr ON pr.id = st.product_id WHERE st.id = ?`, [styleId]);
}
async function materialInfo(type: string, id: number | null) {
  if (!id) return null;
  const t = String(type).toUpperCase();
  if (t === 'YARN') return queryOne<any>(`SELECT yarn_name name, hsn_code FROM mst_yarn WHERE id = ?`, [id]);
  if (t === 'FABRIC') return queryOne<any>(`SELECT fabric_name name, hsn_code FROM mst_fabric WHERE id = ?`, [id]);
  if (t === 'TRIM') return queryOne<any>(`SELECT trim_name name, hsn_code FROM mst_trim WHERE id = ?`, [id]);
  return null;
}
const uomCode = async (id: unknown) => (id ? (await queryOne<any>(`SELECT code FROM cfg_uom WHERE id = ?`, [id]))?.code ?? 'PCS' : 'PCS');

/** Rates on the item lines: tax rate split CGST / SGST (intra-state) or IGST (inter-state); job work / returnable → 0. */
function withRates(items: Omit<EwbItemIn, 'cgst_rate' | 'sgst_rate' | 'igst_rate' | 'cess_rate'>[], interState: boolean, taxed: boolean, given?: (number | null)[]) {
  return items.map((it, i) => {
    const rate = !taxed ? 0 : given?.[i] != null ? Number(given[i]) : defaultGstRate(it.hsn_code, it.quantity ? it.taxable_amount / it.quantity : 0);
    return { ...it, cgst_rate: interState ? 0 : rate / 2, sgst_rate: interState ? 0 : rate / 2, igst_rate: interState ? rate : 0, cess_rate: 0 };
  });
}

export async function prefill(cid: number, type: SourceType, id: number) {
  const from = await consignor(cid);
  let head: any; let items: EwbItemIn[] = []; const notes: string[] = [];

  if (type === 'DISPATCH') {
    const d = await queryOne<any>(`SELECT * FROM trx_dispatch WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!d) throw NotFound('Dispatch not found');
    const to = await consignee(cid, d.buyer_id ? Number(d.buyer_id) : null);
    const so = d.so_id ? await queryOne<any>(`SELECT so.id, so.exchange_rate, cu.code currency FROM trx_sales_order so LEFT JOIN cfg_currency cu ON cu.id = so.currency_id WHERE so.id = ?`, [d.so_id]) : null;
    const fx = so && so.currency && so.currency !== 'INR' ? n(so.exchange_rate) : 1;
    const isExport = (so?.currency && so.currency !== 'INR') || to.party_type === 'EXPORT';
    // pieces by style: posted cartons of the packing / shipment, else the order
    let rows: any[] = [];
    const shipPacking = d.shipment_id ? await queryOne<any>(`SELECT packing_list_id FROM trx_shipment WHERE id = ?`, [d.shipment_id]) : null;
    if (d.packing_id) rows = await query<any>(`SELECT cc.style_id, SUM(cc.qty) qty FROM trx_carton_content cc JOIN trx_carton c ON c.id = cc.carton_id WHERE c.packing_id = ? AND c.carton_status <> 'VOID' GROUP BY cc.style_id`, [d.packing_id]);
    else if (shipPacking?.packing_list_id) rows = await query<any>(`SELECT cc.style_id, SUM(cc.qty) qty FROM trx_packing_list_carton plc JOIN trx_carton_content cc ON cc.carton_id = plc.carton_id WHERE plc.packing_list_id = ? GROUP BY cc.style_id`, [shipPacking.packing_list_id]);
    else if (d.so_id) rows = await query<any>(`SELECT l.style_id, SUM(l.order_qty) qty FROM trx_sales_order_line l WHERE l.so_id = ? GROUP BY l.style_id`, [d.so_id]);
    for (const r of rows) {
      const st = await styleInfo(Number(r.style_id));
      const price = d.so_id ? await queryOne<any>(`SELECT SUM(amount) / NULLIF(SUM(order_qty), 0) p FROM trx_sales_order_line WHERE so_id = ? AND style_id = ?`, [d.so_id, r.style_id]) : null;
      const qty = n(r.qty);
      items.push({ product_name: (st?.product_name || st?.style_name || 'Garments').slice(0, 100), description: `${st?.style_code ?? ''} ${st?.style_name ?? ''}`.trim().slice(0, 100),
        hsn_code: st?.hsn_code ?? '', quantity: qty, unit: 'PCS', taxable_amount: r2(qty * n(price?.p) * fx) } as any);
    }
    if (!items.length) items.push({ product_name: 'Garments', description: null, hsn_code: '', quantity: n(d.total_qty), unit: 'PCS', taxable_amount: 0 } as any);
    if (fx !== 1) notes.push(`Values converted from ${so.currency} at the order rate ${fx} — use the tax invoice value in ₹`);
    const tr = await transporterOf(cid, d.transporter_id ? Number(d.transporter_id) : null, null);
    head = { ...from, ...to, supply_type: 'OUTWARD', sub_supply_type: isExport ? 'Export' : 'Supply', document_type: 'Tax Invoice',
      document_number: docNo(d.dispatch_no), document_date: iso(d.dispatch_date), ...tr,
      vehicle_no: d.vehicle_no ?? null, transport_doc_no: d.lr_no ? docNo(d.lr_no) : null, transport_doc_date: d.lr_date ? iso(d.lr_date) : null,
      source_no: d.dispatch_no };
    if (isExport) { head.to_gstin = 'URP'; head.to_state = 'OTHER COUNTRY'; head.ship_state = ''; head.to_pincode = null; notes.push('Export: ship-to is the port — enter the port PIN code and its state'); }
    notes.push('Document number = dispatch no — change it to the tax invoice number');
    const inter = head.from_state !== head.to_state;
    items = withRates(items as any, inter, !isExport);
  } else if (type === 'PROCESS_DC') {
    const c = await queryOne<any>(`SELECT * FROM trx_jobwork_challan WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!c) throw NotFound('Process DC not found');
    const to = await consignee(cid, c.vendor_id ? Number(c.vendor_id) : null);
    const lines = await query<any>(`SELECT style_id, MAX(description) description, uom_id, SUM(qty) qty, SUM(weight_kg) kg FROM trx_jobwork_challan_line WHERE challan_id = ? GROUP BY style_id, uom_id`, [id]);
    for (const l of lines) {
      const styleId = l.style_id ? Number(l.style_id) : c.style_id ? Number(c.style_id) : null;
      const st = await styleInfo(styleId);
      const cost = await styleCost(cid, styleId);
      const qty = n(l.qty);
      items.push({ product_name: (st?.product_name || st?.style_name || l.description || 'Cut / stitched pieces').slice(0, 100),
        description: `${st?.style_code ?? ''} ${l.description ?? ''}`.trim().slice(0, 100) || null, hsn_code: st?.hsn_code ?? '', quantity: qty,
        unit: await uomCode(l.uom_id), taxable_amount: r2(qty * cost) } as any);
    }
    if (items.some((i) => !i.taxable_amount)) notes.push('Goods value: no approved pre-costing for the style — enter the value of the goods sent');
    head = { ...from, ...to, supply_type: 'OUTWARD', sub_supply_type: 'Job Work', document_type: 'Delivery Challan',
      document_number: docNo(c.challan_no), document_date: iso(c.challan_date), ...(await transporterOf(cid, null, c.transporter ?? null)),
      vehicle_no: c.vehicle_no ?? null, source_no: c.challan_no };
    items = withRates(items as any, head.from_state !== head.to_state, false);
  } else if (type === 'PURCHASE_RETURN') {
    const r = await queryOne<any>(`SELECT * FROM trx_purchase_return WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!r) throw NotFound('Purchase return not found');
    const to = await consignee(cid, r.supplier_id ? Number(r.supplier_id) : null);
    const lines = await query<any>(`SELECT * FROM trx_purchase_return_line WHERE return_id = ? ORDER BY id`, [id]);
    const rates: (number | null)[] = [];
    for (const l of lines) {
      const mt = String(l.material_type ?? '').toUpperCase();
      const m = await materialInfo(mt, l.yarn_id ?? l.fabric_id ?? l.trim_id ?? null);
      items.push({ product_name: (m?.name || l.remarks || mt || 'Material').slice(0, 100), description: [l.lot_no, l.roll_no].filter(Boolean).join(' ').slice(0, 100) || null,
        hsn_code: m?.hsn_code ?? '', quantity: n(l.return_qty), unit: await uomCode(l.uom_id), taxable_amount: r2(n(l.taxable_amount) || n(l.amount)) } as any);
      rates.push(l.gst_percent != null ? n(l.gst_percent) : null);
    }
    head = { ...from, ...to, supply_type: 'OUTWARD', sub_supply_type: 'Others', sub_supply_desc: 'Purchase return', document_type: 'Delivery Challan',
      document_number: docNo(r.return_dc_no || r.return_no), document_date: iso(r.return_dc_date || r.return_date), ...(await transporterOf(cid, null, r.transporter_name ?? null)),
      vehicle_no: r.vehicle_no ?? null, source_no: r.return_no };
    items = withRates(items as any, head.from_state !== head.to_state, true, rates);
  } else if (type === 'GATE_OUTWARD') {
    const g = await queryOne<any>(`SELECT * FROM trx_gate_outward WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!g) throw NotFound('Gate outward pass not found');
    const to = await consignee(cid, g.party_id ? Number(g.party_id) : null);
    const kind = String(g.pass_type ?? '');
    items.push({ product_name: (g.purpose || 'Goods').slice(0, 100), description: g.ref_no ?? null, hsn_code: '', quantity: n(g.total_qty) || n(g.package_count),
      unit: await uomCode(g.uom_id), taxable_amount: 0 } as any);
    notes.push('A gate pass has no item lines — enter the HSN code and the value of the goods');
    head = { ...from, ...to, supply_type: 'OUTWARD',
      sub_supply_type: kind === 'RETURNABLE_JOBWORK' ? 'Job Work' : kind === 'NON_RETURNABLE_DISPATCH' ? 'Supply' : 'Others',
      sub_supply_desc: kind === 'RETURNABLE_JOBWORK' || kind === 'NON_RETURNABLE_DISPATCH' ? null : (kind.replace(/_/g, ' ').toLowerCase() || 'Gate pass'),
      document_type: kind === 'NON_RETURNABLE_DISPATCH' ? 'Tax Invoice' : 'Delivery Challan', document_number: docNo(g.pass_no), document_date: iso(g.pass_date),
      ...(await transporterOf(cid, null, g.transporter_name ?? null)), vehicle_no: g.vehicle_no ?? null,
      transport_doc_no: g.lr_no ? docNo(g.lr_no) : null, source_no: g.pass_no };
    items = withRates(items as any, head.from_state !== head.to_state, kind === 'NON_RETURNABLE_DISPATCH');
  } else if (type === 'STOCK_DELIVERY') {
    const s = await queryOne<any>(`SELECT * FROM trx_stock_delivery WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!s) throw NotFound('Stock delivery not found');
    const to = await consignee(cid, s.party_id ? Number(s.party_id) : null);
    const lines = await query<any>(`SELECT * FROM trx_stock_delivery_line WHERE delivery_id = ? ORDER BY id`, [id]);
    for (const l of lines) {
      const mt = String(l.material_type ?? '').toUpperCase();
      const m = await materialInfo(mt, l.yarn_id ?? l.fabric_id ?? l.trim_id ?? null);
      const st = !m && l.style_id ? await styleInfo(Number(l.style_id)) : null;
      items.push({ product_name: (m?.name || l.item_description || st?.style_name || mt || 'Goods').slice(0, 100), description: [l.color_name, l.sizes].filter(Boolean).join(' ').slice(0, 100) || null,
        hsn_code: m?.hsn_code ?? st?.hsn_code ?? '', quantity: n(l.qty), unit: await uomCode(l.uom_id), taxable_amount: r2(n(l.amount) || n(l.qty) * n(l.rate)) } as any);
    }
    const billable = Number(s.is_billable) === 1;
    const returnable = /RETURN/i.test(String(s.delivery_kind ?? ''));
    head = { ...from, ...to, supply_type: 'OUTWARD', sub_supply_type: billable ? 'Supply' : returnable ? 'Job Work' : 'Others',
      sub_supply_desc: billable || returnable ? null : (s.purpose || 'Stock delivery').slice(0, 100), document_type: billable ? 'Tax Invoice' : 'Delivery Challan',
      document_number: docNo(s.party_dc_no || s.doc_no), document_date: iso(s.doc_date), transporter_party_id: null, transporter_id: null, transporter_name: null,
      vehicle_no: s.vehicle_no ?? null, source_no: s.doc_no };
    items = withRates(items as any, head.from_state !== head.to_state, billable);
  } else throw BadRequest('Unknown document type for an e-way bill');

  delete head.party_type;
  const inter = head.from_state !== head.to_state;
  const values = computeValues(items, inter, 0);
  return { header: { source_type: type, source_id: id, transaction_type: 1, transport_mode: 'Road', vehicle_type: 'Regular', distance_km: 0,
    sub_supply_desc: null, ...head, other_value: 0, ...values }, items, notes };
}

/** Documents of a type the user can make an e-way bill for (picker on the register), newest first. */
export async function sourceDocs(cid: number, type: SourceType, q: string) {
  const like = `%${q}%`;
  const sql: Record<SourceType, string> = {
    DISPATCH: `SELECT d.id, d.dispatch_no no, d.dispatch_date dt, p.party_name party FROM trx_dispatch d LEFT JOIN mst_party p ON p.id = d.buyer_id WHERE d.company_id = ? AND (d.dispatch_no LIKE ? OR p.party_name LIKE ?) ORDER BY d.id DESC LIMIT 50`,
    PROCESS_DC: `SELECT c.id, c.challan_no no, c.challan_date dt, p.party_name party FROM trx_jobwork_challan c LEFT JOIN mst_party p ON p.id = c.vendor_id WHERE c.company_id = ? AND c.status <> 'CANCELLED' AND (c.challan_no LIKE ? OR p.party_name LIKE ?) ORDER BY c.id DESC LIMIT 50`,
    PURCHASE_RETURN: `SELECT r.id, r.return_no no, r.return_date dt, p.party_name party FROM trx_purchase_return r LEFT JOIN mst_party p ON p.id = r.supplier_id WHERE r.company_id = ? AND (r.return_no LIKE ? OR p.party_name LIKE ?) ORDER BY r.id DESC LIMIT 50`,
    GATE_OUTWARD: `SELECT g.id, g.pass_no no, g.pass_date dt, p.party_name party FROM trx_gate_outward g LEFT JOIN mst_party p ON p.id = g.party_id WHERE g.company_id = ? AND (g.pass_no LIKE ? OR p.party_name LIKE ?) ORDER BY g.id DESC LIMIT 50`,
    STOCK_DELIVERY: `SELECT s.id, s.doc_no no, s.doc_date dt, p.party_name party FROM trx_stock_delivery s LEFT JOIN mst_party p ON p.id = s.party_id WHERE s.company_id = ? AND (s.doc_no LIKE ? OR p.party_name LIKE ?) ORDER BY s.id DESC LIMIT 50`,
  };
  return query<any>(sql[type], [cid, like, like]);
}

/** Write the EWB number back on the source document (where it has a field for it). */
export const SOURCE_EWB_COLUMN: Partial<Record<SourceType, [string, string]>> = {
  DISPATCH: ['trx_dispatch', 'eway_bill_no'], PURCHASE_RETURN: ['trx_purchase_return', 'eway_bill_no'], PROCESS_DC: ['trx_jobwork_challan', 'eway_bill_no'],
  GATE_OUTWARD: ['trx_gate_outward', 'eway_bill_no'], STOCK_DELIVERY: ['trx_stock_delivery', 'eway_bill_no'],
};
