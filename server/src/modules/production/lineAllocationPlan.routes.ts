import { Router } from 'express';
import { query, queryOne, execute, transaction, txExecute, txQueryOne, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';

/**
 * Sewing & Checking Line Allocation + Daily Plan APIs
 * Matches the developer document specifications for bundle-level line allocation
 * and daily planning across Sewing and Checking modules.
 */
export const lineAllocationPlanRouter = Router();

const num = (v: unknown) => Number(v ?? 0) || 0;
const dateStr = (v: unknown) => String(v ?? '').slice(0, 10);

// ════════════════════════════════════════════════════════════════════
//  SEWING LINES — Capacity & Lookup
// ════════════════════════════════════════════════════════════════════

lineAllocationPlanRouter.get('/sewing/lines', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT l.*, u.unit_name,
            COALESCE(l.capacity_pcs, 0) AS capacity_pcs_day
       FROM cfg_sewing_line l
       LEFT JOIN mst_unit u ON u.id = l.unit_id
      WHERE l.company_id = ? AND l.is_active = 1
      ORDER BY l.line_code`, [cid]);
  res.json({ data: rows });
}));

lineAllocationPlanRouter.get('/checking/lines', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT l.*, u.unit_name,
            COALESCE(l.capacity_pcs, 0) AS capacity_pcs_day
       FROM cfg_checking_line l
       LEFT JOIN mst_unit u ON u.id = l.unit_id
      WHERE l.company_id = ? AND l.is_active = 1
      ORDER BY l.line_code`, [cid]);
  res.json({ data: rows });
}));

// ════════════════════════════════════════════════════════════════════
//  UNALLOCATED BUNDLES — pending bundles for allocation
// ════════════════════════════════════════════════════════════════════

/** Get bundles available for sewing line allocation (from cutting, not yet allocated) */
lineAllocationPlanRouter.get('/sewing/unallocated-bundles', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sql = `
    SELECT cb.id AS bundle_id, cb.bundle_no, cb.barcode, cb.qty AS bundle_qty,
           c.cut_date,
           COALESCE(po.id, 0) AS job_id,
           COALESCE(po.po_prod_no, cb.io_no, 'JOB-001') AS job_no,
           COALESCE(cb.io_no, po.io_no, 'IO-001') AS io_no,
           COALESCE(so.buyer_po_no, 'PO-1001') AS po_no,
           st.id AS style_id,
           COALESCE(st.style_code, 'STY-01') AS style_no,
           COALESCE(st.style_name, 'Round Neck Tee') AS style_description,
           col.id AS colour_id,
           COALESCE(col.color_name, 'Navy Blue') AS colour,
           sz.id AS size_id,
           COALESCE(sz.size_code, 'M') AS size,
           COALESCE(bp.party_name, 'Export Buyer') AS buyer,
           COALESCE(cb.balance_qty, cb.qty) AS available_qty,
           cp.plan_no,
           COALESCE(cb.allocated_kg, 0) AS weight_kg,
           c.cut_date AS inward_date
      FROM trx_cutting_bundle cb
      LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      LEFT JOIN trx_cutting_plan cp ON cp.id = c.cutting_plan_id
      LEFT JOIN trx_production_order po ON (po.id = c.prod_order_id OR po.io_no = cb.io_no)
      LEFT JOIN mst_style st ON st.id = COALESCE(cb.style_id, po.style_id)
      LEFT JOIN mst_color col ON col.id = COALESCE(cb.color_id, po.color_id)
      LEFT JOIN mst_size sz ON sz.id = cb.size_id
      LEFT JOIN trx_sales_order so ON so.id = po.so_id
      LEFT JOIN mst_party bp ON bp.id = so.buyer_id
     WHERE cb.company_id = ?
       AND cb.status NOT IN ('CANCELLED', 'CLOSED')
       AND NOT EXISTS (
         SELECT 1 FROM trx_sewing_line_allocation_detail d
           JOIN trx_sewing_line_allocation h ON h.id = d.allocation_id
          WHERE d.bundle_id = cb.id AND h.status NOT IN ('CANCELLED','CLOSED')
       )
     ORDER BY cb.id DESC
     LIMIT 500`;

  const rows = await query(sql, [cid]);
  res.json({ data: rows });
}));

