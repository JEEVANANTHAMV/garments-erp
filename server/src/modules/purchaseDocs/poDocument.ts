/**
 * Purchase order document model (client voice notes 04-Nov-2026: "print + PDF + mail for every PO").
 * Loads one PO of any of the four PO types (yarn / fabric → trx_purchase_order, trim → trx_trim_po,
 * general → trx_general_purchase doc_kind PO) into ONE shape that the PDF renderer and the mailer use.
 * Totals are recomputed from the lines with the common invoice engine so the printed figures always add up.
 */
import fs from 'fs';
import path from 'path';
import { query, queryOne } from '../../config/db.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { computeInvoice } from '../../core/invoiceCalc.js';
import { RAW_COLOUR } from '../../core/rawColour.js';

export const PO_TYPES = ['yarn', 'fabric', 'trim', 'general'] as const;
export type PoType = (typeof PO_TYPES)[number];

export const PO_DOC_TYPE: Record<PoType, string> = { yarn: 'YARN_PO', fabric: 'FABRIC_PO', trim: 'TRIM_PO', general: 'GENERAL_PO' };

/** Permission prefix of each PO's own screens / GET route (the PDF and mail use the same rights). */
export const PO_PERMISSION: Record<PoType, string> = { yarn: 'PURCHASE', fabric: 'PURCHASE', trim: 'PROCUREMENT', general: 'PURCHASE' };

export interface PoLine {
  description: string;
  details: string[];
  job: string | null;
  hsn: string | null;
  qty: number;
  uom: string;
  rate: number;
  taxable: number;
  gstRate: number;
  tax: number;
}

export interface PoDocument {
  type: PoType;
  docType: string;
  title: string;
  id: number;
  companyId: number;
  no: string;
  date: string | null;
  deliveryDate: string | null;
  paymentTerms: string | null;
  status: string;            // normalised: DRAFT / PENDING / APPROVED / PARTIAL / CLOSED / CANCELLED / REJECTED …
  isDraft: boolean;
  isCancelled: boolean;
  currency: { code: string; symbol: string | null };
  exchangeRate: number;
  isInterstate: boolean;
  meta: [string, string][];  // extra header fields (IO / job, style, quotation …)
  company: {
    name: string; tradeName: string | null; address: string[]; gstin: string | null; pan: string | null;
    phone: string | null; email: string | null; website: string | null; stateCode: string | null; logoFile: string | null;
  };
  supplier: { id: number; name: string; address: string[]; gstin: string | null; phone: string | null; email: string | null; stateCode: string | null };
  billingAddress: string | null;
  shippingAddress: string | null;
  lines: PoLine[];
  totals: {
    taxable: number; cgst: number; sgst: number; igst: number; gst: number;
    gstGroups: { rate: number; taxable: number; tax: number }[];
    charges: [string, number][];   // freight / insurance / other … (signed)
    tcs: number; roundOff: number; grandTotal: number;
  };
  remarks: string | null;
  preparedBy: string | null;
}

const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const str = (v: unknown) => { const t = String(v ?? '').trim(); return t ? t : null; };
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const dateStr = (v: unknown) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
const fmtQtyStr = (v: unknown) => { const x = num(v); return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(3))); };

