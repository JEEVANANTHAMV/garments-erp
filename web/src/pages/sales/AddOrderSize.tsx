import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../lib/auth';

/**
 * "Add size" on a sales order line (Size doc §9–§10): the buyer asks for a size the style does not have (e.g. XXL).
 * Any existing size from the size master can be added — permission SALES_ORDER.ADD_SIZE, with a reason; the user, date
 * and reason are logged and the style gets the size + its SKUs, so the line's size matrix shows it.
 */
export function AddOrderSize({ styleId, soId, existingCodes, onAdded }: { styleId: number; soId?: number | null; existingCodes: string[]; onAdded: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [sizeId, setSizeId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const catalog = useQuery({ queryKey: ['size-catalog'], queryFn: async () => (await http.get<{ data: any[] }>('/styles/size-catalog')).data ?? [], enabled: open, staleTime: 60_000 });
  if (!can('SALES_ORDER.ADD_SIZE')) return null;
  const free = (catalog.data ?? []).filter((c: any) => !existingCodes.some((x) => x.toUpperCase() === String(c.size_code).toUpperCase()));
  const save = async () => {
    if (!sizeId || !reason.trim()) { toast('Pick the size and give the reason', 'error'); return; }
    setBusy(true);
    try {
      await http.post(`/styles/${styleId}/sizes/order-add`, { size_id: Number(sizeId), so_id: soId ?? null, reason });
      await qc.invalidateQueries({ queryKey: ['lookup', 'style-skus', styleId] });
      toast('Size added to the style for this order (logged)');
      setOpen(false); setSizeId(''); setReason(''); onAdded();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add the size', 'error'); } finally { setBusy(false); }
  };
  if (!open) return <button type="button" className="btn-xs rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800" id="so-add-size" onClick={() => setOpen(true)}>+ Add size</button>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs">
      <select className="input py-0.5 text-xs" id="so-add-size-pick" value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
        <option value="">— Size —</option>
        {free.map((c: any) => <option key={c.id} value={c.id}>{c.size_code}</option>)}
      </select>
      <input className="input w-56 py-0.5 text-xs" id="so-add-size-reason" placeholder="Reason (buyer request …)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="rounded bg-amber-600 px-2 py-0.5 font-semibold text-white" id="so-add-size-save" disabled={busy} onClick={() => void save()}>Add</button>
      <button type="button" className="px-1" onClick={() => setOpen(false)}>✕</button>
    </span>
  );
}
