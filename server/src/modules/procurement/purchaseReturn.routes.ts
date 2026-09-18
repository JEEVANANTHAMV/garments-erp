import { Router } from 'express';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { nextDocNumber } from '../../core/numbering.js';

export const purchaseReturnRouter = Router();

// ---------------------------------------------------------------------------
// 1. GET /api/purchase-returns/reasons — Reason Master
// ---------------------------------------------------------------------------
purchaseReturnRouter.get('/purchase-returns/reasons', ah(async (_req, res) => {
  const reasons = await query<any>(`
    SELECT id, code, name, requires_qc, requires_remarks, is_active
      FROM mst_purchase_return_reason
     WHERE is_active = 1
     ORDER BY id ASC
  `);
  res.json({ data: reasons });
}));

// ---------------------------------------------------------------------------
// 2. GET /api/purchase-returns/grn/:grnId/returnable-items — GRN Items & Returnable Qty
// ---------------------------------------------------------------------------
purchaseReturnRouter.get('/purchase-returns/grn/:grnId/returnable-items', requirePermission('PURCHASE.VIEW'), ah(async (req, res) => {
  const grnId = Number(req.params.grnId);
  const grn = await queryOne<any>(`
    SELECT g.*, sup.party_name AS supplier_name, po.po_no
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
     WHERE g.id = ? AND g.company_id = ?
  `, [grnId, req.user!.companyId]);

  if (!grn) throw NotFound('GRN not found');

  const lines = await query<any>(`
    SELECT gl.*,
           y.yarn_name, y.yarn_code,
           f.fabric_name, f.fabric_code,
           u.code AS uom_code,
           COALESCE((
             SELECT SUM(prl.return_qty)
               FROM trx_purchase_return_line prl
               JOIN trx_purchase_return pr ON pr.id = prl.return_id
              WHERE prl.grn_line_id = gl.id AND pr.status != 'CANCELLED'
           ), 0) AS previous_returned_qty,
           COALESCE(gl.issued_qty, 0) AS issued_qty
      FROM trx_grn_line gl
      LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
      LEFT JOIN mst_fabric f ON f.id = gl.fabric_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
     WHERE gl.grn_id = ?
  `, [grnId]);

  const returnableLines = lines.map((l: any) => {
    const received = Number(l.accepted_qty ?? l.received_qty ?? 0);
    const prevReturned = Number(l.previous_returned_qty ?? 0);
    const issued = Number(l.issued_qty ?? 0);
    const returnable = Math.max(0, received - prevReturned - issued);

    return {
      ...l,
      grn_qty: received,
      previous_returned_qty: prevReturned,
      issued_qty: issued,
      returnable_qty: returnable,
      item_name: l.yarn_name || l.fabric_name || l.color_name || `Item #${l.id}`,
    };
  });

  res.json({ data: { grn, lines: returnableLines } });
}));

// ---------------------------------------------------------------------------
// 3. GET /api/purchase-returns — List
// ---------------------------------------------------------------------------
purchaseReturnRouter.get('/purchase-returns', requirePermission('PURCHASE.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const { material_category, status, supplier_id } = req.query;

  const where: string[] = ['pr.company_id = ?'];
  const params: any[] = [companyId];

  if (material_category) {
    where.push('pr.material_category = ?');
    params.push(material_category);
  }
  if (status) {
    where.push('pr.status = ?');
    params.push(status);
  }
  if (supplier_id) {
    where.push('pr.supplier_id = ?');
    params.push(Number(supplier_id));
  }

  const rows = await query<any>(`
    SELECT pr.*,
           sup.party_name AS supplier_name,
           po.po_no,
           grn.grn_no,
           w.warehouse_name,
           (SELECT COUNT(*) FROM trx_purchase_return_line WHERE return_id = pr.id) AS item_count
      FROM trx_purchase_return pr
      LEFT JOIN mst_party sup ON sup.id = pr.supplier_id
      LEFT JOIN trx_purchase_order po ON po.id = pr.source_po_id OR po.id = pr.po_id
      LEFT JOIN trx_grn grn ON grn.id = pr.source_grn_id OR grn.id = pr.grn_id
      LEFT JOIN mst_warehouse w ON w.id = pr.warehouse_id
     WHERE ${where.join(' AND ')}
     ORDER BY pr.return_date DESC, pr.id DESC
  `, params);

  res.json({ data: rows });
}));

