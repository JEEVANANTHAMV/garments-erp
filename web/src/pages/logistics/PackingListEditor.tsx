import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, Checkbox, DataTable, Input, Modal, Select, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import {
  type BlockS, type ItemS, type PlType, type RowS,
  blocksFromServer, blocksToPayload, calcList, emptyItem, newBlock, newRowAfter, parseHeaders,
  shippedGroups, STANDARD_PRESETS, uid,
} from './packingListModel';
import { PackingListDocument, PackingListPrintPortal } from './PackingListPrint';

const TYPE_COLOR: Record<string, string> = { ASSORTED: 'indigo', SOLID: 'amber', MIXED: 'violet' };
const STATUS_COLOR: Record<string, string> = { DRAFT: 'slate', CONFIRMED: 'emerald', CLOSED: 'gray' };
const TYPE_HELP: Record<PlType, string> = {
  ASSORTED: 'Each carton holds a size ratio (e.g. S1 M2 L3 XL3 XXL2 XXXL1 = 12 pcs/ctn).',
  SOLID: 'One colour in one size per carton (e.g. numeric sizes 36 – 52), grouped per style/colour.',
  MIXED: 'Kids + adult size sets on one list, PCS/PACK × PACK/CTN rows and cartons mixing colours/styles.',
};
const errMsg = (e: any) => e?.message || e?.response?.data?.error?.message || 'Request failed';

