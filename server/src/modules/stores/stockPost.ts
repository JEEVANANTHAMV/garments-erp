import { query, queryOne, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest } from '../../core/errors.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { refreshFabricRollStatus } from '../production/cuttingEngine.js';
import { yarnStockRows, yarnStockQuery } from '../procurement/fabricYarnProcurement.routes.js';

/**
 * Stores stock posting (client tracker 14-Oct-2026): one way to read and move stock for the four kinds of
 * store items, so opening stock, stock audit, stock / general delivery and scrap / rejection all post the same way.
 *
 *   YARN    — a GRN lot line (Y:<grn_line_id>). Out = a material issue line on the lot's batch (the yarn stock
 *             screen and the lot pickers already subtract those); back in = a negative issue line on the same batch.
 *   FABRIC  — a fabric roll (F:<roll_id>), KG. The roll's weight is corrected and the roll history records why.
 *   TRIM    — a trim stock row (T:<trx_trim_stock.id>).
 *   GENERAL — free-text items without a master (G:<warehouse>|<so or 0>|<uom>|<item name>), in trx_store_general_ledger.
 *
 * Yarn / fabric / trim moves also go to trx_stock_ledger (the Stock / Stock Ledger screens).
 */
export type Mat = 'YARN' | 'FABRIC' | 'TRIM' | 'GENERAL';
export const MATS = ['YARN', 'FABRIC', 'TRIM', 'GENERAL'] as const;
const EPS = 0.0005;
const n = (v: unknown) => Number(v ?? 0) || 0;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

export const generalRef = (warehouseId: number, soId: number | null | undefined, uomId: number, item: string) =>
  `G:${warehouseId}|${soId || 0}|${uomId}|${item.trim()}`;
function parseGeneral(ref: string) {
  const [wh, so, uom, ...rest] = ref.slice(2).split('|');
  return { warehouseId: Number(wh), soId: Number(so) || null, uomId: Number(uom), item: rest.join('|') };
}

export interface StockRow {
  source_ref: string; material_type: Mat; warehouse_id: number; warehouse_name?: string | null;
  yarn_id?: number | null; fabric_id?: number | null; trim_id?: number | null;
  item_name: string; item_code?: string | null; item_type?: string | null; color_name?: string | null; sizes?: string | null;
  lot_no?: string | null; grn_no?: string | null; so_id?: number | null; job_no?: string | null; style_id?: number | null;
  uom_id: number; uom_code?: string | null; stock_qty: number; rate: number;
}

