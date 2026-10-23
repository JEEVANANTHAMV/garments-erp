import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileText, Plus, Save, Trash2, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Card, Button, Input, Select, Textarea, Badge, LoadingBlock, ErrorState, SearchInput, useDebounced, ConfirmDialog } from '../../components/ui';
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
          { key: 'sb_no', header: 'S.B. No · Date', render: (r: any) => <div><p className="font-mono text-[12px] font-semibold text-brand-700">{r.sb_no}</p><p className="text-[11px] text-slate-500">{fmtDate(r.sb_date)}</p></div> },
          { key: 'port_code', header: 'Port · Mode', render: (r: any) => <span className="text-[12px]">{r.port_code ?? '—'}{r.mode ? ` · ${r.mode === 'AIR' ? 'Air' : r.mode === 'SEA' ? 'Sea' : r.mode}` : ''}</span> },
          { key: 'invoice_no', header: 'Inv. No & Date', render: (r: any) => <div><p className="font-mono text-[12px]">{r.invoice_no ?? r.ci_invoice_no}</p><p className="text-[11px] text-slate-500">{fmtDate(r.invoice_date)} · {r.buyer_name ?? ''}</p></div> },
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

const FIELDS = ['invoice_id', 'sb_no', 'sb_date', 'port_code', 'mode', 'port_of_loading', 'port_of_discharge', 'country_dest', 'exchange_rate', 'fob_inr', 'freight_inr', 'insurance_inr',
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
  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data; const x: any = { row_version: d.row_version };
    for (const k of FIELDS) x[k] = d[k] ?? '';
    setV(x); setSrc(d.source); setFobTyped(true); setPdfRead(d.pdf_read_fields ?? null); setPdfNote(null);
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
      b.sb_pdf_pages = num(v.sb_pdf_pages);
      b.pdf_read_fields = v.sb_pdf_url ? pdfRead : null;
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
  const incTotal = (Number(v.drawback_amount) || 0) + (Number(v.rodtep_amount) || 0) + (Number(v.rosctl_amount) || 0);
  const num = (k: string, label: string, extra: any = {}) => (
    <Input label={label} type="number" step="any" value={v[k] ?? ''} id={`sb-${k}`} disabled={!editable} onChange={(e) => set(k, e.target.value)} hint={pdfHint(k)} {...extra} />
  );
  // client 23-Oct-2026 (handwritten list): only these fields — the rest of the customs copy is not entered
  return (
    <div>
      <PageHeader breadcrumb={['Export', 'Shipping Bills']} title={isNew ? 'New shipping bill' : <span className="font-mono">SB {d.sb_no}</span>}
        subtitle={isNew ? 'Pick the final commercial invoice — invoice no, date and value come from it' : `${d.buyer_name ?? ''} · ${d.so_no ?? ''} · invoice ${d.invoice_no}`}
        actions={<div className="flex gap-2">
          <Button variant="secondary" onClick={() => nav('/export/shipping-bills')}><ArrowLeft size={15} />Back</Button>
          {editable && <Button loading={busy} id="sb-save" onClick={() => void save()}><Save size={14} />Save</Button>}
          {!isNew && can('EXPORT.DELETE') && <Button variant="danger" onClick={() => setDel(true)}><Trash2 size={14} /></Button>}
        </div>} />
      <div className="space-y-4" id="sb-form">
        <Card title="Shipping bill" actions={<div className="flex items-center gap-2" id="sb-pdf">
          {v.sb_pdf_url && <a className="flex items-center gap-1 text-[12.5px] text-brand-700 hover:underline" id="sb-pdf-link" href={v.sb_pdf_url} target="_blank" rel="noreferrer">
            <FileText size={14} />{v.sb_pdf_name || 'Shipping bill PDF'}{v.sb_pdf_pages ? ` · ${v.sb_pdf_pages} pages` : ''}</a>}
          {v.sb_pdf_url && editable && <button type="button" className="text-slate-400 hover:text-red-600" title="Remove the PDF (saved on Save)" id="sb-pdf-remove"
            onClick={() => { setV((o: any) => ({ ...o, sb_pdf_url: null, sb_pdf_name: null, sb_pdf_pages: null })); setPdfRead(null); setPdfNote(null); }}><X size={14} /></button>}
          {editable && <label className={clsx('btn-secondary btn-sm cursor-pointer', pdfBusy && 'opacity-60')} title="ICEGATE shipping bill PDF — the fields are read and filled for you to check">
            <Upload size={13} />{pdfBusy ? 'Reading…' : v.sb_pdf_url ? 'Replace customs PDF' : 'Upload customs SB PDF'}
            <input type="file" className="hidden" id="sb-pdf-file" accept=".pdf,application/pdf" disabled={pdfBusy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importPdf(f); e.target.value = ''; }} /></label>}
        </div>}>
          {pdfNote && (
            <div id="sb-pdf-note" className={clsx('mx-4 mt-3 rounded-md border px-3 py-2 text-[12.5px]', pdfNote.parse_error || pdfNote.warnings.length ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900')}>
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
            <Input label="Port" id="sb-port_code" value={v.port_code ?? ''} placeholder="INMAA4" hint={pdfHint('port_code')} disabled={!editable} onChange={(e) => set('port_code', e.target.value.toUpperCase())} />
            <Select label="Mode" id="sb-mode" value={v.mode ?? ''} disabled={!editable} onChange={(e) => set('mode', e.target.value)} options={[{ value: 'AIR', label: 'Air' }, { value: 'SEA', label: 'Sea' }]} />
            <Input label="Inv. No & Date" id="sb-inv-no" value={src ? `${src.invoice_no} · ${fmtDate(src.invoice_date)}` : ''} placeholder="From the invoice" disabled />
            <Input label={`Inv. Value${src ? ` (${src.currency_code})` : ''}`} id="sb-inv-value" value={src ? fmtDecimal(src.invoice_value_fc, 2) : ''} placeholder="From the invoice" disabled />
            {num('exchange_rate', `Customs Exchange Rate${src ? ` (₹ per 1 ${src.currency_code})` : ''}`)}
            {num('freight_inr', 'Freight (₹)')}
            <Input label="FOB Value (₹)" type="number" step="any" id="sb-fob_inr" value={v.fob_inr ?? ''} disabled={!editable}
              onChange={(e) => { setFobTyped(true); set('fob_inr', e.target.value); }} hint={[pdfHint('fob_inr'), fobTyped ? `Worked out: ${inr(fobCalc)}` : 'Inv. value × exchange rate − freight'].filter(Boolean).join(' · ')} />
            {num('drawback_amount', 'Drawback (₹)')}
            {src?.lut ? <Input label="IGST Amount (₹)" id="sb-igst_amount" value="0 — export under LUT" disabled /> : num('igst_amount', 'IGST Amount (₹)')}
            {num('rosctl_amount', 'RoSCTL Amount (₹)')}
            {num('rodtep_amount', 'RoDTEP Amount (₹)')}
            <div className="self-end text-[12.5px] sm:col-span-3">Incentives (drawback + RoSCTL + RoDTEP): <b id="sb-inc-total">{inr(incTotal)}</b> — go to Finance and the order's profit</div>
          </div>
          {!isNew && d.incentives?.length > 0 && (
            <table className="w-full border-t border-slate-100" id="sb-incentives">
              <thead><tr><th className="th">Claim (Finance)</th><th className="th text-right">Claim ₹</th><th className="th text-right">Received ₹</th><th className="th">Status</th><th className="th">Credited</th></tr></thead>
              <tbody>{d.incentives.map((x: any) => (
                <tr key={x.id}><td className="td text-[12px]">{x.incentive_type.replace('_', ' ')}</td><td className="td text-right tabular-nums">{fmtDecimal(x.claim_amount, 2)}</td>
                  <td className="td text-right tabular-nums">{fmtDecimal(x.received_amount, 2)}</td><td className="td"><Badge tone={x.status === 'CREDITED' ? 'green' : x.status === 'REJECTED' ? 'red' : 'amber'}>{x.status.toLowerCase()}</Badge></td>
                  <td className="td text-[12px]">{x.credit_date ? fmtDate(x.credit_date) : '—'}</td></tr>))}</tbody>
            </table>
          )}
        </Card>
      </div>
      <ConfirmDialog open={del} title="Delete shipping bill" message={`Delete SB ${d?.sb_no ?? ''}? Its incentive claims are removed (not possible once money is received).`} busy={busy} onCancel={() => setDel(false)}
        onConfirm={async () => { setBusy(true); try { await http.del(`/shipping-bills/${id}`); toast('Shipping bill deleted'); void qc.invalidateQueries({ queryKey: ['shipping-bills'] }); nav('/export/shipping-bills'); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); setDel(false); } }} />
    </div>
  );
}

/* ================================================================ Finance: export incentives */
export function ExportIncentivesPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useQuery({ queryKey: ['export-incentives', status, dq], queryFn: async () => http.get<{ data: any[]; totals: any }>('/export-incentives', { status: status || undefined, q: dq || undefined }) });
  const [edit, setEdit] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await http.put(`/export-incentives/${edit.id}`, { status: edit.status, received_amount: edit.received_amount === '' ? null : Number(edit.received_amount), credit_date: edit.credit_date || null,
        scrip_no: edit.scrip_no || null, remarks: edit.remarks || null });
      toast('Claim updated'); setEdit(null); void list.refetch();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const rows = list.data?.data ?? [];
  return (
    <div>
      <PageHeader title="Export Incentives" breadcrumb={['Finance']} subtitle="Drawback, RoDTEP, RoSCTL and IGST refund claims — entered on the shipping bill; record here what is received" />
      <div className="card mb-3 flex flex-wrap items-end gap-2.5 p-3">
        <SearchInput className="w-64" value={q} onChange={setQ} placeholder="SB no, invoice, scrip…" />
        <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All" options={['PENDING', 'CLAIMED', 'CREDITED', 'REJECTED'].map((x) => ({ value: x, label: x.toLowerCase() }))} />
        {list.data?.totals && <span className="ml-auto text-[12.5px]" id="inc-totals">Claimed {inr(list.data.totals.claimed)} · received {inr(list.data.totals.received)} · outstanding <b>{inr(list.data.totals.claimed - list.data.totals.received)}</b></span>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full" id="inc-list">
          <thead><tr><th className="th">Type</th><th className="th">Shipping bill</th><th className="th">Invoice / order</th><th className="th text-right">Claim ₹</th><th className="th text-right">Received ₹</th>
            <th className="th text-right">Outstanding ₹</th><th className="th">Status</th><th className="th">Credited</th><th className="th" /></tr></thead>
          <tbody>
            {list.isLoading && <tr><td colSpan={9}><LoadingBlock rows={3} /></td></tr>}
            {!list.isLoading && !rows.length && <tr><td colSpan={9} className="td py-8 text-center text-slate-400">No claims yet — they come from the shipping bills</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="row-hover">
                <td className="td text-[12px] font-semibold">{r.incentive_type.replace('_', ' ')}{r.source === 'SHIPPING_BILL' && <span className="ml-1 text-[10.5px] font-normal text-slate-400">from SB</span>}</td>
                <td className="td text-[12px]">{r.shipping_bill_id ? <Link className="font-mono text-brand-700 hover:underline" to={`/export/shipping-bills/${r.shipping_bill_id}`}>{r.sb_no}</Link> : '—'}<p className="text-slate-500">{fmtDate(r.sb_date)}</p></td>
                <td className="td text-[12px]">{r.invoice_no ?? '—'}<p className="text-slate-500">{r.so_no ?? ''} {r.buyer_name ?? ''}</p></td>
                <td className="td text-right tabular-nums">{fmtDecimal(r.claim_amount, 2)}</td>
                <td className="td text-right tabular-nums">{fmtDecimal(r.received_amount, 2)}</td>
                <td className={clsx('td text-right tabular-nums', r.outstanding > 0 && 'font-semibold text-amber-700')}>{fmtDecimal(r.outstanding, 2)}</td>
                <td className="td"><Badge tone={r.status === 'CREDITED' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber'}>{r.status.toLowerCase()}</Badge></td>
                <td className="td text-[12px]">{r.credit_date ? fmtDate(r.credit_date) : '—'}</td>
                <td className="td">{can('FINANCE.UPDATE') && <Button size="sm" variant="ghost" data-inc={r.id} onClick={() => setEdit({ ...r, received_amount: r.received_amount ?? '', credit_date: r.credit_date ?? '' })}>Update</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={() => setEdit(null)}>
          <div className="card w-full max-w-lg p-4" onClick={(e) => e.stopPropagation()} id="inc-edit">
            <h3 className="mb-3 text-[14px] font-semibold">{edit.incentive_type.replace('_', ' ')} · SB {edit.sb_no ?? '—'} · claim {inr(edit.claim_amount)}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} options={['PENDING', 'CLAIMED', 'CREDITED', 'REJECTED'].map((x) => ({ value: x, label: x.toLowerCase() }))} />
              <Input label="Scrip / reference no" value={edit.scrip_no ?? ''} onChange={(e) => setEdit({ ...edit, scrip_no: e.target.value })} />
              <Input label="Received (₹)" type="number" step="any" id="inc-received" value={edit.received_amount} onChange={(e) => setEdit({ ...edit, received_amount: e.target.value })} />
              <Input label="Credit date" type="date" id="inc-credit-date" value={edit.credit_date ?? ''} onChange={(e) => setEdit({ ...edit, credit_date: e.target.value })} />
              <Textarea className="sm:col-span-2" label="Remarks" value={edit.remarks ?? ''} onChange={(e) => setEdit({ ...edit, remarks: e.target.value })} />
            </div>
            <div className="mt-3 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><Button loading={busy} id="inc-save" onClick={() => void save()}>Save</Button></div>
          </div>
        </div>
      )}
    </div>
  );
}
