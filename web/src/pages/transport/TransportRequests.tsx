/**
 * Vehicle requests (gate security · transport, client voice notes 04-Nov-2026; spec §4.1 / §4.2).
 *   /transport/requests            my requests, or the coordinator queue with counters (TRANSPORT.VIEW)
 *   /transport/requests/new        new vehicle request (Save draft / Submit)
 *   /transport/requests/:id/edit   edit a draft / answer a clarification
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Truck, Send, Save } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, FormSection, Input, Select, Textarea, SearchInput, Spinner, LoadingBlock, ErrorState, useDebounced } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { StatusPill, REQUEST_TONE, PRIORITY_TONE, fmtIst, toLocalInput, nowLocalInput, localToIso, useRequestTypes, errMsg } from './transportShared';

const QUEUE_TABS = [
  { key: 'NEW', label: 'New' }, { key: 'UNDER_REVIEW', label: 'Under review' }, { key: 'APPROVED_UNASSIGNED', label: 'Approved – unassigned' },
  { key: 'ASSIGNED', label: 'Assigned' }, { key: 'IN_PROGRESS', label: 'In progress' }, { key: 'DELAYED', label: 'Delayed' },
  { key: 'COMPLETED_TODAY', label: 'Completed today' }, { key: 'REJECTED', label: 'Rejected' }, { key: 'ALL', label: 'All' },
];
const STATUS_OPTIONS = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED', 'APPROVED', 'REJECTED', 'ASSIGNED', 'IN_PROGRESS', 'PICKUP_COMPLETED', 'DELIVERED', 'COMPLETED', 'CANCELLED']
  .map((s) => ({ value: s, label: s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }));

export function TransportRequestsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const coord = can('TRANSPORT.VIEW');
  const [sp, setSp] = useSearchParams();
  const [scope, setScope] = useState<'all' | 'mine'>(coord && sp.get('scope') !== 'mine' ? 'all' : 'mine');
  const queue = sp.get('queue') ?? (coord && scope === 'all' ? 'NEW' : 'ALL');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [f, setF] = useState({ status: '', request_type_id: '', department_id: '', priority: '', from: '', to: '', location: '' });
  const types = useRequestTypes();
  const depts = useLookup('departments');
  const params = { scope, queue: queue === 'ALL' ? undefined : queue, q: q || undefined, pageSize: 200, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) };
  const list = useQuery({
    queryKey: ['transport', 'requests', params],
    queryFn: () => http.get<{ data: any[]; counters: Record<string, number>; scope: string }>('/transport/requests', params),
  });
  const counters = list.data?.counters ?? {};
  const cols: Column<any>[] = [
    { key: 'request_no', header: 'Request', render: (r) => (
      <div><p className="font-semibold text-brand-700">{r.request_no}</p><p className="text-caption text-ink-secondary">{r.type_name}</p></div>) },
    { key: 'required_at', header: 'Needed at', render: (r) => <span className="tabular-nums">{fmtIst(r.required_at)}</span> },
    { key: 'purpose', header: 'Purpose / route', render: (r) => (
      <div className="max-w-[340px]"><p className="truncate">{r.purpose}</p>
        <p className="truncate text-caption text-ink-secondary">{[r.pickup_location, r.destination_location].filter(Boolean).join(' → ') || '—'}</p></div>) },
    ...(scope === 'all' ? [{ key: 'requested_by_name', header: 'Requester', render: (r: any) => <div><p>{r.requested_by_name}</p><p className="text-caption text-ink-secondary">{r.department_name ?? ''}</p></div> }] : []),
    { key: 'priority', header: 'Priority', render: (r) => <StatusPill value={r.priority} tones={PRIORITY_TONE} /> },
    { key: 'status', header: 'Status', render: (r) => (
      <div><StatusPill value={r.status} tones={REQUEST_TONE} />
        {r.trip_no && <p className="mt-0.5 text-caption text-ink-secondary">{r.trip_no} · {r.vehicle_no ?? ''}</p>}</div>) },
  ];
  const setQueue = (k: string) => { const n = new URLSearchParams(sp); n.set('queue', k); setSp(n, { replace: true }); };
  return (
    <>
      <PageHeader title={coord && scope === 'all' ? 'Vehicle Requests – Coordinator Queue' : 'My Vehicle Requests'}
        subtitle="Pickup, drop, courier and material movement with our own / rental vehicles — raise a request, the vehicle manager approves and allocates"
        actions={<>
          {coord && (
            <div className="inline-flex rounded-md border border-surface-border bg-white p-0.5" role="tablist">
              {(['all', 'mine'] as const).map((s) => (
                <button key={s} className={clsx('rounded px-3 py-1.5 text-body', scope === s ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-secondary')}
                  onClick={() => { setScope(s); const n = new URLSearchParams(sp); n.set('scope', s); n.set('queue', s === 'all' ? 'NEW' : 'ALL'); setSp(n, { replace: true }); }}>
                  {s === 'all' ? 'All requests' : 'My requests'}
                </button>
              ))}
            </div>
          )}
          {can('TRANSPORT.REQUEST') && <button className="btn-primary" data-action="new-request" onClick={() => nav('/transport/requests/new')}><Plus size={15} /> New Vehicle Request</button>}
        </>} />
      {scope === 'all' && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-9" data-counters>
          {QUEUE_TABS.map((t) => (
            <button key={t.key} onClick={() => setQueue(t.key)} data-queue={t.key}
              className={clsx('card px-3 py-2 text-left transition-colors', queue === t.key ? 'border-brand-500 bg-brand-50' : 'hover:bg-surface-hover')}>
              <p className="text-caption text-ink-secondary">{t.label}</p>
              <p className={clsx('text-title font-semibold tabular-nums', t.key === 'DELAYED' && counters.DELAYED ? 'text-red-600' : 'text-ink')}>
                {t.key === 'ALL' ? '·' : counters[t.key] ?? 0}
              </p>
            </button>
          ))}
        </div>
      )}
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <SearchInput value={search} onChange={setSearch} placeholder="Request no, purpose, requester…" className="col-span-2" />
        <Select placeholder="Any status" options={STATUS_OPTIONS} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status" />
        <Select placeholder="Any type" options={(types.data ?? []).map((t) => ({ value: t.id, label: t.type_name }))} value={f.request_type_id} onChange={(e) => setF({ ...f, request_type_id: e.target.value })} aria-label="Type" />
        {scope === 'all' && <Select placeholder="Any department" options={toOptions(depts.data)} value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })} aria-label="Department" />}
        <Select placeholder="Any priority" options={['NORMAL', 'URGENT', 'CRITICAL'].map((p) => ({ value: p, label: p[0] + p.slice(1).toLowerCase() }))} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} aria-label="Priority" />
        <input className="input" type="date" aria-label="Needed from" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" aria-label="Needed to" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        {scope === 'all' && <input className="input" placeholder="Location" aria-label="Location" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />}
      </div>
      <DataTable columns={cols} rows={list.data?.data ?? []} loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id} onRowClick={(r) => nav(`/transport/requests/${r.id}`)}
        emptyTitle="No vehicle requests" emptyMessage={scope === 'all' ? 'Nothing in this queue.' : 'Raise a request when you need a pickup, drop or courier collection.'} />
    </>
  );
}

/* ====================================================================== form */
interface Loc { id: number; name: string; address: string | null; phone?: string | null }
const EMPTY = {
  request_type_id: '', department_id: '', purpose: '', priority: 'NORMAL', priority_reason: '', required_at: '',
  pickup_ref: '', pickup_location: '', pickup_address: '', destination_ref: '', destination_location: '', destination_address: '',
  contact_name: '', contact_mobile: '', material_description: '', package_qty: '', package_uom: '', passenger_count: '', remarks: '', clarification_response: '',
};

