import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, CheckCircle2, Save, RefreshCcw, BadgeCheck, Pencil, Lock, Ban } from 'lucide-react';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { Button, Input, Select, Textarea, LoadingBlock, Modal } from '../../../components/ui';
import { fmtDate, fmtDecimal, today } from '../../../lib/format';
import { YpTitle, YpStatus, useReasons, useYarnTypes, errText, kg, n, r3 } from './shared';

/** Yarn Process — Return (doc §12) and Reprocess with billing type + cost treatment (doc §13). */

// ======================================================================= Return
export function YarnProcessReturnPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  if (id === 'new') return <ReturnEditor onBack={() => setParams({})} onDone={(x) => setParams({ id: String(x) })} />;
  if (id) return <ReturnView id={Number(id)} onBack={() => setParams({})} />;
  return <ReturnList onOpen={(x) => setParams({ id: String(x) })} />;
}

function ReturnList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['yarn-process', 'returns'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/returns')).data ?? [] });
  return (
    <div>
      <YpTitle no={3} title="Yarn Process Return" sub="Quality issue on processed cones — back to the return / rework store"
        actions={can('YARN_PROCESS.RETURN') ? <Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Return</Button> : null} />
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Return no', 'Date', 'Original GRN', 'Process', 'Process unit', 'Jobs', 'Type', 'Reason', 'KG', 'Reprocessed', 'Rejected', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|Reprocessed|Rejected/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(r.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{r.return_no}</td><td className="px-3 py-2">{fmtDate(r.return_date)}</td><td className="px-3 py-2 font-mono">{r.inward_no || '—'}</td>
                  <td className="px-3 py-2">{r.process_code || '—'}</td><td className="px-3 py-2">{r.vendor_name || '—'}</td><td className="px-3 py-2">{r.jobs || '—'}</td><td className="px-3 py-2">{r.return_type}</td>
                  <td className="px-3 py-2">{r.reason}</td><td className="px-3 py-2 text-right">{kg(r.total_kg)}</td><td className="px-3 py-2 text-right">{kg(r.reprocessed_kg)}</td><td className="px-3 py-2 text-right">{kg(r.rejected_kg)}</td>
                  <td className="px-3 py-2"><YpStatus value={r.status} /></td>
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
  const grns = useQuery({ queryKey: ['yarn-process', 'inward', 'posted'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/inward?posted=1')).data ?? [] });
  const [head, setHead] = useState({ return_date: today(), inward_id: '', return_type: 'QUALITY', reason_id: '', warehouse_id: '', remarks: '' });
  const lots = useQuery({ queryKey: ['yarn-process', 'processed-lots', head.inward_id], queryFn: async () => (await http.get<{ data: any[] }>(`/yarn-process/processed-lots?inward_id=${head.inward_id}`)).data ?? [], enabled: !!head.inward_id });
  const [sel, setSel] = useState<Record<number, { qty: number; defect: string }>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { const w = warehouses.data ?? []; if (w.length && !head.warehouse_id) setHead((h) => ({ ...h, warehouse_id: String((w.find((x: any) => /reject|return/i.test(x.label)) ?? w[0]).id) })); }, [warehouses.data]);
  const total = Object.values(sel).reduce((a, x) => a + n(x.qty), 0);
  const save = async () => {
    if (!head.reason_id) { toast('Choose the reason', 'warning'); return; }
    const lines = Object.entries(sel).filter(([, x]) => n(x.qty) > 0).map(([id, x]) => ({ source_grn_line_id: Number(id), qty_kg: n(x.qty), defect_reason: x.defect || null }));
    if (!lines.length) { toast('Pick the cones / lots to return', 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/yarn-process/returns', { ...head, inward_id: head.inward_id ? Number(head.inward_id) : null, reason_id: Number(head.reason_id), warehouse_id: Number(head.warehouse_id), lines });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div>
      <YpTitle no={3} title="New Yarn Process Return" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Input label="Return date *" type="date" value={head.return_date} onChange={(e) => setHead({ ...head, return_date: e.target.value })} />
        <Select label="Original GRN *" value={head.inward_id} placeholder="— Yarn process GRN —" onChange={(e) => { setHead({ ...head, inward_id: e.target.value }); setSel({}); }}
          options={(grns.data ?? []).filter((g) => !g.is_reprocess || true).map((g) => ({ value: g.id, label: `${g.inward_no} · ${g.ypo_no} · ${g.vendor_name}` }))} />
        <Select label="Return type *" value={head.return_type} onChange={(e) => setHead({ ...head, return_type: e.target.value })} options={[{ value: 'QUALITY', label: 'Quality' }, { value: 'REPROCESS', label: 'Reprocess' }, { value: 'OTHER', label: 'Other' }]} />
        <Select label="Reason *" value={head.reason_id} placeholder="— Reason —" onChange={(e) => setHead({ ...head, reason_id: e.target.value })} options={(reasons.data ?? []).filter((r) => r.kind !== 'BILLING').map((r) => ({ value: r.id, label: `${r.code} · ${r.reason}` }))} />
        <Select label="Return / rework store *" value={head.warehouse_id} onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })} options={toOptions(warehouses.data)} />
        <Textarea label="Remarks" rows={1} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Job', 'Lot', 'Cone', 'Yarn', 'Shade', 'Store', 'In store KG', 'Return KG', 'Defect'].map((h, i) => <th key={i} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {!head.inward_id && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-400">Choose the original GRN</td></tr>}
            {(lots.data ?? []).map((l) => {
              const on = !!sel[l.grn_line_id];
              return (
                <tr key={l.grn_line_id} className={`border-t border-slate-100 ${on ? 'bg-amber-50' : ''}`}>
                  <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setSel((s) => { const x = { ...s }; if (on) delete x[l.grn_line_id]; else x[l.grn_line_id] = { qty: l.balance_kg, defect: '' }; return x; })} /></td>
                  <td className="px-2 py-1 font-semibold">{l.io_no || 'STOCK'}</td><td className="px-2 py-1 font-mono">{l.lot_no}</td><td className="px-2 py-1">{l.cone_no || '—'}</td><td className="px-2 py-1">{l.yarn_name}</td>
                  <td className="px-2 py-1">{l.shade || '—'}</td><td className="px-2 py-1">{l.warehouse_name}</td><td className="px-2 py-1 text-right">{kg(l.balance_kg)}</td>
                  <td className="px-2 py-1 text-right">{on ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={sel[l.grn_line_id].qty} onChange={(e) => setSel((s) => ({ ...s, [l.grn_line_id]: { ...s[l.grn_line_id], qty: r3(Number(e.target.value)) } }))} /> : '—'}</td>
                  <td className="px-2 py-1">{on ? <input className="input w-40 py-0.5 text-xs" value={sel[l.grn_line_id].defect} onChange={(e) => setSel((s) => ({ ...s, [l.grn_line_id]: { ...s[l.grn_line_id], defect: e.target.value } }))} /> : ''}</td>
                </tr>
              );
            })}
            {head.inward_id && !lots.isLoading && !(lots.data ?? []).length && <tr><td colSpan={10} className="px-3 py-8 text-center text-slate-400">No processed cones of this GRN left in the store</td></tr>}
          </tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={8} className="px-2 py-2 text-right">Return total</td><td className="px-2 py-2 text-right">{kg(total)}</td><td /></tr></tfoot>
        </table>
      </div>
      <div className="mt-3 flex justify-end gap-2"><Button variant="secondary" onClick={onBack}>Cancel</Button><Button loading={busy} onClick={save}><CheckCircle2 size={14} className="mr-1" /> Confirm Return</Button></div>
    </div>
  );
}

function ReturnView({ id, onBack }: { id: number; onBack: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['yarn-process', 'returns', id], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/returns/${id}`)).data });
  const r = q.data;
  if (!r) return <LoadingBlock />;
  const open = (r.lines ?? []).reduce((a: number, l: any) => a + Math.max(0, n(l.qty_kg) - n(l.reprocessed_kg)), 0);
  const close = async () => {
    const reason = window.prompt(`Close ${r.return_no}? KG not reprocessed is rejected / written off. Reason:`);
    if (!reason || reason.trim().length < 3) return;
    try { const x = await http.post<{ message: string }>(`/yarn-process/returns/${id}/close`, { reason }); toast((x as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); } catch (e) { toast(errText(e), 'error'); }
  };
  return (
    <div>
      <YpTitle no={3} title={`Yarn Return — ${r.return_no}`} sub={`${r.inward_no ? `GRN ${r.inward_no} · ` : ''}${r.vendor_name ?? ''} · ${r.reason}`}
        actions={<><YpStatus value={r.status} />
          {r.status !== 'CLOSED' && open > 0.0005 && can('YARN_PROCESS.REPROCESS') && <Button onClick={() => nav(`/production/yarn-process/reprocess?id=new&return=${id}`)}><RefreshCcw size={14} className="mr-1" /> Send to Reprocess</Button>}
          {r.status !== 'CLOSED' && can('YARN_PROCESS.CONFIRM') && <Button variant="secondary" onClick={close}><Lock size={14} className="mr-1" /> Close (reject balance)</Button>}
          <Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'Lot', 'Cone', 'Return lot', 'Returned KG', 'Reprocessed KG', 'Eligible KG', 'Defect'].map((h) => <th key={h} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{r.lines.map((l: any) => (
            <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{l.io_no || 'STOCK'}</td><td className="px-2 py-1 font-mono">{l.lot_no}</td><td className="px-2 py-1">{l.cone_no || '—'}</td>
              <td className="px-2 py-1 font-mono">{l.return_lot_no}</td><td className="px-2 py-1 text-right">{kg(l.qty_kg)}</td><td className="px-2 py-1 text-right">{kg(l.reprocessed_kg)}</td>
              <td className="px-2 py-1 text-right font-semibold">{kg(l.eligible_kg)}</td><td className="px-2 py-1">{l.defect_reason || '—'}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ======================================================================= Reprocess
export function YarnProcessReprocessPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  if (id === 'new') return <ReprocessEditor returnId={params.get('return') ? Number(params.get('return')) : null} onBack={() => setParams({})} onDone={(x) => setParams({ id: String(x) })} />;
  if (id) return <ReprocessView id={Number(id)} onBack={() => setParams({})} />;
  return <ReprocessList onOpen={(x) => setParams({ id: String(x) })} />;
}

function ReprocessList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['yarn-process', 'reprocess'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/reprocess')).data ?? [] });
  return (
    <div>
      <YpTitle no={4} title="Yarn Reprocess" sub="Re-dye / re-wind / re-twist — billable or non-billable"
        actions={can('YARN_PROCESS.REPROCESS') ? <Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Reprocess</Button> : null} />
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Reprocess no', 'Date', 'Process', 'Process unit', 'Jobs', 'Return', 'KG', 'Billing', 'Cost treatment', 'Amount', 'Billing status', 'DC', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|Amount/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(r.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{r.reprocess_no}</td><td className="px-3 py-2">{fmtDate(r.reprocess_date)}</td><td className="px-3 py-2">{r.process_name || r.process_code}</td>
                  <td className="px-3 py-2">{r.vendor_name}</td><td className="px-3 py-2">{r.jobs || '—'}</td><td className="px-3 py-2 font-mono">{r.return_no || 'GRN reject'}</td><td className="px-3 py-2 text-right">{kg(r.total_kg)}</td>
                  <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${r.billing_type === 'BILLABLE' ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-700'}`}>{r.billing_type.replace('_', '-')}</span></td>
                  <td className="px-3 py-2">{r.cost_treatment}</td><td className="px-3 py-2 text-right">₹{fmtDecimal(r.bill_amount, 2)}</td><td className="px-3 py-2"><YpStatus value={r.billing_status} /></td>
                  <td className="px-3 py-2 font-mono">{r.ypo_no || '—'}</td><td className="px-3 py-2"><YpStatus value={r.status} /></td>
                </tr>
              ))}
              {!(list.data ?? []).length && <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">No reprocess entries yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const TREAT: Record<string, string> = { CONTRACTOR: 'Contractor charge', INTERNAL: 'Internal cost', FREE: 'Free', RECOVERY: 'Recovery from contractor' };
function BillingFields({ b, setB, qty, reasons }: { b: any; setB: (p: any) => void; qty: number; reasons: { id: number; reason: string }[] }) {
  const billable = b.billing_type === 'BILLABLE';
  const amt = n(b.bill_amount) > 0 ? n(b.bill_amount) : n(b.rate_per_kg) * qty;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
      <Select label="Billing type *" value={b.billing_type} onChange={(e) => setB({ billing_type: e.target.value, cost_treatment: e.target.value === 'BILLABLE' ? 'CONTRACTOR' : 'INTERNAL' })} options={[{ value: 'BILLABLE', label: 'Billable' }, { value: 'NON_BILLABLE', label: 'Non-billable' }]} />
      <Select label="Cost treatment *" value={b.cost_treatment} onChange={(e) => setB({ cost_treatment: e.target.value })}
        options={(billable ? ['CONTRACTOR'] : ['INTERNAL', 'FREE', 'RECOVERY']).map((x) => ({ value: x, label: TREAT[x] }))} />
      <Select label="Billing reason" value={b.billing_reason_id} placeholder="—" onChange={(e) => setB({ billing_reason_id: e.target.value })} options={reasons.map((r) => ({ value: r.id, label: r.reason }))} />
      {(billable || b.cost_treatment === 'RECOVERY') && <Input label="Rate / KG (₹)" type="number" step="0.01" value={b.rate_per_kg} onChange={(e) => setB({ rate_per_kg: e.target.value })} />}
      {(billable || b.cost_treatment === 'RECOVERY') && <Input label={billable ? 'Approved amount (₹)' : 'Recovery amount (₹)'} type="number" step="0.01" value={b.bill_amount} placeholder={amt ? amt.toFixed(2) : ''} onChange={(e) => setB({ bill_amount: e.target.value })} />}
      <Input label="Internal cost (₹)" type="number" step="0.01" value={b.internal_cost} onChange={(e) => setB({ internal_cost: e.target.value })} />
      <p className="col-span-2 self-end text-[11.5px] text-slate-500 md:col-span-6">{billable ? `Goes to the contractor bill: ₹${amt.toFixed(2)}` : b.cost_treatment === 'RECOVERY' ? `Debited from the contractor on the bill: ₹${amt.toFixed(2)}` : 'Excluded from the contractor bill — the internal cost stays in costing / history.'}</p>
    </div>
  );
}
const billingPayload = (b: any) => ({ billing_type: b.billing_type, cost_treatment: b.cost_treatment, billing_reason_id: b.billing_reason_id ? Number(b.billing_reason_id) : null,
  rate_per_kg: n(b.rate_per_kg), bill_amount: n(b.bill_amount) || null, internal_cost: n(b.internal_cost), billing_remarks: b.billing_remarks || null });

