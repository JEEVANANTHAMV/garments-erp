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

let fibreLineSeq = 0;

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

/* ==============================================================================
   1. FABRIC LIST VIEW
   ============================================================================== */
export function FabricsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({
    key: 'fabric_code',
    dir: 'asc',
  });
  const debounced = useDebounced(search);
  const [catFilter, setCatFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const categories = useLookup('material-categories');

  const list = useList<any>('fabrics', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    category_id: catFilter || undefined,
    fabric_type: typeFilter || undefined,
  });

  return (
    <>
      <PageHeader
        title="Fabrics"
        subtitle="Knitted & woven fabric masters with GSM and fibre composition"
        actions={
          can('MATERIAL.CREATE') && (
            <button className="btn-primary" onClick={() => nav('/masters/fabrics/new')}>
              <Plus size={15} /> New Fabric
            </button>
          )
        }
      />

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search fabric code, name, construction or composition…"
          />
        </div>
        <Select
          placeholder="All Categories"
          options={toOptions(categories.data)}
          value={catFilter}
          onChange={(e) => {
            setCatFilter(e.target.value);
            setPage(1);
          }}
        />
        <Select
          placeholder="All Types"
          options={[
            { value: 'KNIT', label: 'Knit' },
            { value: 'WOVEN', label: 'Woven' },
            { value: 'NONWOVEN', label: 'Non-Woven' },
          ]}
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <DataTable
        columns={[
          {
            key: 'fabric_code',
            header: 'Fabric Code',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono text-[12px] font-semibold text-brand-700">
                {r.fabric_code}
              </span>
            ),
          },
          {
            key: 'fabric_name',
            header: 'Fabric Name',
            sortable: true,
            render: (r: any) => (
              <span className="font-medium text-slate-800">{r.fabric_name}</span>
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
            key: 'knit_structure',
            header: 'Structure / Weave',
            render: (r: any) => (
              <span className="text-slate-600">{r.knit_structure || '—'}</span>
            ),
          },
          {
            key: 'gsm_value',
            header: 'GSM',
            align: 'right',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono font-medium text-slate-700">
                {r.gsm_value ? `${r.gsm_value} GSM` : '—'}
              </span>
            ),
          },
          {
            key: 'fabric_type',
            header: 'Type',
            render: (r: any) => (
              <Badge tone={r.fabric_type === 'KNIT' ? 'blue' : 'amber'}>
                {r.fabric_type || 'KNIT'}
              </Badge>
            ),
          },
          {
            key: 'std_rate',
            header: 'Std Rate (₹/Kg)',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono text-slate-700">
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
        emptyTitle="No fabrics found"
        emptyMessage="Define fabrics with knit/woven structure and composition breakdown."
      />
    </>
  );
}

/* ==============================================================================
   2. FABRIC DETAIL COCKPIT (Clean Required Fields)
   ============================================================================== */
export function FabricDetailPage() {
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
  const yarns = useLookup('yarns');
  const gsms = useLookup('gsm');

  // Fabric General Form State (Clean Initial State)
  const [head, setHead] = useState<Record<string, any>>({
    fabric_code: '',
    fabric_name: '',
    category_id: '',
    fabric_type: 'KNIT',
    knit_structure: 'Single Jersey',
    composition_id: '',
    gsm_id: '',
    width_cm: '',
    dia_inch: '',
    yarn_id: '',
    finish_type: 'Bio-wash + Silicon',
    hsn_code: '6006',
    base_uom: '',
    std_rate: '',
    is_active: 1,
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
    setHead((prev) => ({
      ...prev,
      ...f,
      category_id: f.category_id ? String(f.category_id) : '',
      gsm_id: f.gsm_id ? String(f.gsm_id) : '',
      yarn_id: f.yarn_id ? String(f.yarn_id) : '',
      base_uom: f.base_uom ? String(f.base_uom) : '',
    }));
  }, [fabricQuery.data]);

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
        fibre_name: 'Elastane / Spandex (Lycra)',
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
    if (!head.fabric_name.trim()) {
      toast('Fabric Name is required', 'error');
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
        composition_code: compHead.composition_code || `CMP-${head.fabric_code || Date.now()}`,
        description: compHead.description || autoGeneratedDesc || head.fabric_name,
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

      toast(mode === 'draft' ? 'Fabric saved as Draft' : `Fabric ${isNew ? 'created' : 'updated'} successfully`);
      void qc.invalidateQueries({ queryKey: ['fabrics'] });

      if (isNew && res.data?.id) {
        nav(`/masters/fabrics/${res.data.id}`, { replace: true });
      }
    } catch (e) {
      if (e instanceof ApiError) toast(e.message, 'error');
      else toast('Failed to save fabric master', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && fabricQuery.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && fabricQuery.error) return <div className="card"><ErrorState error={fabricQuery.error} onRetry={() => void fabricQuery.refetch()} /></div>;

  return (
    <>
      <PageHeader
        breadcrumb={['Masters', 'Fabrics', isNew ? 'New' : head.fabric_name]}
        title={
          <div className="flex items-center gap-3">
            <span>{head.fabric_name || 'New Fabric Master'}</span>
            {head.is_active === 0 && (
              <span className="rounded-full bg-amber-100 text-amber-800 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider">
                Draft
              </span>
            )}
          </div>
        }
        subtitle={head.fabric_code ? `Code: ${head.fabric_code}  |  Type: ${head.fabric_type} (${head.knit_structure || ''})  |  Composition: ${autoGeneratedDesc || '100% Cotton'}` : 'Define fabric structure, GSM and fibre breakdown'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" onClick={() => nav('/masters/fabrics')}>
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
                {isNew ? 'Create Fabric' : 'Save & Activate'}
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
            label="Fabric Code"
            required
            placeholder="e.g. FAB-SJ-160"
            value={head.fabric_code}
            onChange={(e) => setHead((s) => ({ ...s, fabric_code: e.target.value }))}
            disabled={!editable}
          />
          <div className="lg:col-span-2">
            <Input
              label="Fabric Name"
              required
              placeholder="e.g. Single Jersey 160 GSM Combed"
              value={head.fabric_name}
              onChange={(e) => setHead((s) => ({ ...s, fabric_name: e.target.value }))}
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

          <Select
            label="Fabric Type"
            options={[
              { value: 'KNIT', label: 'Knit' },
              { value: 'WOVEN', label: 'Woven' },
              { value: 'NONWOVEN', label: 'Non-Woven' },
            ]}
            value={head.fabric_type}
            onChange={(e) => setHead((s) => ({ ...s, fabric_type: e.target.value }))}
            disabled={!editable}
          />
          <Select
            label="Structure / Construction"
            options={[
              { value: 'Single Jersey', label: 'Single Jersey' },
              { value: '1x1 Rib', label: '1x1 Rib' },
              { value: '2x2 Rib', label: '2x2 Rib' },
              { value: 'Interlock', label: 'Interlock' },
              { value: 'Pique', label: 'Pique (Polo)' },
              { value: 'French Terry', label: 'French Terry' },
              { value: 'Fleece (3 Thread)', label: 'Fleece (3 Thread)' },
              { value: 'Waffle / Thermal', label: 'Waffle / Thermal' },
              { value: 'Twill', label: 'Twill (Woven)' },
              { value: 'Poplin', label: 'Poplin (Woven)' },
              { value: 'Canvas', label: 'Canvas (Woven)' },
            ]}
            value={head.knit_structure}
            onChange={(e) => setHead((s) => ({ ...s, knit_structure: e.target.value }))}
            disabled={!editable}
          />
          <Select
            label="Standard GSM"
            options={toOptions(gsms.data)}
            value={head.gsm_id}
            onChange={(e) => setHead((s) => ({ ...s, gsm_id: e.target.value }))}
            disabled={!editable}
          />
          <Select
            label="Primary Yarn Feed"
            options={toOptions(yarns.data)}
            value={head.yarn_id}
            onChange={(e) => setHead((s) => ({ ...s, yarn_id: e.target.value }))}
            disabled={!editable}
          />

          <Input
            label="Width (cm)"
            type="number"
            value={head.width_cm}
            onChange={(e) => setHead((s) => ({ ...s, width_cm: e.target.value }))}
            disabled={!editable}
          />
          <Input
            label="Diameter (Inch)"
            type="number"
            value={head.dia_inch}
            onChange={(e) => setHead((s) => ({ ...s, dia_inch: e.target.value }))}
            disabled={!editable}
          />
          <Input
            label="Finish Type"
            value={head.finish_type}
            onChange={(e) => setHead((s) => ({ ...s, finish_type: e.target.value }))}
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
