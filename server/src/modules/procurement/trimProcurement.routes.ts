import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const trimProcurementRouter = Router();

// ============================================================
// SCHEMAS
// ============================================================

const trimPoLineSchema = z.object({
  id: s.id(),
  trim_id: s.idReq(),
  specification: s.nullableStr(255),
  color_name: s.nullableStr(80),
  trim_size: s.nullableStr(50),
  order_qty: z.coerce.number().positive(),
  uom_id: s.idReq(),
  rate: z.coerce.number().min(0).default(0),
  amount: z.coerce.number().min(0).default(0),
  gst_rate: z.coerce.number().min(0).default(0),
  tax_amount: z.coerce.number().min(0).default(0),
  net_amount: z.coerce.number().min(0).default(0),
});

const trimPoSchema = z.object({
  po_no: s.nullableStr(50),
  po_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.strReq(60),
  style_id: s.id(),
  supplier_id: s.idReq(),
  delivery_date: s.nullableStr(10),
  payment_terms: s.nullableStr(150),
  total_amount: z.coerce.number().min(0).default(0),
  tax_amount: z.coerce.number().min(0).default(0),
  grand_total: z.coerce.number().min(0).default(0),
  status: z.enum(['DRAFT', 'APPROVED', 'PARTIAL', 'CLOSED', 'CANCELLED']).default('APPROVED'),
  remarks: s.text(),
  lines: z.array(trimPoLineSchema).min(1),
});

const trimGrnLineSchema = z.object({
  id: s.id(),
  po_line_id: s.id(),
  trim_id: s.idReq(),
  specification: s.nullableStr(255),
  color_name: s.nullableStr(80),
  trim_size: s.nullableStr(50),
  uom_id: s.idReq(),
  po_qty: z.coerce.number().min(0).default(0),
  received_qty: z.coerce.number().positive(),
  accepted_qty: z.coerce.number().min(0),
  rejected_qty: z.coerce.number().min(0).default(0),
  hold_qty: z.coerce.number().min(0).default(0),
  supplier_lot_no: s.nullableStr(80),
  internal_lot_no: s.strReq(80),
  bin_location: s.nullableStr(50),
  qc_status: z.enum(['ACCEPTED', 'PARTIAL', 'REJECTED', 'HOLD']).default('ACCEPTED'),
  rejection_reason: s.nullableStr(255),
});

const trimGrnSchema = z.object({
  grn_no: s.nullableStr(50),
  grn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  po_id: s.id(),
  io_no: s.strReq(60),
  style_id: s.id(),
  supplier_id: s.idReq(),
  warehouse_id: s.idReq(),
  supplier_inv_no: s.nullableStr(80),
  supplier_dc_no: s.nullableStr(80),
  vehicle_no: s.nullableStr(40),
  status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).default('POSTED'),
  remarks: s.text(),
  lines: z.array(trimGrnLineSchema).min(1),
});

// ============================================================
// TRIM PURCHASE ORDER ROUTES
// ============================================================

/** GET /trim-pos — List Trim POs */
trimProcurementRouter.get('/trim-pos', requirePermission('PROCUREMENT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id, supplier_id, status } = req.query;

  let where = 'WHERE tpo.company_id = ?';
  const params: any[] = [cid];

  if (io_no) {
    where += ' AND tpo.io_no LIKE ?';
    params.push(`%${io_no}%`);
  }
  if (style_id) {
    where += ' AND tpo.style_id = ?';
    params.push(style_id);
  }
  if (supplier_id) {
    where += ' AND tpo.supplier_id = ?';
    params.push(supplier_id);
  }
  if (status) {
    where += ' AND tpo.status = ?';
    params.push(status);
  }

  const rows = await query(
    `SELECT tpo.*,
            st.style_code, st.style_name,
            p.party_name AS supplier_name,
            COUNT(tpol.id) AS total_items,
            COALESCE(SUM(tpol.order_qty), 0) AS total_order_qty,
            COALESCE(SUM(tpol.received_qty), 0) AS total_received_qty
       FROM trx_trim_po tpo
       LEFT JOIN mst_style st ON st.id = tpo.style_id
       LEFT JOIN mst_party p ON p.id = tpo.supplier_id
       LEFT JOIN trx_trim_po_line tpol ON tpol.po_id = tpo.id
      ${where}
      GROUP BY tpo.id
      ORDER BY tpo.id DESC`,
    params
  );

  res.json({ success: true, data: rows });
}));

