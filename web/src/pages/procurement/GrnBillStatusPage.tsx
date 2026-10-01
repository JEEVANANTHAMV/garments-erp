import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Receipt } from 'lucide-react';
import { http } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { PageHeader, Select, Input, Tabs, LoadingBlock, Badge, Checkbox } from '../../components/ui';
import { fmtDate, fmtDecimal } from '../../lib/format';

/**
 * GRN Bill Status (client voice note 01-Oct-2026): for every GRN — supplier (yarn / fabric /
 * general), trims and fabric / yarn process (contractor) — has the bill been received?
 * Pending / partly billed / received, days since the GRN, overdue after BILL_PENDING_ALERT_DAYS.
 */
const SOURCES = [['PURCHASE', 'Supplier GRN (yarn / fabric / general)'], ['TRIM', 'Trims GRN'], ['FABRIC_PROCESS', 'Fabric process GRN (contractor)'], ['YARN_PROCESS', 'Yarn process GRN (contractor)']] as const;
const SRC_LABEL: Record<string, string> = { PURCHASE: 'Supplier', TRIM: 'Trims', FABRIC_PROCESS: 'Fabric process', YARN_PROCESS: 'Yarn process' };
const BOOK: Record<string, string> = { PURCHASE: '/procurement/supplier-bills', TRIM: '/procurement/supplier-bills', FABRIC_PROCESS: '/production/fabric-process/bills?id=new', YARN_PROCESS: '/production/yarn-process/bills?id=new' };