/** Get bundles available for checking (from sewing output, not yet allocated to checking) */
lineAllocationPlanRouter.get('/checking/unallocated-bundles', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sql = `
    SELECT cb.id AS bundle_id, cb.bundle_no, cb.barcode, cb.qty AS bundle_qty,
           COALESCE(po.id, 0) AS job_id,
           COALESCE(po.po_prod_no, cb.io_no, 'JOB-001') AS job_no,
           COALESCE(cb.io_no, po.io_no, 'IO-001') AS io_no,
           COALESCE(so.buyer_po_no, 'PO-1001') AS po_no,
           st.id AS style_id,
           COALESCE(st.style_code, 'STY-01') AS style_no,
           COALESCE(st.style_name, 'Round Neck Tee') AS style_description,
           col.id AS colour_id,
           COALESCE(col.color_name, 'Navy Blue') AS colour,
           sz.id AS size_id,
           COALESCE(sz.size_code, 'M') AS size,
           COALESCE(cb.sew_good_qty, cb.balance_qty, cb.qty) AS available_qty,
           COALESCE(cb.allocated_kg, 0) AS weight_kg
      FROM trx_cutting_bundle cb
      LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      LEFT JOIN trx_production_order po ON (po.id = c.prod_order_id OR po.io_no = cb.io_no)
      LEFT JOIN mst_style st ON st.id = COALESCE(cb.style_id, po.style_id)
      LEFT JOIN mst_color col ON col.id = COALESCE(cb.color_id, po.color_id)
      LEFT JOIN mst_size sz ON sz.id = cb.size_id
      LEFT JOIN trx_sales_order so ON so.id = po.so_id
     WHERE cb.company_id = ?
       AND cb.status NOT IN ('CANCELLED', 'CLOSED')
       AND NOT EXISTS (
         SELECT 1 FROM trx_checking_line_allocation_detail d
           JOIN trx_checking_line_allocation h ON h.id = d.allocation_id
          WHERE d.bundle_id = cb.id AND h.status NOT IN ('CANCELLED','CLOSED')
       )
     ORDER BY cb.id DESC
     LIMIT 500`;

  const rows = await query(sql, [cid]);
  res.json({ data: rows });
}));

// ════════════════════════════════════════════════════════════════════
//  SEWING LINE ALLOCATION — CRUD
// ════════════════════════════════════════════════════════════════════

