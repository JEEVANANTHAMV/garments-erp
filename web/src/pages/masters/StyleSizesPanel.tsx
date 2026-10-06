import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDateTime } from '../../lib/format';

/**
 * Style size assignment (client voice note 05-Oct-2026 + "Size Master & Style Size Assignment" document): the sizes of
 * a style are picked one by one from the size master — S, M, L, 1A, 2A on one style is fine — and a size group is only
 * a shortcut that fills the list. Saving syncs the SKUs (new sizes get SKUs, removed ones are deactivated), so the sales
 * order shows exactly these sizes. Every change is logged.
 */
interface Row { size_id: number; size_code: string; size_label?: string; group_name?: string | null; is_default?: boolean | number; source_type?: string }

export function StyleSizesPanel({ styleId, editable, onSaved }: { styleId: number; editable: boolean; onSaved?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const sizeGroups = useLookup('size-groups');
  const cur = useQuery({ queryKey: ['style-sizes', styleId], queryFn: async () => (await http.get<{ data: Row[]; log: any[]; version_no?: number }>(`/styles/${styleId}/sizes`)) });
  const catalog = useQuery({ queryKey: ['size-catalog'], queryFn: async () => (await http.get<{ data: any[] }>('/styles/size-catalog')).data ?? [], staleTime: 60_000 });
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [pick, setPick] = useState('');
  const [group, setGroup] = useState('');
  const [reason, setReason] = useState('');
  const [newCode, setNewCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.data && !dirty) setRows(cur.data.data ?? []); }, [cur.data, dirty]);

  const free = useMemo(() => (catalog.data ?? []).filter((c: any) => !rows.some((r) => String(r.size_code).toUpperCase() === String(c.size_code).toUpperCase())), [catalog.data, rows]);
  const change = (next: Row[]) => { setRows(next); setDirty(true); };
  const add = () => {
    const c = (catalog.data ?? []).find((x: any) => String(x.id) === pick);
    if (!c) return;
    change([...rows, { size_id: Number(c.id), size_code: c.size_code, size_label: c.size_label, group_name: c.group_name, source_type: 'MANUAL' }]);
    setPick('');
  };
  const move = (i: number, d: number) => { const n = [...rows]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; change(n); };
  const refresh = async () => {
    setDirty(false);
    await Promise.all([cur.refetch(), qc.invalidateQueries({ queryKey: ['lookup', 'style-skus', styleId] }), qc.invalidateQueries({ queryKey: ['styles', 'item', String(styleId)] })]);
    onSaved?.();
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await http.put<{ data: any }>(`/styles/${styleId}/sizes`, { sizes: rows.map((x) => ({ size_id: x.size_id, is_default: !!x.is_default })), reason: reason || null });
      const sy = r.data.sync;
      toast(`Sizes saved${sy ? ` — SKUs: ${sy.added} added, ${sy.reactivated} back, ${sy.deactivated} retired` : ''}`);
      setReason(''); await refresh();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save the sizes', 'error'); } finally { setBusy(false); }
  };
  const importGroup = async (replace: boolean) => {
    if (!group) return;
    setBusy(true);
    try {
      const r = await http.post<{ data: any }>(`/styles/${styleId}/sizes/group`, { size_group_id: Number(group), replace });
      toast(`${r.data.added.length} size(s) added from the group${replace ? ' (sizes outside the group removed)' : ''}`);
      setGroup(''); await refresh();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not import the group', 'error'); } finally { setBusy(false); }
  };
  const createSize = async () => {
    if (!newCode.trim()) return;
    try {
      const r = await http.post<{ data: any }>('/styles/size-catalog', { size_code: newCode.trim(), size_label: newCode.trim() });
      await catalog.refetch();
      setPick(String(r.data.id)); setNewCode('');
      toast(r.data.existed ? `Size ${r.data.size_code} is already in the size master — selected` : `Size ${r.data.size_code} added to the size master`);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add the size', 'error'); }
  };

  return (
    <div className="card p-4" id="style-sizes">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-700">Sizes of this style</h3>
            {cur.data?.version_no != null && (
              <span className="font-mono text-[11px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">
                Active Version: v{cur.data.version_no}
              </span>
            )}
          </div>
          <p className="text-[11.5px] text-slate-500">Pick the sizes one by one. Modifying sizes updates SKUs and increments the style version for audit tracking.</p>
        </div>
        {dirty && <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Not saved</span>}
      </div>
      <div className="flex flex-wrap gap-2" id="style-size-chips">
        {rows.length === 0 && <span className="text-xs text-slate-400">No sizes yet — add sizes or import a size group.</span>}
        {rows.map((r, i) => (
          <span key={r.size_id} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${r.is_default ? 'border-brand-400 bg-brand-50' : 'border-slate-300 bg-white'}`} title={r.group_name ? `From ${r.group_name}` : undefined}>
            {editable && <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => move(i, -1)}>‹</button>}
            <b>{r.size_code}</b>
            {r.source_type === 'ORDER' && <span className="text-[9px] font-bold text-amber-700">ORDER</span>}
            {editable && <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => move(i, 1)}>›</button>}
            {editable && <button type="button" title="Default size" className={r.is_default ? 'text-brand-600' : 'text-slate-300 hover:text-brand-600'} onClick={() => change(rows.map((x) => ({ ...x, is_default: x.size_id === r.size_id ? !x.is_default : false })))}>★</button>}
            {editable && <button type="button" className="font-bold text-red-500" id={`style-size-remove-${r.size_code}`} onClick={() => change(rows.filter((x) => x.size_id !== r.size_id))}>×</button>}
          </span>
        ))}
      </div>
      {editable && (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex items-end gap-2">
            <label className="flex-1 text-xs"><span className="label">Add size</span>
              <select className="input" id="style-size-pick" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">— Size master —</option>
                {free.map((c: any) => <option key={c.id} value={c.id}>{c.size_code}{c.size_label && c.size_label !== c.size_code ? ` · ${c.size_label}` : ''}</option>)}
              </select>
            </label>
            <button type="button" className="btn-secondary btn-sm" id="style-size-add" disabled={!pick} onClick={add}>Add</button>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex-1 text-xs"><span className="label">New size (not in the master)</span>
              <input className="input" id="style-size-new" value={newCode} placeholder="e.g. 7A" onChange={(e) => setNewCode(e.target.value)} />
            </label>
            <button type="button" className="btn-secondary btn-sm" disabled={!newCode.trim()} onClick={() => void createSize()}>Create</button>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex-1 text-xs"><span className="label">Size group (shortcut)</span>
              <select className="input" id="style-size-group" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">— Size group —</option>
                {toOptions(sizeGroups.data).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <button type="button" className="btn-secondary btn-sm" disabled={!group || busy} onClick={() => void importGroup(false)}>Add group</button>
            <button type="button" className="btn-secondary btn-sm" disabled={!group || busy} title="Replace: only this group's sizes stay" onClick={() => void importGroup(true)}>Replace</button>
          </div>
          <input className="input md:col-span-2" placeholder="Reason for the change (kept in the size log)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn-primary btn-sm" id="style-sizes-save" disabled={!dirty || busy} onClick={() => void save()}>Save sizes</button>
        </div>
      )}
      {(cur.data?.log?.length ?? 0) > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer font-semibold text-slate-600">Size change log ({cur.data!.log.length})</summary>
          <table className="mt-1 w-full"><tbody>{cur.data!.log.map((l: any) => (
            <tr key={l.id} className="border-t"><td className="py-0.5 pr-2 text-slate-500">{fmtDateTime(l.created_at)}</td><td className="pr-2 font-semibold">{l.action}</td>
              <td className="pr-2">{l.size_code || ''} {l.old_value ? `${l.old_value} →` : ''} {l.new_value || ''}</td><td className="pr-2">{l.reason || ''}</td><td className="text-slate-500">{l.user_name}</td></tr>
          ))}</tbody></table>
        </details>
      )}
    </div>
  );
}
