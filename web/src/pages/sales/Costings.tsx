import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, ArrowLeft, Save, Trash2, Calculator, Layers, FileText,
  Scale, DollarSign, Printer, Scissors, Shirt, Droplets, Tag, Box
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

/* ------------------------------------------------------ Types & Interfaces */
export interface FabricCostLine {
  _key: string;
  id?: number;
  fabric_type: 'Main Fabric' | 'Rib' | 'Neck Tape' | 'Pocketing' | 'Lining' | 'Collar / Cuff';
  fabric_name: string;
  construction: string;
  gsm: number | '';
  composition: string;
  yarn_count: string;
  process_details: string;
  consumption_kg: number | '';
  excess_pct: number | '';
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
  qty: number | '';
  rate: number | '';
}

export interface TrimCostLine {
  _key: string;
  trim_code: string;
  description: string;
  uom: string;
  consumption: number | '';
  rate: number | '';
}

export interface PackingCostLine {
  _key: string;
  item: string;
  uom: string;
  consumption: number | '';
  rate: number | '';
}

export interface OtherChargeLine {
  _key: string;
  charge_name: string;
  basis: 'Per Order' | 'Per Piece' | 'Percentage';
  amount: number | '';
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
   2. COSTING DETAIL COCKPIT (Matching Screenshot & F14 Sheet)
   ============================================================================== */
export function CostingDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
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

  // Header & Buyer Context State
  const [head, setHead] = useState({
    costing_no: 'CST/26-27/000125',
    costing_date: today(),
    status_id: '',
    status_label: 'Draft',
    version: 0,
    department: 'KIDSWEAR',
    buyer_id: '',
    buyer_name: 'NEXT RETAIL LTD',
    style_id: '',
    style_ref_no: 'NXK241025T01',
    description: 'BOYS T-SHIRT (SS26 ORGANIC COTTON)',
    product_category: 'T-SHIRT',
    size_range: 'XS - XXL',
    order_qty: 9000,
    currency_id: '',
    currency_code: 'USD',
    exchange_rate: 83.2,
    profit_pct: 15.0,
    rejection_pct: 3.0,
    fob_inspection_testing_pct: 7.0,
    payment_terms: '30% Advance, 70% LC',
    price_validity_days: 30,
    remarks: 'Tirupur export FOB quotation based on GOTS certified combed organic cotton.',
  });

  // Section 1: Fabric Details Table
  const [fabrics, setFabrics] = useState<FabricCostLine[]>([
    {
      _key: `fab_${++lineSeq}`,
      fabric_type: 'Main Fabric',
      fabric_name: 'Jersey 160 GSM',
      construction: 'Single Jersey',
      gsm: 160,
      composition: '100% Organic Cotton',
      yarn_count: "30's Combed",
      process_details: 'Knitting + Dyeing + Washing + Stentering + Compacting',
      consumption_kg: 0.226,
      excess_pct: 10.0,
      rate_per_kg: 6.85,
    },
    {
      _key: `fab_${++lineSeq}`,
      fabric_type: 'Rib',
      fabric_name: '1x1 Rib 240 GSM',
      construction: 'Rib 1x1',
      gsm: 240,
      composition: '92% Organic Cotton / 8% Elastane',
      yarn_count: "30's + 20D Lycra",
      process_details: 'Knitting + Dyeing + Washing + Heat Setting',
      consumption_kg: 0.023,
      excess_pct: 10.0,
      rate_per_kg: 7.2,
    },
  ]);

  // Section 2: Garment Consumption Breakdown (F14 Matrix)
  const [consMatrix] = useState({
    body_fabric_kg: 0.226,
    rib_fabric_kg: 0.023,
    neck_tape_kg: 0.005,
    wastage_pct: 10.0,
    garment_weight_gms: 210,
  });

  // Section 3: Fabric Rate Breakdown (Per KG of Main Fabric)
  const [rateBreakdown] = useState({
    raw_material_yarn: 3.45,
    knitting: 0.65,
    dyeing: 0.95,
    washing: 0.65,
    brushing: 0.0,
    heat_setting: 0.0,
    aop: 0.0,
    stentering: 0.25,
    compacting: 0.2,
  });