/* ============================================================
   PACKING LIST REGISTER
============================================================ */
export function PackingListPage() {
  const [lists, setLists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();
  useEffect(() => { api.get('/packing-lists').then((r) => setLists(r.data.data)).finally(() => setLoading(false)); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Packing Lists</h1>
          <p className="text-sm text-slate-500">Assorted / solid / mixed carton lists with weights, CBM and Order vs Shipped</p>
        </div>
        <Button onClick={() => nav('/logistics/packing-lists/new')}>+ New Packing List</Button>
      </div>
      <Card>
        <DataTable
          data={lists} loading={loading}
          columns={[
            { key: 'pl_no', header: 'PL No', sortable: true, render: (r: any) => (
              <button onClick={() => nav(`/logistics/packing-lists/${r.id}`)} className="font-mono text-xs font-semibold text-brand-700 hover:underline">{r.pl_no}</button>) },
            { key: 'pl_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.pl_date) },
            { key: 'pl_type', header: 'Type', render: (r: any) => <Badge color={TYPE_COLOR[r.pl_type] || 'slate'}>{r.pl_type || 'ASSORTED'}</Badge> },
            { key: 'buyer_order_no', header: 'Buyer PO', render: (r: any) => r.buyer_order_no || '—' },
            { key: 'so_no', header: 'Sales Order', render: (r: any) => r.so_no || '—' },
            { key: 'buyer_name', header: 'Buyer', render: (r: any) => r.buyer_name || '—' },
            { key: 'style_summary', header: 'Styles', render: (r: any) => <span className="text-xs text-slate-600">{r.style_summary || '—'}</span> },
            { key: 'total_cartons', header: 'Cartons (CTNS)', align: 'right' as const, render: (r: any) => fmtNumber(r.total_cartons) },
            { key: 'total_qty', header: 'Qty (PCS)', align: 'right' as const, render: (r: any) => fmtNumber(r.total_qty) },
            { key: 'gross_weight_kg', header: 'Gross (KG)', align: 'right' as const, render: (r: any) => fmtDecimal(r.gross_weight_kg) },
            { key: 'total_cbm', header: 'CBM', align: 'right' as const, render: (r: any) => fmtDecimal(r.total_cbm, 3) },
            { key: 'status', header: 'Status', render: (r: any) => <Badge color={STATUS_COLOR[r.status] || 'slate'}>{r.status}</Badge> },
          ]}
        />
      </Card>
    </div>
  );
}

/* ============================================================
   PACKING LIST DETAIL / EDITOR
============================================================ */
const EMPTY_HEADER = {
  pl_no: '', pl_date: today(), io_no: '', so_id: null as number | null, packing_id: null as number | null,
  invoice_id: null as number | null, buyer_id: null as number | null, consignee_id: null as number | null,
  shipment_type: 'EXPORT', destination: '', pl_type: 'ASSORTED' as PlType, status: 'DRAFT',
  allow_ctn_gaps: false, carton_tare_kg: '' as string | number,
  invoice_no: '', invoice_date: '', buyer_order_no: '', buyer_order_date: '', other_references: '',
  exporter_details: '', consignee_details: '', notify_label: 'Notify Party :-', notify_details: '',
  country_of_origin: 'INDIA', country_of_destination: '', pre_carriage_by: '', place_of_receipt: '',
  vessel_flight_no: '', port_of_loading: '', port_of_discharge: '', final_destination: '',
  terms_of_delivery: '', terms_of_payment: '', remarks: '',
};
type Header = typeof EMPTY_HEADER;

export function PackingListDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const isNew = !id || id === 'new';

  const [header, setHeader] = useState<Header>(EMPTY_HEADER);
  const [sizeHeaders, setSizeHeaders] = useState<string[]>(['S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
  const [blocks, setBlocks] = useState<BlockS[]>([newBlock()]);
  const [manualOrder, setManualOrder] = useState<Record<string, Record<string, string>>>({});
  const [saved, setSaved] = useState<any>(null);            // last server copy (for print / summary / cartons)
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [presets, setPresets] = useState<{ name: string; sizes: string[] }[]>(STANDARD_PRESETS);
  const [showPrint, setShowPrint] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [lk, setLk] = useState<{ so: any[]; packings: any[]; parties: any[]; invoices: any[] }>({ so: [], packings: [], parties: [], invoices: [] });

  const ro = !isNew && header.status !== 'DRAFT';

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-orders'), api.get('/lookups/packings'), api.get('/lookups/parties'),
      api.get('/lookups/commercial-invoices').catch(() => ({ data: { data: [] } })),
    ]).then(([so, pk, pt, ci]) => setLk({ so: so.data.data || [], packings: pk.data.data || [], parties: pt.data.data || [], invoices: ci.data.data || [] }));
  }, []);

  const applyServer = (d: any) => {
    setSaved(d);
    setHeader({
      ...EMPTY_HEADER,
      ...Object.fromEntries(Object.keys(EMPTY_HEADER).map((k) => [k, d[k] ?? (EMPTY_HEADER as any)[k]])),
      pl_date: String(d.pl_date || today()).slice(0, 10),
      invoice_date: d.invoice_date ? String(d.invoice_date).slice(0, 10) : '',
      buyer_order_date: d.buyer_order_date ? String(d.buyer_order_date).slice(0, 10) : '',
      allow_ctn_gaps: Boolean(d.allow_ctn_gaps),
      carton_tare_kg: d.carton_tare_kg ?? '',
    } as Header);
    const sh = parseHeaders(d.size_headers);
    if (sh?.length) setSizeHeaders(sh);
    setBlocks(d.blocks?.length ? blocksFromServer(d.blocks) : [newBlock()]);
    const mo: Record<string, Record<string, string>> = {};
    for (const g of d.order_summary || []) if (g.order_source === 'MANUAL') mo[g.group_key] = Object.fromEntries(Object.entries(g.order).map(([k, v]) => [k, String(v)]));
    setManualOrder(mo);
    setDirty(false);
    setServerErrors([]);
  };

  useEffect(() => {
    if (isNew) {
      api.get('/packing-lists/prefill').then((r) => {
        setPresets(r.data.data.size_presets || STANDARD_PRESETS);
        setHeader((h) => ({ ...h, exporter_details: h.exporter_details || r.data.data.exporter_details || '' }));
      }).catch(() => {});
      return;
    }
    api.get(`/packing-lists/${id}`).then((r) => applyServer(r.data.data)).catch((e) => toast(errMsg(e), 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew]);

  const setField = (k: keyof Header, v: any) => { setHeader((p) => ({ ...p, [k]: v })); setDirty(true); };
  const mutateBlocks = (fn: (b: BlockS[]) => BlockS[]) => { setBlocks((prev) => fn(structuredClone(prev))); setDirty(true); };

  const calc = useMemo(() => calcList(header.pl_type, sizeHeaders, blocks), [header.pl_type, sizeHeaders, blocks]);
  const groups = useMemo(() => shippedGroups(blocks, calc), [blocks, calc]);
  const serverGroup = (key: string) => (saved?.order_summary || []).find((g: any) => g.group_key === key);

  /* ---------- sales order prefill */
  const fillFromSo = async (soId: number | null, onlyEmpty = true) => {
    if (!soId) return;
    try {
      const r = await api.get('/packing-lists/prefill', { params: { so_id: soId } });
      const d = r.data.data;
      setPresets(d.size_presets || STANDARD_PRESETS);
      setHeader((h) => {
        const next: any = { ...h };
        for (const k of ['io_no', 'buyer_id', 'consignee_id', 'buyer_order_no', 'buyer_order_date', 'port_of_loading', 'port_of_discharge',
                         'country_of_destination', 'final_destination', 'terms_of_delivery', 'terms_of_payment', 'consignee_details', 'shipment_type', 'exporter_details']) {
          if (d[k] != null && d[k] !== '' && (!onlyEmpty || !next[k])) next[k] = d[k];
        }
        return next;
      });
      setDirty(true);
      toast('Header filled from the sales order');
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  /* ---------- build rows from the physical cartons of the linked packing */
  const buildFromPacking = async () => {
    if (!header.packing_id) return;
    const hasRows = blocks.some((b) => b.rows.some((r) => r.items.some((it) => Object.values(it.size_qty).some((v) => Number(v) > 0))));
    if (hasRows && !window.confirm('Replace the current carton rows with rows built from the packing cartons?')) return;
    try {
      const r = await api.get('/packing-lists/build-rows', { params: { packing_id: header.packing_id } });
      const d = r.data.data;
      setSizeHeaders(d.size_headers);
      setBlocks(blocksFromServer(d.blocks));
      setHeader((h) => ({ ...h, pl_type: d.pl_type }));
      setDirty(true);
      toast(`Built ${d.blocks[0].rows.length} carton range(s) from the packing${d.empty_cartons ? ` (${d.empty_cartons} empty carton(s) skipped)` : ''}`);
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  /* ---------- save */
  const payload = () => ({
    ...header,
    pl_no: header.pl_no || null,
    carton_tare_kg: header.carton_tare_kg === '' ? null : Number(header.carton_tare_kg),
    size_headers: sizeHeaders,
    blocks: blocksToPayload(blocks, sizeHeaders),
    manual_order_qty: Object.entries(manualOrder).flatMap(([group_key, m]) =>
      Object.entries(m).filter(([, v]) => v !== '' && Number(v) > 0).map(([size_label, v]) => ({ group_key, size_label, order_qty: Number(v) }))),
  });
  const handleSave = async () => {
    setSaving(true); setServerErrors([]);
    try {
      const body = payload();
      const r = isNew ? await api.post('/packing-lists', body) : await api.put(`/packing-lists/${id}`, body);
      const warnings: string[] = r.data.warnings || [];
      toast(isNew ? 'Packing list created' : 'Packing list saved');
      if (warnings.length) toast(warnings.join('; '), 'warning');
      if (isNew) nav(`/logistics/packing-lists/${r.data.data.id}`, { replace: true });
      else applyServer(r.data.data);
    } catch (e: any) {
      const details = Array.isArray(e?.details) ? e.details.map((d: any) => d.message).filter(Boolean) : [];
      setServerErrors(details.length ? details : [errMsg(e)]);
      toast(errMsg(e), 'error');
    } finally { setSaving(false); }
  };
  const handleConfirm = async () => {
    if (dirty) { toast('Save your changes before confirming', 'warning'); return; }
    if (!window.confirm('Confirm and freeze this packing list? It can no longer be edited afterwards.')) return;
    try { const r = await api.post(`/packing-lists/${id}/confirm`); applyServer(r.data.data); toast('Packing list confirmed and frozen'); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  const handleReopen = async () => {
    try { const r = await api.post(`/packing-lists/${id}/reopen`, { reason: reopenReason }); applyServer(r.data.data); setReopenOpen(false); setReopenReason(''); toast('Packing list re-opened for correction'); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  const handleExcel = async () => {
    try {
      const r = await api.get(`/packing-lists/${id}/export.xlsx`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      const a = document.createElement('a'); a.href = url; a.download = `${header.pl_no || 'packing-list'}_${header.pl_type}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const handlePrint = () => { setShowPrint(false); setTimeout(() => window.print(), 50); };

  /* ---------- row / block editing helpers */
  const updRow = (bi: number, ri: number, patch: Partial<RowS>) => mutateBlocks((b) => { Object.assign(b[bi].rows[ri], patch); return b; });
  const updItem = (bi: number, ri: number, ii: number, patch: Partial<ItemS>) => mutateBlocks((b) => { Object.assign(b[bi].rows[ri].items[ii], patch); return b; });
  const setQty = (bi: number, ri: number, ii: number, size: string, v: string) => mutateBlocks((b) => {
    const it = b[bi].rows[ri].items[ii];
    if (header.pl_type === 'SOLID' && v !== '' && Number(v) > 0) it.size_qty = {};   // one size per carton
    it.size_qty[size] = v.replace(/[^0-9]/g, '');
    return b;
  });
  const addRow = (bi: number, afterRi?: number) => mutateBlocks((b) => {
    const rows = b[bi].rows; const at = afterRi == null ? rows.length : afterRi + 1;
    rows.splice(at, 0, newRowAfter(rows[at - 1] ?? b[bi - 1]?.rows.at(-1)));
    return b;
  });
  const dupRow = (bi: number, ri: number) => mutateBlocks((b) => {
    const src = b[bi].rows[ri];
    b[bi].rows.splice(ri + 1, 0, { ...structuredClone(src), key: uid(), ctn_from: '', source_carton_ids: null, items: src.items.map((it) => ({ ...structuredClone(it), key: uid() })) });
    return b;
  });
  const delRow = (bi: number, ri: number) => mutateBlocks((b) => { b[bi].rows.splice(ri, 1); return b; });
  const moveRow = (bi: number, ri: number, d: -1 | 1) => mutateBlocks((b) => {
    const rows = b[bi].rows; const j = ri + d; if (j < 0 || j >= rows.length) return b;
    [rows[ri], rows[j]] = [rows[j], rows[ri]]; return b;
  });
  const addItem = (bi: number, ri: number) => mutateBlocks((b) => { const r = b[bi].rows[ri]; r.items.push(emptyItem({ order_no: r.items[0]?.order_no })); return b; });
  const delItem = (bi: number, ri: number, ii: number) => mutateBlocks((b) => { b[bi].rows[ri].items.splice(ii, 1); return b; });
  const grossChanged = (bi: number, ri: number, v: string) => mutateBlocks((b) => {
    const r = b[bi].rows[ri];
    const prevAuto = header.carton_tare_kg !== '' && r.gross_wt_per_ctn !== '' &&
      Math.abs(Number(r.gross_wt_per_ctn) - Number(header.carton_tare_kg) - Number(r.net_wt_per_ctn)) < 1e-9;
    r.gross_wt_per_ctn = v;
    if (header.carton_tare_kg !== '' && v !== '' && (r.net_wt_per_ctn === '' || prevAuto)) {
      r.net_wt_per_ctn = String(Math.max(0, Math.round((Number(v) - Number(header.carton_tare_kg)) * 1000) / 1000));
    }
    return b;
  });

  const soOptions = [{ value: '', label: '— None —' }, ...lk.so.map((s: any) => ({ value: s.id, label: s.label || s.code }))];
  const partyOptions = [{ value: '', label: '— Select —' }, ...lk.parties.map((s: any) => ({ value: s.id, label: s.label || s.code }))];

  return (
    <div className="space-y-5">
      {/* ---------- title bar */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{isNew ? 'New Packing List' : `Packing List — ${header.pl_no}`}</h1>
          <p className="text-sm text-slate-500">{TYPE_HELP[header.pl_type]}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => nav('/logistics/packing-lists')}>← Back</Button>
          {!isNew && <Button variant="outline" onClick={() => setShowPrint(true)} disabled={dirty} title={dirty ? 'Save first' : ''}>Print view</Button>}
          {!isNew && <Button variant="outline" onClick={handleExcel} disabled={dirty || !saved?.blocks?.length} title={dirty ? 'Save first' : ''}>Download Excel</Button>}
          {!isNew && header.status === 'DRAFT' && <Button variant="outline" onClick={handleConfirm}>✓ Confirm &amp; Freeze</Button>}
          {!isNew && header.status === 'CONFIRMED' && <Button variant="outline" onClick={() => setReopenOpen(true)}>Re-open</Button>}
          {!ro && <Button onClick={handleSave} loading={saving}>{dirty || isNew ? 'Save' : 'Saved'}</Button>}
        </div>
      </div>

      {!isNew && (
        <div className="no-print flex flex-wrap items-center gap-2">
          <Badge color={STATUS_COLOR[header.status] || 'slate'} size="lg">{header.status}</Badge>
          <Badge color={TYPE_COLOR[header.pl_type]} size="lg">{header.pl_type}</Badge>
          {header.shipment_type === 'EXPORT' && <Badge color="blue" size="lg">EXPORT</Badge>}
          {saved?.confirmed_at && <span className="text-xs text-slate-500">Confirmed {fmtDate(saved.confirmed_at)} by {saved.confirmed_by_name || '—'}</span>}
          {saved?.reopen_reason && header.status === 'DRAFT' && <span className="text-xs text-amber-700">Re-opened: {saved.reopen_reason}</span>}
          {dirty && <span className="text-xs font-medium text-amber-700">Unsaved changes</span>}
        </div>
      )}

      {serverErrors.length > 0 && (
        <div className="no-print rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="mb-1 font-semibold">The packing list could not be saved:</div>
          <ul className="list-disc pl-5">{serverErrors.slice(0, 20).map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}

      {/* ---------- general */}
      <Card title="Packing list">
        <fieldset disabled={ro} className="grid grid-cols-1 gap-4 p-4 md:grid-cols-4">
          <Input label="PL No" value={header.pl_no} onChange={(e) => setField('pl_no', e.target.value)} placeholder="Auto-generate" disabled={!isNew} />
          <Input label="Date" type="date" value={header.pl_date} onChange={(e) => setField('pl_date', e.target.value)} />
          <Select label="Packing list type" value={header.pl_type} onChange={(e) => setField('pl_type', e.target.value as PlType)}
            options={[{ value: 'ASSORTED', label: 'Assorted — size ratio per carton' }, { value: 'SOLID', label: 'Solid — one size per carton' }, { value: 'MIXED', label: 'Mixed — size sets / packs / mixed cartons' }]} />
          <Select label="Shipment type" value={header.shipment_type} onChange={(e) => setField('shipment_type', e.target.value)}
            options={[{ value: 'EXPORT', label: 'Export' }, { value: 'DOMESTIC', label: 'Domestic' }]} />
          <div className="flex items-end gap-2">
            <Select className="flex-1" label="Sales order" value={header.so_id ?? ''} options={soOptions}
              onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; setField('so_id', v); if (v && isNew) fillFromSo(v); }} />
            {!ro && header.so_id && <Button variant="outline" size="sm" onClick={() => fillFromSo(header.so_id, false)} title="Overwrite header fields from the sales order">↻</Button>}
          </div>
          <Select label="Source packing (cartons)" value={header.packing_id ?? ''}
            onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; const p = lk.packings.find((x: any) => x.id === v);
              setHeader((h) => ({ ...h, packing_id: v, so_id: h.so_id ?? p?.so_id ?? null })); setDirty(true); }}
            options={[{ value: '', label: '— None —' }, ...lk.packings.map((p: any) => ({ value: p.id, label: p.label || p.code }))]} />
          <Input label="I/O No" value={header.io_no || ''} onChange={(e) => setField('io_no', e.target.value)} />
          <Select label="Buyer" value={header.buyer_id ?? ''} options={partyOptions} onChange={(e) => setField('buyer_id', e.target.value ? Number(e.target.value) : null)} />
        </fieldset>
      </Card>

      {/* ---------- export document header */}
      <Card title="Export document header" subtitle="Printed at the top of the packing list, as on the buyer copy">
        <fieldset disabled={ro} className="grid grid-cols-1 gap-4 p-4 md:grid-cols-4">
          <Textarea className="md:col-span-2" label="Exporter" rows={4} value={header.exporter_details} onChange={(e) => setField('exporter_details', e.target.value)} />
          <div className="grid grid-cols-2 gap-3 md:col-span-2">
            <Input label="Invoice no" value={header.invoice_no} onChange={(e) => setField('invoice_no', e.target.value)} />
            <Input label="Invoice date" type="date" value={header.invoice_date} onChange={(e) => setField('invoice_date', e.target.value)} />
            <Input label="Buyer order (PO) no" value={header.buyer_order_no} onChange={(e) => setField('buyer_order_no', e.target.value)} />
            <Input label="Buyer order date" type="date" value={header.buyer_order_date} onChange={(e) => setField('buyer_order_date', e.target.value)} />
            <Select className="col-span-2" label="Commercial invoice (optional link)" value={header.invoice_id ?? ''}
              onChange={(e) => setField('invoice_id', e.target.value ? Number(e.target.value) : null)}
              options={[{ value: '', label: '— None —' }, ...lk.invoices.map((c: any) => ({ value: c.id, label: c.label || c.code }))]} />
          </div>
          <Textarea className="md:col-span-2" label="Consignee" rows={4} value={header.consignee_details} onChange={(e) => setField('consignee_details', e.target.value)} />
          <div className="space-y-2 md:col-span-2">
            <div className="grid grid-cols-2 gap-3">
              <Select label="Right-hand box" value={header.notify_label} onChange={(e) => setField('notify_label', e.target.value)}
                options={[{ value: 'Notify Party :-', label: 'Notify Party' }, { value: 'Goods Delivery address', label: 'Goods Delivery address' }]} />
              <Select label="Consignee party (optional)" value={header.consignee_id ?? ''} options={partyOptions} onChange={(e) => setField('consignee_id', e.target.value ? Number(e.target.value) : null)} />
            </div>
            <Textarea rows={2} value={header.notify_details} onChange={(e) => setField('notify_details', e.target.value)} placeholder="Notify party / delivery address" />
          </div>
          <Input label="Other reference(s)" className="md:col-span-2" value={header.other_references} onChange={(e) => setField('other_references', e.target.value)} />
          <Input label="Country of origin" value={header.country_of_origin} onChange={(e) => setField('country_of_origin', e.target.value)} />
          <Input label="Country of final destination" value={header.country_of_destination} onChange={(e) => setField('country_of_destination', e.target.value)} />
          <Input label="Pre-carriage by" value={header.pre_carriage_by} onChange={(e) => setField('pre_carriage_by', e.target.value)} />
          <Input label="Place of receipt by pre-carrier" value={header.place_of_receipt} onChange={(e) => setField('place_of_receipt', e.target.value)} />
          <Input label="Vessel / Flight no" value={header.vessel_flight_no} onChange={(e) => setField('vessel_flight_no', e.target.value)} placeholder="BY SEA / BY AIR" />
          <Input label="Port of loading" value={header.port_of_loading} onChange={(e) => setField('port_of_loading', e.target.value)} />
          <Input label="Port of discharge" value={header.port_of_discharge} onChange={(e) => setField('port_of_discharge', e.target.value)} />
          <Input label="Final destination" value={header.final_destination} onChange={(e) => setField('final_destination', e.target.value)} />
          <Textarea className="md:col-span-2" rows={2} label="Terms of delivery" value={header.terms_of_delivery} onChange={(e) => setField('terms_of_delivery', e.target.value)} />
          <Textarea className="md:col-span-2" rows={2} label="Terms of payment" value={header.terms_of_payment} onChange={(e) => setField('terms_of_payment', e.target.value)} />
        </fieldset>
      </Card>

      {/* ---------- size headers + options */}
      <Card title="Size columns & carton options">
        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-4">
          <div className="md:col-span-3">
            <SizeHeaderEditor value={sizeHeaders} onChange={(v) => { setSizeHeaders(v); setDirty(true); }} presets={presets} disabled={ro} />
          </div>
          <fieldset disabled={ro} className="space-y-3">
            <Input label="Carton tare (KG) — net = gross − tare" type="number" step="0.001" min="0" value={header.carton_tare_kg}
              onChange={(e) => setField('carton_tare_kg', e.target.value)} placeholder="e.g. 1.1" />
            <Checkbox label="Allow carton-number gaps" checked={header.allow_ctn_gaps} onChange={(v) => setField('allow_ctn_gaps', v)} disabled={ro} />
            {!ro && header.packing_id && <Button variant="outline" size="sm" onClick={buildFromPacking}>Build rows from packing cartons</Button>}
          </fieldset>
        </div>
      </Card>

      {/* ---------- carton rows */}
      {blocks.map((b, bi) => (
        <BlockEditor key={b.key} block={b} bi={bi} ro={ro} plType={header.pl_type} calc={calc.blocks[bi]} listHeaders={sizeHeaders} presets={presets}
          onLabel={(v) => mutateBlocks((x) => { x[bi].label = v; return x; })}
          onHeaders={(v) => mutateBlocks((x) => { x[bi].size_headers = v; return x; })}
          onRemove={blocks.length > 1 ? () => mutateBlocks((x) => { x.splice(bi, 1); return x; }) : undefined}
          updRow={updRow} updItem={updItem} setQty={setQty} addRow={addRow} dupRow={dupRow} delRow={delRow} moveRow={moveRow}
          addItem={addItem} delItem={delItem} grossChanged={grossChanged} />
      ))}
      {!ro && (
        <div className="no-print">
          <Button variant="outline" onClick={() => mutateBlocks((x) => [...x, { ...newBlock(), rows: [newRowAfter(x.at(-1)?.rows.at(-1))] }])}>
            + Add block (new style / colour / size set)
          </Button>
        </div>
      )}

      {/* ---------- grand totals */}
      <Card title="Grand total" subtitle={dirty ? 'Live preview — the server recomputes on save' : 'As saved'}>
        <div className="grid grid-cols-2 gap-4 p-4 text-center md:grid-cols-6">
          <Stat label="Cartons" value={`${fmtNumber(calc.totals.ctns)} CTNS`} />
          <Stat label="Pieces" value={`${fmtNumber(calc.totals.qty)} PCS`} tone="text-blue-700" />
          <Stat label="Net weight" value={`${fmtDecimal(calc.totals.net, 2)} KG`} />
          <Stat label="Gross weight" value={`${fmtDecimal(calc.totals.gross, 2)} KG`} />
          <Stat label="Volume" value={`${fmtDecimal(calc.totals.cbm, 3)} CBM`} />
          <Stat label="Row issues" value={String(calc.issueCount)} tone={calc.issueCount ? 'text-red-600' : 'text-emerald-600'} />
        </div>
        {!dirty && saved?.measurements?.length > 0 && (
          <div className="border-t border-surface-border px-4 py-2 text-xs text-slate-600">
            Carton measurement: {saved.measurements.map((m: any) => `${m.dims} CM - ${m.cartons} CTNS`).join(' / ')}
          </div>
        )}
      </Card>

      {/* ---------- order vs shipped */}
      <Card title="Order qty / Shipped qty / Diff (PCS)"
        subtitle="Order qty comes from the sales order size breakdown when it matches the style & colour; otherwise enter it here. Diff = Order − Shipped.">
        <div className="space-y-4 overflow-x-auto p-4">
          {groups.length === 0 && <p className="text-sm text-slate-500">No carton rows yet.</p>}
          {groups.map((g) => {
            const sg = serverGroup(g.key);
            const fromSo = sg?.order_source === 'SALES_ORDER' && !dirty;
            const sizes = [...g.sizes, ...((sg?.sizes || []) as string[]).filter((s) => !g.sizes.includes(s))];
            const order = (s: string) => (fromSo ? Number(sg.order[s] || 0) : Number(manualOrder[g.key]?.[s] || 0));
            const orderTotal = sizes.reduce((a, s) => a + order(s), 0);
            return (
              <table key={g.key} className="min-w-max border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="border px-2 py-1 text-left">{g.label || '—'} {fromSo && <Badge color="emerald">from sales order</Badge>}</th>
                    {sizes.map((s) => <th key={s} className="w-16 border px-2 py-1">{s}</th>)}
                    <th className="border px-2 py-1">TOTAL</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border px-2 py-1 font-medium">ORDER Qty</td>
                    {sizes.map((s) => (
                      <td key={s} className="border px-1 py-0.5 text-right">
                        {fromSo || ro ? fmtNumber(order(s)) : (
                          <input className="w-14 rounded border border-slate-200 px-1 text-right" inputMode="numeric"
                            value={manualOrder[g.key]?.[s] ?? ''}
                            onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ''); setManualOrder((m) => ({ ...m, [g.key]: { ...(m[g.key] || {}), [s]: v } })); setDirty(true); }} />
                        )}
                      </td>
                    ))}
                    <td className="border px-2 py-1 text-right font-semibold">{fmtNumber(orderTotal)}</td>
                  </tr>
                  <tr>
                    <td className="border px-2 py-1 font-medium">Shipped Qty</td>
                    {sizes.map((s) => <td key={s} className="border px-2 py-1 text-right">{fmtNumber(g.shipped[s] || 0)}</td>)}
                    <td className="border px-2 py-1 text-right font-semibold">{fmtNumber(g.total)}</td>
                  </tr>
                  <tr>
                    <td className="border px-2 py-1 font-medium">Diff</td>
                    {sizes.map((s) => { const d = order(s) - (g.shipped[s] || 0); return <td key={s} className={`border px-2 py-1 text-right ${d ? (d > 0 ? 'text-amber-700' : 'text-red-600') : 'text-slate-400'}`}>{fmtNumber(d)}</td>; })}
                    <td className="border px-2 py-1 text-right font-semibold">{fmtNumber(orderTotal - g.total)}</td>
                  </tr>
                </tbody>
              </table>
            );
          })}
        </div>
      </Card>

      {/* ---------- physical cartons of the linked packing (read-only) */}
      {saved?.cartons?.length > 0 && (
        <Card title={`Cartons in linked packing ${saved.pack_no || ''} (${saved.cartons.length})`}>
          <div className="max-h-72 overflow-y-auto p-4">
            <table className="w-full text-xs">
              <thead className="border-b text-slate-500"><tr><th className="pb-1 text-left">Carton</th><th className="pb-1 text-left">Sizes (PCS)</th><th className="pb-1 text-right">Net (KG)</th><th className="pb-1 text-right">Gross (KG)</th><th className="pb-1 text-right">CBM</th></tr></thead>
              <tbody>{saved.cartons.map((c: any) => (
                <tr key={c.id} className="border-b border-slate-50"><td className="py-1 font-mono">{c.carton_no}</td><td>{c.size_summary || '—'}</td>
                  <td className="text-right">{fmtDecimal(c.net_weight_kg)}</td><td className="text-right">{fmtDecimal(c.gross_weight_kg)}</td><td className="text-right">{fmtDecimal(c.cbm, 3)}</td></tr>))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ---------- print preview + print portal */}
      <Modal open={showPrint} onClose={() => setShowPrint(false)} title="Packing list — print view" size="full"
        footer={<><Button variant="ghost" onClick={() => setShowPrint(false)}>Close</Button><Button variant="outline" onClick={handleExcel}>Download Excel</Button><Button onClick={handlePrint}>Print</Button></>}>
        {saved && <PackingListDocument pl={saved} />}
      </Modal>
      {saved && <PackingListPrintPortal pl={saved} />}

      <Modal open={reopenOpen} onClose={() => setReopenOpen(false)} title="Re-open confirmed packing list" size="sm"
        footer={<><Button variant="ghost" onClick={() => setReopenOpen(false)}>Cancel</Button><Button variant="danger" onClick={handleReopen} disabled={!reopenReason.trim()}>Re-open</Button></>}>
        <p className="mb-3 text-sm text-slate-600">The list goes back to DRAFT so it can be corrected. Not possible once a shipment uses it. The reason is kept in the audit trail.</p>
        <Textarea label="Reason" required value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
      </Modal>
    </div>
  );
}

function Stat({ label, value, tone = 'text-slate-800' }: { label: string; value: string; tone?: string }) {
  return <div><p className={`text-xl font-bold ${tone}`}>{value}</p><p className="text-xs text-slate-500">{label}</p></div>;
}

/* ============================================================
   SIZE HEADER EDITOR — ordered, editable list of size columns
============================================================ */
function SizeHeaderEditor({ value, onChange, presets, disabled, compact }: {
  value: string[]; onChange: (v: string[]) => void; presets: { name: string; sizes: string[] }[]; disabled?: boolean; compact?: boolean;
}) {
  const [add, setAdd] = useState('');
  const push = () => {
    const parts = add.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toUpperCase() === p.toUpperCase())) next.push(p);
    onChange(next); setAdd('');
  };
  const move = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= value.length) return; const n = [...value]; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  return (
    <div className="space-y-2">
      {!compact && <div className="label">Size columns (in print order)</div>}
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((s, i) => (
          <span key={s} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-xs font-semibold text-slate-700">
            {!disabled && <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => move(i, -1)} aria-label={`Move ${s} left`}>‹</button>}
            {s}
            {!disabled && <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => move(i, 1)} aria-label={`Move ${s} right`}>›</button>}
            {!disabled && <button type="button" className="ml-0.5 text-red-400 hover:text-red-600" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${s}`}>×</button>}
          </span>
        ))}
        {!disabled && (
          <>
            <input className="input h-7 w-32 py-0 text-xs" placeholder="Add e.g. 3XL or 36,38" value={add}
              onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); push(); } }} />
            <Button size="sm" variant="outline" onClick={push} disabled={!add.trim()}>Add</Button>
            <select className="input h-7 !w-auto max-w-xs py-0 text-xs" value="" onChange={(e) => { const p = presets[Number(e.target.value)]; if (p) onChange([...p.sizes]); }}>
              <option value="">Preset…</option>
              {presets.map((p, i) => <option key={i} value={i}>{p.name} ({p.sizes.join(', ')})</option>)}
            </select>
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   BLOCK EDITOR — spreadsheet-like carton rows
============================================================ */
function BlockEditor(p: {
  block: BlockS; bi: number; ro: boolean; plType: PlType; calc: ReturnType<typeof calcList>['blocks'][number];
  listHeaders: string[]; presets: { name: string; sizes: string[] }[];
  onLabel: (v: string) => void; onHeaders: (v: string[] | null) => void; onRemove?: () => void;
  updRow: (bi: number, ri: number, patch: Partial<RowS>) => void;
  updItem: (bi: number, ri: number, ii: number, patch: Partial<ItemS>) => void;
  setQty: (bi: number, ri: number, ii: number, size: string, v: string) => void;
  addRow: (bi: number, afterRi?: number) => void; dupRow: (bi: number, ri: number) => void; delRow: (bi: number, ri: number) => void;
  moveRow: (bi: number, ri: number, d: -1 | 1) => void;
  addItem: (bi: number, ri: number) => void; delItem: (bi: number, ri: number, ii: number) => void;
  grossChanged: (bi: number, ri: number, v: string) => void;
}) {
  const { block: b, bi, ro, plType, calc: c } = p;
  const heads = c.headers;
  const mixed = plType === 'MIXED';
  const cellIn = 'w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs focus:border-brand-400 focus:bg-white focus:outline-none disabled:text-slate-700';
  const numIn = cellIn + ' text-right tabular-nums';
  const th = 'border border-slate-200 bg-slate-50 px-1 py-1 text-[10px] font-semibold uppercase text-slate-600';
  const td = 'border border-slate-200 p-0 align-middle';
  const tdN = 'border border-slate-200 px-1 text-right text-xs tabular-nums text-slate-700';

  return (
    <Card title={
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-800">Block {bi + 1}</span>
        <input className="input h-7 w-72 py-0 text-xs" disabled={ro} placeholder="Block label e.g. H26 VANPUR T SHIRT MARINE / Product Code" value={b.label}
          onChange={(e) => p.onLabel(e.target.value)} />
        <span className="text-xs text-slate-500">{fmtNumber(c.ctns)} CTNS · {fmtNumber(c.qty)} PCS · {fmtDecimal(c.net, 2)} / {fmtDecimal(c.gross, 2)} KG</span>
      </div>}
      actions={!ro && (
        <div className="flex items-center gap-2">
          <Checkbox label="Own size columns" checked={Boolean(b.size_headers)} onChange={(v) => p.onHeaders(v ? [...p.listHeaders] : null)} />
          {p.onRemove && <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Remove block ${bi + 1} and its rows?`)) p.onRemove!(); }}>Remove block</Button>}
        </div>
      )}>
      {b.size_headers && (
        <div className="border-b border-surface-border px-4 py-2">
          <SizeHeaderEditor compact value={b.size_headers} onChange={(v) => p.onHeaders(v)} presets={p.presets} disabled={ro} />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-max border-collapse">
          <thead>
            <tr>
              <th className={th} colSpan={2}>Carton no</th>
              <th className={th}>Ctns</th>
              <th className={th}>Order no</th>
              <th className={th}>Style no</th>
              <th className={th}>Style name</th>
              <th className={th}>Colour</th>
              {heads.map((h) => <th key={h} className={th + ' w-12'}>{h}</th>)}
              {mixed && <th className={th}>Pcs / pack</th>}
              {mixed && <th className={th}>Packs / ctn</th>}
              <th className={th}>Pcs / ctn</th>
              <th className={th}>Total PCS</th>
              <th className={th}>Net / ctn KG</th>
              <th className={th}>Gross / ctn KG</th>
              <th className={th}>Total net KG</th>
              <th className={th}>Total gross KG</th>
              <th className={th}>L × W × H CM</th>
              {!ro && <th className={th} />}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, ri) => {
              const rc = c.rows[ri];
              const span = r.items.length;
              const bad = rc.issues.length > 0;
              return r.items.map((it, ii) => (
                <tr key={`${r.key}-${it.key}`} className={bad ? 'bg-red-50/60' : ii > 0 ? 'bg-violet-50/40' : ''} title={rc.issues.join('\n')}>
                  {ii === 0 && <>
                    <td className={td + ' w-14'} rowSpan={span}>
                      <input className={numIn} disabled={ro} inputMode="numeric" value={r.ctn_from} placeholder={String(rc.ctn_from)}
                        onChange={(e) => p.updRow(bi, ri, { ctn_from: e.target.value.replace(/[^0-9]/g, '') })} title="Blank = continue from the previous row" />
                    </td>
                    <td className={tdN + ' w-14 text-slate-500'} rowSpan={span}>– {rc.ctn_to}</td>
                    <td className={td + ' w-14'} rowSpan={span}>
                      <input className={numIn} disabled={ro} inputMode="numeric" value={r.no_of_ctns} onChange={(e) => p.updRow(bi, ri, { no_of_ctns: e.target.value.replace(/[^0-9]/g, '') })} />
                    </td>
                  </>}
                  <td className={td + ' w-24'}><input className={cellIn} disabled={ro} value={it.order_no} onChange={(e) => p.updItem(bi, ri, ii, { order_no: e.target.value })} /></td>
                  <td className={td + ' w-28'}><input className={cellIn} disabled={ro} value={it.style_no} onChange={(e) => p.updItem(bi, ri, ii, { style_no: e.target.value, style_id: null })} /></td>
                  <td className={td + ' w-40'}><input className={cellIn} disabled={ro} value={it.style_name} onChange={(e) => p.updItem(bi, ri, ii, { style_name: e.target.value })} /></td>
                  <td className={td + ' w-28'}><input className={cellIn} disabled={ro} value={it.colour} onChange={(e) => p.updItem(bi, ri, ii, { colour: e.target.value, color_id: null })} /></td>
                  {heads.map((h) => (
                    <td key={h} className={td + ' w-12'}>
                      <input className={numIn} disabled={ro} inputMode="numeric" value={it.size_qty[h] ?? ''} onChange={(e) => p.setQty(bi, ri, ii, h, e.target.value)} />
                    </td>
                  ))}
                  {mixed && <td className={tdN}>{rc.packed ? rc.itemUnits[ii] : ''}</td>}
                  {ii === 0 && <>
                    {mixed && (
                      <td className={td + ' w-14'} rowSpan={span}>
                        <input className={numIn} disabled={ro} inputMode="numeric" placeholder="—" value={r.packs_per_ctn} onChange={(e) => p.updRow(bi, ri, { packs_per_ctn: e.target.value.replace(/[^0-9]/g, '') })} />
                      </td>
                    )}
                    <td className={tdN + ' font-semibold'} rowSpan={span}>{rc.packed ? <span title={`${rc.pcs_per_pack} pcs/pack × ${r.packs_per_ctn} packs`}>{rc.pcs_per_ctn}</span> : rc.pcs_per_ctn}</td>
                    <td className={tdN + ' font-semibold text-blue-700'} rowSpan={span}>{fmtNumber(rc.total_qty)}</td>
                    <td className={td + ' w-16'} rowSpan={span}>
                      <input className={numIn} disabled={ro} inputMode="decimal" value={r.net_wt_per_ctn} onChange={(e) => p.updRow(bi, ri, { net_wt_per_ctn: e.target.value.replace(/[^0-9.]/g, '') })} />
                    </td>
                    <td className={td + ' w-16'} rowSpan={span}>
                      <input className={numIn} disabled={ro} inputMode="decimal" value={r.gross_wt_per_ctn} onChange={(e) => p.grossChanged(bi, ri, e.target.value.replace(/[^0-9.]/g, ''))} />
                    </td>
                    <td className={tdN} rowSpan={span}>{fmtDecimal(rc.total_net, 2)}</td>
                    <td className={tdN} rowSpan={span}>{fmtDecimal(rc.total_gross, 2)}</td>
                    <td className={td + ' w-32'} rowSpan={span}>
                      <div className="flex items-center">
                        {(['length_cm', 'width_cm', 'height_cm'] as const).map((k, i) => (
                          <span key={k} className="flex items-center">
                            {i > 0 && <span className="text-[10px] text-slate-400">×</span>}
                            <input className={numIn + ' w-10'} disabled={ro} inputMode="decimal" value={r[k]} onChange={(e) => p.updRow(bi, ri, { [k]: e.target.value.replace(/[^0-9.]/g, '') } as any)} />
                          </span>
                        ))}
                      </div>
                    </td>
                  </>}
                  {!ro && (
                    <td className="border border-slate-200 px-1 text-[11px] whitespace-nowrap">
                      {ii === 0 ? (
                        <span className="flex items-center gap-1.5 text-slate-500">
                          <Badge color={TYPE_COLOR[rc.inferred]} className="!px-1 !py-0 text-[9px]">{rc.inferred[0]}</Badge>
                          <button type="button" className="hover:text-slate-800" title="Move up" onClick={() => p.moveRow(bi, ri, -1)}>↑</button>
                          <button type="button" className="hover:text-slate-800" title="Move down" onClick={() => p.moveRow(bi, ri, 1)}>↓</button>
                          <button type="button" className="hover:text-brand-700" title="Insert row below" onClick={() => p.addRow(bi, ri)}>＋</button>
                          <button type="button" className="hover:text-brand-700" title="Duplicate row" onClick={() => p.dupRow(bi, ri)}>⧉</button>
                          {mixed && <button type="button" className="hover:text-violet-700" title="Add item line (another colour / style in the same carton)" onClick={() => p.addItem(bi, ri)}>+line</button>}
                          <button type="button" className="text-red-400 hover:text-red-600" title="Delete row" onClick={() => p.delRow(bi, ri)}>✕</button>
                        </span>
                      ) : (
                        <button type="button" className="text-red-400 hover:text-red-600" title="Remove item line" onClick={() => p.delItem(bi, ri, ii)}>✕ line</button>
                      )}
                    </td>
                  )}
                </tr>
              ));
            })}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-semibold">
              <td className="border border-slate-200 px-1 text-xs" colSpan={2}>Sub-total</td>
              <td className={tdN}>{fmtNumber(c.ctns)}</td>
              <td className="border border-slate-200" colSpan={4 + heads.length + (mixed ? 2 : 0)} />
              <td className="border border-slate-200" />
              <td className={tdN + ' text-blue-700'}>{fmtNumber(c.qty)}</td>
              <td className="border border-slate-200" colSpan={2} />
              <td className={tdN}>{fmtDecimal(c.net, 2)}</td>
              <td className={tdN}>{fmtDecimal(c.gross, 2)}</td>
              <td className={tdN}>{fmtDecimal(c.cbm, 3)} CBM</td>
              {!ro && <td className="border border-slate-200" />}
            </tr>
          </tfoot>
        </table>
      </div>
      {c.rows.some((r) => r.issues.length) && (
        <div className="border-t border-red-100 bg-red-50/50 px-4 py-2 text-xs text-red-700">
          {c.rows.map((r, ri) => r.issues.length ? <div key={ri}>Row {ri + 1} (cartons {r.ctn_from}-{r.ctn_to}): {r.issues.join('; ')}</div> : null)}
        </div>
      )}
      {!ro && (
        <div className="border-t border-surface-border px-4 py-2">
          <Button size="sm" variant="outline" onClick={() => p.addRow(bi)}>+ Add carton row</Button>
        </div>
      )}
    </Card>
  );
}
