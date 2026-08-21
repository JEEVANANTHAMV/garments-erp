import {
  type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes,
  type TextareaHTMLAttributes, forwardRef, useEffect, useState,
} from 'react';
import { AlertCircle, Loader2, X, Search, Inbox, ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';

/* ------------------------------------------------------------------ Page */
export function PageHeader({ title, subtitle, actions, breadcrumb }: {
  title: string; subtitle?: string; actions?: ReactNode; breadcrumb?: string[];
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb?.length ? (
          <nav className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-400">
            {breadcrumb.map((b, i) => (
              <span key={i} className="flex items-center gap-1.5">
                {i > 0 && <span>/</span>}<span>{b}</span>
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="truncate text-[22px] font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ----------------------------------------------------------- Form fields */
interface FieldProps { label?: string; error?: string; required?: boolean; hint?: string; className?: string; }

export function Field({ label, error, required, hint, children, className }: FieldProps & { children: ReactNode }) {
  return (
    <div className={className}>
      {label && (
        <label className="label">
          {label}{required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
      {error && <p className="help-error">{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldProps>(
  ({ label, error, required, hint, className, ...rest }, ref) => (
    <Field label={label} error={error} required={required} hint={hint} className={className}>
      <input ref={ref} className={clsx('input', error && 'input-error')} {...rest} />
    </Field>
  ));
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & FieldProps & { options?: { value: string | number; label: string }[]; placeholder?: string }>(
  ({ label, error, required, hint, className, options, placeholder, children, ...rest }, ref) => (
    <Field label={label} error={error} required={required} hint={hint} className={className}>
      <select ref={ref} className={clsx('input appearance-none bg-no-repeat pr-8', error && 'input-error')}
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundPosition: 'right 0.6rem center',
        }} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {children}
      </select>
    </Field>
  ));
Select.displayName = 'Select';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps>(
  ({ label, error, required, hint, className, ...rest }, ref) => (
    <Field label={label} error={error} required={required} hint={hint} className={className}>
      <textarea ref={ref} rows={3} className={clsx('input resize-y', error && 'input-error')} {...rest} />
    </Field>
  ));
Textarea.displayName = 'Textarea';

export function Checkbox({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className={clsx('flex cursor-pointer select-none items-center gap-2 text-[13px] text-slate-700',
      disabled && 'cursor-not-allowed opacity-60')}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30" />
      {label}
    </label>
  );
}

/* ---------------------------------------------------------------- Badges */
const TONE: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-100 text-emerald-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-blue-100 text-blue-700',
  violet: 'bg-violet-100 text-violet-700',
};

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: keyof typeof TONE | string }) {
  return <span className={clsx('badge', TONE[tone] ?? TONE.slate)}>{children}</span>;
}

/** Maps common ERP state words onto a colour tone. */
export function StatusBadge({ value }: { value: unknown }) {
  const v = String(value ?? '').toUpperCase();
  if (!v) return <span className="text-slate-400">—</span>;
  const tone =
    /APPROVED|PASS|COMPLETED|DELIVERED|CREDITED|DONE|ACTIVE|REALIZED|ISSUED|POSTED|ACCEPTED/.test(v) ? 'green' :
    /PENDING|DRAFT|IN_REVIEW|ON_TRACK|BOOKED|REQUESTED|CLAIMED|NEW/.test(v) ? 'amber' :
    /REJECTED|FAIL|CANCELLED|DELAYED|LOST|ON_HOLD/.test(v) ? 'red' :
    /IN_PROGRESS|IN_PRODUCTION|SAILED|TRANSIT|PARTIAL|SUBMITTED|QUOTED|NEGOTIATION/.test(v) ? 'blue' :
    /CLOSED|OBSOLETE|DISCONTINUED|EXPIRED/.test(v) ? 'slate' : 'violet';
  return <Badge tone={tone}>{v.replace(/_/g, ' ')}</Badge>;
}

/* --------------------------------------------------------------- States */
export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={clsx('animate-spin', className)} />;
}

export function LoadingBlock({ label = 'Loading…', rows = 5 }: { label?: string; rows?: number }) {
  return (
    <div className="p-4" aria-busy="true" aria-label={label}>
      <div className="space-y-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton h-9" style={{ opacity: 1 - i * 0.12 }} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, message, action, icon }: {
  title: string; message?: string; action?: ReactNode; icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 rounded-full bg-slate-100 p-3.5 text-slate-400">{icon ?? <Inbox size={24} />}</div>
      <h3 className="text-[15px] font-semibold text-slate-800">{title}</h3>
      {message && <p className="mt-1 max-w-md text-[13px] text-slate-500">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 rounded-full bg-red-50 p-3.5 text-red-500"><AlertCircle size={24} /></div>
      <h3 className="text-[15px] font-semibold text-slate-800">Unable to load this data</h3>
      <p className="mt-1 max-w-md text-[13px] text-slate-500">{message}</p>
      {onRetry && <button onClick={onRetry} className="btn-secondary mt-4">Try again</button>}
    </div>
  );
}

/* ---------------------------------------------------------------- Modal */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode;
  footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);

  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl', full: 'max-w-[95vw]' }[size];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={clsx('animate-fade-in my-6 w-full rounded-xl bg-white shadow-popover', width)}
        role="dialog" aria-modal="true" aria-label={title}>
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-surface-hover hover:text-slate-600"
            aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[calc(100vh-14rem)] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-surface-border bg-surface-muted/60 px-5 py-3 rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', onConfirm, onCancel, busy }: {
  open: boolean; title: string; message: string; confirmLabel?: string;
  onConfirm: () => void; onCancel: () => void; busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} size="sm"
      footer={<>
        <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-danger" onClick={onConfirm} disabled={busy}>
          {busy && <Spinner size={14} />}{confirmLabel}
        </button>
      </>}>
      <p className="text-[13px] leading-relaxed text-slate-600">{message}</p>
    </Modal>
  );
}

/* ------------------------------------------------------------ Search box */
export function SearchInput({ value, onChange, placeholder = 'Search…', className }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  return (
    <div className={clsx('relative', className)}>
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="input pl-9" />
      {value && (
        <button onClick={() => onChange('')} aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Debounces keystrokes so list queries don't fire on every character. */
export function useDebounced<T>(value: T, delay = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/* ------------------------------------------------------------ Pagination */
export function Pager({ page, totalPages, total, pageSize, onPage }: {
  page: number; totalPages: number; total: number; pageSize: number; onPage: (p: number) => void;
}) {
  if (!total) return null;   // guard against undefined / 0 / NaN
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-border px-3.5 py-2.5">
      <p className="text-xs text-slate-500">
        Showing <span className="font-medium text-slate-700">{from}–{to}</span> of{' '}
        <span className="font-medium text-slate-700">{total.toLocaleString('en-IN')}</span>
      </p>
      <div className="flex items-center gap-1">
        <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft size={14} /> Prev
        </button>
        <span className="px-2 text-xs text-slate-600">Page {page} of {Math.max(totalPages, 1)}</span>
        <button className="btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Tabs */
export function Tabs({ tabs, active, onChange }: {
  tabs: { key: string; label: string; count?: number }[];
  active: string; onChange: (k: string) => void;
}) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-surface-border">
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)}
          className={clsx('relative whitespace-nowrap px-3.5 py-2.5 text-[13px] font-medium transition-colors',
            active === t.key ? 'text-brand-700' : 'text-slate-500 hover:text-slate-800')}>
          {t.label}
          {t.count !== undefined && (
            <span className={clsx('ml-1.5 rounded-full px-1.5 py-0.5 text-[10px]',
              active === t.key ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500')}>
              {t.count}
            </span>
          )}
          {active === t.key && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-brand-600" />}
        </button>
      ))}
    </div>
  );
}
