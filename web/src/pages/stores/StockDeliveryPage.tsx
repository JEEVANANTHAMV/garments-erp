import { useState } from 'react';
import { Plus, Trash2, Truck, Undo2, PackageSearch } from 'lucide-react';
import { PageHeader, Tabs, Modal, FormSection, Input, Select, Button, LoadingBlock, StatusBadge, Checkbox, useDebounced } from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import { EwayBillButton } from '../../components/EwayBillButton';
import { useToast } from '../../hooks/useToast';
import { fmtDate, fmtDecimal } from '../../lib/format';
import {
  num, qtyFmt, today, monthStart, useAction, useStoresList, useStoresDoc, FilterBar, SimpleTable, ReportView, ReasonModal, InfoGrid, StockPicker,
  TH, TD, tableHead, type Col, type Mat, type StockRow,
} from './shared';

/**
 * Stock Delivery / General Delivery (client tracker 14-Oct-2026, rows 105–109).
 *   kind STOCK   — /stores/stock-delivery: items from stock; approval takes them out.
 *   kind GENERAL — /stores/general-delivery: the general delivery (outward gate pass) with item lines; free items (machinery,
 *                  tools — no stock) or general store items.
 * Returnable → outstanding until returned (return entry) or closed with a reason. Non-returnable → billable / non-billable.
 */
type Kind = 'STOCK' | 'GENERAL';
interface Line { source_ref: string | null; material_type: Mat; item_name: string; item_description: string; lot_no?: string | null; color_name: string; sizes: string;
  uom_id: number | null; uom_code?: string; stock_qty: number; qty: string; rate: string; remarks: string }

const STOCK_REPORT: Col[] = [
  { key: 'so_no', label: 'Sale Order' }, { key: 'style_no', label: 'Styleno' }, { key: 'dc_no', label: 'DC No' }, { key: 'dc_date', label: 'DC Date', kind: 'date' },
  { key: 'location', label: 'Location' }, { key: 'party_name', label: 'Party Name' }, { key: 'item_name', label: 'Item' },
  { key: 'dc_type', label: 'DC Type', render: (r) => (r.dc_type === 'RETURNABLE' ? 'Returnable' : `Non returnable · ${Number(r.is_billable) ? 'billable' : 'non-billable'}`) },
  { key: 'uom', label: 'UOM' }, { key: 'stock_qty', label: 'Stk Qty', kind: 'qty' }, { key: 'delivered_qty', label: 'Del Qty', kind: 'qty' },
  { key: 'returned_qty', label: 'Returned qty', kind: 'qty' }, { key: 'balance_qty', label: 'Balance Qty', kind: 'qty' },
];
const GENERAL_REPORT: Col[] = [
  { key: 'dc_no', label: 'DCNO' }, { key: 'dc_date', label: 'DC Date', kind: 'date' }, { key: 'dc_type', label: 'DC Type' }, { key: 'from_location', label: 'From Location' },
  { key: 'party_name', label: 'Party' }, { key: 'pdc_no', label: 'PDC No' }, { key: 'item_name', label: 'Item' }, { key: 'description', label: 'Description' },
  { key: 'color_name', label: 'Color' }, { key: 'sizes', label: 'Sizes' }, { key: 'uom', label: 'Uom' }, { key: 'qty', label: 'Qty', kind: 'qty' },
  { key: 'rec_qty', label: 'Rec Qty', kind: 'qty' }, { key: 'bal_qty', label: 'Bal Qty', kind: 'qty' }, { key: 'prepared_by', label: 'Prepby' },
];

