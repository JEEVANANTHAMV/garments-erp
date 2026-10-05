import type { Request } from 'express';
import { query, txQuery, txExecute, type Tx } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { bundleAvail, ironingRequiresChecking } from './bundleLedger.js';

/**
 * Link between Process DCs (job work) and in-house line allocation.
 *
 * A bundle allocated to an in-house line must not silently go out on a DC of
 * the same process: the DC is blocked unless the user asks to release the
 * allocation, and on issue the allocation (and any open daily-plan row for
 * it) is reduced by the PCS that left, so no plan points at pieces that are
 * now with the contractor.
 */
export type LinkProc = 'sewing' | 'checking' | 'ironing' | 'packing';

const T: Record<LinkProc, { alloc: string; allocD: string; plan: string; planD: string; line: string; label: string }> = {
  sewing: { alloc: 'trx_sewing_line_allocation', allocD: 'trx_sewing_line_allocation_detail', plan: 'trx_sewing_daily_plan', planD: 'trx_sewing_daily_plan_detail', line: 'cfg_sewing_line', label: 'sewing' },
  checking: { alloc: 'trx_checking_line_allocation', allocD: 'trx_checking_line_allocation_detail', plan: 'trx_checking_daily_plan', planD: 'trx_checking_daily_plan_detail', line: 'cfg_checking_line', label: 'checking' },
  ironing: { alloc: 'trx_ironing_line_allocation', allocD: 'trx_ironing_line_allocation_detail', plan: 'trx_ironing_daily_plan', planD: 'trx_ironing_daily_plan_detail', line: 'cfg_ironing_line', label: 'ironing' },
  packing: { alloc: 'trx_packing_line_allocation', allocD: 'trx_packing_line_allocation_detail', plan: 'trx_packing_daily_plan', planD: 'trx_packing_daily_plan_detail', line: 'cfg_packing_line', label: 'packing' },
};
const ACTIVE_ALLOC = ['DRAFT', 'SAVED', 'CONFIRMED'];
const OPEN_PLAN = ['DRAFT', 'SAVED', 'CONFIRMED', 'IN_PROGRESS'];
const n = (v: unknown) => Number(v ?? 0) || 0;

/** In-house line process that a DC stage competes with (null = no line planning for it). */
export function linkProcOf(stage: { kind: string; stage_code: string; level: string }): LinkProc | null {
  if (stage.kind === 'SEWING') return 'sewing';
  if (['CHECK', 'CHECKING'].includes(String(stage.stage_code).toUpperCase())) return 'checking';
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
export async function releaseLineAllocation(tx: Tx, req: Request, proc: LinkProc, bundleId: number, qty: number, reason: string, challanId?: number) {
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
      if (challanId) {
        await txExecute(tx,
          `INSERT INTO trx_dc_alloc_release (company_id, challan_id, bundle_id, proc, kind, allocation_detail_id, plan_detail_id, qty) VALUES (?,?,?,?,'PLAN',?,?,?)`,
          [cid, challanId, bundleId, proc, d.id, pd.id, cut]);
      }
      planLeft -= cut;
    }
    if (challanId) {
      await txExecute(tx,
        `INSERT INTO trx_dc_alloc_release (company_id, challan_id, bundle_id, proc, kind, allocation_detail_id, qty) VALUES (?,?,?,?,'ALLOC',?,?)`,
        [cid, challanId, bundleId, proc, d.id, take]);
    }
    released.push({ allocation_no: d.allocation_no, qty: take });
    left -= take;
  }
  if (released.length) {
    await audit(req, t.allocD, bundleId, 'UPDATE', undefined, { action: 'RELEASED_FOR_DC', bundle_id: bundleId, released, reason }, tx);
  }
  return released;
}

// ─────────────────────────────────────────────────────────────────────
// Daily output FROM the DC (client voice note 29-Sep-2026): bundles moving
// from a line to the next process on a Process DC are picked from that
// line's allocation, and issuing the DC is the line's output — no second
// entry in Daily Output.
// ─────────────────────────────────────────────────────────────────────

/** Line process whose output a DC of this stage carries (the process before it). */
export function sourceProcOf(stage: { kind: string; stage_code: string; level: string }): LinkProc | null {
  const code = String(stage.stage_code).toUpperCase();
  if (['CHECK', 'CHECKING', 'WASH', 'WASHING'].includes(code)) return 'sewing';
  if (stage.kind === 'FINISHING') return 'checking';
  if (['PACK', 'PACKING'].includes(code)) return 'ironing';
  return null;
}

