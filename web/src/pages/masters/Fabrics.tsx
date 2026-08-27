import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, PieChart as PieIcon, Layers, FileText, Info,
  CheckCircle2, AlertCircle, Sparkles, Package, Droplets, Sliders
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, Input, Select, Textarea, Spinner, Badge, StatusBadge,
  LoadingBlock, ErrorState, Tabs, useDebounced
} from '../../components/ui';
import { fmtDecimal, humanize } from '../../lib/format';

/* ------------------------------------------------------ Fiber Constants & Data */
export interface FibreComponent {
  _key: string;
  id?: number;
  component_type: 'Main' | 'Additive' | 'Core' | 'Cover' | 'Binder';
  fibre_type: string;
  fibre_category: 'Natural' | 'Synthetic' | 'Semi-Synthetic' | 'Regenerated' | 'Animal' | 'Other';
  percentage: number | '';
  recycled_pct: number | '';
  certification: string;
  remarks: string;
}

const FIBRE_TYPES = [
  { name: 'Cotton', category: 'Natural' as const, color: '#3b82f6' },
  { name: 'Polyester', category: 'Synthetic' as const, color: '#10b981' },
  { name: 'Elastane / Spandex', category: 'Synthetic' as const, color: '#f59e0b' },
  { name: 'Viscose / Rayon', category: 'Semi-Synthetic' as const, color: '#8b5cf6' },
  { name: 'Modal', category: 'Semi-Synthetic' as const, color: '#ec4899' },
  { name: 'Tencel / Lyocell', category: 'Semi-Synthetic' as const, color: '#06b6d4' },
  { name: 'Bamboo', category: 'Semi-Synthetic' as const, color: '#84cc16' },
  { name: 'Linen / Flax', category: 'Natural' as const, color: '#d97706' },
  { name: 'Wool', category: 'Animal' as const, color: '#a855f7' },
  { name: 'Silk', category: 'Animal' as const, color: '#f43f5e' },
  { name: 'Nylon / Polyamide', category: 'Synthetic' as const, color: '#6366f1' },
  { name: 'Acrylic', category: 'Synthetic' as const, color: '#14b8a6' },
  { name: 'Other', category: 'Other' as const, color: '#64748b' },
];

const COMPONENT_TYPES = ['Main', 'Additive', 'Core', 'Cover', 'Binder'];
const FIBRE_CATEGORIES = ['Natural', 'Synthetic', 'Semi-Synthetic', 'Regenerated', 'Animal', 'Other'];
const CERTIFICATIONS = ['— None —', 'GOTS (Organic)', 'GRS (Global Recycled)', 'OEKO-TEX Standard 100', 'BCI (Better Cotton)', 'FSC', 'Cradle to Cradle', 'RCS'];

const KNIT_STRUCTURES = [
  'Single Jersey',
  '1x1 Rib',
  '2x2 Rib',
  'Interlock',
  'Pique (Polo Mesh)',
  'French Terry',
  'Fleece (Brushed)',
  'Fleece (Unbrushed / Loopknit)',
  'Waffle / Thermal',
  'Drop Needle',
  'Jacquard',
  'Pointelle',
  'Twill (Woven)',
  'Poplin (Woven)',
  'Oxford (Woven)',
  'Denim',
  'Canvas',
  'Other',
];

const FINISH_TYPES = [
  'Bio-Wash (Enzyme)',
  'Silicon Softener Wash',
  'Peached / Sueded',
  'Mercerized',
  'Compacted (Zero Shrinkage)',
  'Anti-Microbial / Anti-Bacterial',
  'Moisture Wicking (Quick Dry)',
  'Water Repellent (DWR)',
  'Brushed / Carbon Finished',
  'Pre-Shrunk (Sanforized)',
  'Standard Greige / Unwashed',
];

let compSeq = 0;
const newFibre = (type = 'Cotton', pct: number | '' = 100): FibreComponent => {
  const meta = FIBRE_TYPES.find((f) => f.name === type);
  return {
    _key: `fc_${++compSeq}`,
    component_type: 'Main',
    fibre_type: type,
    fibre_category: meta?.category ?? 'Natural',
    percentage: pct,
    recycled_pct: 0,
    certification: '— None —',
    remarks: '',
  };
};

/* ==============================================================================
   1. FABRICS LIST PAGE (DataTable with filters)
   ============================================================================== */
