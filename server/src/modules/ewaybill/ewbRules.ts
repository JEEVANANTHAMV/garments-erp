import { BadRequest } from '../../core/errors.js';

/**
 * GST e-way bill rules (CGST rule 138) used by every provider: states, validity, value checks, default GST rate.
 */

/** GST state codes (the first two digits of a GSTIN) → state name as the e-way bill system writes it. */
export const GST_STATES: Record<string, string> = {
  '01': 'JAMMU AND KASHMIR', '02': 'HIMACHAL PRADESH', '03': 'PUNJAB', '04': 'CHANDIGARH', '05': 'UTTARAKHAND', '06': 'HARYANA',
  '07': 'DELHI', '08': 'RAJASTHAN', '09': 'UTTAR PRADESH', '10': 'BIHAR', '11': 'SIKKIM', '12': 'ARUNACHAL PRADESH', '13': 'NAGALAND',
  '14': 'MANIPUR', '15': 'MIZORAM', '16': 'TRIPURA', '17': 'MEGHALAYA', '18': 'ASSAM', '19': 'WEST BENGAL', '20': 'JHARKHAND',
  '21': 'ODISHA', '22': 'CHHATTISGARH', '23': 'MADHYA PRADESH', '24': 'GUJARAT', '26': 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU',
  '27': 'MAHARASHTRA', '29': 'KARNATAKA', '30': 'GOA', '31': 'LAKSHADWEEP', '32': 'KERALA', '33': 'TAMIL NADU', '34': 'PUDUCHERRY',
  '35': 'ANDAMAN AND NICOBAR ISLANDS', '36': 'TELANGANA', '37': 'ANDHRA PRADESH', '38': 'LADAKH', '96': 'OTHER COUNTRY', '97': 'OTHER TERRITORY',
};
const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z]/g, '');
/** A state name (any spelling / case) or a GSTIN → the e-way bill state name; '' when unknown. */
export function stateName(stateOrGstin: unknown): string {
  const v = String(stateOrGstin ?? '').trim();
  if (/^\d{2}[A-Z0-9]{13}$/i.test(v)) return GST_STATES[v.slice(0, 2)] ?? '';
  if (/^\d{2}$/.test(v)) return GST_STATES[v] ?? '';
  const k = norm(v);
  if (!k) return '';
  const hit = Object.values(GST_STATES).find((s) => norm(s) === k);
  if (hit) return hit;
  const alias: Record<string, string> = { ORISSA: 'ODISHA', PONDICHERRY: 'PUDUCHERRY', TAMILNADU: 'TAMIL NADU', NEWDELHI: 'DELHI', JAMMUKASHMIR: 'JAMMU AND KASHMIR' };
  return alias[k] ?? '';
}
export const stateCode = (name: string) => Object.entries(GST_STATES).find(([, s]) => s === name)?.[0] ?? '';

export const SUB_SUPPLY_TYPES = ['Supply', 'Export', 'Job Work', 'Job Work Returns', 'Sales Return', 'SKD/CKD/Lots', 'Recipient Not Known',
  'For Own Use', 'Exhibition or Fairs', 'Line Sales', 'Others'] as const;
export const DOCUMENT_TYPES = ['Tax Invoice', 'Bill of Supply', 'Bill of Entry', 'Delivery Challan', 'Credit Note', 'Others'] as const;
export const CANCEL_REASONS = ['Duplicate', 'Order Cancelled', 'Data Entry mistake', 'Others'] as const;
export const VEHICLE_REASONS = ['Due to Break Down', 'Due to Transhipment', 'First Time', 'Others'] as const;
export const EXTEND_REASONS = ['Natural Calamity', 'Law and Order Situation', 'Transhipment', 'Accident', 'Others'] as const;
/** GST UQC codes accepted for e-way bill items, from our units of measure. */
export const UQC: Record<string, string> = {
  PCS: 'PCS', NOS: 'NOS', DZN: 'DOZ', SET: 'SET', PAIR: 'PRS', KG: 'KGS', KGS: 'KGS', GM: 'GMS', TON: 'TON', MTR: 'MTR', CM: 'CMS',
  YRD: 'YDS', SQM: 'SQM', ROLL: 'ROL', BOX: 'BOX', CTN: 'CTN', CONE: 'NOS', LBS: 'KGS', INCH: 'OTH', GROSS: 'GRS',
};
export const uqcOf = (code: unknown) => UQC[String(code ?? '').toUpperCase()] ?? 'OTH';

/**
 * Suggested GST rate by HSN chapter (the user can change it): apparel (61 / 62 / 63) 5 % up to ₹2,500 a piece,
 * 18 % above; yarn / fabric / fibre (50–60) 5 %; anything else 18 %.
 */
export function defaultGstRate(hsn: unknown, unitValue: number): number {
  const ch = Number(String(hsn ?? '').slice(0, 2));
  if (ch >= 61 && ch <= 63) return unitValue > 2500 ? 18 : 5;
  if (ch >= 50 && ch <= 60) return 5;
  return 18;
}

/**
 * Validity (rule 138(10)): Regular cargo 1 day per 200 km (or part), over-dimensional cargo 1 day per 20 km;
 * a day runs to midnight of the day after the generation date. Returns null without a distance.
 */
