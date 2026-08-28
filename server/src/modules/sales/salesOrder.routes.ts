import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Conflict } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const salesOrderRouter = Router();

const INCOTERM = ['FOB','CIF','CFR','EXW','DDP','DAP','FCA'] as const;
const PAYMENT  = ['LC','TT_ADVANCE','TT_AGAINST_DOC','DA','DP','CAD','OPEN'] as const;
const ORDER_TYPES = ['SAMPLE','PROJECTION','DOMESTIC','EXPORT'] as const;

const skuLineSchema = z.object({
  sku_id: s.idReq(),
  qty: z.coerce.number().int().min(0),
});

const lineSchema = z.object({
  style_id: s.idReq(),
  color_id: s.id(),
  description: s.nullableStr(255),
  unit_price: z.coerce.number().min(0),
  excess_pct: s.dec(),
  plan_cut_qty: z.coerce.number().int().min(0).optional(),
  ship_date: s.date(),
  /** Size-wise breakdown. Line order_qty is derived from the sum. */
  skus: z.array(skuLineSchema).default([]),
  /** Used only when no size breakdown is supplied. */
  order_qty: z.coerce.number().int().min(0).optional(),
});

const soSchema = z.object({
  branch_id: s.id(),
  so_no: s.nullableStr(40),
  io_no: s.nullableStr(60),
  order_type: z.enum(ORDER_TYPES).nullish(),
  so_date: s.date(),
  buyer_id: s.idReq(),
  agent_id: s.id(),
  merchandiser_id: s.id(),
  quotation_id: s.id(),
  buyer_po_no: s.nullableStr(60),
  buyer_po_date: s.date(),
  season: s.nullableStr(40),
  currency_id: s.idReq(),
  exchange_rate: s.dec(),
  incoterm: z.enum(INCOTERM).nullish(),
  port_of_loading: s.nullableStr(80),
  destination_country: s.id(),
  destination_port: s.nullableStr(80),
  payment_term: z.enum(PAYMENT).nullish(),
  lc_no: s.nullableStr(60), lc_date: s.date(), lc_expiry: s.date(),
  excess_pct: s.dec(),
  tolerance_plus_pct: s.dec(),
  tolerance_minus_pct: s.dec(),
  ship_date: s.date(), delivery_date: s.date(),
  status_id: s.id(),
  remarks: s.text(),
  lines: z.array(lineSchema).default([]),
});

/** A confirmed order is protected from casual edits. */
const LOCKED_STATES = ['APPROVED', 'CLOSED', 'CANCELLED'];

async function loadLines(id: number) {
  const lines = await query<any>(
    `SELECT l.*, st.style_code, st.style_name, c.color_name, c.color_code
       FROM trx_sales_order_line l
       LEFT JOIN mst_style st ON st.id = l.style_id
       LEFT JOIN mst_color c  ON c.id  = l.color_id
      WHERE l.so_id = ? ORDER BY l.id`, [id]);

  for (const l of lines) {
    l.skus = await query(
      `SELECT ss.*, k.sku_code, k.barcode, c.color_name, sz.size_code, sz.size_label, sz.sort_order
         FROM trx_sales_order_sku ss
         JOIN mst_style_sku k ON k.id = ss.sku_id
         JOIN mst_color c     ON c.id = k.color_id
         JOIN mst_size sz     ON sz.id = k.size_id
        WHERE ss.so_line_id = ? ORDER BY sz.sort_order, sz.id`, [l.id]);
  }
  return lines;
}

/** Recalculate header order_qty / total_amount / plan_cut_qty from the persisted lines. */
async function recalcHeader(tx: Tx, soId: number) {
  const agg = await txQueryOne<{ qty: number; amt: number; plan_cut: number }>(
    tx,
    `SELECT COALESCE(SUM(order_qty),0) AS qty,
            COALESCE(SUM(amount),0) AS amt,
            COALESCE(SUM(plan_cut_qty),0) AS plan_cut
       FROM trx_sales_order_line WHERE so_id = ?`, [soId]);
  await txExecute(tx,
    `UPDATE trx_sales_order SET order_qty = ?, total_amount = ?, plan_cut_qty = ? WHERE id = ?`,
    [agg?.qty ?? 0, agg?.amt ?? 0, agg?.plan_cut ?? (agg?.qty ?? 0), soId]);
}

