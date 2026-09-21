import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Plus, Trash2, PackageCheck, Layers, Disc, Globe
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Badge } from '../../components/ui';

interface GrnLine {
  _key: string;
  id?: number;
  po_id?: number;
  po_no?: string;
  po_line_id?: number;
  so_id?: string | number;
  style_id?: string | number;
  trim_id: string | number;
  trim_name?: string;
  specification: string;
  color_name: string;
  trim_size: string;
  uom_id: number;
  po_qty: number;
  received_qty: number;
  accepted_qty: number;
  rejected_qty: number;
  hold_qty: number;
  rate: number;
  taxable_amount: number;
  gst_rate: number;
  tax_amount: number;
  total_amount: number;
  supplier_lot_no: string;
  internal_lot_no: string;
  bin_location: string;
  qc_status: 'ACCEPTED' | 'PARTIAL' | 'REJECTED' | 'HOLD';
  rejection_reason: string;
}

let glseq = 0;
const emptyGrnLine = (): GrnLine => ({
  _key: `tgl_${++glseq}`,
  so_id: '',
  style_id: '',
  trim_id: '',
  specification: '4 Hole, 15L',
  color_name: 'Navy',
  trim_size: '15L',
  uom_id: 1,
  po_qty: 5000,
  received_qty: 5000,
  accepted_qty: 4950,
  rejected_qty: 50,
  hold_qty: 0,
  rate: 0.85,
  taxable_amount: 4207.5,
  gst_rate: 18,
  tax_amount: 757.35,
  total_amount: 4964.85,
  supplier_lot_no: 'SLOT-001',
  internal_lot_no: `TLOT-${Date.now().toString().slice(-6)}`,
  bin_location: 'BIN-T01',
  qc_status: 'ACCEPTED',
  rejection_reason: '50 pcs cracked / defective finish',
});

