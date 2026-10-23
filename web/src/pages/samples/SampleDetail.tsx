import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Paperclip, Plus, RotateCcw, Save, Send, Trash2, XCircle } from 'lucide-react';
import clsx from 'clsx';
import {
  PageHeader, Card, Button, Input, Select, Textarea, FormSection, Tabs, Modal, Badge, LoadingBlock, ErrorState, ConfirmDialog,
} from '../../components/ui';
import { http, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate, fmtDateTime, fmtNumber, today } from '../../lib/format';
import { SampleStatus, ProcStatus, Kpi, ReasonModal, inr, errMsg, AllocState, STATUS_LABEL } from './sampleShared';
import { CostingTab, AllocationTab } from './SampleCostAlloc';

/**
 * One sample (client 23-Oct-2026, spec §6.3–§6.7): the request, its stages (owner, start / hold / resume / complete /
 * reassign / skip / reopen, output, labour), cost ledger, QC + buyer submissions / decisions / revisions, the
 * allocation of its cost to confirmed orders and the timeline. Every number comes from the server.
 */
type DetailTab = 'overview' | 'workflow' | 'costing' | 'qc' | 'allocation' | 'audit';

export function SampleDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  return isNew ? <SampleForm /> : <SampleView id={Number(id)} />;
}

export function useSample(id: number) {
  return useQuery({ queryKey: ['sample', id], queryFn: async () => (await http.get<{ data: any }>(`/samples/${id}`)).data });
}

/* ================================================================ request form (new + edit) */
function SampleForm({ sample, onSaved }: { sample?: any; onSaved?: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const types = useLookup('sample-types');
  const styles = useLookup('styles');
  const buyers = useLookup('buyers');
  const users = useLookup('users');
  const uoms = useLookup('uoms');
  const enquiries = useLookup('enquiries');
  const isNew = !sample;
  const draft = isNew || sample.status === 'DRAFT';
  const closed = !isNew && ['COMPLETED', 'CANCELLED'].includes(sample.status);
  const editable = !closed && (isNew ? can('SAMPLE.CREATE') : can('SAMPLE.UPDATE'));
  const init = () => ({
    sample_no: sample?.sample_no ?? '', sample_type_id: sample?.sample_type_id ?? '', style_id: sample?.style_id ?? '', buyer_id: sample?.buyer_id ?? '',
    enquiry_id: sample?.enquiry_id ?? '', qty: sample?.qty ?? 1, uom_id: sample?.uom_id ?? '', priority: sample?.priority ?? 'NORMAL',
    request_date: sample?.request_date ?? today(), target_date: sample?.target_date ?? '', merchandiser_id: sample?.merchandiser_id ?? '',
    coordinator_id: sample?.coordinator_id ?? '', instructions: sample?.instructions ?? '', recovered_amount: sample?.recovered_amount ?? 0,
    change_reason: '',
  });
  const [v, setV] = useState<any>(init);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { setV(init()); setErrors({}); }, [sample?.row_version]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, val: unknown) => setV((s: any) => ({ ...s, [k]: val }));
  // the style's buyer fills the buyer
  const styleRow = (styles.data ?? []).find((s: any) => String(s.id) === String(v.style_id)) as any;
  useEffect(() => { if (draft && styleRow?.buyer_id && !v.buyer_id) set('buyer_id', styleRow.buyer_id); }, [styleRow?.buyer_id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isNew && !v.uom_id && uoms.data) { const pcs = uoms.data.find((u) => u.code === 'PCS'); if (pcs) set('uom_id', pcs.id); }
  const tracked = !draft && sample && (String(v.target_date) !== String(sample.target_date ?? '') || Number(v.qty) !== Number(sample.qty)
    || (v.instructions ?? '') !== (sample.instructions ?? '') || Number(v.recovered_amount) !== Number(sample.recovered_amount) || String(v.request_date) !== String(sample.request_date ?? ''));
  const targetBefore = v.target_date && v.request_date && v.target_date < v.request_date;

  const save = async (submit = false) => {
    setErrors({}); setSaving(true);
    try {
      const body = {
        ...v, sample_type_id: Number(v.sample_type_id) || null, style_id: Number(v.style_id) || null, buyer_id: Number(v.buyer_id) || null,
        enquiry_id: Number(v.enquiry_id) || null, uom_id: Number(v.uom_id) || null, merchandiser_id: Number(v.merchandiser_id) || null,
        coordinator_id: Number(v.coordinator_id) || null, qty: Number(v.qty), recovered_amount: Number(v.recovered_amount) || 0,
        change_reason: v.change_reason || null, row_version: sample?.row_version, submit,
      };
      if (isNew) {
        const r = await http.post<{ data: { id: number } }>(`/samples${submit ? '?submit=1' : ''}`, body);
        toast(submit ? 'Sample submitted — stages created' : 'Sample saved as draft');
        void qc.invalidateQueries({ queryKey: ['samples'] });
        nav(`/sales/samples/${r.data.id}${submit ? '?tab=workflow' : ''}`, { replace: true });
      } else {
        const r = await http.put<{ data: any }>(`/samples/${sample.id}`, body);
        toast(r.data.unchanged ? 'Nothing changed' : 'Sample updated');
        onSaved?.();
      }
    } catch (e: any) {
      setErrors(e?.fieldErrors ?? {});
      toast(errMsg(e), 'error');
    } finally { setSaving(false); }
  };

  const form = (
    <div className="card p-4" id="sample-form">
      <FormSection title="Request" cols={4}>
        <Input label="Sample no" value={v.sample_no} disabled={!isNew || !editable} placeholder="Auto" hint={isNew ? 'Leave blank to auto-number' : undefined} onChange={(e) => set('sample_no', e.target.value)} />
        <Select label="Sample type" required id="sample-type" disabled={!draft || !editable} placeholder="— Select —" options={toOptions(types.data)} value={v.sample_type_id} error={errors.sample_type_id}
          onChange={(e) => set('sample_type_id', e.target.value)} hint={draft ? 'Decides the stages (workflow version)' : `Workflow v${sample?.workflow_version ?? '—'}`} />
        <Select label="Style" required id="sample-style" disabled={!draft || !editable} placeholder="— Select —" options={toOptions(styles.data)} value={v.style_id} error={errors.style_id}
          onChange={(e) => { set('style_id', e.target.value); set('buyer_id', ''); }} />
        <Select label="Buyer" required id="sample-buyer" disabled={!draft || !editable || !!styleRow?.buyer_id} placeholder="— Select —" options={toOptions(buyers.data)} value={v.buyer_id} error={errors.buyer_id}
          onChange={(e) => set('buyer_id', e.target.value)} hint={styleRow?.buyer_id ? "The style's buyer" : undefined} />
        <Input label="Quantity" required type="number" min={1} step={1} id="sample-qty" value={v.qty} disabled={!editable} error={errors.qty} onChange={(e) => set('qty', e.target.value)} />
        <Select label="UOM" options={toOptions(uoms.data)} placeholder="—" value={v.uom_id} disabled={!editable} onChange={(e) => set('uom_id', e.target.value)} />
        <Select label="Priority" value={v.priority} disabled={!editable} onChange={(e) => set('priority', e.target.value)} options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'HIGH', label: 'High' }, { value: 'CRITICAL', label: 'Critical' }]} />
        <Select label="Enquiry" placeholder="—" options={toOptions(enquiries.data)} value={v.enquiry_id} disabled={!editable} onChange={(e) => set('enquiry_id', e.target.value)} />
        <Input label="Request date" required type="date" value={v.request_date} disabled={!editable} error={errors.request_date} onChange={(e) => set('request_date', e.target.value)} />
        <Input label="Target date" required type="date" id="sample-target" value={v.target_date} disabled={!editable} error={errors.target_date || (targetBefore ? 'Before the request date — needs a reason and approval rights' : undefined)} onChange={(e) => set('target_date', e.target.value)} />
        <Select label="Merchandiser" placeholder="Me" options={toOptions(users.data)} value={v.merchandiser_id} disabled={!editable} onChange={(e) => set('merchandiser_id', e.target.value)} />
        <Select label="Sample coordinator" placeholder="—" options={toOptions(users.data)} value={v.coordinator_id} disabled={!editable} onChange={(e) => set('coordinator_id', e.target.value)} />
        <Textarea className="sm:col-span-2 lg:col-span-3" label="Instructions" value={v.instructions} disabled={!editable} onChange={(e) => set('instructions', e.target.value)} />
        <Input label="Sample charge paid by buyer (₹)" type="number" min={0} step="0.01" value={v.recovered_amount} disabled={!editable || !can('SAMPLE.COST')}
          hint="Reduces the cost that can be allocated to orders" onChange={(e) => set('recovered_amount', e.target.value)} />
        {(tracked || targetBefore) && (
          <Input className="sm:col-span-2 lg:col-span-4" label="Reason for the change" required id="sample-change-reason" value={v.change_reason} error={errors.change_reason}
            hint="Logged in the sample timeline" onChange={(e) => set('change_reason', e.target.value)} />
        )}
      </FormSection>
      {editable && (
        <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
          {isNew && <Button variant="secondary" onClick={() => nav('/sales/samples?tab=register')}>Cancel</Button>}
          <Button variant={isNew ? 'secondary' : 'primary'} loading={saving} id="sample-save" onClick={() => void save(false)}><Save size={14} />{isNew ? 'Save draft' : 'Save changes'}</Button>
          {isNew && <Button loading={saving} id="sample-save-submit" onClick={() => void save(true)}><Send size={14} />Save &amp; submit</Button>}
        </div>
      )}
    </div>
  );
  if (!isNew) return form;
  return (
    <div>
      <PageHeader title="New sample" breadcrumb={['Orders', 'Samples']} subtitle="Buyer, style, type, quantity and dates — submitting creates the stages of the type's workflow"
        actions={<Button variant="secondary" onClick={() => nav('/sales/samples?tab=register')}><ArrowLeft size={15} />Back</Button>} />
      {form}
    </div>
  );
}

