import { AppError, BadRequest } from '../../core/errors.js';
import { stateName, uqcOf } from './ewbRules.js';

/**
 * E-way bill providers. The screens and the rules never change; only the provider does:
 *   MANUAL         the EWB is generated on the GST portal (ewaybillgst.gov.in) and its number / validity recorded here
 *   MASTERS_INDIA  generated, cancelled, updated through the Masters India e-way bill API
 *                  (docs.mastersindia.co/eway) — switched on with EWB_PROVIDER = MASTERS_INDIA and the server env:
 *                    MASTERS_INDIA_API_URL   sandbox https://sandb-api.edoc.mastersindia.co · production https://router.mastersindia.co
 *                    MASTERS_INDIA_USERNAME / MASTERS_INDIA_PASSWORD   the API user from the Masters India onboarding
 * Every call returns what the portal said (number, date, validity, PDF link) or throws its message.
 */

export interface EwbResult { ewb_no?: string; ewb_date?: Date | null; valid_upto?: Date | null; url?: string | null; raw?: unknown; request?: unknown }
export interface EwbProvider {
  code: 'MANUAL' | 'MASTERS_INDIA';
  label: string;
  /** false = the user types the EWB number / validity from the portal */
  online: boolean;
  generate(e: any, items: any[]): Promise<EwbResult>;
  cancel(e: any, reason: string, remark: string): Promise<EwbResult>;
  updatePartB(e: any, p: PartBIn): Promise<EwbResult>;
  extend(e: any, p: ExtendIn): Promise<EwbResult>;
  fetch(e: any): Promise<EwbResult>;
}
export interface PartBIn { vehicle_no: string; vehicle_type: string; transport_mode: string; transport_doc_no?: string | null; transport_doc_date?: string | null;
  from_place: string; from_state: string; reason: string; remark?: string | null }
export interface ExtendIn { vehicle_no?: string | null; from_place: string; from_state: string; from_pincode: string; remaining_km: number; reason: string; remark?: string | null;
  consignment_status: 'M' | 'T'; transit_type?: string | null; transport_mode: string; transport_doc_no?: string | null; transport_doc_date?: string | null;
  address1?: string | null; address2?: string | null; address3?: string | null }

// ───────────────────────────────────────────────────────── manual (until the API is connected)

export const manualProvider: EwbProvider = {
  code: 'MANUAL', label: 'Manual — generate on the GST portal, record the EWB number here', online: false,
  async generate() { throw BadRequest('Manual mode: generate the e-way bill on the GST portal and enter its number here'); },
  async cancel() { return {}; },
  async updatePartB() { return {}; },
  async extend() { return {}; },
  async fetch() { throw BadRequest('Manual mode: the e-way bill details are on the GST portal — connect the API to refresh them here'); },
};

// ───────────────────────────────────────────────────────── Masters India

const MI_URL = () => (process.env.MASTERS_INDIA_API_URL || 'https://sandb-api.edoc.mastersindia.co').replace(/\/+$/, '');
let miToken: { token: string; at: number } | null = null;

