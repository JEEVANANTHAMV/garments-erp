import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Paperclip, Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { Badge, Button, Input, Select, Textarea, Modal, LoadingBlock, ErrorState, Tabs, Checkbox } from '../../components/ui';
import { http, api, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useLookup } from '../../hooks/useLookup';
import { fmtDate, fmtDateTime, fmtDecimal } from '../../lib/format';

/**
 * Shared pieces of the Export Benefits workspace (client voice note 24-Oct-2026; specs v1 + v2): the meta hook (all
 * labels, schemes, event types and statuses come from the API — nothing hard-coded here), dynamic custom fields from the
 * scheme configuration, and the claim drawer (timeline of dated events, receipt / scrip forms, reversal, Not applicable,
 * follow-ups, documents, history).
 */
export const errMsg = (e: unknown, f = 'Something went wrong') => {
  if (e instanceof ApiError) { const fe = Object.values(e.fieldErrors); return fe.length && e.code === 'VALIDATION_ERROR' ? fe.join(' · ') : e.message; }
  return f;
};
export const inr = (v: unknown) => `₹ ${fmtDecimal(v, 2)}`;
export const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
export const fileToDataUrl = (f: File) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(f); });

export interface Meta {
  event_types: { value: string; label: string; kind: string; modes: string[]; needs_bank: boolean; needs_scrip: boolean; needs_reason: boolean; settles: boolean }[];
  statuses: { value: string; label: string; tone: string; open: boolean }[];
  tracking_modes: Opt[]; categories: Opt[]; settlement_bases: Opt[]; ageing_bases: Opt[]; policies: Opt[]; field_types: string[]; doc_stages: Opt[]; buckets: string[];
  settings: { dup_ref_policy: string; tolerance: number; base_currency: string };
  schemes: { id: number; code: string; display_name: string; short_name: string | null; tracking_mode: string; is_active: number; is_suggested: number; sb_field: string | null;
    sort_order: number; effective_from: string | null; effective_to: string | null; allow_multiple: number; custom_fields: CustomField[]; allowed_events: string[]; ageing_label: string }[];
  rights: { post: boolean; approve: boolean; admin: boolean; export: boolean; draft: boolean; na: boolean };
}
type Opt = { value: string; label: string };
export interface CustomField { key: string; label: string; type: string; required?: boolean; applies_to: 'CLAIM' | 'EVENT'; options?: string[]; min?: number | null; max?: number | null;
  max_length?: number | null; pattern?: string | null; event_types?: string[]; help?: string | null }

export function useBenefitMeta() {
  return useQuery({ queryKey: ['export-benefits', 'meta'], queryFn: async () => (await http.get<{ data: Meta }>('/export-benefits/meta')).data, staleTime: 30_000 });
}

export function StatusPill({ status, label, tone }: { status?: string | null; label?: string | null; tone?: string | null }) {
  return <span className="whitespace-nowrap" data-status={status ?? ''}><Badge tone={tone ?? 'slate'}>{label ?? status ?? '—'}</Badge></span>;
}

