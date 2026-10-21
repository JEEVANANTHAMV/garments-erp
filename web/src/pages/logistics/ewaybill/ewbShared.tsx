import { useQuery } from '@tanstack/react-query';
import { Badge } from '../../../components/ui';
import { http, ApiError } from '../../../lib/api';
import { code128Svg } from '../../../lib/barcode';
import { fmtDate, fmtDateTime, fmtDecimal, fmtNumber } from '../../../lib/format';

/**
 * Shared bits of the GST e-way bill screens (client 21-Oct-2026): reference data, status badge, the client-side tax
 * preview (the server recomputes on save), error parsing and the EWB-01 style print.
 */

export interface EwbMeta {
  provider: 'MANUAL' | 'MASTERS_INDIA'; provider_label: string; online: boolean; threshold: number; configured: boolean;
  sub_supply_types: string[]; document_types: string[]; cancel_reasons: string[]; vehicle_reasons: string[];
  extend_reasons: string[]; states: string[]; source_types: { value: string; label: string }[];
}

export interface EwbItem {
  /** client-only row key */
  key: string;
  product_name: string; description: string; hsn_code: string; quantity: string; unit: string; taxable_amount: string;
  /** one GST % — the server splits it into CGST + SGST (intra-state) or IGST (inter-state) */
  rate: string; cess_rate: string;
}

export const n = (v: unknown) => Number(v ?? 0) || 0;
export const r2 = (x: number) => Math.round(x * 100) / 100;
export const errMsg = (e: unknown) => (e as any)?.message ?? String(e);
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
let seq = 0;
export const rowKey = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

export const TRANSACTION_TYPES = [
  { value: 1, label: '1 · Regular' }, { value: 2, label: '2 · Bill To – Ship To' },
  { value: 3, label: '3 · Bill From – Dispatch From' }, { value: 4, label: '4 · Combination of 2 and 3' },
];
export const TRANSPORT_MODES = ['Road', 'Rail', 'Air', 'Ship'];
export const VEHICLE_TYPES = [{ value: 'Regular', label: 'Regular' }, { value: 'ODC', label: 'Over-dimensional cargo (ODC)' }];
export const STATUS_TABS = [
  { key: '', label: 'All' }, { key: 'DRAFT', label: 'Draft' }, { key: 'ACTIVE', label: 'Active' }, { key: 'PART_A', label: 'Part-A only' },
  { key: 'EXPIRED', label: 'Expired' }, { key: 'CANCELLED', label: 'Cancelled' },
];
const STATUS_VIEW: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'Draft', tone: 'amber' }, ACTIVE: { label: 'Active', tone: 'green' }, PART_A: { label: 'Part-A only', tone: 'blue' },
  EXPIRED: { label: 'Expired', tone: 'slate' }, CANCELLED: { label: 'Cancelled', tone: 'red' }, GENERATED: { label: 'Generated', tone: 'green' },
};
export const statusLabel = (s: string) => STATUS_VIEW[s]?.label ?? s;

export function EwbStatus({ value, id, size }: { value: string; id?: string; size?: 'lg' }) {
  const v = STATUS_VIEW[value] ?? { label: value, tone: 'slate' };
  return <span id={id} data-status={value}><Badge tone={v.tone} size={size}>{v.label}</Badge></span>;
}

export function useEwbMeta() {
  return useQuery({
    queryKey: ['ewb-meta'],
    queryFn: async () => (await http.get<{ data: EwbMeta }>('/eway-bills/meta')).data,
    staleTime: 5 * 60 * 1000,
  });
}

/** Same rule as the server: inter-state (IGST) unless both states are known and equal. */
export const isInterState = (fromState: string, toState: string) => !fromState || !toState || fromState !== toState;

export function computeTotals(items: EwbItem[], inter: boolean, other: number) {
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, cess = 0;
  for (const it of items) {
    const t = n(it.taxable_amount); const rate = n(it.rate);
    taxable += t;
    if (inter) igst += (t * rate) / 100; else { cgst += (t * rate) / 200; sgst += (t * rate) / 200; }
    cess += (t * n(it.cess_rate)) / 100;
  }
  return { taxable: r2(taxable), cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst), cess: r2(cess), total: r2(taxable + cgst + sgst + igst + cess + other) };
}

