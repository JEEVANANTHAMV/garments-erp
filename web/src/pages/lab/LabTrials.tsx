import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { PageHeader, Card, Button, Input, Select, Textarea, Tabs, Badge, Modal, LoadingBlock, ErrorState, SearchInput, useDebounced, FormSection } from '../../components/ui';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { fmtDateTime } from '../../lib/format';
import {
  LabStatus, ResultBadge, ReasonModal, AttachmentList, FilePick, KV, errMsg, label, opts, num, criteriaText, uploadLabFile, useLabOptions, useLabUsers, newKey,
  TRIAL_TYPES, DOSAGE_UOMS, DRYING, ATTACHMENT_TYPES,
} from './labShared';

/** Trials (spec §4.3–§4.7): register, new trial, and the trial workspace (sample, recipe, chemicals, measurements,
 *  results, photos, deviations). Results are always calculated and evaluated by the server. */

const TRIAL_STATUSES = ['DRAFT', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'SUBMITTED', 'LAB_REVIEWED', 'APPROVED', 'REJECTED', 'RETEST_REQUIRED', 'CANCELLED'];

export function LabTrialsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const f = { status: sp.get('status') ?? '', result: sp.get('result') ?? '', mine: sp.get('mine') ?? '' };
  const setF = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const list = useQuery({ queryKey: ['lab-trials', f, dq], queryFn: async () => (await http.get<{ data: any[] }>('/lab/trials', { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), q: dq || undefined })).data });
  return (
    <div>
      <PageHeader title="Lab trials" breadcrumb={['Lab']} subtitle="Wash / treatment / test trials — every retest and recipe revision is a new linked trial"
        actions={can('LAB.UPDATE') && <Button id="lab-trial-new" onClick={() => nav('/lab/trials/create')}><Plus size={15} />New trial</Button>} />
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <SearchInput className="w-64" value={q} onChange={setQ} placeholder="Trial, request, style, sample…" />
        <Select label="Status" className="w-48" placeholder="All" options={opts(TRIAL_STATUSES)} value={f.status} onChange={(e) => setF('status', e.target.value)} />
        <Select label="Result" className="w-32" placeholder="Any" options={opts(['PASS', 'FAIL'])} value={f.result} onChange={(e) => setF('result', e.target.value)} />
        <Select label="Technician" className="w-40" options={[{ value: '', label: 'Everyone' }, { value: '1', label: 'My trials' }]} value={f.mine} onChange={(e) => setF('mine', e.target.value)} />
      </div>
      <div className="card overflow-x-auto">
        {list.isLoading ? <LoadingBlock /> : list.error ? <ErrorState error={list.error} /> : (
          <table className="w-full" id="lab-trial-list">
            <thead><tr><th className="th">Trial</th><th className="th">Request</th><th className="th">Buyer / style</th><th className="th">Type</th><th className="th text-right">Recipe rev</th><th className="th">Technician</th>
              <th className="th">Machine</th><th className="th">Planned</th><th className="th">Result</th><th className="th">Status</th></tr></thead>
            <tbody>
              {(list.data ?? []).length === 0 && <tr><td colSpan={10} className="td text-center text-ink-muted">No trials</td></tr>}
              {(list.data ?? []).map((t) => (
                <tr key={t.id} className="row-hover">
                  <td className="td"><Link className="font-semibold text-brand-700 hover:underline" to={`/lab/trials/${t.id}`}>{t.trial_no}</Link></td>
                  <td className="td"><Link className="hover:underline" to={`/lab/requests/${t.request_id}`}>{t.request_no}</Link></td>
                  <td className="td text-small">{t.buyer_name ?? '—'} · {t.style_code ?? '—'}{t.color_name ? ` · ${t.color_name}` : ''}</td>
                  <td className="td">{label(t.trial_type)}{t.parent_trial_no ? <span className="text-caption text-ink-secondary"> ← {t.parent_trial_no}</span> : null}</td>
                  <td className="td text-right">{t.recipe_revision}</td><td className="td">{t.technician_name}</td><td className="td">{t.machine_code ?? '—'}</td>
                  <td className="td">{fmtDateTime(t.planned_at)}</td><td className="td"><ResultBadge value={t.overall_result} /></td><td className="td"><LabStatus value={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ================================================================ create */
export function LabTrialCreatePage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const o = useLabOptions(); const techs = useLabUsers();
  const [requestId, setRequestId] = useState(sp.get('request') ?? '');
  const open = useQuery({ queryKey: ['lab-requests-for-trial'], queryFn: async () => (await http.get<{ data: any[] }>('/lab/requests',
    { status: 'SAMPLE_RECEIVED,IN_TESTING,PENDING_LAB_REVIEW,PENDING_QA_APPROVAL,RETEST_REQUIRED,REJECTED,APPROVED', pageSize: 500 })).data });
  const req = useQuery({ queryKey: ['lab-request', Number(requestId)], enabled: !!requestId, queryFn: async () => (await http.get<{ data: any }>(`/lab/requests/${requestId}`)).data });
  const [v, setV] = useState<Record<string, any>>({ sample_id: '', issue_qty: '', trial_type: 'INITIAL', parent_trial_id: '', technician_id: '', machine_id: '', planned_at: '', wash_process_code: '', reason: '', remarks: '' });
  const [key] = useState(newKey());
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const set = (k: string, x: unknown) => setV((p) => ({ ...p, [k]: x }));
  useEffect(() => { const s = req.data?.samples ?? []; if (s.length === 1 && !v.sample_id) set('sample_id', String(s[0].id)); }, [req.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const sample = req.data?.samples.find((s: any) => String(s.id) === v.sample_id);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const res = await http.post<{ data: any }>('/lab/trials', {
        request_id: requestId, sample_id: v.sample_id || null, issue_qty: v.issue_qty || 0, trial_type: v.trial_type, parent_trial_id: v.parent_trial_id || null,
        technician_id: v.technician_id, machine_id: v.machine_id || null, planned_at: v.planned_at || null, wash_process_code: v.wash_process_code || null,
        reason: v.reason || null, remarks: v.remarks || null, idempotency_key: v.issue_qty ? key : null,
      });
      toast(`${res.data.trial_no} created`); nav(`/lab/trials/${res.data.id}`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const reqOpts = (open.data ?? []).map((r) => ({ value: r.id, label: `${r.request_no} · ${r.buyer_name ?? '—'} · ${r.style_code ?? r.development_ref ?? '—'} (${label(r.status)})` }));
  return (
    <div>
      <PageHeader title="New trial" breadcrumb={['Lab', 'Trials']} subtitle="Pick the sample and issue the quantity the trial uses (checked against the sample balance)"
        actions={<><Button variant="secondary" onClick={() => nav(-1)}>Back</Button><Button id="lab-trial-create-save" loading={busy} onClick={() => void save()}>Create trial</Button></>} />
      {err && <div id="lab-trial-create-error" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-small text-red-700">{err}</div>}
      <div className="card p-4">
        <FormSection title="Request & sample">
          <Select id="lab-trial-request" label="Lab request" required className="sm:col-span-2" placeholder="— Select request —" options={reqOpts} value={requestId} onChange={(e) => { setRequestId(e.target.value); set('sample_id', ''); }} />
          <Select id="lab-trial-sample" label="Sample" placeholder="—" value={v.sample_id} onChange={(e) => set('sample_id', e.target.value)}
            options={(req.data?.samples ?? []).map((s: any) => ({ value: s.id, label: `${s.sample_no} · ${num(s.balance.available, 3)} ${s.uom} available` }))} />
          <Input id="lab-trial-issue" label={`Issue quantity${sample ? ` (${sample.uom}, max ${num(sample.balance.available, 3)})` : ''}`} type="number" min="0" step="any" value={v.issue_qty} onChange={(e) => set('issue_qty', e.target.value)} />
        </FormSection>
        <FormSection title="Trial">
          <Select label="Trial type" options={opts(TRIAL_TYPES)} value={v.trial_type} onChange={(e) => set('trial_type', e.target.value)} />
          <Select label="Follows trial" placeholder="—" value={v.parent_trial_id} onChange={(e) => set('parent_trial_id', e.target.value)}
            options={(req.data?.trials ?? []).map((t: any) => ({ value: t.id, label: `${t.trial_no} · ${label(t.trial_type)} · ${label(t.status)}` }))} />
          <Select id="lab-trial-tech" label="Technician" required placeholder="—" options={(techs.data ?? []).map((u) => ({ value: u.id, label: u.label }))} value={v.technician_id} onChange={(e) => set('technician_id', e.target.value)} />
          <Select label="Machine" placeholder="—" options={(o.data?.machines ?? []).map((m: any) => ({ value: m.id, label: `${m.machine_code} — ${m.name}${m.status !== 'AVAILABLE' ? ` (${label(m.status)})` : ''}` }))} value={v.machine_id} onChange={(e) => set('machine_id', e.target.value)} />
          <Input label="Planned" type="datetime-local" value={v.planned_at} onChange={(e) => set('planned_at', e.target.value)} />
          <Select label="Wash process" placeholder="—" options={(o.data?.wash_processes ?? []).map((w: any) => ({ value: w.code, label: w.name }))} value={v.wash_process_code} onChange={(e) => set('wash_process_code', e.target.value)} />
          <Input label={v.trial_type === 'INITIAL' ? 'Purpose (optional)' : 'Purpose of variation / reason for retest'} required={v.trial_type !== 'INITIAL'} className="sm:col-span-2" value={v.reason} onChange={(e) => set('reason', e.target.value)} />
          <Textarea label="Remarks" className="sm:col-span-2 lg:col-span-4" value={v.remarks} onChange={(e) => set('remarks', e.target.value)} />
        </FormSection>
      </div>
    </div>
  );
}

/* ================================================================ workspace */
const s2 = (v: unknown) => (v === null || v === undefined ? '' : String(Number(v)) === 'NaN' ? String(v) : String(Number(v)));
const nv = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));

export function LabTrialWorkspacePage() {
  const id = Number(useParams().id);
  const loc = useLocation();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['lab-trial', id], queryFn: async () => (await http.get<{ data: any }>(`/lab/trials/${id}`)).data });
  const initialTab = loc.pathname.endsWith('/recipe') ? 'recipe' : loc.pathname.endsWith('/testing') ? 'measurements' : 'sample';
  const [tab, setTab] = useState(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  const [modal, setModal] = useState<'' | 'cancel' | 'submit'>('');
  const [busy, setBusy] = useState('');
  const t = q.data;
  const refresh = (d?: any) => { if (d) qc.setQueryData(['lab-trial', id], d); else void qc.invalidateQueries({ queryKey: ['lab-trial', id] }); void qc.invalidateQueries({ queryKey: ['lab-trials'] }); };
  if (q.isLoading) return <div className="card"><LoadingBlock /></div>;
  if (q.error || !t) return <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const tech = can('LAB.UPDATE');
  const act = async (path: string, body?: unknown, msg?: string) => {
    setBusy(path);
    try { const r = await http.post<{ data: any }>(`/lab/trials/${id}/${path}`, body); refresh(r.data); if (msg) toast(msg); }
    catch (e) { toast(errMsg(e), 'error'); throw e; } finally { setBusy(''); }
  };
  const latestReport = t.reports[t.reports.length - 1];
  return (
    <div>
      <PageHeader title={<span className="flex flex-wrap items-center gap-2">{t.trial_no} <LabStatus value={t.status} /><ResultBadge value={t.overall_result} /></span>}
        breadcrumb={['Lab', 'Trials']}
        subtitle={<>Request <Link className="text-brand-700 hover:underline" to={`/lab/requests/${t.request_id}`}>{t.request_no}</Link> · {t.buyer_name ?? '—'} · {t.style_code ?? '—'}{t.color_name ? ` · ${t.color_name}` : ''} · {label(t.trial_type)} · recipe rev {t.recipe_revision}{t.plan ? ` · plan ${t.plan.plan_code} v${t.plan.version_no}` : ''}</>}
        actions={<>
          {latestReport && <Button variant="secondary" onClick={() => nav(`/lab/reports/${latestReport.id}`)}>Report {latestReport.report_no} rev {latestReport.revision_no}</Button>}
          {tech && ['DRAFT', 'PLANNED'].includes(t.status) && <Button id="lab-trial-start" loading={busy === 'start'} onClick={() => void act('start', undefined, 'Trial started').catch(() => {})}>Start</Button>}
          {tech && t.status === 'IN_PROGRESS' && <Button id="lab-trial-complete" loading={busy === 'complete'} onClick={() => void act('complete', undefined, 'Trial completed').catch(() => {})}>Complete process</Button>}
          {tech && t.status === 'COMPLETED' && <Button id="lab-trial-submit" onClick={() => setModal('submit')}>Submit to Lab In-charge</Button>}
          {tech && t.editable && <Button variant="danger" onClick={() => setModal('cancel')}>Cancel trial</Button>}
        </>} />
      {t.reason && <p className="mb-3 text-small text-ink-secondary">Purpose / reason: {t.reason}</p>}
      {!t.editable && <div className="mb-3 rounded-lg border border-surface-border bg-surface-muted px-4 py-2 text-small text-ink-secondary">Submitted data is frozen. Corrections come back through a return, a retest or a report revision.</div>}
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'sample', label: 'Sample' }, { key: 'recipe', label: 'Recipe stages', count: t.stages.length }, { key: 'chemicals', label: 'Chemicals', count: t.chemicals.length },
        { key: 'measurements', label: 'Measurements', count: t.params.length }, { key: 'results', label: 'Results' }, { key: 'photos', label: 'Photos & files', count: t.attachments.length },
        { key: 'deviations', label: 'Deviations', count: t.deviations.length }]} />
      {tab === 'sample' && <SampleTab t={t} />}
      {(tab === 'recipe' || tab === 'chemicals') && <RecipeTab key={`${t.row_version}-${tab}`} t={t} part={tab} canEdit={tech && t.editable} onSaved={(d) => { refresh(d); toast('Recipe saved'); }} />}
      {tab === 'measurements' && <MeasurementGrid key={t.row_version} t={t} canEdit={tech && t.results_editable} onSaved={(d) => { refresh(d); toast('Readings saved — results recalculated'); }} />}
      {tab === 'results' && <ResultsTab t={t} canEdit={tech && t.results_editable} canOverride={can('LAB.OVERRIDE') && t.results_editable} onSaved={(d) => refresh(d)} />}
      {tab === 'photos' && <PhotosTab t={t} canEdit={tech && t.editable} onChanged={() => refresh()} />}
      {tab === 'deviations' && <DeviationsTab t={t} canEdit={tech && t.editable} onSaved={(d) => refresh(d)} />}
      <ReasonModal open={modal === 'cancel'} title={`Cancel ${t.trial_no}`} danger confirm="Cancel trial" onClose={() => setModal('')} onSubmit={(reason) => act('cancel', { reason }, 'Trial cancelled')} />
      {modal === 'submit' && <SubmitModal t={t} onClose={() => setModal('')} onDone={(d) => { refresh(d); toast(`Submitted — ${d.submitted_report?.report_no} rev ${d.submitted_report?.revision_no}`); }} />}
    </div>
  );
}

function SampleTab({ t }: { t: any }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Trial" className="lg:col-span-2">
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
          <KV k="Technician" v={t.technician_name} /><KV k="Machine" v={t.machine_code ? `${t.machine_code} — ${t.machine_name}` : null} /><KV k="Wash process" v={t.wash_process_name ?? t.wash_process_code} />
          <KV k="Planned" v={fmtDateTime(t.planned_at)} /><KV k="Started" v={fmtDateTime(t.started_at)} /><KV k="Completed" v={fmtDateTime(t.completed_at)} />
          <KV k="Follows" v={t.parent_trial_no ? <Link className="text-brand-700 hover:underline" to={`/lab/trials/${t.parent_trial_id}`}>{t.parent_trial_no}</Link> : null} />
          <KV k="Followed by" v={t.children.length ? t.children.map((c: any) => <Link key={c.id} className="mr-2 text-brand-700 hover:underline" to={`/lab/trials/${c.id}`}>{c.trial_no}</Link>) : null} />
          <KV k="Remarks" v={t.remarks} />
        </div>
      </Card>
      <Card title="Sample issued">
        <div className="space-y-2 p-4">
          <KV k="Sample" v={t.sample_id ? <Link className="text-brand-700 hover:underline" to={`/lab/samples/${t.sample_id}`}>{t.sample_no}</Link> : null} />
          <KV k="Outstanding with this trial" v={num(t.sample_outstanding, 3)} />
          <ul className="text-small">{t.ledger.map((l: any) => <li key={l.id}>{fmtDateTime(l.txn_at)} · {label(l.txn_type)} {num(l.quantity, 3)} {l.uom} ({l.sample_no})</li>)}</ul>
          {t.ledger.length === 0 && <p className="text-small text-amber-700">No sample issued yet — issue it from the sample page before starting.</p>}
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- recipe + chemicals (one save: PUT replaces both) */
function RecipeTab({ t, part, canEdit, onSaved }: { t: any; part: 'recipe' | 'chemicals'; canEdit: boolean; onSaved: (d: any) => void }) {
  const o = useLabOptions();
  const frozen = !!t.target_frozen;
  const [h, setH] = useState<Record<string, string>>({
    wash_process_code: t.wash_process_code ?? '', machine_id: t.machine_id ? String(t.machine_id) : '', batch_ref: t.batch_ref ?? '', load_weight_kg: s2(t.load_weight_kg), water_qty_l: s2(t.water_qty_l),
    drying_method: t.drying_method ?? '', drying_temp: s2(t.drying_temp), drying_duration_min: s2(t.drying_duration_min), finish_notes: t.finish_notes ?? '', operator_name: t.operator_name ?? '',
  });
  const [stages, setStages] = useState<any[]>(t.stages.map((x: any) => ({ ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v == null ? '' : typeof v === 'number' ? String(v) : String(v)])) })));
  const [chem, setChem] = useState<any[]>(t.chemicals.map((x: any) => ({ ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v == null ? '' : String(v)])) })));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const dis = !canEdit;
  const tdis = !canEdit || frozen;
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await http.put<{ data: any }>(`/lab/trials/${t.id}`, {
        row_version: t.row_version, wash_process_code: h.wash_process_code || null, machine_id: h.machine_id ? Number(h.machine_id) : null, batch_ref: h.batch_ref || null,
        load_weight_kg: nv(h.load_weight_kg), water_qty_l: nv(h.water_qty_l), drying_method: h.drying_method || null, drying_temp: nv(h.drying_temp), drying_duration_min: nv(h.drying_duration_min),
        finish_notes: h.finish_notes || null, operator_name: h.operator_name || null,
        stages: stages.map((x) => ({ stage_no: Number(x.stage_no), process_code: x.process_code, target_temp: nv(x.target_temp), actual_temp: nv(x.actual_temp), target_duration_min: nv(x.target_duration_min),
          actual_duration_min: nv(x.actual_duration_min), water_qty_l: nv(x.water_qty_l), ph_start: nv(x.ph_start), ph_end: nv(x.ph_end), water_hardness: nv(x.water_hardness), rpm: nv(x.rpm),
          rinse_count: nv(x.rinse_count), notes: x.notes || null })),
        chemicals: chem.map((c) => ({ stage_no: nv(c.stage_no), trim_id: c.trim_id ? Number(c.trim_id) : null, chemical_name: c.chemical_name, chemical_lot: c.chemical_lot || null,
          target_dosage: nv(c.target_dosage), actual_dosage: nv(c.actual_dosage), dosage_uom: c.dosage_uom || 'G_L', added_at: c.added_at || null, remarks: c.remarks || null })),
      });
      onSaved(r.data);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const upS = (i: number, k: string, v: string) => setStages((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const upC = (i: number, k: string, v: string) => setChem((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const cell = (val: string, on: (v: string) => void, disabled: boolean, w = 'w-20', type = 'number') =>
    <input className={`input ${w} ${type === 'number' ? 'text-right' : ''}`} type={type} step="any" value={val} disabled={disabled} onChange={(e) => on(e.target.value)} />;
  const lr = nv(h.load_weight_kg) && nv(h.water_qty_l) != null ? (Number(h.water_qty_l) / Number(h.load_weight_kg)) : null;
  return (
    <div className="space-y-4">
      {frozen && canEdit && <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-small text-amber-800">The target recipe is frozen (trial started) — record the actual values; a change of target needs a Recipe Revision trial.</p>}
      {err && <p id="lab-recipe-error" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-small text-red-700">{err}</p>}
      {part === 'recipe' && (
        <>
          <div className="card p-4">
            <FormSection title="Process, load & drying">
              <Select label="Wash process" placeholder="—" disabled={tdis} options={(o.data?.wash_processes ?? []).map((w: any) => ({ value: w.code, label: w.name }))} value={h.wash_process_code} onChange={(e) => setH({ ...h, wash_process_code: e.target.value })} />
              <Select label="Machine" placeholder="—" disabled={tdis} options={(o.data?.machines ?? []).map((m: any) => ({ value: m.id, label: `${m.machine_code} — ${m.name}` }))} value={h.machine_id} onChange={(e) => setH({ ...h, machine_id: e.target.value })} />
              <Input label="Batch / load ref" disabled={dis} value={h.batch_ref} onChange={(e) => setH({ ...h, batch_ref: e.target.value })} />
              <Input label="Load weight (kg)" type="number" step="any" disabled={tdis} value={h.load_weight_kg} onChange={(e) => setH({ ...h, load_weight_kg: e.target.value })} />
              <Input label="Water (L)" type="number" step="any" disabled={tdis} value={h.water_qty_l} onChange={(e) => setH({ ...h, water_qty_l: e.target.value })} />
              <Input label="Liquor ratio (calculated on save)" disabled value={t.liquor_ratio != null ? `1 : ${num(t.liquor_ratio, 2)}` : lr ? `≈ 1 : ${num(lr, 2)} (unsaved)` : ''} />
              <Select label="Drying" placeholder="—" disabled={dis} options={opts(DRYING)} value={h.drying_method} onChange={(e) => setH({ ...h, drying_method: e.target.value })} />
              <Input label="Drying temp (°C)" type="number" step="any" disabled={dis} value={h.drying_temp} onChange={(e) => setH({ ...h, drying_temp: e.target.value })} />
              <Input label="Drying time (min)" type="number" step="any" disabled={dis} value={h.drying_duration_min} onChange={(e) => setH({ ...h, drying_duration_min: e.target.value })} />
              <Input label="Finish / softener / pressing" disabled={dis} value={h.finish_notes} onChange={(e) => setH({ ...h, finish_notes: e.target.value })} />
              <Input label="Operator" disabled={dis} value={h.operator_name} onChange={(e) => setH({ ...h, operator_name: e.target.value })} />
              <KV k="Total time (target / actual)" v={`${num(t.total_target_min)} / ${num(t.total_actual_min)} min`} />
            </FormSection>
          </div>
          <Card title="Stages" subtitle="e.g. pre-wet → enzyme → rinse → softener → extraction → drying">
            <div className="overflow-x-auto"><table className="w-full min-w-[1100px]" id="lab-recipe-stages">
              <thead><tr><th className="th">#</th><th className="th">Process</th><th className="th text-right">Temp T °C</th><th className="th text-right">Temp A °C</th><th className="th text-right">Time T min</th>
                <th className="th text-right">Time A min</th><th className="th text-right">Water L</th><th className="th text-right">pH start</th><th className="th text-right">pH end</th><th className="th text-right">RPM</th><th className="th text-right">Rinses</th><th className="th">Notes</th><th className="th" /></tr></thead>
              <tbody>{stages.map((x, i) => (
                <tr key={i}>
                  <td className="td">{cell(x.stage_no, (v) => upS(i, 'stage_no', v), tdis, 'w-14')}</td>
                  <td className="td">{cell(x.process_code, (v) => upS(i, 'process_code', v), tdis, 'w-32', 'text')}</td>
                  <td className="td">{cell(x.target_temp, (v) => upS(i, 'target_temp', v), tdis)}</td>
                  <td className="td">{cell(x.actual_temp, (v) => upS(i, 'actual_temp', v), dis)}</td>
                  <td className="td">{cell(x.target_duration_min, (v) => upS(i, 'target_duration_min', v), tdis)}</td>
                  <td className="td">{cell(x.actual_duration_min, (v) => upS(i, 'actual_duration_min', v), dis)}</td>
                  <td className="td">{cell(x.water_qty_l, (v) => upS(i, 'water_qty_l', v), tdis)}</td>
                  <td className="td">{cell(x.ph_start, (v) => upS(i, 'ph_start', v), tdis, 'w-16')}</td>
                  <td className="td">{cell(x.ph_end, (v) => upS(i, 'ph_end', v), dis, 'w-16')}</td>
                  <td className="td">{cell(x.rpm, (v) => upS(i, 'rpm', v), tdis, 'w-16')}</td>
                  <td className="td">{cell(x.rinse_count, (v) => upS(i, 'rinse_count', v), tdis, 'w-14')}</td>
                  <td className="td">{cell(x.notes, (v) => upS(i, 'notes', v), dis, 'w-40', 'text')}</td>
                  <td className="td">{!tdis && <button type="button" aria-label="Remove stage" className="text-ink-muted hover:text-red-600" onClick={() => setStages((xs) => xs.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {!tdis && <div className="p-3"><Button id="lab-recipe-add-stage" variant="secondary" onClick={() => setStages((xs) => [...xs, { stage_no: String(xs.length + 1), process_code: '', target_temp: '', actual_temp: '', target_duration_min: '', actual_duration_min: '', water_qty_l: '', ph_start: '', ph_end: '', water_hardness: '', rpm: '', rinse_count: '', notes: '' }])}><Plus size={14} />Add stage</Button></div>}
          </Card>
        </>
      )}
      {part === 'chemicals' && (
        <Card title="Chemicals & dosage" subtitle="Reference only — the lab does not issue stock">
          <div className="overflow-x-auto"><table className="w-full min-w-[1000px]" id="lab-recipe-chemicals">
            <thead><tr><th className="th">Stage</th><th className="th">ERP item</th><th className="th">Chemical</th><th className="th">Lot</th><th className="th text-right">Target dosage</th><th className="th text-right">Actual dosage</th><th className="th">Unit</th><th className="th">Added at</th><th className="th" /></tr></thead>
            <tbody>{chem.map((c, i) => (
              <tr key={i}>
                <td className="td"><select className="input w-20" disabled={tdis} value={c.stage_no} onChange={(e) => upC(i, 'stage_no', e.target.value)}><option value="">—</option>{stages.map((x) => <option key={x.stage_no} value={x.stage_no}>{x.stage_no}</option>)}</select></td>
                <td className="td"><select className="input w-44" disabled={tdis} value={c.trim_id} onChange={(e) => { const it = (o.data?.chemicals ?? []).find((y: any) => String(y.id) === e.target.value); upC(i, 'trim_id', e.target.value); if (it && !c.chemical_name) upC(i, 'chemical_name', it.label); }}>
                  <option value="">—</option>{(o.data?.chemicals ?? []).map((y: any) => <option key={y.id} value={y.id}>{y.code} — {y.label}</option>)}</select></td>
                <td className="td">{cell(c.chemical_name, (v) => upC(i, 'chemical_name', v), tdis, 'w-44', 'text')}</td>
                <td className="td">{cell(c.chemical_lot, (v) => upC(i, 'chemical_lot', v), dis, 'w-28', 'text')}</td>
                <td className="td">{cell(c.target_dosage, (v) => upC(i, 'target_dosage', v), tdis, 'w-24')}</td>
                <td className="td">{cell(c.actual_dosage, (v) => upC(i, 'actual_dosage', v), dis, 'w-24')}</td>
                <td className="td"><select className="input w-24" disabled={tdis} value={c.dosage_uom || 'G_L'} onChange={(e) => upC(i, 'dosage_uom', e.target.value)}>{DOSAGE_UOMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                <td className="td">{cell(c.added_at, (v) => upC(i, 'added_at', v), dis, 'w-28', 'text')}</td>
                <td className="td">{!tdis && <button type="button" aria-label="Remove chemical" className="text-ink-muted hover:text-red-600" onClick={() => setChem((xs) => xs.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          {!tdis && <div className="p-3"><Button variant="secondary" onClick={() => setChem((xs) => [...xs, { stage_no: '', trim_id: '', chemical_name: '', chemical_lot: '', target_dosage: '', actual_dosage: '', dosage_uom: 'G_L', added_at: '', remarks: '' }])}><Plus size={14} />Add chemical</Button></div>}
        </Card>
      )}
      {canEdit && <div className="flex justify-end"><Button id="lab-recipe-save" loading={busy} onClick={() => void save()}>Save recipe</Button></div>}
    </div>
  );
}

/* ---------------------------------------------------------------- measurement grid */
type Cell = { stage: 'BEFORE' | 'AFTER' | 'SINGLE'; no: number };
function cellsOf(p: any): Cell[] {
  const n = Math.max(1, Number(p.repeat_count ?? 1));
  const existingMax = Math.max(0, ...(p.readings ?? []).map((r: any) => Number(r.reading_no)));
  const count = ['PASS_FAIL', 'DROPDOWN', 'TEXT', 'PHOTO'].includes(p.input_type) ? 1 : Math.max(n, existingMax);
  const out: Cell[] = [];
  for (let i = 1; i <= count; i++) {
    if (p.input_type === 'BEFORE_AFTER') { out.push({ stage: 'BEFORE', no: i }, { stage: 'AFTER', no: i }); } else out.push({ stage: 'SINGLE', no: i });
  }
  return out;
}
const ck = (pid: number, c: Cell) => `${pid}:${c.stage}:${c.no}`;

export function MeasurementGrid({ t, canEdit, onSaved }: { t: any; canEdit: boolean; onSaved: (d: any) => void }) {
  const init = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of t.params) for (const r of p.readings) m[`${p.parameter_id}:${r.reading_stage}:${r.reading_no}`] = r.text_value ?? (r.numeric_value == null ? '' : String(Number(r.numeric_value)));
    return m;
  }, [t]);
  const [vals, setVals] = useState<Record<string, string>>(init);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const dirty = Object.keys({ ...init, ...vals }).some((k) => (init[k] ?? '') !== (vals[k] ?? ''));
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const measurements: any[] = [];
      for (const p of t.params) {
        const isText = ['GRADE', 'PASS_FAIL', 'DROPDOWN', 'TEXT', 'PHOTO'].includes(p.input_type);
        for (const c of cellsOf(p)) {
          const k = ck(p.parameter_id, c);
          if ((init[k] ?? '') === (vals[k] ?? '')) continue;
          const v = (vals[k] ?? '').trim();
          measurements.push({ parameter_id: p.parameter_id, reading_stage: c.stage, reading_no: c.no, numeric_value: isText || v === '' ? null : Number(v), text_value: isText && v !== '' ? v : null });
        }
      }
      if (!measurements.length) return;
      const r = await http.post<{ data: any }>(`/lab/trials/${t.id}/measurements`, { row_version: t.row_version, measurements });
      onSaved(r.data);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const input = (p: any, c: Cell) => {
    const k = ck(p.parameter_id, c);
    const v = vals[k] ?? '';
    const on = (x: string) => setVals((o) => ({ ...o, [k]: x }));
    const choices = String(p.allowed_values ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const name = `m-${p.code}-${c.stage}-${c.no}`;
    if (p.input_type === 'GRADE' || p.input_type === 'DROPDOWN' || p.input_type === 'PASS_FAIL') {
      const list = p.input_type === 'PASS_FAIL' ? ['PASS', 'FAIL'] : choices;
      return <select name={name} className="input w-28" disabled={!canEdit} value={v} onChange={(e) => on(e.target.value)}><option value="">—</option>{list.map((x) => <option key={x} value={x}>{x}</option>)}</select>;
    }
    if (p.input_type === 'PHOTO') return <span className="text-small text-ink-secondary">Attach in Photos ({p.evidence_count})</span>;
    if (p.input_type === 'TEXT') return <input name={name} className="input w-56" disabled={!canEdit} value={v} onChange={(e) => on(e.target.value)} />;
    return <input name={name} className="input w-24 text-right" type="number" step="any" disabled={!canEdit} value={v} onChange={(e) => on(e.target.value)} />;
  };
  if (!t.params.length) return <div className="card p-6 text-center text-ink-muted">The test plan has no parameters</div>;
  return (
    <div className="space-y-3">
      {!canEdit && t.editable && <p className="rounded-lg border border-surface-border bg-surface-muted px-4 py-2 text-small text-ink-secondary">Start the trial to enter readings.</p>}
      {err && <p id="lab-meas-error" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-small text-red-700">{err}</p>}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[1000px]" id="lab-meas-grid">
          <thead><tr><th className="th">Parameter</th><th className="th">Method</th><th className="th">Acceptance</th><th className="th">Readings</th><th className="th text-right">Result</th><th className="th">Status</th></tr></thead>
          <tbody>{t.params.map((p: any) => {
            const r = p.result;
            const cells = cellsOf(p);
            return (
              <tr key={p.parameter_id} className="align-top" data-param={p.code}>
                <td className="td"><p className="font-medium">{p.name}{p.is_mandatory ? <span className="ml-0.5 text-red-500">*</span> : null}</p>
                  <p className="text-caption text-ink-secondary">{label(p.input_type)}{p.formula_code && p.formula_code !== 'NONE' && p.formula_code !== 'DIRECT' ? ` · ${label(p.formula_code)}` : ''}{p.reading_unit ? ` · readings in ${p.reading_unit}` : ''}</p></td>
                <td className="td text-small">{p.method_code ?? '—'}{p.standard_reference ? <p className="text-caption text-ink-secondary">{p.standard_reference}</p> : null}</td>
                <td className="td text-small">{criteriaText(p)} {p.unit ?? ''}</td>
                <td className="td">
                  {p.input_type === 'BEFORE_AFTER' ? (
                    <div className="space-y-1">{cells.filter((c) => c.stage === 'BEFORE').map((c) => (
                      <div key={c.no} className="flex items-center gap-1 text-small"><span className="w-6 text-ink-muted">#{c.no}</span><span className="text-ink-secondary">B</span>{input(p, c)}<span className="text-ink-secondary">A</span>{input(p, { stage: 'AFTER', no: c.no })}</div>
                    ))}</div>
                  ) : <div className="flex flex-wrap gap-1">{cells.map((c) => <span key={c.no}>{input(p, c)}</span>)}</div>}
                </td>
                <td className="td text-right tabular-nums">{r?.display_value != null ? <span className="font-semibold">{r.display_value} {p.unit ?? ''}</span> : '—'}
                  {r?.result_text && <p className="text-caption text-ink-secondary">{r.result_text}</p>}</td>
                <td className="td"><ResultBadge value={r?.evaluation_status ?? 'PENDING'} override={!!Number(r?.is_override)} />{r?.evaluation_note && <p className="mt-0.5 text-caption text-ink-secondary">{r.evaluation_note}</p>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-small text-ink-secondary">Overall: <ResultBadge value={t.overall_result ?? 'PENDING'} /> · results are calculated by the server from the raw readings</p>
        {canEdit && <Button id="lab-meas-save" loading={busy} disabled={!dirty} onClick={() => void save()}>Save readings</Button>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- results (override / external source) */
function ResultsTab({ t, canEdit, canOverride, onSaved }: { t: any; canEdit: boolean; canOverride: boolean; onSaved: (d: any) => void }) {
  const toast = useToast();
  const [ov, setOv] = useState<any>(null);
  const [src, setSrc] = useState<any>(null);
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[1000px]" id="lab-results">
        <thead><tr><th className="th">Parameter</th><th className="th">Acceptance</th><th className="th text-right">Before</th><th className="th text-right">After</th><th className="th text-right">Result</th><th className="th text-right">Full precision</th>
          <th className="th">Status</th><th className="th">Source / observation</th><th className="th" /></tr></thead>
        <tbody>{t.params.map((p: any) => {
          const r = p.result ?? {};
          return (
            <tr key={p.parameter_id} className="align-top">
              <td className="td"><p className="font-medium">{p.name}</p><p className="text-caption text-ink-secondary">{p.is_mandatory ? 'Mandatory' : 'Optional'} · {label(p.formula_code)} v{p.formula_version}</p></td>
              <td className="td text-small">{criteriaText(p)}</td>
              <td className="td text-right tabular-nums">{r.raw_before != null ? num(r.raw_before, 3) : ''}</td><td className="td text-right tabular-nums">{r.raw_after != null ? num(r.raw_after, 3) : ''}</td>
              <td className="td text-right tabular-nums font-semibold">{r.display_value ?? '—'} {r.display_value ? p.unit ?? '' : ''}</td>
              <td className="td text-right tabular-nums text-small text-ink-secondary">{r.calculated_value ?? ''}</td>
              <td className="td"><ResultBadge value={r.evaluation_status ?? 'PENDING'} override={!!Number(r.is_override)} />
                {Number(r.is_override) ? <p className="text-caption text-ink-secondary">calc {label(r.calc_status)} · {r.override_reason}</p> : r.evaluation_note ? <p className="text-caption text-ink-secondary">{r.evaluation_note}</p> : null}</td>
              <td className="td text-small">{r.result_source === 'EXTERNAL' ? <span>External: {r.external_lab_name} · cert {r.certificate_no} · {String(r.certificate_date ?? '').slice(0, 10)}</span> : 'Internal'}
                {r.observation && <p className="text-ink-secondary">{r.observation}</p>}</td>
              <td className="td whitespace-nowrap">
                {canEdit && <button type="button" className="mr-3 text-small text-brand-700 hover:underline" onClick={() => setSrc({ p, r })}>Source</button>}
                {canOverride && r.id && <button type="button" className="text-small text-amber-700 hover:underline" onClick={() => setOv({ p, r })}>Override</button>}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
      {ov && <OverrideModal t={t} p={ov.p} r={ov.r} onClose={() => setOv(null)} onDone={(d) => { onSaved(d); toast('Override recorded'); }} />}
      {src && <SourceModal t={t} p={src.p} r={src.r} onClose={() => setSrc(null)} onDone={(d) => { onSaved(d); toast('Result source saved'); }} />}
    </div>
  );
}

function OverrideModal({ t, p, r, onClose, onDone }: { t: any; p: any; r: any; onClose: () => void; onDone: (d: any) => void }) {
  const [status, setStatus] = useState<string>(Number(r.is_override) ? r.evaluation_status : '');
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { const d = await http.post<{ data: any }>(`/lab/trials/${t.id}/results/${p.parameter_id}/override`, { status: status || null, reason }); onDone(d.data); onClose(); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Override — ${p.name}`} subtitle={`Calculated: ${label(r.calc_status)} · ${r.display_value ?? '—'}. Needs a reason; audited; cleared automatically if the readings change the result.`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void go()}>Save</Button></>}>
      <div className="space-y-3">
        <Select label="Status" options={[{ value: '', label: 'Remove override (use calculated)' }, ...opts(['PASS', 'FAIL', 'BORDERLINE', 'NOT_APPLICABLE'])]} value={status} onChange={(e) => setStatus(e.target.value)} />
        <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} error={err || undefined} />
      </div>
    </Modal>
  );
}

function SourceModal({ t, p, r, onClose, onDone }: { t: any; p: any; r: any; onClose: () => void; onDone: (d: any) => void }) {
  const [v, setV] = useState({ result_source: r.result_source ?? 'INTERNAL', external_lab_name: r.external_lab_name ?? '', certificate_no: r.certificate_no ?? '',
    certificate_date: String(r.certificate_date ?? '').slice(0, 10), certificate_attachment_id: r.certificate_attachment_id ? String(r.certificate_attachment_id) : '', observation: r.observation ?? '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [atts, setAtts] = useState<any[]>(t.attachments);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const d = await http.put<{ data: any }>(`/lab/trials/${t.id}/results/${p.parameter_id}/source`, { ...v, certificate_date: v.certificate_date || null,
        certificate_attachment_id: v.certificate_attachment_id ? Number(v.certificate_attachment_id) : null, external_lab_name: v.external_lab_name || null, certificate_no: v.certificate_no || null, observation: v.observation || null });
      onDone(d.data); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const ext = v.result_source === 'EXTERNAL';
  return (
    <Modal open onClose={onClose} title={`Result source — ${p.name}`} subtitle="External results need the lab, certificate no, date and the certificate file"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void go()}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Source" options={[{ value: 'INTERNAL', label: 'Internal lab' }, { value: 'EXTERNAL', label: 'External lab' }]} value={v.result_source} onChange={(e) => setV({ ...v, result_source: e.target.value })} />
        {ext && <>
          <Input label="External lab" required value={v.external_lab_name} onChange={(e) => setV({ ...v, external_lab_name: e.target.value })} />
          <Input label="Certificate no" required value={v.certificate_no} onChange={(e) => setV({ ...v, certificate_no: e.target.value })} />
          <Input label="Certificate date" required type="date" value={v.certificate_date} onChange={(e) => setV({ ...v, certificate_date: e.target.value })} />
          <Select label="Certificate file" required placeholder="—" options={atts.map((a) => ({ value: a.id, label: `${a.original_name} (${label(a.attachment_type)})` }))} value={v.certificate_attachment_id} onChange={(e) => setV({ ...v, certificate_attachment_id: e.target.value })} />
          <div className="flex items-end"><FilePick label="Upload certificate" onPick={async (f) => {
            try { const a = await uploadLabFile(f, { trial_id: t.id, parameter_id: p.parameter_id, attachment_type: 'CERTIFICATE' }); setAtts((x) => [...x, { id: a.id, original_name: f.name, attachment_type: 'CERTIFICATE' }]); setV((o) => ({ ...o, certificate_attachment_id: String(a.id) })); }
            catch (e) { setErr(errMsg(e)); } }} /></div>
        </>}
        <Textarea label="Observation" className="sm:col-span-2" value={v.observation} onChange={(e) => setV({ ...v, observation: e.target.value })} error={err || undefined} />
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- photos */
function PhotosTab({ t, canEdit, onChanged }: { t: any; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [type, setType] = useState('AFTER_PHOTO'); const [pid, setPid] = useState(''); const [caption, setCaption] = useState('');
  const [rm, setRm] = useState<any>(null);
  const need = t.params.filter((p: any) => p.evidence_required);
  return (
    <div className="space-y-4">
      {need.length > 0 && <p className="text-small text-ink-secondary">Evidence required for: {need.map((p: any) => `${p.name} (${p.evidence_count})`).join(', ')}</p>}
      {canEdit && (
        <div className="card flex flex-wrap items-end gap-3 p-3">
          <Select label="Type" className="w-44" options={opts(ATTACHMENT_TYPES)} value={type} onChange={(e) => setType(e.target.value)} />
          <Select label="For parameter" className="w-64" placeholder="Whole trial" options={t.params.map((p: any) => ({ value: p.parameter_id, label: p.name }))} value={pid} onChange={(e) => setPid(e.target.value)} />
          <Input label="Caption" className="w-64" value={caption} onChange={(e) => setCaption(e.target.value)} />
          <FilePick id="lab-trial-photo" label="Upload" onPick={async (f) => {
            try { await uploadLabFile(f, { trial_id: t.id, parameter_id: pid ? Number(pid) : null, attachment_type: type, caption: caption || null }); setCaption(''); onChanged(); toast('File attached'); }
            catch (e) { toast(errMsg(e), 'error'); } }} />
        </div>
      )}
      <Card title="Files">
        <div className="px-4 py-2"><AttachmentList rows={t.attachments.map((a: any) => ({ ...a, caption: [a.parameter_id ? t.params.find((p: any) => p.parameter_id === Number(a.parameter_id))?.name : null, a.caption].filter(Boolean).join(' · ') }))}
          onRemove={canEdit ? (a) => setRm(a) : undefined} /></div>
      </Card>
      <ReasonModal open={!!rm} title={`Remove ${rm?.original_name ?? ''}`} danger confirm="Remove" onClose={() => setRm(null)}
        onSubmit={async (reason) => { await http.post(`/lab/attachments/${rm.id}/remove`, { reason }); onChanged(); }} />
    </div>
  );
}

/* ---------------------------------------------------------------- deviations */
function DeviationsTab({ t, canEdit, onSaved }: { t: any; canEdit: boolean; onSaved: (d: any) => void }) {
  const [v, setV] = useState({ stage_no: '', deviation_type: 'TEMPERATURE', target_value: '', actual_value: '', reason: '', corrective_action: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const add = async () => {
    setBusy(true); setErr('');
    try { const d = await http.post<{ data: any }>(`/lab/trials/${t.id}/deviations`, { ...v, stage_no: v.stage_no || null, target_value: v.target_value || null, actual_value: v.actual_value || null, corrective_action: v.corrective_action || null });
      onSaved(d.data); setV({ stage_no: '', deviation_type: 'TEMPERATURE', target_value: '', actual_value: '', reason: '', corrective_action: '' }); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="card p-4">
          <FormSection title="Record a deviation (target vs actual)">
            <Select label="Stage" placeholder="—" options={t.stages.map((x: any) => ({ value: x.stage_no, label: `${x.stage_no} · ${x.process_code}` }))} value={v.stage_no} onChange={(e) => setV({ ...v, stage_no: e.target.value })} />
            <Select label="Type" options={opts(['TEMPERATURE', 'TIME', 'DOSAGE', 'LIQUOR', 'PH', 'MACHINE', 'OTHER'])} value={v.deviation_type} onChange={(e) => setV({ ...v, deviation_type: e.target.value })} />
            <Input label="Target" value={v.target_value} onChange={(e) => setV({ ...v, target_value: e.target.value })} />
            <Input label="Actual" value={v.actual_value} onChange={(e) => setV({ ...v, actual_value: e.target.value })} />
            <Input label="Reason" required className="sm:col-span-2" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
            <Input label="Corrective action" className="sm:col-span-2" value={v.corrective_action} onChange={(e) => setV({ ...v, corrective_action: e.target.value })} />
          </FormSection>
          {err && <p className="mb-2 text-small text-red-600">{err}</p>}
          <Button id="lab-dev-add" loading={busy} onClick={() => void add()}>Add deviation</Button>
        </div>
      )}
      <div className="card overflow-x-auto">
        <table className="w-full"><thead><tr><th className="th">Stage</th><th className="th">Type</th><th className="th">Target</th><th className="th">Actual</th><th className="th">Reason</th><th className="th">Corrective action</th><th className="th">Reported</th><th className="th">Resolved</th><th className="th" /></tr></thead>
          <tbody>
            {t.deviations.length === 0 && <tr><td colSpan={9} className="td text-center text-ink-muted">No deviations</td></tr>}
            {t.deviations.map((d: any) => (
              <tr key={d.id}><td className="td">{d.stage_no ?? '—'}</td><td className="td">{label(d.deviation_type)}</td><td className="td">{d.target_value ?? ''}</td><td className="td">{d.actual_value ?? ''}</td>
                <td className="td">{d.reason}</td><td className="td">{d.corrective_action ?? ''}</td><td className="td text-small">{fmtDateTime(d.reported_at)} · {d.reported_by_name}</td>
                <td className="td text-small">{d.resolved_at ? `${fmtDateTime(d.resolved_at)} · ${d.resolved_by_name}` : <Badge tone="amber">Open</Badge>}</td>
                <td className="td">{canEdit && !d.resolved_at && <button type="button" className="text-small text-brand-700 hover:underline" onClick={() => setRes(d)}>Resolve</button>}</td></tr>
            ))}
          </tbody></table>
      </div>
      <ReasonModal open={!!res} title="Resolve deviation" confirm="Resolve" onClose={() => setRes(null)}
        onSubmit={async (corrective_action) => { const d = await http.post<{ data: any }>(`/lab/trials/${t.id}/deviations/${res.id}/resolve`, { corrective_action }); onSaved(d.data); }} />
    </div>
  );
}

/* ---------------------------------------------------------------- submit */
function SubmitModal({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: (d: any) => void }) {
  const [rec, setRec] = useState(''); const [busy, setBusy] = useState(false); const [errs, setErrs] = useState<string[]>([]);
  const go = async () => {
    setBusy(true); setErrs([]);
    try { const d = await http.post<{ data: any }>(`/lab/trials/${t.id}/submit`, { row_version: t.row_version, recommendation: rec || null }); onDone(d.data); onClose(); }
    catch (e) {
      const det = e instanceof ApiError && Array.isArray(e.details) ? (e.details as any[]).map((x) => x.message).filter(Boolean) : [];
      setErrs(det.length ? det : [errMsg(e)]);
    } finally { setBusy(false); }
  };
  const missing = t.params.filter((p: any) => p.is_mandatory && (!p.result || ['PENDING', 'INVALID'].includes(p.result.evaluation_status)));
  return (
    <Modal open onClose={onClose} title={`Submit ${t.trial_no} to the Lab In-charge`} subtitle="The recipe, readings and results are frozen into a report revision"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="lab-trial-submit-confirm" loading={busy} onClick={() => void go()}>Submit</Button></>}>
      <div className="space-y-3">
        <p className="text-small">Overall result now: <ResultBadge value={t.overall_result ?? 'PENDING'} /></p>
        {missing.length > 0 && <p className="text-small text-amber-700">Missing mandatory results: {missing.map((p: any) => p.name).join(', ')}</p>}
        <Textarea label="Recommendation (on the report)" value={rec} onChange={(e) => setRec(e.target.value)} />
        {errs.length > 0 && <div id="lab-submit-errors" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-small text-red-700">{errs.map((x) => <p key={x}>{x}</p>)}</div>}
      </div>
    </Modal>
  );
}
