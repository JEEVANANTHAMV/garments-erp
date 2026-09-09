import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const cuttingPlanRouter = Router();

// ============================================================
// CUTTING PLAN CRUD
// ============================================================

const sizeLineSchema = z.object({
  size_id: s.idReq(),
  sku_id: s.id(),
  order_qty: z.coerce.number().int().min(0).default(0),
  planned_qty: z.coerce.number().int().min(0).default(0),
});

const cuttingPlanSchema = z.object({
  plan_no: s.nullableStr(40),
  plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.strReq(40),
  so_id: s.id(),
  prod_order_id: s.id(),
  style_id: s.idReq(),
  color_id: s.id(),
  order_qty: z.coerce.number().int().min(0).default(0),
  planned_cut_qty: z.coerce.number().int().min(0).default(0),
  required_date: s.date(),
  marker_ref: s.nullableStr(60),
  marker_eff_pct: s.dec(),
  fabric_id: s.id(),
  fabric_req_kg: s.dec(),
  fabric_req_mtr: s.dec(),
  status: z.enum(['DRAFT','APPROVED','RELEASED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED']).default('DRAFT'),
  remarks: s.text(),
  sizes: z.array(sizeLineSchema).default([]),
});

/** GET /cutting-plans — List all cutting plans */
cuttingPlanRouter.get('/cutting-plans', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT cp.*,
            st.style_code, st.style_name,
            col.color_name,
            so.so_no,
            po.po_prod_no,
            fab.fabric_name
       FROM trx_cutting_plan cp
       LEFT JOIN mst_style st ON st.id = cp.style_id
       LEFT JOIN mst_color col ON col.id = cp.color_id
       LEFT JOIN trx_sales_order so ON so.id = cp.so_id
       LEFT JOIN trx_production_order po ON po.id = cp.prod_order_id
       LEFT JOIN mst_fabric fab ON fab.id = cp.fabric_id
      WHERE cp.company_id = ?
      ORDER BY cp.plan_date DESC, cp.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /cutting-plans/:id — Single cutting plan with size breakdown */
cuttingPlanRouter.get('/cutting-plans/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(
    `SELECT cp.*,
            st.style_code, st.style_name,
            col.color_name,
            so.so_no,
            po.po_prod_no,
            fab.fabric_name
       FROM trx_cutting_plan cp
       LEFT JOIN mst_style st ON st.id = cp.style_id
       LEFT JOIN mst_color col ON col.id = cp.color_id
       LEFT JOIN trx_sales_order so ON so.id = cp.so_id
       LEFT JOIN trx_production_order po ON po.id = cp.prod_order_id
       LEFT JOIN mst_fabric fab ON fab.id = cp.fabric_id
      WHERE cp.id = ? AND cp.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('Cutting plan not found');

  const sizes = await query(
    `SELECT cps.*, sz.size_code, sz.size_label, sz.sort_order, k.sku_code
       FROM trx_cutting_plan_size cps
       LEFT JOIN mst_size sz ON sz.id = cps.size_id
       LEFT JOIN mst_style_sku k ON k.id = cps.sku_id
      WHERE cps.cutting_plan_id = ?
      ORDER BY sz.sort_order`, [id]);

  res.json({ data: { ...(row as any), sizes } });
}));

/** POST /cutting-plans — Create new cutting plan */
cuttingPlanRouter.post('/cutting-plans', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = cuttingPlanSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const planNo = body.plan_no || await nextDocNumber(tx, cid, 'CUT_PLAN');

    const r = await txExecute(tx,
      `INSERT INTO trx_cutting_plan
        (company_id, plan_no, plan_date, io_no, so_id, prod_order_id, style_id, color_id,
         order_qty, planned_cut_qty, required_date, marker_ref, marker_eff_pct,
         fabric_id, fabric_req_kg, fabric_req_mtr, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, planNo, body.plan_date, body.io_no, body.so_id ?? null, body.prod_order_id ?? null,
       body.style_id, body.color_id ?? null, body.order_qty, body.planned_cut_qty,
       body.required_date ?? null, body.marker_ref ?? null, body.marker_eff_pct ?? null,
       body.fabric_id ?? null, body.fabric_req_kg ?? null, body.fabric_req_mtr ?? null,
       body.status, body.remarks ?? null, req.user!.id]);

    const planId = r.insertId;

    for (const sz of body.sizes) {
      await txExecute(tx,
        `INSERT INTO trx_cutting_plan_size (cutting_plan_id, size_id, sku_id, order_qty, planned_qty)
         VALUES (?,?,?,?,?)`,
        [planId, sz.size_id, sz.sku_id ?? null, sz.order_qty, sz.planned_qty]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_cutting_plan WHERE id = ?`, [planId]);
  });

  await audit(req, 'trx_cutting_plan', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));

/** PUT /cutting-plans/:id — Update cutting plan */
cuttingPlanRouter.put('/cutting-plans/:id', requirePermission('PRODUCTION.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = cuttingPlanSchema.parse(req.body);

  const existing = await queryOne(`SELECT * FROM trx_cutting_plan WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Cutting plan not found');

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_cutting_plan SET
        plan_date = ?, io_no = ?, so_id = ?, prod_order_id = ?, style_id = ?, color_id = ?,
        order_qty = ?, planned_cut_qty = ?, required_date = ?, marker_ref = ?, marker_eff_pct = ?,
        fabric_id = ?, fabric_req_kg = ?, fabric_req_mtr = ?, status = ?, remarks = ?, updated_by = ?
       WHERE id = ?`,
      [body.plan_date, body.io_no, body.so_id ?? null, body.prod_order_id ?? null,
       body.style_id, body.color_id ?? null, body.order_qty, body.planned_cut_qty,
       body.required_date ?? null, body.marker_ref ?? null, body.marker_eff_pct ?? null,
       body.fabric_id ?? null, body.fabric_req_kg ?? null, body.fabric_req_mtr ?? null,
       body.status, body.remarks ?? null, req.user!.id, id]);

    // Replace sizes
    await txExecute(tx, `DELETE FROM trx_cutting_plan_size WHERE cutting_plan_id = ?`, [id]);
    for (const sz of body.sizes) {
      await txExecute(tx,
        `INSERT INTO trx_cutting_plan_size (cutting_plan_id, size_id, sku_id, order_qty, planned_qty)
         VALUES (?,?,?,?,?)`,
        [id, sz.size_id, sz.sku_id ?? null, sz.order_qty, sz.planned_qty]);
    }
  });

  const updated = await queryOne(`SELECT * FROM trx_cutting_plan WHERE id = ?`, [id]);
  await audit(req, 'trx_cutting_plan', id, 'UPDATE', existing, updated);
  res.json({ data: updated });
}));


// ============================================================
// BUNDLE MANAGEMENT
// ============================================================

/** POST /bundles/generate — Generate bundles from a cutting transaction */
cuttingPlanRouter.post('/bundles/generate', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    cutting_id: s.idReq(),
    io_no: s.strReq(40),
    style_id: s.idReq(),
    color_id: s.idReq(),
    size_id: s.idReq(),
    sku_id: s.id(),
    total_qty: z.coerce.number().int().positive(),
    bundle_size: z.coerce.number().int().positive(),
    component: z.string().trim().max(60).default('BODY'),
    line_destination: s.nullableStr(40),
  }).parse(req.body);

  const cutting = await queryOne(
    `SELECT c.* FROM trx_cutting c
       JOIN trx_production_order po ON po.id = c.prod_order_id
      WHERE c.id = ? AND po.company_id = ?`, [body.cutting_id, cid]);
  if (!cutting) throw NotFound('Cutting transaction not found');

  const bundleCount = Math.ceil(body.total_qty / body.bundle_size);
  let remaining = body.total_qty;

  const bundles = await transaction(async (tx) => {
    const created: any[] = [];
    for (let i = 1; i <= bundleCount; i++) {
      const qty = Math.min(body.bundle_size, remaining);
      remaining -= qty;
      const bundleNo = `${body.io_no}-${String(i).padStart(3, '0')}`;

      const r = await txExecute(tx,
        `INSERT INTO trx_cutting_bundle
          (cutting_id, io_no, style_id, color_id, size_id, component, sku_id, bundle_no, qty, status)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [body.cutting_id, body.io_no, body.style_id, body.color_id, body.size_id,
         body.component, body.sku_id ?? null, bundleNo, qty, 'GENERATED']);

      created.push({ id: r.insertId, bundle_no: bundleNo, qty, status: 'GENERATED' });
    }
    return created;
  });

  res.status(201).json({ data: { bundles, count: bundles.length } });
}));

