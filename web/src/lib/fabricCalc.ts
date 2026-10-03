import { useQuery } from '@tanstack/react-query';
import { http } from './api';

/**
 * Live preview of the fabric roll GSM / Dia / meter calculation (client doc 03-Oct-2026).
 * The server (core/fabricRollCalc.ts) is authoritative and recalculates every roll on save — this only
 * shows the same figures while typing:  Meter = KG × 1000 ÷ (GSM × width M), width M from Dia + the approved rule.
 */
export type FabricForm = 'TUBULAR' | 'OPEN_WIDTH';
export interface DiaRule { id: number; rule_code: string; fabric_form: FabricForm; formula_type: 'DIRECT' | 'FACTOR' | 'CIRCUMFERENCE'; factor: number; in_use?: boolean }
export interface FabricSpec { target_gsm: number | null; gsm_min: number | null; gsm_max: number | null; fabric_form: FabricForm; dia_inch: number | null; width_m: number | null; rule_code: string; tolerances: { gsmTolPct: number; meterTolPct: number } }

export const FORM_LABEL: Record<FabricForm, string> = { TUBULAR: 'Tubular', OPEN_WIDTH: 'Open width' };

export function useDiaRules() {
  return useQuery({ queryKey: ['dia-width-rules'], queryFn: async () => (await http.get<{ data: DiaRule[] }>('/dia-width-rules')).data ?? [], staleTime: 300_000 });
}
export function useFabricSpec(fabricId: string | number | null | undefined) {
  return useQuery({
    queryKey: ['fabric-spec', String(fabricId ?? '')],
    queryFn: async () => (await http.get<{ data: FabricSpec }>(`/fabrics/${fabricId}/specification`)).data,
    enabled: !!fabricId, staleTime: 300_000,
  });
}

export const normForm = (v: unknown): FabricForm | null => {
  const s = String(v ?? '').trim().toUpperCase();
  return s.startsWith('TUB') ? 'TUBULAR' : s.startsWith('OPEN') ? 'OPEN_WIDTH' : null;
};
export function parseDiaInch(v: unknown): number | null {
  const m = String(v ?? '').match(/(\d+(?:\.\d+)?)\s*(mm|cm|"|in|inch)?/i);
  if (!m) return null;
  let x = Number(m[1]); const u = (m[2] ?? '').toLowerCase();
  if (u === 'mm') x /= 25.4; else if (u === 'cm') x /= 2.54;
  return x > 0 ? x : null;
}
const ruleK = (r?: DiaRule) => (!r ? 1 : r.formula_type === 'DIRECT' ? 1 : r.formula_type === 'CIRCUMFERENCE' ? Math.PI : Number(r.factor) || 1);
const DEFAULT_K: Record<FabricForm, number> = { TUBULAR: 2, OPEN_WIDTH: 1 };

export interface RollPreview { width_m: number | null; calc_meters: number | null; actual_gsm: number | null; meter_var_pct: number | null; gsm_var_pct: number | null; hold: string | null }

export function previewRoll(i: { weight_kg: unknown; target_gsm: unknown; actual_gsm?: unknown; dia: unknown; form: FabricForm | null; actual_meters?: unknown },
  rules: DiaRule[] | undefined, spec?: Partial<FabricSpec> | null): RollPreview {
  const kg = Number(i.weight_kg) || 0;
  const dia = parseDiaInch(i.dia);
  const form = i.form ?? (/tub/i.test(String(i.dia ?? '')) ? 'TUBULAR' : /open/i.test(String(i.dia ?? '')) ? 'OPEN_WIDTH' : null) ?? spec?.fabric_form ?? 'TUBULAR';
  const rule = (rules ?? []).find((r) => r.in_use && r.fabric_form === form);
  const w = dia ? dia * (rule ? ruleK(rule) : DEFAULT_K[form]) * 0.0254 : null;
  const target = Number(i.target_gsm) || null;
  const am = Number(i.actual_meters) || null;
  let actual = Number(i.actual_gsm) || null;
  if (am && w && kg) actual = (kg * 1000) / (am * w);
  const basis = target ?? actual;
  const calc = kg && basis && w ? (kg * 1000) / (basis * w) : null;
  const mv = calc && am ? ((am - calc) / calc) * 100 : null;
  const gv = target && actual ? ((actual - target) / target) * 100 : null;
  const reasons: string[] = [];
  if (actual && target) {
    const tol = spec?.tolerances?.gsmTolPct ?? 5;
    const lo = spec?.gsm_min || target * (1 - tol / 100), hi = spec?.gsm_max || target * (1 + tol / 100);
    if (actual < lo || actual > hi) reasons.push(`GSM outside ${lo.toFixed(0)}–${hi.toFixed(0)}`);
  }
  if (mv !== null && Math.abs(mv) > (spec?.tolerances?.meterTolPct ?? 5)) reasons.push(`meter ${mv.toFixed(1)}%`);
  return { width_m: w, calc_meters: calc, actual_gsm: actual, meter_var_pct: mv, gsm_var_pct: gv, hold: reasons.length ? reasons.join(' · ') : null };
}

/** "+1.2%" / "-0.4%" with a colour class when beyond the limit. */
export const pctCls = (v: number | null, lim = 5) => (v === null ? 'text-slate-400' : Math.abs(v) > lim ? 'font-semibold text-red-700' : 'text-emerald-700');
export const fmtPct = (v: number | null) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
