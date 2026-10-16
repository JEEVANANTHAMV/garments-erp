import { query, queryOne, txQuery, txQueryOne, type Tx } from '../../config/db.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import type { BlockIn, BlockOut, ComputedList } from './packingListCalc.js';

/**
 * Packing list as the plan (client call 16-Oct-2026):
 *   "The buyer gives the packing list — carton-wise, with the ratio; for a few buyers we make it.
 *    Some buyers give a separate list per country / selling point."
 *
 * A PLAN list is entered first (rows typed from the buyer's sheet, no cartons yet), then RELEASED
 * (status PLANNED, rows frozen). Every carton packed for it names the list and its carton number on it;
 * the carton must hold that carton's colours / sizes, never more. FINISH turns the list into the
 * document from the packed cartons (same carton numbers); a shortage is either sent later on a
 * follow-up plan list (TO_FOLLOW) or debited by the buyer (DEBIT).
 */

export interface PlanLine { style_id: number; style_no: string | null; color_id: number; colour: string | null; size_id: number; size_label: string; qty: number }
export interface PlanCarton { ctn_no: number; block_no: number; row_index: number; label: string | null; lines: PlanLine[]; qty: number }
export interface PlanJson {
  pl_type: string; size_headers: string[] | null;
  blocks: BlockOut[];
  cartons: PlanCarton[];
  total_cartons: number; total_qty: number;
}

const norm = (v: unknown) => String(v ?? '').trim().toUpperCase();
const n = (v: unknown) => Number(v ?? 0) || 0;
export const READY_STATUSES = ['VERIFIED', 'SEALED', 'DISPATCHED'];
const isReady = (c: any) => Number(c.is_posted) === 1 && READY_STATUSES.includes(c.carton_status);
const lk = (color: number, size: number) => `${color}:${size}`;

export function parsePlan(v: unknown): PlanJson | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') { try { return JSON.parse(v) as PlanJson; } catch { return null; } }
  return v as PlanJson;
}

/**
 * Resolve a list's rows into the released plan: per carton number the style × colour × size qty,
 * size labels matched to the style's sizes (size code or label). Every item must be on the order.
 */
