import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Save, Printer, CheckCircle2, Ban } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Textarea, Modal, DataTable } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';

/**
 * Process master (client review 24-Sep-2026): processes, the operations inside
 * each process (power table, singer, overlock …) with default rates, and each
 * contractor's rate per operation. Contractor bills pass process inwards for
 * payment.
 */

const errMsg = (e: any) => e?.message || 'Request failed';
const num = (v: unknown) => Number(v ?? 0) || 0;
const money = (v: unknown) => `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Stage = {
  id: number; stage_code: string; stage_name: string; sort_order: number; is_outsourceable: number;
  bill_include_mistake: number; is_active: number; operations: Operation[];
};
type Operation = { id: number; stage_id: number; op_code: string; op_name: string; default_rate: number; sort_order: number; is_active: number };

function useContractors() {
  const [rows, setRows] = useState<{ id: number; label: string; is_contractor: number }[]>([]);
  useEffect(() => { api.get('/process-dcs/contractors').then((r) => setRows(r.data.data || [])).catch(() => setRows([])); }, []);
  return rows;
}

// ════════════════════════════════════════════════════════════════════
// Process & operations master
// ════════════════════════════════════════════════════════════════════
export function ProcessMasterPage() {
  const toast = useToast();
  const [tab, setTab] = useState<'process' | 'rates'>('process');
  const [stages, setStages] = useState<Stage[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [editStage, setEditStage] = useState<Partial<Stage> | null>(null);
  const [editOp, setEditOp] = useState<Partial<Operation> | null>(null);

  const load = () => api.get('/process-master').then((r) => {
    const rows: Stage[] = r.data.data || [];
    setStages(rows);
    setSelId((cur) => cur ?? rows.find((x) => /STITCH/.test(x.stage_code))?.id ?? rows[0]?.id ?? null);
  }).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { load(); }, []);
  const sel = stages.find((x) => x.id === selId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Process &amp; Operations</h1>
          <p className="text-sm text-slate-500">Processes, the operations inside each (power table, singer, overlock …) and contractor rates per operation</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {([['process', 'Processes & operations'], ['rates', 'Contractor rates']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${tab === k ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>{l}</button>
          ))}
        </div>
      </div>

      {tab === 'process' ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-2" title="Processes"
            actions={<Button size="sm" onClick={() => setEditStage({ stage_code: '', stage_name: '', sort_order: (stages.at(-1)?.sort_order ?? 0) + 1, is_outsourceable: 1, bill_include_mistake: 0, is_active: 1 })}>
              <Plus size={13} className="inline mr-1" />Process</Button>}>
            <div className="divide-y divide-slate-100">
              {stages.map((st) => (
                <button key={st.id} onClick={() => setSelId(st.id)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm ${st.id === selId ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
                  <span className="w-8 text-xs text-slate-400">{st.sort_order}</span>
                  <span className="flex-1">
                    <span className="font-semibold text-slate-800">{st.stage_name}</span>
                    <span className="ml-2 font-mono text-[11px] text-slate-400">{st.stage_code}</span>
                  </span>
                  {!!st.bill_include_mistake && <Badge tone="amber">Bill incl. mistake</Badge>}
                  {!st.is_active && <Badge tone="slate">Inactive</Badge>}
                  <span className="text-xs text-slate-500">{st.operations.length} ops</span>
                </button>
              ))}
            </div>
          </Card>

          <Card className="lg:col-span-3" title={sel ? `${sel.stage_name} — operations` : 'Operations'}
            subtitle="A DC for this process picks the operations it is sent for; the DC rate is their sum"
            actions={sel && <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditStage(sel)}><Pencil size={13} className="inline mr-1" />Edit process</Button>
              <Button size="sm" onClick={() => setEditOp({ stage_id: sel.id, op_code: '', op_name: '', default_rate: 0, sort_order: (sel.operations.at(-1)?.sort_order ?? 0) + 10, is_active: 1 })}>
                <Plus size={13} className="inline mr-1" />Operation</Button>
            </div>}>
            <DataTable data={sel?.operations ?? []} emptyTitle="No operations yet"
              emptyMessage="Add the operations of this process, e.g. Power Table, Singer, Overlock."
              onRowClick={(o: any) => setEditOp(o)}
              columns={[
                { key: 'sort_order', header: '#', render: (o: any) => <span className="text-slate-400">{o.sort_order}</span> },
                { key: 'op_name', header: 'Operation', render: (o: any) => <span className="font-medium">{o.op_name}</span> },
                { key: 'op_code', header: 'Code', render: (o: any) => <span className="font-mono text-[11px]">{o.op_code}</span> },
                { key: 'default_rate', header: 'Default rate (₹ / PCS)', align: 'right' as const, render: (o: any) => num(o.default_rate).toFixed(2) },
                { key: 'is_active', header: 'Status', render: (o: any) => o.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge> },
              ]} />
          </Card>
        </div>
      ) : (
        <ContractorRates stages={stages} />
      )}

      {editStage && <StageModal stage={editStage} onClose={() => setEditStage(null)} onSaved={() => { setEditStage(null); load(); }} />}
      {editOp && <OperationModal op={editOp} stages={stages} onClose={() => setEditOp(null)} onSaved={() => { setEditOp(null); load(); }} />}
    </div>
  );
}

function StageModal({ stage, onClose, onSaved }: { stage: Partial<Stage>; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ ...stage });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const body = { ...f, sort_order: num(f.sort_order), is_outsourceable: !!f.is_outsourceable, bill_include_mistake: !!f.bill_include_mistake, is_active: !!f.is_active };
      if (stage.id) await api.put(`/process-master/stages/${stage.id}`, body); else await api.post('/process-master/stages', body);
      toast('Process saved'); onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} size="sm" title={stage.id ? `Edit ${stage.stage_name}` : 'New process'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} onClick={save}><Save size={13} className="inline mr-1" />Save</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Code" required value={f.stage_code} onChange={(e) => setF({ ...f, stage_code: e.target.value.toUpperCase() })} />
          <Input label="Sequence" type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} />
        </div>
        <Input label="Process name" required value={f.stage_name} onChange={(e) => setF({ ...f, stage_name: e.target.value })} />
        {([['is_outsourceable', 'Can go out on a DC (job work / contractor)'],
          ['bill_include_mistake', 'Bill passing includes mistake qty (contractor paid for rejects)'],
          ['is_active', 'Active']] as const).map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={!!f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked ? 1 : 0 })} />{l}
          </label>
        ))}
      </div>
    </Modal>
  );
}

function OperationModal({ op, stages, onClose, onSaved }: { op: Partial<Operation>; stages: Stage[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ ...op });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const body = { ...f, stage_id: Number(f.stage_id), default_rate: num(f.default_rate), sort_order: num(f.sort_order), is_active: !!f.is_active,
        op_code: f.op_code || String(f.op_name).toUpperCase().replace(/[^A-Z0-9]+/g, '_') };
      if (op.id) await api.put(`/process-master/operations/${op.id}`, body); else await api.post('/process-master/operations', body);
      toast('Operation saved'); onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} size="sm" title={op.id ? `Edit ${op.op_name}` : 'New operation'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} onClick={save}><Save size={13} className="inline mr-1" />Save</Button></>}>
      <div className="space-y-3">
        <Select label="Process" required value={f.stage_id} onChange={(e) => setF({ ...f, stage_id: e.target.value })}
          options={stages.map((s) => ({ value: s.id, label: s.stage_name }))} />
        <Input label="Operation name" required value={f.op_name} placeholder="e.g. Neck Folding" onChange={(e) => setF({ ...f, op_name: e.target.value })} />
        <div className="grid grid-cols-3 gap-3">
          <Input label="Code" value={f.op_code} placeholder="Auto" onChange={(e) => setF({ ...f, op_code: e.target.value.toUpperCase() })} />
          <Input label="Default rate (₹ / PCS)" type="number" min={0} step="0.01" value={f.default_rate} onChange={(e) => setF({ ...f, default_rate: e.target.value })} />
          <Input label="Sequence" type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={!!f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked ? 1 : 0 })} />Active
        </label>
      </div>
    </Modal>
  );
}

/** Rate per operation for one contractor (blank = operation default rate). */
function ContractorRates({ stages }: { stages: Stage[] }) {
  const toast = useToast();
  const contractors = useContractors();
  const [vendorId, setVendorId] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [edit, setEdit] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!vendorId) { setRows([]); return; }
    api.get('/process-master/operations', { params: { vendor_id: vendorId } }).then((r) => {
      const d = r.data.data || [];
      setRows(d);
      setEdit(Object.fromEntries(d.map((o: any) => [o.id, o.contractor_rate != null ? String(Number(o.contractor_rate)) : ''])));
    }).catch((e) => toast(errMsg(e), 'error'));
  }, [vendorId]);

  const byStage = useMemo(() => stages.map((st) => ({ st, ops: rows.filter((o) => Number(o.stage_id) === st.id) })).filter((g) => g.ops.length), [rows, stages]);

  const save = async () => {
    setSaving(true);
    try {
      const rates = rows.map((o) => ({ operation_id: o.id, rate: edit[o.id] === '' ? null : Number(edit[o.id]) }));
      const r = await api.put('/process-master/contractor-rates', { vendor_id: Number(vendorId), rates });
      setRows(r.data.data || []);
      toast('Contractor rates saved');
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Card title="Contractor rates per operation" subtitle="A DC for this contractor picks these rates; blank uses the operation's default rate"
      actions={vendorId && <Button size="sm" loading={saving} onClick={save}><Save size={13} className="inline mr-1" />Save rates</Button>}>
      <div className="p-4">
        <Select label="Contractor" value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="— choose contractor —"
          options={contractors.map((c) => ({ value: c.id, label: c.label }))} className="max-w-md" />
        {vendorId && byStage.map(({ st, ops }) => (
          <div key={st.id} className="mt-4">
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">{st.stage_name}</p>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr>
                <th className="px-3 py-1.5 text-left">Operation</th><th className="px-3 py-1.5 text-right">Default (₹ / PCS)</th>
                <th className="px-3 py-1.5 text-right">Contractor rate (₹ / PCS)</th>
              </tr></thead>
              <tbody>
                {ops.map((o) => (
                  <tr key={o.id} className="border-t border-slate-100">
                    <td className="px-3 py-1.5">{o.op_name}</td>
                    <td className="px-3 py-1.5 text-right text-slate-400">{num(o.default_rate).toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <input type="number" min={0} step="0.01" value={edit[o.id] ?? ''} placeholder={num(o.default_rate).toFixed(2)}
                        onChange={(e) => setEdit((cur) => ({ ...cur, [o.id]: e.target.value }))} className="input h-7 w-28 px-1.5 text-right" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════
// Contractor bills — pass process inwards for payment
// ════════════════════════════════════════════════════════════════════
const BILL_TONE: Record<string, string> = { DRAFT: 'amber', APPROVED: 'green', CANCELLED: 'red' };

export function ContractorBillsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const load = () => {
    setLoading(true);
    api.get('/contractor-bills').then((r) => setRows(r.data.data || []))
      .catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Contractor Bills</h1>
          <p className="text-sm text-slate-500">Pass process inwards of in-house contractors and job workers for payment — good PCS × DC rate, less TDS</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus size={14} className="inline mr-1" />New bill</Button>
      </div>
      <Card>
        <DataTable data={rows} loading={loading} emptyTitle="No contractor bills yet" onRowClick={(r: any) => setOpenId(r.id)}
          columns={[
            { key: 'bill_no', header: 'Bill no', render: (r: any) => <span className="font-mono text-[12px] font-semibold text-brand-700">{r.bill_no}</span> },
            { key: 'bill_date', header: 'Date', render: (r: any) => fmtDate(r.bill_date) },
            { key: 'vendor_name', header: 'Contractor', render: (r: any) => <span>{r.vendor_name}{r.is_contractor ? <Badge tone="amber" className="ml-1">In-house</Badge> : null}</span> },
            { key: 'period', header: 'Period', render: (r: any) => r.period_from || r.period_to ? `${fmtDate(r.period_from)} – ${fmtDate(r.period_to)}` : '—' },
            { key: 'line_count', header: 'Inwards', align: 'right' as const },
            { key: 'billed_qty', header: 'PCS', align: 'right' as const, render: (r: any) => fmtNumber(r.billed_qty) },
            { key: 'gross_amount', header: 'Gross', align: 'right' as const, render: (r: any) => money(r.gross_amount) },
            { key: 'gst_amount', header: 'GST', align: 'right' as const, render: (r: any) => num(r.gst_amount) ? money(r.gst_amount) : '—' },
            { key: 'tds_amount', header: 'TDS', align: 'right' as const, render: (r: any) => num(r.tds_amount) ? money(r.tds_amount) : '—' },
            { key: 'net_amount', header: 'Net payable', align: 'right' as const, render: (r: any) => <b>{money(r.net_amount)}</b> },
            { key: 'status', header: 'Status', render: (r: any) => <Badge tone={BILL_TONE[r.status] ?? 'slate'}>{r.status}</Badge> },
          ]} />
      </Card>
      {creating && <NewBillModal onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); load(); setOpenId(id); }} />}
      {openId && <BillDetail id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

function NewBillModal({ onClose, onSaved }: { onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const contractors = useContractors();
  const [f, setF] = useState<any>({ vendor_id: '', bill_date: today(), period_from: '', period_to: '', tds_pct: '1', gst_pct: '0', is_interstate: false, other_deduction_label: '', other_deduction: '', remarks: '' });
  const [rows, setRows] = useState<any[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!f.vendor_id) { setRows([]); return; }
    api.get('/contractor-bills/unbilled', { params: { vendor_id: f.vendor_id, from: f.period_from || undefined, to: f.period_to || undefined } })
      .then((r) => { const d = r.data.data || []; setRows(d); setPicked(new Set(d.map((x: any) => x.receipt_id))); })
      .catch((e) => toast(errMsg(e), 'error'));
  }, [f.vendor_id, f.period_from, f.period_to]);

  const sel = rows.filter((r) => picked.has(r.receipt_id));
  const gross = sel.reduce((a, r) => a + num(r.amount), 0);
  // Same order as the server: GST on the job-work value, TDS on the value before GST.
  const gst = Math.round(gross * num(f.gst_pct)) / 100;
  const tds = Math.round(gross * num(f.tds_pct)) / 100;
  const net = Math.round(gross + gst - tds - num(f.other_deduction));
  const unpriced = sel.some((r) => !num(r.rate));

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post('/contractor-bills', {
        ...f, vendor_id: Number(f.vendor_id), period_from: f.period_from || null, period_to: f.period_to || null,
        tds_pct: num(f.tds_pct), gst_pct: num(f.gst_pct), is_interstate: !!f.is_interstate,
        other_deduction: num(f.other_deduction), other_deduction_label: f.other_deduction_label || null,
        remarks: f.remarks || null, receipt_ids: [...picked],
      });
      toast(`Bill ${r.data.data.bill_no} saved`); onSaved(r.data.data.id);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} size="xl" title="New contractor bill"
      footer={<>
        <span className="mr-auto self-center text-sm text-slate-600">{sel.length} inwards · Gross <b>{money(gross)}</b> · Net <b>{money(net)}</b></span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={saving} disabled={!sel.length || net < 0} onClick={save}><Save size={13} className="inline mr-1" />Save bill</Button>
      </>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Select label="Contractor" required value={f.vendor_id} onChange={(e) => setF({ ...f, vendor_id: e.target.value })}
          placeholder="— choose —" options={contractors.map((c) => ({ value: c.id, label: c.label }))} className="md:col-span-2" />
        <Input label="Bill date" type="date" value={f.bill_date} onChange={(e) => setF({ ...f, bill_date: e.target.value })} />
        <Input label="TDS %" type="number" min={0} step="0.01" value={f.tds_pct} hint="194C: 1% individual / 2% others" onChange={(e) => setF({ ...f, tds_pct: e.target.value })} />
        <Input label="Inwards from" type="date" value={f.period_from} onChange={(e) => setF({ ...f, period_from: e.target.value })} />
        <Input label="Inwards to" type="date" value={f.period_to} onChange={(e) => setF({ ...f, period_to: e.target.value })} />
        <Input label="Other deduction" value={f.other_deduction_label} placeholder="e.g. Advance" onChange={(e) => setF({ ...f, other_deduction_label: e.target.value })} />
        <Input label="Deduction amount (₹)" type="number" min={0} step="0.01" value={f.other_deduction} onChange={(e) => setF({ ...f, other_deduction: e.target.value })} />
        <Select label="GST % (job work)" value={f.gst_pct} onChange={(e) => setF({ ...f, gst_pct: e.target.value })}
          options={['0', '5', '12', '18'].map((v) => ({ value: v, label: v === '0' ? 'No GST (unregistered / in-house)' : `${v}%` }))} />
        <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" checked={!!f.is_interstate} onChange={(e) => setF({ ...f, is_interstate: e.target.checked })} />Inter-state (IGST)
        </label>
      </div>
      {unpriced && <p className="mt-2 rounded bg-amber-50 px-3 py-1.5 text-xs text-amber-800">Some inwards come from DCs without a rate — they bill at ₹0. Set the rate on the DC or the contractor operation rates.</p>}
      <table className="mt-3 w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr>
          <th className="w-8 px-2 py-1.5">
            <input type="checkbox" checked={rows.length > 0 && picked.size === rows.length}
              onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.receipt_id)) : new Set())} />
          </th>
          <th className="px-2 py-1.5 text-left">Inward</th><th className="px-2 py-1.5 text-left">Date</th><th className="px-2 py-1.5 text-left">DC</th>
          <th className="px-2 py-1.5 text-left">Process / operations</th><th className="px-2 py-1.5 text-left">Jobs</th>
          <th className="px-2 py-1.5 text-right">Good</th><th className="px-2 py-1.5 text-right">Mistake</th><th className="px-2 py-1.5 text-right">Billed PCS</th>
          <th className="px-2 py-1.5 text-right">Rate</th><th className="px-2 py-1.5 text-right">Amount</th>
        </tr></thead>
        <tbody>
          {!f.vendor_id && <tr><td colSpan={11} className="py-6 text-center text-slate-400">Choose the contractor to see inwards not billed yet.</td></tr>}
          {f.vendor_id && !rows.length && <tr><td colSpan={11} className="py-6 text-center text-slate-400">No unbilled inwards for this contractor.</td></tr>}
          {rows.map((r) => (
            <tr key={r.receipt_id} className="border-t border-slate-100">
              <td className="px-2 py-1 text-center">
                <input type="checkbox" checked={picked.has(r.receipt_id)} onChange={() => setPicked((cur) => {
                  const s = new Set(cur); if (s.has(r.receipt_id)) s.delete(r.receipt_id); else s.add(r.receipt_id); return s;
                })} />
              </td>
              <td className="px-2 py-1 font-mono">{r.receipt_no}</td><td className="px-2 py-1">{fmtDate(r.receipt_date)}</td>
              <td className="px-2 py-1 font-mono">{r.challan_no}</td>
              <td className="px-2 py-1">{r.stage_name}{r.operations && <span className="block text-[11px] text-slate-400">{r.operations}</span>}</td>
              <td className="px-2 py-1">{r.io_list ?? '—'}</td>
              <td className="px-2 py-1 text-right">{fmtNumber(r.received_qty)}</td>
              <td className="px-2 py-1 text-right">{num(r.rejected_qty) ? <>{fmtNumber(r.rejected_qty)}{num(r.bill_include_mistake) ? '' : <span className="text-slate-400"> (not paid)</span>}</> : '—'}</td>
              <td className="px-2 py-1 text-right font-semibold">{fmtNumber(r.billed_qty)}</td>
              <td className={`px-2 py-1 text-right ${num(r.rate) ? '' : 'text-amber-700'}`}>{num(r.rate).toFixed(2)}</td>
              <td className="px-2 py-1 text-right font-semibold">{money(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 ml-auto w-72 space-y-1 text-sm">
        <div className="flex justify-between"><span>Gross</span><span>{money(gross)}</span></div>
        {gst > 0 && (f.is_interstate
          ? <div className="flex justify-between"><span>IGST ({num(f.gst_pct)}%)</span><span>+ {money(gst)}</span></div>
          : <><div className="flex justify-between"><span>CGST ({num(f.gst_pct) / 2}%)</span><span>+ {money(gst / 2)}</span></div>
              <div className="flex justify-between"><span>SGST ({num(f.gst_pct) / 2}%)</span><span>+ {money(gst / 2)}</span></div></>)}
        <div className="flex justify-between text-red-600"><span>TDS ({num(f.tds_pct)}%)</span><span>− {money(tds)}</span></div>
        {num(f.other_deduction) > 0 && <div className="flex justify-between text-red-600"><span>{f.other_deduction_label || 'Other deduction'}</span><span>− {money(f.other_deduction)}</span></div>}
        <div className="flex justify-between border-t border-slate-200 pt-1 font-bold"><span>Net payable</span><span>{money(net)}</span></div>
      </div>
      <Textarea label="Remarks" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} rows={2} className="mt-3" />
    </Modal>
  );
}

function BillDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [b, setB] = useState<any>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/contractor-bills/${id}`).then((r) => setB(r.data.data)).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { load(); }, [id]);

  const act = async (path: string, body: any, msg: string) => {
    setBusy(true);
    try { await api.post(`/contractor-bills/${id}/${path}`, body); await load(); toast(msg); onChanged(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  if (!b) return <Modal open onClose={onClose} title="Contractor bill"><p className="text-sm text-slate-500">Loading…</p></Modal>;
  return (
    <Modal open onClose={onClose} size="xl" title={`Contractor bill ${b.bill_no}`}
      footer={<>
        {b.status !== 'CANCELLED' && <Button variant="danger" className="mr-auto" disabled={busy} onClick={() => { setReason(''); setCancelling(true); }}><Ban size={13} className="inline mr-1" />Cancel bill</Button>}
        <Button variant="secondary" onClick={() => printBill(b)}><Printer size={13} className="inline mr-1" />Print</Button>
        {b.status === 'DRAFT' && <Button loading={busy} onClick={() => act('approve', {}, 'Bill approved')}><CheckCircle2 size={13} className="inline mr-1" />Approve</Button>}
      </>}>
      <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div><p className="text-[11px] uppercase text-slate-400">Contractor</p><p className="font-medium">{b.vendor_name}</p></div>
        <div><p className="text-[11px] uppercase text-slate-400">Bill date</p><p className="font-medium">{fmtDate(b.bill_date)}</p></div>
        <div><p className="text-[11px] uppercase text-slate-400">Status</p><Badge tone={BILL_TONE[b.status] ?? 'slate'}>{b.status}</Badge></div>
        <div><p className="text-[11px] uppercase text-slate-400">Approved</p><p className="font-medium">{b.approved_by_name ?? '—'}</p></div>
      </div>
      {b.cancel_reason && <p className="mt-2 rounded bg-red-50 px-3 py-1.5 text-xs text-red-700">Cancelled: {b.cancel_reason}</p>}
      <table className="mt-3 w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr>
          <th className="px-2 py-1.5 text-left">Inward</th><th className="px-2 py-1.5 text-left">Date</th><th className="px-2 py-1.5 text-left">DC</th>
          <th className="px-2 py-1.5 text-left">Process / operations</th><th className="px-2 py-1.5 text-left">Jobs</th>
          <th className="px-2 py-1.5 text-right">Good</th><th className="px-2 py-1.5 text-right">Mistake</th><th className="px-2 py-1.5 text-right">Billed</th>
          <th className="px-2 py-1.5 text-right">Rate</th><th className="px-2 py-1.5 text-right">Amount</th>
        </tr></thead>
        <tbody>
          {b.lines.map((l: any) => (
            <tr key={l.id} className="border-t border-slate-100">
              <td className="px-2 py-1 font-mono">{l.receipt_no}</td><td className="px-2 py-1">{fmtDate(l.receipt_date)}</td>
              <td className="px-2 py-1 font-mono">{l.challan_no}</td>
              <td className="px-2 py-1">{l.stage_name}{l.operations && <span className="block text-[11px] text-slate-400">{l.operations}</span>}</td>
              <td className="px-2 py-1">{l.io_list ?? '—'}</td>
              <td className="px-2 py-1 text-right">{fmtNumber(l.good_qty)}</td><td className="px-2 py-1 text-right">{fmtNumber(l.mistake_qty)}</td>
              <td className="px-2 py-1 text-right font-semibold">{fmtNumber(l.billed_qty)}</td>
              <td className="px-2 py-1 text-right">{num(l.rate).toFixed(2)}</td><td className="px-2 py-1 text-right font-semibold">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 ml-auto w-72 space-y-1 text-sm">
        <div className="flex justify-between"><span>Gross ({fmtNumber(b.billed_qty)} PCS)</span><span>{money(b.gross_amount)}</span></div>
        {num(b.gst_amount) > 0 && <div className="flex justify-between"><span>{b.is_interstate ? 'IGST' : 'CGST + SGST'} ({num(b.gst_pct)}%)</span><span>+ {money(b.gst_amount)}</span></div>}
        <div className="flex justify-between text-red-600"><span>TDS ({num(b.tds_pct)}%)</span><span>− {money(b.tds_amount)}</span></div>
        {num(b.other_deduction) > 0 && <div className="flex justify-between text-red-600"><span>{b.other_deduction_label || 'Other deduction'}</span><span>− {money(b.other_deduction)}</span></div>}
        <div className="flex justify-between text-slate-500"><span>Round off</span><span>{num(b.round_off).toFixed(2)}</span></div>
        <div className="flex justify-between border-t border-slate-200 pt-1 font-bold"><span>Net payable</span><span>{money(b.net_amount)}</span></div>
      </div>
      {cancelling && (
        <Modal open onClose={() => setCancelling(false)} size="sm" title={`Cancel bill ${b.bill_no}`}
          footer={<><Button variant="secondary" onClick={() => setCancelling(false)}>Back</Button>
            <Button variant="danger" disabled={reason.trim().length < 3} onClick={() => { setCancelling(false); act('cancel', { reason }, 'Bill cancelled — its inwards can be billed again'); }}>Confirm</Button></>}>
          <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Modal>
      )}
    </Modal>
  );
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function printBill(b: any) {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return;
  const c = b.company ?? {};
  const rows = b.lines.map((l: any) => `<tr><td>${esc(l.receipt_no)}</td><td>${esc(fmtDate(l.receipt_date))}</td><td>${esc(l.challan_no)}</td>
    <td>${esc(l.stage_name)}${l.operations ? `<br/><small>${esc(l.operations)}</small>` : ''}</td><td>${esc(l.io_list ?? '')}</td>
    <td class="r">${l.good_qty}</td><td class="r">${l.mistake_qty}</td><td class="r">${l.billed_qty}</td><td class="r">${num(l.rate).toFixed(2)}</td><td class="r">${num(l.amount).toFixed(2)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><title>${esc(b.bill_no)}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;margin:18px} h1{font-size:16px;margin:0} h2{font-size:13px;text-align:center}
    table{width:100%;border-collapse:collapse;margin-top:8px} th,td{border:1px solid #444;padding:3px 5px} th{background:#eee;text-align:left}
    .r{text-align:right} small{color:#555} .tot td{border:none} .sign{display:flex;justify-content:space-between;margin-top:48px}
    .sign div{border-top:1px solid #111;width:30%;text-align:center;padding-top:4px} @media print{button{display:none}}
  </style></head><body>
    <h1>${esc(c.legal_name || c.trade_name)}</h1><div>${esc([c.address_line1, c.address_line2, c.city, c.state, c.pincode].filter(Boolean).join(', '))}</div>
    <h2>CONTRACTOR BILL — ${esc(b.bill_no)}</h2>
    <p><b>Contractor:</b> ${esc(b.vendor_name)} (${esc(b.vendor_code || '')}) · <b>Date:</b> ${esc(fmtDate(b.bill_date))}
      ${b.period_from || b.period_to ? ` · <b>Period:</b> ${esc(fmtDate(b.period_from))} – ${esc(fmtDate(b.period_to))}` : ''} · <b>Status:</b> ${esc(b.status)}</p>
    <table><thead><tr><th>Inward</th><th>Date</th><th>DC</th><th>Process / operations</th><th>Jobs</th><th class="r">Good</th><th class="r">Mistake</th>
      <th class="r">Billed PCS</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="tot" style="width:40%;margin-left:auto">
      <tr><td>Gross</td><td class="r">${num(b.gross_amount).toFixed(2)}</td></tr>
      ${num(b.gst_amount) ? (b.is_interstate
        ? `<tr><td>IGST (${num(b.gst_pct)}%)</td><td class="r">${num(b.gst_amount).toFixed(2)}</td></tr>`
        : `<tr><td>CGST (${num(b.gst_pct) / 2}%)</td><td class="r">${(num(b.gst_amount) / 2).toFixed(2)}</td></tr><tr><td>SGST (${num(b.gst_pct) / 2}%)</td><td class="r">${(num(b.gst_amount) / 2).toFixed(2)}</td></tr>`) : ''}
      <tr><td>TDS (${num(b.tds_pct)}%)</td><td class="r">- ${num(b.tds_amount).toFixed(2)}</td></tr>
      ${num(b.other_deduction) ? `<tr><td>${esc(b.other_deduction_label || 'Other deduction')}</td><td class="r">- ${num(b.other_deduction).toFixed(2)}</td></tr>` : ''}
      <tr><td>Round off</td><td class="r">${num(b.round_off).toFixed(2)}</td></tr>
      <tr><td><b>Net payable</b></td><td class="r"><b>${num(b.net_amount).toFixed(2)}</b></td></tr></table>
    <div class="sign"><div>Prepared by</div><div>Approved by</div><div>Contractor's signature</div></div>
    <button onclick="window.print()" style="margin-top:16px">Print</button></body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
}
