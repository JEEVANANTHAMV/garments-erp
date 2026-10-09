import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Sparkles, CheckCircle2, Plus, Trash2, Cpu,
  Layers, Scissors, Disc, FileCheck,
  UploadCloud, Copy, Printer, FileSpreadsheet, GitBranch, Clock
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, Badge } from '../../components/ui';
import { fmtDecimal, fmtNumber, fmtDate, today } from '../../lib/format';
import {
  partKg, withPartWeight, readPartFactor, factorUnitLabel, isKgUom, type PartFactorUnit,
} from '../../lib/partWeight';
import { createPortal } from 'react-dom';
import { MarkerFilesPanel, MarkerThumb, type MarkerFile } from './MarkerFilesPanel';

interface ColorwayRow {
  color_name: string;
  quantities: number[];
  cut_quantities?: number[];
  total_order_pcs?: number;
  total_cut_pcs?: number;
  required_qty?: number;
}

interface CadMarker {
  _key: string;
  id?: number;
  marker_ref: string;
  marker_name: string;
  length_mm: number;
  width_mm: number;
  fabric_dia_type: 'OPEN' | 'TUBE';
  dia_in?: number;
  dia_val?: string;
  dia_spec?: string;
  fabric_id?: number | string;
  fabric_type: string;
  gsm: number;
  direction: string;
  parts_in_lay: string;
  lay_allowance_cm: number;
  width_allowance_in: number;
  rejection_pct?: number;
  fabric_allowance_pct?: number;
  lay_length_cm: number;
  table_width_in: number;
  fabric_wt_per_lay_g: number;
  no_of_pcs_lay: number;
  act_wt_per_pc_g?: number;
  avg_wt_per_pc_g: number;
  act_length_per_pc_cm?: number;
  req_length_per_pc_cm: number;
  total_req_qty: number;
  uom: 'KG' | 'MTR';
  sizes: string[];
  ratios: number[];
  colorways: ColorwayRow[];
}

interface FabricProgramRow {
  fabric_type: string;
  gsm: number;
  dia_spec: string;
  dia_val?: string;
  dia_type?: 'OPEN' | 'TUBE';
  color_name: string;
  order_qty_pcs: number;
  net_qty: number;
  buffer_qty: number;
  sample_qty?: number;
  grand_total_qty: number;
  uom: string;
}

interface TrimItem {
  item_name: string;
  consumption_per_pc: number;
  uom: string;
  total_qty: number;
  remarks: string;
}

/** Flat-knit trim component kinds. Not every garment has a cuff, and extra add-on
 *  components (bottom rib, placket, tipping...) are added as OTHER. */
export type TrimComponentType = 'COLLAR' | 'CUFF' | 'OTHER';

export interface TrimComponent {
  key: string;
  type: TrimComponentType;
  label: string;
  /** Yarn weight per piece of this component, in grams. */
  weight_g: number;
}

export interface ComponentCell {
  dimension: string;
  pcs: number;
}

export interface CollarDimensionRow {
  size: string;
  /** Per-component dimension / piece count, keyed by TrimComponent.key. */
  values?: Record<string, ComponentCell>;
  // Legacy fixed columns — still written (mirrors the first Collar / Cuff component)
  // so older readers and saved sheets keep working.
  collar_dimension?: string;
  collar_pcs?: number;
  cuff_dimension?: string;
  cuff_pcs?: number;
}

export interface FlatKnitSpec {
  enabled: boolean;
  item_type: string;
  color: string;
  gsm: number;
  /** Sum of component weights (grams per garment set). Legacy sheets stored the whole set weight here. */
  weight_per_set_g: number;
  components?: TrimComponent[];
  component_totals?: Record<string, number>;
  size_rows: CollarDimensionRow[];
  total_collar_pcs: number;
  total_cuff_pcs: number;
  total_yarn_kg: number;
  remarks: string;
}

export interface SpecialPartRow {
  part_name: string;
  fabric_type: string;
  gsm?: number;
  dia_spec?: string;
  color: string;
  consumption_per_pc: number;
  uom: string;
  total_qty: number;
  /** Weight factor as entered for non-KG rows (MTRS / PCS); its meaning is set by kg_factor_unit. */
  kg_factor?: number;
  /** PER_KG = m (or pcs) per kg, e.g. draw cord 50 m/kg · G_PER = g per m (or per pc), e.g. 20 g/m. */
  kg_factor_unit?: PartFactorUnit;
  /** Per-kg equivalent (derived). Legacy rows carry only this and are read as PER_KG. */
  qty_per_kg?: number;
  /** Derived purchase weight in KG — see lib/partWeight.ts (recomputed server-side). */
  total_kg?: number;
  remarks: string;
}

const COMPONENT_TYPE_LABEL: Record<TrimComponentType, string> = {
  COLLAR: 'Collar',
  CUFF: 'Cuff',
  OTHER: 'Other Component',
};

/** KG equivalent of a specialized part, or null when a non-KG row has no valid factor (shared calc). */
export const specialPartKg = (sp: SpecialPartRow): number | null => partKg(sp);

const withPartKg = (sp: SpecialPartRow): SpecialPartRow => withPartWeight(sp);

/** "50 m/kg", "20 g/m" ... for read-only displays; null when not set. */
const partFactorText = (sp: SpecialPartRow): string | null => {
  const { factor, unit } = readPartFactor(sp);
  if (!(factor > 0)) return null;
  return `${fmtDecimal(factor, 3)} ${factorUnitLabel(unit, sp.uom)}`;
};

const legacyWeightG = (w: number) => (w > 1 ? w : w * 1000);

/** Recompute component totals, yarn KG and the legacy collar/cuff mirror fields. */
export function recalculateFlatKnit(spec: FlatKnitSpec): FlatKnitSpec {
  const components = spec.components || [];
  const totals: Record<string, number> = {};
  components.forEach((c) => { totals[c.key] = 0; });
  const firstCollar = components.find((c) => c.type === 'COLLAR');
  const firstCuff = components.find((c) => c.type === 'CUFF');

  const size_rows = spec.size_rows.map((r) => {
    const values = { ...(r.values || {}) };
    components.forEach((c) => {
      totals[c.key] += Number(values[c.key]?.pcs) || 0;
    });
    return {
      ...r,
      values,
      collar_dimension: firstCollar ? values[firstCollar.key]?.dimension || '' : '',
      collar_pcs: firstCollar ? Number(values[firstCollar.key]?.pcs) || 0 : 0,
      cuff_dimension: firstCuff ? values[firstCuff.key]?.dimension || '' : '',
      cuff_pcs: firstCuff ? Number(values[firstCuff.key]?.pcs) || 0 : 0,
    };
  });

  const yarnKg = components.reduce((s, c) => s + (totals[c.key] || 0) * (Number(c.weight_g) || 0) / 1000, 0);
  const setWeight = components.reduce((s, c) => s + (Number(c.weight_g) || 0), 0);
  const hasPieces = Object.values(totals).some((cnt) => cnt > 0);
  const isEnabled = spec.enabled || yarnKg > 0 || hasPieces;

  return {
    ...spec,
    enabled: isEnabled,
    components,
    size_rows,
    component_totals: totals,
    weight_per_set_g: Math.round(setWeight * 1000) / 1000,
    total_collar_pcs: components.filter((c) => c.type === 'COLLAR').reduce((s, c) => s + (totals[c.key] || 0), 0),
    total_cuff_pcs: components.filter((c) => c.type === 'CUFF').reduce((s, c) => s + (totals[c.key] || 0), 0),
    total_yarn_kg: Math.round(yarnKg * 100) / 100,
  };
}

/**
 * Bring a saved / imported spec into the component structure. Legacy sheets had fixed
 * Collar + Cuff columns with yarn = collar pcs x set weight, so the collar component
 * inherits the whole set weight and cuff 0 g — totals stay exactly as before.
 */
export function normalizeFlatKnit(spec: FlatKnitSpec): FlatKnitSpec {
  if (spec.components && spec.components.length > 0) return recalculateFlatKnit(spec);
  const rows = spec.size_rows || [];
  const hasCuff = rows.some((r) => (Number(r.cuff_pcs) || 0) > 0 || (r.cuff_dimension || '').trim() !== '');
  const components: TrimComponent[] = [
    { key: 'collar', type: 'COLLAR', label: 'Collar', weight_g: legacyWeightG(Number(spec.weight_per_set_g) || 0) },
  ];
  if (hasCuff) components.push({ key: 'cuff', type: 'CUFF', label: 'Cuff', weight_g: 0 });
  const size_rows = rows.map((r) => {
    const values: Record<string, ComponentCell> = {
      collar: { dimension: r.collar_dimension || '', pcs: Number(r.collar_pcs) || 0 },
    };
    if (hasCuff) values.cuff = { dimension: r.cuff_dimension || '', pcs: Number(r.cuff_pcs) || 0 };
    return { ...r, values };
  });
  return recalculateFlatKnit({ ...spec, components, size_rows });
}

/** An empty marker for a new CAD sheet. */
function blankMarker(): CadMarker {
  return {
    _key: `m_${Date.now()}`, marker_ref: '1A', marker_name: '', length_mm: 0, width_mm: 0, fabric_dia_type: 'OPEN',
    fabric_type: '', gsm: 0, direction: 'ONEWAY', parts_in_lay: '', lay_allowance_cm: 10, width_allowance_in: 2,
    lay_length_cm: 0, table_width_in: 0, fabric_wt_per_lay_g: 0, no_of_pcs_lay: 1, avg_wt_per_pc_g: 0,
    req_length_per_pc_cm: 0, total_req_qty: 0, uom: 'KG', sizes: [], ratios: [], colorways: [],
  };
}

interface CadJob { id: number; job_no: string; buyer_id: number | null; buyer_name?: string; styles: { style_id: number; style_code: string; order_qty: number }[] }

