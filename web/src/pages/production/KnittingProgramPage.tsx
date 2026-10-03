import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Plus, Search, Eye, Trash2, X, Save, Layers,
  RefreshCw, AlertCircle, FileText, Boxes, ShieldCheck, PackageCheck, Truck, PackagePlus,
} from 'lucide-react';
import { http } from '../../lib/api';
import { useDiaRules, previewRoll } from '../../lib/fabricCalc';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Modal, PageHeader, Input, Spinner, LoadingBlock } from '../../components/ui';
import { useQuery as useQ } from '@tanstack/react-query';
import {
  KNIT_DC_READY, KnittingDcModal, KnittingDcPrint, KnittingInwardModal, KnittingDcInwardTab,
} from './KnittingDcInward';

/* ─────────────────────────────────────────────────────────────────
   Constants & Types
───────────────────────────────────────────────────────────────── */
const PARTS = ['TOP', 'BOTTOM', 'COLLAR', 'CUFF', 'FOLDING', 'OTHER'] as const;
const KNITTING_TYPES = ['SOLID', 'STRIPE', 'FEEDER_STRIPE', 'ENGINEERED_STRIPE', 'MULTI_YARN', 'OTHER'] as const;
const STATUS_LIST = [
  'DRAFT', 'STOCK_CHECK', 'RESERVED', 'RELEASED',
  'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED',
  'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED', 'COMPLETED', 'CANCELLED',
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
  /** the job's yarn lot (GRN line) the line is planned from */
  lot_key?: string;
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
  fabric_form: '' as '' | 'TUBULAR' | 'OPEN_WIDTH',
  /** CAD = from the job's CAD fabric program line (fills fabric / GSM / Dia / colour / KG); DIRECT = by hand */
  program_source: 'CAD' as 'CAD' | 'DIRECT',
  cad_req_id: '' as number | '',
  cad_fp_id: '' as number | '',
  fabric_colour: '',
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

  // Knitting DC (yarn outward) and grey fabric inward, per released program.
  const [dcProgId, setDcProgId] = useState<number | null>(null);
  const [inwardProgId, setInwardProgId] = useState<number | null>(null);
  const [printDc, setPrintDc] = useState<string | null>(null);

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
  // the I/O (job) list — picking it fills SO, buyer PO and style
  const { data: jobs = [] } = useQ({
    queryKey: ['procurement-jobs'],
    queryFn: async () => (await http.get<{ data: any[] }>('/procurement/jobs')).data || [],
    staleTime: 60_000,
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
      fabric_form: prog.fabric_form ?? '',
      program_source: prog.program_source ?? 'DIRECT',
      cad_req_id: prog.cad_req_id ?? '',
      cad_fp_id: prog.cad_fp_id ?? '',
      fabric_colour: prog.fabric_colour ?? '',
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
        fabric_form: form.fabric_form || null,
        cad_req_id: form.cad_req_id === '' ? null : Number(form.cad_req_id),
        cad_fp_id: form.cad_fp_id === '' ? null : Number(form.cad_fp_id),
        fabric_colour: form.fabric_colour || null,
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

  // Stock check / reserve / release run across every yarn line of the program
  // (doc §12, §21); the server holds the rules, this only surfaces the result.
  const [stockRows, setStockRows] = useState<any[] | null>(null);

  const runAction = async (id: number, action: 'check-stock' | 'reserve' | 'release') => {
    try {
      const r = await http.post<any>(`/knitting/programs/${id}/${action}`, {});
      if (action === 'check-stock') {
        const rows = r.data ?? [];
        setStockRows(rows);
        const short = rows.filter((x: any) => Number(x.shortage_kg) > 0);
        toast(short.length
          ? `${short.length} yarn line(s) short of stock`
          : 'Stock is sufficient for every yarn line',
          short.length ? 'error' : 'success');
      } else {
        toast(action === 'reserve' ? 'Yarn reserved' : 'Program released');
      }
      void qc.invalidateQueries({ queryKey: ['knitting-programs'] });
      void qc.invalidateQueries({ queryKey: ['knitting-program'] });
    } catch (e: any) {
      toast(e?.message ?? `Could not ${action.replace('-', ' ')}`, 'error');
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
  // yarn the job holds: its own PO / GRN lots and yarn transferred to it — the only yarn a program may plan
  const { data: jobLots = [], isFetched: lotsFetched } = useQ({
    queryKey: ['knit-job-lots', form.so_id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/yarn-stock/job-lots?so_id=${form.so_id}`)).data || [],
    enabled: showForm && form.so_id !== '',
  });
  // the job's CAD fabric program (from CAD)
  const { data: cadFab, isFetched: cadFetched } = useQ({
    queryKey: ['knit-cad-fabrics', form.io_no, form.style_id],
    queryFn: async () => (await http.get<{ data: any }>(`/knitting/programs/cad-fabrics?io_no=${encodeURIComponent(form.io_no)}${form.style_id ? `&style_id=${form.style_id}` : ''}`)).data,
    enabled: showForm && form.program_source === 'CAD' && !!form.io_no,
  });
  const curJob = jobs.find((j: any) => j.job_no === form.io_no);
  const jobStyles: any[] = curJob?.styles ?? [];
  const pickJob = (jobNo: string) => {
    const j = jobs.find((x: any) => x.job_no === jobNo);
    setForm((s) => {
      const keep = j?.styles?.some((st: any) => st.style_id === s.style_id);
      return { ...s, io_no: jobNo, so_id: j ? Number(j.id) : '', buyer_po_no: j?.buyer_po_no ?? '',
        style_id: keep ? s.style_id : (j?.styles?.length === 1 ? j.styles[0].style_id : ''), so_line_id: '',
        cad_req_id: '', cad_fp_id: '',
        // yarn planned from another job's stock does not belong here any more
        yarns: s.yarns.map((y) => (y.issued_qty_kg > 0 ? y : { ...y, lot_key: '', yarn_id: '', count_value: '', colour: '', yarn_po_no: '', yarn_lot_no: '' })) };
    });
  };
  const pickCadLine = (id: string) => {
    const r = (cadFab?.rows ?? []).find((x: any) => String(x.cad_fp_id) === id);
    if (!r) { setForm((s) => ({ ...s, cad_fp_id: '' })); return; }
    setForm((s) => ({ ...s, cad_req_id: cadFab.cad_id, cad_fp_id: r.cad_fp_id, fabric_id: r.fabric_id ?? s.fabric_id, fabric_type: r.fabric_type ?? s.fabric_type,
      gsm: r.gsm ?? s.gsm, dia: r.dia ?? s.dia, fabric_form: r.fabric_form ?? s.fabric_form, fabric_colour: r.colour ?? '',
      required_qty_kg: Math.max(0, Math.round((r.required_kg - r.programmed_kg) * 1000) / 1000) || r.required_kg }));
  };
  const lotLabel = (l: any) => `${l.yarn_code ?? ''} ${l.count_str ?? ''} · lot ${l.lot_no ?? '—'} · ${l.transfer_nos ? `transfer ${l.transfer_nos}` : `PO ${l.po_no ?? '—'}`} · ${l.grn_no} · ${fmtDecimal(l.available_kg, 3)} KG`;
  const pickLot = (key: string, lotKey: string) => {
    const l = jobLots.find((x: any) => `${x.grn_line_id}` === lotKey);
    setYarn(key, l ? { lot_key: lotKey, yarn_id: Number(l.yarn_id), count_value: l.count_str ?? '', colour: l.color_name || l.shade || '',
      yarn_po_no: l.transfer_nos ? `Transfer ${l.transfer_nos}` : (l.po_no ?? ''), yarn_lot_no: l.lot_no ?? '',
      planned_qty_kg: Math.min(Number(l.available_kg), Number(form.required_qty_kg) || Number(l.available_kg)) }
      : { lot_key: '', yarn_id: '', count_value: '', colour: '', yarn_po_no: '', yarn_lot_no: '' });
  };
  /** existing line → the job lot it was planned from (same yarn + lot) */
  const lotKeyOf = (y: YarnLine) => y.lot_key || (jobLots.find((l: any) => Number(l.yarn_id) === Number(y.yarn_id) && (!y.yarn_lot_no || l.lot_no === y.yarn_lot_no))?.grn_line_id?.toString() ?? '');
  // picking the fabric fills its approved specification (target GSM, Dia, tubular / open) from the fabric master
  const { data: diaRules } = useDiaRules();
  const pickFabric = async (v: string) => {
    setF('fabric_id', v ? Number(v) : '');
    if (!v) return;
    try {
      const sp = (await http.get<{ data: any }>(`/fabrics/${v}/specification`)).data;
      setForm((s) => ({ ...s, gsm: sp.target_gsm ? String(sp.target_gsm) : s.gsm, dia: sp.dia_inch ? `${Number(sp.dia_inch)}"` : s.dia,
        fabric_form: sp.fabric_form ?? s.fabric_form, fabric_type: s.fabric_type || sp.fabric_name || '' }));
    } catch { /* no specification — keep what was typed */ }
  };
  const estMeters = previewRoll({ weight_kg: form.required_qty_kg, target_gsm: form.gsm, dia: form.dia, form: (form.fabric_form || null) as any }, diaRules).calc_meters;

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

      {/* Stock check result — required vs available per yarn line (doc §12) */}
      {stockRows && (
        <div className="card mb-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-slate-600">
              <Boxes size={14} className="text-sky-600" /> Yarn Stock Check
            </h3>
            <button className="rounded p-1 text-slate-400 hover:bg-slate-100"
              onClick={() => setStockRows(null)} title="Dismiss" id="btn-close-stockcheck">
              <X size={14} />
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th text-left">Yarn</th>
                  <th className="th text-left">Colour</th>
                  <th className="th text-right">Required KG</th>
                  <th className="th text-right">On Hand</th>
                  <th className="th text-right">Reserved elsewhere</th>
                  <th className="th text-right">Available</th>
                  <th className="th text-right">Shortage</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.map((r: any) => (
                  <tr key={r.program_yarn_id} className="border-t border-slate-100">
                    <td className="td font-medium">
                      {r.yarn_code ? `${r.yarn_code} — ${r.yarn_name}` : '—'}
                    </td>
                    <td className="td text-slate-600">{r.colour || '—'}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.required_qty_kg, 3)}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.on_hand_kg, 3)}</td>
                    <td className="td text-right tabular-nums text-slate-500">
                      {fmtDecimal(r.reserved_by_others_kg, 3)}
                    </td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.available_kg, 3)}</td>
                    <td className="td text-right tabular-nums">
                      {Number(r.shortage_kg) > 0 ? (
                        <span className="font-bold text-rose-700">{fmtDecimal(r.shortage_kg, 3)}</span>
                      ) : (
                        <span className="font-semibold text-emerald-700">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[10px] text-slate-500">
            Reserving does not move stock — only a yarn issue does.
          </p>
        </div>
      )}

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
                        {['DRAFT', 'STOCK_CHECK'].includes(p.status) && (
                          <button
                            id={`btn-stock-kp-${p.id}`}
                            className="rounded p-1.5 text-slate-400 hover:bg-sky-50 hover:text-sky-600"
                            title="Check yarn stock"
                            onClick={() => void runAction(p.id, 'check-stock')}
                          >
                            <Boxes size={14} />
                          </button>
                        )}
                        {['DRAFT', 'STOCK_CHECK'].includes(p.status) && (
                          <button
                            id={`btn-reserve-kp-${p.id}`}
                            className="rounded p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600"
                            title="Reserve yarn"
                            onClick={() => void runAction(p.id, 'reserve')}
                          >
                            <ShieldCheck size={14} />
                          </button>
                        )}
                        {['DRAFT', 'STOCK_CHECK', 'RESERVED'].includes(p.status) && (
                          <button
                            id={`btn-release-kp-${p.id}`}
                            className="rounded p-1.5 text-slate-400 hover:bg-violet-50 hover:text-violet-600"
                            title="Release program"
                            onClick={() => void runAction(p.id, 'release')}
                          >
                            <PackageCheck size={14} />
                          </button>
                        )}
                        {KNIT_DC_READY.includes(p.status) && (
                          <button
                            id={`btn-knit-dc-kp-${p.id}`}
                            className="rounded p-1.5 text-orange-500 hover:bg-orange-50 hover:text-orange-700"
                            title="Knitting DC (yarn outward to knitter)"
                            onClick={() => setDcProgId(p.id)}
                          >
                            <Truck size={14} />
                          </button>
                        )}
                        {KNIT_DC_READY.includes(p.status) && Number(p.total_issued_yarn_kg) > 0 && (
                          <button
                            id={`btn-knit-inward-kp-${p.id}`}
                            className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
                            title="Grey fabric inward (against knitting DC)"
                            onClick={() => setInwardProgId(p.id)}
                          >
                            <PackagePlus size={14} />
                          </button>
                        )}
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
              <label className="block"><span className="label">Program from</span>
                <div className="inline-flex w-full rounded-lg border border-slate-300 bg-slate-100 p-0.5" id="kp-source">
                  {(['CAD', 'DIRECT'] as const).map((src) => (
                    <button key={src} type="button" id={`kp-source-${src}`} onClick={() => setForm((s) => ({ ...s, program_source: src, ...(src === 'DIRECT' ? { cad_req_id: '', cad_fp_id: '' } : {}) }))}
                      className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold ${form.program_source === src ? 'bg-white text-brand-700 shadow-xs' : 'text-slate-600'}`}>
                      {src === 'CAD' ? 'From CAD' : 'Direct'}
                    </button>))}
                </div></label>
              <label className="block"><span className="label">I/O Number *</span>
                <select className="input" value={form.io_no} onChange={(e) => pickJob(e.target.value)} id="kp-io-no">
                  <option value="">— Select I/O —</option>
                  {form.io_no && !curJob && <option value={form.io_no}>{form.io_no}</option>}
                  {jobs.map((j: any) => <option key={j.id} value={j.job_no}>{j.job_no}{j.buyer_name ? ` · ${j.buyer_name}` : ''}</option>)}
                </select></label>
              <Input label="Buyer PO No (auto)" value={form.buyer_po_no}
                onChange={(e) => setF('buyer_po_no', e.target.value)} id="kp-buyer-po" />
              <select className="input" value={form.style_id} onChange={(e) => setF('style_id', e.target.value ? Number(e.target.value) : '')} id="kp-style">
                <option value="">— Style (required) —</option>
                {(jobStyles.length ? jobStyles.map((st: any) => ({ id: st.style_id, style_code: st.style_code, label: st.style_name })) : styles).map((s: any) => <option key={s.id} value={s.id}>{s.style_code} — {s.label}</option>)}
              </select>
              <select className="input" value={form.so_line_id} onChange={(e) => onSoLineSelect(e.target.value)} id="kp-so-line">
                <option value="">— SO line / part (optional) —</option>
                {soLines.filter((l: any) => form.so_id === '' || Number(l.so_id) === Number(form.so_id)).map((l: any) => <option key={l.id} value={l.id}>{l.label}</option>)}
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
            {form.program_source === 'CAD' && (
              <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50/60 p-2.5 text-[12px]" id="kp-cad-box">
                {!form.io_no ? <span className="text-slate-600">Select the I/O — its CAD fabric program loads here.</span>
                  : !cadFetched ? <span className="text-slate-500">Loading the CAD…</span>
                  : !cadFab ? <span className="text-amber-800" id="kp-cad-none">No CAD for {form.io_no}{form.style_id ? ' / this style' : ''} — make the CAD first, or switch to <b>Direct</b>.</span>
                  : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-emerald-900">CAD {cadFab.req_no}{cadFab.style_code ? ` (${cadFab.style_code})` : ''}</span>
                      <select className="input w-[520px] py-1 text-[12px]" value={form.cad_fp_id} onChange={(e) => pickCadLine(e.target.value)} id="kp-cad-line">
                        <option value="">— Fabric line from the CAD (fabric · GSM · Dia · colour · KG) —</option>
                        {(cadFab.rows ?? []).map((r: any) => <option key={r.cad_fp_id} value={r.cad_fp_id}>
                          {r.fabric_type} · {r.gsm ?? '—'} GSM · {r.dia ?? '—'} {r.fabric_form === 'OPEN_WIDTH' ? 'open' : r.fabric_form === 'TUBULAR' ? 'tube' : ''} · {r.colour ?? '—'} · {fmtDecimal(r.required_kg, 1)} KG{r.programmed_kg > 0 ? ` (programmed ${fmtDecimal(r.programmed_kg, 1)})` : ''}
                        </option>)}
                      </select>
                      {form.fabric_colour && <span className="rounded bg-white px-2 py-0.5 text-[11px]">Colour {form.fabric_colour}</span>}
                    </div>)}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <select className="input" value={form.fabric_id} onChange={(e) => void pickFabric(e.target.value)} id="kp-fabric">
                <option value="">— Fabric —</option>
                {fabrics.map((f: any) => <option key={f.id} value={f.id}>{f.fabric_code} — {f.label}</option>)}
              </select>
              <Input label="Fabric Type" placeholder="e.g. Single Jersey, Rib" value={form.fabric_type}
                onChange={(e) => setF('fabric_type', e.target.value)} id="kp-fabric-type" />
              <Input label="GSM (Target)" value={form.gsm}
                onChange={(e) => setF('gsm', e.target.value)} id="kp-gsm" />
              <Input label="Dia (Target)" value={form.dia}
                onChange={(e) => setF('dia', e.target.value)} id="kp-dia" />
              <label className="block"><span className="label">Fabric form</span>
                <select className="input" value={form.fabric_form} onChange={(e) => setF('fabric_form', e.target.value)} id="kp-form">
                  <option value="">— Tubular / open —</option><option value="TUBULAR">Tubular</option><option value="OPEN_WIDTH">Open width</option>
                </select></label>
              <Input label="Gauge" placeholder="e.g. 24 GG" value={form.gauge}
                onChange={(e) => setF('gauge', e.target.value)} id="kp-gauge" />
              <Input label="Loop Length" value={form.loop_length}
                onChange={(e) => setF('loop_length', e.target.value)} id="kp-loop-length" />
              <Input label="Required Qty (KG)" type="number" step="0.001" value={form.required_qty_kg}
                onChange={(e) => setF('required_qty_kg', e.target.value === '' ? '' : Number(e.target.value))} id="kp-req-qty"
                hint={estMeters ? `≈ ${fmtDecimal(estMeters, 1)} m fabric (KG × 1000 ÷ GSM × width)` : undefined} />
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
                              className="input text-[12px] w-full min-w-[330px]"
                              value={lotKeyOf(y) || (y.yarn_id ? `cur:${y.yarn_id}` : '')}
                              disabled={form.so_id === '' || y.issued_qty_kg > 0}
                              onChange={(e) => pickLot(y._key, e.target.value)}
                              id={`yarn-select-${idx}`}
                              title="Only yarn this job holds — its own PO / GRN lots and yarn transferred to it"
                            >
                              <option value="">{form.so_id === '' ? '— Select the I/O first —' : lotsFetched && !jobLots.length ? '— This job holds no yarn (buy / transfer first) —' : "— Yarn from this job's stock —"}</option>
                              {y.yarn_id && !lotKeyOf(y) && <option value={`cur:${y.yarn_id}`}>{yarns.find((yn: any) => yn.id === Number(y.yarn_id))?.code ?? 'Yarn'} (current — no stock left for the job)</option>}
                              {jobLots.map((l: any) => <option key={l.grn_line_id} value={String(l.grn_line_id)}>{lotLabel(l)}</option>)}
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
                              value={y.yarn_po_no} readOnly={!!lotKeyOf(y)}
                              placeholder="from the yarn lot"
                              title="Yarn Purchase Order number — for full traceability"
                              onChange={(e) => setYarn(y._key, { yarn_po_no: e.target.value })}
                              id={`yarn-po-${idx}`} />
                          </td>
                          <td className="td p-1">
                            <input className="input text-[12px] w-28" value={y.yarn_lot_no} readOnly={!!lotKeyOf(y)}
                              placeholder="from the yarn lot"
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

      <KnittingDcModal programId={dcProgId} open={!!dcProgId} onClose={() => setDcProgId(null)}
        onPrint={setPrintDc} />
      <KnittingInwardModal programId={inwardProgId} open={!!inwardProgId} onClose={() => setInwardProgId(null)} />
      <KnittingDcPrint dcNo={printDc} onClose={() => setPrintDc(null)} />
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
    QC: 'bg-purple-100 text-purple-700 border-purple-200',
    STOCK_POSTED: 'bg-green-100 text-green-700 border-green-200',
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
  const [tab, setTab] = useState<'yarns' | 'stripes' | 'issues' | 'dc'>('yarns');

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
        <InfoRow label="Fabric form" value={prog.fabric_form === 'OPEN_WIDTH' ? 'Open width' : prog.fabric_form === 'TUBULAR' ? 'Tubular' : '—'} />
        <InfoRow label="Gauge" value={prog.gauge ?? '—'} />
        <InfoRow label="Required KG" value={<span className="font-semibold">{fmtDecimal(prog.required_qty_kg, 2)}</span>} />
        <InfoRow label="Required Date" value={fmtDate(prog.required_date)} />
        <InfoRow label="Job Work" value={prog.job_work_type?.replace(/_/g, ' ')} />
        {prog.vendor_name && <InfoRow label="Vendor" value={prog.vendor_name} />}
      </div>

      {/* Tabs */}
      <div>
        <div className="flex items-center gap-1 border-b border-slate-200 mb-3">
          {(['yarns', ...(prog.stripes?.length ? ['stripes'] : []), 'issues', 'dc'] as const).map((t) => (
            <button key={t}
              className={`px-3 py-2 text-[12px] font-semibold border-b-2 -mb-px transition-colors ${
                tab === t ? 'border-brand-500 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
              onClick={() => setTab(t as any)}
              id={`detail-tab-${t}`}
            >
              {t === 'yarns' ? `🧵 Yarns (${prog.yarns?.length ?? 0})`
                : t === 'stripes' ? `🎨 Stripes (${prog.stripes?.length ?? 0})`
                : t === 'dc' ? 'Knitting DC & Grey Inward'
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

        {tab === 'dc' && <KnittingDcInwardTab prog={prog} />}

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
