import { useState } from 'react';
import { Plus, Trash2, ClipboardCheck, ListPlus, PackageSearch } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader, Tabs, Modal, FormSection, Input, Select, Button, LoadingBlock, StatusBadge, useDebounced } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { fmtDate, fmtDecimal } from '../../lib/format';
import {
  MAT_OPTIONS, num, qtyFmt, today, monthStart, errMsg, useAction, useStoresList, useStoresDoc, FilterBar, SimpleTable, ReportView, ReasonModal, InfoGrid, StockPicker,
  TH, TD, tableHead, type Col, type Mat, type StockRow,
} from './shared';

/**
 * Stock Audit (client tracker 14-Oct-2026): physical count per lot / roll / trim lot / general item → submit → approval
 * posts physical − ERP as stock adjustments. ERP stock is re-read at approval.
 */
interface Line { source_ref: string | null; item_name: string; lot_no?: string | null; grn_no?: string | null; color_name?: string | null; job_no?: string | null; uom_code?: string; uom_id?: number | null;
  system_qty: number; rate: number; physical_qty: string; process_name: string; remarks: string; item_description?: string }

const REPORT_COLS: Col[] = [
  { key: 'type', label: 'Type' }, { key: 'doc_no', label: 'Docid' }, { key: 'doc_date', label: 'Doc Date', kind: 'date' }, { key: 'location', label: 'Location' },
  { key: 'so_no', label: 'Sale Order No' }, { key: 'style', label: 'Style' }, { key: 'grn_no', label: 'Grn No' }, { key: 'process_name', label: 'Process Name' },
  { key: 'item_name', label: 'Item' }, { key: 'color_name', label: 'Color' }, { key: 'system_qty', label: 'Stock As Per Erp', kind: 'qty' }, { key: 'physical_qty', label: 'Physical Stock', kind: 'qty' },
  { key: 'diff_qty', label: 'Stock Audit Qty', kind: 'qty' }, { key: 'rate', label: 'Rate', kind: 'money' }, { key: 'amount', label: 'Amount', kind: 'money' },
  { key: 'remarks', label: 'Remarks' }, { key: 'prepared_by', label: 'Prepby' }, { key: 'status', label: 'Status', kind: 'status' },
];

const fromStock = (r: StockRow): Line => ({ source_ref: r.source_ref, item_name: r.item_name, lot_no: r.lot_no, grn_no: r.grn_no, color_name: r.color_name, job_no: r.job_no,
  uom_code: r.uom_code, uom_id: r.uom_id, system_qty: num(r.stock_qty), rate: num(r.rate), physical_qty: '', process_name: '', remarks: '' });

export default function StockAuditPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('LIST');
  const [f, setF] = useState({ from: monthStart(), to: today(), q: '', status: '' });
  const q = useDebounced(f.q);
  const list = useStoresList('stock-audit', { from: f.from, to: f.to, q, status: f.status });
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<number | null>(null);
  const cols: Col[] = [
    { key: 'doc_no', label: 'Doc no', render: (r) => <span className="font-mono font-semibold text-brand-700">{r.doc_no}</span> },
    { key: 'doc_date', label: 'Date', kind: 'date' }, { key: 'audit_type', label: 'Type' }, { key: 'warehouse_name', label: 'Location' },
    { key: 'line_count', label: 'Items counted' }, { key: 'diff_lines', label: 'With difference' }, { key: 'diff_amount', label: 'Difference value', kind: 'money' },
    { key: 'prepared_by', label: 'Prepared by' }, { key: 'status', label: 'Status', kind: 'status' },
  ];
  return (
    <>
      <PageHeader breadcrumb={['Gate & Stores', 'Stock Audit']} title="Stock Audit" subtitle="Physical stock vs ERP stock per lot / roll / item; approval posts the difference"
        actions={can('INVENTORY.CREATE') || can('INVENTORY.ADJUST') ? <Button id="new-audit" onClick={() => setEdit({})}><Plus size={14} className="mr-1 inline" /> New stock audit</Button> : null} />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'LIST', label: 'Register' }, { key: 'REPORT', label: 'Stock audit report' }]} active={tab} onChange={setTab} /></div>
      {tab === 'LIST' ? (
        <>
          <FilterBar f={f} setF={setF} statuses={['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED']} />
          <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} onRow={(r) => setView(r.id)} />
        </>
      ) : <ReportView path="stock-audit" title="Stock audit register" cols={REPORT_COLS} />}
      {edit && <AuditEditor doc={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={(d) => { setEdit(null); setView(d.id); }} />}
      {view && <AuditView id={view} onClose={() => setView(null)} onEdit={(d) => { setView(null); setEdit(d); }} />}
    </>
  );
}

