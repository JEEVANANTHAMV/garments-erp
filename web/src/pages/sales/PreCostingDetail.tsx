import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, RefreshCw, CheckCircle,
  Plus, Trash2
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, useStatuses, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, StatusBadge } from '../../components/ui';
import { fmtDecimal, fmtNumber, today, toDateInput } from '../../lib/format';
import { FabricPicker } from './CostingsFabricPicker';
import { PreCostingRowTable } from './PreCostingRowTable';
import {
  computePreCosting, finishingRows, otherDirectRows, processHead, processAmount,
  PRE_COST_HEADS, type PreCostHeadKey,
} from '../../lib/preCostingCalc';

const PROCESS_TYPE_OPTIONS = [
  { value: 'KNITTING', label: 'Knitting → Knitting' },
  { value: 'DYEING', label: 'Dyeing → Dyeing' },
  { value: 'COMPACTING', label: 'Compacting → Dyeing' },
  { value: 'WASHING', label: 'Washing → Washing' },
  { value: 'OTHER', label: 'Other → Washing / Other' },
];
const PROCESS_BASIS_OPTIONS = [
  { value: 'PER_KG', label: 'Per KG' },
  { value: 'PER_PC', label: 'Per PC' },
];
const FINISH_TYPE_OPTIONS = [
  { value: 'FINISHING', label: 'Finishing' },
  { value: 'PACKING', label: 'Packing' },
];
const OTHER_TYPE_OPTIONS = [
  { value: 'TESTING', label: 'Testing' },
  { value: 'FREIGHT', label: 'Freight / Courier' },
  { value: 'AGENT_COMMISSION', label: 'Agent Commission' },
  { value: 'FINANCE', label: 'Finance / Bank' },
  { value: 'OTHER', label: 'Other' },
];
const OTHER_BASIS_OPTIONS = [
  { value: 'PER_PC', label: '₹ per PC' },
  { value: 'PCT_FOB', label: '% of FOB' },
  { value: 'PCT_DIRECT', label: '% of Direct' },
];

/** Process type for a row saved before the type column existed. */
const inferProcessType = (row: any) => {
  const h = processHead(row);
  if (h === 'knitting_cost') return 'KNITTING';
  if (h === 'dyeing_cost') return /COMPACT/i.test(String(row?.process_name ?? '')) ? 'COMPACTING' : 'DYEING';
  return /WASH/i.test(String(row?.process_name ?? '')) ? 'WASHING' : 'OTHER';
};
const normalizeProcess = (row: any, i: number) => {
  const b = String(row?.basis ?? '').toUpperCase().replace(/[\s-]/g, '_');
  return {
    _key: row?._key || `prc_${i}`,
    process_name: row?.process_name ?? '',
    process_type: row?.process_type || inferProcessType(row),
    basis: b === 'PER_KG' || b === 'KG' ? 'PER_KG' : 'PER_PC',
    consumption: row?.consumption ?? '',
    rate: row?.rate ?? '',
    rate_source: row?.rate_source,
  };
};

