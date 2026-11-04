/**
 * Trips / programs (spec §4.5): list, planner (approved requests → driver + vehicle + ordered stops, with availability and
 * conflict warnings) and trip detail (stop sequence, requests, issues, timeline, reassign / cancel / exception close).
 *   /transport/trips  ·  /transport/trips/new?requests=1,2  ·  /transport/trips/:id  ·  /transport/trips/:id/plan
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowUp, ArrowDown, Trash2, Wand2, AlertTriangle, Truck, RefreshCw, Ban, CheckCircle2, Route } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Select, Input, Textarea, Spinner, LoadingBlock, ErrorState, SearchInput, Modal, ImageThumbnail, useDebounced } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { humanize } from '../../lib/format';
import { StatusPill, TRIP_TONE, STOP_TONE, REQUEST_TONE, PRIORITY_TONE, fmtIst, toLocalInput, localToIso, Timeline, Info, ReasonDialog, errMsg } from './transportShared';

const TRIP_STATUSES = ['DRAFT', 'ASSIGNED', 'DRIVER_ACCEPTED', 'STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXCEPTION'].map((s) => ({ value: s, label: humanize(s) }));

export function TransportTripsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [f, setF] = useState({ status: '', from: '', to: '' });
  const params = { q: q || undefined, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) };
  const list = useQuery({ queryKey: ['transport', 'trips', params], queryFn: async () => (await http.get<{ data: any[] }>('/transport/trips', params)).data });
  const cols: Column<any>[] = [
    { key: 'trip_no', header: 'Trip', render: (t) => <div><p className="font-semibold text-brand-700">{t.trip_no}</p><p className="text-caption text-ink-secondary">{t.purpose ?? ''}</p></div> },
    { key: 'planned_start_at', header: 'Planned', render: (t) => <span className="tabular-nums">{fmtIst(t.planned_start_at)} – {fmtIst(t.planned_end_at, false)}</span> },
    { key: 'vehicle_no', header: 'Vehicle', render: (t) => t.vehicle_no ? <div><p>{t.vehicle_no}</p><p className="text-caption text-ink-secondary">{humanize(t.ownership_type)} · {humanize(t.vehicle_type)}</p></div> : '—' },
    { key: 'driver_name', header: 'Driver', render: (t) => t.driver_name ?? '—' },
    { key: 'request_nos', header: 'Requests', render: (t) => <span className="text-small">{t.request_nos ?? '—'}</span> },
    { key: 'stops', header: 'Stops', align: 'right', render: (t) => <span className="tabular-nums">{t.stops_done}/{t.stop_count}</span> },
    { key: 'status', header: 'Status', render: (t) => <div className="flex items-center gap-1"><StatusPill value={t.status} tones={TRIP_TONE} />{Number(t.open_issues) > 0 && <span title="Open issues" className="text-amber-600"><AlertTriangle size={14} /></span>}</div> },
  ];
  return (
    <>
      <PageHeader title="Trips / Programs" subtitle="One driver + one vehicle per trip; a trip can serve several requests with ordered stops"
        actions={can('TRANSPORT.ASSIGN') && <button className="btn-primary" onClick={() => nav('/transport/trips/new')} data-action="new-trip"><Plus size={15} /> Plan Trip</button>} />
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        <SearchInput value={search} onChange={setSearch} placeholder="Trip, vehicle, driver, request no…" className="col-span-2" />
        <Select placeholder="Any status" options={TRIP_STATUSES} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status" />
        <input className="input" type="date" aria-label="From" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" aria-label="To" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      </div>
      <DataTable columns={cols} rows={list.data ?? []} loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} rowKey={(t) => t.id}
        onRowClick={(t) => nav(`/transport/trips/${t.id}`)} emptyTitle="No trips" emptyMessage="Plan a trip from approved vehicle requests." />
    </>
  );
}

/* ====================================================================== planner */
type Line = { request_id: number; service_type: 'PICKUP' | 'DELIVERY'; expected_qty: number | null };
type StopDraft = { key: number; stop_type: string; location_name: string; address: string; expected_arrival_at: string; contact_name: string; contact_mobile: string; is_mandatory: boolean; lines: Line[] };
let skey = 0;
function autoStops(reqs: any[]): StopDraft[] {
  const pick: StopDraft[] = []; const drop: StopDraft[] = [];
  const add = (arr: StopDraft[], type: 'PICKUP' | 'DELIVERY', name: string, addr: string | null, r: any) => {
    const k = `${name}|${addr ?? ''}`.toLowerCase();
    let s = arr.find((x) => `${x.location_name}|${x.address}`.toLowerCase() === k);
    if (!s) { s = { key: ++skey, stop_type: type, location_name: name, address: addr ?? '', expected_arrival_at: '', contact_name: r.contact_name ?? '', contact_mobile: r.contact_mobile ?? '', is_mandatory: true, lines: [] }; arr.push(s); }
    s.lines.push({ request_id: r.id, service_type: type, expected_qty: r.package_qty != null ? Number(r.package_qty) : null });
  };
  for (const r of reqs) {
    if (r.pickup_location) add(pick, 'PICKUP', r.pickup_location, r.pickup_address, r);
    if (r.destination_location) add(drop, 'DELIVERY', r.destination_location, r.destination_address, r);
    if (!r.pickup_location && !r.destination_location) add(drop, 'DELIVERY', String(r.purpose).slice(0, 160), null, r);
  }
  return [...pick, ...drop];
}

