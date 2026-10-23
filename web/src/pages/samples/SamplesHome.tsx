import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, Plus, Settings2, X } from 'lucide-react';
import { PageHeader, Card, Button, Select, Input, Tabs, SearchInput, useDebounced, Badge, LoadingBlock, ErrorState } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate, fmtDateTime, fmtNumber } from '../../lib/format';
import {
  SampleStatus, STATUS_LABEL, SAMPLE_STATUSES, AllocState, ALLOC_STATUS_TONE, Kpi, BarList, ReasonModal, inr, errMsg, daysLabel,
} from './sampleShared';

/**
 * Samples (client 23-Oct-2026 — "Sample-to-Order Profitability" spec §6.1, §6.2, §13): live dashboard, the register,
 * the allocation approval queue and the sample reports. A KPI card opens the register with the same filter, so the
 * numbers always match. Filters live in the URL (shareable, survive a reload).
 */
type Tab = 'dashboard' | 'register' | 'allocations' | 'reports';

const KPI_LABEL: Record<string, string> = {
  active: 'Active', due_today: 'Due today', overdue: 'Overdue', on_hold: 'On hold', pending_internal: 'Pending internal approval',
  pending_buyer: 'Pending buyer response', completed_month: 'Completed this month', unassigned: 'No owner', idle: 'No activity',
  awaiting_resubmission: 'Awaiting resubmission', cost_approval: 'Cost approval pending', alloc_pending: 'Cost not allocated',
  alloc_exception: 'Allocation exception', purchases_to_import: 'Purchases to import', target_changed: 'Target date changed',
};

function csv(name: string, cols: { key: string; header: string }[], rows: any[]) {
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const body = [cols.map((c) => esc(c.header)).join(','), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function SamplesHomePage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as Tab) || 'dashboard';
  const setTab = (t: string) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  const openRegister = (extra: Record<string, string>) => {
    const n = new URLSearchParams(); n.set('tab', 'register');
    for (const k of ['buyer_id', 'sample_type_id']) if (sp.get(k)) n.set(k, sp.get(k)!);
    for (const [k, v] of Object.entries(extra)) n.set(k, v);
    setSp(n);
  };
  return (
    <div>
      <PageHeader title="Samples" breadcrumb={['Orders']}
        subtitle="Sample requests, stages, cost per piece, buyer approval — and the sample cost carried into the order's profit"
        actions={<>
          {can('SAMPLE.ADMIN') && <Button variant="secondary" onClick={() => nav('/masters/sample-types')}><Settings2 size={15} />Sample types</Button>}
          {can('SAMPLE.CREATE') && <Button id="sample-new" onClick={() => nav('/sales/samples/new')}><Plus size={15} />New sample</Button>}
        </>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'dashboard', label: 'Dashboard' }, { key: 'register', label: 'Register' },
        { key: 'allocations', label: 'Cost allocation' }, { key: 'reports', label: 'Reports' },
      ]} />
      {tab === 'dashboard' && <Dashboard openRegister={openRegister} />}
      {tab === 'register' && <Register />}
      {tab === 'allocations' && <Allocations />}
      {tab === 'reports' && <Reports />}
    </div>
  );
}

