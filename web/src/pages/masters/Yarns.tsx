import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, PieChart as PieIcon, Layers, FileText, CheckCircle2,
  Copy, Sparkles, SlidersHorizontal, Check, RefreshCw
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

export interface YarnVariantLine {
  _key: string;
  id?: number;
  yarn_code: string;
  yarn_name: string;
  count_id?: number | string;
  count_value: string;
  count_type: 'Ne' | 'Nm' | 'Denier' | 'Tex';
  ply: number;
  twist: string;
  std_rate: number | string;
  is_active: number;
}

let seq = 0;

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

const QUICK_COUNT_PRESETS = [
  { val: '20s', type: 'Ne' as const, rate: 260 },
  { val: '24s', type: 'Ne' as const, rate: 275 },
  { val: '30s', type: 'Ne' as const, rate: 295 },
  { val: '34s', type: 'Ne' as const, rate: 310 },
  { val: '40s', type: 'Ne' as const, rate: 330 },
  { val: '50s', type: 'Ne' as const, rate: 360 },
  { val: '60s', type: 'Ne' as const, rate: 395 },
  { val: '80s', type: 'Ne' as const, rate: 460 },
  { val: '75D/36F', type: 'Denier' as const, rate: 155 },
  { val: '150D', type: 'Denier' as const, rate: 165 },
];

/* ==============================================================================
   1. YARN LIST VIEW (Toggle between Yarn Bases and All SKU Variants)
   ============================================================================== */
