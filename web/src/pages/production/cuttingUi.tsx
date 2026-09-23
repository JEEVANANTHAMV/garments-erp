/**
 * Small shared widgets for the cutting screens (Fabric DC, Lay, Bundles,
 * Reconciliation): searchable dropdown, barcode scan input, status chips,
 * quantity-with-UOM display.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScanLine, ChevronDown, X } from 'lucide-react';
import clsx from 'clsx';
import { fmtNumber } from '../../lib/format';

export const errMsg = (e: any, fallback = 'Request failed') =>
  e?.message || e?.response?.data?.error?.message || fallback;

/* ------------------------------------------------------------ status chip */
const CHIP: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 ring-slate-200',
  APPROVED: 'bg-sky-100 text-sky-800 ring-sky-200',
  RELEASED: 'bg-indigo-100 text-indigo-800 ring-indigo-200',
  IN_PROGRESS: 'bg-amber-100 text-amber-800 ring-amber-200',
  PARTIALLY_COMPLETED: 'bg-orange-100 text-orange-800 ring-orange-200',
  COMPLETED: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  CLOSED: 'bg-zinc-200 text-zinc-800 ring-zinc-300',
  CANCELLED: 'bg-red-100 text-red-700 ring-red-200',
  VARIANCE_PENDING: 'bg-rose-100 text-rose-800 ring-rose-200',
  VARIANCE: 'bg-rose-100 text-rose-800 ring-rose-200',
  REOPENED: 'bg-violet-100 text-violet-800 ring-violet-200',
  PLANNED: 'bg-slate-100 text-slate-700 ring-slate-200',
  SPREAD: 'bg-sky-100 text-sky-800 ring-sky-200',
  CUT: 'bg-amber-100 text-amber-800 ring-amber-200',
  OPEN: 'bg-sky-100 text-sky-800 ring-sky-200',
  PARTIALLY_USED: 'bg-amber-100 text-amber-800 ring-amber-200',
  ISSUED: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  GENERATED: 'bg-slate-100 text-slate-700 ring-slate-200',
  REVERSED: 'bg-red-100 text-red-700 ring-red-200',
};
const LABEL: Record<string, string> = { IN_PROGRESS: 'In Cutting', VARIANCE_PENDING: 'Variance' };

export function StatusChip({ status }: { status?: string | null }) {
  const s = String(status ?? '').toUpperCase();
  if (!s) return <span className="text-slate-400">—</span>;
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
      CHIP[s] ?? 'bg-slate-100 text-slate-700 ring-slate-200')}>
      {LABEL[s] ?? s.replace(/_/g, ' ')}
    </span>
  );
}

/* ------------------------------------------------------------ qty + uom */
export function Qty({ v, uom, dp = 0, className }: { v: unknown; uom: string; dp?: number; className?: string }) {
  return (
    <span className={clsx('whitespace-nowrap tabular-nums', className)}>
      {fmtNumber(v, dp)} <span className="text-[10px] font-medium text-slate-400">{uom}</span>
    </span>
  );
}

/** Number input with the UOM shown inside the field. */
export function UomInput({ label, uom, value, onChange, step = 'any', min, disabled, className, hint }: {
  label?: string; uom: string; value: any; onChange: (v: string) => void; step?: string; min?: number;
  disabled?: boolean; className?: string; hint?: string;
}) {
  return (
    <div className={className}>
      {label && <label className="label">{label} <span className="text-slate-400">({uom})</span></label>}
      <div className="relative">
        <input type="number" className="input pr-12 text-right tabular-nums" value={value ?? ''} step={step} min={min}
          disabled={disabled} onChange={(e) => onChange(e.target.value)} />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-slate-400">{uom}</span>
      </div>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------ searchable select */
export interface SearchOption { value: string | number; label: string; sub?: ReactNode; right?: ReactNode; disabled?: boolean }

export function SearchSelect({ label, value, options, onChange, placeholder = 'Search…', className, required, disabled }: {
  label?: string; value: string | number | null | undefined; options: SearchOption[];
  onChange: (v: string) => void; placeholder?: string; className?: string; required?: boolean; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const selected = options.find((o) => String(o.value) === String(value ?? ''));
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? options.filter((o) => o.label.toLowerCase().includes(t)) : options).slice(0, 200);
  }, [q, options]);
  return (
    <div className={clsx('relative', className)} ref={box}>
      {label && <label className="label">{label}{required && <span className="ml-0.5 text-red-500">*</span>}</label>}
      <button type="button" disabled={disabled}
        className={clsx('input flex items-center justify-between text-left', disabled && 'opacity-60')}
        onClick={() => setOpen((o) => !o)}>
        <span className={clsx('truncate', !selected && 'text-slate-400')}>{selected?.label ?? placeholder}</span>
        <span className="flex items-center gap-1">
          {selected && !disabled && (
            <X size={14} className="text-slate-400 hover:text-slate-600"
              onClick={(e) => { e.stopPropagation(); onChange(''); }} />
          )}
          <ChevronDown size={14} className="text-slate-400" />
        </span>
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-[260px] rounded-lg border border-slate-200 bg-white shadow-lg">
          <input autoFocus className="input rounded-b-none border-0 border-b" placeholder="Type to search…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No matches</p>}
            {filtered.map((o) => (
              <button key={o.value} type="button" disabled={o.disabled}
                className={clsx('flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[13px] hover:bg-slate-50',
                  String(o.value) === String(value ?? '') && 'bg-brand-50', o.disabled && 'cursor-not-allowed opacity-50')}
                onClick={() => { onChange(String(o.value)); setOpen(false); setQ(''); }}>
                <span className="min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.sub && <span className="block truncate text-[11px] text-slate-400">{o.sub}</span>}
                </span>
                {o.right && <span className="shrink-0 text-[11px] font-semibold text-slate-600">{o.right}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- barcode input */
/** Scanner-friendly input: scanners type the code and send Enter. */
export function ScanInput({ onScan, placeholder = 'Scan barcode / type code and press Enter', label, className }: {
  onScan: (code: string) => void; placeholder?: string; label?: string; className?: string;
}) {
  const [v, setV] = useState('');
  return (
    <div className={className}>
      {label && <label className="label">{label}</label>}
      <div className="relative">
        <ScanLine size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input className="input pl-9 font-mono" value={v} placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const code = v.trim();
              if (code) onScan(code);
              setV('');
            }
          }} />
      </div>
    </div>
  );
}

/** Label used everywhere a bundle's fabric KG is shown (doc §12). */
export const ALLOCATED_KG_LABEL = 'Allocated / Calculated fabric KG (not physical weight)';

/** Planned vs actual metric tile. */
export function MetricTile({ label, value, uom, tone = 'slate', sub }: {
  label: string; value: ReactNode; uom?: string; tone?: 'slate' | 'emerald' | 'amber' | 'red' | 'indigo'; sub?: ReactNode;
}) {
  const t = {
    slate: 'border-slate-200 bg-white', emerald: 'border-emerald-200 bg-emerald-50', amber: 'border-amber-200 bg-amber-50',
    red: 'border-red-200 bg-red-50', indigo: 'border-indigo-200 bg-indigo-50',
  }[tone];
  return (
    <div className={clsx('rounded-lg border px-3 py-2', t)}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums text-slate-900">
        {value} {uom && <span className="text-xs font-semibold text-slate-400">{uom}</span>}
      </p>
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}