  // Section 4: CMT / Making Cost Lines
  const [cmtLines, setCmtLines] = useState<OperationCostLine[]>([
    { _key: `cmt_${++lineSeq}`, component: 'Cutting', rate: 8.0 },
    { _key: `cmt_${++lineSeq}`, component: 'Sewing', rate: 16.0 },
    { _key: `cmt_${++lineSeq}`, component: 'Finishing', rate: 3.0 },
    { _key: `cmt_${++lineSeq}`, component: 'Checking', rate: 2.0 },
    { _key: `cmt_${++lineSeq}`, component: 'Packing', rate: 1.0 },
  ]);

  // Section 5: Printing & Embroidery Lines
  const [embellishments, setEmbellishments] = useState<EmbellishmentLine[]>([
    { _key: `emb_${++lineSeq}`, process: 'Print', description: '2 Grade Panel Print (Discharge)', qty: 1, rate: 35.0 },
    { _key: `emb_${++lineSeq}`, process: 'Embroidery', description: 'Chest Logo Embroidery', qty: 0, rate: 0.0 },
  ]);

  // Section 6: Washing / Finishing Lines
  const [washings, setWashings] = useState<EmbellishmentLine[]>([
    { _key: `wsh_${++lineSeq}`, process: 'Bio Wash', description: 'Soft Flow Enzyme Wash', qty: 1, rate: 12.0 },
  ]);

  // Section 7: Trims Details Lines
  const [trims, setTrims] = useState<TrimCostLine[]>([
    { _key: `trm_${++lineSeq}`, trim_code: 'LBL-MAIN', description: 'Main Woven Brand Label', uom: 'Nos', consumption: 1, rate: 1.0 },
    { _key: `trm_${++lineSeq}`, trim_code: 'LBL-SIZE', description: 'Size Loop Label', uom: 'Nos', consumption: 1, rate: 0.4 },
    { _key: `trm_${++lineSeq}`, trim_code: 'LBL-CARE', description: 'Wash Care Satin Label', uom: 'Nos', consumption: 1, rate: 0.75 },
    { _key: `trm_${++lineSeq}`, trim_code: 'TAG-BRAND', description: 'Barcode & Brand Hangtag', uom: 'Nos', consumption: 1, rate: 0.6 },
    { _key: `trm_${++lineSeq}`, trim_code: 'HGR-BLACK', description: 'Black Export Garment Hanger', uom: 'Nos', consumption: 1, rate: 4.5 },
  ]);

  // Section 8: Packing Materials Lines
  const [packings, setPackings] = useState<PackingCostLine[]>([
    { _key: `pkg_${++lineSeq}`, item: 'Master Polybag', uom: 'Nos', consumption: 1, rate: 0.35 },
    { _key: `pkg_${++lineSeq}`, item: 'Carton Box (7 Ply)', uom: 'Nos', consumption: 1, rate: 0.65 },
    { _key: `pkg_${++lineSeq}`, item: 'Carton Stickers & Labels', uom: 'Nos', consumption: 1, rate: 0.15 },
    { _key: `pkg_${++lineSeq}`, item: 'Kimble Tag Pin', uom: 'Nos', consumption: 1, rate: 0.05 },
    { _key: `pkg_${++lineSeq}`, item: 'BOPP Gum Tape', uom: 'Mtr', consumption: 0.1, rate: 0.2 },
  ]);

  // Section 9: Other Charges Lines (Order Level)
  const [otherCharges, setOtherCharges] = useState<OtherChargeLine[]>([
    { _key: `oth_${++lineSeq}`, charge_name: 'Final Inspection (TUV / SGS)', basis: 'Per Order', amount: 12000 },
    { _key: `oth_${++lineSeq}`, charge_name: 'Lab Testing (Shrinkage & Fastness)', basis: 'Per Order', amount: 8000 },
    { _key: `oth_${++lineSeq}`, charge_name: 'GOTS Certification Transaction Fee', basis: 'Per Order', amount: 2000 },
    { _key: `oth_${++lineSeq}`, charge_name: 'Forwarding & Documentation', basis: 'Per Order', amount: 1000 },
  ]);

