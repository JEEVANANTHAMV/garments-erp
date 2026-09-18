import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Save, Send, CheckCircle2, Truck,
  Plus, Trash2, Layers, FileText, PackageCheck,
  Building2, DollarSign
} from 'lucide-react';
import { useLookup } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { http } from '../../lib/api';
import { fmtDecimal, today } from '../../lib/format';
import { Badge, Spinner } from '../../components/ui';

interface ReturnLine {
  id?: number;
  grn_line_id?: number | null;
  material_type: 'YARN' | 'FABRIC' | 'TRIM' | 'GENERAL';
  yarn_id?: number | null;
  fabric_id?: number | null;
  trim_id?: number | null;
  color_id?: number | null;
  item_name?: string;
  grn_qty: number;
  prev_returned_qty: number;
  issued_qty: number;
  returnable_qty: number;
  return_qty: number;
  uom_id: number;
  uom_code?: string;
  rate: number;
  basic_amount: number;
  gst_percent: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  total_amount: number;
  reason?: string;
  // Dynamic fields
  lot_no?: string;
  dye_lot_no?: string;
  cone_count?: number;
  bag_count?: number;
  roll_no?: string;
  batch_no?: string;
  gsm?: string;
  dia?: string;
  size?: string;
  department?: string;
  expiry_date?: string;
  job_no?: string;
  style_no?: string;
  remarks?: string;
}

interface AllocationLine {
  id?: number;
  line_index: number;
  job_no: string;
  style_no: string;
  allocated_qty: number;
  remarks?: string;
}