export async function lineInfo(tx: Tx | null, cid: number, proc: LinkProc, lineId: number) {
  const sql = `SELECT id, line_code, line_name, is_active FROM ${T[proc].line} WHERE id = ? AND company_id = ?`;
  const rows = tx ? await txQuery<any>(tx, sql, [lineId, cid]) : await query<any>(sql, [lineId, cid]);
  return rows[0] ?? null;
}

/** Open allocation PCS per bundle on one line. */
export async function lineOpenBundles(tx: Tx | null, cid: number, proc: LinkProc, lineId: number) {
  const t = T[proc];
  const sql = `SELECT d.bundle_id, h.allocation_no,
                      SUM(GREATEST(CAST(d.allocated_qty AS SIGNED) - CAST(d.completed_qty AS SIGNED), 0)) AS open_qty
                 FROM ${t.allocD} d JOIN ${t.alloc} h ON h.id = d.allocation_id
                WHERE h.company_id = ? AND h.status = 'CONFIRMED' AND d.status = 'ALLOCATED' AND d.line_id = ?
                GROUP BY d.bundle_id, h.allocation_no`;
  const rows = tx ? await txQuery<any>(tx, sql, [cid, lineId]) : await query<any>(sql, [cid, lineId]);
  const map = new Map<number, { open_qty: number; allocation_no: string }>();
  for (const r of rows) {
    if (n(r.open_qty) <= 0) continue;
    const id = Number(r.bundle_id);
    const cur = map.get(id);
    if (cur) cur.open_qty += n(r.open_qty);
    else map.set(id, { open_qty: n(r.open_qty), allocation_no: r.allocation_no });
  }
  return map;
}

/**
 * Book `qty` PCS of a bundle as output of a line: allocation completed and the
 * open daily-plan rows (plan date up to the DC date, oldest first) achieved.
 */
export async function recordLineOutput(tx: Tx, req: Request, proc: LinkProc, lineId: number, bundleId: number, qty: number, date: string, ref: string) {
  const t = T[proc];
  const cid = req.user!.companyId;
  const rows = await txQuery<any>(tx,
    `SELECT d.* FROM ${t.allocD} d JOIN ${t.alloc} h ON h.id = d.allocation_id
      WHERE h.company_id = ? AND h.status = 'CONFIRMED' AND d.status = 'ALLOCATED' AND d.line_id = ? AND d.bundle_id = ?
      ORDER BY d.id FOR UPDATE`, [cid, lineId, bundleId]);
  let left = qty;
  let booked = 0;
  for (const d of rows) {
    if (left <= 0) break;
    const open = n(d.allocated_qty) - n(d.completed_qty);
    if (open <= 0) continue;
    const take = Math.min(open, left);
    await txExecute(tx,
      `UPDATE ${t.allocD} SET completed_qty = completed_qty + ?, status = IF(completed_qty >= allocated_qty, 'COMPLETED', status) WHERE id = ?`,
      [take, d.id]);
    let planLeft = take;
    const plans = await txQuery<any>(tx,
      `SELECT pd.id, pd.planned_qty, pd.achieved_qty, pd.plan_id FROM ${t.planD} pd JOIN ${t.plan} p ON p.id = pd.plan_id
        WHERE pd.allocation_detail_id = ? AND p.status IN ('CONFIRMED','IN_PROGRESS') AND p.plan_date <= ? AND pd.status <> 'CANCELLED'
        ORDER BY p.plan_date, pd.id FOR UPDATE`, [d.id, date]);
    const touched = new Set<number>();
    for (const pd of plans) {
      if (planLeft <= 0) break;
      const room = n(pd.planned_qty) - n(pd.achieved_qty);
      if (room <= 0) continue;
      const add = Math.min(room, planLeft);
      await txExecute(tx,
        `UPDATE ${t.planD} SET achieved_qty = achieved_qty + ?, status = IF(achieved_qty >= planned_qty, 'COMPLETED', 'IN_PROGRESS') WHERE id = ?`,
        [add, pd.id]);
      touched.add(Number(pd.plan_id));
      planLeft -= add;
    }
    for (const planId of touched) {
      const s1 = await txQuery<any>(tx,
        `SELECT SUM(planned_qty) AS p, SUM(LEAST(achieved_qty, planned_qty)) AS a FROM ${t.planD} WHERE plan_id = ? AND status <> 'CANCELLED'`, [planId]);
      await txExecute(tx, `UPDATE ${t.plan} SET status = ? WHERE id = ? AND status IN ('CONFIRMED','IN_PROGRESS')`,
        [n(s1[0]?.a) >= n(s1[0]?.p) && n(s1[0]?.p) > 0 ? 'COMPLETED' : 'IN_PROGRESS', planId]);
    }
    booked += take;
    left -= take;
  }
  if (booked) await audit(req, t.allocD, bundleId, 'UPDATE', undefined, { action: 'OUTPUT_FROM_DC', line_id: lineId, bundle_id: bundleId, qty: booked, ref }, tx);
  return booked;
}

