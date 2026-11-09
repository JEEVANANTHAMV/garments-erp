/**
 * Accounts → Dashboard and Inbox.
 *   /accounts          dashboard: approvals waiting, documents with problems, Tally queue, this month's books
 *   /accounts/inbox    ERP documents → vouchers: waiting / problems / changed after posting; Scan now; create one
 * Final ERP documents (Bills Inward, process / contractor bills, payments, commercial invoices, bank realisation,
 * incentive receipts) are turned into vouchers by a scan (automatic every few minutes + "Scan now").
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, FilePlus2, CheckCircle2 } from 'lucide-react';
import { PageHeader, Button, Tabs, LoadingBlock, ErrorState, Badge, Select } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { errMsg, inr, Kpi, VOUCHER_TYPE_LABEL } from './accShared';

export function AccountsDashboardPage() {
  const nav = useNavigate();
  const d = useQuery({ queryKey: ['accounts', 'dashboard'], queryFn: async () => (await http.get<{ data: any }>('/accounts/dashboard')).data });
  if (d.isLoading) return <LoadingBlock />;
  if (d.error) return <ErrorState error={d.error} onRetry={() => void d.refetch()} />;
  const x = d.data;
  const v = x.vouchers ?? {};
  const modes = Object.fromEntries((x.rules ?? []).map((r: any) => [r.mode, Number(r.n)]));
  return (
    <div>
      <PageHeader title="Accounts" breadcrumb={['Accounts']}
        subtitle={<>Books of this company{x.fy ? ` · FY ${x.fy.fy_code}` : ''}{x.locked_upto ? ` · locked up to ${x.locked_upto}` : ''} · automatic posting:{' '}
          {modes.AUTO ? `${modes.AUTO} auto` : ''}{modes.REVIEW ? `${modes.AUTO ? ', ' : ''}${modes.REVIEW} for review` : ''}{modes.OFF ? `, ${modes.OFF} off` : ''}</>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi id="acc-kpi-pending" label="Waiting for approval" value={v.pending ?? 0} tone={v.pending ? 'amber' : undefined} onClick={() => nav('/accounts/vouchers?status=PENDING_APPROVAL')} />
        <Kpi label="Drafts / rejected" value={(v.drafts ?? 0) + (v.rejected ?? 0)} onClick={() => nav('/accounts/vouchers?status=DRAFT')} />
        <Kpi id="acc-kpi-issues" label="Documents with problems" value={x.issues} tone={x.issues ? 'red' : undefined} onClick={() => nav('/accounts/inbox?tab=issues')} />
        <Kpi label="Posted vouchers" value={v.posted ?? 0} tone="green" onClick={() => nav('/accounts/vouchers?status=POSTED')} />
        <Kpi label="Waiting for Tally" value={v.tally_pending ?? 0} onClick={() => nav('/accounts/tally')} hint={x.tally?.length ? x.tally.filter((t: any) => Number(t.is_active)).map((t: any) => t.tally_company_name).join(', ') : 'Tally not set up'} />
        <Kpi label="Tally failed / unknown" value={(v.tally_failed ?? 0) + (v.tally_unknown ?? 0)} tone={(v.tally_failed ?? 0) + (v.tally_unknown ?? 0) ? 'red' : undefined} onClick={() => nav('/accounts/tally?tab=problems')} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <p className="mb-2 text-title font-semibold">Posted this month</p>
          {x.month?.length ? (
            <table className="w-full"><tbody>
              {x.month.map((m: any) => (
                <tr key={m.type_code} className="row-hover cursor-pointer" onClick={() => nav(`/accounts/vouchers?type=${m.type_code}&status=POSTED`)}>
                  <td className="td">{VOUCHER_TYPE_LABEL[m.type_code] ?? m.type_code}</td><td className="td text-right tabular-nums">{m.n}</td>
                  <td className="td text-right tabular-nums">₹ {inr(m.amount)}</td>
                </tr>))}
            </tbody></table>) : <p className="text-body text-ink-secondary">Nothing posted this month yet.</p>}
        </div>
        <div className="card p-4 text-body">
          <p className="mb-2 text-title font-semibold">How entries reach the books</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>Final ERP documents (bills, payments, commercial invoices, bank realisation, incentive receipts) become vouchers by the scan — see <Link className="text-brand-700 hover:underline" to="/accounts/inbox">Inbox</Link>.</li>
            <li>Vouchers wait for approval (switch per document type in <Link className="text-brand-700 hover:underline" to="/accounts/settings?tab=rules">Settings</Link>); another user approves (maker-checker).</li>
            <li>Posted vouchers go to Tally — <Link className="text-brand-700 hover:underline" to="/accounts/tally">XML file today</Link>, the Tally connection when its API is confirmed.</li>
            <li>Books: <Link className="text-brand-700 hover:underline" to="/accounts/reports">trial balance, ledgers, P&amp;L, balance sheet, outstanding</Link>. Order-wise profit stays in Reports → Budget vs Actuals.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}

const TABS = [{ key: 'waiting', label: 'Waiting for a voucher' }, { key: 'issues', label: 'Problems' }, { key: 'changed', label: 'Changed after posting' }, { key: 'review', label: 'Vouchers to approve' }];

export function AccountsInboxPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'waiting';
  const [ev, setEv] = useState('');
  const [busy, setBusy] = useState<string>('');
  const pending = useQuery({ queryKey: ['accounts', 'inbox', 'pending'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/inbox/pending')).data, enabled: tab === 'waiting' || tab === 'issues' });
  const changed = useQuery({ queryKey: ['accounts', 'inbox', 'changed'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/inbox/changed')).data, enabled: tab === 'changed' });
  const review = useQuery({ queryKey: ['accounts', 'vouchers', 'review'], enabled: tab === 'review',
    queryFn: async () => (await http.get<{ data: any[] }>('/accounts/vouchers', { status: 'PENDING_APPROVAL', pageSize: 200 })).data });
  const rows = (pending.data ?? []).filter((r) => (tab === 'issues' ? !!r.issue : !r.issue) && (!ev || r.event === ev));
  const events = useMemo(() => [...new Map((pending.data ?? []).map((r) => [r.event, r.label])).entries()], [pending.data]);
  const setTab = (k: string) => { const n = new URLSearchParams(sp); n.set('tab', k); setSp(n, { replace: true }); };

  const scan = async () => {
    setBusy('scan');
    try { const r = await http.post<{ message: string }>('/accounts/inbox/scan', {}); toast(r.message); void qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(''); }
  };
  const create = async (r: any, post = false) => {
    setBusy(`${r.event}:${r.source_id}`);
    try { const x = await http.post<{ message: string }>('/accounts/inbox/create', { event: r.event, source_id: r.source_id, post }); toast(x.message); void qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (e) { toast(errMsg(e), 'error'); void qc.invalidateQueries({ queryKey: ['accounts', 'inbox'] }); } finally { setBusy(''); }
  };
  const approveAll = async () => {
    setBusy('approve');
    try {
      const r = await http.post<{ data: { ok: any[]; failed: any[] }; message: string }>('/accounts/vouchers/approve-many', { ids: (review.data ?? []).map((x) => x.id) });
      toast(r.message, r.data.failed.length ? 'warning' : 'success');
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(''); }
  };

  const docCols: Column<any>[] = [
    { key: 'label', header: 'Document', render: (r) => <div><p className="font-semibold"><Link className="text-brand-700 hover:underline" to={r.link} onClick={(e) => e.stopPropagation()}>{r.source_no ?? `#${r.source_id}`}</Link></p><p className="text-caption text-ink-secondary">{r.label}</p></div> },
    { key: 'date', header: 'Date', render: (r) => <span className="tabular-nums">{r.date}</span> },
    { key: 'amount', header: 'Amount ₹', align: 'right', render: (r) => <span className="tabular-nums">{inr(r.amount)}</span> },
    { key: 'mode', header: 'Posting', render: (r) => r.before_effective ? <Badge tone="slate">Before start date</Badge> : r.mode === 'OFF' ? <Badge tone="slate">Switch off</Badge> : <Badge tone="blue">{r.mode === 'AUTO' ? 'Auto' : 'Review'}</Badge> },
    ...(tab === 'issues' ? [{ key: 'issue', header: 'Problem', render: (r: any) => (
      <div className="max-w-[460px]"><p className="text-status-error-text">{r.issue.message}</p>
        <p className="text-caption text-ink-secondary">{r.issue.code === 'MAPPING' ? 'Fix in Accounts → Settings / Masters, then Scan again' : r.issue.code === 'DATA' ? 'Correct the document, then Scan again' : ''} · tried {r.issue.attempts}×</p></div>) }] : []),
    { key: 'act', header: '', render: (r) => can('ACCOUNTS.ENTRY') ? (
      <div className="flex gap-1">
        <Button size="sm" variant="secondary" loading={busy === `${r.event}:${r.source_id}`} onClick={(e) => { e.stopPropagation(); void create(r); }}><FilePlus2 size={14} />Make voucher</Button>
      </div>) : null },
  ];
  const chCols: Column<any>[] = [
    { key: 'voucher_no', header: 'Voucher', render: (r) => <div><p className="font-semibold text-brand-700">{r.voucher_no ?? `Pending #${r.voucher_id}`}</p><p className="text-caption text-ink-secondary">{r.status === 'POSTED' ? 'Posted' : 'Waiting for approval'}</p></div> },
    { key: 'doc', header: 'Document', render: (r) => <div><Link className="text-brand-700 hover:underline" to={r.link} onClick={(e) => e.stopPropagation()}>{r.source_no}</Link><p className="text-caption text-ink-secondary">{r.label}</p></div> },
    { key: 'amount', header: 'Voucher ₹', align: 'right', render: (r) => <span className="tabular-nums">{inr(r.amount)}</span> },
    { key: 'reason', header: 'What changed', render: (r) => <span className="text-status-error-text">{r.reason}</span> },
    { key: 'todo', header: 'Action', render: (r) => <span className="text-caption text-ink-secondary">{r.status === 'POSTED' ? 'Open → Reverse; the corrected document posts again' : 'Open → Reject'}</span> },
  ];
  const rvCols: Column<any>[] = [
    { key: 'type', header: 'Type', render: (r) => VOUCHER_TYPE_LABEL[r.type_code] },
    { key: 'voucher_date', header: 'Date', render: (r) => <span className="tabular-nums">{r.voucher_date}</span> },
    { key: 'source_no', header: 'Document', render: (r) => r.source_no ?? 'Manual' },
    { key: 'party_name', header: 'Party', render: (r) => r.party_name ?? '—' },
    { key: 'total_debit', header: 'Amount ₹', align: 'right', render: (r) => <span className="tabular-nums">{inr(r.total_debit)}</span> },
  ];

  const counts = { waiting: (pending.data ?? []).filter((r) => !r.issue).length, issues: (pending.data ?? []).filter((r) => r.issue).length };
  return (
    <div>
      <PageHeader title="Accounts inbox" breadcrumb={['Accounts']} subtitle="ERP documents on their way into the books. The scan also runs automatically every few minutes."
        actions={<>
          {tab === 'review' && can('ACCOUNTS.APPROVE') && (review.data?.length ?? 0) > 0 && (
            <Button id="acc-approve-all" loading={busy === 'approve'} onClick={() => void approveAll()}><CheckCircle2 size={14} />Approve all {review.data?.length}</Button>)}
          {can('ACCOUNTS.ENTRY') && <Button id="acc-scan" loading={busy === 'scan'} onClick={() => void scan()}><RefreshCw size={14} />Scan now</Button>}
        </>} />
      <Tabs tabs={TABS.map((t) => ({ ...t, count: t.key === 'waiting' ? counts.waiting : t.key === 'issues' ? counts.issues : t.key === 'changed' ? changed.data?.length : t.key === 'review' ? review.data?.length : undefined }))} active={tab} onChange={setTab} />
      <div className="mt-3">
        {(tab === 'waiting' || tab === 'issues') && (
          <>
            {events.length > 1 && <div className="mb-2 w-72"><Select value={ev} onChange={(e) => setEv(e.target.value)} options={[{ value: '', label: 'All documents' }, ...events.map(([k, l]) => ({ value: k, label: l }))]} /></div>}
            {tab === 'waiting' && <p className="mb-2 text-caption text-ink-secondary">Documents dated before the start date, or whose switch is off, are not picked up by the scan — make their voucher here when needed.</p>}
            <DataTable columns={docCols} rows={rows} loading={pending.isLoading} error={pending.error} rowKey={(r) => `${r.event}:${r.source_id}`}
              emptyTitle={tab === 'issues' ? 'No problems' : 'Nothing waiting'} emptyMessage={tab === 'issues' ? 'Every document the scan picked up has a voucher.' : 'Every final document has a voucher.'} />
          </>)}
        {tab === 'changed' && (
          <DataTable columns={chCols} rows={changed.data ?? []} loading={changed.isLoading} error={changed.error} rowKey={(r) => r.voucher_id}
            onRowClick={(r) => nav(`/accounts/vouchers/${r.voucher_id}`)} emptyTitle="Nothing changed" emptyMessage="No document was cancelled, reopened or re-valued after its voucher was made." />)}
        {tab === 'review' && (
          <DataTable columns={rvCols} rows={review.data ?? []} loading={review.isLoading} error={review.error} rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/accounts/vouchers/${r.id}`)} emptyTitle="Nothing to approve" />)}
      </div>
    </div>
  );
}