export default function StockDeliveryPage({ kind = 'STOCK' }: { kind?: Kind }) {
  const { can } = useAuth();
  const [tab, setTab] = useState('LIST');
  const [f, setF] = useState({ from: monthStart(), to: today(), q: '', status: '' });
  const [dcType, setDcType] = useState('');
  const [onlyOut, setOnlyOut] = useState(false);
  const q = useDebounced(f.q);
  const out = tab === 'OUT';
  const list = useStoresList('deliveries', out ? { kind, outstanding: 1, q } : { kind, from: f.from, to: f.to, q, status: f.status, dc_type: dcType });
  const [edit, setEdit] = useState<any | null>(null);
  const [view, setView] = useState<number | null>(null);
  const label = kind === 'STOCK' ? 'Stock Delivery' : 'General Delivery';
  const cols: Col[] = [
    { key: 'doc_no', label: 'DC no', render: (r) => <span className="tabular-nums font-semibold text-brand-700">{r.doc_no}</span> },
    { key: 'doc_date', label: 'Date', kind: 'date' }, { key: 'party_name', label: 'Party' }, { key: 'warehouse_name', label: 'From location' },
    { key: 'dc_type', label: 'Type', render: (r) => (r.dc_type === 'RETURNABLE' ? 'Returnable' : `Non-returnable · ${Number(r.is_billable) ? 'billable' : 'non-billable'}`) },
    { key: 'expected_return_date', label: 'Return by', kind: 'date' }, { key: 'total_qty', label: 'Qty', kind: 'qty' }, { key: 'returned_qty', label: 'Returned', kind: 'qty' },
    { key: 'total_amount', label: 'Value', kind: 'money' }, { key: 'status', label: 'Status', kind: 'status' },
  ];
  return (
    <>
      <PageHeader breadcrumb={['Gate & Stores', label]} title={label}
        subtitle={kind === 'STOCK' ? 'Items out of stock to a party — returnable (outstanding until returned) or non-returnable (billable / FOC)' : 'Machinery, tools and other goods sent out — returnable or not; approval with a vehicle makes the outward gate pass'}
        actions={can('INVENTORY.CREATE') || can('ISSUE.CREATE') || can('INVENTORY.ADJUST') ? <Button id="new-delivery" onClick={() => setEdit({})}><Plus size={14} className="mr-1 inline" /> New {label.toLowerCase()}</Button> : null} />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'LIST', label: 'Register' }, { key: 'OUT', label: 'Returnable outstanding' }, { key: 'REPORT', label: `${label} report` }]} active={tab} onChange={setTab} /></div>
      {tab === 'REPORT' ? (
        <ReportView path={kind === 'STOCK' ? 'stock-delivery' : 'general-deliveries'} title={`${label} report`} cols={kind === 'STOCK' ? STOCK_REPORT : GENERAL_REPORT}
          extraParams={{ dc_type: dcType, outstanding: onlyOut ? 1 : '' }}
          extra={<>
            <Select label="DC type" className="w-44" value={dcType} placeholder="All" onChange={(e) => setDcType(e.target.value)} options={[{ value: 'RETURNABLE', label: 'Returnable' }, { value: 'NON_RETURNABLE', label: 'Non-returnable' }]} />
            <div className="pb-2"><Checkbox label="Outstanding only" checked={onlyOut} onChange={setOnlyOut} /></div>
          </>} />
      ) : (
        <>
          {!out && <FilterBar f={f} setF={setF} statuses={['DRAFT', 'APPROVED', 'PARTIAL_RETURN', 'RETURNED', 'CLOSED', 'CANCELLED']}>
            <Select label="DC type" className="w-44" value={dcType} placeholder="All" onChange={(e) => setDcType(e.target.value)} options={[{ value: 'RETURNABLE', label: 'Returnable' }, { value: 'NON_RETURNABLE', label: 'Non-returnable' }]} />
          </FilterBar>}
          <SimpleTable cols={cols} rows={list.data ?? []} loading={list.isLoading} onRow={(r) => setView(r.id)} empty={out ? 'Nothing outstanding — every returnable DC has come back' : undefined} />
        </>
      )}
      {edit && <DeliveryEditor kind={kind} doc={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={(d) => { setEdit(null); setView(d.id); }} />}
      {view && <DeliveryView id={view} onClose={() => setView(null)} onEdit={(d) => { setView(null); setEdit(d); }} />}
    </>
  );
}

