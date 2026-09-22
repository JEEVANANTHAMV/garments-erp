import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, X, Route as RouteIcon, Pencil } from 'lucide-react';
import { http } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import {
  Modal, PageHeader, Input, Select, Textarea, Checkbox, LoadingBlock,
  EmptyState, SearchInput, Badge,
} from '../../components/ui';

/**
 * Process Route Master (doc §4).
 *
 * The process sequence is configuration, so a style can run
 * Dyeing → Winding → Knitting while another runs Winding → Twisting → Knitting.
 */

const PROCESS_TYPES = ['YARN_DYEING', 'WINDING', 'TWISTING', 'KNITTING', 'COLLAR_KNITTING'] as const;
const UNITS = ['INTERNAL', 'JOB_WORK', 'BOTH'] as const;

const PROCESS_COLORS: Record<string, string> = {
  YARN_DYEING: 'bg-rose-100 text-rose-800 border-rose-200',
  WINDING: 'bg-sky-100 text-sky-800 border-sky-200',
  TWISTING: 'bg-violet-100 text-violet-800 border-violet-200',
  KNITTING: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  COLLAR_KNITTING: 'bg-amber-100 text-amber-800 border-amber-200',
};

let _seq = 0;
interface Step {
  _key: string;
  seq_no: number;
  process_type: string;
  is_mandatory: boolean;
  default_loss_pct: number | '';
  allowed_unit: string;
  is_active: boolean;
}
const newStep = (seq: number): Step => ({
  _key: `s${++_seq}`, seq_no: seq, process_type: 'YARN_DYEING',
  is_mandatory: true, default_loss_pct: '', allowed_unit: 'BOTH', is_active: true,
});

const emptyForm = {
  route_code: '', route_name: '', yarn_id: '' as number | '',
  fabric_id: '' as number | '', remarks: '', is_active: true,
  lines: [] as Step[],
};