/** GET /bundles — List bundles with filtering */
cuttingPlanRouter.get('/bundles', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const ioNo = req.query.io_no ? String(req.query.io_no) : null;
  const status = req.query.status ? String(req.query.status) : null;

  let sql = `SELECT cb.*, c.cut_no, st.style_code, col.color_name, sz.size_code
       FROM trx_cutting_bundle cb
       JOIN trx_cutting c ON c.id = cb.cutting_id
       JOIN trx_production_order po ON po.id = c.prod_order_id
       LEFT JOIN mst_style st ON st.id = cb.style_id
       LEFT JOIN mst_color col ON col.id = cb.color_id
       LEFT JOIN mst_size sz ON sz.id = cb.size_id
      WHERE po.company_id = ?`;
  const params: any[] = [cid];

  if (ioNo) { sql += ` AND cb.io_no = ?`; params.push(ioNo); }
  if (status) { sql += ` AND cb.status = ?`; params.push(status); }
  sql += ` ORDER BY cb.id DESC`;

  const rows = await query(sql, params);
  res.json({ data: rows });
}));

/** POST /bundles/:id/move — Move bundle to next stage */
cuttingPlanRouter.post('/bundles/:id/move', requirePermission('PRODUCTION.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const bundleId = Number(req.params.id);
  const body = z.object({
    to_stage: z.enum(['CHECKED','ISSUED','IN_SEWING','COMPLETED','FINISHING','CLOSED']),
    destination: s.nullableStr(80),
    remarks: s.nullableStr(255),
  }).parse(req.body);

  const bundle = await queryOne<{ id: number; io_no: string; style_id: number; status: string; qty: number }>(
    `SELECT cb.*, po.company_id FROM trx_cutting_bundle cb
       JOIN trx_cutting c ON c.id = cb.cutting_id
       JOIN trx_production_order po ON po.id = c.prod_order_id
      WHERE cb.id = ? AND po.company_id = ?`, [bundleId, cid]);
  if (!bundle) throw NotFound('Bundle not found');

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_cutting_bundle SET status = ? WHERE id = ?`, [body.to_stage, bundleId]);

    await txExecute(tx,
      `INSERT INTO trx_bundle_movement
        (company_id, bundle_id, io_no, style_id, from_stage, to_stage, moved_qty, moved_by, destination, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [cid, bundleId, bundle.io_no, bundle.style_id, bundle.status, body.to_stage,
       bundle.qty, req.user!.id, body.destination ?? null, body.remarks ?? null]);
  });

  res.json({ data: { id: bundleId, status: body.to_stage } });
}));

