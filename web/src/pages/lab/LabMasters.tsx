import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { PageHeader, Button, Input, Select, Textarea, Checkbox, Tabs, Badge, Modal, LoadingBlock, ErrorState, FormSection } from '../../components/ui';
import { http } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate } from '../../lib/format';
import { LabStatus, errMsg, label, opts, criteriaText, TEST_SCOPES } from './labShared';

/** Lab masters (spec §4.5, §7): test plans (versioned), parameters, categories, units, methods, wash processes, machines.
 *  Masters are deactivated, never deleted. */

/* ================================================================ generic simple master */
interface FieldDef { key: string; label: string; type?: 'text' | 'number' | 'textarea' | 'select' | 'bool'; options?: { value: string; label: string }[]; required?: boolean; code?: boolean }
interface MasterDef { path: string; title: string; codeKey: string; fields: FieldDef[]; columns: { key: string; label: string }[] }

const MASTERS: Record<string, MasterDef> = {
  categories: { path: 'categories', title: 'Test categories', codeKey: 'code', columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'sort_order', label: 'Order' }],
    fields: [{ key: 'code', label: 'Code', required: true, code: true }, { key: 'name', label: 'Name', required: true }, { key: 'description', label: 'Description' }, { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'is_active', label: 'Active', type: 'bool' }] },
  units: { path: 'units', title: 'Units', codeKey: 'code', columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'symbol', label: 'Symbol' }, { key: 'dimension', label: 'Dimension' }],
    fields: [{ key: 'code', label: 'Code', required: true, code: true }, { key: 'name', label: 'Name', required: true }, { key: 'symbol', label: 'Symbol' },
      { key: 'dimension', label: 'Dimension', type: 'select', options: opts(['LENGTH', 'MASS', 'RATIO', 'GRADE', 'FORCE', 'PRESSURE', 'COUNT', 'TEMPERATURE', 'TIME', 'VOLUME', 'CONCENTRATION', 'OTHER']) }, { key: 'is_active', label: 'Active', type: 'bool' }] },
  methods: { path: 'methods', title: 'Test methods', codeKey: 'method_code', columns: [{ key: 'method_code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'standard_reference', label: 'Standard' }, { key: 'revision', label: 'Revision' }],
    fields: [{ key: 'method_code', label: 'Method code', required: true, code: true }, { key: 'name', label: 'Name', required: true }, { key: 'standard_reference', label: 'Standard reference' },
      { key: 'revision', label: 'Revision' }, { key: 'instructions', label: 'Work instruction', type: 'textarea' }, { key: 'is_active', label: 'Active', type: 'bool' }] },
  'wash-processes': { path: 'wash-processes', title: 'Wash processes', codeKey: 'code', columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'sort_order', label: 'Order' }],
    fields: [{ key: 'code', label: 'Code', required: true, code: true }, { key: 'name', label: 'Name', required: true }, { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'is_active', label: 'Active', type: 'bool' }] },
  machines: { path: 'machines', title: 'Lab machines', codeKey: 'machine_code', columns: [{ key: 'machine_code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'machine_type', label: 'Type' }, { key: 'capacity', label: 'Capacity' }, { key: 'status', label: 'Status' }],
    fields: [{ key: 'machine_code', label: 'Machine code', required: true, code: true }, { key: 'name', label: 'Name', required: true }, { key: 'machine_type', label: 'Machine type' },
      { key: 'capacity', label: 'Capacity', type: 'number' }, { key: 'capacity_uom', label: 'Capacity unit' }, { key: 'status', label: 'Status', type: 'select', options: opts(['AVAILABLE', 'IN_USE', 'MAINTENANCE', 'OUT_OF_ORDER']) },
      { key: 'is_active', label: 'Active', type: 'bool' }] },
};

function SimpleMaster({ def }: { def: MasterDef }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['lab-master', def.path], queryFn: async () => (await http.get<{ data: any[] }>(`/lab/${def.path}`)).data });
  const [edit, setEdit] = useState<any>(null);
  const admin = can('LAB.ADMIN');
  return (
    <div className="card overflow-x-auto">
      <div className="flex items-center justify-between border-b border-surface-border px-4 py-2">
        <p className="text-title font-semibold">{def.title}</p>
        {admin && <Button id={`lab-${def.path}-new`} size="sm" onClick={() => setEdit({ is_active: true })}><Plus size={14} />Add</Button>}
      </div>
      {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} /> : (
        <table className="w-full" id={`lab-${def.path}-list`}>
          <thead><tr>{def.columns.map((c) => <th key={c.key} className="th">{c.label}</th>)}<th className="th">Active</th><th className="th" /></tr></thead>
          <tbody>
            {(q.data ?? []).length === 0 && <tr><td colSpan={def.columns.length + 2} className="td text-center text-ink-muted">None yet</td></tr>}
            {(q.data ?? []).map((r) => (
              <tr key={r.id} className="row-hover">
                {def.columns.map((c) => <td key={c.key} className="td">{c.key === 'status' ? <LabStatus value={r[c.key]} /> : r[c.key] == null ? '—' : String(r[c.key])}</td>)}
                <td className="td">{Number(r.is_active) ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}</td>
                <td className="td">{admin && <button type="button" className="text-small text-brand-700 hover:underline" onClick={() => setEdit({ ...r, is_active: !!Number(r.is_active) })}>Edit</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <SimpleEditor def={def} row={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function SimpleEditor({ def, row, onClose }: { def: MasterDef; row: any; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [v, setV] = useState<Record<string, any>>(Object.fromEntries(def.fields.map((f) => [f.key, f.type === 'bool' ? row[f.key] ?? true : row[f.key] == null ? '' : String(row[f.key])])));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const body = Object.fromEntries(def.fields.filter((f) => !(row.id && f.code)).map((f) => [f.key, f.type === 'bool' ? v[f.key] : v[f.key] === '' ? null : v[f.key]]));
      if (row.id) await http.put(`/lab/${def.path}/${row.id}`, body); else await http.post(`/lab/${def.path}`, body);
      void qc.invalidateQueries({ queryKey: ['lab-master', def.path] }); void qc.invalidateQueries({ queryKey: ['lab-form-options'] });
      toast('Saved'); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`${row.id ? 'Edit' : 'New'} — ${def.title}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="lab-master-save" loading={busy} onClick={() => void go()}>Save</Button></>}>
      <div className="space-y-3">
        {def.fields.map((f) => f.type === 'bool' ? <Checkbox key={f.key} label={f.label} checked={!!v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} />
          : f.type === 'select' ? <Select key={f.key} label={f.label} placeholder="—" options={f.options} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            : f.type === 'textarea' ? <Textarea key={f.key} label={f.label} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              : <Input key={f.key} name={`m-${f.key}`} label={f.label} required={f.required} type={f.type === 'number' ? 'number' : 'text'} step="any" disabled={!!(row.id && f.code)} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />)}
        {err && <p className="text-small text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}

export function LabMachinesPage() {
  return <div><PageHeader title="Lab machines" breadcrumb={['Lab', 'Masters']} subtitle="Washers, dryers and testers used by lab trials" /><SimpleMaster def={MASTERS.machines} /></div>;
}

/* ================================================================ parameters (+ categories / units / methods / wash processes) */
const INPUT_TYPES = ['NUMERIC', 'BEFORE_AFTER', 'MULTI_READING', 'GRADE', 'PASS_FAIL', 'DROPDOWN', 'TEXT', 'PHOTO'];
const FORMULAS_FOR: Record<string, string[]> = { NUMERIC: ['DIRECT'], BEFORE_AFTER: ['SHRINKAGE_PCT', 'CHANGE_PCT'], MULTI_READING: ['AVERAGE', 'MIN', 'MAX'], GRADE: ['DIRECT'], PASS_FAIL: ['NONE'], DROPDOWN: ['NONE'], TEXT: ['NONE'], PHOTO: ['NONE'] };
const FORMULA_LABEL: Record<string, string> = { DIRECT: 'Direct value', SHRINKAGE_PCT: 'Shrinkage % = (before − after) ÷ before × 100', CHANGE_PCT: 'Change % = (after − before) ÷ before × 100', AVERAGE: 'Average', MIN: 'Minimum', MAX: 'Maximum', NONE: 'Qualitative' };

export function LabParametersPage() {
  const [tab, setTab] = useState('parameters');
  return (
    <div>
      <PageHeader title="Test parameters" breadcrumb={['Lab', 'Masters']} subtitle="What is measured, its unit, precision and formula — limits are set per test plan" />
      <Tabs active={tab} onChange={setTab} tabs={[{ key: 'parameters', label: 'Parameters' }, { key: 'categories', label: 'Categories' }, { key: 'units', label: 'Units' }, { key: 'methods', label: 'Methods' }, { key: 'wash-processes', label: 'Wash processes' }]} />
      {tab === 'parameters' ? <ParameterList /> : <SimpleMaster key={tab} def={MASTERS[tab]} />}
    </div>
  );
}

function ParameterList() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['lab-master', 'parameters'], queryFn: async () => (await http.get<{ data: any[] }>('/lab/parameters')).data });
  const [edit, setEdit] = useState<any>(null);
  return (
    <div className="card overflow-x-auto">
      <div className="flex items-center justify-end border-b border-surface-border px-4 py-2">{can('LAB.ADMIN') && <Button id="lab-param-new" size="sm" onClick={() => setEdit({ input_type: 'NUMERIC', precision_dp: 2, is_active: true })}><Plus size={14} />Add parameter</Button>}</div>
      {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} /> : (
        <table className="w-full" id="lab-param-list">
          <thead><tr><th className="th">Code</th><th className="th">Name</th><th className="th">Category</th><th className="th">Input</th><th className="th">Formula</th><th className="th">Unit</th><th className="th text-right">Decimals</th><th className="th">Active</th><th className="th" /></tr></thead>
          <tbody>{(q.data ?? []).map((p) => (
            <tr key={p.id} className="row-hover">
              <td className="td font-medium">{p.code}</td><td className="td">{p.name}</td><td className="td">{p.category_name ?? '—'}</td><td className="td">{label(p.input_type)}</td>
              <td className="td text-small">{label(p.formula_code)}</td><td className="td">{p.unit_symbol ?? '—'}{p.reading_unit_symbol && p.reading_unit_symbol !== p.unit_symbol ? ` (readings ${p.reading_unit_symbol})` : ''}</td>
              <td className="td text-right">{p.precision_dp}</td><td className="td">{Number(p.is_active) ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>}</td>
              <td className="td">{can('LAB.ADMIN') && <button type="button" className="text-small text-brand-700 hover:underline" onClick={() => setEdit({ ...p, is_active: !!Number(p.is_active) })}>Edit</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {edit && <ParameterEditor row={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ParameterEditor({ row, onClose }: { row: any; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const cats = useQuery({ queryKey: ['lab-master', 'categories'], queryFn: async () => (await http.get<{ data: any[] }>('/lab/categories', { active: 1 })).data });
  const units = useQuery({ queryKey: ['lab-master', 'units'], queryFn: async () => (await http.get<{ data: any[] }>('/lab/units', { active: 1 })).data });
  const methods = useQuery({ queryKey: ['lab-master', 'methods'], queryFn: async () => (await http.get<{ data: any[] }>('/lab/methods', { active: 1 })).data });
  const s = (x: unknown) => (x == null ? '' : String(x));
  const [v, setV] = useState<Record<string, any>>({ code: s(row.code), name: s(row.name), description: s(row.description), category_id: s(row.category_id), input_type: row.input_type,
    formula_code: s(row.formula_code) || FORMULAS_FOR[row.input_type][0], unit_id: s(row.unit_id), reading_unit_id: s(row.reading_unit_id), precision_dp: s(row.precision_dp),
    allowed_values: s(row.allowed_values), default_method_id: s(row.default_method_id), is_active: row.is_active });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const body = { ...v, category_id: v.category_id || null, unit_id: v.unit_id || null, reading_unit_id: v.reading_unit_id || null, default_method_id: v.default_method_id || null,
        description: v.description || null, allowed_values: v.allowed_values || null };
      if (row.id) await http.put(`/lab/parameters/${row.id}`, body); else await http.post('/lab/parameters', body);
      void qc.invalidateQueries({ queryKey: ['lab-master', 'parameters'] }); toast('Parameter saved'); onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const uo = (units.data ?? []).map((u) => ({ value: u.id, label: `${u.code} (${u.symbol ?? ''})` }));
  return (
    <Modal open onClose={onClose} title={row.id ? `Edit ${row.code}` : 'New parameter'} subtitle="Plans and trials keep their own snapshot — editing never changes a historical result"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button id="lab-param-save" loading={busy} onClick={() => void go()}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input name="p-code" label="Code" required disabled={!!row.id} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} />
        <Input name="p-name" label="Name" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Select label="Category" placeholder="—" options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} value={v.category_id} onChange={(e) => setV({ ...v, category_id: e.target.value })} />
        <Select name="p-input" label="Input type" options={opts(INPUT_TYPES)} value={v.input_type} onChange={(e) => setV({ ...v, input_type: e.target.value, formula_code: FORMULAS_FOR[e.target.value][0] })} />
        <Select label="Formula" className="sm:col-span-2" options={FORMULAS_FOR[v.input_type].map((f) => ({ value: f, label: FORMULA_LABEL[f] }))} value={v.formula_code} onChange={(e) => setV({ ...v, formula_code: e.target.value })} />
        <Select label="Result unit" placeholder="—" options={uo} value={v.unit_id} onChange={(e) => setV({ ...v, unit_id: e.target.value })} />
        <Select label="Reading unit" placeholder="—" options={uo} value={v.reading_unit_id} onChange={(e) => setV({ ...v, reading_unit_id: e.target.value })} />
        <Input label="Decimals (rounding)" type="number" min="0" max="6" value={v.precision_dp} onChange={(e) => setV({ ...v, precision_dp: e.target.value })} />
        <Select label="Default method" placeholder="—" options={(methods.data ?? []).map((m) => ({ value: m.id, label: `${m.method_code} — ${m.name}` }))} value={v.default_method_id} onChange={(e) => setV({ ...v, default_method_id: e.target.value })} />
        {['GRADE', 'DROPDOWN'].includes(v.input_type) && <Input label="Choices / grade scale (comma separated)" className="sm:col-span-2" value={v.allowed_values} onChange={(e) => setV({ ...v, allowed_values: e.target.value })} />}
        <Textarea label="Description" className="sm:col-span-2" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        <Checkbox label="Active" checked={!!v.is_active} onChange={(x) => setV({ ...v, is_active: x })} />
        {err && <p className="text-small text-red-600 sm:col-span-2">{err}</p>}
      </div>
    </Modal>
  );
}

/* ================================================================ test plans */
export function LabTestPlansPage() {
  const { can } = useAuth();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['lab-plans', all], queryFn: async () => (await http.get<{ data: any[] }>('/lab/test-plans', { all: all ? 1 : undefined })).data });
  const [edit, setEdit] = useState<number | 'new' | null>(null);
  return (
    <div>
      <PageHeader title="Test plans" breadcrumb={['Lab', 'Masters']} subtitle="Versioned plans by buyer / style / product / fabric — a version used by a request is never changed; editing makes the next version"
        actions={can('LAB.ADMIN') && <Button id="lab-plan-new" onClick={() => setEdit('new')}><Plus size={15} />New plan</Button>} />
      <div className="card mb-3 p-3"><Checkbox label="Show every version" checked={all} onChange={setAll} /></div>
      <div className="card overflow-x-auto">
        {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} /> : (
          <table className="w-full" id="lab-plan-list">
            <thead><tr><th className="th">Plan</th><th className="th">Name</th><th className="th">Applies to</th><th className="th">Scope</th><th className="th">Effective</th><th className="th text-right">Parameters</th><th className="th text-right">Requests</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody>
              {(q.data ?? []).length === 0 && <tr><td colSpan={9} className="td text-center text-ink-muted">No test plans</td></tr>}
              {(q.data ?? []).map((p) => (
                <tr key={p.id} className="row-hover">
                  <td className="td font-medium">{p.plan_code} v{p.version_no}</td><td className="td">{p.name}</td>
                  <td className="td text-small">{[p.buyer_name, p.style_code, p.product_name, p.fabric_type].filter(Boolean).join(' · ') || 'Any'}</td>
                  <td className="td text-small">{(p.test_scope ?? []).map(label).join(', ') || 'Any'}</td>
                  <td className="td text-small">{p.effective_from ? fmtDate(p.effective_from) : '—'} → {p.effective_to ? fmtDate(p.effective_to) : 'open'}</td>
                  <td className="td text-right">{p.param_count}</td><td className="td text-right">{p.request_count}</td><td className="td"><LabStatus value={p.status} /></td>
                  <td className="td"><button type="button" className="text-small text-brand-700 hover:underline" onClick={() => setEdit(Number(p.id))}>{can('LAB.ADMIN') ? 'Open / edit' : 'Open'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <PlanEditor id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onOpen={(x) => setEdit(x)} />}
    </div>
  );
}

interface PP { parameter_id: string; method_id: string; is_mandatory: boolean; repeat_count: string; min_value: string; max_value: string; target_value: string; tolerance: string; borderline_band: string; pass_values: string; evidence_required: boolean }
const s3 = (x: unknown) => (x == null ? '' : String(Number(x)) === 'NaN' ? String(x) : String(Number(x)));

function PlanEditor({ id, onClose, onOpen }: { id: number | null; onClose: () => void; onOpen: (id: number) => void }) {
  const { can } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const admin = can('LAB.ADMIN');
  const buyers = useLookup('buyers'); const styles = useLookup('styles'); const products = useLookup('products'); const comps = useLookup('compositions');
  const params = useQuery({ queryKey: ['lab-master', 'parameters'], queryFn: async () => (await http.get<{ data: any[] }>('/lab/parameters')).data });
  const methods = useQuery({ queryKey: ['lab-master', 'methods'], queryFn: async () => (await http.get<{ data: any[] }>('/lab/methods', { active: 1 })).data });
  const detail = useQuery({ queryKey: ['lab-plan', id], enabled: !!id, queryFn: async () => (await http.get<{ data: any }>(`/lab/test-plans/${id}`)).data });
  const [h, setH] = useState<Record<string, any> | null>(id ? null : { plan_code: '', name: '', buyer_id: '', style_id: '', product_id: '', fabric_type: '', composition_id: '', effective_from: '', effective_to: '', status: 'ACTIVE', remarks: '' });
  const [scope, setScope] = useState<string[]>([]);
  const [rows, setRows] = useState<PP[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  if (id && detail.data && !h) {
    const d = detail.data; const s = (x: unknown) => (x == null ? '' : String(x));
    setH({ plan_code: d.plan_code, name: d.name, buyer_id: s(d.buyer_id), style_id: s(d.style_id), product_id: s(d.product_id), fabric_type: s(d.fabric_type), composition_id: s(d.composition_id),
      effective_from: s(d.effective_from).slice(0, 10), effective_to: s(d.effective_to).slice(0, 10), status: d.status === 'SUPERSEDED' ? 'ACTIVE' : d.status, remarks: s(d.remarks) });
    setScope(d.test_scope ?? []);
    setRows(d.params.map((p: any) => ({ parameter_id: String(p.parameter_id), method_id: s(p.method_id), is_mandatory: !!Number(p.is_mandatory), repeat_count: String(p.repeat_count),
      min_value: s3(p.min_value), max_value: s3(p.max_value), target_value: s3(p.target_value), tolerance: s3(p.tolerance), borderline_band: s3(p.borderline_band), pass_values: s(p.pass_values), evidence_required: !!Number(p.evidence_required) })));
  }
  const up = (i: number, k: keyof PP, val: any) => setRows((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
  const nn = (x: string) => (x === '' ? null : Number(x));
  const save = async () => {
    if (!h) return;
    setBusy(true); setErr('');
    try {
      const body = { ...h, buyer_id: h.buyer_id || null, style_id: h.style_id || null, product_id: h.product_id || null, fabric_type: h.fabric_type || null, composition_id: h.composition_id || null,
        effective_from: h.effective_from || null, effective_to: h.effective_to || null, remarks: h.remarks || null, test_scope: scope,
        params: rows.filter((r) => r.parameter_id).map((r, i) => ({ parameter_id: Number(r.parameter_id), method_id: r.method_id ? Number(r.method_id) : null, seq_no: (i + 1) * 10, is_mandatory: r.is_mandatory,
          repeat_count: Number(r.repeat_count || 1), min_value: nn(r.min_value), max_value: nn(r.max_value), target_value: nn(r.target_value), tolerance: nn(r.tolerance), borderline_band: nn(r.borderline_band),
          pass_values: r.pass_values || null, evidence_required: r.evidence_required })) };
      const res = id ? await http.put<{ data: any }>(`/lab/test-plans/${id}`, body) : await http.post<{ data: any }>('/lab/test-plans', body);
      void qc.invalidateQueries({ queryKey: ['lab-plans'] }); void qc.invalidateQueries({ queryKey: ['lab-plan'] });
      toast(res.data.new_version ? `Saved as version ${res.data.version_no} (the old version is used by requests)` : 'Plan saved');
      onClose();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const setStatus = async (status: string) => {
    try { await http.post(`/lab/test-plans/${id}/status`, { status }); void qc.invalidateQueries({ queryKey: ['lab-plans'] }); void detail.refetch(); toast(`Plan ${label(status)}`); setH((x) => (x ? { ...x, status } : x)); }
    catch (e) { setErr(errMsg(e)); }
  };
  const d = detail.data;
  return (
    <Modal open onClose={onClose} size="xl" title={id ? `${d?.plan_code ?? ''} v${d?.version_no ?? ''}` : 'New test plan'}
      subtitle={d ? `${label(d.status)} · used by ${d.request_count} request(s)${Number(d.request_count) ? ' — saving makes the next version' : ''}` : 'Each parameter row carries the method and acceptance limits'}
      footerStart={d?.versions?.length > 1 && <span className="text-small">Versions: {d.versions.map((x: any) => <button key={x.id} type="button" className={`mr-2 hover:underline ${x.id === id ? 'font-semibold' : 'text-brand-700'}`} onClick={() => onOpen(x.id)}>v{x.version_no} ({label(x.status)})</button>)}</span>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {admin && id && d && d.status !== 'ACTIVE' && <Button variant="secondary" onClick={() => void setStatus('ACTIVE')}>Activate</Button>}
        {admin && id && d && d.status === 'ACTIVE' && <Button variant="secondary" onClick={() => void setStatus('INACTIVE')}>Deactivate</Button>}
        {admin && <Button id="lab-plan-save" loading={busy} onClick={() => void save()}>Save</Button>}
      </>}>
      {id && detail.isLoading || !h ? <LoadingBlock /> : (
        <div>
          <FormSection title="Plan">
            <Input name="plan-code" label="Plan code" required disabled={!!id} value={h.plan_code} onChange={(e) => setH({ ...h, plan_code: e.target.value })} />
            <Input name="plan-name" label="Name" required className="sm:col-span-2" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} />
            <Select name="plan-status" label="Status" options={opts(['DRAFT', 'ACTIVE', 'INACTIVE'])} value={h.status} onChange={(e) => setH({ ...h, status: e.target.value })} />
            <Select label="Buyer" placeholder="Any buyer" options={toOptions(buyers.data)} value={h.buyer_id} onChange={(e) => setH({ ...h, buyer_id: e.target.value })} />
            <Select label="Style" placeholder="Any style" options={toOptions(styles.data)} value={h.style_id} onChange={(e) => setH({ ...h, style_id: e.target.value })} />
            <Select label="Product category" placeholder="Any" options={toOptions(products.data)} value={h.product_id} onChange={(e) => setH({ ...h, product_id: e.target.value })} />
            <Select label="Fabric type" placeholder="Any" options={opts(['KNIT', 'WOVEN', 'NON_WOVEN', 'OTHER'])} value={h.fabric_type} onChange={(e) => setH({ ...h, fabric_type: e.target.value })} />
            <Select label="Fibre composition" placeholder="Any" options={toOptions(comps.data)} value={h.composition_id} onChange={(e) => setH({ ...h, composition_id: e.target.value })} />
            <Input label="Effective from" type="date" value={h.effective_from} onChange={(e) => setH({ ...h, effective_from: e.target.value })} />
            <Input label="Effective to" type="date" value={h.effective_to} onChange={(e) => setH({ ...h, effective_to: e.target.value })} />
            <Input label="Remarks" value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} />
          </FormSection>
          <FormSection title="Request types (blank = any)" cols={3}>
            {TEST_SCOPES.map((x) => <Checkbox key={x} label={label(x)} checked={scope.includes(x)} onChange={(c) => setScope((s) => (c ? [...s, x] : s.filter((y) => y !== x)))} />)}
          </FormSection>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1200px]" id="lab-plan-params">
              <thead><tr><th className="th">Parameter</th><th className="th">Method</th><th className="th">Mand.</th><th className="th text-right">Readings</th><th className="th text-right">Min</th><th className="th text-right">Max</th>
                <th className="th text-right">Target</th><th className="th text-right">± Tol</th><th className="th text-right">Borderline</th><th className="th">Pass values</th><th className="th">Evidence</th><th className="th">Shown as</th><th className="th" /></tr></thead>
              <tbody>{rows.map((r, i) => {
                const p = (params.data ?? []).find((x) => String(x.id) === r.parameter_id);
                const numIn = (k: keyof PP, w = 'w-20') => <input className={`input ${w} text-right`} type="number" step="any" disabled={!admin} value={r[k] as string} onChange={(e) => up(i, k, e.target.value)} />;
                return (
                  <tr key={i}>
                    <td className="td"><select name={`pp-param-${i}`} className="input w-56" disabled={!admin} value={r.parameter_id} onChange={(e) => { const np = (params.data ?? []).find((x) => String(x.id) === e.target.value); up(i, 'parameter_id', e.target.value); if (np?.default_method_id && !r.method_id) up(i, 'method_id', String(np.default_method_id)); }}>
                      <option value="">—</option>{(params.data ?? []).filter((x) => Number(x.is_active) || String(x.id) === r.parameter_id).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</select>
                      {p && <p className="text-caption text-ink-secondary">{label(p.input_type)} · {p.unit_symbol ?? ''}</p>}</td>
                    <td className="td"><select className="input w-36" disabled={!admin} value={r.method_id} onChange={(e) => up(i, 'method_id', e.target.value)}><option value="">—</option>{(methods.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.method_code}</option>)}</select></td>
                    <td className="td"><input type="checkbox" disabled={!admin} checked={r.is_mandatory} onChange={(e) => up(i, 'is_mandatory', e.target.checked)} /></td>
                    <td className="td">{numIn('repeat_count', 'w-16')}</td><td className="td">{numIn('min_value')}</td><td className="td">{numIn('max_value')}</td>
                    <td className="td">{numIn('target_value')}</td><td className="td">{numIn('tolerance')}</td><td className="td">{numIn('borderline_band')}</td>
                    <td className="td"><input className="input w-32" disabled={!admin || !p || !['DROPDOWN'].includes(p.input_type)} value={r.pass_values} onChange={(e) => up(i, 'pass_values', e.target.value)} placeholder={p?.input_type === 'DROPDOWN' ? p.allowed_values : ''} /></td>
                    <td className="td"><input type="checkbox" disabled={!admin} checked={r.evidence_required} onChange={(e) => up(i, 'evidence_required', e.target.checked)} /></td>
                    <td className="td text-small text-ink-secondary">{criteriaText({ min_value: r.min_value, max_value: r.max_value, target_value: r.target_value, tolerance: r.tolerance, pass_values: r.pass_values })}</td>
                    <td className="td">{admin && <button type="button" aria-label="Remove parameter" className="text-ink-muted hover:text-red-600" onClick={() => setRows((xs) => xs.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          {admin && <Button id="lab-plan-add-param" variant="secondary" className="mt-3" onClick={() => setRows((xs) => [...xs, { parameter_id: '', method_id: '', is_mandatory: true, repeat_count: '1', min_value: '', max_value: '', target_value: '', tolerance: '', borderline_band: '', pass_values: '', evidence_required: false }])}><Plus size={14} />Add parameter</Button>}
          {err && <p id="lab-plan-error" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-small text-red-700">{err}</p>}
        </div>
      )}
    </Modal>
  );
}
