import { useEffect, useMemo, useState } from 'react';
import { ClaimDrawer, DynamicFields, StatusPill, cleanValues, useBenefitMeta, type Meta } from './benefitShared';
import { useLookup } from '../../hooks/useLookup';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileText, Plus, Save, Trash2, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Card, Button, Input, Select, Badge, LoadingBlock, ErrorState, SearchInput, useDebounced, ConfirmDialog } from '../../components/ui';
import { DataTable } from '../../components/DataTable';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { fmtDate, fmtDecimal } from '../../lib/format';

/**
 * Shipping bill from the commercial invoice (client voice note + yellow-marked ICEGATE "LET EXPORT COPY", 23-Oct-2026).
 * Picking the final commercial invoice fills the invoice no / date / value / currency / rate / ports / packages; the
 * yellow fields of the client's PDF are entered here (SB no + date, FOB ₹, freight, exchange rate, DBK, IGST, RoDTEP,
 * RoSCTL). The incentives become Finance claims (received / credited is tracked there) and go into the order's P&L.
 */
const errMsg = (e: unknown, f = 'Something went wrong') => {
  if (e instanceof ApiError) { const fe = Object.values(e.fieldErrors); return fe.length && e.code === 'VALIDATION_ERROR' ? fe.join(' · ') : e.message; }
  return f;
};
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const inr = (v: unknown) => `₹ ${fmtDecimal(v, 2)}`;

