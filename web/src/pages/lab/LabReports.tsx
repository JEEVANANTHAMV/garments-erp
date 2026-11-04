import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { PageHeader, Card, Button, Input, Select, Textarea, Checkbox, Badge, Modal, LoadingBlock, ErrorState, EmptyState, SearchInput, useDebounced } from '../../components/ui';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { LabStatus, ResultBadge, ReasonModal, KV, errMsg, label, opts, num, openBlob, saveBlob, newKey, useLabJobs } from './labShared';

/** Lab reports & dual approval (spec §5, §6, §9): register + Excel export, Lab In-charge / QA queues with the approval
 *  panel, and the report viewer (A4-like snapshot, revisions, approval history, PDF, release, revise, production reference). */

const REPORT_STATUSES = ['PENDING_LAB', 'PENDING_QA', 'APPROVED', 'RELEASED', 'RETURNED', 'REJECTED', 'RETEST_REQUIRED', 'SUPERSEDED'];

export function LabReportsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const buyers = useLookup('buyers');
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const f = { status: sp.get('status') ?? '', buyer_id: sp.get('buyer_id') ?? '', result: sp.get('result') ?? '', from: sp.get('from') ?? '', to: sp.get('to') ?? '', latest: sp.get('latest') ?? '' };
  const setF = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), q: dq || undefined };
  const list = useQuery({ queryKey: ['lab-reports', params], queryFn: async () => (await http.get<{ data: any[] }>('/lab/reports', params)).data });
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <PageHeader title="Lab reports" breadcrumb={['Lab']} subtitle="Report revisions — only a dual-approved, released revision is a production reference"
        actions={<Button id="lab-report-export" variant="secondary" loading={busy} onClick={async () => { setBusy(true); try { await saveBlob('/lab/reports/export', params); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); } }}><Download size={15} />Excel</Button>} />
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <SearchInput className="w-64" value={q} onChange={setQ} placeholder="Report, request, style, buyer, trial…" />
        <Select label="Status" className="w-48" placeholder="All" options={opts(REPORT_STATUSES)} value={f.status} onChange={(e) => setF('status', e.target.value)} />
        <Select label="Buyer" className="w-48" placeholder="All buyers" options={toOptions(buyers.data)} value={f.buyer_id} onChange={(e) => setF('buyer_id', e.target.value)} />
        <Select label="Result" className="w-36" placeholder="Any" options={opts(['PASS', 'FAIL', 'CONDITIONAL'])} value={f.result} onChange={(e) => setF('result', e.target.value)} />
        <Input label="From" type="date" className="w-40" value={f.from} onChange={(e) => setF('from', e.target.value)} />
        <Input label="To" type="date" className="w-40" value={f.to} onChange={(e) => setF('to', e.target.value)} />
        <div className="pb-2"><Checkbox label="Latest revision only" checked={f.latest === '1'} onChange={(v) => setF('latest', v ? '1' : '')} /></div>
      </div>
      <ReportTable rows={list.data} loading={list.isLoading} error={list.error} onOpen={(r) => nav(`/lab/reports/${r.id}`)} id="lab-report-list" />
    </div>
  );
}