/**
 * PCS of each bundle out at stitching contractors (issued on an open stitching DC,
 * not yet received back). A stitching DC books them as sewing WIP, so in-house
 * sewing stock must leave them out.
 */
export async function stitchDcPending(tx: Tx | null, cid: number, bundleIds: number[]) {
  const map = new Map<number, number>();
  if (!bundleIds.length) return map;
  const sql = `SELECT jl.bundle_id, SUM(GREATEST(jl.qty - jl.received_qty - jl.rejected_qty - jl.shortage_qty - jl.loss_qty - jl.returned_qty, 0)) AS pending
                 FROM trx_jobwork_challan_line jl
                 JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id
                 JOIN cfg_process_stage ps ON ps.id = jc.stage_id
                WHERE jc.company_id = ? AND jc.status IN ('ISSUED','PARTIAL_RECEIVED')
                  AND UPPER(ps.stage_code) IN ('STITCH','STITCHING','SEW','SEWING') AND jl.bundle_id IN (?)
                GROUP BY jl.bundle_id`;
  const rows = tx ? await txQuery<any>(tx, sql, [cid, bundleIds]) : await query<any>(sql, [cid, bundleIds]);
  for (const r of rows) if (n(r.pending) > 0) map.set(Number(r.bundle_id), n(r.pending));
  return map;
}

/** PCS of a bundle the process can take now (same rule as line allocation stock). */
function readyFor(proc: LinkProc, b: Record<string, any>, strictChecking: boolean) {
  const a = bundleAvail({ ...b, balance_qty: b.balance_qty ?? b.qty });
  switch (proc) {
    case 'sewing': return a.cut + a.sewing_wip;
    case 'checking': return a.checking;
    case 'ironing': return (strictChecking ? a.checked : a.sewn) + a.finishing_wip;
    default: return a.pack;
  }
}

/**
 * DC cancelled: give back to the line allocations (and still-open daily plans)
 * what this DC released — only while the allocation is active and only as many
 * PCS as are free again (PCS allocated elsewhere meanwhile keep that allocation).
 * Call after the DC's stock has been reversed.
 */