export function FabricsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'fabric_name', dir: 'asc' });
  const debounced = useDebounced(search);
  const [fabricType, setFabricType] = useState('');
  const [gsmId, setGsmId] = useState('');
  const [compositionId, setCompositionId] = useState('');

  const gsms = useLookup('gsm');
  const compositions = useLookup('compositions');

  const list = useList<any>('fabrics', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    fabric_type: fabricType || undefined,
    gsm_id: gsmId || undefined,
    composition_id: compositionId || undefined,
    sort: sort.key,
    dir: sort.dir,
  });

  return (
    <>
      <PageHeader
        breadcrumb={['Master Data', 'Fabrics']}
        title="Fabric Master"
        subtitle="Knit & woven fabric constructions, GSM, fibre compositions and finishing"
        actions={
          can('MATERIAL.CREATE') && (
            <button className="btn-primary" onClick={() => nav('/masters/fabrics/new')}>
              <Plus size={15} /> New Fabric
            </button>
          )
        }
      />

      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search fabric code, name, structure (e.g. Single Jersey) or composition…"
          className="w-full max-w-md"
        />
        <div className="w-44">
          <Select
            placeholder="All Fabric Types"
            options={['KNIT', 'WOVEN', 'NONWOVEN'].map((v) => ({
              value: v,
              label: humanize(v),
            }))}
            value={fabricType}
            onChange={(e) => {
              setFabricType(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-44">
          <Select
            placeholder="All GSMs"
            options={toOptions(gsms.data)}
            value={gsmId}
            onChange={(e) => {
              setGsmId(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-56">
          <Select
            placeholder="All Compositions"
            options={toOptions(compositions.data)}
            value={compositionId}
            onChange={(e) => {
              setCompositionId(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {(fabricType || gsmId || compositionId) && (
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setFabricType('');
              setGsmId('');
              setCompositionId('');
              setPage(1);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <DataTable
        columns={[
          {
            key: 'fabric_code',
            header: 'Fabric Code',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono text-[12.5px] font-bold text-brand-700">{r.fabric_code}</span>
            ),
          },
          {
            key: 'fabric_name',
            header: 'Fabric Name',
            sortable: true,
            render: (r: any) => <span className="font-semibold text-slate-800">{r.fabric_name}</span>,
          },
          {
            key: 'fabric_type',
            header: 'Type',
            render: (r: any) => <Badge tone={r.fabric_type === 'KNIT' ? 'blue' : 'amber'}>{humanize(r.fabric_type || 'KNIT')}</Badge>,
          },
          {
            key: 'knit_structure',
            header: 'Structure',
            render: (r: any) => <span className="font-medium text-slate-700">{r.knit_structure || '—'}</span>,
          },
          {
            key: 'gsm_value',
            header: 'GSM',
            align: 'right',
            render: (r: any) => (
              <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-800">
                {r.gsm_value ? `${r.gsm_value} GSM` : '—'}
              </span>
            ),
          },
          {
            key: 'composition_desc',
            header: 'Fibre Composition',
            render: (r: any) => (
              <span className="font-medium text-slate-700">{r.composition_desc || '100% Cotton'}</span>
            ),
          },
          {
            key: 'finish_type',
            header: 'Finish',
            render: (r: any) => <span className="text-slate-500 text-xs">{r.finish_type || 'Bio-wash'}</span>,
          },
          {
            key: 'std_rate',
            header: 'Rate / KG',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-bold text-slate-900">₹ {fmtDecimal(r.std_rate || 0, 2)}</span>
            ),
          },
          {
            key: 'is_active',
            header: 'Status',
            render: (r: any) => (
              <StatusBadge value={r.is_active ? 'ACTIVE' : 'INACTIVE'} />
            ),
          },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/masters/fabrics/${r.id}`)}
        sort={sort}
        onSort={onSort}
        pagination={list.data?.pagination}
        onPage={setPage}
        emptyTitle="No fabric records found"
        emptyMessage="Create fabric masters with knit structure, GSM, fibre composition and finish."
      />
    </>
  );
}

/* ==============================================================================
   2. FABRIC & COMPOSITION DETAIL PAGE (With Live Donut Chart)
   ============================================================================== */
export function FabricDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [tab, setTab] = useState<'general' | 'composition' | 'construction' | 'dyeing' | 'stock'>('composition');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Lookups
  const categories = useLookup('material-categories');
  const uoms = useLookup('uoms');
  const gsms = useLookup('gsm');
  const yarns = useLookup('yarns');

  // Fabric General Form State
  const [head, setHead] = useState<Record<string, any>>({
    fabric_code: '',
    fabric_name: '',
    category_id: '',
    fabric_type: 'KNIT',
    knit_structure: 'Single Jersey',
    composition_id: '',
    gsm_id: '',
    width_cm: 180,
    dia_inch: 30,
    gauge: '24 GG',
    yarn_id: '',
    finish_type: 'Bio-Wash (Enzyme)',
    hsn_code: '6006',
    base_uom: '',
    std_rate: 420,
    is_active: 1,
    shrinkage_length: 5.0,
    shrinkage_width: 5.0,
    spirality_pct: 3.0,
    dye_type: 'Reactive Dyeing',
    color_fastness_washing: '4-5',
    color_fastness_rubbing: '4 (Dry) / 3-4 (Wet)',
  });

  // Composition State
  const [compHead, setCompHead] = useState({
    composition_code: '',
    composition_name: '95% Cotton / 5% Elastane',
    composition_type: 'Blend',
    status: 'Active',
    description: 'Single jersey stretch knit fabric with high elasticity and recovery.',
    remarks: 'Premium combed cotton with Lycra/Spandex feed.',
    total_recycled_pct: 0.0,
    recycled_by_weight: 0.0,
    recycled_by_fibre: 0.0,
    recycled_desc: '',
  });

  // Fibre Composition Line Items
  const [fibres, setFibres] = useState<FibreComponent[]>([
    { _key: 'fc_1', component_type: 'Main', fibre_type: 'Cotton', fibre_category: 'Natural', percentage: 95, recycled_pct: 0, certification: 'GOTS (Organic)', remarks: '30s Combed Cotton' },
    { _key: 'fc_2', component_type: 'Additive', fibre_type: 'Elastane / Spandex', fibre_category: 'Synthetic', percentage: 5, recycled_pct: 0, certification: 'OEKO-TEX Standard 100', remarks: '20D Bare Lycra' },
  ]);

  // Load Existing Fabric
  const fabricQuery = useQuery({
    queryKey: ['fabrics', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/fabrics/${id}`)).data,
    enabled: !isNew,
  });

  // Load Existing Composition if linked
  const compQuery = useQuery({
    queryKey: ['compositions', 'item', head.composition_id],
    queryFn: async () => (await http.get<{ data: any }>(`/compositions/${head.composition_id}`)).data,
    enabled: !isNew && !!head.composition_id,
  });

  useEffect(() => {
    if (!fabricQuery.data) return;
    const f = fabricQuery.data;
    setHead((prev: any) => ({ ...prev, ...f }));
    if (f.fabric_code && !compHead.composition_code) {
      setCompHead((c) => ({ ...c, composition_code: `CMP-${f.fabric_code}` }));
    }
  }, [fabricQuery.data]);

  useEffect(() => {
    if (!compQuery.data) return;
    const c = compQuery.data;
    setCompHead((prev) => ({
      ...prev,
      composition_code: c.composition_code ?? prev.composition_code,
      composition_name: c.description ?? prev.composition_name,
      description: c.remarks ?? prev.description,
    }));
    if (c.details && Array.isArray(c.details) && c.details.length > 0) {
      setFibres(
        c.details.map((d: any, idx: number) => {
          const meta = FIBRE_TYPES.find((f) => f.name.toLowerCase() === d.fibre_name?.toLowerCase());
          return {
            _key: `fc_${idx + 1}`,
            id: d.id,
            component_type: d.component_type || (idx === 0 ? 'Main' : 'Additive'),
            fibre_type: d.fibre_name,
            fibre_category: meta?.category ?? (d.fibre_category || 'Natural'),
            percentage: Number(d.percentage) || 0,
            recycled_pct: Number(d.recycled_pct) || 0,
            certification: d.certification || '— None —',
            remarks: d.remarks || '',
          };
        })
      );
    }
  }, [compQuery.data]);

  // Handle Fiber Change
  const updateFibre = (key: string, patch: Partial<FibreComponent>) => {
    setFibres((prev) =>
      prev.map((f) => {
        if (f._key !== key) return f;
        const updated = { ...f, ...patch };
        if (patch.fibre_type) {
          const meta = FIBRE_TYPES.find((m) => m.name === patch.fibre_type);
          if (meta) updated.fibre_category = meta.category;
        }
        return updated;
      })
    );
  };

  // Add Fibre
  const addFibre = () => {
    const remaining = Math.max(0, 100 - totalPercentage);
    setFibres((prev) => [...prev, newFibre('Polyester', remaining > 0 ? remaining : 10)]);
  };

  // Remove Fibre
  const removeFibre = (key: string) => {
    setFibres((prev) => prev.filter((f) => f._key !== key));
  };

  // Calculations
  const totalPercentage = useMemo(() => {
    return fibres.reduce((sum, f) => sum + (Number(f.percentage) || 0), 0);
  }, [fibres]);

  const totalRecycledPct = useMemo(() => {
    return fibres.reduce((sum, f) => {
      const p = Number(f.percentage) || 0;
      const r = Number(f.recycled_pct) || 0;
      return sum + (p * r) / 100;
    }, 0);
  }, [fibres]);

  const naturalPct = useMemo(() => {
    return fibres
      .filter((f) => f.fibre_category === 'Natural' || f.fibre_category === 'Animal')
      .reduce((sum, f) => sum + (Number(f.percentage) || 0), 0);
  }, [fibres]);

  const syntheticPct = useMemo(() => {
    return fibres
      .filter((f) => f.fibre_category === 'Synthetic' || f.fibre_category === 'Semi-Synthetic' || f.fibre_category === 'Regenerated')
      .reduce((sum, f) => sum + (Number(f.percentage) || 0), 0);
  }, [fibres]);

  // Auto-generate composition name
  useEffect(() => {
    const valid = fibres.filter((f) => Number(f.percentage) > 0);
    if (valid.length > 0) {
      const autoName = valid.map((f) => `${f.percentage}% ${f.fibre_type}`).join(' / ');
      setCompHead((c) => ({
        ...c,
        composition_name: autoName,
        composition_type: valid.length === 1 ? '100% Pure' : 'Blend',
      }));
    }
  }, [fibres]);

  const editable = isNew ? can('MATERIAL.CREATE') : can('MATERIAL.UPDATE');

  // Save Handler
  const handleSave = async (mode: 'save' | 'draft' | 'saveAndNew' = 'save') => {
    setErrors({});
    if (mode !== 'draft' && Math.abs(totalPercentage - 100) > 0.01) {
      toast('Total fibre composition percentage must equal 100.00%', 'error');
      setTab('composition');
      return;
    }
    if (!head.fabric_code?.trim() || !head.fabric_name?.trim()) {
      toast('Please enter Fabric Code and Fabric Name', 'error');
      setTab('general');
      return;
    }

    setSaving(true);
    try {
      // 1. Create or Update Composition First
      const compPayload = {
        composition_code: compHead.composition_code || `CMP-${head.fabric_code || 'FAB'}`,
        description: compHead.composition_name,
        is_active: mode === 'draft' ? 0 : 1,
        details: fibres.map((f) => ({
          component_type: f.component_type,
          fibre_name: f.fibre_type,
          fibre_category: f.fibre_category,
          percentage: Number(f.percentage) || 0,
          recycled_pct: Number(f.recycled_pct) || 0,
          certification: f.certification,
          remarks: f.remarks,
        })),
      };

      let compId = head.composition_id;
      if (compId) {
        await http.put(`/compositions/${compId}`, compPayload).catch(() => {});
      } else {
        const compRes = await http.post<{ data: any }>('/compositions', compPayload).catch(() => null);
        if (compRes?.data?.id) compId = compRes.data.id;
      }

      // 2. Save Fabric Record
      const fabricPayload = {
        fabric_code: head.fabric_code,
        fabric_name: head.fabric_name,
        category_id: head.category_id || null,
        fabric_type: head.fabric_type || 'KNIT',
        knit_structure: head.knit_structure || null,
        composition_id: compId || null,
        gsm_id: head.gsm_id ? Number(head.gsm_id) : (gsms.data?.[0]?.id ?? null),
        width_cm: Number(head.width_cm) || null,
        dia_inch: Number(head.dia_inch) || null,
        yarn_id: head.yarn_id || null,
        finish_type: head.finish_type || null,
        hsn_code: head.hsn_code || '6006',
        base_uom: head.base_uom ? Number(head.base_uom) : (uoms.data?.[0]?.id ?? 1),
        std_rate: Number(head.std_rate) || 0,
        is_active: mode === 'draft' ? 0 : (head.is_active ?? 1),
      };

      const res = isNew
        ? await http.post<{ data: any }>('/fabrics', fabricPayload)
        : await http.put<{ data: any }>(`/fabrics/${id}`, fabricPayload);

      toast(mode === 'draft' ? 'Fabric saved as Draft — resume anytime' : `Fabric ${isNew ? 'created' : 'updated'} successfully`);
      void qc.invalidateQueries({ queryKey: ['fabrics'] });
      void qc.invalidateQueries({ queryKey: ['compositions'] });
      void qc.invalidateQueries({ queryKey: ['lookup'] });

      if (mode === 'saveAndNew') {
        setHead({
          fabric_code: '',
          fabric_name: '',
          fabric_type: 'KNIT',
          knit_structure: 'Single Jersey',
          width_cm: 180,
          dia_inch: 30,
          finish_type: 'Bio-Wash (Enzyme)',
          std_rate: 420,
          is_active: 1,
        });
        nav('/masters/fabrics/new');
      } else if (isNew && res.data?.id) {
        nav(`/masters/fabrics/${res.data.id}`, { replace: true });
      }
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        toast(e.message, 'error');
      } else {
        toast('Failed to save fabric master', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && fabricQuery.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && fabricQuery.error) return <div className="card"><ErrorState error={fabricQuery.error} onRetry={() => void fabricQuery.refetch()} /></div>;

  const d = fabricQuery.data;

  return (
    <>
      <PageHeader
        breadcrumb={['Masters', 'Fabric Master', isNew ? 'New' : 'View / Edit']}
        title={
          <div className="flex items-center gap-3">
            <span>{isNew ? 'New Fabric Master' : d?.fabric_name || 'Fabric Master'}</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider ${
                head.is_active ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-amber-100 text-amber-800 border border-amber-300'
              }`}
            >
              {head.is_active ? 'Active' : 'Draft'}
            </span>
          </div>
        }
        subtitle={
          isNew
            ? 'Define fabric construction, GSM, width/dia, fibre composition and finishes'
            : `Fabric Code : ${d?.fabric_code || '—'}  |  Structure : ${d?.knit_structure || 'Single Jersey'}  |  Type : ${d?.fabric_type || 'KNIT'}`
        }
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary" onClick={() => nav('/masters/fabrics')}>
              <ArrowLeft size={15} /> Back
            </button>
            {editable && isNew && (
              <button className="btn-secondary" onClick={() => void handleSave('draft')} disabled={saving}>
                {saving ? <Spinner size={14} /> : <FileText size={14} className="text-amber-600" />} Save as Draft
              </button>
            )}
            {editable && isNew && (
              <button className="btn-secondary" onClick={() => void handleSave('saveAndNew')} disabled={saving}>
                Save & New
              </button>
            )}
            {editable && (
              <button className="btn-primary" onClick={() => void handleSave('save')} disabled={saving}>
                {saving ? <Spinner size={15} /> : <Save size={15} />}
                {isNew ? 'Save Fabric' : head.is_active ? 'Save Changes' : 'Activate Fabric'}
              </button>
            )}
          </div>
        }
      />

      {/* Main Tab Navigation */}
      <div className="mb-4">
        <Tabs
          active={tab}
          onChange={(t) => setTab(t as any)}
          tabs={[
            { key: 'general', label: 'General' },
            { key: 'composition', label: 'Composition', count: fibres.length },
            { key: 'construction', label: 'Technical & Construction' },
            { key: 'dyeing', label: 'Dyeing & Quality' },
            { key: 'stock', label: 'Stock & UOM' },
          ]}
        />
      </div>

      {/* ──────────────────────────────────────────────────────────────────────────
          TAB 1: COMPOSITION (Live Donut Chart & Fibre Breakdown)
          ────────────────────────────────────────────────────────────────────────── */}
      {tab === 'composition' && (
        <div className="space-y-4">
          {/* Card 1: Composition Header Information */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-brand-500" />
                <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Composition Information</h3>
              </div>
              <span className="text-xs text-slate-500">Define fabric fibre blend percentages</span>
            </div>

            <div className="p-4 space-y-3.5">
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-5">
                <Input
                  label="Composition Code"
                  placeholder="e.g. CMP-FAB001"
                  value={compHead.composition_code}
                  onChange={(e) => setCompHead((c) => ({ ...c, composition_code: e.target.value }))}
                  disabled={!editable}
                  hint="Auto-generated if blank"
                />
                <div className="lg:col-span-2">
                  <Input
                    label="Composition Name"
                    required
                    placeholder="e.g. 95% Cotton / 5% Elastane"
                    value={compHead.composition_name}
                    onChange={(e) => setCompHead((c) => ({ ...c, composition_name: e.target.value }))}
                    disabled={!editable}
                  />
                </div>
                <Select
                  label="Composition Type"
                  required
                  options={[
                    { value: 'Blend', label: 'Blend' },
                    { value: '100% Pure', label: '100% Pure' },
                    { value: 'Core Spun', label: 'Core Spun' },
                    { value: 'Composite', label: 'Composite' },
                    { value: 'Other', label: 'Other' },
                  ]}
                  value={compHead.composition_type}
                  onChange={(e) => setCompHead((c) => ({ ...c, composition_type: e.target.value }))}
                  disabled={!editable}
                />
                <div className="flex flex-col">
                  <label className="text-[11.5px] font-bold text-slate-700 uppercase tracking-wide mb-1">
                    Total Composition (%)
                  </label>
                  <div
                    className={`flex items-center justify-between rounded-lg border px-3 py-2 font-mono text-sm font-black ${
                      Math.abs(totalPercentage - 100) < 0.01
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                        : 'border-rose-300 bg-rose-50 text-rose-800'
                    }`}
                  >
                    <span>{totalPercentage.toFixed(2)} %</span>
                    {Math.abs(totalPercentage - 100) < 0.01 ? (
                      <CheckCircle2 size={16} className="text-emerald-600" />
                    ) : (
                      <AlertCircle size={16} className="text-rose-600" />
                    )}
                  </div>
                  <span className="text-[10.5px] text-slate-400 mt-1">Must equal 100.00%</span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 pt-2 border-t border-slate-100">
                <Textarea
                  label="Description"
                  rows={2}
                  placeholder="e.g. Single jersey stretch knit fabric with high elasticity and recovery."
                  value={compHead.description}
                  onChange={(e) => setCompHead((c) => ({ ...c, description: e.target.value }))}
                  disabled={!editable}
                />
                <Textarea
                  label="Remarks"
                  rows={2}
                  placeholder="e.g. Premium combed cotton with Lycra/Spandex feed."
                  value={compHead.remarks}
                  onChange={(e) => setCompHead((c) => ({ ...c, remarks: e.target.value }))}
                  disabled={!editable}
                />
              </div>
            </div>
          </div>

          {/* Card 2: Split Grid — Fibre Composition Table (Left 65%) + Donut Chart Summary (Right 35%) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Left 8 Cols: Fibre Composition Table */}
            <div className="lg:col-span-8 card overflow-hidden flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Layers size={15} className="text-brand-600" />
                    <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Fibre Composition</h3>
                  </div>
                  {editable && (
                    <button
                      type="button"
                      onClick={addFibre}
                      className="btn-primary btn-sm flex items-center gap-1 text-xs py-1 px-2.5"
                    >
                      <Plus size={13} /> Add Component
                    </button>
                  )}
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-surface-border bg-slate-100/60 text-[11px] font-bold uppercase text-slate-600">
                        <th className="py-2.5 px-3 w-10 text-center">#</th>
                        <th className="py-2.5 px-3 min-w-[110px]">Component Type</th>
                        <th className="py-2.5 px-3 min-w-[140px]">Fibre Type *</th>
                        <th className="py-2.5 px-3 min-w-[110px]">Category</th>
                        <th className="py-2.5 px-3 w-28 text-right">Percentage (%) *</th>
                        <th className="py-2.5 px-3 w-24 text-right">Recycled (%)</th>
                        <th className="py-2.5 px-3 min-w-[120px]">Certification</th>
                        <th className="py-2.5 px-3 min-w-[130px]">Remarks</th>
                        {editable && <th className="py-2.5 px-3 w-10 text-center">Action</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {fibres.map((f, idx) => (
                        <tr key={f._key} className="hover:bg-slate-50/80 transition-colors">
                          <td className="py-2 px-3 text-center font-bold text-slate-400">{idx + 1}</td>
                          <td className="py-2 px-2">
                            <select
                              value={f.component_type}
                              disabled={!editable}
                              onChange={(e) => updateFibre(f._key, { component_type: e.target.value as any })}
                              className="input py-1 px-2 text-xs"
                            >
                              {COMPONENT_TYPES.map((c) => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-2">
                            <select
                              value={f.fibre_type}
                              disabled={!editable}
                              onChange={(e) => updateFibre(f._key, { fibre_type: e.target.value })}
                              className="input py-1 px-2 text-xs font-semibold text-slate-800"
                            >
                              {FIBRE_TYPES.map((ft) => (
                                <option key={ft.name} value={ft.name}>{ft.name}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-2">
                            <select
                              value={f.fibre_category}
                              disabled={!editable}
                              onChange={(e) => updateFibre(f._key, { fibre_category: e.target.value as any })}
                              className="input py-1 px-2 text-xs text-slate-600"
                            >
                              {FIBRE_CATEGORIES.map((fc) => (
                                <option key={fc} value={fc}>{fc}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-2 text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              max="100"
                              value={f.percentage}
                              disabled={!editable}
                              onChange={(e) =>
                                updateFibre(f._key, {
                                  percentage: e.target.value === '' ? '' : Number(e.target.value),
                                })
                              }
                              className="input py-1 px-2 text-right font-mono font-bold text-slate-900 text-xs w-24"
                              placeholder="0.00"
                            />
                          </td>
                          <td className="py-2 px-2 text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              max="100"
                              value={f.recycled_pct}
                              disabled={!editable}
                              onChange={(e) =>
                                updateFibre(f._key, {
                                  recycled_pct: e.target.value === '' ? '' : Number(e.target.value),
                                })
                              }
                              className="input py-1 px-2 text-right font-mono text-emerald-700 text-xs w-20"
                              placeholder="0.00"
                            />
                          </td>
                          <td className="py-2 px-2">
                            <select
                              value={f.certification}
                              disabled={!editable}
                              onChange={(e) => updateFibre(f._key, { certification: e.target.value })}
                              className="input py-1 px-2 text-xs"
                            >
                              {CERTIFICATIONS.map((cert) => (
                                <option key={cert} value={cert}>{cert}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-2">
                            <input
                              type="text"
                              value={f.remarks}
                              disabled={!editable}
                              onChange={(e) => updateFibre(f._key, { remarks: e.target.value })}
                              placeholder="e.g. Combed, Spandex feed"
                              className="input py-1 px-2 text-xs"
                            />
                          </td>
                          {editable && (
                            <td className="py-2 px-2 text-center">
                              <button
                                type="button"
                                onClick={() => removeFibre(f._key)}
                                disabled={fibres.length <= 1}
                                className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30"
                                title="Remove component"
                              >
                                <Trash2 size={14} />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-xs">
                        <td colSpan={4} className="py-3 px-4 text-slate-800 uppercase tracking-wider">Total</td>
                        <td className="py-3 px-3 text-right font-mono font-black text-sm">
                          <span
                            className={
                              Math.abs(totalPercentage - 100) < 0.01
                                ? 'text-emerald-700 font-extrabold'
                                : 'text-rose-600 underline'
                            }
                          >
                            {totalPercentage.toFixed(2)} %
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-emerald-700 text-xs">
                          {totalRecycledPct.toFixed(2)} %
                        </td>
                        <td colSpan={editable ? 3 : 2} className="py-3 px-3 text-slate-400 font-normal italic text-[11px]">
                          {Math.abs(totalPercentage - 100) < 0.01 ? '✓ Balanced 100%' : '⚠️ Balance remaining: ' + (100 - totalPercentage).toFixed(2) + '%'}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Callout Footer */}
              <div className="m-3 flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/70 p-3 text-[12px] text-blue-900">
                <Info size={16} className="text-blue-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Note: Total Composition percentage must be equal to 100.00% to save.</p>
                  <p className="text-blue-700 text-[11px] mt-0.5">
                    Fabric compositions feed yarn requirement calculations during MRP explosion and costing funnels.
                  </p>
                </div>
              </div>
            </div>

            {/* Right 4 Cols: Live Donut Chart & Composition Summary */}
            <div className="lg:col-span-4 card overflow-hidden flex flex-col justify-between p-4 bg-gradient-to-b from-white to-slate-50/60">
              <div>
                <div className="flex items-center justify-between border-b border-surface-border pb-2.5 mb-3">
                  <div className="flex items-center gap-2">
                    <PieIcon size={16} className="text-brand-600" />
                    <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Composition Summary</h3>
                  </div>
                  <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-extrabold text-brand-700 border border-brand-200">
                    Live Chart
                  </span>
                </div>

                {/* Donut Chart Visualizer */}
                <CompositionDonutChart fibres={fibres} totalPct={totalPercentage} />

                {/* Fibres Legend */}
                <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                  {fibres
                    .filter((f) => Number(f.percentage) > 0)
                    .map((f) => {
                      const meta = FIBRE_TYPES.find((m) => m.name === f.fibre_type);
                      const color = meta?.color || '#3b82f6';
                      return (
                        <div key={f._key} className="flex items-center justify-between text-xs font-medium">
                          <div className="flex items-center gap-2">
                            <span className="h-3 w-3 rounded-full shrink-0 shadow-2xs" style={{ backgroundColor: color }} />
                            <span className="text-slate-800">{f.fibre_type}</span>
                            <span className="text-[10px] text-slate-400 font-mono">({f.fibre_category})</span>
                          </div>
                          <span className="font-mono font-bold text-slate-900 tabular-nums">
                            {Number(f.percentage).toFixed(2)} %
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Natural / Synthetic / Recycled Summary Tile Box */}
              <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3.5 shadow-2xs space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">Natural Fibre :</span>
                  <span className="font-mono font-bold text-slate-900 tabular-nums">{naturalPct.toFixed(2)} %</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 font-medium">Synthetic Fibre :</span>
                  <span className="font-mono font-bold text-slate-900 tabular-nums">{syntheticPct.toFixed(2)} %</span>
                </div>
                <div className="flex items-center justify-between text-xs pt-1.5 border-t border-slate-100">
                  <span className="text-emerald-700 font-bold flex items-center gap-1">
                    <Sparkles size={13} className="text-emerald-600" /> Recycled Fibre :
                  </span>
                  <span className="font-mono font-extrabold text-emerald-700 tabular-nums">{totalRecycledPct.toFixed(2)} %</span>
                </div>
              </div>
            </div>
          </div>

          {/* Card 3: Recycled Details */}
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
              <Sparkles size={15} className="text-emerald-600" />
              <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Recycled Details</h3>
            </div>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
                <Input
                  label="Total Recycled (%)"
                  type="number"
                  step="0.01"
                  value={compHead.total_recycled_pct}
                  onChange={(e) => setCompHead((c) => ({ ...c, total_recycled_pct: Number(e.target.value) || 0 }))}
                  disabled={!editable}
                />
                <Input
                  label="Recycled By Weight (%)"
                  type="number"
                  step="0.01"
                  value={compHead.recycled_by_weight}
                  onChange={(e) => setCompHead((c) => ({ ...c, recycled_by_weight: Number(e.target.value) || 0 }))}
                  disabled={!editable}
                />
                <Input
                  label="Recycled By Fibre (%)"
                  type="number"
                  step="0.01"
                  value={compHead.recycled_by_fibre}
                  onChange={(e) => setCompHead((c) => ({ ...c, recycled_by_fibre: Number(e.target.value) || 0 }))}
                  disabled={!editable}
                />
              </div>
              <Input
                label="Recycled Fibre Description"
                placeholder="e.g. Polyester is 20% recycled GRS certified post-consumer PET fibre."
                value={compHead.recycled_desc}
                onChange={(e) => setCompHead((c) => ({ ...c, recycled_desc: e.target.value }))}
                disabled={!editable}
              />
            </div>
          </div>
        </div>
      )}

      {/* ──────────────────────────────────────────────────────────────────────────
          TAB 2: GENERAL INFORMATION
          ────────────────────────────────────────────────────────────────────────── */}
      {tab === 'general' && (
        <div className="card p-4 space-y-4">
          <div className="flex items-center gap-2 border-b border-surface-border pb-2.5">
            <span className="h-2 w-2 rounded-full bg-brand-500" />
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Fabric Identity & Master Details</h3>
          </div>

          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              label="Fabric Code"
              required
              placeholder="e.g. FAB-SJ-180"
              value={head.fabric_code}
              onChange={(e) => setHead((s: any) => ({ ...s, fabric_code: e.target.value }))}
              disabled={!editable}
              error={errors.fabric_code}
            />
            <div className="lg:col-span-2">
              <Input
                label="Fabric Name"
                required
                placeholder="e.g. 100% Cotton Single Jersey 180 GSM Bio-Washed"
                value={head.fabric_name}
                onChange={(e) => setHead((s: any) => ({ ...s, fabric_name: e.target.value }))}
                disabled={!editable}
                error={errors.fabric_name}
              />
            </div>
            <Select
              label="Fabric Type"
              required
              options={['KNIT', 'WOVEN', 'NONWOVEN'].map((v) => ({ value: v, label: humanize(v) }))}
              value={head.fabric_type || 'KNIT'}
              onChange={(e) => setHead((s: any) => ({ ...s, fabric_type: e.target.value }))}
              disabled={!editable}
            />
            <Select
              label="Knit / Woven Structure"
              options={KNIT_STRUCTURES.map((v) => ({ value: v, label: v }))}
              value={head.knit_structure || 'Single Jersey'}
              onChange={(e) => setHead((s: any) => ({ ...s, knit_structure: e.target.value }))}
              disabled={!editable}
            />
            <Select
              label="GSM"
              options={toOptions(gsms.data)}
              placeholder="— Select GSM —"
              value={head.gsm_id || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, gsm_id: e.target.value }))}
              disabled={!editable}
            />
            <Select
              label="Primary Yarn Feed"
              options={toOptions(yarns.data)}
              placeholder="— Select Primary Yarn —"
              value={head.yarn_id || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, yarn_id: e.target.value }))}
              disabled={!editable}
            />
            <Select
              label="Material Category"
              options={toOptions(categories.data)}
              placeholder="— Select Category —"
              value={head.category_id || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, category_id: e.target.value }))}
              disabled={!editable}
            />
            <Select
              label="Finishing Type"
              options={FINISH_TYPES.map((v) => ({ value: v, label: v }))}
              value={head.finish_type || 'Bio-Wash (Enzyme)'}
              onChange={(e) => setHead((s: any) => ({ ...s, finish_type: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="HSN Code"
              placeholder="e.g. 6006"
              value={head.hsn_code || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, hsn_code: e.target.value }))}
              disabled={!editable}
            />
            <Select
              label="Base UOM"
              required
              options={toOptions(uoms.data)}
              value={head.base_uom || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, base_uom: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="Standard Rate (₹ / KG)"
              type="number"
              step="0.01"
              placeholder="420.00"
              value={head.std_rate || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, std_rate: e.target.value === '' ? '' : Number(e.target.value) }))}
              disabled={!editable}
            />
            <Select
              label="Status"
              options={[
                { value: 1, label: 'Active' },
                { value: 0, label: 'Inactive' },
              ]}
              value={head.is_active ?? 1}
              onChange={(e) => setHead((s: any) => ({ ...s, is_active: Number(e.target.value) }))}
              disabled={!editable}
            />
          </div>
        </div>
      )}

      {/* ──────────────────────────────────────────────────────────────────────────
          TAB 3: TECHNICAL & CONSTRUCTION
          ────────────────────────────────────────────────────────────────────────── */}
      {tab === 'construction' && (
        <div className="card p-4 space-y-4">
          <div className="flex items-center gap-2 border-b border-surface-border pb-2.5">
            <Sliders size={15} className="text-brand-600" />
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Knitting & Dimension Specifications</h3>
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              label="Width (cm)"
              type="number"
              step="0.1"
              placeholder="e.g. 180"
              value={head.width_cm || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, width_cm: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="Diameter (Dia Inches)"
              type="number"
              step="0.1"
              placeholder="e.g. 30"
              value={head.dia_inch || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, dia_inch: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="Knitting Gauge (GG)"
              placeholder="e.g. 24 GG / 28 GG"
              value={head.gauge || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, gauge: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="Max Shrinkage Length (%)"
              type="number"
              step="0.1"
              placeholder="e.g. 5.0"
              value={head.shrinkage_length || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, shrinkage_length: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="Max Shrinkage Width (%)"
              type="number"
              step="0.1"
              placeholder="e.g. 5.0"
              value={head.shrinkage_width || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, shrinkage_width: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="Spirality (%)"
              type="number"
              step="0.1"
              placeholder="e.g. 3.0"
              value={head.spirality_pct || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, spirality_pct: Number(e.target.value) }))}
              disabled={!editable}
            />
          </div>
        </div>
      )}

      {/* ──────────────────────────────────────────────────────────────────────────
          TAB 4: DYEING & QUALITY
          ────────────────────────────────────────────────────────────────────────── */}
      {tab === 'dyeing' && (
        <div className="card p-4 space-y-4">
          <div className="flex items-center gap-2 border-b border-surface-border pb-2.5">
            <Droplets size={15} className="text-brand-600" />
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Dyeing & Color Fastness Ratings</h3>
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              label="Dyeing Method / Dye Type"
              placeholder="e.g. Reactive Dyeing (Soft Flow)"
              value={head.dye_type || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, dye_type: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="Color Fastness to Washing"
              placeholder="e.g. 4-5 (ISO 105 C06)"
              value={head.color_fastness_washing || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, color_fastness_washing: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="Color Fastness to Rubbing / Crocking"
              placeholder="e.g. 4 (Dry) / 3-4 (Wet)"
              value={head.color_fastness_rubbing || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, color_fastness_rubbing: e.target.value }))}
              disabled={!editable}
            />
          </div>
        </div>
      )}

      {/* ──────────────────────────────────────────────────────────────────────────
          TAB 5: STOCK & UOM
          ────────────────────────────────────────────────────────────────────────── */}
      {tab === 'stock' && (
        <div className="card p-4 space-y-4">
          <div className="flex items-center gap-2 border-b border-surface-border pb-2.5">
            <Package size={15} className="text-brand-600" />
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Fabric Inventory & Rolls On Hand</h3>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Current Warehouse Stock</span>
              <p className="mt-1 text-2xl font-black text-slate-900 tabular-nums">8,640 <span className="text-xs font-semibold text-slate-400">KG</span></p>
              <span className="text-[11px] text-emerald-600 font-medium">360 Rolls in greige & dyed stores</span>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4">
              <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700">Allocated to Cutting</span>
              <p className="mt-1 text-2xl font-black text-blue-900 tabular-nums">5,200 <span className="text-xs font-semibold text-blue-500">KG</span></p>
              <span className="text-[11px] text-blue-600 font-medium">Assigned to Production Orders</span>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Free Available Stock</span>
              <p className="mt-1 text-2xl font-black text-emerald-900 tabular-nums">3,440 <span className="text-xs font-semibold text-emerald-500">KG</span></p>
              <span className="text-[11px] text-emerald-700 font-medium">Available for new production planning</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ==============================================================================
   3. DONUT CHART SVG COMPONENT (Visual Live Donut)
   ============================================================================== */
function CompositionDonutChart({
  fibres,
  totalPct,
}: {
  fibres: FibreComponent[];
  totalPct: number;
}) {
  const activeFibres = fibres.filter((f) => Number(f.percentage) > 0);
  const size = 180;
  const strokeWidth = 26;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let cumulativeAngle = 0;

  return (
    <div className="relative flex flex-col items-center justify-center py-2">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rotate-[-90deg]">
        {/* Background track */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="transparent"
          stroke="#f1f5f9"
          strokeWidth={strokeWidth}
        />

        {/* Dynamic Segments */}
        {activeFibres.map((f) => {
          const pct = Number(f.percentage) || 0;
          const strokeDasharray = `${(pct / 100) * circumference} ${circumference}`;
          const strokeDashoffset = -((cumulativeAngle / 100) * circumference);
          cumulativeAngle += pct;

          const meta = FIBRE_TYPES.find((m) => m.name === f.fibre_type);
          const color = meta?.color || '#3b82f6';

          return (
            <circle
              key={f._key}
              cx={center}
              cy={center}
              r={radius}
              fill="transparent"
              stroke={color}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              className="transition-all duration-500 ease-out"
            />
          );
        })}
      </svg>

      {/* Center Label */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        <span className="text-xl font-black tabular-nums text-slate-900">
          {totalPct.toFixed(0)}%
        </span>
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total</span>
      </div>
    </div>
  );
}
