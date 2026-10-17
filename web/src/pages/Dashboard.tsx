import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell
} from 'recharts';
import {
  ShoppingCart, Factory, Ship, ClipboardCheck, AlertTriangle, ArrowRight, Clock,
  Plus, Layers, Package, ShieldCheck,
  Wallet, BarChart3, Settings as SettingsIcon, Boxes
} from 'lucide-react';
import { http } from '../lib/api';
import { fmtNumber, fmtCompact, fmtDate, humanize } from '../lib/format';
import { PageHeader, LoadingBlock, ErrorState, StatusBadge, Badge } from '../components/ui';

/* Chart palette — modern, crisp hues with emerald green primary. */
const PALETTE = ['#16a34a', '#22c55e', '#10b981', '#059669', '#0d9488', '#f59e0b', '#8b5cf6', '#ec4899'];

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
  const totalPieCount = statusPie.reduce((acc, curr) => acc + curr.value, 0);

  return (
    <>
      {/* Top Banner & Quick Actions (Reference 2 Information Architecture + Reference 1 White Theme) */}
      <div className="mb-6 rounded-2xl border border-surface-border bg-white p-5 shadow-card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-2 w-2 rounded-full bg-brand-500 animate-pulse" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-700">Enterprise Workspace</span>
            </div>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">
              Manufacturing Operations Dashboard
            </h1>
            <p className="mt-0.5 text-[13px] text-slate-500">
              Fashion Knits &amp; Garments Export Management System
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/sales/orders" className="btn-primary">
              <Plus size={14} /> New Sales Order
            </Link>
            <Link to="/procurement/purchase-orders" className="btn-secondary">
              <Plus size={14} /> New Purchase Order
            </Link>
            <Link to="/production/sewing-daily-output" className="btn-secondary">
              <Factory size={14} className="text-brand-600" /> Production Entry
            </Link>
            <Link to="/reports" className="btn-secondary">
              <BarChart3 size={14} className="text-slate-500" /> View Reports
            </Link>
          </div>
        </div>

        {/* Enterprise Workspaces Grid (Reference 2 inspired) */}
        <div className="mt-5 border-t border-surface-divider pt-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Workspaces</p>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-5 xl:grid-cols-5">
            {[
              { label: 'Orders & Sales', sub: 'Orders, BOM, T&A', to: '/sales/orders', icon: ShoppingCart },
              { label: 'Procurement', sub: 'Yarn, Fabric, Trims', to: '/procurement/purchase-orders', icon: Layers },
              { label: 'Gate & Stores', sub: 'Stock, Issues, Bins', to: '/inventory/stock', icon: Boxes },
              { label: 'Production', sub: 'Cutting, Sewing, Line', to: '/production/orders', icon: Factory },
              { label: 'Quality & QC', sub: 'AQL, Inspection, Defects', to: '/quality/inspections', icon: ShieldCheck },
              { label: 'Logistics & Export', sub: 'Packing, Shipment, BL', to: '/logistics/shipments', icon: Ship },
              { label: 'Finance & Bills', sub: 'Vouchers, Invoices, AP', to: '/finance/vouchers', icon: Wallet },
              { label: 'Masters', sub: 'Styles, Buyers, Colors', to: '/masters/parties', icon: Package },
              { label: 'MIS Reports', sub: 'Production, Cost, WIP', to: '/reports', icon: BarChart3 },
              { label: 'Administration', sub: 'Users, Roles, Config', to: '/admin/settings', icon: SettingsIcon },
            ].map((ws) => (
              <Link key={ws.to} to={ws.to}
                className="group flex flex-col justify-between rounded-xl border border-surface-border bg-white p-3 transition-all hover:border-brand-200 hover:bg-brand-50/30 hover:shadow-subtle">
                <div className="flex items-center justify-between">
                  <div className="grid h-7 w-7 place-items-center rounded-lg bg-slate-50 text-slate-600 group-hover:bg-brand-50 group-hover:text-brand-700 transition-colors">
                    <ws.icon size={15} />
                  </div>
                  <ArrowRight size={12} className="text-slate-300 opacity-0 group-hover:opacity-100 group-hover:text-brand-600 transition-all -translate-x-1 group-hover:translate-x-0" />
                </div>
                <div className="mt-2 min-w-0">
                  <p className="truncate text-[12px] font-semibold text-slate-800 group-hover:text-brand-900">{ws.label}</p>
                  <p className="truncate text-[10.5px] text-slate-400">{ws.sub}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI tiles (Reference 1 Visual Aesthetic: White Card, Crisp Value, Sparkline Wave, Trend Badge) */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          icon={ShoppingCart}
          tone="brand"
          label="Sales Orders"
          value={fmtNumber(o.total_orders)}
          sub={`${fmtNumber(o.total_qty)} pcs · ${fmtCompact(o.total_value)} value`}
          foot={`${fmtNumber(o.approved_orders)} approved · ${fmtNumber(o.draft_orders)} draft`}
          trend="+12% ↑"
          trendLabel="vs last period"
          trendPositive={true}
        />
        <Kpi
          icon={Factory}
          tone="violet"
          label="Production Output"
          value={fmtNumber(p.produced_qty)}
          sub={`of ${fmtNumber(p.planned_qty)} pcs planned`}
          progress={prodProgress}
          foot={`${fmtNumber(p.in_progress)} orders in progress`}
          trend={`${prodProgress.toFixed(0)}%`}
          trendLabel="plan achieved"
          trendPositive={prodProgress >= 80}
        />
        <Kpi
          icon={ClipboardCheck}
          tone="emerald"
          label="Quality Pass Rate"
          value={`${passRate.toFixed(1)}%`}
          sub={`${fmtNumber(q.passed)} passed / ${fmtNumber(q.total_inspections)} inspections`}
          progress={passRate}
          foot={`${fmtNumber(q.total_defects)} defects logged`}
          trend="+0.6% ↑"
          trendLabel="on target"
          trendPositive={true}
        />
        <Kpi
          icon={Ship}
          tone="amber"
          label="Shipments"
          value={fmtNumber(s.total_shipments)}
          sub={`${fmtNumber(s.in_transit)} in transit · ${fmtNumber(s.delivered)} delivered`}
          foot={`Stock value ${fmtCompact(data.stockValue?.stock_value, '₹')}`}
          trend="On track"
          trendLabel="schedule"
          trendPositive={true}
        />
      </div>

      {/* Charts (Reference 1 Elegance: Emerald Area Chart & Centered Donut) */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">Order intake — last 12 months</h3>
              <p className="text-xs text-slate-500">Monthly booking volume in garment pieces</p>
            </div>
            <span className="rounded-lg border border-surface-border bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-600">
              Monthly Trend
            </span>
          </div>
          {monthly.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={monthly} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gQtyGreen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#16a34a" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="#16a34a" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => fmtCompact(v)} />
                <Tooltip contentStyle={tooltipStyle} formatter={((v: unknown, n: unknown) => [fmtNumber(v), n]) as never} />
                <Area type="monotone" dataKey="Qty" stroke="#16a34a" strokeWidth={2.5}
                  fill="url(#gQtyGreen)" name="Order Qty (pcs)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : <Placeholder text="No order history yet" />}
        </div>

        <div className="card p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">Orders by Status</h3>
              <span className="text-[11px] font-semibold text-brand-700 bg-brand-50 border border-brand-200/60 rounded-full px-2 py-0.5">
                {totalPieCount} Total
              </span>
            </div>
            <p className="text-xs text-slate-500 mb-2">Distribution of active pipeline</p>
          </div>
          {statusPie.length ? (
            <div className="relative">
              <ResponsiveContainer width="100%" height={210}>
                <PieChart>
                  <Pie data={statusPie} dataKey="value" nameKey="name" cx="50%" cy="50%"
                    innerRadius={56} outerRadius={82} paddingAngle={3}>
                    {statusPie.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
              {/* Central metric matching Reference 1 style */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold tracking-tight text-slate-900">{totalPieCount}</span>
                <span className="text-[10.5px] font-medium text-slate-400 uppercase tracking-wider">Orders</span>
              </div>
            </div>
          ) : <Placeholder text="No orders yet" />}
          {statusPie.length ? (
            <div className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
              {statusPie.slice(0, 4).map((item, i) => (
                <div key={item.name} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
                  <span>{item.name}: <strong>{item.value}</strong></span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">Production Pipeline &amp; WIP by Stage</h3>
              <p className="text-xs text-slate-500">Output vs rejection across floor operations</p>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-brand-600" /> Output</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-red-500" /> Rejected</span>
            </div>
          </div>
          {pipeline.some((x) => x.Output > 0) ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={pipeline} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="stage" tick={{ fontSize: 10.5, fill: '#64748b' }} axisLine={{ stroke: '#e5e7eb' }}
                  tickLine={false} interval={0} angle={-25} textAnchor="end" height={54} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => fmtCompact(v)} />
                <Tooltip contentStyle={tooltipStyle} formatter={((v: unknown, n: unknown) => [fmtNumber(v), n]) as never} />
                <Bar dataKey="Output" fill="#16a34a" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Rejected" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Placeholder text="No production movements recorded" />}
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-3 border-b border-surface-divider pb-3">
            <div>
              <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">Live Stage WIP</h3>
              <p className="text-xs text-slate-500">Floor inventory balance</p>
            </div>
            <Link to="/production/wip-stock-value" className="text-xs font-semibold text-brand-700 hover:underline flex items-center gap-1">
              WIP View <ArrowRight size={12} />
            </Link>
          </div>
          {data.productionPipeline.length ? (
            <div className="space-y-2.5">
              {data.productionPipeline.map((s) => {
                const inQty = Number(s.input_qty || 0);
                const outQty = Number(s.output_qty || 0);
                const rejQty = Number(s.rejected_qty || 0);
                const wip = Math.max(0, inQty - outQty - rejQty);
                return (
                  <div key={s.stage_code} className="flex items-center justify-between text-xs py-1.5 border-b border-surface-divider last:border-0">
                    <span className="font-medium text-slate-700 truncate max-w-[130px]">{s.stage_name}</span>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums text-slate-500">{fmtNumber(outQty)} done</span>
                      <span className={wip > 0 ? 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-violet-50 text-violet-700 border border-violet-200/60' : 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-600'}>
                        {fmtNumber(wip)} WIP
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <Placeholder text="No WIP data" pad />}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4">
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3 border-b border-surface-divider pb-3">
            <div>
              <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">Top Buyers by Order Value</h3>
              <p className="text-xs text-slate-500">Key customer contribution</p>
            </div>
            <Link to="/masters/parties" className="text-xs font-semibold text-brand-700 hover:underline flex items-center gap-1">
              All Buyers <ArrowRight size={12} />
            </Link>
          </div>
          {data.topBuyers.length ? (
            <div className="space-y-3">
              {data.topBuyers.slice(0, 6).map((b, i) => {
                const max = Number(data.topBuyers[0].value) || 1;
                const pct = (Number(b.value) / max) * 100;
                return (
                  <div key={b.id}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[12.5px]">
                      <span className="truncate font-semibold text-slate-800">{b.buyer_name}</span>
                      <span className="shrink-0 tabular-nums text-slate-600 font-medium">
                        {fmtCompact(b.value)} · {fmtNumber(b.qty)} pcs
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
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
          <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
            <div>
              <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">Upcoming Shipments</h3>
              <p className="text-xs text-slate-500">Scheduled order export dispatches</p>
            </div>
            <Link to="/sales/orders" className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
              All Orders <ArrowRight size={13} />
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
                      <td className="td font-semibold text-brand-700">
                        <Link to={`/sales/orders/${r.id}`} className="hover:underline">{r.so_no}</Link>
                      </td>
                      <td className="td max-w-[180px] truncate font-medium text-slate-700">{r.buyer_name}</td>
                      <td className="td whitespace-nowrap text-slate-600">{fmtDate(r.ship_date)}</td>
                      <td className="td text-right tabular-nums font-semibold text-slate-900">{fmtNumber(r.order_qty)}</td>
                      <td className="td text-right tabular-nums font-medium text-slate-700">
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
            <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Clock size={15} className="text-amber-500" />
                <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">T&amp;A Alerts</h3>
                {tna?.length ? <Badge tone="amber">{tna.length}</Badge> : null}
              </div>
              <Link to="/tna" className="text-xs font-semibold text-brand-700 hover:underline">View All →</Link>
            </div>
            <div className="max-h-[210px] overflow-y-auto">
              {tna?.length ? tna.slice(0, 8).map((m) => (
                <div key={m.id} className="border-b border-surface-divider px-4 py-2.5 last:border-0 hover:bg-slate-50/50 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-semibold text-slate-800">{m.milestone}</p>
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
              <h3 className="text-[14px] font-bold text-slate-900 tracking-tight">Stock Alerts</h3>
            </div>
            <div className="max-h-[210px] overflow-y-auto">
              {data.lowStockAlerts.length ? data.lowStockAlerts.map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-2 border-b border-surface-divider px-4 py-2.5 last:border-0 hover:bg-slate-50/50 transition-colors">
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-semibold text-slate-800">{a.item_name}</p>
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
  fontSize: 12,
  borderRadius: 10,
  border: '1px solid #e5e7eb',
  boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.08)',
  backgroundColor: '#ffffff',
  color: '#0f172a',
};

function Placeholder({ text, pad }: { text: string; pad?: boolean }) {
  return (
    <div className={`grid place-items-center text-[12.5px] text-slate-400 ${pad ? 'py-10' : 'h-[250px]'}`}>
      {text}
    </div>
  );
}

function Kpi({
  icon: Icon,
  tone,
  label,
  value,
  sub,
  foot,
  progress,
  trend,
  trendLabel,
  trendPositive,
}: {
  icon: typeof ShoppingCart;
  tone: 'brand' | 'violet' | 'emerald' | 'amber';
  label: string;
  value: string;
  sub?: string;
  foot?: string;
  progress?: number;
  trend?: string;
  trendLabel?: string;
  trendPositive?: boolean;
}) {
  const tones = {
    brand: 'bg-brand-50 text-brand-700 border border-brand-200/60',
    violet: 'bg-violet-50 text-violet-700 border border-violet-200/60',
    emerald: 'bg-emerald-50 text-emerald-700 border border-emerald-200/60',
    amber: 'bg-amber-50 text-amber-700 border border-amber-200/60',
  };
  const bars = {
    brand: 'bg-brand-600',
    violet: 'bg-violet-600',
    emerald: 'bg-emerald-600',
    amber: 'bg-amber-500',
  };

  return (
    <div className="card p-5 hover:border-slate-300 transition-all">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[28px] sm:text-[30px] font-bold tracking-tight text-slate-900">{value}</span>
          </div>
        </div>

        {/* Reference 1 Sparkline wave & Icon */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className={`grid h-9 w-9 place-items-center rounded-xl ${tones[tone]} shadow-subtle`}>
            <Icon size={18} />
          </div>
          {/* Subtle sparkline wave matching Reference 1 */}
          <svg className="w-14 h-6 text-brand-600 opacity-80" viewBox="0 0 60 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {tone === 'brand' || tone === 'emerald' ? (
              <path d="M2 18 L15 14 L28 17 L40 8 L58 4" />
            ) : tone === 'violet' ? (
              <path d="M2 16 L14 12 L28 15 L42 9 L58 6" />
            ) : (
              <path d="M2 10 L15 14 L28 8 L42 16 L58 12" stroke="#f59e0b" />
            )}
          </svg>
        </div>
      </div>

      {trend && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[11.5px]">
          <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 font-semibold text-[10.5px] ${
            trendPositive
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60'
              : 'bg-amber-50 text-amber-700 border border-amber-200/60'
          }`}>
            {trend}
          </span>
          {trendLabel && <span className="text-slate-400 font-medium">{trendLabel}</span>}
        </div>
      )}

      {sub && <p className="mt-2 text-[12px] text-slate-500 font-medium">{sub}</p>}

      {progress !== undefined && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className={`h-full rounded-full transition-all ${bars[tone]}`}
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
        </div>
      )}

      {foot && <p className="mt-3 border-t border-surface-divider pt-2.5 text-[11.5px] text-slate-400 font-medium">{foot}</p>}
    </div>
  );
}
