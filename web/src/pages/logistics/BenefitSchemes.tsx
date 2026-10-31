import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, History, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Button, Input, Select, Textarea, Modal, Badge, LoadingBlock, ErrorState, EmptyState, Checkbox, FormSection } from '../../components/ui';
import { http, ApiError } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { fmtDateTime } from '../../lib/format';
import { DynamicFields, errMsg, useBenefitMeta, type CustomField, type Meta } from './benefitShared';

/**
 * Export Benefit Scheme Master (spec v2 §4): authorised users add a new benefit (code, name, tracking mode, events,
 * documents, custom fields, settlement / ageing basis, order-profit policy) and activate it — it then shows on the
 * shipping bill, register, dashboard and reports without a code change. Code is fixed once used; schemes in use are
 * deactivated, never deleted; every change is versioned with its reason.
 */
const BLANK = { code: '', display_name: '', short_name: '', description: '', category: 'OTHER', tracking_mode: 'CASH', default_currency: 'INR', effective_from: '', effective_to: '',
  default_status: 'ENTERED', allowed_events: ['CLAIM_FILED', 'APPROVAL', 'BANK_RECEIPT', 'ADJUSTMENT', 'REVERSAL'], required_documents: [] as any[], custom_fields: [] as CustomField[],
  settlement_basis: 'DECLARED', ageing_basis: 'SB_DATE', profitability_policy: 'EXCLUDE', is_suggested: false, allow_multiple: false, sort_order: 100, is_active: false, reason: '' };

export function BenefitSchemesPage() {
  const meta = useBenefitMeta();
  const list = useQuery({ queryKey: ['export-benefits', 'schemes'], queryFn: async () => (await http.get<{ data: any[] }>('/export-benefits/schemes')).data });
  const [edit, setEdit] = useState<any | null>(null);
  const [hist, setHist] = useState<number | null>(null);
  const M = meta.data;
  if (meta.error || list.error) return <div className="card"><ErrorState error={meta.error ?? list.error} onRetry={() => { void meta.refetch(); void list.refetch(); }} /></div>;
  return (
    <div>
      <PageHeader title="Export Benefit Scheme Master" breadcrumb={['Export', 'Export Benefits']}
        subtitle="DBK, IGST, RoDTEP, RoSCTL and any new benefit — configured here, used everywhere without a code change"
        actions={<div className="flex gap-2"><Link to="/export/incentives" className="btn-secondary"><ArrowLeft size={14} />Benefits</Link>
          {M?.rights.admin && <Button id="sch-new" onClick={() => setEdit({ ...BLANK })}><Plus size={14} />Add new benefit</Button>}</div>} />
      {!M?.rights.admin && M && <div className="card mb-3 border-amber-200 bg-amber-50 px-3 py-2 text-body text-amber-900" id="sch-readonly">View only — changing schemes needs the “Export benefit scheme master” right.</div>}
      <div className="card overflow-x-auto">
        <table className="w-full" id="sch-list"><thead><tr><th className="th">Code</th><th className="th">Benefit</th><th className="th">Tracking</th><th className="th">Basis · ageing</th><th className="th">Order profit</th>
          <th className="th text-right">Claims</th><th className="th">Version</th><th className="th">Status</th><th className="th" /></tr></thead>
          <tbody>{list.isLoading && <tr><td colSpan={9}><LoadingBlock rows={4} /></td></tr>}
            {!list.isLoading && !list.data?.length && <tr><td colSpan={9}><EmptyState title="No schemes" /></td></tr>}
            {list.data?.map((s) => <tr key={s.id} className="row-hover align-top" data-scheme={s.code}>
              <td className="td tabular-nums text-small">{s.code}</td>
              <td className="td text-body"><button className="text-left font-semibold text-brand-700 hover:underline" onClick={() => setEdit({ ...s, effective_from: s.effective_from ?? '', effective_to: s.effective_to ?? '', short_name: s.short_name ?? '', description: s.description ?? '', is_suggested: !!s.is_suggested, allow_multiple: !!s.allow_multiple, is_active: !!s.is_active, reason: '' })}>{s.display_name}</button>
                {s.sb_field && <p className="text-caption text-ink-muted">shipping bill field</p>}</td>
              <td className="td text-small">{s.mode_label}<p className="text-caption text-ink-muted">{s.allowed_events.length} events · {s.custom_fields.length} fields</p></td>
              <td className="td text-small">{M?.settlement_bases.find((b) => b.value === s.settlement_basis)?.label}<p className="text-caption text-ink-muted">aged from {s.ageing_label}</p></td>
              <td className="td text-small">{s.policy_label}</td>
              <td className="td text-right tabular-nums">{s.claims}{s.open_claims ? <p className="text-caption text-amber-700">{s.open_claims} open</p> : null}</td>
              <td className="td text-small">v{s.config_version}<button className="ml-1 text-ink-muted hover:text-ink" title="Configuration history" onClick={() => setHist(s.id)}><History size={13} /></button></td>
              <td className="td">{s.is_active ? <Badge tone="green">active</Badge> : <Badge tone="slate">inactive</Badge>}{!s.is_active && s.readiness.length > 0 && <p className="text-caption text-red-600">{s.readiness.length} to complete</p>}</td>
              <td className="td">{M?.rights.admin && <SchemeToggle s={s} />}</td></tr>)}</tbody></table>
      </div>
      {edit && M && <SchemeEditor initial={edit} meta={M} onClose={() => setEdit(null)} />}
      {hist && <HistoryModal id={hist} onClose={() => setHist(null)} />}
    </div>
  );
}

