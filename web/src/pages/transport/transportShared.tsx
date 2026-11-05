/** Shared bits of the gate transport screens (db/150, client voice notes 04-Nov-2026). */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Modal, Spinner, Textarea } from '../../components/ui';
import { http, ApiError } from '../../lib/api';
import { humanize } from '../../lib/format';

export const REQUEST_TONE: Record<string, string> = {
  DRAFT: 'slate', SUBMITTED: 'blue', UNDER_REVIEW: 'indigo', CLARIFICATION_REQUIRED: 'amber', APPROVED: 'green', REJECTED: 'red',
  ASSIGNED: 'violet', IN_PROGRESS: 'blue', PICKUP_COMPLETED: 'blue', DELIVERED: 'green', COMPLETED: 'green', RECEIVED: 'emerald', CANCELLED: 'red',
};
/** Delivered / completed, waiting for the requester's "Confirm material received" (client 05-Nov-2026). */
export const AWAITING_RECEIPT = ['DELIVERED', 'COMPLETED'];
/** TRANSPORT_DELIVERY_PHOTO (Admin → Settings, default off): delivery / proof photos hidden and never required. */
export const useTransportSettings = () => useQuery({
  queryKey: ['transport', 'settings'],
  queryFn: async () => (await http.get<{ data: { delivery_photo: boolean } }>('/transport/settings')).data,
  staleTime: 60_000,
});
export const TRIP_TONE: Record<string, string> = {
  DRAFT: 'slate', ASSIGNED: 'violet', DRIVER_ACCEPTED: 'indigo', STARTED: 'blue', IN_PROGRESS: 'blue', COMPLETED: 'green', CANCELLED: 'red', EXCEPTION: 'amber',
};
export const STOP_TONE: Record<string, string> = { PENDING: 'slate', EN_ROUTE: 'blue', ARRIVED: 'indigo', SERVICED: 'green', COMPLETED: 'green', FAILED: 'red', CANCELLED: 'red' };
export const PRIORITY_TONE: Record<string, string> = { NORMAL: 'slate', URGENT: 'amber', CRITICAL: 'red' };

/** Status text + colour (never colour alone, spec §9.1). */
export const StatusPill = ({ value, tones }: { value?: string | null; tones: Record<string, string> }) =>
  value ? <Badge tone={tones[value] ?? 'slate'}>{humanize(value)}</Badge> : <span className="text-ink-muted">—</span>;

/** Business time display: dd Mon yyyy, HH:mm in IST. */
export function fmtIst(v: unknown, withDate = true): string {
  if (!v) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', ...(withDate ? { day: '2-digit', month: 'short', year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hour12: false });
}
/** UTC ISO → "YYYY-MM-DDTHH:mm" in IST for <input type="datetime-local">. */
export function toLocalInput(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16);
}
/** Now (+ minutes) as an IST datetime-local value. */
export const nowLocalInput = (plusMin = 0) => new Date(Date.now() + (330 + plusMin) * 60_000).toISOString().slice(0, 16);
/** Datetime-local value (IST) → ISO with +05:30 for the API. */
export const localToIso = (v: string) => (v ? `${v.length === 16 ? `${v}:00` : v}+05:30` : v);

export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong');

/** A confirmation popup that asks for a reason / remark (reject, cancel, clarify, reassign …). */
export function ReasonDialog({ open, title, label, required = true, confirmLabel, danger, onClose, onConfirm, children }: {
  open: boolean; title: string; label: string; required?: boolean; confirmLabel: string; danger?: boolean;
  onClose: () => void; onConfirm: (text: string) => Promise<void>; children?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const close = () => { setText(''); setErr(''); onClose(); };
  return (
    <Modal open={open} onClose={close} title={title} size="sm"
      footer={<>
        <button className="btn-secondary" onClick={close} disabled={busy}>Back</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} data-action="confirm-reason" disabled={busy || (required && text.trim().length < 3)}
          onClick={async () => { setBusy(true); setErr(''); try { await onConfirm(text.trim()); setText(''); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>
          {busy && <Spinner size={14} />} {confirmLabel}
        </button>
      </>}>
      {children}
      <Textarea label={label} required={required} value={text} onChange={(e) => setText(e.target.value)} error={err || undefined} data-field="reason" autoFocus />
    </Modal>
  );
}

export interface RequestType { id: number; type_code: string; type_name: string; requires_pickup: number; requires_destination: number; requires_material: number; requires_proof: number; is_active: number; sort_order: number }
export const useRequestTypes = (all = false) => useQuery({
  queryKey: ['transport', 'request-types', all],
  queryFn: async () => (await http.get<{ data: RequestType[] }>(`/transport/request-types${all ? '?all=1' : ''}`)).data,
  staleTime: 60_000,
});

/** One line of the status timeline. */
export function Timeline({ events }: { events: any[] }) {
  if (!events?.length) return <p className="text-body text-ink-secondary">No events yet</p>;
  return (
    <ol className="space-y-2" data-timeline>
      {events.map((e) => (
        <li key={e.id} className="flex gap-3">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-600" />
          <div className="min-w-0">
            <p className="text-body text-ink">
              <span className="font-semibold">{humanize(e.event_code)}</span>
              {e.entity_type && e.entity_type !== 'REQUEST' && <span className="text-ink-secondary"> · {e.entity_type === 'TRIP' ? 'Trip' : 'Stop'}{e.trip_no ? ` ${e.trip_no}` : ''}</span>}
              {e.new_status && e.old_status !== e.new_status && <span className="text-ink-secondary"> → {humanize(e.new_status)}</span>}
            </p>
            {e.event_note && <p className="text-small text-ink-secondary">{e.event_note}</p>}
            {e.after_json && e.event_code === 'AMENDED' && <AmendDiff before={e.before_json} after={e.after_json} />}
            <p className="text-caption text-ink-muted">{fmtIst(e.event_at)} · {e.actor_name ?? 'System'}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
function AmendDiff({ before, after }: { before: any; after: any }) {
  const b = typeof before === 'string' ? JSON.parse(before) : before ?? {};
  const a = typeof after === 'string' ? JSON.parse(after) : after ?? {};
  const show = (k: string, v: unknown) => (v == null || v === '' ? '—' : k.endsWith('_at') ? fmtIst(v) : String(v));
  return (
    <ul className="mt-0.5 text-small text-ink-secondary">
      {Object.keys(a).map((k) => <li key={k}>{humanize(k)}: <s>{show(k, b[k])}</s> → <span className="text-ink">{show(k, a[k])}</span></li>)}
    </ul>
  );
}

/** Compact label / value pair for detail cards. */
export const Info = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0">
    <p className="text-caption uppercase tracking-wider text-ink-secondary">{label}</p>
    <div className="text-body text-ink break-words">{children ?? '—'}</div>
  </div>
);
