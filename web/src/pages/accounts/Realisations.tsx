/**
 * Accounts → Bank realisation (buyer money received against export invoices; client 09-Nov-2026:
 * "sales bill from shipping, then bank realisation comes here").
 *   /accounts/realisations        list
 *   /accounts/realisations/new    enter: buyer, FC received, realised rate, bank charges, our bank, allocate to FINAL invoices
 *   /accounts/realisations/:id    view (draft: edit) · cancel
 * Saved realisation → Receipt voucher: Bank Dr (net of charges), Bank charges Dr, buyer Cr per invoice at the invoice rate,
 * unallocated = buyer advance, the rate difference = exchange gain / loss.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Save, Ban } from 'lucide-react';
import { PageHeader, Button, Input, Select, Textarea, Field, LoadingBlock, ErrorState, SearchInput, useDebounced } from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { errMsg, inr, VoucherStatus, ReasonModal, todayIst } from './accShared';

export function RealisationsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const q = useDebounced(search).toLowerCase();
  const list = useQuery({ queryKey: ['accounts', 'realisations'], queryFn: async () => (await http.get<{ data: any[] }>('/accounts/realisations')).data });
  const rows = (list.data ?? []).filter((r) => !q || [r.receipt_no, r.buyer_name, r.invoices, r.bank_ref, r.firc_no].some((x) => String(x ?? '').toLowerCase().includes(q)));
  const cols: Column<any>[] = [
    { key: 'receipt_no', header: 'Realisation', render: (r) => <div><p className="font-semibold text-brand-700">{r.receipt_no}</p><p className="text-caption text-ink-secondary">{r.receipt_date}</p></div> },
    { key: 'buyer_name', header: 'Buyer', render: (r) => r.buyer_name },
    { key: 'amount_fc', header: 'Received', align: 'right', render: (r) => <div className="tabular-nums"><p>{r.currency} {inr(r.amount_fc)}</p><p className="text-caption text-ink-secondary">@ {Number(r.exchange_rate)}</p></div> },
    { key: 'amount_inr', header: '₹ realised', align: 'right', render: (r) => <div className="tabular-nums"><p>{inr(r.amount_inr)}</p>{Number(r.bank_charges_inr) ? <p className="text-caption text-ink-secondary">charges {inr(r.bank_charges_inr)}</p> : null}</div> },
    { key: 'invoices', header: 'Against invoices', render: (r) => <div className="max-w-[260px]"><p className="truncate">{r.invoices ?? 'Advance'}</p>{Number(r.amount_fc) - Number(r.allocated_fc ?? 0) > 0.009 ? <p className="text-caption text-ink-secondary">advance {inr(Number(r.amount_fc) - Number(r.allocated_fc ?? 0))}</p> : null}</div> },
    { key: 'bank', header: 'Bank / ref', render: (r) => <div><p>{r.bank_name ?? '—'}</p><p className="text-caption text-ink-secondary">{[r.bank_ref, r.firc_no].filter(Boolean).join(' · ')}</p></div> },
    { key: 'status', header: 'Status', render: (r) => <div><p>{r.status === 'CANCELLED' ? 'Cancelled' : r.status === 'DRAFT' ? 'Draft' : 'Saved'}</p>{r.voucher_id ? <VoucherStatus value={r.voucher_status} /> : null}</div> },
  ];
  return (
    <div>
      <PageHeader title="Bank realisation" breadcrumb={['Accounts']} subtitle="Buyer payments credited in our bank, allocated to final commercial invoices. Each one makes a Receipt voucher."
        actions={can('ACCOUNTS.ENTRY') && <Button id="acc-real-new" onClick={() => nav('/accounts/realisations/new')}><Plus size={14} />New realisation</Button>} />
      <div className="mb-3 w-96"><SearchInput value={search} onChange={setSearch} placeholder="Realisation / buyer / invoice / UTR" /></div>
      <DataTable columns={cols} rows={rows} loading={list.isLoading} error={list.error} rowKey={(r) => r.id} onRowClick={(r) => nav(`/accounts/realisations/${r.id}`)}
        emptyTitle="No realisations yet" emptyMessage="Enter each FIRC / bank credit advice here." />
    </div>
  );
}

const empty = { receipt_date: todayIst(), buyer_id: '', currency_id: '', exchange_rate: '', amount_fc: '', amount_inr: '', bank_charges_inr: '', bank_account_id: '',
  mode: 'TT', bank_ref: '', brc_no: '', firc_no: '', remarks: '' };

export function RealisationDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const buyers = useLookup('buyers');
  const currencies = useLookup('currencies');
  const banks = useLookup('company-bank-accounts');
  const det = useQuery({ queryKey: ['accounts', 'realisation', id], enabled: !isNew, queryFn: async () => (await http.get<{ data: any }>(`/accounts/realisations/${id}`)).data });
  const r = det.data;
  const editable = isNew || r?.status === 'DRAFT';
  const [f, setF] = useState<Record<string, string>>(empty);
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);

  useEffect(() => {
    if (!r) return;
    setF({ receipt_date: r.receipt_date, buyer_id: String(r.buyer_id), currency_id: String(r.currency_id), exchange_rate: String(Number(r.exchange_rate)), amount_fc: String(Number(r.amount_fc)),
      amount_inr: String(Number(r.amount_inr)), bank_charges_inr: Number(r.bank_charges_inr) ? String(Number(r.bank_charges_inr)) : '', bank_account_id: r.bank_account_id ? String(r.bank_account_id) : '',
      mode: r.mode ?? 'TT', bank_ref: r.bank_ref ?? '', brc_no: r.brc_no ?? '', firc_no: r.firc_no ?? '', remarks: r.remarks ?? '' });
    setAlloc(Object.fromEntries(r.allocations.map((a: any) => [a.invoice_id, String(Number(a.allocated_fc))])));
  }, [r]);

  const open = useQuery({
    queryKey: ['accounts', 'open-invoices', f.buyer_id, f.currency_id, id],
    enabled: !!f.buyer_id && editable,
    queryFn: async () => (await http.get<{ data: any[] }>('/accounts/realisations/open-invoices', { buyer_id: f.buyer_id, currency_id: f.currency_id || undefined, except: isNew ? undefined : id })).data,
  });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const fc = Number(f.amount_fc) || 0;
  const xr = Number(f.exchange_rate) || 0;
  const inrAmt = f.amount_inr ? Number(f.amount_inr) : Math.round(fc * xr * 100) / 100;
  const allocated = Object.values(alloc).reduce((t, v) => t + (Number(v) || 0), 0);
  const invRows = editable ? (open.data ?? []) : (r?.allocations ?? []).map((a: any) => ({ id: a.invoice_id, invoice_no: a.invoice_no, invoice_date: a.invoice_date, exchange_rate: a.invoice_rate, total_fc: a.total_fc, open_fc: null }));
  const booked = useMemo(() => invRows.reduce((t: number, i: any) => t + (Number(alloc[i.id]) || 0) * Number(i.exchange_rate), 0), [invRows, alloc]);
  const advance = Math.max(0, fc - allocated);
  const fx = Math.round((inrAmt - booked - advance * xr) * 100) / 100;

  const fillFifo = () => {
    let left = fc; const next: Record<number, string> = {};
    for (const i of open.data ?? []) { if (left <= 0) break; const take = Math.min(left, Number(i.open_fc)); if (take > 0) { next[i.id] = String(Math.round(take * 100) / 100); left -= take; } }
    setAlloc(next);
  };
  const save = async (draft: boolean) => {
    setErr(''); setBusy(draft ? 'draft' : 'save');
    const body = { ...f, draft, amount_inr: f.amount_inr || null, bank_charges_inr: f.bank_charges_inr || 0,
      allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ invoice_id: Number(k), allocated_fc: Number(v) })) };
    try {
      const x = isNew ? await http.post<{ data: any; message: string }>('/accounts/realisations', body) : await http.put<{ data: any; message: string }>(`/accounts/realisations/${id}`, body);
      toast(x.message, /not made/.test(x.message) ? 'warning' : 'success');
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      nav(`/accounts/realisations/${x.data.id}`, { replace: true });
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(''); }
  };
  const cancel = async (reason: string) => {
    setBusy('cancel');
    try { const x = await http.post<{ message: string }>(`/accounts/realisations/${id}/cancel`, { reason }); toast(x.message); setCancelOpen(false); void qc.invalidateQueries({ queryKey: ['accounts'] }); }
    catch (e) { setErr(errMsg(e)); setCancelOpen(false); } finally { setBusy(''); }
  };

  if (!isNew && det.isLoading) return <LoadingBlock />;
  if (!isNew && det.error) return <ErrorState error={det.error} />;
  return (
    <div>
      <PageHeader title={isNew ? 'New bank realisation' : `Realisation ${r.receipt_no}`} breadcrumb={['Accounts', 'Bank realisation']}
        subtitle={r ? `${r.status === 'CANCELLED' ? `Cancelled — ${r.cancel_reason ?? ''}` : r.status === 'DRAFT' ? 'Draft' : 'Saved'} · ${r.buyer_name}` : 'From the bank credit advice / FIRC'}
        actions={<>
          {editable && can('ACCOUNTS.ENTRY') && <Button variant="secondary" loading={busy === 'draft'} onClick={() => void save(true)}>Save draft</Button>}
          {editable && can('ACCOUNTS.ENTRY') && <Button id="acc-real-save" loading={busy === 'save'} onClick={() => void save(false)}><Save size={14} />Save &amp; make voucher</Button>}
          {r && r.status !== 'CANCELLED' && can('ACCOUNTS.ENTRY') && <Button variant="danger" onClick={() => setCancelOpen(true)}><Ban size={14} />Cancel</Button>}
        </>} />
      {err && <div className="mb-3 rounded bg-status-error-background px-3 py-2 text-body text-status-error-text" id="acc-real-error">{err}</div>}
      {r?.vouchers?.length > 0 && (
        <p className="mb-3 text-body">Vouchers: {r.vouchers.map((v: any) => <Link key={v.id} className="mr-3 text-brand-700 hover:underline" to={`/accounts/vouchers/${v.id}`}>{v.voucher_no ?? `pending #${v.id}`} ({v.status.toLowerCase().replace('_', ' ')})</Link>)}</p>)}
      <div className="card mb-3 grid grid-cols-1 gap-3 p-4 md:grid-cols-4">
        <Field label="Realisation date" required><Input id="acc-real-date" type="date" disabled={!editable} value={f.receipt_date} onChange={(e) => set('receipt_date', e.target.value)} /></Field>
        <Field label="Buyer" required><Select id="acc-real-buyer" disabled={!editable} value={f.buyer_id} onChange={(e) => { set('buyer_id', e.target.value); setAlloc({}); }} options={toOptions(buyers.data)} placeholder="Pick the buyer" /></Field>
        <Field label="Currency" required><Select id="acc-real-ccy" disabled={!editable} value={f.currency_id} onChange={(e) => { set('currency_id', e.target.value); setAlloc({}); }} options={toOptions(currencies.data)} placeholder="Currency" /></Field>
        <Field label="Credited to (our bank)" required><Select id="acc-real-bank" disabled={!editable} value={f.bank_account_id} onChange={(e) => set('bank_account_id', e.target.value)} options={toOptions(banks.data)} placeholder="Our bank account" /></Field>
        <Field label="Amount received (FC)" required><Input id="acc-real-fc" disabled={!editable} inputMode="decimal" className="tabular-nums" value={f.amount_fc} onChange={(e) => set('amount_fc', e.target.value)} /></Field>
        <Field label="Realised rate ₹" required><Input id="acc-real-xr" disabled={!editable} inputMode="decimal" className="tabular-nums" value={f.exchange_rate} onChange={(e) => set('exchange_rate', e.target.value)} /></Field>
        <Field label="₹ realised (gross)" hint={`Blank = FC × rate = ${inr(Math.round(fc * xr * 100) / 100)}`}><Input disabled={!editable} inputMode="decimal" className="tabular-nums" value={f.amount_inr} onChange={(e) => set('amount_inr', e.target.value)} /></Field>
        <Field label="Bank charges ₹" hint="Deducted by the banks"><Input id="acc-real-charges" disabled={!editable} inputMode="decimal" className="tabular-nums" value={f.bank_charges_inr} onChange={(e) => set('bank_charges_inr', e.target.value)} /></Field>
        <Field label="Mode"><Select disabled={!editable} value={f.mode} onChange={(e) => set('mode', e.target.value)} options={['TT', 'LC', 'ADVANCE', 'CHEQUE', 'ONLINE', 'OTHER'].map((m) => ({ value: m, label: m }))} /></Field>
        <Field label="Bank ref / UTR"><Input id="acc-real-ref" disabled={!editable} value={f.bank_ref} onChange={(e) => set('bank_ref', e.target.value)} /></Field>
        <Field label="FIRC / e-BRC no"><Input disabled={!editable} value={f.firc_no} onChange={(e) => set('firc_no', e.target.value)} /></Field>
        <Field label="BRC no"><Input disabled={!editable} value={f.brc_no} onChange={(e) => set('brc_no', e.target.value)} /></Field>
        <Field label="Remarks" className="md:col-span-4"><Textarea rows={2} disabled={!editable} value={f.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
      </div>

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between border-b border-surface-border px-4 py-2">
          <p className="text-title font-semibold">Against invoices</p>
          {editable && (open.data?.length ?? 0) > 0 && <Button size="sm" variant="secondary" onClick={fillFifo}>Allocate oldest first</Button>}
        </div>
        {editable && !f.buyer_id ? <p className="p-4 text-body text-ink-secondary">Pick the buyer to see their final invoices.</p> : (
          <table className="w-full" id="acc-real-invoices">
            <thead><tr><th className="th">Invoice</th><th className="th">Date</th><th className="th text-right">Invoice FC</th><th className="th text-right">Invoice rate</th>
              {editable && <th className="th text-right">Open FC</th>}<th className="th w-40 text-right">This realisation FC</th></tr></thead>
            <tbody>
              {invRows.map((i: any) => (
                <tr key={i.id}>
                  <td className="td">{i.invoice_no}{i.io_no ? <span className="text-caption text-ink-secondary"> · {i.io_no}</span> : null}</td>
                  <td className="td tabular-nums">{i.invoice_date}</td>
                  <td className="td text-right tabular-nums">{inr(i.total_fc)}</td>
                  <td className="td text-right tabular-nums">{Number(i.exchange_rate)}</td>
                  {editable && <td className="td text-right tabular-nums">{inr(i.open_fc)}</td>}
                  <td className="td">{editable
                    ? <Input id={`acc-real-alloc-${i.id}`} className="text-right tabular-nums" inputMode="decimal" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [i.id]: e.target.value }))} />
                    : <p className="text-right tabular-nums">{inr(alloc[i.id])}</p>}</td>
                </tr>))}
              {!invRows.length && <tr><td className="td text-ink-secondary" colSpan={6}>{open.isLoading ? 'Loading…' : 'No open final invoices in this currency — the whole amount is an advance.'}</td></tr>}
            </tbody>
          </table>)}
        <div className="grid grid-cols-2 gap-2 border-t border-surface-border p-4 text-body md:grid-cols-5">
          <div><p className="text-caption text-ink-secondary">Allocated FC</p><p className="tabular-nums">{inr(allocated)}</p></div>
          <div><p className="text-caption text-ink-secondary">Advance FC</p><p className="tabular-nums">{inr(advance)}</p></div>
          <div><p className="text-caption text-ink-secondary">Bank Dr ₹ (net of charges)</p><p className="tabular-nums">{inr(inrAmt - (Number(f.bank_charges_inr) || 0))}</p></div>
          <div><p className="text-caption text-ink-secondary">Buyer Cr ₹ (invoice rates + advance)</p><p className="tabular-nums">{inr(booked + advance * xr)}</p></div>
          <div><p className="text-caption text-ink-secondary">Exchange {fx >= 0 ? 'gain' : 'loss'} ₹</p><p className={`tabular-nums font-semibold ${fx >= 0 ? 'text-status-success-text' : 'text-status-error-text'}`} id="acc-real-fx">{inr(Math.abs(fx))}</p></div>
        </div>
      </div>
      <ReasonModal open={cancelOpen} title="Cancel realisation" confirm="Cancel realisation" busy={busy === 'cancel'} onClose={() => setCancelOpen(false)} onSubmit={(x) => void cancel(x)} />
    </div>
  );
}