async function miAuth(force = false): Promise<string> {
  if (!force && miToken && Date.now() - miToken.at < 23 * 3600 * 1000) return miToken.token;
  const username = process.env.MASTERS_INDIA_USERNAME, password = process.env.MASTERS_INDIA_PASSWORD;
  if (!username || !password) throw new AppError(503, 'Masters India API is not configured — set MASTERS_INDIA_USERNAME / MASTERS_INDIA_PASSWORD on the server (or switch EWB_PROVIDER to MANUAL)', 'EWB_NOT_CONFIGURED');
  const res = await fetch(`${MI_URL()}/api/v1/token-auth/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.token) throw new AppError(502, `Masters India login failed: ${body?.error ?? body?.detail ?? res.statusText}`, 'EWB_AUTH', body);
  miToken = { token: body.token, at: Date.now() };
  return body.token;
}

/** One call; retries once with a fresh token on 401; a portal error (code ≠ 200) becomes a readable message. */
async function miCall(method: 'GET' | 'POST', path: string, payload: Record<string, unknown>): Promise<{ msg: any; raw: any }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await miAuth(attempt > 0);
    const url = method === 'GET' ? `${MI_URL()}${path}?${new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v ?? '')]))}` : `${MI_URL()}${path}`;
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` }, body: method === 'POST' ? JSON.stringify(payload) : undefined });
    if (res.status === 401 && attempt === 0) continue;
    const raw: any = await res.json().catch(() => ({}));
    const r = raw?.results ?? raw;
    const code = Number(r?.code ?? res.status);
    if (!res.ok || code !== 200) {
      const m = typeof r?.message === 'string' ? r.message : r?.message?.error || r?.error || raw?.detail || res.statusText;
      throw new AppError(422, `E-way bill portal: ${m}${r?.nic_code && !String(m).startsWith(String(r.nic_code)) ? ` (NIC ${r.nic_code})` : ''}`, 'EWB_PORTAL', raw);
    }
    if (r?.message?.error && String(r.message.error).trim()) throw new AppError(422, `E-way bill portal: ${r.message.error}`, 'EWB_PORTAL', raw);
    return { msg: r?.message ?? {}, raw };
  }
  throw new AppError(502, 'Masters India: not authorised', 'EWB_AUTH');
}

