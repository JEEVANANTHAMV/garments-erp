/**
 * Accounts → Vouchers
 *   /accounts/vouchers          list (type / status / Tally / source filters), bulk approve
 *   /accounts/vouchers/new      manual voucher entry (Journal / Payment / Receipt / Contra / Sales / Purchase / Debit / Credit note)
 *   /accounts/vouchers/:id      view; drafts are edited here; submit / approve / reject / cancel / reverse
 * Posted vouchers never change — corrections are reversals (spec §9.3). Maker-checker: the approver must be another user.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, Send, CheckCircle2, XCircle, Undo2, Ban } from 'lucide-react';
import { PageHeader, Button, Input, Select, Textarea, Field, SearchInput, LoadingBlock, ErrorState, Pager, useDebounced } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import {
  errMsg, inr, VOUCHER_TYPES, VOUCHER_TYPE_LABEL, VoucherStatus, TallyStatus, SOURCE_LABEL, useLedgerOptions, LedgerSelect, ReasonModal, todayIst,
} from './accShared';

const STATUS_OPTS = [
  { value: '', label: 'All statuses' }, { value: 'DRAFT', label: 'Draft' }, { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'POSTED', label: 'Posted' }, { value: 'REJECTED', label: 'Rejected' }, { value: 'REVERSED', label: 'Reversed' }, { value: 'CANCELLED', label: 'Cancelled' },
];

export function VouchersPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const f = { type: sp.get('type') ?? '', status: sp.get('status') ?? '', tally_status: sp.get('tally_status') ?? '', source: sp.get('source') ?? '', from: sp.get('from') ?? '', to: sp.get('to') ?? '' };
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPage(1); setSel(new Set()); }, [q, sp]);
  const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), q: q || undefined, page, pageSize: 50 };
  const list = useQuery({ queryKey: ['accounts', 'vouchers', params], queryFn: () => http.get<{ data: any[]; pagination: any }>('/accounts/vouchers', params) });
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const rows = list.data?.data ?? [];
  const approvable = rows.filter((r) => r.status === 'PENDING_APPROVAL');
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const approveSelected = async () => {
    setBusy(true);
    try {
      const r = await http.post<{ data: { ok: any[]; failed: any[] }; message: string }>('/accounts/vouchers/approve-many', { ids: [...sel] });
      toast(r.message, r.data.failed.length ? 'warning' : 'success');
      if (r.data.failed.length) toast(r.data.failed.slice(0, 3).map((x) => x.message).join(' · '), 'error');
      setSel(new Set());
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  const cols: Column<any>[] = [
    ...(can('ACCOUNTS.APPROVE') ? [{ key: 'sel', header: '', width: '36px', render: (r: any) => r.status === 'PENDING_APPROVAL'
      ? <input type="checkbox" aria-label="Select" checked={sel.has(r.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} /> : null }] : []),
    { key: 'voucher_no', header: 'Voucher', render: (r) => (
      <div><p className="font-semibold text-brand-700">{r.voucher_no ?? `Draft #${r.id}`}</p><p className="text-caption text-ink-secondary">{VOUCHER_TYPE_LABEL[r.type_code]}</p></div>) },
    { key: 'voucher_date', header: 'Date', render: (r) => <span className="tabular-nums">{r.voucher_date}</span> },
    { key: 'party_name', header: 'Party / narration', render: (r) => (
      <div className="max-w-[380px]"><p className="truncate">{r.party_name ?? '—'}</p><p className="truncate text-caption text-ink-secondary">{r.narration ?? ''}</p></div>) },
    { key: 'source', header: 'From', render: (r) => r.source_module
      ? <div><p>{SOURCE_LABEL[r.source_module] ?? r.source_module}</p><p className="text-caption text-ink-secondary">{r.source_no}</p></div>
      : <span className="text-caption text-ink-secondary">Manual</span> },
    { key: 'total_debit', header: 'Amount ₹', align: 'right', render: (r) => (
      <div className="tabular-nums"><p>{inr(r.total_debit)}</p>{r.currency_code && r.fc_amount ? <p className="text-caption text-ink-secondary">{r.currency_code} {inr(r.fc_amount)}</p> : null}</div>) },
    { key: 'status', header: 'Status', render: (r) => <VoucherStatus value={r.status} /> },
    { key: 'tally_status', header: 'Tally', render: (r) => <TallyStatus value={r.tally_status} /> },
  ];
  const pg = list.data?.pagination;
  return (
    <div>
      <PageHeader title="Vouchers" breadcrumb={['Accounts']} subtitle="Every accounting entry — manual and generated from ERP documents. Posted vouchers are corrected by reversal."
        actions={<>
          {can('ACCOUNTS.APPROVE') && sel.size > 0 && <Button id="acc-approve-selected" loading={busy} onClick={() => void approveSelected()}><CheckCircle2 size={14} />Approve {sel.size}</Button>}
          {can('ACCOUNTS.APPROVE') && approvable.length > 0 && sel.size === 0 && (
            <Button variant="secondary" onClick={() => setSel(new Set(approvable.map((r) => r.id)))}>Select pending on this page</Button>)}
          {can('ACCOUNTS.ENTRY') && <Button id="acc-voucher-new" onClick={() => nav('/accounts/vouchers/new')}><Plus size={14} />New voucher</Button>}
        </>} />
      <div className="card mb-3 grid grid-cols-2 gap-2 p-3 md:grid-cols-7">
        <SearchInput value={search} onChange={setSearch} placeholder="Voucher / ref / party / narration" className="md:col-span-2" />
        <Select value={f.type} onChange={(e) => set('type', e.target.value)} options={[{ value: '', label: 'All types' }, ...VOUCHER_TYPES.map((t) => ({ value: t, label: VOUCHER_TYPE_LABEL[t] }))]} />
        <Select id="acc-filter-status" value={f.status} onChange={(e) => set('status', e.target.value)} options={STATUS_OPTS} />
        <Select value={f.source} onChange={(e) => set('source', e.target.value)} options={[{ value: '', label: 'All sources' }, { value: 'MANUAL', label: 'Manual' }, ...Object.entries(SOURCE_LABEL).map(([k, v]) => ({ value: k, label: v }))]} />
        <Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="From" />
        <Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="To" />
      </div>
      <DataTable columns={cols} rows={rows} loading={list.isLoading} error={list.error} rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/accounts/vouchers/${r.id}`)} emptyTitle="No vouchers" emptyMessage="Change the filters, or scan ERP documents from the Accounts inbox." />
      {pg && pg.total > pg.pageSize && (
        <Pager page={pg.page} total={pg.total} pageSize={pg.pageSize} totalPages={Math.ceil(pg.total / pg.pageSize)} onPage={setPage} />)}
    </div>
  );
}

interface Line { key: number; ledger_id: number | null; debit: string; credit: string; narration: string; bill_ref_type: string; bill_ref_no: string; bill_due_date: string }
const blank = (key: number): Line => ({ key, ledger_id: null, debit: '', credit: '', narration: '', bill_ref_type: '', bill_ref_no: '', bill_due_date: '' });
const n = (v: string) => Math.round((Number(v) || 0) * 100) / 100;

export function VoucherDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can, user } = useAuth();
  const ledgers = useLedgerOptions();
  const det = useQuery({ queryKey: ['accounts', 'voucher', id], enabled: !isNew, queryFn: async () => (await http.get<{ data: any }>(`/accounts/vouchers/${id}`)).data });
  const v = det.data;
  const editable = isNew || (v && ['DRAFT', 'REJECTED'].includes(v.status) && !v.is_auto && can('ACCOUNTS.ENTRY'));
  const [h, setH] = useState({ type_code: 'JOURNAL', voucher_date: todayIst(), ref_no: '', ref_date: '', narration: '' });
  const [lines, setLines] = useState<Line[]>([blank(1), blank(2)]);
  const [busy, setBusy] = useState('');
  const [modal, setModal] = useState<'' | 'reject' | 'cancel' | 'reverse'>('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!v) return;
    setH({ type_code: v.type_code, voucher_date: v.voucher_date, ref_no: v.ref_no ?? '', ref_date: v.ref_date ?? '', narration: v.narration ?? '' });
    setLines(v.entries.map((e: any, i: number) => ({ key: i + 1, ledger_id: e.ledger_id, debit: Number(e.debit) ? String(e.debit) : '', credit: Number(e.credit) ? String(e.credit) : '',
      narration: e.narration ?? '', bill_ref_type: e.bill_ref_type ?? '', bill_ref_no: e.bill_ref_no ?? '', bill_due_date: e.bill_due_date ?? '' })));
  }, [v]);

  const byId = useMemo(() => new Map((ledgers.data ?? []).map((l) => [l.id, l])), [ledgers.data]);
  const dr = lines.reduce((t, l) => t + n(l.debit), 0);
  const cr = lines.reduce((t, l) => t + n(l.credit), 0);
  const diff = Math.round((dr - cr) * 100) / 100;
  const upd = (k: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const addLine = () => setLines((ls) => {
    const next = blank(Math.max(0, ...ls.map((l) => l.key)) + 1);
    if (diff > 0) next.credit = String(diff); else if (diff < 0) next.debit = String(-diff);
    return [...ls, next];
  });

  const save = async (submit: boolean) => {
    setErr(''); setBusy(submit ? 'submit' : 'save');
    const body = { ...h, ref_date: h.ref_date || null, submit, row_version: v?.row_version,
      entries: lines.filter((l) => l.ledger_id || n(l.debit) || n(l.credit)).map((l) => ({
        ledger_id: l.ledger_id, debit: n(l.debit) || null, credit: n(l.credit) || null, narration: l.narration || null,
        bill_ref_type: l.bill_ref_type || null, bill_ref_no: l.bill_ref_no || null, bill_due_date: l.bill_due_date || null })) };
    try {
      const r = isNew ? await http.post<{ data: any; message: string }>('/accounts/vouchers', body) : await http.put<{ data: any; message: string }>(`/accounts/vouchers/${id}`, body);
      toast(r.message);
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      if (isNew) nav(`/accounts/vouchers/${r.data.id}`, { replace: true });
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(''); }
  };
  const act = async (path: string, body?: unknown) => {
    setErr(''); setBusy(path);
    try {
      const r = await http.post<{ data: any; message: string }>(`/accounts/vouchers/${id}/${path}`, body);
      toast(r.message); setModal('');
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      if (path === 'reverse' && r.data.reversal_id) nav(`/accounts/vouchers/${r.data.reversal_id}`);
    } catch (e) { setErr(errMsg(e)); setModal(''); } finally { setBusy(''); }
  };

  if (!isNew && det.isLoading) return <LoadingBlock />;
  if (!isNew && det.error) return <ErrorState error={det.error} onRetry={() => void det.refetch()} />;
  const ownVoucher = v && !v.is_auto && Number(v.submitted_by ?? v.created_by) === Number(user?.id);
  const title = isNew ? 'New voucher' : `${VOUCHER_TYPE_LABEL[v.type_code]} ${v.voucher_no ?? `(draft #${v.id})`}`;

  return (
    <div>
      <PageHeader title={title} breadcrumb={['Accounts', 'Vouchers']}
        subtitle={v ? <span className="flex flex-wrap items-center gap-2"><VoucherStatus value={v.status} /><TallyStatus value={v.tally_status} />
          {v.source_module && <span>From {v.source_label ?? SOURCE_LABEL[v.source_module]} {v.source_link ? <Link className="text-brand-700 hover:underline" to={v.source_link}>{v.source_no}</Link> : v.source_no}</span>}</span>
          : 'Debit and credit totals must match. Party lines with bill-wise on need a bill reference.'}
        actions={<>
          {editable && <Button id="acc-v-save" variant="secondary" loading={busy === 'save'} onClick={() => void save(false)}><Save size={14} />Save draft</Button>}
          {editable && <Button id="acc-v-submit" loading={busy === 'submit'} onClick={() => void save(true)}><Send size={14} />Submit for approval</Button>}
          {v?.status === 'PENDING_APPROVAL' && can('ACCOUNTS.APPROVE') && (
            <Button id="acc-v-approve" loading={busy === 'approve'} disabled={!!ownVoucher} title={ownVoucher ? 'Maker-checker: another user approves' : undefined}
              onClick={() => void act('approve')}><CheckCircle2 size={14} />Approve &amp; post</Button>)}
          {v?.status === 'PENDING_APPROVAL' && can('ACCOUNTS.APPROVE') && <Button id="acc-v-reject" variant="danger" onClick={() => setModal('reject')}><XCircle size={14} />Reject</Button>}
          {v && ['DRAFT', 'PENDING_APPROVAL', 'REJECTED'].includes(v.status) && can('ACCOUNTS.ENTRY') && <Button variant="ghost" onClick={() => setModal('cancel')}><Ban size={14} />Cancel</Button>}
          {v?.status === 'POSTED' && can('ACCOUNTS.APPROVE') && <Button id="acc-v-reverse" variant="danger" onClick={() => setModal('reverse')}><Undo2 size={14} />Reverse</Button>}
        </>} />
      {err && <div className="mb-3 rounded border border-status-error-text/30 bg-status-error-background px-3 py-2 text-body text-status-error-text" id="acc-v-error">{err}</div>}
      {v?.reject_reason && v.status === 'REJECTED' && <div className="mb-3 rounded bg-status-error-background px-3 py-2 text-body text-status-error-text">Rejected: {v.reject_reason}</div>}
      {v?.reversal_of_no && <p className="mb-2 text-body">Reversal of <Link className="text-brand-700 hover:underline" to={`/accounts/vouchers/${v.reversal_of_id}`}>{v.reversal_of_no}</Link></p>}
      {v?.reversed_by_no && <p className="mb-2 text-body">Reversed by <Link className="text-brand-700 hover:underline" to={`/accounts/vouchers/${v.reversed_by_id}`}>{v.reversed_by_no}</Link>{v.cancel_reason ? ` — ${v.cancel_reason}` : ''}</p>}

      <div className="card mb-3 grid grid-cols-1 gap-3 p-4 md:grid-cols-5">
        <Field label="Voucher type" required>
          <Select id="acc-v-type" disabled={!editable} value={h.type_code} onChange={(e) => setH({ ...h, type_code: e.target.value })}
            options={VOUCHER_TYPES.map((t) => ({ value: t, label: VOUCHER_TYPE_LABEL[t] }))} />
        </Field>
        <Field label="Date" required><Input id="acc-v-date" type="date" disabled={!editable} value={h.voucher_date} onChange={(e) => setH({ ...h, voucher_date: e.target.value })} /></Field>
        <Field label="Reference (invoice / UTR / cheque)"><Input id="acc-v-ref" disabled={!editable} value={h.ref_no} onChange={(e) => setH({ ...h, ref_no: e.target.value })} /></Field>
        <Field label="Reference date"><Input type="date" disabled={!editable} value={h.ref_date} onChange={(e) => setH({ ...h, ref_date: e.target.value })} /></Field>
        <Field label="Currency">{v?.currency_code ? <p className="py-2 tabular-nums">{v.currency_code} {inr(v.fc_amount)} @ {v.exchange_rate}</p> : <p className="py-2 text-ink-secondary">INR</p>}</Field>
        <Field label="Narration" className="md:col-span-5">
          <Textarea id="acc-v-narration" rows={2} disabled={!editable} value={h.narration} onChange={(e) => setH({ ...h, narration: e.target.value })} />
        </Field>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full" id="acc-v-lines">
          <thead><tr>
            <th className="th w-8">#</th><th className="th min-w-[280px]">Ledger</th><th className="th w-36 text-right">Debit ₹</th><th className="th w-36 text-right">Credit ₹</th>
            <th className="th min-w-[260px]">Bill-wise</th><th className="th min-w-[180px]">Line note</th>{editable && <th className="th w-10" />}
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const led = l.ledger_id ? byId.get(l.ledger_id) : undefined;
              const ev = v?.entries?.[i];
              return (
                <tr key={l.key} className="align-top">
                  <td className="td tabular-nums">{i + 1}</td>
                  <td className="td">
                    {editable ? <LedgerSelect id={`acc-line-ledger-${i}`} value={l.ledger_id} options={ledgers.data ?? []} onChange={(x) => upd(l.key, { ledger_id: x })} />
                      : <div><p>{ev?.ledger_name}</p><p className="text-caption text-ink-secondary">{ev?.group_name}{ev?.io_no ? ` · IO ${ev.io_no}` : ''}</p></div>}
                  </td>
                  <td className="td">{editable ? <Input id={`acc-line-dr-${i}`} className="text-right tabular-nums" inputMode="decimal" value={l.debit} onChange={(e) => upd(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
                    : <p className="text-right tabular-nums">{inr(l.debit, true)}</p>}</td>
                  <td className="td">{editable ? <Input id={`acc-line-cr-${i}`} className="text-right tabular-nums" inputMode="decimal" value={l.credit} onChange={(e) => upd(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
                    : <p className="text-right tabular-nums">{inr(l.credit, true)}</p>}</td>
                  <td className="td">
                    {editable && led && Number(led.is_bill_wise) ? (
                      <div className="grid grid-cols-2 gap-1">
                        <select className="input" value={l.bill_ref_type} onChange={(e) => upd(l.key, { bill_ref_type: e.target.value })} data-native-select>
                          <option value="">On account</option><option value="NEW">New ref</option><option value="AGAINST">Against ref</option><option value="ADVANCE">Advance</option>
                        </select>
                        <Input placeholder="Bill no" value={l.bill_ref_no} disabled={!l.bill_ref_type} onChange={(e) => upd(l.key, { bill_ref_no: e.target.value })} />
                      </div>
                    ) : l.bill_ref_type ? <span className="text-body">{l.bill_ref_type === 'ON_ACCOUNT' ? 'On account' : `${l.bill_ref_type === 'NEW' ? 'New' : l.bill_ref_type === 'AGAINST' ? 'Against' : 'Advance'} ${l.bill_ref_no}`}</span>
                      : <span className="text-caption text-ink-secondary">—</span>}
                  </td>
                  <td className="td">{editable ? <Input value={l.narration} onChange={(e) => upd(l.key, { narration: e.target.value })} /> : <span className="text-body">{l.narration}</span>}</td>
                  {editable && <td className="td"><button type="button" aria-label="Remove line" className="text-ink-secondary hover:text-status-error-text" disabled={lines.length <= 2}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 size={14} /></button></td>}
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr className="border-t border-surface-border">
            <td className="td" />
            <td className="td">{editable && <Button id="acc-line-add" size="sm" variant="secondary" onClick={addLine}><Plus size={14} />Add line</Button>}</td>
            <td className="td text-right font-semibold tabular-nums">{inr(dr)}</td>
            <td className="td text-right font-semibold tabular-nums">{inr(cr)}</td>
            <td className="td" colSpan={editable ? 3 : 2}>
              {diff === 0 ? <span className="text-status-success-text">Balanced</span> : <span className="text-status-error-text" id="acc-v-diff">Difference {inr(Math.abs(diff))} {diff > 0 ? '(more debit)' : '(more credit)'}</span>}
            </td>
          </tr></tfoot>
        </table>
      </div>

      {v && (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="card p-4 text-body">
            <p className="mb-2 text-title font-semibold">Approval</p>
            <p>Created by {v.created_by_name ?? (v.is_auto ? 'automatic scan' : '—')}</p>
            {v.submitted_by_name && <p>Submitted by {v.submitted_by_name}</p>}
            {v.approved_by_name && <p>Posted by {v.approved_by_name} · {String(v.approved_at ?? '').slice(0, 16).replace('T', ' ')}</p>}
            {v.history?.length > 0 && (
              <ul className="mt-2 space-y-1 text-caption text-ink-secondary">
                {v.history.slice(0, 8).map((x: any) => <li key={x.id}>{String(x.changed_at).slice(0, 16).replace('T', ' ')} · {x.user_name ?? 'system'} · {x.new_values?.action ?? 'update'}{x.new_values?.reason ? ` — ${x.new_values.reason}` : ''}</li>)}
              </ul>)}
          </div>
          <div className="card p-4 text-body">
            <p className="mb-2 text-title font-semibold">Tally</p>
            {v.tally?.length ? v.tally.map((t: any) => (
              <div key={t.id} className="space-y-0.5">
                <p>{t.tally_company_name} · {t.connector === 'HTTP' ? 'Tally server' : 'XML file'} · <TallyStatus value={t.status === 'PENDING' ? 'PENDING' : t.status} /></p>
                {t.tally_voucher_no && <p>Tally voucher {t.tally_voucher_no}</p>}
                {t.last_error && <p className="text-status-error-text">{t.last_error}</p>}
                <p className="text-caption text-ink-secondary">Key {t.idempotency_key} · {t.attempts} attempt(s)</p>
              </div>)) : <p className="text-ink-secondary">{v.status === 'POSTED' ? 'No Tally company set up — see Accounts → Tally.' : 'Sent to Tally after posting.'}</p>}
          </div>
        </div>
      )}

      <ReasonModal open={modal === 'reject'} title="Reject voucher" confirm="Reject" busy={busy === 'reject'} onClose={() => setModal('')} onSubmit={(reason) => void act('reject', { reason })} />
      <ReasonModal open={modal === 'cancel'} title="Cancel voucher" confirm="Cancel voucher" busy={busy === 'cancel'} onClose={() => setModal('')} onSubmit={(reason) => void act('cancel', { reason })} />
      <ReasonModal open={modal === 'reverse'} title="Reverse posted voucher" label="Why is it reversed?" confirm="Post reversal" busy={busy === 'reverse'} withDate=""
        onClose={() => setModal('')} onSubmit={(reason, date) => void act('reverse', { reason, date: date || null })} />
    </div>
  );
}