  // Load Existing Costing if editing
  const costingQuery = useQuery({
    queryKey: ['costings', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/resources/costings/${id}`)).data,
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
  }, [costingQuery.data]);

  // ------------------------------------------------------------ Calculations
  // 1. Total Fabric Cost Per Pc
  const totalFabricCostPerPc = useMemo(() => {
    return fabrics.reduce((sum, f) => {
      const cons = Number(f.consumption_kg) || 0;
      const rate = Number(f.rate_per_kg) || 0;
      return sum + cons * rate;
    }, 0);
  }, [fabrics]);

  const totalFabricOrderAmount = useMemo(() => {
    return totalFabricCostPerPc * (Number(head.order_qty) || 0);
  }, [totalFabricCostPerPc, head.order_qty]);

  // 2. CMT Total Cost Per Pc (in local currency / USD normalized)
  const totalCmtPerPc = useMemo(() => {
    return cmtLines.reduce((sum, c) => sum + (Number(c.rate) || 0), 0);
  }, [cmtLines]);

  // 3. Printing / Embroidery Total Per Pc
  const totalEmbellishmentPerPc = useMemo(() => {
    return embellishments.reduce((sum, e) => {
      const q = Number(e.qty) || 0;
      const r = Number(e.rate) || 0;
      return sum + q * r;
    }, 0);
  }, [embellishments]);

  // 4. Washing / Finishing Total Per Pc
  const totalWashingPerPc = useMemo(() => {
    return washings.reduce((sum, w) => {
      const q = Number(w.qty) || 0;
      const r = Number(w.rate) || 0;
      return sum + q * r;
    }, 0);
  }, [washings]);

  // 5. Trims Total Per Pc
  const totalTrimsPerPc = useMemo(() => {
    return trims.reduce((sum, t) => {
      const c = Number(t.consumption) || 0;
      const r = Number(t.rate) || 0;
      return sum + c * r;
    }, 0);
  }, [trims]);

  // 6. Packing Total Per Pc
  const totalPackingPerPc = useMemo(() => {
    return packings.reduce((sum, p) => {
      const c = Number(p.consumption) || 0;
      const r = Number(p.rate) || 0;
      return sum + c * r;
    }, 0);
  }, [packings]);

  // 7. Other Charges Total (Order Level converted to Per Piece)
  const totalOtherChargesOrder = useMemo(() => {
    return otherCharges.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
  }, [otherCharges]);

  const totalOtherChargesPerPc = useMemo(() => {
    const qty = Number(head.order_qty) || 1;
    return qty > 0 ? totalOtherChargesOrder / qty : 0;
  }, [totalOtherChargesOrder, head.order_qty]);

  // Combined Total Cost Per Garment
  // Note: if fabric is in USD ($1.88) and CMT/trims in INR, we convert at exchange rate if USD
  const isUSD = head.currency_code === 'USD';
  const exch = Number(head.exchange_rate) || 83.2;

  // Normalized Per-Piece Cost
  const totalCostPerPc = useMemo(() => {
    return (
      totalFabricCostPerPc +
      totalCmtPerPc +
      totalEmbellishmentPerPc +
      totalWashingPerPc +
      totalTrimsPerPc +
      totalPackingPerPc +
      totalOtherChargesPerPc
    );
  }, [
    totalFabricCostPerPc,
    totalCmtPerPc,
    totalEmbellishmentPerPc,
    totalWashingPerPc,
    totalTrimsPerPc,
    totalPackingPerPc,
    totalOtherChargesPerPc,
  ]);

  // Profit & Quoted FOB Calculations
  const profitPct = Number(head.profit_pct) || 15.0;
  const profitAmountPerPc = (totalCostPerPc * profitPct) / 100;
  const rawSellingPrice = totalCostPerPc + profitAmountPerPc;
  const finalFobPerPc = Math.ceil(rawSellingPrice * 100) / 100;
  const roundOffPerPc = finalFobPerPc - rawSellingPrice;

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
        cutting_cost: Number(cmtLines.find((c) => c.component === 'Cutting')?.rate) || 8,
        stitching_cost: Number(cmtLines.find((c) => c.component === 'Sewing')?.rate) || 16,
        finishing_cost: Number(cmtLines.find((c) => c.component === 'Finishing')?.rate) || 3,
        printing_cost: totalEmbellishmentPerPc,
        washing_cost: totalWashingPerPc,
        trim_cost: totalTrimsPerPc,
        packing_cost: totalPackingPerPc,
        overhead_cost: totalOtherChargesPerPc,
        total_cost: totalCostPerPc,
        margin_pct: profitPct,
        fob_price: finalFobPerPc,
        remarks: head.remarks || null,
        status_id: head.status_id || null,
      };

      const res = isNew
        ? await http.post<{ data: any }>('/resources/costings', payload)
        : await http.put<{ data: any }>(`/resources/costings/${id}`, payload);

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
        subtitle={`Style: ${head.style_ref_no}  |  ${head.description}  |  Order Qty: ${fmtNumber(head.order_qty)} pcs  |  FOB: ${head.currency_code} ${finalFobPerPc.toFixed(2)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" onClick={() => nav('/sales/costings')}>
              <ArrowLeft size={15} /> Back
            </button>
            <button className="btn-secondary" onClick={() => window.print()} title="Print F14 Costing Sheet">
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
          1. COSTING HEADER CARD
          ────────────────────────────────────────────────────────────────────────── */}
      <div className="card mb-4 overflow-hidden shadow-xs">
        <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Calculator size={15} className="text-brand-600" />
            <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-800">Costing Header</h3>
          </div>
          <span className="text-xs text-slate-500 font-mono">F14 Standard Garment Export Model</span>
        </div>

        <div className="p-4 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-6 text-xs">
          <Input
            label="Costing No"
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
            label="Costing Status"
            options={[
              { value: 'Draft', label: 'Draft' },
              { value: 'Under Review', label: 'Under Review' },
              { value: 'Approved', label: 'Approved' },
              { value: 'Submitted to Buyer', label: 'Submitted to Buyer' },
            ]}
            value={head.status_label}
            onChange={(e) => setHead((s) => ({ ...s, status_label: e.target.value }))}
            disabled={!editable}
          />
          <Input
            label="Revision No"
            type="number"
            value={head.version}
            onChange={(e) => setHead((s) => ({ ...s, version: Number(e.target.value) || 0 }))}
            disabled={!editable}
          />
          <Select
            label="Department"
            options={['KIDSWEAR', 'MENSWEAR', 'WOMENSWEAR', 'ACTIVEWEAR', 'INFANT'].map((v) => ({ value: v, label: v }))}
            value={head.department}
            onChange={(e) => setHead((s) => ({ ...s, department: e.target.value }))}
            disabled={!editable}
          />
          <Select
            label="Buyer"
            options={toOptions(buyers.data)}
            value={head.buyer_id}
            onChange={(e) => setHead((s) => ({ ...s, buyer_id: e.target.value }))}
            disabled={!editable}
          />

          <Select
            label="Style / Ref No"
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
          <div className="lg:col-span-2">
            <Input
              label="Description"
              value={head.description}
              onChange={(e) => setHead((s) => ({ ...s, description: e.target.value }))}
              disabled={!editable}
            />
          </div>
          <Input
            label="Product Category"
            value={head.product_category}
            onChange={(e) => setHead((s) => ({ ...s, product_category: e.target.value }))}
            disabled={!editable}
          />
          <Input
            label="Size Range"
            value={head.size_range}
            onChange={(e) => setHead((s) => ({ ...s, size_range: e.target.value }))}
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
            label="Exch. Rate (to INR)"
            type="number"
            step="0.0001"
            value={head.exchange_rate}
            onChange={(e) => setHead((s) => ({ ...s, exchange_rate: Number(e.target.value) || 83.2 }))}
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
          <Input
            label="Rejection Buffer (%)"
            type="number"
            step="0.1"
            value={head.rejection_pct}
            onChange={(e) => setHead((s) => ({ ...s, rejection_pct: Number(e.target.value) || 0 }))}
            disabled={!editable}
          />
          <div className="lg:col-span-2">
            <Input
              label="Payment Terms"
              value={head.payment_terms}
              onChange={(e) => setHead((s) => ({ ...s, payment_terms: e.target.value }))}
              disabled={!editable}
            />
          </div>
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
            { key: '3. CMT / Making', label: '2. CMT & Operations' },
            { key: '4. Printing / Embroidery', label: '3. Embellishments' },
            { key: '6. Trims', label: '4. Trims & Packing' },
            { key: '8. Other Charges', label: '5. Order Overheads' },
            { key: '10. Cost Summary', label: '6. FOB Commercials' },
          ]}
        />
      </div>

      {/* Main Content Grid: Left Workspace (68%) + Right Cost Summary Sidebar (32%) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* ── LEFT 8 COLS: DETAILED BREAKDOWN ACCORDING TO ACTIVE TAB ──────── */}
        <div className="lg:col-span-8 space-y-4">
          {/* TAB 1: FABRIC DETAILS & CONSUMPTION MATRIX */}
          {(activeTab === '1. Fabric' || activeTab === '10. Cost Summary') && (
            <div className="space-y-4">
              {/* Card A: Fabric Details Table */}
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Layers size={15} className="text-brand-600" />
                    <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">Fabric Details</h3>
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
                            fabric_name: 'Single Jersey',
                            construction: 'Single Jersey',
                            gsm: 160,
                            composition: '100% Cotton',
                            yarn_count: "30's Combed",
                            process_details: 'Knitting + Dyeing + Compacting',
                            consumption_kg: 0.2,
                            excess_pct: 10,
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
                        <th className="py-2 px-2 min-w-[130px]">Fabric Name</th>
                        <th className="py-2 px-2 w-16">GSM</th>
                        <th className="py-2 px-2 min-w-[120px]">Composition</th>
                        <th className="py-2 px-2 min-w-[140px]">Process Details</th>
                        <th className="py-2 px-2 w-20 text-right">Cons (Kg)</th>
                        <th className="py-2 px-2 w-16 text-right">Exc %</th>
                        <th className="py-2 px-2 w-20 text-right">Rate/Kg</th>
                        <th className="py-2 px-2 w-20 text-right font-bold text-slate-900">Amt/Pc</th>
                        <th className="py-2 px-2 w-24 text-right font-bold text-brand-700">Total Amt</th>
                        {editable && <th className="py-2 px-2 w-8 text-center" />}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {fabrics.map((f, idx) => {
                        const cons = Number(f.consumption_kg) || 0;
                        const rate = Number(f.rate_per_kg) || 0;
                        const amtPc = cons * rate;
                        const totalAmt = amtPc * (Number(head.order_qty) || 0);
                        return (
                          <tr key={f._key} className="hover:bg-slate-50/70">
                            <td className="py-2 px-2.5 font-bold text-slate-400">{idx + 1}</td>
                            <td className="py-1 px-1">
                              <select
                                value={f.fabric_type}
                                disabled={!editable}
                                onChange={(e) =>
                                  setFabrics((prev) =>
                                    prev.map((item) =>
                                      item._key === f._key ? { ...item, fabric_type: e.target.value as any } : item
                                    )
                                  )
                                }
                                className="input py-1 px-1.5 text-xs font-semibold text-slate-700 w-24"
                              >
                                <option value="Main Fabric">Main Fabric</option>
                                <option value="Rib">Rib</option>
                                <option value="Neck Tape">Neck Tape</option>
                                <option value="Pocketing">Pocketing</option>
                                <option value="Lining">Lining</option>
                                <option value="Collar / Cuff">Collar / Cuff</option>
                              </select>
                            </td>
                            <td className="py-1 px-1">
                              <input
                                type="text"
                                value={f.fabric_name}
                                disabled={!editable}
                                onChange={(e) =>
                                  setFabrics((prev) =>
                                    prev.map((item) =>
                                      item._key === f._key ? { ...item, fabric_name: e.target.value } : item
                                    )
                                  )
                                }
                                className="input py-1 px-1.5 text-xs w-full"
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
                                className="input py-1 px-1.5 text-xs font-mono w-16"
                              />
                            </td>
                            <td className="py-1 px-1">
                              <input
                                type="text"
                                value={f.composition}
                                disabled={!editable}
                                onChange={(e) =>
                                  setFabrics((prev) =>
                                    prev.map((item) =>
                                      item._key === f._key ? { ...item, composition: e.target.value } : item
                                    )
                                  )
                                }
                                className="input py-1 px-1.5 text-xs w-full"
                              />
                            </td>
                            <td className="py-1 px-1">
                              <input
                                type="text"
                                value={f.process_details}
                                disabled={!editable}
                                onChange={(e) =>
                                  setFabrics((prev) =>
                                    prev.map((item) =>
                                      item._key === f._key ? { ...item, process_details: e.target.value } : item
                                    )
                                  )
                                }
                                className="input py-1 px-1.5 text-xs text-slate-500 w-full"
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
                                className="input py-1 px-1.5 text-right font-mono font-bold text-slate-900 w-20 text-xs"
                              />
                            </td>
                            <td className="py-1 px-1 text-right">
                              <input
                                type="number"
                                step="0.1"
                                value={f.excess_pct}
                                disabled={!editable}
                                onChange={(e) =>
                                  setFabrics((prev) =>
                                    prev.map((item) =>
                                      item._key === f._key ? { ...item, excess_pct: Number(e.target.value) } : item
                                    )
                                  )
                                }
                                className="input py-1 px-1 text-right font-mono text-xs w-14"
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
                                className="input py-1 px-1.5 text-right font-mono font-bold text-slate-900 w-20 text-xs"
                              />
                            </td>
                            <td className="py-2 px-2 text-right font-mono font-bold text-slate-900">
                              {head.currency_code} {amtPc.toFixed(2)}
                            </td>
                            <td className="py-2 px-2 text-right font-mono font-black text-brand-700">
                              {head.currency_code} {fmtNumber(Math.round(totalAmt))}
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
                        <td colSpan={9} className="py-2.5 px-4 text-slate-800 uppercase tracking-wider">
                          Total Fabric Cost ({head.currency_code})
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono font-black text-sm text-slate-900">
                          {head.currency_code} {totalFabricCostPerPc.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono font-black text-sm text-brand-700">
                          {head.currency_code} {fmtNumber(Math.round(totalFabricOrderAmount))}
                        </td>
                        {editable && <td />}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Card B: Garment Consumption & Fabric Rate Breakdown (2-Column Grid) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Left: Garment Consumption Matrix */}
                <div className="card overflow-hidden">
                  <div className="border-b border-surface-border bg-slate-50/70 px-4 py-2 flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                      <Scale size={14} className="text-brand-600" /> Garment Consumption
                    </h4>
                    <span className="text-[11px] font-mono text-slate-500">Basis: Per Piece</span>
                  </div>
                  <div className="p-3.5 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Body Fabric Consumption:</span>
                      <span className="font-mono font-bold text-slate-900">{consMatrix.body_fabric_kg.toFixed(3)} Kg/Pc</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Rib Fabric Consumption:</span>
                      <span className="font-mono font-bold text-slate-900">{consMatrix.rib_fabric_kg.toFixed(3)} Kg/Pc</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Neck Tape Consumption:</span>
                      <span className="font-mono font-bold text-slate-900">{consMatrix.neck_tape_kg.toFixed(3)} Kg/Pc</span>
                    </div>
                    <div className="flex items-center justify-between pt-1.5 border-t border-slate-100">
                      <span className="font-semibold text-slate-800">Total Fabric Consumption:</span>
                      <span className="font-mono font-bold text-brand-700">
                        {(consMatrix.body_fabric_kg + consMatrix.rib_fabric_kg + consMatrix.neck_tape_kg).toFixed(3)} Kg/Pc
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Wastage %:</span>
                      <span className="font-mono font-bold text-amber-600">{consMatrix.wastage_pct.toFixed(2)} %</span>
                    </div>
                    <div className="flex items-center justify-between pt-1.5 border-t border-slate-100 font-bold">
                      <span className="text-slate-900">Total With Wastage:</span>
                      <span className="font-mono text-emerald-700">
                        {(
                          (consMatrix.body_fabric_kg + consMatrix.rib_fabric_kg + consMatrix.neck_tape_kg) *
                          (1 + consMatrix.wastage_pct / 100)
                        ).toFixed(4)}{' '}
                        Kg/Pc
                      </span>
                    </div>
                    <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-[11px] text-slate-500">
                      <span>Garment Weight:</span>
                      <span className="font-mono font-semibold">{consMatrix.garment_weight_gms} Gms/Pc</span>
                    </div>
                  </div>
                </div>

                {/* Right: Fabric Rate Breakdown (Per KG of Main Fabric) */}
                <div className="card overflow-hidden">
                  <div className="border-b border-surface-border bg-slate-50/70 px-4 py-2 flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                      <Droplets size={14} className="text-brand-600" /> Fabric Process Rate (Main Fabric)
                    </h4>
                    <span className="text-[11px] font-mono text-slate-500">Rate / Kg ({head.currency_code})</span>
                  </div>
                  <div className="p-3.5 space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Raw Material (Yarn):</span>
                      <span className="font-mono font-semibold text-slate-900">{rateBreakdown.raw_material_yarn.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Knitting:</span>
                      <span className="font-mono text-slate-900">{rateBreakdown.knitting.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Dyeing & Washing:</span>
                      <span className="font-mono text-slate-900">{rateBreakdown.dyeing.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">Stentering & Compacting:</span>
                      <span className="font-mono text-slate-900">
                        {(rateBreakdown.stentering + rateBreakdown.compacting).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t border-slate-200 font-bold">
                      <span className="text-slate-900">Total Rate / Kg:</span>
                      <span className="font-mono text-emerald-700 text-sm">
                        {head.currency_code}{' '}
                        {(
                          rateBreakdown.raw_material_yarn +
                          rateBreakdown.knitting +
                          rateBreakdown.dyeing +
                          rateBreakdown.washing +
                          rateBreakdown.stentering +
                          rateBreakdown.compacting
                        ).toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: CMT / MAKING COST */}
          {(activeTab === '3. CMT / Making' || activeTab === '10. Cost Summary') && (
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
              <div className="p-4 grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                {cmtLines.map((c) => (
                  <div key={c._key} className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-600 block mb-1">
                      {c.component}
                    </label>
                    <div className="flex items-center gap-1 font-mono">
                      <span className="text-slate-400 font-medium">{head.currency_code}</span>
                      <input
                        type="number"
                        step="0.1"
                        value={c.rate}
                        disabled={!editable}
                        onChange={(e) =>
                          setCmtLines((prev) =>
                            prev.map((item) =>
                              item._key === c._key ? { ...item, rate: Number(e.target.value) || 0 } : item
                            )
                          )
                        }
                        className="input py-1 px-2 font-mono font-bold text-slate-900 text-xs w-full text-right"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: EMBELLISHMENTS & WASHING */}
          {(activeTab === '4. Printing / Embroidery' || activeTab === '10. Cost Summary') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Left: Printing & Embroidery */}
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                  <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <Shirt size={14} className="text-brand-600" /> Printing / Embroidery
                  </h3>
                  <span className="font-mono font-bold text-slate-700 text-xs">
                    {head.currency_code} {totalEmbellishmentPerPc.toFixed(2)}
                  </span>
                </div>
                <div className="p-3 space-y-2 text-xs">
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
                        className="input col-span-5 py-1 px-1.5 text-xs"
                      />
                      <input
                        type="number"
                        step="0.5"
                        value={emb.rate}
                        disabled={!editable}
                        onChange={(e) =>
                          setEmbellishments((prev) =>
                            prev.map((item) =>
                              item._key === emb._key ? { ...item, rate: Number(e.target.value) || 0 } : item
                            )
                          )
                        }
                        className="input col-span-4 py-1 px-1.5 text-right font-mono font-bold text-slate-900 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Right: Washing / Finishing */}
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                  <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <Droplets size={14} className="text-brand-600" /> Washing / Finishing
                  </h3>
                  <span className="font-mono font-bold text-slate-700 text-xs">
                    {head.currency_code} {totalWashingPerPc.toFixed(2)}
                  </span>
                </div>
                <div className="p-3 space-y-2 text-xs">
                  {washings.map((w) => (
                    <div key={w._key} className="grid grid-cols-12 gap-2 items-center">
                      <span className="col-span-3 font-semibold text-slate-700">{w.process}</span>
                      <input
                        type="text"
                        value={w.description}
                        disabled={!editable}
                        onChange={(e) =>
                          setWashings((prev) =>
                            prev.map((item) =>
                              item._key === w._key ? { ...item, description: e.target.value } : item
                            )
                          )
                        }
                        className="input col-span-5 py-1 px-1.5 text-xs"
                      />
                      <input
                        type="number"
                        step="0.5"
                        value={w.rate}
                        disabled={!editable}
                        onChange={(e) =>
                          setWashings((prev) =>
                            prev.map((item) =>
                              item._key === w._key ? { ...item, rate: Number(e.target.value) || 0 } : item
                            )
                          )
                        }
                        className="input col-span-4 py-1 px-1.5 text-right font-mono font-bold text-slate-900 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: TRIMS & PACKING MATERIALS */}
          {(activeTab === '6. Trims' || activeTab === '10. Cost Summary') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Trims Details */}
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                  <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <Tag size={14} className="text-brand-600" /> Trims Details (Per Pc)
                  </h3>
                  <span className="font-mono font-bold text-slate-700 text-xs">
                    {head.currency_code} {totalTrimsPerPc.toFixed(2)}
                  </span>
                </div>
                <div className="p-3 space-y-2 text-xs">
                  {trims.map((t) => (
                    <div key={t._key} className="flex items-center justify-between gap-2">
                      <span className="w-36 truncate font-medium text-slate-700">{t.description}</span>
                      <div className="flex items-center gap-1 font-mono">
                        <span className="text-slate-400">{head.currency_code}</span>
                        <input
                          type="number"
                          step="0.05"
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

              {/* Packing Materials */}
              <div className="card overflow-hidden">
                <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                  <h3 className="text-[12.5px] font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                    <Box size={14} className="text-brand-600" /> Packing Materials (Per Pc)
                  </h3>
                  <span className="font-mono font-bold text-slate-700 text-xs">
                    {head.currency_code} {totalPackingPerPc.toFixed(2)}
                  </span>
                </div>
                <div className="p-3 space-y-2 text-xs">
                  {packings.map((p) => (
                    <div key={p._key} className="flex items-center justify-between gap-2">
                      <span className="w-36 truncate font-medium text-slate-700">{p.item}</span>
                      <div className="flex items-center gap-1 font-mono">
                        <span className="text-slate-400">{head.currency_code}</span>
                        <input
                          type="number"
                          step="0.05"
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

          {/* TAB 5: OTHER CHARGES */}
          {(activeTab === '8. Other Charges' || activeTab === '10. Cost Summary') && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <DollarSign size={15} className="text-brand-600" />
                  <h3 className="text-[13px] font-bold uppercase tracking-wider text-slate-800">
                    Other Charges & Order Overheads
                  </h3>
                </div>
                <span className="font-mono font-bold text-slate-700 text-xs">
                  Total: ₹ {fmtNumber(totalOtherChargesOrder)} (≈ {head.currency_code} {totalOtherChargesPerPc.toFixed(2)}/pc)
                </span>
              </div>
              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {otherCharges.map((oth) => (
                  <div key={oth._key} className="flex items-center justify-between p-2.5 rounded-lg border border-slate-200 bg-slate-50/50">
                    <span className="font-semibold text-slate-700">{oth.charge_name}</span>
                    <div className="flex items-center gap-1 font-mono">
                      <span className="text-slate-400">₹</span>
                      <input
                        type="number"
                        step="500"
                        value={oth.amount}
                        disabled={!editable}
                        onChange={(e) =>
                          setOtherCharges((prev) =>
                            prev.map((item) =>
                              item._key === oth._key ? { ...item, amount: Number(e.target.value) || 0 } : item
                            )
                          )
                        }
                        className="input py-1 px-2 text-right font-mono font-bold text-slate-900 text-xs w-28"
                      />
                    </div>
                  </div>
                ))}
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
                <span>3. Printing / Embroidery</span>
                <span className="font-mono font-semibold text-slate-900">{totalEmbellishmentPerPc.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>4. Washing / Finishing</span>
                <span className="font-mono font-semibold text-slate-900">{totalWashingPerPc.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>5. Trims Total</span>
                <span className="font-mono font-semibold text-slate-900">{totalTrimsPerPc.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>6. Packing Total</span>
                <span className="font-mono font-semibold text-slate-900">{totalPackingPerPc.toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between text-slate-600">
                <span>7. Other Charges (Per Pc)</span>
                <span className="font-mono font-semibold text-slate-900">{totalOtherChargesPerPc.toFixed(2)}</span>
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
              <span className="rounded-full bg-emerald-800 px-2 py-0.5 text-[10px] font-mono font-bold">FOB Tirupur</span>
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
              <div className="flex items-center justify-between text-slate-400 text-[11px]">
                <span>Round Off Adjustment:</span>
                <span className="font-mono">{roundOffPerPc.toFixed(2)}</span>
              </div>

              {/* FINAL FOB PRICE */}
              <div className="rounded-xl border-2 border-emerald-400 bg-emerald-100/60 p-3 text-center my-2">
                <span className="text-[11px] font-black uppercase tracking-wider text-emerald-900 block mb-0.5">
                  Final Quoted FOB (Per Pc)
                </span>
                <span className="text-3xl font-black tabular-nums text-emerald-900 font-mono">
                  {head.currency_code} {finalFobPerPc.toFixed(2)}
                </span>
                {isUSD && (
                  <p className="text-[11px] font-mono text-emerald-800 font-medium mt-1">
                    ≈ ₹ {(finalFobPerPc * exch).toFixed(2)} INR
                  </p>
                )}
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

          {/* Card 3: Terms & Reference */}
          <div className="card p-3.5 space-y-2 text-[11.5px] text-slate-600 bg-slate-50/60">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-500">Inspection & Testing:</span>
              <span className="font-mono font-semibold text-slate-800">TUV / SGS Certified</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-500">Payment Terms:</span>
              <span className="font-mono font-semibold text-slate-800">{head.payment_terms}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-500">Price Validity:</span>
              <span className="font-mono font-semibold text-slate-800">{head.price_validity_days} Days</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
