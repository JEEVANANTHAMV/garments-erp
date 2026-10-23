import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Badge, Modal, Textarea, Button } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { fmtMoney } from '../../lib/format';

/**
 * Shared bits of the sample module (client 23-Oct-2026, "Sample-to-Order Profitability" spec): status labels, the
 * money / N/A display of the spec §9 figures, KPI tiles, a bar list for the dashboard and the reason popup.
 */

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', IN_PROGRESS: 'In progress', ON_HOLD: 'On hold',
  PENDING_INTERNAL_APPROVAL: 'Pending internal approval', INTERNALLY_APPROVED: 'Ready to submit',
  SUBMITTED_TO_BUYER: 'With buyer', REVISION_REQUIRED: 'Revision required', APPROVED: 'Buyer approved',
  REJECTED: 'Rejected', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};
const STATUS_TONE: Record<string, string> = {
  DRAFT: 'slate', SUBMITTED: 'blue', IN_PROGRESS: 'blue', ON_HOLD: 'amber', PENDING_INTERNAL_APPROVAL: 'violet',
  INTERNALLY_APPROVED: 'indigo', SUBMITTED_TO_BUYER: 'indigo', REVISION_REQUIRED: 'amber', APPROVED: 'green',
  REJECTED: 'red', COMPLETED: 'green', CANCELLED: 'slate',
};
export const SAMPLE_STATUSES = Object.keys(STATUS_LABEL);
export function SampleStatus({ value }: { value?: string | null }) {
  if (!value) return <span className="text-slate-400">—</span>;
  return <Badge tone={STATUS_TONE[value] ?? 'slate'}>{STATUS_LABEL[value] ?? value}</Badge>;
}

export const PROC_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started', IN_PROGRESS: 'In progress', ON_HOLD: 'On hold', COMPLETED: 'Completed', SKIPPED: 'Skipped', CANCELLED: 'Cancelled',
};
const PROC_TONE: Record<string, string> = { NOT_STARTED: 'slate', IN_PROGRESS: 'blue', ON_HOLD: 'amber', COMPLETED: 'green', SKIPPED: 'gray', CANCELLED: 'slate' };
export function ProcStatus({ value, ready }: { value: string; ready?: boolean }) {
  if (value === 'NOT_STARTED' && ready) return <Badge tone="emerald">Ready</Badge>;
  return <Badge tone={PROC_TONE[value] ?? 'slate'}>{PROC_LABEL[value] ?? value}</Badge>;
}

export const COST_STATUS_TONE: Record<string, string> = { DRAFT: 'slate', SUBMITTED: 'amber', APPROVED: 'blue', POSTED: 'green', REVERSED: 'gray', REJECTED: 'red' };
export const ALLOC_STATUS_TONE: Record<string, string> = {
  DRAFT: 'slate', PENDING_APPROVAL: 'amber', APPROVED: 'blue', POSTED: 'green', PARTIALLY_REVERSED: 'violet', REVERSED: 'gray', REJECTED: 'red', CANCELLED: 'slate',
};
export const ALLOC_STATE: Record<string, [string, string]> = {
  NO_COST: ['No posted cost', 'slate'], ELIGIBLE: ['Not allocated', 'amber'], PARTIAL: ['Partly allocated', 'blue'],
  FULL: ['Fully allocated', 'green'], EXCEPTION: ['Exception', 'red'],
};
export function AllocState({ value }: { value?: string }) {
  const [l, t] = ALLOC_STATE[value ?? ''] ?? ['—', 'slate'];
  return <Badge tone={t}>{l}</Badge>;
}

export const COST_CATEGORIES: { value: string; label: string; hint: string }[] = [
  { value: 'MATERIAL', label: 'Material', hint: 'Fabric / trims issued or bought for the sample' },
  { value: 'LABOUR', label: 'Labour', hint: 'Actual minutes × approved rate, or a fixed operation rate' },
  { value: 'CAD_PATTERN', label: 'CAD / pattern', hint: 'Pattern, marker, grading time' },
  { value: 'SUBCONTRACT', label: 'Subcontract / special process', hint: 'Embroidery, printing, washing … done outside' },
  { value: 'CONSUMABLE', label: 'Consumables', hint: 'Thread, needles, chemicals' },
  { value: 'COURIER', label: 'Courier / dispatch', hint: 'Sending the sample to the buyer' },
  { value: 'REWORK', label: 'Rework / rejection', hint: 'Cost of redoing a stage after QC' },
  { value: 'OVERHEAD', label: 'Overhead (allocated)', hint: 'Allocated by the approved rule — not a direct actual cost' },
  { value: 'ADJUSTMENT', label: 'Adjustment', hint: 'Any other approved cost; can be negative' },
];
export const catLabel = (v: string) => COST_CATEGORIES.find((c) => c.value === v)?.label ?? v;