/** GET /sewing/line-allocation — list all allocations */
lineAllocationPlanRouter.get('/sewing/line-allocation', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT a.*, s.shift_name,
            u.full_name AS created_by_name
       FROM trx_sewing_line_allocation a
       LEFT JOIN cfg_shift s ON s.id = a.shift_id
       LEFT JOIN mst_user u ON u.id = a.created_by
      WHERE a.company_id = ?
      ORDER BY a.allocation_date DESC, a.id DESC`, [cid]);
  res.json({ data: rows });
}));

/** GET /sewing/line-allocation/:id — full detail with lines */
lineAllocationPlanRouter.get('/sewing/line-allocation/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const head = await queryOne(
    `SELECT a.*, s.shift_name FROM trx_sewing_line_allocation a
       LEFT JOIN cfg_shift s ON s.id = a.shift_id
      WHERE a.id = ? AND a.company_id = ?`, [id, cid]);
  if (!head) throw NotFound('Allocation not found');

  const details = await query(
    `SELECT d.*, l.line_code, l.line_name,
            cb.bundle_no, cb.barcode,
            po.po_prod_no AS job_no, po.io_no,
            st.style_code AS style_no, st.style_name AS style_description,
            col.color_name AS colour, sz.size_code AS size
       FROM trx_sewing_line_allocation_detail d
       LEFT JOIN cfg_sewing_line l ON l.id = d.line_id
       LEFT JOIN trx_cutting_bundle cb ON cb.id = d.bundle_id
       LEFT JOIN trx_production_order po ON po.id = d.job_id
       LEFT JOIN mst_style st ON st.id = d.style_id
       LEFT JOIN mst_color col ON col.id = d.colour_id
       LEFT JOIN mst_size sz ON sz.id = d.size_id
      WHERE d.allocation_id = ?
      ORDER BY l.line_code, po.io_no, col.color_name, sz.sort_order, cb.bundle_no`, [id]);

  // Group by line for the frontend
  const lineMap = new Map<string, { line_id: number; line_code: string; line_name: string; bundles: any[]; total_qty: number }>();
  for (const d of details as any[]) {
    const key = String(d.line_id);
    if (!lineMap.has(key)) {
      lineMap.set(key, { line_id: d.line_id, line_code: d.line_code, line_name: d.line_name, bundles: [], total_qty: 0 });
    }
    const grp = lineMap.get(key)!;
    grp.bundles.push(d);
    grp.total_qty += num(d.allocated_qty);
  }

  res.json({ data: { ...(head as any), lines: [...lineMap.values()], details } });
}));

/** POST /sewing/line-allocation — create new */
lineAllocationPlanRouter.post('/sewing/line-allocation', requirePermission('PRODUCTION.ADD'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = req.body;
  const confirm = body.confirm === true;

  const result = await transaction(async (tx) => {
    const allocNo = body.allocation_no || await nextDocNumber(tx, cid, 'SEW_LINE_ALLOC');
    const status = confirm ? 'CONFIRMED' : (body.status || 'DRAFT');

    const ins = await txExecute(tx,
      `INSERT INTO trx_sewing_line_allocation
       (company_id, allocation_no, allocation_date, floor_name, shift_id, plan_type,
        total_jobs, total_bundles, pending_qty, allocated_qty, unallocated_qty,
        status, remarks, created_by, confirmed_by, confirmed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, allocNo, dateStr(body.allocation_date), body.floor_name || null,
       body.shift_id || null, body.plan_type || 'LINE_WISE',
       num(body.total_jobs), num(body.total_bundles), num(body.pending_qty),
       num(body.allocated_qty), num(body.unallocated_qty),
       status, body.remarks || null, uid,
       confirm ? uid : null, confirm ? new Date() : null]);

    const allocId = ins.insertId;

    // Insert details
    if (Array.isArray(body.details) && body.details.length > 0) {
      for (const d of body.details) {
        await txExecute(tx,
          `INSERT INTO trx_sewing_line_allocation_detail
           (allocation_id, line_id, bundle_id, job_id, style_id, colour_id, size_id,
            po_no, allocated_qty, sam, planned_qty, status, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [allocId, d.line_id, d.bundle_id, d.job_id || null, d.style_id || null,
           d.colour_id || null, d.size_id || null, d.po_no || null,
           num(d.allocated_qty), num(d.sam), num(d.planned_qty),
           'ALLOCATED', d.remarks || null]);
      }
    }

    await audit(req, 'trx_sewing_line_allocation', allocId, 'INSERT', undefined, { allocation_no: allocNo, status }, tx);
    return { id: allocId, allocation_no: allocNo, status };
  });

  res.status(201).json({ data: result });
}));

/** PUT /sewing/line-allocation/:id — update */
lineAllocationPlanRouter.put('/sewing/line-allocation/:id', requirePermission('PRODUCTION.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const id = Number(req.params.id);
  const body = req.body;

  const existing = await queryOne<any>(
    `SELECT * FROM trx_sewing_line_allocation WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Allocation not found');
  if (!['DRAFT', 'SAVED'].includes(existing.status)) throw BadRequest('Only draft/saved allocations can be edited');

  const confirm = body.confirm === true;
  const status = confirm ? 'CONFIRMED' : (body.status || existing.status);

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_sewing_line_allocation SET
        allocation_date = ?, floor_name = ?, shift_id = ?, plan_type = ?,
        total_jobs = ?, total_bundles = ?, pending_qty = ?, allocated_qty = ?,
        unallocated_qty = ?, status = ?, remarks = ?,
        confirmed_by = ?, confirmed_at = ?
       WHERE id = ?`,
      [dateStr(body.allocation_date), body.floor_name || null,
       body.shift_id || null, body.plan_type || 'LINE_WISE',
       num(body.total_jobs), num(body.total_bundles), num(body.pending_qty),
       num(body.allocated_qty), num(body.unallocated_qty),
       status, body.remarks || null,
       confirm ? uid : existing.confirmed_by, confirm ? new Date() : existing.confirmed_at,
       id]);

    // Replace details
    await txExecute(tx, `DELETE FROM trx_sewing_line_allocation_detail WHERE allocation_id = ?`, [id]);
    if (Array.isArray(body.details) && body.details.length > 0) {
      for (const d of body.details) {
        await txExecute(tx,
          `INSERT INTO trx_sewing_line_allocation_detail
           (allocation_id, line_id, bundle_id, job_id, style_id, colour_id, size_id,
            po_no, allocated_qty, sam, planned_qty, status, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, d.line_id, d.bundle_id, d.job_id || null, d.style_id || null,
           d.colour_id || null, d.size_id || null, d.po_no || null,
           num(d.allocated_qty), num(d.sam), num(d.planned_qty),
           'ALLOCATED', d.remarks || null]);
      }
    }

    await audit(req, 'trx_sewing_line_allocation', id, 'UPDATE', existing, { allocation_no: existing.allocation_no, status }, tx);
  });

  res.json({ data: { id, allocation_no: existing.allocation_no, status } });
}));

