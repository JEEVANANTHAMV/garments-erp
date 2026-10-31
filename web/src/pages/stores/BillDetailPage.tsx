import { useState, type ReactNode } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Send, CornerDownLeft, Landmark, Link2, PlayCircle, CheckCircle2, ShieldCheck, Undo2, PauseCircle, XCircle, Truck, BookCheck, RotateCcw, Plus } from 'lucide-react';
import { PageHeader, Tabs, Modal, FormSection, Input, Select, Textarea, Button, LoadingBlock, StatusBadge, Badge } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtDecimal } from '../../lib/format';
import { today, useAction, InfoGrid, ReasonModal } from './shared';
import { BillEditor, LinkDialog, TextModal, FilePick, AttachmentList, StageChip, MatchChip, CATEGORY_OPTIONS, WORKFLOW_LABEL, labelOf, useDeptOptions, DEPT_HINT, ISSUE_OPTIONS } from './billShared';

/**
 * Bill workspace (client spec 24-Oct-2026 §16): who has the bill and its last movement at the top; tabs for overview,
 * documents & links, matching, movement timeline, approvals, follow-ups, accounting posting and the audit history.
 * Every button is checked again on the server (permissions, maker-checker, gates).
 */
const TABS = ['overview', 'docs', 'matching', 'movements', 'approvals', 'followups', 'posting', 'audit'] as const;
const TAB_LABEL: Record<string, string> = { overview: 'Overview', docs: 'Documents & links', matching: 'Matching', movements: 'Movement timeline', approvals: 'Approvals',
  followups: 'Follow-ups', posting: 'Accounting posting', audit: 'Audit history' };

type Dialog = null | 'edit' | 'link' | 'handover' | 'received-back' | 'submit-accounts' | 'move' | 'followup' | 'posted' | 'failed' | 'reverse'
  | { kind: 'text'; url: string; title: string; label: string; confirm: string; field?: string; danger?: boolean; min?: number }
  | { kind: 'reason'; url: string; title: string; confirm: string };

