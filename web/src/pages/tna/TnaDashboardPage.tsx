import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ShieldAlert, CheckCircle2, Clock, AlertTriangle, ArrowRight,
  TrendingUp, CalendarClock, RefreshCw, Scissors, Layers, PackageCheck, Ship
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtNumber } from '../../lib/format';

export default function TnaDashboardPage() {
  const nav = useNavigate();

  const dashboardQuery = useQuery({
    queryKey: ['tna-dashboard-full'],
    queryFn: async () => (await http.get<{ data: any }>('/tna/dashboard')).data,
  });

  const d = dashboardQuery.data || {
    total_orders: 0,
    on_track: 0,
    at_risk: 0,
    critical: 0,
    avg_completion: 0,
    fabric_delays: 0,
    trim_delays: 0,
    sample_delays: 0,
    production_delays: 0,
    shipment_risk_orders: 0,
    critical_watchlist: [],
  };

  return (
    <div className="space-y-5 pb-12">
      {/* 1. Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <ShieldAlert className="text-brand-600" size={24} />
              Executive T&A Risk & Control Dashboard
            </h1>
            <span className="rounded-full bg-indigo-50 border border-indigo-200 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
              Live Factory Milestone Intelligence
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time aggregate status, departmental bottlenecks, and critical shipment risk alerts
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm flex items-center gap-1.5"
            onClick={() => nav('/tna')}
          >
            <CalendarClock size={14} /> View All Orders
          </button>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => dashboardQuery.refetch()}
            title="Refresh dashboard"
          >
            <RefreshCw size={14} className={dashboardQuery.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* 2. Top Executive Metrics (Section 19) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Total Orders</span>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-3xl font-bold text-slate-900 font-mono">{d.total_orders}</span>
            <span className="text-xs text-slate-500 font-medium">In Production</span>
          </div>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 shadow-xs">
          <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 flex items-center gap-1">
            <CheckCircle2 size={13} /> On Track
          </span>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-3xl font-bold text-emerald-700 font-mono">{d.on_track}</span>
            <span className="text-xs font-semibold text-emerald-600">
              {d.total_orders > 0 ? ((d.on_track / d.total_orders) * 100).toFixed(0) : 0}% of Total
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 shadow-xs">
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800 flex items-center gap-1">
            <Clock size={13} /> At Risk
          </span>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-3xl font-bold text-amber-700 font-mono">{d.at_risk}</span>
            <span className="text-xs font-semibold text-amber-600">Approaching Due</span>
          </div>
        </div>

        <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-4 shadow-xs">
          <span className="text-[11px] font-bold uppercase tracking-wider text-rose-800 flex items-center gap-1">
            <AlertTriangle size={13} /> Critical Orders
          </span>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-3xl font-bold text-rose-700 font-mono">{d.critical}</span>
            <span className="text-xs font-semibold text-rose-600">Delayed Mandatories</span>
          </div>
        </div>

        <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 shadow-xs">
          <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-800 flex items-center gap-1">
            <TrendingUp size={13} /> Avg Completion
          </span>
          <div className="flex items-baseline justify-between mt-2">
            <span className="text-3xl font-bold text-indigo-700 font-mono">{d.avg_completion}%</span>
            <span className="text-xs font-semibold text-indigo-600">Overall Progress</span>
          </div>
        </div>
      </div>

      {/* 3. Departmental Delay Counters (Section 19 Spec: Fabric, Trim, Sample, Production, Shipment) */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
          Departmental Milestone Delays Breakdown
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-indigo-100 text-indigo-700 shrink-0">
              <Layers size={20} />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-500">Fabric Delays</p>
              <p className="text-xl font-bold text-slate-900 font-mono">{d.fabric_delays}</p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-cyan-100 text-cyan-700 shrink-0">
              <Scissors size={20} />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-500">Trim Delays</p>
              <p className="text-xl font-bold text-slate-900 font-mono">{d.trim_delays}</p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-purple-100 text-purple-700 shrink-0">
              <PackageCheck size={20} />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-500">Sample Approval Delays</p>
              <p className="text-xl font-bold text-slate-900 font-mono">{d.sample_delays}</p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-amber-100 text-amber-700 shrink-0">
              <Scissors size={20} />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-500">Production Delays</p>
              <p className="text-xl font-bold text-slate-900 font-mono">{d.production_delays}</p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-rose-100 text-rose-700 shrink-0">
              <Ship size={20} />
            </div>
            <div>
              <p className="text-[11px] font-semibold text-slate-500">Shipment At Risk</p>
              <p className="text-xl font-bold text-rose-600 font-mono">{d.shipment_risk_orders}</p>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Critical Watchlist Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-xs">
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <AlertTriangle size={16} className="text-rose-600" />
              High Risk & Critical Orders Watchlist
            </h3>
            <p className="text-xs text-slate-500">Orders requiring immediate management intervention to safeguard shipment dates</p>
          </div>
          <span className="rounded-full bg-rose-100 text-rose-800 font-bold px-2.5 py-0.5 text-xs">
            {d.critical_watchlist?.length || 0} Orders Flagged
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-2.5 px-3">T&A No</th>
                <th className="py-2.5 px-3">Buyer</th>
                <th className="py-2.5 px-3">Style & Description</th>
                <th className="py-2.5 px-3">SO / IO</th>
                <th className="py-2.5 px-3 text-right">Order Qty</th>
                <th className="py-2.5 px-3">Shipment Date</th>
                <th className="py-2.5 px-3">Completion %</th>
                <th className="py-2.5 px-3 text-center">Risk Level</th>
                <th className="py-2.5 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {(!d.critical_watchlist || d.critical_watchlist.length === 0) ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-slate-400">
                    No critical or at-risk orders on the watchlist. Excellent factory performance!
                  </td>
                </tr>
              ) : (
                d.critical_watchlist.map((row: any) => (
                  <tr
                    key={row.id}
                    className="hover:bg-slate-50 transition-colors cursor-pointer"
                    onClick={() => nav(`/tna/${row.id}`)}
                  >
                    <td className="py-3 px-3 font-mono font-bold text-brand-700">{row.tna_no}</td>
                    <td className="py-3 px-3 font-semibold text-slate-900">{row.buyer_name}</td>
                    <td className="py-3 px-3">
                      <div className="font-mono font-medium">{row.style_code}</div>
                      <div className="text-[11px] text-slate-500">{row.style_name}</div>
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-600">
                      <div>{row.so_no}</div>
                      <div className="text-[11px] text-slate-400">IO: {row.io_no || '—'}</div>
                    </td>
                    <td className="py-3 px-3 text-right font-mono font-medium">
                      {fmtNumber(row.order_qty)}
                    </td>
                    <td className="py-3 px-3 font-bold text-rose-600">
                      {fmtDate(row.shipment_date)}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[11px]">{row.completion_percentage}%</span>
                        <div className="w-16 bg-slate-200 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="h-1.5 rounded-full bg-rose-500"
                            style={{ width: `${Math.min(100, Math.max(0, row.completion_percentage))}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span className="rounded-full bg-rose-100 border border-rose-200 text-rose-800 font-bold px-2 py-0.5 text-[10px]">
                        {row.shipment_risk}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <button
                        type="button"
                        className="btn-ghost btn-xs text-brand-600 hover:text-brand-800 flex items-center gap-1 ml-auto"
                        onClick={(e) => {
                          e.stopPropagation();
                          nav(`/tna/${row.id}`);
                        }}
                      >
                        Open <ArrowRight size={12} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
