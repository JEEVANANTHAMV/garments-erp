import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, ArrowUp, ArrowDown, Sparkles, Tag,
  Layers, Users, Check, Copy, Ruler, CheckCircle2
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

/* ────────────────────────────────────────────────────────────────────────── */
/* Types & Presets                                                            */
/* ────────────────────────────────────────────────────────────────────────── */
export interface OrderedSizeItem {
  _key: string;
  id?: number;
  size_code: string;
  size_label: string;
  body_measurement?: string;
  barcode_suffix?: string;
  sort_order: number;
  is_active: number;
}

let sizeSeq = 0;

export const SIZE_GROUP_PRESETS = [
  {
    name: 'Adult Alpha (XS - 3XL)',
    category: 'ADULT',
    gender: 'UNISEX',
    description: 'Standard T-Shirt & Polo Chest Scale',
    sizes: [
      { code: 'XS', label: 'Extra Small', body: '36" Chest' },
      { code: 'S', label: 'Small', body: '38" Chest' },
      { code: 'M', label: 'Medium', body: '40" Chest' },
      { code: 'L', label: 'Large', body: '42" Chest' },
      { code: 'XL', label: 'X-Large', body: '44" Chest' },
      { code: '2XL', label: '2X-Large', body: '46" Chest' },
      { code: '3XL', label: '3X-Large', body: '48" Chest' },
    ],
  },
  {
    name: 'Adult Standard (S - XXL)',
    category: 'ADULT',
    gender: 'UNISEX',
    description: 'Regular Adult Scale',
    sizes: [
      { code: 'S', label: 'Small', body: '38" Chest' },
      { code: 'M', label: 'Medium', body: '40" Chest' },
      { code: 'L', label: 'Large', body: '42" Chest' },
      { code: 'XL', label: 'X-Large', body: '44" Chest' },
      { code: 'XXL', label: 'XX-Large', body: '46" Chest' },
    ],
  },
  {
    name: 'Kids Age Scale (2Y - 14Y)',
    category: 'KIDS',
    gender: 'UNISEX',
    description: 'Boys & Girls Casual Age Scale',
    sizes: [
      { code: '2-3Y', label: '2 to 3 Years', body: '92-98 cm' },
      { code: '4-5Y', label: '4 to 5 Years', body: '104-110 cm' },
      { code: '6-7Y', label: '6 to 7 Years', body: '116-122 cm' },
      { code: '8-9Y', label: '8 to 9 Years', body: '128-134 cm' },
      { code: '10-11Y', label: '10 to 11 Years', body: '140-146 cm' },
      { code: '12-13Y', label: '12 to 13 Years', body: '152-158 cm' },
      { code: '14Y+', label: '14 Years & Above', body: '164 cm' },
    ],
  },
  {
    name: 'Baby / Months (0M - 24M)',
    category: 'INFANT',
    gender: 'BABY',
    description: 'Rompers, Bodysuits & Infant Wear',
    sizes: [
      { code: '0-3M', label: '0 to 3 Months', body: '56-62 cm' },
      { code: '3-6M', label: '3 to 6 Months', body: '62-68 cm' },
      { code: '6-9M', label: '6 to 9 Months', body: '68-74 cm' },
      { code: '9-12M', label: '9 to 12 Months', body: '74-80 cm' },
      { code: '12-18M', label: '12 to 18 Months', body: '80-86 cm' },
      { code: '18-24M', label: '18 to 24 Months', body: '86-92 cm' },
      { code: '2T', label: 'Toddler 2', body: '92 cm' },
      { code: '3T', label: 'Toddler 3', body: '98 cm' },
    ],
  },
  {
    name: 'European Kids Height (92 - 164 cm)',
    category: 'KIDS',
    gender: 'UNISEX',
    description: 'EU Export Centimeter Height Scale',
    sizes: [
      { code: '92', label: '92 cm Height', body: '2 Years' },
      { code: '98', label: '98 cm Height', body: '3 Years' },
      { code: '104', label: '104 cm Height', body: '4 Years' },
      { code: '110', label: '110 cm Height', body: '5 Years' },
      { code: '116', label: '116 cm Height', body: '6 Years' },
      { code: '122', label: '122 cm Height', body: '7 Years' },
      { code: '128', label: '128 cm Height', body: '8 Years' },
      { code: '140', label: '140 cm Height', body: '10 Years' },
      { code: '152', label: '152 cm Height', body: '12 Years' },
      { code: '164', label: '164 cm Height', body: '14 Years' },
    ],
  },
  {
    name: 'Bottoms / Numeric Waist (28" - 42")',
    category: 'BOTTOMS',
    gender: 'MEN',
    description: 'Trousers, Jeans & Shorts Waist Scale',
    sizes: [
      { code: '28', label: '28" Waist', body: '71 cm' },
      { code: '30', label: '30" Waist', body: '76 cm' },
      { code: '32', label: '32" Waist', body: '81 cm' },
      { code: '34', label: '34" Waist', body: '86 cm' },
      { code: '36', label: '36" Waist', body: '91 cm' },
      { code: '38', label: '38" Waist', body: '96 cm' },
      { code: '40', label: '40" Waist', body: '101 cm' },
      { code: '42', label: '42" Waist', body: '106 cm' },
    ],
  },
  {
    name: 'Plus Size (1X - 5X)',
    category: 'PLUS_SIZE',
    gender: 'UNISEX',
    description: 'Big & Tall Plus Size Scale',
    sizes: [
      { code: '1X', label: '1X Plus', body: '50" Chest' },
      { code: '2X', label: '2X Plus', body: '54" Chest' },
      { code: '3X', label: '3X Plus', body: '58" Chest' },
      { code: '4X', label: '4X Plus', body: '62" Chest' },
      { code: '5X', label: '5X Plus', body: '66" Chest' },
    ],
  },
  {
    name: 'Free Size / One Size',
    category: 'ACCESSORIES',
    gender: 'UNISEX',
    description: 'Caps, Aprons, Towels & Accessories',
    sizes: [
      { code: 'FREE SIZE', label: 'One Size Fits All', body: 'Universal' },
    ],
  },
];

