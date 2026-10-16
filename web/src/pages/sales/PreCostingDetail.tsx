import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, RefreshCw, CheckCircle,
  Plus, Trash2, BadgeCheck, Lock, GitBranch
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { CERTIFICATIONS, TRIM_CERTIFICATIONS } from '../../lib/certifications';
import { http, ApiError } from '../../lib/api';
import { useLookup, useStatuses, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, StatusBadge } from '../../components/ui';
import { fmtDecimal, fmtNumber, today, toDateInput } from '../../lib/format';
import { FabricPicker } from './CostingsFabricPicker';
import { PreCostingRowTable } from './PreCostingRowTable';
import {
  computePreCosting, finishingRows, otherDirectRows, processHead, processAmount, cmtCoversCutToFinish,
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

/** Certification dropdowns on the Fabric / Yarn / Trims rows (client call 14-Oct-2026). */
const certOptions = (list: { value: string; label: string }[]) => [
  { value: '', label: '—' },
  ...list.map((c) => ({ value: c.value, label: c.value === 'NONE' ? 'None' : c.value })),
];
const CERT_OPTIONS = certOptions(CERTIFICATIONS);
const TRIM_CERT_OPTIONS = certOptions(TRIM_CERTIFICATIONS);
const EMB_TYPE_OPTIONS = [
  { value: 'PRINTING', label: 'Printing' },
  { value: 'EMBROIDERY', label: 'Embroidery' },
];

type CertGroup = { certification: string; materials: { type: 'FABRIC' | 'YARN' | 'TRIM'; name: string }[] };
/**
 * "Certifications required" of the sheet — every Fabric / Yarn / Trim row with a
 * certification other than None, grouped by certification. Saved as data_json
 * `cert_summary`; the cost roll-up never reads it. Mirrors certSummary() in
 * server/src/modules/costing/preCostingCalc.ts.
 */
function certSummary(dj: { fabrics?: any[]; yarns?: any[]; trims?: any[] }): CertGroup[] {
  const out = new Map<string, CertGroup>();
  const add = (type: CertGroup['materials'][number]['type'], rows: any[] | undefined, name: (r: any) => unknown) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      const cert = String(r?.certification ?? '').trim().toUpperCase();
      if (!cert || cert === 'NONE') continue;
      const nm = String(name(r) ?? '').trim() || `${type.toLowerCase()} row`;
      const g = out.get(cert) ?? { certification: cert, materials: [] };
      if (!g.materials.some((m) => m.type === type && m.name === nm)) g.materials.push({ type, name: nm });
      out.set(cert, g);
    }
  };
  add('FABRIC', dj.fabrics, (r) => r?.fabric_name || r?.component);
  add('YARN', dj.yarns, (r) => r?.yarn_name || r?.yarn_count);
  add('TRIM', dj.trims, (r) => r?.description || r?.trim_code);
  return [...out.values()].sort((a, b) => a.certification.localeCompare(b.certification));
}

/**
 * Rows from a grid whose master-pick column changed: fill the row from the master
 * (name, rate, certification …). Rows are matched by position (same length only —
 * a delete never re-fills).
 */
function withMasterPick(next: any[], prev: any[], idKey: string, fill: (row: any, id: string) => any) {
  if (next.length !== prev.length) return next;
  return next.map((r, i) => {
    const id = String(r?.[idKey] ?? '');
    return id && id !== String(prev[i]?.[idKey] ?? '') ? fill(r, id) : r;
  });
}

/** "Add …" button shown above a long grid (the grid has its own at the bottom). */
function TopAddButton({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <button type="button" data-add-top={testId} className="btn-secondary btn-xs flex items-center gap-1" onClick={onClick}>
      <Plus size={13} /> {label}
    </button>
  );
}

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

/**
 * One page instance per costing: /pre-costings/new and /pre-costings/:id share the component, so without a key
 * React kept the previous sheet's rows when "New" was opened from a costing (client 16-Oct-2026).
 */
export default function PreCostingDetailPage() {
  const { id } = useParams();
  return <PreCostingSheet key={id ?? 'new'} />;
}

