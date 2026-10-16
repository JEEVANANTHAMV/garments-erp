import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { lockBundle, applyBundle, addMovement, bundleAvail, packingRequiresQc, TERMINAL } from './bundleLedger.js';

/**
 * FG receipt — the gate into packing (client call 16-Oct-2026):
 *   "whatever we make — in-house bundles or garments back from job work — only after the FG receipt entry
 *    does it come to packing; then the FG store stock (qty and value) is right automatically."
 *
 * A receipt is posted when it is saved (status RECEIVED, fg_posted = 1):
 *   • IN_HOUSE  PCS from the job's bundles that finished ironing (Final QC passed when PACKING_REQUIRES_FINAL_QC):
 *               good + reject ≤ the bundles' ready PCS; good → bundle fg_qty, reject → bundle pack_loss_qty.
 *   • JOB_WORK / RETURN  garments with no bundles here: good ≤ order qty × (1 + FG_RECEIPT_OVER_ORDER_PCT) − received.
 *   • SURPLUS   extra pieces; colour / size must still be on the order.
 *   Every good PC goes into the FG store: trx_stock_ledger FINISHED qty in (sku, job, ₹ standard cost = the
 *   style's approved pre-costing cost / PC), so the Stock Statement and stock enquiry show FG qty and value.
 * Packing (PACKING_FROM_FG_RECEIPT = 1) packs only FG-store PCS: FG on hand = received − packed from FG.
 * A receipt is never edited; it is cancelled (reversed) while its PCS are still in the store, and re-entered.
 */
export const fgReceiptRouter = Router();
const n = (v: unknown) => Number(v ?? 0) || 0;
const k = (c: unknown, sz: unknown) => `${Number(c)}:${Number(sz)}`;

export async function fgMode(tx: Tx | null, cid: number): Promise<boolean> {
  const sql = `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'PACKING_FROM_FG_RECEIPT'`;
  const r = tx ? await txQueryOne<any>(tx, sql, [cid]) : await queryOne<any>(sql, [cid]);
  return String(r?.setting_value ?? '1').trim() !== '0';
}

/** The job (sales order) of an IO no — io_no, or the SO no when the order has no separate IO no. */
async function jobOf(tx: Tx | null, cid: number, ioNo: string) {
  const sql = `SELECT id, so_no, io_no, buyer_id FROM trx_sales_order WHERE company_id = ? AND is_deleted = 0
                 AND (io_no = ? OR (COALESCE(io_no, '') = '' AND so_no = ?)) ORDER BY id DESC LIMIT 1`;
  return tx ? txQueryOne<any>(tx, sql, [cid, ioNo, ioNo]) : queryOne<any>(sql, [cid, ioNo, ioNo]);
}

/** Part key: TOP / BOTTOM … or '' for a job whose lines carry no part. */
export const pk = (part: unknown, c: unknown, sz: unknown) => `${String(part ?? '').toUpperCase()}|${Number(c)}:${Number(sz)}`;

/**
 * FG stock of a job / style per part × colour × size: received (posted receipts, not cancelled) and taken by cartons
 * posted from the FG store (trx_carton_fg_use — a set takes a TOP and a BOTTOM).
 */