/* ================================================================ sample view */
function SampleView({ id }: { id: number }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as DetailTab) || 'overview';
  const setTab = (t: string) => { const n = new URLSearchParams(sp); n.set('tab', t); setSp(n, { replace: true }); };
  const q = useSample(id);
  const s = q.data;
  const [dlg, setDlg] = useState<null | 'cancel' | 'reopen' | 'delete' | 'decision-internal' | 'decision-buyer' | 'submission' | 'revision' | 'qc'>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['sample', id] }); void qc.invalidateQueries({ queryKey: ['sample-costs', id] }); void qc.invalidateQueries({ queryKey: ['sample-allocs', id] }); void qc.invalidateQueries({ queryKey: ['sample-audit', id] }); void qc.invalidateQueries({ queryKey: ['samples'] }); };
  const post = async (path: string, body: any, msg: string) => {
    setBusy(true);
    try { const r = await http.post<{ data: any }>(path, { row_version: s?.row_version, ...body }); toast(msg); setDlg(null); refresh(); return r.data; }
    catch (e) { toast(errMsg(e), 'error'); if ((e as any)?.status === 409) refresh(); return null; } finally { setBusy(false); }
  };
  if (q.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (q.error || !s) return <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const m = s.metrics;
  const closed = ['COMPLETED', 'CANCELLED'].includes(s.status);
  const curProcs = s.processes.filter((p: any) => Number(p.revision_no) === Number(s.revision_no));
  const needsStages = !['DRAFT', ...['COMPLETED', 'CANCELLED']].includes(s.status) && curProcs.filter((p: any) => p.status !== 'CANCELLED').length === 0
    && ['SUBMITTED', 'IN_PROGRESS', 'ON_HOLD'].includes(s.status);

  return (
    <div>
      <PageHeader breadcrumb={['Orders', 'Samples']}
        title={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{s.sample_no}</span><SampleStatus value={s.status} />
          {s.revision_no > 0 && <Badge tone="violet">Revision {s.revision_no}</Badge>}
          {s.priority !== 'NORMAL' && <Badge tone={s.priority === 'CRITICAL' ? 'red' : 'amber'}>{s.priority === 'CRITICAL' ? 'Critical' : 'High'}</Badge>}</span>}
        subtitle={`${s.type_name ?? s.sample_type} · ${s.buyer_name ?? '—'} · ${s.style_code} ${s.style_name ?? ''} · ${fmtNumber(s.qty)} ${s.uom_code ?? 'pcs'} · workflow v${s.workflow_version ?? '—'}`}
        actions={<div className="flex flex-wrap gap-2" id="sample-actions">
          <Button variant="secondary" onClick={() => nav('/sales/samples?tab=register')}><ArrowLeft size={15} />Back</Button>
          {s.status === 'DRAFT' && can('SAMPLE.UPDATE') && <Button id="act-submit" loading={busy} onClick={() => void post(`/samples/${id}/submit`, {}, 'Submitted — stages created').then((r) => r && setTab('workflow'))}><Send size={14} />Submit</Button>}
          {s.status === 'DRAFT' && can('SAMPLE.DELETE') && <Button variant="danger" onClick={() => setDlg('delete')}><Trash2 size={14} />Delete</Button>}
          {needsStages && can('SAMPLE.UPDATE') && <Button id="act-create-stages" loading={busy} onClick={() => void post(`/samples/${id}/create-stages`, {}, 'Stages created')}><Plus size={14} />Create stages</Button>}
          {s.status === 'PENDING_INTERNAL_APPROVAL' && can('SAMPLE.APPROVE') && <Button id="act-internal" onClick={() => setDlg('decision-internal')}><CheckCircle2 size={14} />Internal approval</Button>}
          {['INTERNALLY_APPROVED', 'SUBMITTED_TO_BUYER'].includes(s.status) && can('SAMPLE.APPROVE') && <Button id="act-submission" variant={s.status === 'SUBMITTED_TO_BUYER' ? 'secondary' : 'primary'} onClick={() => setDlg('submission')}><Send size={14} />{s.status === 'SUBMITTED_TO_BUYER' ? 'Another dispatch' : 'Submit to buyer'}</Button>}
          {s.status === 'SUBMITTED_TO_BUYER' && can('SAMPLE.APPROVE') && <Button id="act-buyer" onClick={() => setDlg('decision-buyer')}><CheckCircle2 size={14} />Buyer response</Button>}
          {['REVISION_REQUIRED', 'REJECTED'].includes(s.status) && can('SAMPLE.APPROVE') && <Button id="act-revision" onClick={() => setDlg('revision')}><RotateCcw size={14} />Start revision</Button>}
          {['APPROVED', 'REJECTED'].includes(s.status) && can('SAMPLE.APPROVE') && <Button id="act-close" variant="secondary" loading={busy} onClick={() => void post(`/samples/${id}/close`, {}, s.status === 'APPROVED' ? 'Sample completed' : 'Sample closed')}>{s.status === 'APPROVED' ? 'Close (completed)' : 'Close — no resubmission'}</Button>}
          {!closed && s.status !== 'DRAFT' && can('SAMPLE.APPROVE') && <Button variant="ghost" className="text-red-600" id="act-cancel" onClick={() => setDlg('cancel')}><XCircle size={14} />Cancel</Button>}
          {closed && can('SAMPLE.APPROVE') && <Button variant="secondary" id="act-reopen" onClick={() => setDlg('reopen')}><RotateCcw size={14} />Reopen</Button>}
        </div>} />

      {s.next_action && s.next_action !== '—' && (
        <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3.5 py-2 text-[12.5px] text-sky-800" id="sample-next">
          Next: <b>{s.next_action}</b>{s.current_stage ? ` · current stage ${s.current_stage.stage_name} (${s.current_stage.dept_name ?? 'no department'} · ${s.current_stage.owner ?? 'no owner'})` : ''}
          {s.purchases_to_import > 0 && <> · <button className="font-semibold underline" onClick={() => setTab('costing')}>{s.purchases_to_import} purchase line(s) booked to this sample are not in its cost yet</button></>}
        </div>
      )}
      {m.allocation_state === 'EXCEPTION' && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2 text-[12.5px] text-red-700">
          Allocated {inr(m.allocated_cost)} is more than the posted cost {inr(m.eligible_cost)} (a cost was reversed) — reverse or adjust the allocation.
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8" id="sample-metrics">
        <Kpi label="Elapsed" value={`${m.elapsed_days ?? '—'} d`} sub={`${m.elapsed_working_days ?? '—'} working days`} tone="blue" />
        <Kpi label="Delay" value={m.delay_days ? `${m.delay_days} d` : '0 d'} sub={`Target ${fmtDate(s.target_date)}`} tone={m.delay_days ? 'red' : 'green'} />
        <Kpi label="Progress" value={`${s.progress.done}/${s.progress.total}`} sub={`${fmtNumber(s.good_qty ?? 0)} good pcs`} tone="violet" />
        <Kpi label="Today's cost" value={inr(m.today_cost, '₹ 0')} sub={`${inr(m.today_cost_per_piece)} / piece`} />
        <Kpi label="Cumulative cost" value={inr(m.cumulative_cost, '₹ 0')} sub={m.pending_cost ? `${inr(m.pending_cost)} not approved yet` : 'approved / posted'} tone="slate" />
        <Kpi label="Cost / piece" value={inr(m.cost_per_piece)} sub={`Good piece ${inr(m.cost_per_good_piece)}`} />
        <Kpi label="Avg / piece / day" value={inr(m.avg_daily_cost_per_piece)} />
        <Kpi label="Allocated to orders" value={inr(m.allocated_cost, '₹ 0')} sub={<AllocState value={m.allocation_state} />} tone="green" onClick={() => setTab('allocation')} />
      </div>

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'overview', label: 'Overview' }, { key: 'workflow', label: 'Stages', count: curProcs.length },
        { key: 'costing', label: 'Costing' }, { key: 'qc', label: 'QC & buyer', count: s.qc_inspections.length + s.submissions.length + s.decisions.length },
        { key: 'allocation', label: 'Order allocation' }, { key: 'audit', label: 'Timeline' },
      ]} />
      {tab === 'overview' && <Overview s={s} refresh={refresh} />}
      {tab === 'workflow' && <Workflow s={s} refresh={refresh} />}
      {tab === 'costing' && <CostingTab s={s} refresh={refresh} />}
      {tab === 'qc' && <QcBuyer s={s} openQc={() => setDlg('qc')} />}
      {tab === 'allocation' && <AllocationTab s={s} refresh={refresh} />}
      {tab === 'audit' && <Timeline id={id} />}

      <ReasonModal open={dlg === 'cancel'} title={`Cancel ${s.sample_no}`} message="Open stages are cancelled. Costs stay in the ledger." confirmLabel="Cancel sample" danger busy={busy}
        onClose={() => setDlg(null)} onConfirm={(reason) => void post(`/samples/${id}/cancel`, { reason }, 'Sample cancelled')} />
      <ReasonModal open={dlg === 'reopen'} title={`Reopen ${s.sample_no}`} confirmLabel="Reopen" busy={busy}
        onClose={() => setDlg(null)} onConfirm={(reason) => void post(`/samples/${id}/reopen`, { reason }, 'Sample reopened')} />
      <ConfirmDialog open={dlg === 'delete'} title="Delete draft" message={`Delete draft ${s.sample_no}? This cannot be undone.`} busy={busy} onCancel={() => setDlg(null)}
        onConfirm={async () => { setBusy(true); try { await http.del(`/samples/${id}`); toast('Draft deleted'); void qc.invalidateQueries({ queryKey: ['samples'] }); nav('/sales/samples?tab=register'); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); } }} />
      {(dlg === 'decision-internal' || dlg === 'decision-buyer') && <DecisionModal s={s} stage={dlg === 'decision-internal' ? 'INTERNAL' : 'BUYER'} busy={busy} onClose={() => setDlg(null)}
        onSave={(b) => void post(`/samples/${id}/approvals`, b, 'Decision recorded')} />}
      {dlg === 'submission' && <SubmissionModal s={s} busy={busy} onClose={() => setDlg(null)} onSave={(b) => void post(`/samples/${id}/submissions`, b, 'Submission recorded')} />}
      {dlg === 'revision' && <RevisionModal s={s} busy={busy} onClose={() => setDlg(null)} onSave={(b) => void post(`/samples/${id}/revisions`, b, 'Revision started — stages created').then((r) => r && setTab('workflow'))} />}
      {dlg === 'qc' && <QcModal s={s} busy={busy} onClose={() => setDlg(null)} onSave={(b) => void post(`/samples/${id}/qc-inspections`, b, 'QC inspection recorded')} />}
    </div>
  );
}

