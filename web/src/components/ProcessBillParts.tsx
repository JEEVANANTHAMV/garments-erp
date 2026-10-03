import { CheckCircle2, AlertTriangle, MinusCircle, Layers } from 'lucide-react';
import { Input, Select, Textarea } from './ui';
import { GateEntryPicker } from './ProcessPickers';
import { InvoiceSummary } from './InvoiceSummary';
import { computeInvoice, chargesPayload, EMPTY_CHARGES, type GstMode, type InvoiceCharges, type InvoiceTotals } from '../lib/invoiceCalc';
import { fmtDecimal, today } from '../lib/format';

/**
 * Job-work bills (knitting, fabric process, yarn process) laid out like the purchase bill (client voice note
 * 03-Oct-2026): contractor + party bill no / date + due date + gate entry, GRNs picked into the bill (each GRN's
 * details load), matching (GRN / rate vs quotation / gate), and the common invoice summary — GST nature, freight,
 * other charges (±), TDS, TCS, round off. The server recomputes the same totals (core/processBill.ts).
 */
export interface PbHead {
  vendor_id: string; bill_date: string; party_bill_no: string; party_bill_date: string; due_date: string; gate_inward_id: string;
  gst_type: 'INTRA_STATE' | 'INTER_STATE'; gst_pct: string; discount_amount: string; debit_amount: string; remarks: string; rate_change_reason: string;
}
export const emptyPbHead = (gstPct = '5'): PbHead => ({
  vendor_id: '', bill_date: today(), party_bill_no: '', party_bill_date: '', due_date: '', gate_inward_id: '',
  gst_type: 'INTRA_STATE', gst_pct: gstPct, discount_amount: '', debit_amount: '', remarks: '', rate_change_reason: '',
});
export const emptyPbCharges = (): InvoiceCharges => ({ ...EMPTY_CHARGES });

const n = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => `₹${fmtDecimal(n(v), 2)}`;

/** Totals exactly as the server computes them: base = charges − recovery − discount − debit, then the invoice summary. */
export function pbTotals(h: PbHead, charges: InvoiceCharges, gross: number, recovery = 0): InvoiceTotals & { base: number } {
  const base = Math.round((gross - recovery - n(h.discount_amount) - n(h.debit_amount)) * 100) / 100;
  return { ...computeInvoice([{ taxable: base, gst_rate: n(h.gst_pct) }], h.gst_type as GstMode, charges), base };
}

/** Header + charges fields of the POST body. */
export function pbPayload(h: PbHead, charges: InvoiceCharges, t: InvoiceTotals) {
  const c = chargesPayload(charges, t);
  return {
    vendor_id: Number(h.vendor_id), bill_date: h.bill_date, party_bill_no: h.party_bill_no || null, party_bill_date: h.party_bill_date || null, due_date: h.due_date || null,
    gate_inward_id: h.gate_inward_id ? Number(h.gate_inward_id) : null, gst_type: h.gst_type, gst_pct: n(h.gst_pct),
    discount_amount: n(h.discount_amount), debit_amount: n(h.debit_amount), remarks: h.remarks || null, rate_change_reason: h.rate_change_reason || null,
    freight_charges: c.freight_charges, other_charges: c.other_charges, other_charges_sign: c.other_charges_sign, other_charges_label: c.other_charges_label,
    tds_section: c.tds_section, tds_pct: c.tds_pct, tcs_section: c.tcs_section, tcs_pct: c.tcs_pct, round_off: c.round_off,
  };
}

/** Client-side checks shared by the three bills (the server repeats them). */
export function pbHeadError(h: PbHead, base: number): string | null {
  if (!h.vendor_id) return 'Choose the contractor';
  if (!h.bill_date) return 'Enter the bill date';
  if (h.party_bill_date && h.party_bill_date > h.bill_date) return 'The party bill date is after the bill date';
  if (h.due_date && h.due_date < h.bill_date) return 'The due date is before the bill date';
  if (base < 0) return 'Recovery + discount + debit is more than the charges';
  return null;
}