/** Server item → editable row (the single GST % is IGST or CGST + SGST). */
export const itemFromServer = (it: any): EwbItem => ({
  key: rowKey(), product_name: it.product_name ?? '', description: it.description ?? '', hsn_code: it.hsn_code ?? '',
  quantity: it.quantity == null ? '' : String(n(it.quantity)), unit: it.unit ?? 'PCS',
  taxable_amount: it.taxable_amount == null ? '' : String(n(it.taxable_amount)),
  rate: String(n(it.igst_rate) || r2(n(it.cgst_rate) + n(it.sgst_rate))), cess_rate: String(n(it.cess_rate)),
});
export const emptyItem = (): EwbItem => ({ key: rowKey(), product_name: '', description: '', hsn_code: '', quantity: '', unit: 'PCS', taxable_amount: '', rate: '5', cess_rate: '0' });
export const itemToPayload = (it: EwbItem) => ({
  product_name: it.product_name.trim(), description: it.description.trim() || null, hsn_code: it.hsn_code.trim(),
  quantity: n(it.quantity), unit: it.unit.trim() || 'PCS', taxable_amount: n(it.taxable_amount),
  igst_rate: n(it.rate), cgst_rate: 0, sgst_rate: 0, cess_rate: n(it.cess_rate),
});

/** Server error → headline + the list of problems ("E-way bill not ready: a; b; c" or field details). */
export function parseError(e: unknown): { message: string; problems: string[] } {
  const message = errMsg(e);
  const det = e instanceof ApiError && Array.isArray(e.details) ? (e.details as { message?: string }[]).map((d) => d?.message ?? '').filter(Boolean) : [];
  if (det.length) return { message: message.includes(':') && /not ready/i.test(message) ? message.split(':')[0] : message, problems: det };
  const m = /^(E-way bill not ready):\s*(.*)$/i.exec(message);
  if (m) return { message: m[1], problems: m[2].split(/;\s*/).filter(Boolean) };
  return { message, problems: [] };
}

