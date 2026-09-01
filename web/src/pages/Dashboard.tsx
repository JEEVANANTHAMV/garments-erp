import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell, Legend
} from 'recharts';
import {
  ShoppingCart, Factory, Ship, ClipboardCheck, AlertTriangle, ArrowRight, Clock
} from 'lucide-react';
import { http } from '../lib/api';
import { fmtNumber, fmtCompact, fmtDate, humanize } from '../lib/format';
import { PageHeader, LoadingBlock, ErrorState, StatusBadge, Badge } from '../components/ui';

/* Chart palette — distinct hues, consistent across the dashboard. */
const PALETTE = ['#3663f3', '#12b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

interface Summary {
  orders: Record<string, number | string>;
  production: Record<string, number | string>;
  shipments: Record<string, number | string>;
  quality: Record<string, number | string>;
  ordersByMonth: { month: string; orders: number; qty: string; value: string }[];
  topBuyers: { id: number; buyer_name: string; orders: number; qty: string; value: string }[];
  ordersByStatus: { status: string; count: number; value: string }[];
  upcomingShipments: {
    id: number; so_no: string; ship_date: string; order_qty: number;
    buyer_name: string; currency_code: string; total_amount: string; days_remaining: number;
  }[];
  productionPipeline: {
    stage_code: string; stage_name: string; input_qty: string; output_qty: string; rejected_qty: string;
  }[];
  stockValue: { stock_value: string };
  pendingApprovals: { pending: number };
  lowStockAlerts: { material_type: string; item_name: string; item_code: string; balance: string }[];
}

export default function Dashboard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: async () => (await http.get<{ data: Summary }>('/dashboard/summary')).data,
  });

  const { data: tna } = useQuery({
    queryKey: ['tna-alerts'],
    queryFn: async () => (await http.get<{ data: any[] }>('/dashboard/tna-alerts')).data,
  });

  if (isLoading) return <><PageHeader title="Dashboard" /><div className="card"><LoadingBlock rows={8} /></div></>;
  if (error) return <><PageHeader title="Dashboard" /><div className="card"><ErrorState error={error} onRetry={() => void refetch()} /></div></>;
  if (!data) return null;

  const o = data.orders, p = data.production, s = data.shipments, q = data.quality;
  const passRate = Number(q.total_inspections) > 0
    ? (Number(q.passed) / Number(q.total_inspections)) * 100 : 0;
  const prodProgress = Number(p.planned_qty) > 0
    ? (Number(p.produced_qty) / Number(p.planned_qty)) * 100 : 0;

  const monthly = data.ordersByMonth.map((m) => ({
    month: new Date(m.month + '-01').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
    Orders: m.orders,
    Value: Number(m.value),
    Qty: Number(m.qty),
  }));

  const pipeline = data.productionPipeline.map((x) => ({
    stage: x.stage_name,
    Output: Number(x.output_qty),
    Rejected: Number(x.rejected_qty),
  }));

  const statusPie = data.ordersByStatus.map((x) => ({ name: humanize(x.status), value: x.count }));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Live view of orders, production, quality and shipments"
      />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={ShoppingCart} tone="brand" label="Sales Orders" value={fmtNumber(o.total_orders)}
          sub={`${fmtNumber(o.total_qty)} pcs · ${fmtCompact(o.total_value)} value`}
          foot={`${fmtNumber(o.approved_orders)} approved · ${fmtNumber(o.draft_orders)} draft`} />
        <Kpi icon={Factory} tone="violet" label="Production" value={fmtNumber(p.produced_qty)}
          sub={`of ${fmtNumber(p.planned_qty)} pcs planned`}
          progress={prodProgress}
          foot={`${fmtNumber(p.in_progress)} orders in progress`} />
        <Kpi icon={ClipboardCheck} tone="emerald" label="Quality Pass Rate" value={`${passRate.toFixed(1)}%`}
          sub={`${fmtNumber(q.passed)} passed / ${fmtNumber(q.total_inspections)} inspections`}
          progress={passRate}
          foot={`${fmtNumber(q.total_defects)} defects logged`} />
        <Kpi icon={Ship} tone="amber" label="Shipments" value={fmtNumber(s.total_shipments)}
          sub={`${fmtNumber(s.in_transit)} in transit · ${fmtNumber(s.delivered)} delivered`}
          foot={`Stock value ${fmtCompact(data.stockValue?.stock_value, '₹')}`} />
      </div>

      {/* Charts */}
      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <h3 className="mb-3 text-[14px] font-semibold text-slate-800">Order intake — last 12 months</h3>
          {monthly.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={monthly} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gQty" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3663f3" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#3663f3" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => fmtCompact(v)} />
                <Tooltip contentStyle={tooltipStyle} formatter={((v: unknown, n: unknown) => [fmtNumber(v), n]) as never} />
                <Area type="monotone" dataKey="Qty" stroke="#3663f3" strokeWidth={2}
                  fill="url(#gQty)" name="Order Qty (pcs)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : <Placeholder text="No order history yet" />}
        </div>

        <div className="card p-4">
          <h3 className="mb-3 text-[14px] font-semibold text-slate-800">Orders by status</h3>
          {statusPie.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={statusPie} dataKey="value" nameKey="name" cx="50%" cy="45%"
                  innerRadius={52} outerRadius={82} paddingAngle={2}>
                  {statusPie.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
                <Legend verticalAlign="bottom" height={36}
                  wrapperStyle={{ fontSize: 11, color: '#64748b' }} iconType="circle" iconSize={8} />
              </PieChart>
            </ResponsiveContainer>
          ) : <Placeholder text="No orders yet" />}
        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <h3 className="mb-3 text-[14px] font-semibold text-slate-800">Production pipeline &amp; WIP by stage</h3>
          {pipeline.some((x) => x.Output > 0) ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={pipeline} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef1f5" vertical={false} />
                <XAxis dataKey="stage" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false}
                  tickLine={false} interval={0} angle={-25} textAnchor="end" height={54} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => fmtCompact(v)} />
                <Tooltip contentStyle={tooltipStyle} formatter={((v: unknown, n: unknown) => [fmtNumber(v), n]) as never} />
                <Bar dataKey="Output" fill="#3663f3" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Rejected" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Placeholder text="No production movements recorded" />}
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[14px] font-semibold text-slate-800">Live Stage WIP</h3>
            <Link to="/production/wip" className="text-xs font-medium text-brand-600 hover:text-brand-700 flex items-center gap-1">
              WIP View <ArrowRight size={12} />
            </Link>
          </div>
          {data.productionPipeline.length ? (
            <div className="space-y-2">
              {data.productionPipeline.map((s) => {
                const inQty = Number(s.input_qty || 0);
                const outQty = Number(s.output_qty || 0);
                const rejQty = Number(s.rejected_qty || 0);
                const wip = Math.max(0, inQty - outQty - rejQty);
                return (
                  <div key={s.stage_code} className="flex items-center justify-between text-xs py-1 border-b border-surface-border/50 last:border-0">
                    <span className="font-medium text-slate-700 truncate max-w-[130px]">{s.stage_name}</span>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums text-slate-500">{fmtNumber(outQty)} done</span>
                      <Badge tone={wip > 0 ? 'violet' : 'slate'}>
                        {fmtNumber(wip)} WIP
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <Placeholder text="No WIP data" pad />}
        </div>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4">
        <div className="card p-4">
          <h3 className="mb-3 text-[14px] font-semibold text-slate-800">Top buyers by order value</h3>
          {data.topBuyers.length ? (
            <div className="space-y-2.5">
              {data.topBuyers.slice(0, 6).map((b, i) => {
                const max = Number(data.topBuyers[0].value) || 1;
                const pct = (Number(b.value) / max) * 100;
                return (
                  <div key={b.id}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
                      <span className="truncate font-medium text-slate-700">{b.buyer_name}</span>
                      <span className="shrink-0 tabular-nums text-slate-500">
                        {fmtCompact(b.value)} · {fmtNumber(b.qty)} pcs
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, background: PALETTE[i % PALETTE.length] }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <Placeholder text="No buyer activity yet" />}
        </div>
      </div>

      {/* Operational lists */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
            <h3 className="text-[14px] font-semibold text-slate-800">Upcoming shipments</h3>
            <Link to="/sales/orders" className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700">
              All orders <ArrowRight size={13} />
            </Link>
          </div>
          {data.upcomingShipments.length ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr>
                  <th className="th">Order</th><th className="th">Buyer</th>
                  <th className="th">Ship date</th><th className="th text-right">Qty</th>
                  <th className="th text-right">Value</th><th className="th">Status</th>
                </tr></thead>
                <tbody>
                  {data.upcomingShipments.map((r) => (
                    <tr key={r.id} className="row-hover">
                      <td className="td font-medium text-brand-700">
                        <Link to={`/sales/orders/${r.id}`}>{r.so_no}</Link>
                      </td>
                      <td className="td max-w-[180px] truncate">{r.buyer_name}</td>
                      <td className="td whitespace-nowrap">{fmtDate(r.ship_date)}</td>
                      <td className="td text-right tabular-nums">{fmtNumber(r.order_qty)}</td>
                      <td className="td text-right tabular-nums">
                        {r.currency_code} {fmtNumber(r.total_amount, 0)}
                      </td>
                      <td className="td">
                        {r.days_remaining < 0
                          ? <Badge tone="red">{Math.abs(r.days_remaining)}d overdue</Badge>
                          : r.days_remaining <= 14
                            ? <Badge tone="amber">{r.days_remaining}d left</Badge>
                            : <Badge tone="green">{r.days_remaining}d left</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Placeholder text="No shipments scheduled" pad />}
        </div>

        <div className="space-y-4">
          <div className="card">
            <div className="flex items-center gap-2 border-b border-surface-border px-4 py-3">
              <Clock size={15} className="text-amber-500" />
              <h3 className="text-[14px] font-semibold text-slate-800">T&amp;A alerts</h3>
              {tna?.length ? <Badge tone="amber">{tna.length}</Badge> : null}
            </div>
            <div className="max-h-[210px] overflow-y-auto">
              {tna?.length ? tna.slice(0, 8).map((m) => (
                <div key={m.id} className="border-b border-surface-border/60 px-4 py-2.5 last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-slate-700">{m.milestone}</p>
                      <p className="text-[11px] text-slate-500">{m.so_no} · {fmtDate(m.planned_date)}</p>
                    </div>
                    {m.days_overdue > 0
                      ? <Badge tone="red">{m.days_overdue}d late</Badge>
                      : <StatusBadge value={m.status} />}
                  </div>
                </div>
              )) : <Placeholder text="All milestones on track" pad />}
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-2 border-b border-surface-border px-4 py-3">
              <AlertTriangle size={15} className="text-red-500" />
              <h3 className="text-[14px] font-semibold text-slate-800">Stock alerts</h3>
            </div>
            <div className="max-h-[210px] overflow-y-auto">
              {data.lowStockAlerts.length ? data.lowStockAlerts.map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-2 border-b border-surface-border/60 px-4 py-2.5 last:border-0">
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-medium text-slate-700">{a.item_name}</p>
                    <p className="text-[11px] text-slate-500">{a.item_code} · {a.material_type}</p>
                  </div>
                  <Badge tone={Number(a.balance) <= 0 ? 'red' : 'amber'}>
                    {fmtNumber(a.balance, 1)}
                  </Badge>
                </div>
              )) : <Placeholder text="Stock levels healthy" pad />}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const tooltipStyle = {
  fontSize: 12, borderRadius: 8, border: '1px solid #e4e7ec',
  boxShadow: '0 8px 24px -4px rgb(16 24 40 / 0.12)',
};

function Placeholder({ text, pad }: { text: string; pad?: boolean }) {
  return (
    <div className={`grid place-items-center text-[12.5px] text-slate-400 ${pad ? 'py-10' : 'h-[250px]'}`}>
      {text}
    </div>
  );
}

function Kpi({ icon: Icon, tone, label, value, sub, foot, progress }: {
  icon: typeof ShoppingCart; tone: 'brand' | 'violet' | 'emerald' | 'amber';
  label: string; value: string; sub?: string; foot?: string; progress?: number;
}) {
  const tones = {
    brand: 'bg-brand-50 text-brand-600', violet: 'bg-violet-50 text-violet-600',
    emerald: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600',
  };
  const bars = {
    brand: 'bg-brand-500', violet: 'bg-violet-500',
    emerald: 'bg-emerald-500', amber: 'bg-amber-500',
  };
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-[11.5px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-1.5 text-[26px] font-semibold leading-none tracking-tight text-slate-900">{value}</p>
          {sub && <p className="mt-1.5 text-[12px] text-slate-500">{sub}</p>}
        </div>
        <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${tones[tone]}`}>
          <Icon size={17} />
        </div>
      </div>
      {progress !== undefined && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full transition-all ${bars[tone]}`}
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      )}
      {foot && <p className="mt-2.5 border-t border-surface-border pt-2.5 text-[11.5px] text-slate-500">{foot}</p>}
    </div>
  );
}
