import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, FileInput, Link2, FilePlus2, Mail } from 'lucide-react';
import { PageHeader, Modal, FormSection, Input, Select, Textarea, Button, LoadingBlock, StatusBadge, SearchInput, useDebounced, Pager, Checkbox, Badge } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtDecimal } from '../../lib/format';
import { today, useAction, SimpleTable, InfoGrid, ReasonModal, type Col } from './shared';
import { DOC_TYPE_OPTIONS, CHANNEL_OPTIONS, CATEGORY_OPTIONS, labelOf, FilePick, AttachmentList, useDeptOptions, DEPT_HINT, TextModal } from './billShared';

/**
 * Document Inward Register (client spec 24-Oct-2026 §7): every incoming document is registered on its own Inward No. —
 * a bill, a DC that came before the bill, a GRN copy, an emailed invoice — even when the party or the document no is not known yet.
 * Unresolved documents carry an owner and a due date. A DC never creates a GRN or a bill; a bill is registered from here when ready.
 */
const COMPLETENESS = [{ value: 'COMPLETE', label: 'Complete' }, { value: 'INCOMPLETE', label: 'Incomplete details' }, { value: 'AWAITING_LINK', label: 'Awaiting link' },
  { value: 'DUPLICATE_SUSPECTED', label: 'Duplicate suspected' }, { value: 'REJECTED', label: 'Rejected' }];
const tone = (c: string) => (c === 'COMPLETE' ? 'green' : c === 'DUPLICATE_SUSPECTED' || c === 'REJECTED' ? 'red' : 'amber');