export default function PreCostingDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new' || isNaN(Number(id));
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [saving, setSaving] = useState(false);
  const [loadingBOM, setLoadingBOM] = useState(false);
  const [activeTab, setActiveTab] = useState('Fabric');

  // Merchandiser Flat Sewing Rate Mode (vs Detailed Operations)
  const [useFlatSewingRate, setUseFlatSewingRate] = useState(true);
  const [flatSewingRate, setFlatSewingRate] = useState(20.00);
  const [flatSewingDesc, setFlatSewingDesc] = useState('Garment Stitching to Ironing Complete');

  // Lookups
  const styles = useLookup('styles');
  const buyers = useLookup('buyers');
  const currencies = useLookup('currencies');
  const fabricMaster = useLookup('fabrics');
  const costingStatuses = useStatuses('COSTING');
  // Keys of data_json this screen does not own (e.g. the Classic sheet's `classic` block)
  // are kept so saving here never wipes them.
  const extraJsonRef = useRef<Record<string, unknown>>({});

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
    smv: 12.5,
    smv_rate_per_min: 0.85,
    remarks: '',
  });
  // Stored head values of a loaded sheet: kept for a tab its data_json never had.
  const [storedHeads, setStoredHeads] = useState<Partial<Record<PreCostHeadKey, number>>>({});

  // Tab 1: Fabric Lines
  const [fabrics, setFabrics] = useState<any[]>([
    {
      _key: 'fab_1',
      component: 'Body',
      fabric_id: '1',
      fabric_name: 'Single Jersey 180 GSM',
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
      fabric_id: '4',
      fabric_name: 'Rib 1x1 200 GSM',
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

  // Tab 5: Processes (knitting / dyeing / compacting / washing — per KG or per PC)
  const [processes, setProcesses] = useState<any[]>([
    { _key: 'prc_1', process_name: 'Bio-Washing & Softening', process_type: 'WASHING', basis: 'PER_PC', consumption: '', rate: 4.50 },
  ]);

  // Tab 6: Cutting operations (₹ / pc)
  const [cuttingOps, setCuttingOps] = useState<any[]>([
    { _key: 'cut_1', operation: 'Spreading', rate: 0.40 },
    { _key: 'cut_2', operation: 'Cutting', rate: 0.70 },
    { _key: 'cut_3', operation: 'Numbering / Bundling', rate: 0.40 },
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

  // Tab 8: Finishing & Packing items (qty / pc × rate, each row Finishing or Packing)
  const [finishingItems, setFinishingItems] = useState<any[]>([
    { _key: 'fin_1', item: 'Thread Cutting', cost_type: 'FINISHING', qty_per_pc: 1, rate: 0.30 },
    { _key: 'fin_2', item: 'Checking', cost_type: 'FINISHING', qty_per_pc: 1, rate: 0.40 },
    { _key: 'fin_3', item: 'Ironing', cost_type: 'FINISHING', qty_per_pc: 1, rate: 0.80 },
    { _key: 'fin_4', item: 'Folding', cost_type: 'PACKING', qty_per_pc: 1, rate: 0.25 },
    { _key: 'fin_5', item: 'Printed Polybag with Warning', cost_type: 'PACKING', qty_per_pc: 1, rate: 0.85 },
    { _key: 'fin_6', item: 'Brand Hangtag & Kimble Tag', cost_type: 'PACKING', qty_per_pc: 1, rate: 1.20 },
    { _key: 'fin_7', item: '5-Ply Export Master Carton (60 Pcs/Box)', cost_type: 'PACKING', qty_per_pc: 0.0167, rate: 85.00 },
  ]);

  // Tab 9: Other Direct Charges (₹/pc, % of FOB or % of direct cost)
  const [otherDirect, setOtherDirect] = useState<any[]>([
    { _key: 'oth_1', charge_type: 'TESTING', description: 'Lab Testing & Colour Fastness', basis: 'PER_PC', value: 0.45 },
    { _key: 'oth_2', charge_type: 'FREIGHT', description: 'Buyer Sample Couriers & Approvals', basis: 'PER_PC', value: 0.35 },
  ]);

  // Tab 10: Overhead
  const [overhead, setOverhead] = useState<{ basis: string; rate: number | ''; pct: number | '' }>({
    basis: 'PER_PIECE', rate: 3.00, pct: 5.0,
  });

  const addSewingOp = () => {
    const key = `op_${Date.now()}`;
    setSewingOps((prev) => [...prev, { _key: key, operation: '', smv: '' }]);
    setTimeout(() => {
      const els = document.querySelectorAll<HTMLInputElement>('input[data-smv-op]');
      els[els.length - 1]?.focus();
    }, 0);
  };

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
      margin_pct: c.margin_pct != null ? Number(c.margin_pct) : 15.0,
      smv: c.smv != null ? Number(c.smv) : prev.smv,
      smv_rate_per_min: c.smv_rate_per_min != null ? Number(c.smv_rate_per_min) : prev.smv_rate_per_min,
      remarks: c.remarks || '',
    }));
    const stored: Partial<Record<PreCostHeadKey, number>> = {};
    for (const h of PRE_COST_HEADS) stored[h] = Number(c[h]) || 0;
    setStoredHeads(stored);

    let parsed: any = {};
    if (c.data_json) {
      try {
        parsed = typeof c.data_json === 'string' ? JSON.parse(c.data_json) : c.data_json;
      } catch {
        parsed = {};
      }
    }
    if (!parsed || typeof parsed !== 'object') parsed = {};
    extraJsonRef.current = { ...parsed };
    if (parsed.fabrics) setFabrics(parsed.fabrics);
    if (parsed.yarns) setYarns(parsed.yarns);
    if (parsed.trims) setTrims(parsed.trims);
    if (parsed.embellishments) setEmbellishments(parsed.embellishments);
    if (parsed.sewingOps) setSewingOps(parsed.sewingOps);
    if (parsed.useYarnRecipe !== undefined) setUseYarnRecipe(parsed.useYarnRecipe);
    if (parsed.useFlatSewingRate !== undefined) setUseFlatSewingRate(parsed.useFlatSewingRate);
    if (parsed.flatSewingRate !== undefined) setFlatSewingRate(Number(parsed.flatSewingRate) || 0);
    if (parsed.flatSewingDesc !== undefined) setFlatSewingDesc(parsed.flatSewingDesc);

    // Tabs added later: a sheet saved before them gets its stored head as one row,
    // so the first save keeps the same figure.
    const carried = (label: string, amount: number) => (amount > 0 ? [{ label, amount }] : []);
    setProcesses(Array.isArray(parsed.processes)
      ? parsed.processes.map(normalizeProcess)
      : [
          ...carried('Knitting (earlier sheet)', stored.knitting_cost ?? 0).map((x) => ({ process_name: x.label, process_type: 'KNITTING', rate: x.amount })),
          ...carried('Dyeing (earlier sheet)', stored.dyeing_cost ?? 0).map((x) => ({ process_name: x.label, process_type: 'DYEING', rate: x.amount })),
          ...carried('Washing / process (earlier sheet)', stored.washing_cost ?? 0).map((x) => ({ process_name: x.label, process_type: 'WASHING', rate: x.amount })),
        ].map(normalizeProcess));
    setCuttingOps(Array.isArray(parsed.cuttingOps)
      ? parsed.cuttingOps
      : carried('Cutting (earlier sheet)', stored.cutting_cost ?? 0).map((x, i) => ({ _key: `cut_${i}`, operation: x.label, rate: x.amount })));
    const fin = finishingRows(parsed).map((r: any, i: number) => ({ _key: r._key || `fin_${i}`, ...r }));
    if (!Array.isArray(parsed.finishingItems)) {
      if ((stored.finishing_cost ?? 0) > 0) fin.unshift({ _key: 'fin_old', item: 'Finishing (earlier sheet)', cost_type: 'FINISHING', qty_per_pc: 1, rate: stored.finishing_cost });
      if (!Array.isArray(parsed.packings) && (stored.packing_cost ?? 0) > 0) fin.push({ _key: 'pk_old', item: 'Packing (earlier sheet)', cost_type: 'PACKING', qty_per_pc: 1, rate: stored.packing_cost });
    }
    setFinishingItems(fin);
    const oth = otherDirectRows(parsed).map((r: any, i: number) => ({ _key: r._key || `oth_${i}`, ...r }));
    if (!Array.isArray(parsed.otherDirect) && !Array.isArray(parsed.otherCharges)) {
      const old: [PreCostHeadKey, string, string][] = [
        ['testing_cost', 'TESTING', 'Testing (earlier sheet)'], ['freight_cost', 'FREIGHT', 'Freight (earlier sheet)'],
        ['agent_commission', 'AGENT_COMMISSION', 'Agent commission (earlier sheet)'], ['finance_cost', 'FINANCE', 'Finance (earlier sheet)'],
        ['other_direct_cost', 'OTHER', 'Other (earlier sheet)'],
      ];
      for (const [h, t, d] of old) if ((stored[h] ?? 0) > 0) oth.push({ _key: `oth_${h}`, charge_type: t, description: d, basis: 'PER_PC', value: stored[h] });
    }
    setOtherDirect(oth);
    setOverhead(parsed.overhead && typeof parsed.overhead === 'object'
      ? { basis: parsed.overhead.basis === 'PERCENT_DIRECT' ? 'PERCENT_DIRECT' : 'PER_PIECE', rate: parsed.overhead.rate ?? '', pct: parsed.overhead.pct ?? '' }
      : { basis: 'PER_PIECE', rate: stored.overhead_cost ?? 0, pct: 5.0 });
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

      // BOM consumption → per garment (like the BOM screen / MRP): ÷ 12 per dozen, fixed + additional qty
      // spread over the costing order qty, size- / colour-wise lines weighted by their share of the sizes / colours
      const oq = Math.max(1, Number(head.order_qty) || 1);
      const groupOf = (l: any) => `${l.material_type}|${l.fabric_id ?? l.yarn_id ?? l.trim_id ?? l.item_description ?? ''}`;
      const sizesIn = new Map<string, Set<number>>(), colorsIn = new Map<string, Set<number>>();
      bomLines.forEach((l: any) => {
        if (l.size_id) { const k = groupOf(l); sizesIn.set(k, (sizesIn.get(k) ?? new Set()).add(Number(l.size_id))); }
        if (l.color_id) { const k = groupOf(l); colorsIn.set(k, (colorsIn.get(k) ?? new Set()).add(Number(l.color_id))); }
      });
      const perGarment = (l: any) => {
        const c = Number(l.consumption) || 0, addl = Number(l.additional_qty) || 0;
        const basis = String(l.consumption_basis || 'PER_PIECE');
        let share = 1;
        if (l.size_id) share /= Math.max(1, sizesIn.get(groupOf(l))?.size ?? 1);
        if (l.color_id) share /= Math.max(1, colorsIn.get(groupOf(l))?.size ?? 1);
        const base = basis === 'PER_DOZEN' ? c / 12 : basis === 'FIXED_QTY' ? c / oq : c;
        return Number(((base + addl / oq) * share).toFixed(6));
      };
      bomLines.forEach((l: any, idx: number) => {
        if (l.material_type === 'FABRIC') {
          const cons = perGarment(l) || 0.22;
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
          const cons = perGarment(l) || 1;
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
          const cons = perGarment(l) || 0.23;
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
  // The sheet as stored in data_json; the server recomputes every head from it on save.
  const sheetJson = useMemo(() => ({
    // Keys owned by other screens are kept; older-shape keys are replaced by their new tabs.
    ...Object.fromEntries(Object.entries(extraJsonRef.current).filter(([k]) => k !== 'packings' && k !== 'otherCharges')),
    fabrics,
    yarns,
    trims,
    embellishments,
    processes,
    cuttingOps,
    sewingOps,
    finishingItems,
    otherDirect,
    overhead,
    useYarnRecipe,
    useFlatSewingRate,
    flatSewingRate,
    flatSewingDesc,
  }), [fabrics, yarns, trims, embellishments, processes, cuttingOps, sewingOps, finishingItems,
    otherDirect, overhead, useYarnRecipe, useFlatSewingRate, flatSewingRate, flatSewingDesc]);

  // Same function as the server (lib/preCostingCalc mirrors server/src/modules/costing/preCostingCalc).
  const calc = useMemo(() => computePreCosting(sheetJson, {
    margin_pct: head.margin_pct,
    smv_rate_per_min: head.smv_rate_per_min,
    fallback: { ...storedHeads, smv: head.smv },
  }), [sheetJson, head.margin_pct, head.smv_rate_per_min, head.smv, storedHeads]);
  const H = calc.heads;

  const totalFabricCostPerPc = H.fabric_cost;
  const totalYarnCostPerPc = H.yarn_cost;
  const totalTrimsCostPerPc = H.trim_cost;
  const totalProcessPerPc = H.knitting_cost + H.dyeing_cost + H.washing_cost;
  const cuttingCostPerPc = H.cutting_cost;
  const totalSmv = calc.smv;
  const sewingCostPerPc = H.stitching_cost;
  const finishingCostPerPc = H.finishing_cost;
  const packingCostPerPc = H.packing_cost;
  const otherDirectPerPc = H.testing_cost + H.freight_cost + H.agent_commission + H.finance_cost + H.other_direct_cost;
  const totalDirectCostPerPc = calc.direct_cost;
  const overheadCostPerPc = calc.overhead_cost;
  const totalCostPerPc = calc.total_cost;
  const marginPct = Number(head.margin_pct) || 0;
  const quotedFobPerPc = calc.fob_price;
  const profitAmountPerPc = calc.profit_per_pc;
  const markupPct = calc.markup_pct;

  // Order Totals
  const orderQty = Number(head.order_qty) || 0;
  const totalOrderCost = totalCostPerPc * orderQty;
  const totalOrderFob = quotedFobPerPc * orderQty;
  const totalOrderProfit = profitAmountPerPc * orderQty;

  /** Per-piece amount of an Other Direct row (PCT_FOB on the computed FOB). */
  const otherRowAmount = (r: any) => {
    const v = Number(r.value) || 0;
    if (r.basis === 'PCT_FOB') return calc.error ? 0 : (quotedFobPerPc * v) / 100;
    if (r.basis === 'PCT_DIRECT') return (calc.manufacturing_direct * v) / 100;
    return v;
  };

  // Save Handler
  const handleSave = async (statusOverride = 'Draft') => {
    if (!head.style_id) {
      toast('Please select a Style.', 'warning');
      return;
    }

    if (calc.error) {
      toast(calc.error, 'warning');
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
        currency_id: head.currency_id ? Number(head.currency_id) : 1,
        status_id: costingStatuses.data?.find((st) => String(st.code).toUpperCase() === statusOverride.toUpperCase())?.id ?? undefined,
        season: head.season,
        buyer_ref: head.buyer_ref,
        unit_id: head.unit_id ? Number(head.unit_id) : 1,
        price_basis: head.price_basis,
        costing_type: 'PRE_COSTING',
        order_qty: orderQty,
        // Heads / totals are for reference only: the server recomputes all of them from data_json.
        ...calc.heads,
        smv: totalSmv,
        smv_rate_per_min: head.smv_rate_per_min,
        total_cost: totalCostPerPc,
        margin_pct: marginPct,
        fob_price: quotedFobPerPc,
        remarks: head.remarks,
        // The generic /costings resource stores data_json as TEXT, so send a string.
        data_json: JSON.stringify(sheetJson),
      };

      const isActuallyNew = isNew || !costId || isNaN(Number(costId));
      const res = isActuallyNew
        ? await http.post<{ data: any }>('/costings', payload)
        : await http.put<{ data: any }>(`/costings/${costId}`, payload);

      const saved = res.data;
      setCostId(saved.id);
      setHead((h) => ({ ...h, costing_no: saved.costing_no, status: statusOverride }));
      const stored: Partial<Record<PreCostHeadKey, number>> = {};
      for (const h of PRE_COST_HEADS) stored[h] = Number(saved[h]) || 0;
      setStoredHeads(stored);
      toast(`Merchandiser Pre-Costing ${saved.costing_no} saved.`, 'success');
      qc.invalidateQueries({ queryKey: ['costings'] });
      qc.invalidateQueries({ queryKey: ['pre-costings'] });
      if (isActuallyNew) {
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

      {calc.error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs font-semibold text-rose-800">
          {calc.error} — reduce the margin or the % of FOB charges (Other Direct) before saving.
        </div>
      )}

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
                        fabric_name: '',
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
                        <td className="py-2 px-3 font-sans font-bold text-slate-900 min-w-[220px]">
                          <FabricPicker
                            fabricId={f.fabric_id}
                            fabricName={f.fabric_name}
                            options={fabricMaster.data}
                            onPick={(m) => {
                              const stdRate = Number(m.std_rate) || 0;
                              setFabrics((prev) => prev.map((row, idx) => idx === i ? {
                                ...row,
                                fabric_id: String(m.id),
                                fabric_name: m.label,
                                rate: stdRate > 0 ? stdRate : row.rate,
                                rate_source: stdRate > 0 ? 'Fabric Master Std Rate' : row.rate_source,
                              } : row));
                            }}
                          />
                        </td>
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
            {/* Mode Selector */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-indigo-50 border border-indigo-200">
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-indigo-950 uppercase tracking-wider">Sewing Cost Mode:</span>
                <div className="inline-flex rounded-md shadow-sm">
                  <button
                    type="button"
                    onClick={() => setUseFlatSewingRate(true)}
                    className={`px-3 py-1.5 text-xs font-bold rounded-l-md transition-all ${
                      useFlatSewingRate
                        ? 'bg-brand-800 text-white shadow'
                        : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                    }`}
                  >
                    👔 Merchandiser Flat Rate (₹/pc)
                  </button>
                  <button
                    type="button"
                    onClick={() => setUseFlatSewingRate(false)}
                    className={`px-3 py-1.5 text-xs font-bold rounded-r-md transition-all ${
                      !useFlatSewingRate
                        ? 'bg-brand-800 text-white shadow'
                        : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                    }`}
                  >
                    ⚙️ Detailed SMV Operations
                  </button>
                </div>
              </div>
              <span className="font-mono font-black text-sm text-brand-950 bg-white border border-indigo-200 px-3 py-1 rounded-md">
                Sewing Cost: ₹{sewingCostPerPc.toFixed(2)} / Pc
              </span>
            </div>

            {/* Flat Rate View */}
            {useFlatSewingRate ? (
              <div className="p-4 bg-white rounded-lg border border-slate-200 shadow-sm space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="label text-xs font-bold text-slate-800">Flat Sewing & Ironing Rate (₹ / Piece) *</label>
                    <input
                      type="number"
                      step="0.50"
                      value={flatSewingRate}
                      onChange={(e) => setFlatSewingRate(parseFloat(e.target.value) || 0)}
                      className="input font-mono font-black text-base text-brand-800 w-full"
                      placeholder="20.00"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      Standard merchant rate covering stitching, trimming, checking, and ironing.
                    </p>
                  </div>
                  <div>
                    <label className="label text-xs font-bold text-slate-800">Description / Operations Covered</label>
                    <input
                      type="text"
                      value={flatSewingDesc}
                      onChange={(e) => setFlatSewingDesc(e.target.value)}
                      className="input text-xs w-full"
                      placeholder="e.g. Stitching to Ironing Complete"
                    />
                  </div>
                </div>
                <div className="p-2.5 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  💡 <strong>Merchandiser Note:</strong> Using flat rate simplifies costing quotation without having to calculate individual SMVs for shoulder join, neck attach, sleeve hemming, etc.
                </div>
              </div>
            ) : (
              /* Detailed SMV View */
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-200 text-xs">
                  <span>SMV Calculation: Total SMV ({totalSmv.toFixed(2)} mins) × Rate/Min</span>
                  <div className="flex items-center gap-2">
                    <span className="font-bold">Rate / Min (₹):</span>
                    <input
                      type="number"
                      step="0.05"
                      value={head.smv_rate_per_min}
                      onChange={(e) => setHead((h) => ({ ...h, smv_rate_per_min: Number(e.target.value) || 0 }))}
                      className="w-20 rounded border border-slate-300 px-2 py-1 text-right font-mono font-bold"
                    />
                  </div>
                </div>
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">#</th>
                    <th className="py-2.5 px-3">Operation Description</th>
                    <th className="py-2.5 px-3 text-right">Standard Minute Value (SMV)</th>
                    <th className="py-2.5 px-3 text-right">Cost @ ₹{head.smv_rate_per_min}/Min</th>
                    <th className="py-2.5 px-2 text-center w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sewingOps.map((op, i) => {
                    const opCost = (Number(op.smv) || 0) * (Number(head.smv_rate_per_min) || 0.85);
                    return (
                      <tr key={op._key || i}>
                        <td className="py-2 px-3 text-slate-400">{i + 1}</td>
                        <td className="py-1 px-2 font-sans">
                          <input
                            type="text"
                            value={op.operation}
                            data-smv-op={i}
                            placeholder="Operation name"
                            onChange={(e) => {
                              const val = e.target.value;
                              setSewingOps((prev) => prev.map((row, idx) => idx === i ? { ...row, operation: val } : row));
                            }}
                            className="input py-1 px-1.5 text-xs w-full font-semibold text-slate-900"
                          />
                        </td>
                        <td className="py-1 px-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            value={op.smv}
                            onChange={(e) => {
                              const val = e.target.value === '' ? '' : Number(e.target.value);
                              setSewingOps((prev) => prev.map((row, idx) => idx === i ? { ...row, smv: val } : row));
                            }}
                            onKeyDown={(e) => {
                              // Enter on the last row adds the next operation row (row-by-row entry).
                              if (e.key === 'Enter') { e.preventDefault(); if (i === sewingOps.length - 1) addSewingOp(); }
                            }}
                            className="w-24 rounded border border-slate-200 px-1.5 py-0.5 text-right font-mono text-xs font-bold text-brand-700"
                          />
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-slate-800">₹{opCost.toFixed(3)}</td>
                        <td className="py-1 px-2 text-center">
                          <button
                            type="button"
                            className="text-slate-400 hover:text-rose-600"
                            onClick={() => setSewingOps((prev) => prev.filter((_, idx) => idx !== i))}
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
                    <td colSpan={2} className="py-2.5 px-3 font-sans">Total Sewing SMV:</td>
                    <td className="py-2.5 px-3 text-right text-brand-700 font-black">{totalSmv.toFixed(2)} mins</td>
                    <td className="py-2.5 px-3 text-right text-brand-900 font-black">₹{sewingCostPerPc.toFixed(2)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>Press Enter in the last row's SMV to add the next operation.</span>
                <button type="button" className="btn-secondary btn-xs flex items-center gap-1" onClick={addSewingOp}>
                  <Plus size={13} /> Add Operation
                </button>
              </div>
            </div>
          )}
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
                    {([
                      ['Fabric Materials', totalFabricCostPerPc],
                      ['Yarn (In-House Recipe)', totalYarnCostPerPc],
                      ['Trims & Accessories', totalTrimsCostPerPc],
                      ['Knitting', H.knitting_cost],
                      ['Dyeing & Compacting', H.dyeing_cost],
                      ['Printing', H.printing_cost],
                      ['Embroidery', H.embroidery_cost],
                      ['Washing / Other Process', H.washing_cost],
                      ['Cutting', cuttingCostPerPc],
                      ['Sewing (SMV / Flat)', sewingCostPerPc],
                      ['Finishing', finishingCostPerPc],
                      ['Packing', packingCostPerPc],
                      ['Testing', H.testing_cost],
                      ['Freight', H.freight_cost],
                      ['Agent Commission', H.agent_commission],
                      ['Finance', H.finance_cost],
                      ['Other Direct', H.other_direct_cost],
                      ['Factory Overhead', overheadCostPerPc],
                    ] as [string, number][]).map(([label, v], i) => (
                      <tr key={label} className={v === 0 ? 'text-slate-400' : ''}>
                        <td className="py-2 px-3 font-sans font-semibold text-slate-900">{i + 1}. {label}</td>
                        <td className="py-2 px-3 text-right font-bold">₹{v.toFixed(2)}</td>
                        <td className="py-2 px-3 text-right text-slate-500">
                          {totalCostPerPc > 0 ? ((v / totalCostPerPc) * 100).toFixed(1) : 0}%
                        </td>
                      </tr>
                    ))}
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

        {/* TAB 5: PROCESSES */}
        {activeTab === 'Processes' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Processes / Job Work</h3>
                <p className="text-xs text-slate-500">
                  Per KG: Consumption (kg/pc) × Rate / KG · Per PC: Rate / PC.
                  Knitting → Knitting head · Dyeing &amp; Compacting → Dyeing head · Washing &amp; Other → Washing / Other head
                </p>
              </div>
              <div className="flex gap-2 font-mono text-[11px]">
                <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">Knitting ₹{H.knitting_cost.toFixed(2)}</span>
                <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">Dyeing ₹{H.dyeing_cost.toFixed(2)}</span>
                <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">Washing/Other ₹{H.washing_cost.toFixed(2)}</span>
              </div>
            </div>
            <PreCostingRowTable
              gridId="processes"
              rows={processes}
              onChange={setProcesses}
              columns={[
                { key: 'process_name', label: 'Process', type: 'text', placeholder: 'e.g. Reactive Dyeing' },
                { key: 'process_type', label: 'Type → Head', type: 'select', options: PROCESS_TYPE_OPTIONS, width: 'w-44' },
                { key: 'basis', label: 'Basis', type: 'select', options: PROCESS_BASIS_OPTIONS, width: 'w-24' },
                { key: 'consumption', label: 'Cons / Pc (KG)', type: 'number', step: '0.001', disabled: (r) => r.basis !== 'PER_KG', width: 'w-20' },
                { key: 'rate', label: 'Rate (₹)', type: 'number', step: '0.01', suffix: (r) => (r.basis === 'PER_KG' ? '/kg' : '/pc') },
              ]}
              newRow={() => ({ process_name: '', process_type: 'DYEING', basis: 'PER_KG', consumption: '', rate: '' })}
              amount={(r) => processAmount(r)}
              totalLabel="Total Process Cost Per Piece:"
              total={totalProcessPerPc}
              addLabel="Add Process"
            />
            {useYarnRecipe && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs text-amber-900">
                Yarn recipe is on: knitting and dyeing rows here make up the fabric cost together with the yarn.
              </div>
            )}
          </div>
        )}

        {/* TAB 6: CUTTING */}
        {activeTab === 'Cutting' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Cutting Operations</h3>
              <p className="text-xs text-slate-500">Spreading, cutting, numbering / bundling — rate per piece. Total → Cutting head.</p>
            </div>
            <PreCostingRowTable
              gridId="cutting"
              rows={cuttingOps}
              onChange={setCuttingOps}
              columns={[
                { key: 'operation', label: 'Operation', type: 'text', placeholder: 'e.g. Spreading' },
                { key: 'rate', label: 'Rate / Pc (₹)', type: 'number', step: '0.01' },
              ]}
              newRow={() => ({ operation: '', rate: '' })}
              amount={(r) => Number(r.rate) || 0}
              totalLabel="Total Cutting Cost Per Piece:"
              total={cuttingCostPerPc}
              addLabel="Add Operation"
            />
          </div>
        )}

        {/* TAB 8: FINISHING & PACKING */}
        {activeTab === 'Finishing & Packing' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Finishing &amp; Packing</h3>
                <p className="text-xs text-slate-500">
                  Thread cutting, checking, ironing, folding, polybag, carton, tags — Qty / Pc × Rate. Each row goes to the Finishing or Packing head.
                </p>
              </div>
              <div className="flex gap-2 font-mono text-[11px]">
                <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">Finishing ₹{finishingCostPerPc.toFixed(2)}</span>
                <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">Packing ₹{packingCostPerPc.toFixed(2)}</span>
              </div>
            </div>
            <PreCostingRowTable
              gridId="finishing"
              rows={finishingItems}
              onChange={setFinishingItems}
              columns={[
                { key: 'item', label: 'Item / Operation', type: 'text', placeholder: 'e.g. Ironing' },
                { key: 'cost_type', label: 'Head', type: 'select', options: FINISH_TYPE_OPTIONS, width: 'w-28' },
                { key: 'qty_per_pc', label: 'Qty / Pc', type: 'number', step: '0.0001', width: 'w-20' },
                { key: 'rate', label: 'Rate (₹)', type: 'number', step: '0.01' },
              ]}
              newRow={() => ({ item: '', cost_type: 'FINISHING', qty_per_pc: 1, rate: '' })}
              amount={(r) => (Number(r.qty_per_pc) || 0) * (Number(r.rate) || 0)}
              totalLabel="Total Finishing & Packing Per Piece:"
              total={finishingCostPerPc + packingCostPerPc}
              addLabel="Add Item"
            />
          </div>
        )}

        {/* TAB 9: OTHER DIRECT */}
        {activeTab === 'Other Direct' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Other Direct Charges</h3>
              <p className="text-xs text-slate-500">
                ₹ per PC, % of FOB (e.g. agent commission, finance) or % of direct manufacturing cost
                (₹{calc.manufacturing_direct.toFixed(2)}). % of FOB is solved with the margin: FOB = (Direct + Overhead) ÷ (1 − Margin% − ΣFOB%).
              </p>
            </div>
            <PreCostingRowTable
              gridId="other"
              rows={otherDirect}
              onChange={setOtherDirect}
              columns={[
                { key: 'charge_type', label: 'Charge → Head', type: 'select', options: OTHER_TYPE_OPTIONS, width: 'w-40' },
                { key: 'description', label: 'Description', type: 'text', placeholder: 'e.g. Lab testing' },
                { key: 'basis', label: 'Basis', type: 'select', options: OTHER_BASIS_OPTIONS, width: 'w-32' },
                { key: 'value', label: 'Value', type: 'number', step: '0.01', suffix: (r) => (r.basis === 'PER_PC' || !r.basis ? '₹' : '%') },
              ]}
              newRow={() => ({ charge_type: 'OTHER', description: '', basis: 'PER_PC', value: '' })}
              amount={otherRowAmount}
              totalLabel="Total Other Direct Per Piece:"
              total={otherDirectPerPc}
              addLabel="Add Charge"
            />
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 font-mono text-[11px]">
              {([['Testing', H.testing_cost], ['Freight', H.freight_cost], ['Agent Comm.', H.agent_commission],
                ['Finance', H.finance_cost], ['Other', H.other_direct_cost]] as [string, number][]).map(([l, v]) => (
                <span key={l} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">{l} ₹{v.toFixed(2)}</span>
              ))}
            </div>
          </div>
        )}

        {/* TAB 10: OVERHEAD */}
        {activeTab === 'Overhead' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Factory Overhead</h3>
              <p className="text-xs text-slate-500">
                ₹ per piece, or % of direct cost before %-of-FOB charges (₹{(calc.direct_cost - calc.fob_pct_charges).toFixed(2)}).
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-3xl">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Basis</label>
                <select
                  value={overhead.basis}
                  onChange={(e) => setOverhead((o) => ({ ...o, basis: e.target.value }))}
                  className="input text-xs w-full"
                >
                  <option value="PER_PIECE">₹ per Piece</option>
                  <option value="PERCENT_DIRECT">% of Direct Cost</option>
                </select>
              </div>
              {overhead.basis === 'PERCENT_DIRECT' ? (
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Overhead % of Direct</label>
                  <input
                    type="number"
                    step="0.5"
                    value={overhead.pct}
                    onChange={(e) => setOverhead((o) => ({ ...o, pct: e.target.value === '' ? '' : Number(e.target.value) }))}
                    className="input font-mono font-bold w-full"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Overhead ₹ / Piece</label>
                  <input
                    type="number"
                    step="0.05"
                    value={overhead.rate}
                    onChange={(e) => setOverhead((o) => ({ ...o, rate: e.target.value === '' ? '' : Number(e.target.value) }))}
                    className="input font-mono font-bold w-full"
                  />
                </div>
              )}
              <div className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-brand-800">Overhead / Pc</span>
                <p className="text-xl font-black font-mono text-brand-900">₹{overheadCostPerPc.toFixed(2)}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
