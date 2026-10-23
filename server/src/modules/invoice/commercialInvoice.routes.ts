import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { buildInvoiceLayout, buildInvoiceWorkbook, invoiceTotals, type InvoiceDoc } from './invoiceLayout.js';
import { amountWords, qtyWords } from './invoiceWords.js';
import QRCode from 'qrcode';
import { UQC, CONSTRUCTIONS, INVOICE_NO_RE, composeDescription, constructionOf, genderLabel, uqcOf, gstEndorsement, invoiceChecks, hsnSummary } from './invoiceRules.js';

/**
 * Commercial invoice for shipping in the client's FK-087 format (voice note 23-Oct-2026). The invoice is made from the
 * sales order and its CONFIRMED packing list(s) (one invoice can carry several lists / POs, as FK-087): header boxes,
 * marks, packages, cartons and weights come from the lists, lines are the shipped quantity per order / style / colour at
 * the order's price, and the buyer references (SKU / EAN, buyer item id, supplier material no) come from the list's
 * block labels or the buyer's previous invoice. Everything stays editable; amounts and totals are always worked out here.
 * Draft → Final (read-only; reopen with a reason). Print / Excel in the BUYER or IGST layout (invoiceLayout.ts).
 */
export const commercialInvoiceRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const iso = (d: unknown) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
const dmy = (d: unknown) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso(d) ?? '')); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
/** a packing list that can go on an invoice */
const LIVE_PL = ['CONFIRMED', 'CLOSED'];

async function setting(cid: number, key: string) {
  const r = await queryOne<any>(`SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?`, [cid, key]);
  return r?.setting_value ? String(r.setting_value) : null;
}

/* ================================================================ prefill */

/** "SKU NO:5700381298250 / Coop ID No:1000527034 / Supplier Mat no : F2510" → the three references. */
export function parseBlockRefs(label: string | null | undefined) {
  const t = String(label ?? '');
  const pick = (re: RegExp) => re.exec(t)?.[1]?.trim() ?? null;
  return {
    buyer_sku_no: pick(/SKU\s*NO\.?\s*:?\s*([A-Z0-9-]+)/i) ?? pick(/EAN\s*:?\s*([0-9]+)/i),
    buyer_item_no: pick(/(?:COOP\s*)?ID\s*NO\.?\s*:?\s*([A-Z0-9-]+)/i) ?? pick(/ITEM\s*NO\.?\s*:?\s*([A-Z0-9-]+)/i),
    supplier_mat_no: pick(/SUPPLIER\s*MAT\.?\s*NO\.?\s*:?\s*([A-Z0-9-]+)/i) ?? pick(/PRODUCT\s*CODE\s*:?\s*([A-Z0-9-]+)/i),
  };
}

async function companyExporter(cid: number) {
  const fromSetting = await setting(cid, 'CI_EXPORTER_DETAILS');
  if (fromSetting) return fromSetting;
  const c = await queryOne<any>(`SELECT legal_name, address_line1, address_line2, city, pincode, gstin FROM mst_company WHERE id = ?`, [cid]);
  if (!c) return null;
  return [c.legal_name, c.address_line1, c.address_line2, [c.city, c.pincode].filter(Boolean).join(' - ') + (c.city ? '.INDIA' : ''), c.gstin ? `GST NO: ${c.gstin}` : null]
    .filter((x) => x && String(x).trim()).join('\n');
}

async function partyBlock(partyId: number | null) {
  if (!partyId) return null;
  const p = await queryOne<any>(`SELECT p.party_name, a.address_line1, a.address_line2, a.address_line3, a.city, a.pincode, co.name AS country
      FROM mst_party p LEFT JOIN mst_party_address a ON a.party_id = p.id AND a.is_active = 1
      LEFT JOIN cfg_country co ON co.id = COALESCE(a.country_id, p.country_id)
     WHERE p.id = ? ORDER BY a.is_default DESC, a.id LIMIT 1`, [partyId]);
  if (!p) return null;
  return [p.party_name, p.address_line1, p.address_line2, p.address_line3, [p.city, p.pincode].filter(Boolean).join(' '), p.country ? String(p.country).toUpperCase() : null]
    .filter((x) => x && String(x).trim()).join('\n');
}

/** The buyer's (else the company's) latest invoice: the texts that do not change between shipments. */
async function lastInvoice(cid: number, buyerId: number | null, exceptId?: number) {
  const pick = `SELECT * FROM trx_commercial_invoice WHERE company_id = ? AND id <> ? AND exporter_details IS NOT NULL`;
  return (buyerId ? await queryOne<any>(`${pick} AND buyer_id = ? ORDER BY invoice_date DESC, id DESC LIMIT 1`, [cid, exceptId ?? 0, buyerId]) : null)
    ?? queryOne<any>(`${pick} ORDER BY invoice_date DESC, id DESC LIMIT 1`, [cid, exceptId ?? 0]);
}

const prefillQ = z.object({
  so_id: z.coerce.number().int().positive(),
  pl_ids: z.string().trim().max(400).optional(),
  format: z.enum(['BUYER', 'IGST']).default('BUYER'),
});

/** GET /commercial-invoices/prefill?so_id=&pl_ids=1,2&format= — a new invoice worked out from the order + packing lists. */
commercialInvoiceRouter.get('/commercial-invoices/prefill', requirePermission('EXPORT.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = prefillQ.parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  res.json({ data: await prefill(cid, q.so_id, q.pl_ids ? q.pl_ids.split(',').map(Number).filter((x) => x > 0) : null, q.format) });
}));