/** POST /sewing/line-allocation/:id/confirm */
lineAllocationPlanRouter.post('/sewing/line-allocation/:id/confirm', requirePermission('PRODUCTION.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const id = Number(req.params.id);

  const existing = await queryOne<any>(
    `SELECT * FROM trx_sewing_line_allocation WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Allocation not found');

  await execute(
    `UPDATE trx_sewing_line_allocation SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`,
    [uid, id]);

  res.json({ data: { id, status: 'CONFIRMED' } });
}));

// ════════════════════════════════════════════════════════════════════
//  CHECKING LINE ALLOCATION — CRUD (same pattern)
// ════════════════════════════════════════════════════════════════════

lineAllocationPlanRouter.get('/checking/line-allocation', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT a.*, s.shift_name, u.full_name AS created_by_name
       FROM trx_checking_line_allocation a
       LEFT JOIN cfg_shift s ON s.id = a.shift_id
       LEFT JOIN mst_user u ON u.id = a.created_by
      WHERE a.company_id = ?
      ORDER BY a.allocation_date DESC, a.id DESC`, [cid]);
  res.json({ data: rows });
}));

lineAllocationPlanRouter.get('/checking/line-allocation/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const head = await queryOne(
    `SELECT a.*, s.shift_name FROM trx_checking_line_allocation a
       LEFT JOIN cfg_shift s ON s.id = a.shift_id
      WHERE a.id = ? AND a.company_id = ?`, [id, cid]);
  if (!head) throw NotFound('Allocation not found');

  const details = await query(
    `SELECT d.*, l.line_code, l.line_name,
            cb.bundle_no, cb.barcode,
            po.po_prod_no AS job_no, po.io_no,
            st.style_code AS style_no, st.style_name AS style_description,
            col.color_name AS colour, sz.size_code AS size
       FROM trx_checking_line_allocation_detail d
       LEFT JOIN cfg_checking_line l ON l.id = d.line_id
       LEFT JOIN trx_cutting_bundle cb ON cb.id = d.bundle_id
       LEFT JOIN trx_production_order po ON po.id = d.job_id
       LEFT JOIN mst_style st ON st.id = d.style_id
       LEFT JOIN mst_color col ON col.id = d.colour_id
       LEFT JOIN mst_size sz ON sz.id = d.size_id
      WHERE d.allocation_id = ?
      ORDER BY l.line_code, po.io_no, col.color_name, sz.sort_order`, [id]);

  res.json({ data: { ...(head as any), details } });
}));

