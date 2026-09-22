import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Save, Sparkles, CheckCircle2, Plus, Trash2, Cpu,
  Layers, Scissors, Disc, FileCheck,
  UploadCloud, Copy, Printer, FileSpreadsheet
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, Badge } from '../../components/ui';
import { fmtDecimal, fmtNumber, today } from '../../lib/format';

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

export interface CollarDimensionRow {
  size: string;
  collar_dimension: string;
  collar_pcs: number;
  cuff_dimension?: string;
  cuff_pcs?: number;
}

export interface FlatKnitSpec {
  enabled: boolean;
  item_type: string;
  color: string;
  gsm: number;
  weight_per_set_g: number;
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
  remarks: string;
}

export default function CadRequirementDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const styles = useLookup('styles');

  const [activeTab, setActiveTab] = useState<'MARKERS' | 'F_PRGM' | 'CUT' | 'TRIMS' | 'OUTPUT'>('MARKERS');
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
    internal_ir_no: 'IR-2026-0001',
    order_qty: 4900,
    cad_type: 'KNIT_SJ' as 'KNIT_SJ' | 'KNIT_FLEECE' | 'WOVEN' | 'MULTI_PART',
    uom: 'KG' as 'KG' | 'MTR',
    rejection_pct: 3.0,
    fabric_allowance_pct: 10.0,
    special_notes: '',
    status: 'DRAFT',
    remarks: '',
  });

  // Markers State (initialized with standard Single Jersey setup matching sample 1)
  const [markers, setMarkers] = useState<CadMarker[]>([
    {
      _key: 'm_1A',
      marker_ref: '1A',
      marker_name: 'FS 26227A 1A',
      length_mm: 3982,
      width_mm: 1473,
      fabric_dia_type: 'OPEN',
      fabric_type: '100% ORGANIC COTTON SINGLE JERSEY',
      gsm: 160,
      direction: 'ONEWAY',
      parts_in_lay: 'BCK, FRT, SLV',
      lay_allowance_cm: 10,
      width_allowance_in: 2,
      lay_length_cm: 408.2,
      table_width_in: 60.0,
      fabric_wt_per_lay_g: 995.22,
      no_of_pcs_lay: 10,
      avg_wt_per_pc_g: 109.47,
      req_length_per_pc_cm: 0,
      total_req_qty: 552.63,
      uom: 'KG',
      sizes: ['98', '104', '110'],
      ratios: [2, 2, 6],
      colorways: [
        {
          color_name: 'SEA SALT / SCARLET SAGE',
          quantities: [1250, 1300, 2350],
          cut_quantities: [1288, 1339, 2421],
          total_order_pcs: 4900,
          total_cut_pcs: 5048,
          required_qty: 552.63,
        },
      ],
    },
    {
      _key: 'm_2A',
      marker_ref: '2A',
      marker_name: 'FS 26227A 2A',
      length_mm: 479,
      width_mm: 610,
      fabric_dia_type: 'TUBE',
      fabric_type: '1*1 LYCRA RIB',
      gsm: 240,
      direction: 'ONEWAY',
      parts_in_lay: 'N/RIB',
      lay_allowance_cm: 10,
      width_allowance_in: 1,
      lay_length_cm: 57.9,
      table_width_in: 25.0,
      fabric_wt_per_lay_g: 44.12,
      no_of_pcs_lay: 15,
      avg_wt_per_pc_g: 6.59,
      req_length_per_pc_cm: 0,
      total_req_qty: 33.28,
      uom: 'KG',
      sizes: ['98', '104', '110'],
      ratios: [3, 4, 8],
      colorways: [
        {
          color_name: 'SCARLET SAGE (19-1559 TCX)',
          quantities: [1250, 1300, 2350],
          cut_quantities: [1288, 1339, 2421],
          total_order_pcs: 4900,
          total_cut_pcs: 5048,
          required_qty: 33.28,
        },
      ],
    },
  ]);

  // Consolidated Fabric Program & Cutting Lay
  const [fabricProgram, setFabricProgram] = useState<FabricProgramRow[]>([]);
  const [cuttingLay, setCuttingLay] = useState<FabricProgramRow[]>([]);

  // Trims & Special Parts (Draw cords, twill tapes, collars, zip foldings)
  const [trims, setTrims] = useState<TrimItem[]>([
    { item_name: 'Flat Knit Collar & Cuff Set', consumption_per_pc: 0.184, uom: 'KG/SET', total_qty: 901.6, remarks: 'Mens: 0.040+0.052+0.092=0.184 GRM' },
    { item_name: '10mm Twill Tape', consumption_per_pc: 0.60, uom: 'MTRS/PC', total_qty: 2940, remarks: '60 CM per piece' },
    { item_name: '15mm Tube Draw Cord', consumption_per_pc: 1.10, uom: 'MTRS/PC', total_qty: 5390, remarks: '110 CM per piece (or ~6 KG)' },
    { item_name: 'Zip Folding', consumption_per_pc: 0.007, uom: 'GRM/PC', total_qty: 34.3, remarks: '100% CTN S/J 160 GSM' },
  ]);

  // Flat Knit Collar & Cuff Specification (Size-wise breakdown matrix matching ESTOVIR & NOTRE tech packs)
  const [flatKnitSpec, setFlatKnitSpec] = useState<FlatKnitSpec>({
    enabled: true,
    item_type: '95% COTTON 5% ELASTANE 2X2 FLATKNIT',
    color: 'NAVY',
    gsm: 500,
    weight_per_set_g: 184, // 0.184 kg / set (Mens: 0.040 + 0.052 + 0.092 = 0.184)
    size_rows: [
      { size: '8A', collar_dimension: '14.75" X 5"', collar_pcs: 46, cuff_dimension: '15.75" X 6.50"', cuff_pcs: 98 },
      { size: '10A', collar_dimension: '15.25" X 5.50"', collar_pcs: 52, cuff_dimension: '15.75" X 6.50"', cuff_pcs: 0 },
      { size: '12A', collar_dimension: '15.75" X 5.50"', collar_pcs: 161, cuff_dimension: '16.75" X 6.50"', cuff_pcs: 161 },
      { size: '14A', collar_dimension: '16.00" X 5.75"', collar_pcs: 187, cuff_dimension: '16.75" X 6.75"', cuff_pcs: 187 },
      { size: 'S', collar_dimension: '16.75" X 5.875"', collar_pcs: 89, cuff_dimension: '17.00" X 6.75"', cuff_pcs: 89 },
      { size: 'M', collar_dimension: '17.25" X 5.875"', collar_pcs: 14, cuff_dimension: '17.75" X 7.25"', cuff_pcs: 14 },
      { size: 'XL', collar_dimension: '18.25" X 5.875"', collar_pcs: 8, cuff_dimension: '18.25" X 7.25"', cuff_pcs: 0 },
    ],
    total_collar_pcs: 557,
    total_cuff_pcs: 549,
    total_yarn_kg: 102.5,
    remarks: 'Mens: 0.040+0.052+0.092 = 0.184 GRM | 500 GSM Flatknit',
  });

  // Specialized Parts, Foldings & Tapes (Zip Foldings, Twill Tape, Draw Cords, BNT)
  const [specialParts, setSpecialParts] = useState<SpecialPartRow[]>([
    {
      part_name: 'Zip Folding',
      fabric_type: '100% Cotton Single Jersey',
      gsm: 160,
      dia_spec: 'DIA-ANY (TUBE)',
      color: 'NAVY',
      consumption_per_pc: 0.007,
      uom: 'KG',
      total_qty: 6.0,
      remarks: 'Zip Folding - 0.007 Gram - 100% CTN S/J - 160 GSM',
    },
    {
      part_name: '10mm Twill Tape',
      fabric_type: 'Cotton Twill Tape',
      gsm: 0,
      dia_spec: '10MM',
      color: 'NAVY',
      consumption_per_pc: 0.60,
      uom: 'MTRS',
      total_qty: 380,
      remarks: '10MM Twill Tape - 60 CM per pcs',
    },
    {
      part_name: '15mm Tube Rope / Draw Cord',
      fabric_type: 'Cotton / Poly Tube Rope',
      gsm: 0,
      dia_spec: '15MM',
      color: 'NAVY',
      consumption_per_pc: 1.10,
      uom: 'MTRS',
      total_qty: 290,
      remarks: '15MM Draw Cord - 110 CM per pcs (or ~6 KG)',
    },
    {
      part_name: 'Back Neck Tape (BNT)',
      fabric_type: '100% Cotton Single Jersey',
      gsm: 160,
      dia_spec: '12MM FOLD',
      color: 'NAVY',
      consumption_per_pc: 0.003,
      uom: 'KG',
      total_qty: 1.5,
      remarks: 'BNT - 0.003 GRM (S/J)',
    },
  ]);

  const recalculateFlatKnit = (spec: FlatKnitSpec): FlatKnitSpec => {
    const totCollar = spec.size_rows.reduce((s, r) => s + (Number(r.collar_pcs) || 0), 0);
    const totCuff = spec.size_rows.reduce((s, r) => s + (Number(r.cuff_pcs) || 0), 0);
    const wtKg = spec.weight_per_set_g > 1 ? spec.weight_per_set_g / 1000.0 : spec.weight_per_set_g;
    const yarnKg = Math.round(totCollar * wtKg * 100) / 100;
    return {
      ...spec,
      total_collar_pcs: totCollar,
      total_cuff_pcs: totCuff,
      total_yarn_kg: yarnKg,
    };
  };

  const syncSizesFromMarkers = () => {
    if (!markers.length) {
      toast('No markers found to sync sizes from', 'warning');
      return;
    }
    const sizeMap: Record<string, { order: number; cut: number }> = {};
    markers.forEach((m) => {
      (m.sizes || []).forEach((sz, sIdx) => {
        if (!sz) return;
        if (!sizeMap[sz]) sizeMap[sz] = { order: 0, cut: 0 };
        (m.colorways || []).forEach((cw) => {
          sizeMap[sz].order += Number(cw.quantities?.[sIdx]) || 0;
          sizeMap[sz].cut += Number(cw.cut_quantities?.[sIdx]) || Number(cw.quantities?.[sIdx]) || 0;
        });
      });
    });

    const existingRowMap = new Map(flatKnitSpec.size_rows.map((r) => [r.size, r]));
    const newRows: CollarDimensionRow[] = Object.entries(sizeMap).map(([sz, counts]) => {
      const existing = existingRowMap.get(sz);
      return {
        size: sz,
        collar_dimension: existing?.collar_dimension || `${sz} Collar`,
        collar_pcs: counts.cut || counts.order || 0,
        cuff_dimension: existing?.cuff_dimension || `${sz} Cuff`,
        cuff_pcs: counts.cut || counts.order || 0,
      };
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
        rejection_pct: Number(existingData.rejection_pct ?? 3.0),
        fabric_allowance_pct: Number(existingData.fabric_allowance_pct ?? 10.0),
        special_notes: existingData.special_notes || '',
        status: existingData.status || 'DRAFT',
        remarks: existingData.remarks || '',
      });

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
            dia_in: m.dia_in != null ? Number(m.dia_in) : (m.table_width_in ? Math.round(Number(m.table_width_in)) : undefined),
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
        setFlatKnitSpec(existingData.flat_knit_spec);
      } else if (existingData.dataJson?.flat_knit_spec) {
        setFlatKnitSpec(existingData.dataJson.flat_knit_spec);
      }

      if (existingData.special_parts?.length) {
        setSpecialParts(existingData.special_parts);
      } else if (existingData.dataJson?.special_parts?.length) {
        setSpecialParts(existingData.dataJson.special_parts);
      }

      if (existingData.trims?.length) {
        setTrims(existingData.trims);
      } else if (existingData.dataJson?.trims?.length) {
        setTrims(existingData.dataJson.trims);
      }
    }
  }, [existingData, isNew]);

  // Active Marker shortcut
  const activeMarker = markers[activeMarkerIdx] || markers[0];

  // Mathematical Engine (Pure Reactive Client-side Calculation)
  const isWoven = header.cad_type === 'WOVEN' || header.uom === 'MTR';
  const totalAllowancePct = header.rejection_pct + header.fabric_allowance_pct;

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
        const markerRejectionPct = m.rejection_pct != null ? Number(m.rejection_pct) : Number(header.rejection_pct ?? 3.0);
        const markerFabAllowancePct = m.fabric_allowance_pct != null ? Number(m.fabric_allowance_pct) : Number(header.fabric_allowance_pct ?? 10.0);

        // Lay length in cm: (Length mm / 10) + allowance
        const layLenCm = Math.round(((lengthMm / 10.0) + layAllowance) * 10) / 10;
        // Table width in inches: (Width mm / 25.4) + allowance
        const tblWidthIn = Math.round(((widthMm / 25.4) + widthAllowance) * 100) / 100;
        const diaIn = m.dia_in != null && m.dia_in > 0 ? Number(m.dia_in) : Math.round(tblWidthIn);
        const diaVal = `${diaIn}"`;
        const diaSpec = `${diaVal} ${diaType}`;

        const sumRatios = m.ratios.reduce((a, b) => a + (Number(b) || 0), 0);

        let fabricWtLay = 0;
        let pcsLay = 1;
        let actWtPc = 0;
        let avgWtPc = 0;
        let actLenPc = 0;
        let reqLenPc = 0;

        if (!isWoven) {
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
          if (!isWoven) {
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

        const markerUom = isWoven ? 'MTR' : (m.uom || 'KG');
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
        const diaV = m.dia_val || (m.dia_in ? `${m.dia_in}"` : `${Math.round(m.table_width_in || 0)}"`);
        const diaT = m.fabric_dia_type === 'TUBE' ? 'TUBE' : 'OPEN';
        const key = `${m.fabric_type || 'Main Fabric'}_${m.gsm || 0}_${diaV}_${diaT}`;
        if (!fabMap[key]) {
          fabMap[key] = {
            fabric_type: m.fabric_type || 'Main Fabric',
            gsm: m.gsm || 160,
            dia_val: diaV,
            dia_type: diaT,
            dia_spec: `${diaV} ${diaT}`,
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
          const net = Math.round(d.net_qty * 10) / 10;
          const roundedNet = Math.ceil(net);
          const buffer = Math.max(1, Math.round(roundedNet * 0.02));
          const grand = roundedNet + buffer;

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
            grand_total_qty: grand,
            uom: isWoven ? 'MTR' : 'KG',
          });

          cutLines.push({
            fabric_type: fab.fabric_type,
            gsm: fab.gsm,
            dia_val: fab.dia_val,
            dia_type: fab.dia_type,
            dia_spec: fab.dia_spec,
            color_name: cName,
            order_qty_pcs: d.cut_pcs,
            net_qty: net,
            buffer_qty: 0,
            grand_total_qty: net,
            uom: isWoven ? 'MTR' : 'KG',
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

  // Grand KPI Metrics
  const summaryKpis = useMemo(() => {
    const totalOrderPcs = markers.reduce(
      (sum, m) => sum + (m.colorways?.[0]?.total_order_pcs || 0),
      0
    ) || header.order_qty;

    const grandFabric = fabricProgram.length > 0
      ? fabricProgram.reduce((sum, f) => sum + Number(f.grand_total_qty || 0), 0)
      : markers.reduce((sum, m) => sum + Number(m.total_req_qty || 0), 0);

    const totalActNetFabric = markers.reduce((sum, m) => {
      const pcs = (m.colorways || []).reduce((cs, cw) => cs + (Number(cw.total_cut_pcs) || Number(cw.total_order_pcs) || 0), 0);
      const netPerPc = isWoven ? (m.act_length_per_pc_cm || 0) / 100 : (m.act_wt_per_pc_g || 0) / 1000;
      return sum + (pcs * netPerPc);
    }, 0);

    const avgGarmentCons = totalOrderPcs > 0 ? (grandFabric / totalOrderPcs) : 0;
    const actGarmentCons = totalOrderPcs > 0 && totalActNetFabric > 0 
      ? (totalActNetFabric / totalOrderPcs) 
      : avgGarmentCons * (1 - (totalAllowancePct / 100.0));

    const collarYarnKg = flatKnitSpec.enabled ? Number(flatKnitSpec.total_yarn_kg || 0) : 0;
    const foldingFabricKg = specialParts
      .filter((p) => p.uom === 'KG')
      .reduce((sum, p) => sum + (Number(p.total_qty) || 0), 0);
    const totalTapesMtrs = specialParts
      .filter((p) => p.uom === 'MTRS')
      .reduce((sum, p) => sum + (Number(p.total_qty) || 0), 0);

    const grandTotalMaterial = isWoven
      ? Math.round(grandFabric * 100) / 100
      : Math.round((grandFabric + collarYarnKg + foldingFabricKg) * 100) / 100;

    return {
      totalOrderPcs,
      grandFabric: Math.round(grandFabric * 100) / 100,
      avgGarmentCons: Math.round(avgGarmentCons * 10000) / 10000,
      actGarmentCons: Math.round(actGarmentCons * 10000) / 10000,
      collarYarnKg,
      foldingFabricKg,
      totalTapesMtrs,
      grandTotalMaterial,
      uom: isWoven ? 'MTR' : 'KG',
    };
  }, [markers, fabricProgram, header.order_qty, totalAllowancePct, isWoven, flatKnitSpec, specialParts]);

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

  const recomputeSingleMarker = (m: CadMarker) => {
    const lengthMm = Number(m.length_mm) || 0;
    const widthMm = Number(m.width_mm) || 0;
    const diaType = m.fabric_dia_type === 'TUBE' ? 'TUBE' : 'OPEN';
    const gsm = Number(m.gsm) || 160;

    const layAllowance = Number(m.lay_allowance_cm ?? 10.0);
    const widthAllowance = Number(m.width_allowance_in ?? (diaType === 'TUBE' ? 1.0 : 2.0));
    const markerRejectionPct = m.rejection_pct != null ? Number(m.rejection_pct) : Number(header.rejection_pct ?? 3.0);
    const markerFabAllowancePct = m.fabric_allowance_pct != null ? Number(m.fabric_allowance_pct) : Number(header.fabric_allowance_pct ?? 10.0);

    const layLenCm = Math.round(((lengthMm / 10.0) + layAllowance) * 10) / 10;
    const tblWidthIn = Math.round(((widthMm / 25.4) + widthAllowance) * 100) / 100;
    const diaIn = m.dia_in != null && m.dia_in > 0 ? Number(m.dia_in) : Math.round(tblWidthIn);
    const diaVal = `${diaIn}"`;
    const diaSpec = `${diaVal} ${diaType}`;

    const sumRatios = (m.ratios || []).reduce((a, b) => a + (Number(b) || 0), 0);

    let fabricWtLay = 0;
    let pcsLay = 1;
    let actWtPc = 0;
    let avgWtPc = 0;
    let actLenPc = 0;
    let reqLenPc = 0;

    if (!isWoven) {
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
      if (!isWoven) {
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

    const markerUom = (isWoven || header.cad_type === 'WOVEN' || header.uom === 'MTR') ? 'MTR' : (m.uom || 'KG');
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
                collar_dimension: dim,
                collar_pcs: pcs,
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
          const totCollar = parsedCollarRows.reduce((sum, r) => sum + r.collar_pcs, 0);
          const wtKg = parsedFlatKnitWeight / 1000.0;
          setFlatKnitSpec({
            enabled: true,
            item_type: '95% COTTON 5% ELASTANE 2X2 FLATKNIT',
            color: 'NAVY',
            gsm: 500,
            weight_per_set_g: parsedFlatKnitWeight,
            size_rows: parsedCollarRows,
            total_collar_pcs: totCollar,
            total_cuff_pcs: 0,
            total_yarn_kg: Math.round(totCollar * wtKg * 100) / 100,
            remarks: `Imported from ${file.name} FABRIC sheet (${parsedCollarRows.length} sizes, 500 GSM Flatknit)`,
          });
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
        special_parts: specialParts,
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
        });
      }
      setHeader((p) => ({ ...p, status: 'APPROVED' }));
      toast('Approved! Auto-synced to Style BOM and Procurement.', 'success');
      setActiveTab('OUTPUT');
    } catch (e: any) {
      toast(e.message || 'Approval failed', 'error');
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

          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition disabled:opacity-50"
          >
            <Save size={14} />
            <span>{saving ? 'Saving...' : 'Save CAD Req'}</span>
          </button>
        </div>
      </div>

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="p-3 bg-white rounded-xl border border-slate-200/80 shadow-sm">
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Markers Planned</div>
          <div className="text-lg font-bold text-slate-900 mt-0.5">{markers.length} Sheets</div>
          <div className="text-[10px] text-slate-400">Tabs: {markers.map((m) => m.marker_ref).join(', ')}</div>
        </div>

        <div className="p-3 bg-white rounded-xl border border-slate-200/80 shadow-sm">
          <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Planned Garment Qty</div>
          <div className="text-lg font-bold text-indigo-600 mt-0.5">{fmtNumber(summaryKpis.totalOrderPcs)} Pcs</div>
          <div className="text-[10px] text-slate-400">Rejection: +{header.rejection_pct}% CEIL</div>
        </div>

        <div className="p-3 bg-indigo-50/60 rounded-xl border border-indigo-200 shadow-sm">
          <div className="text-[11px] font-semibold text-indigo-700 uppercase tracking-wider">Total Fabric Need</div>
          <div className="text-xl font-bold text-indigo-900 mt-0.5">
            {fmtDecimal(summaryKpis.grandFabric)} {summaryKpis.uom}
          </div>
          <div className="text-[10px] text-indigo-600">F.PRGM consolidated</div>
        </div>

        <div className="p-3 bg-emerald-50/60 rounded-xl border border-emerald-200 shadow-sm">
          <div className="text-[11px] font-semibold text-emerald-700 uppercase tracking-wider">Average Cons / Pc</div>
          <div className="text-lg font-bold text-emerald-900 mt-0.5">
            {fmtDecimal(summaryKpis.avgGarmentCons * (isWoven ? 1 : 1000), 2)} {isWoven ? 'Mtrs' : 'Gms'}
          </div>
          <div className="text-[10px] text-emerald-600">With {header.fabric_allowance_pct}% fabric allowance</div>
        </div>

        <div className="p-3 bg-amber-50/60 rounded-xl border border-amber-200 shadow-sm">
          <div className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider">Actual Net Cons / Pc</div>
          <div className="text-lg font-bold text-amber-900 mt-0.5">
            {fmtDecimal(summaryKpis.actGarmentCons * (isWoven ? 1 : 1000), 2)} {isWoven ? 'Mtrs' : 'Gms'}
          </div>
          <div className="text-[10px] text-amber-600">Pure net lay consumption</div>
        </div>
      </div>

      {/* Header Parameters Card */}
      <div className="bg-white p-4 rounded-xl border border-slate-200/80 shadow-sm space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-6 gap-3">
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
            label="Style No *"
            value={header.style_id}
            onChange={(e) => setHeader((p) => ({ ...p, style_id: e.target.value }))}
            options={toOptions(styles.data)}
            placeholder="Select Style"
          />

          <Input
            label="Job / IR No"
            value={header.internal_ir_no}
            onChange={(e) => setHeader((p) => ({ ...p, internal_ir_no: e.target.value }))}
            placeholder="e.g. G3 RG 218 AL"
          />

          <div className="space-y-1">
            <label className="block text-xs font-semibold text-slate-700">Garment Type / Mode</label>
            <select
              value={header.cad_type}
              onChange={(e) => {
                const val = e.target.value as any;
                const woven = val === 'WOVEN';
                const nextUom = woven ? 'MTR' : 'KG';
                setHeader((p) => ({
                  ...p,
                  cad_type: val,
                  uom: nextUom,
                  fabric_allowance_pct: woven ? 0.0 : 10.0,
                }));
                setMarkers((prev) =>
                  prev.map((m) =>
                    recomputeSingleMarker({
                      ...m,
                      uom: nextUom,
                    })
                  )
                );
                setFabricProgram((prev) =>
                  prev.map((fp) => ({ ...fp, uom: nextUom }))
                );
                setCuttingLay((prev) =>
                  prev.map((cl) => ({ ...cl, uom: nextUom }))
                );
              }}
              className="w-full text-xs rounded-lg border border-slate-300 py-1.5 px-2 bg-white font-medium text-slate-800"
            >
              <option value="KNIT_SJ">Single Jersey Knits (KG)</option>
              <option value="KNIT_FLEECE">Fleece / Heavy Knits (KG)</option>
              <option value="WOVEN">Woven Fabric (MTRS)</option>
              <option value="MULTI_PART">Multi-Material Hoodies (KG)</option>
            </select>
          </div>

          <Input
            label="Order Qty (Pcs)"
            type="number"
            value={header.order_qty}
            onChange={(e) => setHeader((p) => ({ ...p, order_qty: parseInt(e.target.value) || 0 }))}
          />
        </div>

        {/* Allowances & Instructions Bar */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 pt-2 border-t border-slate-100 items-center">
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-700 whitespace-nowrap">Rejection %:</label>
            <input
              type="number"
              step="0.5"
              value={header.rejection_pct}
              onChange={(e) => setHeader((p) => ({ ...p, rejection_pct: parseFloat(e.target.value) || 0 }))}
              className="w-20 text-xs font-bold text-amber-700 border border-slate-300 rounded px-2 py-1 text-right"
            />
            <span className="text-[11px] text-slate-500">(CEIL per size)</span>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-700 whitespace-nowrap">Fabric Loss %:</label>
            <input
              type="number"
              step="0.5"
              value={header.fabric_allowance_pct}
              onChange={(e) => setHeader((p) => ({ ...p, fabric_allowance_pct: parseFloat(e.target.value) || 0 }))}
              className="w-20 text-xs font-bold text-indigo-700 border border-slate-300 rounded px-2 py-1 text-right"
            />
            <span className="text-[11px] text-slate-500">(Total: {totalAllowancePct}%)</span>
          </div>

          <div className="md:col-span-2">
            <input
              type="text"
              placeholder="Special notes e.g. GREY FORM BIO WASH, 10MM TWILL TAPE - 60 CM..."
              value={header.special_notes}
              onChange={(e) => setHeader((p) => ({ ...p, special_notes: e.target.value }))}
              className="w-full text-xs border border-slate-300 rounded px-2 py-1 font-mono text-slate-700"
            />
          </div>
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
                <label className="block text-[11px] font-semibold text-slate-600">Fabric Type / Description</label>
                <input
                  type="text"
                  value={activeMarker.fabric_type}
                  onChange={(e) => updateActiveMarker({ fabric_type: e.target.value })}
                  placeholder="e.g. 100% Cotton Single Jersey"
                  className="w-full font-semibold border border-slate-300 rounded px-2 py-1 mt-0.5"
                />
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
                  value={activeMarker.width_mm}
                  onChange={(e) => updateActiveMarker({ width_mm: parseFloat(e.target.value) || 0 })}
                  className="w-full font-bold text-indigo-700 border border-slate-300 rounded px-2 py-1 mt-0.5"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600">Dia Form</label>
                <select
                  value={activeMarker.fabric_dia_type}
                  onChange={(e) => {
                    const diaType = e.target.value as 'OPEN' | 'TUBE';
                    updateActiveMarker({ 
                      fabric_dia_type: diaType,
                      width_allowance_in: diaType === 'TUBE' ? 1.0 : 2.0
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
                  value={activeMarker.dia_in ?? Math.round(activeMarker.table_width_in || 0)}
                  onChange={(e) => {
                    const dIn = parseFloat(e.target.value) || 0;
                    updateActiveMarker({ 
                      dia_in: dIn,
                      dia_val: `${dIn}"`,
                      dia_spec: `${dIn}" ${activeMarker.fabric_dia_type}`
                    });
                  }}
                  className="w-full font-bold text-indigo-800 border border-indigo-300 bg-indigo-50/50 rounded px-2 py-1 mt-0.5"
                  placeholder='e.g. 60"'
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-600">GSM</label>
                <input
                  type="number"
                  value={activeMarker.gsm}
                  onChange={(e) => updateActiveMarker({ gsm: parseInt(e.target.value) || 0 })}
                  className="w-full border border-slate-300 rounded px-2 py-1 mt-0.5 font-medium"
                />
              </div>

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
                    onChange={(e) => updateActiveMarker({ width_allowance_in: parseFloat(e.target.value) || 0 })}
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
                <span className="text-slate-500 text-[11px]">Table Width / Dia:</span>
                <div className="font-bold text-indigo-700 mt-0.5 text-sm">
                  {fmtDecimal(activeMarker.table_width_in, 1)}" ({activeMarker.dia_val || `${Math.round(activeMarker.table_width_in || 0)}"`})
                </div>
                <span className="text-[10px] text-slate-400">
                  {((activeMarker.width_mm || 0) / 25.4).toFixed(1)}" + {activeMarker.width_allowance_in}"
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

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                    <th className="py-2 px-3 w-40">Parameter</th>
                    {activeMarker.sizes.map((s, sIdx) => (
                      <th key={sIdx} className="py-2 px-2 text-center">
                        <input
                          type="text"
                          value={s}
                          onChange={(e) => {
                            const copy = [...activeMarker.sizes];
                            copy[sIdx] = e.target.value;
                            updateActiveMarker({ sizes: copy });
                          }}
                          className="w-20 text-center text-xs font-bold border border-slate-300 rounded px-1.5 py-0.5"
                        />
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
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                    <th className="py-2 px-3 w-48">Colorway / Shade</th>
                    <th className="py-2 px-2 text-center w-24">Metric</th>
                    {activeMarker.sizes.map((s, sIdx) => (
                      <th key={sIdx} className="py-2 px-2 text-right">
                        {s}
                      </th>
                    ))}
                    <th className="py-2 px-2 text-right font-bold">Total Pcs</th>
                    <th className="py-2 px-2 text-right font-bold text-indigo-700">Req ({isWoven ? 'MTR' : (activeMarker.uom || 'KG')})</th>
                    <th className="py-2 px-2 text-center w-10">Del</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {activeMarker.colorways.map((cw, cwIdx) => {
                    const cutQtys = (cw.quantities || []).map((q) =>
                      Math.ceil(q * (1 + (header.rejection_pct / 100.0)))
                    );
                    const totOrder = (cw.quantities || []).reduce((a, b) => a + (Number(b) || 0), 0);
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
                          <td className="py-2 px-3 row-span-2">
                            <input
                              type="text"
                              value={cw.color_name}
                              onChange={(e) => {
                                const copy = [...activeMarker.colorways];
                                copy[cwIdx].color_name = e.target.value;
                                updateActiveMarker({ colorways: copy });
                              }}
                              className="w-44 text-xs font-semibold border border-slate-300 rounded px-2 py-1"
                            />
                          </td>
                          <td className="py-1 px-2 text-center font-medium text-slate-500">Order Qty</td>
                          {(cw.quantities || []).map((q, sIdx) => (
                            <td key={sIdx} className="py-1 px-2 text-right">
                              <input
                                type="number"
                                value={q}
                                onChange={(e) => {
                                  const copy = [...activeMarker.colorways];
                                  const qCopy = [...copy[cwIdx].quantities];
                                  qCopy[sIdx] = parseInt(e.target.value) || 0;
                                  copy[cwIdx].quantities = qCopy;
                                  updateActiveMarker({ colorways: copy });
                                }}
                                className="w-20 text-xs text-right font-medium border border-slate-300 rounded px-1.5 py-1"
                              />
                            </td>
                          ))}
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
                          <td className="py-1 px-2 text-center font-semibold text-amber-800">Cut Pieces (Ceil)</td>
                          {cutQtys.map((cq, sIdx) => (
                            <td key={sIdx} className="py-1 px-2 text-right font-mono font-medium">
                              {cq}
                            </td>
                          ))}
                          <td className="py-1 px-2 text-right font-bold font-mono">
                            {fmtNumber(totCut)}
                          </td>
                          <td className="py-1 px-2 text-right text-[10px] text-amber-700">
                            +{activeMarker.rejection_pct ?? header.rejection_pct}% buffer
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
                    <th className="py-2.5 px-3 text-right text-indigo-700">Grand Total ({header.uom})</th>
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
                      <td className="py-2.5 px-3 text-right font-bold text-indigo-700 text-sm">
                        {fmtDecimal(fp.grand_total_qty)} {fp.uom}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-indigo-50/60 font-bold text-indigo-900 border-t border-indigo-200">
                    <td colSpan={5} className="py-3 px-3">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                        <span>TOTAL CONSOLIDATED FABRIC INDENT</span>
                        <div className="flex items-center gap-3 text-xs font-semibold">
                          <span className="text-amber-800 bg-amber-100/70 px-2 py-0.5 rounded">
                            Actual Net Cons: {fmtDecimal(summaryKpis.actGarmentCons * (isWoven ? 1 : 1000), 2)} {isWoven ? 'Mtrs' : 'Gms'}
                          </span>
                          <span className="text-emerald-800 bg-emerald-100/70 px-2 py-0.5 rounded">
                            Gross Avg Cons: {fmtDecimal(summaryKpis.avgGarmentCons * (isWoven ? 1 : 1000), 2)} {isWoven ? 'Mtrs' : 'Gms'}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-2 text-right">{fmtNumber(summaryKpis.totalOrderPcs)} Pcs</td>
                    <td className="py-3 px-2 text-right">
                      {fmtDecimal(fabricProgram.reduce((s, x) => s + Number(x.net_qty || 0), 0))}
                    </td>
                    <td className="py-3 px-2 text-right text-amber-800">
                      +{fmtDecimal(fabricProgram.reduce((s, x) => s + Number(x.buffer_qty || 0), 0))}
                    </td>
                    <td className="py-3 px-3 text-right text-base text-indigo-900">
                      {fmtDecimal(summaryKpis.grandFabric)} {summaryKpis.uom}
                    </td>
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
                  {flatKnitSpec.enabled && (
                    <tr className="hover:bg-amber-50/40 bg-amber-50/20 font-medium">
                      <td className="py-2.5 px-3 font-bold text-slate-900 flex items-center gap-1.5">
                        <Disc size={13} className="text-amber-700" />
                        <span>Flat Knit Collar & Cuff Set</span>
                      </td>
                      <td className="py-2.5 px-3">{flatKnitSpec.item_type} ({flatKnitSpec.gsm} GSM)</td>
                      <td className="py-2.5 px-2 font-mono text-slate-600">
                        {flatKnitSpec.size_rows.length > 0 ? `${flatKnitSpec.size_rows[0]?.size} to ${flatKnitSpec.size_rows[flatKnitSpec.size_rows.length - 1]?.size}` : 'All Sizes'}
                      </td>
                      <td className="py-2.5 px-2 font-semibold text-slate-800">{flatKnitSpec.color}</td>
                      <td className="py-2.5 px-2 text-right font-mono font-bold text-slate-800">
                        {fmtNumber(flatKnitSpec.total_collar_pcs)} Nos
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
                        {fmtDecimal(sp.total_qty, 1)} {sp.uom}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-500">{sp.remarks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Section C: Consolidated Material & Yarn Procurement Summary Cockpit */}
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

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
                <div className="text-[10px] text-amber-700/80 mt-0.5">{fmtNumber(flatKnitSpec.total_collar_pcs)} Collars + Cuffs</div>
              </div>

              <div className="p-3 bg-indigo-600 text-white rounded-lg shadow-sm">
                <span className="text-[10px] text-indigo-200 font-bold uppercase tracking-wider">Grand Total Material</span>
                <div className="text-lg font-extrabold font-mono mt-0.5">
                  {fmtDecimal(summaryKpis.grandTotalMaterial, 2)} <span className="text-xs font-normal text-indigo-200">{summaryKpis.uom}</span>
                </div>
                <div className="text-[10px] text-indigo-200/90 mt-0.5">{isWoven ? 'Total Woven Fabric (MTR)' : 'Fabric + Collar + Fold'}</div>
              </div>
            </div>

            {summaryKpis.totalTapesMtrs > 0 && (
              <div className="text-xs text-slate-600 flex items-center justify-between pt-1">
                <span>Total Tapes & Drawcords Requirement:</span>
                <span className="font-bold text-slate-900 font-mono">
                  {fmtDecimal(summaryKpis.totalTapesMtrs, 1)} MTRS (Twill Tape & Tube Rope)
                </span>
              </div>
            )}
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
                {cuttingLay.map((cl, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-3 font-semibold text-slate-900">{cl.fabric_type}</td>
                    <td className="py-2.5 px-2">{cl.gsm || '—'}</td>
                    <td className="py-2.5 px-2 font-mono text-slate-600">{cl.dia_spec}</td>
                    <td className="py-2.5 px-3 font-bold text-slate-800">{cl.color_name}</td>
                    <td className="py-2.5 px-2 text-right font-medium">{fmtNumber(cl.order_qty_pcs)} Pcs</td>
                    <td className="py-2.5 px-3 text-right font-bold text-emerald-700 text-sm">
                      {fmtDecimal(cl.net_qty)} {cl.uom}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-emerald-50/60 font-bold text-emerald-900 border-t border-emerald-200">
                  <td colSpan={4} className="py-3 px-3">TOTAL CUTTING DEPARTMENT REQUIREMENT</td>
                  <td className="py-3 px-2 text-right">
                    {fmtNumber(cuttingLay.reduce((s, x) => s + Number(x.order_qty_pcs || 0), 0))} Pcs
                  </td>
                  <td className="py-3 px-3 text-right text-base text-emerald-900">
                    {fmtDecimal(cuttingLay.reduce((s, x) => s + Number(x.net_qty || 0), 0))} {summaryKpis.uom}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: TRIMS & ACCESSORIES */}
      {activeTab === 'TRIMS' && (
        <div className="space-y-6">
          {/* Card 1: Flat Knit Collar & Cuff Size-Dimension Matrix */}
          <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-slate-100">
              <div>
                <div className="flex items-center gap-2">
                  <span className="p-1 rounded-lg bg-amber-100 text-amber-800">
                    <Disc size={16} />
                  </span>
                  <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                    Flat Knit Collar & Cuff Size-Dimension Matrix
                  </h2>
                  <Badge tone={flatKnitSpec.enabled ? 'emerald' : 'slate'}>
                    {flatKnitSpec.enabled ? 'Active / Indented' : 'Optional / Disabled'}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Size-specific collar dimensions (e.g. 14.75" x 5"), piece counts, weight per set, and yarn indent calculations
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
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
                    const newRow: CollarDimensionRow = {
                      size: `Size ${flatKnitSpec.size_rows.length + 1}`,
                      collar_dimension: '15.00" X 5.00"',
                      collar_pcs: 50,
                      cuff_dimension: '16.00" X 6.50"',
                      cuff_pcs: 50,
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
                  Weight / Set (Grams or Kg)
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.001"
                    value={flatKnitSpec.weight_per_set_g}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || 0;
                      setFlatKnitSpec(recalculateFlatKnit({ ...flatKnitSpec, weight_per_set_g: val }));
                    }}
                    className="w-full text-xs font-mono font-bold text-amber-900 border border-slate-300 rounded px-2 py-1.5 bg-white"
                  />
                  <span className="text-[11px] text-slate-500 font-medium whitespace-nowrap">
                    {flatKnitSpec.weight_per_set_g > 1 ? 'Gms' : 'Kg'}
                  </span>
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
                      setFlatKnitSpec(recalculateFlatKnit({
                        ...flatKnitSpec,
                        weight_per_set_g: 184,
                        remarks: 'Mens: 0.040+0.052+0.092 = 0.184 GRM (Collar, Cuff, Bottom) | 500 GSM',
                      }));
                      toast('Applied Mens Set Preset (184g / 0.184kg)', 'info');
                    }}
                    className="px-2 py-1 text-[11px] font-semibold rounded border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 transition"
                  >
                    Mens (184g)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFlatKnitSpec(recalculateFlatKnit({
                        ...flatKnitSpec,
                        weight_per_set_g: 137,
                        remarks: 'Boys: 0.031+0.040+0.066 = 0.137 GRM (Collar, Cuff, Bottom) | 500 GSM',
                      }));
                      toast('Applied Boys Set Preset (137g / 0.137kg)', 'info');
                    }}
                    className="px-2 py-1 text-[11px] font-semibold rounded border border-sky-300 bg-sky-50 hover:bg-sky-100 text-sky-800 transition"
                  >
                    Boys (137g)
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
                    <th className="py-2.5 px-3">Collar Dimension Description</th>
                    <th className="py-2.5 px-2 text-right w-24">Collar (Nos)</th>
                    <th className="py-2.5 px-3">Sleeve Cuff Dimension Description</th>
                    <th className="py-2.5 px-2 text-right w-24">Cuff (Nos)</th>
                    <th className="py-2.5 px-3 text-right w-28 text-amber-900">Yarn Wt (Kg)</th>
                    <th className="py-2.5 px-2 text-center w-12">Del</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {flatKnitSpec.size_rows.map((row, idx) => {
                    const wtKg = flatKnitSpec.weight_per_set_g > 1 ? flatKnitSpec.weight_per_set_g / 1000.0 : flatKnitSpec.weight_per_set_g;
                    const rowKg = Math.round((Number(row.collar_pcs) || 0) * wtKg * 100) / 100;
                    return (
                      <tr key={idx} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={row.size}
                            onChange={(e) => {
                              const copy = [...flatKnitSpec.size_rows];
                              copy[idx].size = e.target.value;
                              setFlatKnitSpec(recalculateFlatKnit({ ...flatKnitSpec, size_rows: copy }));
                            }}
                            className="w-24 text-xs font-bold text-slate-900 border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={row.collar_dimension}
                            onChange={(e) => {
                              const copy = [...flatKnitSpec.size_rows];
                              copy[idx].collar_dimension = e.target.value;
                              setFlatKnitSpec({ ...flatKnitSpec, size_rows: copy });
                            }}
                            placeholder='e.g. 15.25" X 5.50"'
                            className="w-full text-xs font-mono font-medium text-slate-800 border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-2 text-right">
                          <input
                            type="number"
                            value={row.collar_pcs}
                            onChange={(e) => {
                              const copy = [...flatKnitSpec.size_rows];
                              copy[idx].collar_pcs = parseInt(e.target.value) || 0;
                              setFlatKnitSpec(recalculateFlatKnit({ ...flatKnitSpec, size_rows: copy }));
                            }}
                            className="w-20 text-xs text-right font-mono font-bold text-slate-900 border border-slate-300 rounded px-1.5 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={row.cuff_dimension || ''}
                            onChange={(e) => {
                              const copy = [...flatKnitSpec.size_rows];
                              copy[idx].cuff_dimension = e.target.value;
                              setFlatKnitSpec({ ...flatKnitSpec, size_rows: copy });
                            }}
                            placeholder='e.g. 16.75" X 6.50"'
                            className="w-full text-xs font-mono font-medium text-slate-600 border border-slate-300 rounded px-2 py-1 bg-white"
                          />
                        </td>
                        <td className="py-2 px-2 text-right">
                          <input
                            type="number"
                            value={row.cuff_pcs || 0}
                            onChange={(e) => {
                              const copy = [...flatKnitSpec.size_rows];
                              copy[idx].cuff_pcs = parseInt(e.target.value) || 0;
                              setFlatKnitSpec(recalculateFlatKnit({ ...flatKnitSpec, size_rows: copy }));
                            }}
                            className="w-20 text-xs text-right font-mono text-slate-700 border border-slate-300 rounded px-1.5 py-1 bg-white"
                          />
                        </td>
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
                    <td className="py-2.5 px-3">TOTALS</td>
                    <td className="py-2.5 px-3 text-xs text-slate-500 font-normal">
                      {flatKnitSpec.size_rows.length} Sizes Defined
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono text-sm">
                      {fmtNumber(flatKnitSpec.total_collar_pcs)} Nos
                    </td>
                    <td className="py-2.5 px-3"></td>
                    <td className="py-2.5 px-2 text-right font-mono text-sm">
                      {fmtNumber(flatKnitSpec.total_cuff_pcs)} Nos
                    </td>
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
                Formula: Total Collar Pcs ({flatKnitSpec.total_collar_pcs} Nos) × Weight/Set ({flatKnitSpec.weight_per_set_g > 1 ? flatKnitSpec.weight_per_set_g + 'g' : flatKnitSpec.weight_per_set_g + 'kg'}) = {flatKnitSpec.total_yarn_kg} KG Flat Knit Yarn
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
                  Requirements for Zip Folding, 10mm Twill Tape, 15mm Draw Cord, and Back Neck Tape (BNT)
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
                          value={sp.fabric_type}
                          onChange={(e) => {
                            const copy = [...specialParts];
                            copy[idx].fabric_type = e.target.value;
                            setSpecialParts(copy);
                          }}
                          className="w-48 text-xs border border-slate-300 rounded px-2 py-1 bg-white"
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
                            copy[idx].consumption_per_pc = cVal;
                            copy[idx].total_qty = Math.round(cVal * header.order_qty * 100) / 100;
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
                            copy[idx].uom = e.target.value;
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
                            copy[idx].total_qty = parseFloat(e.target.value) || 0;
                            setSpecialParts(copy);
                          }}
                          className="w-20 text-xs text-right font-mono font-bold text-indigo-900 border border-slate-300 rounded px-1 py-1 bg-white"
                        />
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
              </table>
            </div>
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
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
