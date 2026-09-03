import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, PieChart as PieIcon, Layers, FileText, CheckCircle2,
  SlidersHorizontal, Copy, Check, Info, Sparkles, Tag, Scissors, RefreshCw, Upload, Image as ImageIcon
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, Input, Select, Spinner, Badge,
  LoadingBlock, ErrorState, useDebounced
} from '../../components/ui';
import { fmtDecimal } from '../../lib/format';

/* ────────────────────────────────────────────────────────────────────────── */
/* Types & Constants                                                          */
/* ────────────────────────────────────────────────────────────────────────── */
export interface FibreDetailLine {
  _key: string;
  id?: number;
  fibre_name: string;
  percentage: number | '';
}

export interface FabricVariantLine {
  _key: string;
  id?: number;
  fabric_code: string;
  fabric_name: string;
  gsm_id?: number | string;
  gsm_value?: number | string;
  width_cm?: number | string;
  dia_inch?: number | string;
  gauge?: string;
  std_rate: number | string;
  is_active: number;
}

let fibreLineSeq = 0;
let variantLineSeq = 0;

const FIBRE_COLOR_PALETTE = [
  '#0284c7', // Brand Sky
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#84cc16', // Lime
  '#64748b', // Slate
];

const FIBRE_PRESETS = [
  'Cotton (Organic)',
  'Cotton (BCI)',
  'Cotton (Carded)',
  'Cotton (Combed)',
  'Polyester (Virgin)',
  'Polyester (Recycled / rPET)',
  'Elastane / Spandex',
  'Viscose / Rayon',
  'Modal',
  'Tencel / Lyocell',
  'Linen',
  'Wool',
  'Nylon / Polyamide',
  'Silk',
  'Bamboo Fibre',
  'Other Blend',
];

const KNIT_STRUCTURES = [
  'Single Jersey',
  '1x1 Rib',
  '2x2 Rib',
  'Interlock',
  'Pique / Polo',
  'Honey Comb',
  'French Terry',
  'Fleece (2-Thread)',
  'Fleece (3-Thread Brushed)',
  'Waffle',
  'Pointelle',
  'Jacquard Knit',
  'Auto Stripe',
  'Velour',
  'Twill (Woven)',
  'Poplin (Woven)',
  'Canvas (Woven)',
  'Oxford (Woven)',
  'Other Construction',
];

const FINISH_TYPES = [
  'Bio-wash + Silicon Softener',
  'Bio-wash (Enzyme)',
  'Silicon Softener Finish',
  'Mercerized + Bio-wash',
  'Mercerized Finish',
  'Peached / Sueded Finish',
  'Brushed Finish',
  'Anti-Pilling Finish',
  'Moisture Wicking / Quick Dry',
  'Water Repellent (DWR)',
  'Anti-Microbial / Anti-Bacterial',
  'Greige / Unfinished',
  'Standard Soft Finish',
];

const STANDARD_GSM_PRESETS = [
  { gsm: 140, label: '140 GSM', defaultDia: 30, defaultWidth: 150, rate: 385 },
  { gsm: 160, label: '160 GSM', defaultDia: 32, defaultWidth: 160, rate: 405 },
  { gsm: 180, label: '180 GSM', defaultDia: 34, defaultWidth: 170, rate: 420 },
  { gsm: 200, label: '200 GSM', defaultDia: 34, defaultWidth: 180, rate: 445 },
  { gsm: 220, label: '220 GSM', defaultDia: 34, defaultWidth: 185, rate: 465 },
  { gsm: 240, label: '240 GSM', defaultDia: 36, defaultWidth: 190, rate: 485 },
  { gsm: 280, label: '280 GSM', defaultDia: 36, defaultWidth: 200, rate: 520 },
];

function parseCompositionToLines(desc?: string): FibreDetailLine[] {
  if (!desc) return [{ _key: `fl_${++fibreLineSeq}`, fibre_name: 'Cotton (Organic)', percentage: 100 }];
  const parts = desc.split(/[\/,+]/).map((s) => s.trim()).filter(Boolean);
  const lines: FibreDetailLine[] = [];
  for (const part of parts) {
    const match = part.match(/^(\d+(?:\.\d+)?)\s*%\s*(.+)$/i);
    if (match) {
      lines.push({
        _key: `fl_${++fibreLineSeq}`,
        percentage: parseFloat(match[1]) || 0,
        fibre_name: match[2].trim(),
      });
    } else {
      lines.push({
        _key: `fl_${++fibreLineSeq}`,
        percentage: parts.length === 1 ? 100 : 0,
        fibre_name: part,
      });
    }
  }
  return lines.length > 0 ? lines : [{ _key: `fl_${++fibreLineSeq}`, fibre_name: 'Cotton (Organic)', percentage: 100 }];
}

/* ==============================================================================
   1. FABRIC LIST VIEW (Base Masters & Count Variants Switcher)
   ============================================================================== */
