import { useState } from 'react';
import { Plus, Save, Play, CheckCircle2, Ban, PackageMinus, PackagePlus, Pencil, Factory } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Textarea, Modal, DataTable, FormSection, LoadingBlock } from '../../../components/ui';
import { api } from '../../../lib/api';
import { fmtDate } from '../../../lib/format';
import { useToast } from '../../../hooks/useToast';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { JobSelect } from '../../../components/JobSelect';
import { type Kind, BASE, LABEL, PRINT_TYPES, ST_TONE, errMsg, num, human, money, qty, pctTxt, usePerm, useGet, Kv, MiniTable } from './shared';
import { MaterialDialog } from './Material';

/** Titled block inside a popup — the shared popup section style (FormSection heading), one column. */
function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return <FormSection title={title} actions={actions} cols={1}><div className="min-w-0">{children}</div></FormSection>;
}

/** Embroidery / printing job (program): order, style, approved design + recipe, planned qty, machine, DC link (doc §7 / §5). */
export function JobsTab({ kind, onNewProduction, onOpenProduction }: { kind: Kind; onNewProduction: (jobId: number) => void; onOpenProduction: (id: number) => void }) {
  const p = usePerm(kind);
  const machines = useGet<any[]>(`${BASE[kind]}/machines`);
  const designs = useGet<any[]>(`${BASE[kind]}/designs`);
  const [f, setF] = useState({ status: 'OPEN', q: '', from: '', to: '', machine_id: '', design_id: '' });
  const list = useGet<any[]>(`${BASE[kind]}/jobs`, { status: f.status || undefined, q: f.q || undefined, from: f.from || undefined, to: f.to || undefined, machine_id: f.machine_id || undefined, design_id: f.design_id || undefined });
  const [edit, setEdit] = useState<any>(null);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Card title={`${LABEL[kind]} jobs`} subtitle="Draft → Planned (approved design + recipe) → Running → Completed"
      actions={p.submit && <Button size="sm" id="mp-job-new" onClick={() => setEdit({})}><Plus size={13} className="mr-1 inline" />New job</Button>}>
      <div className="flex flex-wrap items-end gap-3 p-3">
        <Select label="Status" className="w-36" value={f.status} placeholder="All" onChange={(e) => setF({ ...f, status: e.target.value })}
          options={[{ value: 'OPEN', label: 'Open' }, ...['DRAFT', 'PLANNED', 'RUNNING', 'COMPLETED', 'CANCELLED'].map((s) => ({ value: s, label: human(s) }))]} />
        <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <Select label="Machine" className="w-40" value={f.machine_id} placeholder="All" onChange={(e) => setF({ ...f, machine_id: e.target.value })} options={(machines.data ?? []).map((m: any) => ({ value: m.id, label: m.machine_code }))} />
        <Select label={kind === 'EMBROIDERY' ? 'Design' : 'Artwork'} className="w-44" value={f.design_id} placeholder="All" onChange={(e) => setF({ ...f, design_id: e.target.value })} options={(designs.data ?? []).map((d: any) => ({ value: d.id, label: `${d.design_code} v${d.version_no}` }))} />
        <Input label="Search" placeholder="Job / IO / style" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <DataTable data={list.data ?? []} loading={list.loading} emptyTitle="No jobs" onRowClick={(r: any) => setOpen(r.id)}
        columns={[
          { key: 'job_no', header: 'Job', render: (r: any) => <span className="tabular-nums font-semibold text-brand-700" id={`mp-job-${r.job_no}`}>{r.job_no}</span> },
          { key: 'job_date', header: 'Date', render: (r: any) => fmtDate(r.job_date) },
          { key: 'io', header: 'IO / style', render: (r: any) => <span>{r.io_no ?? '—'}{r.style_code ? <span className="text-ink-secondary"> · {r.style_code}</span> : null}{r.color_name ? <span className="text-ink-muted"> · {r.color_name}</span> : null}</span> },
          { key: 'buyer_name', header: 'Buyer' },
          { key: 'design', header: kind === 'EMBROIDERY' ? 'Design' : 'Artwork', render: (r: any) => r.design_code ? `${r.design_code} v${r.design_version}` : '—' },
          { key: 'recipe', header: 'Recipe', render: (r: any) => r.recipe_no ? `${r.recipe_no} v${r.recipe_version}` : '—' },
          { key: 'machine_code', header: 'Machine' },
          { key: 'planned_qty', header: 'Planned / done / good', align: 'right' as const, render: (r: any) => `${qty(r.planned_qty)} / ${qty(r.input_done)} / ${qty(r.good_done)} ${r.uom}` },
          { key: 'open_entries', header: 'Open entries', align: 'right' as const, render: (r: any) => num(r.open_entries) || '—' },
          { key: 'status', header: 'Status', render: (r: any) => <Badge tone={ST_TONE[r.status]}>{human(r.status)}</Badge> },
        ]} />
      {edit && <JobEditor kind={kind} job={edit} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); void list.reload(); setOpen(id); }} />}
      {open && <JobDetail kind={kind} id={open} onClose={() => { setOpen(null); void list.reload(); }} onEdit={(j) => { setOpen(null); setEdit(j); }}
        onNewProduction={onNewProduction} onOpenProduction={onOpenProduction} />}
    </Card>
  );
}

