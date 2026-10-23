/**
 * Export invoice rules as garment exporters follow them (customs / ICEGATE shipping bill, CGST rules 46 and 96):
 *  - the goods are described the customs way: COMPOSITION + KNITTED/WOVEN + GENDER + GARMENT (PACK), with the
 *    8-digit ITC-HS code and the GST unit (UQC) per line;
 *  - the invoice carries the GST export endorsement (under LUT with its ARN, or on payment of IGST);
 *  - before an invoice is finalised the mandatory particulars are checked (invoice no ≤ 16 characters, exporter
 *    GSTIN and IEC, HSN on every line, HSN chapter 61 = knitted / 62 = woven matching the description, …).
 */

export const UQC = ['PCS', 'SET', 'PAC', 'DOZ', 'NOS', 'PRS', 'BOX', 'KGS', 'MTR'] as const;
export const CONSTRUCTIONS = ['KNITTED', 'WOVEN', 'CROCHETED'] as const;
export const GENDERS = ['MENS', 'LADIES', 'BOYS', 'GIRLS', 'INFANTS', 'UNISEX', 'KIDS'] as const;

const GENDER_MAP: Record<string, string> = { MEN: 'MENS', WOMEN: 'LADIES', BOYS: 'BOYS', GIRLS: 'GIRLS', INFANT: 'INFANTS', UNISEX: 'UNISEX' };
export const genderLabel = (g: unknown) => GENDER_MAP[String(g ?? '').toUpperCase()] ?? null;
/** Fabric type of the master (KNIT, KNIT-xxx, WOVEN …) → the customs word. */
export const constructionOf = (fabricType: unknown, hsn?: unknown) => {
  const f = String(fabricType ?? '').toUpperCase();
  if (f.startsWith('KNIT')) return 'KNITTED';
  if (f.startsWith('WOVEN')) return 'WOVEN';
  if (f.startsWith('CROCHET')) return 'CROCHETED';
  const h = String(hsn ?? '');
  return h.startsWith('61') ? 'KNITTED' : h.startsWith('62') ? 'WOVEN' : null;
};
/** UOM code → GST UQC (PCS stays PCS, SETS → SET, PACKS → PAC, DZN → DOZ). */
export const uqcOf = (unit: unknown) => {
  const u = String(unit ?? '').toUpperCase().trim();
  if (!u) return 'PCS';
  if ((UQC as readonly string[]).includes(u)) return u;
  if (/^SETS?$/.test(u)) return 'SET';
  if (/^PACKS?$|^PKT/.test(u)) return 'PAC';
  if (/^DZN|^DOZ/.test(u)) return 'DOZ';
  if (/^PAIRS?$/.test(u)) return 'PRS';
  return 'PCS';
};

export interface DescParts { composition?: string | null; construction?: string | null; gender_label?: string | null; garment?: string | null; pack_info?: string | null }
/** "95% COTTON 5% ELASTANE KNITTED GIRLS PYJAMA SETS (HANGER PACK)" */
export function composeDescription(p: DescParts) {
  const pack = String(p.pack_info ?? '').trim();
  const head = [p.composition, p.construction, p.gender_label, p.garment].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
  const tail = pack ? (pack.startsWith('(') ? pack : `(${pack})`) : '';
  return `${head}${head && tail ? ' ' : ''}${tail}`.toUpperCase().replace(/\s+/g, ' ').trim();
}

/** GST endorsement printed on an export invoice (CGST rule 46). */
export function gstEndorsement(type: string | null | undefined, arn: string | null | undefined) {
  if (type === 'LUT') return `SUPPLY MEANT FOR EXPORT UNDER LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX${arn ? ` (LUT ARN: ${arn})` : ''}`;
  if (type === 'IGST') return 'SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX (IGST)';
  return null;
}

export const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;
export const IEC_RE = /\b[0-9A-Z]{10}\b/;
/** GST invoice no: at most 16 characters — letters, digits, hyphen and slash. */
export const INVOICE_NO_RE = /^[A-Za-z0-9/-]{1,16}$/;