/** GET /bundles/:id/history — Bundle movement history */
cuttingPlanRouter.get('/bundles/:id/history', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const rows = await query(
    `SELECT bm.*, u.full_name AS moved_by_name
       FROM trx_bundle_movement bm
       LEFT JOIN mst_user u ON u.id = bm.moved_by
      WHERE bm.bundle_id = ?
      ORDER BY bm.moved_at`, [Number(req.params.id)]);
  res.json({ data: rows });
}));


// ============================================================
// FG RECEIPT
// ============================================================

const fgLineSchema = z.object({
  color_id: s.idReq(),
  size_id: s.idReq(),
  sku_id: s.id(),
  good_qty: z.coerce.number().int().min(0).default(0),
  reject_qty: z.coerce.number().int().min(0).default(0),
  batch_no: s.nullableStr(40),
});

const fgReceiptSchema = z.object({
  receipt_no: s.nullableStr(40),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.strReq(40),
  so_id: s.id(),
  prod_order_id: s.id(),
  style_id: s.idReq(),
  warehouse_id: s.id(),
  source_stage: z.string().trim().max(40).default('FINISHING'),
  source_ref: s.nullableStr(60),
  status: z.enum(['DRAFT','RECEIVED','CONFIRMED','CLOSED']).default('DRAFT'),
  remarks: s.text(),
  lines: z.array(fgLineSchema).default([]),
});

