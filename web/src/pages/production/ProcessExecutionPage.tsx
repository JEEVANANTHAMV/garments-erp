import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Save, X, PackageMinus, PackagePlus, ClipboardCheck, History, Plus, Trash2,
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import {
  PageHeader, Input, Select, Textarea, Modal, EmptyState, Badge, Tabs,
} from '../../components/ui';

/**
 * Process execution — material issue (doc §18), output receipt (doc §19),
 * QC (doc §20) and revisions (doc §22).
 *
 * These steps are identical in shape across yarn processes, knitting programs
 * and collar programs, so one screen serves all three: pick the document, then
 * act on it. That mirrors the shared engine behind the API.
 */

const SRC_TYPES = [
  { value: 'YARN_PROCESS', label: 'Yarn Process (dyeing / winding / twisting)' },
  { value: 'KNITTING_PROGRAM', label: 'Knitting Program' },
  { value: 'COLLAR_PROGRAM', label: 'Collar Program' },
] as const;

type SrcType = (typeof SRC_TYPES)[number]['value'];
type Tab = 'issue' | 'receipt' | 'qc' | 'revisions';

/** Where to list documents of each type, and how to label them. */
const DOC_SOURCE: Record<SrcType, { url: string; no: string; extra?: (r: any) => string }> = {
  YARN_PROCESS: { url: '/yarn-processes?pageSize=200', no: 'process_no',
    extra: (r) => `${r.process_type?.replace(/_/g, ' ')} · ${r.status?.replace(/_/g, ' ')}` },
  KNITTING_PROGRAM: { url: '/knitting/programs?pageSize=200', no: 'program_no',
    extra: (r) => `${r.knitting_type?.replace(/_/g, ' ')} · ${r.status?.replace(/_/g, ' ')}` },
  COLLAR_PROGRAM: { url: '/collar-programs?pageSize=200', no: 'program_no',
    extra: (r) => `${r.status?.replace(/_/g, ' ')}` },
};

/** QC parameter list per process, from the doc §20 matrix. */
const QC_TYPE_FOR: Record<SrcType, string> = {
  YARN_PROCESS: 'YARN_DYEING', KNITTING_PROGRAM: 'KNITTING', COLLAR_PROGRAM: 'COLLAR_KNITTING',
};

