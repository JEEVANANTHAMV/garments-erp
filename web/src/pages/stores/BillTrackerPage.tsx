import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, FileText, Send, CornerDownLeft, Landmark } from 'lucide-react';
import { PageHeader, Tabs, Modal, FormSection, Input, Select, Button, LoadingBlock, StatusBadge, useDebounced } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { today, monthStart, useAction, useStoresList, useStoresDoc, FilterBar, SimpleTable, ReportView, ReasonModal, InfoGrid, type Col } from './shared';

/**
 * Bill Tracker (client tracker 14-Oct-2026): bill receipt (from vendor / department) → handover to the department
 * (to whom, date) → received back → submitted to accounts (date, recipient). /stores/bill-tracker?id=<id> opens one bill.
 */
const STATUS_TABS = [{ key: '', label: 'All' }, { key: 'RECEIVED', label: 'Received' }, { key: 'HANDED_OVER', label: 'With department' }, { key: 'RECEIVED_BACK', label: 'Received back' },
  { key: 'SUBMITTED', label: 'Submitted to accounts' }, { key: 'CANCELLED', label: 'Cancelled' }];
const REPORT_COLS: Col[] = [
  { key: 's_no', label: 'S.No' }, { key: 'entry_date', label: 'Date', kind: 'date' }, { key: 'bill_no', label: 'Bill #' }, { key: 'bill_date', label: 'Bill Dt', kind: 'date' },
  { key: 'supplier_name', label: 'Supplier', render: (r) => r.supplier_name ?? r.received_from_dept ?? '—' }, { key: 'purchase_or_process', label: 'Purchase / Process Name' },
  { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'handed_over_to', label: 'Handed over To' }, { key: 'handover_department', label: 'Hand over department' },
  { key: 'handover_date', label: 'Hand over date', kind: 'date' }, { key: 'received_back_date', label: 'Received back from concerned department(date)', kind: 'date' },
  { key: 'submitted_to_accounts_on', label: 'Bill submitted to accouts on', kind: 'date' }, { key: 'accounts_recipient', label: 'A/c recepient Name' },
  { key: 'sign', label: 'A/C Receiver Sign', render: () => '' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'days_pending', label: 'Days pending' },
];

