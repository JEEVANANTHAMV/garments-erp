import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Save, CheckCircle2, BadgeCheck, Pencil } from 'lucide-react';
import { http } from '../../../lib/api';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../lib/auth';
import { Button, Input, Select, Textarea, LoadingBlock, Modal } from '../../../components/ui';
import { fmtDate, fmtDecimal, today } from '../../../lib/format';
import { FpTitle, FpStatus, useProcessTypes, useReasons, errText, kg, n, r3, type StoreRoll } from './shared';

/**
 * Fabric Process — Reprocess (doc §8, §23–36): re-dye / re-wash … from a return (or from stock),
 * with the billing treatment kept apart from the physical reprocess:
 * Billable (on the contractor bill), Non-billable, Internal cost, Free, Recovery from contractor.
 * Confirm creates the reprocess DC; the reprocess GRN is posted on the Inward / GRN screen.
 */
const BILLING = [
  ['BILLABLE', 'Billable — contractor charge'], ['NON_BILLABLE', 'Non-billable'], ['INTERNAL_COST', 'Internal cost'],
  ['FREE', 'Free / no cost'], ['RECOVERY', 'Recovery from contractor'],
] as const;
const COST = [['CONTRACTOR_CHARGE', 'Contractor charge'], ['INTERNAL_COST', 'Internal cost'], ['FREE', 'Free / no cost'], ['RECOVERY', 'Recovery']] as const;

export default function FabricProcessReprocessPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  if (id === 'new') return <ReprocessEditor returnId={params.get('return') ? Number(params.get('return')) : null} onBack={() => setParams({})} onDone={(x) => setParams({ id: String(x) })} />;
  if (id) return <ReprocessView id={Number(id)} onBack={() => setParams({})} />;
  return <ReprocessList onOpen={(x) => setParams({ id: String(x) })} />;
}

