import { useState } from 'react';
import { Plus, Save, CheckCircle2, Copy, Ban, Trash2, Upload, Calculator } from 'lucide-react';
import { Card, Badge, Button, Input, Select, Textarea, Modal, DataTable, Tabs, Checkbox } from '../../../components/ui';
import { api } from '../../../lib/api';
import { fmtDate } from '../../../lib/format';
import { useToast } from '../../../hooks/useToast';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import {
  type Kind, BASE, LABEL, MACHINE_TYPES, ROLES, ROLE_OF_TYPE, PRINT_TYPES, ST_TONE, errMsg, num, human, money, qty, usePerm, useGet, Section, MiniTable, uploadFile,
} from './shared';

/** Masters of the embroidery / printing engine: machines + rates, designs / artwork, recipes, reasons. */
export function MastersTab({ kind }: { kind: Kind }) {
  const [tab, setTab] = useState('machines');
  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'machines', label: 'Machines & rates' },
        { key: 'designs', label: kind === 'EMBROIDERY' ? 'Designs / programs' : 'Artwork' },
        { key: 'recipes', label: kind === 'EMBROIDERY' ? 'Thread & consumable recipes' : 'Dyes & chemical recipes' },
        { key: 'reasons', label: 'Downtime / reject reasons' },
      ]} />
      {tab === 'machines' && <Machines kind={kind} />}
      {tab === 'designs' && <Designs kind={kind} />}
      {tab === 'recipes' && <Recipes kind={kind} />}
      {tab === 'reasons' && <Reasons kind={kind} />}
    </div>
  );
}

// ───────────────────────────── machines ─────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const blankRate = () => ({
  effective_from: today(), costing_method: 'COMPONENT', rate_basis: 'MACHINE', machine_hour_rate: '', depreciation_rate_hour: '', electricity_rate_hour: '',
  maintenance_rate_hour: '', overhead_basis: 'HOUR', overhead_rate_hour: '', overhead_pct: '', operator_rate_hour: '', helper_rate_hour: '', remarks: '',
});
const rateOut = (r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ['effective_from', 'costing_method', 'rate_basis', 'overhead_basis', 'remarks'].includes(k) ? (v || null) : num(v)]));

function RateFields({ kind, r, set }: { kind: Kind; r: any; set: (p: any) => void }) {
  const machine = r.costing_method === 'MACHINE_HOUR' ? num(r.machine_hour_rate) : num(r.depreciation_rate_hour) + num(r.electricity_rate_hour) + num(r.maintenance_rate_hour);
  const total = machine + num(r.operator_rate_hour) + num(r.helper_rate_hour) + (r.overhead_basis === 'HOUR' ? num(r.overhead_rate_hour) : 0);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Input label="Effective from" type="date" required value={r.effective_from} onChange={(e) => set({ effective_from: e.target.value })} />
      <Select label="Machine costing" value={r.costing_method} onChange={(e) => set({ costing_method: e.target.value })}
        options={[{ value: 'COMPONENT', label: 'Component (depreciation + power + maintenance)' }, { value: 'MACHINE_HOUR', label: 'Single machine-hour rate' }]} />
      {kind === 'EMBROIDERY' && <Select label="Rate per" value={r.rate_basis} onChange={(e) => set({ rate_basis: e.target.value })}
        options={[{ value: 'MACHINE', label: 'Machine hour' }, { value: 'HEAD', label: 'Head hour (× heads used)' }]} />}
      {r.costing_method === 'MACHINE_HOUR'
        ? <Input label="Machine hour rate ₹" type="number" id="mp-rate-mhr" value={r.machine_hour_rate} onChange={(e) => set({ machine_hour_rate: e.target.value })} />
        : <>
          <Input label="Depreciation ₹/hr" type="number" id="mp-rate-dep" value={r.depreciation_rate_hour} onChange={(e) => set({ depreciation_rate_hour: e.target.value })} />
          <Input label="Electricity ₹/hr" type="number" id="mp-rate-elec" value={r.electricity_rate_hour} onChange={(e) => set({ electricity_rate_hour: e.target.value })} />
          <Input label="Maintenance ₹/hr" type="number" value={r.maintenance_rate_hour} onChange={(e) => set({ maintenance_rate_hour: e.target.value })} />
        </>}
      <Input label="Operator ₹/hr" type="number" id="mp-rate-op" value={r.operator_rate_hour} onChange={(e) => set({ operator_rate_hour: e.target.value })} />
      <Input label="Helper ₹/hr" type="number" value={r.helper_rate_hour} onChange={(e) => set({ helper_rate_hour: e.target.value })} />
      <Select label="Overhead basis" value={r.overhead_basis} onChange={(e) => set({ overhead_basis: e.target.value })}
        options={[{ value: 'HOUR', label: 'Per hour' }, { value: 'PERCENT', label: '% of material + machine + labour' }]} />
      {r.overhead_basis === 'HOUR'
        ? <Input label="Factory overhead ₹/hr" type="number" value={r.overhead_rate_hour} onChange={(e) => set({ overhead_rate_hour: e.target.value })} />
        : <Input label="Overhead %" type="number" value={r.overhead_pct} onChange={(e) => set({ overhead_pct: e.target.value })} />}
      <div className="col-span-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600 md:col-span-4">
        Machine {money(machine)}/hr + labour {money(num(r.operator_rate_hour) + num(r.helper_rate_hour))}/hr{r.overhead_basis === 'HOUR' ? ` + overhead ${money(r.overhead_rate_hour)}/hr` : ''} =
        <b className="ml-1 text-slate-900">{money(total)} / hour</b>{r.rate_basis === 'HEAD' ? ' (machine part per head)' : ''}.
        Machine and overhead are charged on costing hours; labour on attended hours (end − start − break).
      </div>
    </div>
  );
}

