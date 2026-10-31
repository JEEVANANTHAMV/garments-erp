import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell } from 'recharts';
import { ShoppingCart, Factory, Truck, ClipboardList, Layers, Package, CalendarDays, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Users, HardHat, type LucideIcon } from 'lucide-react';
import { api, http, type ListResponse } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNumber, fmtCompact, fmtDate, humanize } from '../lib/format';
import { LoadingBlock, ErrorState, StatusBadge } from '../components/ui';
import { colors, chartColors, statusColors } from '../theme/designTokens.js';
import { aggregateOutput, aggregateStock, businessDate, monthRange, samePeriodLastMonth, trendPct, type OutputRow, type StockRow } from './dashboard/model';

interface Summary {
  orders: Record<string, number | string>; production: Record<string, number | string>;
  quality: Record<string, number | string>; shipments: Record<string, number | string>;
  ordersByStatus: { status: string; count: number }[];
  ordersByMonth: { month: string; orders: number; qty: string; value: string }[];
  topBuyers: { id: number; buyer_name: string; orders: number; qty: string; value: string }[];
  upcomingShipments: { id: number; so_no: string; buyer_name: string; ship_date: string; order_qty: number; days_remaining: number }[];
  productionPipeline: { stage_code: string; stage_name: string; input_qty: string; output_qty: string; rejected_qty: string }[];
  lowStockAlerts: { material_type: string; item_name: string; item_code: string; balance: string }[];
  stockValue: { stock_value: string }; pendingApprovals: { pending: number };
}
interface Job { id: number; po_prod_no: string; style_code: string; so_no: string; buyer_name: string | null; order_qty: number; produced_qty: number; approval_state: string }
interface Purchase { id: number; po_no: string; supplier_name: string; po_type: string; currency_code: string; total_amount: string; approval_state: string }
interface Task { id: number; milestone: string; so_no: string; planned_date: string; status: string }

// Good pieces per day / stage / style from the real floor screens (cutting, sewing, finishing, packing).
async function loadOutput(range: { dateFrom: string; dateTo: string }, signal: AbortSignal) {
  return (await api.get<{ data: OutputRow[] }>('/dashboard/output', { params: range, signal })).data.data ?? [];
}

// Dispatches come back as one unpaged list: count all, and this month-to-date vs the same days last month.
async function loadDispatches(now: { dateFrom: string; dateTo: string }, prev: { dateFrom: string; dateTo: string }) {
  const rows = (await http.get<{ data: { dispatch_date: string }[] }>('/dispatches')).data ?? [];
  const within = (r: { dispatch_date: string }, p: { dateFrom: string; dateTo: string }) => {
    const d = String(r.dispatch_date ?? '').slice(0, 10);
    return d >= p.dateFrom && d <= p.dateTo;
  };
  return { total: rows.length, now: rows.filter((r) => within(r, now)).length, prev: rows.filter((r) => within(r, prev)).length };
}

interface DashboardList<T> { rows: T[]; total: number }

// Some routes (e.g. /dispatches) return every row with no pagination block; count those rows instead.
function useDashboardList<T>(path: string, permission: string, params: Record<string, unknown> = {}) {
  const { can, company } = useAuth();
  const pageSize = Number(params.pageSize ?? 5);
  return useQuery({
    queryKey: ['dashboard', company?.id, path, params], enabled: can(permission), staleTime: 60_000,
    queryFn: async (): Promise<DashboardList<T>> => {
      const response = await http.get<Partial<ListResponse<T>>>(`/${path}`, { page: 1, pageSize, ...params });
      const rows = Array.isArray(response?.data) ? response.data : [];
      return { rows: rows.slice(0, pageSize), total: Number(response?.pagination?.total ?? rows.length) };
    },
  });
}

