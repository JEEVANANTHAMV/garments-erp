import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Plus, Trash2, PackageCheck
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Badge } from '../../components/ui';

interface GrnLine {
  _key: string;
  id?: number;
  po_line_id?: number;
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
  supplier_lot_no: string;
  internal_lot_no: string;
  bin_location: string;
  qc_status: 'ACCEPTED' | 'PARTIAL' | 'REJECTED' | 'HOLD';
  rejection_reason: string;
}

let glseq = 0;
const emptyGrnLine = (): GrnLine => ({
  _key: `tgl_${++glseq}`,
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
    io_no: 'IO-2026-001',
    style_id: '',
    supplier_id: '',
    warehouse_id: '1',
    supplier_inv_no: 'INV-2026-889',
    supplier_dc_no: 'DC-4421',
    vehicle_no: 'TN-39-AB-1234',
    status: 'POSTED',
    remarks: '',
  });

  const [lines, setLines] = useState<GrnLine[]>([emptyGrnLine()]);

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
        io_no: existingGrn.io_no,
        style_id: String(existingGrn.style_id || ''),
        supplier_id: String(existingGrn.supplier_id || ''),
        warehouse_id: String(existingGrn.warehouse_id || '1'),
        supplier_inv_no: existingGrn.supplier_inv_no || '',
        supplier_dc_no: existingGrn.supplier_dc_no || '',
        vehicle_no: existingGrn.vehicle_no || '',
        status: existingGrn.status || 'POSTED',
        remarks: existingGrn.remarks || '',
      });

      if (existingGrn.lines?.length) {
        setLines(
          existingGrn.lines.map((l: any) => ({
            _key: `tgl_${++glseq}`,
            id: l.id,
            po_line_id: l.po_line_id,
            trim_id: l.trim_id,
            trim_name: l.trim_name,
            specification: l.specification || '',
            color_name: l.color_name || '',
            trim_size: l.trim_size || '',
            uom_id: l.uom_id,
            po_qty: Number(l.po_qty),
            received_qty: Number(l.received_qty),
            accepted_qty: Number(l.accepted_qty),
            rejected_qty: Number(l.rejected_qty),
            hold_qty: Number(l.hold_qty),
            supplier_lot_no: l.supplier_lot_no || '',
            internal_lot_no: l.internal_lot_no,
            bin_location: l.bin_location || '',
            qc_status: l.qc_status || 'ACCEPTED',
            rejection_reason: l.rejection_reason || '',
          }))
        );
      }
    }
  }, [existingGrn]);

  // Handle PO selection: pull lines and auto-fill
  const handlePoSelect = async (poId: string) => {
    setHead((prev) => ({ ...prev, po_id: poId }));
    if (!poId) return;

    try {
      const res = await http.get<{ data: any }>(`/trim-pos/${poId}`);
      const po = res.data;
      if (po) {
        setHead((prev) => ({
          ...prev,
          io_no: po.io_no || prev.io_no,
          style_id: String(po.style_id || prev.style_id),
          supplier_id: String(po.supplier_id || prev.supplier_id),
        }));

        if (po.lines?.length) {
          setLines(
            po.lines.map((l: any, i: number) => {
              const pending = Math.max(0, Number(l.order_qty) - Number(l.received_qty || 0));
              return {
                _key: `tgl_${++glseq}`,
                po_line_id: l.id,
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
                supplier_lot_no: '',
                internal_lot_no: `TLOT-${Date.now().toString().slice(-5)}${i + 1}`,
                bin_location: 'BIN-T01',
                qc_status: 'ACCEPTED',
                rejection_reason: '',
              };
            })
          );
        }
      }
    } catch {
      // ignore
    }
  };

  const updateLine = (idx: number, patch: Partial<GrnLine>) => {
    setLines((prev) => {
      const copy = [...prev];
      const cur = { ...copy[idx], ...patch };

      // Auto-recalculate accepted if received changed
      if ('received_qty' in patch && !('accepted_qty' in patch)) {
        cur.accepted_qty = Math.max(0, Number(cur.received_qty) - (Number(cur.rejected_qty) + Number(cur.hold_qty)));
      }

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
    return { totalReceived, totalAccepted, totalRejected, totalHold };
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
        po_id: head.po_id ? Number(head.po_id) : null,
        style_id: head.style_id ? Number(head.style_id) : null,
        supplier_id: Number(head.supplier_id),
        warehouse_id: Number(head.warehouse_id),
        lines: lines.map((l) => ({
          po_line_id: l.po_line_id || null,
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
            </div>
            <p className="text-xs text-slate-500">
              Goods receipt note with QC inspection, lot tracking & unrestricted inventory posting
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

      {/* Header Form */}
      <div className="card p-5 space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 border-b border-slate-100 pb-2">
          Receipt Details & Order Reference
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          {isNew && (
            <div>
              <label className="label">Link with Trim PO (Optional)</label>
              <select
                value={head.po_id}
                onChange={(e) => handlePoSelect(e.target.value)}
                className="input text-xs font-semibold text-indigo-700"
              >
                <option value="">-- Direct Receipt or Select PO --</option>
                {availablePos.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.po_no} ({p.supplier_name}) - {p.io_no}
                  </option>
                ))}
              </select>
            </div>
          )}
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
            <label className="label">Style Reference</label>
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
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs">
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
          <div>
            <label className="label">Supplier Invoice No</label>
            <input
              type="text"
              disabled={!isNew}
              value={head.supplier_inv_no}
              onChange={(e) => setHead({ ...head, supplier_inv_no: e.target.value })}
              className="input text-xs"
              placeholder="INV-001"
            />
          </div>
          <div>
            <label className="label">Supplier DC / Challan No</label>
            <input
              type="text"
              disabled={!isNew}
              value={head.supplier_dc_no}
              onChange={(e) => setHead({ ...head, supplier_dc_no: e.target.value })}
              className="input text-xs"
              placeholder="DC-001"
            />
          </div>
        </div>
      </div>

      {/* QC Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="card p-3 bg-indigo-50/50 border border-indigo-100">
          <span className="text-slate-500 block text-[11px]">Total Received Qty</span>
          <span className="text-lg font-bold text-indigo-900">{fmtDecimal(totals.totalReceived)}</span>
        </div>
        <div className="card p-3 bg-emerald-50/50 border border-emerald-100">
          <span className="text-slate-500 block text-[11px]">QC Accepted (Unrestricted Stock)</span>
          <span className="text-lg font-bold text-emerald-700">+{fmtDecimal(totals.totalAccepted)}</span>
        </div>
        <div className="card p-3 bg-red-50/50 border border-red-100">
          <span className="text-slate-500 block text-[11px]">QC Rejected Qty</span>
          <span className="text-lg font-bold text-red-700">{fmtDecimal(totals.totalRejected)}</span>
        </div>
        <div className="card p-3 bg-amber-50/50 border border-amber-100">
          <span className="text-slate-500 block text-[11px]">QC Hold / Quarantine</span>
          <span className="text-lg font-bold text-amber-700">{fmtDecimal(totals.totalHold)}</span>
        </div>
      </div>

      {/* Lines Table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-50/70 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">Received Items & QC Split</h3>
            <p className="text-[11px] text-slate-500">Only Accepted Qty enters unrestricted inventory stock</p>
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
                <th className="py-2.5 px-3 text-left w-44">Trim Item *</th>
                <th className="py-2.5 px-3 text-left w-32">Internal Lot No *</th>
                <th className="py-2.5 px-3 text-right w-20">PO Qty</th>
                <th className="py-2.5 px-3 text-right w-24">Received *</th>
                <th className="py-2.5 px-3 text-right w-24">Accepted *</th>
                <th className="py-2.5 px-3 text-right w-20">Rejected</th>
                <th className="py-2.5 px-3 text-right w-20">Hold</th>
                <th className="py-2.5 px-3 text-left w-24">Bin</th>
                <th className="py-2.5 px-3 text-center w-24">QC Status</th>
                <th className="py-2.5 px-3 text-left w-36">Remarks / Reason</th>
                {isNew && <th className="py-2.5 px-3 text-center w-12">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((line, idx) => (
                <tr key={line._key} className="hover:bg-slate-50/50">
                  <td className="py-2 px-3">
                    {isNew ? (
                      <select
                        value={line.trim_id}
                        onChange={(e) => updateLine(idx, { trim_id: e.target.value })}
                        className="input text-xs py-1"
                      >
                        <option value="">-- Select Trim --</option>
                        {trims.map((t: any) => (
                          <option key={t.id} value={t.id}>{t.trim_name} ({t.trim_type})</option>
                        ))}
                      </select>
                    ) : (
                      <span className="font-semibold text-slate-900">{line.trim_name}</span>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      disabled={!isNew}
                      value={line.internal_lot_no}
                      onChange={(e) => updateLine(idx, { internal_lot_no: e.target.value })}
                      className="input text-xs py-1 font-mono font-semibold text-indigo-700"
                    />
                  </td>
                  <td className="py-2 px-3 text-right font-medium text-slate-500">
                    {fmtDecimal(line.po_qty)}
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      disabled={!isNew}
                      value={line.received_qty}
                      onChange={(e) => updateLine(idx, { received_qty: Number(e.target.value) })}
                      className="input text-xs py-1 text-right font-bold text-slate-900"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      disabled={!isNew}
                      value={line.accepted_qty}
                      onChange={(e) => updateLine(idx, { accepted_qty: Number(e.target.value) })}
                      className="input text-xs py-1 text-right font-bold text-emerald-700"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      disabled={!isNew}
                      value={line.rejected_qty}
                      onChange={(e) => updateLine(idx, { rejected_qty: Number(e.target.value) })}
                      className="input text-xs py-1 text-right font-medium text-red-600"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="number"
                      disabled={!isNew}
                      value={line.hold_qty}
                      onChange={(e) => updateLine(idx, { hold_qty: Number(e.target.value) })}
                      className="input text-xs py-1 text-right font-medium text-amber-600"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      disabled={!isNew}
                      value={line.bin_location}
                      onChange={(e) => updateLine(idx, { bin_location: e.target.value })}
                      placeholder="BIN-A1"
                      className="input text-xs py-1 font-mono"
                    />
                  </td>
                  <td className="py-2 px-3 text-center">
                    <Badge variant={line.qc_status === 'ACCEPTED' ? 'success' : line.qc_status === 'HOLD' ? 'warning' : 'danger'}>
                      {line.qc_status}
                    </Badge>
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      disabled={!isNew}
                      value={line.rejection_reason}
                      onChange={(e) => updateLine(idx, { rejection_reason: e.target.value })}
                      placeholder="Defects or remarks"
                      className="input text-xs py-1"
                    />
                  </td>
                  {isNew && (
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
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
