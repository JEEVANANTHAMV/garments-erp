import type { Request } from 'express';
import { query, txQuery, txExecute, type Tx } from '../../config/db.js';
import { audit } from '../../core/audit.js';

/**
 * Link between Process DCs (job work) and in-house line allocation.
 *
 * A bundle allocated to an in-house line must not silently go out on a DC of
 * the same process: the DC is blocked unless the user asks to release the
 * allocation, and on issue the allocation (and any open daily-plan row for
 * it) is reduced by the PCS that left, so no plan points at pieces that are
 * now with the contractor.
 */
export type LinkProc = 'sewing' | 'ironing' | 'packing';

const T: Record<LinkProc, { alloc: string; allocD: string; plan: string; planD: string; line: string; label: string }> = {
  sewing: { alloc: 'trx_sewing_line_allocation', allocD: 'trx_sewing_line_allocation_detail', plan: 'trx_sewing_daily_plan', planD: 'trx_sewing_daily_plan_detail', line: 'cfg_sewing_line', label: 'sewing' },
  ironing: { alloc: 'trx_ironing_line_allocation', allocD: 'trx_ironing_line_allocation_detail', plan: 'trx_ironing_daily_plan', planD: 'trx_ironing_daily_plan_detail', line: 'cfg_ironing_line', label: 'ironing' },
  packing: { alloc: 'trx_packing_line_allocation', allocD: 'trx_packing_line_allocation_detail', plan: 'trx_packing_daily_plan', planD: 'trx_packing_daily_plan_detail', line: 'cfg_packing_line', label: 'packing' },
};
const ACTIVE_ALLOC = ['DRAFT', 'SAVED', 'CONFIRMED'];
const OPEN_PLAN = ['DRAFT', 'SAVED', 'CONFIRMED', 'IN_PROGRESS'];
const n = (v: unknown) => Number(v ?? 0) || 0;

/** In-house line process that a DC stage competes with (null = no line planning for it). */
export function linkProcOf(stage: { kind: string; stage_code: string; level: string }): LinkProc | null {
  if (stage.kind === 'SEWING') return 'sewing';
  if (stage.kind === 'FINISHING') return 'ironing';
  if (['PACK', 'PACKING'].includes(String(stage.stage_code).toUpperCase())) return 'packing';
  return null;
}

export interface OpenAlloc { bundle_id: number; open_qty: number; allocation_no: string; line_code: string; status: string }

/** Open (allocated − completed) in-house allocation per bundle, with the document and line. */
export async function openLineAllocations(tx: Tx | null, cid: number, proc: LinkProc, bundleIds: number[]) {
  const map = new Map<number, OpenAlloc>();
  if (!bundleIds.length) return map;
  const t = T[proc];
  const sql = `SELECT d.bundle_id, h.allocation_no, h.status, l.line_code,
                      GREATEST(CAST(d.allocated_qty AS SIGNED) - CAST(d.completed_qty AS SIGNED), 0) AS open_qty
                 FROM ${t.allocD} d JOIN ${t.alloc} h ON h.id = d.allocation_id LEFT JOIN ${t.line} l ON l.id = d.line_id
                WHERE h.company_id = ? AND h.status IN (?) AND d.status = 'ALLOCATED' AND d.bundle_id IN (?)
                ORDER BY d.id`;
  const params = [cid, ACTIVE_ALLOC, bundleIds];
  const rows = tx ? await txQuery<any>(tx, sql, params) : await query<any>(sql, params);
  for (const r of rows) {
    if (n(r.open_qty) <= 0) continue;
    const id = Number(r.bundle_id);
    const cur = map.get(id);
    if (cur) cur.open_qty += n(r.open_qty);
    else map.set(id, { bundle_id: id, open_qty: n(r.open_qty), allocation_no: r.allocation_no, line_code: r.line_code, status: r.status });
  }
  return map;
}

/**
 * Release `qty` PCS of a bundle from its in-house allocations (oldest first) and
 * trim open daily-plan rows of those allocations to match. Returns what was released.
 */
export async function releaseLineAllocation(tx: Tx, req: Request, proc: LinkProc, bundleId: number, qty: number, reason: string) {
  const t = T[proc];
  const cid = req.user!.companyId;
  const rows = await txQuery<any>(tx,
    `SELECT d.*, h.allocation_no FROM ${t.allocD} d JOIN ${t.alloc} h ON h.id = d.allocation_id
      WHERE h.company_id = ? AND h.status IN (?) AND d.status = 'ALLOCATED' AND d.bundle_id = ?
      ORDER BY d.id FOR UPDATE`, [cid, ACTIVE_ALLOC, bundleId]);
  let left = qty;
  const released: { allocation_no: string; qty: number }[] = [];
  for (const d of rows) {
    if (left <= 0) break;
    const open = n(d.allocated_qty) - n(d.completed_qty);
    if (open <= 0) continue;
    const take = Math.min(open, left);
    const newAlloc = n(d.allocated_qty) - take;
    const status = newAlloc > n(d.completed_qty) ? 'ALLOCATED' : n(d.completed_qty) > 0 ? 'COMPLETED' : 'CANCELLED';
    await txExecute(tx, `UPDATE ${t.allocD} SET allocated_qty = ?, status = ?, remarks = LEFT(CONCAT_WS(' · ', remarks, ?), 255) WHERE id = ?`,
      [newAlloc, status, `${take} PCS released: ${reason}`, d.id]);
    // Open plan rows of this allocation row: planned PCS not yet achieved shrink by the same amount.
    let planLeft = take;
    const plans = await txQuery<any>(tx,
      `SELECT pd.* FROM ${t.planD} pd JOIN ${t.plan} p ON p.id = pd.plan_id
        WHERE pd.allocation_detail_id = ? AND p.status IN (?) AND pd.status <> 'CANCELLED' ORDER BY p.plan_date DESC, pd.id DESC FOR UPDATE`,
      [d.id, OPEN_PLAN]);
    for (const pd of plans) {
      if (planLeft <= 0) break;
      const unachieved = n(pd.planned_qty) - n(pd.achieved_qty);
      if (unachieved <= 0) continue;
      const cut = Math.min(unachieved, planLeft);
      const planned = n(pd.planned_qty) - cut;
      await txExecute(tx, `UPDATE ${t.planD} SET planned_qty = ?, status = ? WHERE id = ?`,
        [planned, planned <= 0 ? 'CANCELLED' : planned <= n(pd.achieved_qty) ? 'COMPLETED' : pd.status, pd.id]);
      planLeft -= cut;
    }
    released.push({ allocation_no: d.allocation_no, qty: take });
    left -= take;
  }
  if (released.length) {
    await audit(req, t.allocD, bundleId, 'UPDATE', undefined, { action: 'RELEASED_FOR_DC', bundle_id: bundleId, released, reason }, tx);
  }
  return released;
}