export default function Dashboard() {
  const { user, company, companies, switchCompany, can } = useAuth();
  const [period, setPeriod] = useState('current');
  const [status, setStatus] = useState('all');
  const date = businessDate();
  const range = monthRange(date, period === 'previous');
  const summary = useQuery({
    queryKey: ['dashboard-summary', company?.id], staleTime: 60_000,
    queryFn: async () => (await http.get<{ data: Summary }>('/dashboard/summary')).data,
  });
  const outputs = useQuery({
    queryKey: ['dashboard-output', company?.id, range], enabled: can('PRODUCTION.VIEW'), staleTime: 60_000,
    queryFn: ({ signal }) => loadOutput(range, signal),
  });
  // Trends: this month to date against the same days of last month; today's output against yesterday.
  const mtd = monthRange(date);
  const lastMtd = samePeriodLastMonth(date);
  const yesterday = businessDate(new Date(Date.now() - 86_400_000));
  const recentOutput = useQuery({
    queryKey: ['dashboard-today-output', company?.id, date], enabled: can('PRODUCTION.VIEW'), staleTime: 60_000,
    queryFn: ({ signal }) => loadOutput({ dateFrom: yesterday, dateTo: date }, signal),
  });
  // "Today output" = pieces sewn (each garment once), matching the reference's Pcs (All Lines).
  const sewnOn = (day: string) => (recentOutput.data ?? []).filter((r) => r.stage === 'SEWING' && r.output_date === day).reduce((sum, r) => sum + Number(r.qty), 0);
  const jobs = useDashboardList<Job>('production-orders', 'PRODUCTION.VIEW');
  const purchases = useDashboardList<Purchase>('purchase-orders', 'PURCHASE.VIEW');
  const dispatches = useQuery({
    queryKey: ['dashboard-dispatches', company?.id, date], enabled: can('DISPATCH.VIEW'), staleTime: 60_000,
    queryFn: () => loadDispatches(mtd, lastMtd),
  });
  const ordersNow = useDashboardList<never>('sales-orders', 'SALES_ORDER.VIEW', { ...mtd, pageSize: 1 });
  const ordersPrev = useDashboardList<never>('sales-orders', 'SALES_ORDER.VIEW', { ...lastMtd, pageSize: 1 });
  const posNow = useDashboardList<never>('purchase-orders', 'PURCHASE.VIEW', { dateField: 'po_date', ...mtd, pageSize: 1 });
  const posPrev = useDashboardList<never>('purchase-orders', 'PURCHASE.VIEW', { dateField: 'po_date', ...lastMtd, pageSize: 1 });
  const jobsNow = useDashboardList<never>('production-orders', 'PRODUCTION.VIEW', { dateField: 'prod_date', ...mtd, pageSize: 1 });
  const jobsPrev = useDashboardList<never>('production-orders', 'PRODUCTION.VIEW', { dateField: 'prod_date', ...lastMtd, pageSize: 1 });
  const visitors = useDashboardList<never>('gate-visitors', 'GATE_INWARD.VIEW', { dateField: 'visit_date', dateFrom: date, dateTo: date, visitor_type: 'VISITOR', pageSize: 1 });
  const contractors = useDashboardList<never>('gate-visitors', 'GATE_INWARD.VIEW', { dateField: 'visit_date', dateFrom: date, dateTo: date, visitor_type: 'CONTRACTOR', pageSize: 1 });
  const trend = (now?: { total: number }, prev?: { total: number }) => now && prev ? trendPct(now.total, prev.total) : null;
  const inwards = useDashboardList<never>('gate-inwards', 'GATE_INWARD.VIEW', { dateField: 'entry_date', dateFrom: date, dateTo: date, pageSize: 1 });
  const outwards = useDashboardList<never>('gate-outwards', 'GATE_OUTWARD.VIEW', { dateField: 'pass_date', dateFrom: date, dateTo: date, pageSize: 1 });
  const stock = useQuery({
    queryKey: ['dashboard-fabric-stock', company?.id], enabled: can('INVENTORY.VIEW'), staleTime: 60_000,
    queryFn: async () => (await http.get<{ data: StockRow[] }>('/inventory/stock', { material_type: 'FABRIC' })).data,
  });
  const tna = useQuery({
    queryKey: ['tna-alerts', company?.id], enabled: can('PRODUCTION.VIEW'), staleTime: 60_000,
    queryFn: async () => (await http.get<{ data: Task[] }>('/dashboard/tna-alerts')).data,
  });
  const data = summary.data;
  const production = aggregateOutput(outputs.data ?? []);
  const fabric = aggregateStock(stock.data ?? []);
  const orderStatuses = (data?.ordersByStatus ?? []).map((s) => ({
    name: humanize(s.status), value: Number(s.count), code: s.status,
    color: /APPROVED|COMPLETED/.test(s.status) ? chartColors.sewing : /REJECTED|CANCELLED/.test(s.status) ? chartColors.delayed
      : /PENDING/.test(s.status) ? chartColors.finishing : statusColors.neutral.text,
  }));
  const selectedStatuses = orderStatuses.filter((s) => status === 'all' || s.code === status);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()));
  const greeting = hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';

  return (
    <div className="space-y-3">
      <div className="flex min-h-[80px] flex-wrap items-center justify-between gap-3 pb-1">
        <div>
          <p className="mb-1 text-xs text-brand-700">Home</p>
          <h1 className="text-page font-semibold leading-tight text-ink-heading">{greeting}{user?.fullName ? `, ${user.fullName}` : ''}</h1>
          <p className="mt-1 text-body-lg text-ink-secondary">Here’s what’s happening in your garment production today.</p>
        </div>
        <div className="card flex items-center gap-3 px-3 py-2">
          <CalendarDays size={19} className="text-ink-secondary" />
          <div>
            <p className="text-xs font-medium">{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date())}</p>
            {companies.length > 1 ? <select aria-label="Dashboard company" className="mt-1 max-w-[220px] bg-transparent text-xs text-ink-secondary" value={company?.id} onChange={(e) => void switchCompany(Number(e.target.value))}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.trade_name || c.legal_name}</option>)}
            </select> : <p className="mt-1 text-xs text-ink-secondary">{company?.trade_name || company?.legal_name}</p>}
          </div>
        </div>
      </div>
      {summary.isLoading ? <div className="card"><LoadingBlock rows={6} /></div> : summary.error ? <div className="card"><ErrorState error={summary.error} onRetry={() => void summary.refetch()} /></div> : data && <>
        <div className="dashboard-grid dashboard-kpis">
          <Kpi icon={ClipboardList} color={chartColors.cutting} label="Total Orders" value={fmtNumber(data.orders.total_orders)} caption="All sales orders" trend={trend(ordersNow.data, ordersPrev.data)} />
          {can('PURCHASE.VIEW') && <Kpi icon={ShoppingCart} color={chartColors.sewing} label="Purchase Orders" value={fmtNumber(purchases.data?.total)} caption="All purchase orders" query={purchases} trend={trend(posNow.data, posPrev.data)} />}
          {can('PRODUCTION.VIEW') && <Kpi icon={Package} color={chartColors.packing} label="Production Jobs" value={fmtNumber(data.production.total_prod_orders)} caption={`${fmtNumber(data.production.in_progress)} in progress`} trend={trend(jobsNow.data, jobsPrev.data)} />}
          {can('PRODUCTION.VIEW') && <Kpi icon={Factory} color={chartColors.finishing} label="Today Output" value={recentOutput.data ? fmtNumber(sewnOn(date)) : '—'} unit="Pcs" caption="Sewn today · all lines" query={recentOutput} trend={recentOutput.data ? trendPct(sewnOn(date), sewnOn(yesterday)) : null} trendLabel="vs yesterday" />}
          {can('DISPATCH.VIEW') && <Kpi icon={Truck} color={chartColors.dispatch} label="Dispatches" value={fmtNumber(dispatches.data?.total)} caption={`${fmtNumber(dispatches.data?.now ?? 0)} this month`} query={dispatches} trend={dispatches.data ? trendPct(dispatches.data.now, dispatches.data.prev) : null} />}
          {can('INVENTORY.VIEW') && <Kpi icon={Layers} color={chartColors.inventory} label="Fabric Stock" value={stock.data ? (fabric.totals.length ? fabric.totals.map((t) => fmtNumber(t.value, 2)).join(' / ') : '0') : '—'} unit={fabric.totals.map((t) => t.unit).join(' / ') || undefined} caption="Current balance by unit" query={stock} />}
        </div>
        <div className="dashboard-grid dashboard-charts">
          {can('PRODUCTION.VIEW') && <Panel title="Production Progress" action={<Period value={period} onChange={setPeriod} />}>
            <QueryContent query={outputs} empty={!production.days.length} emptyText="No cutting, sewing, finishing or packing output recorded in this period">
              <p className="px-3 text-xs text-ink-secondary">Recorded good output by stage (pcs)</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 text-xs text-ink-secondary">{production.stages.map((s) => <span key={s.key} className="flex items-center gap-1"><Dot color={s.color} />{s.name}</span>)}</div>
              <div className="px-2 pb-2">
                <ResponsiveContainer width="100%" height={210}>
                  <BarChart data={production.days} margin={{ top: 8, right: 12, left: 0, bottom: 4 }} accessibilityLayer>
                    <CartesianGrid vertical={false} stroke={colors.divider} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => fmtDate(d).slice(0, 6)} tick={{ fontSize: 11, fill: colors.secondary }} tickLine={false} axisLine={false} minTickGap={20} />
                    <YAxis width={45} tickFormatter={(v) => fmtCompact(v)} tick={{ fontSize: 11, fill: colors.secondary }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => fmtDate(d)} formatter={(v) => fmtNumber(v)} />
                    {production.stages.map((s) => <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={18} />)}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </QueryContent>
          </Panel>}
          {can('PRODUCTION.VIEW') && <Panel title="Style Wise Production" action={<Period value={period} onChange={setPeriod} />}>
            <QueryContent query={outputs} empty={!production.styles.length} emptyText="No sewing output recorded in this period">
              <p className="px-3 text-xs text-ink-secondary">Pieces sewn, by style</p>
              <Donut data={production.styles} unit="Pcs" percentages />
            </QueryContent>
          </Panel>}
          <Panel title="Order Status" action={<select className="rounded border border-surface-border bg-white px-2 py-1 text-xs" aria-label="Order status filter" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All Orders</option>{orderStatuses.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>}>
            <p className="px-3 text-xs text-ink-secondary">Sales order approval states</p>
            <Donut data={selectedStatuses} unit="Orders" />
          </Panel>
        </div>
        <div className="dashboard-grid dashboard-tables">
          {can('PRODUCTION.VIEW') && <Panel title="Recent Production Jobs" to="/production/orders">
            <QueryContent query={jobs} empty={!jobs.data?.rows.length}>
              <Table headers={['Job No', 'Style', 'Buyer', 'Order Qty', 'Produced', 'Balance', 'Status']} numeric={[3, 4, 5]}>
                {jobs.data?.rows.map((j) => <tr key={j.id} className="row-hover"><td className="td">{j.po_prod_no}</td><td className="td">{j.style_code || '—'}</td><td className="td" title={j.so_no ? `Sales order ${j.so_no}` : undefined}>{j.buyer_name || j.so_no || '—'}</td><td className="td text-right">{fmtNumber(j.order_qty)}</td><td className="td text-right">{fmtNumber(j.produced_qty)}</td><td className="td text-right">{fmtNumber(Number(j.order_qty) - Number(j.produced_qty))}</td><td className="td"><StatusBadge value={j.approval_state} /></td></tr>)}
              </Table>
            </QueryContent>
          </Panel>}
          {can('PRODUCTION.VIEW') && <Panel title="Pending Tasks (TNA)" to="/tna">
            <QueryContent query={tna} empty={!tna.data?.length} emptyText="No upcoming or overdue tasks">
              <Table headers={['Task', 'Order No', 'Planned Date', 'Status']}>
                {tna.data?.slice(0, 5).map((t) => <tr key={t.id} className="row-hover"><td className="td">{t.milestone}</td><td className="td">{t.so_no}</td><td className="td">{fmtDate(t.planned_date)}</td><td className="td"><StatusBadge value={t.status} /></td></tr>)}
              </Table>
            </QueryContent>
          </Panel>}
        </div>
        <div className="dashboard-grid dashboard-stock">
          {can('INVENTORY.VIEW') && <Panel title="Fabric Stock Position" to="/inventory/stock">
            <QueryContent query={stock} empty={!fabric.items.length}>
              <Table headers={['Fabric', 'Unit', 'Received', 'Issued', 'Balance']} numeric={[2, 3, 4]}>
                {fabric.items.slice(0, 5).map((s) => <tr key={`${s.fabric_id}-${s.uom_code}`} className="row-hover"><td className="td">{s.item_name}</td><td className="td">{s.uom_code || '—'}</td><td className="td text-right">{fmtNumber(s.total_in, 2)}</td><td className="td text-right">{fmtNumber(s.total_out, 2)}</td><td className="td text-right">{fmtNumber(s.balance, 2)}</td></tr>)}
              </Table>
            </QueryContent>
          </Panel>}
          {can('PURCHASE.VIEW') && <Panel title="Purchase Orders" to="/procurement/purchase-orders">
            <QueryContent query={purchases} empty={!purchases.data?.rows.length}>
              <Table headers={['PO No', 'Supplier', 'Value', 'Status']} numeric={[2]}>
                {purchases.data?.rows.map((p) => <tr key={p.id} className="row-hover"><td className="td">{p.po_no}</td><td className="td">{p.supplier_name}</td><td className="td text-right">{p.currency_code} {fmtNumber(p.total_amount, 2)}</td><td className="td"><StatusBadge value={p.approval_state} /></td></tr>)}
              </Table>
            </QueryContent>
          </Panel>}
          {(can('GATE_INWARD.VIEW') || can('GATE_OUTWARD.VIEW')) && <Panel title="Gate Entry (Today)">
            <Table headers={['Type', 'Count']} numeric={[1]}>
              {can('GATE_INWARD.VIEW') && <tr><td className="td"><Link className="flex items-center gap-2 text-brand-700 hover:underline" to="/gate/inwards"><ArrowLeft size={16} />Inward (Material)</Link></td><td className="td text-right"><Count query={inwards} /></td></tr>}
              {can('GATE_OUTWARD.VIEW') && <tr><td className="td"><Link className="flex items-center gap-2 text-brand-700 hover:underline" to="/gate/outwards"><ArrowRight size={16} />Outward (Passes)</Link></td><td className="td text-right"><Count query={outwards} /></td></tr>}
              {can('GATE_INWARD.VIEW') && <tr><td className="td"><Link className="flex items-center gap-2 text-brand-700 hover:underline" to="/gate/visitors"><Users size={16} />Visitors</Link></td><td className="td text-right"><Count query={visitors} /></td></tr>}
              {can('GATE_INWARD.VIEW') && <tr><td className="td"><Link className="flex items-center gap-2 text-brand-700 hover:underline" to="/gate/visitors"><HardHat size={16} />Contractors</Link></td><td className="td text-right"><Count query={contractors} /></td></tr>}
            </Table>
          </Panel>}
        </div>
        <details className="card">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink-heading">More operational insights</summary>
          <div className="dashboard-grid p-3 md:grid-cols-2 xl:grid-cols-3">
            <Panel title="Upcoming Shipments" to={can('SALES_ORDER.VIEW') ? '/sales/orders' : undefined}>
              {data.upcomingShipments.length ? <Table headers={['Order', 'Buyer', 'Ship Date', 'Qty']} numeric={[3]}>{data.upcomingShipments.map((s) => <tr key={s.id}><td className="td">{s.so_no}</td><td className="td">{s.buyer_name}</td><td className="td">{fmtDate(s.ship_date)}</td><td className="td text-right">{fmtNumber(s.order_qty)}</td></tr>)}</Table> : <Empty />}
            </Panel>
            <Panel title="Top Buyers by Order Value">
              {data.topBuyers.length ? <Table headers={['Buyer', 'Orders', 'Qty', 'Value']} numeric={[1, 2, 3]}>{data.topBuyers.map((b) => <tr key={b.id}><td className="td">{b.buyer_name}</td><td className="td text-right">{fmtNumber(b.orders)}</td><td className="td text-right">{fmtNumber(b.qty)}</td><td className="td text-right">{fmtNumber(b.value)}</td></tr>)}</Table> : <Empty />}
            </Panel>
            <Panel title="Live Stage WIP" to={can('PRODUCTION.VIEW') ? '/production/wip-stock-value' : undefined}>
              {data.productionPipeline.length ? <Table headers={['Stage', 'Output', 'WIP']} numeric={[1, 2]}>{data.productionPipeline.map((s) => <tr key={s.stage_code}><td className="td">{s.stage_name}</td><td className="td text-right">{fmtNumber(s.output_qty)}</td><td className="td text-right">{fmtNumber(Math.max(0, Number(s.input_qty) - Number(s.output_qty) - Number(s.rejected_qty)))}</td></tr>)}</Table> : <Empty />}
            </Panel>
            <Panel title="Quality & Approvals"><dl className="space-y-2 p-3 text-sm"><div className="flex justify-between gap-2"><dt>Quality pass rate</dt><dd className="numeric-cell">{Number(data.quality.total_inspections) ? `${fmtNumber(Number(data.quality.passed) / Number(data.quality.total_inspections) * 100, 1)}%` : '—'}</dd></div><div className="flex justify-between gap-2"><dt>Pending approvals</dt><dd>{fmtNumber(data.pendingApprovals.pending)}</dd></div></dl></Panel>
            <Panel title="Stock Alerts">{data.lowStockAlerts.length ? <Table headers={['Item', 'Type', 'Balance']} numeric={[2]}>{data.lowStockAlerts.map((a, i) => <tr key={i}><td className="td">{a.item_name}</td><td className="td">{a.material_type}</td><td className="td text-right">{fmtNumber(a.balance, 2)}</td></tr>)}</Table> : <Empty text="No stock alerts" />}</Panel>
            <Panel title="Order Intake — Last 12 Months">{data.ordersByMonth.length ? <Table headers={['Month', 'Orders', 'Qty']} numeric={[1, 2]}>{data.ordersByMonth.map((m) => <tr key={m.month}><td className="td">{m.month}</td><td className="td text-right">{fmtNumber(m.orders)}</td><td className="td text-right">{fmtNumber(m.qty)}</td></tr>)}</Table> : <Empty />}</Panel>
          </div>
        </details>
      </>}
    </div>
  );
}