export default function BillDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const location = useLocation();
  const back = (location.state as any)?.back ?? '';
  const [tab, setTab] = useState<string>('overview');
  const d = useQuery({ queryKey: ['stores', 'bill-tracker', 'doc', id], queryFn: async () => (await http.get<{ data: any }>(`/stores/bill-tracker/${id}`)).data });
  const act = useAction();
  const [dlg, setDlg] = useState<Dialog>(null);
  const b = d.data;
  if (d.isError) return <div className="card p-6 text-red-600">{(d.error as any)?.message ?? 'Bill not found'}</div>;
  if (!b) return <div className="card"><LoadingBlock /></div>;
  const r = b.rights; const wf = b.workflow_status;
  const post = (url: string, body: unknown = {}) => act.mutate({ url: `/stores/bill-tracker/${id}/${url}`, body: { ...(body as object), row_version: b.row_version } }, { onSuccess: () => setDlg(null) });
  const text = (url: string, title: string, label: string, confirm: string, extra: Partial<{ field: string; danger: boolean; min: number }> = {}) => setDlg({ kind: 'text', url, title, label, confirm, ...extra });
  const btn = (key: string, label: ReactNode, onClick: () => void, variant: 'primary' | 'secondary' | 'danger' = 'secondary') =>
    <Button key={key} id={`bt-${key}`} size="sm" variant={variant} loading={act.isPending && false} onClick={onClick}>{label}</Button>;
  const legacyLive = !['SUBMITTED', 'CANCELLED'].includes(b.status);
  const postingLive = (b.postings ?? []).find((p: any) => !['CANCELLED'].includes(p.status));
  const actions: ReactNode[] = [];
  if (r.edit && wf === 'OPEN') actions.push(btn('edit', 'Edit', () => setDlg('edit')));
  if (r.edit && ['OPEN', 'PENDING_VERIFICATION'].includes(wf)) actions.push(btn('link', <><Link2 size={13} className="mr-1 inline" />Link document</>, () => setDlg('link')));
  if (r.edit && !['CANCELLED', 'REVERSED'].includes(wf)) actions.push(btn('match', <><PlayCircle size={13} className="mr-1 inline" />Run matching</>, () => act.mutate({ url: `/stores/bill-tracker/${id}/match` }, { onSuccess: () => setTab('matching') })));
  if (r.edit && ['RECEIVED', 'RECEIVED_BACK'].includes(b.status)) actions.push(btn('handover', <><Send size={13} className="mr-1 inline" />Hand over</>, () => setDlg('handover')));
  if (r.edit && b.status === 'HANDED_OVER') actions.push(btn('back', <><CornerDownLeft size={13} className="mr-1 inline" />Received back</>, () => setDlg('received-back')));
  if (r.edit && wf !== 'CANCELLED') actions.push(btn('move', <><Truck size={13} className="mr-1 inline" />Move</>, () => setDlg('move')));
  if (r.edit && legacyLive) actions.push(btn('accounts', <><Landmark size={13} className="mr-1 inline" />Submit to accounts</>, () => setDlg('submit-accounts'), 'primary'));
  else if (r.edit && wf === 'OPEN') actions.push(btn('submit', <><Send size={13} className="mr-1 inline" />Submit for verification</>, () => post('submit-verification'), 'primary'));
  if (r.verify && wf === 'PENDING_VERIFICATION') actions.push(btn('verify', <><CheckCircle2 size={13} className="mr-1 inline" />Verify</>, () => text('verify', `Verify ${b.entry_no}`, 'Remarks (optional)', 'Verify', { field: 'remarks', min: 0 }), 'primary'));
  if (r.approve && wf === 'PENDING_APPROVAL') actions.push(btn('approve', <><ShieldCheck size={13} className="mr-1 inline" />Approve</>, () => text('approve', `Approve ${b.entry_no}`, 'Remarks (optional)', 'Approve', { field: 'remarks', min: 0 }), 'primary'));
  if ((r.verify || r.approve) && (['PENDING_VERIFICATION', 'PENDING_APPROVAL'].includes(wf) || (wf === 'APPROVED' && r.approve && b.posting_status !== 'POSTED')))
    actions.push(btn('return', <><Undo2 size={13} className="mr-1 inline" />Return for correction</>, () => text('return', `Return ${b.entry_no} for correction`, 'What has to be corrected?', 'Return')));
  if ((r.verify || r.approve) && ['OPEN', 'PENDING_VERIFICATION', 'PENDING_APPROVAL'].includes(wf)) actions.push(btn('hold', <><PauseCircle size={13} className="mr-1 inline" />Hold</>, () => text('hold', `Hold ${b.entry_no}`, 'Why on hold?', 'Hold')));
  if ((r.verify || r.approve) && wf === 'ON_HOLD') actions.push(btn('release', 'Release hold', () => text('release', `Release ${b.entry_no}`, 'Why released?', 'Release')));
  if ((r.verify || r.approve) && ['OPEN', 'PENDING_VERIFICATION', 'PENDING_APPROVAL', 'ON_HOLD'].includes(wf)) actions.push(btn('reject', <><XCircle size={13} className="mr-1 inline" />Reject</>, () => text('reject', `Reject ${b.entry_no}`, 'Reason for rejection', 'Reject', { danger: true })));
  if (r.approve && ['REJECTED', 'REVERSED'].includes(wf)) actions.push(btn('reopen', <><RotateCcw size={13} className="mr-1 inline" />Reopen</>, () => text('reopen', `Reopen ${b.entry_no}`, 'Why reopen?', 'Reopen')));
  if (r.approve && b.duplicate_status === 'SUSPECTED') actions.push(btn('cleardup', 'Not a duplicate', () => text('duplicate/clear', `Clear duplicate · ${b.entry_no}`, 'Why is this not a duplicate?', 'Clear duplicate')));
  if (r.post && wf === 'APPROVED' && !postingLive) actions.push(btn('queue', 'Queue for posting', () => act.mutate({ url: `/stores/bill-tracker/${id}/queue-posting` }), 'primary'));
  if (r.post && postingLive && ['QUEUED', 'UNKNOWN', 'FAILED'].includes(postingLive.status) && wf === 'APPROVED') actions.push(btn('posted', <><BookCheck size={13} className="mr-1 inline" />Enter voucher (posted)</>, () => setDlg('posted'), 'primary'));
  if (r.post && postingLive && ['QUEUED', 'UNKNOWN'].includes(postingLive.status)) actions.push(btn('failed', 'Posting failed', () => setDlg('failed')));
  if (r.post && postingLive && ['FAILED', 'UNKNOWN', 'RECON_REQUIRED'].includes(postingLive.status)) actions.push(btn('retry', 'Retry posting', () => text('retry-posting', `Retry posting · ${b.entry_no}`, 'Reason for the retry', 'Retry')));
  if (r.post && postingLive && ['POSTED', 'RECON_REQUIRED'].includes(postingLive.status)) actions.push(btn('reverse', 'Reverse posting', () => setDlg('reverse'), 'danger'));
  if (r.edit && ['OPEN', 'REJECTED', 'ON_HOLD'].includes(wf) && b.status !== 'CANCELLED') actions.push(btn('cancel', 'Cancel bill', () => setDlg({ kind: 'reason', url: 'cancel', title: `Cancel bill ${b.bill_no}`, confirm: 'Cancel bill' }), 'danger'));
  const last = b.movements?.[0];
  return (
    <>
      <PageHeader breadcrumb={['Purchase', 'Bill Tracker', b.entry_no]} title={`${b.entry_no} · ${b.supplier_name ?? b.received_from_dept ?? ''}`}
        subtitle={<>Invoice <b>{b.bill_no}</b>{b.bill_date ? ` dated ${fmtDate(b.bill_date)}` : ''} · ₹{fmtDecimal(b.amount, 2)}{b.currency_code !== 'INR' ? ` (${b.currency_code} @ ${b.exchange_rate})` : ''} · {labelOf(CATEGORY_OPTIONS, b.bill_category)}</>}
        actions={<Button variant="secondary" id="bt-back" onClick={() => navigate(`/stores/bill-tracker${back}`)}><ArrowLeft size={14} className="mr-1 inline" /> Bills</Button>} />
      <div className="card mb-3 grid gap-3 p-4 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-wrap items-center gap-2 text-body">
          <StageChip stage={b.stage} />
          <span className="text-ink-secondary">Workflow</span><StatusBadge value={WORKFLOW_LABEL[wf] ?? wf} />
          <span className="text-ink-secondary">Documents</span><Badge tone={b.completeness_status === 'COMPLETE' ? 'green' : 'amber'}>{b.completeness_status === 'COMPLETE' ? 'Complete' : `Missing: ${b.missing_labels.join(', ')}`}</Badge>
          <span className="text-ink-secondary">Matching</span><MatchChip v={b.match_status} />
          {b.duplicate_status !== 'NONE' && <Badge tone={b.duplicate_status === 'SUSPECTED' ? 'red' : 'slate'}>Duplicate {b.duplicate_status.toLowerCase()}</Badge>}
          <span className="text-ink-secondary">Accounts</span><StatusBadge value={b.posting_status} />
          {b.external_voucher_no && <span>Voucher <b>{b.external_voucher_no}</b> · {fmtDate(b.external_voucher_date)}</span>}
          <span className="w-full text-ink-secondary">Next: <b>{b.next_action}</b></span>
        </div>
        <div id="bt-holder" className="rounded-lg border border-surface-border bg-surface-muted px-3 py-2 text-body">
          <div className="text-caption uppercase tracking-wider text-ink-muted">Current holder</div>
          <div className="font-semibold">{b.holder_name ?? '—'}{b.holder_dept ? ` · ${b.holder_dept}` : ''}{b.holder_location ? ` · ${b.holder_location}` : ''}</div>
          {last && <div className="text-ink-secondary">{last.movement_type.replace('_', ' ').toLowerCase()} {fmtDateTime(last.moved_at)}{last.purpose ? ` — ${last.purpose}` : ''}</div>}
          {b.holder_expected_back && <div className={b.holder_expected_back < today() ? 'font-semibold text-red-600' : 'text-ink-secondary'}>Expected back {fmtDate(b.holder_expected_back)}</div>}
          {last?.ack_status === 'PENDING' && <div className="text-amber-700">Waiting for acknowledgement</div>}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-2">{actions}</div>
      {b.rights.own_entry && wf === 'PENDING_APPROVAL' && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-body text-amber-800">You entered this bill — another user must approve it (maker-checker).</div>}
      <div className="card px-4 pt-2">
        <Tabs tabs={TABS.map((t) => ({ key: t, label: TAB_LABEL[t], count: t === 'docs' ? b.links.filter((l: any) => !l.removed_at).length + b.attachments.filter((a: any) => !a.is_removed).length
          : t === 'followups' ? b.followups.filter((f: any) => f.status === 'OPEN').length : undefined }))} active={tab} onChange={setTab} />
        <div className="pb-4">
          {tab === 'overview' && <Overview b={b} />}
          {tab === 'docs' && <Docs b={b} onLink={() => setDlg('link')} />}
          {tab === 'matching' && <Matching b={b} />}
          {tab === 'movements' && <Movements b={b} />}
          {tab === 'approvals' && <Approvals b={b} />}
          {tab === 'followups' && <Followups b={b} onNew={() => setDlg('followup')} />}
          {tab === 'posting' && <Posting b={b} />}
          {tab === 'audit' && <Audit id={id} />}
        </div>
      </div>

      {dlg === 'edit' && <BillEditor doc={b} onClose={() => setDlg(null)} onSaved={() => setDlg(null)} />}
      {dlg === 'link' && <LinkDialog bill={b} onClose={() => setDlg(null)} />}
      {(dlg === 'handover' || dlg === 'received-back' || dlg === 'submit-accounts' || dlg === 'move') &&
        <StepModal step={dlg} doc={b} busy={act.isPending} onClose={() => setDlg(null)} onSave={(body) => act.mutate({ url: `/stores/bill-tracker/${id}/${dlg === 'move' ? 'movements' : dlg}`, body }, { onSuccess: () => setDlg(null) })} />}
      {dlg === 'followup' && <FollowupModal busy={act.isPending} onClose={() => setDlg(null)} onSave={(body) => act.mutate({ url: `/stores/bill-tracker/${id}/followups`, body }, { onSuccess: () => setDlg(null) })} />}
      {dlg === 'posted' && <PostedModal b={b} busy={act.isPending} onClose={() => setDlg(null)} onSave={(body) => post('mark-posted', body)} />}
      {dlg === 'failed' && <TextModal title={`Posting failed · ${b.entry_no}`} label="Error from the accounts package" confirm="Mark failed" busy={act.isPending} onClose={() => setDlg(null)} onConfirm={(t) => post('mark-failed', { error: t })} />}
      {dlg === 'reverse' && <ReverseModal busy={act.isPending} onClose={() => setDlg(null)} onSave={(body) => post('reverse', body)} />}
      {dlg && typeof dlg === 'object' && dlg.kind === 'text' && <TextModal title={dlg.title} label={dlg.label} confirm={dlg.confirm} danger={dlg.danger} min={dlg.min ?? 3} busy={act.isPending}
        onClose={() => setDlg(null)} onConfirm={(t) => post(dlg.url, { [dlg.field ?? 'reason']: t || null })} />}
      {dlg && typeof dlg === 'object' && dlg.kind === 'reason' && <ReasonModal title={dlg.title} confirm={dlg.confirm} busy={act.isPending} onClose={() => setDlg(null)} onConfirm={(reason) => post(dlg.url, { reason })} />}
    </>
  );
}

