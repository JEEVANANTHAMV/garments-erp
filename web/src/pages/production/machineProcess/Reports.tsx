import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Card, Button, Input, Select } from '../../../components/ui';
import { fmtDate } from '../../../lib/format';
import { type Kind, BASE, LABEL, human, money, qty, pctTxt, num, usePerm, useGet, toCsv, download } from './shared';

/** Reports (embroidery doc §29 / printing doc §27) — approved production, optionally with submitted entries. */
const REPORTS: { key: string; label: string; cost?: boolean; emb?: boolean }[] = [
  { key: 'machine-output', label: 'Machine-wise output' },
  { key: 'daily-production', label: 'Daily production (date / shift / machine)' },
  { key: 'job-cost', label: 'Job-wise cost', cost: true },
  { key: 'design-productivity', label: 'Design-wise productivity', emb: true },
  { key: 'machine-efficiency', label: 'Machine efficiency & utilization' },
  { key: 'downtime', label: 'Downtime analysis' },
  { key: 'consumption', label: 'Material consumption (standard vs actual)' },
  { key: 'variance', label: 'Consumption variance by job' },
  { key: 'reject-rework', label: 'Reject / rework analysis' },
  { key: 'cost-sheet', label: 'Cost sheet (per entry)', cost: true },
  { key: 'standard-vs-actual', label: 'Standard vs actual cost', cost: true },
  { key: 'operator', label: 'Operator productivity' },
  { key: 'pending-jobs', label: 'Pending jobs (planned vs done)' },
  { key: 'machine-cost', label: 'Machine cost summary (by month)', cost: true },
];

const MONEY = new Set(['material', 'thread', 'consumable', 'machine', 'labour', 'overhead', 'other', 'total', 'std_total', 'cost_per_good', 'cost_per_1000_stitches', 'variance',
  'thread_cost', 'consumable_cost', 'material_cost', 'machine_cost', 'labour_cost', 'overhead_cost', 'other_cost', 'total_cost', 'std_total_cost', 'cost_per_unit', 'cost_per_kg',
  'standard_cost', 'actual_cost', 'variance_cost', 'cost_impact', 'standard', 'actual']);
const PCT = new Set(['reject_pct', 'rework_pct', 'efficiency_pct', 'utilization_pct', 'variance_pct', 'pct_of_input', 'done_pct']);
const HIDE = new Set(['id', 'job_id', 'machine_id', 'design_id', 'attended_min', 'is_final']);
const LABELS: Record<string, string> = {
  run_hours: 'Run h', std_hours: 'Std h', downtime_min: 'Downtime min', avg_heads: 'Avg heads', stitches: 'Stitches', output_per_hour: 'Output / h', stitches_per_hour: 'Stitches / h',
  cost_per_good: '₹ / good pc', cost_per_1000_stitches: '₹ / 1,000 st', std_total: 'Standard ₹', total: 'Total ₹', variance: 'Variance ₹', variance_pct: 'Var %',
  input_done: 'Input done', good_done: 'Good done', open_entries: 'Open entries', planned_qty: 'Planned', attended_hours: 'Attended h', pct_of_input: '% of input',
};

export function ReportsTab({ kind }: { kind: Kind }) {
  const p = usePerm(kind);
  const machines = useGet<any[]>(`${BASE[kind]}/machines`);
  const avail = REPORTS.filter((r) => (!r.cost || p.costing) && (!r.emb || kind === 'EMBROIDERY'));
  const [key, setKey] = useState(avail[0].key);
  const first = new Date(); first.setDate(1);
  const [f, setF] = useState({ from: first.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), machine_id: '', status: 'approved' });
  const rep = useGet<any[]>(`${BASE[kind]}/reports/${key}`, { from: f.from || undefined, to: f.to || undefined, machine_id: f.machine_id || undefined, status: f.status });
  const rows = rep.data ?? [];
  const cols = rows.length ? Object.keys(rows[0]).filter((k) => !HIDE.has(k)) : [];
  const fmt = (k: string, v: unknown) => {
    if (v == null || v === '') return '—';
    if (MONEY.has(k)) return money(v);
    if (PCT.has(k)) return pctTxt(v);
    if (/date|planned_end/.test(k)) return fmtDate(v);
    if (typeof v === 'boolean') return v ? 'Yes' : '';
    if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/code|no$|period/.test(k))) return qty(v, 2);
    return String(v);
  };
  const label = (k: string) => LABELS[k] ?? human(k);
  return (
    <Card title={`${LABEL[kind]} reports`} subtitle="Built from approved entries and their frozen costing — reconciles with the transactions"
      actions={<Button size="sm" variant="secondary" disabled={!rows.length} onClick={() => download(`${kind.toLowerCase()}-${key}-${f.from}-${f.to}.csv`, toCsv(rows, cols.map((k) => ({ key: k, label: label(k) }))))}>
        <Download size={13} className="mr-1 inline" />CSV</Button>}>
      <div className="flex flex-wrap items-end gap-3 p-3">
        <Select label="Report" className="w-72" id="mp-report-key" value={key} onChange={(e) => setKey(e.target.value)} options={avail.map((r) => ({ value: r.key, label: r.label }))} />
        <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Select label="Machine" className="w-40" value={f.machine_id} placeholder="All" onChange={(e) => setF({ ...f, machine_id: e.target.value })} options={(machines.data ?? []).map((m: any) => ({ value: m.id, label: m.machine_code }))} />
        <Select label="Entries" className="w-48" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={[{ value: 'approved', label: 'Approved only' }, { value: 'all', label: 'Approved + submitted' }]} />
        <Button variant="secondary" onClick={() => void rep.reload()}><RefreshCw size={13} className="mr-1 inline" />Run</Button>
      </div>
      {rep.error && <p className="px-3 pb-3 text-sm text-red-600">{rep.error}</p>}
      <div className="overflow-x-auto px-3 pb-3">
        {rep.loading ? <p className="text-sm text-slate-500">Loading…</p> : !rows.length ? <p className="py-6 text-center text-sm text-slate-400">No data for the filters</p> : (
          <table className="w-full text-xs" id="mp-report-table">
            <thead className="bg-slate-50 text-slate-500"><tr>{cols.map((k) => <th key={k} className="whitespace-nowrap px-2 py-1.5 text-left font-semibold">{label(k)}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                {cols.map((k) => <td key={k} className={`whitespace-nowrap px-2 py-1 ${typeof r[k] === 'number' || MONEY.has(k) || PCT.has(k) ? 'text-right tabular-nums' : ''} ${k === 'variance_pct' && num(r[k]) > 0 ? 'text-red-600' : ''}`}>{fmt(k, r[k])}</td>)}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