function DeliveryEditor({ kind, doc, onClose, onSaved }: { kind: Kind; doc: any | null; onClose: () => void; onSaved: (d: any) => void }) {
  const toast = useToast();
  const [h, setH] = useState({
    doc_date: doc?.doc_date ?? today(), dc_type: doc?.dc_type ?? 'RETURNABLE', is_billable: doc?.is_billable === null || doc?.is_billable === undefined ? '' : String(Number(doc.is_billable)),
    warehouse_id: doc?.warehouse_id ? String(doc.warehouse_id) : '', party_id: doc?.party_id ? String(doc.party_id) : '', party_dc_no: doc?.party_dc_no ?? '',
    so_id: doc?.so_id ? String(doc.so_id) : '', purpose: doc?.purpose ?? '', expected_return_date: doc?.expected_return_date ?? '', vehicle_no: doc?.vehicle_no ?? '', remarks: doc?.remarks ?? '',
  });
  const [lines, setLines] = useState<Line[]>(doc?.lines?.map((l: any) => ({ source_ref: l.source_ref, material_type: l.material_type, item_name: l.item_name, item_description: l.item_description ?? '',
    color_name: l.color_name ?? '', sizes: l.sizes ?? '', uom_id: l.uom_id, uom_code: l.uom_code, stock_qty: num(l.stock_qty), qty: String(l.qty), rate: String(l.rate ?? ''), remarks: l.remarks ?? '' })) ?? []);
  const [picker, setPicker] = useState(false);
  const whs = useLookup('warehouses'); const parties = useLookup('trade-parties'); const sos = useLookup('sales-orders'); const uoms = useLookup('uoms');
  const act = useAction();
  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const add = (rows: StockRow[]) => setLines((ls) => [...ls, ...rows.filter((r) => !ls.some((l) => l.source_ref === r.source_ref)).map((r) => ({
    source_ref: r.source_ref, material_type: r.material_type, item_name: r.item_name, item_description: r.material_type === 'GENERAL' ? r.item_name : (r.lot_no ?? ''), lot_no: r.lot_no,
    color_name: r.color_name ?? '', sizes: r.sizes ?? '', uom_id: r.uom_id, uom_code: r.uom_code, stock_qty: num(r.stock_qty), qty: '', rate: String(r.rate ?? ''), remarks: '' }))]);
  const totQty = lines.reduce((a, l) => a + num(l.qty), 0);
  const totAmt = lines.reduce((a, l) => a + num(l.qty) * num(l.rate), 0);
  const ret = h.dc_type === 'RETURNABLE';
  const save = () => {
    if (!lines.length) return toast('Add at least one item', 'error');
    act.mutate({ url: doc ? `/stores/deliveries/${doc.id}` : '/stores/deliveries', method: doc ? 'put' : 'post',
      body: { ...h, delivery_kind: kind, warehouse_id: Number(h.warehouse_id) || null, party_id: Number(h.party_id) || null, so_id: Number(h.so_id) || null,
        is_billable: ret || h.is_billable === '' ? null : h.is_billable === '1', expected_return_date: ret && h.expected_return_date ? h.expected_return_date : null,
        lines: lines.map((l) => ({ source_ref: l.source_ref, item_description: l.item_description || null, color_name: l.color_name || null, sizes: l.sizes || null, uom_id: l.uom_id,
          qty: num(l.qty), rate: l.rate === '' ? null : num(l.rate), remarks: l.remarks || null })) } }, { onSuccess: (r) => onSaved(r.data) });
  };
  return (
    <Modal open onClose={onClose} title={doc ? `Edit ${kind === 'STOCK' ? 'stock' : 'general'} delivery ${doc.doc_no}` : `New ${kind === 'STOCK' ? 'stock' : 'general'} delivery`}
      subtitle="Saved as a draft; approval takes the stock out (and makes the gate pass when a vehicle is given)" icon={<Truck size={16} />} size="full"
      footerStart={<>{lines.length} item{lines.length === 1 ? '' : 's'} · qty {qtyFmt(totQty)} · value ₹{fmtDecimal(totAmt, 2)}</>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="delivery-save" loading={act.isPending} onClick={save}>Save for approval</Button>
      </>}>
      <FormSection title="Document" cols={4}>
        <Input label="DC date" type="date" required value={h.doc_date} onChange={(e) => setH({ ...h, doc_date: e.target.value })} />
        <Select label="DC type" required id="delivery-type" value={h.dc_type} onChange={(e) => setH({ ...h, dc_type: e.target.value })}
          options={[{ value: 'RETURNABLE', label: 'Returnable' }, { value: 'NON_RETURNABLE', label: 'Non-returnable' }]} />
        {ret
          ? <Input label="Expected return" type="date" value={h.expected_return_date} onChange={(e) => setH({ ...h, expected_return_date: e.target.value })} />
          : <Select label="Billing" required id="delivery-billable" value={h.is_billable} placeholder="Select…" onChange={(e) => setH({ ...h, is_billable: e.target.value })}
              options={[{ value: '1', label: 'Billable' }, { value: '0', label: 'Non-billable (FOC)' }]} />}
        <Select label="From location" required id="delivery-wh" value={h.warehouse_id} disabled={lines.some((l) => l.source_ref)} placeholder="Select…" onChange={(e) => setH({ ...h, warehouse_id: e.target.value })} options={toOptions(whs.data)} />
      </FormSection>
      <FormSection title="Party" cols={4}>
        <Select label="Party" required id="delivery-party" className="sm:col-span-2" value={h.party_id} placeholder="Select…" onChange={(e) => setH({ ...h, party_id: e.target.value })} options={toOptions(parties.data)} />
        <Input label="Party DC no" value={h.party_dc_no} onChange={(e) => setH({ ...h, party_dc_no: e.target.value })} />
        <Select label="Sale order / job" value={h.so_id} placeholder="—" onChange={(e) => setH({ ...h, so_id: e.target.value })} options={toOptions(sos.data)} />
      </FormSection>
      <FormSection title="Movement" cols={4}>
        <Input label="Purpose" className="sm:col-span-2" value={h.purpose} onChange={(e) => setH({ ...h, purpose: e.target.value })} />
        <Input label="Vehicle no" value={h.vehicle_no} hint="Given → gate pass made at approval" onChange={(e) => setH({ ...h, vehicle_no: e.target.value })} />
        <Input label="Remarks" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
      </FormSection>
      <div className="mb-2 flex items-end justify-between border-b border-slate-100 pb-1.5">
        <h3 className={tableHead}>Items</h3>
        <div className="flex gap-2">
          {kind === 'GENERAL' && <Button size="sm" variant="secondary" id="delivery-free-line" onClick={() => setLines((ls) => [...ls, { source_ref: null, material_type: 'GENERAL', item_name: '', item_description: '', color_name: '', sizes: '', uom_id: null, stock_qty: 0, qty: '', rate: '', remarks: '' }])}>
            <Plus size={13} className="mr-1 inline" /> Item (not from stock)</Button>}
          <Button size="sm" id="delivery-pick" disabled={!h.warehouse_id} onClick={() => setPicker(true)}><PackageSearch size={13} className="mr-1 inline" /> Pick from stock</Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>
            {['Item', 'Description', 'Colour', 'Sizes', 'UOM', 'Stock', 'Qty', 'Rate', 'Value', 'Remarks', ''].map((t) => <th key={t} className={`${TH} ${/Stock|Qty|Rate|Value/.test(t) ? 'text-right' : 'text-left'}`}>{t}</th>)}
          </tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.source_ref ?? `free${i}`} className="border-t border-slate-100 delivery-line">
                <td className={`${TD} font-medium`}>{l.source_ref ? <>{l.item_name}<span className="ml-1 text-[10.5px] text-slate-400">{l.material_type.toLowerCase()}</span></> : <span className="text-slate-400">Not from stock</span>}</td>
                <td className={TD}><input className="input w-48 line-desc" value={l.item_description} placeholder={l.source_ref ? '' : 'Item / description'} onChange={(e) => set(i, { item_description: e.target.value })} /></td>
                <td className={TD}><input className="input w-24" value={l.color_name} onChange={(e) => set(i, { color_name: e.target.value })} /></td>
                <td className={TD}><input className="input w-16" value={l.sizes} onChange={(e) => set(i, { sizes: e.target.value })} /></td>
                <td className={TD}>{l.source_ref ? l.uom_code : <select className="input w-20 line-uom" value={l.uom_id ?? ''} onChange={(e) => set(i, { uom_id: Number(e.target.value) || null })}><option value="">—</option>{(uoms.data ?? []).map((u) => <option key={u.id} value={u.id}>{String(u.code)}</option>)}</select>}</td>
                <td className={`${TD} text-right tabular-nums`}>{l.source_ref ? qtyFmt(l.stock_qty) : '—'}</td>
                <td className={TD}><input className={`input w-24 text-right line-qty ${l.source_ref && num(l.qty) > l.stock_qty ? 'input-error' : ''}`} type="number" min="0" step="any" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></td>
                <td className={TD}><input className="input w-24 text-right" type="number" min="0" step="any" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} /></td>
                <td className={`${TD} text-right tabular-nums`}>{fmtDecimal(num(l.qty) * num(l.rate), 2)}</td>
                <td className={TD}><input className="input w-32" value={l.remarks} onChange={(e) => set(i, { remarks: e.target.value })} /></td>
                <td className={TD}><button className="rounded p-1 text-slate-400 hover:text-red-600" aria-label="Remove item" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
              </tr>
            ))}
            {!lines.length && <tr><td colSpan={11} className="px-3 py-8 text-center text-slate-400">Choose the location, then pick items from stock{kind === 'GENERAL' ? ' or add items not held in stock' : ''}</td></tr>}
          </tbody>
        </table>
      </div>
      {picker && <StockPicker material={kind === 'GENERAL' ? 'GENERAL' : 'TRIM'} allowTypeChange warehouseId={Number(h.warehouse_id)} exclude={lines.map((l) => l.source_ref ?? '')}
        onClose={() => setPicker(false)} onPick={(rows) => { add(rows); setPicker(false); }} />}
    </Modal>
  );
}

