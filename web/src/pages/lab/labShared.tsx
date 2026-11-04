import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Badge, Modal, Textarea, Button } from '../../components/ui';
import { api, http, ApiError } from '../../lib/api';

/**
 * Shared bits of the lab module (client spec "Lab Management — Washing & Testing", 02-Nov-2026): status labels and
 * tones, result badges, the reason popup, authenticated PDF / Excel blob handling, base64 file upload, the job picker
 * (GET /lab/jobs — lab users need not hold purchase rights) and the form options of the lab masters.
 */

export const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong');
export const label = (v?: string | null) => (v ? v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');

const TONE: Record<string, string> = {
  DRAFT: 'slate', SUBMITTED: 'blue', CLARIFICATION_REQUIRED: 'amber', SAMPLE_RECEIVED: 'indigo', IN_TESTING: 'blue', PENDING_LAB_REVIEW: 'violet',
  PENDING_QA_APPROVAL: 'violet', APPROVED: 'green', REJECTED: 'red', RETEST_REQUIRED: 'amber', CANCELLED: 'slate', CLOSED: 'slate',
  PLANNED: 'indigo', IN_PROGRESS: 'blue', COMPLETED: 'indigo', LAB_REVIEWED: 'violet',
  PENDING_LAB: 'violet', PENDING_QA: 'violet', RELEASED: 'green', RETURNED: 'amber', SUPERSEDED: 'slate',
  RECEIVED: 'green', ISSUED: 'blue', PARTIALLY_CONSUMED: 'blue', CONSUMED: 'slate', RETAINED: 'indigo', DISPOSED: 'slate',
  ACTIVE: 'green', INACTIVE: 'slate', REVOKED: 'slate',
};
export function LabStatus({ value }: { value?: string | null }) {
  if (!value) return <span className="text-ink-muted">—</span>;
  return <Badge tone={TONE[value] ?? 'slate'}>{label(value)}</Badge>;
}
const RTONE: Record<string, string> = { PASS: 'green', FAIL: 'red', BORDERLINE: 'amber', NOT_APPLICABLE: 'slate', PENDING: 'slate', INVALID: 'red', CONDITIONAL: 'amber' };
export function ResultBadge({ value, override }: { value?: string | null; override?: boolean }) {
  if (!value) return <span className="text-ink-muted">—</span>;
  return <Badge tone={RTONE[value] ?? 'slate'}>{value === 'NOT_APPLICABLE' ? 'N/A' : label(value)}{override ? ' (override)' : ''}</Badge>;
}

export const TEST_SCOPES = ['WASHING', 'GARMENT', 'TEXTILE_PHYSICAL', 'TEXTILE_CHEMICAL', 'BUYER_SPECIFIC', 'COMBINED'];
export const SOURCES = ['MERCHANDISING', 'PRODUCTION', 'QA', 'BUYER', 'OTHER'];
export const SAMPLE_TYPES = ['FABRIC_SWATCH', 'CUT_PANEL', 'GARMENT', 'TRIM', 'WASHED_GARMENT', 'CONTROL'];
export const SAMPLE_UOMS = ['PCS', 'KG', 'MTR', 'SWATCH'];
export const TRIAL_TYPES = ['INITIAL', 'RECIPE_REVISION', 'RETEST', 'CONFIRMATION', 'BUYER_REPEAT'];
export const DOSAGE_UOMS = [['G_L', 'g/l'], ['ML_L', 'ml/l'], ['PCT_OWG', '% owg'], ['G', 'g'], ['ML', 'ml'], ['KG', 'kg'], ['L', 'L']] as const;
export const DRYING = ['TUMBLE', 'LINE', 'FLAT', 'DRIP', 'NONE'];
export const ATTACHMENT_TYPES = ['BUYER_PROTOCOL', 'SAMPLE_PHOTO', 'BEFORE_PHOTO', 'AFTER_PHOTO', 'EVIDENCE', 'CERTIFICATE', 'OTHER'];
export const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: label(x) }));

/* ---------------------------------------------------------------- reason popup */
export function ReasonModal({ open, title, subtitle, confirm = 'Confirm', danger, minLength = 3, onClose, onSubmit, children, id }: {
  open: boolean; title: string; subtitle?: ReactNode; confirm?: string; danger?: boolean; minLength?: number; id?: string;
  onClose: () => void; onSubmit: (reason: string) => Promise<unknown> | void; children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const close = () => { setReason(''); setErr(''); onClose(); };
  const go = async () => {
    if (reason.trim().length < minLength) { setErr(`Give a reason (${minLength}+ characters)`); return; }
    setBusy(true); setErr('');
    try { await onSubmit(reason.trim()); setReason(''); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={close} title={title} subtitle={subtitle} size="sm"
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button>
        <Button id={id} variant={danger ? 'danger' : 'primary'} loading={busy} onClick={() => void go()}>{confirm}</Button></>}>
      {children}
      <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} error={err || undefined} />
    </Modal>
  );
}