function Overview({ b }: { b: any }) {
  return (
    <InfoGrid items={[
      ['Tracking no', b.entry_no], ['Received on', fmtDate(b.entry_date)], ['From', b.received_from === 'VENDOR' ? 'Vendor' : `Department: ${b.received_from_dept}`], ['Supplier', b.supplier_name],
      ['Invoice no', b.bill_no], ['Invoice date', b.bill_date ? fmtDate(b.bill_date) : '—'], ['Category', labelOf(CATEGORY_OPTIONS, b.bill_category)], ['Purchase / process', b.purchase_or_process],
      ['Taxable value', b.taxable_value === null ? '—' : `₹${fmtDecimal(b.taxable_value, 2)}`], ['GST (C / S / I)', `${fmtDecimal(b.cgst_amount, 2)} / ${fmtDecimal(b.sgst_amount, 2)} / ${fmtDecimal(b.igst_amount, 2)}`],
      ['Other / round off', `${fmtDecimal(b.other_charges, 2)} / ${fmtDecimal(b.round_off, 2)}`], ['Bill total', `₹${fmtDecimal(b.amount, 2)}`],
      ['Billed qty', b.bill_qty === null ? '—' : fmtDecimal(b.bill_qty, 3)], ['Currency', `${b.currency_code}${b.currency_code !== 'INR' ? ` @ ${b.exchange_rate}` : ''}`],
      ['Department / cost centre', b.cost_department], ['Payment due', b.payment_due_date ? fmtDate(b.payment_due_date) : '—'], ['Inward document', b.inward_no],
      ['Handed over to', b.handed_over_to ? `${b.handed_over_to} · ${b.handover_department ?? ''}` : '—'], ['Received back', b.received_back_date ? fmtDate(b.received_back_date) : '—'],
      ['To accounts', b.submitted_to_accounts_on ? `${fmtDate(b.submitted_to_accounts_on)} · ${b.accounts_recipient ?? ''}` : '—'],
      ['Entered by', b.prepared_by], ['Verified by', b.verified_by_name ? `${b.verified_by_name} · ${fmtDateTime(b.verified_at)}` : '—'],
      ['Approved by', b.approved_by_name ? `${b.approved_by_name} · ${fmtDateTime(b.approved_at)}` : '—'], ['Remarks', b.remarks],
      ['Duplicate note', b.duplicate_note], ['Hold reason', b.hold_reason], ['Reject reason', b.reject_reason], ['Cancel reason', b.cancel_reason],
    ]} />
  );
}

