import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, FileInput, RefreshCw, Save } from 'lucide-react';
import { PageHeader, Tabs, Input, Select, Button, LoadingBlock, StatusBadge, SearchInput, useDebounced, Pager, Checkbox } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { useAction, SimpleTable, ReportView, type Col } from './shared';
import { BillEditor, CATEGORY_OPTIONS, WORKFLOW_LABEL, StageChip, MatchChip, TextModal, labelOf, ISSUE_OPTIONS } from './billShared';

/**
 * Bill Tracker (client tracker 14-Oct-2026; extended 24-Oct-2026 from the client's bill tracker / document inward spec):
 * dashboard KPIs, the bill list (filters live in the URL, so they are kept when coming back from a bill), approval inbox,
 * follow-ups, posting queue, approved-vs-posted reconciliation, the client's report sheet, and category settings.
 * A bill opens in its own workspace: /stores/bill-tracker/:id. The old /stores/bill-tracker?id=<id> links still work.
 */
const TABS = [
  { key: 'dashboard', label: 'Dashboard' }, { key: 'bills', label: 'Bills' }, { key: 'inbox', label: 'Approval inbox' }, { key: 'followups', label: 'Follow-ups' },
  { key: 'posting', label: 'Posting queue' }, { key: 'recon', label: 'Reconciliation' }, { key: 'report', label: 'Bill tracker report' }, { key: 'settings', label: 'Settings' },
];
const REPORT_COLS: Col[] = [
  { key: 's_no', label: 'S.No' }, { key: 'entry_date', label: 'Date', kind: 'date' }, { key: 'bill_no', label: 'Bill #' }, { key: 'bill_date', label: 'Bill Dt', kind: 'date' },
  { key: 'supplier_name', label: 'Supplier', render: (r) => r.supplier_name ?? r.received_from_dept ?? '—' }, { key: 'purchase_or_process', label: 'Purchase / Process Name' },
  { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'handed_over_to', label: 'Handed over To' }, { key: 'handover_department', label: 'Hand over department' },
  { key: 'handover_date', label: 'Hand over date', kind: 'date' }, { key: 'received_back_date', label: 'Received back from concerned department(date)', kind: 'date' },
  { key: 'submitted_to_accounts_on', label: 'Bill submitted to accouts on', kind: 'date' }, { key: 'accounts_recipient', label: 'A/c recepient Name' },
  { key: 'sign', label: 'A/C Receiver Sign', render: () => '' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'stage', label: 'Stage' },
  { key: 'external_voucher_no', label: 'A/c voucher' }, { key: 'days_pending', label: 'Days pending' },
];
export const KPI_LABEL: Record<string, string> = {
  bills_awaited: 'Bills awaited (DC / GRN copy without bill)', dc_awaited: 'DC awaited', grn_awaited: 'GRN / process receipt awaited', data_pending: 'Data entry pending',
  awaiting_matching: 'Awaiting matching', mismatch: 'Mismatch / duplicate', verification_pending: 'Verification pending', approval_pending: 'Approval pending',
  on_hold: 'On hold', approved_not_queued: 'Approved, not queued', posting_queued: 'Posting queued', posting_failed: 'Posting failed', posted: 'Posted',
  overdue_followups: 'Overdue follow-ups', overdue_custody: 'Overdue custody (not returned)', inward_unresolved: 'Inward documents unresolved', inward_overdue: 'Inward documents overdue',
};

