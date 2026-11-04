import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { PageHeader, Card, Button, LoadingBlock, ErrorState } from '../../components/ui';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Kpi, label } from './labShared';

/** Lab dashboard (spec §9.1, §12): workload counters, approval ageing and the most failed parameters (90 days). */
export function LabDashboardPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['lab-dashboard'], queryFn: async () => (await http.get<{ data: any }>('/lab/dashboard/summary')).data, refetchInterval: 120_000 });
  const d = q.data; const k = d?.kpis ?? {};
  return (
    <div>
      <PageHeader title="Lab dashboard" breadcrumb={['Lab']} subtitle="Washing, garment and textile testing — requests, trials and the dual approval queue"
        actions={can('LAB.CREATE') && <Button id="lab-dash-new" onClick={() => nav('/lab/requests/create')}><Plus size={15} />New lab request</Button>} />
      {q.isLoading ? <div className="card"><LoadingBlock /></div> : q.error ? <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : (
        <div className="space-y-4">
          <div id="lab-kpis" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Open requests" value={k.open_requests ?? 0} onClick={() => nav('/lab/requests?open=1')} />
            <Kpi label="Pending sample inward" value={k.pending_inward ?? 0} tone="amber" onClick={() => nav('/lab/requests?status=SUBMITTED')} />
            <Kpi label="Samples awaiting testing" value={k.samples_awaiting_testing ?? 0} tone="indigo" onClick={() => nav('/lab/requests?status=SAMPLE_RECEIVED')} />
            <Kpi label="Trials in progress" value={k.trials_in_progress ?? 0} onClick={() => nav('/lab/trials?status=IN_PROGRESS,COMPLETED')} />
            <Kpi label="Lab review pending" value={k.lab_review_pending ?? 0} tone="violet" onClick={() => nav('/lab/review')} />
            <Kpi label="QA approval pending" value={k.qa_approval_pending ?? 0} tone="violet" onClick={() => nav('/lab/qa-approval')} />
            <Kpi label="Retest required" value={k.retest_required ?? 0} tone="amber" onClick={() => nav('/lab/trials?type=RETEST')} />
            <Kpi label="Failed trials (month)" value={k.failed_trials_month ?? 0} tone="red" onClick={() => nav('/lab/trials?result=FAIL')} />
            <Kpi label="Approved today" value={k.approved_today ?? 0} tone="green" onClick={() => nav('/lab/reports?status=APPROVED,RELEASED')} />
            <Kpi label="Approved this month" value={k.approved_month ?? 0} tone="green" onClick={() => nav('/lab/reports?status=APPROVED,RELEASED')} />
            <Kpi label="Overdue requests" value={k.overdue_requests ?? 0} tone="red" onClick={() => nav('/lab/requests?open=1')} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Pending approval — ageing (days)">
              <div className="overflow-x-auto">
                <table className="w-full" id="lab-ageing">
                  <thead><tr><th className="th">Stage</th><th className="th text-right">0–1</th><th className="th text-right">2–3</th><th className="th text-right">4–7</th><th className="th text-right">8+</th></tr></thead>
                  <tbody>
                    {(d?.ageing ?? []).length === 0 && <tr><td className="td text-center text-ink-muted" colSpan={5}>Nothing pending</td></tr>}
                    {(d?.ageing ?? []).map((a: any) => (
                      <tr key={a.stage}><td className="td">{a.stage === 'PENDING_LAB' ? 'Lab In-charge' : 'QA Manager'}</td>
                        <td className="td text-right tabular-nums">{a.d0_1}</td><td className="td text-right tabular-nums">{a.d2_3}</td>
                        <td className="td text-right tabular-nums">{a.d4_7}</td><td className="td text-right tabular-nums">{a.d8 ? <span className="font-semibold text-red-600">{a.d8}</span> : 0}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Most failed parameters (90 days)">
              <div className="p-4">
                {(d?.failures ?? []).length === 0 ? <p className="text-small text-ink-muted">No failures recorded</p> : (d.failures as any[]).map((f) => {
                  const max = Math.max(1, ...d.failures.map((x: any) => Number(x.fails)));
                  return (
                    <div key={f.code} className="mb-2">
                      <div className="flex justify-between text-small"><span>{f.name}</span><span className="tabular-nums">{f.fails}</span></div>
                      <div className="h-2 rounded bg-surface-header"><div className="h-2 rounded bg-red-400" style={{ width: `${(Number(f.fails) / max) * 100}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            </Card>
            <Card title="Requests by status">
              <div className="flex flex-wrap gap-2 p-4">
                {(d?.requests_by_status ?? []).length === 0 && <p className="text-small text-ink-muted">No lab requests yet</p>}
                {(d?.requests_by_status ?? []).map((s: any) => (
                  <button key={s.status} type="button" className="rounded-lg border border-surface-border px-3 py-2 text-left hover:border-brand-400"
                    onClick={() => nav(`/lab/requests?status=${s.status}`)}>
                    <p className="text-caption text-ink-secondary">{label(s.status)}</p><p className="text-title font-semibold tabular-nums">{s.c}</p>
                  </button>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
