import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Save, PackageCheck, Plus, Trash2, Layers,
  Boxes, Sparkles, Info
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, Badge, Modal } from '../../components/ui';
import { fmtDecimal, today } from '../../lib/format';

interface PhysicalRoll {
  _key?: string;
  id?: number;
  roll_no: string;
  lot_no: string;
  meters: number;
  weight_kg: number;
  gsm: number;
  dia: string;
  shade: string;
  location_bin: string;
  qc_status: 'ACCEPTED' | 'CONDITIONAL' | 'REJECTED';
  remarks?: string;
}

interface GrnLineItem {
  _key: string;
  id?: number;
  po_line_id?: number;
  fabric_id: string | number;
  fabric_name?: string;
  fabric_type: string;
  shade_code: string;
  lot_no: string;
  po_qty: number;
  received_qty: number; // in meters
  received_weight: number; // in kg
  no_of_rolls: number;
  accepted_qty: number;
  rejected_qty: number;
  hold_qty: number;
  balance_qty: number;
  rate: number;
  qc_status: string;
  uom_id: number;
  rolls: PhysicalRoll[];
}

let lineSeq = 0;
const emptyLine = (): GrnLineItem => ({
  _key: `fgl_${++lineSeq}`,
  fabric_id: '',
  fabric_type: 'Knitted',
  shade_code: 'NVY-01',
  lot_no: 'LOT-2026-01',
  po_qty: 1000,
  received_qty: 1000,
  received_weight: 250,
  no_of_rolls: 5,
  accepted_qty: 1000,
  rejected_qty: 0,
  hold_qty: 0,
  balance_qty: 0,
  rate: 65.0,
  qc_status: 'ACCEPTED',
  uom_id: 9,
  rolls: [
    { roll_no: 'R-01', lot_no: 'LOT-2026-01', meters: 200, weight_kg: 50, gsm: 180, dia: '30"', shade: 'NVY-01', location_bin: 'A-01', qc_status: 'ACCEPTED' },
    { roll_no: 'R-02', lot_no: 'LOT-2026-01', meters: 200, weight_kg: 50, gsm: 180, dia: '30"', shade: 'NVY-01', location_bin: 'A-02', qc_status: 'ACCEPTED' },
    { roll_no: 'R-03', lot_no: 'LOT-2026-01', meters: 200, weight_kg: 50, gsm: 180, dia: '30"', shade: 'NVY-01', location_bin: 'A-03', qc_status: 'ACCEPTED' },
    { roll_no: 'R-04', lot_no: 'LOT-2026-01', meters: 200, weight_kg: 50, gsm: 180, dia: '30"', shade: 'NVY-01', location_bin: 'A-04', qc_status: 'ACCEPTED' },
    { roll_no: 'R-05', lot_no: 'LOT-2026-01', meters: 200, weight_kg: 50, gsm: 180, dia: '30"', shade: 'NVY-01', location_bin: 'A-05', qc_status: 'ACCEPTED' },
  ],
});