export async function fgStockParts(tx: Tx | null, cid: number, ioNo: string, styleId: number, exceptReceipt?: number | null) {
  const run = <T,>(sql: string, p: unknown[]) => (tx ? txQuery<T>(tx, sql, p) : query<T>(sql, p));
  const rec = await run<any>(
    `SELECT l.part_name, l.color_id, l.size_id, SUM(l.good_qty) q FROM trx_fg_receipt r JOIN trx_fg_receipt_line l ON l.fg_receipt_id = r.id
      WHERE r.company_id = ? AND r.io_no = ? AND r.style_id = ? AND r.fg_posted = 1 AND r.status <> 'CANCELLED' ${exceptReceipt ? 'AND r.id <> ?' : ''}
      GROUP BY l.part_name, l.color_id, l.size_id`, exceptReceipt ? [cid, ioNo, styleId, exceptReceipt] : [cid, ioNo, styleId]);
  const used = await run<any>(
    `SELECT u.part_name, u.color_id, u.size_id, SUM(u.qty) q FROM trx_carton_fg_use u JOIN trx_carton c ON c.id = u.carton_id JOIN trx_packing p ON p.id = u.packing_id
      WHERE p.company_id = ? AND p.io_no = ? AND p.style_id = ? AND c.is_posted = 1 AND c.from_fg = 1 AND c.carton_status <> 'VOID'
      GROUP BY u.part_name, u.color_id, u.size_id`, [cid, ioNo, styleId]);
  const out = new Map<string, { received: number; packed: number; on_hand: number }>();
  for (const r of rec) out.set(pk(r.part_name, r.color_id, r.size_id), { received: n(r.q), packed: 0, on_hand: n(r.q) });
  for (const u of used) {
    const key = pk(u.part_name, u.color_id, u.size_id);
    const cur = out.get(key) ?? { received: 0, packed: 0, on_hand: 0 };
    cur.packed += n(u.q); cur.on_hand = Math.max(cur.received - cur.packed, 0);
    out.set(key, cur);
  }
  return out;
}

/**
 * FG stock per colour × size — all parts summed (part undefined), or of one part (lines with no part count for any part).
 */
export async function fgOnHand(tx: Tx | null, cid: number, ioNo: string, styleId: number, exceptReceipt?: number | null, part?: string | null) {
  const parts = await fgStockParts(tx, cid, ioNo, styleId, exceptReceipt);
  const want = part === undefined ? null : String(part ?? '').toUpperCase();
  const out = new Map<string, { received: number; packed: number; on_hand: number }>();
  for (const [key, v] of parts) {
    const [p, cs] = key.split('|');
    if (want !== null && p !== want && p !== '') continue;
    const cur = out.get(cs) ?? { received: 0, packed: 0, on_hand: 0 };
    cur.received += v.received; cur.packed += v.packed; cur.on_hand = Math.max(cur.received - cur.packed, 0);
    out.set(cs, cur);
  }
  return out;
}

/**
 * PCS bagged (open polybag entries, not yet in a posted carton) per part × colour × size of a job / style.
 * A set's bag holds its TOP (the set's colour) and its BOTTOM (the paired colour).
 */
export async function openBagsByPart(tx: Tx, cid: number, ioNo: string, styleId: number) {
  const rows = await txQuery<any>(tx,
    `SELECT pb.packing_id, p.packing_unit, p.part_name, pb.color_id, pb.size_id, SUM(pb.pieces - pb.cartoned_qty) q
       FROM trx_packing_polybag pb JOIN trx_packing p ON p.id = pb.packing_id
      WHERE p.company_id = ? AND p.io_no = ? AND p.style_id = ? AND pb.status = 'OPEN'
      GROUP BY pb.packing_id, p.packing_unit, p.part_name, pb.color_id, pb.size_id`, [cid, ioNo, styleId]);
  const sets = rows.some((x) => x.packing_unit === 'SET')
    ? await txQuery<any>(tx, `SELECT * FROM trx_packing_set WHERE packing_id IN (?)`, [[...new Set(rows.filter((x) => x.packing_unit === 'SET').map((x) => x.packing_id))]])
    : [];
  const out = new Map<string, number>();
  const add = (key: string, q: number) => out.set(key, (out.get(key) ?? 0) + q);
  for (const x of rows) {
    if (x.packing_unit === 'SET') {
      const d = sets.find((y) => Number(y.packing_id) === Number(x.packing_id) && Number(y.top_color_id) === Number(x.color_id));
      add(pk(d?.top_part ?? 'TOP', x.color_id, x.size_id), n(x.q));
      if (d) add(pk(d.bottom_part, d.bottom_color_id, x.size_id), n(x.q));
    } else add(pk(x.part_name, x.color_id, x.size_id), n(x.q));
  }
  return out;
}