/** Stock on hand for a material kind, one row per lot / roll / trim lot / general item. */
export async function stockRows(cid: number, f: { material_type: Mat; warehouse_id?: number; so_id?: number; q?: string; include_zero?: boolean; refs?: string[] }): Promise<StockRow[]> {
  const like = f.q ? `%${f.q}%` : null;
  let rows: StockRow[] = [];
  if (f.material_type === 'YARN') {
    const ys = await yarnStockRows(cid, yarnStockQuery.parse({ warehouse_id: f.warehouse_id, search: f.q || undefined }));
    const ids = ys.map((r: any) => Number(r.id));
    const rates = ids.length ? await query<any>('SELECT id, rate FROM trx_grn_line WHERE id IN (?)', [ids]) : [];
    const rate = new Map(rates.map((r) => [Number(r.id), n(r.rate)]));
    rows = ys.filter((r: any) => !['REJECTED', 'PENDING'].includes(r.qc_status)).map((r: any) => ({
      source_ref: `Y:${r.id}`, material_type: 'YARN', warehouse_id: Number(r.warehouse_id), warehouse_name: r.warehouse_name,
      yarn_id: Number(r.yarn_id), item_name: r.yarn_name, item_code: r.yarn_code, item_type: r.yarn_type ?? 'Yarn', color_name: r.color_name ?? r.shade ?? null,
      lot_no: r.lot_no, grn_no: r.grn_no, so_id: r.owner_so_id ? Number(r.owner_so_id) : null, job_no: r.internal_ir_no ?? r.so_no ?? null,
      style_id: r.style_id ? Number(r.style_id) : null, uom_id: Number(r.uom_id), uom_code: r.uom_code, stock_qty: r4(n(r.stock_qty)), rate: rate.get(Number(r.id)) ?? 0,
    }));
  } else if (f.material_type === 'FABRIC') {
    const where = ['r.company_id = ?']; const p: unknown[] = [cid];
    if (f.warehouse_id) { where.push('r.warehouse_id = ?'); p.push(f.warehouse_id); }
    if (like) { where.push('(fb.fabric_name LIKE ? OR r.roll_no LIKE ? OR r.lot_no LIKE ? OR r.color_name LIKE ?)'); p.push(like, like, like, like); }
    const rs = await query<any>(
      `SELECT r.id, r.warehouse_id, w.warehouse_name, r.fabric_id, fb.fabric_name, fb.fabric_code, fb.fabric_type, r.color_name, r.shade, r.roll_no, r.lot_no,
              g.grn_no, r.so_id, COALESCE(so.io_no, so.so_no) job_no, r.weight_kg - r.issued_kg bal, gl.rate, r.qc_status, r.process_state
         FROM trx_fabric_roll r JOIN mst_fabric fb ON fb.id = r.fabric_id
         LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id LEFT JOIN trx_grn g ON g.id = r.grn_id LEFT JOIN trx_grn_line gl ON gl.id = r.grn_line_id
         LEFT JOIN trx_sales_order so ON so.id = r.so_id
        WHERE ${where.join(' AND ')} AND r.qc_status <> 'REJECTED' AND r.stock_status <> 'CLOSED'
        ORDER BY fb.fabric_name, r.roll_no LIMIT 2000`, p);
    rows = rs.map((r) => ({
      source_ref: `F:${r.id}`, material_type: 'FABRIC', warehouse_id: Number(r.warehouse_id), warehouse_name: r.warehouse_name,
      fabric_id: Number(r.fabric_id), item_name: r.fabric_name, item_code: r.fabric_code, item_type: r.fabric_type ?? 'Fabric',
      color_name: r.color_name ?? r.shade ?? null, lot_no: [r.roll_no, r.lot_no].filter(Boolean).join(' / '), grn_no: r.grn_no,
      so_id: r.so_id ? Number(r.so_id) : null, job_no: r.job_no, uom_id: UOM_KG, uom_code: 'KG', stock_qty: r4(n(r.bal)), rate: n(r.rate),
    }));
  } else if (f.material_type === 'TRIM') {
    const where = ['s.company_id = ?']; const p: unknown[] = [cid];
    if (f.warehouse_id) { where.push('s.warehouse_id = ?'); p.push(f.warehouse_id); }
    if (like) { where.push('(t.trim_name LIKE ? OR t.trim_code LIKE ? OR s.internal_lot_no LIKE ? OR s.color_name LIKE ?)'); p.push(like, like, like, like); }
    const rs = await query<any>(
      `SELECT s.id, s.warehouse_id, w.warehouse_name, s.trim_id, t.trim_name, t.trim_code, t.trim_type, s.color_name, s.trim_size, s.internal_lot_no,
              s.so_id, s.style_id, COALESCE(so.io_no, so.so_no) job_no, s.stock_qty - s.allocated_qty bal, s.uom_id, u.code uom_code,
              COALESCE((SELECT l.rate FROM trx_trim_grn_line l WHERE l.trim_id = s.trim_id AND l.internal_lot_no = s.internal_lot_no ORDER BY l.id DESC LIMIT 1), t.std_rate, 0) rate
         FROM trx_trim_stock s JOIN mst_trim t ON t.id = s.trim_id LEFT JOIN mst_warehouse w ON w.id = s.warehouse_id
         LEFT JOIN cfg_uom u ON u.id = s.uom_id LEFT JOIN trx_sales_order so ON so.id = s.so_id
        WHERE ${where.join(' AND ')} ORDER BY t.trim_name, s.internal_lot_no LIMIT 2000`, p);
    rows = rs.map((r) => ({
      source_ref: `T:${r.id}`, material_type: 'TRIM', warehouse_id: Number(r.warehouse_id), warehouse_name: r.warehouse_name,
      trim_id: Number(r.trim_id), item_name: r.trim_name, item_code: r.trim_code, item_type: r.trim_type, color_name: r.color_name, sizes: r.trim_size,
      lot_no: r.internal_lot_no, so_id: r.so_id ? Number(r.so_id) : null, job_no: r.job_no, style_id: r.style_id ? Number(r.style_id) : null,
      uom_id: Number(r.uom_id), uom_code: r.uom_code, stock_qty: r4(n(r.bal)), rate: n(r.rate),
    }));
  } else {
    const where = ['g.company_id = ?']; const p: unknown[] = [cid];
    if (f.warehouse_id) { where.push('g.warehouse_id = ?'); p.push(f.warehouse_id); }
    if (like) { where.push('g.item_name LIKE ?'); p.push(like); }
    const rs = await query<any>(
      `SELECT g.warehouse_id, w.warehouse_name, g.item_name, g.uom_id, u.code uom_code, COALESCE(g.so_id, 0) so_key, MAX(g.so_id) so_id,
              COALESCE(MAX(so.io_no), MAX(so.so_no)) job_no, MAX(g.color_name) color_name, SUM(g.qty_in) - SUM(g.qty_out) bal,
              SUM(g.qty_in * g.rate) / NULLIF(SUM(g.qty_in), 0) rate
         FROM trx_store_general_ledger g LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id LEFT JOIN cfg_uom u ON u.id = g.uom_id
         LEFT JOIN trx_sales_order so ON so.id = g.so_id
        WHERE ${where.join(' AND ')} GROUP BY g.warehouse_id, w.warehouse_name, g.item_name, g.uom_id, u.code, COALESCE(g.so_id, 0)
        ORDER BY g.item_name`, p);
    rows = rs.map((r) => ({
      source_ref: generalRef(Number(r.warehouse_id), Number(r.so_key), Number(r.uom_id), r.item_name), material_type: 'GENERAL',
      warehouse_id: Number(r.warehouse_id), warehouse_name: r.warehouse_name, item_name: r.item_name, item_type: 'General',
      color_name: r.color_name, so_id: r.so_id ? Number(r.so_id) : null, job_no: r.job_no, uom_id: Number(r.uom_id), uom_code: r.uom_code,
      stock_qty: r4(n(r.bal)), rate: r4(n(r.rate)),
    }));
  }
  if (f.so_id) rows = rows.filter((r) => r.so_id === f.so_id);
  if (f.refs) rows = rows.filter((r) => f.refs!.includes(r.source_ref));
  else if (!f.include_zero) rows = rows.filter((r) => r.stock_qty > EPS);
  return rows;
}