export function ShippingBillsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const list = useQuery({ queryKey: ['shipping-bills', dq, page], queryFn: async () => http.get<{ data: any[]; pagination: any }>('/shipping-bills', { q: dq || undefined, page, pageSize: 25 }) });
  return (
    <div>
      <PageHeader title="Shipping Bills" breadcrumb={['Export']} subtitle="Customs shipping bill from the final commercial invoice — with drawback, RoDTEP, RoSCTL and IGST"
        actions={can('EXPORT.CREATE') && <Button id="sb-new" onClick={() => nav('/export/shipping-bills/new')}><Plus size={15} />New shipping bill</Button>} />
      <div className="card mb-3 p-3"><SearchInput className="w-72" value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="SB no, invoice, order, buyer…" /></div>
      <DataTable rows={list.data?.data ?? []} loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} rowKey={(r: any) => r.id}
        onRowClick={(r: any) => nav(`/export/shipping-bills/${r.id}`)} pagination={list.data?.pagination} onPage={setPage} emptyTitle="No shipping bills"
        columns={[
          { key: 'sb_no', header: 'S.B. No · Date', render: (r: any) => <div><p className="tabular-nums text-small font-semibold text-brand-700">{r.sb_no}</p><p className="text-caption text-slate-500">{fmtDate(r.sb_date)}</p></div> },
          { key: 'port_code', header: 'Port · Mode', render: (r: any) => <span className="text-small">{r.port_code ?? '—'}{r.mode ? ` · ${r.mode === 'AIR' ? 'Air' : r.mode === 'SEA' ? 'Sea' : r.mode}` : ''}</span> },
          { key: 'invoice_no', header: 'Inv. No & Date', render: (r: any) => <div><p className="tabular-nums text-small">{r.invoice_no ?? r.ci_invoice_no}</p><p className="text-caption text-slate-500">{fmtDate(r.invoice_date)} · {r.buyer_name ?? ''}</p></div> },
          { key: 'invoice_value_fc', header: 'Inv. Value', align: 'right', render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.invoice_value_fc, 2)}` },
          { key: 'exchange_rate', header: 'Ex. Rate', align: 'right', render: (r: any) => fmtDecimal(r.exchange_rate, 2) },
          { key: 'fob_inr', header: 'FOB ₹', align: 'right', render: (r: any) => fmtDecimal(r.fob_inr, 2) },
          { key: 'drawback_amount', header: 'Drawback', align: 'right', render: (r: any) => fmtDecimal(r.drawback_amount, 2) },
          { key: 'igst_amount', header: 'IGST', align: 'right', render: (r: any) => (Number(r.lut) ? <Badge tone="slate">LUT</Badge> : fmtDecimal(r.igst_amount, 2)) },
          { key: 'rosctl_amount', header: 'RoSCTL', align: 'right', render: (r: any) => fmtDecimal(r.rosctl_amount, 2) },
          { key: 'rodtep_amount', header: 'RoDTEP', align: 'right', render: (r: any) => fmtDecimal(r.rodtep_amount, 2) },
        ]} />
    </div>
  );
}

const FIELDS = ['invoice_id', 'sb_no', 'sb_date', 'port_code', 'port_id', 'mode', 'port_of_loading', 'port_of_discharge', 'country_dest', 'exchange_rate', 'fob_inr', 'freight_inr', 'insurance_inr',
  'drawback_amount', 'igst_value', 'igst_amount', 'rodtep_amount', 'rosctl_amount', 'leo_no', 'leo_date', 'cha_name', 'cha_ref', 'ad_code', 'packages', 'gross_weight_kg',
  'bl_awb_no', 'bl_awb_date', 'brc_due_date', 'scheme_code', 'remarks', 'sb_pdf_url', 'sb_pdf_name', 'sb_pdf_pages'];
/** Fields read from the customs PDF that go into the form (the rest of what is read is kept for reference). */
const PDF_FILL = ['sb_no', 'sb_date', 'port_code', 'mode', 'exchange_rate', 'freight_inr', 'insurance_inr', 'fob_inr', 'drawback_amount', 'igst_value', 'igst_amount', 'rodtep_amount', 'rosctl_amount', 'leo_date'];

export function ShippingBillDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const detail = useQuery({ queryKey: ['shipping-bill', id], queryFn: async () => (await http.get<{ data: any }>(`/shipping-bills/${id}`)).data, enabled: !isNew });
  const invoices = useQuery({ queryKey: ['sb-invoices'], queryFn: async () => (await http.get<{ data: any[] }>('/shipping-bills/invoices')).data });
  const [v, setV] = useState<any>(isNew ? { sb_date: new Date().toISOString().slice(0, 10), mode: 'SEA', freight_inr: 0, insurance_inr: 0 } : null);
  const [src, setSrc] = useState<any | null>(null);
  const [fobTyped, setFobTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [pdfRead, setPdfRead] = useState<Record<string, unknown> | null>(null);
  const [pdfNote, setPdfNote] = useState<{ found: number; parse_error: string | null; warnings: string[] } | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [claim, setClaim] = useState<number | null>(null);
  // benefit grid (spec v2 §6): scheme rows beyond the four customs columns, and claim custom fields — keyed by scheme id
  const [extra, setExtra] = useState<Record<number, { declared_amount: string; cf: Record<string, unknown> }>>({});
  const meta = useBenefitMeta();
  const ports = useLookup('ports');
  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data; const x: any = { row_version: d.row_version };
    for (const k of FIELDS) x[k] = d[k] ?? '';
    setV(x); setSrc(d.source); setFobTyped(true); setPdfRead(d.pdf_read_fields ?? null); setPdfNote(null);
    setExtra(Object.fromEntries((d.incentives ?? []).filter((c: any) => c.scheme_id).map((c: any) => [c.scheme_id, { declared_amount: c.declared_amount == null ? '' : String(c.declared_amount), cf: c.custom_field_values ?? {} }])));
  }, [detail.data]);
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const pickInvoice = async (invoiceId: string) => {
    set('invoice_id', invoiceId);
    if (!invoiceId) { setSrc(null); return false; }
    try {
      const s = (await http.get<{ data: any }>(`/shipping-bills/invoice-source/${invoiceId}`)).data;
      setSrc(s);
      setV((o: any) => ({ ...o, invoice_id: invoiceId, exchange_rate: s.exchange_rate ?? '', port_of_loading: s.port_of_loading ?? '', port_of_discharge: s.port_of_discharge ?? '',
        country_dest: s.country_dest ?? '', packages: s.packages ?? '', gross_weight_kg: s.gross_weight_kg ?? '', igst_value: s.igst_value || '', igst_amount: s.igst_amount || '' }));
      setFobTyped(false);
      return true;
    } catch (e) { toast(errMsg(e), 'error'); return false; }
  };
  // client voice note 23-Oct-2026: the customs SB PDF fills the form once (pages 1–2 are read on upload); the user checks
  // and corrects, and the PDF stays attached for reference. A PDF that cannot be read is attached and filled by hand.
  const importPdf = async (f: File) => {
    if (f.size > 15 * 1024 * 1024) { toast('The PDF is larger than 15 MB', 'error'); return; }
    setPdfBusy(true);
    try {
      const data = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(f); });
      const r = (await http.post<{ data: any }>('/shipping-bills/import-pdf', { filename: f.name, data, shipping_bill_id: isNew ? null : Number(id) })).data;
      if (isNew && r.invoice?.selectable && String(r.invoice.id) !== String(v.invoice_id)) await pickInvoice(String(r.invoice.id));
      const read = r.fields ?? {};
      setV((o: any) => {
        const x = { ...o, sb_pdf_url: r.file.url, sb_pdf_name: r.file.name, sb_pdf_pages: r.file.pages ?? '' };
        for (const k of PDF_FILL) if (read[k] != null && read[k] !== '') x[k] = read[k];
        return x;
      });
      if (read.fob_inr != null) setFobTyped(true);
      setPdfRead(r.fields ?? null);
      setPdfNote({ found: r.found, parse_error: r.parse_error, warnings: r.warnings ?? [] });
      toast(r.parse_error ? `PDF attached — ${r.parse_error}` : `PDF read: ${r.found} fields filled — check them and save`, r.parse_error ? 'error' : undefined);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setPdfBusy(false); }
  };
  /** "PDF: 50,153" under a field changed after the PDF filled it (so a correction is visible). */
  const pdfHint = (k: string) => {
    if (!pdfRead || pdfRead[k] == null || v?.[k] == null || v[k] === '') return undefined;
    const a = pdfRead[k]; const b = v[k];
    const same = typeof a === 'number' ? Math.abs(a - Number(b)) < 0.005 : String(a) === String(b);
    return same ? undefined : `PDF: ${typeof a === 'number' ? fmtDecimal(a, 2) : String(a)}`;
  };
  // FOB ₹ = invoice value × rate − freight − insurance, until typed from the shipping bill
  const fobCalc = useMemo(() => (src ? r2(Number(src.invoice_value_fc) * (Number(v?.exchange_rate) || 0) - (Number(v?.freight_inr) || 0) - (Number(v?.insurance_inr) || 0)) : 0), [src, v?.exchange_rate, v?.freight_inr, v?.insurance_inr]);
  useEffect(() => { if (src && !fobTyped) setV((o: any) => ({ ...o, fob_inr: fobCalc > 0 ? fobCalc : '' })); }, [fobCalc, src, fobTyped]);
  const editable = isNew ? can('EXPORT.CREATE') : can('EXPORT.UPDATE');
  const save = async () => {
    setBusy(true);
    try {
      const num = (x: any) => (x === '' || x == null ? null : Number(x));
      const b: any = { ...v };
      for (const k of ['invoice_id', 'exchange_rate', 'fob_inr', 'freight_inr', 'insurance_inr', 'drawback_amount', 'igst_value', 'igst_amount', 'rodtep_amount', 'rosctl_amount', 'packages', 'gross_weight_kg']) b[k] = num(v[k]);
      for (const k of FIELDS) if (b[k] === '') b[k] = null;
      if (src?.lut) { b.igst_amount = 0; b.igst_value = null; }   // export under LUT: no IGST (the field shows "0 — LUT")
      b.sb_pdf_pages = num(v.sb_pdf_pages);
      b.pdf_read_fields = v.sb_pdf_url ? pdfRead : null;
      b.port_id = num(v.port_id);
      // benefit rows: the four customs schemes keep their amount in the columns above; the others (and claim custom fields) go as rows
      b.benefits = Object.entries(extra).map(([sid, r]) => {
        const sc = meta.data?.schemes.find((x) => x.id === Number(sid));
        return { scheme_id: Number(sid), declared_amount: sc?.sb_field ? num(v[sc.sb_field]) : num(r.declared_amount), custom_field_values: cleanValues(r.cf) };
      });
      const r = isNew ? await http.post<{ data: any }>('/shipping-bills', b) : await http.put<{ data: any }>(`/shipping-bills/${id}`, b);
      toast(`Shipping bill saved — FOB ${inr(r.data.fob_inr)}${r.data.warnings?.length ? ` · ${r.data.warnings.join(' · ')}` : ''}`, r.data.warnings?.length ? 'error' : undefined);
      void qc.invalidateQueries({ queryKey: ['shipping-bills'] }); void qc.invalidateQueries({ queryKey: ['sb-invoices'] });
      if (isNew) nav(`/export/shipping-bills/${r.data.id}`, { replace: true }); else void detail.refetch();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  if (!isNew && detail.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && detail.error) return <div className="card"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div>;
  if (!v) return null;
  const d = detail.data;
  const invOptions = (invoices.data ?? []).filter((x) => x.selectable || String(x.id) === String(v.invoice_id))
    .map((x) => ({ value: x.id, label: `${x.invoice_no} · ${fmtDate(x.invoice_date)} · ${x.buyer_name ?? ''} · ${x.currency_code} ${fmtDecimal(x.total_value, 2)}` }));
  const drafts = (invoices.data ?? []).filter((x) => x.doc_status !== 'FINAL' && !x.sb_no).length;
  const num = (k: string, label: string, extra: any = {}) => (
    <Input label={label} type="number" step="any" value={v[k] ?? ''} id={`sb-${k}`} disabled={!editable} onChange={(e) => set(k, e.target.value)} hint={pdfHint(k)} {...extra} />
  );
  // client 23-Oct-2026 (handwritten list): only these fields — the rest of the customs copy is not entered
  return (
    <div>
      <PageHeader breadcrumb={['Export', 'Shipping Bills']} title={isNew ? 'New shipping bill' : <span className="tabular-nums">SB {d.sb_no}</span>}
        subtitle={isNew ? 'Pick the final commercial invoice — invoice no, date and value come from it' : `${d.buyer_name ?? ''} · ${d.so_no ?? ''} · invoice ${d.invoice_no}`}
        actions={<div className="flex gap-2">
          <Button variant="secondary" onClick={() => nav('/export/shipping-bills')}><ArrowLeft size={15} />Back</Button>
          {editable && <Button loading={busy} id="sb-save" onClick={() => void save()}><Save size={14} />Save</Button>}
          {!isNew && can('EXPORT.DELETE') && <Button variant="danger" onClick={() => setDel(true)}><Trash2 size={14} /></Button>}
        </div>} />
      <div className="space-y-4" id="sb-form">
        <Card title="Shipping bill" actions={<div className="flex items-center gap-2" id="sb-pdf">
          {v.sb_pdf_url && <a className="flex items-center gap-1 text-body text-brand-700 hover:underline" id="sb-pdf-link" href={v.sb_pdf_url} target="_blank" rel="noreferrer">
            <FileText size={14} />{v.sb_pdf_name || 'Shipping bill PDF'}{v.sb_pdf_pages ? ` · ${v.sb_pdf_pages} pages` : ''}</a>}
          {v.sb_pdf_url && editable && <button type="button" className="text-slate-400 hover:text-red-600" title="Remove the PDF (saved on Save)" id="sb-pdf-remove"
            onClick={() => { setV((o: any) => ({ ...o, sb_pdf_url: null, sb_pdf_name: null, sb_pdf_pages: null })); setPdfRead(null); setPdfNote(null); }}><X size={14} /></button>}
          {editable && <label className={clsx('btn-secondary btn-sm cursor-pointer', pdfBusy && 'opacity-60')} title="ICEGATE shipping bill PDF — the fields are read and filled for you to check">
            <Upload size={13} />{pdfBusy ? 'Reading…' : v.sb_pdf_url ? 'Replace customs PDF' : 'Upload customs SB PDF'}
            <input type="file" className="hidden" id="sb-pdf-file" accept=".pdf,application/pdf" disabled={pdfBusy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPdf(f); e.target.value = ''; }} /></label>}
        </div>}>
          {pdfNote && (
            <div id="sb-pdf-note" className={clsx('mx-4 mt-3 rounded-md border px-3 py-2 text-body', pdfNote.parse_error || pdfNote.warnings.length ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900')}>
              {pdfNote.parse_error ? <p>PDF attached for reference — {pdfNote.parse_error}.</p>
                : <p>{pdfNote.found} fields read from the PDF and filled below — check them against the PDF, correct anything wrong, then Save.</p>}
              {pdfNote.warnings.map((w) => <p key={w}>• {w}</p>)}
            </div>
          )}
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            <Select className="sm:col-span-4" label="Commercial invoice (final)" required id="sb-invoice" disabled={!isNew} placeholder="— Select —" options={invOptions} value={v.invoice_id}
              onChange={(e) => void pickInvoice(e.target.value)} hint={drafts ? `${drafts} draft invoice(s) not listed — finalise them first` : undefined} />
            <Input label="S.B. No" required type="text" id="sb-sb_no" value={v.sb_no ?? ''} hint={pdfHint('sb_no')} disabled={!editable} onChange={(e) => set('sb_no', e.target.value)} />
            <Input label="Date" required type="date" id="sb-sb_date" value={v.sb_date ?? ''} hint={pdfHint('sb_date')} disabled={!editable} onChange={(e) => set('sb_date', e.target.value)} />
            <Select label="Port of loading" id="sb-port_id" value={v.port_id ?? ''} disabled={!editable} placeholder="— Select port —"
              options={(ports.data ?? []).map((p) => ({ value: p.id, label: p.label }))} hint={pdfHint('port_code') ?? (v.port_code ? `Code ${v.port_code}` : 'Port master: add more under Masters')}
              onChange={(e) => { const p = (ports.data ?? []).find((x) => String(x.id) === e.target.value); setV((o: any) => ({ ...o, port_id: e.target.value, port_code: (p?.port_code as string) ?? o.port_code, mode: (p?.mode as string) ?? o.mode, port_of_loading: (p?.port_name as string) ?? o.port_of_loading })); }} />
            <Input label="Port code" id="sb-port_code" value={v.port_code ?? ''} placeholder="INMAA4" disabled={!editable}
              onChange={(e) => { const code = e.target.value.toUpperCase(); const p = (ports.data ?? []).find((x) => x.port_code === code); setV((o: any) => ({ ...o, port_code: code, port_id: p ? String(p.id) : o.port_id })); }} />
            <Select label="Mode" id="sb-mode" value={v.mode ?? ''} disabled={!editable} onChange={(e) => set('mode', e.target.value)} options={[{ value: 'SEA', label: 'Sea' }, { value: 'AIR', label: 'Air' }, { value: 'ROAD', label: 'Road' }]} />
            <Input label="Inv. No & Date" id="sb-inv-no" value={src ? `${src.invoice_no} · ${fmtDate(src.invoice_date)}` : ''} placeholder="From the invoice" disabled />
            <Input label={`Inv. Value${src ? ` (${src.currency_code})` : ''}`} id="sb-inv-value" value={src ? fmtDecimal(src.invoice_value_fc, 2) : ''} placeholder="From the invoice" disabled />
            {num('exchange_rate', `Customs Exchange Rate${src ? ` (₹ per 1 ${src.currency_code})` : ''}`)}
            {num('freight_inr', 'Freight (₹)')}
            <Input label="FOB Value (₹)" type="number" step="any" id="sb-fob_inr" value={v.fob_inr ?? ''} disabled={!editable}
              onChange={(e) => { setFobTyped(true); set('fob_inr', e.target.value); }} hint={[pdfHint('fob_inr'), fobTyped ? `Worked out: ${inr(fobCalc)}` : 'Inv. value × exchange rate − freight'].filter(Boolean).join(' · ')} />

          </div>
          {meta.data && <BenefitGrid meta={meta.data} v={v} setV={setV} extra={extra} setExtra={setExtra} claims={isNew ? [] : d.incentives ?? []} lut={!!src?.lut}
            editable={editable} pdfHint={pdfHint} onOpen={setClaim} />}
        </Card>
      </div>
      {claim && <ClaimDrawer id={claim} onClose={() => { setClaim(null); void detail.refetch(); }} />}
      <ConfirmDialog open={del} title="Delete shipping bill" message={`Delete SB ${d?.sb_no ?? ''}? Its incentive claims are removed (not possible once money is received).`} busy={busy} onCancel={() => setDel(false)}
        onConfirm={async () => { setBusy(true); try { await http.del(`/shipping-bills/${id}`); toast('Shipping bill deleted'); void qc.invalidateQueries({ queryKey: ['shipping-bills'] }); nav('/export/shipping-bills'); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); setDel(false); } }} />
    </div>
  );
}

/**
 * Benefit grid of the shipping bill: the schemes marked "suggest on shipping bill" (DBK / IGST / RoSCTL / RoDTEP) as rows —
 * their amounts are the customs fields the PDF fills — plus "Add benefit" for any other active scheme of the master.
 * Each row becomes its own claim; receipts / scrips are recorded on it later, each on its own date.
 */
function BenefitGrid({ meta, v, setV, extra, setExtra, claims, lut, editable, pdfHint, onOpen }: {
  meta: Meta; v: any; setV: (f: (o: any) => any) => void; extra: Record<number, { declared_amount: string; cf: Record<string, unknown> }>;
  setExtra: (f: (o: any) => any) => void; claims: any[]; lut: boolean; editable: boolean; pdfHint: (k: string) => string | undefined; onOpen: (id: number) => void;
}) {
  const sbDate = v.sb_date || new Date().toISOString().slice(0, 10);
  const effective = (s: Meta['schemes'][number]) => !!s.is_active && (!s.effective_from || s.effective_from <= sbDate) && (!s.effective_to || s.effective_to >= sbDate);
  const shown = meta.schemes.filter((s) => (s.sb_field && s.is_suggested && effective(s)) || claims.some((c) => c.scheme_id === s.id) || extra[s.id] || (s.sb_field && Number(v[s.sb_field]) > 0));
  const addable = meta.schemes.filter((s) => effective(s) && !shown.includes(s));
  const [add, setAdd] = useState('');
  const total = shown.reduce((t, s) => t + (Number(s.sb_field ? v[s.sb_field] : extra[s.id]?.declared_amount) || 0), 0);
  const row = (id: number) => extra[id] ?? { declared_amount: '', cf: {} };
  return (
    <div className="border-t border-slate-100" id="sb-benefits">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <p className="text-body font-semibold text-slate-700">Export benefits <span className="font-normal text-slate-500">— each is tracked on its own (received on its own date); cash and scrip kept apart</span></p>
        {editable && addable.length > 0 && <div className="flex items-center gap-2"><Select className="w-56" id="sb-add-benefit" value={add} placeholder="Add benefit…" options={addable.map((s) => ({ value: s.id, label: s.display_name }))} onChange={(e) => setAdd(e.target.value)} />
          <Button size="sm" variant="secondary" id="sb-add-benefit-btn" disabled={!add} onClick={() => { setExtra((o: any) => ({ ...o, [Number(add)]: { declared_amount: '', cf: {} } })); setAdd(''); }}><Plus size={13} />Add</Button></div>}
      </div>
      <table className="mt-2 w-full">
        <thead><tr><th className="th">Benefit</th><th className="th w-44">Declared ₹</th><th className="th">Scheme fields</th><th className="th text-right">Cash ₹</th><th className="th text-right">Scrip issued ₹</th><th className="th text-right">Pending ₹</th><th className="th">Status</th></tr></thead>
        <tbody>
          {shown.map((s) => {
            const c = claims.find((x) => x.scheme_id === s.id);
            const claimFields = s.custom_fields.filter((f) => f.applies_to === 'CLAIM');
            const igstLut = s.sb_field === 'igst_amount' && lut;
            return (
              <tr key={s.id} data-sb-inc={s.code} className="align-top">
                <td className="td text-body font-semibold">{s.display_name}<p className="text-caption font-normal text-slate-400">{s.tracking_mode === 'CASH' ? 'cash' : s.tracking_mode === 'SCRIP' ? 'scrip' : s.tracking_mode.toLowerCase()}{!s.is_active && ' · inactive'}</p></td>
                <td className="td">{igstLut ? <Input id="sb-igst_amount" value="0 — export under LUT" disabled />
                  : s.sb_field ? <Input type="number" step="any" min={0} id={`sb-${s.sb_field}`} value={v[s.sb_field] ?? ''} disabled={!editable} hint={pdfHint(s.sb_field)} onChange={(e) => setV((o: any) => ({ ...o, [s.sb_field!]: e.target.value }))} />
                    : <Input type="number" step="any" min={0} id={`sb-benefit-${s.code}`} value={row(s.id).declared_amount} disabled={!editable} placeholder="not known yet"
                      onChange={(e) => setExtra((o: any) => ({ ...o, [s.id]: { ...row(s.id), declared_amount: e.target.value } }))} />}</td>
                <td className="td">{claimFields.length ? <div className="grid gap-2 sm:grid-cols-2"><DynamicFields fields={claimFields} values={row(s.id).cf} disabled={!editable} idPrefix={`sb-cf-${s.code}`}
                  onChange={(cf) => setExtra((o: any) => ({ ...o, [s.id]: { ...row(s.id), cf } }))} /></div> : <span className="text-small text-slate-300">—</span>}</td>
                <td className="td text-right tabular-nums">{c ? fmtDecimal(c.received_amount, 2) : '—'}</td>
                <td className="td text-right tabular-nums text-indigo-700">{c && s.tracking_mode !== 'CASH' ? fmtDecimal(c.scrip_issued, 2) : '—'}</td>
                <td className={clsx('td text-right tabular-nums', c?.outstanding > 0 && 'font-semibold text-amber-700')}>{c ? fmtDecimal(c.outstanding, 2) : '—'}</td>
                <td className="td">{c ? <button className="text-left" title="Open — record receipts / scrip on their dates" data-open-claim={c.id} onClick={() => onOpen(c.id)}><StatusPill status={c.status} label={c.status_label} tone={c.status_tone} />
                  {c.receipts?.length > 0 && <span className="block text-caption text-slate-500">{c.receipts.map((r: any) => `${fmtDate(r.receipt_date)} ₹${fmtDecimal(r.amount, 2)}`).join(' · ')}</span>}</button>
                  : <span className="text-caption text-slate-400">{extra[s.id] || Number(s.sb_field ? v[s.sb_field] : 0) > 0 ? 'made on save' : 'no claim (0)'}</span>}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr className="border-t border-slate-200"><td className="td text-small font-semibold">Total declared</td><td className="td text-body font-semibold tabular-nums" id="sb-inc-total">{inr(total)}</td><td colSpan={5} className="td text-small text-slate-500">Order profit uses each scheme’s policy (IGST refund is not income)</td></tr></tfoot>
      </table>
    </div>
  );
}