export default function ProcessExecutionPage() {
  const qc = useQueryClient();

  const [srcType, setSrcType] = useState<SrcType>('YARN_PROCESS');
  const [srcId, setSrcId] = useState<number | ''>('');
  const [tab, setTab] = useState<Tab>('issue');

  const lk = (name: string) => useQuery({
    queryKey: ['lookups', name],
    queryFn: async () => (await http.get<{ data: any[] }>(`/lookups/${name}`)).data || [],
  });
  const { data: yarns = [] } = lk('yarns');
  const { data: warehouses = [] } = lk('warehouses');

  const { data: docs = [] } = useQuery({
    queryKey: ['exec-docs', srcType],
    queryFn: async () => (await http.get<{ data: any[] }>(DOC_SOURCE[srcType].url)).data || [],
  });

  // Reset the selected document whenever the type changes.
  useEffect(() => { setSrcId(''); }, [srcType]);

  const selected = docs.find((d: any) => d.id === Number(srcId));

  const { data: issues = [] } = useQuery({
    queryKey: ['exec-issues', srcType, srcId],
    queryFn: async () => (await http.get<{ data: any[] }>(
      `/process-issues?src_type=${srcType}&src_id=${srcId}`)).data || [],
    enabled: srcId !== '',
  });
  const { data: receipts = [] } = useQuery({
    queryKey: ['exec-receipts', srcType, srcId],
    queryFn: async () => (await http.get<{ data: any[] }>(
      `/process-receipts?src_type=${srcType}&src_id=${srcId}`)).data || [],
    enabled: srcId !== '',
  });
  const { data: qcRows = [] } = useQuery({
    queryKey: ['exec-qc', srcType, srcId],
    queryFn: async () => (await http.get<{ data: any[] }>(
      `/process-qc?src_type=${srcType}&src_id=${srcId}`)).data || [],
    enabled: srcId !== '',
  });
  const { data: revisions = [] } = useQuery({
    queryKey: ['exec-revisions', srcType, srcId],
    queryFn: async () => (await http.get<{ data: any[] }>(
      `/process-revisions?src_type=${srcType}&src_id=${srcId}`)).data || [],
    enabled: srcId !== '',
  });

  const refreshAll = () => {
    for (const k of ['exec-issues', 'exec-receipts', 'exec-qc', 'exec-revisions', 'exec-docs']) {
      void qc.invalidateQueries({ queryKey: [k] });
    }
  };

  const [modal, setModal] = useState<Tab | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Process Execution"
        subtitle="Issue material, receive output, record QC and raise revisions across every process"
      />

      <div className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
        <Select label="Document Type" value={srcType}
          onChange={(e) => setSrcType(e.target.value as SrcType)} id="ex-srctype">
          {SRC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
        <Select label="Document" value={srcId} placeholder="— Select a document —"
          onChange={(e) => setSrcId(e.target.value ? Number(e.target.value) : '')} id="ex-doc">
          {docs.map((d: any) => (
            <option key={d.id} value={d.id}>
              {d[DOC_SOURCE[srcType].no]} — {DOC_SOURCE[srcType].extra?.(d) ?? ''}
            </option>
          ))}
        </Select>
      </div>

      {srcId === '' ? (
        <EmptyState icon={<ClipboardCheck size={22} />} title="Pick a document"
          message="Choose a process or program above to issue material, receive output or record QC." />
      ) : (
        <>
          <div className="card flex flex-wrap items-center justify-between gap-2 p-3">
            <div className="text-[12px]">
              <span className="font-mono font-semibold text-brand-700">
                {selected?.[DOC_SOURCE[srcType].no]}
              </span>
              <span className="ml-2 text-slate-500">{DOC_SOURCE[srcType].extra?.(selected) ?? ''}</span>
              {Number(selected?.revision_no) > 0 && (
                <Badge tone="amber" className="ml-2">Rev {selected.revision_no}</Badge>
              )}
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => setModal('issue')} id="btn-new-issue">
                <PackageMinus size={14} /> Issue
              </button>
              <button className="btn-secondary" onClick={() => setModal('receipt')} id="btn-new-receipt">
                <PackagePlus size={14} /> Receipt
              </button>
              <button className="btn-secondary" onClick={() => setModal('qc')} id="btn-new-qc">
                <ClipboardCheck size={14} /> QC
              </button>
              <button className="btn-secondary" onClick={() => setModal('revisions')} id="btn-new-revision">
                <History size={14} /> Revise
              </button>
            </div>
          </div>

          <Tabs
            tabs={[
              { key: 'issue', label: `Issues (${issues.length})` },
              { key: 'receipt', label: `Receipts (${receipts.length})` },
              { key: 'qc', label: `QC (${qcRows.length})` },
              { key: 'revisions', label: `Revisions (${revisions.length})` },
            ]}
            active={tab}
            onChange={(k: string) => setTab(k as Tab)}
          />

          <div className="card p-0">
            {tab === 'issue' && (
              <Table head={['Issue No', 'Date', 'Yarn', 'Lot', 'Yarn PO', 'KG', 'Override']}
                rows={issues.map((i: any) => [
                  i.issue_no, fmtDate(i.issue_date),
                  i.yarn_code ? `${i.yarn_code} — ${i.yarn_name}` : '—',
                  i.lot_no ?? '—', i.yarn_po_no ?? '—', fmtDecimal(i.issued_qty_kg, 3),
                  i.is_override
                    ? <Badge tone="amber">Yes</Badge>
                    : <span className="text-slate-400">No</span>,
                ])} empty="No material issued yet" />
            )}
            {tab === 'receipt' && (
              <Table head={['Receipt No', 'Date', 'Input', 'Output', 'Loss', 'Rejected', 'Lot', 'QC', 'Posted']}
                rows={receipts.map((r: any) => [
                  r.receipt_no, fmtDate(r.receipt_date), fmtDecimal(r.input_qty, 3),
                  `${fmtDecimal(r.output_qty, 3)} ${r.output_uom_code ?? ''}`,
                  fmtDecimal(r.loss_qty, 3), fmtDecimal(r.rejected_qty, 3),
                  r.output_lot_no ?? '—',
                  <Badge tone={r.qc_status === 'PASSED' ? 'emerald' : r.qc_status === 'REJECTED' ? 'rose' : 'amber'}>
                    {r.qc_status}
                  </Badge>,
                  r.is_stock_posted ? 'Yes' : 'No',
                ])} empty="No output received yet" />
            )}
            {tab === 'qc' && (
              <div className="divide-y divide-slate-100">
                {qcRows.length === 0 ? (
                  <p className="py-8 text-center text-[12px] text-slate-400">No QC recorded</p>
                ) : qcRows.map((q: any) => (
                  <div key={q.id} className="p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-medium">
                        {fmtDate(q.qc_date)} · {q.checked_by_name ?? '—'}
                      </span>
                      <Badge tone={q.overall_status === 'PASSED' ? 'emerald'
                        : q.overall_status === 'REJECTED' ? 'rose' : 'amber'}>
                        {q.overall_status}
                      </Badge>
                    </div>
                    {(q.lines ?? []).length > 0 && (
                      <Table head={['Parameter', 'Expected', 'Actual', 'Result']}
                        rows={q.lines.map((l: any) => [
                          l.parameter, l.expected_value ?? '—', l.actual_value ?? '—',
                          <Badge tone={l.result === 'PASS' ? 'emerald' : l.result === 'FAIL' ? 'rose' : 'slate'}>
                            {l.result}
                          </Badge>,
                        ])} empty="" />
                    )}
                  </div>
                ))}
              </div>
            )}
            {tab === 'revisions' && (
              <Table head={['Rev', 'Date', 'Reason', 'Status before', 'Status after', 'By']}
                rows={revisions.map((r: any) => [
                  <span className="font-bold text-amber-700">#{r.revision_no}</span>,
                  fmtDate(r.revision_date), r.reason,
                  r.status_before?.replace(/_/g, ' ') ?? '—',
                  r.status_after?.replace(/_/g, ' ') ?? '—',
                  r.revised_by ?? '—',
                ])} empty="No revisions — this document has not been changed after release" />
            )}
          </div>
        </>
      )}

      <IssueModal open={modal === 'issue'} onClose={() => setModal(null)}
        srcType={srcType} srcId={Number(srcId)} yarns={yarns} warehouses={warehouses}
        onSaved={() => { setModal(null); refreshAll(); }} />
      <ReceiptModal open={modal === 'receipt'} onClose={() => setModal(null)}
        srcType={srcType} srcId={Number(srcId)} warehouses={warehouses}
        onSaved={() => { setModal(null); refreshAll(); }} />
      <QcModal open={modal === 'qc'} onClose={() => setModal(null)}
        srcType={srcType} srcId={Number(srcId)} receipts={receipts}
        onSaved={() => { setModal(null); refreshAll(); }} />
      <RevisionModal open={modal === 'revisions'} onClose={() => setModal(null)}
        srcType={srcType} srcId={Number(srcId)}
        onSaved={() => { setModal(null); refreshAll(); }} />
    </div>
  );
}