export async function resolvePlan(tx: Tx, cid: number, pl: any, st: ComputedList): Promise<PlanJson> {
  if (!pl.so_id) throw BadRequest('Pick the sales order (job) of the packing list before releasing it as a plan');
  const rows = st.blocks.flatMap((b) => b.rows);
  if (!rows.length) throw BadRequest('Enter the carton rows of the buyer packing list before releasing it');
  const fromCartons = rows.filter((r) => r.source_carton_ids?.length);
  if (fromCartons.length) throw BadRequest('A plan is the buyer list entered before packing — these rows were built from packed cartons; use the list as a document instead');
  const total = rows.reduce((a, r) => a + r.no_of_ctns, 0);
  if (total > 20000) throw BadRequest(`The plan has ${total} cartons — at most 20000 on one list`);

  // order lines: style × colour on the sales order
  const soLines = await txQuery<any>(tx,
    `SELECT DISTINCT l.style_id, l.color_id FROM trx_sales_order_line l JOIN trx_sales_order so ON so.id = l.so_id AND so.company_id = ? WHERE l.so_id = ?`,
    [cid, pl.so_id]);
  const onOrder = new Set(soLines.map((x: any) => `${x.style_id}:${x.color_id}`));
  const styles = [...new Set(soLines.map((x: any) => Number(x.style_id)))];
  const sizeRows = styles.length ? await txQuery<any>(tx,
    `SELECT DISTINCT k.style_id, sz.id AS size_id, sz.size_code, sz.size_label
       FROM mst_style_sku k JOIN mst_size sz ON sz.id = k.size_id WHERE k.style_id IN (?)`, [styles]) : [];
  const sizeOf = (styleId: number, label: string) => {
    const L = norm(label);
    return sizeRows.find((x: any) => Number(x.style_id) === styleId && (norm(x.size_code) === L || norm(x.size_label) === L));
  };

  const problems: string[] = [];
  const cartons: PlanCarton[] = [];
  st.blocks.forEach((b) => b.rows.forEach((r, ri) => {
    const lines: PlanLine[] = [];
    for (const it of r.items) {
      const what = `cartons ${r.ctn_from}-${r.ctn_to}`;
      if (!it.style_id || !it.color_id) { problems.push(`${what}: pick the style and colour from the order (typed names cannot be packed against)`); continue; }
      if (!onOrder.has(`${it.style_id}:${it.color_id}`)) { problems.push(`${what}: ${it.style_no ?? `style #${it.style_id}`} ${it.colour ?? `colour #${it.color_id}`} is not on the sales order`); continue; }
      for (const [label, q] of Object.entries(it.size_qty_per_ctn ?? {})) {
        if (!(Number(q) > 0)) continue;
        const sz = sizeOf(Number(it.style_id), label);
        if (!sz) { problems.push(`${what}: size "${label}" is not a size of ${it.style_no ?? `style #${it.style_id}`}`); continue; }
        const same = lines.find((x) => x.style_id === Number(it.style_id) && x.color_id === Number(it.color_id) && x.size_id === Number(sz.size_id));
        if (same) same.qty += Number(q);
        else lines.push({ style_id: Number(it.style_id), style_no: it.style_no, color_id: Number(it.color_id), colour: it.colour,
                          size_id: Number(sz.size_id), size_label: label, qty: Number(q) });
      }
    }
    const qty = lines.reduce((a, l) => a + l.qty, 0);
    for (let c = r.ctn_from; c <= r.ctn_to; c++) cartons.push({ ctn_no: c, block_no: b.block_no, row_index: ri, label: b.label, lines, qty });
  }));
  if (problems.length) {
    const u = [...new Set(problems)];
    throw BadRequest(`${u.slice(0, 4).join('; ')}${u.length > 4 ? `; and ${u.length - 4} more` : ''}`);
  }
  return {
    pl_type: pl.pl_type, size_headers: st.blocks[0]?.effective_size_headers ?? null,
    blocks: st.blocks, cartons, total_cartons: cartons.length, total_qty: cartons.reduce((a, c) => a + c.qty, 0),
  };
}

/** Rows of a stored plan back into editable list input (unrelease / reopen). */
export function planBlocksIn(plan: PlanJson): BlockIn[] {
  return plan.blocks.map((b) => ({
    label: b.label, size_headers: b.size_headers,
    rows: b.rows.map((r) => ({
      row_type: r.row_type, ctn_from: r.ctn_from, ctn_to: r.ctn_to, no_of_ctns: r.no_of_ctns,
      pcs_per_pack: r.pcs_per_pack, packs_per_ctn: r.packs_per_ctn, pcs_per_ctn: r.pcs_per_ctn,
      net_wt_per_ctn: r.net_wt_per_ctn, gross_wt_per_ctn: r.gross_wt_per_ctn,
      length_cm: r.length_cm, width_cm: r.width_cm, height_cm: r.height_cm, remarks: r.remarks, source_carton_ids: null,
      items: r.items.map((i) => ({ so_id: i.so_id, order_no: i.order_no, style_id: i.style_id, style_no: i.style_no, style_name: i.style_name,
                                   color_id: i.color_id, colour: i.colour, size_qty: i.size_qty })),
    })),
  }));
}

/**
 * A carton packed for a plan: the list must be PLANNED for the same order, the carton number must be on
 * it and free, and the carton holds only that carton's colours / sizes, at most the planned qty.
 * Locks the list row (serialises carton numbers on one plan).
 */
export async function assertCartonForPlan(tx: Tx, cid: number, order: any, planId: number, ctnNo: number,
  lines: { color_id: number; size_id: number; qty: number }[], cartonId: number | null) {
  const pl = await txQueryOne<any>(tx, `SELECT id, pl_no, status, list_mode, so_id, plan_json FROM trx_packing_list WHERE id = ? AND company_id = ? FOR UPDATE`, [planId, cid]);
  if (!pl) throw BadRequest(`Packing list #${planId} not found`);
  if (pl.list_mode !== 'PLAN' || pl.status !== 'PLANNED') throw BadRequest(`Packing list ${pl.pl_no} is not a released plan (${pl.list_mode === 'PLAN' ? pl.status : 'document list'}) — cartons are packed only against a released plan`);
  if (Number(pl.so_id) !== Number(order.so_id)) throw BadRequest(`Packing list ${pl.pl_no} is for another sales order`);
  const plan = parsePlan(pl.plan_json);
  const ctn = plan?.cartons.find((c) => c.ctn_no === ctnNo);
  if (!ctn) throw BadRequest(`Carton ${ctnNo} is not on packing list ${pl.pl_no} (cartons ${plan?.cartons[0]?.ctn_no ?? '-'}–${plan?.cartons[plan.cartons.length - 1]?.ctn_no ?? '-'})`);
  const other = ctn.lines.find((l) => l.style_id !== Number(order.style_id));
  if (other) throw BadRequest(`Carton ${ctnNo} of ${pl.pl_no} holds style ${other.style_no ?? other.style_id} — pack it from that style's packing order`);
  const dup = await txQueryOne<any>(tx,
    `SELECT carton_no FROM trx_carton WHERE pl_plan_id = ? AND pl_ctn_no = ? AND carton_status <> 'VOID' AND id <> ? LIMIT 1`, [planId, ctnNo, cartonId ?? 0]);
  if (dup) throw BadRequest(`Carton ${ctnNo} of ${pl.pl_no} is already packed (carton ${dup.carton_no}) — void it first to pack it again`);
  const plannedBy = new Map(ctn.lines.map((l) => [lk(l.color_id, l.size_id), l]));
  for (const l of lines) {
    const p = plannedBy.get(lk(Number(l.color_id), Number(l.size_id)));
    if (!p) throw BadRequest(`Carton ${ctnNo} of ${pl.pl_no} does not hold colour #${l.color_id} / size #${l.size_id} — the plan has ${ctn.lines.map((x) => `${x.colour} ${x.size_label} ${x.qty}`).join(', ')}`);
    if (Number(l.qty) > p.qty) throw BadRequest(`Carton ${ctnNo} of ${pl.pl_no}: ${p.colour} ${p.size_label} is ${p.qty} pcs on the plan — ${l.qty} entered (excess goes on a revised plan, not in the carton)`);
  }
  const packed = lines.reduce((a, l) => a + Number(l.qty), 0);
  return { pl_no: pl.pl_no as string, planned: ctn.qty, packed, short: ctn.qty - packed };
}

/**
 * Planned vs packed for a plan list, per carton number and per colour × size.
 * Carton states: NOT_PACKED · IN_PROGRESS (not yet posted + verified) · READY · READY_SHORT (fewer pcs than planned).
 */
export async function planStatus(cid: number, plId: number, planIn?: PlanJson | null, db?: { tx?: Tx }) {
  const q = <T = any>(sql: string, p: unknown[]) => (db?.tx ? txQuery<T>(db.tx, sql, p) : query<T>(sql, p));
  let plan = planIn ?? null;
  if (!plan) {
    const pl = await queryOne<any>(`SELECT plan_json FROM trx_packing_list WHERE id = ? AND company_id = ?`, [plId, cid]);
    if (!pl) throw NotFound('Packing list not found');
    plan = parsePlan(pl.plan_json);
  }
  if (!plan) return null;
  const cs = await q<any>(
    `SELECT c.id, c.carton_no, c.carton_status, c.is_posted, c.pl_ctn_no, p.pack_no, p.id AS packing_id
       FROM trx_carton c JOIN trx_packing p ON p.id = c.packing_id AND p.company_id = ?
      WHERE c.pl_plan_id = ? AND c.carton_status <> 'VOID'`, [cid, plId]);
  const ids = cs.map((c: any) => Number(c.id));
  const content = ids.length ? await q<any>(`SELECT carton_id, color_id, size_id, SUM(qty) AS qty FROM trx_carton_content WHERE carton_id IN (?) GROUP BY carton_id, color_id, size_id`, [ids]) : [];
  const byCarton = new Map<number, any[]>();
  for (const x of content) { const a = byCarton.get(Number(x.carton_id)) ?? []; a.push(x); byCarton.set(Number(x.carton_id), a); }
  const byNo = new Map<number, any>(cs.map((c: any) => [Number(c.pl_ctn_no), c]));

  const grid = new Map<string, { color_id: number; colour: string | null; size_id: number; size_label: string; style_no: string | null; planned: number; ready: number; in_progress: number }>();
  const cell = (l: PlanLine) => {
    const k = `${l.style_id}|${lk(l.color_id, l.size_id)}`;
    let g = grid.get(k);
    if (!g) { g = { color_id: l.color_id, colour: l.colour, size_id: l.size_id, size_label: l.size_label, style_no: l.style_no, planned: 0, ready: 0, in_progress: 0 }; grid.set(k, g); }
    return g;
  };
  const cartons = plan.cartons.map((pc) => {
    const c = byNo.get(pc.ctn_no);
    const got = c ? (byCarton.get(Number(c.id)) ?? []) : [];
    const packed = got.reduce((a, x) => a + n(x.qty), 0);
    for (const l of pc.lines) {
      const g = cell(l);
      g.planned += l.qty;
      const have = got.filter((x) => Number(x.color_id) === l.color_id && Number(x.size_id) === l.size_id).reduce((a, x) => a + n(x.qty), 0);
      if (c && isReady(c)) g.ready += have; else if (c) g.in_progress += have;
    }
    const state = !c ? 'NOT_PACKED' : !isReady(c) ? 'IN_PROGRESS' : packed < pc.qty ? 'READY_SHORT' : 'READY';
    return { ctn_no: pc.ctn_no, block_no: pc.block_no, label: pc.label, planned: pc.qty, packed, state,
             carton_id: c ? Number(c.id) : null, carton_no: c?.carton_no ?? null, carton_status: c?.carton_status ?? null, pack_no: c?.pack_no ?? null };
  });
  const cells = [...grid.values()].map((g) => ({ ...g, short: g.planned - g.ready }));
  const count = (s: string) => cartons.filter((c) => c.state === s).length;
  const readyQty = cells.reduce((a, g) => a + g.ready, 0);
  const used = new Set(cartons.filter((c) => c.carton_id).map((c) => c.ctn_no));
  return {
    total_cartons: plan.total_cartons, total_qty: plan.total_qty,
    ready_cartons: count('READY') + count('READY_SHORT'), short_cartons: count('READY_SHORT'),
    in_progress_cartons: count('IN_PROGRESS'), not_packed_cartons: count('NOT_PACKED'),
    ready_qty: readyQty, in_progress_qty: cells.reduce((a, g) => a + g.in_progress, 0), short_qty: plan.total_qty - readyQty,
    next_free: plan.cartons.find((c) => !used.has(c.ctn_no))?.ctn_no ?? null,
    cartons, cells,
  };
}

/** Released plans of a sales order a carton of this packing order can be packed for (carton editor picker). */
export async function plansForOrder(cid: number, order: { so_id: number; style_id: number }) {
  const lists = await query<any>(
    `SELECT id, pl_no, destination, country_of_destination, buyer_order_no, plan_json FROM trx_packing_list
      WHERE company_id = ? AND so_id = ? AND list_mode = 'PLAN' AND status = 'PLANNED' ORDER BY id`, [cid, order.so_id]);
  const out = [];
  for (const l of lists) {
    const plan = parsePlan(l.plan_json);
    if (!plan) continue;
    const st = await planStatus(cid, Number(l.id), plan);
    const mine = plan.cartons.filter((c) => c.lines.every((x) => x.style_id === Number(order.style_id)));
    if (!mine.length) continue;
    const stateOf = new Map(st!.cartons.map((c) => [c.ctn_no, c]));
    out.push({
      id: Number(l.id), pl_no: l.pl_no, destination: l.destination ?? l.country_of_destination ?? null, buyer_order_no: l.buyer_order_no,
      total_cartons: plan.total_cartons, ready_cartons: st!.ready_cartons, in_progress_cartons: st!.in_progress_cartons,
      cartons: mine.map((c) => ({ ctn_no: c.ctn_no, label: c.label, qty: c.qty, lines: c.lines,
        packed: stateOf.get(c.ctn_no)?.carton_no ?? null, state: stateOf.get(c.ctn_no)?.state ?? 'NOT_PACKED' })),
    });
  }
  return out;
}