/** Renders a scheme's custom fields (claim or event) — the same component powers the scheme master preview. */
export function DynamicFields({ fields, values, onChange, errors = {}, disabled, idPrefix = 'cf' }: {
  fields: CustomField[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; errors?: Record<string, string>; disabled?: boolean; idPrefix?: string;
}) {
  if (!fields.length) return null;
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  return (
    <>
      {fields.map((f) => {
        const err = errors[`custom.${f.key}`];
        const id = `${idPrefix}-${f.key}`;
        const v = values[f.key];
        if (f.type === 'checkbox') return <div key={f.key} className="self-end pb-2"><Checkbox label={`${f.label}${f.required ? ' *' : ''}`} checked={!!v} disabled={disabled} onChange={(c: boolean) => set(f.key, c)} /></div>;
        if (f.type === 'select') return <Select key={f.key} id={id} label={f.label} required={f.required} disabled={disabled} value={String(v ?? '')} error={err} hint={f.help ?? undefined}
          placeholder="— Select —" options={(f.options ?? []).map((o) => ({ value: o, label: o }))} onChange={(e) => set(f.key, e.target.value)} />;
        return <Input key={f.key} id={id} label={f.label} required={f.required} disabled={disabled} error={err} hint={f.help ?? undefined}
          type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step={f.type === 'number' ? 'any' : undefined} value={v == null ? '' : String(v)}
          maxLength={f.max_length ?? undefined} onChange={(e) => set(f.key, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />;
      })}
    </>
  );
}
export const cleanValues = (v: Record<string, unknown>) => { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) if (x !== '' && x != null) o[k] = x; return Object.keys(o).length ? o : null; };

export async function openDocument(id: number, name?: string) {
  const r = await api.get(`/export-benefits/documents/${id}/file`, { responseType: 'blob' });
  const url = URL.createObjectURL(r.data);
  const w = window.open(url, '_blank');
  if (!w) { const a = document.createElement('a'); a.href = url; a.download = name ?? 'document'; a.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function Tile({ label, value, sub, tone, onClick, id }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; onClick?: () => void; id?: string }) {
  const cls = clsx('card px-3 py-2 text-left', onClick && 'cursor-pointer transition hover:border-brand-300 hover:shadow');
  const body = (
    <>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx('text-[16px] font-semibold tabular-nums', tone === 'green' && 'text-emerald-700', tone === 'amber' && 'text-amber-700', tone === 'red' && 'text-red-700', tone === 'indigo' && 'text-indigo-700')}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </>
  );
  return onClick ? <button type="button" id={id} className={cls} onClick={onClick}>{body}</button> : <div id={id} className={cls}>{body}</div>;
}

/* ================================================================ claim drawer */
export function ClaimDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useBenefitMeta();
  const q = useQuery({ queryKey: ['export-benefit-claim', id], queryFn: async () => (await http.get<{ data: any }>(`/export-benefits/claims/${id}`)).data });
  const users = useLookup('users');
  const [tab, setTab] = useState('timeline');
  const [form, setForm] = useState<string | null>(null);
  const [rev, setRev] = useState<any | null>(null);
  const [stage, setStage] = useState<null | 'QUERY' | 'REJECT' | 'SHORT_CLOSE' | 'NA'>(null);
  const [sv, setSv] = useState<any>({ reason: '', owner_user_id: '', due_date: '' });
  const [fu, setFu] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const x = q.data; const M = meta.data; const rights = M?.rights;
  const refresh = () => { void q.refetch(); void qc.invalidateQueries({ queryKey: ['export-benefits'] }); void qc.invalidateQueries({ queryKey: ['export-incentives'] }); void qc.invalidateQueries({ queryKey: ['shipping-bill'] }); };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast(done); refresh(); return true; } catch (e) { toast(errMsg(e), 'error'); return false; } finally { setBusy(false); }
  };
  if (q.error) return <Modal open onClose={onClose} title="Benefit"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Modal>;
  const scrip = x?.scrip_capable;
  const evTypes = (M?.event_types ?? []).filter((t) => x?.config.allowed_events.includes(t.value) && t.value !== 'REVERSAL');
  const closed = x && ['REJECTED', 'SHORT_CLOSED', 'NOT_APPLICABLE'].includes(x.status);
  return (
    <Modal open onClose={onClose} size="xl" title={x ? `${x.scheme_name} · ${x.sb_no ? `SB ${x.sb_no}` : 'claim'}` : 'Benefit'}
      subtitle={x ? `${x.invoice_no ?? ''}${x.so_no ? ` · ${x.so_no}` : ''}${x.buyer_name ? ` · ${x.buyer_name}` : ''} · ${x.mode_label} · config v${x.config.version}${x.config.is_active ? '' : ' (scheme inactive)'}` : undefined}
      footerStart={x && <div className="flex flex-wrap gap-2" id="bc-actions">
        {x.applicability === 'NOT_APPLICABLE'
          ? rights?.na && <Button size="sm" variant="secondary" id="bc-applicable" loading={busy} onClick={() => void run(() => http.post(`/export-benefits/claims/${id}/applicability`, { applicable: true }), 'Marked applicable')}>Mark applicable</Button>
          : <>
            {rights?.na && x.net_cash + x.adjusted_amount + x.scrip_issued === 0 && <Button size="sm" variant="secondary" id="bc-na" onClick={() => { setStage('NA'); setSv({ reason: '' }); }}>Not applicable</Button>}
            {(rights?.export || rights?.post) && !closed && x.status !== 'QUERY' && x.pending_amount > 0 && <Button size="sm" variant="secondary" id="bc-query" onClick={() => { setStage('QUERY'); setSv({ reason: '', owner_user_id: '', due_date: '' }); }}>Query</Button>}
            {(rights?.export || rights?.post) && !closed && x.pending_amount > 0 && (x.net_cash + x.adjusted_amount + x.scrip_issued > 0
              ? <Button size="sm" variant="secondary" id="bc-short" onClick={() => { setStage('SHORT_CLOSE'); setSv({ reason: '' }); }}>Short-close balance</Button>
              : <Button size="sm" variant="secondary" id="bc-reject" onClick={() => { setStage('REJECT'); setSv({ reason: '', owner_user_id: '', due_date: '' }); }}>Rejected</Button>)}
            {(rights?.export || rights?.post) && ['REJECTED', 'SHORT_CLOSED', 'QUERY'].includes(x.status) && <Button size="sm" variant="secondary" id="bc-reopen" loading={busy}
              onClick={() => void run(() => http.post(`/export-benefits/claims/${id}/stage`, { action: 'REOPEN' }), 'Claim reopened')}>{x.status === 'QUERY' ? 'Query resolved' : 'Reopen'}</Button>}
          </>}
      </div>}
      footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      {!x || !M ? <LoadingBlock rows={5} /> : (
        <div className="space-y-3" id="benefit-claim">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
            <Tile label="Declared" value={x.declared_amount == null ? 'Not known' : inr(x.declared_amount)} sub={x.claimed_amount != null ? `claimed ${inr(x.claimed_amount)}` : 'claim not filed'} />
            <Tile label="Basis" value={x.basis_amount == null ? '—' : inr(x.basis_amount)} sub={x.approved_amount != null ? `approved ${inr(x.approved_amount)} · ${x.basis_label}` : x.basis_label} />
            <Tile label="Cash received" value={inr(x.net_cash)} tone="green" sub={x.sale_proceeds > 0 ? `incl. sale proceeds ${inr(x.sale_proceeds)}` : x.adjusted_amount > 0 ? `+ adjusted ${inr(x.adjusted_amount)}` : 'bank credits'} />
            {scrip && <Tile label="Scrip issued / available" value={`${fmtDecimal(x.scrip_issued, 2)} / ${fmtDecimal(x.scrip_available, 2)}`} tone="indigo"
              sub={`utilised ${fmtDecimal(x.scrip_utilised, 2)} · sold ${fmtDecimal(x.scrip_sold, 2)}${x.scrip_expired ? ` · expired ${fmtDecimal(x.scrip_expired, 2)}` : ''}`} />}
            <Tile label={scrip ? 'Pending (not issued)' : 'Pending'} value={inr(x.pending_amount)} tone="amber" sub={x.days_pending != null ? `${x.days_pending} days · from ${x.ageing_label}` : x.last_event_date ? `last event ${fmtDate(x.last_event_date)}` : undefined} />
            <div className="card flex flex-col justify-center gap-1 px-3 py-2"><StatusPill status={x.status} label={x.status_label} tone={x.status_tone} />
              {x.excess_amount > 0 && <Badge tone="red">Excess {inr(x.excess_amount)}</Badge>}
              {(x.not_applicable_reason || x.closed_reason) && <p className="text-[11px] text-slate-500">{x.not_applicable_reason ?? x.closed_reason}</p>}</div>
          </div>
          {stage && <StageForm stage={stage} sv={sv} setSv={setSv} users={users.data ?? []} busy={busy} onCancel={() => setStage(null)}
            onSave={async () => { const ok = stage === 'NA' ? await run(() => http.post(`/export-benefits/claims/${id}/applicability`, { applicable: false, reason: sv.reason }), 'Marked Not applicable')
              : await run(() => http.post(`/export-benefits/claims/${id}/stage`, { action: stage, reason: sv.reason, owner_user_id: sv.owner_user_id || null, due_date: sv.due_date || null }), 'Saved');
            if (ok) setStage(null); }} />}
          <Tabs active={tab} onChange={setTab} tabs={[{ key: 'timeline', label: 'Timeline', count: x.events.length }, { key: 'docs', label: 'Documents', count: x.all_documents.length },
            { key: 'followups', label: 'Follow-ups', count: x.followups.filter((f: any) => f.status === 'OPEN').length }, { key: 'history', label: 'Status history' }, { key: 'audit', label: 'Audit' }]} />
          {tab === 'timeline' && (
            <div className="space-y-3">
              <div className="overflow-x-auto">
                <table className="w-full" id="bc-timeline">
                  <thead><tr><th className="th">Actual date</th><th className="th">Event</th><th className="th text-right">Amount ₹</th><th className="th">Bank / UTR · scrip</th>
                    <th className="th">Entered · posted</th><th className="th">Status</th><th className="th" /></tr></thead>
                  <tbody>
                    {!x.events.length && <tr><td colSpan={7} className="td py-6 text-center text-[12px] text-slate-400">Nothing recorded yet — add the receipt or scrip on the day it comes</td></tr>}
                    {x.events.map((e: any) => (
                      <tr key={e.id} data-event={e.event_type} data-event-id={e.id} className={clsx(e.status === 'REVERSED' && 'text-slate-400 line-through decoration-slate-300', e.event_type === 'REVERSAL' && 'bg-red-50/40')}>
                        <td className="td whitespace-nowrap text-[12px] font-semibold">{fmtDate(e.event_date)}</td>
                        <td className="td text-[12px]">{e.label}{e.is_exception ? <span className="ml-1"><Badge tone="red">exception</Badge></span> : null}
                          {e.remarks && <p className="text-[11px] text-slate-500 no-underline">{e.remarks}</p>}
                          {e.custom_field_values && <p className="text-[11px] text-slate-500">{Object.entries(e.custom_field_values).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</p>}</td>
                        <td className="td text-right tabular-nums">{e.event_type === 'REVERSAL' ? '−' : ''}{fmtDecimal(e.base_amount, 2)}{e.currency_code !== 'INR' && <p className="text-[10.5px] text-slate-400">{e.currency_code} {fmtDecimal(e.amount, 2)} @ {e.exchange_rate}</p>}</td>
                        <td className="td text-[12px]">{e.bank_label && <span>{e.bank_label}</span>}{e.bank_reference && <p className="tabular-nums text-[11px]">{e.bank_reference}</p>}
                          {e.scrip_number && <p className="tabular-nums text-[11px]">Scrip {e.scrip_number}</p>}{e.is_cash && e.status === 'POSTED' && <p className="text-[10.5px] text-slate-400">bank match {inr(e.matched_amount)}</p>}
                          {e.documents?.map((d: any) => <button key={d.id} className="mr-1 inline-flex items-center gap-0.5 text-[11px] text-brand-700 hover:underline" onClick={() => void openDocument(d.id, d.original_name).catch((er) => toast(errMsg(er), 'error'))}><Paperclip size={11} />{d.original_name}</button>)}</td>
                        <td className="td whitespace-nowrap text-[11px] text-slate-500">{fmtDateTime(e.created_at)} · {e.created_by_name ?? ''}{e.posted_at && <p>posted {fmtDateTime(e.posted_at)}{e.posted_by_name ? ` · ${e.posted_by_name}` : ''}</p>}</td>
                        <td className="td"><Badge tone={e.status === 'POSTED' ? 'green' : e.status === 'DRAFT' ? 'amber' : 'slate'}>{e.status.toLowerCase()}</Badge></td>
                        <td className="td whitespace-nowrap">
                          {e.status === 'DRAFT' && rights?.post && <button className="mr-2 text-brand-700 hover:underline" title="Post" data-post={e.id} onClick={() => void run(() => http.post(`/export-benefits/events/${e.id}/post`, {}), 'Posted')}><Send size={14} /></button>}
                          {e.status === 'DRAFT' && rights?.draft && <button className="text-slate-400 hover:text-red-600" title="Delete draft" onClick={() => void run(() => http.del(`/export-benefits/events/${e.id}`), 'Draft deleted')}><Trash2 size={14} /></button>}
                          {e.status === 'POSTED' && e.event_type !== 'REVERSAL' && rights?.post && rights?.approve && <button className="text-slate-400 hover:text-red-600" title="Reverse (with reason)" data-reverse={e.id}
                            onClick={() => setRev({ id: e.id, label: `${e.label} ${fmtDate(e.event_date)} ${inr(e.base_amount)}`, reason: '' })}><RotateCcw size={14} /></button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rev && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3" id="bc-reverse-form">
                  <p className="mb-2 text-[12.5px] text-red-900">Reverse {rev.label}? The original stays in the history; a reversal row nets it out.</p>
                  <Textarea label="Reason" required id="bc-reverse-reason" rows={2} value={rev.reason} onChange={(e) => setRev({ ...rev, reason: e.target.value })} />
                  <div className="mt-2 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setRev(null)}>Cancel</button>
                    <Button variant="danger" loading={busy} id="bc-reverse-save" disabled={rev.reason.trim().length < 3}
                      onClick={async () => { if (await run(() => http.post(`/export-benefits/events/${rev.id}/reverse`, { reason: rev.reason }), 'Reversed')) setRev(null); }}>Reverse</Button></div>
                </div>
              )}
              {!form && !closed && (rights?.post || rights?.draft || rights?.export) && (
                <div className="flex flex-wrap gap-2" id="bc-add">
                  {evTypes.filter((t) => rights?.post || rights?.draft || ['CLAIM_FILED', 'APPROVAL'].includes(t.value)).map((t) => (
                    <Button key={t.value} size="sm" variant={['BANK_RECEIPT', 'REFUND_CREDIT', 'SCRIP_ISSUE'].includes(t.value) ? 'primary' : 'secondary'} data-add-event={t.value} onClick={() => setForm(t.value)}>
                      <Plus size={13} />{t.label}</Button>
                  ))}
                </div>
              )}
              {form && <EventForm claim={x} meta={M} type={form} onCancel={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
            </div>
          )}
          {tab === 'docs' && <DocsTab claim={x} canEdit={!!(rights?.export || rights?.post)} onChanged={refresh} />}
          {tab === 'followups' && (
            <div className="space-y-2">
              <table className="w-full" id="bc-followups"><thead><tr><th className="th">Reason</th><th className="th">Next action</th><th className="th">Owner</th><th className="th">Due</th><th className="th">Status</th><th className="th" /></tr></thead>
                <tbody>{!x.followups.length && <tr><td colSpan={6} className="td py-4 text-center text-[12px] text-slate-400">No follow-ups</td></tr>}
                  {x.followups.map((f: any) => <tr key={f.id}><td className="td text-[12px]">{f.reason_code.toLowerCase().replace('_', ' ')}</td><td className="td text-[12px]">{f.action_note}{f.done_note && <p className="text-slate-500">done: {f.done_note}</p>}</td>
                    <td className="td text-[12px]">{f.owner_name ?? '—'}</td><td className={clsx('td text-[12px]', f.overdue && 'font-semibold text-red-600')}>{fmtDate(f.due_date)}</td>
                    <td className="td"><Badge tone={f.status === 'OPEN' ? (f.overdue ? 'red' : 'amber') : 'green'}>{f.status.toLowerCase()}</Badge></td>
                    <td className="td">{f.status === 'OPEN' && (rights?.export || rights?.post) && <Button size="sm" variant="secondary" onClick={() => void run(() => http.post(`/export-benefits/followups/${f.id}/done`, {}), 'Follow-up done')}>Done</Button>}</td></tr>)}</tbody></table>
              {(rights?.export || rights?.post) && (fu ? (
                <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4" id="bc-fu-form">
                  <Input className="sm:col-span-2" label="Next action" required value={fu.action_note} onChange={(e) => setFu({ ...fu, action_note: e.target.value })} />
                  <Select label="Owner" value={fu.owner_user_id} placeholder="Me" options={(users.data ?? []).map((u) => ({ value: u.id, label: u.label }))} onChange={(e) => setFu({ ...fu, owner_user_id: e.target.value })} />
                  <Input label="Due date" type="date" value={fu.due_date} onChange={(e) => setFu({ ...fu, due_date: e.target.value })} />
                  <div className="flex justify-end gap-2 sm:col-span-4"><button className="btn-secondary" onClick={() => setFu(null)}>Cancel</button>
                    <Button loading={busy} disabled={fu.action_note.trim().length < 3} onClick={async () => { if (await run(() => http.post(`/export-benefits/claims/${id}/followups`, { action_note: fu.action_note, owner_user_id: fu.owner_user_id || null, due_date: fu.due_date || null }), 'Follow-up added')) setFu(null); }}>Add</Button></div>
                </div>) : <Button size="sm" variant="secondary" id="bc-fu-add" onClick={() => setFu({ action_note: '', owner_user_id: '', due_date: '' })}><Plus size={13} />Follow-up</Button>)}
            </div>
          )}
          {tab === 'history' && (
            <table className="w-full"><thead><tr><th className="th">When</th><th className="th">From → to</th><th className="th">Reason</th><th className="th">By</th></tr></thead>
              <tbody>{x.status_history.map((h: any) => <tr key={h.id}><td className="td text-[12px]">{fmtDateTime(h.changed_at)}</td>
                <td className="td text-[12px]">{h.old_status ? `${statusLabel(M, h.old_status)} → ` : ''}<b>{statusLabel(M, h.new_status)}</b></td><td className="td text-[12px]">{h.reason ?? ''}</td><td className="td text-[12px]">{h.changed_by_name ?? ''}</td></tr>)}</tbody></table>
          )}
          {tab === 'audit' && (
            <table className="w-full" id="bc-audit"><thead><tr><th className="th">When</th><th className="th">What</th><th className="th">Change</th><th className="th">By</th></tr></thead>
              <tbody>{x.audit.map((a: any) => <tr key={a.id} className="align-top"><td className="td whitespace-nowrap text-[12px]">{fmtDateTime(a.changed_at)}</td><td className="td text-[12px]">{a.table_name.replace('trx_export_', '').replace(/_/g, ' ')} #{a.record_id} · {a.action.toLowerCase()}</td>
                <td className="td max-w-[480px] break-words tabular-nums text-[10.5px] text-slate-600">{a.old_values ? `${JSON.stringify(a.old_values).slice(0, 200)} → ` : ''}{a.new_values ? JSON.stringify(a.new_values).slice(0, 300) : ''}</td><td className="td text-[12px]">{a.changed_by_name ?? ''}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
    </Modal>
  );
}
const statusLabel = (M: Meta, s: string) => M.statuses.find((x) => x.value === s)?.label ?? s;

function StageForm({ stage, sv, setSv, users, busy, onCancel, onSave }: { stage: string; sv: any; setSv: (v: any) => void; users: { id: number; label: string }[]; busy: boolean; onCancel: () => void; onSave: () => void }) {
  const text: Record<string, string> = { NA: 'This benefit does not apply to the shipping bill — it stops showing as pending (reason required, audited).', QUERY: 'The authority raised a query — the owner follows it up by the due date.',
    REJECT: 'The whole claim is rejected — nothing will come. A follow-up is kept with the owner and due date.', SHORT_CLOSE: 'The balance will not come — it stops showing as pending.' };
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3" id="bc-stage-form">
      <p className="mb-2 text-[12.5px] text-amber-900">{text[stage]}</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Textarea className="sm:col-span-2" label="Reason" required id="bc-stage-reason" rows={2} value={sv.reason} onChange={(e) => setSv({ ...sv, reason: e.target.value })} />
        {(stage === 'QUERY' || stage === 'REJECT') && <>
          <Select label="Owner" id="bc-stage-owner" value={sv.owner_user_id} placeholder="Me" options={users.map((u) => ({ value: u.id, label: u.label }))} onChange={(e) => setSv({ ...sv, owner_user_id: e.target.value })} />
          <Input label="Due date" type="date" id="bc-stage-due" value={sv.due_date} hint="Blank = in 7 days" onChange={(e) => setSv({ ...sv, due_date: e.target.value })} /></>}
      </div>
      <div className="mt-2 flex justify-end gap-2"><button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <Button loading={busy} id="bc-stage-save" disabled={sv.reason.trim().length < 3} onClick={onSave}>Confirm</Button></div>
    </div>
  );
}

/** Receipt / scrip / claim event form — fields depend on the event type and the scheme configuration of the claim. */
function EventForm({ claim, meta, type, onCancel, onSaved }: { claim: any; meta: Meta; type: string; onCancel: () => void; onSaved: () => void }) {
  const toast = useToast();
  const banks = useLookup('company-bank-accounts');
  const t = meta.event_types.find((e) => e.value === type)!;
  const fields = (claim.config.custom_fields as CustomField[]).filter((f) => f.applies_to === 'EVENT' && (!f.event_types?.length || f.event_types.includes(type)));
  const suggested = t.kind === 'SCRIP_OUT' ? claim.scrip_available : t.settles ? claim.pending_amount : type === 'CLAIM_FILED' ? claim.declared_amount : type === 'APPROVAL' ? (claim.claimed_amount ?? claim.declared_amount) : '';
  const defBank = (banks.data ?? []).find((b) => b.is_default)?.id ?? (banks.data ?? [])[0]?.id ?? '';
  const lastScrip = [...claim.events].reverse().find((e: any) => e.scrip_number)?.scrip_number ?? '';
  const [v, setV] = useState<any>({ event_date: todayIst(), amount: suggested ? String(suggested) : '', currency_code: 'INR', exchange_rate: '', rate_date: '', bank_account_id: '', bank_reference: '',
    scrip_number: t.kind === 'SCRIP_OUT' ? lastScrip : '', source_document_no: '', remarks: '', cf: {}, post: meta.rights.post, allow_excess: false, allow_early_date: false, allow_inactive: false, exception_reason: '', file: null as File | null, doc_type: t.kind === 'CASH' || t.kind === 'PROCEEDS' ? 'BANK_ADVICE' : t.kind.startsWith('SCRIP') ? 'SCRIP_LEDGER' : 'OTHER' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<string | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const amt = Number(v.amount) || 0;
  const overBy = t.settles && claim.basis_amount != null ? Math.round((claim.net_cash - claim.sale_proceeds + claim.adjusted_amount + claim.scrip_issued + amt - claim.basis_amount) * 100) / 100 : 0;
  const overAvail = t.kind === 'SCRIP_OUT' && amt > claim.scrip_available + 0.005;
  const early = claim.sb_date && v.event_date && v.event_date < claim.sb_date;
  const save = async (ackDup = false) => {
    setBusy(true); setErrors({});
    try {
      const document = v.file ? { filename: v.file.name, data: await fileToDataUrl(v.file), doc_type: v.doc_type || 'OTHER' } : null;
      const r = await http.post<{ data: any }>(`/export-benefits/claims/${claim.id}/events`, {
        event_type: type, event_date: v.event_date, amount: Number(v.amount), currency_code: v.currency_code || 'INR', exchange_rate: v.exchange_rate ? Number(v.exchange_rate) : null, rate_date: v.rate_date || null,
        bank_account_id: t.needs_bank ? Number(v.bank_account_id || defBank) || null : null, bank_reference: v.bank_reference || null, scrip_number: v.scrip_number || null,
        source_document_no: v.source_document_no || null, remarks: v.remarks || null, custom_field_values: cleanValues(v.cf), post: !!v.post,
        allow_excess: v.allow_excess || undefined, allow_early_date: v.allow_early_date || undefined, allow_inactive: v.allow_inactive || undefined, ack_duplicate: ackDup || undefined,
        exception_reason: v.exception_reason || null, document });
      if (r.data.warnings?.length) toast(`Saved — ${r.data.warnings.join(' · ')}`, 'error'); else toast(v.post ? `${t.label} posted` : 'Draft saved');
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_REFERENCE' && meta.settings.dup_ref_policy !== 'BLOCK') { setDup(e.message); return; }
      if (e instanceof ApiError) { setErrors(e.fieldErrors); setWarn([e.message]); }
      toast(errMsg(e), 'error');
    } finally { setBusy(false); }
  };
  const isClaim = ['CLAIM_FILED', 'APPROVAL'].includes(type);
  return (
    <div className="rounded-lg border border-brand-200 bg-brand-50/30 p-3" id="bc-event-form" data-type={type}>
      <p className="mb-2 text-[13px] font-semibold text-slate-800">{t.label} — {claim.scheme_name}{!t.settles && !isClaim && t.kind !== 'SCRIP_OUT' && t.kind !== 'PROCEEDS' ? '' : ''}</p>
      {t.kind === 'SCRIP_IN' && <p className="mb-2 text-[11.5px] text-indigo-700">A scrip issue is not cash — it shows as scrip available until it is utilised or sold.</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        <Input label={isClaim ? 'Date' : 'Actual date (bank credit / issue)'} type="date" required id="ev-date" value={v.event_date} max={todayIst()} error={errors.event_date}
          hint={early ? `Before the SB date ${fmtDate(claim.sb_date)} — exception needed` : 'Date of the source document, not today\'s entry'} onChange={(e) => set('event_date', e.target.value)} />
        <Input label={`Amount${v.currency_code !== 'INR' ? ` (${v.currency_code})` : ' (₹)'}`} type="number" step="any" required id="ev-amount" value={v.amount} error={errors.amount}
          hint={t.kind === 'SCRIP_OUT' ? `Available ${inr(claim.scrip_available)}` : t.settles ? `Pending ${inr(claim.pending_amount)}` : undefined} onChange={(e) => set('amount', e.target.value)} />
        <Input label="Currency" id="ev-currency" value={v.currency_code} maxLength={3} onChange={(e) => set('currency_code', e.target.value.toUpperCase())} />
        {v.currency_code !== 'INR' ? <><Input label="Exchange rate (₹)" type="number" step="any" required value={v.exchange_rate} error={errors.exchange_rate} onChange={(e) => set('exchange_rate', e.target.value)} />
          <Input label="Rate date" type="date" required value={v.rate_date} onChange={(e) => set('rate_date', e.target.value)} /></> : <div className="hidden sm:block" />}
        {t.needs_bank && <Select label="Bank account" required id="ev-bank" value={v.bank_account_id || defBank} error={errors.bank_account_id} placeholder="— Select —"
          options={(banks.data ?? []).map((b) => ({ value: b.id, label: b.label }))} onChange={(e) => set('bank_account_id', e.target.value)} hint={banks.data && !banks.data.length ? 'Add our bank account in Masters → Bank accounts' : undefined} />}
        {(t.needs_bank || type === 'ADJUSTMENT') && <Input label="UTR / bank reference" id="ev-ref" value={v.bank_reference} onChange={(e) => { set('bank_reference', e.target.value); setDup(null); }} />}
        {(t.needs_scrip || t.kind === 'SCRIP_OUT' || type === 'EXPIRY') && <Input label="Scrip number" required={t.needs_scrip} id="ev-scrip" value={v.scrip_number} error={errors.scrip_number} onChange={(e) => set('scrip_number', e.target.value)} />}
        <Input label={type === 'APPROVAL' ? 'Sanction / approval ref' : 'Source document no'} id="ev-srcdoc" value={v.source_document_no} onChange={(e) => set('source_document_no', e.target.value)} />
        <DynamicFields fields={fields} values={v.cf} errors={errors} idPrefix="ev-cf" onChange={(cf) => set('cf', cf)} />
        <Input className="sm:col-span-2" label={t.needs_reason ? 'Reason / remarks' : 'Remarks'} required={t.needs_reason} id="ev-remarks" value={v.remarks} error={errors.remarks} onChange={(e) => set('remarks', e.target.value)} />
        {!isClaim && <label className="flex flex-col gap-1 text-[12px] text-slate-600 sm:col-span-2"><span className="font-medium">Attachment (bank advice / scrip ledger …)</span>
          <span className="flex gap-2"><input type="file" id="ev-file" accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv" className="text-[12px]" onChange={(e) => set('file', e.target.files?.[0] ?? null)} />
            <input className="input w-36" value={v.doc_type} onChange={(e) => set('doc_type', e.target.value.toUpperCase())} title="Document type" /></span></label>}
      </div>
      {(overBy > meta.settings.tolerance || overAvail || early || !claim.config.is_active) && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900" id="ev-warnings">
          {overBy > meta.settings.tolerance && <p>• {inr(overBy)} more than pending — an over-receipt is an exception (shown as excess, never hidden).</p>}
          {overAvail && <p>• More than the scrip available ({inr(claim.scrip_available)}) — this will be blocked.</p>}
          {early && <p>• The date is before the shipping bill date.</p>}
          {!claim.config.is_active && <p>• The scheme is inactive — posting on this historical claim is an authorised exception.</p>}
          {(overBy > meta.settings.tolerance || early || !claim.config.is_active) && meta.rights.approve && <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {overBy > meta.settings.tolerance && <Checkbox label="Over-receipt exception" checked={v.allow_excess} onChange={(c: boolean) => set('allow_excess', c)} />}
            {early && <Checkbox label="Early date exception" checked={v.allow_early_date} onChange={(c: boolean) => set('allow_early_date', c)} />}
            {!claim.config.is_active && <Checkbox label="Inactive scheme exception" checked={v.allow_inactive} onChange={(c: boolean) => set('allow_inactive', c)} />}
            <Input label="Exception reason" id="ev-exc-reason" value={v.exception_reason} onChange={(e) => set('exception_reason', e.target.value)} />
          </div>}
        </div>
      )}
      {warn.length > 0 && !dup && <p className="mt-2 text-[12px] text-red-700" id="ev-error">{warn.join(' · ')}</p>}
      {dup && <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-[12px] text-red-800" id="ev-dup">{dup}
        <div className="mt-1 flex gap-2"><Button size="sm" variant="danger" id="ev-dup-confirm" loading={busy} onClick={() => void save(true)}>Record anyway</Button><button className="btn-secondary btn-sm" onClick={() => setDup(null)}>Change UTR</button></div></div>}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {meta.rights.post && !isClaim && <Checkbox label="Post now (posted events can only be reversed)" checked={v.post} onChange={(c: boolean) => set('post', c)} />}
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <Button loading={busy} id="ev-save" disabled={!(amt > 0) || !v.event_date} onClick={() => void save()}>{v.post || isClaim ? 'Post' : 'Save draft'}</Button>
      </div>
    </div>
  );
}

function DocsTab({ claim, canEdit, onChanged }: { claim: any; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [docType, setDocType] = useState('OTHER');
  const required = (claim.config.required_documents ?? []) as { doc_type: string; label: string; stage: string; policy: string }[];
  const upload = async (f: File) => {
    setBusy(true);
    try { await http.post(`/export-benefits/claims/${claim.id}/documents`, { filename: f.name, data: await fileToDataUrl(f), doc_type: docType }); toast('Attached'); onChanged(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2" id="bc-docs">
      {required.length > 0 && <p className="text-[12px] text-slate-500">Required by the scheme: {required.map((r) => `${r.label} (${r.stage.toLowerCase()}, ${r.policy === 'BLOCK' ? 'must' : 'should'})`).join(' · ')}</p>}
      <table className="w-full"><thead><tr><th className="th">File</th><th className="th">Type</th><th className="th">For</th><th className="th">Uploaded</th><th className="th" /></tr></thead>
        <tbody>{!claim.all_documents.length && <tr><td colSpan={5} className="td py-4 text-center text-[12px] text-slate-400">No documents</td></tr>}
          {claim.all_documents.map((d: any) => <tr key={d.id}><td className="td text-[12px]"><button className="inline-flex items-center gap-1 text-brand-700 hover:underline" data-doc={d.id} onClick={() => void openDocument(d.id, d.original_name).catch((er) => toast(errMsg(er), 'error'))}><FileText size={13} />{d.original_name}</button></td>
            <td className="td text-[12px]">{d.doc_type}</td><td className="td text-[12px]">{d.event_id ? `event #${d.event_id}` : 'claim'}</td><td className="td text-[12px]">{fmtDateTime(d.uploaded_at)} · {d.uploaded_by_name ?? ''}</td>
            <td className="td">{canEdit && !d.event_id && <button className="text-slate-400 hover:text-red-600" title="Remove" onClick={() => void http.del(`/export-benefits/documents/${d.id}`).then(() => { toast('Removed'); onChanged(); }, (er) => toast(errMsg(er), 'error'))}><Trash2 size={14} /></button>}</td></tr>)}</tbody></table>
      {canEdit && <div className="flex items-end gap-2"><Input className="w-44" label="Document type" value={docType} onChange={(e) => setDocType(e.target.value.toUpperCase())} />
        <label className={clsx('btn-secondary btn-sm cursor-pointer', busy && 'opacity-60')}><Paperclip size={13} />{busy ? 'Uploading…' : 'Attach file'}
          <input type="file" className="hidden" id="bc-doc-file" accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label></div>}
    </div>
  );
}