export function ProcessBillHeader({ h, setH, suppliers, vendorLabel, idPrefix, onVendorChange }: {
  h: PbHead; setH: (f: (x: PbHead) => PbHead) => void; suppliers: any[] | undefined; vendorLabel: string; idPrefix: string; onVendorChange?: () => void;
}) {
  return (
    <div className="card mb-3 grid grid-cols-2 items-end gap-3 p-4 md:grid-cols-6" id={`${idPrefix}-head`}>
      <Select label={`${vendorLabel} *`} className="col-span-2" value={h.vendor_id} placeholder="—" id={`${idPrefix}-vendor`}
        onChange={(e) => { const v = e.target.value; setH((x) => ({ ...x, vendor_id: v, gate_inward_id: '' })); onVendorChange?.(); }}
        options={(suppliers ?? []).map((s: any) => ({ value: String(s.id), label: s.code ? `${s.code} — ${s.label}` : s.label }))} />
      <Input label="Bill date *" type="date" value={h.bill_date} id={`${idPrefix}-date`} onChange={(e) => setH((x) => ({ ...x, bill_date: e.target.value }))} />
      <Input label="Party bill / invoice no" value={h.party_bill_no} id={`${idPrefix}-party-bill`} onChange={(e) => setH((x) => ({ ...x, party_bill_no: e.target.value }))} />
      <Input label="Party bill date" type="date" value={h.party_bill_date} id={`${idPrefix}-party-date`} onChange={(e) => setH((x) => ({ ...x, party_bill_date: e.target.value }))} />
      <Input label="Payment due date" type="date" value={h.due_date} id={`${idPrefix}-due`} onChange={(e) => setH((x) => ({ ...x, due_date: e.target.value }))} />
      <div className="col-span-2 md:col-span-3">
        {h.vendor_id
          ? <GateEntryPicker partyId={h.vendor_id} value={h.gate_inward_id} idPrefix={idPrefix} onChange={(v) => setH((x) => ({ ...x, gate_inward_id: v }))}
              onPick={(g) => setH((x) => ({ ...x, gate_inward_id: String(g.id), party_bill_no: x.party_bill_no || g.supplier_inv_no || g.supplier_dc_no || '' }))} />
          : <p className="pb-2 text-xs text-slate-400">Choose the contractor to see their gate entries and GRNs</p>}
      </div>
    </div>
  );
}