function ReportTable({ rows, loading, error, onOpen, id, ageing }: { rows?: any[]; loading: boolean; error: unknown; onOpen: (r: any) => void; id: string; ageing?: boolean }) {
  return (
    <div className="card overflow-x-auto">
      {loading ? <LoadingBlock /> : error ? <ErrorState error={error} /> : (
        <table className="w-full" id={id}>
          <thead><tr><th className="th">Report</th><th className="th">Request / trial</th><th className="th">Buyer / style</th><th className="th">Prepared</th><th className="th">Lab In-charge</th><th className="th">QA</th>
            {ageing && <th className="th text-right">Age (days)</th>}<th className="th">Result</th><th className="th">Status</th></tr></thead>
          <tbody>
            {(rows ?? []).length === 0 && <tr><td colSpan={ageing ? 9 : 8} className="td text-center text-ink-muted">Nothing here</td></tr>}
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="row-hover cursor-pointer" onClick={() => onOpen(r)}>
                <td className="td"><Link className="font-semibold text-brand-700 hover:underline" to={`/lab/reports/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.report_no} rev {r.revision_no}</Link></td>
                <td className="td text-small">{r.request_no} · {r.trial_no}{r.priority === 'URGENT' ? <Badge tone="red" className="ml-1">Urgent</Badge> : null}</td>
                <td className="td text-small">{r.buyer_name ?? '—'} · {r.style_code ?? '—'}{r.color_name ? ` · ${r.color_name}` : ''}</td>
                <td className="td text-small">{fmtDateTime(r.prepared_at)}<p className="text-ink-secondary">{r.prepared_by_name}</p></td>
                <td className="td text-small">{r.lab_approved_at ? <>{fmtDateTime(r.lab_approved_at)}<p className="text-ink-secondary">{r.lab_approved_by_name}</p></> : '—'}</td>
                <td className="td text-small">{r.qa_approved_at ? <>{fmtDateTime(r.qa_approved_at)}<p className="text-ink-secondary">{r.qa_approved_by_name}</p></> : '—'}</td>
                {ageing && <td className={`td text-right tabular-nums ${r.age_days > 3 ? 'font-semibold text-red-600' : ''}`}>{r.age_days}</td>}
                <td className="td"><ResultBadge value={r.overall_result} /></td><td className="td"><LabStatus value={r.report_status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ================================================================ approval queues */
export function LabReviewQueuePage({ level }: { level: 'LAB' | 'QA' }) {
  const list = useQuery({ queryKey: ['lab-reports', 'queue', level], queryFn: async () => (await http.get<{ data: any[] }>('/lab/reports', { queue: level === 'LAB' ? 'lab' : 'qa' })).data, refetchInterval: 60_000 });
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div>
      <PageHeader title={level === 'LAB' ? 'Lab In-charge review' : 'QA Manager approval'} breadcrumb={['Lab']}
        subtitle={level === 'LAB' ? 'Check recipe, data, calculations, evidence and method — approve to QA, return, reject or ask for a retest'
          : 'Independent final review and buyer / spec compliance — approve, return to lab, reject or ask for a retest'} />
      <ReportTable rows={list.data} loading={list.isLoading} error={list.error} onOpen={(r) => setSel(Number(r.id))} id={level === 'LAB' ? 'lab-review-list' : 'lab-qa-list'} ageing />
      {sel && <ApprovalDrawer id={sel} level={level} onClose={() => setSel(null)} onDone={() => { setSel(null); void list.refetch(); }} />}
    </div>
  );
}

function ApprovalDrawer({ id, level, onClose, onDone }: { id: number; level: 'LAB' | 'QA'; onClose: () => void; onDone: () => void }) {
  const q = useQuery({ queryKey: ['lab-report', id], queryFn: async () => (await http.get<{ data: any }>(`/lab/reports/${id}`)).data });
  return (
    <Modal open onClose={onClose} size="full" title={q.data ? `${q.data.report_no} rev ${q.data.revision_no} — ${level === 'LAB' ? 'lab review' : 'QA approval'}` : 'Loading…'}
      subtitle={q.data ? `${q.data.request_no} · ${q.data.trial_no} · ${q.data.buyer_name ?? '—'} · ${q.data.style_code ?? '—'}` : undefined}>
      {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} /> : <ApprovalPanel r={q.data} level={level} onDone={onDone} />}
    </Modal>
  );
}

/** Criteria vs observed values side by side, then the decision with mandatory remarks where applicable. */
export function ApprovalPanel({ r, level, onDone }: { r: any; level: 'LAB' | 'QA'; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const s = r.snapshot;
  const [remarks, setRemarks] = useState('');
  const [override, setOverride] = useState(false);
  const [cond, setCond] = useState({ conditional_reason: '', conditional_scope: '', conditional_expiry: '' });
  const [busy, setBusy] = useState(''); const [err, setErr] = useState('');
  const [key] = useState(newKey());
  const pending = r.report_status === (level === 'LAB' ? 'PENDING_LAB' : 'PENDING_QA');
  const allowed = can(level === 'LAB' ? 'LAB.APPROVE' : 'LAB.QA_APPROVE');
  const decide = async (decision: string) => {
    if (['RETURN', 'REJECT', 'RETEST', 'CONDITIONAL'].includes(decision) && !remarks.trim()) { setErr('Remarks are required for this decision'); return; }
    setBusy(decision); setErr('');
    try {
      const body: Record<string, unknown> = { decision, remarks: remarks || null, report_revision: r.revision_no, override, idempotency_key: `${key}-${decision}` };
      if (decision === 'CONDITIONAL') Object.assign(body, cond);
      const res = await http.post<{ data: any }>(`/lab/reports/${r.id}/${level === 'LAB' ? 'lab-approve' : 'qa-approve'}`, body);
      void qc.invalidateQueries({ queryKey: ['lab-report', r.id] }); void qc.invalidateQueries({ queryKey: ['lab-reports'] });
      toast(`${label(decision)} recorded${res.data.new_trial ? ` — retest ${res.data.new_trial.trial_no} created` : ''}`);
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? `Not allowed: ${e.message}` : errMsg(e));
    } finally { setBusy(''); }
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KV k="Overall result" v={<ResultBadge value={r.overall_result} />} /><KV k="Prepared by" v={`${s.prepared_by_name ?? '—'} · ${fmtDateTime(r.prepared_at)}`} />
        <KV k="Lab In-charge" v={r.lab_approved_by_name ? `${r.lab_approved_by_name} · ${fmtDateTime(r.lab_approved_at)}` : null} /><KV k="Snapshot" v={String(r.snapshot_hash).slice(0, 16)} />
      </div>
      <Card title="Criteria vs observed">
        <div className="overflow-x-auto"><table className="w-full min-w-[900px]" id="lab-approval-results">
          <thead><tr><th className="th">Test</th><th className="th">Method</th><th className="th">Acceptance</th><th className="th">Readings</th><th className="th text-right">Observed</th><th className="th">Status</th></tr></thead>
          <tbody>{(s.results ?? []).map((x: any) => (
            <tr key={x.parameter_id} className="align-top">
              <td className="td"><p className="font-medium">{x.name}</p><p className="text-caption text-ink-secondary">{x.is_mandatory ? 'Mandatory' : 'Optional'}{x.result_source === 'EXTERNAL' ? ` · external ${x.external_lab_name} cert ${x.certificate_no}` : ''}</p></td>
              <td className="td text-small">{x.method_code ?? '—'}</td><td className="td text-small">{x.criteria_text} {x.unit ?? ''}</td>
              <td className="td text-small text-ink-secondary">{(x.readings ?? []).map((g: any) => `${g.reading_stage === 'SINGLE' ? '' : g.reading_stage[0]}${g.reading_no} ${g.text_value ?? num(g.numeric_value, 3)}`).join(' · ')}</td>
              <td className="td text-right font-semibold tabular-nums">{x.display_value ?? '—'} {x.display_value ? x.unit ?? '' : ''}</td>
              <td className="td"><ResultBadge value={x.evaluation_status} override={x.is_override} />{x.is_override && <p className="text-caption text-amber-700">{x.override_reason}</p>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recipe summary">
          <div className="space-y-1 p-4 text-small">
            <p>{s.trial.wash_process_name ?? s.trial.wash_process_code ?? '—'} · {s.trial.machine ? `${s.trial.machine.machine_code}` : 'no machine'} · load {num(s.trial.load_weight_kg, 3) || '—'} kg · L:R {s.trial.liquor_ratio != null ? `1:${num(s.trial.liquor_ratio)}` : '—'} · {num(s.trial.total_duration_min)} min</p>
            {(s.stages ?? []).map((x: any) => <p key={x.stage_no}>#{x.stage_no} {x.process_code}: {num(x.target_temp)}/{num(x.actual_temp)} °C · {num(x.target_duration_min)}/{num(x.actual_duration_min)} min</p>)}
            {(s.chemicals ?? []).map((c: any, i: number) => <p key={i} className="text-ink-secondary">{c.chemical_name} {num(c.target_dosage, 4)}/{num(c.actual_dosage, 4)} {String(c.dosage_uom).toLowerCase()}</p>)}
            {(s.deviations ?? []).map((d: any, i: number) => <p key={i} className="text-amber-700">Deviation: {label(d.deviation_type)} {d.target_value}→{d.actual_value} — {d.reason}</p>)}
          </div>
        </Card>
        <Card title="Evidence">
          <ul className="p-4 text-small">{(s.attachments ?? []).length === 0 ? <li className="text-ink-muted">No files</li> : s.attachments.map((a: any) => (
            <li key={a.id}><button type="button" className="text-brand-700 hover:underline" onClick={() => void openBlob(`/lab/attachments/${a.id}/file`, { inline: 1 }).catch((e) => toast(errMsg(e), 'error'))}>{a.original_name}</button> <span className="text-ink-secondary">{label(a.attachment_type)}</span></li>
          ))}</ul>
        </Card>
      </div>
      {pending && allowed ? (
        <Card title={level === 'LAB' ? 'Lab In-charge decision' : 'QA Manager decision'}>
          <div className="space-y-3 p-4">
            <Textarea id="lab-approval-remarks" label="Remarks (required to return / reject / retest)" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            {level === 'QA' && can('LAB.OVERRIDE') && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Input label="Conditional — reason" value={cond.conditional_reason} onChange={(e) => setCond({ ...cond, conditional_reason: e.target.value })} />
                <Input label="Conditional — scope" value={cond.conditional_scope} onChange={(e) => setCond({ ...cond, conditional_scope: e.target.value })} />
                <Input label="Conditional — expiry" type="date" value={cond.conditional_expiry} onChange={(e) => setCond({ ...cond, conditional_expiry: e.target.value })} />
              </div>
            )}
            {can('LAB.OVERRIDE') && <Checkbox label="Emergency maker-checker override (audited; explain in remarks)" checked={override} onChange={setOverride} />}
            {err && <p id="lab-approval-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-small text-red-700">{err}</p>}
            <div className="flex flex-wrap gap-2">
              <Button id={level === 'LAB' ? 'lab-lab-approve' : 'lab-qa-approve'} loading={busy === 'APPROVE'} onClick={() => void decide('APPROVE')}>{level === 'LAB' ? 'Approve to QA' : 'Final approve'}</Button>
              {level === 'QA' && can('LAB.OVERRIDE') && <Button variant="secondary" loading={busy === 'CONDITIONAL'} onClick={() => void decide('CONDITIONAL')}>Conditional approval</Button>}
              <Button id="lab-approval-return" variant="secondary" loading={busy === 'RETURN'} onClick={() => void decide('RETURN')}>{level === 'LAB' ? 'Return for correction' : 'Return to lab'}</Button>
              <Button id="lab-approval-retest" variant="secondary" loading={busy === 'RETEST'} onClick={() => void decide('RETEST')}>Retest</Button>
              <Button id="lab-approval-reject" variant="danger" loading={busy === 'REJECT'} onClick={() => void decide('REJECT')}>Reject</Button>
            </div>
          </div>
        </Card>
      ) : <p className="text-small text-ink-secondary">{pending ? 'You do not hold the approval permission for this step.' : `No ${level === 'LAB' ? 'lab' : 'QA'} decision is pending (${label(r.report_status)}).`}</p>}
    </div>
  );
}

/* ================================================================ viewer */
export function LabReportViewerPage() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lab-report', id], queryFn: async () => (await http.get<{ data: any }>(`/lab/reports/${id}`)).data });
  const [modal, setModal] = useState<'' | 'revise' | 'prodref' | 'approve' | 'revoke'>('');
  const [revokeId, setRevokeId] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const r = q.data;
  if (q.isLoading) return <div className="card"><LoadingBlock /></div>;
  if (q.error || !r) return <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['lab-report', id] }); void qc.invalidateQueries({ queryKey: ['lab-reports'] }); };
  const valid = ['APPROVED', 'RELEASED'].includes(r.report_status);
  const pdf = async (download: boolean) => {
    setBusy(download ? 'dl' : 'pdf');
    try { if (download) await saveBlob(`/lab/reports/${id}/pdf`, { download: 1 }); else await openBlob(`/lab/reports/${id}/pdf`); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(''); }
  };
  const release = async () => {
    setBusy('release');
    try { await http.post(`/lab/reports/${id}/release`, { idempotency_key: newKey() }); refresh(); toast('Report released'); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(''); }
  };
  const level = r.report_status === 'PENDING_LAB' ? 'LAB' : r.report_status === 'PENDING_QA' ? 'QA' : null;
  return (
    <div>
      <PageHeader title={<span className="flex flex-wrap items-center gap-2">{r.report_no} rev {r.revision_no} <LabStatus value={r.report_status} /><ResultBadge value={r.overall_result} /></span>}
        breadcrumb={['Lab', 'Reports']}
        subtitle={<>Request <Link className="text-brand-700 hover:underline" to={`/lab/requests/${r.request_id}`}>{r.request_no}</Link> · trial <Link className="text-brand-700 hover:underline" to={`/lab/trials/${r.trial_id}`}>{r.trial_no}</Link></>}
        actions={<>
          <Button id="lab-report-pdf" variant="secondary" loading={busy === 'pdf'} onClick={() => void pdf(false)}><FileText size={15} />PDF</Button>
          <Button variant="secondary" loading={busy === 'dl'} onClick={() => void pdf(true)}><Download size={15} />Download</Button>
          {level && <Button id="lab-report-decide" onClick={() => setModal('approve')}>{level === 'LAB' ? 'Lab review' : 'QA approval'}</Button>}
          {r.report_status === 'APPROVED' && can('LAB.QA_APPROVE') && <Button id="lab-release" loading={busy === 'release'} onClick={() => void release()}>Release</Button>}
          {valid && can('LAB.QA_APPROVE') && <Button variant="secondary" onClick={() => setModal('prodref')}>Link to production</Button>}
          {valid && can('LAB.UPDATE') && !r.open_revision_trial && r.revisions[r.revisions.length - 1]?.id === r.id && <Button variant="secondary" onClick={() => setModal('revise')}>Revise</Button>}
        </>} />
      {r.open_revision_trial && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-small text-amber-800">Being revised in <Link className="font-semibold hover:underline" to={`/lab/trials/${r.open_revision_trial.id}`}>{r.open_revision_trial.trial_no}</Link> ({label(r.open_revision_trial.status)})</p>}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2"><ReportSheet r={r} /></div>
        <div className="space-y-4">
          <Card title="Revisions">
            <ul className="divide-y divide-surface-divider" id="lab-report-revisions">{r.revisions.map((x: any) => (
              <li key={x.id} className="flex items-center justify-between px-4 py-2 text-small">
                <span>{x.id === r.id ? <b>Rev {x.revision_no}</b> : <Link className="text-brand-700 hover:underline" to={`/lab/reports/${x.id}`}>Rev {x.revision_no}</Link>}{x.revision_reason ? <span className="text-ink-secondary"> · {x.revision_reason}</span> : null}</span>
                <LabStatus value={x.report_status} />
              </li>
            ))}</ul>
          </Card>
          <Card title="Approval history">
            <ul className="divide-y divide-surface-divider" id="lab-report-approvals">
              {r.approvals.length === 0 && <li className="px-4 py-2 text-small text-ink-muted">No decision yet</li>}
              {r.approvals.map((a: any) => (
                <li key={a.id} className="px-4 py-2 text-small">
                  <p><b>{a.approval_level === 'LAB' ? 'Lab In-charge' : a.approval_level === 'QA' ? 'QA Manager' : 'Release'}</b> · {label(a.decision)} · rev {a.report_revision}{Number(a.override_used) ? <Badge tone="amber" className="ml-1">override</Badge> : null}</p>
                  <p className="text-ink-secondary">{a.approver_name} · {fmtDateTime(a.decided_at)}</p>{a.remarks && <p>{a.remarks}</p>}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Production references">
            <ul className="divide-y divide-surface-divider" id="lab-report-prodrefs">
              {r.production_refs.length === 0 && <li className="px-4 py-2 text-small text-ink-muted">Not linked to production</li>}
              {r.production_refs.map((p: any) => (
                <li key={p.id} className="px-4 py-2 text-small">
                  <p><b>{p.job_no ?? '—'}</b> · {p.style_code ?? '—'}{p.color_name ? ` · ${p.color_name}` : ''}{p.fabric_lot ? ` · lot ${p.fabric_lot}` : ''} <LabStatus value={p.status} /></p>
                  <p className="text-ink-secondary">Valid {p.valid_from ? fmtDate(p.valid_from) : 'now'} → {p.valid_to ? fmtDate(p.valid_to) : 'open'}{p.acknowledged_at ? ` · acknowledged by ${p.acknowledged_by_name} ${fmtDateTime(p.acknowledged_at)}` : ''}</p>
                  {p.status === 'ACTIVE' && <div className="mt-1 flex gap-3">
                    {!p.acknowledged_at && <button type="button" className="text-brand-700 hover:underline" onClick={async () => { try { await http.post(`/lab/production-references/${p.id}/acknowledge`); refresh(); toast('Acknowledged'); } catch (e) { toast(errMsg(e), 'error'); } }}>Acknowledge</button>}
                    {can('LAB.QA_APPROVE') && <button type="button" className="text-red-600 hover:underline" onClick={() => { setRevokeId(p.id); setModal('revoke'); }}>Revoke</button>}
                  </div>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      {modal === 'approve' && level && (
        <Modal open onClose={() => setModal('')} size="full" title={`${r.report_no} rev ${r.revision_no} — ${level === 'LAB' ? 'lab review' : 'QA approval'}`}>
          <ApprovalPanel r={r} level={level} onDone={() => { setModal(''); refresh(); }} />
        </Modal>
      )}
      <ReasonModal open={modal === 'revise'} title={`Revise ${r.report_no} rev ${r.revision_no}`} subtitle="Creates a new trial copying the approved recipe and readings; submitting it makes the next revision. The approved snapshot is never edited." confirm="Create revision trial"
        onClose={() => setModal('')} onSubmit={async (reason) => { const d = await http.post<{ data: any }>(`/lab/reports/${id}/revise`, { reason }); toast(`${d.data.trial_no} created`); nav(`/lab/trials/${d.data.trial_id}`); }} />
      <ReasonModal open={modal === 'revoke'} title="Revoke production reference" danger confirm="Revoke" onClose={() => setModal('')}
        onSubmit={async (reason) => { await http.post(`/lab/production-references/${revokeId}/revoke`, { reason }); refresh(); }} />
      {modal === 'prodref' && <ProdRefModal r={r} onClose={() => setModal('')} onDone={() => { refresh(); toast('Linked to production'); }} />}
    </div>
  );
}

function ProdRefModal({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const jobs = useLabJobs(); const colors = useLookup('colors');
  const s = r.snapshot.request;
  const [v, setV] = useState({ so_id: s.so_id ? String(s.so_id) : '', style_id: s.style_id ? String(s.style_id) : '', color_id: s.color_id ? String(s.color_id) : '', fabric_lot: s.fabric_lot ?? '',
    process_code: r.snapshot.trial.wash_process_code ?? '', valid_from: '', valid_to: '', remarks: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const job = (jobs.data ?? []).find((j) => String(j.id) === v.so_id);
  const go = async () => {
    setBusy(true); setErr('');
    try {
      await http.post(`/lab/reports/${r.id}/production-reference`, { so_id: v.so_id || null, style_id: v.style_id || null, color_id: v.color_id || null, fabric_lot: v.fabric_lot || null,
        process_code: v.process_code || null, valid_from: v.valid_from || null, valid_to: v.valid_to || null, remarks: v.remarks || null });
      onDone(); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Link report to production" subtitle="A controlled read-only reference — production confirms the actual bulk recipe"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void go()}>Link</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Order (I/O)" placeholder="—" className="sm:col-span-2" options={(jobs.data ?? []).map((j) => ({ value: j.id, label: j.label }))} value={v.so_id} onChange={(e) => setV({ ...v, so_id: e.target.value, style_id: '' })} />
        <Select label="Style" placeholder="—" options={(job?.styles ?? []).map((x) => ({ value: x.style_id, label: x.style_code })).concat(!job && s.style_id ? [{ value: s.style_id, label: s.style_code }] : [])} value={v.style_id} onChange={(e) => setV({ ...v, style_id: e.target.value })} />
        <Select label="Colour" placeholder="—" options={toOptions(colors.data)} value={v.color_id} onChange={(e) => setV({ ...v, color_id: e.target.value })} />
        <Input label="Fabric lot" value={v.fabric_lot} onChange={(e) => setV({ ...v, fabric_lot: e.target.value })} />
        <Input label="Process" value={v.process_code} onChange={(e) => setV({ ...v, process_code: e.target.value })} />
        <Input label="Valid from" type="date" value={v.valid_from} onChange={(e) => setV({ ...v, valid_from: e.target.value })} />
        <Input label="Valid to" type="date" value={v.valid_to} onChange={(e) => setV({ ...v, valid_to: e.target.value })} />
        <Textarea label="Remarks" className="sm:col-span-2" value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} error={err || undefined} />
      </div>
    </Modal>
  );
}

/** The frozen snapshot rendered as an A4-like sheet (the PDF has the same sections). */
function ReportSheet({ r }: { r: any }) {
  const s = r.snapshot; const q = s.request; const t = s.trial;
  const valid = ['APPROVED', 'RELEASED'].includes(r.report_status);
  if (!s) return <EmptyState title="No snapshot" />;
  const row = (k: string, v: unknown) => <div className="flex gap-2 py-0.5 text-small"><span className="w-36 shrink-0 text-ink-muted">{k}</span><span className="min-w-0 text-ink">{v === null || v === undefined || v === '' ? '—' : String(v)}</span></div>;
  return (
    <div id="lab-report-sheet" className="mx-auto max-w-[210mm] rounded-lg border border-surface-border bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink pb-2">
        <div><p className="text-title font-semibold">{s.company?.name}</p><p className="text-caption text-ink-secondary">{s.company?.address}</p></div>
        <div className="text-right text-small"><p className="text-title font-semibold">LAB TEST REPORT</p><p>{r.report_no} · Rev {r.revision_no}</p><p>Issue {fmtDate(r.released_at ?? r.qa_approved_at ?? r.prepared_at)}</p></div>
      </div>
      {!valid && <p className="mt-2 rounded bg-amber-50 py-1 text-center text-small font-semibold text-amber-800">UNAPPROVED DRAFT — NOT VALID FOR BULK PRODUCTION</p>}
      <h4 className="mt-4 border-b border-surface-border text-small font-semibold uppercase text-ink-secondary">Reference</h4>
      <div className="grid gap-x-6 sm:grid-cols-2">
        {row('Buyer', q.buyer_name)}{row('Buyer PO', q.buyer_po_no)}{row('Order (I/O)', q.job_no)}{row('Style', [q.style_code, q.style_name].filter(Boolean).join(' — '))}
        {row('Colour', q.color_name)}{row('Fabric', q.fabric_name)}{row('Composition / GSM', [q.composition, q.gsm ? `${q.gsm} GSM` : ''].filter(Boolean).join(' · '))}{row('Lot', q.fabric_lot)}
        {row('Lab request', q.request_no)}{row('Sample ID(s)', (s.samples ?? []).map((x: any) => x.sample_no).join(', '))}{row('Trial', `${t.trial_no} · ${label(t.trial_type)} · recipe rev ${t.recipe_revision}`)}
        {row('Test date', `${fmtDate(t.started_at)}${t.completed_at ? ` → ${fmtDate(t.completed_at)}` : ''}`)}{row('Test plan', s.plan ? `${s.plan.plan_code} v${s.plan.version_no}` : '')}
      </div>
      <h4 className="mt-4 border-b border-surface-border text-small font-semibold uppercase text-ink-secondary">Process</h4>
      <div className="grid gap-x-6 sm:grid-cols-2">
        {row('Wash type', t.wash_process_name ?? t.wash_process_code)}{row('Machine', t.machine ? `${t.machine.machine_code} — ${t.machine.name}` : '')}
        {row('Load / water', `${num(t.load_weight_kg, 3) || '—'} kg / ${num(t.water_qty_l) || '—'} L`)}{row('Liquor ratio', t.liquor_ratio != null ? `1 : ${num(t.liquor_ratio)}` : '')}
        {row('Total time', `${num(t.total_duration_min)} min`)}{row('Drying', [t.drying_method, t.drying_temp != null ? `${t.drying_temp} °C` : '', t.drying_duration_min != null ? `${t.drying_duration_min} min` : ''].filter(Boolean).join(' · '))}
      </div>
      {(s.stages ?? []).length > 0 && <table className="mt-2 w-full text-small"><thead><tr><th className="th">#</th><th className="th">Stage</th><th className="th text-right">Temp T/A</th><th className="th text-right">Time T/A</th><th className="th text-right">pH</th></tr></thead>
        <tbody>{s.stages.map((x: any) => <tr key={x.stage_no}><td className="td">{x.stage_no}</td><td className="td">{x.process_code}</td><td className="td text-right">{num(x.target_temp)} / {num(x.actual_temp)}</td><td className="td text-right">{num(x.target_duration_min)} / {num(x.actual_duration_min)}</td><td className="td text-right">{num(x.ph_start)} / {num(x.ph_end)}</td></tr>)}</tbody></table>}
      {(s.chemicals ?? []).length > 0 && <table className="mt-2 w-full text-small"><thead><tr><th className="th">Chemical</th><th className="th">Lot</th><th className="th text-right">Target</th><th className="th text-right">Actual</th><th className="th">Unit</th></tr></thead>
        <tbody>{s.chemicals.map((c: any, i: number) => <tr key={i}><td className="td">{c.chemical_name}</td><td className="td">{c.chemical_lot ?? ''}</td><td className="td text-right">{num(c.target_dosage, 4)}</td><td className="td text-right">{num(c.actual_dosage, 4)}</td><td className="td">{label(c.dosage_uom)}</td></tr>)}</tbody></table>}
      <h4 className="mt-4 border-b border-surface-border text-small font-semibold uppercase text-ink-secondary">Results</h4>
      <div className="overflow-x-auto"><table className="w-full text-small" id="lab-report-results">
        <thead><tr><th className="th">Test</th><th className="th">Method</th><th className="th">Acceptance</th><th className="th text-right">Before</th><th className="th text-right">After</th><th className="th text-right">Result</th><th className="th">Status</th></tr></thead>
        <tbody>{(s.results ?? []).map((x: any) => (
          <tr key={x.parameter_id}><td className="td">{x.name}</td><td className="td">{x.method_code ?? ''}</td><td className="td">{x.criteria_text} {x.unit ?? ''}</td>
            <td className="td text-right tabular-nums">{x.raw_before != null ? num(x.raw_before, 3) : ''}</td><td className="td text-right tabular-nums">{x.raw_after != null ? num(x.raw_after, 3) : ''}</td>
            <td className="td text-right font-semibold tabular-nums">{x.display_value ?? '—'}</td><td className="td"><ResultBadge value={x.evaluation_status} override={x.is_override} /></td></tr>
        ))}</tbody>
      </table></div>
      <h4 className="mt-4 border-b border-surface-border text-small font-semibold uppercase text-ink-secondary">Disposition</h4>
      <p className="mt-1 text-body font-semibold">Overall: {r.overall_result ?? '—'}{r.disposition ? ` · ${label(r.disposition)}` : ''}</p>
      {r.disposition === 'CONDITIONAL' && <p className="text-small text-amber-800">Conditional: {r.conditional_reason} · scope {r.conditional_scope} · until {fmtDate(r.conditional_expiry)}</p>}
      {r.recommendation && <p className="text-small">Recommendation: {r.recommendation}</p>}
      <h4 className="mt-4 border-b border-surface-border text-small font-semibold uppercase text-ink-secondary">Approvals</h4>
      {row('Prepared by', `${s.prepared_by_name ?? '—'} · ${fmtDateTime(s.submitted_at)}`)}
      {row('Lab In-charge', r.lab_approved_by_name ? `${r.lab_approved_by_name} · ${fmtDateTime(r.lab_approved_at)}` : 'Pending')}
      {row('QA Manager', r.qa_approved_by_name ? `${r.qa_approved_by_name} · ${fmtDateTime(r.qa_approved_at)}` : 'Pending')}
    </div>
  );
}
