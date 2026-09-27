import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, Calculator, Layers, FileText,
  Printer, Scissors, Shirt, Tag, Box
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, Input, Select, Spinner, StatusBadge,
  LoadingBlock, ErrorState, Tabs, useDebounced
} from '../../components/ui';
import { fmtDate, fmtDecimal, fmtNumber, today, toDateInput } from '../../lib/format';
import { FabricPicker } from './CostingsFabricPicker';

/* ------------------------------------------------------ Types & Interfaces */
export interface FabricCostLine {
  _key: string;
  fabric_type: string;
  fabric_id?: string;
  fabric_name: string;
  gsm: number | '';
  consumption_kg: number | '';
  rate_per_kg: number | '';
}

export interface OperationCostLine {
  _key: string;
  component: string;
  rate: number | '';
}

export interface EmbellishmentLine {
  _key: string;
  process: string;
  description: string;
  rate: number | '';
}

export interface TrimCostLine {
  _key: string;
  description: string;
  uom: string;
  consumption: number | '';
  rate: number | '';
}

export interface PackingCostLine {
  _key: string;
  item: string;
  consumption: number | '';
  rate: number | '';
}

let lineSeq = 0;

/* ==============================================================================
   1. COSTINGS LIST PAGE (DataTable & Summary KPIs)
   ============================================================================== */
