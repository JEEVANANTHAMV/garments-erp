import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Save, Trash2 } from 'lucide-react';
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
/** a field entered from the shipping bill (yellow on the client's PDF) */
const Y = 'rounded-md bg-amber-50 ring-1 ring-amber-300 p-1.5';

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
          { key: 'sb_no', header: 'SB no · date', render: (r: any) => <div><p className="font-mono text-[12px] font-semibold text-brand-700">{r.sb_no}</p><p className="text-[11px] text-slate-500">{fmtDate(r.sb_date)}{r.port_code ? ` · ${r.port_code}` : ''}</p></div> },
          { key: 'invoice_no', header: 'Invoice', render: (r: any) => <div><p className="font-mono text-[12px]">{r.invoice_no ?? r.ci_invoice_no}</p><p className="text-[11px] text-slate-500">{r.currency_code} {fmtDecimal(r.invoice_value_fc, 2)}</p></div> },
          { key: 'buyer_name', header: 'Buyer / order', render: (r: any) => <div><p>{r.buyer_name}</p><p className="text-[11px] text-slate-500">{r.so_no}</p></div> },
          { key: 'fob_inr', header: 'FOB ₹', align: 'right', render: (r: any) => fmtDecimal(r.fob_inr, 2) },
          { key: 'incentives_total', header: 'DBK + RoDTEP + RoSCTL', align: 'right', render: (r: any) => <div><p>{fmtDecimal(r.incentives_total, 2)}</p>{Number(r.incentives_received) > 0 && <p className="text-[11px] text-emerald-700">received {fmtDecimal(r.incentives_received, 2)}</p>}</div> },
          { key: 'igst_amount', header: 'IGST ₹', align: 'right', render: (r: any) => (Number(r.lut) ? <Badge tone="slate">LUT</Badge> : fmtDecimal(r.igst_amount, 2)) },
          { key: 'leo_date', header: 'LEO', render: (r: any) => (r.leo_date ? fmtDate(r.leo_date) : '—') },
          { key: 'brc_due_date', header: 'BRC due', render: (r: any) => fmtDate(r.brc_due_date) },
        ]} />
    </div>
  );
}