/** In-house PCS ready to receive (finished, not yet in the store / packed), per part × colour × size, with their bundles. */
async function bundlesReady(tx: Tx | null, cid: number, ioNo: string, styleId: number) {
  const strict = tx ? await packingRequiresQc(tx, cid) : String((await queryOne<any>(
    `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'PACKING_REQUIRES_FINAL_QC'`, [cid]))?.setting_value ?? '0').trim() === '1';
  const sql = `SELECT cb.* FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      WHERE COALESCE(cb.company_id, c.company_id) = ? AND cb.io_no = ? AND cb.style_id = ? AND cb.status NOT IN ('SPLIT','CANCELLED') ORDER BY cb.id`;
  const rows = tx ? await txQuery<any>(tx, sql, [cid, ioNo, styleId]) : await query<any>(sql, [cid, ioNo, styleId]);
  const ready = new Map<string, number>();
  for (const b of rows) {
    const a = TERMINAL.includes(b.status) ? 0 : bundleAvail(b, strict).pack;
    if (a > 0) ready.set(pk(b.part_name, b.color_id, b.size_id), (ready.get(pk(b.part_name, b.color_id, b.size_id)) ?? 0) + a);
  }
  return { ready, bundles: rows, strict };
}

/** Standard cost / PC of a style for FG valuation: its latest approved pre-costing (₹), else 0. */
async function stdCost(tx: Tx, cid: number, styleId: number) {
  const c = await txQueryOne<any>(tx,
    `SELECT c.total_cost FROM trx_costing c LEFT JOIN cfg_status st ON st.id = c.status_id
      WHERE c.company_id = ? AND c.style_id = ? AND c.is_deleted = 0 AND c.costing_type = 'PRE_COSTING' AND st.code = 'APPROVED'
      ORDER BY c.approved_at DESC, c.version DESC, c.id DESC LIMIT 1`, [cid, styleId]);
  return Math.round(n(c?.total_cost) * 10000) / 10000;
}

/**
 * The job's FG receipt grid for one style: every colour × size of the order (sales order SKUs; bundles of the job
 * for colours / sizes cut beyond the order), with order qty, received, in-house ready, packed and on hand.
 */
