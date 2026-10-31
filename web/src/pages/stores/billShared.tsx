import { useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Link2, Paperclip, Download, AlertTriangle } from 'lucide-react';
import { Modal, FormSection, Input, Select, Textarea, Button, Checkbox, Badge } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { api, http } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { today, useAction, errMsg } from './shared';

/**
 * Bill tracker + document inward (client spec 24-Oct-2026): shared pieces — labels, status chips, bill editor, link picker,
 * file upload / authenticated download.
 */
export const CATEGORY_OPTIONS = [
  { value: 'PURCHASE', label: 'Purchase' }, { value: 'PROCESS', label: 'Process / job work' }, { value: 'EXPENSE', label: 'Expense' },
  { value: 'FREIGHT', label: 'Freight' }, { value: 'SERVICE', label: 'Service' }, { value: 'OTHER', label: 'Other' },
];
export const WORKFLOW_LABEL: Record<string, string> = {
  OPEN: 'Open', PENDING_VERIFICATION: 'Pending verification', PENDING_APPROVAL: 'Pending approval', APPROVED: 'Approved', ON_HOLD: 'On hold',
  REJECTED: 'Rejected', CANCELLED: 'Cancelled', REVERSED: 'Reversed',
};
export const DOC_TYPE_OPTIONS = [
  { value: 'BILL', label: 'Bill / invoice' }, { value: 'DC', label: 'Delivery challan (DC)' }, { value: 'GRN_COPY', label: 'GRN copy' }, { value: 'PO_COPY', label: 'PO copy' },
  { value: 'PROCESS_CHALLAN', label: 'Process challan' }, { value: 'FREIGHT_PROOF', label: 'Freight proof / LR' }, { value: 'CERTIFICATE', label: 'Certificate' },
  { value: 'EMAIL_ATTACHMENT', label: 'Email attachment' }, { value: 'OTHER', label: 'Other' },
];
export const CHANNEL_OPTIONS = [{ value: 'PHYSICAL', label: 'Physical' }, { value: 'EMAIL', label: 'Email' }, { value: 'SCAN', label: 'Scan' }, { value: 'PORTAL', label: 'Portal' }, { value: 'OTHER', label: 'Other' }];
export const LINK_TYPE_OPTIONS = [
  { value: 'GATE_INWARD', label: 'Supplier DC (gate inward)' }, { value: 'DOC_INWARD', label: 'Inward document (DC / GRN copy…)' }, { value: 'JOBWORK_CHALLAN', label: 'Process DC (job work)' },
  { value: 'GRN', label: 'GRN' }, { value: 'TRIM_GRN', label: 'Trim GRN' }, { value: 'PO', label: 'Purchase order' }, { value: 'TRIM_PO', label: 'Trim PO' },
  { value: 'SUPPLIER_BILL', label: 'Bills Inward entry' }, { value: 'KNITTING_BILL', label: 'Knitting bill' }, { value: 'FABRIC_PROCESS_BILL', label: 'Fabric process bill' },
  { value: 'YARN_PROCESS_BILL', label: 'Yarn process bill' }, { value: 'CONTRACTOR_BILL', label: 'Contractor bill' },
];
export const ISSUE_OPTIONS = ['MISSING_BILL', 'MISSING_DC', 'MISSING_GRN', 'MISMATCH', 'DUPLICATE', 'SUPPLIER_CLARIFICATION', 'APPROVAL_DELAY', 'POSTING_FAILURE', 'DATA_COMPLETION', 'OTHER']
  .map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) }));
export const labelOf = (opts: { value: string; label: string }[], v: unknown) => opts.find((o) => o.value === v)?.label ?? String(v ?? '—');

export function Chip({ children, tone = 'slate' }: { children: ReactNode; tone?: 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'violet' }) {
  return <Badge tone={tone}>{children}</Badge>;
}
export function StageChip({ stage }: { stage: string }) {
  const tone = /Posted|Approved/.test(stage) ? 'green' : /Mismatch|Duplicate|failed|Rejected|Cancelled|Reversed/.test(stage) ? 'red'
    : /Awaiting|pending|hold|entry/i.test(stage) ? 'amber' : /queued|verification|Ready/.test(stage) ? 'blue' : 'slate';
  return <Badge tone={tone as any}>{stage}</Badge>;
}
export function MatchChip({ v }: { v: string }) {
  const tone = v === 'MATCHED' || v === 'RESOLVED' ? 'green' : v === 'BLOCKED' ? 'red' : v === 'WARNING' ? 'amber' : 'slate';
  return <Badge tone={tone as any}>{v === 'NOT_RUN' ? 'Not run' : v.charAt(0) + v.slice(1).toLowerCase()}</Badge>;
}

