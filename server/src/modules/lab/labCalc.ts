/**
 * Lab calculation + evaluation engine (spec §4.7) — pure functions, no database. The server always recalculates from
 * the raw readings; a result sent by a client is never stored.
 *
 *   SHRINKAGE_PCT  ((Before − After) / Before) × 100 per reading pair, result = mean of the pairs. Negative = growth —
 *                  the sign is never changed or clamped. Before = 0 (or negative) → INVALID, no result.
 *   CHANGE_PCT     ((After − Before) / Before) × 100 (growth / GSM change), same pairing rules.
 *   AVERAGE / MIN / MAX   over the single readings.
 *   DIRECT         one value; repeated numeric readings are averaged, repeated grades report the lowest (worst) grade.
 *   NONE           qualitative (dropdown / pass-fail / text / photo).
 *
 * Evaluation runs on the value rounded to the parameter precision (half away from zero); the full-precision value is
 * stored next to it. Limits: min / max, else target ± tolerance. Inclusive edges. BORDERLINE = inside the limits but
 * within the plan's borderline band of a limit (still acceptable, flagged for the reviewer).
 */

export const FORMULA_VERSION: Record<string, number> = { DIRECT: 1, SHRINKAGE_PCT: 1, CHANGE_PCT: 1, AVERAGE: 1, MIN: 1, MAX: 1, NONE: 1 };
export const INPUT_TYPES = ['NUMERIC', 'BEFORE_AFTER', 'MULTI_READING', 'GRADE', 'PASS_FAIL', 'DROPDOWN', 'TEXT', 'PHOTO'] as const;
export const FORMULAS = ['DIRECT', 'SHRINKAGE_PCT', 'CHANGE_PCT', 'AVERAGE', 'MIN', 'MAX', 'NONE'] as const;
export type InputType = (typeof INPUT_TYPES)[number];
export type Formula = (typeof FORMULAS)[number];
export type EvalStatus = 'PASS' | 'FAIL' | 'BORDERLINE' | 'NOT_APPLICABLE' | 'PENDING' | 'INVALID';

/** Which formulas an input type can use. */
export const FORMULAS_FOR: Record<InputType, Formula[]> = {
  NUMERIC: ['DIRECT'],
  BEFORE_AFTER: ['SHRINKAGE_PCT', 'CHANGE_PCT'],
  MULTI_READING: ['AVERAGE', 'MIN', 'MAX'],
  GRADE: ['DIRECT'],
  PASS_FAIL: ['NONE'],
  DROPDOWN: ['NONE'],
  TEXT: ['NONE'],
  PHOTO: ['NONE'],
};

/** Round half away from zero at `dp` decimals without binary drift (4.45 → 4.5, −2.25 → −2.3). */
export function roundHalfAway(x: number, dp: number): number {
  if (!Number.isFinite(x)) return x;
  const s = Math.sign(x) || 1;
  const a = Math.abs(x);
  // shift via exponent notation so 1.005 → 100.5 exactly, then round
  const shifted = Number(`${a.toPrecision(15)}e${dp}`);
  const r = Math.round(shifted + 1e-9);
  return s * Number(`${r}e-${dp}`);
}

export function fmtFixed(x: number, dp: number): string {
  const r = roundHalfAway(x, dp);
  const out = r.toFixed(dp);
  return out === `-${(0).toFixed(dp)}` ? (0).toFixed(dp) : out;
}

/** Grey-scale grade text → number: "4-5" / "4/5" → 4.5, "3" → 3. */
export function gradeToNumber(v: string | null | undefined): number | null {
  if (v == null) return null;
  const t = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)\s*[-/]\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return (Number(m[1]) + Number(m[2])) / 2;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}
export function numberToGrade(n: number): string {
  return Number.isInteger(n) ? String(n) : `${Math.floor(n)}-${Math.floor(n) + 1}`;
}