/** "YYYY-MM-DDTHH:mm" of now, for <input type="datetime-local">. */
export const nowLocalInput = () => {
  const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
/** datetime-local value (browser time) → ISO for the server; '' → undefined. */
export const localToIso = (v: string) => (v ? new Date(v).toISOString() : undefined);

/** Popup print of the e-way bill in the layout of the portal's EWB-01 (like the carton label). */
export function printEwayBill(e: any): boolean {
  const w = window.open('', '_blank', 'width=820,height=900');
  if (!w) return false;
  const items = (e.items ?? []).map((it: any, i: number) => {
    const rate = n(it.igst_rate) ? `IGST ${n(it.igst_rate)}%` : n(it.cgst_rate) + n(it.sgst_rate) ? `CGST ${n(it.cgst_rate)}% + SGST ${n(it.sgst_rate)}%` : 'Nil';
    return `<tr><td>${i + 1}</td><td>${esc(it.hsn_code)}</td><td>${esc(it.product_name)}${it.description ? ` — ${esc(it.description)}` : ''}</td>
      <td class="r">${esc(fmtDecimal(it.quantity, 2))} ${esc(it.unit)}</td><td class="r">${esc(fmtDecimal(it.taxable_amount))}</td><td>${esc(rate)}</td></tr>`;
  }).join('');
  const hsn = [...new Set((e.items ?? []).map((it: any) => it.hsn_code).filter(Boolean))].join(', ');
  const partB = (e.events ?? []).filter((ev: any) => ev.ok && ['PART_B', 'GENERATE', 'RECORD'].includes(ev.action));
  const enteredOn = partB.length ? partB[0].created_at : e.ewb_date;
  const reason = e.sub_supply_type === 'Others' && e.sub_supply_desc ? `Others — ${e.sub_supply_desc}` : e.sub_supply_type;
  const row = (k: string, v: unknown) => `<tr><th>${esc(k)}</th><td>${esc(v == null || v === '' ? '—' : v)}</td></tr>`;
  w.document.open();
  w.document.write(`<!doctype html><html><head><title>E-Way Bill ${esc(e.ewb_no ?? e.doc_no)}</title><style>
    body{font:12px Arial;margin:0;padding:18px;color:#000} .page{border:1.5px solid #000;padding:14px;max-width:760px;margin:auto}
    h1{font-size:18px;margin:0;text-align:center;letter-spacing:1px} h2{font-size:13px;margin:12px 0 4px;padding:3px 6px;background:#eee;border:1px solid #000}
    .top{display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px} .big{font:bold 20px monospace;letter-spacing:1px}
    table{width:100%;border-collapse:collapse} th,td{border:1px solid #000;padding:3px 6px;text-align:left;vertical-align:top;font-size:12px}
    .kv th{width:38%;background:#fafafa;font-weight:normal} .r{text-align:right} .muted{color:#555;font-size:11px}
    .stamp{display:inline-block;border:2px solid #b00;color:#b00;padding:2px 8px;font-weight:bold;transform:rotate(-4deg)}
    @media print{body{padding:0} .page{border:none}}</style></head><body><div class="page">
    <h1>E-WAY BILL</h1>
    <div class="top"><div>
      <div>E-Way Bill No: <span class="big">${esc(e.ewb_no ?? 'Not generated')}</span></div>
      <div>E-Way Bill Date: <b>${esc(fmtDateTime(e.ewb_date))}</b></div>
      <div>Generated By: <b>${esc(e.from_gstin)}</b> — ${esc(e.from_name)}</div>
      <div>Valid Upto: <b>${esc(e.valid_upto ? fmtDateTime(e.valid_upto) : 'Part B not entered')}</b></div>
      ${e.status === 'CANCELLED' ? `<div style="margin-top:4px"><span class="stamp">CANCELLED</span> ${esc(e.cancel_reason ?? '')}</div>` : ''}
    </div><div style="text-align:center">${e.ewb_no ? code128Svg(String(e.ewb_no), { height: 54, module: 1.5 }) : ''}
      <div style="font:bold 13px monospace;letter-spacing:2px">${esc(e.ewb_no ?? '')}</div></div></div>
    <h2>Part - A</h2><table class="kv">
      ${row('GSTIN of Supplier', `${e.from_gstin} — ${e.from_name}`)}
      ${row('Place of Dispatch', [e.from_place, e.from_state, e.from_pincode].filter(Boolean).join(', '))}
      ${row('GSTIN of Recipient', `${e.to_gstin} — ${e.to_name}`)}
      ${row('Place of Delivery', [e.to_place, e.to_state, e.to_pincode].filter(Boolean).join(', '))}
      ${row('Document No.', e.document_number)}
      ${row('Document Date', fmtDate(e.document_date))}
      ${row('Document Type', e.document_type)}
      ${row('Transaction Type', `${e.supply_type} — ${TRANSACTION_TYPES.find((t) => t.value === n(e.transaction_type))?.label ?? e.transaction_type}`)}
      ${row('Value of Goods (₹)', fmtDecimal(e.total_invoice_value))}
      ${row('HSN Code', hsn)}
      ${row('Reason for Transportation', reason)}
      ${row('Transporter', [e.transporter_id, e.transporter_name].filter(Boolean).join(' — '))}
    </table>
    <h2>Part - B</h2><table>
      <thead><tr><th>Mode</th><th>Vehicle / Trans Doc No &amp; Dt.</th><th>From</th><th>Entered Date</th><th>Entered By</th></tr></thead>
      <tbody><tr><td>${esc(e.transport_mode)}</td>
        <td>${esc(e.vehicle_no || '—')}${e.transport_doc_no ? ` / ${esc(e.transport_doc_no)} ${esc(fmtDate(e.transport_doc_date))}` : ''}</td>
        <td>${esc(e.from_place ?? '')}</td><td>${esc(e.vehicle_no || e.transport_doc_no ? fmtDateTime(enteredOn) : '—')}</td><td>${esc(e.from_gstin)}</td></tr></tbody></table>
    <h2>Items</h2><table>
      <thead><tr><th>#</th><th>HSN</th><th>Product</th><th class="r">Quantity</th><th class="r">Taxable ₹</th><th>Tax rate</th></tr></thead>
      <tbody>${items}</tbody>
      <tfoot>
        <tr><th colspan="4" class="r">Taxable</th><th class="r">${esc(fmtDecimal(e.taxable_amount))}</th><th></th></tr>
        <tr><th colspan="4" class="r">CGST / SGST / IGST / Cess</th><th class="r" colspan="2">${esc([e.cgst_amount, e.sgst_amount, e.igst_amount, e.cess_amount].map((x) => fmtDecimal(x)).join(' / '))}</th></tr>
        <tr><th colspan="4" class="r">Total invoice value</th><th class="r">${esc(fmtDecimal(e.total_invoice_value))}</th><th></th></tr>
      </tfoot></table>
    <p class="muted">Distance ${esc(fmtNumber(e.distance_km))} km · ${esc(e.provider === 'MASTERS_INDIA' ? 'Generated through Masters India' : 'Recorded from the GST portal')} · Ref ${esc(e.doc_no)}</p>
    </div><script>setTimeout(function(){window.print()},300)</script></body></html>`);
  w.document.close();
  return true;
}