const FIELDS = ['invoice_id', 'sb_no', 'sb_date', 'port_code', 'mode', 'port_of_loading', 'port_of_discharge', 'country_dest', 'exchange_rate', 'fob_inr', 'freight_inr', 'insurance_inr',
  'drawback_amount', 'igst_value', 'igst_amount', 'rodtep_amount', 'rosctl_amount', 'leo_no', 'leo_date', 'cha_name', 'cha_ref', 'ad_code', 'packages', 'gross_weight_kg',
  'bl_awb_no', 'bl_awb_date', 'brc_due_date', 'scheme_code', 'remarks'];

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
  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data; const x: any = { row_version: d.row_version };
    for (const k of FIELDS) x[k] = d[k] ?? '';
    setV(x); setSrc(d.source); setFobTyped(true);
  }, [detail.data]);
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const pickInvoice = async (invoiceId: string) => {
    set('invoice_id', invoiceId);
    if (!invoiceId) { setSrc(null); return; }
    try {
      const s = (await http.get<{ data: any }>(`/shipping-bills/invoice-source/${invoiceId}`)).data;
      setSrc(s);
      setV((o: any) => ({ ...o, invoice_id: invoiceId, exchange_rate: s.exchange_rate ?? '', port_of_loading: s.port_of_loading ?? '', port_of_discharge: s.port_of_discharge ?? '',
        country_dest: s.country_dest ?? '', packages: s.packages ?? '', gross_weight_kg: s.gross_weight_kg ?? '', igst_value: s.igst_value || '', igst_amount: s.igst_amount || '' }));
      setFobTyped(false);
    } catch (e) { toast(errMsg(e), 'error'); }
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
  const yIn = (k: string, label: string, type = 'number', extra: any = {}) => (
    <div className={Y}><Input label={label} type={type} step="any" value={v[k] ?? ''} id={`sb-${k}`} disabled={!editable} onChange={(e) => set(k, e.target.value)} {...extra} /></div>
  );
  return (
    <div>
      <PageHeader breadcrumb={['Export', 'Shipping Bills']} title={isNew ? 'New shipping bill' : <span className="font-mono">SB {d.sb_no}</span>}
        subtitle={isNew ? 'Pick the final commercial invoice; enter the yellow fields from the shipping bill (LET EXPORT COPY)' : `${d.buyer_name ?? ''} · ${d.so_no ?? ''} · invoice ${d.invoice_no}`}
        actions={<div className="flex gap-2">
          <Button variant="secondary" onClick={() => nav('/export/shipping-bills')}><ArrowLeft size={15} />Back</Button>
          {editable && <Button loading={busy} id="sb-save" onClick={() => void save()}><Save size={14} />Save</Button>}
          {!isNew && can('EXPORT.DELETE') && <Button variant="danger" onClick={() => setDel(true)}><Trash2 size={14} /></Button>}
        </div>} />
      <p className="mb-3 flex items-center gap-2 text-[12px] text-slate-600"><span className="inline-block h-3 w-5 rounded bg-amber-100 ring-1 ring-amber-300" /> = entered from the shipping bill; the rest comes from the commercial invoice.</p>
      <div className="space-y-4" id="sb-form">
        <Card title="Commercial invoice">
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            <Select className="sm:col-span-2" label="Commercial invoice (final)" required id="sb-invoice" disabled={!isNew} placeholder="— Select —" options={invOptions} value={v.invoice_id}
              onChange={(e) => void pickInvoice(e.target.value)} hint={drafts ? `${drafts} draft invoice(s) not listed — finalise them first` : undefined} />
            {src && <>
              <Input label="Invoice no & date" value={`${src.invoice_no} · ${fmtDate(src.invoice_date)}`} disabled />
              <Input label={`Invoice value (${src.currency_code})`} value={fmtDecimal(src.invoice_value_fc, 2)} disabled id="sb-inv-value" />
              <Input label="Order" value={`${src.so_no ?? ''} · ${src.buyer_name ?? ''}`} disabled />
              <Input label="GST export" value={src.lut ? 'Under LUT (no IGST)' : 'On payment of IGST'} disabled />
              <Input label={`FOB per invoice (${src.currency_code})`} value={fmtDecimal(src.fob_fc_invoice, 2)} disabled />
              <Input label="Invoice term" value={src.invoice_term ?? ''} disabled />
            </>}
          </div>
        </Card>
        <Card title="A · Shipping bill summary">
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            {yIn('sb_no', 'SB no', 'text', { required: true })}
            {yIn('sb_date', 'SB date', 'date', { required: true })}
            <Input label="Port code" value={v.port_code ?? ''} placeholder="INMAA4" disabled={!editable} onChange={(e) => set('port_code', e.target.value.toUpperCase())} />
            <Select label="Mode" value={v.mode ?? ''} disabled={!editable} onChange={(e) => set('mode', e.target.value)} options={['SEA', 'AIR', 'ROAD'].map((x) => ({ value: x, label: x }))} />
            <Input label="Port of loading" value={v.port_of_loading ?? ''} disabled={!editable} onChange={(e) => set('port_of_loading', e.target.value)} />
            <Input label="Port of discharge" value={v.port_of_discharge ?? ''} disabled={!editable} onChange={(e) => set('port_of_discharge', e.target.value)} />
            <Input label="Country of final destination" value={v.country_dest ?? ''} disabled={!editable} onChange={(e) => set('country_dest', e.target.value)} />
            <Input label="Packages" type="number" value={v.packages ?? ''} disabled={!editable} onChange={(e) => set('packages', e.target.value)} />
            <Input label="Gross weight (kg)" type="number" step="any" value={v.gross_weight_kg ?? ''} disabled={!editable} onChange={(e) => set('gross_weight_kg', e.target.value)} />
            <Input label="CB / CHA name" value={v.cha_name ?? ''} disabled={!editable} onChange={(e) => set('cha_name', e.target.value)} />
            <Input label="AD code" value={v.ad_code ?? ''} disabled={!editable} onChange={(e) => set('ad_code', e.target.value)} />
            <Input label="MAWB / BL no" value={v.bl_awb_no ?? ''} disabled={!editable} onChange={(e) => set('bl_awb_no', e.target.value)} />
          </div>
        </Card>
        <Card title="C · Valuation">
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            {yIn('exchange_rate', `Exchange rate (₹ per 1 ${src?.currency_code ?? ''})`, 'number', { hint: 'Customs rate on the shipping bill' })}
            {yIn('freight_inr', 'Freight (₹)')}
            <Input label="Insurance (₹)" type="number" step="any" value={v.insurance_inr ?? ''} disabled={!editable} onChange={(e) => set('insurance_inr', e.target.value)} />
            <div className={Y}><Input label="FOB value (₹)" type="number" step="any" id="sb-fob_inr" value={v.fob_inr ?? ''} disabled={!editable}
              onChange={(e) => { setFobTyped(true); set('fob_inr', e.target.value); }} hint={fobTyped ? `Worked out: ${inr(fobCalc)}` : 'Invoice value × rate − freight − insurance'} /></div>
          </div>
        </Card>
        <Card title="D · Export promotion (incentives) and IGST" subtitle="Entered once here — Finance tracks the money received; the incentives go into the order's profit">
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            {yIn('drawback_amount', 'DBK claim (₹)')}
            {yIn('rodtep_amount', 'RoDTEP amount (₹)')}
            {yIn('rosctl_amount', 'RoSCTL amount (₹)')}
            <div className="self-end text-[12.5px]">Incentives: <b id="sb-inc-total">{inr(incTotal)}</b></div>
            <Input label="IGST value (₹)" type="number" step="any" value={v.igst_value ?? ''} disabled={!editable || !!src?.lut} onChange={(e) => set('igst_value', e.target.value)} />
            {src?.lut ? <Input label="IGST amount (₹)" value="0 — export under LUT" disabled /> : yIn('igst_amount', 'IGST amount (₹)', 'number', { hint: 'Refund claimed through the shipping bill' })}
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
        <Card title="J · Process">
          <div className="grid gap-3 p-4 sm:grid-cols-4">
            <Input label="LEO no" value={v.leo_no ?? ''} disabled={!editable} onChange={(e) => set('leo_no', e.target.value)} />
            <Input label="LEO date" type="date" value={v.leo_date ?? ''} disabled={!editable} onChange={(e) => set('leo_date', e.target.value)} />
            <Input label="BRC realisation date" type="date" value={v.brc_due_date ?? ''} disabled={!editable} onChange={(e) => set('brc_due_date', e.target.value)} hint="Blank = end of the 9th month after the SB" />
            <Input label="Scheme code" value={v.scheme_code ?? ''} disabled={!editable} onChange={(e) => set('scheme_code', e.target.value)} />
            <Textarea className="sm:col-span-4" label="Remarks" value={v.remarks ?? ''} disabled={!editable} onChange={(e) => set('remarks', e.target.value)} />
          </div>
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
