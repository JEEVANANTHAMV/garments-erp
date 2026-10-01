import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { http } from '../../../lib/api';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { Button, Input, Select, Tabs, LoadingBlock } from '../../../components/ui';
import { fmtDate, fmtDecimal } from '../../../lib/format';
import { FpTitle, FpStatus, useProcessTypes, errText, kg, n } from './shared';

/** Fabric Process — Roll Tracking (doc §9): chronological history of a roll and the rolls made from it. */
const EVENT_LABEL: Record<string, string> = {
  GRN: 'GRN (receipt)', PROCESS_OUTWARD: 'Process outward', PROCESS_INWARD: 'Process inward', REJECT: 'Reject', PROCESS_LOSS: 'Process loss', RETURN: 'Return',
  REPROCESS_OUTWARD: 'Reprocess outward', REPROCESS_INWARD: 'Reprocess inward', DC_CANCELLED: 'DC cancelled', ISSUE_TO_CUTTING: 'Issued to cutting',
};
export function FabricRollTrackingPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('roll') ?? '');
  const roll = params.get('roll');
  const h = useQuery({ queryKey: ['fabric-process', 'roll-history', roll], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/roll-history?roll_no=${encodeURIComponent(roll!)}`)).data, enabled: !!roll, retry: false });
  const d = h.data;
  return (
    <div>
      <FpTitle no={7} title="Roll Tracking / Roll History" sub="Fabric store → process outward → process unit → GRN → return / reprocess → processed store → cutting" />
      <div className="card mb-3 flex flex-wrap items-end gap-2 p-4">
        <Input label="Roll no" className="w-64" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) setParams({ roll: q.trim() }); }} />
        <Button onClick={() => q.trim() && setParams({ roll: q.trim() })}><Search size={14} className="mr-1" /> Search</Button>
      </div>
      {roll && h.isLoading && <LoadingBlock />}
      {h.error && <div className="card p-6 text-sm text-red-700">{errText(h.error)}</div>}
      {d && (
        <>
          <div className="card mb-3 grid grid-cols-2 gap-3 p-4 text-xs md:grid-cols-8">
            {[['Roll no', d.roll.roll_no], ['Fabric', d.roll.fabric_name], ['Job', d.roll.io_no || '—'], ['Colour', d.roll.color_name || '—'], ['GSM / dia', `${d.roll.gsm ?? '—'} / ${d.roll.dia ?? '—'}`],
              ['In store', `${kg(d.roll.balance_kg)} KG`], ['Store', d.roll.warehouse_name || '—'], ['Current status', `${d.roll.process_state}${d.roll.balance_kg > 0 ? ' · in stock' : ' · used'}`]].map(([k, v]) => (
              <div key={k}><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div><div className="font-semibold">{v}</div></div>))}
          </div>
          <div className="card mb-3 overflow-x-auto">
            <h3 className="px-4 pt-3 text-[13px] font-semibold text-slate-800">Movement history</h3>
            <table className="mt-2 w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['#', 'Date', 'Transaction', 'Doc no', 'Process', 'From', 'To', 'Roll no', 'Job', 'Qty KG', 'Remarks'].map((x) => <th key={x} className={`px-2 py-2 ${x === 'Qty KG' ? 'text-right' : 'text-left'}`}>{x}</th>)}</tr></thead>
              <tbody>{d.timeline.map((e: any, i: number) => (
                <tr key={i} className="border-t border-slate-100"><td className="px-2 py-1 text-slate-400">{i + 1}</td><td className="px-2 py-1">{fmtDate(e.when)}</td>
                  <td className="px-2 py-1 font-semibold">{EVENT_LABEL[e.event] ?? e.event}</td><td className="px-2 py-1 font-mono">{e.ref_no || '—'}</td><td className="px-2 py-1">{e.process || '—'}</td>
                  <td className="px-2 py-1">{e.from || '—'}</td><td className="px-2 py-1">{e.to || '—'}</td><td className="px-2 py-1 font-mono">{e.roll_no}</td><td className="px-2 py-1">{e.io_no || '—'}</td>
                  <td className="px-2 py-1 text-right">{kg(e.qty_kg)}</td><td className="px-2 py-1">{e.remarks || ''}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="card overflow-x-auto">
            <h3 className="px-4 pt-3 text-[13px] font-semibold text-slate-800">Process flow — rolls in this lineage</h3>
            <table className="mt-2 w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['Roll', 'State', 'Colour', 'Job', 'GRN', 'Store', 'KG', 'In store'].map((x) => <th key={x} className={`px-2 py-2 ${/KG|store$/.test(x) && x !== 'Store' ? 'text-right' : 'text-left'}`}>{x}</th>)}</tr></thead>
              <tbody>{d.lineage.map((r: any) => (
                <tr key={r.id} className={`border-t border-slate-100 ${r.id === d.roll.id ? 'bg-sky-50' : ''}`}><td className="px-2 py-1 font-mono">{r.roll_no}</td><td className="px-2 py-1">{r.process_state}</td><td className="px-2 py-1">{r.color_name || '—'}</td>
                  <td className="px-2 py-1">{r.io_no || '—'}</td><td className="px-2 py-1 font-mono">{r.grn_no}</td><td className="px-2 py-1">{r.warehouse_name || '—'}</td><td className="px-2 py-1 text-right">{kg(r.weight_kg)}</td><td className="px-2 py-1 text-right">{kg(r.balance_kg)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** Fabric Process — Ledger / Summary (doc §10, §18): process summary, job-wise status, date-wise ledger. */
export function FabricProcessLedgerPage() {
  const [tab, setTab] = useState('summary');
  const [f, setF] = useState({ from: '', to: '', vendor_id: '', sub_process: '' });
  const [applied, setApplied] = useState(f);
  const types = useProcessTypes();
  const suppliers = useLookup('suppliers');
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v) as [string, string][]).toString();
  const summary = useQuery({ queryKey: ['fabric-process', 'summary', qs], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/summary?${qs}`)).data });
  const jobs = useQuery({ queryKey: ['fabric-process', 'job-status', qs], queryFn: async () => (await http.get<{ data: any[] }>(`/fabric-process/job-status?${qs}`)).data ?? [], enabled: tab === 'jobs' });
  const ledger = useQuery({ queryKey: ['fabric-process', 'ledger', qs], queryFn: async () => (await http.get<{ data: any[] }>(`/fabric-process/ledger?${qs}`)).data ?? [], enabled: tab === 'ledger' });
  const P = summary.data?.processes ?? [];
  const tot = (k: string) => P.reduce((a: number, p: any) => a + n(p[k]), 0);
  const rep = summary.data?.reprocess ?? [];
  return (
    <div>
      <FpTitle no={8} title="Process Ledger / Summary" sub="Outward, good, reject, loss, return, reprocess and balance — process, job and date wise" />
      <div className="card mb-3 grid grid-cols-2 items-end gap-3 p-4 md:grid-cols-6">
        <Select label="Process" value={f.sub_process} placeholder="All" onChange={(e) => setF({ ...f, sub_process: e.target.value })} options={(types.data ?? []).map((t) => ({ value: t.code, label: t.name }))} />
        <Select label="Contractor" value={f.vendor_id} placeholder="All" onChange={(e) => setF({ ...f, vendor_id: e.target.value })} options={toOptions(suppliers.data)} />
        <Input label="From date" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To date" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Button onClick={() => setApplied(f)}><Search size={14} className="mr-1" /> Search</Button>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        {[['Outward', tot('outward_kg'), 'bg-sky-50 border-sky-200'], ['Good (inward)', tot('good_kg'), 'bg-emerald-50 border-emerald-200'], ['Reject', tot('reject_kg'), 'bg-red-50 border-red-200'],
          ['Process loss', tot('loss_kg'), 'bg-amber-50 border-amber-200'], ['Returned', tot('return_kg'), 'bg-purple-50 border-purple-200'], ['Pending at vendor', tot('balance_kg'), 'bg-orange-50 border-orange-200']].map(([k, v, c]) => (
          <div key={String(k)} className={`rounded-lg border px-3 py-2 ${c}`}><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-600">{k} (KG)</div><div className="text-lg font-bold tabular-nums">{kg(v)}</div></div>))}
      </div>
      <div className="card overflow-x-auto">
        <div className="px-4 pt-2"><Tabs tabs={[{ key: 'summary', label: 'Process summary' }, { key: 'jobs', label: 'Job-wise status' }, { key: 'ledger', label: 'Date-wise ledger' }]} active={tab} onChange={setTab} /></div>
        {tab === 'summary' && (
          <>
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>{['Process', 'Outward KG', 'Good KG', 'Reject KG', 'Loss KG', 'Loss %', 'Returned KG', 'Balance KG'].map((h) => <th key={h} className={`px-3 py-2 ${h === 'Process' ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
              <tbody>{P.map((p: any) => (
                <tr key={p.sub_process} className="border-t border-slate-100"><td className="px-3 py-1.5 font-semibold">{p.process_name || p.sub_process}{p.is_reprocess ? ' (reprocess)' : ''}</td><td className="px-3 py-1.5 text-right">{kg(p.outward_kg)}</td>
                  <td className="px-3 py-1.5 text-right text-emerald-700">{kg(p.good_kg)}</td><td className="px-3 py-1.5 text-right text-red-700">{kg(p.reject_kg)}</td><td className="px-3 py-1.5 text-right text-amber-700">{kg(p.loss_kg)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtDecimal(p.loss_pct, 2)}%</td><td className="px-3 py-1.5 text-right">{kg(p.return_kg)}</td><td className="px-3 py-1.5 text-right font-semibold">{kg(p.balance_kg)}</td></tr>
              ))}{!P.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">No process movement in this period</td></tr>}</tbody>
            </table>
            {rep.length > 0 && (
              <table className="mt-4 w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>{['Reprocess', 'Total KG', 'Billable KG', 'Non-billable KG', 'Billable amount', 'Internal cost'].map((h) => <th key={h} className={`px-3 py-2 ${h === 'Reprocess' ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
                <tbody>{rep.map((r: any) => <tr key={r.sub_process} className="border-t border-slate-100"><td className="px-3 py-1.5 font-semibold">{r.sub_process}</td><td className="px-3 py-1.5 text-right">{kg(r.kg)}</td><td className="px-3 py-1.5 text-right">{kg(r.billable_kg)}</td><td className="px-3 py-1.5 text-right">{kg(r.non_billable_kg)}</td><td className="px-3 py-1.5 text-right">₹{fmtDecimal(r.billable_amount, 2)}</td><td className="px-3 py-1.5 text-right">₹{fmtDecimal(r.internal_cost, 2)}</td></tr>)}</tbody>
              </table>
            )}
          </>
        )}
        {tab === 'jobs' && (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Job no', 'PO no', 'Style no', 'Colour', 'Process', 'DCs', 'Outward KG', 'Good KG', 'Reject KG', 'Loss KG', 'Pending KG', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|DCs/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>{(jobs.data ?? []).map((j, i) => (
              <tr key={i} className="border-t border-slate-100"><td className="px-3 py-1.5 font-semibold">{j.io_no}</td><td className="px-3 py-1.5">{j.buyer_po_no || '—'}</td><td className="px-3 py-1.5">{j.style_code || '—'}</td><td className="px-3 py-1.5">{j.color_name || '—'}</td>
                <td className="px-3 py-1.5">{j.sub_process}</td><td className="px-3 py-1.5 text-right">{j.dcs}</td><td className="px-3 py-1.5 text-right">{kg(j.outward_kg)}</td><td className="px-3 py-1.5 text-right text-emerald-700">{kg(j.good_kg)}</td>
                <td className="px-3 py-1.5 text-right text-red-700">{kg(j.reject_kg)}</td><td className="px-3 py-1.5 text-right text-amber-700">{kg(j.loss_kg)}</td><td className="px-3 py-1.5 text-right font-semibold">{kg(j.pending_kg)}</td><td className="px-3 py-1.5"><FpStatus value={j.status} /></td></tr>
            ))}</tbody>
          </table>
        )}
        {tab === 'ledger' && (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['#', 'Doc date', 'Doc no', 'Transaction', 'Process', 'Contractor', 'Jobs', 'Outward KG', 'Good KG', 'Reject KG', 'Loss KG', 'Balance at vendor', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|Balance/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>{(ledger.data ?? []).map((r, i) => (
              <tr key={i} className="border-t border-slate-100"><td className="px-3 py-1.5 text-slate-400">{i + 1}</td><td className="px-3 py-1.5">{fmtDate(r.doc_date)}</td><td className="px-3 py-1.5 font-mono">{r.doc_no}</td><td className="px-3 py-1.5 font-semibold">{r.txn}</td>
                <td className="px-3 py-1.5">{r.sub_process}</td><td className="px-3 py-1.5">{r.contractor}</td><td className="px-3 py-1.5">{r.jobs || '—'}</td><td className="px-3 py-1.5 text-right">{r.outward_kg ? kg(r.outward_kg) : ''}</td>
                <td className="px-3 py-1.5 text-right">{r.good_kg ? kg(r.good_kg) : ''}</td><td className="px-3 py-1.5 text-right">{r.reject_kg ? kg(r.reject_kg) : ''}</td><td className="px-3 py-1.5 text-right">{r.loss_kg ? kg(r.loss_kg) : ''}</td>
                <td className="px-3 py-1.5 text-right font-semibold">{kg(r.balance_kg)}</td><td className="px-3 py-1.5"><FpStatus value={r.status} /></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