/* ================================================================ overview */
function Overview({ s, refresh }: { s: any; refresh: () => void }) {
  return (
    <div className="space-y-4">
      <SampleForm sample={s} onSaved={refresh} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 text-[12.5px]">
            <dt className="text-slate-500">Created</dt><dd>{fmtDateTime(s.created_at)} · {s.created_by_name ?? '—'}</dd>
            <dt className="text-slate-500">Merchandiser</dt><dd>{s.merchandiser_name ?? '—'}</dd>
            <dt className="text-slate-500">Coordinator</dt><dd>{s.coordinator_name ?? '—'}</dd>
            <dt className="text-slate-500">Stages done</dt><dd>{s.completed_date ? fmtDate(s.completed_date) : '—'}</dd>
            <dt className="text-slate-500">Buyer decision</dt><dd>{s.buyer_decision ? s.buyer_decision.replace(/_/g, ' ').toLowerCase() : '—'}</dd>
            <dt className="text-slate-500">Last QC</dt><dd>{s.last_qc_result ?? '—'}</dd>
            {s.cancel_reason && <><dt className="text-slate-500">Cancel reason</dt><dd>{s.cancel_reason}</dd></>}
            <dt className="text-slate-500">Output (this revision)</dt><dd>{fmtNumber(s.progress.good_qty)} good · {fmtNumber(s.progress.reject_qty)} reject · {fmtNumber(s.progress.rework_qty)} rework</dd>
          </dl>
        </Card>
        <Attachments s={s} refresh={refresh} />
      </div>
    </div>
  );
}

