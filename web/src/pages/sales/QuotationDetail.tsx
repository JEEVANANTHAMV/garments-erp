import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useJobBoms, bomItemLabel, type JobBomItem } from '../../lib/jobBom';
import { QuotationVersionsButton } from './QuotationVersions';
import {
  ArrowLeft, Plus, Trash2, Save, FileText, Printer, Layers, Sparkles,
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, useStatuses } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import {
  PageHeader, Spinner, Badge, LoadingBlock, ErrorState, Modal,
} from '../../components/ui';
import { fmtDecimal, today, toDateInput } from '../../lib/format';

/* ─────────────────────────────────────────────────────────────── */

const INCOTERMS = ['FOB','CIF','CFR','EXW','DDP','DAP','FCA'].map(v => ({ value: v, label: v }));

const QUOTATION_TYPES = [
  { value: 'FABRIC',   label: 'Fabric Quotation', desc: 'Fabric procurement & job work with Dia, GSM, Colors, GST/IGST' },
  { value: 'YARN',     label: 'Yarn Quotation', desc: 'Spinning mills & yarn procurement with Type, Counts, GST/IGST' },
  { value: 'TRIMS',    label: 'Trims Quotation', desc: 'Accessories, zippers, buttons, labels with Size, Color, GST/IGST' },
  { value: 'GENERAL',  label: 'General / Sample', desc: 'Admin & sundry items, sample cones & buttons (Normal vs I/O Wise)' },
  { value: 'BUYER',    label: 'Buyer Quotation', desc: 'Direct export offer for buyers in Foreign Currency (USD/EUR/GBP)' },
  { value: 'IMPORT',   label: 'Import Quotation', desc: 'For foreign suppliers with CIF & Landed Cost' },
];

const MATERIAL_PROCESSES: Record<string, string[]> = {
  FABRIC: [
    'Fabric Dyeing',
    'Washing',
    'Printing',
    'Compacting / Finishing',
    'Mercerizing',
    'Heat Setting',
    'Brushing / Peaching',
  ],
  YARN: [
    'Knitting',
    'Yarn Dyeing',
    'Twisting',
    'Doubling',
    'Gassing / Mercerizing',
    'Cone Winding',
  ],
  TRIMS: [
    'Button Dyeing',
    'Zipper Dyeing',
    'Label Printing',
    'Custom Coating',
  ],
  GENERAL: [
    'General Job Work',
    'Sample Processing',
    'Sub-contracting',
  ],
};

const GST_OPTIONS = [
  { value: 0,  label: '0%' },
  { value: 5,  label: '5%' },
  { value: 12, label: '12%' },
  { value: 18, label: '18%' },
  { value: 28, label: '28%' },
];

interface QLine {
  _key: string;
  id?: number;
  job_no: string;
  so_id: number | '';
  bom_line_id: number | '';
  material_type: string;
  fabric_id: number | '';
  yarn_id: number | '';
  trim_id: number | '';
  style_id: number | '';
  color_id: number | '';
  size_id: number | '';
  dia: string;
  gsm: string;
  yarn_type: string;
  yarn_count: string;
  trim_size: string;
  description: string;
  qty: number | '';
  uom_id: number | '';
  quotation_rate: number | '';
  confirm_rate: number | '';
  /** BOM / master standard rate — shown as a reference only; the quotation / confirm rate is the supplier's. */
  ref_rate?: number;
  unit_price: number | '';
  gst_rate: number;
  igst_rate: number;
  sort_order: number;
  /** Process quotation: the fabric rolls this line is for (genealogy doc §9 / §18) — qty = their KG. */
  rolls?: QRoll[];
  /** Process quotation costing (doc §17): process + dye / chemical + other = the quoted rate per KG. */
  process_rate?: number | '';
  dye_chem_rate?: number | '';
  other_rate?: number | '';
  /** fabric | state | colour | gsm | dia — rolls of the same group go on one line */
  _group?: string;
}
interface QRoll { fabric_roll_id: number; roll_no: string; qty_kg: number | ''; max_kg?: number; trace?: string }
const rollTrace = (r: any) => [r.production_no ? `prod ${r.production_no}` : null, r.program_no, r.lot_no ? `lot ${r.lot_no}` : null, r.previous_process ? `after ${r.previous_process}` : null].filter(Boolean).join(' · ');
/** Group rolls by fabric, process state, distinct colour, program and geometry */
const rollGroup = (r: any) => `${r.fabric_id}|${r.process_state ?? ''}|${r.color_name || (r.colour && r.colour !== 'GREY' ? r.colour : '') || (r.lot_no ? `lot:${r.lot_no}` : `roll:${r.id}`)}|${r.program_no || ''}|${r.gsm ?? ''}|${r.dia ?? ''}`;
const sumRolls = (rs: QRoll[] | undefined) => Math.round((rs ?? []).reduce((a, r) => a + (Number(r.qty_kg) || 0), 0) * 1000) / 1000;

let keySeq = 0;
const newLine = (sort = 0): QLine => ({
  _key: `q${++keySeq}`,
  job_no: '',
  so_id: '',
  bom_line_id: '',
  material_type: '',
  fabric_id: '',
  yarn_id: '',
  trim_id: '',
  style_id: '',
  color_id: '',
  size_id: '',
  dia: '',
  gsm: '',
  yarn_type: '',
  yarn_count: '',
  trim_size: '',
  description: '',
  qty: '',
  uom_id: '',
  quotation_rate: '',
  confirm_rate: '',
  unit_price: '',
  gst_rate: 0,
  igst_rate: 0,
  sort_order: sort,
});

/** A job (sales order) from GET /procurement/jobs — the "IO No" selector of Load from BOM. */
interface JobOption {
  id: number;
  so_no: string;
  io_no: string | null;
  job_no: string;
  buyer_id?: number | null;
  label: string;
  styles: { style_id: number; style_code: string; style_name: string; plan_cut_qty: number }[];
}

/** Quotation type → BOM material line type(s) it quotes and the master id column. */
const BOM_MATERIAL: Record<string, { key: 'fabric_id' | 'yarn_id' | 'trim_id'; types: string[]; lookup: string; label: string }> = {
  FABRIC: { key: 'fabric_id', types: ['FABRIC'], lookup: 'fabrics', label: 'Fabric' },
  YARN:   { key: 'yarn_id',   types: ['YARN'], lookup: 'yarns', label: 'Yarn' },
  TRIMS:  { key: 'trim_id',   types: ['TRIM', 'ACCESSORY', 'PACKING'], lookup: 'trims', label: 'Trim' },
};

