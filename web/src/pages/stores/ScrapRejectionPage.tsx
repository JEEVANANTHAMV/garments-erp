import { useState } from 'react';
import { Plus, Trash2, Recycle, PackageSearch } from 'lucide-react';
import { PageHeader, Tabs, Modal, FormSection, Input, Select, Button, LoadingBlock, StatusBadge, useDebounced } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { num, qtyFmt, today, monthStart, useAction, useStoresList, useStoresDoc, FilterBar, SimpleTable, ReportView, ReasonModal, InfoGrid, StockPicker, TH, TD, tableHead, type Col, type StockRow } from './shared';

/**
 * Scrap / Rejection entry at any stage (client tracker rows 88 / 89 / 91). Stock items leave the location; a rejection
 * moves them into the rejection godown. Garment / WIP pieces at a production stage are recorded.
 */
const STAGES = ['Stores', 'Yarn process', 'Knitting', 'Dyeing / processing', 'Cutting', 'Printing / embroidery', 'Sewing', 'Checking', 'Ironing / finishing', 'Packing', 'Other'];
interface Line { source_ref: string | null; material_type: string; item_name: string; item_description: string; lot_no?: string | null; color_name: string; sizes: string;
  uom_id: number | null; uom_code?: string; stock_qty: number; qty: string; rate: string; reason: string }

const REPORT_COLS: Col[] = [
  { key: 'entry_kind', label: 'Type' }, { key: 'doc_no', label: 'Doc no' }, { key: 'doc_date', label: 'Date', kind: 'date' }, { key: 'stage', label: 'Stage' },
  { key: 'process_name', label: 'Process' }, { key: 'location', label: 'Location' }, { key: 'rejection_godown', label: 'Rejection godown' }, { key: 'so_no', label: 'Sale order' },
  { key: 'style_code', label: 'Style' }, { key: 'item_name', label: 'Item' }, { key: 'color_name', label: 'Colour' }, { key: 'sizes', label: 'Sizes' }, { key: 'uom', label: 'UOM' },
  { key: 'qty', label: 'Qty', kind: 'qty' }, { key: 'rate', label: 'Rate', kind: 'money' }, { key: 'amount', label: 'Amount', kind: 'money' }, { key: 'reason', label: 'Reason' }, { key: 'prepared_by', label: 'Prepby' },
];

export default function ScrapRejectionPage() {
  const { can, canAny } = useAuth();
  const [tab, setTab] = useState('LIST');
  const [kind, setKind] = useState('');
  const [f, setF] = useState({ from: monthStart(), to: today(), q: '', status: '' });
  const q = useDebounced(f.q);
  const list = useStoresList('scrap-rejections', { from: f.from, to: f.to, q, status: f.status, kind });
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<number | null>(null);
  const kindSel = <Select label="Type" className="w-40" value={kind} placeholder="All" onChange={(e) => setKind(e.target.value)} options={[{ value: 'SCRAP', label: 'Scrap' }, { value: 'REJECTION', label: 'Rejection' }]} />;
  const cols: Col[] = [
    { key: 'doc_no', label: 'Doc no', render: (r) => <span className="tabular-nums font-semibold text-brand-700">{r.doc_no}</span> }, { key: 'doc_date', label: 'Date', kind: 'date' },
    { key: 'entry_kind', label: 'Type' }, { key: 'stage', label: 'Stage' }, { key: 'warehouse_name', label: 'From' }, { key: 'rejection_warehouse_name', label: 'To (rejection)' },
    { key: 'so_no', label: 'Job' }, { key: 'total_qty', label: 'Qty', kind: 'qty' }, { key: 'total_amount', label: 'Value', kind: 'money' }, { key: 'status', label: 'Status', kind: 'status' },
  ];
  return (
    <>
      <PageHeader breadcrumb={['Gate & Stores', 'Scrap & Rejection']} title="Scrap & Rejection" subtitle="Scrap or reject goods at any stage; rejected stock moves to the rejection godown"
        actions={canAny('INVENTORY.CREATE', 'QC.CREATE', 'PRODUCTION.CREATE', 'INVENTORY.ADJUST') ? <>
          <Button variant="secondary" id="new-rejection" onClick={() => setEdit({ entry_kind: 'REJECTION' })}><Plus size={14} className="mr-1 inline" /> Rejection</Button>
          <Button id="new-scrap" onClick={() => setEdit({ entry_kind: 'SCRAP' })}><Plus size={14} className="mr-1 inline" /> Scrap</Button>
        </> : null} />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'LIST', label: 'Register' }, { key: 'REPORT', label: 'Scrap / rejection report' }]} active={tab} onChange={setTab} /></div>
      {tab === 'LIST' ? (
        <>
          <FilterBar f={f} setF={setF} statuses={['DRAFT', 'POSTED', 'CANCELLED']}>{kindSel}</FilterBar>
          <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} onRow={(r) => setView(r.id)} />
        </>
      ) : <ReportView path="scrap-rejections" title="Scrap and rejection entries" cols={REPORT_COLS} extra={kindSel} extraParams={{ kind }} />}
      {edit && <EntryEditor doc={edit.id ? edit : null} kind={edit.entry_kind} canPost={can('INVENTORY.ADJUST')} onClose={() => setEdit(null)} onSaved={(d) => { setEdit(null); setView(d.id); }} />}
      {view && <EntryView id={view} onClose={() => setView(null)} onEdit={(d) => { setView(null); setEdit(d); }} />}
    </>
  );
}