function Machines({ kind }: { kind: Kind }) {
  const p = usePerm(kind);
  const list = useGet<any[]>(`${BASE[kind]}/machines`);
  const [edit, setEdit] = useState<any>(null);
  return (
    <Card title={`${LABEL[kind]} machines`} subtitle="Capacity and effective-dated costing rates — a rate change never alters costing already approved"
      actions={p.master && <Button size="sm" id="mp-machine-new" onClick={() => setEdit({})}><Plus size={13} className="mr-1 inline" />New machine</Button>}>
      <DataTable data={list.data ?? []} loading={list.loading} emptyTitle="No machines yet" onRowClick={(r: any) => setEdit(r)}
        columns={[
          { key: 'machine_code', header: 'Code', render: (r: any) => <span className="font-mono font-semibold text-brand-700">{r.machine_code}</span> },
          { key: 'machine_name', header: 'Name' },
          { key: 'machine_type', header: 'Type', render: (r: any) => human(r.machine_type) },
          kind === 'EMBROIDERY'
            ? { key: 'head_count', header: 'Heads × needles', render: (r: any) => `${r.head_count} × ${r.needle_count ?? '—'}` }
            : { key: 'no_of_colors', header: 'Colours', render: (r: any) => r.no_of_colors ?? '—' },
          { key: 'cap', header: 'Capacity / hr', align: 'right' as const, render: (r: any) => kind === 'EMBROIDERY' ? `${qty(r.capacity_stitches_hour, 0)} st${r.capacity_per_hour ? ` · ${qty(r.capacity_per_hour)} pcs` : ''}` : `${qty(r.capacity_per_hour)} ${r.capacity_uom}` },
          { key: 'rate', header: 'Machine ₹/hr', align: 'right' as const, render: (r: any) => r.rate_id ? money(r.costing_method === 'MACHINE_HOUR' ? r.machine_hour_rate : num(r.depreciation_rate_hour) + num(r.electricity_rate_hour) + num(r.maintenance_rate_hour)) : <span className="text-red-600">no rate</span> },
          { key: 'lab', header: 'Labour ₹/hr', align: 'right' as const, render: (r: any) => money(num(r.operator_rate_hour) + num(r.helper_rate_hour)) },
          { key: 'effective_from', header: 'Rate from', render: (r: any) => fmtDate(r.effective_from) },
          { key: 'is_active', header: 'Status', render: (r: any) => r.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge> },
        ]} />
      {edit && <MachineEditor kind={kind} row={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void list.reload(); }} />}
    </Card>
  );
}