export function TransportRequestForm() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const types = useRequestTypes();
  const depts = useLookup('departments');
  const locs = useQuery({ queryKey: ['transport', 'locations'], queryFn: async () => (await http.get<{ data: { units: Loc[]; parties: Loc[] } }>('/transport/locations')).data, staleTime: 300_000 });
  const existing = useQuery({ queryKey: ['transport', 'request', id], enabled: editing, queryFn: async () => (await http.get<{ data: any }>(`/transport/requests/${id}`)).data });
  const last = useQuery({ queryKey: ['transport', 'my-last'], enabled: !editing, queryFn: async () => (await http.get<{ data: any[] }>('/transport/requests', { scope: 'mine', pageSize: 1 })).data?.[0] ?? null });
  const [v, setV] = useState<Record<string, string>>({ ...EMPTY, required_at: nowLocalInput(60), contact_name: user?.fullName ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'draft' | 'submit'>('');

  useEffect(() => {
    const r = existing.data; if (!r) return;
    const s = (x: unknown) => (x == null ? '' : String(x));
    setV({
      request_type_id: s(r.request_type_id), department_id: s(r.department_id), purpose: s(r.purpose), priority: r.priority, priority_reason: s(r.priority_reason),
      required_at: toLocalInput(r.required_at),
      pickup_ref: r.pickup_unit_id ? `U:${r.pickup_unit_id}` : r.pickup_party_id ? `P:${r.pickup_party_id}` : '', pickup_location: s(r.pickup_location), pickup_address: s(r.pickup_address),
      destination_ref: r.destination_unit_id ? `U:${r.destination_unit_id}` : r.destination_party_id ? `P:${r.destination_party_id}` : '', destination_location: s(r.destination_location), destination_address: s(r.destination_address),
      contact_name: s(r.contact_name), contact_mobile: s(r.contact_mobile), material_description: s(r.material_description), package_qty: s(r.package_qty), package_uom: s(r.package_uom),
      passenger_count: s(r.passenger_count), remarks: s(r.remarks), clarification_response: s(r.clarification_response),
    });
  }, [existing.data]);
  // the login may load after the form opened (direct link / reload): default the contact to the requester then
  useEffect(() => { if (!editing && user?.fullName) setV((p) => (p.contact_name ? p : { ...p, contact_name: user.fullName })); }, [user?.fullName, editing]);
  useEffect(() => { if (last.data?.department_id && !v.department_id) setV((p) => ({ ...p, department_id: String(last.data.department_id) })); }, [last.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const type = useMemo(() => (types.data ?? []).find((t) => String(t.id) === v.request_type_id), [types.data, v.request_type_id]);
  const set = (k: string, val: string) => { setV((p) => ({ ...p, [k]: val })); if (errors[k]) setErrors((e) => { const n = { ...e }; delete n[k]; return n; }); };
  const pickLoc = (side: 'pickup' | 'destination', ref: string) => {
    const [kind, rid] = ref.split(':');
    const list = kind === 'U' ? locs.data?.units : kind === 'P' ? locs.data?.parties : undefined;
    const l = list?.find((x) => String(x.id) === rid);
    setV((p) => ({ ...p, [`${side}_ref`]: ref, ...(l ? { [`${side}_location`]: l.name, [`${side}_address`]: l.address ?? '' } : {}) }));
  };
  const locOptions = (
    <>
      <optgroup label="Our units">{(locs.data?.units ?? []).map((u) => <option key={`U${u.id}`} value={`U:${u.id}`}>{u.name}</option>)}</optgroup>
      <optgroup label="Business partners">{(locs.data?.parties ?? []).map((p) => <option key={`P${p.id}`} value={`P:${p.id}`}>{p.name}</option>)}</optgroup>
    </>
  );

  const save = async (submit: boolean) => {
    const errs: Record<string, string> = {};
    if (!v.request_type_id) errs.request_type_id = 'Select the request type';
    if (v.purpose.trim().length < 3) errs.purpose = 'Purpose is required';
    if (!v.required_at) errs.required_at = 'Required date & time';
    if (v.contact_name.trim().length < 2) errs.contact_name = 'Contact name is required';
    if (!/^[+]?[\d\s-]{7,20}$/.test(v.contact_mobile.trim())) errs.contact_mobile = 'Enter a reachable mobile number';
    if (submit && type) {
      if (type.requires_pickup && !v.pickup_location.trim()) errs.pickup_location = `Pickup is required for ${type.type_name}`;
      if (type.requires_destination && !v.destination_location.trim()) errs.destination_location = `Destination is required for ${type.type_name}`;
      if (type.requires_material && !v.material_description.trim()) errs.material_description = `Material / parcel description is required for ${type.type_name}`;
      if (v.priority !== 'NORMAL' && !v.priority_reason.trim()) errs.priority_reason = 'Give the reason for the priority';
      if (existing.data?.status === 'CLARIFICATION_REQUIRED' && !v.clarification_response.trim()) errs.clarification_response = 'Answer the coordinator\'s question';
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const [pk, pid] = v.pickup_ref.split(':'); const [dk, did] = v.destination_ref.split(':');
    const body = {
      request_type_id: Number(v.request_type_id), department_id: v.department_id || null, purpose: v.purpose, priority: v.priority, priority_reason: v.priority_reason,
      required_at: localToIso(v.required_at),
      pickup_unit_id: pk === 'U' ? Number(pid) : null, pickup_party_id: pk === 'P' ? Number(pid) : null, pickup_location: v.pickup_location, pickup_address: v.pickup_address,
      destination_unit_id: dk === 'U' ? Number(did) : null, destination_party_id: dk === 'P' ? Number(did) : null, destination_location: v.destination_location, destination_address: v.destination_address,
      contact_name: v.contact_name, contact_mobile: v.contact_mobile, material_description: v.material_description, package_qty: v.package_qty, package_uom: v.package_uom,
      passenger_count: v.passenger_count, remarks: v.remarks, clarification_response: v.clarification_response || null, submit, row_version: existing.data?.row_version,
    };
    setBusy(submit ? 'submit' : 'draft');
    try {
      const res = editing ? await http.put<{ data: any }>(`/transport/requests/${id}`, body) : await http.post<{ data: any; message?: string }>('/transport/requests', body);
      void qc.invalidateQueries({ queryKey: ['transport'] });
      toast((res as any).message ?? `Request ${res.data.request_no} ${submit ? 'submitted — next: coordinator review' : 'saved as draft'}`);
      nav(`/transport/requests/${res.data.id}`);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
      toast(errMsg(e), 'error');
    } finally { setBusy(''); }
  };

  if (editing && existing.isLoading) return <LoadingBlock />;
  if (editing && existing.error) return <ErrorState error={existing.error} />;
  const clar = existing.data?.status === 'CLARIFICATION_REQUIRED';
  return (
    <>
      <PageHeader title={editing ? `Edit ${existing.data?.request_no}` : 'New Vehicle Request'} breadcrumb={['Gate Security', 'Vehicle Requests']}
        subtitle="Fields marked * are needed; the request type decides whether pickup, destination and material are mandatory"
        actions={<Link to={editing ? `/transport/requests/${id}` : '/transport/requests'} className="btn-secondary">Cancel</Link>} />
      {clar && (
        <div className="card mb-3 border-amber-300 bg-amber-50 p-3">
          <p className="text-body font-semibold text-ink">Coordinator asks: {existing.data.clarification_question}</p>
          <Textarea label="Your answer" required className="mt-2" value={v.clarification_response} error={errors.clarification_response} onChange={(e) => set('clarification_response', e.target.value)} data-field="clarification_response" />
        </div>
      )}
      <div className="card space-y-5 p-4" data-form="transport-request">
        <FormSection title="General" cols={4}>
          <Select label="Request type" required options={(types.data ?? []).map((t) => ({ value: t.id, label: t.type_name }))} placeholder="— Select —"
            value={v.request_type_id} error={errors.request_type_id} onChange={(e) => set('request_type_id', e.target.value)} data-field="request_type_id" />
          <Input label="Purpose" required className="sm:col-span-2" value={v.purpose} error={errors.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="e.g. Collect export sample parcel from courier" data-field="purpose" />
          <Select label="Department" options={toOptions(depts.data)} placeholder="— Select —" value={v.department_id} onChange={(e) => set('department_id', e.target.value)} data-field="department_id" />
          <Input label="Requested by" value={user?.fullName ?? ''} readOnly disabled hint="Your login" />
          <Select label="Priority" options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'URGENT', label: 'Urgent' }, { value: 'CRITICAL', label: 'Critical' }]} value={v.priority} onChange={(e) => set('priority', e.target.value)} data-field="priority" />
          {v.priority !== 'NORMAL' && <Input label="Reason for priority" required className="sm:col-span-2" value={v.priority_reason} error={errors.priority_reason} onChange={(e) => set('priority_reason', e.target.value)} data-field="priority_reason" />}
        </FormSection>
        <FormSection title="Route & schedule" cols={4}>
          <Input label="Required date & time" required type="datetime-local" value={v.required_at} error={errors.required_at} onChange={(e) => set('required_at', e.target.value)} hint="India time" data-field="required_at" />
          <div className="hidden sm:block sm:col-span-3" />
          <Select label="Pickup from (pick a place)" value={v.pickup_ref} onChange={(e) => pickLoc('pickup', e.target.value)} data-field="pickup_ref"><option value="">— Other / type below —</option>{locOptions}</Select>
          <Input label="Pickup location" required={!!type?.requires_pickup} value={v.pickup_location} error={errors.pickup_location} onChange={(e) => set('pickup_location', e.target.value)} data-field="pickup_location" />
          <Input label="Pickup address" className="sm:col-span-2" value={v.pickup_address} onChange={(e) => set('pickup_address', e.target.value)} data-field="pickup_address" />
          <Select label="Destination (pick a place)" value={v.destination_ref} onChange={(e) => pickLoc('destination', e.target.value)} data-field="destination_ref"><option value="">— Other / type below —</option>{locOptions}</Select>
          <Input label="Destination" required={!!type?.requires_destination} value={v.destination_location} error={errors.destination_location} onChange={(e) => set('destination_location', e.target.value)} data-field="destination_location" />
          <Input label="Destination address" className="sm:col-span-2" value={v.destination_address} onChange={(e) => set('destination_address', e.target.value)} data-field="destination_address" />
        </FormSection>
        <FormSection title="Material / parcel" cols={4}>
          <Input label="Material / parcel description" required={!!type?.requires_material} className="sm:col-span-2" value={v.material_description} error={errors.material_description} onChange={(e) => set('material_description', e.target.value)} data-field="material_description" />
          <Input label="Package qty" type="number" min={0} step="any" value={v.package_qty} onChange={(e) => set('package_qty', e.target.value)} data-field="package_qty" />
          <Input label="UOM" placeholder="BOX / ROLL / BAG" value={v.package_uom} onChange={(e) => set('package_uom', e.target.value)} data-field="package_uom" />
          <Input label="Passengers (if any)" type="number" min={0} value={v.passenger_count} onChange={(e) => set('passenger_count', e.target.value)} />
        </FormSection>
        <FormSection title="Contact & remarks" cols={4}>
          <Input label="Contact name" required value={v.contact_name} error={errors.contact_name} onChange={(e) => set('contact_name', e.target.value)} data-field="contact_name" />
          <Input label="Contact mobile" required inputMode="tel" value={v.contact_mobile} error={errors.contact_mobile} onChange={(e) => set('contact_mobile', e.target.value)} data-field="contact_mobile" />
          <Textarea label="Remarks" className="sm:col-span-2" value={v.remarks} onChange={(e) => set('remarks', e.target.value)} />
        </FormSection>
        <p className="text-small text-ink-secondary">Attachments (courier slip, DC copy …) can be added on the request after saving.</p>
        <div className="flex flex-wrap justify-end gap-2 border-t border-surface-border pt-3">
          {(!editing || existing.data?.status === 'DRAFT') && (
            <button className="btn-secondary" disabled={!!busy} onClick={() => void save(false)} data-action="save-draft">{busy === 'draft' ? <Spinner size={14} /> : <Save size={15} />} Save draft</button>
          )}
          <button className="btn-primary" disabled={!!busy} onClick={() => void save(true)} data-action="submit-request">{busy === 'submit' ? <Spinner size={14} /> : <Send size={15} />} {clar ? 'Answer & resubmit' : 'Submit request'}</button>
        </div>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-small text-ink-secondary"><Truck size={14} /> After you submit, the transport coordinator reviews it and allocates a vehicle and driver; you get a message at each step.</p>
    </>
  );
}