function DeliveryView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (d: any) => void }) {
  const { can } = useAuth();
  const d = useStoresDoc('deliveries', id);
  const act = useAction();
  const [reason, setReason] = useState<'cancel' | 'close' | null>(null);
  const [ret, setRet] = useState(false);
  const doc = d.data;
  const outstanding = doc && doc.dc_type === 'RETURNABLE' && ['APPROVED', 'PARTIAL_RETURN'].includes(doc.status);
  return (
    <Modal open onClose={onClose} title={doc ? `${doc.delivery_kind === 'GENERAL' ? 'General' : 'Stock'} delivery ${doc.doc_no}` : 'Delivery'}
      subtitle={outstanding ? 'Returnable — outstanding until the goods come back' : undefined} icon={<Truck size={16} />} size="xl"
      footerStart={doc ? <StatusBadge value={doc.status} /> : null}
      footer={doc && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {doc.status !== 'CANCELLED' && <EwayBillButton sourceType="STOCK_DELIVERY" sourceId={id} />}
        {doc.status === 'DRAFT' && <Button variant="secondary" id="delivery-cancel" onClick={() => setReason('cancel')}>Cancel DC</Button>}
        {doc.status === 'DRAFT' && <Button variant="secondary" id="delivery-edit" onClick={() => onEdit(doc)}>Edit</Button>}
        {outstanding && can('INVENTORY.ADJUST') && <Button variant="secondary" id="delivery-close" onClick={() => setReason('close')}>Close short</Button>}
        {outstanding && <Button id="delivery-return" onClick={() => setRet(true)}><Undo2 size={14} className="mr-1 inline" /> Return entry</Button>}
        {doc.status === 'DRAFT' && can('INVENTORY.ADJUST') && <Button id="delivery-approve" loading={act.isPending} onClick={() => act.mutate({ url: `/stores/deliveries/${id}/approve` })}>Approve</Button>}
      </>}>
      {!doc ? <LoadingBlock /> : (
        <>
          <InfoGrid items={[['DC date', fmtDate(doc.doc_date)], ['Type', doc.dc_type === 'RETURNABLE' ? 'Returnable' : `Non-returnable · ${Number(doc.is_billable) ? 'billable' : 'non-billable'}`],
            ['Party', doc.party_name], ['Party DC no', doc.party_dc_no], ['From location', doc.warehouse_name], ['Job', doc.so_no], ['Return by', doc.expected_return_date ? fmtDate(doc.expected_return_date) : '—'],
            ['Gate pass', doc.gate_pass_no], ['Purpose', doc.purpose], ['Prepared by', doc.prepared_by], ['Approved', doc.approved_at ? `${fmtDate(doc.approved_at)} · ${doc.approved_by_name ?? ''}` : '—'],
            ['Cancel / close reason', doc.cancel_reason]]} />
          <SimpleTable rows={doc.lines} cols={[
            { key: 'item_name', label: 'Item' }, { key: 'item_description', label: 'Description' }, { key: 'color_name', label: 'Colour' }, { key: 'sizes', label: 'Sizes' }, { key: 'uom_code', label: 'UOM' },
            { key: 'stock_qty', label: 'Stock', kind: 'qty' }, { key: 'qty', label: 'Delivered', kind: 'qty' }, { key: 'returned_qty', label: 'Returned', kind: 'qty' },
            { key: 'balance_qty', label: 'Balance', kind: 'qty' }, { key: 'amount', label: 'Value', kind: 'money' },
          ]} />
          {doc.returns?.length > 0 && <>
            <h3 className={`${tableHead} mb-2 mt-4 border-b border-slate-100 pb-1.5`}>Returns</h3>
            <SimpleTable rows={doc.returns} cols={[{ key: 'return_no', label: 'Return no' }, { key: 'return_date', label: 'Date', kind: 'date' }, { key: 'party_dc_no', label: 'Party DC no' },
              { key: 'qty', label: 'Qty', kind: 'qty' }, { key: 'prepared_by', label: 'Entered by' }, { key: 'remarks', label: 'Remarks' }]} />
          </>}
        </>
      )}
      {reason && <ReasonModal title={reason === 'cancel' ? `Cancel ${doc?.doc_no}` : `Close ${doc?.doc_no} short`} confirm={reason === 'cancel' ? 'Cancel DC' : 'Close DC'}
        subtitle={reason === 'close' ? 'The balance will not come back; it stays out of stock' : undefined} busy={act.isPending}
        onClose={() => setReason(null)} onConfirm={(r) => act.mutate({ url: `/stores/deliveries/${id}/${reason}`, body: { reason: r } }, { onSuccess: () => setReason(null) })} />}
      {ret && doc && <ReturnEntry doc={doc} onClose={() => setRet(false)} />}
    </Modal>
  );
}

