import { useState } from 'react';
import { Plus, Trash2, PackagePlus } from 'lucide-react';
import { PageHeader, Tabs, Modal, FormSection, Input, Select, Button, LoadingBlock, StatusBadge, useDebounced } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDecimal } from '../../lib/format';
import {
  MAT_OPTIONS, num, qtyFmt, today, monthStart, useAction, useStoresList, useStoresDoc, FilterBar, SimpleTable, ReportView, ReasonModal, InfoGrid,
  TH, TD, tableHead, type Col, type Mat,
} from './shared';

/**
 * Opening Stock (client tracker 14-Oct-2026): yarn / fabric / trims / general items by location, SO / style optional,
 * with rate. Draft → Post into stock. Posted entries are never edited or deleted (correct with a Stock Audit).
 */
const KG = 5;
interface Line { material_type: Mat; yarn_id: string; fabric_id: string; trim_id: string; item_description: string; color_name: string; sizes: string; lot_no: string; roll_no: string; uom_id: string; qty: string; rate: string; remarks: string }
const blank = (mt: Mat = 'YARN'): Line => ({ material_type: mt, yarn_id: '', fabric_id: '', trim_id: '', item_description: '', color_name: '', sizes: '', lot_no: '', roll_no: '', uom_id: mt === 'FABRIC' || mt === 'YARN' ? String(KG) : '', qty: '', rate: '', remarks: '' });

const REPORT_COLS: Col[] = [
  { key: 'doc_no', label: 'Docid' }, { key: 'doc_date', label: 'Docdate', kind: 'date' }, { key: 'party_name', label: 'Party Name' }, { key: 'location', label: 'Location' },
  { key: 'process_name', label: 'Process Name' }, { key: 'so_no', label: 'Sale Order No' }, { key: 'style_no', label: 'Style No' }, { key: 'season', label: 'Season' },
  { key: 'buyer', label: 'Buyer' }, { key: 'buyer_dept', label: 'Buyer Dept' }, { key: 'item_name', label: 'Item Name' }, { key: 'item_type', label: 'Item Type' },
  { key: 'color_name', label: 'Color' }, { key: 'sizes', label: 'Sizes' }, { key: 'description', label: 'Description' }, { key: 'uom', label: 'Uom' },
  { key: 'qty', label: 'Qty', kind: 'qty' }, { key: 'rate', label: 'Rate', kind: 'money' }, { key: 'amount', label: 'Amount', kind: 'money' },
  { key: 'prepared_by', label: 'Prepby' }, { key: 'remarks', label: 'Remarks' }, { key: 'order_type', label: 'Order Type' },
];

export default function OpeningStockPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('LIST');
  const [f, setF] = useState({ from: monthStart(), to: today(), q: '', status: '' });
  const q = useDebounced(f.q);
  const list = useStoresList('opening-stock', { from: f.from, to: f.to, q, status: f.status });
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<number | null>(null);
  const cols: Col[] = [
    { key: 'doc_no', label: 'Doc no', render: (r) => <span className="tabular-nums font-semibold text-brand-700">{r.doc_no}</span> },
    { key: 'doc_date', label: 'Date', kind: 'date' }, { key: 'warehouse_name', label: 'Location' }, { key: 'party_name', label: 'Party' },
    { key: 'so_no', label: 'Job' }, { key: 'line_count', label: 'Items' }, { key: 'total_qty', label: 'Qty', kind: 'qty' }, { key: 'total_amount', label: 'Amount', kind: 'money' },
    { key: 'prepared_by', label: 'Prepared by' }, { key: 'status', label: 'Status', kind: 'status' },
  ];
  return (
    <>
      <PageHeader breadcrumb={['Gate & Stores', 'Opening Stock']} title="Opening Stock" subtitle="Stock on hand at go-live, by location — posts into yarn lots, fabric rolls, trim stock and general items"
        actions={can('INVENTORY.CREATE') || can('INVENTORY.ADJUST') ? <Button id="new-opening" onClick={() => setEdit({})}><Plus size={14} className="mr-1 inline" /> New opening stock</Button> : null} />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'LIST', label: 'Register' }, { key: 'REPORT', label: 'Opening stock report' }]} active={tab} onChange={setTab} /></div>
      {tab === 'LIST' ? (
        <>
          <FilterBar f={f} setF={setF} statuses={['DRAFT', 'POSTED', 'CANCELLED']} />
          <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} onRow={(r) => setView(r.id)} />
        </>
      ) : <ReportView path="opening-stock" title="Opening stock register" cols={REPORT_COLS} />}
      {edit && <OpeningEditor doc={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={(d) => { setEdit(null); setView(d.id); }} />}
      {view && <OpeningView id={view} onClose={() => setView(null)} onEdit={(d) => { setView(null); setEdit(d); }} />}
    </>
  );
}