export default function DocumentInwardPage() {
  const { canAny } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'page') p.delete('page'); setParams(p, { replace: true }); };
  const [search, setSearch] = useState(get('q'));
  const dq = useDebounced(search);
  useEffect(() => { if (dq !== get('q')) set('q', dq); }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const [intake, setIntake] = useState(false);
  const openId = Number(get('open')) || null;
  const parties = useLookup('parties');
  const qs = new URLSearchParams();
  for (const k of ['from', 'to', 'q', 'doc_type', 'channel', 'completeness', 'party_id', 'page']) if (get(k)) qs.set(k, get(k));
  if (get('awaiting_bill')) qs.set('awaiting_bill', '1');
  if (get('overdue')) qs.set('overdue', '1');
  if (get('mine')) qs.set('mine', '1');
  if (get('unresolved')) qs.set('status', 'ACTIVE');
  if (!get('status') && !get('unresolved')) qs.set('status', 'ACTIVE');
  if (get('status') && get('status') !== 'ALL') qs.set('status', get('status'));
  if (get('status') === 'ALL') qs.delete('status');
  qs.set('page_size', '50');
  const list = useQuery({ queryKey: ['stores', 'doc-inward', qs.toString()], queryFn: async () => http.get<{ data: any[]; pagination: any }>(`/stores/document-inward?${qs}`) });
  const rows = (list.data?.data ?? []).filter((r) => !get('unresolved') || r.completeness !== 'COMPLETE');
  const cols: Col[] = [
    { key: 'inward_no', label: 'Inward no', render: (r) => <span className="tabular-nums font-semibold text-brand-700">{r.inward_no}</span> },
    { key: 'received_at', label: 'Received', render: (r) => `${fmtDate(r.receipt_date)}` }, { key: 'doc_type', label: 'Type', render: (r) => labelOf(DOC_TYPE_OPTIONS, r.doc_type) },
    { key: 'channel', label: 'Channel', render: (r) => labelOf(CHANNEL_OPTIONS, r.channel) }, { key: 'party_name', label: 'Party', render: (r) => r.party_name ?? r.sender_name ?? <span className="text-amber-600">unknown</span> },
    { key: 'doc_no', label: 'Doc no' }, { key: 'doc_date', label: 'Doc date', kind: 'date' }, { key: 'amount', label: 'Amount', kind: 'money' },
    { key: 'completeness', label: 'State', render: (r) => <Badge tone={tone(r.completeness) as any}>{labelOf(COMPLETENESS, r.completeness)}</Badge> },
    { key: 'bills', label: 'Bill(s)' }, { key: 'attachment_count', label: 'Files' },
    { key: 'owner_name', label: 'Owner / due', render: (r) => (r.completeness === 'COMPLETE' ? '—' : <span className={r.overdue ? 'font-semibold text-red-600' : ''}>{r.owner_name ?? '—'} · {fmtDate(r.due_date)}</span>) },
  ];
  const pg = list.data?.pagination;
  return (
    <>
      <PageHeader breadcrumb={['Purchase', 'Document Inward']} title="Document Inward" subtitle="Every bill, DC, GRN copy, email attachment the moment it arrives — on its own inward no"
        actions={<div className="flex gap-2">
          <Button variant="secondary" onClick={() => navigate('/stores/bill-tracker?tab=dashboard')}>Bill tracker</Button>
          {canAny('FINANCE.CREATE', 'FINANCE.UPDATE', 'PURCHASE.CREATE', 'GRN.CREATE') && <Button id="new-inward" onClick={() => setIntake(true)}><Plus size={14} className="mr-1 inline" /> Register document</Button>}
        </div>} />
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-4">
        <Input label="From" type="date" className="w-36" value={get('from')} onChange={(e) => set('from', e.target.value)} />
        <Input label="To" type="date" className="w-36" value={get('to')} onChange={(e) => set('to', e.target.value)} />
        <Select label="Type" id="din-flt-type" className="w-44" value={get('doc_type')} placeholder="All" onChange={(e) => set('doc_type', e.target.value)} options={DOC_TYPE_OPTIONS} />
        <Select label="Channel" className="w-32" value={get('channel')} placeholder="All" onChange={(e) => set('channel', e.target.value)} options={CHANNEL_OPTIONS} />
        <Select label="State" className="w-44" value={get('completeness')} placeholder="All" onChange={(e) => set('completeness', e.target.value)} options={COMPLETENESS} />
        <Select label="Party" className="w-56" value={get('party_id')} placeholder="All" onChange={(e) => set('party_id', e.target.value)} options={toOptions(parties.data)} />
        <Select label="Status" className="w-32" value={get('status') || 'ACTIVE'} onChange={(e) => set('status', e.target.value)} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'REJECTED', label: 'Rejected' }, { value: 'CANCELLED', label: 'Cancelled' }, { value: 'ALL', label: 'All' }]} />
        <Checkbox label="Awaiting bill" checked={!!get('awaiting_bill')} onChange={(v) => set('awaiting_bill', v ? '1' : '')} />
        <Checkbox label="Overdue" checked={!!get('overdue')} onChange={(v) => set('overdue', v ? '1' : '')} />
        <Checkbox label="Mine" checked={!!get('mine')} onChange={(v) => set('mine', v ? '1' : '')} />
        <SearchInput className="min-w-[200px] flex-1" value={search} onChange={setSearch} placeholder="Inward no, doc no, party, sender, subject…" />
      </div>
      <SimpleTable cols={cols} rows={rows} loading={list.isLoading} empty="No documents match" onRow={(r) => set('open', String(r.id))} />
      {pg && pg.totalPages > 1 && <Pager page={pg.page} totalPages={pg.totalPages} total={pg.total} pageSize={pg.pageSize} onPage={(p: number) => set('page', String(p))} />}
      {intake && <IntakeModal onClose={() => setIntake(false)} onSaved={(d) => { setIntake(false); set('open', String(d.id)); }} />}
      {openId && <InwardView id={openId} onClose={() => set('open', '')} />}
    </>
  );
}

