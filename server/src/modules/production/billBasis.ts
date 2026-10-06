/**
 * Contractor bill basis (client voice note 06-Oct-2026) — what a contractor is paid for, for outside job work and
 * in-house subcontractors alike:
 *   ISSUED       — the DC qty sent: 1,000 PCS on the DC = 1,000 PCS paid (good + mistake + shortage + loss, as each
 *                  inward accounts for them; PCS returned unprocessed are never paid)
 *   GOOD         — only the good PCS received: 950 good of 1,000 = 950 paid
 *   GOOD_MISTAKE — good + mistake (reject) PCS received
 * Default: job work order line → contractor → process setting (bill_include_mistake). It is fixed on the DC when the DC
 * is made, and can be changed for a whole bill at bill passing.
 */
import { txQueryOne, type Tx } from '../../config/db.js';

export const BILL_BASES = ['ISSUED', 'GOOD', 'GOOD_MISTAKE'] as const;
export type BillBasis = (typeof BILL_BASES)[number];
export const BILL_BASIS_LABEL: Record<BillBasis, string> = {
  ISSUED: 'DC qty sent', GOOD: 'Good PCS received', GOOD_MISTAKE: 'Good + mistake PCS',
};

const n = (v: unknown) => Number(v ?? 0) || 0;
export const isBasis = (v: unknown): v is BillBasis => BILL_BASES.includes(v as BillBasis);

/** The basis that applies: bill override → DC → contractor → process. */
export function effectiveBasis(o: { override?: unknown; dc?: unknown; party?: unknown; stageInclMistake?: unknown }): BillBasis {
  if (isBasis(o.override)) return o.override;
  if (isBasis(o.dc)) return o.dc;
  if (isBasis(o.party)) return o.party;
  return n(o.stageInclMistake) ? 'GOOD_MISTAKE' : 'GOOD';
}

/** PCS paid on one inward (or one job of an inward) under a basis. */
export function billedQty(basis: BillBasis, q: { good: unknown; mistake: unknown; short?: unknown; loss?: unknown }) {
  if (basis === 'ISSUED') return n(q.good) + n(q.mistake) + n(q.short) + n(q.loss);
  if (basis === 'GOOD_MISTAKE') return n(q.good) + n(q.mistake);
  return n(q.good);
}

/** Basis to fix on a new DC: the job work order line's, else the contractor's (NULL = process setting at billing). */
export async function dcBillBasis(tx: Tx, vendorId: number, jwLineId?: number | null, typed?: unknown): Promise<BillBasis | null> {
  if (isBasis(typed)) return typed;
  if (jwLineId) {
    const l = await txQueryOne<any>(tx, `SELECT bill_basis FROM trx_jw_order_line WHERE id = ?`, [jwLineId]);
    if (isBasis(l?.bill_basis)) return l.bill_basis;
  }
  const p = await txQueryOne<any>(tx, `SELECT jw_bill_basis FROM mst_party WHERE id = ?`, [vendorId]);
  return isBasis(p?.jw_bill_basis) ? p.jw_bill_basis : null;
}
