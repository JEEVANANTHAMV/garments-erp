import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Save, PackageCheck, Plus, Trash2, Disc
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, Badge } from '../../components/ui';
import { fmtDecimal, today } from '../../lib/format';

interface YarnGrnLine {
  _key: string;
  id?: number;
  po_line_id?: number;
  yarn_id: string | number;
  yarn_name?: string;
  yarn_type: string;
  composition?: string;
  lot_no: string;
  po_qty: number;
  received_qty: number; // in KG
  packs: number; // in bags/packs
  accepted_qty: number;
  rejected_qty: number;
  hold_qty: number;
  balance_qty: number;
  rate: number;
  qc_status: string;
}

let yglSeq = 0;
const emptyYarnGrnLine = (): YarnGrnLine => ({
  _key: `ygl_${++yglSeq}`,
  yarn_id: '',
  yarn_type: 'Grey Yarn',
  lot_no: 'LOT-Y-001',
  po_qty: 2268,
  received_qty: 2268,
  packs: 50,
  accepted_qty: 2268,
  rejected_qty: 0,
  hold_qty: 0,
  balance_qty: 0,
  rate: 220.0,
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
  const styles = useLookup('styles');
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

  // Header State
  const [header, setHeader] = useState({
    grn_no: '',
    grn_date: today(),
    po_id: '',
    gate_inward_id: '',
    internal_ir_no: 'IR-2026-0001',
    supplier_id: '',
    warehouse_id: '1',
    style_id: '',
    supplier_dc_no: '',
    supplier_inv_no: '',
    vehicle_no: '',
    qc_status: 'ACCEPTED',
    remarks: '',
  });

  const [lines, setLines] = useState<YarnGrnLine[]>([emptyYarnGrnLine()]);

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
        remarks: existingData.remarks || '',
      });

      if (existingData.lines?.length) {
        const loadedLines: YarnGrnLine[] = existingData.lines.map((l: any) => ({
          _key: `ygl_${l.id}`,
          id: l.id,
          po_line_id: l.po_line_id,
          yarn_id: l.yarn_id,
          yarn_name: l.yarn_name,
          yarn_type: l.yarn_type || 'Grey Yarn',
          composition: l.composition,
          lot_no: l.lot_no || 'LOT-1',
          po_qty: Number(l.received_qty) + Number(l.balance_qty || 0),
          received_qty: Number(l.received_qty || 0),
          packs: Number(l.no_of_rolls || 1),
          accepted_qty: Number(l.accepted_qty || l.received_qty || 0),
          rejected_qty: Number(l.rejected_qty || 0),
          hold_qty: Number(l.hold_qty || 0),
          balance_qty: Number(l.balance_qty || 0),
          rate: Number(l.rate || 0),
          qc_status: l.qc_status || 'ACCEPTED',
        }));
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

  // Handle PO selection
  const handleSelectPO = async (poIdStr: string) => {
    setHeader((prev) => ({ ...prev, po_id: poIdStr }));
    if (!poIdStr) return;

    try {
      const res = await http.get<{ data: any }>(`/purchase-orders/${poIdStr}`);
      const po = res.data;
      if (po) {
        setHeader((prev) => ({
          ...prev,
          po_id: poIdStr,
          supplier_id: po.supplier_id ? String(po.supplier_id) : prev.supplier_id,
          internal_ir_no: po.internal_ir_no || prev.internal_ir_no,
          style_id: po.style_id ? String(po.style_id) : prev.style_id,
        }));

        if (po.lines?.length) {
          const poLines = po.lines.filter(
            (l: any) => l.material_type === 'YARN' || l.yarn_id
          );
          if (poLines.length > 0) {
            const mappedLines: YarnGrnLine[] = poLines.map((pl: any) => {
              const qty = Number(pl.qty) || 2268;
              const bags = Number(pl.packs) || Math.round(qty / 45.36) || 50;

              return {
                _key: `ygl_${++yglSeq}`,
                po_line_id: pl.id,
                yarn_id: pl.yarn_id,
                yarn_name: pl.yarn_name,
                yarn_type: pl.yarn_type || 'Grey Yarn',
                composition: pl.composition,
                lot_no: 'LOT-Y-01',
                po_qty: qty,
                received_qty: qty,
                packs: bags,
                accepted_qty: qty,
                rejected_qty: 0,
                hold_qty: 0,
                balance_qty: 0,
                rate: Number(pl.rate) || 0,
                qc_status: 'ACCEPTED',
              };
            });
            setLines(mappedLines);
            toast(`Loaded ${mappedLines.length} yarn items from ${po.po_no}`, 'info');
          }
        }
      }
    } catch {
      toast('Failed to load PO details', 'error');
    }
  };

  // Recalculate line quantities
  const updateLine = (idx: number, updates: Partial<YarnGrnLine>) => {
    setLines((prev) => {
      const copy = [...prev];
      const cur = { ...copy[idx], ...updates };

      const rec = Number(cur.received_qty) || 0;
      const rej = Number(cur.rejected_qty) || 0;
      const hold = Number(cur.hold_qty) || 0;
      cur.accepted_qty = Math.max(0, rec - rej - hold);
      cur.balance_qty = Math.max(0, Number(cur.po_qty) - cur.accepted_qty);

      copy[idx] = cur;
      return copy;
    });
  };

  const totals = useMemo(() => {
    const totalKg = lines.reduce((s, l) => s + (Number(l.received_qty) || 0), 0);
    const acceptedKg = lines.reduce((s, l) => s + (Number(l.accepted_qty) || 0), 0);
    const totalPacks = lines.reduce((s, l) => s + (Number(l.packs) || 0), 0);
    return { totalKg, acceptedKg, totalPacks };
  }, [lines]);

  const handleSave = async () => {
    if (!header.supplier_id) {
      toast('Please select a spinning mill / supplier', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...header,
        lines: lines.map((l) => ({
          po_line_id: l.po_line_id,
          yarn_id: l.yarn_id,
          received_qty: l.received_qty,
          packs: l.packs,
          accepted_qty: l.accepted_qty,
          rejected_qty: l.rejected_qty,
          hold_qty: l.hold_qty,
          balance_qty: l.balance_qty,
          lot_no: l.lot_no,
          qc_status: l.qc_status,
          rate: l.rate,
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
              Weighed KG gross/tare receipt, bag counting, lot verification, and stock ledger posting
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
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

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-3 bg-amber-50/60 rounded-xl border border-amber-200">
          <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider">Total Weighed (KG)</div>
          <div className="text-xl font-bold text-amber-900 mt-0.5">{fmtDecimal(totals.totalKg)} KG</div>
        </div>
        <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-200">
          <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">Accepted Net Qty</div>
          <div className="text-xl font-bold text-emerald-900 mt-0.5">{fmtDecimal(totals.acceptedKg)} KG</div>
        </div>
        <div className="p-3 bg-indigo-50/60 rounded-xl border border-indigo-200">
          <div className="text-[11px] font-semibold text-indigo-700 uppercase tracking-wider">Bags / Packs Count</div>
          <div className="text-xl font-bold text-indigo-900 mt-0.5">{totals.totalPacks} Bags</div>
        </div>
      </div>

      {/* Header Fields Card */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-4">
        <div className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-1.5 pb-2 border-b border-slate-100">
          <Disc size={14} className="text-amber-600" />
          <span>Receipt Header Information</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {isNew ? (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Link to Yarn PO (Optional)
              </label>
              <select
                value={header.po_id}
                onChange={(e) => handleSelectPO(e.target.value)}
                className="w-full text-xs rounded-lg border border-slate-300 py-1.5 px-2 focus:border-amber-500"
              >
                <option value="">-- Direct Yarn Receipt --</option>
                {poList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.po_no} ({p.supplier_name || 'Mill'})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <Input label="GRN No" value={header.grn_no} disabled />
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
                {((gateInwards.data as any[]) || []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.code || g.label} {g.vehicle_no ? `(${g.vehicle_no})` : ''}
                  </option>
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

          <Input
            label="GRN Date"
            type="date"
            value={header.grn_date}
            onChange={(e) => setHeader((p) => ({ ...p, grn_date: e.target.value }))}
            disabled={!isNew}
          />

          <Select
            label="Spinning Mill / Supplier *"
            value={header.supplier_id}
            onChange={(e) => setHeader((p) => ({ ...p, supplier_id: e.target.value }))}
            options={toOptions(suppliers.data)}
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
            label="Internal / IR No"
            value={header.internal_ir_no}
            onChange={(e) => setHeader((p) => ({ ...p, internal_ir_no: e.target.value }))}
            disabled={!isNew}
          />

          <Select
            label="Style No"
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
              <Disc size={14} className="text-amber-600" />
              <span>Yarn Inward Items ({lines.length})</span>
            </h2>
            <p className="text-[11px] text-slate-400">
              Record weighed KG, bags/packs, cone lot batch, and acceptance values
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
                <th className="py-2.5 px-3">Yarn Item</th>
                <th className="py-2.5 px-2">Type</th>
                <th className="py-2.5 px-2">Lot / Batch No</th>
                <th className="py-2.5 px-2 text-right">PO Qty (KG)</th>
                <th className="py-2.5 px-2 text-right">Weighed Rec (KG) *</th>
                <th className="py-2.5 px-2 text-center">Bags / Packs</th>
                <th className="py-2.5 px-2 text-right">Accepted (KG)</th>
                <th className="py-2.5 px-2 text-right">Rejected (KG)</th>
                <th className="py-2.5 px-2 text-right">Hold (KG)</th>
                <th className="py-2.5 px-2 text-right">Balance (KG)</th>
                <th className="py-2.5 px-2 text-center">QC</th>
                {isNew && <th className="py-2.5 px-2 text-center">Del</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {lines.map((l, idx) => (
                <tr key={l._key || idx} className="hover:bg-slate-50/70 transition">
                  <td className="py-2.5 px-3 min-w-[140px]">
                    {isNew ? (
                      <select
                        value={l.yarn_id}
                        onChange={(e) => updateLine(idx, { yarn_id: e.target.value })}
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
                  <td className="py-2.5 px-2 text-slate-600">{l.yarn_type}</td>
                  <td className="py-2.5 px-2">
                    {isNew ? (
                      <input
                        type="text"
                        value={l.lot_no}
                        onChange={(e) => updateLine(idx, { lot_no: e.target.value })}
                        className="w-24 text-xs font-mono border border-slate-300 rounded px-1.5 py-1"
                      />
                    ) : (
                      <span className="font-mono text-slate-700">{l.lot_no}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right text-slate-500">{fmtDecimal(l.po_qty)}</td>
                  <td className="py-2.5 px-2 text-right">
                    {isNew ? (
                      <input
                        type="number"
                        value={l.received_qty}
                        onChange={(e) =>
                          updateLine(idx, { received_qty: parseFloat(e.target.value) || 0 })
                        }
                        className="w-24 text-xs text-right font-bold text-amber-700 border border-slate-300 rounded px-1.5 py-1"
                      />
                    ) : (
                      <span className="font-bold text-amber-700">{fmtDecimal(l.received_qty)} KG</span>
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
                        className="w-16 text-xs text-center border border-slate-300 rounded px-1 py-1"
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
                        value={l.rejected_qty}
                        onChange={(e) =>
                          updateLine(idx, { rejected_qty: parseFloat(e.target.value) || 0 })
                        }
                        className="w-16 text-xs text-right text-red-600 border border-slate-300 rounded px-1 py-1"
                      />
                    ) : (
                      <span className="text-red-600">{fmtDecimal(l.rejected_qty)}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right">
                    {isNew ? (
                      <input
                        type="number"
                        value={l.hold_qty}
                        onChange={(e) =>
                          updateLine(idx, { hold_qty: parseFloat(e.target.value) || 0 })
                        }
                        className="w-16 text-xs text-right text-amber-600 border border-slate-300 rounded px-1 py-1"
                      />
                    ) : (
                      <span className="text-amber-600">{fmtDecimal(l.hold_qty)}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right text-slate-500">{fmtDecimal(l.balance_qty)}</td>
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
                      >
                        <Trash2 size={13} />
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
