import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Plus, Search, Eye, Trash2, X, Save, Layers,
  RefreshCw, AlertCircle, FileText,
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Modal, PageHeader, Input, Spinner, LoadingBlock } from '../../components/ui';
import { useQuery as useQ } from '@tanstack/react-query';

/* ─────────────────────────────────────────────────────────────────
   Constants & Types
───────────────────────────────────────────────────────────────── */
const PARTS = ['TOP', 'BOTTOM', 'COLLAR', 'CUFF', 'FOLDING', 'OTHER'] as const;
const KNITTING_TYPES = ['SOLID', 'STRIPE', 'FEEDER_STRIPE', 'ENGINEERED_STRIPE', 'MULTI_YARN', 'OTHER'] as const;
const STATUS_LIST = [
  'DRAFT', 'STOCK_CHECK', 'RESERVED', 'RELEASED',
  'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED',
  'OUTPUT_RECEIPT', 'COMPLETED', 'CANCELLED',
] as const;

const PART_COLORS: Record<string, string> = {
  TOP: 'bg-sky-100 text-sky-800 border-sky-200',
  BOTTOM: 'bg-violet-100 text-violet-800 border-violet-200',
  COLLAR: 'bg-rose-100 text-rose-800 border-rose-200',
  CUFF: 'bg-amber-100 text-amber-800 border-amber-200',
  FOLDING: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  OTHER: 'bg-slate-100 text-slate-700 border-slate-200',
};

let _yarnSeq = 0;
let _stripeSeq = 0;

interface YarnLine {
  _key: string;
  id?: number;
  seq_no: number;
  yarn_id: number | '';
  yarn_name_manual: string;
  count_value: string;
  colour: string;
  yarn_po_no: string;
  yarn_lot_no: string;
  planning_ratio_pct: number | '';
  planned_qty_kg: number | '';
  reserved_qty_kg: number;
  issued_qty_kg: number;
}

interface StripeLine {
  _key: string;
  id?: number;
  seq_no: number;
  program_yarn_id: number | '';
  yarn_label: string;
  colour: string;
  courses: number | '';
  notes: string;
}

const newYarnLine = (seq: number): YarnLine => ({
  _key: `y${++_yarnSeq}`, seq_no: seq, yarn_id: '', yarn_name_manual: '',
  count_value: '', colour: '', yarn_po_no: '', yarn_lot_no: '',
  planning_ratio_pct: '', planned_qty_kg: '', reserved_qty_kg: 0, issued_qty_kg: 0,
});

const newStripeLine = (seq: number): StripeLine => ({
  _key: `s${++_stripeSeq}`, seq_no: seq, program_yarn_id: '',
  yarn_label: '', colour: '', courses: '', notes: '',
});

const emptyForm = () => ({
  program_no: '',
  program_date: today(),
  so_id: '' as number | '',
  so_line_id: '' as number | '',
  io_no: '',
  buyer_po_no: '',
  style_id: '' as number | '',
  part_name: 'TOP' as typeof PARTS[number],
  fabric_id: '' as number | '',
  fabric_type: '',
  knitting_type: 'SOLID' as typeof KNITTING_TYPES[number],
  gsm: '',
  dia: '',
  gauge: '',
  loop_length: '',
  required_qty_kg: '' as number | '',
  required_date: '',
  job_work_type: 'INTERNAL' as 'INTERNAL' | 'JOB_WORK',
  vendor_id: '' as number | '',
  status: 'DRAFT' as typeof STATUS_LIST[number],
  remarks: '',
  yarns: [newYarnLine(1)] as YarnLine[],
  stripes: [] as StripeLine[],
});

