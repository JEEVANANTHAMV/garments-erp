import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Plus, Trash2, Scissors, Printer
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Badge } from '../../components/ui';

interface TrimLine {
  id?: number;
  _key: string;
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
  tax_amount: number;
  net_amount: number;
}

let tseq = 0;
const emptyTrimLine = (): TrimLine => ({
  _key: `tl_${++tseq}`,
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
  const isNew = id === 'new';
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

  // Header state
  const [head, setHead] = useState({
    id: isNew ? undefined : Number(id),
    po_no: '',
    io_no: 'IO-2026-001',
    po_date: today(),
    supplier_id: '',
    style_id: '',
    delivery_date: '',
    payment_terms: '30 Days Net',
    status: 'APPROVED',
    remarks: '',
  });

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
        delivery_date: existingPo.delivery_date?.split('T')[0] || '',
        payment_terms: existingPo.payment_terms || '30 Days Net',
        status: existingPo.status || 'APPROVED',
        remarks: existingPo.remarks || '',
      });

      if (existingPo.lines?.length) {
        setLines(
          existingPo.lines.map((l: any) => ({
            _key: `tl_${++tseq}`,
            id: l.id,
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
            tax_amount: Number(l.tax_amount),
            net_amount: Number(l.net_amount),
          }))
        );
      }
    }
  }, [existingPo]);

  // Update line calculations
  const updateLine = (idx: number, patch: Partial<TrimLine>) => {
    setLines((prev) => {
      const copy = [...prev];
      const cur = { ...copy[idx], ...patch };

      const qty = Number(cur.order_qty) || 0;
      const rate = Number(cur.rate) || 0;
      const gst = Number(cur.gst_rate) || 0;

      const amt = qty * rate;
      const tax = (amt * gst) / 100;
      const net = amt + tax;

      cur.amount = amt;
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
    const taxAmount = lines.reduce((s, l) => s + (l.tax_amount || 0), 0);
    const grandTotal = totalAmount + taxAmount;
    return { totalAmount, taxAmount, grandTotal };
  }, [lines]);

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
        total_amount: totals.totalAmount,
        tax_amount: totals.taxAmount,
        grand_total: totals.grandTotal,
        lines: lines.map((l) => ({
          id: l.id,
          trim_id: Number(l.trim_id),
          specification: l.specification,
          color_name: l.color_name,
          trim_size: l.trim_size,
          order_qty: Number(l.order_qty),
          uom_id: Number(l.uom_id || 1),
          rate: Number(l.rate),
          amount: Number(l.amount),
          gst_rate: Number(l.gst_rate),
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
            </div>
            <p className="text-xs text-slate-500">
              Procurement order for trims, buttons, zippers, thread, labels & accessories
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

      {/* Header Form */}
      <div className="card p-5 space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 border-b border-slate-100 pb-2">
          Order Information & Linkage
        </h3>

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
            <label className="label">Style Reference</label>
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

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
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

      {/* Lines Table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50/70 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Trim Order Lines</h3>
            <p className="text-[11px] text-slate-500">Specify items, specifications, size, color, quantity and unit rate</p>
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
                <th className="py-2.5 px-3 text-left w-48">Trim Item *</th>
                <th className="py-2.5 px-3 text-left w-36">Specification</th>
                <th className="py-2.5 px-3 text-left w-24">Color</th>
                <th className="py-2.5 px-3 text-left w-20">Size</th>
                <th className="py-2.5 px-3 text-right w-24">Order Qty *</th>
                <th className="py-2.5 px-3 text-left w-20">UOM</th>
                <th className="py-2.5 px-3 text-right w-24">Rate (₹)</th>
                <th className="py-2.5 px-3 text-right w-20">GST %</th>
                <th className="py-2.5 px-3 text-right w-28">Net Amount</th>
                <th className="py-2.5 px-3 text-center w-12">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((line, idx) => (
                <tr key={line._key} className="hover:bg-slate-50/50">
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
                      {trims.map((t: any) => (
                        <option key={t.id} value={t.id}>
                          {t.trim_name} ({t.trim_type || t.trim_code})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      value={line.specification}
                      onChange={(e) => updateLine(idx, { specification: e.target.value })}
                      placeholder="e.g. 4 Hole, 15L"
                      className="input text-xs py-1"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      value={line.color_name}
                      onChange={(e) => updateLine(idx, { color_name: e.target.value })}
                      placeholder="Color"
                      className="input text-xs py-1"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      value={line.trim_size}
                      onChange={(e) => updateLine(idx, { trim_size: e.target.value })}
                      placeholder="Size"
                      className="input text-xs py-1"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      step="1"
                      value={line.order_qty}
                      onChange={(e) => updateLine(idx, { order_qty: Number(e.target.value) })}
                      className="input text-xs py-1 text-right font-semibold text-slate-900"
                    />
                  </td>
                  <td className="py-2 px-3">
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
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      step="0.01"
                      value={line.rate}
                      onChange={(e) => updateLine(idx, { rate: Number(e.target.value) })}
                      className="input text-xs py-1 text-right"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      step="0.5"
                      value={line.gst_rate}
                      onChange={(e) => updateLine(idx, { gst_rate: Number(e.target.value) })}
                      className="input text-xs py-1 text-right"
                    />
                  </td>
                  <td className="py-2 px-3 text-right font-bold text-slate-900">
                    ₹{fmtDecimal(line.net_amount)}
                  </td>
                  <td className="py-2 px-3 text-center">
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      disabled={lines.length === 1}
                      className="text-slate-400 hover:text-red-600 disabled:opacity-30 p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer Totals */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row justify-end items-end gap-3 text-xs">
          <div className="space-y-1 text-right">
            <div className="text-slate-500">
              Taxable Amount: <span className="font-semibold text-slate-800">₹{fmtDecimal(totals.totalAmount)}</span>
            </div>
            <div className="text-slate-500">
              GST Tax Amount: <span className="font-semibold text-slate-800">₹{fmtDecimal(totals.taxAmount)}</span>
            </div>
            <div className="text-sm font-bold text-slate-900 border-t border-slate-200 pt-1">
              Grand Total: <span className="text-emerald-700">₹{fmtDecimal(totals.grandTotal)}</span>
            </div>
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
                  PURCHASE ORDER VOUCHER
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
                  <div><span className="text-slate-500 font-medium">Status:</span> <span className="font-bold text-emerald-700">{head.status}</span></div>
                </div>
              </div>

              {/* Items Table */}
              <div className="mb-6">
                <table className="w-full border-collapse border border-slate-300 text-[11px]">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700">
                      <th className="border border-slate-300 py-1.5 px-2 text-left">#</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-left">Trim Item</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-left">Specification</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-center">Color / Size</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Order Qty</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Rate (₹)</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Tax (%)</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Total (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l: any, idx: number) => {
                      const trimObj = trims.find((t: any) => String(t.id) === String(l.trim_id));
                      return (
                        <tr key={l._key || idx}>
                          <td className="border border-slate-300 py-1 px-2 text-center text-slate-500">{idx + 1}</td>
                          <td className="border border-slate-300 py-1 px-2 font-semibold text-slate-900">{trimObj?.trim_name || l.trim_name || 'Trim'}</td>
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
                      <td colSpan={7} className="border border-slate-300 py-1 px-2 text-right font-semibold text-slate-600">Taxable Subtotal:</td>
                      <td className="border border-slate-300 py-1 px-2 text-right font-bold">₹{fmtDecimal(totals.totalAmount)}</td>
                    </tr>
                    <tr className="bg-slate-50">
                      <td colSpan={7} className="border border-slate-300 py-1 px-2 text-right font-semibold text-slate-600">Total Tax:</td>
                      <td className="border border-slate-300 py-1 px-2 text-right font-bold">₹{fmtDecimal(totals.taxAmount)}</td>
                    </tr>
                    <tr className="bg-slate-100 font-bold">
                      <td colSpan={7} className="border border-slate-300 py-1.5 px-2 text-right text-slate-900">Grand Total:</td>
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
