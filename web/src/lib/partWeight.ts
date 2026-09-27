/**
 * KG conversion for CAD specialized parts, foldings, tapes & cords.
 * Mirrored byte-for-byte in web/src/lib/partWeight.ts (the same pattern as
 * invoiceCalc) — keep the two identical. The server recomputes the purchase KG
 * with this module and never trusts a KG figure sent by the client.
 *
 * A non-KG row (MTRS or PCS) is converted with a weight factor entered in one
 * of two units:
 *   PER_KG  "m per kg" / "pcs per kg"  kg = qty / factor   (290 m ÷ 50 m/kg  = 5.8 kg)
 *   G_PER   "g per m"  / "g per pc"    kg = qty × factor / 1000 (290 m × 20 g/m = 5.8 kg)
 *
 * Stored on the row as `kg_factor` + `kg_factor_unit`. Rows saved before the unit
 * existed only carry `qty_per_kg`, which is read as PER_KG (its original meaning).
 * `qty_per_kg` is still written as the per-kg equivalent for older readers.
 * KG rows are their own weight. A missing / non-positive factor gives null
 * ("set factor") and the row is left out of KG totals.
 */

export type PartFactorUnit = 'PER_KG' | 'G_PER';

export interface PartWeightInput {
  uom?: string | null;
  total_qty?: number | string | null;
  kg_factor?: number | string | null;
  kg_factor_unit?: string | null;
  /** Legacy: MTRS (or PCS) per KG. */
  qty_per_kg?: number | string | null;
}

export const PART_FACTOR_UNITS: PartFactorUnit[] = ['PER_KG', 'G_PER'];

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** True when the row is already measured in kilograms. */
export function isKgUom(uom: string | null | undefined): boolean {
  const u = String(uom || 'KG').trim().toUpperCase();
  return u === 'KG' || u === 'KGS';
}

/** Short unit of a non-KG row: 'm' for metres, 'pc' for pieces / nos. */
export function partQtyUnit(uom: string | null | undefined): 'm' | 'pc' {
  const u = String(uom || '').trim().toUpperCase();
  return u.startsWith('M') ? 'm' : 'pc';
}

export function normalizeFactorUnit(unit: string | null | undefined): PartFactorUnit {
  return unit === 'G_PER' ? 'G_PER' : 'PER_KG';
}

/** Label for a factor unit on a row, e.g. "m per kg", "g per m", "pcs per kg", "g per pc". */
export function factorUnitLabel(unit: string | null | undefined, uom: string | null | undefined): string {
  const q = partQtyUnit(uom);
  return normalizeFactorUnit(unit) === 'G_PER' ? `g per ${q}` : `${q === 'm' ? 'm' : 'pcs'} per kg`;
}

/** The factor as entered + its unit, reading legacy `qty_per_kg` rows as PER_KG. */
export function readPartFactor(row: PartWeightInput): { factor: number; unit: PartFactorUnit } {
  const hasNew = row.kg_factor !== undefined && row.kg_factor !== null && row.kg_factor !== '';
  if (hasNew) return { factor: Number(row.kg_factor) || 0, unit: normalizeFactorUnit(row.kg_factor_unit) };
  return { factor: Number(row.qty_per_kg) || 0, unit: 'PER_KG' };
}

/** MTRS (or PCS) per KG equivalent of the row's factor, or null when not set. */
export function partQtyPerKg(row: PartWeightInput): number | null {
  const { factor, unit } = readPartFactor(row);
  if (!(factor > 0) || !Number.isFinite(factor)) return null;
  return unit === 'G_PER' ? round6(1000 / factor) : factor;
}

/** Purchase weight of a row in KG, or null when a non-KG row has no valid factor. */
export function partKg(row: PartWeightInput): number | null {
  const qty = Number(row.total_qty) || 0;
  if (isKgUom(row.uom)) return round3(qty);
  const { factor, unit } = readPartFactor(row);
  if (!(factor > 0) || !Number.isFinite(factor)) return null;
  return round3(unit === 'G_PER' ? (qty * factor) / 1000 : qty / factor);
}

/** Row with its factor fields normalised and `total_kg` / `qty_per_kg` derived. */
export function withPartWeight<T extends PartWeightInput>(row: T): T & { total_kg?: number } {
  const next: any = { ...row };
  if (isKgUom(row.uom)) {
    next.total_kg = partKg(row) ?? undefined;
    return next;
  }
  const { factor, unit } = readPartFactor(row);
  next.kg_factor = factor > 0 ? factor : undefined;
  next.kg_factor_unit = unit;
  next.qty_per_kg = partQtyPerKg(row) ?? undefined;
  const kg = partKg(row);
  next.total_kg = kg == null ? undefined : kg;
  return next;
}
