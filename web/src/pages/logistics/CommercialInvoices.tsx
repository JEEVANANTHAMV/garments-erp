import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, Eye, Lock, Plus, Printer, RefreshCw, Save, Trash2, Unlock } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Card, Button, Input, Select, Textarea, Modal, Badge, LoadingBlock, ErrorState, SearchInput, useDebounced, ConfirmDialog } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { http, api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate, fmtNumber, fmtDecimal } from '../../lib/format';
import { PackingListLayout, type PlLayout } from './PackingListPrint';

/**
 * Commercial invoice for shipping in the client's FK-087 format (voice note 23-Oct-2026: "use this format for the
 * shipping invoice"). Made from the sales order and its confirmed packing list(s); every box of the sheet is a field
 * here. Two layouts: BUYER (bank details + REX declaration) and IGST (INR value + IGST paid per rate, charge lines).
 * Preview / print / Excel are drawn from the server's cell grid, so they match the client's sheet.
 */

const errMsg = (e: unknown, f = 'Something went wrong') => {
  if (e instanceof ApiError) { const fe = Object.values(e.fieldErrors); return fe.length && e.code === 'VALIDATION_ERROR' ? fe.join(' · ') : e.message; }
  return f;
};
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/* ================================================================ register */
export function CommercialInvoicesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const list = useQuery({
    queryKey: ['commercial-invoices', dq, status, page],
    queryFn: async () => http.get<{ data: any[]; pagination: any }>('/commercial-invoices', { q: dq || undefined, doc_status: status || undefined, page, pageSize: 25 }),
  });
  return (
    <div>
      <PageHeader title="Commercial Invoices" breadcrumb={['Export']} subtitle="Shipping invoices in the FK-087 format — made from the order's confirmed packing lists"
        actions={can('EXPORT.CREATE') && <Button id="ci-new" onClick={() => nav('/export/invoices/new')}><Plus size={15} />New invoice</Button>} />
      <div className="card mb-3 flex flex-wrap items-end gap-2.5 p-3">
        <SearchInput className="w-72" value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Invoice no, order, PO, buyer…" />
        <Select className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} placeholder="All" options={[{ value: 'DRAFT', label: 'Draft' }, { value: 'FINAL', label: 'Final' }]} />
      </div>
      <DataTable rows={list.data?.data ?? []} loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} rowKey={(r: any) => r.id}
        onRowClick={(r: any) => nav(`/export/invoices/${r.id}`)} pagination={list.data?.pagination} onPage={setPage} emptyTitle="No invoices"
        columns={[
          { key: 'invoice_no', header: 'Invoice no', render: (r: any) => <span className="font-mono text-[12px] font-semibold text-brand-700">{r.invoice_no}</span> },
          { key: 'invoice_date', header: 'Date', render: (r: any) => fmtDate(r.invoice_date) },
          { key: 'buyer_name', header: 'Buyer / order', render: (r: any) => <div><p className="font-medium">{r.buyer_name}</p><p className="text-[11px] text-slate-500">{r.so_no}{r.io_no ? ` · ${r.io_no}` : ''}</p></div> },
          { key: 'buyer_order_ref', header: 'Buyer PO', render: (r: any) => <span className="text-[12px]">{String(r.buyer_order_ref ?? '').replace(/\n/g, ' / ') || '—'}</span> },
          { key: 'packing_lists', header: 'Packing lists', render: (r: any) => <span className="text-[12px]">{r.packing_lists ?? '—'}</span> },
          { key: 'qty', header: 'Qty', align: 'right', render: (r: any) => fmtNumber(r.qty) },
          { key: 'total_value', header: 'Value', align: 'right', render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.total_value, 2)}` },
          { key: 'invoice_format', header: 'Format', render: (r: any) => <Badge tone={r.invoice_format === 'IGST' ? 'violet' : 'blue'}>{r.invoice_format === 'IGST' ? 'IGST' : 'Buyer'}</Badge> },
          { key: 'doc_status', header: 'Status', render: (r: any) => <Badge tone={r.doc_status === 'FINAL' ? 'green' : 'amber'}>{r.doc_status === 'FINAL' ? 'Final' : 'Draft'}</Badge> },
        ]} />
    </div>
  );
}

/* ================================================================ editor */
const EMPTY_LINE = { line_kind: 'GOODS', order_no: '', buyer_sku_no: '', buyer_item_no: '', supplier_mat_no: '', description: '', hsn_code: '', qty: '', unit_price: '', gst_rate: '' };
const HEAD_KEYS = ['invoice_no', 'invoice_date', 'invoice_format', 'currency_id', 'exchange_rate', 'exporter_details', 'exporter_ref', 'buyer_order_ref', 'other_references',
  'consignee_details', 'buyer_details', 'ship_to_details', 'country_origin_text', 'country_dest_text', 'pre_carriage_by', 'place_of_receipt', 'vessel_flight_no',
  'port_of_loading', 'port_of_discharge', 'final_destination', 'terms_of_delivery', 'terms_of_payment', 'marks_nos', 'packages_text', 'goods_heading', 'item_ref_label',
  'qty_unit', 'rate_basis', 'total_cartons', 'total_pcs', 'total_pcs_unit', 'net_weight_kg', 'gross_weight_kg', 'qty_words', 'amount_words', 'bank_details',
  'rex_declaration', 'declaration', 'footer_note', 'goods_gst_rate', 'charges_gst_rate', 'remarks'];
const fromServer = (d: any) => {
  const v: any = { so_id: d.so_id, pl_ids: d.pl_ids ?? [], row_version: d.row_version };
  for (const k of HEAD_KEYS) v[k] = d[k] ?? '';
  v.lines = (d.lines ?? []).map((l: any) => ({ ...EMPTY_LINE, ...Object.fromEntries(Object.entries(l).map(([k, x]) => [k, x ?? ''])) }));
  return v;
};

export function CommercialInvoiceDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const currencies = useLookup('currencies');
  const orders = useLookup('sales-orders');
  const detail = useQuery({ queryKey: ['commercial-invoice', id], queryFn: async () => (await http.get<{ data: any }>(`/commercial-invoices/${id}`)).data, enabled: !isNew });
  const [v, setV] = useState<any | null>(isNew ? { so_id: '', pl_ids: [], invoice_format: 'BUYER', lines: [] } : null);
  const [plOptions, setPlOptions] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<null | 'BUYER' | 'IGST'>(null);
  const [printLayout, setPrintLayout] = useState<PlLayout | null>(null);
  const [confirm, setConfirm] = useState<null | 'delete' | 'reopen'>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { if (detail.data) setV(fromServer(detail.data)); }, [detail.data]);
  // the packing lists of the order (to add / remove lists on a saved invoice)
  useEffect(() => {
    if (!v?.so_id || !can('EXPORT.CREATE')) return;
    http.get<{ data: any }>('/commercial-invoices/prefill', { so_id: v.so_id, pl_ids: (v.pl_ids ?? []).join(',') || undefined, format: v.invoice_format })
      .then((r) => setPlOptions(r.data.packing_lists)).catch(() => setPlOptions([]));
  }, [v?.so_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const final = detail.data?.doc_status === 'FINAL';
  const editable = !final && (isNew ? can('EXPORT.CREATE') : can('EXPORT.UPDATE'));
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const setLine = (i: number, k: string, x: unknown) => setV((o: any) => ({ ...o, lines: o.lines.map((l: any, j: number) => (j === i ? { ...l, [k]: x } : l)) }));
  const cur = (currencies.data ?? []).find((c) => String(c.id) === String(v?.currency_id));
  const igst = v?.invoice_format === 'IGST';
  const totals = useMemo(() => {
    const ls = v?.lines ?? [];
    const amt = (l: any) => r2((Number(l.qty) || 0) * (Number(l.unit_price) || 0));
    const goods = ls.filter((l: any) => l.line_kind !== 'CHARGE');
    return { qty: goods.reduce((t: number, l: any) => t + (Number(l.qty) || 0), 0), goods: r2(goods.reduce((t: number, l: any) => t + amt(l), 0)), total: r2(ls.reduce((t: number, l: any) => t + amt(l), 0)), amt };
  }, [v?.lines]);

  const fill = async (format = v.invoice_format) => {
    if (!v.so_id) { toast('Pick the sales order first', 'error'); return; }
    setBusy(true);
    try {
      const r = await http.get<{ data: any }>('/commercial-invoices/prefill', { so_id: v.so_id, pl_ids: (v.pl_ids ?? []).join(',') || undefined, format });
      const d = r.data;
      setPlOptions(d.packing_lists);
      setV((o: any) => ({ ...fromServer({ ...d, row_version: o.row_version }), invoice_no: o.invoice_no ?? '', invoice_format: format }));
      toast(`Filled from ${d.so_no}${d.pl_ids.length ? ` and ${d.pl_ids.length} packing list(s)` : ' (no confirmed packing list — order quantities)'}`);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const body = () => {
    const nz = (x: any) => (x === '' || x == null ? null : x);
    const num = (x: any) => (x === '' || x == null ? null : Number(x));
    const b: any = { so_id: Number(v.so_id), pl_ids: v.pl_ids, row_version: v.row_version };
    for (const k of HEAD_KEYS) b[k] = nz(v[k]);
    for (const k of ['currency_id', 'exchange_rate', 'total_cartons', 'total_pcs', 'net_weight_kg', 'gross_weight_kg', 'goods_gst_rate', 'charges_gst_rate']) b[k] = num(v[k]);
    b.qty_unit = v.qty_unit || 'PCS'; b.invoice_format = v.invoice_format || 'BUYER';
    b.lines = v.lines.map((l: any) => ({ line_kind: l.line_kind || 'GOODS', so_id: num(l.so_id), style_id: num(l.style_id), color_id: num(l.color_id), order_no: nz(l.order_no),
      buyer_sku_no: nz(l.buyer_sku_no), buyer_item_no: nz(l.buyer_item_no), supplier_mat_no: nz(l.supplier_mat_no), description: nz(l.description), hsn_code: nz(l.hsn_code),
      qty: Number(l.qty), unit_price: Number(l.unit_price), gst_rate: num(l.gst_rate) }));
    return b;
  };
  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        const r = await http.post<{ data: { id: number } }>('/commercial-invoices', body());
        toast('Invoice saved'); void qc.invalidateQueries({ queryKey: ['commercial-invoices'] }); nav(`/export/invoices/${r.data.id}`, { replace: true });
      } else {
        await http.put(`/commercial-invoices/${id}`, body()); toast('Invoice saved'); await detail.refetch(); void qc.invalidateQueries({ queryKey: ['commercial-invoices'] });
      }
    } catch (e) { toast(errMsg(e), 'error'); if ((e as any)?.status === 409) void detail.refetch(); } finally { setBusy(false); }
  };
  const act = async (path: string, b: any, msg: string) => {
    setBusy(true);
    try { await http.post(`/commercial-invoices/${id}/${path}`, b); toast(msg); setConfirm(null); setReason(''); await detail.refetch(); void qc.invalidateQueries({ queryKey: ['commercial-invoices'] }); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const excel = async (format: string) => {
    try {
      const r = await api.get(`/commercial-invoices/${id}/export.xlsx`, { params: { format }, responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `${detail.data?.invoice_no ?? 'invoice'}_${format}.xlsx`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast(errMsg(e, 'Could not download the Excel'), 'error'); }
  };
  const print = async (format: string) => {
    try {
      const d = (await http.get<{ data: any }>(`/commercial-invoices/${id}`, { format })).data;
      setPrintLayout(d.layout); setTimeout(() => window.print(), 150);
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  if (!isNew && detail.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && detail.error) return <div className="card"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div>;
  if (!v) return null;
  const T = detail.data?.totals;
  const dirtyTotals = !isNew && T && Math.abs(T.total_amount - totals.total) > 0.005;

  return (
    <div>
      <PageHeader breadcrumb={['Export', 'Commercial Invoices']}
        title={<span className="flex flex-wrap items-center gap-2">{isNew ? 'New commercial invoice' : <span className="font-mono">{detail.data.invoice_no}</span>}
          {!isNew && <Badge tone={final ? 'green' : 'amber'}>{final ? 'Final' : 'Draft'}</Badge>}
          {!isNew && detail.data.legacy && <Badge tone="slate">old form — fill the boxes</Badge>}</span>}
        subtitle={isNew ? 'Pick the order and its confirmed packing lists, fill, check, save' : `${detail.data.buyer_name ?? ''} · ${detail.data.so_no ?? ''}${final ? ` · finalised ${fmtDate(detail.data.finalized_at)} by ${detail.data.finalized_by_name ?? ''}` : ''}`}
        actions={<div className="flex flex-wrap gap-2" id="ci-actions">
          <Button variant="secondary" onClick={() => nav('/export/invoices')}><ArrowLeft size={15} />Back</Button>
          {!isNew && <><Button variant="secondary" id="ci-preview" onClick={() => setPreview(v.invoice_format)}><Eye size={14} />Preview</Button>
            <Button variant="secondary" id="ci-print" onClick={() => void print(v.invoice_format)}><Printer size={14} />Print</Button>
            <Button variant="secondary" id="ci-excel" onClick={() => void excel(v.invoice_format)}><Download size={14} />Excel</Button></>}
          {editable && <Button loading={busy} id="ci-save" onClick={() => void save()}><Save size={14} />Save</Button>}
          {!isNew && !final && can('EXPORT.APPROVE') && <Button variant="secondary" loading={busy} id="ci-finalize" onClick={() => void act('finalize', {}, 'Invoice finalised — read-only')}><Lock size={14} />Finalise</Button>}
          {!isNew && final && can('EXPORT.APPROVE') && <Button variant="secondary" id="ci-reopen" onClick={() => setConfirm('reopen')}><Unlock size={14} />Reopen</Button>}
          {!isNew && !final && can('EXPORT.DELETE') && <Button variant="danger" onClick={() => setConfirm('delete')}><Trash2 size={14} /></Button>}
        </div>} />
      {dirtyTotals && <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-800">Not saved: the lines changed — Save before preview / print / Excel.</p>}

      <fieldset disabled={!editable} className="space-y-4" id="ci-form">
        <Card title="Order, packing lists & format">
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            <Select label="Sales order" required id="ci-so" disabled={!isNew} placeholder="— Select —" options={toOptions(orders.data)} value={v.so_id}
              onChange={(e) => { set('so_id', e.target.value); set('pl_ids', []); setPlOptions([]); }} />
            <Select label="Layout" id="ci-format" value={v.invoice_format} onChange={(e) => set('invoice_format', e.target.value)}
              options={[{ value: 'BUYER', label: 'Buyer invoice (bank + REX)' }, { value: 'IGST', label: 'IGST invoice (INR + IGST paid)' }]} />
            <Input label="Invoice no" value={v.invoice_no} placeholder="Auto when blank" id="ci-no" onChange={(e) => set('invoice_no', e.target.value)} hint="e.g. FK-087/26-27" />
            <Input label="Invoice date" type="date" required value={v.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} />
            <div className="sm:col-span-4">
              <p className="label">Packing lists on this invoice <span className="font-normal text-slate-400">(confirmed lists of the order; one invoice can carry several POs)</span></p>
              <div className="flex flex-wrap gap-2" id="ci-pls">
                {!plOptions.length && <span className="text-[12px] text-slate-400">{v.so_id ? 'No packing list for this order — the order quantities are used' : 'Pick the order'}</span>}
                {plOptions.map((p) => {
                  const on = v.pl_ids.includes(Number(p.id));
                  const mine = !isNew && Number(p.invoice_id) === Number(id);
                  const ok = p.selectable || mine;
                  return (
                    <label key={p.id} className={clsx('flex items-center gap-1.5 rounded border px-2 py-1 text-[12px]', on ? 'border-brand-400 bg-brand-50' : 'border-slate-200', !ok && 'opacity-50')}
                      title={!ok ? (p.linked_invoice_no ? `On invoice ${p.linked_invoice_no}` : `${String(p.status).toLowerCase()} — confirm it first`) : undefined}>
                      <input type="checkbox" data-pl={p.pl_no} disabled={!ok} checked={on} onChange={(e) => set('pl_ids', e.target.checked ? [...v.pl_ids, Number(p.id)] : v.pl_ids.filter((x: number) => x !== Number(p.id)))} />
                      <b>{p.pl_no}</b> {String(p.status).toLowerCase()} · {fmtNumber(p.total_cartons)} ctns · {fmtNumber(p.total_qty)} pcs{p.buyer_order_no ? ` · PO ${p.buyer_order_no}` : ''}
                      {p.linked_invoice_no && !mine && <span className="text-amber-700">on {p.linked_invoice_no}</span>}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="flex items-end sm:col-span-4">
              <Button variant="secondary" loading={busy} id="ci-fill" disabled={!v.so_id} onClick={() => void fill()}><RefreshCw size={14} />{isNew ? 'Fill from order & packing lists' : 'Fill again (replaces the boxes and lines)'}</Button>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Exporter · invoice · buyer's order">
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <Textarea className="sm:col-span-2" rows={5} label="Exporter (name, address, GST no — one per line)" required value={v.exporter_details} id="ci-exporter" onChange={(e) => set('exporter_details', e.target.value)} />
              <Input label="Exporter's Ref." value={v.exporter_ref} placeholder="IEC NO : …" onChange={(e) => set('exporter_ref', e.target.value)} />
              <Input label="Other Reference(s)" value={v.other_references} onChange={(e) => set('other_references', e.target.value)} />
              <Textarea className="sm:col-span-2" rows={2} label="Buyer's Order No. & Date (one PO per line)" value={v.buyer_order_ref} onChange={(e) => set('buyer_order_ref', e.target.value)} />
              <Select label="Currency" options={(currencies.data ?? []).map((c) => ({ value: c.id, label: String(c.code) }))} value={v.currency_id} onChange={(e) => set('currency_id', e.target.value)} />
              <Input label={`Exchange rate (₹ per 1 ${cur?.code ?? ''})`} type="number" step="any" value={v.exchange_rate} id="ci-xr" onChange={(e) => set('exchange_rate', e.target.value)} />
            </div>
          </Card>
          <Card title="Consignee · buyer · ship to">
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <Textarea rows={6} label="Consignee" required value={v.consignee_details} id="ci-consignee" onChange={(e) => set('consignee_details', e.target.value)} />
              <Textarea rows={6} label="Buyer (if other than consignee)" value={v.buyer_details} onChange={(e) => set('buyer_details', e.target.value)} />
              <Textarea className="sm:col-span-2" rows={3} label="Ship to (delivery address)" value={v.ship_to_details} onChange={(e) => set('ship_to_details', e.target.value)} />
              <Input label="Country of origin of goods" value={v.country_origin_text} onChange={(e) => set('country_origin_text', e.target.value)} />
              <Input label="Country of final destination" value={v.country_dest_text} onChange={(e) => set('country_dest_text', e.target.value)} />
            </div>
          </Card>
          <Card title="Transport · terms">
            <div className="grid gap-3 p-4 sm:grid-cols-3">
              <Input label="Pre-carriage by" value={v.pre_carriage_by} onChange={(e) => set('pre_carriage_by', e.target.value)} />
              <Input label="Place of receipt by pre-carrier" value={v.place_of_receipt} onChange={(e) => set('place_of_receipt', e.target.value)} />
              <Input label="Vessel / flight no." value={v.vessel_flight_no} onChange={(e) => set('vessel_flight_no', e.target.value)} />
              <Input label="Port of loading" value={v.port_of_loading} onChange={(e) => set('port_of_loading', e.target.value)} />
              <Input label="Port of discharge" value={v.port_of_discharge} onChange={(e) => set('port_of_discharge', e.target.value)} />
              <Input label="Final destination" value={v.final_destination} onChange={(e) => set('final_destination', e.target.value)} />
              <Input className="sm:col-span-3" label="Terms of delivery" value={v.terms_of_delivery} onChange={(e) => set('terms_of_delivery', e.target.value)} />
              <Input className="sm:col-span-3" label="Terms of payment" value={v.terms_of_payment} onChange={(e) => set('terms_of_payment', e.target.value)} />
            </div>
          </Card>
          <Card title="Marks · packages · description">
            <div className="grid gap-3 p-4 sm:grid-cols-3">
              <Textarea rows={7} label="Marks & Nos. / Container No. (one per line)" value={v.marks_nos} onChange={(e) => set('marks_nos', e.target.value)} />
              <Textarea rows={3} label="No. & kind of packages" value={v.packages_text} onChange={(e) => set('packages_text', e.target.value)} />
              <Textarea rows={3} label="Description of goods (heading)" value={v.goods_heading} onChange={(e) => set('goods_heading', e.target.value)} />
              <Input label="Quantity unit" value={v.qty_unit} onChange={(e) => set('qty_unit', e.target.value)} />
              <Input label="Rate caption" value={v.rate_basis} placeholder={`FOB ${cur?.code ?? ''}`} onChange={(e) => set('rate_basis', e.target.value)} />
              <Input label="Buyer item no caption" value={v.item_ref_label} placeholder="COOP ID NO" onChange={(e) => set('item_ref_label', e.target.value)} />
            </div>
          </Card>
        </div>

        <Card title="Lines" subtitle="Goods: one line per order / style / colour (shipped quantity from the packing lists). Charges (IGST layout): hanger cost and the like — their quantity is printed beside the item references so the quantity total stays the goods quantity."
          actions={editable && <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => set('lines', [...v.lines, { ...EMPTY_LINE }])}><Plus size={13} />Goods line</Button>
            <Button size="sm" variant="secondary" id="ci-add-charge" onClick={() => set('lines', [...v.lines, { ...EMPTY_LINE, line_kind: 'CHARGE', description: 'HANGER COST', qty: totals.qty || '' }])}><Plus size={13} />Charge</Button>
          </div>}>
          <div className="overflow-x-auto">
            <table className="w-full" id="ci-lines">
              <thead><tr><th className="th w-16">Kind</th><th className="th">Order no</th><th className="th">SKU / EAN</th><th className="th">{v.item_ref_label || 'Buyer item no'}</th>
                <th className="th">Supplier mat no</th><th className="th">Description</th><th className="th">HSN</th><th className="th text-right">Qty</th><th className="th text-right">Rate</th>
                <th className="th text-right">Amount</th>{igst && <th className="th text-right">IGST %</th>}<th className="th" /></tr></thead>
              <tbody>
                {!v.lines.length && <tr><td colSpan={12} className="td py-6 text-center text-slate-400">No lines — fill from the order or add a line</td></tr>}
                {v.lines.map((l: any, i: number) => {
                  const inp = (k: string, w = 'w-28', type = 'text') => <input className={clsx('input h-8 py-0 text-[12px]', w, type === 'number' && 'text-right')} type={type} step="any" value={l[k] ?? ''} data-line={`${i}-${k}`} onChange={(e) => setLine(i, k, e.target.value)} />;
                  return (
                    <tr key={i} className="align-top">
                      <td className="td text-[11px]"><Badge tone={l.line_kind === 'CHARGE' ? 'violet' : 'slate'}>{l.line_kind === 'CHARGE' ? 'charge' : 'goods'}</Badge></td>
                      <td className="td">{l.line_kind === 'CHARGE' ? null : inp('order_no')}</td>
                      <td className="td">{l.line_kind === 'CHARGE' ? null : inp('buyer_sku_no', 'w-32')}</td>
                      <td className="td">{l.line_kind === 'CHARGE' ? null : inp('buyer_item_no')}</td>
                      <td className="td">{l.line_kind === 'CHARGE' ? null : inp('supplier_mat_no', 'w-24')}</td>
                      <td className="td">{inp('description', 'w-72')}</td>
                      <td className="td">{inp('hsn_code', 'w-24')}</td>
                      <td className="td text-right">{inp('qty', 'w-24', 'number')}</td>
                      <td className="td text-right">{inp('unit_price', 'w-20', 'number')}</td>
                      <td className="td text-right tabular-nums font-semibold">{fmtDecimal(totals.amt(l), 2)}</td>
                      {igst && <td className="td text-right">{inp('gst_rate', 'w-16', 'number')}</td>}
                      <td className="td">{editable && <button type="button" className="text-red-500" onClick={() => set('lines', v.lines.filter((_: any, j: number) => j !== i))}>×</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr className="bg-slate-50 font-semibold"><td className="td" colSpan={7}>Total {cur?.code ?? ''}</td><td className="td text-right tabular-nums" id="ci-total-qty">{fmtNumber(totals.qty)}</td><td className="td" />
                <td className="td text-right tabular-nums" id="ci-total-amount">{fmtDecimal(totals.total, 2)}</td>{igst && <td className="td" />}<td className="td" /></tr></tfoot>
            </table>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Totals & words">
            <div className="grid gap-3 p-4 sm:grid-cols-3">
              <Input label="Total cartons" type="number" value={v.total_cartons} onChange={(e) => set('total_cartons', e.target.value)} />
              <Input label="Total pieces" type="number" value={v.total_pcs} onChange={(e) => set('total_pcs', e.target.value)} />
              <Input label="Pieces unit" value={v.total_pcs_unit} placeholder="PCS / PACKS" onChange={(e) => set('total_pcs_unit', e.target.value)} />
              <Input label="Net weight (kg)" type="number" step="any" value={v.net_weight_kg} onChange={(e) => set('net_weight_kg', e.target.value)} />
              <Input label="Gross weight (kg)" type="number" step="any" value={v.gross_weight_kg} onChange={(e) => set('gross_weight_kg', e.target.value)} />
              <div />
              <Input className="sm:col-span-3" label="Quantity in words" value={v.qty_words} placeholder={detail.data?.words?.qty ?? 'Worked out from the quantity'} onChange={(e) => set('qty_words', e.target.value)} hint="Blank = worked out" />
              <Input className="sm:col-span-3" label="Amount in words" value={v.amount_words} placeholder={detail.data?.words?.amount ?? 'Worked out from the total'} onChange={(e) => set('amount_words', e.target.value)} hint="Blank = worked out" />
            </div>
          </Card>
          <Card title={igst ? 'IGST layout — GST and note' : 'Bank details & REX declaration'}>
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              {!igst && <>
                <Textarea rows={6} label="Our bank details (one per line)" value={v.bank_details} onChange={(e) => set('bank_details', e.target.value)} />
                <Textarea rows={6} label="REX declaration" value={v.rex_declaration} onChange={(e) => set('rex_declaration', e.target.value)} />
              </>}
              {igst && <>
                <Input label="GST % on goods" type="number" step="any" id="ci-goods-gst" value={v.goods_gst_rate} onChange={(e) => set('goods_gst_rate', e.target.value)} />
                <Input label="GST % on charges" type="number" step="any" value={v.charges_gst_rate} onChange={(e) => set('charges_gst_rate', e.target.value)} />
                <Textarea className="sm:col-span-2" rows={2} label="Note (import bond …)" value={v.footer_note} onChange={(e) => set('footer_note', e.target.value)} />
                {T && <div className="text-[12px] sm:col-span-2" id="ci-igst-summary">FOB {cur?.code} {fmtDecimal(T.goods_amount, 2)} → ₹ {fmtDecimal(T.goods_inr, 2)} · GST {v.goods_gst_rate}% ₹ {fmtDecimal(T.goods_gst, 2)}
                  {T.charges_amount ? ` · charges ₹ ${fmtDecimal(T.charges_inr, 2)} · GST ${v.charges_gst_rate}% ₹ ${fmtDecimal(T.charges_gst, 2)}` : ''}</div>}
              </>}
              <Textarea className="sm:col-span-2" rows={3} label="Declaration" value={v.declaration} onChange={(e) => set('declaration', e.target.value)} />
            </div>
          </Card>
        </div>
      </fieldset>

      {preview && <PreviewModal id={Number(id)} format={preview} onFormat={setPreview} onClose={() => setPreview(null)} onPrint={(f) => { setPreview(null); void print(f); }} onExcel={(f) => void excel(f)} />}
      {printLayout && <InvoicePrintPortal layout={printLayout} />}
      <ConfirmDialog open={confirm === 'delete'} title="Delete invoice" message={`Delete ${detail.data?.invoice_no ?? ''}? Its packing lists are released.`} busy={busy} onCancel={() => setConfirm(null)}
        onConfirm={async () => { setBusy(true); try { await http.del(`/commercial-invoices/${id}`); toast('Invoice deleted'); void qc.invalidateQueries({ queryKey: ['commercial-invoices'] }); nav('/export/invoices'); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); } }} />
      <Modal open={confirm === 'reopen'} onClose={() => setConfirm(null)} title="Reopen the invoice" size="sm"
        footer={<><button className="btn-secondary" onClick={() => setConfirm(null)}>Cancel</button><Button loading={busy} disabled={reason.trim().length < 3} onClick={() => void act('reopen', { reason }, 'Invoice reopened')}>Reopen</Button></>}>
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </div>
  );
}

function PreviewModal({ id, format, onFormat, onClose, onPrint, onExcel }: { id: number; format: 'BUYER' | 'IGST'; onFormat: (f: 'BUYER' | 'IGST') => void; onClose: () => void; onPrint: (f: string) => void; onExcel: (f: string) => void }) {
  const q = useQuery({ queryKey: ['commercial-invoice-layout', id, format], queryFn: async () => (await http.get<{ data: any }>(`/commercial-invoices/${id}`, { format })).data });
  return (
    <Modal open onClose={onClose} title="Invoice preview" subtitle="As printed / as the Excel — FK-087 layout" size="full"
      footerStart={<div className="flex gap-1">{(['BUYER', 'IGST'] as const).map((f) => <button key={f} className={clsx('rounded px-2.5 py-1 text-[12px]', f === format ? 'bg-brand-600 text-white' : 'bg-slate-100')} onClick={() => onFormat(f)}>{f === 'BUYER' ? 'Buyer invoice' : 'IGST invoice'}</button>)}</div>}
      footer={<><Button variant="secondary" onClick={() => onExcel(format)}><Download size={14} />Excel</Button><Button onClick={() => onPrint(format)}><Printer size={14} />Print</Button></>}>
      {q.isLoading ? <LoadingBlock rows={10} /> : q.data && <div className="mx-auto max-w-[900px]" id="ci-preview-doc"><PackingListLayout layout={q.data.layout} /></div>}
    </Modal>
  );
}

function InvoicePrintPortal({ layout }: { layout: PlLayout }) {
  return createPortal(
    <div id="ci-print-root">
      <style>{`
        #ci-print-root { display: none; }
        @media print {
          @page { size: A4 portrait; margin: 8mm; }
          body > *:not(#ci-print-root) { display: none !important; }
          #ci-print-root { display: block !important; }
          #ci-print-root .pl-doc { font-size: 9px; }
        }
      `}</style>
      <PackingListLayout layout={layout} />
    </div>,
    document.body,
  );
}

