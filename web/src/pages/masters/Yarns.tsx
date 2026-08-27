import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, PieChart as PieIcon, Layers, FileText, Info,
  CheckCircle2, AlertCircle, Sparkles, Scale, Building2, Package
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
   1. YARNS LIST PAGE (DataTable with filters)
   ============================================================================== */
export function YarnsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'yarn_name', dir: 'asc' });
  const debounced = useDebounced(search);
  const [yarnType, setYarnType] = useState('');
  const [compositionId, setCompositionId] = useState('');

  const compositions = useLookup('compositions');

  const list = useList<any>('yarns', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    yarn_type: yarnType || undefined,
    composition_id: compositionId || undefined,
    sort: sort.key,
    dir: sort.dir,
  });

  return (
    <>
      <PageHeader
        breadcrumb={['Master Data', 'Yarns']}
        title="Yarn Master"
        subtitle="Yarn specifications, fibre composition breakdown, count and rates"
        actions={
          can('MATERIAL.CREATE') && (
            <button className="btn-primary" onClick={() => nav('/masters/yarns/new')}>
              <Plus size={15} /> New Yarn
            </button>
          )
        }
      />

      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search yarn code, name, count (e.g. 30s) or composition…"
          className="w-full max-w-md"
        />
        <div className="w-48">
          <Select
            placeholder="All Yarn Types"
            options={['COMBED', 'CARDED', 'OE', 'COMPACT', 'MELANGE', 'SLUB', 'OTHER'].map((v) => ({
              value: v,
              label: humanize(v),
            }))}
            value={yarnType}
            onChange={(e) => {
              setYarnType(e.target.value);
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
        {(yarnType || compositionId) && (
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setYarnType('');
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
            key: 'yarn_code',
            header: 'Yarn Code',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono text-[12.5px] font-bold text-brand-700">{r.yarn_code}</span>
            ),
          },
          {
            key: 'yarn_name',
            header: 'Yarn Name',
            sortable: true,
            render: (r: any) => <span className="font-semibold text-slate-800">{r.yarn_name}</span>,
          },
          {
            key: 'count_value',
            header: 'Count',
            render: (r: any) => (
              <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700">
                {r.count_value ? `${r.count_value} ${r.count_type || 'Ne'}` : '—'}
              </span>
            ),
          },
          {
            key: 'yarn_type',
            header: 'Type',
            render: (r: any) => <Badge tone="blue">{humanize(r.yarn_type || 'COMBED')}</Badge>,
          },
          {
            key: 'composition_desc',
            header: 'Fibre Composition',
            render: (r: any) => (
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-slate-700">{r.composition_desc || '100% Cotton'}</span>
              </div>
            ),
          },
          {
            key: 'uom_code',
            header: 'Base UOM',
            render: (r: any) => <span className="text-slate-500">{r.uom_code || 'KG'}</span>,
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
        onRowClick={(r) => nav(`/masters/yarns/${r.id}`)}
        sort={sort}
        onSort={onSort}
        pagination={list.data?.pagination}
        onPage={setPage}
        emptyTitle="No yarn records found"
        emptyMessage="Create yarn masters with fibre composition, count and rates."
      />
    </>
  );
}

/* ==============================================================================
   2. YARN & COMPOSITION DETAIL PAGE (Matching Screenshot UI)
   ============================================================================== */
export function YarnDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [tab, setTab] = useState<'general' | 'composition' | 'specification' | 'supplier' | 'stock'>('composition');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Lookups
  const categories = useLookup('material-categories');
  const uoms = useLookup('uoms');
  const suppliers = useLookup('suppliers');

  // Yarn General Form State
  const [head, setHead] = useState<Record<string, any>>({
    yarn_code: '',
    yarn_name: '',
    category_id: '',
    count_value: '30s',
    count_type: 'Ne',
    ply: 1,
    yarn_type: 'COMBED',
    hsn_code: '5205',
    base_uom: '',
    std_rate: 285,
    is_active: 1,
    preferred_supplier_id: '',
    min_order_qty: 500,
    lead_time_days: 14,
    packing_type: '24 Cones / Bag',
    twist_direction: 'Z',
    tpm: 820,
    csp: 2850,
    rkm: 18.5,
    hairiness_index: 4.8,
    evenness_u: 9.8,
  });

  // Composition State
  const [compHead, setCompHead] = useState({
    composition_code: '',
    composition_name: '60% Cotton / 35% Polyester / 5% Elastane',
    composition_type: 'Blend',
    status: 'Active',
    description: 'Cotton rich blend yarn for knitting single jersey and rib fabrics.',
    remarks: 'Premium quality blend with low pilling and high tensile strength.',
    total_recycled_pct: 20.0,
    recycled_by_weight: 20.0,
    recycled_by_fibre: 7.0,
    recycled_desc: 'Polyester is 20% recycled GRS certified post-consumer PET fibre.',
  });

  // Fibre Composition Line Items
  const [fibres, setFibres] = useState<FibreComponent[]>([
    { _key: 'fc_1', component_type: 'Main', fibre_type: 'Cotton', fibre_category: 'Natural', percentage: 60, recycled_pct: 0, certification: 'GOTS (Organic)', remarks: 'Combed Cotton' },
    { _key: 'fc_2', component_type: 'Main', fibre_type: 'Polyester', fibre_category: 'Synthetic', percentage: 35, recycled_pct: 20, certification: 'GRS (Global Recycled)', remarks: 'Recycled Polyester' },
    { _key: 'fc_3', component_type: 'Additive', fibre_type: 'Elastane / Spandex', fibre_category: 'Synthetic', percentage: 5, recycled_pct: 0, certification: '— None —', remarks: 'Spandex Filament' },
  ]);

  // Load Existing Yarn
  const yarnQuery = useQuery({
    queryKey: ['yarns', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/resources/yarns/${id}`)).data,
    enabled: !isNew,
  });

  // Load Existing Composition if linked
  const compQuery = useQuery({
    queryKey: ['compositions', 'item', head.composition_id],
    queryFn: async () => (await http.get<{ data: any }>(`/resources/compositions/${head.composition_id}`)).data,
    enabled: !isNew && !!head.composition_id,
  });

  useEffect(() => {
    if (!yarnQuery.data) return;
    const y = yarnQuery.data;
    setHead((prev: any) => ({ ...prev, ...y }));
    if (y.yarn_code && !compHead.composition_code) {
      setCompHead((c) => ({ ...c, composition_code: `CMP-${y.yarn_code}` }));
    }
  }, [yarnQuery.data]);

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
    setFibres((prev) => [...prev, newFibre('Viscose / Rayon', remaining > 0 ? remaining : 10)]);
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
    if (!head.yarn_code?.trim() || !head.yarn_name?.trim()) {
      toast('Please enter Yarn Code and Yarn Name', 'error');
      setTab('general');
      return;
    }

    setSaving(true);
    try {
      // 1. Create or Update Composition First
      const compPayload = {
        composition_code: compHead.composition_code || `CMP-${head.yarn_code || 'YRN'}`,
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
        await http.put(`/resources/compositions/${compId}`, compPayload).catch(() => {});
      } else {
        const compRes = await http.post<{ data: any }>('/resources/compositions', compPayload).catch(() => null);
        if (compRes?.data?.id) compId = compRes.data.id;
      }

      // 2. Save Yarn Record
      const yarnPayload = {
        yarn_code: head.yarn_code,
        yarn_name: head.yarn_name,
        category_id: head.category_id || null,
        count_value: head.count_value || null,
        count_type: head.count_type || 'Ne',
        composition_id: compId || null,
        ply: Number(head.ply) || 1,
        yarn_type: head.yarn_type || 'COMBED',
        hsn_code: head.hsn_code || '5205',
        base_uom: head.base_uom ? Number(head.base_uom) : (uoms.data?.[0]?.id ?? 1),
        std_rate: Number(head.std_rate) || 0,
        is_active: mode === 'draft' ? 0 : (head.is_active ?? 1),
      };

      const res = isNew
        ? await http.post<{ data: any }>('/resources/yarns', yarnPayload)
        : await http.put<{ data: any }>(`/resources/yarns/${id}`, yarnPayload);

      toast(mode === 'draft' ? 'Yarn saved as Draft — resume anytime' : `Yarn ${isNew ? 'created' : 'updated'} successfully`);
      void qc.invalidateQueries({ queryKey: ['yarns'] });
      void qc.invalidateQueries({ queryKey: ['compositions'] });
      void qc.invalidateQueries({ queryKey: ['lookup'] });

      if (mode === 'saveAndNew') {
        setHead({
          yarn_code: '',
          yarn_name: '',
          count_value: '30s',
          count_type: 'Ne',
          ply: 1,
          yarn_type: 'COMBED',
          std_rate: 280,
          is_active: 1,
        });
        nav('/masters/yarns/new');
      } else if (isNew && res.data?.id) {
        nav(`/masters/yarns/${res.data.id}`, { replace: true });
      }
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        toast(e.message, 'error');
      } else {
        toast('Failed to save yarn master', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && yarnQuery.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && yarnQuery.error) return <div className="card"><ErrorState error={yarnQuery.error} onRetry={() => void yarnQuery.refetch()} /></div>;

  const d = yarnQuery.data;

  return (
    <>
      <PageHeader
        breadcrumb={['Masters', 'Yarn Master', isNew ? 'New' : 'View / Edit']}
        title={
          <div className="flex items-center gap-3">
            <span>{isNew ? 'New Yarn Master' : d?.yarn_name || 'Yarn Master'}</span>
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
            ? 'Define yarn counts, fibre composition breakdown and specifications'
            : `Yarn Code : ${d?.yarn_code || '—'}  |  Yarn Name : ${d?.yarn_name || '—'}  |  Count : ${d?.count_value || '30s'} ${d?.count_type || 'Ne'}`
        }
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary" onClick={() => nav('/masters/yarns')}>
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
                {isNew ? 'Save Yarn' : head.is_active ? 'Save Changes' : 'Activate Yarn'}
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
            { key: 'specification', label: 'Specification' },
            { key: 'supplier', label: 'Supplier & Commercial' },
            { key: 'stock', label: 'Stock & UOM' },
          ]}
        />
      </div>

      {/* ──────────────────────────────────────────────────────────────────────────
          TAB 1: COMPOSITION (Hero feature from screenshot)
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
              <span className="text-xs text-slate-500">Define yarn fibre blend percentages</span>
            </div>

            <div className="p-4 space-y-3.5">
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-5">
                <Input
                  label="Composition Code"
                  placeholder="e.g. CMP-000089"
                  value={compHead.composition_code}
                  onChange={(e) => setCompHead((c) => ({ ...c, composition_code: e.target.value }))}
                  disabled={!editable}
                  hint="Auto-generated if blank"
                />
                <div className="lg:col-span-2">
                  <Input
                    label="Composition Name"
                    required
                    placeholder="e.g. 60% Cotton / 35% Polyester / 5% Elastane"
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
                  placeholder="e.g. Cotton rich blend yarn for knitting single jersey and rib fabrics."
                  value={compHead.description}
                  onChange={(e) => setCompHead((c) => ({ ...c, description: e.target.value }))}
                  disabled={!editable}
                />
                <Textarea
                  label="Remarks"
                  rows={2}
                  placeholder="e.g. Premium quality blend with low pilling and high tensile strength."
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
                              placeholder="e.g. Combed, Spandex"
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
                    You can add more fibre components using the "Add Component" button. Use Component Type as per yarn structure (Main, Core, Cover, Additive, etc.).
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
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Yarn Identity & Master Details</h3>
          </div>

          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <Input
              label="Yarn Code"
              required
              placeholder="e.g. Y30CC / YRN-000125"
              value={head.yarn_code}
              onChange={(e) => setHead((s: any) => ({ ...s, yarn_code: e.target.value }))}
              disabled={!editable}
              error={errors.yarn_code}
            />
            <div className="lg:col-span-2">
              <Input
                label="Yarn Name"
                required
                placeholder="e.g. 30s Combed Cotton Compact"
                value={head.yarn_name}
                onChange={(e) => setHead((s: any) => ({ ...s, yarn_name: e.target.value }))}
                disabled={!editable}
                error={errors.yarn_name}
              />
            </div>
            <Select
              label="Material Category"
              options={toOptions(categories.data)}
              placeholder="— Select Category —"
              value={head.category_id || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, category_id: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="Count Value"
              placeholder="e.g. 30s, 40s, 150D"
              value={head.count_value || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, count_value: e.target.value }))}
              disabled={!editable}
            />
            <Select
              label="Count System / Type"
              options={['Ne', 'Nm', 'Denier', 'Tex'].map((v) => ({ value: v, label: v }))}
              value={head.count_type || 'Ne'}
              onChange={(e) => setHead((s: any) => ({ ...s, count_type: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="Ply"
              type="number"
              min="1"
              max="12"
              value={head.ply || 1}
              onChange={(e) => setHead((s: any) => ({ ...s, ply: Number(e.target.value) || 1 }))}
              disabled={!editable}
            />
            <Select
              label="Yarn Spinning Type"
              options={['COMBED', 'CARDED', 'OE', 'COMPACT', 'MELANGE', 'SLUB', 'OTHER'].map((v) => ({
                value: v,
                label: humanize(v),
              }))}
              value={head.yarn_type || 'COMBED'}
              onChange={(e) => setHead((s: any) => ({ ...s, yarn_type: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="HSN / Tariff Code"
              placeholder="e.g. 5205"
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
              placeholder="285.00"
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
          TAB 3: SPECIFICATION
          ────────────────────────────────────────────────────────────────────────── */}
      {tab === 'specification' && (
        <div className="card p-4 space-y-4">
          <div className="flex items-center gap-2 border-b border-surface-border pb-2.5">
            <Scale size={15} className="text-brand-600" />
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Physical & Quality Specifications</h3>
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              label="Twist Direction"
              options={[{ value: 'Z', label: 'Z-Twist (Standard)' }, { value: 'S', label: 'S-Twist' }]}
              value={head.twist_direction || 'Z'}
              onChange={(e) => setHead((s: any) => ({ ...s, twist_direction: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="TPM (Twist Per Metre)"
              type="number"
              placeholder="e.g. 820"
              value={head.tpm || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, tpm: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="CSP (Count Strength Product)"
              type="number"
              placeholder="e.g. 2850"
              value={head.csp || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, csp: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="RKM (Single Yarn Tenacity)"
              type="number"
              step="0.1"
              placeholder="e.g. 18.5"
              value={head.rkm || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, rkm: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="Hairiness Index (H)"
              type="number"
              step="0.1"
              placeholder="e.g. 4.8"
              value={head.hairiness_index || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, hairiness_index: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="Evenness (U %)"
              type="number"
              step="0.1"
              placeholder="e.g. 9.8"
              value={head.evenness_u || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, evenness_u: Number(e.target.value) }))}
              disabled={!editable}
            />
          </div>
        </div>
      )}

      {/* ──────────────────────────────────────────────────────────────────────────
          TAB 4: SUPPLIER & COMMERCIAL
          ────────────────────────────────────────────────────────────────────────── */}
      {tab === 'supplier' && (
        <div className="card p-4 space-y-4">
          <div className="flex items-center gap-2 border-b border-surface-border pb-2.5">
            <Building2 size={15} className="text-brand-600" />
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Preferred Supplier & Commercials</h3>
          </div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              label="Preferred Spinner / Mill"
              options={toOptions(suppliers.data)}
              placeholder="— Select Supplier —"
              value={head.preferred_supplier_id || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, preferred_supplier_id: e.target.value }))}
              disabled={!editable}
            />
            <Input
              label="Minimum Order Qty (KG)"
              type="number"
              placeholder="500"
              value={head.min_order_qty || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, min_order_qty: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="Lead Time (Days)"
              type="number"
              placeholder="14"
              value={head.lead_time_days || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, lead_time_days: Number(e.target.value) }))}
              disabled={!editable}
            />
            <Input
              label="Standard Packing"
              placeholder="e.g. 24 Cones / Bag (45.36 KG)"
              value={head.packing_type || ''}
              onChange={(e) => setHead((s: any) => ({ ...s, packing_type: e.target.value }))}
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
            <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Inventory & Stock Status</h3>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Current Warehouse Stock</span>
              <p className="mt-1 text-2xl font-black text-slate-900 tabular-nums">4,250 <span className="text-xs font-semibold text-slate-400">KG</span></p>
              <span className="text-[11px] text-emerald-600 font-medium">94 Bags on hand</span>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4">
              <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700">Allocated / In-Knitting</span>
              <p className="mt-1 text-2xl font-black text-blue-900 tabular-nums">2,800 <span className="text-xs font-semibold text-blue-500">KG</span></p>
              <span className="text-[11px] text-blue-600 font-medium">Assigned to Work Orders</span>
            </div>
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Free Available Stock</span>
              <p className="mt-1 text-2xl font-black text-emerald-900 tabular-nums">1,450 <span className="text-xs font-semibold text-emerald-500">KG</span></p>
              <span className="text-[11px] text-emerald-700 font-medium">Available for new orders</span>
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
