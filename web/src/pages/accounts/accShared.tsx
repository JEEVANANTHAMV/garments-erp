/**
 * Accounts module — shared helpers (client spec "Complete Accounts & TallyPrime", 09-Nov-2026).
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Modal, Textarea, Field, Input } from '../../components/ui';
import { http, api, ApiError } from '../../lib/api';

export const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong');

/** ₹ 1,23,456.78 (en-IN), blank for zero when `blankZero`. */
export function inr(v: unknown, blankZero = false) {
  const n = Number(v ?? 0);
  if (blankZero && !n) return '';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** Balance with Dr / Cr suffix (Dr positive). */
export function drcr(v: unknown) {
  const n = Number(v ?? 0);
  if (Math.abs(n) < 0.005) return '0.00';
  return `${inr(Math.abs(n))} ${n > 0 ? 'Dr' : 'Cr'}`;
}

export const VOUCHER_TYPE_LABEL: Record<string, string> = {
  JOURNAL: 'Journal', PAYMENT: 'Payment', RECEIPT: 'Receipt', CONTRA: 'Contra', SALES: 'Sales', PURCHASE: 'Purchase',
  DEBIT_NOTE: 'Debit Note', CREDIT_NOTE: 'Credit Note',
};
export const VOUCHER_TYPES = Object.keys(VOUCHER_TYPE_LABEL);

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'slate', PENDING_APPROVAL: 'amber', POSTED: 'green', REJECTED: 'red', CANCELLED: 'slate', REVERSED: 'violet',
};
const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Pending approval', POSTED: 'Posted', REJECTED: 'Rejected', CANCELLED: 'Cancelled', REVERSED: 'Reversed',
};
export function VoucherStatus({ value }: { value?: string | null }) {
  if (!value) return null;
  return <Badge tone={STATUS_TONE[value] ?? 'slate'}>{STATUS_LABEL[value] ?? value}</Badge>;
}
const TALLY_TONE: Record<string, string> = {
  NOT_SENT: 'slate', PENDING: 'amber', PROCESSING: 'blue', POSTED: 'green', FAILED: 'red', UNKNOWN: 'red', RECONCILED: 'green', SKIPPED: 'slate',
};
const TALLY_LABEL: Record<string, string> = {
  NOT_SENT: 'Not sent', PENDING: 'Tally pending', PROCESSING: 'Sent to Tally', POSTED: 'In Tally', FAILED: 'Tally failed', UNKNOWN: 'Tally unknown',
  RECONCILED: 'Reconciled', SKIPPED: 'Skipped',
};
export function TallyStatus({ value }: { value?: string | null }) {
  if (!value || value === 'NOT_SENT') return <span className="text-caption text-ink-secondary">—</span>;
  return <Badge tone={TALLY_TONE[value] ?? 'slate'}>{TALLY_LABEL[value] ?? value}</Badge>;
}

export const SOURCE_LABEL: Record<string, string> = {
  SUPPLIER_BILL: 'Bills Inward', KNITTING_BILL: 'Knitting bill', FABRIC_PROCESS_BILL: 'Fabric process bill', YARN_PROCESS_BILL: 'Yarn process bill',
  CONTRACTOR_BILL: 'Contractor bill', CONTRACTOR_PAYMENT: 'Contractor payment', CONTRACTOR_ADVANCE: 'Contractor advance', CONTRACTOR_CREDIT_NOTE: 'Contractor credit note',
  PURCHASE_CREDIT_NOTE: 'Purchase return', COMMERCIAL_INVOICE: 'Commercial invoice', REALISATION: 'Bank realisation', EXPORT_BENEFIT: 'Export incentive',
};

export interface LedgerOption { id: number; label: string; code: string; ledger_type: string; is_bill_wise: number; party_id: number | null; group_name: string; nature: string }
export function useLedgerOptions() {
  return useQuery({
    queryKey: ['accounts', 'ledger-options'],
    queryFn: async () => (await http.get<{ data: LedgerOption[] }>('/accounts/ledger-options')).data,
    staleTime: 60_000,
  });
}

/** Ledger picker (native select → upgraded to type-to-search by the global SelectSearch). */
export function LedgerSelect({ value, onChange, options, id, placeholder = 'Pick a ledger', filter }: {
  value: number | null | undefined; onChange: (id: number | null) => void; options: LedgerOption[]; id?: string; placeholder?: string;
  filter?: (l: LedgerOption) => boolean;
}) {
  const list = filter ? options.filter(filter) : options;
  return (
    <select id={id} className="input w-full" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{placeholder}</option>
      {list.map((l) => <option key={l.id} value={l.id}>{l.label} · {l.group_name}</option>)}
    </select>
  );
}

/** Ask for a reason (reject / cancel / reverse). */
export function ReasonModal({ open, title, label = 'Reason', confirm, busy, onClose, onSubmit, withDate }: {
  open: boolean; title: string; label?: string; confirm: string; busy?: boolean; onClose: () => void;
  onSubmit: (reason: string, date?: string) => void; withDate?: string;
}) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(withDate ?? '');
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button id="acc-reason-ok" variant="danger" loading={busy} disabled={reason.trim().length < 5} onClick={() => onSubmit(reason.trim(), date || undefined)}>{confirm}</Button>
      </>}>
      <div className="space-y-3">
        <Field label={label} required hint="At least 5 characters — kept in the audit trail">
          <Textarea id="acc-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {withDate !== undefined && (
          <Field label="Reversal date" hint="Blank = the original voucher date">
            <Input id="acc-reason-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function Kpi({ label, value, hint, tone, onClick, id }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'amber' | 'red' | 'green'; onClick?: () => void; id?: string }) {
  const color = tone === 'red' ? 'text-status-error-text' : tone === 'amber' ? 'text-status-pending-label' : tone === 'green' ? 'text-status-success-text' : 'text-ink';
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag id={id} type={onClick ? 'button' : undefined} onClick={onClick}
      className={`card px-4 py-3 text-left ${onClick ? 'transition hover:border-brand-500' : ''}`}>
      <p className="text-caption text-ink-secondary">{label}</p>
      <p className={`text-title font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="text-caption text-ink-secondary">{hint}</p>}
    </Tag>
  );
}

/** POST that returns a file (XML export). */
export async function postDownload(url: string, body: unknown, fallbackName: string) {
  const r = await api.post(url, body, { responseType: 'blob' });
  const cd = String(r.headers['content-disposition'] ?? '');
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const href = URL.createObjectURL(r.data as Blob);
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

export function todayIst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
export function fyStart(d = todayIst()) {
  const [y, m] = d.split('-').map(Number);
  return `${m >= 4 ? y : y - 1}-04-01`;
}

/** File → base64 (no data: prefix) for JSON uploads. */
export function fileToBase64(f: File): Promise<string> {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => bad(r.error);
    r.readAsDataURL(f);
  });
}

/** GET that returns a file (template download). */
export async function getDownload(url: string, fallbackName: string) {
  const r = await api.get(url, { responseType: 'blob' });
  const cd = String(r.headers['content-disposition'] ?? '');
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const href = URL.createObjectURL(r.data as Blob);
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}
