/** Transport coordinator dashboard (spec §9.1 / §10): KPIs, pending queue, today's schedule, open issues, expiring documents. */
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Plus, Truck } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, LoadingBlock, ErrorState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { fmtDate, humanize } from '../../lib/format';
import { StatusPill, TRIP_TONE, REQUEST_TONE, PRIORITY_TONE, fmtIst } from './transportShared';

export function TransportDashboard() {
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['transport', 'dashboard'], queryFn: async () => (await http.get<{ data: any }>('/transport/dashboard')).data, refetchInterval: 60_000 });
  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const { kpis: k, schedule, queue, issues, expiring } = q.data;
  const tiles: [string, number | string, string, boolean?][] = [
    ['New requests', k.new_requests, '/transport/requests?scope=all&queue=NEW'],
    ['Under review', k.under_review, '/transport/requests?scope=all&queue=UNDER_REVIEW'],
    ['Approved – unassigned', k.approved_unassigned, '/transport/requests?scope=all&queue=APPROVED_UNASSIGNED'],
    ['Delayed requests', k.delayed, '/transport/requests?scope=all&queue=DELAYED', k.delayed > 0],
    ['Trips in progress', k.trips_running, '/transport/trips?status=STARTED,IN_PROGRESS'],
    ['Completed today', k.completed_today, '/transport/requests?scope=all&queue=COMPLETED_TODAY'],
    ['Delivered – awaiting receipt', k.pending_receipt ?? 0, '/transport/requests?scope=all&queue=PENDING_RECEIPT'],
    ['Available vehicles', `${k.available_vehicles} / ${k.vehicles}`, '/transport/vehicles'],
    ['Available drivers', `${k.available_drivers} / ${k.drivers}`, '/transport/drivers'],
    ['Owned vs rental trips (month)', `${k.owned_trips_month} : ${k.rental_trips_month}`, '/gate/reports#vehicle-utilisation'],
    ['Trip exceptions', k.trip_exceptions, '/transport/trips?status=EXCEPTION', k.trip_exceptions > 0],
    ['Open issues', k.open_issues, '/transport/trips', k.open_issues > 0],
    ['Rejected', k.rejected, '/transport/requests?scope=all&queue=REJECTED'],
  ];
  return (
    <>
      <PageHeader title="Transport Dashboard" subtitle="Vehicle requests, trips and fleet availability today"
        actions={<>
          {can('TRANSPORT.ASSIGN') && <button className="btn-primary" onClick={() => nav('/transport/trips/new')}><Truck size={15} /> Plan Trip</button>}
          {can('TRANSPORT.REQUEST') && <button className="btn-secondary" onClick={() => nav('/transport/requests/new')}><Plus size={15} /> New Request</button>}
        </>} />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-kpis>
        {tiles.map(([label, val, to, alert]) => (
          <Link key={label} to={to} className={clsx('card p-3 hover:bg-surface-hover', alert && 'border-red-300')}>
            <p className="text-caption text-ink-secondary">{label}</p>
            <p className={clsx('text-title-lg font-semibold tabular-nums', alert ? 'text-red-600' : 'text-ink')}>{val}</p>
          </Link>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 text-title font-semibold text-ink">Today's schedule & running trips</h3>
          {!schedule.length && <p className="text-body text-ink-secondary">No trips today.</p>}
          <ul className="divide-y divide-surface-divider">
            {schedule.map((t: any) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2 text-body">
                <Link to={`/transport/trips/${t.id}`} className="font-semibold text-brand-700">{t.trip_no}</Link>
                <StatusPill value={t.status} tones={TRIP_TONE} />
                <span className="tabular-nums">{fmtIst(t.planned_start_at, false)}–{fmtIst(t.planned_end_at, false)}</span>
                <span>{t.vehicle_no} · {t.driver_name}</span>
                <span className="text-ink-secondary">{t.stops_done}/{t.stops} stops</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-title font-semibold text-ink">Pending queue</h3>
          {!queue.length && <p className="text-body text-ink-secondary">Nothing waiting.</p>}
          <ul className="divide-y divide-surface-divider">
            {queue.map((r: any) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-body">
                <Link to={`/transport/requests/${r.id}`} className="font-semibold text-brand-700">{r.request_no}</Link>
                <StatusPill value={r.status} tones={REQUEST_TONE} />{r.priority !== 'NORMAL' && <StatusPill value={r.priority} tones={PRIORITY_TONE} />}
                <span>{r.type_name}</span><span className="text-ink-secondary">{r.requester} · needed {fmtIst(r.required_at)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-title font-semibold text-ink">Open issues</h3>
          {!issues.length && <p className="text-body text-ink-secondary">No open issues.</p>}
          <ul className="space-y-1.5">
            {issues.map((i: any) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 text-body">
                <AlertTriangle size={14} className="text-amber-600" /><Link to={`/transport/trips/${i.trip_id}`} className="text-brand-700">{i.trip_no}</Link>
                <b>{humanize(i.issue_type)}</b><span>{i.description}</span><span className="text-caption text-ink-secondary">{fmtIst(i.reported_at)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-title font-semibold text-ink">Documents expiring in 30 days</h3>
          {!expiring.length && <p className="text-body text-ink-secondary">Nothing expiring.</p>}
          <ul className="space-y-1">
            {expiring.map((e: any) => (
              <li key={`${e.kind}${e.id}`} className="text-body">
                <Link to={e.kind === 'VEHICLE' ? '/transport/vehicles' : '/transport/drivers'} className="text-brand-700">{e.name}</Link> · {e.kind === 'VEHICLE' ? 'vehicle papers' : 'driving licence'} ·{' '}
                <span className={e.expired ? 'font-semibold text-red-600' : 'text-amber-700'}>{e.expired ? 'expired' : 'expires'} {fmtDate(e.expiry)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
