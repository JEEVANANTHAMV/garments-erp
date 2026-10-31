import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';

/**
 * Set composition of a style (client 29-Oct-2026, set spec §4.2): the parts one SET is made of and the pieces of each
 * per set — TOP 1 + BOTTOM 1, TOP 2 + BOTTOM 1, TOP + BOTTOM + DUPATTA. With two or more parts the sales order can be
 * entered in sets; cutting, sewing and QC still run per part, and sets are formed at packing. No parts = a piece style.
 */
interface Part { part_name: string; qty_per_set: number | '' }
const SUGGEST = ['TOP', 'BOTTOM', 'DUPATTA', 'JACKET', 'SHORTS', 'SKIRT', 'VEST'];

export function StyleSetPartsPanel({ styleId, editable }: { styleId: number; editable: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const cur = useQuery({
    queryKey: ['style-set-parts-admin', styleId],
    queryFn: async () => await http.get<{ data: Part[]; set_orders: string[] }>(`/styles/${styleId}/set-parts`),
  });
  const [rows, setRows] = useState<Part[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.data && !dirty) setRows(cur.data.data ?? []); }, [cur.data, dirty]);
  const change = (next: Part[]) => { setRows(next); setDirty(true); };

  const save = async () => {
    setBusy(true);
    try {
      await http.put(`/styles/${styleId}/set-parts`, { parts: rows.filter((r) => r.part_name.trim()).map((r) => ({ part_name: r.part_name.trim().toUpperCase(), qty_per_set: Number(r.qty_per_set) || 1 })) });
      setDirty(false);
      toast('Set composition saved', 'success');
      void qc.invalidateQueries({ queryKey: ['style-set-parts-admin', styleId] });
      void qc.invalidateQueries({ queryKey: ['style-set-parts', styleId] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save the set composition', 'error');
    } finally { setBusy(false); }
  };

  const isSet = rows.filter((r) => r.part_name.trim()).length >= 2;
  const pcs = rows.reduce((a, r) => a + (Number(r.qty_per_set) || 0), 0);
  return (
    <div className="card p-4" data-set-parts-panel>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-body font-bold uppercase tracking-wider text-ink">Set composition</h3>
          <p className="text-small text-ink-secondary">
            Sold as a set (e.g. TOP + BOTTOM)? List its parts and the pieces of each per set. The sales order can then be
            entered in sets; each part is still cut, sewn and checked as pieces and paired at packing. Leave empty for a piece style.
          </p>
        </div>
        {isSet && <span className="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-small font-semibold text-indigo-800">1 SET = {pcs} pcs</span>}
      </div>
      {rows.length > 0 && (
        <table className="mb-2 text-body">
          <thead><tr><th className="th">#</th><th className="th">Part</th><th className="th">Pieces per set</th><th className="th" /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="td text-ink-muted">{i + 1}{i === 0 ? ' (set colour)' : ''}</td>
                <td className="td p-1">
                  <input className="input w-36 uppercase" list="set-part-suggest" maxLength={20} disabled={!editable} id={`set-part-name-${i}`}
                    value={r.part_name} onChange={(e) => change(rows.map((x, k) => (k === i ? { ...x, part_name: e.target.value.toUpperCase() } : x)))} />
                </td>
                <td className="td p-1">
                  <input className="input w-20 text-right" type="number" min={1} max={20} disabled={!editable} id={`set-part-qty-${i}`}
                    value={r.qty_per_set} onChange={(e) => change(rows.map((x, k) => (k === i ? { ...x, qty_per_set: e.target.value === '' ? '' : Number(e.target.value) } : x)))} />
                </td>
                <td className="td">
                  {editable && (
                    <button type="button" className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-600" title="Remove part"
                      onClick={() => change(rows.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <datalist id="set-part-suggest">{SUGGEST.map((x) => <option key={x} value={x} />)}</datalist>
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          {rows.length === 0 && (
            <button type="button" className="btn-secondary text-xs" id="set-parts-top-bottom"
              onClick={() => change([{ part_name: 'TOP', qty_per_set: 1 }, { part_name: 'BOTTOM', qty_per_set: 1 }])}>
              Make it a set: TOP 1 + BOTTOM 1
            </button>
          )}
          <button type="button" className="btn-secondary text-xs" id="set-parts-add"
            onClick={() => change([...rows, { part_name: '', qty_per_set: 1 }])}><Plus size={13} /> Add part</button>
          {dirty && (
            <button type="button" className="btn-primary text-xs" id="set-parts-save" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save set composition'}
            </button>
          )}
          {rows.length === 1 && <span className="text-small text-red-600">A set needs at least two parts</span>}
        </div>
      )}
      {(cur.data?.set_orders?.length ?? 0) > 0 && (
        <p className="mt-2 text-caption text-ink-secondary">
          Orders entered in sets ({cur.data!.set_orders.join(', ')}) keep the composition they were entered with.
        </p>
      )}
    </div>
  );
}