export default function CadRequirementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const styles = useLookup('styles');
  const fabrics = useLookup('fabrics');
  // IO no is picked from the jobs (sales orders); the style list then narrows to the job's styles
  const jobs = useQuery({ queryKey: ['procurement-jobs'], queryFn: async () => (await http.get<{ data: CadJob[] }>('/procurement/jobs')).data ?? [], staleTime: 60_000 });

  const [activeTab, setActiveTab] = useState<'MARKERS' | 'F_PRGM' | 'CUT' | 'TRIMS' | 'OUTPUT' | 'RATIO_PATTI'>('MARKERS');
  const [activeMarkerIdx, setActiveMarkerIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [importing, setImporting] = useState(false);

  // Header State
  const [header, setHeader] = useState({
    req_no: '',
    req_date: today(),
    style_id: '',
    buyer_id: '',
    internal_ir_no: '',
    order_qty: 0,
    cad_type: 'KNIT_SJ' as 'KNIT_SJ' | 'KNIT_FLEECE' | 'WOVEN' | 'MULTI_PART',
    uom: 'KG' as 'KG' | 'MTR',
    cad_version: 'V01',
    rejection_pct: 3.0,
    fabric_allowance_pct: 10.0,
    marker_efficiency: 85,
    special_notes: '',
    status: 'DRAFT',
    remarks: '',
  });
  // marker report PDF / CAD file per marker, with the layout picture (client 05-Oct-2026)
  const [markerFiles, setMarkerFiles] = useState<MarkerFile[]>([]);

  // Markers State — a new CAD starts empty (one blank marker); a saved CAD loads its own markers
  const [markers, setMarkers] = useState<CadMarker[]>([blankMarker()]);

  // Consolidated Fabric Program & Cutting Lay
  const [fabricProgram, setFabricProgram] = useState<FabricProgramRow[]>([]);
  const [cuttingLay, setCuttingLay] = useState<FabricProgramRow[]>([]);

  // Trims, flat-knit collar / cuff and specialized parts — empty on a new CAD (no sample data)
  const [trims, setTrims] = useState<TrimItem[]>([]);
  const [flatKnitSpec, setFlatKnitSpec] = useState<FlatKnitSpec>(() => normalizeFlatKnit({
    enabled: false, item_type: '', color: '', gsm: 0, weight_per_set_g: 0, size_rows: [],
    total_collar_pcs: 0, total_cuff_pcs: 0, total_yarn_kg: 0, remarks: '',
  }));
  const [specialParts, setSpecialParts] = useState<SpecialPartRow[]>([]);
  const [foamKhadaItems, setFoamKhadaItems] = useState<{
    id?: string;
    item_name: string;
    material_spec?: string;
    color?: string;
    width_in?: number | string;
    consumption_per_pc?: number;
    total_mtrs: number;
    remarks?: string;
  }[]>([]);

  const syncSizesFromMarkers = () => {
    if (!markers.length) {
      toast('No markers found to sync sizes from', 'warning');
      return;
    }
    // Garments per size = colour-wise maximum across markers: body and rib markers of the
    // same garment are NOT added together (that doubled the collar / cuff pcs).
    const perColour: Record<string, Record<string, { order: number; cut: number }>> = {};
    markers.forEach((m) => {
      (m.sizes || []).forEach((sz, sIdx) => {
        if (!sz) return;
        (m.colorways || []).forEach((cw) => {
          const c = (cw.color_name || 'Solid').trim().toUpperCase();
          perColour[c] = perColour[c] || {};
          const cur = perColour[c][sz] || { order: 0, cut: 0 };
          const o = Number(cw.quantities?.[sIdx]) || 0;
          const k = Number(cw.cut_quantities?.[sIdx]) || o;
          perColour[c][sz] = { order: Math.max(cur.order, o), cut: Math.max(cur.cut, k) };
        });
      });
    });
    const sizeMap: Record<string, { order: number; cut: number }> = {};
    Object.values(perColour).forEach((sizes) => Object.entries(sizes).forEach(([sz, v]) => {
      if (!sizeMap[sz]) sizeMap[sz] = { order: 0, cut: 0 };
      sizeMap[sz].order += v.order;
      sizeMap[sz].cut += v.cut;
    }));

    const existingRowMap = new Map(flatKnitSpec.size_rows.map((r) => [r.size, r]));
    const comps = flatKnitSpec.components || [];
    const newRows: CollarDimensionRow[] = Object.entries(sizeMap).map(([sz, counts]) => {
      const existing = existingRowMap.get(sz);
      const values: Record<string, ComponentCell> = {};
      comps.forEach((c) => {
        values[c.key] = {
          dimension: existing?.values?.[c.key]?.dimension || `${sz} ${c.label}`,
          pcs: counts.cut || counts.order || 0,
        };
      });
      return { size: sz, values };
    });

    if (newRows.length === 0) {
      toast('No size breakdown found in markers', 'info');
      return;
    }

    const updated = recalculateFlatKnit({
      ...flatKnitSpec,
      size_rows: newRows,
    });
    setFlatKnitSpec(updated);
    toast(`Synced ${newRows.length} sizes with piece counts from CAD markers!`, 'success');
  };

  // Flat-knit components (Collar / Cuff / other add-ons) — selectable per section
  const [newComponentType, setNewComponentType] = useState<TrimComponentType>('CUFF');

  const addFlatKnitComponent = (type: TrimComponentType) => {
    const comps = flatKnitSpec.components || [];
    const sameType = comps.filter((c) => c.type === type).length;
    const base = type === 'OTHER' ? 'Component' : COMPONENT_TYPE_LABEL[type];
    const comp: TrimComponent = {
      key: `c_${Date.now()}`,
      type,
      label: sameType > 0 || type === 'OTHER' ? `${base} ${sameType + 1}` : base,
      weight_g: 0,
    };
    setFlatKnitSpec(recalculateFlatKnit({
      ...flatKnitSpec,
      components: [...comps, comp],
      size_rows: flatKnitSpec.size_rows.map((r) => ({
        ...r,
        values: { ...(r.values || {}), [comp.key]: { dimension: '', pcs: 0 } },
      })),
    }));
  };

  const updateFlatKnitComponent = (key: string, patch: Partial<TrimComponent>) => {
    setFlatKnitSpec(recalculateFlatKnit({
      ...flatKnitSpec,
      components: (flatKnitSpec.components || []).map((c) => {
        if (c.key !== key) return c;
        const next = { ...c, ...patch };
        // Changing the type renames an untouched default label
        if (patch.type && patch.label === undefined && c.label === COMPONENT_TYPE_LABEL[c.type]) {
          next.label = COMPONENT_TYPE_LABEL[patch.type];
        }
        return next;
      }),
    }));
  };

  const removeFlatKnitComponent = (key: string) => {
    setFlatKnitSpec(recalculateFlatKnit({
      ...flatKnitSpec,
      components: (flatKnitSpec.components || []).filter((c) => c.key !== key),
      size_rows: flatKnitSpec.size_rows.map((r) => {
        const values = { ...(r.values || {}) };
        delete values[key];
        return { ...r, values };
      }),
    }));
  };

  const setFlatKnitCell = (rowIdx: number, key: string, patch: Partial<ComponentCell>) => {
    const size_rows = flatKnitSpec.size_rows.map((r, i) => {
      if (i !== rowIdx) return r;
      const cur = r.values?.[key] || { dimension: '', pcs: 0 };
      return { ...r, values: { ...(r.values || {}), [key]: { ...cur, ...patch } } };
    });
    setFlatKnitSpec(recalculateFlatKnit({ ...flatKnitSpec, size_rows }));
  };

  /**
   * Mens / Boys presets — same meaning as before components existed: yarn = counted
   * collar pcs x set weight. The whole set weight goes on the primary counted component
   * (the first Collar, else the first component); other components keep their weights.
   */
  const applyFlatKnitPreset = (setWeightG: number, remarks: string) => {
    let comps = flatKnitSpec.components || [];
    let size_rows = flatKnitSpec.size_rows;
    if (comps.length === 0) {
      comps = [{ key: 'collar', type: 'COLLAR', label: 'Collar', weight_g: 0 }];
      size_rows = size_rows.map((r) => ({
        ...r,
        values: { ...(r.values || {}), collar: r.values?.collar || { dimension: '', pcs: 0 } },
      }));
    }
    const primary = comps.find((c) => c.type === 'COLLAR') || comps[0];
    const components = comps.map((c) => (c.key === primary.key ? { ...c, weight_g: setWeightG } : c));
    const updated = recalculateFlatKnit({ ...flatKnitSpec, components, size_rows, remarks });
    setFlatKnitSpec(updated);
    return { updated, primary };
  };

  const curJob = (jobs.data ?? []).find((j) => j.job_no === header.internal_ir_no);
  const jobStyles = curJob?.styles ?? [];
  const pickJob = (jobNo: string) => {
    const j = (jobs.data ?? []).find((x) => x.job_no === jobNo);
    setHeader((p) => {
      const keep = j?.styles.find((st) => String(st.style_id) === p.style_id);
      const st = keep ?? (j?.styles.length === 1 ? j.styles[0] : undefined);
      return {
        ...p, internal_ir_no: jobNo,
        buyer_id: j?.buyer_id ? String(j.buyer_id) : p.buyer_id,
        style_id: st ? String(st.style_id) : (j ? '' : p.style_id),
        order_qty: st?.order_qty || p.order_qty,
      };
    });
  };
  const pickStyle = (styleId: string) => {
    const st = jobStyles.find((x) => String(x.style_id) === styleId);
    setHeader((p) => ({ ...p, style_id: styleId, order_qty: st?.order_qty || p.order_qty }));
  };

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
        buyer_id: existingData.buyer_id ? String(existingData.buyer_id) : '',
        internal_ir_no: existingData.internal_ir_no || '',
        order_qty: Number(existingData.order_qty) || 1000,
        cad_type: existingData.cad_type || 'KNIT_SJ',
        uom: existingData.uom || (existingData.cad_type === 'WOVEN' ? 'MTR' : 'KG'),
        cad_version: existingData.cad_version || 'V01',
        rejection_pct: Number(existingData.rejection_pct ?? 3.0),
        fabric_allowance_pct: Number(existingData.fabric_allowance_pct ?? 10.0),
        marker_efficiency: Number(existingData.marker_efficiency) || 85,
        special_notes: existingData.special_notes || '',
        status: existingData.status || 'DRAFT',
        remarks: existingData.remarks || '',
      });
      setMarkerFiles(Array.isArray(existingData.marker_files) ? existingData.marker_files : []);

      if (existingData.markers?.length) {
        setMarkers(
          existingData.markers.map((m: any, idx: number) => ({
            _key: `m_${m.id || idx}`,
            id: m.id,
            marker_ref: m.marker_ref || `M${idx + 1}`,
            marker_name: m.marker_name || `Marker ${m.marker_ref || idx + 1}`,
            length_mm: Number(m.length_mm) || 0,
            width_mm: Number(m.width_mm) || 0,
            fabric_dia_type: m.fabric_dia_type || 'OPEN',
            fabric_type: m.fabric_type || 'Main Fabric',
            gsm: Number(m.gsm) || 160,
            direction: m.direction || 'ONEWAY',
            parts_in_lay: m.parts_in_lay || '',
            lay_allowance_cm: Number(m.lay_allowance_cm ?? 10.0),
            width_allowance_in: Number(m.width_allowance_in ?? (m.fabric_dia_type === 'TUBE' ? 1.0 : 2.0)),
            rejection_pct: m.rejection_pct != null ? Number(m.rejection_pct) : Number(existingData.rejection_pct ?? 3.0),
            fabric_allowance_pct: m.fabric_allowance_pct != null ? Number(m.fabric_allowance_pct) : Number(existingData.fabric_allowance_pct ?? 10.0),
            // dia_in = actual fabric dia (NOT table width). If never stored, derive from table_width_in - allowance.
            dia_in: m.dia_in != null ? Number(m.dia_in) : (
              m.table_width_in
                ? Math.max(0, Math.round(Number(m.table_width_in) - Number(m.width_allowance_in ?? (m.fabric_dia_type === 'TUBE' ? 1.0 : 2.0))))
                : (m.width_mm ? Math.round(Number(m.width_mm) / 25.4) : undefined)
            ),
            dia_val: m.dia_val || (m.dia_in ? `${m.dia_in}"` : undefined),
            dia_spec: m.dia_spec || (m.dia_in ? `${m.dia_in}" ${m.fabric_dia_type || 'OPEN'}` : undefined),
            lay_length_cm: Number(m.lay_length_cm) || 0,
            table_width_in: Number(m.table_width_in) || 0,
            fabric_wt_per_lay_g: Number(m.fabric_wt_per_lay_g) || 0,
            no_of_pcs_lay: Number(m.no_of_pcs_lay) || 1,
            act_wt_per_pc_g: Number(m.act_wt_per_pc_g) || 0,
            avg_wt_per_pc_g: Number(m.avg_wt_per_pc_g) || 0,
            act_length_per_pc_cm: Number(m.act_length_per_pc_cm) || 0,
            req_length_per_pc_cm: Number(m.req_length_per_pc_cm) || 0,
            total_req_qty: Number(m.total_req_qty) || 0,
            uom: m.uom || existingData.uom || 'KG',
            sizes: Array.isArray(m.sizes) ? m.sizes : ['S', 'M', 'L'],
            ratios: Array.isArray(m.ratios) ? m.ratios : [1, 2, 1],
            colorways: Array.isArray(m.colorways) ? m.colorways : [],
          }))
        );
      }

      if (existingData.fabric_program?.length) {
        setFabricProgram(existingData.fabric_program);
      }
      if (existingData.cutting_lay?.length) {
        setCuttingLay(existingData.cutting_lay);
      }

      if (existingData.flat_knit_spec) {
        setFlatKnitSpec(normalizeFlatKnit(existingData.flat_knit_spec));
      } else if (existingData.dataJson?.flat_knit_spec) {
        setFlatKnitSpec(normalizeFlatKnit(existingData.dataJson.flat_knit_spec));
      }

      if (existingData.special_parts?.length) {
        setSpecialParts(existingData.special_parts.map(withPartKg));
      } else if (existingData.dataJson?.special_parts?.length) {
        setSpecialParts(existingData.dataJson.special_parts.map(withPartKg));
      }

      if (existingData.trims?.length) {
        setTrims(existingData.trims);
      } else if (existingData.dataJson?.trims?.length) {
        setTrims(existingData.dataJson.trims);
      }

      if (existingData.foam_khada_items?.length) {
        setFoamKhadaItems(existingData.foam_khada_items);
      } else if (existingData.dataJson?.foam_khada_items?.length) {
        setFoamKhadaItems(existingData.dataJson.foam_khada_items);
      }
    }
  }, [existingData, isNew]);

  // Active Marker shortcut
  const activeMarker = markers[activeMarkerIdx] || markers[0];

  // Mathematical Engine (Pure Reactive Client-side Calculation)
  const isWoven = header.cad_type === 'WOVEN' || header.uom === 'MTR';

  const runCalculation = () => {
    setCalculating(true);
    try {
      const updatedMarkers = markers.map((m) => {
        const lengthMm = Number(m.length_mm) || 0;
        const widthMm = Number(m.width_mm) || 0;
        const diaType = m.fabric_dia_type === 'TUBE' ? 'TUBE' : 'OPEN';
        const gsm = Number(m.gsm) || 160;

        const layAllowance = Number(m.lay_allowance_cm ?? 10.0);
        const widthAllowance = Number(m.width_allowance_in ?? (diaType === 'TUBE' ? 1.0 : 2.0));
        const markerIsWoven = (m.uom === 'MTR') || isWoven;
        const markerRejectionPct = m.rejection_pct != null ? Number(m.rejection_pct) : Number(header.rejection_pct ?? 3.0);
        const markerFabAllowancePct = m.fabric_allowance_pct != null ? Number(m.fabric_allowance_pct) : Number(header.fabric_allowance_pct ?? 10.0);

        // Lay length in cm: (Length mm / 10) + allowance
        const layLenCm = Math.round(((lengthMm / 10.0) + layAllowance) * 10) / 10;
        // Marker actual dia in inches:
        const actualDiaIn = Number(m.dia_in) > 0 ? Number(m.dia_in) : (widthMm > 0 ? Math.round(widthMm / 25.4) : 0);
        // Table width in inches: (actual dia or width mm / 25.4) + width allowance (+2")
        const tblWidthIn = Math.round(((actualDiaIn > 0 ? actualDiaIn : (widthMm / 25.4)) + widthAllowance) * 100) / 100;
        const diaIn = actualDiaIn > 0 ? actualDiaIn : (tblWidthIn > widthAllowance ? Math.round(tblWidthIn - widthAllowance) : 0);
        const diaVal = `${diaIn}"`;
        const diaSpec = `${diaVal} ${diaType}`;

        const sumRatios = m.ratios.reduce((a, b) => a + (Number(b) || 0), 0);

        let fabricWtLay = 0;
        let pcsLay = 1;
        let actWtPc = 0;
        let avgWtPc = 0;
        let actLenPc = 0;
        let reqLenPc = 0;

        if (!markerIsWoven) {
          const layerMult = diaType === 'TUBE' ? 2 : 1;
          fabricWtLay = Math.round(((layLenCm * (tblWidthIn * 2.54) * gsm / 10000.0) * layerMult) * 1000) / 1000;
          pcsLay = Math.max(1, sumRatios * layerMult);
          actWtPc = Math.round((fabricWtLay / pcsLay) * 10000) / 10000;
          avgWtPc = Math.round((actWtPc * (1 + (markerFabAllowancePct / 100.0))) * 10000) / 10000;
        } else {
          pcsLay = Math.max(1, sumRatios);
          actLenPc = Math.round((layLenCm / pcsLay) * 10000) / 10000;
          reqLenPc = Math.round((actLenPc * (1 + (markerFabAllowancePct / 100.0))) * 10000) / 10000;
        }

        let markerTotalReq = 0;
        const updatedColorways = m.colorways.map((cw) => {
          const qtys = (cw.quantities || []).map((q) => Number(q) || 0);
          const cutQtys = qtys.map((q) => Math.ceil(q * (1 + (markerRejectionPct / 100.0))));
          const totOrder = qtys.reduce((a, b) => a + b, 0);
          const totCut = cutQtys.reduce((a, b) => a + b, 0);

          let reqQty = 0;
          if (!markerIsWoven) {
            reqQty = Math.round(((avgWtPc * totCut) / 1000.0) * 1000) / 1000;
          } else {
            reqQty = Math.round(((reqLenPc * totCut) / 100.0) * 1000) / 1000;
          }

          markerTotalReq += reqQty;

          return {
            ...cw,
            quantities: qtys,
            cut_quantities: cutQtys,
            total_order_pcs: totOrder,
            total_cut_pcs: totCut,
            required_qty: reqQty,
          };
        });

        const markerUom = markerIsWoven ? 'MTR' : (m.uom || 'KG');
        return {
          ...m,
          uom: markerUom,
          lay_length_cm: layLenCm,
          table_width_in: tblWidthIn,
          dia_in: diaIn,
          dia_val: diaVal,
          dia_spec: diaSpec,
          rejection_pct: markerRejectionPct,
          fabric_allowance_pct: markerFabAllowancePct,
          fabric_wt_per_lay_g: fabricWtLay,
          no_of_pcs_lay: pcsLay,
          act_wt_per_pc_g: actWtPc,
          avg_wt_per_pc_g: avgWtPc,
          act_length_per_pc_cm: actLenPc,
          req_length_per_pc_cm: reqLenPc,
          total_req_qty: Math.round(markerTotalReq * 100) / 100,
          colorways: updatedColorways,
        };
      });

      setMarkers(updatedMarkers);

      // Consolidate Fabric Program (F.PRGM) & Cutting Lay (CUT)
      const fabMap: Record<string, any> = {};
      updatedMarkers.forEach((m) => {
        const markerIsWoven = m.uom === 'MTR' || isWoven;
        const tableDiaIn = Math.round(m.table_width_in || ((m.dia_in || 0) + (m.width_allowance_in || 2)));
        const diaV = `${tableDiaIn}"`;
        const diaT = m.fabric_dia_type === 'TUBE' ? 'TUBE' : 'OPEN';
        const mUom = m.uom || (markerIsWoven ? 'MTR' : 'KG');
        const key = `${m.fabric_type || 'Main Fabric'}_${markerIsWoven ? 0 : (m.gsm || 0)}_${diaV}_${diaT}_${mUom}`;
        if (!fabMap[key]) {
          fabMap[key] = {
            fabric_type: m.fabric_type || 'Main Fabric',
            gsm: markerIsWoven ? 0 : (m.gsm || 160),
            dia_val: diaV,
            dia_type: diaT,
            dia_spec: `${diaV} ${diaT}`,
            uom: mUom,
            colorways: {},
          };
        }
        m.colorways.forEach((cw) => {
          const cName = cw.color_name || 'Solid';
          if (!fabMap[key].colorways[cName]) {
            fabMap[key].colorways[cName] = { order_pcs: 0, cut_pcs: 0, net_qty: 0 };
          }
          fabMap[key].colorways[cName].order_pcs += Number(cw.total_order_pcs) || 0;
          fabMap[key].colorways[cName].cut_pcs += Number(cw.total_cut_pcs) || 0;
          fabMap[key].colorways[cName].net_qty += Number(cw.required_qty) || 0;
        });
      });

      const fpLines: FabricProgramRow[] = [];
      const cutLines: FabricProgramRow[] = [];

      Object.values(fabMap).forEach((fab: any) => {
        Object.entries(fab.colorways).forEach(([cName, d]: [string, any]) => {
          const existingFp = fabricProgram.find(
            (p) => p.fabric_type === fab.fabric_type && p.color_name === cName && p.dia_val === fab.dia_val
          );
          const sample = Number(existingFp?.sample_qty || 0);
          const net = Math.round(d.net_qty * 10) / 10;
          const roundedNet = Math.ceil(net);
          const buffer = Math.max(1, Math.round(roundedNet * 0.02));
          const grand = roundedNet + buffer + sample;

          fpLines.push({
            fabric_type: fab.fabric_type,
            gsm: fab.gsm,
            dia_val: fab.dia_val,
            dia_type: fab.dia_type,
            dia_spec: fab.dia_spec,
            color_name: cName,
            order_qty_pcs: d.order_pcs,
            net_qty: net,
            buffer_qty: buffer,
            sample_qty: sample,
            grand_total_qty: grand,
            uom: fab.uom || (isWoven ? 'MTR' : 'KG'),
          });

          const cuttingLossPct = header.fabric_allowance_pct !== undefined && header.fabric_allowance_pct !== null
            ? Number(header.fabric_allowance_pct)
            : (isWoven ? 2.0 : 12.0);
          const cuttingNet = Math.round(grand * (1 - (cuttingLossPct / 100.0)) * 100) / 100;

          cutLines.push({
            fabric_type: fab.fabric_type,
            gsm: fab.gsm,
            dia_val: fab.dia_val,
            dia_type: fab.dia_type,
            dia_spec: fab.dia_spec,
            color_name: cName,
            order_qty_pcs: d.cut_pcs,
            net_qty: cuttingNet,
            buffer_qty: 0,
            grand_total_qty: cuttingNet,
            uom: fab.uom || (isWoven ? 'MTR' : 'KG'),
          });
        });
      });

      setFabricProgram(fpLines);
      setCuttingLay(cutLines);
      setHeader((p) => ({ ...p, status: 'CALCULATED' }));
      toast('CAD consumption calculation completed successfully!', 'success');
    } catch {
      toast('Calculation failed', 'error');
    } finally {
      setCalculating(false);
    }
  };

  /**
   * Fabric meterage of a knitted F.PRGM row: processes such as compacting are
   * measured and charged in metres, so the KG indent is also shown in metres.
   * m = KG × 1000 ÷ (GSM × width in m); tubular fabric has two layers (width × 2).
   */
  const fabricMeterage = (fp: { grand_total_qty?: number | string; gsm?: number | string; dia_val?: string; dia_spec?: string; dia_type?: string }) => {
    if (isWoven) return null;
    const kg = Number(fp.grand_total_qty) || 0;
    const gsm = Number(fp.gsm) || 0;
    const dia = parseFloat(String(fp.dia_val || fp.dia_spec || '').replace(/[^0-9.]/g, '')) || 0;
    const tube = fp.dia_type === 'TUBE' || String(fp.dia_spec || '').includes('TUBE');
    const widthM = dia * 0.0254 * (tube ? 2 : 1);
    if (!(kg > 0 && gsm > 0 && widthM > 0)) return null;
    return Math.round((kg * 1000) / (gsm * widthM));
  };

  // Grand KPI Metrics
  const summaryKpis = useMemo(() => {
    // Order qty in garments, from the main fabric only (the first marker's fabric): per colour × size
    // the largest marker quantity, summed. Body + rib / collar markers of the same garment must not add
    // up (4900 + 4900 is not 9800) — a rib often carries its own colour name, so other fabrics are
    // accessories of the same order quantity (client call 29-Sep-2026). Body markers split by size add.
    const mainFabric = (markers[0]?.fabric_type || '').trim().toUpperCase();
    const cellPcs: Record<string, number> = {};
    markers.filter((m) => (m.fabric_type || '').trim().toUpperCase() === mainFabric).forEach((m) => (m.colorways || []).forEach((cw) => {
      const c = (cw.color_name || 'Solid').trim().toUpperCase();
      (cw.quantities || []).forEach((q, i) => {
        const k = `${c}|${String(m.sizes?.[i] ?? i).trim().toUpperCase()}`;
        cellPcs[k] = Math.max(cellPcs[k] || 0, Number(q) || 0);
      });
    }));
    const totalOrderPcs = Object.values(cellPcs).reduce((a, b) => a + b, 0) || header.order_qty;

    // Separate Knitted Fabric (KG) and Woven / Foam Interlinings (MTR)
    const grandFabricKg = fabricProgram.length > 0
      ? fabricProgram.filter((f) => f.uom !== 'MTR').reduce((sum, f) => sum + Number(f.grand_total_qty || 0), 0)
      : markers.filter((m) => m.uom !== 'MTR').reduce((sum, m) => sum + Number(m.total_req_qty || 0), 0);

    const grandFabricMtr = fabricProgram.length > 0
      ? fabricProgram.filter((f) => f.uom === 'MTR').reduce((sum, f) => sum + Number(f.grand_total_qty || 0), 0)
      : markers.filter((m) => m.uom === 'MTR').reduce((sum, m) => sum + Number(m.total_req_qty || 0), 0);

    const totalFoamKhadaMtrs = foamKhadaItems.reduce((sum, fk) => sum + (Number(fk.total_mtrs) || 0), 0);

    // Fabric loss % entered on this document is taken OFF the knitted fabric to give the actual piece weight
    const lossPct = header.fabric_allowance_pct != null && !isNaN(Number(header.fabric_allowance_pct))
      ? Number(header.fabric_allowance_pct)
      : (markers.length > 0 && markers[0].fabric_allowance_pct != null ? Number(markers[0].fabric_allowance_pct) : 0);
    // For Knitted garments: piece weight is strictly based on Knitted Fabric (KG). MTR (Foam / Khada) is strictly excluded!
    const avgGarmentCons = totalOrderPcs > 0 ? ((isWoven ? grandFabricMtr : grandFabricKg) / totalOrderPcs) : 0;
    const actGarmentCons = avgGarmentCons * (1 - lossPct / 100.0);

    const collarYarnKg = (flatKnitSpec.enabled || Number(flatKnitSpec.total_yarn_kg || 0) > 0) ? Number(flatKnitSpec.total_yarn_kg || 0) : 0;
    const foldingFabricKg = specialParts
      .filter((p) => isKgUom(p.uom))
      .reduce((sum, p) => sum + (Number(p.total_qty) || 0), 0);
    const totalTapesMtrs = specialParts
      .filter((p) => p.uom === 'MTRS')
      .reduce((sum, p) => sum + (Number(p.total_qty) || 0), 0);
    // Tapes / cords / PCS items bought by weight: MTRS (or PCS) / qty-per-KG factor
    const nonKgParts = specialParts.filter((p) => !isKgUom(p.uom));
    const tapesKg = Math.round(nonKgParts.reduce((sum, p) => sum + (specialPartKg(p) || 0), 0) * 1000) / 1000;
    const partsMissingKgFactor = nonKgParts.filter((p) => specialPartKg(p) == null && (Number(p.total_qty) || 0) > 0).length;
    const partsKg = Math.round((collarYarnKg + foldingFabricKg + tapesKg) * 1000) / 1000;

    const grandTotalMaterial = isWoven
      ? Math.round(grandFabricMtr * 100) / 100
      : Math.round((grandFabricKg + partsKg) * 100) / 100;

    // Average per piece from the bottom totals — knitted fabric PLUS collar/cuff yarn, foldings, tapes & cords
    const partsKgPerPc = totalOrderPcs > 0 ? partsKg / totalOrderPcs : 0;
    const avgConsInclParts = totalOrderPcs > 0
      ? (isWoven ? avgGarmentCons : grandTotalMaterial / totalOrderPcs)
      : 0;
    // Actual piece weight = average piece weight less the fabric loss % on the fabric part only.
    const actualPieceWt = totalOrderPcs > 0
      ? (isWoven ? actGarmentCons : actGarmentCons + partsKg / totalOrderPcs)
      : 0;

    return {
      totalOrderPcs,
      grandFabric: Math.round((isWoven ? grandFabricMtr : grandFabricKg) * 100) / 100,
      grandFabricKg: Math.round(grandFabricKg * 100) / 100,
      grandFabricMtr: Math.round((grandFabricMtr + totalFoamKhadaMtrs) * 100) / 100,
      totalFoamKhadaMtrs: Math.round(totalFoamKhadaMtrs * 100) / 100,
      avgGarmentCons: Math.round(avgGarmentCons * 10000) / 10000,
      actGarmentCons: Math.round(actGarmentCons * 10000) / 10000,
      collarYarnKg,
      foldingFabricKg,
      totalTapesMtrs,
      tapesKg,
      partsKg,
      partsMissingKgFactor,
      partsKgPerPc: Math.round(partsKgPerPc * 100000) / 100000,
      avgConsInclParts: Math.round(avgConsInclParts * 100000) / 100000,
      actualPieceWt: Math.round(actualPieceWt * 100000) / 100000,
      lossPct,
      grandTotalMaterial,
      uom: isWoven ? 'MTR' : 'KG',
    };
  }, [markers, fabricProgram, header.order_qty, header.fabric_allowance_pct, isWoven, flatKnitSpec, specialParts, foamKhadaItems]);

  // Marker Operations
  const addMarker = () => {
    const nextRef = `${markers.length + 1}A`;
    const newM: CadMarker = {
      _key: `m_${Date.now()}`,
      marker_ref: nextRef,
      marker_name: `${header.req_no || 'CAD'} ${nextRef}`,
      length_mm: 2000,
      width_mm: 1500,
      fabric_dia_type: 'OPEN',
      fabric_type: markers[0]?.fabric_type || 'Single Jersey',
      gsm: markers[0]?.gsm || 160,
      direction: 'ONEWAY',
      parts_in_lay: 'PARTS',
      lay_allowance_cm: 10,
      width_allowance_in: 2,
      lay_length_cm: 210,
      table_width_in: 61,
      fabric_wt_per_lay_g: 0,
      no_of_pcs_lay: 1,
      avg_wt_per_pc_g: 0,
      req_length_per_pc_cm: 0,
      total_req_qty: 0,
      uom: isWoven ? 'MTR' : 'KG',
      sizes: markers[0]?.sizes ? [...markers[0].sizes] : ['S', 'M', 'L'],
      ratios: markers[0]?.ratios ? [...markers[0].ratios] : [1, 1, 1],
      colorways: markers[0]?.colorways ? JSON.parse(JSON.stringify(markers[0].colorways)) : [
        { color_name: 'Color 1', quantities: [100, 200, 100] }
      ],
    };
    setMarkers([...markers, newM]);
    setActiveMarkerIdx(markers.length);
    toast(`Marker ${nextRef} added`, 'info');
  };

  const duplicateActiveMarker = () => {
    if (!activeMarker) return;
    const nextRef = `${activeMarker.marker_ref}_COPY`;
    const dup: CadMarker = {
      ...JSON.parse(JSON.stringify(activeMarker)),
      _key: `m_${Date.now()}`,
      marker_ref: nextRef,
      marker_name: `${activeMarker.marker_name} (Copy)`,
    };
    delete dup.id;
    setMarkers([...markers, dup]);
    setActiveMarkerIdx(markers.length);
    toast(`Marker duplicated as ${nextRef}`, 'info');
  };

  const removeActiveMarker = () => {
    if (markers.length <= 1) {
      toast('At least one marker is required', 'warning');
      return;
    }
    const copy = markers.filter((_, i) => i !== activeMarkerIdx);
    setMarkers(copy);
    setActiveMarkerIdx(Math.max(0, activeMarkerIdx - 1));
    toast('Marker removed', 'info');
  };

  // colourways are picked from the IO's sales order colours (client 05-Oct-2026: typed colours mismatch the order)
  const jobColours = useQuery({
    queryKey: ['cad-job-colours', header.internal_ir_no, header.style_id],
    queryFn: async () => (await http.get<{ data: any[] }>('/cad-requirements/job-colours', { io_no: header.internal_ir_no, style_id: header.style_id || undefined })).data ?? [],
    enabled: !!header.internal_ir_no,
    staleTime: 60_000,
  });

  // sales order size breakdown & pure order quantities (without excess)
  const jobBreakdown = useQuery({
    queryKey: ['cad-job-breakdown', header.internal_ir_no, header.style_id],
    queryFn: async () => (await http.get<{ data: any }>('/cad-requirements/job-breakdown', { io_no: header.internal_ir_no, style_id: header.style_id || undefined })).data,
    enabled: !!header.internal_ir_no,
    staleTime: 60_000,
  });

  const syncOrderBreakdownToMarker = () => {
    const b = jobBreakdown.data;
    if (!b?.sizes?.length) {
      toast('No sizes or lines found on this sales order', 'warning');
      return;
    }
    const sizes = b.sizes.map(String);
    const ratios = sizes.map(() => 1);
    const colorways = (b.colorways?.length ? b.colorways : [{ color_name: 'Solid', quantities: sizes.map(() => 0) }]).map((cw: any) => ({
      color_name: cw.color_name,
      quantities: (cw.quantities || []).map((q: any) => Number(q) || 0),
    }));
    updateActiveMarker({ sizes, ratios, colorways });
    if (b.total_order_qty > 0) {
      setHeader((p) => ({ ...p, order_qty: b.total_order_qty }));
    }
    toast(`Loaded ${sizes.length} sizes and pure order quantities from Sales Order`, 'success');
  };

  /** Fill the active marker from its marker report (width, length, ratio, garments per marker) + the CAD efficiency. */
  const applyMarkerReport = (p: NonNullable<MarkerFile['parsed']>) => {
    if (!activeMarker) return;
    const patch: Partial<CadMarker> = {};
    if (p.marker_length_m) patch.length_mm = Math.round(p.marker_length_m * 1000);
    if (p.marker_width_in) patch.width_mm = Math.round(p.marker_width_in * 25.4 * 10) / 10;
    if (p.ratio_sizes?.length && p.ratios?.length) {
      const sizes = p.ratio_sizes.map(String);
      patch.sizes = sizes;
      patch.ratios = p.ratios.map(Number);
      // keep each colourway's quantities for the sizes that stay
      patch.colorways = (activeMarker.colorways || []).map((cw) => ({
        ...cw,
        quantities: sizes.map((sz) => { const i = (activeMarker.sizes || []).findIndex((x) => String(x).toUpperCase() === sz.toUpperCase()); return i >= 0 ? Number(cw.quantities?.[i]) || 0 : 0; }),
        cut_quantities: undefined as any,
      }));
    }
    if (p.garments_per_marker) patch.no_of_pcs_lay = p.garments_per_marker;
    updateActiveMarker(patch);
    if (p.efficiency_pct) setHeader((h) => ({ ...h, marker_efficiency: Number(p.efficiency_pct) }));
    toast(`Marker ${activeMarker.marker_ref} filled from the marker report — check the colour quantities and Save`, 'success');
  };

  const recomputeSingleMarker = (m: CadMarker) => {
    const lengthMm = Number(m.length_mm) || 0;
    const widthMm = Number(m.width_mm) || 0;
    const diaType = m.fabric_dia_type === 'TUBE' ? 'TUBE' : 'OPEN';
    const gsm = Number(m.gsm) || 160;

    const layAllowance = Number(m.lay_allowance_cm ?? 10.0);
    const widthAllowance = Number(m.width_allowance_in ?? (diaType === 'TUBE' ? 1.0 : 2.0));
    const markerIsWoven = (m.uom === 'MTR') || isWoven;
    const markerRejectionPct = m.rejection_pct != null ? Number(m.rejection_pct) : Number(header.rejection_pct ?? 3.0);
    const markerFabAllowancePct = m.fabric_allowance_pct != null ? Number(m.fabric_allowance_pct) : Number(header.fabric_allowance_pct ?? 10.0);

    const layLenCm = Math.round(((lengthMm / 10.0) + layAllowance) * 10) / 10;
    // dia_in = actual fabric dia (e.g. 58"). Table width = actual dia + allowance (e.g. 58 + 2 = 60").
    const actualDiaIn = Number(m.dia_in) > 0 ? Number(m.dia_in) : (widthMm > 0 ? Math.round(widthMm / 25.4) : 0);
    const tblWidthIn = Math.round(((actualDiaIn > 0 ? actualDiaIn : (widthMm / 25.4)) + widthAllowance) * 100) / 100;
    const diaIn = actualDiaIn > 0 ? actualDiaIn : (tblWidthIn > widthAllowance ? Math.round(tblWidthIn - widthAllowance) : 0);
    const diaVal = diaIn > 0 ? `${diaIn}"` : '';
    const diaSpec = diaVal ? `${diaVal} ${diaType}` : '';

    const sumRatios = (m.ratios || []).reduce((a, b) => a + (Number(b) || 0), 0);

    let fabricWtLay = 0;
    let pcsLay = 1;
    let actWtPc = 0;
    let avgWtPc = 0;
    let actLenPc = 0;
    let reqLenPc = 0;

    if (!markerIsWoven) {
      const layerMult = diaType === 'TUBE' ? 2 : 1;
      fabricWtLay = Math.round(((layLenCm * (tblWidthIn * 2.54) * gsm / 10000.0) * layerMult) * 1000) / 1000;
      pcsLay = Math.max(1, sumRatios * layerMult);
      actWtPc = Math.round((fabricWtLay / pcsLay) * 10000) / 10000;
      avgWtPc = Math.round((actWtPc * (1 + (markerFabAllowancePct / 100.0))) * 10000) / 10000;
    } else {
      pcsLay = Math.max(1, sumRatios);
      actLenPc = Math.round((layLenCm / pcsLay) * 10000) / 10000;
      reqLenPc = Math.round((actLenPc * (1 + (markerFabAllowancePct / 100.0))) * 10000) / 10000;
    }

    let markerTotalReq = 0;
    const updatedColorways = (m.colorways || []).map((cw) => {
      const qtys = (cw.quantities || []).map((q) => Number(q) || 0);
      const cutQtys = qtys.map((q) => Math.ceil(q * (1 + (markerRejectionPct / 100.0))));
      const totOrder = qtys.reduce((a, b) => a + b, 0);
      const totCut = cutQtys.reduce((a, b) => a + b, 0);

      let reqQty = 0;
      if (!markerIsWoven) {
        reqQty = Math.round(((avgWtPc * totCut) / 1000.0) * 1000) / 1000;
      } else {
        reqQty = Math.round(((reqLenPc * totCut) / 100.0) * 1000) / 1000;
      }

      markerTotalReq += reqQty;

      return {
        ...cw,
        quantities: qtys,
        cut_quantities: cutQtys,
        total_order_pcs: totOrder,
        total_cut_pcs: totCut,
        required_qty: reqQty,
      };
    });

    const markerUom = markerIsWoven ? 'MTR' : (m.uom || 'KG');
    return {
      ...m,
      uom: markerUom,
      lay_length_cm: layLenCm,
      table_width_in: tblWidthIn,
      dia_in: diaIn,
      dia_val: diaVal,
      dia_spec: diaSpec,
      rejection_pct: markerRejectionPct,
      fabric_allowance_pct: markerFabAllowancePct,
      fabric_wt_per_lay_g: fabricWtLay,
      no_of_pcs_lay: pcsLay,
      act_wt_per_pc_g: actWtPc,
      avg_wt_per_pc_g: avgWtPc,
      act_length_per_pc_cm: actLenPc,
      req_length_per_pc_cm: reqLenPc,
      total_req_qty: Math.round(markerTotalReq * 100) / 100,
      colorways: updatedColorways,
    };
  };

  const updateActiveMarker = (updates: Partial<CadMarker>) => {
    setMarkers((prev) => {
      const copy = [...prev];
      const merged = { ...copy[activeMarkerIdx], ...updates };
      copy[activeMarkerIdx] = recomputeSingleMarker(merged);
      return copy;
    });
  };

  // Excel Direct File Import
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const bstr = evt.target?.result;
        if (!bstr) return;

        const wb = XLSX.read(bstr, { type: 'binary', cellFormula: true, cellNF: true });
        const summarySheetName = wb.SheetNames.find((s) => s === 'F.PRGM' || s === 'FABRIC');
        const markerSheetNames = wb.SheetNames.filter((s) => s !== 'F.PRGM' && s !== 'FABRIC' && s !== 'CUT');

        if (markerSheetNames.length === 0) {
          toast('No marker sheets found in Excel file', 'error');
          setImporting(false);
          return;
        }

        const firstMarker = wb.Sheets[markerSheetNames[0]];
        const getV = (c: string) => firstMarker[c]?.v ?? '';

        const styleCode = String(getV('B1')).trim();
        const buyerName = String(getV('B3')).trim();
        const reqDate = String(getV('B4')).trim() || today();

        let rejPct = 3.0;
        let fabPct = 10.0;
        let specialNotes = '';
        let parsedCollarRows: CollarDimensionRow[] = [];
        let parsedFlatKnitWeight = 184;

        if (summarySheetName) {
          const s = wb.Sheets[summarySheetName];
          const getSumV = (c: string) => s[c]?.v ?? '';
          for (let r = 12; r <= 32; r++) {
            const lbl = String(getSumV('A' + r) || '').toUpperCase();
            if (lbl.includes('REJECTION')) {
              const v = Number(getSumV('B' + r));
              rejPct = v < 1 ? Math.round(v * 100) : v;
            }
            if (lbl.includes('FABRIC') && !lbl.includes('ALLOWANCE')) {
              const v = Number(getSumV('B' + r));
              fabPct = v < 1 ? Math.round(v * 100) : v;
            }
            for (const col of ['F', 'G', 'H']) {
              const noteVal = String(getSumV(col + r) || '').trim();
              if (noteVal && (noteVal.includes('NOTE') || noteVal.includes('WASH') || noteVal.includes('GRM') || noteVal.includes('TAPE') || noteVal.includes('CORD') || noteVal.includes('ZIP') || noteVal.includes('COLLAR'))) {
                specialNotes += (specialNotes ? '\n' : '') + noteVal;
                if (noteVal.includes('MENS') && noteVal.includes('0.184')) {
                  parsedFlatKnitWeight = 184;
                } else if (noteVal.includes('BOYS') && noteVal.includes('0.137')) {
                  parsedFlatKnitWeight = 137;
                }
              }
            }
          }

          // Parse Collar Dimensions and sizes (Columns L, N, P, R, T, V, X)
          for (let c = 11; c < 26; c += 2) {
            const col1 = XLSX.utils.encode_col(c);
            const sz = String(s[col1 + '7']?.v || '').trim();
            const dim = String(s[col1 + '8']?.v || '').trim();
            const pcs = Number(s[col1 + '12']?.v || s[col1 + '14']?.v) || 0;
            if (sz && sz !== '-' && dim) {
              parsedCollarRows.push({
                size: sz,
                values: { collar: { dimension: dim, pcs } },
              });
            }
          }
        }

        const fnUpper = file.name.toUpperCase();
        const isWovenFile = fnUpper.includes('WOVEN') || markerSheetNames.some((sn) => {
          const ms = wb.Sheets[sn];
          const fab = String(ms['B36']?.v || ms['D9']?.v || ms['B35']?.v || '').toUpperCase();
          return fab.includes('WOVEN') || fab.includes('SEER SUCKER') || fab.includes('VOILE');
        });

        const parsedMarkers: CadMarker[] = markerSheetNames.map((sn, idx) => {
          const ms = wb.Sheets[sn];
          const getMV = (c: string) => ms[c]?.v ?? '';

          const mRef = String(getMV('B2') || sn).trim();
          const lMm = Number(getMV('B5')) || 0;
          const wMm = Number(getMV('B6')) || 0;
          const dia = String(getMV('B35') || getMV('L4') || 'OPEN').toUpperCase().includes('TUBE') ? 'TUBE' : 'OPEN';
          const dir = String(getMV('B34') || getMV('D8') || 'ONEWAY').trim();
          const fType = String(getMV('B36') || getMV('D9') || getMV('B35') || 'Main Fabric').trim();
          const gsmVal = Number(getMV('B37') || getMV('K9') || getMV('J26')) || (isWovenFile ? 100 : 160);
          const parts = String(getMV('B38') || getMV('D10') || '').trim();

          const sizesList: string[] = [];
          const ratiosList: number[] = [];
          ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].forEach((col) => {
            const sz = getMV(col + '5');
            const rt = Number(getMV(col + '6')) || 0;
            if (sz && sz !== '.' && sz !== '') {
              sizesList.push(String(sz));
              ratiosList.push(rt);
            }
          });

          if (sizesList.length === 0) {
            ['B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15'].forEach((c, i) => {
              const sz = getMV(c);
              const rt = Number(getMV('B' + (16 + i))) || 0;
              if (sz && sz !== '.' && sz !== '') {
                sizesList.push(String(sz));
                ratiosList.push(rt);
              }
            });
          }

          const cws: ColorwayRow[] = [];
          for (let r = 39; r <= 120; r += 9) {
            const cName = String(getMV('A' + r) || '').trim();
            if (cName && cName !== '.' && cName !== '-' && isNaN(Number(cName))) {
              const qList: number[] = [];
              for (let sIdx = 0; sIdx < sizesList.length; sIdx++) {
                const q = Number(getMV('B' + (r + sIdx))) || 0;
                qList.push(q);
              }
              const totalO = qList.reduce((a, b) => a + b, 0);
              if (totalO > 0 || cws.length === 0) {
                cws.push({ color_name: cName, quantities: qList, total_order_pcs: totalO });
              }
            }
          }

          const layLen = Number(getMV('J24') || getMV('J23')) || (lMm / 10 + 10);
          const tblW = Number(getMV('J25') || getMV('J24')) || (wMm / 25.4 + (dia === 'TUBE' ? 1 : 2));
          const fWtLay = Number(getMV('J27')) || 0;
          const pcsLay = Number(getMV('J28') || getMV('J25')) || 1;
          const avgWt = Number(getMV('J29')) || 0;
          const reqLen = Number(getMV('J26')) || 0;
          const totReq = Number(getMV('J30') || getMV('J27')) || 0;

          return {
            _key: `m_imp_${idx}`,
            marker_ref: mRef,
            marker_name: `${styleCode} ${mRef}`,
            length_mm: lMm,
            width_mm: wMm,
            fabric_dia_type: dia,
            fabric_type: fType,
            gsm: gsmVal,
            direction: dir,
            parts_in_lay: parts,
            lay_allowance_cm: 10,
            width_allowance_in: dia === 'TUBE' ? 1 : 2,
            rejection_pct: rejPct,
            fabric_allowance_pct: fabPct,
            dia_in: Math.round(tblW),
            dia_val: `${Math.round(tblW)}"`,
            dia_spec: `${Math.round(tblW)}" ${dia}`,
            lay_length_cm: layLen,
            table_width_in: tblW,
            fabric_wt_per_lay_g: fWtLay,
            no_of_pcs_lay: pcsLay,
            act_wt_per_pc_g: pcsLay > 0 && fWtLay > 0 ? Math.round((fWtLay / pcsLay) * 10000) / 10000 : 0,
            avg_wt_per_pc_g: avgWt,
            req_length_per_pc_cm: reqLen,
            total_req_qty: totReq,
            uom: isWovenFile ? 'MTR' : 'KG',
            sizes: sizesList.length ? sizesList : ['S', 'M', 'L'],
            ratios: ratiosList.length ? ratiosList : [1, 1, 1],
            colorways: cws.length ? cws : [{ color_name: 'Solid', quantities: [1000, 1000, 1000] }],
          };
        });

        // Auto-match style if found in styles lookup
        const matchedStyle = styles.data?.find((st: any) =>
          st.style_code === styleCode || st.label?.includes(styleCode) || st.style_name?.includes(styleCode)
        );

        // Update Component State
        setHeader((prev) => ({
          ...prev,
          style_id: matchedStyle ? String(matchedStyle.id) : prev.style_id,
          req_date: reqDate || prev.req_date,
          cad_type: isWovenFile ? 'WOVEN' : (fnUpper.includes('ACNT') ? 'KNIT_FLEECE' : 'KNIT_SJ'),
          uom: isWovenFile ? 'MTR' : 'KG',
          rejection_pct: rejPct,
          fabric_allowance_pct: fabPct,
          special_notes: specialNotes,
          remarks: `Imported from ${file.name}${buyerName ? ` (Buyer: ${buyerName})` : ''}`,
        }));

        setMarkers(parsedMarkers);
        setActiveMarkerIdx(0);

        if (parsedCollarRows.length > 0) {
          // Sheet gives collar counts only; the set weight rides on the collar component (as before).
          setFlatKnitSpec(recalculateFlatKnit({
            enabled: true,
            item_type: '95% COTTON 5% ELASTANE 2X2 FLATKNIT',
            color: 'NAVY',
            gsm: 500,
            weight_per_set_g: parsedFlatKnitWeight,
            components: [{ key: 'collar', type: 'COLLAR', label: 'Collar', weight_g: parsedFlatKnitWeight }],
            size_rows: parsedCollarRows,
            total_collar_pcs: 0,
            total_cuff_pcs: 0,
            total_yarn_kg: 0,
            remarks: `Imported from ${file.name} FABRIC sheet (${parsedCollarRows.length} sizes, 500 GSM Flatknit)`,
          }));
        }

        toast(`Imported ${parsedMarkers.length} markers from ${file.name}!`, 'success');
        setImporting(false);
      };

      reader.readAsBinaryString(file);
    } catch {
      toast('Failed to parse Excel file', 'error');
      setImporting(false);
    }
  };

  // Save CAD Requirement
  const handleSave = async () => {
    if (!header.internal_ir_no.trim()) {
      toast('Please select the IO No', 'error');
      return;
    }
    if (!header.style_id) {
      toast('Please select a Style No', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...header,
        markers,
        fabric_program: fabricProgram,
        cutting_lay: cuttingLay,
        summary_metrics: summaryKpis,
        flat_knit_spec: flatKnitSpec,
        special_parts: specialParts.map(withPartKg),
        foam_khada_items: foamKhadaItems,
        trims,
        total_fabric_kg: isWoven ? 0 : summaryKpis.grandTotalMaterial,
        total_fabric_mtrs: isWoven ? summaryKpis.grandFabric : 0,
      };

      if (isNew) {
        const res = await http.post<{ data: { id: number; req_no: string } }>('/cad-requirements', payload);
        toast(`CAD Requirement ${res.data.req_no} saved!`, 'success');
        nav(`/production/cad-requirements/${res.data.id}`);
      } else {
        await http.put(`/cad-requirements/${id}`, { ...payload, id: Number(id) });
        toast('CAD Requirement saved successfully', 'success');
      }
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : 'Failed to save CAD requirement';
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Approve CAD Requirement
  const handleApprove = async () => {
    try {
      if (!isNew && id) {
        await http.post(`/cad-requirements/${id}/approve`, {
          total_fabric_kg: isWoven ? 0 : summaryKpis.grandTotalMaterial,
          total_fabric_mtrs: isWoven ? summaryKpis.grandFabric : 0,
          total_yarn_kg: isWoven ? 0 : Math.round(summaryKpis.grandTotalMaterial * 1.05 * 10) / 10,
          // Purchase hand-off: specialized parts & flat-knit components, converted to KG server-side
          special_parts: specialParts.map(withPartKg),
          foam_khada_items: foamKhadaItems,
          flat_knit_spec: flatKnitSpec,
          summary_metrics: summaryKpis,
        });
      }
      setHeader((p) => ({ ...p, status: 'APPROVED' }));
      toast('Approved! Auto-synced to Style BOM and Procurement.', 'success');
      setActiveTab('OUTPUT');
    } catch (e: any) {
      toast(e.message || 'Approval failed', 'error');
    }
  };

  // Next revision label: V01 -> V02, V1 -> V2
  const nextRevisionLabel = useMemo(() => {
    const cur = String(header.cad_version || 'V01');
    const match = cur.match(/^([A-Za-z]*)(\d+)$/);
    if (match) {
      const prefix = match[1] || 'V';
      const num = parseInt(match[2], 10) + 1;
      return `${prefix}${String(num).padStart(match[2].length, '0')}`;
    }
    return `${cur}-R1`;
  }, [header.cad_version]);

  // Create editable revision for approved CAD
  const [revising, setRevising] = useState(false);
  const handleCreateRevision = async () => {
    if (!id || isNew) return;
    if (!confirm(`Create new revision (${nextRevisionLabel}) for CAD requirement ${header.req_no}? This will create an editable draft while preserving this approved version in history.`)) return;
    setRevising(true);
    try {
      const res = await http.post<{ success: boolean; data: any }>(`/cad-requirements/${id}/revision`);
      toast(`Created revision ${res.data?.cad_version || nextRevisionLabel}! Opening new editable draft...`, 'success');
      nav(`/production/cad-requirements/${res.data.id}`);
    } catch (e: any) {
      toast(e.message || 'Failed to create revision', 'error');
    } finally {
      setRevising(false);
    }
  };

  if (!isNew && loadingExisting) {
    return <div className="py-20 text-center text-slate-400">Loading CAD Requirement #{id}...</div>;
  }

  return (
    <div className="space-y-4 pb-20">
      {/* Top Header & Action Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-200 pb-3">
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
                {isNew ? 'New Garment CAD Requirement' : `CAD Sheet: ${header.req_no || id}`}
              </h1>
              {header.cad_version && (
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-800">
                  {header.cad_version}
                </span>
              )}
              <Badge
                tone={
                  header.status === 'APPROVED'
                    ? 'green'
                    : header.status === 'SUPERSEDED'
                    ? 'amber'
                    : header.status === 'CALCULATED'
                    ? 'blue'
                    : 'slate'
                }
              >
                {header.status}
              </Badge>
              <Badge tone={isWoven ? 'amber' : 'indigo'}>
                {isWoven ? 'WOVEN (METERS)' : 'KNIT (KG)'}
              </Badge>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Lay & marker sheets (1A, 1B, 2A), table allowances, tubular/open layers, CEILING cut rejection & F.PRGM consolidation
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* File Upload Input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".xls,.xlsx"
            className="hidden"
          />

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 shadow-sm transition disabled:opacity-50"
            title="Upload and auto-populate from 05 SJ, 25 ESTOVIR, 37 NOTRE, or WOVEN Excel files"
          >
            <UploadCloud size={14} className={importing ? 'animate-spin' : ''} />
            <span>{importing ? 'Parsing Excel...' : 'Import CAD Excel (.xls)'}</span>
          </button>

          <button
            onClick={runCalculation}
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
              <span>Approve for BOM & PO</span>
            </button>
          )}

          {header.status === 'APPROVED' && (
            <button
              onClick={handleCreateRevision}
              disabled={revising}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white shadow-sm transition disabled:opacity-50"
              title="Create an editable revision (V2, V3...) while preserving approved V1"
            >
              <GitBranch size={14} className={revising ? 'animate-spin' : ''} />
              <span>{revising ? 'Creating Revision...' : `Create Revision (${nextRevisionLabel})`}</span>
            </button>
          )}

          <button
            onClick={handleSave}
            disabled={saving || header.status === 'APPROVED'}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition disabled:opacity-50"
          >
            <Save size={14} />
            <span>{saving ? 'Saving...' : 'Save CAD Req'}</span>
          </button>
        </div>
      </div>

      {/* Revision and Approval Status Notifications */}
      {header.status === 'APPROVED' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-emerald-900 shadow-2xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
            <span>
              This CAD Requirement is <strong>Approved</strong> ({header.cad_version || 'V01'}). If changes are needed, click <strong>Create Revision</strong> to generate an editable revision ({nextRevisionLabel}) while preserving this approved version in history.
            </span>
          </div>
          <button
            onClick={handleCreateRevision}
            disabled={revising}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white shadow-2xs shrink-0 transition"
          >
            <GitBranch size={13} />
            <span>Create Revision ({nextRevisionLabel})</span>
          </button>
        </div>
      )}

      {header.status === 'SUPERSEDED' && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2 text-xs text-amber-900 shadow-2xs">
          <Clock size={16} className="text-amber-600 shrink-0" />
          <span>
            This CAD Requirement ({header.cad_version || 'V01'}) is <strong>SUPERSEDED</strong> by a newer revision and is preserved for historical audit.
          </span>
        </div>
      )}

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="p-3 bg-white rounded-xl border border-slate-200/80 shadow-sm">
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Markers Planned</div>
          <div className="text-lg font-bold text-slate-900 mt-0.5">{markers.length} Sheets</div>
          <div className="text-[10px] text-slate-400">Tabs: {markers.map((m) => m.marker_ref).join(', ')}</div>
        </div>

        <div className="p-3 bg-white rounded-xl border border-slate-200/80 shadow-sm">
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Order Qty (Garments)</div>
          <div className="text-lg font-bold text-indigo-600 mt-0.5">{fmtNumber(summaryKpis.totalOrderPcs)} Pcs</div>
          <div className="text-[10px] text-slate-400">Main fabric colours · rib / collar not added · Rej +{header.rejection_pct}%</div>
        </div>

        <div className="p-3 bg-indigo-50/60 rounded-xl border border-indigo-200 shadow-sm">
          <div className="text-[11px] font-semibold text-indigo-700 uppercase tracking-wider">Total Fabric Need</div>
          <div className="text-xl font-bold text-indigo-900 mt-0.5">
            {fmtDecimal(isWoven ? summaryKpis.grandFabricMtr : summaryKpis.grandFabricKg)} {summaryKpis.uom}
          </div>
          {summaryKpis.grandFabricMtr > 0 && !isWoven && (
            <div className="text-[10px] text-purple-700 font-bold mt-0.5">
              + {fmtDecimal(summaryKpis.grandFabricMtr)} MTR Foam / Khada
            </div>
          )}
          <div className="text-[10px] text-indigo-600">F.PRGM consolidated</div>
        </div>

        <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-200 shadow-sm">
          <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">Average Piece Weight</div>
          <div className="text-lg font-bold text-emerald-900 mt-0.5">
            {fmtDecimal(summaryKpis.avgConsInclParts * (isWoven ? 1 : 1000), 2)} {isWoven ? 'Mtrs' : 'Gms'}
          </div>
          <div className="text-[10px] text-emerald-600">
            {isWoven
              ? `Fabric only · parts +${fmtDecimal(summaryKpis.partsKgPerPc * 1000, 2)} Gms`
              : `Fabric ${fmtDecimal(summaryKpis.avgGarmentCons * 1000, 2)} + Parts ${fmtDecimal(summaryKpis.partsKgPerPc * 1000, 2)} Gms`}
          </div>
        </div>

        <div className="p-3 bg-amber-50/60 rounded-xl border border-amber-200 shadow-sm">
          <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider">Actual Piece Weight</div>
          <div className="text-lg font-bold text-amber-900 mt-0.5">
            {fmtDecimal(summaryKpis.actualPieceWt * (isWoven ? 1 : 1000), 2)} {isWoven ? 'Mtrs' : 'Gms'}
          </div>
          <div className="text-[10px] text-amber-600">Average − fabric loss {summaryKpis.lossPct}% (collar / tapes not reduced)</div>
        </div>
      </div>

      {/* Header Parameters Card */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-7 gap-3">
          <Input
            label="CAD Req No"
            value={header.req_no}
            onChange={(e) => setHeader((p) => ({ ...p, req_no: e.target.value }))}
            placeholder="CAD-XXXXX"
            disabled={!isNew}
          />

          <Input
            label="Date"
            type="date"
            value={header.req_date}
            onChange={(e) => setHeader((p) => ({ ...p, req_date: e.target.value }))}
          />

          <Select
            label="IO No *"
            id="cad-io"
            value={header.internal_ir_no}
            onChange={(e) => pickJob(e.target.value)}
            options={[
              ...(header.internal_ir_no && !(jobs.data ?? []).some((j) => j.job_no === header.internal_ir_no) ? [{ value: header.internal_ir_no, label: header.internal_ir_no }] : []),
              ...(jobs.data ?? []).map((j) => ({ value: j.job_no, label: `${j.job_no}${j.buyer_name ? ` · ${j.buyer_name}` : ''}` })),
            ]}
            placeholder="Select IO No"
          />

          <Select
            label="Style No *"
            id="cad-style"
            value={header.style_id}
            onChange={(e) => pickStyle(e.target.value)}
            options={jobStyles.length ? jobStyles.map((st) => ({ value: String(st.style_id), label: st.style_code })) : toOptions(styles.data)}
            placeholder="Select Style"
          />

          <Input
            label="Order Qty (Pcs)"
            type="number"
            value={header.order_qty}
            onChange={(e) => setHeader((p) => ({ ...p, order_qty: parseInt(e.target.value) || 0 }))}
          />

          <Input
            label="Rejection / Cut %"
            type="number"
            step="0.5"
            value={header.rejection_pct ?? 3}
            onChange={(e) => {
              const val = parseFloat(e.target.value) || 0;
              setHeader((p) => ({ ...p, rejection_pct: val }));
              setMarkers((prev) => prev.map((m) => ({ ...m, rejection_pct: val })));
            }}
            placeholder="e.g. 2, 3 or 5"
          />

          <Input
            label="Fabric Loss %"
            type="number"
            step="0.5"
            value={header.fabric_allowance_pct ?? 10}
            onChange={(e) => {
              const val = parseFloat(e.target.value) || 0;
              setHeader((p) => ({ ...p, fabric_allowance_pct: val }));
              setMarkers((prev) => prev.map((m) => ({ ...m, fabric_allowance_pct: val })));
            }}
            placeholder="e.g. 10 or 12"
          />
        </div>

        {/* Special Instructions & Notes Bar */}
        <div className="pt-2 border-t border-slate-100">
          <input
            type="text"
            placeholder="Special instructions / notes e.g. GREY FORM BIO WASH, 10MM TWILL TAPE - 60 CM..."
            value={header.special_notes}
            onChange={(e) => setHeader((p) => ({ ...p, special_notes: e.target.value }))}
            className="w-full text-xs border border-slate-300 rounded px-2.5 py-1.5 font-mono text-slate-700 bg-white"
          />
        </div>
      </div>

      {/* Main Navigation Tabs */}
      <div className="flex border-b border-slate-200 space-x-1 overflow-x-auto">
        {[
          { id: 'MARKERS', label: `1. Markers Cockpit (${markers.length})`, icon: Scissors },
          { id: 'F_PRGM', label: '2. Fabric Program (F.PRGM)', icon: FileSpreadsheet },
          { id: 'CUT', label: '3. Cutting Lay Sheet (CUT)', icon: Layers },
          { id: 'TRIMS', label: '4. Trims & Accessories', icon: Disc },
          { id: 'OUTPUT', label: '5. BOM & Sourcing Hand-off', icon: FileCheck },
          { id: 'RATIO_PATTI', label: '6. Ratio Patti', icon: Printer },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-1.5 py-2.5 px-4 text-xs font-semibold border-b-2 transition whitespace-nowrap ${
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

      {/* TAB 1: MARKERS COCKPIT */}
      {activeTab === 'MARKERS' && activeMarker && (
        <div className="space-y-4">
          {/* Marker Tabs Strip */}
          <div className="flex items-center justify-between bg-slate-100 p-1.5 rounded-xl border border-slate-200">
            <div className="flex items-center gap-1 overflow-x-auto">
              {markers.map((m, idx) => (
                <button
                  key={m._key || idx}
                  onClick={() => setActiveMarkerIdx(idx)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                    activeMarkerIdx === idx
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-600 hover:bg-white/60'
                  }`}
                >
                  <MarkerThumb url={markerFiles.find((f) => f.marker_ref === m.marker_ref && f.image_url)?.image_url} size={22} alt={`Marker ${m.marker_ref}`} />
                  <span>Sheet {m.marker_ref}</span>
                  <span className="text-[10px] px-1 py-0.5 rounded bg-slate-100 font-normal">
                    {fmtDecimal(m.total_req_qty)} {isWoven ? 'MTR' : (m.uom || 'KG')}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={addMarker}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-700"
              >
                <Plus size={13} />
                <span>Add Marker</span>
              </button>
              <button
                onClick={duplicateActiveMarker}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                title="Duplicate active marker"
              >
                <Copy size={13} />
                <span>Clone</span>
              </button>
              <button
                onClick={removeActiveMarker}
                className="p-1 text-slate-400 hover:text-red-600 rounded"
                title="Delete marker"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {/* Active Marker Details & Lay Geometry */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-slate-900">
                  Marker [{activeMarker.marker_ref}] Specifications
                </span>
                <Badge tone={activeMarker.fabric_dia_type === 'TUBE' ? 'purple' : 'blue'}>
                  {activeMarker.fabric_dia_type === 'TUBE' ? 'TUBE (2 LAYERS/PLY)' : 'OPEN (1 LAYER/PLY)'}
                </Badge>
              </div>
              <span className="text-xs text-slate-500 font-mono">
                {activeMarker.parts_in_lay || 'Body / Sleeve'}
              </span>
            </div>

            <MarkerFilesPanel cadId={isNew ? null : Number(id)} markerRef={activeMarker.marker_ref} files={markerFiles} onFiles={setMarkerFiles} onApply={applyMarkerReport} />

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-2.5 text-xs">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600">Marker Ref</label>
                <input
                  type="text"
                  value={activeMarker.marker_ref}
                  onChange={(e) => updateActiveMarker({ marker_ref: e.target.value })}
                  className="w-full font-bold border border-slate-300 rounded px-2 py-1 mt-0.5"
                />
              </div>

              <div className="lg:col-span-2">
                <div className="flex items-center justify-between">
                  <label className="block text-[11px] font-semibold text-slate-600">Fabric Type / Description</label>
                  <span className="text-[10px] text-indigo-600 font-semibold">Fabric Master Linked</span>
                </div>
                <input
                  type="text"
                  list="cad-fabrics-master-list"
                  value={activeMarker.fabric_type}
                  onChange={(e) => {
                    const val = e.target.value;
                    const matched = (fabrics.data ?? []).find(
                      (f: any) => f.label === val || f.code === val || `${f.code} — ${f.label}` === val
                    );
                    updateActiveMarker({
                      fabric_type: matched ? matched.label : val,
                      ...(matched ? {
                        fabric_id: matched.id,
                        ...((!activeMarker.gsm || activeMarker.gsm === 0) && (matched.min_gsm || matched.gsm) ? { gsm: Number(matched.min_gsm || matched.gsm) } : {}),
                        ...((!activeMarker.dia_in || activeMarker.dia_in === 0) && matched.dia_inch ? { dia_in: Number(matched.dia_inch) } : {}),
                      } : {}),
                    });
                  }}
                  placeholder="Select from Fabric Master or type..."
                  className="w-full font-semibold border border-indigo-200 rounded px-2 py-1 mt-0.5 bg-indigo-50/20 focus:bg-white"
                />
                <datalist id="cad-fabrics-master-list">
                  {(fabrics.data ?? []).map((f: any) => (
                    <option key={f.id} value={f.label}>
                      {f.code ? `[${f.code}] ` : ''}{f.label} {f.min_gsm ? `(${f.min_gsm} GSM)` : ''}
                    </option>
                  ))}
                </datalist>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600">CAD Length (mm)</label>
                <input
                  type="number"
                  value={activeMarker.length_mm}
                  onChange={(e) => updateActiveMarker({ length_mm: parseFloat(e.target.value) || 0 })}
                  className="w-full font-bold text-indigo-700 border border-slate-300 rounded px-2 py-1 mt-0.5"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600">CAD Width (mm)</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={activeMarker.width_mm || ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const wMm = raw === '' ? 0 : parseFloat(raw) || 0;
                    const dIn = wMm > 0 ? Math.round(wMm / 25.4) : undefined;
                    const allowance = Number(activeMarker.width_allowance_in ?? (activeMarker.fabric_dia_type === 'TUBE' ? 1.0 : 2.0));
                    updateActiveMarker({ 
                      width_mm: wMm,
                      dia_in: dIn,
                      dia_val: dIn ? `${dIn}"` : undefined,
                      dia_spec: dIn ? `${dIn}" ${activeMarker.fabric_dia_type || 'OPEN'}` : undefined,
                      table_width_in: dIn ? Math.round((dIn + allowance) * 100) / 100 : 0,
                    });
                  }}
                  className="w-full font-bold text-indigo-700 border border-slate-300 rounded px-2 py-1 mt-0.5"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600">Dia Form</label>
                <select
                  value={activeMarker.fabric_dia_type}
                  onChange={(e) => {
                    const diaType = e.target.value as 'OPEN' | 'TUBE';
                    const allowance = diaType === 'TUBE' ? 1.0 : 2.0;
                    const dIn = Number(activeMarker.dia_in) > 0 ? Number(activeMarker.dia_in) : (activeMarker.width_mm ? Math.round(activeMarker.width_mm / 25.4) : 0);
                    updateActiveMarker({ 
                      fabric_dia_type: diaType,
                      width_allowance_in: allowance,
                      table_width_in: dIn > 0 ? Math.round((dIn + allowance) * 100) / 100 : activeMarker.table_width_in,
                    });
                  }}
                  className="w-full border border-slate-300 rounded px-2 py-1 mt-0.5 font-semibold"
                >
                  <option value="OPEN">OPEN (Flat)</option>
                  <option value="TUBE">TUBE (Circular)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-indigo-700">Fabric Dia (Inches)</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={activeMarker.dia_in != null && activeMarker.dia_in !== ('' as any) ? activeMarker.dia_in : (activeMarker.width_mm ? Math.round(activeMarker.width_mm / 25.4) : '')}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const dIn = raw === '' ? undefined : parseFloat(raw);
                    const allowance = Number(activeMarker.width_allowance_in ?? (activeMarker.fabric_dia_type === 'TUBE' ? 1.0 : 2.0));
                    const newTableW = dIn != null && dIn > 0 ? Math.round((dIn + allowance) * 100) / 100 : activeMarker.table_width_in;
                    updateActiveMarker({ 
                      dia_in: dIn,
                      dia_val: dIn != null ? `${dIn}"` : undefined,
                      dia_spec: dIn != null ? `${dIn}" ${activeMarker.fabric_dia_type || 'OPEN'}` : undefined,
                      width_mm: dIn != null && dIn > 0 ? Math.round(dIn * 25.4) : activeMarker.width_mm,
                      table_width_in: newTableW,
                    });
                  }}
                  className="w-full font-bold text-indigo-800 border border-indigo-300 bg-indigo-50/50 rounded px-2 py-1 mt-0.5"
                  placeholder='e.g. 58"'
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600">Unit / Mode</label>
                <select
                  value={activeMarker.uom || 'KG'}
                  onChange={(e) => {
                    const newUom = e.target.value as 'KG' | 'MTR';
                    updateActiveMarker({
                      uom: newUom,
                      ...(newUom === 'MTR' ? { gsm: 0 } : { gsm: activeMarker.gsm || 160 }),
                    });
                  }}
                  className="w-full border border-slate-300 rounded px-2 py-1 mt-0.5 font-bold text-indigo-700 bg-white"
                >
                  <option value="KG">KG (Knitted)</option>
                  <option value="MTR">MTR (Woven / Foam)</option>
                </select>
              </div>

              {activeMarker.uom !== 'MTR' ? (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-600">GSM</label>
                  <input
                    type="number"
                    value={activeMarker.gsm}
                    onChange={(e) => updateActiveMarker({ gsm: parseInt(e.target.value) || 0 })}
                    className="w-full border border-slate-300 rounded px-2 py-1 mt-0.5 font-medium"
                    placeholder="e.g. 180"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400">GSM (N/A for MTR)</label>
                  <div className="w-full border border-slate-200 bg-slate-100 text-slate-400 rounded px-2 py-1 mt-0.5 text-xs font-semibold flex items-center h-[30px]">
                    — Not Applicable
                  </div>
                </div>
              )}

              <div>
                <label className="block text-[11px] font-semibold text-slate-600">Direction</label>
                <select
                  value={activeMarker.direction}
                  onChange={(e) => updateActiveMarker({ direction: e.target.value })}
                  className="w-full border border-slate-300 rounded px-2 py-1 mt-0.5"
                >
                  <option value="ONEWAY">ONEWAY</option>
                  <option value="TWOWAY">TWOWAY</option>
                </select>
              </div>
            </div>

            {/* Marker-Level Individual Variables (Rejection %, Fabric Loss %, Buffers) */}
            <div className="p-3 bg-amber-50/30 rounded-xl border border-amber-200/80 grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-3 text-xs">
              <div>
                <label className="block text-[11px] font-bold text-amber-800">
                  Marker Rejection %
                </label>
                <div className="flex items-center gap-1 mt-0.5">
                  <input
                    type="number"
                    step="0.5"
                    value={activeMarker.rejection_pct ?? header.rejection_pct ?? 3.0}
                    onChange={(e) => updateActiveMarker({ rejection_pct: parseFloat(e.target.value) || 0 })}
                    className="w-full font-bold text-amber-900 border border-amber-300 bg-white rounded px-2 py-1"
                  />
                  <span className="text-amber-800 font-bold">%</span>
                </div>
                <span className="text-[10px] text-amber-700">Per-marker CEIL cut buffer</span>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-indigo-800">
                  Marker Fabric Loss %
                </label>
                <div className="flex items-center gap-1 mt-0.5">
                  <input
                    type="number"
                    step="0.5"
                    value={activeMarker.fabric_allowance_pct ?? header.fabric_allowance_pct ?? 10.0}
                    onChange={(e) => updateActiveMarker({ fabric_allowance_pct: parseFloat(e.target.value) || 0 })}
                    className="w-full font-bold text-indigo-900 border border-indigo-300 bg-white rounded px-2 py-1"
                  />
                  <span className="text-indigo-800 font-bold">%</span>
                </div>
                <span className="text-[10px] text-indigo-700">For gross avg consumption</span>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700">
                  Lay Add (cm)
                </label>
                <div className="flex items-center gap-1 mt-0.5">
                  <input
                    type="number"
                    step="1"
                    value={activeMarker.lay_allowance_cm ?? 10.0}
                    onChange={(e) => updateActiveMarker({ lay_allowance_cm: parseFloat(e.target.value) || 0 })}
                    className="w-full font-bold text-slate-800 border border-slate-300 bg-white rounded px-2 py-1"
                  />
                  <span className="text-slate-500 font-medium">cm</span>
                </div>
                <span className="text-[10px] text-slate-500">End bits allowance</span>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700">
                  Width Add (in)
                </label>
                <div className="flex items-center gap-1 mt-0.5">
                  <input
                    type="number"
                    step="0.5"
                    value={activeMarker.width_allowance_in ?? (activeMarker.fabric_dia_type === 'TUBE' ? 1.0 : 2.0)}
                    onChange={(e) => {
                      const allowance = parseFloat(e.target.value) || 0;
                      const dIn = Number(activeMarker.dia_in) > 0 ? Number(activeMarker.dia_in) : (activeMarker.width_mm ? Math.round(activeMarker.width_mm / 25.4) : 0);
                      const newTableW = dIn > 0 ? Math.round((dIn + allowance) * 100) / 100 : activeMarker.table_width_in;
                      updateActiveMarker({ width_allowance_in: allowance, table_width_in: newTableW });
                    }}
                    className="w-full font-bold text-slate-800 border border-slate-300 bg-white rounded px-2 py-1"
                  />
                  <span className="text-slate-500 font-medium">in</span>
                </div>
                <span className="text-[10px] text-slate-500">Selvedge & edge trim</span>
              </div>

              <div className="col-span-2 sm:col-span-4 md:col-span-1">
                <label className="block text-[11px] font-semibold text-slate-700">Parts Included</label>
                <input
                  type="text"
                  value={activeMarker.parts_in_lay}
                  onChange={(e) => updateActiveMarker({ parts_in_lay: e.target.value })}
                  placeholder="BCK, FRT, SLV, N/RIB"
                  className="w-full font-medium border border-slate-300 bg-white rounded px-2 py-1 mt-0.5"
                />
                <span className="text-[10px] text-slate-500">Garment components</span>
              </div>
            </div>

            {/* Computed Lay Geometry & Piece Weights (Net Actual vs Gross Average) */}
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3 text-xs">
              <div>
                <span className="text-slate-500 text-[11px]">Lay Length:</span>
                <div className="font-bold text-slate-900 mt-0.5 text-sm">
                  {fmtDecimal(activeMarker.lay_length_cm, 1)} cm
                </div>
                <span className="text-[10px] text-slate-400">
                  {((activeMarker.length_mm || 0) / 10).toFixed(1)} + {activeMarker.lay_allowance_cm}cm
                </span>
              </div>

              <div>
                <span className="text-slate-500 text-[11px]">Table Width / Dia (+{activeMarker.width_allowance_in ?? 2}"):</span>
                <div className="font-bold text-indigo-700 mt-0.5 text-sm">
                  {fmtDecimal(activeMarker.table_width_in, 1)}" (Table Dia: {Math.round(activeMarker.table_width_in || ((activeMarker.dia_in || 0) + (activeMarker.width_allowance_in ?? 2)))}")
                </div>
                <span className="text-[10px] text-slate-400">
                  Actual Dia: {activeMarker.dia_in || (activeMarker.width_mm ? Math.round(activeMarker.width_mm / 25.4) : 0)}" + {activeMarker.width_allowance_in ?? 2}"
                </span>
              </div>

              {!isWoven ? (
                <>
                  <div>
                    <span className="text-slate-500 text-[11px]">Fabric Wt / Lay:</span>
                    <div className="font-bold text-indigo-700 mt-0.5 text-sm">
                      {fmtDecimal(activeMarker.fabric_wt_per_lay_g, 1)} g
                    </div>
                    <span className="text-[10px] text-slate-400">
                      {activeMarker.fabric_dia_type === 'TUBE' ? 'x2 Tubular layers' : 'Single layer'}
                    </span>
                  </div>

                  <div>
                    <span className="text-slate-500 text-[11px]">No of Pcs / Lay:</span>
                    <div className="font-bold text-slate-900 mt-0.5 text-sm">
                      {activeMarker.no_of_pcs_lay} pcs
                    </div>
                    <span className="text-[10px] text-slate-400">Ratios {activeMarker.fabric_dia_type === 'TUBE' ? 'x2' : ''}</span>
                  </div>

                  {/* Net Actual Piece Weight */}
                  <div className="p-2 bg-amber-50 rounded-lg border border-amber-200">
                    <span className="text-amber-800 text-[10px] font-bold uppercase tracking-wider">Actual Wt / Pc (Net):</span>
                    <div className="font-extrabold text-amber-900 mt-0.5 text-sm">
                      {fmtDecimal(activeMarker.act_wt_per_pc_g || (activeMarker.fabric_wt_per_lay_g / (activeMarker.no_of_pcs_lay || 1)), 2)} g/pc
                    </div>
                    <span className="text-[9px] text-amber-700">Pure net lay weight</span>
                  </div>

                  {/* Gross Average Piece Weight */}
                  <div className="p-2 bg-emerald-50 rounded-lg border border-emerald-200">
                    <span className="text-emerald-800 text-[10px] font-bold uppercase tracking-wider">Average Wt / Pc (Gross):</span>
                    <div className="font-extrabold text-emerald-900 mt-0.5 text-sm">
                      {fmtDecimal(activeMarker.avg_wt_per_pc_g, 2)} g/pc
                    </div>
                    <span className="text-[9px] text-emerald-700">
                      +{activeMarker.fabric_allowance_pct ?? header.fabric_allowance_pct}% fabric allowance
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <span className="text-slate-500 text-[11px]">No of Pcs / Lay:</span>
                    <div className="font-bold text-slate-900 mt-0.5 text-sm">
                      {activeMarker.no_of_pcs_lay} pcs
                    </div>
                    <span className="text-[10px] text-slate-400">Sum of ratios</span>
                  </div>

                  <div className="p-2 bg-amber-50 rounded-lg border border-amber-200">
                    <span className="text-amber-800 text-[10px] font-bold uppercase tracking-wider">Actual Length / Pc (Net):</span>
                    <div className="font-extrabold text-amber-900 mt-0.5 text-sm">
                      {fmtDecimal(activeMarker.act_length_per_pc_cm || (activeMarker.lay_length_cm / (activeMarker.no_of_pcs_lay || 1)), 2)} cm/pc
                    </div>
                    <span className="text-[9px] text-amber-700">Pure net lay length</span>
                  </div>

                  <div className="p-2 bg-emerald-50 rounded-lg border border-emerald-200">
                    <span className="text-emerald-800 text-[10px] font-bold uppercase tracking-wider">Req Length / Pc (Gross):</span>
                    <div className="font-extrabold text-emerald-900 mt-0.5 text-sm">
                      {fmtDecimal(activeMarker.req_length_per_pc_cm, 2)} cm/pc
                    </div>
                    <span className="text-[9px] text-emerald-700">
                      +{activeMarker.fabric_allowance_pct ?? header.fabric_allowance_pct}% fabric allowance
                    </span>
                  </div>
                </>
              )}

              <div className="p-2 bg-indigo-50 rounded-lg border border-indigo-200">
                <span className="text-indigo-800 text-[10px] font-bold uppercase tracking-wider">Marker Total Req:</span>
                <div className="text-base font-extrabold text-indigo-950 mt-0.5">
                  {fmtDecimal(activeMarker.total_req_qty)} {isWoven ? 'MTR' : (activeMarker.uom || 'KG')}
                </div>
                <span className="text-[9px] text-indigo-700">Fabric required</span>
              </div>
            </div>
          </div>

          {/* Sizes & Lay Ratio Distribution */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  Sizes & Lay Ratio (Pcs/Lay)
                </h3>
                <p className="text-[11px] text-slate-500">
                  Defines garment sizes in the marker and how many pieces cut per table ply
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={syncOrderBreakdownToMarker}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition"
                  title="Load all sizes and pure order quantities from the Sales Order (Audio 2)"
                >
                  <Sparkles size={13} />
                  <span>Sync Sizes from Order</span>
                </button>
                <button
                  onClick={() => {
                    const newSizes = [...activeMarker.sizes, `S${activeMarker.sizes.length + 1}`];
                    const newRatios = [...activeMarker.ratios, 1];
                    const newColorways = activeMarker.colorways.map((cw) => ({
                      ...cw,
                      quantities: [...cw.quantities, 0],
                    }));
                    updateActiveMarker({ sizes: newSizes, ratios: newRatios, colorways: newColorways });
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                >
                  <Plus size={13} />
                  <span>Add Size Column</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                    <th className="py-2 px-3 w-40">Parameter</th>
                    {activeMarker.sizes.map((s, sIdx) => (
                      <th key={sIdx} className="py-2 px-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <input
                            type="text"
                            value={s}
                            onChange={(e) => {
                              const copy = [...activeMarker.sizes];
                              copy[sIdx] = e.target.value;
                              updateActiveMarker({ sizes: copy });
                            }}
                            className="w-16 text-center text-xs font-bold border border-slate-300 rounded px-1.5 py-0.5"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (activeMarker.sizes.length <= 1) {
                                toast('Marker must have at least one size', 'warning');
                                return;
                              }
                              const newSizes = activeMarker.sizes.filter((_, idx) => idx !== sIdx);
                              const newRatios = activeMarker.ratios.filter((_, idx) => idx !== sIdx);
                              const newColorways = activeMarker.colorways.map((cw) => ({
                                ...cw,
                                quantities: cw.quantities.filter((_, idx) => idx !== sIdx),
                              }));
                              updateActiveMarker({ sizes: newSizes, ratios: newRatios, colorways: newColorways });
                              toast(`Removed size ${s} from marker`, 'info');
                            }}
                            className="text-slate-400 hover:text-red-600 transition p-0.5 rounded hover:bg-red-50"
                            title={`Remove size ${s} from this marker`}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </th>
                    ))}
                    <th className="py-2 px-2 text-center w-20">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  <tr>
                    <td className="py-2 px-3 font-semibold text-slate-900">Lay Ratio / Pcs</td>
                    {activeMarker.ratios.map((rt, sIdx) => (
                      <td key={sIdx} className="py-2 px-2 text-center">
                        <input
                          type="number"
                          value={rt}
                          onChange={(e) => {
                            const copy = [...activeMarker.ratios];
                            copy[sIdx] = parseInt(e.target.value) || 0;
                            updateActiveMarker({ ratios: copy });
                          }}
                          className="w-16 text-center text-xs font-bold text-indigo-700 border border-slate-300 rounded px-1.5 py-0.5"
                        />
                      </td>
                    ))}
                    <td className="py-2 px-2 text-center font-bold text-slate-900">
                      {activeMarker.ratios.reduce((a, b) => a + (Number(b) || 0), 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Colorways & Order Quantities Spreadsheet Grid */}
          <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  Colorways & Order Matrix (with Rejection CEIL)
                </h3>
                <p className="text-[11px] text-slate-500">
                  Formula: <strong>Cut Pieces = CEILING(Order Qty × (1 + {header.rejection_pct}%), 1)</strong>
                </p>
              </div>
              <button
                onClick={() => {
                  const newCw: ColorwayRow = {
                    color_name: `Colorway ${activeMarker.colorways.length + 1}`,
                    quantities: activeMarker.sizes.map(() => 0),
                  };
                  updateActiveMarker({ colorways: [...activeMarker.colorways, newCw] });
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
              >
                <Plus size={13} />
                <span>Add Colorway</span>
              </button>
              {markers.length > 1 && (
                <button
                  type="button"
                  title="Copy this marker's colours and size quantities to the other markers (rib / collar fabric follows the body order qty)"
                  onClick={() => {
                    const src = activeMarker;
                    const key = (c?: string) => (c || '').trim().toUpperCase();
                    setMarkers((ms) => ms.map((m, i) => {
                      if (i === activeMarkerIdx) return m;
                      const sizes = m.sizes?.length ? m.sizes : [...src.sizes];
                      const cws = [...(m.colorways || [])];
                      src.colorways.forEach((cw) => {
                        const qtys = sizes.map((sz) => {
                          const k = src.sizes.indexOf(sz);
                          return k >= 0 ? Number(cw.quantities?.[k]) || 0 : 0;
                        });
                        const j = cws.findIndex((x) => key(x.color_name) === key(cw.color_name));
                        if (j >= 0) cws[j] = { ...cws[j], quantities: qtys };
                        else cws.push({ color_name: cw.color_name, quantities: qtys });
                      });
                      return recomputeSingleMarker({ ...m, sizes, colorways: cws });
                    }));
                    toast(`${src.colorways.length} colour(s) copied from ${src.marker_ref} to the other markers — run Auto-Consumption to refresh F.PRGM`, 'success');
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-700"
                >
                  <span>Copy colours to all markers</span>
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                    <th className="py-2 px-3 w-48">Colorway / Shade</th>
                    <th className="py-2 px-2 text-center w-28">Metric</th>
                    {activeMarker.sizes.map((s, sIdx) => (
                      <th key={sIdx} className="py-2 px-2 text-right min-w-[70px]">
                        {s}
                      </th>
                    ))}
                    <th className="py-2 px-2 text-right font-bold w-24">Total Pcs</th>
                    <th className="py-2 px-2 text-right font-bold text-indigo-700 w-28">Req ({isWoven ? 'MTR' : (activeMarker.uom || 'KG')})</th>
                    <th className="py-2 px-2 text-center w-10">Del</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {activeMarker.colorways.map((cw, cwIdx) => {
                    const effRej = activeMarker.rejection_pct != null ? Number(activeMarker.rejection_pct) : Number(header.rejection_pct ?? 3.0);
                    const rawQtys = activeMarker.sizes.map((_, sIdx) => Number(cw.quantities?.[sIdx]) || 0);
                    const cutQtys = rawQtys.map((q) =>
                      Math.ceil(q * (1 + (effRej / 100.0)))
                    );
                    const totOrder = rawQtys.reduce((a, b) => a + b, 0);
                    const totCut = cutQtys.reduce((a, b) => a + b, 0);

                    let reqVal = 0;
                    if (!isWoven) {
                      reqVal = Math.round(((activeMarker.avg_wt_per_pc_g * totCut) / 1000.0) * 100) / 100;
                    } else {
                      reqVal = Math.round(((activeMarker.req_length_per_pc_cm * totCut) / 100.0) * 100) / 100;
                    }

                    return (
                      <React.Fragment key={cwIdx}>
                        {/* Row 1: Raw Order Quantity Input */}
                        <tr className="hover:bg-slate-50/50">
                          <td rowSpan={2} className="py-2 px-3 align-middle border-r border-slate-100 bg-white">
                            {(jobColours.data ?? []).length > 0 ? (
                              <select
                                value={cw.color_name}
                                id={`cad-cw-colour-${cwIdx}`}
                                onChange={(e) => {
                                  const copy = [...activeMarker.colorways];
                                  copy[cwIdx].color_name = e.target.value;
                                  updateActiveMarker({ colorways: copy });
                                }}
                                className={`w-44 text-xs font-semibold border rounded px-2 py-1 ${(jobColours.data ?? []).some((c: any) => String(c.color_name).toUpperCase() === String(cw.color_name).toUpperCase()) ? 'border-slate-300' : 'border-red-400 bg-red-50'}`}
                                title="Colours of this IO's sales order"
                              >
                                {!(jobColours.data ?? []).some((c: any) => String(c.color_name).toUpperCase() === String(cw.color_name).toUpperCase()) && (
                                  <option value={cw.color_name}>{cw.color_name ? `${cw.color_name} (not on the order)` : '— Colour of the order —'}</option>
                                )}
                                {(jobColours.data ?? []).map((c: any) => <option key={c.color_id} value={c.color_name}>{c.color_name}</option>)}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={cw.color_name}
                                onChange={(e) => {
                                  const copy = [...activeMarker.colorways];
                                  copy[cwIdx].color_name = e.target.value;
                                  updateActiveMarker({ colorways: copy });
                                }}
                                title={header.internal_ir_no ? 'This IO has no colours on its sales order' : 'Pick the IO first — its order colours become a list'}
                                className="w-44 text-xs font-semibold border border-slate-300 rounded px-2 py-1"
                              />
                            )}
                          </td>
                          <td className="py-1 px-2 text-center font-medium text-slate-500 bg-slate-50/50">Order Qty</td>
                          {activeMarker.sizes.map((_, sIdx) => {
                            const q = Number(cw.quantities?.[sIdx]) || 0;
                            return (
                              <td key={sIdx} className="py-1 px-2 text-right">
                                <input
                                  type="number"
                                  value={q}
                                  onChange={(e) => {
                                    const copy = [...activeMarker.colorways];
                                    const qCopy = [...(copy[cwIdx].quantities || [])];
                                    qCopy[sIdx] = parseInt(e.target.value) || 0;
                                    copy[cwIdx].quantities = qCopy;
                                    updateActiveMarker({ colorways: copy });
                                  }}
                                  className="w-20 text-xs text-right font-medium border border-slate-300 rounded px-1.5 py-1"
                                />
                              </td>
                            );
                          })}
                          <td className="py-1 px-2 text-right font-bold text-slate-900">
                            {fmtNumber(totOrder)}
                          </td>
                          <td className="py-1 px-2 text-right font-bold text-indigo-700">
                            {fmtDecimal(reqVal)} {isWoven ? 'MTR' : (activeMarker.uom || 'KG')}
                          </td>
                          <td className="py-1 px-2 text-center">
                            <button
                              onClick={() => {
                                const copy = activeMarker.colorways.filter((_, i) => i !== cwIdx);
                                updateActiveMarker({ colorways: copy });
                              }}
                              className="p-1 text-slate-400 hover:text-red-600 rounded"
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>

                        {/* Row 2: Computed Cut Pieces with Rejection CEIL */}
                        <tr className="bg-amber-50/30 text-[11px] text-amber-900">
                          <td className="py-1 px-2 text-center font-semibold text-amber-800 bg-amber-50/60">Cut Pieces (Ceil)</td>
                          {activeMarker.sizes.map((_, sIdx) => (
                            <td key={sIdx} className="py-1 px-2 text-right font-mono font-medium">
                              {cutQtys[sIdx] ?? 0}
                            </td>
                          ))}
                          <td className="py-1 px-2 text-right font-bold font-mono">
                            {fmtNumber(totCut)}
                          </td>
                          <td className="py-1 px-2 text-right text-[10px] text-amber-700 font-medium">
                            +{effRej}% buffer
                          </td>
                          <td></td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: FABRIC PROGRAM (F.PRGM) */}
      {activeTab === 'F_PRGM' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-6">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <FileSpreadsheet size={16} className="text-indigo-600" />
                <span>Fabric Request & Indent Program (F.PRGM)</span>
              </h2>
              <p className="text-xs text-slate-500">
                Official consolidated fabric procurement indent with explicit Dia, safety buffers and process allowances
              </p>
            </div>
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm"
            >
              <Printer size={14} />
              <span>Print F.PRGM</span>
            </button>
          </div>

          {/* Section A: Main Body & Rib Knitted Fabric Indent */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-indigo-600 inline-block"></span>
                <span>Part A: Main Body & Knitted Fabric Indent</span>
              </h3>
              <span className="text-[11px] text-slate-500 font-medium">
                Calculated from Marker Width & Lay Length
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                    <th className="py-2.5 px-3">Fabric Type</th>
                    <th className="py-2.5 px-2">GSM</th>
                    <th className="py-2.5 px-2">Dia (Inches)</th>
                    <th className="py-2.5 px-2">Dia Form</th>
                    <th className="py-2.5 px-3">Colour / Shade</th>
                    <th className="py-2.5 px-2 text-right">Order Qty</th>
                    <th className="py-2.5 px-2 text-right">Net Req ({header.uom})</th>
                    <th className="py-2.5 px-2 text-right">Buffer ({header.uom})</th>
                    <th className="py-2.5 px-2 text-right text-purple-700 font-bold">Sample ({header.uom})</th>
                    <th className="py-2.5 px-3 text-right text-indigo-700">Grand Total ({header.uom})</th>
                    {!isWoven && <th className="py-2.5 px-3 text-right text-sky-700" title="KG × 1000 ÷ (GSM × width m); tube = 2 layers">Meterage (MTR)</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {fabricProgram.map((fp, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-3 font-semibold text-slate-900">{fp.fabric_type}</td>
                      <td className="py-2.5 px-2">{fp.gsm || '—'}</td>
                      <td className="py-2.5 px-2 font-bold text-indigo-700">
                        {fp.dia_val || fp.dia_spec?.split(' ')?.[0] || '—'}
                      </td>
                      <td className="py-2.5 px-2">
                        <Badge tone={fp.dia_type === 'TUBE' || fp.dia_spec?.includes('TUBE') ? 'purple' : 'blue'}>
                          {fp.dia_type === 'TUBE' || fp.dia_spec?.includes('TUBE') ? 'TUBE' : 'OPEN'}
                        </Badge>
                      </td>
                      <td className="py-2.5 px-3 font-bold text-slate-800">{fp.color_name}</td>
                      <td className="py-2.5 px-2 text-right">{fmtNumber(fp.order_qty_pcs)} Pcs</td>
                      <td className="py-2.5 px-2 text-right font-medium">{fmtDecimal(fp.net_qty)}</td>
                      <td className="py-2.5 px-2 text-right text-amber-700 font-medium">+{fmtDecimal(fp.buffer_qty)}</td>
                      <td className="py-2.5 px-2 text-right text-purple-700 font-medium">
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-[10px] text-purple-500 font-bold">+</span>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            value={fp.sample_qty ?? ''}
                            placeholder="0"
                            onChange={(e) => {
                              const sQty = Math.max(0, parseFloat(e.target.value) || 0);
                              setFabricProgram((prev) => {
                                const next = [...prev];
                                const row = { ...next[idx] };
                                row.sample_qty = sQty;
                                const net = Number(row.net_qty) || 0;
                                const buf = Number(row.buffer_qty) || 0;
                                row.grand_total_qty = Math.round((Math.ceil(net) + buf + sQty) * 100) / 100;
                                next[idx] = row;
                                return next;
                              });
                            }}
                            className="w-14 text-right font-bold text-purple-900 border border-purple-300 rounded px-1.5 py-0.5 bg-purple-50/50 focus:bg-white text-xs"
                          />
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-bold text-indigo-700 text-sm">
                        {fmtDecimal(fp.grand_total_qty)} {fp.uom}
                      </td>
                      {!isWoven && (
                        <td className="py-2.5 px-3 text-right font-semibold text-sky-800">
                          {fabricMeterage(fp) != null ? `${fmtNumber(fabricMeterage(fp))} MTR` : '—'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-indigo-50/60 font-bold text-indigo-900 border-t border-indigo-200">
                    {/* Avg cons / pc moved to the consolidated summary below (includes Part B items) */}
                    <td colSpan={5} className="py-3 px-3">TOTAL CONSOLIDATED FABRIC INDENT</td>
                    <td className="py-3 px-2 text-right">{fmtNumber(summaryKpis.totalOrderPcs)} Pcs</td>
                    <td className="py-3 px-2 text-right">
                      {fmtDecimal(fabricProgram.reduce((s, x) => s + Number(x.net_qty || 0), 0))}
                    </td>
                    <td className="py-3 px-2 text-right text-amber-800">
                      +{fmtDecimal(fabricProgram.reduce((s, x) => s + Number(x.buffer_qty || 0), 0))}
                    </td>
                    <td className="py-3 px-2 text-right text-purple-800">
                      +{fmtDecimal(fabricProgram.reduce((s, x) => s + Number(x.sample_qty || 0), 0))}
                    </td>
                    <td className="py-3 px-3 text-right text-base text-indigo-900">
                      {fmtDecimal(summaryKpis.grandFabric)} {summaryKpis.uom}
                    </td>
                    {!isWoven && (
                      <td className="py-3 px-3 text-right text-sky-900">
                        {fmtNumber(fabricProgram.reduce((a, fp) => a + (fabricMeterage(fp) || 0), 0))} MTR
                      </td>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Section B: Specialized Parts, Tapes & Flat Knit Collar Indent */}
          <div className="space-y-2 pt-2 border-t border-slate-200">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-600 inline-block"></span>
                <span>Part B: Specialized Parts, Tapes & Flat Knit Collar Indent</span>
              </h3>
              <span className="text-[11px] text-amber-800 font-medium">
                Foldings, Neck Binding Tapes, Drawcords & Collar Yarn
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-amber-50/70 text-amber-950 font-bold border-b border-amber-200">
                    <th className="py-2.5 px-3">Item / Part Name</th>
                    <th className="py-2.5 px-3">Fabric / Specification</th>
                    <th className="py-2.5 px-2">Dia / Width</th>
                    <th className="py-2.5 px-2">Colour</th>
                    <th className="py-2.5 px-2 text-right">Pieces / Breakdown</th>
                    <th className="py-2.5 px-2">Unit</th>
                    <th className="py-2.5 px-3 text-right text-amber-900 font-extrabold">Total Requirement</th>
                    <th className="py-2.5 px-3">Procurement Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {/* Flat Knit Collar Row if configured */}
                  {(flatKnitSpec.enabled || Number(flatKnitSpec.total_yarn_kg || 0) > 0) && (
                    <tr className="hover:bg-amber-50/40 bg-amber-50/20 font-medium">
                      <td className="py-2.5 px-3 font-bold text-slate-900 flex items-center gap-1.5">
                        <Disc size={13} className="text-amber-700" />
                        <span>Flat Knit {(flatKnitSpec.components || []).map((c) => c.label).join(' & ') || 'Components'}</span>
                      </td>
                      <td className="py-2.5 px-3">{flatKnitSpec.item_type} ({flatKnitSpec.gsm} GSM)</td>
                      <td className="py-2.5 px-2 font-mono text-slate-600">
                        {flatKnitSpec.size_rows.length > 0 ? `${flatKnitSpec.size_rows[0]?.size} to ${flatKnitSpec.size_rows[flatKnitSpec.size_rows.length - 1]?.size}` : 'All Sizes'}
                      </td>
                      <td className="py-2.5 px-2 font-semibold text-slate-800">{flatKnitSpec.color}</td>
                      <td className="py-2.5 px-2 text-right font-mono font-bold text-slate-800">
                        {(flatKnitSpec.components || []).map((c) => (
                          <div key={c.key}>{fmtNumber(flatKnitSpec.component_totals?.[c.key] || 0)} {c.label}</div>
                        ))}
                      </td>
                      <td className="py-2.5 px-2 font-bold text-amber-900">KG</td>
                      <td className="py-2.5 px-3 text-right font-mono font-extrabold text-amber-900 text-sm">
                        {fmtDecimal(flatKnitSpec.total_yarn_kg, 2)} KG
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-600">{flatKnitSpec.remarks}</td>
                    </tr>
                  )}

                  {/* Specialized Parts Rows */}
                  {specialParts.map((sp, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-3 font-semibold text-slate-900 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                        <span>{sp.part_name}</span>
                      </td>
                      <td className="py-2.5 px-3">{sp.fabric_type} {sp.gsm ? `(${sp.gsm} GSM)` : ''}</td>
                      <td className="py-2.5 px-2 font-mono text-indigo-700 font-semibold">{sp.dia_spec || '—'}</td>
                      <td className="py-2.5 px-2 font-semibold text-slate-800">{sp.color}</td>
                      <td className="py-2.5 px-2 text-right font-mono text-slate-600">
                        {fmtDecimal(sp.consumption_per_pc, 3)} / pc
                      </td>
                      <td className="py-2.5 px-2 font-bold text-slate-700">{sp.uom}</td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold text-indigo-900 text-sm">
                        <div>{fmtDecimal(sp.total_qty, 1)} {sp.uom}</div>
                        {!isKgUom(sp.uom) && (
                          specialPartKg(sp) != null ? (
                            <div className="text-amber-900 text-xs">= {fmtDecimal(specialPartKg(sp), 2)} KG <span className="font-normal text-slate-500">@ {partFactorText(sp)}</span></div>
                          ) : (
                            <div className="text-[10px] font-normal text-red-600">KG factor not set</div>
                          )
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-500">{sp.remarks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section C: Foam & Khada Roll Indent (MTR — Non-Piece Weight) */}
          {foamKhadaItems.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-purple-950 uppercase tracking-wider flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-purple-600 inline-block"></span>
                  <span>Part C: Foam & Khada Roll Indent (MTR — Non-Piece Weight)</span>
                </h3>
                <span className="text-[11px] text-purple-800 font-bold bg-purple-100 border border-purple-200 px-2 py-0.5 rounded">
                  Excluded from Knitted Piece Weight (Trims Procurement Only)
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-purple-50/70 text-purple-950 font-bold border-b border-purple-200">
                      <th className="py-2.5 px-3">Item / Roll Name</th>
                      <th className="py-2.5 px-3">Material Specification</th>
                      <th className="py-2.5 px-2">Width (Inches)</th>
                      <th className="py-2.5 px-2">Colour</th>
                      <th className="py-2.5 px-2 text-right">Cons / Pc (Mtr)</th>
                      <th className="py-2.5 px-2">Unit</th>
                      <th className="py-2.5 px-3 text-right text-purple-900 font-extrabold">Total Requirement</th>
                      <th className="py-2.5 px-3">Procurement Remarks</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {foamKhadaItems.map((fk, idx) => (
                      <tr key={fk.id || idx} className="hover:bg-purple-50/30">
                        <td className="py-2.5 px-3 font-semibold text-slate-900 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
                          <span>{fk.item_name}</span>
                        </td>
                        <td className="py-2.5 px-3">{fk.material_spec || '—'}</td>
                        <td className="py-2.5 px-2 font-mono text-purple-700 font-semibold">{fk.width_in ? `${fk.width_in}"` : '—'}</td>
                        <td className="py-2.5 px-2 font-semibold text-slate-800">{fk.color || '—'}</td>
                        <td className="py-2.5 px-2 text-right font-mono text-slate-600">
                          {fk.consumption_per_pc ? `${fmtDecimal(fk.consumption_per_pc, 3)} / pc` : '—'}
                        </td>
                        <td className="py-2.5 px-2 font-bold text-purple-900">MTR</td>
                        <td className="py-2.5 px-3 text-right font-mono font-extrabold text-purple-900 text-sm">
                          {fmtDecimal(fk.total_mtrs, 1)} MTR
                        </td>
                        <td className="py-2.5 px-3 text-xs text-slate-600">{fk.remarks || 'Interlining roll indent'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-purple-50/60 font-bold text-purple-900 border-t border-purple-200">
                      <td colSpan={6} className="py-2.5 px-3">TOTAL FOAM & KHADA ROLL REQUIREMENT</td>
                      <td className="py-2.5 px-3 text-right font-mono text-sm">
                        {fmtDecimal(foamKhadaItems.reduce((s, x) => s + (Number(x.total_mtrs) || 0), 0))} MTR
                      </td>
                      <td className="py-2.5 px-3 text-xs text-purple-700 font-medium">Purchased via Trims / Sourcing in Meters</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Section D: Consolidated Material & Yarn Procurement Summary Cockpit */}
          <div className="p-4 bg-gradient-to-br from-indigo-50/80 via-slate-50 to-amber-50/60 rounded-xl border border-indigo-200/80 space-y-3">
            <div className="flex items-center justify-between border-b border-indigo-200/60 pb-2">
              <h3 className="text-xs font-bold text-indigo-950 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles size={15} className="text-indigo-600" />
                <span>Consolidated Yarn & Material Procurement Summary</span>
              </h3>
              <span className="text-xs font-semibold text-indigo-700">
                Ready for Yarn & Fabric PO Creation
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="p-3 bg-white/90 rounded-lg border border-slate-200/80">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Main & Rib Fabric</span>
                <div className="text-base font-extrabold text-slate-900 font-mono mt-1">
                  {fmtDecimal(summaryKpis.grandFabric, 2)} <span className="text-xs font-normal text-slate-500">{summaryKpis.uom}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">Body + Rib Knitting</div>
              </div>

              <div className="p-3 bg-white/90 rounded-lg border border-slate-200/80">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Folding Fabric (S/J)</span>
                <div className="text-base font-extrabold text-indigo-900 font-mono mt-1">
                  {fmtDecimal(summaryKpis.foldingFabricKg, 2)} <span className="text-xs font-normal text-slate-500">KG</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">DIA-ANY TUBE / Plackets</div>
              </div>

              <div className="p-3 bg-white/90 rounded-lg border border-amber-200/80 bg-amber-50/40">
                <span className="text-[10px] text-amber-800 font-bold uppercase tracking-wider">Flat Knit Collar Yarn</span>
                <div className="text-base font-extrabold text-amber-900 font-mono mt-1">
                  {fmtDecimal(summaryKpis.collarYarnKg, 2)} <span className="text-xs font-normal text-amber-700">KG</span>
                </div>
                <div className="text-[10px] text-amber-700/80 mt-0.5">
                  {(flatKnitSpec.components || []).map((c) => `${fmtNumber(flatKnitSpec.component_totals?.[c.key] || 0)} ${c.label}`).join(' + ')}
                </div>
              </div>

              <div className="p-3 bg-white/90 rounded-lg border border-slate-200/80">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Tapes & Cords</span>
                <div className="text-base font-extrabold text-indigo-900 font-mono mt-1">
                  {fmtDecimal(summaryKpis.tapesKg, 2)} <span className="text-xs font-normal text-slate-500">KG</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">{fmtDecimal(summaryKpis.totalTapesMtrs, 1)} MTRS converted</div>
              </div>

              <div className="p-3 bg-indigo-600 text-white rounded-lg shadow-sm">
                <span className="text-[10px] text-indigo-200 font-bold uppercase tracking-wider">Grand Total Material</span>
                <div className="text-lg font-extrabold font-mono mt-0.5">
                  {fmtDecimal(summaryKpis.grandTotalMaterial, 2)} <span className="text-xs font-normal text-indigo-200">{summaryKpis.uom}</span>
                </div>
                <div className="text-[10px] text-indigo-200/90 mt-0.5">{isWoven ? 'Total Woven Fabric (MTR)' : 'Fabric + Collar + Fold + Tapes'}</div>
              </div>
            </div>

            {summaryKpis.totalTapesMtrs > 0 && (
              <div className="text-xs text-slate-600 flex items-center justify-between pt-1">
                <span>Total Tapes & Drawcords Requirement:</span>
                <span className="font-bold text-slate-900 font-mono">
                  {fmtDecimal(summaryKpis.totalTapesMtrs, 1)} MTRS = {fmtDecimal(summaryKpis.tapesKg, 2)} KG (Twill Tape & Tube Rope)
                </span>
              </div>
            )}
            {summaryKpis.partsMissingKgFactor > 0 && (
              <div className="text-[11px] text-red-600">
                {summaryKpis.partsMissingKgFactor} non-KG part(s) have no weight factor — set it in Trims & Accessories so the KG purchase requirement is complete.
              </div>
            )}

            {/* Piece Weights: Actual Piece Weight & Average Piece Weight side-by-side */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2.5 border-t border-indigo-200/60 text-xs">
              <span className="font-bold text-indigo-950 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles size={14} className="text-indigo-600" />
                <span>Piece Weight Analysis (incl. collar, foldings, tapes & cords)</span>
              </span>
              <div className="flex flex-wrap items-center gap-2.5 font-mono">
                {/* 1. Actual Piece Weight (before Average Piece Weight) */}
                <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-300 text-amber-950 px-2.5 py-1 rounded-lg shadow-2xs">
                  <span className="text-[10px] font-sans font-bold uppercase tracking-wider text-amber-800">Actual Piece Weight:</span>
                  <span className="font-extrabold text-sm text-amber-950">
                    {fmtDecimal(summaryKpis.actualPieceWt * (isWoven ? 1 : 1000), 2)} {isWoven ? 'Mtrs' : 'Gms'}
                  </span>
                  <span className="text-[10px] font-sans text-amber-700 font-medium">(-{summaryKpis.lossPct}% loss)</span>
                </div>

                {/* 2. Average Piece Weight (Gross) */}
                <div className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-300 text-emerald-950 px-2.5 py-1 rounded-lg shadow-2xs">
                  <span className="text-[10px] font-sans font-bold uppercase tracking-wider text-emerald-800">Average Piece Weight:</span>
                  <span className="font-extrabold text-sm text-emerald-950">
                    {fmtDecimal(summaryKpis.avgConsInclParts * (isWoven ? 1 : 1000), 2)} {isWoven ? 'Mtrs' : 'Gms'}
                  </span>
                </div>

                <span className="text-slate-400 font-sans text-[11px]">
                  ({fmtDecimal(summaryKpis.grandTotalMaterial, 2)} {summaryKpis.uom} ÷ {fmtNumber(summaryKpis.totalOrderPcs)} pcs)
                </span>
              </div>
            </div>
          </div>

          {/* Signoff / Approval Signature Grid */}
          <div className="pt-4 border-t border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Prepared By</span>
              <div className="font-semibold text-xs text-slate-800 mt-2">FAB.PGMR (CAD Dept)</div>
            </div>
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Approved By</span>
              <div className="font-semibold text-xs text-slate-800 mt-2">M.D / Production Head</div>
            </div>
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Approved By</span>
              <div className="font-semibold text-xs text-slate-800 mt-2">MERCH (Merchandiser)</div>
            </div>
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Received By</span>
              <div className="font-semibold text-xs text-slate-800 mt-2">FABRIC Sourcing / Mill</div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: CUTTING LAY SHEET (CUT) */}
      {activeTab === 'CUT' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <Layers size={16} className="text-emerald-600" />
                <span>Cutting Department Lay & Issue Plan (CUT)</span>
              </h2>
              <p className="text-xs text-slate-500">
                Exact net lay cutting schedule and roll allocation without procurement buffers
              </p>
            </div>
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm"
            >
              <Printer size={14} />
              <span>Print Cutting Sheet</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                  <th className="py-2.5 px-3">Fabric Type</th>
                  <th className="py-2.5 px-2">GSM</th>
                  <th className="py-2.5 px-2">Diameter</th>
                  <th className="py-2.5 px-3">Colour / Shade</th>
                  <th className="py-2.5 px-2 text-right">Cutting Lay Qty (Pcs)</th>
                  <th className="py-2.5 px-3 text-right text-emerald-700">Net Cutting Fabric ({header.uom})</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {cuttingLay.map((cl, idx) => {
                  const matchingFp = fabricProgram.find(
                    (fp) => fp.fabric_type === cl.fabric_type && fp.color_name === cl.color_name
                  );
                  const fpGrand = Number(matchingFp?.grand_total_qty || cl.grand_total_qty || cl.net_qty || 0);
                  const sampleQty = Number(matchingFp?.sample_qty || 0);
                  const lossPct = header.fabric_allowance_pct !== undefined && header.fabric_allowance_pct !== null 
                    ? Number(header.fabric_allowance_pct) 
                    : (isWoven ? 2.0 : 12.0);
                  const bulkNetCut = Math.round(fpGrand * (1 - (lossPct / 100.0)) * 100) / 100;
                  const sampleNetCut = sampleQty > 0 ? Math.round(sampleQty * (1 - lossPct / 100) * 100) / 100 : 0;

                  return (
                    <React.Fragment key={idx}>
                      <tr className="hover:bg-slate-50/70">
                        <td className="py-2.5 px-3 font-semibold text-slate-900 flex items-center gap-1.5">
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">BULK</span>
                          <span>{cl.fabric_type}</span>
                        </td>
                        <td className="py-2.5 px-2">{cl.gsm || '—'}</td>
                        <td className="py-2.5 px-2 font-mono text-slate-600">{cl.dia_spec}</td>
                        <td className="py-2.5 px-3 font-bold text-slate-800">{cl.color_name}</td>
                        <td className="py-2.5 px-2 text-right font-medium">{fmtNumber(cl.order_qty_pcs)} Pcs</td>
                        <td className="py-2.5 px-3 text-right">
                          <div className="font-bold text-emerald-700 text-sm">
                            {fmtDecimal(bulkNetCut)} {cl.uom}
                          </div>
                          <div className="text-[10px] text-slate-500 font-normal">
                            ({fmtDecimal(fpGrand, 2)} {cl.uom} − {lossPct}% process loss)
                          </div>
                        </td>
                      </tr>

                      {sampleQty > 0 && (
                        <tr className="bg-purple-50/40 hover:bg-purple-50/70 border-b border-purple-100">
                          <td className="py-2.5 px-3 font-semibold text-purple-950 flex items-center gap-1.5 pl-6">
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-200 text-purple-900">SAMPLE</span>
                            <span>{cl.fabric_type}</span>
                          </td>
                          <td className="py-2.5 px-2 text-purple-800">{cl.gsm || '—'}</td>
                          <td className="py-2.5 px-2 font-mono text-purple-700">{cl.dia_spec}</td>
                          <td className="py-2.5 px-3 font-bold text-purple-900">{cl.color_name} (Sample)</td>
                          <td className="py-2.5 px-2 text-right text-purple-700 font-medium italic">Fitting / Development</td>
                          <td className="py-2.5 px-3 text-right">
                            <div className="font-bold text-purple-900 text-sm">{fmtDecimal(sampleNetCut)} {cl.uom}</div>
                            <div className="text-[10px] text-purple-600 font-normal">({fmtDecimal(sampleQty, 2)} kg − {lossPct}% process loss)</div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                {(() => {
                  const totalBulkCut = cuttingLay.reduce((s, x) => s + Number(x.net_qty || 0), 0);
                  const totalSampleCut = cuttingLay.reduce((s, cl) => {
                    const mFp = fabricProgram.find((fp) => fp.fabric_type === cl.fabric_type && fp.color_name === cl.color_name);
                    const sq = Number(mFp?.sample_qty || 0);
                    const loss = header.fabric_allowance_pct !== undefined && header.fabric_allowance_pct !== null ? Number(header.fabric_allowance_pct) : 0;
                    return s + (sq > 0 ? Math.round(sq * (1 - loss / 100) * 100) / 100 : 0);
                  }, 0);

                  return (
                    <tr className="bg-emerald-50/60 font-bold text-emerald-900 border-t border-emerald-200">
                      <td colSpan={4} className="py-3 px-3">
                        TOTAL CUTTING DEPARTMENT REQUIREMENT
                        {totalSampleCut > 0 && (
                          <span className="text-xs font-normal text-emerald-700 ml-2">
                            (Bulk: {fmtDecimal(totalBulkCut)} {summaryKpis.uom} + Sample: {fmtDecimal(totalSampleCut)} {summaryKpis.uom})
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-2 text-right">
                        {fmtNumber(cuttingLay.reduce((s, x) => s + Number(x.order_qty_pcs || 0), 0))} Pcs
                      </td>
                      <td className="py-3 px-3 text-right text-base text-emerald-900">
                        {fmtDecimal(totalBulkCut + totalSampleCut)} {summaryKpis.uom}
                      </td>
                    </tr>
                  );
                })()}
              </tfoot>
            </table>
          </div>

          {/* Foldings / specialized parts are issued to cutting too (zip folding, BNT, tapes & cords) */}
          {specialParts.length > 0 && (
            <div className="space-y-2 pt-3 border-t border-slate-200">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                <Scissors size={14} className="text-amber-700" />
                <span>Foldings, Specialized Parts, Tapes & Cords — Cutting Issue</span>
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-amber-50/70 text-amber-950 font-bold border-b border-amber-200">
                      <th className="py-2.5 px-3">Part Name</th>
                      <th className="py-2.5 px-3">Fabric / Material Spec</th>
                      <th className="py-2.5 px-2">Dia / Form</th>
                      <th className="py-2.5 px-2">Colour</th>
                      <th className="py-2.5 px-2 text-right">Cons / Pc</th>
                      <th className="py-2.5 px-2 text-right">Total Qty</th>
                      <th className="py-2.5 px-3 text-right text-amber-900">Total KG</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {specialParts.map((sp, idx) => {
                      const kg = specialPartKg(sp);
                      return (
                        <tr key={idx} className="hover:bg-slate-50/70">
                          <td className="py-2.5 px-3 font-semibold text-slate-900">{sp.part_name}</td>
                          <td className="py-2.5 px-3">{sp.fabric_type} {sp.gsm ? `(${sp.gsm} GSM)` : ''}</td>
                          <td className="py-2.5 px-2 font-mono text-slate-600">{sp.dia_spec || '—'}</td>
                          <td className="py-2.5 px-2 font-semibold text-slate-800">{sp.color}</td>
                          <td className="py-2.5 px-2 text-right font-mono">{fmtDecimal(sp.consumption_per_pc, 3)} {sp.uom}</td>
                          <td className="py-2.5 px-2 text-right font-mono font-bold">{fmtDecimal(sp.total_qty, 1)} {sp.uom}</td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold text-amber-900">
                            {kg != null ? `${fmtDecimal(kg, 2)} KG` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-amber-50/60 font-bold text-amber-950 border-t border-amber-200">
                      <td colSpan={6} className="py-3 px-3">TOTAL FOLDINGS & SPECIALIZED PARTS</td>
                      <td className="py-3 px-3 text-right font-mono">
                        {fmtDecimal(summaryKpis.foldingFabricKg + summaryKpis.tapesKg, 2)} KG
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: TRIMS & ACCESSORIES */}
      {activeTab === 'TRIMS' && (
        <div className="space-y-6">
          {/* Card 1: Flat Knit Component Size-Dimension Matrix (Collar / Cuff / other add-on components) */}
          <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-slate-100">
              <div>
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-amber-100 text-amber-800">
                    <Disc size={16} />
                  </span>
                  <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                    Flat Knit Components Size-Dimension Matrix
                  </h2>
                  <Badge tone={flatKnitSpec.enabled ? 'emerald' : 'slate'}>
                    {flatKnitSpec.enabled ? 'Active / Indented' : 'Optional / Disabled'}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Select the components this garment needs (Collar, Cuff, or other add-ons) — size-wise dimensions, piece counts, weight per piece and yarn indent
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextEnabled = !flatKnitSpec.enabled;
                    const updated = recalculateFlatKnit({
                      ...flatKnitSpec,
                      enabled: nextEnabled,
                    });
                    setFlatKnitSpec(updated);
                  }}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition ${
                    flatKnitSpec.enabled
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                  title="Toggle Flat Knit calculation in F.PRGM and procurement summary"
                >
                  <Disc size={13} />
                  <span>{flatKnitSpec.enabled ? 'Flat Knit Active' : 'Enable Flat Knit'}</span>
                </button>
                <button
                  type="button"
                  onClick={syncSizesFromMarkers}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition"
                  title="Pull sizes and cut piece counts from active markers"
                >
                  <Sparkles size={13} />
                  <span>Sync Sizes from Markers</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const values: Record<string, ComponentCell> = {};
                    (flatKnitSpec.components || []).forEach((c) => { values[c.key] = { dimension: '', pcs: 50 }; });
                    const newRow: CollarDimensionRow = {
                      size: `Size ${flatKnitSpec.size_rows.length + 1}`,
                      values,
                    };
                    const updated = recalculateFlatKnit({
                      ...flatKnitSpec,
                      size_rows: [...flatKnitSpec.size_rows, newRow],
                    });
                    setFlatKnitSpec(updated);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 transition"
                >
                  <Plus size={13} />
                  <span>Add Size Row</span>
                </button>
              </div>
            </div>

            {/* Flat Knit Specification Header Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 bg-slate-50/80 p-3 rounded-lg border border-slate-200/60">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Item Description / Type
                </label>
                <input
                  type="text"
                  value={flatKnitSpec.item_type}
                  onChange={(e) => setFlatKnitSpec({ ...flatKnitSpec, item_type: e.target.value })}
                  placeholder="95% COTTON 5% ELASTANE 2X2 FLATKNIT"
                  className="w-full text-xs font-semibold text-slate-800 border border-slate-300 rounded px-2 py-1.5 bg-white"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Colour / Yarn Shade
                </label>
                <input
                  type="text"
                  value={flatKnitSpec.color}
                  onChange={(e) => setFlatKnitSpec({ ...flatKnitSpec, color: e.target.value })}
                  placeholder="NAVY / MOTTLED GREY MELANGE"
                  className="w-full text-xs font-semibold text-slate-800 border border-slate-300 rounded px-2 py-1.5 bg-white"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Weight / Set (sum of components)
                </label>
                <div className="flex items-center gap-1">
                  <div className="w-full text-xs font-mono font-bold text-amber-900 border border-slate-200 rounded px-2 py-1.5 bg-slate-100">
                    {fmtDecimal(flatKnitSpec.weight_per_set_g, 1)}
                  </div>
                  <span className="text-[11px] text-slate-500 font-medium whitespace-nowrap">Gms</span>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Industry Presets
                </label>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    type="button"
                    onClick={() => {
                      const { updated, primary } = applyFlatKnitPreset(
                        184,
                        'Mens: 0.040+0.052+0.092 = 0.184 GRM (Collar, Cuff, Bottom) | 500 GSM',
                      );
                      toast(`Applied Mens preset — ${primary.label} 184g / set (Weight / Set ${updated.weight_per_set_g}g)`, 'info');
                    }}
                    className="px-2 py-1 text-[11px] font-semibold rounded border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 transition"
                  >
                    Mens (184g)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const { updated, primary } = applyFlatKnitPreset(
                        137,
                        'Boys: 0.031+0.040+0.066 = 0.137 GRM (Collar, Cuff, Bottom) | 500 GSM',
                      );
                      toast(`Applied Boys preset — ${primary.label} 137g / set (Weight / Set ${updated.weight_per_set_g}g)`, 'info');
                    }}
                    className="px-2 py-1 text-[11px] font-semibold rounded border border-sky-300 bg-sky-50 hover:bg-sky-100 text-sky-800 transition"
                  >
                    Boys (137g)
                  </button>
                </div>
              </div>
            </div>

            {/* Component selector: choose which components this garment has */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                {(flatKnitSpec.components || []).map((c) => (
                  <div key={c.key} className="flex items-end gap-1.5 p-2 rounded-lg border border-amber-200 bg-amber-50/40">
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Component</label>
                      <select
                        value={c.type}
                        onChange={(e) => updateFlatKnitComponent(c.key, { type: e.target.value as TrimComponentType })}
                        className="text-xs font-semibold border border-slate-300 rounded px-1 py-1 bg-white"
                      >
                        <option value="COLLAR">Collar</option>
                        <option value="CUFF">Cuff</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Name</label>
                      <input
                        type="text"
                        value={c.label}
                        onChange={(e) => updateFlatKnitComponent(c.key, { label: e.target.value })}
                        className="w-28 text-xs font-semibold border border-slate-300 rounded px-1.5 py-1 bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-0.5">Wt / Pc (g)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={c.weight_g}
                        onChange={(e) => updateFlatKnitComponent(c.key, { weight_g: parseFloat(e.target.value) || 0 })}
                        className="w-16 text-xs text-right font-mono font-bold text-amber-900 border border-slate-300 rounded px-1 py-1 bg-white"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFlatKnitComponent(c.key)}
                      className="p-1 mb-0.5 text-slate-400 hover:text-red-600 rounded"
                      title={`Remove ${c.label}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <div className="flex items-end gap-1.5 p-2 rounded-lg border border-dashed border-slate-300">
                  <select
                    value={newComponentType}
                    onChange={(e) => setNewComponentType(e.target.value as TrimComponentType)}
                    className="text-xs font-medium border border-slate-300 rounded px-1 py-1 bg-white"
                  >
                    <option value="COLLAR">Collar</option>
                    <option value="CUFF">Cuff</option>
                    <option value="OTHER">Other Component</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => addFlatKnitComponent(newComponentType)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
                  >
                    <Plus size={12} />
                    <span>Add Component</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Size Breakdown Dimension Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100/90 text-slate-700 font-bold border-b border-slate-200">
                    <th className="py-2.5 px-3 w-28">Size Label</th>
                    {(flatKnitSpec.components || []).map((c) => (
                      <React.Fragment key={c.key}>
                        <th className="py-2.5 px-3">{c.label} Dimension</th>
                        <th className="py-2.5 px-2 text-right w-24">{c.label} (Nos)</th>
                      </React.Fragment>
                    ))}
                    <th className="py-2.5 px-3 text-right w-28 text-amber-900">Yarn Wt (Kg)</th>
                    <th className="py-2.5 px-2 text-center w-12">Del</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {flatKnitSpec.size_rows.map((row, idx) => {
                    const rowKg = Math.round((flatKnitSpec.components || []).reduce(
                      (s, c) => s + (Number(row.values?.[c.key]?.pcs) || 0) * (Number(c.weight_g) || 0) / 1000, 0,
                    ) * 100) / 100;
                    return (
                      <tr key={idx} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={row.size}
                            onChange={(e) => {
                              const copy = [...flatKnitSpec.size_rows];
                              copy[idx] = { ...copy[idx], size: e.target.value };
                              setFlatKnitSpec(recalculateFlatKnit({ ...flatKnitSpec, size_rows: copy }));
                            }}
                            className="w-24 text-xs font-bold text-slate-900 border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        {(flatKnitSpec.components || []).map((c) => (
                          <React.Fragment key={c.key}>
                            <td className="py-2 px-3">
                              <input
                                type="text"
                                value={row.values?.[c.key]?.dimension || ''}
                                onChange={(e) => setFlatKnitCell(idx, c.key, { dimension: e.target.value })}
                                placeholder='e.g. 15.25" X 5.50"'
                                className="w-full min-w-[7rem] text-xs font-mono font-medium text-slate-800 border border-slate-300 rounded px-2 py-1 bg-white"
                              />
                            </td>
                            <td className="py-2 px-2 text-right">
                              <input
                                type="number"
                                value={row.values?.[c.key]?.pcs || 0}
                                onChange={(e) => setFlatKnitCell(idx, c.key, { pcs: parseInt(e.target.value) || 0 })}
                                className="w-20 text-xs text-right font-mono font-bold text-slate-900 border border-slate-300 rounded px-1.5 py-1 bg-white"
                              />
                            </td>
                          </React.Fragment>
                        ))}
                        <td className="py-2 px-3 text-right font-mono font-bold text-amber-900">
                          {fmtDecimal(rowKg, 2)} kg
                        </td>
                        <td className="py-2 px-2 text-center">
                          <button
                            type="button"
                            onClick={() => {
                              const copy = flatKnitSpec.size_rows.filter((_, i) => i !== idx);
                              setFlatKnitSpec(recalculateFlatKnit({ ...flatKnitSpec, size_rows: copy }));
                            }}
                            className="p-1 text-slate-400 hover:text-red-600 rounded"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-amber-50/70 font-bold text-amber-950 border-t-2 border-amber-200">
                    <td className="py-2.5 px-3">
                      TOTALS
                      <div className="text-[10px] text-slate-500 font-normal">{flatKnitSpec.size_rows.length} Sizes Defined</div>
                    </td>
                    {(flatKnitSpec.components || []).map((c) => (
                      <React.Fragment key={c.key}>
                        <td className="py-2.5 px-3"></td>
                        <td className="py-2.5 px-2 text-right font-mono text-sm">
                          {fmtNumber(flatKnitSpec.component_totals?.[c.key] || 0)} Nos
                        </td>
                      </React.Fragment>
                    ))}
                    <td className="py-2.5 px-3 text-right font-mono text-sm text-amber-900 font-extrabold">
                      {fmtDecimal(flatKnitSpec.total_yarn_kg, 2)} KG
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 bg-amber-50/40 rounded-lg border border-amber-200/60 text-xs text-amber-950">
              <span className="font-semibold">
                Formula: {(flatKnitSpec.components || [])
                  .map((c) => `${c.label} ${fmtNumber(flatKnitSpec.component_totals?.[c.key] || 0)} Nos × ${c.weight_g}g`)
                  .join(' + ') || 'No components'} = {flatKnitSpec.total_yarn_kg} KG Flat Knit Yarn
              </span>
              <span className="text-[11px] text-amber-800">
                Auto-synced into Fabric Program (F.PRGM) & Yarn Indent
              </span>
            </div>
          </div>

          {/* Card 2: Specialized Parts, Tapes, Foldings & Accessories */}
          <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                  <Scissors size={16} className="text-indigo-600" />
                  <span>Specialized Parts, Foldings, Tapes & Cords Indent</span>
                </h2>
                <p className="text-xs text-slate-500">
                  Requirements for Zip Folding, 10mm Twill Tape, 15mm Draw Cord, and Back Neck Tape (BNT) — MTRS / PCS items are converted to KG for purchase via the weight factor (m per kg or g per m)
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setSpecialParts((p) => [
                    ...p,
                    {
                      part_name: 'New Specialized Part',
                      fabric_type: 'Single Jersey',
                      gsm: 160,
                      dia_spec: 'DIA-ANY (TUBE)',
                      color: 'NAVY',
                      consumption_per_pc: 0.01,
                      uom: 'KG',
                      total_qty: 10,
                      total_kg: 10,
                      remarks: '',
                    },
                  ])
                }
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
              >
                <Plus size={13} />
                <span>Add Specialized Part</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                    <th className="py-2.5 px-3">Part Name</th>
                    <th className="py-2.5 px-3">Fabric / Material Spec</th>
                    <th className="py-2.5 px-2">Dia / Form</th>
                    <th className="py-2.5 px-2">Color</th>
                    <th className="py-2.5 px-2 text-right">Cons / Pc</th>
                    <th className="py-2.5 px-2">Unit</th>
                    <th className="py-2.5 px-2 text-right">Total Qty</th>
                    <th className="py-2.5 px-2 text-right" title="Weight factor for MTRS / PCS rows: m (or pcs) per kg, e.g. draw cord 290 m ÷ 50 m/kg = 5.8 kg — or g per m (or per pc) from the supplier spec, e.g. 290 m × 20 g/m = 5.8 kg">Weight Factor</th>
                    <th className="py-2.5 px-2 text-right text-amber-900">Total KG</th>
                    <th className="py-2.5 px-3">Remarks / Formula</th>
                    <th className="py-2.5 px-2 text-center">Del</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {specialParts.map((sp, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/70">
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={sp.part_name}
                          onChange={(e) => {
                            const copy = [...specialParts];
                            copy[idx].part_name = e.target.value;
                            setSpecialParts(copy);
                          }}
                          className="w-36 text-xs font-semibold border border-slate-300 rounded px-2 py-1 bg-white"
                        />
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          list="cad-fabrics-master-list"
                          value={sp.fabric_type}
                          placeholder="Select fabric or type..."
                          onChange={(e) => {
                            const copy = [...specialParts];
                            copy[idx].fabric_type = e.target.value;
                            setSpecialParts(copy);
                          }}
                          className="w-48 text-xs border border-indigo-200 rounded px-2 py-1 bg-white"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="text"
                          value={sp.dia_spec || ''}
                          onChange={(e) => {
                            const copy = [...specialParts];
                            copy[idx].dia_spec = e.target.value;
                            setSpecialParts(copy);
                          }}
                          placeholder="DIA-ANY (TUBE)"
                          className="w-28 text-xs font-mono border border-slate-300 rounded px-1.5 py-1 bg-white"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <input
                          type="text"
                          value={sp.color}
                          onChange={(e) => {
                            const copy = [...specialParts];
                            copy[idx].color = e.target.value;
                            setSpecialParts(copy);
                          }}
                          className="w-20 text-xs border border-slate-300 rounded px-1.5 py-1 bg-white"
                        />
                      </td>
                      <td className="py-2 px-2 text-right">
                        <input
                          type="number"
                          step="0.001"
                          value={sp.consumption_per_pc}
                          onChange={(e) => {
                            const copy = [...specialParts];
                            const cVal = parseFloat(e.target.value) || 0;
                            copy[idx] = withPartKg({
                              ...copy[idx],
                              consumption_per_pc: cVal,
                              total_qty: Math.round(cVal * header.order_qty * 100) / 100,
                            });
                            setSpecialParts(copy);
                          }}
                          className="w-20 text-xs text-right font-mono border border-slate-300 rounded px-1.5 py-1 bg-white"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <select
                          value={sp.uom}
                          onChange={(e) => {
                            const copy = [...specialParts];
                            copy[idx] = withPartKg({
                              ...copy[idx], uom: e.target.value,
                              // Tapes / cords: 50 m = 1 kg unless a factor is already set (client call 29-Sep-2026)
                              ...(e.target.value === 'MTRS' && !(Number(copy[idx].kg_factor) > 0) ? { kg_factor: 50, kg_factor_unit: 'PER_KG' as const } : {}),
                            });
                            setSpecialParts(copy);
                          }}
                          className="text-xs font-medium border border-slate-300 rounded px-1 py-1 bg-white"
                        >
                          <option value="KG">KG</option>
                          <option value="MTRS">MTRS</option>
                          <option value="PCS">PCS</option>
                        </select>
                      </td>
                      <td className="py-2 px-2 text-right font-bold text-indigo-900 font-mono">
                        <input
                          type="number"
                          step="0.1"
                          value={sp.total_qty}
                          onChange={(e) => {
                            const copy = [...specialParts];
                            copy[idx] = withPartKg({ ...copy[idx], total_qty: parseFloat(e.target.value) || 0 });
                            setSpecialParts(copy);
                          }}
                          className="w-20 text-xs text-right font-mono font-bold text-indigo-900 border border-slate-300 rounded px-1 py-1 bg-white"
                        />
                      </td>
                      <td className="py-2 px-2 text-right">
                        {isKgUom(sp.uom) ? (
                          <span className="text-slate-400">—</span>
                        ) : (() => {
                          const { factor, unit } = readPartFactor(sp);
                          return (
                            <div className="flex items-center justify-end gap-1">
                              <input
                                type="number"
                                step="0.001"
                                min="0"
                                value={factor > 0 ? factor : ''}
                                placeholder={unit === 'G_PER' ? 'g' : 'qty'}
                                onChange={(e) => {
                                  const copy = [...specialParts];
                                  copy[idx] = withPartKg({
                                    ...copy[idx],
                                    kg_factor: parseFloat(e.target.value) || 0,
                                    kg_factor_unit: unit,
                                  });
                                  setSpecialParts(copy);
                                }}
                                className={`w-16 text-xs text-right font-mono border rounded px-1 py-1 bg-white ${factor > 0 ? 'border-slate-300' : 'border-red-300'}`}
                              />
                              <select
                                value={unit}
                                title="Factor unit"
                                onChange={(e) => {
                                  // Only the meaning of the entered number changes; nothing is auto-converted
                                  const copy = [...specialParts];
                                  copy[idx] = withPartKg({
                                    ...copy[idx],
                                    kg_factor: factor,
                                    kg_factor_unit: e.target.value as PartFactorUnit,
                                  });
                                  setSpecialParts(copy);
                                }}
                                className="text-[11px] border border-slate-300 rounded px-0.5 py-1 bg-white"
                              >
                                <option value="PER_KG">{factorUnitLabel('PER_KG', sp.uom)}</option>
                                <option value="G_PER">{factorUnitLabel('G_PER', sp.uom)}</option>
                              </select>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-2 px-2 text-right font-mono font-bold text-amber-900 whitespace-nowrap">
                        {specialPartKg(sp) != null ? `${fmtDecimal(specialPartKg(sp), 2)} KG` : <span className="text-red-500 font-normal">set factor</span>}
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={sp.remarks}
                          onChange={(e) => {
                            const copy = [...specialParts];
                            copy[idx].remarks = e.target.value;
                            setSpecialParts(copy);
                          }}
                          className="w-full text-xs text-slate-600 border border-slate-300 rounded px-2 py-1 bg-white"
                        />
                      </td>
                      <td className="py-2 px-2 text-center">
                        <button
                          type="button"
                          onClick={() => setSpecialParts((p) => p.filter((_, i) => i !== idx))}
                          className="p-1 text-slate-400 hover:text-red-600 rounded"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-amber-50/60 font-bold text-amber-950 border-t border-amber-200">
                    <td colSpan={6} className="py-2.5 px-3">
                      TOTALS
                      {summaryKpis.totalTapesMtrs > 0 && (
                        <span className="ml-2 text-xs font-normal text-slate-600">{fmtDecimal(summaryKpis.totalTapesMtrs, 1)} MTRS tapes & cords</span>
                      )}
                    </td>
                    <td className="py-2.5 px-2"></td>
                    <td className="py-2.5 px-2"></td>
                    <td className="py-2.5 px-2 text-right font-mono whitespace-nowrap">
                      {fmtDecimal(summaryKpis.foldingFabricKg + summaryKpis.tapesKg, 2)} KG
                    </td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Card 3: Foam & Khada Roll Indent (MTR) - Non-Piece Weight Interlinings */}
          <div className="bg-white rounded-xl border border-purple-200/90 shadow-sm p-4 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-purple-100">
              <div>
                <h2 className="text-sm font-bold text-purple-950 uppercase tracking-wider flex items-center gap-1.5">
                  <Scissors size={16} className="text-purple-600" />
                  <span>Foam & Khada Roll Indent (MTR) — Specialized Interlinings</span>
                </h2>
                <p className="text-xs text-slate-500">
                  Interlining Foam rolls, Khada fabric, and chest canvases purchased in <strong>Meters (MTR)</strong>. These quantities are strictly excluded from the Garment Piece Weight (Gms) calculation and Knitted Fabric (KG) sum.
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setFoamKhadaItems((p) => [
                    ...p,
                    {
                      id: `fk-${Date.now()}`,
                      item_name: 'Foam Sheet Roll',
                      material_spec: '10mm High-Density Foam',
                      color: 'White',
                      width_in: 44,
                      consumption_per_pc: 0.15,
                      total_mtrs: Math.round(0.15 * (header.order_qty || 0) * 100) / 100,
                      remarks: 'Chest interlining',
                    },
                  ])
                }
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border border-purple-300 bg-purple-50 hover:bg-purple-100 text-purple-800"
              >
                <Plus size={13} />
                <span>Add Foam / Khada Item</span>
              </button>
            </div>

            {foamKhadaItems.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-400 bg-slate-50/50 rounded-lg border border-dashed border-slate-200">
                No Foam or Khada roll items defined for this style. Click "+ Add Foam / Khada Item" if this order requires foam or khada interlinings.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-purple-50/70 text-purple-950 font-bold border-b border-purple-200">
                      <th className="py-2.5 px-3">Item / Roll Name</th>
                      <th className="py-2.5 px-3">Material Specification</th>
                      <th className="py-2.5 px-2">Width (Inches)</th>
                      <th className="py-2.5 px-2">Colour</th>
                      <th className="py-2.5 px-2 text-right">Cons / Pc (Mtr)</th>
                      <th className="py-2.5 px-2 text-right text-purple-900 font-bold">Total Requirement (MTR)</th>
                      <th className="py-2.5 px-3">Remarks / Usage</th>
                      <th className="py-2.5 px-2 text-center">Del</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {foamKhadaItems.map((fk, idx) => (
                      <tr key={fk.id || idx} className="hover:bg-purple-50/30">
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={fk.item_name}
                            onChange={(e) => {
                              const copy = [...foamKhadaItems];
                              copy[idx].item_name = e.target.value;
                              setFoamKhadaItems(copy);
                            }}
                            className="w-40 text-xs font-semibold border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={fk.material_spec || ''}
                            onChange={(e) => {
                              const copy = [...foamKhadaItems];
                              copy[idx].material_spec = e.target.value;
                              setFoamKhadaItems(copy);
                            }}
                            className="w-44 text-xs border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            type="number"
                            value={fk.width_in || ''}
                            onChange={(e) => {
                              const copy = [...foamKhadaItems];
                              copy[idx].width_in = parseFloat(e.target.value) || '';
                              setFoamKhadaItems(copy);
                            }}
                            className="w-20 text-xs border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            type="text"
                            value={fk.color || ''}
                            onChange={(e) => {
                              const copy = [...foamKhadaItems];
                              copy[idx].color = e.target.value;
                              setFoamKhadaItems(copy);
                            }}
                            className="w-24 text-xs border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-2 text-right">
                          <input
                            type="number"
                            step="0.001"
                            value={fk.consumption_per_pc || ''}
                            onChange={(e) => {
                              const copy = [...foamKhadaItems];
                              const cons = parseFloat(e.target.value) || 0;
                              copy[idx].consumption_per_pc = cons;
                              copy[idx].total_mtrs = Math.round(cons * (header.order_qty || 0) * 100) / 100;
                              setFoamKhadaItems(copy);
                            }}
                            className="w-20 text-xs text-right font-mono border border-slate-300 rounded px-1.5 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-2 text-right font-bold text-purple-900 font-mono">
                          <div className="flex items-center justify-end gap-1">
                            <input
                              type="number"
                              step="0.1"
                              value={fk.total_mtrs || ''}
                              onChange={(e) => {
                                const copy = [...foamKhadaItems];
                                copy[idx].total_mtrs = parseFloat(e.target.value) || 0;
                                setFoamKhadaItems(copy);
                              }}
                              className="w-24 text-xs text-right font-mono font-bold text-purple-900 border border-purple-300 rounded px-1.5 py-1 bg-purple-50/50"
                            />
                            <span className="text-[10px] text-purple-700 font-semibold">MTR</span>
                          </div>
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={fk.remarks || ''}
                            onChange={(e) => {
                              const copy = [...foamKhadaItems];
                              copy[idx].remarks = e.target.value;
                              setFoamKhadaItems(copy);
                            }}
                            className="w-full text-xs text-slate-600 border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-2 text-center">
                          <button
                            type="button"
                            onClick={() => setFoamKhadaItems((p) => p.filter((_, i) => i !== idx))}
                            className="p-1 text-slate-400 hover:text-red-600 rounded"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-purple-50/60 font-bold text-purple-900 border-t border-purple-200">
                      <td colSpan={5} className="py-2.5 px-3">TOTAL FOAM & KHADA ROLL INDENT (EXCLUDED FROM PIECE WT)</td>
                      <td className="py-2.5 px-2 text-right font-mono text-sm">
                        {fmtDecimal(foamKhadaItems.reduce((s, x) => s + (Number(x.total_mtrs) || 0), 0))} MTR
                      </td>
                      <td colSpan={2} className="py-2.5 px-3 text-right text-xs text-purple-700 font-medium">
                        Procured in Meters via Trims/Sourcing
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 5: BOM & SOURCING HAND-OFF */}
      {activeTab === 'OUTPUT' && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                <FileCheck size={16} className="text-emerald-600" />
                <span>Production Bill of Materials (BOM) & PO Hand-off</span>
              </h2>
              <p className="text-xs text-slate-500">
                Generated per-piece consumption approved and ready for purchase order creation
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
            <div className="p-4 bg-sky-50/50 rounded-xl border border-sky-200 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-sky-900 text-xs uppercase tracking-wider flex items-center gap-1">
                  <Layers size={14} className="text-sky-700" />
                  <span>Fabric Commitment & BOM Line</span>
                </h3>
                <span className="font-bold text-sky-800 text-sm">
                  {fmtDecimal(summaryKpis.grandFabric)} {summaryKpis.uom}
                </span>
              </div>
              <ul className="text-xs space-y-2 text-slate-700">
                <li className="flex justify-between border-b border-sky-100 pb-1">
                  <span>Per-Garment BOM Consumption:</span>
                  <span className="font-semibold text-slate-900">
                    {fmtDecimal(summaryKpis.avgGarmentCons, 5)} {summaryKpis.uom}/pc
                  </span>
                </li>
                <li className="flex justify-between border-b border-sky-100 pb-1">
                  <span>Net Garment Weight:</span>
                  <span className="font-semibold text-slate-900">
                    {fmtDecimal(summaryKpis.actGarmentCons, 5)} {summaryKpis.uom}/pc
                  </span>
                </li>
                <li className="flex justify-between border-b border-sky-100 pb-1">
                  <span>Avg / Pc incl. Collar, Foldings, Tapes & Cords:</span>
                  <span className="font-semibold text-slate-900">
                    {isWoven
                      ? `${fmtDecimal(summaryKpis.avgGarmentCons, 5)} MTR + ${fmtDecimal(summaryKpis.partsKgPerPc, 5)} KG/pc`
                      : `${fmtDecimal(summaryKpis.avgConsInclParts, 5)} KG/pc`}
                  </span>
                </li>
              </ul>
            </div>

            <div className="p-4 bg-amber-50/50 rounded-xl border border-amber-200 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-amber-900 text-xs uppercase tracking-wider flex items-center gap-1">
                  <Disc size={14} className="text-amber-700" />
                  <span>Yarn Indent / Spinning Conversion</span>
                </h3>
                <span className="font-bold text-amber-800 text-sm">
                  {!isWoven ? `${fmtDecimal(summaryKpis.grandFabric * 1.05)} KG` : 'Woven (N/A)'}
                </span>
              </div>
              <ul className="text-xs space-y-2 text-slate-700">
                <li className="flex justify-between border-b border-amber-100 pb-1">
                  <span>Estimated 50 KG Bags:</span>
                  <span className="font-semibold text-slate-900">
                    {!isWoven ? `${Math.ceil((summaryKpis.grandFabric * 1.05) / 50)} Bags` : '—'}
                  </span>
                </li>
                <li className="flex justify-between border-b border-amber-100 pb-1">
                  <span>Yarn Spinning / Knitting Allowance:</span>
                  <span className="font-semibold text-slate-900">+5.0%</span>
                </li>
                {summaryKpis.tapesKg > 0 && (
                  <li className="flex justify-between border-b border-amber-100 pb-1" title="Grey yarn to issue for knitting the twill tape / tube rope (tape metres ÷ m per kg)">
                    <span>Yarn for Tapes & Cords ({fmtDecimal(summaryKpis.totalTapesMtrs, 0)} MTRS):</span>
                    <span className="font-semibold text-slate-900">{fmtDecimal(summaryKpis.tapesKg, 2)} KG</span>
                  </li>
                )}
              </ul>
            </div>
          </div>

          {/* Purchase requirement for trims / specialized parts — tapes & cords bought by weight (KG) */}
          <div className="p-4 bg-white rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1">
                <Scissors size={14} className="text-indigo-600" />
                <span>Specialized Parts & Flat Knit — Purchase Requirement (KG)</span>
              </h3>
              <span className="font-bold text-indigo-900 text-sm">{fmtDecimal(summaryKpis.partsKg, 2)} KG</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                    <th className="py-2 px-3">Item</th>
                    <th className="py-2 px-3">Spec</th>
                    <th className="py-2 px-2">Colour</th>
                    <th className="py-2 px-2 text-right">Requirement</th>
                    <th className="py-2 px-2 text-right">Conversion</th>
                    <th className="py-2 px-3 text-right text-indigo-800">Purchase Qty</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {flatKnitSpec.enabled && (flatKnitSpec.components || []).map((c) => {
                    const pcs = flatKnitSpec.component_totals?.[c.key] || 0;
                    return (
                      <tr key={c.key}>
                        <td className="py-2 px-3 font-semibold text-slate-900">Flat Knit {c.label}</td>
                        <td className="py-2 px-3">{flatKnitSpec.item_type}</td>
                        <td className="py-2 px-2">{flatKnitSpec.color}</td>
                        <td className="py-2 px-2 text-right font-mono">{fmtNumber(pcs)} Nos</td>
                        <td className="py-2 px-2 text-right font-mono text-slate-500">{c.weight_g} g/pc</td>
                        <td className="py-2 px-3 text-right font-mono font-bold text-indigo-900">
                          {fmtDecimal((pcs * (Number(c.weight_g) || 0)) / 1000, 2)} KG
                        </td>
                      </tr>
                    );
                  })}
                  {specialParts.map((sp, idx) => {
                    const kg = specialPartKg(sp);
                    return (
                      <tr key={`sp_${idx}`}>
                        <td className="py-2 px-3 font-semibold text-slate-900">{sp.part_name}</td>
                        <td className="py-2 px-3">{sp.fabric_type} {sp.dia_spec ? `· ${sp.dia_spec}` : ''}</td>
                        <td className="py-2 px-2">{sp.color}</td>
                        <td className="py-2 px-2 text-right font-mono">{fmtDecimal(sp.total_qty, 1)} {sp.uom}</td>
                        <td className="py-2 px-2 text-right font-mono text-slate-500">
                          {isKgUom(sp.uom) ? '—' : partFactorText(sp) ?? 'set factor'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-bold text-indigo-900">
                          {kg != null ? `${fmtDecimal(kg, 2)} KG` : `${fmtDecimal(sp.total_qty, 1)} ${sp.uom}`}
                        </td>
                      </tr>
                    );
                  })}
                  {foamKhadaItems.map((fk, idx) => (
                    <tr key={`fk_${idx}`} className="bg-purple-50/20">
                      <td className="py-2 px-3 font-semibold text-purple-950 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
                        <span>{fk.item_name} (Foam/Khada)</span>
                      </td>
                      <td className="py-2 px-3">{fk.material_spec || '—'} {fk.width_in ? `(${fk.width_in}")` : ''}</td>
                      <td className="py-2 px-2">{fk.color || '—'}</td>
                      <td className="py-2 px-2 text-right font-mono">{fmtDecimal(fk.total_mtrs, 1)} MTR</td>
                      <td className="py-2 px-2 text-right font-mono text-purple-600">Trims / Roll</td>
                      <td className="py-2 px-3 text-right font-mono font-bold text-purple-900">
                        {fmtDecimal(fk.total_mtrs, 1)} MTR
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summaryKpis.partsMissingKgFactor > 0 && (
              <div className="text-[11px] text-red-600">
                {summaryKpis.partsMissingKgFactor} item(s) still purchased in their own unit — set the weight factor in Trims & Accessories to buy them in KG.
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 6: RATIO PATTI */}
      {activeTab === 'RATIO_PATTI' && (
        <RatioPattiTab
          markers={markers}
          forceWoven={isWoven}
          refData={(existingData?.ratio_patti_ref as RatioPattiRef) ?? EMPTY_RP_REF}
          header={{
            req_no: header.req_no,
            req_date: header.req_date,
            internal_ir_no: header.internal_ir_no,
            style_code: existingData?.style_code
              || (styles.data?.find((st: any) => String(st.id) === String(header.style_id))?.code as string)
              || '',
            style_name: existingData?.style_name
              || (styles.data?.find((st: any) => String(st.id) === String(header.style_id))?.label as string)
              || '',
            buyer_name: existingData?.buyer_name || '',
            order_qty: Number(header.order_qty) || 0,
            rejection_pct: Number(header.rejection_pct) || 0,
            fabric_allowance_pct: Number(header.fabric_allowance_pct) || 0,
          }}
        />
      )}

    </div>
  );
}

/* ==============================================================================
   RATIO PATTI (cutting-floor ratio sheet)
   ============================================================================== */

const EMPTY_RP_REF: RatioPattiRef = { marker_versions: [], lay_summary: [] };

interface RatioPattiRef {
  marker_versions?: { marker_no: string; version: number; size_consumption: Record<string, number> | null;
    cad_kg_per_pc: number | null; marker_kg_per_ply: number | null; uom: string; approved: boolean }[];
  lay_summary?: { marker_no: string; lays: number; plies: number; expected_pieces: number; actual_cut_qty: number }[];
}

interface RatioPattiHeader {
  req_no: string;
  req_date: string;
  internal_ir_no: string;
  style_code: string;
  style_name: string;
  buyer_name: string;
  order_qty: number;
  rejection_pct: number;
  fabric_allowance_pct: number;
}

interface RatioPattiSizeRow {
  size: string;
  ratio: number;
  pcsPerPly: number;
  orderQty: number;
  cutQty: number;
  pcsFromLays: number;
  netPerPc: number;       // g (knit) or cm (woven)
  grossPerPc: number;
  netQty: number;         // KG / MTR
  rejectionQty: number;
  allowanceQty: number;
  grossQty: number;
}

interface RatioPattiCalc {
  woven: boolean;
  unit: 'KG' | 'MTR';
  perPcUnit: 'g' | 'cm';
  layerMult: number;
  rows: RatioPattiSizeRow[];
  totals: Omit<RatioPattiSizeRow, 'size' | 'netPerPc' | 'grossPerPc'>;
  pcsPerLay: number;
  pliesRequired: number;
  pliesPlanned: number | null;
  laysPlanned: number | null;
  plies: number;
  pliesSource: 'LAY_PLAN' | 'CALCULATED';
  weightSource: 'SIZE_WISE' | 'MARKER_AVG';
  markerVersion: number | null;
  rejectionPct: number;
  allowancePct: number;
  layAllowanceCm: number;
  widthAllowanceIn: number;
  fabricPerLayQty: number;   // KG or MTR for one ply
  layFabricQty: number;      // plies × fabric per lay
  layEndAllowanceQty: number;
  widthAllowanceQty: number;
  warnings: string[];
}

const n0 = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function computeRatioPatti(m: CadMarker, hdr: RatioPattiHeader, forceWoven: boolean, ref: RatioPattiRef): RatioPattiCalc {
  const woven = forceWoven || m.uom === 'MTR';
  const unit: 'KG' | 'MTR' = woven ? 'MTR' : 'KG';
  const perPcUnit: 'g' | 'cm' = woven ? 'cm' : 'g';
  const div = woven ? 100 : 1000; // cm→m, g→kg
  const tube = !woven && m.fabric_dia_type === 'TUBE';
  const layerMult = tube ? 2 : 1;
  const gsm = n0(m.gsm);
  const rejectionPct = m.rejection_pct != null ? n0(m.rejection_pct) : n0(hdr.rejection_pct);
  const allowancePct = m.fabric_allowance_pct != null ? n0(m.fabric_allowance_pct) : n0(hdr.fabric_allowance_pct);
  const layAllowanceCm = n0(m.lay_allowance_cm);
  const widthAllowanceIn = n0(m.width_allowance_in);
  const warnings: string[] = [];

  const sizes: string[] = Array.isArray(m.sizes) ? m.sizes.map(String) : [];
  const ratios: number[] = (Array.isArray(m.ratios) ? m.ratios : []).map(n0);
  const colorways = Array.isArray(m.colorways) ? m.colorways : [];

  // Per size / colour order and cut quantities. Cut qty = order + rejection %,
  // exactly as the Markers tab computes it (reuse its figures when present).
  const orderBy: number[][] = colorways.map((cw) => sizes.map((_, si) => n0(cw.quantities?.[si])));
  const cutBy: number[][] = colorways.map((cw, ci) => sizes.map((_, si) => {
    const stored = cw.cut_quantities?.[si];
    return stored != null && stored !== ('' as any) ? n0(stored) : Math.ceil(orderBy[ci][si] * (1 + rejectionPct / 100));
  }));

  // Plies needed per colour = the size that needs the most plies decides the lay.
  let pliesRequired = 0;
  colorways.forEach((_, ci) => {
    let need = 0;
    sizes.forEach((sz, si) => {
      const perPly = ratios[si] * layerMult;
      const cut = cutBy[ci][si];
      if (cut > 0 && perPly <= 0) {
        const msg = `Size ${sz} has cut quantity but ratio 0 — it cannot be cut from this marker`;
        if (!warnings.includes(msg)) warnings.push(msg);
        return;
      }
      if (perPly > 0) need = Math.max(need, Math.ceil(cut / perPly));
    });
    pliesRequired += need;
  });

  const layRef = ref.lay_summary?.find((l) => l.marker_no === m.marker_ref);
  const pliesPlanned = layRef ? layRef.plies : null;
  const laysPlanned = layRef ? layRef.lays : null;
  const plies = pliesPlanned && pliesPlanned > 0 ? pliesPlanned : pliesRequired;
  const pliesSource: RatioPattiCalc['pliesSource'] = pliesPlanned && pliesPlanned > 0 ? 'LAY_PLAN' : 'CALCULATED';

  // Piece weight: marker average (lay weight ÷ pieces per lay). When a CAD
  // marker version carries size-wise consumption, that is used per size.
  const mv = ref.marker_versions?.find((v) => v.marker_no === m.marker_ref);
  const sizeCons = !woven && mv?.size_consumption ? mv.size_consumption : null;
  const markerAvgNet = woven
    ? (n0(m.act_length_per_pc_cm) || (n0(m.req_length_per_pc_cm) / (1 + allowancePct / 100)))
    : (n0(m.act_wt_per_pc_g) || (n0(m.avg_wt_per_pc_g) / (1 + allowancePct / 100)));
  let usedSizeWise = false;

  const rows: RatioPattiSizeRow[] = sizes.map((sz, si) => {
    const ratio = ratios[si] || 0;
    const pcsPerPly = ratio * layerMult;
    const orderQty = orderBy.reduce((s, r) => s + r[si], 0);
    const cutQty = cutBy.reduce((s, r) => s + r[si], 0);
    let netPerPc = markerAvgNet;
    if (sizeCons && sizeCons[sz] != null) {
      netPerPc = n0(sizeCons[sz]) * 1000; // KG/pc → g/pc
      usedSizeWise = true;
    }
    const grossPerPc = netPerPc * (1 + allowancePct / 100);
    const netQty = (orderQty * netPerPc) / div;
    const rejectionQty = ((cutQty - orderQty) * netPerPc) / div;
    const allowanceQty = (cutQty * (grossPerPc - netPerPc)) / div;
    return {
      size: sz,
      ratio,
      pcsPerPly,
      orderQty,
      cutQty,
      pcsFromLays: plies * pcsPerPly,
      netPerPc,
      grossPerPc,
      netQty,
      rejectionQty,
      allowanceQty,
      grossQty: netQty + rejectionQty + allowanceQty,
    };
  });

  const totals = rows.reduce(
    (t, r) => ({
      ratio: t.ratio + r.ratio,
      pcsPerPly: t.pcsPerPly + r.pcsPerPly,
      orderQty: t.orderQty + r.orderQty,
      cutQty: t.cutQty + r.cutQty,
      pcsFromLays: t.pcsFromLays + r.pcsFromLays,
      netQty: t.netQty + r.netQty,
      rejectionQty: t.rejectionQty + r.rejectionQty,
      allowanceQty: t.allowanceQty + r.allowanceQty,
      grossQty: t.grossQty + r.grossQty,
    }),
    { ratio: 0, pcsPerPly: 0, orderQty: 0, cutQty: 0, pcsFromLays: 0, netQty: 0, rejectionQty: 0, allowanceQty: 0, grossQty: 0 },
  );

  // Lay-level figures. The lay-end and width allowances are already inside
  // the lay length / table width and therefore inside the piece weight — they
  // are broken out here so the cutting floor can see where the fabric goes.
  const layLenCm = n0(m.lay_length_cm) || (n0(m.length_mm) / 10 + layAllowanceCm);
  const tblWidthIn = n0(m.table_width_in) || (n0(m.width_mm) / 25.4 + widthAllowanceIn);
  let fabricPerLayQty: number;
  let layEndPerPly: number;
  let widthPerPly: number;
  if (woven) {
    fabricPerLayQty = layLenCm / 100;
    layEndPerPly = layAllowanceCm / 100;
    widthPerPly = 0;
  } else {
    fabricPerLayQty = n0(m.fabric_wt_per_lay_g) / 1000
      || (layLenCm * tblWidthIn * 2.54 * gsm / 10000 * layerMult) / 1000;
    layEndPerPly = (layAllowanceCm * tblWidthIn * 2.54 * gsm / 10000 * layerMult) / 1000;
    widthPerPly = ((layLenCm - layAllowanceCm) * widthAllowanceIn * 2.54 * gsm / 10000 * layerMult) / 1000;
  }

  const extraPcs = totals.pcsFromLays - totals.cutQty;
  if (totals.cutQty > 0 && extraPcs > totals.cutQty * 0.05) {
    warnings.push(
      `Ratio does not follow the order size mix — ${fmtNumber(plies)} plies give ${fmtNumber(extraPcs)} pcs more than the cut quantity `
      + `(${fmtNumber(plies * fabricPerLayQty, 0)} ${unit} laid vs ${fmtNumber(totals.grossQty, 0)} ${unit} gross requirement)`,
    );
  }
  if (!sizes.length) warnings.push('No sizes / ratios on this marker — set them in the Markers Cockpit tab');
  if (!colorways.length) warnings.push('No colour-wise order quantities on this marker — plies and fabric cannot be calculated');
  if (!markerAvgNet && !usedSizeWise) warnings.push('Piece weight is 0 — run "Calculate" on the Markers tab');

  return {
    woven, unit, perPcUnit, layerMult, rows, totals,
    pcsPerLay: totals.pcsPerPly,
    pliesRequired, pliesPlanned, laysPlanned, plies, pliesSource,
    weightSource: usedSizeWise ? 'SIZE_WISE' : 'MARKER_AVG',
    markerVersion: mv?.version ?? null,
    rejectionPct, allowancePct, layAllowanceCm, widthAllowanceIn,
    fabricPerLayQty,
    layFabricQty: plies * fabricPerLayQty,
    layEndAllowanceQty: plies * layEndPerPly,
    widthAllowanceQty: plies * widthPerPly,
    warnings,
  };
}

const q3 = (v: number) => fmtDecimal(v, 3);

function RatioPattiMarkerSheet({ m, idx, calc, print }: {
  m: CadMarker; idx: number; calc: RatioPattiCalc; print?: boolean;
}) {
  const u = calc.unit;
  const pu = calc.perPcUnit;
  const dia = m.dia_val || (m.dia_in ? `${m.dia_in}"` : m.table_width_in ? `${fmtDecimal(m.table_width_in, 1)}"` : '—');
  const th = 'py-2 px-2 border border-slate-300 text-[11px] font-semibold text-slate-700 bg-slate-100';
  const td = 'py-1.5 px-2 border border-slate-200 text-[11.5px] tabular-nums';

  return (
    <div className={`rp-marker bg-white ${print ? 'border border-slate-400 mb-4' : 'rounded-xl border border-slate-200/80 shadow-sm overflow-hidden'}`}>
      {/* Marker header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-indigo-50 border-b border-indigo-100">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center min-w-8 h-8 px-1.5 rounded-lg bg-indigo-600 text-white text-xs font-bold">
            {m.marker_ref || `M${idx + 1}`}
          </span>
          <div>
            <div className="text-sm font-bold text-indigo-900">{m.marker_name || `Marker ${m.marker_ref || idx + 1}`}</div>
            <div className="text-[11px] text-indigo-700">
              {m.fabric_type || 'Fabric'} · {m.gsm ? `${m.gsm} GSM` : 'GSM —'} · Dia {dia} {m.fabric_dia_type || ''}
              {m.parts_in_lay ? ` · Parts: ${m.parts_in_lay}` : ''}
            </div>
          </div>
        </div>
        <div className="flex gap-4 text-right">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Pcs / Ply</div>
            <div className="text-base font-bold text-indigo-800">{fmtNumber(calc.pcsPerLay)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              Plies {calc.pliesSource === 'LAY_PLAN' ? '(lay plan)' : '(required)'}
            </div>
            <div className="text-base font-bold text-indigo-800">{fmtNumber(calc.plies)}</div>
          </div>
        </div>
      </div>

      {/* Marker parameters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-px bg-slate-200 text-[11px]">
        {[
          ['Marker Length', m.length_mm ? `${fmtNumber(m.length_mm)} mm` : '—'],
          ['Marker Width', m.width_mm ? `${fmtNumber(m.width_mm)} mm` : '—'],
          ['Lay Length', m.lay_length_cm ? `${fmtDecimal(m.lay_length_cm, 1)} cm` : '—'],
          ['Table Width', m.table_width_in ? `${fmtDecimal(m.table_width_in, 2)}"` : '—'],
          ['Dia / GSM', `${dia} / ${m.gsm || '—'}`],
          [calc.woven ? 'Fabric / Ply' : 'Fabric Wt / Lay', `${q3(calc.fabricPerLayQty)} ${u}`],
          ['Pcs / Lay', fmtNumber(calc.pcsPerLay)],
          ['Direction', m.direction || '—'],
        ].map(([k, v]) => (
          <div key={k} className="bg-white px-2.5 py-1.5">
            <div className="text-[10px] text-slate-500">{k}</div>
            <div className="font-semibold text-slate-800">{v}</div>
          </div>
        ))}
      </div>

      {/* Size-wise ratio sheet */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={`${th} text-left`}>Size</th>
              <th className={`${th} text-center`}>Ratio</th>
              <th className={`${th} text-center`}>Pcs / Ply</th>
              <th className={`${th} text-right`}>Order Pcs</th>
              <th className={`${th} text-right`}>Cut Pcs (+{fmtDecimal(calc.rejectionPct, 1)}%)</th>
              <th className={`${th} text-right`}>Pcs from {fmtNumber(calc.plies)} Plies</th>
              <th className={`${th} text-right`}>
                Net {calc.woven ? 'Length' : 'Wt'} / Pc ({pu})
                <div className="font-normal text-[9.5px] text-slate-500">
                  {calc.weightSource === 'SIZE_WISE' ? `CAD size-wise (v${calc.markerVersion})` : 'Marker average'}
                </div>
              </th>
              <th className={`${th} text-right`}>Gross / Pc ({pu})<div className="font-normal text-[9.5px] text-slate-500">+{fmtDecimal(calc.allowancePct, 1)}% allowance</div></th>
              <th className={`${th} text-right`}>Net Fabric ({u})</th>
              <th className={`${th} text-right`}>Rejection Wastage ({u})</th>
              <th className={`${th} text-right`}>Allowance Wastage ({u})</th>
              <th className={`${th} text-right`}>Gross Req. ({u})</th>
            </tr>
          </thead>
          <tbody>
            {calc.rows.length ? calc.rows.map((r) => (
              <tr key={r.size}>
                <td className={`${td} font-semibold text-slate-800`}>{r.size}</td>
                <td className={`${td} text-center font-bold text-indigo-700`}>{r.ratio}</td>
                <td className={`${td} text-center`}>{fmtNumber(r.pcsPerPly)}</td>
                <td className={`${td} text-right`}>{fmtNumber(r.orderQty)}</td>
                <td className={`${td} text-right font-medium`}>{fmtNumber(r.cutQty)}</td>
                <td className={`${td} text-right ${r.pcsFromLays < r.cutQty ? 'text-red-600 font-semibold' : ''}`}>{fmtNumber(r.pcsFromLays)}</td>
                <td className={`${td} text-right`}>{fmtDecimal(r.netPerPc, 2)}</td>
                <td className={`${td} text-right`}>{fmtDecimal(r.grossPerPc, 2)}</td>
                <td className={`${td} text-right`}>{q3(r.netQty)}</td>
                <td className={`${td} text-right text-amber-700`}>{q3(r.rejectionQty)}</td>
                <td className={`${td} text-right text-amber-700`}>{q3(r.allowanceQty)}</td>
                <td className={`${td} text-right font-bold text-emerald-700`}>{q3(r.grossQty)}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan={12} className="py-4 text-center text-slate-400 text-[11px] border border-slate-200">
                  No size ratios defined — set ratios in the Markers Cockpit tab
                </td>
              </tr>
            )}
          </tbody>
          {calc.rows.length > 0 && (
            <tfoot>
              <tr className="bg-indigo-50 font-bold text-slate-900">
                <td className={td}>TOTAL</td>
                <td className={`${td} text-center text-indigo-700`}>{calc.totals.ratio}</td>
                <td className={`${td} text-center`}>{fmtNumber(calc.totals.pcsPerPly)}</td>
                <td className={`${td} text-right`}>{fmtNumber(calc.totals.orderQty)}</td>
                <td className={`${td} text-right`}>{fmtNumber(calc.totals.cutQty)}</td>
                <td className={`${td} text-right`}>{fmtNumber(calc.totals.pcsFromLays)}</td>
                <td className={`${td} text-right text-slate-500 font-normal`}>
                  {calc.totals.cutQty ? fmtDecimal((calc.totals.netQty + calc.totals.rejectionQty) * (calc.woven ? 100 : 1000) / calc.totals.cutQty, 2) : '—'}
                  <div className="text-[9px]">wtd. avg</div>
                </td>
                <td className={`${td} text-right text-slate-500 font-normal`}>
                  {calc.totals.cutQty ? fmtDecimal(calc.totals.grossQty * (calc.woven ? 100 : 1000) / calc.totals.cutQty, 2) : '—'}
                  <div className="text-[9px]">wtd. avg</div>
                </td>
                <td className={`${td} text-right`}>{q3(calc.totals.netQty)}</td>
                <td className={`${td} text-right text-amber-800`}>{q3(calc.totals.rejectionQty)}</td>
                <td className={`${td} text-right text-amber-800`}>{q3(calc.totals.allowanceQty)}</td>
                <td className={`${td} text-right text-emerald-800`}>{q3(calc.totals.grossQty)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Wastage summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 px-4 py-3 bg-slate-50 border-t border-slate-200 text-[11px] text-slate-700">
        <div className="space-y-0.5">
          <div className="font-semibold text-slate-800 mb-1">Wastage allowances</div>
          <div>Rejection: <strong>{fmtDecimal(calc.rejectionPct, 2)}%</strong> → {q3(calc.totals.rejectionQty)} {u}</div>
          <div>Fabric allowance: <strong>{fmtDecimal(calc.allowancePct, 2)}%</strong> → {q3(calc.totals.allowanceQty)} {u}</div>
          <div className="font-semibold">Total wastage: {q3(calc.totals.rejectionQty + calc.totals.allowanceQty)} {u}
            {calc.totals.grossQty > 0 && <> ({fmtDecimal(((calc.totals.rejectionQty + calc.totals.allowanceQty) / calc.totals.grossQty) * 100, 2)}% of gross)</>}
          </div>
        </div>
        <div className="space-y-0.5">
          <div className="font-semibold text-slate-800 mb-1">Lay allowances (inside piece {calc.woven ? 'length' : 'weight'})</div>
          <div>Lay-end allowance: <strong>{fmtDecimal(calc.layAllowanceCm, 1)} cm</strong> / ply → {q3(calc.layEndAllowanceQty)} {u}</div>
          <div>Width allowance: <strong>{fmtDecimal(calc.widthAllowanceIn, 2)}"</strong>
            {calc.woven ? ' (not applicable to metre consumption)' : <> → {q3(calc.widthAllowanceQty)} {u}</>}
          </div>
          <div>Fabric for {fmtNumber(calc.plies)} plies × {q3(calc.fabricPerLayQty)} {u}: <strong>{q3(calc.layFabricQty)} {u}</strong></div>
        </div>
        <div className="space-y-0.5">
          <div className="font-semibold text-slate-800 mb-1">Plies</div>
          <div>Required for cut qty: <strong>{fmtNumber(calc.pliesRequired)}</strong></div>
          <div>Lay plans: {calc.pliesPlanned != null ? <><strong>{fmtNumber(calc.pliesPlanned)}</strong> plies in {calc.laysPlanned} lay(s)</> : <span className="text-slate-400">none yet</span>}</div>
          <div className="text-emerald-800 font-semibold">Gross requirement: {q3(calc.totals.grossQty)} {u}</div>
        </div>
      </div>

      {calc.warnings.length > 0 && (
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-[11px] text-amber-800 space-y-0.5">
          {calc.warnings.map((w) => <div key={w}>⚠ {w}</div>)}
        </div>
      )}
    </div>
  );
}

const RP_PRINT_CSS = `
.rp-print-root { display: none; }
@media print {
  body.rp-printing > *:not(.rp-print-root) { display: none !important; }
  body.rp-printing > .rp-print-root { display: block !important; }
  body.rp-printing { background: #fff !important; }
  .rp-print-root { font-size: 11px; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .rp-print-root .rp-marker { break-inside: avoid; page-break-inside: avoid; }
  .rp-print-root table { width: 100%; }
  @page { size: A4 landscape; margin: 10mm; }
}
`;

function RatioPattiTab({ markers, header, forceWoven, refData }: {
  markers: CadMarker[]; header: RatioPattiHeader; forceWoven: boolean; refData: RatioPattiRef;
}) {
  const calcs = useMemo(
    () => markers.map((m) => computeRatioPatti(m, header, forceWoven, refData)),
    [markers, header, forceWoven, refData],
  );

  const grand = calcs.reduce(
    (t, c) => {
      const k = c.unit;
      t[k] = t[k] ?? { net: 0, rej: 0, allow: 0, gross: 0 };
      t[k].net += c.totals.netQty; t[k].rej += c.totals.rejectionQty;
      t[k].allow += c.totals.allowanceQty; t[k].gross += c.totals.grossQty;
      return t;
    },
    {} as Record<string, { net: number; rej: number; allow: number; gross: number }>,
  );

  const doPrint = () => {
    document.body.classList.add('rp-printing');
    const done = () => {
      document.body.classList.remove('rp-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    // Give React a frame to flush the portal before the print dialog snapshots.
    requestAnimationFrame(() => {
      window.print();
      setTimeout(done, 500);
    });
  };

  const headerBlock = (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-[12px]">
      <div><span className="text-slate-500">CAD No:</span> <strong>{header.req_no || 'Unsaved'}</strong></div>
      <div><span className="text-slate-500">Date:</span> <strong>{header.req_date ? fmtDate(header.req_date) : '—'}</strong></div>
      <div><span className="text-slate-500">IO No:</span> <strong>{header.internal_ir_no || '—'}</strong></div>
      <div><span className="text-slate-500">Order Qty:</span> <strong>{fmtNumber(header.order_qty)} pcs</strong></div>
      <div className="col-span-2"><span className="text-slate-500">Style:</span> <strong>{header.style_code || '—'}</strong>{header.style_name ? ` — ${header.style_name}` : ''}</div>
      <div className="col-span-2"><span className="text-slate-500">Buyer:</span> <strong>{header.buyer_name || '—'}</strong></div>
    </div>
  );

  const grandBlock = Object.entries(grand).map(([unit, g]) => (
    <div key={unit} className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
      <span>All markers ({unit}) —</span>
      <span>Net: <strong>{q3(g.net)}</strong></span>
      <span>Rejection: <strong>{q3(g.rej)}</strong></span>
      <span>Allowance: <strong>{q3(g.allow)}</strong></span>
      <span className="text-emerald-800">Gross requirement: <strong>{q3(g.gross)} {unit}</strong></span>
    </div>
  ));

  const signatures = (
    <div className="grid grid-cols-3 gap-10 pt-12 text-[12px] text-center">
      {['Prepared by (CAD)', 'Cutting Supervisor', 'Checked / Approved'].map((s) => (
        <div key={s}><div className="border-t border-slate-500 pt-1">{s}</div></div>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <style>{RP_PRINT_CSS}</style>

      {/* On-screen header bar */}
      <div className="flex flex-wrap items-start justify-between gap-3 bg-white rounded-xl border border-slate-200/80 shadow-sm p-4">
        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Ratio Patti — Cutting Floor Ratio Sheet</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Size ratio, plies, pieces, piece weight and wastage per marker. Figures follow the last
              "Calculate" on the Markers tab{header.req_no ? '' : ' — save the CAD sheet to get a CAD No on the print'}.
            </p>
          </div>
          {headerBlock}
        </div>
        <button
          onClick={doPrint}
          disabled={!markers.length}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow transition disabled:opacity-50"
        >
          <Printer size={14} />
          <span>Print Ratio Patti</span>
        </button>
      </div>

      {markers.map((m, idx) => (
        <RatioPattiMarkerSheet key={m._key || idx} m={m} idx={idx} calc={calcs[idx]} />
      ))}

      {markers.length > 1 && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm px-4 py-3 space-y-1">{grandBlock}</div>
      )}

      {markers.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400">
          <Scissors size={32} className="mx-auto text-slate-300 mb-2" />
          <p className="text-sm font-medium text-slate-600">No markers defined yet</p>
          <p className="text-xs mt-1">Add markers in the Markers Cockpit tab, then return here to view the Ratio Patti.</p>
        </div>
      )}

      {/* Print-only copy, rendered outside the app shell so nothing else prints */}
      {markers.length > 0 && createPortal(
        <div className="rp-print-root">
          <div className="border-b-2 border-black pb-2 mb-3">
            <div className="flex items-baseline justify-between">
              <h1 className="text-lg font-bold">RATIO PATTI — CUTTING RATIO SHEET</h1>
              <span className="text-[11px]">Printed {new Date().toLocaleString('en-GB')}</span>
            </div>
            <div className="mt-1.5">{headerBlock}</div>
          </div>
          {markers.map((m, idx) => (
            <RatioPattiMarkerSheet key={m._key || idx} m={m} idx={idx} calc={calcs[idx]} print />
          ))}
          {markers.length > 1 && <div className="border border-slate-400 px-3 py-2 space-y-1">{grandBlock}</div>}
          {signatures}
        </div>,
        document.body,
      )}
    </div>
  );
}