export interface CheckLine { line_kind: string; description?: string | null; hsn_code?: string | null; qty: number; unit_price: number; construction?: string | null; uqc?: string | null; gst_rate?: number | null }
export interface CheckInput {
  invoice_no: string; invoice_date: string | null; invoice_format: string; exchange_rate: number; currency_code: string;
  exporter_details: string | null; exporter_ref: string | null; consignee_details: string | null;
  gst_supply_type: string | null; lut_arn: string | null; goods_gst_rate: number | null; charges_gst_rate: number | null;
  port_of_loading: string | null; port_of_discharge: string | null; country_dest_text: string | null;
  total_cartons: number | null; total_pcs: number | null; net_weight_kg: number | null; gross_weight_kg: number | null;
  lines: CheckLine[];
  packing_lists: { pl_no: string; total_cartons: number | null; total_qty: number | null; net_weight_kg: number | null; gross_weight_kg: number | null }[];
}

/** Errors stop finalising; warnings are shown. */
export function invoiceChecks(inv: CheckInput, today: string) {
  const errors: string[] = []; const warnings: string[] = [];
  if (!INVOICE_NO_RE.test(inv.invoice_no ?? '')) errors.push(`Invoice no "${inv.invoice_no}" — GST allows at most 16 characters (letters, digits, - and /)`);
  if (inv.invoice_date && inv.invoice_date > today) errors.push('Invoice date is in the future');
  if (!inv.exporter_details?.trim()) errors.push('Exporter box is empty');
  else if (!GSTIN_RE.test(inv.exporter_details.toUpperCase())) errors.push('Exporter box has no GSTIN (GST NO: 15 characters)');
  if (!inv.exporter_ref || !IEC_RE.test(inv.exporter_ref.toUpperCase().replace(/IEC\s*NO\s*:?/, ''))) errors.push("Exporter's Ref. has no IEC (10 characters)");
  if (!inv.consignee_details?.trim()) errors.push('Consignee box is empty');
  if (!inv.port_of_loading?.trim() || !inv.port_of_discharge?.trim()) errors.push('Port of loading and port of discharge are needed');
  if (!inv.country_dest_text?.trim()) errors.push('Country of final destination is empty');
  if (inv.currency_code !== 'INR' && !(inv.exchange_rate > 0)) errors.push('Exchange rate is missing');
  if (!inv.gst_supply_type) errors.push('Choose the GST export type: under LUT (no IGST) or on payment of IGST');
  if (inv.gst_supply_type === 'LUT' && !inv.lut_arn?.trim()) errors.push('Export under LUT: enter the LUT ARN');
  if (inv.gst_supply_type === 'LUT' && inv.invoice_format === 'IGST') errors.push('The IGST layout is for exports on payment of IGST — choose the buyer layout for a LUT export');
  if (inv.gst_supply_type === 'IGST' && !(Number(inv.goods_gst_rate) > 0) && !inv.lines.some((l) => l.line_kind === 'GOODS' && Number(l.gst_rate) > 0)) errors.push('Export on payment of IGST: enter the IGST % on goods');
  const goods = inv.lines.filter((l) => l.line_kind === 'GOODS');
  if (!goods.length) errors.push('No goods line');
  inv.lines.forEach((l, i) => {
    const tag = `Line ${i + 1}${l.description ? ` (${String(l.description).slice(0, 40)})` : ''}`;
    const hsn = String(l.hsn_code ?? '').trim();
    if (!String(l.description ?? '').trim()) errors.push(`${tag}: description is empty`);
    if (!/^\d{8}$/.test(hsn)) errors.push(`${tag}: 8-digit HSN (ITC-HS) code needed for the shipping bill`);
    if (!(l.qty > 0)) errors.push(`${tag}: quantity is zero`);
    if (l.line_kind === 'GOODS' && !(l.unit_price > 0)) errors.push(`${tag}: rate is zero`);
    const c = String(l.construction ?? '').toUpperCase() || (/\bKNITTED\b/i.test(String(l.description)) ? 'KNITTED' : /\bWOVEN\b/i.test(String(l.description)) ? 'WOVEN' : '');
    if (l.line_kind === 'GOODS' && hsn.startsWith('61') && c === 'WOVEN') errors.push(`${tag}: HSN ${hsn} is chapter 61 (knitted / crocheted apparel) but the goods are woven`);
    if (l.line_kind === 'GOODS' && hsn.startsWith('62') && c === 'KNITTED') errors.push(`${tag}: HSN ${hsn} is chapter 62 (woven apparel) but the goods are knitted`);
    if (l.uqc && !(UQC as readonly string[]).includes(String(l.uqc))) errors.push(`${tag}: unit ${l.uqc} is not a GST UQC (${UQC.join(', ')})`);
  });
  // against the packing lists (warnings: packs / sets may be counted differently on the invoice)
  if (!inv.packing_lists.length) warnings.push('No packing list on this invoice');
  else {
    const sum = (k: 'total_cartons' | 'total_qty' | 'net_weight_kg' | 'gross_weight_kg') => inv.packing_lists.reduce((t, p) => t + Number(p[k] ?? 0), 0);
    const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
    const gq = goods.reduce((t, l) => t + Number(l.qty), 0);
    if (!near(gq, sum('total_qty'), 0.001)) warnings.push(`Goods quantity ${gq} differs from the packing lists (${sum('total_qty')} pcs)`);
    if (inv.total_cartons != null && !near(Number(inv.total_cartons), sum('total_cartons'), 0)) warnings.push(`Total cartons ${inv.total_cartons} differs from the packing lists (${sum('total_cartons')})`);
    if (inv.net_weight_kg != null && !near(Number(inv.net_weight_kg), sum('net_weight_kg'), 0.01)) warnings.push(`Net weight ${inv.net_weight_kg} kg differs from the packing lists (${Math.round(sum('net_weight_kg') * 1000) / 1000} kg)`);
    if (inv.gross_weight_kg != null && !near(Number(inv.gross_weight_kg), sum('gross_weight_kg'), 0.01)) warnings.push(`Gross weight ${inv.gross_weight_kg} kg differs from the packing lists (${Math.round(sum('gross_weight_kg') * 1000) / 1000} kg)`);
  }
  if (inv.total_cartons == null || inv.net_weight_kg == null || inv.gross_weight_kg == null) warnings.push('Total cartons / net weight / gross weight not filled');
  if (inv.net_weight_kg != null && inv.gross_weight_kg != null && Number(inv.gross_weight_kg) < Number(inv.net_weight_kg)) errors.push('Gross weight is less than the net weight');
  return { errors, warnings, ready: errors.length === 0 };
}

