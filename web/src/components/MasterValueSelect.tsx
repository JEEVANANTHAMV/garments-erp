import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useToast } from '../hooks/useToast';

/**
 * Pick-or-create field for the fabric / yarn masters (client voice note 05-Oct-2026): fibre name, fabric type,
 * construction, structure, effect, yarn type and yarn construction come from a master list the user grows from the
 * screen ("+ Add" a value that is not there), instead of a fixed list.
 */
export type MasterAttr = 'FIBRE' | 'FABRIC_TYPE' | 'KNIT_STRUCTURE' | 'STRUCTURE' | 'EFFECT' | 'YARN_TYPE' | 'YARN_CONSTRUCTION';

export function useMasterValues(type: MasterAttr) {
  return useQuery({
    queryKey: ['material-attrs', type],
    queryFn: async () => ((await api.get('/material-attrs', { params: { attr_type: type, pageSize: 200, sort: 'sort_order', dir: 'asc' } })).data.data ?? []) as { id: number; attr_value: string }[],
    staleTime: 60_000,
  });
}

export function MasterValueSelect({ type, label, value, onChange, disabled, id, className = '', compact }: {
  type: MasterAttr; label?: string; value: string | null | undefined; onChange: (v: string) => void;
  disabled?: boolean; id?: string; className?: string; compact?: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data = [], isLoading } = useMasterValues(type);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const options = useMemo(() => {
    const vals = data.map((d) => d.attr_value);
    if (value && !vals.some((v) => v.toUpperCase() === String(value).toUpperCase())) vals.unshift(String(value));
    return vals;
  }, [data, value]);

  const create = async () => {
    const v = draft.trim();
    if (!v) return;
    const existing = data.find((d) => d.attr_value.toUpperCase() === v.toUpperCase());
    if (existing) { onChange(existing.attr_value); setAdding(false); setDraft(''); return; }
    try {
      await api.post('/material-attrs', { attr_type: type, attr_value: v, sort_order: 500, is_active: true });
      await qc.invalidateQueries({ queryKey: ['material-attrs', type] });
      onChange(v); setAdding(false); setDraft('');
      toast(`"${v}" added to the master`);
    } catch (e: any) { toast(e?.message || 'Could not add the value', 'error'); }
  };

  const input = compact ? 'input py-1 px-2 text-xs' : 'input';
  return (
    <div className={className}>
      {label && <span className="label">{label}</span>}
      {adding ? (
        <div className="flex gap-1">
          <input autoFocus className={`${input} flex-1`} value={draft} id={id ? `${id}-new` : undefined} placeholder="Type the new value"
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } if (e.key === 'Escape') setAdding(false); }} />
          <button type="button" className="rounded bg-brand-600 px-2 text-xs font-semibold text-white" id={id ? `${id}-save` : undefined} onClick={() => void create()}>Add</button>
          <button type="button" className="rounded border px-2 text-xs" onClick={() => setAdding(false)}>✕</button>
        </div>
      ) : (
        <select className={`${input} w-full`} id={id} disabled={disabled} value={value ?? ''}
          onChange={(e) => { if (e.target.value === '__add__') { setAdding(true); setDraft(''); } else onChange(e.target.value); }}>
          <option value="">{isLoading ? 'Loading…' : '— Select —'}</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
          {!disabled && <option value="__add__">+ Add new…</option>}
        </select>
      )}
    </div>
  );
}