/* ─────────────────────────────────────────────────────────────────
   Main Page
───────────────────────────────────────────────────────────────── */
export default function KnittingProgramPage() {
  const qc = useQueryClient();
  const toast = useToast();

  // Filters
  const [search, setSearch] = useState('');
  const [partFilter, setPartFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [knittingTypeFilter, setKnittingTypeFilter] = useState('ALL');

  // Modal state
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'yarns' | 'stripes' | 'issues'>('yarns');

  // Form state
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  // Lookups
  const { data: yarns = [] } = useQ({
    queryKey: ['lookups', 'yarns'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/yarns')).data || [],
  });
  const { data: styles = [] } = useQ({
    queryKey: ['lookups', 'styles'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/styles')).data || [],
  });
  const { data: fabrics = [] } = useQ({
    queryKey: ['lookups', 'fabrics'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/fabrics')).data || [],
  });
  const { data: soLines = [] } = useQ({
    queryKey: ['lookups', 'sales-order-lines'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/sales-order-lines')).data || [],
  });
  const { data: parties = [] } = useQ({
    queryKey: ['lookups', 'parties'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/parties')).data || [],
  });

  // Programs list
  const { data: programs = [], isLoading, refetch } = useQ({
    queryKey: ['knitting-programs', partFilter, statusFilter, knittingTypeFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: '100' });
      if (search) params.set('q', search);
      if (partFilter !== 'ALL') params.set('part_name', partFilter);
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (knittingTypeFilter !== 'ALL') params.set('knitting_type', knittingTypeFilter);
      return (await http.get<{ data: any[] }>(`/knitting/programs?${params}`)).data || [];
    },
  });

  // Single program detail
  const { data: detail, isLoading: detailLoading } = useQ({
    queryKey: ['knitting-program', detailId],
    queryFn: async () => (await http.get<{ data: any }>(`/knitting/programs/${detailId}`)).data,
    enabled: !!detailId,
  });

  const openCreate = () => {
    setEditId(null);
    setForm(emptyForm());
    setActiveTab('yarns');
    setShowForm(true);
  };

  const openEdit = (prog: any) => {
    setEditId(prog.id);
    setActiveTab('yarns');

    const loadedYarns: YarnLine[] = (prog.yarns ?? []).map((y: any) => ({
      _key: `y${++_yarnSeq}`, id: y.id, seq_no: y.seq_no,
      yarn_id: y.yarn_id ?? '', yarn_name_manual: y.yarn_name_manual ?? '',
      count_value: y.count_value ?? '', colour: y.colour ?? '',
      yarn_po_no: y.yarn_po_no ?? '', yarn_lot_no: y.yarn_lot_no ?? '',
      planning_ratio_pct: y.planning_ratio_pct !== null && y.planning_ratio_pct !== undefined
        ? Number(y.planning_ratio_pct) : '',
      planned_qty_kg: Number(y.planned_qty_kg) || '',
      reserved_qty_kg: Number(y.reserved_qty_kg) || 0,
      issued_qty_kg: Number(y.issued_qty_kg) || 0,
    }));

    const loadedStripes: StripeLine[] = (prog.stripes ?? []).map((s: any) => ({
      _key: `s${++_stripeSeq}`, id: s.id, seq_no: s.seq_no,
      program_yarn_id: s.program_yarn_id ?? '',
      yarn_label: s.yarn_label ?? '', colour: s.colour ?? '',
      courses: Number(s.courses) || '', notes: s.notes ?? '',
    }));

    setForm({
      program_no: prog.program_no ?? '',
      program_date: prog.program_date ? prog.program_date.split('T')[0] : today(),
      so_id: prog.so_id ?? '',
      so_line_id: prog.so_line_id ?? '',
      io_no: prog.io_no ?? '',
      buyer_po_no: prog.buyer_po_no ?? '',
      style_id: prog.style_id ?? '',
      part_name: prog.part_name ?? 'TOP',
      fabric_id: prog.fabric_id ?? '',
      fabric_type: prog.fabric_type ?? '',
      knitting_type: prog.knitting_type ?? 'SOLID',
      gsm: prog.gsm ?? '',
      dia: prog.dia ?? '',
      gauge: prog.gauge ?? '',
      loop_length: prog.loop_length ?? '',
      required_qty_kg: Number(prog.required_qty_kg) || '',
      required_date: prog.required_date ? prog.required_date.split('T')[0] : '',
      job_work_type: prog.job_work_type ?? 'INTERNAL',
      vendor_id: prog.vendor_id ?? '',
      status: prog.status ?? 'DRAFT',
      remarks: prog.remarks ?? '',
      yarns: loadedYarns.length ? loadedYarns : [newYarnLine(1)],
      stripes: loadedStripes,
    });
    setShowForm(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...form,
        so_id: form.so_id === '' ? null : Number(form.so_id),
        so_line_id: form.so_line_id === '' ? null : Number(form.so_line_id),
        style_id: form.style_id === '' ? null : Number(form.style_id),
        fabric_id: form.fabric_id === '' ? null : Number(form.fabric_id),
        vendor_id: form.vendor_id === '' ? null : Number(form.vendor_id),
        required_qty_kg: Number(form.required_qty_kg) || 0,
        yarns: form.yarns.map((y, i) => ({
          ...y,
          seq_no: i + 1,
          yarn_id: y.yarn_id === '' ? null : Number(y.yarn_id),
          planning_ratio_pct: y.planning_ratio_pct === '' ? null : Number(y.planning_ratio_pct),
          planned_qty_kg: Number(y.planned_qty_kg) || 0,
        })),
        stripes: form.stripes.map((s, i) => ({
          ...s,
          seq_no: i + 1,
          program_yarn_id: s.program_yarn_id === '' ? null : Number(s.program_yarn_id),
          courses: Number(s.courses) || 0,
        })),
      };

      if (editId) {
        await http.put(`/knitting/programs/${editId}`, payload);
        toast('Knitting program updated');
      } else {
        await http.post('/knitting/programs', payload);
        toast('Knitting program created');
      }

      void qc.invalidateQueries({ queryKey: ['knitting-programs'] });
      void qc.invalidateQueries({ queryKey: ['knitting-program'] });
      setShowForm(false);
    } catch (e: any) {
      toast(e?.message ?? 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const deleteProg = async (id: number) => {
    if (!confirm('Delete this knitting program?')) return;
    try {
      await http.del(`/knitting/programs/${id}`);
      toast('Program deleted');
      void qc.invalidateQueries({ queryKey: ['knitting-programs'] });
    } catch (e: any) {
      toast(e?.message ?? 'Delete failed', 'error');
    }
  };

  const setF = (k: string, v: unknown) => setForm((s) => ({ ...s, [k]: v }));

  const addYarnLine = () =>
    setForm((s) => ({ ...s, yarns: [...s.yarns, newYarnLine(s.yarns.length + 1)] }));

  const removeYarnLine = (key: string) =>
    setForm((s) => ({ ...s, yarns: s.yarns.filter((y) => y._key !== key) }));

  const setYarn = (key: string, patch: Partial<YarnLine>) =>
    setForm((s) => ({
      ...s,
      yarns: s.yarns.map((y) => (y._key === key ? { ...y, ...patch } : y)),
    }));

  const addStripeLine = () =>
    setForm((s) => ({ ...s, stripes: [...s.stripes, newStripeLine(s.stripes.length + 1)] }));

  const removeStripeLine = (key: string) =>
    setForm((s) => ({ ...s, stripes: s.stripes.filter((st) => st._key !== key) }));

  const setStripe = (key: string, patch: Partial<StripeLine>) =>
    setForm((s) => ({
      ...s,
      stripes: s.stripes.map((st) => (st._key === key ? { ...st, ...patch } : st)),
    }));

  // Auto-fill count_value from selected yarn
  const handleYarnSelect = (key: string, yarnId: string) => {
    const y = yarns.find((y: any) => y.id === Number(yarnId));
    setYarn(key, {
      yarn_id: yarnId === '' ? '' : Number(yarnId),
      count_value: y?.count_value ?? y?.count_master_value ?? '',
    });
  };

  // The Sales Order line owns the part (the server enforces this too); selecting
  // a line prefills the SO, style and part so they cannot drift apart.
  const linkedPart: string | null = (() => {
    if (form.so_line_id === '') return null;
    const l = soLines.find((l: any) => l.id === Number(form.so_line_id));
    return l?.part_name ?? null;
  })();

  const onSoLineSelect = (value: string) => {
    const line = soLines.find((l: any) => l.id === Number(value));
    setForm((s) => ({
      ...s,
      so_line_id: value === '' ? '' : Number(value),
      so_id: line?.so_id ?? s.so_id,
      style_id: line?.style_id ?? s.style_id,
      part_name: (line?.part_name as any) ?? s.part_name,
    }));
  };

  const isStripeType = ['STRIPE', 'FEEDER_STRIPE', 'ENGINEERED_STRIPE', 'MULTI_YARN'].includes(form.knitting_type);

  const totalPlannedKg = form.yarns.reduce((sum, y) => sum + (Number(y.planned_qty_kg) || 0), 0);
  const totalRatio = form.yarns.reduce((sum, y) => sum + (Number(y.planning_ratio_pct) || 0), 0);

  return (
    <>
      <PageHeader
        breadcrumb={['Production', 'Knitting Programs']}
        title="Knitting Programs"
        subtitle="Plan multi-yarn knitting with stripe patterns and full yarn traceability"
        actions={
          <button className="btn-primary" onClick={openCreate} id="btn-new-knitting-program">
            <Plus size={15} /> New Program
          </button>
        }
      />

      {/* Filters */}
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-8 w-full"
            placeholder="Program no, I/O No, Buyer PO…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            id="knitting-programs-search"
          />
        </div>
        <select className="input w-36" value={partFilter} onChange={(e) => setPartFilter(e.target.value)} id="filter-part">
          <option value="ALL">All Parts</option>
          {PARTS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input w-40" value={knittingTypeFilter} onChange={(e) => setKnittingTypeFilter(e.target.value)} id="filter-knitting-type">
          <option value="ALL">All Types</option>
          {KNITTING_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
        <select className="input w-44" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} id="filter-status">
          <option value="ALL">All Statuses</option>
          {STATUS_LIST.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <button className="btn-secondary" onClick={() => void refetch()}>
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Programs Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <LoadingBlock rows={6} />
        ) : programs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-400">
              <Layers size={26} />
            </div>
            <p className="text-[14px] font-semibold text-slate-700">No knitting programs found</p>
            <p className="text-[12px] text-slate-400">Create your first program to plan yarn usage and stripe patterns</p>
            <button className="btn-primary mt-1" onClick={openCreate}>
              <Plus size={14} /> Create Knitting Program
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Program No</th>
                  <th className="th">Date</th>
                  <th className="th">I/O No</th>
                  <th className="th">Style</th>
                  <th className="th">Part</th>
                  <th className="th">Type</th>
                  <th className="th text-right">Required KG</th>
                  <th className="th text-right">Planned KG</th>
                  <th className="th text-right">Issued KG</th>
                  <th className="th">Status</th>
                  <th className="th">Actions</th>
                </tr>
              </thead>
              <tbody>
                {programs.map((p: any) => (
                  <tr key={p.id} className="row-hover">
                    <td className="td font-mono text-[12px] font-semibold text-brand-700">
                      {p.program_no}
                    </td>
                    <td className="td text-slate-500">{fmtDate(p.program_date)}</td>
                    <td className="td font-medium">{p.io_no ?? '—'}</td>
                    <td className="td">
                      {p.style_code ? (
                        <span className="font-medium text-slate-800">{p.style_code}</span>
                      ) : '—'}
                      {p.style_name && <span className="block text-[11px] text-slate-400">{p.style_name}</span>}
                    </td>
                    <td className="td">
                      {p.part_name ? (
                        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${PART_COLORS[p.part_name] ?? PART_COLORS.OTHER}`}>
                          {p.part_name}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="td text-slate-600 text-[11px]">
                      {p.knitting_type?.replace(/_/g, ' ')}
                    </td>
                    <td className="td text-right tabular-nums font-medium">
                      {fmtDecimal(p.required_qty_kg, 2)}
                    </td>
                    <td className="td text-right tabular-nums text-brand-700 font-semibold">
                      {fmtDecimal(p.total_planned_yarn_kg, 2)}
                    </td>
                    <td className="td text-right tabular-nums text-emerald-700 font-semibold">
                      {fmtDecimal(p.total_issued_yarn_kg, 2)}
                    </td>
                    <td className="td">
                      <StatusPill status={p.status} />
                    </td>
                    <td className="td">
                      <div className="flex items-center gap-1.5">
                        <button
                          id={`btn-view-kp-${p.id}`}
                          className="rounded p-1.5 text-slate-400 hover:bg-brand-50 hover:text-brand-600"
                          title="View detail"
                          onClick={() => { setDetailId(p.id); setActiveTab('yarns'); }}
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          id={`btn-edit-kp-${p.id}`}
                          className="rounded p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600"
                          title="Edit"
                          onClick={() => openEdit(p)}
                        >
                          <FileText size={14} />
                        </button>
                        <button
                          id={`btn-delete-kp-${p.id}`}
                          className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          title="Delete"
                          onClick={() => void deleteProg(p.id)}
                        >
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
      </div>

      {/* Create / Edit Modal */}
      <Modal open={showForm} onClose={() => setShowForm(false)} title={editId ? 'Edit Knitting Program' : 'New Knitting Program'} size="xl">
        <div className="space-y-5 max-h-[80vh] overflow-y-auto pr-1">

          {/* Header fields */}
          <div>
            <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-brand-500 inline-block" />
              Program Details
            </h4>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <Input label="Program No" placeholder="Auto-generate" value={form.program_no}
                onChange={(e) => setF('program_no', e.target.value)} id="kp-program-no" />
              <Input label="Program Date" type="date" value={form.program_date}
                onChange={(e) => setF('program_date', e.target.value)} id="kp-program-date" />
              <Input label="I/O Number" value={form.io_no}
                onChange={(e) => setF('io_no', e.target.value)} id="kp-io-no" />
              <Input label="Buyer PO No" value={form.buyer_po_no}
                onChange={(e) => setF('buyer_po_no', e.target.value)} id="kp-buyer-po" />
              <select className="input" value={form.so_line_id} onChange={(e) => onSoLineSelect(e.target.value)} id="kp-so-line">
                <option value="">— Sales Order line (optional) —</option>
                {soLines.map((l: any) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <select className="input" value={form.style_id} onChange={(e) => setF('style_id', e.target.value ? Number(e.target.value) : '')} id="kp-style">
                <option value="">— Style —</option>
                {styles.map((s: any) => <option key={s.id} value={s.id}>{s.style_code} — {s.label}</option>)}
              </select>
              <div>
                <select className="input w-full" value={form.part_name}
                  onChange={(e) => setF('part_name', e.target.value)}
                  disabled={linkedPart !== null} id="kp-part">
                  {PARTS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                {linkedPart && (
                  <p className="mt-1 text-[10px] text-slate-500">Part follows the linked Sales Order line</p>
                )}
              </div>
              <select className="input" value={form.knitting_type} onChange={(e) => setF('knitting_type', e.target.value)} id="kp-knitting-type">
                {KNITTING_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
              <select className="input" value={form.status} onChange={(e) => setF('status', e.target.value)} id="kp-status">
                {STATUS_LIST.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          </div>

          {/* Fabric specification */}
          <div>
            <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
              Fabric Specification
            </h4>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <select className="input" value={form.fabric_id} onChange={(e) => setF('fabric_id', e.target.value ? Number(e.target.value) : '')} id="kp-fabric">
                <option value="">— Fabric —</option>
                {fabrics.map((f: any) => <option key={f.id} value={f.id}>{f.fabric_code} — {f.label}</option>)}
              </select>
              <Input label="Fabric Type" placeholder="e.g. Single Jersey, Rib" value={form.fabric_type}
                onChange={(e) => setF('fabric_type', e.target.value)} id="kp-fabric-type" />
              <Input label="GSM (Target)" value={form.gsm}
                onChange={(e) => setF('gsm', e.target.value)} id="kp-gsm" />
              <Input label="Dia (Target)" value={form.dia}
                onChange={(e) => setF('dia', e.target.value)} id="kp-dia" />
              <Input label="Gauge" placeholder="e.g. 24 GG" value={form.gauge}
                onChange={(e) => setF('gauge', e.target.value)} id="kp-gauge" />
              <Input label="Loop Length" value={form.loop_length}
                onChange={(e) => setF('loop_length', e.target.value)} id="kp-loop-length" />
              <Input label="Required Qty (KG)" type="number" step="0.001" value={form.required_qty_kg}
                onChange={(e) => setF('required_qty_kg', e.target.value === '' ? '' : Number(e.target.value))} id="kp-req-qty" />
              <Input label="Required Date" type="date" value={form.required_date}
                onChange={(e) => setF('required_date', e.target.value)} id="kp-req-date" />
              <select className="input" value={form.job_work_type} onChange={(e) => setF('job_work_type', e.target.value)} id="kp-job-type">
                <option value="INTERNAL">Internal</option>
                <option value="JOB_WORK">Job Work</option>
              </select>
              {form.job_work_type === 'JOB_WORK' && (
                <select className="input" value={form.vendor_id} onChange={(e) => setF('vendor_id', e.target.value ? Number(e.target.value) : '')} id="kp-vendor">
                  <option value="">— Vendor —</option>
                  {parties.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              )}
            </div>
          </div>

          {/* Tabs: Yarn Combination | Stripe Pattern */}
          <div>
            <div className="flex items-center gap-1 border-b border-slate-200 mb-4">
              {(['yarns', ...(isStripeType ? ['stripes'] : [])] as const).map((t) => (
                <button
                  key={t}
                  className={`px-4 py-2 text-[12px] font-semibold border-b-2 -mb-px transition-colors ${
                    activeTab === t
                      ? 'border-brand-500 text-brand-700'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                  onClick={() => setActiveTab(t as any)}
                  id={`tab-kp-${t}`}
                >
                  {t === 'yarns' ? '🧵 Yarn Combination' : '🎨 Stripe Pattern'}
                </button>
              ))}
            </div>

            {/* Yarn Combination Tab */}
            {activeTab === 'yarns' && (
              <div>
                {/* Header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <p className="text-[12px] font-semibold text-slate-700">
                      {form.yarns.length} Yarn Line{form.yarns.length !== 1 ? 's' : ''}
                    </p>
                    {totalPlannedKg > 0 && (
                      <span className="rounded bg-brand-50 border border-brand-200 px-2 py-0.5 text-[11px] font-semibold text-brand-800">
                        Total: {fmtDecimal(totalPlannedKg, 2)} KG
                      </span>
                    )}
                    {isStripeType && totalRatio > 0 && (
                      <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${
                        Math.abs(totalRatio - 100) < 0.01 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'
                      }`}>
                        Ratio: {totalRatio.toFixed(1)}% {Math.abs(totalRatio - 100) < 0.01 ? '✓' : '(must = 100%)'}
                      </span>
                    )}
                  </div>
                  <button className="btn-secondary btn-sm" onClick={addYarnLine} id="btn-add-yarn-line">
                    <Plus size={13} /> Add Yarn
                  </button>
                </div>

                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-[12px]">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="th w-8">#</th>
                        <th className="th">Yarn (Master)</th>
                        <th className="th">Count</th>
                        <th className="th">Colour</th>
                        <th className="th">
                          Yarn PO No
                          <span className="ml-1 text-[10px] font-normal text-brand-600">(Traceability)</span>
                        </th>
                        <th className="th">Lot No</th>
                        {isStripeType && <th className="th text-right">Ratio %</th>}
                        <th className="th text-right">Planned KG</th>
                        <th className="th text-right">Issued KG</th>
                        <th className="th w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {form.yarns.map((y, idx) => (
                        <tr key={y._key} className="border-t border-slate-100">
                          <td className="td text-center text-slate-500 font-semibold">{idx + 1}</td>
                          <td className="td p-1">
                            <select
                              className="input text-[12px] w-full"
                              value={y.yarn_id}
                              onChange={(e) => handleYarnSelect(y._key, e.target.value)}
                              id={`yarn-select-${idx}`}
                            >
                              <option value="">— Select Yarn —</option>
                              {yarns.map((yn: any) => (
                                <option key={yn.id} value={yn.id}>
                                  {yn.yarn_code} — {yn.label ?? yn.yarn_name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="td p-1">
                            <input className="input text-[12px] w-24" value={y.count_value}
                              placeholder="e.g. 30s"
                              onChange={(e) => setYarn(y._key, { count_value: e.target.value })}
                              id={`yarn-count-${idx}`} />
                          </td>
                          <td className="td p-1">
                            <input className="input text-[12px] w-28" value={y.colour}
                              placeholder="e.g. Navy"
                              onChange={(e) => setYarn(y._key, { colour: e.target.value })}
                              id={`yarn-colour-${idx}`} />
                          </td>
                          <td className="td p-1">
                            <input className="input text-[12px] w-32 border-brand-300 focus:border-brand-500 focus:ring-brand-500/20"
                              value={y.yarn_po_no}
                              placeholder="YPO-2026-001"
                              title="Yarn Purchase Order number — for full traceability"
                              onChange={(e) => setYarn(y._key, { yarn_po_no: e.target.value })}
                              id={`yarn-po-${idx}`} />
                          </td>
                          <td className="td p-1">
                            <input className="input text-[12px] w-28" value={y.yarn_lot_no}
                              placeholder="LOT-001"
                              onChange={(e) => setYarn(y._key, { yarn_lot_no: e.target.value })}
                              id={`yarn-lot-${idx}`} />
                          </td>
                          {isStripeType && (
                            <td className="td p-1">
                              <input type="number" step="0.01" min="0" max="100"
                                className="input text-[12px] w-20 text-right"
                                value={y.planning_ratio_pct}
                                placeholder="0.00"
                                onChange={(e) => setYarn(y._key, { planning_ratio_pct: e.target.value === '' ? '' : Number(e.target.value) })}
                                id={`yarn-ratio-${idx}`} />
                            </td>
                          )}
                          <td className="td p-1">
                            <input type="number" step="0.001" min="0"
                              className="input text-[12px] w-24 text-right"
                              value={y.planned_qty_kg}
                              placeholder="0.000"
                              onChange={(e) => setYarn(y._key, { planned_qty_kg: e.target.value === '' ? '' : Number(e.target.value) })}
                              id={`yarn-planned-kg-${idx}`} />
                          </td>
                          <td className="td text-right text-emerald-700 font-semibold tabular-nums">
                            {fmtDecimal(y.issued_qty_kg, 2)}
                          </td>
                          <td className="td p-1">
                            {form.yarns.length > 1 && (
                              <button
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                onClick={() => removeYarnLine(y._key)}
                                id={`btn-remove-yarn-${idx}`}
                              >
                                <X size={13} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {isStripeType && Math.abs(totalRatio - 100) > 0.01 && totalRatio > 0 && (
                  <div className="mt-2 flex items-center gap-2 text-[12px] text-amber-700">
                    <AlertCircle size={13} />
                    Planning ratios should total 100% for stripe programs. Current: {totalRatio.toFixed(1)}%
                  </div>
                )}
              </div>
            )}

            {/* Stripe Pattern Tab */}
            {activeTab === 'stripes' && isStripeType && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[12px] font-semibold text-slate-700">
                    Course-based stripe sequence (repeats continuously)
                  </p>
                  <button className="btn-secondary btn-sm" onClick={addStripeLine} id="btn-add-stripe">
                    <Plus size={13} /> Add Stripe Row
                  </button>
                </div>

                {form.stripes.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-[12px] text-slate-400">
                    Add stripe rows to define the course-based repeat pattern
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full text-[12px]">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="th w-8">Seq</th>
                          <th className="th">Yarn Line Ref</th>
                          <th className="th">Yarn Label</th>
                          <th className="th">Colour</th>
                          <th className="th text-right">Courses</th>
                          <th className="th">Notes</th>
                          <th className="th w-8" />
                        </tr>
                      </thead>
                      <tbody>
                        {form.stripes.map((st, idx) => (
                          <tr key={st._key} className="border-t border-slate-100">
                            <td className="td text-center text-slate-500 font-semibold">{idx + 1}</td>
                            <td className="td p-1">
                              <select
                                className="input text-[12px] w-full"
                                value={st.program_yarn_id}
                                onChange={(e) => setStripe(st._key, { program_yarn_id: e.target.value === '' ? '' : Number(e.target.value) })}
                                id={`stripe-yarn-ref-${idx}`}
                              >
                                <option value="">— Yarn Line —</option>
                                {form.yarns.map((y, i) => (
                                  <option key={y._key} value={y.id ?? 0}>
                                    Line {i + 1} — {y.colour || y.count_value || `Yarn ${i + 1}`}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="td p-1">
                              <input className="input text-[12px] w-28" value={st.yarn_label}
                                placeholder="e.g. Navy 30s"
                                onChange={(e) => setStripe(st._key, { yarn_label: e.target.value })}
                                id={`stripe-label-${idx}`} />
                            </td>
                            <td className="td p-1">
                              <input className="input text-[12px] w-24" value={st.colour}
                                placeholder="e.g. Navy"
                                onChange={(e) => setStripe(st._key, { colour: e.target.value })}
                                id={`stripe-colour-${idx}`} />
                            </td>
                            <td className="td p-1">
                              <input type="number" min="0"
                                className="input text-[12px] w-20 text-right"
                                value={st.courses}
                                placeholder="0"
                                onChange={(e) => setStripe(st._key, { courses: e.target.value === '' ? '' : Number(e.target.value) })}
                                id={`stripe-courses-${idx}`} />
                            </td>
                            <td className="td p-1">
                              <input className="input text-[12px] w-36" value={st.notes}
                                onChange={(e) => setStripe(st._key, { notes: e.target.value })}
                                id={`stripe-notes-${idx}`} />
                            </td>
                            <td className="td p-1">
                              <button
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                onClick={() => removeStripeLine(st._key)}
                                id={`btn-remove-stripe-${idx}`}
                              >
                                <X size={13} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="bg-slate-50 border-t border-slate-200">
                        <tr>
                          <td colSpan={4} className="td font-semibold text-slate-700">Total Courses (1 repeat)</td>
                          <td className="td text-right font-bold text-brand-700 tabular-nums">
                            {form.stripes.reduce((s, r) => s + (Number(r.courses) || 0), 0)}
                          </td>
                          <td colSpan={2} />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Remarks */}
          <div>
            <label className="block text-[12px] font-medium text-slate-700 mb-1">Remarks</label>
            <textarea className="input w-full h-16 resize-none" value={form.remarks}
              onChange={(e) => setF('remarks', e.target.value)} id="kp-remarks" />
          </div>

          {/* Save buttons */}
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button className="btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving} id="btn-save-knitting-program">
              {saving ? <Spinner size={14} /> : <Save size={14} />}
              {editId ? 'Update Program' : 'Create Program'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Detail Drawer */}
      <Modal open={!!detailId} onClose={() => setDetailId(null)} title="Knitting Program Detail" size="xl">
        {detailLoading ? (
          <LoadingBlock rows={5} />
        ) : detail ? (
          <DetailView prog={detail} onEdit={() => { openEdit(detail); setDetailId(null); }} />
        ) : null}
      </Modal>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Status Pill
───────────────────────────────────────────────────────────────── */
function StatusPill({ status }: { status: string }) {
  const tones: Record<string, string> = {
    DRAFT: 'bg-slate-100 text-slate-600 border-slate-200',
    STOCK_CHECK: 'bg-blue-100 text-blue-700 border-blue-200',
    RESERVED: 'bg-indigo-100 text-indigo-700 border-indigo-200',
    RELEASED: 'bg-cyan-100 text-cyan-700 border-cyan-200',
    MATERIAL_ISSUED: 'bg-orange-100 text-orange-700 border-orange-200',
    IN_PROGRESS: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    PRODUCTION_COMPLETED: 'bg-lime-100 text-lime-700 border-lime-200',
    OUTPUT_RECEIPT: 'bg-teal-100 text-teal-700 border-teal-200',
    COMPLETED: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    CANCELLED: 'bg-red-100 text-red-700 border-red-200',
  };
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${tones[status] ?? tones.DRAFT}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Detail View inside the drawer
───────────────────────────────────────────────────────────────── */
function DetailView({ prog, onEdit }: { prog: any; onEdit: () => void }) {
  const [tab, setTab] = useState<'yarns' | 'stripes' | 'issues'>('yarns');

  return (
    <div className="space-y-4 max-h-[80vh] overflow-y-auto pr-1">
      {/* Program info grid */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-100 bg-slate-50 p-4 text-[12px] sm:grid-cols-3 lg:grid-cols-4">
        <InfoRow label="Program No" value={<span className="font-mono font-bold text-brand-700">{prog.program_no}</span>} />
        <InfoRow label="Date" value={fmtDate(prog.program_date)} />
        <InfoRow label="I/O No" value={prog.io_no ?? '—'} />
        <InfoRow label="Buyer PO" value={prog.buyer_po_no ?? '—'} />
        <InfoRow label="Style" value={prog.style_code ? `${prog.style_code} — ${prog.style_name}` : '—'} />
        <InfoRow label="Part" value={
          prog.part_name ? (
            <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-semibold ${PART_COLORS[prog.part_name] ?? PART_COLORS.OTHER}`}>
              {prog.part_name}
            </span>
          ) : '—'
        } />
        <InfoRow label="Knitting Type" value={prog.knitting_type?.replace(/_/g, ' ')} />
        <InfoRow label="Status" value={<StatusPill status={prog.status} />} />
        <InfoRow label="Fabric Type" value={prog.fabric_type ?? prog.fabric_name ?? '—'} />
        <InfoRow label="GSM" value={prog.gsm ?? '—'} />
        <InfoRow label="Dia" value={prog.dia ?? '—'} />
        <InfoRow label="Gauge" value={prog.gauge ?? '—'} />
        <InfoRow label="Required KG" value={<span className="font-semibold">{fmtDecimal(prog.required_qty_kg, 2)}</span>} />
        <InfoRow label="Required Date" value={fmtDate(prog.required_date)} />
        <InfoRow label="Job Work" value={prog.job_work_type?.replace(/_/g, ' ')} />
        {prog.vendor_name && <InfoRow label="Vendor" value={prog.vendor_name} />}
      </div>

      {/* Tabs */}
      <div>
        <div className="flex items-center gap-1 border-b border-slate-200 mb-3">
          {(['yarns', ...(prog.stripes?.length ? ['stripes'] : []), 'issues'] as const).map((t) => (
            <button key={t}
              className={`px-3 py-2 text-[12px] font-semibold border-b-2 -mb-px transition-colors ${
                tab === t ? 'border-brand-500 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
              onClick={() => setTab(t as any)}
              id={`detail-tab-${t}`}
            >
              {t === 'yarns' ? `🧵 Yarns (${prog.yarns?.length ?? 0})`
                : t === 'stripes' ? `🎨 Stripes (${prog.stripes?.length ?? 0})`
                : `📋 Issues (${prog.issues?.length ?? 0})`}
            </button>
          ))}
        </div>

        {tab === 'yarns' && (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">#</th>
                  <th className="th">Yarn</th>
                  <th className="th">Count</th>
                  <th className="th">Colour</th>
                  <th className="th text-brand-700">Yarn PO No</th>
                  <th className="th">Lot No</th>
                  <th className="th text-right">Ratio %</th>
                  <th className="th text-right">Planned KG</th>
                  <th className="th text-right">Reserved KG</th>
                  <th className="th text-right">Issued KG</th>
                  <th className="th text-right">Balance KG</th>
                </tr>
              </thead>
              <tbody>
                {(prog.yarns ?? []).map((y: any, i: number) => {
                  const balance = Number(y.planned_qty_kg) - Number(y.issued_qty_kg);
                  return (
                    <tr key={y.id ?? i} className="border-t border-slate-100">
                      <td className="td font-semibold text-slate-500">{y.seq_no}</td>
                      <td className="td font-medium text-slate-800">
                        {y.yarn_code ? `${y.yarn_code} — ${y.yarn_name}` : (y.yarn_name_manual || '—')}
                      </td>
                      <td className="td text-slate-600">{y.count_value || '—'}</td>
                      <td className="td">{y.colour || '—'}</td>
                      <td className="td">
                        {y.yarn_po_no ? (
                          <span className="font-mono text-brand-700 font-semibold">{y.yarn_po_no}</span>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="td text-slate-600">{y.yarn_lot_no || '—'}</td>
                      <td className="td text-right tabular-nums">
                        {y.planning_ratio_pct !== null ? `${Number(y.planning_ratio_pct).toFixed(2)}%` : '—'}
                      </td>
                      <td className="td text-right tabular-nums font-semibold text-brand-700">
                        {fmtDecimal(y.planned_qty_kg, 2)}
                      </td>
                      <td className="td text-right tabular-nums text-indigo-700">
                        {fmtDecimal(y.reserved_qty_kg, 2)}
                      </td>
                      <td className="td text-right tabular-nums text-emerald-700 font-semibold">
                        {fmtDecimal(y.issued_qty_kg, 2)}
                      </td>
                      <td className={`td text-right tabular-nums font-semibold ${balance < 0 ? 'text-red-600' : 'text-slate-700'}`}>
                        {fmtDecimal(balance, 2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'stripes' && (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">Seq</th>
                  <th className="th">Yarn Label</th>
                  <th className="th">Colour</th>
                  <th className="th text-right">Courses</th>
                  <th className="th">Notes</th>
                </tr>
              </thead>
              <tbody>
                {(prog.stripes ?? []).map((s: any, i: number) => (
                  <tr key={s.id ?? i} className="border-t border-slate-100">
                    <td className="td font-semibold text-slate-500">{s.seq_no}</td>
                    <td className="td font-medium text-slate-800">{s.yarn_label || '—'}</td>
                    <td className="td">{s.colour || '—'}</td>
                    <td className="td text-right tabular-nums font-bold text-brand-700">{s.courses}</td>
                    <td className="td text-slate-500">{s.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 border-t-2 border-slate-200">
                <tr>
                  <td colSpan={3} className="td font-bold text-slate-700">Total courses per repeat</td>
                  <td className="td text-right font-black text-brand-800 tabular-nums">
                    {(prog.stripes ?? []).reduce((s: number, r: any) => s + Number(r.courses || 0), 0)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {tab === 'issues' && (
          <div>
            {(prog.issues ?? []).length === 0 ? (
              <p className="text-center text-[12px] text-slate-400 py-8">No yarn issues recorded yet</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-[12px]">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="th">Issue No</th>
                      <th className="th">Date</th>
                      <th className="th">Yarn</th>
                      <th className="th">PO No</th>
                      <th className="th">Lot No</th>
                      <th className="th text-right">Issued KG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(prog.issues ?? []).map((iss: any) => (
                      <tr key={iss.id} className="border-t border-slate-100">
                        <td className="td font-mono text-brand-700 font-semibold">{iss.issue_no}</td>
                        <td className="td text-slate-500">{fmtDate(iss.issue_date)}</td>
                        <td className="td font-medium">{iss.yarn_code ? `${iss.yarn_code} — ${iss.yarn_name}` : '—'}</td>
                        <td className="td font-mono text-[11px] text-brand-600">{iss.yarn_po_no || '—'}</td>
                        <td className="td text-slate-600">{iss.yarn_lot_no || '—'}</td>
                        <td className="td text-right tabular-nums font-semibold text-emerald-700">
                          {fmtDecimal(iss.issued_qty_kg, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button className="btn-primary" onClick={onEdit} id="btn-edit-from-detail">
          <FileText size={14} /> Edit Program
        </button>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-[12px] text-slate-800">{value}</p>
    </div>
  );
}