async function writeLines(tx: Tx, soId: number, lines: z.infer<typeof lineSchema>[], headerExcessPct = 0) {
  for (const l of lines) {
    const skuQty = l.skus.reduce((a, x) => a + x.qty, 0);
    const qty = l.skus.length ? skuQty : (l.order_qty ?? 0);
    if (qty <= 0) throw BadRequest('Each order line needs a quantity greater than zero');
    const amount = Number((qty * l.unit_price).toFixed(4));
    const excessPct = Number(l.excess_pct !== undefined && l.excess_pct !== null ? l.excess_pct : headerExcessPct);
    const planCutQty = l.plan_cut_qty && l.plan_cut_qty > 0
      ? l.plan_cut_qty
      : Math.round(qty * (1 + (excessPct || 0) / 100));

    const r = await txExecute(tx,
      `INSERT INTO trx_sales_order_line
         (so_id, style_id, color_id, description, order_qty, excess_pct, plan_cut_qty, unit_price, amount, ship_date)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [soId, l.style_id, l.color_id ?? null, l.description ?? null, qty, excessPct, planCutQty, l.unit_price, amount,
       l.ship_date ?? null]);

    for (const sk of l.skus) {
      if (sk.qty <= 0) continue;   // skip empty cells in the size grid
      await txExecute(tx,
        `INSERT INTO trx_sales_order_sku (so_line_id, sku_id, qty) VALUES (?,?,?)`,
        [r.insertId, sk.sku_id, sk.qty]);
    }
  }
}

// ---------------------------------------------------------------- LIST
salesOrderRouter.get('/', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    q: z.string().trim().optional(),
    buyer_id: z.coerce.number().int().optional(),
    status_id: z.coerce.number().int().optional(),
    approval_state: z.string().optional(),
    season: z.string().optional(),
    dateFrom: z.string().optional(), dateTo: z.string().optional(),
  }).parse(req.query);

  const where = ['t.company_id = ?', 't.is_deleted = 0'];
  const params: unknown[] = [req.user!.companyId];
  if (q.q) {
    where.push('(t.so_no LIKE ? OR t.io_no LIKE ? OR t.buyer_po_no LIKE ? OR b.party_name LIKE ? OR mer.party_name LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  if (q.buyer_id) { where.push('t.buyer_id = ?'); params.push(q.buyer_id); }
  if (q.approval_state) { where.push('t.approval_state = ?'); params.push(q.approval_state); }
  for (const k of ['branch_id', 'agent_id', 'merchandiser_id', 'status_id', 'currency_id', 'season', 'order_type'] as const) {
    if ((q as any)[k]) { where.push(`t.${k} = ?`); params.push((q as any)[k]); }
  }
  if (q.dateFrom) { where.push('t.so_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo)   { where.push('t.so_date <= ?'); params.push(q.dateTo); }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(
      `SELECT t.*, b.party_name AS buyer_name, ag.party_name AS agent_name,
              mer.party_name AS merchandiser_name,
              cur.code AS currency_code, cs.label AS status_label, dc.name AS destination_name,
              (SELECT COALESCE(SUM(po.produced_qty),0) FROM trx_production_order po
                WHERE po.so_id = t.id) AS produced_qty
         FROM trx_sales_order t
         LEFT JOIN mst_party b   ON b.id  = t.buyer_id
         LEFT JOIN mst_party ag  ON ag.id = t.agent_id
         LEFT JOIN mst_party mer ON mer.id = t.merchandiser_id
         LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
         LEFT JOIN cfg_status cs ON cs.id = t.status_id
         LEFT JOIN cfg_country dc ON dc.id = t.destination_country
        WHERE ${clause} ORDER BY t.so_date DESC, t.id DESC
        LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM trx_sales_order t LEFT JOIN mst_party mer ON mer.id = t.merchandiser_id LEFT JOIN mst_party b ON b.id = t.buyer_id WHERE ${clause}`, params),
  ]);

  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

// ------------------------------------------------------------- GET ONE
salesOrderRouter.get('/:id', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const so = await queryOne(
    `SELECT t.*, b.party_name AS buyer_name, b.party_code AS buyer_code,
            ag.party_name AS agent_name, mer.party_name AS merchandiser_name, mer.party_code AS merchandiser_code,
            cur.code AS currency_code, cs.label AS status_label, dc.name AS destination_name
       FROM trx_sales_order t
       LEFT JOIN mst_party b   ON b.id  = t.buyer_id
       LEFT JOIN mst_party ag  ON ag.id = t.agent_id
       LEFT JOIN mst_party mer ON mer.id = t.merchandiser_id
       LEFT JOIN cfg_currency cur ON cur.id = t.currency_id
       LEFT JOIN cfg_status cs ON cs.id = t.status_id
       LEFT JOIN cfg_country dc ON dc.id = t.destination_country
      WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!so) throw NotFound('Sales order not found');

  const [lines, prodOrders, invoices] = await Promise.all([
    loadLines(id),
    query(`SELECT id, po_prod_no, style_id, order_qty, produced_qty, approval_state
             FROM trx_production_order WHERE so_id = ? ORDER BY id`, [id]),
    query(`SELECT id, invoice_no, invoice_date, total_value FROM trx_commercial_invoice
            WHERE so_id = ? ORDER BY id`, [id]),
  ]);
  res.json({ data: { ...so, lines, production_orders: prodOrders, invoices } });
}));

