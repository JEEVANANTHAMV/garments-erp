import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Plus, Trash2, Save, FileText, Printer, Layers, Sparkles,
} from 'lucide-react';
import { http } from '../../lib/api';
import { useLookup, useStatuses } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import {
  PageHeader, Spinner, Badge, LoadingBlock, ErrorState,
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
  unit_price: number | '';
  gst_rate: number;
  igst_rate: number;
  sort_order: number;
}

let keySeq = 0;
const newLine = (sort = 0): QLine => ({
  _key: `q${++keySeq}`,
  job_no: '',
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
  const showJobAndStyle = !isGeneral || Boolean(head.is_io_wise);

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
  const statuses   = useStatuses('QUOTATION');

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
        is_io_wise: 0,
        currency_id: (h.currency_id && h.currency_id !== inrCurrency?.id) ? h.currency_id : (usdCurrency?.id ?? ''),
        exchange_rate: Number(h.exchange_rate) > 1 ? h.exchange_rate : 86.50,
        incoterm: h.incoterm || 'FOB',
      }));
    } else if (type === 'IMPORT') {
      setHead(h => ({
        ...h,
        quotation_type: 'IMPORT',
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
      quotation_date: toDateInput(d.quotation_date),
      valid_until: toDateInput(d.valid_until),
      is_io_wise: d.is_io_wise ? 1 : 0,
    });
    setLines(
      (d.lines ?? []).map((l: any, i: number) => ({
        _key: `q${++keySeq}`,
        id: l.id,
        job_no: l.job_no ?? '',
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
      }))
    );
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
        qc.invalidateQueries({ queryKey: ['quotations'] });
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
        subtitle={isNew ? 'Create quotation with dynamic fields for Fabric, Yarn, Trims, General, Buyer & Import' : `Version ${head.version || 1} • ${head.quotation_date || ''}`}
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary" onClick={() => nav('/sales/quotations')}>
              <ArrowLeft size={15} /> Back
            </button>
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
                    <th className="min-w-[95px] px-2 py-2 text-right">Quotation Rate ({currSymbol})</th>
                    <th className="min-w-[95px] px-2 py-2 text-right">Confirm Rate ({currSymbol})</th>
                    
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
                      <tr key={l._key} className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-2 py-1.5 text-center font-mono text-[11px] text-slate-400">
                          {i + 1}
                        </td>

                        {/* I/O Num / Job No */}
                        {showJobAndStyle && (
                          <td className="px-1.5 py-1">
                            <input
                              type="text"
                              placeholder="I/O #"
                              value={l.job_no}
                              onChange={e => setLine(l._key, { job_no: e.target.value })}
                              className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                            />
                          </td>
                        )}

                        {/* Style No */}
                        {showJobAndStyle && (
                          <td className="px-1.5 py-1">
                            <select
                              value={l.style_id}
                              onChange={e => setLine(l._key, { style_id: Number(e.target.value) || '' })}
                              className="w-full rounded border border-surface-border bg-white px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
                            >
                              <option value="">— Style —</option>
                              {(styles.data ?? []).map((s: any) => (
                                <option key={s.id} value={s.id}>{s.code}</option>
                              ))}
                            </select>
                          </td>
                        )}

                        {/* FABRIC COLUMNS */}
                        {isFabric && (
                          <>
                            <td className="px-1.5 py-1">
                              <input
                                type="text"
                                placeholder='Dia (e.g. 30")'
                                value={l.dia}
                                onChange={e => setLine(l._key, { dia: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
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
                                placeholder="GSM"
                                value={l.gsm}
                                onChange={e => setLine(l._key, { gsm: e.target.value })}
                                className="w-full rounded border border-surface-border px-2 py-1 text-xs focus:border-brand-500 focus:outline-none"
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
                                placeholder="e.g. 30s, 34s, 40s"
                                value={l.yarn_count}
                                onChange={e => setLine(l._key, { yarn_count: e.target.value })}
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
                            placeholder="0.00"
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
                    <td colSpan={isDomesticLike ? 8 : 6} className="px-3 py-2.5 text-right uppercase tracking-wider text-[11px] text-slate-600">
                      Total Basic Value
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      {fmtDecimal(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0), 2)}
                    </td>
                    <td colSpan={isDomesticLike ? 4 : 2}></td>
                    <td className="px-3 py-2.5 text-right font-mono text-sm font-bold text-brand-700">
                      {currSymbol} {fmtDecimal(calc.basicAmount, 2)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
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