export function TripPlanner() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['transport', 'trip', id], enabled: !!id, queryFn: async () => (await http.get<{ data: any }>(`/transport/trips/${id}`)).data });
  const reqs = useQuery({ queryKey: ['transport', 'assignable', id], queryFn: async () => (await http.get<{ data: any[] }>('/transport/assignable-requests', id ? { trip_id: id } : {})).data });
  const [selected, setSelected] = useState<number[]>([]);
  const [win, setWin] = useState({ start: '', end: '' });
  const [hdr, setHdr] = useState({ purpose: '', remarks: '', driver_id: '', vehicle_id: '' });
  const [stops, setStops] = useState<StopDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [init, setInit] = useState(false);

  // initial state: from the trip being re-planned, or from ?requests=…
  useEffect(() => {
    if (init || !reqs.data || (id && !existing.data)) return;
    if (id && existing.data) {
      const t = existing.data;
      setSelected(t.requests.map((r: any) => r.id));
      setWin({ start: toLocalInput(t.planned_start_at), end: toLocalInput(t.planned_end_at) });
      setHdr({ purpose: t.purpose ?? '', remarks: t.remarks ?? '', driver_id: t.driver_id ? String(t.driver_id) : '', vehicle_id: t.vehicle_id ? String(t.vehicle_id) : '' });
      setStops(t.stops.map((s: any) => ({ key: ++skey, stop_type: s.stop_type, location_name: s.location_name, address: s.address ?? '', expected_arrival_at: toLocalInput(s.expected_arrival_at),
        contact_name: s.contact_name ?? '', contact_mobile: s.contact_mobile ?? '', is_mandatory: !!s.is_mandatory,
        lines: s.lines.map((l: any) => ({ request_id: Number(l.request_id), service_type: l.service_type, expected_qty: l.expected_qty != null ? Number(l.expected_qty) : null })) })));
    } else {
      const ids = (sp.get('requests') ?? '').split(',').map(Number).filter(Boolean).filter((x) => reqs.data!.some((r) => r.id === x));
      setSelected(ids);
      const first = reqs.data.filter((r) => ids.includes(r.id)).map((r) => new Date(r.required_at).getTime()).sort()[0];
      const base = first ? first - 30 * 60_000 : Date.now() + 30 * 60_000;
      setWin({ start: toLocalInput(new Date(base)), end: toLocalInput(new Date(base + 3 * 3_600_000)) });
      setStops(autoStops(reqs.data.filter((r) => ids.includes(r.id))));
    }
    setInit(true);
  }, [reqs.data, existing.data, id, sp, init]);

  const avail = useQuery({
    queryKey: ['transport', 'availability', win, id], enabled: !!win.start && !!win.end && win.end > win.start,
    queryFn: async () => (await http.get<{ data: { vehicles: any[]; drivers: any[] } }>('/transport/availability', { start: localToIso(win.start), end: localToIso(win.end), trip_id: id })).data,
  });
  const selReqs = useMemo(() => (reqs.data ?? []).filter((r) => selected.includes(r.id)), [reqs.data, selected]);
  const toggle = (rid: number) => {
    const next = selected.includes(rid) ? selected.filter((x) => x !== rid) : [...selected, rid];
    setSelected(next);
    if (!selected.includes(rid)) {
      const r = reqs.data!.find((x) => x.id === rid);
      setStops((s) => [...s, ...autoStops([r])]);
    } else setStops((s) => s.map((x) => ({ ...x, lines: x.lines.filter((l) => l.request_id !== rid) })).filter((x) => x.lines.length || !x.location_name));
  };
  const move = (i: number, d: -1 | 1) => setStops((s) => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return s; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const upd = (i: number, patch: Partial<StopDraft>) => setStops((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const setLine = (i: number, rid: number, svc: '' | 'PICKUP' | 'DELIVERY') => setStops((s) => s.map((x, k) => {
    if (k !== i) return x;
    const rest = x.lines.filter((l) => l.request_id !== rid);
    const r = selReqs.find((y) => y.id === rid);
    return { ...x, lines: svc ? [...rest, { request_id: rid, service_type: svc, expected_qty: r?.package_qty != null ? Number(r.package_qty) : null }] : rest };
  }));
  const uncovered = selReqs.filter((r) => !stops.some((s) => s.lines.some((l) => l.request_id === r.id)));
  const vehicle = avail.data?.vehicles.find((v) => String(v.id) === hdr.vehicle_id);
  const driver = avail.data?.drivers.find((d) => String(d.id) === hdr.driver_id);
  const timeWarn = selReqs.filter((r) => { const t = new Date(r.required_at).getTime(); return win.start && win.end && (t < new Date(localToIso(win.start)).getTime() - 4 * 3_600_000 || t > new Date(localToIso(win.end)).getTime()); });

  const save = async () => {
    setErr('');
    if (!selected.length) { setErr('Select at least one approved request'); return; }
    if (!hdr.driver_id || !hdr.vehicle_id) { setErr('Select the driver and the vehicle'); return; }
    if (uncovered.length) { setErr(`Add a stop for ${uncovered.map((r) => r.request_no).join(', ')}`); return; }
    const body = {
      planned_start_at: localToIso(win.start), planned_end_at: localToIso(win.end), purpose: hdr.purpose, remarks: hdr.remarks,
      driver_id: Number(hdr.driver_id), vehicle_id: Number(hdr.vehicle_id), request_ids: selected, row_version: existing.data?.row_version,
      stops: stops.filter((s) => s.location_name.trim()).map((s) => ({ stop_type: s.stop_type, location_name: s.location_name, address: s.address, expected_arrival_at: s.expected_arrival_at ? localToIso(s.expected_arrival_at) : null,
        contact_name: s.contact_name, contact_mobile: s.contact_mobile, is_mandatory: s.is_mandatory, requests: s.lines })),
    };
    setBusy(true);
    try {
      const res = id ? await http.post<{ data: any }>(`/transport/trips/${id}/assign`, body) : await http.post<{ data: any; message?: string }>('/transport/trips', body);
      void qc.invalidateQueries({ queryKey: ['transport'] });
      toast((res as any).message ?? `Trip ${res.data.trip_no} saved — the driver has been notified`);
      nav(`/transport/trips/${res.data.id}`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  if (reqs.isLoading || (id && existing.isLoading)) return <LoadingBlock />;
  if (reqs.error) return <ErrorState error={reqs.error} />;
  const optLabel = (x: any, name: string) => `${name}${x.conflicts?.length ? ` — busy: ${x.conflicts.map((c: any) => c.trip_no).join(', ')}` : ''}${x.availability_status !== 'AVAILABLE' ? ` — ${humanize(x.availability_status)}` : ''}${x.warnings?.length ? ' ⚠' : ''}`;
  return (
    <>
      <PageHeader breadcrumb={['Gate Security', 'Trips']} title={id ? `Re-plan ${existing.data?.trip_no}` : 'Plan Trip / Allocate Vehicle'}
        subtitle="Pick approved requests, the time window, a free driver and vehicle, then order the stops"
        actions={<Link className="btn-secondary" to={id ? `/transport/trips/${id}` : '/transport/trips'}>Cancel</Link>} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[400px_1fr]">
        <div className="card h-fit p-3" data-panel="requests">
          <h3 className="mb-2 text-title font-semibold text-ink">Approved requests</h3>
          {!reqs.data?.length && <p className="text-body text-ink-secondary">No approved requests waiting for a vehicle.</p>}
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {(reqs.data ?? []).map((r) => (
              <li key={r.id}>
                <label className={clsx('flex cursor-pointer gap-2 rounded-md border px-2 py-1.5', selected.includes(r.id) ? 'border-brand-500 bg-brand-50' : 'border-surface-border hover:bg-surface-hover')}>
                  <input type="checkbox" className="mt-1" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} data-request={r.request_no} />
                  <span className="min-w-0 text-body">
                    <span className="font-semibold">{r.request_no}</span> <StatusPill value={r.priority} tones={PRIORITY_TONE} />
                    <span className="block truncate text-small text-ink-secondary">{r.type_name} · {fmtIst(r.required_at)} · {r.requested_by_name}</span>
                    <span className="block truncate text-small">{[r.pickup_location, r.destination_location].filter(Boolean).join(' → ') || r.purpose}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-4">
          <div className="card grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <Input label="Planned start" required type="datetime-local" value={win.start} onChange={(e) => setWin({ ...win, start: e.target.value })} data-field="planned_start_at" />
            <Input label="Planned end" required type="datetime-local" value={win.end} onChange={(e) => setWin({ ...win, end: e.target.value })} data-field="planned_end_at" />
            <Select label="Vehicle" required placeholder={avail.isLoading ? 'Loading…' : '— Select —'} value={hdr.vehicle_id} onChange={(e) => setHdr({ ...hdr, vehicle_id: e.target.value })} data-field="vehicle_id"
              options={(avail.data?.vehicles ?? []).map((v) => ({ value: v.id, label: optLabel(v, `${v.registration_no} · ${humanize(v.ownership_type)} ${humanize(v.vehicle_type)}`), disabled: !v.assignable && String(v.id) !== hdr.vehicle_id }))} />
            <Select label="Driver" required placeholder={avail.isLoading ? 'Loading…' : '— Select —'} value={hdr.driver_id} onChange={(e) => setHdr({ ...hdr, driver_id: e.target.value })} data-field="driver_id"
              options={(avail.data?.drivers ?? []).map((d) => ({ value: d.id, label: optLabel(d, d.driver_name), disabled: !d.assignable && String(d.id) !== hdr.driver_id }))} />
            <Input label="Purpose" className="sm:col-span-2" value={hdr.purpose} onChange={(e) => setHdr({ ...hdr, purpose: e.target.value })} />
            <Input label="Coordinator notes for the driver" className="sm:col-span-2" value={hdr.remarks} onChange={(e) => setHdr({ ...hdr, remarks: e.target.value })} />
          </div>
          {(vehicle?.warnings?.length || driver?.warnings?.length || vehicle?.conflicts?.length || driver?.conflicts?.length || timeWarn.length) ? (
            <div className="card border-amber-300 bg-amber-50 p-3 text-body" data-conflicts>
              <p className="flex items-center gap-1.5 font-semibold text-ink"><AlertTriangle size={15} className="text-amber-600" /> Check before saving</p>
              <ul className="ml-5 list-disc text-ink">
                {[...(vehicle?.warnings ?? []), ...(driver?.warnings ?? [])].map((w: string) => <li key={w}>{w}</li>)}
                {[...(vehicle?.conflicts ?? []), ...(driver?.conflicts ?? [])].map((c: any) => <li key={`${c.trip_no}`}>Already on {c.trip_no} ({fmtIst(c.from)} – {fmtIst(c.to, false)}) — overlapping bookings are blocked</li>)}
                {timeWarn.map((r) => <li key={r.id}>{r.request_no} is needed at {fmtIst(r.required_at)} — outside the trip window</li>)}
              </ul>
            </div>
          ) : null}
          <div className="card p-3" data-panel="stops">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-title font-semibold text-ink">Stops (in order)</h3>
              <div className="flex gap-2">
                <button className="btn-secondary btn-sm" onClick={() => setStops(autoStops(selReqs))} data-action="auto-stops"><Wand2 size={13} /> Generate from requests</button>
                <button className="btn-secondary btn-sm" onClick={() => setStops((s) => [...s, { key: ++skey, stop_type: 'PICKUP', location_name: '', address: '', expected_arrival_at: '', contact_name: '', contact_mobile: '', is_mandatory: true, lines: [] }])}><Plus size={13} /> Add stop</button>
              </div>
            </div>
            {!stops.length && <p className="text-body text-ink-secondary">Select requests — stops are generated from their pickup and destination.</p>}
            <ol className="space-y-2">
              {stops.map((s, i) => (
                <li key={s.key} className="rounded-md border border-surface-border p-2" data-stop={i + 1}>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[32px_140px_1fr_1fr_170px_auto] sm:items-end">
                    <span className="text-title font-semibold text-ink-secondary">{i + 1}</span>
                    <Select label="Type" value={s.stop_type} onChange={(e) => upd(i, { stop_type: e.target.value })}
                      options={[{ value: 'PICKUP', label: 'Pickup' }, { value: 'DELIVERY', label: 'Delivery' }, { value: 'PICKUP_DELIVERY', label: 'Pickup + delivery' }, { value: 'OTHER', label: 'Other' }]} />
                    <Input label="Location" value={s.location_name} onChange={(e) => upd(i, { location_name: e.target.value })} />
                    <Input label="Address" value={s.address} onChange={(e) => upd(i, { address: e.target.value })} />
                    <Input label="Expected arrival" type="datetime-local" value={s.expected_arrival_at} onChange={(e) => upd(i, { expected_arrival_at: e.target.value })} />
                    <div className="flex gap-0.5 pb-1">
                      <button className="rounded p-1.5 hover:bg-surface-hover" title="Up" onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                      <button className="rounded p-1.5 hover:bg-surface-hover" title="Down" onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                      <button className="rounded p-1.5 text-red-600 hover:bg-red-50" title="Remove" onClick={() => setStops((x) => x.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selReqs.map((r) => {
                      const l = s.lines.find((x) => x.request_id === r.id);
                      return (
                        <label key={r.id} className={clsx('flex items-center gap-1 rounded border px-1.5 py-0.5 text-small', l ? 'border-brand-400 bg-brand-50' : 'border-surface-border')}>
                          {r.request_no}
                          <select className="bg-transparent text-small" value={l?.service_type ?? ''} onChange={(e) => setLine(i, r.id, e.target.value as '' | 'PICKUP' | 'DELIVERY')} aria-label={`${r.request_no} at stop ${i + 1}`}>
                            <option value="">—</option><option value="PICKUP">Pickup</option><option value="DELIVERY">Delivery</option>
                          </select>
                        </label>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ol>
            {uncovered.length > 0 && <p className="mt-2 text-small text-red-600">No stop yet for {uncovered.map((r) => r.request_no).join(', ')}</p>}
          </div>
          {err && <div className="card border-red-200 bg-red-50 p-3 text-body text-red-800" data-error>{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="btn-primary" disabled={busy} onClick={() => void save()} data-action="assign-trip">{busy ? <Spinner size={14} /> : <Truck size={15} />} {id ? 'Save plan' : 'Assign trip'}</button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ====================================================================== detail */
export function TripDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['transport', 'trip', id], queryFn: async () => (await http.get<{ data: any }>(`/transport/trips/${id}`)).data });
  const [dialog, setDialog] = useState<'' | 'cancel' | 'exception' | 'reassign'>('');
  const [resolve, setResolve] = useState<any>(null);
  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const t = q.data; const a = t.actions ?? {};
  const refresh = () => void qc.invalidateQueries({ queryKey: ['transport'] });
  const km = t.start_odometer != null && t.end_odometer != null ? Number(t.end_odometer) - Number(t.start_odometer) : null;
  return (
    <>
      <PageHeader breadcrumb={['Gate Security', 'Trips']} title={<span className="flex flex-wrap items-center gap-2">{t.trip_no} <StatusPill value={t.status} tones={TRIP_TONE} />{t.exception_closed ? <StatusPill value="EXCEPTION" tones={TRIP_TONE} /> : null}</span>}
        subtitle={t.purpose ?? undefined}
        actions={<>
          {a.assign && <button className="btn-secondary" onClick={() => nav(`/transport/trips/${id}/plan`)} data-action="replan"><Route size={14} /> Re-plan</button>}
          {a.reassign && <button className="btn-secondary" onClick={() => setDialog('reassign')} data-action="reassign"><RefreshCw size={14} /> Reassign driver / vehicle</button>}
          {a.exceptionClose && <button className="btn-secondary" onClick={() => setDialog('exception')} data-action="exception-close"><CheckCircle2 size={14} /> Close with exception</button>}
          {a.cancel && <button className="btn-ghost text-red-700" onClick={() => setDialog('cancel')} data-action="cancel-trip"><Ban size={14} /> Cancel trip</button>}
        </>} />
      {t.status === 'EXCEPTION' && t.driver_reject_reason && <div className="card mb-3 border-amber-300 bg-amber-50 p-3 text-body"><b>Driver rejected:</b> {t.driver_reject_reason} — reassign the trip.</div>}
      {!!t.conflicts?.length && <div className="card mb-3 border-red-200 bg-red-50 p-3 text-body"><b>Conflict:</b> {t.conflicts.map((c: any) => c.trip_no).join(', ')} overlap this trip.</div>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
            <Info label="Vehicle">{t.vehicle_no ? `${t.vehicle_no} · ${humanize(t.ownership_type)} ${humanize(t.vehicle_type)}` : '—'}{t.rental_provider_name && <p className="text-small text-ink-secondary">{t.rental_provider_name}</p>}</Info>
            <Info label="Driver">{t.driver_name ?? '—'}{t.driver_mobile && <> · <a className="text-brand-700" href={`tel:${t.driver_mobile}`}>{t.driver_mobile}</a></>}</Info>
            <Info label="Planned">{fmtIst(t.planned_start_at)} – {fmtIst(t.planned_end_at, false)}</Info>
            <Info label="Actual">{t.started_at ? `${fmtIst(t.started_at)} – ${t.completed_at ? fmtIst(t.completed_at, false) : '…'}` : '—'}</Info>
            <Info label="Assigned by">{t.assigned_by_name ? `${t.assigned_by_name} · ${fmtIst(t.assigned_at)}` : '—'}</Info>
            <Info label="Accepted">{fmtIst(t.accepted_at)}</Info>
            <Info label="Odometer">{t.start_odometer ?? '—'} → {t.end_odometer ?? '—'}{km != null && ` (${km} km)`}</Info>
            <Info label="Notes">{t.remarks ?? t.exception_reason ?? t.cancellation_reason}</Info>
          </div>
          <div className="card p-4">
            <h3 className="mb-2 text-title font-semibold text-ink">Stops</h3>
            <ol className="space-y-2">
              {t.stops.map((s: any) => (
                <li key={s.id} className="rounded-md border border-surface-border p-2" data-stop-status={s.status}>
                  <div className="flex flex-wrap items-center gap-2 text-body">
                    <b>{s.stop_no}.</b> <span className="font-semibold">{s.location_name}</span> <span className="text-ink-secondary">{humanize(s.stop_type)}</span>
                    <StatusPill value={s.status} tones={STOP_TONE} />
                    {s.actual_arrival_at && <span className="text-small text-ink-secondary">arrived {fmtIst(s.actual_arrival_at, false)}</span>}
                    {s.expected_arrival_at && <span className="text-small text-ink-secondary">expected {fmtIst(s.expected_arrival_at, false)}</span>}
                  </div>
                  {s.address && <p className="text-small text-ink-secondary">{s.address}</p>}
                  <ul className="mt-1 text-small">
                    {s.lines.map((l: any) => (
                      <li key={l.id}>
                        <Link to={`/transport/requests/${l.request_id}`} className="text-brand-700">{l.request_no}</Link> · {humanize(l.service_type)} · <b>{humanize(l.result)}</b>
                        {l.actual_qty != null && ` · qty ${Number(l.actual_qty)}${l.expected_qty != null ? `/${Number(l.expected_qty)}` : ''}`}{l.receiver_name && ` · ${l.receiver_name}`}{l.result_note && ` · ${l.result_note}`}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
          <div className="card p-4">
            <h3 className="mb-2 text-title font-semibold text-ink">Requests on this trip</h3>
            <table className="w-full text-body">
              <tbody>
                {t.requests.map((r: any) => (
                  <tr key={r.id} className="border-b border-surface-divider last:border-0">
                    <td className="py-1.5"><Link to={`/transport/requests/${r.id}`} className="font-semibold text-brand-700">{r.request_no}</Link></td>
                    <td>{r.type_name}</td><td>{r.requested_by_name}</td><td>{fmtIst(r.required_at)}</td>
                    <td><StatusPill value={r.status} tones={REQUEST_TONE} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(t.issues.length > 0 || t.proofs.length > 0) && (
            <div className="card p-4">
              <h3 className="mb-2 text-title font-semibold text-ink">Issues & proof</h3>
              <ul className="space-y-1.5">
                {t.issues.map((i: any) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2 text-body">
                    <AlertTriangle size={14} className={i.resolved_at ? 'text-ink-muted' : 'text-amber-600'} />
                    <b>{humanize(i.issue_type)}</b> <span className="text-ink-secondary">{humanize(i.severity)}</span> {i.description}
                    <span className="text-caption text-ink-secondary">{i.reported_by_name} · {fmtIst(i.reported_at)}</span>
                    {i.resolved_at ? <span className="text-small text-ink-secondary">Resolved: {i.resolution_note}</span>
                      : a.reassign !== undefined && <button className="btn-secondary btn-sm" onClick={() => setResolve(i)}>Resolve</button>}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-3">
                {t.proofs.map((p: any) => <div key={p.id} className="flex items-center gap-2 text-small"><ImageThumbnail url={p.file_url} title={`${p.request_no ?? ''} proof`} /><span>{p.request_no}<br />{p.receiver_name}</span></div>)}
              </div>
            </div>
          )}
        </div>
        <div className="card h-fit p-4"><h3 className="mb-3 text-title font-semibold text-ink">Timeline</h3><Timeline events={t.timeline} /></div>
      </div>
      <ReasonDialog open={dialog === 'cancel'} title={`Cancel ${t.trip_no}`} label="Cancellation reason" confirmLabel="Cancel trip" danger onClose={() => setDialog('')}
        onConfirm={async (r) => { await http.post(`/transport/trips/${id}/cancel`, { reason: r, row_version: t.row_version }); toast('Trip cancelled — its requests are back in the queue'); refresh(); }} />
      <ReasonDialog open={dialog === 'exception'} title={`Close ${t.trip_no} with an exception`} label="Reason (pending stops are marked failed)" confirmLabel="Close trip" danger onClose={() => setDialog('')}
        onConfirm={async (r) => { await http.post(`/transport/trips/${id}/close-exception`, { reason: r }); toast('Trip closed — unserved requests are back in the queue'); refresh(); }} />
      <ReasonDialog open={!!resolve} title="Resolve issue" label="Resolution note" confirmLabel="Resolve" onClose={() => setResolve(null)}
        onConfirm={async (r) => { await http.post(`/transport/trips/${id}/issues/${resolve.id}/resolve`, { note: r }); toast('Issue resolved'); refresh(); }} />
      {dialog === 'reassign' && <ReassignDialog t={t} onClose={() => setDialog('')} onDone={() => { setDialog(''); toast('Reassigned — driver and requesters notified'); refresh(); }} />}
    </>
  );
}

function ReassignDialog({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: () => void }) {
  const started = ['STARTED', 'IN_PROGRESS'].includes(t.status);
  const avail = useQuery({ queryKey: ['transport', 'availability', 'reassign', t.id], queryFn: async () => (await http.get<{ data: { vehicles: any[]; drivers: any[] } }>('/transport/availability', { start: started ? new Date().toISOString() : t.planned_start_at, end: t.planned_end_at, trip_id: t.id })).data });
  const [v, setV] = useState({ driver_id: String(t.driver_id ?? ''), vehicle_id: String(t.vehicle_id ?? ''), reason: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  return (
    <Modal open onClose={onClose} title={`Reassign ${t.trip_no}`} subtitle={started ? 'The trip has started — the reason is mandatory' : 'The driver must accept again if changed'} size="sm"
      footer={<>
        <button className="btn-secondary" onClick={onClose}>Back</button>
        <button className="btn-primary" disabled={busy || (started && v.reason.trim().length < 3)} data-action="confirm-reassign" onClick={async () => {
          setBusy(true); setErr('');
          try { await http.post(`/transport/trips/${t.id}/reassign`, { driver_id: Number(v.driver_id), vehicle_id: Number(v.vehicle_id), reason: v.reason || null, row_version: t.row_version }); onDone(); }
          catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }}>{busy && <Spinner size={14} />} Reassign</button>
      </>}>
      <div className="space-y-3">
        <Select label="Driver" value={v.driver_id} onChange={(e) => setV({ ...v, driver_id: e.target.value })} data-field="reassign-driver"
          options={(avail.data?.drivers ?? []).map((d) => ({ value: d.id, label: `${d.driver_name}${d.conflicts.length ? ` — busy ${d.conflicts.map((c: any) => c.trip_no).join(', ')}` : ''}`, disabled: !d.assignable && String(d.id) !== String(t.driver_id) }))} />
        <Select label="Vehicle" value={v.vehicle_id} onChange={(e) => setV({ ...v, vehicle_id: e.target.value })} data-field="reassign-vehicle"
          options={(avail.data?.vehicles ?? []).map((x) => ({ value: x.id, label: `${x.registration_no} · ${humanize(x.ownership_type)}${x.conflicts.length ? ` — busy ${x.conflicts.map((c: any) => c.trip_no).join(', ')}` : ''}`, disabled: !x.assignable && String(x.id) !== String(t.vehicle_id) }))} />
        <Textarea label="Reason" required={started} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} error={err || undefined} />
      </div>
    </Modal>
  );
}