function MachineEditor({ kind, row, onClose, onSaved }: { kind: Kind; row: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const p = usePerm(kind);
  const detail = useGet<any>(row.id ? `${BASE[kind]}/machines/${row.id}` : null);
  const [m, setM] = useState<any>({
    machine_code: row.machine_code ?? '', machine_name: row.machine_name ?? '', machine_type: row.machine_type ?? MACHINE_TYPES[kind][0],
    head_count: row.head_count ?? 1, needle_count: row.needle_count ?? '', no_of_colors: row.no_of_colors ?? '', capacity_stitches_hour: row.capacity_stitches_hour ?? '',
    capacity_per_hour: row.capacity_per_hour ?? '', capacity_uom: row.capacity_uom ?? 'PCS', setup_time_minutes: row.setup_time_minutes ?? '', location: row.location ?? '',
    remarks: row.remarks ?? '', is_active: row.is_active ?? 1,
  });
  const [rate, setRate] = useState<any>(blankRate());
  const [busy, setBusy] = useState(false);
  const ro = !p.master;
  const body = () => ({
    ...m, head_count: num(m.head_count) || 1, needle_count: m.needle_count === '' ? null : num(m.needle_count), no_of_colors: m.no_of_colors === '' ? null : num(m.no_of_colors),
    capacity_stitches_hour: m.capacity_stitches_hour === '' ? null : num(m.capacity_stitches_hour), capacity_per_hour: m.capacity_per_hour === '' ? null : num(m.capacity_per_hour),
    setup_time_minutes: m.setup_time_minutes === '' ? null : num(m.setup_time_minutes), is_active: !!num(m.is_active),
  });
  const save = async () => {
    setBusy(true);
    try {
      if (row.id) await api.put(`${BASE[kind]}/machines/${row.id}`, body());
      else await api.post(`${BASE[kind]}/machines`, { ...body(), rate: rateOut(rate) });
      toast(`Machine ${m.machine_code} saved`); onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const addRate = async () => {
    setBusy(true);
    try { await api.post(`${BASE[kind]}/machines/${row.id}/rates`, rateOut(rate)); toast(`Rate from ${rate.effective_from} saved`); setRate(blankRate()); void detail.reload(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const set = (p2: any) => setM({ ...m, ...p2 });
  return (
    <Modal open size="xl" onClose={onClose} title={row.id ? `Machine ${row.machine_code}` : `New ${LABEL[kind].toLowerCase()} machine`}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{!ro && <Button loading={busy} id="mp-machine-save" onClick={save}><Save size={13} className="mr-1 inline" />Save machine</Button>}</>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Input label="Machine code" required id="mp-machine-code" disabled={ro} value={m.machine_code} onChange={(e) => set({ machine_code: e.target.value })} />
          <Input label="Machine name" required id="mp-machine-name" disabled={ro} value={m.machine_name} onChange={(e) => set({ machine_name: e.target.value })} />
          <Select label="Machine type" disabled={ro} value={m.machine_type} onChange={(e) => set({ machine_type: e.target.value })} options={MACHINE_TYPES[kind].map((t) => ({ value: t, label: human(t) }))} />
          {kind === 'EMBROIDERY' ? <>
            <Input label="Heads" type="number" id="mp-machine-heads" disabled={ro} value={m.head_count} onChange={(e) => set({ head_count: e.target.value })} />
            <Input label="Needles per head" type="number" required id="mp-machine-needles" disabled={ro} value={m.needle_count} onChange={(e) => set({ needle_count: e.target.value })} />
            <Input label="Std stitches / hour (machine)" type="number" required id="mp-machine-cap-st" disabled={ro} value={m.capacity_stitches_hour} onChange={(e) => set({ capacity_stitches_hour: e.target.value })} />
            <Input label="Std pcs / hour (optional)" type="number" disabled={ro} value={m.capacity_per_hour} onChange={(e) => set({ capacity_per_hour: e.target.value })} />
          </> : <>
            <Input label="Max colours" type="number" disabled={ro} value={m.no_of_colors} onChange={(e) => set({ no_of_colors: e.target.value })} />
            <Input label="Std output / hour" type="number" required id="mp-machine-cap" disabled={ro} value={m.capacity_per_hour} onChange={(e) => set({ capacity_per_hour: e.target.value })} />
            <Select label="Capacity UOM" disabled={ro} value={m.capacity_uom} onChange={(e) => set({ capacity_uom: e.target.value })} options={['PCS', 'KG', 'MTR'].map((u) => ({ value: u, label: u }))} />
          </>}
          <Input label="Std setup (min)" type="number" disabled={ro} value={m.setup_time_minutes} onChange={(e) => set({ setup_time_minutes: e.target.value })} />
          <Input label="Location" disabled={ro} value={m.location} onChange={(e) => set({ location: e.target.value })} />
          <Input label="Remarks" className="md:col-span-2" disabled={ro} value={m.remarks} onChange={(e) => set({ remarks: e.target.value })} />
          <div className="flex items-end pb-1.5"><Checkbox label="Active" checked={!!num(m.is_active)} disabled={ro} onChange={(v) => set({ is_active: v ? 1 : 0 })} /></div>
        </div>
        {!row.id && <Section title="Costing rates (effective dated)"><RateFields kind={kind} r={rate} set={(p2) => setRate({ ...rate, ...p2 })} /></Section>}
        {row.id && <Section title="Rate history">
          <MiniTable rows={detail.data?.rates ?? []} cols={[
            { h: 'From', r: (r) => fmtDate(r.effective_from) },
            { h: 'Method', r: (r) => `${human(r.costing_method)}${r.rate_basis === 'HEAD' ? ' / head' : ''}` },
            { h: 'Machine ₹/hr', right: true, r: (r) => money(r.costing_method === 'MACHINE_HOUR' ? r.machine_hour_rate : num(r.depreciation_rate_hour) + num(r.electricity_rate_hour) + num(r.maintenance_rate_hour)) },
            { h: 'Operator', right: true, r: (r) => money(r.operator_rate_hour) },
            { h: 'Helper', right: true, r: (r) => money(r.helper_rate_hour) },
            { h: 'Overhead', right: true, r: (r) => r.overhead_basis === 'HOUR' ? `${money(r.overhead_rate_hour)}/hr` : `${num(r.overhead_pct)}%` },
            { h: 'Used by approved', r: (r) => num(r.used_final) ? <Badge tone="green">{r.used_final} entries · locked</Badge> : '—' },
            { h: 'By', r: (r) => r.created_by_name ?? '—' },
          ]} />
          {p.master && <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
            <p className="text-xs font-semibold text-slate-600">Add a rate from a date (production on / after that date is costed with it)</p>
            <RateFields kind={kind} r={rate} set={(p2) => setRate({ ...rate, ...p2 })} />
            <Button size="sm" loading={busy} id="mp-rate-add" onClick={addRate}><Plus size={12} className="mr-1 inline" />Add rate</Button>
          </div>}
        </Section>}
      </div>
    </Modal>
  );
}

// ───────────────────────────── designs ─────────────────────────────
function Designs({ kind }: { kind: Kind }) {
  const p = usePerm(kind);
  const [f, setF] = useState({ status: '', q: '' });
  const list = useGet<any[]>(`${BASE[kind]}/designs`, { status: f.status || undefined, q: f.q || undefined });
  const [open, setOpen] = useState<any>(null);
  return (
    <Card title={kind === 'EMBROIDERY' ? 'Embroidery designs / programs' : 'Print artwork'}
      subtitle="Version controlled — an approved version is never edited; make a new version. Jobs keep the version they were planned on."
      actions={p.master && <Button size="sm" id="mp-design-new" onClick={() => setOpen({})}><Plus size={13} className="mr-1 inline" />New {kind === 'EMBROIDERY' ? 'design' : 'artwork'}</Button>}>
      <div className="flex flex-wrap items-end gap-3 p-3">
        <Select label="Status" className="w-40" value={f.status} placeholder="All" onChange={(e) => setF({ ...f, status: e.target.value })} options={['DRAFT', 'APPROVED', 'OBSOLETE'].map((s) => ({ value: s, label: human(s) }))} />
        <Input label="Search" placeholder="Code / name" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <DataTable data={list.data ?? []} loading={list.loading} emptyTitle="No designs yet" onRowClick={(r: any) => setOpen(r)}
        columns={[
          { key: 'design_code', header: 'Code', render: (r: any) => <span className="font-mono font-semibold text-brand-700">{r.design_code} <span className="text-slate-400">v{r.version_no}</span></span> },
          { key: 'design_name', header: 'Name' },
          ...(kind === 'EMBROIDERY' ? [{ key: 'total_stitches', header: 'Stitches', align: 'right' as const, render: (r: any) => qty(r.total_stitches, 0) }] : [{ key: 'print_type', header: 'Print type', render: (r: any) => human(r.print_type) }]),
          { key: 'no_of_colors', header: 'Colours', align: 'right' as const },
          { key: 'placement', header: 'Placement' },
          { key: 'style_code', header: 'Style' },
          { key: 'file', header: 'File', render: (r: any) => r.file_url ? <a href={r.file_url} target="_blank" rel="noreferrer" className="text-brand-700 underline" onClick={(e) => e.stopPropagation()}>{r.file_name ?? 'file'}</a> : '—' },
          { key: 'status', header: 'Status', render: (r: any) => <Badge tone={ST_TONE[r.status]}>{human(r.status)}</Badge> },
        ]} />
      {open && <DesignEditor kind={kind} row={open} onClose={() => setOpen(null)} onSaved={(d) => { void list.reload(); setOpen(d); }} />}
    </Card>
  );
}

function DesignEditor({ kind, row, onClose, onSaved }: { kind: Kind; row: any; onClose: () => void; onSaved: (d: any) => void }) {
  const toast = useToast();
  const p = usePerm(kind);
  const styles = useLookup('styles');
  const buyers = useLookup('buyers');
  const materials = useGet<any[]>(`${BASE[kind]}/materials`);
  const detail = useGet<any>(row.id ? `${BASE[kind]}/designs/${row.id}` : null);
  const d0 = detail.data ?? row;
  const [d, setD] = useState<any>(null);
  const cur = d ?? {
    design_code: d0.design_code ?? '', design_name: d0.design_name ?? '', style_id: d0.style_id ?? '', buyer_id: d0.buyer_id ?? '', file_url: d0.file_url ?? '', file_name: d0.file_name ?? '',
    total_stitches: d0.total_stitches ?? '', no_of_colors: d0.no_of_colors ?? '', needle_sequence: d0.needle_sequence ?? '', hoop_size: d0.hoop_size ?? '', std_minutes_per_pc: d0.std_minutes_per_pc ?? '',
    backing_type: d0.backing_type ?? '', print_type: d0.print_type ?? '', placement: d0.placement ?? '', remarks: d0.remarks ?? '',
    colors: (d0.colors ?? []).map((c: any) => ({ needle_no: c.needle_no ?? '', color_name: c.color_name, trim_id: c.trim_id ?? '', stitches: c.stitches ?? '' })),
  };
  const set = (x: any) => setD({ ...cur, ...x });
  const [busy, setBusy] = useState(false);
  const status = d0.status ?? 'DRAFT';
  const ro = !p.master || (row.id && status !== 'DRAFT');
  const act = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true);
    try { const r = await fn(); toast(msg); setD(null); onSaved(r.data.data); void detail.reload(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const payload = () => ({
    ...cur, style_id: cur.style_id || null, buyer_id: cur.buyer_id || null, total_stitches: cur.total_stitches === '' ? null : num(cur.total_stitches),
    no_of_colors: cur.no_of_colors === '' ? null : num(cur.no_of_colors), std_minutes_per_pc: cur.std_minutes_per_pc === '' ? null : num(cur.std_minutes_per_pc),
    colors: cur.colors.filter((c: any) => c.color_name).map((c: any) => ({ needle_no: c.needle_no === '' ? null : num(c.needle_no), color_name: c.color_name, trim_id: c.trim_id || null, stitches: c.stitches === '' ? null : num(c.stitches) })),
  });
  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try { const u = await uploadFile(file); set({ file_url: u.url, file_name: u.originalName }); toast('File uploaded'); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open size="xl" onClose={onClose} title={row.id ? `${cur.design_code} v${d0.version_no ?? 1} · ${human(status)}` : `New ${kind === 'EMBROIDERY' ? 'design' : 'artwork'}`}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {row.id && status === 'DRAFT' && (p.master || p.approve) && <Button variant="secondary" loading={busy} id="mp-design-approve" onClick={() => act(() => api.post(`${BASE[kind]}/designs/${row.id}/approve`), 'Design approved')}><CheckCircle2 size={13} className="mr-1 inline" />Approve</Button>}
        {row.id && status !== 'DRAFT' && p.master && <Button variant="secondary" loading={busy} id="mp-design-version" onClick={() => act(() => api.post(`${BASE[kind]}/designs/${row.id}/new-version`), 'New draft version made')}><Copy size={13} className="mr-1 inline" />New version</Button>}
        {row.id && status === 'APPROVED' && (p.master || p.approve) && <Button variant="secondary" loading={busy} onClick={() => act(() => api.post(`${BASE[kind]}/designs/${row.id}/obsolete`), 'Marked obsolete')}><Ban size={13} className="mr-1 inline" />Obsolete</Button>}
        {!ro && <Button loading={busy} id="mp-design-save" onClick={() => act(() => (row.id ? api.put(`${BASE[kind]}/designs/${row.id}`, payload()) : api.post(`${BASE[kind]}/designs`, payload())), 'Design saved (draft)')}><Save size={13} className="mr-1 inline" />Save draft</Button>}
      </>}>
      <div className="space-y-4">
        {ro && row.id && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">This version is {human(status).toLowerCase()} and cannot be changed{p.master ? ' — use "New version"' : ''}.</p>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Input label="Design code" required id="mp-design-code" disabled={ro || !!row.id} value={cur.design_code} onChange={(e) => set({ design_code: e.target.value })} />
          <Input label="Design name" required id="mp-design-name" className="md:col-span-2" disabled={ro} value={cur.design_name} onChange={(e) => set({ design_name: e.target.value })} />
          <Input label="Placement" placeholder="Chest / Sleeve / Back" disabled={ro} value={cur.placement} onChange={(e) => set({ placement: e.target.value })} />
          <Select label="Style (optional)" disabled={ro} value={cur.style_id} placeholder="— any style —" onChange={(e) => set({ style_id: e.target.value })} options={toOptions(styles.data)} />
          <Select label="Buyer (optional)" disabled={ro} value={cur.buyer_id} placeholder="— any buyer —" onChange={(e) => set({ buyer_id: e.target.value })} options={toOptions(buyers.data)} />
          {kind === 'EMBROIDERY' ? <>
            <Input label="Total stitches" type="number" required id="mp-design-stitches" disabled={ro} value={cur.total_stitches} onChange={(e) => set({ total_stitches: e.target.value })} />
            <Input label="Std machine min / pc (per head)" type="number" disabled={ro} value={cur.std_minutes_per_pc} onChange={(e) => set({ std_minutes_per_pc: e.target.value })} />
            <Input label="Hoop / frame size" disabled={ro} value={cur.hoop_size} onChange={(e) => set({ hoop_size: e.target.value })} />
            <Input label="Backing type" placeholder="Cut-away / Tear-away / Water soluble" disabled={ro} value={cur.backing_type} onChange={(e) => set({ backing_type: e.target.value })} />
            <Input label="Needle sequence" className="md:col-span-2" placeholder="1-2-3-1-4" disabled={ro} value={cur.needle_sequence} onChange={(e) => set({ needle_sequence: e.target.value })} />
          </> : <>
            <Select label="Print type" disabled={ro} value={cur.print_type} placeholder="— choose —" onChange={(e) => set({ print_type: e.target.value })} options={PRINT_TYPES.map((t) => ({ value: t, label: human(t) }))} />
            <Input label="No. of colours" type="number" disabled={ro} value={cur.no_of_colors} onChange={(e) => set({ no_of_colors: e.target.value })} />
          </>}
          <div className="col-span-2 md:col-span-4">
            <span className="label">{kind === 'EMBROIDERY' ? 'Design file (DST / DSB / EMB / PDF / image)' : 'Artwork file (PDF / image)'}</span>
            <div className="flex items-center gap-3">
              {!ro && <label className="btn-secondary cursor-pointer text-xs"><Upload size={12} className="mr-1 inline" />Upload<input type="file" className="hidden" id="mp-design-file" onChange={(e) => void onFile(e.target.files?.[0])} /></label>}
              {cur.file_url ? <a href={cur.file_url} target="_blank" rel="noreferrer" className="text-xs text-brand-700 underline">{cur.file_name || cur.file_url}</a> : <span className="text-xs text-slate-400">No file</span>}
            </div>
          </div>
          <Textarea label="Remarks" className="col-span-2 md:col-span-4" disabled={ro} value={cur.remarks} onChange={(e) => set({ remarks: e.target.value })} />
        </div>
        <Section title={kind === 'EMBROIDERY' ? 'Thread colours / needle sequence' : 'Ink colours'}
          actions={!ro && <Button size="sm" variant="secondary" onClick={() => set({ colors: [...cur.colors, { needle_no: '', color_name: '', trim_id: '', stitches: '' }] })}><Plus size={12} className="mr-1 inline" />Add colour</Button>}>
          {cur.colors.length ? <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              {kind === 'EMBROIDERY' && <th className="px-2 py-1 text-left">Needle</th>}<th className="px-2 py-1 text-left">Colour</th>
              <th className="px-2 py-1 text-left">Material</th>{kind === 'EMBROIDERY' && <th className="px-2 py-1 text-left">Stitches</th>}<th />
            </tr></thead>
            <tbody>{cur.colors.map((c: any, i: number) => {
              const upd = (x: any) => set({ colors: cur.colors.map((y: any, j: number) => (j === i ? { ...y, ...x } : y)) });
              return (
                <tr key={i} className="border-t border-slate-100">
                  {kind === 'EMBROIDERY' && <td className="px-2 py-1"><input className="input h-8 w-16" type="number" disabled={ro} value={c.needle_no} onChange={(e) => upd({ needle_no: e.target.value })} /></td>}
                  <td className="px-2 py-1"><input className="input h-8 w-40" disabled={ro} value={c.color_name} onChange={(e) => upd({ color_name: e.target.value })} /></td>
                  <td className="px-2 py-1"><select className="input h-8 w-56" disabled={ro} value={c.trim_id} onChange={(e) => upd({ trim_id: e.target.value })}><option value="">—</option>{(materials.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.code} · {t.label}</option>)}</select></td>
                  {kind === 'EMBROIDERY' && <td className="px-2 py-1"><input className="input h-8 w-24" type="number" disabled={ro} value={c.stitches} onChange={(e) => upd({ stitches: e.target.value })} /></td>}
                  <td className="px-2 py-1">{!ro && <button className="text-red-500" onClick={() => set({ colors: cur.colors.filter((_: any, j: number) => j !== i) })}><Trash2 size={13} /></button>}</td>
                </tr>
              );
            })}</tbody>
          </table> : <p className="py-2 text-xs text-slate-400">No colours listed</p>}
        </Section>
        {row.id && (detail.data?.versions?.length ?? 0) > 1 && <Section title="Versions">
          <MiniTable rows={detail.data.versions} cols={[{ h: 'Version', r: (v) => `v${v.version_no}` }, { h: 'Status', r: (v) => <Badge tone={ST_TONE[v.status]}>{human(v.status)}</Badge> }, { h: 'Approved', r: (v) => fmtDate(v.approved_at) }]} />
        </Section>}
      </div>
    </Modal>
  );
}

// ───────────────────────────── recipes ─────────────────────────────
function Recipes({ kind }: { kind: Kind }) {
  const p = usePerm(kind);
  const [f, setF] = useState({ status: '', q: '' });
  const list = useGet<any[]>(`${BASE[kind]}/recipes`, { status: f.status || undefined, q: f.q || undefined });
  const [open, setOpen] = useState<any>(null);
  return (
    <Card title={kind === 'EMBROIDERY' ? 'Thread & consumable recipes' : 'Dyes & chemical recipes'}
      subtitle={kind === 'EMBROIDERY' ? 'Standard per piece or per 1,000 stitches (thread factor) with loss %' : 'Standard per recipe base qty (e.g. grams per 100 PCS) with loss % — Required = Qty ÷ Base × Standard × (1 + Loss %)'}
      actions={p.master && <Button size="sm" id="mp-recipe-new" onClick={() => setOpen({})}><Plus size={13} className="mr-1 inline" />New recipe</Button>}>
      <div className="flex flex-wrap items-end gap-3 p-3">
        <Select label="Status" className="w-40" value={f.status} placeholder="All" onChange={(e) => setF({ ...f, status: e.target.value })} options={['DRAFT', 'APPROVED', 'OBSOLETE'].map((s) => ({ value: s, label: human(s) }))} />
        <Input label="Search" placeholder="Recipe no / name" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <DataTable data={list.data ?? []} loading={list.loading} emptyTitle="No recipes yet" onRowClick={(r: any) => setOpen(r)}
        columns={[
          { key: 'recipe_no', header: 'Recipe', render: (r: any) => <span className="font-mono font-semibold text-brand-700">{r.recipe_no} <span className="text-slate-400">v{r.version_no}</span></span> },
          { key: 'recipe_name', header: 'Name' },
          { key: 'design_code', header: 'Design', render: (r: any) => r.design_code ? `${r.design_code} v${r.design_version}` : '—' },
          { key: 'base', header: 'Base', render: (r: any) => `${qty(r.base_qty)} ${r.base_uom}` },
          { key: 'item_count', header: 'Materials', align: 'right' as const },
          { key: 'effective_from', header: 'Effective', render: (r: any) => fmtDate(r.effective_from) },
          { key: 'status', header: 'Status', render: (r: any) => <Badge tone={ST_TONE[r.status]}>{human(r.status)}</Badge> },
        ]} />
      {open && <RecipeEditor kind={kind} row={open} onClose={() => setOpen(null)} onSaved={(d) => { void list.reload(); setOpen(d); }} />}
    </Card>
  );
}

function RecipeEditor({ kind, row, onClose, onSaved }: { kind: Kind; row: any; onClose: () => void; onSaved: (d: any) => void }) {
  const toast = useToast();
  const p = usePerm(kind);
  const uoms = useLookup('uoms');
  const materials = useGet<any[]>(`${BASE[kind]}/materials`);
  const designs = useGet<any[]>(`${BASE[kind]}/designs`, { status: 'APPROVED' });
  const detail = useGet<any>(row.id ? `${BASE[kind]}/recipes/${row.id}` : null);
  const r0 = detail.data ?? row;
  const [d, setD] = useState<any>(null);
  const cur = d ?? {
    recipe_no: r0.recipe_no ?? '', recipe_name: r0.recipe_name ?? '', design_id: r0.design_id ?? '', base_qty: r0.base_qty ?? (kind === 'PRINTING' ? 100 : 1), base_uom: r0.base_uom ?? 'PCS',
    effective_from: r0.effective_from ?? '', remarks: r0.remarks ?? '',
    items: (r0.items ?? []).map((i: any) => ({ trim_id: i.trim_id, material_role: i.material_role, basis: i.basis, std_qty: i.std_qty, uom_id: i.uom_id, per_stock_unit: i.per_stock_unit, loss_pct: i.loss_pct, remarks: i.remarks ?? '' })),
  };
  const set = (x: any) => setD({ ...cur, ...x });
  const [busy, setBusy] = useState(false);
  const [calc, setCalc] = useState<{ qty: string; rows: any[] | null }>({ qty: '1000', rows: null });
  const status = r0.status ?? 'DRAFT';
  const ro = !p.master || (row.id && status !== 'DRAFT');
  const mat = (id: unknown) => (materials.data ?? []).find((m: any) => String(m.id) === String(id));
  const blank = () => ({ trim_id: '', material_role: ROLES[kind][0], basis: kind === 'EMBROIDERY' ? 'PER_PIECE' : 'PER_BASE', std_qty: '', uom_id: '', per_stock_unit: '', loss_pct: '', remarks: '' });
  const payload = () => ({
    recipe_no: cur.recipe_no || null, recipe_name: cur.recipe_name, design_id: cur.design_id || null, base_qty: num(cur.base_qty) || 1, base_uom: cur.base_uom, effective_from: cur.effective_from || null, remarks: cur.remarks || null,
    items: cur.items.map((i: any) => ({ trim_id: num(i.trim_id), material_role: i.material_role, basis: i.basis, std_qty: num(i.std_qty), uom_id: num(i.uom_id), per_stock_unit: i.per_stock_unit === '' || i.per_stock_unit == null ? null : num(i.per_stock_unit), loss_pct: num(i.loss_pct), remarks: i.remarks || null })),
  });
  const act = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true);
    try { const r = await fn(); toast(msg); setD(null); onSaved(r.data.data); void detail.reload(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const runCalc = async () => {
    try { const r = await api.get(`${BASE[kind]}/recipes/${row.id}/requirement`, { params: { qty: num(calc.qty) } }); setCalc({ ...calc, rows: r.data.data }); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const upd = (i: number, x: any) => set({ items: cur.items.map((y: any, j: number) => (j === i ? { ...y, ...x } : y)) });
  return (
    <Modal open size="full" onClose={onClose} title={row.id ? `Recipe ${cur.recipe_no} v${r0.version_no ?? 1} · ${human(status)}` : 'New recipe'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {row.id && status === 'DRAFT' && (p.master || p.approve) && <Button variant="secondary" loading={busy} id="mp-recipe-approve" onClick={() => act(() => api.post(`${BASE[kind]}/recipes/${row.id}/approve`), 'Recipe approved')}><CheckCircle2 size={13} className="mr-1 inline" />Approve</Button>}
        {row.id && status !== 'DRAFT' && p.master && <Button variant="secondary" loading={busy} onClick={() => act(() => api.post(`${BASE[kind]}/recipes/${row.id}/new-version`), 'New draft version made')}><Copy size={13} className="mr-1 inline" />New version</Button>}
        {row.id && status === 'APPROVED' && (p.master || p.approve) && <Button variant="secondary" loading={busy} onClick={() => act(() => api.post(`${BASE[kind]}/recipes/${row.id}/obsolete`), 'Marked obsolete')}><Ban size={13} className="mr-1 inline" />Obsolete</Button>}
        {!ro && <Button loading={busy} id="mp-recipe-save" onClick={() => act(() => (row.id ? api.put(`${BASE[kind]}/recipes/${row.id}`, payload()) : api.post(`${BASE[kind]}/recipes`, payload())), 'Recipe saved (draft)')}><Save size={13} className="mr-1 inline" />Save draft</Button>}
      </>}>
      <div className="space-y-4">
        {ro && row.id && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">This version is {human(status).toLowerCase()} and cannot be changed{p.master ? ' — use "New version"' : ''}.</p>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <Input label="Recipe no" placeholder="Auto" disabled={ro || !!row.id} value={cur.recipe_no} onChange={(e) => set({ recipe_no: e.target.value })} />
          <Input label="Recipe name" required id="mp-recipe-name" className="md:col-span-2" disabled={ro} value={cur.recipe_name} onChange={(e) => set({ recipe_name: e.target.value })} />
          <Select label="Design (optional)" disabled={ro} value={cur.design_id} placeholder="— any —" onChange={(e) => set({ design_id: e.target.value })}
            options={(designs.data ?? []).map((x: any) => ({ value: x.id, label: `${x.design_code} v${x.version_no}${x.total_stitches ? ` · ${qty(x.total_stitches, 0)} st` : ''}` }))} />
          <Input label="Base qty (per-base lines)" type="number" disabled={ro} value={cur.base_qty} onChange={(e) => set({ base_qty: e.target.value })} />
          <Select label="Base UOM" disabled={ro} value={cur.base_uom} onChange={(e) => set({ base_uom: e.target.value })} options={['PCS', 'KG', 'MTR'].map((u) => ({ value: u, label: u }))} />
          <Input label="Effective from" type="date" disabled={ro} value={cur.effective_from ?? ''} onChange={(e) => set({ effective_from: e.target.value })} />
          <Input label="Remarks" className="md:col-span-5" disabled={ro} value={cur.remarks} onChange={(e) => set({ remarks: e.target.value })} />
        </div>
        <Section title="Materials" actions={!ro && <Button size="sm" variant="secondary" id="mp-recipe-add-line" onClick={() => set({ items: [...cur.items, blank()] })}><Plus size={12} className="mr-1 inline" />Add material</Button>}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                <th className="px-2 py-1 text-left">Material (trims master)</th><th className="px-2 py-1 text-left">Role</th><th className="px-2 py-1 text-left">Basis</th>
                <th className="px-2 py-1 text-right">Std qty</th><th className="px-2 py-1 text-left">UOM</th><th className="px-2 py-1 text-right">Per stock unit</th><th className="px-2 py-1 text-right">Loss %</th><th />
              </tr></thead>
              <tbody>{cur.items.map((i: any, idx: number) => {
                const m = mat(i.trim_id);
                const diffUom = m && i.uom_id && String(m.base_uom) !== String(i.uom_id);
                return (
                  <tr key={idx} className="border-t border-slate-100">
                    <td className="px-2 py-1"><select className="input h-8 w-64" id={`mp-recipe-${idx}-trim`} disabled={ro} value={i.trim_id}
                      onChange={(e) => { const mm = mat(e.target.value); const role = ROLE_OF_TYPE[mm?.trim_type]; upd(idx, { trim_id: e.target.value, uom_id: i.uom_id || mm?.base_uom || '', ...(role && ROLES[kind].includes(role) ? { material_role: role } : {}) }); }}>
                      <option value="">— material —</option>{(materials.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.preferred ? '' : '· '}{t.code} · {t.label} ({t.uom_code}, stock {qty(t.stock_qty)})</option>)}</select></td>
                    <td className="px-2 py-1"><select className="input h-8 w-28" disabled={ro} value={i.material_role} onChange={(e) => upd(idx, { material_role: e.target.value })}>{ROLES[kind].map((r) => <option key={r} value={r}>{human(r)}</option>)}</select></td>
                    <td className="px-2 py-1"><select className="input h-8 w-40" id={`mp-recipe-${idx}-basis`} disabled={ro} value={i.basis} onChange={(e) => upd(idx, { basis: e.target.value })}>
                      <option value="PER_PIECE">Per piece</option><option value="PER_BASE">Per {qty(cur.base_qty)} {cur.base_uom}</option>
                      {kind === 'EMBROIDERY' && <option value="PER_1000_STITCH">Per 1,000 stitches</option>}</select></td>
                    <td className="px-2 py-1 text-right"><input className="input h-8 w-24 text-right" type="number" id={`mp-recipe-${idx}-qty`} disabled={ro} value={i.std_qty} onChange={(e) => upd(idx, { std_qty: e.target.value })} /></td>
                    <td className="px-2 py-1"><select className="input h-8 w-24" id={`mp-recipe-${idx}-uom`} disabled={ro} value={i.uom_id} onChange={(e) => upd(idx, { uom_id: e.target.value, per_stock_unit: '' })}><option value="">—</option>{toOptions(uoms.data).map((o) => <option key={o.value} value={o.value}>{(uoms.data ?? []).find((u: any) => u.id === o.value)?.code}</option>)}</select></td>
                    <td className="px-2 py-1 text-right">{diffUom
                      ? <span className="inline-flex items-center gap-1"><input className="input h-8 w-24 text-right" type="number" id={`mp-recipe-${idx}-factor`} placeholder="from UOM master" disabled={ro} value={i.per_stock_unit ?? ''} onChange={(e) => upd(idx, { per_stock_unit: e.target.value })} /><span className="text-slate-400">/ {m.uom_code}</span></span>
                      : <span className="text-slate-400">1</span>}</td>
                    <td className="px-2 py-1 text-right"><input className="input h-8 w-16 text-right" type="number" disabled={ro} value={i.loss_pct} onChange={(e) => upd(idx, { loss_pct: e.target.value })} /></td>
                    <td className="px-2 py-1">{!ro && <button className="text-red-500" onClick={() => set({ items: cur.items.filter((_: any, j: number) => j !== idx) })}><Trash2 size={13} /></button>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            <p className="mt-2 text-[11px] text-slate-500">Materials are trims items (types Thread, Backing, Topping … / Dye, Pigment, Binder, Chemical). When the recipe UOM differs from the stock UOM, give how many recipe units are in one stock unit (e.g. 5000 MTR per CONE) — KG→GM etc. come from the UOM master.</p>
          </div>
        </Section>
        {row.id && <Section title="Standard requirement calculator">
          <div className="flex items-end gap-2">
            <Input label="Production qty" type="number" id="mp-recipe-calc-qty" value={calc.qty} onChange={(e) => setCalc({ ...calc, qty: e.target.value })} />
            <Button size="sm" variant="secondary" id="mp-recipe-calc" onClick={runCalc}><Calculator size={12} className="mr-1 inline" />Calculate</Button>
          </div>
          {calc.rows && <div className="mt-2"><MiniTable rows={calc.rows} cols={[
            { h: 'Material', r: (l) => `${l.trim_code} · ${l.trim_name}` }, { h: 'Basis', r: (l) => human(l.basis) },
            { h: 'Standard', right: true, r: (l) => `${qty(l.standard_qty, 4)} ${l.uom_code}` }, { h: 'In stock units', right: true, r: (l) => `${qty(l.stock_qty, 4)} ${l.stock_uom_code}` },
            ...(p.costing ? [{ h: 'Std cost', right: true, r: (l: any) => money(l.std_cost) }] : []),
          ]} /></div>}
        </Section>}
      </div>
    </Modal>
  );
}

// ───────────────────────────── reasons ─────────────────────────────
function Reasons({ kind }: { kind: Kind }) {
  const toast = useToast();
  const p = usePerm(kind);
  const list = useGet<any[]>(`${BASE[kind]}/reasons`);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    try {
      const b = { ...edit, sort_order: num(edit.sort_order), needs_approval: !!num(edit.needs_approval), is_active: !!num(edit.is_active) };
      if (edit.id) await api.put(`${BASE[kind]}/reasons/${edit.id}`, b); else await api.post(`${BASE[kind]}/reasons`, b);
      toast('Reason saved'); setEdit(null); void list.reload();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  return (
    <Card title="Downtime and reject / rework reasons" subtitle="Controlled reason master — reject and rework are always recorded against a reason"
      actions={p.master && <Button size="sm" onClick={() => setEdit({ reason_type: 'DOWNTIME', reason_code: '', reason_name: '', sort_order: 0, needs_approval: 0, is_active: 1 })}><Plus size={13} className="mr-1 inline" />New reason</Button>}>
      <DataTable data={list.data ?? []} loading={list.loading} onRowClick={(r: any) => p.master && setEdit(r)}
        columns={[
          { key: 'reason_type', header: 'Type', render: (r: any) => <Badge tone={r.reason_type === 'DOWNTIME' ? 'amber' : 'red'}>{r.reason_type === 'DOWNTIME' ? 'Downtime' : 'Reject / rework'}</Badge> },
          { key: 'reason_code', header: 'Code', render: (r: any) => <span className="font-mono">{r.reason_code}</span> },
          { key: 'reason_name', header: 'Reason' },
          { key: 'needs_approval', header: 'Needs approval', render: (r: any) => (r.needs_approval ? 'Yes' : '—') },
          { key: 'is_active', header: 'Status', render: (r: any) => r.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge> },
        ]} />
      {edit && <Modal open onClose={() => setEdit(null)} title={edit.id ? `Reason ${edit.reason_code}` : 'New reason'}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}><Save size={13} className="mr-1 inline" />Save</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" value={edit.reason_type} onChange={(e) => setEdit({ ...edit, reason_type: e.target.value })} options={[{ value: 'DOWNTIME', label: 'Downtime' }, { value: 'REJECT', label: 'Reject / rework' }]} />
          <Input label="Code" required value={edit.reason_code} onChange={(e) => setEdit({ ...edit, reason_code: e.target.value })} />
          <Input label="Reason" required className="col-span-2" value={edit.reason_name} onChange={(e) => setEdit({ ...edit, reason_name: e.target.value })} />
          <Input label="Sort order" type="number" value={edit.sort_order} onChange={(e) => setEdit({ ...edit, sort_order: e.target.value })} />
          <div className="flex items-end gap-4 pb-1.5">
            <Checkbox label="Needs approval" checked={!!num(edit.needs_approval)} onChange={(v) => setEdit({ ...edit, needs_approval: v ? 1 : 0 })} />
            <Checkbox label="Active" checked={!!num(edit.is_active)} onChange={(v) => setEdit({ ...edit, is_active: v ? 1 : 0 })} />
          </div>
        </div>
      </Modal>}
    </Card>
  );
}