function JobEditor({ kind, job, onClose, onSaved }: { kind: Kind; job: any; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const colors = useLookup('colors');
  const designs = useGet<any[]>(`${BASE[kind]}/designs`, { status: 'APPROVED' });
  const recipes = useGet<any[]>(`${BASE[kind]}/recipes`, { status: 'APPROVED' });
  const machines = useGet<any[]>(`${BASE[kind]}/machines`, { active: '1' });
  const dcs = useGet<any[]>(`${BASE[kind]}/dc-options`);
  const [h, setH] = useState<any>({
    job_date: job.job_date ?? new Date().toISOString().slice(0, 10), so_id: job.so_id ?? '', io_no: job.io_no ?? '', style_id: job.style_id ?? '', styles: [] as any[],
    color_id: job.color_id ?? '', design_id: job.design_id ?? '', recipe_id: job.recipe_id ?? '', machine_id: job.machine_id ?? '', challan_id: job.challan_id ?? '',
    placement: job.placement ?? '', print_type: job.print_type ?? '', input_type: job.input_type ?? 'CUT_PANEL', planned_qty: job.planned_qty ?? '', uom: job.uom ?? 'PCS',
    planned_start: job.planned_start ?? '', planned_end: job.planned_end ?? '', remarks: job.remarks ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (x: any) => setH({ ...h, ...x });
  // keep the job's current (maybe now obsolete) design / recipe selectable
  const designOpts = [...(designs.data ?? [])];
  if (job.design_id && !designOpts.some((d) => d.id === job.design_id)) designOpts.push({ id: job.design_id, design_code: job.design_code, version_no: job.design_version });
  const recipeOpts = (recipes.data ?? []).filter((r: any) => !r.design_id || !h.design_id || String(r.design_id) === String(h.design_id));
  if (job.recipe_id && !recipeOpts.some((r: any) => r.id === job.recipe_id)) recipeOpts.push({ id: job.recipe_id, recipe_no: job.recipe_no, version_no: job.recipe_version });
  const save = async () => {
    setBusy(true);
    try {
      const b = {
        job_date: h.job_date, so_id: h.so_id || null, io_no: h.io_no || null, style_id: h.style_id || null, color_id: h.color_id || null, design_id: h.design_id || null,
        recipe_id: h.recipe_id || null, machine_id: h.machine_id || null, challan_id: h.challan_id || null, placement: h.placement || null, print_type: h.print_type || null,
        input_type: h.input_type, planned_qty: num(h.planned_qty), uom: h.uom, planned_start: h.planned_start || null, planned_end: h.planned_end || null, remarks: h.remarks || null,
      };
      const r = job.id ? await api.put(`${BASE[kind]}/jobs/${job.id}`, b) : await api.post(`${BASE[kind]}/jobs`, b);
      toast(`Job ${r.data.data.job_no} saved`); onSaved(r.data.data.id);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open size="xl" onClose={onClose} title={job.id ? `Edit ${job.job_no}` : `New ${LABEL[kind].toLowerCase()} job`}
      subtitle="Only approved design / recipe versions can be chosen. Once production or material is posted the design, recipe and UOM of the job are locked."
      icon={<Factory size={16} />}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} id="mp-job-save" disabled={!(num(h.planned_qty) > 0)} onClick={save}><Save size={13} className="mr-1 inline" />Save</Button></>}>
      <FormSection title="Order" cols={4}>
        <Input label="Job date" type="date" value={h.job_date} onChange={(e) => set({ job_date: e.target.value })} />
        <JobSelect value={h.so_id} by="so_id" label="Buyer order (IO)" id="mp-job-so" onPick={(j) => set({ so_id: j?.id ?? '', io_no: j?.job_no ?? '', styles: j?.styles ?? [], style_id: j && j.styles.length === 1 ? j.styles[0].style_id : '' })} />
        <Select label="Style" id="mp-job-style" value={h.style_id} placeholder="— style —" onChange={(e) => set({ style_id: e.target.value })}
          options={(h.styles.length ? h.styles : job.style_id ? [{ style_id: job.style_id, style_code: job.style_code }] : []).map((s: any) => ({ value: s.style_id, label: `${s.style_code}${s.style_name ? ` · ${s.style_name}` : ''}` }))} />
        <Select label="Colour" value={h.color_id} placeholder="— colour —" onChange={(e) => set({ color_id: e.target.value })} options={toOptions(colors.data)} />
      </FormSection>
      <FormSection title={kind === 'EMBROIDERY' ? 'Design & recipe' : 'Artwork & recipe'} cols={kind === 'PRINTING' ? 4 : 3}>
        <Select label={kind === 'EMBROIDERY' ? 'Approved design' : 'Approved artwork'} id="mp-job-design" value={h.design_id} placeholder="— choose —"
          onChange={(e) => { const d = designOpts.find((x) => String(x.id) === e.target.value); set({ design_id: e.target.value, placement: h.placement || d?.placement || '', print_type: h.print_type || d?.print_type || '' }); }}
          options={designOpts.map((d: any) => ({ value: d.id, label: `${d.design_code} v${d.version_no}${d.total_stitches ? ` · ${qty(d.total_stitches, 0)} st` : ''}${d.design_name ? ` · ${d.design_name}` : ''}` }))} />
        <Select label="Approved recipe" id="mp-job-recipe" value={h.recipe_id} placeholder="— choose —" onChange={(e) => set({ recipe_id: e.target.value })}
          options={recipeOpts.map((r: any) => ({ value: r.id, label: `${r.recipe_no} v${r.version_no}${r.recipe_name ? ` · ${r.recipe_name}` : ''}` }))} />
        <Input label="Placement" placeholder="Chest / Sleeve / Back / Panel" value={h.placement} onChange={(e) => set({ placement: e.target.value })} />
        {kind === 'PRINTING' && <Select label="Print type" value={h.print_type} placeholder="—" onChange={(e) => set({ print_type: e.target.value })} options={PRINT_TYPES.map((t) => ({ value: t, label: human(t) }))} />}
      </FormSection>
      <FormSection title="Quantity & schedule" cols={3}>
        <Select label="Input" value={h.input_type} onChange={(e) => set({ input_type: e.target.value })} options={['CUT_PANEL', 'GARMENT', 'FABRIC', 'OTHER'].map((t) => ({ value: t, label: human(t) }))} />
        <Input label="Planned qty" type="number" required id="mp-job-qty" value={h.planned_qty} onChange={(e) => set({ planned_qty: e.target.value })} />
        <Select label="UOM" value={h.uom} onChange={(e) => set({ uom: e.target.value })} options={['PCS', 'KG', 'MTR'].map((u) => ({ value: u, label: u }))} />
        <Input label="Planned start" type="date" value={h.planned_start} onChange={(e) => set({ planned_start: e.target.value })} />
        <Input label="Planned end" type="date" value={h.planned_end} onChange={(e) => set({ planned_end: e.target.value })} />
      </FormSection>
      <FormSection title="Machine & DC" cols={2}>
        <Select label="Machine (planned)" id="mp-job-machine" value={h.machine_id} placeholder="— any —" onChange={(e) => set({ machine_id: e.target.value })} options={(machines.data ?? []).map((m: any) => ({ value: m.id, label: `${m.machine_code} · ${m.machine_name}` }))} />
        <Select label="Process DC (came on)" value={h.challan_id} placeholder="— none / in-house —" onChange={(e) => set({ challan_id: e.target.value })}
          options={(dcs.data ?? []).map((d: any) => ({ value: d.id, label: `${d.challan_no} · ${fmtDate(d.challan_date)} · ${d.io_no ?? ''} ${d.style_code ?? ''} · ${d.vendor_name ?? ''}` }))} />
      </FormSection>
      <FormSection title="Remarks" cols={1}>
        <Textarea label="Remarks" value={h.remarks} onChange={(e) => set({ remarks: e.target.value })} />
      </FormSection>
    </Modal>
  );
}

export function JobDetail({ kind, id, onClose, onEdit, onNewProduction, onOpenProduction }: {
  kind: Kind; id: number; onClose: () => void; onEdit: (j: any) => void; onNewProduction: (jobId: number) => void; onOpenProduction: (id: number) => void;
}) {
  const toast = useToast();
  const p = usePerm(kind);
  const d = useGet<any>(`${BASE[kind]}/jobs/${id}`);
  const [mat, setMat] = useState<'ISSUE' | 'RETURN' | null>(null);
  const [busy, setBusy] = useState(false);
  const j = d.data;
  const act = async (path: string, body: any, msg: string) => {
    setBusy(true);
    try { await api.post(`${BASE[kind]}/jobs/${id}/${path}`, body); toast(msg); void d.reload(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const complete = async () => {
    try { await api.post(`${BASE[kind]}/jobs/${id}/complete`, {}); toast('Job completed'); void d.reload(); }
    catch (e: any) {
      if (/Unused material/.test(errMsg(e))) {
        const reason = window.prompt(`${errMsg(e)}\n\nGive the reason to complete anyway:`);
        if (reason) await act('complete', { material_balance_reason: reason }, 'Job completed');
      } else toast(errMsg(e), 'error');
    }
  };
  const cancel = async () => {
    const reason = window.prompt(`Cancel job ${j.job_no} — reason:`);
    if (reason) await act('cancel', { reason }, 'Job cancelled');
  };
  return (
    <Modal open size="full" onClose={onClose} title={j ? `${LABEL[kind]} job ${j.job_no}` : 'Job'}
      icon={<Factory size={16} />}
      subtitle={j ? <span className="inline-flex flex-wrap items-center gap-2"><Badge tone={ST_TONE[j.status]}>{human(j.status)}</Badge>{j.io_no ?? ''}{j.style_code ? ` · ${j.style_code}` : ''} · planned {qty(j.planned_qty)} {j.uom}</span> : undefined}
      footer={j && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {p.submit && ['DRAFT', 'PLANNED', 'RUNNING'].includes(j.status) && <Button variant="secondary" onClick={() => onEdit(j)}><Pencil size={13} className="mr-1 inline" />Edit</Button>}
        {p.store && ['PLANNED', 'RUNNING'].includes(j.status) && <Button variant="secondary" id="mp-job-issue" onClick={() => setMat('ISSUE')}><PackageMinus size={13} className="mr-1 inline" />Issue material</Button>}
        {p.store && j.status !== 'CANCELLED' && j.materials?.length > 0 && <Button variant="secondary" onClick={() => setMat('RETURN')}><PackagePlus size={13} className="mr-1 inline" />Return material</Button>}
        {p.submit && ['PLANNED', 'RUNNING'].includes(j.status) && <Button variant="secondary" loading={busy} id="mp-job-complete" onClick={complete}><CheckCircle2 size={13} className="mr-1 inline" />Complete</Button>}
        {p.submit && ['DRAFT', 'PLANNED', 'RUNNING'].includes(j.status) && <Button variant="danger" loading={busy} onClick={cancel}><Ban size={13} className="mr-1 inline" />Cancel job</Button>}
        {p.submit && j.status === 'DRAFT' && <Button loading={busy} id="mp-job-plan" onClick={() => act('plan', {}, 'Job planned — released to the floor')}><Play size={13} className="mr-1 inline" />Plan / release</Button>}
        {(p.create || p.submit) && ['PLANNED', 'RUNNING'].includes(j.status) && <Button id="mp-job-new-prod" onClick={() => onNewProduction(j.id)}><Factory size={13} className="mr-1 inline" />New production entry</Button>}
      </>}>
      {!j ? (d.error ? <p className="text-sm text-ink-secondary">{d.error}</p> : <LoadingBlock />) : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Section title="Job">
              <Kv label="Status" value={<Badge tone={ST_TONE[j.status]}>{human(j.status)}</Badge>} />
              <Kv label="Date" value={fmtDate(j.job_date)} />
              <Kv label="Buyer / order" value={`${j.buyer_name ?? '—'} · ${j.io_no ?? '—'}${j.buyer_po_no ? ` · PO ${j.buyer_po_no}` : ''}`} />
              <Kv label="Style / colour" value={`${j.style_code ?? '—'}${j.color_name ? ` · ${j.color_name}` : ''}`} />
              <Kv label="Placement / input" value={`${j.placement ?? '—'} · ${human(j.input_type)}`} />
              <Kv label="Planned" value={`${qty(j.planned_qty)} ${j.uom} · ${fmtDate(j.planned_start)} → ${fmtDate(j.planned_end)}`} />
              <Kv label="Machine" value={j.machine_code ? `${j.machine_code} · ${j.machine_name}` : '—'} />
            </Section>
            <Section title={kind === 'EMBROIDERY' ? 'Design & recipe' : 'Artwork & recipe'}>
              <Kv label={kind === 'EMBROIDERY' ? 'Design' : 'Artwork'} value={j.design_code ? `${j.design_code} v${j.design_version} · ${j.design_name}` : '—'} />
              {kind === 'EMBROIDERY' && <Kv label="Stitches / pc" value={qty(j.stitches_per_pc, 0)} />}
              {kind === 'PRINTING' && <Kv label="Print type" value={human(j.print_type)} />}
              <Kv label="Recipe" value={j.recipe_no ? `${j.recipe_no} v${j.recipe_version} · ${j.recipe_name}` : '—'} />
              {j.design_file_url && <Kv label="File" value={<a className="text-brand-700 underline" href={j.design_file_url} target="_blank" rel="noreferrer">open</a>} />}
              {j.dc && <Kv label="Process DC" value={`${j.dc.challan_no} · ${human(j.dc.status)} · out ${qty(j.dc.issued)} / in ${qty(j.dc.received)}${j.dc.vendor_name ? ` · ${j.dc.vendor_name}` : ''}`} />}
            </Section>
            <Section title="Output (approved)">
              <Kv label="Input processed" value={`${qty(j.output.input)} / ${qty(j.planned_qty)} ${j.uom}`} />
              <Kv label="Good" value={qty(j.output.good)} strong />
              <Kv label="Reject" value={`${qty(j.output.reject)} (${pctTxt(num(j.output.input) ? num(j.output.reject) / num(j.output.input) * 100 : null)})`} />
              <Kv label="Rework" value={qty(j.output.rework)} />
              <Kv label="Balance to produce" value={qty(j.output.balance_to_produce)} />
              <Kv label="Entries waiting" value={j.output.pending_entries} />
              {j.cost && <>
                <div className="my-1 border-t border-surface-divider" />
                <Kv label="Total cost" value={money(j.cost.total)} strong />
                <Kv label="Cost / good pc" value={money(j.cost.cost_per_good)} strong />
                {kind === 'EMBROIDERY' && <Kv label="Cost / 1,000 stitches" value={money(j.cost.cost_per_1000_stitches)} />}
                <Kv label="Standard / variance" value={`${money(j.cost.std_total)} · ${pctTxt(j.cost.variance?.variance_pct)}`} />
              </>}
            </Section>
          </div>
          <Section title="Standard requirement (recipe for planned qty)">
            <MiniTable rows={j.requirement ?? []} empty="No recipe on the job" cols={[
              { h: 'Material', r: (l) => `${l.trim_code} · ${l.trim_name}` }, { h: 'Role', r: (l) => human(l.material_role) }, { h: 'Basis', r: (l) => human(l.basis) },
              { h: 'Std qty', right: true, r: (l) => `${qty(l.standard_qty, 3)} ${l.uom_code}` }, { h: 'In stock units', right: true, r: (l) => `${qty(l.stock_qty, 4)} ${l.stock_uom_code}` },
            ]} />
          </Section>
          <Section title="Material balance (stock units)">
            <MiniTable rows={j.materials ?? []} empty="No material issued yet" cols={[
              { h: 'Material', r: (m) => `${m.trim_code} · ${m.trim_name}` }, { h: 'Issued', right: true, r: (m) => qty(m.issued, 4) }, { h: 'Returned', right: true, r: (m) => qty(m.returned, 4) },
              { h: 'Net issued', right: true, r: (m) => qty(m.net_issued, 4) }, { h: 'Consumed (production)', right: true, r: (m) => qty(m.consumed, 4) },
              { h: 'With machine', right: true, r: (m) => <span className={m.balance > 0.0001 ? 'font-semibold text-amber-700' : ''}>{qty(m.balance, 4)} {m.uom_code}</span> },
              ...(p.costing || p.store ? [{ h: 'Issued value', right: true, r: (m: any) => money(m.amount) }] : []),
            ]} />
          </Section>
          <Section title="Production entries">
            <MiniTable rows={j.productions ?? []} empty="No production entered" cols={[
              { h: 'Entry', r: (x) => <button className="tabular-nums text-brand-700 hover:underline" onClick={() => onOpenProduction(x.id)}>{x.production_no}</button> },
              { h: 'Date', r: (x) => `${fmtDate(x.prod_date)} ${x.shift_code ?? ''}` }, { h: 'Machine', r: (x) => x.machine_code },
              { h: 'Time', r: (x) => `${String(x.start_at).slice(11)}–${String(x.end_at).slice(11)}` },
              { h: 'Input', right: true, r: (x) => qty(x.input_qty) }, { h: 'Good', right: true, r: (x) => qty(x.good_qty) }, { h: 'Reject', right: true, r: (x) => qty(x.reject_qty) },
              { h: 'Rework', right: true, r: (x) => qty(x.rework_qty) }, { h: 'Run h', right: true, r: (x) => qty(x.net_run_hours) },
              ...(p.costing ? [{ h: 'Cost', right: true, r: (x: any) => money(x.total_cost) }, { h: '₹ / pc', right: true, r: (x: any) => money(x.cost_per_unit) }] : []),
              { h: 'Status', r: (x) => <Badge tone={ST_TONE[x.status]}>{human(x.status)}{x.rework_of_id ? ' · rework' : ''}</Badge> },
            ]} />
          </Section>
        </div>
      )}
      {mat && j && <MaterialDialog kind={kind} type={mat} jobId={j.id} onClose={() => setMat(null)} onDone={() => { setMat(null); void d.reload(); }} />}
    </Modal>
  );
}