export default function GrnBillStatusPage() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('status') ?? 'OPEN');
  const [f, setF] = useState({ source: params.get('source') ?? '', supplier_id: '', from: '', to: '', overdue: false });
  const suppliers = useLookup('suppliers');
  const qs = new URLSearchParams(Object.entries({ status: tab === 'ALL' ? '' : tab, source: f.source, supplier_id: f.supplier_id, from: f.from, to: f.to, overdue: f.overdue ? '1' : '' }).filter(([, v]) => v) as [string, string][]).toString();
  const q = useQuery({ queryKey: ['grn-bill-status', qs], queryFn: async () => (await http.get<{ data: any[]; summary: any }>(`/procurement/grn-bill-status?${qs}`)) });
  const rows = q.data?.data ?? [];
  const sm = q.data?.summary;
  const csv = () => {
    const cols: [string, string][] = [['grn_no', 'GRN'], ['grn_date', 'Date'], ['days', 'Days'], ['source', 'Type'], ['supplier', 'Supplier'], ['po_nos', 'PO'], ['supplier_inv_no', 'Supplier invoice / challan'],
      ['grn_qty', 'Qty'], ['grn_value', 'GRN value'], ['billed_value', 'Billed'], ['bill_nos', 'Bills'], ['status', 'Status']];
    const lines = [cols.map((c) => c[1]).join(','), ...rows.map((r) => cols.map(([k]) => `"${String(k === 'grn_date' ? fmtDate(r[k]) : r[k] ?? '').replace(/"/g, '""')}"`).join(','))];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'grn-bill-status.csv'; a.click();
  };
  return (
    <>
      <PageHeader breadcrumb={['Procurement', 'GRN Bill Status']} title="GRN Bill Status" subtitle="Has the supplier / contractor bill come for every GRN? Pending and overdue GRNs also show in the bell."
        actions={<button className="btn-secondary text-xs" disabled={!rows.length} onClick={csv}><Download size={14} className="mr-1 inline" /> Excel (CSV)</button>} />
      {sm && (
        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          {[['Bill not received', `${sm.pending.count} GRN${sm.pending.value ? ` · ₹${fmtDecimal(sm.pending.value, 0)}` : ''}`, 'border-red-200 bg-red-50 text-red-900'],
            ['Partly billed', `${sm.partial.count} GRN${sm.partial.value ? ` · ₹${fmtDecimal(sm.partial.value, 0)} open` : ''}`, 'border-amber-200 bg-amber-50 text-amber-900'],
            [`Overdue (> ${sm.alert_days} days)`, `${sm.overdue} GRN`, 'border-orange-300 bg-orange-50 text-orange-900'],
            ['Bill received', `${sm.received.count} GRN`, 'border-emerald-200 bg-emerald-50 text-emerald-900']].map(([k, v, cls]) => (
            <div key={k} className={`rounded-lg border px-3 py-2 ${cls}`}><div className="text-[10.5px] font-semibold uppercase tracking-wider opacity-75">{k}</div><div className="text-[15px] font-bold">{v}</div></div>))}
        </div>
      )}
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'OPEN', label: 'Bill pending (all open)' }, { key: 'PENDING', label: 'Not received' }, { key: 'PARTIAL', label: 'Partly billed' }, { key: 'RECEIVED', label: 'Received' }, { key: 'ALL', label: 'All GRNs' }]} active={tab} onChange={setTab} /></div>
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-4">
        <Select label="GRN type" className="w-72" value={f.source} placeholder="All" onChange={(e) => setF({ ...f, source: e.target.value })} options={SOURCES.map(([v, l]) => ({ value: v, label: l }))} />
        <Select label="Supplier / contractor" className="w-64" value={f.supplier_id} placeholder="All" onChange={(e) => setF({ ...f, supplier_id: e.target.value })} options={toOptions(suppliers.data)} />
        <Input label="GRN from" type="date" className="w-40" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="GRN to" type="date" className="w-40" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <div className="pb-2"><Checkbox label="Overdue only" checked={f.overdue} onChange={(v) => setF({ ...f, overdue: v })} /></div>
      </div>
      <div className="card overflow-x-auto">
        {q.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['GRN', 'Date', 'Days', 'Type', 'Supplier / contractor', 'PO', 'Supplier inv / challan', 'Qty', 'GRN value', 'Billed', 'Bill no', 'Status', ''].map((h) => <th key={h} className={`px-3 py-2 ${/Qty|value|Billed|Days/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.source}${r.grn_id}`} className={`border-t border-slate-100 ${r.overdue ? 'bg-red-50/50' : ''}`}>
                  <td className="px-3 py-1.5"><Link to={r.link} className="font-mono font-semibold text-brand-700 hover:underline">{r.grn_no}</Link></td>
                  <td className="px-3 py-1.5">{fmtDate(r.grn_date)}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${r.overdue ? 'font-bold text-red-700' : ''}`}>{r.days}</td>
                  <td className="px-3 py-1.5">{SRC_LABEL[r.source]}{r.source === 'PURCHASE' && r.material ? <span className="text-slate-400"> · {String(r.material).toLowerCase()}</span> : null}</td>
                  <td className="px-3 py-1.5 font-medium">{r.supplier || '—'}</td><td className="px-3 py-1.5">{r.po_nos || '—'}</td><td className="px-3 py-1.5">{r.supplier_inv_no || '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtDecimal(r.grn_qty, 3)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.grn_value ? `₹${fmtDecimal(r.grn_value, 2)}` : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.billed_value ? `₹${fmtDecimal(r.billed_value, 2)}` : '—'}</td>
                  <td className="px-3 py-1.5">{r.bill_nos ? <span className="font-mono">{r.bill_nos}</span> : '—'}{r.bill_status ? <span className="ml-1 text-slate-400">({String(r.bill_status).toLowerCase()})</span> : null}</td>
                  <td className="px-3 py-1.5"><Badge tone={r.status === 'RECEIVED' ? 'green' : r.status === 'PARTIAL' ? 'amber' : 'red'}>{r.status === 'RECEIVED' ? 'Bill received' : r.status === 'PARTIAL' ? 'Partly billed' : 'Bill pending'}</Badge>{r.overdue ? <span className="ml-1 text-[10.5px] font-bold text-red-700">overdue</span> : null}</td>
                  <td className="px-3 py-1.5 text-right">{r.status !== 'RECEIVED' && <Link to={BOOK[r.source]} className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand-700 hover:underline"><Receipt size={12} /> Book bill</Link>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">Nothing here</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
