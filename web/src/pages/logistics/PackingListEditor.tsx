import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, Checkbox, DataTable, Input, Modal, Select, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import {
  type BlockS, type ItemS, type PlType, type RowS,
  blocksFromServer, blocksToPayload, calcList, emptyItem, newBlock, newRowAfter, parseHeaders,
  normKey, shippedGroups, STANDARD_PRESETS, uid, FORMAT_LABEL,
} from './packingListModel';
import { useAuth } from '../../lib/auth';
import { PackingListDocument, PackingListPrintPortal } from './PackingListPrint';
import { JobSelect } from '../../components/JobSelect';

const TYPE_COLOR: Record<string, string> = { ASSORTED: 'indigo', SOLID: 'amber', MIXED: 'violet' };
const STATUS_COLOR: Record<string, string> = { DRAFT: 'slate', PLANNED: 'blue', CONFIRMED: 'emerald', CLOSED: 'gray' };
const PLAN_STATE: Record<string, { label: string; color: string }> = {
  NOT_PACKED: { label: 'Not packed', color: 'slate' }, IN_PROGRESS: { label: 'Packing', color: 'amber' },
  READY: { label: 'Packed', color: 'emerald' }, READY_SHORT: { label: 'Packed short', color: 'red' },
};
const TYPE_HELP: Record<PlType, string> = {
  ASSORTED: 'Each carton holds a size ratio (e.g. S1 M2 L3 XL3 XXL2 XXXL1 = 12 pcs/ctn).',
  SOLID: 'One colour in one size per carton (e.g. numeric sizes 36 – 52), grouped per style/colour.',
  MIXED: 'Kids + adult size sets on one list, PCS/PACK × PACK/CTN rows and cartons mixing colours/styles.',
};
const n0 = (v: unknown) => Number(v ?? 0) || 0;
const errMsg = (e: any) => e?.message || e?.response?.data?.error?.message || 'Request failed';