// ------------------------------------------------------------------ files
export function readFile(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
}
/** Files are private: fetched with the login token, never from a public URL. */
export async function downloadAttachment(id: number, name: string) {
  const r = await api.get(`/stores/bill-docs/attachments/${id}/download`, { responseType: 'blob' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(r.data as Blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
export function FilePick({ id, onPick, busy, label = 'Attach file' }: { id?: string; onPick: (f: { filename: string; data: string }) => void; busy?: boolean; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const toast = useToast();
  return (
    <>
      <input ref={ref} id={id} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.tif,.tiff,.heic,.eml,.msg,.txt,.csv,.xls,.xlsx,.doc,.docx"
        onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          if (f.size > 10 * 1024 * 1024) { toast('File is larger than 10 MB', 'error'); return; }
          onPick({ filename: f.name, data: await readFile(f) });
        }} />
      <Button variant="secondary" loading={busy} onClick={() => ref.current?.click()}><Paperclip size={13} className="mr-1 inline" /> {label}</Button>
    </>
  );
}
export function AttachmentList({ rows, onRemove }: { rows: any[]; onRemove?: (a: any) => void }) {
  const toast = useToast();
  if (!rows.length) return <div className="py-3 text-small text-slate-400">No files attached</div>;
  return (
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1.5 text-left">File</th><th className="px-2 py-1.5 text-left">From</th><th className="px-2 py-1.5 text-right">Size</th>
        <th className="px-2 py-1.5 text-left">Uploaded</th><th className="px-2 py-1.5 text-left">SHA-256</th><th /></tr></thead>
      <tbody>{rows.map((a) => (
        <tr key={a.id} className={`border-t border-slate-100 ${a.is_removed ? 'text-slate-400 line-through' : ''}`}>
          <td className="px-2 py-1.5">{a.original_name}{a.duplicate_of_id ? <span className="ml-1 text-amber-600" title="The same file was uploaded before"><AlertTriangle size={12} className="inline" /> duplicate file</span> : null}</td>
          <td className="px-2 py-1.5">{a.inward_no ?? (a.bill_id ? 'Bill' : '—')}</td>
          <td className="px-2 py-1.5 text-right tabular-nums">{fmtDecimal(Number(a.byte_size) / 1024, 0)} KB</td>
          <td className="px-2 py-1.5">{fmtDate(a.uploaded_at)} · {a.uploaded_by_name ?? ''}</td>
          <td className="px-2 py-1.5 tabular-nums text-caption text-slate-500">{String(a.sha256).slice(0, 12)}…</td>
          <td className="whitespace-nowrap px-2 py-1.5 text-right">
            {!a.is_removed && <button className="mr-2 text-brand-700 hover:underline" onClick={() => downloadAttachment(a.id, a.original_name).catch((e) => toast(errMsg(e), 'error'))}><Download size={12} className="inline" /> Download</button>}
            {!a.is_removed && onRemove && <button className="text-red-600 hover:underline" onClick={() => onRemove(a)}>Remove</button>}
          </td>
        </tr>))}</tbody>
    </table>
  );
}

// ------------------------------------------------------------------ department master options
export function useDeptOptions() {
  const depts = useLookup('departments');
  return (current?: string) => {
    const names = (depts.data ?? []).map((d: any) => String(d.label));
    const cur = String(current ?? '').trim();
    return [
      ...(cur && !names.some((n) => n.toLowerCase() === cur.toLowerCase()) ? [{ value: cur, label: `${cur} (not in master)` }] : []),
      ...names.map((n) => ({ value: n, label: n })),
    ];
  };
}
export const DEPT_HINT = 'Departments come from Masters → Departments';

// ------------------------------------------------------------------ bill editor
export function BillEditor({ doc, onClose, onSaved }: { doc: any | null; onClose: () => void; onSaved: (d: any) => void }) {
  const deptOptions = useDeptOptions();
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const [b, setB] = useState({
    entry_date: doc?.entry_date ?? today(), received_from: doc?.received_from ?? 'VENDOR', received_from_dept: doc?.received_from_dept ?? '', bill_no: doc?.bill_no ?? '',
    bill_date: doc?.bill_date ?? '', supplier_id: s(doc?.supplier_id), purchase_or_process: doc?.purchase_or_process ?? '', amount: doc?.amount ? String(doc.amount) : '',
    remarks: doc?.remarks ?? '', bill_category: doc?.bill_category ?? 'PURCHASE', bill_qty: s(doc?.bill_qty), taxable_value: s(doc?.taxable_value),
    cgst_amount: doc ? s(doc.cgst_amount) : '', sgst_amount: doc ? s(doc.sgst_amount) : '', igst_amount: doc ? s(doc.igst_amount) : '', other_charges: doc ? s(doc.other_charges) : '',
    round_off: doc ? s(doc.round_off) : '', currency_code: doc?.currency_code ?? 'INR', exchange_rate: s(doc?.exchange_rate ?? 1), cost_department: doc?.cost_department ?? '',
    payment_due_date: doc?.payment_due_date ?? '', duplicate_reason: '',
  });
  const [dupMsg, setDupMsg] = useState<string | null>(null);
  const parties = useLookup('payables');
  const dup = useQuery({
    queryKey: ['stores', 'bt-dup', b.supplier_id, b.bill_no, doc?.id], enabled: !!b.supplier_id && b.bill_no.trim().length > 0,
    queryFn: async () => (await http.get<{ data: { duplicates: any[]; bill_entries: any[] } }>(`/stores/bill-tracker/duplicates?supplier_id=${b.supplier_id}&bill_no=${encodeURIComponent(b.bill_no)}${doc?.id ? `&exclude_id=${doc.id}` : ''}`)).data,
  });
  const act = useAction();
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));
  const calc = ['taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'other_charges', 'round_off'].reduce((t, k) => t + (Number((b as any)[k]) || 0), 0);
  const save = () => act.mutate({ url: doc ? `/stores/bill-tracker/${doc.id}` : '/stores/bill-tracker', method: doc ? 'put' : 'post',
    body: { ...b, bill_date: b.bill_date || null, supplier_id: Number(b.supplier_id) || null, amount: Number(b.amount) || 0, received_from_dept: b.received_from_dept || null,
      bill_qty: numOrNull(b.bill_qty), taxable_value: numOrNull(b.taxable_value), exchange_rate: Number(b.exchange_rate) || 1, cost_department: b.cost_department || null,
      payment_due_date: b.payment_due_date || null, duplicate_reason: b.duplicate_reason || null, row_version: doc?.row_version } },
  { onSuccess: (r) => onSaved(r.data), onError: (e: any) => { if (e?.status === 409 && /Duplicate/.test(e?.message)) setDupMsg(e.message); } });
  const set = (k: string) => (e: { target: { value: string } }) => setB({ ...b, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={doc ? `Edit bill ${doc.bill_no}` : 'Bill received'} subtitle="Bill receipt from a vendor or a department" icon={<FileText size={16} />} size="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="bill-save" loading={act.isPending} onClick={save}>Save</Button>
      </>}>
      <FormSection title="Receipt" cols={3}>
        <Input label="Received on" type="date" required value={b.entry_date} max={today()} onChange={set('entry_date')} />
        <Select label="Received from" required value={b.received_from} onChange={set('received_from')} options={[{ value: 'VENDOR', label: 'Vendor' }, { value: 'DEPARTMENT', label: 'Department' }]} />
        {b.received_from === 'DEPARTMENT'
          ? <Select label="Department" required id="bill-from-dept" value={b.received_from_dept} placeholder="Select department…" hint={DEPT_HINT} onChange={set('received_from_dept')} options={deptOptions(b.received_from_dept)} />
          : <div />}
      </FormSection>
      <FormSection title="Bill" cols={3}>
        <Select label="Supplier" required={b.received_from === 'VENDOR'} id="bill-supplier" className="sm:col-span-2" value={b.supplier_id} placeholder="Select…" onChange={set('supplier_id')} options={toOptions(parties.data)} />
        <Select label="Bill category" required id="bill-category" value={b.bill_category} onChange={set('bill_category')} options={CATEGORY_OPTIONS}
          hint="Decides the documents the bill needs (an expense bill needs no GRN)" />
        <Input label="Supplier invoice no" required id="bill-no" value={b.bill_no} onChange={set('bill_no')} />
        <Input label="Invoice date" type="date" id="bill-date" value={b.bill_date} max={today()} onChange={set('bill_date')} />
        <Input label="Purchase / process" value={b.purchase_or_process} placeholder="e.g. Yarn purchase / Dyeing" onChange={set('purchase_or_process')} />
      </FormSection>
      {(dup.data?.duplicates.length ?? 0) > 0 && (
        <div className="mx-1 mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-body text-red-800">
          <b>Possible duplicate{dupMsg ? ' — give the reason to save it anyway' : ''}:</b> the same supplier invoice no is already on {dup.data!.duplicates.map((d) => `${d.entry_no} (${d.bill_no}, ₹${fmtDecimal(d.amount, 2)})`).join(', ')}.
          {<Input label="If this really is a different bill, why?" id="bill-dup-reason" className="mt-2" value={b.duplicate_reason} onChange={set('duplicate_reason')} />}
        </div>)}
      {(dup.data?.bill_entries.length ?? 0) > 0 && (
        <div className="mx-1 mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-body text-blue-800">
          Bills Inward already has {dup.data!.bill_entries.map((e) => `${e.bill_no} (₹${fmtDecimal(e.total_amount, 2)})${e.linked_to ? ` — linked to ${e.linked_to}` : ''}`).join(', ')} for this invoice — link it after saving.
        </div>)}
      <FormSection title="Amount" cols={4}>
        <Input label="Bill total" type="number" min="0" step="any" required id="bill-amount" value={b.amount} onChange={set('amount')} />
        <Input label="Taxable value" type="number" min="0" step="any" id="bill-taxable" value={b.taxable_value} onChange={set('taxable_value')} hint="Optional — when entered, the total is checked" />
        <Input label="CGST" type="number" step="any" value={b.cgst_amount} onChange={set('cgst_amount')} />
        <Input label="SGST" type="number" step="any" value={b.sgst_amount} onChange={set('sgst_amount')} />
        <Input label="IGST" type="number" step="any" value={b.igst_amount} onChange={set('igst_amount')} />
        <Input label="Other charges" type="number" step="any" value={b.other_charges} onChange={set('other_charges')} />
        <Input label="Round off" type="number" step="any" value={b.round_off} onChange={set('round_off')} />
        <Input label="Billed qty" type="number" min="0" step="any" id="bill-qty" value={b.bill_qty} onChange={set('bill_qty')} hint="For quantity matching with the GRN" />
        {b.taxable_value !== '' && Math.abs(calc - (Number(b.amount) || 0)) > 1 &&
          <div className="col-span-full text-small text-red-600">Taxable + GST + other + round off = {fmtDecimal(calc, 2)}, bill total {fmtDecimal(b.amount, 2)}</div>}
        <Select label="Currency" value={b.currency_code} onChange={set('currency_code')} options={['INR', 'USD', 'EUR', 'GBP'].map((c) => ({ value: c, label: c }))} />
        {b.currency_code !== 'INR' && <Input label="Exchange rate" type="number" step="any" required value={b.exchange_rate} onChange={set('exchange_rate')} />}
        <Select label="Department / cost centre" value={b.cost_department} placeholder="—" onChange={set('cost_department')} options={deptOptions(b.cost_department)} />
        <Input label="Payment due" type="date" value={b.payment_due_date} onChange={set('payment_due_date')} />
      </FormSection>
      <FormSection title="Remarks" cols={1}>
        <Input label="Remarks" value={b.remarks} onChange={set('remarks')} />
      </FormSection>
    </Modal>
  );
}

// ------------------------------------------------------------------ link picker
export function LinkDialog({ bill, onClose }: { bill: any; onClose: () => void }) {
  const [type, setType] = useState(bill.missing_docs?.includes('DC') ? 'GATE_INWARD' : bill.bill_category === 'PROCESS' ? 'JOBWORK_CHALLAN' : 'GRN');
  const [q, setQ] = useState('');
  const [anyParty, setAnyParty] = useState(!bill.supplier_id);
  const [sel, setSel] = useState<any | null>(null);
  const [amt, setAmt] = useState(''); const [qty, setQty] = useState(''); const [note, setNote] = useState('');
  const list = useQuery({
    queryKey: ['stores', 'bt-cands', type, anyParty ? 0 : bill.supplier_id, q, bill.id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/stores/bill-tracker/link-candidates?type=${type}${!anyParty && bill.supplier_id ? `&supplier_id=${bill.supplier_id}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}&bill_id=${bill.id}`)).data,
  });
  const act = useAction();
  const save = () => act.mutate({ url: `/stores/bill-tracker/${bill.id}/links`, body: { link_type: type, target_id: sel.id, linked_amount: amt === '' ? null : Number(amt),
    linked_qty: qty === '' ? null : Number(qty), note: note || null, allow_other_party: anyParty } }, { onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={`Link a document · ${bill.entry_no}`} subtitle="DC, GRN, PO, Bills Inward entry or process record — with what is still unbilled" icon={<Link2 size={16} />} size="xl"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="link-save" disabled={!sel} loading={act.isPending} onClick={save}>Link</Button>
      </>}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Select label="Document type" id="link-type" className="w-64" value={type} onChange={(e) => { setType(e.target.value); setSel(null); }} options={LINK_TYPE_OPTIONS} />
        <Input label="Search no" className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
        <Checkbox label="Other parties too" checked={anyParty} onChange={setAnyParty} />
      </div>
      <div className="max-h-[45vh] overflow-auto rounded-lg border border-slate-200">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr>
            <th className="px-2 py-1.5" /><th className="px-2 py-1.5 text-left">No</th><th className="px-2 py-1.5 text-left">Ref</th><th className="px-2 py-1.5 text-left">Date</th>
            <th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5 text-right">Value</th><th className="px-2 py-1.5 text-right">Already billed</th>
            <th className="px-2 py-1.5 text-right">Remaining</th><th className="px-2 py-1.5 text-left">On bills</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.id} data-cand={r.id} onClick={() => { setSel(r); setAmt(r.remaining_amount ?? ''); setQty(r.remaining_qty ?? ''); }}
                className={`cursor-pointer border-t border-slate-100 ${sel?.id === r.id ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
                <td className="px-2 py-1.5"><input type="radio" readOnly checked={sel?.id === r.id} /></td>
                <td className="px-2 py-1.5 tabular-nums">{r.no}</td><td className="px-2 py-1.5">{r.ref ?? '—'}{r.doc_type ? ` · ${labelOf(DOC_TYPE_OPTIONS, r.doc_type)}` : ''}</td>
                <td className="px-2 py-1.5">{fmtDate(r.dt)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.qty === null ? '—' : fmtDecimal(r.qty, 3)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.amount === null ? '—' : fmtDecimal(r.amount, 2)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.billed_amount ? fmtDecimal(r.billed_amount, 2) : '—'}</td>
                <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{r.remaining_amount === null ? '—' : fmtDecimal(r.remaining_amount, 2)}</td>
                <td className="px-2 py-1.5">{r.billed_by ?? ''}</td>
              </tr>))}
            {!list.isLoading && !(list.data ?? []).length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Nothing found{!anyParty ? ' for this supplier' : ''}</td></tr>}
          </tbody>
        </table>
      </div>
      {sel && sel.amount !== null && (
        <FormSection title={`This bill covers (of ${sel.no})`} cols={3} className="mt-3">
          <Input label="Amount" type="number" step="any" id="link-amount" value={amt} onChange={(e) => setAmt(e.target.value)} hint={`Remaining ${fmtDecimal(sel.remaining_amount, 2)}`} />
          {sel.qty !== null && <Input label="Qty" type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} hint={`Remaining ${fmtDecimal(sel.remaining_qty, 3)}`} />}
          <Input label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        </FormSection>)}
    </Modal>
  );
}

/** Asks for a reason or text (generic). */
export function TextModal({ title, label, confirm, onClose, onConfirm, busy, min = 3, danger, children }: {
  title: string; label: string; confirm: string; onClose: () => void; onConfirm: (t: string) => void; busy?: boolean; min?: number; danger?: boolean; children?: ReactNode;
}) {
  const [t, setT] = useState('');
  return (
    <Modal open onClose={onClose} title={title} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Back</Button>
        <Button id="text-confirm" variant={danger ? 'danger' : 'primary'} disabled={t.trim().length < min} loading={busy} onClick={() => onConfirm(t.trim())}>{confirm}</Button>
      </>}>
      {children}
      <Textarea label={label} required={min > 0} rows={3} id="text-input" value={t} onChange={(e) => setT(e.target.value)} />
    </Modal>
  );
}
