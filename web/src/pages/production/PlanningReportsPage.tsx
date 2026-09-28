import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Card, Button, Input, Select, Tabs } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { type Proc, PROC_LABEL, UtilBar } from './linePlanUi';

/**
 * Planning reports (developer doc §10, §28, §29): dashboard KPIs, plan vs
 * actual with achievement / rework / reject %, line capacity vs allocation
 * vs plan, and allocation by job / style / colour / size / line.
 */

const TABS = [
  { key: 'pva', label: 'Plan vs Actual' },
  { key: 'util', label: 'Line Utilization' },
  { key: 'alloc', label: 'Allocation Summary' },
];
const monthStart = () => today().slice(0, 8) + '01';

export function PlanningReportsPage() {
  const toast = useToast();
  const [proc, setProc] = useState<Proc>('sewing');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [date, setDate] = useState(today());
  const [groupBy, setGroupBy] = useState('job');
  const [tab, setTab] = useState('pva');
  const [kpi, setKpi] = useState<any>(null);
  const [pva, setPva] = useState<any>(null);
  const [util, setUtil] = useState<any[]>([]);
  const [alloc, setAlloc] = useState<any[]>([]);

  const load = async () => {
    try {
      const [k, p, u, a] = await Promise.all([
        api.get('/production-planning/kpis', { params: { date } }),
        api.get(`/${proc}/reports/plan-vs-actual`, { params: { from, to } }),
        api.get(`/${proc}/reports/line-utilization`, { params: { date } }),
        api.get(`/${proc}/reports/allocation-summary`, { params: { from, to, group_by: groupBy } }),
      ]);
      setKpi(k.data.data); setPva(p.data.data); setUtil(u.data.data || []); setAlloc(a.data.data || []);
    } catch (e: any) {
      toast(e?.message || 'Failed to load reports', 'error');
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [proc, groupBy]);

  const s = kpi?.sewing; const c = kpi?.checking;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Production Planning Reports</h1>
        <p className="text-sm text-slate-500">Plan vs actual, line utilization and allocation for sewing, checking, ironing and packing</p>
      </div>

      <Card className="!p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Process" className="w-40" value={proc} onChange={(e) => setProc(e.target.value as Proc)}
            options={(Object.keys(PROC_LABEL) as Proc[]).map((p) => ({ value: p, label: PROC_LABEL[p] }))} />
          <Input label="From" type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input label="KPI / utilization date" type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button className="!h-10" onClick={load}><Search size={14} className="mr-1" /> Show</Button>
        </div>
      </Card>

      {kpi && (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <Card title={`Sewing — ${fmtDate(kpi.date)}`}>
            <Kpis items={[['Capacity', s.capacity], ['Planned', s.planned], ['Actual', s.actual], ['Balance', s.balance],
              ['Achievement', `${s.achievement_pct}%`], ['Rework', `${s.rework_pct}%`], ['Reject', `${s.reject_pct}%`]]} />
          </Card>
          <Card title={`Checking — ${fmtDate(kpi.date)}`}>
            <Kpis items={[['Waiting (inward)', c.inward_waiting], ['Allocated', c.allocated], ['Unallocated', c.unallocated],
              ['QC Good', c.qc_good], ['Rework', c.rework], ['Reject', c.reject], ['Outward', c.outward]]} />
          </Card>
        </div>
      )}

      <Card>
        <div className="px-3 pt-2"><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
        {tab === 'pva' && pva && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>{['Date', 'Line', 'Planned', 'Good', 'Rework', 'Reject', 'Balance', 'Achievement', 'Rework %', 'Reject %'].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
              </thead>
              <tbody>
                {pva.rows.map((r: any) => (
                  <tr key={`${r.date}-${r.line_id}`} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">{fmtDate(r.date)}</td>
                    <td className="px-3 py-1.5 font-mono text-brand-700">{r.line_code}</td>
                    <td className="px-3 py-1.5">{fmtNumber(r.planned)}</td>
                    <td className="px-3 py-1.5 font-medium text-emerald-700">{fmtNumber(r.good)}</td>
                    <td className="px-3 py-1.5 text-amber-700">{fmtNumber(r.rework)}</td>
                    <td className="px-3 py-1.5 text-red-700">{fmtNumber(r.reject)}</td>
                    <td className="px-3 py-1.5">{fmtNumber(r.balance)}</td>
                    <td className="px-3 py-1.5"><UtilBar value={r.achievement_pct} width="w-16" /></td>
                    <td className="px-3 py-1.5">{r.rework_pct}%</td>
                    <td className="px-3 py-1.5">{r.reject_pct}%</td>
                  </tr>
                ))}
                {!pva.rows.length && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-400">No plans in this period</td></tr>}
              </tbody>
              {pva.rows.length > 0 && (
                <tfoot className="border-t bg-slate-50 font-semibold">
                  <tr>
                    <td className="px-3 py-1.5" colSpan={2}>Total</td>
                    <td className="px-3 py-1.5">{fmtNumber(pva.totals.planned)}</td><td className="px-3 py-1.5">{fmtNumber(pva.totals.good)}</td>
                    <td className="px-3 py-1.5">{fmtNumber(pva.totals.rework)}</td><td className="px-3 py-1.5">{fmtNumber(pva.totals.reject)}</td>
                    <td className="px-3 py-1.5">{fmtNumber(pva.totals.balance)}</td><td className="px-3 py-1.5">{pva.totals.achievement_pct}%</td>
                    <td className="px-3 py-1.5">{pva.totals.rework_pct}%</td><td className="px-3 py-1.5">{pva.totals.reject_pct}%</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        {tab === 'util' && (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>{['Line', 'Supervisor', 'Capacity', 'Allocated', 'Planned', 'Actual', 'Allocation %', 'Plan %', 'Achievement'].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
            </thead>
            <tbody>
              {util.map((r) => (
                <tr key={r.line_id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 font-mono text-brand-700">{r.line_code}</td><td className="px-3 py-1.5">{r.supervisor_name || '—'}</td>
                  <td className="px-3 py-1.5">{fmtNumber(r.capacity)}</td><td className="px-3 py-1.5">{fmtNumber(r.allocated)}</td>
                  <td className="px-3 py-1.5">{fmtNumber(r.planned)}</td><td className="px-3 py-1.5 font-medium text-emerald-700">{fmtNumber(r.actual)}</td>
                  <td className="px-3 py-1.5"><UtilBar value={r.allocation_util_pct} width="w-14" /></td>
                  <td className="px-3 py-1.5"><UtilBar value={r.plan_util_pct} width="w-14" /></td>
                  <td className="px-3 py-1.5"><UtilBar value={r.achievement_pct} width="w-14" /></td>
                </tr>
              ))}
              {!util.length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">No active lines</td></tr>}
            </tbody>
          </table>
        )}
        {tab === 'alloc' && (
          <div>
            <div className="px-3 pb-2">
              <Select label="Group by" className="w-40" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}
                options={[['job', 'Job'], ['style', 'Style'], ['colour', 'Colour'], ['size', 'Size'], ['line', 'Line']].map(([v, l]) => ({ value: v, label: l }))} />
            </div>
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>{['Group', 'Bundles', 'Lines', 'Allocated', 'Completed', 'Open'].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
              </thead>
              <tbody>
                {alloc.map((r) => (
                  <tr key={String(r.group_key)} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 font-medium">{r.group_key ?? '—'}</td><td className="px-3 py-1.5">{r.bundles}</td><td className="px-3 py-1.5">{r.lines}</td>
                    <td className="px-3 py-1.5">{fmtNumber(r.allocated)}</td><td className="px-3 py-1.5 text-emerald-700">{fmtNumber(r.completed)}</td>
                    <td className="px-3 py-1.5 text-amber-700">{fmtNumber(r.open_qty)}</td>
                  </tr>
                ))}
                {!alloc.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">No allocations in this period</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Kpis({ items }: { items: [string, unknown][] }) {
  return (
    <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4 lg:grid-cols-7">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-[10px] text-slate-500">{k}</p>
          <p className="text-lg font-bold text-slate-800">{typeof v === 'number' ? fmtNumber(v) : String(v)}</p>
        </div>
      ))}
    </div>
  );
}
