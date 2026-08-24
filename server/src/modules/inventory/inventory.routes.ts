import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const inventoryRouter = Router();

const MATERIAL = ['YARN', 'FABRIC', 'TRIM'] as const;

/** Post one movement row to the append-only stock ledger. */
async function postLedger(tx: Tx, p: {
  companyId: number; warehouseId: number; binId?: number | null;
  materialType: string; yarnId?: number | null; fabricId?: number | null; trimId?: number | null;
  skuId?: number | null; colorId?: number | null; batchId?: number | null;
  txnType: string; refType: string; refId: number;
  qtyIn?: number; qtyOut?: number; uomId: number; rate?: number; userId: number;
}) {
  await txExecute(tx,
    `INSERT INTO trx_stock_ledger
       (company_id, warehouse_id, bin_id, material_type, yarn_id, fabric_id, trim_id,
        sku_id, color_id, batch_id, txn_type, ref_type, ref_id,
        qty_in, qty_out, uom_id, rate, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.companyId, p.warehouseId, p.binId ?? null, p.materialType,
     p.yarnId ?? null, p.fabricId ?? null, p.trimId ?? null, p.skuId ?? null,
     p.colorId ?? null, p.batchId ?? null, p.txnType, p.refType, p.refId,
     p.qtyIn ?? 0, p.qtyOut ?? 0, p.uomId, p.rate ?? 0, p.userId]);
}

// ============================================================== GRN
const grnLineSchema = z.object({
  po_line_id: s.id(),
  material_type: z.enum(MATERIAL),
  yarn_id: s.id(), fabric_id: s.id(), trim_id: s.id(), color_id: s.id(),
  batch_id: s.id(),
  /** Create a batch on the fly for traceability. */
  new_batch_no: s.nullableStr(50),
  shade_lot: s.nullableStr(40),
  received_qty: z.coerce.number().positive('Received quantity must be greater than zero'),
  accepted_qty: z.coerce.number().min(0),
  rejected_qty: z.coerce.number().min(0).default(0),
  uom_id: s.idReq(),
  bin_id: s.id(),
  rate: z.coerce.number().min(0).default(0),
}).refine((l) => l.accepted_qty + l.rejected_qty <= l.received_qty + 0.00001,
  { message: 'Accepted + rejected cannot exceed the received quantity' })
  .refine((l) => (l.material_type === 'YARN' && l.yarn_id) ||
                 (l.material_type === 'FABRIC' && l.fabric_id) ||
                 (l.material_type === 'TRIM' && l.trim_id),
  { message: 'Select a material matching the chosen material type' });

const grnSchema = z.object({
  grn_no: s.nullableStr(40),
  grn_date: s.date(),
  po_id: s.id(),
  supplier_id: s.idReq(),
  warehouse_id: s.idReq(),
  supplier_dc_no: s.nullableStr(60),
  supplier_inv_no: s.nullableStr(60),
  vehicle_no: s.nullableStr(30),
  status_id: s.id(),
  remarks: s.nullableStr(500),
  lines: z.array(grnLineSchema).min(1, 'A GRN needs at least one line'),
});

inventoryRouter.get('/grns', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    q: z.string().trim().optional(),
    supplier_id: z.coerce.number().int().optional(),
    warehouse_id: z.coerce.number().int().optional(),
    po_id: z.coerce.number().int().optional(),
  }).parse(req.query);

  const where = ['t.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  if (q.q) { where.push('(t.grn_no LIKE ? OR t.supplier_dc_no LIKE ? OR t.supplier_inv_no LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  for (const k of ['supplier_id', 'warehouse_id', 'po_id'] as const) {
    if (q[k]) { where.push(`t.${k} = ?`); params.push(q[k]); }
  }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(`SELECT t.*, sup.party_name AS supplier_name, w.warehouse_name, po.po_no,
                  (SELECT COUNT(*) FROM trx_grn_line gl WHERE gl.grn_id = t.id) AS line_count
             FROM trx_grn t
             LEFT JOIN mst_party sup ON sup.id = t.supplier_id
             LEFT JOIN mst_warehouse w ON w.id = t.warehouse_id
             LEFT JOIN trx_purchase_order po ON po.id = t.po_id
            WHERE ${clause} ORDER BY t.grn_date DESC, t.id DESC
            LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM trx_grn t WHERE ${clause}`, params),
  ]);
  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

inventoryRouter.get('/grns/:id', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const grn = await queryOne(
    `SELECT t.*, sup.party_name AS supplier_name, w.warehouse_name, po.po_no
       FROM trx_grn t
       LEFT JOIN mst_party sup ON sup.id = t.supplier_id
       LEFT JOIN mst_warehouse w ON w.id = t.warehouse_id
       LEFT JOIN trx_purchase_order po ON po.id = t.po_id
      WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!grn) throw NotFound('GRN not found');

  const lines = await query(
    `SELECT l.*, y.yarn_name, fb.fabric_name, tr.trim_name, c.color_name,
            u.code AS uom_code, b.batch_no, b.shade_lot, bn.bin_code
       FROM trx_grn_line l
       LEFT JOIN mst_yarn y ON y.id = l.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = l.trim_id
       LEFT JOIN mst_color c ON c.id = l.color_id
       LEFT JOIN cfg_uom u ON u.id = l.uom_id
       LEFT JOIN mst_batch b ON b.id = l.batch_id
       LEFT JOIN mst_warehouse_bin bn ON bn.id = l.bin_id
      WHERE l.grn_id = ? ORDER BY l.id`, [id]);
  res.json({ data: { ...grn, lines } });
}));