/** Current stock of one source (lot / roll / trim lot / general item). */
export async function stockOf(cid: number, ref: string): Promise<StockRow | null> {
  const kind = ref[0];
  if (kind === 'Y') {
    const gl = await queryOne<any>('SELECT gl.yarn_id FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id WHERE gl.id = ? AND g.company_id = ?', [Number(ref.slice(2)), cid]);
    if (!gl) return null;
    const ys = await yarnStockRows(cid, yarnStockQuery.parse({ yarn_id: gl.yarn_id }));
    const r = ys.find((x: any) => Number(x.id) === Number(ref.slice(2)));
    if (!r) return null;
    const rate = await queryOne<any>('SELECT rate FROM trx_grn_line WHERE id = ?', [r.id]);
    return { source_ref: ref, material_type: 'YARN', warehouse_id: Number(r.warehouse_id), yarn_id: Number(r.yarn_id), item_name: r.yarn_name,
      color_name: r.color_name ?? r.shade ?? null, lot_no: r.lot_no, grn_no: r.grn_no, so_id: r.owner_so_id ? Number(r.owner_so_id) : null,
      style_id: r.style_id ? Number(r.style_id) : null, uom_id: Number(r.uom_id), stock_qty: r4(n(r.stock_qty)), rate: n(rate?.rate) };
  }
  const mt: Mat = kind === 'F' ? 'FABRIC' : kind === 'T' ? 'TRIM' : 'GENERAL';
  const wh = kind === 'G' ? parseGeneral(ref).warehouseId : undefined;
  const rows = await stockRows(cid, { material_type: mt, warehouse_id: wh, refs: [ref] });
  return rows[0] ?? null;
}

export interface MoveCtx {
  cid: number; userId: number; tx: Tx;
  refType: string; refId: number; refNo: string; date: string;
  /** Material issue headers made for yarn moves of this posting, per warehouse. */
  issues?: Map<number, number>;
  /** Moves already made in this (uncommitted) posting, per source — stock reads run outside the transaction. */
  pending?: Map<string, number>;
}