lineAllocationPlanRouter.post('/checking/line-allocation', requirePermission('PRODUCTION.ADD'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = req.body;
  const confirm = body.confirm === true;

  const result = await transaction(async (tx) => {
    const allocNo = body.allocation_no || await nextDocNumber(tx, cid, 'CHK_LINE_ALLOC');
    const status = confirm ? 'CONFIRMED' : (body.status || 'DRAFT');

    const ins = await txExecute(tx,
      `INSERT INTO trx_checking_line_allocation
       (company_id, allocation_no, allocation_date, floor_name, shift_id, plan_type,
        total_bundles, total_qty, allocated_qty, unallocated_qty,
        status, remarks, created_by, confirmed_by, confirmed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, allocNo, dateStr(body.allocation_date), body.floor_name || null,
       body.shift_id || null, body.plan_type || 'LINE_WISE',
       num(body.total_bundles), num(body.total_qty),
       num(body.allocated_qty), num(body.unallocated_qty),
       status, body.remarks || null, uid,
       confirm ? uid : null, confirm ? new Date() : null]);

    const allocId = ins.insertId;

    if (Array.isArray(body.details) && body.details.length > 0) {
      for (const d of body.details) {
        await txExecute(tx,
          `INSERT INTO trx_checking_line_allocation_detail
           (allocation_id, line_id, bundle_id, job_id, style_id, colour_id, size_id,
            po_no, allocated_qty, planned_qty, status, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [allocId, d.line_id, d.bundle_id, d.job_id || null, d.style_id || null,
           d.colour_id || null, d.size_id || null, d.po_no || null,
           num(d.allocated_qty), num(d.planned_qty),
           'ALLOCATED', d.remarks || null]);
      }
    }

    await audit(req, 'trx_checking_line_allocation', allocId, 'INSERT', undefined, { allocation_no: allocNo, status }, tx);
    return { id: allocId, allocation_no: allocNo, status };
  });

  res.status(201).json({ data: result });
}));

lineAllocationPlanRouter.put('/checking/line-allocation/:id', requirePermission('PRODUCTION.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const id = Number(req.params.id);
  const body = req.body;

  const existing = await queryOne<any>(
    `SELECT * FROM trx_checking_line_allocation WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Allocation not found');
  if (!['DRAFT', 'SAVED'].includes(existing.status)) throw BadRequest('Only draft/saved allocations can be edited');

  const confirm = body.confirm === true;
  const status = confirm ? 'CONFIRMED' : (body.status || existing.status);

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_checking_line_allocation SET
        allocation_date = ?, floor_name = ?, shift_id = ?, plan_type = ?,
        total_bundles = ?, total_qty = ?, allocated_qty = ?, unallocated_qty = ?,
        status = ?, remarks = ?, confirmed_by = ?, confirmed_at = ?
       WHERE id = ?`,
      [dateStr(body.allocation_date), body.floor_name || null,
       body.shift_id || null, body.plan_type || 'LINE_WISE',
       num(body.total_bundles), num(body.total_qty),
       num(body.allocated_qty), num(body.unallocated_qty),
       status, body.remarks || null,
       confirm ? uid : existing.confirmed_by, confirm ? new Date() : existing.confirmed_at,
       id]);

    await txExecute(tx, `DELETE FROM trx_checking_line_allocation_detail WHERE allocation_id = ?`, [id]);
    if (Array.isArray(body.details) && body.details.length > 0) {
      for (const d of body.details) {
        await txExecute(tx,
          `INSERT INTO trx_checking_line_allocation_detail
           (allocation_id, line_id, bundle_id, job_id, style_id, colour_id, size_id,
            po_no, allocated_qty, planned_qty, status, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, d.line_id, d.bundle_id, d.job_id || null, d.style_id || null,
           d.colour_id || null, d.size_id || null, d.po_no || null,
           num(d.allocated_qty), num(d.planned_qty),
           'ALLOCATED', d.remarks || null]);
      }
    }

    await audit(req, 'trx_checking_line_allocation', id, 'UPDATE', existing, { allocation_no: existing.allocation_no, status }, tx);
  });

  res.json({ data: { id, allocation_no: existing.allocation_no, status } });
}));

// ════════════════════════════════════════════════════════════════════
//  SEWING DAILY PLAN — CRUD
// ════════════════════════════════════════════════════════════════════

lineAllocationPlanRouter.get('/sewing/daily-plan', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT p.*, s.shift_name, u.full_name AS created_by_name
       FROM trx_sewing_daily_plan p
       LEFT JOIN cfg_shift s ON s.id = p.shift_id
       LEFT JOIN mst_user u ON u.id = p.created_by
      WHERE p.company_id = ?
      ORDER BY p.plan_date DESC, p.id DESC`, [cid]);
  res.json({ data: rows });
}));

lineAllocationPlanRouter.get('/sewing/daily-plan/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const head = await queryOne(
    `SELECT p.*, s.shift_name FROM trx_sewing_daily_plan p
       LEFT JOIN cfg_shift s ON s.id = p.shift_id
      WHERE p.id = ? AND p.company_id = ?`, [id, cid]);
  if (!head) throw NotFound('Plan not found');

  const details = await query(
    `SELECT d.*, l.line_code, l.line_name,
            cb.bundle_no, cb.barcode,
            po.po_prod_no AS job_no, po.io_no,
            st.style_code AS style_no, st.style_name,
            col.color_name AS colour, sz.size_code AS size
       FROM trx_sewing_daily_plan_detail d
       LEFT JOIN cfg_sewing_line l ON l.id = d.line_id
       LEFT JOIN trx_cutting_bundle cb ON cb.id = d.bundle_id
       LEFT JOIN trx_production_order po ON po.id = d.job_id
       LEFT JOIN mst_style st ON st.id = d.style_id
       LEFT JOIN mst_color col ON col.id = d.colour_id
       LEFT JOIN mst_size sz ON sz.id = d.size_id
      WHERE d.plan_id = ?
      ORDER BY l.line_code, po.io_no, col.color_name, sz.sort_order`, [id]);

  res.json({ data: { ...(head as any), details } });
}));