function EntryEditor({ doc, kind, canPost, onClose, onSaved }: { doc: any | null; kind: 'SCRAP' | 'REJECTION'; canPost: boolean; onClose: () => void; onSaved: (d: any) => void }) {
  const toast = useToast();
  const [h, setH] = useState({ doc_date: doc?.doc_date ?? today(), stage: doc?.stage ?? 'Stores', warehouse_id: doc?.warehouse_id ? String(doc.warehouse_id) : '',
    rejection_warehouse_id: doc?.rejection_warehouse_id ? String(doc.rejection_warehouse_id) : '', so_id: doc?.so_id ? String(doc.so_id) : '', process_name: doc?.process_name ?? '', remarks: doc?.remarks ?? '' });
  const [lines, setLines] = useState<Line[]>(doc?.lines?.map((l: any) => ({ source_ref: l.source_ref, material_type: l.material_type, item_name: l.item_name, item_description: l.item_description ?? '',
    color_name: l.color_name ?? '', sizes: l.sizes ?? '', uom_id: l.uom_id, uom_code: l.uom_code, stock_qty: 0, qty: String(l.qty), rate: String(l.rate ?? ''), reason: l.reason ?? '' })) ?? []);
  const [picker, setPicker] = useState(false);
  const whs = useLookup('warehouses'); const sos = useLookup('sales-orders'); const uoms = useLookup('uoms');
  const rejWhs = (whs.data ?? []).filter((w: any) => w.warehouse_type === 'REJECTION');
  const act = useAction();
  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const add = (rows: StockRow[]) => setLines((ls) => [...ls, ...rows.filter((r) => !ls.some((l) => l.source_ref === r.source_ref)).map((r) => ({
    source_ref: r.source_ref, material_type: r.material_type, item_name: r.item_name, item_description: r.lot_no ?? '', lot_no: r.lot_no, color_name: r.color_name ?? '', sizes: r.sizes ?? '',
    uom_id: r.uom_id, uom_code: r.uom_code, stock_qty: num(r.stock_qty), qty: '', rate: String(r.rate ?? ''), reason: '' }))]);
  const save = (post_now: boolean) => {
    if (!lines.length) return toast('Add at least one item', 'error');
    act.mutate({ url: doc ? `/stores/scrap-rejections/${doc.id}` : '/stores/scrap-rejections', method: doc ? 'put' : 'post',
      body: { ...h, entry_kind: kind, post_now, warehouse_id: Number(h.warehouse_id) || null, rejection_warehouse_id: Number(h.rejection_warehouse_id) || null, so_id: Number(h.so_id) || null,
        lines: lines.map((l) => ({ material_type: l.material_type, source_ref: l.source_ref, item_description: l.item_description || null, color_name: l.color_name || null, sizes: l.sizes || null,
          uom_id: l.uom_id, qty: num(l.qty), rate: l.rate === '' ? null : num(l.rate), reason: l.reason || null })) } }, { onSuccess: (r) => onSaved(r.data) });
  };
  const total = lines.reduce((a, l) => a + num(l.qty) * num(l.rate), 0);
  return (
    <Modal open onClose={onClose} title={doc ? `Edit ${kind.toLowerCase()} entry ${doc.doc_no}` : kind === 'SCRAP' ? 'New scrap entry' : 'New rejection entry'}
      subtitle={kind === 'SCRAP' ? 'Stock items leave stock when posted; garment / WIP pieces are recorded' : 'Stock items move to the rejection godown when posted'}
      icon={<Recycle size={16} />} size="full"
      footerStart={<>{lines.length} item{lines.length === 1 ? '' : 's'} · value ₹{fmtDecimal(total, 2)}</>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" id="scrap-save-draft" loading={act.isPending} onClick={() => save(false)}>Save draft</Button>
        {!doc && canPost && <Button id="scrap-save-post" loading={act.isPending} onClick={() => save(true)}>Save &amp; post</Button>}
      </>}>
      <FormSection title="Document" cols={4}>
        <Input label="Date" type="date" required value={h.doc_date} onChange={(e) => setH({ ...h, doc_date: e.target.value })} />
        <Select label="Stage" required id="scrap-stage" value={h.stage} onChange={(e) => setH({ ...h, stage: e.target.value })} options={STAGES.map((s) => ({ value: s, label: s }))} />
        <Input label="Process" value={h.process_name} onChange={(e) => setH({ ...h, process_name: e.target.value })} />
        <Select label="Sale order / job" value={h.so_id} placeholder="—" onChange={(e) => setH({ ...h, so_id: e.target.value })} options={toOptions(sos.data)} />
      </FormSection>
      <FormSection title="Location" cols={kind === 'REJECTION' ? 3 : 2}>
        <Select label="From location" required id="scrap-wh" value={h.warehouse_id} disabled={lines.some((l) => l.source_ref)} placeholder="Select…" onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} options={toOptions(whs.data)} />
        {kind === 'REJECTION' && <Select label="Rejection godown" value={h.rejection_warehouse_id} placeholder={rejWhs.length ? 'Default rejection godown' : 'No REJECTION location set up'}
          onChange={(e) => setH({ ...h, rejection_warehouse_id: e.target.value })} options={toOptions(rejWhs as any)} />}
        <Input label="Remarks" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
      </FormSection>
      <div className="mb-2 flex items-end justify-between border-b border-slate-100 pb-1.5">
        <h3 className={tableHead}>Items</h3>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" id="scrap-garment-line" onClick={() => setLines((ls) => [...ls, { source_ref: null, material_type: 'GARMENT', item_name: '', item_description: '', color_name: '', sizes: '', uom_id: 1, stock_qty: 0, qty: '', rate: '', reason: '' }])}>
            <Plus size={13} className="mr-1 inline" /> Garment / WIP pieces</Button>
          <Button size="sm" id="scrap-pick" disabled={!h.warehouse_id} onClick={() => setPicker(true)}><PackageSearch size={13} className="mr-1 inline" /> Pick from stock</Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Item', 'Description', 'Colour', 'Sizes', 'UOM', 'Stock', 'Qty', 'Rate', 'Value', 'Reason', ''].map((t) => <th key={t} className={`${TH} ${/Stock|Qty|Rate|Value/.test(t) ? 'text-right' : 'text-left'}`}>{t}</th>)}</tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.source_ref ?? `g${i}`} className="border-t border-slate-100 scrap-line">
                <td className={`${TD} font-medium`}>{l.source_ref ? <>{l.item_name}<span className="ml-1 text-caption text-slate-400">{l.material_type.toLowerCase()}</span></> : <span className="text-slate-500">Garment / WIP</span>}</td>
                <td className={TD}><input className="input w-48 line-desc" value={l.item_description} placeholder={l.source_ref ? '' : 'e.g. Sewing rejects — style / part'} onChange={(e) => set(i, { item_description: e.target.value })} /></td>
                <td className={TD}><input className="input w-24" value={l.color_name} onChange={(e) => set(i, { color_name: e.target.value })} /></td>
                <td className={TD}><input className="input w-16" value={l.sizes} onChange={(e) => set(i, { sizes: e.target.value })} /></td>
                <td className={TD}>{l.source_ref ? l.uom_code : <select className="input w-20" value={l.uom_id ?? ''} onChange={(e) => set(i, { uom_id: Number(e.target.value) || null })}><option value="">—</option>{(uoms.data ?? []).map((u) => <option key={u.id} value={u.id}>{String(u.code)}</option>)}</select>}</td>
                <td className={`${TD} text-right tabular-nums`}>{l.source_ref && l.stock_qty ? qtyFmt(l.stock_qty) : '—'}</td>
                <td className={TD}><input className="input w-24 text-right line-qty" type="number" min="0" step="any" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
                <td className={TD}><input className="input w-24 text-right" type="number" min="0" step="any" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} /></td>
                <td className={`${TD} text-right tabular-nums`}>{fmtDecimal(num(l.qty) * num(l.rate), 2)}</td>
                <td className={TD}><input className="input w-36" value={l.reason} onChange={(e) => set(i, { reason: e.target.value })} /></td>
                <td className={TD}><button className="rounded p-1 text-slate-400 hover:text-red-600" aria-label="Remove item" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
              </tr>
            ))}
            {!lines.length && <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">Pick stock items or add garment / WIP pieces</td></tr>}
          </tbody>
        </table>
      </div>
      {picker && <StockPicker material="TRIM" allowTypeChange warehouseId={Number(h.warehouse_id)} exclude={lines.map((l) => l.source_ref ?? '')} onClose={() => setPicker(false)} onPick={(rows) => { add(rows); setPicker(false); }} />}
    </Modal>
  );
}