export async function fgJobInfo(cid: number, ioNo: string, styleId?: number | null) {
  const so = await jobOf(null, cid, ioNo);
  const styles = so ? await query<any>(
    `SELECT DISTINCT st.id, st.style_code, st.style_name FROM trx_sales_order_line l JOIN mst_style st ON st.id = l.style_id WHERE l.so_id = ? ORDER BY st.style_code`, [so.id])
    : await query<any>(
      `SELECT DISTINCT st.id, st.style_code, st.style_name FROM trx_cutting_bundle cb JOIN mst_style st ON st.id = cb.style_id WHERE cb.company_id = ? AND cb.io_no = ?`, [cid, ioNo]);
  if (!so && !styles.length) throw BadRequest(`Job ${ioNo} not found (no sales order or cutting with that IO no)`);
  const sid = styleId ?? (styles.length === 1 ? Number(styles[0].id) : null);
  if (sid && !styles.some((x) => Number(x.id) === sid)) throw BadRequest('The style is not on this job — pick a style of the job');
  const base = { io_no: ioNo, so_id: so ? Number(so.id) : null, so_no: so?.so_no ?? null, styles, style_id: sid };
  if (!sid) return { ...base, parts: [], colors: [], sizes: [], cells: [] };

  // order qty per part (the sales order line carries the part: TOP / BOTTOM of a set are separate lines)
  const order = so ? await query<any>(
    `SELECT l.part_name, k.color_id, k.size_id, k.id sku_id, SUM(sk.qty - sk.cancelled_qty) q
       FROM trx_sales_order_line l JOIN trx_sales_order_sku sk ON sk.so_line_id = l.id JOIN mst_style_sku k ON k.id = sk.sku_id
      WHERE l.so_id = ? AND l.style_id = ? GROUP BY l.part_name, k.color_id, k.size_id, k.id`, [so.id, sid]) : [];
  const { ready } = await bundlesReady(null, cid, ioNo, sid);
  const fg = await fgStockParts(null, cid, ioNo, sid);
  const keys = new Set<string>([...order.map((o) => pk(o.part_name, o.color_id, o.size_id)), ...ready.keys(), ...fg.keys()]);
  const split = (key: string) => { const [p, cs] = key.split('|'); const [c, sz] = cs.split(':').map(Number); return { p, c, sz }; };
  const cIds = [...new Set([...keys].map((x) => split(x).c))];
  const sIds = [...new Set([...keys].map((x) => split(x).sz))];
  const parts = [...new Set([...keys].map((x) => split(x).p))].sort((a, b) => (a === 'TOP' ? -1 : b === 'TOP' ? 1 : a.localeCompare(b)));
  const colors = cIds.length ? await query<any>(`SELECT id, color_code, color_name FROM mst_color WHERE id IN (?) ORDER BY color_name`, [cIds]) : [];
  const sizes = sIds.length ? await query<any>(`SELECT id, size_code, size_label, sort_order FROM mst_size WHERE id IN (?) ORDER BY sort_order, id`, [sIds]) : [];
  const skus = await query<any>(`SELECT id, color_id, size_id FROM mst_style_sku WHERE style_id = ?`, [sid]);
  const cells = [...keys].map((key) => {
    const { p, c, sz } = split(key);
    // an order line with no part matches a bundle part of the same colour / size (single-part jobs)
    const o = order.find((x) => pk(x.part_name, x.color_id, x.size_id) === key)
      ?? (p ? order.find((x) => !x.part_name && Number(x.color_id) === c && Number(x.size_id) === sz) : undefined);
    const f = fg.get(key);
    return {
      part_name: p || null, color_id: c, size_id: sz, sku_id: o?.sku_id ?? skus.find((x) => Number(x.color_id) === c && Number(x.size_id) === sz)?.id ?? null,
      order_qty: n(o?.q), on_order: !!o, received: f?.received ?? 0, packed: f?.packed ?? 0, on_hand: f?.on_hand ?? 0,
      in_house_ready: ready.get(key) ?? 0,
    };
  });
  // a part key '' next to real parts is only an order line without a part: fold it into the matching part cells
  const real = parts.filter((x) => x);
  const out = real.length ? cells.filter((c) => c.part_name || !cells.some((x) => x.part_name && x.color_id === c.color_id && x.size_id === c.size_id)) : cells;
  return { ...base, parts: parts.filter((x) => x || !real.length).map((x) => x || null), colors, sizes, cells: out };

}

const lineSchema = z.object({
  // TOP / BOTTOM … (a set's parts are received separately, paired at packing); optional on a single-part job
  part_name: z.string().trim().toUpperCase().max(20).nullish(),
  color_id: s.idReq(), size_id: s.idReq(),
  good_qty: z.coerce.number().int().min(0).default(0),
  reject_qty: z.coerce.number().int().min(0).default(0),
  batch_no: s.nullableStr(40),
});
const receiptSchema = z.object({
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.strReq(40),
  style_id: s.idReq(),
  source_type: z.enum(['IN_HOUSE', 'JOB_WORK', 'RETURN', 'SURPLUS']).default('IN_HOUSE'),
  warehouse_id: s.idReq(),
  source_ref: s.nullableStr(60),
  prod_order_id: s.id(),
  remarks: s.text(),
  lines: z.array(lineSchema).default([]),
});
type ReceiptIn = z.infer<typeof receiptSchema>;