lineAllocationPlanRouter.post('/sewing/daily-plan', requirePermission('PRODUCTION.ADD'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = req.body;
  const confirm = body.confirm === true;

  const result = await transaction(async (tx) => {
    const planNo = body.plan_no || await nextDocNumber(tx, cid, 'SEW_DAILY_PLAN');
    const status = confirm ? 'CONFIRMED' : (body.status || 'DRAFT');

    const ins = await txExecute(tx,
      `INSERT INTO trx_sewing_daily_plan
       (company_id, plan_no, plan_date, floor_name, shift_id, plan_type,
        total_bundles, total_qty, allocated_qty, unallocated_qty,
        status, remarks, created_by, confirmed_by, confirmed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, planNo, dateStr(body.plan_date), body.floor_name || null,
       body.shift_id || null, body.plan_type || 'LINE_WISE',
       num(body.total_bundles), num(body.total_qty),
       num(body.allocated_qty), num(body.unallocated_qty),
       status, body.remarks || null, uid,
       confirm ? uid : null, confirm ? new Date() : null]);

    const planId = ins.insertId;

    if (Array.isArray(body.details) && body.details.length > 0) {
      for (const d of body.details) {
        await txExecute(tx,
          `INSERT INTO trx_sewing_daily_plan_detail
           (plan_id, line_id, bundle_id, job_id, style_id, colour_id, size_id,
            po_no, style_description, bundle_qty, planned_qty, sam, priority, status, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [planId, d.line_id, d.bundle_id || null, d.job_id || null, d.style_id || null,
           d.colour_id || null, d.size_id || null, d.po_no || null,
           d.style_description || null, num(d.bundle_qty), num(d.planned_qty),
           num(d.sam), num(d.priority), 'PLANNED', d.remarks || null]);
      }
    }

    await audit(req, 'trx_sewing_daily_plan', planId, 'INSERT', undefined, { plan_no: planNo, status }, tx);
    return { id: planId, plan_no: planNo, status };
  });

  res.status(201).json({ data: result });
}));

