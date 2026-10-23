import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Button, Input, Select, Textarea, Modal, Badge, LoadingBlock, SearchInput, useDebounced } from '../../components/ui';
import { http, api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { fmtDate, fmtDecimal } from '../../lib/format';

/**
 * Export incentives — received / pending (client voice note 23-Oct-2026, late): drawback, IGST refund, RoSCTL and
 * RoDTEP of a shipping bill come on different dates, sometimes in parts. Finance records each receipt on its claim
 * (date, amount, UTR / scroll / scrip no); Export and Finance both see, per shipping bill, what has come and what is
 * pending, and for how long. A balance that will not come is short-closed (or the claim rejected) with a reason.
 */
const errMsg = (e: unknown, f = 'Something went wrong') => {
  if (e instanceof ApiError) { const fe = Object.values(e.fieldErrors); return fe.length && e.code === 'VALIDATION_ERROR' ? fe.join(' · ') : e.message; }
  return f;
};
const inr = (v: unknown) => `₹ ${fmtDecimal(v, 2)}`;
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const TYPES = [['DUTY_DRAWBACK', 'Drawback'], ['GST_REFUND', 'IGST refund'], ['ROSCTL', 'RoSCTL'], ['RODTEP', 'RoDTEP']] as const;
export const INC_STATUS: Record<string, { label: string; tone: string }> = {
  PENDING: { label: 'Pending', tone: 'amber' }, CLAIMED: { label: 'Pending', tone: 'amber' }, PARTIAL: { label: 'Part received', tone: 'blue' },
  CREDITED: { label: 'Received', tone: 'green' }, SHORT_CLOSED: { label: 'Short-closed', tone: 'slate' }, REJECTED: { label: 'Rejected', tone: 'red' },
  RECEIVED: { label: 'Received', tone: 'green' },
};
const StatusBadge = ({ s }: { s: string }) => <span className="whitespace-nowrap"><Badge tone={(INC_STATUS[s]?.tone ?? 'slate') as any}>{INC_STATUS[s]?.label ?? s.toLowerCase()}</Badge></span>;

/* ================================================================ the tracker (Export + Finance) */
export function ExportIncentivesPage({ area = 'Finance' }: { area?: 'Finance' | 'Export' }) {
  const { can } = useAuth();
  const toast = useToast();
  const [view, setView] = useState<'bills' | 'claims'>('bills');
  const [status, setStatus] = useState('OPEN');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const dq = useDebounced(q);
  const params = { status: status || undefined, q: dq || undefined, from: from || undefined, to: to || undefined };
  const track = useQuery({ queryKey: ['export-incentives', 'tracker', params], enabled: view === 'bills',
    queryFn: async () => http.get<{ data: any[]; totals: any }>('/export-incentives/tracker', params) });
  const claims = useQuery({ queryKey: ['export-incentives', 'claims', params], enabled: view === 'claims',
    queryFn: async () => http.get<{ data: any[]; totals: any }>('/export-incentives', { ...params, status: status === 'RECEIVED' ? 'CREDITED' : params.status }) });
  const excel = async () => {
    try {
      const r = await api.get('/export-incentives/tracker.xlsx', { params, responseType: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `export_incentives_${today()}.xlsx`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast(errMsg(e, 'Could not download the Excel'), 'error'); }
  };
  const T = track.data?.totals;
  const rows = track.data?.data ?? [];
  const crows = claims.data?.data ?? [];
  const tab = (on: boolean) => clsx('rounded-md px-3 py-1.5 text-[12.5px] font-medium', on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200');
  return (
    <div>
      <PageHeader title="Export Incentives" breadcrumb={[area]}
        subtitle="Drawback, IGST refund, RoSCTL and RoDTEP per shipping bill — what is received and what is pending. Finance records each receipt on its own date."
        actions={view === 'bills' && <Button variant="secondary" id="inc-excel" onClick={() => void excel()}><Download size={14} />Excel</Button>} />
      <div className="card mb-3 flex flex-wrap items-end gap-2.5 p-3">
        <div className="flex gap-1" id="inc-view">
          <button className={tab(view === 'bills')} onClick={() => setView('bills')}>By shipping bill</button>
          <button className={tab(view === 'claims')} id="inc-view-claims" onClick={() => setView('claims')}>All claims</button>
        </div>
        <SearchInput className="w-60" value={q} onChange={setQ} placeholder="SB no, invoice, order, buyer…" />
        <Select className="w-44" id="inc-status" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All"
          options={[{ value: 'OPEN', label: 'Pending (to receive)' }, { value: 'RECEIVED', label: 'Fully received' }]} />
        <Input className="w-40" type="date" label="SB from" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input className="w-40" type="date" label="to" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {view === 'bills' && T && (
        <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6" id="inc-totals">
          <Tile label="Claimed" value={inr(T.claim)} />
          <Tile label="Received" value={inr(T.received)} tone="green" />
          <Tile label={`Pending · ${T.pending_bills} SB${T.pending_bills === 1 ? '' : 's'}`} value={inr(T.outstanding)} tone="amber" />
          {TYPES.filter(([t]) => t !== 'GST_REFUND' || T.by_type[t].claim > 0).slice(0, 3).map(([t, l]) => (
            <Tile key={t} label={`${l} pending`} value={inr(T.by_type[t].outstanding)} sub={`of ${inr(T.by_type[t].claim)}`} />
          ))}
        </div>
      )}

      {view === 'bills' ? (
        <div className="card overflow-x-auto">
          <table className="w-full" id="inc-tracker">
            <thead><tr>
              <th className="th">Shipping bill</th><th className="th">Invoice · order · buyer</th>
              {TYPES.map(([t, l]) => <th key={t} className="th text-right">{l}</th>)}
              <th className="th text-right">Pending ₹</th><th className="th">Status</th>
            </tr></thead>
            <tbody>
              {track.isLoading && <tr><td colSpan={8}><LoadingBlock rows={4} /></td></tr>}
              {!track.isLoading && !rows.length && <tr><td colSpan={8} className="td py-10 text-center text-slate-400">{status === 'OPEN' ? 'Nothing pending — every claim is received' : 'No shipping bills with incentives'}</td></tr>}
              {rows.map((r) => (
                <tr key={r.shipping_bill_id} className="row-hover align-top" data-sb={r.sb_no}>
                  <td className="td whitespace-nowrap text-[12px]"><Link className="font-mono font-semibold text-brand-700 hover:underline" to={`/export/shipping-bills/${r.shipping_bill_id}`}>{r.sb_no}</Link>
                    <p className="text-slate-500">{fmtDate(r.sb_date)}{r.pending_days != null && <span className={clsx('ml-1', r.pending_days > 90 ? 'font-semibold text-red-600' : 'text-slate-400')}>· {r.pending_days} d</span>}</p></td>
                  <td className="td text-[12px]">{r.invoice_no ?? '—'}<p className="text-slate-500">{r.so_no ?? ''} · {r.buyer_name ?? ''}</p></td>
                  {TYPES.map(([t]) => {
                    const c = r.cells[t];
                    if (!c) return <td key={t} className="td text-right text-[12px] text-slate-300">—</td>;
                    return (
                      <td key={t} className="td text-right text-[12px]">
                        <button type="button" className="w-full rounded px-1 py-0.5 text-right hover:bg-slate-50" data-cell={`${r.sb_no}-${t}`} onClick={() => setOpen(c.ids[0])}
                          title="Open the claim — receipts">
                          <span className="tabular-nums font-semibold">{fmtDecimal(c.received, 2)}</span><span className="tabular-nums text-slate-400"> / {fmtDecimal(c.claim, 2)}</span>
                          <span className="mt-0.5 block"><StatusBadge s={c.status} /></span>
                          {c.last_date && <span className="block whitespace-nowrap text-[10.5px] text-slate-500">recd {fmtDate(c.last_date)}</span>}
                        </button>
                      </td>
                    );
                  })}
                  <td className={clsx('td text-right tabular-nums', r.outstanding > 0 && 'font-semibold text-amber-700')}>{fmtDecimal(r.outstanding, 2)}
                    {r.short > 0 && <p className="text-[10.5px] font-normal text-slate-500">short {fmtDecimal(r.short, 2)}</p>}</td>
                  <td className="td"><StatusBadge s={r.status} /></td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && T && (
              <tfoot><tr className="border-t-2 border-slate-200 font-semibold">
                <td className="td" colSpan={2}>Total ({rows.length})</td>
                {TYPES.map(([t]) => <td key={t} className="td text-right text-[12px] tabular-nums">{fmtDecimal(T.by_type[t].received, 2)}<span className="font-normal text-slate-400"> / {fmtDecimal(T.by_type[t].claim, 2)}</span></td>)}
                <td className="td text-right tabular-nums text-amber-700">{fmtDecimal(T.outstanding, 2)}</td><td className="td" />
              </tr></tfoot>
            )}
          </table>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full" id="inc-list">
            <thead><tr><th className="th">Type</th><th className="th">Shipping bill</th><th className="th">Invoice / order</th><th className="th text-right">Claim ₹</th><th className="th text-right">Received ₹</th>
              <th className="th text-right">Pending ₹</th><th className="th">Status</th><th className="th">Last received</th></tr></thead>
            <tbody>
              {claims.isLoading && <tr><td colSpan={8}><LoadingBlock rows={3} /></td></tr>}
              {!claims.isLoading && !crows.length && <tr><td colSpan={8} className="td py-8 text-center text-slate-400">No claims</td></tr>}
              {crows.map((r) => (
                <tr key={r.id} className="row-hover cursor-pointer" data-inc={r.id} onClick={() => setOpen(r.id)}>
                  <td className="td text-[12px] font-semibold">{r.label}{r.source === 'SHIPPING_BILL' && <span className="ml-1 text-[10.5px] font-normal text-slate-400">from SB</span>}</td>
                  <td className="td text-[12px]">{r.sb_no ?? '—'}<p className="text-slate-500">{fmtDate(r.sb_date)}</p></td>
                  <td className="td text-[12px]">{r.invoice_no ?? '—'}<p className="text-slate-500">{r.so_no ?? ''} {r.buyer_name ?? ''}</p></td>
                  <td className="td text-right tabular-nums">{fmtDecimal(r.claim_amount, 2)}</td>
                  <td className="td text-right tabular-nums">{fmtDecimal(r.received_amount, 2)}{r.receipts_count > 1 && <p className="text-[10.5px] text-slate-400">{r.receipts_count} receipts</p>}</td>
                  <td className={clsx('td text-right tabular-nums', r.outstanding > 0 && 'font-semibold text-amber-700')}>{fmtDecimal(r.outstanding, 2)}</td>
                  <td className="td"><StatusBadge s={r.status} /></td>
                  <td className="td text-[12px]">{r.credit_date ? fmtDate(r.credit_date) : '—'}{r.pending_days != null && <p className="text-[10.5px] text-slate-400">pending {r.pending_days} d</p>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {claims.data?.totals && <p className="border-t border-slate-100 px-3 py-2 text-[12px] text-slate-600">Claimed {inr(claims.data.totals.claimed)} · received {inr(claims.data.totals.received)} · pending <b>{inr(claims.data.totals.outstanding)}</b>{claims.data.totals.short > 0 && ` · short-closed ${inr(claims.data.totals.short)}`}</p>}
        </div>
      )}
      {open && <IncentiveClaimModal id={open} onClose={() => setOpen(null)} canEdit={can('FINANCE.UPDATE')} />}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'green' | 'amber' }) {
  return (
    <div className="card px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('text-[16px] font-semibold tabular-nums', tone === 'green' && 'text-emerald-700', tone === 'amber' && 'text-amber-700')}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

/* ================================================================ one claim: receipts, short-close */
export function IncentiveClaimModal({ id, onClose, canEdit }: { id: number; onClose: () => void; canEdit: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['export-incentive', id], queryFn: async () => (await http.get<{ data: any }>(`/export-incentives/${id}`)).data });
  const [rc, setRc] = useState<any | null>(null);
  const [close, setClose] = useState<null | 'SHORT_CLOSE' | 'REJECT'>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const x = q.data;
  const refresh = () => { void q.refetch(); void qc.invalidateQueries({ queryKey: ['export-incentives'] }); void qc.invalidateQueries({ queryKey: ['shipping-bill'] }); };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast(done); refresh(); return true; } catch (e) { toast(errMsg(e), 'error'); return false; } finally { setBusy(false); }
  };
  const addReceipt = async () => {
    if (await run(() => http.post(`/export-incentives/${id}/receipts`, { receipt_date: rc.receipt_date, amount: Number(rc.amount), mode: rc.mode, reference: rc.reference || null, remarks: rc.remarks || null }), 'Receipt recorded')) setRc(null);
  };
  const isClosed = x && ['SHORT_CLOSED', 'REJECTED'].includes(x.status);
  return (
    <Modal open onClose={onClose} size="lg" title={x ? `${x.label} · ${x.sb_no ? `SB ${x.sb_no}` : 'claim'}` : 'Incentive claim'}
      subtitle={x ? `${x.invoice_no ?? ''}${x.so_no ? ` · ${x.so_no}` : ''}${x.buyer_name ? ` · ${x.buyer_name}` : ''}` : undefined}
      footerStart={x && canEdit && <div className="flex gap-2">
        {isClosed ? <Button variant="secondary" size="sm" id="inc-reopen" loading={busy} onClick={() => void run(() => http.post(`/export-incentives/${id}/close`, { action: 'REOPEN' }), 'Claim reopened')}>Reopen claim</Button>
          : x.outstanding > 0 && (x.received_amount > 0
            ? <Button variant="secondary" size="sm" id="inc-short" onClick={() => { setClose('SHORT_CLOSE'); setReason(''); }}>Short-close balance</Button>
            : <Button variant="secondary" size="sm" id="inc-reject" onClick={() => { setClose('REJECT'); setReason(''); }}>Rejected</Button>)}
      </div>}
      footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      {q.isLoading || !x ? <LoadingBlock rows={4} /> : (
        <div className="space-y-3" id="inc-claim">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Claim" value={inr(x.claim_amount)} sub={x.claim_date ? `from ${fmtDate(x.claim_date)}` : undefined} />
            <Tile label="Received" value={inr(x.received_amount)} tone="green" sub={x.credit_date ? `last ${fmtDate(x.credit_date)}` : undefined} />
            <Tile label="Pending" value={inr(x.outstanding)} tone="amber" sub={x.pending_days != null ? `${x.pending_days} days` : undefined} />
            <div className="card flex flex-col justify-center px-3 py-2"><StatusBadge s={x.status} />{x.closed_reason && <p className="mt-1 text-[11px] text-slate-500">{x.closed_reason}</p>}</div>
          </div>
          <table className="w-full" id="inc-receipts">
            <thead><tr><th className="th">Received on</th><th className="th text-right">Amount ₹</th><th className="th">Mode</th><th className="th">UTR / scroll / scrip no</th><th className="th">Remarks</th><th className="th" /></tr></thead>
            <tbody>
              {!x.receipts.length && <tr><td colSpan={6} className="td py-4 text-center text-[12px] text-slate-400">Nothing received yet</td></tr>}
              {x.receipts.map((r: any) => (
                <tr key={r.id}>
                  <td className="td text-[12px]">{fmtDate(r.receipt_date)}</td><td className="td text-right tabular-nums">{fmtDecimal(r.amount, 2)}</td>
                  <td className="td text-[12px]">{r.mode === 'SCRIP' ? 'e-scrip' : r.mode === 'ADJUSTED' ? 'adjusted' : 'bank'}</td>
                  <td className="td font-mono text-[12px]">{r.reference ?? '—'}</td><td className="td text-[12px] text-slate-500">{r.remarks ?? ''}</td>
                  <td className="td">{canEdit && <button className="text-slate-400 hover:text-red-600" title="Remove this receipt" data-del-receipt={r.id}
                    onClick={() => void run(() => http.del(`/export-incentives/${id}/receipts/${r.id}`), 'Receipt removed')}><Trash2 size={14} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {canEdit && !isClosed && x.outstanding > 0 && !rc && (
            <Button size="sm" id="inc-add-receipt" onClick={() => setRc({ receipt_date: today(), amount: String(x.outstanding), mode: ['RODTEP', 'ROSCTL'].includes(x.incentive_type) ? 'SCRIP' : 'BANK', reference: '', remarks: '' })}>
              <Plus size={14} />Record receipt</Button>
          )}
          {rc && (
            <div className="rounded-lg border border-slate-200 p-3" id="inc-receipt-form">
              <div className="grid gap-3 sm:grid-cols-4">
                <Input label="Received on" type="date" required id="inc-r-date" value={rc.receipt_date} max={today()} onChange={(e) => setRc({ ...rc, receipt_date: e.target.value })} />
                <Input label="Amount (₹)" type="number" step="any" required id="inc-r-amount" value={rc.amount} hint={`Pending ${inr(x.outstanding)}`} onChange={(e) => setRc({ ...rc, amount: e.target.value })} />
                <Select label="Mode" id="inc-r-mode" value={rc.mode} onChange={(e) => setRc({ ...rc, mode: e.target.value })}
                  options={[{ value: 'BANK', label: 'Bank credit' }, { value: 'SCRIP', label: 'e-scrip (ICEGATE)' }, { value: 'ADJUSTED', label: 'Adjusted' }]} />
                <Input label={rc.mode === 'SCRIP' ? 'Scrip no' : 'UTR / scroll no'} id="inc-r-ref" value={rc.reference} onChange={(e) => setRc({ ...rc, reference: e.target.value })} />
                <Input className="sm:col-span-4" label="Remarks" value={rc.remarks} onChange={(e) => setRc({ ...rc, remarks: e.target.value })} />
              </div>
              <div className="mt-3 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setRc(null)}>Cancel</button>
                <Button loading={busy} id="inc-r-save" disabled={!(Number(rc.amount) > 0) || !rc.receipt_date} onClick={() => void addReceipt()}>Save receipt</Button></div>
            </div>
          )}
          {close && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3" id="inc-close-form">
              <p className="mb-2 text-[12.5px] text-amber-900">{close === 'SHORT_CLOSE' ? `The balance ${inr(x.outstanding)} will not come — it stops showing as pending.` : 'The whole claim is rejected — nothing will come.'}</p>
              <Textarea label="Reason" required id="inc-close-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="mt-2 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setClose(null)}>Cancel</button>
                <Button loading={busy} id="inc-close-save" disabled={reason.trim().length < 3}
                  onClick={async () => { if (await run(() => http.post(`/export-incentives/${id}/close`, { action: close, reason }), close === 'SHORT_CLOSE' ? 'Balance short-closed' : 'Claim rejected')) setClose(null); }}>Confirm</Button></div>
            </div>
          )}
          {x.remarks && <p className="text-[12px] text-slate-500">Remarks: {x.remarks}</p>}
        </div>
      )}
    </Modal>
  );
}