export default function BillTrackerPage() {
  const { canAny } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const legacyId = Number(params.get('id')) || null;
  useEffect(() => { if (legacyId) navigate(`/stores/bill-tracker/${legacyId}`, { replace: true }); }, [legacyId, navigate]);
  const tab = params.get('tab') ?? 'bills';
  const setTab = (t: string) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }); };
  const openKpi = (k: string) => {
    if (k === 'bills_awaited') return navigate('/stores/document-inward?awaiting_bill=1');
    if (k.startsWith('inward_')) return navigate(`/stores/document-inward?${k === 'inward_overdue' ? 'overdue=1' : 'unresolved=1'}`);
    if (k === 'overdue_followups') return setParams(new URLSearchParams({ tab: 'followups', overdue: '1' }));
    setParams(new URLSearchParams({ tab: 'bills', kpi: k }));
  };
  return (
    <>
      <PageHeader breadcrumb={['Purchase', 'Bill Tracker']} title="Bill Tracker" subtitle="Where every bill is, what it is waiting for, who has it — through approval and posting to accounts"
        actions={<div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/stores/document-inward')}><FileInput size={14} className="mr-1 inline" /> Document inward</Button>
          {canAny('FINANCE.CREATE', 'FINANCE.UPDATE', 'PURCHASE.CREATE', 'GRN.CREATE') && <Button id="new-bill" onClick={() => setEdit(true)}><Plus size={14} className="mr-1 inline" /> Bill received</Button>}
        </div>} />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
      {tab === 'dashboard' && <Dashboard onKpi={openKpi} onAge={(a) => setParams(new URLSearchParams({ tab: 'bills', age: a }))} />}
      {tab === 'bills' && <BillList />}
      {tab === 'inbox' && <Inbox />}
      {tab === 'followups' && <Followups />}
      {tab === 'posting' && <PostingQueue />}
      {tab === 'recon' && <Reconciliation />}
      {tab === 'report' && <ReportView path="bill-tracker" title="Bill tracker" cols={REPORT_COLS} />}
      {tab === 'settings' && <Settings />}
      {edit && <BillEditor doc={null} onClose={() => setEdit(false)} onSaved={(d) => { setEdit(false); navigate(`/stores/bill-tracker/${d.id}`, { state: { back: `?${params.toString()}` } }); }} />}
    </>
  );
}

