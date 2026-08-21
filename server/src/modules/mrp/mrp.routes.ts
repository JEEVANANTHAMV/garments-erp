import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';

export const mrpRouter = Router();

mrpRouter.get('/', requirePermission('MRP.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    so_id: z.coerce.number().int().optional(),
  }).parse(req.query);

  const where = ['t.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  if (q.so_id) { where.push('t.so_id = ?'); params.push(q.so_id); }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(`SELECT t.*, so.so_no, cs.label AS status_label,
                  (SELECT COUNT(*) FROM trx_mrp_requirement r WHERE r.mrp_id = t.id) AS requirement_count
             FROM trx_mrp_run t
             LEFT JOIN trx_sales_order so ON so.id = t.so_id
             LEFT JOIN cfg_status cs ON cs.id = t.status_id
            WHERE ${clause} ORDER BY t.id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM trx_mrp_run t WHERE ${clause}`, params),
  ]);
  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

mrpRouter.get('/:id', requirePermission('MRP.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const run = await queryOne(
    `SELECT t.*, so.so_no, cs.label AS status_label
       FROM trx_mrp_run t
       LEFT JOIN trx_sales_order so ON so.id = t.so_id
       LEFT JOIN cfg_status cs ON cs.id = t.status_id
      WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!run) throw NotFound('MRP run not found');

  const requirements = await query(
    `SELECT r.*, y.yarn_name, y.yarn_code, fb.fabric_name, fb.fabric_code,
            tr.trim_name, tr.trim_code, c.color_name, u.code AS uom_code,
            st.style_code, so.so_no,
            COALESCE(y.std_rate, fb.std_rate, tr.std_rate, 0) AS std_rate
       FROM trx_mrp_requirement r
       LEFT JOIN mst_yarn y ON y.id = r.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = r.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = r.trim_id
       LEFT JOIN mst_color c ON c.id = r.color_id
       LEFT JOIN cfg_uom u ON u.id = r.uom_id
       LEFT JOIN mst_style st ON st.id = r.style_id
       LEFT JOIN trx_sales_order so ON so.id = r.so_id
      WHERE r.mrp_id = ? ORDER BY r.material_type, r.id`, [id]);

  res.json({ data: { ...run, requirements } });
}));

const runSchema = z.object({
  so_id: z.coerce.number().int().positive('Select a sales order to run MRP against'),
  mrp_no: z.string().trim().max(40).optional(),
  run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  remarks: z.string().trim().max(500).optional(),
});

/**
 * Run MRP for a sales order.
 *
 * For every SO line it finds the style's active BOM, explodes consumption
 * (including wastage) against the ordered quantity, nets off free stock and
 * quantities already on open purchase orders, and writes the shortfall.
 */