const titleCase = (v: unknown) => {
  const t = String(v ?? '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '';
};

/* ─────────────────────────────────────────────────────────────── */

export default function QuotationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  /* ── head state ── */
  const [head, setHead] = useState<Record<string, any>>({
    quotation_type: 'FABRIC',
    quotation_category: 'PURCHASE',
    process_name: '',
    is_io_wise: 0,
    quotation_date: today(),
    version: 1,
    exchange_rate: 86.50,
    incoterm: 'FOB',
    // Domestic summary
    discount_pct: 0, discount_amount: 0,
    freight_charges: 0, packing_charges: 0, other_charges: 0,
    cgst_rate: 9, sgst_rate: 9, igst_rate: 0, round_off: 0,
    // Import & Buyer summary
    courier_charges: 0, insurance: 0, bank_charges: 0,
    customs_duty: 0, clearing_charges: 0, margin_pct: 0,
  });
  const [lines, setLines] = useState<QLine[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const isBuyer    = head.quotation_type === 'BUYER';
  const isImport   = head.quotation_type === 'IMPORT';
  const isFabric   = head.quotation_type === 'FABRIC';
  const isYarn     = head.quotation_type === 'YARN';
  const isTrims    = head.quotation_type === 'TRIMS';
  const isGeneral  = head.quotation_type === 'GENERAL';
  const isDomesticLike = !isBuyer && !isImport; // FABRIC, YARN, TRIMS, GENERAL, DOMESTIC
  const isProcess  = isDomesticLike && head.quotation_category === 'PROCESS';
  const showJobAndStyle = !isGeneral || Boolean(head.is_io_wise);
  const bomMaterial = BOM_MATERIAL[head.quotation_type as string];   // FABRIC / YARN / TRIMS only

  /* ── lookups ── */
  const buyers     = useLookup('buyers');
  const suppliers  = useLookup('suppliers');
  const currencies = useLookup('currencies');
  const branches   = useLookup('branches');
  const agents     = useLookup('agents');
  const styles     = useLookup('styles');
  const colors     = useLookup('colors');
  const sizes      = useLookup('sizes-all');   // individual sizes
  const uoms       = useLookup('uoms');        // unit of measure
  const gsmLookup  = useLookup('gsm');         // standard GSM values
  const diaLookup  = useLookup('dias');        // tube diameter values
  const yarnCounts = useLookup('yarn-counts'); // yarn counts
  const statuses   = useStatuses('QUOTATION');
  const materials  = useLookup(bomMaterial?.lookup ?? null);   // fabric / yarn / trim masters

  /* ── Load from BOM: job (IO No) → that job's BOM lines of this quotation's material ── */
  const jobs = useQuery({
    queryKey: ['procurement-jobs'],
    queryFn: async () => (await http.get<{ data: JobOption[] }>('/procurement/jobs')).data || [],
    enabled: Boolean(bomMaterial),
    staleTime: 60 * 1000,
  });
  const [bomJobId, setBomJobId] = useState('');
  const [bomStyleId, setBomStyleId] = useState('');
  const [bomLoading, setBomLoading] = useState(false);
  const bomJob = (jobs.data ?? []).find(j => String(j.id) === bomJobId);
  // Line-level pick: each line's own IO + style → that job's BOM items of this quotation's material
  const jobBoms = useJobBoms(bomMaterial ? lines.map(l => ({ so_id: l.so_id, style_id: l.style_id })) : []);
  const jobById = (id: unknown) => (jobs.data ?? []).find(j => j.id === Number(id));
  /** Fills a line from the picked BOM item, keeping its row key and any rate already entered. */
  const pickBomItem = (l: QLine, it: JobBomItem) => {
    const next = bomItemToLine(it, it.job_no, l.sort_order, { _key: l._key, id: l.id, sort_order: l.sort_order } as Partial<QLine>);
    setLine(l._key, { ...next, quotation_rate: Number(l.quotation_rate) > 0 ? l.quotation_rate : next.quotation_rate, confirm_rate: l.confirm_rate });
  };

  const inrCurrency = currencies.data?.find((c: any) => c.code === 'INR');
  const usdCurrency = currencies.data?.find((c: any) => c.code === 'USD');

  // Ensure default currency is set properly based on type
  useEffect(() => {
    if (!currencies.data?.length) return;
    if (isDomesticLike) {
      if ((!head.currency_id || isNew) && inrCurrency) {
        setHead(h => ({ ...h, currency_id: inrCurrency.id, exchange_rate: 1 }));
      }
    } else {
      if ((!head.currency_id || head.currency_id === inrCurrency?.id) && usdCurrency) {
        setHead(h => ({ ...h, currency_id: usdCurrency.id, exchange_rate: Number(h.exchange_rate) > 1 ? h.exchange_rate : 86.50 }));
      }
    }
  }, [currencies.data, isNew, isDomesticLike, inrCurrency, usdCurrency]);

  const handleTypeChange = (type: string) => {
    if (type === 'BUYER') {
      setHead(h => ({
        ...h,
        quotation_type: 'BUYER',
        quotation_category: 'PURCHASE',
        process_name: '',
        is_io_wise: 0,
        currency_id: (h.currency_id && h.currency_id !== inrCurrency?.id) ? h.currency_id : (usdCurrency?.id ?? ''),
        exchange_rate: Number(h.exchange_rate) > 1 ? h.exchange_rate : 86.50,
        incoterm: h.incoterm || 'FOB',
      }));
    } else if (type === 'IMPORT') {
      setHead(h => ({
        ...h,
        quotation_type: 'IMPORT',
        quotation_category: 'PURCHASE',
        process_name: '',
        is_io_wise: 0,
        currency_id: (h.currency_id && h.currency_id !== inrCurrency?.id) ? h.currency_id : (usdCurrency?.id ?? ''),
        exchange_rate: Number(h.exchange_rate) > 1 ? h.exchange_rate : 86.50,
        incoterm: h.incoterm || 'CIF',
      }));
    } else {
      // FABRIC, YARN, TRIMS, GENERAL, DOMESTIC
      setHead(h => ({
        ...h,
        quotation_type: type,
        process_name: h.quotation_category === 'PROCESS' ? (MATERIAL_PROCESSES[type]?.[0] || 'Job Work') : '',
        currency_id: inrCurrency?.id ?? 1,
        exchange_rate: 1,
      }));
    }
  };

  /* ── load existing ── */
  const detail = useQuery({
    queryKey: ['quotations', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/quotations/${id}`)).data,
    enabled: !isNew,
  });

  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data;
    setHead({
      ...d,
      quotation_category: d.quotation_category || 'PURCHASE',
      process_name: d.process_name || '',
      quotation_date: toDateInput(d.quotation_date),
      valid_until: toDateInput(d.valid_until),
      is_io_wise: d.is_io_wise ? 1 : 0,
    });
    setLines(
      (d.lines ?? []).map((l: any, i: number) => ({
        _key: `q${++keySeq}`,
        id: l.id,
        job_no: l.job_no ?? '',
        so_id: l.so_id ?? '',
        bom_line_id: l.bom_line_id ?? '',
        material_type: l.material_type ?? '',
        fabric_id: l.fabric_id ?? '',
        yarn_id: l.yarn_id ?? '',
        trim_id: l.trim_id ?? '',
        style_id: l.style_id ?? '',
        color_id: l.color_id ?? '',
        size_id: l.size_id ?? '',
        dia: l.dia ?? '',
        gsm: l.gsm ?? '',
        yarn_type: l.yarn_type ?? '',
        yarn_count: l.yarn_count ?? '',
        trim_size: l.trim_size ?? '',
        description: l.description ?? '',
        qty: l.qty !== null && l.qty !== undefined ? Number(l.qty) : '',
        uom_id: l.uom_id ?? '',
        quotation_rate: l.quotation_rate !== null && l.quotation_rate !== undefined ? Number(l.quotation_rate) : (Number(l.unit_price) || ''),
        confirm_rate: l.confirm_rate !== null && l.confirm_rate !== undefined ? Number(l.confirm_rate) : '',
        unit_price: Number(l.unit_price) || '',
        gst_rate: Number(l.gst_rate ?? 0),
        igst_rate: Number(l.igst_rate ?? 0),
        sort_order: i,
        process_rate: l.process_rate != null ? Number(l.process_rate) : '',
        dye_chem_rate: l.dye_chem_rate != null ? Number(l.dye_chem_rate) : '',
        other_rate: l.other_rate != null ? Number(l.other_rate) : '',
      }))
    );
    // the rolls of each line (by its position)
    if (d.quotation_category === 'PROCESS') {
      void http.get<{ data: any[] }>(`/quotations/${d.id}/rolls`).then((r) => {
        const rows = r.data ?? [];
        if (!rows.length) return;
        setLines((ls) => ls.map((l, i) => {
          const mine = rows.filter((x) => Number(x.line_sort) === i);
          return mine.length ? { ...l, _group: rollGroup(mine[0]), rolls: mine.map((x) => ({ fabric_roll_id: Number(x.fabric_roll_id), roll_no: x.roll_no, qty_kg: Number(x.qty_kg), trace: rollTrace(x) })) } : l;
        }));
      }).catch(() => {});
    }
  }, [detail.data]);

  /* ── Rate helper: Confirm Rate takes precedence over Quotation Rate ── */
  const getEffectiveRate = (l: QLine) => {
    const cr = Number(l.confirm_rate);
    if (cr > 0) return cr;
    const qr = Number(l.quotation_rate);
    if (qr > 0) return qr;
    return Number(l.unit_price) || 0;
  };

  /* ── computed totals ── */
  const calc = useMemo(() => {
    const basicAmount = lines.reduce((sum, l) => {
      const q = Number(l.qty) || 0;
      const r = getEffectiveRate(l);
      return sum + q * r;
    }, 0);

    if (isDomesticLike) {
      // Domestic / Procurement
      const discAmt = basicAmount * ((Number(head.discount_pct) || 0) / 100);
      const freight = Number(head.freight_charges) || 0;
      const packing = Number(head.packing_charges) || 0;
      const other   = Number(head.other_charges)   || 0;
      const taxableValue = Math.max(0, basicAmount - discAmt + freight + packing + other);

      let totalCgst = 0;
      let totalSgst = 0;
      let totalIgst = 0;

      const gstGroups: Record<number, number> = {};
      const igstGroups: Record<number, number> = {};

      lines.forEach(l => {
        const amt = (Number(l.qty) || 0) * getEffectiveRate(l);
        const gRate = Number(l.gst_rate) || 0;
        const iRate = Number(l.igst_rate) || 0;

        if (iRate > 0) {
          igstGroups[iRate] = (igstGroups[iRate] || 0) + amt;
        } else if (gRate > 0) {
          gstGroups[gRate] = (gstGroups[gRate] || 0) + amt;
        }
      });

      const gstBreakdown = Object.entries(gstGroups).map(([rate, base]) => {
        const numRate = Number(rate);
        const cgst = base * (numRate / 2 / 100);
        const sgst = base * (numRate / 2 / 100);
        totalCgst += cgst;
        totalSgst += sgst;
        return { rate: numRate, baseAmt: base, cgst, sgst };
      });

      const igstBreakdown = Object.entries(igstGroups).map(([rate, base]) => {
        const numRate = Number(rate);
        const igst = base * (numRate / 100);
        totalIgst += igst;
        return { rate: numRate, baseAmt: base, igst };
      });

      const totalGst = totalCgst + totalSgst + totalIgst;
      const grandTotal = taxableValue + totalGst + (Number(head.round_off) || 0);

      return {
        basicAmount, discAmt, taxableValue,
        totalCgst, totalSgst, totalIgst, totalGst,
        grandTotal, gstBreakdown, igstBreakdown,
        totalAmount: grandTotal,
      };
    } else if (isBuyer) {
      // Buyer Export Quotation
      const discAmt  = basicAmount * ((Number(head.discount_pct) || 0) / 100);
      const freight  = Number(head.freight_charges)  || 0;
      const insure   = Number(head.insurance)        || 0;
      const packing  = Number(head.packing_charges)  || 0;
      const other    = Number(head.other_charges)     || 0;
      const finalOffer = Math.max(0, basicAmount - discAmt + freight + insure + packing + other);
      const rate = Number(head.exchange_rate) || 1;
      const inrEquivalent = finalOffer * rate;
      return { basicAmount, discAmt, finalOffer, inrEquivalent, totalAmount: finalOffer };
    } else {
      // Import
      const courier  = Number(head.courier_charges)  || 0;
      const freight  = Number(head.freight_charges)  || 0;
      const insure   = Number(head.insurance)        || 0;
      const packing  = Number(head.packing_charges)  || 0;
      const bank     = Number(head.bank_charges)     || 0;
      const customs  = Number(head.customs_duty)      || 0;
      const clearing = Number(head.clearing_charges)  || 0;
      const other    = Number(head.other_charges)     || 0;
      const landedCost = basicAmount + courier + freight + insure + packing + bank + customs + clearing + other;
      const marginAmt  = landedCost * ((Number(head.margin_pct) || 0) / 100);
      const finalSelling = landedCost + marginAmt;
      return { basicAmount, landedCost, marginAmt, finalSelling, totalAmount: finalSelling };
    }
  }, [lines, head, isDomesticLike, isBuyer]);

  /* ── helpers ── */
  const hSet = (k: string, v: any) => setHead(h => ({ ...h, [k]: v }));
  const err = (k: string) => errors[k] ? <p className="text-[11px] text-red-500 mt-0.5">{errors[k]}</p> : null;

  /* ── line helpers ── */
  const addLine = () => setLines(ls => [...ls, newLine(ls.length)]);
  const removeLine = (key: string) => setLines(ls => ls.length > 1 ? ls.filter(l => l._key !== key) : ls);
  const setLine = (key: string, patch: Partial<QLine>) =>
    setLines(ls => ls.map(l => l._key === key ? { ...l, ...patch } : l));

  /** Quotation line from a BOM item of a job (qty = BOM requirement). The rate is NOT taken from the BOM: the
   *  quotation rate / confirm rate are what the supplier quoted (client 03-Oct-2026); the BOM's standard rate is only a reference. */
  function bomItemToLine(it: any, jobNo: string | null | undefined, i: number, keep?: Partial<QLine>): QLine {
    if (!bomMaterial) return { ...newLine(i), ...(keep ?? {}) };
    const rate = Number(it.std_rate) || 0;
    const base: QLine = {
      ...newLine(i), ...(keep ?? {}),
      job_no: it.job_no || jobNo || '',
      so_id: it.so_id ?? '',
      bom_line_id: it.bom_line_id ?? '',
      material_type: it.material_type,
      style_id: it.style_id ?? '',
      color_id: it.color_id ?? '',
      size_id: it.size_id ?? '',
      qty: Number(it.final_requirement ?? it.order_required_qty) || '',
      uom_id: it.uom_id ?? '',
      quotation_rate: '',
      ref_rate: rate > 0 ? rate : undefined,
    };
    if (bomMaterial.key === 'fabric_id') {
      return { ...base, fabric_id: it.fabric_id,
        description: [it.fabric_name, it.item_description].filter(Boolean).join(' — '),
        dia: it.fabric_dia ? `${Number(it.fabric_dia)}"` : '',
        gsm: it.fabric_gsm ? String(it.fabric_gsm) : '' };
    }
    if (bomMaterial.key === 'yarn_id') {
      return { ...base, yarn_id: it.yarn_id,
        description: [it.yarn_name, it.item_description].filter(Boolean).join(' — '),
        yarn_type: titleCase(it.yarn_master_type),
        yarn_count: it.yarn_count || '' };
    }
    return { ...base, trim_id: it.trim_id,
      description: [it.trim_name, it.specification || it.trim_specification || it.item_description].filter(Boolean).join(' — '),
      trim_size: it.size_code || '' };
  }

  /*
   * Process (job-work) quotation: the job's ACTUAL material, not the BOM (client 03-Oct-2026 — a job whose BOM has
   * only yarn still has fabric once it is knitted; a dyeing quotation must come from the job's available fabric rolls).
   */
  const isProcessQuote = head.quotation_category === 'PROCESS' && (head.quotation_type === 'FABRIC' || head.quotation_type === 'YARN');
  const [actual, setActual] = useState<null | { kind: 'FABRIC' | 'YARN'; job: any; groups: any[]; rolls: any[]; pick: Record<string, number | ''> }>(null);
  const [scanRoll, setScanRoll] = useState('');
  async function loadJobActual() {
    if (!bomJobId) { toast('Select the IO No (job) first', 'warning'); return; }
    setBomLoading(true);
    try {
      const kind = head.quotation_type === 'YARN' ? 'YARN' : 'FABRIC';
      // dyeing takes grey fabric; other processes (washing, compacting …) any state
      const dye = /dye/i.test(head.process_name || '');
      const d = kind === 'FABRIC'
        ? (await http.get<{ data: any }>(`/jobs/${bomJobId}/fabric-availability?${new URLSearchParams({ ...(dye ? { state: 'GREY' } : {}), ...(!isNew && id ? { exclude_quotation_id: String(id) } : {}) })}`)).data
        : (await http.get<{ data: any }>(`/jobs/${bomJobId}/yarn-availability`)).data;
      if (!d.groups.length) {
        toast(kind === 'FABRIC' ? `Job ${d.job.job_no} has no ${dye ? 'grey ' : ''}fabric in stock yet (knit it / receive it first)` : `Job ${d.job.job_no} holds no yarn`, 'warning');
        return;
      }
      // fabric: pick roll by roll (doc §9.1 "select required rolls / quantity"); yarn: by lot group
      const rolls = kind === 'FABRIC' ? [...(d.rolls ?? [])].sort((a: any, b: any) => rollGroup(a).localeCompare(rollGroup(b)) || a.id - b.id) : [];
      setActual({ kind, job: d.job, groups: d.groups, rolls,
        pick: kind === 'FABRIC' ? Object.fromEntries(rolls.map((r: any) => [String(r.id), r.available_kg])) : Object.fromEntries(d.groups.map((g: any) => [g.key, g.available_kg])) });
    } catch (e: any) {
      toast(e instanceof ApiError ? e.message : 'Could not load the job\'s material', 'error');
    } finally { setBomLoading(false); }
  }
  /** Scan / type a roll no: reverse-traced to its job; added to the line of the same fabric / state / colour (doc §9.2). */
  const [rollChoice, setRollChoice] = useState<any[] | null>(null);
  async function addScannedRoll(rollId?: number) {
    const no = scanRoll.trim();
    if (!no && !rollId) return;
    try {
      const r = (await http.get<{ data: any }>(`/fabric-rolls/lookup?${new URLSearchParams({ ...(rollId ? { roll_id: String(rollId) } : { roll_no: no }), process: head.process_name || '',
        ...(bomJobId ? { so_id: bomJobId } : {}), ...(!isNew && id ? { exclude_quotation_id: String(id) } : {}) })}`)).data;
      if (r.ambiguous) { setRollChoice(r.candidates); return; }
      setRollChoice(null);
      if (lines.some((l) => (l.rolls ?? []).some((x) => x.fabric_roll_id === Number(r.id)))) { toast(`${r.roll_no} is already on this quotation`, 'warning'); return; }
      if (!r.eligible) { toast(`${r.roll_no}: ${r.problems.join('; ')}`, 'error'); return; }
      const kg = (uoms.data ?? []).find((u: any) => String(u.code).toUpperCase() === 'KG')?.id ?? '';
      const roll: QRoll = { fabric_roll_id: Number(r.id), roll_no: r.roll_no, qty_kg: r.available_kg, max_kg: r.available_kg, trace: rollTrace(r) };
      const grp = rollGroup(r);
      setLines((ls) => {
        const at = ls.findIndex((l) => l._group === grp && Number(l.so_id) === Number(r.so_id));
        if (at >= 0) return ls.map((l, i) => { if (i !== at) return l; const rolls = [...(l.rolls ?? []), roll]; return { ...l, rolls, qty: sumRolls(rolls), description: l.description.replace(/· \d+ roll\(s\)/, `· ${rolls.length} roll(s)`) }; });
        const blank = ls.length === 1 && !ls[0].description && !ls[0].qty && !ls[0].fabric_id;
        const line: QLine = { ...newLine(ls.length), job_no: r.job_no, so_id: Number(r.so_id), material_type: 'FABRIC', fabric_id: r.fabric_id, dia: r.dia ?? '', gsm: r.gsm != null ? String(r.gsm) : '',
          uom_id: kg as any, rolls: [roll], qty: r.available_kg, _group: grp, description: `${r.fabric_name ?? 'Fabric'} · ${r.process_state}${r.color_name ? ` ${r.color_name}` : ''} · 1 roll(s)` };
        return blank ? [line] : [...ls, line];
      });
      setHead((h) => ({ ...h, job_no: h.job_no || r.job_no }));
      toast(`${r.roll_no} → job ${r.job_no}${r.buyer_name ? ` · ${r.buyer_name}` : ''}${r.styles ? ` · ${r.styles}` : ''} · ${r.fabric_name} · ${r.available_kg} KG`, 'success');
      setScanRoll('');
    } catch (e: any) { toast(e instanceof ApiError ? e.message : 'Roll not found', 'error'); }
  }
  const setRollKg = (key: string, rollId: number, v: number | '') => setLines((ls) => ls.map((l) => {
    if (l._key !== key) return l;
    const rolls: QRoll[] = (l.rolls ?? []).map((r): QRoll => (r.fabric_roll_id === rollId ? { ...r, qty_kg: v === '' ? '' : (r.max_kg != null ? Math.min(Number(v), r.max_kg) : Number(v)) } : r));
    return { ...l, rolls, qty: sumRolls(rolls) };
  }));
  const dropRoll = (key: string, rollId: number) => setLines((ls) => ls.map((l) => {
    if (l._key !== key) return l;
    const rolls = (l.rolls ?? []).filter((r) => r.fabric_roll_id !== rollId);
    return { ...l, rolls, qty: rolls.length ? sumRolls(rolls) : l.qty };
  }));
  const setBreakup = (key: string, patch: Partial<QLine>) => setLines((ls) => ls.map((l) => {
    if (l._key !== key) return l;
    const n2 = { ...l, ...patch };
    const parts = [n2.process_rate, n2.dye_chem_rate, n2.other_rate];
    return parts.some((x) => x !== '' && x != null) ? { ...n2, quotation_rate: Math.round(parts.reduce((a: number, x) => a + (Number(x) || 0), 0) * 100) / 100 } : n2;
  }));

  function applyJobActual() {
    if (!actual) return;
    const kg = (uoms.data ?? []).find((u: any) => String(u.code).toUpperCase() === 'KG')?.id ?? '';
    const st = bomJob && bomJob.styles.length === 1 ? bomJob.styles[0].style_id : (bomStyleId ? Number(bomStyleId) : '');
    if (actual.kind === 'FABRIC') {
      const picked = actual.rolls.filter((r) => Number(actual.pick[String(r.id)]) > 0);
      if (!picked.length) { toast('Tick at least one roll with KG', 'warning'); return; }
      const byGroup = new Map<string, any[]>();
      for (const r of picked) byGroup.set(rollGroup(r), [...(byGroup.get(rollGroup(r)) ?? []), r]);
      const next: QLine[] = [...byGroup.entries()].map(([grp, rs], i) => {
        const r0 = rs[0];
        const rolls: QRoll[] = rs.map((r) => ({ fabric_roll_id: Number(r.id), roll_no: r.roll_no, qty_kg: Number(actual.pick[String(r.id)]), max_kg: r.available_kg, trace: rollTrace(r) }));
        const resolvedColor = r0.color_name || (r0.colour && r0.colour !== 'GREY' ? r0.colour : '');
        return { ...newLine(i), job_no: actual.job.job_no, so_id: actual.job.id, style_id: st as any, material_type: 'FABRIC', fabric_id: r0.fabric_id, dia: r0.dia ?? '', gsm: r0.gsm != null ? String(r0.gsm) : '',
          uom_id: kg as any, rolls, qty: sumRolls(rolls), _group: grp,
          description: `${r0.fabric_name ?? 'Fabric'} · ${resolvedColor ? `${resolvedColor} · ` : ''}${r0.process_state} · ${rs.length} roll(s)${r0.program_no ? ` (${r0.program_no})` : ''}` };
      });
      const hasEntered = lines.some(l => l.description || l.qty || l.fabric_id || l.yarn_id);
      if (hasEntered && !window.confirm(`Replace the ${lines.length} existing line(s)?`)) return;
      setLines(next);
      setHead(h => ({ ...h, job_no: actual.job.job_no, buyer_id: h.buyer_id || bomJob?.buyer_id || h.buyer_id }));
      toast(`${next.length} line(s) with ${picked.length} roll(s) loaded from job ${actual.job.job_no}`, 'success');
      setActual(null);
      return;
    }
    const chosen = actual.groups.filter((g) => Number(actual.pick[g.key]) > 0);
    if (!chosen.length) { toast('Tick at least one line with KG', 'warning'); return; }
    const next: QLine[] = chosen.map((g, i) => {
      const base: QLine = { ...newLine(i), job_no: actual.job.job_no, so_id: actual.job.id, style_id: st as any, material_type: actual.kind, qty: Number(actual.pick[g.key]), uom_id: kg as any };
      return actual.kind === 'FABRIC'
        ? { ...base, fabric_id: g.fabric_id, dia: g.dia ?? '', gsm: g.gsm != null ? String(g.gsm) : '',
            description: `${g.fabric_name ?? 'Fabric'} · ${g.process_state}${g.colour && g.colour !== 'GREY' ? ` ${g.colour}` : ''} · ${g.rolls} roll(s)${g.programs ? ` · ${g.programs}` : ''}` }
        : { ...base, yarn_id: g.yarn_id, yarn_count: g.count_str ?? '', description: `${g.yarn_name ?? 'Yarn'}${g.shade ? ` · ${g.shade}` : ''} · lot ${g.lot_nos}` };
    });
    const hasEntered = lines.some(l => l.description || l.qty || l.fabric_id || l.yarn_id);
    if (hasEntered && !window.confirm(`Replace the ${lines.length} existing line(s)?`)) return;
    setLines(next);
    setHead(h => ({ ...h, job_no: actual.job.job_no, buyer_id: h.buyer_id || bomJob?.buyer_id || h.buyer_id }));
    toast(`${next.length} line(s) loaded from job ${actual.job.job_no}'s actual yarn`, 'success');
    setActual(null);
  }

  /** Fills the line items from the selected job's BOM (only this quotation's material type). */
  async function loadFromBom() {
    if (!bomMaterial) return;
    if (!bomJobId) { toast('Select the IO No (job) first', 'warning'); return; }
    setBomLoading(true);
    try {
      const qs = new URLSearchParams({ so_id: bomJobId });
      if (bomStyleId) qs.set('style_id', bomStyleId);
      const data = (await http.get<{ data: any }>(`/boms/for-job?${qs.toString()}`)).data;
      (data?.warnings || []).forEach((w: string) => toast(w, 'warning'));
      const items: any[] = (data?.lines || []).filter((it: any) =>
        bomMaterial.types.includes(it.material_type) && it[bomMaterial.key]);
      if (!items.length) {
        toast(`The BOM of job ${data?.job_no || ''} has no ${bomMaterial.label.toLowerCase()} items`, 'warning');
        return;
      }
      const hasEntered = lines.some(l => l.description || l.qty || l.fabric_id || l.yarn_id || l.trim_id);
      if (hasEntered && !window.confirm(`Replace the ${lines.length} existing line(s) with ${items.length} ${bomMaterial.label.toLowerCase()} item(s) from the BOM?`)) return;

      setLines(items.map((it, i) => bomItemToLine(it, data.job_no, i)));
      setHead(h => ({
        ...h,
        job_no: data.job_no || h.job_no,
        buyer_id: h.buyer_id || bomJob?.buyer_id || h.buyer_id,
      }));
      toast(`Loaded ${items.length} ${bomMaterial.label.toLowerCase()} item(s) from BOM ${data.bom?.bom_no || ''}`, 'success');
    } catch (e: any) {
      toast(e instanceof ApiError ? e.message : 'Failed to load the BOM of this job', 'error');
    } finally {
      setBomLoading(false);
    }
  }

  /* ── save ── */
  async function handleSave(asDraft = false) {
    const errs: Record<string, string> = {};
    if (!head.quotation_date) errs.quotation_date = 'Required';
    const resolvedCurrencyId = isDomesticLike
      ? (inrCurrency?.id ?? head.currency_id ?? 1)
      : head.currency_id;

    if (!resolvedCurrencyId) errs.currency_id = 'Required';

    // Party validation
    if (isBuyer && !head.buyer_id) {
      errs.buyer_id = 'Customer / Buyer is required';
    } else if (isImport && !head.supplier_id) {
      errs.supplier_id = 'Supplier is required';
    } else if (isDomesticLike && !head.supplier_id && !head.buyer_id) {
      errs.supplier_id = 'Supplier / Vendor is required';
    }

    if (lines.some(l => !l.qty || (!l.confirm_rate && !l.quotation_rate && !l.unit_price))) {
      errs.lines = 'All lines need Quantity and at least Quotation Rate or Confirm Rate';
    }

    setErrors(errs);
    if (Object.keys(errs).length) return;

    // Build payload
    const totalAmt = (calc as any).totalAmount || 0;
    const payload = {
      ...head,
      quotation_category: isDomesticLike ? (head.quotation_category || 'PURCHASE') : 'PURCHASE',
      process_name: (isDomesticLike && head.quotation_category === 'PROCESS') ? (head.process_name || null) : null,
      is_io_wise: isGeneral ? (head.is_io_wise ? 1 : 0) : 0,
      currency_id: Number(resolvedCurrencyId),
      exchange_rate: isDomesticLike ? 1 : Number(head.exchange_rate || 1),
      total_amount: totalAmt,
      taxable_value: isDomesticLike ? (calc as any).taxableValue : undefined,
      landed_cost: isImport ? (calc as any).landedCost : undefined,
      final_selling_rate: isImport ? (calc as any).finalSelling : (isBuyer ? (calc as any).finalOffer : undefined),
      lines: lines.map((l, i) => {
        const rate = getEffectiveRate(l);
        const qRate = Number(l.quotation_rate) || Number(l.unit_price) || 0;
        const cRate = Number(l.confirm_rate) || 0;
        const lineAmt = (Number(l.qty) || 0) * rate;
        const gRate = isDomesticLike ? (Number(l.gst_rate) || 0) : 0;
        const iRate = isDomesticLike ? (Number(l.igst_rate) || 0) : 0;

        return {
          id: l.id,
          job_no: l.job_no || null,
          so_id: l.so_id || null,
          bom_line_id: l.bom_line_id || null,
          material_type: bomMaterial ? (l.material_type || bomMaterial.types[0]) : (l.material_type || null),
          fabric_id: bomMaterial?.key === 'fabric_id' ? (l.fabric_id || null) : null,
          yarn_id: bomMaterial?.key === 'yarn_id' ? (l.yarn_id || null) : null,
          trim_id: bomMaterial?.key === 'trim_id' ? (l.trim_id || null) : null,
          style_id: l.style_id || null,
          color_id: l.color_id || null,
          size_id: l.size_id || null,
          dia: l.dia || null,
          gsm: l.gsm || null,
          yarn_type: l.yarn_type || null,
          yarn_count: l.yarn_count || null,
          trim_size: l.trim_size || null,
          description: l.description || null,
          qty: Number(l.qty),
          uom_id: l.uom_id || null,
          unit_price: rate,
          quotation_rate: qRate,
          confirm_rate: cRate,
          gst_rate: gRate,
          gst_amount: gRate > 0 ? (lineAmt * (gRate / 100)) : 0,
          igst_rate: iRate,
          igst_amount: iRate > 0 ? (lineAmt * (iRate / 100)) : 0,
          amount: lineAmt,
          sort_order: i,
          process_rate: l.process_rate === '' || l.process_rate == null ? null : Number(l.process_rate),
          dye_chem_rate: l.dye_chem_rate === '' || l.dye_chem_rate == null ? null : Number(l.dye_chem_rate),
          other_rate: l.other_rate === '' || l.other_rate == null ? null : Number(l.other_rate),
          rolls: (l.rolls ?? []).map((r) => ({ fabric_roll_id: r.fabric_roll_id, qty_kg: Number(r.qty_kg) || 0 })),
        };
      }),
    };

    setSaving(true);
    try {
      if (isNew) {
        const res = await http.post<{ data: { id: number } }>('/quotations', payload);
        toast(asDraft ? 'Quotation saved as Draft' : 'Quotation created', 'success');
        qc.invalidateQueries({ queryKey: ['quotations'] });
        nav(`/sales/quotations/${res.data.id}`, { replace: true });
      } else {
        await http.put(`/quotations/${id}`, payload);
        toast(asDraft ? 'Quotation saved as Draft' : 'Quotation saved', 'success');
        qc.invalidateQueries({ queryKey: ['quotations', 'item', id] });
        qc.invalidateQueries({ queryKey: ['quotations'] });   // incl. the versions list (V1, V2 …)
      }
    } catch (e: any) {
      toast(e?.message ?? 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  /* ── loading ── */
  if (!isNew && detail.isLoading) return <LoadingBlock label="Loading quotation…" />;
  if (!isNew && detail.isError)   return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;

  const selectedCur = currencies.data?.find((c: any) => c.id === Number(head.currency_id));
  const currCode: string = isDomesticLike ? 'INR' : String(selectedCur?.code || 'USD');
  const currSymbol: string = isDomesticLike
    ? '₹'
    : String(selectedCur?.symbol || (currCode === 'USD' ? '$' : currCode === 'EUR' ? '€' : currCode === 'GBP' ? '£' : currCode));

  // Footer alignment: S.No + I/O & Style + material master + type-specific columns
  const colsBeforeQty = 1 + (showJobAndStyle ? 2 : 0) + (bomMaterial ? 1 : 0)
    + (isFabric ? 4 : isYarn ? 3 : isTrims ? 3 : isGeneral ? 1 : (isBuyer || isImport) ? 3 : 0);

  const typeBadgeTone = isBuyer ? 'emerald' : isImport ? 'violet' : isFabric ? 'sky' : isYarn ? 'amber' : isTrims ? 'rose' : 'slate';
  const typeLabel = QUOTATION_TYPES.find(t => t.value === head.quotation_type)?.label || 'Quotation';

  /* ── render ── */
  return (
    <>
      <PageHeader
        breadcrumb={['Sales', 'Quotations']}
        title={
          <div className="flex items-center gap-2.5">
            <span>{isNew ? 'New Quotation' : (head.quotation_no || 'Quotation')}</span>
            <Badge tone={typeBadgeTone}>
              {typeLabel}
            </Badge>
            {isGeneral && Boolean(head.is_io_wise) && (
              <Badge tone="cyan">I/O Wise Job Costing</Badge>
            )}
          </div>
        }
        subtitle={isNew ? 'Create quotation with dynamic fields for Fabric, Yarn, Trims, General, Buyer & Import'
          : `Version ${head.version || 1} • ${head.quotation_date || ''}${(head as any).prepared_by_name ? ` • Prepared by ${(head as any).prepared_by_name}` : ''}${(head as any).approved_by_name ? ` • Approved by ${(head as any).approved_by_name}${(head as any).approved_at ? ` on ${String((head as any).approved_at).slice(0, 10)}` : ''}` : (head as any).status_code && (head as any).status_code !== 'ACCEPTED' ? ' • Not approved yet' : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary" onClick={() => nav('/sales/quotations')}>
              <ArrowLeft size={15} /> Back
            </button>
            {!isNew && <QuotationVersionsButton quotationId={Number(id)} currentLines={lines} />}
            {!isNew && (
              <button className="btn-secondary" onClick={() => window.print()}>
                <Printer size={15} /> Print
              </button>
            )}
            <button className="btn-secondary" onClick={() => handleSave(true)} disabled={saving}>
              {saving ? <Spinner size={15} /> : <FileText size={15} />} Save as Draft
            </button>
            <button className="btn-primary" onClick={() => handleSave(false)} disabled={saving}>
              {saving ? <Spinner size={15} /> : <Save size={15} />}
              {isNew ? 'Submit Quotation' : 'Save Changes'}
            </button>
          </div>
        }
      />

      {/* ── Quotation Type Switcher Banner ── */}
      <div className="card mb-4 p-3 bg-white">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <Layers size={13} className="text-brand-600" /> Select Quotation Classification
          </span>
          <span className="text-[11px] text-slate-400 font-medium">Fields and calculations adapt automatically</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {QUOTATION_TYPES.map(t => {
            const active = head.quotation_type === t.value;
            let activeColor = 'border-brand-500 bg-brand-50/80 text-brand-900 ring-1 ring-brand-400';
            let dotColor = 'border-brand-600 bg-brand-600';

            if (t.value === 'FABRIC') {
              activeColor = 'border-sky-500 bg-sky-50/90 text-sky-950 ring-1 ring-sky-400';
              dotColor = 'border-sky-600 bg-sky-600';
            } else if (t.value === 'YARN') {
              activeColor = 'border-amber-500 bg-amber-50/90 text-amber-950 ring-1 ring-amber-400';
              dotColor = 'border-amber-600 bg-amber-600';
            } else if (t.value === 'TRIMS') {
              activeColor = 'border-rose-500 bg-rose-50/90 text-rose-950 ring-1 ring-rose-400';
              dotColor = 'border-rose-600 bg-rose-600';
            } else if (t.value === 'GENERAL') {
              activeColor = 'border-slate-600 bg-slate-100 text-slate-900 ring-1 ring-slate-500';
              dotColor = 'border-slate-700 bg-slate-700';
            } else if (t.value === 'BUYER') {
              activeColor = 'border-emerald-500 bg-emerald-50/90 text-emerald-950 ring-1 ring-emerald-400';
              dotColor = 'border-emerald-600 bg-emerald-600';
            } else if (t.value === 'IMPORT') {
              activeColor = 'border-violet-500 bg-violet-50/90 text-violet-950 ring-1 ring-violet-400';
              dotColor = 'border-violet-600 bg-violet-600';
            }

            return (
              <button
                key={t.value}
                type="button"
                onClick={() => handleTypeChange(t.value)}
                className={`p-2.5 rounded-lg border text-left transition-all flex flex-col justify-between ${
                  active
                    ? `${activeColor} shadow-sm`
                    : 'border-surface-border bg-slate-50/50 text-slate-600 hover:bg-slate-100 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <p className="text-xs font-bold">{t.label}</p>
                  <span className={`h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center ${
                    active ? dotColor : 'border-slate-300'
                  }`}>
                    {active && <span className="h-1 w-1 rounded-full bg-white" />}
                  </span>
                </div>
                <p className="text-[10.5px] text-slate-500 leading-snug line-clamp-2">{t.desc}</p>
              </button>
            );
          })}
        </div>

        {/* ── Quotation Purpose: Purchase vs Process (Job Work) ── */}
        {isDomesticLike && (
          <div className="mt-3 pt-3 border-t border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-700">
                  Quotation Purpose:
                </span>
                <div className="inline-flex rounded-lg bg-slate-100 p-0.5 border border-slate-300">
                  <button
                    type="button"
                    onClick={() => setHead(h => ({ ...h, quotation_category: 'PURCHASE', process_name: '' }))}
                    className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${
                      head.quotation_category !== 'PROCESS'
                        ? 'bg-white text-brand-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    📦 Material Purchase Quotation (Default)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const defaultProc = MATERIAL_PROCESSES[head.quotation_type]?.[0] || 'Job Work';
                      setHead(h => ({
                        ...h,
                        quotation_category: 'PROCESS',
                        process_name: h.process_name || defaultProc,
                      }));
                    }}
                    className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${
                      head.quotation_category === 'PROCESS'
                        ? 'bg-amber-600 text-white shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    ⚙️ Process / Job Work Quotation
                  </button>
                </div>
              </div>

              {head.quotation_category === 'PROCESS' && (
                <span className="text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-300 px-2.5 py-0.5 rounded-full">
                  Rates represent Job Work / Processing charges ({currSymbol}/Kg or {currSymbol}/Unit)
                </span>
              )}
            </div>

            {/* If PROCESS is selected, show category-specific process badges and custom input */}
            {head.quotation_category === 'PROCESS' && (
              <div className="mt-2.5 rounded-lg bg-amber-50/80 border border-amber-200 p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-bold text-amber-900 mr-1 flex items-center gap-1">
                    <Sparkles size={13} className="text-amber-600" />
                    Select {head.quotation_type} Process:
                  </span>
                  {(MATERIAL_PROCESSES[head.quotation_type] || []).map((proc) => {
                    const sel = head.process_name === proc;
                    return (
                      <button
                        key={proc}
                        type="button"
                        onClick={() => setHead(h => ({ ...h, process_name: proc }))}
                        className={`px-2.5 py-1 text-xs font-bold rounded-md transition-all border ${
                          sel
                            ? 'bg-amber-600 text-white border-amber-700 shadow-xs'
                            : 'bg-white text-slate-700 border-amber-200 hover:bg-amber-100'
                        }`}
                      >
                        {sel ? `✓ ${proc}` : proc}
                      </button>
                    );
                  })}
                  <div className="ml-auto flex items-center gap-1">
                    <span className="text-[11px] text-amber-800 font-medium">Other Process:</span>
                    <input
                      type="text"
                      placeholder="e.g. Specialty Finish"
                      value={head.process_name || ''}
                      onChange={(e) => setHead(h => ({ ...h, process_name: e.target.value }))}
                      className="text-xs px-2 py-1 rounded border border-amber-300 bg-white font-medium text-slate-800 focus:outline-none focus:border-amber-500 w-44"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Sub-Toggle for GENERAL Quotation: Normal vs I/O Wise ── */}
        {isGeneral && (
          <div className="mt-3 pt-3 border-t border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 bg-slate-50 p-2.5 rounded-lg">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-brand-600 shrink-0" />
              <div>
                <p className="text-xs font-bold text-slate-800">General Quotation Mode</p>
                <p className="text-[11px] text-slate-500">
                  {head.is_io_wise
                    ? '🎯 I/O Wise Mode: Sample materials or testing cones/buttons charged to a specific Internal Job Order'
                    : '🏢 Normal Mode: General administration, consumables & stock materials'}
                </p>
              </div>
            </div>

            <div className="flex items-center rounded-lg border border-slate-300 bg-white p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => hSet('is_io_wise', 0)}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  !head.is_io_wise ? 'bg-brand-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Normal Mode
              </button>
              <button
                type="button"
                onClick={() => hSet('is_io_wise', 1)}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  head.is_io_wise ? 'bg-cyan-700 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                I/O Wise (Job Costing)
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start w-full mb-6">
        {/* ── LEFT (Cols 1-8 / xl:1-9): Header Fields + Lines + Remarks ── */}
        <div className="lg:col-span-8 xl:col-span-9 space-y-4">
          
          {/* Header Card */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${
                  isBuyer ? 'bg-emerald-500' : isImport ? 'bg-violet-500' : isFabric ? 'bg-sky-500' : isYarn ? 'bg-amber-500' : isTrims ? 'bg-rose-500' : 'bg-slate-500'
                }`} />
                <h4 className="text-[12px] font-bold uppercase tracking-wider text-slate-700">
                  {typeLabel} Header
                </h4>
              </div>
              <span className="text-[11px] font-semibold text-slate-500">
                Currency: <strong className="text-slate-800">{currCode} ({currSymbol})</strong>
              </span>
            </div>

            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-3">
              {/* Supplier or Customer */}
              {isBuyer ? (
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    Customer / Buyer *
                  </label>
                  <select
                    value={head.buyer_id ?? ''}
                    onChange={e => hSet('buyer_id', e.target.value)}
                    className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                  >
                    <option value="">— Select Buyer —</option>
                    {(buyers.data ?? []).map((b: any) => (
                      <option key={b.id} value={b.id}>{b.label}</option>
                    ))}
                  </select>
                  {err('buyer_id')}
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    Supplier / Vendor *
                  </label>
                  <select
                    value={head.supplier_id ?? ''}
                    onChange={e => hSet('supplier_id', e.target.value)}
                    className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                  >
                    <option value="">— Select Supplier —</option>
                    {(suppliers.data ?? []).map((s: any) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                  {err('supplier_id')}
                </div>
              )}

              {/* Currency */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Currency *
                </label>
                {isDomesticLike ? (
                  <div className="flex items-center justify-between rounded-lg border border-surface-border bg-slate-50 px-3 py-1.5 text-xs text-slate-700 font-medium">
                    <span>INR — Indian Rupee (₹)</span>
                    <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-800">INR</span>
                  </div>
                ) : (
                  <select
                    value={head.currency_id ?? ''}
                    onChange={e => hSet('currency_id', e.target.value)}
                    className={`w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:outline-none ${
                      isBuyer ? 'focus:border-emerald-500' : 'focus:border-violet-500'
                    }`}
                  >
                    <option value="">— Select Currency —</option>
                    {(currencies.data ?? []).map((c: any) => (
                      <option key={c.id} value={c.id}>{c.code} — {c.label}</option>
                    ))}
                  </select>
                )}
                {err('currency_id')}
              </div>

              {/* Quotation Date */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Quotation Date *
                </label>
                <input
                  type="date"
                  value={head.quotation_date ?? ''}
                  onChange={e => hSet('quotation_date', e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                />
                {err('quotation_date')}
              </div>

              {/* Valid Till */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Valid Till
                </label>
                <input
                  type="date"
                  value={head.valid_until ?? ''}
                  onChange={e => hSet('valid_until', e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                />
              </div>

              {/* Payment Terms */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Payment Terms
                </label>
                <input
                  type="text"
                  placeholder={isBuyer ? 'e.g. LC at Sight, TT 30 Days' : 'e.g. 30 Days Net, Advance, Against Delivery'}
                  value={head.payment_terms ?? ''}
                  onChange={e => hSet('payment_terms', e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                />
              </div>

              {/* Incoterms */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Delivery / Incoterms
                </label>
                <select
                  value={head.incoterm ?? (isBuyer ? 'FOB' : isImport ? 'CIF' : 'EXW')}
                  onChange={e => hSet('incoterm', e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                >
                  {INCOTERMS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              {/* Buyer & Import Extra fields (Ports & Exchange Rate) */}
              {!isDomesticLike && (
                <>
                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                      Port of Loading
                    </label>
                    <input
                      type="text"
                      placeholder={isBuyer ? 'e.g. Tuticorin / Chennai / Nhava Sheva' : 'e.g. Shanghai, China'}
                      value={head.port_of_loading ?? ''}
                      onChange={e => hSet('port_of_loading', e.target.value)}
                      className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                      Port of Discharge
                    </label>
                    <input
                      type="text"
                      placeholder={isBuyer ? 'e.g. Felixstowe / Rotterdam / New York' : 'e.g. Chennai / Tuticorin'}
                      value={head.port_of_discharge ?? ''}
                      onChange={e => hSet('port_of_discharge', e.target.value)}
                      className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                      Forex Rate (1 {currCode} to INR)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={head.exchange_rate ?? 86.50}
                      onChange={e => hSet('exchange_rate', Number(e.target.value))}
                      className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                    />
                  </div>
                </>
              )}

              {/* Optional Buyer / Customer reference for procurement */}
              {isDomesticLike && (
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    Buyer / Customer Reference
                  </label>
                  <select
                    value={head.buyer_id ?? ''}
                    onChange={e => hSet('buyer_id', e.target.value)}
                    className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                  >
                    <option value="">— Optional Buyer —</option>
                    {(buyers.data ?? []).map((b: any) => (
                      <option key={b.id} value={b.id}>{b.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Enquiry Ref */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Enquiry / PO Reference
                </label>
                <input
                  type="text"
                  placeholder="e.g. ENQ-2026-004 / REF-88"
                  value={head.enquiry_ref ?? ''}
                  onChange={e => hSet('enquiry_ref', e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                />
              </div>

              {/* Sales Person / Agent */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Sales Person / Agent
                </label>
                <select
                  value={head.agent_id ?? ''}
                  onChange={e => hSet('agent_id', e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                >
                  <option value="">— None —</option>
                  {(agents.data ?? []).map((a: any) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
              </div>

              {/* Branch */}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Branch
                </label>
                <select
                  value={head.branch_id ?? ''}
                  onChange={e => hSet('branch_id', e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                >
                  <option value="">— Default Branch —</option>
                  {(branches.data ?? []).map((b: any) => (
                    <option key={b.id} value={b.id}>{b.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* ── Load from Bill of Material (Fabric / Yarn / Trims quotations) ── */}
          {bomMaterial && (
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles size={13} className="text-brand-600" />
                  <h4 className="text-[12px] font-bold uppercase tracking-wider text-slate-700">
                    {isProcessQuote ? `Load the job's actual ${bomMaterial.label.toLowerCase()}` : 'Load from Bill of Material'}
                  </h4>
                </div>
                <span className="text-[11px] text-slate-500">
                  {isProcessQuote
                    ? `Job-work on what the job really has: ${head.quotation_type === 'FABRIC' ? 'the fabric rolls its knitting produced (or bought for it)' : 'the yarn lots bought for / transferred to it'} — no fabric BOM needed`
                    : `Picks only the job's BOM ${bomMaterial.label.toLowerCase()} items with the planned requirement`}
                </span>
              </div>
              <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-3 items-end">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    IO No (Internal Order)
                  </label>
                  <select
                    value={bomJobId}
                    onChange={e => {
                      const job = (jobs.data ?? []).find(j => String(j.id) === e.target.value);
                      setBomJobId(e.target.value);
                      setBomStyleId(job && job.styles.length === 1 ? String(job.styles[0].style_id) : '');
                    }}
                    className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
                  >
                    <option value="">— Select Job / IO No —</option>
                    {(jobs.data ?? []).map(j => (
                      <option key={j.id} value={j.id}>{j.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    Style No
                  </label>
                  <select
                    value={bomStyleId}
                    onChange={e => setBomStyleId(e.target.value)}
                    disabled={!bomJob}
                    className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none disabled:bg-slate-50"
                  >
                    <option value="">{bomJob ? 'All styles of the job' : '— Select job first —'}</option>
                    {(bomJob?.styles ?? []).map(st => (
                      <option key={st.style_id} value={st.style_id}>{st.style_code} — {st.style_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <button
                    type="button"
                    className="btn-primary w-full justify-center"
                    disabled={!bomJobId || bomLoading}
                    onClick={() => void (isProcessQuote ? loadJobActual() : loadFromBom())}
                    id="btn-load-job-material"
                  >
                    {bomLoading ? <Spinner size={14} /> : <Layers size={14} />} {isProcessQuote ? `Load Job's ${bomMaterial.label}` : `Load ${bomMaterial.label} Items from BOM`}
                  </button>
                </div>
                {isProcessQuote && head.quotation_type === 'FABRIC' && (
                  <div className="md:col-span-full flex items-end gap-2 border-t border-dashed border-slate-200 pt-2">
                    <label className="block flex-1 max-w-xs">
                      <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Or scan / type a roll no</span>
                      <input value={scanRoll} onChange={(e) => setScanRoll(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addScannedRoll(); } }}
                        placeholder="Roll no — fills job, PO, style, buyer, fabric" id="q-scan-roll" className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs" />
                    </label>
                    <button type="button" className="btn-secondary" id="btn-add-roll" disabled={!scanRoll.trim()} onClick={() => void addScannedRoll()}>Add roll</button>
                  </div>
                )}
                {isProcessQuote && rollChoice && (
                  <div className="md:col-span-full rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs" id="roll-choice">
                    <div className="mb-1 font-semibold text-amber-900">Roll no {scanRoll} is on several GRNs — pick the one:</div>
                    {rollChoice.map((c) => (
                      <button key={c.id} type="button" className="mr-2 mb-1 rounded border border-amber-300 bg-white px-2 py-1 text-left hover:bg-amber-100" onClick={() => void addScannedRoll(Number(c.id))}>
                        <b>{c.roll_no}</b> · job {c.job_no ?? '—'} · {c.grn_no} · {c.fabric_name} {c.process_state}{c.color_name ? ` ${c.color_name}` : ''} · {c.available_kg} KG
                      </button>))}
                    <button type="button" className="text-slate-500 underline" onClick={() => setRollChoice(null)}>cancel</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {actual && (
            <Modal open onClose={() => setActual(null)} size="xl" title={`Job ${actual.job.job_no} — actual ${actual.kind === 'FABRIC' ? 'fabric' : 'yarn'} available`}
              footer={<>
                <span className="mr-auto self-center text-xs text-slate-600">{actual.job.buyer_name ?? ''}{actual.job.styles ? ` · ${actual.job.styles}` : ''}{actual.job.buyer_po_no ? ` · PO ${actual.job.buyer_po_no}` : ''}</span>
                <button className="btn-secondary" onClick={() => setActual(null)}>Cancel</button>
                <button className="btn-primary" onClick={applyJobActual} id="btn-apply-job-material">Load selected</button>
              </>}>
              {actual.kind === 'FABRIC' ? (
              <table className="w-full text-xs" id="job-actual-table">
                <thead className="bg-slate-50 text-slate-500"><tr>
                  {['', 'Roll', 'Fabric', 'State', 'Colour', 'GSM', 'Dia', 'Production · program · lot', 'QC', 'Available KG', 'Available M', 'Quote KG'].map((h, i) => <th key={i} className={`px-2 py-2 ${/KG|M$/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                </tr></thead>
                <tbody>{actual.rolls.map((r) => {
                  const k = String(r.id); const on = Number(actual.pick[k]) > 0;
                  const setPick = (v: number | '') => setActual((a) => (a ? { ...a, pick: { ...a.pick, [k]: v } } : a));
                  return (
                    <tr key={k} className={`border-t border-slate-100 ${on ? 'bg-emerald-50/50' : ''}`} data-roll={r.roll_no}>
                      <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setPick(on ? '' : r.available_kg)} /></td>
                      <td className="px-2 py-1 font-mono font-semibold">{r.roll_no}</td><td className="px-2 py-1">{r.fabric_name}</td><td className="px-2 py-1">{r.process_state}</td><td className="px-2 py-1 font-semibold text-slate-800">{r.color_name || (r.colour && r.colour !== 'GREY' ? r.colour : (r.color_name || r.colour || '—'))}</td>
                      <td className="px-2 py-1">{r.gsm ?? '—'}</td><td className="px-2 py-1">{r.dia ?? '—'}</td><td className="px-2 py-1 text-slate-600">{rollTrace(r) || r.grn_no}</td><td className="px-2 py-1">QC ok</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtDecimal(r.available_kg, 3)}</td><td className="px-2 py-1 text-right tabular-nums">{r.available_m ? fmtDecimal(r.available_m, 2) : '—'}</td>
                      <td className="px-2 py-1 text-right"><input type="number" step="0.001" className="w-24 rounded border border-surface-border px-2 py-0.5 text-right text-xs"
                        value={actual.pick[k]} max={r.available_kg} onChange={(e) => setPick(e.target.value === '' ? '' : Math.min(Number(e.target.value), r.available_kg))} /></td>
                    </tr>);
                })}</tbody>
              </table>
              ) : (
              <table className="w-full text-xs" id="job-actual-table">
                <thead className="bg-slate-50 text-slate-500"><tr>
                  {['', 'Yarn', 'Count', 'Shade', 'Lots', 'Available KG', 'Quote KG']
                    .map((h, i) => <th key={i} className={`px-2 py-2 ${/KG|Rolls/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                </tr></thead>
                <tbody>{actual.groups.map((g) => {
                  const on = Number(actual.pick[g.key]) > 0;
                  const setPick = (v: number | '') => setActual((a) => (a ? { ...a, pick: { ...a.pick, [g.key]: v } } : a));
                  return (
                    <tr key={g.key} className={`border-t border-slate-100 ${on ? 'bg-emerald-50/50' : ''}`}>
                      <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setPick(on ? '' : g.available_kg)} /></td>
                      {actual.kind === 'FABRIC' ? (<>
                        <td className="px-2 py-1 font-medium">{g.fabric_name}</td><td className="px-2 py-1">{g.process_state}</td><td className="px-2 py-1">{g.colour ?? '—'}</td>
                        <td className="px-2 py-1">{g.gsm ?? '—'}</td><td className="px-2 py-1">{g.dia ?? '—'}</td><td className="px-2 py-1 text-right">{g.rolls}</td><td className="px-2 py-1">{g.programs || '—'}</td>
                      </>) : (<>
                        <td className="px-2 py-1 font-medium">{g.yarn_name}</td><td className="px-2 py-1">{g.count_str ?? '—'}</td><td className="px-2 py-1">{g.shade ?? '—'}</td><td className="px-2 py-1">{g.lot_nos}</td>
                      </>)}
                      <td className="px-2 py-1 text-right tabular-nums">{fmtDecimal(g.available_kg, 3)}</td>
                      <td className="px-2 py-1 text-right"><input type="number" step="0.001" className="w-24 rounded border border-surface-border px-2 py-0.5 text-right text-xs"
                        value={actual.pick[g.key]} max={g.available_kg} onChange={(e) => setPick(e.target.value === '' ? '' : Math.min(Number(e.target.value), g.available_kg))} /></td>
                    </tr>);
                })}</tbody>
              </table>
              )}
              <p className="mt-2 text-[11px] text-slate-500">Only the job's own rolls: QC-accepted, KG left, not on a draft DC or another live quotation. Rolls of the same fabric / state / colour / GSM / Dia go on one line. Pick the dye colour on each line after loading.</p>
            </Modal>
          )}

          {/* ── Product Details Table ── */}
          <div className="card overflow-hidden shadow-xs">
            <div className="flex items-center justify-between border-b border-surface-border bg-slate-50/70 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${
                  isBuyer ? 'bg-emerald-500' : isFabric ? 'bg-sky-500' : isYarn ? 'bg-amber-500' : isTrims ? 'bg-rose-500' : 'bg-brand-500'
                }`} />
                <h4 className="text-[12px] font-bold uppercase tracking-wider text-slate-700">
                  {typeLabel} Line Items
                </h4>
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-700">
                  {lines.length} {lines.length === 1 ? 'Item' : 'Items'}
                </span>
              </div>
              <span className="text-[11px] text-slate-500">
                Amount uses <strong>Confirm Rate</strong> (falls back to Quotation Rate if unconfirmed)
              </span>
            </div>

            {errors.lines && (
              <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700">
                {errors.lines}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-surface-border bg-slate-100/80 font-semibold uppercase tracking-wider text-slate-600 text-[11px]">
                    <th className="w-8 px-2 py-2 text-center">S.No</th>
                    
                    {/* I/O Num / Job No */}
                    {showJobAndStyle && (
                      <th className="min-w-[95px] px-2 py-2">I/O Num</th>
                    )}

                    {/* Style No */}
                    {showJobAndStyle && (
                      <th className="min-w-[120px] px-2 py-2">Style No</th>
                    )}

                    {/* Material master (Fabric / Yarn / Trim) — carried into the PO */}
                    {bomMaterial && (
                      <th className="min-w-[150px] px-2 py-2">{bomMaterial.label === 'Trim' ? 'Trim Item' : bomMaterial.label}</th>
                    )}

                    {/* FABRIC SPECIFIC */}
                    {isFabric && (
                      <>
                        <th className="min-w-[70px] px-2 py-2">Dia</th>
                        <th className="min-w-[140px] px-2 py-2">Cloth Description</th>
                        <th className="min-w-[100px] px-2 py-2">Color</th>
                        <th className="min-w-[65px] px-2 py-2">GSM</th>
                      </>
                    )}

                    {/* YARN SPECIFIC */}
                    {isYarn && (
                      <>
                        <th className="min-w-[110px] px-2 py-2">Yarn Type</th>
                        <th className="min-w-[80px] px-2 py-2">Counts</th>
                        <th className="min-w-[100px] px-2 py-2">Color</th>
                      </>
                    )}

                    {/* TRIMS SPECIFIC */}
                    {isTrims && (
                      <>
                        <th className="min-w-[140px] px-2 py-2">Trims Description</th>
                        <th className="min-w-[100px] px-2 py-2">Trim Color</th>
                        <th className="min-w-[80px] px-2 py-2">Trim Size</th>
                      </>
                    )}

                    {/* GENERAL SPECIFIC */}
                    {isGeneral && (
                      <th className="min-w-[180px] px-2 py-2">Item Description</th>
                    )}

                    {/* BUYER / IMPORT SPECIFIC */}
                    {(isBuyer || isImport) && (
                      <>
                        <th className="min-w-[140px] px-2 py-2">Description</th>
                        <th className="min-w-[100px] px-2 py-2">Color</th>
                        <th className="min-w-[90px] px-2 py-2">Size</th>
                      </>
                    )}

                    {/* COMMON: Qty, UOM, Rates, Taxes, Amount */}
                    <th className="min-w-[75px] px-2 py-2 text-right">Qty</th>
                    <th className="min-w-[85px] px-2 py-2 text-center">UOM</th>
                    <th className="min-w-[95px] px-2 py-2 text-right">{isProcess ? 'Process Rate' : 'Quotation Rate'} ({currSymbol})</th>
                    <th className="min-w-[95px] px-2 py-2 text-right">{isProcess ? 'Confirm Proc Rate' : 'Confirm Rate'} ({currSymbol})</th>
                    
                    {isDomesticLike && (
                      <>
                        <th className="min-w-[70px] px-1.5 py-2 text-center">GST %</th>
                        <th className="min-w-[70px] px-1.5 py-2 text-center">IGST %</th>
                      </>
                    )}

                    <th className="min-w-[100px] px-2 py-2 text-right">Amount ({currSymbol})</th>
                    <th className="w-8 px-1 py-2 text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-border bg-white">
                  {lines.map((l, i) => {
                    const effRate = getEffectiveRate(l);
                    const lineAmt = (Number(l.qty) || 0) * effRate;

                    return (
                      <Fragment key={l._key}>
                      <tr className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-2 py-1.5 text-center font-mono text-[11px] text-slate-400">
                          {i + 1}
                        </td>

                        {/* I/O Num / Job No */}
                        {showJobAndStyle && (
                          <td className="px-1.5 py-1">
                            {bomMaterial ? (
                              <select
                                value={l.so_id}
                                onChange={e => {
                                  const job = jobById(e.target.value);
                                  const keepStyle = job?.styles.some(st => st.style_id === Number(l.style_id));
                                  setLine(l._key, {
                                    so_id: job ? job.id : '', job_no: job?.job_no ?? '', bom_line_id: '',
                                    style_id: keepStyle ? l.style_id : (job && job.styles.length === 1 ? job.styles[0].style_id : ''),
                                  });
                                }}
                                className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              >
                                <option value="">{l.job_no && !l.so_id ? l.job_no : '— I/O —'}</option>
                                {(jobs.data ?? []).map(j => <option key={j.id} value={j.id}>{j.job_no}</option>)}
                              </select>
                            ) : (
                              <input
                                type="text"
                                placeholder="I/O #"
                                value={l.job_no}
                                onChange={e => setLine(l._key, { job_no: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              />
                            )}
                          </td>
                        )}

                        {/* Style No */}
                        {showJobAndStyle && (
                          <td className="px-1.5 py-1">
                            <select
                              value={l.style_id}
                              onChange={e => setLine(l._key, { style_id: Number(e.target.value) || '', ...(bomMaterial ? { bom_line_id: '' as const } : {}) })}
                              className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                            >
                              <option value="">— Style —</option>
                              {bomMaterial && jobById(l.so_id)
                                ? jobById(l.so_id)!.styles.map(st => <option key={st.style_id} value={st.style_id}>{st.style_code}</option>)
                                : (styles.data ?? []).map((s: any) => (
                                  <option key={s.id} value={s.id}>{s.code}</option>
                                ))}
                            </select>
                          </td>
                        )}

                        {/* Material master */}
                        {bomMaterial && (
                          <td className="px-1.5 py-1">
                            {(() => {
                              const bomItems = jobBoms.itemsFor(l.so_id, l.style_id, bomMaterial.types).filter(it => it[bomMaterial.key]);
                              const st = jobBoms.statusFor(l.so_id, l.style_id);
                              return (
                            <select
                              value={l.bom_line_id && bomItems.some(it => it.bom_line_id === Number(l.bom_line_id)) ? `bom:${l.bom_line_id}` : l[bomMaterial.key]}
                              title={st === 'empty' ? `No ${bomMaterial.label.toLowerCase()} in this job's BOM` : undefined}
                              onChange={e => {
                                if (e.target.value.startsWith('bom:')) {
                                  const it = bomItems.find(x => `bom:${x.bom_line_id}` === e.target.value);
                                  if (it) pickBomItem(l, it);
                                  return;
                                }
                                // A master item that is on this job's BOM fills from the BOM too (qty, colour, size, spec)
                                const inBom = bomItems.filter(x => Number(x[bomMaterial.key]) === Number(e.target.value));
                                if (inBom.length === 1) { pickBomItem(l, inBom[0]); return; }
                                if (inBom.length > 1) toast(`${inBom.length} BOM lines use this item (colour / size wise) — pick the line from "BOM of ${l.job_no}" to load its qty`, 'info');
                                const m: any = (materials.data ?? []).find((x: any) => String(x.id) === e.target.value);
                                setLine(l._key, {
                                  bom_line_id: '',
                                  [bomMaterial.key]: Number(e.target.value) || '',
                                  material_type: l.material_type || bomMaterial.types[0],
                                  description: l.description || m?.label || '',
                                  uom_id: l.uom_id || (Number(m?.base_uom) || ''),
                                } as Partial<QLine>);
                              }}
                              className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                            >
                              <option value="">{st === 'loading' ? 'Loading BOM…' : `— ${bomMaterial.label} —`}</option>
                              {bomItems.length > 0 && (
                                <optgroup label={`BOM of ${l.job_no || 'job'} (qty = requirement)`}>
                                  {bomItems.map(it => <option key={it.bom_line_id} value={`bom:${it.bom_line_id}`}>{bomItemLabel(it)}</option>)}
                                </optgroup>
                              )}
                              <optgroup label={`All ${bomMaterial.label.toLowerCase()}s`}>
                                {(materials.data ?? []).map((m: any) => (
                                  <option key={m.id} value={m.id}>{m.code ? `${m.code} — ${m.label}` : m.label}</option>
                                ))}
                              </optgroup>
                            </select>
                              );
                            })()}
                          </td>
                        )}

                        {/* FABRIC COLUMNS */}
                        {isFabric && (
                          <>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                list="quotation-dia-options"
                                placeholder='Dia (e.g. 30")'
                                value={l.dia}
                                onChange={e => setLine(l._key, { dia: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs font-medium focus:border-brand-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                placeholder="Cloth description"
                                value={l.description}
                                onChange={e => setLine(l._key, { description: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-1.5 py-1">
                              <select
                                value={l.color_id}
                                onChange={e => setLine(l._key, { color_id: Number(e.target.value) || '' })}
                                className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              >
                                <option value="">— Color —</option>
                                {(colors.data ?? []).map((c: any) => (
                                  <option key={c.id} value={c.id}>{c.label}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                list="quotation-gsm-options"
                                placeholder="GSM (e.g. 160)"
                                value={l.gsm}
                                onChange={e => setLine(l._key, { gsm: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs font-medium focus:border-brand-500 focus:outline-none"
                              />
                            </td>
                          </>
                        )}

                        {/* YARN COLUMNS */}
                        {isYarn && (
                          <>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                placeholder="e.g. Combed / Carded"
                                value={l.yarn_type}
                                onChange={e => setLine(l._key, { yarn_type: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                list="quotation-yarn-count-options"
                                placeholder="e.g. 30s, 2/40s"
                                value={l.yarn_count}
                                onChange={e => setLine(l._key, { yarn_count: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs font-mono font-bold text-brand-700 focus:border-brand-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-1.5 py-1">
                              <select
                                value={l.color_id}
                                onChange={e => setLine(l._key, { color_id: Number(e.target.value) || '' })}
                                className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              >
                                <option value="">— Color —</option>
                                {(colors.data ?? []).map((c: any) => (
                                  <option key={c.id} value={c.id}>{c.label}</option>
                                ))}
                              </select>
                            </td>
                          </>
                        )}

                        {/* TRIMS COLUMNS */}
                        {isTrims && (
                          <>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                placeholder="Trims description"
                                value={l.description}
                                onChange={e => setLine(l._key, { description: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-1.5 py-1">
                              <select
                                value={l.color_id}
                                onChange={e => setLine(l._key, { color_id: Number(e.target.value) || '' })}
                                className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              >
                                <option value="">— Color —</option>
                                {(colors.data ?? []).map((c: any) => (
                                  <option key={c.id} value={c.id}>{c.label}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                placeholder="Size (18L, 24L...)"
                                value={l.trim_size}
                                onChange={e => setLine(l._key, { trim_size: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              />
                            </td>
                          </>
                        )}

                        {/* GENERAL COLUMNS */}
                        {isGeneral && (
                          <td className="px-1.5 py-1">
                            <input
                              type="text"
                              placeholder={head.is_io_wise ? 'Item description (e.g. 10 Sample Testing Buttons)' : 'Item description'}
                              value={l.description}
                              onChange={e => setLine(l._key, { description: e.target.value })}
                              className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                            />
                          </td>
                        )}

                        {/* BUYER / IMPORT COLUMNS */}
                        {(isBuyer || isImport) && (
                          <>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                placeholder="Garment description"
                                value={l.description}
                                onChange={e => setLine(l._key, { description: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              />
                            </td>
                            <td className="px-1.5 py-1">
                              <select
                                value={l.color_id}
                                onChange={e => setLine(l._key, { color_id: Number(e.target.value) || '' })}
                                className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              >
                                <option value="">— Color —</option>
                                {(colors.data ?? []).map((c: any) => (
                                  <option key={c.id} value={c.id}>{c.label}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-1.5 py-1">
                              <select
                                value={l.size_id}
                                onChange={e => setLine(l._key, { size_id: Number(e.target.value) || '' })}
                                className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                              >
                                <option value="">— Size —</option>
                                {(sizes.data ?? []).map((s: any) => (
                                  <option key={s.id} value={s.id}>{s.size_label}</option>
                                ))}
                              </select>
                            </td>
                          </>
                        )}

                        {/* COMMON: Qty */}
                        <td className="px-1.5 py-1">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            placeholder="0"
                            value={l.qty}
                            readOnly={(l.rolls ?? []).length > 0}
                            title={(l.rolls ?? []).length > 0 ? 'Qty = the KG of its rolls' : undefined}
                            onChange={e => setLine(l._key, { qty: e.target.value === '' ? '' : Number(e.target.value) })}
                            className="w-full rounded border border-surface-border px-2 py-1 text-right text-xs focus:border-brand-500 focus:outline-none font-mono"
                          />
                        </td>

                        {/* COMMON: UOM */}
                        <td className="px-1.5 py-1">
                          <select
                            value={l.uom_id}
                            onChange={e => setLine(l._key, { uom_id: Number(e.target.value) || '' })}
                            className="w-full rounded border border-surface-border bg-white px-1 py-1 text-center text-xs focus:border-brand-500 focus:outline-none font-medium"
                          >
                            <option value="">— UOM —</option>
                            {(uoms.data ?? []).map((u: any) => (
                              <option key={u.id} value={u.id}>{u.code}</option>
                            ))}
                          </select>
                        </td>

                        {/* COMMON: Quotation Rate */}
                        <td className="px-1.5 py-1">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder={l.ref_rate ? `BOM ${l.ref_rate}` : '0.00'}
                            title={l.ref_rate ? `BOM standard rate ₹${l.ref_rate} — reference only; enter the supplier's quoted rate` : undefined}
                            value={l.quotation_rate}
                            onChange={e => setLine(l._key, { quotation_rate: e.target.value === '' ? '' : Number(e.target.value) })}
                            className="w-full rounded border border-surface-border px-2 py-1 text-right text-xs focus:border-brand-500 focus:outline-none font-mono"
                          />
                        </td>

                        {/* COMMON: Confirm Rate */}
                        <td className="px-1.5 py-1">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Confirm"
                            value={l.confirm_rate}
                            onChange={e => setLine(l._key, { confirm_rate: e.target.value === '' ? '' : Number(e.target.value) })}
                            className="w-full rounded border border-emerald-300 bg-emerald-50/40 px-2 py-1 text-right text-xs font-semibold text-emerald-900 focus:border-emerald-500 focus:outline-none font-mono"
                          />
                        </td>

                        {/* DOMESTIC TAXES: GST % & IGST % */}
                        {isDomesticLike && (
                          <>
                            <td className="px-1 py-1">
                              <select
                                value={l.gst_rate}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  setLine(l._key, { gst_rate: val, igst_rate: val > 0 ? 0 : l.igst_rate });
                                }}
                                className="w-full rounded border border-surface-border bg-white px-1 py-1 text-center text-xs font-bold text-slate-700 focus:border-brand-500 focus:outline-none"
                              >
                                {GST_OPTIONS.map(g => (
                                  <option key={g.value} value={g.value}>{g.label}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-1 py-1">
                              <select
                                value={l.igst_rate}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  setLine(l._key, { igst_rate: val, gst_rate: val > 0 ? 0 : l.gst_rate });
                                }}
                                className="w-full rounded border border-surface-border bg-white px-1 py-1 text-center text-xs font-bold text-amber-700 focus:border-brand-500 focus:outline-none"
                              >
                                {GST_OPTIONS.map(g => (
                                  <option key={g.value} value={g.value}>{g.label}</option>
                                ))}
                              </select>
                            </td>
                          </>
                        )}

                        {/* Line Total Amount */}
                        <td className="px-2 py-1.5 text-right font-mono font-bold text-slate-800">
                          {fmtDecimal(lineAmt, 2)}
                        </td>

                        {/* Delete line */}
                        <td className="px-1 py-1.5 text-center">
                          <button
                            type="button"
                            onClick={() => removeLine(l._key)}
                            title="Remove line"
                            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                      {isProcessQuote && ((l.rolls ?? []).length > 0 || true) && (
                        <tr className="bg-slate-50/60" data-line={i + 1}>
                          <td />
                          <td colSpan={99} className="px-2 pb-2 pt-0.5 text-[11px]">
                            {(l.rolls ?? []).length > 0 && (
                              <div className="mb-1 flex flex-wrap items-center gap-1.5" id={`q-rolls-${i + 1}`}>
                                <span className="font-semibold text-slate-600">Rolls:</span>
                                {(l.rolls ?? []).map((r) => (
                                  <span key={r.fabric_roll_id} className="inline-flex items-center gap-1 rounded border border-sky-200 bg-white px-1.5 py-0.5" title={r.trace}>
                                    <b className="font-mono">{r.roll_no}</b>
                                    <input type="number" step="0.001" className="w-16 rounded border border-slate-200 px-1 text-right" value={r.qty_kg}
                                      onChange={(e) => setRollKg(l._key, r.fabric_roll_id, e.target.value === '' ? '' : Number(e.target.value))} /> KG
                                    {r.trace && <span className="text-slate-400">{r.trace}</span>}
                                    <button type="button" className="text-slate-400 hover:text-rose-600" onClick={() => dropRoll(l._key, r.fabric_roll_id)} title="Take the roll off">✕</button>
                                  </span>
                                ))}
                                <span className="text-slate-500">= {fmtDecimal(sumRolls(l.rolls), 3)} KG</span>
                              </div>
                            )}
                            <div className="flex flex-wrap items-center gap-2 text-slate-600" id={`q-cost-${i + 1}`}>
                              <span className="font-semibold">Costing / KG:</span>
                              {([['process_rate', 'Process'], ['dye_chem_rate', 'Dye / chemical'], ['other_rate', 'Other']] as const).map(([k, lab]) => (
                                <label key={k} className="inline-flex items-center gap-1">{lab}
                                  <input type="number" step="0.01" min="0" className="w-20 rounded border border-slate-200 px-1 text-right" value={(l as any)[k] ?? ''} id={`q-${k}-${i + 1}`}
                                    onChange={(e) => setBreakup(l._key, { [k]: e.target.value === '' ? '' : Number(e.target.value) } as any)} /></label>
                              ))}
                              <span>= <b>{currSymbol}{fmtDecimal(Number(l.quotation_rate) || 0, 2)}</b> quoted rate{[l.process_rate, l.dye_chem_rate, l.other_rate].some((x) => x !== '' && x != null) ? '' : ' (enter the breakup to build it)'}</span>
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-surface-border bg-slate-50/40">
                    <td colSpan={20} className="px-3 py-2">
                      <button
                        type="button"
                        onClick={addLine}
                        className="btn-secondary btn-sm w-full border-dashed border-slate-300 hover:border-brand-500 hover:text-brand-700 hover:bg-brand-50/40 transition-colors flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold text-slate-600"
                      >
                        <Plus size={14} className="text-brand-600" /> Add {typeLabel} Line
                      </button>
                    </td>
                  </tr>
                  <tr className="border-t-2 border-surface-border bg-slate-50/90 font-bold text-slate-800">
                    <td colSpan={colsBeforeQty} className="px-3 py-2.5 text-right uppercase tracking-wider text-[11px] text-slate-600">
                      Total Basic Value
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      {fmtDecimal(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0), 2)}
                    </td>
                    {/* UOM, Quotation Rate, Confirm Rate (+ GST %, IGST % on domestic) */}
                    <td colSpan={isDomesticLike ? 5 : 3}></td>
                    <td className="px-3 py-2.5 text-right font-mono text-sm font-bold text-brand-700">
                      {currSymbol} {fmtDecimal(calc.basicAmount, 2)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>

              {/* Dropdown Datalists for Tube Dia, GSM, and Yarn Counts */}
              <datalist id="quotation-dia-options">
                {(diaLookup.data ?? []).map((d: any) => (
                  <option key={d.id} value={`${d.code || d.dia_value}" Dia`}>
                    {d.label}
                  </option>
                ))}
                {['20" Dia', '24" Dia', '26" Dia', '28" Dia', '30" Dia', '32" Dia', '34" Dia', '36" Dia'].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </datalist>

              <datalist id="quotation-gsm-options">
                {(gsmLookup.data ?? []).map((g: any) => (
                  <option key={g.id} value={`${g.code || g.gsm_value} GSM`}>
                    {g.label}
                  </option>
                ))}
                {['140 GSM', '160 GSM', '180 GSM', '200 GSM', '220 GSM', '240 GSM', '280 GSM', '320 GSM'].map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </datalist>

              <datalist id="quotation-yarn-count-options">
                {(yarnCounts.data ?? []).map((yc: any) => (
                  <option key={yc.id} value={yc.code || yc.count_value}>
                    {yc.label || `${yc.count_value} ${yc.count_type}`}
                  </option>
                ))}
                {['20s', '24s', '30s', '34s', '40s', '2/30s', '2/40s', '2/50s', '30s/30s/10s'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </datalist>
            </div>
          </div>

          {/* ── Notes & Terms Card ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="card p-3.5">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-2">
                Internal Remarks / Notes
              </h4>
              <textarea
                rows={3}
                placeholder="Internal notes for merchandising, procurement and store teams…"
                value={head.remarks ?? ''}
                onChange={e => hSet('remarks', e.target.value)}
                className="w-full rounded-lg border border-surface-border p-2.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
              />
            </div>

            <div className="card p-3.5">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-2">
                Terms &amp; Conditions
              </h4>
              <textarea
                rows={3}
                placeholder="Validity, delivery terms, payment conditions, certification requirements…"
                value={head.terms ?? ''}
                onChange={e => hSet('terms', e.target.value)}
                className="w-full rounded-lg border border-surface-border p-2.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* ── RIGHT (Cols 9-12 / xl:10-12): Dynamic Pricing Summary Card ── */}
        <div className="lg:col-span-4 xl:col-span-3 space-y-4">
          <div className="card overflow-hidden shadow-sm">
            <div className={`px-4 py-3 flex items-center justify-between text-white ${
              isBuyer ? 'bg-emerald-700' : isImport ? 'bg-violet-700' : isFabric ? 'bg-sky-700' : isYarn ? 'bg-amber-700' : isTrims ? 'bg-rose-700' : 'bg-slate-700'
            }`}>
              <div className="flex items-center gap-2">
                <FileText size={15} />
                <h4 className="text-[12.5px] font-bold">
                  {isBuyer ? 'Buyer Export Pricing Summary' : isImport ? 'Import Cost & Landing Summary' : 'Quotation Pricing Summary'}
                </h4>
              </div>
              <span className="rounded bg-white/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                {currSymbol}
              </span>
            </div>

            <div className="p-4 space-y-2 text-xs divide-y divide-slate-100">
              {/* ── BUYER EXPORT SUMMARY ── */}
              {isBuyer && (() => {
                const d = calc as any;
                return (
                  <div className="space-y-2 pt-1">
                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600 font-medium">Items Total ({currCode})</span>
                      <span className="font-mono font-bold text-slate-800">{currSymbol} {fmtDecimal(d.basicAmount, 2)}</span>
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-600">Discount %</span>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.5"
                          value={head.discount_pct ?? 0}
                          onChange={e => hSet('discount_pct', Number(e.target.value))}
                          className="w-14 rounded border border-surface-border px-1.5 py-0.5 text-right text-xs focus:border-emerald-500 focus:outline-none"
                        />
                      </div>
                      <span className="font-mono text-slate-700">- {currSymbol} {fmtDecimal(d.discAmt, 2)}</span>
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Ocean / Air Freight ({currCode})</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.freight_charges ?? 0}
                        onChange={e => hSet('freight_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-emerald-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Marine Insurance ({currCode})</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.insurance ?? 0}
                        onChange={e => hSet('insurance', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-emerald-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Packing &amp; Hangtag ({currCode})</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.packing_charges ?? 0}
                        onChange={e => hSet('packing_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-emerald-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Other / Handling ({currCode})</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.other_charges ?? 0}
                        onChange={e => hSet('other_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-emerald-500 focus:outline-none"
                      />
                    </div>

                    <div className="border-t-2 border-emerald-600 pt-2.5 mt-2 space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-bold text-slate-900">Total Offer ({currCode})</span>
                        <span className="text-lg font-bold text-emerald-700 font-mono">
                          {currSymbol} {fmtDecimal(d.finalOffer, 2)}
                        </span>
                      </div>

                      {/* Realization in INR */}
                      <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 space-y-1">
                        <div className="flex justify-between text-[11px] text-emerald-800">
                          <span>Exchange Rate (1 {currCode})</span>
                          <span className="font-mono font-bold">₹ {fmtDecimal(head.exchange_rate || 1, 2)}</span>
                        </div>
                        <div className="flex justify-between text-xs font-bold text-emerald-950 pt-1 border-t border-emerald-200">
                          <span>INR Realization Value</span>
                          <span className="font-mono text-sm">₹ {fmtDecimal(d.inrEquivalent, 2)}</span>
                        </div>
                      </div>

                      {/* Tax Note */}
                      <div className="rounded bg-slate-50 border border-slate-200 px-2 py-1 text-[11px] text-slate-600 flex items-center justify-between">
                        <span>Export Tax Scheme:</span>
                        <span className="font-semibold text-slate-800">LUT Export (0% GST)</span>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ── DOMESTIC / PROCUREMENT SUMMARY (FABRIC, YARN, TRIMS, GENERAL, DOMESTIC) ── */}
              {isDomesticLike && (() => {
                const d = calc as any;
                const totalGstBreakdown = d.gstBreakdown ?? [];
                const totalIgstBreakdown = d.igstBreakdown ?? [];

                return (
                  <div className="space-y-2 pt-1">
                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600 font-medium">Basic Amount</span>
                      <span className="font-mono font-bold text-slate-800">₹ {fmtDecimal(d.basicAmount, 2)}</span>
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-600">Discount %</span>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.5"
                          value={head.discount_pct ?? 0}
                          onChange={e => hSet('discount_pct', Number(e.target.value))}
                          className="w-14 rounded border border-surface-border px-1.5 py-0.5 text-right text-xs focus:border-brand-500 focus:outline-none"
                        />
                      </div>
                      <span className="font-mono text-slate-700">- ₹ {fmtDecimal(d.discAmt, 2)}</span>
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Freight / Transport</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.freight_charges ?? 0}
                        onChange={e => hSet('freight_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-brand-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Packing Charges</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.packing_charges ?? 0}
                        onChange={e => hSet('packing_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-brand-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Other Charges</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.other_charges ?? 0}
                        onChange={e => hSet('other_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-brand-500 focus:outline-none"
                      />
                    </div>

                    <div className="border-t border-surface-border pt-2 flex justify-between items-center">
                      <span className="font-bold text-slate-800">Taxable Value</span>
                      <span className="font-mono font-bold text-brand-800">₹ {fmtDecimal(d.taxableValue, 2)}</span>
                    </div>

                    {/* Per-line GST & IGST breakdown */}
                    <div className="rounded-lg bg-amber-50/70 border border-amber-200 p-2.5 space-y-1.5">
                      <div className="text-[11px] font-bold text-amber-900 uppercase tracking-wider flex items-center justify-between">
                        <span>GST &amp; IGST Breakdown</span>
                        <span className="text-[10px] font-mono text-amber-800">Per-Line</span>
                      </div>

                      {/* CGST + SGST (Intrastate) */}
                      {totalGstBreakdown.map((g: any) => (
                        <div key={`cgst-${g.rate}`} className="text-[11px] space-y-0.5 border-b border-amber-200/60 pb-1">
                          <div className="flex justify-between text-slate-600">
                            <span>CGST @ {(g.rate / 2).toFixed(1)}% (on ₹{fmtDecimal(g.baseAmt, 2)})</span>
                            <span className="font-mono font-semibold">₹ {fmtDecimal(g.cgst, 2)}</span>
                          </div>
                          <div className="flex justify-between text-slate-600">
                            <span>SGST @ {(g.rate / 2).toFixed(1)}% (on ₹{fmtDecimal(g.baseAmt, 2)})</span>
                            <span className="font-mono font-semibold">₹ {fmtDecimal(g.sgst, 2)}</span>
                          </div>
                        </div>
                      ))}

                      {/* IGST (Interstate) */}
                      {totalIgstBreakdown.map((ig: any) => (
                        <div key={`igst-${ig.rate}`} className="text-[11px] space-y-0.5 border-b border-amber-200/60 pb-1">
                          <div className="flex justify-between text-slate-600">
                            <span>IGST @ {ig.rate}% (on ₹{fmtDecimal(ig.baseAmt, 2)})</span>
                            <span className="font-mono font-semibold text-amber-900">₹ {fmtDecimal(ig.igst, 2)}</span>
                          </div>
                        </div>
                      ))}

                      {totalGstBreakdown.length === 0 && totalIgstBreakdown.length === 0 && (
                        <div className="text-[11px] text-slate-500 italic">0% GST / IGST applied</div>
                      )}

                      <div className="flex justify-between pt-1 font-bold text-amber-950 border-t border-amber-200">
                        <span>Total Tax (GST + IGST)</span>
                        <span className="font-mono">₹ {fmtDecimal(d.totalGst, 2)}</span>
                      </div>
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Round Off</span>
                      <input
                        type="number"
                        step="0.01"
                        value={head.round_off ?? 0}
                        onChange={e => hSet('round_off', Number(e.target.value))}
                        className="w-20 rounded border border-surface-border px-1.5 py-0.5 text-right font-mono text-xs focus:border-brand-500 focus:outline-none"
                      />
                    </div>

                    <div className="border-t-2 border-slate-800 pt-3 mt-3">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-bold text-slate-900">Grand Total (INR)</span>
                        <span className="text-lg font-bold text-brand-700 font-mono">
                          ₹ {fmtDecimal(d.grandTotal, 2)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ── IMPORT SUMMARY ── */}
              {isImport && (() => {
                const d = calc as any;
                return (
                  <div className="space-y-2 pt-1">
                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600 font-medium">Product Value</span>
                      <span className="font-mono font-bold text-slate-800">{currSymbol} {fmtDecimal(d.basicAmount, 2)}</span>
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Courier Charges</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.courier_charges ?? 0}
                        onChange={e => hSet('courier_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Freight Charges</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.freight_charges ?? 0}
                        onChange={e => hSet('freight_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Insurance</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.insurance ?? 0}
                        onChange={e => hSet('insurance', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Packing Charges</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.packing_charges ?? 0}
                        onChange={e => hSet('packing_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Bank Charges</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.bank_charges ?? 0}
                        onChange={e => hSet('bank_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Customs / Duty</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.customs_duty ?? 0}
                        onChange={e => hSet('customs_duty', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Clearing Charges</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.clearing_charges ?? 0}
                        onChange={e => hSet('clearing_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <span className="text-slate-600">Other Charges</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={head.other_charges ?? 0}
                        onChange={e => hSet('other_charges', Number(e.target.value))}
                        className="w-24 rounded border border-surface-border px-2 py-0.5 text-right font-mono text-xs focus:border-violet-500 focus:outline-none"
                      />
                    </div>

                    <div className="border-t border-surface-border pt-2 flex justify-between items-center">
                      <span className="font-bold text-slate-800">Landed Cost</span>
                      <span className="font-mono font-bold text-violet-800">{currSymbol} {fmtDecimal(d.landedCost, 2)}</span>
                    </div>

                    <div className="flex justify-between items-center py-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-600">Margin %</span>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.5"
                          value={head.margin_pct ?? 0}
                          onChange={e => hSet('margin_pct', Number(e.target.value))}
                          className="w-14 rounded border border-surface-border px-1.5 py-0.5 text-right text-xs focus:border-violet-500 focus:outline-none"
                        />
                      </div>
                      <span className="font-mono text-slate-700">+ {currSymbol} {fmtDecimal(d.marginAmt, 2)}</span>
                    </div>

                    <div className="border-t-2 border-slate-800 pt-3 mt-3">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-bold text-slate-900">Final Quotation Value</span>
                        <span className="text-lg font-bold text-violet-700 font-mono">
                          {currSymbol} {fmtDecimal(d.finalSelling, 2)}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-[11px] text-slate-500 mt-1">
                        <span>INR Equivalent (@ ₹{fmtDecimal(head.exchange_rate || 1, 2)})</span>
                        <span className="font-mono font-semibold">
                          ₹ {fmtDecimal(d.finalSelling * (Number(head.exchange_rate) || 1), 2)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Workflow Status Card */}
          <div className="card p-4">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1.5">
              Workflow Status
            </label>
            <select
              value={head.status_id ?? ''}
              onChange={e => hSet('status_id', e.target.value)}
              className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-brand-500 focus:outline-none"
            >
              <option value="">— Select Status —</option>
              {(statuses.data ?? []).map((s: any) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}
