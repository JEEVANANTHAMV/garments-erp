import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, BadgeAlert } from 'lucide-react';
import { PageHeader, Tabs, Modal, FormSection, Input, Select, Textarea, Button, LoadingBlock, StatusBadge, Checkbox, useDebounced } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { MAT_OPTIONS, num, qtyFmt, today, monthStart, useAction, useStoresList, useStoresDoc, FilterBar, SimpleTable, ReportView, ReasonModal, InfoGrid, type Col, type Mat } from './shared';

/**
 * Special Request (client tracker 14-Oct-2026): purchase over and above the budget (BOM requirement + allowed excess).
 * Entry shows the job's budget for the item; approval (Approve Purchase) can raise the job's purchase allowance.
 */
const REPORT_COLS: Col[] = [
  { key: 'req_no', label: 'Request no' }, { key: 'req_date', label: 'Date', kind: 'date' }, { key: 'so_no', label: 'Sale order' }, { key: 'style_code', label: 'Style' },
  { key: 'buyer', label: 'Buyer' }, { key: 'material_type', label: 'Material' }, { key: 'item_name', label: 'Item' }, { key: 'uom_code', label: 'UOM' },
  { key: 'budget_qty', label: 'Budget (allowed)', kind: 'qty' }, { key: 'ordered_qty', label: 'Already ordered', kind: 'qty' }, { key: 'requested_qty', label: 'Requested', kind: 'qty' },
  { key: 'rate', label: 'Rate', kind: 'money' }, { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'reason', label: 'Reason' }, { key: 'requested_by', label: 'Requested by' },
  { key: 'status', label: 'Status', kind: 'status' }, { key: 'decided_by_name', label: 'Approved / rejected by' }, { key: 'decided_at', label: 'On', kind: 'date' }, { key: 'decision_remarks', label: 'Remarks' },
];

export default function SpecialRequestPage() {
  const { canAny } = useAuth();
  const [tab, setTab] = useState('LIST');
  const [f, setF] = useState({ from: monthStart(), to: today(), q: '', status: '' });
  const q = useDebounced(f.q);
  const list = useStoresList('special-requests', { from: f.from, to: f.to, q, status: f.status });
  const [create, setCreate] = useState(false);
  const [view, setView] = useState<number | null>(null);
  const cols: Col[] = [
    { key: 'req_no', label: 'Request', render: (r) => <span className="font-mono font-semibold text-brand-700">{r.req_no}</span> }, { key: 'req_date', label: 'Date', kind: 'date' },
    { key: 'so_no', label: 'Job' }, { key: 'item_name', label: 'Item' }, { key: 'budget_qty', label: 'Budget', kind: 'qty' }, { key: 'ordered_qty', label: 'Ordered', kind: 'qty' },
    { key: 'requested_qty', label: 'Extra asked', kind: 'qty' }, { key: 'uom_code', label: 'UOM' }, { key: 'amount', label: 'Amount', kind: 'money' },
    { key: 'requested_by', label: 'By' }, { key: 'status', label: 'Status', kind: 'status' },
  ];
  return (
    <>
      <PageHeader breadcrumb={['Purchase', 'Special Requests']} title="Special Requests" subtitle="Purchase over and above the budget — raised, then approved or rejected"
        actions={canAny('PURCHASE.CREATE', 'PURCHASE.APPROVE') ? <Button id="new-special" onClick={() => setCreate(true)}><Plus size={14} className="mr-1 inline" /> New special request</Button> : null} />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'LIST', label: 'Requests' }, { key: 'REPORT', label: 'Special requests made during a period' }]} active={tab} onChange={setTab} /></div>
      {tab === 'LIST' ? (
        <>
          <FilterBar f={f} setF={setF} statuses={['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']} />
          <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} onRow={(r) => setView(r.id)} />
        </>
      ) : <ReportView path="special-requests" title="Special requests" cols={REPORT_COLS} />}
      {create && <RequestEditor onClose={() => setCreate(false)} onSaved={(d) => { setCreate(false); setView(d.id); }} />}
      {view && <RequestView id={view} onClose={() => setView(null)} />}
    </>
  );
}

