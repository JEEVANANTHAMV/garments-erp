import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, Send, CheckCircle2, XCircle, Ban, Trash2, PackageMinus } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Textarea, Modal, DataTable, FormSection } from '../../../components/ui';
import { api } from '../../../lib/api';
import { fmtDate, fmtDateTime } from '../../../lib/format';
import { useToast } from '../../../hooks/useToast';
import { useLookup } from '../../../hooks/useLookup';
import { type Kind, BASE, LABEL, ST_TONE, errMsg, num, human, money, rate4, qty, pctTxt, usePerm, useGet, Kv, MiniTable } from './shared';
import { MaterialDialog } from './Material';

/** Titled block inside a popup — the shared popup section style (FormSection heading), one column. */
function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return <FormSection title={title} actions={actions} cols={1}><div className="min-w-0">{children}</div></FormSection>;
}

/** Production entries list (machine output by date / shift / machine). */
export function ProductionTab({ kind, onOpen }: { kind: Kind; onOpen: (o: { id?: number; jobId?: number }) => void }) {
  const p = usePerm(kind);
  const machines = useGet<any[]>(`${BASE[kind]}/machines`);
  const [f, setF] = useState({ status: '', from: '', to: '', machine_id: '', q: '' });
  const list = useGet<any[]>(`${BASE[kind]}/production`, { status: f.status || undefined, from: f.from || undefined, to: f.to || undefined, machine_id: f.machine_id || undefined, q: f.q || undefined });
  return (
    <Card title={`${LABEL[kind]} production entries`} subtitle="Machine timing, output and consumption per shift — Draft → Submitted → Approved (costing frozen) / Rejected"
      actions={<div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => void list.reload()}>Refresh</Button>
        {(p.create || p.submit) && <Button size="sm" id="mp-prod-new" onClick={() => onOpen({})}><Plus size={13} className="mr-1 inline" />New entry</Button>}
      </div>}>
      <div className="flex flex-wrap items-end gap-3 p-3">
        <Select label="Status" className="w-36" value={f.status} placeholder="All" onChange={(e) => setF({ ...f, status: e.target.value })} options={['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => ({ value: s, label: human(s) }))} />
        <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Select label="Machine" className="w-40" value={f.machine_id} placeholder="All" onChange={(e) => setF({ ...f, machine_id: e.target.value })} options={(machines.data ?? []).map((m: any) => ({ value: m.id, label: m.machine_code }))} />
        <Input label="Search" placeholder="Entry / job / IO / operator" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <DataTable data={list.data ?? []} loading={list.loading} emptyTitle="No production entries" onRowClick={(r: any) => onOpen({ id: r.id })}
        columns={[
          { key: 'production_no', header: 'Entry', render: (r: any) => <span className="tabular-nums font-semibold text-brand-700">{r.production_no}</span> },
          { key: 'prod_date', header: 'Date / shift', render: (r: any) => `${fmtDate(r.prod_date)} ${r.shift_code ?? ''}` },
          { key: 'machine_code', header: 'Machine', render: (r: any) => `${r.machine_code}${kind === 'EMBROIDERY' ? ` · ${r.heads_used}h` : ''}` },
          { key: 'job_no', header: 'Job', render: (r: any) => <span>{r.job_no}<span className="text-ink-muted"> · {r.io_no ?? ''} {r.style_code ?? ''}</span></span> },
          { key: 'time', header: 'Time', render: (r: any) => `${String(r.start_at).slice(11)}–${String(r.end_at).slice(11)}` },
          { key: 'out', header: 'Input / good / rej / rwk', align: 'right' as const, render: (r: any) => `${qty(r.input_qty)} / ${qty(r.good_qty)} / ${qty(r.reject_qty)} / ${qty(r.rework_qty)}` },
          { key: 'net_run_hours', header: 'Run h', align: 'right' as const, render: (r: any) => qty(r.net_run_hours) },
          { key: 'output_per_hour', header: 'Output / h', align: 'right' as const, render: (r: any) => qty(r.output_per_hour, 1) },
          { key: 'efficiency_pct', header: 'Eff.', align: 'right' as const, render: (r: any) => pctTxt(r.efficiency_pct) },
          ...(p.costing ? [{ key: 'cost_per_unit', header: '₹ / good pc', align: 'right' as const, render: (r: any) => money(r.cost_per_unit) }] : []),
          { key: 'operator_name', header: 'Operator' },
          { key: 'status', header: 'Status', render: (r: any) => <span className="flex items-center gap-1"><Badge tone={ST_TONE[r.status]}>{human(r.status)}</Badge>{r.over_plan ? <Badge tone="amber">over plan</Badge> : null}{r.rework_of_id ? <Badge tone="violet">rework</Badge> : null}</span> },
        ]} />
    </Card>
  );
}

type Row = Record<string, any>;
const blankForm = (jobId?: number) => ({
  prod_date: new Date().toISOString().slice(0, 10), shift_id: '', job_id: jobId ? String(jobId) : '', machine_id: '', heads_used: '1',
  operator_name: '', helper_name: '', operator_count: '1', helper_count: '0', start_at: '', end_at: '', break_minutes: '0', setup_minutes: '0',
  input_qty: '', good_qty: '', reject_qty: '0', rework_qty: '0', adjustment_reason: '', output_uom: '', good_weight_kg: '', total_stitches: '',
  other_cost: '0', other_cost_reason: '', rework_of_id: '', remarks: '',
  outputs: [] as Row[], downtime: [] as Row[], counter_ids: [] as number[],
});

/** Production entry — header, machine, output, material and cost panels (doc §21 / §19), server-calculated. */
export function ProductionForm({ kind, id: id0, jobId, onClose }: { kind: Kind; id?: number; jobId?: number; onClose: () => void }) {
  const toast = useToast();
  const p = usePerm(kind);
  const shifts = useLookup('shifts');
  const machines = useGet<any[]>(`${BASE[kind]}/machines`, { active: '1' });
  const reasons = useGet<any[]>(`${BASE[kind]}/reasons`, { active: '1' });
  const jobs = useGet<any[]>(`${BASE[kind]}/jobs`, { status: 'OPEN' });
  const [id, setId] = useState<number | undefined>(id0);
  const [entry, setEntry] = useState<any>(null);
  const [f, setF] = useState<any>(blankForm(jobId));
  const [over, setOver] = useState<Record<string, { actual_qty: string; wastage_qty: string }>>({});
  const [job, setJob] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [pErr, setPErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mat, setMat] = useState(false);
  const set = (x: any) => setF((cur: any) => ({ ...cur, ...x }));

  const load = async (eid: number) => {
    const r = await api.get(`${BASE[kind]}/production/${eid}`);
    const e = r.data.data;
    setEntry(e);
    setF({
      prod_date: e.prod_date, shift_id: String(e.shift_id), job_id: String(e.job_id), machine_id: String(e.machine_id), heads_used: String(e.heads_used),
      operator_name: e.operator_name ?? '', helper_name: e.helper_name ?? '', operator_count: String(num(e.operator_count)), helper_count: String(num(e.helper_count)),
      start_at: e.start_at, end_at: e.end_at, break_minutes: String(e.break_minutes), setup_minutes: String(e.setup_minutes),
      input_qty: String(num(e.input_qty)), good_qty: String(num(e.good_qty)), reject_qty: String(num(e.reject_qty)), rework_qty: String(num(e.rework_qty)),
      adjustment_reason: e.adjustment_reason ?? '', output_uom: e.output_uom ?? '', good_weight_kg: e.good_weight_kg != null ? String(num(e.good_weight_kg)) : '',
      total_stitches: e.stitches_source && e.stitches_source !== 'DESIGN' && e.total_stitches != null ? String(e.total_stitches) : '',
      other_cost: String(num(e.other_cost)), other_cost_reason: e.other_cost_reason ?? '', rework_of_id: e.rework_of_id ? String(e.rework_of_id) : '', remarks: e.remarks ?? '',
      outputs: e.outputs.map((o: any) => ({ output_type: o.output_type, reason_id: String(o.reason_id), qty: String(num(o.qty)), remarks: o.remarks ?? '' })),
      downtime: e.downtime.map((d: any) => ({ reason_id: String(d.reason_id), start_at: d.start_at ?? '', end_at: d.end_at ?? '', minutes: String(d.minutes), remarks: d.remarks ?? '' })),
      counter_ids: (e.counters ?? []).map((c: any) => c.id),
    });
    // actuals typed earlier (different from the standard) stay as entered
    const o: Record<string, any> = {};
    for (const c of e.consumption) if (Math.abs(num(c.actual_qty) - num(c.standard_qty)) > 1e-6 || num(c.wastage_qty) > 0) o[c.trim_id] = { actual_qty: String(num(c.actual_qty)), wastage_qty: String(num(c.wastage_qty)) };
    setOver(o);
  };
  useEffect(() => { if (id) void load(id).catch((e) => { toast(errMsg(e), 'error'); onClose(); }); }, [id]);
  useEffect(() => {
    if (!f.job_id) { setJob(null); return; }
    void api.get(`${BASE[kind]}/jobs/${f.job_id}`).then((r) => {
      const j = r.data.data;
      setJob(j);
      if (!id) setF((cur: any) => ({ ...cur, machine_id: cur.machine_id || (j.machine_id ? String(j.machine_id) : ''), output_uom: cur.output_uom || j.uom }));
    }).catch(() => setJob(null));
  }, [f.job_id, kind]);
  // shift times fill the start / end of a new entry
  const pickShift = (sid: string) => {
    const s = (shifts.data ?? []).find((x: any) => String(x.id) === sid) as any;
    const x: any = { shift_id: sid };
    if (s && !f.start_at && s.start_time) x.start_at = `${f.prod_date}T${String(s.start_time).slice(0, 5)}`;
    if (s && !f.end_at && s.end_time) {
      const crosses = String(s.end_time) < String(s.start_time);
      const d = new Date(`${f.prod_date}T00:00:00Z`); if (crosses) d.setUTCDate(d.getUTCDate() + 1);
      x.end_at = `${d.toISOString().slice(0, 10)}T${String(s.end_time).slice(0, 5)}`;
    }
    set(x);
  };

  const status = entry?.status ?? 'NEW';
  const ro = ['APPROVED', 'CANCELLED'].includes(status) || (status === 'SUBMITTED' && !p.submit) || !(p.create || p.submit);
  const body = useMemo(() => ({
    prod_date: f.prod_date, shift_id: num(f.shift_id), job_id: num(f.job_id), machine_id: num(f.machine_id), heads_used: num(f.heads_used) || 1,
    operator_name: f.operator_name || null, helper_name: f.helper_name || null, operator_count: num(f.operator_count), helper_count: num(f.helper_count),
    start_at: f.start_at, end_at: f.end_at, break_minutes: num(f.break_minutes), setup_minutes: num(f.setup_minutes),
    input_qty: num(f.input_qty), good_qty: num(f.good_qty), reject_qty: num(f.reject_qty), rework_qty: num(f.rework_qty),
    adjustment_reason: f.adjustment_reason || null, output_uom: f.output_uom || null, good_weight_kg: f.good_weight_kg === '' ? null : num(f.good_weight_kg),
    total_stitches: f.total_stitches === '' ? null : num(f.total_stitches), counter_ids: f.counter_ids,
    other_cost: num(f.other_cost), other_cost_reason: f.other_cost_reason || null, rework_of_id: f.rework_of_id ? num(f.rework_of_id) : null, remarks: f.remarks || null,
    outputs: f.outputs.filter((o: Row) => num(o.qty) > 0).map((o: Row) => ({ output_type: o.output_type, reason_id: num(o.reason_id), qty: num(o.qty), remarks: o.remarks || null })),
    downtime: f.downtime.filter((d: Row) => d.reason_id).map((d: Row) => (d.start_at && d.end_at
      ? { reason_id: num(d.reason_id), start_at: d.start_at, end_at: d.end_at, remarks: d.remarks || null }
      : { reason_id: num(d.reason_id), minutes: num(d.minutes), remarks: d.remarks || null })),
    consumption: Object.entries(over).filter(([, v]) => v.actual_qty !== '').map(([k, v]) => ({ trim_id: Number(k), actual_qty: num(v.actual_qty), wastage_qty: num(v.wastage_qty) })),
  }), [f, over]);

  // live server calculation (never computed in the browser)
  const seq = useRef(0);
  useEffect(() => {
    if (ro && entry) return;
    if (!body.job_id || !body.machine_id || !body.shift_id || !body.start_at || !body.end_at || !(body.input_qty > 0)) { setPreview(null); setPErr(null); return; }
    const my = ++seq.current;
    const t = setTimeout(() => {
      api.post(`${BASE[kind]}/production/preview`, body, { params: { id } }).then((r) => { if (my === seq.current) { setPreview(r.data.data); setPErr(null); } })
        .catch((e) => { if (my === seq.current) { setPErr(errMsg(e)); } });
    }, 500);
    return () => clearTimeout(t);
  }, [JSON.stringify(body), ro, id]);

  const shown = ro && entry ? { consumption: entry.consumption, cost: entry.costing, adjustment_qty: entry.adjustment_qty, total_stitches: entry.total_stitches, stitches_source: entry.stitches_source, downtime_minutes: entry.downtime_minutes } : preview;
  const c = shown?.cost;
  const adj = num(f.input_qty) - num(f.good_qty) - num(f.reject_qty) - num(f.rework_qty);

  const save = async (andSubmit: boolean) => {
    setBusy(true);
    try {
      let eid = id;
      if (!eid) {
        const r = await api.post(`${BASE[kind]}/production`, body, { params: andSubmit ? { submit: 1 } : {} });
        eid = r.data.data.id; setId(eid);
        toast(`${r.data.data.production_no} ${andSubmit ? 'submitted for approval' : 'saved as draft'}`);
      } else {
        await api.put(`${BASE[kind]}/production/${eid}`, body);
        if (andSubmit) await api.post(`${BASE[kind]}/production/${eid}/submit`);
        toast(andSubmit ? 'Submitted for approval' : 'Saved');
      }
      await load(eid!);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const action = async (path: string, payload: any, msg: string) => {
    setBusy(true);
    try { await api.post(`${BASE[kind]}/production/${id}/${path}`, payload); toast(msg); await load(id!); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const approve = async () => {
    let over_plan_reason: string | null = null;
    if (entry?.over_plan) { over_plan_reason = window.prompt('Output is above the job plan + tolerance — give the over-plan reason:'); if (!over_plan_reason) return; }
    await action('approve', { over_plan_reason }, 'Approved — costing frozen');
  };
  const reject = async () => { const remarks = window.prompt('Reason for rejecting this entry:'); if (remarks) await action('reject', { remarks }, 'Rejected — back to the floor for correction'); };
  const cancel = async () => { const reason = window.prompt(status === 'APPROVED' ? 'Reverse (cancel) this approved entry — reason:' : 'Cancel this entry — reason:'); if (reason) await action('cancel', { reason }, 'Entry cancelled'); };

  const dtReasons = (reasons.data ?? []).filter((r: any) => r.reason_type === 'DOWNTIME');
  const rjReasons = (reasons.data ?? []).filter((r: any) => r.reason_type === 'REJECT');
  const machine = (machines.data ?? []).find((m: any) => String(m.id) === String(f.machine_id));
  const reworkSources = (job?.productions ?? []).filter((x: any) => x.status === 'APPROVED' && num(x.rework_qty) > 0 && String(x.id) !== String(id));
  const jobOpts = [...(jobs.data ?? []).filter((j: any) => ['PLANNED', 'RUNNING'].includes(j.status))];
  if (job && !jobOpts.some((j) => j.id === job.id)) jobOpts.push(job);

  return (
    <Modal open size="full" onClose={onClose} title={entry ? `${LABEL[kind]} production ${entry.production_no}` : `New ${LABEL[kind].toLowerCase()} production entry`}
      subtitle="Machine output for one shift — standard consumption and cost are calculated by the server"
      footerStart={entry ? <span className="flex items-center gap-2 text-xs"><Badge tone={ST_TONE[status]}>{human(status)}</Badge>{entry.over_plan ? <Badge tone="amber">over plan</Badge> : null}</span> : undefined}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {p.store && entry && ['DRAFT', 'SUBMITTED', 'REJECTED'].includes(status) && <Button variant="secondary" onClick={() => setMat(true)}><PackageMinus size={13} className="mr-1 inline" />Issue material</Button>}
        {!ro && <Button variant="secondary" loading={busy} id="mp-prod-save" onClick={() => save(false)}><Save size={13} className="mr-1 inline" />{status === 'SUBMITTED' ? 'Save changes' : 'Save draft'}</Button>}
        {status === 'SUBMITTED' && p.approve && <Button variant="secondary" loading={busy} id="mp-prod-reject" onClick={reject}><XCircle size={13} className="mr-1 inline" />Reject</Button>}
        {entry && !['CANCELLED'].includes(status) && (status === 'APPROVED' ? p.approve : status === 'SUBMITTED' ? p.submit : (p.create || p.submit)) &&
          <Button variant="danger" loading={busy} id="mp-prod-cancel" onClick={cancel}><Ban size={13} className="mr-1 inline" />{status === 'APPROVED' ? 'Reverse' : 'Cancel entry'}</Button>}
        {!ro && p.submit && status !== 'SUBMITTED' && <Button loading={busy} id="mp-prod-submit" onClick={() => save(true)}><Send size={13} className="mr-1 inline" />Save & submit</Button>}
        {status === 'SUBMITTED' && p.approve && <Button loading={busy} id="mp-prod-approve" onClick={approve}><CheckCircle2 size={13} className="mr-1 inline" />Approve</Button>}
      </>}>
      <div className="space-y-4">
        {entry?.status === 'REJECTED' && <p className="rounded-lg bg-red-50 p-2 text-xs text-red-700">Rejected by {entry.rejected_by_name}: {entry.reject_remarks} — correct and save; it goes back to draft.</p>}
        {entry?.status === 'CANCELLED' && <p className="rounded-lg bg-surface-header p-2 text-xs text-ink">Cancelled by {entry.cancelled_by_name}: {entry.cancel_reason}</p>}
        {/* Header + job context box */}
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-3">
        <FormSection title="Entry" cols={4} className="xl:col-span-2">
          <Input label="Date" type="date" disabled={ro} value={f.prod_date} onChange={(e) => set({ prod_date: e.target.value })} />
          <Select label="Shift" required id="mp-prod-shift" disabled={ro} value={f.shift_id} placeholder="— shift —" onChange={(e) => pickShift(e.target.value)}
            options={(shifts.data ?? []).map((s: any) => ({ value: s.id, label: `${s.code} · ${s.label}` }))} />
          <Select label="Job" required id="mp-prod-job" className="sm:col-span-2" disabled={ro || !!entry} value={f.job_id} placeholder="— planned / running job —" onChange={(e) => set({ job_id: e.target.value })}
            options={jobOpts.map((j: any) => ({ value: j.id, label: `${j.job_no} · ${j.io_no ?? ''} ${j.style_code ?? ''} · ${qty(j.planned_qty)} ${j.uom ?? ''}` }))} />
        </FormSection>
          <div className="rounded-lg bg-surface-muted p-2 text-caption text-ink-secondary">
            {job ? <>
              {[job.buyer_name, job.io_no, job.style_code, job.color_name].some(Boolean) && <div><b>{[job.buyer_name, job.io_no, job.style_code, job.color_name].filter(Boolean).join(' · ')}</b></div>}
              <div>{kind === 'EMBROIDERY' ? 'Design' : 'Artwork'} {job.design_code ? `${job.design_code} v${job.design_version}` : '—'}{job.placement ? ` · ${job.placement}` : ''}{job.stitches_per_pc ? ` · ${qty(job.stitches_per_pc, 0)} st/pc` : ''}</div>
              <div>Done {qty(job.output?.input)} / {qty(job.planned_qty)} {job.uom} · balance {qty(job.output?.balance_to_produce)}</div>
            </> : 'Pick the job'}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Machine">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
              <Select label="Machine" required id="mp-prod-machine" className={kind === 'PRINTING' ? 'col-span-2' : undefined} disabled={ro} value={f.machine_id} placeholder="— machine —" onChange={(e) => set({ machine_id: e.target.value })}
                options={(machines.data ?? []).map((m: any) => ({ value: m.id, label: `${m.machine_code}${kind === 'EMBROIDERY' ? ` · ${m.head_count} heads` : ''}` }))} />
              {kind === 'EMBROIDERY' && <Input label={`Heads used${machine ? ` (of ${machine.head_count})` : ''}`} type="number" id="mp-prod-heads" disabled={ro} value={f.heads_used} onChange={(e) => set({ heads_used: e.target.value })} />}
              <Input label="Operator" id="mp-prod-operator" disabled={ro} value={f.operator_name} onChange={(e) => set({ operator_name: e.target.value })} />
              <Input label="Helper" disabled={ro} value={f.helper_name} onChange={(e) => set({ helper_name: e.target.value })} />
              <Input label="Operators (no.)" type="number" disabled={ro} value={f.operator_count} onChange={(e) => set({ operator_count: e.target.value })} />
              <Input label="Helpers (no.)" type="number" disabled={ro} value={f.helper_count} onChange={(e) => set({ helper_count: e.target.value })} />
              <Input label="Start" type="datetime-local" required id="mp-prod-start" disabled={ro} value={f.start_at} onChange={(e) => set({ start_at: e.target.value })} />
              <Input label="End" type="datetime-local" required id="mp-prod-end" disabled={ro} value={f.end_at} onChange={(e) => set({ end_at: e.target.value })} />
              <Input label="Break (min)" type="number" id="mp-prod-break" disabled={ro} value={f.break_minutes} onChange={(e) => set({ break_minutes: e.target.value })} />
              <Input label={kind === 'EMBROIDERY' ? 'Setup / hooping (min)' : 'Setup (min)'} type="number" id="mp-prod-setup" disabled={ro} value={f.setup_minutes} onChange={(e) => set({ setup_minutes: e.target.value })} />
            </div>
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between"><span className="text-xs font-semibold text-ink-secondary">Downtime {shown?.downtime_minutes ? `· ${shown.downtime_minutes} min` : ''}</span>
                {!ro && <Button size="sm" variant="secondary" id="mp-prod-add-dt" onClick={() => set({ downtime: [...f.downtime, { reason_id: '', start_at: '', end_at: '', minutes: '', remarks: '' }] })}><Plus size={12} className="mr-1 inline" />Downtime</Button>}</div>
              {f.downtime.map((d: Row, i: number) => {
                const upd = (x: any) => set({ downtime: f.downtime.map((y: Row, j: number) => (j === i ? { ...y, ...x } : y)) });
                return (
                  <div key={i} className="mb-1 flex flex-wrap items-center gap-1">
                    <select className="input h-8 w-48" id={`mp-prod-dt-${i}-reason`} disabled={ro} value={d.reason_id} onChange={(e) => upd({ reason_id: e.target.value })}>
                      <option value="">— reason —</option>{dtReasons.map((r: any) => <option key={r.id} value={r.id}>{r.reason_code} · {r.reason_name}</option>)}</select>
                    <input className="input h-8 w-44" type="datetime-local" title="Start (optional)" disabled={ro} value={d.start_at} onChange={(e) => upd({ start_at: e.target.value })} />
                    <input className="input h-8 w-44" type="datetime-local" title="End (optional)" disabled={ro} value={d.end_at} onChange={(e) => upd({ end_at: e.target.value })} />
                    <input className="input h-8 w-20" type="number" placeholder="min" id={`mp-prod-dt-${i}-min`} disabled={ro || !!(d.start_at && d.end_at)} value={d.minutes} onChange={(e) => upd({ minutes: e.target.value })} />
                    <input className="input h-8 w-40" placeholder="remarks" disabled={ro} value={d.remarks} onChange={(e) => upd({ remarks: e.target.value })} />
                    {!ro && <button className="text-red-500" onClick={() => set({ downtime: f.downtime.filter((_: Row, j: number) => j !== i) })}><Trash2 size={13} /></button>}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="Output">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
              <Input label="Input qty" type="number" required id="mp-prod-input" disabled={ro} value={f.input_qty} onChange={(e) => set({ input_qty: e.target.value })} />
              <Input label="Good" type="number" id="mp-prod-good" disabled={ro} value={f.good_qty} onChange={(e) => set({ good_qty: e.target.value })} />
              <Input label="Reject" type="number" id="mp-prod-reject-qty" disabled={ro} value={f.reject_qty} onChange={(e) => set({ reject_qty: e.target.value })} />
              <Input label="Rework" type="number" id="mp-prod-rework-qty" disabled={ro} value={f.rework_qty} onChange={(e) => set({ rework_qty: e.target.value })} />
              {Math.abs(adj) > 1e-6 && <Input label={`Adjustment ${qty(adj, 4)} — reason`} className="col-span-2" required disabled={ro} value={f.adjustment_reason} onChange={(e) => set({ adjustment_reason: e.target.value })} />}
              <Select label="Output UOM" disabled={ro} value={f.output_uom} onChange={(e) => set({ output_uom: e.target.value })} options={['PCS', 'KG', 'MTR'].map((u) => ({ value: u, label: u }))} />
              {kind === 'PRINTING'
                ? <Input label="Good weight (KG) — for ₹/kg" type="number" disabled={ro} value={f.good_weight_kg} onChange={(e) => set({ good_weight_kg: e.target.value })} />
                : <Input label="Actual stitches (counter)" type="number" disabled={ro} placeholder={shown?.total_stitches ? `${qty(shown.total_stitches, 0)} from ${human(shown.stitches_source)}` : 'from design'} value={f.total_stitches} onChange={(e) => set({ total_stitches: e.target.value })} />}
              {reworkSources.length > 0 && <Select label="Rework run of" disabled={ro} value={f.rework_of_id} placeholder="— fresh production —" onChange={(e) => set({ rework_of_id: e.target.value })}
                options={reworkSources.map((x: any) => ({ value: x.id, label: `${x.production_no} · rework ${qty(x.rework_qty)}` }))} />}
            </div>
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between"><span className="text-xs font-semibold text-ink-secondary">Reject / rework by reason</span>
                {!ro && <Button size="sm" variant="secondary" id="mp-prod-add-rej" onClick={() => set({ outputs: [...f.outputs, { output_type: num(f.reject_qty) > 0 ? 'REJECT' : 'REWORK', reason_id: '', qty: '', remarks: '' }] })}><Plus size={12} className="mr-1 inline" />Reason</Button>}</div>
              {f.outputs.map((o: Row, i: number) => {
                const upd = (x: any) => set({ outputs: f.outputs.map((y: Row, j: number) => (j === i ? { ...y, ...x } : y)) });
                return (
                  <div key={i} className="mb-1 flex flex-wrap items-center gap-1">
                    <select className="input h-8 w-28" disabled={ro} value={o.output_type} onChange={(e) => upd({ output_type: e.target.value })}><option value="REJECT">Reject</option><option value="REWORK">Rework</option></select>
                    <select className="input h-8 w-56" id={`mp-prod-out-${i}-reason`} disabled={ro} value={o.reason_id} onChange={(e) => upd({ reason_id: e.target.value })}>
                      <option value="">— reason —</option>{rjReasons.map((r: any) => <option key={r.id} value={r.id}>{r.reason_code} · {r.reason_name}</option>)}</select>
                    <input className="input h-8 w-20" type="number" placeholder="qty" id={`mp-prod-out-${i}-qty`} disabled={ro} value={o.qty} onChange={(e) => upd({ qty: e.target.value })} />
                    <input className="input h-8 w-40" placeholder="remarks" disabled={ro} value={o.remarks} onChange={(e) => upd({ remarks: e.target.value })} />
                    {!ro && <button className="text-red-500" onClick={() => set({ outputs: f.outputs.filter((_: Row, j: number) => j !== i) })}><Trash2 size={13} /></button>}
                  </div>
                );
              })}
            </div>
          </Section>
        </div>

        <Section title="Material — standard vs actual">
          {shown?.consumption?.length ? (
            <div className="overflow-x-auto"><table className="w-full text-xs">
              <thead className="bg-surface-muted text-ink-secondary"><tr>
                <th className="px-2 py-1 text-left">Material</th><th className="px-2 py-1 text-left">Role</th><th className="px-2 py-1 text-right">Standard</th>
                <th className="px-2 py-1 text-right">Issued (entry)</th><th className="px-2 py-1 text-right">Returned</th><th className="px-2 py-1 text-right">Actual</th>
                <th className="px-2 py-1 text-right">Wastage</th><th className="px-2 py-1 text-right">Variance</th><th className="px-2 py-1 text-right">Var %</th>
                {p.costing && <><th className="px-2 py-1 text-right">Rate</th><th className="px-2 py-1 text-right">Cost</th></>}
              </tr></thead>
              <tbody>{shown.consumption.map((cn: any) => {
                const o = over[cn.trim_id];
                return (
                  <tr key={cn.trim_id} className="border-t border-surface-divider">
                    <td className="px-2 py-1">{cn.trim_code ?? `#${cn.trim_id}`}{cn.trim_name ? ` · ${cn.trim_name}` : ''}{cn.lot_nos ? <span className="text-ink-muted"> · lot {cn.lot_nos}</span> : null}</td>
                    <td className="px-2 py-1">{human(cn.material_role)}</td>
                    <td className="px-2 py-1 text-right">{qty(cn.standard_qty, 3)} {cn.uom_code ?? ''}</td>
                    <td className="px-2 py-1 text-right">{qty(cn.issued_qty, 3)}</td><td className="px-2 py-1 text-right">{qty(cn.returned_qty, 3)}</td>
                    <td className="px-2 py-1 text-right">{ro ? qty(cn.actual_qty, 3) : <input className="input h-7 w-24 text-right" type="number" id={`mp-prod-act-${cn.trim_id}`} placeholder={String(num(cn.actual_qty))}
                      value={o?.actual_qty ?? ''} onChange={(e) => setOver({ ...over, [cn.trim_id]: { actual_qty: e.target.value, wastage_qty: o?.wastage_qty ?? '' } })} />}</td>
                    <td className="px-2 py-1 text-right">{ro ? qty(cn.wastage_qty, 3) : <input className="input h-7 w-20 text-right" type="number" value={o?.wastage_qty ?? ''}
                      onChange={(e) => setOver({ ...over, [cn.trim_id]: { actual_qty: o?.actual_qty ?? String(num(cn.actual_qty)), wastage_qty: e.target.value } })} />}</td>
                    <td className={`px-2 py-1 text-right ${num(cn.variance) > 0 ? 'text-red-600' : 'text-emerald-700'}`}>{qty(cn.variance, 3)}</td>
                    <td className="px-2 py-1 text-right">{pctTxt(cn.variance_pct)}</td>
                    {p.costing && <><td className="px-2 py-1 text-right">{rate4(cn.unit_cost)}</td><td className="px-2 py-1 text-right">{money(cn.total_cost)}</td></>}
                  </tr>
                );
              })}</tbody>
            </table>
            <p className="mt-1 text-caption text-ink-secondary">Actual defaults to what the store issued against this entry (issued − returned), else the standard. Type the actual when it differs; wastage is part of actual.</p></div>
          ) : <p className="text-xs text-ink-muted">Fill the job, machine, shift, timings and input qty — the standard consumption and cost are calculated by the server.</p>}
        </Section>

        <div className="grid gap-4 lg:grid-cols-3">
          <Section title="Productivity">
            {pErr && !ro ? <p className="text-xs text-red-600" id="mp-prod-preview-error">{pErr}</p> : c ? <>
              <Kv label="Net run hours" value={qty(c.net_run_hours, 2)} strong />
              <Kv label="Costing hours" value={qty(c.costing_hours, 2)} />
              <Kv label={`Output / hour`} value={qty(c.output_per_hour, 1)} />
              {kind === 'EMBROIDERY' && <Kv label="Stitches / hour" value={qty(c.stitches_per_hour, 0)} />}
              <Kv label="Efficiency" value={pctTxt(c.efficiency_pct)} />
              <Kv label="Utilization" value={pctTxt(c.utilization_pct)} />
              <Kv label="Reject % / rework %" value={`${pctTxt(c.reject_pct)} / ${pctTxt(c.rework_pct)}`} />
              {kind === 'EMBROIDERY' && <Kv label="Stitches" value={`${qty(shown?.total_stitches, 0)}${shown?.stitches_source ? ` (${human(shown.stitches_source)})` : ''}`} />}
            </> : <p className="text-xs text-ink-muted">—</p>}
          </Section>
          {p.costing ? <Section title="Cost">
            {c && c.total_cost !== undefined ? <>
              <Kv label={kind === 'EMBROIDERY' ? 'Thread' : 'Dyes / pigments / inks'} value={money(c.thread_cost)} />
              <Kv label={kind === 'EMBROIDERY' ? 'Backing / consumables' : 'Chemicals / binders'} value={money(c.consumable_cost)} />
              <Kv label="Machine" value={money(c.machine_cost)} />
              <Kv label="Labour" value={money(c.labour_cost)} />
              <Kv label="Overhead" value={money(c.overhead_cost)} />
              <Kv label="Other (approved)" value={money(c.other_cost)} />
              <div className="my-1 border-t border-surface-divider" />
              <Kv label="Total" value={money(c.total_cost)} strong />
              <Kv label="Cost / good pc" value={money(c.cost_per_unit)} strong />
              {kind === 'EMBROIDERY' ? <Kv label="Cost / 1,000 stitches" value={money(c.cost_per_1000_stitches)} /> : <Kv label="Cost / KG" value={money(c.cost_per_kg)} />}
              <Kv label="Standard cost / variance" value={`${money(c.std_total_cost)} · ${num(c.std_total_cost) > 0 ? pctTxt(((num(c.total_cost) - num(c.std_total_cost)) / num(c.std_total_cost)) * 100) : '—'}`} />
              {entry?.costing?.is_final ? <p className="mt-1 text-caption text-emerald-700">Frozen at approval — later rate / recipe changes do not alter it.</p> : null}
            </> : <p className="text-xs text-ink-muted">—</p>}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Input label="Other cost ₹" type="number" disabled={ro} value={f.other_cost} onChange={(e) => set({ other_cost: e.target.value })} />
              {num(f.other_cost) > 0 && <Input label="Other cost reason" required disabled={ro} value={f.other_cost_reason} onChange={(e) => set({ other_cost_reason: e.target.value })} />}
            </div>
          </Section> : <Section title="Cost"><p className="text-xs text-ink-muted">Costing is shown to supervisors and accounts.</p></Section>}
          <Section title="Remarks & history">
            <Textarea label="Remarks" disabled={ro} value={f.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            {entry && <div className="mt-2 space-y-0.5 text-caption text-ink-secondary">
              <div>Created by {entry.created_by_name} · {fmtDateTime(entry.created_at)}</div>
              {(entry.approvals ?? []).map((a: any) => <div key={a.id}><b>{human(a.action)}</b> {a.acted_by_name} · {fmtDateTime(a.acted_at)}{a.remarks ? ` — ${a.remarks}` : ''}</div>)}
              {entry.rework_of_no && <div>Rework run of {entry.rework_of_no}</div>}
            </div>}
          </Section>
        </div>
        {entry?.audit?.length > 0 && <Section title="Audit trail">
          <MiniTable rows={entry.audit.slice(0, 20)} cols={[{ h: 'When', r: (a) => fmtDateTime(a.changed_at) }, { h: 'Who', r: (a) => a.changed_by_name ?? '—' }, { h: 'Action', r: (a) => a.action },
            { h: 'Change', r: (a) => <span className="line-clamp-2 max-w-xl break-all tabular-nums text-micro text-ink-secondary">{typeof a.new_values === 'string' ? a.new_values.slice(0, 220) : JSON.stringify(a.new_values ?? '').slice(0, 220)}</span> }]} />
        </Section>}
      </div>
      {mat && entry && <MaterialDialog kind={kind} type="ISSUE" jobId={entry.job_id} productionId={entry.id} onClose={() => setMat(false)} onDone={() => { setMat(false); void load(entry.id); }} />}
    </Modal>
  );
}
