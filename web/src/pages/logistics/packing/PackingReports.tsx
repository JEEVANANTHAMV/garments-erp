import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import * as XLSX from 'xlsx';
import { PageHeader, Card, Button, Input, Tabs, LoadingBlock, EmptyState, ErrorState } from '../../../components/ui';
import { JobSelect } from '../../../components/JobSelect';
import { http } from '../../../lib/api';
import { fmtDateTime, humanize } from '../../../lib/format';
import { PackingNav, PkStatus, TableHead, errMsg } from './packingShared';

const REPORTS = [
  { key: 'job-status', label: 'Job-wise status' }, { key: 'po-status', label: 'PO-wise status' }, { key: 'balance', label: 'Style / colour / size balance' },
  { key: 'carton-register', label: 'Carton register' }, { key: 'carton-contents', label: 'Carton contents' }, { key: 'consumption', label: 'Polybag & carton consumption' },
  { key: 'packaging-stock', label: 'Packaging stock & variance' }, { key: 'full-partial', label: 'Full vs partial' }, { key: 'pending', label: 'Unsealed / pending' },
  { key: 'packed-vs-dispatched', label: 'Packed vs dispatched' }, { key: 'reconciliation', label: 'Reconciliation' }, { key: 'repack-history', label: 'Repack history' },
  { key: 'trace', label: 'Carton traceability' },
];
const HIDE = new Set(['id', 'so_id', 'sort_order']);
const cell = (k: string, v: unknown) => {
  if (v == null || v === '') return '—';
  if (k === 'carton_status' || k === 'order_status' || k === 'event_type') return <PkStatus value={String(v)} />;
  if (/(_at|created_at)$/.test(k)) return fmtDateTime(v);
  if (k === 'is_posted' || k === 'dispatched' || k === 'is_partial' || k === 'negative') return Number(v) ? 'Yes' : 'No';
  return String(v);
};

/** Packing reports (doc §18) — one page, one tab per report; the buyer packing list is the packing-list screen. */
export function PackingReportsPage() {
  const [tab, setTab] = useState('job-status');
  const [soId, setSoId] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [traceCode, setTraceCode] = useState('');
  const q = useQuery({
    queryKey: ['packing-report', tab, soId, traceCode], enabled: tab !== 'trace' || !!traceCode,
    queryFn: async () => (await http.get<{ data: any }>(`/packing/reports/${tab}`, { so_id: soId ?? undefined, code: tab === 'trace' ? traceCode : undefined })).data,
  });
  const rows: any[] = tab === 'trace' ? [] : (q.data ?? []);
  const cols = rows.length ? Object.keys(rows[0]).filter((k) => !HIDE.has(k)) : [];
  const exportXlsx = () => {
    const ws = XLSX.utils.json_to_sheet(rows.map((r) => Object.fromEntries(cols.map((c) => [humanize(c), r[c]]))));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, tab.slice(0, 30)); XLSX.writeFile(wb, `packing-${tab}.xlsx`);
  };
  const t = q.data as any;
  return (
    <div>
      <PageHeader title="Packing reports" breadcrumb={['Logistics', 'Packing']}
        subtitle={<>Status, balance, cartons, packaging consumption and traceability. The buyer packing list is on the <Link className="text-brand-700 hover:underline" to="/logistics/packing-lists">Packing list</Link> screen.</>}
        actions={tab !== 'trace' && rows.length > 0 && <Button variant="secondary" onClick={exportXlsx}><Download size={15} />Excel</Button>} />
      <PackingNav active="/logistics/packing/reports" />
      <Tabs tabs={REPORTS} active={tab} onChange={setTab} />
      {tab === 'trace' ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
          <Card title="Scan carton"><div className="space-y-3 p-4">
            <Input id="trace-scan" label="Carton barcode" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setTraceCode(code.trim()); }} placeholder="Scan, then Enter" />
            <div className="flex justify-end"><Button onClick={() => setTraceCode(code.trim())}>Trace</Button></div>
          </div></Card>
          {!traceCode ? <EmptyState title="Scan a carton" message="Shows contents, the cut bundles inside and the shipment." /> : q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={errMsg(q.error)} /> : t && (
            <Card title={<span className="tabular-nums">{t.carton.carton_no}</span>} subtitle={`${t.carton.pack_no} · ${t.carton.job_no} · ${t.carton.style_code} · PO ${t.carton.buyer_po_no ?? '—'} · ${t.carton.buyer_name ?? ''}`}
              actions={<PkStatus value={t.carton.carton_status} posted={t.carton.is_posted} />}>
              <div className="grid gap-4 p-4 lg:grid-cols-2" id="trace-result">
                <div><TableHead title="Contents" /><table className="w-full text-[12.5px]"><tbody>{t.contents.map((c: any, i: number) => <tr key={i}><td className="td">{c.color_name}</td><td className="td">{c.size_code}</td><td className="td text-right">{c.qty} pcs</td></tr>)}</tbody></table></div>
                <div><TableHead title="Bundles" />{!t.bundles.length ? <p className="text-[12px] text-slate-400">Not posted yet — bundles link on posting.</p> :
                  <table className="w-full text-[12.5px]"><tbody>{t.bundles.map((b: any, i: number) => <tr key={i}><td className="td tabular-nums">{b.bundle_no}</td><td className="td">{b.cut_no}</td><td className="td">{b.color_name}/{b.size_code}</td><td className="td text-right">{b.qty}</td></tr>)}</tbody></table>}</div>
                <div><TableHead title="History" /><ul className="text-[12px] text-slate-600">{t.events.map((e: any, i: number) => <li key={i}>{fmtDateTime(e.created_at)} · {e.event_type}{e.reason ? ` — ${e.reason}` : ''}</li>)}</ul></div>
                <div><TableHead title="Shipment" />{t.shipment.length ? t.shipment.map((s: any, i: number) => <div key={i} className="text-[12.5px]">{s.shipment_no} · {s.status}</div>) : <p className="text-[12px] text-slate-400">Not on a shipment.</p>}</div>
              </div>
            </Card>
          )}
        </div>
      ) : (
        <Card>
          <div className="flex flex-wrap items-end gap-3 border-b border-surface-border p-3">
            <JobSelect className="w-80" by="so_id" label="Job" placeholder="All jobs" value={soId ?? ''} onPick={(j) => setSoId(j?.id ?? null)} />
          </div>
          {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} /> : !rows.length ? <EmptyState title="No data" message="Nothing to show for this report yet." /> : (
            <div className="overflow-x-auto"><table className="w-full text-[12.5px]" id="report-table">
              <thead><tr>{cols.map((c) => <th key={c} className="th">{humanize(c)}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i} className="row-hover">{cols.map((c) => <td key={c} className={`td ${typeof r[c] === 'number' ? 'text-right tabular-nums' : ''}`}>{cell(c, r[c])}</td>)}</tr>)}</tbody>
            </table></div>
          )}
        </Card>
      )}
    </div>
  );
}