// ---------------------------------------------------------------------------
// 4. GET /api/purchase-returns/:id — Detail with lines and allocations
// ---------------------------------------------------------------------------
purchaseReturnRouter.get('/purchase-returns/:id', requirePermission('PURCHASE.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const pr = await queryOne<any>(`
    SELECT pr.*,
           sup.party_name AS supplier_name,
           po.po_no,
           grn.grn_no,
           w.warehouse_name
      FROM trx_purchase_return pr
      LEFT JOIN mst_party sup ON sup.id = pr.supplier_id
      LEFT JOIN trx_purchase_order po ON po.id = pr.source_po_id OR po.id = pr.po_id
      LEFT JOIN trx_grn grn ON grn.id = pr.source_grn_id OR grn.id = pr.grn_id
      LEFT JOIN mst_warehouse w ON w.id = pr.warehouse_id
     WHERE pr.id = ? AND pr.company_id = ?
  `, [id, req.user!.companyId]);

  if (!pr) throw NotFound('Purchase Return not found');

  const lines = await query<any>(`
    SELECT prl.*,
           y.yarn_name, y.yarn_code,
           f.fabric_name, f.fabric_code,
           u.code AS uom_code
      FROM trx_purchase_return_line prl
      LEFT JOIN mst_yarn y ON y.id = prl.yarn_id
      LEFT JOIN mst_fabric f ON f.id = prl.fabric_id
      LEFT JOIN cfg_uom u ON u.id = prl.uom_id
     WHERE prl.return_id = ?
     ORDER BY prl.id ASC
  `, [id]);

  const allocations = await query<any>(`
    SELECT * FROM trx_purchase_return_allocation
     WHERE return_id = ?
     ORDER BY id ASC
  `, [id]);

  res.json({ data: { ...pr, lines, allocations } });
}));

// ---------------------------------------------------------------------------
// 5. POST /api/purchase-returns — Create Return
// ---------------------------------------------------------------------------
purchaseReturnRouter.post('/purchase-returns', requirePermission('PURCHASE.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const {
    return_type = 'FULL',
    material_category = 'FABRIC',
    return_date = new Date().toISOString().slice(0, 10),
    supplier_id,
    source_po_id,
    source_grn_id,
    warehouse_id,
    return_reason = 'QUALITY_REJECTION',
    remarks,
    lines = [],
    allocations = [],
    transporter_name,
    vehicle_no,
    driver_name,
    eway_bill_no,
    credit_note_ref,
    credit_note_date,
    credit_note_amount,
  } = req.body;

  if (!supplier_id) throw BadRequest('Supplier is required');
  if (!warehouse_id) throw BadRequest('Warehouse/Store is required');
  if (!lines.length) throw BadRequest('At least one return item is required');

  const createdId = await transaction(async (tx) => {
    const returnNo = req.body.return_no || await nextDocNumber(tx, companyId, 'PURCHASE_RETURN');

    let totalQty = 0;
    let totalAmount = 0;

    for (const l of lines) {
      const qty = Number(l.return_qty || 0);
      const rate = Number(l.rate || 0);
      const basic = Number((qty * rate).toFixed(4));
      const gstRate = Number(l.gst_percent || 5);
      const gstAmt = Number((basic * (gstRate / 100)).toFixed(4));
      const lineTotal = basic + gstAmt;

      totalQty += qty;
      totalAmount += lineTotal;
    }

    const retRes = await txExecute(tx, `
      INSERT INTO trx_purchase_return (
        company_id, return_no, return_type, material_category,
        return_date, source_po_id, source_grn_id, grn_id, supplier_id, warehouse_id,
        return_reason, total_qty, total_amount,
        transporter_name, vehicle_no, driver_name, eway_bill_no,
        credit_note_ref, credit_note_date, credit_note_amount,
        status, remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)
    `, [
      companyId, returnNo, return_type, material_category,
      return_date, source_po_id ? Number(source_po_id) : null,
      source_grn_id ? Number(source_grn_id) : null,
      source_grn_id ? Number(source_grn_id) : null,
      Number(supplier_id), Number(warehouse_id),
      return_reason, totalQty, totalAmount,
      transporter_name || null, vehicle_no || null, driver_name || null, eway_bill_no || null,
      credit_note_ref || null, credit_note_date || null, Number(credit_note_amount || 0),
      remarks || null, userId,
    ]);

    const newReturnId = retRes.insertId;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const qty = Number(l.return_qty || 0);
      const rate = Number(l.rate || 0);
      const basic = Number((qty * rate).toFixed(4));
      const gstRate = Number(l.gst_percent || 5);
      const isIgst = Boolean(l.is_igst);
      const gstAmt = Number((basic * (gstRate / 100)).toFixed(4));
      const cgst = isIgst ? 0 : Number((gstAmt / 2).toFixed(4));
      const sgst = isIgst ? 0 : Number((gstAmt / 2).toFixed(4));
      const igst = isIgst ? gstAmt : 0;
      const lineTotal = basic + gstAmt;

      const lineRes = await txExecute(tx, `
        INSERT INTO trx_purchase_return_line (
          return_id, grn_line_id, material_type,
          yarn_id, fabric_id, trim_id, color_id,
          return_qty, grn_qty, prev_returned_qty, issued_qty, returnable_qty,
          uom_id, rate, amount, basic_amount, taxable_amount,
          gst_percent, cgst_amount, sgst_amount, igst_amount, total_amount,
          reason, lot_no, dye_lot_no, cone_count, bag_count,
          roll_no, batch_no, gsm, dia, size, department, expiry_date,
          job_no, style_no, remarks
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newReturnId,
        l.grn_line_id ? Number(l.grn_line_id) : null,
        l.material_type || material_category,
        l.yarn_id ? Number(l.yarn_id) : null,
        l.fabric_id ? Number(l.fabric_id) : null,
        l.trim_id ? Number(l.trim_id) : null,
        l.color_id ? Number(l.color_id) : null,
        qty,
        Number(l.grn_qty || 0),
        Number(l.prev_returned_qty || 0),
        Number(l.issued_qty || 0),
        Number(l.returnable_qty || qty),
        l.uom_id ? Number(l.uom_id) : 1,
        rate,
        basic,
        basic,
        basic,
        gstRate,
        cgst,
        sgst,
        igst,
        lineTotal,
        l.reason || return_reason,
        l.lot_no || null,
        l.dye_lot_no || null,
        l.cone_count ? Number(l.cone_count) : null,
        l.bag_count ? Number(l.bag_count) : null,
        l.roll_no || null,
        l.batch_no || null,
        l.gsm || null,
        l.dia || null,
        l.size || null,
        l.department || null,
        l.expiry_date || null,
        l.job_no || null,
        l.style_no || null,
        l.remarks || null,
      ]);

      const returnLineId = lineRes.insertId;

      // Allocations for this line
      const lineAllocations = allocations.filter((a: any) => a.line_index === i || a.return_line_id === l.id);
      for (const a of lineAllocations) {
        if (Number(a.allocated_qty) > 0) {
          await txExecute(tx, `
            INSERT INTO trx_purchase_return_allocation (
              return_id, return_line_id, job_no, style_no, allocated_qty, remarks
            ) VALUES (?,?,?,?,?,?)
          `, [
            newReturnId,
            returnLineId,
            a.job_no || 'JOB-001',
            a.style_no || 'STYLE-001',
            Number(a.allocated_qty),
            a.remarks || null,
          ]);
        }
      }
    }

    return newReturnId;
  });

  res.status(201).json({ data: { id: createdId, message: 'Purchase Return created successfully' } });
}));

