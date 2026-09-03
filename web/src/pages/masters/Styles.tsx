import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Sparkles, Save, FileText, Check, ChevronDown, X, Search } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions, useStatuses, toPlainOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, Input, Select, Textarea, Spinner, Badge, StatusBadge, LoadingBlock, ErrorState, Tabs, useDebounced,
  ImageUpload, ImageThumbnail,
} from '../../components/ui';
import { fmtDate } from '../../lib/format';

/* ────────────────────────────────────────────────────────────────────────── */
/* Color Multi-Select with Search & Swatches                                  */
/* ────────────────────────────────────────────────────────────────────────── */
function ColorMultiSelect({
  colors,
  selectedIds,
  onChange,
  disabled = false,
  error,
}: {
  colors: any[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = colors.filter(c =>
    (c.label || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.code || '').toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (id: number) => {
    if (disabled) return;
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter(x => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const selectAll = () => {
    if (disabled) return;
    onChange(Array.from(new Set([...selectedIds, ...filtered.map(c => c.id)])));
  };

  const clearAll = () => {
    if (disabled) return;
    onChange([]);
  };

  const selectedColors = colors.filter(c => selectedIds.includes(c.id));

  return (
    <div className="relative sm:col-span-2" ref={ref}>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-[11.5px] font-bold uppercase tracking-wider text-slate-700">
          Colourways (Colors) <span className="text-slate-400 font-normal lowercase">(search &amp; multi-select)</span>
        </label>
        {selectedIds.length > 0 && !disabled && (
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] font-medium text-slate-400 hover:text-red-600 transition-colors"
          >
            Clear all ({selectedIds.length})
          </button>
        )}
      </div>

      {/* Main Trigger Box */}
      <div
        onClick={() => !disabled && setOpen(o => !o)}
        className={`min-h-[38px] w-full cursor-pointer rounded-lg border bg-white p-1.5 flex flex-wrap items-center gap-1.5 transition-all ${
          open ? 'border-brand-500 ring-2 ring-brand-100' : 'border-surface-border hover:border-slate-300'
        } ${disabled ? 'cursor-not-allowed bg-slate-50 opacity-60' : ''}`}
      >
        {selectedColors.length === 0 ? (
          <span className="text-xs text-slate-400 px-2 py-1">
            — Select colours for this style (click to search &amp; select) —
          </span>
        ) : (
          selectedColors.map(c => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50/85 px-2 py-0.5 text-xs font-medium text-brand-900"
            >
              <span
                className="h-2.5 w-2.5 rounded-full border border-black/10 shrink-0"
                style={{ backgroundColor: c.hex_value || '#cbd5e1' }}
              />
              <span>{c.label}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    toggle(c.id);
                  }}
                  className="text-brand-500 hover:text-brand-800 p-0.5 rounded"
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))
        )}

        <div className="ml-auto flex items-center gap-1 text-slate-400 pr-1.5">
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      <p className="mt-1 text-[11px] text-slate-400">
        SKUs are generated as colour × size combinations for all selected colours.
      </p>

      {/* Dropdown Popover */}
      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 rounded-xl border border-surface-border bg-white shadow-popover animate-fade-in p-2">
          {/* Search Box */}
          <div className="relative mb-2">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              autoFocus
              placeholder="Search colours by name or code…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full rounded-lg border border-surface-border bg-slate-50/70 py-1.5 pl-8 pr-3 text-xs text-slate-800 focus:border-brand-500 focus:bg-white focus:outline-none"
            />
          </div>

          {/* Quick Action Bar */}
          <div className="flex items-center justify-between px-1.5 py-1 border-b border-surface-border text-[11px] text-slate-500 mb-1">
            <span>{filtered.length} colours found</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="text-brand-600 hover:text-brand-700 font-semibold"
              >
                Select all ({filtered.length})
              </button>
              <span>•</span>
              <button
                type="button"
                onClick={clearAll}
                className="text-slate-500 hover:text-red-600"
              >
                Clear all
              </button>
            </div>
          </div>

          {/* Color List */}
          <div className="max-h-56 overflow-y-auto divide-y divide-slate-50 pr-1">
            {filtered.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-400">No colours match &quot;{search}&quot;</p>
            ) : (
              filtered.map(c => {
                const selected = selectedIds.includes(c.id);
                return (
                  <div
                    key={c.id}
                    onClick={() => toggle(c.id)}
                    className={`flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer text-xs transition-colors ${
                      selected ? 'bg-brand-50/70 font-semibold text-brand-900' : 'hover:bg-slate-50 text-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className="h-4 w-4 rounded border border-black/10 shadow-sm shrink-0"
                        style={{ backgroundColor: c.hex_value || '#e2e8f0' }}
                      />
                      <span>{c.label}</span>
                      {c.code && (
                        <span className="text-[10px] text-slate-400 font-mono">({c.code})</span>
                      )}
                    </div>

                    <div className={`h-4 w-4 rounded border flex items-center justify-center ${
                      selected ? 'bg-brand-600 border-brand-600 text-white' : 'border-slate-300'
                    }`}>
                      {selected && <Check size={11} strokeWidth={3} />}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StylesPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'style_code', dir: 'asc' });
  const debounced = useDebounced(search);
  const [buyerId, setBuyerId] = useState('');
  const buyers = useLookup('buyers');

  const list = useList<any>('styles', {
    page, pageSize: 25, q: debounced || undefined, buyer_id: buyerId || undefined,
  });

  return (
    <>
      <PageHeader title="Styles" subtitle="Buyer-specific styles, colourways and SKUs"
        actions={can('STYLE.CREATE') && (
          <button className="btn-primary" onClick={() => nav('/masters/styles/new')}>
            <Plus size={15} /> New Style
          </button>)} />

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search style code, name or buyer ref…" />
        <Select placeholder="All buyers" options={toOptions(buyers.data)}
          value={buyerId} onChange={(e) => { setBuyerId(e.target.value); setPage(1); }} />
      </div>

      <DataTable
        columns={[
          { key: 'image_url', header: 'Photo', width: '56px',
            render: (r: any) => (
              <ImageThumbnail url={r.image_url} alt={r.style_code} title={`${r.style_code} — ${r.style_name}`} size="md" />
            ) },
          { key: 'style_code', header: 'Style code', sortable: true,
            render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.style_code}</span> },
          { key: 'style_name', header: 'Name', sortable: true,
            render: (r: any) => <span className="font-medium text-slate-800">{r.style_name}</span> },
          { key: 'product_name', header: 'Product' },
          { key: 'buyer_name', header: 'Buyer' },
          { key: 'season', header: 'Season' },
          { key: 'size_group_name', header: 'Size group' },
          { key: 'fabric_name', header: 'Body fabric' },
          { key: 'sku_count', header: 'SKUs', align: 'right',
            render: (r: any) => <Badge tone={Number(r.sku_count) > 0 ? 'green' : 'slate'}>{r.sku_count}</Badge> },
          { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/masters/styles/${r.id}`)}
        sort={sort} onSort={onSort}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No styles yet"
        emptyMessage="Create a style to start sampling, costing and ordering." />
    </>
  );
}

export function StyleDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [tab, setTab] = useState('details');
  const [v, setV] = useState<Record<string, any>>({ is_active: 1 });
  const [colorIds, setColorIds] = useState<number[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const products = useLookup('products');
  const buyers = useLookup('buyers');
  const sizeGroups = useLookup('size-groups');
  const fabrics = useLookup('fabrics');
  const colors = useLookup('colors');
  const statuses = useStatuses('STYLE');

  const detail = useQuery({
    queryKey: ['styles', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/styles/${id}`)).data,
    enabled: !isNew,
  });

  if (detail.data && !hydrated) {
    setV({ ...detail.data });
    setColorIds((detail.data.colors ?? []).map((c: any) => c.id));
    setHydrated(true);
  }

  const editable = isNew ? can('STYLE.CREATE') : can('STYLE.UPDATE');
  const set = (k: string, val: unknown) => setV((s) => ({ ...s, [k]: val }));

  const save = async (asDraft = false) => {
    setErrors({}); setSaving(true);
    try {
      const body = {
        style_code: v.style_code, style_name: v.style_name, product_id: v.product_id,
        buyer_id: v.buyer_id || null, buyer_style_ref: v.buyer_style_ref || null,
        season: v.season || null, size_group_id: v.size_group_id || null,
        fabric_id: v.fabric_id || null, description: v.description || null,
        image_url: v.image_url || null,
        status_id: v.status_id || null, is_active: asDraft ? 0 : (v.is_active ?? 1), colorIds,
      };
      const res = isNew
        ? await http.post<{ data: any }>('/styles', body)
        : await http.put<{ data: any }>(`/styles/${id}`, body);
      toast(asDraft ? 'Style saved as Draft — resume anytime' : `Style ${isNew ? 'created' : 'updated'} successfully`);
      void qc.invalidateQueries({ queryKey: ['styles'] });
      void qc.invalidateQueries({ queryKey: ['lookup'] });
      if (isNew) nav(`/masters/styles/${res.data.id}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError) { setErrors(e.fieldErrors); toast(e.message, 'error'); }
    } finally { setSaving(false); }
  };

  const generateSkus = async () => {
    setGenerating(true);
    try {
      const res = await http.post<{ data: { created: number; total: number } }>(`/styles/${id}/generate-skus`);
      toast(`${res.data.created} new SKU${res.data.created === 1 ? '' : 's'} generated (${res.data.total} total)`);
      void detail.refetch();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not generate SKUs', 'error');
    } finally { setGenerating(false); }
  };

  if (!isNew && detail.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && detail.error) return <div className="card"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div>;

  const d = detail.data;

  return (
    <>
      <PageHeader
        breadcrumb={['Master Data', 'Styles']}
        title={
          <div className="flex items-center gap-3">
            {!isNew && v.image_url && (
              <ImageThumbnail url={v.image_url} alt={d?.style_code} title={`${d?.style_code} — ${d?.style_name}`} size="md" />
            )}
            <span>{isNew ? 'New Style' : d?.style_code ?? 'Style'}</span>
          </div>
        }
        subtitle={isNew ? 'Define a buyer style and its colourways' : d?.style_name}
        actions={<>
          <button className="btn-secondary" onClick={() => nav('/masters/styles')}>
            <ArrowLeft size={15} /> Back
          </button>
          {editable && isNew && (
            <button className="btn-secondary" onClick={() => void save(true)} disabled={saving}>
              {saving ? <Spinner size={15} /> : <FileText size={15} />} Save as Draft
            </button>
          )}
          {editable && (
            <button className="btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size={15} /> : <Save size={15} />}
              {isNew ? 'Create Style' : !v.is_active ? 'Activate Style' : 'Save'}
            </button>
          )}
        </>} />

      {!isNew && (
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'details', label: 'Details' },
          { key: 'skus', label: 'SKUs', count: d?.skus?.length ?? 0 },
          { key: 'boms', label: 'BOMs', count: d?.boms?.length ?? 0 },
        ]} />
      )}

      {(isNew || tab === 'details') && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 mb-4">
            {/* Left 2 Cols: Main Metadata Form */}
            <div className="card p-4 lg:col-span-2">
              <h3 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-slate-700">Style Specifications</h3>
              <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
                <Input label="Style code" required value={v.style_code ?? ''} disabled={!editable}
                  onChange={(e) => set('style_code', e.target.value)} error={errors.style_code} />
                <Input label="Style name" required value={v.style_name ?? ''} disabled={!editable}
                  onChange={(e) => set('style_name', e.target.value)} error={errors.style_name} />
                <Select label="Product" required options={toOptions(products.data)} placeholder="— Select product —"
                  value={v.product_id ?? ''} disabled={!editable}
                  onChange={(e) => set('product_id', e.target.value)} error={errors.product_id} />
                <Select label="Buyer" options={toOptions(buyers.data)} placeholder="— Select buyer —"
                  value={v.buyer_id ?? ''} disabled={!editable} onChange={(e) => set('buyer_id', e.target.value)} />
                <Input label="Buyer style ref" value={v.buyer_style_ref ?? ''} disabled={!editable}
                  onChange={(e) => set('buyer_style_ref', e.target.value)} />
                <Input label="Season" placeholder="e.g. SS26" value={v.season ?? ''} disabled={!editable}
                  onChange={(e) => set('season', e.target.value)} />
                <Select label="Size group" options={toOptions(sizeGroups.data)} placeholder="— Select —"
                  value={v.size_group_id ?? ''} disabled={!editable}
                  onChange={(e) => set('size_group_id', e.target.value)}
                  hint="Required before SKUs can be generated" />
                <Select label="Body fabric" options={toOptions(fabrics.data)} placeholder="— Select —"
                  value={v.fabric_id ?? ''} disabled={!editable} onChange={(e) => set('fabric_id', e.target.value)} />
                <ColorMultiSelect colors={colors.data ?? []} selectedIds={colorIds} onChange={setColorIds} disabled={!editable} />
                <Select label="Status" options={toPlainOptions(statuses.data)} placeholder="— Select —"
                  value={v.status_id ?? ''} disabled={!editable} onChange={(e) => set('status_id', e.target.value)} />
                <Textarea className="sm:col-span-2" label="Description" value={v.description ?? ''}
                  disabled={!editable} onChange={(e) => set('description', e.target.value)} />
              </div>
            </div>

            {/* Right 1 Col: Garment Photo & Sketch Upload */}
            <div className="card p-4">
              <h3 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-slate-700">Garment Photo / Sketch</h3>
              <ImageUpload
                label=""
                hint="PNG, JPG, WEBP or SVG up to 10MB"
                value={v.image_url}
                disabled={!editable}
                onChange={(url: string | null) => set('image_url', url)}
              />
            </div>
          </div>
        </>
      )}

      {!isNew && tab === 'skus' && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-3">
            <div>
              <h3 className="text-[13.5px] font-semibold text-slate-800">Style SKUs</h3>
              <p className="text-[12px] text-slate-500">{d?.skus?.length ?? 0} SKUs · colour × size combinations</p>
            </div>
            {can('STYLE.UPDATE') && (
              <button className="btn-primary btn-sm" onClick={() => void generateSkus()} disabled={generating}>
                {generating ? <Spinner size={13} /> : <Sparkles size={13} />} Generate SKUs
              </button>
            )}
          </div>
          {d?.skus?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr>
                  <th className="th">SKU code</th><th className="th">Colour</th>
                  <th className="th">Size</th><th className="th">Barcode</th>
                </tr></thead>
                <tbody>
                  {d.skus.map((s: any) => (
                    <tr key={s.id} className="row-hover">
                      <td className="td font-mono text-[12px] text-brand-700">{s.sku_code}</td>
                      <td className="td">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block h-3.5 w-3.5 rounded border border-slate-200"
                            style={{ background: s.hex_value || '#f1f5f9' }} />
                          {s.color_name}
                        </span>
                      </td>
                      <td className="td">{s.size_label}</td>
                      <td className="td font-mono text-[11.5px] text-slate-500">{s.barcode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-6 py-12 text-center">
              <p className="text-[13px] text-slate-500">
                No SKUs yet. Assign a size group and colourways, then generate.
              </p>
            </div>
          )}
        </div>
      )}

      {!isNew && tab === 'boms' && (
        <div className="card overflow-hidden">
          {d?.boms?.length ? (
            <table className="w-full">
              <thead><tr>
                <th className="th">BOM no</th><th className="th">Version</th>
                <th className="th">Scope / Order</th>
                <th className="th">Effective</th><th className="th">Status</th>
              </tr></thead>
              <tbody>
                {d.boms.map((b: any) => (
                  <tr key={b.id} className="row-hover cursor-pointer" onClick={() => nav(`/masters/boms/${b.id}`)}>
                    <td className="td font-mono text-[12px] text-brand-700">{b.bom_no}</td>
                    <td className="td">v{b.version}</td>
                    <td className="td">
                      {b.so_no ? (
                        <span className="font-mono text-[11.5px] font-semibold text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded border border-brand-200">
                          {b.so_no}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                          Master (All Orders)
                        </span>
                      )}
                    </td>
                    <td className="td">{fmtDate(b.effective_date)}</td>
                    <td className="td"><StatusBadge value={b.status_label} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="p-8 text-center text-[13px] text-slate-400">No BOM defined for this style yet.</p>}
        </div>
      )}
    </>
  );
}
