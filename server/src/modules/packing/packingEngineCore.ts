import type { Request } from 'express';
import { txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest, NotFound, Forbidden } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import {
  bundleAvail, availAt, packingRequiresQc, linkBundlesToCarton, unlinkBundleFromCarton, TERMINAL,
} from '../production/bundleLedger.js';

/**
 * Packing engine core (client "Garment Packing Module Developer Document", 14-Oct-2026).
 *
 *   rule → packing order (trx_packing, is_engine = 1) → polybag / piece entry → carton (trx_carton + content)
 *        → verify → seal → POST (bundle packed_qty + packaging trim stock, one transaction) → packing list / shipment
 *
 * Quantities (per job + style + colour + size):
 *   ready      = Σ bundle "pack" availability (bundleLedger.bundleAvail; Final-QC passed only when
 *                PACKING_REQUIRES_FINAL_QC = 1). Posted cartons already left this number (bundle packed_qty).
 *   reserved   = what OTHER open packing orders (DRAFT / APPROVED / IN_PROGRESS) still hold:
 *                max(planned − posted, unposted carton pieces) per order.
 *   eligible   = ready − reserved  (for this order, including its own unposted cartons)
 *   available  = eligible − this order's unposted (draft / open / verified / sealed) carton pieces
 *
 * Draft and unposted cartons never touch bundle counters or trim stock; only POST does, and only once
 * (carton row lock + is_posted flag + unique (carton, post_seq) consumption rows).
 */

export const OPEN_ORDER = ['DRAFT', 'APPROVED', 'IN_PROGRESS'];
export const WORKING_ORDER = ['APPROVED', 'IN_PROGRESS'];
export const EDITABLE_CARTON = ['DRAFT', 'OPEN'];

const n = (v: unknown) => Number(v ?? 0) || 0;
export const key = (c: unknown, s: unknown) => `${Number(c)}:${Number(s)}`;
export const pct = (actual: number, expected: number) =>
  expected > 0 ? Math.round(((actual - expected) / expected) * 10000) / 100 : (actual > 0 ? 100 : 0);

export function canApprove(req: Request) {
  return !!req.user && (req.user.isSuperAdmin || req.user.permissions.has('PACKING.APPROVE'));
}
export function assertApprove(req: Request, what: string) {
  if (!canApprove(req)) throw Forbidden(`${what} needs the PACKING.APPROVE permission (packing supervisor / manager)`);
}

export async function setting(tx: Tx, cid: number, k: string, dflt: string): Promise<string> {
  const r = await txQueryOne<{ setting_value: string }>(tx,
    `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?`, [cid, k]);
  return String(r?.setting_value ?? dflt).trim();
}

export interface Rule {
  id: number; rule_code: string; rule_name: string; buyer_id: number | null; style_id: number | null; so_id: number | null;
  packing_mode: 'BUNDLE_QUANTITY' | 'INDIVIDUAL_PIECE'; pieces_per_polybag: number; polybag_trim_id: number | null;
  carton_trim_id: number | null; standard_pieces_per_carton: number; allow_mixed_sizes: number; allow_mixed_colours: number;
  allow_partial_carton: number; allow_overpack: number; label_template: string | null; revision: number;
  effective_from: string | null; effective_to: string | null; scope?: string;
}

/** Rule priority PO (job) → Style → Buyer → Company default; active and effective today. */
export async function resolveRule(tx: Tx, cid: number, soId: number, styleId: number | null, buyerId: number | null): Promise<Rule | null> {
  const rows = await txQuery<Rule & { prio: number }>(tx,
    `SELECT r.*,
            CASE WHEN r.so_id IS NOT NULL THEN 1 WHEN r.style_id IS NOT NULL THEN 2 WHEN r.buyer_id IS NOT NULL THEN 3 ELSE 4 END AS prio
       FROM mst_packing_rule r
      WHERE r.company_id = ? AND r.is_active = 1
        AND (r.effective_from IS NULL OR r.effective_from <= CURDATE())
        AND (r.effective_to IS NULL OR r.effective_to >= CURDATE())
        AND (r.so_id IS NULL OR r.so_id = ?)
        AND (r.style_id IS NULL OR r.style_id <=> ?)
        AND (r.buyer_id IS NULL OR r.buyer_id <=> ?)
      ORDER BY prio, (r.style_id IS NOT NULL) DESC, (r.buyer_id IS NOT NULL) DESC, r.id DESC
      LIMIT 1`, [cid, soId, styleId, buyerId]);
  const r = rows[0];
  if (!r) return null;
  r.scope = ['', 'PO / job', 'Style', 'Buyer', 'Company default'][r.prio];
  return r;
}

export function ruleOf(order: any): Rule {
  const raw = order.rule_snapshot;
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!r) throw BadRequest(`Packing order ${order.pack_no} has no packing rule snapshot`);
  return r as Rule;
}