/** "+ Add GRN" dropdown with chips — like the purchase bill. `options` are the contractor's unbilled GRNs. */
export function GrnPicker({ options, picked, onAdd, onRemove, onAddAll, idPrefix, noun = 'GRN' }: {
  options: { key: string; label: string }[]; picked: string[]; onAdd: (key: string) => void; onRemove: (key: string) => void; onAddAll: () => void; idPrefix: string; noun?: string;
}) {
  const free = options.filter((o) => !picked.includes(o.key));
  return (
    <div className="card mb-3 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-96 py-1.5 text-xs" value="" id={`${idPrefix}-add-grn`} onChange={(e) => { if (e.target.value) onAdd(e.target.value); }}>
          <option value="">{free.length ? `+ Add ${noun} (loads its details)…` : options.length ? `All ${noun}s are on the bill` : `No unbilled ${noun}s for this contractor`}</option>
          {free.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        {free.length > 1 && <button type="button" className="rounded border border-indigo-200 bg-indigo-50 px-2 py-1 font-semibold text-indigo-800" id={`${idPrefix}-add-all`} onClick={onAddAll}>Add all ({free.length})</button>}
      </div>
      {picked.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-dashed border-indigo-100 pt-2" id={`${idPrefix}-chips`}>
          <span className="flex items-center gap-1 font-bold text-slate-600"><Layers size={13} className="text-indigo-600" /> On this bill ({picked.length}):</span>
          {picked.map((k) => (
            <span key={k} className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-semibold text-indigo-800">
              {options.find((o) => o.key === k)?.label.split(' · ')[0] ?? k}
              <button type="button" className="ml-0.5 text-indigo-400 hover:text-rose-600" title="Remove from the bill" onClick={() => onRemove(k)}>✕</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** GRN / rate / gate matching, computed (not ticked by hand). */
export function MatchStrip({ grnCount, rateDiffs, gate }: { grnCount: number; rateDiffs: string[]; gate: boolean }) {
  const chip = (ok: boolean | null, label: string, detail: string) => (
    <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 ${ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : ok === null ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
      {ok ? <CheckCircle2 size={13} /> : ok === null ? <MinusCircle size={13} /> : <AlertTriangle size={13} />}<b>{label}</b> {detail}
    </span>
  );
  const status = rateDiffs.length ? 'Discrepancy' : gate ? 'Fully matched' : 'Partially matched';
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" id="pb-match">
      {chip(grnCount > 0, 'GRN', grnCount ? `${grnCount} linked — qty = GRN good KG` : 'none')}
      {chip(!rateDiffs.length, 'Rate', rateDiffs.length ? `differs from quotation: ${rateDiffs.join(', ')}` : 'as quotation')}
      {chip(gate ? true : null, 'Gate', gate ? 'entry mapped' : 'not mapped')}
      <span className="ml-auto font-semibold text-slate-700">Match status: <span id="pb-match-status">{status}</span></span>
    </div>
  );
}

/** Deductions, GST nature / %, remarks, and the invoice summary block. */
export function ProcessBillCharges({ h, setH, charges, setCharges, totals, gross, recovery = 0, rateChanged, idPrefix }: {
  h: PbHead; setH: (f: (x: PbHead) => PbHead) => void; charges: InvoiceCharges; setCharges: (f: (c: InvoiceCharges) => InvoiceCharges) => void;
  totals: InvoiceTotals & { base: number }; gross: number; recovery?: number; rateChanged: boolean; idPrefix: string;
}) {
  return (
    <div className="mb-3 grid gap-3 lg:grid-cols-[1fr_380px]">
      <div className="card space-y-3 p-4 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold uppercase tracking-wider text-slate-700">GST nature:</span>
          {(['INTRA_STATE', 'INTER_STATE'] as const).map((m) => (
            <button key={m} type="button" id={`${idPrefix}-gst-${m}`} onClick={() => setH((x) => ({ ...x, gst_type: m }))}
              className={`rounded-md border px-2.5 py-1 font-semibold ${h.gst_type === m ? 'border-indigo-300 bg-white text-indigo-700 shadow-xs' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
              {m === 'INTRA_STATE' ? 'Intra-state (CGST + SGST)' : 'Inter-state (IGST)'}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Input label="GST %" type="number" value={h.gst_pct} id={`${idPrefix}-gst-pct`} onChange={(e) => setH((x) => ({ ...x, gst_pct: e.target.value }))} />
          <Input label="Less: discount (₹)" type="number" value={h.discount_amount} id={`${idPrefix}-discount`} onChange={(e) => setH((x) => ({ ...x, discount_amount: e.target.value }))} />
          <Input label="Less: debit / shortage (₹)" type="number" value={h.debit_amount} id={`${idPrefix}-debit`} onChange={(e) => setH((x) => ({ ...x, debit_amount: e.target.value }))} />
        </div>
        <table className="w-full max-w-md" id={`${idPrefix}-base`}>
          <tbody>
            <tr><td className="py-0.5">Job-work charges (GRN KG × rate{recovery ? ' + billable reprocess' : ''})</td><td className="text-right font-mono">{money(gross)}</td></tr>
            {recovery > 0 && <tr className="text-red-700"><td>Less: recovery from contractor</td><td className="text-right font-mono">− {money(recovery)}</td></tr>}
            {n(h.discount_amount) > 0 && <tr><td>Less: discount</td><td className="text-right font-mono">− {money(h.discount_amount)}</td></tr>}
            {n(h.debit_amount) > 0 && <tr><td>Less: debit / shortage</td><td className="text-right font-mono">− {money(h.debit_amount)}</td></tr>}
            <tr className="border-t border-slate-200 font-semibold"><td className="pt-1">Taxable value</td><td className={`pt-1 text-right font-mono ${totals.base < 0 ? 'text-red-700' : ''}`}>{money(totals.base)}</td></tr>
          </tbody>
        </table>
        <Textarea label="Remarks" rows={2} value={h.remarks} id={`${idPrefix}-remarks`} onChange={(e) => setH((x) => ({ ...x, remarks: e.target.value }))} />
        {rateChanged && <Input label="Reason for rate change from quotation *" value={h.rate_change_reason} id={`${idPrefix}-rate-reason`} onChange={(e) => setH((x) => ({ ...x, rate_change_reason: e.target.value }))} />}
      </div>
      <InvoiceSummary totals={totals} value={charges} onChange={(p) => setCharges((c) => ({ ...c, ...p }))} gstMode={h.gst_type as GstMode} title="Bill Financial Summary" />
    </div>
  );
}

/** Read-only summary rows of a saved job-work bill (calc_version 2 shows every head; older bills their simple totals). */
export function ProcessBillTotalsView({ b }: { b: any }) {
  const row = (label: string, v: unknown, cls = '') => <tr className={cls}><td className="px-2 py-0.5">{label}</td><td className="px-2 py-0.5 text-right font-mono">{money(v)}</td></tr>;
  const v2 = Number(b.calc_version) === 2;
  const sign = Number(b.other_charges_sign) < 0 ? -1 : 1;
  return (
    <table className="ml-auto w-full max-w-sm text-xs" id="pb-totals">
      <tbody>
        {row('Gross charges', b.gross_amount)}
        {n(b.recovery_amount) > 0 && row('Less recovery', -n(b.recovery_amount), 'text-red-700')}
        {n(b.discount_amount) > 0 && row('Less discount', -n(b.discount_amount))}
        {n(b.debit_amount) > 0 && row('Less debit / shortage', -n(b.debit_amount))}
        {!v2 && n(b.other_charges) !== 0 && row('Add other charges', b.other_charges)}
        {row('Taxable value', v2 ? b.taxable_amount : n(b.net_amount) - n(b.gst_amount), 'font-semibold')}
        {b.gst_type === 'INTER_STATE' ? row(`IGST ${fmtDecimal(b.gst_pct, 2)}%`, b.igst_amount || b.gst_amount)
          : <>{row(`CGST ${fmtDecimal(n(b.gst_pct) / 2, 2)}%`, b.cgst_amount || n(b.gst_amount) / 2)}{row(`SGST ${fmtDecimal(n(b.gst_pct) / 2, 2)}%`, b.sgst_amount || n(b.gst_amount) / 2)}</>}
        {v2 && n(b.freight_charges) > 0 && row('Freight', b.freight_charges)}
        {v2 && n(b.other_charges) > 0 && row(`${sign < 0 ? 'Less' : 'Add'}: ${b.other_charges_label || 'other charges'}`, sign * n(b.other_charges))}
        {v2 && n(b.tcs_amount) > 0 && row(`TCS ${b.tcs_section ?? ''} ${fmtDecimal(b.tcs_pct, 3)}%`, b.tcs_amount)}
        {v2 && n(b.tds_amount) > 0 && row(`Less TDS ${b.tds_section ?? ''} ${fmtDecimal(b.tds_pct, 3)}%`, -n(b.tds_amount), 'text-red-700')}
        {v2 && n(b.round_off) !== 0 && row('Round off', b.round_off)}
        <tr className="border-t border-slate-300 text-sm font-bold"><td className="px-2 py-1">Net payable</td><td className="px-2 py-1 text-right font-mono" id="pb-net">{money(b.net_amount)}</td></tr>
      </tbody>
    </table>
  );
}

/** Header facts of a saved job-work bill. */
export function processBillFacts(b: any): [string, unknown][] {
  return [['Party bill', b.party_bill_no || '—'], ['Party bill date', b.party_bill_date ? String(b.party_bill_date).slice(0, 10) : '—'], ['Due date', b.due_date ? String(b.due_date).slice(0, 10) : '—'],
    ['Gate entry', b.gate_entry_no || '—'], ['GST', b.gst_type === 'INTER_STATE' ? 'IGST' : 'CGST + SGST'], ['Match', String(b.match_status ?? '—').replace('_', ' ').toLowerCase()]];
}