const dmy = (d: unknown) => { const x = d instanceof Date ? d : new Date(String(d)); return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`; };
/** "26/06/2023 05:29:00 PM" / "26/06/2023 23:59:00" → Date */
export function parsePortalDate(v: unknown): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i.exec(String(v ?? '').trim());
  if (!m) return null;
  let h = Number(m[4] ?? 0);
  if (m[7]) { const pm = m[7].toUpperCase() === 'PM'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h, Number(m[5] ?? 0), Number(m[6] ?? 0));
}
const MODE_NO: Record<string, string> = { Road: '1', Rail: '2', Air: '3', Ship: '4' };

/** Our e-way bill record → the Masters India generate payload. */
export function miGeneratePayload(e: any, items: any[]) {
  return {
    userGstin: e.from_gstin,
    supply_type: e.supply_type === 'INWARD' ? 'inward' : 'outward',
    sub_supply_type: e.sub_supply_type, sub_supply_description: e.sub_supply_desc ?? '',
    document_type: e.document_type, document_number: e.document_number, document_date: dmy(e.document_date),
    gstin_of_consignor: e.from_gstin, legal_name_of_consignor: e.from_name, address1_of_consignor: e.from_address1 ?? '', address2_of_consignor: e.from_address2 ?? '',
    place_of_consignor: e.from_place ?? '', pincode_of_consignor: Number(e.from_pincode), state_of_consignor: stateName(e.from_state), actual_from_state_name: stateName(e.dispatch_state || e.from_state),
    gstin_of_consignee: e.to_gstin, legal_name_of_consignee: e.to_name, address1_of_consignee: e.to_address1 ?? '', address2_of_consignee: e.to_address2 ?? '',
    place_of_consignee: e.to_place ?? '', pincode_of_consignee: Number(e.to_pincode), state_of_supply: stateName(e.to_state), actual_to_state_name: stateName(e.ship_state || e.to_state),
    transaction_type: Number(e.transaction_type || 1),
    other_value: Number(e.other_value || 0), total_invoice_value: Number(e.total_invoice_value), taxable_amount: Number(e.taxable_amount),
    cgst_amount: Number(e.cgst_amount), sgst_amount: Number(e.sgst_amount), igst_amount: Number(e.igst_amount), cess_amount: Number(e.cess_amount), cess_nonadvol_value: 0,
    transporter_id: e.transporter_id ?? '', transporter_name: e.transporter_name ?? '',
    transporter_document_number: e.transport_doc_no ?? '', transporter_document_date: e.transport_doc_date ? dmy(e.transport_doc_date) : '',
    transportation_mode: e.transport_mode, transportation_distance: String(e.distance_km ?? 0),
    vehicle_number: e.vehicle_no ?? '', vehicle_type: e.vehicle_type === 'ODC' ? 'ODC' : 'Regular',
    generate_status: 1, data_source: 'erp', user_ref: e.doc_no, location_code: '', eway_bill_status: '', auto_print: 'Y', email: '',
    itemList: items.map((it) => ({
      product_name: it.product_name, product_description: it.description ?? it.product_name, hsn_code: String(it.hsn_code),
      quantity: Number(it.quantity), unit_of_product: uqcOf(it.unit), cgst_rate: Number(it.cgst_rate), sgst_rate: Number(it.sgst_rate),
      igst_rate: Number(it.igst_rate), cess_rate: Number(it.cess_rate), cessNonAdvol: 0, taxable_amount: Number(it.taxable_amount),
    })),
  };
}

export const mastersIndiaProvider: EwbProvider = {
  code: 'MASTERS_INDIA', label: 'Masters India e-way bill API', online: true,
  async generate(e, items) {
    const request = miGeneratePayload(e, items);
    const { msg, raw } = await miCall('POST', '/api/v1/ewayBillsGenerate/', request);
    if (!msg?.ewayBillNo) throw new AppError(422, 'E-way bill portal returned no e-way bill number', 'EWB_PORTAL', raw);
    return { ewb_no: String(msg.ewayBillNo), ewb_date: parsePortalDate(msg.ewayBillDate), valid_upto: parsePortalDate(msg.validUpto), url: msg.url ?? null, raw, request };
  },
  async cancel(e, reason, remark) {
    const request = { userGstin: e.from_gstin, eway_bill_number: Number(e.ewb_no), reason_of_cancel: reason, cancel_remark: remark, data_source: 'erp' };
    const { raw } = await miCall('POST', '/api/v1/ewayBillCancel/', request);
    return { raw, request };
  },
  async updatePartB(e, p) {
    const request = { userGstin: e.from_gstin, eway_bill_number: Number(e.ewb_no), vehicle_number: p.vehicle_no, vehicle_type: p.vehicle_type === 'ODC' ? 'O' : 'R',
      place_of_consignor: p.from_place, state_of_consignor: stateName(p.from_state), reason_code_for_vehicle_updation: p.reason, reason_for_vehicle_updation: p.remark ?? '',
      transporter_document_number: p.transport_doc_no ?? '', transporter_document_date: p.transport_doc_date ? dmy(p.transport_doc_date) : '',
      mode_of_transport: MODE_NO[p.transport_mode] ?? '1', data_source: 'erp' };
    const { msg, raw } = await miCall('POST', '/api/v1/updateVehicleNumber/', request);
    return { valid_upto: parsePortalDate(msg.validUpto), url: msg.url ?? null, raw, request };
  },
  async extend(e, p) {
    const request = { userGstin: e.from_gstin, eway_bill_number: Number(e.ewb_no), vehicle_number: p.vehicle_no ?? '', place_of_consignor: p.from_place,
      state_of_consignor: stateName(p.from_state), remaining_distance: p.remaining_km, transporter_document_number: p.transport_doc_no ?? '',
      transporter_document_date: p.transport_doc_date ? dmy(p.transport_doc_date) : '', mode_of_transport: MODE_NO[p.transport_mode] ?? '1',
      extend_validity_reason: p.reason, extend_remarks: p.remark ?? '', consignment_status: p.consignment_status, from_pincode: Number(p.from_pincode),
      transit_type: p.consignment_status === 'T' ? (p.transit_type ?? 'R') : '', address_line1: p.address1 ?? '', address_line2: p.address2 ?? '', address_line3: p.address3 ?? '' };
    const { msg, raw } = await miCall('POST', '/api/v1/ewayBillValidityExtend/', request);
    return { valid_upto: parsePortalDate(msg.validUpto), url: msg.url ?? null, raw, request };
  },
  async fetch(e) {
    const { msg, raw } = await miCall('GET', '/api/v1/getEwayBillData/', { action: 'GetEwayBill', gstin: e.from_gstin, eway_bill_number: e.ewb_no });
    return { ewb_no: String(msg.eway_bill_number ?? e.ewb_no), ewb_date: parsePortalDate(msg.eway_bill_date), valid_upto: parsePortalDate(msg.eway_bill_valid_date), raw };
  },
};

export const providerOf = (code: string): EwbProvider => (code === 'MASTERS_INDIA' ? mastersIndiaProvider : manualProvider);