export default function FabricGRNDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();

  const suppliers = useLookup('suppliers');
  const warehouses = useLookup('warehouses');
  const fabrics = useLookup('fabrics');
  const styles = useLookup('styles');
  const gateInwards = useLookup('gate-inwards');

  // Load PO options for linking
  const { data: poList = [] } = useQuery({
    queryKey: ['available-fabric-pos'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/purchase-orders?po_type=MATERIAL');
      return res.data || [];
    },
    enabled: isNew,
  });

  const [saving, setSaving] = useState(false);
  const [selectedLineIdx, setSelectedLineIdx] = useState(0);

  // Auto-generate rolls modal
  const [genModalOpen, setGenModalOpen] = useState(false);
  const [genRollCount, setGenRollCount] = useState(5);
  const [genMetersPerRoll, setGenMetersPerRoll] = useState(200);
  const [genWeightPerRoll, setGenWeightPerRoll] = useState(50);
  const [genPrefix, setGenPrefix] = useState('R-');

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

  const [lines, setLines] = useState<GrnLineItem[]>([emptyLine()]);

  // Load existing GRN
  const { data: existingData, isLoading: loadingExisting } = useQuery({
    queryKey: ['fabric-grn-detail', id],
    queryFn: async () => {
      if (isNew) return null;
      const res = await http.get<{ data: any }>(`/fabric-grns/${id}`);
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
        const loadedLines: GrnLineItem[] = existingData.lines.map((l: any) => {
          // find matching rolls from existingData.rolls
          const matchingRolls = (existingData.rolls || []).filter(
            (r: any) => r.grn_line_id === l.id || r.fabric_id === l.fabric_id
          );
          return {
            _key: `fgl_${l.id}`,
            id: l.id,
            po_line_id: l.po_line_id,
            fabric_id: l.fabric_id,
            fabric_name: l.fabric_name,
            fabric_type: l.fabric_type || 'Knitted',
            shade_code: l.shade_code || 'NVY-01',
            lot_no: l.lot_no || 'LOT-1',
            po_qty: Number(l.received_qty) + Number(l.balance_qty || 0),
            received_qty: Number(l.received_qty || 0),
            received_weight: Number(l.received_weight || 0),
            no_of_rolls: Number(l.no_of_rolls || matchingRolls.length || 1),
            accepted_qty: Number(l.accepted_qty || l.received_qty || 0),
            rejected_qty: Number(l.rejected_qty || 0),
            hold_qty: Number(l.hold_qty || 0),
            balance_qty: Number(l.balance_qty || 0),
            rate: Number(l.rate || 0),
            qc_status: l.qc_status || 'ACCEPTED',
            uom_id: l.uom_id || 9,
            rolls: matchingRolls.map((r: any) => ({
              id: r.id,
              roll_no: r.roll_no,
              lot_no: r.lot_no,
              meters: Number(r.meters),
              weight_kg: Number(r.weight_kg),
              gsm: Number(r.gsm),
              dia: r.dia,
              shade: r.shade,
              location_bin: r.location_bin,
              qc_status: r.qc_status,
              remarks: r.remarks,
            })),
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

  // Handle PO selection: populate supplier, style, lines
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
            (l: any) => l.material_type === 'FABRIC' || l.fabric_id
          );
          if (poLines.length > 0) {
            const mappedLines: GrnLineItem[] = poLines.map((pl: any, idx: number) => {
              const qty = Number(pl.qty) || 1000;
              const weight = Number(pl.weight_kg) || qty * 0.25;
              const rollsCount = Number(pl.no_of_rolls) || 5;
              const mPerRoll = qty / (rollsCount || 1);
              const wPerRoll = weight / (rollsCount || 1);

              const generatedRolls: PhysicalRoll[] = [];
              for (let i = 1; i <= rollsCount; i++) {
                generatedRolls.push({
                  roll_no: `R-${po.po_no || 'PO'}-${idx + 1}-${i}`,
                  lot_no: 'LOT-01',
                  meters: Math.round(mPerRoll * 10) / 10,
                  weight_kg: Math.round(wPerRoll * 10) / 10,
                  gsm: Number(pl.gsm) || 180,
                  dia: pl.dia || '30"',
                  shade: pl.shade_code || 'NVY-01',
                  location_bin: `BIN-${idx + 1}`,
                  qc_status: 'ACCEPTED',
                });
              }

              return {
                _key: `fgl_${++lineSeq}`,
                po_line_id: pl.id,
                fabric_id: pl.fabric_id,
                fabric_name: pl.fabric_name,
                fabric_type: pl.fabric_type || 'Knitted',
                shade_code: pl.shade_code || 'NVY-01',
                lot_no: 'LOT-01',
                po_qty: qty,
                received_qty: qty,
                received_weight: weight,
                no_of_rolls: rollsCount,
                accepted_qty: qty,
                rejected_qty: 0,
                hold_qty: 0,
                balance_qty: 0,
                rate: Number(pl.rate) || 0,
                qc_status: 'ACCEPTED',
                uom_id: pl.uom_id || 9,
                rolls: generatedRolls,
              };
            });
            setLines(mappedLines);
            setSelectedLineIdx(0);
            toast(`Loaded ${mappedLines.length} fabric items from ${po.po_no}`, 'info');
          }
        }
      }
    } catch {
      toast('Failed to load PO details', 'error');
    }
  };

  // Current active line for rolls
  const activeLine = lines[selectedLineIdx] || lines[0];

  // Roll updates
  const updateRoll = (rollIdx: number, field: keyof PhysicalRoll, val: any) => {
    setLines((prev) => {
      const copy = [...prev];
      const curLine = { ...copy[selectedLineIdx] };
      const curRolls = [...curLine.rolls];
      curRolls[rollIdx] = { ...curRolls[rollIdx], [field]: val };
      curLine.rolls = curRolls;

      // Recalculate line meters & weight from rolls
      const totalMeters = curRolls.reduce((s, r) => s + (Number(r.meters) || 0), 0);
      const totalWeight = curRolls.reduce((s, r) => s + (Number(r.weight_kg) || 0), 0);
      curLine.received_qty = totalMeters;
      curLine.received_weight = totalWeight;
      curLine.no_of_rolls = curRolls.length;
      curLine.accepted_qty = curRolls
        .filter((r) => r.qc_status === 'ACCEPTED')
        .reduce((s, r) => s + (Number(r.meters) || 0), 0);
      curLine.rejected_qty = curRolls
        .filter((r) => r.qc_status === 'REJECTED')
        .reduce((s, r) => s + (Number(r.meters) || 0), 0);
      curLine.hold_qty = curRolls
        .filter((r) => r.qc_status === 'CONDITIONAL')
        .reduce((s, r) => s + (Number(r.meters) || 0), 0);
      curLine.balance_qty = Math.max(0, curLine.po_qty - curLine.accepted_qty);

      copy[selectedLineIdx] = curLine;
      return copy;
    });
  };

  const removeRoll = (rollIdx: number) => {
    setLines((prev) => {
      const copy = [...prev];
      const curLine = { ...copy[selectedLineIdx] };
      curLine.rolls = curLine.rolls.filter((_, i) => i !== rollIdx);
      curLine.no_of_rolls = curLine.rolls.length;
      copy[selectedLineIdx] = curLine;
      return copy;
    });
  };

  const addSingleRoll = () => {
    setLines((prev) => {
      const copy = [...prev];
      const curLine = { ...copy[selectedLineIdx] };
      const nextNum = curLine.rolls.length + 1;
      const newRoll: PhysicalRoll = {
        roll_no: `R-${nextNum < 10 ? '0' + nextNum : nextNum}`,
        lot_no: curLine.lot_no || 'LOT-01',
        meters: 100,
        weight_kg: 25,
        gsm: 180,
        dia: '30"',
        shade: curLine.shade_code || 'NVY-01',
        location_bin: 'A-01',
        qc_status: 'ACCEPTED',
      };
      curLine.rolls = [...curLine.rolls, newRoll];
      curLine.no_of_rolls = curLine.rolls.length;
      copy[selectedLineIdx] = curLine;
      return copy;
    });
  };

  const executeAutoGenerateRolls = () => {
    if (!activeLine) return;
    const newRolls: PhysicalRoll[] = [];
    for (let i = 1; i <= genRollCount; i++) {
      newRolls.push({
        roll_no: `${genPrefix}${i < 10 ? '0' + i : i}`,
        lot_no: activeLine.lot_no || 'LOT-01',
        meters: Number(genMetersPerRoll),
        weight_kg: Number(genWeightPerRoll),
        gsm: 180,
        dia: '30"',
        shade: activeLine.shade_code || 'NVY-01',
        location_bin: `BIN-${i}`,
        qc_status: 'ACCEPTED',
      });
    }

    setLines((prev) => {
      const copy = [...prev];
      const curLine = { ...copy[selectedLineIdx] };
      curLine.rolls = newRolls;
      curLine.no_of_rolls = newRolls.length;
      curLine.received_qty = genRollCount * genMetersPerRoll;
      curLine.received_weight = genRollCount * genWeightPerRoll;
      curLine.accepted_qty = curLine.received_qty;
      curLine.balance_qty = Math.max(0, curLine.po_qty - curLine.accepted_qty);
      copy[selectedLineIdx] = curLine;
      return copy;
    });

    setGenModalOpen(false);
    toast(`Generated ${genRollCount} physical rolls`, 'success');
  };

  // KPIs
  const summary = useMemo(() => {
    const totalMeters = lines.reduce((s, l) => s + (Number(l.received_qty) || 0), 0);
    const totalWeight = lines.reduce((s, l) => s + (Number(l.received_weight) || 0), 0);
    const totalRolls = lines.reduce((s, l) => s + (l.rolls?.length || 0), 0);
    const acceptedMeters = lines.reduce((s, l) => s + (Number(l.accepted_qty) || 0), 0);
    return { totalMeters, totalWeight, totalRolls, acceptedMeters };
  }, [lines]);

  // Save GRN
  const handleSave = async () => {
    if (!header.supplier_id) {
      toast('Please select a supplier', 'error');
      return;
    }
    if (lines.length === 0) {
      toast('Please add at least one fabric item', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...header,
        lines: lines.map((l) => ({
          po_line_id: l.po_line_id,
          fabric_id: l.fabric_id,
          received_qty: l.received_qty,
          received_weight: l.received_weight,
          no_of_rolls: l.rolls?.length || l.no_of_rolls,
          accepted_qty: l.accepted_qty,
          rejected_qty: l.rejected_qty,
          hold_qty: l.hold_qty,
          balance_qty: l.balance_qty,
          lot_no: l.lot_no,
          qc_status: l.qc_status,
          uom_id: l.uom_id,
          rate: l.rate,
          rolls: l.rolls.map((r) => ({
            roll_no: r.roll_no,
            lot_no: r.lot_no,
            meters: r.meters,
            weight_kg: r.weight_kg,
            gsm: r.gsm,
            dia: r.dia,
            shade: r.shade,
            location_bin: r.location_bin,
            qc_status: r.qc_status,
            remarks: r.remarks,
          })),
        })),
      };

      const res = await http.post<{ data: any }>('/fabric-grns', payload);
      toast(`Fabric GRN ${res.data.grn_no} posted to stock!`, 'success');
      nav('/procurement/fabric/grn');
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : 'Failed to save fabric GRN';
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && loadingExisting) {
    return (
      <div className="py-20 text-center text-slate-400">
        Loading fabric GRN #{id}...
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-16">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => nav('/procurement/fabric/grn')}
            className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-600 transition"
            title="Back to Fabric GRNs"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-md bg-emerald-100 text-emerald-700">
                <PackageCheck size={18} />
              </span>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                {isNew ? 'New Fabric GRN & Physical Roll Inward' : `Fabric GRN: ${header.grn_no}`}
              </h1>
              {!isNew && <Badge tone="green">POSTED TO STOCK</Badge>}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Roll barcode tagging, physical yardage/kg inspection, GSM verification, and bin storage
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => nav('/procurement/fabric/roll-stock')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <Boxes size={14} className="text-sky-600" />
            <span>Roll Stock Ledger</span>
          </button>
          {isNew && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition disabled:opacity-50"
            >
              <Save size={15} />
              <span>{saving ? 'Posting to Stock...' : 'Post & Save GRN'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Summary KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-200">
          <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">Total Received</div>
          <div className="text-xl font-bold text-emerald-900 mt-0.5">{fmtDecimal(summary.totalMeters)} m</div>
        </div>
        <div className="p-3 bg-indigo-50/60 rounded-xl border border-indigo-200">
          <div className="text-[11px] font-semibold text-indigo-700 uppercase tracking-wider">Gross Weight</div>
          <div className="text-xl font-bold text-indigo-900 mt-0.5">{fmtDecimal(summary.totalWeight)} kg</div>
        </div>
        <div className="p-3 bg-sky-50/60 rounded-xl border border-sky-200">
          <div className="text-[11px] font-semibold text-sky-700 uppercase tracking-wider">Total Rolls</div>
          <div className="text-xl font-bold text-sky-900 mt-0.5">{summary.totalRolls} rolls</div>
        </div>
        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
          <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">Accepted Yardage</div>
          <div className="text-xl font-bold text-slate-800 mt-0.5">{fmtDecimal(summary.acceptedMeters)} m</div>
        </div>
      </div>

      {/* Header Fields Card */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-4">
        <div className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-1.5 pb-2 border-b border-slate-100">
          <Layers size={14} className="text-emerald-600" />
          <span>Receipt Header & Reference Information</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
          {isNew ? (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Link to Fabric PO (Optional)
              </label>
              <select
                value={header.po_id}
                onChange={(e) => handleSelectPO(e.target.value)}
                className="w-full text-xs rounded-lg border border-slate-300 py-1.5 px-2 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              >
                <option value="">-- Direct Fabric Receipt --</option>
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
            label="Supplier / Mill *"
            value={header.supplier_id}
            onChange={(e) => setHeader((p) => ({ ...p, supplier_id: e.target.value }))}
            options={toOptions(suppliers.data)}
            placeholder="Select Fabric Mill"
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
            placeholder="e.g. IR-2026-0001"
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
            placeholder="DC / Delivery Challan"
            disabled={!isNew}
          />

          <Input
            label="Supplier Inv / Bill No"
            value={header.supplier_inv_no}
            onChange={(e) => setHeader((p) => ({ ...p, supplier_inv_no: e.target.value }))}
            placeholder="Invoice / E-way Bill"
            disabled={!isNew}
          />

          <Input
            label="Vehicle No"
            value={header.vehicle_no}
            onChange={(e) => setHeader((p) => ({ ...p, vehicle_no: e.target.value }))}
            placeholder="TN 38 AB 1234"
            disabled={!isNew}
          />

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              Overall QC Status
            </label>
            <select
              value={header.qc_status}
              onChange={(e) => setHeader((p) => ({ ...p, qc_status: e.target.value }))}
              className="w-full text-xs rounded-lg border border-slate-300 py-1.5 px-2 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 font-semibold"
              disabled={!isNew}
            >
              <option value="ACCEPTED">ACCEPTED (Pass to Available Stock)</option>
              <option value="CONDITIONAL">CONDITIONAL (Reserved / Hold)</option>
              <option value="REJECTED">REJECTED (Do Not Add to Live Stock)</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <Input
              label="Remarks / Delivery Notes"
              value={header.remarks}
              onChange={(e) => setHeader((p) => ({ ...p, remarks: e.target.value }))}
              placeholder="e.g. Inspected 100% on arrival. Lot shade verified against approved lab dip."
              disabled={!isNew}
            />
          </div>
        </div>
      </div>

      {/* Fabric Line Items Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden space-y-3 p-4">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
          <div>
            <h2 className="text-xs font-semibold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <Layers size={14} className="text-emerald-600" />
              <span>Fabric Line Items ({lines.length})</span>
            </h2>
            <p className="text-[11px] text-slate-400">
              Click a row to inspect or modify its physical roll breakdown below
            </p>
          </div>
          {isNew && (
            <button
              onClick={() => {
                setLines((p) => [...p, emptyLine()]);
                setSelectedLineIdx(lines.length);
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
            >
              <Plus size={13} />
              <span>Add Fabric Item</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                <th className="py-2.5 px-3">Fabric Name</th>
                <th className="py-2.5 px-2">Type</th>
                <th className="py-2.5 px-2">Shade / Lot</th>
                <th className="py-2.5 px-2 text-right">PO Qty</th>
                <th className="py-2.5 px-2 text-right">Rec Qty (Mtrs)</th>
                <th className="py-2.5 px-2 text-right">Gross Wt (KG)</th>
                <th className="py-2.5 px-2 text-center">Rolls</th>
                <th className="py-2.5 px-2 text-right">Accepted</th>
                <th className="py-2.5 px-2 text-right">Rejected</th>
                <th className="py-2.5 px-2 text-right">Hold</th>
                <th className="py-2.5 px-2 text-right">PO Balance</th>
                <th className="py-2.5 px-2 text-center">QC</th>
                {isNew && <th className="py-2.5 px-2 text-center">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {lines.map((l, idx) => (
                <tr
                  key={l._key || idx}
                  onClick={() => setSelectedLineIdx(idx)}
                  className={`cursor-pointer transition ${
                    selectedLineIdx === idx ? 'bg-emerald-50/70 font-medium' : 'hover:bg-slate-50/70'
                  }`}
                >
                  <td className="py-2.5 px-3">
                    {isNew ? (
                      <select
                        value={l.fabric_id}
                        onChange={(e) => {
                          const val = e.target.value;
                          setLines((prev) => {
                            const copy = [...prev];
                            copy[idx] = { ...copy[idx], fabric_id: val };
                            return copy;
                          });
                        }}
                        className="w-48 text-xs rounded border border-slate-300 py-1 px-1.5"
                      >
                        <option value="">Select Fabric</option>
                        {toOptions(fabrics.data).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="font-semibold text-slate-900">{l.fabric_name || 'Fabric Item'}</div>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-slate-600">{l.fabric_type}</td>
                  <td className="py-2.5 px-2">
                    <span className="font-mono text-[11px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                      {l.shade_code} / {l.lot_no}
                    </span>
                  </td>
                  <td className="py-2.5 px-2 text-right">{fmtDecimal(l.po_qty)}</td>
                  <td className="py-2.5 px-2 text-right font-semibold text-emerald-700">
                    {fmtDecimal(l.received_qty)} m
                  </td>
                  <td className="py-2.5 px-2 text-right font-medium text-slate-800">
                    {fmtDecimal(l.received_weight)} kg
                  </td>
                  <td className="py-2.5 px-2 text-center font-bold text-sky-700">
                    {l.rolls?.length || l.no_of_rolls}
                  </td>
                  <td className="py-2.5 px-2 text-right text-emerald-600">{fmtDecimal(l.accepted_qty)}</td>
                  <td className="py-2.5 px-2 text-right text-red-600">{fmtDecimal(l.rejected_qty)}</td>
                  <td className="py-2.5 px-2 text-right text-amber-600">{fmtDecimal(l.hold_qty)}</td>
                  <td className="py-2.5 px-2 text-right text-slate-500">{fmtDecimal(l.balance_qty)}</td>
                  <td className="py-2.5 px-2 text-center">
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-emerald-100 text-emerald-800">
                      {l.qc_status}
                    </span>
                  </td>
                  {isNew && (
                    <td className="py-2.5 px-2 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (lines.length === 1) {
                            toast('Cannot delete the only fabric line', 'warning');
                            return;
                          }
                          setLines((p) => p.filter((_, i) => i !== idx));
                          if (selectedLineIdx >= lines.length - 1) setSelectedLineIdx(0);
                        }}
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

      {/* Physical Roll Sub-Grid Cockpit */}
      {activeLine && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-2 border-b border-slate-100">
            <div>
              <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <Boxes size={15} className="text-sky-600" />
                <span>Physical Roll Inspection Sub-Grid: {activeLine.fabric_name || 'Selected Fabric'}</span>
              </h3>
              <p className="text-[11px] text-slate-500">
                Individual roll tags, meters, weight, GSM, Dia, QC, and bin allocations
              </p>
            </div>

            {isNew && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setGenModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 transition"
                >
                  <Sparkles size={13} />
                  <span>Auto-Generate Rolls</span>
                </button>
                <button
                  onClick={addSingleRoll}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
                >
                  <Plus size={13} />
                  <span>Add Roll</span>
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-sky-50/50 text-slate-700 font-semibold border-b border-sky-100">
                  <th className="py-2 px-3">#</th>
                  <th className="py-2 px-2">Roll No *</th>
                  <th className="py-2 px-2">Lot No</th>
                  <th className="py-2 px-2 text-right">Length (Mtrs) *</th>
                  <th className="py-2 px-2 text-right">Weight (KG) *</th>
                  <th className="py-2 px-2 text-center">GSM</th>
                  <th className="py-2 px-2 text-center">Dia</th>
                  <th className="py-2 px-2">Shade</th>
                  <th className="py-2 px-2">Location / Bin</th>
                  <th className="py-2 px-2 text-center">QC Status</th>
                  <th className="py-2 px-2">Remarks</th>
                  {isNew && <th className="py-2 px-2 text-center">Del</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {activeLine.rolls?.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-8 text-center text-slate-400">
                      No rolls added. Click "Auto-Generate Rolls" or "Add Roll".
                    </td>
                  </tr>
                ) : (
                  activeLine.rolls.map((r, rIdx) => (
                    <tr key={r._key || rIdx} className="hover:bg-slate-50/60">
                      <td className="py-2 px-3 text-slate-400 font-mono text-[11px]">{rIdx + 1}</td>
                      <td className="py-2 px-2">
                        {isNew ? (
                          <input
                            type="text"
                            value={r.roll_no}
                            onChange={(e) => updateRoll(rIdx, 'roll_no', e.target.value)}
                            className="w-24 text-xs font-mono font-semibold text-sky-700 border border-slate-300 rounded px-1.5 py-0.5"
                          />
                        ) : (
                          <span className="font-mono font-semibold text-sky-700">{r.roll_no}</span>
                        )}
                      </td>
                      <td className="py-2 px-2">
                        {isNew ? (
                          <input
                            type="text"
                            value={r.lot_no}
                            onChange={(e) => updateRoll(rIdx, 'lot_no', e.target.value)}
                            className="w-24 text-xs font-mono border border-slate-300 rounded px-1.5 py-0.5"
                          />
                        ) : (
                          <span className="font-mono text-slate-600">{r.lot_no}</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {isNew ? (
                          <input
                            type="number"
                            value={r.meters}
                            onChange={(e) => updateRoll(rIdx, 'meters', parseFloat(e.target.value) || 0)}
                            className="w-20 text-xs text-right font-medium border border-slate-300 rounded px-1.5 py-0.5"
                          />
                        ) : (
                          <span className="font-medium text-emerald-700">{fmtDecimal(r.meters)} m</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {isNew ? (
                          <input
                            type="number"
                            value={r.weight_kg}
                            onChange={(e) => updateRoll(rIdx, 'weight_kg', parseFloat(e.target.value) || 0)}
                            className="w-20 text-xs text-right font-medium border border-slate-300 rounded px-1.5 py-0.5"
                          />
                        ) : (
                          <span className="font-medium text-indigo-700">{fmtDecimal(r.weight_kg)} kg</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {isNew ? (
                          <input
                            type="number"
                            value={r.gsm}
                            onChange={(e) => updateRoll(rIdx, 'gsm', parseInt(e.target.value) || 0)}
                            className="w-16 text-xs text-center border border-slate-300 rounded px-1 py-0.5"
                          />
                        ) : (
                          <span>{r.gsm}</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {isNew ? (
                          <input
                            type="text"
                            value={r.dia}
                            onChange={(e) => updateRoll(rIdx, 'dia', e.target.value)}
                            className="w-16 text-xs text-center border border-slate-300 rounded px-1 py-0.5"
                          />
                        ) : (
                          <span>{r.dia}</span>
                        )}
                      </td>
                      <td className="py-2 px-2">
                        {isNew ? (
                          <input
                            type="text"
                            value={r.shade}
                            onChange={(e) => updateRoll(rIdx, 'shade', e.target.value)}
                            className="w-20 text-xs border border-slate-300 rounded px-1.5 py-0.5"
                          />
                        ) : (
                          <span>{r.shade}</span>
                        )}
                      </td>
                      <td className="py-2 px-2">
                        {isNew ? (
                          <input
                            type="text"
                            value={r.location_bin}
                            onChange={(e) => updateRoll(rIdx, 'location_bin', e.target.value)}
                            className="w-20 text-xs font-mono border border-slate-300 rounded px-1.5 py-0.5"
                          />
                        ) : (
                          <span className="font-mono text-slate-700">{r.location_bin || '—'}</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {isNew ? (
                          <select
                            value={r.qc_status}
                            onChange={(e) => updateRoll(rIdx, 'qc_status', e.target.value)}
                            className={`text-[11px] rounded px-1 py-0.5 font-semibold ${
                              r.qc_status === 'ACCEPTED'
                                ? 'bg-emerald-100 text-emerald-800'
                                : r.qc_status === 'REJECTED'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            <option value="ACCEPTED">ACCEPTED</option>
                            <option value="CONDITIONAL">CONDITIONAL</option>
                            <option value="REJECTED">REJECTED</option>
                          </select>
                        ) : (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                              r.qc_status === 'ACCEPTED'
                                ? 'bg-emerald-100 text-emerald-800'
                                : r.qc_status === 'REJECTED'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {r.qc_status}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2">
                        {isNew ? (
                          <input
                            type="text"
                            value={r.remarks || ''}
                            onChange={(e) => updateRoll(rIdx, 'remarks', e.target.value)}
                            placeholder="Roll notes..."
                            className="w-28 text-xs border border-slate-300 rounded px-1.5 py-0.5"
                          />
                        ) : (
                          <span className="text-slate-500 text-[11px]">{r.remarks || '—'}</span>
                        )}
                      </td>
                      {isNew && (
                        <td className="py-2 px-2 text-center">
                          <button
                            onClick={() => removeRoll(rIdx)}
                            className="p-1 text-slate-400 hover:text-red-600 rounded"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Auto-Generate Rolls Modal */}
      {genModalOpen && (
        <Modal
          title="Auto-Generate Physical Fabric Rolls"
          open={genModalOpen}
          onClose={() => setGenModalOpen(false)}
        >
          <div className="space-y-4 text-xs">
            <div className="p-3 bg-sky-50 rounded-lg text-sky-800 flex items-start gap-2">
              <Info size={16} className="mt-0.5 shrink-0" />
              <span>
                Specify the number of rolls and average length/weight. This will populate the roll sub-grid with unique roll numbers for barcode tagging.
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Number of Rolls"
                type="number"
                value={genRollCount}
                onChange={(e) => setGenRollCount(parseInt(e.target.value) || 1)}
              />
              <Input
                label="Roll Prefix"
                value={genPrefix}
                onChange={(e) => setGenPrefix(e.target.value)}
                placeholder="R-"
              />
              <Input
                label="Meters per Roll"
                type="number"
                value={genMetersPerRoll}
                onChange={(e) => setGenMetersPerRoll(parseFloat(e.target.value) || 0)}
              />
              <Input
                label="Weight (KG) per Roll"
                type="number"
                value={genWeightPerRoll}
                onChange={(e) => setGenWeightPerRoll(parseFloat(e.target.value) || 0)}
              />
            </div>

            <div className="p-3 bg-slate-50 rounded-lg text-slate-700 text-[11px] flex justify-between">
              <span>Calculated Total: <strong>{genRollCount * genMetersPerRoll} m</strong></span>
              <span>Total Weight: <strong>{genRollCount * genWeightPerRoll} kg</strong></span>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setGenModalOpen(false)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={executeAutoGenerateRolls}
                className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-medium"
              >
                Generate {genRollCount} Rolls
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