export default function TrimGRNDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new' || !id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const [saving, setSaving] = useState(false);

  // Lookups
  const { data: suppliers = [] } = useQuery({
    queryKey: ['lookups', 'suppliers'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/suppliers')).data || [],
  });

  const { data: styles = [] } = useQuery({
    queryKey: ['lookups', 'styles'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/styles')).data || [],
  });

  const { data: warehouses = [] } = useQuery({
    queryKey: ['lookups', 'warehouses'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/warehouses')).data || [],
  });

  const { data: trims = [] } = useQuery({
    queryKey: ['lookups', 'trims'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/trims')).data || [],
  });

  const { data: salesOrders = [] } = useQuery({
    queryKey: ['lookups', 'sales-orders'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/sales-orders')).data || [],
  });

  const { data: gateInwards = [] } = useQuery({
    queryKey: ['lookups', 'gate-inwards'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/gate-inwards')).data || [],
  });

  const { data: currencies = [] } = useQuery({
    queryKey: ['lookups', 'currencies'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/currencies')).data || [],
  });

  // Available POs
  const { data: availablePos = [] } = useQuery({
    queryKey: ['trim-pos'],
    queryFn: async () => (await http.get<{ data: any[] }>('/trim-pos')).data || [],
    enabled: isNew,
  });

  // Header State
  const [head, setHead] = useState({
    id: isNew ? undefined : Number(id),
    grn_no: '',
    grn_date: today(),
    po_id: '',
    gate_inward_id: '',
    io_no: 'IO-2026-001',
    style_id: '',
    supplier_id: '',
    warehouse_id: '1',
    currency_id: '1',
    exchange_rate: 1.0,
    supplier_inv_no: 'INV-2026-889',
    supplier_dc_no: 'DC-4421',
    vehicle_no: 'TN-39-AB-1234',
    is_interstate: false,
    status: 'POSTED',
    remarks: '',
  });

  const [selectedPoIds, setSelectedPoIds] = useState<string[]>([]);
  const [lines, setLines] = useState<GrnLine[]>([emptyGrnLine()]);

  // Selected Currency Info
  const selectedCurrency = (currencies as any[]).find((c: any) => String(c.id) === String(head.currency_id));
  const currSymbol = selectedCurrency?.symbol || '₹';
  const currCode = selectedCurrency?.code || 'INR';
  const isForeignCurrency = currCode !== 'INR' && Number(head.exchange_rate) > 0 && Number(head.exchange_rate) !== 1.0;

  // Load existing GRN
  const { data: existingGrn } = useQuery({
    queryKey: ['trim-grn', id],
    queryFn: async () => {
      if (isNew) return null;
      return (await http.get<{ data: any }>(`/trim-grns/${id}`)).data;
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (existingGrn) {
      setHead({
        id: existingGrn.id,
        grn_no: existingGrn.grn_no,
        grn_date: existingGrn.grn_date?.split('T')[0] || today(),
        po_id: String(existingGrn.po_id || ''),
        gate_inward_id: String(existingGrn.gate_inward_id || ''),
        io_no: existingGrn.io_no,
        style_id: String(existingGrn.style_id || ''),
        supplier_id: String(existingGrn.supplier_id || ''),
        warehouse_id: String(existingGrn.warehouse_id || '1'),
        currency_id: String(existingGrn.currency_id || '1'),
        exchange_rate: Number(existingGrn.exchange_rate || 1.0),
        supplier_inv_no: existingGrn.supplier_inv_no || '',
        supplier_dc_no: existingGrn.supplier_dc_no || '',
        vehicle_no: existingGrn.vehicle_no || '',
        is_interstate: Boolean(existingGrn.is_interstate),
        status: existingGrn.status || 'POSTED',
        remarks: existingGrn.remarks || '',
      });

      let pids: string[] = [];
      if (Array.isArray(existingGrn.po_ids)) {
        pids = existingGrn.po_ids.map(String).filter(Boolean);
      } else if (typeof existingGrn.po_ids === 'string') {
        try {
          const parsed = JSON.parse(existingGrn.po_ids);
          if (Array.isArray(parsed)) pids = parsed.map(String).filter(Boolean);
        } catch {}
      }
      if (!pids.length && existingGrn.po_id) {
        pids = [String(existingGrn.po_id)];
      }
      setSelectedPoIds(pids);

      if (existingGrn.lines?.length) {
        setLines(
          existingGrn.lines.map((l: any) => {
            const acc = Number(l.accepted_qty);
            const rate = Number(l.rate || 0.85);
            const gstRate = Number(l.gst_rate !== undefined ? l.gst_rate : 18);
            const taxable = Number(l.taxable_amount !== undefined ? l.taxable_amount : Math.round(acc * rate * 100) / 100);
            const taxAmt = Number(l.tax_amount !== undefined ? l.tax_amount : Math.round(((taxable * gstRate) / 100) * 100) / 100);
            const totalAmt = Number(l.total_amount !== undefined ? l.total_amount : (taxable + taxAmt));

            return {
              _key: `tgl_${++glseq}`,
              id: l.id,
              po_id: l.po_id ? Number(l.po_id) : (existingGrn.po_id ? Number(existingGrn.po_id) : undefined),
              po_no: l.po_no || undefined,
              po_line_id: l.po_line_id,
              so_id: l.so_id ? String(l.so_id) : '',
              style_id: l.style_id ? String(l.style_id) : '',
              trim_id: l.trim_id,
              trim_name: l.trim_name,
              specification: l.specification || '',
              color_name: l.color_name || '',
              trim_size: l.trim_size || '',
              uom_id: l.uom_id,
              po_qty: Number(l.po_qty),
              received_qty: Number(l.received_qty),
              accepted_qty: acc,
              rejected_qty: Number(l.rejected_qty),
              hold_qty: Number(l.hold_qty),
              rate,
              taxable_amount: taxable,
              gst_rate: gstRate,
              tax_amount: taxAmt,
              total_amount: totalAmt,
              supplier_lot_no: l.supplier_lot_no || '',
              internal_lot_no: l.internal_lot_no,
              bin_location: l.bin_location || '',
              qc_status: l.qc_status || 'ACCEPTED',
              rejection_reason: l.rejection_reason || '',
            };
          })
        );
      }
    }
  }, [existingGrn]);

  // Handle Gate Entry selection: auto-fill supplier, DC, invoice, vehicle, warehouse
  const handleGateInwardSelect = (ginId: string) => {
    setHead((prev) => {
      const next = { ...prev, gate_inward_id: ginId };
      if (!ginId) return next;
      const found = gateInwards.find((g: any) => String(g.id) === ginId);
      if (found) {
        if (found.party_id) next.supplier_id = String(found.party_id);
        if (found.supplier_dc_no) next.supplier_dc_no = found.supplier_dc_no;
        if (found.supplier_inv_no) next.supplier_inv_no = found.supplier_inv_no;
        if (found.vehicle_no) next.vehicle_no = found.vehicle_no;
        if (found.warehouse_id) next.warehouse_id = String(found.warehouse_id);
      }
      return next;
    });
  };

  // Handle PO selection: auto-fetch and merge lines
  const handleAddPo = async (poId: string) => {
    if (!poId) return;
    if (selectedPoIds.includes(poId)) {
      toast('This PO is already linked', 'info');
      return;
    }

    try {
      const res = await http.get<{ data: any }>(`/trim-pos/${poId}`);
      const po = res.data;
      if (po) {
        const nextPoIds = [...selectedPoIds, poId];
        setSelectedPoIds(nextPoIds);

        setHead((prev) => ({
          ...prev,
          po_id: nextPoIds[0],
          io_no: po.io_no || prev.io_no,
          style_id: String(po.style_id || prev.style_id),
          supplier_id: String(po.supplier_id || prev.supplier_id),
          currency_id: po.currency_id ? String(po.currency_id) : prev.currency_id,
          exchange_rate: po.exchange_rate ? Number(po.exchange_rate) : prev.exchange_rate,
          is_interstate: prev.is_interstate || Boolean(po.is_interstate),
        }));

        if (po.lines?.length) {
          const mappedLines: GrnLine[] = po.lines.map((l: any, i: number) => {
            const pending = Math.max(0, Number(l.order_qty) - Number(l.received_qty || 0));
            const rate = Number(l.rate || 0.85);
            const gstRate = Number(l.gst_rate !== undefined ? l.gst_rate : 18);
            const taxable = Math.round(pending * rate * 100) / 100;
            const tax = Math.round(((taxable * gstRate) / 100) * 100) / 100;
            const total = taxable + tax;

            return {
              _key: `tgl_${++glseq}`,
              po_id: Number(poId),
              po_no: po.po_no,
              po_line_id: l.id,
              so_id: l.so_id ? String(l.so_id) : (po.so_id ? String(po.so_id) : ''),
              style_id: l.style_id ? String(l.style_id) : (po.style_id ? String(po.style_id) : ''),
              trim_id: l.trim_id,
              trim_name: l.trim_name,
              specification: l.specification || '',
              color_name: l.color_name || '',
              trim_size: l.trim_size || '',
              uom_id: l.uom_id,
              po_qty: Number(l.order_qty),
              received_qty: pending,
              accepted_qty: pending,
              rejected_qty: 0,
              hold_qty: 0,
              rate,
              taxable_amount: taxable,
              gst_rate: gstRate,
              tax_amount: tax,
              total_amount: total,
              supplier_lot_no: '',
              internal_lot_no: `TLOT-${Date.now().toString().slice(-5)}${i + 1}`,
              bin_location: 'BIN-T01',
              qc_status: 'ACCEPTED',
              rejection_reason: '',
            };
          });

          setLines((prev) => {
            const isPlaceholder = prev.length === 1 && !prev[0].id && !prev[0].po_line_id;
            return isPlaceholder ? mappedLines : [...prev, ...mappedLines];
          });
          toast(`Loaded ${mappedLines.length} trim lines from ${po.po_no}`, 'info');
        }
      }
    } catch {
      toast('Failed to load PO details', 'error');
    }
  };

  const handleRemovePo = (poId: string) => {
    const updated = selectedPoIds.filter((p) => p !== poId);
    setSelectedPoIds(updated);
    setHead((prev) => ({ ...prev, po_id: updated[0] || '' }));

    setLines((prev) => {
      const remaining = prev.filter((l) => String(l.po_id) !== poId);
      if (!remaining.length) {
        return [emptyGrnLine()];
      }
      return remaining;
    });
    toast(`Removed PO #${poId}`, 'info');
  };

  const updateLine = (idx: number, patch: Partial<GrnLine>) => {
    setLines((prev) => {
      const copy = [...prev];
      const cur = { ...copy[idx], ...patch };

      // Auto-recalculate accepted if received changed
      if ('received_qty' in patch && !('accepted_qty' in patch)) {
        cur.accepted_qty = Math.max(0, Number(cur.received_qty) - (Number(cur.rejected_qty) + Number(cur.hold_qty)));
      }

      const acc = Number(cur.accepted_qty) || 0;
      const rate = Number(cur.rate) || 0;
      const gstRate = Number(cur.gst_rate !== undefined ? cur.gst_rate : 18);
      const taxable = Math.round(acc * rate * 100) / 100;
      const tax = Math.round(((taxable * gstRate) / 100) * 100) / 100;
      cur.taxable_amount = taxable;
      cur.tax_amount = tax;
      cur.total_amount = taxable + tax;

      copy[idx] = cur;
      return copy;
    });
  };

  const addLine = () => setLines((prev) => [...prev, emptyGrnLine()]);
  const removeLine = (idx: number) => {
    if (lines.length === 1) return;
    setLines((prev) => prev.filter((_, i) => i !== idx));
  };

  // Totals
  const totals = useMemo(() => {
    const totalReceived = lines.reduce((s, l) => s + (Number(l.received_qty) || 0), 0);
    const totalAccepted = lines.reduce((s, l) => s + (Number(l.accepted_qty) || 0), 0);
    const totalRejected = lines.reduce((s, l) => s + (Number(l.rejected_qty) || 0), 0);
    const totalHold = lines.reduce((s, l) => s + (Number(l.hold_qty) || 0), 0);
    const taxableAmount = lines.reduce((s, l) => s + (Number(l.taxable_amount) || 0), 0);

    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    lines.forEach((l) => {
      const tax = Number(l.tax_amount) || 0;
      if (head.is_interstate) {
        igstAmount += tax;
      } else {
        cgstAmount += Math.round((tax / 2) * 100) / 100;
        sgstAmount += Math.round((tax / 2) * 100) / 100;
      }
    });

    const taxAmount = cgstAmount + sgstAmount + igstAmount;
    const grandTotal = taxableAmount + taxAmount;
    const inrGrandTotal = grandTotal * (Number(head.exchange_rate) || 1.0);

    return { totalReceived, totalAccepted, totalRejected, totalHold, taxableAmount, cgstAmount, sgstAmount, igstAmount, taxAmount, grandTotal, inrGrandTotal };
  }, [lines, head.is_interstate, head.exchange_rate]);

  const handleSave = async () => {
    if (!head.io_no) {
      toast('Please enter I/O No', 'error');
      return;
    }
    if (!head.supplier_id) {
      toast('Please select a Supplier', 'error');
      return;
    }
    if (!head.warehouse_id) {
      toast('Please select a Receiving Warehouse', 'error');
      return;
    }

    // Validation: accepted + rejected + hold <= received
    for (const l of lines) {
      if (!l.trim_id || l.received_qty <= 0) {
        toast('Each line must have a Trim item and Received Qty > 0', 'error');
        return;
      }
      if (Number(l.accepted_qty) + Number(l.rejected_qty) + Number(l.hold_qty) > Number(l.received_qty) + 0.0001) {
        toast(`Accepted + Rejected + Hold cannot exceed Received qty on line for lot ${l.internal_lot_no}`, 'error');
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        ...head,
        po_id: selectedPoIds.length > 0 ? Number(selectedPoIds[0]) : (head.po_id ? Number(head.po_id) : null),
        po_ids: selectedPoIds.length > 0 ? selectedPoIds.map(Number).filter(Boolean) : (head.po_id ? [Number(head.po_id)] : []),
        gate_inward_id: head.gate_inward_id ? Number(head.gate_inward_id) : null,
        style_id: head.style_id ? Number(head.style_id) : null,
        supplier_id: Number(head.supplier_id),
        warehouse_id: Number(head.warehouse_id),
        currency_id: Number(head.currency_id || 1),
        exchange_rate: Number(head.exchange_rate || 1.0),
        is_interstate: head.is_interstate ? 1 : 0,
        taxable_amount: totals.taxableAmount,
        tax_amount: totals.taxAmount,
        igst_amount: totals.igstAmount,
        net_amount: totals.grandTotal,
        lines: lines.map((l) => ({
          po_id: l.po_id || (selectedPoIds[0] ? Number(selectedPoIds[0]) : undefined),
          po_line_id: l.po_line_id || null,
          so_id: l.so_id ? Number(l.so_id) : undefined,
          style_id: l.style_id ? Number(l.style_id) : undefined,
          trim_id: Number(l.trim_id),
          specification: l.specification,
          color_name: l.color_name,
          trim_size: l.trim_size,
          uom_id: Number(l.uom_id || 1),
          po_qty: Number(l.po_qty || 0),
          received_qty: Number(l.received_qty),
          accepted_qty: Number(l.accepted_qty),
          rejected_qty: Number(l.rejected_qty || 0),
          hold_qty: Number(l.hold_qty || 0),
          rate: Number(l.rate),
          taxable_amount: Number(l.taxable_amount),
          gst_rate: Number(l.gst_rate),
          tax_amount: Number(l.tax_amount),
          total_amount: Number(l.total_amount),
          supplier_lot_no: l.supplier_lot_no,
          internal_lot_no: l.internal_lot_no,
          bin_location: l.bin_location,
          qc_status: l.qc_status,
          rejection_reason: l.rejection_reason,
        })),
      };

      const res = await http.post<{ data: { id: number; grn_no: string } }>('/trim-grns', payload);
      toast(`Trim GRN ${res.data.grn_no} posted! Stock increased by ${totals.totalAccepted} pcs.`);
      qc.invalidateQueries({ queryKey: ['trim-grns'] });
      qc.invalidateQueries({ queryKey: ['trim-stock'] });
      nav('/procurement/trim/grn');
    } catch (err: any) {
      toast(err?.response?.data?.error?.message || 'Failed to post Trim GRN', 'error');
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
            onClick={() => nav('/procurement/trim/grn')}
            className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 transition"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-indigo-100 text-indigo-700">
                <PackageCheck size={18} />
              </span>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                {isNew ? 'New Trim Goods Receipt (GRN)' : `Trim GRN: ${head.grn_no || id}`}
              </h1>
              {!isNew && <Badge variant="success">{head.status}</Badge>}
              {isForeignCurrency && (
                <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                  <Globe size={11} /> IMPORT GRN ({currCode})
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Goods receipt note with QC inspection, amount details, gate inward linkage & inventory posting
            </p>
          </div>
        </div>

        {isNew && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn-primary text-xs flex items-center gap-1.5 shadow-sm"
            >
              <Save size={15} /> {saving ? 'Posting...' : 'Post Trim GRN'}
            </button>
          </div>
        )}
      </div>

      {/* KPI Cards Strip */}
      <div className={`grid grid-cols-2 ${isForeignCurrency ? 'sm:grid-cols-7' : 'sm:grid-cols-6'} gap-3`}>
        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
          <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Total Received</div>
          <div className="text-lg font-bold text-slate-900 mt-0.5 font-mono">{fmtDecimal(totals.totalReceived)}</div>
        </div>
        <div className="p-3 bg-emerald-50/70 rounded-xl border border-emerald-200">
          <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">Accepted Net</div>
          <div className="text-lg font-bold text-emerald-900 mt-0.5 font-mono">{fmtDecimal(totals.totalAccepted)}</div>
        </div>
        <div className="p-3 bg-rose-50/70 rounded-xl border border-rose-200">
          <div className="text-[11px] font-semibold text-rose-700 uppercase tracking-wider">Rejected / Hold</div>
          <div className="text-lg font-bold text-rose-900 mt-0.5 font-mono">{fmtDecimal(totals.totalRejected + totals.totalHold)}</div>
        </div>
        <div className="p-3 bg-sky-50/70 rounded-xl border border-sky-200">
          <div className="text-[11px] font-semibold text-sky-700 uppercase tracking-wider">Taxable Value</div>
          <div className="text-lg font-bold text-sky-900 mt-0.5 font-mono">{currSymbol}{fmtDecimal(totals.taxableAmount, 2)}</div>
        </div>
        <div className="p-3 bg-purple-50/70 rounded-xl border border-purple-200">
          <div className="text-[11px] font-semibold text-purple-700 uppercase tracking-wider">
            {head.is_interstate ? 'IGST Amount' : 'CGST + SGST'}
          </div>
          <div className="text-lg font-bold text-purple-900 mt-0.5 font-mono">{currSymbol}{fmtDecimal(totals.taxAmount, 2)}</div>
        </div>
        <div className="p-3 bg-indigo-50/70 rounded-xl border border-indigo-200">
          <div className="text-[11px] font-semibold text-indigo-700 uppercase tracking-wider">
            Grand Total ({currCode})
          </div>
          <div className="text-lg font-bold text-indigo-950 mt-0.5 font-mono">{currSymbol}{fmtDecimal(totals.grandTotal, 2)}</div>
        </div>
        {isForeignCurrency && (
          <div className="p-3 bg-amber-50/70 rounded-xl border border-amber-200">
            <div className="text-[11px] font-semibold text-amber-800 uppercase tracking-wider">INR Converted</div>
            <div className="text-lg font-bold text-amber-950 mt-0.5 font-mono">₹{fmtDecimal(totals.inrGrandTotal, 2)}</div>
            <div className="text-[10px] text-amber-600 mt-0.5">@ ₹{head.exchange_rate}/{currCode}</div>
          </div>
        )}
      </div>

      {/* Header Form */}
      <div className="card p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-100 pb-2 gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
            <Disc size={14} className="text-indigo-600" />
            <span>Receipt Details, Gate Linkage & Currency</span>
          </h3>

          {/* Inter-State IGST Toggle */}
          <label className="flex items-center gap-2 cursor-pointer bg-slate-50 hover:bg-slate-100 border border-slate-200 px-3 py-1 rounded-lg text-xs transition">
            <input
              type="checkbox"
              checked={head.is_interstate}
              disabled={!isNew}
              onChange={(e) => setHead({ ...head, is_interstate: e.target.checked })}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="font-semibold text-slate-700">Inter-State Supply (IGST Applicable)</span>
            <span className="text-[10px] text-slate-400 font-normal">
              {head.is_interstate ? 'Single IGST rate applied' : 'Split CGST + SGST applied'}
            </span>
          </label>
        </div>

        {/* Row 1: GRN Number, PO Link, Gate Entry, Date */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <label className="label font-bold text-slate-800">GRN No</label>
            <input
              type="text"
              value={isNew ? '(Auto-Generated on Save)' : (head.grn_no || `TGRN-${id}`)}
              disabled
              className="input text-xs font-mono font-bold text-indigo-700 bg-indigo-50/40 border-indigo-200"
            />
          </div>

          <div>
            {isNew ? (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="label">Link Trim POs ({selectedPoIds.length} selected)</label>
                  {selectedPoIds.length > 0 && (
                    <span className="text-[10px] text-indigo-700 font-semibold">Multi-PO active</span>
                  )}
                </div>
                <select
                  value=""
                  onChange={(e) => handleAddPo(e.target.value)}
                  className="input text-xs font-semibold text-indigo-700"
                >
                  <option value="">+ Add Trim PO to this GRN...</option>
                  {availablePos.filter((p: any) => !selectedPoIds.includes(String(p.id))).map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.po_no} ({p.supplier_name}) - {p.io_no}
                    </option>
                  ))}
                </select>

                {selectedPoIds.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {selectedPoIds.map((pId) => {
                      const pObj = availablePos.find((p: any) => String(p.id) === pId);
                      const label = pObj?.po_no || `PO #${pId}`;
                      const lineCnt = lines.filter((l) => String(l.po_id) === pId).length;
                      return (
                        <span key={pId} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold bg-indigo-50 text-indigo-800 border border-indigo-300">
                          <span>📋 {label}</span>
                          {lineCnt > 0 && <span className="text-[10px] bg-indigo-200 text-indigo-900 px-1 rounded font-mono">{lineCnt} items</span>}
                          <button
                            type="button"
                            onClick={() => handleRemovePo(pId)}
                            className="text-indigo-400 hover:text-rose-600 font-bold ml-0.5"
                            title="Remove this PO"
                          >
                            ✕
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label className="label">Linked Trim POs ({selectedPoIds.length || (head.po_id ? 1 : 0)})</label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(selectedPoIds.length > 0 ? selectedPoIds : (head.po_id ? [head.po_id] : [])).map((pId) => (
                    <span key={pId} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-300">
                      📋 PO #{pId}
                    </span>
                  ))}
                  {!selectedPoIds.length && !head.po_id && (
                    <span className="text-xs text-slate-400">Direct Receipt</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Gate Entry Mapping (Clip 2 requirement: GRN MUST have Gate Entry mapping) */}
          <div>
            <label className="label font-semibold text-indigo-900">Map Gate Entry (Auto-fills details)</label>
            {isNew ? (
              <select
                value={head.gate_inward_id}
                onChange={(e) => handleGateInwardSelect(e.target.value)}
                className="input text-xs font-medium border-indigo-300 bg-indigo-50/40"
              >
                <option value="">-- Select Inward Gate Pass --</option>
                {gateInwards.map((g: any) => (
                  <option key={g.id} value={g.id}>
                    {g.code || g.label} {g.vehicle_no ? `(${g.vehicle_no})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={(existingGrn as any)?.gate_entry_no || (head.gate_inward_id ? `GIN #${head.gate_inward_id}` : 'None')}
                disabled
                className="input text-xs"
              />
            )}
          </div>

          <div>
            <label className="label">GRN Date *</label>
            <input
              type="date"
              required
              disabled={!isNew}
              value={head.grn_date}
              onChange={(e) => setHead({ ...head, grn_date: e.target.value })}
              className="input text-xs"
            />
          </div>
        </div>

        {/* Row 2: I/O No, Style Reference, Supplier, Warehouse */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <label className="label">I/O No (Internal Order) *</label>
            <input
              type="text"
              required
              disabled={!isNew}
              value={head.io_no}
              onChange={(e) => setHead({ ...head, io_no: e.target.value })}
              className="input text-xs font-semibold text-slate-900"
            />
          </div>
          <div>
            <label className="label">Style Reference (Default)</label>
            <select
              disabled={!isNew}
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
              disabled={!isNew}
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
            <label className="label">Receiving Warehouse *</label>
            <select
              required
              disabled={!isNew}
              value={head.warehouse_id}
              onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })}
              className="input text-xs"
            >
              {warehouses.length > 0 ? (
                warehouses.map((w: any) => (
                  <option key={w.id} value={w.id}>{w.warehouse_name}</option>
                ))
              ) : (
                <option value="1">Main Trims Store</option>
              )}
            </select>
          </div>
        </div>

        {/* Row 3: Currency, Exchange Rate, Invoice, DC, Vehicle */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4 text-xs">
          <div>
            <label className="label font-semibold text-emerald-800">Currency *</label>
            <select
              disabled={!isNew}
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
              disabled={!isNew || !isForeignCurrency}
              onChange={(e) => setHead({ ...head, exchange_rate: Number(e.target.value) })}
              className={`input text-xs ${isForeignCurrency ? 'font-semibold border-amber-300 bg-amber-50/50' : 'bg-slate-50 text-slate-500'}`}
            />
          </div>

          <div>
            <label className="label">Supplier Inv / Bill No</label>
            <input
              type="text"
              disabled={!isNew}
              value={head.supplier_inv_no}
              onChange={(e) => setHead({ ...head, supplier_inv_no: e.target.value })}
              className="input text-xs"
            />
          </div>

          <div>
            <label className="label">Supplier DC No</label>
            <input
              type="text"
              disabled={!isNew}
              value={head.supplier_dc_no}
              onChange={(e) => setHead({ ...head, supplier_dc_no: e.target.value })}
              className="input text-xs"
            />
          </div>

          <div>
            <label className="label">Vehicle No</label>
            <input
              type="text"
              disabled={!isNew}
              value={head.vehicle_no}
              onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })}
              placeholder="TN-39-AB-1234"
              className="input text-xs"
            />
          </div>
        </div>

        {/* Remarks */}
        <div className="text-xs">
          <label className="label">Remarks</label>
          <input
            type="text"
            disabled={!isNew}
            value={head.remarks}
            onChange={(e) => setHead({ ...head, remarks: e.target.value })}
            placeholder="e.g. Received intact, QC passed"
            className="input text-xs"
          />
        </div>
      </div>

      {/* Lines Table - Order strictly follows Clip 3: 1st: #, 2nd: I/O (Job No), 3rd: Style No, 4th: Trim Item */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50/70 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
              <Layers size={14} className="text-indigo-600" />
              <span>Inspection, Amount Details & Job Allocation ({lines.length})</span>
            </h3>
            <p className="text-[11px] text-slate-500">
              Columns strictly ordered: # → I/O (Job No) → Style No → Trim Item → Specifications & Quantities
            </p>
          </div>
          {isNew && (
            <button
              type="button"
              onClick={addLine}
              className="btn-secondary text-xs flex items-center gap-1 py-1 px-2.5 shadow-sm"
            >
              <Plus size={13} /> Add Line
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="table w-full text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase font-semibold border-b border-slate-200">
              <tr>
                {/* 1st: S.No */}
                <th className="py-2.5 px-2 text-center w-10">#</th>
                {/* PO Ref */}
                <th className="py-2.5 px-2 text-left min-w-[100px]">PO Ref</th>
                {/* 2nd: I/O Job No */}
                <th className="py-2.5 px-2 text-left min-w-[130px]">I/O (Job No)</th>
                {/* 3rd: Style No */}
                <th className="py-2.5 px-2 text-left min-w-[120px]">Style No</th>
                {/* 4th: Trim Item */}
                <th className="py-2.5 px-3 text-left min-w-[150px]">Trim Item *</th>
                {/* Followed by Spec, Color, Size */}
                <th className="py-2.5 px-2 text-left w-24">Spec</th>
                <th className="py-2.5 px-2 text-left w-20">Color</th>
                <th className="py-2.5 px-2 text-left w-16">Size</th>
                <th className="py-2.5 px-2 text-right w-16">PO Qty</th>
                <th className="py-2.5 px-2 text-right w-18">Rec Qty *</th>
                <th className="py-2.5 px-2 text-right w-18">Acc Qty *</th>
                <th className="py-2.5 px-2 text-right w-14">Rej</th>
                <th className="py-2.5 px-2 text-right w-14">Hold</th>
                <th className="py-2.5 px-2 text-right w-18">Rate ({currSymbol})</th>
                <th className="py-2.5 px-2 text-right w-20">Taxable ({currSymbol})</th>
                <th className="py-2.5 px-2 text-center w-14">{head.is_interstate ? 'IGST %' : 'GST %'}</th>
                <th className="py-2.5 px-2 text-right w-18">Tax ({currSymbol})</th>
                <th className="py-2.5 px-2 text-right w-22">Total ({currSymbol})</th>
                <th className="py-2.5 px-2 text-left w-24">Internal Lot</th>
                <th className="py-2.5 px-2 text-center w-20">QC</th>
                {isNew && <th className="py-2.5 px-2 text-center w-8"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((line, idx) => (
                <tr key={line._key} className="hover:bg-slate-50/50">
                  {/* 1. S.No (#) */}
                  <td className="py-2 px-2 text-center font-mono font-medium text-slate-400">
                    {idx + 1}
                  </td>

                  {/* PO Ref */}
                  <td className="py-2 px-2">
                    {line.po_no || line.po_id ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                        {line.po_no || `PO #${line.po_id}`}
                      </span>
                    ) : (
                      <span className="text-slate-400 text-[11px]">—</span>
                    )}
                  </td>

                  {/* 2. I/O (Job No) */}
                  <td className="py-2 px-2">
                    {isNew ? (
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
                    ) : (
                      <span className="font-medium text-slate-700">
                        {line.so_id ? `SO #${line.so_id}` : (head.io_no || 'Stock')}
                      </span>
                    )}
                  </td>

                  {/* 3. Style No */}
                  <td className="py-2 px-2">
                    {isNew ? (
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
                    ) : (
                      <span className="font-mono text-slate-700">
                        {styles.find((s: any) => String(s.id) === String(line.style_id))?.style_code || '-'}
                      </span>
                    )}
                  </td>

                  {/* 4. Trim Item */}
                  <td className="py-2 px-3">
                    {isNew ? (
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
                    ) : (
                      <span className="font-semibold text-slate-900">{line.trim_name || 'Trim Item'}</span>
                    )}
                  </td>

                  {/* Specification */}
                  <td className="py-2 px-2">
                    {isNew ? (
                      <input
                        type="text"
                        value={line.specification}
                        onChange={(e) => updateLine(idx, { specification: e.target.value })}
                        className="input text-xs py-1"
                      />
                    ) : (
                      <span className="text-slate-600">{line.specification}</span>
                    )}
                  </td>

                  {/* Color */}
                  <td className="py-2 px-2">
                    {isNew ? (
                      <input
                        type="text"
                        value={line.color_name}
                        onChange={(e) => updateLine(idx, { color_name: e.target.value })}
                        className="input text-xs py-1"
                      />
                    ) : (
                      <span className="text-slate-600">{line.color_name}</span>
                    )}
                  </td>

                  {/* Size */}
                  <td className="py-2 px-2">
                    {isNew ? (
                      <input
                        type="text"
                        value={line.trim_size}
                        onChange={(e) => updateLine(idx, { trim_size: e.target.value })}
                        className="input text-xs py-1"
                      />
                    ) : (
                      <span className="text-slate-600">{line.trim_size}</span>
                    )}
                  </td>

                  {/* PO Qty */}
                  <td className="py-2 px-2 text-right">
                    <span className="font-mono text-slate-500">{fmtDecimal(line.po_qty)}</span>
                  </td>

                  {/* Received Qty */}
                  <td className="py-2 px-2 text-right">
                    {isNew ? (
                      <input
                        type="number"
                        value={line.received_qty}
                        onChange={(e) => updateLine(idx, { received_qty: Number(e.target.value) })}
                        className="input text-xs py-1 text-right font-mono font-bold text-slate-800"
                      />
                    ) : (
                      <span className="font-mono font-bold">{fmtDecimal(line.received_qty)}</span>
                    )}
                  </td>

                  {/* Accepted Qty */}
                  <td className="py-2 px-2 text-right">
                    {isNew ? (
                      <input
                        type="number"
                        value={line.accepted_qty}
                        onChange={(e) => updateLine(idx, { accepted_qty: Number(e.target.value) })}
                        className="input text-xs py-1 text-right font-mono font-bold text-emerald-700"
                      />
                    ) : (
                      <span className="font-mono text-emerald-700 font-bold">{fmtDecimal(line.accepted_qty)}</span>
                    )}
                  </td>

                  {/* Rejected Qty */}
                  <td className="py-2 px-2 text-right">
                    {isNew ? (
                      <input
                        type="number"
                        value={line.rejected_qty}
                        onChange={(e) => updateLine(idx, { rejected_qty: Number(e.target.value) })}
                        className="input text-xs py-1 text-right font-mono text-rose-600"
                      />
                    ) : (
                      <span className="font-mono text-rose-600">{fmtDecimal(line.rejected_qty)}</span>
                    )}
                  </td>

                  {/* Hold Qty */}
                  <td className="py-2 px-2 text-right">
                    {isNew ? (
                      <input
                        type="number"
                        value={line.hold_qty}
                        onChange={(e) => updateLine(idx, { hold_qty: Number(e.target.value) })}
                        className="input text-xs py-1 text-right font-mono text-amber-600"
                      />
                    ) : (
                      <span className="font-mono text-amber-600">{fmtDecimal(line.hold_qty)}</span>
                    )}
                  </td>

                  {/* Rate */}
                  <td className="py-2 px-2 text-right">
                    {isNew ? (
                      <input
                        type="number"
                        step="0.01"
                        value={line.rate}
                        onChange={(e) => updateLine(idx, { rate: Number(e.target.value) })}
                        className="input text-xs py-1 text-right font-mono"
                      />
                    ) : (
                      <span className="font-mono">{currSymbol}{fmtDecimal(line.rate, 2)}</span>
                    )}
                  </td>

                  {/* Taxable Amount */}
                  <td className="py-2 px-2 text-right font-mono font-medium text-slate-900">
                    {currSymbol}{fmtDecimal(line.taxable_amount, 2)}
                  </td>

                  {/* GST % */}
                  <td className="py-2 px-2">
                    {isNew ? (
                      <select
                        value={line.gst_rate}
                        onChange={(e) => updateLine(idx, { gst_rate: Number(e.target.value) })}
                        className="input text-xs py-1 text-center font-mono"
                      >
                        <option value={0}>0%</option>
                        <option value={5}>5%</option>
                        <option value={12}>12%</option>
                        <option value={18}>18%</option>
                        <option value={28}>28%</option>
                      </select>
                    ) : (
                      <span className="font-mono text-center block">{line.gst_rate}%</span>
                    )}
                  </td>

                  {/* Tax Amount */}
                  <td className="py-2 px-2 text-right font-mono text-purple-700">
                    {currSymbol}{fmtDecimal(line.tax_amount, 2)}
                  </td>

                  {/* Total Amount */}
                  <td className="py-2 px-2 text-right font-mono font-bold text-slate-900">
                    {currSymbol}{fmtDecimal(line.total_amount, 2)}
                  </td>

                  {/* Internal Lot */}
                  <td className="py-2 px-2">
                    {isNew ? (
                      <input
                        type="text"
                        value={line.internal_lot_no}
                        onChange={(e) => updateLine(idx, { internal_lot_no: e.target.value })}
                        className="input text-xs py-1 font-mono"
                      />
                    ) : (
                      <span className="font-mono text-slate-700">{line.internal_lot_no}</span>
                    )}
                  </td>

                  {/* QC Status */}
                  <td className="py-2 px-2 text-center">
                    {isNew ? (
                      <select
                        value={line.qc_status}
                        onChange={(e) => updateLine(idx, { qc_status: e.target.value as any })}
                        className="input text-xs py-1 font-bold"
                      >
                        <option value="ACCEPTED">ACCEPTED</option>
                        <option value="PARTIAL">PARTIAL</option>
                        <option value="REJECTED">REJECTED</option>
                        <option value="HOLD">HOLD</option>
                      </select>
                    ) : (
                      <Badge variant={line.qc_status === 'ACCEPTED' ? 'success' : 'warning'}>
                        {line.qc_status}
                      </Badge>
                    )}
                  </td>

                  {isNew && (
                    <td className="py-2 px-2 text-center">
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        disabled={lines.length === 1}
                        className="text-slate-400 hover:text-red-600 disabled:opacity-30 p-1"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50/80 border-t border-slate-200 font-bold text-slate-800">
              <tr>
                <td colSpan={7} className="py-3 px-3 text-right text-slate-600">Totals:</td>
                <td className="py-3 px-2 text-right font-mono text-slate-500"></td>
                <td className="py-3 px-2 text-right font-mono text-slate-800">{fmtDecimal(totals.totalReceived)}</td>
                <td className="py-3 px-2 text-right font-mono text-emerald-800">{fmtDecimal(totals.totalAccepted)}</td>
                <td className="py-3 px-2 text-right font-mono text-rose-700">{fmtDecimal(totals.totalRejected)}</td>
                <td className="py-3 px-2 text-right font-mono text-amber-700">{fmtDecimal(totals.totalHold)}</td>
                <td className="py-3 px-2 text-right text-slate-500 text-xs">Taxable Total:</td>
                <td className="py-3 px-2 text-right font-mono">{currSymbol}{fmtDecimal(totals.taxableAmount, 2)}</td>
                <td className="py-3 px-2 text-center text-xs text-slate-500">
                  {head.is_interstate ? 'IGST:' : 'CGST+SGST:'}
                </td>
                <td className="py-3 px-2 text-right font-mono text-purple-700">{currSymbol}{fmtDecimal(totals.taxAmount, 2)}</td>
                <td className="py-3 px-2 text-right font-mono text-sm font-black text-slate-900">
                  {currSymbol}{fmtDecimal(totals.grandTotal, 2)}
                </td>
                <td colSpan={isNew ? 3 : 2}></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Footer Financial Breakdown */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row justify-end items-end gap-6 text-xs">
          <div className="space-y-1 text-right font-mono">
            <div className="text-slate-600">
              Taxable Amount: <span className="font-semibold text-slate-900">{currSymbol}{fmtDecimal(totals.taxableAmount, 2)}</span>
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
            <div className="text-sm font-black text-indigo-900 border-t border-slate-200 pt-1">
              Net Payable Grand Total ({currCode}): <span>{currSymbol}{fmtDecimal(totals.grandTotal, 2)}</span>
            </div>
            {isForeignCurrency && (
              <div className="text-xs font-bold text-amber-900 pt-0.5">
                INR Converted Total: <span>₹{fmtDecimal(totals.inrGrandTotal, 2)}</span>
                <span className="text-[10px] font-normal text-slate-500 ml-1">(@ ₹{head.exchange_rate}/{currCode})</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