/** HSN-wise summary (shipping bill / GSTR-1 export table): per HSN + UQC + IGST %. */
export function hsnSummary(lines: (CheckLine & { amount: number })[], xr: number, goodsRate: number | null, chargeRate: number | null) {
  const m = new Map<string, { hsn_code: string; description: string; uqc: string; qty: number; value_fc: number; value_inr: number; gst_rate: number; gst_inr: number }>();
  const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  for (const l of lines) {
    const rate = Number(l.gst_rate ?? (l.line_kind === 'CHARGE' ? chargeRate : goodsRate) ?? 0);
    const uqc = l.uqc || 'PCS';
    const k = `${l.hsn_code ?? ''}|${uqc}|${rate}`;
    const e = m.get(k) ?? { hsn_code: String(l.hsn_code ?? ''), description: String(l.description ?? ''), uqc, qty: 0, value_fc: 0, value_inr: 0, gst_rate: rate, gst_inr: 0 };
    const inr = r2(Number(l.amount) * xr);
    e.qty += Number(l.qty); e.value_fc = r2(e.value_fc + Number(l.amount)); e.value_inr = r2(e.value_inr + inr); e.gst_inr = r2(e.gst_inr + r2(inr * rate / 100));
    m.set(k, e);
  }
  return [...m.values()];
}