async function prefill(cid: number, soId: number, plIds: number[] | null, format: 'BUYER' | 'IGST') {
  const so = await queryOne<any>(`SELECT so.*, cu.code AS currency_code, co.name AS dest_country FROM trx_sales_order so
      LEFT JOIN cfg_currency cu ON cu.id = so.currency_id LEFT JOIN cfg_country co ON co.id = so.destination_country
     WHERE so.id = ? AND so.company_id = ? AND so.is_deleted = 0`, [soId, cid]);
  if (!so) throw NotFound('Sales order not found');
  // every packing list of the order (the picker); the chosen ones must be confirmed and free of another invoice
  const all = await query<any>(`SELECT pl.id, pl.pl_no, pl.status, pl.pl_type, pl.invoice_id, ci.invoice_no AS linked_invoice_no, pl.total_cartons, pl.total_qty,
      pl.net_weight_kg, pl.gross_weight_kg, pl.buyer_order_no, pl.buyer_order_date, pl.pl_date
      FROM trx_packing_list pl LEFT JOIN trx_commercial_invoice ci ON ci.id = pl.invoice_id
     WHERE pl.company_id = ? AND pl.so_id = ? ORDER BY pl.id`, [cid, soId]);
  const chosenIds = plIds ?? all.filter((p) => LIVE_PL.includes(p.status) && !p.invoice_id).map((p) => Number(p.id));
  const pls = chosenIds.length ? await query<any>(`SELECT * FROM trx_packing_list WHERE company_id = ? AND id IN (?) ORDER BY id`, [cid, chosenIds]) : [];
  for (const p of pls) if (!LIVE_PL.includes(p.status)) throw BadRequest(`${p.pl_no} is ${String(p.status).toLowerCase()} — confirm the packing list first`);
  const pl0 = pls[0];
  const last = await lastInvoice(cid, Number(so.buyer_id));
  const fx = so.currency_code === 'INR' ? 1 : n(so.exchange_rate) > 1 ? n(so.exchange_rate)
    : n((await queryOne<any>(`SELECT x.rate FROM trx_exchange_rate x JOIN cfg_currency i ON i.id = x.to_currency AND i.code = 'INR' WHERE x.from_currency = ? ORDER BY x.rate_date DESC LIMIT 1`, [so.currency_id]))?.rate) || 1;

  const poOf = (no: unknown, dt: unknown) => `PO NO: ${no}${dt ? `   DT: ${dmy(dt)}.` : ''}`;
  let poLines = [...new Set(pls.filter((p) => p.buyer_order_no).map((p) => poOf(p.buyer_order_no, p.buyer_order_date)))];
  if (!poLines.length && so.buyer_po_no) poLines = [poOf(so.buyer_po_no, so.buyer_po_date)];
  const cartons = pls.reduce((t, p) => t + n(p.total_cartons), 0);
  const pcs = pls.reduce((t, p) => t + n(p.total_qty), 0);
  const firstOf = (k: string) => pls.map((p) => p[k]).find((v) => v != null && String(v).trim() !== '') ?? null;

  // ---------- lines: shipped qty per order / style / colour (packing list items), else the order lines
  let lines: any[] = [];
  const soIds = [...new Set([soId, ...(pls.length ? (await query<any>(`SELECT DISTINCT so_id FROM trx_packing_list_row_item WHERE packing_list_id IN (?) AND so_id IS NOT NULL`, [chosenIds])).map((x) => Number(x.so_id)) : [])])];
  const soLines = await query<any>(`SELECT l.*, st.style_code, st.style_name, c.color_name, so2.buyer_po_no FROM trx_sales_order_line l
      JOIN trx_sales_order so2 ON so2.id = l.so_id LEFT JOIN mst_style st ON st.id = l.style_id LEFT JOIN mst_color c ON c.id = l.color_id WHERE l.so_id IN (?)`, [soIds]);
  const soLineOf = (lineSo: number, styleId: number, colorId: number | null) => {
    const cands = soLines.filter((l) => Number(l.so_id) === lineSo && Number(l.style_id) === styleId);
    return cands.find((l) => colorId && Number(l.color_id) === colorId) ?? cands[0] ?? null;
  };
  // client 23-Oct-2026: "Order No" on the invoice is the buyer's PO number
  const poOfSo = new Map<number, string | null>(soLines.map((l) => [Number(l.so_id), l.buyer_po_no ?? null]));
  poOfSo.set(soId, so.buyer_po_no ?? null);
  // size range shipped, in the style's size order (S-XXL)
  const sizeSeq = new Map<string, number>();
  const styleIdsAll = [...new Set(soLines.map((l) => Number(l.style_id)))];
  if (styleIdsAll.length) {
    for (const r of await query<any>(`SELECT ss.style_id, sz.size_code, ss.sequence_no FROM mst_style_size ss JOIN mst_size sz ON sz.id = ss.size_id WHERE ss.style_id IN (?)`, [styleIdsAll])) {
      sizeSeq.set(`${r.style_id}|${String(r.size_code).toUpperCase()}`, Number(r.sequence_no));
    }
  }
  const sizeRange = (styleId: number, sizes: string[]) => {
    const u = [...new Set(sizes.filter(Boolean))];
    u.sort((a, b) => (sizeSeq.get(`${styleId}|${a.toUpperCase()}`) ?? 999) - (sizeSeq.get(`${styleId}|${b.toUpperCase()}`) ?? 999) || a.localeCompare(b, undefined, { numeric: true }));
    return !u.length ? null : u.length === 1 ? u[0] : `${u[0]}-${u[u.length - 1]}`;
  };
  if (pls.length) {
    const items = await query<any>(`SELECT i.so_id, i.order_no, i.style_id, MIN(i.style_no) style_no, i.color_id, MIN(i.colour) colour, SUM(i.total_qty) qty,
             MIN(b.label) AS block_label, MIN(i.id) first_id, GROUP_CONCAT(i.size_qty SEPARATOR '\u0001') AS size_json
        FROM trx_packing_list_row_item i JOIN trx_packing_list_row r ON r.id = i.row_id LEFT JOIN trx_packing_list_block b ON b.id = r.block_id
       WHERE i.packing_list_id IN (?)
       GROUP BY i.so_id, i.order_no, i.style_id, i.color_id ORDER BY first_id`, [chosenIds]);
    lines = items.filter((i) => n(i.qty) > 0).map((i) => {
      const sl = soLineOf(Number(i.so_id ?? soId), Number(i.style_id), i.color_id ? Number(i.color_id) : null);
      const sizes: string[] = [];
      for (const j of String(i.size_json ?? '').split('\u0001')) {
        try { const o = JSON.parse(j); if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (Number(v) > 0) sizes.push(String(k)); } catch { /* no sizes */ }
      }
      // only the buyer's PO — never our own order no (the packing list falls back to it when the order has no PO)
      return { so_id: i.so_id ?? soId, style_id: i.style_id, color_id: i.color_id, order_no: poOfSo.get(Number(i.so_id ?? soId)) ?? null,
        qty: n(i.qty), unit_price: n(sl?.unit_price), sl, style_code: i.style_no ?? sl?.style_code, colour: i.colour ?? sl?.color_name ?? null,
        size_text: sizeRange(Number(i.style_id), sizes), ...parseBlockRefs(i.block_label) };
    });
  } else {
    const skuSizes = await query<any>(`SELECT ss.so_line_id, sz.size_code FROM trx_sales_order_sku ss JOIN mst_style_sku k ON k.id = ss.sku_id JOIN mst_size sz ON sz.id = k.size_id
       WHERE ss.so_line_id IN (?) AND ss.qty > 0`, [soLines.length ? soLines.map((l) => l.id) : [0]]).catch(() => []);
    lines = soLines.filter((l) => Number(l.so_id) === soId).map((l) => ({ so_id: soId, style_id: l.style_id, color_id: l.color_id, order_no: so.buyer_po_no,
      qty: Math.max(0, n(l.order_qty) - n(l.cancelled_qty)), unit_price: n(l.unit_price), sl: l, style_code: l.style_code, colour: l.assort_color || l.color_name || null,
      size_text: sizeRange(Number(l.style_id), skuSizes.filter((x) => Number(x.so_line_id) === Number(l.id)).map((x) => String(x.size_code))),
      buyer_sku_no: null, buyer_item_no: null, supplier_mat_no: null }));
  }
  // description of goods: the order line's (client 23-Oct-2026: "the composition we put on the sales order comes
  // automatically, editable"); else the buyer's earlier invoice of the style; else built from the masters
  const prev = await query<any>(`SELECT l.* FROM trx_commercial_invoice_line l
      JOIN trx_commercial_invoice ci ON ci.id = l.invoice_id WHERE ci.company_id = ? AND ci.buyer_id = ? AND l.line_kind = 'GOODS' ORDER BY ci.invoice_date DESC, l.id DESC LIMIT 500`, [cid, so.buyer_id]);
  const styleIds = [...new Set(lines.map((l) => Number(l.style_id)).filter(Boolean))];
  const masters = styleIds.length ? await query<any>(`SELECT st.id, p.product_name, p.gender, p.hsn_code AS product_hsn, f.fabric_type, f.hsn_code AS fabric_hsn, cm.description AS composition, um.code AS uom
      FROM mst_style st LEFT JOIN mst_product p ON p.id = st.product_id LEFT JOIN mst_fabric f ON f.id = st.fabric_id
      LEFT JOIN mst_composition cm ON cm.id = f.composition_id LEFT JOIN cfg_uom um ON um.id = p.default_uom WHERE st.id IN (?)`, [styleIds]) : [];
  const qtyUnit = last?.qty_unit ?? 'PCS';
  lines = lines.map((l, i) => {
    const pv = prev.find((p) => Number(p.style_id) === Number(l.style_id));
    const ms = masters.find((m) => Number(m.id) === Number(l.style_id));
    const hsn = pv?.hsn_code ?? (ms?.product_hsn && /^\d{8}$/.test(ms.product_hsn) ? ms.product_hsn : null) ?? null;
    const soComposition = l.sl?.composition ? String(l.sl.composition).toUpperCase() : null;
    const masterParts = { composition: ms?.composition ? String(ms.composition).toUpperCase() : null, construction: constructionOf(ms?.fabric_type, hsn),
      gender_label: genderLabel(ms?.gender), garment: ms?.product_name ? String(ms.product_name).toUpperCase() : null, pack_info: null };
    const parts = pv && (pv.composition || pv.garment)
      ? { composition: pv.composition, construction: pv.construction, gender_label: pv.gender_label, garment: pv.garment, pack_info: pv.pack_info }
      : masterParts;
    if (soComposition) parts.composition = soComposition;
    const composed = composeDescription(parts);
    const soTyped = l.sl?.goods_description ? String(l.sl.goods_description).toUpperCase() : null;
    const typed = soTyped ?? (pv && Number(pv.desc_auto) === 0 ? pv.description : null);
    return {
      line_kind: 'GOODS', sort_order: i + 1, so_id: l.so_id, style_id: l.style_id, color_id: l.color_id, order_no: l.order_no,
      style_ref: pv?.style_ref && Number(pv.style_id) === Number(l.style_id) ? pv.style_ref : l.style_code ?? null, colour: l.colour ?? null, size_text: l.size_text ?? null,
      buyer_sku_no: l.buyer_sku_no ?? pv?.buyer_sku_no ?? null, buyer_item_no: l.buyer_item_no ?? pv?.buyer_item_no ?? null,
      supplier_mat_no: l.supplier_mat_no ?? pv?.supplier_mat_no ?? l.style_code ?? null,
      ...parts, desc_auto: typed ? 0 : composed ? 1 : 0,
      description: typed ?? (composed || pv?.description || l.sl?.description || null), hsn_code: hsn, uqc: pv?.uqc ?? uqcOf(ms?.uom ?? qtyUnit),
      qty: l.qty, unit_price: l.unit_price, amount: r2(l.qty * l.unit_price), gst_rate: null,
    };
  });
  if (format === 'IGST' && last) {
    // the previous invoice's charge lines (hanger cost …) come back with the goods quantity as their quantity
    const ch = await query<any>(`SELECT * FROM trx_commercial_invoice_line WHERE invoice_id = ? AND line_kind = 'CHARGE' ORDER BY sort_order, id`, [last.id]);
    const gq = lines.reduce((t, l) => t + n(l.qty), 0);
    ch.forEach((c, k) => lines.push({ line_kind: 'CHARGE', sort_order: lines.length + k + 1, description: c.description, hsn_code: c.hsn_code, qty: gq, desc_auto: 0, uqc: c.uqc ?? 'PCS',
      unit_price: n(c.unit_price), amount: r2(gq * n(c.unit_price)), gst_rate: c.gst_rate, order_no: null, buyer_sku_no: null, buyer_item_no: null, supplier_mat_no: null }));
  }

  const exporter = firstOf('exporter_details') ?? last?.exporter_details ?? await companyExporter(cid);
  const buyerShort = (await queryOne<any>(`SELECT COALESCE(NULLIF(short_name,''), party_name) n FROM mst_party WHERE id = ?`, [so.buyer_id]))?.n ?? '';
  const marks = last?.marks_nos
    ? String(last.marks_nos).replace(/\b\d{1,4}\s*TO\s*\d{1,5}\b/i, `01 TO ${cartons || ''}`).replace(/\b\d+\s*PACKAGES\b/i, `${cartons || ''} PACKAGES`)
    : [buyerShort.toUpperCase(), 'Carton No:', cartons ? `01 TO ${cartons}` : '', cartons ? `${cartons} PACKAGES` : ''].filter(Boolean).join('\n');
  return {
    so_id: soId, so_no: so.so_no, io_no: so.io_no, buyer_id: so.buyer_id, currency_id: so.currency_id, currency_code: so.currency_code, exchange_rate: fx,
    invoice_format: format, invoice_date: new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10),
    packing_lists: all.map((p) => ({ ...p, pl_date: iso(p.pl_date), buyer_order_date: iso(p.buyer_order_date), selectable: LIVE_PL.includes(p.status) && !p.invoice_id })),
    pl_ids: chosenIds,
    exporter_details: exporter,
    exporter_ref: last?.exporter_ref ?? await (async () => { const iec = (await queryOne<any>(`SELECT iec_code FROM mst_company WHERE id = ?`, [cid]))?.iec_code; return iec ? `IEC NO : ${iec}` : null; })(),
    buyer_order_ref: poLines.join('\n') || null,
    other_references: firstOf('other_references') ?? last?.other_references ?? 'STYLE NO:  AS PER BELOW',
    consignee_details: firstOf('consignee_details') ?? await partyBlock(Number(pl0?.consignee_id ?? so.buyer_id)),
    buyer_details: last?.buyer_details ?? null,
    ship_to_details: (pl0 && /SHIP|DELIVER/i.test(String(pl0.notify_label ?? '')) ? pl0.notify_details : null) ?? firstOf('notify_details') ?? last?.ship_to_details ?? null,
    country_origin_text: firstOf('country_of_origin') ?? 'INDIA',
    country_dest_text: firstOf('country_of_destination') ?? (so.dest_country ? String(so.dest_country).toUpperCase() : null),
    pre_carriage_by: firstOf('pre_carriage_by') ?? last?.pre_carriage_by ?? null,
    place_of_receipt: firstOf('place_of_receipt') ?? last?.place_of_receipt ?? null,
    vessel_flight_no: firstOf('vessel_flight_no') ?? last?.vessel_flight_no ?? null,
    port_of_loading: firstOf('port_of_loading') ?? so.port_of_loading ?? null,
    port_of_discharge: firstOf('port_of_discharge') ?? so.destination_port ?? null,
    final_destination: firstOf('final_destination') ?? (so.dest_country ? String(so.dest_country).toUpperCase() : null),
    terms_of_delivery: firstOf('terms_of_delivery') ?? last?.terms_of_delivery ?? (so.incoterm ? `${so.incoterm} BY SEA FROM ${String(so.port_of_loading ?? '').toUpperCase()}.` : null),
    terms_of_payment: firstOf('terms_of_payment') ?? last?.terms_of_payment ?? null,
    marks_nos: marks || null,
    packages_text: cartons ? `${cartons}  CTNS\n${cartons}  PACKAGES` : null,
    goods_heading: last?.goods_heading ?? null,
    item_ref_label: last?.item_ref_label ?? (/COOP/i.test(buyerShort) ? 'COOP ID NO' : 'BUYER ITEM NO'),
    qty_unit: last?.qty_unit ?? 'PCS', rate_basis: last?.rate_basis ?? `FOB ${so.currency_code}`,
    total_cartons: cartons || null, total_pcs: pcs || null, total_pcs_unit: last?.total_pcs_unit ?? 'PCS',
    net_weight_kg: pls.length ? r2(pls.reduce((t, p) => t + n(p.net_weight_kg), 0)) : null,
    gross_weight_kg: pls.length ? r2(pls.reduce((t, p) => t + n(p.gross_weight_kg), 0)) : null,
    bank_details: last?.bank_details ?? await setting(cid, 'CI_BANK_DETAILS'),
    rex_declaration: last?.rex_declaration ?? await setting(cid, 'CI_REX_DECLARATION'),
    declaration: last?.declaration ?? await setting(cid, 'CI_DECLARATION'),
    footer_note: format === 'IGST' ? last?.footer_note ?? null : null,
    goods_gst_rate: last?.goods_gst_rate ?? (format === 'IGST' ? 5 : null), charges_gst_rate: last?.charges_gst_rate ?? (format === 'IGST' ? 18 : null),
    gst_supply_type: format === 'IGST' ? 'IGST' : last?.gst_supply_type ?? ((await setting(cid, 'CI_LUT_ARN')) ? 'LUT' : null),
    lut_arn: last?.lut_arn ?? await setting(cid, 'CI_LUT_ARN'),
    lines,
  };
}

