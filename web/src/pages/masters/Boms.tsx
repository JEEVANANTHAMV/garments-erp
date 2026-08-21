import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Save, Trash2, Layers } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions, useStatuses, toPlainOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, Input, Select, Textarea, Spinner, Badge, StatusBadge,
  LoadingBlock, ErrorState, useDebounced,
} from '../../components/ui';
import { fmtDate, fmtDecimal, fmtNumber, today, toDateInput } from '../../lib/format';

const MATERIALS = ['YARN', 'FABRIC', 'TRIM'] as const;

interface BomLine {
  _key: string;
  material_type: 'YARN' | 'FABRIC' | 'TRIM';
  yarn_id: number | ''; fabric_id: number | ''; trim_id: number | '';
  color_id: number | ''; consumption: number | ''; uom_id: number | '';
  wastage_pct: number | ''; remarks: string;
}
let seq = 0;
const emptyLine = (): BomLine => ({
  _key: `b${++seq}`, material_type: 'FABRIC', yarn_id: '', fabric_id: '', trim_id: '',
  color_id: '', consumption: '', uom_id: '', wastage_pct: 0, remarks: '',
});

export function BomsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch } = useListState();
  const debounced = useDebounced(search);
  const list = useList<any>('boms', { page, pageSize: 25, q: debounced || undefined });

  return (
    <>
      <PageHeader title="Bill of Materials" subtitle="Per-garment material consumption by style"
        actions={can('BOM.CREATE') && (
          <button className="btn-primary" onClick={() => nav('/masters/boms/new')}>
            <Plus size={15} /> New BOM
          </button>)} />

      <SearchInput value={search} onChange={setSearch} placeholder="Search BOM or style code…"
        className="mb-3 w-full max-w-sm" />

      <DataTable
        columns={[
          { key: 'bom_no', header: 'BOM no',
            render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.bom_no}</span> },
          { key: 'version', header: 'Version', render: (r: any) => `v${r.version}` },
          { key: 'style_code', header: 'Style',
            render: (r: any) => <div><p className="font-medium">{r.style_code}</p>
              <p className="text-[11px] text-slate-500">{r.style_name}</p></div> },
          { key: 'line_count', header: 'Components', align: 'right',
            render: (r: any) => <Badge tone="blue">{r.line_count}</Badge> },
          { key: 'effective_date', header: 'Effective', render: (r: any) => fmtDate(r.effective_date) },
          { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/masters/boms/${r.id}`)}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No BOMs yet"
        emptyMessage="A BOM drives MRP, costing and material issue. Create one per style." />
    </>
  );
}

export function BomDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [head, setHead] = useState<Record<string, any>>({ version: 1, effective_date: today(), is_active: 1 });
  const [lines, setLines] = useState<BomLine[]>([emptyLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [explodeQty, setExplodeQty] = useState(1000);

  const styles = useLookup('styles');
  const yarns = useLookup('yarns');
  const fabrics = useLookup('fabrics');
  const trims = useLookup('trims');
  const colors = useLookup('colors');
  const uoms = useLookup('uoms');
  const statuses = useStatuses('BOM');

  const detail = useQuery({
    queryKey: ['boms', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/boms/${id}`)).data,
    enabled: !isNew,
  });

  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data;
    setHead({ ...d, effective_date: toDateInput(d.effective_date) });
    setLines((d.lines ?? []).map((l: any) => ({
      _key: `b${++seq}`, material_type: l.material_type,
      yarn_id: l.yarn_id ?? '', fabric_id: l.fabric_id ?? '', trim_id: l.trim_id ?? '',
      color_id: l.color_id ?? '', consumption: Number(l.consumption), uom_id: l.uom_id,
      wastage_pct: Number(l.wastage_pct ?? 0), remarks: l.remarks ?? '',
    })));
  }, [detail.data]);

  const editable = isNew ? can('BOM.CREATE') : can('BOM.UPDATE');

  // Rate lookup so the builder can price the BOM live.
  const rateOf = (l: BomLine): number => {
    const src = l.material_type === 'YARN' ? yarns.data
              : l.material_type === 'FABRIC' ? fabrics.data : trims.data;
    const mid = l.material_type === 'YARN' ? l.yarn_id
              : l.material_type === 'FABRIC' ? l.fabric_id : l.trim_id;
    return Number((src ?? []).find((x: any) => x.id === Number(mid))?.std_rate ?? 0);
  };

  const costPerGarment = useMemo(() =>
    lines.reduce((sum, l) => {
      const cons = Number(l.consumption) || 0;
      const withWaste = cons * (1 + (Number(l.wastage_pct) || 0) / 100);
      return sum + withWaste * rateOf(l);
    }, 0),
    [lines, yarns.data, fabrics.data, trims.data]);

  const setLine = (key: string, patch: Partial<BomLine>) =>
    setLines((s) => s.map((l) => (l._key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    setErrors({}); setSaving(true);
    try {
      const body = {
        style_id: head.style_id, bom_no: head.bom_no || undefined, version: head.version || 1,
        effective_date: head.effective_date || null, status_id: head.status_id || null,
        remarks: head.remarks || null, is_active: head.is_active ?? 1,
        lines: lines.filter((l) => l.consumption && (l.yarn_id || l.fabric_id || l.trim_id)).map((l) => ({
          material_type: l.material_type,
          yarn_id: l.material_type === 'YARN' ? Number(l.yarn_id) : null,
          fabric_id: l.material_type === 'FABRIC' ? Number(l.fabric_id) : null,
          trim_id: l.material_type === 'TRIM' ? Number(l.trim_id) : null,
          color_id: l.color_id ? Number(l.color_id) : null,
          consumption: Number(l.consumption), uom_id: Number(l.uom_id),
          wastage_pct: Number(l.wastage_pct) || 0, remarks: l.remarks || null,
        })),
      };
      if (!body.lines.length) { toast('Add at least one component line', 'error'); setSaving(false); return; }

      const res = isNew
        ? await http.post<{ data: any }>('/boms', body)
        : await http.put<{ data: any }>(`/boms/${id}`, body);
      toast(`BOM ${isNew ? 'created' : 'updated'} successfully`);
      void qc.invalidateQueries({ queryKey: ['boms'] });
      if (isNew) nav(`/masters/boms/${res.data.id}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError) { setErrors(e.fieldErrors); toast(e.message, 'error'); }
    } finally { setSaving(false); }
  };

  if (!isNew && detail.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && detail.error) return <div className="card"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div>;

  return (
    <>
      <PageHeader
        breadcrumb={['Master Data', 'Bill of Materials']}
        title={isNew ? 'New BOM' : detail.data?.bom_no ?? 'BOM'}
        subtitle={isNew ? 'Define per-garment material consumption'
          : `${detail.data?.style_code ?? ''} — ${detail.data?.style_name ?? ''}`}
        actions={<>
          <button className="btn-secondary" onClick={() => nav('/masters/boms')}>
            <ArrowLeft size={15} /> Back
          </button>
          {editable && (
            <button className="btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size={15} /> : <Save size={15} />} Save
            </button>
          )}
        </>} />

      <div className="card mb-4 p-4">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3 lg:grid-cols-5">
          <Input label="BOM no" hint={isNew ? 'Blank to auto-generate' : undefined}
            value={head.bom_no ?? ''} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, bom_no: e.target.value }))} error={errors.bom_no} />
          <Input label="Version" type="number" value={head.version ?? 1} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, version: e.target.value }))} />
          <Select label="Style" required options={toOptions(styles.data)} placeholder="— Select style —"
            value={head.style_id ?? ''} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, style_id: e.target.value }))} error={errors.style_id} />
          <Input label="Effective date" type="date" value={head.effective_date ?? ''} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, effective_date: e.target.value }))} />
          <Select label="Status" options={toPlainOptions(statuses.data)} placeholder="— Select —"
            value={head.status_id ?? ''} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, status_id: e.target.value }))} />
        </div>
      </div>

      <div className="card mb-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-surface-border px-4 py-3">
          <Layers size={15} className="text-brand-600" />
          <h3 className="text-[13.5px] font-semibold text-slate-800">Components</h3>
          <span className="text-[12px] text-slate-500">· consumption per garment</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr>
              <th className="th w-[110px]">Type</th>
              <th className="th min-w-[220px]">Material</th>
              <th className="th w-[150px]">Colour</th>
              <th className="th w-[120px] text-right">Consumption</th>
              <th className="th w-[110px]">UOM</th>
              <th className="th w-[100px] text-right">Wastage %</th>
              <th className="th w-[120px] text-right">Cost/gmt</th>
              {editable && <th className="th w-10" />}
            </tr></thead>
            <tbody>
              {lines.map((l) => {
                const rate = rateOf(l);
                const cons = Number(l.consumption) || 0;
                const lineCost = cons * (1 + (Number(l.wastage_pct) || 0) / 100) * rate;
                const matOptions = l.material_type === 'YARN' ? toOptions(yarns.data)
                                 : l.material_type === 'FABRIC' ? toOptions(fabrics.data)
                                 : toOptions(trims.data);
                const matValue = l.material_type === 'YARN' ? l.yarn_id
                               : l.material_type === 'FABRIC' ? l.fabric_id : l.trim_id;
                return (
                  <tr key={l._key}>
                    <td className="td p-1.5">
                      <select className="input py-1.5 text-[12.5px]" value={l.material_type} disabled={!editable}
                        onChange={(e) => setLine(l._key, {
                          material_type: e.target.value as BomLine['material_type'],
                          yarn_id: '', fabric_id: '', trim_id: '',
                        })}>
                        {MATERIALS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td className="td p-1.5">
                      <select className="input py-1.5 text-[12.5px]" value={matValue} disabled={!editable}
                        onChange={(e) => {
                          const val = e.target.value ? Number(e.target.value) : '';
                          const src = l.material_type === 'YARN' ? yarns.data
                                    : l.material_type === 'FABRIC' ? fabrics.data : trims.data;
                          const picked = (src ?? []).find((x: any) => x.id === Number(val));
                          setLine(l._key, {
                            yarn_id: l.material_type === 'YARN' ? val : '',
                            fabric_id: l.material_type === 'FABRIC' ? val : '',
                            trim_id: l.material_type === 'TRIM' ? val : '',
                            uom_id: (picked?.base_uom as number) ?? l.uom_id,
                          });
                        }}>
                        <option value="">— Select —</option>
                        {matOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                    <td className="td p-1.5">
                      <select className="input py-1.5 text-[12.5px]" value={l.color_id} disabled={!editable}
                        onChange={(e) => setLine(l._key, { color_id: e.target.value ? Number(e.target.value) : '' })}>
                        <option value="">All colours</option>
                        {(colors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </td>
                    <td className="td p-1.5">
                      <input type="number" step="0.00001" className="input py-1.5 text-right text-[12.5px] tabular-nums"
                        value={l.consumption} disabled={!editable}
                        onChange={(e) => setLine(l._key, { consumption: e.target.value === '' ? '' : Number(e.target.value) })} />
                    </td>
                    <td className="td p-1.5">
                      <select className="input py-1.5 text-[12.5px]" value={l.uom_id} disabled={!editable}
                        onChange={(e) => setLine(l._key, { uom_id: e.target.value ? Number(e.target.value) : '' })}>
                        <option value="">—</option>
                        {(uoms.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.code}</option>)}
                      </select>
                    </td>
                    <td className="td p-1.5">
                      <input type="number" step="0.001" className="input py-1.5 text-right text-[12.5px] tabular-nums"
                        value={l.wastage_pct} disabled={!editable}
                        onChange={(e) => setLine(l._key, { wastage_pct: e.target.value === '' ? '' : Number(e.target.value) })} />
                    </td>
                    <td className="td text-right tabular-nums text-slate-600">
                      {rate > 0 ? fmtDecimal(lineCost, 4) : <span className="text-slate-300">—</span>}
                    </td>
                    {editable && (
                      <td className="td p-1.5 text-right">
                        <button onClick={() => setLines((s) => s.filter((x) => x._key !== l._key))}
                          disabled={lines.length === 1}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {editable && (
          <div className="border-t border-surface-border p-2.5">
            <button className="btn-secondary btn-sm w-full justify-center border-dashed"
              onClick={() => setLines((s) => [...s, emptyLine()])}>
              <Plus size={14} /> Add component
            </button>
          </div>
        )}
      </div>

      {/* Cost roll-up */}
      <div className="card p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label">Material cost per garment</p>
            <p className="text-[24px] font-semibold tabular-nums text-slate-900">{fmtDecimal(costPerGarment, 4)}</p>
            <p className="mt-0.5 text-[11.5px] text-slate-500">Based on standard rates, wastage included</p>
          </div>
          <div className="flex items-end gap-3">
            <div>
              <label className="label">Explode for quantity</label>
              <input type="number" className="input w-36 tabular-nums" value={explodeQty}
                onChange={(e) => setExplodeQty(Math.max(0, Number(e.target.value)))} />
            </div>
            <div className="text-right">
              <p className="label">Total material cost</p>
              <p className="text-[24px] font-semibold tabular-nums text-brand-700">
                {fmtDecimal(costPerGarment * explodeQty, 2)}
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