function IntakeModal({ doc, onClose, onSaved }: { doc?: any; onClose: () => void; onSaved: (d: any) => void }) {
  const parties = useLookup('parties');
  const users = useLookup('users');
  const deptOptions = useDeptOptions();
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const [v, setV] = useState({
    doc_type: doc?.doc_type ?? 'BILL', channel: doc?.channel ?? 'PHYSICAL', receipt_date: doc?.receipt_date ?? today(), received_dept: doc?.received_dept ?? '', sender_name: s(doc?.sender_name),
    party_id: s(doc?.party_id), doc_no: s(doc?.doc_no), doc_date: s(doc?.doc_date), amount: s(doc?.amount), assigned_to: s(doc?.assigned_to), due_date: s(doc?.due_date), notes: s(doc?.notes), tags: s(doc?.tags),
    mailbox: s(doc?.mailbox), email_from: s(doc?.email_from), email_subject: s(doc?.email_subject), email_message_id: s(doc?.email_message_id),
    email_received_at: doc?.email_received_at ? String(doc.email_received_at).slice(0, 16) : '', email_attachment_ref: s(doc?.email_attachment_ref),
  });
  const [file, setFile] = useState<{ filename: string; data: string } | null>(null);
  const act = useAction();
  const f = (k: string) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const save = () => act.mutate({ url: doc ? `/stores/document-inward/${doc.id}` : '/stores/document-inward', method: doc ? 'put' : 'post',
    body: { ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x])), receipt_date: v.receipt_date, party_id: Number(v.party_id) || null,
      assigned_to: Number(v.assigned_to) || null, amount: v.amount === '' ? null : Number(v.amount), file, row_version: doc?.row_version } }, { onSuccess: (r) => onSaved(r.data) });
  return (
    <Modal open onClose={onClose} title={doc ? `Edit ${doc.inward_no}` : 'Register an incoming document'} subtitle="Save with what you know now — missing details get an owner and a due date" icon={<FileInput size={16} />} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="din-save" loading={act.isPending} onClick={save}>Save</Button></>}>
      <FormSection title="Receipt" cols={3}>
        <Select label="Document type" required id="din-type" value={v.doc_type} onChange={f('doc_type')} options={DOC_TYPE_OPTIONS} />
        <Select label="Received by" required id="din-channel" value={v.channel} onChange={f('channel')} options={CHANNEL_OPTIONS} />
        <Input label="Receipt date" type="date" required max={today()} value={v.receipt_date} onChange={f('receipt_date')} />
        <Select label="Receiving department" value={v.received_dept} placeholder="—" hint={DEPT_HINT} onChange={f('received_dept')} options={deptOptions(v.received_dept)} />
        <Input label="From / sender" value={v.sender_name} placeholder="Courier, driver, contact…" onChange={f('sender_name')} />
      </FormSection>
      {v.channel === 'EMAIL' && (
        <FormSection title={<><Mail size={13} className="mr-1 inline" />Email (entered by hand — no mailbox connection)</> as any} cols={2}>
          <Input label="Sender email" required id="din-email-from" value={v.email_from} onChange={f('email_from')} />
          <Input label="Received at" type="datetime-local" id="din-email-at" value={v.email_received_at} onChange={f('email_received_at')} />
          <Input label="Subject" className="sm:col-span-2" value={v.email_subject} onChange={f('email_subject')} />
          <Input label="Message ID" id="din-email-msgid" value={v.email_message_id} placeholder="<…@mail…>" onChange={f('email_message_id')} />
          <Input label="Mailbox" value={v.mailbox} placeholder="accounts@…" onChange={f('mailbox')} />
        </FormSection>)}
      <FormSection title="Document (fill what is known)" cols={3}>
        <Select label="Party" id="din-party" className="sm:col-span-2" value={v.party_id} placeholder="Not known yet" onChange={f('party_id')} options={toOptions(parties.data)} />
        <Input label="Amount" type="number" min="0" step="any" id="din-amount" value={v.amount} onChange={f('amount')} />
        <Input label="Document no" id="din-docno" value={v.doc_no} onChange={f('doc_no')} />
        <Input label="Document date" type="date" id="din-docdate" max={today()} value={v.doc_date} onChange={f('doc_date')} />
        <Input label="Tags" value={v.tags} onChange={f('tags')} />
      </FormSection>
      <FormSection title="If it is not complete" cols={3}>
        <Select label="Owner" value={v.assigned_to} placeholder="Me" onChange={f('assigned_to')} options={toOptions(users.data)} />
        <Input label="Due date" type="date" value={v.due_date} onChange={f('due_date')} />
        <div />
        <Textarea label="Notes" className="sm:col-span-3" rows={2} value={v.notes} onChange={f('notes')} />
      </FormSection>
      {!doc && <div className="flex items-center gap-3 px-1">
        <FilePick id="din-file" label={file ? 'Change file' : 'Attach scan / file'} onPick={setFile} />
        {file && <span className="text-body">{file.filename}</span>}
      </div>}
    </Modal>
  );
}