function EntryView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (d: any) => void }) {
  const { can } = useAuth();
  const d = useStoresDoc('scrap-rejections', id);
  const act = useAction();
  const [cancel, setCancel] = useState(false);
  const doc = d.data;
  return (
    <Modal open onClose={onClose} title={doc ? `${doc.entry_kind === 'SCRAP' ? 'Scrap' : 'Rejection'} entry ${doc.doc_no}` : 'Entry'} icon={<Recycle size={16} />} size="xl"
      footerStart={doc ? <StatusBadge value={doc.status} /> : null}
      footer={doc && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {doc.status === 'DRAFT' && <Button variant="secondary" id="scrap-cancel" onClick={() => setCancel(true)}>Cancel draft</Button>}
        {doc.status === 'DRAFT' && <Button variant="secondary" id="scrap-edit" onClick={() => onEdit(doc)}>Edit</Button>}
        {doc.status === 'DRAFT' && can('INVENTORY.ADJUST') && <Button id="scrap-post" loading={act.isPending} onClick={() => act.mutate({ url: `/stores/scrap-rejections/${id}/post` })}>Post</Button>}
      </>}>
      {!doc ? <LoadingBlock /> : (
        <>
          <InfoGrid items={[['Date', fmtDate(doc.doc_date)], ['Stage', doc.stage], ['Process', doc.process_name], ['Job', doc.so_no], ['From', doc.warehouse_name],
            ['Rejection godown', doc.rejection_warehouse_name], ['Prepared by', doc.prepared_by], ['Posted', doc.posted_at ? `${fmtDate(doc.posted_at)} · ${doc.posted_by_name ?? ''}` : '—'],
            ['Remarks', doc.remarks], ['Cancel reason', doc.cancel_reason]]} />
          <SimpleTable rows={doc.lines} cols={[{ key: 'material_type', label: 'Material' }, { key: 'item_name', label: 'Item' }, { key: 'color_name', label: 'Colour' }, { key: 'sizes', label: 'Sizes' },
            { key: 'uom_code', label: 'UOM' }, { key: 'qty', label: 'Qty', kind: 'qty' }, { key: 'rate', label: 'Rate', kind: 'money' }, { key: 'amount', label: 'Value', kind: 'money' }, { key: 'reason', label: 'Reason' }]} />
        </>
      )}
      {cancel && <ReasonModal title={`Cancel ${doc?.doc_no}`} busy={act.isPending} onClose={() => setCancel(false)}
        onConfirm={(reason) => act.mutate({ url: `/stores/scrap-rejections/${id}/cancel`, body: { reason } }, { onSuccess: () => setCancel(false) })} />}
    </Modal>
  );
}