function AuditEditor({ doc, onClose, onSaved }: { doc: any | null; onClose: () => void; onSaved: (d: any) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [h, setH] = useState({ doc_date: doc?.doc_date ?? today(), audit_type: (doc?.audit_type ?? 'YARN') as Mat, warehouse_id: doc?.warehouse_id ? String(doc.warehouse_id) : '', remarks: doc?.remarks ?? '' });
  const [lines, setLines] = useState<Line[]>(doc?.lines?.map((l: any) => ({ source_ref: l.source_ref, item_name: l.item_name, lot_no: l.lot_no, grn_no: l.grn_no, color_name: l.color_name, job_no: l.so_no,
    uom_code: l.uom_code, uom_id: l.uom_id, system_qty: num(l.system_qty), rate: num(l.rate), physical_qty: String(l.physical_qty ?? ''), process_name: l.process_name ?? '', remarks: l.remarks ?? '',
    item_description: l.item_description })) ?? []);
  const [picker, setPicker] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const whs = useLookup('warehouses'); const uoms = useLookup('uoms');
  const act = useAction();
  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const add = (rows: StockRow[]) => setLines((ls) => [...ls, ...rows.filter((r) => !ls.some((l) => l.source_ref === r.source_ref)).map(fromStock)]);
  const loadAll = async () => {
    if (!h.warehouse_id) return toast('Select the location first', 'error');
    setLoadingAll(true);
    try { add((await qc.fetchQuery({ queryKey: ['stores', 'stock-items', h.audit_type, h.warehouse_id, 'all'], queryFn: async () => (await http.get<{ data: StockRow[] }>(`/stores/stock-items?material_type=${h.audit_type}&warehouse_id=${h.warehouse_id}`)).data }))); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setLoadingAll(false); }
  };
  const diff = (l: Line) => (l.physical_qty === '' ? 0 : num(l.physical_qty) - l.system_qty);
  const counted = lines.filter((l) => l.physical_qty !== '');
  const diffVal = counted.reduce((a, l) => a + diff(l) * l.rate, 0);
  const save = (submit: boolean) => {
    if (lines.some((l) => l.physical_qty === '')) return toast('Enter the physical qty of every line (0 if nothing was found) or remove it', 'error');
    act.mutate({ url: doc ? `/stores/stock-audit/${doc.id}` : '/stores/stock-audit', method: doc ? 'put' : 'post',
      body: { ...h, warehouse_id: Number(h.warehouse_id) || null, submit, lines: lines.map((l) => ({ source_ref: l.source_ref, item_description: l.item_description ?? (l.source_ref ? null : l.item_name),
        uom_id: l.uom_id ?? null, physical_qty: num(l.physical_qty), process_name: l.process_name, remarks: l.remarks })) } }, { onSuccess: (r) => onSaved(r.data) });
  };
  return (
    <Modal open onClose={onClose} title={doc ? `Edit stock audit ${doc.doc_no}` : 'New stock audit'} subtitle="Load the location's stock as a count sheet, enter what is physically there, then submit for approval"
      icon={<ClipboardCheck size={16} />} size="full"
      footerStart={<>{lines.length} line{lines.length === 1 ? '' : 's'} · {counted.filter((l) => Math.abs(diff(l)) > 0.0005).length} with difference · value ₹{fmtDecimal(diffVal, 2)}</>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" id="audit-save-draft" disabled={!lines.length} loading={act.isPending} onClick={() => save(false)}>Save draft</Button>
        <Button id="audit-submit" disabled={!lines.length} loading={act.isPending} onClick={() => save(true)}>Submit for approval</Button>
      </>}>
      <FormSection title="Document" cols={4}>
        <Input label="Date" type="date" required value={h.doc_date} onChange={(e) => setH({ ...h, doc_date: e.target.value })} />
        <Select label="Type" required id="audit-type" value={h.audit_type} disabled={lines.length > 0} hint={lines.length ? 'Remove the lines to change' : undefined}
          onChange={(e) => setH({ ...h, audit_type: e.target.value as Mat })} options={MAT_OPTIONS} />
        <Select label="Location" required id="audit-wh" value={h.warehouse_id} disabled={lines.length > 0} placeholder="Select…" onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} options={toOptions(whs.data)} />
        <Input label="Remarks" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
      </FormSection>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2 border-b border-slate-100 pb-1.5">
        <h3 className={tableHead}>Count sheet</h3>
        <div className="flex gap-2">
          {h.audit_type === 'GENERAL' && <Button size="sm" variant="secondary" onClick={() => setLines((ls) => [...ls, { source_ref: null, item_name: '', item_description: '', uom_id: null, system_qty: 0, rate: 0, physical_qty: '', process_name: '', remarks: '' }])}>
            <Plus size={13} className="mr-1 inline" /> Item not in system</Button>}
          <Button size="sm" variant="secondary" id="audit-load-all" disabled={!h.warehouse_id} loading={loadingAll} onClick={loadAll}><ListPlus size={13} className="mr-1 inline" /> Load all stock</Button>
          <Button size="sm" id="audit-pick" disabled={!h.warehouse_id} onClick={() => setPicker(true)}><PackageSearch size={13} className="mr-1 inline" /> Pick items</Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>
            {['Item', 'Lot / roll', 'GRN', 'Colour', 'Job', 'UOM', 'ERP stock', 'Physical', 'Difference', 'Rate', 'Value', 'Process', 'Remarks', ''].map((t) => <th key={t} className={`${TH} ${/stock|Physical|Difference|Rate|Value/.test(t) ? 'text-right' : 'text-left'}`}>{t}</th>)}
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const d = diff(l);
              return (
                <tr key={l.source_ref ?? `new${i}`} className="border-t border-slate-100 audit-line">
                  <td className={`${TD} font-medium`}>{l.source_ref ? l.item_name : <input className="input w-48" placeholder="Item name" value={l.item_description ?? ''} onChange={(e) => set(i, { item_description: e.target.value, item_name: e.target.value })} />}</td>
                  <td className={TD}>{l.lot_no || '—'}</td><td className={TD}>{l.grn_no || '—'}</td><td className={TD}>{l.color_name || '—'}</td><td className={TD}>{l.job_no || '—'}</td>
                  <td className={TD}>{l.source_ref ? l.uom_code : <select className="input w-20" value={l.uom_id ?? ''} onChange={(e) => set(i, { uom_id: Number(e.target.value) || null })}><option value="">—</option>{(uoms.data ?? []).map((u) => <option key={u.id} value={u.id}>{String(u.code)}</option>)}</select>}</td>
                  <td className={`${TD} text-right tabular-nums`}>{qtyFmt(l.system_qty)}</td>
                  <td className={TD}><input className="input w-24 text-right audit-physical" type="number" min="0" step="any" value={l.physical_qty} onChange={(e) => set(i, { physical_qty: e.target.value })} /></td>
                  <td className={`${TD} text-right tabular-nums font-semibold ${d < 0 ? 'text-red-700' : d > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>{l.physical_qty === '' ? '—' : qtyFmt(d)}</td>
                  <td className={`${TD} text-right tabular-nums`}>{fmtDecimal(l.rate, 2)}</td>
                  <td className={`${TD} text-right tabular-nums`}>{l.physical_qty === '' ? '—' : fmtDecimal(d * l.rate, 2)}</td>
                  <td className={TD}><input className="input w-24" value={l.process_name} onChange={(e) => set(i, { process_name: e.target.value })} /></td>
                  <td className={TD}><input className="input w-32" value={l.remarks} onChange={(e) => set(i, { remarks: e.target.value })} /></td>
                  <td className={TD}><button className="rounded p-1 text-slate-400 hover:text-red-600" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
                </tr>
              );
            })}
            {!lines.length && <tr><td colSpan={14} className="px-3 py-8 text-center text-slate-400">Choose type and location, then Load all stock or Pick items</td></tr>}
          </tbody>
        </table>
      </div>
      {picker && <StockPicker material={h.audit_type} warehouseId={Number(h.warehouse_id)} exclude={lines.map((l) => l.source_ref ?? '')} onClose={() => setPicker(false)} onPick={(rows) => { add(rows); setPicker(false); }} />}
    </Modal>
  );
}

function AuditView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (d: any) => void }) {
  const { can } = useAuth();
  const d = useStoresDoc('stock-audit', id);
  const act = useAction();
  const [reason, setReason] = useState<'cancel' | 'reject' | null>(null);
  const doc = d.data;
  const open = doc && ['DRAFT', 'SUBMITTED', 'REJECTED'].includes(doc.status);
  return (
    <Modal open onClose={onClose} title={doc ? `Stock audit ${doc.doc_no}` : 'Stock audit'}
      subtitle={doc?.status === 'SUBMITTED' ? 'Approval re-reads ERP stock and posts physical − ERP for every line' : doc?.status === 'REJECTED' ? `Sent back: ${doc.cancel_reason ?? ''}` : undefined}
      icon={<ClipboardCheck size={16} />} size="xl"
      footerStart={doc ? <StatusBadge value={doc.status} /> : null}
      footer={doc && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {open && <Button variant="secondary" id="audit-cancel" onClick={() => setReason('cancel')}>Cancel audit</Button>}
        {['DRAFT', 'REJECTED'].includes(doc.status) && <Button variant="secondary" id="audit-edit" onClick={() => onEdit(doc)}>Edit</Button>}
        {['DRAFT', 'REJECTED'].includes(doc.status) && <Button id="audit-submit-view" loading={act.isPending} onClick={() => act.mutate({ url: `/stores/stock-audit/${id}/submit` })}>Submit for approval</Button>}
        {doc.status === 'SUBMITTED' && can('INVENTORY.ADJUST') && <Button variant="secondary" id="audit-reject" onClick={() => setReason('reject')}>Send back</Button>}
        {doc.status === 'SUBMITTED' && can('INVENTORY.ADJUST') && <Button id="audit-approve" loading={act.isPending} onClick={() => act.mutate({ url: `/stores/stock-audit/${id}/approve` })}>Approve &amp; post differences</Button>}
      </>}>
      {!doc ? <LoadingBlock /> : (
        <>
          <InfoGrid items={[['Date', fmtDate(doc.doc_date)], ['Type', doc.audit_type], ['Location', doc.warehouse_name], ['Prepared by', doc.prepared_by],
            ['Submitted', doc.submitted_at ? `${fmtDate(doc.submitted_at)} · ${doc.submitted_by_name ?? ''}` : '—'], ['Approved', doc.approved_at ? `${fmtDate(doc.approved_at)} · ${doc.approved_by_name ?? ''}` : '—'],
            ['Remarks', doc.remarks], ['Cancel / send-back reason', doc.cancel_reason]]} />
          <SimpleTable rows={doc.lines} cols={[
            { key: 'item_name', label: 'Item' }, { key: 'lot_no', label: 'Lot / roll' }, { key: 'grn_no', label: 'GRN' }, { key: 'color_name', label: 'Colour' }, { key: 'so_no', label: 'Job' },
            { key: 'uom_code', label: 'UOM' }, { key: 'system_qty', label: 'ERP stock', kind: 'qty' }, { key: 'physical_qty', label: 'Physical', kind: 'qty' },
            { key: 'diff_qty', label: 'Difference', kind: 'qty' }, { key: 'rate', label: 'Rate', kind: 'money' }, { key: 'amount', label: 'Value', kind: 'money' }, { key: 'remarks', label: 'Remarks' },
          ]} />
        </>
      )}
      {reason && <ReasonModal title={reason === 'cancel' ? `Cancel ${doc?.doc_no}` : `Send ${doc?.doc_no} back for recount`} confirm={reason === 'cancel' ? 'Cancel audit' : 'Send back'} busy={act.isPending}
        onClose={() => setReason(null)} onConfirm={(r) => act.mutate({ url: `/stores/stock-audit/${id}/${reason}`, body: { reason: r } }, { onSuccess: () => setReason(null) })} />}
    </Modal>
  );
}
