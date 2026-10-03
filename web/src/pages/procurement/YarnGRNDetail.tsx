import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { GrnPrintButton } from '../../components/GrnPrintButton';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Save, PackageCheck, Plus, Trash2, Disc, Layers
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, Badge } from '../../components/ui';
import { fmtDecimal, today } from '../../lib/format';
import { InvoiceSummary } from '../../components/InvoiceSummary';
import { computeInvoice, chargesFromRow, chargesPayload, EMPTY_CHARGES, type InvoiceCharges } from '../../lib/invoiceCalc';
import { gateOptions, supplierOptions } from '../../lib/gateOptions';
import { ReceiptTypeChooser, LineReceiptChip, openForGrn, type ReceiptType } from '../../lib/poReceipt';

interface YarnGrnLine {
  _key: string;
  id?: number;
  po_id?: number;
  po_no?: string;
  po_line_id?: number;
  so_id?: string | number;
  style_id?: string | number;
  yarn_id: string | number;
  yarn_name?: string;
  yarn_type: string;
  /** Yarn count as ordered on the PO (e.g. 30s Ne) */
  yarn_count_str?: string;
  shade_code?: string;
  color_name?: string;
  composition?: string;
  lot_no: string;
  po_qty: number;
  /** Ordered on the PO line and received on earlier GRNs (shown on the 2nd+ receipt). */
  ordered_qty?: number;
  prev_received?: number;
  received_qty: number; // in KG
  packs: number; // in bags/packs
  accepted_qty: number;
  rejected_qty: number;
  hold_qty: number;
  balance_qty: number;
  rate: number;
  gst_rate: number;
  taxable_amount: number;
  total_amount: number;
  qc_status: string;
}

let yglSeq = 0;
const emptyYarnGrnLine = (): YarnGrnLine => ({
  _key: `ygl_${++yglSeq}`,
  so_id: '',
  style_id: '',
  yarn_id: '',
  yarn_type: 'Grey Yarn',
  shade_code: '',
  color_name: '',
  lot_no: '',
  po_qty: 0,
  received_qty: 0,
  packs: 0,
  accepted_qty: 0,
  rejected_qty: 0,
  hold_qty: 0,
  balance_qty: 0,
  rate: 0,
  gst_rate: 0,
  taxable_amount: 0,
  total_amount: 0,
  qc_status: 'ACCEPTED',
});