/**
 * Post an FG receipt (inside the caller's transaction). Also used by the job-work inward (source JOB_WORK),
 * so garments back from a job-work order reach packing the same way.
 */
export async function postFgReceipt(tx: Tx, req: Request, b: ReceiptIn & { source_stage?: string; so_id?: number | null; no_order_cap?: boolean }) {
  const cid = req.user!.companyId;
  const lines = b.lines.filter((l) => l.good_qty > 0 || l.reject_qty > 0);
  if (!lines.length) throw BadRequest('Enter the good / reject PCS of at least one colour / size');
  const wh = await txQueryOne<any>(tx, `SELECT id, warehouse_name FROM mst_warehouse WHERE id = ? AND company_id = ?`, [b.warehouse_id, cid]);
  if (!wh) throw BadRequest('FG store (warehouse) not found');
  const so = await jobOf(tx, cid, b.io_no);
  if (so) await txQueryOne(tx, `SELECT id FROM trx_sales_order WHERE id = ? FOR UPDATE`, [so.id]); // one job's receipts / packing in turn
  const info = await fgJobInfo(cid, b.io_no, b.style_id);
  const jobParts = (info.parts ?? []).filter((x): x is string => !!x);
  // the part of each line: as sent, else the job's only part; a job with TOP and BOTTOM needs it on every line
  for (const l of lines) {
    if (l.part_name && !jobParts.includes(l.part_name)) throw BadRequest(`Part ${l.part_name} is not on job ${b.io_no} (${jobParts.join(' / ') || 'no parts'})`);
    if (!l.part_name) {
      if (jobParts.length > 1) throw BadRequest(`Job ${b.io_no} has ${jobParts.join(' and ')} — give the part of every line (TOP and BOTTOM are received separately)`);
      l.part_name = jobParts[0] ?? null;
    }
  }
  const seen = new Set<string>();
  for (const l of lines) { const key = pk(l.part_name, l.color_id, l.size_id); if (seen.has(key)) throw BadRequest('A part / colour / size is entered twice'); seen.add(key); }
  const cellOf = (l: { part_name?: string | null; color_id: number; size_id: number }) =>
    info.cells.find((c) => String(c.part_name ?? '') === String(l.part_name ?? '') && c.color_id === l.color_id && c.size_id === l.size_id);
  const label = (l: { part_name?: string | null; color_id: number; size_id: number }) =>
    `${l.part_name ? `${l.part_name} ` : ''}${info.colors.find((c: any) => Number(c.id) === l.color_id)?.color_name ?? `colour #${l.color_id}`} / ${info.sizes.find((z2: any) => Number(z2.id) === l.size_id)?.size_code ?? `size #${l.size_id}`}`;
  for (const l of lines) {
    const c = cellOf(l);
    if (!c || (!c.on_order && b.source_type !== 'IN_HOUSE' && !c.in_house_ready)) throw BadRequest(`${label(l)} is not on job ${b.io_no} for this style`);
  }

  const no = await nextDocNumber(tx, cid, 'FG_RECEIPT');
  const good = lines.reduce((a, l) => a + l.good_qty, 0), rej = lines.reduce((a, l) => a + l.reject_qty, 0);
  const r = await txExecute(tx,
    `INSERT INTO trx_fg_receipt (company_id, receipt_no, receipt_date, io_no, so_id, prod_order_id, style_id, warehouse_id, source_stage, source_type,
                                 source_ref, total_qty, total_reject, status, fg_posted, remarks, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'RECEIVED',1,?,?)`,
    [cid, no, b.receipt_date, b.io_no, so?.id ?? b.so_id ?? null, b.prod_order_id ?? null, b.style_id, b.warehouse_id,
     b.source_stage ?? b.source_type, b.source_type, b.source_ref ?? null, good, rej, b.remarks ?? null, req.user!.id]);
  const id = Number(r.insertId);
  const bundleRows: { line: (typeof lines)[number]; bundle_id: number; good: number; reject: number }[] = [];
  if (b.source_type === 'IN_HOUSE') {
    const { bundles, strict } = await bundlesReady(tx, cid, b.io_no, b.style_id);
    for (const l of lines) {
      const mine = bundles.filter((x) => Number(x.color_id) === l.color_id && Number(x.size_id) === l.size_id
        && (!l.part_name || String(x.part_name ?? '').toUpperCase() === l.part_name));
      let good = l.good_qty; let rej = l.reject_qty;
      const ready = mine.reduce((a, x) => a + (TERMINAL.includes(x.status) ? 0 : bundleAvail(x, strict).pack), 0);
      if (good + rej > ready) {
        throw BadRequest(`${label(l)}: only ${ready} PCS have finished ${strict ? 'Final QC' : 'ironing'} and are not yet in the FG store — ${good + rej} entered`);
      }
      for (const bx of mine) {
        if (good + rej <= 0) break;
        const locked = await lockBundle(tx, cid, { id: Number(bx.id) });
        const avail = TERMINAL.includes(locked.status) ? 0 : bundleAvail(locked, strict).pack;
        const g = Math.min(avail, good); const r = Math.min(avail - g, rej);
        if (g + r <= 0) continue;
        const after = await applyBundle(tx, locked, { fg_qty: g, pack_loss_qty: r });
        await addMovement(tx, req, locked, {
          txn_type: 'FG_RECEIPT', from_stage: locked.status, to_stage: after.status, qty: g + r, good: g, reject: r,
          destination: wh.warehouse_name, ref_table: 'trx_fg_receipt', ref_id: id, remarks: `Received into the FG store (${no})`,
        });
        bundleRows.push({ line: l, bundle_id: Number(bx.id), good: g, reject: r });
        good -= g; rej -= r;
      }
      if (good + rej > 0) throw BadRequest(`${label(l)}: ${good + rej} PCS could not be taken from the job's bundles`);
    }
  } else if (b.source_type !== 'SURPLUS' && !b.no_order_cap) {
    const pctRow = await txQueryOne<any>(tx, `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'FG_RECEIPT_OVER_ORDER_PCT'`, [cid]);
    const pct = n(pctRow?.setting_value ?? 5);
    for (const l of lines) {
      const c = cellOf(l)!;
      const cap = Math.floor(c.order_qty * (1 + pct / 100));
      if (c.received + l.good_qty > cap) {
        throw BadRequest(`${label(l)}: order ${c.order_qty} PCS (+${pct}% = ${cap}), already received ${c.received} — ${l.good_qty} more is over the order. Use source "Surplus" for extra pieces.`);
      }
    }
  }

  const rate = await stdCost(tx, cid, b.style_id);
  const pcs = await txQueryOne<any>(tx, `SELECT id FROM cfg_uom WHERE code IN ('PCS','PC','NOS') ORDER BY FIELD(code,'PCS','PC','NOS') LIMIT 1`);
  for (const l of lines) {
    const c = cellOf(l)!;
    const lr = await txExecute(tx,
      `INSERT INTO trx_fg_receipt_line (fg_receipt_id, part_name, color_id, size_id, sku_id, good_qty, reject_qty, batch_no) VALUES (?,?,?,?,?,?,?,?)`,
      [id, l.part_name ?? null, l.color_id, l.size_id, c.sku_id, l.good_qty, l.reject_qty, l.batch_no ?? null]);
    for (const br of bundleRows.filter((x) => x.line === l)) {
      await txExecute(tx, `INSERT INTO trx_fg_receipt_bundle (fg_receipt_id, line_id, bundle_id, good_qty, reject_qty) VALUES (?,?,?,?,?)`,
        [id, lr.insertId, br.bundle_id, br.good, br.reject]);
    }
    if (l.good_qty > 0) {
      await txExecute(tx,
        `INSERT INTO trx_stock_ledger (company_id, warehouse_id, material_type, sku_id, color_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate, so_id, created_by)
         VALUES (?,?,'FINISHED',?,?,'PRODUCTION_IN','FG_RECEIPT',?,?,0,?,?,?,?)`,
        [cid, b.warehouse_id, c.sku_id, l.color_id, id, l.good_qty, pcs?.id ?? 1, rate, so?.id ?? null, req.user!.id]);
    }
  }
  await audit(req, 'trx_fg_receipt', id, 'INSERT', undefined, { receipt_no: no, io_no: b.io_no, source: b.source_type, good, reject: rej, bundles: bundleRows.length }, tx);
  return { id, receipt_no: no };
}

