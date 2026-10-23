import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus, Search } from 'lucide-react';
import clsx from 'clsx';
import { Card, Button, Input, Select, Textarea, Modal, Badge, LoadingBlock } from '../../components/ui';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate, fmtDateTime, fmtNumber, today } from '../../lib/format';
import { COST_CATEGORIES, COST_STATUS_TONE, ALLOC_STATUS_TONE, ALLOC_METHODS, catLabel, Kpi, ReasonModal, inr, errMsg, AllocState } from './sampleShared';

/**
 * Costing and order-allocation tabs of a sample (spec §6.5, §6.7, §9, §9.1). Costs: Draft → Submitted → Approved →
 * Posted; posted costs are reversed, never edited. Allocation: the server splits the posted, eligible, unallocated
 * cost over confirmed orders; Draft → Pending approval → Approved → Posted → (partly) reversed.
 */

/* ================================================================ costing */
export function CostingTab({ s, refresh }: { s: any; refresh: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['sample-costs', s.id], queryFn: async () => http.get<{ data: any[]; summary: any }>(`/samples/${s.id}/costs`) });
  const [sel, setSel] = useState<number[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [importing, setImporting] = useState(false);
  const [reasonFor, setReasonFor] = useState<{ c: any; action: 'reject' | 'reverse' } | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = q.data?.data ?? [];
  const sum = q.data?.summary;
  const done = () => { setSel([]); void q.refetch(); refresh(); };
  const act = async (c: any, action: string, reason?: string) => {
    setBusy(true);
    try {
      const r = await http.post<{ data: any }>(`/samples/${s.id}/costs/${c.id}/${action}`, { reason });
      const done: Record<string, string> = { submit: 'submitted', approve: 'approved', post: 'posted', reject: 'rejected', reverse: 'reversed (negative entry posted)' };
      toast(r.data.warning ?? `Cost #${c.id} ${done[action] ?? action}`, r.data.warning ? 'error' : undefined);
      setReasonFor(null); done();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const bulk = async (action: string) => {
    setBusy(true);
    try { const r = await http.post<{ data: any }>(`/samples/${s.id}/costs-bulk`, { ids: sel, action }); toast(`${r.data.updated} cost(s) ${{ submit: 'submitted', approve: 'approved', post: 'posted' }[action] ?? action}`); done(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const del = async (c: any) => { try { await http.del(`/samples/${s.id}/costs/${c.id}`); toast('Draft deleted'); done(); } catch (e) { toast(errMsg(e), 'error'); } };
  const selRows = rows.filter((r) => sel.includes(r.id));
  const allIn = (st: string[]) => selRows.length > 0 && selRows.every((r) => st.includes(r.status));
  if (q.isLoading || !sum) return <div className="card"><LoadingBlock rows={6} /></div>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6" id="cost-summary">
        <Kpi label="Today's cost" value={inr(sum.today_cost, '₹ 0')} sub={`${inr(sum.today_cost_per_piece)} / requested piece`} />
        <Kpi label="Cumulative" value={inr(sum.cumulative_cost, '₹ 0')} sub={`as of ${fmtDate(sum.as_of)}`} tone="slate" />
        <Kpi label="Per requested piece" value={inr(sum.cost_per_piece)} sub={`${fmtNumber(sum.qty)} requested`} />
        <Kpi label="Per good piece" value={inr(sum.cost_per_good_piece)} sub={sum.good_qty == null ? 'no output yet' : `${fmtNumber(sum.good_qty)} good`} />
        <Kpi label="Avg / piece / day" value={inr(sum.avg_daily_cost_per_piece)} sub={`${sum.elapsed_days ?? '—'} days`} />
        <Kpi label="Waiting approval" value={inr(sum.pending_cost, '₹ 0')} sub={`${sum.costs_awaiting_approval} submitted / approved, not posted`} tone="amber" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="By category (approved / posted)" className="lg:col-span-1">
          <table className="w-full text-[12.5px]" id="cost-by-category">
            <tbody>
              {sum.by_category.length === 0 && <tr><td className="td text-center text-slate-400">No cost yet</td></tr>}
              {sum.by_category.map((c: any) => (
                <tr key={c.category}><td className="td">{catLabel(c.category)}{!c.eligible && <span className="ml-1 text-[10.5px] text-slate-400">not allocatable</span>}</td>
                  <td className="td text-right tabular-nums">{inr(c.amount, '₹ 0')}</td></tr>
              ))}
              <tr className="bg-slate-50 font-semibold"><td className="td">Total</td><td className="td text-right tabular-nums">{inr(sum.cumulative_cost, '₹ 0')}</td></tr>
              {Number(sum.recovered_amount) > 0 && <tr><td className="td text-slate-500">Paid by buyer</td><td className="td text-right tabular-nums text-slate-500">− {inr(sum.recovered_amount)}</td></tr>}
              <tr><td className="td text-slate-500">Posted, allocatable</td><td className="td text-right tabular-nums">{inr(sum.eligible_cost, '₹ 0')}</td></tr>
            </tbody>
          </table>
        </Card>
        <Card title="Daily cost" className="lg:col-span-2">
          <div className="flex h-32 items-end gap-1 p-4">
            {sum.daily.length === 0 && <p className="w-full text-center text-[12px] text-slate-400">No approved / posted cost yet</p>}
            {sum.daily.map((d: any) => {
              const max = Math.max(1, ...sum.daily.map((x: any) => Math.abs(x.amount)));
              return <div key={d.date} title={`${fmtDate(d.date)}: ${inr(d.amount)}`} className={clsx('min-w-[6px] flex-1 rounded-t', d.amount < 0 ? 'bg-red-400' : 'bg-brand-500')} style={{ height: `${Math.max(4, (Math.abs(d.amount) / max) * 100)}%` }} />;
            })}
          </div>
        </Card>
      </div>
      <Card title="Cost ledger" subtitle="Draft → submitted → approved → posted. Only posted cost can be allocated to orders; a posted cost is reversed, never edited."
        actions={<div className="flex flex-wrap gap-2">
          {can('SAMPLE.COST') && s.purchases_to_import > 0 && <Badge tone="amber">{s.purchases_to_import} purchase line(s) to import</Badge>}
          {can('SAMPLE.COST') && <Button size="sm" variant="secondary" id="cost-import" onClick={() => setImporting(true)}><Download size={13} />From purchases</Button>}
          {can('SAMPLE.COST') && <Button size="sm" id="cost-add" onClick={() => setEditing({})}><Plus size={13} />Add cost</Button>}
        </div>}>
        {sel.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[12.5px]" id="cost-bulk">
            <b>{sel.length} selected</b>
            {can('SAMPLE.COST') && allIn(['DRAFT']) && <Button size="sm" variant="secondary" loading={busy} onClick={() => void bulk('submit')}>Submit</Button>}
            {can('SAMPLE.COST_APPROVE') && allIn(['SUBMITTED']) && <Button size="sm" variant="secondary" loading={busy} onClick={() => void bulk('approve')}>Approve</Button>}
            {can('SAMPLE.COST_APPROVE') && allIn(['SUBMITTED', 'APPROVED']) && <Button size="sm" loading={busy} id="cost-bulk-post" onClick={() => void bulk('post')}>Approve &amp; post</Button>}
            <button className="text-slate-500" onClick={() => setSel([])}>clear</button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full" id="cost-ledger">
            <thead><tr><th className="th w-8" /><th className="th">Date</th><th className="th">Category</th><th className="th">Description / source</th><th className="th text-right">Qty × rate</th>
              <th className="th text-right">Amount ₹</th><th className="th">Status</th><th className="th">By</th><th className="th" /></tr></thead>
            <tbody>
              {!rows.length && <tr><td className="td py-8 text-center text-slate-400" colSpan={9}>No cost entered yet</td></tr>}
              {rows.map((c) => (
                <tr key={c.id} className={clsx('row-hover align-top', ['REJECTED', 'REVERSED'].includes(c.status) && 'opacity-60')} data-cost={c.id}>
                  <td className="td">{['DRAFT', 'SUBMITTED', 'APPROVED'].includes(c.status) && <input type="checkbox" checked={sel.includes(c.id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} />}</td>
                  <td className="td whitespace-nowrap text-[12px]">{fmtDate(c.cost_date)}</td>
                  <td className="td text-[12px]">{catLabel(c.category)}{c.basis !== 'ACTUAL' && <p className="text-[10.5px] text-amber-700">{c.basis.toLowerCase()}</p>}</td>
                  <td className="td max-w-[320px] text-[12px]"><p>{c.description}</p>
                    <p className="text-[11px] text-slate-500">{c.source_type === 'GENERAL_PURCHASE' ? `Purchase ${c.source_ref ?? ''}` : c.source_type === 'PROCESS_LABOUR' ? `Stage labour · ${c.stage_name ?? ''}` : c.source_type === 'REVERSAL' ? 'Reversal entry' : c.source_ref ?? ''}
                      {c.stage_name && c.source_type === 'MANUAL' ? ` · ${c.stage_name}` : ''}{c.currency_code && c.currency_code !== 'INR' ? ` · ${c.currency_code} ${fmtNumber(c.amount_fc, 2)} @ ${Number(c.exchange_rate)}` : ''}</p>
                    {c.reason && <p className="text-[11px] text-red-600">{c.status === 'REVERSED' ? 'Reversed' : c.reversal_of_id ? '' : 'Rejected'}{c.reversal_of_id ? '' : ': '}{c.reversal_of_id ? '' : c.reason}</p>}</td>
                  <td className="td text-right text-[12px] tabular-nums">{c.qty != null ? `${fmtNumber(c.qty, 2)} ${c.uom_code ?? ''} × ${fmtNumber(c.rate, 2)}` : '—'}</td>
                  <td className={clsx('td text-right tabular-nums font-semibold', Number(c.amount) < 0 && 'text-red-600')}>{fmtNumber(c.amount, 2)}</td>
                  <td className="td"><Badge tone={COST_STATUS_TONE[c.status] ?? 'slate'}>{c.status.toLowerCase()}</Badge></td>
                  <td className="td text-[11px] text-slate-500">{c.created_by_name}{c.posted_by_name ? <p>posted {c.posted_by_name}</p> : c.approved_by_name ? <p>appr. {c.approved_by_name}</p> : null}</td>
                  <td className="td whitespace-nowrap text-right">
                    {can('SAMPLE.COST') && ['DRAFT', 'SUBMITTED'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>Edit</Button>}
                    {can('SAMPLE.COST') && c.status === 'DRAFT' && <><Button size="sm" variant="ghost" onClick={() => void act(c, 'submit')}>Submit</Button><Button size="sm" variant="ghost" className="text-red-600" onClick={() => void del(c)}>Delete</Button></>}
                    {can('SAMPLE.COST_APPROVE') && c.status === 'SUBMITTED' && <Button size="sm" variant="ghost" onClick={() => void act(c, 'approve')}>Approve</Button>}
                    {can('SAMPLE.COST_APPROVE') && ['SUBMITTED', 'APPROVED'].includes(c.status) && <><Button size="sm" variant="ghost" id={`cost-post-${c.id}`} onClick={() => void act(c, 'post')}>Post</Button>
                      <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setReasonFor({ c, action: 'reject' })}>Reject</Button></>}
                    {can('SAMPLE.COST_APPROVE') && c.status === 'POSTED' && !c.reversal_of_id && <Button size="sm" variant="ghost" className="text-red-600" id={`cost-reverse-${c.id}`} onClick={() => setReasonFor({ c, action: 'reverse' })}>Reverse</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {editing && <CostModal s={s} c={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); done(); }} />}
      {importing && <ImportModal s={s} onClose={() => setImporting(false)} onDone={() => { setImporting(false); done(); }} />}
      <ReasonModal open={!!reasonFor} danger busy={busy} title={reasonFor?.action === 'reverse' ? `Reverse cost #${reasonFor?.c.id}` : `Reject cost #${reasonFor?.c.id}`}
        message={reasonFor?.action === 'reverse' ? <>A negative entry of {inr(-Number(reasonFor?.c.amount ?? 0))} is posted today; the original stays as history. If the cost is already allocated to orders, the allocation must be adjusted.</> : 'The entry is kept as rejected; its source line can be imported again.'}
        confirmLabel={reasonFor?.action === 'reverse' ? 'Reverse' : 'Reject'} onClose={() => setReasonFor(null)} onConfirm={(r) => reasonFor && void act(reasonFor.c, reasonFor.action, r)} />
    </div>
  );
}

function CostModal({ s, c, onClose, onDone }: { s: any; c: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const uoms = useLookup('uoms');
  const currencies = useLookup('currencies');
  const isNew = !c.id;
  const linked = !isNew && c.source_type !== 'MANUAL';
  const [v, setV] = useState<any>({
    cost_date: c.cost_date ?? today(), category: c.category ?? 'MATERIAL', description: c.description ?? '', process_id: c.process_id ?? '',
    qty: c.qty ?? '', uom_id: c.uom_id ?? '', rate: c.rate ?? '', amount_fc: c.amount_fc ?? '', currency_id: c.currency_id ?? '', exchange_rate: c.exchange_rate ?? '',
    basis: c.basis ?? 'ACTUAL', source_ref: c.source_ref ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const cur = (currencies.data ?? []).find((x) => String(x.id) === String(v.currency_id));
  const foreign = cur && cur.code !== 'INR';
  const computed = Number(v.qty) > 0 && Number(v.rate) > 0 ? Number(v.qty) * Number(v.rate) : Number(v.amount_fc) || 0;
  const inrAmt = computed * (foreign ? Number(v.exchange_rate) || 0 : 1);
  const procs = s.processes.filter((p: any) => p.status !== 'CANCELLED');
  const save = async (submit: boolean) => {
    setBusy(true);
    const n = (x: unknown) => (x === '' || x == null ? null : Number(x));
    const body = { ...v, process_id: n(v.process_id), qty: n(v.qty), uom_id: n(v.uom_id), rate: n(v.rate), amount_fc: n(v.amount_fc), currency_id: n(v.currency_id),
      exchange_rate: foreign ? n(v.exchange_rate) : null, source_ref: v.source_ref || null, submit };
    try {
      if (isNew) await http.post(`/samples/${s.id}/costs`, body); else await http.put(`/samples/${s.id}/costs/${c.id}`, body);
      toast(isNew ? `Cost entered${submit ? ' and submitted for approval' : ' as draft'}` : 'Cost updated');
      onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const catHint = COST_CATEGORIES.find((x) => x.value === v.category)?.hint;
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add sample cost' : `Edit cost #${c.id}`} subtitle={`${s.sample_no}${linked ? ' · linked to its source — the amount cannot change' : ''}`} size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        {(isNew || c.status === 'DRAFT') && <Button variant="secondary" loading={busy} onClick={() => void save(false)}>Save draft</Button>}
        <Button loading={busy} id="cost-save" onClick={() => void save(true)}>{isNew || c.status === 'DRAFT' ? 'Submit for approval' : 'Save'}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-4" id="cost-form">
        <Input label="Date" type="date" required value={v.cost_date} onChange={(e) => set('cost_date', e.target.value)} />
        <Select label="Category" required id="cost-category" value={v.category} onChange={(e) => set('category', e.target.value)} options={COST_CATEGORIES.map((x) => ({ value: x.value, label: x.label }))} hint={catHint} className="sm:col-span-2" />
        <Select label="Basis" value={v.basis} onChange={(e) => set('basis', e.target.value)} options={[{ value: 'ACTUAL', label: 'Actual' }, { value: 'STANDARD', label: 'Standard rate' }, ...(v.category === 'OVERHEAD' ? [{ value: 'ALLOCATED', label: 'Allocated (overhead)' }] : [])]} />
        <Input className="sm:col-span-3" label="Description" required id="cost-desc" value={v.description} onChange={(e) => set('description', e.target.value)} />
        <Select label="Stage" placeholder="—" options={procs.map((p: any) => ({ value: p.id, label: `${p.stage_name}${p.revision_no ? ` (rev ${p.revision_no})` : ''}` }))} value={v.process_id} onChange={(e) => set('process_id', e.target.value)} />
        <Input label="Qty" type="number" min={0} step="any" value={v.qty} disabled={linked} onChange={(e) => set('qty', e.target.value)} />
        <Select label="UOM" placeholder="—" options={toOptions(uoms.data)} value={v.uom_id} onChange={(e) => set('uom_id', e.target.value)} />
        <Input label="Rate" type="number" min={0} step="any" value={v.rate} disabled={linked} onChange={(e) => set('rate', e.target.value)} />
        <Input label="Amount" type="number" step="any" id="cost-amount" value={Number(v.qty) > 0 && Number(v.rate) > 0 ? computed.toFixed(2) : v.amount_fc} disabled={linked || (Number(v.qty) > 0 && Number(v.rate) > 0)}
          onChange={(e) => set('amount_fc', e.target.value)} hint={Number(v.qty) > 0 && Number(v.rate) > 0 ? 'qty × rate' : undefined} />
        <Select label="Currency" placeholder="INR" options={(currencies.data ?? []).map((x) => ({ value: x.id, label: String(x.code) }))} value={v.currency_id} disabled={linked} onChange={(e) => set('currency_id', e.target.value)} />
        {foreign && <Input label={`₹ per 1 ${cur?.code}`} type="number" min={0} step="any" required value={v.exchange_rate} disabled={linked} onChange={(e) => set('exchange_rate', e.target.value)} />}
        <Input label="Source document" value={v.source_ref} placeholder="Bill / DC / AWB no" onChange={(e) => set('source_ref', e.target.value)} className={foreign ? '' : 'sm:col-span-2'} />
        <p className="self-end text-right text-[13px] font-semibold text-slate-700 sm:col-span-4">= {inr(inrAmt, '₹ 0')}</p>
      </div>
    </Modal>
  );
}

function ImportModal({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['sample-cost-sources', s.id], queryFn: async () => (await http.get<{ data: any[] }>(`/samples/${s.id}/cost-sources`)).data });
  const rows = q.data ?? [];
  const [pick, setPick] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const chosen = Object.keys(pick).map(Number);
  const save = async () => {
    setBusy(true);
    try {
      const r = await http.post<{ data: any }>(`/samples/${s.id}/cost-sources/import`, { lines: chosen.map((id) => ({ line_id: id, category: pick[id] })) });
      toast(`${r.data.created} cost(s) imported and submitted for approval`); onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Costs from purchases booked to this sample" subtitle="General purchase lines with allocation Sample = this sample. Each line can be taken once." size="xl"
      footer={<><button className="btn-secondary" onClick={onClose}>Close</button><Button loading={busy} id="import-save" disabled={!chosen.length} onClick={() => void save()}>Import {chosen.length || ''}</Button></>}>
      {q.isLoading ? <LoadingBlock rows={3} /> : !rows.length ? (
        <p className="py-6 text-center text-[13px] text-slate-500">No purchase is booked to {s.sample_no}. In General Purchase, set a line's allocation to <b>Sample</b> and pick this sample.</p>
      ) : (
        <table className="w-full" id="import-list">
          <thead><tr><th className="th w-8" /><th className="th">Purchase</th><th className="th">Item</th><th className="th text-right">Qty × rate</th><th className="th text-right">Amount ₹</th><th className="th">Category</th><th className="th">State</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line_id} className={clsx('align-top', !r.importable && 'opacity-60')}>
                <td className="td">{r.importable && <input type="checkbox" checked={pick[r.line_id] !== undefined} onChange={(e) => { const n = { ...pick }; if (e.target.checked) n[r.line_id] = r.suggested_category; else delete n[r.line_id]; setPick(n); }} />}</td>
                <td className="td text-[12px]"><p className="font-mono">{r.doc_no}</p><p className="text-slate-500">{fmtDate(r.purchase_date)} · {r.supplier_name}</p></td>
                <td className="td text-[12px]">{r.item_description}<p className="text-slate-500">{String(r.material_type).toLowerCase()}{r.expense_head ? ` · ${r.expense_head}` : ''}</p></td>
                <td className="td text-right text-[12px] tabular-nums">{fmtNumber(r.qty, 2)} {r.uom_code} × {fmtNumber(r.rate, 2)}</td>
                <td className="td text-right tabular-nums">{fmtNumber(r.amount_inr, 2)}</td>
                <td className="td">{r.importable ? <select className="input h-8 py-0 text-[12px]" value={pick[r.line_id] ?? r.suggested_category} disabled={pick[r.line_id] === undefined}
                  onChange={(e) => setPick({ ...pick, [r.line_id]: e.target.value })}>{COST_CATEGORIES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select> : catLabel(r.suggested_category)}</td>
                <td className="td text-[12px]">{r.cost_id ? <Badge tone="green">in cost ({String(r.cost_status).toLowerCase()})</Badge> : !['APPROVED', 'POSTED'].includes(r.approval_state) ? <Badge tone="amber">purchase {String(r.approval_state ?? 'draft').toLowerCase()}</Badge> : <Badge tone="blue">ready</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/* ================================================================ allocation */
export function AllocationTab({ s, refresh }: { s: any; refresh: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['sample-allocs', s.id], queryFn: async () => http.get<{ data: any[]; balance: any }>(`/samples/${s.id}/allocations`) });
  const [wizard, setWizard] = useState<any | null>(null);
  const [reasonFor, setReasonFor] = useState<{ b: any; action: 'reject' | 'reverse' | 'cancel'; lineIds?: number[] } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const bal = q.data?.balance;
  const act = async (b: any, action: string, extra: any = {}) => {
    setBusy(b.id);
    try {
      const r = await http.post<{ data: any }>(`/sample-allocations/${b.id}/${action}`, { row_version: b.row_version, ...extra });
      toast(`${b.batch_no}: ${r.data.idempotent ? 'already posted' : (r.data.status ?? action).replace(/_/g, ' ').toLowerCase()}`);
      setReasonFor(null); void q.refetch(); refresh();
    } catch (e) { toast(errMsg(e), 'error'); void q.refetch(); } finally { setBusy(null); }
  };
  if (q.isLoading || !bal) return <div className="card"><LoadingBlock rows={5} /></div>;
  const canAllocate = can('SAMPLE.ALLOCATE') && !['DRAFT', 'CANCELLED'].includes(s.status);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" id="alloc-balance">
        <Kpi label="Posted, allocatable" value={inr(bal.eligible, '₹ 0')} sub="posted cost of allocatable categories − buyer-paid charge" />
        <Kpi label="Allocated (posted)" value={inr(bal.allocated, '₹ 0')} tone="green" />
        <Kpi label="Awaiting approval" value={inr(bal.reserved, '₹ 0')} tone="amber" />
        <Kpi label="Balance" value={inr(bal.unallocated, '₹ 0')} tone={bal.unallocated < 0 ? 'red' : 'blue'} sub={bal.unallocated < 0 ? 'over-allocated — reverse' : `${inr(bal.available, '₹ 0')} free to allocate`} />
        <div className="card flex flex-col justify-center gap-2 p-3.5">
          <AllocState value={s.metrics.allocation_state} />
          {canAllocate && <Button id="alloc-new" disabled={bal.available <= 0} onClick={() => setWizard({})}><Plus size={14} />Allocate to orders</Button>}
        </div>
      </div>
      {!['APPROVED', 'COMPLETED'].includes(s.status) && canAllocate && bal.available > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">The buyer has not approved this sample yet — an allocation now needs an override reason.</p>
      )}
      <p className="text-[12px] text-slate-500">Accounting mode: <b>analytical</b> — the allocation appears as "Sample dev" in the order's Budget vs Actuals / OCR; the sample cost ledger stays the source and no journal is posted, so the expense is never counted twice.</p>
      {(q.data?.data ?? []).length === 0 && <div className="card p-8 text-center text-[13px] text-slate-500">No allocation yet.</div>}
      {(q.data?.data ?? []).map((b) => (
        <Card key={b.id} title={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{b.batch_no}</span><Badge tone={ALLOC_STATUS_TONE[b.status] ?? 'slate'}>{b.status.replace(/_/g, ' ').toLowerCase()}</Badge>
          <span className="text-[12px] font-normal text-slate-500">{ALLOC_METHODS.find((x) => x.value === b.method)?.label} · {inr(b.total_allocated)} · {fmtDateTime(b.created_at)} {b.created_by_name}</span></span>}
          subtitle={<>{b.reason}{b.override_reason && <span className="text-amber-700"> · Override: {b.override_reason}</span>}{b.reject_reason && <span className="text-red-600"> · {b.reject_reason}</span>}</>}
          actions={<div className="flex flex-wrap gap-1" data-batch={b.batch_no}>
            {can('SAMPLE.ALLOCATE') && b.status === 'DRAFT' && <><Button size="sm" variant="secondary" onClick={() => setWizard(b)}>Edit</Button>
              <Button size="sm" loading={busy === b.id} id={`batch-submit-${b.id}`} onClick={() => void act(b, 'submit')}>Submit</Button>
              <Button size="sm" variant="ghost" onClick={() => setReasonFor({ b, action: 'cancel' })}>Cancel</Button></>}
            {can('SAMPLE.ALLOC_APPROVE') && b.status === 'PENDING_APPROVAL' && <Button size="sm" variant="secondary" loading={busy === b.id} onClick={() => void act(b, 'approve')}>Approve</Button>}
            {can('SAMPLE.ALLOC_APPROVE') && ['PENDING_APPROVAL', 'APPROVED'].includes(b.status) && <><Button size="sm" loading={busy === b.id} id={`batch-post-${b.id}`} onClick={() => void act(b, 'post')}>Post</Button>
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setReasonFor({ b, action: 'reject' })}>Reject</Button></>}
            {can('SAMPLE.ALLOC_APPROVE') && ['POSTED', 'PARTIALLY_REVERSED'].includes(b.status) && <Button size="sm" variant="ghost" className="text-red-600" id={`batch-reverse-${b.id}`} onClick={() => setReasonFor({ b, action: 'reverse' })}>Reverse all</Button>}
          </div>}>
          <table className="w-full">
            <thead><tr><th className="th">Order</th><th className="th">Buyer · PO</th><th className="th text-right">Basis</th><th className="th text-right">Allocated ₹</th><th className="th">Line</th><th className="th" /></tr></thead>
            <tbody>
              {b.lines.map((l: any) => (
                <tr key={l.id} className={clsx(l.status === 'REVERSED' && 'opacity-60')}>
                  <td className="td"><Link className="font-mono text-[12px] text-brand-700 hover:underline" to={`/sales/orders/${l.so_id}`}>{l.so_no}</Link>{Number(l.is_override) ? <Badge tone="amber" className="ml-1">override</Badge> : null}</td>
                  <td className="td text-[12px]">{l.buyer_name}{l.buyer_po_no ? ` · ${l.buyer_po_no}` : ''}</td>
                  <td className="td text-right text-[12px] tabular-nums">{fmtNumber(l.basis_pct, 2)}%{l.basis_qty != null ? <p className="text-slate-500">{fmtNumber(l.basis_qty)} pcs · {inr(l.basis_value, '—')}</p> : null}</td>
                  <td className="td text-right tabular-nums font-semibold">{fmtNumber(l.allocated_amount, 2)}</td>
                  <td className="td text-[12px]">{l.status === 'REVERSED' ? <span className="text-red-600">reversed {fmtDate(l.reversed_at)} · {l.reverse_reason}</span> : 'active'}</td>
                  <td className="td text-right">{can('SAMPLE.ALLOC_APPROVE') && l.status === 'ACTIVE' && ['POSTED', 'PARTIALLY_REVERSED'].includes(b.status) && b.lines.filter((x: any) => x.status === 'ACTIVE').length > 1 &&
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setReasonFor({ b, action: 'reverse', lineIds: [l.id] })}>Reverse</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
      {wizard && <AllocationWizard s={s} batch={wizard.id ? wizard : null} onClose={() => setWizard(null)} onDone={() => { setWizard(null); void q.refetch(); refresh(); }} />}
      <ReasonModal open={!!reasonFor} danger={reasonFor?.action !== 'cancel'} busy={busy === reasonFor?.b.id}
        title={`${reasonFor?.action === 'reverse' ? (reasonFor.lineIds ? 'Reverse the line of' : 'Reverse') : reasonFor?.action === 'reject' ? 'Reject' : 'Cancel'} ${reasonFor?.b.batch_no ?? ''}`}
        message={reasonFor?.action === 'reverse' ? 'The allocation leaves the order P&L; the line stays as history. Allocate again if the cost belongs to another order.' : undefined}
        confirmLabel={reasonFor?.action === 'reverse' ? 'Reverse' : reasonFor?.action === 'reject' ? 'Reject' : 'Cancel draft'}
        onClose={() => setReasonFor(null)} onConfirm={(reason) => reasonFor && void act(reasonFor.b, reasonFor.action, { reason, line_ids: reasonFor.lineIds })} />
    </div>
  );
}

function AllocationWizard({ s, batch, onClose, onDone }: { s: any; batch: any | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const el = useQuery({ queryKey: ['sample-eligible', s.id, term], queryFn: async () => (await http.get<{ data: any }>(`/samples/${s.id}/eligible-orders`, { q: term || undefined })).data });
  const [method, setMethod] = useState<string>(batch?.method ?? 'PERCENT');
  const [lines, setLines] = useState<Record<number, { pct?: string; manual_amount?: string; so_no?: string; override?: boolean }>>(
    () => Object.fromEntries((batch?.lines ?? []).map((l: any) => [l.so_id, { pct: String(Number(l.basis_pct)), manual_amount: l.manual_amount != null ? String(Number(l.manual_amount)) : String(Number(l.allocated_amount)), so_no: l.so_no, override: !!Number(l.is_override) }])));
  const [amount, setAmount] = useState<string>(batch && ['QUANTITY', 'VALUE', 'EQUAL'].includes(batch.method) ? String(Number(batch.amount_to_allocate)) : '');
  const [reason, setReason] = useState<string>(batch?.reason ?? 'Buyer approved the sample and the order is confirmed');
  const [override, setOverride] = useState<string>(batch?.override_reason ?? '');
  const [preview, setPreview] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const d = el.data;
  const orders = useMemo(() => [...(d?.matched ?? []), ...(d?.others ?? [])], [d]);
  const chosen = Object.keys(lines).map(Number);
  const needsOverride = !d?.buyer_approved || chosen.some((id) => orders.find((o) => o.so_id === id)?.override ?? lines[id]?.override);
  const body = () => ({
    method, reason, override_reason: override || null, amount_to_allocate: ['QUANTITY', 'VALUE', 'EQUAL', 'PERCENT'].includes(method) && amount ? Number(amount) : null,
    lines: chosen.map((so_id) => ({ so_id, pct: method === 'PERCENT' ? Number(lines[so_id].pct) || null : null, manual_amount: method === 'MANUAL' ? Number(lines[so_id].manual_amount) || null : null })),
    row_version: batch?.row_version,
  });
  const doPreview = async () => {
    setBusy(true);
    try { setPreview((await http.post<{ data: any }>(`/samples/${s.id}/allocations/preview${batch ? `?batch_id=${batch.id}` : ''}`, body())).data); }
    catch (e) { setPreview(null); toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const save = async (submit: boolean) => {
    setBusy(true);
    try {
      if (batch) { await http.put(`/sample-allocations/${batch.id}`, body()); if (submit) await http.post(`/sample-allocations/${batch.id}/submit`, {}); }
      else await http.post(`/samples/${s.id}/allocations${submit ? '?submit=1' : ''}`, body());
      toast(submit ? 'Allocation sent for approval' : 'Allocation saved as draft');
      onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const toggle = (o: any, on: boolean) => { const n = { ...lines }; if (on) n[o.so_id] = { pct: '', manual_amount: '', so_no: o.so_no, override: o.override }; else delete n[o.so_id]; setLines(n); setPreview(null); };
  const setLine = (id: number, k: 'pct' | 'manual_amount', x: string) => { setLines({ ...lines, [id]: { ...lines[id], [k]: x } }); setPreview(null); };
  return (
    <Modal open onClose={onClose} title={batch ? `Edit ${batch.batch_no}` : 'Allocate sample cost to orders'} subtitle={`${s.sample_no} · ${s.buyer_name} · ${s.style_code}`} size="xl"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <Button variant="secondary" loading={busy} id="alloc-preview" disabled={!chosen.length} onClick={() => void doPreview()}>Preview split</Button>
        <Button variant="secondary" loading={busy} id="alloc-save-draft" disabled={!preview} onClick={() => void save(false)}>Save draft</Button>
        <Button loading={busy} id="alloc-save-submit" disabled={!preview} onClick={() => void save(true)}>Send for approval</Button></>}>
      {el.isLoading ? <LoadingBlock rows={4} /> : d && (
        <div className="space-y-3" id="alloc-wizard">
          <div className="grid grid-cols-2 gap-2 text-[12.5px] sm:grid-cols-4">
            <div className="rounded border border-slate-200 p-2">Posted, allocatable <b className="block text-[15px]">{inr(d.balance.eligible, '₹ 0')}</b></div>
            <div className="rounded border border-slate-200 p-2">Already allocated <b className="block text-[15px]">{inr(d.balance.allocated, '₹ 0')}</b></div>
            <div className="rounded border border-slate-200 p-2">Awaiting approval <b className="block text-[15px]">{inr(d.balance.reserved, '₹ 0')}</b></div>
            <div className="rounded border border-brand-200 bg-brand-50 p-2">Free to allocate <b className="block text-[15px]" id="alloc-available">{inr(d.balance.available, '₹ 0')}</b></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Select label="Method" id="alloc-method" value={method} onChange={(e) => { setMethod(e.target.value); setPreview(null); }} options={ALLOC_METHODS.map((m) => ({ value: m.value, label: m.label }))}
              hint={ALLOC_METHODS.find((m) => m.value === method)?.hint} />
            {method !== 'MANUAL' && <Input label={method === 'PERCENT' ? 'Pool (₹) the % apply to' : 'Amount to split (₹)'} type="number" min={0} step="0.01" id="alloc-amount" value={amount}
              placeholder={String(d.balance.available)} onChange={(e) => { setAmount(e.target.value); setPreview(null); }} hint="Blank = everything free to allocate" />}
            <Input label="Reason" required id="alloc-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-[12px] font-semibold text-slate-600">Confirmed orders of {s.buyer_name} with style {s.style_code}</p>
              <div className="flex items-center gap-1">
                <input className="input h-8 w-56 py-0 text-[12px]" placeholder="Other order (SO / PO no) — override" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setTerm(search.trim())} />
                <Button size="sm" variant="secondary" onClick={() => setTerm(search.trim())}><Search size={13} /></Button>
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto rounded border border-slate-200">
              <table className="w-full" id="alloc-orders">
                <thead className="sticky top-0 bg-white"><tr><th className="th w-8" /><th className="th">Order</th><th className="th">Buyer · PO · ship</th><th className="th text-right">Style qty</th><th className="th text-right">Value ₹</th><th className="th text-right">Already from this sample</th><th className="th text-right w-32">{method === 'PERCENT' ? '%' : method === 'MANUAL' ? 'Amount ₹' : ''}</th></tr></thead>
                <tbody>
                  {!orders.length && <tr><td className="td py-6 text-center text-[12px] text-slate-400" colSpan={7}>No confirmed (approved / closed) order of this buyer has this style yet. Search another order to allocate on override.</td></tr>}
                  {orders.map((o: any) => (
                    <tr key={o.so_id} className={clsx(lines[o.so_id] && 'bg-brand-50/40')}>
                      <td className="td"><input type="checkbox" data-so={o.so_no} checked={!!lines[o.so_id]} onChange={(e) => toggle(o, e.target.checked)} /></td>
                      <td className="td font-mono text-[12px]">{o.so_no}{o.override && <Badge tone="amber" className="ml-1">override</Badge>}<p className="font-sans text-[11px] text-slate-400">{String(o.approval_state).toLowerCase()}</p></td>
                      <td className="td text-[12px]">{o.buyer_name}{o.buyer_po_no ? ` · ${o.buyer_po_no}` : ''}<p className="text-slate-400">{fmtDate(o.ship_date)}</p></td>
                      <td className="td text-right text-[12px] tabular-nums">{fmtNumber(o.basis_qty)}</td>
                      <td className="td text-right text-[12px] tabular-nums">{o.basis_value == null ? <span className="text-amber-700">no ₹ rate</span> : fmtNumber(o.basis_value, 0)}</td>
                      <td className="td text-right text-[12px] tabular-nums">{o.already_allocated ? fmtNumber(o.already_allocated, 2) : '—'}</td>
                      <td className="td text-right">{lines[o.so_id] && method === 'PERCENT' && <input className="input h-8 w-24 py-0 text-right text-[12px]" type="number" min={0} max={100} step="0.01" data-pct={o.so_no} value={lines[o.so_id].pct} onChange={(e) => setLine(o.so_id, 'pct', e.target.value)} />}
                        {lines[o.so_id] && method === 'MANUAL' && <input className="input h-8 w-28 py-0 text-right text-[12px]" type="number" min={0} step="0.01" data-amt={o.so_no} value={lines[o.so_id].manual_amount} onChange={(e) => setLine(o.so_id, 'manual_amount', e.target.value)} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {needsOverride && chosen.length > 0 && <Textarea label="Override reason" required id="alloc-override" value={override} onChange={(e) => setOverride(e.target.value)}
            hint={!d.buyer_approved ? 'The sample is not buyer-approved yet' : 'An order of another buyer / without this style is included'} />}
          {preview && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3" id="alloc-preview-box">
              <p className="mb-1 text-[12.5px] font-semibold text-emerald-900">Split worked out by the server — total {inr(preview.total)}</p>
              <table className="w-full text-[12.5px]"><tbody>
                {preview.lines.map((l: any) => <tr key={l.so_id}><td className="py-0.5 font-mono">{l.so_no}</td><td className="text-right tabular-nums">{fmtNumber(l.basis_pct, 2)}%</td><td className="text-right font-semibold tabular-nums">{inr(l.allocated_amount)}</td></tr>)}
              </tbody></table>
              {preview.warnings?.map((w: string) => <p key={w} className="mt-1 text-[12px] text-amber-800">{w}</p>)}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
