import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Plus, Trash2, Save, FileText, Printer, ChevronDown,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http } from '../../lib/api';
import { useLookup, useStatuses } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import {
  PageHeader, Input, Select, Spinner, Badge, LoadingBlock, ErrorState,
} from '../../components/ui';
import { fmtDecimal, today, toDateInput } from '../../lib/format';

/* ─────────────────────────────────────────────────────────────── */

const INCOTERMS = ['FOB','CIF','CFR','EXW','DDP','DAP','FCA'];
const QUOTATION_TYPES = [
  { value: 'DOMESTIC', label: 'Domestic (INR)' },
  { value: 'IMPORT',   label: 'Import (Foreign Currency)' },
];
const GST_OPTIONS = [
  { value: 0,    label: '0%' },
  { value: 5,    label: '5%' },
  { value: 12,   label: '12%' },
  { value: 18,   label: '18%' },
  { value: 28,   label: '28%' },
];

interface QLine {
  _key: string;
  id?: number;
  job_no: string;
  style_id: number | '';
  color_id: number | '';
  size_id: number | '';
  description: string;
  qty: number | '';
  uom_id: number | '';
  unit_price: number | '';
  gst_rate: number;
  sort_order: number;
}

let keySeq = 0;
const newLine = (sort = 0): QLine => ({
  _key: `q${++keySeq}`, job_no: '', style_id: '', color_id: '', size_id: '',
  description: '', qty: '', uom_id: '', unit_price: '', gst_rate: 0, sort_order: sort,
});

/* ─────────────────────────────────────────────────────────────── */