async function loadReceipt(cid: number, id: number) {
  const row = await queryOne<any>(
    `SELECT fg.*, st.style_code, st.style_name, so.so_no, wh.warehouse_name, u.full_name AS created_by_name
       FROM trx_fg_receipt fg LEFT JOIN mst_style st ON st.id = fg.style_id LEFT JOIN trx_sales_order so ON so.id = fg.so_id
       LEFT JOIN mst_warehouse wh ON wh.id = fg.warehouse_id LEFT JOIN mst_user u ON u.id = fg.created_by
      WHERE fg.id = ? AND fg.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('FG receipt not found');
  const lines = await query<any>(
    `SELECT l.*, col.color_name, sz.size_code, sz.sort_order, k.sku_code FROM trx_fg_receipt_line l
       LEFT JOIN mst_color col ON col.id = l.color_id LEFT JOIN mst_size sz ON sz.id = l.size_id LEFT JOIN mst_style_sku k ON k.id = l.sku_id
      WHERE l.fg_receipt_id = ? ORDER BY col.color_name, sz.sort_order`, [id]);
  const bundles = await query<any>(
    `SELECT rb.*, cb.bundle_no FROM trx_fg_receipt_bundle rb JOIN trx_cutting_bundle cb ON cb.id = rb.bundle_id WHERE rb.fg_receipt_id = ? ORDER BY rb.id`, [id]);
  return { ...row, lines, bundles };
}

/** GET /fg-receipts — register */
fgReceiptRouter.get('/fg-receipts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const qp = z.object({ io_no: z.string().trim().max(40).optional(), status: z.string().trim().max(20).optional() }).parse(req.query);
  const where = ['fg.company_id = ?']; const p: unknown[] = [cid];
  if (qp.io_no) { where.push('fg.io_no = ?'); p.push(qp.io_no); }
  if (qp.status) { where.push('fg.status = ?'); p.push(qp.status); }
  const rows = await query(
    `SELECT fg.*, st.style_code, st.style_name, so.so_no, wh.warehouse_name
       FROM trx_fg_receipt fg LEFT JOIN mst_style st ON st.id = fg.style_id LEFT JOIN trx_sales_order so ON so.id = fg.so_id
       LEFT JOIN mst_warehouse wh ON wh.id = fg.warehouse_id
      WHERE ${where.join(' AND ')} ORDER BY fg.receipt_date DESC, fg.id DESC LIMIT 1000`, p);
  res.json({ data: rows });
}));

/** GET /fg-receipts/job-info?io_no=&style_id= — the size-wise grid of a job / style (order colours & sizes only). */
fgReceiptRouter.get('/fg-receipts/job-info', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ io_no: z.string().trim().min(1).max(40), style_id: s.id() }).parse(req.query);
  const info = await fgJobInfo(req.user!.companyId, qp.io_no, qp.style_id ?? null);
  res.json({ data: { ...info, fg_mode: await fgMode(null, req.user!.companyId) } });
}));

fgReceiptRouter.get('/fg-receipts/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  res.json({ data: await loadReceipt(req.user!.companyId, Number(req.params.id)) });
}));

fgReceiptRouter.post('/fg-receipts', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const b = receiptSchema.parse(req.body);
  const r = await transaction((tx) => postFgReceipt(tx, req, b));
  res.status(201).json({ data: await loadReceipt(req.user!.companyId, r.id), message: `FG receipt ${r.receipt_no} posted into the FG store` });
}));

fgReceiptRouter.put('/fg-receipts/:id', requirePermission('PRODUCTION.UPDATE'), ah(async () => {
  throw BadRequest('A posted FG receipt is not edited — cancel it (while its PCS are still in the FG store) and enter it again');
}));

/** POST /fg-receipts/:id/cancel {reason} — reverse a receipt whose PCS are all still in the FG store. */
fgReceiptRouter.post('/fg-receipts/:id/cancel', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Give a reason (min 3 characters)').max(255) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const r = await txQueryOne<any>(tx, `SELECT * FROM trx_fg_receipt WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!r) throw NotFound('FG receipt not found');
    if (r.status === 'CANCELLED') throw BadRequest(`${r.receipt_no} is already cancelled`);
    const lines = await txQuery<any>(tx, `SELECT * FROM trx_fg_receipt_line WHERE fg_receipt_id = ?`, [id]);
    if (Number(r.fg_posted)) {
      const so = await jobOf(tx, cid, r.io_no);
      if (so) await txQueryOne(tx, `SELECT id FROM trx_sales_order WHERE id = ? FOR UPDATE`, [so.id]);
      const left = await fgStockParts(tx, cid, r.io_no, Number(r.style_id), id);
      const held = await openBagsByPart(tx, cid, r.io_no, Number(r.style_id));
      for (const l of lines) {
        const key = pk(l.part_name, l.color_id, l.size_id);
        const after = (left.get(key)?.received ?? 0) - (left.get(key)?.packed ?? 0);
        const bagged = held.get(key) ?? 0;
        if (after < bagged || after < 0) {
          throw BadRequest(`${r.receipt_no}: PCS of this receipt are already packed / bagged — reverse those first (FG left would be ${after}, bagged ${bagged})`);
        }
      }
      const links = await txQuery<any>(tx, `SELECT * FROM trx_fg_receipt_bundle WHERE fg_receipt_id = ? ORDER BY bundle_id`, [id]);
      for (const ln of links) {
        const b = await lockBundle(tx, cid, { id: Number(ln.bundle_id) });
        const after = await applyBundle(tx, b, { fg_qty: -n(ln.good_qty), pack_loss_qty: -n(ln.reject_qty) });
        await addMovement(tx, req, b, { txn_type: 'FG_RECEIPT_CANCEL', from_stage: b.status, to_stage: after.status, qty: n(ln.good_qty) + n(ln.reject_qty),
          ref_table: 'trx_fg_receipt', ref_id: id, remarks: reason });
      }
      const led = await txQuery<any>(tx, `SELECT * FROM trx_stock_ledger WHERE ref_type = 'FG_RECEIPT' AND ref_id = ? AND company_id = ?`, [id, cid]);
      for (const x of led) {
        await txExecute(tx,
          `INSERT INTO trx_stock_ledger (company_id, warehouse_id, material_type, sku_id, color_id, txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate, so_id, created_by)
           VALUES (?,?,'FINISHED',?,?,'ADJUST','FG_RECEIPT_CANCEL',?,0,?,?,?,?,?)`,
          [cid, x.warehouse_id, x.sku_id, x.color_id, id, x.qty_in, x.uom_id, x.rate, x.so_id, req.user!.id]);
      }
    }
    await txExecute(tx, `UPDATE trx_fg_receipt SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ? WHERE id = ?`, [req.user!.id, reason, id]);
    await audit(req, 'trx_fg_receipt', id, 'UPDATE', { status: r.status }, { status: 'CANCELLED', reason }, tx);
  });
  res.json({ data: await loadReceipt(cid, id), message: 'FG receipt cancelled — its PCS are out of the FG store' });
}));