export const ALLOC_METHODS = [
  { value: 'PERCENT', label: 'Percentage', hint: 'Each order takes a % of the balance (total ≤ 100%)' },
  { value: 'QUANTITY', label: 'Order quantity', hint: 'Split by the order quantity of this style on each order' },
  { value: 'VALUE', label: 'Order value', hint: 'Split by the order value (INR) of this style on each order' },
  { value: 'EQUAL', label: 'Equal split', hint: 'Same amount to every order' },
  { value: 'MANUAL', label: 'Manual amount', hint: 'Type the amount of each order' },
];

/** ₹ amount, or N/A when the figure is not defined (zero divisor — spec §9). */
export const inr = (v: unknown, na = 'N/A') => (v == null || v === '' ? na : `₹ ${fmtMoney(v)}`);

export const errMsg = (e: unknown, fallback = 'Something went wrong') => {
  if (e instanceof ApiError) {
    const fe = Object.values(e.fieldErrors);
    return fe.length && e.code === 'VALIDATION_ERROR' ? fe.join(' · ') : e.message;
  }
  return fallback;
};

export function Kpi({ label, value, sub, tone = 'slate', onClick, id }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; onClick?: () => void; id?: string }) {
  const bar: Record<string, string> = { slate: 'bg-slate-300', blue: 'bg-sky-500', amber: 'bg-amber-500', red: 'bg-red-500', green: 'bg-emerald-500', violet: 'bg-violet-500', indigo: 'bg-indigo-500' };
  return (
    <button type="button" id={id} onClick={onClick} disabled={!onClick}
      className={clsx('card relative overflow-hidden p-3.5 text-left transition', onClick && 'hover:border-brand-300 hover:shadow-md cursor-pointer')}>
      <span className={clsx('absolute inset-y-0 left-0 w-1', bar[tone] ?? bar.slate)} />
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-[22px] font-bold tracking-tight text-slate-900">{value}</p>
      {sub && <p className="text-[11.5px] text-slate-500">{sub}</p>}
    </button>
  );
}

/** Horizontal bars (dashboard distributions). Text values are shown next to each bar. */
export function BarList({ rows, money, onClick, empty = 'Nothing to show' }: { rows: { label: string; value: number }[]; money?: boolean; onClick?: (label: string) => void; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  if (!rows.length) return <p className="py-6 text-center text-[12px] text-slate-400">{empty}</p>;
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <button key={r.label} type="button" disabled={!onClick} onClick={() => onClick?.(r.label)}
          className={clsx('grid w-full grid-cols-[minmax(90px,38%)_1fr_auto] items-center gap-2 text-left text-[12px]', onClick && 'hover:opacity-80')}>
          <span className="truncate text-slate-600" title={r.label}>{r.label}</span>
          <span className="h-2.5 rounded-full bg-slate-100"><span className="block h-2.5 rounded-full bg-brand-500" style={{ width: `${(Math.abs(r.value) / max) * 100}%` }} /></span>
          <span className="tabular-nums font-semibold text-slate-700">{money ? inr(r.value) : r.value}</span>
        </button>
      ))}
    </div>
  );
}

/** Popup asking for a (required) reason before an action. */
export function ReasonModal({ open, title, message, label = 'Reason', confirmLabel = 'Confirm', danger, busy, onClose, onConfirm, minLength = 3 }: {
  open: boolean; title: string; message?: ReactNode; label?: string; confirmLabel?: string; danger?: boolean; busy?: boolean; minLength?: number;
  onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const short = reason.trim().length < minLength;
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={short} id="reason-confirm" onClick={() => onConfirm(reason.trim())}>{confirmLabel}</Button>
      </>}>
      {message && <div className="mb-3 text-[13px] text-slate-600">{message}</div>}
      <Textarea label={label} required value={reason} id="reason-input" onChange={(e) => setReason(e.target.value)} autoFocus
        hint={short ? `At least ${minLength} characters` : undefined} />
    </Modal>
  );
}

export const daysLabel = (v: unknown) => (v == null ? '—' : `${v} d`);