/** Expected cartons for colour × size quantities, honouring the mixed size / colour rule (doc §9). */
export function expectedCartons(lines: { color_id: number; size_id: number; qty: number }[], r: Rule): number {
  const cap = Math.max(n(r.standard_pieces_per_carton), 1);
  const groups = new Map<string, number>();
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    const g = r.allow_mixed_sizes && r.allow_mixed_colours ? 'all'
      : r.allow_mixed_sizes ? `c${l.color_id}` : r.allow_mixed_colours ? `s${l.size_id}` : key(l.color_id, l.size_id);
    groups.set(g, (groups.get(g) ?? 0) + l.qty);
  }
  let total = 0;
  for (const q of groups.values()) total += Math.ceil(q / cap);
  return total;
}
export const stdPolybags = (pieces: number, r: Rule) => Math.ceil(pieces / Math.max(n(r.pieces_per_polybag), 1));

// ─────────────────────────────────────────────────────────── orders

export async function loadOrder(tx: Tx, cid: number, id: number, lock = false) {
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid packing order id');
  const o = await txQueryOne<any>(tx,
    `SELECT p.* FROM trx_packing p WHERE p.id = ? AND p.company_id = ? ${lock ? 'FOR UPDATE' : ''}`, [id, cid]);
  if (!o) throw NotFound('Packing order not found');
  if (!o.is_engine) throw BadRequest(`${o.pack_no} is an old packing record — open it from the packing list screen`);
  return o;
}

/** Serialise everything that reserves / packs one job's garments (orders of the same SO). */
export async function lockJob(tx: Tx, soId: number) {
  await txQueryOne(tx, `SELECT id FROM trx_sales_order WHERE id = ? FOR UPDATE`, [soId]);
}

export interface JobKey { cid: number; io_no: string; style_id: number; part_name?: string | null }

/** Bundles of the job / style (optionally one colour × size), with their pack availability. */
export async function jobBundles(tx: Tx, j: JobKey, colorId?: number | null, sizeId?: number | null) {
  const strict = await packingRequiresQc(tx, j.cid);
  const rows = await txQuery<any>(tx,
    `SELECT cb.* FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      WHERE COALESCE(cb.company_id, c.company_id) = ? AND cb.io_no = ? AND cb.style_id = ?
        ${j.part_name ? 'AND cb.part_name = ?' : ''}
        ${colorId ? 'AND cb.color_id = ?' : ''} ${sizeId ? 'AND cb.size_id = ?' : ''}
        AND cb.status NOT IN ('SPLIT','CANCELLED')
      ORDER BY cb.id`,
    [j.cid, j.io_no, j.style_id, ...(j.part_name ? [j.part_name] : []), ...(colorId ? [colorId] : []), ...(sizeId ? [sizeId] : [])]);
  return rows.map((b) => {
    const a = bundleAvail(b, strict);
    const ready = TERMINAL.includes(b.status) ? 0 : a.pack;
    return { ...b, ready, packed: a.packed, qc_pending: a.qc, finishing_wip: a.finishing_wip, strict };
  });
}

/** Open polybag remainder (bagged, not yet in a posted carton) per bundle, optionally excluding one order. */
export async function openBagged(tx: Tx, bundleIds: number[], exceptOrder?: number | null) {
  const m = new Map<number, number>();
  if (!bundleIds.length) return m;
  const rows = await txQuery<any>(tx,
    `SELECT bundle_id, SUM(pieces - cartoned_qty) q FROM trx_packing_polybag
      WHERE bundle_id IN (?) AND status = 'OPEN' ${exceptOrder ? 'AND packing_id <> ?' : ''} GROUP BY bundle_id`,
    exceptOrder ? [bundleIds, exceptOrder] : [bundleIds]);
  for (const r of rows) m.set(Number(r.bundle_id), n(r.q));
  return m;
}

/** Posted / unposted carton pieces per colour × size of one order (VOID excluded). */
export async function orderCartonQty(tx: Tx, orderId: number, exceptCarton?: number | null) {
  const rows = await txQuery<any>(tx,
    `SELECT cc.color_id, cc.size_id, c.is_posted, SUM(cc.qty) q
       FROM trx_carton c JOIN trx_carton_content cc ON cc.carton_id = c.id
      WHERE c.packing_id = ? AND c.carton_status <> 'VOID' ${exceptCarton ? 'AND c.id <> ?' : ''}
      GROUP BY cc.color_id, cc.size_id, c.is_posted`, exceptCarton ? [orderId, exceptCarton] : [orderId]);
  const posted = new Map<string, number>(); const draft = new Map<string, number>();
  for (const r of rows) {
    const m = Number(r.is_posted) ? posted : draft;
    m.set(key(r.color_id, r.size_id), (m.get(key(r.color_id, r.size_id)) ?? 0) + n(r.q));
  }
  return { posted, draft };
}

