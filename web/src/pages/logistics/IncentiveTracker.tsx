import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, Settings2, Upload, Wand2 } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Button, Input, Select, Modal, Badge, LoadingBlock, ErrorState, EmptyState, SearchInput, useDebounced, Tabs, Pager, Checkbox } from '../../components/ui';
import { http, api, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useLookup } from '../../hooks/useLookup';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { ClaimDrawer, StatusPill, Tile, errMsg, inr, todayIst, fileToDataUrl, useBenefitMeta, type Meta } from './benefitShared';

/**
 * Export Benefits workspace (client voice note 24-Oct-2026: "the shipping bill comes first; drawback comes one day,
 * RoDTEP / RoSCTL later — on that day we pick the SB and record it"; specs v1 + v2). Dashboard → register (one row per
 * SB + scheme, expandable timeline) → claim drawer for receipts / scrip events; receipt-date report, ageing, follow-ups,
 * bank reconciliation. Schemes, statuses and labels all come from the API, so a scheme added in the master shows here.
 */
const download = async (url: string, params: Record<string, unknown>, file: string, toast: (m: string, t?: any) => void) => {
  try {
    const r = await api.get(url, { params: { ...params, format: 'xlsx' }, responseType: 'blob' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = file; a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { toast(errMsg(e, 'Could not download the Excel'), 'error'); }
};
const TABS = [{ key: 'dashboard', label: 'Dashboard' }, { key: 'register', label: 'Benefit register' }, { key: 'bills', label: 'By shipping bill' }, { key: 'receipts', label: 'Receipts by date' },
  { key: 'ageing', label: 'Ageing' }, { key: 'followups', label: 'Follow-ups' }, { key: 'recon', label: 'Bank reconciliation' }];

export function ExportIncentivesPage({ area = 'Finance' }: { area?: 'Finance' | 'Export' }) {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'dashboard';
  const meta = useBenefitMeta();
  const [open, setOpen] = useState<number | null>(null);
  const goRegister = (filter: Record<string, unknown>) => { const p = new URLSearchParams({ tab: 'register' }); for (const [k, v] of Object.entries(filter)) if (v != null && v !== '') p.set(k, String(v)); setSp(p); };
  return (
    <div>
      <PageHeader title="Export Benefits" breadcrumb={[area]}
        subtitle="Drawback, IGST refund, RoDTEP, RoSCTL and any scheme added in the master — each received on its own date. Cash and scrip are kept apart."
        actions={meta.data?.rights.admin && <Link to="/export/benefit-schemes" className="btn-secondary" id="eb-schemes-link"><Settings2 size={14} />Scheme master</Link>} />
      <Tabs tabs={TABS} active={tab} onChange={(k) => setSp(new URLSearchParams({ tab: k }))} />
      {meta.isLoading ? <div className="card"><LoadingBlock rows={6} /></div> : meta.error ? <div className="card"><ErrorState error={meta.error} onRetry={() => void meta.refetch()} /></div> : (
        <div id={`eb-tab-${tab}`}>
          {tab === 'dashboard' && <Dashboard onFilter={goRegister} />}
          {tab === 'register' && <Register meta={meta.data!} onOpen={setOpen} />}
          {tab === 'bills' && <Bills onOpen={setOpen} />}
          {tab === 'receipts' && <Receipts meta={meta.data!} onOpen={setOpen} />}
          {tab === 'ageing' && <Ageing onFilter={goRegister} />}
          {tab === 'followups' && <Followups onOpen={setOpen} />}
          {tab === 'recon' && <Recon meta={meta.data!} onOpen={setOpen} />}
        </div>
      )}
      {open && <ClaimDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Kept for callers of the 23-Oct screen. */
export function IncentiveClaimModal({ id, onClose }: { id: number; onClose: () => void; canEdit?: boolean }) { return <ClaimDrawer id={id} onClose={onClose} />; }

/* ================================================================ dashboard */
function Dashboard({ onFilter }: { onFilter: (f: Record<string, unknown>) => void }) {
  const q = useQuery({ queryKey: ['export-benefits', 'dashboard'], queryFn: async () => (await http.get<{ data: any }>('/export-benefits/dashboard')).data });
  if (q.isLoading) return <div className="card"><LoadingBlock rows={6} /></div>;
  if (q.error) return <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const d = q.data;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" id="eb-kpis">
        {d.cards.map((c: any) => <Tile key={c.key} id={`kpi-${c.key}`} label={c.label} value={inr(c.amount)} tone={c.tone} onClick={() => onFilter(c.filter)}
          sub={[c.count ? `${c.count} ${c.key.startsWith('cash') || c.key.startsWith('proceeds') || c.key.startsWith('scrip_month') ? 'events' : 'claims'}` : null, c.sub].filter(Boolean).join(' · ') || undefined} />)}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="card overflow-x-auto lg:col-span-2">
          <p className="border-b border-slate-100 px-3 py-2 text-[12.5px] font-semibold text-slate-700">By scheme</p>
          <table className="w-full" id="eb-by-scheme"><thead><tr><th className="th">Scheme</th><th className="th text-right">Claims</th><th className="th text-right">Basis ₹</th><th className="th text-right">Cash ₹</th>
            <th className="th text-right">Scrip issued / available</th><th className="th text-right">Pending ₹</th></tr></thead>
            <tbody>{!d.by_scheme.length && <tr><td colSpan={6} className="td py-6 text-center text-slate-400">No claims yet — they come from the shipping bills</td></tr>}
              {d.by_scheme.map((r: any) => <tr key={r.scheme_id} className="row-hover cursor-pointer" data-scheme={r.code} onClick={() => onFilter({ scheme_id: r.scheme_id })}>
                <td className="td text-[12.5px] font-semibold">{r.display_name}<p className="text-[11px] font-normal text-slate-400">{r.mode_label}</p></td>
                <td className="td text-right tabular-nums">{r.claims}{r.open_claims ? <span className="text-amber-700"> · {r.open_claims} open</span> : null}</td>
                <td className="td text-right tabular-nums">{fmtDecimal(r.basis, 2)}</td><td className="td text-right tabular-nums text-emerald-700">{fmtDecimal(r.cash + r.proceeds, 2)}</td>
                <td className="td text-right tabular-nums text-indigo-700">{r.tracking_mode === 'CASH' ? '—' : `${fmtDecimal(r.scrip_issued, 2)} / ${fmtDecimal(r.scrip_available, 2)}`}</td>
                <td className="td text-right font-semibold tabular-nums text-amber-700">{fmtDecimal(r.pending, 2)}</td></tr>)}</tbody></table>
        </div>
        <div className="card p-3 text-[12.5px]" id="eb-queues">
          <p className="mb-2 font-semibold text-slate-700">Needs attention</p>
          {[['Follow-ups open', d.queues.followups_open, { followup: 'OPEN' }], ['Follow-ups overdue', d.queues.followups_overdue, { followup: 'OVERDUE' }], ['Under query', d.queues.query, { status: 'QUERY' }],
            ['Rejected', d.queues.rejected, { status: 'REJECTED' }], ['Not applicable', d.queues.not_applicable, { status: 'NOT_APPLICABLE' }]].map(([l, c, f]: any) => (
            <button key={l} className="flex w-full justify-between rounded px-1 py-1 hover:bg-slate-50" onClick={() => onFilter(f)}><span>{l}</span><b className={c ? 'text-amber-700' : 'text-slate-400'}>{c}</b></button>))}
          <p className="mt-2 flex justify-between px-1"><span>Bank lines not reconciled</span><b>{d.queues.bank_unmatched} · {inr(d.queues.bank_unmatched_amount)}</b></p>
          <p className="flex justify-between px-1"><span>Draft events</span><b>{d.queues.drafts}</b></p>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <p className="border-b border-slate-100 px-3 py-2 text-[12.5px] font-semibold text-slate-700">Pending ageing (days, as on {fmtDate(d.as_of)})</p>
          <AgeingTable data={d.ageing} onFilter={onFilter} />
        </div>
        <div className="card overflow-x-auto">
          <p className="border-b border-slate-100 px-3 py-2 text-[12.5px] font-semibold text-slate-700">Last 6 months — cash vs scrip</p>
          <table className="w-full"><thead><tr><th className="th">Month</th><th className="th text-right">Bank / refund ₹</th><th className="th text-right">Sale proceeds ₹</th><th className="th text-right">Scrip issued ₹ (not cash)</th></tr></thead>
            <tbody>{!d.trend.length && <tr><td colSpan={4} className="td py-4 text-center text-slate-400">Nothing received yet</td></tr>}
              {d.trend.map((t: any) => <tr key={t.month}><td className="td text-[12px]">{t.month}</td><td className="td text-right tabular-nums">{fmtDecimal(t.cash, 2)}</td>
                <td className="td text-right tabular-nums">{fmtDecimal(t.proceeds, 2)}</td><td className="td text-right tabular-nums text-indigo-700">{fmtDecimal(t.scrip, 2)}</td></tr>)}</tbody></table>
        </div>
      </div>
    </div>
  );
}

function AgeingTable({ data, onFilter }: { data: any; onFilter: (f: Record<string, unknown>) => void }) {
  return (
    <table className="w-full" id="eb-ageing"><thead><tr><th className="th">Scheme · aged from</th>{data.buckets.map((b: string) => <th key={b} className="th text-right">{b}</th>)}<th className="th text-right">Pending ₹</th></tr></thead>
      <tbody>{!data.by_scheme.length && <tr><td colSpan={6} className="td py-4 text-center text-slate-400">Nothing pending</td></tr>}
        {data.by_scheme.map((s: any) => <tr key={s.scheme_id}><td className="td text-[12px] font-semibold">{s.display_name}<p className="text-[10.5px] font-normal text-slate-400">{s.ageing_label}</p></td>
          {data.buckets.map((b: string) => <td key={b} className="td text-right text-[12px]">{s.buckets[b].count ? <button className={clsx('tabular-nums hover:underline', b === '90+' && 'font-semibold text-red-600')} data-bucket={`${s.code}-${b}`}
            onClick={() => onFilter({ scheme_id: s.scheme_id, pending: 1, bucket: b })}>{fmtDecimal(s.buckets[b].amount, 2)}<span className="text-slate-400"> ({s.buckets[b].count})</span></button> : <span className="text-slate-300">—</span>}</td>)}
          <td className="td text-right font-semibold tabular-nums">{fmtDecimal(s.pending, 2)}</td></tr>)}
        {data.by_scheme.length > 0 && <tr className="border-t-2 border-slate-200 font-semibold"><td className="td">Total</td>{data.buckets.map((b: string) => <td key={b} className="td text-right tabular-nums">
          <button className="hover:underline" onClick={() => onFilter({ pending: 1, bucket: b })}>{fmtDecimal(data.total[b].amount, 2)}</button></td>)}
          <td className="td text-right tabular-nums">{fmtDecimal(data.buckets.reduce((t: number, b: string) => t + data.total[b].amount, 0), 2)}</td></tr>}</tbody></table>
  );
}

/* ================================================================ register */
const FILTER_KEYS = ['as_of', 'q', 'scheme_id', 'status', 'from', 'to', 'pending', 'bucket', 'event_kind', 'event_from', 'event_to', 'excess', 'followup', 'sb_id'];
function Register({ meta, onOpen }: { meta: Meta; onOpen: (id: number) => void }) {
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k) ?? ''])) as Record<string, string>;
  const [q, setQ] = useState(f.q);
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'sb_date', dir: 'desc' });
  const [exp, setExp] = useState<Record<number, boolean>>({});
  const setF = (k: string, v: string) => { const p = new URLSearchParams(sp); if (v) p.set(k, v); else p.delete(k); p.set('tab', 'register'); setSp(p); setPage(1); };
  const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), q: dq || undefined, page, pageSize: 25, sort: sort.key, dir: sort.dir };
  const list = useQuery({ queryKey: ['export-benefits', 'register', params], queryFn: async () => http.get<{ data: any[]; pagination: any; totals: any }>('/export-benefits/claims', params) });
  const rows = list.data?.data ?? [];
  const T = list.data?.totals;
  const extra = ['bucket', 'event_kind', 'event_from', 'excess', 'followup', 'sb_id'].filter((k) => f[k]);
  const th = (key: string, label: string, right = false) => (
    <th className={clsx('th', right && 'text-right')}><button className="hover:text-slate-800" onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
      {label}{sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}</button></th>);
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2.5 p-3" id="eb-reg-filters">
        <SearchInput className="w-60" value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="SB, invoice, order, buyer, UTR, scrip…" />
        <Select className="w-52" id="eb-f-scheme" value={f.scheme_id} placeholder="All schemes" onChange={(e) => setF('scheme_id', e.target.value)}
          options={meta.schemes.map((s) => ({ value: s.id, label: `${s.display_name}${s.is_active ? '' : ' (inactive)'}` }))} />
        <Select className="w-48" id="eb-f-status" value={f.status} placeholder="All statuses" onChange={(e) => setF('status', e.target.value)}
          options={[{ value: 'OPEN', label: 'Pending (anything to come)' }, ...meta.statuses.map((s) => ({ value: s.value, label: s.label }))]} />
        <Input className="w-36" type="date" label="SB from" value={f.from} onChange={(e) => setF('from', e.target.value)} />
        <Input className="w-36" type="date" label="to" value={f.to} onChange={(e) => setF('to', e.target.value)} />
        <div className="pb-2"><Checkbox label="Pending only" checked={!!f.pending} onChange={(c) => setF('pending', c ? '1' : '')} /></div>
        {extra.length > 0 && <div className="flex flex-wrap items-center gap-1 pb-1.5" id="eb-f-extra">{extra.map((k) => <Badge key={k} tone="blue">{k.replace('_', ' ')}: {f[k]}</Badge>)}
          <button className="text-[12px] text-brand-700 hover:underline" onClick={() => { const p = new URLSearchParams({ tab: 'register' }); for (const k of ['q', 'scheme_id', 'status', 'from', 'to', 'pending']) if (f[k]) p.set(k, f[k]); setSp(p); }}>clear</button></div>}
        <div className="ml-auto pb-0.5"><Button variant="secondary" id="eb-reg-excel" onClick={() => void download('/export-benefits/claims', params, `export_benefit_register_${todayIst()}.xlsx`, toast)}><Download size={14} />Excel</Button></div>
      </div>
      {T && T.by_scheme.length > 0 && (
        <div className="flex flex-wrap gap-2" id="eb-reg-totals">
          <Tile label={`${T.claims} benefits`} value={inr(T.pending)} sub={`pending · cash ${inr(T.cash + T.proceeds)}${T.scrip_available ? ` · scrip avail. ${inr(T.scrip_available)}` : ''}`} tone="amber" />
          {T.by_scheme.map((s: any) => <Tile key={s.scheme_id} label={s.short_name || s.display_name} value={inr(s.pending)} sub={`of ${inr(s.basis)} · cash ${inr(s.cash + s.proceeds)}${s.tracking_mode !== 'CASH' ? ` · scrip ${inr(s.scrip_issued)}` : ''}`} />)}
        </div>
      )}
      {list.error ? <div className="card"><ErrorState error={list.error} onRetry={() => void list.refetch()} /></div> : (
        <div className="card overflow-x-auto">
          <table className="w-full" id="eb-register">
            <thead><tr><th className="th w-6" />{th('sb_date', 'Shipping bill')}<th className="th">Invoice · order · buyer</th>{th('scheme', 'Benefit')}{th('declared', 'Declared / basis ₹', true)}
              {th('cash', 'Cash received ₹', true)}<th className="th text-right">Scrip issued / avail. / used / sold</th>{th('pending', 'Pending ₹', true)}{th('last_event', 'Last event')}{th('days', 'Days pending', true)}{th('status', 'Status')}</tr></thead>
            <tbody>
              {list.isLoading && <tr><td colSpan={11}><LoadingBlock rows={5} /></td></tr>}
              {!list.isLoading && !rows.length && <tr><td colSpan={11}><EmptyState title="No benefits match" message="Change the filters — benefits come from the shipping bills (or the scheme rows added to them)." /></td></tr>}
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className="row-hover align-top" data-claim={r.id} data-scheme={r.scheme_code} data-sb={r.sb_no}>
                    <td className="td"><button className="text-slate-400 hover:text-slate-700" title="Show every event" data-expand={r.id} onClick={() => setExp((e) => ({ ...e, [r.id]: !e[r.id] }))}>{exp[r.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></td>
                    <td className="td whitespace-nowrap text-[12px]">{r.shipping_bill_id ? <Link className="tabular-nums font-semibold text-brand-700 hover:underline" to={`/export/shipping-bills/${r.shipping_bill_id}`}>{r.sb_no}</Link> : <span className="text-slate-400">no SB</span>}
                      <p className="text-slate-500">{fmtDate(r.sb_date ?? r.claim_date)}</p></td>
                    <td className="td text-[12px]">{r.invoice_no ?? '—'}<p className="text-slate-500">{r.so_no ?? ''} · {r.buyer_name ?? ''}</p></td>
                    <td className="td text-[12px]"><button className="text-left font-semibold text-brand-700 hover:underline" data-open={r.id} onClick={() => onOpen(r.id)}>{r.scheme_name}</button><p className="text-[10.5px] text-slate-400">{r.mode_label}</p></td>
                    <td className="td text-right text-[12px] tabular-nums">{r.declared_amount == null ? <span className="text-slate-400">not known</span> : fmtDecimal(r.declared_amount, 2)}
                      {r.basis_amount != null && r.basis_source !== 'DECLARED' && <p className="text-[10.5px] text-slate-500">{r.basis_source?.toLowerCase()} {fmtDecimal(r.basis_amount, 2)}</p>}</td>
                    <td className="td text-right tabular-nums text-emerald-700">{fmtDecimal(r.net_cash, 2)}{r.adjusted_amount > 0 && <p className="text-[10.5px] text-slate-500">adj. {fmtDecimal(r.adjusted_amount, 2)}</p>}</td>
                    <td className="td text-right text-[12px] tabular-nums text-indigo-700">{r.scrip_capable ? `${fmtDecimal(r.scrip_issued, 0)} / ${fmtDecimal(r.scrip_available, 0)} / ${fmtDecimal(r.scrip_utilised, 0)} / ${fmtDecimal(r.scrip_sold, 0)}` : <span className="text-slate-300">—</span>}</td>
                    <td className={clsx('td text-right tabular-nums', r.pending_amount > 0 && 'font-semibold text-amber-700')}>{fmtDecimal(r.pending_amount, 2)}{r.excess_amount > 0 && <p className="text-[10.5px] font-semibold text-red-600">excess {fmtDecimal(r.excess_amount, 2)}</p>}</td>
                    <td className="td whitespace-nowrap text-[12px]">{r.last_event_date ? fmtDate(r.last_event_date) : '—'}</td>
                    <td className={clsx('td text-right text-[12px] tabular-nums', (r.days_pending ?? 0) > 90 && 'font-semibold text-red-600')} title={r.days_pending != null ? `from ${r.ageing_label}` : undefined}>{r.days_pending ?? '—'}</td>
                    <td className="td"><StatusPill status={r.status} label={r.status_label} tone={r.status_tone} />{r.open_followups > 0 && <p className="text-[10.5px] text-violet-700">{r.open_followups} follow-up</p>}</td>
                  </tr>
                  {exp[r.id] && <tr><td /><td colSpan={10} className="bg-slate-50/60 px-3 py-2"><Timeline id={r.id} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
          {list.data?.pagination && <Pager {...list.data.pagination} onPage={setPage} />}
        </div>
      )}
    </div>
  );
}

function Timeline({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['export-benefit-claim', id], queryFn: async () => (await http.get<{ data: any }>(`/export-benefits/claims/${id}`)).data });
  if (q.isLoading) return <LoadingBlock rows={2} />;
  if (q.error) return <ErrorState error={q.error} />;
  const ev = q.data.events.filter((e: any) => e.status !== 'DRAFT');
  if (!ev.length) return <p className="text-[12px] text-slate-400" data-timeline={id}>Nothing received or issued yet.</p>;
  return (
    <div className="flex flex-wrap gap-2" data-timeline={id}>
      {ev.map((e: any) => <span key={e.id} className={clsx('rounded border px-2 py-1 text-[11.5px]', e.status === 'REVERSED' ? 'border-slate-200 text-slate-400 line-through' : e.event_type === 'REVERSAL' ? 'border-red-200 bg-red-50 text-red-700' : e.is_cash ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-indigo-200 bg-indigo-50 text-indigo-800')}>
        <b>{fmtDate(e.event_date)}</b> · {e.label} · {e.event_type === 'REVERSAL' ? '−' : ''}₹{fmtDecimal(e.base_amount, 2)}{e.bank_reference ? ` · ${e.bank_reference}` : ''}{e.scrip_number ? ` · ${e.scrip_number}` : ''}</span>)}
    </div>
  );
}

/* ================================================================ by shipping bill (completion view) */
function Bills({ onOpen }: { onOpen: (id: number) => void }) {
  const toast = useToast();
  const [status, setStatus] = useState('OPEN');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const params = { status: status || undefined, q: dq || undefined };
  const t = useQuery({ queryKey: ['export-incentives', 'tracker', params], queryFn: async () => http.get<{ data: any[]; totals: any; types: any[] }>('/export-incentives/tracker', params) });
  const types = t.data?.types ?? []; const rows = t.data?.data ?? [];
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2.5 p-3">
        <SearchInput className="w-60" value={q} onChange={setQ} placeholder="SB no, invoice, order, buyer…" />
        <Select className="w-48" id="inc-status" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All" options={[{ value: 'OPEN', label: 'Pending (to receive)' }, { value: 'RECEIVED', label: 'Fully settled' }]} />
        <div className="ml-auto"><Button variant="secondary" id="inc-excel" onClick={() => void download('/export-incentives/tracker.xlsx', params, `export_benefits_${todayIst()}.xlsx`, toast)}><Download size={14} />Excel</Button></div>
      </div>
      {t.error ? <div className="card"><ErrorState error={t.error} onRetry={() => void t.refetch()} /></div> : (
        <div className="card overflow-x-auto">
          <table className="w-full" id="inc-tracker">
            <thead><tr><th className="th">Shipping bill</th><th className="th">Invoice · order · buyer</th>{types.map((x) => <th key={x.value} className="th text-right" title={x.name}>{x.label}</th>)}<th className="th text-right">Pending ₹</th><th className="th">All benefits</th></tr></thead>
            <tbody>
              {t.isLoading && <tr><td colSpan={types.length + 4}><LoadingBlock rows={4} /></td></tr>}
              {!t.isLoading && !rows.length && <tr><td colSpan={types.length + 4} className="td py-10 text-center text-slate-400">{status === 'OPEN' ? 'Nothing pending — every benefit is settled' : 'No shipping bills with benefits'}</td></tr>}
              {rows.map((r) => (
                <tr key={r.shipping_bill_id} className="row-hover align-top" data-sb={r.sb_no}>
                  <td className="td whitespace-nowrap text-[12px]"><Link className="tabular-nums font-semibold text-brand-700 hover:underline" to={`/export/shipping-bills/${r.shipping_bill_id}`}>{r.sb_no}</Link>
                    <p className="text-slate-500">{fmtDate(r.sb_date)}{r.pending_days != null && <span className={clsx('ml-1', r.pending_days > 90 ? 'font-semibold text-red-600' : 'text-slate-400')}>· {r.pending_days} d</span>}</p></td>
                  <td className="td text-[12px]">{r.invoice_no ?? '—'}<p className="text-slate-500">{r.so_no ?? ''} · {r.buyer_name ?? ''}</p></td>
                  {types.map((x) => {
                    const c = r.cells[x.value];
                    if (!c) return <td key={x.value} className="td text-right text-[12px] text-slate-300">—</td>;
                    return (
                      <td key={x.value} className="td text-right text-[12px]">
                        <button type="button" className="w-full rounded px-1 py-0.5 text-right hover:bg-slate-50" data-cell={`${r.sb_no}-${x.value}`} onClick={() => onOpen(c.ids[0])}>
                          {c.scrip_capable ? <><span className="tabular-nums font-semibold text-indigo-700">{fmtDecimal(c.scrip_issued, 2)}</span><span className="tabular-nums text-slate-400"> / {fmtDecimal(c.claim, 2)}</span>
                            {c.received > 0 && <span className="block text-[10.5px] text-emerald-700">cash {fmtDecimal(c.received, 2)}</span>}</>
                            : <><span className="tabular-nums font-semibold">{fmtDecimal(c.received, 2)}</span><span className="tabular-nums text-slate-400"> / {fmtDecimal(c.claim, 2)}</span></>}
                          <span className="mt-0.5 block"><StatusPill status={c.status} label={c.status_label} tone={c.status_tone} /></span>
                          {c.last_date && <span className="block whitespace-nowrap text-[10.5px] text-slate-500">last {fmtDate(c.last_date)}</span>}
                        </button>
                      </td>
                    );
                  })}
                  <td className={clsx('td text-right tabular-nums', r.outstanding > 0 && 'font-semibold text-amber-700')}>{fmtDecimal(r.outstanding, 2)}</td>
                  <td className="td"><Badge tone={r.status === 'RECEIVED' ? 'green' : r.status === 'PARTIAL' ? 'blue' : 'amber'}>{r.status === 'RECEIVED' ? 'Settled' : r.status === 'PARTIAL' ? 'Part' : 'Pending'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================================================ receipts by date */
function Receipts({ meta, onOpen }: { meta: Meta; onOpen: (id: number) => void }) {
  const toast = useToast();
  const [p, setP] = useState({ from: `${todayIst().slice(0, 7)}-01`, to: todayIst(), kind: 'CASH', scheme_id: '' });
  const params = Object.fromEntries(Object.entries(p).filter(([, v]) => v));
  const q = useQuery({ queryKey: ['export-benefits', 'receipts', params], queryFn: async () => http.get<{ data: any[]; daily: any[]; total: number }>('/export-benefits/reports/receipts', params) });
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2.5 p-3">
        <Input className="w-36" type="date" label="From" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} />
        <Input className="w-36" type="date" label="To" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} />
        <Select className="w-52" label="Show" id="eb-rc-kind" value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value })} options={[{ value: 'CASH', label: 'Cash (bank, refund, sale proceeds)' }, { value: 'SCRIP', label: 'Scrip events (not cash)' }, { value: 'ALL', label: 'All events' }]} />
        <Select className="w-48" label="Scheme" value={p.scheme_id} placeholder="All" options={meta.schemes.map((s) => ({ value: s.id, label: s.display_name }))} onChange={(e) => setP({ ...p, scheme_id: e.target.value })} />
        <div className="ml-auto"><Button variant="secondary" onClick={() => void download('/export-benefits/reports/receipts', params, `export_benefit_receipts_${p.from}_${p.to}.xlsx`, toast)}><Download size={14} />Excel</Button></div>
      </div>
      {q.error ? <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : (
        <div className="grid gap-3 lg:grid-cols-4">
          <div className="card overflow-x-auto lg:col-span-3">
            <table className="w-full" id="eb-receipts"><thead><tr><th className="th">Actual date</th><th className="th">Benefit</th><th className="th">Event</th><th className="th">SB · invoice</th><th className="th text-right">Amount ₹</th><th className="th">Bank · UTR / scrip</th><th className="th">Posted</th></tr></thead>
              <tbody>{q.isLoading && <tr><td colSpan={7}><LoadingBlock rows={3} /></td></tr>}
                {!q.isLoading && !q.data?.data.length && <tr><td colSpan={7} className="td py-8 text-center text-slate-400">Nothing in this period</td></tr>}
                {q.data?.data.map((r) => <tr key={r.id} className="row-hover cursor-pointer" onClick={() => onOpen(r.claim_id)}><td className="td text-[12px] font-semibold">{fmtDate(r.event_date)}</td><td className="td text-[12px]">{r.scheme_name}</td>
                  <td className="td text-[12px]">{r.label}</td><td className="td text-[12px]">{r.sb_no ?? '—'}<p className="text-slate-500">{r.invoice_no ?? ''}</p></td>
                  <td className={clsx('td text-right tabular-nums', r.signed_amount < 0 && 'text-red-600')}>{fmtDecimal(r.signed_amount, 2)}</td>
                  <td className="td text-[12px]">{r.bank_label ?? ''}<p className="tabular-nums text-[11px]">{r.bank_reference ?? r.scrip_number ?? ''}</p></td><td className="td text-[11px] text-slate-500">{fmtDate(r.posted_at)} · {r.posted_by_name ?? ''}</td></tr>)}</tbody>
              {q.data && q.data.data.length > 0 && <tfoot><tr className="border-t-2 border-slate-200 font-semibold"><td className="td" colSpan={4}>Total</td><td className="td text-right tabular-nums">{fmtDecimal(q.data.total, 2)}</td><td colSpan={2} /></tr></tfoot>}</table>
          </div>
          <div className="card overflow-x-auto"><p className="border-b border-slate-100 px-3 py-2 text-[12.5px] font-semibold text-slate-700">Daily totals</p>
            <table className="w-full" id="eb-daily"><tbody>{q.data?.daily.map((d) => <tr key={d.date}><td className="td text-[12px]">{fmtDate(d.date)}</td><td className="td text-right tabular-nums">{fmtDecimal(d.amount, 2)}</td></tr>)}</tbody></table></div>
        </div>
      )}
    </div>
  );
}

/* ================================================================ ageing */
function Ageing({ onFilter }: { onFilter: (f: Record<string, unknown>) => void }) {
  const toast = useToast();
  const [asOf, setAsOf] = useState(todayIst());
  const q = useQuery({ queryKey: ['export-benefits', 'ageing', asOf], queryFn: async () => (await http.get<{ data: any }>('/export-benefits/reports/ageing', { as_of: asOf })).data });
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2.5 p-3">
        <Input className="w-40" type="date" label="As on" value={asOf} onChange={(e) => setAsOf(e.target.value || todayIst())} />
        <p className="pb-2 text-[12px] text-slate-500">Each scheme is aged from its configured basis date (shown under its name). Settled items stop ageing.</p>
        <div className="ml-auto"><Button variant="secondary" onClick={() => void download('/export-benefits/reports/ageing', { as_of: asOf }, `export_benefit_ageing_${asOf}.xlsx`, toast)}><Download size={14} />Excel</Button></div>
      </div>
      {q.isLoading ? <div className="card"><LoadingBlock rows={4} /></div> : q.error ? <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : (
        <>
          <div className="card overflow-x-auto"><AgeingTable data={q.data} onFilter={(f) => onFilter({ ...f, as_of: asOf })} /></div>
          <div className="card overflow-x-auto">
            <table className="w-full" id="eb-ageing-rows"><thead><tr><th className="th">SB</th><th className="th">Benefit</th><th className="th">Aged from</th><th className="th text-right">Days</th><th className="th">Bucket</th><th className="th text-right">Pending ₹</th><th className="th">Status</th></tr></thead>
              <tbody>{q.data.rows.slice(0, 300).map((r: any) => <tr key={r.id}><td className="td text-[12px] tabular-nums">{r.sb_no ?? '—'}</td><td className="td text-[12px]">{r.scheme_name}</td>
                <td className="td text-[12px]">{fmtDate(r.ageing_date)} <span className="text-slate-400">({r.ageing_label})</span></td><td className="td text-right tabular-nums">{r.days_pending}</td><td className="td text-[12px]">{r.bucket}</td>
                <td className="td text-right tabular-nums">{fmtDecimal(r.pending_amount, 2)}</td><td className="td"><StatusPill status={r.status} label={r.status_label} tone={r.status_tone} /></td></tr>)}</tbody></table>
          </div>
        </>
      )}
    </div>
  );
}

/* ================================================================ follow-ups */
function Followups({ onOpen }: { onOpen: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [st, setSt] = useState('OPEN');
  const [mine, setMine] = useState(false);
  const q = useQuery({ queryKey: ['export-benefits', 'followups', st, mine], queryFn: async () => (await http.get<{ data: any[] }>('/export-benefits/followups', { status: st, mine: mine ? 1 : undefined })).data });
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-3 p-3">
        <Select className="w-40" label="Status" value={st} onChange={(e) => setSt(e.target.value)} options={[{ value: 'OPEN', label: 'Open' }, { value: 'DONE', label: 'Done' }, { value: 'ALL', label: 'All' }]} />
        <div className="pb-2"><Checkbox label="Mine only" checked={mine} onChange={setMine} /></div>
      </div>
      {q.error ? <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : (
        <div className="card overflow-x-auto">
          <table className="w-full" id="eb-followups"><thead><tr><th className="th">Benefit · SB</th><th className="th">Reason</th><th className="th">Next action</th><th className="th">Owner</th><th className="th">Due</th><th className="th text-right">Days open</th><th className="th text-right">Pending ₹</th><th className="th" /></tr></thead>
            <tbody>{q.isLoading && <tr><td colSpan={8}><LoadingBlock rows={3} /></td></tr>}
              {!q.isLoading && !q.data?.length && <tr><td colSpan={8} className="td py-8 text-center text-slate-400">No follow-ups</td></tr>}
              {q.data?.map((f) => <tr key={f.id} className="row-hover"><td className="td text-[12px]"><button className="font-semibold text-brand-700 hover:underline" onClick={() => onOpen(f.claim_id)}>{f.scheme_name}</button><p className="tabular-nums text-slate-500">{f.sb_no ?? ''}</p></td>
                <td className="td text-[12px]">{f.reason_code.toLowerCase().replace('_', ' ')}<p><StatusPill status={f.status} label={f.status_label} tone={f.status_tone} /></p></td><td className="td text-[12px]">{f.action_note}</td><td className="td text-[12px]">{f.owner_name ?? '—'}</td>
                <td className={clsx('td text-[12px]', f.overdue && 'font-semibold text-red-600')}>{fmtDate(f.due_date)}</td><td className="td text-right tabular-nums">{f.days_outstanding}</td><td className="td text-right tabular-nums">{fmtDecimal(f.pending_amount, 2)}</td>
                <td className="td">{f.status === 'OPEN' && <Button size="sm" variant="secondary" onClick={async () => { try { await http.post(`/export-benefits/followups/${f.id}/done`, {}); toast('Done'); void qc.invalidateQueries({ queryKey: ['export-benefits'] }); } catch (e) { toast(errMsg(e), 'error'); } }}>Done</Button>}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}

/* ================================================================ bank reconciliation */
function Recon({ meta, onOpen }: { meta: Meta; onOpen: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const banks = useLookup('company-bank-accounts');
  const [bank, setBank] = useState('');
  const [st, setSt] = useState('UNMATCHED,PARTIAL');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<any | null>(null);
  const lines = useQuery({ queryKey: ['export-benefits', 'bank-lines', st, bank], queryFn: async () => http.get<{ data: any[]; totals: any }>('/export-benefits/bank-lines', { status: st || undefined, bank_account_id: bank || undefined }) });
  const rep = useQuery({ queryKey: ['export-benefits', 'recon-report'], queryFn: async () => (await http.get<{ data: any }>('/export-benefits/reports/reconciliation')).data });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['export-benefits'] }); };
  const act = async (fn: () => Promise<any>, msg: (r: any) => string) => { setBusy(true); try { const r = await fn(); toast(msg(r)); refresh(); return true; } catch (e) { toast(errMsg(e), 'error'); return false; } finally { setBusy(false); } };
  const upload = (f: File) => act(async () => (await http.post<{ data: any }>('/export-benefits/bank-statements/import', { filename: f.name, data: await fileToDataUrl(f), bank_account_id: bank ? Number(bank) : null })).data,
    (r) => `${r.lines_read} credit lines read · ${r.lines_new} new · ${r.duplicates} already imported · ${r.auto_matched} matched automatically`);
  const canRecon = meta.rights.post;
  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2.5 p-3" id="eb-recon-bar">
        <Select className="w-64" label="Bank account" id="eb-recon-bank" value={bank} placeholder="All accounts" options={(banks.data ?? []).map((b) => ({ value: b.id, label: b.label }))} onChange={(e) => setBank(e.target.value)} />
        <Select className="w-48" label="Lines" value={st} onChange={(e) => setSt(e.target.value)} options={[{ value: 'UNMATCHED,PARTIAL', label: 'To reconcile' }, { value: 'MATCHED', label: 'Matched' }, { value: 'IGNORED', label: 'Not benefit credits' }, { value: '', label: 'All' }]} />
        {canRecon && <label className={clsx('btn-secondary cursor-pointer', busy && 'opacity-60')} title="CSV or Excel bank statement — credit lines are imported once (re-importing the same file adds nothing)">
          <Upload size={14} />Import statement<input type="file" className="hidden" id="eb-recon-file" accept=".csv,.xlsx,.xls,.txt" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label>}
        {canRecon && <Button variant="secondary" loading={busy} id="eb-recon-auto" onClick={() => void act(async () => (await http.post<{ data: any }>('/export-benefits/reconciliation/auto', { bank_account_id: bank ? Number(bank) : null })).data, (r) => `${r.matched} matched`)}><Wand2 size={14} />Auto-match</Button>}
        {lines.data?.totals && <p className="ml-auto pb-2 text-[12px] text-slate-600">Unmatched {lines.data.totals.unmatched.count} ({inr(lines.data.totals.unmatched.amount)}) · partial {lines.data.totals.partial.count}</p>}
      </div>
      {rep.data && <div className="grid gap-2 sm:grid-cols-3" id="eb-recon-summary">
        <Tile label="Receipts not in a bank statement" value={inr(rep.data.receipts.unmatched.amount)} sub={`${rep.data.receipts.unmatched.count} receipts`} tone="amber" />
        <Tile label="Receipts partly matched" value={inr(rep.data.receipts.partial.amount)} sub={`${rep.data.receipts.partial.count} receipts`} />
        <Tile label="Receipts matched" value={String(rep.data.receipts.matched.count)} tone="green" />
      </div>}
      {lines.error ? <div className="card"><ErrorState error={lines.error} onRetry={() => void lines.refetch()} /></div> : (
        <div className="card overflow-x-auto">
          <table className="w-full" id="eb-bank-lines"><thead><tr><th className="th">Date</th><th className="th">Bank</th><th className="th">Reference · narration</th><th className="th text-right">Credit ₹</th><th className="th text-right">Unallocated ₹</th><th className="th">Matched to</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody>{lines.isLoading && <tr><td colSpan={8}><LoadingBlock rows={3} /></td></tr>}
              {!lines.isLoading && !lines.data?.data.length && <tr><td colSpan={8} className="td py-8 text-center text-slate-400">No bank lines — import a statement (CSV / Excel with Date, Credit, Reference / Narration columns)</td></tr>}
              {lines.data?.data.map((l) => <tr key={l.id} className="align-top" data-line={l.id}><td className="td text-[12px]">{fmtDate(l.txn_date)}</td><td className="td text-[12px]">{l.bank_label ?? '—'}</td>
                <td className="td text-[12px]"><span className="tabular-nums">{l.reference ?? '—'}</span><p className="max-w-[340px] truncate text-slate-500" title={l.narration ?? ''}>{l.narration ?? ''}</p></td>
                <td className="td text-right tabular-nums">{fmtDecimal(l.amount, 2)}</td><td className="td text-right tabular-nums">{fmtDecimal(l.unallocated, 2)}</td>
                <td className="td text-[12px]">{l.matches.map((m: any) => <p key={m.id}><button className="text-brand-700 hover:underline" onClick={() => onOpen(m.claim_id)}>{m.scheme_name} {m.sb_no ?? ''}</button> {inr(m.matched_amount)}
                  <span className="text-slate-400"> {m.match_type.toLowerCase()}</span>{canRecon && <button className="ml-1 text-[11px] text-red-600 hover:underline" data-undo={m.id} onClick={() => { const reason = window.prompt('Reason to undo this match'); if (reason) void act(() => http.post(`/export-benefits/reconciliation/matches/${m.id}/undo`, { reason }), () => 'Match undone'); }}>undo</button>}</p>)}
                  {l.ignore_reason && <p className="text-slate-500">{l.ignore_reason}</p>}</td>
                <td className="td"><Badge tone={l.match_status === 'MATCHED' ? 'green' : l.match_status === 'PARTIAL' ? 'blue' : l.match_status === 'IGNORED' ? 'slate' : 'amber'}>{l.match_status.toLowerCase()}</Badge></td>
                <td className="td whitespace-nowrap">{canRecon && l.unallocated > 0.005 && l.match_status !== 'IGNORED' && <Button size="sm" variant="secondary" data-match={l.id} onClick={() => setLine(l)}>Match</Button>}
                  {canRecon && l.match_status === 'UNMATCHED' && <button className="ml-2 text-[11px] text-slate-500 hover:underline" onClick={() => { const reason = window.prompt('Why is this not a benefit credit?'); if (reason) void act(() => http.post(`/export-benefits/bank-lines/${l.id}/ignore`, { ignore: true, reason }), () => 'Marked'); }}>not a benefit</button>}
                  {canRecon && l.match_status === 'IGNORED' && <button className="text-[11px] text-brand-700 hover:underline" onClick={() => void act(() => http.post(`/export-benefits/bank-lines/${l.id}/ignore`, { ignore: false }), () => 'Restored')}>restore</button>}</td></tr>)}</tbody></table>
        </div>
      )}
      {rep.data?.scrips?.length > 0 && (
        <div className="card overflow-x-auto"><p className="border-b border-slate-100 px-3 py-2 text-[12.5px] font-semibold text-slate-700">Scrip register — compare with the ICEGATE e-scrip ledger</p>
          <table className="w-full" id="eb-scrips"><thead><tr><th className="th">Scrip no</th><th className="th">Scheme</th><th className="th text-right">Issued / in</th><th className="th text-right">Utilised</th><th className="th text-right">Sold / out</th><th className="th text-right">Expired</th><th className="th text-right">Balance</th><th className="th">Last event</th></tr></thead>
            <tbody>{rep.data.scrips.map((x: any) => <tr key={`${x.scrip_number}-${x.scheme_name}`}><td className="td tabular-nums text-[12px]">{x.scrip_number}</td><td className="td text-[12px]">{x.scheme_name}</td><td className="td text-right tabular-nums">{fmtDecimal(x.issued, 2)}</td>
              <td className="td text-right tabular-nums">{fmtDecimal(x.utilised, 2)}</td><td className="td text-right tabular-nums">{fmtDecimal(x.sold, 2)}</td><td className="td text-right tabular-nums">{fmtDecimal(x.expired, 2)}</td>
              <td className={clsx('td text-right tabular-nums font-semibold', x.balance < 0 && 'text-red-600')}>{fmtDecimal(x.balance, 2)}</td><td className="td text-[12px]">{fmtDate(x.last_date)}</td></tr>)}</tbody></table></div>
      )}
      {line && <MatchModal line={line} onClose={() => setLine(null)} onDone={() => { setLine(null); refresh(); }} />}
    </div>
  );
}

function MatchModal({ line, onClose, onDone }: { line: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const c = useQuery({ queryKey: ['export-benefits', 'candidates', line.id], queryFn: async () => (await http.get<{ data: any[] }>('/export-benefits/reconciliation/events', { bank_line_id: line.id })).data });
  const [pick, setPick] = useState<any | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const differs = useMemo(() => pick && ((line.reference && pick.bank_reference && line.reference.toUpperCase().replace(/[^A-Z0-9]/g, '') !== pick.bank_reference.toUpperCase().replace(/[^A-Z0-9]/g, '')) || Math.abs(line.amount - pick.base_amount) > 0.005), [pick, line]);
  const save = async () => {
    setBusy(true);
    try { await http.post('/export-benefits/reconciliation/match', { bank_line_id: line.id, event_id: pick.id, amount: amount ? Number(amount) : null, reason: reason || null }); toast('Matched'); onDone(); }
    catch (e) { toast(e instanceof ApiError ? e.message : errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={`Match bank credit ${inr(line.amount)} · ${fmtDate(line.txn_date)}`} subtitle={`${line.reference ?? ''} ${line.narration ?? ''}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><Button id="eb-match-save" loading={busy} disabled={!pick || (differs && reason.trim().length < 3)} onClick={() => void save()}>Match</Button></>}>
      {c.isLoading ? <LoadingBlock rows={3} /> : c.error ? <ErrorState error={c.error} /> : !c.data?.length ? <EmptyState title="No unmatched receipts" message="Record the receipt on its benefit first (actual date, amount, UTR), then match." /> : (
        <table className="w-full" id="eb-candidates"><thead><tr><th className="th" /><th className="th">Date</th><th className="th">Benefit · SB</th><th className="th">UTR</th><th className="th text-right">Unmatched ₹</th></tr></thead>
          <tbody>{c.data.map((e) => <tr key={e.id} className={clsx('row-hover cursor-pointer', pick?.id === e.id && 'bg-brand-50')} data-candidate={e.id} onClick={() => { setPick(e); setAmount(String(Math.min(e.unmatched, line.unallocated))); }}>
            <td className="td"><input type="radio" readOnly checked={pick?.id === e.id} /></td><td className="td text-[12px]">{fmtDate(e.event_date)}</td><td className="td text-[12px]">{e.scheme_name} <span className="tabular-nums">{e.sb_no ?? ''}</span><p className="text-slate-500">{e.label} · {e.bank_label ?? ''}</p></td>
            <td className="td tabular-nums text-[12px]">{e.bank_reference ?? '—'}</td><td className="td text-right tabular-nums">{fmtDecimal(e.unmatched, 2)}</td></tr>)}</tbody></table>
      )}
      {pick && <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Input label="Amount to allocate" type="number" step="any" id="eb-match-amount" value={amount} onChange={(e) => setAmount(e.target.value)} hint={`Line unallocated ${inr(line.unallocated)}`} />
        <Input className="sm:col-span-2" label="Reason" required={!!differs} id="eb-match-reason" value={reason} onChange={(e) => setReason(e.target.value)} hint={differs ? 'Reference or amount differ — reason required' : undefined} />
      </div>}
    </Modal>
  );
}
