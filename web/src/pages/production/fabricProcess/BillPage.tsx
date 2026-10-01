import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, CheckCircle2, Search, Ban } from 'lucide-react';
import { http } from '../../../lib/api';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { Button, Input, Select, Textarea, LoadingBlock } from '../../../components/ui';
import { fmtDate, fmtDecimal, today } from '../../../lib/format';
import { FpTitle, FpStatus, errText, kg, n } from './shared';

/**
 * Fabric Process — Contractor bill (doc §27, §33): GRN good KG × rate + approved billable reprocess
 * − recovery from contractor. Non-billable / internal / free reprocess is shown as excluded and can
 * never be billed. Cancelling a bill releases its GRNs / reprocess for billing again.
 */
const money = (v: unknown) => `₹${fmtDecimal(n(v), 2)}`;

export default function FabricProcessBillPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  if (id === 'new') return <BillEditor onBack={() => setParams({})} onDone={(x) => setParams({ id: String(x) })} />;
  if (id) return <BillView id={Number(id)} onBack={() => setParams({})} />;
  return <BillList onOpen={(x) => setParams({ id: String(x) })} />;
}

function BillList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const list = useQuery({ queryKey: ['fabric-process', 'bills'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/bills')).data ?? [] });
  return (
    <div>
      <FpTitle no={6} title="Contractor Bill (Fabric Process)" sub="GRN charges + billable reprocess − recovery" actions={<Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Bill</Button>} />
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Bill no', 'Date', 'Supplier / Vendor', 'Party bill', 'Lines', 'Gross', 'Recovery', 'GST', 'Net', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/Gross|Recovery|GST|Net|Lines/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((b) => (
                <tr key={b.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(b.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{b.bill_no}</td><td className="px-3 py-2">{fmtDate(b.bill_date)}</td><td className="px-3 py-2">{b.vendor_name}</td>
                  <td className="px-3 py-2">{b.party_bill_no || '—'}</td><td className="px-3 py-2 text-right">{b.line_count}</td><td className="px-3 py-2 text-right">{money(b.gross_amount)}</td>
                  <td className="px-3 py-2 text-right text-red-700">{n(b.recovery_amount) ? `− ${money(b.recovery_amount)}` : '—'}</td><td className="px-3 py-2 text-right">{money(b.gst_amount)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{money(b.net_amount)}</td><td className="px-3 py-2"><FpStatus value={b.status} /></td>
                </tr>
              ))}
              {!(list.data ?? []).length && <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">No contractor bills yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function BillEditor({ onBack, onDone }: { onBack: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const suppliers = useLookup('suppliers');
  const [head, setHead] = useState({ vendor_id: '', bill_date: today(), party_bill_no: '', from_date: '', to_date: '', discount_amount: 0, other_charges: 0, gst_pct: 5, remarks: '' });
  const [loaded, setLoaded] = useState<any>(null);
  const [pick, setPick] = useState<Record<string, { on: boolean; rate: number }>>({});
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (!head.vendor_id) { toast('Choose the contractor', 'warning'); return; }
    try {
      const p = new URLSearchParams({ vendor_id: head.vendor_id });
      if (head.from_date) p.set('from', head.from_date);
      if (head.to_date) p.set('to', head.to_date);
      const r = (await http.get<{ data: any }>(`/fabric-process/bill-sources?${p}`)).data;
      setLoaded(r);
      const init: Record<string, { on: boolean; rate: number }> = {};
      r.grns.forEach((g: any) => { init[`GRN:${g.ref_id}`] = { on: true, rate: n(g.last_rate) }; });
      r.reprocess.forEach((x: any) => { init[`${x.line_type}:${x.ref_id}`] = { on: true, rate: n(x.rate) }; });
      setPick(init);
    } catch (e) { toast(errText(e), 'error'); }
  };
  const lines = loaded ? [
    ...loaded.grns.map((g: any) => ({ ...g, key: `GRN:${g.ref_id}`, amount: n(g.qty_kg) * n(pick[`GRN:${g.ref_id}`]?.rate) })),
    ...loaded.reprocess.map((x: any) => ({ ...x, key: `${x.line_type}:${x.ref_id}`, amount: n(x.bill_amount) * (x.line_type === 'RECOVERY' ? -1 : 1) })),
  ] : [];
  const on = lines.filter((l: any) => pick[l.key]?.on);
  const gross = on.filter((l: any) => l.line_type !== 'RECOVERY').reduce((a: number, l: any) => a + l.amount, 0);
  const recovery = -on.filter((l: any) => l.line_type === 'RECOVERY').reduce((a: number, l: any) => a + l.amount, 0);
  const taxable = gross - recovery - n(head.discount_amount) + n(head.other_charges);
  const gst = taxable * n(head.gst_pct) / 100;
  const save = async () => {
    if (!on.length) { toast('Tick the GRNs / reprocess to bill', 'warning'); return; }
    const noRate = on.find((l: any) => l.line_type === 'GRN' && !(n(pick[l.key]?.rate) > 0));
    if (noRate) { toast(`${noRate.doc_no}: enter the rate per KG`, 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/fabric-process/bills', {
        ...head, vendor_id: Number(head.vendor_id), from_date: head.from_date || null, to_date: head.to_date || null,
        lines: on.map((l: any) => ({ line_type: l.line_type, ref_id: l.ref_id, rate: n(pick[l.key]?.rate) })),
      });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['fabric-process'] }); onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div>
      <FpTitle no={6} title="New Contractor Bill" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 items-end gap-3 p-4 md:grid-cols-6">
        <Select label="Contractor (Supplier / Vendor) *" value={head.vendor_id} placeholder="—" onChange={(e) => { setHead({ ...head, vendor_id: e.target.value }); setLoaded(null); }} options={toOptions(suppliers.data)} />
        <Input label="Bill date *" type="date" value={head.bill_date} onChange={(e) => setHead({ ...head, bill_date: e.target.value })} />
        <Input label="Contractor bill no" value={head.party_bill_no} onChange={(e) => setHead({ ...head, party_bill_no: e.target.value })} />
        <Input label="From date" type="date" value={head.from_date} onChange={(e) => setHead({ ...head, from_date: e.target.value })} />
        <Input label="To date" type="date" value={head.to_date} onChange={(e) => setHead({ ...head, to_date: e.target.value })} />
        <Button onClick={load}><Search size={14} className="mr-1" /> Load GRNs / reprocess</Button>
      </div>
      {loaded && (
        <>
          <div className="card mb-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Type', 'Doc no', 'Date', 'Job', 'Process', 'Qty KG', 'Rate / KG', 'Amount'].map((h, i) => <th key={i} className={`px-2 py-2 ${/KG|Rate|Amount/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
              <tbody>
                {lines.map((l: any) => (
                  <tr key={l.key} className="border-t border-slate-100">
                    <td className="px-2 py-1"><input type="checkbox" checked={!!pick[l.key]?.on} onChange={(e) => setPick((p) => ({ ...p, [l.key]: { ...p[l.key], on: e.target.checked } }))} /></td>
                    <td className="px-2 py-1"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${l.line_type === 'GRN' ? 'bg-sky-100 text-sky-800' : l.line_type === 'RECOVERY' ? 'bg-red-100 text-red-800' : 'bg-purple-100 text-purple-800'}`}>{l.line_type === 'REPROCESS' ? 'Reprocess (billable)' : l.line_type === 'RECOVERY' ? 'Recovery' : 'GRN'}</span></td>
                    <td className="px-2 py-1 font-mono">{l.doc_no}</td><td className="px-2 py-1">{fmtDate(l.doc_date)}</td><td className="px-2 py-1">{l.io_no || '—'}</td><td className="px-2 py-1">{l.process_name || l.sub_process}</td>
                    <td className="px-2 py-1 text-right">{kg(l.qty_kg)}</td>
                    <td className="px-2 py-1 text-right">{l.line_type === 'GRN'
                      ? <input type="number" step="0.01" className="input w-24 py-0.5 text-right text-xs" value={pick[l.key]?.rate ?? 0} onChange={(e) => setPick((p) => ({ ...p, [l.key]: { ...p[l.key], rate: Number(e.target.value) } }))} />
                      : money(l.rate)}</td>
                    <td className={`px-2 py-1 text-right font-semibold ${l.amount < 0 ? 'text-red-700' : ''}`}>{money(l.amount)}</td>
                  </tr>
                ))}
                {!lines.length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Nothing to bill for this contractor</td></tr>}
              </tbody>
            </table>
          </div>
          {(loaded.excluded.length > 0 || loaded.pending_approval.length > 0) && (
            <div className="card mb-3 p-3 text-xs text-slate-600">
              {loaded.excluded.length > 0 && <p><b>Excluded (non-billable / internal / free):</b> {loaded.excluded.map((x: any) => `${x.doc_no} ${kg(x.qty_kg)} KG`).join(' · ')} — total {kg(loaded.excluded.reduce((a: number, x: any) => a + n(x.qty_kg), 0))} KG</p>}
              {loaded.pending_approval.length > 0 && <p className="mt-1 text-amber-700"><b>Billable, waiting for billing approval:</b> {loaded.pending_approval.map((x: any) => `${x.doc_no} (${money(x.bill_amount)})`).join(' · ')}</p>}
            </div>
          )}
          <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
            <Input label="Less: discount (₹)" type="number" value={head.discount_amount} onChange={(e) => setHead({ ...head, discount_amount: Number(e.target.value) })} />
            <Input label="Add: other charges (₹)" type="number" value={head.other_charges} onChange={(e) => setHead({ ...head, other_charges: Number(e.target.value) })} />
            <Input label="GST %" type="number" value={head.gst_pct} onChange={(e) => setHead({ ...head, gst_pct: Number(e.target.value) })} />
            <Textarea label="Remarks" className="col-span-2 md:col-span-3" rows={1} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
            <div className="col-span-2 md:col-span-6 flex flex-wrap justify-end gap-6 text-sm">
              <span>Gross <b>{money(gross)}</b></span>{recovery > 0 && <span className="text-red-700">Recovery <b>− {money(recovery)}</b></span>}
              <span>Taxable <b>{money(taxable)}</b></span><span>GST <b>{money(gst)}</b></span><span className="text-lg">Net <b>{money(taxable + gst)}</b></span>
            </div>
          </div>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onBack}>Cancel</Button><Button loading={busy} onClick={save}><CheckCircle2 size={14} className="mr-1" /> Post Bill</Button></div>
        </>
      )}
    </div>
  );
}

function BillView({ id, onBack }: { id: number; onBack: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['fabric-process', 'bills', id], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/bills/${id}`)).data });
  const b = q.data;
  if (!b) return <LoadingBlock />;
  const cancel = async () => {
    const reason = window.prompt(`Cancel ${b.bill_no}? Reason:`);
    if (!reason) return;
    try { const r = await http.post(`/fabric-process/bills/${id}/cancel`, { reason }); toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['fabric-process'] }); } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <div>
      <FpTitle no={6} title={`Contractor Bill — ${b.bill_no}`} sub={`${b.vendor_name} · ${fmtDate(b.bill_date)}${b.party_bill_no ? ` · party bill ${b.party_bill_no}` : ''}`}
        actions={<><FpStatus value={b.status} />{b.status === 'POSTED' && <Button variant="danger" onClick={cancel}><Ban size={14} className="mr-1" /> Cancel bill</Button>}<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Type', 'Doc no', 'Date', 'Job', 'Process', 'Qty KG', 'Rate', 'Amount'].map((h) => <th key={h} className={`px-2 py-2 ${/KG|Rate|Amount/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{b.lines.map((l: any) => <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1">{l.line_type}</td><td className="px-2 py-1 font-mono">{l.doc_no}</td><td className="px-2 py-1">{fmtDate(l.doc_date)}</td><td className="px-2 py-1">{l.io_no || '—'}</td><td className="px-2 py-1">{l.sub_process}</td><td className="px-2 py-1 text-right">{kg(l.qty_kg)}</td><td className="px-2 py-1 text-right">{money(l.rate)}</td><td className={`px-2 py-1 text-right ${n(l.amount) < 0 ? 'text-red-700' : ''}`}>{money(l.amount)}</td></tr>)}</tbody>
          <tfoot className="bg-slate-50 text-right font-semibold">
            <tr><td colSpan={7} className="px-2 py-1">Gross</td><td className="px-2 py-1">{money(b.gross_amount)}</td></tr>
            {n(b.recovery_amount) > 0 && <tr><td colSpan={7} className="px-2 py-1 text-red-700">Less recovery</td><td className="px-2 py-1 text-red-700">− {money(b.recovery_amount)}</td></tr>}
            <tr><td colSpan={7} className="px-2 py-1">Less discount / add other</td><td className="px-2 py-1">− {money(b.discount_amount)} / + {money(b.other_charges)}</td></tr>
            <tr><td colSpan={7} className="px-2 py-1">GST {fmtDecimal(b.gst_pct, 2)}%</td><td className="px-2 py-1">{money(b.gst_amount)}</td></tr>
            <tr className="text-sm"><td colSpan={7} className="px-2 py-2">Net amount</td><td className="px-2 py-2">{money(b.net_amount)}</td></tr>
          </tfoot>
        </table>
      </div>
      {b.remarks && <pre className="card mt-3 whitespace-pre-wrap p-3 text-[11px] text-slate-600">{b.remarks}</pre>}
    </div>
  );
}
