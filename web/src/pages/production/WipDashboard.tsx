import { useEffect, useState, useCallback } from 'react';
import { Badge } from '../../components/ui';
import { fmtNumber } from '../../lib/format';
import { api } from '../../lib/api';

interface StageWip { stage_code: string; stage_name: string; sort_order: number;
  wip_qty: number; input_qty: number; output_qty: number; rejected_qty: number; rework_qty: number; }
interface DailyKpi { total_plan: number; total_actual: number; total_reject: number;
  total_rework: number; achievement_pct: number; }

export function WipDashboardPage() {
  const [wipStages, setWipStages] = useState<StageWip[]>([]);
  const [dailyKpi, setDailyKpi] = useState<DailyKpi | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/dashboard/wip-widget');
      setWipStages(res.data?.data?.wipStages ?? []);
      setDailyKpi(res.data?.data?.dailyKpi ?? null);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 30000); return () => clearInterval(iv); }, [load]);

  const totalWip = wipStages.reduce((s, r) => s + Number(r.wip_qty ?? 0), 0);
  const maxWip = Math.max(1, ...wipStages.map(r => Number(r.wip_qty ?? 0)));

  const achPct = dailyKpi?.achievement_pct ?? 0;
  const achColor = achPct >= 95 ? 'emerald' : achPct >= 85 ? 'amber' : 'red';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">WIP Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">Real-time work-in-progress across all production stages</p>
      </div>

      {/* Daily KPI banner */}
      {dailyKpi && (
        <div className="grid grid-cols-5 gap-4">
          {[
            { label: 'Today Plan', value: fmtNumber(dailyKpi.total_plan), tone: 'blue' },
            { label: 'Actual Good', value: fmtNumber(dailyKpi.total_actual), tone: 'emerald' },
            { label: 'Rejected', value: fmtNumber(dailyKpi.total_reject), tone: 'red' },
            { label: 'Rework', value: fmtNumber(dailyKpi.total_rework), tone: 'amber' },
            { label: 'Achievement', value: `${achPct}%`, tone: achColor },
          ].map(kpi => (
            <div key={kpi.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{kpi.label}</p>
              <p className={`mt-1 text-2xl font-bold text-${kpi.tone}-700`}>{kpi.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Total WIP */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-800">Stage-wise WIP</h2>
          <Badge tone="violet">{fmtNumber(totalWip)} pcs total WIP</Badge>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-400">Loading…</div>
        ) : wipStages.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-slate-400">No WIP data — create process transactions</div>
        ) : (
          <div className="space-y-3">
            {wipStages.map(stage => {
              const wip = Number(stage.wip_qty ?? 0);
              const pct = (wip / maxWip) * 100;
              return (
                <div key={stage.stage_code} className="flex items-center gap-4">
                  <div className="w-32 text-sm font-medium text-slate-700 truncate">{stage.stage_name}</div>
                  <div className="flex-1">
                    <div className="h-8 rounded-lg bg-slate-50 overflow-hidden relative">
                      <div
                        className="h-full rounded-lg bg-gradient-to-r from-brand-400 to-brand-600 transition-all duration-700"
                        style={{ width: `${Math.max(0, pct)}%` }}
                      />
                      {wip > 0 && (
                        <span className="absolute inset-y-0 left-3 flex items-center text-xs font-semibold text-white drop-shadow">
                          {fmtNumber(wip)} pcs
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-3 text-xs tabular-nums">
                    <span className="text-slate-500">In: {fmtNumber(stage.input_qty)}</span>
                    <span className="text-emerald-600">Out: {fmtNumber(stage.output_qty)}</span>
                    {Number(stage.rejected_qty) > 0 && <span className="text-red-500">Rej: {fmtNumber(stage.rejected_qty)}</span>}
                    {Number(stage.rework_qty) > 0 && <span className="text-amber-500">Rwk: {fmtNumber(stage.rework_qty)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pipeline flow */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Production Pipeline Flow</h2>
        <div className="flex items-center gap-0 overflow-x-auto pb-2">
          {wipStages.map((stage, idx) => (
            <div key={stage.stage_code} className="flex items-center">
              <div className="text-center min-w-[100px]">
                <div className={`mx-auto w-14 h-14 rounded-full flex items-center justify-center text-sm font-bold shadow
                  ${Number(stage.wip_qty) > 0
                    ? 'bg-gradient-to-br from-brand-500 to-brand-700 text-white'
                    : 'bg-slate-100 text-slate-400'}`}>
                  {fmtNumber(stage.wip_qty)}
                </div>
                <p className="mt-1 text-[11px] font-medium text-slate-600 truncate">{stage.stage_name}</p>
              </div>
              {idx < wipStages.length - 1 && (
                <div className="flex items-center -mx-1">
                  <div className="w-8 h-0.5 bg-slate-300" />
                  <svg className="w-3 h-3 text-slate-400 -ml-0.5" viewBox="0 0 12 12" fill="currentColor">
                    <path d="M2 1l8 5-8 5V1z"/>
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