/** What other open orders of the same job / style still hold, per colour × size. */
export async function reservedByOthers(tx: Tx, j: JobKey, exceptOrder?: number | null) {
  const others = await txQuery<any>(tx,
    `SELECT id FROM trx_packing WHERE company_id = ? AND is_engine = 1 AND io_no = ? AND style_id = ?
        AND order_status IN ('DRAFT','APPROVED','IN_PROGRESS') ${exceptOrder ? 'AND id <> ?' : ''}`,
    exceptOrder ? [j.cid, j.io_no, j.style_id, exceptOrder] : [j.cid, j.io_no, j.style_id]);
  const res = new Map<string, number>();
  for (const o of others) {
    const lines = await txQuery<any>(tx, `SELECT color_id, size_id, planned_qty FROM trx_packing_order_line WHERE packing_id = ?`, [o.id]);
    const { posted, draft } = await orderCartonQty(tx, o.id);
    const keys = new Set([...lines.map((l) => key(l.color_id, l.size_id)), ...draft.keys()]);
    for (const k of keys) {
      const plan = n(lines.find((l) => key(l.color_id, l.size_id) === k)?.planned_qty);
      const hold = Math.max(plan - (posted.get(k) ?? 0), draft.get(k) ?? 0, 0);
      if (hold) res.set(k, (res.get(k) ?? 0) + hold);
    }
  }
  return res;
}

export interface EligRow {
  color_id: number; size_id: number; color_name?: string; size_code?: string; sort_order?: number; sku_id?: number | null;
  order_qty: number; ready: number; reserved_other: number; eligible: number; planned: number;
  posted: number; draft: number; available: number; balance: number; bagged: number; bagged_open: number; qc_pending: number;
}

/**
 * Colour × size eligibility for a job / style (and for an existing order, its own plan / posted / draft).
 * Used by order creation, carton validation, polybag entry and reconciliation.
 */
export async function eligibility(tx: Tx, j: JobKey, soId: number, orderId?: number | null): Promise<EligRow[]> {
  const bundles = await jobBundles(tx, j);
  const ready = new Map<string, number>(); const qcp = new Map<string, number>();
  for (const b of bundles) {
    const k = key(b.color_id, b.size_id);
    ready.set(k, (ready.get(k) ?? 0) + b.ready);
    qcp.set(k, (qcp.get(k) ?? 0) + (b.strict ? b.qc_pending : 0));
  }
  const orderQty = new Map<string, { q: number; sku: number }>();
  const so = await txQuery<any>(tx,
    `SELECT k.color_id, k.size_id, k.id sku_id, SUM(sk.qty - sk.cancelled_qty) q
       FROM trx_sales_order_line l JOIN trx_sales_order_sku sk ON sk.so_line_id = l.id JOIN mst_style_sku k ON k.id = sk.sku_id
      WHERE l.so_id = ? AND l.style_id = ? ${j.part_name ? 'AND (l.part_name IS NULL OR l.part_name = ?)' : ''}
      GROUP BY k.color_id, k.size_id, k.id`, j.part_name ? [soId, j.style_id, j.part_name] : [soId, j.style_id]);
  for (const r of so) orderQty.set(key(r.color_id, r.size_id), { q: n(r.q), sku: Number(r.sku_id) });
  const reserved = await reservedByOthers(tx, j, orderId);
  let plan = new Map<string, number>(); let posted = new Map<string, number>(); let draft = new Map<string, number>();
  const bagged = new Map<string, number>(); const baggedOpen = new Map<string, number>();
  if (orderId) {
    const lines = await txQuery<any>(tx, `SELECT color_id, size_id, planned_qty FROM trx_packing_order_line WHERE packing_id = ?`, [orderId]);
    plan = new Map(lines.map((l) => [key(l.color_id, l.size_id), n(l.planned_qty)]));
    ({ posted, draft } = await orderCartonQty(tx, orderId));
    const bags = await txQuery<any>(tx,
      `SELECT color_id, size_id, SUM(pieces) p, SUM(CASE WHEN status='OPEN' THEN pieces - cartoned_qty ELSE 0 END) o
         FROM trx_packing_polybag WHERE packing_id = ? AND status <> 'VOID' GROUP BY color_id, size_id`, [orderId]);
    for (const b of bags) { bagged.set(key(b.color_id, b.size_id), n(b.p)); baggedOpen.set(key(b.color_id, b.size_id), n(b.o)); }
  }
  const keys = new Set([...ready.keys(), ...orderQty.keys(), ...plan.keys(), ...posted.keys(), ...draft.keys()]);
  const out: EligRow[] = [];
  for (const k of keys) {
    const [c, s] = k.split(':').map(Number);
    const rdy = ready.get(k) ?? 0; const rsv = reserved.get(k) ?? 0;
    const elig = Math.max(rdy - rsv, 0);
    const pl = plan.get(k) ?? 0; const pst = posted.get(k) ?? 0; const dr = draft.get(k) ?? 0;
    out.push({
      color_id: c, size_id: s, sku_id: orderQty.get(k)?.sku ?? null, order_qty: orderQty.get(k)?.q ?? 0, ready: rdy, reserved_other: rsv,
      eligible: elig, planned: pl, posted: pst, draft: dr, available: Math.max(elig - dr, 0), balance: Math.max(pl - pst, 0),
      bagged: bagged.get(k) ?? 0, bagged_open: baggedOpen.get(k) ?? 0, qc_pending: qcp.get(k) ?? 0,
    });
  }
  if (out.length) {
    const cols = await txQuery<any>(tx, `SELECT id, color_name FROM mst_color WHERE id IN (?)`, [[...new Set(out.map((r) => r.color_id))]]);
    const sizes = await txQuery<any>(tx, `SELECT id, size_code, sort_order FROM mst_size WHERE id IN (?)`, [[...new Set(out.map((r) => r.size_id))]]);
    for (const r of out) {
      r.color_name = cols.find((x) => Number(x.id) === r.color_id)?.color_name ?? `#${r.color_id}`;
      const sz = sizes.find((x) => Number(x.id) === r.size_id);
      r.size_code = sz?.size_code ?? `#${r.size_id}`; r.sort_order = n(sz?.sort_order);
    }
  }
  return out.sort((a, b) => String(a.color_name).localeCompare(String(b.color_name)) || n(a.sort_order) - n(b.sort_order));
}

