import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, PieChart as PieIcon, Layers, FileText, CheckCircle2
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

/* ------------------------------------------------------ Fibre Detail Line */
export interface FibreDetailLine {
  _key: string;
  id?: number;
  fibre_name: string;
  percentage: number | '';
}

const FIBRE_COLOR_PALETTE = [
  '#0284c7', // Sky blue
  '#10b981', // Emerald green
  '#f59e0b', // Amber
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#14b8a6', // Teal
  '#f97316', // Orange
  '#64748b', // Slate
];

const FIBRE_PRESETS = [
  'Cotton (Organic)',
  'Cotton (Conventional)',
  'Polyester',
  'Viscose / Rayon',
  'Elastane / Spandex (Lycra)',
  'Modal',
  'Linen',
  'Bamboo',
  'Nylon',
  'Wool',
  'Acrylic',
  'Silk',
];

let fibreLineSeq = 0;

/* ==============================================================================
   1. YARNS LIST PAGE (DataTable & Filters)
   ============================================================================== */
export function YarnsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'yarn_name', dir: 'asc' });
  const debounced = useDebounced(search);
  const [yarnType, setYarnType] = useState('');

  const list = useList<any>('yarns', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    yarn_type: yarnType || undefined,
    sort: sort.key,
    dir: sort.dir,
  });

  return (
    <>
      <PageHeader
        breadcrumb={['Masters', 'Yarn Master']}
        title="Yarn Master"
        subtitle="Manage spinning counts, fibre composition, yarn types, rates, and technical parameters"
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
          placeholder="Search yarn code, name, count…"
          className="w-full max-w-md"
        />
        <div className="w-52">
          <Select
            placeholder="All Yarn Types"
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
        {yarnType && (
          <button className="btn-ghost btn-sm" onClick={() => { setYarnType(''); setPage(1); }}>
            Clear filter
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
            header: 'Yarn Name & Count',
            sortable: true,
            render: (r: any) => (
              <div>
                <p className="font-bold text-slate-900">{r.yarn_name}</p>
                <p className="text-[11px] text-slate-500 font-mono">
                  {r.count_value ? `${r.count_value} ${r.count_type || 'Ne'}` : ''} {r.ply > 1 ? `/${r.ply}` : ''}
                </p>
              </div>
            ),
          },
          {
            key: 'yarn_type',
            header: 'Spinning Type',
            render: (r: any) => (
              <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-bold text-slate-700">
                {r.yarn_type || 'COMBED'}
              </span>
            ),
          },
          {
            key: 'composition_desc',
            header: 'Composition',
            render: (r: any) => (
              <span className="font-medium text-slate-700 text-xs">
                {r.composition_desc || '—'}
              </span>
            ),
          },
          {
            key: 'std_rate',
            header: 'Standard Rate',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-bold text-slate-900">
                ₹ {fmtDecimal(r.std_rate || 0, 2)} <span className="text-[10.5px] text-slate-500 font-normal">/{r.uom_code || 'Kg'}</span>
              </span>
            ),
          },
          {
            key: 'is_active',
            header: 'Status',
            align: 'center',
            render: (r: any) => (
              r.is_active === 1 || r.is_active === true ? (
                <Badge tone="success">Active</Badge>
              ) : (
                <Badge tone="neutral">Draft</Badge>
              )
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
        emptyTitle="No yarns found"
        emptyMessage="Define yarns with counts and composition breakdown."
      />
    </>
  );
}

/* ==============================================================================
   2. YARN DETAIL COCKPIT (Clean Required Fields)
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

  // Yarn General Form State (Clean Initial State)
  const [head, setHead] = useState<Record<string, any>>({
    yarn_code: '',
    yarn_name: '',
    category_id: '',
    count_value: '',
    count_type: 'Ne',
    ply: 1,
    yarn_type: 'COMBED',
    hsn_code: '5205',
    base_uom: '',
    std_rate: '',
    is_active: 1,
    composition_id: '',
  });

  // Composition State
  const [compHead, setCompHead] = useState({
    composition_code: '',
    description: '',
  });

  // Fibre Breakdown lines
  const [fibreLines, setFibreLines] = useState<FibreDetailLine[]>([
    { _key: `fl_${++fibreLineSeq}`, fibre_name: 'Cotton (Organic)', percentage: 100 },
  ]);

  // Load Existing Yarn
  const yarnQuery = useQuery({
    queryKey: ['yarns', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/yarns/${id}`)).data,
    enabled: !isNew,
  });

  // Load Existing Composition if linked
  const compQuery = useQuery({
    queryKey: ['compositions', 'item', head.composition_id],
    queryFn: async () => (await http.get<{ data: any }>(`/compositions/${head.composition_id}`)).data,
    enabled: !isNew && !!head.composition_id,
  });

  useEffect(() => {
    if (!yarnQuery.data) return;
    const y = yarnQuery.data;
    setHead((prev) => ({
      ...prev,
      ...y,
      category_id: y.category_id ? String(y.category_id) : '',
      base_uom: y.base_uom ? String(y.base_uom) : '',
    }));
  }, [yarnQuery.data]);

  useEffect(() => {
    if (!compQuery.data) return;
    const c = compQuery.data;
    setCompHead({
      composition_code: c.composition_code || '',
      description: c.description || '',
    });
    if (Array.isArray(c.details) && c.details.length > 0) {
      setFibreLines(
        c.details.map((d: any) => ({
          _key: `fl_${++fibreLineSeq}`,
          id: d.id,
          fibre_name: d.fibre_name,
          percentage: Number(d.percentage) || 0,
        }))
      );
    }
  }, [compQuery.data]);

  // Total percentage calculation
  const totalPercentage = useMemo(() => {
    return fibreLines.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0);
  }, [fibreLines]);

  const isValid100 = Math.abs(totalPercentage - 100) < 0.01;

  // Auto-generate composition description
  const autoGeneratedDesc = useMemo(() => {
    const valid = fibreLines.filter((f) => (Number(f.percentage) || 0) > 0 && f.fibre_name.trim());
    if (valid.length === 0) return '';
    return valid.map((f) => `${f.percentage}% ${f.fibre_name}`).join(' / ');
  }, [fibreLines]);

  // Interactive Fibre Operations
  const handleAddFibre = () => {
    const remaining = Math.max(0, 100 - totalPercentage);
    setFibreLines((prev) => [
      ...prev,
      {
        _key: `fl_${++fibreLineSeq}`,
        fibre_name: 'Polyester',
        percentage: remaining > 0 ? remaining : 0,
      },
    ]);
  };

  const handleRemoveFibre = (key: string) => {
    setFibreLines((prev) => prev.filter((item) => item._key !== key));
  };

  const handleUpdateFibre = (key: string, field: keyof FibreDetailLine, value: any) => {
    setFibreLines((prev) =>
      prev.map((item) => (item._key === key ? { ...item, [field]: value } : item))
    );
  };

  const editable = isNew ? can('MATERIAL.CREATE') : can('MATERIAL.UPDATE');

  // Save Handler
  const handleSave = async (mode: 'save' | 'draft' = 'save') => {
    if (!head.yarn_name.trim()) {
      toast('Yarn Name is required', 'error');
      return;
    }
    if (!isValid100 && mode !== 'draft') {
      toast(`Fibre composition must total exactly 100% (currently ${totalPercentage}%)`, 'error');
      return;
    }

    setSaving(true);
    try {
      // 1. Save or Create Composition
      const compPayload = {
        composition_code: compHead.composition_code || `CMP-${head.yarn_code || Date.now()}`,
        description: compHead.description || autoGeneratedDesc || head.yarn_name,
        is_active: mode === 'draft' ? 0 : 1,
        details: fibreLines.map((l) => ({
          fibre_name: l.fibre_name,
          percentage: Number(l.percentage) || 0,
        })),
      };

      let compId = head.composition_id;
      if (compId) {
        await http.put(`/compositions/${compId}`, compPayload).catch(() => {});
      } else {
        const compRes = await http.post<{ data: any }>('/compositions', compPayload).catch(() => null);
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
        ? await http.post<{ data: any }>('/yarns', yarnPayload)
        : await http.put<{ data: any }>(`/yarns/${id}`, yarnPayload);

      toast(mode === 'draft' ? 'Yarn saved as Draft' : `Yarn ${isNew ? 'created' : 'updated'} successfully`);
      void qc.invalidateQueries({ queryKey: ['yarns'] });

      if (isNew && res.data?.id) {
        nav(`/masters/yarns/${res.data.id}`, { replace: true });
      }
    } catch (e) {
      if (e instanceof ApiError) toast(e.message, 'error');
      else toast('Failed to save yarn master', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && yarnQuery.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && yarnQuery.error) return <div className="card"><ErrorState error={yarnQuery.error} onRetry={() => void yarnQuery.refetch()} /></div>;

  return (
    <>
      <PageHeader
        breadcrumb={['Masters', 'Yarns', isNew ? 'New' : head.yarn_name]}
        title={
          <div className="flex items-center gap-3">
            <span>{head.yarn_name || 'New Yarn Master'}</span>
            {head.is_active === 0 && (
              <span className="rounded-full bg-amber-100 text-amber-800 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider">
                Draft
              </span>
            )}
          </div>
        }
        subtitle={head.yarn_code ? `Code: ${head.yarn_code}  |  Count: ${head.count_value || ''} ${head.count_type || 'Ne'}  |  Composition: ${autoGeneratedDesc || '100% Cotton'}` : 'Define yarn counts and fibre breakdown'}
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
                {isNew ? 'Create Yarn' : 'Save & Activate'}
              </button>
            )}
          </div>
        }
      />

      {/* Section 1: General Specifications */}
      <div className="card p-4 space-y-4 mb-4">
        <div className="flex items-center gap-2 border-b border-surface-border pb-2.5">
          <span className="h-2 w-2 rounded-full bg-brand-500" />
          <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-700">
            General Specifications
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
          <Input
            label="Yarn Code"
            required
            placeholder="e.g. YRN-30S-COMB"
            value={head.yarn_code}
            onChange={(e) => setHead((s) => ({ ...s, yarn_code: e.target.value }))}
            disabled={!editable}
          />
          <div className="lg:col-span-2">
            <Input
              label="Yarn Name"
              required
              placeholder="e.g. 30s Combed Cotton Yarn"
              value={head.yarn_name}
              onChange={(e) => setHead((s) => ({ ...s, yarn_name: e.target.value }))}
              disabled={!editable}
            />
          </div>
          <Select
            label="Category"
            options={toOptions(categories.data)}
            value={head.category_id}
            onChange={(e) => setHead((s) => ({ ...s, category_id: e.target.value }))}
            disabled={!editable}
          />

          <Input
            label="Count Value"
            placeholder="e.g. 30s, 40s, 2/40s"
            value={head.count_value}
            onChange={(e) => setHead((s) => ({ ...s, count_value: e.target.value }))}
            disabled={!editable}
          />
          <Select
            label="Count Type"
            options={[
              { value: 'Ne', label: 'Ne (English Cotton Count)' },
              { value: 'Nm', label: 'Nm (Metric Count)' },
              { value: 'Denier', label: 'Denier (Filament / Synthetic)' },
              { value: 'Tex', label: 'Tex (Direct System)' },
            ]}
            value={head.count_type}
            onChange={(e) => setHead((s) => ({ ...s, count_type: e.target.value }))}
            disabled={!editable}
          />
          <Input
            label="Ply"
            type="number"
            min="1"
            value={head.ply}
            onChange={(e) => setHead((s) => ({ ...s, ply: Number(e.target.value) || 1 }))}
            disabled={!editable}
          />
          <Select
            label="Yarn Type"
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
          <Input
            label="Standard Rate (₹/Kg)"
            type="number"
            step="0.01"
            value={head.std_rate}
            onChange={(e) => setHead((s) => ({ ...s, std_rate: e.target.value }))}
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
        </div>
      </div>

      {/* Section 2: Fibre Composition & Donut Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Left 7 Cols: Interactive Fibre Table */}
          <div className="lg:col-span-7 space-y-4">
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Layers size={15} className="text-brand-600" />
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">
                    Fibre Composition Breakdown
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
                          />
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
                <div className="relative w-44 h-44">
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
                <div className="w-full mt-4 space-y-1.5">
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
    </>
  );
}