/* ── Material issue (doc §18) ───────────────────────────────────── */
function IssueModal({ open, onClose, srcType, srcId, yarns, warehouses, onSaved }: any) {
  const toast = useToast();
  const [f, setF] = useState<any>({
    issue_date: today(), yarn_id: '', lot_no: '', yarn_po_no: '',
    warehouse_id: '', issued_qty_kg: '', allow_override: false, override_reason: '', remarks: '',
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!f.yarn_id || !f.warehouse_id || !(Number(f.issued_qty_kg) > 0)) {
      toast('Yarn, warehouse and a quantity above zero are required', 'error'); return;
    }
    setSaving(true);
    try {
      await http.post('/process-issues', {
        src_type: srcType, src_id: srcId, issue_date: f.issue_date,
        yarn_id: Number(f.yarn_id), lot_no: f.lot_no || null, yarn_po_no: f.yarn_po_no || null,
        warehouse_id: Number(f.warehouse_id), issued_qty_kg: Number(f.issued_qty_kg),
        allow_override: f.allow_override, override_reason: f.override_reason || null,
        remarks: f.remarks || null,
      });
      toast('Material issued');
      setF({ issue_date: today(), yarn_id: '', lot_no: '', yarn_po_no: '', warehouse_id: '',
             issued_qty_kg: '', allow_override: false, override_reason: '', remarks: '' });
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not issue material', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Issue Material" size="md"
      footer={<Footer saving={saving} onClose={onClose} onSave={save} label="Issue" id="btn-save-issue" />}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input label="Issue Date" type="date" value={f.issue_date}
            onChange={(e) => setF({ ...f, issue_date: e.target.value })} id="is-date" />
          <Select label="Yarn" required value={f.yarn_id} placeholder="— Select —"
            onChange={(e) => setF({ ...f, yarn_id: e.target.value })} id="is-yarn">
            {yarns.map((y: any) => <option key={y.id} value={y.id}>{y.code} — {y.label}</option>)}
          </Select>
          <Select label="Warehouse" required value={f.warehouse_id} placeholder="— Select —"
            onChange={(e) => setF({ ...f, warehouse_id: e.target.value })} id="is-wh">
            {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input label="Lot No" value={f.lot_no}
            onChange={(e) => setF({ ...f, lot_no: e.target.value })} id="is-lot" />
          <Input label="Yarn PO No" value={f.yarn_po_no}
            onChange={(e) => setF({ ...f, yarn_po_no: e.target.value })} id="is-po" />
          <Input label="Issue Qty (KG)" type="number" step="0.001" value={f.issued_qty_kg}
            onChange={(e) => setF({ ...f, issued_qty_kg: e.target.value })} id="is-qty" />
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <label className="flex items-center gap-2 text-[12px] text-slate-700">
            <input type="checkbox" checked={f.allow_override}
              onChange={(e) => setF({ ...f, allow_override: e.target.checked })} id="is-override" />
            Issue beyond available stock (needs authorisation)
          </label>
          {f.allow_override && (
            <Input label="Override reason" required value={f.override_reason} className="mt-2"
              onChange={(e) => setF({ ...f, override_reason: e.target.value })} id="is-reason" />
          )}
        </div>
        <Textarea label="Remarks" value={f.remarks}
          onChange={(e) => setF({ ...f, remarks: e.target.value })} id="is-remarks" />
      </div>
    </Modal>
  );
}

/* ── Output receipt (doc §19) ───────────────────────────────────── */
function ReceiptModal({ open, onClose, srcType, srcId, warehouses, onSaved }: any) {
  const toast = useToast();
  const [f, setF] = useState<any>({
    receipt_date: today(), input_qty: '', output_qty: '', rejected_qty: '',
    output_lot_no: '', warehouse_id: '', qc_status: 'PENDING', post_stock: false, remarks: '',
  });
  const [saving, setSaving] = useState(false);

  // Loss is derived, never typed — input less output less rejected.
  const loss = Math.max(0, (Number(f.input_qty) || 0) - (Number(f.output_qty) || 0) - (Number(f.rejected_qty) || 0));

  const save = async () => {
    if (!f.warehouse_id) { toast('Select a warehouse', 'error'); return; }
    if (f.post_stock && f.qc_status !== 'PASSED') {
      toast('Stock can only be posted once QC has passed', 'error'); return;
    }
    setSaving(true);
    try {
      await http.post('/process-receipts', {
        src_type: srcType, src_id: srcId, receipt_date: f.receipt_date,
        input_qty: Number(f.input_qty) || 0, output_qty: Number(f.output_qty) || 0,
        rejected_qty: Number(f.rejected_qty) || 0,
        output_lot_no: f.output_lot_no || null, warehouse_id: Number(f.warehouse_id),
        qc_status: f.qc_status, post_stock: f.post_stock, remarks: f.remarks || null,
      });
      toast('Receipt recorded');
      setF({ receipt_date: today(), input_qty: '', output_qty: '', rejected_qty: '',
             output_lot_no: '', warehouse_id: '', qc_status: 'PENDING', post_stock: false, remarks: '' });
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not record the receipt', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record Output Receipt" size="md"
      footer={<Footer saving={saving} onClose={onClose} onSave={save} label="Record" id="btn-save-receipt" />}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input label="Receipt Date" type="date" value={f.receipt_date}
            onChange={(e) => setF({ ...f, receipt_date: e.target.value })} id="rc-date" />
          <Input label="Input Qty" type="number" step="0.001" value={f.input_qty}
            onChange={(e) => setF({ ...f, input_qty: e.target.value })} id="rc-input" />
          <Input label="Output Qty" type="number" step="0.001" value={f.output_qty}
            onChange={(e) => setF({ ...f, output_qty: e.target.value })} id="rc-output" />
          <Input label="Rejected Qty" type="number" step="0.001" value={f.rejected_qty}
            onChange={(e) => setF({ ...f, rejected_qty: e.target.value })} id="rc-rejected" />
          <Input label="Output Lot No" value={f.output_lot_no} placeholder="Auto-generated if blank"
            onChange={(e) => setF({ ...f, output_lot_no: e.target.value })} id="rc-lot" />
          <Select label="Warehouse" required value={f.warehouse_id} placeholder="— Select —"
            onChange={(e) => setF({ ...f, warehouse_id: e.target.value })} id="rc-wh">
            {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </Select>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12px]">
          <span className="font-semibold text-slate-600">Process loss (derived): </span>
          <span className="font-mono font-bold text-slate-900">{fmtDecimal(loss, 3)}</span>
          <span className="ml-2 text-[10px] text-slate-500">input − output − rejected</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="QC Status" value={f.qc_status}
            onChange={(e) => setF({ ...f, qc_status: e.target.value })} id="rc-qc">
            {['PENDING', 'PASSED', 'HOLD', 'REJECTED'].map((q) => <option key={q} value={q}>{q}</option>)}
          </Select>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-[12px] text-slate-700">
              <input type="checkbox" checked={f.post_stock} disabled={f.qc_status !== 'PASSED'}
                onChange={(e) => setF({ ...f, post_stock: e.target.checked })} id="rc-post" />
              Post to stock now
              {f.qc_status !== 'PASSED' && <span className="text-[10px] text-slate-400">(needs QC passed)</span>}
            </label>
          </div>
        </div>
        <Textarea label="Remarks" value={f.remarks}
          onChange={(e) => setF({ ...f, remarks: e.target.value })} id="rc-remarks" />
      </div>
    </Modal>
  );
}

/* ── QC (doc §20) ───────────────────────────────────────────────── */
function QcModal({ open, onClose, srcType, srcId, receipts, onSaved }: any) {
  const toast = useToast();
  const [f, setF] = useState<any>({
    qc_date: today(), receipt_id: '', overall_status: 'PENDING', remarks: '',
  });
  const [lines, setLines] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);

  // Seed the parameter list from the doc §20 matrix for this process.
  const { data: params = [] } = useQuery({
    queryKey: ['qc-params', srcType],
    queryFn: async () => (await http.get<{ data: string[] }>(
      `/process-qc/parameters/${QC_TYPE_FOR[srcType as SrcType]}`)).data || [],
    enabled: open,
  });
  useEffect(() => {
    if (open && params.length && lines.length === 0) {
      setLines(params.map((p: string) => ({ parameter: p, expected_value: '', actual_value: '', result: 'NA' })));
    }
  }, [open, params]);

  const save = async () => {
    setSaving(true);
    try {
      await http.post('/process-qc', {
        src_type: srcType, src_id: srcId, qc_date: f.qc_date,
        receipt_id: f.receipt_id === '' ? null : Number(f.receipt_id),
        process_type: QC_TYPE_FOR[srcType as SrcType],
        overall_status: f.overall_status, remarks: f.remarks || null,
        lines: lines.filter((l) => l.parameter),
      });
      toast('QC recorded');
      setLines([]); setF({ qc_date: today(), receipt_id: '', overall_status: 'PENDING', remarks: '' });
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not record QC', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record QC" size="lg"
      footer={<Footer saving={saving} onClose={onClose} onSave={save} label="Record QC" id="btn-save-qc" />}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input label="QC Date" type="date" value={f.qc_date}
            onChange={(e) => setF({ ...f, qc_date: e.target.value })} id="qc-date" />
          <Select label="Against Receipt" value={f.receipt_id} placeholder="— Whole document —"
            onChange={(e) => setF({ ...f, receipt_id: e.target.value })} id="qc-receipt">
            {receipts.map((r: any) => <option key={r.id} value={r.id}>{r.receipt_no}</option>)}
          </Select>
          <Select label="Overall Result" value={f.overall_status}
            onChange={(e) => setF({ ...f, overall_status: e.target.value })} id="qc-status">
            {['PENDING', 'PASSED', 'HOLD', 'REJECTED'].map((q) => <option key={q} value={q}>{q}</option>)}
          </Select>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              QC Parameters
            </h4>
            <button className="btn-secondary btn-sm"
              onClick={() => setLines([...lines, { parameter: '', expected_value: '', actual_value: '', result: 'NA' }])}>
              <Plus size={13} /> Add
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th text-left">Parameter</th>
                  <th className="th w-32">Expected</th>
                  <th className="th w-32">Actual</th>
                  <th className="th w-28">Result</th>
                  <th className="th w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="td p-1">
                      <input className="input text-[12px]" value={l.parameter}
                        onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, parameter: e.target.value } : x))} />
                    </td>
                    <td className="td p-1">
                      <input className="input text-[12px]" value={l.expected_value}
                        onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, expected_value: e.target.value } : x))} />
                    </td>
                    <td className="td p-1">
                      <input className="input text-[12px]" value={l.actual_value}
                        onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, actual_value: e.target.value } : x))} />
                    </td>
                    <td className="td p-1">
                      <select className="input text-[12px]" value={l.result}
                        onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, result: e.target.value } : x))}>
                        {['NA', 'PASS', 'FAIL'].map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td className="td text-center">
                      <button className="btn-icon text-rose-600"
                        onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <Textarea label="Remarks" value={f.remarks}
          onChange={(e) => setF({ ...f, remarks: e.target.value })} id="qc-remarks" />
      </div>
    </Modal>
  );
}