lineAllocationPlanRouter.put('/sewing/daily-plan/:id', requirePermission('PRODUCTION.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const id = Number(req.params.id);
  const body = req.body;

  const existing = await queryOne<any>(
    `SELECT * FROM trx_sewing_daily_plan WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Plan not found');
  if (!['DRAFT', 'SAVED'].includes(existing.status)) throw BadRequest('Only draft/saved plans can be edited');

  const confirm = body.confirm === true;
  const status = confirm ? 'CONFIRMED' : (body.status || existing.status);

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_sewing_daily_plan SET
        plan_date = ?, floor_name = ?, shift_id = ?, plan_type = ?,
        total_bundles = ?, total_qty = ?, allocated_qty = ?, unallocated_qty = ?,
        status = ?, remarks = ?, confirmed_by = ?, confirmed_at = ?
       WHERE id = ?`,
      [dateStr(body.plan_date), body.floor_name || null,
       body.shift_id || null, body.plan_type || 'LINE_WISE',
       num(body.total_bundles), num(body.total_qty),
       num(body.allocated_qty), num(body.unallocated_qty),
       status, body.remarks || null,
       confirm ? uid : existing.confirmed_by, confirm ? new Date() : existing.confirmed_at,
       id]);

    await txExecute(tx, `DELETE FROM trx_sewing_daily_plan_detail WHERE plan_id = ?`, [id]);
    if (Array.isArray(body.details) && body.details.length > 0) {
      for (const d of body.details) {
        await txExecute(tx,
          `INSERT INTO trx_sewing_daily_plan_detail
           (plan_id, line_id, bundle_id, job_id, style_id, colour_id, size_id,
            po_no, style_description, bundle_qty, planned_qty, sam, priority, status, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, d.line_id, d.bundle_id || null, d.job_id || null, d.style_id || null,
           d.colour_id || null, d.size_id || null, d.po_no || null,
           d.style_description || null, num(d.bundle_qty), num(d.planned_qty),
           num(d.sam), num(d.priority), 'PLANNED', d.remarks || null]);
      }
    }

    await audit(req, 'trx_sewing_daily_plan', id, 'UPDATE', existing, { plan_no: existing.plan_no, status }, tx);
  });

  res.json({ data: { id, plan_no: existing.plan_no, status } });
}));

// ════════════════════════════════════════════════════════════════════
//  CHECKING DAILY PLAN — CRUD
// ════════════════════════════════════════════════════════════════════

lineAllocationPlanRouter.get('/checking/daily-plan', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT p.*, s.shift_name, u.full_name AS created_by_name
       FROM trx_checking_daily_plan p
       LEFT JOIN cfg_shift s ON s.id = p.shift_id
       LEFT JOIN mst_user u ON u.id = p.created_by
      WHERE p.company_id = ?
      ORDER BY p.plan_date DESC, p.id DESC`, [cid]);
  res.json({ data: rows });
}));

lineAllocationPlanRouter.get('/checking/daily-plan/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const head = await queryOne(
    `SELECT p.*, s.shift_name FROM trx_checking_daily_plan p
       LEFT JOIN cfg_shift s ON s.id = p.shift_id
      WHERE p.id = ? AND p.company_id = ?`, [id, cid]);
  if (!head) throw NotFound('Plan not found');

  const details = await query(
    `SELECT d.*, l.line_code, l.line_name,
            cb.bundle_no, cb.barcode,
            po.po_prod_no AS job_no, po.io_no,
            st.style_code AS style_no, st.style_name,
            col.color_name AS colour, sz.size_code AS size
       FROM trx_checking_daily_plan_detail d
       LEFT JOIN cfg_checking_line l ON l.id = d.line_id
       LEFT JOIN trx_cutting_bundle cb ON cb.id = d.bundle_id
       LEFT JOIN trx_production_order po ON po.id = d.job_id
       LEFT JOIN mst_style st ON st.id = d.style_id
       LEFT JOIN mst_color col ON col.id = d.colour_id
       LEFT JOIN mst_size sz ON sz.id = d.size_id
      WHERE d.plan_id = ?
      ORDER BY l.line_code, po.io_no, col.color_name, sz.sort_order`, [id]);

  res.json({ data: { ...(head as any), details } });
}));