export function YarnsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [view, setView] = useState<'bases' | 'variants'>('bases');
  
  const { page, setPage, search, setSearch, sort, onSort } = useListState({
    key: view === 'bases' ? 'base_name' : 'yarn_name',
    dir: 'asc',
  });
  const debounced = useDebounced(search);
  const [yarnType, setYarnType] = useState('');
  const [certFilter, setCertFilter] = useState('');

  // List of Yarn Bases
  const basesList = useList<any>('yarn-bases', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    yarn_type: yarnType || undefined,
    certification: certFilter || undefined,
  });

  // List of All SKU Variants
  const variantsList = useList<any>('yarns', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    yarn_type: yarnType || undefined,
  });

  return (
    <>
      <PageHeader
        title="Yarn Masters"
        subtitle="2-Tier Architecture: Base identities (Fibre, Composition, Cert) &amp; Count-wise Item SKUs"
        actions={
          can('MATERIAL.CREATE') && (
            <button className="btn-primary" onClick={() => nav('/masters/yarns/new')}>
              <Plus size={15} /> New Yarn Base
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
            Yarn Base Masters
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
            All Count Variants / SKUs
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={view === 'bases' ? "Search base code, name, cert…" : "Search item code, count, yarn…"}
            />
          </div>
          <div className="w-40">
            <Select
              placeholder="All Spinning Types"
              options={[
                { value: 'COMBED', label: 'Combed' },
                { value: 'CARDED', label: 'Carded' },
                { value: 'OE', label: 'Open End (OE)' },
                { value: 'COMPACT', label: 'Compact' },
                { value: 'MELANGE', label: 'Melange' },
                { value: 'SLUB', label: 'Slub' },
              ]}
              value={yarnType}
              onChange={(e) => {
                setYarnType(e.target.value);
                setPage(1);
              }}
            />
          </div>
          {view === 'bases' && (
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
          )}
        </div>
      </div>

      {/* VIEW 1: YARN BASES TABLE */}
      {view === 'bases' ? (
        <DataTable
          columns={[
            {
              key: 'base_code',
              header: 'Base Code',
              sortable: true,
              render: (r: any) => (
                <span className="font-mono text-[12px] font-semibold text-brand-700">
                  {r.base_code}
                </span>
              ),
            },
            {
              key: 'base_name',
              header: 'Yarn Base Name',
              sortable: true,
              render: (r: any) => (
                <div>
                  <span className="font-medium text-slate-800">{r.base_name}</span>
                  {r.certification && r.certification !== 'NONE' && (
                    <span className="ml-2 inline-block rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.2 text-[10px] font-bold text-emerald-700">
                      {r.certification}
                    </span>
                  )}
                </div>
              ),
            },
            {
              key: 'composition_desc',
              header: 'Fibre Composition',
              render: (r: any) => (
                <span className="inline-flex items-center gap-1.5 font-medium text-slate-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  {r.composition_desc || '100% Cotton'}
                </span>
              ),
            },
            {
              key: 'yarn_type',
              header: 'Spinning Type',
              render: (r: any) => (
                <Badge tone="slate">{r.yarn_type || 'COMBED'}</Badge>
              ),
            },
            {
              key: 'variant_count',
              header: 'Count Variants',
              align: 'center',
              render: (r: any) => (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-bold text-brand-800 border border-brand-200">
                  {Number(r.variant_count) || 0} Count{(Number(r.variant_count) || 0) === 1 ? '' : 's'}
                </span>
              ),
            },
            {
              key: 'is_active',
              header: 'Status',
              render: (r: any) => (
                <Badge tone={r.is_active ? 'green' : 'slate'}>
                  {r.is_active ? 'Active' : 'Draft'}
                </Badge>
              ),
            },
          ]}
          rows={basesList.data?.data ?? []}
          loading={basesList.isLoading}
          error={basesList.error}
          onRetry={() => void basesList.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/masters/yarns/${r.id}`)}
          sort={sort}
          onSort={onSort}
          pagination={basesList.data?.pagination}
          onPage={setPage}
          emptyTitle="No Yarn Bases found"
          emptyMessage="Create a Base Yarn identity and auto-generate Count Variants in one click."
        />
      ) : (
        /* VIEW 2: ALL SKU VARIANTS TABLE */
        <DataTable
          columns={[
            {
              key: 'yarn_code',
              header: 'Item SKU Code',
              sortable: true,
              render: (r: any) => (
                <span className="font-mono text-[12px] font-semibold text-brand-700">
                  {r.yarn_code}
                </span>
              ),
            },
            {
              key: 'yarn_name',
              header: 'Yarn Item Name',
              sortable: true,
              render: (r: any) => (
                <div>
                  <span className="font-medium text-slate-800">{r.yarn_name}</span>
                  {r.base_name && (
                    <span className="block text-[11px] text-slate-400 font-normal">
                      Base: {r.base_name} ({r.base_code})
                    </span>
                  )}
                </div>
              ),
            },
            {
              key: 'count_value',
              header: 'Count / Spec',
              render: (r: any) => (
                <span className="font-mono font-semibold text-slate-800">
                  {r.count_value || '—'} {r.count_type || 'Ne'}
                  {Number(r.ply) > 1 ? `/${r.ply}` : ''} {r.twist ? `(${r.twist})` : ''}
                </span>
              ),
            },
            {
              key: 'composition_desc',
              header: 'Fibre Composition',
              render: (r: any) => (
                <span className="text-slate-700 text-xs">
                  {r.composition_desc || '100% Cotton'}
                </span>
              ),
            },
            {
              key: 'std_rate',
              header: 'Std Rate (₹/Kg)',
              align: 'right',
              render: (r: any) => (
                <span className="font-mono font-bold text-slate-900">
                  {r.std_rate ? `₹${fmtDecimal(r.std_rate, 2)}` : '—'}
                </span>
              ),
            },
            {
              key: 'is_active',
              header: 'Status',
              render: (r: any) => (
                <Badge tone={r.is_active ? 'green' : 'slate'}>
                  {r.is_active ? 'Active' : 'Draft'}
                </Badge>
              ),
            },
          ]}
          rows={variantsList.data?.data ?? []}
          loading={variantsList.isLoading}
          error={variantsList.error}
          onRetry={() => void variantsList.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => r.yarn_base_id ? nav(`/masters/yarns/${r.yarn_base_id}`) : nav(`/masters/yarns/new`)}
          sort={sort}
          onSort={onSort}
          pagination={variantsList.data?.pagination}
          onPage={setPage}
          emptyTitle="No Yarn SKUs found"
          emptyMessage="Yarn variants with unique Item Codes will appear here."
        />
      )}
    </>
  );
}

/* ==============================================================================
   2. YARN BASE MASTER + COUNT VARIANTS COCKPIT
   ============================================================================== */
export function YarnDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [saving, setSaving] = useState(false);

  // Lookups
  const categories = useLookup('material-categories');
  const uoms = useLookup('uoms');
  const yarnCounts = useLookup('yarn-counts');

  // Base Form State
  const [head, setHead] = useState<Record<string, any>>({
    base_code: '',
    base_name: '',
    category_id: '',
    yarn_type: 'COMBED',
    certification: 'GOTS',
    hsn_code: '5205',
    base_uom: '',
    description: '',
    is_active: 1,
    composition_id: '',
  });

  // Fibre Breakdown lines
  const [fibreLines, setFibreLines] = useState<FibreDetailLine[]>([
    { _key: `fl_${++seq}`, fibre_name: 'Cotton (Organic)', percentage: 100 },
  ]);

  // Count Variants State
  const [variants, setVariants] = useState<YarnVariantLine[]>([
    { _key: `var_${++seq}`, yarn_code: '', yarn_name: '', count_value: '30s', count_type: 'Ne', ply: 1, twist: 'Z', std_rate: 295, is_active: 1 },
    { _key: `var_${++seq}`, yarn_code: '', yarn_name: '', count_value: '40s', count_type: 'Ne', ply: 1, twist: 'Z', std_rate: 330, is_active: 1 },
  ]);

  // Load Existing Yarn Base
  const baseQuery = useQuery({
    queryKey: ['yarn-bases', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/yarn-bases/${id}`)).data,
    enabled: !isNew,
  });

  // Load Linked Variants for this Base
  const variantsQuery = useQuery({
    queryKey: ['yarns', 'by-base', id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/yarns?yarn_base_id=${id}&pageSize=100`)).data,
    enabled: !isNew,
  });

  // Load Existing Composition if linked
  const compQuery = useQuery({
    queryKey: ['compositions', 'item', head.composition_id],
    queryFn: async () => (await http.get<{ data: any }>(`/compositions/${head.composition_id}`)).data,
    enabled: !isNew && !!head.composition_id,
  });

  // Populate Base data
  useEffect(() => {
    if (baseQuery.data) {
      const b = baseQuery.data;
      setHead({
        base_code: b.base_code || '',
        base_name: b.base_name || '',
        category_id: b.category_id || '',
        yarn_type: b.yarn_type || 'COMBED',
        certification: b.certification || 'NONE',
        hsn_code: b.hsn_code || '5205',
        base_uom: b.base_uom || '',
        description: b.description || '',
        is_active: b.is_active ?? 1,
        composition_id: b.composition_id || '',
      });
    }
  }, [baseQuery.data]);

  // Populate Variants data
  useEffect(() => {
    if (variantsQuery.data && Array.isArray(variantsQuery.data) && variantsQuery.data.length > 0) {
      setVariants(
        variantsQuery.data.map((v: any) => ({
          _key: `var_${v.id}`,
          id: v.id,
          yarn_code: v.yarn_code || '',
          yarn_name: v.yarn_name || '',
          count_id: v.count_id || '',
          count_value: v.count_value || '30s',
          count_type: v.count_type || 'Ne',
          ply: Number(v.ply) || 1,
          twist: v.twist || 'Z',
          std_rate: v.std_rate ?? 0,
          is_active: v.is_active ?? 1,
        }))
      );
    }
  }, [variantsQuery.data]);

  // Populate Composition data
  useEffect(() => {
    if (compQuery.data?.details?.length) {
      setFibreLines(
        compQuery.data.details.map((d: any) => ({
          _key: `fl_${d.id}`,
          id: d.id,
          fibre_name: d.fibre_name,
          percentage: Number(d.percentage) || 0,
        }))
      );
    }
  }, [compQuery.data]);

  // Set default UOM if new
  useEffect(() => {
    if (isNew && !head.base_uom && uoms.data?.length) {
      const kgUom = uoms.data.find((u: any) => u.code === 'KG') || uoms.data[0];
      if (kgUom) setHead((s) => ({ ...s, base_uom: kgUom.id }));
    }
  }, [isNew, uoms.data, head.base_uom]);

  // Set default Category if new
  useEffect(() => {
    if (isNew && !head.category_id && categories.data?.length) {
      const yrnCat = categories.data.find((c: any) => (c.code || '').includes('YRN') || (c.label || '').toLowerCase().includes('yarn'));
      if (yrnCat) setHead((s) => ({ ...s, category_id: yrnCat.id }));
    }
  }, [isNew, categories.data, head.category_id]);

  // Auto-generate Composition text
  const autoGeneratedDesc = useMemo(() => {
    return fibreLines
      .filter((l) => Number(l.percentage) > 0)
      .map((l) => `${l.percentage}% ${l.fibre_name}`)
      .join(' / ');
  }, [fibreLines]);

  const totalPercentage = useMemo(() => {
    return fibreLines.reduce((acc, l) => acc + (Number(l.percentage) || 0), 0);
  }, [fibreLines]);

  const isValid100 = Math.abs(totalPercentage - 100) < 0.01;

  // Fibre Line Handlers
  const handleAddFibre = () => {
    const existing = fibreLines.map((l) => l.fibre_name);
    const nextPreset = FIBRE_PRESETS.find((p) => !existing.includes(p)) || 'Polyester (Virgin)';
    const remaining = Math.max(0, 100 - totalPercentage);
    setFibreLines((s) => [...s, { _key: `fl_${++seq}`, fibre_name: nextPreset, percentage: remaining }]);
  };

  const handleUpdateFibre = (key: string, field: keyof FibreDetailLine, val: any) => {
    setFibreLines((s) => s.map((l) => (l._key === key ? { ...l, [field]: val } : l)));
  };

  const handleRemoveFibre = (key: string) => {
    setFibreLines((s) => s.filter((l) => l._key !== key));
  };

  // Variant Handlers
  const handleAddPresetCount = (preset: typeof QUICK_COUNT_PRESETS[0]) => {
    const exists = variants.some((v) => v.count_value === preset.val && v.count_type === preset.type);
    if (exists) {
      toast(`Count ${preset.val} ${preset.type} is already added in variants.`, 'info');
      return;
    }
    const baseCode = head.base_code || 'YRN';
    const cleanVal = preset.val.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const autoCode = `${baseCode}-${cleanVal}`;
    const autoName = `${head.base_name ? `${head.base_name} ` : ''}${preset.val} ${preset.type}`.trim();

    setVariants((s) => [
      ...s,
      {
        _key: `var_${++seq}`,
        yarn_code: autoCode,
        yarn_name: autoName,
        count_value: preset.val,
        count_type: preset.type,
        ply: 1,
        twist: 'Z',
        std_rate: preset.rate,
        is_active: 1,
      },
    ]);
  };

  const handleAddEmptyVariant = () => {
    setVariants((s) => [
      ...s,
      {
        _key: `var_${++seq}`,
        yarn_code: '',
        yarn_name: '',
        count_value: '30s',
        count_type: 'Ne',
        ply: 1,
        twist: 'Z',
        std_rate: 0,
        is_active: 1,
      },
    ]);
  };

  const handleUpdateVariant = (key: string, field: keyof YarnVariantLine, val: any) => {
    setVariants((s) => s.map((v) => (v._key === key ? { ...v, [field]: val } : v)));
  };

  const handleDuplicateVariant = (key: string) => {
    const target = variants.find((v) => v._key === key);
    if (!target) return;
    setVariants((s) => [
      ...s,
      {
        ...target,
        _key: `var_${++seq}`,
        id: undefined,
        yarn_code: target.yarn_code ? `${target.yarn_code}-COPY` : '',
      },
    ]);
  };

  const handleRemoveVariant = (key: string) => {
    if (variants.length <= 1) {
      toast('At least one count variant is required for a Yarn Base', 'info');
      return;
    }
    setVariants((s) => s.filter((v) => v._key !== key));
  };

  const editable = can(isNew ? 'MATERIAL.CREATE' : 'MATERIAL.UPDATE');

  // Auto-fill codes if empty
  const handleAutoGenerateCodes = () => {
    const baseCode = (head.base_code || 'YB01').toUpperCase().replace(/[^A-Z0-9]/g, '');
    setVariants((s) =>
      s.map((v) => {
        const cVal = (v.count_value || 'CNT').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const plyStr = v.ply > 1 ? `_${v.ply}PLY` : '';
        const genCode = `YRN-${baseCode}-${cVal}${plyStr}`;
        const genName = `${head.base_name || 'Yarn'} ${v.count_value} ${v.count_type || 'Ne'}${v.ply > 1 ? ` / ${v.ply}` : ''}`.trim();
        return {
          ...v,
          yarn_code: v.yarn_code || genCode,
          yarn_name: v.yarn_name || genName,
        };
      })
    );
  };

  // SAVE BASE + VARIANTS
  const handleSave = async (mode: 'save' | 'draft' = 'save') => {
    if (!head.base_name) {
      toast('Yarn Base Name is required', 'error');
      return;
    }
    if (!isValid100) {
      toast(`Fibre composition must total 100% (currently ${totalPercentage.toFixed(1)}%)`, 'error');
      return;
    }
    if (variants.length === 0) {
      toast('Please add at least 1 Count Variant', 'error');
      return;
    }

    setSaving(true);
    try {
      // 1. Save Composition
      let compId = head.composition_id;
      const compCode = `COMP-${(head.base_code || head.base_name).substring(0, 10).toUpperCase()}`;
      const compPayload = {
        composition_code: compCode,
        description: autoGeneratedDesc || head.base_name,
        details: fibreLines.map((f) => ({
          fibre_name: f.fibre_name,
          percentage: Number(f.percentage) || 0,
        })),
      };

      if (!compId) {
        const compRes = await http.post<{ data: any }>('/compositions', compPayload);
        compId = compRes.data?.id;
      } else {
        await http.put(`/compositions/${compId}`, compPayload);
      }

      // 2. Save Yarn Base Master
      const baseCode = head.base_code || `YB-${Date.now().toString().slice(-5)}`;
      const basePayload = {
        base_code: baseCode,
        base_name: head.base_name,
        category_id: head.category_id || null,
        composition_id: compId || null,
        yarn_type: head.yarn_type || 'COMBED',
        certification: head.certification || 'NONE',
        hsn_code: head.hsn_code || '5205',
        base_uom: head.base_uom ? Number(head.base_uom) : (uoms.data?.[0]?.id ?? 1),
        description: head.description || null,
        is_active: mode === 'draft' ? 0 : (head.is_active ?? 1),
      };

      const baseRes = isNew
        ? await http.post<{ data: any }>('/yarn-bases', basePayload)
        : await http.put<{ data: any }>(`/yarn-bases/${id}`, basePayload);

      const savedBaseId = isNew ? baseRes.data?.id : id;

      // 3. Save / Sync Count Variants in mst_yarn
      for (const [idx, v] of variants.entries()) {
        const itemCode = v.yarn_code || `${baseCode}-${(v.count_value || 'CNT').toUpperCase().replace(/[^A-Z0-9]/g, '')}-${idx + 1}`;
        const itemName = v.yarn_name || `${head.base_name} ${v.count_value} ${v.count_type || 'Ne'}${v.ply > 1 ? ` / ${v.ply}` : ''}`.trim();

        const yarnItemPayload = {
          yarn_code: itemCode,
          yarn_name: itemName,
          category_id: head.category_id || null,
          yarn_base_id: savedBaseId,
          count_id: v.count_id || null,
          count_value: v.count_value || null,
          count_type: v.count_type || 'Ne',
          composition_id: compId || null,
          ply: Number(v.ply) || 1,
          twist: v.twist || 'Z',
          yarn_type: head.yarn_type || 'COMBED',
          hsn_code: head.hsn_code || '5205',
          base_uom: head.base_uom ? Number(head.base_uom) : (uoms.data?.[0]?.id ?? 1),
          std_rate: Number(v.std_rate) || 0,
          is_active: mode === 'draft' ? 0 : (v.is_active ?? 1),
        };

        if (v.id) {
          await http.put(`/yarns/${v.id}`, yarnItemPayload);
        } else {
          await http.post('/yarns', yarnItemPayload);
        }
      }

      toast(
        mode === 'draft'
          ? `Yarn Base saved as Draft with ${variants.length} variants`
          : `Yarn Base & ${variants.length} Count Variants synchronized successfully!`,
        'success'
      );

      void qc.invalidateQueries({ queryKey: ['yarn-bases'] });
      void qc.invalidateQueries({ queryKey: ['yarns'] });

      if (isNew && savedBaseId) {
        nav(`/masters/yarns/${savedBaseId}`, { replace: true });
      }
    } catch (e) {
      if (e instanceof ApiError) toast(e.message, 'error');
      else toast('Failed to save yarn base master & variants', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && baseQuery.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && baseQuery.error) return <div className="card"><ErrorState error={baseQuery.error} onRetry={() => void baseQuery.refetch()} /></div>;

  return (
    <>
      <PageHeader
        breadcrumb={['Masters', 'Yarns', isNew ? 'New Base Master' : head.base_name]}
        title={
          <div className="flex items-center gap-3">
            <span>{head.base_name || 'New Yarn Base Master'}</span>
            {head.certification && head.certification !== 'NONE' && (
              <span className="rounded-full bg-emerald-100 text-emerald-800 px-3 py-0.5 text-xs font-bold uppercase tracking-wider">
                {head.certification} Certified
              </span>
            )}
            {head.is_active === 0 && (
              <span className="rounded-full bg-amber-100 text-amber-800 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider">
                Draft
              </span>
            )}
          </div>
        }
        subtitle={
          head.base_code
            ? `Base Code: ${head.base_code}  |  Spinning: ${head.yarn_type}  |  Composition: ${autoGeneratedDesc || '100% Organic Cotton'}  |  Variants: ${variants.length} Counts`
            : 'Define Yarn Base identity, fibre composition, and generate count variants with unique item codes'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" onClick={() => nav('/masters/yarns')}>
              <ArrowLeft size={15} /> Back
            </button>
            {editable && (
              <button className="btn-secondary" onClick={() => void handleSave('draft')} disabled={saving}>
                {saving ? <Spinner size={14} /> : <FileText size={14} className="text-amber-600" />} Save as Draft
              </button>
            )}
            {editable && (
              <button className="btn-primary" onClick={() => void handleSave('save')} disabled={saving}>
                {saving ? <Spinner size={15} /> : <Save size={15} />}
                {isNew ? 'Create Yarn Base & Variants' : 'Save & Sync Variants'}
              </button>
            )}
          </div>
        }
      />

      {/* SECTION 1: YARN BASE SPECIFICATIONS */}
      <div className="card p-4 space-y-4 mb-4">
        <div className="flex items-center justify-between border-b border-surface-border pb-2.5">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-brand-600" />
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">
              1. Yarn Base Specifications (Parent Identity)
            </h3>
          </div>
          <span className="text-[11px] text-slate-400 font-medium">
            Single master entry for this yarn category &amp; fibre identity
          </span>
        </div>

        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
          <Input
            label="Yarn Base Code"
            placeholder="e.g. YB-00001 (Auto if blank)"
            value={head.base_code}
            onChange={(e) => setHead((s) => ({ ...s, base_code: e.target.value }))}
            disabled={!editable}
          />
          <div className="lg:col-span-2">
            <Input
              label="Yarn Base Name"
              required
              placeholder="e.g. 100% Organic Cotton Combed"
              value={head.base_name}
              onChange={(e) => setHead((s) => ({ ...s, base_name: e.target.value }))}
              disabled={!editable}
            />
          </div>
          <Select
            label="Material Category"
            options={toOptions(categories.data)}
            value={head.category_id}
            onChange={(e) => setHead((s) => ({ ...s, category_id: e.target.value }))}
            disabled={!editable}
          />

          <Select
            label="Spinning / Yarn Type"
            options={[
              { value: 'COMBED', label: 'Combed' },
              { value: 'CARDED', label: 'Carded' },
              { value: 'OE', label: 'Open End (OE)' },
              { value: 'COMPACT', label: 'Compact' },
              { value: 'MELANGE', label: 'Melange' },
              { value: 'SLUB', label: 'Slub' },
              { value: 'OTHER', label: 'Other' },
            ]}
            value={head.yarn_type}
            onChange={(e) => setHead((s) => ({ ...s, yarn_type: e.target.value }))}
            disabled={!editable}
          />

          <Select
            label="Certification"
            options={[
              { value: 'GOTS', label: 'GOTS (Global Organic Textile Standard)' },
              { value: 'OEKO-TEX', label: 'OEKO-TEX Standard 100' },
              { value: 'BCI', label: 'BCI (Better Cotton Initiative)' },
              { value: 'GRS', label: 'GRS (Global Recycled Standard)' },
              { value: 'OCS', label: 'OCS (Organic Content Standard)' },
              { value: 'NONE', label: 'None / Standard' },
            ]}
            value={head.certification}
            onChange={(e) => setHead((s) => ({ ...s, certification: e.target.value }))}
            disabled={!editable}
          />

          <Input
            label="HSN Code"
            value={head.hsn_code}
            onChange={(e) => setHead((s) => ({ ...s, hsn_code: e.target.value }))}
            disabled={!editable}
          />
          <Select
            label="Base UOM"
            options={toOptions(uoms.data)}
            value={head.base_uom}
            onChange={(e) => setHead((s) => ({ ...s, base_uom: e.target.value }))}
            disabled={!editable}
          />

          <Select
            label="Status"
            options={[
              { value: '1', label: 'Active' },
              { value: '0', label: 'Draft' },
            ]}
            value={String(head.is_active ?? 1)}
            onChange={(e) => setHead((s) => ({ ...s, is_active: Number(e.target.value) }))}
            disabled={!editable}
          />
          <div className="lg:col-span-3">
            <Input
              label="Description / Technical Notes"
              placeholder="e.g. Ring spun, high tensile strength, ideal for export-grade single jersey"
              value={head.description}
              onChange={(e) => setHead((s) => ({ ...s, description: e.target.value }))}
              disabled={!editable}
            />
          </div>
        </div>
      </div>

      {/* SECTION 2: FIBRE COMPOSITION & VISUALIZER */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start mb-4">
        {/* Left 7 Cols: Interactive Fibre Table */}
        <div className="lg:col-span-7 space-y-4">
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Layers size={15} className="text-brand-600" />
                <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">
                  2. Fibre Composition Breakdown
                </h3>
              </div>
              {editable && (
                <button type="button" onClick={handleAddFibre} className="btn-primary btn-sm text-xs py-1 px-2 flex items-center gap-1">
                  <Plus size={13} /> Add Fibre
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-surface-border bg-slate-100/60 text-[11px] font-bold uppercase text-slate-600">
                    <th className="py-2 px-2.5 w-8">#</th>
                    <th className="py-2 px-2 min-w-[200px]">Fibre Type</th>
                    <th className="py-2 px-2 w-28 text-right">Share (%)</th>
                    {editable && <th className="py-2 px-2 w-8 text-center" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fibreLines.map((f, idx) => (
                    <tr key={f._key} className="hover:bg-slate-50/70">
                      <td className="py-2 px-2.5 font-bold text-slate-400">
                        <span
                          className="inline-block w-2 h-2 rounded-full mr-1.5"
                          style={{ backgroundColor: FIBRE_COLOR_PALETTE[idx % FIBRE_COLOR_PALETTE.length] }}
                        />
                        {idx + 1}
                      </td>
                      <td className="py-1 px-1">
                        <select
                          value={f.fibre_name}
                          disabled={!editable}
                          onChange={(e) => handleUpdateFibre(f._key, 'fibre_name', e.target.value)}
                          className="input py-1 px-2 text-xs font-semibold text-slate-700 w-full"
                        >
                          {FIBRE_PRESETS.map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1 px-1 text-right">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={f.percentage}
                          disabled={!editable}
                          onChange={(e) => handleUpdateFibre(f._key, 'percentage', e.target.value === '' ? '' : Number(e.target.value))}
                          className="input py-1 px-2 text-right font-mono font-bold text-slate-900 text-xs w-full"
                        >
                        </input>
                      </td>
                      {editable && (
                        <td className="py-1 px-1 text-center">
                          <button
                            type="button"
                            onClick={() => handleRemoveFibre(f._key)}
                            disabled={fibreLines.length <= 1}
                            className="p-1 text-slate-400 hover:text-rose-600 rounded"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-xs">
                    <td colSpan={2} className="py-2.5 px-3 text-slate-800 uppercase tracking-wider">
                      Total Composition
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
                      const strokeOffset = (accumulatedPct / 100) * circumference;
                      accumulatedPct += pct;
                      return (
                        <circle
                          key={item._key}
                          cx="50"
                          cy="50"
                          r="38"
                          fill="transparent"
                          stroke={FIBRE_COLOR_PALETTE[idx % FIBRE_COLOR_PALETTE.length]}
                          strokeWidth="14"
                          strokeDasharray={`${strokeLength} ${circumference}`}
                          strokeDashoffset={-strokeOffset}
                          strokeLinecap="butt"
                        />
                      );
                    });
                  })()}
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-2xl font-black text-slate-800 font-mono">{totalPercentage.toFixed(0)}%</span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Total</span>
                </div>
              </div>

              {/* Legend List */}
              <div className="w-full mt-3 space-y-1">
                {fibreLines.map((f, idx) => (
                  <div key={f._key} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: FIBRE_COLOR_PALETTE[idx % FIBRE_COLOR_PALETTE.length] }}
                      />
                      <span className="font-semibold text-slate-700">{f.fibre_name}</span>
                    </div>
                    <span className="font-mono font-bold text-slate-900">{f.percentage}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 3: YARN COUNT VARIANTS & SKU GENERATOR */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border bg-slate-50/80 px-4 py-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" />
              <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">
                3. Yarn Variants / Count Generator (Child Items for Stock &amp; PO)
              </h3>
            </div>
            <p className="text-[11.5px] text-slate-500 mt-0.5">
              Each count variant automatically gets a unique Item Code for inventory, PO, GRN, Stock Ledger, and BOM consumption.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleAutoGenerateCodes}
              className="btn-secondary btn-sm text-xs py-1 px-2.5 flex items-center gap-1.5"
              title="Auto-fill item codes and names based on Base Code + Count"
            >
              <RefreshCw size={13} /> Auto-format Codes
            </button>
            {editable && (
              <button
                type="button"
                onClick={handleAddEmptyVariant}
                className="btn-primary btn-sm text-xs py-1 px-2.5 flex items-center gap-1.5"
              >
                <Plus size={13} /> Add Custom Count
              </button>
            )}
          </div>
        </div>

        {/* Quick Count Preset Chips */}
        <div className="border-b border-surface-border bg-white px-4 py-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-bold uppercase text-slate-400 mr-1 flex items-center gap-1">
            <Sparkles size={12} className="text-amber-500" /> Quick Add Counts:
          </span>
          {QUICK_COUNT_PRESETS.map((p) => {
            const added = variants.some((v) => v.count_value === p.val && v.count_type === p.type);
            return (
              <button
                key={`${p.val}-${p.type}`}
                type="button"
                disabled={!editable}
                onClick={() => handleAddPresetCount(p)}
                className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-semibold transition-all ${
                  added
                    ? 'border-brand-300 bg-brand-50 text-brand-800 font-bold'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-brand-400 hover:bg-slate-50'
                }`}
              >
                {added && <Check size={12} className="text-brand-600" />}
                <span>{p.val} {p.type}</span>
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
                <th className="py-2.5 px-2 min-w-[150px]">Unique Item Code</th>
                <th className="py-2.5 px-2 min-w-[200px]">Yarn Item Name</th>
                <th className="py-2.5 px-2 w-28">Count</th>
                <th className="py-2.5 px-2 w-24">System</th>
                <th className="py-2.5 px-2 w-16 text-center">Ply</th>
                <th className="py-2.5 px-2 w-16 text-center">Twist</th>
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
                      placeholder="e.g. YRN-30S-ORG"
                      value={v.yarn_code}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'yarn_code', e.target.value)}
                      className="input py-1 px-2 font-mono font-bold text-brand-700 text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      placeholder="e.g. Organic Cotton 30s Ne"
                      value={v.yarn_name}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'yarn_name', e.target.value)}
                      className="input py-1 px-2 font-medium text-slate-800 text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      list="yarn-count-options"
                      placeholder="30s, 40s"
                      value={v.count_value}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'count_value', e.target.value)}
                      className="input py-1 px-2 font-mono font-bold text-slate-900 text-xs w-full"
                    />
                    <datalist id="yarn-count-options">
                      {(yarnCounts.data ?? []).map((yc: any) => (
                        <option key={yc.id} value={yc.count_value}>
                          {yc.label || `${yc.count_value} ${yc.count_type}`}
                        </option>
                      ))}
                    </datalist>
                  </td>
                  <td className="py-1 px-1">
                    <select
                      value={v.count_type}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'count_type', e.target.value)}
                      className="input py-1 px-2 text-xs font-semibold text-slate-700 w-full"
                    >
                      <option value="Ne">Ne</option>
                      <option value="Nm">Nm</option>
                      <option value="Denier">Denier</option>
                      <option value="Tex">Tex</option>
                    </select>
                  </td>
                  <td className="py-1 px-1 text-center">
                    <input
                      type="number"
                      min="1"
                      value={v.ply}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'ply', Number(e.target.value) || 1)}
                      className="input py-1 px-1 text-center font-mono text-xs w-14"
                    />
                  </td>
                  <td className="py-1 px-1 text-center">
                    <select
                      value={v.twist}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'twist', e.target.value)}
                      className="input py-1 px-1 text-center font-mono text-xs w-14"
                    >
                      <option value="Z">Z</option>
                      <option value="S">S</option>
                    </select>
                  </td>
                  <td className="py-1 px-1 text-right">
                    <input
                      type="number"
                      step="0.01"
                      value={v.std_rate}
                      disabled={!editable}
                      onChange={(e) => handleUpdateVariant(v._key, 'std_rate', e.target.value === '' ? '' : Number(e.target.value))}
                      className="input py-1 px-2 text-right font-mono font-bold text-slate-900 text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1 text-center">
                    <button
                      type="button"
                      disabled={!editable}
                      onClick={() => handleUpdateVariant(v._key, 'is_active', v.is_active ? 0 : 1)}
                      className={`rounded px-2 py-0.5 text-[10.5px] font-bold ${
                        v.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
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
                          title="Duplicate variant"
                          className="p-1 text-slate-400 hover:text-brand-600 rounded"
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveVariant(v._key)}
                          disabled={variants.length <= 1}
                          title="Remove variant"
                          className="p-1 text-slate-400 hover:text-rose-600 rounded disabled:opacity-40"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50 font-bold text-xs text-slate-700">
                <td colSpan={7} className="py-2 px-3">
                  Total Active Count Variants: <span className="font-mono text-brand-700">{variants.filter((v) => v.is_active).length}</span>
                </td>
                <td className="py-2 px-2 text-right font-mono text-slate-500">
                  Avg: ₹{(variants.reduce((a, b) => a + (Number(b.std_rate) || 0), 0) / (variants.length || 1)).toFixed(2)}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </>
  );
}