function ReprocessList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const list = useQuery({ queryKey: ['fabric-process', 'reprocess'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/reprocess')).data ?? [] });
  return (
    <div>
      <FpTitle no={4} title="Reprocess" sub="Re-dye / re-wash / re-compact — billable or non-billable" actions={<Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Reprocess</Button>} />
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Reprocess no', 'Date', 'Process', 'Supplier / Vendor', 'Source', 'Jobs', 'Qty KG', 'Billing', 'Amount', 'Billing status', 'DC', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|Amount/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {(list.data ?? []).map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(r.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{r.reprocess_no}</td><td className="px-3 py-2">{fmtDate(r.reprocess_date)}</td>
                  <td className="px-3 py-2">{r.process_name}</td><td className="px-3 py-2">{r.vendor_name}</td><td className="px-3 py-2">{r.source_type === 'RETURN' ? `Return ${r.return_no}` : 'Stock'}</td>
                  <td className="px-3 py-2">{r.jobs || '—'}</td><td className="px-3 py-2 text-right">{kg(r.total_kg)}</td>
                  <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${r.billing_type === 'BILLABLE' ? 'bg-emerald-100 text-emerald-800' : r.billing_type === 'RECOVERY' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'}`}>{BILLING.find((b) => b[0] === r.billing_type)?.[1].split(' —')[0]}</span></td>
                  <td className="px-3 py-2 text-right">₹{fmtDecimal(r.bill_amount, 2)}</td><td className="px-3 py-2"><FpStatus value={r.billing_status} />{r.bill_no ? <span className="ml-1 font-mono text-[10px]">{r.bill_no}</span> : null}</td>
                  <td className="px-3 py-2 font-mono">{r.fpo_no || '—'}</td><td className="px-3 py-2"><FpStatus value={r.status} /></td>
                </tr>
              ))}
              {!(list.data ?? []).length && <tr><td colSpan={12} className="px-3 py-10 text-center text-slate-400">No reprocess entries yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function BillingFields({ b, setB, qty, reasons }: { b: any; setB: (p: any) => void; qty: number; reasons: { id: number; reason: string }[] }) {
  const billable = b.billing_type === 'BILLABLE' || b.billing_type === 'RECOVERY';
  const amount = n(b.bill_amount) > 0 ? n(b.bill_amount) : r3(n(b.rate_per_kg) * qty);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Select label="Billing type *" value={b.billing_type} onChange={(e) => {
        const t = e.target.value;
        setB({ billing_type: t, bill_required: t === 'BILLABLE' ? 'YES' : 'NO', cost_treatment: t === 'BILLABLE' ? 'CONTRACTOR_CHARGE' : t === 'RECOVERY' ? 'RECOVERY' : t === 'FREE' ? 'FREE' : 'INTERNAL_COST',
          ...(t === 'BILLABLE' || t === 'RECOVERY' ? {} : { rate_per_kg: 0, bill_amount: '' }) });
      }} options={BILLING.map(([v, l]) => ({ value: v, label: l }))} />
      <Select label="Bill required" value={b.bill_required} disabled={b.billing_type !== 'BILLABLE'} onChange={(e) => setB({ bill_required: e.target.value })} options={[{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }]} />
      <Select label="Billing reason" value={b.billing_reason_id} placeholder="—" onChange={(e) => setB({ billing_reason_id: e.target.value })} options={reasons.map((r) => ({ value: r.id, label: r.reason }))} />
      <Select label="Cost treatment" value={b.cost_treatment} onChange={(e) => setB({ cost_treatment: e.target.value })} options={COST.map(([v, l]) => ({ value: v, label: l }))} />
      <Input label="Rate / KG (₹)" type="number" step="0.01" value={b.rate_per_kg} disabled={!billable} onChange={(e) => setB({ rate_per_kg: e.target.value })} />
      <Input label={b.billing_type === 'RECOVERY' ? 'Amount to recover (₹)' : 'Bill amount (₹)'} type="number" step="0.01" value={billable ? (b.bill_amount === '' ? amount : b.bill_amount) : 0} disabled={!billable}
        hint={billable ? `${kg(qty)} KG × rate unless entered` : 'Excluded from contractor bills'} onChange={(e) => setB({ bill_amount: e.target.value })} />
      <Input label="Internal cost (₹)" type="number" step="0.01" value={b.internal_cost} hint="Chemical / handling cost — kept even when not billed" onChange={(e) => setB({ internal_cost: e.target.value })} />
      <Input label="Billing remarks" value={b.billing_remarks} onChange={(e) => setB({ billing_remarks: e.target.value })} />
    </div>
  );
}
const billingPayload = (b: any) => ({
  billing_type: b.billing_type, bill_required: b.bill_required === 'YES', billing_reason_id: b.billing_reason_id ? Number(b.billing_reason_id) : null, cost_treatment: b.cost_treatment || null,
  rate_per_kg: n(b.rate_per_kg), bill_amount: b.bill_amount === '' ? null : n(b.bill_amount), internal_cost: n(b.internal_cost), billing_remarks: b.billing_remarks || null,
});

function ReprocessEditor({ returnId, onBack, onDone }: { returnId: number | null; onBack: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const types = useProcessTypes();
  const reasons = useReasons();
  const suppliers = useLookup('suppliers');
  const returns = useQuery({ queryKey: ['fabric-process', 'returns'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/returns')).data ?? [] });
  const [head, setHead] = useState({ reprocess_date: today(), source_type: 'RETURN', return_id: returnId ? String(returnId) : '', sub_process: 'RE_DYEING', vendor_id: '', color_name: '', reason_id: '', remarks: '' });
  const [b, setBState] = useState<any>({ billing_type: 'NON_BILLABLE', bill_required: 'NO', billing_reason_id: '', cost_treatment: 'INTERNAL_COST', rate_per_kg: 0, bill_amount: '', internal_cost: 0, billing_remarks: '' });
  const setB = (p: any) => setBState((x: any) => ({ ...x, ...p }));
  const ret = useQuery({ queryKey: ['fabric-process', 'returns', head.return_id], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/returns/${head.return_id}`)).data, enabled: head.source_type === 'RETURN' && !!head.return_id });
  const stock = useQuery({ queryKey: ['fabric-process', 'store-rolls', 'returned'], queryFn: async () => (await http.get<{ data: StoreRoll[] }>('/fabric-process/store-rolls?returned=1')).data ?? [], enabled: head.source_type === 'STOCK' });
  const [sel, setSel] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ret.data) {
      setHead((h) => ({ ...h, vendor_id: h.vendor_id || String(ret.data.vendor_id ?? ''), reason_id: h.reason_id || String(ret.data.reason_id ?? '') }));
      setSel(Object.fromEntries(ret.data.lines.filter((l: any) => n(l.qty_kg) - n(l.reprocessed_kg) > 0.0005).map((l: any) => [l.return_roll_id, r3(n(l.qty_kg) - n(l.reprocessed_kg))])));
    }
  }, [ret.data]);
  const rows: { roll_id: number; roll_no: string; io_no: string | null; color: string | null; eligible: number }[] = head.source_type === 'RETURN'
    ? (ret.data?.lines ?? []).map((l: any) => ({ roll_id: l.return_roll_id, roll_no: `${l.roll_no}-R`, io_no: l.io_no, color: l.color_name, eligible: r3(n(l.qty_kg) - n(l.reprocessed_kg)) })).filter((r: any) => r.eligible > 0.0005)
    : (stock.data ?? []).map((r) => ({ roll_id: r.id, roll_no: r.roll_no, io_no: r.io_no, color: r.color_name, eligible: r.balance_kg }));
  const qty = rows.filter((r) => sel[r.roll_id] !== undefined).reduce((a, r) => a + n(sel[r.roll_id]), 0);
  const save = async (confirm: boolean) => {
    if (!head.vendor_id || !head.reason_id) { toast('Choose the process unit and the reason', 'warning'); return; }
    const lines = rows.filter((r) => sel[r.roll_id] !== undefined && n(sel[r.roll_id]) > 0);
    if (!lines.length) { toast('Pick the rolls to reprocess', 'warning'); return; }
    setBusy(true);
    try {
      const r = await http.post<{ data: any; message: string }>('/fabric-process/reprocess', {
        ...head, return_id: head.source_type === 'RETURN' ? Number(head.return_id) : null, vendor_id: Number(head.vendor_id), reason_id: Number(head.reason_id), confirm,
        ...billingPayload(b), lines: lines.map((l) => ({ source_roll_id: l.roll_id, qty_kg: n(sel[l.roll_id]) })),
      });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['fabric-process'] }); onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div>
      <FpTitle no={4} title="New Reprocess" actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Input label="Reprocess date *" type="date" value={head.reprocess_date} onChange={(e) => setHead({ ...head, reprocess_date: e.target.value })} />
        <Select label="Source *" value={head.source_type} onChange={(e) => { setHead({ ...head, source_type: e.target.value }); setSel({}); }} options={[{ value: 'RETURN', label: 'From return' }, { value: 'STOCK', label: 'From stock (reject store)' }]} />
        {head.source_type === 'RETURN' && <Select label="Return no *" value={head.return_id} placeholder="— Return —" onChange={(e) => { setHead({ ...head, return_id: e.target.value }); setSel({}); }}
          options={(returns.data ?? []).filter((r) => n(r.total_kg) - n(r.reprocessed_kg) > 0.0005).map((r) => ({ value: r.id, label: `${r.return_no} · ${r.inward_no ?? ''} · ${kg(n(r.total_kg) - n(r.reprocessed_kg))} KG open` }))} />}
        <Select label="Process *" value={head.sub_process} onChange={(e) => setHead({ ...head, sub_process: e.target.value })} options={(types.data ?? []).filter((t) => t.is_reprocess).map((t) => ({ value: t.code, label: t.name }))} />
        <Select label="Process unit (Supplier / Vendor) *" value={head.vendor_id} placeholder="—" onChange={(e) => setHead({ ...head, vendor_id: e.target.value })} options={toOptions(suppliers.data)} />
        <Input label="New colour" value={head.color_name} onChange={(e) => setHead({ ...head, color_name: e.target.value })} />
        <Select label="Reason *" value={head.reason_id} placeholder="—" onChange={(e) => setHead({ ...head, reason_id: e.target.value })} options={(reasons.data ?? []).map((r) => ({ value: r.id, label: r.reason }))} />
        <Textarea label="Remarks" className="col-span-2 md:col-span-5" rows={1} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </div>
      <div className="card mb-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['', 'Job', 'Source roll', 'Colour', 'Eligible KG', 'Reprocess KG'].map((h, i) => <th key={i} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => {
              const on = sel[r.roll_id] !== undefined;
              return (
                <tr key={r.roll_id} className={`border-t border-slate-100 ${on ? 'bg-purple-50/60' : ''}`}>
                  <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setSel((s) => { const c = { ...s }; if (on) delete c[r.roll_id]; else c[r.roll_id] = r.eligible; return c; })} /></td>
                  <td className="px-2 py-1 font-semibold">{r.io_no || '—'}</td><td className="px-2 py-1 font-mono">{r.roll_no}</td><td className="px-2 py-1">{r.color || '—'}</td>
                  <td className="px-2 py-1 text-right">{kg(r.eligible)}</td>
                  <td className="px-2 py-1 text-right">{on ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={sel[r.roll_id]} onChange={(e) => setSel((s) => ({ ...s, [r.roll_id]: Number(e.target.value) }))} /> : '—'}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">{head.source_type === 'RETURN' ? 'Choose a return with open KG' : 'No returned / rejected rolls in stock'}</td></tr>}
          </tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={5} className="px-2 py-2 text-right">Reprocess qty</td><td className="px-2 py-2 text-right">{kg(qty)}</td></tr></tfoot>
        </table>
      </div>
      <div className="card mb-3 p-4">
        <h3 className="mb-3 text-[13px] font-semibold text-slate-800">Billing details</h3>
        <BillingFields b={b} setB={setB} qty={qty} reasons={(reasons.data ?? []).filter((r) => r.kind !== 'RETURN')} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" loading={busy} onClick={() => save(false)}><Save size={14} className="mr-1" /> Save Draft</Button>
        <Button loading={busy} onClick={() => save(true)}><CheckCircle2 size={14} className="mr-1" /> Confirm Reprocess</Button>
      </div>
    </div>
  );
}

function ReprocessView({ id, onBack }: { id: number; onBack: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { can } = useAuth() as any;
  const reasons = useReasons();
  const q = useQuery({ queryKey: ['fabric-process', 'reprocess', id], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/reprocess/${id}`)).data });
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [b, setBState] = useState<any>(null);
  const [why, setWhy] = useState('');
  const r = q.data;
  if (!r) return <LoadingBlock />;
  const act = async (fn: () => Promise<any>) => { setBusy(true); try { const x = await fn(); toast(x?.message ?? 'Done', 'success'); void qc.invalidateQueries({ queryKey: ['fabric-process'] }); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); } };
  const openEdit = () => { setBState({ billing_type: r.billing_type, bill_required: r.bill_required ? 'YES' : 'NO', billing_reason_id: r.billing_reason_id ? String(r.billing_reason_id) : '', cost_treatment: r.cost_treatment ?? 'INTERNAL_COST', rate_per_kg: n(r.rate_per_kg), bill_amount: n(r.bill_amount) || '', internal_cost: n(r.internal_cost), billing_remarks: '' }); setWhy(''); setEdit(true); };
  const isManager = typeof can === 'function' ? can('PRODUCTION.APPROVE') : true;
  return (
    <div>
      <FpTitle no={4} title={`Reprocess — ${r.reprocess_no}`} sub={`${r.process_name} · ${r.vendor_name} · ${r.source_type === 'RETURN' ? `from return ${r.return_no}` : 'from stock'} · ${r.reason}`}
        actions={<><FpStatus value={r.status} /><Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 text-xs md:grid-cols-6">
        {[['Qty', `${kg(r.total_kg)} KG`], ['Billing type', BILLING.find((x) => x[0] === r.billing_type)?.[1]], ['Bill required', r.bill_required ? 'Yes' : 'No'], ['Billing reason', r.billing_reason || '—'],
          ['Rate / KG', `₹${fmtDecimal(r.rate_per_kg, 2)}`], [r.billing_type === 'RECOVERY' ? 'Recovery amount' : 'Bill amount', `₹${fmtDecimal(r.bill_amount, 2)}`], ['Cost treatment', COST.find((x) => x[0] === r.cost_treatment)?.[1] ?? '—'],
          ['Internal cost', `₹${fmtDecimal(r.internal_cost, 2)}`], ['Billing status', <FpStatus key="b" value={r.billing_status} />], ['Contractor bill', r.bill_no || '—'], ['Reprocess DC', r.fpo_no || '—'], ['DC status', r.dc_status ? <FpStatus key="d" value={r.dc_status} /> : '—']].map(([k, v]) => (
          <div key={String(k)}><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div><div className="font-semibold">{v}</div></div>))}
      </div>
      {r.billing_remarks && <pre className="card mb-3 whitespace-pre-wrap p-3 text-[11px] text-slate-600">{r.billing_remarks}</pre>}
      <div className="card mb-3 overflow-x-auto">
        <table className="w-full text-xs"><thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'Source roll', 'Colour', 'Qty KG'].map((h) => <th key={h} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{r.lines.map((l: any) => <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{l.io_no || '—'}</td><td className="px-2 py-1 font-mono">{l.roll_no}</td><td className="px-2 py-1">{l.color_name || '—'}</td><td className="px-2 py-1 text-right">{kg(l.qty_kg)}</td></tr>)}</tbody></table>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {r.status === 'DRAFT' && <Button loading={busy} onClick={() => act(() => http.post(`/fabric-process/reprocess/${id}/confirm`, {}))}><CheckCircle2 size={14} className="mr-1" /> Confirm Reprocess</Button>}
        {['BILLABLE', 'RECOVERY'].includes(r.billing_type) && r.billing_status === 'PENDING' && isManager && <Button variant="secondary" loading={busy} onClick={() => act(() => http.post(`/fabric-process/reprocess/${id}/approve-billing`, {}))}><BadgeCheck size={14} className="mr-1" /> Approve billing</Button>}
        {isManager && r.status !== 'CANCELLED' && <Button variant="secondary" onClick={openEdit}><Pencil size={14} className="mr-1" /> Change billing</Button>}
        {r.fpo_id && ['IN_PROCESS'].includes(r.status) && <Button onClick={() => nav(`/production/fabric-process/inward?fpo=${r.fpo_id}`)}>Receive reprocess (GRN)</Button>}
      </div>
      {edit && b && (
        <Modal open onClose={() => setEdit(false)} size="xl" title={`Change billing — ${r.reprocess_no}`}
          footer={<><Button variant="secondary" onClick={() => setEdit(false)}>Cancel</Button>
            <Button loading={busy} disabled={why.trim().length < 3} onClick={() => act(async () => { const x = await http.post(`/fabric-process/reprocess/${id}/billing`, { ...billingPayload(b), change_reason: why }); setEdit(false); return x; })}>Save change</Button></>}>
          <p className="mb-3 text-xs text-slate-600">The old and new billing type and the reason are logged. A reprocess already on a contractor bill needs the bill cancelled first.</p>
          <BillingFields b={b} setB={(p: any) => setBState((x: any) => ({ ...x, ...p }))} qty={n(r.total_kg)} reasons={(reasons.data ?? []).filter((x) => x.kind !== 'RETURN')} />
          <Input className="mt-3" label="Reason for the change *" value={why} onChange={(e) => setWhy(e.target.value)} />
        </Modal>
      )}
    </div>
  );
}