export default function CostingsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'costing_date', dir: 'desc' });
  const debounced = useDebounced(search);
  const [buyerId, setBuyerId] = useState('');
  const [styleId, setStyleId] = useState('');

  const buyers = useLookup('buyers');
  const styles = useLookup('styles');

  const list = useList<any>('costings', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    buyer_id: buyerId || undefined,
    style_id: styleId || undefined,
    sort: sort.key,
    dir: sort.dir,
  });

  return (
    <>
      <PageHeader
        breadcrumb={['Pre-Sales', 'Costing']}
        title="Costing Sheets"
        subtitle="Style-level pre-order cost build-up (F14 model), process breakdown and FOB pricing"
        actions={
          can('COSTING.CREATE') && (
            <button className="btn-primary" onClick={() => nav('/sales/costings/new')}>
              <Plus size={15} /> New Costing
            </button>
          )
        }
      />

      {/* Top Level Screen Switcher */}
      <div className="mb-4 flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          type="button"
          className="px-3 py-1.5 text-xs font-bold rounded-lg bg-brand-600 text-white shadow-xs flex items-center gap-1.5"
        >
          <FileText size={14} /> Costing Sheets (Classic F14)
        </button>
        <button
          type="button"
          onClick={() => nav('/sales/pre-costings')}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 flex items-center gap-1.5"
        >
          <Layers size={14} /> Merchandiser Pre-Costing (V2 Engine)
        </button>
      </div>

      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search costing number or style code…"
          className="w-full max-w-md"
        />
        <div className="w-56">
          <Select
            placeholder="All Buyers"
            options={toOptions(buyers.data)}
            value={buyerId}
            onChange={(e) => {
              setBuyerId(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-56">
          <Select
            placeholder="All Styles"
            options={toOptions(styles.data)}
            value={styleId}
            onChange={(e) => {
              setStyleId(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {(buyerId || styleId) && (
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setBuyerId('');
              setStyleId('');
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
            key: 'costing_no',
            header: 'Costing No',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono text-[12.5px] font-bold text-brand-700">{r.costing_no}</span>
            ),
          },
          {
            key: 'version',
            header: 'Rev',
            align: 'center',
            render: (r: any) => (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-700">
                v{r.version || 1}
              </span>
            ),
          },
          {
            key: 'costing_date',
            header: 'Date',
            sortable: true,
            render: (r: any) => fmtDate(r.costing_date),
          },
          {
            key: 'style_code',
            header: 'Style',
            render: (r: any) => (
              <div>
                <p className="font-bold text-slate-900">{r.style_code || '—'}</p>
                <p className="text-[11px] text-slate-500">{r.style_name || '—'}</p>
              </div>
            ),
          },
          {
            key: 'buyer_name',
            header: 'Buyer',
            render: (r: any) => <span className="font-medium text-slate-800">{r.buyer_name || '—'}</span>,
          },
          {
            key: 'order_qty',
            header: 'Order Qty',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-semibold text-slate-700">
                {r.order_qty ? `${fmtNumber(r.order_qty)} pcs` : '—'}
              </span>
            ),
          },
          {
            key: 'total_cost',
            header: 'Cost / Pc',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-medium text-slate-600">
                {r.currency_code || 'USD'} {fmtDecimal(r.total_cost || 0, 2)}
              </span>
            ),
          },
          {
            key: 'fob_price',
            header: 'Quoted FOB',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-black text-emerald-700 text-[13px]">
                {r.currency_code || 'USD'} {fmtDecimal(r.fob_price || 0, 2)}
              </span>
            ),
          },
          {
            key: 'margin_pct',
            header: 'Margin',
            align: 'right',
            render: (r: any) => {
              const m = Number(r.margin_pct) || 0;
              return (
                <span className={`font-mono font-bold text-xs ${m >= 15 ? 'text-emerald-600' : m >= 10 ? 'text-amber-600' : 'text-rose-600'}`}>
                  {m.toFixed(1)}%
                </span>
              );
            },
          },
          {
            key: 'status_label',
            header: 'Status',
            render: (r: any) => <StatusBadge value={r.status_label || 'Draft'} />,
          },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/sales/costings/${r.id}`)}
        sort={sort}
        onSort={onSort}
        pagination={list.data?.pagination}
        onPage={setPage}
        emptyTitle="No costing sheets found"
        emptyMessage="Create a style costing sheet to calculate garment fabric consumption, CMT, trims and FOB."
      />
    </>
  );
}

/* ==============================================================================
   2. COSTING DETAIL COCKPIT (Clean Essential Fields)
   ============================================================================== */
export function CostingDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('1. Fabric');

  // Lookups
  const styles = useLookup('styles');
  const buyers = useLookup('buyers');
  const currencies = useLookup('currencies');
  const fabricMaster = useLookup('fabrics');
  // Full data_json of the record; this sheet only owns its `classic` block and
  // leaves the Pre-Costing screen's keys untouched on save.
  const dataJsonRef = useRef<Record<string, unknown>>({});
  const [head, setHead] = useState({
    costing_no: '',
    costing_date: today(),
    status_id: '',
    status_label: 'Draft',
    version: 1,
    department: 'MENSWEAR',
    buyer_id: '',
    style_id: '',
    style_ref_no: '',
    description: '',
    order_qty: 1000,
    currency_id: '',
    currency_code: 'USD',
    exchange_rate: 83.2,
    profit_pct: 15.0,
    remarks: '',
  });

  // Section 1: Fabric Details Table
  const [fabrics, setFabrics] = useState<FabricCostLine[]>([
    {
      _key: `fab_${++lineSeq}`,
      fabric_type: 'Main Fabric',
      fabric_id: '2',
      fabric_name: 'Single Jersey 160 GSM',
      gsm: 160,
      consumption_kg: 0.22,
      rate_per_kg: 6.5,
    },
    {
      _key: `fab_${++lineSeq}`,
      fabric_type: 'Rib',
      fabric_id: '4',
      fabric_name: 'Rib 1x1 200 GSM',
      gsm: 200,
      consumption_kg: 0.025,
      rate_per_kg: 7.2,
    },
  ]);

  // Section 2: CMT / Making Cost Lines
  const [cmtLines, setCmtLines] = useState<OperationCostLine[]>([
    { _key: `cmt_${++lineSeq}`, component: 'Cutting', rate: 0.1 },
    { _key: `cmt_${++lineSeq}`, component: 'Sewing', rate: 0.2 },
    { _key: `cmt_${++lineSeq}`, component: 'Finishing', rate: 0.05 },
    { _key: `cmt_${++lineSeq}`, component: 'Packing', rate: 0.05 },
  ]);

  // Section 3: Printing & Washing
  const [embellishments, setEmbellishments] = useState<EmbellishmentLine[]>([
    { _key: `emb_${++lineSeq}`, process: 'Printing', description: 'Chest Print', rate: 0.25 },
    { _key: `emb_${++lineSeq}`, process: 'Washing', description: 'Bio-wash', rate: 0.15 },
  ]);

  // Section 4: Trims Details Lines
  const [trims, setTrims] = useState<TrimCostLine[]>([
    { _key: `trm_${++lineSeq}`, description: 'Main Brand Label', uom: 'Nos', consumption: 1, rate: 0.03 },
    { _key: `trm_${++lineSeq}`, description: 'Care / Size Label', uom: 'Nos', consumption: 1, rate: 0.02 },
    { _key: `trm_${++lineSeq}`, description: 'Brand Hangtag', uom: 'Nos', consumption: 1, rate: 0.05 },
  ]);

  // Section 5: Packing Materials Lines
  const [packings, setPackings] = useState<PackingCostLine[]>([
    { _key: `pkg_${++lineSeq}`, item: 'Individual Polybag', consumption: 1, rate: 0.02 },
    { _key: `pkg_${++lineSeq}`, item: 'Export Carton Box', consumption: 0.04, rate: 0.05 },
  ]);

  // Load Existing Costing if editing
  const costingQuery = useQuery({
    queryKey: ['costings', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/costings/${id}`)).data,
    enabled: !isNew,
  });

  useEffect(() => {
    if (!costingQuery.data) return;
    const c = costingQuery.data;
    setHead((prev) => ({
      ...prev,
      ...c,
      costing_date: toDateInput(c.costing_date),
      profit_pct: Number(c.margin_pct) || prev.profit_pct,
    }));
    try {
      const parsed = c.data_json ? (typeof c.data_json === 'string' ? JSON.parse(c.data_json) : c.data_json) : {};
      dataJsonRef.current = parsed && typeof parsed === 'object' ? parsed : {};
      const cl = (dataJsonRef.current as any).classic;
      if (cl) {
        if (Array.isArray(cl.fabrics) && cl.fabrics.length) setFabrics(cl.fabrics);
        if (Array.isArray(cl.cmtLines) && cl.cmtLines.length) setCmtLines(cl.cmtLines);
        if (Array.isArray(cl.embellishments)) setEmbellishments(cl.embellishments);
        if (Array.isArray(cl.trims)) setTrims(cl.trims);
        if (Array.isArray(cl.packings)) setPackings(cl.packings);
      }
    } catch {
      dataJsonRef.current = {};
    }
  }, [costingQuery.data]);

  // CMT rows: Cutting / Finishing / Packing map to their own cost heads; Sewing
  // and every extra making row the user adds go to stitching, so the saved heads
  // always add up to the CMT total.
  const cmtRate = (name: string) =>
    cmtLines.filter((c) => c.component.trim().toLowerCase() === name).reduce((s, c) => s + (Number(c.rate) || 0), 0);

  const addCmtLine = () => {
    setCmtLines((prev) => [...prev, { _key: `cmt_${++lineSeq}`, component: '', rate: '' }]);
    setTimeout(() => {
      const els = document.querySelectorAll<HTMLInputElement>('input[data-cmt-name]');
      els[els.length - 1]?.focus();
    }, 0);
  };

  // ------------------------------------------------------------ Calculations
  // 1. Total Fabric Cost Per Pc
  const totalFabricCostPerPc = useMemo(() => {
    return fabrics.reduce((sum, f) => {
      const cons = Number(f.consumption_kg) || 0;
      const rate = Number(f.rate_per_kg) || 0;
      return sum + cons * rate;
    }, 0);
  }, [fabrics]);

  // 2. CMT Total Cost Per Pc
  const totalCmtPerPc = useMemo(() => {
    return cmtLines.reduce((sum, c) => sum + (Number(c.rate) || 0), 0);
  }, [cmtLines]);

  // 3. Embellishments Total Per Pc
  const totalEmbellishmentPerPc = useMemo(() => {
    return embellishments.reduce((sum, e) => sum + (Number(e.rate) || 0), 0);
  }, [embellishments]);

  // 4. Trims Total Per Pc
  const totalTrimsPerPc = useMemo(() => {
    return trims.reduce((sum, t) => {
      const c = Number(t.consumption) || 0;
      const r = Number(t.rate) || 0;
      return sum + c * r;
    }, 0);
  }, [trims]);

  // 5. Packing Total Per Pc
  const totalPackingPerPc = useMemo(() => {
    return packings.reduce((sum, p) => {
      const c = Number(p.consumption) || 0;
      const r = Number(p.rate) || 0;
      return sum + c * r;
    }, 0);
  }, [packings]);

  // Total Cost Per Piece
  const totalCostPerPc = useMemo(() => {
    return (
      totalFabricCostPerPc +
      totalCmtPerPc +
      totalEmbellishmentPerPc +
      totalTrimsPerPc +
      totalPackingPerPc
    );
  }, [
    totalFabricCostPerPc,
    totalCmtPerPc,
    totalEmbellishmentPerPc,
    totalTrimsPerPc,
    totalPackingPerPc,
  ]);

  // Profit & Quoted FOB Calculations
  const profitPct = Number(head.profit_pct) || 15.0;
  const profitAmountPerPc = (totalCostPerPc * profitPct) / 100;
  const finalFobPerPc = totalCostPerPc + profitAmountPerPc;

  // Total Order Values
  const orderQty = Number(head.order_qty) || 0;
  const totalOrderCost = totalCostPerPc * orderQty;
  const totalOrderProfit = profitAmountPerPc * orderQty;
  const totalOrderFob = finalFobPerPc * orderQty;

  const editable = isNew ? can('COSTING.CREATE') : can('COSTING.UPDATE');

  // Save Handler
  const handleSave = async (mode: 'save' | 'draft' | 'saveAndNew' = 'save') => {
    if (!head.style_id && isNew && styles.data?.[0]?.id) {
      head.style_id = String(styles.data[0].id);
    }
    setSaving(true);
    try {
      const payload = {
        costing_no: head.costing_no || undefined,
        costing_date: head.costing_date,
        version: head.version || 1,
        style_id: head.style_id ? Number(head.style_id) : (styles.data?.[0]?.id ?? 1),
        buyer_id: head.buyer_id ? Number(head.buyer_id) : (buyers.data?.[0]?.id ?? null),
        currency_id: head.currency_id ? Number(head.currency_id) : (currencies.data?.[0]?.id ?? 1),
        order_qty: Number(head.order_qty) || 0,
        fabric_cost: totalFabricCostPerPc,
        cutting_cost: cmtRate('cutting'),
        stitching_cost: totalCmtPerPc - cmtRate('cutting') - cmtRate('finishing') - cmtRate('packing'),
        finishing_cost: cmtRate('finishing'),
        printing_cost: totalEmbellishmentPerPc,
        trim_cost: totalTrimsPerPc,
        packing_cost: totalPackingPerPc + cmtRate('packing'),
        total_cost: totalCostPerPc,
        margin_pct: profitPct,
        fob_price: finalFobPerPc,
        remarks: head.remarks || null,
        status_id: head.status_id || null,
        data_json: JSON.stringify({
          ...dataJsonRef.current,
          classic: { fabrics, cmtLines, embellishments, trims, packings },
        }),
      };

      const res = isNew
        ? await http.post<{ data: any }>('/costings', payload)
        : await http.put<{ data: any }>(`/costings/${id}`, payload);

      toast(mode === 'draft' ? 'Costing sheet saved as Draft' : `Costing ${isNew ? 'created' : 'updated'} successfully`);
      void qc.invalidateQueries({ queryKey: ['costings'] });

      if (mode === 'saveAndNew') {
        nav('/sales/costings/new');
      } else if (isNew && res.data?.id) {
        nav(`/sales/costings/${res.data.id}`, { replace: true });
      }
    } catch (e) {
      if (e instanceof ApiError) toast(e.message, 'error');
      else toast('Failed to save costing sheet', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && costingQuery.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && costingQuery.error) return <div className="card"><ErrorState error={costingQuery.error} onRetry={() => void costingQuery.refetch()} /></div>;

  return (
    <>
      <PageHeader
        breadcrumb={['Pre-Sales', 'Costing Sheet', isNew ? 'New' : head.costing_no]}
        title={
          <div className="flex items-center gap-3">
            <span>Costing — {head.style_ref_no || 'Style'}</span>
            <span className="rounded-full bg-blue-100 text-blue-800 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider border border-blue-300">
              {head.status_label || 'Draft'}
            </span>
          </div>
        }
        subtitle={`Order Qty: ${fmtNumber(head.order_qty)} pcs  |  Total Cost: ${head.currency_code} ${totalCostPerPc.toFixed(2)}  |  Quoted FOB: ${head.currency_code} ${finalFobPerPc.toFixed(2)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" onClick={() => nav('/sales/costings')}>
              <ArrowLeft size={15} /> Back
            </button>
            <button className="btn-secondary" onClick={() => window.print()} title="Print Costing Sheet">
              <Printer size={15} /> Print
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
                {isNew ? 'Save Costing' : 'Submit & Update'}
              </button>
            )}
          </div>
        }
      />

      {/* ──────────────────────────────────────────────────────────────────────────
          1. COSTING HEADER CARD (Clean & Essential)
          ────────────────────────────────────────────────────────────────────────── */}
      <div className="card mb-4 overflow-hidden shadow-xs">
        <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Calculator size={15} className="text-brand-600" />
            <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-800">Costing Header</h3>
          </div>
          <span className="text-xs text-slate-500 font-mono">Style Pre-Order Cost Build-Up</span>
        </div>

        <div className="p-4 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
          <Input
            label="Costing No"
            placeholder="Auto-generated if blank"
            value={head.costing_no}
            onChange={(e) => setHead((s) => ({ ...s, costing_no: e.target.value }))}
            disabled={!editable}
          />
          <Input
            label="Costing Date"
            type="date"
            required
            value={head.costing_date}
            onChange={(e) => setHead((s) => ({ ...s, costing_date: e.target.value }))}
            disabled={!editable}
          />
          <Select
            label="Style"
            options={toOptions(styles.data)}
            value={head.style_id}
            onChange={(e) => {
              const selected = styles.data?.find((st: any) => String(st.id) === e.target.value);
              setHead((s) => ({
                ...s,
                style_id: e.target.value,
                style_ref_no: String(selected?.style_code || s.style_ref_no),
                description: String(selected?.style_name || s.description),
              }));
            }}
            disabled={!editable}
          />
          <Select
            label="Buyer"
            options={toOptions(buyers.data)}
            value={head.buyer_id}
            onChange={(e) => setHead((s) => ({ ...s, buyer_id: e.target.value }))}
            disabled={!editable}
          />

          <Input
            label="Order Qty (Pcs)"
            type="number"
            required
            value={head.order_qty}
            onChange={(e) => setHead((s) => ({ ...s, order_qty: Number(e.target.value) || 0 }))}
            disabled={!editable}
          />
          <Select
            label="Currency"
            options={toOptions(currencies.data)}
            value={head.currency_id}
            onChange={(e) => {
              const c = currencies.data?.find((cur: any) => String(cur.id) === e.target.value);
              setHead((s) => ({
                ...s,
                currency_id: e.target.value,
                currency_code: String(c?.code || 'USD'),
                exchange_rate: c?.code === 'INR' ? 1.0 : s.exchange_rate,
              }));
            }}
            disabled={!editable}
          />
          <Input
            label="Profit Margin (%)"
            type="number"
            step="0.1"
            value={head.profit_pct}
            onChange={(e) => setHead((s) => ({ ...s, profit_pct: Number(e.target.value) || 0 }))}
            disabled={!editable}
          />
          <Select
            label="Costing Status"
            options={[
              { value: 'Draft', label: 'Draft' },
              { value: 'Under Review', label: 'Under Review' },
              { value: 'Approved', label: 'Approved' },
            ]}
            value={head.status_label}
            onChange={(e) => setHead((s) => ({ ...s, status_label: e.target.value }))}
            disabled={!editable}
          />
        </div>
      </div>

      {/* ──────────────────────────────────────────────────────────────────────────
          2. WORKSPACE TABS & SPLIT GRID
          ────────────────────────────────────────────────────────────────────────── */}
      <div className="mb-3">
        <Tabs
          active={activeTab}
          onChange={setActiveTab}
          tabs={[
            { key: '1. Fabric', label: '1. Fabric & Consumption' },
            { key: '2. CMT', label: '2. CMT & Making' },
            { key: '3. Embellishments', label: '3. Embellishments' },
            { key: '4. Trims & Packing', label: '4. Trims & Packing' },
          ]}
        />
      </div>

      {/* Main Content Grid: Left Inputs (68%) + Right Cost Summary Sidebar (32%) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* ── LEFT 8 COLS: TAB CONTENT ────────────────────────────────────── */}
        <div className="lg:col-span-8 space-y-4">
          {/* TAB 1: FABRIC DETAILS */}
          {activeTab === '1. Fabric' && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Layers size={15} className="text-brand-600" />
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Fabric Components</h3>
                </div>
                {editable && (
                  <button
                    type="button"
                    onClick={() =>
                      setFabrics((prev) => [
                        ...prev,
                        {
                          _key: `fab_${++lineSeq}`,
                          fabric_type: 'Main Fabric',
                          fabric_id: '',
                          fabric_name: '',
                          gsm: '',
                          consumption_kg: 0.2,
                          rate_per_kg: 6.5,
                        },
                      ])
                    }
                    className="btn-primary btn-sm text-xs py-1 px-2.5 flex items-center gap-1"
                  >
                    <Plus size={13} /> Add Fabric
                  </button>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-surface-border bg-slate-100/60 text-[11px] font-bold uppercase text-slate-600">
                      <th className="py-2 px-2.5 w-8">#</th>
                      <th className="py-2 px-2">Type</th>
                      <th className="py-2 px-2 min-w-[140px]">Fabric Name</th>
                      <th className="py-2 px-2 w-20">GSM</th>
                      <th className="py-2 px-2 w-24 text-right">Cons (Kg/pc)</th>
                      <th className="py-2 px-2 w-24 text-right">Rate/Kg</th>
                      <th className="py-2 px-2 w-24 text-right font-bold text-slate-900">Amt / Pc</th>
                      {editable && <th className="py-2 px-2 w-8 text-center" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {fabrics.map((f, idx) => {
                      const cons = Number(f.consumption_kg) || 0;
                      const rate = Number(f.rate_per_kg) || 0;
                      const amtPc = cons * rate;
                      return (
                        <tr key={f._key} className="hover:bg-slate-50/70">
                          <td className="py-2 px-2.5 font-bold text-slate-400">{idx + 1}</td>
                          <td className="py-1 px-1">
                            <input
                              type="text"
                              value={f.fabric_type}
                              disabled={!editable}
                              onChange={(e) =>
                                setFabrics((prev) =>
                                  prev.map((item) =>
                                    item._key === f._key ? { ...item, fabric_type: e.target.value } : item
                                  )
                                )
                              }
                              className="input py-1 px-1.5 text-xs font-semibold text-slate-700 w-28"
                            />
                          </td>
                          <td className="py-1 px-1 min-w-[200px]">
                            <FabricPicker
                              fabricId={f.fabric_id}
                              fabricName={f.fabric_name}
                              options={fabricMaster.data}
                              disabled={!editable}
                              onPick={(m) => {
                                const stdRate = Number(m.std_rate) || 0;
                                setFabrics((prev) =>
                                  prev.map((item) =>
                                    item._key === f._key
                                      ? {
                                          ...item,
                                          fabric_id: String(m.id),
                                          fabric_name: m.label,
                                          // Master std rate is in INR; only apply it on INR sheets or empty rates.
                                          rate_per_kg: stdRate > 0 && (head.currency_code === 'INR' || !item.rate_per_kg) ? stdRate : item.rate_per_kg,
                                        }
                                      : item
                                  )
                                );
                              }}
                            />
                          </td>
                          <td className="py-1 px-1">
                            <input
                              type="number"
                              value={f.gsm}
                              disabled={!editable}
                              onChange={(e) =>
                                setFabrics((prev) =>
                                  prev.map((item) =>
                                    item._key === f._key ? { ...item, gsm: Number(e.target.value) } : item
                                  )
                                )
                              }
                              className="input py-1 px-1.5 text-xs font-mono w-20"
                            />
                          </td>
                          <td className="py-1 px-1 text-right">
                            <input
                              type="number"
                              step="0.001"
                              value={f.consumption_kg}
                              disabled={!editable}
                              onChange={(e) =>
                                setFabrics((prev) =>
                                  prev.map((item) =>
                                    item._key === f._key
                                      ? { ...item, consumption_kg: e.target.value === '' ? '' : Number(e.target.value) }
                                      : item
                                  )
                                )
                              }
                              className="input py-1 px-1.5 text-right font-mono font-bold text-slate-900 w-24 text-xs"
                            />
                          </td>
                          <td className="py-1 px-1 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={f.rate_per_kg}
                              disabled={!editable}
                              onChange={(e) =>
                                setFabrics((prev) =>
                                  prev.map((item) =>
                                    item._key === f._key
                                      ? { ...item, rate_per_kg: e.target.value === '' ? '' : Number(e.target.value) }
                                      : item
                                  )
                                )
                              }
                              className="input py-1 px-1.5 text-right font-mono font-bold text-slate-900 w-24 text-xs"
                            />
                          </td>
                          <td className="py-2 px-2 text-right font-mono font-bold text-slate-900">
                            {head.currency_code} {amtPc.toFixed(2)}
                          </td>
                          {editable && (
                            <td className="py-1 px-1 text-center">
                              <button
                                type="button"
                                onClick={() => setFabrics((prev) => prev.filter((item) => item._key !== f._key))}
                                disabled={fabrics.length <= 1}
                                className="p-1 text-slate-400 hover:text-rose-600 rounded"
                              >
                                <Trash2 size={13} />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-xs">
                      <td colSpan={6} className="py-2.5 px-4 text-slate-800 uppercase tracking-wider">
                        Total Fabric Cost Per Piece
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono font-black text-sm text-slate-900">
                        {head.currency_code} {totalFabricCostPerPc.toFixed(2)}
                      </td>
                      {editable && <td />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* TAB 2: CMT / MAKING COST */}
          {activeTab === '2. CMT' && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Scissors size={15} className="text-brand-600" />
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">
                    CMT / Making Cost (Per Piece)
                  </h3>
                </div>
                <span className="font-mono font-bold text-slate-700 text-xs">
                  Total CMT: {head.currency_code} {totalCmtPerPc.toFixed(2)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-surface-border bg-slate-100/60 text-[11px] font-bold uppercase text-slate-600">
                      <th className="py-2 px-2.5 w-8">#</th>
                      <th className="py-2 px-2">Making Component / Operation</th>
                      <th className="py-2 px-2 w-36 text-right">Rate / Pc ({head.currency_code})</th>
                      {editable && <th className="py-2 px-2 w-8 text-center" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {cmtLines.map((c, idx) => (
                      <tr key={c._key} className="hover:bg-slate-50/70">
                        <td className="py-2 px-2.5 font-bold text-slate-400">{idx + 1}</td>
                        <td className="py-1 px-1">
                          <input
                            type="text"
                            value={c.component}
                            data-cmt-name={idx}
                            placeholder="e.g. Cutting, Sewing, Ironing, Checking…"
                            disabled={!editable}
                            onChange={(e) =>
                              setCmtLines((prev) =>
                                prev.map((item) => (item._key === c._key ? { ...item, component: e.target.value } : item))
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                (e.currentTarget.closest('tr')?.querySelector('input[type="number"]') as HTMLInputElement | null)?.focus();
                              }
                            }}
                            className="input py-1 px-1.5 text-xs font-semibold text-slate-700 w-full"
                          />
                        </td>
                        <td className="py-1 px-1 text-right">
                          <input
                            type="number"
                            step="0.01"
                            value={c.rate}
                            disabled={!editable}
                            onChange={(e) =>
                              setCmtLines((prev) =>
                                prev.map((item) =>
                                  item._key === c._key
                                    ? { ...item, rate: e.target.value === '' ? '' : Number(e.target.value) }
                                    : item
                                )
                              )
                            }
                            onKeyDown={(e) => {
                              // Enter on the last row's rate adds the next CMT row (row-by-row entry).
                              if (e.key === 'Enter' && editable) {
                                e.preventDefault();
                                if (idx === cmtLines.length - 1) addCmtLine();
                                else {
                                  const names = document.querySelectorAll<HTMLInputElement>('input[data-cmt-name]');
                                  names[idx + 1]?.focus();
                                }
                              }
                            }}
                            className="input py-1 px-1.5 text-right font-mono font-bold text-slate-900 w-32 text-xs"
                          />
                        </td>
                        {editable && (
                          <td className="py-1 px-1 text-center">
                            <button
                              type="button"
                              onClick={() => setCmtLines((prev) => prev.filter((item) => item._key !== c._key))}
                              disabled={cmtLines.length <= 1}
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
                      <td colSpan={2} className="py-2.5 px-4 text-slate-800 uppercase tracking-wider">
                        Total CMT Per Piece
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono font-black text-sm text-slate-900">
                        {head.currency_code} {totalCmtPerPc.toFixed(2)}
                      </td>
                      {editable && <td />}
                    </tr>
                  </tfoot>
                </table>
              </div>
              {editable && (
                <div className="flex items-center justify-between border-t border-surface-border px-4 py-2 text-[11px] text-slate-500">
                  <span>Press Enter in the last row&apos;s rate to add the next row.</span>
                  <button
                    type="button"
                    onClick={addCmtLine}
                    className="btn-secondary btn-sm text-xs py-1 px-2.5 flex items-center gap-1"
                  >
                    <Plus size={13} /> Add Row
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: EMBELLISHMENTS & WASHING */}
          {activeTab === '3. Embellishments' && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Shirt size={15} className="text-brand-600" />
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">
                    Embellishments & Washing (Per Piece)
                  </h3>
                </div>
                <span className="font-mono font-bold text-slate-700 text-xs">
                  Total: {head.currency_code} {totalEmbellishmentPerPc.toFixed(2)}
                </span>
              </div>
              <div className="p-4 space-y-2.5 text-xs">
                {embellishments.map((emb) => (
                  <div key={emb._key} className="grid grid-cols-12 gap-2 items-center">
                    <span className="col-span-3 font-semibold text-slate-700">{emb.process}</span>
                    <input
                      type="text"
                      value={emb.description}
                      disabled={!editable}
                      onChange={(e) =>
                        setEmbellishments((prev) =>
                          prev.map((item) =>
                            item._key === emb._key ? { ...item, description: e.target.value } : item
                          )
                        )
                      }
                      className="input col-span-6 py-1 px-2 text-xs"
                    />
                    <div className="col-span-3 flex items-center gap-1 font-mono">
                      <span className="text-slate-400">{head.currency_code}</span>
                      <input
                        type="number"
                        step="0.01"
                        value={emb.rate}
                        disabled={!editable}
                        onChange={(e) =>
                          setEmbellishments((prev) =>
                            prev.map((item) =>
                              item._key === emb._key ? { ...item, rate: Number(e.target.value) || 0 } : item
                            )
                          )
                        }
                        className="input py-1 px-2 text-right font-mono font-bold text-slate-900 text-xs w-full"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 4: TRIMS & PACKING */}
          {activeTab === '4. Trims & Packing' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Trims */}
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                  <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <Tag size={14} className="text-brand-600" /> Trims Total: {head.currency_code} {totalTrimsPerPc.toFixed(2)}
                  </h3>
                </div>
                <div className="p-3 space-y-2 text-xs">
                  {trims.map((t) => (
                    <div key={t._key} className="flex items-center justify-between gap-2">
                      <span className="w-40 truncate font-medium text-slate-700">{t.description}</span>
                      <div className="flex items-center gap-1 font-mono">
                        <span className="text-slate-400">{head.currency_code}</span>
                        <input
                          type="number"
                          step="0.01"
                          value={t.rate}
                          disabled={!editable}
                          onChange={(e) =>
                            setTrims((prev) =>
                              prev.map((item) =>
                                item._key === t._key ? { ...item, rate: Number(e.target.value) || 0 } : item
                              )
                            )
                          }
                          className="input py-1 px-1.5 text-right font-mono font-bold text-slate-900 text-xs w-20"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Packing */}
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                  <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <Box size={14} className="text-brand-600" /> Packing Total: {head.currency_code} {totalPackingPerPc.toFixed(2)}
                  </h3>
                </div>
                <div className="p-3 space-y-2 text-xs">
                  {packings.map((p) => (
                    <div key={p._key} className="flex items-center justify-between gap-2">
                      <span className="w-40 truncate font-medium text-slate-700">{p.item}</span>
                      <div className="flex items-center gap-1 font-mono">
                        <span className="text-slate-400">{head.currency_code}</span>
                        <input
                          type="number"
                          step="0.01"
                          value={p.rate}
                          disabled={!editable}
                          onChange={(e) =>
                            setPackings((prev) =>
                              prev.map((item) =>
                                item._key === p._key ? { ...item, rate: Number(e.target.value) || 0 } : item
                              )
                            )
                          }
                          className="input py-1 px-1.5 text-right font-mono font-bold text-slate-900 text-xs w-20"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT 4 COLS: COST SUMMARY & COMMERCIAL FOB COCKPIT ──────────── */}
        <div className="lg:col-span-4 space-y-4">
          {/* Card 1: Cost Summary (Per Piece) */}
          <div className="card overflow-hidden shadow-xs border border-slate-200">
            <div className="border-b border-surface-border bg-slate-900 text-white px-4 py-2.5 flex items-center justify-between">
              <h3 className="text-[12.5px] font-bold uppercase tracking-wider">Cost Summary (Per Pc)</h3>
              <span className="font-mono font-bold text-xs text-brand-300">{head.currency_code}</span>
            </div>

            <div className="p-4 space-y-2 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>1. Fabric Cost</span>
                <span className="font-mono font-semibold text-slate-900">{totalFabricCostPerPc.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>2. CMT / Making</span>
                <span className="font-mono font-semibold text-slate-900">{totalCmtPerPc.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>3. Embellishments / Wash</span>
                <span className="font-mono font-semibold text-slate-900">{totalEmbellishmentPerPc.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>4. Trims Total</span>
                <span className="font-mono font-semibold text-slate-900">{totalTrimsPerPc.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>5. Packing Total</span>
                <span className="font-mono font-semibold text-slate-900">{totalPackingPerPc.toFixed(2)}</span>
              </div>

              {/* Total Cost Row */}
              <div className="flex items-center justify-between pt-2.5 border-t-2 border-slate-200 font-bold text-slate-900 text-sm">
                <span>TOTAL COST (PER PC)</span>
                <span className="font-mono font-black text-slate-900">
                  {head.currency_code} {totalCostPerPc.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {/* Card 2: Commercial Margins & Final FOB Pricing */}
          <div className="card overflow-hidden shadow-xs border border-emerald-200 bg-gradient-to-b from-white to-emerald-50/30">
            <div className="border-b border-emerald-200 bg-emerald-700 text-white px-4 py-2.5 flex items-center justify-between">
              <h3 className="text-[12.5px] font-bold uppercase tracking-wider">Commercial &amp; FOB Pricing</h3>
              <span className="rounded-full bg-emerald-800 px-2 py-0.5 text-[10px] font-mono font-bold">FOB Quote</span>
            </div>

            <div className="p-4 space-y-2.5 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span>Profit Margin %:</span>
                <span className="font-mono font-bold text-emerald-700">{profitPct.toFixed(2)} %</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>Profit Amount (Per Pc):</span>
                <span className="font-mono font-semibold text-emerald-700">
                  {head.currency_code} {profitAmountPerPc.toFixed(2)}
                </span>
              </div>

              {/* FINAL FOB PRICE */}
              <div className="rounded-xl border-2 border-emerald-400 bg-emerald-100/60 p-3 text-center my-2">
                <span className="text-[11px] font-black uppercase tracking-wider text-emerald-900 block mb-0.5">
                  Final Quoted FOB (Per Pc)
                </span>
                <span className="text-3xl font-black tabular-nums text-emerald-900 font-mono">
                  {head.currency_code} {finalFobPerPc.toFixed(2)}
                </span>
              </div>

              {/* Order Level Commercial Summary */}
              <div className="pt-2 border-t border-slate-200 space-y-1.5 text-xs">
                <div className="flex items-center justify-between text-slate-600">
                  <span>Total Order Cost:</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {head.currency_code} {fmtNumber(Math.round(totalOrderCost))}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-600">
                  <span>Total Order Profit:</span>
                  <span className="font-mono font-bold text-emerald-700">
                    {head.currency_code} {fmtNumber(Math.round(totalOrderProfit))}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-slate-200 font-bold text-slate-900">
                  <span>Total Order Value (FOB):</span>
                  <span className="font-mono font-black text-brand-700 text-sm">
                    {head.currency_code} {fmtNumber(Math.round(totalOrderFob))}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
