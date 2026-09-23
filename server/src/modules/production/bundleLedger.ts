import type { Request } from 'express';
import { txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { audit } from '../../core/audit.js';

/**
 * Bundle stage ledger (traceability doc §14, §15, §20).
 *
 * A bundle carries one counter per downstream stage. Every stage may only
 * consume what the previous stage produced, and every change happens with
 * the bundle row locked (lockBundle → FOR UPDATE), so two users scanning the
 * same bundle can never double-issue it.
 *
 *   qty ─┬─ balance_qty (cut panels still at cutting)
 *        ├─ out_cut_qty (cut panels out on a print/embroidery DC)
 *        └─ sew_in_qty ─┬─ sewing WIP
 *                       ├─ sew_reject_qty
 *                       └─ sew_good_qty ─┬─ out_sewn_qty (washing DC) / sewn_loss_qty
 *                                        └─ fin_in_qty ─┬─ finishing WIP / fin_reject_qty
 *                                                       └─ fin_good_qty ─┬─ qc_pass / qc_reject
 *                                                                        └─ packed / out_pack / pack_loss
 */

export const COUNTERS = [
  'balance_qty', 'sew_in_qty', 'sew_good_qty', 'sew_reject_qty',
  'fin_in_qty', 'fin_good_qty', 'fin_reject_qty', 'qc_pass_qty', 'qc_reject_qty',
  'packed_qty', 'cut_loss_qty', 'sewn_loss_qty', 'pack_loss_qty',
  'out_cut_qty', 'out_sewn_qty', 'out_pack_qty',
] as const;
export type Counter = typeof COUNTERS[number];
export type Level = 'CUT' | 'SEWN' | 'FIN' | 'PACK';

export interface BundleRow {
  id: number; company_id: number; cutting_id: number; bundle_no: string; barcode: string | null;
  io_no: string | null; style_id: number | null; color_id: number | null; size_id: number | null;
  sku_id: number | null; part_name: string | null; qty: number; status: string;
  allocated_kg: number | null; parent_bundle_id: number | null;
  [k: string]: any;
}

/** Statuses after which a bundle takes no further movement. */
export const TERMINAL = ['SPLIT', 'CANCELLED', 'CLOSED', 'SHIPPED'];

const n = (v: unknown) => Number(v ?? 0) || 0;

/** Whether cartons may only take Final-QC passed PCS (cfg_system_setting). */
export async function packingRequiresQc(tx: Tx, cid: number): Promise<boolean> {
  const row = await txQueryOne<{ setting_value: string }>(tx,
    `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'PACKING_REQUIRES_FINAL_QC'`, [cid]);
  return String(row?.setting_value ?? '0').trim() === '1';
}

/** PCS available at each stage of a bundle. */
export function bundleAvail(b: Record<string, any>, strictQc = false) {
  const qcDone = n(b.qc_pass_qty);
  const packedish = n(b.packed_qty) + n(b.out_pack_qty) + n(b.pack_loss_qty);
  const cut = Math.max(n(b.balance_qty), 0);
  const sewing_wip = Math.max(n(b.sew_in_qty) - n(b.sew_good_qty) - n(b.sew_reject_qty), 0);
  const sewn = Math.max(n(b.sew_good_qty) - n(b.fin_in_qty) - n(b.out_sewn_qty) - n(b.sewn_loss_qty), 0);
  const finishing_wip = Math.max(n(b.fin_in_qty) - n(b.fin_good_qty) - n(b.fin_reject_qty), 0);
  const qc = strictQc
    ? Math.max(n(b.fin_good_qty) - qcDone - n(b.qc_reject_qty), 0)
    // Packed PCS are assumed to come from QC-passed PCS first.
    : Math.max(n(b.fin_good_qty) - qcDone - n(b.qc_reject_qty) - Math.max(packedish - qcDone, 0), 0);
  const pack = strictQc
    ? Math.max(qcDone - packedish, 0)
    : Math.max(n(b.fin_good_qty) - n(b.qc_reject_qty) - packedish, 0);
  const rejected = n(b.cut_loss_qty) + n(b.sew_reject_qty) + n(b.sewn_loss_qty) + n(b.fin_reject_qty)
    + n(b.qc_reject_qty) + n(b.pack_loss_qty);
  const alive = b.status === 'SPLIT' || b.status === 'CLOSED' ? 0 : Math.max(n(b.qty) - rejected, 0);
  return {
    cut, out_cut: n(b.out_cut_qty), sewing_wip, sewn, out_sewn: n(b.out_sewn_qty), finishing_wip,
    qc, pack, out_pack: n(b.out_pack_qty), packed: n(b.packed_qty), rejected, alive,
  };
}

export function availAt(b: Record<string, any>, level: Level, strictQc = false): number {
  const a = bundleAvail(b, strictQc);
  return level === 'CUT' ? a.cut : level === 'SEWN' ? a.sewn : level === 'FIN' ? a.qc : a.pack;
}

/** Status implied by the counters (terminal statuses are kept). */
export function deriveStatus(b: Record<string, any>): string {
  if (TERMINAL.includes(b.status)) return b.status;
  const a = bundleAvail(b);
  if (n(b.packed_qty) > 0 && a.alive > 0 && n(b.packed_qty) >= a.alive) return 'PACKED';
  if (n(b.fin_in_qty) > 0) return 'FINISHING';
  if (n(b.sew_in_qty) > 0) return a.sewing_wip === 0 && a.cut === 0 && a.out_cut === 0 ? 'COMPLETED' : 'IN_SEWING';
  if (n(b.out_cut_qty) > 0) return 'ISSUED';
  return b.status === 'CHECKED' ? 'CHECKED' : 'GENERATED';
}

/**
 * Lock one bundle (by id, barcode or bundle no) for the current company.
 * Barcode/bundle no lookups must be unambiguous.
 */
export async function lockBundle(tx: Tx, cid: number, ref: { id?: number | null; code?: string | null }): Promise<BundleRow> {
  let rows: BundleRow[];
  if (ref.id) {
    rows = await txQuery<BundleRow>(tx,
      `SELECT cb.* FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
        WHERE cb.id = ? AND COALESCE(cb.company_id, c.company_id) = ? FOR UPDATE OF cb`, [ref.id, cid]);
  } else if (ref.code) {
    rows = await txQuery<BundleRow>(tx,
      `SELECT cb.* FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
        WHERE (cb.barcode = ? OR cb.bundle_no = ?) AND COALESCE(cb.company_id, c.company_id) = ?
        ORDER BY (cb.barcode = ?) DESC LIMIT 2 FOR UPDATE OF cb`, [ref.code, ref.code, cid, ref.code]);
    if (rows.length > 1 && rows[0].barcode !== ref.code) {
      throw BadRequest(`Bundle no "${ref.code}" matches more than one bundle — scan the barcode instead`);
    }
  } else {
    throw BadRequest('Bundle id or barcode is required');
  }
  const b = rows[0];
  if (!b) throw NotFound(`Bundle ${ref.code ?? ref.id} not found`);
  if (!b.company_id) {
    await txExecute(tx, `UPDATE trx_cutting_bundle SET company_id = ? WHERE id = ?`, [cid, b.id]);
    b.company_id = cid;
  }
  if (b.balance_qty == null) b.balance_qty = b.qty;
  return b;
}

export function assertActive(b: BundleRow) {
  if (TERMINAL.includes(b.status)) {
    throw BadRequest(`Bundle ${b.bundle_no} is ${b.status} — no further movement allowed`
      + (b.status === 'SPLIT' ? ' (use its child bundles)' : ''));
  }
}

/**
 * Apply counter deltas to a locked bundle, re-derive its status and persist.
 * Throws if any counter would go negative. Returns the updated row.
 */
export async function applyBundle(tx: Tx, b: BundleRow, delta: Partial<Record<Counter, number>>, forceStatus?: string): Promise<BundleRow> {
  const next: BundleRow = { ...b };
  for (const [k, d] of Object.entries(delta)) {
    if (!d) continue;
    next[k] = n(b[k]) + Number(d);
    if (next[k] < 0) throw BadRequest(`Bundle ${b.bundle_no}: ${k.replace(/_/g, ' ')} cannot go below zero`);
  }
  next.status = forceStatus ?? deriveStatus(next);
  const sets = COUNTERS.map((c) => `${c} = ?`).join(', ');
  await txExecute(tx, `UPDATE trx_cutting_bundle SET ${sets}, status = ? WHERE id = ?`,
    [...COUNTERS.map((c) => n(next[c])), next.status, b.id]);
  return next;
}

export interface MovementInput {
  txn_type: string;
  from_stage?: string;
  to_stage?: string;
  qty: number;
  good?: number | null;
  reject?: number | null;
  rework?: number | null;
  location?: string | null;
  work_center?: string | null;
  destination?: string | null;
  ref_table?: string | null;
  ref_id?: number | null;
  remarks?: string | null;
}

/** One trx_bundle_movement row: user, time, location/work centre, quantities, source document. */
export async function addMovement(tx: Tx, req: Request, b: BundleRow, m: MovementInput) {
  await txExecute(tx,
    `INSERT INTO trx_bundle_movement
       (company_id, bundle_id, io_no, style_id, from_stage, to_stage, txn_type, moved_qty,
        good_qty, reject_qty, rework_qty, moved_by, moved_at, destination, location, work_center,
        ref_table, ref_id, remarks)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?,?,?,?,?)`,
    [req.user!.companyId, b.id, b.io_no ?? null, b.style_id ?? null,
     m.from_stage ?? b.status ?? '', m.to_stage ?? b.status ?? '', m.txn_type, Math.max(m.qty, 0),
     m.good ?? null, m.reject ?? null, m.rework ?? null, req.user!.id,
     m.destination ?? null, m.location ?? null, m.work_center ?? null,
     m.ref_table ?? null, m.ref_id ?? null, m.remarks ?? null]);
}

/** Resolve many bundle references (ids and/or codes) to ids, company-scoped, without locking. */
export async function resolveBundleIds(tx: Tx, cid: number, ids: number[] = [], codes: string[] = []): Promise<number[]> {
  const out = new Set<number>(ids);
  for (const code of codes) {
    const rows = await txQuery<{ id: number; barcode: string }>(tx,
      `SELECT cb.id, cb.barcode FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
        WHERE (cb.barcode = ? OR cb.bundle_no = ?) AND COALESCE(cb.company_id, c.company_id) = ?
        ORDER BY (cb.barcode = ?) DESC LIMIT 2`, [code, code, cid, code]);
    if (!rows.length) throw NotFound(`Bundle ${code} not found`);
    if (rows.length > 1 && rows[0].barcode !== code) throw BadRequest(`Bundle no "${code}" is ambiguous — scan the barcode`);
    out.add(rows[0].id);
  }
  // Lock in id order so concurrent multi-bundle documents cannot deadlock.
  return [...out].sort((a, b) => a - b);
}

// ─────────────────────────────────────────────────────────────────────
// Carton ← bundle link (doc §23). Used by POST /cartons/:id/bundles and
// available to the packing module:
//
//   import { linkBundlesToCarton } from '../production/bundleLedger.js';
//   await transaction((tx) => linkBundlesToCarton(tx, req, cartonId, [{ barcode: 'X', qty: 10 }]));
// ─────────────────────────────────────────────────────────────────────
export interface CartonBundleItem { bundle_id?: number | null; barcode?: string | null; qty?: number | null }

export async function linkBundlesToCarton(tx: Tx, req: Request, cartonId: number, items: CartonBundleItem[]) {
  const cid = req.user!.companyId;
  if (!items.length) throw BadRequest('No bundles supplied');
  const carton = await txQueryOne<any>(tx,
    `SELECT ct.*, p.company_id, p.style_id AS pack_style_id, p.pack_no, p.io_no AS pack_io_no
       FROM trx_carton ct JOIN trx_packing p ON p.id = ct.packing_id
      WHERE ct.id = ? AND p.company_id = ? FOR UPDATE OF ct`, [cartonId, cid]);
  if (!carton) throw NotFound('Carton not found');
  const shipped = await txQueryOne<any>(tx,
    `SELECT sp.id FROM trx_shipment_package sp WHERE sp.carton_id = ? AND sp.status IN ('DISPATCHED','DELIVERED') LIMIT 1`, [cartonId]);
  if (shipped) throw BadRequest(`Carton ${carton.carton_no} is already dispatched — it cannot take more bundles`);

  const strict = await packingRequiresQc(tx, cid);
  // Resolve then lock in id order.
  const resolved: { id: number; qty?: number | null }[] = [];
  for (const it of items) {
    const [id] = await resolveBundleIds(tx, cid, it.bundle_id ? [it.bundle_id] : [], it.barcode ? [it.barcode] : []);
    if (!id) throw BadRequest('Each item needs bundle_id or barcode');
    if (resolved.some((r) => r.id === id)) throw BadRequest('The same bundle is listed twice');
    resolved.push({ id, qty: it.qty });
  }
  resolved.sort((a, b) => a.id - b.id);

  const linked: any[] = [];
  for (const r of resolved) {
    const b = await lockBundle(tx, cid, { id: r.id });
    assertActive(b);
    if (carton.pack_style_id && b.style_id && Number(carton.pack_style_id) !== Number(b.style_id)) {
      throw BadRequest(`Bundle ${b.bundle_no} is a different style from packing ${carton.pack_no}`);
    }
    const avail = availAt(b, 'PACK', strict);
    const qty = r.qty ?? avail;
    if (!qty || qty <= 0) {
      throw BadRequest(`Bundle ${b.bundle_no} has no PCS ready to pack`
        + (n(b.packed_qty) ? ` (${n(b.packed_qty)} PCS already packed)` : strict ? ' (Final QC passed PCS required)' : ' (finishing output required)'));
    }
    if (qty > avail) throw BadRequest(`Bundle ${b.bundle_no}: only ${avail} PCS ready to pack, ${qty} requested`);

    await txExecute(tx,
      `INSERT INTO trx_carton_bundle (carton_id, bundle_id, qty, created_by) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)`, [cartonId, b.id, qty, req.user!.id]);
    const after = await applyBundle(tx, b, { packed_qty: qty });
    await addMovement(tx, req, b, {
      txn_type: 'PACK', from_stage: b.status, to_stage: after.status, qty, good: qty,
      destination: carton.carton_no, location: carton.pack_no, ref_table: 'trx_carton', ref_id: cartonId,
    });
    linked.push({ bundle_id: b.id, bundle_no: b.bundle_no, qty, status: after.status });
  }
  await audit(req, 'trx_carton_bundle', cartonId, 'INSERT', undefined, linked, tx);
  return { carton_id: cartonId, carton_no: carton.carton_no, bundles: linked };
}

/** Reverse a carton ← bundle link (unpack) while the carton is not dispatched. */
export async function unlinkBundleFromCarton(tx: Tx, req: Request, cartonId: number, bundleId: number, reason: string) {
  const cid = req.user!.companyId;
  const carton = await txQueryOne<any>(tx,
    `SELECT ct.*, p.pack_no FROM trx_carton ct JOIN trx_packing p ON p.id = ct.packing_id
      WHERE ct.id = ? AND p.company_id = ? FOR UPDATE OF ct`, [cartonId, cid]);
  if (!carton) throw NotFound('Carton not found');
  const shipped = await txQueryOne<any>(tx,
    `SELECT id FROM trx_shipment_package WHERE carton_id = ? AND status IN ('DISPATCHED','DELIVERED') LIMIT 1`, [cartonId]);
  if (shipped) throw BadRequest(`Carton ${carton.carton_no} is already dispatched`);
  const link = await txQueryOne<any>(tx,
    `SELECT * FROM trx_carton_bundle WHERE carton_id = ? AND bundle_id = ? FOR UPDATE`, [cartonId, bundleId]);
  if (!link) throw NotFound('Bundle is not in this carton');
  const b = await lockBundle(tx, cid, { id: bundleId });
  await txExecute(tx, `DELETE FROM trx_carton_bundle WHERE id = ?`, [link.id]);
  const after = await applyBundle(tx, b, { packed_qty: -Number(link.qty) });
  await addMovement(tx, req, b, {
    txn_type: 'UNPACK', from_stage: b.status, to_stage: after.status, qty: Number(link.qty),
    destination: carton.carton_no, ref_table: 'trx_carton', ref_id: cartonId, remarks: reason,
  });
  await audit(req, 'trx_carton_bundle', link.id, 'DELETE', link, { reason }, tx);
  return { carton_id: cartonId, bundle_id: bundleId, qty: Number(link.qty), status: after.status };
}