export default function YarnGRNDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();

  const suppliers = useLookup('suppliers');
  const warehouses = useLookup('warehouses');
  const yarns = useLookup('yarns');
  /** The yarn master's count (e.g. "30s Ne") — used when the PO line carries none. */
  const countOf = (yarnId: unknown) => { const y: any = (yarns.data ?? []).find((x: any) => String(x.id) === String(yarnId)); return y?.count_value ? `${y.count_value} ${y.count_type || 'Ne'}` : ''; };
  const styles = useLookup('styles');
  const salesOrders = useLookup('sales-orders');
  const gateInwards = useLookup('gate-inwards');

  // Load PO options for linking
  const { data: poList = [] } = useQuery({
    queryKey: ['available-yarn-pos'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/purchase-orders?po_type=MATERIAL');
      return res.data || [];
    },
    enabled: isNew,
  });

  const [saving, setSaving] = useState(false);
  const [selectedPoIds, setSelectedPoIds] = useState<string[]>([]);

  // Header State
  const [header, setHeader] = useState({
    grn_no: '',
    grn_date: today(),
    /** PARTIAL = more to come on the PO; FINAL = last delivery (pending is closed short) */
    receipt_type: 'PARTIAL' as ReceiptType,
    po_id: '',
    gate_inward_id: '',
    internal_ir_no: '',
    supplier_id: '',
    warehouse_id: '1',
    style_id: '',
    supplier_dc_no: '',
    supplier_inv_no: '',
    vehicle_no: '',
    qc_status: 'ACCEPTED',
    is_interstate: false,
    remarks: '',
  });

  const [lines, setLines] = useState<YarnGrnLine[]>([emptyYarnGrnLine()]);
  // Common invoice summary heads (TDS / TCS / other charges / freight / round off)
  const [charges, setCharges] = useState<InvoiceCharges>(EMPTY_CHARGES);

  // Load existing GRN
  const { data: existingData, isLoading: loadingExisting } = useQuery({
    queryKey: ['yarn-grn-detail', id],
    queryFn: async () => {
      if (isNew) return null;
      const res = await http.get<{ data: any }>(`/yarn-grns/${id}`);
      return res.data;
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (existingData) {
      setHeader({
        grn_no: existingData.grn_no || '',
        grn_date: existingData.grn_date?.slice(0, 10) || today(),
        po_id: existingData.po_id ? String(existingData.po_id) : '',
        gate_inward_id: existingData.gate_inward_id ? String(existingData.gate_inward_id) : '',
        internal_ir_no: existingData.internal_ir_no || '',
        supplier_id: existingData.supplier_id ? String(existingData.supplier_id) : '',
        warehouse_id: existingData.warehouse_id ? String(existingData.warehouse_id) : '1',
        style_id: existingData.style_id ? String(existingData.style_id) : '',
        supplier_dc_no: existingData.supplier_dc_no || '',
        supplier_inv_no: existingData.supplier_inv_no || '',
        vehicle_no: existingData.vehicle_no || '',
        qc_status: existingData.qc_status || 'ACCEPTED',
        is_interstate: Boolean(existingData.is_interstate),
        remarks: existingData.remarks || '',
      });
      setCharges(chargesFromRow(existingData, 'tcs_rate'));

      let pids: string[] = [];
      if (Array.isArray(existingData.po_ids)) {
        pids = existingData.po_ids.map(String).filter(Boolean);
      } else if (typeof existingData.po_ids === 'string') {
        try {
          const parsed = JSON.parse(existingData.po_ids);
          if (Array.isArray(parsed)) pids = parsed.map(String).filter(Boolean);
        } catch {}
      }
      if (!pids.length && existingData.po_id) {
        pids = [String(existingData.po_id)];
      }
      setSelectedPoIds(pids);

      if (existingData.lines?.length) {
        const loadedLines = existingData.lines.map((l: any) => {
          const acc = Number(l.accepted_qty ?? l.received_qty ?? 0);
          const rate = Number(l.rate || 0);
          const taxable = acc * rate;
          const gstRate = Number(l.gst_rate || 5);
          const totalAmt = taxable + (taxable * gstRate) / 100;
          return {
            id: l.id,
            po_id: l.po_id ? Number(l.po_id) : undefined,
            po_no: l.po_no || '',
            yarn_id: l.yarn_id,
            yarn_name: l.yarn_name,
            yarn_type: l.yarn_type || 'Grey Yarn',
            yarn_count_str: l.yarn_count_str || '',
            shade_code: l.shade_code || '',
            color_name: l.color_name || '',
            composition: l.composition,
            lot_no: l.lot_no || '',
            po_qty: Number(l.received_qty) + Number(l.balance_qty || 0),
            received_qty: Number(l.received_qty || 0),
            packs: Number(l.no_of_rolls || l.packs || 1),
            accepted_qty: acc,
            rejected_qty: Number(l.rejected_qty || 0),
            hold_qty: Number(l.hold_qty || 0),
            balance_qty: Number(l.balance_qty || 0),
            rate,
            gst_rate: gstRate,
            taxable_amount: taxable,
            total_amount: totalAmt,
            qc_status: l.qc_status || 'ACCEPTED',
          };
        });
        setLines(loadedLines);
      }
    }
  }, [existingData, isNew]);

  // Handle Gate Inward selection: auto-populate supplier, vehicle, DC, inv, warehouse
  const handleSelectGateInward = (ginIdStr: string) => {
    setHeader((prev) => {
      const next = { ...prev, gate_inward_id: ginIdStr };
      if (!ginIdStr) return next;
      const found = (gateInwards.data as any[])?.find((g) => String(g.id) === ginIdStr);
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
  const handleAddPO = async (poIdStr: string) => {
    if (!poIdStr) return;
    if (selectedPoIds.includes(poIdStr)) {
      toast('This PO is already linked', 'info');
      return;
    }

    try {
      const res = await http.get<{ data: any }>(`/purchase-orders/${poIdStr}`);
      const po = res.data;
      if (po) {
        const nextPoIds = [...selectedPoIds, poIdStr];
        setSelectedPoIds(nextPoIds);

        setHeader((prev) => ({
          ...prev,
          po_id: nextPoIds[0],
          supplier_id: !prev.supplier_id && po.supplier_id ? String(po.supplier_id) : prev.supplier_id,
          internal_ir_no: po.internal_ir_no || prev.internal_ir_no,
          style_id: !prev.style_id && po.style_id ? String(po.style_id) : prev.style_id,
          is_interstate: prev.is_interstate || !!po.is_interstate,
        }));

        if (po.lines?.length) {
          const poLines = po.lines.filter(
            (l: any) => l.material_type === 'YARN' || l.yarn_id
          );
          if (poLines.length > 0) {
            const mappedLines: YarnGrnLine[] = poLines.map((pl: any) => {
              // Receive what is still open on the PO line; rate and GST come from the PO.
              const qty = Math.max(Number(pl.qty || 0) - Number(pl.received_qty || 0), 0);
              const bags = Number(pl.packs) || 0;
              const rate = Number(pl.rate) || 0;
              const gstRate = Number(pl.gst_rate ?? 0) || 0;
              const taxable = Math.round(qty * rate * 100) / 100;
              const taxAmt = Math.round((taxable * (gstRate / 100)) * 100) / 100;
              const totalAmt = taxable + taxAmt;

              return {
                _key: `ygl_${++yglSeq}`,
                po_id: Number(poIdStr),
                po_no: po.po_no,
                po_line_id: pl.id,
                so_id: pl.so_id ? String(pl.so_id) : (po.so_id ? String(po.so_id) : ''),
                style_id: pl.style_id ? String(pl.style_id) : (po.style_id ? String(po.style_id) : ''),
                yarn_id: pl.yarn_id,
                yarn_name: pl.yarn_name,
                yarn_type: pl.yarn_type || 'Grey Yarn',
                yarn_count_str: pl.yarn_count_str || countOf(pl.yarn_id),
                shade_code: pl.shade_code || '',
                color_name: pl.color_name || '',
                composition: pl.composition,
                lot_no: '',
                po_qty: qty,
                ordered_qty: Number(pl.qty) || 0,
                prev_received: Number(pl.received_qty) || 0,
                received_qty: qty,
                packs: bags,
                accepted_qty: qty,
                rejected_qty: 0,
                hold_qty: 0,
                balance_qty: 0,
                rate,
                gst_rate: gstRate,
                taxable_amount: taxable,
                total_amount: totalAmt,
                qc_status: 'ACCEPTED',
              };
            });

            setLines((prev) => {
              const isPlaceholder = prev.length === 1 && !prev[0].id && !prev[0].po_line_id;
              return isPlaceholder ? mappedLines : [...prev, ...mappedLines];
            });
            toast(`Loaded ${mappedLines.length} yarn items from ${po.po_no}`, 'info');
          } else {
            toast(`PO ${po.po_no} has no yarn items`, 'info');
          }
        }
      }
    } catch {
      toast('Failed to load PO details', 'error');
    }
  };

  const handleRemovePO = (poIdStr: string) => {
    const updated = selectedPoIds.filter((p) => p !== poIdStr);
    setSelectedPoIds(updated);
    setHeader((prev) => ({ ...prev, po_id: updated[0] || '' }));

    setLines((prev) => {
      const remaining = prev.filter((l) => String(l.po_id) !== poIdStr);
      if (!remaining.length) {
        return [emptyYarnGrnLine()];
      }
      return remaining;
    });
    toast(`Removed PO #${poIdStr}`, 'info');
  };

  // Recalculate line quantities and amounts
  const updateLine = (idx: number, updates: Partial<YarnGrnLine>) => {
    setLines((prev) => {
      const copy = [...prev];
      const cur = { ...copy[idx], ...updates };

      const rec = Number(cur.received_qty) || 0;
      const rej = Number(cur.rejected_qty) || 0;
      const hold = Number(cur.hold_qty) || 0;
      cur.accepted_qty = Math.max(0, rec - rej - hold);
      cur.balance_qty = Math.max(0, Number(cur.po_qty) - cur.accepted_qty);

      const rate = Number(cur.rate) || 0;
      const gstRate = Number(cur.gst_rate !== undefined ? cur.gst_rate : 5.0);
      const taxable = Math.round(cur.accepted_qty * rate * 100) / 100;
      const taxAmt = Math.round((taxable * (gstRate / 100)) * 100) / 100;
      cur.taxable_amount = taxable;
      cur.total_amount = taxable + taxAmt;

      copy[idx] = cur;
      return copy;
    });
  };

  const totals = useMemo(() => {
    const totalKg = lines.reduce((s, l) => s + (Number(l.received_qty) || 0), 0);
    const acceptedKg = lines.reduce((s, l) => s + (Number(l.accepted_qty) || 0), 0);
    const totalPacks = lines.reduce((s, l) => s + (Number(l.packs) || 0), 0);
    const taxableAmount = lines.reduce((s, l) => s + (Number(l.taxable_amount) || 0), 0);

    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;

    lines.forEach((l) => {
      const tax = Math.round(((l.taxable_amount || 0) * ((Number(l.gst_rate) || 5) / 100)) * 100) / 100;
      if (header.is_interstate) {
        totalIgst += tax;
      } else {
        totalCgst += Math.round((tax / 2) * 100) / 100;
        totalSgst += Math.round((tax / 2) * 100) / 100;
      }
    });

    const totalTax = totalCgst + totalSgst + totalIgst;
    const inv = computeInvoice(
      lines.map((l) => ({ taxable: Number(l.taxable_amount) || 0, gst_rate: Number(l.gst_rate) || 5 })),
      header.is_interstate ? 'INTER_STATE' : 'INTRA_STATE',
      charges,
    );
    const tcsAmt = inv.tcs;
    const grandTotal = inv.net;

    return {
      totalKg,
      acceptedKg,
      totalPacks,
      taxableAmount,
      totalCgst,
      totalSgst,
      totalIgst,
      totalTax,
      tcsAmt,
      grandTotal,
      inv,
    };
  }, [lines, header.is_interstate, charges]);

  const handleSave = async () => {
    if (!header.supplier_id) {
      toast('Please select a spinning mill / supplier', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...header,
        po_id: selectedPoIds.length > 0 ? selectedPoIds[0] : (header.po_id || null),
        po_ids: selectedPoIds.length > 0 ? selectedPoIds.map(Number).filter(Boolean) : (header.po_id ? [Number(header.po_id)] : []),
        ...chargesPayload(charges, totals.inv),
        tcs_rate: Number(charges.tcs_pct) || 0,
        tcs_applicable: Number(charges.tcs_pct) > 0 ? 1 : 0,
        tcs_section: Number(charges.tcs_pct) > 0 ? (charges.tcs_section || '206C(1H)') : null,
        grand_total: totals.grandTotal,
        lines: lines.map((l) => ({
          po_id: l.po_id || (selectedPoIds[0] ? Number(selectedPoIds[0]) : undefined),
          po_line_id: l.po_line_id,
          so_id: l.so_id ? Number(l.so_id) : undefined,
          style_id: l.style_id ? Number(l.style_id) : undefined,
          yarn_id: l.yarn_id,
          yarn_type: l.yarn_type || 'Grey Yarn',
          yarn_count_str: l.yarn_count_str || countOf(l.yarn_id) || null,
          shade_code: l.shade_code || null,
          color_name: l.color_name || null,
          received_qty: l.received_qty,
          packs: l.packs,
          accepted_qty: l.accepted_qty,
          rejected_qty: l.rejected_qty,
          hold_qty: l.hold_qty,
          balance_qty: l.balance_qty,
          lot_no: l.lot_no,
          qc_status: l.qc_status,
          rate: l.rate,
          gst_rate: l.gst_rate,
          taxable_amount: l.taxable_amount,
          total_amount: l.total_amount,
        })),
      };

      const res = await http.post<{ data: any }>('/yarn-grns', payload);
      toast(`Yarn GRN ${res.data.grn_no} posted to inventory in KG!`, 'success');
      nav('/procurement/yarn/grn');
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : 'Failed to save yarn GRN';
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && loadingExisting) {
    return (
      <div className="py-20 text-center text-slate-400">
        Loading yarn GRN #{id}...
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-16">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => nav('/procurement/yarn/grn')}
            className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-600 transition"
            title="Back to Yarn GRNs"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-md bg-amber-100 text-amber-700">
                <PackageCheck size={18} />
              </span>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                {isNew ? 'New Yarn GRN (Weighed Inward)' : `Yarn GRN: ${header.grn_no}`}
              </h1>
              {!isNew && <Badge tone="green">POSTED TO STOCK (KG)</Badge>}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Weighed KG gross/tare receipt, bag counting, lot verification, tax amounts, and stock ledger posting
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!isNew && <GrnPrintButton kind="grn" id={Number(id)} />}
          {isNew && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white shadow-sm transition disabled:opacity-50"
            >
              <Save size={15} />
              <span>{saving ? 'Posting to Stock...' : 'Post & Save Yarn GRN'}</span>
            </button>
          )}
        </div>
      </div>

      {/* KPI Summary Strip (6 cards: Qty, Packs, Taxable, GST/IGST, Net) */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <div className="p-3 bg-amber-50/70 rounded-xl border border-amber-200">
          <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider">Total Weighed</div>
          <div className="text-lg font-bold text-amber-900 mt-0.5 font-mono">{fmtDecimal(totals.totalKg)} KG</div>
        </div>
        <div className="p-3 bg-emerald-50/70 rounded-xl border border-emerald-200">
          <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">Accepted Net Qty</div>
          <div className="text-lg font-bold text-emerald-900 mt-0.5 font-mono">{fmtDecimal(totals.acceptedKg)} KG</div>
        </div>
        <div className="p-3 bg-indigo-50/70 rounded-xl border border-indigo-200">
          <div className="text-[11px] font-semibold text-indigo-700 uppercase tracking-wider">Bags / Packs</div>
          <div className="text-lg font-bold text-indigo-900 mt-0.5 font-mono">{totals.totalPacks} Bags</div>
        </div>
        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
          <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Taxable Value</div>
          <div className="text-lg font-bold text-slate-900 mt-0.5 font-mono">₹{fmtDecimal(totals.taxableAmount, 2)}</div>
        </div>
        <div className="p-3 bg-purple-50/70 rounded-xl border border-purple-200">
          <div className="text-[11px] font-semibold text-purple-700 uppercase tracking-wider">
            {header.is_interstate ? 'IGST Amount' : 'CGST + SGST'}
          </div>
          <div className="text-lg font-bold text-purple-900 mt-0.5 font-mono">₹{fmtDecimal(totals.totalTax, 2)}</div>
        </div>
        <div className="p-3 bg-amber-100/60 rounded-xl border border-amber-300">
          <div className="text-[11px] font-semibold text-amber-900 uppercase tracking-wider">Net Payable</div>
          <div className="text-lg font-bold text-amber-950 mt-0.5 font-mono">₹{fmtDecimal(totals.grandTotal, 2)}</div>
        </div>
      </div>

      {/* Header Fields Card */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-2 border-b border-slate-100 gap-2">
          <div className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
            <Disc size={14} className="text-amber-600" />
            <span>Receipt Header Information</span>
          </div>

          {/* Inter-State Supply IGST Toggle */}
          <label className="flex items-center gap-2 cursor-pointer bg-slate-50 hover:bg-slate-100 border border-slate-200 px-3 py-1 rounded-lg text-xs transition">
            <input
              type="checkbox"
              checked={header.is_interstate}
              disabled={!isNew}
              onChange={(e) => setHeader((h) => ({ ...h, is_interstate: e.target.checked }))}
              className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
            />
            <span className="font-semibold text-slate-700">Inter-State Supply (IGST Applicable)</span>
            <span className="text-[10px] text-slate-400 font-normal">
              {header.is_interstate ? 'Single IGST rate applied' : 'Split CGST + SGST applied'}
            </span>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          <Input
            label="GRN No"
            value={isNew ? '(Auto-generated on Save)' : header.grn_no}
            disabled
            className="font-mono font-bold text-amber-800 bg-amber-50/40"
          />

          <Input
            label="GRN Date"
            type="date"
            value={header.grn_date}
            onChange={(e) => setHeader((p) => ({ ...p, grn_date: e.target.value }))}
            disabled={!isNew}
          />

          {isNew ? (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-slate-600">
                  Link Yarn POs ({selectedPoIds.length} selected)
                </label>
                {selectedPoIds.length > 0 && (
                  <span className="text-[10px] text-amber-700 font-semibold">Multi-PO active</span>
                )}
              </div>
              <select
                value=""
                onChange={(e) => handleAddPO(e.target.value)}
                className="w-full text-xs rounded-lg border border-slate-300 py-1.5 px-2 focus:border-amber-500 font-semibold text-amber-900"
              >
                <option value="">+ Add PO to this GRN...</option>
                {poList.filter((p) => !selectedPoIds.includes(String(p.id)) && openForGrn(p)).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.po_no} ({p.supplier_name || 'Mill'}){p.receipt_status === 'PARTIALLY_RECEIVED' ? ' · partially received' : ''}
                  </option>
                ))}
              </select>

              {selectedPoIds.length > 0 && (
                <div className="mt-2"><ReceiptTypeChooser value={header.receipt_type} onChange={(v) => setHeader((h) => ({ ...h, receipt_type: v }))} id="ygrn-receipt" /></div>
              )}
              {/* Selected PO Badges */}
              {selectedPoIds.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  {selectedPoIds.map((pId) => {
                    const pObj = poList.find((p) => String(p.id) === pId);
                    const label = pObj?.po_no || `PO #${pId}`;
                    const lineCnt = lines.filter((l) => String(l.po_id) === pId).length;
                    return (
                      <span key={pId} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-semibold bg-amber-50 text-amber-900 border border-amber-300">
                        <span>📋 {label}</span>
                        {lineCnt > 0 && <span className="text-[10px] bg-amber-200 text-amber-900 px-1 rounded font-mono">{lineCnt} items</span>}
                        <button
                          type="button"
                          onClick={() => handleRemovePO(pId)}
                          className="text-amber-600 hover:text-rose-600 font-bold ml-0.5"
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
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Linked Purchase Orders ({selectedPoIds.length || (header.po_id ? 1 : 0)})
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {(selectedPoIds.length > 0 ? selectedPoIds : (header.po_id ? [header.po_id] : [])).map((pId) => (
                  <span key={pId} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-300">
                    📋 PO #{pId}
                  </span>
                ))}
                {!selectedPoIds.length && !header.po_id && (
                  <span className="text-xs text-slate-400">Direct Receipt</span>
                )}
              </div>
            </div>
          )}

          {isNew ? (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Map Gate Entry (Auto-fills details)
              </label>
              <select
                value={header.gate_inward_id}
                onChange={(e) => handleSelectGateInward(e.target.value)}
                className="w-full text-xs rounded-lg border border-amber-300 bg-amber-50/40 py-1.5 px-2 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
              >
                <option value="">-- Select Inward Gate Pass --</option>
                {gateOptions(gateInwards.data as any[], header.supplier_id, header.gate_inward_id).map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
            </div>
          ) : (
            <Input
              label="Gate Inward Entry"
              value={(existingData as any)?.gate_entry_no || (header.gate_inward_id ? `GIN #${header.gate_inward_id}` : 'None')}
              disabled
            />
          )}

          <Select
            label="Spinning Mill / Supplier *"
            value={header.supplier_id}
            onChange={(e) => setHeader((p) => ({ ...p, supplier_id: e.target.value }))}
            options={supplierOptions(suppliers.data, header.supplier_id, poList)}
            placeholder="Select Mill"
            disabled={!isNew}
          />

          <Select
            label="Receiving Warehouse *"
            value={header.warehouse_id}
            onChange={(e) => setHeader((p) => ({ ...p, warehouse_id: e.target.value }))}
            options={toOptions(warehouses.data)}
            disabled={!isNew}
          />

          <Input
            label="IO No (Internal Order)"
            value={header.internal_ir_no}
            onChange={(e) => setHeader((p) => ({ ...p, internal_ir_no: e.target.value }))}
            disabled={!isNew}
          />

          <Select
            label="Style No (Default)"
            value={header.style_id}
            onChange={(e) => setHeader((p) => ({ ...p, style_id: e.target.value }))}
            options={toOptions(styles.data)}
            placeholder="Select Style"
            disabled={!isNew}
          />

          <Input
            label="Supplier DC No"
            value={header.supplier_dc_no}
            onChange={(e) => setHeader((p) => ({ ...p, supplier_dc_no: e.target.value }))}
            disabled={!isNew}
          />

          <Input
            label="Supplier Inv / Bill No"
            value={header.supplier_inv_no}
            onChange={(e) => setHeader((p) => ({ ...p, supplier_inv_no: e.target.value }))}
            disabled={!isNew}
          />

          <Input
            label="Vehicle No"
            value={header.vehicle_no}
            onChange={(e) => setHeader((p) => ({ ...p, vehicle_no: e.target.value }))}
            placeholder="TN 38 AB 9876"
            disabled={!isNew}
          />

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Overall QC Status
            </label>
            <select
              value={header.qc_status}
              onChange={(e) => setHeader((p) => ({ ...p, qc_status: e.target.value }))}
              className="w-full text-xs rounded-lg border border-slate-300 py-1.5 px-2 font-semibold"
              disabled={!isNew}
            >
              <option value="ACCEPTED">ACCEPTED (Post to Available Stock)</option>
              <option value="CONDITIONAL">CONDITIONAL (Reserved / Lab Hold)</option>
              <option value="REJECTED">REJECTED (Do Not Stock)</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <Input
              label="Remarks / Weigher Notes"
              value={header.remarks}
              onChange={(e) => setHeader((p) => ({ ...p, remarks: e.target.value }))}
              placeholder="e.g. Weighbridge slip #9842 verified. Moisture test normal."
              disabled={!isNew}
            />
          </div>
        </div>
      </div>

      {/* Yarn Line Items Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden space-y-3 p-4">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
          <div>
            <h2 className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <Layers size={14} className="text-amber-600" />
              <span>Yarn Inward Items & Amount Details ({lines.length})</span>
            </h2>
            <p className="text-[11px] text-slate-400">
              Multiple jobs supported: assign each line item to a Sales Order or Stock, with live tax and amount details
            </p>
          </div>
          {isNew && (
            <button
              onClick={() => setLines((p) => [...p, emptyYarnGrnLine()])}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
            >
              <Plus size={13} />
              <span>Add Yarn Item</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                <th className="py-2.5 px-2 w-8 text-center">#</th>
                <th className="py-2.5 px-2 min-w-[100px]">PO Ref</th>
                <th className="py-2.5 px-2 min-w-[130px]">IO No</th>
                <th className="py-2.5 px-2 min-w-[110px]">Style</th>
                <th className="py-2.5 px-3 min-w-[140px]">Yarn Item</th>
                <th className="py-2.5 px-2 w-24">Count</th>
                <th className="py-2.5 px-2 w-24">Type</th>
                <th className="py-2.5 px-2 w-24">Color / Shade</th>
                <th className="py-2.5 px-2 w-24">Lot / Batch</th>
                <th className="py-2.5 px-2 text-right w-20">PO (KG)</th>
                <th className="py-2.5 px-2 text-right w-24">Weighed (KG) *</th>
                <th className="py-2.5 px-2 text-center w-16">Bags</th>
                <th className="py-2.5 px-2 text-right w-20">Acc (KG)</th>
                <th className="py-2.5 px-2 text-right w-16">Rej</th>
                <th className="py-2.5 px-2 text-right w-16">Hold</th>
                <th className="py-2.5 px-2 text-right w-20">Rate (₹)</th>
                <th className="py-2.5 px-2 text-right w-24">Taxable (₹)</th>
                <th className="py-2.5 px-2 text-center w-16">{header.is_interstate ? 'IGST %' : 'GST %'}</th>
                <th className="py-2.5 px-2 text-right w-20">Tax (₹)</th>
                <th className="py-2.5 px-2 text-right w-24">Total (₹)</th>
                <th className="py-2.5 px-2 text-center w-20">QC</th>
                {isNew && <th className="py-2.5 px-2 text-center w-8"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {lines.map((l, idx) => {
                const lineTax = Math.round(((l.taxable_amount || 0) * ((Number(l.gst_rate) || 5) / 100)) * 100) / 100;
                return (
                  <tr key={l._key || idx} className="hover:bg-slate-50/70 transition">
                    {/* # S.No */}
                    <td className="py-2.5 px-2 text-center text-slate-400 font-mono text-[11px]">{idx + 1}</td>

                    {/* PO Ref */}
                    <td className="py-2.5 px-2">
                      {l.po_no || l.po_id ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                          {l.po_no || `PO #${l.po_id}`}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">—</span>
                      )}
                    </td>

                    {/* I/O Num (Internal Order / Job) */}
                    <td className="py-2.5 px-2">
                      {isNew ? (
                        <select
                          value={l.so_id || ''}
                          onChange={(e) => {
                            const so = (salesOrders.data ?? []).find((x: any) => String(x.id) === e.target.value);
                            updateLine(idx, { so_id: e.target.value, ...(so?.style_id ? { style_id: String(so.style_id) } : {}) });
                          }}
                          className="w-full text-xs rounded border border-slate-300 py-1 px-1 bg-white"
                        >
                          <option value="">Stock / General</option>
                          {toOptions(salesOrders.data).map((so) => (
                            <option key={so.value} value={so.value}>{so.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="font-medium text-slate-700">
                          {l.so_id ? ((salesOrders.data ?? []).find((x: any) => String(x.id) === String(l.so_id))?.job_no ?? `SO #${l.so_id}`) : 'Stock / General'}
                        </span>
                      )}
                    </td>

                    {/* Style */}
                    <td className="py-2.5 px-2">
                      {isNew ? (
                        <select
                          value={l.style_id || ''}
                          onChange={(e) => updateLine(idx, { style_id: e.target.value })}
                          className="w-full text-xs rounded border border-slate-300 py-1 px-1 bg-white"
                        >
                          <option value="">—</option>
                          {toOptions(styles.data).map((st) => (
                            <option key={st.value} value={st.value}>{st.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="font-medium text-slate-700">
                          {l.style_id ? `Style #${l.style_id}` : '—'}
                        </span>
                      )}
                    </td>

                    {/* Yarn Item */}
                    <td className="py-2.5 px-3">
                      {isNew ? (
                        <select
                          value={l.yarn_id}
                          onChange={(e) => updateLine(idx, { yarn_id: e.target.value, yarn_count_str: countOf(e.target.value) })}
                          className="w-full text-xs rounded border border-slate-300 py-1 px-1.5"
                        >
                          <option value="">Select Yarn</option>
                          {toOptions(yarns.data).map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="font-semibold text-slate-900">{l.yarn_name || 'Yarn Item'}</div>
                      )}
                    </td>

                    {/* Yarn count (as ordered) */}
                    <td className="py-2.5 px-2" id={`yg-count-${idx}`}>
                      {isNew ? (
                        <input value={l.yarn_count_str ?? ''} placeholder="e.g. 30s Ne" onChange={(e) => updateLine(idx, { yarn_count_str: e.target.value })}
                          className="w-20 text-xs rounded border border-slate-300 py-0.5 px-1" />
                      ) : <span className="font-semibold">{l.yarn_count_str || '—'}</span>}
                    </td>

                    {/* Yarn Type */}
                    <td className="py-2.5 px-2 text-slate-600">
                      {isNew ? (
                        <select
                          value={l.yarn_type}
                          onChange={(e) => updateLine(idx, { yarn_type: e.target.value })}
                          className={`text-xs rounded border py-0.5 px-1 font-semibold ${
                            l.yarn_type === 'Dyed Yarn'
                              ? 'bg-purple-50 text-purple-700 border-purple-300'
                              : 'bg-amber-50 text-amber-800 border-amber-300'
                          }`}
                        >
                          <option value="Grey Yarn">Grey Yarn</option>
                          <option value="Dyed Yarn">Dyed Yarn</option>
                        </select>
                      ) : (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          l.yarn_type === 'Dyed Yarn'
                            ? 'bg-purple-100 text-purple-700'
                            : 'bg-amber-100 text-amber-800'
                        }`}>
                          {l.yarn_type}
                        </span>
                      )}
                    </td>

                    {/* Color / Shade */}
                    <td className="py-2.5 px-2">
                      {isNew ? (
                        l.yarn_type === 'Dyed Yarn' ? (
                          <input
                            type="text"
                            value={l.shade_code || l.color_name || ''}
                            onChange={(e) => updateLine(idx, { shade_code: e.target.value, color_name: e.target.value })}
                            className="w-20 text-xs font-mono border border-purple-300 bg-purple-50/40 rounded px-1 py-1"
                            placeholder="Shade"
                          />
                        ) : (
                          <span className="text-slate-400 text-xs block text-center">—</span>
                        )
                      ) : (
                        <span className="font-mono text-slate-700 text-xs">{l.shade_code || l.color_name || '—'}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2">
                      {isNew ? (
                        <input
                          type="text"
                          value={l.lot_no}
                          onChange={(e) => updateLine(idx, { lot_no: e.target.value })}
                          className="w-20 text-xs font-mono border border-slate-300 rounded px-1.5 py-1"
                        />
                      ) : (
                        <span className="font-mono text-slate-700">{l.lot_no}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2 text-right text-slate-500 whitespace-nowrap">
                      {l.ordered_qty != null ? (
                        <div className="leading-tight">
                          <div>{fmtDecimal(l.ordered_qty)} <span className="text-[10px] text-slate-400">ordered</span></div>
                          {Number(l.prev_received) > 0 && <div>{fmtDecimal(l.prev_received)} <span className="text-[10px]">recd earlier</span></div>}
                          <div className="font-semibold text-amber-700">{fmtDecimal(l.po_qty)} <span className="text-[10px] font-normal">pending</span></div>
                          {isNew && <LineReceiptChip ordered={l.ordered_qty} prev={l.prev_received} accepted={Number(l.accepted_qty) || 0} type={header.receipt_type} />}
                        </div>
                      ) : fmtDecimal(l.po_qty)}
                    </td>
                    <td className="py-2.5 px-2 text-right">
                      {isNew ? (
                        <input
                          type="number"
                          step="0.01"
                          value={l.received_qty}
                          onChange={(e) =>
                            updateLine(idx, { received_qty: parseFloat(e.target.value) || 0 })
                          }
                          className="w-20 text-xs text-right font-bold text-amber-700 border border-slate-300 rounded px-1.5 py-1"
                        />
                      ) : (
                        <span className="font-bold text-amber-700">{fmtDecimal(l.received_qty)}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2 text-center">
                      {isNew ? (
                        <input
                          type="number"
                          value={l.packs}
                          onChange={(e) =>
                            updateLine(idx, { packs: parseInt(e.target.value) || 0 })
                          }
                          className="w-14 text-xs text-center border border-slate-300 rounded px-1 py-1"
                        />
                      ) : (
                        <span className="font-medium">{l.packs}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2 text-right font-semibold text-emerald-600">
                      {fmtDecimal(l.accepted_qty)}
                    </td>
                    <td className="py-2.5 px-2 text-right">
                      {isNew ? (
                        <input
                          type="number"
                          step="0.01"
                          value={l.rejected_qty}
                          onChange={(e) =>
                            updateLine(idx, { rejected_qty: parseFloat(e.target.value) || 0 })
                          }
                          className="w-14 text-xs text-right text-red-600 border border-slate-300 rounded px-1 py-1"
                        />
                      ) : (
                        <span className="text-red-600">{fmtDecimal(l.rejected_qty)}</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2 text-right">
                      {isNew ? (
                        <input
                          type="number"
                          step="0.01"
                          value={l.hold_qty}
                          onChange={(e) =>
                            updateLine(idx, { hold_qty: parseFloat(e.target.value) || 0 })
                          }
                          className="w-14 text-xs text-right text-amber-600 border border-slate-300 rounded px-1 py-1"
                        />
                      ) : (
                        <span className="text-amber-600">{fmtDecimal(l.hold_qty)}</span>
                      )}
                    </td>

                    {/* Rate */}
                    <td className="py-2.5 px-2 text-right">
                      {isNew ? (
                        <input
                          type="number"
                          step="0.1"
                          value={l.rate}
                          onChange={(e) => updateLine(idx, { rate: parseFloat(e.target.value) || 0 })}
                          className="w-16 text-xs text-right font-mono border border-slate-300 rounded px-1 py-1"
                        />
                      ) : (
                        <span className="font-mono">₹{fmtDecimal(l.rate, 2)}</span>
                      )}
                    </td>

                    {/* Taxable Amount */}
                    <td className="py-2.5 px-2 text-right font-mono font-medium text-slate-900">
                      ₹{fmtDecimal(l.taxable_amount, 2)}
                    </td>

                    {/* GST % */}
                    <td className="py-2.5 px-2 text-center">
                      {isNew ? (
                        <select
                          value={l.gst_rate}
                          onChange={(e) => updateLine(idx, { gst_rate: parseFloat(e.target.value) || 5 })}
                          className="w-16 text-xs text-center border border-slate-300 rounded px-1 py-1 bg-white font-mono"
                        >
                          <option value="0">0%</option>
                          <option value="5">5%</option>
                          <option value="12">12%</option>
                          <option value="18">18%</option>
                          <option value="28">28%</option>
                        </select>
                      ) : (
                        <span className="font-mono">{l.gst_rate}%</span>
                      )}
                    </td>

                    {/* Tax Amount */}
                    <td className="py-2.5 px-2 text-right font-mono text-purple-700">
                      ₹{fmtDecimal(lineTax, 2)}
                    </td>

                    {/* Total Amount */}
                    <td className="py-2.5 px-2 text-right font-mono font-bold text-slate-900">
                      ₹{fmtDecimal(l.total_amount, 2)}
                    </td>

                    <td className="py-2.5 px-2 text-center">
                      {isNew ? (
                        <select
                          value={l.qc_status}
                          onChange={(e) => updateLine(idx, { qc_status: e.target.value })}
                          className="text-[11px] rounded border border-slate-300 py-0.5 px-1 font-semibold"
                        >
                          <option value="ACCEPTED">ACCEPTED</option>
                          <option value="CONDITIONAL">CONDITIONAL</option>
                          <option value="REJECTED">REJECTED</option>
                        </select>
                      ) : (
                        <Badge tone={l.qc_status === 'ACCEPTED' ? 'green' : 'amber'}>
                          {l.qc_status}
                        </Badge>
                      )}
                    </td>
                    {isNew && (
                      <td className="py-2.5 px-2 text-center">
                        <button
                          onClick={() => setLines((p) => p.filter((_, i) => i !== idx))}
                          className="p-1 text-slate-400 hover:text-red-600 rounded"
                          disabled={lines.length === 1}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50/80 border-t border-slate-200 font-bold text-slate-800">
              <tr>
                <td colSpan={9} className="py-3 px-3 text-right text-slate-600">Totals:</td>
                <td className="py-3 px-2 text-right font-mono text-amber-800">{fmtDecimal(totals.totalKg, 2)}</td>
                <td className="py-3 px-2 text-center font-mono">{totals.totalPacks}</td>
                <td className="py-3 px-2 text-right font-mono text-emerald-800">{fmtDecimal(totals.acceptedKg, 2)}</td>
                <td colSpan={3} className="py-3 px-2 text-right text-slate-500 text-xs">Taxable Total:</td>
                <td className="py-3 px-2 text-right font-mono">₹{fmtDecimal(totals.taxableAmount, 2)}</td>
                <td className="py-3 px-2 text-center text-xs text-slate-500">
                  {header.is_interstate ? 'IGST:' : 'CGST+SGST:'}
                </td>
                <td className="py-3 px-2 text-right font-mono text-purple-700">₹{fmtDecimal(totals.totalTax, 2)}</td>
                <td className="py-3 px-2 text-right font-mono text-sm font-black text-slate-900">
                  ₹{fmtDecimal(totals.grandTotal, 2)}
                </td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Common invoice financial summary */}
        <div className="mt-4 flex justify-end">
          <InvoiceSummary
            className="w-full max-w-md"
            totals={totals.inv}
            value={charges}
            onChange={(patch) => setCharges((c) => ({ ...c, ...patch }))}
            gstMode={header.is_interstate ? 'INTER_STATE' : 'INTRA_STATE'}
            readOnly={!isNew}
          />
        </div>
      </div>
    </div>
  );
}