/* ================================================================ save */
const lineSchema = z.object({
  line_kind: z.enum(['GOODS', 'CHARGE']).default('GOODS'),
  so_id: s.id(), style_id: s.id(), color_id: s.id(),
  order_no: s.nullableStr(60), buyer_sku_no: s.nullableStr(60), buyer_item_no: s.nullableStr(60), supplier_mat_no: s.nullableStr(60),
  description: s.nullableStr(500), hsn_code: z.union([z.string().trim().regex(/^\d{4,8}$/, 'HSN: 4 to 8 digits'), z.literal(''), z.null()]).transform((v) => v || null).nullish(),
  composition: s.nullableStr(120), construction: z.union([z.enum(CONSTRUCTIONS), z.literal(''), z.null()]).transform((v) => v || null).nullish(),
  gender_label: s.nullableStr(20), garment: s.nullableStr(80), pack_info: s.nullableStr(80),
  style_ref: s.nullableStr(60), colour: s.nullableStr(80), size_text: s.nullableStr(80),
  desc_auto: z.coerce.boolean().default(false), uqc: z.union([z.enum(UQC), z.literal(''), z.null()]).transform((v) => v || null).nullish(),
  qty: z.coerce.number().positive('Quantity must be more than 0'),
  unit_price: z.coerce.number().min(0, 'Rate cannot be negative'),
  gst_rate: z.coerce.number().min(0).max(40).nullish(),
});
const txt = (max: number) => s.nullableStr(max);
const invSchema = z.object({
  invoice_no: z.union([z.string().trim().regex(INVOICE_NO_RE, 'Invoice no: at most 16 characters — letters, digits, - and / (GST rule)'), z.literal(''), z.null()]).transform((v) => v || null).nullish(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  so_id: s.idReq(), invoice_format: z.enum(['BUYER', 'IGST']).default('BUYER'),
  currency_id: s.id(), exchange_rate: z.coerce.number().positive('Enter the exchange rate').nullish(),
  pl_ids: z.array(z.coerce.number().int().positive()).max(30).default([]),
  exporter_details: s.text(), exporter_ref: txt(200), buyer_order_ref: txt(500), other_references: txt(500),
  consignee_details: s.text(), buyer_details: s.text(), ship_to_details: s.text(),
  country_origin_text: txt(60), country_dest_text: txt(60), pre_carriage_by: txt(80), place_of_receipt: txt(80), vessel_flight_no: txt(80),
  port_of_loading: txt(80), port_of_discharge: txt(80), final_destination: txt(80), terms_of_delivery: txt(500), terms_of_payment: txt(500),
  marks_nos: s.text(), packages_text: txt(200), goods_heading: s.text(), item_ref_label: txt(30),
  qty_unit: z.string().trim().min(1).max(12).default('PCS'), rate_basis: txt(20),
  total_cartons: z.coerce.number().int().min(0).nullish(), total_pcs: z.coerce.number().int().min(0).nullish(), total_pcs_unit: txt(12),
  net_weight_kg: z.coerce.number().min(0).nullish(), gross_weight_kg: z.coerce.number().min(0).nullish(),
  qty_words: txt(300), amount_words: txt(300),
  bank_details: s.text(), rex_declaration: s.text(), declaration: s.text(), footer_note: s.text(),
  goods_gst_rate: z.coerce.number().min(0).max(40).nullish(), charges_gst_rate: z.coerce.number().min(0).max(40).nullish(),
  remarks: s.text(),
  gst_supply_type: z.union([z.enum(['LUT', 'IGST']), z.literal(''), z.null()]).transform((v) => v || null).nullish(), lut_arn: txt(40),
  lines: z.array(lineSchema).min(1, 'Add at least one line').max(300),
  row_version: z.coerce.number().int().nullish(),
});
type InvIn = z.infer<typeof invSchema>;

const HEADER_TEXT = ['exporter_details', 'exporter_ref', 'buyer_order_ref', 'other_references', 'consignee_details', 'buyer_details', 'ship_to_details',
  'country_origin_text', 'country_dest_text', 'pre_carriage_by', 'place_of_receipt', 'vessel_flight_no', 'port_of_loading', 'port_of_discharge', 'final_destination',
  'terms_of_delivery', 'terms_of_payment', 'marks_nos', 'packages_text', 'goods_heading', 'item_ref_label', 'qty_unit', 'rate_basis', 'total_cartons', 'total_pcs',
  'total_pcs_unit', 'net_weight_kg', 'gross_weight_kg', 'qty_words', 'amount_words', 'bank_details', 'rex_declaration', 'declaration', 'footer_note',
  'goods_gst_rate', 'charges_gst_rate', 'remarks', 'gst_supply_type', 'lut_arn'] as const;

async function validate(tx: Tx, cid: number, b: InvIn, invoiceId: number | null) {
  const so = await txQueryOne<any>(tx, `SELECT so.id, so.buyer_id, so.currency_id, so.exchange_rate, so.approval_state, cu.code AS currency_code FROM trx_sales_order so
      LEFT JOIN cfg_currency cu ON cu.id = so.currency_id WHERE so.id = ? AND so.company_id = ? AND so.is_deleted = 0`, [b.so_id, cid]);
  if (!so) throw BadRequest('Sales order not found', [{ field: 'so_id', message: 'Pick the sales order' }]);
  if (['DRAFT', 'CANCELLED', 'REJECTED'].includes(so.approval_state)) throw BadRequest(`The order is ${String(so.approval_state).toLowerCase()} — invoice an approved order`);
  const currencyId = b.currency_id ?? so.currency_id;
  const cur = await txQueryOne<any>(tx, `SELECT code FROM cfg_currency WHERE id = ?`, [currencyId]);
  if (!cur) throw BadRequest('Currency not found');
  const xr = cur.code === 'INR' ? 1 : n(b.exchange_rate);
  if (cur.code !== 'INR' && !(xr > 0)) throw BadRequest(`Enter the exchange rate (₹ per 1 ${cur.code})`, [{ field: 'exchange_rate', message: 'Required' }]);
  if (b.invoice_format === 'IGST' && b.goods_gst_rate == null) throw BadRequest('IGST format: enter the GST % on goods', [{ field: 'goods_gst_rate', message: 'Required' }]);
  if (b.invoice_format === 'IGST' && b.lines.some((l) => l.line_kind === 'CHARGE') && b.charges_gst_rate == null) throw BadRequest('IGST format: enter the GST % on charges', [{ field: 'charges_gst_rate', message: 'Required' }]);
  if (!b.lines.some((l) => l.line_kind === 'GOODS')) throw BadRequest('Add at least one goods line');
  // packing lists: of this order (or carrying its items), confirmed, not on another invoice
  const ids = [...new Set(b.pl_ids)];
  if (ids.length) {
    const pls = await txQuery<any>(tx, `SELECT pl.id, pl.pl_no, pl.status, pl.so_id, pl.invoice_id, ci.invoice_no FROM trx_packing_list pl LEFT JOIN trx_commercial_invoice ci ON ci.id = pl.invoice_id
        WHERE pl.company_id = ? AND pl.id IN (?) FOR UPDATE`, [cid, ids]);
    if (pls.length !== ids.length) throw BadRequest('A packing list was not found');
    for (const p of pls) {
      if (!LIVE_PL.includes(p.status)) throw BadRequest(`${p.pl_no} is ${String(p.status).toLowerCase()} — confirm the packing list first`);
      if (p.invoice_id && Number(p.invoice_id) !== invoiceId) throw Conflict(`${p.pl_no} is already on invoice ${p.invoice_no}`);
    }
  }
  return { so, currencyId, currencyCode: cur.code as string, xr };
}

async function writeInvoice(tx: Tx, req: Request, b: InvIn, id: number | null) {
  const cid = req.user!.companyId;
  const v = await validate(tx, cid, b, id);
  if (b.invoice_format === 'IGST' && b.gst_supply_type === 'LUT') throw BadRequest('The IGST layout is for exports on payment of IGST — choose the buyer layout for a LUT export', [{ field: 'gst_supply_type', message: 'Not with the IGST layout' }]);
  const lines = b.lines.map((l, i) => {
    const composed = composeDescription(l);
    // description built from its parts unless typed; a line needs one or the other
    const description = l.desc_auto && composed ? composed : l.description ?? (composed || null);
    if (!description) throw BadRequest(`Line ${i + 1}: enter the description (or its parts)`);
    return { ...l, description, desc_auto: l.desc_auto && !!composed, sort_order: i + 1, amount: r2(l.qty * l.unit_price) };
  });
  const T = invoiceTotals({ lines: lines as any, exchange_rate: v.xr, goods_gst_rate: b.goods_gst_rate ?? null, charges_gst_rate: b.charges_gst_rate ?? null });
  const head: Record<string, unknown> = {
    invoice_date: b.invoice_date, so_id: b.so_id, buyer_id: v.so.buyer_id, currency_id: v.currencyId, exchange_rate: v.xr, invoice_format: b.invoice_format,
    fob_value: T.goods_amount, total_value: T.total_amount, port_of_loading: b.port_of_loading ?? null, port_of_discharge: b.port_of_discharge ?? null,
    final_destination: b.final_destination ?? null,
  };
  for (const k of HEADER_TEXT) head[k] = (b as any)[k] ?? null;
  head.qty_unit = b.qty_unit;
  let invoiceId = id;
  if (id == null) {
    let no = b.invoice_no?.trim() || null;
    if (no) { if (await txQueryOne(tx, `SELECT id FROM trx_commercial_invoice WHERE company_id = ? AND invoice_no = ?`, [cid, no])) throw Conflict(`Invoice no ${no} is already used`); }
    else for (let i = 0; i < 200; i++) { no = await nextDocNumber(tx, cid, 'INVOICE'); if (!(await txQueryOne(tx, `SELECT id FROM trx_commercial_invoice WHERE company_id = ? AND invoice_no = ?`, [cid, no]))) break; }
    const keys = Object.keys(head);
    const r = await txExecute(tx, `INSERT INTO trx_commercial_invoice (company_id, invoice_no, created_by, ${keys.join(', ')}) VALUES (?,?,?,${keys.map(() => '?').join(',')})`,
      [cid, no, req.user!.id, ...keys.map((k) => head[k] as any)]);
    invoiceId = Number(r.insertId);
  } else {
    if (b.invoice_no?.trim()) {
      const dup = await txQueryOne<any>(tx, `SELECT id FROM trx_commercial_invoice WHERE company_id = ? AND invoice_no = ? AND id <> ?`, [cid, b.invoice_no.trim(), id]);
      if (dup) throw Conflict(`Invoice no ${b.invoice_no.trim()} is already used`);
      head.invoice_no = b.invoice_no.trim();
    }
    const keys = Object.keys(head);
    await txExecute(tx, `UPDATE trx_commercial_invoice SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
      [...keys.map((k) => head[k] as any), req.user!.id, id]);
    await txExecute(tx, `DELETE FROM trx_commercial_invoice_line WHERE invoice_id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_packing_list SET invoice_id = NULL WHERE company_id = ? AND invoice_id = ?`, [cid, id]);
  }
  for (const l of lines) {
    await txExecute(tx, `INSERT INTO trx_commercial_invoice_line (invoice_id, sort_order, line_kind, so_id, style_id, color_id, order_no, buyer_sku_no, buyer_item_no, supplier_mat_no,
        description, hsn_code, qty, unit_price, amount, gst_rate, composition, construction, gender_label, garment, pack_info, desc_auto, uqc, style_ref, colour, size_text)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [invoiceId, l.sort_order, l.line_kind, l.so_id ?? null, l.style_id ?? null, l.color_id ?? null, l.order_no ?? null, l.buyer_sku_no ?? null, l.buyer_item_no ?? null,
        l.supplier_mat_no ?? null, l.description, l.hsn_code ?? null, l.qty, l.unit_price, l.amount, l.gst_rate ?? null,
        l.composition ?? null, l.construction ?? null, l.gender_label ?? null, l.garment ?? null, l.pack_info ?? null, l.desc_auto ? 1 : 0, l.uqc ?? null,
        l.style_ref ?? null, l.colour ?? null, l.size_text ?? null]);
  }
  if (b.pl_ids.length) await txQuery(tx, `UPDATE trx_packing_list SET invoice_id = ? WHERE company_id = ? AND id IN (?)`, [invoiceId, cid, [...new Set(b.pl_ids)]]);
  return invoiceId!;
}

commercialInvoiceRouter.post('/commercial-invoices', requirePermission('EXPORT.CREATE'), ah(async (req, res) => {
  const b = invSchema.parse(req.body ?? {});
  const id = await transaction((tx) => writeInvoice(tx, req, b, null));
  await audit(req, 'trx_commercial_invoice', id, 'INSERT', undefined, { so_id: b.so_id, format: b.invoice_format, lines: b.lines.length, pl_ids: b.pl_ids });
  res.status(201).json({ data: { id } });
}));

commercialInvoiceRouter.put('/commercial-invoices/:id', requirePermission('EXPORT.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = invSchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_commercial_invoice WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!cur) throw NotFound('Invoice not found');
    if (cur.doc_status === 'FINAL') throw BadRequest('A final invoice is read-only — reopen it to change it');
    if (b.row_version != null && Number(b.row_version) !== Number(cur.row_version)) throw Conflict('This invoice was changed by someone else — reload it');
    await writeInvoice(tx, req, b, id);
  });
  await audit(req, 'trx_commercial_invoice', id, 'UPDATE', undefined, { format: b.invoice_format, lines: b.lines.length, pl_ids: b.pl_ids });
  res.json({ data: { id } });
}));

