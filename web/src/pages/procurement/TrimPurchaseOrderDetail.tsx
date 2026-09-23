import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Plus, Trash2, Scissors, Printer, Layers, Sparkles, RefreshCw
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Badge } from '../../components/ui';

interface TrimLine {
  id?: number;
  _key: string;
  so_id?: string | number;
  style_id?: string | number;
  trim_id: string | number;
  trim_name?: string;
  specification: string;
  color_name: string;
  trim_size: string;
  order_qty: number;
  uom_id: number;
  rate: number;
  amount: number;
  gst_rate: number;
  igst_rate?: number;
  igst_amount?: number;
  cgst_amount?: number;
  sgst_amount?: number;
  tax_amount: number;
  net_amount: number;
}

let tseq = 0;
const emptyTrimLine = (): TrimLine => ({
  _key: `tl_${++tseq}`,
  so_id: '',
  style_id: '',
  trim_id: '',
  specification: '4 Hole, 15L',
  color_name: 'Navy',
  trim_size: '15L',
  order_qty: 5000,
  uom_id: 1, // PCS
  rate: 0.85,
  amount: 4250,
  gst_rate: 18,
  tax_amount: 765,
  net_amount: 5015,
});

export default function TrimPurchaseOrderDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [saving, setSaving] = useState(false);
  const [showPrintPO, setShowPrintPO] = useState(false);

  // Lookups
  const { data: suppliers = [] } = useQuery({
    queryKey: ['lookups', 'suppliers'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/suppliers')).data || [],
  });

  const { data: styles = [] } = useQuery({
    queryKey: ['lookups', 'styles'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/styles')).data || [],
  });

  const { data: trims = [] } = useQuery({
    queryKey: ['lookups', 'trims'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/trims')).data || [],
  });

  const { data: salesOrders = [] } = useQuery({
    queryKey: ['lookups', 'sales-orders'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/sales-orders')).data || [],
  });

  const { data: currencies = [] } = useQuery({
    queryKey: ['lookups', 'currencies'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/currencies')).data || [],
  });

  // Header state
  const [head, setHead] = useState({
    id: isNew ? undefined : Number(id),
    po_no: '',
    io_no: 'IO-2026-001',
    po_date: today(),
    supplier_id: '',
    style_id: '',
    currency_id: '1',
    exchange_rate: 1.0,
    delivery_date: '',
    payment_terms: '30 Days Net',
    status: 'APPROVED',
    is_interstate: false,
    remarks: '',
  });

  const [filterBomOnly, setFilterBomOnly] = useState(true);

  // Active BOM query for this style/job
  const activeStyleId = head.style_id;
  const { data: bomData } = useQuery({
    queryKey: ['bom-for-job-trim', activeStyleId, head.io_no],
    queryFn: async () => {
      if (!activeStyleId) return null;
      const res = await http.get<{ data: any }>(`/boms/for-job?style_id=${activeStyleId}&io_no=${head.io_no}`);
      return res.data;
    },
    enabled: Boolean(activeStyleId),
  });

  const bomTrims = bomData?.trims || [];

  const [lines, setLines] = useState<TrimLine[]>([emptyTrimLine()]);

  // Load existing PO
  const { data: existingPo } = useQuery({
    queryKey: ['trim-purchase-order', id],
    queryFn: async () => {
      if (isNew) return null;
      const res = await http.get<{ data: any }>(`/trim-pos/${id}`);
      return res.data;
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (existingPo) {
      setHead({
        id: existingPo.id,
        po_no: existingPo.po_no,
        io_no: existingPo.io_no,
        po_date: existingPo.po_date?.split('T')[0] || today(),
        supplier_id: String(existingPo.supplier_id || ''),
        style_id: String(existingPo.style_id || ''),
        currency_id: String(existingPo.currency_id || '1'),
        exchange_rate: Number(existingPo.exchange_rate || 1.0),
        delivery_date: existingPo.delivery_date?.split('T')[0] || '',
        payment_terms: existingPo.payment_terms || '30 Days Net',
        status: existingPo.status || 'APPROVED',
        is_interstate: Boolean(existingPo.is_interstate),
        remarks: existingPo.remarks || '',
      });

      if (existingPo.lines?.length) {
        setLines(
          existingPo.lines.map((l: any) => ({
            _key: `tl_${++tseq}`,
            id: l.id,
            so_id: l.so_id ? String(l.so_id) : '',
            style_id: l.style_id ? String(l.style_id) : '',
            trim_id: l.trim_id,
            trim_name: l.trim_name,
            specification: l.specification || '',
            color_name: l.color_name || '',
            trim_size: l.trim_size || '',
            order_qty: Number(l.order_qty),
            uom_id: l.uom_id,
            rate: Number(l.rate),
            amount: Number(l.amount),
            gst_rate: Number(l.gst_rate),
            igst_rate: Number(l.igst_rate || 0),
            igst_amount: Number(l.igst_amount || 0),
            tax_amount: Number(l.tax_amount),
            net_amount: Number(l.net_amount),
          }))
        );
      }
    }
  }, [existingPo]);

  const handleLoadFromBOM = () => {
    if (!bomTrims.length) {
      toast('No trims defined in this BOM', 'warning');
      return;
    }
    const newLines = bomTrims.map((bt: any) => {
      const trimMaster = trims.find((t: any) => t.id === bt.trim_id);
      const reqQty = bt.order_required_qty || Math.round(Number(bt.consumption || 1) * 1000);
      const rate = Number(bt.std_rate || trimMaster?.std_rate || 10);
      const amt = reqQty * rate;
      const gst = 12;
      const tax = (amt * gst) / 100;
      return {
        _key: `tl_${++tseq}`,
        so_id: '',
        style_id: head.style_id,
        trim_id: String(bt.trim_id),
        trim_name: bt.trim_name || trimMaster?.trim_name,
        specification: bt.remarks || trimMaster?.specification || '',
        color_name: bt.color_name || '',
        trim_size: bt.size_code || '',
        order_qty: reqQty,
        uom_id: bt.uom_id || trimMaster?.base_uom || 1,
        rate: rate,
        amount: amt,
        gst_rate: gst,
        igst_rate: head.is_interstate ? gst : 0,
        igst_amount: head.is_interstate ? tax : 0,
        tax_amount: tax,
        net_amount: amt + tax,
      };
    });
    setLines(newLines);
    toast(`Loaded ${newLines.length} trim items from Style BOM ${bomData.bom.bom_no}`, 'success');
  };

  // Update line calculations
  const updateLine = (idx: number, patch: Partial<TrimLine>) => {
    setLines((prev) => {
      const copy = [...prev];
      const cur = { ...copy[idx], ...patch };

      const qty = Number(cur.order_qty) || 0;
      const rate = Number(cur.rate) || 0;
      const gst = Number(cur.gst_rate) || 0;

      const amt = Math.round(qty * rate * 100) / 100;
      let cgst = 0;
      let sgst = 0;
      let igst = 0;

      if (head.is_interstate) {
        igst = Math.round(((amt * gst) / 100) * 100) / 100;
      } else {
        cgst = Math.round(((amt * (gst / 2)) / 100) * 100) / 100;
        sgst = Math.round(((amt * (gst / 2)) / 100) * 100) / 100;
      }
      const tax = cgst + sgst + igst;
      const net = amt + tax;

      cur.amount = amt;
      cur.cgst_amount = cgst;
      cur.sgst_amount = sgst;
      cur.igst_amount = igst;
      cur.igst_rate = head.is_interstate ? gst : 0;
      cur.tax_amount = tax;
      cur.net_amount = net;

      copy[idx] = cur;
      return copy;
    });
  };

  const addLine = () => setLines((prev) => [...prev, emptyTrimLine()]);
  const removeLine = (idx: number) => {
    if (lines.length === 1) return;
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  // Totals
  const totals = useMemo(() => {
    const totalAmount = lines.reduce((s, l) => s + (l.amount || 0), 0);
    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    lines.forEach((l) => {
      const amt = l.amount || 0;
      const gst = l.gst_rate || 0;
      if (head.is_interstate) {
        igstAmount += Math.round(((amt * gst) / 100) * 100) / 100;
      } else {
        cgstAmount += Math.round(((amt * (gst / 2)) / 100) * 100) / 100;
        sgstAmount += Math.round(((amt * (gst / 2)) / 100) * 100) / 100;
      }
    });

    const taxAmount = cgstAmount + sgstAmount + igstAmount;
    const grandTotal = totalAmount + taxAmount;
    const totalQty = lines.reduce((s, l) => s + (l.order_qty || 0), 0);

    return { totalAmount, cgstAmount, sgstAmount, igstAmount, taxAmount, grandTotal, totalQty };
  }, [lines, head.is_interstate]);

  const handleSave = async () => {
    if (!head.io_no) {
      toast('Please enter I/O No', 'error');
      return;
    }
    if (!head.supplier_id) {
      toast('Please select a Supplier', 'error');
      return;
    }
    if (lines.some((l) => !l.trim_id || l.order_qty <= 0)) {
      toast('Please ensure all lines have a valid Trim item and Order Qty > 0', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...head,
        supplier_id: Number(head.supplier_id),
        style_id: head.style_id ? Number(head.style_id) : null,
        currency_id: Number(head.currency_id || 1),
        exchange_rate: Number(head.exchange_rate || 1.0),
        is_interstate: head.is_interstate ? 1 : 0,
        total_amount: totals.totalAmount,
        tax_amount: totals.taxAmount,
        cgst_amount: totals.cgstAmount,
        sgst_amount: totals.sgstAmount,
        igst_amount: totals.igstAmount,
        grand_total: totals.grandTotal,
        lines: lines.map((l) => ({
          id: l.id,
          so_id: l.so_id ? Number(l.so_id) : undefined,
          style_id: l.style_id ? Number(l.style_id) : (head.style_id ? Number(head.style_id) : undefined),
          trim_id: Number(l.trim_id),
          specification: l.specification,
          color_name: l.color_name,
          trim_size: l.trim_size,
          order_qty: Number(l.order_qty),
          uom_id: Number(l.uom_id || 1),
          rate: Number(l.rate),
          amount: Number(l.amount),
          gst_rate: Number(l.gst_rate),
          igst_rate: head.is_interstate ? Number(l.gst_rate) : 0,
          igst_amount: head.is_interstate ? Number(l.tax_amount) : 0,
          tax_amount: Number(l.tax_amount),
          net_amount: Number(l.net_amount),
        })),
      };

      if (isNew) {
        const res = await http.post<{ data: { id: number; po_no: string } }>('/trim-pos', payload);
        toast(`Trim PO ${res.data.po_no} created successfully`);
        qc.invalidateQueries({ queryKey: ['trim-purchase-orders'] });
        nav('/procurement/trim/orders');
      } else {
        await http.put(`/trim-pos/${id}`, payload);
        toast('Trim PO updated successfully');
        qc.invalidateQueries({ queryKey: ['trim-purchase-orders'] });
        qc.invalidateQueries({ queryKey: ['trim-purchase-order', id] });
        nav('/procurement/trim/orders');
      }
    } catch (err: any) {
      toast(err?.response?.data?.error?.message || 'Failed to save Trim PO', 'error');
    } finally {
      setSaving(false);
    }
  };

  const selectedCurrency = currencies.find((c: any) => String(c.id) === String(head.currency_id)) || { code: 'INR', symbol: '₹' };
  const currSymbol = selectedCurrency.symbol || (selectedCurrency.code === 'INR' ? '₹' : selectedCurrency.code || '₹');
  const currCode = selectedCurrency.code || 'INR';
  const isForeignCurrency = selectedCurrency.code && selectedCurrency.code !== 'INR';
  const inrGrandTotal = totals.grandTotal * (Number(head.exchange_rate) || 1);

  return (
    <div className="space-y-6 pb-12">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => nav('/procurement/trim/orders')}
            className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 transition"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-emerald-100 text-emerald-700">
                <Scissors size={18} />
              </span>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                {isNew ? 'New Trim Purchase Order' : `Trim PO: ${head.po_no || id}`}
              </h1>
              {!isNew && <Badge variant="info">{head.status}</Badge>}
              {isForeignCurrency && (
                <span className="bg-amber-100 text-amber-800 text-[11px] font-bold px-2 py-0.5 rounded border border-amber-300">
                  Import PO ({selectedCurrency.code})
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Procurement order for trims, buttons, zippers, thread, labels & accessories (Domestic & Import)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isNew && (
            <button
              type="button"
              onClick={() => setShowPrintPO(true)}
              className="btn-secondary text-xs flex items-center gap-1.5 shadow-sm border border-slate-300 hover:bg-slate-50"
            >
              <Printer size={15} /> Print PO
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="btn-primary text-xs flex items-center gap-1.5 shadow-sm"
          >
            <Save size={15} /> {saving ? 'Saving...' : 'Save Trim PO'}
          </button>
        </div>
      </div>

      {/* KPI Cards Strip */}
      <div className={`grid grid-cols-2 ${isForeignCurrency ? 'sm:grid-cols-6' : 'sm:grid-cols-5'} gap-3`}>
        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
          <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Total Items</div>
          <div className="text-lg font-bold text-slate-900 mt-0.5 font-mono">{lines.length} Lines</div>
        </div>
        <div className="p-3 bg-emerald-50/70 rounded-xl border border-emerald-200">
          <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">Order Qty</div>
          <div className="text-lg font-bold text-emerald-900 mt-0.5 font-mono">{fmtDecimal(totals.totalQty)}</div>
        </div>
        <div className="p-3 bg-sky-50/70 rounded-xl border border-sky-200">
          <div className="text-[11px] font-semibold text-sky-700 uppercase tracking-wider">Taxable Value</div>
          <div className="text-lg font-bold text-sky-900 mt-0.5 font-mono">{currSymbol}{fmtDecimal(totals.totalAmount, 2)}</div>
        </div>
        <div className="p-3 bg-purple-50/70 rounded-xl border border-purple-200">
          <div className="text-[11px] font-semibold text-purple-700 uppercase tracking-wider">
            {head.is_interstate ? 'IGST (Total)' : 'CGST + SGST'}
          </div>
          <div className="text-lg font-bold text-purple-900 mt-0.5 font-mono">{currSymbol}{fmtDecimal(totals.taxAmount, 2)}</div>
        </div>
        <div className="p-3 bg-emerald-100/60 rounded-xl border border-emerald-300">
          <div className="text-[11px] font-semibold text-emerald-900 uppercase tracking-wider">Grand Total</div>
          <div className="text-lg font-bold text-emerald-950 mt-0.5 font-mono">{currSymbol}{fmtDecimal(totals.grandTotal, 2)}</div>
        </div>
        {isForeignCurrency && (
          <div className="p-3 bg-amber-50 rounded-xl border border-amber-300">
            <div className="text-[11px] font-semibold text-amber-800 uppercase tracking-wider">INR Equivalent</div>
            <div className="text-lg font-bold text-amber-950 mt-0.5 font-mono">₹{fmtDecimal(inrGrandTotal, 2)}</div>
            <div className="text-[10px] text-amber-700">@ ₹{head.exchange_rate} / {selectedCurrency.code}</div>
          </div>
        )}
      </div>

      {/* Header Form */}
      <div className="card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-100 pb-2 gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Order Information & Linkage
          </h3>

          {/* Inter-State IGST Toggle */}
          <label className="flex items-center gap-2 cursor-pointer bg-slate-50 hover:bg-slate-100 border border-slate-200 px-3 py-1 rounded-lg text-xs transition">
            <input
              type="checkbox"
              checked={head.is_interstate}
              onChange={(e) => setHead({ ...head, is_interstate: e.target.checked })}
              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="font-semibold text-slate-700">Inter-State Supply (IGST Applicable)</span>
            <span className="text-[10px] text-slate-400 font-normal">
              {head.is_interstate ? 'Single IGST tax rate applied' : 'Split CGST + SGST applied'}
            </span>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <label className="label">I/O No (Internal Order) *</label>
            <input
              type="text"
              required
              value={head.io_no}
              onChange={(e) => setHead({ ...head, io_no: e.target.value })}
              placeholder="e.g. IO-2026-001"
              className="input text-xs font-semibold text-slate-900"
            />
          </div>
          <div>
            <label className="label">Style Reference (Default)</label>
            <select
              value={head.style_id}
              onChange={(e) => setHead({ ...head, style_id: e.target.value })}
              className="input text-xs"
            >
              <option value="">-- Select Style --</option>
              {styles.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.style_code} - {s.style_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Supplier / Vendor *</label>
            <select
              required
              value={head.supplier_id}
              onChange={(e) => setHead({ ...head, supplier_id: e.target.value })}
              className="input text-xs font-medium"
            >
              <option value="">-- Choose Supplier --</option>
              {suppliers.map((s: any) => (
                <option key={s.id} value={s.id}>{s.party_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">PO Date *</label>
            <input
              type="date"
              required
              value={head.po_date}
              onChange={(e) => setHead({ ...head, po_date: e.target.value })}
              className="input text-xs"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4 text-xs">
          <div>
            <label className="label">Expected Delivery Date</label>
            <input
              type="date"
              value={head.delivery_date}
              onChange={(e) => setHead({ ...head, delivery_date: e.target.value })}
              className="input text-xs"
            />
          </div>
          <div>
            <label className="label">Payment Terms</label>
            <input
              type="text"
              value={head.payment_terms}
              onChange={(e) => setHead({ ...head, payment_terms: e.target.value })}
              placeholder="30 Days Net"
              className="input text-xs"
            />
          </div>
          <div>
            <label className="label font-semibold text-emerald-800">Currency *</label>
            <select
              value={head.currency_id}
              onChange={(e) => {
                const cid = e.target.value;
                const cur = (currencies as any[]).find((c: any) => String(c.id) === cid);
                setHead({
                  ...head,
                  currency_id: cid,
                  exchange_rate: cur?.code === 'INR' ? 1.0 : (head.exchange_rate && head.exchange_rate !== 1.0 ? head.exchange_rate : (cur?.code === 'USD' ? 84.50 : cur?.code === 'EUR' ? 91.20 : 1.0)),
                });
              }}
              className="input text-xs font-semibold bg-emerald-50/40 border-emerald-300"
            >
              {(currencies as any[]).map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.code} ({c.symbol || ''}) - {c.label || c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Exchange Rate (to INR)</label>
            <input
              type="number"
              step="0.0001"
              value={head.exchange_rate}
              disabled={!isForeignCurrency}
              onChange={(e) => setHead({ ...head, exchange_rate: Number(e.target.value) })}
              className={`input text-xs ${isForeignCurrency ? 'font-semibold border-amber-300 bg-amber-50/50' : 'bg-slate-50 text-slate-500'}`}
            />
          </div>
          <div>
            <label className="label">Order Status</label>
            <select
              value={head.status}
              onChange={(e) => setHead({ ...head, status: e.target.value })}
              className="input text-xs"
            >
              <option value="DRAFT">Draft</option>
              <option value="APPROVED">Approved</option>
              <option value="PARTIAL">Partial</option>
              <option value="CLOSED">Closed</option>
            </select>
          </div>
        </div>
      </div>

      {/* BOM Linkage & Auto-Fill Banner */}
      {head.style_id && (
        <div className="rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50/80 via-white to-indigo-50/50 p-4 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="p-2 rounded-lg bg-indigo-100 text-indigo-700 mt-0.5">
                <Sparkles size={16} />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-bold text-indigo-950 uppercase tracking-wide">
                    Bill of Materials (BOM) Integration
                  </h4>
                  {bomData?.bom && (
                    <span className="bg-indigo-100 text-indigo-800 text-[10.5px] font-bold px-2 py-0.5 rounded border border-indigo-300">
                      BOM: {bomData.bom.bom_no} · v{bomData.bom.version}
                    </span>
                  )}
                </div>
                <p className="text-xs text-indigo-800 mt-0.5">
                  {bomData?.bom
                    ? `Style "${bomData.bom.style_code}" has ${bomTrims.length} trim component(s) defined in active BOM. Only planned BOM trims are populated/suggested.`
                    : 'No active BOM found for this style. Showing all Master trim catalog items.'}
                </p>
              </div>
            </div>

            {bomTrims.length > 0 && (
              <div className="flex items-center gap-3 shrink-0">
                <label className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-indigo-900">
                  <input
                    type="checkbox"
                    checked={filterBomOnly}
                    onChange={(e) => setFilterBomOnly(e.target.checked)}
                    className="rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span>Show BOM Items Only</span>
                </label>
                <button
                  type="button"
                  onClick={handleLoadFromBOM}
                  className="btn-primary bg-indigo-600 hover:bg-indigo-700 text-white text-xs py-1.5 px-3 flex items-center gap-1.5 shadow-sm"
                >
                  <RefreshCw size={13} />
                  <span>Load Trims from BOM ({bomTrims.length})</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Lines Table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50/70 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
              <Layers size={14} className="text-emerald-600" />
              <span>Trim Order Lines & Job Allocation ({lines.length})</span>
            </h3>
            <p className="text-[11px] text-slate-500">
              Arranged as: S.No → I/O (Job) → Style → Trim Item → Specifications & Rates
            </p>
          </div>
          <button
            type="button"
            onClick={addLine}
            className="btn-secondary text-xs flex items-center gap-1 py-1 px-2.5 shadow-sm"
          >
            <Plus size={13} /> Add Line
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="table w-full text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-2 text-center w-10">#</th>
                <th className="py-2.5 px-2 text-left min-w-[140px]">I/O (Job No) *</th>
                <th className="py-2.5 px-2 text-left min-w-[130px]">Style No *</th>
                <th className="py-2.5 px-3 text-left min-w-[150px]">Trim Item *</th>
                <th className="py-2.5 px-2 text-left w-28">Specification</th>
                <th className="py-2.5 px-2 text-left w-20">Color</th>
                <th className="py-2.5 px-2 text-left w-16">Size</th>
                <th className="py-2.5 px-2 text-right w-20">Order Qty *</th>
                <th className="py-2.5 px-2 text-left w-16">UOM</th>
                <th className="py-2.5 px-2 text-right w-20">Rate ({currSymbol})</th>
                <th className="py-2.5 px-2 text-right w-24">Taxable ({currSymbol})</th>
                <th className="py-2.5 px-2 text-center w-16">{head.is_interstate ? 'IGST %' : 'GST %'}</th>
                <th className="py-2.5 px-2 text-right w-20">Tax ({currSymbol})</th>
                <th className="py-2.5 px-2 text-right w-24">Net ({currSymbol})</th>
                <th className="py-2.5 px-2 text-center w-10">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((line, idx) => {
                const availableTrims = (filterBomOnly && bomTrims.length > 0)
                  ? trims.filter((t: any) => bomTrims.some((bt: any) => Number(bt.trim_id) === Number(t.id)))
                  : trims;

                return (
                  <tr key={line._key} className="hover:bg-slate-50/50">
                    {/* 1. S.No */}
                    <td className="py-2 px-2 text-center font-mono font-medium text-slate-400">
                      {idx + 1}
                    </td>

                    {/* 2. I/O (Job No) */}
                    <td className="py-2 px-2">
                      <select
                        value={line.so_id || ''}
                        onChange={(e) => updateLine(idx, { so_id: e.target.value })}
                        className="input text-xs py-1 bg-white"
                      >
                        <option value="">{head.io_no ? `${head.io_no} (Default)` : 'Stock / General'}</option>
                        {salesOrders.map((so: any) => (
                          <option key={so.id} value={so.id}>
                            {so.so_no} {so.style_name ? `(${so.style_name})` : ''}
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* 3. Style No */}
                    <td className="py-2 px-2">
                      <select
                        value={line.style_id || head.style_id || ''}
                        onChange={(e) => updateLine(idx, { style_id: e.target.value })}
                        className="input text-xs py-1"
                      >
                        <option value="">-- Style --</option>
                        {styles.map((s: any) => (
                          <option key={s.id} value={s.id}>
                            {s.style_code}
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* 4. Trim Item */}
                    <td className="py-2 px-3">
                      <select
                        value={line.trim_id}
                        onChange={(e) => {
                          const sel = trims.find((t: any) => String(t.id) === e.target.value);
                          updateLine(idx, {
                            trim_id: e.target.value,
                            specification: sel?.specification || line.specification,
                          });
                        }}
                        className="input text-xs py-1"
                      >
                        <option value="">-- Select Trim --</option>
                        {availableTrims.map((t: any) => (
                          <option key={t.id} value={t.id}>
                            {t.trim_name} ({t.trim_type || t.trim_code})
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* 5. Specification */}
                    <td className="py-2 px-2">
                      <input
                        type="text"
                        value={line.specification}
                        onChange={(e) => updateLine(idx, { specification: e.target.value })}
                        placeholder="e.g. 4 Hole, 15L"
                        className="input text-xs py-1"
                      />
                    </td>

                    {/* 6. Color */}
                    <td className="py-2 px-2">
                      <input
                        type="text"
                        value={line.color_name}
                        onChange={(e) => updateLine(idx, { color_name: e.target.value })}
                        placeholder="Color"
                        className="input text-xs py-1"
                      />
                    </td>

                    {/* 7. Size */}
                    <td className="py-2 px-2">
                      <input
                        type="text"
                        value={line.trim_size}
                        onChange={(e) => updateLine(idx, { trim_size: e.target.value })}
                        placeholder="Size"
                        className="input text-xs py-1"
                      />
                    </td>

                    {/* 8. Order Qty */}
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        step="1"
                        value={line.order_qty}
                        onChange={(e) => updateLine(idx, { order_qty: Number(e.target.value) })}
                        className="input text-xs py-1 text-right font-semibold text-slate-900"
                      />
                    </td>

                    {/* 9. UOM */}
                    <td className="py-2 px-2">
                      <select
                        value={line.uom_id}
                        onChange={(e) => updateLine(idx, { uom_id: Number(e.target.value) })}
                        className="input text-xs py-1"
                      >
                        <option value={1}>PCS</option>
                        <option value={9}>MTR</option>
                        <option value={10}>KG</option>
                        <option value={11}>BOX</option>
                        <option value={12}>ROLL</option>
                      </select>
                    </td>

                    {/* 10. Rate */}
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        step="0.01"
                        value={line.rate}
                        onChange={(e) => updateLine(idx, { rate: Number(e.target.value) })}
                        className="input text-xs py-1 text-right font-mono"
                      />
                    </td>

                    {/* 11. Taxable */}
                    <td className="py-2 px-2 text-right font-mono font-medium text-slate-800">
                      {currSymbol}{fmtDecimal(line.amount, 2)}
                    </td>

                    {/* 12. GST / IGST % */}
                    <td className="py-2 px-2">
                      <select
                        value={line.gst_rate}
                        onChange={(e) => updateLine(idx, { gst_rate: Number(e.target.value) })}
                        className="input text-xs py-1 text-center"
                      >
                        <option value={0}>0%</option>
                        <option value={5}>5%</option>
                        <option value={12}>12%</option>
                        <option value={18}>18%</option>
                        <option value={28}>28%</option>
                      </select>
                    </td>

                    {/* 13. Tax Amount */}
                    <td className="py-2 px-2 text-right font-mono text-slate-600">
                      {currSymbol}{fmtDecimal(line.tax_amount, 2)}
                    </td>

                    {/* 14. Net Amount */}
                    <td className="py-2 px-2 text-right font-mono font-bold text-slate-950">
                      {currSymbol}{fmtDecimal(line.net_amount, 2)}
                    </td>

                    {/* 15. Action */}
                    <td className="py-2 px-2 text-center">
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        disabled={lines.length === 1}
                        className="text-slate-400 hover:text-rose-600 transition disabled:opacity-30"
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50/80 border-t border-slate-200 font-bold text-slate-800">
              <tr>
                <td colSpan={7} className="py-3 px-3 text-right text-slate-600">Total Items:</td>
                <td className="py-3 px-2 text-right font-mono text-emerald-800">{fmtDecimal(totals.totalQty)}</td>
                <td colSpan={2} className="py-3 px-2 text-right text-slate-500 text-xs">Taxable Total:</td>
                <td className="py-3 px-2 text-right font-mono">{currSymbol}{fmtDecimal(totals.totalAmount, 2)}</td>
                <td className="py-3 px-2 text-center text-xs text-slate-500">
                  {head.is_interstate ? 'IGST:' : 'CGST+SGST:'}
                </td>
                <td className="py-3 px-2 text-right font-mono text-purple-700">{currSymbol}{fmtDecimal(totals.taxAmount, 2)}</td>
                <td className="py-3 px-2 text-right font-mono text-sm font-black text-slate-900">
                  {currSymbol}{fmtDecimal(totals.grandTotal, 2)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Footer Tax Breakdown */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row justify-end items-end gap-6 text-xs">
          <div className="space-y-1 text-right font-mono">
            <div className="text-slate-600">
              Taxable Amount: <span className="font-semibold text-slate-900">{currSymbol}{fmtDecimal(totals.totalAmount, 2)}</span>
            </div>
            {head.is_interstate ? (
              <div className="text-purple-700">
                Integrated GST (IGST): <span className="font-bold">{currSymbol}{fmtDecimal(totals.igstAmount, 2)}</span>
              </div>
            ) : (
              <>
                <div className="text-slate-600">
                  Central GST (CGST): <span className="font-semibold">{currSymbol}{fmtDecimal(totals.cgstAmount, 2)}</span>
                </div>
                <div className="text-slate-600">
                  State GST (SGST): <span className="font-semibold">{currSymbol}{fmtDecimal(totals.sgstAmount, 2)}</span>
                </div>
              </>
            )}
            <div className="text-sm font-black text-emerald-800 border-t border-slate-200 pt-1">
              Net Grand Total ({currCode}): <span>{currSymbol}{fmtDecimal(totals.grandTotal, 2)}</span>
            </div>
            {isForeignCurrency && (
              <div className="text-xs font-bold text-amber-900 pt-0.5">
                INR Converted: <span>₹{fmtDecimal(totals.grandTotal * (Number(head.exchange_rate) || 1.0), 2)}</span>
                <span className="text-[10px] font-normal text-slate-500 ml-1">(@ ₹{head.exchange_rate}/{currCode})</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* PRINTABLE PURCHASE ORDER VOUCHER MODAL */}
      {showPrintPO && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden border border-slate-200 my-auto flex flex-col max-h-[96vh]">
            <div className="px-6 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50 no-print">
              <span className="font-bold text-sm text-slate-800 flex items-center gap-2">
                <Printer size={16} className="text-emerald-600" /> Print Trim Purchase Order
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="btn-primary text-xs py-1.5 px-4 flex items-center gap-1.5"
                >
                  <Printer size={14} /> Print Now
                </button>
                <button
                  type="button"
                  onClick={() => setShowPrintPO(false)}
                  className="btn-secondary text-xs py-1.5 px-3"
                >
                  Close
                </button>
              </div>
            </div>

            {/* Printable Document Sheet */}
            <div className="p-8 overflow-y-auto print-container text-slate-900 bg-white font-sans text-xs">
              <div className="border-b-2 border-slate-800 pb-4 mb-4 text-center">
                <h1 className="text-xl font-black uppercase tracking-wider text-slate-900">GARMENT MANUFACTURING ERP</h1>
                <p className="text-xs text-slate-500 font-medium">Trims & Accessories Procurement Division</p>
                <div className="inline-block mt-2 px-4 py-1 rounded bg-emerald-100 text-emerald-900 font-bold text-sm tracking-wide">
                  PURCHASE ORDER VOUCHER ({head.is_interstate ? 'INTER-STATE / IGST' : 'INTRA-STATE / GST'})
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border border-slate-300 rounded-lg p-3.5 mb-4 bg-slate-50/50">
                <div className="space-y-1.5">
                  <div><span className="text-slate-500 font-medium">PO Number:</span> <span className="font-bold text-slate-900 font-mono text-sm">{head.po_no || id}</span></div>
                  <div><span className="text-slate-500 font-medium">PO Date:</span> <span className="font-semibold text-slate-800">{head.po_date}</span></div>
                  <div><span className="text-slate-500 font-medium">Expected Delivery:</span> <span className="font-semibold text-slate-800">{head.delivery_date || '-'}</span></div>
                  <div><span className="text-slate-500 font-medium">Payment Terms:</span> <span className="font-semibold text-slate-800">{head.payment_terms || '-'}</span></div>
                </div>
                <div className="space-y-1.5 border-l border-slate-200 pl-4">
                  <div><span className="text-slate-500 font-medium">Supplier / Vendor:</span> <span className="font-bold text-slate-900">{suppliers.find((s: any) => String(s.id) === String(head.supplier_id))?.party_name || '-'}</span></div>
                  <div><span className="text-slate-500 font-medium">Internal Order (I/O No):</span> <span className="font-bold text-sky-800 font-mono">{head.io_no}</span></div>
                  <div><span className="text-slate-500 font-medium">Style:</span> <span className="font-semibold text-slate-800">{styles.find((s: any) => String(s.id) === String(head.style_id))?.style_code || '-'}</span></div>
                  <div><span className="text-slate-500 font-medium">Taxation:</span> <span className="font-bold text-emerald-700">{head.is_interstate ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}</span></div>
                </div>
              </div>

              {/* Items Table */}
              <div className="mb-6">
                <table className="w-full border-collapse border border-slate-300 text-[11px]">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700">
                      <th className="border border-slate-300 py-1.5 px-2 text-left">#</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-left">Trim Item</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-left">I/O (Internal Order) / Job</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-left">Specification</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-center">Color / Size</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Order Qty</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Rate (₹)</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">{head.is_interstate ? 'IGST (%)' : 'GST (%)'}</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Total (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l: any, idx: number) => {
                      const trimObj = trims.find((t: any) => String(t.id) === String(l.trim_id));
                      const soObj = salesOrders.find((so: any) => String(so.id) === String(l.so_id));
                      return (
                        <tr key={l._key || idx}>
                          <td className="border border-slate-300 py-1 px-2 text-center text-slate-500">{idx + 1}</td>
                          <td className="border border-slate-300 py-1 px-2 font-semibold text-slate-900">{trimObj?.trim_name || l.trim_name || 'Trim'}</td>
                          <td className="border border-slate-300 py-1 px-2 text-slate-600">{soObj?.so_no || 'General'}</td>
                          <td className="border border-slate-300 py-1 px-2 text-slate-600">{l.specification || '-'}</td>
                          <td className="border border-slate-300 py-1 px-2 text-center">{l.color_name || '-'} / {l.trim_size || '-'}</td>
                          <td className="border border-slate-300 py-1 px-2 text-right font-bold">{fmtDecimal(l.order_qty)}</td>
                          <td className="border border-slate-300 py-1 px-2 text-right">₹{fmtDecimal(l.rate)}</td>
                          <td className="border border-slate-300 py-1 px-2 text-right">{l.gst_rate}%</td>
                          <td className="border border-slate-300 py-1 px-2 text-right font-bold">₹{fmtDecimal(l.net_amount)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50">
                      <td colSpan={8} className="border border-slate-300 py-1 px-2 text-right font-semibold text-slate-600">Taxable Subtotal:</td>
                      <td className="border border-slate-300 py-1 px-2 text-right font-bold">₹{fmtDecimal(totals.totalAmount)}</td>
                    </tr>
                    {head.is_interstate ? (
                      <tr className="bg-slate-50">
                        <td colSpan={8} className="border border-slate-300 py-1 px-2 text-right font-semibold text-purple-700">Total IGST:</td>
                        <td className="border border-slate-300 py-1 px-2 text-right font-bold text-purple-800">₹{fmtDecimal(totals.igstAmount)}</td>
                      </tr>
                    ) : (
                      <>
                        <tr className="bg-slate-50">
                          <td colSpan={8} className="border border-slate-300 py-1 px-2 text-right font-semibold text-slate-600">CGST Amount:</td>
                          <td className="border border-slate-300 py-1 px-2 text-right font-bold">₹{fmtDecimal(totals.cgstAmount)}</td>
                        </tr>
                        <tr className="bg-slate-50">
                          <td colSpan={8} className="border border-slate-300 py-1 px-2 text-right font-semibold text-slate-600">SGST Amount:</td>
                          <td className="border border-slate-300 py-1 px-2 text-right font-bold">₹{fmtDecimal(totals.sgstAmount)}</td>
                        </tr>
                      </>
                    )}
                    <tr className="bg-slate-100 font-bold">
                      <td colSpan={8} className="border border-slate-300 py-1.5 px-2 text-right text-slate-900">Grand Total:</td>
                      <td className="border border-slate-300 py-1.5 px-2 text-right font-black text-emerald-800 text-sm">₹{fmtDecimal(totals.grandTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Signatures */}
              <div className="grid grid-cols-4 gap-4 pt-8 mt-6 border-t border-slate-300 text-center text-[10px]">
                <div>
                  <div className="border-b border-slate-400 h-8 mb-1"></div>
                  <span className="font-semibold text-slate-700">Prepared By</span>
                </div>
                <div>
                  <div className="border-b border-slate-400 h-8 mb-1"></div>
                  <span className="font-semibold text-slate-700">Merchandiser</span>
                </div>
                <div>
                  <div className="border-b border-slate-400 h-8 mb-1"></div>
                  <span className="font-semibold text-slate-700">Accounts Manager</span>
                </div>
                <div>
                  <div className="border-b border-slate-400 h-8 mb-1"></div>
                  <span className="font-semibold text-slate-700">Authorized Signatory</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