export async function restoreLineAllocations(tx: Tx, req: Request, challanId: number) {
  const cid = req.user!.companyId;
  const rows = await txQuery<any>(tx,
    `SELECT * FROM trx_dc_alloc_release WHERE company_id = ? AND challan_id = ? AND status = 'RELEASED' ORDER BY kind, id FOR UPDATE`, [cid, challanId]);
  if (!rows.length) return [];
  const strict = await ironingRequiresChecking(tx, cid);
  const restoredByDetail = new Map<string, number>();
  const out: { proc: string; kind: string; allocation_no?: string; plan_no?: string; qty: number; restored: number; note: string }[] = [];
  const mark = async (r: any, restored: number, note: string) => {
    const status = restored >= n(r.qty) ? 'RESTORED' : restored > 0 ? 'PARTIAL' : 'SKIPPED';
    await txExecute(tx, `UPDATE trx_dc_alloc_release SET restored_qty = ?, status = ?, note = ?, restored_at = NOW() WHERE id = ?`,
      [restored, status, note.slice(0, 255), r.id]);
  };

  for (const r of rows.filter((x) => x.kind === 'ALLOC')) {
    const t = T[r.proc as LinkProc];
    const d = await txQuery<any>(tx,
      `SELECT d.*, h.status AS head_status, h.allocation_no FROM ${t.allocD} d JOIN ${t.alloc} h ON h.id = d.allocation_id WHERE d.id = ? FOR UPDATE`,
      [r.allocation_detail_id]).then((x) => x[0]);
    if (!d) { await mark(r, 0, 'allocation row not found'); continue; }
    if (!ACTIVE_ALLOC.includes(d.head_status)) {
      const note = `allocation ${d.allocation_no} is ${d.head_status} — not restored`;
      await mark(r, 0, note); out.push({ proc: r.proc, kind: 'ALLOC', allocation_no: d.allocation_no, qty: n(r.qty), restored: 0, note }); continue;
    }
    const b = await txQuery<any>(tx, `SELECT * FROM trx_cutting_bundle WHERE id = ? FOR UPDATE`, [r.bundle_id]).then((x) => x[0]);
    const others = await txQuery<any>(tx,
      `SELECT COALESCE(SUM(GREATEST(CAST(d.allocated_qty AS SIGNED) - CAST(d.completed_qty AS SIGNED), 0)), 0) AS open_qty
         FROM ${t.allocD} d JOIN ${t.alloc} h ON h.id = d.allocation_id
        WHERE h.company_id = ? AND h.status IN (?) AND d.status = 'ALLOCATED' AND d.bundle_id = ? AND d.id <> ?`,
      [cid, ACTIVE_ALLOC, r.bundle_id, d.id]).then((x) => n(x[0]?.open_qty));
    const ownOpen = d.status === 'ALLOCATED' ? Math.max(n(d.allocated_qty) - n(d.completed_qty), 0) : 0;
    const atContractor = r.proc === 'sewing' ? (await stitchDcPending(tx, cid, [Number(r.bundle_id)])).get(Number(r.bundle_id)) ?? 0 : 0;
    const free = Math.max(readyFor(r.proc, b ?? {}, strict) - atContractor - others - ownOpen, 0);
    const restore = Math.min(n(r.qty), free);
    if (restore > 0) {
      const allocated = n(d.allocated_qty) + restore;
      await txExecute(tx,
        `UPDATE ${t.allocD} SET allocated_qty = ?, status = ?, remarks = LEFT(CONCAT_WS(' · ', remarks, ?), 255) WHERE id = ?`,
        [allocated, allocated > n(d.completed_qty) ? 'ALLOCATED' : d.status, `${restore} PCS restored (DC cancelled)`, d.id]);
    }
    const note = restore >= n(r.qty) ? 'restored' : restore > 0 ? `only ${restore} PCS free again — the rest is allocated elsewhere` : 'PCS already allocated elsewhere — not restored';
    restoredByDetail.set(`${r.proc}|${d.id}`, restore);
    await mark(r, restore, note);
    out.push({ proc: r.proc, kind: 'ALLOC', allocation_no: d.allocation_no, qty: n(r.qty), restored: restore, note });
  }

  for (const r of rows.filter((x) => x.kind === 'PLAN')) {
    const t = T[r.proc as LinkProc];
    const key = `${r.proc}|${r.allocation_detail_id}`;
    const room = restoredByDetail.get(key) ?? 0;
    const pd = await txQuery<any>(tx,
      `SELECT pd.*, p.status AS plan_status, p.plan_no, p.plan_date >= CURDATE() AS current_plan
         FROM ${t.planD} pd JOIN ${t.plan} p ON p.id = pd.plan_id WHERE pd.id = ? FOR UPDATE`, [r.plan_detail_id]).then((x) => x[0]);
    let restore = 0; let note = '';
    if (!pd) note = 'plan row not found';
    else if (!OPEN_PLAN.includes(pd.plan_status)) note = `plan ${pd.plan_no} is ${pd.plan_status} — not restored`;
    else if (!n(pd.current_plan)) note = `plan ${pd.plan_no} is for a past date — not restored`;
    else if (room <= 0) note = 'allocation not restored, so the plan is not either';
    else {
      restore = Math.min(n(r.qty), room);
      const planned = n(pd.planned_qty) + restore;
      await txExecute(tx, `UPDATE ${t.planD} SET planned_qty = ?, status = ? WHERE id = ?`,
        [planned, n(pd.achieved_qty) >= planned ? 'COMPLETED' : n(pd.achieved_qty) > 0 ? 'IN_PROGRESS' : 'PLANNED', pd.id]);
      restoredByDetail.set(key, room - restore);
      note = restore >= n(r.qty) ? 'restored' : `only ${restore} PCS restored`;
    }
    await mark(r, restore, note);
    out.push({ proc: r.proc, kind: 'PLAN', plan_no: pd?.plan_no, qty: n(r.qty), restored: restore, note });
  }
  await audit(req, 'trx_dc_alloc_release', challanId, 'UPDATE', undefined, { action: 'RESTORED_ON_DC_CANCEL', challan_id: challanId, result: out }, tx);
  return out;
}