commercialInvoiceRouter.post('/commercial-invoices/:id/finalize', requirePermission('EXPORT.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  // the mandatory export particulars (invoiceRules.invoiceChecks) — every error must be cleared first
  const inv = await loadInvoice(cid, id);
  if (inv.checks.errors.length) throw BadRequest(`Cannot finalise — ${inv.checks.errors.length} point(s) to fix: ${inv.checks.errors.join('; ')}`, inv.checks.errors.map((m) => ({ field: 'checks', message: m })));
  await transaction(async (tx) => {
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_commercial_invoice WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!cur) throw NotFound('Invoice not found');
    if (cur.doc_status === 'FINAL') return;
    if (Number(cur.row_version) !== Number(inv.row_version)) throw Conflict('The invoice changed while it was being checked — try again');
    await txExecute(tx, `UPDATE trx_commercial_invoice SET doc_status = 'FINAL', finalized_by = ?, finalized_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [req.user!.id, id]);
  });
  await audit(req, 'trx_commercial_invoice', id, 'UPDATE', { doc_status: 'DRAFT' }, { doc_status: 'FINAL' });
  res.json({ data: { id, doc_status: 'FINAL' } });
}));

commercialInvoiceRouter.post('/commercial-invoices/:id/reopen', requirePermission('EXPORT.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Give the reason').max(255) }).parse(req.body ?? {});
  const cur = await queryOne<any>(`SELECT doc_status FROM trx_commercial_invoice WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!cur) throw NotFound('Invoice not found');
  if (cur.doc_status !== 'FINAL') throw BadRequest('The invoice is not final');
  const sb = await queryOne<any>(`SELECT sb_no FROM trx_shipping_bill WHERE company_id = ? AND invoice_id = ? LIMIT 1`, [cid, id]);
  if (sb) throw BadRequest(`Shipping bill ${sb.sb_no} is filed on this invoice — the invoice stays final (delete the shipping bill entry first if it was wrong)`);
  const ewb = await queryOne<any>(`SELECT doc_no, ewb_no, status FROM trx_eway_bill WHERE company_id = ? AND source_type = 'COMMERCIAL_INVOICE' AND source_id = ? AND status <> 'CANCELLED' LIMIT 1`, [cid, id]);
  if (ewb) throw BadRequest(ewb.ewb_no ? `E-way bill ${ewb.ewb_no} is made on this invoice — cancel it first (within 24 hours), then reopen the invoice`
    : `Draft e-way bill ${ewb.doc_no} is made from this invoice — delete it first, then reopen the invoice`);
  await query(`UPDATE trx_commercial_invoice SET doc_status = 'DRAFT', row_version = row_version + 1 WHERE id = ?`, [id]);
  await audit(req, 'trx_commercial_invoice', id, 'UPDATE', { doc_status: 'FINAL' }, { doc_status: 'DRAFT', reason });
  res.json({ data: { id, doc_status: 'DRAFT' } });
}));