/** GET /trim-pos/:id — Detail with lines */
trimProcurementRouter.get('/trim-pos/:id', requirePermission('PROCUREMENT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const po = await queryOne(
    `SELECT tpo.*,
            st.style_code, st.style_name,
            p.party_name AS supplier_name
       FROM trx_trim_po tpo
       LEFT JOIN mst_style st ON st.id = tpo.style_id
       LEFT JOIN mst_party p ON p.id = tpo.supplier_id
      WHERE tpo.id = ? AND tpo.company_id = ?`,
    [req.params.id, cid]
  );

  if (!po) throw NotFound('Trim Purchase Order not found');

  const lines = await query(
    `SELECT tpol.*,
            t.trim_name, t.trim_code, t.trim_type,
            u.uom_code
       FROM trx_trim_po_line tpol
       JOIN mst_trim t ON t.id = tpol.trim_id
       LEFT JOIN cfg_uom u ON u.id = tpol.uom_id
      WHERE tpol.po_id = ?
      ORDER BY tpol.id ASC`,
    [po.id]
  );

  res.json({ success: true, data: { ...po, lines } });
}));

/** POST /trim-pos — Create Trim PO (No stock effect) */
trimProcurementRouter.post('/trim-pos', requirePermission('PROCUREMENT.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = trimPoSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const poNo = body.po_no || await nextDocNumber(tx, cid, 'TPO');

    const resPo = await txExecute(
      tx,
      `INSERT INTO trx_trim_po
         (company_id, po_no, po_date, io_no, style_id, supplier_id, delivery_date,
          payment_terms, total_amount, tax_amount, grand_total, status, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, poNo, body.po_date, body.io_no, body.style_id, body.supplier_id, body.delivery_date,
        body.payment_terms, body.total_amount, body.tax_amount, body.grand_total, body.status,
        body.remarks, uid
      ]
    );

    const poId = resPo.insertId;

    for (const line of body.lines) {
      await txExecute(
        tx,
        `INSERT INTO trx_trim_po_line
           (po_id, trim_id, specification, color_name, trim_size, order_qty, uom_id,
            rate, amount, gst_rate, tax_amount, net_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          poId, line.trim_id, line.specification, line.color_name, line.trim_size, line.order_qty,
          line.uom_id, line.rate, line.amount, line.gst_rate, line.tax_amount, line.net_amount
        ]
      );
    }

    return { id: poId, po_no: poNo };
  });

  await audit(req, 'trx_trim_po', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** PUT /trim-pos/:id — Update Trim PO */
trimProcurementRouter.put('/trim-pos/:id', requirePermission('PROCUREMENT.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = trimPoSchema.parse(req.body);

  const existing = await queryOne('SELECT id, status FROM trx_trim_po WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!existing) throw NotFound('Trim PO not found');
  if (existing.status === 'CLOSED' || existing.status === 'CANCELLED') {
    throw BadRequest(`Cannot update PO in ${existing.status} status`);
  }

  await transaction(async (tx) => {
    await txExecute(
      tx,
      `UPDATE trx_trim_po
          SET po_date = ?, io_no = ?, style_id = ?, supplier_id = ?, delivery_date = ?,
              payment_terms = ?, total_amount = ?, tax_amount = ?, grand_total = ?,
              status = ?, remarks = ?
        WHERE id = ? AND company_id = ?`,
      [
        body.po_date, body.io_no, body.style_id, body.supplier_id, body.delivery_date,
        body.payment_terms, body.total_amount, body.tax_amount, body.grand_total,
        body.status, body.remarks, req.params.id, cid
      ]
    );

    await txExecute(tx, 'DELETE FROM trx_trim_po_line WHERE po_id = ?', [req.params.id]);

    for (const line of body.lines) {
      await txExecute(
        tx,
        `INSERT INTO trx_trim_po_line
           (po_id, trim_id, specification, color_name, trim_size, order_qty, uom_id,
            rate, amount, gst_rate, tax_amount, net_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.params.id, line.trim_id, line.specification, line.color_name, line.trim_size,
          line.order_qty, line.uom_id, line.rate, line.amount, line.gst_rate, line.tax_amount,
          line.net_amount
        ]
      );
    }
  });

  await audit(req, 'trx_trim_po', Number(req.params.id), 'UPDATE', existing, body);
  res.json({ success: true, message: 'Trim PO updated' });
}));

// ============================================================
// TRIM GRN & STOCK ROUTES
// ============================================================

/** GET /trim-grns — List Trim GRNs */
trimProcurementRouter.get('/trim-grns', requirePermission('PROCUREMENT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id, supplier_id, po_id } = req.query;

  let where = 'WHERE tg.company_id = ?';
  const params: any[] = [cid];

  if (io_no) {
    where += ' AND tg.io_no LIKE ?';
    params.push(`%${io_no}%`);
  }
  if (style_id) {
    where += ' AND tg.style_id = ?';
    params.push(style_id);
  }
  if (supplier_id) {
    where += ' AND tg.supplier_id = ?';
    params.push(supplier_id);
  }
  if (po_id) {
    where += ' AND tg.po_id = ?';
    params.push(po_id);
  }

  const rows = await query(
    `SELECT tg.*,
            st.style_code, st.style_name,
            p.party_name AS supplier_name,
            w.warehouse_name,
            tpo.po_no,
            COUNT(tgl.id) AS total_items,
            COALESCE(SUM(tgl.received_qty), 0) AS total_received_qty,
            COALESCE(SUM(tgl.accepted_qty), 0) AS total_accepted_qty,
            COALESCE(SUM(tgl.rejected_qty), 0) AS total_rejected_qty
       FROM trx_trim_grn tg
       LEFT JOIN mst_style st ON st.id = tg.style_id
       LEFT JOIN mst_party p ON p.id = tg.supplier_id
       LEFT JOIN mst_warehouse w ON w.id = tg.warehouse_id
       LEFT JOIN trx_trim_po tpo ON tpo.id = tg.po_id
       LEFT JOIN trx_trim_grn_line tgl ON tgl.grn_id = tg.id
      ${where}
      GROUP BY tg.id
      ORDER BY tg.id DESC`,
    params
  );

  res.json({ success: true, data: rows });
}));

/** GET /trim-grns/:id — Detail with lines */
trimProcurementRouter.get('/trim-grns/:id', requirePermission('PROCUREMENT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const grn = await queryOne(
    `SELECT tg.*,
            st.style_code, st.style_name,
            p.party_name AS supplier_name,
            w.warehouse_name,
            tpo.po_no
       FROM trx_trim_grn tg
       LEFT JOIN mst_style st ON st.id = tg.style_id
       LEFT JOIN mst_party p ON p.id = tg.supplier_id
       LEFT JOIN mst_warehouse w ON w.id = tg.warehouse_id
       LEFT JOIN trx_trim_po tpo ON tpo.id = tg.po_id
      WHERE tg.id = ? AND tg.company_id = ?`,
    [req.params.id, cid]
  );

  if (!grn) throw NotFound('Trim GRN not found');

  const lines = await query(
    `SELECT tgl.*,
            t.trim_name, t.trim_code, t.trim_type,
            u.uom_code
       FROM trx_trim_grn_line tgl
       JOIN mst_trim t ON t.id = tgl.trim_id
       LEFT JOIN cfg_uom u ON u.id = tgl.uom_id
      WHERE tgl.grn_id = ?
      ORDER BY tgl.id ASC`,
    [grn.id]
  );

  res.json({ success: true, data: { ...grn, lines } });
}));

/** POST /trim-grns — Create Trim GRN (Only accepted_qty increases unrestricted stock) */
trimProcurementRouter.post('/trim-grns', requirePermission('PROCUREMENT.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = trimGrnSchema.parse(req.body);

  // Validate line quantities: accepted + rejected + hold <= received
  for (const line of body.lines) {
    const totalSplit = line.accepted_qty + line.rejected_qty + line.hold_qty;
    if (totalSplit > line.received_qty + 0.0001) {
      throw BadRequest(`Accepted (${line.accepted_qty}) + Rejected (${line.rejected_qty}) + Hold (${line.hold_qty}) cannot exceed Received quantity (${line.received_qty}) for lot ${line.internal_lot_no}`);
    }
  }

  const result = await transaction(async (tx) => {
    const grnNo = body.grn_no || await nextDocNumber(tx, cid, 'TGRN');

    const resGrn = await txExecute(
      tx,
      `INSERT INTO trx_trim_grn
         (company_id, grn_no, grn_date, po_id, io_no, style_id, supplier_id, warehouse_id,
          supplier_inv_no, supplier_dc_no, vehicle_no, status, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, grnNo, body.grn_date, body.po_id, body.io_no, body.style_id, body.supplier_id,
        body.warehouse_id, body.supplier_inv_no, body.supplier_dc_no, body.vehicle_no,
        body.status, body.remarks, uid
      ]
    );

    const grnId = resGrn.insertId;

    for (const line of body.lines) {
      await txExecute(
        tx,
        `INSERT INTO trx_trim_grn_line
           (grn_id, po_line_id, trim_id, specification, color_name, trim_size, uom_id,
            po_qty, received_qty, accepted_qty, rejected_qty, hold_qty, supplier_lot_no,
            internal_lot_no, bin_location, qc_status, rejection_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          grnId, line.po_line_id || null, line.trim_id, line.specification, line.color_name,
          line.trim_size, line.uom_id, line.po_qty, line.received_qty, line.accepted_qty,
          line.rejected_qty, line.hold_qty, line.supplier_lot_no, line.internal_lot_no,
          line.bin_location, line.qc_status, line.rejection_reason
        ]
      );

      // Update PO Line received_qty if po_line_id provided
      if (line.po_line_id) {
        await txExecute(
          tx,
          `UPDATE trx_trim_po_line SET received_qty = received_qty + ? WHERE id = ?`,
          [line.received_qty, line.po_line_id]
        );
      }

      // Stock posting: ONLY accepted_qty updates unrestricted inventory!
      if (line.accepted_qty > 0 && body.status === 'POSTED') {
        await txExecute(
          tx,
          `INSERT INTO trx_trim_stock
             (company_id, warehouse_id, trim_id, color_name, trim_size, internal_lot_no, bin_location, stock_qty, uom_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             stock_qty = stock_qty + VALUES(stock_qty),
             bin_location = COALESCE(VALUES(bin_location), bin_location)`,
          [
            cid, body.warehouse_id, line.trim_id, line.color_name, line.trim_size,
            line.internal_lot_no, line.bin_location, line.accepted_qty, line.uom_id
          ]
        );
      }
    }

    // Check if PO is fully received
    if (body.po_id) {
      const pols = await query('SELECT order_qty, received_qty FROM trx_trim_po_line WHERE po_id = ?', [body.po_id]);
      const allReceived = pols.length > 0 && pols.every((p: any) => Number(p.received_qty) >= Number(p.order_qty));
      const anyReceived = pols.some((p: any) => Number(p.received_qty) > 0);
      const newStatus = allReceived ? 'CLOSED' : (anyReceived ? 'PARTIAL' : 'APPROVED');
      await txExecute(tx, 'UPDATE trx_trim_po SET status = ? WHERE id = ?', [newStatus, body.po_id]);
    }

    return { id: grnId, grn_no: grnNo };
  });

  await audit(req, 'trx_trim_grn', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** GET /trim-stock — View current real-time trim inventory */
trimProcurementRouter.get('/trim-stock', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { trim_id, warehouse_id, internal_lot_no } = req.query;

  let where = 'WHERE ts.company_id = ? AND ts.stock_qty > 0';
  const params: any[] = [cid];

  if (trim_id) {
    where += ' AND ts.trim_id = ?';
    params.push(trim_id);
  }
  if (warehouse_id) {
    where += ' AND ts.warehouse_id = ?';
    params.push(warehouse_id);
  }
  if (internal_lot_no) {
    where += ' AND ts.internal_lot_no LIKE ?';
    params.push(`%${internal_lot_no}%`);
  }

  const rows = await query(
    `SELECT ts.*,
            t.trim_name, t.trim_code, t.trim_type,
            w.warehouse_name,
            u.uom_code,
            (ts.stock_qty - ts.allocated_qty) AS available_qty
       FROM trx_trim_stock ts
       JOIN mst_trim t ON t.id = ts.trim_id
       JOIN mst_warehouse w ON w.id = ts.warehouse_id
       LEFT JOIN cfg_uom u ON u.id = ts.uom_id
      ${where}
      ORDER BY t.trim_name ASC, ts.internal_lot_no ASC`,
    params
  );

  res.json({ success: true, data: rows });
}));