/* ============================================================
   PACKING LIST REGISTER
============================================================ */
export function PackingListPage() {
  const [lists, setLists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [flt, setFlt] = useState({ q: '', type: '', status: '' });
  const nav = useNavigate();
  useEffect(() => { api.get('/packing-lists').then((r) => setLists(r.data.data)).finally(() => setLoading(false)); }, []);
  // register filters (spec §11): buyer / PO / job / style / invoice / shipment by text, template model, status
  const shown = lists.filter((r) => (!flt.type || r.pl_type === flt.type) && (!flt.status || r.status === flt.status)
    && (!flt.q || [r.pl_no, r.buyer_order_no, r.so_no, r.io_no, r.buyer_name, r.style_summary, r.invoice_no, r.shipment_no]
      .some((v) => String(v ?? '').toLowerCase().includes(flt.q.toLowerCase()))));

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
        <div className="flex flex-wrap items-end gap-3 border-b border-surface-border p-3">
          <Input className="w-72" label="Search" placeholder="PL / PO / job / buyer / style / invoice / shipment" value={flt.q} onChange={(e) => setFlt((f) => ({ ...f, q: e.target.value }))} id="pl-reg-q" />
          <Select className="w-80" label="Template" value={flt.type} onChange={(e) => setFlt((f) => ({ ...f, type: e.target.value }))}
            options={[{ value: '', label: 'All models' }, ...(['ASSORTED', 'SOLID', 'MIXED'] as const).map((t) => ({ value: t, label: FORMAT_LABEL[t] }))]} />
          <Select className="w-40" label="Status" value={flt.status} onChange={(e) => setFlt((f) => ({ ...f, status: e.target.value }))}
            options={[{ value: '', label: 'All' }, { value: 'DRAFT', label: 'Draft' }, { value: 'PLANNED', label: 'Planned (packing)' }, { value: 'CONFIRMED', label: 'Confirmed' }, { value: 'CLOSED', label: 'Closed' }]} />
        </div>
        <DataTable
          data={shown} loading={loading}
          columns={[
            { key: 'pl_no', header: 'PL No', sortable: true, render: (r: any) => (
              <button onClick={() => nav(`/logistics/packing-lists/${r.id}`)} className="tabular-nums text-xs font-semibold text-brand-700 hover:underline">{r.pl_no}</button>) },
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
            { key: 'status', header: 'Status', render: (r: any) => <span className="flex items-center gap-1"><Badge color={STATUS_COLOR[r.status] || 'slate'}>{r.status}</Badge>{r.revision_no > 0 && <Badge color="amber">Rev {r.revision_no}</Badge>}
              {r.list_mode === 'PLAN' && <Badge color="blue">Plan</Badge>}{r.short_action && r.short_action !== 'NONE' && <Badge color="red">{r.short_action === 'TO_FOLLOW' ? `Short ${r.short_qty} to follow` : `Short ${r.short_qty} debit`}</Badge>}</span> },
            { key: 'shipment_no', header: 'Shipment', render: (r: any) => r.shipment_no || '—' },
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
  shipment_type: 'EXPORT', destination: '', pl_type: 'ASSORTED' as PlType, list_mode: 'DOCUMENT' as 'DOCUMENT' | 'PLAN', status: 'DRAFT', ctn_numbering: 'SEQUENCE' as 'SEQUENCE' | 'CARTON_NO',
  allow_ctn_gaps: false, carton_tare_kg: '' as string | number,
  invoice_no: '', invoice_date: '', buyer_order_no: '', buyer_order_date: '', other_references: '',
  exporter_details: '', consignee_details: '', notify_label: 'Notify Party :-', notify_details: '',
  country_of_origin: 'INDIA', country_of_destination: '', pre_carriage_by: '', place_of_receipt: '',
  vessel_flight_no: '', port_of_loading: '', port_of_discharge: '', final_destination: '',
  terms_of_delivery: '', terms_of_payment: '', remarks: '',
};
type Header = typeof EMPTY_HEADER;

/** One style + colour of the sales order with its size breakdown (from /packing-lists/prefill). */
interface OrderLine {
  style_id: number | null; style_code: string | null; style_name: string | null;
  color_id: number | null; color_name: string | null; sizes: { size_code: string; qty: number }[];
}
const DEFAULT_SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
/** Sizes of the order lines in their size order (each line is already sorted). */
const orderSizes = (lines: OrderLine[]) => {
  const out: string[] = [];
  for (const l of lines) for (const s of l.sizes) if (!out.includes(s.size_code)) out.push(s.size_code);
  return out;
};
const orderNoOf = (d: { buyer_order_no?: string | null; so_no?: string | null }) => d.buyer_order_no || d.so_no || '';

export function PackingListDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const isNew = !id || id === 'new';

  const [header, setHeader] = useState<Header>(EMPTY_HEADER);
  const [sizeHeaders, setSizeHeaders] = useState<string[]>(DEFAULT_SIZES);
  const [orderLines, setOrderLines] = useState<OrderLine[]>([]);
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
  const [cartonInfo, setCartonInfo] = useState<Record<number, CartonInfo>>({});   // posted cartons behind built rows
  const [packSum, setPackSum] = useState<any>(null);                               // Order | Packed | On this list | Balance
  const [req, setReq] = useState<Record<string, { ppb: string; bpc: string; ppc: string }>>({}); // carton requirement inputs per row
  const [autoRows, setAutoRows] = useState(false);          // rows came from the auto-fill and were not edited since
  const [ctnStart, setCtnStart] = useState('1');             // first carton number when numbering 1..N
  const [buyerTpl, setBuyerTpl] = useState<any>(null);       // buyer default template
  const [formatTouched, setFormatTouched] = useState(false); // user picked a format → buyer default no longer applied
  const [revView, setRevView] = useState<any>(null);         // frozen revision shown in the print modal
  const [overOpen, setOverOpen] = useState(false);
  const [overReason, setOverReason] = useState('');
  const [finishOpen, setFinishOpen] = useState(false);
  const [shortAction, setShortAction] = useState<'TO_FOLLOW' | 'DEBIT'>('TO_FOLLOW');
  const [shortReason, setShortReason] = useState('');
  const { can } = useAuth();

  const ro = !isNew && header.status !== 'DRAFT';
  // packing list as the plan (buyer list entered first, cartons packed against its carton numbers)
  const isPlan = header.list_mode === 'PLAN';
  const planFinished = isPlan && !!saved?.plan_finished_at;
  const planDraft = isPlan && header.status === 'DRAFT' && !planFinished;
  const ps = saved?.plan_status;

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-orders'), api.get('/lookups/packings'), api.get('/lookups/buyers'),   // buyer + consignee: buyers only
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
    setCartonInfo(d.carton_info || {});
    if (d.pack_summary) setPackSum(d.pack_summary);
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

  // Style / colour / size breakdown of the linked sales order — feeds the row pickers and "Add rows from order".
  useEffect(() => {
    if (!header.so_id) { setOrderLines([]); return; }
    api.get('/packing-lists/prefill', { params: { so_id: header.so_id } })
      .then((r) => setOrderLines(r.data.data.order_lines || [])).catch(() => setOrderLines([]));
  }, [header.so_id]);

  // Packed (posted cartons) / order qty / packaging stock for the order or job
  useEffect(() => {
    if (!header.so_id && !header.io_no) { setPackSum(null); return; }
    api.get('/packing-lists/pack-summary', { params: { so_id: header.so_id || undefined, io_no: header.io_no || undefined, pl_id: isNew ? undefined : id } })
      .then((r) => setPackSum(r.data.data)).catch(() => {});
  }, [header.so_id, header.io_no, id, isNew, saved]);

  const setField = (k: keyof Header, v: any) => { setHeader((p) => ({ ...p, [k]: v })); setDirty(true); };
  const mutateBlocks = (fn: (b: BlockS[]) => BlockS[]) => { setBlocks((prev) => fn(structuredClone(prev))); setDirty(true); setAutoRows(false); };

  /* ---------- style / colour pickers on the carton rows */
  const itemFromLine = (l: OrderLine) => ({
    style_id: l.style_id, style_no: l.style_code ?? '', style_name: l.style_name ?? '', color_id: l.color_id, colour: l.color_name ?? '',
  });
  const pickStyle = (bi: number, ri: number, ii: number, v: string) => mutateBlocks((b) => {
    const it = b[bi].rows[ri].items[ii];
    const hit = orderLines.filter((l) => normKey(l.style_code) === normKey(v));
    it.style_no = v; it.style_id = hit[0]?.style_id ?? null;
    if (hit.length) {
      it.style_name = hit[0].style_name ?? it.style_name;
      // only one colour of this style on the order → take it; a colour the style does not have is cleared
      if (hit.length === 1) { it.colour = hit[0].color_name ?? ''; it.color_id = hit[0].color_id; }
      else if (it.colour && !hit.some((l) => normKey(l.color_name) === normKey(it.colour))) { it.colour = ''; it.color_id = null; }
    }
    return b;
  });
  const pickColour = (bi: number, ri: number, ii: number, v: string) => mutateBlocks((b) => {
    const it = b[bi].rows[ri].items[ii];
    const hit = orderLines.find((l) => normKey(l.color_name) === normKey(v) && (!it.style_no || normKey(l.style_code) === normKey(it.style_no)));
    it.colour = v; it.color_id = hit?.color_id ?? null;
    return b;
  });
  /** Order line a shipped group (order no | style | colour key) belongs to. */
  const lineOfGroup = (key: string) => {
    const [, style, colour] = key.split('|');
    return orderLines.find((l) => (normKey(l.style_code) === style || normKey(l.style_name) === style) && normKey(l.color_name) === colour);
  };

  /* ---------- one carton row per style / colour of the order, with the order qty */
  const addRowsFromOrder = () => {
    if (!orderLines.length) return;
    const hasRows = blocks.some((b) => b.rows.some((r) => r.items.some((it) => Object.values(it.size_qty).some((v) => Number(v) > 0))));
    if (hasRows && !window.confirm('Replace the current carton rows with rows from the sales order?')) return;
    const orderNo = orderNoOf({ buyer_order_no: header.buyer_order_no, so_no: lk.so.find((s: any) => s.id === header.so_id)?.code });
    const solid = header.pl_type === 'SOLID';
    const rows: RowS[] = [];
    for (const l of orderLines) {
      const base = { ...emptyItem({ order_no: orderNo, so_id: header.so_id }), ...itemFromLine(l) };
      const parts = solid ? l.sizes.filter((s) => s.qty > 0).map((s) => [s]) : [l.sizes.filter((s) => s.qty > 0)];
      for (const p of parts) {
        if (!p.length) continue;
        rows.push({ ...newRowAfter(), items: [{ ...base, key: uid(), size_qty: Object.fromEntries(p.map((s) => [s.size_code, String(s.qty)])) }] });
      }
    }
    setSizeHeaders((h) => { const sz = orderSizes(orderLines); return hasRows ? [...h, ...sz.filter((s) => !h.includes(s))] : sz; });
    setBlocks([{ ...newBlock(), rows }]);
    setDirty(true);
    toast(`${rows.length} row(s) added with the order qty — split them into cartons and delete what is not packed`);
  };

  const calc = useMemo(() => calcList(header.pl_type, sizeHeaders, blocks), [header.pl_type, sizeHeaders, blocks]);
  const groups = useMemo(() => shippedGroups(blocks, calc), [blocks, calc]);
  const serverGroup = (key: string) => (saved?.order_summary || []).find((g: any) => g.group_key === key);

  /* ---------- rows from packed cartons vs rows typed by hand / from the order */
  const flatRows = useMemo(() => blocks.flatMap((b, bi) => b.rows.map((r, ri) => ({ r, bi, ri, rc: calc.blocks[bi].rows[ri] }))), [blocks, calc]);
  const handRows = flatRows.filter((x) => !x.r.source_carton_ids?.length && x.rc.total_qty > 0);
  const listCartons = useMemo(() => {
    const ids = flatRows.flatMap((x) => x.r.source_carton_ids ?? []);
    const info = ids.map((cid) => cartonInfo[cid]).filter(Boolean);
    return { count: ids.length, full: info.filter((c) => !c.is_partial).length, partial: info.filter((c) => c.is_partial).length,
             polybags: info.reduce((a, c) => a + (c.polybag_qty || 0), 0), qty: info.reduce((a, c) => a + (c.qty || 0), 0) };
  }, [flatRows, cartonInfo]);
  const handPolybags = handRows.reduce((a, x) => a + (x.rc.packed ? Math.trunc(Number(x.r.packs_per_ctn) || 0) * x.rc.ctns : 0), 0);

  /* ---------- carton requirement helper (rows typed from the order): pcs / polybag × polybags / carton */
  const [reqDefault, setReqDefault] = useState({ ppb: '', bpc: '', ppc: '' });
  const reqCalc = handRows.map((x) => {
    const own = req[x.r.key] ?? { ppb: '', bpc: '', ppc: '' };
    const ppb = Number(own.ppb || reqDefault.ppb) || 0, bpc = Number(own.bpc || reqDefault.bpc) || 0;
    const ppc = Number(own.ppc || reqDefault.ppc) || (ppb && bpc ? ppb * bpc : 0);
    const qty = x.rc.total_qty;
    const cartons = ppc ? Math.ceil(qty / ppc) : 0;
    const full = ppc ? Math.floor(qty / ppc) : 0;
    return { ...x, own, ppb, bpc, ppc, qty, cartons, full, loose: ppc ? qty - full * ppc : 0, polybags: ppb ? Math.ceil(qty / ppb) : 0 };
  });
  const reqTotals = { cartons: reqCalc.reduce((a, x) => a + x.cartons, 0), polybags: reqCalc.reduce((a, x) => a + x.polybags, 0), qty: reqCalc.reduce((a, x) => a + x.qty, 0) };
  const setReqField = (key: string, k: 'ppb' | 'bpc' | 'ppc', v: string) =>
    setReq((m) => ({ ...m, [key]: { ...(m[key] ?? { ppb: '', bpc: '', ppc: '' }), [k]: v.replace(/[^0-9]/g, '') } }));

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
                         'country_of_destination', 'final_destination', 'terms_of_delivery', 'terms_of_payment', 'consignee_details', 'shipment_type', 'exporter_details',
                         'invoice_id', 'invoice_no', 'invoice_date', 'vessel_flight_no', 'other_references', 'notify_details', 'country_of_origin']) {
          if (d[k] != null && d[k] !== '' && (!onlyEmpty || !next[k] || (k === 'country_of_origin' && next[k] === 'INDIA'))) next[k] = d[k];
        }
        if (d.notify_label && (!onlyEmpty || !h.notify_details)) next.notify_label = d.notify_label;
        // buyer default template (format + numbering) unless the user already picked a format
        if (d.buyer_template && !formatTouched) { next.pl_type = d.buyer_template.pl_type; next.ctn_numbering = d.buyer_template.ctn_numbering || 'SEQUENCE'; }
        return next;
      });
      setBuyerTpl(d.buyer_template ?? null);
      // carton rows: order no of the sales order on rows that have none, size columns from the order
      const lines: OrderLine[] = d.order_lines || [];
      const orderNo = orderNoOf(d);
      const noQty = !blocks.some((b) => b.rows.some((r) => r.items.some((it) => Object.values(it.size_qty).some((v) => Number(v) > 0))));
      const sizes = orderSizes(lines);
      const styles = [...new Set(lines.map((l) => l.style_code))];
      if (sizes.length && (noQty || !onlyEmpty)) setSizeHeaders(sizes);
      mutateBlocks((b) => {
        for (const bl of b) for (const r of bl.rows) for (const it of r.items) {
          if (!it.order_no.trim() && orderNo) it.order_no = orderNo;
          if (!it.so_id) it.so_id = soId;
          // one style on the order → fill it; one style + colour → fill the colour too
          if (styles.length === 1 && !it.style_no.trim()) {
            const l = lines[0];
            Object.assign(it, lines.length === 1 ? itemFromLine(l) : { style_id: l.style_id, style_no: l.style_code ?? '', style_name: l.style_name ?? '' });
          }
        }
        return b;
      });
      toast('Header and carton defaults filled from the sales order');
      return d;
    } catch (e) { toast(errMsg(e), 'error'); }
    return null;
  };

  /* ---------- AUTO-FILL: rows from the posted (verified / sealed) cartons of the packing, order or job,
                grouped per the chosen format (Model 1 / 2 / 3) */
  const canBuild = Boolean(header.packing_id || header.so_id || header.io_no);
  const hasTypedQty = () => blocks.some((b) => b.rows.some((r) => r.items.some((it) => Object.values(it.size_qty).some((v) => Number(v) > 0))));
  const buildFromPacking = async (opts: { format?: PlType; src?: { packing_id?: number | null; so_id?: number | null; io_no?: string | null };
                                          numbering?: string; start?: string; auto?: boolean } = {}) => {
    const src = opts.src ?? { packing_id: header.packing_id, so_id: header.so_id, io_no: header.io_no };
    if (!src.packing_id && !src.so_id && !src.io_no) return;
    if (!opts.auto && !autoRows && hasTypedQty() && !window.confirm('Replace the current carton rows with rows built from the packed cartons?')) return;
    try {
      const params: any = src.packing_id ? { packing_id: src.packing_id } : src.so_id ? { so_id: src.so_id } : { io_no: src.io_no };
      const numbering = opts.numbering ?? header.ctn_numbering;
      // format not chosen yet (no buyer default either) → inferred from the cartons' contents
      const format = opts.format ?? (formatTouched || !isNew || buyerTpl ? header.pl_type : 'AUTO');
      const r = await api.get('/packing-lists/build-rows', { params: { ...params, format, numbering,
        start: numbering === 'SEQUENCE' ? (Number(opts.start ?? ctnStart) || 1) : undefined, pl_id: isNew ? undefined : id } });
      const d = r.data.data;
      setSizeHeaders(d.size_headers);
      setBlocks(blocksFromServer(d.blocks));
      setCartonInfo(d.carton_info || {});
      setHeader((h) => ({ ...h, pl_type: d.pl_type, ctn_numbering: d.numbering || h.ctn_numbering, allow_ctn_gaps: h.allow_ctn_gaps || Boolean(d.has_gaps) }));
      setDirty(true); setAutoRows(true);
      const sk = d.skipped || {};
      const skipped = [sk.not_ready ? `${sk.not_ready} not posted / verified` : '', sk.on_other_list ? `${sk.on_other_list} on another list` : '', sk.shipped ? `${sk.shipped} shipped` : '']
        .filter(Boolean).join(', ');
      toast(`Auto-filled ${d.carton_count ?? ''} posted carton(s) as ${d.row_count ?? d.blocks[0]?.rows.length} row(s) in ${d.blocks.length} block(s) — ${d.pl_type}`
        + `${d.empty_cartons ? ` (${d.empty_cartons} empty carton(s) skipped)` : ''}${skipped ? ` — skipped ${skipped}` : ''}`
        + `${d.missing_weight ? ` — ${d.missing_weight} carton(s) without weight: enter it on the rows` : ''}`);
    } catch (e) { if (!opts.auto) toast(errMsg(e), 'error'); else toast(`No rows auto-filled: ${errMsg(e)}`, 'warning'); }
  };
  /** A source (order / job / packing) was picked: fill the header, then the rows from its posted cartons. */
  const pickSource = async (src: { packing_id?: number | null; so_id?: number | null; io_no?: string | null }, soForHeader: number | null) => {
    let fmt: PlType | undefined;
    if (soForHeader && isNew) {
      const d = await fillFromSo(soForHeader);
      if (d?.buyer_template && !formatTouched) fmt = d.buyer_template.pl_type;
    }
    if (!ro && header.list_mode !== 'PLAN' && (autoRows || !hasTypedQty())) await buildFromPacking({ src, format: fmt, auto: true });
  };
  /** Format changed: rows that came from the auto-fill are regrouped for the new format. */
  const changeFormat = (v: PlType) => {
    setField('pl_type', v); setFormatTouched(true);
    if (autoRows && canBuild) void buildFromPacking({ format: v, auto: true });
  };
  const saveBuyerDefault = async () => {
    if (!header.buyer_id) return;
    try {
      const r = await api.put('/packing-lists/buyer-template', { buyer_id: header.buyer_id, pl_type: header.pl_type, ctn_numbering: header.ctn_numbering,
        size_headers: sizeHeaders, notify_label: header.notify_label || null, notify_details: header.notify_details || null, other_references: header.other_references || null });
      setBuyerTpl(r.data.data); toast(`Buyer default set: ${FORMAT_LABEL[header.pl_type]}`);
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  // buyer picked by hand → its default template
  useEffect(() => {
    if (!header.buyer_id) { setBuyerTpl(null); return; }
    api.get('/packing-lists/buyer-template', { params: { buyer_id: header.buyer_id } }).then((r) => {
      const t = r.data.data; setBuyerTpl(t);
      if (t && isNew && !formatTouched && !autoRows && !hasTypedQty()) setHeader((h) => ({ ...h, pl_type: t.pl_type, ctn_numbering: t.ctn_numbering || 'SEQUENCE' }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header.buyer_id]);

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
  const handleConfirm = async (reason?: string) => {
    if (dirty) { toast('Save your changes before confirming', 'warning'); return; }
    if (!reason && saved?.over_shipment?.qty > 0) { setOverOpen(true); return; }
    if (!reason && !window.confirm('Confirm and freeze this packing list? It can no longer be edited afterwards (only revised).')) return;
    try {
      const r = await api.post(`/packing-lists/${id}/confirm`, reason ? { over_ship_reason: reason } : {});
      applyServer(r.data.data); setOverOpen(false); setOverReason(''); toast('Packing list confirmed and frozen');
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const planAction = async (path: 'release' | 'unrelease' | 'finish' | 'reopen', body: any, done: string) => {
    if (dirty) { toast('Save your changes first', 'warning'); return false; }
    try {
      const r = await api.post(`/packing-lists/${id}/plan/${path}`, body);
      applyServer(r.data.data); toast(done);
      if (r.data.warnings?.length) toast(r.data.warnings.join('; '), 'warning');
      return true;
    } catch (e) { toast(errMsg(e), 'error'); return false; }
  };
  const changeMode = (v: 'DOCUMENT' | 'PLAN') => {
    if (v === 'PLAN' && blocks.some((b) => b.rows.some((r) => r.source_carton_ids?.length))) {
      if (!window.confirm('A packing plan is the buyer list entered before packing — clear the rows built from packed cartons?')) return;
      setBlocks([newBlock()]); setCartonInfo({}); setAutoRows(false);
    }
    setField('list_mode', v);
  };
  const finishPlan = async () => {
    const short = n0(ps?.short_qty) > 0;
    const ok = await planAction('finish', short ? { short_action: shortAction, short_reason: shortReason.trim() } : {},
      short ? (shortAction === 'TO_FOLLOW' ? 'Packing finished — a follow-up packing list was made for the shortage' : 'Packing finished — the shortage is recorded as debited by the buyer')
            : 'Packing finished — the list is built from the packed cartons');
    if (ok) { setFinishOpen(false); setShortReason(''); }
  };
  const handleReopen = async () => {
    try {
      const r = await api.post(`/packing-lists/${id}/revise`, { reason: reopenReason });
      applyServer(r.data.data); setReopenOpen(false); setReopenReason('');
      toast(`Revision ${r.data.data.revision_no} opened — the confirmed version is kept in the history`);
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const openRevision = async (rev: number) => {
    try { const r = await api.get(`/packing-lists/${id}/revisions/${rev}`); setRevView(r.data.data); }
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
    // solid sheet: typing a size moves a one-size carton to that size (a multi-size carton keeps its other sizes)
    if (header.pl_type === 'SOLID' && v !== '' && Number(v) > 0 && Object.values(it.size_qty).filter((q) => Number(q) > 0).length <= 1) it.size_qty = {};
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
          {!isNew && planDraft && <Button onClick={() => { if (window.confirm('Release this buyer list to packing? Its rows are frozen and cartons are packed against its carton numbers.')) void planAction('release', {}, 'Plan released — pack the cartons against it'); }} id="pl-release">Release plan to packing</Button>}
          {!isNew && header.status === 'PLANNED' && <Button variant="outline" onClick={() => void planAction('unrelease', {}, 'Plan back to draft')} id="pl-unrelease" disabled={!!ps?.cartons?.some((c: any) => c.carton_id)} title="Only before any carton is packed for it">Back to draft</Button>}
          {!isNew && header.status === 'PLANNED' && <Button onClick={() => setFinishOpen(true)} id="pl-finish">Finish packing</Button>}
          {!isNew && planFinished && header.status === 'DRAFT' && <Button variant="outline" onClick={() => { if (window.confirm('Reopen the plan? The plan rows come back so more cartons can be packed; an unused follow-up list is removed.')) void planAction('reopen', {}, 'Plan reopened'); }} id="pl-plan-reopen">Reopen plan</Button>}
          {!isNew && header.status === 'DRAFT' && !planDraft && <Button variant="outline" onClick={() => handleConfirm()} id="pl-confirm">✓ Confirm &amp; Freeze</Button>}
          {!isNew && header.status === 'CONFIRMED' && <Button variant="outline" onClick={() => setReopenOpen(true)} id="pl-revise">Revise (new revision)</Button>}
          {!ro && <Button onClick={handleSave} loading={saving}>{dirty || isNew ? 'Save' : 'Saved'}</Button>}
        </div>
      </div>

      {!isNew && (
        <div className="no-print flex flex-wrap items-center gap-2">
          <Badge color={STATUS_COLOR[header.status] || 'slate'} size="lg">{header.status}</Badge>
          <Badge color={TYPE_COLOR[header.pl_type]} size="lg">{header.pl_type}</Badge>
          {saved?.revision_no > 0 && <Badge color="amber" size="lg">Rev {saved.revision_no}</Badge>}
          {isPlan && <Badge color="blue" size="lg">Packing plan</Badge>}
          {saved?.follow_of_no && <span className="text-xs text-blue-700" data-testid="pl-follow-of">Shortage to follow from <button className="font-semibold hover:underline" onClick={() => nav(`/logistics/packing-lists/${saved.follow_of_id}`)}>{saved.follow_of_no}</button></span>}
          {saved?.short_action && saved.short_action !== 'NONE' && <span className="text-xs text-red-700" data-testid="pl-short-note">Short {fmtNumber(saved.short_qty)} PCS — {saved.short_action === 'TO_FOLLOW' ? 'to follow' : 'debited by the buyer'}{saved.short_reason ? `: ${saved.short_reason}` : ''}</span>}
          {header.shipment_type === 'EXPORT' && <Badge color="blue" size="lg">EXPORT</Badge>}
          {saved?.confirmed_at && <span className="text-xs text-slate-500">Confirmed {fmtDate(saved.confirmed_at)} by {saved.confirmed_by_name || '—'}</span>}
          {saved?.reopen_reason && header.status === 'DRAFT' && <span className="text-xs text-amber-700">Revision {saved.revision_no} opened: {saved.reopen_reason}</span>}
          {saved?.over_ship_note && <span className="text-xs text-red-700">Over-shipment approved: {saved.over_ship_note}</span>}
          {dirty && <span className="text-xs font-medium text-amber-700">Unsaved changes</span>}
        </div>
      )}

      {serverErrors.length > 0 && (
        <div className="no-print rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="mb-1 font-semibold">The packing list could not be saved:</div>
          <ul className="list-disc pl-5">{serverErrors.slice(0, 20).map((m, i) => <li key={i}>{m}</li>)}</ul>
        </div>
      )}

      {saved?.over_shipment?.qty > 0 && (
        <div className="no-print rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="pl-over-ship">
          <b>Over-shipment: {fmtNumber(saved.over_shipment.qty)} PCS more than the order qty</b> —{' '}
          {saved.over_shipment.lines.map((l: any) => `${l.style ?? ''} ${l.colour ?? ''}: ${Object.entries(l.excess).map(([k, v]) => `${k} +${v}`).join(' ')}`).join('; ')}.
          {header.status === 'DRAFT' && ' Confirming needs an approval reason (Approve Packing right).'}
        </div>
      )}
      {saved?.carton_check && !saved.carton_check.ok && (
        <div className="no-print rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" data-testid="pl-carton-drift">
          <b>The packed cartons changed since this list was made</b> — {saved.carton_check.issues.slice(0, 5).join('; ')}.
          {header.status === 'CONFIRMED' ? ' Revise the list and rebuild the rows.' : ' Rebuild the rows from the packed cartons.'}
        </div>
      )}

      {/* ---------- packing plan: the buyer list released to packing */}
      {planDraft && !isNew && (
        <div className="no-print rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900" data-testid="pl-plan-hint">
          <b>Packing plan (buyer list)</b> — enter the buyer's cartons as rows (style and colour from the order, size ratio per carton), save, then
          <b> Release plan to packing</b>. Cartons are then packed against these carton numbers on the Carton screen; one list per country / selling point.
        </div>
      )}
      {ps && (
        <div id="pl-plan-status"><Card title="Packing against the plan" subtitle={`${saved?.plan_released_at ? `Released ${fmtDate(saved.plan_released_at)}${saved.plan_released_by_name ? ` by ${saved.plan_released_by_name}` : ''}` : ''}${saved?.plan_finished_at ? ` · finished ${fmtDate(saved.plan_finished_at)}` : ''}`}>
          <div className="grid grid-cols-2 gap-4 p-4 text-center md:grid-cols-5">
            <Stat label="Planned" value={`${fmtNumber(ps.total_cartons)} CTNS / ${fmtNumber(ps.total_qty)}`} />
            <Stat label="Packed (posted)" value={`${fmtNumber(ps.ready_cartons)} / ${fmtNumber(ps.ready_qty)}`} tone="text-emerald-700" />
            <Stat label="Packing (not posted)" value={`${fmtNumber(ps.in_progress_cartons)} / ${fmtNumber(ps.in_progress_qty)}`} tone="text-amber-700" />
            <Stat label="Not packed (cartons)" value={fmtNumber(ps.not_packed_cartons)} />
            <Stat label="Short (PCS)" value={fmtNumber(ps.short_qty)} tone={ps.short_qty > 0 ? 'text-red-700' : 'text-slate-800'} />
          </div>
          <div className="grid gap-4 border-t border-surface-border p-4 lg:grid-cols-2">
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs" id="plan-cartons">
                <thead><tr className="text-left text-slate-500"><th className="py-1">Ctn</th><th>Block</th><th className="text-right">Plan</th><th className="text-right">Packed</th><th className="pl-4">Carton</th><th>State</th></tr></thead>
                <tbody>{ps.cartons.map((c: any) => (
                  <tr key={c.ctn_no} data-ctn={c.ctn_no} data-state={c.state} className="border-t border-slate-100">
                    <td className="py-1 tabular-nums">{c.ctn_no}</td><td>{c.label ?? c.block_no}</td>
                    <td className="text-right">{c.planned}</td><td className="text-right">{c.carton_id ? c.packed : '—'}</td>
                    <td className="pl-4 tabular-nums">{c.carton_no ?? ''}{c.pack_no ? <span className="ml-1 font-sans text-slate-400">{c.pack_no}</span> : null}</td>
                    <td><Badge color={PLAN_STATE[c.state]?.color ?? 'slate'}>{PLAN_STATE[c.state]?.label ?? c.state}</Badge></td>
                  </tr>))}</tbody>
              </table>
            </div>
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs" id="plan-cells">
                <thead><tr className="text-left text-slate-500"><th className="py-1">Style / colour / size</th><th className="text-right">Plan</th><th className="text-right">Packed</th><th className="text-right">Packing</th><th className="text-right">Short</th></tr></thead>
                <tbody>{ps.cells.map((g: any) => (
                  <tr key={`${g.style_no}|${g.color_id}:${g.size_id}`} className="border-t border-slate-100">
                    <td className="py-1">{g.style_no} {g.colour} <b>{g.size_label}</b></td><td className="text-right">{g.planned}</td>
                    <td className="text-right text-emerald-700">{g.ready}</td><td className="text-right text-amber-700">{g.in_progress || ''}</td>
                    <td className={`text-right ${g.short > 0 ? 'font-semibold text-red-700' : ''}`}>{g.short || ''}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          </div>
          {saved?.follow_ups?.length > 0 && (
            <div className="border-t border-surface-border px-4 py-2 text-xs text-slate-700" id="pl-follow-ups">
              Follow-up list(s) for the shortage: {saved.follow_ups.map((f: any) => (
                <button key={f.id} className="mr-3 font-semibold text-brand-700 hover:underline" onClick={() => nav(`/logistics/packing-lists/${f.id}`)}>{f.pl_no} ({f.status}, {fmtNumber(f.total_cartons)} ctns / {fmtNumber(f.total_qty)} pcs)</button>))}
            </div>
          )}
        </Card></div>
      )}

      {/* ---------- packed vs order (posted cartons) */}
      {(packSum || listCartons.count > 0 || handRows.length > 0) && (
        <div id="pl-pack-summary"><Card title="Packing status" subtitle="Order qty vs posted cartons (verified / sealed) and what is on this list">
          <div className="grid grid-cols-2 gap-4 p-4 text-center md:grid-cols-4">
            <Stat label="Order qty (PCS)" value={packSum?.order_qty != null ? fmtNumber(packSum.order_qty) : '—'} />
            <Stat label={`Packed — posted cartons${packSum?.packed ? ` (${fmtNumber(packSum.packed.cartons)} CTNS)` : ''}`} value={packSum?.packed ? fmtNumber(packSum.packed.qty) : '—'} tone="text-emerald-700" />
            <Stat label={`On this list (${fmtNumber(calc.totals.ctns)} CTNS)`} value={fmtNumber(calc.totals.qty)} tone="text-blue-700" />
            <Stat label="Balance to pack (order − packed)" value={packSum?.balance_to_pack != null ? fmtNumber(packSum.balance_to_pack) : '—'}
              tone={packSum?.balance_to_pack > 0 ? 'text-amber-700' : 'text-slate-800'} />
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-surface-border px-4 py-2 text-xs text-slate-600">
            <span data-testid="pl-sum-cartons">Cartons on this list: <b>{fmtNumber(calc.totals.ctns)}</b>
              {listCartons.count > 0 && <> — from packed cartons {fmtNumber(listCartons.count)} (full <b>{listCartons.full}</b> · partial <b>{listCartons.partial}</b>)</>}
              {handRows.length > 0 && <> · typed {fmtNumber(handRows.reduce((a, x) => a + x.rc.ctns, 0))}</>}
            </span>
            <span data-testid="pl-sum-polybags">Polybags: <b>{fmtNumber(listCartons.polybags + handPolybags)}</b></span>
            {packSum?.ready_unlisted && <span>Ready cartons not on any list: <b>{fmtNumber(packSum.ready_unlisted.cartons)}</b> ({fmtNumber(packSum.ready_unlisted.qty)} PCS)</span>}
            {saved?.shipment && <span>Shipment: <b>{saved.shipment.shipment_no}</b></span>}
          </div>
          {handRows.length > 0 && (
            <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800" data-testid="pl-hand-warning">
              ⚠ {handRows.length} row(s) not from packed cartons — typed by hand or from the order. Totals of these rows are not checked against posted cartons;
              {canBuild ? ' use "Build rows from packed cartons" once the cartons are sealed.' : ' link a sales order / job to build rows from packed cartons.'}
            </div>
          )}
        </Card></div>
      )}

      {/* ---------- general */}
      <Card title="Packing list">
        <fieldset disabled={ro} className="grid grid-cols-1 gap-4 p-4 md:grid-cols-4">
          <Input label="PL No" value={header.pl_no} onChange={(e) => setField('pl_no', e.target.value)} placeholder="Auto-generate" disabled={!isNew} />
          <Input label="Date" type="date" value={header.pl_date} onChange={(e) => setField('pl_date', e.target.value)} />
          <div>
            <Select label="Format (template model)" value={header.pl_type} onChange={(e) => changeFormat(e.target.value as PlType)} id="pl-format"
              options={(['ASSORTED', 'SOLID', 'MIXED'] as const).map((t) => ({ value: t, label: FORMAT_LABEL[t] }))} />
            {buyerTpl && <p className="mt-1 text-[11px] text-slate-500" data-testid="pl-buyer-default">Buyer default: <b>{buyerTpl.pl_type}</b>{buyerTpl.pl_type !== header.pl_type && ' (another format picked)'}</p>}
          </div>
          <Select label="List type" value={header.list_mode} id="pl-mode" disabled={planFinished}
            onChange={(e) => changeMode(e.target.value as 'DOCUMENT' | 'PLAN')}
            options={[{ value: 'DOCUMENT', label: 'Document — from packed cartons' }, { value: 'PLAN', label: 'Packing plan — buyer list first' }]} />
          <Select label="Shipment type" value={header.shipment_type} onChange={(e) => setField('shipment_type', e.target.value)}
            options={[{ value: 'EXPORT', label: 'Export' }, { value: 'DOMESTIC', label: 'Domestic' }]} />
          <div className="flex items-end gap-2">
            <Select className="flex-1" label="Sales order" value={header.so_id ?? ''} options={soOptions}
              onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; setField('so_id', v); if (v) void pickSource({ packing_id: header.packing_id, so_id: v }, v); }} />
            {!ro && header.so_id && <Button variant="outline" size="sm" onClick={() => fillFromSo(header.so_id, false)} title="Overwrite header fields from the sales order">↻</Button>}
          </div>
          <Select label="Source packing (cartons)" value={header.packing_id ?? ''} id="pl-packing"
            onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; const p = lk.packings.find((x: any) => x.id === v);
              const so = header.so_id ?? p?.so_id ?? null;
              setHeader((h) => ({ ...h, packing_id: v, so_id: h.so_id ?? p?.so_id ?? null })); setDirty(true);
              if (v) void pickSource({ packing_id: v }, !header.so_id ? so : null); }}
            options={[{ value: '', label: '— None —' }, ...lk.packings.map((p: any) => ({ value: p.id, label: p.label || p.code }))]} />
          <JobSelect label="I/O No" value={header.io_no || ''} id="pl-io"
            onPick={(j) => { setHeader((h) => ({ ...h, io_no: j?.job_no ?? '', so_id: j ? j.id : h.so_id })); setDirty(true); if (j) void pickSource({ packing_id: header.packing_id, so_id: j.id, io_no: j.job_no }, j.id); }} />
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
            <div className="grid grid-cols-2 gap-2">
              <Select label="Carton numbers" value={header.ctn_numbering} id="pl-numbering"
                onChange={(e) => { const v = e.target.value as Header['ctn_numbering']; setField('ctn_numbering', v); if (autoRows) void buildFromPacking({ numbering: v, auto: true }); }}
                options={[{ value: 'SEQUENCE', label: '1..N on this list' }, { value: 'CARTON_NO', label: 'Physical carton no' }]} />
              {header.ctn_numbering === 'SEQUENCE' && (
                <Input label="Start at" inputMode="numeric" value={ctnStart} id="pl-ctn-start"
                  onChange={(e) => setCtnStart(e.target.value.replace(/[^0-9]/g, ''))}
                  onBlur={() => { if (autoRows) void buildFromPacking({ auto: true }); }} />
              )}
            </div>
            {!ro && canBuild && !planDraft && (
              <Button variant="outline" size="sm" onClick={() => buildFromPacking()} id="pl-build-from-cartons"
                title="Rows from the posted (verified / sealed) cartons of the source packing, else of the sales order / job, that are not on another list — grouped for the chosen format">
                {autoRows ? '↻ Rebuild rows from packed cartons' : 'Build rows from packed cartons'}
              </Button>
            )}
            {!ro && header.buyer_id && can('PACKING.APPROVE') && (
              <Button variant="ghost" size="sm" onClick={saveBuyerDefault} id="pl-save-buyer-default" title="Use this format / numbering / size columns as the buyer's default">
                Save as buyer default
              </Button>
            )}
            {!ro && orderLines.length > 0 && (
              <Button variant="outline" size="sm" onClick={addRowsFromOrder} title="One row per style / colour (per size for Solid) with the sales order qty">
                Add rows from order
              </Button>
            )}
          </fieldset>
        </div>
      </Card>

      {/* ---------- carton rows */}
      <datalist id="pl-order-styles">
        {[...new Map(orderLines.map((l) => [l.style_code, l])).values()].map((l) => <option key={l.style_code ?? ''} value={l.style_code ?? ''}>{l.style_name}</option>)}
      </datalist>
      {[...new Set(orderLines.map((l) => l.style_code))].map((sc) => (
        <datalist key={sc ?? ''} id={`pl-order-colours-${normKey(sc)}`}>
          {orderLines.filter((l) => l.style_code === sc).map((l) => <option key={l.color_name ?? ''} value={l.color_name ?? ''} />)}
        </datalist>
      ))}
      <datalist id="pl-order-colours-">
        {[...new Set(orderLines.map((l) => l.color_name))].map((c) => <option key={c ?? ''} value={c ?? ''} />)}
      </datalist>
      {blocks.map((b, bi) => (
        <BlockEditor key={b.key} block={b} bi={bi} ro={ro} plType={header.pl_type} calc={calc.blocks[bi]} listHeaders={sizeHeaders} presets={presets}
          onLabel={(v) => mutateBlocks((x) => { x[bi].label = v; return x; })}
          onHeaders={(v) => mutateBlocks((x) => { x[bi].size_headers = v; return x; })}
          onRemove={blocks.length > 1 ? () => mutateBlocks((x) => { x.splice(bi, 1); return x; }) : undefined}
          updRow={updRow} updItem={updItem} setQty={setQty} addRow={addRow} dupRow={dupRow} delRow={delRow} moveRow={moveRow}
          addItem={addItem} delItem={delItem} grossChanged={grossChanged} pickStyle={pickStyle} pickColour={pickColour}
          hasOrder={orderLines.length > 0} cartonInfo={cartonInfo} />
      ))}
      {!ro && (
        <div className="no-print">
          <Button variant="outline" onClick={() => mutateBlocks((x) => [...x, { ...newBlock(), rows: [newRowAfter(x.at(-1)?.rows.at(-1))] }])}>
            + Add block (new style / colour / size set)
          </Button>
        </div>
      )}

      {/* ---------- carton requirement (pieces per box) for rows typed from the order */}
      {handRows.length > 0 && (
        <div id="pl-carton-req"><Card title="Carton requirement"
          subtitle="Pieces per polybag × polybags per carton (or pieces per carton) → cartons and polybags needed for the rows typed from the order">
          <div className="space-y-3 overflow-x-auto p-4">
            <div className="flex flex-wrap items-end gap-3 text-xs">
              <span className="font-medium text-slate-600">Same for all rows:</span>
              <ReqInput label="Pcs / polybag" value={reqDefault.ppb} onChange={(v) => setReqDefault((d) => ({ ...d, ppb: v }))} id="req-all-ppb" />
              <ReqInput label="Polybags / carton" value={reqDefault.bpc} onChange={(v) => setReqDefault((d) => ({ ...d, bpc: v }))} id="req-all-bpc" />
              <ReqInput label="or Pcs / carton" value={reqDefault.ppc} onChange={(v) => setReqDefault((d) => ({ ...d, ppc: v }))} id="req-all-ppc" />
            </div>
            <table className="min-w-max border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 text-[10px] uppercase text-slate-600">
                  {['Row', 'Style / colour', 'Qty (PCS)', 'Pcs / polybag', 'Polybags / ctn', 'Pcs / ctn', 'Cartons needed', 'Full + loose', 'Polybags needed'].map((h) =>
                    <th key={h} className="border border-slate-200 px-2 py-1">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {reqCalc.map((x, i) => (
                  <tr key={x.r.key}>
                    <td className="border border-slate-200 px-2 py-1 text-slate-500">{i + 1} (ctn {x.rc.ctn_from}-{x.rc.ctn_to})</td>
                    <td className="border border-slate-200 px-2 py-1">{x.r.items.map((it) => [it.style_no || it.style_name, it.colour].filter(Boolean).join(' / ')).join(' + ') || '—'}</td>
                    <td className="border border-slate-200 px-2 py-1 text-right tabular-nums">{fmtNumber(x.qty)}</td>
                    {(['ppb', 'bpc', 'ppc'] as const).map((k) => (
                      <td key={k} className="border border-slate-200 p-0">
                        <input className="w-20 bg-transparent px-1 py-0.5 text-right text-xs tabular-nums focus:bg-white focus:outline-none" inputMode="numeric"
                          value={x.own[k]} placeholder={k === 'ppc' ? (x.ppc ? String(x.ppc) : '') : (reqDefault[k] || '')}
                          onChange={(e) => setReqField(x.r.key, k, e.target.value)} />
                      </td>
                    ))}
                    <td className="border border-slate-200 px-2 py-1 text-right font-semibold text-blue-700 tabular-nums">{x.ppc ? fmtNumber(x.cartons) : '—'}</td>
                    <td className="border border-slate-200 px-2 py-1 text-right tabular-nums text-slate-600">{x.ppc ? `${fmtNumber(x.full)}${x.loose ? ` + ${x.loose} pcs` : ''}` : '—'}</td>
                    <td className="border border-slate-200 px-2 py-1 text-right tabular-nums">{x.ppb ? fmtNumber(x.polybags) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50 font-semibold">
                  <td className="border border-slate-200 px-2 py-1" colSpan={2}>Total</td>
                  <td className="border border-slate-200 px-2 py-1 text-right">{fmtNumber(reqTotals.qty)}</td>
                  <td className="border border-slate-200" colSpan={3} />
                  <td className="border border-slate-200 px-2 py-1 text-right text-blue-700" data-testid="req-total-cartons">{fmtNumber(reqTotals.cartons)}</td>
                  <td className="border border-slate-200" />
                  <td className="border border-slate-200 px-2 py-1 text-right" data-testid="req-total-polybags">{fmtNumber(reqTotals.polybags)}</td>
                </tr>
              </tfoot>
            </table>
            <div className="flex flex-wrap gap-x-6 text-sm" data-testid="req-stock">
              <span>Cartons needed <b>{fmtNumber(reqTotals.cartons)}</b>{packSum?.packaging_stock && <> · in stock <b className={reqTotals.cartons > packSum.packaging_stock.CARTON ? 'text-red-600' : 'text-emerald-700'}>{fmtNumber(packSum.packaging_stock.CARTON)}</b></>}</span>
              <span>Polybags needed <b>{fmtNumber(reqTotals.polybags)}</b>{packSum?.packaging_stock && <> · in stock <b className={reqTotals.polybags > packSum.packaging_stock.POLYBAG ? 'text-red-600' : 'text-emerald-700'}>{fmtNumber(packSum.packaging_stock.POLYBAG)}</b></>}</span>
            </div>
            {!packSum?.packaging_stock && <p className="text-[11px] text-slate-400">Pick the sales order / job to compare with carton and polybag stock.</p>}
          </div>
        </Card></div>
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
        subtitle="Order qty comes from the sales order size breakdown when it matches the style & colour; otherwise enter it here. Diff = Order − Shipped (positive = short shipped); over-shipment is shown on its own Excess row.">
        <div className="space-y-4 overflow-x-auto p-4">
          {groups.length === 0 && <p className="text-sm text-slate-500">No carton rows yet.</p>}
          {groups.map((g) => {
            const sg = serverGroup(g.key);
            // order qty: the saved server figure, else live from the sales order lines (matched on style + colour)
            const live = lineOfGroup(g.key);
            const hasManual = Object.values(manualOrder[g.key] || {}).some((v) => v !== '');
            const fromSo = (sg?.order_source === 'SALES_ORDER' && !dirty) || (!!live && !hasManual);
            const soQty: Record<string, number> = sg?.order_source === 'SALES_ORDER' && !dirty ? sg.order
              : Object.fromEntries((live?.sizes || []).map((s) => [s.size_code, s.qty]));
            const sizes = [...g.sizes, ...Object.keys(soQty), ...((sg?.sizes || []) as string[])].filter((s, i, a) => a.indexOf(s) === i);
            const order = (s: string) => (fromSo ? Number(soQty[s] || 0) : Number(manualOrder[g.key]?.[s] || 0));
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
                  {orderTotal > 0 && sizes.some((s) => (g.shipped[s] || 0) > order(s)) && (
                    <tr className="bg-red-50 text-red-700" data-testid="pl-excess-row">
                      <td className="border px-2 py-1 font-medium">Excess (Shipped &gt; Order)</td>
                      {sizes.map((s) => <td key={s} className="border px-2 py-1 text-right">{fmtNumber(Math.max(0, (g.shipped[s] || 0) - order(s)))}</td>)}
                      <td className="border px-2 py-1 text-right font-semibold">{fmtNumber(sizes.reduce((a, s) => a + Math.max(0, (g.shipped[s] || 0) - order(s)), 0))}</td>
                    </tr>
                  )}
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
                <tr key={c.id} className="border-b border-slate-50"><td className="py-1 tabular-nums">{c.carton_no}</td><td>{c.size_summary || '—'}</td>
                  <td className="text-right">{fmtDecimal(c.net_weight_kg)}</td><td className="text-right">{fmtDecimal(c.gross_weight_kg)}</td><td className="text-right">{fmtDecimal(c.cbm, 3)}</td></tr>))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ---------- revision history (frozen confirmed versions) */}
      {saved?.revisions?.length > 0 && (
        <div id="pl-revisions"><Card title="Revision history" subtitle="Each confirmed version is frozen before it is revised">
          <table className="w-full text-xs">
            <thead className="border-b text-slate-500"><tr><th className="px-4 py-1 text-left">Rev</th><th className="text-left">Reason</th><th className="text-right">Cartons</th><th className="text-right">PCS</th><th className="text-right">Gross (KG)</th><th className="text-left pl-4">Revised by</th><th /></tr></thead>
            <tbody>{saved.revisions.map((r: any) => (
              <tr key={r.revision_no} className="border-b border-slate-50">
                <td className="px-4 py-1 font-semibold">Rev {r.revision_no}</td><td>{r.reason}</td>
                <td className="text-right">{fmtNumber(r.total_cartons)}</td><td className="text-right">{fmtNumber(r.total_qty)}</td><td className="text-right">{fmtDecimal(r.gross_weight_kg, 2)}</td>
                <td className="pl-4">{r.created_by_name || '—'} · {fmtDate(r.created_at)}</td>
                <td className="pr-4 text-right"><Button size="sm" variant="ghost" onClick={() => openRevision(r.revision_no)}>View</Button></td>
              </tr>))}
            </tbody>
          </table>
        </Card></div>
      )}

      {/* ---------- print preview + print portal */}
      <Modal open={showPrint} onClose={() => setShowPrint(false)} title={`Packing list ${header.pl_no ?? ''} — print view`} size="full"
        subtitle="Preview of the printed packing list"
        footer={<><Button variant="secondary" onClick={() => setShowPrint(false)}>Close</Button><Button variant="secondary" onClick={handleExcel}>Download Excel</Button><Button onClick={handlePrint}>Print</Button></>}>
        {saved && <PackingListDocument pl={saved} />}
      </Modal>
      {saved && <PackingListPrintPortal pl={saved} />}
      <Modal open={!!revView} onClose={() => setRevView(null)} title={`Packing list ${header.pl_no ?? ''} — Rev ${revView?.revision_no ?? ''} (frozen)`} size="full"
        subtitle={revView ? `Revised ${fmtDate(revView.created_at)} by ${revView.created_by_name || '—'}: ${revView.reason}` : ''}
        footer={<Button variant="secondary" onClick={() => setRevView(null)}>Close</Button>}>
        {revView?.snapshot && <PackingListDocument pl={revView.snapshot} />}
      </Modal>
      <Modal open={finishOpen} onClose={() => setFinishOpen(false)} title="Finish packing against the plan" size="md"
        footer={<><Button variant="secondary" onClick={() => setFinishOpen(false)}>Cancel</Button>
          <Button onClick={finishPlan} id="pl-finish-go" disabled={n0(ps?.short_qty) > 0 && !shortReason.trim()}>Finish packing</Button></>}>
        <div className="space-y-3 text-sm text-slate-700" id="pl-finish-modal">
          <p>The list is rebuilt from the {fmtNumber(ps?.ready_cartons ?? 0)} packed carton(s) — same carton numbers as the buyer list — and goes back to draft for weights and Confirm. Every carton packed for it must be posted and verified / sealed.</p>
          {n0(ps?.short_qty) > 0 ? (<>
            <p className="rounded-md bg-red-50 p-2 text-red-800"><b>{fmtNumber(ps.short_qty)} PCS of the plan are not packed</b> ({ps.not_packed_cartons} carton(s) not packed, {ps.short_cartons} packed short).</p>
            <label className="flex items-start gap-2"><input type="radio" name="short" id="short-follow" checked={shortAction === 'TO_FOLLOW'} onChange={() => setShortAction('TO_FOLLOW')} />
              <span><b>We make it and send it later</b> — a follow-up packing list (plan) is made with the balance, same buyer / destination.</span></label>
            <label className="flex items-start gap-2"><input type="radio" name="short" id="short-debit" checked={shortAction === 'DEBIT'} onChange={() => setShortAction('DEBIT')} />
              <span><b>The buyer debits it</b> — the shortage is recorded on this list.</span></label>
            <Textarea label="Reason" required rows={2} value={shortReason} onChange={(e) => setShortReason(e.target.value)} id="short-reason" />
          </>) : <p className="text-emerald-700">Everything on the plan is packed.</p>}
        </div>
      </Modal>
      <Modal open={overOpen} onClose={() => setOverOpen(false)} title="Confirm with over-shipment" size="sm"
        subtitle={`${fmtNumber(saved?.over_shipment?.qty ?? 0)} PCS above the order qty`}
        footer={<><Button variant="secondary" onClick={() => setOverOpen(false)}>Cancel</Button><Button variant="danger" onClick={() => handleConfirm(overReason.trim())} disabled={!overReason.trim()} id="pl-over-go">Approve &amp; confirm</Button></>}>
        <p className="mb-3 text-sm text-slate-600">Shipped quantity is more than the buyer order for some sizes. Confirming needs the Approve Packing right; the reason is printed nowhere but kept on the list and in the audit trail.</p>
        <Textarea label="Approval reason" required value={overReason} onChange={(e) => setOverReason(e.target.value)} id="pl-over-reason" />
      </Modal>

      <Modal open={reopenOpen} onClose={() => setReopenOpen(false)} title={`Revise packing list ${header.pl_no ?? ''}`} size="sm"
        subtitle={`Opens revision ${(saved?.revision_no ?? 0) + 1}`}
        footer={<><Button variant="secondary" onClick={() => setReopenOpen(false)}>Cancel</Button><Button variant="danger" onClick={handleReopen} disabled={!reopenReason.trim()} id="pl-revise-go">Revise</Button></>}>
        <p className="mb-3 text-sm text-slate-600">A confirmed list cannot be edited. Revising freezes this confirmed version (Rev {saved?.revision_no ?? 0}) in the history and sends the list back to DRAFT as the next revision. Not possible once a shipment uses it. The reason is kept with the revision and in the audit trail.</p>
        <Textarea label="Reason" required value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
      </Modal>
    </div>
  );
}

interface CartonInfo { carton_no: string; pack_no: string; status: string; is_partial: boolean; polybag_qty: number; qty: number }

function ReqInput({ label, value, onChange, id }: { label: string; value: string; onChange: (v: string) => void; id: string }) {
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-slate-500">{label}
      <input id={id} className="input h-7 w-24 py-0 text-right text-xs" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))} />
    </label>
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
  pickStyle: (bi: number, ri: number, ii: number, v: string) => void;
  pickColour: (bi: number, ri: number, ii: number, v: string) => void;
  hasOrder: boolean;
  cartonInfo: Record<number, CartonInfo>;
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
              <th className={th}>Packed cartons</th>
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
                  <td className={td + ' w-28'}><input className={cellIn} disabled={ro} value={it.style_no} list={p.hasOrder ? 'pl-order-styles' : undefined}
                    placeholder={p.hasOrder && !ro ? 'Pick…' : undefined} onChange={(e) => p.pickStyle(bi, ri, ii, e.target.value)} /></td>
                  <td className={td + ' w-40'}><input className={cellIn} disabled={ro} value={it.style_name} onChange={(e) => p.updItem(bi, ri, ii, { style_name: e.target.value })} /></td>
                  <td className={td + ' w-28'}><input className={cellIn} disabled={ro} value={it.colour} list={p.hasOrder ? `pl-order-colours-${normKey(it.style_no)}` : undefined}
                    placeholder={p.hasOrder && !ro ? 'Pick…' : undefined} onChange={(e) => p.pickColour(bi, ri, ii, e.target.value)} /></td>
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
                    <td className={tdN + ' whitespace-nowrap text-left'} rowSpan={span}>
                      <PackedCell ids={r.source_carton_ids} info={p.cartonInfo} />
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
              <td className="border border-slate-200" />
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

/** Source of a carton row: posted cartons (with polybags, partial count) or a warning for typed rows. */
function PackedCell({ ids, info }: { ids?: number[] | null; info: Record<number, CartonInfo> }) {
  if (!ids?.length) return <span className="text-[10px] font-medium text-amber-700" data-testid="row-not-packed" title="Typed by hand or from the order — not checked against posted cartons">⚠ not from packed cartons</span>;
  const cs = ids.map((i) => info[i]).filter(Boolean);
  const bags = [...new Set(cs.map((c) => c.polybag_qty))];
  const partial = cs.filter((c) => c.is_partial).length;
  return (
    <span className="text-[10px] text-emerald-700" data-testid="row-packed" title={cs.map((c) => `${c.pack_no} ${c.carton_no}: ${c.qty} pcs, ${c.polybag_qty} polybag(s), ${c.status}`).join('\n')}>
      ✓ {ids.length} ctn{bags.length === 1 && bags[0] ? ` · ${bags[0]} polybag${bags[0] > 1 ? 's' : ''}/ctn` : ''}{partial ? ` · ${partial} partial` : ''}
    </span>
  );
}