export const jobKeyOf = (o: any): JobKey => ({ cid: Number(o.company_id), io_no: o.io_no, style_id: Number(o.style_id), part_name: o.part_name || null });

/** Roll posted cartons up onto the order header (packing list / shipment read these totals). */
export async function recalcOrder(tx: Tx, orderId: number) {
  const a = await txQueryOne<any>(tx,
    `SELECT COUNT(*) cartons, COALESCE(SUM(pieces_total),0) q, COALESCE(SUM(net_weight_kg),0) net, COALESCE(SUM(gross_weight_kg),0) gross
       FROM trx_carton WHERE packing_id = ? AND is_posted = 1 AND carton_status <> 'VOID'`, [orderId]);
  await txExecute(tx, `UPDATE trx_packing SET total_cartons = ?, total_qty = ?, net_weight_kg = ?, gross_weight_kg = ?, updated_at = NOW() WHERE id = ?`,
    [n(a?.cartons), n(a?.q), n(a?.net), n(a?.gross), orderId]);
}

// ─────────────────────────────────────────────────────────── cartons

export interface CartonLineIn { color_id: number; size_id: number; qty: number; polybag_qty?: number | null; bundle_id?: number | null }

export async function cartonEvent(tx: Tx, req: Request, c: { id: number; packing_id: number }, type: string, from: string | null, to: string | null,
  reason?: string | null, detail?: unknown) {
  await txExecute(tx,
    `INSERT INTO trx_carton_event (company_id, carton_id, packing_id, event_type, from_status, to_status, reason, detail, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, c.id, c.packing_id, type, from, to, reason ?? null, detail === undefined ? null : JSON.stringify(detail), req.user!.id]);
}

export async function assertPackagingTrim(tx: Tx, cid: number, trimId: number | null | undefined, type: 'POLYBAG' | 'CARTON') {
  if (!trimId) return null;
  const t = await txQueryOne<any>(tx, `SELECT id, trim_code, trim_name, trim_type, is_active, is_deleted, base_uom FROM mst_trim WHERE id = ? AND company_id = ?`, [trimId, cid]);
  if (!t) throw BadRequest(`${type === 'CARTON' ? 'Carton' : 'Polybag'} item #${trimId} not found`);
  if (!t.is_active || t.is_deleted) throw BadRequest(`${t.trim_name} is not an active packaging item`);
  if (t.trim_type !== type) throw BadRequest(`${t.trim_name} is a ${t.trim_type} item — pick a ${type} item from the trims master`);
  return t;
}

/**
 * Validate carton lines against the order rule and availability. `stage`:
 *   save   — while filling (partial allowed even when the rule forbids it)
 *   verify — capacity, partial and mixed rules enforced
 *   post   — as verify, availability re-checked under lock
 */
export async function validateCarton(tx: Tx, order: any, lines: CartonLineIn[], opts: { cartonId?: number | null; stage: 'save' | 'verify' | 'post' }) {
  const r = ruleOf(order);
  if (!lines.length) throw BadRequest('Add at least one colour / size line to the carton');
  const seen = new Set<string>();
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw BadRequest('Pieces must be a positive whole number');
    const k = key(l.color_id, l.size_id);
    if (seen.has(k)) throw BadRequest('The same colour / size is listed twice in the carton — put it on one line');
    seen.add(k);
  }
  const sizes = new Set(lines.map((l) => Number(l.size_id))); const colours = new Set(lines.map((l) => Number(l.color_id)));
  if (sizes.size > 1 && !Number(r.allow_mixed_sizes)) throw BadRequest(`The packing rule (${r.rule_code}) does not allow mixed sizes in one carton`);
  if (colours.size > 1 && !Number(r.allow_mixed_colours)) throw BadRequest(`The packing rule (${r.rule_code}) does not allow mixed colours in one carton`);
  const total = lines.reduce((a, l) => a + l.qty, 0);
  const cap = n(r.standard_pieces_per_carton);
  if (cap && total > cap && !Number(r.allow_overpack)) throw BadRequest(`Carton holds ${total} pcs — capacity is ${cap} and the rule does not allow overpacking`);
  if (opts.stage !== 'save' && cap && total < cap && !Number(r.allow_partial_carton)) {
    throw BadRequest(`Carton holds ${total} of ${cap} pcs — the packing rule (${r.rule_code}) does not allow partial cartons`);
  }

  const elig = await eligibility(tx, jobKeyOf(order), Number(order.so_id), order.id);
  const own = opts.cartonId ? await txQuery<any>(tx,
    `SELECT cc.color_id, cc.size_id, cc.qty, c.is_posted FROM trx_carton_content cc JOIN trx_carton c ON c.id = cc.carton_id
      WHERE cc.carton_id = ? AND c.carton_status <> 'VOID'`, [opts.cartonId]) : [];
  for (const l of lines) {
    const e = elig.find((x) => x.color_id === Number(l.color_id) && x.size_id === Number(l.size_id));
    const label = e ? `${e.color_name} / ${e.size_code}` : `colour #${l.color_id} / size #${l.size_id}`;
    if (!e || !e.planned) throw BadRequest(`${label} is not on packing order ${order.pack_no}`);
    const mine = own.filter((o) => !Number(o.is_posted) && key(o.color_id, o.size_id) === key(l.color_id, l.size_id)).reduce((a, o) => a + n(o.qty), 0);
    const avail = e.available + mine;
    if (l.qty > avail) {
      throw BadRequest(`${label}: only ${avail} pcs eligible to pack (ready ${e.ready}, held by other orders ${e.reserved_other}, in other unposted cartons ${e.draft - mine}) — ${l.qty} entered`);
    }
    if (e.posted + (e.draft - mine) + l.qty > e.planned && !Number(r.allow_overpack)) {
      throw BadRequest(`${label}: ${e.posted + e.draft - mine + l.qty} pcs would exceed the planned ${e.planned} pcs (overpack not allowed by the rule)`);
    }
    if (order.packing_mode === 'INDIVIDUAL_PIECE') {
      const openBag = e.bagged_open - (e.draft - mine);
      if (l.qty > openBag) throw BadRequest(`${label}: only ${Math.max(openBag, 0)} pcs are bagged and not yet in a carton — enter them on the Polybag screen first`);
    }
    if (l.bundle_id) {
      const b = await txQueryOne<any>(tx, `SELECT id, bundle_no, io_no, style_id, color_id, size_id FROM trx_cutting_bundle WHERE id = ?`, [l.bundle_id]);
      if (!b || b.io_no !== order.io_no || Number(b.style_id) !== Number(order.style_id)) throw BadRequest(`Bundle #${l.bundle_id} is not on job ${order.io_no}`);
      if (Number(b.color_id) !== Number(l.color_id) || Number(b.size_id) !== Number(l.size_id)) throw BadRequest(`Bundle ${b.bundle_no} is a different colour / size from the line`);
    }
  }
  const stdBags = lines.reduce((a, l) => a + stdPolybags(l.qty, r), 0);
  return { total, cap, is_partial: cap > 0 && total < cap ? 1 : 0, std_polybags: stdBags, elig };
}