// -------------------------------------------------------------- CREATE
salesOrderRouter.post('/', requirePermission('SALES_ORDER.CREATE'), ah(async (req, res) => {
  const body = soSchema.parse(req.body);
  if (!body.lines.length) throw BadRequest('A sales order needs at least one line');

  const created = await transaction(async (tx) => {
    const soNo = body.so_no || await nextDocNumber(tx, req.user!.companyId, 'SALES_ORDER',
      { branchId: body.branch_id ?? null });
    const { lines, ...h } = body;

    const r = await txExecute(tx,
      `INSERT INTO trx_sales_order
        (company_id, branch_id, so_no, io_no, order_type, so_date, buyer_id, agent_id, merchandiser_id, quotation_id,
         buyer_po_no, buyer_po_date, season, currency_id, exchange_rate, incoterm,
         port_of_loading, destination_country, destination_port, payment_term,
         lc_no, lc_date, lc_expiry, excess_pct, tolerance_plus_pct, tolerance_minus_pct,
         ship_date, delivery_date, status_id,
         approval_state, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,
      [req.user!.companyId, h.branch_id ?? null, soNo, h.io_no ?? null, h.order_type ?? 'EXPORT', h.so_date ?? null, h.buyer_id,
       h.agent_id ?? null, h.merchandiser_id ?? null, h.quotation_id ?? null, h.buyer_po_no ?? null, h.buyer_po_date ?? null,
       h.season ?? null, h.currency_id, h.exchange_rate ?? 1, h.incoterm ?? 'FOB',
       h.port_of_loading ?? null, h.destination_country ?? null, h.destination_port ?? null,
       h.payment_term ?? 'LC', h.lc_no ?? null, h.lc_date ?? null, h.lc_expiry ?? null,
       h.excess_pct ?? 0, h.tolerance_plus_pct ?? 0, h.tolerance_minus_pct ?? 0,
       h.ship_date ?? null, h.delivery_date ?? null, h.status_id ?? null, h.remarks ?? null,
       req.user!.id]);

    await writeLines(tx, r.insertId, lines, Number(h.excess_pct) || 0);
    await recalcHeader(tx, r.insertId);
    return txQueryOne(tx, `SELECT * FROM trx_sales_order WHERE id = ?`, [r.insertId]);
  });

  await audit(req, 'trx_sales_order', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

// -------------------------------------------------------------- UPDATE
salesOrderRouter.put('/:id', requirePermission('SALES_ORDER.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne<any>(`SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Sales order not found');
  if (LOCKED_STATES.includes(before.approval_state)) {
    throw Conflict(`This order is ${before.approval_state.toLowerCase()} and can no longer be edited`);
  }

  const body = soSchema.partial().parse(req.body);
  const after = await transaction(async (tx) => {
    const { lines, ...h } = body;
    const cols: Record<string, unknown> = { ...h, updated_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (keys.length) {
      await txExecute(tx,
        `UPDATE trx_sales_order SET ${keys.map((k) => `${k} = ?`).join(', ')}
          WHERE id = ? AND company_id = ?`,
        [...keys.map((k) => cols[k]), id, req.user!.companyId]);
    }
    if (lines) {
      const existing = await txQuery<{ id: number }>(
        tx,
        `SELECT id FROM trx_sales_order_line WHERE so_id = ?`, [id]);
      for (const l of existing) {
        await txExecute(tx, `DELETE FROM trx_sales_order_sku WHERE so_line_id = ?`, [l.id]);
      }
      await txExecute(tx, `DELETE FROM trx_sales_order_line WHERE so_id = ?`, [id]);
      await writeLines(tx, id, lines, Number(h.excess_pct ?? before.excess_pct) || 0);
    }
    await recalcHeader(tx, id);
    return txQueryOne(tx, `SELECT * FROM trx_sales_order WHERE id = ?`, [id]);
  });

  await audit(req, 'trx_sales_order', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

// ------------------------------------------------------- STATE CHANGES
const stateSchema = z.object({
  approval_state: z.enum(['DRAFT','PENDING','APPROVED','REJECTED','ON_HOLD','CLOSED','CANCELLED']),
  remarks: s.nullableStr(500),
});

salesOrderRouter.post('/:id/approval-state', requirePermission('SALES_ORDER.APPROVE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { approval_state, remarks } = stateSchema.parse(req.body);
  const before = await queryOne<any>(`SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Sales order not found');

  const after = await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_sales_order SET approval_state = ?, updated_by = ? WHERE id = ?`,
      [approval_state, req.user!.id, id]);
    await txExecute(tx,
      `INSERT INTO trx_status_history (domain, record_id, to_status_id, remarks, changed_by)
       SELECT 'SALES_ORDER', ?, id, ?, ? FROM cfg_status
        WHERE domain = 'SALES_ORDER' AND code = ? LIMIT 1`,
      [id, remarks ?? `State changed to ${approval_state}`, req.user!.id, approval_state]);
    return txQueryOne(tx, `SELECT * FROM trx_sales_order WHERE id = ?`, [id]);
  });

  await audit(req, 'trx_sales_order', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

salesOrderRouter.delete('/:id', requirePermission('SALES_ORDER.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne<any>(`SELECT * FROM trx_sales_order WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Sales order not found');

  const used = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM trx_production_order WHERE so_id = ?`, [id]);
  if ((used?.n ?? 0) > 0) {
    throw Conflict('This order already has production orders and cannot be deleted. Cancel it instead.');
  }

  await transaction((tx) => txExecute(tx,
    `UPDATE trx_sales_order SET is_deleted = 1, updated_by = ? WHERE id = ?`, [req.user!.id, id]));
  await audit(req, 'trx_sales_order', id, 'DELETE', before, undefined);
  res.json({ data: { id, deleted: true } });
}));

/** Size-wise summary across the whole order — used by the packing screens. */
salesOrderRouter.get('/:id/size-summary', requirePermission('SALES_ORDER.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query(
    `SELECT sz.id AS size_id, sz.size_code, sz.size_label, sz.sort_order,
            c.id AS color_id, c.color_name, SUM(ss.qty) AS qty
       FROM trx_sales_order_sku ss
       JOIN trx_sales_order_line l ON l.id = ss.so_line_id
       JOIN mst_style_sku k ON k.id = ss.sku_id
       JOIN mst_size sz     ON sz.id = k.size_id
       JOIN mst_color c     ON c.id  = k.color_id
      WHERE l.so_id = ?
      GROUP BY sz.id, sz.size_code, sz.size_label, sz.sort_order, c.id, c.color_name
      ORDER BY c.color_name, sz.sort_order`, [id]);
  res.json({ data: rows });
}));