function SchemeToggle({ s }: { s: any }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); try { await fn(); toast(msg); void qc.invalidateQueries({ queryKey: ['export-benefits'] }); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); } };
  if (s.is_active) return <Button size="sm" variant="secondary" loading={busy} data-deactivate={s.code} onClick={() => { const reason = window.prompt(`Deactivate ${s.display_name}? New claims are blocked; history stays. Reason:`); if (reason) void run(() => http.post(`/export-benefits/schemes/${s.id}/deactivate`, { reason }), 'Deactivated'); }}>Deactivate</Button>;
  return <div className="flex gap-1"><Button size="sm" loading={busy} data-activate={s.code} onClick={() => void run(() => http.post(`/export-benefits/schemes/${s.id}/activate`, {}), 'Activated — it now shows on shipping bills and reports')}>Activate</Button>
    {!s.is_used && <button className="text-ink-muted hover:text-red-600" title="Delete (never used)" onClick={() => { if (window.confirm(`Delete ${s.display_name}? It was never used.`)) void run(() => http.del(`/export-benefits/schemes/${s.id}`), 'Deleted'); }}><Trash2 size={14} /></button>}</div>;
}

function SchemeEditor({ initial, meta, onClose }: { initial: any; meta: Meta; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState<any>(initial);
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<any | null>(null);
  const [pvEvent, setPvEvent] = useState('');
  const [pvValues, setPvValues] = useState<Record<string, unknown>>({});
  const isNew = !initial.id;
  const used = !isNew && initial.claims > 0;
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const body = () => ({ ...v, effective_from: v.effective_from || null, effective_to: v.effective_to || null, short_name: v.short_name || null, description: v.description || null,
    custom_fields: v.custom_fields.map((f: any) => ({ ...f, options: f.type === 'select' ? (typeof f.options === 'string' ? f.options.split(',').map((o: string) => o.trim()).filter(Boolean) : f.options ?? []) : undefined,
      min: f.min === '' || f.min == null ? null : Number(f.min), max: f.max === '' || f.max == null ? null : Number(f.max), max_length: f.max_length ? Number(f.max_length) : null, pattern: f.pattern || null })),
    sort_order: Number(v.sort_order) || 100, reason: v.reason || null });
  // live check of the configuration (nothing saved)
  useEffect(() => {
    const t = setTimeout(() => { http.post<{ data: { errors: any[] } }>('/export-benefits/schemes/validate', body()).then((r) => setErrors(r.data.errors), () => {}); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  const errOf = (k: string) => errors.filter((e) => e.field === k || e.field.startsWith(`${k}.`)).map((e) => e.message).join(' · ') || undefined;
  const modeEvents = meta.event_types.filter((t) => t.modes.includes(v.tracking_mode));
  const save = async (confirm = false) => {
    setBusy(true);
    try {
      const b = { ...body(), confirm_mode_change: confirm || undefined };
      if (isNew) await http.post('/export-benefits/schemes', b); else await http.put(`/export-benefits/schemes/${initial.id}`, b);
      toast(isNew ? 'Scheme added' : 'Scheme saved (new version)'); void qc.invalidateQueries({ queryKey: ['export-benefits'] }); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRM_MODE_CHANGE') { setImpact({ message: e.message, ...(e.details as any) }); return; }
      if (e instanceof ApiError && Array.isArray(e.details)) setErrors(e.details as any);
      toast(errMsg(e), 'error');
    } finally { setBusy(false); }
  };
  const fields: any[] = v.custom_fields;
  const setField = (i: number, k: string, x: unknown) => set('custom_fields', fields.map((f, j) => (j === i ? { ...f, [k]: x } : f)));
  const docs: any[] = v.required_documents;
  const setDoc = (i: number, k: string, x: unknown) => set('required_documents', docs.map((d, j) => (j === i ? { ...d, [k]: x } : d)));
  const previewFields = (body().custom_fields as CustomField[]).filter((f) => f.key && f.label);
  return (
    <Modal open onClose={onClose} size="xl" title={isNew ? 'Add new benefit scheme' : `${initial.display_name} · v${initial.config_version}`}
      subtitle={used ? `In use on ${initial.claims} claims — the code is fixed; changes need a reason and apply to new claims (old claims keep their version)` : 'Inactive schemes can be saved incomplete; activation checks the configuration'}
      footerStart={errors.length > 0 && <span className="text-red-600" id="sch-errors">{errors.length} to fix before it can be active: {errors[0].message}</span>}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><Button id="sch-save" loading={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="grid gap-4 lg:grid-cols-3" id="sch-editor">
        <div className="lg:col-span-2">
          <FormSection title="Benefit" cols={4}>
            <Input label="Code" required id="sch-code" value={v.code} disabled={used} error={errOf('code')} hint={used ? 'Fixed after first use' : 'e.g. OTHER_001 — never reused'} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} />
            <Input className="sm:col-span-2" label="Display name" required id="sch-name" value={v.display_name} error={errOf('display_name')} onChange={(e) => set('display_name', e.target.value)} />
            <Input label="Short label" id="sch-short" value={v.short_name} maxLength={30} onChange={(e) => set('short_name', e.target.value)} />
            <Select label="Category" value={v.category} options={meta.categories} onChange={(e) => set('category', e.target.value)} />
            <Select label="Tracking mode" required id="sch-mode" value={v.tracking_mode} options={meta.tracking_modes} error={errOf('tracking_mode')}
              onChange={(e) => { const m = e.target.value; setV((o: any) => ({ ...o, tracking_mode: m, allowed_events: o.allowed_events.filter((x: string) => meta.event_types.find((t) => t.value === x)?.modes.includes(m)) })); }} />
            <Input label="Currency" value={v.default_currency} maxLength={3} onChange={(e) => set('default_currency', e.target.value.toUpperCase())} />
            <Select label="Initial stage" value={v.default_status} options={[{ value: 'ENTERED', label: 'Entered / pending' }, { value: 'FILED', label: 'Filed' }, { value: 'QUERY', label: 'Under query' }]} onChange={(e) => set('default_status', e.target.value)} />
            <Input label="Effective from" type="date" value={v.effective_from} onChange={(e) => set('effective_from', e.target.value)} />
            <Input label="Effective to" type="date" value={v.effective_to} error={errOf('effective_to')} onChange={(e) => set('effective_to', e.target.value)} />
            <Input label="Order" type="number" value={v.sort_order} onChange={(e) => set('sort_order', e.target.value)} />
            <div className="flex flex-col gap-1 pt-5"><Checkbox label="Suggest on shipping bill" checked={v.is_suggested} onChange={(c) => set('is_suggested', c)} /><Checkbox label="Allow more than one per SB" checked={v.allow_multiple} onChange={(c) => set('allow_multiple', c)} /></div>
            <Textarea className="sm:col-span-4" label="Description" rows={2} value={v.description} onChange={(e) => set('description', e.target.value)} />
          </FormSection>
          <FormSection title="Settlement, ageing and order profit" cols={3}>
            <Select label="Pending is worked out on" value={v.settlement_basis} options={meta.settlement_bases} onChange={(e) => set('settlement_basis', e.target.value)} hint="Finance-approved basis; falls back to the earlier amount until known" />
            <Select label="Ageing from" value={v.ageing_basis} options={meta.ageing_bases} onChange={(e) => set('ageing_basis', e.target.value)} />
            <Select label="Order profit" value={v.profitability_policy} options={meta.policies} onChange={(e) => set('profitability_policy', e.target.value)} />
          </FormSection>
          <FormSection title="Allowed events" description={`Only events possible for ${meta.tracking_modes.find((m) => m.value === v.tracking_mode)?.label} are listed`} cols={3}>
            {modeEvents.map((t) => <Checkbox key={t.value} label={t.label} checked={v.allowed_events.includes(t.value)}
              onChange={(c) => set('allowed_events', c ? [...v.allowed_events, t.value] : v.allowed_events.filter((x: string) => x !== t.value))} />)}
            {errOf('allowed_events') && <p className="text-small text-red-600 sm:col-span-3" id="sch-events-error">{errOf('allowed_events')}</p>}
          </FormSection>
          <FormSection title="Custom fields" description="Extra fields shown on the claim (shipping bill row) or on an event; validated by the server"
            actions={<Button size="sm" variant="secondary" id="sch-add-field" onClick={() => set('custom_fields', [...fields, { key: '', label: '', type: 'text', required: false, applies_to: 'EVENT', options: '', event_types: [] }])}><Plus size={13} />Field</Button>} cols={1}>
            {!fields.length && <p className="text-small text-ink-muted">No custom fields.</p>}
            {fields.map((f, i) => (
              <div key={i} className="grid gap-2 rounded-lg border border-surface-border p-2 sm:grid-cols-6" data-field-row={i}>
                <Input label="Key" value={f.key} error={errOf(`custom_fields.${i}`)} onChange={(e) => setField(i, 'key', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} />
                <Input label="Label" value={f.label} onChange={(e) => setField(i, 'label', e.target.value)} />
                <Select label="Type" value={f.type} options={meta.field_types.map((t) => ({ value: t, label: t }))} onChange={(e) => setField(i, 'type', e.target.value)} />
                <Select label="On" value={f.applies_to} options={[{ value: 'CLAIM', label: 'Claim (SB row)' }, { value: 'EVENT', label: 'Event' }]} onChange={(e) => setField(i, 'applies_to', e.target.value)} />
                {f.type === 'select' ? <Input label="Options (comma)" value={Array.isArray(f.options) ? f.options.join(', ') : f.options ?? ''} onChange={(e) => setField(i, 'options', e.target.value)} />
                  : f.type === 'number' ? <div className="grid grid-cols-2 gap-1"><Input label="Min" type="number" value={f.min ?? ''} onChange={(e) => setField(i, 'min', e.target.value)} /><Input label="Max" type="number" value={f.max ?? ''} onChange={(e) => setField(i, 'max', e.target.value)} /></div>
                    : f.type === 'text' ? <Input label="Pattern (regex)" value={f.pattern ?? ''} onChange={(e) => setField(i, 'pattern', e.target.value)} /> : <div />}
                <div className="flex items-end justify-between gap-2 pb-1.5"><Checkbox label="Required" checked={!!f.required} onChange={(c) => setField(i, 'required', c)} />
                  <button className="text-ink-muted hover:text-red-600" title="Remove" onClick={() => set('custom_fields', fields.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>
                {f.applies_to === 'EVENT' && <div className="flex flex-wrap gap-2 sm:col-span-6"><span className="text-caption text-ink-secondary">Only on:</span>{v.allowed_events.filter((x: string) => x !== 'REVERSAL').map((x: string) => (
                  <label key={x} className="flex items-center gap-1 text-caption"><input type="checkbox" checked={(f.event_types ?? []).includes(x)} onChange={(e) => setField(i, 'event_types', e.target.checked ? [...(f.event_types ?? []), x] : (f.event_types ?? []).filter((y: string) => y !== x))} />{meta.event_types.find((t) => t.value === x)?.label}</label>))}
                  <span className="text-caption text-ink-muted">(none ticked = every event)</span></div>}
              </div>
            ))}
          </FormSection>
          <FormSection title="Required documents" actions={<Button size="sm" variant="secondary" onClick={() => set('required_documents', [...docs, { doc_type: '', label: '', stage: 'RECEIPT', policy: 'WARN' }])}><Plus size={13} />Document</Button>} cols={1}>
            {!docs.length && <p className="text-small text-ink-muted">None required.</p>}
            {docs.map((d, i) => <div key={i} className="grid gap-2 sm:grid-cols-5">
              <Input label="Type code" value={d.doc_type} error={errOf(`required_documents.${i}`)} onChange={(e) => setDoc(i, 'doc_type', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} />
              <Input label="Label" value={d.label} onChange={(e) => setDoc(i, 'label', e.target.value)} />
              <Select label="When" value={d.stage} options={meta.doc_stages} onChange={(e) => setDoc(i, 'stage', e.target.value)} />
              <Select label="If missing" value={d.policy} options={[{ value: 'WARN', label: 'Warn' }, { value: 'BLOCK', label: 'Block posting' }]} onChange={(e) => setDoc(i, 'policy', e.target.value)} />
              <div className="flex items-end pb-2"><button className="text-ink-muted hover:text-red-600" onClick={() => set('required_documents', docs.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div></div>)}
          </FormSection>
          {!isNew && <FormSection title="Change" cols={2}>
            <Input className="sm:col-span-2" label="Reason for the change" required={used} id="sch-reason" value={v.reason} onChange={(e) => set('reason', e.target.value)} hint="Kept in the configuration history" />
          </FormSection>}
          {isNew && <div className="mt-2"><Checkbox label="Active now (else save as draft and activate later)" checked={v.is_active} onChange={(c) => set('is_active', c)} /></div>}
          {impact && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-body text-red-900" id="sch-impact">
            <p className="font-semibold">{impact.message}</p>
            <p>{impact.claims} claims ({impact.open_claims} open) and {impact.events} events use this scheme. {impact.note}</p>
            {impact.incompatible_events?.length > 0 && <p>Events not possible in the new mode (kept as history): {impact.incompatible_events.map((x: any) => `${x.label} × ${x.count}`).join(', ')}</p>}
            <div className="mt-2 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setImpact(null)}>Cancel</button><Button variant="danger" id="sch-confirm-mode" loading={busy} onClick={() => void save(true)}>Confirm the mode change</Button></div>
          </div>}
        </div>
        <div className="space-y-3" id="sch-preview">
          <div className="rounded-lg border border-dashed border-surface-input p-3">
            <p className="mb-2 text-small font-semibold uppercase tracking-wide text-ink-secondary">Preview — shipping bill row</p>
            <div className="grid gap-2"><Input label={`${v.display_name || 'New benefit'} — declared ₹`} type="number" disabled value="" placeholder="0.00" />
              <DynamicFields fields={previewFields.filter((f) => f.applies_to === 'CLAIM')} values={pvValues} onChange={setPvValues} idPrefix="pv-claim" /></div>
          </div>
          <div className="rounded-lg border border-dashed border-surface-input p-3">
            <p className="mb-2 text-small font-semibold uppercase tracking-wide text-ink-secondary">Preview — event form</p>
            <Select value={pvEvent} placeholder="— pick an event —" options={v.allowed_events.filter((x: string) => x !== 'REVERSAL').map((x: string) => ({ value: x, label: meta.event_types.find((t) => t.value === x)?.label ?? x }))} onChange={(e) => setPvEvent(e.target.value)} />
            {pvEvent && (() => { const t = meta.event_types.find((x) => x.value === pvEvent)!; return <div className="mt-2 grid gap-2">
              <Input label="Actual date" type="date" disabled value="" /><Input label="Amount" disabled value="" />
              {t.needs_bank && <Input label="Bank account · UTR" disabled value="" />}{t.needs_scrip && <Input label="Scrip number" disabled value="" />}
              <DynamicFields fields={previewFields.filter((f) => f.applies_to === 'EVENT' && (!f.event_types?.length || f.event_types.includes(pvEvent)))} values={pvValues} onChange={setPvValues} idPrefix="pv-ev" />
              {t.kind === 'SCRIP_IN' && <p className="text-caption text-indigo-700">Shows as scrip available — not cash.</p>}</div>; })()}
          </div>
          <div className={clsx('rounded-lg p-3 text-small', errors.length ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800')} id="sch-readiness">
            {errors.length ? <><p className="font-semibold">Before activation:</p>{errors.map((e, i) => <p key={i}>• {e.message}</p>)}</> : <p>The configuration is complete — it can be active.</p>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function HistoryModal({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['export-benefits', 'scheme', id], queryFn: async () => (await http.get<{ data: any }>(`/export-benefits/schemes/${id}`)).data });
  const diff = (a: any, b: any) => (a ? Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])) : []);
  return (
    <Modal open onClose={onClose} size="lg" title={q.data ? `${q.data.display_name} — configuration history` : 'History'} footer={<button className="btn-secondary" onClick={onClose}>Close</button>}>
      {q.isLoading ? <LoadingBlock rows={3} /> : q.error ? <ErrorState error={q.error} /> : (
        <table className="w-full" id="sch-history"><thead><tr><th className="th">Version</th><th className="th">Change</th><th className="th">What changed (old → new)</th><th className="th">Reason</th><th className="th">By · when</th></tr></thead>
          <tbody>{q.data.history.map((h: any) => <tr key={h.id} className="align-top"><td className="td">v{h.config_version}</td><td className="td text-small">{h.change_type.toLowerCase().replace('_', ' ')}</td>
            <td className="td max-w-[360px] tabular-nums text-caption text-ink-secondary">{diff(h.old_snapshot, h.snapshot).map((k) => <p key={k}>{k}: {JSON.stringify(h.old_snapshot[k]).slice(0, 60)} → {JSON.stringify(h.snapshot[k]).slice(0, 60)}</p>)}</td>
            <td className="td text-small">{h.reason ?? ''}</td><td className="td text-small">{h.changed_by_name ?? 'system'}<p className="text-ink-muted">{fmtDateTime(h.changed_at)}</p></td></tr>)}</tbody></table>
      )}
    </Modal>
  );
}