/* ==============================================================================
   1. SIZE GROUPS LIST VIEW
   ============================================================================== */
export function SizeGroupsPage() {
  const nav = useNavigate();
  const { can } = useAuth();

  const { page, setPage, search, setSearch, sort, onSort } = useListState({
    key: 'group_name',
    dir: 'asc',
  });
  const debounced = useDebounced(search);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [genderFilter, setGenderFilter] = useState('');

  const list = useList<any>('size-groups', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    category: categoryFilter || undefined,
    gender: genderFilter || undefined,
  });

  return (
    <>
      <PageHeader
        title="Size Group Masters"
        subtitle="Ordered Size Scales &amp; Groups for Styles, Cutting Lay Ratios, and Order Breakdowns"
        actions={
          can('SIZE.CREATE') && (
            <button className="btn-primary" onClick={() => nav('/masters/size-groups/new')}>
              <Plus size={15} /> New Size Group
            </button>
          )
        }
      />

      {/* Toolbar Filters */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search group code, name, sizes…"
            />
          </div>
          <div className="w-40">
            <Select
              placeholder="All Categories"
              options={[
                { value: 'ADULT', label: 'Adult' },
                { value: 'KIDS', label: 'Kids' },
                { value: 'INFANT', label: 'Infant / Baby' },
                { value: 'BOTTOMS', label: 'Denim & Bottoms' },
                { value: 'PLUS_SIZE', label: 'Plus Size' },
                { value: 'ACCESSORIES', label: 'Accessories' },
              ]}
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="w-36">
            <Select
              placeholder="All Genders"
              options={[
                { value: 'MEN', label: 'Men' },
                { value: 'WOMEN', label: 'Women' },
                { value: 'BOYS', label: 'Boys' },
                { value: 'GIRLS', label: 'Girls' },
                { value: 'UNISEX', label: 'Unisex' },
                { value: 'BABY', label: 'Baby' },
              ]}
              value={genderFilter}
              onChange={(e) => {
                setGenderFilter(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <DataTable
        columns={[
          {
            key: 'group_code',
            header: 'Group Code',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono font-bold text-brand-700">{r.group_code}</span>
            ),
          },
          {
            key: 'group_name',
            header: 'Size Group Name',
            sortable: true,
            render: (r: any) => (
              <div>
                <div className="font-bold text-slate-900">{r.group_name}</div>
                {r.description && (
                  <div className="text-[11px] text-slate-500 font-medium truncate max-w-[280px]">
                    {r.description}
                  </div>
                )}
              </div>
            ),
          },
          {
            key: 'category',
            header: 'Category',
            render: (r: any) => (
              <span className="inline-flex rounded px-2 py-0.5 text-[11px] font-bold bg-slate-100 text-slate-700">
                {r.category || 'ADULT'}
              </span>
            ),
          },
          {
            key: 'gender',
            header: 'Target / Gender',
            render: (r: any) => (
              <span className="text-xs font-medium text-slate-600">
                {r.gender || 'UNISEX'}
              </span>
            ),
          },
          {
            key: 'size_scale_preview',
            header: 'Ordered Size Scale (Sequence)',
            render: (r: any) => {
              const preview = r.size_scale_preview;
              if (!preview) return <span className="text-xs text-slate-400 italic">No sizes defined</span>;
              const parts = String(preview).split(' ➔ ');
              return (
                <div className="flex flex-wrap items-center gap-1">
                  {parts.map((sz, idx) => (
                    <span key={idx} className="inline-flex items-center gap-1 font-mono font-bold text-xs bg-slate-100 text-slate-800 rounded px-1.5 py-0.5 border border-slate-200">
                      {sz}
                    </span>
                  ))}
                </div>
              );
            },
          },
          {
            key: 'size_count',
            header: 'Total Sizes',
            render: (r: any) => {
              const count = Number(r.size_count) || 0;
              return (
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${
                  count > 0 ? 'bg-brand-50 text-brand-700 border border-brand-200' : 'bg-rose-50 text-rose-700'
                }`}>
                  {count} {count === 1 ? 'Size' : 'Sizes'}
                </span>
              );
            },
          },
          {
            key: 'is_active',
            header: 'Status',
            render: (r: any) => (
              <Badge tone={r.is_active ? 'green' : 'slate'}>
                {r.is_active ? 'Active' : 'Inactive'}
              </Badge>
            ),
          },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(r: any) => r.id}
        onRowClick={(r: any) => nav(`/masters/size-groups/${r.id}`)}
        sort={sort}
        onSort={onSort}
        pagination={list.data?.pagination}
        onPage={setPage}
      />
    </>
  );
}

/* ==============================================================================
   2. SIZE GROUP COCKPIT & SCALE BUILDER
   ============================================================================== */
export function SizeGroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [saving, setSaving] = useState(false);
  const buyers = useLookup('buyers');

  // Group Form State
  const [head, setHead] = useState<Record<string, any>>({
    group_code: '',
    group_name: '',
    category: 'ADULT',
    gender: 'UNISEX',
    buyer_id: '',
    description: '',
    is_active: 1,
  });

  // Ordered Sizes State
  const [sizes, setSizes] = useState<OrderedSizeItem[]>([
    { _key: 'sz_1', size_code: 'XS', size_label: 'Extra Small', body_measurement: '36" Chest', sort_order: 1, is_active: 1 },
    { _key: 'sz_2', size_code: 'S', size_label: 'Small', body_measurement: '38" Chest', sort_order: 2, is_active: 1 },
    { _key: 'sz_3', size_code: 'M', size_label: 'Medium', body_measurement: '40" Chest', sort_order: 3, is_active: 1 },
    { _key: 'sz_4', size_code: 'L', size_label: 'Large', body_measurement: '42" Chest', sort_order: 4, is_active: 1 },
    { _key: 'sz_5', size_code: 'XL', size_label: 'X-Large', body_measurement: '44" Chest', sort_order: 5, is_active: 1 },
    { _key: 'sz_6', size_code: '2XL', size_label: '2X-Large', body_measurement: '46" Chest', sort_order: 6, is_active: 1 },
  ]);

  // Load existing Group & Sizes
  const qGroup = useQuery({
    queryKey: ['size-group-detail', id],
    queryFn: async () => {
      const res = await http.get<any>(`/api/resources/size-groups/${id}`);
      return res.data;
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (qGroup.data) {
      const g = qGroup.data;
      setHead({
        group_code: g.group_code || '',
        group_name: g.group_name || '',
        category: g.category || 'ADULT',
        gender: g.gender || 'UNISEX',
        buyer_id: g.buyer_id || '',
        description: g.description || '',
        is_active: g.is_active ?? 1,
      });

      if (g.sizes && g.sizes.length > 0) {
        setSizes(
          g.sizes.map((s: any, idx: number) => ({
            _key: `sz_${s.id || idx}`,
            id: s.id,
            size_code: s.size_code || '',
            size_label: s.size_label || '',
            body_measurement: s.body_measurement || '',
            barcode_suffix: s.barcode_suffix || '',
            sort_order: s.sort_order ?? idx + 1,
            is_active: s.is_active ?? 1,
          }))
        );
      }
    }
  }, [qGroup.data]);

  // Auto Code on New
  useEffect(() => {
    if (isNew && !head.group_code) {
      setHead((h) => ({ ...h, group_code: `SG-${Math.floor(100 + Math.random() * 900)}` }));
    }
  }, [isNew]);

  // Apply a Preset
  const handleApplyPreset = (preset: typeof SIZE_GROUP_PRESETS[0]) => {
    setHead((h) => ({
      ...h,
      group_name: h.group_name || preset.name,
      category: preset.category,
      gender: preset.gender,
      description: preset.description,
    }));

    setSizes(
      preset.sizes.map((s, idx) => ({
        _key: `sz_preset_${++sizeSeq}`,
        size_code: s.code,
        size_label: s.label,
        body_measurement: s.body,
        barcode_suffix: '',
        sort_order: idx + 1,
        is_active: 1,
      }))
    );

    toast(`Applied preset: ${preset.name}`, 'success');
  };

  // Add Size row
  const handleAddSize = (code?: string, label?: string) => {
    setSizes((s) => [
      ...s,
      {
        _key: `sz_${++sizeSeq}`,
        size_code: code || '',
        size_label: label || code || '',
        body_measurement: '',
        barcode_suffix: '',
        sort_order: s.length + 1,
        is_active: 1,
      },
    ]);
  };

  const handleUpdateSize = (key: string, field: keyof OrderedSizeItem, val: any) => {
    setSizes((s) => s.map((item) => (item._key === key ? { ...item, [field]: val } : item)));
  };

  const handleMoveUp = (idx: number) => {
    if (idx === 0) return;
    setSizes((s) => {
      const arr = [...s];
      const temp = arr[idx - 1];
      arr[idx - 1] = arr[idx];
      arr[idx] = temp;
      return arr.map((item, i) => ({ ...item, sort_order: i + 1 }));
    });
  };

  const handleMoveDown = (idx: number) => {
    if (idx === sizes.length - 1) return;
    setSizes((s) => {
      const arr = [...s];
      const temp = arr[idx + 1];
      arr[idx + 1] = arr[idx];
      arr[idx] = temp;
      return arr.map((item, i) => ({ ...item, sort_order: i + 1 }));
    });
  };

  const handleRemoveSize = (key: string) => {
    if (sizes.length <= 1) {
      toast('At least one size is required in a Size Group', 'info');
      return;
    }
    setSizes((s) => s.filter((item) => item._key !== key).map((item, i) => ({ ...item, sort_order: i + 1 })));
  };

  const handleDuplicateSize = (key: string) => {
    const target = sizes.find((s) => s._key === key);
    if (!target) return;
    setSizes((s) => {
      const arr = [...s, { ...target, _key: `sz_${++sizeSeq}`, id: undefined, size_code: `${target.size_code}-COPY` }];
      return arr.map((item, i) => ({ ...item, sort_order: i + 1 }));
    });
  };

  const editable = can(isNew ? 'SIZE.CREATE' : 'SIZE.UPDATE');

  // SAVE
  const handleSave = async () => {
    if (!head.group_code?.trim()) {
      toast('Size Group Code is required', 'info');
      return;
    }
    if (!head.group_name?.trim()) {
      toast('Size Group Name is required', 'info');
      return;
    }
    if (sizes.length === 0) {
      toast('Please add at least one size to the group', 'info');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        group_code: head.group_code.trim().toUpperCase(),
        group_name: head.group_name.trim(),
        category: head.category || 'ADULT',
        gender: head.gender || 'UNISEX',
        buyer_id: head.buyer_id || null,
        description: head.description || null,
        is_active: head.is_active ? 1 : 0,
        sizes: sizes.map((s, idx) => ({
          id: s.id,
          size_code: s.size_code.trim().toUpperCase(),
          size_label: s.size_label.trim(),
          body_measurement: s.body_measurement || null,
          barcode_suffix: s.barcode_suffix || null,
          sort_order: idx + 1,
          is_active: s.is_active ? 1 : 0,
        })),
      };

      let groupId = id;
      if (isNew) {
        const res = await http.post<any>('/api/resources/size-groups', payload);
        groupId = res.data?.id;
      } else {
        await http.put(`/api/resources/size-groups/${id}`, payload);
      }

      toast('Size Group and ordered scale saved successfully!', 'success');
      qc.invalidateQueries({ queryKey: ['size-groups'] });
      qc.invalidateQueries({ queryKey: ['sizes'] });
      qc.invalidateQueries({ queryKey: ['size-group-detail', String(groupId)] });

      if (isNew) {
        nav(`/masters/size-groups/${groupId}`);
      }
    } catch (err: any) {
      toast(err instanceof ApiError ? err.message : (err?.message || 'Failed to save size group'), 'info');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this Size Group and its sizes?')) return;
    try {
      await http.del(`/api/resources/size-groups/${id}`);
      toast('Size Group deleted', 'success');
      qc.invalidateQueries({ queryKey: ['size-groups'] });
      qc.invalidateQueries({ queryKey: ['sizes'] });
      nav('/masters/size-groups');
    } catch (err: any) {
      toast(err?.message || 'Failed to delete size group', 'info');
    }
  };

  if (!isNew && qGroup.isLoading) return <LoadingBlock />;
  if (!isNew && qGroup.isError) return <ErrorState error={qGroup.error} />;

  return (
    <div className="space-y-6 pb-20">
      {/* Page Header */}
      <PageHeader
        title={isNew ? 'New Size Group Scale' : `${head.group_name} (${head.group_code})`}
        subtitle="Ordered Size Scale Definition for Garment Styles, Cutting Ratios, and PO Breakdowns"
        actions={
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => nav('/masters/size-groups')}>
              <ArrowLeft size={15} /> Back to List
            </button>
            {!isNew && can('SIZE.DELETE') && (
              <button type="button" className="btn-danger" onClick={handleDelete}>
                <Trash2 size={15} /> Delete
              </button>
            )}
            {editable && (
              <button
                type="button"
                className="btn-primary flex items-center gap-1.5 shadow-md hover:shadow-lg"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? <Spinner size={15} /> : <Save size={15} />}
                {isNew ? 'Create Size Group Scale' : 'Save All Changes'}
              </button>
            )}
          </div>
        }
      />

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* SECTION 1: SIZE GROUP IDENTITY & ATTRIBUTES                                */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <div className="card p-5 border border-slate-200 shadow-sm bg-white">
        <div className="flex items-center justify-between border-b border-surface-border pb-3 mb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Layers size={16} />
            </span>
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900">
                1. Size Group Identity &amp; Classification
              </h2>
              <p className="text-xs text-slate-500">
                Categorization and target department for this size scale
              </p>
            </div>
          </div>
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${
            head.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
          }`}>
            <span className={`h-2 w-2 rounded-full ${head.is_active ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            {head.is_active ? 'Active Scale' : 'Draft Scale'}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label">Group Code *</label>
            <div className="flex gap-1">
              <Input
                value={head.group_code}
                disabled={!editable}
                onChange={(e) => setHead({ ...head, group_code: e.target.value.toUpperCase() })}
                placeholder="e.g. SG-ADULT-ALPHA"
                className="font-mono font-bold text-brand-700"
              />
              <button
                type="button"
                className="btn-secondary px-2 text-xs font-mono font-bold"
                title="Auto Generate Code"
                onClick={() => setHead({ ...head, group_code: `SG-${Math.floor(100 + Math.random() * 900)}` })}
              >
                Auto
              </button>
            </div>
          </div>

          <div className="lg:col-span-2">
            <label className="label">Size Group Name *</label>
            <Input
              value={head.group_name}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, group_name: e.target.value })}
              placeholder="e.g. Men's Alpha Standard (XS - 3XL)"
              className="font-semibold text-slate-900"
            />
          </div>

          <div>
            <label className="label">Category *</label>
            <Select
              value={head.category}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, category: e.target.value })}
              options={[
                { value: 'ADULT', label: 'Adult (Men/Women)' },
                { value: 'KIDS', label: 'Kids (Boys/Girls)' },
                { value: 'INFANT', label: 'Infant / Baby & Toddler' },
                { value: 'BOTTOMS', label: 'Denim & Bottoms / Waist' },
                { value: 'PLUS_SIZE', label: 'Plus Size / Big & Tall' },
                { value: 'ACCESSORIES', label: 'Free Size / Accessories' },
              ]}
            />
          </div>

          <div>
            <label className="label">Target Gender / Division</label>
            <Select
              value={head.gender}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, gender: e.target.value })}
              options={[
                { value: 'MEN', label: 'Men' },
                { value: 'WOMEN', label: 'Women' },
                { value: 'BOYS', label: 'Boys' },
                { value: 'GIRLS', label: 'Girls' },
                { value: 'UNISEX', label: 'Unisex' },
                { value: 'BABY', label: 'Baby / Toddler' },
              ]}
            />
          </div>

          <div>
            <label className="label">Buyer / Customer Standard (Optional)</label>
            <Select
              value={head.buyer_id}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, buyer_id: e.target.value })}
              options={[{ value: '', label: '— Universal / All Buyers —' }, ...toOptions(buyers.data)]}
            />
          </div>

          <div>
            <label className="label">Master Status</label>
            <Select
              value={head.is_active}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, is_active: Number(e.target.value) })}
              options={[
                { value: 1, label: 'Active (Available for Styles / Orders)' },
                { value: 0, label: 'Inactive' },
              ]}
            />
          </div>

          <div className="lg:col-span-4">
            <label className="label">Technical Description &amp; Usage Notes</label>
            <Input
              value={head.description}
              disabled={!editable}
              onChange={(e) => setHead({ ...head, description: e.target.value })}
              placeholder="e.g. Standard chest ratio breakdown for Men's Knitted Round Neck and Polo T-Shirts."
            />
          </div>
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* SECTION 2: ONE-CLICK PRESET BUTTONS                                       */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <div className="card p-4 border border-slate-200 bg-slate-50/70">
        <div className="flex items-center gap-2 mb-2.5">
          <Sparkles size={16} className="text-amber-500" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800">
            One-Click Industry Standard Scale Presets
          </h3>
          <span className="text-[11px] text-slate-500 font-medium">
            (Click any preset to instantly auto-populate the ordered size scale)
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {SIZE_GROUP_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              disabled={!editable}
              onClick={() => handleApplyPreset(p)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-slate-800 border border-slate-300 shadow-sm hover:border-brand-500 hover:text-brand-700 hover:shadow transition-all"
            >
              <Tag size={12} className="text-brand-600" />
              <span>{p.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────────────────── */}
      {/* SECTION 3: ORDERED SIZES TABLE & SEQUENCE BUILDER                         */}
      {/* ────────────────────────────────────────────────────────────────────────── */}
      <div className="card p-5 border border-slate-200 shadow-sm bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-border pb-3 mb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
              <Ruler size={16} />
            </span>
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-900">
                2. Ordered Sizes Scale (Sequence 1 to {sizes.length})
              </h2>
              <p className="text-xs text-slate-500">
                The exact order here dictates how sizes appear across Styles, Cutting Lay Sheets, and Order Ratios
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {editable && (
              <button
                type="button"
                onClick={() => handleAddSize()}
                className="btn-primary flex items-center gap-1 text-xs"
              >
                <Plus size={13} /> Add Size
              </button>
            )}
          </div>
        </div>

        {/* Live Scale Visualizer Chain */}
        <div className="mb-4 rounded-lg bg-indigo-50/50 border border-indigo-100 p-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 mb-2 flex items-center gap-1">
            <CheckCircle2 size={13} /> Live Scale Sequence Preview:
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sizes.map((s, idx) => (
              <div key={s._key} className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-md bg-white border border-indigo-200 px-2.5 py-1 text-xs font-mono font-bold text-indigo-950 shadow-sm">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-indigo-100 text-[10px] text-indigo-700">
                    {idx + 1}
                  </span>
                  <span>{s.size_code || '—'}</span>
                  {s.body_measurement && (
                    <span className="text-[10px] font-sans font-normal text-slate-400">
                      ({s.body_measurement})
                    </span>
                  )}
                </span>
                {idx < sizes.length - 1 && (
                  <span className="text-indigo-400 font-bold text-xs">➔</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Sizes Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-surface-border bg-slate-100/60 text-[11px] font-bold uppercase text-slate-600">
                <th className="py-2.5 px-3 w-16 text-center">Order #</th>
                <th className="py-2.5 px-2 min-w-[140px]">Size Code *</th>
                <th className="py-2.5 px-2 min-w-[200px]">Size Display Label *</th>
                <th className="py-2.5 px-2 min-w-[180px]">Body Spec / Measurement Guide</th>
                <th className="py-2.5 px-2 w-32">Barcode Suffix</th>
                <th className="py-2.5 px-2 w-20 text-center">Status</th>
                <th className="py-2.5 px-2 w-28 text-center">Reorder</th>
                {editable && <th className="py-2.5 px-2 w-16 text-center">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sizes.map((s, idx) => (
                <tr key={s._key} className="hover:bg-slate-50/70">
                  <td className="py-2 px-3 text-center">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 font-mono font-bold text-xs text-slate-700">
                      {idx + 1}
                    </span>
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      placeholder="e.g. S, M, L, 32"
                      value={s.size_code}
                      disabled={!editable}
                      onChange={(e) => handleUpdateSize(s._key, 'size_code', e.target.value.toUpperCase())}
                      className="input py-1 px-2 font-mono font-bold text-brand-700 text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      placeholder="e.g. Small, Medium"
                      value={s.size_label}
                      disabled={!editable}
                      onChange={(e) => handleUpdateSize(s._key, 'size_label', e.target.value)}
                      className="input py-1 px-2 font-medium text-slate-800 text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      placeholder="e.g. 38 Chest, 104 cm"
                      value={s.body_measurement || ''}
                      disabled={!editable}
                      onChange={(e) => handleUpdateSize(s._key, 'body_measurement', e.target.value)}
                      className="input py-1 px-2 text-xs text-slate-600 w-full"
                    />
                  </td>
                  <td className="py-1 px-1">
                    <input
                      type="text"
                      placeholder="e.g. 01, 02"
                      value={s.barcode_suffix || ''}
                      disabled={!editable}
                      onChange={(e) => handleUpdateSize(s._key, 'barcode_suffix', e.target.value)}
                      className="input py-1 px-2 font-mono text-xs w-full"
                    />
                  </td>
                  <td className="py-1 px-1 text-center">
                    <button
                      type="button"
                      disabled={!editable}
                      onClick={() => handleUpdateSize(s._key, 'is_active', s.is_active ? 0 : 1)}
                      className={`inline-flex rounded px-2 py-0.5 text-[10px] font-bold ${
                        s.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {s.is_active ? 'Active' : 'Draft'}
                    </button>
                  </td>
                  <td className="py-1 px-1 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        disabled={!editable || idx === 0}
                        onClick={() => handleMoveUp(idx)}
                        className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30"
                        title="Move Up"
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={!editable || idx === sizes.length - 1}
                        onClick={() => handleMoveDown(idx)}
                        className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30"
                        title="Move Down"
                      >
                        <ArrowDown size={13} />
                      </button>
                    </div>
                  </td>
                  {editable && (
                    <td className="py-1 px-1 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleDuplicateSize(s._key)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                          title="Duplicate Size"
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveSize(s._key)}
                          className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          title="Remove Size"
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

        {/* Bottom KPI Metrics */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 pt-3 border-t border-slate-100">
          <div className="rounded-lg bg-blue-50/60 border border-blue-200 p-3 text-center">
            <span className="text-[11px] font-bold uppercase tracking-wider text-blue-700">Total Scale Sizes</span>
            <div className="text-xl font-black text-blue-900 mt-0.5">{sizes.length}</div>
          </div>
          <div className="rounded-lg bg-emerald-50/60 border border-emerald-200 p-3 text-center">
            <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Active Sizes</span>
            <div className="text-xl font-black text-emerald-900 mt-0.5">
              {sizes.filter((s) => s.is_active).length}
            </div>
          </div>
          <div className="rounded-lg bg-amber-50/60 border border-amber-200 p-3 text-center">
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700">Inactive Sizes</span>
            <div className="text-xl font-black text-amber-900 mt-0.5">
              {sizes.filter((s) => !s.is_active).length}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