function Docs({ b, onLink }: { b: any; onLink: () => void }) {
  const act = useAction();
  const [rm, setRm] = useState<{ url: string; title: string } | null>(null);
  const live = ['OPEN', 'PENDING_VERIFICATION'].includes(b.workflow_status) && b.rights.edit;
  const cat = b.category;
  const req = cat ? [['req_dc', 'DC'], ['req_receipt', 'GRN'], ['req_po', 'PO'], ['req_bill_entry', 'Bills Inward entry'], ['req_process', 'Process receipt / rate'], ['req_attachment', 'Scanned copy']]
    .filter(([k]) => Number(cat[k])).map(([, l]) => l) : [];
  return (
    <div className="space-y-4">
      <div className="text-body text-ink-secondary">{cat?.category_name}: needs {req.length ? <b>{req.join(', ')}</b> : <b>no supporting document</b>}.
        {b.missing_labels.length ? <span className="ml-1 text-amber-700">Missing: {b.missing_labels.join(', ')}</span> : <span className="ml-1 text-green-700">All present.</span>}</div>
      {b.suggestions?.length > 0 && <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-body text-blue-800">Bills Inward has {b.suggestions.map((s: any) => `${s.bill_no} (₹${fmtDecimal(s.total_amount, 2)})`).join(', ')} for this invoice no — link it.</div>}
      {b.duplicates?.length > 0 && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-body text-red-800">Same supplier + invoice no: {b.duplicates.map((x: any) => x.entry_no).join(', ')}</div>}
      <div>
        <div className="mb-1 flex items-center justify-between"><div className="text-body font-semibold">Linked documents</div>{live && <Button size="sm" variant="secondary" onClick={onLink}><Plus size={12} className="mr-1 inline" />Link</Button>}</div>
        <table className="w-full text-xs">
          <thead className="bg-surface-muted text-ink-secondary"><tr><th className="px-2 py-1.5 text-left">Type</th><th className="px-2 py-1.5 text-left">No</th><th className="px-2 py-1.5 text-left">Date</th><th className="px-2 py-1.5 text-left">Party</th>
            <th className="px-2 py-1.5 text-right">Doc qty</th><th className="px-2 py-1.5 text-right">Doc value</th><th className="px-2 py-1.5 text-right">Linked qty</th><th className="px-2 py-1.5 text-right">Linked value</th><th className="px-2 py-1.5 text-left">By</th><th /></tr></thead>
          <tbody>
            {b.links.map((l: any) => (
              <tr key={l.id} data-link={l.link_type} className={`border-t border-surface-divider ${l.removed_at ? 'text-ink-muted line-through' : ''}`}>
                <td className="px-2 py-1.5">{l.type_label}{l.needs_override ? <span className="ml-1 text-red-600">(over-billed)</span> : null}</td><td className="px-2 py-1.5 tabular-nums">{l.target_no}</td>
                <td className="px-2 py-1.5">{fmtDate(l.target_date)}</td><td className="px-2 py-1.5">{l.target_party ?? '—'}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{l.target_qty === null ? '—' : fmtDecimal(l.target_qty, 3)}</td><td className="px-2 py-1.5 text-right tabular-nums">{l.target_amount === null ? '—' : fmtDecimal(l.target_amount, 2)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{l.linked_qty === null ? '—' : fmtDecimal(l.linked_qty, 3)}</td><td className="px-2 py-1.5 text-right tabular-nums">{l.linked_amount === null ? '—' : fmtDecimal(l.linked_amount, 2)}</td>
                <td className="px-2 py-1.5">{l.created_by_name}{l.removed_at ? ` · removed: ${l.remove_reason}` : ''}</td>
                <td className="px-2 py-1.5 text-right">{live && !l.removed_at && <button className="text-red-600 hover:underline" onClick={() => setRm({ url: `/stores/bill-tracker/${b.id}/links/${l.id}/remove`, title: `Unlink ${l.target_no}` })}>Unlink</button>}</td>
              </tr>))}
            {!b.links.length && <tr><td colSpan={10} className="px-3 py-6 text-center text-ink-muted">Nothing linked yet</td></tr>}
          </tbody>
          {b.links.some((l: any) => !l.removed_at && l.linked_amount !== null) && <tfoot><tr className="border-t border-surface-border font-semibold"><td colSpan={7} className="px-2 py-1.5 text-right">Total linked value</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{fmtDecimal(b.links.filter((l: any) => !l.removed_at && !['DOC_INWARD', 'GATE_INWARD'].includes(l.link_type)).reduce((s: number, l: any) => s + Number(l.linked_amount ?? 0), 0), 2)}</td><td colSpan={2} /></tr></tfoot>}
        </table>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between"><div className="text-body font-semibold">Files (bill and its inward documents)</div>
          {b.rights.edit && b.workflow_status !== 'CANCELLED' && <FilePick id="bt-file" busy={act.isPending} onPick={(f) => act.mutate({ url: `/stores/bill-tracker/${b.id}/attachments`, body: f })} />}</div>
        <AttachmentList rows={b.attachments} onRemove={b.rights.edit ? (a) => setRm({ url: `/stores/bill-docs/attachments/${a.id}/remove`, title: `Remove ${a.original_name}` }) : undefined} />
      </div>
      {rm && <ReasonModal title={rm.title} confirm="Remove" busy={act.isPending} onClose={() => setRm(null)} onConfirm={(reason) => act.mutate({ url: rm.url, body: { reason } }, { onSuccess: () => setRm(null) })} />}
    </div>
  );
}

function Matching({ b }: { b: any }) {
  const act = useAction();
  const [ov, setOv] = useState<any | null>(null);
  const canOverride = b.rights.approve && !b.rights.own_entry && ['OPEN', 'PENDING_VERIFICATION', 'PENDING_APPROVAL'].includes(b.workflow_status);
  if (!b.matching.length) return <div className="py-6 text-center text-body text-ink-secondary">Matching has not been run{b.match_status === 'NOT_RUN' ? ' since the last change' : ''}. Use <b>Run matching</b>.</div>;
  const tone = (s: string) => (s === 'BLOCKING' ? 'red' : s === 'WARNING' ? 'amber' : s === 'PASS' ? 'green' : 'slate');
  return (
    <>
      <div className="mb-2 text-body text-ink-secondary">Run #{b.match_run} · {fmtDateTime(b.matched_at)} · result <MatchChip v={b.match_status} />{b.match_status === 'NOT_RUN' && ' (out of date — something changed since)'}</div>
      <table className="w-full text-xs">
        <thead className="bg-surface-muted text-ink-secondary"><tr><th className="px-2 py-1.5 text-left">Check</th><th className="px-2 py-1.5 text-left">Severity</th><th className="px-2 py-1.5 text-right">Expected</th>
          <th className="px-2 py-1.5 text-right">Actual</th><th className="px-2 py-1.5 text-right">Variance</th><th className="px-2 py-1.5 text-right">Tolerance</th><th className="px-2 py-1.5 text-left">Resolution</th></tr></thead>
        <tbody>{b.matching.map((m: any) => (
          <tr key={m.id} data-rule={m.rule_code} className="border-t border-surface-divider">
            <td className="px-2 py-1.5">{m.label}</td><td className="px-2 py-1.5"><Badge tone={tone(m.severity) as any}>{m.severity}</Badge></td>
            <td className="px-2 py-1.5 text-right tabular-nums">{m.expected_value ?? ''}</td><td className="px-2 py-1.5 text-right tabular-nums">{m.actual_value ?? ''}</td>
            <td className="px-2 py-1.5 text-right tabular-nums">{m.variance_value ?? ''}</td><td className="px-2 py-1.5 text-right tabular-nums">{m.tolerance ?? ''}</td>
            <td className="px-2 py-1.5">{m.result_status === 'OVERRIDDEN' ? <span className="text-green-700">Overridden by {m.overridden_by_name}: {m.override_reason}</span>
              : m.severity === 'BLOCKING' && canOverride && ['OVERBILLING', 'RECEIPT_AMOUNT', 'RECEIPT_QTY', 'BILL_ENTRY_AMOUNT', 'SUPPLIER', 'PO_AMOUNT', 'PROCESS_AMOUNT'].includes(m.rule_code)
                ? <button className="text-brand-700 hover:underline" onClick={() => setOv(m)}>Override…</button> : ''}</td>
          </tr>))}</tbody>
      </table>
      {ov && <TextModal title="Override a blocking difference" label="Reason (kept in the audit trail)" confirm="Override" busy={act.isPending} onClose={() => setOv(null)}
        onConfirm={(reason) => act.mutate({ url: `/stores/bill-tracker/${b.id}/match-results/${ov.id}/override`, body: { reason } }, { onSuccess: () => setOv(null) })}>
        <div className="mb-2 text-body">{ov.label}: expected {ov.expected_value}, actual {ov.actual_value}</div></TextModal>}
    </>
  );
}

function Movements({ b }: { b: any }) {
  const act = useAction();
  const { user } = useAuth();
  const [fix, setFix] = useState<any | null>(null);
  return (
    <>
      <div className="mb-2 text-small text-ink-secondary">Movements are never edited — a wrong hand-off is reversed by a correction entry.</div>
      <ol className="space-y-2">{b.movements.map((m: any, i: number) => (
        <li key={m.id} data-move={m.movement_type} className="rounded-lg border border-surface-border px-3 py-2 text-body">
          <div className="flex flex-wrap items-center gap-2"><span className="tabular-nums text-ink-muted">#{m.seq}</span><Badge tone={m.movement_type === 'CORRECTION' ? 'red' : 'blue'}>{m.movement_type.replace('_', ' ')}</Badge>
            <span>{m.from_holder ?? '—'}{m.from_dept ? ` (${m.from_dept})` : ''} → <b>{m.to_holder ?? '—'}</b>{m.to_dept ? ` (${m.to_dept})` : ''}{m.to_location ? ` · ${m.to_location}` : ''}</span>
            <span className="text-ink-secondary">{fmtDate(m.business_date)} · recorded {fmtDateTime(m.moved_at)} by {m.recorded_by_name ?? '—'}</span></div>
          <div className="text-ink-secondary">{m.purpose}{m.expected_return_date ? ` · expected back ${fmtDate(m.expected_return_date)}` : ''}{m.note ? ` · ${m.note}` : ''}</div>
          <div className="flex gap-3">
            {m.ack_status !== 'NOT_REQUIRED' && <span className={m.ack_status === 'PENDING' ? 'text-amber-700' : m.ack_status === 'DISPUTED' ? 'text-red-600' : 'text-green-700'}>
              {m.ack_status.toLowerCase()}{m.ack_by_name ? ` by ${m.ack_by_name} ${fmtDateTime(m.ack_at)}` : ''}{m.ack_note ? ` — ${m.ack_note}` : ''}</span>}
            {m.ack_status === 'PENDING' && Number(m.to_user_id) === user?.id && <>
              <button className="text-brand-700 hover:underline" onClick={() => act.mutate({ url: `/stores/bill-tracker/movements/${m.id}/acknowledge`, body: { decision: 'ACKNOWLEDGED' } })}>Acknowledge receipt</button>
              <button className="text-red-600 hover:underline" onClick={() => { const note = window.prompt('What is wrong?'); if (note) act.mutate({ url: `/stores/bill-tracker/movements/${m.id}/acknowledge`, body: { decision: 'DISPUTED', note } }); }}>Dispute</button></>}
            {i === 0 && b.rights.edit && ['HANDOVER', 'RETURN', 'TRANSFER'].includes(m.movement_type) && <button className="text-red-600 hover:underline" onClick={() => setFix(m)}>Correct (reverse) this entry</button>}
          </div>
        </li>))}</ol>
      {fix && <TextModal title={`Correct movement #${fix.seq}`} label="Why was it wrong?" confirm="Add correction" busy={act.isPending} onClose={() => setFix(null)}
        onConfirm={(reason) => act.mutate({ url: `/stores/bill-tracker/${b.id}/movements/${fix.id}/correct`, body: { reason } }, { onSuccess: () => setFix(null) })} />}
    </>
  );
}

function Approvals({ b }: { b: any }) {
  if (!b.approvals.length) return <div className="py-6 text-center text-body text-ink-secondary">No decisions yet</div>;
  return (
    <table className="w-full text-xs">
      <thead className="bg-surface-muted text-ink-secondary"><tr><th className="px-2 py-1.5 text-left">When</th><th className="px-2 py-1.5 text-left">Step</th><th className="px-2 py-1.5 text-left">Decision</th>
        <th className="px-2 py-1.5 text-left">From → to</th><th className="px-2 py-1.5 text-left">By</th><th className="px-2 py-1.5 text-right">Amount</th><th className="px-2 py-1.5 text-left">Comments</th></tr></thead>
      <tbody>{b.approvals.map((a: any) => (
        <tr key={a.id} className="border-t border-surface-divider"><td className="px-2 py-1.5">{fmtDateTime(a.decided_at)}</td><td className="px-2 py-1.5">{a.stage}</td><td className="px-2 py-1.5"><StatusBadge value={a.decision} /></td>
          <td className="px-2 py-1.5">{a.from_status ? `${WORKFLOW_LABEL[a.from_status] ?? a.from_status} → ${WORKFLOW_LABEL[a.to_status] ?? a.to_status}` : '—'}</td><td className="px-2 py-1.5">{a.actor_name}</td>
          <td className="px-2 py-1.5 text-right tabular-nums">{a.amount === null ? '' : fmtDecimal(a.amount, 2)}</td><td className="whitespace-normal px-2 py-1.5">{a.comments}</td></tr>))}</tbody>
    </table>
  );
}

function Followups({ b, onNew }: { b: any; onNew: () => void }) {
  const act = useAction();
  const [close, setClose] = useState<any | null>(null);
  return (
    <>
      {b.rights.edit && <div className="mb-2"><Button size="sm" variant="secondary" id="bt-fu-new" onClick={onNew}><Plus size={12} className="mr-1 inline" />Follow-up</Button></div>}
      <table className="w-full text-xs">
        <thead className="bg-surface-muted text-ink-secondary"><tr><th className="px-2 py-1.5 text-left">Due</th><th className="px-2 py-1.5 text-left">Issue</th><th className="px-2 py-1.5 text-left">Priority</th><th className="px-2 py-1.5 text-left">Owner</th>
          <th className="px-2 py-1.5 text-left">Reason</th><th className="px-2 py-1.5 text-left">Next follow-up</th><th className="px-2 py-1.5 text-left">Status / resolution</th><th /></tr></thead>
        <tbody>{b.followups.map((f: any) => (
          <tr key={f.id} data-fu={f.issue_type} className="border-t border-surface-divider"><td className={`px-2 py-1.5 ${f.status === 'OPEN' && f.due_date < today() ? 'font-semibold text-red-600' : ''}`}>{fmtDate(f.due_date)}</td>
            <td className="px-2 py-1.5">{labelOf(ISSUE_OPTIONS, f.issue_type)}</td><td className="px-2 py-1.5">{f.priority}</td><td className="px-2 py-1.5">{f.owner_name}</td>
            <td className="whitespace-normal px-2 py-1.5">{f.reason}</td><td className="px-2 py-1.5">{fmtDate(f.next_followup_date)}</td>
            <td className="px-2 py-1.5"><StatusBadge value={f.status} /> {f.resolution_note}</td>
            <td className="px-2 py-1.5">{f.status === 'OPEN' && b.rights.edit && <button className="text-brand-700 hover:underline" onClick={() => setClose(f)}>Close</button>}</td></tr>))}
          {!b.followups.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-ink-muted">No follow-ups</td></tr>}</tbody>
      </table>
      {close && <TextModal title="Close follow-up" label="How was it resolved?" confirm="Close" busy={act.isPending} onClose={() => setClose(null)}
        onConfirm={(t) => act.mutate({ url: `/stores/bill-tracker/followups/${close.id}/close`, body: { resolution_note: t } }, { onSuccess: () => setClose(null) })} />}
    </>
  );
}

function Posting({ b }: { b: any }) {
  if (!b.postings.length) return <div className="py-6 text-center text-body text-ink-secondary">Not sent to accounting. An approved bill is queued automatically; the accounts package is not connected yet (MANUAL adapter) — accounts enters the voucher no after posting.</div>;
  return (
    <div className="space-y-3">{b.postings.map((p: any) => (
      <div key={p.id} className="rounded-lg border border-surface-border p-3 text-body">
        <div className="flex flex-wrap items-center gap-3"><StatusBadge value={p.status} /><span className="tabular-nums text-small">{p.idempotency_key}</span><span>Adapter {p.adapter}</span>
          <span>₹{fmtDecimal(p.payload_amount, 2)}</span><span>Attempts {p.attempts}</span>
          {p.external_voucher_no && <span>Voucher <b>{p.external_voucher_no}</b> · {fmtDate(p.external_voucher_date)} · {p.posted_by_name}</span>}
          {p.reversal_voucher_no && <span className="text-red-600">Reversed by voucher {p.reversal_voucher_no}</span>}
          {p.last_error_summary && <span className="text-red-600">{p.last_error_summary}</span>}</div>
        <table className="mt-2 w-full text-xs"><tbody>{p.attempts.map((a: any) => (
          <tr key={a.id} className="border-t border-surface-divider"><td className="py-1">{fmtDateTime(a.at)}</td><td>{a.action}</td><td>{a.outcome}</td><td>{a.voucher_no ?? ''}</td><td>{a.error_summary ?? a.reason ?? ''}</td><td>{a.actor_name}</td></tr>))}</tbody></table>
      </div>))}</div>
  );
}

function Audit({ id }: { id: number }) {
  const d = useQuery({ queryKey: ['stores', 'bt-audit', id], queryFn: async () => (await http.get<{ data: any[] }>(`/stores/bill-tracker/${id}/audit`)).data });
  if (!d.data) return <LoadingBlock />;
  const show = (v: unknown) => { if (!v) return ''; try { const o = typeof v === 'string' ? JSON.parse(v) : v; return Object.entries(o).filter(([, x]) => x !== null && typeof x !== 'object').slice(0, 10).map(([k, x]) => `${k}: ${x}`).join(' · '); } catch { return String(v); } };
  return (
    <table className="w-full text-xs">
      <thead className="bg-surface-muted text-ink-secondary"><tr><th className="px-2 py-1.5 text-left">When</th><th className="px-2 py-1.5 text-left">Who</th><th className="px-2 py-1.5 text-left">What</th><th className="px-2 py-1.5 text-left">Before</th><th className="px-2 py-1.5 text-left">After</th></tr></thead>
      <tbody>{d.data.map((a) => (
        <tr key={a.id} className="border-t border-surface-divider align-top"><td className="whitespace-nowrap px-2 py-1.5">{fmtDateTime(a.changed_at)}</td><td className="px-2 py-1.5">{a.changed_by_name}</td>
          <td className="px-2 py-1.5">{a.table_name.replace(/^trx_bill_|^trx_/, '').replace(/_/g, ' ')} {a.action.toLowerCase()}</td>
          <td className="max-w-[300px] whitespace-normal px-2 py-1.5 text-ink-secondary">{show(a.old_values)}</td><td className="max-w-[420px] whitespace-normal px-2 py-1.5">{show(a.new_values)}</td></tr>))}</tbody>
    </table>
  );
}

// ------------------------------------------------------------------ dialogs
function StepModal({ step, doc, busy, onClose, onSave }: { step: 'handover' | 'received-back' | 'submit-accounts' | 'move'; doc: any; busy: boolean; onClose: () => void; onSave: (b: Record<string, unknown>) => void }) {
  const deptOptions = useDeptOptions();
  const users = useLookup('users');
  const [v, setV] = useState<Record<string, string>>(step === 'handover' ? { handed_over_to: '', handover_department: doc.handover_department ?? '', handover_date: today(), to_user_id: '', purpose: '', expected_return_date: '' }
    : step === 'received-back' ? { received_back_date: today() } : step === 'submit-accounts' ? { submitted_to_accounts_on: today(), accounts_recipient: '', to_user_id: '' }
      : { to_user_id: '', to_holder: '', to_dept: '', to_location: '', purpose: '', business_date: today(), expected_return_date: '', note: '' });
  const title = { handover: 'Hand over to department', 'received-back': 'Received back from department', 'submit-accounts': 'Submit to accounts', move: 'Move the bill' }[step];
  const req = step === 'handover' ? ['handed_over_to', 'handover_department', 'handover_date'] : step === 'received-back' ? ['received_back_date']
    : step === 'submit-accounts' ? ['submitted_to_accounts_on', 'accounts_recipient'] : ['purpose'];
  const ready = req.every((k) => String(v[k] ?? '').trim()) && (step !== 'move' || !!(v.to_user_id || v.to_holder || v.to_dept || v.to_location));
  const pickUser = (id: string, nameKey: string) => { const u = (users.data ?? []).find((x: any) => String(x.id) === id); setV({ ...v, to_user_id: id, ...(u ? { [nameKey]: String(u.label) } : {}) }); };
  const body = () => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : k === 'to_user_id' ? Number(x) : x]));
  return (
    <Modal open onClose={onClose} title={`${title} · ${doc.bill_no}`} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="bill-step-save" disabled={!ready} loading={busy} onClick={() => onSave(body())}>Save</Button>
      </>}>
      <FormSection cols={1}>
        {step === 'handover' && <>
          <Select label="ERP user (optional — they acknowledge it)" value={v.to_user_id} placeholder="—" onChange={(e) => pickUser(e.target.value, 'handed_over_to')} options={toOptions(users.data)} />
          <Input label="Handed over to" required id="step-to" value={v.handed_over_to} onChange={(e) => setV({ ...v, handed_over_to: e.target.value })} />
          <Select label="Department" required id="step-dept" value={v.handover_department} placeholder="Select department…" hint={DEPT_HINT} onChange={(e) => setV({ ...v, handover_department: e.target.value })} options={deptOptions(v.handover_department)} />
          <Input label="Handover date" type="date" required max={today()} value={v.handover_date} onChange={(e) => setV({ ...v, handover_date: e.target.value })} />
          <Input label="Purpose" value={v.purpose} placeholder="e.g. purchase verification" onChange={(e) => setV({ ...v, purpose: e.target.value })} />
          <Input label="Expected back by" type="date" min={today()} value={v.expected_return_date} onChange={(e) => setV({ ...v, expected_return_date: e.target.value })} />
        </>}
        {step === 'received-back' && <Input label="Received back on" type="date" required max={today()} value={v.received_back_date} onChange={(e) => setV({ ...v, received_back_date: e.target.value })} />}
        {step === 'submit-accounts' && <>
          <Input label="Submitted on" type="date" required max={today()} value={v.submitted_to_accounts_on} onChange={(e) => setV({ ...v, submitted_to_accounts_on: e.target.value })} />
          <Select label="ERP user (optional)" value={v.to_user_id} placeholder="—" onChange={(e) => pickUser(e.target.value, 'accounts_recipient')} options={toOptions(users.data)} />
          <Input label="Accounts recipient" required id="step-recipient" value={v.accounts_recipient} onChange={(e) => setV({ ...v, accounts_recipient: e.target.value })} />
          <div className="text-small text-ink-secondary">The bill then waits for accounts' verification.</div>
        </>}
        {step === 'move' && <>
          <Select label="To ERP user" value={v.to_user_id} placeholder="—" onChange={(e) => pickUser(e.target.value, 'to_holder')} options={toOptions(users.data)} />
          <Input label="To person (name)" id="move-to" value={v.to_holder} onChange={(e) => setV({ ...v, to_holder: e.target.value })} />
          <Select label="To department" value={v.to_dept} placeholder="—" hint={DEPT_HINT} onChange={(e) => setV({ ...v, to_dept: e.target.value })} options={deptOptions(v.to_dept)} />
          <Input label="Location / queue" value={v.to_location} placeholder="e.g. Auditor's desk / digital queue" onChange={(e) => setV({ ...v, to_location: e.target.value })} />
          <Input label="Purpose" required id="move-purpose" value={v.purpose} placeholder="Data entry, verification, auditor review…" onChange={(e) => setV({ ...v, purpose: e.target.value })} />
          <Input label="Date" type="date" required max={today()} value={v.business_date} onChange={(e) => setV({ ...v, business_date: e.target.value })} />
          <Input label="Expected back by" type="date" min={today()} value={v.expected_return_date} onChange={(e) => setV({ ...v, expected_return_date: e.target.value })} />
        </>}
      </FormSection>
    </Modal>
  );
}

function FollowupModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (b: unknown) => void }) {
  const users = useLookup('users');
  const [v, setV] = useState({ issue_type: 'SUPPLIER_CLARIFICATION', priority: 'NORMAL', owner_id: '', due_date: today(), reason: '', next_followup_date: '', notes: '' });
  return (
    <Modal open onClose={onClose} title="New follow-up" size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="fu-save" disabled={v.reason.trim().length < 3} loading={busy}
        onClick={() => onSave({ ...v, owner_id: Number(v.owner_id) || null, next_followup_date: v.next_followup_date || null, notes: v.notes || null })}>Save</Button></>}>
      <FormSection cols={2}>
        <Select label="Issue" required value={v.issue_type} onChange={(e) => setV({ ...v, issue_type: e.target.value })} options={ISSUE_OPTIONS} />
        <Select label="Priority" value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })} options={['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) => ({ value: p, label: p.toLowerCase() }))} />
        <Select label="Owner" value={v.owner_id} placeholder="Me" onChange={(e) => setV({ ...v, owner_id: e.target.value })} options={toOptions(users.data)} />
        <Input label="Due date" type="date" required value={v.due_date} onChange={(e) => setV({ ...v, due_date: e.target.value })} />
        <Input label="Next follow-up" type="date" value={v.next_followup_date} onChange={(e) => setV({ ...v, next_followup_date: e.target.value })} />
        <div />
        <Textarea label="Reason" required id="fu-reason" className="sm:col-span-2" rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
        <Textarea label="Notes" className="sm:col-span-2" rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </FormSection>
    </Modal>
  );
}