function Kpi({ k, v, onClick, tone }: { k: string; v: number; onClick: () => void; tone?: string }) {
  return (
    <button data-kpi={k} onClick={onClick} className="card p-3 text-left transition hover:shadow-md">
      <div className="text-caption uppercase tracking-wider text-slate-500">{KPI_LABEL[k] ?? k}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${v ? tone ?? 'text-slate-800' : 'text-slate-300'}`}>{v}</div>
    </button>
  );
}

function Dashboard({ onKpi, onAge }: { onKpi: (k: string) => void; onAge: (a: string) => void }) {
  const d = useQuery({ queryKey: ['stores', 'bt-dashboard'], queryFn: async () => (await http.get<{ data: any }>('/stores/bill-tracker/dashboard')).data });
  if (!d.data) return <div className="card"><LoadingBlock /></div>;
  const k = d.data.kpis;
  const groups: [string, string[], string][] = [
    ['Documents', ['bills_awaited', 'dc_awaited', 'grn_awaited', 'data_pending', 'inward_unresolved', 'inward_overdue'], 'text-amber-600'],
    ['Checks & approval', ['awaiting_matching', 'mismatch', 'verification_pending', 'approval_pending', 'on_hold'], 'text-red-600'],
    ['Accounts', ['approved_not_queued', 'posting_queued', 'posting_failed', 'posted'], 'text-blue-700'],
    ['Follow-up & custody', ['overdue_followups', 'overdue_custody'], 'text-red-600'],
  ];
  return (
    <div className="space-y-4">
      {groups.map(([g, keys, tone]) => (
        <div key={g}><div className="mb-1.5 text-small font-semibold uppercase tracking-wider text-slate-500">{g}</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{keys.map((x) => <Kpi key={x} k={x} v={Number(k[x] ?? 0)} tone={tone} onClick={() => onKpi(x)} />)}</div>
        </div>))}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4">
          <div className="mb-2 text-body font-semibold">Open bills by age (days since received)</div>
          <table className="w-full text-xs"><tbody>{d.data.ageing.map((a: any) => (
            <tr key={a.bucket} data-age={a.bucket} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onAge(a.bucket)}>
              <td className="py-1.5">{a.bucket} days</td><td className="py-1.5 text-right tabular-nums">{a.bills}</td><td className="py-1.5 text-right tabular-nums">₹{fmtDecimal(a.amount, 2)}</td></tr>))}</tbody></table>
        </div>
        <div className="card p-4">
          <div className="mb-2 text-body font-semibold">Open bills: who has them</div>
          <table className="w-full text-xs"><thead className="text-slate-500"><tr><th className="text-left">Department / place</th><th className="text-right">Bills</th><th className="text-right">Overdue</th></tr></thead>
            <tbody>{d.data.holders.map((h: any) => <tr key={h.dept} className="border-t border-slate-100"><td className="py-1.5">{h.dept}</td><td className="text-right tabular-nums">{h.bills}</td>
              <td className={`text-right tabular-nums ${Number(h.overdue) ? 'text-red-600' : ''}`}>{h.overdue}</td></tr>)}</tbody></table>
        </div>
        <div className="card p-4">
          <div className="mb-2 text-body font-semibold">Average time with each department (180 days)</div>
          <table className="w-full text-xs"><thead className="text-slate-500"><tr><th className="text-left">Department / place</th><th className="text-right">Hand-offs</th><th className="text-right">Avg days</th></tr></thead>
            <tbody>{d.data.dwell.map((h: any) => <tr key={h.dept} className="border-t border-slate-100"><td className="py-1.5">{h.dept}</td><td className="text-right tabular-nums">{h.moves}</td><td className="text-right tabular-nums">{h.avg_days}</td></tr>)}
              {!d.data.dwell.length && <tr><td colSpan={3} className="py-3 text-center text-slate-400">No hand-offs yet</td></tr>}</tbody></table>
        </div>
      </div>
    </div>
  );
}

const FILTER_KEYS = ['from', 'to', 'q', 'workflow', 'category', 'kpi', 'age', 'match', 'posting', 'holder_dept', 'supplier_id', 'page'];
function BillList() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'page') p.delete('page'); setParams(p, { replace: true }); };
  const [search, setSearch] = useState(get('q'));
  const dq = useDebounced(search);
  useEffect(() => { if (dq !== get('q')) set('q', dq); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const depts = useLookup('departments');
  const parties = useLookup('payables');
  const qs = new URLSearchParams(FILTER_KEYS.filter((k) => get(k)).map((k) => [k, get(k)]));
  qs.set('page_size', '50');
  const list = useQuery({ queryKey: ['stores', 'bill-tracker', qs.toString()], queryFn: async () => http.get<{ data: any[]; pagination: any }>(`/stores/bill-tracker?${qs}`) });
  const cols: Col[] = [
    { key: 'entry_no', label: 'Tracking no', render: (r) => <span className="tabular-nums font-semibold text-brand-700">{r.entry_no}</span> },
    { key: 'supplier_name', label: 'Supplier', render: (r) => r.supplier_name ?? (r.received_from_dept ? `Dept: ${r.received_from_dept}` : '—') },
    { key: 'bill_no', label: 'Invoice no' }, { key: 'bill_date', label: 'Inv date', kind: 'date' }, { key: 'amount', label: 'Amount', kind: 'money' },
    { key: 'bill_category', label: 'Category', render: (r) => labelOf(CATEGORY_OPTIONS, r.bill_category) },
    { key: 'holder', label: 'With', render: (r) => (r.holder_name ? `${r.holder_name}${r.holder_dept ? ` · ${r.holder_dept}` : ''}` : '—') },
    { key: 'stage', label: 'Stage', render: (r) => <StageChip stage={r.stage} /> },
    { key: 'missing', label: 'Missing', render: (r) => (r.missing_labels?.length ? <span className="text-amber-700">{r.missing_labels.join(', ')}</span> : '—') },
    { key: 'match_status', label: 'Matching', render: (r) => <MatchChip v={r.match_status} /> },
    { key: 'age_days', label: 'Age', render: (r) => `${r.age_days} d` }, { key: 'next_action', label: 'Next action' },
  ];
  const pg = list.data?.pagination;
  return (
    <>
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-4">
        <Input label="Received from" type="date" className="w-36" value={get('from')} onChange={(e) => set('from', e.target.value)} />
        <Input label="To" type="date" className="w-36" value={get('to')} onChange={(e) => set('to', e.target.value)} />
        <Select label="Workflow" id="flt-workflow" className="w-44" value={get('workflow')} placeholder="All" onChange={(e) => set('workflow', e.target.value)}
          options={Object.entries(WORKFLOW_LABEL).map(([value, label]) => ({ value, label }))} />
        <Select label="Category" className="w-40" value={get('category')} placeholder="All" onChange={(e) => set('category', e.target.value)} options={CATEGORY_OPTIONS} />
        <Select label="Waiting for" id="flt-kpi" className="w-52" value={get('kpi')} placeholder="Anything" onChange={(e) => set('kpi', e.target.value)}
          options={Object.entries(KPI_LABEL).filter(([k]) => !['bills_awaited', 'overdue_followups', 'inward_unresolved', 'inward_overdue'].includes(k)).map(([value, label]) => ({ value, label }))} />
        <Select label="Age" className="w-28" value={get('age')} placeholder="All" onChange={(e) => set('age', e.target.value)} options={['0-3', '4-7', '8-15', '16-30', '31+'].map((a) => ({ value: a, label: `${a} d` }))} />
        <Select label="With department" className="w-44" value={get('holder_dept')} placeholder="All" onChange={(e) => set('holder_dept', e.target.value)} options={(depts.data ?? []).map((d: any) => ({ value: d.label, label: d.label }))} />
        <Select label="Supplier" className="w-56" value={get('supplier_id')} placeholder="All" onChange={(e) => set('supplier_id', e.target.value)} options={toOptions(parties.data)} />
        <SearchInput className="min-w-[200px] flex-1" value={search} onChange={setSearch} placeholder="Invoice no, tracking no, supplier, holder…" />
        {FILTER_KEYS.some((k) => get(k)) && <Button variant="secondary" onClick={() => { setSearch(''); setParams(new URLSearchParams({ tab: 'bills' }), { replace: true }); }}>Clear</Button>}
      </div>
      <SimpleTable cols={cols} rows={list.data?.data ?? []} loading={list.isLoading} empty="No bills match the filters"
        onRow={(r) => navigate(`/stores/bill-tracker/${r.id}`, { state: { back: location.search } })} />
      {pg && pg.totalPages > 1 && <Pager page={pg.page} totalPages={pg.totalPages} total={pg.total} pageSize={pg.pageSize} onPage={(p: number) => set('page', String(p))} />}
      {pg && <div className="mt-2 text-small text-slate-500">{pg.total} bill(s)</div>}
    </>
  );
}

function Inbox() {
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['stores', 'bt-inbox'], queryFn: async () => (await http.get<{ data: any[] }>('/stores/bill-tracker/approval-inbox')).data });
  const cols: Col[] = [
    { key: 'entry_no', label: 'Tracking no', render: (r) => <span className="tabular-nums font-semibold text-brand-700">{r.entry_no}</span> },
    { key: 'workflow_status', label: 'Waiting for', render: (r) => (r.workflow_status === 'PENDING_VERIFICATION' ? 'Verification' : 'Approval') },
    { key: 'supplier_name', label: 'Supplier' }, { key: 'bill_no', label: 'Invoice no' }, { key: 'amount', label: 'Amount', kind: 'money' },
    { key: 'bill_category', label: 'Category', render: (r) => labelOf(CATEGORY_OPTIONS, r.bill_category) },
    { key: 'match_status', label: 'Matching', render: (r) => <MatchChip v={r.match_status} /> },
    { key: 'missing', label: 'Missing', render: (r) => r.missing_labels?.join(', ') || '—' },
    { key: 'verified_by_name', label: 'Verified by' }, { key: 'prepared_by', label: 'Entered by', render: (r) => `${r.prepared_by ?? ''}${r.own_entry ? ' (you — cannot approve)' : ''}` },
    { key: 'age_days', label: 'Age', render: (r) => `${r.age_days} d` },
  ];
  return <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} empty="Nothing waiting for verification or approval" onRow={(r) => navigate(`/stores/bill-tracker/${r.id}`, { state: { back: '?tab=inbox' } })} />;
}

function Followups() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const overdue = params.get('overdue') === '1'; const mine = params.get('mine') === '1'; const status = params.get('fstatus') ?? 'OPEN';
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const list = useQuery({ queryKey: ['stores', 'bt-fu', overdue, mine, status], queryFn: async () => (await http.get<{ data: any[] }>(`/stores/bill-tracker/followups?status=${status}${overdue ? '&overdue=1' : ''}${mine ? '&mine=1' : ''}`)).data });
  const act = useAction();
  const [close, setClose] = useState<any | null>(null);
  const cols: Col[] = [
    { key: 'due_date', label: 'Due', render: (r) => <span className={r.overdue ? 'font-semibold text-red-600' : ''}>{fmtDate(r.due_date)}</span> },
    { key: 'issue_type', label: 'Issue', render: (r) => labelOf(ISSUE_OPTIONS, r.issue_type) }, { key: 'priority', label: 'Priority', kind: 'status' },
    { key: 'doc', label: 'Bill / document', render: (r) => r.entry_no ?? r.inward_no ?? '—' }, { key: 'party_name', label: 'Party' },
    { key: 'reason', label: 'Reason', render: (r) => <span className="whitespace-normal">{r.reason}</span> }, { key: 'owner_name', label: 'Owner' },
    { key: 'next_followup_date', label: 'Next follow-up', kind: 'date' }, { key: 'status', label: 'Status', kind: 'status' },
    { key: 'x', label: '', render: (r) => (r.status === 'OPEN' ? <button className="text-brand-700 hover:underline" onClick={(e) => { e.stopPropagation(); setClose(r); }}>Close</button> : r.resolution_note) },
  ];
  return (
    <>
      <div className="card mb-3 flex flex-wrap items-end gap-4 p-4">
        <Select label="Status" className="w-36" value={status} onChange={(e) => set('fstatus', e.target.value)} options={['OPEN', 'CLOSED', 'CANCELLED', 'ALL'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))} />
        <Checkbox label="Overdue only" checked={overdue} onChange={(v) => set('overdue', v ? '1' : '')} />
        <Checkbox label="Assigned to me" checked={mine} onChange={(v) => set('mine', v ? '1' : '')} />
      </div>
      <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} empty="No follow-ups"
        onRow={(r) => (r.bill_id ? navigate(`/stores/bill-tracker/${r.bill_id}`, { state: { back: `?${params}` } }) : navigate(`/stores/document-inward?open=${r.inward_id}`))} />
      {close && <TextModal title={`Close follow-up · ${close.entry_no ?? close.inward_no}`} label="How was it resolved?" confirm="Close" busy={act.isPending} onClose={() => setClose(null)}
        onConfirm={(t) => act.mutate({ url: `/stores/bill-tracker/followups/${close.id}/close`, body: { resolution_note: t } }, { onSuccess: () => setClose(null) })} />}
    </>
  );
}

function PostingQueue() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['stores', 'bt-posting', status], queryFn: async () => (await http.get<{ data: any[] }>(`/stores/bill-tracker/posting-queue${status ? `?status=${status}` : ''}`)).data });
  const act = useAction();
  const cols: Col[] = [
    { key: 'entry_no', label: 'Tracking no', render: (r) => <span className="tabular-nums font-semibold text-brand-700">{r.entry_no}</span> },
    { key: 'supplier_name', label: 'Supplier' }, { key: 'bill_no', label: 'Invoice no' }, { key: 'amount', label: 'Amount', kind: 'money' },
    { key: 'idempotency_key', label: 'Idempotency key', render: (r) => <span className="tabular-nums text-caption">{r.idempotency_key}</span> }, { key: 'adapter', label: 'Adapter' },
    { key: 'status', label: 'Status', kind: 'status' }, { key: 'attempts', label: 'Attempts' },
    { key: 'external_voucher_no', label: 'Voucher', render: (r) => (r.external_voucher_no ? `${r.external_voucher_no} · ${fmtDate(r.external_voucher_date)}` : '—') },
    { key: 'last_error_summary', label: 'Last error' }, { key: 'created_at', label: 'Queued', kind: 'date' },
  ];
  return (
    <>
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-4">
        <Select label="Status" id="pq-status" className="w-48" value={status} placeholder="All" onChange={(e) => setStatus(e.target.value)}
          options={['QUEUED', 'POSTED', 'FAILED', 'UNKNOWN', 'RECON_REQUIRED', 'CANCELLED', 'REVERSED'].map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))} />
        <div className="flex-1 text-small text-slate-500">Adapter: <b>MANUAL</b> — the accounting software is not connected yet. Accounts posts the voucher in their package and enters the voucher no on the bill.</div>
        {can('BILL_TRACKER.POST') && <Button variant="secondary" id="pq-run" loading={act.isPending} onClick={() => act.mutate({ url: '/stores/bill-tracker/posting/enqueue-eligible' })}><RefreshCw size={13} className="mr-1 inline" /> Queue approved bills</Button>}
      </div>
      <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} empty="The posting queue is empty" onRow={(r) => navigate(`/stores/bill-tracker/${r.bill_id}`, { state: { back: '?tab=posting' } })} />
    </>
  );
}

const RECON_LABEL: Record<string, string> = { APPROVED_NOT_QUEUED: 'Approved, not queued', PENDING_POSTING: 'Waiting for posting', FAILED: 'Posting failed', AMOUNT_DIFFERS: 'Posted amount differs',
  VOUCHER_REUSED: 'Voucher no on two bills', RECON_REQUIRED: 'Reconciliation required', POSTED: 'Posted', REVERSED: 'Reversed', OK: 'OK' };
function Reconciliation() {
  const navigate = useNavigate();
  const [f, setF] = useState('');
  const d = useQuery({ queryKey: ['stores', 'bt-recon'], queryFn: async () => http.get<{ data: any[]; summary: Record<string, { bills: number; amount: number }> }>('/stores/bill-tracker/reconciliation') });
  const rows = (d.data?.data ?? []).filter((r) => !f || r.recon === f);
  const cols: Col[] = [
    { key: 'entry_no', label: 'Tracking no', render: (r) => <span className="tabular-nums font-semibold text-brand-700">{r.entry_no}</span> }, { key: 'supplier_name', label: 'Supplier' },
    { key: 'bill_no', label: 'Invoice no' }, { key: 'amount', label: 'ERP amount', kind: 'money' }, { key: 'payload_amount', label: 'Sent for posting', kind: 'money' },
    { key: 'approved_at', label: 'Approved', kind: 'date' }, { key: 'queue_status', label: 'Queue', kind: 'status' },
    { key: 'external_voucher_no', label: 'Voucher', render: (r) => (r.external_voucher_no ? `${r.external_voucher_no} · ${fmtDate(r.external_voucher_date)}` : '—') },
    { key: 'recon', label: 'Result', render: (r) => <StageChip stage={RECON_LABEL[r.recon] ?? r.recon} /> },
  ];
  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {Object.entries(RECON_LABEL).filter(([k]) => k !== 'OK').map(([k, l]) => (
          <button key={k} onClick={() => setF(f === k ? '' : k)} className={`card p-3 text-left ${f === k ? 'ring-2 ring-brand-400' : ''}`}>
            <div className="text-caption uppercase tracking-wider text-slate-500">{l}</div>
            <div className="text-xl font-semibold tabular-nums">{d.data?.summary?.[k]?.bills ?? 0}</div>
            <div className="text-caption tabular-nums text-slate-500">₹{fmtDecimal(d.data?.summary?.[k]?.amount ?? 0, 2)}</div>
          </button>))}
      </div>
      <SimpleTable cols={cols} rows={rows} loading={d.isLoading} empty="No approved bills yet" onRow={(r) => navigate(`/stores/bill-tracker/${r.id}`, { state: { back: '?tab=recon' } })} />
    </>
  );
}

function Settings() {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['stores', 'bt-cats'], queryFn: async () => (await http.get<{ data: any[] }>('/stores/bill-tracker/categories')).data });
  const [rows, setRows] = useState<Record<number, any>>({});
  const act = useAction();
  const edit = can('BILL_TRACKER.CONFIG');
  if (!list.data) return <div className="card"><LoadingBlock /></div>;
  const val = (c: any) => rows[c.id] ?? c;
  const upd = (c: any, k: string, v: unknown) => setRows({ ...rows, [c.id]: { ...val(c), [k]: v } });
  const flags: [string, string][] = [['req_dc', 'DC'], ['req_receipt', 'GRN'], ['req_po', 'PO'], ['req_bill_entry', 'Bills Inward'], ['req_process', 'Process receipt / rate'], ['req_attachment', 'Scan / file']];
  return (
    <div className="card overflow-x-auto p-4">
      <div className="mb-3 text-body text-slate-600">Documents each bill category needs before it can be verified, matching tolerances (the larger of % and ₹ applies), what happens when a bill links more than a GRN / PO value, and the value above which a finance controller (BILL_TRACKER.APPROVE_HIGH) must approve.</div>
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1.5 text-left">Category</th>{flags.map(([, l]) => <th key={l} className="px-2 py-1.5">{l}</th>)}
          <th className="px-2 py-1.5">Amount tol %</th><th className="px-2 py-1.5">Amount tol ₹</th><th className="px-2 py-1.5">Qty tol %</th><th className="px-2 py-1.5">Over-billing</th><th className="px-2 py-1.5">Finance controller above ₹</th><th /></tr></thead>
        <tbody>{list.data.map((c) => { const v = val(c); return (
          <tr key={c.id} data-cat={c.category_code} className="border-t border-slate-100">
            <td className="px-2 py-1.5"><div className="font-semibold">{c.category_code}</div><div className="text-slate-500">{c.category_name}</div></td>
            {flags.map(([k]) => <td key={k} className="px-2 py-1.5 text-center"><input type="checkbox" disabled={!edit} checked={!!Number(v[k])} onChange={(e) => upd(c, k, e.target.checked ? 1 : 0)} /></td>)}
            {['amount_tol_pct', 'amount_tol_abs', 'qty_tol_pct'].map((k) => <td key={k} className="px-2 py-1.5"><input className="input w-20 text-right" type="number" step="any" disabled={!edit} value={v[k]} onChange={(e) => upd(c, k, e.target.value)} /></td>)}
            <td className="px-2 py-1.5"><select className="input w-28" disabled={!edit} value={v.over_billing} onChange={(e) => upd(c, 'over_billing', e.target.value)}><option value="APPROVAL">Needs approval</option><option value="BLOCK">Block</option></select></td>
            <td className="px-2 py-1.5"><input className="input w-28 text-right" type="number" disabled={!edit} value={v.high_value_limit} onChange={(e) => upd(c, 'high_value_limit', e.target.value)} /></td>
            <td className="px-2 py-1.5">{edit && rows[c.id] && <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ url: `/stores/bill-tracker/categories/${c.id}`, method: 'put', body: { ...v, is_active: true } },
              { onSuccess: () => { const r = { ...rows }; delete r[c.id]; setRows(r); } })}><Save size={12} className="mr-1 inline" />Save</Button>}</td>
          </tr>); })}</tbody>
      </table>
      {!edit && <div className="mt-2 text-small text-slate-500">Changing these needs BILL_TRACKER.CONFIG.</div>}
      <div className="mt-3"><StatusBadge value="INFO" /> <span className="text-small text-slate-500">Maker-checker (approver ≠ the person who entered the bill) and the posting adapter are company settings (BT_MAKER_CHECKER, BT_POSTING_ADAPTER).</span></div>
    </div>
  );
}
