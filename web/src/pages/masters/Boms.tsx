import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ArrowLeft, Save, Trash2, Layers, FileText, Zap, Sparkles } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions, useStatuses, toPlainOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, Input, Select, Spinner, Badge, StatusBadge, LoadingBlock, ErrorState, useDebounced
} from '../../components/ui';
import { fmtDate, fmtDecimal, today, toDateInput } from '../../lib/format';

const MATERIALS = ['FABRIC', 'YARN', 'TRIM', 'ACCESSORY', 'PACKING', 'GENERAL'] as const;

interface BomLine {
  _key: string;
  material_type: 'FABRIC' | 'YARN' | 'TRIM' | 'ACCESSORY' | 'PACKING' | 'GENERAL';
  yarn_id: number | '';
  fabric_id: number | '';
  trim_id: number | '';
  item_description: string;
  color_id: number | '';
  size_id: number | '';
  consumption_basis: string;
  applicability: string;
  consumption: number | '';
  additional_qty: number | '';
  uom_id: number | '';
  wastage_pct: number | '';
  remarks: string;
}
let seq = 0;
const emptyLine = (type: BomLine['material_type'] = 'TRIM'): BomLine => ({
  _key: `b${++seq}`,
  material_type: type,
  yarn_id: '',
  fabric_id: '',
  trim_id: '',
  item_description: '',
  color_id: '',
  size_id: '',
  consumption_basis: 'PER_PIECE',
  applicability: 'ALL',
  consumption: '',
  additional_qty: 0,
  uom_id: '',
  wastage_pct: 0,
  remarks: '',
});