/* ================================================================ dashboard */
function Dashboard({ openRegister }: { openRegister: (f: Record<string, string>) => void }) {
  const [sp, setSp] = useSearchParams();
  const buyers = useLookup('buyers');
  const types = useLookup('sample-types');
  const f = { buyer_id: sp.get('buyer_id') ?? '', sample_type_id: sp.get('sample_type_id') ?? '', from: sp.get('from') ?? '', to: sp.get('to') ?? '' };
  const setF = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const q = useQuery({
    queryKey: ['samples-dashboard', f],
    queryFn: async () => (await http.get<{ data: any }>('/samples-dashboard', f)).data,
    refetchInterval: 120_000,
  });
  const d = q.data;
  const k = d?.kpis;
  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <Select label="Buyer" className="w-52" placeholder="All buyers" options={toOptions(buyers.data)} value={f.buyer_id} onChange={(e) => setF('buyer_id', e.target.value)} />
        <Select label="Sample type" className="w-48" placeholder="All types" options={toOptions(types.data)} value={f.sample_type_id} onChange={(e) => setF('sample_type_id', e.target.value)} />
        <Input label="Requested from" type="date" className="w-40" value={f.from} onChange={(e) => setF('from', e.target.value)} />
        <Input label="to" type="date" className="w-40" value={f.to} onChange={(e) => setF('to', e.target.value)} />
        {d && <span className="ml-auto text-[11.5px] text-slate-400">As of {fmtDate(d.as_of)} · costs approved / posted, INR</span>}
      </div>
      {q.isLoading ? <div className="card"><LoadingBlock rows={6} /></div> : q.error ? <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : d && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" id="sample-kpis">
            <Kpi id="kpi-active" label="Active samples" value={k.active} tone="blue" onClick={() => openRegister({ kpi: 'active' })} />
            <Kpi id="kpi-due" label="Due today" value={k.due_today} tone="amber" onClick={() => openRegister({ kpi: 'due_today' })} />
            <Kpi id="kpi-overdue" label="Overdue" value={k.overdue} tone="red" onClick={() => openRegister({ kpi: 'overdue' })} />
            <Kpi label="On hold" value={k.on_hold} tone="amber" onClick={() => openRegister({ kpi: 'on_hold' })} />
            <Kpi label="Pending internal approval" value={k.pending_internal} tone="violet" onClick={() => openRegister({ kpi: 'pending_internal' })} />
            <Kpi label="Pending buyer response" value={k.pending_buyer} tone="indigo" onClick={() => openRegister({ kpi: 'pending_buyer' })} />
            <Kpi label="Completed this month" value={k.completed_month} tone="green" onClick={() => openRegister({ kpi: 'completed_month' })} />
            <Kpi id="kpi-cost" label="Cumulative cost" value={inr(k.cumulative_cost, '₹ 0')} sub={`Today ${inr(k.today_cost, '₹ 0')}`} tone="slate" onClick={() => openRegister({})} />
            <Kpi label="Avg cost / piece" value={inr(k.avg_cost_per_piece)} tone="slate" />
            <Kpi label="Allocated to orders" value={inr(k.allocated_cost, '₹ 0')} tone="green" />
            <Kpi id="kpi-unallocated" label="Not yet allocated" value={inr(k.unallocated_cost, '₹ 0')} tone="amber" onClick={() => openRegister({ kpi: 'alloc_pending' })} />
          </div>
          {d.exceptions.length > 0 && (
            <Card title={<span className="flex items-center gap-2"><AlertTriangle size={15} className="text-amber-600" />Exceptions</span>}>
              <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4" id="sample-exceptions">
                {d.exceptions.map((e: any) => (
                  <button key={e.key} type="button" onClick={() => openRegister({ kpi: e.key })}
                    className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-left hover:border-amber-400">
                    <p className="text-[12px] font-semibold text-amber-900">{e.label}</p>
                    <p className="text-[20px] font-bold text-amber-800">{e.count}</p>
                    <p className="truncate text-[11px] text-amber-700">{e.samples.map((s: any) => s.sample_no).join(', ')}{e.count > e.samples.length ? ' …' : ''}</p>
                  </button>
                ))}
              </div>
            </Card>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Current stage (open samples)"><div className="p-4"><BarList rows={d.stage_distribution} /></div></Card>
            <Card title="Ageing (days since request, open samples)"><div className="p-4"><BarList rows={d.ageing} /></div></Card>
            <Card title="Buyer load (open samples)"><div className="p-4"><BarList rows={d.buyer_load} /></div></Card>
            <Card title="Cost by sample type"><div className="p-4"><BarList rows={d.cost_by_type} money empty="No approved / posted cost yet" /></div></Card>
          </div>
          <Card title="Daily sample cost — last 30 days (approved / posted, reversals negative)">
            <div className="flex h-36 items-end gap-1 p-4" id="sample-trend">
              {d.daily_cost.map((t: any) => {
                const max = Math.max(1, ...d.daily_cost.map((x: any) => Math.abs(x.amount)));
                return <div key={t.date} title={`${fmtDate(t.date)}: ${inr(t.amount, '₹ 0')}`} className={`flex-1 rounded-t ${t.amount < 0 ? 'bg-red-400' : 'bg-brand-500'}`}
                  style={{ height: `${Math.max(t.amount ? 3 : 1, (Math.abs(t.amount) / max) * 100)}%`, opacity: t.amount ? 1 : 0.25 }} />;
              })}
            </div>
          </Card>
          <Card title="Pending work by department / person">
            <div className="overflow-x-auto">
              <table className="w-full" id="sample-pending-owner">
                <thead><tr><th className="th">Department</th><th className="th">Owner</th><th className="th text-right">Open</th><th className="th text-right">Overdue</th><th className="th text-right">Oldest (days)</th><th className="th text-right">Average (days)</th></tr></thead>
                <tbody>
                  {d.pending_by_owner.length === 0 && <tr><td className="td text-center text-slate-400" colSpan={6}>No open stages</td></tr>}
                  {d.pending_by_owner.map((r: any) => (
                    <tr key={`${r.department}|${r.owner}`} className="row-hover">
                      <td className="td">{r.department}</td>
                      <td className="td">{r.owner === 'Unassigned' ? <Badge tone="red">Unassigned</Badge> : r.owner}</td>
                      <td className="td text-right tabular-nums">{r.open}</td>
                      <td className="td text-right tabular-nums">{r.overdue ? <span className="font-semibold text-red-600">{r.overdue}</span> : 0}</td>
                      <td className="td text-right tabular-nums">{r.oldest_days}</td>
                      <td className="td text-right tabular-nums">{r.avg_days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/* ================================================================ register */
const REG_COLS: (Column<any> & { csv?: (r: any) => unknown })[] = [
  { key: 'sample_no', header: 'Sample no', sortable: true, render: (r) => <Link className="font-mono text-[12px] font-semibold text-brand-700 hover:underline" to={`/sales/samples/${r.id}`}>{r.sample_no}</Link> },
  { key: 'buyer_name', header: 'Buyer / style', sortable: true, render: (r) => <div><p className="font-medium">{r.buyer_name}</p><p className="text-[11px] text-slate-500">{r.style_code} · {r.type_name ?? r.sample_type}{r.revision_no ? ` · rev ${r.revision_no}` : ''}</p></div> },
  { key: 'priority', header: 'Priority', render: (r) => r.priority === 'NORMAL' ? <span className="text-slate-500">Normal</span> : <Badge tone={r.priority === 'CRITICAL' ? 'red' : 'amber'}>{r.priority === 'CRITICAL' ? 'Critical' : 'High'}</Badge> },
  { key: 'target_date', header: 'Requested / target', sortable: true, render: (r) => <div className="text-[12px]"><p>{fmtDate(r.request_date)}</p><p className={r.overdue ? 'font-semibold text-red-600' : 'text-slate-500'}>→ {fmtDate(r.target_date)}{r.completed_date ? ` · done ${fmtDate(r.completed_date)}` : ''}</p></div> },
  { key: 'status', header: 'Status', sortable: true, render: (r) => <SampleStatus value={r.status} /> },
  { key: 'current_stage', header: 'Current stage / owner', render: (r) => r.current_stage ? <div className="text-[12px]"><p className="font-medium">{r.current_stage}{r.current_stage_status === 'ON_HOLD' ? ' (on hold)' : ''}</p>
    <p className="text-slate-500">{r.pending_department ?? '—'} · {r.pending_owner ?? <span className="font-semibold text-red-600">no owner</span>}</p></div> : <span className="text-slate-400">—</span> },
  { key: 'elapsed_days', header: 'Elapsed / delay', sortable: true, align: 'right', render: (r) => <div className="text-[12px] tabular-nums"><p title={`${r.elapsed_working_days ?? '—'} working days`}>{daysLabel(r.elapsed_days)} <span className="text-slate-400">({r.elapsed_working_days ?? '—'} wd)</span></p>
    {r.delay_days ? <p className="font-semibold text-red-600">+{r.delay_days} d late</p> : null}{r.process_age_days != null ? <p className="text-slate-500">stage {r.process_age_days} d</p> : null}</div> },
  { key: 'stages_done', header: 'Progress', align: 'right', render: (r) => <div className="text-[12px] tabular-nums"><p>{r.stages_done}/{r.stages_total}</p><p className="text-slate-500">{fmtNumber(r.good_qty_total)} good · {fmtNumber(r.reject_qty_total)} rej · {fmtNumber(r.rework_qty_total)} rw</p></div> },
  { key: 'cumulative_cost', header: 'Today / cumulative', sortable: true, align: 'right', render: (r) => <div className="text-[12px] tabular-nums"><p className="text-slate-500">{inr(r.today_cost, '₹ 0')}</p><p className="font-semibold">{inr(r.cumulative_cost, '₹ 0')}</p></div> },
  { key: 'cost_per_piece', header: '₹ / piece · avg / day', sortable: true, align: 'right', render: (r) => <div className="text-[12px] tabular-nums"><p>{inr(r.cost_per_piece)}</p><p className="text-slate-500">{inr(r.avg_daily_cost_per_piece)}</p></div> },
  { key: 'allocation_state', header: 'Order allocation', render: (r) => <div className="text-[12px]"><AllocState value={r.allocation_state} />{r.allocated_cost > 0 && <p className="mt-0.5 tabular-nums text-slate-500">{inr(r.allocated_cost)} to {r.allocated_orders} order(s)</p>}</div> },
  { key: 'next_action', header: 'Next action', render: (r) => <span className="text-[12px] text-slate-600">{r.next_action}</span> },
];
const CSV_COLS = [
  { key: 'sample_no', header: 'Sample no' }, { key: 'buyer_name', header: 'Buyer' }, { key: 'style_code', header: 'Style' }, { key: 'type_name', header: 'Type' },
  { key: 'priority', header: 'Priority' }, { key: 'qty', header: 'Qty' }, { key: 'request_date', header: 'Request date' }, { key: 'target_date', header: 'Target date' },
  { key: 'completed_date', header: 'Completed' }, { key: 'status', header: 'Status' }, { key: 'revision_no', header: 'Revision' }, { key: 'current_stage', header: 'Current stage' },
  { key: 'pending_department', header: 'Pending department' }, { key: 'pending_owner', header: 'Pending owner' }, { key: 'elapsed_days', header: 'Elapsed days' },
  { key: 'elapsed_working_days', header: 'Working days' }, { key: 'delay_days', header: 'Delay days' }, { key: 'process_age_days', header: 'Stage age days' },
  { key: 'stages_done', header: 'Stages done' }, { key: 'stages_total', header: 'Stages' }, { key: 'today_cost', header: "Today's cost" }, { key: 'cumulative_cost', header: 'Cumulative cost' },
  { key: 'cost_per_piece', header: 'Cost per piece' }, { key: 'cost_per_good_piece', header: 'Cost per good piece' }, { key: 'avg_daily_cost_per_piece', header: 'Avg daily cost per piece' },
  { key: 'eligible_cost', header: 'Eligible cost' }, { key: 'allocated_cost', header: 'Allocated' }, { key: 'unallocated_cost', header: 'Unallocated' }, { key: 'allocation_state', header: 'Allocation' },
  { key: 'next_action', header: 'Next action' },
];

function Register() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const buyers = useLookup('buyers');
  const types = useLookup('sample-types');
  const depts = useLookup('departments');
  const users = useLookup('users');
  const get = (k: string) => sp.get(k) ?? '';
  const setF = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); n.delete('page'); setSp(n, { replace: true }); };
  const [q, setQ] = useState(get('q'));
  const dq = useDebounced(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (dq !== get('q')) setF('q', dq); }, [dq]);
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    for (const k of ['q', 'status', 'sample_type_id', 'buyer_id', 'priority', 'department_id', 'owner_user_id', 'kpi', 'from', 'to', 'sort', 'dir', 'page']) if (sp.get(k)) p[k] = sp.get(k)!;
    return p;
  }, [sp]);
  const list = useQuery({
    queryKey: ['samples', params],
    queryFn: async () => http.get<{ data: any[]; totals: any; pagination: any }>('/samples', { pageSize: 25, ...params }),
  });
  const sort = params.sort ? { key: params.sort, dir: (params.dir as 'asc' | 'desc') ?? 'desc' } : undefined;
  const exportCsv = async () => { const all = await http.get<{ data: any[] }>('/samples', { ...params, page: 1, pageSize: 500 }); csv('samples', CSV_COLS, all.data); };
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2.5 p-3">
        <SearchInput className="w-60" value={q} onChange={setQ} placeholder="Sample no, style, buyer…" />
        <Select className="w-44" placeholder="All statuses" options={SAMPLE_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} value={get('status')} onChange={(e) => setF('status', e.target.value)} />
        <Select className="w-40" placeholder="All types" options={toOptions(types.data)} value={get('sample_type_id')} onChange={(e) => setF('sample_type_id', e.target.value)} />
        <Select className="w-48" placeholder="All buyers" options={toOptions(buyers.data)} value={get('buyer_id')} onChange={(e) => setF('buyer_id', e.target.value)} />
        <Select className="w-32" placeholder="Any priority" options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'HIGH', label: 'High' }, { value: 'CRITICAL', label: 'Critical' }]} value={get('priority')} onChange={(e) => setF('priority', e.target.value)} />
        <Select className="w-44" placeholder="Pending department" options={toOptions(depts.data)} value={get('department_id')} onChange={(e) => setF('department_id', e.target.value)} />
        <Select className="w-44" placeholder="Pending with (employee)" options={toOptions(users.data)} value={get('owner_user_id')} onChange={(e) => setF('owner_user_id', e.target.value)} />
        <Select className="w-52" placeholder="Quick filter" options={Object.entries(KPI_LABEL).map(([value, label]) => ({ value, label }))} value={get('kpi')} onChange={(e) => setF('kpi', e.target.value)} />
        <Button variant="secondary" className="ml-auto" onClick={() => void exportCsv()}><Download size={14} />Export</Button>
      </div>
      {get('kpi') && (
        <div className="flex items-center gap-2 text-[12.5px]" id="register-kpi-chip">
          <Badge tone="indigo">{KPI_LABEL[get('kpi')] ?? get('kpi')}</Badge>
          <button className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800" onClick={() => setF('kpi', '')}><X size={13} />clear</button>
        </div>
      )}
      <DataTable columns={REG_COLS} rows={list.data?.data ?? []} loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r: any) => r.id} onRowClick={(r: any) => nav(`/sales/samples/${r.id}`)} emptyTitle="No samples" emptyMessage="No sample matches these filters."
        sort={sort} onSort={(k) => { const n = new URLSearchParams(sp); n.set('sort', k); n.set('dir', sort?.key === k && sort.dir === 'desc' ? 'asc' : 'desc'); setSp(n, { replace: true }); }}
        pagination={list.data?.pagination} onPage={(p) => setF('page', String(p))} stickyFirst />
      {list.data?.totals && (
        <p className="text-right text-[12px] text-slate-500" id="register-totals">
          {list.data.pagination.total} samples · {fmtNumber(list.data.totals.qty)} pcs · today {inr(list.data.totals.today_cost, '₹ 0')} · cumulative {inr(list.data.totals.cumulative_cost, '₹ 0')} ·
          allocated {inr(list.data.totals.allocated_cost, '₹ 0')} · not allocated {inr(list.data.totals.unallocated_cost, '₹ 0')}
        </p>
      )}
    </div>
  );
}