function PreCostingSheet() {
  const { id } = useParams();
  const { can } = useAuth();
  const isNew = !id || id === 'new' || isNaN(Number(id));
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [saving, setSaving] = useState(false);
  const [loadingBOM, setLoadingBOM] = useState(false);
  const [activeTab, setActiveTab] = useState('Fabric');

  // Merchandiser Flat Sewing Rate Mode (vs Detailed Operations)
  // Client 16-Oct-2026: the merchandiser quotes ONE flat CMT rate (cutting → finishing); detailed SMV operations are
  // optional here (Production enters SMV on Production Rate Fixing) and are only counted in Detailed SMV mode.
  const [useFlatSewingRate, setUseFlatSewingRate] = useState(true);
  const [flatSewingRate, setFlatSewingRate] = useState<number | ''>('');
  const [flatSewingDesc, setFlatSewingDesc] = useState('');
  const [cmtScope, setCmtScope] = useState<'CUT_TO_FINISH' | 'STITCHING'>('CUT_TO_FINISH');

  // Lookups
  const styles = useLookup('styles');
  const buyers = useLookup('buyers');
  const currencies = useLookup('currencies');
  const fabricMaster = useLookup('fabrics');
  const yarnMaster = useLookup('yarns');
  const trimMaster = useLookup('trims');
  // Colour and size are picked from the masters (client 16-Oct-2026: typed values kept mismatching)
  const colorMaster = useLookup('colors');
  const sizeMaster = useLookup('sizes');
  /** Master colours; a row's older typed colour that is not in the master stays visible, marked. */
  const colorOptions = (current?: string) => {
    const names = (colorMaster.data ?? []).map((c: any) => String(c.label));
    const cur = String(current ?? '').trim();
    return [
      { value: '', label: '— colour —' },
      ...(cur && !names.some((n) => n.toLowerCase() === cur.toLowerCase()) ? [{ value: cur, label: `${cur} (not in master)` }] : []),
      ...names.map((n) => ({ value: n, label: n })),
    ];
  };
  /** "All sizes", then the size master (code, with its size group); an older value not in the master stays, marked. */
  const sizeOptions = (current?: string) => {
    const list = (sizeMaster.data ?? []).map((z: any) => ({ value: String(z.code), label: `${z.code}${z.group_name ? ` · ${z.group_name}` : ''}` }));
    const uniq = [...new Map(list.map((o) => [o.value, o])).values()];
    const cur = String(current ?? '').trim();
    return [
      { value: 'All', label: 'All sizes' },
      ...(cur && cur !== 'All' && !uniq.some((o) => o.value === cur) ? [{ value: cur, label: `${cur} (not in master)` }] : []),
      ...uniq,
    ];
  };
  // Certification of each material master (fabric / yarn from their base) — the row default.
  const materialCerts = useQuery({
    queryKey: ['pre-costings', 'material-certs'],
    queryFn: async () => (await http.get<{ data: { fabrics: Record<string, string>; yarns: Record<string, string>; trims: Record<string, string> } }>('/pre-costings/material-certs')).data,
    staleTime: 60 * 1000,
  });
  const certOf = (kind: 'fabrics' | 'yarns' | 'trims', id: unknown) => (id ? materialCerts.data?.[kind]?.[String(id)] ?? '' : '');
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
    season: '',
    style_id: '',
    style_code: '',
    style_name: '',
    buyer_ref: '',
    order_qty: 0,
    currency_id: '1',
    currency_code: 'INR',
    // ₹ per 1 unit of the quote currency: every rate on the sheet is ₹, the quoted FOB is shown in the currency
    exchange_rate: '' as number | '',
    fx_rate_date: '',
    price_basis: 'PER_PCS',
    unit_id: '1',
    factory: '',
    version: 1,
    status: 'Draft',
    status_code: 'DRAFT',
    margin_pct: 0,
    smv: 0,
    smv_rate_per_min: 0,
    remarks: '',
  });
  // Stored head values of a loaded sheet: kept for a tab its data_json never had.
  const [storedHeads, setStoredHeads] = useState<Partial<Record<PreCostHeadKey, number>>>({});

  // A new sheet starts empty — no sample rows (client 16-Oct-2026: "New" showed earlier values).
  const [fabrics, setFabrics] = useState<any[]>([]);
  // Yarn lines (in-house manufactured fabric recipe)
  const [useYarnRecipe, setUseYarnRecipe] = useState(false);
  const [yarns, setYarns] = useState<any[]>([]);
  const [trims, setTrims] = useState<any[]>([]);
  const [embellishments, setEmbellishments] = useState<any[]>([]);
  // Processes (knitting / dyeing / compacting / washing — per KG or per PC)
  const [processes, setProcesses] = useState<any[]>([]);
  // Cutting operations (₹ / pc)
  const [cuttingOps, setCuttingOps] = useState<any[]>([]);
  // Sewing SMV operations (optional — Detailed SMV mode only)
  const [sewingOps, setSewingOps] = useState<any[]>([]);
  // Finishing & Packing items (qty / pc × rate, each row Finishing or Packing)
  const [finishingItems, setFinishingItems] = useState<any[]>([]);
  // Other Direct Charges (₹/pc, % of FOB or % of direct cost)
  const [otherDirect, setOtherDirect] = useState<any[]>([]);
  // Overhead
  const [overhead, setOverhead] = useState<{ basis: string; rate: number | ''; pct: number | '' }>({
    basis: 'PER_PIECE', rate: '', pct: '',
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
      season: c.season || '',
      style_id: String(c.style_id || ''),
      style_code: c.style_code || '',
      style_name: c.style_name || '',
      buyer_ref: c.buyer_ref || '',
      order_qty: Number(c.order_qty) || 0,
      currency_id: String(c.currency_id || '1'),
      currency_code: c.currency_code || 'INR',
      exchange_rate: c.exchange_rate != null && String(c.currency_code || 'INR') !== 'INR' ? Number(c.exchange_rate) : '',
      fx_rate_date: toDateInput(c.fx_rate_date) || '',
      price_basis: c.price_basis || 'PER_PCS',
      version: Number(c.version) || 1,
      status: c.status_label || 'Draft',
      status_code: String(costingStatuses.data?.find((x) => Number(x.id) === Number(c.status_id))?.code ?? c.status_code ?? 'DRAFT').toUpperCase(),
      margin_pct: c.margin_pct != null ? Number(c.margin_pct) : 0,
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
    // sheets saved before the scope existed: the flat rate was stitching only (their totals stay the same)
    // a sheet saved before flat mode existed priced sewing from its SMV rows — keep that mode so its total stays
    if (parsed.useFlatSewingRate === undefined) setUseFlatSewingRate(!(Array.isArray(parsed.sewingOps) && parsed.sewingOps.length));
    setCmtScope(String(parsed.cmtScope ?? '').toUpperCase() === 'CUT_TO_FINISH' ? 'CUT_TO_FINISH' : 'STITCHING');

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
      : { basis: 'PER_PIECE', rate: stored.overhead_cost ?? 0, pct: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costingQuery.data, costingStatuses.data]);

  // Fabric rows saved before the GSM column existed (client 16-Oct-2026) show their fabric master's GSM.
  useEffect(() => {
    if (!fabricMaster.data?.length) return;
    setFabrics((prev) => {
      let changed = false;
      const next = prev.map((r) => {
        if (r?.gsm !== undefined || !r?.fabric_id) return r;
        const m: any = fabricMaster.data?.find((x: any) => String(x.id) === String(r.fabric_id));
        if (!m) return r;
        changed = true;
        return { ...r, gsm: m.gsm_value ?? m.min_gsm ?? '' };
      });
      return changed ? next : prev;
    });
  }, [fabricMaster.data, costingQuery.data]);

  // Rows saved / defaulted before the Certification column existed take the master's certification.
  useEffect(() => {
    if (!materialCerts.data) return;
    const fill = (kind: 'fabrics' | 'yarns' | 'trims', idKey: string) => (prev: any[]) => {
      let changed = false;
      const next = prev.map((r) => {
        if (r?.certification !== undefined || !r?.[idKey]) return r;
        changed = true;
        return { ...r, certification: certOf(kind, r[idKey]) };
      });
      return changed ? next : prev;
    };
    setFabrics(fill('fabrics', 'fabric_id'));
    setYarns(fill('yarns', 'yarn_id'));
    setTrims(fill('trims', 'trim_id'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialCerts.data, costingQuery.data]);

  const newFabricRow = () => ({
    _key: `fab_${Date.now()}`,
    component: '',
    fabric_id: '',
    fabric_name: '',
    gsm: '',
    color: '',
    size: 'All',
    consumption: '',
    wastage_pct: '',
    rate: '',
    amount: 0,
    rate_source: 'Manual Rate',
    certification: '',
  });
  const newYarnRow = () => ({
    yarn_id: '', yarn_count: '', yarn_name: '', composition: '',
    consumption: '', wastage_pct: '', rate: '', rate_source: 'Manual Rate', certification: '',
  });
  const newTrimRow = () => ({
    trim_id: '', trim_code: '', description: '', size: 'All', color: '',
    consumption: 1, uom: 'Nos', wastage_pct: '', rate: '', certification: '',
  });
  const newEmbRow = () => ({ type: 'PRINTING', method: '', artwork: '', position: '', colors: '', rate: '' });
  /** Append a row from the top "Add" button (the grid's own button is at the bottom). */
  const addTop = (setter: (fn: (prev: any[]) => any[]) => void, gridId: string, row: any) =>
    setter((prev) => [...prev, { _key: `${gridId}_${Date.now()}`, ...row }]);

  const pickYarn = (row: any, id: string) => {
    const m: any = yarnMaster.data?.find((y) => String(y.id) === id);
    if (!m) return row;
    const std = Number(m.std_rate) || 0;
    return {
      ...row,
      yarn_name: m.label,
      yarn_count: m.count_value ? `${m.count_value}${m.count_type ? ` ${m.count_type}` : ''}` : row.yarn_count,
      rate: std > 0 ? std : row.rate,
      rate_source: std > 0 ? 'Yarn Master Std Rate' : row.rate_source,
      certification: certOf('yarns', id) || row.certification || '',
    };
  };
  const pickTrim = (row: any, id: string) => {
    const m: any = trimMaster.data?.find((t) => String(t.id) === id);
    if (!m) return row;
    const std = Number(m.std_rate) || 0;
    return {
      ...row,
      trim_code: m.code ?? row.trim_code,
      description: m.label,
      uom: m.uom_code || row.uom,
      rate: std > 0 ? std : row.rate,
      certification: certOf('trims', id) || row.certification || '',
    };
  };
  // Item name only (client 16-Oct-2026: the code in front hid the item in the narrow dropdown); the code is still
  // stored on the row (trim_code) from the master, just not shown.
  const masterOptions = (items: any[] | undefined, manual: string) => [
    { value: '', label: manual },
    ...(items ?? []).map((m) => ({ value: String(m.id), label: String(m.label ?? m.code ?? '') })),
  ];

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
        // a fixed qty (and the additional qty) is already the quantity for the line's own sizes / colours
        if (basis === 'FIXED_QTY') return Number(((c + addl) / oq).toFixed(6));
        const base = basis === 'PER_DOZEN' ? c / 12 : c;
        return Number((base * share + addl / oq).toFixed(6));
      };
      bomLines.forEach((l: any, idx: number) => {
        if (l.material_type === 'FABRIC') {
          const cons = perGarment(l) || 0;
          const wastage = l.wastage_pct != null && l.wastage_pct !== '' ? Number(l.wastage_pct) : 0;
          const rate = Number(l.applied_rate) || Number(l.std_rate) || 0;
          newFabrics.push({
            _key: `fab_${idx}`,
            component: l.part_name || l.component || (idx === 0 ? 'Body' : ''),
            fabric_id: String(l.fabric_id),
            fabric_name: l.fabric_name,
            gsm: l.fabric_gsm ?? '',
            color: l.color_name || '',
            size: l.size_code || 'All',
            consumption: cons,
            wastage_pct: wastage,
            rate: rate,
            amount: cons * (1 + wastage / 100) * rate,
            rate_source: l.rate_source || 'Style BOM',
            certification: l.certification || '',
          });
        } else if (l.material_type === 'TRIM') {
          const cons = perGarment(l) || 0;
          const wastage = l.wastage_pct != null && l.wastage_pct !== '' ? Number(l.wastage_pct) : 0;
          const rate = Number(l.applied_rate) || Number(l.std_rate) || 0;
          newTrims.push({
            _key: `trm_${idx}`,
            trim_id: String(l.trim_id),
            trim_code: l.trim_code,
            description: l.trim_name,
            size: l.size_code || 'All',
            color: l.color_name || '',
            consumption: cons,
            uom: l.uom_code || 'Nos',
            wastage_pct: wastage,
            rate: rate,
            amount: cons * (1 + wastage / 100) * rate,
            certification: l.certification || '',
          });
        } else if (l.material_type === 'YARN') {
          const cons = perGarment(l) || 0;
          const rate = Number(l.applied_rate) || Number(l.std_rate) || 0;
          newYarns.push({
            _key: `yrn_${idx}`,
            yarn_id: String(l.yarn_id),
            yarn_name: l.yarn_name,
            yarn_count: l.yarn_code || '',
            composition: '',
            consumption: cons,
            wastage_pct: Number(l.wastage_pct) || 0,
            rate: rate,
            amount: cons * (1 + (Number(l.wastage_pct) || 0) / 100) * rate,
            rate_source: l.rate_source || 'Style BOM',
            certification: l.certification || '',
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
    cmtScope,
    // Certification requirement summary ("generate certificate" on save) — not used by the calc.
    cert_summary: certSummary({ fabrics, yarns, trims }),
  }), [fabrics, yarns, trims, embellishments, processes, cuttingOps, sewingOps, finishingItems,
    otherDirect, overhead, useYarnRecipe, useFlatSewingRate, flatSewingRate, flatSewingDesc, cmtScope]);

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

  // Quote currency: rates are ₹; the FOB is quoted in the costing currency at the exchange rate (₹ per 1 unit)
  const curRow: any = currencies.data?.find((c: any) => String(c.id) === String(head.currency_id));
  const curCode = String(curRow?.code ?? head.currency_code ?? 'INR').toUpperCase();
  const curSym = curCode === 'INR' ? '₹' : (curRow?.symbol || `${curCode} `);
  const isForeign = curCode !== 'INR';
  const fxRate = Number(head.exchange_rate) || 0;
  const fobFc = isForeign ? (fxRate > 0 ? quotedFobPerPc / fxRate : null) : quotedFobPerPc;
  const cmtAll = cmtCoversCutToFinish({ useFlatSewingRate, cmtScope });
  // Approved = read-only baseline; changes go through Revise (v + 1). Approving needs COSTING.APPROVE.
  const isApproved = head.status_code === 'APPROVED';
  const canApprove = can('COSTING.APPROVE');

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
    if (isForeign && !(fxRate > 0)) {
      toast(`Enter the exchange rate — ₹ per 1 ${curCode}`, 'warning');
      return;
    }
    if (statusOverride === 'Approved' && !(orderQty > 0)) {
      toast('Enter the order quantity before approving', 'warning');
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
        exchange_rate: isForeign ? fxRate : 1,
        fx_rate_date: isForeign ? (head.fx_rate_date || head.costing_date) : undefined,
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
      setHead((h) => ({ ...h, costing_no: saved.costing_no, status: statusOverride, status_code: statusOverride.toUpperCase() }));
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

  const [revising, setRevising] = useState(false);
  const handleRevise = async () => {
    if (!costId) return;
    const reason = window.prompt(`Reason for revising ${head.costing_no} v${head.version} (kept on the new version)`, '');
    if (reason === null) return;
    setRevising(true);
    try {
      const r = await http.post<{ data: { id: number } }>(`/pre-costings/${costId}/revise`, { reason: reason.trim() || null });
      toast(`${head.costing_no} v${Number(head.version) + 1} created as a draft — v${head.version} stays approved`, 'success');
      qc.invalidateQueries({ queryKey: ['pre-costings'] });
      qc.invalidateQueries({ queryKey: ['costings'] });
      nav(`/sales/pre-costings/${r.data.id}`);
    } catch (err) {
      toast((err as ApiError).message || 'Could not revise the costing', 'error');
    } finally {
      setRevising(false);
    }
  };

  // when a foreign currency is picked, pre-fill its latest exchange rate (₹ per 1 unit) if none is entered
  const pickCurrency = async (val: string) => {
    const row: any = currencies.data?.find((c: any) => String(c.id) === val);
    setHead((h) => ({ ...h, currency_id: val, currency_code: row?.code ?? h.currency_code }));
    if (!row || String(row.code).toUpperCase() === 'INR' || Number(head.exchange_rate) > 0) return;
    try {
      const r = await http.get<{ data: { rate: number | null; rate_date: string | null } }>('/pre-costings/fx-rate', { params: { currency_id: val, on: head.costing_date } });
      if (r.data.rate) setHead((h) => (Number(h.exchange_rate) > 0 ? h : { ...h, exchange_rate: r.data.rate!, fx_rate_date: toDateInput(r.data.rate_date) || h.fx_rate_date }));
    } catch { /* the merchandiser types the rate */ }
  };

  const tabs = [
    'Fabric',
    'Yarn Recipe',
    'Trims',
    'Printing & Emb',
    'Processes',
    'Cutting',
    'CMT / Sewing',
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
            disabled={loadingBOM || !head.style_id || isApproved}
          >
            <RefreshCw size={14} className={loadingBOM ? 'animate-spin text-brand-600' : ''} />
            {loadingBOM ? 'Loading BOM…' : 'Load Style BOM & Rates'}
          </button>

          {isApproved ? (
            <button
              type="button"
              id="pc-revise"
              className="btn-primary btn-sm flex items-center gap-1.5"
              onClick={handleRevise}
              disabled={revising}
              title="An approved costing is read-only; Revise creates the next version as a draft"
            >
              <GitBranch size={14} /> {revising ? 'Creating…' : `Revise (create v${Number(head.version) + 1})`}
            </button>
          ) : (
            <>
              <button
                type="button"
                id="pc-save"
                className="btn-primary btn-sm flex items-center gap-1.5"
                onClick={() => handleSave('Draft')}
                disabled={saving}
              >
                <Save size={14} /> Save Draft
              </button>
              {costId && canApprove && (
                <button
                  type="button"
                  id="pc-approve"
                  className="btn-success btn-sm flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                  onClick={() => handleSave('Approved')}
                  disabled={saving}
                >
                  <CheckCircle size={14} /> Approve Costing
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {isApproved && (
        <div id="pc-approved-banner" className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-900">
          <Lock size={14} /> <b>Approved — read-only.</b> This version is the baseline for quotations and production costing.
          To change it, click Revise: v{Number(head.version) + 1} is created as a draft and v{head.version} stays as it is.
        </div>
      )}

      {/* 2. Top Header Grid */}
      <fieldset disabled={isApproved} className="contents">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-7 gap-3.5">
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
              id="pc-currency"
              value={head.currency_id}
              onChange={(e) => pickCurrency(e.target.value)}
              options={(currencies.data ?? []).map((c: any) => ({ value: String(c.id), label: `${c.code} — ${c.label}` }))}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              {isForeign ? `Exchange Rate (₹ per 1 ${curCode}) *` : 'Exchange Rate'}
            </label>
            {isForeign ? (
              <Input
                id="pc-fx"
                type="number"
                step="0.0001"
                value={head.exchange_rate}
                placeholder={`₹ for 1 ${curCode}`}
                onChange={(e) => setHead((h) => ({ ...h, exchange_rate: e.target.value === '' ? '' : Number(e.target.value) }))}
              />
            ) : (
              <p className="h-10 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">INR — no conversion</p>
            )}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          All rates on the tabs are in <b>₹ (INR)</b>.{isForeign ? <> The quoted FOB is shown in <b>{curCode}</b> (₹ ÷ exchange rate) with the ₹ value under it.</> : null}
        </p>
      </div>
      </fieldset>

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

        <div className="rounded-xl border border-brand-300 bg-brand-50 p-3.5 shadow-xs" id="pc-fob">
          <span className="text-xs font-black uppercase tracking-wider text-brand-900">Quoted FOB Price / Pc{isForeign ? ` (${curCode})` : ''}</span>
          {isForeign ? (
            <>
              <p className="text-2xl font-black text-brand-900 font-mono mt-1" data-fob-fc>
                {fobFc != null ? `${curSym}${fmtDecimal(fobFc, 4)}` : <span className="text-base text-amber-700">enter exchange rate</span>}
              </p>
              <p className="text-[11px] text-brand-800 font-bold mt-0.5" data-fob-inr>
                ₹{fmtDecimal(quotedFobPerPc, 2)} / pc · @ ₹{fxRate || '—'} per {curCode}
              </p>
              <p className="text-[11px] text-brand-800 mt-0.5">
                Order FOB: {fobFc != null ? `${curSym}${fmtDecimal(fobFc * orderQty, 2)}` : '—'} · ₹{fmtDecimal(totalOrderFob, 0)}
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl font-black text-brand-900 font-mono mt-1">₹{fmtDecimal(quotedFobPerPc, 2)}</p>
              <p className="text-[11px] text-brand-800 font-bold mt-0.5">Total Order FOB: ₹{fmtDecimal(totalOrderFob, 0)}</p>
            </>
          )}
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
      <fieldset disabled={isApproved} className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs min-w-0">
        {/* TAB 1: FABRICS */}
        {activeTab === 'Fabric' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Fabric Consumption & Costing</h3>
                <p className="text-xs text-slate-500">
                  Gross Qty = Consumption × (1 + Wastage %) × Order Qty · Colour and size are picked from Masters → Colors / Sizes
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
                <TopAddButton testId="fabric" label="Add Fabric Line" onClick={() => setFabrics((prev) => [...prev, newFabricRow()])} />
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
                    <th className="py-2.5 px-3 text-right" title="From the fabric master when a fabric is picked; editable">GSM</th>
                    <th className="py-2.5 px-3">Colour</th>
                    <th className="py-2.5 px-3">Size</th>
                    <th className="py-2.5 px-3">Certification</th>
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
                        <td className="py-1 px-2 font-sans">
                          <input
                            type="text"
                            value={f.component ?? ''}
                            placeholder="Component"
                            onChange={(e) => {
                              const val = e.target.value;
                              setFabrics((prev) => prev.map((row, idx) => idx === i ? { ...row, component: val } : row));
                            }}
                            className="w-28 rounded border border-slate-200 px-1.5 py-0.5 text-xs font-semibold text-slate-800"
                          />
                        </td>
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
                                gsm: (m as any).gsm_value ?? (m as any).min_gsm ?? row.gsm ?? '',
                                rate: stdRate > 0 ? stdRate : row.rate,
                                rate_source: stdRate > 0 ? 'Fabric Master Std Rate' : row.rate_source,
                                certification: certOf('fabrics', m.id) || row.certification || '',
                              } : row));
                            }}
                          />
                        </td>
                        <td className="py-1 px-2 text-right">
                          <input
                            type="number"
                            min={0}
                            data-gsm-fabric={i}
                            value={f.gsm ?? ''}
                            placeholder="GSM"
                            onChange={(e) => {
                              const val = e.target.value === '' ? '' : Number(e.target.value);
                              setFabrics((prev) => prev.map((row, idx) => idx === i ? { ...row, gsm: val } : row));
                            }}
                            className="w-16 rounded border border-slate-200 px-1.5 py-0.5 text-right font-mono text-xs"
                          />
                        </td>
                        <td className="py-1 px-2 font-sans">
                          <select
                            data-color-fabric={i}
                            value={f.color ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFabrics((prev) => prev.map((row, idx) => idx === i ? { ...row, color: val } : row));
                            }}
                            className="w-32 rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                          >
                            {colorOptions(f.color).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td className="py-1 px-2 font-sans">
                          <select
                            data-size-fabric={i}
                            value={f.size || 'All'}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFabrics((prev) => prev.map((row, idx) => idx === i ? { ...row, size: val } : row));
                            }}
                            className="w-28 rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                          >
                            {sizeOptions(f.size).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td className="py-1 px-2 font-sans">
                          <select
                            data-cert-fabric={i}
                            value={f.certification ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setFabrics((prev) => prev.map((row, idx) => idx === i ? { ...row, certification: val } : row));
                            }}
                            className="w-28 rounded border border-slate-200 px-1.5 py-0.5 text-xs"
                          >
                            {CERT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
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
                    <td colSpan={10} className="py-2.5 px-3 text-right font-sans">Total Fabric Cost Per Piece:</td>
                    <td className="py-2.5 px-3 text-right text-brand-900 font-black">₹{totalFabricCostPerPc.toFixed(2)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="flex justify-end">
              <button type="button" className="btn-secondary btn-xs flex items-center gap-1" onClick={() => setFabrics((prev) => [...prev, newFabricRow()])}>
                <Plus size={13} /> Add Fabric Line
              </button>
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
                  Pick a yarn from the master (rate and certification default from it) or type a manual line. Cost = Cons × (1 + Wastage %) × Rate.
                </p>
              </div>
              <TopAddButton testId="yarns" label="Add Yarn Line" onClick={() => addTop(setYarns, 'yarns', newYarnRow())} />
            </div>
            <PreCostingRowTable
              gridId="yarns"
              rows={yarns}
              onChange={(rows) => setYarns((prev) => withMasterPick(rows, prev, 'yarn_id', pickYarn))}
              columns={[
                { key: 'yarn_id', label: 'Yarn (master)', type: 'select', options: masterOptions(yarnMaster.data, '— manual —'), width: 'w-56' },
                { key: 'yarn_name', label: 'Description', type: 'text', placeholder: 'e.g. 30s Combed Cotton' },
                { key: 'yarn_count', label: 'Count', type: 'text', width: 'w-24' },
                { key: 'composition', label: 'Composition', type: 'text', width: 'w-28' },
                { key: 'certification', label: 'Certification', type: 'select', options: CERT_OPTIONS, width: 'w-24' },
                { key: 'consumption', label: 'Cons / Pc (KG)', type: 'number', step: '0.001', width: 'w-20' },
                { key: 'wastage_pct', label: 'Wastage %', type: 'number', step: '0.5', width: 'w-16' },
                { key: 'rate', label: 'Rate / KG (₹)', type: 'number', step: '0.01', width: 'w-20' },
              ]}
              newRow={newYarnRow}
              amount={(r) => (Number(r.consumption) || 0) * (1 + (Number(r.wastage_pct) || 0) / 100) * (Number(r.rate) || 0)}
              totalLabel="Total Yarn Cost Per Piece:"
              total={useYarnRecipe ? totalYarnCostPerPc : yarns.reduce((a, r) => a + (Number(r.consumption) || 0) * (1 + (Number(r.wastage_pct) || 0) / 100) * (Number(r.rate) || 0), 0)}
              addLabel="Add Yarn Line"
            />
            {!useYarnRecipe && (
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5 text-xs text-slate-600">
                Yarn recipe is off (Fabric tab): these lines are kept for reference and certification, but the fabric rows carry the cost.
              </div>
            )}
          </div>
        )}

        {/* TAB 3: TRIMS */}
        {activeTab === 'Trims' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Trims & Accessories</h3>
                <p className="text-xs text-slate-500">
                  Labels, buttons, zippers, hangtags, threads — add as many lines as the style needs. Pick from the master (rate and certification default) or type a manual line. Colour and size come from Masters → Colors / Sizes.
                </p>
              </div>
              <TopAddButton testId="trims" label="Add Trim Line" onClick={() => addTop(setTrims, 'trims', newTrimRow())} />
            </div>
            <PreCostingRowTable
              gridId="trims"
              rows={trims}
              onChange={(rows) => setTrims((prev) => withMasterPick(rows, prev, 'trim_id', pickTrim))}
              columns={[
                { key: 'trim_id', label: 'Trim (master)', type: 'select', options: masterOptions(trimMaster.data, '— manual —'), width: 'w-56' },
                { key: 'description', label: 'Description', type: 'text', placeholder: 'e.g. Woven main label' },
                { key: 'color', label: 'Colour', type: 'select', options: (r: any) => colorOptions(r.color), width: 'w-32' },
                { key: 'size', label: 'Size', type: 'select', options: (r: any) => sizeOptions(r.size), width: 'w-28' },
                { key: 'uom', label: 'UOM', type: 'text', width: 'w-16' },
                { key: 'certification', label: 'Certification', type: 'select', options: TRIM_CERT_OPTIONS, width: 'w-24' },
                { key: 'consumption', label: 'Cons / Pc', type: 'number', step: '0.001', width: 'w-20' },
                { key: 'wastage_pct', label: 'Wastage %', type: 'number', step: '0.5', width: 'w-16' },
                { key: 'rate', label: 'Rate (₹)', type: 'number', step: '0.01', width: 'w-20' },
              ]}
              newRow={newTrimRow}
              amount={(r) => (Number(r.consumption) || 0) * (1 + (Number(r.wastage_pct) || 0) / 100) * (Number(r.rate) || 0)}
              amountLabel="Amount (₹)"
              totalLabel="Total Trims Cost Per Piece:"
              total={totalTrimsCostPerPc}
              addLabel="Add Trim Line"
            />
          </div>
        )}

        {/* TAB 4: PRINTING & EMBROIDERY */}
        {activeTab === 'Printing & Emb' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Printing & Embroidery Embellishments</h3>
                <p className="text-xs text-slate-500">Artwork, screen / rotary printing, multi-head embroidery — rate per piece. Embroidery rows → Embroidery head, the rest → Printing.</p>
              </div>
              <TopAddButton testId="emb" label="Add Embellishment" onClick={() => addTop(setEmbellishments, 'emb', newEmbRow())} />
            </div>
            <PreCostingRowTable
              gridId="emb"
              rows={embellishments}
              onChange={setEmbellishments}
              columns={[
                { key: 'type', label: 'Type → Head', type: 'select', options: EMB_TYPE_OPTIONS, width: 'w-32' },
                { key: 'method', label: 'Method', type: 'text', placeholder: 'e.g. Screen Print', width: 'w-32' },
                { key: 'artwork', label: 'Artwork / Description', type: 'text', placeholder: 'e.g. Chest logo 3 colours' },
                { key: 'position', label: 'Position', type: 'text', width: 'w-28' },
                { key: 'colors', label: 'Colours', type: 'number', step: '1', width: 'w-14' },
                { key: 'rate', label: 'Rate / Pc (₹)', type: 'number', step: '0.01', width: 'w-20' },
              ]}
              newRow={newEmbRow}
              amount={(r) => Number(r.rate) || 0}
              totalLabel="Total Printing & Embroidery Per Piece:"
              total={H.printing_cost + H.embroidery_cost}
              addLabel="Add Embellishment"
            />
          </div>
        )}

        {/* TAB 7: SEWING (SMV ENGINE) */}
        {activeTab === 'CMT / Sewing' && (
          <div className="space-y-4">
            {/* Mode Selector */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-indigo-50 border border-indigo-200">
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-indigo-950 uppercase tracking-wider">CMT / Sewing Cost:</span>
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
                    Flat CMT rate (₹ / pc) — main
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
                    Detailed SMV operations — optional
                  </button>
                </div>
              </div>
              <span className="font-mono font-black text-sm text-brand-950 bg-white border border-indigo-200 px-3 py-1 rounded-md">
                {useFlatSewingRate && cmtAll ? 'CMT' : 'Sewing'} Cost: ₹{sewingCostPerPc.toFixed(2)} / Pc
              </span>
            </div>

            {/* Flat Rate View */}
            {useFlatSewingRate ? (
              <div className="p-4 bg-white rounded-lg border border-slate-200 shadow-sm space-y-4" id="pc-flat-cmt">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="label text-xs font-bold text-slate-800">Flat CMT rate (₹ / piece) *</label>
                    <input
                      id="pc-flat-rate"
                      type="number"
                      step="0.50"
                      value={flatSewingRate}
                      onChange={(e) => setFlatSewingRate(e.target.value === '' ? '' : parseFloat(e.target.value) || 0)}
                      className="input font-mono font-black text-base text-brand-800 w-full"
                      placeholder="e.g. 25.00"
                    />
                  </div>
                  <div>
                    <label className="label text-xs font-bold text-slate-800">The flat rate covers</label>
                    <select id="pc-cmt-scope" className="input text-xs w-full" value={cmtScope} onChange={(e) => setCmtScope(e.target.value as any)}>
                      <option value="CUT_TO_FINISH">Cutting → finishing (cutting, stitching, checking, ironing)</option>
                      <option value="STITCHING">Stitching only (cutting &amp; finishing on their own tabs)</option>
                    </select>
                  </div>
                  <div>
                    <label className="label text-xs font-bold text-slate-800">Description / operations covered</label>
                    <input
                      type="text"
                      value={flatSewingDesc}
                      onChange={(e) => setFlatSewingDesc(e.target.value)}
                      className="input text-xs w-full"
                      placeholder="e.g. Cutting to ironing complete"
                    />
                  </div>
                </div>
                <div className="p-2.5 rounded bg-amber-50 border border-amber-200 text-xs text-amber-900">
                  The merchandiser quotes one flat rate per piece. Detailed SMV operations are entered by Production on
                  <b> Production Rate Fixing</b> (SMV × ₹ / min); Production Costing then compares this flat rate with
                  production's operation rates and the actual cost.
                  {cmtAll && <> Cutting rows and Finishing rows are inside this rate, so they are not added again (packing still counts).</>}
                </div>
              </div>
            ) : (
              /* Detailed SMV View */
              <div className="space-y-3">
                <div className="flex items-center justify-between p-2 rounded bg-slate-50 border border-slate-200 text-xs">
                  <span>Optional — counted only in this mode: Total SMV ({totalSmv.toFixed(2)} mins) × Rate/Min</span>
                  <div className="flex items-center gap-2">
                    <TopAddButton testId="sewing" label="Add Operation" onClick={addSewingOp} />
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
                    const opCost = (Number(op.smv) || 0) * (Number(head.smv_rate_per_min) || 0);
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
                <span>Press Enter in the last row's SMV to add the next operation. Name operations as in Process &amp; Operations (Power Table, Singer …) so the Job Rate Card can load these rates.</span>
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
                      [useFlatSewingRate ? (cmtAll ? 'CMT flat (cutting → finishing)' : 'Sewing (flat)') : 'Sewing (SMV)', sewingCostPerPc],
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
                    <span className="font-sans text-slate-700">Target Gross Margin % (on selling price):</span>
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
                    <span className="font-sans text-slate-700">Markup % (on cost) — not the same as margin:</span>
                    <strong className="text-emerald-700">{markupPct.toFixed(2)}%</strong>
                  </div>

                  <div className="flex items-center justify-between border-t border-brand-200 pt-2">
                    <span className="font-sans text-slate-700">Profit Amount Per Piece:</span>
                    <strong className="text-emerald-800 text-sm">₹{profitAmountPerPc.toFixed(2)}</strong>
                  </div>

                  <div className="flex items-center justify-between border-t-2 border-brand-400 pt-3 text-brand-950">
                    <span className="font-sans font-bold text-sm">Quoted FOB Selling Price / Pc{isForeign ? ` (${curCode})` : ''}:</span>
                    <strong className="text-xl font-black text-brand-900" id="pc-summary-fob">
                      {isForeign ? (fobFc != null ? `${curSym}${fobFc.toFixed(4)}` : '—') : `₹${quotedFobPerPc.toFixed(2)}`}
                    </strong>
                  </div>
                  {isForeign && (
                    <div className="flex items-center justify-between text-slate-600">
                      <span className="font-sans">INR value (₹ / pc) @ ₹{fxRate || '—'} per {curCode}:</span>
                      <strong>₹{quotedFobPerPc.toFixed(2)}</strong>
                    </div>
                  )}

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
                      <span>{isForeign && fobFc != null ? `${curSym}${fmtDecimal(fobFc * orderQty, 2)} · ` : ''}₹{fmtDecimal(totalOrderFob, 0)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Certification requirement summary (saved as data_json.cert_summary) */}
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4" id="pc-cert-summary">
              <div className="flex items-center gap-2">
                <BadgeCheck size={16} className="text-emerald-700" />
                <h4 className="font-bold text-sm text-emerald-950">Certifications required</h4>
              </div>
              <p className="mt-0.5 text-[11px] text-emerald-800">
                From the Certification column of the Fabric, Yarn and Trims rows. Saved with the costing; source certified materials for each.
              </p>
              {sheetJson.cert_summary.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">No certified material on this sheet.</p>
              ) : (
                <table className="mt-2 w-full text-left text-xs">
                  <thead className="text-slate-500"><tr><th className="py-1 pr-3 w-32">Certification</th><th className="py-1">Materials</th></tr></thead>
                  <tbody className="divide-y divide-emerald-100">
                    {sheetJson.cert_summary.map((g) => (
                      <tr key={g.certification} data-cert={g.certification}>
                        <td className="py-1.5 pr-3 font-bold text-emerald-900">{g.certification}</td>
                        <td className="py-1.5">
                          {g.materials.map((m, i) => (
                            <span key={`${m.type}-${m.name}`}>
                              {i > 0 && ', '}
                              <span className="text-slate-500">{m.type === 'FABRIC' ? 'Fabric' : m.type === 'YARN' ? 'Yarn' : 'Trim'}</span> {m.name}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
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
                <TopAddButton testId="processes" label="Add Process" onClick={() => addTop(setProcesses, 'processes', { process_name: '', process_type: 'DYEING', basis: 'PER_KG', consumption: '', rate: '' })} />
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
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Cutting Operations</h3>
                <p className="text-xs text-slate-500">Spreading, cutting, numbering / bundling — rate per piece. Total → Cutting head.</p>
                {cmtAll && <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900" data-cmt-covered="cutting">Covered by the flat CMT rate (cutting → finishing) — these rows are not added.</p>}
              </div>
              <TopAddButton testId="cutting" label="Add Operation" onClick={() => addTop(setCuttingOps, 'cutting', { operation: '', rate: '' })} />
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
                {cmtAll && <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900" data-cmt-covered="finishing">Finishing rows are covered by the flat CMT rate (cutting → finishing) and are not added; Packing rows still count.</p>}
              </div>
              <div className="flex gap-2 font-mono text-[11px]">
                <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">Finishing ₹{finishingCostPerPc.toFixed(2)}</span>
                <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">Packing ₹{packingCostPerPc.toFixed(2)}</span>
                <TopAddButton testId="finishing" label="Add Item" onClick={() => addTop(setFinishingItems, 'finishing', { item: '', cost_type: 'FINISHING', qty_per_pc: 1, rate: '' })} />
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
            <div className="flex items-start justify-between gap-2">
              <div>
              <h3 className="text-sm font-bold text-slate-900">Other Direct Charges</h3>
              <p className="text-xs text-slate-500">
                ₹ per PC, % of FOB (e.g. agent commission, finance) or % of direct manufacturing cost
                (₹{calc.manufacturing_direct.toFixed(2)}). % of FOB is solved with the margin: FOB = (Direct + Overhead) ÷ (1 − Margin% − ΣFOB%).
              </p>
              </div>
              <TopAddButton testId="other" label="Add Charge" onClick={() => addTop(setOtherDirect, 'other', { charge_type: 'OTHER', description: '', basis: 'PER_PC', value: '' })} />
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
      </fieldset>
    </div>
  );
}
