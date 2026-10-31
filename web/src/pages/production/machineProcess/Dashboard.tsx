import { useState, type ReactNode } from 'react';
import { Card, Input } from '../../../components/ui';
import { fmtDate } from '../../../lib/format';
import { type Kind, BASE, money, qty, pctTxt, num, usePerm, useGet } from './shared';

/** Output, efficiency, downtime and cost KPIs (embroidery doc §30, printing doc §28). */
function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

/** One-series magnitude bar: single brand hue, value text in neutral ink, title tooltip on hover. */
function Bar({ value, max, title }: { value: number; max: number; title: string }) {
  const w = max > 0 ? Math.max((value / max) * 100, value > 0 ? 2 : 0) : 0;
  return (
    <div className="h-3 w-full rounded bg-slate-100" title={title}>
      <div className="h-3 rounded-r bg-brand-500" style={{ width: `${w}%` }} />
    </div>
  );
}

export function DashboardTab({ kind }: { kind: Kind }) {
  const p = usePerm(kind);
  const first = new Date(); first.setDate(1);
  const [f, setF] = useState({ from: first.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });
  const d = useGet<any>(`${BASE[kind]}/dashboard`, f);
  const k = d.data?.kpi ?? {};
  const daily: any[] = d.data?.daily ?? [];
  const maxGood = Math.max(...daily.map((x) => num(x.good)), 0);
  const top: any[] = d.data?.top_downtime ?? [];
  const maxDt = Math.max(...top.map((x) => num(x.minutes)), 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <p className="pb-2 text-xs text-slate-500">Approved production · {k.pending_approval ?? 0} entries waiting approval · {k.pending_drafts ?? 0} drafts</p>
      </div>
      {d.error && <p className="text-sm text-red-600">{d.error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6" id="mp-dash-kpis">
        <Tile label="Jobs" value={qty(k.total_jobs, 0)} sub={`${qty(k.open_jobs, 0)} open · ${qty(k.jobs_run, 0)} ran`} />
        <Tile label="Planned qty" value={qty(k.planned_qty, 0)} />
        <Tile label="Input" value={qty(k.input_qty, 0)} sub={`${qty(k.entries, 0)} entries`} />
        <Tile label="Good output" value={qty(k.good_output, 0)} />
        <Tile label="Reject" value={qty(k.reject_qty, 0)} sub={pctTxt(k.reject_pct)} />
        <Tile label="Rework" value={qty(k.rework_qty, 0)} sub={pctTxt(k.rework_pct)} />
        <Tile label="Machine hours" value={qty(k.machine_hours, 1)} sub={kind === 'EMBROIDERY' ? `${qty(k.head_hours, 1)} head-hours` : `${qty(k.output_per_hour, 1)} / hour`} />
        {kind === 'EMBROIDERY' && <Tile label="Stitches" value={qty(k.stitches, 0)} sub={`${qty(k.stitches_per_hour, 0)} / hour`} />}
        <Tile label="Utilization" value={pctTxt(k.utilization_pct)} />
        <Tile label="Efficiency" value={pctTxt(k.efficiency_pct)} />
        <Tile label="Downtime" value={`${qty(k.downtime_minutes, 0)} min`} />
        {p.costing && <>
          <Tile label={kind === 'EMBROIDERY' ? 'Thread cost' : 'Dyes cost'} value={money(k.thread_cost)} />
          <Tile label={kind === 'EMBROIDERY' ? 'Consumable cost' : 'Chemical cost'} value={money(k.consumable_cost)} />
          <Tile label="Machine cost" value={money(k.machine_cost)} />
          <Tile label="Labour cost" value={money(k.labour_cost)} />
          <Tile label="Overhead" value={money(k.overhead_cost)} />
          <Tile label="Total cost" value={money(k.total_cost)} sub={`std ${money(k.std_total_cost)} · ${pctTxt(k.variance_pct)}`} />
          <Tile label="Cost / good pc" value={money(k.cost_per_good)} />
          {kind === 'EMBROIDERY' && <Tile label="Cost / 1,000 stitches" value={money(k.cost_per_1000_stitches)} />}
        </>}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Good output by day">
          <div className="space-y-1 p-3">
            {!daily.length ? <p className="text-xs text-slate-400">No approved production in the range</p> : daily.map((x) => (
              <div key={x.prod_date} className="grid grid-cols-[90px_1fr_80px] items-center gap-2 text-xs">
                <span className="text-slate-600">{fmtDate(x.prod_date)}</span>
                <Bar value={num(x.good)} max={maxGood} title={`${fmtDate(x.prod_date)}: ${qty(x.good, 0)} good, ${qty(x.reject, 0)} reject, ${qty(x.run_hours, 1)} run h${x.total != null ? `, ${money(x.total)}` : ''}`} />
                <span className="text-right tabular-nums text-slate-800">{qty(x.good, 0)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Top downtime reasons">
          <div className="space-y-1 p-3">
            {!top.length ? <p className="text-xs text-slate-400">No downtime recorded</p> : top.map((x) => (
              <div key={x.reason_code} className="grid grid-cols-[160px_1fr_80px] items-center gap-2 text-xs">
                <span className="truncate text-slate-600">{x.reason_code} · {x.reason_name}</span>
                <Bar value={num(x.minutes)} max={maxDt} title={`${x.reason_name}: ${x.minutes} min in ${x.occurrences} stops`} />
                <span className="text-right tabular-nums text-slate-800">{qty(x.minutes, 0)} min</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      {p.costing && <Card title="High cost-variance jobs (≥ 5% from standard)">
        <div className="overflow-x-auto p-3">
          {!(d.data?.high_variance_jobs ?? []).length ? <p className="text-xs text-slate-400">None</p> : (
            <table className="w-full text-xs"><thead className="bg-slate-50 text-slate-500"><tr>
              <th className="px-2 py-1 text-left">Job</th><th className="px-2 py-1 text-left">Style</th><th className="px-2 py-1 text-right">Good</th>
              <th className="px-2 py-1 text-right">Standard</th><th className="px-2 py-1 text-right">Actual</th><th className="px-2 py-1 text-right">Variance</th><th className="px-2 py-1 text-right">₹ / pc</th>
            </tr></thead><tbody>{d.data.high_variance_jobs.map((r: any) => (
              <tr key={r.job_id} className="border-t border-slate-100"><td className="px-2 py-1 tabular-nums">{r.job_no}</td><td className="px-2 py-1">{r.style_code ?? '—'}</td>
                <td className="px-2 py-1 text-right">{qty(r.good, 0)}</td><td className="px-2 py-1 text-right">{money(r.std_total)}</td><td className="px-2 py-1 text-right">{money(r.total)}</td>
                <td className="px-2 py-1 text-right font-semibold">{pctTxt(r.variance_pct)}</td><td className="px-2 py-1 text-right">{money(r.cost_per_good)}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      </Card>}
    </div>
  );
}