export function PurchaseReturnDetailPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [reasons, setReasons] = useState<any[]>([]);

  // Lookups
  const { data: suppliers } = useLookup('suppliers');
  const { data: warehouses } = useLookup('warehouses');
  const { data: purchaseOrders } = useLookup('purchase-orders');
  const { data: grns } = useLookup('grns');

  // Header State
  const [head, setHead] = useState<any>({
    return_no: '',
    return_type: 'FULL',
    material_category: 'FABRIC',
    return_date: today(),
    supplier_id: '',
    source_po_id: '',
    source_grn_id: '',
    warehouse_id: 1,
    return_reason: 'QUALITY_REJECTION',
    remarks: '',
    status: 'DRAFT',
    // Return DC
    return_dc_no: '',
    return_dc_date: today(),
    transporter_name: '',
    vehicle_no: '',
    driver_name: '',
    eway_bill_no: '',
    // Credit Note
    credit_note_ref: '',
    credit_note_date: '',
    credit_note_amount: 0,
    stock_posted: 0,
  });

  const [lines, setLines] = useState<ReturnLine[]>([]);
  const [allocations, setAllocations] = useState<AllocationLine[]>([]);

  // Load Reasons
  useEffect(() => {
    http.get<{ data: any[] }>('/purchase-returns/reasons')
      .then((res) => setReasons(res.data || []))
      .catch(() => {});
  }, []);

  // Load existing Return
  useEffect(() => {
    if (!isNew && id) {
      setLoading(true);
      http.get<{ data: any }>(`/purchase-returns/${id}`)
        .then((res) => {
          const d = res.data;
          setHead({
            ...d,
            supplier_id: d.supplier_id || '',
            source_po_id: d.source_po_id || '',
            source_grn_id: d.source_grn_id || '',
            warehouse_id: d.warehouse_id || 1,
          });
          setLines(d.lines || []);
          setAllocations(d.allocations || []);
        })
        .catch(() => {
          toast('Failed to load purchase return', 'error');
          nav('/procurement/returns');
        })
        .finally(() => setLoading(false));
    }
  }, [id, isNew]);

  // Load GRN items when GRN is selected
  const handleGrnSelect = async (grnId: string) => {
    setHead((h: any) => ({ ...h, source_grn_id: grnId }));
    if (!grnId) return;

    try {
      const res = await http.get<{ data: { grn: any; lines: any[] } }>(`/purchase-returns/grn/${grnId}/returnable-items`);
      const { grn, lines: grnLines } = res.data;

      if (grn) {
        setHead((h: any) => ({
          ...h,
          supplier_id: grn.supplier_id || h.supplier_id,
          source_po_id: grn.po_id || h.source_po_id,
          warehouse_id: grn.warehouse_id || h.warehouse_id,
        }));
      }

      const newLines: ReturnLine[] = grnLines.map((gl) => {
        const returnable = gl.returnable_qty || 0;
        const rate = Number(gl.rate || 0);
        const gstRate = Number(gl.gst_rate || 5);
        const basic = Number((returnable * rate).toFixed(4));
        const gstAmt = Number((basic * (gstRate / 100)).toFixed(4));

        return {
          grn_line_id: gl.id,
          material_type: gl.fabric_id ? 'FABRIC' : gl.yarn_id ? 'YARN' : 'TRIM',
          yarn_id: gl.yarn_id,
          fabric_id: gl.fabric_id,
          trim_id: gl.trim_id,
          color_id: gl.color_id,
          item_name: gl.yarn_name || gl.fabric_name || gl.color_name || `Line #${gl.id}`,
          grn_qty: Number(gl.grn_qty || 0),
          prev_returned_qty: Number(gl.previous_returned_qty || 0),
          issued_qty: Number(gl.issued_qty || 0),
          returnable_qty: returnable,
          return_qty: returnable,
          uom_id: gl.uom_id || 1,
          uom_code: gl.uom_code || 'KG',
          rate,
          basic_amount: basic,
          gst_percent: gstRate,
          cgst_amount: Number((gstAmt / 2).toFixed(4)),
          sgst_amount: Number((gstAmt / 2).toFixed(4)),
          igst_amount: 0,
          total_amount: basic + gstAmt,
          reason: head.return_reason,
          lot_no: gl.lot_no || '',
          dye_lot_no: gl.shade_code || '',
          roll_no: gl.roll_no || '',
          gsm: gl.gsm || '',
          dia: gl.dia || '',
        };
      });

      setLines(newLines);
      toast(`Loaded ${newLines.length} items from GRN with returnable balances`, 'success');
    } catch {
      toast('Failed to load items for chosen GRN', 'error');
    }
  };

  const updateLine = (idx: number, patch: Partial<ReturnLine>) => {
    setLines((prev) => {
      const next = [...prev];
      const cur = { ...next[idx], ...patch };

      // Recalculate amounts
      const qty = Number(cur.return_qty || 0);
      const rate = Number(cur.rate || 0);
      const gstPct = Number(cur.gst_percent || 0);
      const basic = Number((qty * rate).toFixed(4));
      const gstAmt = Number((basic * (gstPct / 100)).toFixed(4));

      cur.basic_amount = basic;
      cur.cgst_amount = Number((gstAmt / 2).toFixed(4));
      cur.sgst_amount = Number((gstAmt / 2).toFixed(4));
      cur.total_amount = basic + gstAmt;

      next[idx] = cur;
      return next;
    });
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
    setAllocations((prev) => prev.filter((a) => a.line_index !== idx));
  };

  const addEmptyLine = () => {
    setLines((prev) => [
      ...prev,
      {
        material_type: head.material_category,
        item_name: 'Manual Return Item',
        grn_qty: 0,
        prev_returned_qty: 0,
        issued_qty: 0,
        returnable_qty: 0,
        return_qty: 1,
        uom_id: 1,
        rate: 100,
        basic_amount: 100,
        gst_percent: 5,
        cgst_amount: 2.5,
        sgst_amount: 2.5,
        igst_amount: 0,
        total_amount: 105,
        reason: head.return_reason,
      },
    ]);
  };

  const addAllocation = (lineIndex: number) => {
    setAllocations((prev) => [
      ...prev,
      {
        line_index: lineIndex,
        job_no: 'JOB-2026-001',
        style_no: 'STYLE-001',
        allocated_qty: lines[lineIndex]?.return_qty || 0,
        remarks: 'Allocation against line item',
      },
    ]);
  };

  const removeAllocation = (idx: number) => {
    setAllocations((prev) => prev.filter((_, i) => i !== idx));
  };

  // Totals
  const totalReturnQty = lines.reduce((acc, l) => acc + Number(l.return_qty || 0), 0);
  const totalBasic = lines.reduce((acc, l) => acc + Number(l.basic_amount || 0), 0);
  const totalGst = lines.reduce((acc, l) => acc + (Number(l.cgst_amount || 0) + Number(l.sgst_amount || 0) + Number(l.igst_amount || 0)), 0);
  const grandTotal = totalBasic + totalGst;

  // Save Return
  const handleSave = async () => {
    if (!head.supplier_id) {
      toast('Please select a Supplier', 'error');
      return;
    }
    if (!lines.length) {
      toast('Please add at least one line item', 'error');
      return;
    }

    // Validation: return_qty <= returnable_qty when GRN is linked
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.grn_line_id && l.return_qty > l.returnable_qty) {
        toast(`Line #${i + 1}: Return Qty (${l.return_qty}) exceeds Returnable Qty (${l.returnable_qty})`, 'error');
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        ...head,
        lines,
        allocations,
      };

      if (isNew) {
        const res = await http.post<{ data: { id: number } }>('/purchase-returns', payload);
        toast('Purchase Return created successfully', 'success');
        nav(`/procurement/returns/${res.data.id}`);
      } else {
        toast('Purchase Return updated', 'success');
      }
    } catch (err: any) {
      toast(err?.response?.data?.message || 'Failed to save Purchase Return', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Status transitions
  const handleStatusChange = async (newStatus: string) => {
    if (isNew) return;
    try {
      await http.post(`/purchase-returns/${id}/status`, { status: newStatus });
      setHead((h: any) => ({ ...h, status: newStatus }));
      toast(`Status updated to ${newStatus}`, 'success');
    } catch {
      toast('Failed to update status', 'error');
    }
  };

  // Return DC
  const handleGenerateDC = async () => {
    if (isNew) return;
    try {
      const res = await http.post<{ data: any }>(`/purchase-returns/${id}/return-dc`, {
        transporter_name: head.transporter_name,
        vehicle_no: head.vehicle_no,
        driver_name: head.driver_name,
        eway_bill_no: head.eway_bill_no,
      });
      setHead((h: any) => ({
        ...h,
        return_dc_no: res.data.return_dc_no,
        return_dc_date: res.data.return_dc_date,
        status: 'RETURN_DC_CREATED',
      }));
      toast(`Return DC generated: ${res.data.return_dc_no}`, 'success');
    } catch {
      toast('Failed to generate Return DC', 'error');
    }
  };

  // Post Stock
  const handlePostStock = async () => {
    if (isNew) return;
    try {
      await http.post(`/purchase-returns/${id}/post-stock`);
      setHead((h: any) => ({ ...h, stock_posted: 1, status: 'STOCK_POSTED' }));
      toast('Stock deduction / reversal posted to inventory', 'success');
    } catch (err: any) {
      toast(err?.response?.data?.message || 'Failed to post stock reversal', 'error');
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size={32} />
      </div>
    );
  }

  const isDraft = head.status === 'DRAFT';
  const isApproved = head.status === 'APPROVED';
  const isDcCreated = head.status === 'RETURN_DC_CREATED';

  return (
    <div className="space-y-6 pb-20">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => nav('/procurement/returns')}
            className="rounded-lg border border-slate-300 p-2 hover:bg-slate-100 transition-colors"
          >
            <ArrowLeft className="h-4 w-4 text-slate-600" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900">
                {isNew ? 'New Purchase Return' : `Purchase Return ${head.return_no}`}
              </h1>
              <Badge tone={head.status === 'APPROVED' ? 'emerald' : head.status === 'DRAFT' ? 'slate' : 'indigo'}>
                {head.status}
              </Badge>
              {Boolean(head.stock_posted) && (
                <Badge tone="emerald">Stock Reversed</Badge>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Supplier Material &amp; Job-Work Return Reversal per Developer Specification
            </p>
          </div>
        </div>

        {/* Workflow Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {isDraft && (
            <>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="btn btn-secondary flex items-center gap-1.5"
              >
                <Save className="h-4 w-4" />
                <span>{saving ? 'Saving...' : 'Save Draft'}</span>
              </button>
              {!isNew && (
                <button
                  type="button"
                  onClick={() => handleStatusChange('SUBMITTED')}
                  className="btn btn-primary flex items-center gap-1.5"
                >
                  <Send className="h-4 w-4" />
                  <span>Submit for Approval</span>
                </button>
              )}
            </>
          )}

          {head.status === 'SUBMITTED' && (
            <>
              <button
                type="button"
                onClick={() => handleStatusChange('APPROVED')}
                className="btn btn-primary bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>Approve Return</span>
              </button>
              <button
                type="button"
                onClick={() => handleStatusChange('REJECTED')}
                className="btn btn-secondary text-red-600 hover:bg-red-50 flex items-center gap-1.5"
              >
                <span>Reject</span>
              </button>
            </>
          )}

          {isApproved && (
            <button
              type="button"
              onClick={handleGenerateDC}
              className="btn btn-primary bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5"
            >
              <Truck className="h-4 w-4" />
              <span>Generate Return DC</span>
            </button>
          )}

          {(isDcCreated || (isApproved && !head.stock_posted)) && (
            <button
              type="button"
              onClick={handlePostStock}
              className="btn btn-primary bg-sky-700 hover:bg-sky-800 text-white flex items-center gap-1.5"
            >
              <PackageCheck className="h-4 w-4" />
              <span>Post Stock Reduction</span>
            </button>
          )}
        </div>
      </div>

      {/* Return Header Card */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700 mb-4 flex items-center gap-2">
          <FileText className="h-4 w-4 text-brand-600" />
          <span>Return Header Information</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="label">Return No</label>
            <input
              className="input font-mono font-semibold text-brand-700 bg-slate-50"
              value={head.return_no || 'Auto-generated on save'}
              readOnly
            />
          </div>

          <div>
            <label className="label">Return Date *</label>
            <input
              type="date"
              className="input"
              value={head.return_date || ''}
              onChange={(e) => setHead({ ...head, return_date: e.target.value })}
              disabled={!isDraft}
            />
          </div>

          <div>
            <label className="label">Material Category *</label>
            <select
              className="input font-semibold"
              value={head.material_category}
              onChange={(e) => setHead({ ...head, material_category: e.target.value })}
              disabled={!isDraft || lines.length > 0}
            >
              <option value="FABRIC">🧶 FABRIC Return</option>
              <option value="YARN">🧵 YARN Return</option>
              <option value="TRIM">✂️ TRIMS Return</option>
              <option value="GENERAL">📦 GENERAL Material Return</option>
            </select>
          </div>

          <div>
            <label className="label">Return Type</label>
            <select
              className="input"
              value={head.return_type}
              onChange={(e) => setHead({ ...head, return_type: e.target.value })}
              disabled={!isDraft}
            >
              <option value="FULL">FULL Return</option>
              <option value="PARTIAL">PARTIAL Return</option>
              <option value="QC_REJECTION">QC Rejection</option>
              <option value="EXCESS_RETURN">Excess Return</option>
              <option value="WRONG_MATERIAL">Wrong Material</option>
              <option value="WRONG_SPECIFICATION">Wrong Specification</option>
            </select>
          </div>

          <div>
            <label className="label">Supplier / Vendor *</label>
            <select
              className="input"
              value={head.supplier_id}
              onChange={(e) => setHead({ ...head, supplier_id: e.target.value })}
              disabled={!isDraft}
            >
              <option value="">— Select Supplier —</option>
              {suppliers?.map((s: any) => (
                <option key={s.id} value={s.id}>{s.label || s.party_name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Source GRN Ref (Auto-loads items)</label>
            <select
              className="input font-mono font-medium text-brand-700 bg-amber-50/40 border-amber-300"
              value={head.source_grn_id}
              onChange={(e) => handleGrnSelect(e.target.value)}
              disabled={!isDraft}
            >
              <option value="">— Select Source GRN —</option>
              {grns?.map((g: any) => (
                <option key={g.id} value={g.id}>{g.code || g.label || `GRN #${g.id}`}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Source PO Ref</label>
            <select
              className="input font-mono"
              value={head.source_po_id}
              onChange={(e) => setHead({ ...head, source_po_id: e.target.value })}
              disabled={!isDraft}
            >
              <option value="">— Select PO Ref —</option>
              {purchaseOrders?.map((p: any) => (
                <option key={p.id} value={p.id}>{p.code || p.label || `PO #${p.id}`}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Store / Warehouse *</label>
            <select
              className="input"
              value={head.warehouse_id}
              onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })}
              disabled={!isDraft}
            >
              {warehouses?.map((w: any) => (
                <option key={w.id} value={w.id}>{w.label || w.warehouse_name}</option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="label">Primary Return Reason *</label>
            <select
              className="input font-medium"
              value={head.return_reason}
              onChange={(e) => setHead({ ...head, return_reason: e.target.value })}
              disabled={!isDraft}
            >
              {reasons.map((r: any) => (
                <option key={r.code} value={r.code}>{r.name} {r.requires_qc ? '(QC)' : ''}</option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="label">Remarks / Inspection Notes</label>
            <input
              className="input"
              value={head.remarks || ''}
              onChange={(e) => setHead({ ...head, remarks: e.target.value })}
              placeholder="e.g. Returned due to shade variation in roll R-0043"
              disabled={!isDraft}
            />
          </div>
        </div>
      </div>

      {/* Return Item Grid with Returnable Qty Calculation */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="flex items-center justify-between p-4 bg-slate-50 border-b border-slate-200">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Return Items Grid</h3>
            <p className="text-[11px] text-slate-500">
              Returnable Qty = GRN Received Qty − Previous Returned Qty − Issued Qty
            </p>
          </div>
          {isDraft && (
            <button
              type="button"
              onClick={addEmptyLine}
              className="btn btn-secondary text-xs flex items-center gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Custom Item</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="bg-slate-100/70 text-slate-700 font-semibold border-b border-slate-200 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3">#</th>
                <th className="py-2.5 px-3">Item / Description</th>
                <th className="py-2.5 px-3 text-right">GRN Qty</th>
                <th className="py-2.5 px-3 text-right">Prev Ret</th>
                <th className="py-2.5 px-3 text-right">Issued</th>
                <th className="py-2.5 px-3 text-right text-emerald-800 font-bold bg-emerald-50/50">Returnable</th>
                <th className="py-2.5 px-3 text-right font-bold text-red-700 bg-red-50/50">Return Qty *</th>
                <th className="py-2.5 px-3">UOM</th>
                <th className="py-2.5 px-3 text-right">Rate</th>
                <th className="py-2.5 px-3 text-right">Basic</th>
                <th className="py-2.5 px-3 text-right">GST %</th>
                <th className="py-2.5 px-3 text-right">Total</th>
                <th className="py-2.5 px-3">Reason</th>
                {isDraft && <th className="py-2.5 px-3 text-center">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-sans">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={14} className="py-8 text-center text-slate-400">
                    No items selected. Select a Source GRN above or click &quot;Add Custom Item&quot;.
                  </td>
                </tr>
              ) : (
                lines.map((l, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/60 transition-colors">
                    <td className="py-2 px-3 font-mono font-bold text-slate-400">{idx + 1}</td>
                    <td className="py-2 px-3 font-medium text-slate-900 max-w-xs truncate">
                      {l.item_name || 'Material Item'}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-slate-500">{fmtDecimal(l.grn_qty, 2)}</td>
                    <td className="py-2 px-3 text-right font-mono text-slate-500">{fmtDecimal(l.prev_returned_qty, 2)}</td>
                    <td className="py-2 px-3 text-right font-mono text-slate-500">{fmtDecimal(l.issued_qty, 2)}</td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-emerald-700 bg-emerald-50/30">
                      {fmtDecimal(l.returnable_qty, 2)}
                    </td>
                    <td className="py-2 px-3 text-right bg-red-50/30">
                      <input
                        type="number"
                        step="0.01"
                        className="input text-right font-bold text-red-700 h-8 w-24 py-1 px-2 border-red-300"
                        value={l.return_qty}
                        onChange={(e) => updateLine(idx, { return_qty: Number(e.target.value) })}
                        disabled={!isDraft}
                      />
                    </td>
                    <td className="py-2 px-3 font-mono text-slate-600">{l.uom_code || 'KG'}</td>
                    <td className="py-2 px-3 text-right font-mono">
                      <input
                        type="number"
                        step="0.01"
                        className="input text-right h-8 w-20 py-1 px-2"
                        value={l.rate}
                        onChange={(e) => updateLine(idx, { rate: Number(e.target.value) })}
                        disabled={!isDraft}
                      />
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-slate-700">{fmtDecimal(l.basic_amount, 2)}</td>
                    <td className="py-2 px-3 text-right font-mono text-slate-500">{l.gst_percent}%</td>
                    <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">{fmtDecimal(l.total_amount, 2)}</td>
                    <td className="py-2 px-3 max-w-[140px]">
                      <select
                        className="input text-[11px] h-8 py-0 px-1"
                        value={l.reason || head.return_reason}
                        onChange={(e) => updateLine(idx, { reason: e.target.value })}
                        disabled={!isDraft}
                      >
                        {reasons.map((r: any) => (
                          <option key={r.code} value={r.code}>{r.name}</option>
                        ))}
                      </select>
                    </td>
                    {isDraft && (
                      <td className="py-2 px-3 text-center">
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          className="text-red-500 hover:text-red-700 p-1"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Dynamic Category Tracking Fields Section */}
        {lines.length > 0 && (
          <div className="p-4 bg-slate-50/50 border-t border-slate-200">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-3 flex items-center gap-2">
              <Layers className="h-3.5 w-3.5 text-brand-600" />
              <span>Category Tracking Specifics ({head.material_category})</span>
            </h4>

            <div className="space-y-3">
              {lines.map((l, idx) => (
                <div key={idx} className="p-3 bg-white border border-slate-200 rounded-lg text-xs space-y-2">
                  <div className="font-semibold text-slate-800">
                    Line #{idx + 1}: {l.item_name}
                  </div>

                  {head.material_category === 'YARN' && (
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      <div>
                        <label className="text-[11px] text-slate-500">Lot No</label>
                        <input
                          className="input h-8 text-xs font-mono"
                          value={l.lot_no || ''}
                          onChange={(e) => updateLine(idx, { lot_no: e.target.value })}
                          placeholder="Yarn Lot"
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Dye Lot No</label>
                        <input
                          className="input h-8 text-xs font-mono"
                          value={l.dye_lot_no || ''}
                          onChange={(e) => updateLine(idx, { dye_lot_no: e.target.value })}
                          placeholder="Dye Lot"
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Bags</label>
                        <input
                          type="number"
                          className="input h-8 text-xs"
                          value={l.bag_count || ''}
                          onChange={(e) => updateLine(idx, { bag_count: Number(e.target.value) })}
                          placeholder="Bags count"
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Cones / Packages</label>
                        <input
                          type="number"
                          className="input h-8 text-xs"
                          value={l.cone_count || ''}
                          onChange={(e) => updateLine(idx, { cone_count: Number(e.target.value) })}
                          placeholder="Cones count"
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Return Weight (Kg)</label>
                        <input
                          type="number"
                          step="0.01"
                          className="input h-8 text-xs font-mono font-bold text-brand-700"
                          value={l.return_qty}
                          onChange={(e) => updateLine(idx, { return_qty: Number(e.target.value) })}
                          disabled={!isDraft}
                        />
                      </div>
                    </div>
                  )}

                  {head.material_category === 'FABRIC' && (
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      <div>
                        <label className="text-[11px] text-slate-500">Roll No / Barcode</label>
                        <input
                          className="input h-8 text-xs font-mono"
                          value={l.roll_no || ''}
                          onChange={(e) => updateLine(idx, { roll_no: e.target.value })}
                          placeholder="Roll No"
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Batch / Dye Lot</label>
                        <input
                          className="input h-8 text-xs font-mono"
                          value={l.dye_lot_no || l.batch_no || ''}
                          onChange={(e) => updateLine(idx, { dye_lot_no: e.target.value, batch_no: e.target.value })}
                          placeholder="Dye Lot"
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">GSM</label>
                        <input
                          className="input h-8 text-xs"
                          value={l.gsm || ''}
                          onChange={(e) => updateLine(idx, { gsm: e.target.value })}
                          placeholder="180"
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Dia / Width</label>
                        <input
                          className="input h-8 text-xs"
                          value={l.dia || ''}
                          onChange={(e) => updateLine(idx, { dia: e.target.value })}
                          placeholder="30 Inch"
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Return Weight (Kg)</label>
                        <input
                          type="number"
                          step="0.01"
                          className="input h-8 text-xs font-mono font-bold text-brand-700"
                          value={l.return_qty}
                          onChange={(e) => updateLine(idx, { return_qty: Number(e.target.value) })}
                          disabled={!isDraft}
                        />
                      </div>
                    </div>
                  )}

                  {head.material_category === 'TRIM' && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <label className="text-[11px] text-slate-500">Batch No</label>
                        <input
                          className="input h-8 text-xs font-mono"
                          value={l.batch_no || ''}
                          onChange={(e) => updateLine(idx, { batch_no: e.target.value })}
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Size / Dimension</label>
                        <input
                          className="input h-8 text-xs"
                          value={l.size || ''}
                          onChange={(e) => updateLine(idx, { size: e.target.value })}
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Colour / Shade</label>
                        <input
                          className="input h-8 text-xs"
                          value={l.dye_lot_no || ''}
                          onChange={(e) => updateLine(idx, { dye_lot_no: e.target.value })}
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Return Qty</label>
                        <input
                          type="number"
                          className="input h-8 text-xs font-mono font-bold text-brand-700"
                          value={l.return_qty}
                          onChange={(e) => updateLine(idx, { return_qty: Number(e.target.value) })}
                          disabled={!isDraft}
                        />
                      </div>
                    </div>
                  )}

                  {head.material_category === 'GENERAL' && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <label className="text-[11px] text-slate-500">Batch / Serial No</label>
                        <input
                          className="input h-8 text-xs font-mono"
                          value={l.batch_no || ''}
                          onChange={(e) => updateLine(idx, { batch_no: e.target.value })}
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Department</label>
                        <input
                          className="input h-8 text-xs"
                          value={l.department || ''}
                          onChange={(e) => updateLine(idx, { department: e.target.value })}
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Expiry Date</label>
                        <input
                          type="date"
                          className="input h-8 text-xs"
                          value={l.expiry_date || ''}
                          onChange={(e) => updateLine(idx, { expiry_date: e.target.value })}
                          disabled={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500">Return Qty</label>
                        <input
                          type="number"
                          className="input h-8 text-xs font-mono font-bold text-brand-700"
                          value={l.return_qty}
                          onChange={(e) => updateLine(idx, { return_qty: Number(e.target.value) })}
                          disabled={!isDraft}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Financial Footer */}
        <div className="p-4 bg-slate-100/60 border-t border-slate-200 flex flex-wrap justify-between items-center gap-4">
          <div className="text-xs text-slate-600">
            Total Items: <span className="font-bold text-slate-900">{lines.length}</span> | Total Return Quantity: <span className="font-bold text-brand-700">{fmtDecimal(totalReturnQty, 2)}</span>
          </div>
          <div className="flex items-center gap-6 text-xs">
            <div>Taxable Basic: <span className="font-mono font-bold text-slate-800">₹{fmtDecimal(totalBasic, 2)}</span></div>
            <div>GST: <span className="font-mono font-bold text-slate-800">₹{fmtDecimal(totalGst, 2)}</span></div>
            <div className="text-sm bg-white px-3 py-1.5 rounded-lg border border-slate-200">
              Net Return Value: <span className="font-mono font-bold text-brand-700">₹{fmtDecimal(grandTotal, 2)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Multiple Job + Multiple Style Allocation Section (Section 12 & 13) */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800 flex items-center gap-2">
              <Building2 className="h-4 w-4 text-brand-600" />
              <span>Job No &amp; Style Allocation (Section 13)</span>
            </h3>
            <p className="text-xs text-slate-500">Allocate returned quantities against specific factory Jobs and Styles.</p>
          </div>
          {isDraft && lines.length > 0 && (
            <button
              type="button"
              onClick={() => addAllocation(0)}
              className="btn btn-secondary text-xs flex items-center gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Allocation</span>
            </button>
          )}
        </div>

        {allocations.length === 0 ? (
          <p className="text-xs text-slate-400 italic py-2">No Job/Style allocations added.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-2 px-3">Target Line Item</th>
                  <th className="py-2 px-3">Job No</th>
                  <th className="py-2 px-3">Style No</th>
                  <th className="py-2 px-3 text-right">Allocated Qty</th>
                  <th className="py-2 px-3">Remarks</th>
                  {isDraft && <th className="py-2 px-3 text-center">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {allocations.map((a, idx) => (
                  <tr key={idx}>
                    <td className="py-2 px-3">
                      <select
                        className="input h-8 text-xs py-0"
                        value={a.line_index}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setAllocations((prev) => prev.map((x, i) => i === idx ? { ...x, line_index: val } : x));
                        }}
                        disabled={!isDraft}
                      >
                        {lines.map((l, lIdx) => (
                          <option key={lIdx} value={lIdx}>Line #{lIdx + 1}: {l.item_name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 px-3">
                      <input
                        className="input h-8 text-xs font-mono"
                        value={a.job_no}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAllocations((prev) => prev.map((x, i) => i === idx ? { ...x, job_no: val } : x));
                        }}
                        placeholder="e.g. JOB-1001"
                        disabled={!isDraft}
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        className="input h-8 text-xs font-mono"
                        value={a.style_no}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAllocations((prev) => prev.map((x, i) => i === idx ? { ...x, style_no: val } : x));
                        }}
                        placeholder="e.g. ST-101"
                        disabled={!isDraft}
                      />
                    </td>
                    <td className="py-2 px-3 text-right">
                      <input
                        type="number"
                        step="0.01"
                        className="input h-8 w-24 text-right font-mono font-semibold"
                        value={a.allocated_qty}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setAllocations((prev) => prev.map((x, i) => i === idx ? { ...x, allocated_qty: val } : x));
                        }}
                        disabled={!isDraft}
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        className="input h-8 text-xs"
                        value={a.remarks || ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAllocations((prev) => prev.map((x, i) => i === idx ? { ...x, remarks: val } : x));
                        }}
                        placeholder="Allocation notes"
                        disabled={!isDraft}
                      />
                    </td>
                    {isDraft && (
                      <td className="py-2 px-3 text-center">
                        <button
                          type="button"
                          onClick={() => removeAllocation(idx)}
                          className="text-red-500 hover:text-red-700"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Return DC & Outward Gate Pass Section (Section 16) */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800 mb-4 flex items-center gap-2">
          <Truck className="h-4 w-4 text-brand-600" />
          <span>Return DC (Delivery Challan) &amp; Logistics (Section 16)</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="label">Return DC No</label>
            <input
              className="input font-mono font-bold text-slate-700 bg-slate-50"
              value={head.return_dc_no || 'Auto-generated upon DC approval'}
              readOnly
            />
          </div>
          <div>
            <label className="label">Return DC Date</label>
            <input
              type="date"
              className="input"
              value={head.return_dc_date || ''}
              onChange={(e) => setHead({ ...head, return_dc_date: e.target.value })}
            />
          </div>
          <div>
            <label className="label">E-Way Bill No</label>
            <input
              className="input font-mono"
              value={head.eway_bill_no || ''}
              onChange={(e) => setHead({ ...head, eway_bill_no: e.target.value })}
              placeholder="e.g. 181234567890"
            />
          </div>
          <div>
            <label className="label">Transporter Name</label>
            <input
              className="input"
              value={head.transporter_name || ''}
              onChange={(e) => setHead({ ...head, transporter_name: e.target.value })}
              placeholder="Transport Agency"
            />
          </div>
          <div>
            <label className="label">Vehicle No</label>
            <input
              className="input font-mono uppercase"
              value={head.vehicle_no || ''}
              onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })}
              placeholder="TN 38 AB 1234"
            />
          </div>
          <div>
            <label className="label">Driver Name</label>
            <input
              className="input"
              value={head.driver_name || ''}
              onChange={(e) => setHead({ ...head, driver_name: e.target.value })}
              placeholder="Driver Name"
            />
          </div>
        </div>
      </div>

      {/* Commercial & Supplier Credit Note Section (Section 27) */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800 mb-4 flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-brand-600" />
          <span>Commercial &amp; Credit Note Reference (Section 27)</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Supplier Credit Note Ref</label>
            <input
              className="input font-mono"
              value={head.credit_note_ref || ''}
              onChange={(e) => setHead({ ...head, credit_note_ref: e.target.value })}
              placeholder="e.g. CN-2026-891"
            />
          </div>
          <div>
            <label className="label">Credit Note Date</label>
            <input
              type="date"
              className="input"
              value={head.credit_note_date || ''}
              onChange={(e) => setHead({ ...head, credit_note_date: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Credit Note Value (₹)</label>
            <input
              type="number"
              step="0.01"
              className="input font-mono font-bold text-slate-800"
              value={head.credit_note_amount || grandTotal}
              onChange={(e) => setHead({ ...head, credit_note_amount: Number(e.target.value) })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
