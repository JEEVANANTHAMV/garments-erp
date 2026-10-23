import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Save, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Card, Button, Input, Select, Modal, Badge, LoadingBlock, ErrorState } from '../../components/ui';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate } from '../../lib/format';
import { errMsg } from './sampleShared';

/**
 * Sample types and their stage templates (spec §4: no universal workflow — each type has a versioned template; a
 * sample keeps the version it was created with). Stages with the same step number run in parallel; a step starts
 * when every mandatory stage of the earlier steps is completed or skipped.
 */
const CATEGORIES = [
  { value: 'DEVELOPMENT', label: 'Development (proto, concept)' }, { value: 'FIT', label: 'Fit / sizing' },
  { value: 'SALES', label: 'Sales / marketing (SMS, photo)' }, { value: 'PRE_PRODUCTION', label: 'Pre-production (PP, TOP)' }, { value: 'OTHER', label: 'Other' },
];

export function SampleTypesPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['sample-types-admin'], queryFn: async () => (await http.get<{ data: any[] }>('/sample-types')).data });
  const [sel, setSel] = useState<number | null>(null);
  const [newType, setNewType] = useState(false);
  const types = q.data ?? [];
  const cur = types.find((t) => t.id === sel) ?? types[0];
  return (
    <div>
      <PageHeader title="Sample types & workflow" breadcrumb={['Masters & Setup']} subtitle="Each sample type has its own stage template (versioned)"
        actions={<>
          <Button variant="secondary" onClick={() => nav('/sales/samples')}><ArrowLeft size={15} />Samples</Button>
          {can('SAMPLE.ADMIN') && <Button id="type-new" onClick={() => setNewType(true)}><Plus size={15} />New type</Button>}
        </>} />
      {q.isLoading ? <div className="card"><LoadingBlock rows={6} /></div> : q.error ? <div className="card"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div className="card overflow-hidden" id="type-list">
            {types.map((t) => (
              <button key={t.id} type="button" onClick={() => setSel(t.id)} data-type={t.type_code}
                className={clsx('flex w-full items-center justify-between border-b border-slate-100 px-3.5 py-2.5 text-left text-[13px] last:border-0', cur?.id === t.id ? 'bg-brand-50' : 'hover:bg-slate-50')}>
                <span><b>{t.type_name}</b><span className="block text-[11px] text-slate-500">{t.type_code} · {t.stages.length} stages · v{t.version_no ?? '—'}</span></span>
                {!Number(t.is_active) && <Badge tone="slate">inactive</Badge>}
              </button>
            ))}
          </div>
          {cur && <TypeEditor key={`${cur.id}-${cur.workflow_id}`} t={cur} onSaved={() => void q.refetch()} />}
        </div>
      )}
      {newType && <NewTypeModal onClose={() => setNewType(false)} onDone={(id) => { setNewType(false); void q.refetch().then(() => setSel(id)); }} />}
    </div>
  );
}

interface StageRow { stage_code: string; stage_name: string; step_group: number; department_id: string | number; is_mandatory: boolean; sla_days: string | number; needs_output: boolean }

