/**
 * Driver mobile screen (spec §4.6): /driver/my-trips and /driver/trips/:id — stacked cards, large touch targets,
 * one primary action. Every action sends an idempotency key that is kept until the server confirms, so a retry after a
 * network error never records the event twice; success is shown only after the API answers.
 */
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Phone, AlertTriangle, Truck, ChevronRight, RefreshCw, Navigation, PackageCheck, Flag } from 'lucide-react';
import clsx from 'clsx';
import { LoadingBlock, ErrorState, Modal, Input, Select, Textarea, Spinner } from '../../components/ui';
import { PhotoCapture } from '../../components/PhotoCapture';
import { http } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { humanize } from '../../lib/format';
import { StatusPill, TRIP_TONE, STOP_TONE, PRIORITY_TONE, fmtIst, errMsg } from './transportShared';

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** POST with an idempotency key that survives retries of the same action until it succeeds. */
function useDriverAction() {
  const keys = useRef<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const run = async (action: string, path: string, body: object = {}) => {
    keys.current[action] ??= newKey();
    setBusy(action);
    try {
      const res = await http.post<{ data: any }>(path, { ...body, idempotency_key: keys.current[action] });
      delete keys.current[action];
      return res.data;
    } finally { setBusy(''); }
  };
  return { run, busy };
}

