import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, XCircle } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useLookup } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { Button, Input, Select, Textarea, LoadingBlock } from '../../components/ui';
import { GateEntryPicker } from '../../components/ProcessPickers';
import { fmtDate, fmtDecimal, today } from '../../lib/format';

/**
 * Knitting job-work bill (Full_Knitting_Module_Developer_Document §22; client voice note 02-Oct-2026):
 * one bill from many knitting GRNs of a knitter — grey fabric KG × the approved quotation rate of the
 * knitting DC. A rate different from the quotation needs a reason. Lives inside Bills Inward.
 */
const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as any)?.message || 'Failed');
const n = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => `₹${fmtDecimal(n(v), 2)}`;

export default function KnittingBillsPage() {
  const [view, setView] = useState<null | 'new' | number>(null);
  if (view === 'new') return <KnittingBillEditor onBack={() => setView(null)} onDone={(id) => setView(id)} />;
  if (typeof view === 'number') return <KnittingBillView id={view} onBack={() => setView(null)} />;
  return <KnittingBillList onOpen={setView} />;
}

function KnittingBillList({ onOpen }: { onOpen: (v: 'new' | number) => void }) {
  const { can } = useAuth() as any;
  const list = useQuery({ queryKey: ['knitting-bills'], queryFn: async () => (await http.get<{ data: any[] }>('/knitting-bills')).data ?? [] });
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-slate-800">Knitting job-work bills</h2>
          <p className="text-xs text-slate-500">Bill the knitter from the knitting GRNs (grey fabric KG × approved quotation rate)</p>
        </div>
        {(can('PURCHASE.CREATE') || can('PRODUCTION.CREATE')) && <Button onClick={() => onOpen('new')} id="btn-new-knit-bill"><Plus size={14} className="mr-1" /> New Knitting Bill</Button>}
      </div>
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Bill no', 'Date', 'Knitter', 'Party bill', 'GRNs', 'Fabric KG', 'Gross', 'GST', 'Net', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|Gross|GST|Net|GRNs/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((b) => (
                <tr key={b.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(Number(b.id))}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{b.bill_no}</td><td className="px-3 py-2">{fmtDate(b.bill_date)}</td>
                  <td className="px-3 py-2">{b.vendor_name}</td><td className="px-3 py-2">{b.party_bill_no || '—'}</td>
                  <td className="px-3 py-2 text-right">{b.line_count}</td><td className="px-3 py-2 text-right">{fmtDecimal(b.fabric_kg, 3)}</td>
                  <td className="px-3 py-2 text-right">{money(b.gross_amount)}</td><td className="px-3 py-2 text-right">{money(b.gst_amount)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{money(b.net_amount)}</td>
                  <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${b.status === 'CANCELLED' ? 'bg-slate-200 text-slate-600' : 'bg-emerald-100 text-emerald-800'}`}>{b.status}</span></td>
                </tr>
              ))}
              {!(list.data ?? []).length && <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">No knitting bills yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function KnittingBillEditor({ onBack, onDone }: { onBack: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const suppliers = useLookup('suppliers');
  const [h, setH] = useState({ vendor_id: '', bill_date: today(), party_bill_no: '', gate_inward_id: '', discount_amount: '', debit_amount: '', other_charges: '', gst_pct: '5', rate_change_reason: '', remarks: '' });
  const [sel, setSel] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const src = useQuery({
    queryKey: ['knitting-bill-sources', h.vendor_id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/knitting-bill-sources?vendor_id=${h.vendor_id}`)).data ?? [],
    enabled: !!h.vendor_id,
  });
  const rows = src.data ?? [];
  const picked = rows.filter((r) => sel[r.receipt_id] !== undefined);
  const gross = picked.reduce((a, r) => a + n(r.fabric_kg) * n(sel[r.receipt_id]), 0);
  const taxable = gross - n(h.discount_amount) - n(h.debit_amount) + n(h.other_charges);
  const gst = taxable * n(h.gst_pct) / 100;
  const changed = picked.filter((r) => r.quotation_rate != null && Math.abs(n(r.quotation_rate) - n(sel[r.receipt_id])) > 0.005);
  const toggle = (r: any) => setSel((s) => { const x = { ...s }; if (x[r.receipt_id] !== undefined) delete x[r.receipt_id]; else x[r.receipt_id] = n(r.quotation_rate); return x; });

  const save = async () => {
    if (!picked.length) { toast('Tick the knitting GRNs to bill', 'warning'); return; }
    const noRate = picked.find((r) => !(n(sel[r.receipt_id]) > 0));
    if (noRate) { toast(`${noRate.receipt_no}: enter the rate per KG`, 'warning'); return; }
    if (changed.length && h.rate_change_reason.trim().length < 3) { toast(`Rate differs from the approved quotation on ${changed.map((r) => r.receipt_no).join(', ')} — give the reason`, 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/knitting-bills', {
        vendor_id: Number(h.vendor_id), bill_date: h.bill_date, party_bill_no: h.party_bill_no || null, gate_inward_id: h.gate_inward_id ? Number(h.gate_inward_id) : null,
        discount_amount: n(h.discount_amount), debit_amount: n(h.debit_amount), other_charges: n(h.other_charges), gst_pct: n(h.gst_pct),
        rate_change_reason: h.rate_change_reason || null, remarks: h.remarks || null,
        lines: picked.map((x) => ({ receipt_id: Number(x.receipt_id), rate: n(sel[x.receipt_id]) })),
      });
      toast((r as any).message, 'success');
      void qc.invalidateQueries({ queryKey: ['knitting-bills'] }); void qc.invalidateQueries({ queryKey: ['knitting-bill-sources'] });
      onDone(Number(r.data.id));
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-800">New knitting job-work bill</h2>
        <Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>
      </div>
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Select label="Knitter (job-work unit) *" value={h.vendor_id} placeholder="— Knitter —" id="kb-vendor"
          onChange={(e) => { setH({ ...h, vendor_id: e.target.value, gate_inward_id: '' }); setSel({}); }}
          options={(suppliers.data ?? []).map((s: any) => ({ value: String(s.id), label: s.label }))} />
        <Input label="Bill date *" type="date" value={h.bill_date} onChange={(e) => setH({ ...h, bill_date: e.target.value })} />
        <Input label="Knitter's bill no" value={h.party_bill_no} id="kb-party-bill" onChange={(e) => setH({ ...h, party_bill_no: e.target.value })} />
        <div className="col-span-2 md:col-span-3">
          <GateEntryPicker partyId={h.vendor_id} value={h.gate_inward_id} idPrefix="kb" onChange={(v) => setH((x) => ({ ...x, gate_inward_id: v }))}
            onPick={(g) => setH((x) => ({ ...x, gate_inward_id: String(g.id), party_bill_no: x.party_bill_no || g.supplier_inv_no || '' }))} />
        </div>
      </div>

      {h.vendor_id && (
        <div className="card mb-3 overflow-x-auto">
          {src.isLoading ? <LoadingBlock /> : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Knitting GRN', 'Date', 'Program', 'Job', 'Our DC(s)', 'Receipt', 'Fabric KG', 'Quotation', 'Rate / KG', 'Amount'].map((x, i) => <th key={i} className={`px-2 py-2 ${/KG|Rate|Amount/.test(x) ? 'text-right' : 'text-left'}`}>{x}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => {
                  const on = sel[r.receipt_id] !== undefined;
                  const diff = on && r.quotation_rate != null && Math.abs(n(r.quotation_rate) - n(sel[r.receipt_id])) > 0.005;
                  return (
                    <tr key={r.receipt_id} className="border-t border-slate-100">
                      <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => toggle(r)} id={`kb-pick-${r.receipt_id}`} /></td>
                      <td className="px-2 py-1 font-mono">{r.receipt_no}</td><td className="px-2 py-1">{fmtDate(r.receipt_date)}</td>
                      <td className="px-2 py-1">{r.program_no}</td><td className="px-2 py-1">{r.io_no || '—'}</td><td className="px-2 py-1 font-mono">{r.dc_nos || '—'}</td>
                      <td className="px-2 py-1">{r.receipt_type === 'FINAL' ? 'Final' : 'Partial'}</td>
                      <td className="px-2 py-1 text-right">{fmtDecimal(r.fabric_kg, 3)}</td>
                      <td className="px-2 py-1">{r.quotation_no ? `${r.quotation_no} · ${money(r.quotation_rate)}` : <span className="text-amber-700">no quotation</span>}</td>
                      <td className="px-2 py-1 text-right">{on
                        ? <input type="number" step="0.01" className={`input w-20 py-0.5 text-right text-xs ${diff ? 'border-amber-500 bg-amber-50' : ''}`} value={sel[r.receipt_id]} id={`kb-rate-${r.receipt_id}`}
                            onChange={(e) => setSel((s) => ({ ...s, [r.receipt_id]: Number(e.target.value) }))} />
                        : '—'}</td>
                      <td className="px-2 py-1 text-right font-semibold">{on ? money(n(r.fabric_kg) * n(sel[r.receipt_id])) : '—'}</td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">No unbilled knitting GRNs for this knitter</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      )}

      {picked.length > 0 && (
        <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
          <Input label="Less: discount (₹)" type="number" value={h.discount_amount} onChange={(e) => setH({ ...h, discount_amount: e.target.value })} />
          <Input label="Less: debit / shortage (₹)" type="number" value={h.debit_amount} onChange={(e) => setH({ ...h, debit_amount: e.target.value })} />
          <Input label="Add: other charges (₹)" type="number" value={h.other_charges} onChange={(e) => setH({ ...h, other_charges: e.target.value })} />
          <Input label="GST %" type="number" value={h.gst_pct} onChange={(e) => setH({ ...h, gst_pct: e.target.value })} />
          <Textarea label="Remarks" className="col-span-2" rows={1} value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
          {changed.length > 0 && <Input label="Reason for rate change from quotation *" className="col-span-2 md:col-span-6" value={h.rate_change_reason} id="kb-rate-reason" onChange={(e) => setH({ ...h, rate_change_reason: e.target.value })} />}
          <div className="col-span-2 flex flex-wrap items-center justify-end gap-6 text-sm md:col-span-6">
            <span>Gross <b>{money(gross)}</b></span><span>Taxable <b>{money(taxable)}</b></span><span>GST <b>{money(gst)}</b></span>
            <span className="text-lg">Net <b>{money(taxable + gst)}</b></span>
            <Button loading={busy} onClick={save} id="btn-save-knit-bill">Post bill</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function KnittingBillView({ id, onBack }: { id: number; onBack: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth() as any;
  const q = useQuery({ queryKey: ['knitting-bills', id], queryFn: async () => (await http.get<{ data: any }>(`/knitting-bills/${id}`)).data });
  const b = q.data;
  const cancel = async () => {
    const reason = window.prompt(`Cancel ${b.bill_no}? Reason:`);
    if (!reason) return;
    try {
      const r = await http.post<{ message: string }>(`/knitting-bills/${id}/cancel`, { reason });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['knitting-bills'] }); void qc.invalidateQueries({ queryKey: ['knitting-bill-sources'] });
    } catch (e) { toast(errText(e), 'error'); }
  };
  if (!b) return <LoadingBlock />;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-800">Knitting bill {b.bill_no} <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${b.status === 'CANCELLED' ? 'bg-slate-200' : 'bg-emerald-100 text-emerald-800'}`}>{b.status}</span></h2>
        <div className="flex gap-2">
          {b.status !== 'CANCELLED' && (can('PURCHASE.DELETE') || can('PURCHASE.APPROVE') || can('PRODUCTION.APPROVE')) && <Button variant="secondary" onClick={cancel}><XCircle size={14} className="mr-1" /> Cancel bill</Button>}
          <Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>
        </div>
      </div>
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 text-xs md:grid-cols-6">
        {[['Knitter', b.vendor_name], ['Bill date', fmtDate(b.bill_date)], ['Knitter bill no', b.party_bill_no || '—'], ['Gate entry', b.gate_entry_no || '—'], ['Gross', money(b.gross_amount)], ['Net', money(b.net_amount)]].map(([k, v]) => (
          <div key={k}><div className="text-slate-500">{k}</div><div className="font-semibold">{v}</div></div>
        ))}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['GRN', 'Date', 'Program', 'Job', 'DC(s)', 'Fabric KG', 'Quotation rate', 'Rate', 'Amount'].map((x) => <th key={x} className={`px-2 py-2 ${/KG|rate|Rate|Amount/.test(x) ? 'text-right' : 'text-left'}`}>{x}</th>)}</tr></thead>
          <tbody>{(b.lines ?? []).map((l: any) => (
            <tr key={l.id} className="border-t border-slate-100">
              <td className="px-2 py-1 font-mono">{l.receipt_no}</td><td className="px-2 py-1">{fmtDate(l.receipt_date)}</td><td className="px-2 py-1">{l.program_no}</td><td className="px-2 py-1">{l.io_no || '—'}</td>
              <td className="px-2 py-1 font-mono">{l.dc_nos || '—'}</td><td className="px-2 py-1 text-right">{fmtDecimal(l.fabric_kg, 3)}</td>
              <td className="px-2 py-1 text-right">{l.quotation_rate != null ? money(l.quotation_rate) : '—'}</td>
              <td className={`px-2 py-1 text-right ${l.quotation_rate != null && Math.abs(n(l.quotation_rate) - n(l.rate)) > 0.005 ? 'font-semibold text-amber-700' : ''}`}>{money(l.rate)}</td>
              <td className="px-2 py-1 text-right font-semibold">{money(l.amount)}</td>
            </tr>
          ))}</tbody>
        </table>
        <div className="flex flex-wrap justify-end gap-6 border-t border-slate-100 p-3 text-sm">
          <span>Discount {money(b.discount_amount)}</span><span>Debit {money(b.debit_amount)}</span><span>Other {money(b.other_charges)}</span>
          <span>GST {fmtDecimal(b.gst_pct, 2)}% = {money(b.gst_amount)}</span><span className="text-base">Net <b>{money(b.net_amount)}</b></span>
        </div>
      </div>
      {b.remarks && <pre className="card mt-3 whitespace-pre-wrap p-3 text-[11px] text-slate-600">{b.remarks}</pre>}
    </div>
  );
}