export async function cartonLines(tx: Tx, cartonId: number): Promise<CartonLineIn[]> {
  const rows = await txQuery<any>(tx, `SELECT color_id, size_id, qty, polybag_qty, bundle_id FROM trx_carton_content WHERE carton_id = ? ORDER BY id`, [cartonId]);
  return rows.map((r) => ({ color_id: Number(r.color_id), size_id: Number(r.size_id), qty: n(r.qty), polybag_qty: n(r.polybag_qty), bundle_id: r.bundle_id ? Number(r.bundle_id) : null }));
}

/** Carton may not change once it is dispatched / on a shipment / on a confirmed packing list. */
export async function assertNotDownstream(tx: Tx, c: any) {
  if (c.carton_status === 'DISPATCHED') throw BadRequest(`Carton ${c.carton_no} is dispatched — correct it through a return / reversal on the shipment`);
  const ship = await txQueryOne<any>(tx,
    `SELECT sh.shipment_no FROM trx_shipment_package sp JOIN trx_shipment sh ON sh.id = sp.shipment_id
      WHERE sp.carton_id = ? AND sp.status <> 'CANCELLED' LIMIT 1`, [c.id]);
  if (ship) throw BadRequest(`Carton ${c.carton_no} is on shipment ${ship.shipment_no} — remove it from the shipment first`);
  try {
    const pl = await txQueryOne<any>(tx,
      `SELECT pl.pl_no, pl.status FROM trx_packing_list_carton plc JOIN trx_packing_list pl ON pl.id = plc.packing_list_id
        WHERE plc.carton_id = ? AND pl.status IN ('CONFIRMED','CLOSED') LIMIT 1`, [c.id]);
    if (pl) throw BadRequest(`Carton ${c.carton_no} is on ${String(pl.status).toLowerCase()} packing list ${pl.pl_no}`);
  } catch (e: any) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
}