function RequestEditor({ onClose, onSaved }: { onClose: () => void; onSaved: (d: any) => void }) {
  const [b, setB] = useState({ req_date: today(), so_id: '', material_type: 'YARN' as Mat, item_id: '', item_description: '', uom_id: '', requested_qty: '', rate: '', reason: '', raise_allowance: true });
  const sos = useLookup('sales-orders'); const yarns = useLookup('yarns'); const fabrics = useLookup('fabrics'); const trims = useLookup('trims'); const uoms = useLookup('uoms');
  const items = b.material_type === 'YARN' ? yarns.data : b.material_type === 'FABRIC' ? fabrics.data : trims.data;
  const budget = useQuery({ queryKey: ['stores', 'sr-budget', b.so_id, b.material_type, b.item_id], enabled: !!b.so_id && (b.material_type === 'GENERAL' || !!b.item_id),
    queryFn: async () => (await http.get<{ data: any }>(`/stores/special-requests/budget?so_id=${b.so_id}&material_type=${b.material_type}${b.item_id ? `&item_id=${b.item_id}` : ''}`)).data });
  const bud = budget.data;
  const act = useAction();
  const onItem = (id: string) => {
    const it = items?.find((x) => String(x.id) === id) as any;
    setB({ ...b, item_id: id, uom_id: it?.base_uom ? String(it.base_uom) : b.uom_id, rate: it?.std_rate && !b.rate ? String(it.std_rate) : b.rate });
  };
  const save = () => act.mutate({ url: '/stores/special-requests', body: {
    req_date: b.req_date, so_id: Number(b.so_id) || null, material_type: b.material_type, yarn_id: b.material_type === 'YARN' ? Number(b.item_id) || null : null,
    fabric_id: b.material_type === 'FABRIC' ? Number(b.item_id) || null : null, trim_id: b.material_type === 'TRIM' ? Number(b.item_id) || null : null,
    item_description: b.item_description || null, uom_id: Number(b.uom_id) || null, requested_qty: num(b.requested_qty), rate: num(b.rate), reason: b.reason, raise_allowance: b.raise_allowance } },
    { onSuccess: (r) => onSaved(r.data) });
  return (
    <Modal open onClose={onClose} title="New special request" subtitle="Ask to buy more than the job's budget; an approver decides" icon={<BadgeAlert size={16} />} size="lg"
      footerStart={<>Amount ₹{fmtDecimal(num(b.requested_qty) * num(b.rate), 2)}</>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="special-save" loading={act.isPending} onClick={save}>Raise request</Button>
      </>}>
      <FormSection title="Request" cols={3}>
        <Input label="Date" type="date" required value={b.req_date} onChange={(e) => setB({ ...b, req_date: e.target.value })} />
        <Select label="Sale order / job" className="sm:col-span-2" id="special-so" value={b.so_id} placeholder="— (not for a job)" onChange={(e) => setB({ ...b, so_id: e.target.value })} options={toOptions(sos.data)} />
      </FormSection>
      <FormSection title="Item & quantity" cols={3}>
        <Select label="Material" required id="special-mt" value={b.material_type} onChange={(e) => setB({ ...b, material_type: e.target.value as Mat, item_id: '' })} options={MAT_OPTIONS} />
        {b.material_type === 'GENERAL'
          ? <Input label="Item" required className="sm:col-span-2" id="special-item-text" value={b.item_description} onChange={(e) => setB({ ...b, item_description: e.target.value })} />
          : <Select label="Item" required className="sm:col-span-2" id="special-item" value={b.item_id} placeholder="Select…" onChange={(e) => onItem(e.target.value)} options={toOptions(items)} />}
        <Select label="UOM" value={b.uom_id} placeholder="—" onChange={(e) => setB({ ...b, uom_id: e.target.value })} options={(uoms.data ?? []).map((u) => ({ value: u.id, label: String(u.code) }))} />
        <Input label="Extra qty requested" required type="number" min="0" step="any" id="special-qty" value={b.requested_qty} onChange={(e) => setB({ ...b, requested_qty: e.target.value })} />
        <Input label="Rate" type="number" min="0" step="any" value={b.rate} onChange={(e) => setB({ ...b, rate: e.target.value })} />
      </FormSection>
      {b.so_id && (budget.isFetching ? <LoadingBlock rows={1} /> : bud ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
          {bud.not_on_bom ? <>This item is not on job {bud.job_no}'s BOM — the whole quantity is over budget.</>
            : <>Job {bud.job_no}: requirement <b>{qtyFmt(bud.required)}</b> · allowed (with excess) <b>{qtyFmt(bud.allowed)}</b> · already ordered <b>{qtyFmt(bud.ordered)}</b> · balance <b>{qtyFmt(bud.balance)}</b> {bud.uom_code ?? ''}</>}
        </div>) : null)}
      <FormSection title="Reason" cols={1}>
        <Textarea label="Why is the extra needed?" required rows={3} id="special-reason" value={b.reason} onChange={(e) => setB({ ...b, reason: e.target.value })} />
        {b.so_id && b.material_type !== 'GENERAL' && <Checkbox label="On approval, raise the job's purchase allowance by this qty (so the PO passes the excess check)" checked={b.raise_allowance} onChange={(v) => setB({ ...b, raise_allowance: v })} />}
      </FormSection>
    </Modal>
  );
}

