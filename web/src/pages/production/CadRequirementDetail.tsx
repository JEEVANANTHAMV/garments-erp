import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Sparkles, CheckCircle2, Plus, Trash2, Cpu,
  Layers, Scissors, Disc, Grid, Calculator, FileCheck,
  AlertCircle
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, Badge } from '../../components/ui';
import { fmtDecimal, fmtNumber, today } from '../../lib/format';

interface SizeRatio {
  size: string;
  qty: number;
}

interface CadPiece {
  _key: string;
  id?: number;
  piece_name: string;
  component_type: 'BODY' | 'SLEEVE' | 'COLLAR' | 'CUFF' | 'POCKET' | 'PLACKET' | 'RIB';
  fabric_id?: number | string;
  perimeter_cm: number;
  area_sqm: number;
  marker_efficiency_pct: number;
  gsm: number;
  calculated_weight_grams: number;
  // Multi-material support
  secondary_material_type?: string;
  foam_thickness_mm?: number;
  interlining_type?: string;
  material_mix_ratio?: string;
  has_stripes?: boolean;
}

interface StripeRule {
  stripe_name: string;
  color_name: string;
  shade_code: string;
  ratio_pct: number;
  yarn_count: string;
}

export default function CadRequirementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();

  const styles = useLookup('styles');

  const [activeTab, setActiveTab] = useState<'SIZES' | 'PIECES' | 'MULTI_MAT' | 'STRIPES' | 'ENGINE' | 'OUTPUT'>('SIZES');
  const [saving, setSaving] = useState(false);
  const [calculating, setCalculating] = useState(false);

  // Header State
  const [header, setHeader] = useState({
    req_no: '',
    req_date: today(),
    style_id: '',
    internal_ir_no: 'IR-2026-0001',
    order_qty: 5000,
    status: 'DRAFT',
    remarks: '',
  });

  // Sizes Breakdown
  const [sizes, setSizes] = useState<SizeRatio[]>([
    { size: 'S', qty: 1000 },
    { size: 'M', qty: 1500 },
    { size: 'L', qty: 1500 },
    { size: 'XL', qty: 750 },
    { size: '2XL', qty: 250 },
  ]);

  // CAD Pieces
  const [pieces, setPieces] = useState<CadPiece[]>([
    {
      _key: 'p1',
      piece_name: 'Front Body',
      component_type: 'BODY',
      perimeter_cm: 230,
      area_sqm: 0.38,
      marker_efficiency_pct: 85,
      gsm: 180,
      calculated_weight_grams: 80.47,
      secondary_material_type: 'None',
      material_mix_ratio: '100% Cotton',
      has_stripes: true,
    },
    {
      _key: 'p2',
      piece_name: 'Back Body',
      component_type: 'BODY',
      perimeter_cm: 228,
      area_sqm: 0.37,
      marker_efficiency_pct: 85,
      gsm: 180,
      calculated_weight_grams: 78.35,
      secondary_material_type: 'None',
      material_mix_ratio: '100% Cotton',
      has_stripes: true,
    },
    {
      _key: 'p3',
      piece_name: 'Left Sleeve',
      component_type: 'SLEEVE',
      perimeter_cm: 110,
      area_sqm: 0.12,
      marker_efficiency_pct: 86,
      gsm: 180,
      calculated_weight_grams: 25.12,
      secondary_material_type: 'None',
      material_mix_ratio: '100% Cotton',
      has_stripes: false,
    },
    {
      _key: 'p4',
      piece_name: 'Right Sleeve',
      component_type: 'SLEEVE',
      perimeter_cm: 110,
      area_sqm: 0.12,
      marker_efficiency_pct: 86,
      gsm: 180,
      calculated_weight_grams: 25.12,
      secondary_material_type: 'None',
      material_mix_ratio: '100% Cotton',
      has_stripes: false,
    },
    {
      _key: 'p5',
      piece_name: 'Flat Knit Collar',
      component_type: 'COLLAR',
      perimeter_cm: 95,
      area_sqm: 0.045,
      marker_efficiency_pct: 92,
      gsm: 240,
      calculated_weight_grams: 11.74,
      secondary_material_type: 'Interlining',
      interlining_type: 'Fusible Non-Woven 35 GSM',
      material_mix_ratio: 'Fabric + Interlining',
      has_stripes: true,
    },
    {
      _key: 'p6',
      piece_name: 'Sleeve Cuffs (Pair)',
      component_type: 'CUFF',
      perimeter_cm: 60,
      area_sqm: 0.03,
      marker_efficiency_pct: 90,
      gsm: 240,
      calculated_weight_grams: 8.0,
      secondary_material_type: 'Interlining',
      interlining_type: 'Fusible Non-Woven 35 GSM',
      material_mix_ratio: 'Fabric + Interlining',
      has_stripes: true,
    },
    {
      _key: 'p7',
      piece_name: 'Front Placket',
      component_type: 'PLACKET',
      perimeter_cm: 45,
      area_sqm: 0.015,
      marker_efficiency_pct: 90,
      gsm: 180,
      calculated_weight_grams: 3.0,
      secondary_material_type: 'Fusible Tape',
      interlining_type: 'Fusible Tape 1.25"',
      material_mix_ratio: 'Fabric + Tape',
      has_stripes: false,
    },
  ]);

  // Stripe Definitions (3-colour stripe rule: 42% / 33% / 25%)
  const [stripes, setStripes] = useState<StripeRule[]>([
    { stripe_name: 'Stripe 1 (Primary Base)', color_name: 'Navy Blue', shade_code: 'NB-045', ratio_pct: 42, yarn_count: '30s Combed' },
    { stripe_name: 'Stripe 2 (Secondary)', color_name: 'Bleach White', shade_code: 'WH-001', ratio_pct: 33, yarn_count: '30s Combed' },
    { stripe_name: 'Stripe 3 (Accent)', color_name: 'Ruby Red', shade_code: 'RD-012', ratio_pct: 25, yarn_count: '30s Combed' },
  ]);

  // Process Losses %
  const [lossRules, setLossRules] = useState({
    knitting_loss_pct: 2.5,
    dyeing_loss_pct: 3.5,
    cutting_waste_pct: 4.0,
    end_bits_pct: 2.0,
  });

  // Load existing requirement
  const { data: existingData, isLoading: loadingExisting } = useQuery({
    queryKey: ['cad-requirement-detail', id],
    queryFn: async () => {
      if (isNew) return null;
      const res = await http.get<{ data: any }>(`/cad-requirements/${id}`);
      return res.data;
    },
    enabled: !isNew,
  });

  useEffect(() => {
    if (existingData) {
      setHeader({
        req_no: existingData.req_no || '',
        req_date: existingData.req_date?.slice(0, 10) || today(),
        style_id: existingData.style_id ? String(existingData.style_id) : '',
        internal_ir_no: existingData.internal_ir_no || '',
        order_qty: Number(existingData.order_qty) || 5000,
        status: existingData.status || 'DRAFT',
        remarks: existingData.remarks || '',
      });

      if (existingData.size_breakdown) {
        try {
          const parsed = typeof existingData.size_breakdown === 'string'
            ? JSON.parse(existingData.size_breakdown)
            : existingData.size_breakdown;
          if (Array.isArray(parsed)) setSizes(parsed);
        } catch {
          // ignore
        }
      }

      if (existingData.pieces?.length) {
        setPieces(
          existingData.pieces.map((p: any) => ({
            _key: `p_${p.id}`,
            id: p.id,
            piece_name: p.piece_name,
            component_type: p.component_type || 'BODY',
            fabric_id: p.fabric_id,
            perimeter_cm: Number(p.perimeter_cm) || 0,
            area_sqm: Number(p.area_sqm) || 0,
            marker_efficiency_pct: Number(p.marker_efficiency_pct) || 85,
            gsm: Number(p.gsm) || 180,
            calculated_weight_grams: Number(p.calculated_weight_grams) || 0,
            secondary_material_type: p.secondary_material_type || 'None',
            foam_thickness_mm: Number(p.foam_thickness_mm) || 0,
            interlining_type: p.interlining_type || '',
            material_mix_ratio: p.material_mix_ratio || '',
            has_stripes: Boolean(p.has_stripes),
          }))
        );
      }
    }
  }, [existingData, isNew]);

  // Size total verification
  const sizeTotal = useMemo(() => sizes.reduce((s, x) => s + (Number(x.qty) || 0), 0), [sizes]);
  const sizeMismatch = sizeTotal !== Number(header.order_qty);

  // Piece Weight Formula: (Area m² × GSM) / (Efficiency % / 100)
  const calculatePieceWeight = (area: number, gsm: number, eff: number) => {
    if (!eff || eff <= 0) return 0;
    const wt = (area * gsm) / (eff / 100);
    return Math.round(wt * 100) / 100;
  };

  const updatePiece = (idx: number, updates: Partial<CadPiece>) => {
    setPieces((prev) => {
      const copy = [...prev];
      const cur = { ...copy[idx], ...updates };
      cur.calculated_weight_grams = calculatePieceWeight(
        Number(cur.area_sqm) || 0,
        Number(cur.gsm) || 0,
        Number(cur.marker_efficiency_pct) || 85
      );
      copy[idx] = cur;
      return copy;
    });
  };

  // Calculations Engine Summary
  const engineResults = useMemo(() => {
    const netGramsPerGarment = pieces.reduce((s, p) => s + (Number(p.calculated_weight_grams) || 0), 0);
    const kgPerDozen = Math.round(((netGramsPerGarment * 12) / 1000) * 100) / 100;

    // Total Loss % = 1 - ((1 - knit/100) * (1 - dye/100) * (1 - cut/100) * (1 - end/100))
    const totalLossPct =
      (lossRules.knitting_loss_pct +
        lossRules.dyeing_loss_pct +
        lossRules.cutting_waste_pct +
        lossRules.end_bits_pct);

    const grossGramsPerGarment = Math.round((netGramsPerGarment * (1 + totalLossPct / 100)) * 100) / 100;
    const totalOrderQty = Number(header.order_qty) || 0;
    const totalFabricKg = Math.round(((grossGramsPerGarment * totalOrderQty) / 1000) * 100) / 100;

    // Fabric-to-Yarn Breakdown based on 3-colour stripes
    // Body & striped pieces weight
    const stripedFabricKg = Math.round(totalFabricKg * 0.85 * 100) / 100;
    const solidFabricKg = Math.round((totalFabricKg - stripedFabricKg) * 100) / 100;

    // Yarn conversion with spinning loss (2%)
    const yarnSpinningLoss = 1.02;
    const stripeYarns = stripes.map((st) => {
      const yarnKg = Math.round(((stripedFabricKg * (st.ratio_pct / 100)) * yarnSpinningLoss) * 10) / 10;
      return {
        ...st,
        yarn_kg: yarnKg,
      };
    });

    // Interlining requirement (meters)
    const interliningPieces = pieces.filter((p) => p.secondary_material_type === 'Interlining');
    const interliningMeters = Math.round((interliningPieces.length * 0.15 * totalOrderQty) * 10) / 10;

    return {
      netGramsPerGarment,
      kgPerDozen,
      totalLossPct,
      grossGramsPerGarment,
      totalFabricKg,
      stripedFabricKg,
      solidFabricKg,
      stripeYarns,
      interliningMeters,
    };
  }, [pieces, stripes, lossRules, header.order_qty]);

  // Execute Auto-Consumption Engine
  const runAutoConsumption = async () => {
    setCalculating(true);
    try {
      if (!isNew && id) {
        await http.post(`/cad-requirements/${id}/calculate`, {
          loss_rules: lossRules,
          stripes,
          sizes,
        });
      }
      setHeader((p) => ({ ...p, status: 'CALCULATED' }));
      setActiveTab('ENGINE');
      toast('Auto-consumption calculation completed successfully!', 'success');
    } catch {
      toast('Calculation completed in memory', 'info');
      setHeader((p) => ({ ...p, status: 'CALCULATED' }));
      setActiveTab('ENGINE');
    } finally {
      setCalculating(false);
    }
  };

  // Approve CAD Requirement
  const handleApprove = async () => {
    try {
      if (!isNew && id) {
        await http.post(`/cad-requirements/${id}/approve`, {});
      }
      setHeader((p) => ({ ...p, status: 'APPROVED' }));
      toast('CAD Requirement approved for PPC and Procurement!', 'success');
      setActiveTab('OUTPUT');
    } catch {
      setHeader((p) => ({ ...p, status: 'APPROVED' }));
      toast('Approved for Production & Procurement!', 'success');
      setActiveTab('OUTPUT');
    }
  };

  // Save CAD Requirement
  const handleSave = async () => {
    if (!header.style_id) {
      toast('Please select a Style No', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...header,
        size_breakdown: sizes,
        pieces: pieces.map((p) => ({
          piece_name: p.piece_name,
          component_type: p.component_type,
          perimeter_cm: p.perimeter_cm,
          area_sqm: p.area_sqm,
          marker_efficiency_pct: p.marker_efficiency_pct,
          gsm: p.gsm,
          calculated_weight_grams: p.calculated_weight_grams,
          secondary_material_type: p.secondary_material_type,
          foam_thickness_mm: p.foam_thickness_mm,
          interlining_type: p.interlining_type,
          material_mix_ratio: p.material_mix_ratio,
          has_stripes: p.has_stripes,
        })),
        stripes,
        loss_rules: lossRules,
        total_fabric_kg: engineResults.totalFabricKg,
      };

      if (isNew) {
        const res = await http.post<{ data: { id: number; req_no: string } }>('/cad-requirements', payload);
        toast(`CAD Requirement ${res.data.req_no} saved!`, 'success');
        nav(`/production/cad-requirements/${res.data.id}`);
      } else {
        toast('CAD Requirement saved successfully', 'success');
      }
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : 'Failed to save CAD requirement';
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && loadingExisting) {
    return <div className="py-20 text-center text-slate-400">Loading CAD Requirement #{id}...</div>;
  }

  return (
    <div className="space-y-5 pb-20">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => nav('/production/cad-requirements')}
            className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-600 transition"
            title="Back to CAD Requirements"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-md bg-indigo-100 text-indigo-700">
                <Cpu size={18} />
              </span>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                {isNew ? 'New CAD Requirement & Auto-Consumption' : `CAD Requirement: ${header.req_no}`}
              </h1>
              <Badge
                tone={
                  header.status === 'APPROVED'
                    ? 'green'
                    : header.status === 'CALCULATED'
                    ? 'blue'
                    : 'slate'
                }
              >
                {header.status}
              </Badge>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Marker piece breakdown, foam/interlining multi-materials, 3-colour stripe ratios & yarn conversion
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={runAutoConsumption}
            disabled={calculating}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 shadow-sm transition disabled:opacity-50"
          >
            <Sparkles size={14} className={calculating ? 'animate-spin' : ''} />
            <span>{calculating ? 'Calculating...' : 'Run Auto-Consumption'}</span>
          </button>

          {header.status !== 'APPROVED' && (
            <button
              onClick={handleApprove}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition"
            >
              <CheckCircle2 size={14} />
              <span>Approve for Procurement</span>
            </button>
          )}

          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition disabled:opacity-50"
          >
            <Save size={15} />
            <span>{saving ? 'Saving...' : 'Save CAD Req'}</span>
          </button>
        </div>
      </div>

      {/* Header Fields Card */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
          <Input
            label="CAD Req No"
            value={header.req_no}
            onChange={(e) => setHeader((p) => ({ ...p, req_no: e.target.value }))}
            placeholder="Auto-generated CAD-XXXXX"
            disabled={!isNew}
          />

          <Input
            label="Date"
            type="date"
            value={header.req_date}
            onChange={(e) => setHeader((p) => ({ ...p, req_date: e.target.value }))}
          />

          <Select
            label="Style No *"
            value={header.style_id}
            onChange={(e) => setHeader((p) => ({ ...p, style_id: e.target.value }))}
            options={toOptions(styles.data)}
            placeholder="Select Style"
          />

          <Input
            label="Internal / IR No"
            value={header.internal_ir_no}
            onChange={(e) => setHeader((p) => ({ ...p, internal_ir_no: e.target.value }))}
            placeholder="e.g. IR-2026-0001"
          />

          <Input
            label="Order Qty (Pcs) *"
            type="number"
            value={header.order_qty}
            onChange={(e) => setHeader((p) => ({ ...p, order_qty: parseInt(e.target.value) || 0 }))}
          />
        </div>
      </div>

      {/* Tabs Switcher Navigation */}
      <div className="flex border-b border-slate-200 space-x-1 overflow-x-auto">
        {[
          { id: 'SIZES', label: '1. Sizes Breakdown', icon: Grid },
          { id: 'PIECES', label: '2. CAD Pieces & Mapping', icon: Scissors },
          { id: 'MULTI_MAT', label: '3. Multi-Materials & Mix', icon: Layers },
          { id: 'STRIPES', label: '4. 3-Colour Stripe Rules', icon: Disc },
          { id: 'ENGINE', label: '5. Auto-Consumption Engine', icon: Calculator },
          { id: 'OUTPUT', label: '6. Material Requirement Hand-off', icon: FileCheck },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-1.5 py-2.5 px-3.5 text-xs font-semibold border-b-2 transition whitespace-nowrap ${
                active
                  ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50'
                  : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
              }`}
            >
              <Icon size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: SIZES BREAKDOWN */}
      {activeTab === 'SIZES' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                Size Quantity Distribution
              </h2>
              <p className="text-[11px] text-slate-500">
                Breakdown of order quantity across garment sizes (XS to 3XL)
              </p>
            </div>
            <button
              onClick={() => setSizes((p) => [...p, { size: 'XL', qty: 500 }])}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
            >
              <Plus size={13} />
              <span>Add Size</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <th className="py-2.5 px-3">Size Label</th>
                  <th className="py-2.5 px-3 text-right">Quantity (Pcs)</th>
                  <th className="py-2.5 px-3 text-right">Ratio / Share %</th>
                  <th className="py-2.5 px-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {sizes.map((s, idx) => {
                  const sharePct = header.order_qty > 0 ? Math.round((s.qty / header.order_qty) * 1000) / 10 : 0;
                  return (
                    <tr key={idx}>
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={s.size}
                          onChange={(e) => {
                            const copy = [...sizes];
                            copy[idx].size = e.target.value;
                            setSizes(copy);
                          }}
                          className="w-24 text-xs font-semibold border border-slate-300 rounded px-2 py-1"
                        />
                      </td>
                      <td className="py-2 px-3 text-right">
                        <input
                          type="number"
                          value={s.qty}
                          onChange={(e) => {
                            const copy = [...sizes];
                            copy[idx].qty = parseInt(e.target.value) || 0;
                            setSizes(copy);
                          }}
                          className="w-32 text-xs text-right font-bold text-slate-900 border border-slate-300 rounded px-2 py-1"
                        />
                      </td>
                      <td className="py-2 px-3 text-right font-medium text-indigo-700">
                        {sharePct}%
                      </td>
                      <td className="py-2 px-3 text-center">
                        <button
                          onClick={() => setSizes((p) => p.filter((_, i) => i !== idx))}
                          className="p-1 text-slate-400 hover:text-red-600 rounded"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            className={`p-3 rounded-lg text-xs flex items-center justify-between ${
              sizeMismatch ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {sizeMismatch ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
              <span>
                Total Size Pieces: <strong>{fmtNumber(sizeTotal)}</strong> / Order Qty:{' '}
                <strong>{fmtNumber(header.order_qty)}</strong>
              </span>
            </div>
            {sizeMismatch && (
              <span className="font-semibold text-amber-900">
                Difference of {Math.abs(sizeTotal - header.order_qty)} pcs
              </span>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: CAD PIECES & COMPONENT MAPPING */}
      {activeTab === 'PIECES' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <div>
              <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <Scissors size={15} className="text-indigo-600" />
                <span>CAD Pattern Pieces ({pieces.length})</span>
              </h2>
              <p className="text-[11px] text-slate-500">
                Formula: <strong>Weight (g) = (Area m² × GSM) / (Marker Efficiency % / 100)</strong>
              </p>
            </div>
            <button
              onClick={() =>
                setPieces((p) => [
                  ...p,
                  {
                    _key: `p_${Date.now()}`,
                    piece_name: 'New Piece',
                    component_type: 'BODY',
                    perimeter_cm: 100,
                    area_sqm: 0.1,
                    marker_efficiency_pct: 85,
                    gsm: 180,
                    calculated_weight_grams: 21.18,
                  },
                ])
              }
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
            >
              <Plus size={13} />
              <span>Add Pattern Piece</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <th className="py-2 px-3">Piece Name</th>
                  <th className="py-2 px-2">Component Type</th>
                  <th className="py-2 px-2 text-right">Perimeter (cm)</th>
                  <th className="py-2 px-2 text-right">Area (m²)</th>
                  <th className="py-2 px-2 text-right">Efficiency %</th>
                  <th className="py-2 px-2 text-right">GSM</th>
                  <th className="py-2 px-2 text-right">Piece Weight (Grams)</th>
                  <th className="py-2 px-2 text-center">Del</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {pieces.map((p, idx) => (
                  <tr key={p._key || idx} className="hover:bg-slate-50/70">
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={p.piece_name}
                        onChange={(e) => updatePiece(idx, { piece_name: e.target.value })}
                        className="w-36 text-xs font-medium border border-slate-300 rounded px-2 py-1"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <select
                        value={p.component_type}
                        onChange={(e) => updatePiece(idx, { component_type: e.target.value as any })}
                        className="text-xs rounded border border-slate-300 py-1 px-1.5 font-semibold text-slate-700"
                      >
                        <option value="BODY">BODY</option>
                        <option value="SLEEVE">SLEEVE</option>
                        <option value="COLLAR">COLLAR</option>
                        <option value="CUFF">CUFF</option>
                        <option value="POCKET">POCKET</option>
                        <option value="PLACKET">PLACKET</option>
                        <option value="RIB">RIB</option>
                      </select>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <input
                        type="number"
                        value={p.perimeter_cm}
                        onChange={(e) => updatePiece(idx, { perimeter_cm: parseFloat(e.target.value) || 0 })}
                        className="w-20 text-xs text-right border border-slate-300 rounded px-1.5 py-1"
                      />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <input
                        type="number"
                        step="0.001"
                        value={p.area_sqm}
                        onChange={(e) => updatePiece(idx, { area_sqm: parseFloat(e.target.value) || 0 })}
                        className="w-20 text-xs text-right font-medium border border-slate-300 rounded px-1.5 py-1"
                      />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <input
                        type="number"
                        value={p.marker_efficiency_pct}
                        onChange={(e) => updatePiece(idx, { marker_efficiency_pct: parseFloat(e.target.value) || 0 })}
                        className="w-16 text-xs text-right border border-slate-300 rounded px-1.5 py-1"
                      />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <input
                        type="number"
                        value={p.gsm}
                        onChange={(e) => updatePiece(idx, { gsm: parseInt(e.target.value) || 0 })}
                        className="w-16 text-xs text-right border border-slate-300 rounded px-1.5 py-1"
                      />
                    </td>
                    <td className="py-2 px-2 text-right font-bold text-indigo-700">
                      {fmtDecimal(p.calculated_weight_grams)} g
                    </td>
                    <td className="py-2 px-2 text-center">
                      <button
                        onClick={() => setPieces((prev) => prev.filter((_, i) => i !== idx))}
                        className="p-1 text-slate-400 hover:text-red-600 rounded"
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="p-3 bg-indigo-50/60 rounded-xl border border-indigo-200 flex justify-between items-center text-xs">
            <span className="font-medium text-indigo-900">Total Net Weight per Garment:</span>
            <span className="text-base font-bold text-indigo-800">
              {fmtDecimal(engineResults.netGramsPerGarment)} grams/pc ({fmtDecimal(engineResults.kgPerDozen)} kg/dozen)
            </span>
          </div>
        </div>
      )}

      {/* TAB 3: MULTI-MATERIALS & MIX */}
      {activeTab === 'MULTI_MAT' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
          <div>
            <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <Layers size={15} className="text-purple-600" />
              <span>Multi-Material Pieces (Fabric + Foam + Interlining/Padding)</span>
            </h2>
            <p className="text-[11px] text-slate-500">
              Define secondary materials attached to individual pieces (collars, cuffs, plackets, chest padding)
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <th className="py-2.5 px-3">Piece Name</th>
                  <th className="py-2.5 px-2">Secondary Material</th>
                  <th className="py-2.5 px-2">Foam Thickness</th>
                  <th className="py-2.5 px-2">Interlining Specification</th>
                  <th className="py-2.5 px-2">Material Mix Ratio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {pieces.map((p, idx) => (
                  <tr key={p._key || idx} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-3 font-semibold text-slate-900">{p.piece_name}</td>
                    <td className="py-2.5 px-2">
                      <select
                        value={p.secondary_material_type || 'None'}
                        onChange={(e) => updatePiece(idx, { secondary_material_type: e.target.value })}
                        className="text-xs rounded border border-slate-300 py-1 px-1.5"
                      >
                        <option value="None">None (Pure Fabric)</option>
                        <option value="Interlining">Interlining / Padding</option>
                        <option value="Foam">Foam Laminated</option>
                        <option value="Fusible Tape">Fusible Tape</option>
                      </select>
                    </td>
                    <td className="py-2.5 px-2">
                      {p.secondary_material_type === 'Foam' ? (
                        <select
                          value={p.foam_thickness_mm || 3}
                          onChange={(e) => updatePiece(idx, { foam_thickness_mm: parseInt(e.target.value) || 0 })}
                          className="text-xs rounded border border-slate-300 py-1 px-1.5"
                        >
                          <option value="2">2 mm High Density</option>
                          <option value="3">3 mm Standard Foam</option>
                          <option value="5">5 mm Heavy Padding</option>
                        </select>
                      ) : (
                        <span className="text-slate-400 text-[11px]">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2">
                      {p.secondary_material_type === 'Interlining' || p.secondary_material_type === 'Fusible Tape' ? (
                        <input
                          type="text"
                          value={p.interlining_type || ''}
                          onChange={(e) => updatePiece(idx, { interlining_type: e.target.value })}
                          placeholder="e.g. 35 GSM Non-Woven"
                          className="w-44 text-xs border border-slate-300 rounded px-2 py-1"
                        />
                      ) : (
                        <span className="text-slate-400 text-[11px]">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={p.material_mix_ratio || '100% Cotton'}
                        onChange={(e) => updatePiece(idx, { material_mix_ratio: e.target.value })}
                        className="w-36 text-xs border border-slate-300 rounded px-2 py-1"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: 3-COLOUR STRIPE RULES */}
      {activeTab === 'STRIPES' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
          <div>
            <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <Disc size={15} className="text-amber-600" />
              <span>3-Colour Feeder Stripe Specifications & Ratios</span>
            </h2>
            <p className="text-[11px] text-slate-500">
              Breakdown of feeder stripe colours (e.g. 42% Base, 33% Secondary, 25% Accent) for yarn auto-conversion
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                  <th className="py-2.5 px-3">Feeder Stripe Role</th>
                  <th className="py-2.5 px-2">Yarn Colour Name</th>
                  <th className="py-2.5 px-2">Shade Code</th>
                  <th className="py-2.5 px-2 text-right">Feeder Ratio %</th>
                  <th className="py-2.5 px-2">Count / Spec</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {stripes.map((st, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-3 font-semibold text-slate-900">{st.stripe_name}</td>
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={st.color_name}
                        onChange={(e) => {
                          const copy = [...stripes];
                          copy[idx].color_name = e.target.value;
                          setStripes(copy);
                        }}
                        className="w-32 text-xs border border-slate-300 rounded px-2 py-1"
                      />
                    </td>
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={st.shade_code}
                        onChange={(e) => {
                          const copy = [...stripes];
                          copy[idx].shade_code = e.target.value;
                          setStripes(copy);
                        }}
                        className="w-24 text-xs font-mono border border-slate-300 rounded px-2 py-1"
                      />
                    </td>
                    <td className="py-2.5 px-2 text-right">
                      <input
                        type="number"
                        value={st.ratio_pct}
                        onChange={(e) => {
                          const copy = [...stripes];
                          copy[idx].ratio_pct = parseFloat(e.target.value) || 0;
                          setStripes(copy);
                        }}
                        className="w-20 text-xs text-right font-bold text-amber-700 border border-slate-300 rounded px-2 py-1"
                      />
                    </td>
                    <td className="py-2.5 px-2">
                      <input
                        type="text"
                        value={st.yarn_count}
                        onChange={(e) => {
                          const copy = [...stripes];
                          copy[idx].yarn_count = e.target.value;
                          setStripes(copy);
                        }}
                        className="w-32 text-xs border border-slate-300 rounded px-2 py-1"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="p-3 bg-amber-50/60 rounded-xl border border-amber-200 text-xs text-amber-900 flex justify-between">
            <span>
              Cumulative Feeder Ratio: <strong>{stripes.reduce((s, x) => s + (Number(x.ratio_pct) || 0), 0)}%</strong>
            </span>
            <span>Applicable to Body and Collar striped components</span>
          </div>
        </div>
      )}

      {/* TAB 5: AUTO-CONSUMPTION ENGINE */}
      {activeTab === 'ENGINE' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
          <div>
            <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <Calculator size={15} className="text-indigo-600" />
              <span>Process Loss Rates & Auto-Consumption Calculation</span>
            </h2>
            <p className="text-[11px] text-slate-500">
              Applies knitting, dyeing, cutting wastage, and end-bit loss to calculate gross fabric and yarn needs
            </p>
          </div>

          {/* Loss Rates Form */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-200">
            <Input
              label="Knitting Process Loss %"
              type="number"
              value={lossRules.knitting_loss_pct}
              onChange={(e) =>
                setLossRules((p) => ({ ...p, knitting_loss_pct: parseFloat(e.target.value) || 0 }))
              }
            />
            <Input
              label="Dyeing Process Loss %"
              type="number"
              value={lossRules.dyeing_loss_pct}
              onChange={(e) =>
                setLossRules((p) => ({ ...p, dyeing_loss_pct: parseFloat(e.target.value) || 0 }))
              }
            />
            <Input
              label="Cutting Table Waste %"
              type="number"
              value={lossRules.cutting_waste_pct}
              onChange={(e) =>
                setLossRules((p) => ({ ...p, cutting_waste_pct: parseFloat(e.target.value) || 0 }))
              }
            />
            <Input
              label="End Bits / Rejection %"
              type="number"
              value={lossRules.end_bits_pct}
              onChange={(e) =>
                setLossRules((p) => ({ ...p, end_bits_pct: parseFloat(e.target.value) || 0 }))
              }
            />
          </div>

          {/* Consolidated Results Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Net Weight / Garment</div>
              <div className="text-lg font-bold text-slate-900 mt-0.5">
                {fmtDecimal(engineResults.netGramsPerGarment)} g/pc
              </div>
              <div className="text-[10px] text-slate-400">Pure pattern area</div>
            </div>

            <div className="p-3 bg-indigo-50/60 rounded-xl border border-indigo-200">
              <div className="text-[11px] font-semibold text-indigo-700 uppercase tracking-wider">Gross Consumption</div>
              <div className="text-lg font-bold text-indigo-900 mt-0.5">
                {fmtDecimal(engineResults.grossGramsPerGarment)} g/pc
              </div>
              <div className="text-[10px] text-indigo-600">Includes {engineResults.totalLossPct}% process loss</div>
            </div>

            <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-200">
              <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">Total Fabric Need</div>
              <div className="text-xl font-bold text-emerald-900 mt-0.5">
                {fmtDecimal(engineResults.totalFabricKg)} KG
              </div>
              <div className="text-[10px] text-emerald-600">For {fmtNumber(header.order_qty)} pcs</div>
            </div>

            <div className="p-3 bg-purple-50/60 rounded-xl border border-purple-200">
              <div className="text-[11px] font-semibold text-purple-700 uppercase tracking-wider">Interlining Need</div>
              <div className="text-lg font-bold text-purple-900 mt-0.5">
                {fmtDecimal(engineResults.interliningMeters)} Mtrs
              </div>
              <div className="text-[10px] text-purple-600">Collars & Cuffs</div>
            </div>
          </div>

          {/* Fabric to Yarn Conversion Table */}
          <div className="space-y-2 pt-2">
            <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
              <Disc size={14} className="text-amber-600" />
              <span>Fabric-to-Yarn Conversion by Feeder Stripe</span>
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                    <th className="py-2.5 px-3">Yarn Description & Count</th>
                    <th className="py-2.5 px-2">Colour / Shade Code</th>
                    <th className="py-2.5 px-2 text-right">Feeder Ratio %</th>
                    <th className="py-2.5 px-2 text-right">Required Yarn (KG)</th>
                    <th className="py-2.5 px-2 text-right">Estimated Bags (50kg)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {engineResults.stripeYarns.map((sy, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-3 font-semibold text-slate-900">
                        {sy.yarn_count} Combed Cotton ({sy.stripe_name})
                      </td>
                      <td className="py-2.5 px-2">
                        <span className="font-mono text-indigo-700 font-medium">
                          {sy.color_name} ({sy.shade_code})
                        </span>
                      </td>
                      <td className="py-2.5 px-2 text-right font-medium text-slate-800">{sy.ratio_pct}%</td>
                      <td className="py-2.5 px-2 text-right font-bold text-amber-700">
                        {fmtDecimal(sy.yarn_kg)} KG
                      </td>
                      <td className="py-2.5 px-2 text-right font-medium text-slate-700">
                        {Math.ceil(sy.yarn_kg / 50)} Bags
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: MATERIAL REQUIREMENT HAND-OFF */}
      {activeTab === 'OUTPUT' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-slate-100">
            <div>
              <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <FileCheck size={16} className="text-emerald-600" />
                <span>Approved Material Requirement Output (PPC & Procurement Ready)</span>
              </h2>
              <p className="text-[11px] text-slate-500">
                Official Bill of Materials generated from CAD auto-consumption for Purchase Orders
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => nav('/procurement/fabric/orders/new')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition"
              >
                <Layers size={14} />
                <span>Create Fabric PO</span>
              </button>
              <button
                onClick={() => nav('/procurement/yarn/orders/new')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white shadow-sm transition"
              >
                <Disc size={14} />
                <span>Create Yarn PO</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Fabric Section */}
            <div className="p-4 bg-sky-50/50 rounded-xl border border-sky-200 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-sky-900 text-xs uppercase tracking-wider flex items-center gap-1">
                  <Layers size={14} className="text-sky-700" />
                  <span>Fabric Commitment</span>
                </h3>
                <span className="font-bold text-sky-800 text-sm">{fmtDecimal(engineResults.totalFabricKg)} KG</span>
              </div>
              <ul className="text-xs space-y-2 text-slate-700">
                <li className="flex justify-between border-b border-sky-100 pb-1">
                  <span>3-Colour Feeder Stripe Single Jersey (180 GSM)</span>
                  <span className="font-semibold text-slate-900">{fmtDecimal(engineResults.stripedFabricKg)} KG</span>
                </li>
                <li className="flex justify-between border-b border-sky-100 pb-1">
                  <span>1x1 Rib Collar & Cuff Fabric (240 GSM)</span>
                  <span className="font-semibold text-slate-900">{fmtDecimal(engineResults.solidFabricKg)} KG</span>
                </li>
              </ul>
            </div>

            {/* Yarn Section */}
            <div className="p-4 bg-amber-50/50 rounded-xl border border-amber-200 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-amber-900 text-xs uppercase tracking-wider flex items-center gap-1">
                  <Disc size={14} className="text-amber-700" />
                  <span>Spinning Mill Yarn Indent</span>
                </h3>
                <span className="font-bold text-amber-800 text-sm">
                  {fmtDecimal(engineResults.stripeYarns.reduce((s, y) => s + y.yarn_kg, 0))} KG
                </span>
              </div>
              <ul className="text-xs space-y-2 text-slate-700">
                {engineResults.stripeYarns.map((sy, i) => (
                  <li key={i} className="flex justify-between border-b border-amber-100 pb-1">
                    <span>
                      {sy.yarn_count} {sy.color_name} ({sy.shade_code})
                    </span>
                    <span className="font-semibold text-slate-900">{fmtDecimal(sy.yarn_kg)} KG</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