export function FabricsPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [view, setView] = useState<'bases' | 'variants'>('bases');

  const { page, setPage, search, setSearch, sort, onSort } = useListState({
    key: view === 'bases' ? 'base_name' : 'fabric_name',
    dir: 'asc',
  });
  const debounced = useDebounced(search);
  const [fabricType, setFabricType] = useState('');
  const [certFilter, setCertFilter] = useState('');
  const [structureFilter, setStructureFilter] = useState('');

  // List of Fabric Bases
  const basesList = useList<any>('fabric-bases', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    fabric_type: fabricType || undefined,
    certification: certFilter || undefined,
  });

  // List of All SKU Variants
  const variantsList = useList<any>('fabrics', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    fabric_type: fabricType || undefined,
    knit_structure: structureFilter || undefined,
  });

  return (
    <>
      <PageHeader
        title="Fabric Masters"
        subtitle="2-Tier Architecture: Base structures (Fibre, Weave, Finish, Cert) &amp; GSM/Width Inventory SKUs"
        actions={
          can('MATERIAL.CREATE') && (
            <button className="btn-primary" onClick={() => nav('/masters/fabrics/new')}>
              <Plus size={15} /> New Fabric Base
            </button>
          )
        }
      />

      {/* View Switcher Tabs & Filters */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
        <div className="inline-flex rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => { setView('bases'); setPage(1); }}
            className={`flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-bold transition-all ${
              view === 'bases'
                ? 'bg-white text-brand-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Layers size={14} />
            Fabric Base Masters
          </button>
          <button
            type="button"
            onClick={() => { setView('variants'); setPage(1); }}
            className={`flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-bold transition-all ${
              view === 'variants'
                ? 'bg-white text-brand-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <SlidersHorizontal size={14} />
            All GSM Variants / SKUs
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={view === 'bases' ? "Search base code, structure, cert…" : "Search item code, GSM, fabric…"}
            />
          </div>
          <div className="w-36">
            <Select
              placeholder="All Types"
              options={[
                { value: 'KNIT', label: 'Knit' },
                { value: 'WOVEN', label: 'Woven' },
                { value: 'NONWOVEN', label: 'Non-Woven' },
              ]}
              value={fabricType}
              onChange={(e) => {
                setFabricType(e.target.value);
                setPage(1);
              }}
            />
          </div>
          {view === 'bases' ? (
            <div className="w-40">
              <Select
                placeholder="All Certifications"
                options={[
                  { value: 'GOTS', label: 'GOTS' },
                  { value: 'OEKO-TEX', label: 'OEKO-TEX' },
                  { value: 'BCI', label: 'BCI' },
                  { value: 'GRS', label: 'GRS' },
                  { value: 'OCS', label: 'OCS' },
                  { value: 'NONE', label: 'None / Standard' },
                ]}
                value={certFilter}
                onChange={(e) => {
                  setCertFilter(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          ) : (
            <div className="w-44">
              <Select
                placeholder="All Structures"
                options={KNIT_STRUCTURES.map(s => ({ value: s, label: s }))}
                value={structureFilter}
                onChange={(e) => {
                  setStructureFilter(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* VIEW 1: FABRIC BASES TABLE */}
      {view === 'bases' ? (
        <DataTable
          items={basesList.items}
          total={basesList.total}
          page={page}
          pageSize={25}
          loading={basesList.isLoading}
          sort={sort}
          onSort={onSort}
          onPageChange={setPage}
          onRowClick={(row) => nav(`/masters/fabrics/${row.id}`)}
          columns={[
            {
              key: 'base_code',
              header: 'Base Code',
              sortable: true,
              render: (r) => (
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-brand-700">{r.base_code}</span>
                  {r.image_url && (
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-100 text-slate-500" title="Has swatch image">
                      <ImageIcon size={12} />
                    </span>
                  )}
                </div>
              ),
            },
            {
              key: 'base_name',
              header: 'Fabric Base Name',
              sortable: true,
              render: (r) => (
                <div>
                  <div className="font-bold text-slate-900">{r.base_name}</div>
                  <div className="text-[11px] text-slate-500 font-medium">
                    {r.composition_desc || r.composition || '100% Cotton'}
                  </div>
                </div>
              ),
            },
            {
              key: 'knit_structure',
              header: 'Structure / Weave',
              render: (r) => (
                <div className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800">
                  <Scissors size={12} className="text-slate-500" />
                  {r.knit_structure || 'Single Jersey'}
                </div>
              ),
            },
            {
              key: 'fabric_type',
              header: 'Type',
              render: (r) => (
                <span className={`inline-flex rounded px-2 py-0.5 text-[11px] font-bold ${
                  r.fabric_type === 'KNIT' ? 'bg-indigo-50 text-indigo-700' :
                  r.fabric_type === 'WOVEN' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-700'
                }`}>
                  {r.fabric_type}
                </span>
              ),
            },
            {
              key: 'finish_type',
              header: 'Finish & Treatment',
              render: (r) => (
                <span className="text-xs text-slate-600 font-medium truncate max-w-[180px] block" title={r.finish_type}>
                  {r.finish_type || 'Bio-wash + Silicon'}
                </span>
              ),
            },
            {
              key: 'certification',
              header: 'Certification',
              render: (r) => (
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  r.certification === 'GOTS' ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' :
                  r.certification === 'OEKO-TEX' ? 'bg-blue-100 text-blue-800 border border-blue-300' :
                  r.certification === 'BCI' ? 'bg-teal-100 text-teal-800 border border-teal-300' :
                  r.certification === 'GRS' ? 'bg-purple-100 text-purple-800 border border-purple-300' :
                  'bg-slate-100 text-slate-600'
                }`}>
                  {r.certification || 'NONE'}
                </span>
              ),
            },
            {
              key: 'variant_count',
              header: 'GSM Variants',
              render: (r) => {
                const count = Number(r.variant_count) || 0;
                return (
                  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${
                    count > 0 ? 'bg-brand-50 text-brand-700 border border-brand-200' : 'bg-rose-50 text-rose-700'
                  }`}>
                    {count} {count === 1 ? 'GSM SKU' : 'GSM SKUs'}
                  </span>
                );
              },
            },
            {
              key: 'is_active',
              header: 'Status',
              render: (r) => (
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  r.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${r.is_active ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                  {r.is_active ? 'Active' : 'Inactive'}
                </span>
              ),
            },
          ]}
        />
      ) : (
        /* VIEW 2: ALL SKU VARIANTS TABLE */
        <DataTable
          items={variantsList.items}
          total={variantsList.total}
          page={page}
          pageSize={25}
          loading={variantsList.isLoading}
          sort={sort}
          onSort={onSort}
          onPageChange={setPage}
          onRowClick={(row) => row.fabric_base_id ? nav(`/masters/fabrics/${row.fabric_base_id}`) : undefined}
          columns={[
            {
              key: 'fabric_code',
              header: 'Item SKU Code',
              sortable: true,
              render: (r) => (
                <span className="font-mono font-bold text-brand-700">{r.fabric_code}</span>
              ),
            },
            {
              key: 'fabric_name',
              header: 'Fabric Item Name',
              sortable: true,
              render: (r) => (
                <div>
                  <div className="font-bold text-slate-900">{r.fabric_name}</div>
                  {r.base_name && (
                    <div className="text-[11px] text-slate-500 font-medium">
                      Base: {r.base_name} ({r.base_code})
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'gsm_value',
              header: 'GSM',
              render: (r) => (
                <span className="inline-flex rounded bg-blue-50 px-2 py-0.5 font-mono text-xs font-bold text-blue-700">
                  {r.gsm_value ? `${r.gsm_value} GSM` : '—'}
                </span>
              ),
            },
            {
              key: 'dia_inch',
              header: 'Width / Dia',
              render: (r) => (
                <span className="text-xs font-medium text-slate-700">
                  {r.dia_inch ? `${r.dia_inch}" Dia` : ''} {r.width_cm ? `(${r.width_cm} cm)` : ''}
                </span>
              ),
            },
            {
              key: 'gauge',
              header: 'Gauge',
              render: (r) => (
                <span className="font-mono text-xs font-semibold text-slate-600">
                  {r.gauge || '24 GG'}
                </span>
              ),
            },
            {
              key: 'knit_structure',
              header: 'Structure',
              render: (r) => (
                <span className="text-xs text-slate-700 font-medium">
                  {r.knit_structure || 'Single Jersey'}
                </span>
              ),
            },
            {
              key: 'std_rate',
              header: 'Std Rate (₹/Kg)',
              render: (r) => (
                <span className="font-mono text-xs font-bold text-slate-900">
                  ₹{fmtDecimal(r.std_rate, 2)}
                </span>
              ),
            },
            {
              key: 'is_active',
              header: 'Status',
              render: (r) => (
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  r.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${r.is_active ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                  {r.is_active ? 'Active' : 'Draft'}
                </span>
              ),
            },
          ]}
        />
      )}
    </>
  );
}

/* ==============================================================================
   2. 2-TIER FABRIC BASE COCKPIT & GSM VARIANTS GENERATOR
   ============================================================================== */
export function FabricDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [saving, setSaving] = useState(false);

  // Lookups
  const categories = useLookup('material-categories');
  const uoms = useLookup('uoms');
  const gsmList = useLookup('gsm');
  const yarns = useLookup('yarns');

  // Base Form State
  const [head, setHead] = useState<Record<string, any>>({
    base_code: '',
    base_name: '',
    category_id: '',
    fabric_type: 'KNIT',
    knit_structure: 'Single Jersey',
    yarn_id: '',
    finish_type: 'Bio-wash + Silicon Softener',
    certification: 'GOTS',
    hsn_code: '6006',
    base_uom: '',
    image_url: '',
    description: '',
    is_active: 1,
    composition_id: '',
  });

  // Fibre Composition Lines
  const [fibreLines, setFibreLines] = useState<FibreDetailLine[]>([
    { _key: 'fl_init_1', fibre_name: 'Cotton (Organic)', percentage: 100 },
  ]);

  // GSM Variants List
  const [variants, setVariants] = useState<FabricVariantLine[]>([
    {
      _key: 'var_1',
      fabric_code: '',
      fabric_name: 'Single Jersey 160 GSM 32" Dia',
      gsm_id: '',
      gsm_value: 160,
      width_cm: 160,
      dia_inch: 32,
      gauge: '24 GG',
      std_rate: 405,
      is_active: 1,
    },
    {
      _key: 'var_2',
      fabric_code: '',
      fabric_name: 'Single Jersey 180 GSM 34" Dia',
      gsm_id: '',
      gsm_value: 180,
      width_cm: 170,
      dia_inch: 34,
      gauge: '24 GG',
      std_rate: 420,
      is_active: 1,
    },
  ]);

  // Load existing Base & Variants
  const qBase = useQuery({
    queryKey: ['fabric-base-detail', id],
    queryFn: async () => {
      const res = await http.get<any>(`/api/resources/fabric-bases/${id}`);
      return res.data;
    },
    enabled: !isNew,
  });

  const qVariants = useQuery({
    queryKey: ['fabric-variants-by-base', id],
    queryFn: async () => {
      const res = await http.get<any>(`/api/resources/fabrics?fabric_base_id=${id}&pageSize=100`);
      return res.data?.items || [];
    },
    enabled: !isNew,
  });

  // Populate data when loaded
  useEffect(() => {
    if (qBase.data) {
      const b = qBase.data;
      setHead({
        base_code: b.base_code || '',
        base_name: b.base_name || '',
        category_id: b.category_id || '',
        fabric_type: b.fabric_type || 'KNIT',
        knit_structure: b.knit_structure || 'Single Jersey',
        yarn_id: b.yarn_id || '',
        finish_type: b.finish_type || 'Bio-wash + Silicon Softener',
        certification: b.certification || 'GOTS',
        hsn_code: b.hsn_code || '6006',
        base_uom: b.base_uom || '',
        image_url: b.image_url || '',
        description: b.description || '',
        is_active: b.is_active ?? 1,
        composition_id: b.composition_id || '',
      });

      // Populate fibre composition
      if (b.composition_desc) {
        setFibreLines(parseCompositionToLines(b.composition_desc));
      }
    }
  }, [qBase.data]);

  useEffect(() => {
    if (qVariants.data && qVariants.data.length > 0) {
      setVariants(
        qVariants.data.map((v: any) => ({
          _key: `var_${v.id}`,
          id: v.id,
          fabric_code: v.fabric_code || '',
          fabric_name: v.fabric_name || '',
          gsm_id: v.gsm_id || '',
          gsm_value: v.gsm_value || '',
          width_cm: v.width_cm || '',
          dia_inch: v.dia_inch || '',
          gauge: v.gauge || '24 GG',
          std_rate: v.std_rate ?? 0,
          is_active: v.is_active ?? 1,
        }))
      );
    }
  }, [qVariants.data]);

  // Defaults on new form
  useEffect(() => {
    if (isNew) {
      if (categories.data?.length && !head.category_id) {
        const cat = categories.data.find((c: any) => c.material_type === 'FABRIC' || c.code === 'CAT-FAB');
        if (cat) setHead((h) => ({ ...h, category_id: cat.id }));
      }
      if (uoms.data?.length && !head.base_uom) {
        const kg = uoms.data.find((u: any) => u.code === 'KG');
        if (kg) setHead((h) => ({ ...h, base_uom: kg.id }));
      }
      if (!head.base_code) {
        const rnd = Math.floor(1000 + Math.random() * 9000);
        setHead((h) => ({ ...h, base_code: `FB-${rnd}` }));
      }
    }
  }, [isNew, categories.data, uoms.data]);

  // Total Percentage Validator
  const totalPercentage = useMemo(() => {
    return fibreLines.reduce((acc, curr) => acc + (Number(curr.percentage) || 0), 0);
  }, [fibreLines]);

  const isValid100 = Math.abs(totalPercentage - 100) < 0.001;

  // Auto-derived Composition summary string
  const autoCompositionString = useMemo(() => {
    return fibreLines
      .filter((l) => Number(l.percentage) > 0 && l.fibre_name)
      .map((l) => `${l.percentage}% ${l.fibre_name}`)
      .join(' / ');
  }, [fibreLines]);

  // Fibre Line handlers
  const handleAddFibreLine = () => {
    const used = new Set(fibreLines.map((l) => l.fibre_name));
    const nextFibre = FIBRE_PRESETS.find((p) => !used.has(p)) || 'Cotton (Organic)';
    const remaining = Math.max(0, 100 - totalPercentage);
    setFibreLines((s) => [...s, { _key: `fl_${++fibreLineSeq}`, fibre_name: nextFibre, percentage: remaining || 0 }]);
  };

  const handleUpdateFibreLine = (key: string, patch: Partial<FibreDetailLine>) => {
    setFibreLines((s) => s.map((line) => (line._key === key ? { ...line, ...patch } : line)));
  };

  const handleRemoveFibreLine = (key: string) => {
    if (fibreLines.length <= 1) {
      toast('At least one fibre is required', 'info');
      return;
    }
    setFibreLines((s) => s.filter((l) => l._key !== key));
  };

  // Variant handlers
  const handleAddVariant = (presetGsm?: number, dia?: number, rate?: number) => {
    const baseCode = (head.base_code || 'FB-01').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const gsmVal = presetGsm || 180;
    const diaVal = dia || 34;
    const gsmMatch = (gsmList.data || []).find((g: any) => Number(g.code) === gsmVal);

    setVariants((s) => [
      ...s,
      {
        _key: `var_${++variantLineSeq}`,
        fabric_code: `FAB-${baseCode}-${gsmVal}-${diaVal}D`,
        fabric_name: `${head.base_name || 'Fabric'} ${gsmVal} GSM ${diaVal}" Dia`,
        gsm_id: gsmMatch?.id || '',
        gsm_value: gsmVal,
        width_cm: Math.round(diaVal * 5),
        dia_inch: diaVal,
        gauge: '24 GG',
        std_rate: rate || 420,
        is_active: 1,
      },
    ]);
  };

  const handleUpdateVariant = (key: string, field: keyof FabricVariantLine, val: any) => {
    setVariants((s) =>
      s.map((v) => {
        if (v._key !== key) return v;
        const updated = { ...v, [field]: val };
        // If GSM dropdown changed, update gsm_value
        if (field === 'gsm_id') {
          const matchedGsm = (gsmList.data || []).find((g: any) => String(g.id) === String(val));
          if (matchedGsm) {
            updated.gsm_value = Number(matchedGsm.code) || matchedGsm.code;
            updated.fabric_name = `${head.base_name || 'Fabric'} ${matchedGsm.code} GSM ${v.dia_inch ? `${v.dia_inch}" Dia` : ''}`;
          }
        }
        return updated;
      })
    );
  };

  const handleDuplicateVariant = (key: string) => {
    const target = variants.find((v) => v._key === key);
    if (!target) return;
    setVariants((s) => [
      ...s,
      {
        ...target,
        _key: `var_${++variantLineSeq}`,
        id: undefined,
        fabric_code: target.fabric_code ? `${target.fabric_code}-COPY` : '',
      },
    ]);
  };

  const handleRemoveVariant = (key: string) => {
    if (variants.length <= 1) {
      toast('At least one GSM variant is required for a Fabric Base', 'info');
      return;
    }
    setVariants((s) => s.filter((v) => v._key !== key));
  };

  const editable = can(isNew ? 'MATERIAL.CREATE' : 'MATERIAL.UPDATE');

  // Auto-fill codes if empty
  const handleAutoGenerateCodes = () => {
    const baseCode = (head.base_code || 'FB01').toUpperCase().replace(/[^A-Z0-9]/g, '');
    setVariants((s) =>
      s.map((v) => {
        const gsm = v.gsm_value || 180;
        const dia = v.dia_inch ? `${v.dia_inch}D` : 'OW';
        return {
          ...v,
          fabric_code: `FAB-${baseCode}-${gsm}-${dia}`,
          fabric_name: `${head.base_name || 'Fabric'} ${gsm} GSM ${v.dia_inch ? `${v.dia_inch}" Dia` : ''}`,
        };
      })
    );
    toast('Generated standard Fabric Variant Item Codes', 'success');
  };

  // SAVE BATCH
  const handleSaveAll = async () => {
    if (!head.base_code?.trim()) {
      toast('Fabric Base Code is required', 'info');
      return;
    }
    if (!head.base_name?.trim()) {
      toast('Fabric Base Name is required', 'info');
      return;
    }
    if (!head.base_uom) {
      toast('Base UOM is required', 'info');
      return;
    }
    if (!isValid100) {
      toast(`Fibre composition must total exactly 100% (currently ${totalPercentage.toFixed(1)}%)`, 'info');
      return;
    }
    if (variants.length === 0) {
      toast('Please add at least one GSM variant', 'info');
      return;
    }

    setSaving(true);
    try {
      // 1. Create or Find Composition Record
      let compositionId = head.composition_id;
      if (autoCompositionString) {
        try {
          const compRes = await http.post<any>('/api/resources/compositions', {
            code: `COMP-${Date.now().toString().slice(-6)}`,
            description: autoCompositionString,
            is_active: 1,
          });
          compositionId = compRes.data?.id;
        } catch {
          // ignore duplicate composition error
        }
      }

      // 2. Save Fabric Base Master
      const basePayload = {
        base_code: head.base_code.trim().toUpperCase(),
        base_name: head.base_name.trim(),
        category_id: head.category_id || null,
        fabric_type: head.fabric_type,
        knit_structure: head.knit_structure || null,
        yarn_id: head.yarn_id || null,
        finish_type: head.finish_type || null,
        certification: head.certification || 'NONE',
        hsn_code: head.hsn_code || '6006',
        base_uom: head.base_uom,
        image_url: head.image_url || null,
        description: head.description || autoCompositionString,
        composition_id: compositionId || null,
        is_active: head.is_active ? 1 : 0,
      };

      let baseId = id;
      if (isNew) {
        const created = await http.post<any>('/api/resources/fabric-bases', basePayload);
        baseId = created.data?.id;
      } else {
        await http.put(`/api/resources/fabric-bases/${id}`, basePayload);
      }

      // 3. Save / Synchronize Child Variants
      for (const v of variants) {
        const vPayload = {
          fabric_base_id: baseId,
          fabric_code: v.fabric_code.trim().toUpperCase(),
          fabric_name: v.fabric_name.trim(),
          category_id: head.category_id || null,
          fabric_type: head.fabric_type,
          knit_structure: head.knit_structure || null,
          composition_id: compositionId || null,
          gsm_id: v.gsm_id || null,
          width_cm: Number(v.width_cm) || 0,
          dia_inch: Number(v.dia_inch) || 0,
          gauge: v.gauge || '24 GG',
          yarn_id: head.yarn_id || null,
          finish_type: head.finish_type || null,
          hsn_code: head.hsn_code || '6006',
          base_uom: head.base_uom,
          std_rate: Number(v.std_rate) || 0,
          is_active: v.is_active ? 1 : 0,
        };

        if (v.id) {
          await http.put(`/api/resources/fabrics/${v.id}`, vPayload);
        } else {
          await http.post('/api/resources/fabrics', vPayload);
        }
      }

      toast('Fabric Base and All Variants saved successfully!', 'success');
      qc.invalidateQueries({ queryKey: ['fabric-bases'] });
      qc.invalidateQueries({ queryKey: ['fabrics'] });
      qc.invalidateQueries({ queryKey: ['fabric-base-detail', String(baseId)] });
      qc.invalidateQueries({ queryKey: ['fabric-variants-by-base', String(baseId)] });

      if (isNew) {
        nav(`/masters/fabrics/${baseId}`);
      }
    } catch (err: any) {
      toast(err instanceof ApiError ? err.message : (err?.message || 'Failed to save fabric base'), 'info');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this Fabric Base and its variants?')) return;
    try {
      await http.delete(`/api/resources/fabric-bases/${id}`);
      toast('Fabric Base deleted', 'success');
      qc.invalidateQueries({ queryKey: ['fabric-bases'] });
      qc.invalidateQueries({ queryKey: ['fabrics'] });
      nav('/masters/fabrics');
    } catch (err: any) {
      toast(err?.message || 'Failed to delete fabric base', 'info');
    }
  };

  if (!isNew && qBase.isLoading) return <LoadingBlock />;
  if (!isNew && qBase.isError) return <ErrorState error={qBase.error} />;

  return (
    <div className="space-y-6 pb-20">
      {/* Top Header */}
      <PageHeader
        title={isNew ? 'New Fabric Base Master' : `${head.base_name || 'Fabric Base'} (${head.base_code})`}
        subtitle="2-Tier Parent Master: Base Construction, Finish, Certification &amp; Linked GSM Variants"
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => nav('/masters/fabrics')}>
              <ArrowLeft size={15} /> Back to List
            </button>
            {!isNew && can('MATERIAL.DELETE') && (
              <button type="button" className="btn-danger" onClick={handleDelete}>
                <Trash2 size={15} /> Delete
              </button>
            )}
            {editable && (
              <button
                type="button"
                className="btn-primary flex items-center gap-1.5 shadow-md hover:shadow-lg"
                onClick={handleSaveAll}
                disabled={saving}
              >
                {saving ? <Spinner size={15} /> : <Save size={15} />}
                {isNew ? 'Create Fabric Base & Variants' : 'Save All Changes'}
              </button>
            )}
          </div>
        }
      />

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* SECTION 1: FABRIC BASE SPECIFICATIONS                                     */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <div className="card p-5 border border-slate-200 shadow-sm bg-white">
        <div className="flex items-center justify-between border-b border-surface-border pb-3 mb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Layers size={16} />
            </span>
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900">
                1. Fabric Base Identity &amp; Construction
              </h2>
              <p className="text-xs text-slate-500">
                Universal identity (Weave, Finish, Certification) applied across all GSM variants
              </p>
            </div>
          </div>
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${
            head.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
          }`}>
            <span className={`h-2 w-2 rounded-full ${head.is_active ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            {head.is_active ? 'Active Master' : 'Draft Master'}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label">Fabric Base Code *</label>
            <div className="flex gap-1">
              <Input
                value={head.base_code}
                disabled={!editable}
                onChange={(e) => setHead({ ...head, base_code: e.target.value.toUpperCase() })}
                placeholder="e.g. FB-00001"
                className="font-mono font-bold text-brand-700"
              />
              <button
                type="button"
                className="btn-secondary px-2 text-xs font-mono font-bold"
                title="Auto Generate Code"
                onClick={() => setHead({ ...head, base_code: `FB-${Math.floor(1000 + Math.random() * 9000)}` })}
              >
                Auto
              </button>
            </div>
          </div>

          <div className="lg:col-span-2">
            <label className="label">Fabric Base Name *</label>
            <Input
              value={head.base_name}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, base_name: e.target.value })}
              placeholder="e.g. Single Jersey (100% Combed Cotton)"
              className="font-semibold text-slate-900"
            />
          </div>

          <div>
            <label className="label">Material Category *</label>
            <Select
              value={head.category_id}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, category_id: e.target.value })}
              options={toOptions(categories.data || [], 'id', 'label')}
            />
          </div>

          <div>
            <label className="label">Fabric Type *</label>
            <Select
              value={head.fabric_type}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, fabric_type: e.target.value })}
              options={[
                { value: 'KNIT', label: 'Knit Fabric' },
                { value: 'WOVEN', label: 'Woven Fabric' },
                { value: 'NONWOVEN', label: 'Non-Woven' },
              ]}
            />
          </div>

          <div>
            <label className="label">Structure / Construction *</label>
            <Select
              value={head.knit_structure}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, knit_structure: e.target.value })}
              options={KNIT_STRUCTURES.map((s) => ({ value: s, label: s }))}
            />
          </div>

          <div>
            <label className="label">Primary Yarn Feed</label>
            <Select
              value={head.yarn_id}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, yarn_id: e.target.value })}
              options={[{ value: '', label: '— Select Primary Yarn —' }, ...toOptions(yarns.data || [], 'id', 'label')]}
            />
          </div>

          <div>
            <label className="label">Finish &amp; Treatment</label>
            <Select
              value={head.finish_type}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, finish_type: e.target.value })}
              options={FINISH_TYPES.map((f) => ({ value: f, label: f }))}
            />
          </div>

          <div>
            <label className="label">Environmental Certification</label>
            <Select
              value={head.certification}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, certification: e.target.value })}
              options={[
                { value: 'GOTS', label: 'GOTS (Global Organic Textile Standard)' },
                { value: 'OEKO-TEX', label: 'OEKO-TEX Standard 100' },
                { value: 'BCI', label: 'BCI (Better Cotton Initiative)' },
                { value: 'GRS', label: 'GRS (Global Recycled Standard)' },
                { value: 'OCS', label: 'OCS (Organic Content Standard)' },
                { value: 'NONE', label: 'None / Standard' },
              ]}
            />
          </div>

          <div>
            <label className="label">HSN Code</label>
            <Input
              value={head.hsn_code}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, hsn_code: e.target.value })}
              placeholder="6006"
              className="font-mono text-xs"
            />
          </div>

          <div>
            <label className="label">Base Inventory UOM *</label>
            <Select
              value={head.base_uom}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, base_uom: e.target.value })}
              options={toOptions(uoms.data || [], 'id', 'label')}
            />
          </div>

          <div>
            <label className="label">Master Status</label>
            <Select
              value={head.is_active}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, is_active: Number(e.target.value) })}
              options={[
                { value: 1, label: 'Active (Available for BOM / PO / Cutting)' },
                { value: 0, label: 'Inactive / Draft' },
              ]}
            />
          </div>

          <div className="lg:col-span-4">
            <label className="label">Fabric Description &amp; Technical Notes</label>
            <Input
              value={head.description}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, description: e.target.value })}
              placeholder="e.g. 100% Organic Combed Cotton Single Jersey with Bio-wash and silicon finish for ultra-soft handfeel."
            />
          </div>
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* SECTION 2: FIBRE COMPOSITION BREAKDOWN & DONUT VISUALIZER                 */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left 7 Cols: Fibre Composition Table */}
        <div className="lg:col-span-7 space-y-4">
          <div className="card p-5 border border-slate-200">
            <div className="flex items-center justify-between border-b border-surface-border pb-3 mb-4">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                  <Sparkles size={16} />
                </span>
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">
                    2. Fibre Composition Breakdown
                  </h3>
                  <p className="text-xs text-slate-500">
                    Must total exactly <span className="font-bold text-slate-700">100%</span>
                  </p>
                </div>
              </div>
              {editable && (
                <button
                  type="button"
                  onClick={handleAddFibreLine}
                  className="btn-secondary flex items-center gap-1 text-xs"
                >
                  <Plus size={13} /> Add Fibre
                </button>
              )}
            </div>

            {/* Interactive Fibre Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-surface-border bg-slate-50/75 text-[11px] font-bold uppercase text-slate-500">
                    <th className="py-2 px-2 w-8">#</th>
                    <th className="py-2 px-2">Fibre Name</th>
                    <th className="py-2 px-2 w-32 text-right">Ratio (%)</th>
                    {editable && <th className="py-2 px-2 w-12 text-center">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fibreLines.map((line, idx) => {
                    const color = FIBRE_COLOR_PALETTE[idx % FIBRE_COLOR_PALETTE.length];
                    return (
                      <tr key={line._key} className="hover:bg-slate-50/50">
                        <td className="py-2 px-2">
                          <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
                        </td>
                        <td className="py-1 px-2">
                          <input
                            type="text"
                            list={`fibre-presets-${line._key}`}
                            value={line.fibre_name}
                            disabled={!editable}
                            onChange={(e) => handleUpdateFibreLine(line._key, { fibre_name: e.target.value })}
                            placeholder="Select or type fibre name"
                            className="input py-1 px-2 font-medium text-slate-800 text-xs w-full"
                          />
                          <datalist id={`fibre-presets-${line._key}`}>
                            {FIBRE_PRESETS.map((p) => (
                              <option key={p} value={p} />
                            ))}
                          </datalist>
                        </td>
                        <td className="py-1 px-2 text-right">
                          <div className="relative inline-block w-24">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.1"
                              value={line.percentage}
                              disabled={!editable}
                              onChange={(e) =>
                                handleUpdateFibreLine(line._key, {
                                  percentage: e.target.value === '' ? '' : parseFloat(e.target.value) || 0,
                                })
                              }
                              className="input py-1 px-2 text-right font-mono font-bold text-xs w-full pr-6"
                            />
                            <span className="absolute right-2 top-1.5 text-xs text-slate-400 font-bold">%</span>
                          </div>
                        </td>
                        {editable && (
                          <td className="py-1 px-2 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveFibreLine(line._key)}
                              className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-colors"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                    <td colSpan={2} className="py-2.5 px-2 text-right text-xs uppercase text-slate-600">
                      Total Percentage:
                    </td>
                    <td className={`py-2.5 px-2 text-right font-mono font-black text-sm ${isValid100 ? 'text-emerald-700' : 'text-rose-600'}`}>
                      {totalPercentage.toFixed(1)}%
                    </td>
                    {editable && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>

        {/* Right 5 Cols: Live Composition Donut Chart */}
        <div className="lg:col-span-5 space-y-4">
          <div className="card p-4 overflow-hidden border border-slate-200">
            <div className="flex items-center justify-between border-b border-surface-border pb-2.5 mb-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                <PieIcon size={14} className="text-brand-600" /> Live Composition Visualizer
              </h3>
              {isValid100 ? (
                <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                  <CheckCircle2 size={13} /> 100% Balanced
                </span>
              ) : (
                <span className="text-[11px] font-bold text-rose-600">
                  {totalPercentage > 100 ? `Over by ${(totalPercentage - 100).toFixed(1)}%` : `Under by ${(100 - totalPercentage).toFixed(1)}%`}
                </span>
              )}
            </div>

            {/* Dynamic SVG Donut Chart */}
            <div className="flex flex-col items-center justify-center my-2">
              <div className="relative w-40 h-40">
                <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="38" fill="transparent" stroke="#e2e8f0" strokeWidth="14" />
                  {(() => {
                    let accumulatedPct = 0;
                    const circumference = 2 * Math.PI * 38;
                    return fibreLines.map((item, idx) => {
                      const pct = Number(item.percentage) || 0;
                      if (pct <= 0) return null;
                      const strokeLength = (pct / 100) * circumference;
                      const strokeOffset = ((100 - accumulatedPct) / 100) * circumference;
                      accumulatedPct += pct;
                      const color = FIBRE_COLOR_PALETTE[idx % FIBRE_COLOR_PALETTE.length];
                      return (
                        <circle
                          key={item._key}
                          cx="50"
                          cy="50"
                          r="38"
                          fill="transparent"
                          stroke={color}
                          strokeWidth="14"
                          strokeDasharray={`${strokeLength} ${circumference - strokeLength}`}
                          strokeDashoffset={strokeOffset}
                          className="transition-all duration-500 ease-out"
                        />
                      );
                    });
                  })()}
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
                  <span className={`text-xl font-black font-mono ${isValid100 ? 'text-slate-800' : 'text-rose-600'}`}>
                    {totalPercentage.toFixed(0)}%
                  </span>
                  <span className="text-[10px] uppercase font-bold text-slate-400">Composition</span>
                </div>
              </div>

              {/* Legend Badges */}
              <div className="mt-3 flex flex-wrap justify-center gap-1.5 w-full">
                {fibreLines.map((item, idx) => {
                  const color = FIBRE_COLOR_PALETTE[idx % FIBRE_COLOR_PALETTE.length];
                  const pct = Number(item.percentage) || 0;
                  if (pct <= 0) return null;
                  return (
                    <div
                      key={item._key}
                      className="flex items-center gap-1.5 rounded-full bg-slate-50 border border-slate-200 px-2.5 py-0.5 text-[11px] font-medium text-slate-700"
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                      <span className="truncate max-w-[110px]">{item.fibre_name || 'Fibre'}</span>
                      <span className="font-mono font-bold text-slate-900">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Generated String */}
            <div className="mt-3 rounded bg-slate-50 p-2 text-center text-xs font-semibold text-slate-700 border border-slate-200">
              <span className="text-slate-400 font-normal">Spec: </span>
              {autoCompositionString || '100% Organic Cotton'}
            </div>
          </div>
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* SECTION 3: FABRIC GSM & WIDTH VARIANTS GENERATOR TABLE                    */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <div className="card p-5 border border-slate-200 shadow-sm bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3 mb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
              <SlidersHorizontal size={16} />
            </span>
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900">
                3. Fabric Variants / GSM &amp; Width Specifications
              </h2>
              <p className="text-xs text-slate-500">
                Individual inventory items (SKUs) with specific GSM, Tube Dia / Width, and Rates for Cutting &amp; Purchase
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {editable && (
              <>
                <button
                  type="button"
                  onClick={handleAutoGenerateCodes}
                  className="btn-secondary flex items-center gap-1 text-xs"
                  title="Auto-format Item Codes based on Base Code + GSM + Dia"
                >
                  <RefreshCw size={13} /> Auto-format Codes
                </button>
                <button
                  type="button"
                  onClick={() => handleAddVariant()}
                  className="btn-primary flex items-center gap-1 text-xs"
                >
                  <Plus size={13} /> Add GSM Variant
                </button>
              </>
            )}
          </div>
        </div>

        {/* Quick Add Presets Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50 p-2.5 border border-slate-200">
          <span className="text-xs font-bold text-slate-700 flex items-center gap-1 mr-2">
            <Tag size={13} className="text-brand-600" /> Quick Add GSM Presets:
          </span>
          {STANDARD_GSM_PRESETS.map((p) => {
            const added = variants.some((v) => Number(v.gsm_value) === p.gsm);
            return (
              <button
                key={p.gsm}
                type="button"
                onClick={() => handleAddVariant(p.gsm, p.defaultDia, p.rate)}
                disabled={!editable}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-bold transition-all ${
                  added
                    ? 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                    : 'bg-white text-slate-800 border border-slate-300 hover:border-brand-500 hover:text-brand-700 hover:shadow-sm'
                }`}
              >
                {added && <Check size={12} className="text-brand-600" />}
                <span>+ {p.label} ({p.defaultDia}" Dia)</span>
              </button>
            );
          })}
        </div>

        {/* Variants Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-surface-border bg-slate-100/60 text-[11px] font-bold uppercase text-slate-600">
                <th className="py-2.5 px-3 w-8">#</th>
                <th className="py-2.5 px-2 min-w-[160px]">Unique Item SKU Code *</th>
                <th className="py-2.5 px-2 min-w-[220px]">Fabric Item Name *</th>
                <th className="py-2.5 px-2 w-32">GSM Specification</th>
                <th className="py-2.5 px-2 w-28">Width (cm)</th>
                <th className="py-2.5 px-2 w-28">Tube Dia (Inch)</th>
                <th className="py-2.5 px-2 w-24">Gauge</th>
                <th className="py-2.5 px-2 w-28 text-right">Std Rate (₹/Kg)</th>
                <th className="py-2.5 px-2 w-20 text-center">Status</th>
                {editable && <th className="py-2.5 px-2 w-16 text-center">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {variants.map((v, idx) => (
                <tr key={v._key} className="hover:bg-slate-50/70">
                  <td className="py-2 px-3 font-bold text-slate-400">{idx + 1}</td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      placeholder="e.g. FAB-SJ-160-32D"
                      value={v.fabric_code}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'fabric_code', e.target.value)}
                      className="input py-1 px-2 font-mono font-bold text-brand-700 text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      placeholder="e.g. Single Jersey 160 GSM 32 Dia"
                      value={v.fabric_name}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'fabric_name', e.target.value)}
                      className="input py-1 px-2 font-medium text-slate-800 text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <select
                      value={v.gsm_id}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'gsm_id', e.target.value)}
                      className="select py-1 px-2 font-bold text-xs w-full"
                    >
                      <option value="">{v.gsm_value ? `${v.gsm_value} GSM` : 'Select GSM'}</option>
                      {(gsmList.data ?? []).map((g: any) => (
                        <option key={g.id} value={g.id}>
                          {g.label || `${g.code} GSM`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="number"
                      placeholder="160"
                      value={v.width_cm}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'width_cm', e.target.value)}
                      className="input py-1 px-2 font-mono text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="number"
                      placeholder="32"
                      value={v.dia_inch}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'dia_inch', e.target.value)}
                      className="input py-1 px-2 font-mono text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      placeholder="24 GG"
                      value={v.gauge}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'gauge', e.target.value)}
                      className="input py-1 px-2 font-mono text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1 text-right">
                    <input
                      type="number"
                      step="0.5"
                      placeholder="420"
                      value={v.std_rate}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'std_rate', e.target.value)}
                      className="input py-1 px-2 font-mono font-bold text-right text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1 text-center">
                    <button
                      type="button"
                      disabled={!editable}
                      onClick={() => handleUpdateVariant(v._key, 'is_active', v.is_active ? 0 : 1)}
                      className={`inline-flex rounded px-2 py-0.5 text-[10px] font-bold ${
                        v.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {v.is_active ? 'Active' : 'Draft'}
                    </button>
                  </td>
                  {editable && (
                    <td className="py-1 px-1 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleDuplicateVariant(v._key)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          title="Duplicate GSM Variant"
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveVariant(v._key)}
                          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          title="Remove Variant"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Bottom Summary KPI Cards */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 pt-3 border-t border-slate-100">
          <div className="rounded-lg bg-blue-50/60 border border-blue-200 p-3 text-center">
            <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700">Total Variants</span>
            <div className="text-xl font-black text-blue-900 mt-0.5">{variants.length}</div>
          </div>
          <div className="rounded-lg bg-emerald-50/60 border border-emerald-200 p-3 text-center">
            <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Active SKUs</span>
            <div className="text-xl font-black text-emerald-900 mt-0.5">
              {variants.filter((v) => v.is_active).length}
            </div>
          </div>
          <div className="rounded-lg bg-amber-50/60 border border-amber-200 p-3 text-center">
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700">Inactive / Drafts</span>
            <div className="text-xl font-black text-amber-900 mt-0.5">
              {variants.filter((v) => !v.is_active).length}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