function RequestView({ id, onClose }: { id: number; onClose: () => void }) {
  const { can, canAny } = useAuth();
  const d = useStoresDoc('special-requests', id);
  const act = useAction();
  const [reason, setReason] = useState<'reject' | 'cancel' | null>(null);
  const [remarks, setRemarks] = useState('');
  const r = d.data;
  return (
    <Modal open onClose={onClose} title={r ? `Special request ${r.req_no}` : 'Special request'} icon={<BadgeAlert size={16} />} size="lg"
      footerStart={r ? <StatusBadge value={r.status} /> : null}
      footer={r && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {r.status === 'PENDING' && canAny('PURCHASE.CREATE', 'PURCHASE.APPROVE') && <Button variant="secondary" id="special-cancel" onClick={() => setReason('cancel')}>Cancel request</Button>}
        {r.status === 'PENDING' && can('PURCHASE.APPROVE') && <Button variant="secondary" id="special-reject" onClick={() => setReason('reject')}>Reject</Button>}
        {r.status === 'PENDING' && can('PURCHASE.APPROVE') && <Button id="special-approve" loading={act.isPending} onClick={() => act.mutate({ url: `/stores/special-requests/${id}/approve`, body: { remarks: remarks || null } })}>Approve</Button>}
      </>}>
      {!r ? <LoadingBlock /> : (
        <>
          <InfoGrid items={[['Date', fmtDate(r.req_date)], ['Job', r.so_no], ['Style', r.style_code], ['Buyer', r.buyer], ['Item', `${r.item_name} (${String(r.material_type).toLowerCase()})`],
            ['Budget (allowed)', `${qtyFmt(r.budget_qty)} ${r.uom_code ?? ''}`], ['Already ordered', qtyFmt(r.ordered_qty)], ['Extra requested', `${qtyFmt(r.requested_qty)} ${r.uom_code ?? ''}`],
            ['Rate', fmtDecimal(r.rate, 2)], ['Amount', `₹${fmtDecimal(r.amount, 2)}`], ['Requested by', r.requested_by],
            ['Raise job allowance', Number(r.raise_allowance) ? (r.allowance_applied_qty ? `Yes · +${qtyFmt(r.allowance_applied_qty)} applied` : 'Yes, on approval') : 'No'],
            ['Decided', r.decided_at ? `${fmtDate(r.decided_at)} · ${r.decided_by_name ?? ''}` : '—'], ['Decision remarks', r.decision_remarks]]} />
          <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] text-slate-700"><b>Reason:</b> {r.reason}</p>
          {r.status === 'PENDING' && can('PURCHASE.APPROVE') && <Input label="Approval remarks (optional)" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}
        </>
      )}
      {reason && <ReasonModal title={reason === 'reject' ? `Reject ${r?.req_no}` : `Cancel ${r?.req_no}`} confirm={reason === 'reject' ? 'Reject' : 'Cancel request'} busy={act.isPending}
        onClose={() => setReason(null)} onConfirm={(x) => act.mutate({ url: `/stores/special-requests/${id}/${reason}`, body: { reason: x } }, { onSuccess: () => setReason(null) })} />}
    </Modal>
  );
}