export default function BillTrackerPage() {
  const { canAny } = useAuth();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('LIST');
  const [status, setStatus] = useState('');
  const [f, setF] = useState({ from: monthStart(), to: today(), q: '' });
  const q = useDebounced(f.q);
  const list = useStoresList('bill-tracker', { from: f.from, to: f.to, q, status });
  const [edit, setEdit] = useState<any | null>(null);
  const viewId = Number(params.get('id')) || null;
  const setView = (id: number | null) => { const p = new URLSearchParams(params); if (id) p.set('id', String(id)); else p.delete('id'); setParams(p, { replace: true }); };
  const cols: Col[] = [
    { key: 'entry_no', label: 'Entry', render: (r) => <span className="font-mono font-semibold text-brand-700">{r.entry_no}</span> }, { key: 'entry_date', label: 'Received', kind: 'date' },
    { key: 'bill_no', label: 'Bill no' }, { key: 'bill_date', label: 'Bill date', kind: 'date' }, { key: 'supplier_name', label: 'From', render: (r) => r.supplier_name ?? (r.received_from_dept ? `Dept: ${r.received_from_dept}` : '—') },
    { key: 'purchase_or_process', label: 'Purchase / process' }, { key: 'amount', label: 'Amount', kind: 'money' },
    { key: 'handed_over_to', label: 'With', render: (r) => (r.handed_over_to ? `${r.handed_over_to} (${r.handover_department ?? ''})` : '—') },
    { key: 'submitted_to_accounts_on', label: 'To accounts', kind: 'date' }, { key: 'status', label: 'Status', kind: 'status' },
  ];
  return (
    <>
      <PageHeader breadcrumb={['Purchase', 'Bill Tracker']} title="Bill Tracker" subtitle="Where is every bill — received, with which department, back, submitted to accounts"
        actions={canAny('FINANCE.CREATE', 'FINANCE.UPDATE', 'PURCHASE.CREATE', 'GRN.CREATE') ? <Button id="new-bill" onClick={() => setEdit({})}><Plus size={14} className="mr-1 inline" /> Bill received</Button> : null} />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'LIST', label: 'Bills' }, { key: 'REPORT', label: 'Bill tracker report' }]} active={tab} onChange={setTab} /></div>
      {tab === 'LIST' ? (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">{STATUS_TABS.map((s) => (
            <button key={s.key} onClick={() => setStatus(s.key)} className={`rounded-full border px-3 py-1 text-[12px] ${status === s.key ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{s.label}</button>))}
          </div>
          <FilterBar f={f} setF={setF} />
          <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} onRow={(r) => setView(r.id)} />
        </>
      ) : <ReportView path="bill-tracker" title="Bill tracker" cols={REPORT_COLS} />}
      {edit && <BillEditor doc={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={(d) => { setEdit(null); setView(d.id); }} />}
      {viewId && <BillView id={viewId} onClose={() => setView(null)} onEdit={(d) => { setView(null); setEdit(d); }} />}
    </>
  );
}

function BillEditor({ doc, onClose, onSaved }: { doc: any | null; onClose: () => void; onSaved: (d: any) => void }) {
  const [b, setB] = useState({
    entry_date: doc?.entry_date ?? today(), received_from: doc?.received_from ?? 'VENDOR', received_from_dept: doc?.received_from_dept ?? '', bill_no: doc?.bill_no ?? '',
    bill_date: doc?.bill_date ?? '', supplier_id: doc?.supplier_id ? String(doc.supplier_id) : '', purchase_or_process: doc?.purchase_or_process ?? '', amount: doc?.amount ? String(doc.amount) : '',
    supplier_bill_id: doc?.supplier_bill_id ? String(doc.supplier_bill_id) : '', grn_id: doc?.grn_id ? String(doc.grn_id) : '', remarks: doc?.remarks ?? '',
  });
  const parties = useLookup('parties');
  const src = useQuery({ queryKey: ['stores', 'bill-sources', b.supplier_id], enabled: !!b.supplier_id,
    queryFn: async () => (await http.get<{ data: { bills: any[]; grns: any[] } }>(`/stores/bill-tracker/sources?supplier_id=${b.supplier_id}`)).data });
  const act = useAction();
  const save = () => act.mutate({ url: doc ? `/stores/bill-tracker/${doc.id}` : '/stores/bill-tracker', method: doc ? 'put' : 'post',
    body: { ...b, bill_date: b.bill_date || null, supplier_id: Number(b.supplier_id) || null, amount: Number(b.amount) || 0, supplier_bill_id: Number(b.supplier_bill_id) || null,
      grn_id: Number(b.grn_id) || null, received_from_dept: b.received_from_dept || null } }, { onSuccess: (r) => onSaved(r.data) });
  const pickBill = (id: string) => {
    const x = src.data?.bills.find((y) => String(y.id) === id);
    setB({ ...b, supplier_bill_id: id, ...(x && !b.bill_no ? { bill_no: x.inv_no ?? x.bill_no } : {}), ...(x && !b.amount ? { amount: String(x.total_amount ?? '') } : {}), ...(x && !b.bill_date ? { bill_date: x.bill_date } : {}) });
  };
  return (
    <Modal open onClose={onClose} title={doc ? `Edit bill ${doc.bill_no}` : 'Bill received'} subtitle="Bill receipt from a vendor or a department" icon={<FileText size={16} />} size="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="bill-save" loading={act.isPending} onClick={save}>Save</Button>
      </>}>
      <FormSection title="Receipt" cols={3}>
        <Input label="Received on" type="date" required value={b.entry_date} onChange={(e) => setB({ ...b, entry_date: e.target.value })} />
        <Select label="Received from" required value={b.received_from} onChange={(e) => setB({ ...b, received_from: e.target.value })} options={[{ value: 'VENDOR', label: 'Vendor' }, { value: 'DEPARTMENT', label: 'Department' }]} />
        {b.received_from === 'DEPARTMENT'
          ? <Input label="Department" required id="bill-from-dept" value={b.received_from_dept} onChange={(e) => setB({ ...b, received_from_dept: e.target.value })} />
          : <div />}
      </FormSection>
      <FormSection title="Bill" cols={3}>
        <Select label="Supplier" required={b.received_from === 'VENDOR'} id="bill-supplier" className="sm:col-span-2" value={b.supplier_id} placeholder="Select…" onChange={(e) => setB({ ...b, supplier_id: e.target.value, supplier_bill_id: '', grn_id: '' })} options={toOptions(parties.data)} />
        <Input label="Purchase / process" value={b.purchase_or_process} placeholder="e.g. Yarn purchase / Dyeing" onChange={(e) => setB({ ...b, purchase_or_process: e.target.value })} />
        <Input label="Bill no" required id="bill-no" value={b.bill_no} onChange={(e) => setB({ ...b, bill_no: e.target.value })} />
        <Input label="Bill date" type="date" value={b.bill_date} onChange={(e) => setB({ ...b, bill_date: e.target.value })} />
        <Input label="Amount" type="number" min="0" step="any" id="bill-amount" value={b.amount} onChange={(e) => setB({ ...b, amount: e.target.value })} />
      </FormSection>
      <FormSection title="Link (optional)" cols={2}>
        <Select label="Bills Inward entry" value={b.supplier_bill_id} placeholder={b.supplier_id ? '—' : 'Select the supplier first'} disabled={!b.supplier_id} onChange={(e) => pickBill(e.target.value)}
          options={(src.data?.bills ?? []).map((x) => ({ value: x.id, label: `${x.bill_no} · ${fmtDate(x.bill_date)} · ₹${fmtDecimal(x.total_amount, 2)}` }))} />
        <Select label="GRN" value={b.grn_id} placeholder={b.supplier_id ? '—' : 'Select the supplier first'} disabled={!b.supplier_id} onChange={(e) => setB({ ...b, grn_id: e.target.value })}
          options={(src.data?.grns ?? []).map((x) => ({ value: x.id, label: `${x.grn_no} · ${fmtDate(x.grn_date)}` }))} />
        <Input label="Remarks" className="sm:col-span-2" value={b.remarks} onChange={(e) => setB({ ...b, remarks: e.target.value })} />
      </FormSection>
    </Modal>
  );
}

type Step = 'handover' | 'received-back' | 'submit-accounts';
function BillView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (d: any) => void }) {
  const { canAny } = useAuth();
  const d = useStoresDoc('bill-tracker', id);
  const act = useAction();
  const [step, setStep] = useState<Step | null>(null);
  const [cancel, setCancel] = useState(false);
  const doc = d.data;
  const edit = canAny('FINANCE.CREATE', 'FINANCE.UPDATE', 'PURCHASE.CREATE', 'GRN.CREATE');
  const live = doc && !['SUBMITTED', 'CANCELLED'].includes(doc.status);
  return (
    <Modal open onClose={onClose} title={doc ? `Bill ${doc.bill_no}` : 'Bill'} subtitle={doc ? `${doc.entry_no} · ${doc.supplier_name ?? doc.received_from_dept ?? ''}` : undefined} icon={<FileText size={16} />} size="lg"
      footerStart={doc ? <StatusBadge value={doc.status} /> : null}
      footer={doc && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {live && edit && <Button variant="secondary" id="bill-cancel" onClick={() => setCancel(true)}>Cancel bill</Button>}
        {doc.status === 'RECEIVED' && edit && <Button variant="secondary" id="bill-edit" onClick={() => onEdit(doc)}>Edit</Button>}
        {['RECEIVED', 'RECEIVED_BACK'].includes(doc.status) && edit && <Button variant="secondary" id="bill-handover" onClick={() => setStep('handover')}><Send size={13} className="mr-1 inline" /> Hand over</Button>}
        {doc.status === 'HANDED_OVER' && edit && <Button variant="secondary" id="bill-back" onClick={() => setStep('received-back')}><CornerDownLeft size={13} className="mr-1 inline" /> Received back</Button>}
        {live && edit && <Button id="bill-accounts" onClick={() => setStep('submit-accounts')}><Landmark size={13} className="mr-1 inline" /> Submit to accounts</Button>}
      </>}>
      {!doc ? <LoadingBlock /> : (
        <InfoGrid items={[['Received on', fmtDate(doc.entry_date)], ['From', doc.received_from === 'VENDOR' ? 'Vendor' : `Department: ${doc.received_from_dept}`], ['Supplier', doc.supplier_name], ['Bill date', doc.bill_date ? fmtDate(doc.bill_date) : '—'],
          ['Purchase / process', doc.purchase_or_process], ['Amount', `₹${fmtDecimal(doc.amount, 2)}`], ['Bills Inward', doc.linked_bill_no], ['GRN', doc.linked_grn_no],
          ['Handed over to', doc.handed_over_to ? `${doc.handed_over_to} · ${doc.handover_department ?? ''}` : '—'], ['Handover date', doc.handover_date ? fmtDate(doc.handover_date) : '—'],
          ['Received back', doc.received_back_date ? fmtDate(doc.received_back_date) : '—'], ['To accounts', doc.submitted_to_accounts_on ? `${fmtDate(doc.submitted_to_accounts_on)} · ${doc.accounts_recipient ?? ''}` : '—'],
          ['Prepared by', doc.prepared_by], ['Remarks', doc.remarks], ['Cancel reason', doc.cancel_reason]]} />
      )}
      {step && doc && <StepModal step={step} doc={doc} busy={act.isPending} onClose={() => setStep(null)}
        onSave={(body) => act.mutate({ url: `/stores/bill-tracker/${id}/${step}`, body }, { onSuccess: () => setStep(null) })} />}
      {cancel && <ReasonModal title={`Cancel bill ${doc?.bill_no}`} confirm="Cancel bill" busy={act.isPending} onClose={() => setCancel(false)}
        onConfirm={(reason) => act.mutate({ url: `/stores/bill-tracker/${id}/cancel`, body: { reason } }, { onSuccess: () => setCancel(false) })} />}
    </Modal>
  );
}

function StepModal({ step, doc, busy, onClose, onSave }: { step: Step; doc: any; busy: boolean; onClose: () => void; onSave: (b: Record<string, string>) => void }) {
  const [v, setV] = useState<Record<string, string>>(step === 'handover' ? { handed_over_to: '', handover_department: doc.handover_department ?? '', handover_date: today() }
    : step === 'received-back' ? { received_back_date: today() } : { submitted_to_accounts_on: today(), accounts_recipient: '' });
  const title = { handover: 'Hand over to department', 'received-back': 'Received back from department', 'submit-accounts': 'Submit to accounts' }[step];
  const ready = Object.values(v).every((x) => x.trim());
  return (
    <Modal open onClose={onClose} title={`${title} · ${doc.bill_no}`} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="bill-step-save" disabled={!ready} loading={busy} onClick={() => onSave(v)}>Save</Button>
      </>}>
      <FormSection cols={1}>
        {step === 'handover' && <>
          <Input label="Handed over to" required id="step-to" value={v.handed_over_to} onChange={(e) => setV({ ...v, handed_over_to: e.target.value })} />
          <Input label="Department" required id="step-dept" value={v.handover_department} onChange={(e) => setV({ ...v, handover_department: e.target.value })} />
          <Input label="Handover date" type="date" required value={v.handover_date} onChange={(e) => setV({ ...v, handover_date: e.target.value })} />
        </>}
        {step === 'received-back' && <Input label="Received back on" type="date" required value={v.received_back_date} onChange={(e) => setV({ ...v, received_back_date: e.target.value })} />}
        {step === 'submit-accounts' && <>
          <Input label="Submitted on" type="date" required value={v.submitted_to_accounts_on} onChange={(e) => setV({ ...v, submitted_to_accounts_on: e.target.value })} />
          <Input label="Accounts recipient" required id="step-recipient" value={v.accounts_recipient} onChange={(e) => setV({ ...v, accounts_recipient: e.target.value })} />
        </>}
      </FormSection>
    </Modal>
  );
}