function Panel({ title, to, action, children }: { title: string; to?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="card dashboard-panel"><div className="flex flex-wrap items-center justify-between gap-2 px-3 py-3"><h2 className="text-title font-semibold text-ink-heading">{title}</h2>{to ? <Link className="text-xs text-brand-700 hover:underline" to={to}>View All</Link> : action}</div>{children}</section>;
}
function Table({ headers, numeric = [], children }: { headers: string[]; numeric?: number[]; children: ReactNode }) {
  return <div className="overflow-x-auto px-2 pb-2" role="region" aria-label={`${headers[0]} data table`} tabIndex={0}><table><thead><tr>{headers.map((h, i) => <th key={h} scope="col" className={`th ${numeric.includes(i) ? 'text-right' : ''}`}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
function Period({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select className="rounded border border-surface-border bg-white px-2 py-1 text-xs" aria-label="Production period" value={value} onChange={(e) => onChange(e.target.value)}><option value="current">This Month</option><option value="previous">Last Month</option></select>;
}
function Empty({ text = 'No records available' }: { text?: string }) { return <p className="px-4 py-10 text-center text-xs text-ink-secondary">{text}</p>; }
function QueryContent({ query, empty, emptyText, children }: { query: UseQueryResult<unknown>; empty: boolean; emptyText?: string; children: ReactNode }) {
  return query.isLoading ? <LoadingBlock rows={4} /> : query.error ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : empty ? <Empty text={emptyText} /> : children;
}
function Count({ query }: { query: UseQueryResult<DashboardList<unknown>> }) {
  return query.isLoading ? <span aria-label="Loading count">…</span> : query.error ? <button className="text-brand-700 underline" onClick={() => void query.refetch()}>Retry</button> : fmtNumber(query.data?.total);
}
function Kpi({ icon: Icon, color, label, value, unit, caption, query, trend, trendLabel = 'vs same days last month' }: {
  icon: LucideIcon; color: string; label: string; value: string; unit?: string; caption: string;
  query?: UseQueryResult<unknown>; trend?: number | null; trendLabel?: string;
}) {
  const up = (trend ?? 0) >= 0;
  return <section className="card min-w-0 p-3"><div className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-x-3">
    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-white" style={{ backgroundColor: color }}><Icon size={22} /></div>
    <div className="min-w-0">
      <h2 className="text-body text-ink">{label}</h2>
      {query?.isLoading ? <div className="skeleton my-1 h-7 w-20" aria-label={`Loading ${label}`} />
        : query?.error ? <button className="py-1 text-xs text-brand-700 underline" onClick={() => void query.refetch()}>Unable to load · Retry</button>
        : <div className="flex flex-wrap items-baseline gap-x-2">
            <p tabIndex={0} className="dashboard-kpi-value font-bold leading-tight text-ink-heading">{value}</p>
            {unit && <span className="text-small text-ink-secondary">{unit}</span>}
            {trend != null && <span title={trendLabel} className={`inline-flex items-center gap-0.5 text-small font-semibold ${up ? 'text-status-success-text' : 'text-status-error-text'}`}>
              {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}{up ? '+' : ''}{trend}%<span className="sr-only"> {trendLabel}</span></span>}
          </div>}
      <p className="mt-0.5 text-caption text-ink-secondary">{caption}</p>
    </div>
  </div></section>;
}
function Dot({ color }: { color: string }) { return <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />; }
function Donut({ data, unit, percentages }: { data: { name: string; value: number; color: string }[]; unit: string; percentages?: boolean }) {
  const total = data.reduce((sum, s) => sum + s.value, 0);
  if (!total) return <Empty />;
  return <div className="flex flex-wrap items-center justify-center gap-2 px-3 pb-3">
    <div className="relative h-[200px] w-[170px] max-w-full shrink-0"><ResponsiveContainer width="100%" height="100%"><PieChart accessibilityLayer><Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={76} paddingAngle={1} stroke="none">{data.map((s, i) => <Cell key={`${s.name}-${i}`} fill={s.color} />)}</Pie><Tooltip contentStyle={tooltipStyle} formatter={(v) => fmtNumber(v)} /></PieChart></ResponsiveContainer><div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="max-w-[100px] break-all text-center text-lg font-bold tabular-nums text-ink-heading">{fmtNumber(total)}</span><span className="text-xs text-ink-secondary">{unit}</span></div></div>
    <ul className="min-w-[110px] flex-1 space-y-2 text-xs">{data.map((s, i) => <li key={`${s.name}-${i}`} className="flex items-center gap-2"><Dot color={s.color} /><span className="min-w-0 flex-1 break-words">{s.name}</span><span className="numeric-cell">{percentages ? `${fmtNumber(s.value / total * 100, 1)}%` : fmtNumber(s.value)}</span></li>)}</ul>
  </div>;
}
const tooltipStyle = { fontSize: 12, borderRadius: 8, border: `1px solid ${colors.border}`, backgroundColor: colors.surface, color: colors.text };