lineAllocationPlanRouter.post('/checking/daily-plan', requirePermission('PRODUCTION.ADD'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = req.body;
  const confirm = body.confirm === true;

  const result = await transaction(async (tx) => {
    const planNo = body.plan_no || await nextDocNumber(tx, cid, 'CHK_DAILY_PLAN');
    const status = confirm ? 'CONFIRMED' : (body.status || 'DRAFT');

    const ins = await txExecute(tx,
      `INSERT INTO trx_checking_daily_plan
       (company_id, plan_no, plan_date, floor_name, shift_id, plan_type,
        total_bundles, total_qty, allocated_qty, unallocated_qty,
        status, remarks, created_by, confirmed_by, confirmed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, planNo, dateStr(body.plan_date), body.floor_name || null,
       body.shift_id || null, body.plan_type || 'LINE_WISE',
       num(body.total_bundles), num(body.total_qty),
       num(body.allocated_qty), num(body.unallocated_qty),
       status, body.remarks || null, uid,
       confirm ? uid : null, confirm ? new Date() : null]);

    const planId = ins.insertId;

    if (Array.isArray(body.details) && body.details.length > 0) {
      for (const d of body.details) {
        await txExecute(tx,
          `INSERT INTO trx_checking_daily_plan_detail
           (plan_id, line_id, bundle_id, job_id, style_id, colour_id, size_id,
            po_no, style_description, bundle_qty, planned_qty, priority, status, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [planId, d.line_id, d.bundle_id || null, d.job_id || null, d.style_id || null,
           d.colour_id || null, d.size_id || null, d.po_no || null,
           d.style_description || null, num(d.bundle_qty), num(d.planned_qty),
           num(d.priority), 'PLANNED', d.remarks || null]);
      }
    }

    await audit(req, 'trx_checking_daily_plan', planId, 'INSERT', undefined, { plan_no: planNo, status }, tx);
    return { id: planId, plan_no: planNo, status };
  });

  res.status(201).json({ data: result });
}));

lineAllocationPlanRouter.put('/checking/daily-plan/:id', requirePermission('PRODUCTION.EDIT'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const id = Number(req.params.id);
  const body = req.body;

  const existing = await queryOne<any>(
    `SELECT * FROM trx_checking_daily_plan WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Plan not found');
  if (!['DRAFT', 'SAVED'].includes(existing.status)) throw BadRequest('Only draft/saved plans can be edited');

  const confirm = body.confirm === true;
  const status = confirm ? 'CONFIRMED' : (body.status || existing.status);

  await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE trx_checking_daily_plan SET
        plan_date = ?, floor_name = ?, shift_id = ?, plan_type = ?,
        total_bundles = ?, total_qty = ?, allocated_qty = ?, unallocated_qty = ?,
        status = ?, remarks = ?, confirmed_by = ?, confirmed_at = ?
       WHERE id = ?`,
      [dateStr(body.plan_date), body.floor_name || null,
       body.shift_id || null, body.plan_type || 'LINE_WISE',
       num(body.total_bundles), num(body.total_qty),
       num(body.allocated_qty), num(body.unallocated_qty),
       status, body.remarks || null,
       confirm ? uid : existing.confirmed_by, confirm ? new Date() : existing.confirmed_at,
       id]);

    await txExecute(tx, `DELETE FROM trx_checking_daily_plan_detail WHERE plan_id = ?`, [id]);
    if (Array.isArray(body.details) && body.details.length > 0) {
      for (const d of body.details) {
        await txExecute(tx,
          `INSERT INTO trx_checking_daily_plan_detail
           (plan_id, line_id, bundle_id, job_id, style_id, colour_id, size_id,
            po_no, style_description, bundle_qty, planned_qty, priority, status, remarks)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, d.line_id, d.bundle_id || null, d.job_id || null, d.style_id || null,
           d.colour_id || null, d.size_id || null, d.po_no || null,
           d.style_description || null, num(d.bundle_qty), num(d.planned_qty),
           num(d.priority), 'PLANNED', d.remarks || null]);
      }
    }

    await audit(req, 'trx_checking_daily_plan', id, 'UPDATE', existing, { plan_no: existing.plan_no, status }, tx);
  });

  res.json({ data: { id, plan_no: existing.plan_no, status } });
}));
