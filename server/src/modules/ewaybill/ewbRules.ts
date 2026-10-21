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
 * E-way bill times are Indian time (IST, UTC+05:30) whatever the server's time zone: validity ends at midnight IST and
 * the portal's dates are IST. These build / read a Date in IST so a server running in UTC gets the same answer.
 */
const IST_MS = 330 * 60 * 1000;
export const istDate = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, mo, d, h, mi, s) - IST_MS);
export function istParts(d: Date) {
  const x = new Date(d.getTime() + IST_MS);
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth(), d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), s: x.getUTCSeconds() };
}
/** "2026-10-21" / "2026-10-21T17:30" / "2026-10-21 17:30:00" (IST unless the string carries a zone) → Date; null when not a date. */
export function istFromString(v: string | null | undefined): Date | null {
  const t = String(v ?? '').trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(t);
  const d = m ? istDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Validity (rule 138(10)): Regular cargo 1 day per 200 km (or part), over-dimensional cargo 1 day per 20 km;
 * a day runs to midnight (IST) of the day after the generation date — the portal shows it as 11:59 PM.
 * Returns null without a distance.
 */
export function validityUpto(from: Date, distanceKm: number, vehicleType: 'Regular' | 'ODC'): Date | null {
  if (!(distanceKm > 0)) return null;
  const days = Math.max(1, Math.ceil(distanceKm / (vehicleType === 'ODC' ? 20 : 200)));
  const p = istParts(from);
  return istDate(p.y, p.mo, p.d + days, 23, 59, 0);
}

/** Sub supply type → document types the portal accepts with it (outward); a combination outside this is rejected there. */
export const OUTWARD_DOC_TYPES: Record<string, readonly string[]> = {
  'Supply': ['Tax Invoice', 'Bill of Supply'], 'Export': ['Tax Invoice', 'Bill of Supply'], 'Job Work': ['Delivery Challan'],
  'SKD/CKD/Lots': ['Tax Invoice', 'Bill of Supply', 'Delivery Challan'], 'Recipient Not Known': ['Delivery Challan', 'Others'],
  'For Own Use': ['Delivery Challan'], 'Exhibition or Fairs': ['Delivery Challan'], 'Line Sales': ['Delivery Challan'],
  'Others': ['Delivery Challan', 'Others'],
};
/** Inward-only sub supply types. */
export const INWARD_ONLY_SUB = ['Job Work Returns', 'Sales Return'];

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
  // the total is the sum of the rounded figures shown (the portal checks it against them, not against unrounded tax)
  const v = { taxable_amount: r2(taxable), cgst_amount: r2(cgst), sgst_amount: r2(sgst), igst_amount: r2(igst), cess_amount: r2(cess) };
  return { ...v, total_invoice_value: r2(v.taxable_amount + v.cgst_amount + v.sgst_amount + v.igst_amount + v.cess_amount + r2(other)) };
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
  // the portal checks the consignor state against its GSTIN, and a registered consignee's state of supply against its GSTIN
  if (GSTIN_RE.test(String(e.from_gstin ?? '')) && stateName(e.from_state) && stateName(e.from_state) !== stateName(e.from_gstin))
    p.push(`Consignor state ${stateName(e.from_state)} does not match GSTIN ${e.from_gstin} (${stateName(e.from_gstin)})`);
  if (GSTIN_RE.test(String(e.to_gstin ?? '')) && stateName(e.to_state) && stateName(e.to_state) !== stateName(e.to_gstin))
    p.push(`State of supply ${stateName(e.to_state)} does not match consignee GSTIN ${e.to_gstin} (${stateName(e.to_gstin)})`);
  if (!String(e.document_number ?? '').trim()) p.push('Document number is missing');
  else if (!/^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/.test(e.document_number)) p.push(`Document number "${e.document_number}" — at most 16 letters / digits / "/" / "-", not starting with 0, "/" or "-"`);
  const docDay = String(e.document_date ?? '').slice(0, 10);
  const today = (() => { const t = istParts(new Date()); return `${t.y}-${String(t.mo + 1).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`; })();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(docDay)) p.push('Document date is missing');
  else if (docDay > today) p.push(`Document date ${docDay} is in the future`);
  if (e.sub_supply_type === 'Others' && !String(e.sub_supply_desc ?? '').trim()) p.push('Describe the sub supply type (Others)');
  if ((e.supply_type ?? 'OUTWARD') === 'OUTWARD') {
    if (INWARD_ONLY_SUB.includes(e.sub_supply_type)) p.push(`"${e.sub_supply_type}" is an inward sub supply type`);
    else if (OUTWARD_DOC_TYPES[e.sub_supply_type] && !OUTWARD_DOC_TYPES[e.sub_supply_type].includes(e.document_type))
      p.push(`Document type for "${e.sub_supply_type}" must be ${OUTWARD_DOC_TYPES[e.sub_supply_type].join(' / ')} (not ${e.document_type})`);
  }
  if (!items.length) p.push('Add at least one item');
  items.forEach((it, i) => {
    if (!/^\d{4,8}$/.test(String(it.hsn_code ?? ''))) p.push(`Item ${i + 1} (${it.product_name}): HSN code (4–8 digits) is missing`);
    else if (String(it.hsn_code).startsWith('99')) p.push(`Item ${i + 1} (${it.product_name}): HSN ${it.hsn_code} is a service (SAC) — an e-way bill carries goods only`);
    if (!(it.quantity > 0)) p.push(`Item ${i + 1} (${it.product_name}): quantity is missing`);
    if (!(it.taxable_amount > 0)) p.push(`Item ${i + 1} (${it.product_name}): taxable value is missing`);
  });
  if (e.distance_km < 0 || e.distance_km > 4000) p.push('Distance must be 0–4000 km (0 = worked out from the PIN codes)');
  // Part B given with Part A is checked whenever it is there (it starts the validity); required only when asked
  if (e.vehicle_no && !VEHICLE_RE.test(cleanVehicle(e.vehicle_no))) p.push(`Vehicle number "${e.vehicle_no}" is not in the RTO format (e.g. TN39AB1234)`);
  if (e.transport_doc_no && !e.transport_doc_date) p.push('Transport document date is missing');
  if (e.transport_doc_date && /^\d{4}-\d{2}-\d{2}$/.test(docDay) && String(e.transport_doc_date).slice(0, 10) < docDay) p.push('Transport document date cannot be before the document date');
  if (opts.needPartB) {
    if (e.transport_mode === 'Road' && !e.vehicle_no && !e.transporter_id) p.push('Road transport needs the vehicle number (Part B) or a transporter ID');
    if (e.transport_mode !== 'Road' && !e.transport_doc_no) p.push(`${e.transport_mode} transport needs the transport document number and date`);
  }
  if (e.transporter_id && !GSTIN_RE.test(String(e.transporter_id))) p.push(`Transporter ID "${e.transporter_id}" is not a valid GSTIN / TRANSIN`);
  if (p.length) throw BadRequest(`E-way bill not ready: ${p.slice(0, 6).join('; ')}${p.length > 6 ? `; and ${p.length - 6} more` : ''}`, p.map((m) => ({ field: '', message: m })));
}