// ---------------------------------------------------------------------------
// 6. POST /api/purchase-returns/:id/status — Status transitions
// ---------------------------------------------------------------------------
purchaseReturnRouter.post('/purchase-returns/:id/status', requirePermission('PURCHASE.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;
  const companyId = req.user!.companyId;
  const userId = req.user!.id;

  const validStatuses = ['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED'];
  if (!validStatuses.includes(status)) throw BadRequest(`Invalid status: ${status}`);

  const extraSets: string[] = [];
  const params: any[] = [status];

  if (status === 'APPROVED') {
    extraSets.push('approved_by = ?, approved_at = NOW()');
    params.push(userId);
  }

  const sql = `
    UPDATE trx_purchase_return
       SET status = ? ${extraSets.length ? ', ' + extraSets.join(', ') : ''}
     WHERE id = ? AND company_id = ?
  `;
  params.push(id, companyId);

  await query(sql, params);
  res.json({ success: true, message: `Status updated to ${status}` });
}));

// ---------------------------------------------------------------------------
// 7. POST /api/purchase-returns/:id/return-dc — Generate / Save Return DC
// ---------------------------------------------------------------------------
purchaseReturnRouter.post('/purchase-returns/:id/return-dc', requirePermission('PURCHASE.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const companyId = req.user!.companyId;
  const { transporter_name, vehicle_no, driver_name, eway_bill_no } = req.body;

  const current = await queryOne<any>(`
    SELECT * FROM trx_purchase_return WHERE id = ? AND company_id = ?
  `, [id, companyId]);

  if (!current) throw NotFound('Purchase Return not found');

  const dcNo = current.return_dc_no || `RDC-${current.return_no || id}`;
  const dcDate = current.return_dc_date || new Date().toISOString().slice(0, 10);

  await query(`
    UPDATE trx_purchase_return
       SET return_dc_no = ?, return_dc_date = ?,
           transporter_name = ?, vehicle_no = ?, driver_name = ?, eway_bill_no = ?,
           status = CASE WHEN status = 'APPROVED' THEN 'RETURN_DC_CREATED' ELSE status END
     WHERE id = ? AND company_id = ?
  `, [dcNo, dcDate, transporter_name || null, vehicle_no || null, driver_name || null, eway_bill_no || null, id, companyId]);

  res.json({ success: true, data: { return_dc_no: dcNo, return_dc_date: dcDate } });
}));