export async function lockCarton(tx: Tx, cid: number, id: number) {
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid carton id');
  const c = await txQueryOne<any>(tx,
    `SELECT c.* FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id WHERE c.id = ? AND p.company_id = ? FOR UPDATE OF c`, [id, cid]);
  if (!c) throw NotFound('Carton not found');
  return c;
}

// ─────────────────────────────────────────────────────────── packaging stock

/** Take `qty` of a trim from stock lots FIFO (job lots first, then general), recording consumption + ledger. */
async function consumeTrim(tx: Tx, req: Request, order: any, carton: any, seq: number, kind: 'POLYBAG' | 'CARTON', trimId: number, qty: number, stdQty: number, allowNeg: boolean) {
  const cid = req.user!.companyId;
  if (qty <= 0) return [];
  const lots = await txQuery<any>(tx,
    `SELECT ts.*, t.trim_name FROM trx_trim_stock ts JOIN mst_trim t ON t.id = ts.trim_id
      WHERE ts.company_id = ? AND ts.trim_id = ? AND (ts.so_key = ? OR ts.so_key = 0)
        ${order.warehouse_id ? 'AND ts.warehouse_id = ?' : ''}
      ORDER BY (ts.so_key = ?) DESC, ts.id FOR UPDATE OF ts`,
    order.warehouse_id ? [cid, trimId, Number(order.so_id), order.warehouse_id, Number(order.so_id)] : [cid, trimId, Number(order.so_id), Number(order.so_id)]);
  const name = lots[0]?.trim_name ?? (await txQueryOne<any>(tx, `SELECT trim_name FROM mst_trim WHERE id = ?`, [trimId]))?.trim_name ?? `#${trimId}`;
  const free = lots.reduce((a, l) => a + Math.max(n(l.stock_qty) - n(l.allocated_qty), 0), 0);
  if (!lots.length) throw BadRequest(`No stock lot of ${name}${order.warehouse_id ? ' in the packing warehouse' : ''} — receive it (trims GRN) before posting`);
  if (free + 1e-6 < qty && !allowNeg) {
    throw BadRequest(`${name}: ${qty} needed for carton ${carton.carton_no}, only ${Math.round(free * 100) / 100} in stock (negative packaging stock is not allowed — PACKING_ALLOW_NEGATIVE_PACKAGING)`);
  }
  const takes: { lot: any; q: number }[] = [];
  let left = qty;
  for (const l of lots) {
    if (left <= 0) break;
    const q = Math.min(Math.max(n(l.stock_qty) - n(l.allocated_qty), 0), left);
    if (q > 0) { takes.push({ lot: l, q }); left -= q; }
  }
  if (left > 1e-9) {
    const first = takes.find((t) => t.lot.id === lots[0].id);
    if (first) first.q += left; else takes.push({ lot: lots[0], q: left });
  }
  for (const t of takes) {
    await txExecute(tx, `UPDATE trx_trim_stock SET stock_qty = stock_qty - ? WHERE id = ?`, [t.q, t.lot.id]);
    await txExecute(tx,
      `INSERT INTO trx_packing_consumption (company_id, packing_id, carton_id, post_seq, material_kind, trim_id, trim_stock_id, warehouse_id, lot_no, qty, std_qty, uom_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, order.id, carton.id, seq, kind, trimId, t.lot.id, t.lot.warehouse_id, t.lot.internal_lot_no, t.q, stdQty, t.lot.uom_id, req.user!.id]);
    await txExecute(tx,
      `INSERT INTO trx_stock_ledger (company_id, warehouse_id, material_type, trim_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, created_by, so_id)
       VALUES (?,?,'TRIM',?,'PACKING','PACKING_CARTON',?,0,?,?,?,?)`,
      [cid, t.lot.warehouse_id, trimId, carton.id, t.q, t.lot.uom_id, req.user!.id, order.so_id]);
  }
  return takes.map((t) => ({ kind, trim_id: trimId, lot: t.lot.internal_lot_no, qty: t.q }));
}

/** Variance of polybags / cartons for the order if `extra` unposted cartons were posted now. */
export async function orderVariance(tx: Tx, order: any, extraCartonIds: number[] = []) {
  const r = ruleOf(order);
  const cartons = await txQuery<any>(tx,
    `SELECT id, polybag_qty, std_polybag_qty, is_posted FROM trx_carton WHERE packing_id = ? AND carton_status <> 'VOID'`, [order.id]);
  const set = cartons.filter((c) => Number(c.is_posted) || extraCartonIds.includes(Number(c.id)));
  const ids = set.map((c) => Number(c.id));
  const lines = ids.length ? await txQuery<any>(tx,
    `SELECT color_id, size_id, SUM(qty) qty FROM trx_carton_content WHERE carton_id IN (?) GROUP BY color_id, size_id`, [ids]) : [];
  const bagsActual = set.reduce((a, c) => a + n(c.polybag_qty), 0);
  const bagsExpected = set.reduce((a, c) => a + n(c.std_polybag_qty), 0);
  const ctnActual = set.length;
  const ctnExpected = expectedCartons(lines.map((l) => ({ color_id: Number(l.color_id), size_id: Number(l.size_id), qty: n(l.qty) })), r);
  const tol = Number(await setting(tx, Number(order.company_id), 'PACKING_VARIANCE_TOLERANCE_PCT', '2')) || 0;
  const bagPct = pct(bagsActual, bagsExpected); const ctnPct = pct(ctnActual, ctnExpected);
  return {
    tolerance_pct: tol,
    polybags: { expected: bagsExpected, actual: bagsActual, variance: bagsActual - bagsExpected, variance_pct: bagPct },
    cartons: { expected: ctnExpected, actual: ctnActual, variance: ctnActual - ctnExpected, variance_pct: ctnPct },
    beyond_tolerance: Math.abs(bagPct) > tol || Math.abs(ctnPct) > tol,
  };
}

/**
 * Post one carton (doc §10, §16) inside the caller's transaction. Idempotent: an already posted carton
 * is skipped, so a retried / double-clicked post never deducts packaging twice.
 */
export async function postCarton(tx: Tx, req: Request, order: any, cartonId: number) {
  const cid = req.user!.companyId;
  const c = await lockCarton(tx, cid, cartonId);
  if (Number(c.packing_id) !== Number(order.id)) throw BadRequest('Carton is not on this packing order');
  if (Number(c.is_posted)) return { carton_id: c.id, carton_no: c.carton_no, skipped: true };
  if (!['VERIFIED', 'SEALED'].includes(c.carton_status)) throw BadRequest(`Carton ${c.carton_no} is ${c.carton_status} — verify it before posting`);
  if (!WORKING_ORDER.includes(order.order_status)) throw BadRequest(`Packing order ${order.pack_no} is ${order.order_status} — only approved / in-progress orders post`);
  const r = ruleOf(order);
  const lines = await cartonLines(tx, c.id);
  const v = await validateCarton(tx, order, lines, { cartonId: c.id, stage: 'post' });
  if (v.total !== n(c.pieces_total)) throw BadRequest(`Carton ${c.carton_no}: header total ${c.pieces_total} does not match its lines (${v.total})`);
  const polybagTrim = c.polybag_trim_id ?? r.polybag_trim_id; const cartonTrim = c.carton_trim_id ?? r.carton_trim_id;
  if (!cartonTrim) throw BadRequest(`Carton ${c.carton_no} has no carton type (packaging item) — set it before posting`);
  if (n(c.polybag_qty) > 0 && !polybagTrim) throw BadRequest(`Carton ${c.carton_no} has no polybag type — set it before posting`);

  // bundles: chosen bundle first, else bundles this order bagged, else oldest ready bundle
  const jk = jobKeyOf(order);
  const items = new Map<number, number>();
  for (const l of lines) {
    let need = l.qty;
    const bundles = await jobBundles(tx, jk, l.color_id, l.size_id);
    const otherBag = await openBagged(tx, bundles.map((b) => Number(b.id)), order.id);
    const mine = await txQuery<any>(tx,
      `SELECT bundle_id, SUM(pieces - cartoned_qty) q FROM trx_packing_polybag WHERE packing_id = ? AND status = 'OPEN' AND color_id = ? AND size_id = ? GROUP BY bundle_id`,
      [order.id, l.color_id, l.size_id]);
    const mineQ = new Map(mine.map((m) => [Number(m.bundle_id), n(m.q)]));
    const ordered = [...bundles].sort((a, b) =>
      (Number(b.id) === l.bundle_id ? 1 : 0) - (Number(a.id) === l.bundle_id ? 1 : 0)
      || (mineQ.get(Number(b.id)) ? 1 : 0) - (mineQ.get(Number(a.id)) ? 1 : 0) || Number(a.id) - Number(b.id));
    for (const b of ordered) {
      if (need <= 0) break;
      const free = b.ready - (otherBag.get(Number(b.id)) ?? 0) - (items.get(Number(b.id)) ?? 0);
      const q = Math.min(Math.max(free, 0), need);
      if (q > 0) { items.set(Number(b.id), (items.get(Number(b.id)) ?? 0) + q); need -= q; }
    }
    if (need > 0) throw BadRequest(`Carton ${c.carton_no}: ${need} pcs of a colour / size line are no longer ready to pack on any bundle of ${order.io_no}`);
  }
  const link = await linkBundlesToCarton(tx, req, c.id, [...items.entries()].map(([bundle_id, qty]) => ({ bundle_id, qty })));

  // mark this order's polybag entries as cartoned (FIFO per bundle)
  for (const [bundleId, qty] of items) {
    let left = qty;
    const bags = await txQuery<any>(tx,
      `SELECT id, pieces, cartoned_qty FROM trx_packing_polybag WHERE packing_id = ? AND bundle_id = ? AND status = 'OPEN' ORDER BY id FOR UPDATE`, [order.id, bundleId]);
    for (const b of bags) {
      if (left <= 0) break;
      const q = Math.min(n(b.pieces) - n(b.cartoned_qty), left);
      if (q <= 0) continue;
      await txExecute(tx, `UPDATE trx_packing_polybag SET cartoned_qty = cartoned_qty + ?, status = IF(cartoned_qty >= pieces, 'CARTONED', 'OPEN') WHERE id = ?`, [q, b.id]);
      await txExecute(tx, `INSERT INTO trx_packing_polybag_use (polybag_id, carton_id, qty) VALUES (?,?,?)`, [b.id, c.id, q]);
      left -= q;
    }
  }

  // packaging consumption (actual) — once per post_seq
  const allowNeg = (await setting(tx, cid, 'PACKING_ALLOW_NEGATIVE_PACKAGING', '0')) === '1';
  const seq = n(c.post_seq) + 1;
  const used = [
    ...(polybagTrim ? await consumeTrim(tx, req, order, c, seq, 'POLYBAG', Number(polybagTrim), n(c.polybag_qty), n(c.std_polybag_qty), allowNeg) : []),
    ...await consumeTrim(tx, req, order, c, seq, 'CARTON', Number(cartonTrim), 1, 1, allowNeg),
  ];
  await txExecute(tx,
    `UPDATE trx_carton SET is_posted = 1, posted_at = NOW(), posted_by = ?, post_seq = ?, polybag_trim_id = ?, carton_trim_id = ?, updated_at = NOW() WHERE id = ?`,
    [req.user!.id, seq, polybagTrim ?? null, cartonTrim, c.id]);
  await cartonEvent(tx, req, c, 'POST', c.carton_status, c.carton_status, null, { bundles: link.bundles, packaging: used });
  await audit(req, 'trx_carton', c.id, 'UPDATE', { is_posted: 0 }, { is_posted: 1, post_seq: seq, bundles: link.bundles, packaging: used }, tx);
  return { carton_id: c.id, carton_no: c.carton_no, skipped: false, bundles: link.bundles, packaging: used };
}

/** Authorised reversal of a posted carton: packaging back to the same lots, bundles un-packed, polybag entries reopened. */
export async function reverseCarton(tx: Tx, req: Request, c: any, reason: string) {
  if (!Number(c.is_posted)) return { reversed: false };
  await assertNotDownstream(tx, c);
  const cons = await txQuery<any>(tx, `SELECT * FROM trx_packing_consumption WHERE carton_id = ? AND reversed_at IS NULL ORDER BY id FOR UPDATE`, [c.id]);
  for (const k of cons) {
    await txExecute(tx, `UPDATE trx_trim_stock SET stock_qty = stock_qty + ? WHERE id = ?`, [k.qty, k.trim_stock_id]);
    await txExecute(tx, `UPDATE trx_packing_consumption SET reversed_at = NOW(), reversed_by = ?, reverse_reason = ? WHERE id = ?`, [req.user!.id, reason, k.id]);
    await txExecute(tx,
      `INSERT INTO trx_stock_ledger (company_id, warehouse_id, material_type, trim_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, created_by)
       VALUES (?,?,'TRIM',?,'RETURN','PACKING_CARTON_REV',?,?,0,?,?)`,
      [req.user!.companyId, k.warehouse_id, k.trim_id, c.id, k.qty, k.uom_id ?? 1, req.user!.id]);
  }
  const links = await txQuery<any>(tx, `SELECT bundle_id FROM trx_carton_bundle WHERE carton_id = ? ORDER BY bundle_id`, [c.id]);
  for (const l of links) await unlinkBundleFromCarton(tx, req, c.id, Number(l.bundle_id), reason);
  const uses = await txQuery<any>(tx, `SELECT * FROM trx_packing_polybag_use WHERE carton_id = ?`, [c.id]);
  for (const u of uses) {
    await txExecute(tx, `UPDATE trx_packing_polybag SET cartoned_qty = GREATEST(cartoned_qty - ?, 0), status = 'OPEN' WHERE id = ? AND status <> 'VOID'`, [u.qty, u.polybag_id]);
  }
  await txExecute(tx, `DELETE FROM trx_packing_polybag_use WHERE carton_id = ?`, [c.id]);
  await txExecute(tx, `UPDATE trx_carton SET is_posted = 0, posted_at = NULL, posted_by = NULL, updated_at = NOW() WHERE id = ?`, [c.id]);
  await cartonEvent(tx, req, c, 'REVERSE', c.carton_status, c.carton_status, reason, { packaging_returned: cons.map((k) => ({ trim_id: k.trim_id, lot: k.lot_no, qty: Number(k.qty) })), bundles: links.length });
  await audit(req, 'trx_carton', c.id, 'UPDATE', { is_posted: 1 }, { is_posted: 0, reason }, tx);
  return { reversed: true };
}

export { availAt };