commercialInvoiceRouter.delete('/commercial-invoices/:id', requirePermission('EXPORT.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_commercial_invoice WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!cur) throw NotFound('Invoice not found');
    if (cur.doc_status === 'FINAL') throw BadRequest('A final invoice cannot be deleted — reopen it first');
    for (const [t, c] of [['trx_shipping_bill', 'invoice_id'], ['trx_export_incentive', 'invoice_id'], ['trx_shipment', 'invoice_id']] as const) {
      const used = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [t, c]);
      if (Number(used?.c) && Number((await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM ${t} WHERE ${c} = ?`, [id]))?.c)) throw BadRequest(`The invoice is used on a ${t.replace('trx_', '').replace(/_/g, ' ')} — remove it there first`);
    }
    await txExecute(tx, `UPDATE trx_packing_list SET invoice_id = NULL WHERE company_id = ? AND invoice_id = ?`, [cid, id]);
    await txExecute(tx, `DELETE FROM trx_invoice_tax WHERE invoice_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM trx_commercial_invoice_line WHERE invoice_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM trx_commercial_invoice WHERE id = ?`, [id]);
  });
  await audit(req, 'trx_commercial_invoice', id, 'DELETE');
  res.json({ data: { id, deleted: true } });
}));

/* ================================================================ read */
commercialInvoiceRouter.get('/commercial-invoices', requirePermission('EXPORT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({
    q: z.string().trim().max(60).optional(), buyer_id: z.coerce.number().int().optional(), so_id: z.coerce.number().int().optional(),
    doc_status: z.enum(['DRAFT', 'FINAL']).optional(), invoice_format: z.enum(['BUYER', 'IGST']).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25),
  }).parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  const w = ['t.company_id = ?']; const p: unknown[] = [cid];
  if (q.q) { w.push('(t.invoice_no LIKE ? OR so.so_no LIKE ? OR so.io_no LIKE ? OR t.buyer_order_ref LIKE ? OR b.party_name LIKE ?)'); p.push(...Array(5).fill(`%${q.q}%`)); }
  for (const k of ['buyer_id', 'so_id', 'doc_status', 'invoice_format'] as const) if (q[k] != null) { w.push(`t.${k} = ?`); p.push(q[k]); }
  if (q.from) { w.push('t.invoice_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('t.invoice_date <= ?'); p.push(q.to); }
  const where = w.join(' AND ');
  const [rows, total] = await Promise.all([
    query<any>(`SELECT t.id, t.invoice_no, t.invoice_date, t.invoice_format, t.doc_status, t.so_id, so.so_no, so.io_no, b.party_name AS buyer_name, cu.code AS currency_code,
        t.total_value, t.exchange_rate, t.total_cartons, t.total_pcs, t.buyer_order_ref,
        (SELECT GROUP_CONCAT(pl.pl_no ORDER BY pl.id SEPARATOR ', ') FROM trx_packing_list pl WHERE pl.invoice_id = t.id) AS packing_lists,
        (SELECT SUM(l.qty) FROM trx_commercial_invoice_line l WHERE l.invoice_id = t.id AND COALESCE(l.line_kind,'GOODS') = 'GOODS') AS qty
       FROM trx_commercial_invoice t LEFT JOIN trx_sales_order so ON so.id = t.so_id LEFT JOIN mst_party b ON b.id = t.buyer_id LEFT JOIN cfg_currency cu ON cu.id = t.currency_id
      WHERE ${where} ORDER BY t.invoice_date DESC, t.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p),
    queryOne<any>(`SELECT COUNT(*) c FROM trx_commercial_invoice t LEFT JOIN trx_sales_order so ON so.id = t.so_id LEFT JOIN mst_party b ON b.id = t.buyer_id WHERE ${where}`, p),
  ]);
  res.json({ data: rows.map((r) => ({ ...r, invoice_date: iso(r.invoice_date) })), pagination: { page: q.page, pageSize: q.pageSize, total: n(total?.c), totalPages: Math.max(1, Math.ceil(n(total?.c) / q.pageSize)) } });
}));