mrpRouter.post('/run', requirePermission('MRP.CREATE'), ah(async (req, res) => {
  const body = runSchema.parse(req.body);

  const so = await queryOne<{ id: number; so_no: string; ship_date: string | null }>(
    `SELECT id, so_no, ship_date FROM trx_sales_order
      WHERE id = ? AND company_id = ? AND is_deleted = 0`,
    [body.so_id, req.user!.companyId]);
  if (!so) throw NotFound('Sales order not found');

  const created = await transaction(async (tx) => {
    const lines = await txQuery<{ id: number; style_id: number; order_qty: number; color_id: number | null }>(
      tx,
      `SELECT id, style_id, order_qty, color_id FROM trx_sales_order_line WHERE so_id = ?`, [body.so_id]);
    if (!lines.length) throw BadRequest('This sales order has no lines to plan against');

    const mrpNo = body.mrp_no || await nextDocNumber(tx, req.user!.companyId, 'MRP');
    const r = await txExecute(tx,
      `INSERT INTO trx_mrp_run (company_id, mrp_no, run_date, so_id, remarks, created_by)
       VALUES (?,?,?,?,?,?)`,
      [req.user!.companyId, mrpNo, body.run_date ?? new Date().toISOString().slice(0, 10),
       body.so_id, body.remarks ?? null, req.user!.id]);
    const mrpId = r.insertId;

    // Aggregate gross requirement per (material, color) across all SO lines.
    const agg = new Map<string, {
      material_type: string; yarn_id: number | null; fabric_id: number | null;
      trim_id: number | null; color_id: number | null; uom_id: number;
      style_id: number; gross: number;
    }>();

    let bomsFound = 0;
    for (const line of lines) {
      const bom = await txQueryOne<{ id: number }>(
        tx,
        `SELECT id FROM trx_bom
          WHERE style_id = ? AND company_id = ? AND is_active = 1
          ORDER BY version DESC LIMIT 1`, [line.style_id, req.user!.companyId]);
      if (!bom) continue;   // style without a BOM contributes nothing
      bomsFound++;

      const bomLines = await txQuery<any>(
        tx,
        `SELECT material_type, yarn_id, fabric_id, trim_id, color_id, consumption, uom_id, wastage_pct
           FROM trx_bom_line WHERE bom_id = ?`, [bom.id]);

      for (const bl of bomLines) {
        const perUnit = Number(bl.consumption) * (1 + Number(bl.wastage_pct ?? 0) / 100);
        const gross = perUnit * Number(line.order_qty);
        // BOM line colour wins; otherwise inherit the order line's colour.
        const colorId = bl.color_id ?? line.color_id ?? null;
        const key = [bl.material_type, bl.yarn_id, bl.fabric_id, bl.trim_id, colorId].join(':');

        const prev = agg.get(key);
        if (prev) prev.gross += gross;
        else agg.set(key, {
          material_type: bl.material_type, yarn_id: bl.yarn_id, fabric_id: bl.fabric_id,
          trim_id: bl.trim_id, color_id: colorId, uom_id: bl.uom_id,
          style_id: line.style_id, gross,
        });
      }
    }

    if (!bomsFound) {
      throw BadRequest('None of the styles on this order have an active BOM. Create a BOM first.');
    }

    for (const item of agg.values()) {
      const stock = await txQueryOne<{ bal: number }>(
        tx,
        `SELECT COALESCE(SUM(qty_in) - SUM(qty_out), 0) AS bal
           FROM trx_stock_ledger
          WHERE company_id = ? AND material_type = ?
            AND (yarn_id <=> ?) AND (fabric_id <=> ?) AND (trim_id <=> ?)`,
        [req.user!.companyId, item.material_type, item.yarn_id, item.fabric_id, item.trim_id]);

      // Quantity already ordered but not yet received on open POs.
      const onOrder = await txQueryOne<{ qty: number }>(
        tx,
        `SELECT COALESCE(SUM(pol.qty - pol.received_qty), 0) AS qty
           FROM trx_purchase_order_line pol
           JOIN trx_purchase_order po ON po.id = pol.po_id
          WHERE po.company_id = ? AND po.is_deleted = 0
            AND po.approval_state NOT IN ('CANCELLED','REJECTED','CLOSED')
            AND (pol.yarn_id <=> ?) AND (pol.fabric_id <=> ?) AND (pol.trim_id <=> ?)
            AND pol.qty > pol.received_qty`,
        [req.user!.companyId, item.yarn_id, item.fabric_id, item.trim_id]);

      const inStock = Number(stock?.bal ?? 0);
      const onOrderQty = Number(onOrder?.qty ?? 0);
      const net = Math.max(0, item.gross - inStock - onOrderQty);

      await txExecute(tx,
        `INSERT INTO trx_mrp_requirement
           (mrp_id, so_id, style_id, material_type, yarn_id, fabric_id, trim_id, color_id,
            gross_required, in_stock, on_order, net_required, uom_id, required_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [mrpId, body.so_id, item.style_id, item.material_type, item.yarn_id, item.fabric_id,
         item.trim_id, item.color_id, item.gross.toFixed(5), inStock.toFixed(5),
         onOrderQty.toFixed(5), net.toFixed(5), item.uom_id, so.ship_date]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_mrp_run WHERE id = ?`, [mrpId]);
  });

  await audit(req, 'trx_mrp_run', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

/**
 * Turn shortfalls from an MRP run into draft purchase orders, grouped by
 * supplier where a preferred supplier can be inferred, otherwise one PO per run.
 */
const toPoSchema = z.object({
  supplier_id: z.coerce.number().int().positive(),
  requirement_ids: z.array(z.coerce.number().int().positive()).min(1, 'Select at least one requirement'),
  currency_id: z.coerce.number().int().positive(),
  delivery_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

mrpRouter.post('/:id/create-po', requirePermission('PURCHASE.CREATE'), ah(async (req, res) => {
  const mrpId = Number(req.params.id);
  const body = toPoSchema.parse(req.body);

  const run = await queryOne(`SELECT * FROM trx_mrp_run WHERE id = ? AND company_id = ?`,
    [mrpId, req.user!.companyId]);
  if (!run) throw NotFound('MRP run not found');

  const created = await transaction(async (tx) => {
    const reqs = await txQuery<any>(
      tx,
      `SELECT r.*, COALESCE(y.std_rate, fb.std_rate, tr.std_rate, 0) AS std_rate
         FROM trx_mrp_requirement r
         LEFT JOIN mst_yarn y ON y.id = r.yarn_id
         LEFT JOIN mst_fabric fb ON fb.id = r.fabric_id
         LEFT JOIN mst_trim tr ON tr.id = r.trim_id
        WHERE r.mrp_id = ? AND r.id IN (${body.requirement_ids.map(() => '?').join(',')})`,
      [mrpId, ...body.requirement_ids]);
    if (!reqs.length) throw BadRequest('No matching requirements found');

    const poNo = await nextDocNumber(tx, req.user!.companyId, 'PURCHASE_ORDER');
    const r = await txExecute(tx,
      `INSERT INTO trx_purchase_order
         (company_id, po_no, po_date, supplier_id, po_type, so_id, mrp_id, currency_id,
          delivery_date, approval_state, created_by)
       VALUES (?,?,CURDATE(),?,'MATERIAL',?,?,?,?,'DRAFT',?)`,
      [req.user!.companyId, poNo, body.supplier_id, (run as any).so_id, mrpId,
       body.currency_id, body.delivery_date ?? null, req.user!.id]);
    const poId = r.insertId;

    let total = 0;
    for (const rq of reqs) {
      const qty = Number(rq.net_required);
      if (qty <= 0) continue;
      const rate = Number(rq.std_rate ?? 0);
      const amount = Number((qty * rate).toFixed(4));
      total += amount;
      await txExecute(tx,
        `INSERT INTO trx_purchase_order_line
           (po_id, material_type, yarn_id, fabric_id, trim_id, color_id, qty, uom_id, rate, amount)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [poId, rq.material_type, rq.yarn_id, rq.fabric_id, rq.trim_id, rq.color_id,
         qty.toFixed(5), rq.uom_id, rate, amount]);
    }
    await txExecute(tx,
      `UPDATE trx_purchase_order SET total_amount = ?, grand_total = ? WHERE id = ?`,
      [total.toFixed(4), total.toFixed(4), poId]);

    return txQueryOne(tx, `SELECT * FROM trx_purchase_order WHERE id = ?`, [poId]);
  });

  await audit(req, 'trx_purchase_order', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));