export function DriverMyTrips() {
  const [when, setWhen] = useState<'active' | 'today' | 'recent'>('active');
  const me = useQuery({ queryKey: ['driver', 'me'], queryFn: async () => (await http.get<{ data: any }>('/driver/me')).data, retry: false });
  const list = useQuery({ queryKey: ['driver', 'trips', when], enabled: !!me.data, queryFn: async () => (await http.get<{ data: any[] }>('/driver/trips', { when })).data, refetchInterval: 60_000 });
  if (me.isLoading) return <LoadingBlock />;
  if (me.error) return <div className="mx-auto max-w-lg"><ErrorState error={me.error} /></div>;
  return (
    <div className="mx-auto max-w-lg" data-driver-screen>
      <div className="mb-3 flex items-center justify-between">
        <div><h1 className="text-page font-semibold text-ink">My Trips</h1><p className="text-body text-ink-secondary">{me.data.driver_name} · {me.data.mobile_no}</p></div>
        <button className="btn-secondary" onClick={() => void list.refetch()} aria-label="Refresh"><RefreshCw size={16} className={clsx(list.isFetching && 'animate-spin')} /></button>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg border border-surface-border bg-white p-1">
        {(['active', 'today', 'recent'] as const).map((w) => (
          <button key={w} onClick={() => setWhen(w)} className={clsx('rounded-md py-2.5 text-body', when === w ? 'bg-brand-600 font-semibold text-white' : 'text-ink-secondary')}>
            {w === 'active' ? 'Active' : w === 'today' ? 'Today' : 'Recent'}
          </button>
        ))}
      </div>
      {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : (
        <div className="space-y-2">
          {!list.data?.length && <div className="card p-6 text-center text-body text-ink-secondary">No trips here.</div>}
          {list.data?.map((t) => (
            <Link key={t.id} to={`/driver/trips/${t.id}`} className="card flex items-center gap-3 p-3 active:bg-surface-hover" data-trip-card={t.trip_no}>
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700"><Truck size={20} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5"><b className="text-body">{t.trip_no}</b><StatusPill value={t.status} tones={TRIP_TONE} />{t.priority !== 'NORMAL' && <StatusPill value={t.priority} tones={PRIORITY_TONE} />}</div>
                <p className="text-body text-ink">Report {fmtIst(t.planned_start_at)}</p>
                <p className="truncate text-small text-ink-secondary">{t.vehicle_no} · {t.stops_done}/{t.stop_count} stops{t.next_stop ? ` · next: ${t.next_stop}` : ''}</p>
              </div>
              <ChevronRight size={18} className="text-ink-muted" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function DriverTripPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['driver', 'trip', id], queryFn: async () => (await http.get<{ data: any }>(`/driver/trips/${id}`)).data });
  const { run, busy } = useDriverAction();
  const [dlg, setDlg] = useState<'' | 'reject' | 'start' | 'complete' | 'issue'>('');
  const [serve, setServe] = useState<any>(null);
  const [err, setErr] = useState('');
  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <div className="mx-auto max-w-lg"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const t = q.data;
  const act = async (action: string, path: string, body: object, ok: string) => {
    setErr('');
    try { await run(action, path, body); toast(ok); void qc.invalidateQueries({ queryKey: ['driver'] }); return true; }
    catch (e) { setErr(`${errMsg(e)} — check the network and tap again`); return false; }
  };
  const running = ['STARTED', 'IN_PROGRESS'].includes(t.status);
  const current = t.stops.find((s: any) => ['EN_ROUTE', 'ARRIVED', 'PENDING'].includes(s.status));
  const allDone = t.stops.every((s: any) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(s.status) || !s.is_mandatory);
  const big = 'btn-primary w-full min-h-12 text-title';
  return (
    <div className="mx-auto max-w-lg pb-24" data-driver-trip={t.trip_no}>
      <Link to="/driver/my-trips" className="mb-2 inline-flex items-center text-body text-brand-700">‹ My trips</Link>
      <div className="card mb-3 p-3">
        <div className="flex flex-wrap items-center gap-2"><h1 className="text-page font-semibold text-ink">{t.trip_no}</h1><StatusPill value={t.status} tones={TRIP_TONE} /></div>
        <p className="text-body text-ink">{t.vehicle_no} · {humanize(t.vehicle_type)}</p>
        <p className="text-body text-ink-secondary">Report {fmtIst(t.planned_start_at)} · till {fmtIst(t.planned_end_at, false)}</p>
        {t.purpose && <p className="text-body">{t.purpose}</p>}
        {t.remarks && <p className="mt-1 rounded bg-amber-50 p-2 text-body text-ink">Note: {t.remarks}</p>}
      </div>

      {err && <div className="card mb-3 border-red-200 bg-red-50 p-3 text-body text-red-800" data-error>{err}</div>}

      {/* primary action */}
      <div className="mb-3 space-y-2">
        {t.status === 'ASSIGNED' && <>
          <button className={big} disabled={!!busy} onClick={() => void act('accept', `/driver/trips/${id}/accept`, {}, 'Trip accepted')} data-action="accept">{busy === 'accept' && <Spinner size={16} />} Accept trip</button>
          <button className="btn-secondary w-full min-h-12" onClick={() => setDlg('reject')} data-action="reject">Reject</button>
        </>}
        {t.status === 'DRIVER_ACCEPTED' && <button className={big} onClick={() => setDlg('start')} data-action="start"><Navigation size={18} /> Start trip</button>}
        {running && current && ['EN_ROUTE', 'PENDING'].includes(current.status) && (
          <button className={big} disabled={!!busy} onClick={() => void act(`arrive-${current.id}`, `/driver/stops/${current.id}/arrive`, {}, `Arrived at ${current.location_name}`)} data-action="arrive">
            {busy === `arrive-${current.id}` ? <Spinner size={16} /> : <MapPin size={18} />} Arrived at {current.location_name}
          </button>
        )}
        {running && current?.status === 'ARRIVED' && (
          <button className={big} onClick={() => setServe(current)} data-action="serve"><PackageCheck size={18} /> {current.lines.some((l: any) => l.service_type === 'DELIVERY') ? 'Delivered / drop completed' : 'Pickup completed'}</button>
        )}
        {running && allDone && <button className={big} onClick={() => setDlg('complete')} data-action="complete-trip"><Flag size={18} /> Complete trip</button>}
        {['ASSIGNED', 'DRIVER_ACCEPTED', 'STARTED', 'IN_PROGRESS'].includes(t.status) && (
          <button className="btn-secondary w-full min-h-12 text-amber-800" onClick={() => setDlg('issue')} data-action="report-issue"><AlertTriangle size={16} /> Report issue</button>
        )}
      </div>

      <h2 className="mb-1.5 text-title font-semibold text-ink">Stops</h2>
      <ol className="space-y-2">
        {t.stops.map((s: any) => (
          <li key={s.id} className={clsx('card p-3', current?.id === s.id && running && 'border-brand-500')} data-stop={s.stop_no}>
            <div className="flex flex-wrap items-center gap-2"><b className="text-title">{s.stop_no}. {s.location_name}</b><StatusPill value={s.status} tones={STOP_TONE} /></div>
            <p className="text-small text-ink-secondary">{humanize(s.stop_type)}{s.expected_arrival_at && ` · by ${fmtIst(s.expected_arrival_at, false)}`}</p>
            {s.address && <a className="text-body text-brand-700" href={`https://maps.google.com/?q=${encodeURIComponent(`${s.location_name} ${s.address}`)}`} target="_blank" rel="noreferrer">{s.address}</a>}
            {s.contact_mobile && <a className="mt-1 flex items-center gap-1.5 text-body text-brand-700" href={`tel:${s.contact_mobile}`}><Phone size={14} /> {s.contact_name} {s.contact_mobile}</a>}
            <ul className="mt-1.5 space-y-1 text-body">
              {s.lines.map((l: any) => (
                <li key={l.id} className="rounded bg-surface-muted px-2 py-1">
                  <b>{humanize(l.service_type)}</b> · {l.request_no} · {l.material_description ?? l.purpose}
                  {l.expected_qty != null && ` · ${Number(l.expected_qty)} ${l.package_uom ?? ''}`}
                  {l.result !== 'PENDING' && <span className="ml-1 font-semibold">→ {humanize(l.result)}{l.actual_qty != null && ` (${Number(l.actual_qty)})`}</span>}
                  {l.contact_mobile && <a className="ml-1 text-brand-700" href={`tel:${l.contact_mobile}`}>☎ {l.contact_name}</a>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>

      <ReasonModal open={dlg === 'reject'} title="Reject trip" label="Reason" onClose={() => setDlg('')} busy={busy === 'reject'}
        onOk={async (r) => { if (await act('reject', `/driver/trips/${id}/reject`, { reason: r }, 'Trip rejected — coordinator informed')) setDlg(''); }} />
      <OdoModal open={dlg === 'start'} title="Start trip" busy={busy === 'start'} onClose={() => setDlg('')}
        onOk={async (o) => { if (await act('start', `/driver/trips/${id}/start`, { odometer: o }, 'Trip started')) setDlg(''); }} />
      <OdoModal open={dlg === 'complete'} title="Complete trip" busy={busy === 'complete'} onClose={() => setDlg('')}
        onOk={async (o) => { if (await act('complete', `/driver/trips/${id}/complete`, { odometer: o }, 'Trip completed')) setDlg(''); }} />
      {dlg === 'issue' && <IssueModal stops={t.stops} busy={busy === 'issue'} onClose={() => setDlg('')}
        onOk={async (b) => { if (await act('issue', `/driver/trips/${id}/issues`, b, 'Issue reported to the coordinator')) setDlg(''); }} />}
      {serve && <ServeModal stop={serve} busy={busy === `serve-${serve.id}`} onClose={() => setServe(null)}
        onOk={async (b) => { if (await act(`serve-${serve.id}`, `/driver/stops/${serve.id}/complete`, b, `${serve.location_name} done`)) setServe(null); }} />}
    </div>
  );
}

function ReasonModal({ open, title, label, busy, onClose, onOk }: { open: boolean; title: string; label: string; busy: boolean; onClose: () => void; onOk: (r: string) => void }) {
  const [r, setR] = useState('');
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Back</button><button className="btn-danger" disabled={busy || r.trim().length < 3} onClick={() => onOk(r.trim())} data-action="confirm">{busy && <Spinner size={14} />} {title}</button></>}>
      <Textarea label={label} required value={r} onChange={(e) => setR(e.target.value)} data-field="reason" />
    </Modal>
  );
}
function OdoModal({ open, title, busy, onClose, onOk }: { open: boolean; title: string; busy: boolean; onClose: () => void; onOk: (o: number | null) => void }) {
  const [o, setO] = useState('');
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Back</button><button className="btn-primary" disabled={busy} onClick={() => onOk(o === '' ? null : Number(o))} data-action="confirm">{busy && <Spinner size={14} />} {title}</button></>}>
      <Input label="Odometer (km, optional)" type="number" inputMode="decimal" min={0} value={o} onChange={(e) => setO(e.target.value)} data-field="odometer" />
    </Modal>
  );
}
const ISSUES = ['DELAY', 'RECIPIENT_UNAVAILABLE', 'ITEM_NOT_READY', 'WRONG_ADDRESS', 'BREAKDOWN', 'ACCIDENT', 'OTHER'];
function IssueModal({ stops, busy, onClose, onOk }: { stops: any[]; busy: boolean; onClose: () => void; onOk: (b: object) => void }) {
  const [b, setB] = useState({ issue_type: 'DELAY', description: '', stop_id: '' });
  return (
    <Modal open onClose={onClose} title="Report issue" size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Back</button><button className="btn-primary" disabled={busy || b.description.trim().length < 3} onClick={() => onOk({ ...b, stop_id: b.stop_id || null })} data-action="confirm">{busy && <Spinner size={14} />} Send</button></>}>
      <div className="space-y-3">
        <Select label="Issue" value={b.issue_type} onChange={(e) => setB({ ...b, issue_type: e.target.value })} options={ISSUES.map((i) => ({ value: i, label: humanize(i) }))} data-field="issue_type" />
        <Select label="Stop (optional)" placeholder="—" value={b.stop_id} onChange={(e) => setB({ ...b, stop_id: e.target.value })} options={stops.map((s) => ({ value: s.id, label: `${s.stop_no}. ${s.location_name}` }))} />
        <Textarea label="What happened" required value={b.description} onChange={(e) => setB({ ...b, description: e.target.value })} data-field="description" />
      </div>
    </Modal>
  );
}
/** Pickup / delivery result for each request at the stop: quantity, done / failed, receiver, proof photo. */
function ServeModal({ stop, busy, onClose, onOk }: { stop: any; busy: boolean; onClose: () => void; onOk: (b: object) => void }) {
  const pending = stop.lines.filter((l: any) => l.result === 'PENDING');
  const [lines, setLines] = useState(pending.map((l: any) => ({ request_id: Number(l.request_id), service_type: l.service_type, actual_qty: l.expected_qty != null ? String(Number(l.expected_qty)) : '', result: 'DONE', note: '' })));
  const [receiver, setReceiver] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const delivery = pending.some((l: any) => l.service_type === 'DELIVERY');
  const needsPhoto = pending.some((l: any) => l.service_type === 'DELIVERY' && Number(l.requires_proof));
  const upd = (i: number, p: object) => setLines((x: any[]) => x.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const anyFailNoNote = lines.some((l: any) => l.result === 'FAILED' && !l.note.trim() && !note.trim());
  const blocked = (delivery && lines.some((l: any) => l.service_type === 'DELIVERY' && l.result !== 'FAILED') && !receiver.trim()) || (needsPhoto && lines.some((l: any) => l.result !== 'FAILED') && !photo) || anyFailNoNote;
  return (
    <Modal open onClose={onClose} title={`${stop.stop_no}. ${stop.location_name}`} subtitle={delivery ? 'Delivery / drop' : 'Pickup'} size="md"
      footer={<><button className="btn-secondary" onClick={onClose}>Back</button>
        <button className="btn-primary min-h-11" disabled={busy || blocked} data-action="confirm-serve"
          onClick={() => onOk({ lines: lines.map((l: any) => ({ ...l, actual_qty: l.actual_qty === '' ? null : Number(l.actual_qty), receiver_name: receiver || null, note: l.note || null })), receiver_name: receiver || null, photo_url: photo, note: note || null })}>
          {busy && <Spinner size={14} />} Confirm</button></>}>
      <div className="space-y-3">
        {lines.map((l: any, i: number) => {
          const src = pending[i];
          return (
            <div key={`${l.request_id}-${l.service_type}`} className="rounded-md border border-surface-border p-2">
              <p className="text-body font-semibold">{humanize(l.service_type)} · {src.request_no}</p>
              <p className="text-small text-ink-secondary">{src.material_description ?? src.purpose}</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Input label={`Qty${src.expected_qty != null ? ` (of ${Number(src.expected_qty)})` : ''}`} type="number" inputMode="decimal" min={0} value={l.actual_qty} onChange={(e) => upd(i, { actual_qty: e.target.value })} data-field={`qty-${l.request_id}`} />
                <Select label="Result" value={l.result} onChange={(e) => upd(i, { result: e.target.value })} options={[{ value: 'DONE', label: 'Done' }, { value: 'FAILED', label: 'Could not do' }]} data-field={`result-${l.request_id}`} />
              </div>
              {l.result === 'FAILED' && <Input className="mt-2" label="Why?" required value={l.note} onChange={(e) => upd(i, { note: e.target.value })} />}
              {src.expected_qty != null && l.actual_qty !== '' && Number(l.actual_qty) < Number(src.expected_qty) && l.result === 'DONE' && <p className="mt-1 text-small text-amber-700">Short quantity — recorded as partial and the coordinator is alerted.</p>}
            </div>
          );
        })}
        {delivery && <Input label="Receiver name" required value={receiver} onChange={(e) => setReceiver(e.target.value)} data-field="receiver_name" />}
        <PhotoCapture label={needsPhoto ? 'Proof photo' : 'Photo (optional)'} required={needsPhoto} value={photo} onChange={setPhoto} facing="environment" filePrefix="proof" />
        <Textarea label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}