function InwardView({ id, onClose }: { id: number; onClose: () => void }) {
  const navigate = useNavigate();
  const { canAny } = useAuth();
  const d = useQuery({ queryKey: ['stores', 'doc-inward', 'doc', id], queryFn: async () => (await http.get<{ data: any }>(`/stores/document-inward/${id}`)).data });
  const act = useAction();
  const [dlg, setDlg] = useState<null | 'edit' | 'bill' | 'linkbill' | 'link' | 'reject' | 'cancel' | 'cleardup' | 'unlink'>(null);
  const [cat, setCat] = useState('PURCHASE');
  const [sel, setSel] = useState<any>(null);
  const doc = d.data;
  const edit = canAny('FINANCE.CREATE', 'FINANCE.UPDATE', 'PURCHASE.CREATE', 'GRN.CREATE');
  const active = doc?.status === 'ACTIVE';
  const billable = doc && ['BILL', 'EMAIL_ATTACHMENT', 'FREIGHT_PROOF', 'OTHER'].includes(doc.doc_type) && !doc.bills;
  return (
    <Modal open onClose={onClose} title={doc ? `${doc.inward_no} · ${labelOf(DOC_TYPE_OPTIONS, doc.doc_type)}` : 'Document'} subtitle={doc ? `${doc.party_name ?? doc.sender_name ?? 'Party not known'}${doc.doc_no ? ` · ${doc.doc_no}` : ''}` : undefined}
      icon={<FileInput size={16} />} size="xl"
      footerStart={doc ? <Badge tone={tone(doc.completeness) as any}>{labelOf(COMPLETENESS, doc.completeness)}</Badge> : null}
      footer={doc && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {edit && active && <Button variant="secondary" id="din-cancel" onClick={() => setDlg('cancel')}>Cancel</Button>}
        {edit && active && <Button variant="secondary" id="din-reject" onClick={() => setDlg('reject')}>Reject</Button>}
        {active && doc.duplicate_note && !Number(doc.duplicate_cleared) && canAny('BILL_TRACKER.VERIFY', 'BILL_TRACKER.APPROVE') && <Button variant="secondary" id="din-cleardup" onClick={() => setDlg('cleardup')}>Not a duplicate</Button>}
        {edit && active && <Button variant="secondary" id="din-edit" onClick={() => setDlg('edit')}>Edit</Button>}
        {edit && active && <Button variant="secondary" id="din-link" onClick={() => setDlg('link')}><Link2 size={13} className="mr-1 inline" />Link</Button>}
        {edit && active && !billable && <Button variant="secondary" id="din-linkbill" onClick={() => setDlg('linkbill')}>Link to a bill</Button>}
        {edit && active && billable && <Button id="din-create-bill" onClick={() => setDlg('bill')}><FilePlus2 size={13} className="mr-1 inline" />Register as bill</Button>}
      </>}>
      {!doc ? <LoadingBlock /> : <>
        {doc.duplicate_note && <div className={`mb-3 rounded-lg px-3 py-2 text-body ${Number(doc.duplicate_cleared) ? 'bg-slate-50 text-slate-600' : 'bg-red-50 text-red-800'}`}>
          {Number(doc.duplicate_cleared) ? 'Duplicate flag cleared: ' : 'Duplicate suspected: '}{doc.duplicate_note}</div>}
        <InfoGrid items={[['Received', `${fmtDate(doc.receipt_date)} (entered ${fmtDateTime(doc.received_at)})`], ['By', `${doc.received_by_name ?? ''}${doc.received_dept ? ` · ${doc.received_dept}` : ''}`],
          ['Channel', labelOf(CHANNEL_OPTIONS, doc.channel)], ['Sender', doc.sender_name], ['Party', doc.party_name], ['Doc no / date', `${doc.doc_no ?? '—'} · ${doc.doc_date ? fmtDate(doc.doc_date) : '—'}`],
          ['Amount', doc.amount === null ? '—' : `₹${fmtDecimal(doc.amount, 2)}`], ['Owner / due', doc.completeness === 'COMPLETE' ? '—' : `${doc.owner_name ?? '—'} · ${fmtDate(doc.due_date)}`],
          ...(doc.channel === 'EMAIL' ? [['Email from', doc.email_from], ['Email received', doc.email_received_at ? fmtDateTime(doc.email_received_at) : '—'], ['Subject', doc.email_subject], ['Message ID', doc.email_message_id]] as [string, any][] : []),
          ['Notes', doc.notes], ['Tags', doc.tags], ['Status', <StatusBadge value={doc.status} />], ['Reason', doc.status_reason]]} />
        <div className="mb-1 text-body font-semibold">Bills</div>
        {doc.bills.length ? <table className="mb-3 w-full text-xs"><tbody>{doc.bills.map((b: any) => (
          <tr key={b.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => navigate(`/stores/bill-tracker/${b.id}`)}>
            <td className="py-1.5 tabular-nums text-brand-700">{b.entry_no}</td><td>{b.party_name}</td><td>{b.bill_no}</td><td className="text-right">₹{fmtDecimal(b.amount, 2)}</td><td><StatusBadge value={b.workflow_status} /></td></tr>))}</tbody></table>
          : <div className="mb-3 text-body text-slate-400">{['DC', 'PROCESS_CHALLAN', 'GRN_COPY'].includes(doc.doc_type) ? 'Bill not received yet (a DC never creates a bill or a GRN)' : 'Not registered as a bill yet'}</div>}
        <div className="mb-1 text-body font-semibold">Linked documents</div>
        <table className="mb-3 w-full text-xs"><tbody>
          {doc.links.map((l: any) => (
            <tr key={l.id} className={`border-t border-slate-100 ${l.removed_at ? 'text-slate-400 line-through' : ''}`}><td className="py-1.5">{l.type_label}</td><td className="tabular-nums">{l.target_no}</td><td>{l.note}</td><td>{l.linked_by_name}</td>
              <td className="text-right">{!l.removed_at && edit && active && <button className="text-red-600 hover:underline" onClick={() => { setSel(l); setDlg('unlink'); }}>Unlink</button>}</td></tr>))}
          {doc.linked_from.map((l: any) => <tr key={`f${l.id}`} className="border-t border-slate-100"><td className="py-1.5">Linked from</td><td className="tabular-nums">{l.source_no}</td><td>{labelOf(DOC_TYPE_OPTIONS, l.source_type)}</td><td /><td /></tr>)}
          {!doc.links.length && !doc.linked_from.length && <tr><td className="py-2 text-slate-400">None</td></tr>}
        </tbody></table>
        <div className="mb-1 flex items-center justify-between"><div className="text-body font-semibold">Files</div>
          {edit && active && <FilePick id="din-view-file" busy={act.isPending} onPick={(f) => act.mutate({ url: `/stores/document-inward/${id}/attachments`, body: f })} />}</div>
        <AttachmentList rows={doc.attachments} onRemove={edit ? (a) => { setSel({ ...a, attachment: true }); setDlg('unlink'); } : undefined} />
        {doc.followups.length > 0 && <><div className="mb-1 mt-3 text-body font-semibold">Follow-ups</div>
          {doc.followups.map((f: any) => <div key={f.id} className="text-body">{fmtDate(f.due_date)} · {f.issue_type} · {f.reason} · <StatusBadge value={f.status} /></div>)}</>}
      </>}
      {dlg === 'edit' && doc && <IntakeModal doc={doc} onClose={() => setDlg(null)} onSaved={() => setDlg(null)} />}
      {dlg === 'bill' && doc && <Modal open onClose={() => setDlg(null)} title={`Register ${doc.inward_no} as a bill`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button id="din-bill-save" loading={act.isPending}
          onClick={() => act.mutate({ url: `/stores/document-inward/${id}/create-bill`, body: { bill_category: cat } }, { onSuccess: (r) => { setDlg(null); navigate(`/stores/bill-tracker/${r.data.id}`); } })}>Register bill</Button></>}>
        <Select label="Bill category" id="din-bill-cat" value={cat} onChange={(e) => setCat(e.target.value)} options={CATEGORY_OPTIONS} />
        <div className="mt-2 text-small text-slate-500">Supplier {doc.party_name ?? '—'}, invoice {doc.doc_no ?? '—'} dated {doc.doc_date ? fmtDate(doc.doc_date) : '—'}, ₹{fmtDecimal(doc.amount ?? 0, 2)}. The duplicate check runs first.</div>
      </Modal>}
      {dlg === 'linkbill' && doc && <LinkBillModal doc={doc} onClose={() => setDlg(null)} />}
      {dlg === 'link' && doc && <DocLinkModal doc={doc} onClose={() => setDlg(null)} />}
      {(dlg === 'reject' || dlg === 'cancel') && <ReasonModal title={`${dlg === 'reject' ? 'Reject' : 'Cancel'} ${doc?.inward_no}`} confirm={dlg === 'reject' ? 'Reject' : 'Cancel document'} busy={act.isPending}
        onClose={() => setDlg(null)} onConfirm={(reason) => act.mutate({ url: `/stores/document-inward/${id}/${dlg}`, body: { reason } }, { onSuccess: () => setDlg(null) })} />}
      {dlg === 'cleardup' && <TextModal title="Not a duplicate" label="Why?" confirm="Clear" busy={act.isPending} onClose={() => setDlg(null)}
        onConfirm={(reason) => act.mutate({ url: `/stores/document-inward/${id}/clear-duplicate`, body: { reason } }, { onSuccess: () => setDlg(null) })} />}
      {dlg === 'unlink' && sel && <ReasonModal title={sel.attachment ? `Remove ${sel.original_name}` : `Unlink ${sel.target_no}`} confirm="Remove" busy={act.isPending} onClose={() => setDlg(null)}
        onConfirm={(reason) => act.mutate({ url: sel.attachment ? `/stores/bill-docs/attachments/${sel.id}/remove` : `/stores/document-inward/${id}/links/${sel.id}/remove`, body: { reason } }, { onSuccess: () => setDlg(null) })} />}
    </Modal>
  );
}