/**
 * Create a GRN. Accepted quantities post into the stock ledger and roll up
 * onto the PO line's received_qty — all inside one transaction.
 */
inventoryRouter.post('/grns', requirePermission('GRN.CREATE'), ah(async (req, res) => {
  const body = grnSchema.parse(req.body);

  const created = await transaction(async (tx) => {
    const grnNo = body.grn_no || await nextDocNumber(tx, req.user!.companyId, 'GRN');
    const r = await txExecute(tx,
      `INSERT INTO trx_grn (company_id, grn_no, grn_date, po_id, supplier_id, warehouse_id,
                            supplier_dc_no, supplier_inv_no, vehicle_no, status_id, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, grnNo, body.grn_date ?? null, body.po_id ?? null, body.supplier_id,
       body.warehouse_id, body.supplier_dc_no ?? null, body.supplier_inv_no ?? null,
       body.vehicle_no ?? null, body.status_id ?? null, body.remarks ?? null, req.user!.id]);
    const grnId = r.insertId;

    for (const l of body.lines) {
      let batchId = l.batch_id ?? null;

      if (!batchId && l.new_batch_no) {
        const b = await txExecute(tx,
          `INSERT INTO mst_batch (company_id, batch_no, material_type, yarn_id, fabric_id,
                                  trim_id, supplier_id, received_date, shade_lot)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [req.user!.companyId, l.new_batch_no, l.material_type, l.yarn_id ?? null,
           l.fabric_id ?? null, l.trim_id ?? null, body.supplier_id,
           body.grn_date ?? null, l.shade_lot ?? null]);
        batchId = b.insertId;
      }

      await txExecute(tx,
        `INSERT INTO trx_grn_line (grn_id, po_line_id, material_type, yarn_id, fabric_id, trim_id,
                                   color_id, batch_id, received_qty, accepted_qty, rejected_qty, uom_id, bin_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [grnId, l.po_line_id ?? null, l.material_type, l.yarn_id ?? null, l.fabric_id ?? null,
         l.trim_id ?? null, l.color_id ?? null, batchId, l.received_qty, l.accepted_qty,
         l.rejected_qty ?? 0, l.uom_id, l.bin_id ?? null]);

      // Only accepted stock enters inventory.
      if (l.accepted_qty > 0) {
        await postLedger(tx, {
          companyId: req.user!.companyId, warehouseId: body.warehouse_id, binId: l.bin_id,
          materialType: l.material_type, yarnId: l.yarn_id, fabricId: l.fabric_id,
          trimId: l.trim_id, colorId: l.color_id, batchId,
          txnType: 'GRN', refType: 'GRN', refId: grnId,
          qtyIn: l.accepted_qty, uomId: l.uom_id, rate: l.rate ?? 0, userId: req.user!.id,
        });
      }

      if (l.po_line_id) {
        await txExecute(tx,
          `UPDATE trx_purchase_order_line SET received_qty = received_qty + ? WHERE id = ?`,
          [l.accepted_qty, l.po_line_id]);
      }
    }

    return txQueryOne(tx, `SELECT * FROM trx_grn WHERE id = ?`, [grnId]);
  });

  await audit(req, 'trx_grn', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

// ==================================================== MATERIAL ISSUE
const issueLineSchema = z.object({
  material_type: z.enum(MATERIAL),
  yarn_id: s.id(), fabric_id: s.id(), trim_id: s.id(), color_id: s.id(), batch_id: s.id(),
  issued_qty: z.coerce.number().positive('Issued quantity must be greater than zero'),
  uom_id: s.idReq(),
});

const issueSchema = z.object({
  issue_no: s.nullableStr(40),
  issue_date: s.date(),
  warehouse_id: s.idReq(),
  prod_order_id: s.id(),
  issued_to_unit: s.id(),
  status_id: s.id(),
  remarks: s.nullableStr(500),
  /** Block the issue when it would drive stock negative. */
  allow_negative: z.boolean().default(false),
  lines: z.array(issueLineSchema).min(1, 'A material issue needs at least one line'),
});

/** Current on-hand quantity for one item in one warehouse. */
async function stockOnHand(tx: Tx, companyId: number, warehouseId: number, l: {
  material_type: string; yarn_id?: number | null; fabric_id?: number | null;
  trim_id?: number | null; batch_id?: number | null;
}) {
  const row = await txQueryOne<{ bal: number }>(
    tx,
    `SELECT COALESCE(SUM(qty_in) - SUM(qty_out), 0) AS bal
       FROM trx_stock_ledger
      WHERE company_id = ? AND warehouse_id = ? AND material_type = ?
        AND (yarn_id   <=> ?) AND (fabric_id <=> ?) AND (trim_id <=> ?)
        AND (? IS NULL OR batch_id <=> ?)`,
    [companyId, warehouseId, l.material_type, l.yarn_id ?? null, l.fabric_id ?? null,
     l.trim_id ?? null, l.batch_id ?? null, l.batch_id ?? null]);
  return Number(row?.bal ?? 0);
}

inventoryRouter.get('/issues', requirePermission('ISSUE.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    q: z.string().trim().optional(),
    prod_order_id: z.coerce.number().int().optional(),
    warehouse_id: z.coerce.number().int().optional(),
  }).parse(req.query);

  const where = ['t.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  if (q.q) { where.push('t.issue_no LIKE ?'); params.push(`%${q.q}%`); }
  for (const k of ['prod_order_id', 'warehouse_id'] as const) {
    if (q[k]) { where.push(`t.${k} = ?`); params.push(q[k]); }
  }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(`SELECT t.*, w.warehouse_name, po.po_prod_no, un.unit_name,
                  (SELECT COUNT(*) FROM trx_material_issue_line il WHERE il.issue_id = t.id) AS line_count
             FROM trx_material_issue t
             LEFT JOIN mst_warehouse w ON w.id = t.warehouse_id
             LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
             LEFT JOIN mst_unit un ON un.id = t.issued_to_unit
            WHERE ${clause} ORDER BY t.issue_date DESC, t.id DESC
            LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM trx_material_issue t WHERE ${clause}`, params),
  ]);
  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

inventoryRouter.get('/issues/:id', requirePermission('ISSUE.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const issue = await queryOne(
    `SELECT t.*, w.warehouse_name, po.po_prod_no, un.unit_name
       FROM trx_material_issue t
       LEFT JOIN mst_warehouse w ON w.id = t.warehouse_id
       LEFT JOIN trx_production_order po ON po.id = t.prod_order_id
       LEFT JOIN mst_unit un ON un.id = t.issued_to_unit
      WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!issue) throw NotFound('Material issue not found');

  const lines = await query(
    `SELECT l.*, y.yarn_name, fb.fabric_name, tr.trim_name, c.color_name,
            u.code AS uom_code, b.batch_no
       FROM trx_material_issue_line l
       LEFT JOIN mst_yarn y ON y.id = l.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id
       LEFT JOIN mst_trim tr ON tr.id = l.trim_id
       LEFT JOIN mst_color c ON c.id = l.color_id
       LEFT JOIN cfg_uom u ON u.id = l.uom_id
       LEFT JOIN mst_batch b ON b.id = l.batch_id
      WHERE l.issue_id = ? ORDER BY l.id`, [id]);
  res.json({ data: { ...issue, lines } });
}));

inventoryRouter.post('/issues', requirePermission('ISSUE.CREATE'), ah(async (req, res) => {
  const body = issueSchema.parse(req.body);

  const created = await transaction(async (tx) => {
    // Validate availability before writing anything.
    if (!body.allow_negative) {
      for (const l of body.lines) {
        const bal = await stockOnHand(tx, req.user!.companyId, body.warehouse_id, l);
        if (l.issued_qty > bal + 0.00001) {
          const name = l.yarn_id ? 'yarn' : l.fabric_id ? 'fabric' : 'trim';
          throw BadRequest(
            `Insufficient stock for ${name}: requested ${l.issued_qty}, available ${bal.toFixed(3)}`);
        }
      }
    }

    const issueNo = body.issue_no || await nextDocNumber(tx, req.user!.companyId, 'MAT_ISSUE');
    const r = await txExecute(tx,
      `INSERT INTO trx_material_issue (company_id, issue_no, issue_date, warehouse_id,
                                       prod_order_id, issued_to_unit, status_id, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, issueNo, body.issue_date ?? null, body.warehouse_id,
       body.prod_order_id ?? null, body.issued_to_unit ?? null, body.status_id ?? null,
       body.remarks ?? null, req.user!.id]);
    const issueId = r.insertId;

    for (const l of body.lines) {
      await txExecute(tx,
        `INSERT INTO trx_material_issue_line (issue_id, material_type, yarn_id, fabric_id,
                                              trim_id, color_id, batch_id, issued_qty, uom_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [issueId, l.material_type, l.yarn_id ?? null, l.fabric_id ?? null, l.trim_id ?? null,
         l.color_id ?? null, l.batch_id ?? null, l.issued_qty, l.uom_id]);

      await postLedger(tx, {
        companyId: req.user!.companyId, warehouseId: body.warehouse_id,
        materialType: l.material_type, yarnId: l.yarn_id, fabricId: l.fabric_id,
        trimId: l.trim_id, colorId: l.color_id, batchId: l.batch_id,
        txnType: 'ISSUE', refType: 'MATERIAL_ISSUE', refId: issueId,
        qtyOut: l.issued_qty, uomId: l.uom_id, userId: req.user!.id,
      });
    }
    return txQueryOne(tx, `SELECT * FROM trx_material_issue WHERE id = ?`, [issueId]);
  });

  await audit(req, 'trx_material_issue', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

// ================================================== STOCK ENQUIRY
/** Current stock balances derived from the ledger. */
inventoryRouter.get('/stock', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const q = z.object({
    warehouse_id: z.coerce.number().int().optional(),
    material_type: z.enum(['YARN','FABRIC','TRIM','FINISHED','WIP']).optional(),
    q: z.string().trim().optional(),
    onlyInStock: z.coerce.boolean().default(false),
  }).parse(req.query);

  const where = ['sl.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  if (q.warehouse_id)  { where.push('sl.warehouse_id = ?'); params.push(q.warehouse_id); }
  if (q.material_type) { where.push('sl.material_type = ?'); params.push(q.material_type); }
  if (q.q) {
    where.push('(y.yarn_name LIKE ? OR fb.fabric_name LIKE ? OR tr.trim_name LIKE ? OR k.sku_code LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }

  const rows = await query(
    `SELECT sl.material_type, sl.warehouse_id, w.warehouse_name,
            sl.bin_id, bn.bin_code, bn.rack,
            sl.yarn_id, sl.fabric_id, sl.trim_id, sl.sku_id, sl.batch_id,
            COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name, k.sku_code) AS item_name,
            COALESCE(y.yarn_code, fb.fabric_code, tr.trim_code, k.sku_code) AS item_code,
            b.batch_no, b.shade_lot, u.code AS uom_code,
            SUM(sl.qty_in)  AS total_in,
            SUM(sl.qty_out) AS total_out,
            SUM(sl.qty_in) - SUM(sl.qty_out) AS balance
       FROM trx_stock_ledger sl
       LEFT JOIN mst_warehouse w ON w.id = sl.warehouse_id
       LEFT JOIN mst_warehouse_bin bn ON bn.id = sl.bin_id
       LEFT JOIN mst_yarn y   ON y.id  = sl.yarn_id
       LEFT JOIN mst_fabric fb ON fb.id = sl.fabric_id
       LEFT JOIN mst_trim tr  ON tr.id = sl.trim_id
       LEFT JOIN mst_style_sku k ON k.id = sl.sku_id
       LEFT JOIN mst_batch b  ON b.id  = sl.batch_id
       LEFT JOIN cfg_uom u    ON u.id  = sl.uom_id
      WHERE ${where.join(' AND ')}
      GROUP BY sl.material_type, sl.warehouse_id, w.warehouse_name,
               sl.bin_id, bn.bin_code, bn.rack,
               sl.yarn_id, sl.fabric_id, sl.trim_id, sl.sku_id, sl.batch_id,
               item_name, item_code, b.batch_no, b.shade_lot, u.code
      ${q.onlyInStock ? 'HAVING balance > 0' : ''}
      ORDER BY sl.material_type, item_name`, params);

  res.json({ data: rows });
}));

/** Full movement history for one item — the stock ledger drill-down. */
inventoryRouter.get('/ledger', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(50),
    warehouse_id: z.coerce.number().int().optional(),
    bin_id: z.coerce.number().int().optional(),
    material_type: z.string().optional(),
    yarn_id: z.coerce.number().int().optional(),
    fabric_id: z.coerce.number().int().optional(),
    trim_id: z.coerce.number().int().optional(),
    sku_id: z.coerce.number().int().optional(),
    batch_id: z.coerce.number().int().optional(),
    dateFrom: z.string().optional(), dateTo: z.string().optional(),
  }).parse(req.query);

  const where = ['sl.company_id = ?']; const params: unknown[] = [req.user!.companyId];
  for (const k of ['warehouse_id','bin_id','material_type','yarn_id','fabric_id','trim_id','sku_id','batch_id'] as const) {
    if ((q as any)[k]) { where.push(`sl.${k} = ?`); params.push((q as any)[k]); }
  }
  if (q.dateFrom) { where.push('sl.txn_date >= ?'); params.push(q.dateFrom); }
  if (q.dateTo)   { where.push('sl.txn_date <= ?'); params.push(`${q.dateTo} 23:59:59`); }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(`SELECT sl.*, w.warehouse_name, bn.bin_code, bn.rack, u.code AS uom_code, b.batch_no, b.shade_lot,
                  COALESCE(y.yarn_name, fb.fabric_name, tr.trim_name, k.sku_code) AS item_name,
                  usr.full_name AS created_by_name
             FROM trx_stock_ledger sl
             LEFT JOIN mst_warehouse w ON w.id = sl.warehouse_id
             LEFT JOIN mst_warehouse_bin bn ON bn.id = sl.bin_id
             LEFT JOIN cfg_uom u ON u.id = sl.uom_id
             LEFT JOIN mst_batch b ON b.id = sl.batch_id
             LEFT JOIN mst_yarn y ON y.id = sl.yarn_id
             LEFT JOIN mst_fabric fb ON fb.id = sl.fabric_id
             LEFT JOIN mst_trim tr ON tr.id = sl.trim_id
             LEFT JOIN mst_style_sku k ON k.id = sl.sku_id
             LEFT JOIN mst_user usr ON usr.id = sl.created_by
            WHERE ${clause} ORDER BY sl.txn_date DESC, sl.id DESC
            LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM trx_stock_ledger sl WHERE ${clause}`, params),
  ]);
  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

/** Manual stock adjustment (cycle count corrections). */
const adjustSchema = z.object({
  warehouse_id: s.idReq(),
  material_type: z.enum(['YARN','FABRIC','TRIM','FINISHED']),
  yarn_id: s.id(), fabric_id: s.id(), trim_id: s.id(), sku_id: s.id(),
  batch_id: s.id(), bin_id: s.id(),
  qty: z.coerce.number().refine((n) => n !== 0, 'Adjustment quantity cannot be zero'),
  uom_id: s.idReq(),
  remarks: s.strReq(255),
});

inventoryRouter.post('/adjust', requirePermission('INVENTORY.ADJUST'), ah(async (req, res) => {
  const body = adjustSchema.parse(req.body);
  await transaction(async (tx) => {
    await postLedger(tx, {
      companyId: req.user!.companyId, warehouseId: body.warehouse_id, binId: body.bin_id,
      materialType: body.material_type, yarnId: body.yarn_id, fabricId: body.fabric_id,
      trimId: body.trim_id, skuId: body.sku_id, batchId: body.batch_id,
      txnType: 'ADJUST', refType: 'ADJUSTMENT', refId: 0,
      qtyIn: body.qty > 0 ? body.qty : 0,
      qtyOut: body.qty < 0 ? Math.abs(body.qty) : 0,
      uomId: body.uom_id, userId: req.user!.id,
    });
  });
  await audit(req, 'trx_stock_ledger', 0, 'INSERT', undefined, body);
  res.status(201).json({ data: { success: true } });
}));