export default function ProcessRoutePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);

  const { data: yarns = [] } = useQuery({
    queryKey: ['lookups', 'yarns'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/yarns')).data || [],
  });
  const { data: fabrics = [] } = useQuery({
    queryKey: ['lookups', 'fabrics'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/fabrics')).data || [],
  });

  const { data: routes = [], isLoading, refetch } = useQuery({
    queryKey: ['process-routes', search],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (search) p.set('q', search);
      return (await http.get<{ data: any[] }>(`/process-routes?${p}`)).data || [];
    },
  });

  const setF = (k: string, v: any) => setForm((s) => ({ ...s, [k]: v }));
  const setStep = (key: string, patch: Partial<Step>) =>
    setForm((s) => ({ ...s, lines: s.lines.map((l) => (l._key === key ? { ...l, ...patch } : l)) }));

  const openNew = () => {
    setEditId(null);
    setForm({ ...emptyForm, lines: [newStep(1)] });
    setOpen(true);
  };

  const openEdit = async (id: number) => {
    const r = (await http.get<{ data: any }>(`/process-routes/${id}`)).data;
    setEditId(id);
    setForm({
      route_code: r.route_code ?? '', route_name: r.route_name ?? '',
      yarn_id: r.yarn_id ?? '', fabric_id: r.fabric_id ?? '',
      remarks: r.remarks ?? '', is_active: !!r.is_active,
      lines: (r.lines ?? []).map((l: any) => ({
        _key: `s${++_seq}`, seq_no: l.seq_no, process_type: l.process_type,
        is_mandatory: !!l.is_mandatory,
        default_loss_pct: l.default_loss_pct != null ? Number(l.default_loss_pct) : '',
        allowed_unit: l.allowed_unit, is_active: !!l.is_active,
      })),
    });
    setOpen(true);
  };

  const save = async () => {
    if (!form.route_code.trim() || !form.route_name.trim()) {
      toast('Route code and name are required', 'error'); return;
    }
    if (!form.lines.length) { toast('Add at least one process step', 'error'); return; }

    const payload = {
      route_code: form.route_code.trim(), route_name: form.route_name.trim(),
      yarn_id: form.yarn_id === '' ? null : Number(form.yarn_id),
      fabric_id: form.fabric_id === '' ? null : Number(form.fabric_id),
      remarks: form.remarks || null, is_active: form.is_active,
      lines: form.lines.map((l, i) => ({
        seq_no: i + 1, process_type: l.process_type, is_mandatory: l.is_mandatory,
        default_loss_pct: l.default_loss_pct === '' ? 0 : Number(l.default_loss_pct),
        allowed_unit: l.allowed_unit, is_active: l.is_active,
      })),
    };

    setSaving(true);
    try {
      if (editId) await http.put(`/process-routes/${editId}`, payload);
      else await http.post('/process-routes', payload);
      toast(editId ? 'Route updated' : 'Route created');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['process-routes'] });
    } catch (e: any) {
      toast(e?.message || 'Could not save the route', 'error');
    } finally { setSaving(false); }
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this process route?')) return;
    try {
      await http.del(`/process-routes/${id}`);
      toast('Route deleted');
      void qc.invalidateQueries({ queryKey: ['process-routes'] });
    } catch (e: any) { toast(e?.message || 'Could not delete the route', 'error'); }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Process Routes"
        subtitle="Configure the process sequence — dyeing, winding, twisting, knitting — per yarn or fabric"
        actions={
          <button className="btn-primary" onClick={openNew} id="btn-new-route">
            <Plus size={15} /> New Route
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search route code or name…" />
        <button className="btn-secondary" onClick={() => void refetch()}>Refresh</button>
      </div>

      {isLoading ? <LoadingBlock label="Loading routes…" /> : routes.length === 0 ? (
        <EmptyState
          icon={<RouteIcon size={22} />}
          title="No process routes yet"
          message="Create a route to define the sequence a yarn follows through the factory."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-[12px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="th text-left">Code</th>
                <th className="th text-left">Route Name</th>
                <th className="th text-left">Sequence</th>
                <th className="th text-left">Yarn / Fabric</th>
                <th className="th text-center">Steps</th>
                <th className="th text-center">Active</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r: any) => (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                  <td className="td font-mono font-semibold text-brand-700">{r.route_code}</td>
                  <td className="td font-medium">{r.route_name}</td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1">
                      {String(r.sequence_text || '').split(' → ').filter(Boolean).map((p, i) => (
                        <span key={i}
                          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${PROCESS_COLORS[p] ?? 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                          {p.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="td text-slate-600">{r.yarn_name || r.fabric_name || '— any —'}</td>
                  <td className="td text-center tabular-nums">{r.step_count}</td>
                  <td className="td text-center">
                    <Badge tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'Yes' : 'No'}</Badge>
                  </td>
                  <td className="td text-right">
                    <div className="flex justify-end gap-1">
                      <button className="btn-icon" title="Edit" onClick={() => void openEdit(r.id)}>
                        <Pencil size={14} />
                      </button>
                      <button className="btn-icon text-rose-600" title="Delete" onClick={() => void remove(r.id)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editId ? 'Edit Process Route' : 'New Process Route'}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setOpen(false)}><X size={14} /> Cancel</button>
            <button className="btn-primary" disabled={saving} onClick={() => void save()} id="btn-save-route">
              <Save size={14} /> {saving ? 'Saving…' : 'Save Route'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Route Code" required value={form.route_code}
              placeholder="e.g. R-DYE-WND-KNT"
              onChange={(e) => setF('route_code', e.target.value)} id="route-code" />
            <Input label="Route Name" required value={form.route_name}
              placeholder="e.g. Dyed Yarn → Winding → Knitting"
              onChange={(e) => setF('route_name', e.target.value)} id="route-name" />
            <Select label="Applicable Yarn" value={form.yarn_id} placeholder="— Any yarn —"
              onChange={(e) => setF('yarn_id', e.target.value ? Number(e.target.value) : '')} id="route-yarn">
              {yarns.map((y: any) => <option key={y.id} value={y.id}>{y.code} — {y.label}</option>)}
            </Select>
            <Select label="Applicable Fabric" value={form.fabric_id} placeholder="— Any fabric —"
              onChange={(e) => setF('fabric_id', e.target.value ? Number(e.target.value) : '')} id="route-fabric">
              {fabrics.map((f: any) => <option key={f.id} value={f.id}>{f.code} — {f.label}</option>)}
            </Select>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Process Sequence
              </h4>
              <button className="btn-secondary btn-sm"
                onClick={() => setForm((s) => ({ ...s, lines: [...s.lines, newStep(s.lines.length + 1)] }))}
                id="btn-add-step">
                <Plus size={13} /> Add Step
              </button>
            </div>

            {form.lines.length === 0 ? (
              <p className="py-4 text-center text-[12px] text-slate-400">
                No steps yet — add the processes this route runs through.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-[12px]">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="th w-12">#</th>
                      <th className="th text-left">Process</th>
                      <th className="th w-28">Loss %</th>
                      <th className="th w-32">Unit</th>
                      <th className="th w-24 text-center">Mandatory</th>
                      <th className="th w-12" />
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((l, i) => (
                      <tr key={l._key} className="border-t border-slate-100">
                        <td className="td text-center font-semibold text-slate-500">{i + 1}</td>
                        <td className="td p-1">
                          <select className="input text-[12px]" value={l.process_type}
                            onChange={(e) => setStep(l._key, { process_type: e.target.value })}
                            id={`step-type-${i}`}>
                            {PROCESS_TYPES.map((p) => (
                              <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>
                            ))}
                          </select>
                        </td>
                        <td className="td p-1">
                          <input className="input text-[12px]" type="number" step="0.001" min="0" max="100"
                            value={l.default_loss_pct} placeholder="0"
                            onChange={(e) => setStep(l._key, {
                              default_loss_pct: e.target.value === '' ? '' : Number(e.target.value),
                            })} id={`step-loss-${i}`} />
                        </td>
                        <td className="td p-1">
                          <select className="input text-[12px]" value={l.allowed_unit}
                            onChange={(e) => setStep(l._key, { allowed_unit: e.target.value })}
                            id={`step-unit-${i}`}>
                            {UNITS.map((u) => <option key={u} value={u}>{u.replace(/_/g, ' ')}</option>)}
                          </select>
                        </td>
                        <td className="td text-center">
                          <input type="checkbox" checked={l.is_mandatory}
                            onChange={(e) => setStep(l._key, { is_mandatory: e.target.checked })}
                            id={`step-mand-${i}`} />
                        </td>
                        <td className="td text-center">
                          <button className="btn-icon text-rose-600"
                            onClick={() => setForm((s) => ({
                              ...s, lines: s.lines.filter((x) => x._key !== l._key),
                            }))}>
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <Textarea label="Remarks" value={form.remarks}
            onChange={(e) => setF('remarks', e.target.value)} id="route-remarks" />
          <Checkbox label="Active" checked={form.is_active} onChange={(v) => setF('is_active', v)} />
        </div>
      </Modal>
    </div>
  );
}