function OpeningEditor({ doc, onClose, onSaved }: { doc: any | null; onClose: () => void; onSaved: (d: any) => void }) {
  const { can } = useAuth();
  const [h, setH] = useState({
    doc_date: doc?.doc_date ?? today(), warehouse_id: doc?.warehouse_id ? String(doc.warehouse_id) : '', party_id: doc?.party_id ? String(doc.party_id) : '',
    process_name: doc?.process_name ?? '', so_id: doc?.so_id ? String(doc.so_id) : '', remarks: doc?.remarks ?? '',
  });
  const [lines, setLines] = useState<Line[]>(doc?.lines?.length ? doc.lines.map((l: any) => ({
    material_type: l.material_type, yarn_id: String(l.yarn_id ?? ''), fabric_id: String(l.fabric_id ?? ''), trim_id: String(l.trim_id ?? ''), item_description: l.item_description ?? '',
    color_name: l.color_name ?? '', sizes: l.sizes ?? '', lot_no: l.lot_no ?? '', roll_no: l.roll_no ?? '', uom_id: String(l.uom_id ?? ''), qty: String(l.qty ?? ''), rate: String(l.rate ?? ''), remarks: l.remarks ?? '',
  })) : [blank()]);
  const whs = useLookup('warehouses'); const parties = useLookup('suppliers'); const sos = useLookup('sales-orders');
  const yarns = useLookup('yarns'); const fabrics = useLookup('fabrics'); const trims = useLookup('trims'); const uoms = useLookup('uoms');
  const act = useAction();
  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const itemOpts = (mt: Mat) => toOptions(mt === 'YARN' ? yarns.data : mt === 'FABRIC' ? fabrics.data : trims.data);
  const onItem = (i: number, l: Line, id: string) => {
    const src = (l.material_type === 'YARN' ? yarns.data : l.material_type === 'FABRIC' ? fabrics.data : trims.data)?.find((x) => String(x.id) === id) as any;
    set(i, { [l.material_type === 'YARN' ? 'yarn_id' : l.material_type === 'FABRIC' ? 'fabric_id' : 'trim_id']: id,
      ...(src?.base_uom && l.material_type !== 'FABRIC' ? { uom_id: String(src.base_uom) } : {}), ...(src?.std_rate && !l.rate ? { rate: String(src.std_rate) } : {}) });
  };
  const totQty = lines.reduce((a, l) => a + num(l.qty), 0);
  const totAmt = lines.reduce((a, l) => a + num(l.qty) * num(l.rate), 0);
  const save = (post_now: boolean) => {
    const body = { ...h, warehouse_id: Number(h.warehouse_id) || null, party_id: Number(h.party_id) || null, so_id: Number(h.so_id) || null, post_now,
      lines: lines.map((l) => ({ ...l, yarn_id: Number(l.yarn_id) || null, fabric_id: Number(l.fabric_id) || null, trim_id: Number(l.trim_id) || null,
        uom_id: Number(l.uom_id) || null, qty: num(l.qty), rate: num(l.rate) })) };
    act.mutate(doc ? { url: `/stores/opening-stock/${doc.id}`, body, method: 'put' } : { url: '/stores/opening-stock', body }, { onSuccess: (r) => onSaved(r.data) });
  };
  return (
    <Modal open onClose={onClose} title={doc ? `Edit opening stock ${doc.doc_no}` : 'New opening stock'} subtitle="Yarn and fabric become opening GRN lots / rolls under the party; trims and general items go to the location's stock"
      icon={<PackagePlus size={16} />} size="full"
      footerStart={<>{lines.length} item{lines.length === 1 ? '' : 's'} · qty {qtyFmt(totQty)} · amount ₹{fmtDecimal(totAmt, 2)}</>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" id="opening-save-draft" loading={act.isPending} onClick={() => save(false)}>Save draft</Button>
        {!doc && can('INVENTORY.ADJUST') && <Button id="opening-save-post" loading={act.isPending} onClick={() => save(true)}>Save &amp; post into stock</Button>}
      </>}>
      <FormSection title="Document" cols={4}>
        <Input label="Date" type="date" required value={h.doc_date} onChange={(e) => setH({ ...h, doc_date: e.target.value })} />
        <Select label="Location" required id="opening-wh" value={h.warehouse_id} placeholder="Select…" onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} options={toOptions(whs.data)} />
        <Select label="Party" id="opening-party" value={h.party_id} placeholder="Select…" hint="Needed for yarn / fabric (the opening lot's supplier)" onChange={(e) => setH({ ...h, party_id: e.target.value })} options={toOptions(parties.data)} />
        <Input label="Process" value={h.process_name} placeholder="e.g. Grey / Dyed" onChange={(e) => setH({ ...h, process_name: e.target.value })} />
        <Select label="Sale order / job (optional)" className="sm:col-span-2" value={h.so_id} placeholder="General stock" onChange={(e) => setH({ ...h, so_id: e.target.value })} options={toOptions(sos.data)} />
        <Input label="Remarks" className="sm:col-span-2" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
      </FormSection>
      <div className="mb-2 flex items-end justify-between border-b border-slate-100 pb-1.5">
        <h3 className={tableHead}>Items</h3>
        <Button size="sm" id="opening-add-line" onClick={() => setLines((ls) => [...ls, blank(ls[ls.length - 1]?.material_type ?? 'YARN')])}><Plus size={13} className="mr-1 inline" /> Add item</Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>
            {['Material', 'Item', 'Colour', 'Sizes', 'Lot no', 'Roll no', 'UOM', 'Qty', 'Rate', 'Amount', 'Remarks', ''].map((t) => <th key={t} className={`${TH} text-left`}>{t}</th>)}
          </tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-t border-slate-100 opening-line">
                <td className={TD}><select className="input w-32" value={l.material_type} onChange={(e) => set(i, { ...blank(e.target.value as Mat), qty: l.qty, rate: l.rate })}>{MAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
                <td className={TD}>
                  {l.material_type === 'GENERAL'
                    ? <input className="input w-56 line-item" placeholder="Item name" value={l.item_description} onChange={(e) => set(i, { item_description: e.target.value })} />
                    : <select className="input w-56 line-item" value={l.material_type === 'YARN' ? l.yarn_id : l.material_type === 'FABRIC' ? l.fabric_id : l.trim_id} onChange={(e) => onItem(i, l, e.target.value)}>
                        <option value="">Select…</option>{itemOpts(l.material_type).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
                </td>
                <td className={TD}><input className="input w-24" value={l.color_name} onChange={(e) => set(i, { color_name: e.target.value })} /></td>
                <td className={TD}><input className="input w-16" value={l.sizes} onChange={(e) => set(i, { sizes: e.target.value })} /></td>
                <td className={TD}><input className="input w-28" value={l.lot_no} placeholder="auto" onChange={(e) => set(i, { lot_no: e.target.value })} /></td>
                <td className={TD}><input className="input w-24" disabled={l.material_type !== 'FABRIC'} value={l.roll_no} placeholder={l.material_type === 'FABRIC' ? 'auto' : ''} onChange={(e) => set(i, { roll_no: e.target.value })} /></td>
                <td className={TD}><select className="input w-20 line-uom" disabled={l.material_type === 'FABRIC'} value={l.material_type === 'FABRIC' ? String(KG) : l.uom_id} onChange={(e) => set(i, { uom_id: e.target.value })}>
                  <option value="">—</option>{(uoms.data ?? []).map((u) => <option key={u.id} value={u.id}>{String(u.code)}</option>)}</select></td>
                <td className={TD}><input className="input w-24 text-right line-qty" type="number" min="0" step="any" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
                <td className={TD}><input className="input w-24 text-right line-rate" type="number" min="0" step="any" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} /></td>
                <td className={`${TD} text-right tabular-nums`}>{fmtDecimal(num(l.qty) * num(l.rate), 2)}</td>
                <td className={TD}><input className="input w-32" value={l.remarks} onChange={(e) => set(i, { remarks: e.target.value })} /></td>
                <td className={TD}>{lines.length > 1 && <button className="rounded p-1 text-slate-400 hover:text-red-600" aria-label="Remove item" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function OpeningView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (d: any) => void }) {
  const { can } = useAuth();
  const d = useStoresDoc('opening-stock', id);
  const act = useAction();
  const [cancel, setCancel] = useState(false);
  const doc = d.data;
  return (
    <Modal open onClose={onClose} title={doc ? `Opening stock ${doc.doc_no}` : 'Opening stock'} subtitle={doc?.status === 'POSTED' ? 'Posted into stock — corrections go through a Stock Audit' : undefined}
      icon={<PackagePlus size={16} />} size="xl"
      footerStart={doc ? <StatusBadge value={doc.status} /> : null}
      footer={doc && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {doc.status === 'DRAFT' && <Button variant="secondary" id="opening-cancel" onClick={() => setCancel(true)}>Cancel draft</Button>}
        {doc.status === 'DRAFT' && <Button variant="secondary" id="opening-edit" onClick={() => onEdit(doc)}>Edit</Button>}
        {doc.status === 'DRAFT' && can('INVENTORY.ADJUST') && <Button id="opening-post" loading={act.isPending} onClick={() => act.mutate({ url: `/stores/opening-stock/${id}/post` })}>Post into stock</Button>}
      </>}>
      {!doc ? <LoadingBlock /> : (
        <>
          <InfoGrid items={[['Date', fmtDate(doc.doc_date)], ['Location', doc.warehouse_name], ['Party', doc.party_name], ['Process', doc.process_name], ['Job', doc.so_no], ['Prepared by', doc.prepared_by],
            ['Posted', doc.posted_at ? `${fmtDate(doc.posted_at)} · ${doc.posted_by_name ?? ''}` : '—'], ['Remarks', doc.cancel_reason ? `Cancelled: ${doc.cancel_reason}` : doc.remarks]]} />
          <SimpleTable rows={doc.lines} cols={[
            { key: 'material_type', label: 'Material' }, { key: 'item_name', label: 'Item' }, { key: 'item_type', label: 'Type' }, { key: 'color_name', label: 'Colour' }, { key: 'sizes', label: 'Sizes' },
            { key: 'lot_no', label: 'Lot' }, { key: 'roll_no', label: 'Roll' }, { key: 'line_so_no', label: 'Job' }, { key: 'uom_code', label: 'UOM' },
            { key: 'qty', label: 'Qty', kind: 'qty' }, { key: 'rate', label: 'Rate', kind: 'money' }, { key: 'amount', label: 'Amount', kind: 'money' },
          ]} />
        </>
      )}
      {cancel && <ReasonModal title={`Cancel ${doc?.doc_no}`} onClose={() => setCancel(false)} busy={act.isPending}
        onConfirm={(reason) => act.mutate({ url: `/stores/opening-stock/${id}/cancel`, body: { reason } }, { onSuccess: () => setCancel(false) })} />}
    </Modal>
  );
}