function LinkBillModal({ doc, onClose }: { doc: any; onClose: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useQuery({ queryKey: ['stores', 'din-bills', dq, doc.party_id], queryFn: async () =>
    (await http.get<{ data: any[] }>(`/stores/bill-tracker?page_size=50${doc.party_id ? `&supplier_id=${doc.party_id}` : ''}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`)).data
      .filter((b) => ['OPEN', 'PENDING_VERIFICATION'].includes(b.workflow_status)) });
  const act = useAction();
  return (
    <Modal open onClose={onClose} title={`Link ${doc.inward_no} to a bill`} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <SearchInput className="mb-3" value={q} onChange={setQ} placeholder="Invoice no / tracking no" />
      <SimpleTable rows={list.data ?? []} loading={list.isLoading} empty="No open bills of this party"
        cols={[{ key: 'entry_no', label: 'Tracking no' }, { key: 'supplier_name', label: 'Supplier' }, { key: 'bill_no', label: 'Invoice' }, { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'stage', label: 'Stage' }]}
        onRow={(b) => act.mutate({ url: `/stores/document-inward/${doc.id}/link-bill`, body: { bill_id: b.id } }, { onSuccess: onClose })} />
    </Modal>
  );
}

function DocLinkModal({ doc, onClose }: { doc: any; onClose: () => void }) {
  const TYPES = [{ value: 'GATE_INWARD', label: 'Gate inward (supplier DC)' }, { value: 'PO', label: 'Purchase order' }, { value: 'TRIM_PO', label: 'Trim PO' }, { value: 'GRN', label: 'GRN' },
    { value: 'TRIM_GRN', label: 'Trim GRN' }, { value: 'JOBWORK_CHALLAN', label: 'Process DC' }, { value: 'SUPPLIER_BILL', label: 'Bills Inward entry' }, { value: 'INWARD', label: 'Another inward document' }];
  const [type, setType] = useState('PO');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useQuery({ queryKey: ['stores', 'din-cands', type, dq, doc.party_id], queryFn: async () =>
    (await http.get<{ data: any[] }>(`/stores/bill-tracker/link-candidates?type=${type === 'INWARD' ? 'DOC_INWARD' : type}${doc.party_id ? `&supplier_id=${doc.party_id}` : ''}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`)).data });
  const act = useAction();
  return (
    <Modal open onClose={onClose} title={`Link ${doc.inward_no}`} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="mb-3 flex gap-3"><Select label="Type" id="din-link-type" className="w-56" value={type} onChange={(e) => setType(e.target.value)} options={TYPES} />
        <Input label="Search" className="flex-1" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <SimpleTable rows={(list.data ?? []).filter((r) => !(type === 'INWARD' && r.id === doc.id))} loading={list.isLoading} empty="Nothing found"
        cols={[{ key: 'no', label: 'No' }, { key: 'ref', label: 'Ref' }, { key: 'dt', label: 'Date', kind: 'date' }, { key: 'amount', label: 'Value', kind: 'money' }]}
        onRow={(r) => act.mutate({ url: `/stores/document-inward/${doc.id}/links`, body: { target_type: type, target_id: r.id } }, { onSuccess: onClose })} />
    </Modal>
  );
}

