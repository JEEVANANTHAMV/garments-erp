import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText, Send, Truck, CalendarClock, Ban } from 'lucide-react';
import clsx from 'clsx';
import { Modal, Button, Input, Select, Textarea, SearchInput, LoadingBlock, EmptyState, useDebounced } from '../../../components/ui';
import { http } from '../../../lib/api';
import { fmtDate, fmtDateTime } from '../../../lib/format';
import { type EwbMeta, TRANSPORT_MODES, VEHICLE_TYPES, nowLocalInput, localToIso, parseError } from './ewbShared';

/** Red box with the server's message and, for "not ready", the list of problems. */
export function ErrorBox({ err, id }: { err: { message: string; problems: string[] } | null; id?: string }) {
  if (!err) return null;
  return (
    <div id={id} className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-body text-red-700" role="alert">
      <div className="font-semibold">{err.message}</div>
      {!!err.problems.length && <ul className="mt-1 list-disc space-y-0.5 pl-5">{err.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
    </div>
  );
}

type Run = (path: string, body: Record<string, unknown>) => Promise<boolean>;
type ErrState = { message: string; problems: string[] } | null;

/** Wraps a portal action: busy flag, red box on failure, close on success. */
function useAction(run: Run, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ErrState>(null);
  const go = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try { if (await run(path, body)) onClose(); } catch (e) { setErr(parseError(e)); } finally { setBusy(false); }
  };
  return { busy, err, setErr, go };
}

/* ─────────────────────────────────────────────── pick the source document (register → New) */

export function SourcePickerModal({ open, onClose, meta }: { open: boolean; onClose: () => void; meta?: EwbMeta }) {
  const nav = useNavigate();
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const docs = useQuery({
    queryKey: ['ewb-sources', type, dq],
    queryFn: async () => (await http.get<{ data: { id: number; no: string; dt: string; party: string | null }[] }>('/eway-bills/sources', { type, q: dq })).data,
    enabled: open && !!type,
  });
  return (
    <Modal open={open} onClose={onClose} title="New e-way bill" icon={<FileText size={16} />} size="lg"
      subtitle="Pick the document that moves the goods — its consignee, items and values fill the draft."
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="mb-3 flex flex-wrap gap-2" id="ewb-src-types">
        {(meta?.source_types ?? []).map((t) => (
          <button key={t.value} type="button" data-src-type={t.value} onClick={() => { setType(t.value); setQ(''); }}
            className={clsx('rounded-lg border px-3 py-1.5 text-body font-medium transition-colors',
              type === t.value ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-surface-border text-ink-secondary hover:bg-surface-muted')}>
            {t.label}
          </button>
        ))}
      </div>
      {!type ? <EmptyState title="Choose the kind of document" message="Dispatch, process / job-work DC, purchase return, gate outward or stock delivery." /> : (
        <>
          <SearchInput value={q} onChange={setQ} placeholder="Search document no / party" className="mb-3" />
          {docs.isLoading ? <LoadingBlock rows={4} /> : !docs.data?.length ? <EmptyState title="No documents" message="Nothing of this kind matches." /> : (
            <div className="max-h-[420px] overflow-y-auto rounded-lg border border-surface-border">
              <table className="w-full text-body" id="ewb-src-list">
                <thead><tr><th className="th">Document</th><th className="th">Date</th><th className="th">Party</th></tr></thead>
                <tbody>{docs.data.map((d) => (
                  <tr key={d.id} data-src-id={d.id} className="cursor-pointer hover:bg-brand-50/50"
                    onClick={() => nav(`/logistics/eway-bills/new?source_type=${type}&source_id=${d.id}`)}>
                    <td className="td tabular-nums font-medium text-brand-700">{d.no}</td><td className="td">{fmtDate(d.dt)}</td><td className="td">{d.party ?? '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/* ─────────────────────────────────────────────── generate (online: confirm; manual: record the portal number) */

export function GenerateModal({ open, onClose, meta, run, total }: { open: boolean; onClose: () => void; meta: EwbMeta; run: Run; total: string }) {
  const [f, setF] = useState({ ewb_no: '', ewb_date: nowLocalInput(), valid_upto: '' });
  const a = useAction(run, onClose);
  const submit = () => {
    if (meta.online) { a.go('generate', {}); return; }
    if (!/^\d{12}$/.test(f.ewb_no)) { a.setErr({ message: 'Enter the 12-digit e-way bill number from the GST portal', problems: [] }); return; }
    a.go('generate', { ewb_no: f.ewb_no, ewb_date: localToIso(f.ewb_date), valid_upto: localToIso(f.valid_upto) });
  };
  return (
    <Modal open={open} onClose={onClose} size="sm" icon={<Send size={16} />}
      title={meta.online ? 'Generate e-way bill' : 'Record e-way bill from the GST portal'}
      subtitle={meta.online ? `Sent to the GST portal through ${meta.provider_label}. Value ₹${total}.` : 'Generate it on ewaybillgst.gov.in with these details, then enter the number here.'}
      footer={<><Button variant="secondary" onClick={onClose} disabled={a.busy}>Cancel</Button>
        <Button id="ewb-confirm-generate" loading={a.busy} onClick={submit}>{meta.online ? 'Generate' : 'Record e-way bill'}</Button></>}>
      <ErrorBox err={a.err} id="ewb-gen-error" />
      {meta.online ? <p className="text-body text-ink-secondary">The e-way bill is generated on the portal and cannot be edited afterwards — only the vehicle updated, the validity extended or (within 24 h) cancelled.</p> : (
        <div className="grid gap-3">
          <Input label="E-way bill no" required id="ewb-no-input" inputMode="numeric" maxLength={12} placeholder="12 digits" value={f.ewb_no}
            onChange={(e) => setF({ ...f, ewb_no: e.target.value.replace(/\D/g, '').slice(0, 12) })} />
          <Input label="E-way bill date & time" type="datetime-local" id="ewb-date-input" value={f.ewb_date} onChange={(e) => setF({ ...f, ewb_date: e.target.value })} />
          <Input label="Valid upto" type="datetime-local" id="ewb-valid-input" value={f.valid_upto} onChange={(e) => setF({ ...f, valid_upto: e.target.value })}
            hint="Leave blank to work it out from the distance (no vehicle yet → Part-A only)" />
        </div>
      )}
    </Modal>
  );
}

/* ─────────────────────────────────────────────── Part B: vehicle update */

export function PartBModal({ open, onClose, meta, run, e }: { open: boolean; onClose: () => void; meta: EwbMeta; run: Run; e: any }) {
  const [f, setF] = useState({
    vehicle_no: e.vehicle_no ?? '', vehicle_type: e.vehicle_type ?? 'Regular', transport_mode: e.transport_mode ?? 'Road',
    transport_doc_no: e.transport_doc_no ?? '', transport_doc_date: e.transport_doc_date ?? '',
    from_place: e.from_place ?? '', from_state: e.from_state ?? '', reason: e.vehicle_no ? '' : 'First Time', remark: '', valid_upto: '',
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const a = useAction(run, onClose);
  // manual mode, first vehicle and no distance on the draft: the validity cannot be worked out — take it from the portal
  const needValid = !meta.online && !e.valid_upto && !(Number(e.distance_km) > 0);
  const submit = () => a.go('part-b', {
    ...f, transport_doc_no: f.transport_doc_no || null, transport_doc_date: f.transport_doc_date || null, remark: f.remark || null,
    valid_upto: meta.online ? undefined : localToIso(f.valid_upto),
  });
  return (
    <Modal open={open} onClose={onClose} title="Update vehicle (Part B)" icon={<Truck size={16} />} size="md"
      subtitle={e.valid_upto ? 'Change of vehicle — breakdown, transhipment. Validity stays as it is.' : 'First Part B starts the validity of the e-way bill.'}
      footer={<><Button variant="secondary" onClick={onClose} disabled={a.busy}>Cancel</Button>
        <Button id="ewb-partb-save" loading={a.busy} disabled={!f.reason || !f.from_place || (needValid && !f.valid_upto)} onClick={submit}>Update vehicle</Button></>}>
      <ErrorBox err={a.err} id="ewb-partb-error" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Mode" value={f.transport_mode} onChange={(ev) => set({ transport_mode: ev.target.value })} options={TRANSPORT_MODES.map((m) => ({ value: m, label: m }))} />
        <Input label="Vehicle no" id="ewb-partb-vehicle" required={f.transport_mode === 'Road'} placeholder="TN39AB1234" value={f.vehicle_no}
          onChange={(ev) => set({ vehicle_no: ev.target.value.toUpperCase() })} />
        <Select label="Vehicle type" value={f.vehicle_type} onChange={(ev) => set({ vehicle_type: ev.target.value })} options={VEHICLE_TYPES} />
        <Select label="Reason" required id="ewb-partb-reason" value={f.reason} onChange={(ev) => set({ reason: ev.target.value })} placeholder="Select…"
          options={meta.vehicle_reasons.map((r) => ({ value: r, label: r }))} />
        <Input label="Transport doc / LR no" value={f.transport_doc_no} maxLength={15} onChange={(ev) => set({ transport_doc_no: ev.target.value })} />
        <Input label="Transport doc date" type="date" value={f.transport_doc_date} onChange={(ev) => set({ transport_doc_date: ev.target.value })} />
        <Input label="From place" required id="ewb-partb-place" value={f.from_place} onChange={(ev) => set({ from_place: ev.target.value })} />
        <Select label="From state" required value={f.from_state} onChange={(ev) => set({ from_state: ev.target.value })} placeholder="Select…" options={meta.states.map((s) => ({ value: s, label: s }))} />
        <Input label="Remark" className="sm:col-span-2" maxLength={50} value={f.remark} onChange={(ev) => set({ remark: ev.target.value })} />
        {!meta.online && <Input label="Valid upto (from the portal)" type="datetime-local" className="sm:col-span-2" id="ewb-partb-valid" required={needValid}
          value={f.valid_upto} onChange={(ev) => set({ valid_upto: ev.target.value })}
          hint={needValid ? 'The draft has no distance, so the validity cannot be worked out — enter the “valid upto” shown on the portal'
            : e.valid_upto ? 'Leave blank to keep the validity' : 'Leave blank to work it out from the distance'} />}
      </div>
    </Modal>
  );
}

/* ─────────────────────────────────────────────── extend validity */

export function ExtendModal({ open, onClose, meta, run, e }: { open: boolean; onClose: () => void; meta: EwbMeta; run: Run; e: any }) {
  const [f, setF] = useState({
    remaining_km: '', reason: '', remark: '', consignment_status: 'M', transit_type: '', from_place: e.to_place ?? '', from_state: e.to_state ?? '',
    from_pincode: '', vehicle_no: e.vehicle_no ?? '', transport_mode: e.transport_mode ?? 'Road', transport_doc_no: '', transport_doc_date: '', address1: '', valid_upto: '',
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const a = useAction(run, onClose);
  const moving = f.consignment_status === 'M';
  const submit = () => a.go('extend', {
    ...f, remaining_km: Number(f.remaining_km) || 0, transit_type: moving ? null : f.transit_type || null, vehicle_no: moving ? f.vehicle_no : null,
    transport_doc_no: f.transport_doc_no || null, transport_doc_date: f.transport_doc_date || null, address1: f.address1 || null,
    valid_upto: meta.online ? undefined : localToIso(f.valid_upto),
  });
  return (
    <Modal open={open} onClose={onClose} title="Extend validity" icon={<CalendarClock size={16} />} size="md"
      subtitle={`Valid upto ${fmtDateTime(e.valid_upto)} — extension is allowed from 8 hours before to 8 hours after it ends.`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={a.busy}>Cancel</Button>
        <Button id="ewb-extend-save" loading={a.busy} disabled={!f.reason || !f.remaining_km} onClick={submit}>Extend</Button></>}>
      <ErrorBox err={a.err} id="ewb-extend-error" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Consignment" value={f.consignment_status} onChange={(ev) => set({ consignment_status: ev.target.value })}
          options={[{ value: 'M', label: 'In movement (on a vehicle)' }, { value: 'T', label: 'In transit (stopped)' }]} />
        {moving
          ? <Input label="Vehicle no" required value={f.vehicle_no} onChange={(ev) => set({ vehicle_no: ev.target.value.toUpperCase() })} />
          : <Select label="Goods are at" required value={f.transit_type} onChange={(ev) => set({ transit_type: ev.target.value })} placeholder="Select…"
              options={[{ value: 'R', label: 'Road' }, { value: 'W', label: 'Warehouse' }, { value: 'O', label: 'Others' }]} />}
        <Input label="Remaining distance (km)" required type="number" min={1} value={f.remaining_km} onChange={(ev) => set({ remaining_km: ev.target.value })} />
        <Select label="Reason" required value={f.reason} onChange={(ev) => set({ reason: ev.target.value })} placeholder="Select…" options={meta.extend_reasons.map((r) => ({ value: r, label: r }))} />
        <Input label="Current place" required value={f.from_place} onChange={(ev) => set({ from_place: ev.target.value })} />
        <Select label="Current state" required value={f.from_state} onChange={(ev) => set({ from_state: ev.target.value })} placeholder="Select…" options={meta.states.map((s) => ({ value: s, label: s }))} />
        <Input label="Current PIN code" required maxLength={6} value={f.from_pincode} onChange={(ev) => set({ from_pincode: ev.target.value.replace(/\D/g, '') })} />
        <Select label="Mode" value={f.transport_mode} onChange={(ev) => set({ transport_mode: ev.target.value })} options={TRANSPORT_MODES.map((m) => ({ value: m, label: m }))} />
        <Input label="Transport doc / LR no" maxLength={15} value={f.transport_doc_no} onChange={(ev) => set({ transport_doc_no: ev.target.value })} />
        <Input label="Transport doc date" type="date" value={f.transport_doc_date} onChange={(ev) => set({ transport_doc_date: ev.target.value })} />
        <Input label="Address" className="sm:col-span-2" value={f.address1} onChange={(ev) => set({ address1: ev.target.value })} />
        <Input label="Remark" required className="sm:col-span-2" maxLength={50} value={f.remark} onChange={(ev) => set({ remark: ev.target.value })} />
        {!meta.online && <Input label="New valid upto (from the portal)" type="datetime-local" className="sm:col-span-2" value={f.valid_upto}
          onChange={(ev) => set({ valid_upto: ev.target.value })} hint="Leave blank to work it out from the remaining distance" />}
      </div>
    </Modal>
  );
}

/* ─────────────────────────────────────────────── cancel (within 24 h) */

export function CancelModal({ open, onClose, meta, run, e }: { open: boolean; onClose: () => void; meta: EwbMeta; run: Run; e: any }) {
  const [f, setF] = useState({ reason: '', remark: '' });
  const a = useAction(run, onClose);
  return (
    <Modal open={open} onClose={onClose} title={`Cancel e-way bill ${e.ewb_no ?? ''}`} icon={<Ban size={16} />} size="sm"
      subtitle="Allowed only within 24 hours of generation. The number is cleared from the source document."
      footer={<><Button variant="secondary" onClick={onClose} disabled={a.busy}>Keep</Button>
        <Button variant="danger" id="ewb-cancel-confirm" loading={a.busy} disabled={!f.reason || f.remark.trim().length < 3}
          onClick={() => a.go('cancel', { reason: f.reason, remark: f.remark.trim() })}>Cancel e-way bill</Button></>}>
      <ErrorBox err={a.err} id="ewb-cancel-error" />
      <div className="grid gap-3">
        <Select label="Reason" required id="ewb-cancel-reason" value={f.reason} onChange={(ev) => setF({ ...f, reason: ev.target.value })} placeholder="Select…"
          options={meta.cancel_reasons.map((r) => ({ value: r, label: r }))} />
        <Textarea label="Remark" required id="ewb-cancel-remark" maxLength={100} hint="At least 3 characters" value={f.remark} onChange={(ev) => setF({ ...f, remark: ev.target.value })} />
      </div>
    </Modal>
  );
}
