import { Router } from 'express';
import { query, queryOne, transaction, txQuery, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { nextDocNumber } from '../../core/numbering.js';

export const purchaseReturnRouter = Router();

/**
 * Append a row to the purchase return audit trail (spec §28).
 *
 * Takes the surrounding transaction so the audit row commits or rolls back with
 * the state change it describes — an audit entry for a change that never landed
 * would be worse than none.
 */
async function writeReturnAudit(
  tx: Tx,
  companyId: number,
  returnId: number,
  action: string,
  oldStatus: string | null,
  newStatus: string | null,
  userId: number | null,
  ip: string | null,
  remarks: string | null,
): Promise<void> {
  await txExecute(tx, `
    INSERT INTO trx_purchase_return_audit (
      company_id, purchase_return_id, action, old_status, new_status,
      user_id, ip_address, remarks
    ) VALUES (?,?,?,?,?,?,?,?)
  `, [companyId, returnId, action, oldStatus, newStatus, userId, ip, remarks]);
}

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
           -- Issued/consumed comes from the stock ledger, not the GRN line:
           -- trx_grn_line has no issued_qty column. RETURN movements are
           -- excluded because they are already counted as previous_returned_qty.
           COALESCE((
             SELECT SUM(sl.qty_out)
               FROM trx_stock_ledger sl
              WHERE sl.company_id = g.company_id
                AND sl.material_type = gl.material_type
                AND sl.txn_type <> 'RETURN'
                AND ((gl.yarn_id   IS NOT NULL AND sl.yarn_id   = gl.yarn_id)
                  OR (gl.fabric_id IS NOT NULL AND sl.fabric_id = gl.fabric_id)
                  OR (gl.trim_id   IS NOT NULL AND sl.trim_id   = gl.trim_id))
           ), 0) AS issued_qty
      FROM trx_grn_line gl
      JOIN trx_grn g ON g.id = gl.grn_id
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
      LEFT JOIN trx_purchase_order po ON po.id = pr.source_po_id
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
      LEFT JOIN trx_purchase_order po ON po.id = pr.source_po_id
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

    await writeReturnAudit(tx, companyId, newReturnId, 'CREATED', null, 'DRAFT',
      userId, req.ip ?? null, `Return created with ${lines.length} line(s)`);

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

  const prev = await queryOne<any>(
    `SELECT status FROM trx_purchase_return WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!prev) throw NotFound('Purchase Return not found');

  await transaction(async (tx) => {
    await txExecute(tx, sql, params);
    await writeReturnAudit(tx, companyId, id, status, prev.status, status,
      userId, req.ip ?? null, req.body.remarks ?? null);
  });

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

  await transaction(async (tx) => {
    await txExecute(tx, `
      UPDATE trx_purchase_return
         SET return_dc_no = ?, return_dc_date = ?,
             transporter_name = ?, vehicle_no = ?, driver_name = ?, eway_bill_no = ?,
             status = CASE WHEN status = 'APPROVED' THEN 'RETURN_DC_CREATED' ELSE status END
       WHERE id = ? AND company_id = ?
    `, [dcNo, dcDate, transporter_name || null, vehicle_no || null, driver_name || null, eway_bill_no || null, id, companyId]);

    await writeReturnAudit(tx, companyId, id, 'RETURN_DC_CREATED', current.status,
      current.status === 'APPROVED' ? 'RETURN_DC_CREATED' : current.status,
      req.user!.id, req.ip ?? null, `Return DC ${dcNo}`);
  });

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
        // trx_fabric_roll tracks availability in stock_status (there is no
        // `status` column). CLOSED takes the roll out of available stock.
        await txExecute(tx, `
          UPDATE trx_fabric_roll
             SET stock_status = 'CLOSED'
           WHERE roll_no = ? AND company_id = ?
        `, [l.roll_no, companyId]);
      }

      // 3. Reverse stock: a purchase return moves material OUT of the warehouse.
      // The original GRN ledger rows are never touched — the reversal is a new
      // RETURN row with qty_out, so the audit trail stays intact.
      const returnQty = Number(l.return_qty || 0);
      if (returnQty > 0) {
        await txExecute(tx, `
          INSERT INTO trx_stock_ledger (
            company_id, warehouse_id, material_type, yarn_id, fabric_id, trim_id, color_id,
            txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate, created_by
          ) VALUES (?,?,?,?,?,?,?,'RETURN','PURCHASE_RETURN',?,0,?,?,?,?)
        `, [
          companyId,
          Number(pr.warehouse_id),
          l.material_type,
          l.yarn_id ? Number(l.yarn_id) : null,
          l.fabric_id ? Number(l.fabric_id) : null,
          l.trim_id ? Number(l.trim_id) : null,
          l.color_id ? Number(l.color_id) : null,
          id,
          returnQty,
          Number(l.uom_id),
          Number(l.rate || 0),
          userId,
        ]);
      }
    }

    await writeReturnAudit(tx, companyId, id, 'STOCK_POSTED', pr.status, 'STOCK_POSTED',
      userId, req.ip ?? null, `Stock reversed for ${lines.length} line(s)`);
  });

  res.json({ success: true, message: 'Inventory stock successfully reversed for Purchase Return' });
}));

// ---------------------------------------------------------------------------
// 9. GET /api/purchase-returns/:id/audit — Audit trail (spec §28)
// ---------------------------------------------------------------------------
purchaseReturnRouter.get('/purchase-returns/:id/audit', requirePermission('PURCHASE.VIEW'), ah(async (req, res) => {
  const rows = await query<any>(`
    SELECT a.*, u.full_name AS user_name
      FROM trx_purchase_return_audit a
      LEFT JOIN mst_user u ON u.id = a.user_id
     WHERE a.purchase_return_id = ? AND a.company_id = ?
     ORDER BY a.action_date DESC, a.id DESC
  `, [Number(req.params.id), req.user!.companyId]);
  res.json({ data: rows });
}));

// ---------------------------------------------------------------------------
// 10. POST /api/purchase-returns/:id/credit-note — Raise Credit Note (spec §27)
// ---------------------------------------------------------------------------
purchaseReturnRouter.post('/purchase-returns/:id/credit-note', requirePermission('PURCHASE_RETURN.CREDIT_NOTE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const companyId = req.user!.companyId;
  const userId = req.user!.id;

  const pr = await queryOne<any>(
    `SELECT * FROM trx_purchase_return WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!pr) throw NotFound('Purchase Return not found');
  if (pr.credit_note_id) throw BadRequest('A credit note has already been raised for this return');
  if (!pr.stock_posted) throw BadRequest('Post the return stock before raising a credit note');

  // Tax split comes from the return lines so the note always agrees with them.
  const tot = await queryOne<any>(`
    SELECT COALESCE(SUM(taxable_amount),0) AS taxable,
           COALESCE(SUM(cgst_amount),0)    AS cgst,
           COALESCE(SUM(sgst_amount),0)    AS sgst,
           COALESCE(SUM(igst_amount),0)    AS igst,
           COALESCE(SUM(total_amount),0)   AS total
      FROM trx_purchase_return_line WHERE return_id = ?
  `, [id]);

  const result = await transaction(async (tx) => {
    const cnNo = await nextDocNumber(tx, companyId, 'PURCHASE_CREDIT_NOTE');
    const ins = await txExecute(tx, `
      INSERT INTO trx_purchase_credit_note (
        company_id, credit_note_no, credit_note_date, purchase_return_id, supplier_id,
        supplier_invoice_no, taxable_amount, cgst_amount, sgst_amount, igst_amount,
        total_amount, status, remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'ISSUED',?,?)
    `, [
      companyId, cnNo, req.body.credit_note_date || new Date().toISOString().slice(0, 10),
      id, pr.supplier_id, req.body.supplier_invoice_no || null,
      tot.taxable, tot.cgst, tot.sgst, tot.igst, tot.total,
      req.body.remarks || `Credit note against ${pr.return_no}`, userId,
    ]);

    const cnId = ins.insertId;
    await txExecute(tx, `
      UPDATE trx_purchase_return
         SET credit_note_id = ?, credit_note_ref = ?, credit_note_date = ?,
             credit_note_amount = ?, status = 'CLOSED'
       WHERE id = ?
    `, [cnId, cnNo, req.body.credit_note_date || new Date().toISOString().slice(0, 10), tot.total, id]);

    await writeReturnAudit(tx, companyId, id, 'CREDIT_NOTE_CREATED', pr.status, 'CLOSED', userId,
      req.ip ?? null, `Credit note ${cnNo} for ${tot.total}`);

    return { id: cnId, credit_note_no: cnNo, total_amount: tot.total };
  });

  res.json({ success: true, data: result });
}));

