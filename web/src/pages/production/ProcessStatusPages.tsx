import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { Card, Button, Input, Select, SearchInput, useDebounced } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtNumber } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

/**
 * Process DC reports (client call 13-Oct-2026):
 *   Operation status — each process operation (Power Table, Singer, Trimming …) on its own: sent, good back, lost, pending.
 *   WIP stock value  — where the job's PCS are and what they are worth (fabric + cutting + processes done), for the auditors.
 */
const errMsg = (e: any) => e?.message || 'Request failed';
const num = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function csv(name: string, cols: { k: string; h: string }[], rows: any[]) {
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = [cols.map((c) => esc(c.h)).join(','), ...rows.map((r) => cols.map((c) => esc(r[c.k])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export function OperationStatusPage() {
  const toast = useToast();
  const [stages, setStages] = useState<any[]>([]);
  const [f, setF] = useState({ stage_id: '', io_no: '', from: '', to: '' });
  const dio = useDebounced(f.io_no);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    api.get('/process-dcs/stages').then((r) => {
      const st = r.data.data || [];
      setStages(st);
      const stitch = st.find((s: any) => s.kind === 'SEWING');
      if (stitch) setF((cur) => ({ ...cur, stage_id: cur.stage_id || String(stitch.id) }));
    }).catch(() => setStages([]));
  }, []);
  useEffect(() => {
    setLoading(true);
    api.get('/process-dcs/operation-status', { params: { stage_id: f.stage_id || undefined, io_no: dio || undefined, from: f.from || undefined, to: f.to || undefined } })
      .then((r) => setRows(r.data.data || [])).catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  }, [f.stage_id, dio, f.from, f.to]);
  // operation totals (cards) + detail
  const byOp = useMemo(() => {
    const m = new Map<string, { op: string; stage: string; sent: number; good: number; lost: number; pending: number }>();
    for (const r of rows) {
      const k = `${r.stage_name}|${r.operation}`;
      const x = m.get(k) ?? { op: r.operation, stage: r.stage_name, sent: 0, good: 0, lost: 0, pending: 0 };
      x.sent += num(r.sent); x.good += num(r.good); x.lost += num(r.lost); x.pending += num(r.pending);
      m.set(k, x);
    }
    return [...m.values()];
  }, [rows]);
  const cols = [
    { k: 'stage_name', h: 'Process' }, { k: 'operation', h: 'Operation' }, { k: 'io_no', h: 'Job' }, { k: 'style_code', h: 'Style' },
    { k: 'color_name', h: 'Colour' }, { k: 'sent_to', h: 'Sent to' }, { k: 'dcs', h: 'DCs' }, { k: 'bundles', h: 'Bundles' },
    { k: 'sent', h: 'Sent' }, { k: 'good', h: 'Good back' }, { k: 'lost', h: 'Reject / short' }, { k: 'pending', h: 'Pending' },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Operation status</h1>
          <p className="text-sm text-slate-500">Each process operation on its own — PCS sent on DCs, back good, rejected / short and still pending</p>
        </div>
        <div className="flex gap-2">
          <Link to="/production/jobwork-challans" className="btn-secondary">Process Outward (DC)</Link>
          <Button variant="secondary" disabled={!rows.length} onClick={() => csv('operation-status.csv', cols, rows)}><Download size={13} className="mr-1 inline" />CSV</Button>
        </div>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Select label="Process" className="w-48" value={f.stage_id} placeholder="All processes" id="os-stage" onChange={(e) => setF({ ...f, stage_id: e.target.value })}
            options={stages.map((s) => ({ value: s.id, label: s.stage_name }))} />
          <div><span className="label">Job (IO no)</span><SearchInput value={f.io_no} onChange={(v) => setF({ ...f, io_no: v })} placeholder="IO no…" className="w-48" /></div>
          <Input type="date" label="DC from" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <Input type="date" label="DC to" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3 px-3 pb-3 md:grid-cols-4 xl:grid-cols-6" id="os-cards">
          {byOp.map((o) => (
            <div key={`${o.stage}|${o.op}`} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{o.op}</div>
              <div className="mt-1 text-lg font-bold tabular-nums text-slate-900">{fmtNumber(o.pending)} <span className="text-xs font-medium text-slate-500">pending</span></div>
              <div className="text-[11px] text-slate-500">sent {fmtNumber(o.sent)} · good {fmtNumber(o.good)}{o.lost ? ` · lost ${fmtNumber(o.lost)}` : ''}</div>
            </div>
          ))}
          {!byOp.length && !loading && <p className="col-span-full py-4 text-center text-sm text-slate-400">No DCs for the filters</p>}
        </div>
        <div className="overflow-x-auto px-3 pb-3">
          <table className="w-full text-xs" id="os-table">
            <thead className="bg-slate-50 text-slate-500"><tr>{cols.map((c) => <th key={c.k} className={`px-2 py-1.5 font-semibold ${['dcs', 'bundles', 'sent', 'good', 'lost', 'pending'].includes(c.k) ? 'text-right' : 'text-left'}`}>{c.h}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-2 py-1">{r.stage_name}</td><td className="px-2 py-1 font-semibold">{r.operation}</td><td className="px-2 py-1 font-mono">{r.io_no ?? '—'}</td>
                <td className="px-2 py-1">{r.style_code ?? '—'}</td><td className="px-2 py-1">{r.color_name ?? '—'}</td><td className="px-2 py-1 text-slate-500">{r.sent_to ?? '—'}</td>
                <td className="px-2 py-1 text-right">{r.dcs}</td><td className="px-2 py-1 text-right">{r.bundles}</td>
                <td className="px-2 py-1 text-right">{fmtNumber(r.sent)}</td><td className="px-2 py-1 text-right text-emerald-700">{fmtNumber(r.good)}</td>
                <td className="px-2 py-1 text-right text-red-600">{r.lost ? fmtNumber(r.lost) : '—'}</td>
                <td className={`px-2 py-1 text-right font-semibold ${r.pending ? 'text-amber-700' : 'text-slate-400'}`}>{fmtNumber(r.pending)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function WipStockValuePage() {
  const toast = useToast();
  const [f, setF] = useState({ io_no: '', group_by: 'location' });
  const dio = useDebounced(f.io_no);
  const [res, setRes] = useState<{ data: any[]; meta: any } | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api.get('/process-dcs/stock-value', { params: { io_no: dio || undefined, group_by: f.group_by } })
      .then((r) => setRes(r.data)).catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  }, [dio, f.group_by]);
  const rows = res?.data ?? [];
  const tot = rows.reduce((a, r) => ({ pcs: a.pcs + num(r.pcs), fab: a.fab + num(r.fabric_value), pro: a.pro + num(r.process_value), all: a.all + num(r.total_value) }), { pcs: 0, fab: 0, pro: 0, all: 0 });
  const g = f.group_by;
  const cols = [
    ...(g === 'location' || g === 'detail' ? [{ k: 'location', h: 'Store / unit / contractor' }] : []),
    ...(g === 'stage' || g === 'detail' ? [{ k: 'stage', h: 'Stage' }] : []),
    ...(g === 'job' || g === 'detail' ? [{ k: 'io_no', h: 'Job' }, { k: 'style_code', h: 'Style' }, { k: 'color_name', h: 'Colour' }] : []),
    ...(g !== 'job' && g !== 'detail' ? [{ k: 'jobs', h: 'Jobs' }] : []),
    { k: 'pcs', h: 'PCS' }, { k: 'fabric_value', h: 'Fabric value' }, { k: 'process_value', h: 'Cutting + process value' }, { k: 'total_value', h: 'Total value' }, { k: 'value_per_pc', h: '₹ / PC' },
  ];
  const right = new Set(['jobs', 'pcs', 'fabric_value', 'process_value', 'total_value', 'value_per_pc']);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">WIP stock value</h1>
          <p className="text-sm text-slate-500">PCS of open jobs by store / process and their value — fabric cost + cutting rate + rates of the processes already done</p>
        </div>
        <Button variant="secondary" disabled={!rows.length} onClick={() => csv(`wip-stock-value-${g}.csv`, cols, rows)}><Download size={13} className="mr-1 inline" />CSV</Button>
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Select label="Group by" className="w-48" value={f.group_by} id="sv-group" onChange={(e) => setF({ ...f, group_by: e.target.value })}
            options={[{ value: 'location', label: 'Store / unit / contractor' }, { value: 'stage', label: 'Stage' }, { value: 'job', label: 'Job / colour' }, { value: 'detail', label: 'Full detail' }]} />
          <div><span className="label">Job (IO no)</span><SearchInput value={f.io_no} onChange={(v) => setF({ ...f, io_no: v })} placeholder="All open jobs" className="w-48" /></div>
          <div className="ml-auto grid grid-cols-2 gap-3 md:grid-cols-4" id="sv-totals">
            {[['PCS', fmtNumber(tot.pcs)], ['Fabric', money(tot.fab)], ['Cutting + process', money(tot.pro)], ['Total', money(tot.all)]].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-slate-200 bg-white px-3 py-2"><div className="text-[11px] uppercase text-slate-500">{k}</div><div className="text-base font-bold tabular-nums text-slate-900">{v}</div></div>
            ))}
          </div>
        </div>
        {res?.meta && <p className="px-3 pb-2 text-[11px] text-slate-500">{res.meta.note}. Cutting rate {res.meta.cutting_rate_per_pc ? `₹${res.meta.cutting_rate_per_pc}/PC` : 'not set (Admin › Settings › COSTING_CUTTING_RATE_PER_PC)'}. In-house DCs count their internal rate; contractor DCs their rate.</p>}
        <div className="overflow-x-auto px-3 pb-3">
          {loading ? <p className="py-6 text-center text-sm text-slate-400">Loading…</p> : (
            <table className="w-full text-xs" id="sv-table">
              <thead className="bg-slate-50 text-slate-500"><tr>{cols.map((c) => <th key={c.k} className={`px-2 py-1.5 font-semibold ${right.has(c.k) ? 'text-right' : 'text-left'}`}>{c.h}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100">{cols.map((c) => (
                  <td key={c.k} className={`px-2 py-1 ${right.has(c.k) ? 'text-right tabular-nums' : ''}`}>
                    {['fabric_value', 'process_value', 'total_value', 'value_per_pc'].includes(c.k) ? money(r[c.k]) : c.k === 'pcs' ? fmtNumber(r.pcs) : (r[c.k] ?? '—')}
                  </td>))}
                </tr>
              ))}{!rows.length && <tr><td colSpan={cols.length} className="py-6 text-center text-slate-400">No open WIP</td></tr>}</tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
