import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { http, ApiError } from '../lib/api';
import { useLookup } from '../hooks/useLookup';
import { useToast } from '../hooks/useToast';
import { Button, Input, LoadingBlock } from './ui';
import { fmtDate, fmtDecimal } from '../lib/format';
import { type InvoiceCharges } from '../lib/invoiceCalc';
import { emptyPbHead, emptyPbCharges, pbTotals, pbPayload, pbHeadError, ProcessBillHeader, GrnPicker, MatchStrip, ProcessBillCharges, type PbHead } from './ProcessBillParts';

/**
 * Fabric / yarn process contractor bill editor — same flow as the purchase bill (client voice note 03-Oct-2026):
 * pick the contractor → map the gate entry → add GRNs (each brings its DC, party challan, vehicle, job, process,
 * input / good / reject / loss KG and the quotation rate) and approved reprocess / recovery → charges, GST, TDS / TCS,
 * round off → post. Bill qty is the GRN good KG; the rate defaults to the approved quotation (a change needs a reason).
 */
const n = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => `₹${fmtDecimal(n(v), 2)}`;
const kg = (v: unknown) => fmtDecimal(n(v), 3);
const errText = (e: unknown) => (e instanceof ApiError ? e.message : (e as any)?.message || 'Failed');

export function ContractorBillEditor({ kind, title, onBack, onDone }: { kind: 'fabric' | 'yarn'; title: ReactNode; onBack: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const suppliers = useLookup('suppliers');
  const base = kind === 'fabric' ? '/fabric-process' : '/yarn-process';
  const px = kind === 'fabric' ? 'fpb' : 'ypb';
  const [h, setHState] = useState<PbHead>(emptyPbHead('5'));
  const setH = (f: (x: PbHead) => PbHead) => setHState(f);
  const [charges, setChargesState] = useState<InvoiceCharges>(emptyPbCharges());
  const setCharges = (f: (c: InvoiceCharges) => InvoiceCharges) => setChargesState(f);
  const [range, setRange] = useState({ from: '', to: '', job: '' });
  const [picked, setPicked] = useState<string[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const src = useQuery({
    queryKey: [kind === 'fabric' ? 'fabric-process' : 'yarn-process', 'bill-sources', h.vendor_id, range.from, range.to],
    queryFn: async () => {
      const p = new URLSearchParams({ vendor_id: h.vendor_id });
      if (range.from) p.set('from', range.from);
      if (range.to) p.set('to', range.to);
      return (await http.get<{ data: any }>(`${base}/bill-sources?${p}`)).data;
    },
    enabled: !!h.vendor_id,
  });
  const all = useMemo(() => (src.data ? [
    ...src.data.grns.map((g: any) => ({ ...g, key: `GRN:${g.ref_id}` })),
    ...src.data.reprocess.map((x: any) => ({ ...x, key: `${x.line_type}:${x.ref_id}` })),
  ] : []) as any[], [src.data]);
  const visible = all.filter((r) => !range.job || String(r.io_no ?? '').toLowerCase().includes(range.job.toLowerCase()));
  const options = visible.map((r) => ({
    key: r.key,
    label: r.line_type === 'GRN'
      ? `${r.doc_no} · ${fmtDate(r.doc_date)} · ${r.dc_no ?? '—'} · ${r.process_name || r.sub_process || r.process_code} · ${r.io_no || 'no job'} · ${kg(r.qty_kg)} KG`
      : `${r.doc_no} · ${r.line_type === 'RECOVERY' ? 'Recovery' : 'Reprocess (billable)'} · ${r.io_no || ''} · ${money(r.bill_amount)}`,
  }));
  const lines = picked.map((k) => all.find((r) => r.key === k)).filter(Boolean) as any[];
  const rateOf = (r: any) => (r.line_type === 'GRN' ? n(rates[r.key]) : n(r.rate));
  const amountOf = (r: any) => (r.line_type === 'GRN' ? Math.round(n(r.qty_kg) * n(rates[r.key]) * 100) / 100 : n(r.bill_amount) * (r.line_type === 'RECOVERY' ? -1 : 1));
  const gross = lines.filter((l) => l.line_type !== 'RECOVERY').reduce((a, l) => a + amountOf(l), 0);
  const recovery = -lines.filter((l) => l.line_type === 'RECOVERY').reduce((a, l) => a + amountOf(l), 0);
  const totals = pbTotals(h, charges, gross, recovery);
  const rateDiffs = lines.filter((l) => l.line_type === 'GRN' && l.quotation_rate != null && Math.abs(n(l.quotation_rate) - n(rates[l.key])) > 0.005).map((l) => l.doc_no);
  const recoveriesLeft = all.filter((r) => r.line_type === 'RECOVERY' && !picked.includes(r.key));

  const add = (k: string) => {
    const r = all.find((x) => x.key === k); if (!r || picked.includes(k)) return;
    setPicked((p) => [...p, k]);
    if (r.line_type === 'GRN') setRates((x) => ({ ...x, [k]: x[k] ?? n(r.quotation_rate ?? r.last_rate) }));
  };
  const addAll = () => visible.forEach((r) => add(r.key));
  const remove = (k: string) => setPicked((p) => p.filter((x) => x !== k));

  const save = async () => {
    const err = pbHeadError(h, totals.base); if (err) { toast(err, 'warning'); return; }
    if (!lines.length) { toast('Add the GRNs / reprocess to bill', 'warning'); return; }
    const noRate = lines.find((l) => l.line_type === 'GRN' && !(n(rates[l.key]) > 0));
    if (noRate) { toast(`${noRate.doc_no}: enter the rate per KG`, 'warning'); return; }
    if (rateDiffs.length && h.rate_change_reason.trim().length < 3) { toast(`Rate differs from the approved quotation on ${rateDiffs.join(', ')} — give the reason`, 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>(`${base}/bills`, {
        ...pbPayload(h, charges, totals), from_date: range.from || null, to_date: range.to || null,
        lines: lines.map((l) => ({ line_type: l.line_type, ref_id: l.ref_id, rate: rateOf(l) })),
      });
      toast((r as any).message, 'success');
      void qc.invalidateQueries({ queryKey: [kind === 'fabric' ? 'fabric-process' : 'yarn-process'] });
      onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">{title}<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></div>
      <ProcessBillHeader h={h} setH={setH} suppliers={suppliers.data} vendorLabel="Contractor (process unit)" idPrefix={px} onVendorChange={() => { setPicked([]); setRates({}); }} />
      {h.vendor_id && (
        <>
          <div className="mb-2 flex flex-wrap items-end gap-3 text-xs">
            <Input label="GRNs from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <Input label="to" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            <Input label="Job (IO) filter" value={range.job} placeholder="IO no" onChange={(e) => setRange({ ...range, job: e.target.value })} />
          </div>
          {src.isLoading ? <LoadingBlock /> : <GrnPicker options={options} picked={picked} onAdd={add} onRemove={remove} onAddAll={addAll} idPrefix={px} noun="GRN / reprocess" />}
          {recoveriesLeft.length > 0 && picked.length > 0 && <p className="mb-2 rounded bg-red-50 px-3 py-1.5 text-xs text-red-800">Recovery pending from this contractor, not on the bill: {recoveriesLeft.map((r) => `${r.doc_no} (${money(r.bill_amount)})`).join(', ')}</p>}
          {lines.length > 0 && (
            <>
              <div className="card mb-3 overflow-x-auto">
                <table className="w-full text-xs" id={`${px}-lines`}>
                  <thead className="bg-slate-50 text-slate-500"><tr>{['Type', 'GRN / doc', 'Date', 'Our DC', 'Party challan', 'Vehicle', 'Gate', 'Job', 'Process', kind === 'fabric' ? 'Colour · rolls' : 'Lots', 'Sent KG', 'Good KG', 'Reject', 'Loss', 'Quotation', 'Rate / KG', 'Amount', ''].map((x, i) =>
                    <th key={i} className={`px-2 py-2 ${/KG|Reject|Loss|Rate|Amount/.test(x) ? 'text-right' : 'text-left'}`}>{x}</th>)}</tr></thead>
                  <tbody>
                    {lines.map((l) => {
                      const diff = l.line_type === 'GRN' && l.quotation_rate != null && Math.abs(n(l.quotation_rate) - n(rates[l.key])) > 0.005;
                      return (
                        <tr key={l.key} className="border-t border-slate-100" data-key={l.key}>
                          <td className="px-2 py-1"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${l.line_type === 'GRN' ? 'bg-sky-100 text-sky-800' : l.line_type === 'RECOVERY' ? 'bg-red-100 text-red-800' : 'bg-purple-100 text-purple-800'}`}>{l.line_type === 'REPROCESS' ? 'Reprocess' : l.line_type === 'RECOVERY' ? 'Recovery' : 'GRN'}</span></td>
                          <td className="px-2 py-1 font-mono">{l.doc_no}{l.grn_no && <span className="block text-[10px] text-slate-400">{l.grn_no}</span>}</td>
                          <td className="px-2 py-1">{fmtDate(l.doc_date)}</td><td className="px-2 py-1 font-mono">{l.dc_no ?? '—'}</td><td className="px-2 py-1">{l.challan_no || '—'}</td><td className="px-2 py-1">{l.vehicle_no || '—'}</td>
                          <td className="px-2 py-1">{l.gate_entry_no || '—'}</td><td className="px-2 py-1">{l.io_no || '—'}</td><td className="px-2 py-1">{l.process_name || l.sub_process || l.process_code}</td>
                          <td className="px-2 py-1">{kind === 'fabric' ? [l.colours, l.rolls ? `${l.rolls} rolls` : null].filter(Boolean).join(' · ') || '—' : l.lots || '—'}</td>
                          <td className="px-2 py-1 text-right">{l.input_kg != null ? kg(l.input_kg) : '—'}</td><td className="px-2 py-1 text-right font-semibold">{kg(l.qty_kg)}</td>
                          <td className="px-2 py-1 text-right">{l.reject_kg != null ? kg(l.reject_kg) : '—'}</td><td className="px-2 py-1 text-right">{l.loss_kg != null ? kg(l.loss_kg) : '—'}</td>
                          <td className="px-2 py-1">{l.line_type !== 'GRN' ? '—' : l.quotation_rate != null ? `${l.quotation_no ?? ''} ${money(l.quotation_rate)}` : <span className="text-amber-700">no quotation</span>}</td>
                          <td className="px-2 py-1 text-right">{l.line_type === 'GRN'
                            ? <input type="number" step="0.01" className={`input w-20 py-0.5 text-right text-xs ${diff ? 'border-amber-500 bg-amber-50' : ''}`} value={rates[l.key] ?? 0} id={`${px}-rate-${l.ref_id}`}
                                onChange={(e) => setRates((x) => ({ ...x, [l.key]: Number(e.target.value) }))} />
                            : money(l.rate)}</td>
                          <td className={`px-2 py-1 text-right font-semibold ${amountOf(l) < 0 ? 'text-red-700' : ''}`}>{money(amountOf(l))}</td>
                          <td className="px-1"><button type="button" className="text-slate-400 hover:text-rose-600" title="Remove" onClick={() => remove(l.key)}>✕</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 font-semibold"><tr><td colSpan={11} className="px-2 py-1 text-right">Total</td><td className="px-2 py-1 text-right">{kg(lines.filter((l) => l.line_type === 'GRN').reduce((a, l) => a + n(l.qty_kg), 0))}</td><td colSpan={4} /><td className="px-2 py-1 text-right">{money(gross - recovery)}</td><td /></tr></tfoot>
                </table>
              </div>
              {src.data && (src.data.excluded.length > 0 || src.data.pending_approval.length > 0) && (
                <div className="mb-3 text-[11.5px] text-slate-600">
                  {src.data.excluded.length > 0 && <div>Excluded (non-billable / internal / free): {src.data.excluded.map((x: any) => `${x.doc_no} ${kg(x.qty_kg)} KG`).join(' · ')}</div>}
                  {src.data.pending_approval.length > 0 && <div className="text-amber-700">Billable, waiting for billing approval: {src.data.pending_approval.map((x: any) => `${x.doc_no} (${money(x.bill_amount)})`).join(' · ')}</div>}
                </div>
              )}
              <MatchStrip grnCount={lines.filter((l) => l.line_type === 'GRN').length} rateDiffs={rateDiffs} gate={!!h.gate_inward_id} />
              <ProcessBillCharges h={h} setH={setH} charges={charges} setCharges={setCharges} totals={totals} gross={gross} recovery={recovery} rateChanged={rateDiffs.length > 0} idPrefix={px} />
              <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onBack}>Cancel</Button><Button loading={busy} onClick={save} id={`btn-${px}-post`}><CheckCircle2 size={14} className="mr-1" /> Post Bill</Button></div>
            </>
          )}
        </>
      )}
    </div>
  );
}
