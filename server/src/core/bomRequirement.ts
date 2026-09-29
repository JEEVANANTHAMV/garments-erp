import { query, txQuery, type Tx } from '../config/db.js';

/**
 * BOM requirement of a job, shared by MRP, the BOM print and the job BOM pick
 * for quotations / POs so they always agree:
 *
 *   quantity a BOM line applies to = plan-cut PCS of the order cells it covers
 *     (all cells, one colour, one size, or one colour-size), where each size's
 *     plan cut already includes its size-wise excess %;
 *   requirement = that qty × consumption (÷ 12 per dozen, or the fixed qty),
 *     + wastage %, + additional qty.
 */
export interface OrderCell { color_id: number | null; size_id: number | null; qty: number; plan_cut: number }

const n = (v: unknown) => Number(v ?? 0) || 0;

/** Colour × size cells of one style on a sales order (lines without a size breakdown give colour cells). */
export async function orderCells(tx: Tx | null, soId: number, styleId: number): Promise<OrderCell[]> {
  const run = (sql: string, p: unknown[]) => (tx ? txQuery<any>(tx, sql, p) : query<any>(sql, p));
  const sized = await run(
    `SELECT COALESCE(k.color_id, l.color_id) AS color_id, k.size_id, SUM(ss.qty) AS qty,
            SUM(COALESCE(ss.plan_cut_qty,
                         ROUND(ss.qty * NULLIF(l.plan_cut_qty, 0) / NULLIF(l.order_qty, 0)),
                         ss.qty)) AS plan_cut
       FROM trx_sales_order_sku ss
       JOIN trx_sales_order_line l ON l.id = ss.so_line_id
       JOIN mst_style_sku k ON k.id = ss.sku_id
      WHERE l.so_id = ? AND l.style_id = ? AND ss.qty > 0
      GROUP BY COALESCE(k.color_id, l.color_id), k.size_id`, [soId, styleId]);
  const plain = await run(
    `SELECT l.color_id, NULL AS size_id, SUM(l.order_qty) AS qty,
            SUM(COALESCE(NULLIF(l.plan_cut_qty, 0), l.order_qty)) AS plan_cut
       FROM trx_sales_order_line l
      WHERE l.so_id = ? AND l.style_id = ?
        AND NOT EXISTS (SELECT 1 FROM trx_sales_order_sku ss WHERE ss.so_line_id = l.id AND ss.qty > 0)
      GROUP BY l.color_id`, [soId, styleId]);
  return [...sized, ...plain].map((r) => ({
    color_id: r.color_id == null ? null : Number(r.color_id),
    size_id: r.size_id == null ? null : Number(r.size_id),
    qty: n(r.qty), plan_cut: n(r.plan_cut),
  }));
}

export const cellsPlanCut = (cells: OrderCell[]) => cells.reduce((a, c) => a + c.plan_cut, 0);
export const cellsOrderQty = (cells: OrderCell[]) => cells.reduce((a, c) => a + c.qty, 0);

/** Cells a BOM line covers (colour and / or size specific, else all). */
export function cellsFor(line: { color_id?: unknown; size_id?: unknown }, cells: OrderCell[]) {
  const color = line.color_id ? Number(line.color_id) : null;
  const size = line.size_id ? Number(line.size_id) : null;
  if (!color && !size) return cells;
  return cells.filter((c) => (!color || c.color_id === color) && (!size || c.size_id === size));
}

/** Requirement of a BOM line for `qty` garments. */
export function lineRequirement(line: { consumption?: unknown; consumption_basis?: unknown; wastage_pct?: unknown; additional_qty?: unknown }, qty: number) {
  const cons = n(line.consumption);
  const basis = String(line.consumption_basis || 'PER_PIECE');
  const base = basis === 'PER_DOZEN' ? (qty / 12) * cons : basis === 'FIXED_QTY' ? cons : qty * cons;
  const waste = base * (n(line.wastage_pct) / 100);
  const addl = n(line.additional_qty);
  return { basis, base, waste, addl, required: base + waste + addl };
}
