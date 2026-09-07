import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, RefreshCw, CheckCircle,
  Plus, Trash2
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, StatusBadge } from '../../components/ui';
import { fmtDecimal, fmtNumber, today, toDateInput } from '../../lib/format';

export default function PreCostingDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [saving, setSaving] = useState(false);
  const [loadingBOM, setLoadingBOM] = useState(false);
  const [activeTab, setActiveTab] = useState('Fabric');

  // Lookups
  const styles = useLookup('styles');
  const buyers = useLookup('buyers');
  const currencies = useLookup('currencies');

  // Header State
  const [costId, setCostId] = useState<number | null>(isNew ? null : Number(id));
  const [head, setHead] = useState({
    costing_no: '',
    costing_date: today(),
    buyer_id: '',
    buyer_name: '',
    season: 'AW-26',
    style_id: '',
    style_code: '',
    style_name: '',
    buyer_ref: 'RFQ-45821',
    order_qty: 5000,
    currency_id: '1',
    currency_code: 'INR',
    price_basis: 'PER_PCS',
    unit_id: '1',
    factory: 'Unit 1 (Tiruppur)',
    version: 1,
    status: 'Draft',
    margin_pct: 15.0,
    markup_pct: 17.65,
    cutting_cost: 1.50,
    finishing_cost: 1.50,
    smv: 12.5,
    smv_rate_per_min: 0.85,
    overhead_basis: 'PER_PIECE',
    overhead_rate: 3.00,
    overhead_pct: 5.0,
    remarks: '',
  });

  // Tab 1: Fabric Lines
  const [fabrics, setFabrics] = useState<any[]>([
    {
      _key: 'fab_1',
      component: 'Body',
      fabric_id: '1',
      fabric_name: 'Single Jersey 100% Cotton 180 GSM',
      color: 'Black',
      size: 'All',
      consumption: 0.22,
      wastage_pct: 5.0,
      rate: 420.00,
      amount: 97.02,
      rate_source: 'Standard Rate Master',
    },
    {
      _key: 'fab_2',
      component: 'Collar / Neck Rib',
      fabric_id: '2',
      fabric_name: '1x1 Rib 100% Cotton 220 GSM',
      color: 'Black',
      size: 'All',
      consumption: 0.025,
      wastage_pct: 4.0,
      rate: 450.00,
      amount: 11.70,
      rate_source: 'Standard Rate Master',
    },
  ]);

  // Tab 2: Yarn Lines (For in-house manufactured fabric recipe)
  const [useYarnRecipe, setUseYarnRecipe] = useState(false);
  const [yarns, setYarns] = useState<any[]>([
    {
      _key: 'yarn_1',
      yarn_count_id: '1',
      yarn_count: '30s Combed',
      yarn_id: '1',
      yarn_name: '30s Combed Cotton Cone Yarn',
      composition: '100% Cotton',
      consumption: 0.23,
      wastage_pct: 3.0,
      rate: 285.00,
      amount: 67.51,
      rate_source: 'Approved Supplier Quote',
    },
  ]);

  // Tab 3: Trims Lines
  const [trims, setTrims] = useState<any[]>([
    {
      _key: 'trm_1',
      trim_id: '1',
      trim_code: 'TR-LBL-01',
      description: 'Woven Main Brand Label',
      size: '30x50mm',
      color: 'White/Black',
      consumption: 1.0,
      uom: 'Nos',
      wastage_pct: 3.0,
      rate: 1.20,
      amount: 1.24,
    },
    {
      _key: 'trm_2',
      trim_id: '2',
      trim_code: 'TR-CARE-01',
      description: 'Printed Satin Care / Wash Label',
      size: '25x60mm',
      color: 'White',
      consumption: 1.0,
      uom: 'Nos',
      wastage_pct: 3.0,
      rate: 0.75,
      amount: 0.77,
    },
    {
      _key: 'trm_3',
      trim_id: '3',
      trim_code: 'TR-THRD-01',
      description: 'Spun Poly Sewing Thread (Cones)',
      size: '40/2',
      color: 'Black',
      consumption: 0.015,
      uom: 'Cone',
      wastage_pct: 5.0,
      rate: 120.00,
      amount: 1.89,
    },
  ]);

  // Tab 4: Printing & Embroidery
  const [embellishments, setEmbellishments] = useState<any[]>([
    {
      _key: 'emb_1',
      type: 'PRINTING',
      method: 'Screen Print',
      artwork: 'Chest Logo 3-Colours',
      position: 'Front Chest',
      colors: 3,
      rate: 6.50,
      rate_source: 'Outsourced Printer Quote',
    },
  ]);

  // Tab 5: Process / Job Work
  const [processes, setProcesses] = useState<any[]>([
    {
      _key: 'prc_1',
      process_name: 'Bio-Washing & Softening',
      basis: 'Per Garment',
      rate: 4.50,
      rate_source: 'In-House Dyeing & Wash Unit',
    },
  ]);

  // Tab 7: Sewing SMV Operations
  const [sewingOps, setSewingOps] = useState<any[]>([
    { _key: 'op_1', operation: 'Shoulder Join', smv: 0.85 },
    { _key: 'op_2', operation: 'Rib Neck Attach', smv: 1.60 },
    { _key: 'op_3', operation: 'Neck Topstitch', smv: 1.20 },
    { _key: 'op_4', operation: 'Sleeve Attach', smv: 2.40 },
    { _key: 'op_5', operation: 'Side Seam Overlock', smv: 2.10 },
    { _key: 'op_6', operation: 'Sleeve & Bottom Hemming', smv: 2.85 },
    { _key: 'op_7', operation: 'Check & Trim Thread', smv: 1.50 },
  ]);

  // Tab 8: Packing Materials
  const [packings, setPackings] = useState<any[]>([
    { _key: 'pk_1', item: 'Printed Polybag with Warning', consumption: 1.0, rate: 0.85 },
    { _key: 'pk_2', item: 'Brand Hangtag & Kimble Tag', consumption: 1.0, rate: 1.20 },
    { _key: 'pk_3', item: '5-Ply Export Master Carton (60 Pcs/Box)', consumption: 0.0167, rate: 85.00 },
  ]);

  // Tab 9: Other Direct Charges
  const [otherCharges, setOtherCharges] = useState<any[]>([
    { _key: 'oth_1', charge_type: 'Lab Testing & Colour Fastness', rate_per_pc: 0.45 },
    { _key: 'oth_2', charge_type: 'Buyer Sample Couriers & Approvals', rate_per_pc: 0.35 },
  ]);

  // Load existing costing
  const costingQuery = useQuery({
    queryKey: ['pre-costings', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/costings/${id}`)).data,
    enabled: !isNew && !isNaN(Number(id)),
  });

  useEffect(() => {
    if (!costingQuery.data) return;
    const c = costingQuery.data;
    setCostId(c.id);
    setHead((prev) => ({
      ...prev,
      costing_no: c.costing_no || '',
      costing_date: toDateInput(c.costing_date) || today(),
      buyer_id: String(c.buyer_id || ''),
      buyer_name: c.buyer_name || '',
      season: c.season || 'AW-26',
      style_id: String(c.style_id || ''),
      style_code: c.style_code || '',
      style_name: c.style_name || '',
      buyer_ref: c.buyer_ref || 'RFQ-45821',
      order_qty: Number(c.order_qty) || 5000,
      currency_id: String(c.currency_id || '1'),
      currency_code: c.currency_code || 'INR',
      price_basis: c.price_basis || 'PER_PCS',
      version: Number(c.version) || 1,
      status: c.status_label || 'Draft',
      margin_pct: Number(c.margin_pct) || 15.0,
      remarks: c.remarks || '',
    }));

    if (c.data_json) {
      try {
        const parsed = typeof c.data_json === 'string' ? JSON.parse(c.data_json) : c.data_json;
        if (parsed.fabrics) setFabrics(parsed.fabrics);
        if (parsed.yarns) setYarns(parsed.yarns);
        if (parsed.trims) setTrims(parsed.trims);
        if (parsed.embellishments) setEmbellishments(parsed.embellishments);
        if (parsed.processes) setProcesses(parsed.processes);
        if (parsed.sewingOps) setSewingOps(parsed.sewingOps);
        if (parsed.packings) setPackings(parsed.packings);
        if (parsed.otherCharges) setOtherCharges(parsed.otherCharges);
        if (parsed.useYarnRecipe !== undefined) setUseYarnRecipe(parsed.useYarnRecipe);
      } catch (err) {
        // ignore
      }
    }
  }, [costingQuery.data]);

  // Load Style BOM & Rates
  const handleLoadStyleBOM = async (styleIdOverride?: string) => {
    const sId = styleIdOverride || head.style_id;
    if (!sId) {
      toast('Please select a Style first.', 'warning');
      return;
    }

    setLoadingBOM(true);
    try {
      const res = await http.get<{ data: any }>(`/pre-costings/style-data/${sId}`);
      const { style, bomLines } = res.data;

      setHead((h) => ({
        ...h,
        style_id: String(style.id),
        style_code: style.style_code,
        style_name: style.style_name,
        buyer_id: String(style.buyer_id || h.buyer_id),
        buyer_name: style.buyer_name || h.buyer_name,
        season: style.season || h.season,
        smv: Number(style.smv) || h.smv,
      }));

      // Map BOM lines into fabrics and trims
      const newFabrics: any[] = [];
      const newTrims: any[] = [];
      const newYarns: any[] = [];

      bomLines.forEach((l: any, idx: number) => {
        if (l.material_type === 'FABRIC') {
          const cons = Number(l.consumption) || 0.22;
          const wastage = Number(l.wastage_pct) || 5;
          const rate = Number(l.applied_rate) || Number(l.std_rate) || 420;
          newFabrics.push({
            _key: `fab_${idx}`,
            component: idx === 0 ? 'Body' : 'Collar / Neck',
            fabric_id: String(l.fabric_id),
            fabric_name: l.fabric_name,
            color: l.color_name || 'Assorted',
            size: l.size_code || 'All',
            consumption: cons,
            wastage_pct: wastage,
            rate: rate,
            amount: cons * (1 + wastage / 100) * rate,
            rate_source: l.rate_source || 'Style BOM',
          });
        } else if (l.material_type === 'TRIM') {
          const cons = Number(l.consumption) || 1;
          const wastage = Number(l.wastage_pct) || 3;
          const rate = Number(l.applied_rate) || Number(l.std_rate) || 1.5;
          newTrims.push({
            _key: `trm_${idx}`,
            trim_id: String(l.trim_id),
            trim_code: l.trim_code,
            description: l.trim_name,
            size: l.size_code || 'Standard',
            color: l.color_name || 'Standard',
            consumption: cons,
            uom: l.uom_code || 'Nos',
            wastage_pct: wastage,
            rate: rate,
            amount: cons * (1 + wastage / 100) * rate,
          });
        } else if (l.material_type === 'YARN') {
          const cons = Number(l.consumption) || 0.23;
          const rate = Number(l.applied_rate) || 285;
          newYarns.push({
            _key: `yrn_${idx}`,
            yarn_id: String(l.yarn_id),
            yarn_name: l.yarn_name,
            yarn_count: l.yarn_code || '30s Combed',
            composition: '100% Cotton',
            consumption: cons,
            wastage_pct: 3.0,
            rate: rate,
            amount: cons * 1.03 * rate,
            rate_source: l.rate_source || 'Style BOM',
          });
        }
      });

      if (newFabrics.length > 0) setFabrics(newFabrics);
      if (newTrims.length > 0) setTrims(newTrims);
      if (newYarns.length > 0) setYarns(newYarns);

      toast(`Loaded Style BOM and rates for ${style.style_code}`, 'success');
    } catch (err) {
      toast((err as ApiError).message || 'Failed to load Style BOM data', 'error');
    } finally {
      setLoadingBOM(false);
    }
  };

  // ------------------------------------------------------------- Calculations
  // 1. Fabric Cost
  const totalFabricCostPerPc = useMemo(() => {
    if (useYarnRecipe) return 0; // If using yarn recipe, fabric cost is derived from yarn + knitting + process
    return fabrics.reduce((s, f) => {
      const cons = Number(f.consumption) || 0;
      const wastage = Number(f.wastage_pct) || 0;
      const rate = Number(f.rate) || 0;
      return s + (cons * (1 + wastage / 100) * rate);
    }, 0);
  }, [fabrics, useYarnRecipe]);

  // 2. Yarn Recipe Cost
  const totalYarnCostPerPc = useMemo(() => {
    if (!useYarnRecipe) return 0;
    return yarns.reduce((s, y) => {
      const cons = Number(y.consumption) || 0;
      const wastage = Number(y.wastage_pct) || 0;
      const rate = Number(y.rate) || 0;
      return s + (cons * (1 + wastage / 100) * rate);
    }, 0);
  }, [yarns, useYarnRecipe]);

  // 3. Trims Cost
  const totalTrimsCostPerPc = useMemo(() => {
    return trims.reduce((s, t) => {
      const cons = Number(t.consumption) || 0;
      const wastage = Number(t.wastage_pct) || 0;
      const rate = Number(t.rate) || 0;
      return s + (cons * (1 + wastage / 100) * rate);
    }, 0);
  }, [trims]);

  // 4. Embellishments Cost
  const totalEmbellishmentPerPc = useMemo(() => {
    return embellishments.reduce((s, e) => s + (Number(e.rate) || 0), 0);
  }, [embellishments]);

  // 5. Process / Job Work Cost
  const totalProcessPerPc = useMemo(() => {
    return processes.reduce((s, p) => s + (Number(p.rate) || 0), 0);
  }, [processes]);

  // 6. Cutting Cost
  const cuttingCostPerPc = Number(head.cutting_cost) || 1.50;

  // 7. Sewing Cost (SMV Engine: Total SMV * Rate/Min)
  const totalSmv = useMemo(() => {
    return sewingOps.reduce((s, op) => s + (Number(op.smv) || 0), 0) || Number(head.smv) || 12.5;
  }, [sewingOps, head.smv]);

  const sewingCostPerPc = useMemo(() => {
    return totalSmv * (Number(head.smv_rate_per_min) || 0.85);
  }, [totalSmv, head.smv_rate_per_min]);

  // 8. Finishing & Packing Cost
  const finishingCostPerPc = Number(head.finishing_cost) || 1.50;
  const packingCostPerPc = useMemo(() => {
    return packings.reduce((s, pk) => s + (Number(pk.consumption) || 0) * (Number(pk.rate) || 0), 0);
  }, [packings]);

  // 9. Other Direct Charges
  const otherDirectPerPc = useMemo(() => {
    return otherCharges.reduce((s, ch) => s + (Number(ch.rate_per_pc) || 0), 0);
  }, [otherCharges]);

  // Total Direct Cost Per Piece
  const totalDirectCostPerPc = useMemo(() => {
    return (
      totalFabricCostPerPc +
      totalYarnCostPerPc +
      totalTrimsCostPerPc +
      totalEmbellishmentPerPc +
      totalProcessPerPc +
      cuttingCostPerPc +
      sewingCostPerPc +
      finishingCostPerPc +
      packingCostPerPc +
      otherDirectPerPc
    );
  }, [
    totalFabricCostPerPc,
    totalYarnCostPerPc,
    totalTrimsCostPerPc,
    totalEmbellishmentPerPc,
    totalProcessPerPc,
    cuttingCostPerPc,
    sewingCostPerPc,
    finishingCostPerPc,
    packingCostPerPc,
    otherDirectPerPc,
  ]);

  // Overhead Allocation
  const overheadCostPerPc = useMemo(() => {
    if (head.overhead_basis === 'PERCENT_DIRECT') {
      return (totalDirectCostPerPc * (Number(head.overhead_pct) || 5.0)) / 100;
    }
    return Number(head.overhead_rate) || 3.00;
  }, [totalDirectCostPerPc, head.overhead_basis, head.overhead_pct, head.overhead_rate]);

  // Total Pre-Cost Per Piece
  const totalCostPerPc = totalDirectCostPerPc + overheadCostPerPc;

  // Margin % vs Markup % & Quoted FOB Selling Price
  const marginPct = Number(head.margin_pct) || 15.0;
  const quotedFobPerPc = marginPct >= 100 ? totalCostPerPc : totalCostPerPc / (1 - marginPct / 100);
  const profitAmountPerPc = quotedFobPerPc - totalCostPerPc;
  const markupPct = totalCostPerPc > 0 ? (profitAmountPerPc / totalCostPerPc) * 100 : 0;

  // Order Totals
  const orderQty = Number(head.order_qty) || 5000;
  const totalOrderCost = totalCostPerPc * orderQty;
  const totalOrderFob = quotedFobPerPc * orderQty;
  const totalOrderProfit = profitAmountPerPc * orderQty;

  // Save Handler
  const handleSave = async (statusOverride = 'Draft') => {
    if (!head.style_id) {
      toast('Please select a Style.', 'warning');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        id: costId || undefined,
        costing_no: head.costing_no || undefined,
        costing_date: head.costing_date,
        version: head.version,
        style_id: Number(head.style_id),
        buyer_id: head.buyer_id ? Number(head.buyer_id) : undefined,
        season: head.season,
        buyer_ref: head.buyer_ref,
        unit_id: head.unit_id ? Number(head.unit_id) : 1,
        price_basis: head.price_basis,
        costing_type: 'PRE_COSTING',
        order_qty: orderQty,
        fabric_cost: totalFabricCostPerPc,
        yarn_cost: totalYarnCostPerPc,
        trim_cost: totalTrimsCostPerPc,
        printing_cost: totalEmbellishmentPerPc,
        washing_cost: totalProcessPerPc,
        cutting_cost: cuttingCostPerPc,
        stitching_cost: sewingCostPerPc,
        finishing_cost: finishingCostPerPc,
        packing_cost: packingCostPerPc,
        smv: totalSmv,
        smv_rate_per_min: head.smv_rate_per_min,
        overhead_cost: overheadCostPerPc,
        total_cost: totalCostPerPc,
        margin_pct: marginPct,
        fob_price: quotedFobPerPc,
        remarks: head.remarks,
        data_json: {
          fabrics,
          yarns,
          trims,
          embellishments,
          processes,
          sewingOps,
          packings,
          otherCharges,
          useYarnRecipe,
        },
      };

      const res = isNew
        ? await http.post<{ data: any }>('/costings', payload)
        : await http.put<{ data: any }>(`/costings/${costId}`, payload);

      const saved = res.data;
      setCostId(saved.id);
      setHead((h) => ({ ...h, costing_no: saved.costing_no, status: statusOverride }));
      toast(`Merchandiser Pre-Costing ${saved.costing_no} saved.`, 'success');
      qc.invalidateQueries({ queryKey: ['costings'] });
      qc.invalidateQueries({ queryKey: ['pre-costings'] });
      if (isNew) {
        nav(`/sales/pre-costings/${saved.id}`, { replace: true });
      }
    } catch (err) {
      toast((err as ApiError).message || 'Failed to save pre-costing', 'error');
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    'Fabric',
    'Yarn Recipe',
    'Trims',
    'Printing & Emb',
    'Processes',
    'Cutting',
    'Sewing (SMV)',
    'Finishing & Packing',
    'Other Direct',
    'Overhead',
    'Summary & FOB',
  ];

  return (
    <div className="space-y-4 pb-12">
      {/* 1. Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => nav('/sales/pre-costings')}
          >
            <ArrowLeft size={16} /> Back to List
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 font-mono">
                {head.costing_no || 'New Merchandiser Pre-Costing'}
              </h1>
              <span className="rounded bg-brand-50 border border-brand-200 px-2 py-0.5 text-xs font-bold text-brand-700 font-mono">
                v{head.version}
              </span>
              <StatusBadge value={head.status} />
            </div>
            <p className="text-xs text-slate-500">
              Style consumption & commercial FOB pricing engine
            </p>
          </div>
        </div>

        {/* Action Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm flex items-center gap-1.5"
            onClick={() => handleLoadStyleBOM()}
            disabled={loadingBOM || !head.style_id}
          >
            <RefreshCw size={14} className={loadingBOM ? 'animate-spin text-brand-600' : ''} />
            {loadingBOM ? 'Loading BOM…' : 'Load Style BOM & Rates'}
          </button>

          <button
            type="button"
            className="btn-primary btn-sm flex items-center gap-1.5"
            onClick={() => handleSave('Draft')}
            disabled={saving}
          >
            <Save size={14} /> Save Draft
          </button>

          {costId && (
            <button
              type="button"
              className="btn-success btn-sm flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
              onClick={() => handleSave('Approved')}
              disabled={saving}
            >
              <CheckCircle size={14} /> Approve Costing
            </button>
          )}
        </div>
      </div>

      {/* 2. Top Header Grid */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3.5">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Style Code *
            </label>
            <Select
              value={head.style_id}
              onChange={(e) => {
                const val = e.target.value;
                setHead((h) => ({ ...h, style_id: val }));
                if (val) handleLoadStyleBOM(val);
              }}
              options={toOptions(styles.data)}
              placeholder="Select Style…"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Buyer
            </label>
            <Select
              value={head.buyer_id}
              onChange={(e) => setHead((h) => ({ ...h, buyer_id: e.target.value }))}
              options={toOptions(buyers.data)}
              placeholder="Select Buyer…"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Season
            </label>
            <Input
              value={head.season}
              onChange={(e) => setHead((h) => ({ ...h, season: e.target.value }))}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Buyer Reference / RFQ
            </label>
            <Input
              value={head.buyer_ref}
              onChange={(e) => setHead((h) => ({ ...h, buyer_ref: e.target.value }))}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Order Quantity (PCS)
            </label>
            <Input
              type="number"
              value={head.order_qty}
              onChange={(e) => setHead((h) => ({ ...h, order_qty: Number(e.target.value) || 0 }))}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Currency
            </label>
            <Select
              value={head.currency_id}
              onChange={(e) => setHead((h) => ({ ...h, currency_id: e.target.value }))}
              options={toOptions(currencies.data)}
            />
          </div>
        </div>
      </div>

      {/* 3. Top Summary Banner */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Direct Cost / Pc</span>
          <p className="text-2xl font-black text-slate-800 font-mono mt-1">₹{fmtDecimal(totalDirectCostPerPc, 2)}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">Fabrics, Trims, CMT & Processes</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total Pre-Cost / Pc</span>
          <p className="text-2xl font-black text-slate-900 font-mono mt-1">₹{fmtDecimal(totalCostPerPc, 2)}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">Including ₹{fmtDecimal(overheadCostPerPc, 2)} Overhead</p>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5 shadow-xs">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-800">Target Margin</span>
            <span className="rounded bg-emerald-200 px-1.5 py-0.2 text-[11px] font-black text-emerald-900 font-mono">
              {markupPct.toFixed(1)}% Markup
            </span>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-black text-emerald-900 font-mono">{marginPct}%</span>
            <span className="text-xs font-semibold text-emerald-700 font-mono">(₹{fmtDecimal(profitAmountPerPc, 2)}/pc)</span>
          </div>
          <p className="text-[11px] text-emerald-800 font-medium mt-0.5">Commercial profit target</p>
        </div>

        <div className="rounded-xl border border-brand-300 bg-brand-50 p-3.5 shadow-xs">
          <span className="text-xs font-black uppercase tracking-wider text-brand-900">Quoted FOB Price / Pc</span>
          <p className="text-2xl font-black text-brand-900 font-mono mt-1">₹{fmtDecimal(quotedFobPerPc, 2)}</p>
          <p className="text-[11px] text-brand-800 font-bold mt-0.5">
            Total Order FOB: ₹{fmtDecimal(totalOrderFob, 0)}
          </p>
        </div>
      </div>

      {/* 4. Tab Navigation */}
      <div className="border-b border-slate-200">
        <nav className="flex flex-wrap gap-1" aria-label="Costing Tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 text-xs font-bold rounded-t-lg transition-colors ${
                activeTab === tab
                  ? 'border-b-2 border-brand-600 bg-brand-50/60 text-brand-900 font-black'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* 5. Tab Panels */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        {/* TAB 1: FABRICS */}
        {activeTab === 'Fabric' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Fabric Consumption & Costing</h3>
                <p className="text-xs text-slate-500">
                  Gross Qty = Consumption × (1 + Wastage %) × Order Qty
                </p>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useYarnRecipe}
                    onChange={(e) => setUseYarnRecipe(e.target.checked)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>Derive from In-House Yarn Recipe</span>
                </label>
                <button
                  type="button"
                  className="btn-secondary btn-xs flex items-center gap-1"
                  onClick={() => {
                    setFabrics([
                      ...fabrics,
                      {
                        _key: `fab_${Date.now()}`,
                        component: 'Body',
                        fabric_id: '',
                        fabric_name: 'Fabric Item',
                        color: 'Assorted',
                        size: 'All',
                        consumption: 0.20,
                        wastage_pct: 5,
                        rate: 420,
                        amount: 88.2,
                        rate_source: 'Manual Rate',
                      },
                    ]);
                  }}
                >
                  <Plus size={13} /> Add Fabric Line
                </button>
              </div>
            </div>

            {useYarnRecipe && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs text-amber-900">
                ⚠️ <strong>In-House Yarn Recipe Active:</strong> Fabric cost is calculated from Yarn + Knitting + Dyeing tabs without double counting.
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Component</th>
                    <th className="py-2.5 px-3">Fabric Description</th>
                    <th className="py-2.5 px-3">Color</th>
                    <th className="py-2.5 px-3 text-right">Cons/Pc (KG)</th>
                    <th className="py-2.5 px-3 text-right">Wastage %</th>
                    <th className="py-2.5 px-3 text-right">Gross Cons</th>
                    <th className="py-2.5 px-3 text-right">Rate / KG (₹)</th>
                    <th className="py-2.5 px-3 text-right">Cost / Pc (₹)</th>
                    <th className="py-2.5 px-3">Rate Source</th>
                    <th className="py-2.5 px-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {fabrics.map((f, i) => {
                    const gross = (Number(f.consumption) || 0) * (1 + (Number(f.wastage_pct) || 0) / 100);
                    const lineAmt = gross * (Number(f.rate) || 0);
                    return (
                      <tr key={f._key || i}>
                        <td className="py-2 px-3 font-sans font-semibold text-slate-800">{f.component}</td>
                        <td className="py-2 px-3 font-sans font-bold text-slate-900">{f.fabric_name}</td>
                        <td className="py-2 px-3 font-sans text-slate-600">{f.color}</td>
                        <td className="py-2 px-3 text-right">
                          <input
                            type="number"
                            step="0.001"
                            value={f.consumption}
                            onChange={(e) => {
                              const val = Number(e.target.value) || 0;
                              const updated = [...fabrics];
                              updated[i].consumption = val;
                              setFabrics(updated);
                            }}
                            className="w-20 rounded border border-slate-200 px-1.5 py-0.5 text-right font-mono text-xs"
                          />
                        </td>
                        <td className="py-2 px-3 text-right">
                          <input
                            type="number"
                            step="0.5"
                            value={f.wastage_pct}
                            onChange={(e) => {
                              const val = Number(e.target.value) || 0;
                              const updated = [...fabrics];
                              updated[i].wastage_pct = val;
                              setFabrics(updated);
                            }}
                            className="w-16 rounded border border-slate-200 px-1.5 py-0.5 text-right font-mono text-xs"
                          />
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-slate-700">{gross.toFixed(3)} kg</td>
                        <td className="py-2 px-3 text-right">
                          <input
                            type="number"
                            step="1"
                            value={f.rate}
                            onChange={(e) => {
                              const val = Number(e.target.value) || 0;
                              const updated = [...fabrics];
                              updated[i].rate = val;
                              setFabrics(updated);
                            }}
                            className="w-20 rounded border border-slate-200 px-1.5 py-0.5 text-right font-mono text-xs font-bold"
                          />
                        </td>
                        <td className="py-2 px-3 text-right font-black text-brand-900">₹{lineAmt.toFixed(2)}</td>
                        <td className="py-2 px-3 font-sans text-[11px] text-slate-500">{f.rate_source || 'Standard'}</td>
                        <td className="py-2 px-2 text-center">
                          <button
                            type="button"
                            className="text-slate-400 hover:text-rose-600"
                            onClick={() => setFabrics(fabrics.filter((_, idx) => idx !== i))}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 font-bold border-t border-slate-200">
                  <tr>
                    <td colSpan={7} className="py-2.5 px-3 text-right font-sans">Total Fabric Cost Per Piece:</td>
                    <td className="py-2.5 px-3 text-right text-brand-900 font-black">₹{totalFabricCostPerPc.toFixed(2)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* TAB 2: YARN RECIPE */}
        {activeTab === 'Yarn Recipe' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Yarn Recipe Breakdown (In-House Fabric)</h3>
                <p className="text-xs text-slate-500">
                  Derive spinning/knitting costs from Yarn Counts, Wastage % and Approved Supplier Quotes
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary btn-xs flex items-center gap-1"
                onClick={() => {
                  setYarns([
                    ...yarns,
                    {
                      _key: `yrn_${Date.now()}`,
                      yarn_count: '24s Combed',
                      yarn_name: 'Cotton Yarn',
                      composition: '100% Cotton',
                      consumption: 0.15,
                      wastage_pct: 3,
                      rate: 265,
                      amount: 40.94,
                    },
                  ]);
                }}
              >
                <Plus size={13} /> Add Yarn Line
              </button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Yarn Count</th>
                    <th className="py-2.5 px-3">Description</th>
                    <th className="py-2.5 px-3">Composition</th>
                    <th className="py-2.5 px-3 text-right">Cons / Pc (KG)</th>
                    <th className="py-2.5 px-3 text-right">Wastage %</th>
                    <th className="py-2.5 px-3 text-right">Rate / KG (₹)</th>
                    <th className="py-2.5 px-3 text-right">Cost / Pc (₹)</th>
                    <th className="py-2.5 px-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {yarns.map((y, i) => {
                    const gross = (Number(y.consumption) || 0) * (1 + (Number(y.wastage_pct) || 0) / 100);
                    const lineAmt = gross * (Number(y.rate) || 0);
                    return (
                      <tr key={y._key || i}>
                        <td className="py-2 px-3 font-sans font-bold text-brand-700">{y.yarn_count}</td>
                        <td className="py-2 px-3 font-sans text-slate-900">{y.yarn_name}</td>
                        <td className="py-2 px-3 font-sans text-slate-600">{y.composition}</td>
                        <td className="py-2 px-3 text-right">{y.consumption} kg</td>
                        <td className="py-2 px-3 text-right">{y.wastage_pct}%</td>
                        <td className="py-2 px-3 text-right font-bold">₹{y.rate}</td>
                        <td className="py-2 px-3 text-right font-black text-brand-900">₹{lineAmt.toFixed(2)}</td>
                        <td className="py-2 px-2 text-center">
                          <button
                            type="button"
                            className="text-slate-400 hover:text-rose-600"
                            onClick={() => setYarns(yarns.filter((_, idx) => idx !== i))}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 3: TRIMS */}
        {activeTab === 'Trims' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Trims & Accessories</h3>
                <p className="text-xs text-slate-500">Labels, Buttons, Zippers, Hangtags, Sewing Threads</p>
              </div>
              <button
                type="button"
                className="btn-secondary btn-xs flex items-center gap-1"
                onClick={() => {
                  setTrims([
                    ...trims,
                    {
                      _key: `trm_${Date.now()}`,
                      trim_code: 'TR-NEW',
                      description: 'New Trim Item',
                      size: 'Standard',
                      color: 'Black',
                      consumption: 1,
                      uom: 'Nos',
                      wastage_pct: 2,
                      rate: 1.5,
                      amount: 1.53,
                    },
                  ]);
                }}
              >
                <Plus size={13} /> Add Trim Line
              </button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Code</th>
                    <th className="py-2.5 px-3">Description</th>
                    <th className="py-2.5 px-3">UOM</th>
                    <th className="py-2.5 px-3 text-right">Cons / Pc</th>
                    <th className="py-2.5 px-3 text-right">Wastage %</th>
                    <th className="py-2.5 px-3 text-right">Rate (₹)</th>
                    <th className="py-2.5 px-3 text-right">Amount (₹)</th>
                    <th className="py-2.5 px-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {trims.map((t, i) => {
                    const gross = (Number(t.consumption) || 0) * (1 + (Number(t.wastage_pct) || 0) / 100);
                    const lineAmt = gross * (Number(t.rate) || 0);
                    return (
                      <tr key={t._key || i}>
                        <td className="py-2 px-3 font-bold text-brand-700">{t.trim_code}</td>
                        <td className="py-2 px-3 font-sans font-semibold text-slate-900">{t.description}</td>
                        <td className="py-2 px-3 font-sans text-slate-600">{t.uom}</td>
                        <td className="py-2 px-3 text-right">{t.consumption}</td>
                        <td className="py-2 px-3 text-right">{t.wastage_pct}%</td>
                        <td className="py-2 px-3 text-right font-bold">₹{t.rate}</td>
                        <td className="py-2 px-3 text-right font-black text-brand-900">₹{lineAmt.toFixed(2)}</td>
                        <td className="py-2 px-2 text-center">
                          <button
                            type="button"
                            className="text-slate-400 hover:text-rose-600"
                            onClick={() => setTrims(trims.filter((_, idx) => idx !== i))}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 font-bold border-t border-slate-200">
                  <tr>
                    <td colSpan={6} className="py-2.5 px-3 text-right font-sans">Total Trims Cost Per Piece:</td>
                    <td className="py-2.5 px-3 text-right text-brand-900 font-black">₹{totalTrimsCostPerPc.toFixed(2)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: PRINTING & EMBROIDERY */}
        {activeTab === 'Printing & Emb' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Printing & Embroidery Embellishments</h3>
                <p className="text-xs text-slate-500">Artwork, Screen/Rotary Printing, Multi-head Embroidery</p>
              </div>
              <button
                type="button"
                className="btn-secondary btn-xs flex items-center gap-1"
                onClick={() => {
                  setEmbellishments([
                    ...embellishments,
                    {
                      _key: `emb_${Date.now()}`,
                      type: 'PRINTING',
                      method: 'Chest Print',
                      artwork: 'New Design',
                      position: 'Chest',
                      colors: 2,
                      rate: 5.0,
                    },
                  ]);
                }}
              >
                <Plus size={13} /> Add Embellishment
              </button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3">Artwork / Description</th>
                    <th className="py-2.5 px-3">Position</th>
                    <th className="py-2.5 px-3 text-right">Rate / Pc (₹)</th>
                    <th className="py-2.5 px-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {embellishments.map((e, i) => (
                    <tr key={e._key || i}>
                      <td className="py-2 px-3 font-sans font-bold text-brand-700">{e.type}</td>
                      <td className="py-2 px-3 font-sans text-slate-900">{e.artwork}</td>
                      <td className="py-2 px-3 font-sans text-slate-600">{e.position}</td>
                      <td className="py-2 px-3 text-right font-black text-slate-900">₹{fmtDecimal(e.rate, 2)}</td>
                      <td className="py-2 px-2 text-center">
                        <button
                          type="button"
                          className="text-slate-400 hover:text-rose-600"
                          onClick={() => setEmbellishments(embellishments.filter((_, idx) => idx !== i))}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 7: SEWING (SMV ENGINE) */}
        {activeTab === 'Sewing (SMV)' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-indigo-50 border border-indigo-200">
              <div>
                <h3 className="text-sm font-bold text-indigo-950">SMV-Based Sewing Cost Engine</h3>
                <p className="text-xs text-indigo-800 font-mono">
                  Sewing Cost = Total SMV ({totalSmv.toFixed(2)} mins) × Rate/Min (₹{head.smv_rate_per_min}) = <strong className="text-brand-900 font-black">₹{sewingCostPerPc.toFixed(2)} / Pc</strong>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-indigo-900">Rate / Minute (₹):</span>
                <input
                  type="number"
                  step="0.05"
                  value={head.smv_rate_per_min}
                  onChange={(e) => setHead((h) => ({ ...h, smv_rate_per_min: Number(e.target.value) || 0 }))}
                  className="w-20 rounded border border-indigo-300 px-2 py-1 text-right font-mono text-xs font-bold"
                />
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">#</th>
                    <th className="py-2.5 px-3">Operation Description</th>
                    <th className="py-2.5 px-3 text-right">Standard Minute Value (SMV)</th>
                    <th className="py-2.5 px-3 text-right">Cost @ ₹{head.smv_rate_per_min}/Min</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sewingOps.map((op, i) => {
                    const opCost = (Number(op.smv) || 0) * (Number(head.smv_rate_per_min) || 0.85);
                    return (
                      <tr key={op._key || i}>
                        <td className="py-2 px-3 text-slate-400">{i + 1}</td>
                        <td className="py-2 px-3 font-sans font-semibold text-slate-900">{op.operation}</td>
                        <td className="py-2 px-3 text-right font-bold text-brand-700">{op.smv} mins</td>
                        <td className="py-2 px-3 text-right font-bold text-slate-800">₹{opCost.toFixed(3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 font-bold border-t border-slate-200">
                  <tr>
                    <td colSpan={2} className="py-2.5 px-3 font-sans">Total Sewing SMV:</td>
                    <td className="py-2.5 px-3 text-right text-brand-700 font-black">{totalSmv.toFixed(2)} mins</td>
                    <td className="py-2.5 px-3 text-right text-brand-900 font-black">₹{sewingCostPerPc.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* TAB 11: SUMMARY & FOB */}
        {activeTab === 'Summary & FOB' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Pre-Costing Summary & FOB Calculation</h3>
              <p className="text-xs text-slate-500">
                Direct Cost + Allocated Overhead + Commercial Margin = Final Quoted FOB Price
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Cost Head Table */}
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3">Cost Element</th>
                      <th className="py-2.5 px-3 text-right">Cost / Pc (₹)</th>
                      <th className="py-2.5 px-3 text-right">Share %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">1. Fabric Materials</td>
                      <td className="py-2 px-3 text-right font-bold">₹{totalFabricCostPerPc.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? ((totalFabricCostPerPc / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">2. Trims & Accessories</td>
                      <td className="py-2 px-3 text-right font-bold">₹{totalTrimsCostPerPc.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? ((totalTrimsCostPerPc / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">3. Cutting Labour & CAD</td>
                      <td className="py-2 px-3 text-right font-bold">₹{cuttingCostPerPc.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? ((cuttingCostPerPc / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">4. Sewing (SMV Engine)</td>
                      <td className="py-2 px-3 text-right font-bold text-brand-700">₹{sewingCostPerPc.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? ((sewingCostPerPc / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">5. Embellishments (Printing)</td>
                      <td className="py-2 px-3 text-right font-bold">₹{totalEmbellishmentPerPc.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? ((totalEmbellishmentPerPc / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">6. Washing / Special Process</td>
                      <td className="py-2 px-3 text-right font-bold">₹{totalProcessPerPc.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? ((totalProcessPerPc / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">7. Finishing & Packaging</td>
                      <td className="py-2 px-3 text-right font-bold">₹{(finishingCostPerPc + packingCostPerPc).toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? (((finishingCostPerPc + packingCostPerPc) / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">8. Other Direct Charges</td>
                      <td className="py-2 px-3 text-right font-bold">₹{otherDirectPerPc.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? ((otherDirectPerPc / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2 px-3 font-sans font-semibold text-slate-900">9. Factory Overhead</td>
                      <td className="py-2 px-3 text-right font-bold">₹{overheadCostPerPc.toFixed(2)}</td>
                      <td className="py-2 px-3 text-right text-slate-500">
                        {totalCostPerPc > 0 ? ((overheadCostPerPc / totalCostPerPc) * 100).toFixed(1) : 0}%
                      </td>
                    </tr>
                  </tbody>
                  <tfoot className="bg-slate-50 font-mono font-black border-t-2 border-slate-300">
                    <tr>
                      <td className="py-3 px-3 font-sans text-sm">TOTAL PRE-COST</td>
                      <td className="py-3 px-3 text-right text-sm text-brand-900">₹{totalCostPerPc.toFixed(2)}</td>
                      <td className="py-3 px-3 text-right text-sm">100.0%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Commercial Margin & Selling Price Box */}
              <div className="rounded-xl border border-brand-200 bg-brand-50/30 p-4 space-y-4">
                <h4 className="font-bold text-sm text-brand-950">Commercial Pricing & FOB Build-Up</h4>

                <div className="space-y-3 font-mono text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-sans text-slate-700">Cost Price Basis (Per Piece):</span>
                    <strong className="text-slate-900 text-sm">₹{totalCostPerPc.toFixed(2)}</strong>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="font-sans text-slate-700">Target Profit Margin %:</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        step="0.5"
                        value={head.margin_pct}
                        onChange={(e) => setHead((h) => ({ ...h, margin_pct: Number(e.target.value) || 0 }))}
                        className="w-16 rounded border border-brand-300 px-1.5 py-0.5 text-right font-bold text-xs text-brand-900"
                      />
                      <span>%</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="font-sans text-slate-700">Equivalent Markup on Cost:</span>
                    <strong className="text-emerald-700">{markupPct.toFixed(2)}%</strong>
                  </div>

                  <div className="flex items-center justify-between border-t border-brand-200 pt-2">
                    <span className="font-sans text-slate-700">Profit Amount Per Piece:</span>
                    <strong className="text-emerald-800 text-sm">₹{profitAmountPerPc.toFixed(2)}</strong>
                  </div>

                  <div className="flex items-center justify-between border-t-2 border-brand-400 pt-3 text-brand-950">
                    <span className="font-sans font-bold text-sm">Quoted FOB Selling Price / Pc:</span>
                    <strong className="text-xl font-black text-brand-900">₹{quotedFobPerPc.toFixed(2)}</strong>
                  </div>

                  <div className="rounded-lg bg-white border border-brand-200 p-3 mt-4 space-y-1.5 font-mono">
                    <div className="flex justify-between text-slate-600">
                      <span>Order Quantity:</span>
                      <strong>{fmtNumber(orderQty)} PCS</strong>
                    </div>
                    <div className="flex justify-between text-slate-600">
                      <span>Total Estimated Production Cost:</span>
                      <strong>₹{fmtDecimal(totalOrderCost, 0)}</strong>
                    </div>
                    <div className="flex justify-between text-emerald-700 font-bold">
                      <span>Total Commercial Profit:</span>
                      <strong>₹{fmtDecimal(totalOrderProfit, 0)}</strong>
                    </div>
                    <div className="flex justify-between text-brand-900 font-black text-sm border-t border-slate-200 pt-1.5">
                      <span>Total Quoted FOB Order Value:</span>
                      <span>₹{fmtDecimal(totalOrderFob, 0)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Other Tabs (Cutting, Finishing, Other Direct, Overhead) fallback display */}
        {['Cutting', 'Finishing & Packing', 'Processes', 'Other Direct', 'Overhead'].includes(activeTab) && (
          <div className="p-4 text-xs text-slate-600 space-y-2">
            <h3 className="text-sm font-bold text-slate-900">{activeTab} Details</h3>
            <p className="text-slate-500">
              Configure parameters and rates for {activeTab}. Values roll directly into the Summary & FOB Pricing engine.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
