import { query, queryOne, txQuery, type Tx } from '../config/db.js';

/**
 * Fabric roll GSM / Dia / meter engine (client doc "Knitting GSM + Dia/Width + Fabric Roll Meter", 03-Oct-2026).
 *
 *   Meter = KG × 1000 ÷ (GSM × width M)          width M from Dia through the approved Dia/Width rule
 *   KG    = Meter × GSM × width M ÷ 1000
 *   GSM   = KG × 1000 ÷ (Meter × width M)
 *   Width = KG × 1000 ÷ (GSM × Meter)
 *
 * The server is authoritative: every roll insert recalculates here; the screens only preview.
 * Target GSM (specification) and actual GSM (QC), calculated meter and actual meter are kept apart.
 */
export type FabricForm = 'TUBULAR' | 'OPEN_WIDTH';
export interface DiaRule { id: number | null; rule_code: string; fabric_form: FabricForm; formula_type: 'DIRECT' | 'FACTOR' | 'CIRCUMFERENCE'; factor: number }

const INCH_M = 0.0254;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round = (x: number, d: number) => { const f = 10 ** d; return Math.round(x * f) / f; };

/** TUBE / TUBULAR → TUBULAR; OPEN / OPEN_WIDTH → OPEN_WIDTH; anything else null. */
export function normForm(v: unknown): FabricForm | null {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('TUB')) return 'TUBULAR';
  if (s.startsWith('OPEN')) return 'OPEN_WIDTH';
  return null;
}