function TypeEditor({ t, onSaved }: { t: any; onSaved: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const depts = useLookup('departments');
  const editable = can('SAMPLE.ADMIN');
  const [head, setHead] = useState({ type_name: t.type_name, category: t.category, description: t.description ?? '', sort_order: t.sort_order ?? 0, is_active: !!Number(t.is_active) });
  const [rows, setRows] = useState<StageRow[]>(() => t.stages.map((x: any) => ({ stage_code: x.stage_code, stage_name: x.stage_name, step_group: Number(x.step_group), department_id: x.department_id ?? '',
    is_mandatory: !!Number(x.is_mandatory), sla_days: x.sla_days ?? '', needs_output: !!Number(x.needs_output) })));
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const versions = useQuery({ queryKey: ['sample-type-versions', t.id], queryFn: async () => (await http.get<{ data: any[] }>(`/sample-types/${t.id}/versions`)).data });
  useEffect(() => setDirty(false), [t.workflow_id]);
  const change = (n: StageRow[]) => { setRows(n); setDirty(true); };
  const move = (i: number, d: number) => { const n = [...rows]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; change(n); };
  const saveHead = async () => {
    setBusy(true);
    try { await http.put(`/sample-types/${t.id}`, { ...head, description: head.description || null }); toast('Sample type saved'); onSaved(); void qc.invalidateQueries({ queryKey: ['lookup', 'sample-types'] }); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const saveStages = async () => {
    setBusy(true);
    try {
      const r = await http.put<{ data: any }>(`/sample-types/${t.id}/workflow`, {
        remarks: remarks || null,
        stages: rows.map((x) => ({ ...x, department_id: Number(x.department_id) || null, sla_days: x.sla_days === '' ? null : Number(x.sla_days), step_group: Number(x.step_group) || 1 })),
      });
      toast(r.data.new_version ? `Saved as workflow v${r.data.version_no} — samples already made keep their version` : `Workflow v${r.data.version_no} updated`);
      setRemarks(''); setDirty(false); onSaved(); void versions.refetch();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <Card title={`${t.type_name} (${t.type_code})`} subtitle={`${t.sample_count} sample(s) of this type`}
        actions={editable && <Button size="sm" variant="secondary" loading={busy} onClick={() => void saveHead()}><Save size={13} />Save type</Button>}>
        <div className="grid gap-3 p-4 sm:grid-cols-4">
          <Input label="Name" value={head.type_name} disabled={!editable} onChange={(e) => setHead({ ...head, type_name: e.target.value })} />
          <Select label="Category" value={head.category} disabled={!editable} options={CATEGORIES} onChange={(e) => setHead({ ...head, category: e.target.value })} />
          <Input label="Order" type="number" value={head.sort_order} disabled={!editable} onChange={(e) => setHead({ ...head, sort_order: Number(e.target.value) })} />
          <Select label="Active" value={head.is_active ? '1' : '0'} disabled={!editable} options={[{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }]} onChange={(e) => setHead({ ...head, is_active: e.target.value === '1' })} />
          <Input className="sm:col-span-4" label="Description" value={head.description} disabled={!editable} onChange={(e) => setHead({ ...head, description: e.target.value })} />
        </div>
      </Card>
      <Card title={`Stages — workflow v${t.version_no ?? '—'}`} subtitle="Same step number = parallel. A step starts after every mandatory stage of the earlier steps is done. Optional stages can be skipped; skipping a mandatory one needs approval rights."
        actions={editable && <div className="flex items-center gap-2">{dirty && <Badge tone="amber">not saved</Badge>}
          <Button size="sm" variant="secondary" onClick={() => change([...rows, { stage_code: '', stage_name: '', step_group: (rows.at(-1)?.step_group ?? 0) + 1, department_id: '', is_mandatory: true, sla_days: '', needs_output: false }])}><Plus size={13} />Stage</Button>
          <Button size="sm" loading={busy} id="workflow-save" disabled={!dirty} onClick={() => void saveStages()}><Save size={13} />Save stages</Button></div>}>
        <div className="overflow-x-auto">
          <table className="w-full" id="workflow-stages">
            <thead><tr><th className="th w-16">Step</th><th className="th">Code</th><th className="th">Stage</th><th className="th">Department</th><th className="th">Mandatory</th><th className="th">SLA (days)</th><th className="th">Asks output qty</th>{editable && <th className="th" />}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="td"><input className="input h-8 w-14 py-0 text-[12px]" type="number" min={1} value={r.step_group} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, step_group: Number(e.target.value) } : x)))} /></td>
                  <td className="td"><input className="input h-8 w-28 py-0 font-mono text-[12px]" value={r.stage_code} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, stage_code: e.target.value.toUpperCase() } : x)))} /></td>
                  <td className="td"><input className="input h-8 py-0 text-[12px]" value={r.stage_name} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, stage_name: e.target.value } : x)))} /></td>
                  <td className="td"><select className="input h-8 py-0 text-[12px]" value={r.department_id} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, department_id: e.target.value } : x)))}>
                    <option value="">—</option>{toOptions(depts.data).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
                  <td className="td text-center"><input type="checkbox" checked={r.is_mandatory} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, is_mandatory: e.target.checked } : x)))} /></td>
                  <td className="td"><input className="input h-8 w-20 py-0 text-[12px]" type="number" min={0} step="0.5" value={r.sla_days} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, sla_days: e.target.value } : x)))} /></td>
                  <td className="td text-center"><input type="checkbox" checked={r.needs_output} disabled={!editable} onChange={(e) => change(rows.map((x, j) => (j === i ? { ...x, needs_output: e.target.checked } : x)))} /></td>
                  {editable && <td className="td whitespace-nowrap"><button className="p-1 text-slate-400 hover:text-slate-700" onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                    <button className="p-1 text-slate-400 hover:text-slate-700" onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                    <button className="p-1 text-red-400 hover:text-red-600" onClick={() => change(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable && dirty && <div className="border-t border-slate-100 p-3"><Input label="What changed (kept with the version)" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>}
      </Card>
      <Card title="Versions">
        <div className="p-3 text-[12.5px]">
          {(versions.data ?? []).map((w) => (
            <p key={w.id} className="border-b border-slate-100 py-1.5 last:border-0"><b>v{w.version_no}</b>{Number(w.is_current) ? <Badge tone="green" className="ml-1">current</Badge> : null}
              <span className="ml-2 text-slate-500">{fmtDate(w.effective_from)} · {w.stages.length} stages · {w.sample_count} sample(s){w.created_by_name ? ` · ${w.created_by_name}` : ''}{w.remarks ? ` · ${w.remarks}` : ''}</span></p>
          ))}
        </div>
      </Card>
    </div>
  );
}

function NewTypeModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const toast = useToast();
  const [v, setV] = useState({ type_code: '', type_name: '', category: 'OTHER' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { const r = await http.post<{ data: { id: number } }>('/sample-types', v); toast('Sample type created — add its stages'); onDone(r.data.id); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="New sample type" size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><Button loading={busy} disabled={!v.type_code.trim() || !v.type_name.trim()} onClick={() => void save()}>Create</Button></>}>
      <div className="grid gap-3">
        <Input label="Code" required value={v.type_code} placeholder="e.g. COUNTER" onChange={(e) => setV({ ...v, type_code: e.target.value.toUpperCase() })} />
        <Input label="Name" required value={v.type_name} onChange={(e) => setV({ ...v, type_name: e.target.value })} />
        <Select label="Category" value={v.category} options={CATEGORIES} onChange={(e) => setV({ ...v, category: e.target.value })} />
      </div>
    </Modal>
  );
}