/** GET /fg-receipts — List all FG receipts */
cuttingPlanRouter.get('/fg-receipts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT fg.*, st.style_code, st.style_name, so.so_no, wh.warehouse_name
       FROM trx_fg_receipt fg
       LEFT JOIN mst_style st ON st.id = fg.style_id
       LEFT JOIN trx_sales_order so ON so.id = fg.so_id
       LEFT JOIN mst_warehouse wh ON wh.id = fg.warehouse_id
      WHERE fg.company_id = ?
      ORDER BY fg.receipt_date DESC, fg.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /fg-receipts/:id — Single FG receipt with lines */
cuttingPlanRouter.get('/fg-receipts/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const row = await queryOne(
    `SELECT fg.*, st.style_code, st.style_name, so.so_no, wh.warehouse_name
       FROM trx_fg_receipt fg
       LEFT JOIN mst_style st ON st.id = fg.style_id
       LEFT JOIN trx_sales_order so ON so.id = fg.so_id
       LEFT JOIN mst_warehouse wh ON wh.id = fg.warehouse_id
      WHERE fg.id = ? AND fg.company_id = ?`, [id, cid]);
  if (!row) throw NotFound('FG receipt not found');

  const lines = await query(
    `SELECT l.*, col.color_name, sz.size_code, sz.size_label, sz.sort_order, k.sku_code
       FROM trx_fg_receipt_line l
       LEFT JOIN mst_color col ON col.id = l.color_id
       LEFT JOIN mst_size sz ON sz.id = l.size_id
       LEFT JOIN mst_style_sku k ON k.id = l.sku_id
      WHERE l.fg_receipt_id = ?
      ORDER BY col.color_name, sz.sort_order`, [id]);

  res.json({ data: { ...(row as any), lines } });
}));

/** POST /fg-receipts — Create FG receipt */
cuttingPlanRouter.post('/fg-receipts', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = fgReceiptSchema.parse(req.body);

  const totalGood = body.lines.reduce((sum, l) => sum + l.good_qty, 0);
  const totalReject = body.lines.reduce((sum, l) => sum + l.reject_qty, 0);

  const result = await transaction(async (tx) => {
    const receiptNo = body.receipt_no || await nextDocNumber(tx, cid, 'FG_RECEIPT');

    const r = await txExecute(tx,
      `INSERT INTO trx_fg_receipt
        (company_id, receipt_no, receipt_date, io_no, so_id, prod_order_id, style_id,
         warehouse_id, source_stage, source_ref, total_qty, total_reject, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, body.receipt_date, body.io_no, body.so_id ?? null, body.prod_order_id ?? null,
       body.style_id, body.warehouse_id ?? null, body.source_stage, body.source_ref ?? null,
       totalGood, totalReject, body.status, body.remarks ?? null, req.user!.id]);

    const fgId = r.insertId;

    for (const line of body.lines) {
      await txExecute(tx,
        `INSERT INTO trx_fg_receipt_line (fg_receipt_id, color_id, size_id, sku_id, good_qty, reject_qty, batch_no)
         VALUES (?,?,?,?,?,?,?)`,
        [fgId, line.color_id, line.size_id, line.sku_id ?? null, line.good_qty, line.reject_qty, line.batch_no ?? null]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_fg_receipt WHERE id = ?`, [fgId]);
  });

  await audit(req, 'trx_fg_receipt', (result as any).id, 'INSERT', undefined, result);
  res.status(201).json({ data: result });
}));

/** PUT /fg-receipts/:id — Update FG receipt */
cuttingPlanRouter.put('/fg-receipts/:id', requirePermission('PRODUCTION.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = fgReceiptSchema.parse(req.body);

  const existing = await queryOne(`SELECT * FROM trx_fg_receipt WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('FG receipt not found');

  const totalGood = body.lines.reduce((sum, l) => sum + l.good_qty, 0);
  const totalReject = body.lines.reduce((sum, l) => sum + l.reject_qty, 0);

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_fg_receipt SET
        receipt_date = ?, io_no = ?, so_id = ?, prod_order_id = ?, style_id = ?,
        warehouse_id = ?, source_stage = ?, source_ref = ?, total_qty = ?, total_reject = ?,
        status = ?, remarks = ?
       WHERE id = ?`,
      [body.receipt_date, body.io_no, body.so_id ?? null, body.prod_order_id ?? null,
       body.style_id, body.warehouse_id ?? null, body.source_stage, body.source_ref ?? null,
       totalGood, totalReject, body.status, body.remarks ?? null, id]);

    await txExecute(tx, `DELETE FROM trx_fg_receipt_line WHERE fg_receipt_id = ?`, [id]);
    for (const line of body.lines) {
      await txExecute(tx,
        `INSERT INTO trx_fg_receipt_line (fg_receipt_id, color_id, size_id, sku_id, good_qty, reject_qty, batch_no)
         VALUES (?,?,?,?,?,?,?)`,
        [id, line.color_id, line.size_id, line.sku_id ?? null, line.good_qty, line.reject_qty, line.batch_no ?? null]);
    }
  });

  const updated = await queryOne(`SELECT * FROM trx_fg_receipt WHERE id = ?`, [id]);
  await audit(req, 'trx_fg_receipt', id, 'UPDATE', existing, updated);
  res.json({ data: updated });
}));