// ---------------------------------------------------------------------------
// 11. GET /api/purchase-returns/reports/:report — Reports (spec §30)
// ---------------------------------------------------------------------------
purchaseReturnRouter.get('/purchase-returns/reports/:report', requirePermission('REPORT.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const { from, to } = req.query;

  const range: string[] = [];
  const rp: any[] = [companyId];
  if (from) { range.push('pr.return_date >= ?'); rp.push(from); }
  if (to)   { range.push('pr.return_date <= ?'); rp.push(to); }
  const dateWhere = range.length ? ` AND ${range.join(' AND ')}` : '';

  // Each report is a named SELECT over the same return/line join.
  const REPORTS: Record<string, string> = {
    // §30.1 Purchase Return Register
    register: `
      SELECT pr.id, pr.return_no, pr.return_date, pr.return_type, pr.material_category,
             pr.status, pr.total_qty, pr.total_amount, pr.return_dc_no, pr.credit_note_ref,
             sup.party_name AS supplier_name, grn.grn_no
        FROM trx_purchase_return pr
        LEFT JOIN mst_party sup ON sup.id = pr.supplier_id
        LEFT JOIN trx_grn grn ON grn.id = pr.source_grn_id OR grn.id = pr.grn_id
       WHERE pr.company_id = ?${dateWhere}
       ORDER BY pr.return_date DESC, pr.id DESC`,
    // §30.2 Supplier-wise
    supplier: `
      SELECT sup.id AS supplier_id, sup.party_name AS supplier_name,
             COUNT(DISTINCT pr.id) AS return_count,
             SUM(pr.total_qty) AS total_qty, SUM(pr.total_amount) AS total_amount
        FROM trx_purchase_return pr
        JOIN mst_party sup ON sup.id = pr.supplier_id
       WHERE pr.company_id = ?${dateWhere}
       GROUP BY sup.id, sup.party_name
       ORDER BY total_amount DESC`,
    // §30.3 Material category-wise
    category: `
      SELECT pr.material_category,
             COUNT(DISTINCT pr.id) AS return_count,
             SUM(pr.total_qty) AS total_qty, SUM(pr.total_amount) AS total_amount
        FROM trx_purchase_return pr
       WHERE pr.company_id = ?${dateWhere}
       GROUP BY pr.material_category
       ORDER BY total_amount DESC`,
    // §30.4 Job-wise
    job: `
      SELECT COALESCE(a.job_no, prl.job_no) AS job_no,
             COUNT(DISTINCT pr.id) AS return_count,
             SUM(COALESCE(a.allocated_qty, prl.return_qty)) AS total_qty
        FROM trx_purchase_return pr
        JOIN trx_purchase_return_line prl ON prl.return_id = pr.id
        LEFT JOIN trx_purchase_return_allocation a ON a.return_line_id = prl.id
       WHERE pr.company_id = ?${dateWhere}
         AND COALESCE(a.job_no, prl.job_no) IS NOT NULL
       GROUP BY COALESCE(a.job_no, prl.job_no)
       ORDER BY total_qty DESC`,
    // §30.5 Style-wise
    style: `
      SELECT COALESCE(a.style_no, prl.style_no) AS style_no,
             COUNT(DISTINCT pr.id) AS return_count,
             SUM(COALESCE(a.allocated_qty, prl.return_qty)) AS total_qty
        FROM trx_purchase_return pr
        JOIN trx_purchase_return_line prl ON prl.return_id = pr.id
        LEFT JOIN trx_purchase_return_allocation a ON a.return_line_id = prl.id
       WHERE pr.company_id = ?${dateWhere}
         AND COALESCE(a.style_no, prl.style_no) IS NOT NULL
       GROUP BY COALESCE(a.style_no, prl.style_no)
       ORDER BY total_qty DESC`,
    // §30.6 Fabric roll return
    'fabric-roll': `
      SELECT pr.return_no, pr.return_date, prl.roll_no, prl.lot_no, prl.dye_lot_no,
             prl.gsm, prl.dia, prl.return_qty, f.fabric_name, sup.party_name AS supplier_name
        FROM trx_purchase_return pr
        JOIN trx_purchase_return_line prl ON prl.return_id = pr.id
        LEFT JOIN mst_fabric f ON f.id = prl.fabric_id
        LEFT JOIN mst_party sup ON sup.id = pr.supplier_id
       WHERE pr.company_id = ? AND prl.roll_no IS NOT NULL${dateWhere}
       ORDER BY pr.return_date DESC`,
    // §30.7 QC rejection returns
    'qc-rejection': `
      SELECT pr.return_no, pr.return_date, pr.return_reason, pr.total_qty, pr.total_amount,
             sup.party_name AS supplier_name, pr.material_category, pr.status
        FROM trx_purchase_return pr
        LEFT JOIN mst_party sup ON sup.id = pr.supplier_id
       WHERE pr.company_id = ?
         AND (pr.return_type = 'QC_REJECTION'
              OR pr.return_reason IN ('QUALITY_REJECTION','FAILED_INSPECTION'))${dateWhere}
       ORDER BY pr.return_date DESC`,
  };

  const reportKey = String(req.params.report);
  const sql = REPORTS[reportKey];
  if (!sql) throw BadRequest(`Unknown report: ${reportKey}. Valid: ${Object.keys(REPORTS).join(', ')}`);

  res.json({ data: await query<any>(sql, rp), report: reportKey });
}));