/* ── Revision (doc §22) ─────────────────────────────────────────── */
function RevisionModal({ open, onClose, srcType, srcId, onSaved }: any) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [reopen, setReopen] = useState('');
  const [changes, setChanges] = useState<{ field: string; value: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const { data: fields = [] } = useQuery({
    queryKey: ['revision-fields', srcType],
    queryFn: async () => (await http.get<{ data: string[] }>(
      `/process-revisions/fields/${srcType}`)).data || [],
    enabled: open,
  });

  const save = async () => {
    if (reason.trim().length < 5) { toast('Give a reason of at least 5 characters', 'error'); return; }
    setSaving(true);
    try {
      const payload: any = { src_type: srcType, src_id: srcId, reason: reason.trim(), changes: {} };
      for (const c of changes) if (c.field) payload.changes[c.field] = c.value;
      if (reopen) payload.reopen_to = reopen;
      await http.post('/process-revisions', payload);
      toast('Revision raised');
      setReason(''); setReopen(''); setChanges([]);
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not raise the revision', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Raise a Revision" size="md"
      footer={<Footer saving={saving} onClose={onClose} onSave={save} label="Raise Revision" id="btn-save-revision" />}>
      <div className="space-y-3">
        <p className="rounded-lg border border-amber-200 bg-amber-50/60 p-2 text-[11px] text-amber-900">
          A released or completed document is historical and is never edited in place.
          A revision snapshots the current state, records why it changed, and bumps the revision number.
        </p>
        <Textarea label="Reason for revision" value={reason} required
          placeholder="e.g. Buyer increased the order quantity after release"
          onChange={(e) => setReason(e.target.value)} id="rev-reason" />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Field changes (optional)
            </h4>
            <button className="btn-secondary btn-sm"
              onClick={() => setChanges([...changes, { field: '', value: '' }])}>
              <Plus size={13} /> Add
            </button>
          </div>
          {changes.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-slate-400">
              No field changes — the revision will only record the reason.
            </p>
          ) : changes.map((c, i) => (
            <div key={i} className="mb-2 flex items-end gap-2">
              <Select label="Field" value={c.field} placeholder="— Select —" className="flex-1"
                onChange={(e) => setChanges(changes.map((x, j) => j === i ? { ...x, field: e.target.value } : x))}>
                {fields.map((f: string) => <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>)}
              </Select>
              <Input label="New value" value={c.value} className="flex-1"
                onChange={(e) => setChanges(changes.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
              <button className="btn-icon mb-2 text-rose-600" onClick={() => setChanges(changes.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        <Select label="Reopen document to" value={reopen} placeholder="— Keep current status —"
          onChange={(e) => setReopen(e.target.value)} id="rev-reopen">
          <option value="RELEASED">RELEASED</option>
          <option value="IN_PROGRESS">IN PROGRESS</option>
        </Select>
      </div>
    </Modal>
  );
}

/* ── shared bits ────────────────────────────────────────────────── */
function Footer({ saving, onClose, onSave, label, id }: any) {
  return (
    <div className="flex justify-end gap-2">
      <button className="btn-secondary" onClick={onClose}><X size={14} /> Cancel</button>
      <button className="btn-primary" disabled={saving} onClick={() => void onSave()} id={id}>
        <Save size={14} /> {saving ? 'Saving…' : label}
      </button>
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) {
    return empty ? <p className="py-8 text-center text-[12px] text-slate-400">{empty}</p> : null;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead className="bg-slate-50">
          <tr>{head.map((h) => <th key={h} className="th text-left">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/60">
              {r.map((c, j) => <td key={j} className="td">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