export function splitList(v: string | null | undefined): string[] {
  return String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

export interface Reading { reading_stage: 'BEFORE' | 'AFTER' | 'SINGLE'; reading_no: number; numeric_value: number | null; text_value: string | null }
export interface ParamDef { input_type: InputType; formula_code: Formula; precision_dp: number; allowed_values?: string | null }
export interface Criteria {
  min_value: number | null; max_value: number | null; target_value: number | null; tolerance: number | null;
  borderline_band: number | null; pass_values: string | null; is_mandatory: boolean; repeat_count: number;
}
export interface CalcResult {
  raw_before: number | null; raw_after: number | null; calculated_value: number | null; display_value: string | null;
  result_text: string | null; status: EvalStatus; note: string | null; complete: boolean; lower: number | null; upper: number | null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const micro = (x: number) => Math.round(x * 1e6);

/** Effective numeric limits of a criteria row. */
export function limits(c: Pick<Criteria, 'min_value' | 'max_value' | 'target_value' | 'tolerance'>) {
  const hasTT = c.target_value != null && c.tolerance != null;
  const lower = c.min_value != null ? Number(c.min_value) : hasTT ? Number(c.target_value) - Number(c.tolerance) : null;
  const upper = c.max_value != null ? Number(c.max_value) : hasTT ? Number(c.target_value) + Number(c.tolerance) : null;
  return { lower, upper };
}

/** PASS / FAIL / BORDERLINE of a (rounded) value against the limits; NOT_APPLICABLE when the plan sets no limit. */
export function evaluateNumeric(value: number, c: Criteria): { status: EvalStatus; note: string | null; lower: number | null; upper: number | null } {
  const { lower, upper } = limits(c);
  if (lower == null && upper == null) return { status: 'NOT_APPLICABLE', note: 'No acceptance limit in the test plan', lower, upper };
  const v = micro(value);
  if (lower != null && v < micro(lower)) return { status: 'FAIL', note: `Below minimum ${lower}`, lower, upper };
  if (upper != null && v > micro(upper)) return { status: 'FAIL', note: `Above maximum ${upper}`, lower, upper };
  const band = c.borderline_band != null && Number(c.borderline_band) > 0 ? micro(Number(c.borderline_band)) : 0;
  if (band && ((lower != null && v - micro(lower) <= band) || (upper != null && micro(upper) - v <= band)))
    return { status: 'BORDERLINE', note: 'Within limits, close to a limit', lower, upper };
  return { status: 'PASS', note: null, lower, upper };
}

function pairs(readings: Reading[]) {
  const b = new Map<number, number>(); const a = new Map<number, number>();
  for (const r of readings) {
    if (r.numeric_value == null) continue;
    if (r.reading_stage === 'BEFORE') b.set(r.reading_no, Number(r.numeric_value));
    if (r.reading_stage === 'AFTER') a.set(r.reading_no, Number(r.numeric_value));
  }
  const out: { no: number; before: number; after: number }[] = [];
  for (const [no, before] of [...b.entries()].sort((x, y) => x[0] - y[0])) if (a.has(no)) out.push({ no, before, after: a.get(no)! });
  return { out, befores: [...b.values()], afters: [...a.values()] };
}

/** One parameter: readings → calculated value → evaluation. `hasEvidence` is used by PHOTO parameters. */
export function computeResult(p: ParamDef, c: Criteria, readings: Reading[], hasEvidence = false): CalcResult {
  const dp = Math.max(0, Math.min(6, Number(p.precision_dp ?? 2)));
  const need = Math.max(1, Number(c.repeat_count ?? 1));
  const base: CalcResult = { raw_before: null, raw_after: null, calculated_value: null, display_value: null, result_text: null,
    status: 'PENDING', note: null, complete: false, lower: null, upper: null };
  const numeric = (v: number, rawNote: string | null = null): CalcResult => {
    const rounded = roundHalfAway(v, dp);
    const e = evaluateNumeric(rounded, c);
    return { ...base, calculated_value: v, display_value: fmtFixed(v, dp), status: e.status, note: e.note ?? rawNote, complete: true, lower: e.lower, upper: e.upper };
  };

  switch (p.formula_code) {
    case 'SHRINKAGE_PCT':
    case 'CHANGE_PCT': {
      const { out, befores, afters } = pairs(readings);
      const rb = befores.length ? mean(befores) : null; const ra = afters.length ? mean(afters) : null;
      if (out.some((x) => x.before <= 0))
        return { ...base, raw_before: rb, raw_after: ra, status: 'INVALID', note: 'Before measurement must be greater than zero' };
      if (out.length < need) return { ...base, raw_before: rb, raw_after: ra, note: `${out.length} of ${need} before / after pair(s) entered` };
      const per = out.map((x) => (p.formula_code === 'SHRINKAGE_PCT' ? (x.before - x.after) / x.before : (x.after - x.before) / x.before) * 100);
      const v = mean(per);
      const r = numeric(v);
      const growth = p.formula_code === 'SHRINKAGE_PCT' && roundHalfAway(v, dp) < 0 ? 'Growth (negative shrinkage)' : null;
      return { ...r, raw_before: rb, raw_after: ra, result_text: growth, note: r.note ?? null };
    }
    case 'AVERAGE': case 'MIN': case 'MAX': {
      const xs = readings.filter((r) => r.reading_stage === 'SINGLE' && r.numeric_value != null).map((r) => Number(r.numeric_value));
      if (xs.length < need) return { ...base, note: `${xs.length} of ${need} reading(s) entered` };
      const v = p.formula_code === 'AVERAGE' ? mean(xs) : p.formula_code === 'MIN' ? Math.min(...xs) : Math.max(...xs);
      return numeric(v);
    }
    case 'DIRECT': {
      if (p.input_type === 'GRADE') {
        const allowed = splitList(p.allowed_values);
        const gs = readings.filter((r) => r.reading_stage === 'SINGLE' && (r.text_value ?? '') !== '');
        if (gs.length < need) return { ...base, note: `${gs.length} of ${need} grade(s) entered` };
        const bad = gs.find((g) => (allowed.length && !allowed.includes(String(g.text_value).trim())) || gradeToNumber(g.text_value) == null);
        if (bad) return { ...base, status: 'INVALID', note: `Grade "${bad.text_value}" is not on the scale` };
        const nums = gs.map((g) => gradeToNumber(g.text_value)!);
        const worst = Math.min(...nums);
        const r = numeric(worst);
        const worstText = gs.find((g) => gradeToNumber(g.text_value) === worst)!.text_value!.trim();
        return { ...r, display_value: worstText, result_text: gs.length > 1 ? `Lowest of ${gs.length} grades` : null };
      }
      const xs = readings.filter((r) => r.reading_stage === 'SINGLE' && r.numeric_value != null).map((r) => Number(r.numeric_value));
      if (xs.length < need) return { ...base, note: `${xs.length} of ${need} reading(s) entered` };
      return numeric(mean(xs));
    }
    default: {
      // qualitative
      const t = readings.find((r) => r.reading_stage === 'SINGLE' && (r.text_value ?? '').trim() !== '')?.text_value?.trim() ?? null;
      if (p.input_type === 'PHOTO') {
        if (!hasEvidence) return { ...base, note: 'Photo evidence not attached' };
        return { ...base, result_text: t, display_value: 'Photo', status: 'NOT_APPLICABLE', complete: true };
      }
      if (t == null) return { ...base, note: 'No value entered' };
      if (p.input_type === 'PASS_FAIL') {
        const u = t.toUpperCase();
        if (u !== 'PASS' && u !== 'FAIL') return { ...base, status: 'INVALID', note: 'Enter PASS or FAIL' };
        return { ...base, display_value: u, result_text: u, status: u as EvalStatus, complete: true };
      }
      if (p.input_type === 'DROPDOWN') {
        const allowed = splitList(p.allowed_values);
        if (allowed.length && !allowed.includes(t)) return { ...base, status: 'INVALID', note: `"${t}" is not one of the choices` };
        const pv = splitList(c.pass_values);
        return { ...base, display_value: t, result_text: t, status: pv.length ? (pv.includes(t) ? 'PASS' : 'FAIL') : 'NOT_APPLICABLE', complete: true };
      }
      return { ...base, display_value: t.length > 40 ? `${t.slice(0, 37)}…` : t, result_text: t, status: 'NOT_APPLICABLE', complete: true };
    }
  }
}

/** Overall trial result: PASS only when every mandatory result passes (BORDERLINE / N.A. do not fail); FAIL when any
 *  mandatory result fails; null while a mandatory result is missing or invalid. */
export function overallResult(rows: { is_mandatory: boolean | number; status: EvalStatus }[]): 'PASS' | 'FAIL' | null {
  const mand = rows.filter((r) => Number(r.is_mandatory) === 1 || r.is_mandatory === true);
  if (mand.some((r) => r.status === 'FAIL')) return 'FAIL';
  if (mand.some((r) => r.status === 'PENDING' || r.status === 'INVALID')) return null;
  return 'PASS';
}