// ---------------------------------------------------------------------------
// 12. GET /api/purchase-returns/grn/:grnId/qc-rejections — QC integration (spec §15)
//
// For QUALITY_REJECTION / FAILED_INSPECTION returns the screen loads the
// quantity QC already rejected or held on the GRN and offers it as the
// suggested return quantity, capped at what is still returnable.
// ---------------------------------------------------------------------------
purchaseReturnRouter.get('/purchase-returns/grn/:grnId/qc-rejections', requirePermission('PURCHASE.VIEW'), ah(async (req, res) => {
  const grnId = Number(req.params.grnId);
  const companyId = req.user!.companyId;

  const grn = await queryOne<any>(
    `SELECT id, grn_no, grn_date, supplier_id, warehouse_id, qc_status
       FROM trx_grn WHERE id = ? AND company_id = ?`, [grnId, companyId]);
  if (!grn) throw NotFound('GRN not found');

  const lines = await query<any>(`
    SELECT gl.id AS grn_line_id, gl.material_type, gl.yarn_id, gl.fabric_id, gl.trim_id,
           gl.uom_id, gl.rate, gl.gst_rate, gl.lot_no, gl.qc_status,
           gl.received_qty, gl.accepted_qty,
           COALESCE(gl.rejected_qty, 0) AS rejected_qty,
           COALESCE(gl.hold_qty, 0)     AS hold_qty,
           y.yarn_name, f.fabric_name, u.code AS uom_code,
           COALESCE((
             SELECT SUM(prl.return_qty)
               FROM trx_purchase_return_line prl
               JOIN trx_purchase_return pr ON pr.id = prl.return_id
              WHERE prl.grn_line_id = gl.id AND pr.status <> 'CANCELLED'
           ), 0) AS previous_returned_qty
      FROM trx_grn_line gl
      LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
      LEFT JOIN mst_fabric f ON f.id = gl.fabric_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
     WHERE gl.grn_id = ?
  `, [grnId]);

  const rejected = lines
    .map((l: any) => {
      const qcRejected = Number(l.rejected_qty) + Number(l.hold_qty);
      const stillReturnable = Math.max(0, Number(l.accepted_qty ?? l.received_qty ?? 0) - Number(l.previous_returned_qty));
      return {
        ...l,
        qc_rejected_qty: qcRejected,
        // Never suggest more than is actually still returnable.
        suggested_return_qty: Math.min(qcRejected, stillReturnable),
        item_name: l.yarn_name || l.fabric_name || `Item #${l.grn_line_id}`,
      };
    })
    .filter((l: any) => l.qc_rejected_qty > 0);

  res.json({ data: { grn, lines: rejected, qc_reference: grn.qc_status ?? null } });
}));