// ---------------------------------------------------------------------------
// 8. POST /api/purchase-returns/:id/post-stock — Stock Reversal
// ---------------------------------------------------------------------------
purchaseReturnRouter.post('/purchase-returns/:id/post-stock', requirePermission('INVENTORY.ADJUST'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const companyId = req.user!.companyId;
  const userId = req.user!.id;

  const pr = await queryOne<any>(`
    SELECT * FROM trx_purchase_return WHERE id = ? AND company_id = ?
  `, [id, companyId]);

  if (!pr) throw NotFound('Purchase Return not found');
  if (pr.stock_posted) throw BadRequest('Stock has already been posted for this return');

  await transaction(async (tx) => {
    // 1. Mark return as stock_posted
    await txExecute(tx, `
      UPDATE trx_purchase_return
         SET stock_posted = 1, posted_by = ?, posted_at = NOW(),
             status = 'STOCK_POSTED'
       WHERE id = ?
    `, [userId, id]);

    // 2. If fabric rolls exist, mark returned
    const lines = await txQuery<any>(tx, `
      SELECT * FROM trx_purchase_return_line WHERE return_id = ?
    `, [id]);

    for (const l of lines) {
      if (l.roll_no) {
        await txExecute(tx, `
          UPDATE trx_fabric_roll
             SET status = 'RETURNED'
           WHERE roll_no = ? AND company_id = ?
        `, [l.roll_no, companyId]);
      }
    }
  });

  res.json({ success: true, message: 'Inventory stock successfully reversed for Purchase Return' });
}));