export default function QuotationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  /* ── head state ── */
  const [head, setHead] = useState<Record<string, any>>({
    quotation_type: 'DOMESTIC',
    quotation_date: today(),
    version: 1,
    exchange_rate: 1,
    incoterm: 'FOB',
    // Domestic summary
    discount_pct: 0, discount_amount: 0,
    freight_charges: 0, packing_charges: 0, other_charges: 0,
    cgst_rate: 9, sgst_rate: 9, igst_rate: 0, round_off: 0,
    // Import summary
    courier_charges: 0, insurance: 0, bank_charges: 0,
    customs_duty: 0, clearing_charges: 0, margin_pct: 0,
  });
  const [lines, setLines] = useState<QLine[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const isImport = head.quotation_type === 'IMPORT';

  /* ── lookups ── */
  const buyers    = useLookup('buyers');
  const suppliers = useLookup('suppliers');
  const currencies = useLookup('currencies');
  const branches   = useLookup('branches');
  const agents     = useLookup('agents');
  const uoms       = useLookup('uoms');
  const styles     = useLookup('styles');
  const colors     = useLookup('colors');
  const sizes      = useLookup('sizes-all');   // individual sizes
  const statuses   = useStatuses('QUOTATION');

  const inrCurrency = currencies.data?.find((c: any) => c.code === 'INR');
  const usdCurrency = currencies.data?.find((c: any) => c.code === 'USD');

  // Ensure default currency is INR for Domestic quotations
  useEffect(() => {
    if (!currencies.data?.length) return;
    if (head.quotation_type === 'DOMESTIC') {
      if ((!head.currency_id || isNew) && inrCurrency) {
        setHead(h => ({ ...h, currency_id: inrCurrency.id, exchange_rate: 1 }));
      }
    }
  }, [currencies.data, isNew, head.quotation_type, inrCurrency]);

  const handleTypeChange = (type: string) => {
    if (type === 'DOMESTIC') {
      setHead(h => ({
        ...h,
        quotation_type: 'DOMESTIC',
        currency_id: inrCurrency?.id ?? 1,
        exchange_rate: 1,
      }));
    } else {
      setHead(h => ({
        ...h,
        quotation_type: 'IMPORT',
        currency_id: h.currency_id === inrCurrency?.id ? (usdCurrency?.id ?? '') : h.currency_id,
        exchange_rate: h.exchange_rate === 1 ? 84.50 : h.exchange_rate,
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
    });
    setLines(
      (d.lines ?? []).map((l: any, i: number) => ({
        _key: `q${++keySeq}`, id: l.id,
        job_no: l.job_no ?? '',
        style_id: l.style_id ?? '',
        color_id: l.color_id ?? '',
        size_id: l.size_id ?? '',
        description: l.description ?? '',
        qty: Number(l.qty),
        uom_id: l.uom_id ?? '',
        unit_price: Number(l.unit_price),
        gst_rate: Number(l.gst_rate ?? 0),
        sort_order: i,
      }))
    );
  }, [detail.data]);

  /* ── computed totals ── */
  const calc = useMemo(() => {
    const basicAmount = lines.reduce((sum, l) => {
      const q = Number(l.qty) || 0;
      const r = Number(l.unit_price) || 0;
      return sum + q * r;
    }, 0);

    if (!isImport) {
      // Domestic
      const discAmt = basicAmount * ((Number(head.discount_pct) || 0) / 100);
      const freight = Number(head.freight_charges) || 0;
      const packing = Number(head.packing_charges) || 0;
      const other   = Number(head.other_charges)   || 0;
      const taxableValue = basicAmount - discAmt + freight + packing + other;

      // Per-line GST grouped
      const gstLines = lines.reduce((acc, l) => {
        const q = Number(l.qty) || 0;
        const r = Number(l.unit_price) || 0;
        const lineAmt = q * r;
        const rate = Number(l.gst_rate) || 0;
        acc[rate] = (acc[rate] || 0) + lineAmt;
        return acc;
      }, {} as Record<number, number>);

      let totalGst = 0;
      const gstBreakdown = Object.entries(gstLines).map(([rate, amt]) => {
        const numRate = Number(rate);
        const cgst = amt * (numRate / 2 / 100);
        const sgst = amt * (numRate / 2 / 100);
        totalGst += cgst + sgst;
        return { rate: numRate, baseAmt: amt, cgst, sgst };
      });

      const grandTotal = taxableValue + totalGst + (Number(head.round_off) || 0);
      return { basicAmount, discAmt, taxableValue, totalGst, grandTotal, gstBreakdown };
    } else {
      // Import
      const courier  = Number(head.courier_charges) || 0;
      const freight  = Number(head.freight_charges)  || 0;
      const insure   = Number(head.insurance)         || 0;
      const packing  = Number(head.packing_charges)   || 0;
      const bank     = Number(head.bank_charges)      || 0;
      const customs  = Number(head.customs_duty)       || 0;
      const clearing = Number(head.clearing_charges)   || 0;
      const other    = Number(head.other_charges)      || 0;
      const landedCost = basicAmount + courier + freight + insure + packing + bank + customs + clearing + other;
      const marginAmt  = landedCost * ((Number(head.margin_pct) || 0) / 100);
      const finalSelling = landedCost + marginAmt;
      return { basicAmount, landedCost, marginAmt, finalSelling };
    }
  }, [lines, head, isImport]);

  /* ── helpers ── */
  const hSet = (k: string, v: any) => setHead(h => ({ ...h, [k]: v }));
  const toOpts = (data?: any[]) => (data ?? []).map((d: any) => ({ value: d.id, label: d.label }));
  const err = (k: string) => errors[k] ? <p className="text-[11px] text-red-500 mt-0.5">{errors[k]}</p> : null;

  /* ── line helpers ── */
  const addLine = () => setLines(ls => [...ls, newLine(ls.length)]);
  const removeLine = (key: string) => setLines(ls => ls.filter(l => l._key !== key));
  const setLine = (key: string, patch: Partial<QLine>) =>
    setLines(ls => ls.map(l => l._key === key ? { ...l, ...patch } : l));

  /* ── save ── */
  async function handleSave(draft = false) {
    const errs: Record<string, string> = {};
    if (!head.quotation_date) errs.quotation_date = 'Required';
    const resolvedCurrencyId = !isImport
      ? (inrCurrency?.id ?? head.currency_id ?? 1)
      : head.currency_id;

    if (!resolvedCurrencyId) errs.currency_id = 'Required';
    if (!isImport && !head.buyer_id) errs.buyer_id = 'Required';
    if (isImport && !head.supplier_id) errs.supplier_id = 'Required';
    if (lines.some(l => !l.qty || !l.unit_price)) errs.lines = 'All lines need Qty and Rate';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    // Build payload
    const payload = {
      ...head,
      currency_id: Number(resolvedCurrencyId),
      exchange_rate: isImport ? Number(head.exchange_rate || 1) : 1,
      total_amount: isImport ? (calc as any).finalSelling : (calc as any).grandTotal,
      taxable_value: isImport ? undefined : (calc as any).taxableValue,
      landed_cost: isImport ? (calc as any).landedCost : undefined,
      final_selling_rate: isImport ? (calc as any).finalSelling : undefined,
      lines: lines.map((l, i) => ({
        id: l.id,
        job_no: l.job_no || null,
        style_id: l.style_id || null,
        color_id: l.color_id || null,
        size_id: l.size_id || null,
        description: l.description || null,
        qty: Number(l.qty),
        uom_id: l.uom_id || null,
        unit_price: Number(l.unit_price),
        gst_rate: isImport ? 0 : (Number(l.gst_rate) || 0),
        gst_amount: isImport ? 0 : ((Number(l.qty) * Number(l.unit_price)) * (Number(l.gst_rate) / 100)),
        amount: (Number(l.qty) || 0) * (Number(l.unit_price) || 0),
        sort_order: i,
      })),
    };

    setSaving(true);
    try {
      if (isNew) {
        const res = await http.post<{ data: { id: number } }>('/quotations', payload);
        toast.success('Quotation created');
        qc.invalidateQueries({ queryKey: ['quotations'] });
        nav(`/sales/quotations/${res.data.id}`, { replace: true });
      } else {
        await http.put(`/quotations/${id}`, payload);
        toast.success('Quotation saved');
        qc.invalidateQueries({ queryKey: ['quotations', 'item', id] });
        qc.invalidateQueries({ queryKey: ['quotations'] });
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  /* ── loading ── */
  if (!isNew && detail.isLoading) return <LoadingBlock label="Loading quotation…" />;
  if (!isNew && detail.isError)   return <ErrorState message="Could not load quotation." />;

  const currSymbol = !isImport
    ? '₹'
    : (currencies.data?.find((c: any) => c.id === Number(head.currency_id))?.symbol ?? '$');

  /* ── render ── */
  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Page Header ── */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => nav('/sales/quotations')}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors">
            <ArrowLeft size={18} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-slate-900">
                {isNew ? 'New Quotation' : (head.quotation_no || 'Quotation')}
              </h1>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                ${isImport ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`}>
                {isImport ? 'Import' : 'Domestic'}
              </span>
            </div>
            <p className="text-sm text-slate-500">
              {isNew ? 'Home › Sales › Quotations › New' : `Home › Sales › Quotations › ${head.quotation_no}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isNew && (
            <button className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium
              text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
              <Printer size={15} /> Print
            </button>
          )}
          <button onClick={() => handleSave(true)} disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium
              text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50">
            <FileText size={15} /> Save as Draft
          </button>
          <button onClick={() => handleSave(false)} disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold
              text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 shadow-sm">
            {saving ? <Spinner size="sm" /> : <Save size={15} />}
            Submit Quotation
          </button>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-6 py-6 flex gap-6 items-start">
        {/* ── LEFT: header + lines ── */}
        <div className="flex-1 min-w-0 space-y-5">

          {/* ── Header Card ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
            {/* Type toggle */}
            <div className="flex items-center gap-3 mb-6">
              {QUOTATION_TYPES.map(t => (
                <button key={t.value}
                  onClick={() => handleTypeChange(t.value)}
                  className={`flex-1 py-2.5 rounded-lg border-2 text-sm font-semibold transition-all
                    ${head.quotation_type === t.value
                      ? (t.value === 'IMPORT' ? 'border-violet-500 bg-violet-50 text-violet-700' : 'border-sky-500 bg-sky-50 text-sky-700')
                      : 'border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300'}`}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-3 gap-4">
              {/* Row 1 */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Customer / Supplier *</label>
                {!isImport ? (
                  <select value={head.buyer_id ?? ''} onChange={e => hSet('buyer_id', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-400 bg-white">
                    <option value="">— Select Buyer —</option>
                    {(buyers.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.label}</option>)}
                  </select>
                ) : (
                  <select value={head.supplier_id ?? ''} onChange={e => hSet('supplier_id', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-400 bg-white">
                    <option value="">— Select Supplier —</option>
                    {(suppliers.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                )}
                {err('buyer_id')}{err('supplier_id')}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Quotation Type</label>
                <div className="px-3 py-2 rounded-lg border border-slate-200 text-sm bg-slate-50 text-slate-700 font-medium">
                  {isImport ? 'Import' : 'Domestic'}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Currency *</label>
                {!isImport ? (
                  <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 text-sm bg-slate-50 text-slate-700 font-medium">
                    <span>INR — Indian Rupee (₹)</span>
                    <span className="text-[11px] bg-sky-100 text-sky-700 px-2 py-0.5 rounded font-semibold">Domestic INR</span>
                  </div>
                ) : (
                  <select value={head.currency_id ?? ''} onChange={e => hSet('currency_id', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-400 bg-white">
                    <option value="">— Select Currency —</option>
                    {(currencies.data ?? []).filter((c: any) => c.code !== 'INR').map((c: any) => (
                      <option key={c.id} value={c.id}>{c.code} — {c.label}</option>
                    ))}
                  </select>
                )}
                {err('currency_id')}
              </div>

              {/* Row 2 */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Quotation Date *</label>
                <input type="date" value={head.quotation_date ?? ''} onChange={e => hSet('quotation_date', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500" />
                {err('quotation_date')}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Valid Till</label>
                <input type="date" value={head.valid_until ?? ''} onChange={e => hSet('valid_until', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500" />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Payment Terms</label>
                <input type="text" value={head.payment_terms ?? ''} onChange={e => hSet('payment_terms', e.target.value)}
                  placeholder="e.g. TT Advance, LC at Sight"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500" />
              </div>

              {/* Row 3 */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Buyer (Incoterms)</label>
                <select value={head.incoterm ?? 'FOB'} onChange={e => hSet('incoterm', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500 bg-white">
                  {INCOTERMS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              {isImport && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Port of Loading</label>
                  <input type="text" value={head.port_of_loading ?? ''} onChange={e => hSet('port_of_loading', e.target.value)}
                    placeholder="e.g. Chennai, India"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500" />
                </div>
              )}

              {isImport && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Port of Discharge</label>
                  <input type="text" value={head.port_of_discharge ?? ''} onChange={e => hSet('port_of_discharge', e.target.value)}
                    placeholder="e.g. Hamburg, Germany"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500" />
                </div>
              )}

              {isImport && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Exchange Rate</label>
                  <input type="number" step="0.01" value={head.exchange_rate ?? 1} onChange={e => hSet('exchange_rate', e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500" />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Enquiry Reference</label>
                <input type="text" value={head.enquiry_ref ?? ''} onChange={e => hSet('enquiry_ref', e.target.value)}
                  placeholder="Enter enquiry ref"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500" />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Sales Person / Agent</label>
                <select value={head.agent_id ?? ''} onChange={e => hSet('agent_id', e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500 bg-white">
                  <option value="">— None —</option>
                  {(agents.data ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* ── Product Lines ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-800">Product Details</h2>
              <button onClick={addLine}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold
                  text-brand-700 bg-brand-50 rounded-lg hover:bg-brand-100 transition-colors border border-brand-200">
                <Plus size={13} /> Add Line
              </button>
            </div>
            {errors.lines && <p className="px-6 py-2 text-xs text-red-600 bg-red-50">{errors.lines}</p>}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide w-8">#</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Job No</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Style / Item</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Description</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Color</th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Size</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Qty (Pcs)</th>
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Rate ({currSymbol})</th>
                    {!isImport && (
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">GST %</th>
                    )}
                    <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wide">Amount</th>
                    <th className="px-3 py-2.5 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {lines.map((l, i) => {
                    const amount = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
                    return (
                      <tr key={l._key} className="hover:bg-slate-50/60 group">
                        <td className="px-3 py-2 text-xs text-slate-400">{i + 1}</td>
                        <td className="px-3 py-2">
                          <input type="text" value={l.job_no} onChange={e => setLine(l._key, { job_no: e.target.value })}
                            placeholder="Job no"
                            className="w-24 px-2 py-1.5 rounded-md border border-slate-200 text-xs focus:ring-1 focus:ring-brand-400" />
                        </td>
                        <td className="px-3 py-2">
                          <select value={l.style_id} onChange={e => setLine(l._key, { style_id: Number(e.target.value) || '' })}
                            className="w-36 px-2 py-1.5 rounded-md border border-slate-200 text-xs focus:ring-1 focus:ring-brand-400 bg-white">
                            <option value="">— Style —</option>
                            {(styles.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.code}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <input type="text" value={l.description} onChange={e => setLine(l._key, { description: e.target.value })}
                            placeholder="Description"
                            className="w-40 px-2 py-1.5 rounded-md border border-slate-200 text-xs focus:ring-1 focus:ring-brand-400" />
                        </td>
                        <td className="px-3 py-2">
                          <select value={l.color_id} onChange={e => setLine(l._key, { color_id: Number(e.target.value) || '' })}
                            className="w-32 px-2 py-1.5 rounded-md border border-slate-200 text-xs focus:ring-1 focus:ring-brand-400 bg-white">
                            <option value="">— Color —</option>
                            {(colors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.label}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          {/* Individual size picker — no group auto-load */}
                          <select value={l.size_id} onChange={e => setLine(l._key, { size_id: Number(e.target.value) || '' })}
                            className="w-32 px-2 py-1.5 rounded-md border border-slate-200 text-xs focus:ring-1 focus:ring-brand-400 bg-white">
                            <option value="">— Size —</option>
                            {(sizes.data ?? []).map((s: any) => (
                              <option key={s.id} value={s.id}>{s.size_label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" value={l.qty} onChange={e => setLine(l._key, { qty: Number(e.target.value) || '' })}
                            min="0" placeholder="0"
                            className="w-20 px-2 py-1.5 rounded-md border border-slate-200 text-xs text-right focus:ring-1 focus:ring-brand-400" />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" value={l.unit_price} onChange={e => setLine(l._key, { unit_price: Number(e.target.value) || '' })}
                            step="0.01" min="0" placeholder="0.00"
                            className="w-24 px-2 py-1.5 rounded-md border border-slate-200 text-xs text-right focus:ring-1 focus:ring-brand-400" />
                        </td>
                        {!isImport && (
                          <td className="px-3 py-2">
                            <select value={l.gst_rate} onChange={e => setLine(l._key, { gst_rate: Number(e.target.value) })}
                              className="w-20 px-2 py-1.5 rounded-md border border-slate-200 text-xs focus:ring-1 focus:ring-brand-400 bg-white">
                              {GST_OPTIONS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                            </select>
                          </td>
                        )}
                        <td className="px-3 py-2 text-right">
                          <span className="text-xs font-medium text-slate-700">
                            {fmtDecimal(amount, 2)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <button onClick={() => removeLine(l._key)}
                            className="p-1 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors
                              opacity-0 group-hover:opacity-100">
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50">
                    <td colSpan={!isImport ? 7 : 6} className="px-3 py-2.5 text-xs font-semibold text-slate-600 text-right">
                      Basic Amount
                    </td>
                    <td className="px-3 py-2.5 text-right text-sm font-bold text-slate-900">
                      {fmtDecimal(calc.basicAmount, 2)}
                    </td>
                    {!isImport && <td></td>}
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* ── Notes & Terms ── */}
          <div className="grid grid-cols-2 gap-5">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Notes</h3>
              <textarea value={head.remarks ?? ''} onChange={e => hSet('remarks', e.target.value)}
                rows={4} placeholder="Internal notes or remarks…"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm resize-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
              <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Terms & Conditions</h3>
              <textarea value={head.terms ?? ''} onChange={e => hSet('terms', e.target.value)}
                rows={4} placeholder="Standard T&C or special terms…"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm resize-none focus:ring-2 focus:ring-brand-500" />
            </div>
          </div>
        </div>

        {/* ── RIGHT: Summary Panel ── */}
        <div className="w-72 shrink-0 sticky top-6 space-y-4">
          <div className={`rounded-xl border shadow-sm overflow-hidden
            ${isImport ? 'border-violet-200' : 'border-sky-200'}`}>
            <div className={`px-5 py-3 flex items-center gap-2
              ${isImport ? 'bg-violet-600' : 'bg-sky-600'}`}>
              <FileText size={15} className="text-white/80" />
              <span className="text-sm font-semibold text-white">
                {isImport ? 'Import Cost Summary' : 'Domestic Quotation'}
              </span>
            </div>

            <div className="bg-white px-5 py-4 space-y-0">
              {/* ─── DOMESTIC PANEL ─── */}
              {!isImport && (() => {
                const d = calc as any;
                const totalGstBreakdown = d.gstBreakdown ?? [];
                return (
                  <>
                    <SumRow label="Basic Amount" value={d.basicAmount} sym={currSymbol} />
                    <div className="flex items-center justify-between py-1.5">
                      <span className="text-xs text-slate-600">Discount %</span>
                      <div className="flex items-center gap-1">
                        <input type="number" value={head.discount_pct ?? 0}
                          onChange={e => hSet('discount_pct', Number(e.target.value))}
                          className="w-14 px-1.5 py-0.5 text-xs text-right border border-slate-200 rounded focus:ring-1 focus:ring-brand-400" />
                        <span className="text-xs text-slate-500">= {fmtDecimal(d.discAmt, 2)}</span>
                      </div>
                    </div>
                    <EditRow label="Freight / Transport" field="freight_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Packing Charges" field="packing_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Other Charges" field="other_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <div className="border-t border-slate-100 mt-2 pt-2">
                      <SumRow label="Taxable Value" value={d.taxableValue} sym={currSymbol} bold />
                    </div>
                    {/* GST breakdown per rate */}
                    {totalGstBreakdown.length > 0 ? (
                      totalGstBreakdown.map((g: any) => (
                        <div key={g.rate} className="pl-2 border-l-2 border-amber-200 my-1 space-y-0.5">
                          <div className="flex justify-between">
                            <span className="text-[11px] text-slate-500">CGST @ {g.rate / 2}%</span>
                            <span className="text-[11px] text-slate-600">{fmtDecimal(g.cgst, 2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-[11px] text-slate-500">SGST @ {g.rate / 2}%</span>
                            <span className="text-[11px] text-slate-600">{fmtDecimal(g.sgst, 2)}</span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <>
                        <GstRow label="CGST %" rateField="cgst_rate" amtField="cgst_amount" head={head} hSet={hSet} sym={currSymbol} />
                        <GstRow label="SGST %" rateField="sgst_rate" amtField="sgst_amount" head={head} hSet={hSet} sym={currSymbol} />
                        <GstRow label="IGST %" rateField="igst_rate" amtField="igst_amount" head={head} hSet={hSet} sym={currSymbol} />
                      </>
                    )}
                    <div className="flex items-center justify-between py-1">
                      <span className="text-xs text-slate-500">Round Off</span>
                      <input type="number" step="0.01" value={head.round_off ?? 0}
                        onChange={e => hSet('round_off', Number(e.target.value))}
                        className="w-20 px-1.5 py-0.5 text-xs text-right border border-slate-200 rounded focus:ring-1 focus:ring-brand-400" />
                    </div>
                    <div className="border-t-2 border-slate-800 mt-3 pt-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-slate-900">Grand Total (INR)</span>
                        <span className="text-lg font-bold text-sky-700">
                          ₹ {fmtDecimal(d.grandTotal, 2)}
                        </span>
                      </div>
                    </div>
                  </>
                );
              })()}

              {/* ─── IMPORT PANEL ─── */}
              {isImport && (() => {
                const d = calc as any;
                return (
                  <>
                    <SumRow label="Product Value" value={d.basicAmount} sym={currSymbol} />
                    <EditRow label="Courier Charges" field="courier_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Freight Charges" field="freight_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Insurance" field="insurance" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Packing Charges" field="packing_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Bank Charges" field="bank_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Customs / Duty" field="customs_duty" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Clearing Charges" field="clearing_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <EditRow label="Other Charges" field="other_charges" head={head} hSet={hSet} sym={currSymbol} />
                    <div className="border-t border-slate-100 mt-2 pt-2">
                      <SumRow label="Landed Cost" value={d.landedCost} sym={currSymbol} bold />
                    </div>
                    <div className="flex items-center justify-between py-1.5">
                      <span className="text-xs text-slate-600">Margin %</span>
                      <div className="flex items-center gap-1">
                        <input type="number" value={head.margin_pct ?? 0}
                          onChange={e => hSet('margin_pct', Number(e.target.value))}
                          className="w-14 px-1.5 py-0.5 text-xs text-right border border-slate-200 rounded focus:ring-1 focus:ring-brand-400" />
                        <span className="text-xs text-slate-500">= {fmtDecimal(d.marginAmt, 2)}</span>
                      </div>
                    </div>
                    <SumRow label="Final Selling Rate" value={d.finalSelling} sym={currSymbol} />
                    <div className="border-t-2 border-slate-800 mt-3 pt-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-bold text-slate-900">Final Quotation Value</span>
                        <span className="text-lg font-bold text-violet-700">
                          {currSymbol} {fmtDecimal(d.finalSelling, 2)}
                        </span>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* Status */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Status</label>
            <select value={head.status_id ?? ''} onChange={e => hSet('status_id', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-brand-500 bg-white">
              <option value="">— Select Status —</option>
              {(statuses.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Small helper components ─────────────────── */

function SumRow({ label, value, sym, bold }: { label: string; value: number; sym: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${bold ? 'font-semibold' : ''}`}>
      <span className={`text-xs ${bold ? 'text-slate-800' : 'text-slate-600'}`}>{label}</span>
      <span className={`text-xs ${bold ? 'text-slate-900' : 'text-slate-700'}`}>{fmtDecimal(value, 2)}</span>
    </div>
  );
}

function EditRow({ label, field, head, hSet, sym }: {
  label: string; field: string; head: Record<string, any>;
  hSet: (k: string, v: any) => void; sym: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-slate-600">{label}</span>
      <input type="number" step="0.01" min="0" value={head[field] ?? 0}
        onChange={e => hSet(field, Number(e.target.value))}
        className="w-24 px-1.5 py-0.5 text-xs text-right border border-slate-200 rounded focus:ring-1 focus:ring-brand-400" />
    </div>
  );
}

function GstRow({ label, rateField, amtField, head, hSet, sym }: {
  label: string; rateField: string; amtField: string;
  head: Record<string, any>; hSet: (k: string, v: any) => void; sym: string;
}) {
  const taxable = Number(head.taxable_value) || 0;
  const rate = Number(head[rateField]) || 0;
  const amount = taxable * (rate / 100);
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-slate-500">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" step="0.5" min="0" value={rate}
          onChange={e => hSet(rateField, Number(e.target.value))}
          className="w-12 px-1.5 py-0.5 text-xs text-right border border-slate-200 rounded focus:ring-1 focus:ring-brand-400" />
        <span className="text-[11px] text-slate-500">= {fmtDecimal(amount, 2)}</span>
      </div>
    </div>
  );
}