export function BomsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch } = useListState();
  const debounced = useDebounced(search);
  const list = useList<any>('boms', { page, pageSize: 25, q: debounced || undefined });

  return (
    <>
      <PageHeader title="Bill of Materials (BOM)" subtitle="Per-garment CAD auto-consumption & tech pack trim requirements by style"
        actions={can('BOM.CREATE') && (
          <button className="btn-primary" onClick={() => nav('/masters/boms/new')}>
            <Plus size={15} /> New BOM
          </button>)} />

      <SearchInput value={search} onChange={setSearch} placeholder="Search BOM, style or order no…"
        className="mb-3 w-full max-w-sm" />

      <DataTable
        columns={[
          { key: 'bom_no', header: 'BOM no',
            render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.bom_no}</span> },
          { key: 'version', header: 'Version', render: (r: any) => `v${r.version}` },
          { key: 'style_code', header: 'Style',
            render: (r: any) => <div><p className="font-medium">{r.style_code}</p>
              <p className="text-[11px] text-slate-500">{r.style_name}</p></div> },
          { key: 'so_no', header: 'Mapped Order',
            render: (r: any) => r.so_no ? (
              <div>
                <span className="inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold text-brand-800 bg-brand-50 px-2 py-0.5 rounded border border-brand-200">
                  {r.so_no}
                </span>
                {r.buyer_po_no && <p className="text-[10.5px] text-slate-400">PO: {r.buyer_po_no}</p>}
              </div>
            ) : (
              <span className="inline-flex items-center text-[11px] font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                Master (All Orders)
              </span>
            ) },
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
        emptyMessage="A BOM drives MRP, costing and material procurement. Create one per style." />
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
  const [lines, setLines] = useState<BomLine[]>([emptyLine('FABRIC')]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [syncingCad, setSyncingCad] = useState(false);
  const [activeTab, setActiveTab] = useState<'ALL' | 'FABRIC' | 'YARN' | 'TRIM' | 'ACCESSORY' | 'PACKING' | 'GENERAL'>('ALL');
  const [explodeQty, setExplodeQty] = useState(1000);

  const styles = useLookup('styles');
  const salesOrders = useLookup('sales-orders');
  const yarns = useLookup('yarns');
  const fabrics = useLookup('fabrics');
  const trims = useLookup('trims');
  const colors = useLookup('colors');
  const sizes = useLookup('sizes');
  const uoms = useLookup('uoms');
  const statuses = useStatuses('BOM');

  const detail = useQuery({
    queryKey: ['boms', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/boms/${id}`)).data,
    enabled: !isNew,
  });

  // Query latest approved CAD requirement for this Style
  const { data: latestCad, refetch: refetchCad } = useQuery({
    queryKey: ['bom-latest-cad', head.style_id],
    queryFn: async () => {
      if (!head.style_id) return null;
      const res = await http.get<{ data: any }>(`/boms/latest-cad/${head.style_id}`);
      return res.data;
    },
    enabled: Boolean(head.style_id),
  });

  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data;
    setHead({ ...d, so_id: d.so_id ?? '', effective_date: toDateInput(d.effective_date) });
    setLines((d.lines ?? []).map((l: any) => ({
      _key: `b${++seq}`,
      material_type: l.material_type || 'TRIM',
      yarn_id: l.yarn_id ?? '',
      fabric_id: l.fabric_id ?? '',
      trim_id: l.trim_id ?? '',
      item_description: l.item_description ?? '',
      color_id: l.color_id ?? '',
      size_id: l.size_id ?? '',
      consumption_basis: l.consumption_basis || 'PER_PIECE',
      applicability: l.applicability || 'ALL',
      consumption: Number(l.consumption),
      additional_qty: Number(l.additional_qty ?? 0),
      uom_id: l.uom_id,
      wastage_pct: Number(l.wastage_pct ?? 0),
      remarks: l.remarks ?? '',
    })));
  }, [detail.data]);

  const editable = isNew ? can('BOM.CREATE') : can('BOM.UPDATE');

  // Handle Sync CAD Auto-Consumption (Clip 4 Requirement)
  const handleSyncCad = async () => {
    if (!latestCad?.has_approved_cad) {
      toast('No approved CAD consumption found for this style', 'warning');
      return;
    }

    setSyncingCad(true);
    try {
      if (!isNew && id) {
        // Backend auto-sync route
        await http.post(`/boms/${id}/sync-cad`);
        toast('CAD Auto-Consumption synced successfully into BOM lines!', 'success');
        void qc.invalidateQueries({ queryKey: ['boms', 'item', id] });
        void refetchCad();
      } else {
        // In-memory sync for new BOM
        const cad = latestCad;
        const fabricCons = Number(cad.fabric_consumption_per_pc) || 0.25;
        const yarnCons = Number(cad.yarn_req_per_pc) || Number((fabricCons * 1.05).toFixed(4));
        const kgUom = (uoms.data ?? []).find((u: any) => u.code === 'KG')?.id || 5;

        // Keep non-fabric/yarn lines (Trims) and append/replace fabric & yarn
        const otherLines = lines.filter((l) => l.material_type !== 'FABRIC' && l.material_type !== 'YARN');

        const newFabricLine: BomLine = {
          _key: `b${++seq}`,
          material_type: 'FABRIC',
          fabric_id: cad.fabric_id || (fabrics.data?.[0]?.id ?? ''),
          yarn_id: '',
          trim_id: '',
          item_description: '',
          color_id: '',
          size_id: '',
          consumption_basis: 'PER_PIECE',
          applicability: 'ALL',
          consumption: fabricCons,
          additional_qty: 0,
          uom_id: kgUom,
          wastage_pct: 3.0,
          remarks: `CAD Auto-Consumption (Marker: ${cad.marker_name || 'Approved'})`,
        };

        const newYarnLine: BomLine = {
          _key: `b${++seq}`,
          material_type: 'YARN',
          yarn_id: cad.yarn_id || (yarns.data?.[0]?.id ?? ''),
          fabric_id: '',
          trim_id: '',
          item_description: '',
          color_id: '',
          size_id: '',
          consumption_basis: 'PER_PIECE',
          applicability: 'ALL',
          consumption: yarnCons,
          additional_qty: 0,
          uom_id: kgUom,
          wastage_pct: 2.0,
          remarks: `CAD Derived Yarn (Yield: 95%)`,
        };

        setLines([newFabricLine, newYarnLine, ...otherLines]);
        toast('CAD Auto-Consumption populated into Fabric & Yarn lines!', 'success');
      }
    } catch (e) {
      toast((e as any).message || 'Failed to sync CAD consumption', 'error');
    } finally {
      setSyncingCad(false);
    }
  };

  const handleApprove = async () => {
    if (!id || isNew) return;
    try {
      await http.post(`/boms/${id}/approve`);
      toast('BOM approved successfully! Version marked active.', 'success');
      void qc.invalidateQueries({ queryKey: ['boms'] });
    } catch (e) {
      toast((e as any).message || 'Failed to approve BOM', 'error');
    }
  };

  const handleCreateRevision = async () => {
    if (!id || isNew) return;
    try {
      const res = await http.post<{ data: any }>(`/boms/${id}/revision`);
      toast(`Created revision v${res.data.version} — previous version preserved!`, 'success');
      void qc.invalidateQueries({ queryKey: ['boms'] });
      nav(`/masters/boms/${res.data.id}`);
    } catch (e) {
      toast((e as any).message || 'Failed to create revision', 'error');
    }
  };

  // Rate lookup so builder can price the BOM live
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

  const filteredLines = useMemo(() => {
    if (activeTab === 'ALL') return lines;
    return lines.filter((l) => l.material_type === activeTab);
  }, [lines, activeTab]);

  const counts = useMemo(() => ({
    all: lines.length,
    fabric: lines.filter((l) => l.material_type === 'FABRIC').length,
    yarn: lines.filter((l) => l.material_type === 'YARN').length,
    trim: lines.filter((l) => l.material_type === 'TRIM').length,
    accessory: lines.filter((l) => l.material_type === 'ACCESSORY').length,
    packing: lines.filter((l) => l.material_type === 'PACKING').length,
    general: lines.filter((l) => l.material_type === 'GENERAL').length,
  }), [lines]);

  const save = async (asDraft = false) => {
    setErrors({}); setSaving(true);
    try {
      const body = {
        style_id: head.style_id,
        so_id: head.so_id ? Number(head.so_id) : null,
        bom_no: head.bom_no || undefined,
        version: head.version || 1,
        effective_date: head.effective_date || null,
        status_id: head.status_id || null,
        approval_state: head.approval_state || (asDraft ? 'DRAFT' : 'SUBMITTED'),
        remarks: head.remarks || null,
        is_active: asDraft ? 0 : (head.is_active ?? 1),
        lines: lines.filter((l) => l.consumption && (l.yarn_id || l.fabric_id || l.trim_id || l.item_description)).map((l) => ({
          material_type: l.material_type,
          yarn_id: l.material_type === 'YARN' ? Number(l.yarn_id) : null,
          fabric_id: l.material_type === 'FABRIC' ? Number(l.fabric_id) : null,
          trim_id: ['TRIM','ACCESSORY','PACKING','GENERAL'].includes(l.material_type) && l.trim_id ? Number(l.trim_id) : null,
          item_description: l.item_description || null,
          color_id: l.color_id ? Number(l.color_id) : null,
          size_id: l.size_id ? Number(l.size_id) : null,
          consumption_basis: l.consumption_basis || 'PER_PIECE',
          applicability: l.applicability || 'ALL',
          consumption: Number(l.consumption),
          additional_qty: Number(l.additional_qty) || 0,
          uom_id: Number(l.uom_id),
          wastage_pct: Number(l.wastage_pct) || 0,
          remarks: l.remarks || null,
        })),
      };
      if (!asDraft && !body.lines.length) { toast('Add at least one component line', 'error'); setSaving(false); return; }

      const res = isNew
        ? await http.post<{ data: any }>('/boms', body)
        : await http.put<{ data: any }>(`/boms/${id}`, body);
      toast(asDraft ? 'BOM saved as Draft — resume anytime' : `BOM ${isNew ? 'created' : 'updated'} successfully`);
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
        title={isNew ? 'New BOM' : `${detail.data?.bom_no ?? 'BOM'} (v${head.version || 1})`}
        subtitle={isNew ? 'Define per-garment material consumption (Yarn, Fabric, Trims, Accessories, Packing, General)'
          : `${detail.data?.style_code ?? ''} — ${detail.data?.style_name ?? ''}${detail.data?.so_no ? ` (Order: ${detail.data.so_no})` : ' (Master)'}`}
        actions={<>
          <button className="btn-secondary" onClick={() => nav('/masters/boms')}>
            <ArrowLeft size={15} /> Back
          </button>
          {!isNew && head.approval_state === 'APPROVED' && (
            <button className="btn-secondary text-indigo-700 bg-indigo-50 border-indigo-200 hover:bg-indigo-100" onClick={handleCreateRevision}>
              <Sparkles size={14} /> Create Revision v{(Number(head.version) || 1) + 1}
            </button>
          )}
          {!isNew && head.approval_state !== 'APPROVED' && (
            <button className="btn-secondary text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100" onClick={handleApprove}>
              <Zap size={14} /> Approve BOM
            </button>
          )}
          {editable && isNew && (
            <button className="btn-secondary" onClick={() => void save(true)} disabled={saving}>
              {saving ? <Spinner size={15} /> : <FileText size={15} />} Save as Draft
            </button>
          )}
          {editable && (
            <button className="btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size={15} /> : <Save size={15} />}
              {isNew ? 'Create BOM' : !head.is_active ? 'Activate BOM' : 'Save BOM'}
            </button>
          )}
        </>} />

      {/* CAD Auto-Consumption Banner (Clip 4 Requirement) */}
      {head.style_id && (
        <div className={`mb-4 rounded-xl border p-4 shadow-xs transition-all ${
          latestCad?.has_approved_cad
            ? 'border-emerald-200 bg-gradient-to-r from-emerald-50/90 via-white to-emerald-50/40 text-emerald-950'
            : 'border-slate-200 bg-slate-50/70 text-slate-700'
        }`}>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className={`p-2 rounded-lg mt-0.5 ${
                latestCad?.has_approved_cad ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
              }`}>
                <Zap size={17} />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider">
                    CAD Auto-Consumption Integration
                  </h4>
                  {latestCad?.has_approved_cad ? (
                    <span className="bg-emerald-100 text-emerald-800 text-[10.5px] font-bold px-2 py-0.5 rounded border border-emerald-300">
                      Approved Marker: {latestCad.marker_name || 'CAD-MKR'} ({latestCad.efficiency_pct}% Eff)
                    </span>
                  ) : (
                    <span className="bg-slate-200 text-slate-700 text-[10.5px] font-medium px-2 py-0.5 rounded">
                      No Approved CAD Requirement
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] mt-0.5 text-slate-600">
                  {latestCad?.has_approved_cad
                    ? `Per Garment Fabric: ${fmtDecimal(latestCad.fabric_consumption_per_pc, 4)} kg | Derived Yarn: ${fmtDecimal(latestCad.yarn_req_per_pc, 4)} kg.`
                    : 'Once CAD marker consumption is approved in CAD module, Yarn and Fabric will automatically link to this BOM.'}
                </p>
              </div>
            </div>

            {latestCad?.has_approved_cad && editable && (
              <button
                type="button"
                onClick={handleSyncCad}
                disabled={syncingCad}
                className="btn-primary text-xs py-1.5 px-3.5 flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 border-emerald-600 shadow-sm shrink-0"
              >
                {syncingCad ? <Spinner size={13} /> : <Sparkles size={13} />}
                <span>Sync CAD Auto-Consumption</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* BOM Header Card */}
      <div className="card mb-4 p-4">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-6">
          <Input label="BOM no" hint={isNew ? 'Blank to auto-generate' : undefined}
            value={head.bom_no ?? ''} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, bom_no: e.target.value }))} error={errors.bom_no} />
          <Input label="Version" type="number" value={head.version ?? 1} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, version: e.target.value }))} />
          <Select label="Style" required options={toOptions(styles.data)} placeholder="— Select style —"
            value={head.style_id ?? ''} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, style_id: e.target.value }))} error={errors.style_id} />
          <Select
            label="Sales order (optional)"
            options={toOptions(salesOrders.data)}
            placeholder="— Master (All Orders) —"
            value={head.so_id ?? ''}
            disabled={!editable}
            hint="Blank = Master for all orders"
            onChange={(e) => setHead((s) => ({ ...s, so_id: e.target.value }))}
          />
          <Input label="Effective date" type="date" value={head.effective_date ?? ''} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, effective_date: e.target.value }))} />
          <Select label="Status" options={toPlainOptions(statuses.data)} placeholder="— Select —"
            value={head.status_id ?? ''} disabled={!editable}
            onChange={(e) => setHead((s) => ({ ...s, status_id: e.target.value }))} />
        </div>
      </div>

      {/* Components Section with Tabs & Tech Pack Trim Support */}
      <div className="card mb-4 overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-surface-border px-4 py-3 gap-2">
          <div className="flex items-center gap-2">
            <Layers size={15} className="text-brand-600" />
            <h3 className="text-[13.5px] font-semibold text-slate-800">Components & Tech Pack Materials</h3>
            <span className="text-[12px] text-slate-500">· consumption per garment</span>
          </div>

          {/* Component Tabs */}
          <div className="flex flex-wrap items-center gap-1 bg-slate-100 p-0.5 rounded-lg text-xs">
            <button
              type="button"
              onClick={() => setActiveTab('ALL')}
              className={`px-2.5 py-1 rounded-md font-medium transition ${
                activeTab === 'ALL' ? 'bg-white shadow-xs text-brand-700 font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All ({counts.all})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('FABRIC')}
              className={`px-2.5 py-1 rounded-md font-medium transition ${
                activeTab === 'FABRIC' ? 'bg-white shadow-xs text-emerald-700 font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Fabric ({counts.fabric})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('YARN')}
              className={`px-2.5 py-1 rounded-md font-medium transition ${
                activeTab === 'YARN' ? 'bg-white shadow-xs text-amber-700 font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Yarn ({counts.yarn})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('TRIM')}
              className={`px-2.5 py-1 rounded-md font-medium transition ${
                activeTab === 'TRIM' ? 'bg-white shadow-xs text-indigo-700 font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Trims ({counts.trim})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ACCESSORY')}
              className={`px-2.5 py-1 rounded-md font-medium transition ${
                activeTab === 'ACCESSORY' ? 'bg-white shadow-xs text-purple-700 font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Accessories ({counts.accessory})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('PACKING')}
              className={`px-2.5 py-1 rounded-md font-medium transition ${
                activeTab === 'PACKING' ? 'bg-white shadow-xs text-sky-700 font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Packing ({counts.packing})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('GENERAL')}
              className={`px-2.5 py-1 rounded-md font-medium transition ${
                activeTab === 'GENERAL' ? 'bg-white shadow-xs text-teal-700 font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              General ({counts.general})
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr>
              <th className="th w-[95px]">Type</th>
              <th className="th min-w-[200px]">Material / Description</th>
              <th className="th w-[110px]">Applicability</th>
              <th className="th w-[110px]">Colour</th>
              <th className="th w-[100px]">Size</th>
              <th className="th w-[105px]">Basis</th>
              <th className="th w-[90px] text-right">Cons/pc</th>
              <th className="th w-[80px] text-right">Addl Qty</th>
              <th className="th w-[75px]">UOM</th>
              <th className="th w-[75px] text-right">Waste %</th>
              <th className="th w-[95px] text-right">Cost/gmt</th>
              {editable && <th className="th w-10" />}
            </tr></thead>
            <tbody>
              {filteredLines.map((l) => {
                const rate = rateOf(l);
                const cons = Number(l.consumption) || 0;
                const lineCost = cons * (1 + (Number(l.wastage_pct) || 0) / 100) * rate;
                const isGeneralOrPacking = ['ACCESSORY', 'PACKING', 'GENERAL'].includes(l.material_type);
                const matOptions = l.material_type === 'YARN' ? toOptions(yarns.data)
                                 : l.material_type === 'FABRIC' ? toOptions(fabrics.data)
                                 : toOptions(trims.data);
                const matValue = l.material_type === 'YARN' ? l.yarn_id
                               : l.material_type === 'FABRIC' ? l.fabric_id : l.trim_id;
                return (
                  <tr key={l._key} className="hover:bg-slate-50/50">
                    <td className="td p-1.5">
                      <select className="input py-1 text-[11px] font-semibold" value={l.material_type} disabled={!editable}
                        onChange={(e) => setLine(l._key, {
                          material_type: e.target.value as BomLine['material_type'],
                          yarn_id: '', fabric_id: '', trim_id: '', item_description: '',
                        })}>
                        {MATERIALS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td className="td p-1.5">
                      {isGeneralOrPacking && !l.trim_id ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            className="input py-1 text-[11.5px]"
                            placeholder="e.g. Polybag, Carton, Tape..."
                            value={l.item_description || ''}
                            disabled={!editable}
                            onChange={(e) => setLine(l._key, { item_description: e.target.value })}
                          />
                          <select className="input py-1 text-[11px] w-28 shrink-0" value={l.trim_id} disabled={!editable}
                            onChange={(e) => setLine(l._key, { trim_id: e.target.value ? Number(e.target.value) : '' })}>
                            <option value="">(or Master)</option>
                            {(trims.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.label || t.trim_name}</option>)}
                          </select>
                        </div>
                      ) : (
                        <select className="input py-1 text-[11.5px]" value={matValue} disabled={!editable}
                          onChange={(e) => {
                            const val = e.target.value ? Number(e.target.value) : '';
                            const src = l.material_type === 'YARN' ? yarns.data
                                      : l.material_type === 'FABRIC' ? fabrics.data : trims.data;
                            const picked = (src ?? []).find((x: any) => x.id === Number(val));
                            setLine(l._key, {
                              yarn_id: l.material_type === 'YARN' ? val : '',
                              fabric_id: l.material_type === 'FABRIC' ? val : '',
                              trim_id: ['TRIM','ACCESSORY','PACKING','GENERAL'].includes(l.material_type) ? val : '',
                              uom_id: (picked?.base_uom as number) ?? l.uom_id,
                            });
                          }}>
                          <option value="">— Select Material —</option>
                          {matOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      )}
                    </td>
                    {/* Applicability */}
                    <td className="td p-1.5">
                      <select className="input py-1 text-[11px]" value={l.applicability || 'ALL'} disabled={!editable}
                        onChange={(e) => setLine(l._key, { applicability: e.target.value })}>
                        <option value="ALL">All (Uniform)</option>
                        <option value="COLOUR_WISE">Colour-wise</option>
                        <option value="SIZE_WISE">Size-wise</option>
                        <option value="COLOUR_SIZE_WISE">Colour & Size</option>
                      </select>
                    </td>
                    {/* Colour */}
                    <td className="td p-1.5">
                      <select className="input py-1 text-[11px]" value={l.color_id} disabled={!editable}
                        onChange={(e) => setLine(l._key, { color_id: e.target.value ? Number(e.target.value) : '' })}>
                        <option value="">All Colours</option>
                        {(colors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </td>
                    {/* Size */}
                    <td className="td p-1.5">
                      <select className="input py-1 text-[11px]" value={l.size_id} disabled={!editable}
                        onChange={(e) => setLine(l._key, { size_id: e.target.value ? Number(e.target.value) : '' })}>
                        <option value="">All Sizes</option>
                        {(sizes.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select>
                    </td>
                    {/* Consumption Basis */}
                    <td className="td p-1.5">
                      <select className="input py-1 text-[11px]" value={l.consumption_basis || 'PER_PIECE'} disabled={!editable}
                        onChange={(e) => setLine(l._key, { consumption_basis: e.target.value })}>
                        <option value="PER_PIECE">Per Piece</option>
                        <option value="PER_DOZEN">Per Dozen</option>
                        <option value="PER_CARTON">Per Carton</option>
                        <option value="PER_SET">Per Set</option>
                        <option value="FIXED_QTY">Fixed Qty</option>
                      </select>
                    </td>
                    {/* Consumption */}
                    <td className="td p-1.5">
                      <input type="number" step="0.00001" className="input py-1 text-right text-[11.5px] tabular-nums font-mono font-semibold"
                        value={l.consumption} disabled={!editable}
                        placeholder="0.00"
                        onChange={(e) => setLine(l._key, { consumption: e.target.value === '' ? '' : Number(e.target.value) })} />
                    </td>
                    {/* Additional Qty */}
                    <td className="td p-1.5">
                      <input type="number" step="0.01" className="input py-1 text-right text-[11.5px] tabular-nums font-mono"
                        value={l.additional_qty} disabled={!editable}
                        placeholder="0"
                        onChange={(e) => setLine(l._key, { additional_qty: e.target.value === '' ? '' : Number(e.target.value) })} />
                    </td>
                    {/* UOM */}
                    <td className="td p-1.5">
                      <select className="input py-1 text-[11px]" value={l.uom_id} disabled={!editable}
                        onChange={(e) => setLine(l._key, { uom_id: e.target.value ? Number(e.target.value) : '' })}>
                        <option value="">—</option>
                        {(uoms.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.code}</option>)}
                      </select>
                    </td>
                    {/* Wastage % */}
                    <td className="td p-1.5">
                      <input type="number" step="0.01" className="input py-1 text-right text-[11px] tabular-nums"
                        value={l.wastage_pct} disabled={!editable}
                        placeholder="0"
                        onChange={(e) => setLine(l._key, { wastage_pct: e.target.value === '' ? '' : Number(e.target.value) })} />
                    </td>
                    <td className="td text-right tabular-nums font-mono text-slate-700">
                      {rate > 0 ? `₹${fmtDecimal(lineCost, 3)}` : <span className="text-slate-300">—</span>}
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
          <div className="border-t border-surface-border p-2.5 flex flex-wrap items-center justify-between gap-2 bg-slate-50/60">
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-secondary btn-sm"
                onClick={() => setLines((s) => [...s, emptyLine('FABRIC')])}>
                <Plus size={13} /> Add Fabric
              </button>
              <button className="btn-secondary btn-sm"
                onClick={() => setLines((s) => [...s, emptyLine('YARN')])}>
                <Plus size={13} /> Add Yarn
              </button>
              <button className="btn-secondary btn-sm"
                onClick={() => setLines((s) => [...s, emptyLine('TRIM')])}>
                <Plus size={13} /> Add Trim
              </button>
              <button className="btn-secondary btn-sm"
                onClick={() => setLines((s) => [...s, emptyLine('ACCESSORY')])}>
                <Plus size={13} /> Add Accessory
              </button>
              <button className="btn-secondary btn-sm"
                onClick={() => setLines((s) => [...s, emptyLine('PACKING')])}>
                <Plus size={13} /> Add Packing
              </button>
              <button className="btn-secondary btn-sm"
                onClick={() => setLines((s) => [...s, emptyLine('GENERAL')])}>
                <Plus size={13} /> Add General
              </button>
            </div>
            <span className="text-[11px] text-slate-400">
              CAD feeds Fabric/Yarn; Merchandiser enters Trims, Accessories, Packing & General Materials
            </span>
          </div>
        )}
      </div>

      {/* Cost roll-up */}
      <div className="card p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label">Material cost per garment</p>
            <p className="text-[24px] font-semibold tabular-nums text-slate-900">₹{fmtDecimal(costPerGarment, 4)}</p>
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
                ₹{fmtDecimal(costPerGarment * explodeQty, 2)}
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