/** "23/10/2026 14:05:00" in IST (the e-way bill print's date format; DATETIMEs are stored in UTC). */
const istStamp = (d: unknown) => {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(String(d));
  if (Number.isNaN(x.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(x).map((q) => [q.type, q.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
};

/**
 * The generated e-way bill of the invoice (client voice note 23-Oct-2026: "the EWB made from the commercial invoice shows
 * on it with its QR code"). QR = "EWB no/generator GSTIN/generated date-time", as on the portal's EWB print.
 */
async function invoiceEwb(cid: number, id: number) {
  const e = await queryOne<any>(`SELECT id, doc_no, status, ewb_no, ewb_date, valid_upto, from_gstin, vehicle_no, distance_km FROM trx_eway_bill
     WHERE company_id = ? AND source_type = 'COMMERCIAL_INVOICE' AND source_id = ? AND status <> 'CANCELLED' ORDER BY id DESC LIMIT 1`, [cid, id]);
  if (!e) return null;
  const generated = e.status === 'GENERATED' && !!e.ewb_no;
  const qr = generated ? await QRCode.toDataURL(`${e.ewb_no}/${e.from_gstin ?? ''}/${istStamp(e.ewb_date) ?? ''}`, { errorCorrectionLevel: 'M', margin: 0, width: 160 }) : null;
  return { id: Number(e.id), doc_no: e.doc_no, status: e.status, ewb_no: e.ewb_no, ewb_date: istStamp(e.ewb_date), valid_upto: istStamp(e.valid_upto),
    from_gstin: e.from_gstin, vehicle_no: e.vehicle_no, distance_km: e.distance_km == null ? null : n(e.distance_km), generated, qr };
}

async function loadInvoice(cid: number, id: number) {
  const h = await queryOne<any>(`SELECT t.*, so.so_no, so.io_no, b.party_name AS buyer_name, cu.code AS currency_code, fu.full_name AS finalized_by_name
      FROM trx_commercial_invoice t LEFT JOIN trx_sales_order so ON so.id = t.so_id LEFT JOIN mst_party b ON b.id = t.buyer_id
      LEFT JOIN cfg_currency cu ON cu.id = t.currency_id LEFT JOIN mst_user fu ON fu.id = t.finalized_by
     WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
  if (!h) throw NotFound('Invoice not found');
  const [lines, pls] = await Promise.all([
    query<any>(`SELECT l.*, st.style_code, c.color_name FROM trx_commercial_invoice_line l LEFT JOIN mst_style st ON st.id = l.style_id LEFT JOIN mst_color c ON c.id = l.color_id
      WHERE l.invoice_id = ? ORDER BY l.sort_order, l.id`, [id]),
    query<any>(`SELECT id, pl_no, status, total_cartons, total_qty, net_weight_kg, gross_weight_kg, buyer_order_no FROM trx_packing_list WHERE company_id = ? AND invoice_id = ? ORDER BY id`, [cid, id]),
  ]);
  const legacy = !h.exporter_details && !h.consignee_details;   // made before the FK-087 format (old form)
  const doc: InvoiceDoc = {
    ...h, invoice_date: iso(h.invoice_date), invoice_format: h.invoice_format === 'IGST' ? 'IGST' : 'BUYER', currency_code: h.currency_code ?? '',
    exchange_rate: n(h.exchange_rate), total_cartons: h.total_cartons, total_pcs: h.total_pcs, net_weight_kg: h.net_weight_kg == null ? null : n(h.net_weight_kg),
    gross_weight_kg: h.gross_weight_kg == null ? null : n(h.gross_weight_kg), goods_gst_rate: h.goods_gst_rate == null ? null : n(h.goods_gst_rate),
    charges_gst_rate: h.charges_gst_rate == null ? null : n(h.charges_gst_rate), qty_unit: h.qty_unit || 'PCS',
    lines: lines.map((l) => ({ ...l, line_kind: l.line_kind === 'CHARGE' ? 'CHARGE' : 'GOODS', qty: n(l.qty), unit_price: n(l.unit_price), amount: n(l.amount),
      gst_rate: l.gst_rate == null ? null : n(l.gst_rate) })),
  };
  const T = invoiceTotals(doc);
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const checks = invoiceChecks({ ...doc, invoice_no: h.invoice_no, gst_supply_type: h.gst_supply_type, lut_arn: h.lut_arn,
    packing_lists: pls.map((p) => ({ ...p, total_cartons: p.total_cartons == null ? null : n(p.total_cartons), total_qty: p.total_qty == null ? null : n(p.total_qty),
      net_weight_kg: p.net_weight_kg == null ? null : n(p.net_weight_kg), gross_weight_kg: p.gross_weight_kg == null ? null : n(p.gross_weight_kg) })) }, today);
  return {
    ...doc, so_no: h.so_no, io_no: h.io_no, buyer_name: h.buyer_name, so_id: h.so_id, buyer_id: h.buyer_id, currency_id: h.currency_id, doc_status: h.doc_status,
    row_version: h.row_version, finalized_at: h.finalized_at, finalized_by_name: h.finalized_by_name, legacy,
    packing_lists: pls, pl_ids: pls.map((p) => Number(p.id)), totals: T, checks,
    hsn_summary: hsnSummary(doc.lines, doc.exchange_rate, doc.goods_gst_rate, doc.charges_gst_rate),
    gst_endorsement: gstEndorsement(h.gst_supply_type, h.lut_arn),
    eway_bill: await invoiceEwb(cid, id),
    shipping_bill: await queryOne<any>(`SELECT id, sb_no, sb_date, port_code, sb_pdf_url, sb_pdf_name FROM trx_shipping_bill WHERE company_id = ? AND invoice_id = ? LIMIT 1`, [cid, id])
      .then((x) => (x ? { ...x, sb_date: iso(x.sb_date) } : null)),
    words: { qty: doc.qty_words || qtyWords(T.goods_qty, doc.qty_unit), amount: doc.amount_words || amountWords(T.total_amount, doc.currency_code) },
  };
}

commercialInvoiceRouter.get('/commercial-invoices/:id', requirePermission('EXPORT.VIEW'), ah(async (req, res) => {
  const inv = await loadInvoice(req.user!.companyId, Number(req.params.id));
  res.json({ data: { ...inv, layout: buildInvoiceLayout({ ...inv, invoice_format: (req.query.format === 'IGST' || req.query.format === 'BUYER') ? req.query.format : inv.invoice_format }) } });
}));

/** GET /commercial-invoices/:id/export.xlsx?format= — the invoice in the FK-087 sheet layout. */
commercialInvoiceRouter.get('/commercial-invoices/:id/export.xlsx', requirePermission('EXPORT.VIEW'), ah(async (req, res) => {
  const inv = await loadInvoice(req.user!.companyId, Number(req.params.id));
  const format = req.query.format === 'IGST' || req.query.format === 'BUYER' ? req.query.format : inv.invoice_format;
  const buf = buildInvoiceWorkbook({ ...inv, invoice_format: format });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${String(inv.invoice_no).replace(/[^A-Za-z0-9_.-]+/g, '_')}_${format}.xlsx"`);
  res.send(buf);
}));