function Attachments({ s, refresh }: { s: any; refresh: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [docType, setDocType] = useState('TECH_PACK');
  const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) { toast('File is larger than 10 MB', 'error'); return; }
    setBusy(true);
    try {
      const data = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(f); });
      const up = (await api.post('/uploads', { filename: f.name, data, folder: 'attachments' })).data.data;
      await http.post(`/samples/${s.id}/attachments`, { file_url: up.url, file_name: f.name, mime_type: up.mimeType ?? f.type, size_bytes: up.size ?? f.size, doc_type: docType });
      toast('Attachment added'); refresh();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const remove = async (a: any) => { try { await http.del(`/samples/${s.id}/attachments/${a.id}`); toast('Removed'); refresh(); } catch (e) { toast(errMsg(e), 'error'); } };
  return (
    <Card title={<span className="flex items-center gap-2"><Paperclip size={14} />Tech pack, photos &amp; evidence</span>}
      actions={can('SAMPLE.UPDATE') && <div className="flex items-center gap-2">
        <select className="input h-8 py-0 text-[12px]" value={docType} onChange={(e) => setDocType(e.target.value)}>
          {['TECH_PACK', 'PHOTO', 'MEASUREMENT', 'BUYER_COMMENTS', 'COURIER', 'OTHER'].map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ').toLowerCase()}</option>)}
        </select>
        <label className={clsx('btn-secondary btn-sm cursor-pointer', busy && 'opacity-60')}>{busy ? 'Uploading…' : 'Upload'}
          <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.svg" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label>
      </div>}>
      <div className="p-3">
        {!s.attachments.length && <p className="py-4 text-center text-[12px] text-slate-400">No files yet (PDF / images, up to 10 MB)</p>}
        {s.attachments.map((a: any) => (
          <div key={a.id} className="flex items-center justify-between border-b border-slate-100 py-1.5 text-[12.5px] last:border-0">
            <span><Badge tone="slate">{String(a.doc_type).replace(/_/g, ' ').toLowerCase()}</Badge> <a className="text-brand-700 hover:underline" href={a.file_url} target="_blank" rel="noreferrer">{a.file_name ?? a.file_url}</a></span>
            <span className="text-[11px] text-slate-400">{a.uploaded_by_name} · {fmtDateTime(a.uploaded_at)}{can('SAMPLE.UPDATE') && <button className="ml-2 text-red-500 hover:text-red-700" onClick={() => void remove(a)}>remove</button>}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ================================================================ stages */
type PAction = 'start' | 'hold' | 'resume' | 'complete' | 'reassign' | 'skip' | 'reopen';
function Workflow({ s, refresh }: { s: any; refresh: () => void }) {
  const { can } = useAuth();
  const [act, setAct] = useState<{ p: any; a: PAction } | null>(null);
  const revs = useMemo(() => [...new Set<number>(s.processes.map((p: any) => Number(p.revision_no)))].sort((a, b) => b - a), [s.processes]);
  const running = ['SUBMITTED', 'IN_PROGRESS', 'ON_HOLD'].includes(s.status);
  const reopenable = running || ['PENDING_INTERNAL_APPROVAL', 'INTERNALLY_APPROVED'].includes(s.status);
  if (!s.processes.length) return <div className="card p-8 text-center text-[13px] text-slate-500">{s.status === 'DRAFT' ? 'Submit the request to create its stages.' : 'No stages yet — use "Create stages".'}</div>;
  return (
    <div className="space-y-4" id="sample-stages">
      {revs.map((rev) => {
        const rows = s.processes.filter((p: any) => Number(p.revision_no) === rev);
        const current = rev === Number(s.revision_no);
        const r = s.revisions.find((x: any) => Number(x.revision_no) === rev);
        return (
          <Card key={rev} title={<span>{rev === 0 ? 'First build' : `Revision ${rev}`}{!current && <span className="ml-2 text-[11px] font-normal text-slate-400">earlier revision — read only</span>}</span>}
            subtitle={r?.comments ?? undefined}>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr><th className="th w-8">#</th><th className="th">Stage</th><th className="th">Status</th><th className="th">Department / owner</th><th className="th">Started · done</th>
                  <th className="th text-right">Age / SLA</th><th className="th text-right">Good · rej · rw</th><th className="th text-right">Minutes</th>{current && <th className="th" />}</tr></thead>
                <tbody>
                  {rows.map((p: any) => (
                    <tr key={p.id} className={clsx('align-top', current ? 'row-hover' : 'opacity-70')} data-stage={p.stage_code}>
                      <td className="td text-[11px] text-slate-400">{p.step_group}</td>
                      <td className="td"><p className="font-medium">{p.stage_name}{!Number(p.is_mandatory) && <span className="ml-1 text-[10.5px] text-slate-400">optional</span>}</p>
                        {p.rework_of_stage && <p className="text-[11px] text-amber-700">rework of {p.rework_of_stage}</p>}
                        {p.blocked_by?.length > 0 && <p className="text-[11px] text-slate-400">after {p.blocked_by.join(', ')}</p>}
                        {p.hold_reason && p.status === 'ON_HOLD' && <p className="text-[11px] text-amber-700">Hold: {p.hold_reason}</p>}
                        {p.skip_reason && <p className="text-[11px] text-slate-500">Skipped: {p.skip_reason}</p>}</td>
                      <td className="td"><ProcStatus value={p.status} ready={p.ready} /></td>
                      <td className="td text-[12px]"><p>{p.dept_name ?? '—'}</p><p className={!p.assigned_user_name && !p.assigned_contractor_name && current && !['COMPLETED', 'SKIPPED', 'CANCELLED'].includes(p.status) ? 'font-semibold text-red-600' : 'text-slate-500'}>
                        {p.assigned_user_name ?? p.assigned_contractor_name ?? 'no owner'}{p.assigned_contractor_name && p.assigned_user_name ? ` · ${p.assigned_contractor_name}` : ''}</p>
                        {p.planned_date && <p className="text-[11px] text-slate-400">planned {fmtDate(p.planned_date)}</p>}</td>
                      <td className="td text-[12px]">{p.started_at ? fmtDateTime(p.started_at) : '—'}<p className="text-slate-500">{p.completed_at ? fmtDateTime(p.completed_at) : ''}</p></td>
                      <td className="td text-right text-[12px] tabular-nums">{p.age_days != null ? `${p.age_days} d` : '—'}<p className={p.sla_breached ? 'font-semibold text-red-600' : 'text-slate-400'}>{p.sla_days != null ? `SLA ${Number(p.sla_days)} d` : ''}{p.sla_breached ? ' · late' : ''}</p></td>
                      <td className="td text-right text-[12px] tabular-nums">{p.good_qty != null || p.reject_qty != null ? `${fmtNumber(p.good_qty ?? 0)} · ${fmtNumber(p.reject_qty ?? 0)} · ${fmtNumber(p.rework_qty ?? 0)}` : '—'}</td>
                      <td className="td text-right text-[12px] tabular-nums">{p.labour_minutes ? fmtNumber(p.labour_minutes) : '—'}</td>
                      {current && (
                        <td className="td whitespace-nowrap text-right">
                          {can('SAMPLE.PROCESS') && running && p.status === 'NOT_STARTED' && p.ready && <Button size="sm" id={`st-start-${p.stage_code}`} onClick={() => setAct({ p, a: 'start' })}>Start</Button>}
                          {can('SAMPLE.PROCESS') && p.status === 'IN_PROGRESS' && <><Button size="sm" id={`st-complete-${p.stage_code}`} onClick={() => setAct({ p, a: 'complete' })}>Complete</Button>
                            <Button size="sm" variant="ghost" onClick={() => setAct({ p, a: 'hold' })}>Hold</Button></>}
                          {can('SAMPLE.PROCESS') && p.status === 'ON_HOLD' && <Button size="sm" onClick={() => setAct({ p, a: 'resume' })}>Resume</Button>}
                          {can('SAMPLE.PROCESS') && ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD'].includes(p.status) && <Button size="sm" variant="ghost" onClick={() => setAct({ p, a: 'reassign' })}>Assign</Button>}
                          {running && p.status === 'NOT_STARTED' && (Number(p.is_mandatory) ? can('SAMPLE.APPROVE') : can('SAMPLE.PROCESS')) && <Button size="sm" variant="ghost" id={`st-skip-${p.stage_code}`} onClick={() => setAct({ p, a: 'skip' })}>Skip</Button>}
                          {reopenable && can('SAMPLE.APPROVE') && ['COMPLETED', 'SKIPPED'].includes(p.status) && <Button size="sm" variant="ghost" onClick={() => setAct({ p, a: 'reopen' })}>Reopen</Button>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
      {act && <ProcessModal s={s} p={act.p} action={act.a} onClose={() => setAct(null)} onDone={() => { setAct(null); refresh(); }} />}
    </div>
  );
}

const ACTION_TITLE: Record<PAction, string> = { start: 'Start', hold: 'Put on hold', resume: 'Resume', complete: 'Complete', reassign: 'Assign / reassign', skip: 'Skip', reopen: 'Reopen' };
function ProcessModal({ s, p, action, onClose, onDone }: { s: any; p: any; action: PAction; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const depts = useLookup('departments');
  const users = useLookup('users');
  const contractors = useLookup('process-units');
  const [v, setV] = useState<any>({
    department_id: p.department_id ?? '', assigned_user_id: p.assigned_user_id ?? '', assigned_contractor_id: p.assigned_contractor_id ?? '', planned_date: p.planned_date ?? '',
    input_qty: p.input_qty ?? (Number(p.needs_output) ? s.qty : ''), good_qty: '', reject_qty: '', rework_qty: '', labour_minutes: '',
    labour_rate: s.labour_rate_per_min ? String(s.labour_rate_per_min) : '', reason: '', remarks: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const num = (x: unknown) => (x === '' || x == null ? null : Number(x));
  const labourAmt = (Number(v.labour_minutes) || 0) * (Number(v.labour_rate) || 0);
  const save = async () => {
    setBusy(true);
    try {
      const body: any = { row_version: s.row_version, reason: v.reason || null, remarks: v.remarks || null };
      if (['start', 'reassign'].includes(action)) Object.assign(body, { department_id: num(v.department_id), assigned_user_id: num(v.assigned_user_id), assigned_contractor_id: num(v.assigned_contractor_id) });
      if (action === 'reassign') body.planned_date = v.planned_date || null;
      if (action === 'start') body.input_qty = num(v.input_qty);
      if (action === 'complete') Object.assign(body, { input_qty: num(v.input_qty), good_qty: num(v.good_qty), reject_qty: num(v.reject_qty), rework_qty: num(v.rework_qty), labour_minutes: num(v.labour_minutes), labour_rate: num(v.labour_rate) });
      const r = await http.post<{ data: any }>(`/samples/${s.id}/processes/${p.id}/${action}`, body);
      toast(`${p.stage_name}: ${ACTION_TITLE[action].toLowerCase()} done${r.data.cost_id ? ' — labour cost entered for approval' : ''}`);
      onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const needReason = ['hold', 'skip', 'reopen'].includes(action);
  return (
    <Modal open onClose={onClose} title={`${ACTION_TITLE[action]} — ${p.stage_name}`} subtitle={`${s.sample_no} · ${Number(p.is_mandatory) ? 'mandatory' : 'optional'} stage`} size="md"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <Button loading={busy} id="proc-save" disabled={needReason && v.reason.trim().length < 3} onClick={() => void save()}>{ACTION_TITLE[action]}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2" id="proc-form">
        {['start', 'reassign'].includes(action) && <>
          <Select label="Department" placeholder="—" options={toOptions(depts.data)} value={v.department_id} onChange={(e) => set('department_id', e.target.value)} />
          <Select label="Employee" id="proc-user" placeholder="—" options={toOptions(users.data)} value={v.assigned_user_id} onChange={(e) => set('assigned_user_id', e.target.value)} />
          <Select label="Contractor / job worker" id="proc-contractor" placeholder="—" options={toOptions(contractors.data)} value={v.assigned_contractor_id} onChange={(e) => set('assigned_contractor_id', e.target.value)}
            hint={action === 'start' ? 'Name the employee or the contractor' : undefined} />
        </>}
        {action === 'reassign' && <Input label="Planned date" type="date" value={v.planned_date} onChange={(e) => set('planned_date', e.target.value)} />}
        {(action === 'start' || action === 'complete') && Number(p.needs_output) ? <Input label="Input qty" type="number" min={0} value={v.input_qty} onChange={(e) => set('input_qty', e.target.value)} /> : null}
        {action === 'complete' && <>
          {Number(p.needs_output) ? <>
            <Input label="Good qty" required type="number" min={0} id="proc-good" value={v.good_qty} onChange={(e) => set('good_qty', e.target.value)} />
            <Input label="Reject qty" type="number" min={0} value={v.reject_qty} onChange={(e) => set('reject_qty', e.target.value)} />
            <Input label="Rework qty" type="number" min={0} value={v.rework_qty} onChange={(e) => set('rework_qty', e.target.value)} />
          </> : null}
          <Input label="Labour minutes" type="number" min={0} id="proc-minutes" value={v.labour_minutes} onChange={(e) => set('labour_minutes', e.target.value)} />
          <Input label="Rate ₹ / minute" type="number" min={0} step="0.01" value={v.labour_rate} disabled={!can('SAMPLE.COST')} onChange={(e) => set('labour_rate', e.target.value)}
            hint={labourAmt > 0 ? `Labour cost ₹ ${labourAmt.toFixed(2)} goes to the cost ledger for approval` : 'Minutes × approved rate = labour cost'} />
        </>}
        {needReason && <Textarea className="sm:col-span-2" label="Reason" required id="proc-reason" value={v.reason} onChange={(e) => set('reason', e.target.value)} />}
        {['resume', 'reassign'].includes(action) && <Input className="sm:col-span-2" label="Note" value={v.reason} onChange={(e) => set('reason', e.target.value)} />}
        {['start', 'complete'].includes(action) && <Textarea className="sm:col-span-2" label="Remarks / handover note" value={v.remarks} onChange={(e) => set('remarks', e.target.value)} />}
      </div>
    </Modal>
  );
}

/* ================================================================ QC & buyer */
function QcBuyer({ s, openQc }: { s: any; openQc: () => void }) {
  const { can } = useAuth();
  const canQc = can('SAMPLE.QC') && !['DRAFT', 'COMPLETED', 'CANCELLED'].includes(s.status);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="QC inspections" actions={canQc && <Button size="sm" id="qc-new" onClick={openQc}><Plus size={13} />Record QC</Button>} className="lg:col-span-2">
        <div className="overflow-x-auto">
          <table className="w-full" id="qc-list">
            <thead><tr><th className="th">Date · rev</th><th className="th">Stage</th><th className="th text-right">Checked · pass · rej · rw</th><th className="th">Measurements</th><th className="th">Defects</th><th className="th">Result</th><th className="th">Remarks / by</th></tr></thead>
            <tbody>
              {!s.qc_inspections.length && <tr><td className="td py-6 text-center text-slate-400" colSpan={7}>No inspection yet</td></tr>}
              {s.qc_inspections.map((q: any) => {
                const defects = typeof q.defects === 'string' ? JSON.parse(q.defects) : q.defects;
                return (
                  <tr key={q.id} className="align-top">
                    <td className="td text-[12px]">{fmtDate(q.inspection_date)}<p className="text-slate-400">rev {q.revision_no}</p></td>
                    <td className="td text-[12px]">{q.stage_name ?? '—'}</td>
                    <td className="td text-right text-[12px] tabular-nums">{fmtNumber(q.checked_qty)} · {fmtNumber(q.passed_qty)} · {fmtNumber(q.rejected_qty)} · {fmtNumber(q.rework_qty)}</td>
                    <td className="td text-[12px]">{String(q.measurement_result).replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="td text-[12px]">{defects?.length ? defects.map((d: any, i: number) => <p key={i}>{d.defect_name} <span className="text-slate-400">({d.severity.toLowerCase()} × {d.qty})</span></p>) : '—'}</td>
                    <td className="td"><Badge tone={q.result === 'PASS' ? 'green' : 'red'}>{q.result}</Badge><p className="mt-0.5 text-[11px] text-slate-500">{q.disposition.toLowerCase()}{q.rework_stage_name ? ` → ${q.rework_stage_name}` : ''}</p></td>
                    <td className="td max-w-[220px] text-[12px] text-slate-600">{q.remarks}<p className="text-[11px] text-slate-400">{q.inspected_by_name}</p></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Buyer submissions">
        <div className="p-3 text-[12.5px]" id="submission-list">
          {!s.submissions.length && <p className="py-4 text-center text-slate-400">Not sent yet</p>}
          {s.submissions.map((x: any) => (
            <div key={x.id} className="border-b border-slate-100 py-1.5 last:border-0">
              <p><b>{fmtDate(x.submission_date)}</b> · rev {x.revision_no} · {fmtNumber(x.qty)} pcs {x.courier_name ? `· ${x.courier_name}` : ''} {x.tracking_no ? `#${x.tracking_no}` : ''}</p>
              <p className="text-[11px] text-slate-500">{x.sent_to ? `to ${x.sent_to} · ` : ''}{x.remarks ?? ''} {x.recorded_by_name}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Decisions">
        <div className="p-3 text-[12.5px]" id="decision-list">
          {!s.decisions.length && <p className="py-4 text-center text-slate-400">No decision yet</p>}
          {s.decisions.map((x: any) => (
            <div key={x.id} className="border-b border-slate-100 py-1.5 last:border-0">
              <p><Badge tone={x.decision === 'APPROVED' ? 'green' : x.decision === 'REJECTED' ? 'red' : 'amber'}>{x.stage === 'BUYER' ? 'Buyer' : 'Internal'} · {x.decision.replace(/_/g, ' ').toLowerCase()}</Badge>
                <span className="ml-2">{fmtDate(x.decision_date)} · rev {x.revision_no}</span></p>
              {x.comments && <p className="mt-0.5 text-slate-600">{x.comments}</p>}
              <p className="text-[11px] text-slate-400">{x.decided_by_name}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Revisions" className="lg:col-span-2">
        <div className="p-3 text-[12.5px]">
          {s.revisions.map((r: any) => (
            <p key={r.id} className="border-b border-slate-100 py-1.5 last:border-0"><b>{r.revision_no === 0 ? 'First build' : `Revision ${r.revision_no}`}</b> · {r.revision_type.toLowerCase()} · <Badge tone="slate">{r.status.toLowerCase()}</Badge>
              <span className="ml-2 text-slate-500">{fmtDateTime(r.requested_at)} {r.requested_by_name}</span>{r.comments && <span className="block text-slate-600">{r.comments}</span>}</p>
          ))}
        </div>
      </Card>
    </div>
  );
}

function DecisionModal({ s, stage, busy, onClose, onSave }: { s: any; stage: 'INTERNAL' | 'BUYER'; busy: boolean; onClose: () => void; onSave: (b: any) => void }) {
  const [v, setV] = useState({ decision: 'APPROVED', decision_date: today(), comments: '' });
  const needComments = v.decision !== 'APPROVED';
  return (
    <Modal open onClose={onClose} title={stage === 'BUYER' ? 'Buyer response' : 'Internal approval'} subtitle={`${s.sample_no} · revision ${s.revision_no}`} size="md"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><Button loading={busy} id="decision-save" disabled={needComments && v.comments.trim().length < 3} onClick={() => onSave(v)}>Record</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2" id="decision-form">
        <Select label="Decision" id="decision-pick" value={v.decision} onChange={(e) => setV({ ...v, decision: e.target.value })} options={[
          { value: 'APPROVED', label: stage === 'BUYER' ? 'Approved by buyer' : 'Approved — ready to send' },
          { value: 'CHANGES_REQUESTED', label: 'Changes requested (revision)' }, { value: 'REJECTED', label: 'Rejected' }]} />
        <Input label="Date" type="date" value={v.decision_date} onChange={(e) => setV({ ...v, decision_date: e.target.value })} />
        <Textarea className="sm:col-span-2" label={stage === 'BUYER' ? 'Buyer comments' : 'Comments'} required={needComments} id="decision-comments" value={v.comments} onChange={(e) => setV({ ...v, comments: e.target.value })} />
      </div>
      {stage === 'INTERNAL' && s.last_qc_result === 'FAIL' && <p className="mt-2 text-[12px] text-red-600">The latest QC inspection failed — approval needs a passing inspection.</p>}
    </Modal>
  );
}

function SubmissionModal({ s, busy, onClose, onSave }: { s: any; busy: boolean; onClose: () => void; onSave: (b: any) => void }) {
  const [v, setV] = useState({ submission_date: today(), qty: String(s.good_qty ?? s.qty), courier_name: '', tracking_no: '', sent_to: '', remarks: '' });
  return (
    <Modal open onClose={onClose} title="Submit to buyer" subtitle={`${s.sample_no} · revision ${s.revision_no}`} size="md"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><Button loading={busy} id="submission-save" disabled={!(Number(v.qty) > 0)} onClick={() => onSave({ ...v, qty: Number(v.qty) })}>Record dispatch</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2" id="submission-form">
        <Input label="Date" type="date" required value={v.submission_date} onChange={(e) => setV({ ...v, submission_date: e.target.value })} />
        <Input label="Quantity" type="number" min={1} required value={v.qty} onChange={(e) => setV({ ...v, qty: e.target.value })} />
        <Input label="Courier" value={v.courier_name} onChange={(e) => setV({ ...v, courier_name: e.target.value })} />
        <Input label="Tracking / AWB" id="submission-awb" value={v.tracking_no} onChange={(e) => setV({ ...v, tracking_no: e.target.value })} />
        <Input className="sm:col-span-2" label="Sent to (buyer contact / office)" value={v.sent_to} onChange={(e) => setV({ ...v, sent_to: e.target.value })} />
        <Textarea className="sm:col-span-2" label="Remarks" value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} />
      </div>
      <p className="mt-2 text-[11.5px] text-slate-500">Courier cost: enter it in Costing (category Courier) or import the courier bill booked to this sample.</p>
    </Modal>
  );
}

function RevisionModal({ s, busy, onClose, onSave }: { s: any; busy: boolean; onClose: () => void; onSave: (b: any) => void }) {
  const types = useQuery({ queryKey: ['sample-type-versions', s.sample_type_id], queryFn: async () => (await http.get<{ data: any[] }>(`/sample-types/${s.sample_type_id}/versions`)).data, enabled: !!s.sample_type_id });
  const wf = types.data?.find((w) => Number(w.id) === Number(s.workflow_id));
  const [picked, setPicked] = useState<number[] | null>(null);
  const stages = wf?.stages ?? [];
  const sel = picked ?? stages.map((x: any) => Number(x.id));
  const lastDecision = s.decisions[0];
  const [v, setV] = useState({ comments: lastDecision?.comments ?? '', revision_type: lastDecision?.stage === 'INTERNAL' ? 'INTERNAL' : 'BUYER', target_date: '' });
  return (
    <Modal open onClose={onClose} title={`Start revision ${Number(s.revision_no) + 1}`} subtitle="Earlier stages, costs, QC and comments stay as history" size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <Button loading={busy} id="revision-save" disabled={v.comments.trim().length < 3 || !sel.length} onClick={() => onSave({ ...v, target_date: v.target_date || null, stage_ids: sel })}>Start revision</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2" id="revision-form">
        <Select label="Asked by" value={v.revision_type} onChange={(e) => setV({ ...v, revision_type: e.target.value })} options={[{ value: 'BUYER', label: 'Buyer' }, { value: 'INTERNAL', label: 'Internal review' }]} />
        <Input label="New target date" type="date" value={v.target_date} onChange={(e) => setV({ ...v, target_date: e.target.value })} hint="Leave blank to keep the target" />
        <Textarea className="sm:col-span-2" label="What has to change" required id="revision-comments" value={v.comments} onChange={(e) => setV({ ...v, comments: e.target.value })} />
      </div>
      <p className="mb-1 mt-3 text-[12px] font-semibold text-slate-600">Stages to redo (workflow v{wf?.version_no ?? '—'})</p>
      {types.isLoading ? <LoadingBlock rows={2} /> : (
        <div className="grid gap-1 sm:grid-cols-2">
          {stages.map((x: any) => (
            <label key={x.id} className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={sel.includes(Number(x.id))} onChange={(e) => setPicked(e.target.checked ? [...sel, Number(x.id)] : sel.filter((y) => y !== Number(x.id)))} />
              {x.stage_name}{!Number(x.is_mandatory) && <span className="text-[11px] text-slate-400">optional</span>}
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

function QcModal({ s, busy, onClose, onSave }: { s: any; busy: boolean; onClose: () => void; onSave: (b: any) => void }) {
  const defectsLk = useLookup('defects');
  const procs = s.processes.filter((p: any) => Number(p.revision_no) === Number(s.revision_no) && p.status !== 'CANCELLED');
  const qcStage = procs.find((p: any) => p.stage_code === 'QC');
  const [v, setV] = useState<any>({ inspection_date: today(), process_id: qcStage?.id ?? '', checked_qty: String(s.good_qty ?? s.qty), passed_qty: String(s.good_qty ?? s.qty), rejected_qty: '0', rework_qty: '0',
    measurement_result: 'OK', disposition: 'ACCEPT', rework_of_process_id: '', remarks: '' });
  const [defects, setDefects] = useState<any[]>([]);
  const [meas, setMeas] = useState<any[]>([]);
  const set = (k: string, x: unknown) => setV((o: any) => ({ ...o, [k]: x }));
  const sumOk = Number(v.passed_qty || 0) + Number(v.rejected_qty || 0) + Number(v.rework_qty || 0) <= Number(v.checked_qty || 0);
  const save = () => onSave({
    ...v, process_id: Number(v.process_id) || null, rework_of_process_id: Number(v.rework_of_process_id) || null,
    checked_qty: Number(v.checked_qty), passed_qty: Number(v.passed_qty || 0), rejected_qty: Number(v.rejected_qty || 0), rework_qty: Number(v.rework_qty || 0),
    defects: defects.filter((d) => d.defect_name).map((d) => ({ ...d, defect_id: Number(d.defect_id) || null, qty: Number(d.qty) || 1 })),
    measurements: meas.filter((x) => x.point).map((x) => ({ ...x, ok: x.ok !== false })),
  });
  return (
    <Modal open onClose={onClose} title="QC inspection" subtitle={`${s.sample_no} · revision ${s.revision_no}`} size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><Button loading={busy} id="qc-save" disabled={!sumOk || !(Number(v.checked_qty) > 0) || (v.disposition === 'REWORK' && !v.rework_of_process_id)} onClick={save}>Save inspection</Button></>}>
      <div className="grid gap-3 sm:grid-cols-4" id="qc-form">
        <Input label="Date" type="date" value={v.inspection_date} onChange={(e) => set('inspection_date', e.target.value)} />
        <Select label="At stage" placeholder="—" options={procs.map((p: any) => ({ value: p.id, label: p.stage_name }))} value={v.process_id} onChange={(e) => set('process_id', e.target.value)} />
        <Input label="Checked" type="number" min={0} required value={v.checked_qty} onChange={(e) => set('checked_qty', e.target.value)} />
        <Input label="Passed" type="number" min={0} id="qc-passed" value={v.passed_qty} onChange={(e) => set('passed_qty', e.target.value)} />
        <Input label="Rejected" type="number" min={0} value={v.rejected_qty} onChange={(e) => set('rejected_qty', e.target.value)} />
        <Input label="Rework" type="number" min={0} value={v.rework_qty} onChange={(e) => set('rework_qty', e.target.value)} error={sumOk ? undefined : 'More than checked'} />
        <Select label="Measurements" value={v.measurement_result} onChange={(e) => set('measurement_result', e.target.value)} options={[{ value: 'OK', label: 'Within tolerance' }, { value: 'OUT_OF_TOLERANCE', label: 'Out of tolerance' }, { value: 'NOT_CHECKED', label: 'Not checked' }]} />
        <Select label="Disposition" id="qc-disposition" value={v.disposition} onChange={(e) => set('disposition', e.target.value)} options={[{ value: 'ACCEPT', label: 'Accept (pass)' }, { value: 'REWORK', label: 'Rework' }, { value: 'REJECT', label: 'Reject' }]} />
        {v.disposition === 'REWORK' && <Select className="sm:col-span-2" label="Stage to rework" required id="qc-rework-stage" placeholder="— Select —" options={procs.filter((p: any) => p.status === 'COMPLETED').map((p: any) => ({ value: p.id, label: p.stage_name }))} value={v.rework_of_process_id} onChange={(e) => set('rework_of_process_id', e.target.value)} hint="A rework stage is added after the last stage" />}
        <Textarea className="sm:col-span-4" label="Remarks" value={v.remarks} onChange={(e) => set('remarks', e.target.value)} />
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between"><p className="text-[12px] font-semibold text-slate-600">Defects</p><button className="text-[12px] text-brand-700" onClick={() => setDefects([...defects, { defect_id: '', defect_name: '', severity: 'MINOR', qty: 1 }])}>+ add</button></div>
          {defects.map((d, i) => (
            <div key={i} className="mb-1 grid grid-cols-[1fr_90px_60px_20px] gap-1">
              <select className="input h-8 py-0 text-[12px]" value={d.defect_id} onChange={(e) => { const x = (defectsLk.data ?? []).find((y) => String(y.id) === e.target.value) as any; const n = [...defects]; n[i] = { ...d, defect_id: e.target.value, defect_name: x?.label ?? '', severity: x?.defect_type ?? d.severity }; setDefects(n); }}>
                <option value="">— defect —</option>{(defectsLk.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
              <select className="input h-8 py-0 text-[12px]" value={d.severity} onChange={(e) => { const n = [...defects]; n[i] = { ...d, severity: e.target.value }; setDefects(n); }}>{['CRITICAL', 'MAJOR', 'MINOR'].map((x) => <option key={x}>{x}</option>)}</select>
              <input className="input h-8 py-0 text-[12px]" type="number" min={0} value={d.qty} onChange={(e) => { const n = [...defects]; n[i] = { ...d, qty: e.target.value }; setDefects(n); }} />
              <button className="text-red-500" onClick={() => setDefects(defects.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between"><p className="text-[12px] font-semibold text-slate-600">Measurements</p><button className="text-[12px] text-brand-700" onClick={() => setMeas([...meas, { point: '', spec: '', actual: '', tolerance: '', ok: true }])}>+ add</button></div>
          {meas.map((x, i) => (
            <div key={i} className="mb-1 grid grid-cols-[1fr_60px_60px_60px_24px_20px] gap-1">
              {(['point', 'spec', 'actual', 'tolerance'] as const).map((k) => <input key={k} className="input h-8 py-0 text-[12px]" placeholder={k} value={x[k]} onChange={(e) => { const n = [...meas]; n[i] = { ...x, [k]: e.target.value }; setMeas(n); }} />)}
              <input type="checkbox" title="Within tolerance" checked={x.ok !== false} onChange={(e) => { const n = [...meas]; n[i] = { ...x, ok: e.target.checked }; setMeas(n); }} />
              <button className="text-red-500" onClick={() => setMeas(meas.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ================================================================ timeline */
function Timeline({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['sample-audit', id], queryFn: async () => http.get<{ data: any[]; process_log: any[] }>(`/samples/${id}/audit`) });
  if (q.isLoading) return <div className="card"><LoadingBlock rows={6} /></div>;
  const rows = [...(q.data?.data ?? []).map((a) => ({ ...a, kind: 'sample' })), ...(q.data?.process_log ?? []).map((l) => ({ ...l, kind: 'stage' }))]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const show = (v: any) => { if (v == null) return ''; const o = typeof v === 'string' ? JSON.parse(v) : v; return Object.entries(o).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(x) ? x.join(', ') : typeof x === 'object' && x ? JSON.stringify(x) : STATUS_LABEL[String(x)] ?? x}`).join(' · '); };
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" id="sample-timeline">
        <thead><tr><th className="th">When</th><th className="th">Who</th><th className="th">What</th><th className="th">Details</th><th className="th">Reason</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.kind}-${r.id}`} className="align-top">
              <td className="td whitespace-nowrap text-[12px]">{fmtDateTime(r.created_at)}</td>
              <td className="td text-[12px]">{r.user_name ?? '—'}</td>
              <td className="td text-[12px]">{r.kind === 'stage' ? <><Badge tone="blue">Stage</Badge> {r.stage_name}: {r.action.toLowerCase()}</> : <><Badge tone="slate">{r.entity.toLowerCase()}</Badge> {r.action.replace(/_/g, ' ').toLowerCase()}</>}</td>
              <td className="td max-w-[420px] text-[12px] text-slate-600">{r.kind === 'stage' ? `${r.from_status ?? ''} → ${r.to_status ?? ''}${r.good_qty != null ? ` · good ${r.good_qty}` : ''}${r.minutes ? ` · ${r.minutes} min` : ''}` : <>{r.old_values && <span className="text-slate-400">{show(r.old_values)} → </span>}{show(r.new_values)}</>}</td>
              <td className="td max-w-[260px] text-[12px] text-slate-600">{r.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