function ReturnEntry({ doc, onClose }: { doc: any; onClose: () => void }) {
  const open = doc.lines.filter((l: any) => num(l.balance_qty) > 0.0005);
  const [h, setH] = useState({ return_date: today(), party_dc_no: '', remarks: '' });
  const [qty, setQty] = useState<Record<number, string>>(Object.fromEntries(open.map((l: any) => [l.id, String(num(l.balance_qty))])));
  const act = useAction();
  const total = Object.values(qty).reduce((a, v) => a + num(v), 0);
  return (
    <Modal open onClose={onClose} title={`Return entry · ${doc.doc_no}`} subtitle="Goods back from the party; stock items return to their lot / roll" icon={<Undo2 size={16} />} size="lg"
      footerStart={<>Returning {qtyFmt(total)}</>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="return-save" disabled={total <= 0} loading={act.isPending} onClick={() => act.mutate({ url: `/stores/deliveries/${doc.id}/returns`,
          body: { ...h, party_dc_no: h.party_dc_no || null, remarks: h.remarks || null, lines: open.map((l: any) => ({ delivery_line_id: l.id, qty: num(qty[l.id]) })) } }, { onSuccess: onClose })}>Save return</Button>
      </>}>
      <FormSection cols={3}>
        <Input label="Return date" type="date" required value={h.return_date} onChange={(e) => setH({ ...h, return_date: e.target.value })} />
        <Input label="Party DC no" value={h.party_dc_no} onChange={(e) => setH({ ...h, party_dc_no: e.target.value })} />
        <Input label="Remarks" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
      </FormSection>
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr>{['Item', 'UOM', 'Delivered', 'Returned', 'Outstanding', 'Return now'].map((t) => <th key={t} className={`${TH} ${t === 'Item' || t === 'UOM' ? 'text-left' : 'text-right'}`}>{t}</th>)}</tr></thead>
        <tbody>
          {open.map((l: any) => (
            <tr key={l.id} className="border-t border-slate-100">
              <td className={TD}>{l.item_name}{l.item_description && l.item_description !== l.item_name ? <span className="text-slate-400"> · {l.item_description}</span> : null}</td><td className={TD}>{l.uom_code}</td>
              <td className={`${TD} text-right tabular-nums`}>{qtyFmt(l.qty)}</td><td className={`${TD} text-right tabular-nums`}>{qtyFmt(l.returned_qty)}</td><td className={`${TD} text-right tabular-nums`}>{qtyFmt(l.balance_qty)}</td>
              <td className={`${TD} text-right`}><input className="input w-24 text-right return-qty" type="number" min="0" max={num(l.balance_qty)} step="any" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
