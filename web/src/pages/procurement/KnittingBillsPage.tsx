import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, XCircle } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useLookup } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { Button, LoadingBlock } from '../../components/ui';
import { emptyPbHead, emptyPbCharges, pbTotals, pbPayload, pbHeadError, ProcessBillHeader, GrnPicker, MatchStrip, ProcessBillCharges, ProcessBillTotalsView, processBillFacts, type PbHead } from '../../components/ProcessBillParts';
import { type InvoiceCharges } from '../../lib/invoiceCalc';
import { fmtDate, fmtDecimal } from '../../lib/format';

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
  const [h, setHState] = useState<PbHead>(emptyPbHead('5'));
  const setH = (f: (x: PbHead) => PbHead) => setHState(f);
  const [charges, setChargesState] = useState<InvoiceCharges>(emptyPbCharges());
  const [sel, setSel] = useState<Record<string, number>>({});   // receipt_id → rate, in the order added
  const [order, setOrder] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const src = useQuery({
    queryKey: ['knitting-bill-sources', h.vendor_id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/knitting-bill-sources?vendor_id=${h.vendor_id}`)).data ?? [],
    enabled: !!h.vendor_id,
  });
  const rows = src.data ?? [];
  const picked = order.map((k) => rows.find((r) => String(r.receipt_id) === k)).filter(Boolean) as any[];
  const gross = picked.reduce((a, r) => a + Math.round(n(r.fabric_kg) * n(sel[r.receipt_id]) * 100) / 100, 0);
  const totals = pbTotals(h, charges, gross);
  const changed = picked.filter((r) => r.quotation_rate != null && Math.abs(n(r.quotation_rate) - n(sel[r.receipt_id])) > 0.005);
  const add = (k: string) => { const r = rows.find((x) => String(x.receipt_id) === k); if (!r || order.includes(k)) return; setOrder((o) => [...o, k]); setSel((s) => ({ ...s, [k]: s[k] ?? n(r.quotation_rate) })); };
  const remove = (k: string) => setOrder((o) => o.filter((x) => x !== k));
  const options = rows.map((r) => ({ key: String(r.receipt_id), label: `${r.receipt_no} · ${fmtDate(r.receipt_date)} · ${r.program_no} · ${r.io_no || 'no job'} · DC ${r.dc_nos || '—'} · ${fmtDecimal(r.fabric_kg, 3)} KG` }));

  const save = async () => {
    const err = pbHeadError(h, totals.base); if (err) { toast(err, 'warning'); return; }
    if (!picked.length) { toast('Add the knitting GRNs to bill', 'warning'); return; }
    const noRate = picked.find((r) => !(n(sel[r.receipt_id]) > 0));
    if (noRate) { toast(`${noRate.receipt_no}: enter the rate per KG`, 'warning'); return; }
    if (changed.length && h.rate_change_reason.trim().length < 3) { toast(`Rate differs from the approved quotation on ${changed.map((r) => r.receipt_no).join(', ')} — give the reason`, 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/knitting-bills', {
        ...pbPayload(h, charges, totals),
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
      <ProcessBillHeader h={h} setH={setH} suppliers={suppliers.data} vendorLabel="Knitter (job-work unit)" idPrefix="kb" onVendorChange={() => { setSel({}); setOrder([]); }} />
      {h.vendor_id && (src.isLoading ? <LoadingBlock /> : <GrnPicker options={options} picked={order} onAdd={add} onRemove={remove} onAddAll={() => rows.forEach((r) => add(String(r.receipt_id)))} idPrefix="kb" noun="knitting GRN" />)}
      {picked.length > 0 && (
        <>
          <div className="card mb-3 overflow-x-auto">
            <table className="w-full text-xs" id="kb-lines">
              <thead className="bg-slate-50 text-slate-500"><tr>{['Knitting GRN', 'Date', 'Program', 'Job', 'Fabric', 'Our DC(s)', 'Party DC', 'Gate', 'Receipt', 'Rolls', 'Fabric KG', 'Reject', 'Loss', 'Quotation', 'Rate / KG', 'Amount', ''].map((x, i) => <th key={i} className={`px-2 py-2 ${/KG|Reject|Loss|Rate|Amount|Rolls/.test(x) ? 'text-right' : 'text-left'}`}>{x}</th>)}</tr></thead>
              <tbody>
                {picked.map((r) => {
                  const diff = r.quotation_rate != null && Math.abs(n(r.quotation_rate) - n(sel[r.receipt_id])) > 0.005;
                  return (
                    <tr key={r.receipt_id} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-mono">{r.receipt_no}{r.grn_no && <span className="block text-[10px] text-slate-400">{r.grn_no}</span>}</td><td className="px-2 py-1">{fmtDate(r.receipt_date)}</td>
                      <td className="px-2 py-1">{r.program_no}</td><td className="px-2 py-1">{r.io_no || '—'}</td><td className="px-2 py-1">{[r.fabric_type, r.fabric_colour].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="px-2 py-1 font-mono">{r.dc_nos || '—'}</td><td className="px-2 py-1">{r.party_dc_no || '—'}</td><td className="px-2 py-1">{r.gate_entry_no ? `${r.gate_entry_no}${r.vehicle_no ? ` · ${r.vehicle_no}` : ''}` : '—'}</td>
                      <td className="px-2 py-1">{r.receipt_type === 'FINAL' ? 'Final' : 'Partial'}</td><td className="px-2 py-1 text-right">{r.rolls || '—'}</td>
                      <td className="px-2 py-1 text-right font-semibold">{fmtDecimal(r.fabric_kg, 3)}</td><td className="px-2 py-1 text-right">{fmtDecimal(r.reject_kg, 3)}</td><td className="px-2 py-1 text-right">{fmtDecimal(r.loss_kg, 3)}</td>
                      <td className="px-2 py-1">{r.quotation_no ? `${r.quotation_no} · ${money(r.quotation_rate)}` : <span className="text-amber-700">no quotation</span>}</td>
                      <td className="px-2 py-1 text-right"><input type="number" step="0.01" className={`input w-20 py-0.5 text-right text-xs ${diff ? 'border-amber-500 bg-amber-50' : ''}`} value={sel[r.receipt_id]} id={`kb-rate-${r.receipt_id}`}
                        onChange={(e) => setSel((s) => ({ ...s, [r.receipt_id]: Number(e.target.value) }))} /></td>
                      <td className="px-2 py-1 text-right font-semibold">{money(n(r.fabric_kg) * n(sel[r.receipt_id]))}</td>
                      <td className="px-1"><button type="button" className="text-slate-400 hover:text-rose-600" title="Remove" onClick={() => remove(String(r.receipt_id))}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <MatchStrip grnCount={picked.length} rateDiffs={changed.map((r) => r.receipt_no)} gate={!!h.gate_inward_id} />
          <ProcessBillCharges h={h} setH={setH} charges={charges} setCharges={setChargesState} totals={totals} gross={gross} rateChanged={changed.length > 0} idPrefix="kb" />
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onBack}>Cancel</Button><Button loading={busy} onClick={save} id="btn-save-knit-bill">Post bill</Button></div>
        </>
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
        {([['Knitter', b.vendor_name], ['Bill date', fmtDate(b.bill_date)], ...processBillFacts(b)] as [string, unknown][]).map(([k, v]) => (
          <div key={k}><div className="text-slate-500">{k}</div><div className="font-semibold">{String(v)}</div></div>
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
        <div className="border-t border-slate-100 p-3"><ProcessBillTotalsView b={b} /></div>
      </div>
      {b.remarks && <pre className="card mt-3 whitespace-pre-wrap p-3 text-[11px] text-slate-600">{b.remarks}</pre>}
    </div>
  );
}