/* ================================================================ allocation queue / register */
function Allocations() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState('PENDING_APPROVAL,APPROVED');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [busy, setBusy] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<any>(null);
  const list = useQuery({ queryKey: ['sample-allocations', status, dq], queryFn: async () => (await http.get<{ data: any[] }>('/sample-allocations', { status: status || undefined, q: dq || undefined })).data });
  const act = async (b: any, action: string, reason?: string) => {
    setBusy(b.id);
    try {
      await http.post(`/sample-allocations/${b.id}/${action}`, { reason, row_version: b.row_version });
      toast(`${b.batch_no}: ${action === 'post' ? 'posted to the order P&L' : action === 'approve' ? 'approved' : 'rejected'}`);
      setRejecting(null);
      void qc.invalidateQueries({ queryKey: ['sample-allocations'] });
      void qc.invalidateQueries({ queryKey: ['samples'] });
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };
  const rows = list.data ?? [];
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2.5 p-3">
        <Select className="w-56" value={status} onChange={(e) => setStatus(e.target.value)} options={[
          { value: 'PENDING_APPROVAL,APPROVED', label: 'Approval queue' }, { value: 'DRAFT', label: 'Drafts' },
          { value: 'POSTED,PARTIALLY_REVERSED', label: 'Posted' }, { value: 'REVERSED,REJECTED,CANCELLED', label: 'Reversed / rejected / cancelled' }, { value: '', label: 'All' },
        ]} />
        <SearchInput className="w-64" value={q} onChange={setQ} placeholder="Batch, sample, style, buyer, order…" />
        <span className="ml-auto text-[11.5px] text-slate-500">Analytical allocation: shown in the order's Budget vs Actuals; no GL journal (the sample expense is counted once).</span>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full" id="alloc-register">
          <thead><tr><th className="th">Batch</th><th className="th">Sample</th><th className="th">Orders</th><th className="th">Method</th><th className="th text-right">Amount</th><th className="th">Status</th><th className="th">Reason / by</th><th className="th" /></tr></thead>
          <tbody>
            {list.isLoading && <tr><td colSpan={8}><LoadingBlock rows={3} /></td></tr>}
            {!list.isLoading && !rows.length && <tr><td className="td py-8 text-center text-slate-400" colSpan={8}>Nothing here</td></tr>}
            {rows.map((b) => (
              <tr key={b.id} className="row-hover align-top">
                <td className="td font-mono text-[12px] font-semibold">{b.batch_no}<p className="font-sans text-[11px] font-normal text-slate-400">{fmtDateTime(b.created_at)}</p></td>
                <td className="td"><Link className="font-mono text-[12px] text-brand-700 hover:underline" to={`/sales/samples/${b.sample_id}?tab=allocation`}>{b.sample_no}</Link><p className="text-[11px] text-slate-500">{b.buyer_name} · {b.style_code}</p></td>
                <td className="td text-[12px]">{b.lines.map((l: any) => (
                  <p key={l.id} className={l.status === 'REVERSED' ? 'text-slate-400 line-through' : ''}>
                    <Link to={`/sales/orders/${l.so_id}`} className="hover:underline">{l.so_no}</Link> · {inr(l.allocated_amount)}{l.is_override ? <Badge tone="amber" className="ml-1">override</Badge> : null}
                  </p>))}</td>
                <td className="td text-[12px]">{b.method}</td>
                <td className="td text-right tabular-nums font-semibold">{inr(b.total_allocated)}{Number(b.live_amount) !== Number(b.total_allocated) && ['POSTED', 'PARTIALLY_REVERSED', 'REVERSED'].includes(b.status) ? <p className="text-[11px] font-normal text-slate-500">live {inr(b.live_amount)}</p> : null}</td>
                <td className="td"><Badge tone={ALLOC_STATUS_TONE[b.status] ?? 'slate'}>{b.status.replace(/_/g, ' ')}</Badge></td>
                <td className="td max-w-[260px] text-[12px] text-slate-600">{b.reason}{b.override_reason ? <p className="text-amber-700">Override: {b.override_reason}</p> : null}{b.reject_reason ? <p className="text-red-600">{b.reject_reason}</p> : null}<p className="text-[11px] text-slate-400">{b.created_by_name}{b.posted_by_name ? ` · posted ${b.posted_by_name}` : ''}</p></td>
                <td className="td whitespace-nowrap">
                  {can('SAMPLE.ALLOC_APPROVE') && b.status === 'PENDING_APPROVAL' && <Button size="sm" variant="secondary" loading={busy === b.id} onClick={() => void act(b, 'approve')}>Approve</Button>}
                  {can('SAMPLE.ALLOC_APPROVE') && ['PENDING_APPROVAL', 'APPROVED'].includes(b.status) && <Button size="sm" className="ml-1" loading={busy === b.id} id={`alloc-post-${b.id}`} onClick={() => void act(b, 'post')}>Post</Button>}
                  {can('SAMPLE.ALLOC_APPROVE') && ['PENDING_APPROVAL', 'APPROVED'].includes(b.status) && <Button size="sm" variant="ghost" className="ml-1 text-red-600" onClick={() => setRejecting(b)}>Reject</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReasonModal key={rejecting?.id ?? 0} open={!!rejecting} title={`Reject ${rejecting?.batch_no ?? ''}`} confirmLabel="Reject" danger busy={busy === rejecting?.id}
        onClose={() => setRejecting(null)} onConfirm={(r) => void act(rejecting, 'reject', r)} />
    </div>
  );
}

/* ================================================================ reports */
const REPORTS: Record<string, { title: string; endpoint: string; cols: { key: string; header: string; money?: boolean; link?: boolean }[] }> = {
  unallocated: { title: 'Unallocated sample cost', endpoint: '/sample-reports/unallocated', cols: [
    { key: 'sample_no', header: 'Sample', link: true }, { key: 'buyer_name', header: 'Buyer' }, { key: 'style_code', header: 'Style' }, { key: 'type_name', header: 'Type' },
    { key: 'status', header: 'Status' }, { key: 'cumulative_cost', header: 'Cumulative', money: true }, { key: 'eligible_cost', header: 'Eligible (posted)', money: true },
    { key: 'allocated_cost', header: 'Allocated', money: true }, { key: 'pending_allocation', header: 'Awaiting approval', money: true }, { key: 'unallocated_cost', header: 'Remaining', money: true },
    { key: 'confirmed_orders', header: 'Confirmed orders (buyer + style)' }, { key: 'days_since_completion', header: 'Days since completion' },
  ] },
  'cost-sheet': { title: 'Sample cost sheet', endpoint: '/sample-reports/cost-sheet', cols: [
    { key: 'sample_no', header: 'Sample', link: true }, { key: 'buyer_name', header: 'Buyer' }, { key: 'style_code', header: 'Style' }, { key: 'qty', header: 'Qty' }, { key: 'good_qty', header: 'Good' },
    { key: 'elapsed_days', header: 'Days' }, { key: 'material', header: 'Material', money: true }, { key: 'labour', header: 'Labour', money: true }, { key: 'cad_pattern', header: 'CAD', money: true },
    { key: 'subcontract', header: 'Subcontract', money: true }, { key: 'consumable', header: 'Consumables', money: true }, { key: 'courier', header: 'Courier', money: true },
    { key: 'rework', header: 'Rework', money: true }, { key: 'overhead', header: 'Overhead (alloc.)', money: true }, { key: 'adjustment', header: 'Adjustment', money: true },
    { key: 'today_cost', header: 'Today', money: true }, { key: 'cumulative_cost', header: 'Cumulative', money: true }, { key: 'cost_per_piece', header: '₹/piece', money: true },
    { key: 'cost_per_good_piece', header: '₹/good piece', money: true }, { key: 'avg_daily_cost_per_piece', header: '₹/piece/day', money: true }, { key: 'pending_cost', header: 'Not approved yet', money: true },
  ] },
  history: { title: 'Buyer / style sample history', endpoint: '/sample-reports/history', cols: [
    { key: 'sample_no', header: 'Sample', link: true }, { key: 'buyer_name', header: 'Buyer' }, { key: 'style_code', header: 'Style' }, { key: 'type_name', header: 'Type' }, { key: 'status', header: 'Status' },
    { key: 'revisions', header: 'Revisions' }, { key: 'submissions', header: 'Submissions' }, { key: 'approved', header: 'Approved' }, { key: 'rejected', header: 'Rejected' },
    { key: 'changes_requested', header: 'Changes requested' }, { key: 'cumulative_cost', header: 'Cost', money: true }, { key: 'request_date', header: 'Requested' }, { key: 'completed_date', header: 'Completed' },
  ] },
};
function Reports() {
  const [sp, setSp] = useSearchParams();
  const key = sp.get('report') ?? 'unallocated';
  const def = REPORTS[key] ?? REPORTS.unallocated;
  const buyers = useLookup('buyers');
  const buyer = sp.get('buyer_id') ?? '';
  const q = useQuery({ queryKey: ['sample-report', key, buyer], queryFn: async () => (await http.get<{ data: any[] }>(def.endpoint, { buyer_id: buyer || undefined })).data });
  const rows = q.data ?? [];
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2.5 p-3">
        <Select className="w-64" label="Report" value={key} onChange={(e) => set('report', e.target.value)} options={Object.entries(REPORTS).map(([value, r]) => ({ value, label: r.title }))} />
        <Select className="w-52" label="Buyer" placeholder="All buyers" options={toOptions(buyers.data)} value={buyer} onChange={(e) => set('buyer_id', e.target.value)} />
        <Button variant="secondary" className="ml-auto" onClick={() => csv(key, def.cols, rows)}><Download size={14} />Export</Button>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full" id={`report-${key}`}>
          <thead><tr>{def.cols.map((c) => <th key={c.key} className={`th ${c.money ? 'text-right' : ''}`}>{c.header}</th>)}</tr></thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={def.cols.length}><LoadingBlock rows={3} /></td></tr>}
            {!q.isLoading && !rows.length && <tr><td className="td py-8 text-center text-slate-400" colSpan={def.cols.length}>No rows</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="row-hover">
                {def.cols.map((c) => (
                  <td key={c.key} className={`td text-[12px] ${c.money ? 'text-right tabular-nums' : ''}`}>
                    {c.link ? <Link className="font-mono text-brand-700 hover:underline" to={`/sales/samples/${r.id}`}>{r[c.key]}</Link>
                      : c.key === 'status' ? <SampleStatus value={r.status} /> : c.money ? inr(r[c.key], r[c.key] === undefined ? '—' : 'N/A')
                        : /_date$/.test(c.key) ? fmtDate(r[c.key]) : r[c.key] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot><tr className="bg-slate-50 font-semibold">{def.cols.map((c, i) => (
              <td key={c.key} className={`td text-[12px] ${c.money ? 'text-right tabular-nums' : ''}`}>
                {i === 0 ? `${rows.length} samples` : c.money && !/per_|piece/.test(c.key) ? inr(rows.reduce((t, r) => t + (Number(r[c.key]) || 0), 0), '₹ 0') : ''}
              </td>))}</tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
