import { useMemo, useRef, useState } from 'react';
import type { LookupItem } from '../../hooks/useLookup';

/**
 * Searchable fabric picker backed by the fabric master (`/lookups/fabrics`).
 * Used by the Pre-Costing and Classic Costing sheets so fabric names always
 * come from `mst_fabric` instead of being typed free-hand. Rows saved before
 * this picker existed may carry a name that is not in the master — that name
 * is still shown, flagged "not in master", until the user picks a master row.
 */
export function FabricPicker({
  fabricId, fabricName, options, onPick, disabled, className,
}: {
  fabricId?: string | number | null;
  fabricName?: string;
  options?: LookupItem[];
  onPick: (item: LookupItem) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = options ?? [];
  const selected = all.find((o) => String(o.id) === String(fabricId ?? ''));
  const display = fabricName || selected?.label || '';
  const inMaster = !!selected;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? all.filter((o) => `${o.code ?? ''} ${o.label}`.toLowerCase().includes(q))
      : all;
    return list.slice(0, 50);
  }, [all, query]);

  const pick = (item: LookupItem) => {
    onPick(item);
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  };

  return (
    <div className={`relative ${className ?? ''}`}>
      <input
        ref={inputRef}
        type="text"
        disabled={disabled}
        value={open ? query : display}
        placeholder={open ? (display || 'Search fabric master…') : 'Select fabric from master…'}
        onFocus={() => { setOpen(true); setQuery(''); setHi(0); }}
        onBlur={() => { setTimeout(() => setOpen(false), 150); }}
        onChange={(e) => { setQuery(e.target.value); setHi(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); if (matches[hi]) pick(matches[hi]); }
          else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); }
        }}
        className={`input py-1 px-1.5 text-xs w-full font-sans ${display && !inMaster ? 'border-amber-300 bg-amber-50/60' : ''}`}
        title={display && !inMaster ? 'Not in fabric master — pick a master fabric' : display}
      />
      {display && !inMaster && !open && (
        <span className="absolute -bottom-3.5 left-0 text-[10px] font-semibold text-amber-700 whitespace-nowrap">
          not in master
        </span>
      )}
      {open && !disabled && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full min-w-[240px] overflow-auto rounded-md border border-slate-200 bg-white py-1 text-xs shadow-lg">
          {matches.length === 0 && (
            <li className="px-2.5 py-1.5 text-slate-400">No fabric in master matches “{query}”</li>
          )}
          {matches.map((o, i) => (
            <li
              key={o.id}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setHi(i)}
              className={`cursor-pointer px-2.5 py-1.5 ${i === hi ? 'bg-brand-50 text-brand-900' : 'text-slate-700'}`}
            >
              {o.code && <span className="font-mono text-[11px] text-slate-400 mr-1.5">{String(o.code)}</span>}
              <span className="font-semibold">{o.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
