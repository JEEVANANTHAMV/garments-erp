import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, CheckCircle2, RefreshCcw, Trash2 } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { http } from '../../../lib/api';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { Button, Input, Select, Textarea, LoadingBlock } from '../../../components/ui';
import { fmtDate, today } from '../../../lib/format';
import { FpTitle, FpStatus, useReasons, errText, kg, n } from './shared';

/** Fabric Process — Return (doc §7): quality issue on processed rolls of a GRN → return / reject store. */
export default function FabricProcessReturnPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  if (id === 'new') return <ReturnEditor onBack={() => setParams({})} onDone={(x) => setParams({ id: String(x) })} />;
  if (id) return <ReturnView id={Number(id)} onBack={() => setParams({})} />;
  return <ReturnList onOpen={(x) => setParams({ id: String(x) })} />;
}

function ReturnList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['fabric-process', 'returns'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/returns')).data ?? [] });
  return (
    <div>
      <FpTitle no={3} title="Process Return" sub="Reject / quality issue against a process GRN" actions={can('FABRIC_PROCESS.RETURN') ? <Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Return</Button> : null} />
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Return no', 'Date', 'Original GRN', 'DC', 'Supplier / Vendor', 'Jobs', 'Type', 'Reason', 'Qty KG', 'Reprocessed KG', 'Store', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(r.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{r.return_no}</td><td className="px-3 py-2">{fmtDate(r.return_date)}</td>
                  <td className="px-3 py-2 font-mono">{r.inward_no || '—'}</td><td className="px-3 py-2 font-mono">{r.fpo_no || '—'}</td><td className="px-3 py-2">{r.vendor_name || '—'}</td>
                  <td className="px-3 py-2">{r.jobs || '—'}</td><td className="px-3 py-2">{String(r.return_type).replace('_', ' ').toLowerCase()}</td><td className="px-3 py-2">{r.reason}</td>
                  <td className="px-3 py-2 text-right">{kg(r.total_kg)}</td><td className="px-3 py-2 text-right">{kg(r.reprocessed_kg)}</td><td className="px-3 py-2">{r.warehouse_name}</td>
                  <td className="px-3 py-2"><FpStatus value={r.status} /></td>
                </tr>
              ))}
              {!(list.data ?? []).length && <tr><td colSpan={12} className="px-3 py-10 text-center text-slate-400">No returns yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ReturnEditor({ onBack, onDone }: { onBack: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const reasons = useReasons();
  const warehouses = useLookup('warehouses');
  const grns = useQuery({ queryKey: ['fabric-process', 'inward'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/inward')).data ?? [] });
  const [head, setHead] = useState({ return_date: today(), inward_id: '', return_type: 'QUALITY_REJECT', reason_id: '', warehouse_id: '', remarks: '' });
  const grn = useQuery({ queryKey: ['fabric-process', 'inward', head.inward_id], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/inward/${head.inward_id}`)).data, enabled: !!head.inward_id });
  const [sel, setSel] = useState<Record<number, { qty: number | ''; reason: string }>>({});
  const [busy, setBusy] = useState(false);
  const rolls = (grn.data?.lines ?? []).filter((l: any) => l.fabric_roll_id && n(l.stock_balance_kg) > 0);
  const picked = rolls.filter((l: any) => sel[l.fabric_roll_id]);
  const total = picked.reduce((a: number, l: any) => a + n(sel[l.fabric_roll_id]?.qty), 0);
  const rejWh = (warehouses.data ?? []).find((w: any) => /reject/i.test(w.label));
  const save = async () => {
    if (!head.inward_id) { toast('Choose the original GRN', 'warning'); return; }
    if (!head.reason_id) { toast('Choose the reason', 'warning'); return; }
    if (!picked.length) { toast('Pick the rolls to return', 'warning'); return; }
    const wh = head.warehouse_id || (rejWh ? String(rejWh.id) : '');
    if (!wh) { toast('Choose the return store', 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/fabric-process/returns', {
        ...head, inward_id: Number(head.inward_id), reason_id: Number(head.reason_id), warehouse_id: Number(wh),
        lines: picked.map((l: any) => ({ source_roll_id: l.fabric_roll_id, qty_kg: n(sel[l.fabric_roll_id].qty), defect_reason: sel[l.fabric_roll_id].reason || null })),
      });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['fabric-process'] }); onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div>
      <FpTitle no={3} title="New Process Return" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Input label="Return date *" type="date" value={head.return_date} onChange={(e) => setHead({ ...head, return_date: e.target.value })} />
        <Select label="Original GRN *" value={head.inward_id} placeholder="— Process GRN —" onChange={(e) => { setHead({ ...head, inward_id: e.target.value }); setSel({}); }}
          options={(grns.data ?? []).filter((g) => g.status === 'POSTED').map((g) => ({ value: g.id, label: `${g.inward_no} · ${g.fpo_no} · ${g.vendor_name}` }))} />
        <Input label="Process" value={grn.data?.process_name ?? ''} disabled />
        <Select label="Return type *" value={head.return_type} onChange={(e) => setHead({ ...head, return_type: e.target.value })}
          options={[{ value: 'QUALITY_REJECT', label: 'Quality reject' }, { value: 'REPROCESS', label: 'For reprocess' }, { value: 'OTHER', label: 'Other' }]} />
        <Select label="Reason *" value={head.reason_id} placeholder="— Reason —" onChange={(e) => setHead({ ...head, reason_id: e.target.value })}
          options={(reasons.data ?? []).filter((r) => r.kind !== 'BILLING').map((r) => ({ value: r.id, label: r.reason }))} />
        <Select label="Return store" value={head.warehouse_id || (rejWh ? String(rejWh.id) : '')} onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })} options={toOptions(warehouses.data)} />
        <Textarea label="Remarks" className="col-span-2 md:col-span-6" rows={1} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Job', 'Output roll', 'Colour', 'In store KG', 'Return KG', 'Defect reason'].map((h, i) => <th key={i} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {!head.inward_id && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Choose the original GRN</td></tr>}
            {rolls.map((l: any) => {
              const s = sel[l.fabric_roll_id];
              return (
                <tr key={l.id} className={`border-t border-slate-100 ${s ? 'bg-red-50/60' : ''}`}>
                  <td className="px-2 py-1"><input type="checkbox" checked={!!s} onChange={() => setSel((x) => { const c = { ...x }; if (s) delete c[l.fabric_roll_id]; else c[l.fabric_roll_id] = { qty: n(l.stock_balance_kg), reason: '' }; return c; })} /></td>
                  <td className="px-2 py-1 font-semibold">{l.io_no}</td><td className="px-2 py-1 font-mono">{l.roll_no}</td><td className="px-2 py-1">{l.color_name || '—'}</td>
                  <td className="px-2 py-1 text-right">{kg(l.stock_balance_kg)}</td>
                  <td className="px-2 py-1 text-right">{s ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={s.qty} onChange={(e) => setSel((x) => ({ ...x, [l.fabric_roll_id]: { ...s, qty: e.target.value === '' ? '' : Number(e.target.value) } }))} /> : '—'}</td>
                  <td className="px-2 py-1">{s ? <input className="input w-48 py-0.5 text-xs" value={s.reason} placeholder="e.g. Shade variation" onChange={(e) => setSel((x) => ({ ...x, [l.fabric_roll_id]: { ...s, reason: e.target.value } }))} /> : ''}</td>
                </tr>
              );
            })}
            {head.inward_id && !grn.isLoading && !rolls.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">No processed rolls of this GRN left in the store</td></tr>}
          </tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={5} className="px-2 py-2 text-right">Total return</td><td className="px-2 py-2 text-right">{kg(total)}</td><td /></tr></tfoot>
        </table>
      </div>
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onBack}>Cancel</Button><Button loading={busy} onClick={save}><CheckCircle2 size={14} className="mr-1" /> Confirm Return</Button></div>
    </div>
  );
}

function ReturnView({ id, onBack }: { id: number; onBack: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['fabric-process', 'returns', id], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/returns/${id}`)).data });
  const r = q.data;
  if (!r) return <LoadingBlock />;
  const open = r.lines.reduce((a: number, l: any) => a + n(l.qty_kg) - n(l.reprocessed_kg), 0);
  return (
    <div>
      <FpTitle no={3} title={`Process Return — ${r.return_no}`} sub={`GRN ${r.inward_no ?? '—'} · ${r.vendor_name ?? ''} · ${r.reason}`}
        actions={<><FpStatus value={r.status} />
          {open > 0.0005 && can('FABRIC_PROCESS.REPROCESS') && <Button onClick={() => nav(`/production/fabric-process/reprocess?id=new&return=${id}`)}><RefreshCcw size={14} className="mr-1" /> Send to Reprocess</Button>}
          <Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'Roll', 'Colour', 'Return KG', 'Reprocessed KG', 'Open KG', 'Defect reason'].map((h) => <th key={h} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{r.lines.map((l: any) => (
            <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{l.io_no || '—'}</td><td className="px-2 py-1 font-mono">{l.roll_no}</td><td className="px-2 py-1">{l.color_name || '—'}</td>
              <td className="px-2 py-1 text-right">{kg(l.qty_kg)}</td><td className="px-2 py-1 text-right">{kg(l.reprocessed_kg)}</td><td className="px-2 py-1 text-right">{kg(n(l.qty_kg) - n(l.reprocessed_kg))}</td><td className="px-2 py-1">{l.defect_reason || '—'}</td></tr>
          ))}</tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={3} className="px-2 py-2 text-right">Total</td><td className="px-2 py-2 text-right">{kg(r.total_kg)}</td><td className="px-2 py-2 text-right">{kg(r.reprocessed_kg)}</td><td className="px-2 py-2 text-right">{kg(open)}</td><td /></tr></tfoot>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500"><Trash2 size={11} className="inline" /> Posted returns cannot be deleted — returned KG sits in {r.warehouse_name} until it is reprocessed.</p>
    </div>
  );
}
