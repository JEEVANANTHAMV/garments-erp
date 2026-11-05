/**
 * Transport masters (spec §4.3 / §4.4 / §2.1): vehicles (owned + rental), staff drivers, request types.
 * No delete — a vehicle / driver is deactivated (inactive ones cannot be assigned).
 *   /transport/vehicles  ·  /transport/drivers  ·  /transport/request-types
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, AlertTriangle } from 'lucide-react';
import { PageHeader, Modal, Input, Select, Textarea, Checkbox, Spinner, SearchInput, Badge, useDebounced } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { fmtDate, humanize } from '../../lib/format';
import { errMsg, useTransportSettings } from './transportShared';

const LIVE_TONE: Record<string, string> = { AVAILABLE: 'green', ASSIGNED: 'violet', IN_TRIP: 'blue', ON_TRIP: 'blue', MAINTENANCE: 'amber', ON_LEAVE: 'amber', INACTIVE: 'red' };
const VEHICLE_TYPES = ['CAR', 'VAN', 'PICKUP', 'MINI_TRUCK', 'TRUCK', 'TWO_WHEELER', 'BUS', 'OTHER'].map((v) => ({ value: v, label: humanize(v) }));

/** Generic save-in-a-popup for the master screens. */
function useMasterSave(path: string, onDone: () => void) {
  const qc = useQueryClient(); const toast = useToast();
  const [busy, setBusy] = useState(false); const [errors, setErrors] = useState<Record<string, string>>({}); const [err, setErr] = useState('');
  const save = async (id: number | null, body: object) => {
    setBusy(true); setErrors({}); setErr('');
    try {
      if (id) await http.put(`${path}/${id}`, body); else await http.post(path, body);
      void qc.invalidateQueries({ queryKey: ['transport'] });
      toast('Saved'); onDone();
    } catch (e) { if (e instanceof ApiError) setErrors(e.fieldErrors); setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return { busy, errors, err, save };
}

/* ====================================================================== vehicles */
export function TransportVehiclesPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState(''); const q = useDebounced(search);
  const [own, setOwn] = useState('');
  const list = useQuery({ queryKey: ['transport', 'vehicles', q, own], queryFn: async () => (await http.get<{ data: any[] }>('/transport/vehicles', { q: q || undefined, ownership_type: own || undefined })).data });
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  const cols: Column<any>[] = [
    { key: 'vehicle_code', header: 'Vehicle', render: (v) => <div><p className="font-semibold">{v.registration_no}</p><p className="text-caption text-ink-secondary">{v.vehicle_code !== v.registration_no ? v.vehicle_code : ''} {[v.make, v.model].filter(Boolean).join(' ')}</p></div> },
    { key: 'vehicle_type', header: 'Type', render: (v) => humanize(v.vehicle_type) },
    { key: 'ownership_type', header: 'Ownership', render: (v) => <div><Badge tone={v.ownership_type === 'RENTAL' ? 'indigo' : 'slate'}>{humanize(v.ownership_type)}</Badge>{v.rental_provider_name && <p className="text-caption text-ink-secondary">{v.rental_provider_name}{v.rental_rate ? ` · ₹${Number(v.rental_rate)}/${(v.rental_rate_basis ?? '').toLowerCase()}` : ''}</p>}</div> },
    { key: 'capacity', header: 'Capacity', render: (v) => v.capacity != null ? `${Number(v.capacity)} ${v.capacity_uom ?? ''}` : '—' },
    { key: 'expiry', header: 'Insurance / permit / fitness', render: (v) => <div className="text-small">{[v.insurance_expiry, v.permit_expiry, v.fitness_expiry].map((d) => (d ? fmtDate(d) : '—')).join(' · ')}{v.warnings?.length > 0 && <p className="flex items-center gap-1 text-red-600"><AlertTriangle size={12} />{v.warnings.join(', ')}</p>}</div> },
    { key: 'live_status', header: 'Availability', render: (v) => <div><Badge tone={LIVE_TONE[v.live_status] ?? 'slate'}>{humanize(v.live_status)}</Badge>{v.running_trip_no && <p className="text-caption text-ink-secondary">{v.running_trip_no}</p>}</div> },
  ];
  return (
    <>
      <PageHeader title="Vehicle Master" subtitle="Company-owned and rental vehicles in one list; inactive or under-maintenance vehicles cannot be allocated"
        actions={can('TRANSPORT.MASTER') && <button className="btn-primary" onClick={() => setEdit(null)} data-action="new-vehicle"><Plus size={15} /> New Vehicle</button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Registration, make, provider…" className="w-full max-w-sm" />
        <Select placeholder="Owned + rental" value={own} onChange={(e) => setOwn(e.target.value)} options={[{ value: 'OWNED', label: 'Owned' }, { value: 'RENTAL', label: 'Rental' }]} aria-label="Ownership" />
      </div>
      <DataTable columns={cols} rows={list.data ?? []} loading={list.isLoading} error={list.error} rowKey={(v) => v.id} onRowClick={can('TRANSPORT.MASTER') ? (v) => setEdit(v) : undefined}
        emptyTitle="No vehicles" emptyMessage="Add the company vehicles and any rental vehicles you use." />
      {edit !== undefined && <VehicleForm v={edit} onClose={() => setEdit(undefined)} />}
    </>
  );
}

function VehicleForm({ v, onClose }: { v: any | null; onClose: () => void }) {
  const s = (x: unknown) => (x == null ? '' : String(x).slice(0, 10));
  const [f, setF] = useState<Record<string, any>>({
    vehicle_code: v?.vehicle_code ?? '', registration_no: v?.registration_no ?? '', ownership_type: v?.ownership_type ?? 'OWNED', vehicle_type: v?.vehicle_type ?? 'CAR',
    make: v?.make ?? '', model: v?.model ?? '', capacity: v?.capacity ?? '', capacity_uom: v?.capacity_uom ?? '', seating: v?.seating ?? '',
    rental_party_id: v?.rental_party_id ?? '', rental_provider_name: v?.rental_provider_name ?? '', rental_provider_contact: v?.rental_provider_contact ?? '', rental_rate: v?.rental_rate ?? '', rental_rate_basis: v?.rental_rate_basis ?? '',
    availability_status: v?.availability_status ?? 'AVAILABLE', insurance_expiry: s(v?.insurance_expiry), permit_expiry: s(v?.permit_expiry), fitness_expiry: s(v?.fitness_expiry), pollution_expiry: s(v?.pollution_expiry),
    remarks: v?.remarks ?? '', is_active: v ? Number(v.is_active) : 1,
  });
  const transporters = useLookup('transporters', f.ownership_type === 'RENTAL');
  const m = useMasterSave('/transport/vehicles', onClose);
  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const rental = f.ownership_type === 'RENTAL';
  return (
    <Modal open onClose={onClose} title={v ? `Edit ${v.registration_no}` : 'New Vehicle'} size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={m.busy} onClick={() => void m.save(v?.id ?? null, { ...f, row_version: v?.row_version })} data-action="save-vehicle">{m.busy && <Spinner size={14} />} Save</button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Input label="Registration no" required value={f.registration_no} onChange={set('registration_no')} error={m.errors.registration_no} placeholder="TN 39 AB 1234" hint="Saved upper case without spaces" data-field="registration_no" />
        <Input label="Vehicle code" value={f.vehicle_code} onChange={set('vehicle_code')} hint="Blank = registration no" />
        <Select label="Ownership" required value={f.ownership_type} onChange={set('ownership_type')} options={[{ value: 'OWNED', label: 'Owned' }, { value: 'RENTAL', label: 'Rental' }]} data-field="ownership_type" />
        <Select label="Vehicle type" required value={f.vehicle_type} onChange={set('vehicle_type')} options={VEHICLE_TYPES} data-field="vehicle_type" />
        <Input label="Make" value={f.make} onChange={set('make')} />
        <Input label="Model" value={f.model} onChange={set('model')} />
        <Input label="Capacity" type="number" min={0} value={f.capacity} onChange={set('capacity')} error={m.errors.capacity} />
        <Input label="Capacity UOM" value={f.capacity_uom} onChange={set('capacity_uom')} placeholder="KG / CBM" />
        <Input label="Seats" type="number" min={0} value={f.seating} onChange={set('seating')} />
        {rental && <>
          <Select label="Rental provider (transporter)" value={f.rental_party_id} onChange={set('rental_party_id')} options={toOptions(transporters.data)} placeholder="— Not in the party list —" />
          <Input label="Provider name" required value={f.rental_provider_name} onChange={set('rental_provider_name')} error={m.errors.rental_provider_name} hint="Filled from the transporter when picked" data-field="rental_provider_name" />
          <Input label="Provider contact" value={f.rental_provider_contact} onChange={set('rental_provider_contact')} />
          <Input label="Rental rate (₹)" type="number" min={0} value={f.rental_rate} onChange={set('rental_rate')} />
          <Select label="Rate per" value={f.rental_rate_basis} onChange={set('rental_rate_basis')} placeholder="—" options={['TRIP', 'DAY', 'KM', 'MONTH'].map((x) => ({ value: x, label: humanize(x) }))} />
        </>}
        <Input label="Insurance expiry" type="date" value={f.insurance_expiry} onChange={set('insurance_expiry')} />
        <Input label="Permit expiry" type="date" value={f.permit_expiry} onChange={set('permit_expiry')} />
        <Input label="Fitness expiry" type="date" value={f.fitness_expiry} onChange={set('fitness_expiry')} />
        <Input label="Pollution (PUC) expiry" type="date" value={f.pollution_expiry} onChange={set('pollution_expiry')} />
        <Select label="Availability" value={f.availability_status} onChange={set('availability_status')} options={[{ value: 'AVAILABLE', label: 'Available' }, { value: 'MAINTENANCE', label: 'Under maintenance' }, { value: 'INACTIVE', label: 'Inactive' }]} />
        <div className="flex items-end pb-1.5"><Checkbox label="Active" checked={!!f.is_active} onChange={(x) => setF((p) => ({ ...p, is_active: x ? 1 : 0 }))} /></div>
        <Textarea label="Remarks" className="sm:col-span-3" value={f.remarks} onChange={set('remarks')} />
      </div>
      {m.err && <p className="help-error mt-2" data-error>{m.err}</p>}
    </Modal>
  );
}

/* ====================================================================== drivers */
export function TransportDriversPage() {
  const { can } = useAuth();
  const [search, setSearch] = useState(''); const q = useDebounced(search);
  const list = useQuery({ queryKey: ['transport', 'drivers', q], queryFn: async () => (await http.get<{ data: any[] }>('/transport/drivers', { q: q || undefined })).data });
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  const cols: Column<any>[] = [
    { key: 'driver_name', header: 'Driver', render: (d) => <div><p className="font-semibold">{d.driver_name}</p><p className="text-caption text-ink-secondary">{d.username}{d.employee_code ? ` · ${d.employee_code}` : ''}</p></div> },
    { key: 'mobile_no', header: 'Mobile', render: (d) => <a className="text-brand-700" href={`tel:${d.mobile_no}`} onClick={(e) => e.stopPropagation()}>{d.mobile_no}</a> },
    { key: 'licence_no', header: 'Licence', render: (d) => <div><p>{d.licence_no} {d.licence_class && <span className="text-ink-secondary">({d.licence_class})</span>}</p><p className={d.warnings?.length ? 'text-small text-red-600' : 'text-small text-ink-secondary'}>valid to {fmtDate(d.licence_expiry)}</p></div> },
    { key: 'emergency', header: 'Emergency contact', render: (d) => d.emergency_contact_name ? `${d.emergency_contact_name} · ${d.emergency_contact_mobile ?? ''}` : '—' },
    { key: 'live_status', header: 'Availability', render: (d) => <div><Badge tone={LIVE_TONE[d.live_status] ?? 'slate'}>{humanize(d.live_status)}</Badge>{d.running_trip_no && <p className="text-caption text-ink-secondary">{d.running_trip_no}</p>}</div> },
  ];
  return (
    <>
      <PageHeader title="Staff Driver Master" subtitle="Drivers are staff logins — the driver signs in to the driver screen with their own login"
        actions={can('TRANSPORT.MASTER') && <button className="btn-primary" onClick={() => setEdit(null)} data-action="new-driver"><Plus size={15} /> New Driver</button>} />
      <div className="mb-3"><SearchInput value={search} onChange={setSearch} placeholder="Name, licence, mobile…" className="w-full max-w-sm" /></div>
      <DataTable columns={cols} rows={list.data ?? []} loading={list.isLoading} error={list.error} rowKey={(d) => d.id} onRowClick={can('TRANSPORT.MASTER') ? (d) => setEdit(d) : undefined}
        emptyTitle="No drivers" emptyMessage="Create a login for the driver (Admin → Users, role Driver), then add the driver profile here." />
      {edit !== undefined && <DriverForm d={edit} onClose={() => setEdit(undefined)} />}
    </>
  );
}

function DriverForm({ d, onClose }: { d: any | null; onClose: () => void }) {
  const users = useQuery({ queryKey: ['transport', 'driver-candidates'], queryFn: async () => (await http.get<{ data: any[] }>('/transport/driver-candidates')).data });
  const [f, setF] = useState<Record<string, any>>({
    user_id: d?.user_id ?? '', licence_no: d?.licence_no ?? '', licence_class: d?.licence_class ?? '', licence_expiry: d?.licence_expiry ? String(d.licence_expiry).slice(0, 10) : '',
    mobile_no: d?.mobile_no ?? '', emergency_contact_name: d?.emergency_contact_name ?? '', emergency_contact_mobile: d?.emergency_contact_mobile ?? '',
    availability_status: d?.availability_status ?? 'AVAILABLE', remarks: d?.remarks ?? '', is_active: d ? Number(d.is_active) : 1,
  });
  const m = useMasterSave('/transport/drivers', onClose);
  const set = (k: string) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={d ? `Edit ${d.driver_name}` : 'New Driver'} size="md"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={m.busy} onClick={() => void m.save(d?.id ?? null, { ...f, row_version: d?.row_version })} data-action="save-driver">{m.busy && <Spinner size={14} />} Save</button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select label="Staff (login)" required className="sm:col-span-2" value={f.user_id} error={m.errors.user_id} placeholder="— Select staff —" data-field="user_id"
          onChange={(e) => { const u = users.data?.find((x) => String(x.id) === e.target.value); setF((p) => ({ ...p, user_id: e.target.value, mobile_no: p.mobile_no || u?.mobile || '' })); }}
          options={(users.data ?? []).filter((u) => !u.driver_id || u.driver_id === d?.id).map((u) => ({ value: u.id, label: `${u.label} (${u.code})` }))} />
        <Input label="Licence no" required value={f.licence_no} onChange={set('licence_no')} error={m.errors.licence_no} data-field="licence_no" />
        <Input label="Licence class" value={f.licence_class} onChange={set('licence_class')} placeholder="LMV / HMV / MCWG" />
        <Input label="Licence expiry" required type="date" value={f.licence_expiry} onChange={set('licence_expiry')} error={m.errors.licence_expiry} data-field="licence_expiry" />
        <Input label="Mobile" required inputMode="tel" value={f.mobile_no} onChange={set('mobile_no')} error={m.errors.mobile_no} data-field="mobile_no" />
        <Input label="Emergency contact" value={f.emergency_contact_name} onChange={set('emergency_contact_name')} />
        <Input label="Emergency mobile" value={f.emergency_contact_mobile} onChange={set('emergency_contact_mobile')} error={m.errors.emergency_contact_mobile} />
        <Select label="Availability" value={f.availability_status} onChange={set('availability_status')} options={[{ value: 'AVAILABLE', label: 'Available' }, { value: 'ON_LEAVE', label: 'On leave' }, { value: 'INACTIVE', label: 'Inactive' }]} />
        <div className="flex items-end pb-1.5"><Checkbox label="Active" checked={!!f.is_active} onChange={(x) => setF((p) => ({ ...p, is_active: x ? 1 : 0 }))} /></div>
        <Textarea label="Remarks" className="sm:col-span-2" value={f.remarks} onChange={set('remarks')} />
      </div>
      {m.err && <p className="help-error mt-2" data-error>{m.err}</p>}
    </Modal>
  );
}

/* ====================================================================== request types */
export function TransportRequestTypesPage() {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['transport', 'request-types', 'all'], queryFn: async () => (await http.get<{ data: any[] }>('/transport/request-types?all=1')).data });
  const [edit, setEdit] = useState<any | null | undefined>(undefined);
  const photoOn = !!useTransportSettings().data?.delivery_photo;
  const yn = (x: unknown) => (Number(x) ? <Badge tone="green">Required</Badge> : <span className="text-ink-muted">Optional</span>);
  const cols: Column<any>[] = [
    { key: 'type_name', header: 'Request type', render: (t) => <div><p className="font-semibold">{t.type_name}</p><p className="text-caption text-ink-secondary">{t.type_code}</p></div> },
    { key: 'requires_pickup', header: 'Pickup', render: (t) => yn(t.requires_pickup) },
    { key: 'requires_destination', header: 'Destination', render: (t) => yn(t.requires_destination) },
    { key: 'requires_material', header: 'Material details', render: (t) => yn(t.requires_material) },
    ...(photoOn ? [{ key: 'requires_proof', header: 'Delivery proof photo', render: (t: any) => yn(t.requires_proof) }] : []),
    { key: 'is_active', header: 'Active', render: (t) => (Number(t.is_active) ? 'Yes' : 'No') },
  ];
  return (
    <>
      <PageHeader title="Transport Request Types" subtitle={photoOn ? 'Each type decides which request fields are mandatory and whether the driver must photograph the delivery' : 'Each type decides which request fields are mandatory (delivery photos are off — Admin → Settings → TRANSPORT_DELIVERY_PHOTO)'}
        actions={can('TRANSPORT.MASTER') && <button className="btn-primary" onClick={() => setEdit(null)}><Plus size={15} /> New Type</button>} />
      <DataTable columns={cols} rows={list.data ?? []} loading={list.isLoading} error={list.error} rowKey={(t) => t.id} onRowClick={can('TRANSPORT.MASTER') ? (t) => setEdit(t) : undefined} />
      {edit !== undefined && <TypeForm t={edit} onClose={() => setEdit(undefined)} />}
    </>
  );
}
function TypeForm({ t, onClose }: { t: any | null; onClose: () => void }) {
  const photoOn = !!useTransportSettings().data?.delivery_photo;
  const [f, setF] = useState<Record<string, any>>({
    type_code: t?.type_code ?? '', type_name: t?.type_name ?? '', requires_pickup: t ? Number(t.requires_pickup) : 1, requires_destination: t ? Number(t.requires_destination) : 1,
    requires_material: t ? Number(t.requires_material) : 0, requires_proof: t ? Number(t.requires_proof) : 0, sort_order: t?.sort_order ?? 0, is_active: t ? Number(t.is_active) : 1,
  });
  const m = useMasterSave('/transport/request-types', onClose);
  const chk = (k: string, label: string) => <Checkbox label={label} checked={!!f[k]} onChange={(x) => setF((p) => ({ ...p, [k]: x ? 1 : 0 }))} />;
  return (
    <Modal open onClose={onClose} title={t ? `Edit ${t.type_name}` : 'New Request Type'} size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.busy} onClick={() => void m.save(t?.id ?? null, f)}>{m.busy && <Spinner size={14} />} Save</button></>}>
      <div className="space-y-3">
        <Input label="Code" required value={f.type_code} onChange={(e) => setF({ ...f, type_code: e.target.value })} error={m.errors.type_code} />
        <Input label="Name" required value={f.type_name} onChange={(e) => setF({ ...f, type_name: e.target.value })} error={m.errors.type_name} />
        <Input label="Sort order" type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} />
        {chk('requires_pickup', 'Pickup location required')}{chk('requires_destination', 'Destination required')}{chk('requires_material', 'Material / parcel description required')}
        {photoOn && chk('requires_proof', 'Delivery proof photo required')}{chk('is_active', 'Active')}
        {m.err && <p className="help-error">{m.err}</p>}
      </div>
    </Modal>
  );
}