/** Dia text → inches: 30, 30", 30 inch, 76 cm, 762 mm. The form may be written in the text ("30\" TUBE"). */
export function parseDia(v: unknown): { inch: number | null; form: FabricForm | null } {
  const s = String(v ?? '').trim();
  if (!s) return { inch: null, form: null };
  const m = s.match(/(\d+(?:\.\d+)?)\s*(mm|cm|m\b|"|in|inch|inches)?/i);
  if (!m) return { inch: null, form: normForm(s.replace(/[^A-Za-z_]/g, '')) };
  let x = Number(m[1]);
  const u = (m[2] ?? '').toLowerCase();
  if (u === 'mm') x /= 25.4; else if (u === 'cm') x /= 2.54; else if (u === 'm') x /= INCH_M;
  const form = /tub/i.test(s) ? 'TUBULAR' : /open/i.test(s) ? 'OPEN_WIDTH' : null;
  return { inch: x > 0 ? x : null, form };
}

const DEFAULT_RULES: Record<FabricForm, DiaRule> = {
  TUBULAR: { id: null, rule_code: 'DEFAULT-TUBE-X2', fabric_form: 'TUBULAR', formula_type: 'FACTOR', factor: 2 },
  OPEN_WIDTH: { id: null, rule_code: 'DEFAULT-OPEN', fabric_form: 'OPEN_WIDTH', formula_type: 'DIRECT', factor: 1 },
};

/** The approved, active Dia/Width rule of the form on the date (latest effective_from wins). */
export async function resolveRule(cid: number, form: FabricForm, onDate?: string | null, tx?: Tx): Promise<DiaRule> {
  const sql = `SELECT id, rule_code, fabric_form, formula_type, factor FROM mst_dia_width_rule
                WHERE company_id = ? AND fabric_form = ? AND is_active = 1 AND approval_status = 'APPROVED'
                  AND effective_from <= COALESCE(?, CURDATE()) AND (effective_to IS NULL OR effective_to >= COALESCE(?, CURDATE()))
                ORDER BY effective_from DESC, id DESC LIMIT 1`;
  const p = [cid, form, onDate ?? null, onDate ?? null];
  let r: any;
  try { r = tx ? (await txQuery<any>(tx, sql, p))[0] : await queryOne<any>(sql, p); } catch { r = null; }
  return r ? { id: Number(r.id), rule_code: r.rule_code, fabric_form: r.fabric_form, formula_type: r.formula_type, factor: num(r.factor) || 1 } : DEFAULT_RULES[form];
}

export function widthM(diaInch: number, rule: DiaRule) {
  const k = rule.formula_type === 'DIRECT' ? 1 : rule.formula_type === 'CIRCUMFERENCE' ? Math.PI : rule.factor;
  return diaInch * k * INCH_M;
}

export interface RollCalcInput {
  weight_kg: number;
  target_gsm?: number | null;
  actual_gsm?: number | null;
  dia?: unknown;
  fabric_form?: unknown;
  actual_meters?: number | null;
  /** fabric GSM limits; when missing, target ± gsmTolPct */
  gsm_min?: number | null; gsm_max?: number | null;
  gsmTolPct?: number; meterTolPct?: number;
}
export interface RollCalc {
  fabric_form: FabricForm | null; dia_inch: number | null; width_m: number | null; dia_rule_id: number | null; rule_code: string | null;
  target_gsm: number | null; actual_gsm: number | null; calc_basis: 'TARGET_GSM' | 'ACTUAL_GSM' | null;
  calc_meters: number | null; actual_meters: number | null; meters: number | null;
  meter_var: number | null; meter_var_pct: number | null; gsm_var: number | null; gsm_var_pct: number | null;
  out_of_tolerance: boolean; reasons: string[]; formula: string;
}

/** Pure roll calculation (rule already resolved). */
export function calcRoll(i: RollCalcInput, rule: DiaRule | null): RollCalc {
  const kg = num(i.weight_kg);
  const d = parseDia(i.dia);
  const form = normForm(i.fabric_form) ?? d.form ?? rule?.fabric_form ?? null;
  const wM = d.inch && rule ? widthM(d.inch, rule) : null;
  const target = num(i.target_gsm) > 0 ? num(i.target_gsm) : null;
  const actMeters = num(i.actual_meters) > 0 ? num(i.actual_meters) : null;
  // actual GSM: from KG + actual meter (measured), else the GSM the QC entered
  let actual = num(i.actual_gsm) > 0 ? num(i.actual_gsm) : null;
  if (actMeters && wM && kg > 0) actual = (kg * 1000) / (actMeters * wM);
  const basisGsm = target ?? actual;
  const calc = kg > 0 && basisGsm && wM ? (kg * 1000) / (basisGsm * wM) : null;
  const meterVar = calc && actMeters ? actMeters - calc : null;
  const meterVarPct = calc && actMeters ? ((actMeters - calc) / calc) * 100 : null;
  const gsmVar = target && actual ? actual - target : null;
  const gsmVarPct = target && actual ? ((actual - target) / target) * 100 : null;
  const reasons: string[] = [];
  if (actual && target) {
    const tol = num(i.gsmTolPct) || 5;
    const lo = num(i.gsm_min) > 0 ? num(i.gsm_min) : target * (1 - tol / 100);
    const hi = num(i.gsm_max) > 0 ? num(i.gsm_max) : target * (1 + tol / 100);
    if (actual < lo - 1e-9 || actual > hi + 1e-9) reasons.push(`GSM ${round(actual, 1)} outside ${round(lo, 1)}–${round(hi, 1)}`);
  }
  if (meterVarPct !== null && Math.abs(meterVarPct) > (num(i.meterTolPct) || 5) + 1e-9) reasons.push(`meter ${round(meterVarPct, 2)}% vs calculated (limit ±${num(i.meterTolPct) || 5}%)`);
  return {
    fabric_form: form, dia_inch: d.inch ? round(d.inch, 3) : null, width_m: wM ? round(wM, 5) : null, dia_rule_id: rule?.id ?? null, rule_code: rule?.rule_code ?? null,
    target_gsm: target ? round(target, 3) : null, actual_gsm: actual ? round(actual, 3) : null,
    calc_basis: calc ? (target ? 'TARGET_GSM' : 'ACTUAL_GSM') : null,
    calc_meters: calc ? round(calc, 3) : null, actual_meters: actMeters ? round(actMeters, 3) : null,
    meters: actMeters ? round(actMeters, 3) : calc ? round(calc, 3) : null,
    meter_var: meterVar !== null ? round(meterVar, 3) : null, meter_var_pct: meterVarPct !== null ? round(meterVarPct, 3) : null,
    gsm_var: gsmVar !== null ? round(gsmVar, 3) : null, gsm_var_pct: gsmVarPct !== null ? round(gsmVarPct, 3) : null,
    out_of_tolerance: reasons.length > 0, reasons, formula: 'KG*1000/(GSM*WIDTH_M)',
  };
}

/** Company tolerance settings (ROLL_GSM_TOLERANCE_PCT, ROLL_METER_VARIANCE_PCT). */
export async function rollTolerances(cid: number) {
  const rows = await query<any>(`SELECT setting_key k, setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key IN ('ROLL_GSM_TOLERANCE_PCT','ROLL_METER_VARIANCE_PCT')`, [cid]);
  const g = (k: string, d: number) => { const r = rows.find((x) => x.k === k); const x = Number(r?.v); return Number.isFinite(x) && x > 0 ? x : d; };
  return { gsmTolPct: g('ROLL_GSM_TOLERANCE_PCT', 5), meterTolPct: g('ROLL_METER_VARIANCE_PCT', 5) };
}

/** Fabric master spec: target GSM, min / max, form, dia. */
export async function fabricSpec(fabricId: number | null | undefined, tx?: Tx) {
  if (!fabricId) return null;
  const sql = `SELECT fb.id, fb.min_gsm, fb.max_gsm, fb.width_form, fb.dia_inch, g.gsm_value, g.tolerance
                 FROM mst_fabric fb LEFT JOIN mst_gsm g ON g.id = fb.gsm_id WHERE fb.id = ?`;
  const r = tx ? (await txQuery<any>(tx, sql, [fabricId]))[0] : await queryOne<any>(sql, [fabricId]);
  if (!r) return null;
  return { target_gsm: num(r.gsm_value) || null, gsm_min: num(r.min_gsm) || null, gsm_max: num(r.max_gsm) || null,
    fabric_form: normForm(r.width_form), dia_inch: num(r.dia_inch) || null };
}

/** Everything a roll insert needs: spec + rule + tolerances → calculation. */
export async function calcRollFor(cid: number, i: RollCalcInput & { fabric_id?: number | null; on?: string | null }, tx?: Tx,
  ctx?: { tol?: { gsmTolPct: number; meterTolPct: number }; spec?: Awaited<ReturnType<typeof fabricSpec>> | null }) {
  const spec = ctx?.spec !== undefined ? ctx.spec : await fabricSpec(i.fabric_id, tx);
  const tol = ctx?.tol ?? await rollTolerances(cid);
  const form = normForm(i.fabric_form) ?? parseDia(i.dia).form ?? spec?.fabric_form ?? 'TUBULAR';
  const rule = await resolveRule(cid, form, i.on, tx);
  return calcRoll({
    ...i, fabric_form: form,
    dia: i.dia ?? (spec?.dia_inch ? `${spec.dia_inch}` : null),
    target_gsm: i.target_gsm ?? spec?.target_gsm ?? null,
    gsm_min: i.gsm_min ?? spec?.gsm_min ?? null, gsm_max: i.gsm_max ?? spec?.gsm_max ?? null, ...tol,
  }, rule);
}

/** Column list + values for the calculation columns of trx_fabric_roll. */
export const ROLL_CALC_COLS = 'fabric_form, target_gsm, actual_gsm, width_m, dia_rule_id, calc_meters, actual_meters, meter_var_pct, gsm_var_pct, calc_basis, gsm_flag';
export const rollCalcVals = (c: RollCalc) => [c.fabric_form, c.target_gsm, c.actual_gsm, c.width_m, c.dia_rule_id, c.calc_meters, c.actual_meters,
  c.meter_var_pct, c.gsm_var_pct, c.calc_basis, c.out_of_tolerance ? 'OUT_OF_TOLERANCE' : null];

/** Reverse calculations (calculator / planning). Exactly one unknown is solved. */
export function solve(i: { weight_kg?: number | null; meters?: number | null; gsm?: number | null; width_m?: number | null }) {
  const kg = num(i.weight_kg), m = num(i.meters), g = num(i.gsm), w = num(i.width_m);
  if (kg > 0 && g > 0 && w > 0 && !m) return { solved: 'meters', meters: round((kg * 1000) / (g * w), 3) };
  if (m > 0 && g > 0 && w > 0 && !kg) return { solved: 'weight_kg', weight_kg: round((m * g * w) / 1000, 3) };
  if (kg > 0 && m > 0 && w > 0 && !g) return { solved: 'gsm', gsm: round((kg * 1000) / (m * w), 3) };
  if (kg > 0 && g > 0 && m > 0 && !w) return { solved: 'width_m', width_m: round((kg * 1000) / (g * m), 5) };
  return { solved: null };
}