async function yarnIssueHeader(ctx: MoveCtx, warehouseId: number) {
  ctx.issues ??= new Map();
  const have = ctx.issues.get(warehouseId);
  if (have) return have;
  const cnt = await txQueryOne<any>(ctx.tx, 'SELECT COUNT(*) c FROM trx_material_issue WHERE company_id = ? AND issue_no LIKE ?', [ctx.cid, `${ctx.refNo}/%`]);
  const r = await txExecute(ctx.tx,
    `INSERT INTO trx_material_issue (company_id, issue_no, issue_date, warehouse_id, remarks, created_by) VALUES (?,?,?,?,?,?)`,
    [ctx.cid, `${ctx.refNo}/${n(cnt?.c) + 1}`, ctx.date, warehouseId, `Stores ${ctx.refType.replace(/_/g, ' ').toLowerCase()} ${ctx.refNo} (yarn lot stock movement)`, ctx.userId]);
  ctx.issues.set(warehouseId, r.insertId);
  return r.insertId;
}

/**
 * Move stock of one source by `delta` (+ in / − out). `to` (rejection godown) receives what goes out.
 * Returns the source row before the move. Throws when the stock would go negative.
 */
export async function moveStock(ctx: MoveCtx, ref: string, delta: number, opts: { txnType: 'ADJUST' | 'ISSUE' | 'RETURN' | 'TRANSFER_OUT'; label: string; to?: number | null; rate?: number; soId?: number | null }) {
  const { tx, cid } = ctx;
  if (Math.abs(delta) <= EPS) return null;
  const cur = await stockOf(cid, ref);
  if (!cur) throw BadRequest(`Stock item ${ref} not found`);
  ctx.pending ??= new Map();
  cur.stock_qty = r4(cur.stock_qty + (ctx.pending.get(ref) ?? 0));
  ctx.pending.set(ref, (ctx.pending.get(ref) ?? 0) + delta);
  if (delta < 0 && cur.stock_qty + delta < -EPS) throw BadRequest(`${cur.item_name}${cur.lot_no ? ` (${cur.lot_no})` : ''}: stock ${cur.stock_qty} — cannot take out ${r4(-delta)}`);
  const rate = opts.rate ?? cur.rate ?? 0;
  const ledger = async (warehouseId: number, inQ: number, outQ: number, txnType: string) => {
    if (cur.material_type === 'GENERAL') return;
    await postLedger(tx, { companyId: cid, warehouseId, materialType: cur.material_type as 'YARN' | 'FABRIC' | 'TRIM',
      yarnId: cur.yarn_id, fabricId: cur.fabric_id, trimId: cur.trim_id, soId: opts.soId ?? cur.so_id,
      txnType: txnType as any, refType: ctx.refType, refId: ctx.refId, qtyIn: inQ, qtyOut: outQ, uomId: cur.uom_id, rate, createdBy: ctx.userId });
  };
  const id = Number(ref.slice(2));

  if (cur.material_type === 'YARN') {
    const gl = await txQueryOne<any>(tx, 'SELECT gl.id, gl.batch_id, gl.yarn_id, gl.lot_no, g.supplier_id FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id WHERE gl.id = ? FOR UPDATE', [id]);
    let batchId = gl.batch_id ? Number(gl.batch_id) : null;
    if (!batchId) {
      const b = await txExecute(tx, `INSERT INTO mst_batch (company_id, batch_no, material_type, yarn_id, shade_lot, supplier_id, received_date, remarks) VALUES (?,?,?,?,?,?,?,?)`,
        [cid, `LOT-${gl.id}-${Date.now().toString(36).toUpperCase()}`, 'YARN', gl.yarn_id, gl.lot_no ?? null, gl.supplier_id ?? null, ctx.date, `Batch for yarn lot line ${gl.id} (stores movement)`]);
      batchId = b.insertId;
      await txExecute(tx, 'UPDATE trx_grn_line SET batch_id = ? WHERE id = ? AND batch_id IS NULL', [batchId, gl.id]);
    }
    const issueId = await yarnIssueHeader(ctx, cur.warehouse_id);
    await txExecute(tx, `INSERT INTO trx_material_issue_line (issue_id, material_type, yarn_id, batch_id, issued_qty, uom_id) VALUES (?,?,?,?,?,?)`,
      [issueId, 'YARN', gl.yarn_id, batchId, -delta, cur.uom_id]);
  } else if (cur.material_type === 'FABRIC') {
    const roll = await txQueryOne<any>(tx, 'SELECT id, roll_no, weight_kg, issued_kg, warehouse_id, so_id FROM trx_fabric_roll WHERE id = ? FOR UPDATE', [id]);
    const whole = delta < 0 && Math.abs(-delta - (n(roll.weight_kg) - n(roll.issued_kg))) <= EPS && n(roll.issued_kg) <= EPS;
    if (opts.to && whole) {
      // the whole roll goes to the rejection godown as it is
      await txExecute(tx, `UPDATE trx_fabric_roll SET warehouse_id = ?, qc_status = 'REJECTED' WHERE id = ?`, [opts.to, id]);
    } else {
      await txExecute(tx, 'UPDATE trx_fabric_roll SET weight_kg = COALESCE(weight_kg, 0) + ? WHERE id = ?', [delta, id]);
      await refreshFabricRollStatus(tx, id, { reopen: delta > 0 });
    }
    await txExecute(tx,
      `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, qty_kg, so_id, remarks, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, id, roll.roll_no, opts.label.slice(0, 30), ctx.refType.slice(0, 30), ctx.refId, ctx.refNo, delta, roll.so_id, `${opts.label} ${ctx.refNo}: ${delta > 0 ? '+' : ''}${r4(delta)} KG`, ctx.userId]);
  } else if (cur.material_type === 'TRIM') {
    const res = await txExecute(tx, 'UPDATE trx_trim_stock SET stock_qty = stock_qty + ? WHERE id = ? AND stock_qty - allocated_qty + ? >= -0.0005', [delta, id, delta]);
    if (!res.affectedRows) throw BadRequest(`${cur.item_name}: not enough free trim stock`);
    if (opts.to) {
      const s = await txQueryOne<any>(tx, 'SELECT * FROM trx_trim_stock WHERE id = ?', [id]);
      await txExecute(tx,
        `INSERT INTO trx_trim_stock (company_id, warehouse_id, trim_id, color_name, trim_size, internal_lot_no, stock_qty, uom_id, so_id, style_id, so_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE stock_qty = stock_qty + VALUES(stock_qty)`,
        [cid, opts.to, s.trim_id, s.color_name, s.trim_size, s.internal_lot_no, -delta, s.uom_id, s.so_id, s.style_id, s.so_key]);
    }
  } else {
    const g = parseGeneral(ref);
    await txExecute(tx,
      `INSERT INTO trx_store_general_ledger (company_id, warehouse_id, item_name, uom_id, so_id, color_name, qty_in, qty_out, rate, ref_type, ref_id, ref_no, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, g.warehouseId, g.item, g.uomId, g.soId, cur.color_name ?? null, delta > 0 ? delta : 0, delta < 0 ? -delta : 0, rate, ctx.refType, ctx.refId, ctx.refNo, ctx.userId]);
    if (opts.to) {
      await txExecute(tx,
        `INSERT INTO trx_store_general_ledger (company_id, warehouse_id, item_name, uom_id, so_id, color_name, qty_in, qty_out, rate, ref_type, ref_id, ref_no, created_by)
         VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)`,
        [cid, opts.to, g.item, g.uomId, g.soId, cur.color_name ?? null, -delta, rate, ctx.refType, ctx.refId, ctx.refNo, ctx.userId]);
    }
  }
  if (opts.to) {
    await ledger(cur.warehouse_id, 0, -delta, 'TRANSFER_OUT');
    await ledger(opts.to, -delta, 0, 'TRANSFER_IN');
  } else {
    await ledger(cur.warehouse_id, delta > 0 ? delta : 0, delta < 0 ? -delta : 0, opts.txnType);
  }
  return cur;
}

/** New general item stock (opening stock): no source row needed. */
export async function addGeneral(ctx: MoveCtx, p: { warehouseId: number; item: string; uomId: number; soId?: number | null; color?: string | null; qty: number; rate: number }) {
  await txExecute(ctx.tx,
    `INSERT INTO trx_store_general_ledger (company_id, warehouse_id, item_name, uom_id, so_id, color_name, qty_in, qty_out, rate, ref_type, ref_id, ref_no, created_by)
     VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)`,
    [ctx.cid, p.warehouseId, p.item.trim(), p.uomId, p.soId ?? null, p.color ?? null, p.qty, p.rate, ctx.refType, ctx.refId, ctx.refNo, ctx.userId]);
  return generalRef(p.warehouseId, p.soId, p.uomId, p.item);
}