/* ---------------------------------------------------------------- blobs (PDF / Excel) with the app's auth */
export async function fetchBlob(url: string, params?: Record<string, unknown>) {
  const r = await api.get<Blob>(url, { params, responseType: 'blob', timeout: 90_000, validateStatus: (s) => s !== 401 && s < 500 });
  if (r.status !== 200) {
    let msg = `Download failed (HTTP ${r.status})`;
    try { msg = JSON.parse(await (r.data as Blob).text())?.error?.message ?? msg; } catch { /* not JSON */ }
    throw new ApiError(r.status, 'DOWNLOAD_FAILED', msg);
  }
  const cd = String(r.headers['content-disposition'] ?? '');
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] ?? /filename="([^"]+)"/.exec(cd)?.[1] ?? 'file');
  return { blob: r.data as Blob, name };
}
export async function openBlob(url: string, params?: Record<string, unknown>) {
  const w = window.open('', '_blank');
  const { blob } = await fetchBlob(url, params);
  const u = URL.createObjectURL(blob);
  if (w) w.location.href = u; else window.location.href = u;
  setTimeout(() => URL.revokeObjectURL(u), 60_000);
}
export async function saveBlob(url: string, params?: Record<string, unknown>) {
  const { blob, name } = await fetchBlob(url, params);
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 30_000);
}

/* ---------------------------------------------------------------- private upload (POST /lab/attachments) */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}
export async function uploadLabFile(file: File, target: { request_id?: number; sample_id?: number; trial_id?: number; parameter_id?: number | null; attachment_type: string; caption?: string | null }) {
  if (file.size > 10 * 1024 * 1024) throw new Error('File is larger than 10 MB');
  const data = await readAsDataUrl(file);
  return (await http.post<{ data: { id: number } }>('/lab/attachments', { ...target, filename: file.name, data })).data;
}
export function FilePick({ onPick, label: text = 'Attach file', id, accept = '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx,.csv,.txt', disabled }: {
  onPick: (f: File) => void; label?: string; id?: string; accept?: string; disabled?: boolean;
}) {
  return (
    <label className={clsx('btn-secondary cursor-pointer', disabled && 'pointer-events-none opacity-60')}>
      <input id={id} type="file" className="hidden" accept={accept} disabled={disabled}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
      {text}
    </label>
  );
}
export function AttachmentList({ rows, onRemove }: { rows: any[]; onRemove?: (a: any) => void }) {
  if (!rows?.length) return <p className="px-1 py-2 text-small text-ink-muted">No files</p>;
  return (
    <ul className="divide-y divide-surface-divider">
      {rows.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-2 py-1.5 text-small">
          <Badge tone="slate">{label(a.attachment_type)}</Badge>
          <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => void openBlob(`/lab/attachments/${a.id}/file`, { inline: 1 })}>{a.original_name}</button>
          {a.caption && <span className="text-ink-secondary">{a.caption}</span>}
          {onRemove && <button type="button" className="ml-auto text-caption text-red-600 hover:underline" onClick={() => onRemove(a)}>Remove</button>}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- lookups */
export interface LabJob { id: number; so_no: string; io_no: string | null; job_no: string; buyer_po_no: string | null; buyer_id: number | null; buyer_name: string | null;
  styles: { style_id: number; style_code: string; style_name: string }[]; label: string }
export function useLabJobs() {
  return useQuery({ queryKey: ['lab-jobs'], queryFn: async () => (await http.get<{ data: LabJob[] }>('/lab/jobs')).data, staleTime: 60_000 });
}
export function useLabOptions() {
  return useQuery({ queryKey: ['lab-form-options'], queryFn: async () => (await http.get<{ data: any }>('/lab/form-options')).data, staleTime: 60_000 });
}
export function useLabUsers(perm = 'LAB.UPDATE') {
  return useQuery({ queryKey: ['lab-users', perm], queryFn: async () => (await http.get<{ data: { id: number; label: string; code: string }[] }>('/lab/users', { perm })).data, staleTime: 60_000 });
}

/* ---------------------------------------------------------------- small display helpers */
export function Kpi({ label: l, value, tone = 'blue', onClick, id }: { label: string; value: ReactNode; tone?: 'blue' | 'amber' | 'red' | 'green' | 'violet' | 'indigo' | 'gray'; onClick?: () => void; id?: string }) {
  const bar = { blue: 'bg-brand-500', amber: 'bg-amber-500', red: 'bg-red-500', green: 'bg-emerald-500', violet: 'bg-violet-500', indigo: 'bg-indigo-500', gray: 'bg-surface-border' }[tone];
  return (
    <button type="button" id={id} onClick={onClick} disabled={!onClick}
      className="card relative overflow-hidden p-3 text-left transition-shadow hover:shadow-md disabled:cursor-default disabled:hover:shadow-none">
      <span className={clsx('absolute inset-y-0 left-0 w-1', bar)} />
      <p className="text-small font-medium text-ink-secondary">{l}</p>
      <p className="mt-1 text-page font-semibold tabular-nums text-ink-heading">{value}</p>
    </button>
  );
}
export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-caption text-ink-muted">{k}</p>
      <p className="truncate text-body text-ink">{v === null || v === undefined || v === '' ? '—' : v}</p>
    </div>
  );
}
export const num = (v: unknown, dp = 2) => (v == null || v === '' ? '' : String(Number(Number(v).toFixed(dp))));
export function criteriaText(p: any) {
  if (p.pass_values) return `Pass: ${p.pass_values}`;
  const has = (x: unknown) => x !== null && x !== undefined && x !== '';
  if (!has(p.min_value) && !has(p.max_value) && has(p.target_value) && has(p.tolerance)) return `${num(p.target_value, 4)} ± ${num(p.tolerance, 4)}`;
  const lo = has(p.min_value) ? num(p.min_value, 4) : null; const hi = has(p.max_value) ? num(p.max_value, 4) : null;
  return lo && hi ? `${lo} to ${hi}` : lo ? `≥ ${lo}` : hi ? `≤ ${hi}` : 'Report only';
}
export const newKey = () => `lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
