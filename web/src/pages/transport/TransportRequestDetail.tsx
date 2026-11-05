/** Vehicle request detail + timeline + coordinator actions (spec §4.1 / §4.2 / §5). Route /transport/requests/:id */
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, HelpCircle, Ban, Pencil, Truck, Paperclip, Trash2, Eye, FilePen, PackageCheck } from 'lucide-react';
import { PageHeader, LoadingBlock, ErrorState, Modal, Input, Textarea, Spinner, ImageThumbnail } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { humanize } from '../../lib/format';
import { StatusPill, REQUEST_TONE, TRIP_TONE, PRIORITY_TONE, STOP_TONE, fmtIst, Timeline, Info, ReasonDialog, errMsg, toLocalInput, localToIso, nowLocalInput } from './transportShared';

export function TransportRequestDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['transport', 'request', id], queryFn: async () => (await http.get<{ data: any }>(`/transport/requests/${id}`)).data });
  const [dialog, setDialog] = useState<'' | 'approve' | 'reject' | 'clarify' | 'cancel'>('');
  const [amend, setAmend] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  if (q.isLoading) return <LoadingBlock />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const r = q.data;
  const a = r.actions ?? {};
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['transport'] }); };
  const post = async (path: string, body: object, msg: string) => {
    await http.post(`/transport/requests/${id}/${path}`, { ...body, row_version: r.row_version });
    toast(msg); refresh();
  };
  const upload = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) { toast('File must be under 10 MB', 'error'); return; }
    setUploading(true);
    try {
      const data = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(file); });
      const up = await http.post<{ data: { url: string; size: number; mimeType: string } }>('/uploads', { filename: file.name, data, folder: 'attachments' });
      await http.post(`/transport/requests/${id}/attachments`, { file_name: file.name, file_url: up.data.url, mime_type: up.data.mimeType, file_size: up.data.size });
      toast('Attachment added'); refresh();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const mine = Number(r.requested_by) === user?.id;
  return (
    <>
      <PageHeader breadcrumb={['Gate Security', 'Vehicle Requests']}
        title={<span className="flex flex-wrap items-center gap-2">{r.request_no} <StatusPill value={r.status} tones={REQUEST_TONE} /> <StatusPill value={r.priority} tones={PRIORITY_TONE} /></span>}
        subtitle={`${r.type_name} · ${r.purpose}`}
        actions={<>
          {a.edit && <button className="btn-secondary" onClick={() => nav(`/transport/requests/${id}/edit`)} data-action="edit"><Pencil size={14} /> {r.status === 'CLARIFICATION_REQUIRED' ? 'Answer clarification' : 'Edit draft'}</button>}
          {a.submit && r.status === 'DRAFT' && <button className="btn-primary" data-action="submit" onClick={() => void post('submit', {}, 'Submitted — next: coordinator review').catch((e) => toast(errMsg(e), 'error'))}>Submit</button>}
          {a.amend && <button className="btn-secondary" onClick={() => setAmend(true)} data-action="amend"><FilePen size={14} /> Amend</button>}
          {a.review && <button className="btn-secondary" data-action="review" onClick={() => void post('review', {}, 'Taken for review').catch((e) => toast(errMsg(e), 'error'))}><Eye size={14} /> Take for review</button>}
          {a.clarify && <button className="btn-secondary" onClick={() => setDialog('clarify')} data-action="clarify"><HelpCircle size={14} /> Ask clarification</button>}
          {a.reject && <button className="btn-secondary text-red-700" onClick={() => setDialog('reject')} data-action="reject"><X size={14} /> Reject</button>}
          {a.approve && <button className="btn-primary" onClick={() => setDialog('approve')} data-action="approve"><Check size={14} /> Approve</button>}
          {a.assign && <button className="btn-primary" onClick={() => nav(`/transport/trips/new?requests=${r.id}`)} data-action="assign"><Truck size={14} /> Allocate vehicle</button>}
          {a.confirm_received && <button className="btn-primary" onClick={() => setReceiving(true)} data-action="confirm-received"><PackageCheck size={14} /> Confirm material received</button>}
          {a.cancel && <button className="btn-ghost text-red-700" onClick={() => setDialog('cancel')} data-action="cancel"><Ban size={14} /> Cancel request</button>}
        </>} />

      {r.status === 'CLARIFICATION_REQUIRED' && (
        <div className="card mb-3 border-amber-300 bg-amber-50 p-3 text-body">
          <b>Clarification asked:</b> {r.clarification_question}{mine && ' — open "Answer clarification" to reply and resubmit.'}
        </div>
      )}
      {a.confirm_received && (
        <div className="card mb-3 border-emerald-300 bg-emerald-50 p-3 text-body" id="tr-await-receipt">
          <b>Delivered.</b> {mine ? 'When the material reaches you, press "Confirm material received" (date-time, qty, condition).' : 'Waiting for the requester to confirm the material received.'}
        </div>
      )}
      {r.status === 'RECEIVED' && (
        <div className={`card mb-3 p-3 text-body ${r.received_condition && r.received_condition !== 'OK' ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`} id="tr-received">
          <b>Material received</b> {fmtIst(r.received_at)} · {humanize(r.received_condition ?? 'OK')}{r.received_qty != null && ` · qty ${Number(r.received_qty)} ${r.package_uom ?? ''}`}{r.received_remarks && ` · ${r.received_remarks}`}
        </div>
      )}
      {r.status === 'REJECTED' && <div className="card mb-3 border-red-200 bg-red-50 p-3 text-body"><b>Rejected:</b> {r.rejection_reason}</div>}
      {r.status === 'CANCELLED' && <div className="card mb-3 border-red-200 bg-red-50 p-3 text-body"><b>Cancelled:</b> {r.cancel_reason}</div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
            <Info label="Requested by">{r.requested_by_name}</Info>
            <Info label="Department">{r.department_name}</Info>
            <Info label="Needed at">{fmtIst(r.required_at)}</Info>
            <Info label="Submitted">{fmtIst(r.submitted_at)}</Info>
            <Info label="Pickup">{r.pickup_location}{r.pickup_address && <p className="text-small text-ink-secondary">{r.pickup_address}</p>}</Info>
            <Info label="Destination">{r.destination_location}{r.destination_address && <p className="text-small text-ink-secondary">{r.destination_address}</p>}</Info>
            <Info label="Contact">{r.contact_name} · <a className="text-brand-700" href={`tel:${r.contact_mobile}`}>{r.contact_mobile}</a></Info>
            <Info label="Material">{r.material_description}{r.package_qty != null && ` · ${Number(r.package_qty)} ${r.package_uom ?? ''}`}</Info>
            {r.priority !== 'NORMAL' && <Info label="Priority reason">{r.priority_reason}</Info>}
            {r.approved_at && <Info label="Approved">{r.approved_by_name} · {fmtIst(r.approved_at)}{r.approval_remarks && ` · ${r.approval_remarks}`}</Info>}
            {r.clarification_response && <Info label="Clarification answer">{r.clarification_response}</Info>}
            {r.remarks && <Info label="Remarks">{r.remarks}</Info>}
          </div>

          <div className="card p-4">
            <h3 className="mb-2 text-title font-semibold text-ink">Trip & vehicle</h3>
            {!r.trips?.length && <p className="text-body text-ink-secondary">{r.status === 'APPROVED' ? 'Approved — waiting for a vehicle to be allocated.' : 'No trip yet.'}</p>}
            {(r.trips ?? []).map((t: any) => (
              <div key={`${t.trip_id}-${t.linked_at}`} className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-surface-divider pb-2 text-body last:border-0">
                <Link to={`/transport/trips/${t.trip_id}`} className="font-semibold text-brand-700">{t.trip_no}</Link>
                <StatusPill value={t.status} tones={TRIP_TONE} />
                <span>{t.vehicle_no} ({humanize(t.ownership_type)})</span>
                <span>{t.driver_name}{t.driver_mobile && <> · <a className="text-brand-700" href={`tel:${t.driver_mobile}`}>{t.driver_mobile}</a></>}</span>
                <span className="text-ink-secondary">{fmtIst(t.planned_start_at)} – {fmtIst(t.planned_end_at, false)}</span>
                {!t.is_active && <span className="text-small text-ink-secondary">Left the trip: {t.unlink_reason}</span>}
              </div>
            ))}
            {!!r.service_lines?.length && (
              <table className="mt-2 w-full text-body">
                <thead><tr className="text-left text-small text-ink-secondary"><th className="py-1">Stop</th><th>Service</th><th>Status</th><th>Qty</th><th>Receiver</th><th>Done at</th></tr></thead>
                <tbody>
                  {r.service_lines.map((l: any) => (
                    <tr key={l.id} className="border-t border-surface-divider">
                      <td className="py-1">{l.stop_no}. {l.location_name}</td><td>{humanize(l.service_type)}</td>
                      <td><StatusPill value={l.result === 'PENDING' ? l.stop_status : l.result} tones={{ ...STOP_TONE, DONE: 'green', PARTIAL: 'amber' }} /></td>
                      <td className="tabular-nums">{l.actual_qty ?? l.expected_qty ?? '—'}</td><td>{l.receiver_name ?? '—'}</td><td>{fmtIst(l.done_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {r.delivery_photo && !!r.proofs?.length && (
              <div className="mt-3 flex flex-wrap gap-3">
                {r.proofs.map((p: any) => (
                  <div key={p.id} className="flex items-center gap-2 text-small text-ink-secondary">
                    <ImageThumbnail url={p.file_url} title={`Proof · ${p.location_name ?? ''}`} />
                    <span>{p.receiver_name ?? ''}<br />{fmtIst(p.captured_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-title font-semibold text-ink">Attachments</h3>
              {(mine || a.approve || a.reject) && !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(r.status) && (
                <>
                  <input ref={fileRef} type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} data-field="attachment" />
                  <button className="btn-secondary btn-sm" disabled={uploading} onClick={() => fileRef.current?.click()} data-action="add-attachment">{uploading ? <Spinner size={13} /> : <Paperclip size={13} />} Add</button>
                </>
              )}
            </div>
            {!r.attachments?.length && <p className="text-body text-ink-secondary">None</p>}
            <ul className="space-y-1">
              {(r.attachments ?? []).map((f: any) => (
                <li key={f.id} className="flex items-center gap-2 text-body">
                  <a href={f.file_url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{f.file_name}</a>
                  <span className="text-caption text-ink-secondary">{f.uploaded_by_name} · {fmtIst(f.uploaded_at)}</span>
                  {(mine || a.approve) && <button className="rounded p-1 text-ink-muted hover:text-red-600" title="Remove" onClick={async () => { try { await http.del(`/transport/requests/${id}/attachments/${f.id}`); refresh(); } catch (e) { toast(errMsg(e), 'error'); } }}><Trash2 size={13} /></button>}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="card h-fit p-4">
          <h3 className="mb-3 text-title font-semibold text-ink">Timeline</h3>
          <Timeline events={r.timeline} />
        </div>
      </div>

      <ReasonDialog open={dialog === 'approve'} title={`Approve ${r.request_no}`} label="Remarks (optional)" required={false} confirmLabel="Approve"
        onClose={() => setDialog('')} onConfirm={(t) => post('approve', { remarks: t || null }, 'Approved — allocate a vehicle next')}>
        <p className="mb-2 text-body text-ink-secondary">Approval does not reserve a vehicle; availability is checked when you allocate the trip.</p>
      </ReasonDialog>
      <ReasonDialog open={dialog === 'reject'} title={`Reject ${r.request_no}`} label="Rejection reason" confirmLabel="Reject" danger
        onClose={() => setDialog('')} onConfirm={(t) => post('reject', { reason: t }, 'Request rejected — requester informed')} />
      <ReasonDialog open={dialog === 'clarify'} title={`Ask the requester about ${r.request_no}`} label="Question" confirmLabel="Send question"
        onClose={() => setDialog('')} onConfirm={(t) => post('clarification', { question: t }, 'Question sent to the requester')} />
      <ReasonDialog open={dialog === 'cancel'} title={`Cancel ${r.request_no}`} label="Cancellation reason" confirmLabel="Cancel request" danger
        onClose={() => setDialog('')} onConfirm={(t) => post('cancel', { reason: t }, 'Request cancelled')} />
      {receiving && <ReceivedDialog r={r} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); refresh(); toast('Material received — coordinator informed'); }} />}
      {amend && <AmendDialog r={r} onClose={() => setAmend(false)} onDone={() => { setAmend(false); refresh(); toast('Amendment saved'); }} />}
    </>
  );
}

/** Requester confirms the material received (client 05-Nov-2026): date-time, qty, condition (remarks when not OK). */
function ReceivedDialog({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ received_at: nowLocalInput(), received_qty: r.package_qty != null ? String(Number(r.package_qty)) : '', condition: 'OK', remarks: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const needRemarks = v.condition !== 'OK';
  return (
    <Modal open onClose={onClose} title={`Material received — ${r.request_no}`} subtitle={r.material_description || r.purpose} size="sm"
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Back</button>
        <button className="btn-primary" disabled={busy || !v.received_at || (needRemarks && v.remarks.trim().length < 3)} data-action="save-received" onClick={async () => {
          setBusy(true); setErr('');
          try {
            await http.post(`/transport/requests/${r.id}/confirm-received`, {
              received_at: localToIso(v.received_at), received_qty: v.received_qty === '' ? null : Number(v.received_qty),
              condition: v.condition, remarks: v.remarks.trim() || null, row_version: r.row_version,
            });
            onDone();
          } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }}>{busy && <Spinner size={14} />} Confirm received</button>
      </>}>
      <div className="space-y-3">
        <Input label="Received date & time" type="datetime-local" value={v.received_at} max={nowLocalInput(5)} onChange={(e) => setV((p) => ({ ...p, received_at: e.target.value }))} data-field="received-at" />
        <Input label={`Received qty${r.package_uom ? ` (${r.package_uom})` : ''}`} type="number" value={v.received_qty} placeholder="optional" onChange={(e) => setV((p) => ({ ...p, received_qty: e.target.value }))} data-field="received-qty" />
        <div>
          <label className="mb-1 block text-small font-medium text-ink-secondary" htmlFor="tr-received-condition">Condition</label>
          <select id="tr-received-condition" className="input" value={v.condition} onChange={(e) => setV((p) => ({ ...p, condition: e.target.value }))}>
            <option value="OK">OK — received in full, good condition</option>
            <option value="SHORT">Short — less than sent</option>
            <option value="DAMAGED">Damaged</option>
          </select>
        </div>
        <Textarea label={needRemarks ? 'What is short / damaged' : 'Remarks (optional)'} required={needRemarks} value={v.remarks} onChange={(e) => setV((p) => ({ ...p, remarks: e.target.value }))} error={err || undefined} data-field="received-remarks" />
      </div>
    </Modal>
  );
}

/** Amendment after submission: time / route / material / contact with a reason (before / after kept in the timeline). */
function AmendDialog({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const s = (x: unknown) => (x == null ? '' : String(x));
  const [v, setV] = useState({
    required_at: toLocalInput(r.required_at), pickup_location: s(r.pickup_location), pickup_address: s(r.pickup_address),
    destination_location: s(r.destination_location), destination_address: s(r.destination_address), contact_name: s(r.contact_name), contact_mobile: s(r.contact_mobile),
    material_description: s(r.material_description), package_qty: s(r.package_qty), package_uom: s(r.package_uom), reason: '',
  });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k: string) => (e: { target: { value: string } }) => setV((p) => ({ ...p, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={`Amend ${r.request_no}`} subtitle="Changes after submission are recorded with before / after values" size="lg"
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Back</button>
        <button className="btn-primary" disabled={busy || v.reason.trim().length < 3} data-action="save-amendment" onClick={async () => {
          setBusy(true); setErr('');
          try {
            await http.post(`/transport/requests/${r.id}/amendment`, {
              ...v, required_at: localToIso(v.required_at), pickup_unit_id: r.pickup_unit_id, pickup_party_id: r.pickup_party_id,
              destination_unit_id: r.destination_unit_id, destination_party_id: r.destination_party_id, passenger_count: r.passenger_count, remarks: r.remarks, row_version: r.row_version,
            });
            onDone();
          } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }}>{busy && <Spinner size={14} />} Save amendment</button>
      </>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Input label="Required date & time" type="datetime-local" value={v.required_at} onChange={set('required_at')} />
        <Input label="Contact mobile" value={v.contact_mobile} onChange={set('contact_mobile')} />
        <Input label="Pickup location" value={v.pickup_location} onChange={set('pickup_location')} />
        <Input label="Pickup address" value={v.pickup_address} onChange={set('pickup_address')} />
        <Input label="Destination" value={v.destination_location} onChange={set('destination_location')} />
        <Input label="Destination address" value={v.destination_address} onChange={set('destination_address')} />
        <Input label="Contact name" value={v.contact_name} onChange={set('contact_name')} />
        <Input label="Material / parcel" value={v.material_description} onChange={set('material_description')} />
        <Input label="Package qty" type="number" value={v.package_qty} onChange={set('package_qty')} />
        <Input label="UOM" value={v.package_uom} onChange={set('package_uom')} />
        <Textarea label="Reason for the amendment" required className="sm:col-span-2" value={v.reason} onChange={set('reason')} error={err || undefined} data-field="amend-reason" />
      </div>
    </Modal>
  );
}