/** The company logo as a local PNG / JPEG inside uploads/ (never a path outside it, never a remote URL). */
function logoFile(logoPath: string | null): string | null {
  if (!logoPath || /^https?:/i.test(logoPath) || !/\.(png|jpe?g)$/i.test(logoPath)) return null;
  const uploads = path.resolve(process.cwd(), 'uploads');
  const rel = logoPath.replace(/^\/+/, '').replace(/^uploads\//, '');
  const file = path.resolve(uploads, rel);
  if (!file.startsWith(uploads + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

async function loadCompany(companyId: number, branchId: number | null) {
  const c = await queryOne<any>(`SELECT * FROM mst_company WHERE id = ?`, [companyId]);
  if (!c) throw NotFound('Company not found');
  const b = branchId ? await queryOne<any>(`SELECT * FROM mst_branch WHERE id = ? AND company_id = ?`, [branchId, companyId]) : null;
  const useBranch = !!(b && b.address_line1 && !b.is_head_office);
  const address = useBranch
    ? [b.address_line1, [b.city, b.state, b.pincode].filter(Boolean).join(', ')]
    : [c.address_line1, c.address_line2, [c.city, c.state, c.pincode].filter(Boolean).join(' - ')];
  return {
    name: String(c.legal_name || c.trade_name || ''),
    tradeName: str(c.trade_name) && c.trade_name !== c.legal_name ? String(c.trade_name) : null,
    address: address.map((a) => String(a ?? '').trim()).filter(Boolean),
    gstin: str(useBranch && b.gstin ? b.gstin : c.gstin),
    pan: str(c.pan),
    phone: str(useBranch && b.phone ? b.phone : c.phone),
    email: str(c.email),
    website: str(c.website),
    stateCode: str(c.state_gst_code) ?? (str(c.gstin)?.slice(0, 2) ?? null),
    logoFile: logoFile(str(c.logo_path)),
  };
}

async function loadSupplier(supplierId: number, companyId: number) {
  const p = await queryOne<any>(`SELECT id, party_name, legal_name, gstin, phone, email FROM mst_party WHERE id = ? AND company_id = ?`, [supplierId, companyId]);
  if (!p) return { id: supplierId, name: '—', address: [], gstin: null, phone: null, email: null, stateCode: null };
  const a = await queryOne<any>(
    `SELECT * FROM mst_party_address WHERE party_id = ? AND is_active = 1
      ORDER BY is_default DESC, FIELD(address_type, 'BILLING', 'REGISTERED', 'FACTORY', 'WAREHOUSE', 'SHIPPING'), id LIMIT 1`, [supplierId]);
  const cty = a?.country_id ? await queryOne<any>(`SELECT name AS country_name FROM cfg_country WHERE id = ?`, [a.country_id]) : null;
  const address = a
    ? [a.address_line1, a.address_line2, a.address_line3,
      [a.city, a.district && a.district !== a.city ? a.district : null, a.state, a.pincode].filter(Boolean).join(', '),
      cty?.country_name && !/india/i.test(cty.country_name) ? cty.country_name : null]
    : [];
  return {
    id: Number(p.id),
    name: String(p.legal_name || p.party_name),
    address: address.map((x) => String(x ?? '').trim()).filter(Boolean),
    gstin: str(p.gstin),
    phone: str(a?.mobile) ?? str(a?.phone) ?? str(p.phone),
    email: str(p.email),
    stateCode: str(p.gstin)?.slice(0, 2) ?? null,
  };
}

async function userName(id: unknown) {
  if (!id) return null;
  const u = await queryOne<any>(`SELECT full_name, username FROM mst_user WHERE id = ?`, [id]);
  return u ? String(u.full_name || u.username) : null;
}

async function soJobs(ids: unknown[]): Promise<Map<number, string>> {
  const clean = [...new Set(ids.map(Number).filter((x) => x > 0))];
  if (!clean.length) return new Map();
  const rows = await query<any>(`SELECT id, io_no, so_no FROM trx_sales_order WHERE id IN (?)`, [clean]);
  return new Map(rows.map((r) => [Number(r.id), String(r.io_no || r.so_no)]));
}

/** Supplier e-mail suggestions: purchase contacts first, then the party e-mail, primary contact, address e-mails. */
export async function supplierEmails(supplierId: number, companyId: number): Promise<string[]> {
  const p = await queryOne<any>(`SELECT email FROM mst_party WHERE id = ? AND company_id = ?`, [supplierId, companyId]);
  if (!p) return [];
  const contacts = await query<any>(
    `SELECT email, is_purchase_contact, is_primary FROM mst_party_contact WHERE party_id = ? AND is_active = 1 AND email IS NOT NULL AND email <> ''
      ORDER BY is_purchase_contact DESC, is_primary DESC, id`, [supplierId]);
  const addr = await query<any>(`SELECT email FROM mst_party_address WHERE party_id = ? AND is_active = 1 AND email IS NOT NULL AND email <> '' ORDER BY is_default DESC, id`, [supplierId]);
  const split = (v: unknown) => String(v ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const purchase = contacts.filter((c) => Number(c.is_purchase_contact)).flatMap((c) => split(c.email));
  const ordered = purchase.length
    ? [...purchase, ...split(p.email)]
    : [...split(p.email), ...contacts.flatMap((c) => split(c.email)), ...addr.flatMap((a) => split(a.email))];
  const seen = new Set<string>();
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return ordered.filter((e) => ok.test(e) && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase())).slice(0, 5);
}

function totalsFrom(lines: PoLine[], interstate: boolean, ch: { freight?: number; insurance?: number; customs?: number; clearing?: number; other?: number; otherSign?: number; otherLabel?: string | null; tcsPct?: number; roundOff?: number }) {
  const t = computeInvoice(lines.map((l) => ({ taxable: l.taxable, gst_rate: l.gstRate, tax: l.tax })), interstate ? 'INTER_STATE' : 'INTRA_STATE', {
    freight_charges: ch.freight, insurance: ch.insurance, customs_duty: ch.customs, clearing_charges: ch.clearing,
    other_charges: ch.other, other_charges_sign: ch.otherSign, tcs_pct: ch.tcsPct, round_off: ch.roundOff, tds_pct: 0,
  });
  const charges: [string, number][] = [];
  if (num(ch.freight)) charges.push(['Freight', r2(num(ch.freight))]);
  if (num(ch.insurance)) charges.push(['Insurance', r2(num(ch.insurance))]);
  if (num(ch.customs)) charges.push(['Customs duty', r2(num(ch.customs))]);
  if (num(ch.clearing)) charges.push(['Clearing charges', r2(num(ch.clearing))]);
  if (num(ch.other)) charges.push([ch.otherLabel || 'Other charges', t.otherSigned]);
  return { taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, gst: t.gst, gstGroups: t.gstGroups, charges, tcs: t.tcs, roundOff: t.roundOff, grandTotal: t.net };
}

/** A line's tax: the stored tax when present, else taxable × GST %. */
const lineTax = (taxable: number, rate: number, stored: unknown) => (num(stored) > 0 ? r2(num(stored)) : r2((taxable * rate) / 100));

// ------------------------------------------------------------------ yarn / fabric (trx_purchase_order)
async function loadMaterialPo(type: 'yarn' | 'fabric', id: number, cid: number): Promise<PoDocument> {
  const po = await queryOne<any>(
    `SELECT t.*, cur.code AS currency_code, cur.symbol AS currency_symbol, cs.code AS status_code,
            so.so_no, so.io_no, st.style_code, st.style_name, q.quotation_no
       FROM trx_purchase_order t
       LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
       LEFT JOIN cfg_status cs ON cs.id = t.status_id
       LEFT JOIN trx_sales_order so ON so.id = t.so_id
       LEFT JOIN mst_style st ON st.id = t.style_id
       LEFT JOIN trx_quotation q ON q.id = t.quotation_id
      WHERE t.id = ? AND t.company_id = ? AND t.is_deleted = 0`, [id, cid]);
  if (!po) throw NotFound('Purchase order not found');

  const rows = await query<any>(
    `SELECT l.*, u.code AS uom_code, y.yarn_name, y.hsn_code AS yarn_hsn, f.fabric_name, f.hsn_code AS fabric_hsn,
            tr.trim_name, tr.hsn_code AS trim_hsn, c.color_name AS master_color, dm.party_name AS dyeing_mill
       FROM trx_purchase_order_line l
       LEFT JOIN cfg_uom u ON u.id = l.uom_id
       LEFT JOIN mst_yarn y ON y.id = l.yarn_id
       LEFT JOIN mst_fabric f ON f.id = l.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = l.trim_id
       LEFT JOIN mst_color c ON c.id = l.color_id
       LEFT JOIN mst_party dm ON dm.id = l.dyeing_mill_id
      WHERE l.po_id = ? ORDER BY l.id`, [id]);
  const jobs = await soJobs(rows.map((r) => r.so_id));
  const headerJob = str(po.io_no) ?? str(po.so_no) ?? str(po.internal_ir_no);
  const interstate = !!Number(po.is_interstate);

  const lines: PoLine[] = rows.map((l) => {
    const details: string[] = [];
    let description: string;
    if (l.material_type === 'YARN') {
      description = str(l.yarn_name) ?? str(l.description) ?? `${l.yarn_type ?? 'Yarn'} ${l.yarn_count_str ?? ''}`.trim();
      if (str(l.description) && l.description !== description) details.push(String(l.description));
      if (str(l.yarn_count_str)) details.push(`Count: ${l.yarn_count_str}`);
      if (str(l.composition)) details.push(`Composition: ${l.composition}`);
      if (str(l.yarn_category)) details.push(`Type: ${l.yarn_category}`);
      const dyed = /dyed/i.test(String(l.yarn_type ?? '')) || (!l.yarn_type && (l.color_name || l.color_id));
      const colour = str(l.color_name) ?? str(l.master_color) ?? str(l.shade_code);
      details.push(dyed && colour ? `Colour: ${colour}${l.shade_code && l.shade_code !== colour ? ` (shade ${l.shade_code})` : ''}` : `Colour: ${RAW_COLOUR}`);
      if (dyed && str(l.dyeing_mill)) details.push(`Dyeing mill: ${l.dyeing_mill}`);
      if (l.purchase_basis === 'PACK_BAG' && num(l.packs)) details.push(`${l.packs} bags x ${fmtQtyStr(l.pack_weight_kg)} kg`);
    } else if (l.material_type === 'FABRIC') {
      description = str(l.fabric_name) ?? str(l.description) ?? 'Fabric';
      if (str(l.description) && l.description !== description) details.push(String(l.description));
      const spec = [str(l.fabric_type), str(l.composition), l.gsm ? `GSM ${l.gsm}` : null, l.dia ? `Dia ${l.dia}` : null].filter(Boolean);
      if (spec.length) details.push(spec.join(' | '));
      const colour = str(l.color_name) ?? str(l.master_color);
      if (colour) details.push(`Colour: ${colour}${l.shade_code && l.shade_code !== colour ? ` (shade ${l.shade_code})` : ''}`);
      else if (str(l.shade_code)) details.push(`Shade: ${l.shade_code}`);
      if (str(l.pantone_spec)) details.push(`Pantone: ${l.pantone_spec}`);
      if (str(l.finish)) details.push(`Finish: ${l.finish}`);
      if (Number(l.print_flag)) details.push(`Print${l.print_color ? `: ${l.print_color}` : ''}`);
      const pack = [num(l.no_of_rolls) ? `${l.no_of_rolls} rolls` : null, num(l.weight_kg) ? `${fmtQtyStr(l.weight_kg)} kg` : null].filter(Boolean);
      if (pack.length) details.push(pack.join(' / '));
    } else {
      description = str(l.trim_name) ?? str(l.description) ?? String(l.material_type);
      if (str(l.description) && l.description !== description) details.push(String(l.description));
      if (str(l.color_name)) details.push(`Colour: ${l.color_name}`);
    }
    const taxable = r2(num(l.amount) || num(l.qty) * num(l.rate));
    const gstRate = interstate ? (num(l.igst_rate) || num(l.gst_rate)) : num(l.gst_rate) || (num(l.cgst_rate) + num(l.sgst_rate));
    const storedTax = num(l.tax_amount) || num(l.igst_amount) + num(l.cgst_amount) + num(l.sgst_amount);
    return {
      description, details,
      job: jobs.get(Number(l.so_id)) ?? headerJob,
      hsn: str(l.hsn_code) ?? str(l.yarn_hsn) ?? str(l.fabric_hsn) ?? str(l.trim_hsn),
      qty: num(l.qty), uom: String(l.uom_code ?? ''), rate: num(l.rate),
      taxable, gstRate, tax: lineTax(taxable, gstRate, storedTax),
    };
  });

  const kinds = new Set(rows.map((r) => r.material_type));
  const title = kinds.size === 1 && kinds.has('YARN') ? 'YARN PURCHASE ORDER'
    : kinds.size === 1 && kinds.has('FABRIC') ? 'FABRIC PURCHASE ORDER'
      : type === 'yarn' ? 'YARN PURCHASE ORDER' : 'FABRIC PURCHASE ORDER';
  const status = String(po.status_code === 'CANCELLED' ? 'CANCELLED' : (po.approval_state || po.status_code || 'DRAFT')).toUpperCase();
  const meta: [string, string][] = [];
  if (headerJob) meta.push(['IO / Job No', headerJob]);
  if (str(po.style_code)) meta.push(['Style', `${po.style_code}${po.style_name ? ` - ${po.style_name}` : ''}`]);
  if (str(po.quotation_no)) meta.push(['Quotation', String(po.quotation_no)]);
  if (str(po.order_type)) meta.push(['Order type', String(po.order_type)]);

  return {
    type, docType: PO_DOC_TYPE[type], title, id, companyId: cid,
    no: String(po.po_no || `PO-${id}`), date: dateStr(po.po_date), deliveryDate: dateStr(po.delivery_date),
    paymentTerms: str(po.payment_terms), status,
    isDraft: ['DRAFT', 'PENDING'].includes(status), isCancelled: ['CANCELLED', 'REJECTED'].includes(status),
    currency: { code: String(po.currency_code || 'INR'), symbol: str(po.currency_symbol) },
    exchangeRate: num(po.exchange_rate) || 1, isInterstate: interstate, meta,
    company: await loadCompany(cid, po.branch_id ? Number(po.branch_id) : null),
    supplier: await loadSupplier(Number(po.supplier_id), cid),
    billingAddress: str(po.billing_address), shippingAddress: str(po.shipping_address),
    lines,
    totals: totalsFrom(lines, interstate, {
      freight: num(po.freight_charges), other: num(po.other_charges), otherSign: num(po.other_charges) < 0 ? -1 : 1,
      tcsPct: Number(po.tcs_applicable) ? num(po.tcs_rate) : 0, roundOff: num(po.round_off),
    }),
    remarks: str(po.remarks), preparedBy: await userName(po.created_by),
  };
}

// ------------------------------------------------------------------ trim (trx_trim_po)
async function loadTrimPo(id: number, cid: number): Promise<PoDocument> {
  const po = await queryOne<any>(
    `SELECT t.*, cur.code AS currency_code, cur.symbol AS currency_symbol, st.style_code, st.style_name
       FROM trx_trim_po t
       LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
       LEFT JOIN mst_style st ON st.id = t.style_id
      WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
  if (!po) throw NotFound('Trim purchase order not found');
  const rows = await query<any>(
    `SELECT l.*, tr.trim_name, tr.trim_code, tr.trim_type, tr.hsn_code AS trim_hsn, u.code AS uom_code
       FROM trx_trim_po_line l
       LEFT JOIN mst_trim tr ON tr.id = l.trim_id
       LEFT JOIN cfg_uom u ON u.id = l.uom_id
      WHERE l.po_id = ? ORDER BY l.id`, [id]);
  const jobs = await soJobs(rows.map((r) => r.so_id));
  const interstate = !!Number(po.is_interstate);
  const lines: PoLine[] = rows.map((l) => {
    const details: string[] = [];
    if (str(l.trim_code) && l.trim_code !== l.trim_name) details.push(`Code: ${l.trim_code}`);
    if (str(l.specification)) details.push(String(l.specification));
    const cs = [l.color_name ? `Colour: ${l.color_name}` : null, l.trim_size ? `Size: ${l.trim_size}` : null].filter(Boolean);
    if (cs.length) details.push(cs.join(' | '));
    const taxable = r2(num(l.amount) || num(l.order_qty) * num(l.rate));
    const gstRate = interstate ? (num(l.igst_rate) || num(l.gst_rate)) : num(l.gst_rate);
    return {
      description: String(l.trim_name || 'Trim'), details,
      job: jobs.get(Number(l.so_id)) ?? str(po.io_no),
      hsn: str(l.trim_hsn), qty: num(l.order_qty), uom: String(l.uom_code ?? ''), rate: num(l.rate),
      taxable, gstRate, tax: lineTax(taxable, gstRate, num(l.tax_amount) || num(l.igst_amount)),
    };
  });
  const status = String(po.status || 'APPROVED').toUpperCase();
  const meta: [string, string][] = [];
  if (str(po.io_no)) meta.push(['IO / Job No', String(po.io_no)]);
  if (str(po.style_code)) meta.push(['Style', `${po.style_code}${po.style_name ? ` - ${po.style_name}` : ''}`]);
  return {
    type: 'trim', docType: PO_DOC_TYPE.trim, title: 'TRIMS & ACCESSORIES PURCHASE ORDER', id, companyId: cid,
    no: String(po.po_no || `TPO-${id}`), date: dateStr(po.po_date), deliveryDate: dateStr(po.delivery_date),
    paymentTerms: str(po.payment_terms), status,
    isDraft: status === 'DRAFT', isCancelled: status === 'CANCELLED',
    currency: { code: String(po.currency_code || 'INR'), symbol: str(po.currency_symbol) },
    exchangeRate: num(po.exchange_rate) || 1, isInterstate: interstate, meta,
    company: await loadCompany(cid, null), supplier: await loadSupplier(Number(po.supplier_id), cid),
    billingAddress: null, shippingAddress: null, lines,
    totals: totalsFrom(lines, interstate, {}),
    remarks: str(po.remarks), preparedBy: await userName(po.created_by),
  };
}

// ------------------------------------------------------------------ general (trx_general_purchase, doc_kind PO)
const ALLOCATION_LABEL: Record<string, string> = {
  GENERAL_STOCK: 'General stock', BUYER_ORDER: 'Buyer order', PRODUCTION_ORDER: 'Production order', SAMPLE: 'Sample',
  JOB_WORK: 'Job work', MAINTENANCE: 'Maintenance', DEPARTMENT: 'Department', DIRECT_EXPENSE: 'Direct expense',
};

async function loadGeneralPo(id: number, cid: number): Promise<PoDocument> {
  const po = await queryOne<any>(
    `SELECT t.*, cur.code AS currency_code, cur.symbol AS currency_symbol, cs.code AS status_code
       FROM trx_general_purchase t
       LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
       LEFT JOIN cfg_status cs ON cs.id = t.status_id
      WHERE t.id = ? AND t.company_id = ? AND t.is_deleted = 0`, [id, cid]);
  if (!po) throw NotFound('General purchase order not found');
  if (po.doc_kind && po.doc_kind !== 'PO') throw BadRequest('This is a goods receipt (GRN), not a purchase order — use the GRN voucher print');
  const rows = await query<any>(
    `SELECT l.*, u.code AS uom_code, d.dept_name AS department_name,
            CASE l.material_type WHEN 'TRIM' THEN (SELECT hsn_code FROM mst_trim WHERE id = l.material_id)
                                 WHEN 'YARN' THEN (SELECT hsn_code FROM mst_yarn WHERE id = l.material_id)
                                 WHEN 'FABRIC' THEN (SELECT hsn_code FROM mst_fabric WHERE id = l.material_id) END AS master_hsn
       FROM trx_general_purchase_line l
       LEFT JOIN cfg_uom u ON u.id = l.uom_id
       LEFT JOIN mst_department d ON d.id = l.department_id
      WHERE l.purchase_id = ? ORDER BY l.id`, [id]);
  const jobs = await soJobs(rows.map((r) => r.so_id));
  const interstate = !!Number(po.is_interstate);
  const lines: PoLine[] = rows.map((l) => {
    const details: string[] = [];
    if (str(l.remarks)) details.push(String(l.remarks));
    const alloc = [str(l.department_name), str(l.cost_centre), str(l.expense_head), str(l.machine_id) ? `Machine ${l.machine_id}` : null].filter(Boolean);
    if (alloc.length) details.push(alloc.join(' | '));
    const raw = num(l.qty) * num(l.rate);
    const taxable = r2(raw - (raw * num(l.discount_pct)) / 100);
    if (num(l.discount_pct)) details.push(`Discount ${num(l.discount_pct)}%`);
    const gstRate = interstate ? (num(l.igst_rate) || num(l.gst_rate)) : num(l.gst_rate);
    return {
      description: String(l.item_description || 'Item'), details,
      job: jobs.get(Number(l.so_id)) ?? ALLOCATION_LABEL[String(l.allocation_type)] ?? null,
      hsn: str(l.master_hsn), qty: num(l.qty), uom: String(l.uom_code ?? ''), rate: num(l.rate),
      taxable, gstRate, tax: lineTax(taxable, gstRate, l.tax_amount),
    };
  });
  const status = String(po.status_code === 'CANCELLED' ? 'CANCELLED' : (po.approval_state || 'DRAFT')).toUpperCase();
  const meta: [string, string][] = [];
  if (str(po.purchase_type)) meta.push(['Purchase type', String(po.purchase_type).replace(/_/g, ' ')]);
  return {
    type: 'general', docType: PO_DOC_TYPE.general, title: 'GENERAL PURCHASE ORDER', id, companyId: cid,
    no: String(po.purchase_no || `GP-${id}`), date: dateStr(po.purchase_date), deliveryDate: null,
    paymentTerms: str(po.payment_terms), status,
    isDraft: ['DRAFT', 'PENDING'].includes(status), isCancelled: ['CANCELLED', 'REJECTED'].includes(status),
    currency: { code: String(po.currency_code || 'INR'), symbol: str(po.currency_symbol) },
    exchangeRate: num(po.exchange_rate) || 1, isInterstate: interstate, meta,
    company: await loadCompany(cid, po.branch_id ? Number(po.branch_id) : null),
    supplier: await loadSupplier(Number(po.supplier_id), cid),
    billingAddress: null, shippingAddress: null, lines,
    totals: totalsFrom(lines, interstate, {
      freight: num(po.freight_charges), insurance: num(po.insurance), customs: num(po.customs_duty), clearing: num(po.clearing_charges),
      other: Math.abs(num(po.other_charges)), otherSign: num(po.other_charges_sign) < 0 ? -1 : 1, otherLabel: str(po.other_charges_label),
      tcsPct: num(po.tcs_pct), roundOff: num(po.round_off),
    }),
    remarks: str(po.remarks), preparedBy: await userName(po.created_by),
  };
}

export async function loadPoDocument(type: PoType, id: number, companyId: number): Promise<PoDocument> {
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid id');
  if (type === 'yarn' || type === 'fabric') return loadMaterialPo(type, id, companyId);
  if (type === 'trim') return loadTrimPo(id, companyId);
  return loadGeneralPo(id, companyId);
}

/** Why this PO may not be e-mailed to the supplier (null = it may). */
export function mailBlockReason(doc: PoDocument): string | null {
  if (doc.isDraft) return 'Approve the PO before sending it to the supplier';
  if (doc.isCancelled) return `This PO is ${doc.status.toLowerCase()} — it cannot be sent to the supplier`;
  return null;
}

/** File name for the PDF: the PO number with anything unsafe for a file name removed. */
export const pdfFileName = (doc: PoDocument) => `${doc.no.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || `PO-${doc.id}`}.pdf`;