function PostedModal({ b, busy, onClose, onSave }: { b: any; busy: boolean; onClose: () => void; onSave: (x: unknown) => void }) {
  const [v, setV] = useState({ voucher_no: '', voucher_date: today(), remarks: '' });
  return (
    <Modal open onClose={onClose} title={`Posted in accounts · ${b.entry_no}`} subtitle="Enter the voucher from the accounting package" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="posted-save" disabled={!v.voucher_no.trim()} loading={busy} onClick={() => onSave({ ...v, remarks: v.remarks || null })}>Save</Button></>}>
      <FormSection cols={1}>
        <Input label="Voucher no" required id="posted-voucher" value={v.voucher_no} onChange={(e) => setV({ ...v, voucher_no: e.target.value })} />
        <Input label="Voucher date" type="date" required max={today()} value={v.voucher_date} onChange={(e) => setV({ ...v, voucher_date: e.target.value })} />
        <Input label="Remarks" value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} />
      </FormSection>
    </Modal>
  );
}

function ReverseModal({ busy, onClose, onSave }: { busy: boolean; onClose: () => void; onSave: (x: unknown) => void }) {
  const [v, setV] = useState({ reversal_voucher_no: '', reason: '' });
  return (
    <Modal open onClose={onClose} title="Reverse the posting" subtitle="Post the reversal in the accounts package first, then record it here" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!v.reversal_voucher_no.trim() || v.reason.trim().length < 3} loading={busy} onClick={() => onSave(v)}>Reverse</Button></>}>
      <FormSection cols={1}>
        <Input label="Reversal voucher no" required value={v.reversal_voucher_no} onChange={(e) => setV({ ...v, reversal_voucher_no: e.target.value })} />
        <Textarea label="Reason" required rows={2} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
      </FormSection>
    </Modal>
  );
}