export function validityUpto(from: Date, distanceKm: number, vehicleType: 'Regular' | 'ODC'): Date | null {
  if (!(distanceKm > 0)) return null;
  const days = Math.max(1, Math.ceil(distanceKm / (vehicleType === 'ODC' ? 20 : 200)));
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, 23, 59, 59);
  return d;
}

export const GSTIN_RE = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const VEHICLE_RE = /^[A-Z]{2}[0-9A-Z]{1,3}[A-Z]{0,3}[0-9]{1,4}$|^(TR|TM)[0-9A-Z]{4,13}$|^DF[0-9A-Z]{5,13}$|^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$/;
export const cleanVehicle = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface EwbItemIn { product_name: string; description?: string | null; hsn_code: string; quantity: number; unit: string;
  taxable_amount: number; cgst_rate: number; sgst_rate: number; igst_rate: number; cess_rate: number }

/** Taxes and invoice value from the items (intra-state → CGST + SGST, inter-state → IGST). */
export function computeValues(items: EwbItemIn[], interState: boolean, other: number) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, cess = 0;
  for (const it of items) {
    taxable += it.taxable_amount;
    if (interState) igst += (it.taxable_amount * it.igst_rate) / 100;
    else { cgst += (it.taxable_amount * it.cgst_rate) / 100; sgst += (it.taxable_amount * it.sgst_rate) / 100; }
    cess += (it.taxable_amount * it.cess_rate) / 100;
  }
  const total = taxable + cgst + sgst + igst + cess + other;
  return { taxable_amount: r2(taxable), cgst_amount: r2(cgst), sgst_amount: r2(sgst), igst_amount: r2(igst), cess_amount: r2(cess), total_invoice_value: r2(total) };
}

/**
 * Everything the portal would reject, checked before a call (and for manual entry, so the record is complete).
 * `partB`: a vehicle (road) or transport document (rail / air / ship) is needed to start the validity.
 */
export function assertReady(e: any, items: EwbItemIn[], opts: { needPartB: boolean }) {
  const p: string[] = [];
  if (!GSTIN_RE.test(String(e.from_gstin ?? ''))) p.push(`Consignor GSTIN "${e.from_gstin ?? ''}" is not a valid GSTIN`);
  if (e.to_gstin !== 'URP' && !GSTIN_RE.test(String(e.to_gstin ?? ''))) p.push(`Consignee GSTIN "${e.to_gstin ?? ''}" is not valid — use URP for an unregistered party`);
  if (!/^[1-9]\d{5}$/.test(String(e.from_pincode ?? ''))) p.push('Consignor PIN code (6 digits) is missing');
  if (!/^[1-9]\d{5}$/.test(String(e.to_pincode ?? ''))) p.push('Consignee PIN code (6 digits) is missing — add it on the partner address');
  if (!stateName(e.from_state)) p.push('Consignor state is missing');
  if (!stateName(e.to_state)) p.push('Consignee state (state of supply) is missing');
  if (!String(e.document_number ?? '').trim()) p.push('Document number is missing');
  else if (!/^[A-Za-z0-9/-]{1,16}$/.test(e.document_number)) p.push(`Document number "${e.document_number}" — at most 16 letters / digits / "/" / "-"`);
  if (e.sub_supply_type === 'Others' && !String(e.sub_supply_desc ?? '').trim()) p.push('Describe the sub supply type (Others)');
  if (!items.length) p.push('Add at least one item');
  items.forEach((it, i) => {
    if (!/^\d{4,8}$/.test(String(it.hsn_code ?? ''))) p.push(`Item ${i + 1} (${it.product_name}): HSN code (4–8 digits) is missing`);
    if (!(it.quantity > 0)) p.push(`Item ${i + 1} (${it.product_name}): quantity is missing`);
    if (!(it.taxable_amount > 0)) p.push(`Item ${i + 1} (${it.product_name}): taxable value is missing`);
  });
  if (e.distance_km < 0 || e.distance_km > 4000) p.push('Distance must be 0–4000 km (0 = worked out from the PIN codes)');
  if (opts.needPartB) {
    if (e.transport_mode === 'Road' && !e.vehicle_no && !e.transporter_id) p.push('Road transport needs the vehicle number (Part B) or a transporter ID');
    if (e.vehicle_no && !VEHICLE_RE.test(cleanVehicle(e.vehicle_no))) p.push(`Vehicle number "${e.vehicle_no}" is not in the RTO format (e.g. TN39AB1234)`);
    if (e.transport_mode !== 'Road' && !e.transport_doc_no) p.push(`${e.transport_mode} transport needs the transport document number and date`);
  }
  if (e.transporter_id && !GSTIN_RE.test(String(e.transporter_id))) p.push(`Transporter ID "${e.transporter_id}" is not a valid GSTIN / TRANSIN`);
  if (p.length) throw BadRequest(`E-way bill not ready: ${p.slice(0, 6).join('; ')}${p.length > 6 ? `; and ${p.length - 6} more` : ''}`, p.map((m) => ({ field: '', message: m })));
}