function ReprocessEditor({ returnId, onBack, onDone }: { returnId: number | null; onBack: () => void; onDone: (id: number) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const types = useYarnTypes();
  const reasons = useReasons();
  const suppliers = useLookup('suppliers');
  const returns = useQuery({ queryKey: ['yarn-process', 'returns'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/returns')).data ?? [] });
  const rejectLots = useQuery({ queryKey: ['yarn-process', 'reject-lots'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/reject-lots')).data ?? [] });
  const [head, setHead] = useState({ reprocess_date: today(), source_type: returnId ? 'RETURN' : 'RETURN', return_id: returnId ? String(returnId) : '', process_code: 'RE_YARN_DYEING', vendor_id: '', target_shade: '', reason_id: '', remarks: '' });
  const [b, setBState] = useState<any>({ billing_type: 'NON_BILLABLE', cost_treatment: 'INTERNAL', billing_reason_id: '', rate_per_kg: '', bill_amount: '', internal_cost: '' });
  const setB = (p: any) => setBState((x: any) => ({ ...x, ...p }));
  const [sel, setSel] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const ret = (returns.data ?? []).find((r) => String(r.id) === head.return_id);
  useEffect(() => { if (ret && !head.vendor_id && ret.vendor_id) setHead((h) => ({ ...h, vendor_id: String(ret.vendor_id) })); }, [ret]);
  const lots = (rejectLots.data ?? []).filter((l) => (head.source_type === 'RETURN' ? String(l.return_id) === head.return_id : !l.return_id));
  const qty = Object.values(sel).reduce((a, x) => a + n(x), 0);
  const save = async (confirm: boolean) => {
    if (!head.vendor_id || !head.reason_id) { toast('Choose the process unit and the reason', 'warning'); return; }
    const lines = Object.entries(sel).filter(([, q]) => n(q) > 0).map(([id, q]) => ({ source_grn_line_id: Number(id), qty_kg: n(q) }));
    if (!lines.length) { toast('Pick the cones / lots to reprocess', 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/yarn-process/reprocess', { ...head, return_id: head.return_id ? Number(head.return_id) : null, vendor_id: Number(head.vendor_id), reason_id: Number(head.reason_id), ...billingPayload(b), lines, confirm });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div>
      <YpTitle no={4} title="New Yarn Reprocess" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Input label="Date *" type="date" value={head.reprocess_date} onChange={(e) => setHead({ ...head, reprocess_date: e.target.value })} />
        <Select label="Source *" value={head.source_type} onChange={(e) => { setHead({ ...head, source_type: e.target.value }); setSel({}); }} options={[{ value: 'RETURN', label: 'Process return' }, { value: 'REJECT', label: 'GRN reject cones' }]} />
        {head.source_type === 'RETURN' && <Select label="Return no *" value={head.return_id} placeholder="— Return —" onChange={(e) => { setHead({ ...head, return_id: e.target.value }); setSel({}); }}
          options={(returns.data ?? []).filter((r) => r.status !== 'CLOSED').map((r) => ({ value: r.id, label: `${r.return_no} · ${r.vendor_name ?? ''} · ${kg(n(r.total_kg) - n(r.reprocessed_kg))} KG open` }))} />}
        <Select label="Process *" value={head.process_code} onChange={(e) => setHead({ ...head, process_code: e.target.value })} options={(types.data ?? []).filter((t) => t.is_active && (t.is_reprocess || t.allow_reprocess)).map((t) => ({ value: t.code, label: t.name }))} />
        <Select label="Process unit *" value={head.vendor_id} placeholder="— Process unit —" onChange={(e) => setHead({ ...head, vendor_id: e.target.value })} options={toOptions(suppliers.data)} />
        <Input label="Target shade" value={head.target_shade} onChange={(e) => setHead({ ...head, target_shade: e.target.value })} />
        <Select label="Reason *" value={head.reason_id} placeholder="— Reason —" onChange={(e) => setHead({ ...head, reason_id: e.target.value })} options={(reasons.data ?? []).map((r) => ({ value: r.id, label: `${r.code} · ${r.reason}` }))} />
        <Textarea label="Remarks" className="col-span-2 md:col-span-5" rows={1} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </div>
      <div className="card mb-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Job', 'Lot', 'Cone', 'Yarn', 'Shade', 'From', 'Eligible KG', 'Reprocess KG'].map((h, i) => <th key={i} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {lots.map((l) => {
              const on = sel[l.grn_line_id] !== undefined;
              return (
                <tr key={l.grn_line_id} className={`border-t border-slate-100 ${on ? 'bg-purple-50' : ''}`}>
                  <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setSel((s) => { const x = { ...s }; if (on) delete x[l.grn_line_id]; else x[l.grn_line_id] = l.balance_kg; return x; })} /></td>
                  <td className="px-2 py-1 font-semibold">{l.io_no || 'STOCK'}</td><td className="px-2 py-1 font-mono">{l.lot_no}</td><td className="px-2 py-1">{l.cone_no || '—'}</td><td className="px-2 py-1">{l.yarn_name}</td>
                  <td className="px-2 py-1">{l.shade || '—'}</td><td className="px-2 py-1 font-mono">{l.return_no || l.source_doc || '—'}</td><td className="px-2 py-1 text-right">{kg(l.balance_kg)}</td>
                  <td className="px-2 py-1 text-right">{on ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={sel[l.grn_line_id]} onChange={(e) => setSel((s) => ({ ...s, [l.grn_line_id]: r3(Number(e.target.value)) }))} /> : '—'}</td>
                </tr>
              );
            })}
            {!lots.length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">{head.source_type === 'RETURN' ? 'Choose a return with open KG' : 'No GRN reject cones in stock'}</td></tr>}
          </tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={8} className="px-2 py-2 text-right">Reprocess qty</td><td className="px-2 py-2 text-right">{kg(qty)}</td></tr></tfoot>
        </table>
      </div>
      <div className="card mb-3 p-4"><h3 className="mb-3 text-[13px] font-semibold text-slate-800">Billing — Billable / Non-billable</h3><BillingFields b={b} setB={setB} qty={qty} reasons={(reasons.data ?? []).filter((r) => r.kind !== 'RETURN')} /></div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" loading={busy} onClick={() => save(false)}><Save size={14} className="mr-1" /> Save</Button>
        {can('YARN_PROCESS.CONFIRM') && can('YARN_PROCESS.BILLING_APPROVE') && <Button loading={busy} onClick={() => save(true)}><CheckCircle2 size={14} className="mr-1" /> Approve & issue reprocess DC</Button>}
      </div>
      {!can('YARN_PROCESS.BILLING_APPROVE') && <p className="mt-2 text-right text-[11.5px] text-slate-500">Saved as a request — a Process Manager approves the billing before the reprocess DC is issued.</p>}
    </div>
  );
}

function ReprocessView({ id, onBack }: { id: number; onBack: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const reasons = useReasons();
  const q = useQuery({ queryKey: ['yarn-process', 'reprocess', id], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/reprocess/${id}`)).data });
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [b, setBState] = useState<any>(null);
  const [why, setWhy] = useState('');
  const r = q.data;
  if (!r) return <LoadingBlock />;
  const act = async (fn: () => Promise<any>) => { setBusy(true); try { const x = await fn(); toast(x?.message ?? 'Done', 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); } };
  return (
    <div>
      <YpTitle no={4} title={`Yarn Reprocess — ${r.reprocess_no}`} sub={`${r.process_name ?? r.process_code} · ${r.vendor_name} · ${r.reason ?? ''}`}
        actions={<><YpStatus value={r.status} />
          {r.status === 'DRAFT' && can('YARN_PROCESS.BILLING_APPROVE') && <Button variant="secondary" loading={busy} onClick={() => act(() => http.post(`/yarn-process/reprocess/${id}/approve`, {}))}><BadgeCheck size={14} className="mr-1" /> Approve</Button>}
          {r.status === 'APPROVED' && can('YARN_PROCESS.CONFIRM') && <Button loading={busy} onClick={() => act(() => http.post(`/yarn-process/reprocess/${id}/confirm`, {}))}><CheckCircle2 size={14} className="mr-1" /> Issue reprocess DC</Button>}
          {['DRAFT', 'APPROVED'].includes(r.status) && can('YARN_PROCESS.REPROCESS') && <Button variant="danger" loading={busy} onClick={() => { if (window.confirm(`Cancel ${r.reprocess_no}?`)) void act(() => http.post(`/yarn-process/reprocess/${id}/cancel`, {})); }}><Ban size={14} className="mr-1" /> Cancel</Button>}
          {can('YARN_PROCESS.BILLING_CHANGE') && r.status !== 'CANCELLED' && !r.contractor_bill_id && <Button variant="secondary" onClick={() => { setBState({ billing_type: r.billing_type, cost_treatment: r.cost_treatment, billing_reason_id: r.billing_reason_id ?? '', rate_per_kg: r.rate_per_kg, bill_amount: r.bill_amount, internal_cost: r.internal_cost }); setEdit(true); }}><Pencil size={14} className="mr-1" /> Change billing</Button>}
          {r.ypo_id && ['IN_PROCESS', 'INWARD_PENDING'].includes(r.status) && can('YARN_PROCESS.CREATE') && <Button onClick={() => nav(`/production/yarn-process/inward?ypo=${r.ypo_id}`)}>Receive reprocess (GRN)</Button>}
          <Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 text-xs md:grid-cols-6">
        {[['Date', fmtDate(r.reprocess_date)], ['Source', r.return_no ? `Return ${r.return_no}` : 'GRN reject'], ['Qty', `${kg(r.total_kg)} KG`], ['Billing type', r.billing_type.replace('_', '-')],
          ['Cost treatment', TREAT[r.cost_treatment] ?? r.cost_treatment], ['Rate / KG', `₹${fmtDecimal(r.rate_per_kg, 2)}`], ['Bill amount', `₹${fmtDecimal(r.bill_amount, 2)}`], ['Internal cost', `₹${fmtDecimal(r.internal_cost, 2)}`],
          ['Billing status', r.billing_status], ['Contractor bill', r.bill_no || '—'], ['Reprocess DC', r.ypo_no || '—'], ['Target shade', r.target_shade || '—']].map(([k, v]) => (
          <div key={k}><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div><div className="font-semibold">{v}</div></div>))}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'Lot', 'Cone', 'Yarn', 'Shade', 'KG'].map((h) => <th key={h} className={`px-2 py-2 ${h === 'KG' ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{r.lines.map((l: any) => <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{l.io_no || 'STOCK'}</td><td className="px-2 py-1 font-mono">{l.lot_no}</td><td className="px-2 py-1">{l.cone_no || '—'}</td><td className="px-2 py-1">{l.yarn_name}</td><td className="px-2 py-1">{l.shade || '—'}</td><td className="px-2 py-1 text-right">{kg(l.qty_kg)}</td></tr>)}</tbody>
        </table>
      </div>
      {r.billing_remarks && <pre className="card mt-3 whitespace-pre-wrap p-3 text-[11.5px] text-slate-600">{r.billing_remarks}</pre>}
      {edit && b && (
        <Modal open onClose={() => setEdit(false)} size="xl" title={`Change billing — ${r.reprocess_no}`}
          footer={<><Button variant="secondary" onClick={() => setEdit(false)}>Cancel</Button>
            <Button loading={busy} disabled={why.trim().length < 3} onClick={() => act(async () => { const x = await http.post(`/yarn-process/reprocess/${id}/billing`, { ...billingPayload(b), change_reason: why }); setEdit(false); return x; })}>Save change</Button></>}>
          <BillingFields b={b} setB={(p) => setBState((x: any) => ({ ...x, ...p }))} qty={n(r.total_kg)} reasons={(reasons.data ?? []).filter((x) => x.kind !== 'RETURN')} />
          <Input label="Reason for the change *" className="mt-3" value={why} onChange={(e) => setWhy(e.target.value)} />
          <p className="mt-2 text-[11.5px] text-slate-500">Old value, new value, reason and approver are kept in the audit trail.</p>
        </Modal>
      )}
    </div>
  );
}
