import { Router } from 'express';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';

export const fabricYarnProcurementRouter = Router();

/* ==============================================================================
   PART A: FABRIC PURCHASE & ROLL-LEVEL GRN
   ============================================================================== */

/**
 * 1. POST /api/fabric-purchase-orders/convert-from-quotation
 * Converts an approved fabric quotation to a Fabric PO
 */
fabricYarnProcurementRouter.post('/fabric-purchase-orders/convert-from-quotation', requirePermission('PURCHASE.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const { quotation_id, required_date, remarks, billing_address, shipping_address, shipping_to_party_id } = req.body;

  if (!quotation_id) throw BadRequest('Quotation ID is required');

  const quote = await queryOne<any>(`
    SELECT q.*, cur.id AS currency_id
      FROM trx_quotation q
      LEFT JOIN cfg_currency cur ON cur.id = q.currency_id
     WHERE q.id = ? AND q.company_id = ?
  `, [quotation_id, companyId]);

  if (!quote) throw NotFound('Quotation not found');

  const quoteLines = await query<any>(`
    SELECT ql.*, fb.fabric_name, fb.fabric_type AS master_fabric_type, fb.construction
      FROM trx_quotation_line ql
      LEFT JOIN mst_fabric fb ON fb.id = ql.fabric_id
     WHERE ql.quotation_id = ?
  `, [quotation_id]);

  if (quoteLines.length === 0) throw BadRequest('Quotation has no fabric lines');

  let finalPoNo = '';

  const poId = await transaction(async (tx) => {
    finalPoNo = await nextDocNumber(tx, companyId, 'PURCHASE_ORDER');

    const poRes = await txQueryOne<{ insertId: number }>(tx, `
      INSERT INTO trx_purchase_order (
        company_id, po_no, internal_ir_no, po_date, supplier_id,
        po_type, order_type, quotation_id, style_id, currency_id,
        exchange_rate, delivery_date, payment_terms, total_amount,
        tax_amount, grand_total, approval_state, remarks,
        billing_address, shipping_address, shipping_to_party_id, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      finalPoNo,
      quote.job_no || 'IR-2026-0001',
      new Date().toISOString().slice(0, 10),
      quote.supplier_id || quote.buyer_id, // supplier
      'MATERIAL',
      'PRODUCTION',
      quotation_id,
      quoteLines[0]?.style_id || null,
      quote.currency_id || 1,
      quote.exchange_rate || 1.0,
      required_date || null,
      quote.payment_terms || null,
      quote.taxable_value || quote.total_amount || 0,
      quote.igst_amount || 0,
      quote.total_amount || 0,
      'APPROVED',
      remarks || `Converted from Fabric Quotation ${quote.quotation_no}`,
      billing_address || null,
      shipping_address || null,
      shipping_to_party_id ? Number(shipping_to_party_id) : null,
      userId,
    ]);

    const newPoId = poRes!.insertId;

    for (const ql of quoteLines) {
      await txExecute(tx, `
        INSERT INTO trx_purchase_order_line (
          po_id, material_type, fabric_id, description,
          fabric_type, dia, gsm, composition, shade_code,
          print_flag, print_color, finish,
          qty, uom_id, rate, amount, gst_rate, received_qty
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newPoId,
        'FABRIC',
        ql.fabric_id,
        ql.description || ql.fabric_name || 'Fabric Purchase Item',
        ql.master_fabric_type || 'Knitted',
        ql.dia || '30"',
        ql.gsm || '180',
        ql.construction || '100% Cotton',
        ql.yarn_count || 'NVY-01',
        0,
        null,
        'Compact',
        Number(ql.qty),
        ql.uom_id || 9, // MTR or KG
        Number(ql.unit_price || ql.quotation_rate || 100),
        Number(ql.amount),
        Number(ql.gst_rate || 5.0),
        0,
      ]);
    }

    // Update Quotation status
    await txExecute(tx, `
      UPDATE trx_quotation SET remarks = CONCAT(COALESCE(remarks, ''), ' [Converted to PO: ', ?)
       WHERE id = ?
    `, [finalPoNo, quotation_id]);

    return newPoId;
  });

  await audit(req, 'trx_purchase_order', poId, 'INSERT', null, { po_no: finalPoNo, quotation_id });

  res.json({ data: { id: poId, po_no: finalPoNo } });
}));

/**
 * 2. POST /api/fabric-grns
 * Creates a Fabric GRN with roll-level tracking and updates stock ledger
 */
fabricYarnProcurementRouter.post('/fabric-grns', requirePermission('GRN.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const body = req.body;

  let finalGrnNo = body.grn_no;

  const grnId = await transaction(async (tx) => {
    if (!finalGrnNo) {
      finalGrnNo = await nextDocNumber(tx, companyId, 'GRN');
    }

    // 1. Create GRN Header
    const grnRes = await txQueryOne<{ insertId: number }>(tx, `
      INSERT INTO trx_grn (
        company_id, grn_no, internal_ir_no, grn_date, po_id, style_id,
        supplier_id, warehouse_id, supplier_dc_no, supplier_inv_no,
        vehicle_no, gate_inward_id, qc_status, remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      finalGrnNo,
      body.internal_ir_no || 'IR-2026-0001',
      body.grn_date || new Date().toISOString().slice(0, 10),
      body.po_id ? Number(body.po_id) : null,
      body.style_id ? Number(body.style_id) : null,
      Number(body.supplier_id),
      Number(body.warehouse_id),
      body.supplier_dc_no || null,
      body.supplier_inv_no || null,
      body.vehicle_no || null,
      body.gate_inward_id ? Number(body.gate_inward_id) : null,
      body.qc_status || 'ACCEPTED',
      body.remarks || null,
      userId,
    ]);

    const newGrnId = grnRes!.insertId;

    if (body.gate_inward_id) {
      await txExecute(tx, `
        UPDATE trx_gate_inward
           SET status = 'GRN_COMPLETED'
         WHERE id = ? AND company_id = ?
      `, [Number(body.gate_inward_id), companyId]);
    }

    // 2. Insert GRN Lines
    const lines = Array.isArray(body.lines) ? body.lines : [];
    for (const line of lines) {
      const recQty = Number(line.received_qty) || 0;
      const accQty = Number(line.accepted_qty !== undefined ? line.accepted_qty : recQty);
      const rejQty = Number(line.rejected_qty) || 0;
      const holdQty = Number(line.hold_qty) || 0;
      const poQty = Number(line.po_qty) || recQty;
      const balanceQty = Math.max(0, poQty - accQty);

      const lineRes = await txQueryOne<{ insertId: number }>(tx, `
        INSERT INTO trx_grn_line (
          grn_id, po_line_id, material_type, fabric_id,
          received_qty, received_weight, no_of_rolls,
          accepted_qty, rejected_qty, hold_qty, balance_qty,
          lot_no, qc_status, uom_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newGrnId,
        line.po_line_id ? Number(line.po_line_id) : null,
        'FABRIC',
        Number(line.fabric_id),
        recQty,
        Number(line.received_weight || recQty * 0.25),
        Number(line.no_of_rolls || 1),
        accQty,
        rejQty,
        holdQty,
        balanceQty,
        line.lot_no || 'LOT-DEFAULT',
        line.qc_status || body.qc_status || 'ACCEPTED',
        line.uom_id || 9,
      ]);

      const grnLineId = lineRes!.insertId;

      // 3. Insert Roll-Level Details
      const rolls = Array.isArray(line.rolls) ? line.rolls : [];
      for (let i = 0; i < rolls.length; i++) {
        const r = rolls[i];
        const rNo = r.roll_no || `R-${finalGrnNo}-${i + 1}`;
        await txExecute(tx, `
          INSERT INTO trx_fabric_roll (
            company_id, grn_id, grn_line_id, fabric_id,
            roll_no, lot_no, meters, weight_kg, gsm, dia, shade,
            warehouse_id, location_bin, qc_status, stock_status, remarks
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
          companyId,
          newGrnId,
          grnLineId,
          Number(line.fabric_id),
          rNo,
          r.lot_no || line.lot_no || 'LOT-1',
          Number(r.meters || r.qty || 250),
          Number(r.weight_kg || 62.5),
          Number(r.gsm || 180),
          r.dia || '30"',
          r.shade || 'NVY-01',
          Number(body.warehouse_id),
          r.location_bin || 'A-01',
          r.qc_status || 'ACCEPTED',
          r.qc_status === 'ACCEPTED' ? 'AVAILABLE' : 'RESERVED',
          r.remarks || null,
        ]);
      }

      // 4. Update PO Line Received Qty
      if (line.po_line_id) {
        await txExecute(tx, `
          UPDATE trx_purchase_order_line
             SET received_qty = COALESCE(received_qty, 0) + ?
           WHERE id = ?
        `, [accQty, line.po_line_id]);
      }

      // 5. Post to Stock Ledger if Accepted
      if (accQty > 0 && body.qc_status !== 'REJECTED') {
        await txExecute(tx, `
          INSERT INTO trx_stock_ledger (
            company_id, warehouse_id, material_type, fabric_id,
            txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [
          companyId,
          Number(body.warehouse_id),
          'FABRIC',
          Number(line.fabric_id),
          'GRN',
          'GRN',
          newGrnId,
          accQty,
          0,
          line.uom_id || 9,
          Number(line.rate || 0),
        ]);
      }
    }

    return newGrnId;
  });

  await audit(req, 'trx_grn', grnId, 'INSERT', null, { grn_no: finalGrnNo, po_id: body.po_id });

  res.json({ data: { id: grnId, grn_no: finalGrnNo } });
}));

/**
 * GET /api/fabric-grns
 */
fabricYarnProcurementRouter.get('/fabric-grns', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const rows = await query<any>(`
    SELECT g.*,
           sup.party_name AS supplier_name,
           wh.warehouse_name,
           po.po_no,
           st.style_code,
           gin.entry_no AS gate_entry_no,
           COALESCE((SELECT SUM(gl.received_qty) FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'FABRIC'), 0) AS total_meters,
           COALESCE((SELECT SUM(gl.received_weight) FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'FABRIC'), 0) AS total_weight_kg,
           COALESCE((SELECT COUNT(*) FROM trx_fabric_roll fr WHERE fr.grn_id = g.id), (SELECT SUM(gl.no_of_rolls) FROM trx_grn_line gl WHERE gl.grn_id = g.id)) AS roll_count
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_warehouse wh ON wh.id = g.warehouse_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      LEFT JOIN mst_style st ON st.id = g.style_id
      LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
     WHERE g.company_id = ?
       AND (EXISTS (SELECT 1 FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'FABRIC')
            OR po.po_no LIKE 'FPO%' OR g.grn_no LIKE 'FGRN%')
     ORDER BY g.id DESC
  `, [companyId]);
  res.json({ data: rows });
}));

/**
 * GET /api/fabric-grns/:id
 */
fabricYarnProcurementRouter.get('/fabric-grns/:id', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  const grn = await queryOne<any>(`
    SELECT g.*,
           sup.party_name AS supplier_name,
           wh.warehouse_name,
           po.po_no,
           st.style_code,
           gin.entry_no AS gate_entry_no
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_warehouse wh ON wh.id = g.warehouse_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      LEFT JOIN mst_style st ON st.id = g.style_id
      LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
     WHERE g.id = ? AND g.company_id = ?
  `, [id, companyId]);

  if (!grn) throw NotFound('Fabric GRN not found');

  const lines = await query<any>(`
    SELECT gl.*, fb.fabric_name, fb.fabric_code, fb.construction, u.code AS uom_code
      FROM trx_grn_line gl
      LEFT JOIN mst_fabric fb ON fb.id = gl.fabric_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
     WHERE gl.grn_id = ?
  `, [id]);

  const rolls = await query<any>(`
    SELECT fr.*, fb.fabric_name, fb.fabric_code
      FROM trx_fabric_roll fr
      LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
     WHERE fr.grn_id = ?
     ORDER BY fr.id ASC
  `, [id]);

  res.json({ data: { ...grn, lines, rolls } });
}));

/**
 * 3. GET /api/fabric-rolls
 * Search and list physical fabric roll stock
 */
fabricYarnProcurementRouter.get('/fabric-rolls', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const { fabric_id, lot_no, shade, qc_status, stock_status, search } = req.query;

  let sql = `
    SELECT fr.*,
           fb.fabric_name, fb.fabric_code,
           wh.warehouse_name,
           grn.grn_no, grn.grn_date, grn.internal_ir_no,
           po.po_no,
           st.style_code
      FROM trx_fabric_roll fr
      LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
      LEFT JOIN mst_warehouse wh ON wh.id = fr.warehouse_id
      LEFT JOIN trx_grn grn ON grn.id = fr.grn_id
      LEFT JOIN trx_purchase_order po ON po.id = grn.po_id
      LEFT JOIN mst_style st ON st.id = grn.style_id
     WHERE fr.company_id = ?
  `;
  const params: any[] = [companyId];

  if (fabric_id) {
    sql += ` AND fr.fabric_id = ?`;
    params.push(Number(fabric_id));
  }
  if (req.query.grn_id) {
    sql += ` AND fr.grn_id = ?`;
    params.push(Number(req.query.grn_id));
  }
  if (lot_no) {
    sql += ` AND fr.lot_no LIKE ?`;
    params.push(`%${lot_no}%`);
  }
  if (shade) {
    sql += ` AND fr.shade LIKE ?`;
    params.push(`%${shade}%`);
  }
  if (qc_status) {
    sql += ` AND fr.qc_status = ?`;
    params.push(String(qc_status));
  }
  if (stock_status) {
    sql += ` AND fr.stock_status = ?`;
    params.push(String(stock_status));
  }
  if (search) {
    sql += ` AND (fr.roll_no LIKE ? OR fr.lot_no LIKE ? OR fb.fabric_name LIKE ? OR fr.shade LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }

  sql += ` ORDER BY fr.id DESC`;

  const rows = await query<any>(sql, params);
  res.json({ data: rows });
}));

/**
 * 4. POST /api/fabric-rolls/:id/status
 * Update roll stock status (e.g. AVAILABLE, RESERVED, ISSUED, CLOSED)
 */
fabricYarnProcurementRouter.post('/fabric-rolls/:id/status', requirePermission('INVENTORY.ADJUST'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  const { stock_status, qc_status, location_bin } = req.body;

  const roll = await queryOne<any>(`
    SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ?
  `, [id, companyId]);

  if (!roll) throw NotFound('Roll not found');

  await query(`
    UPDATE trx_fabric_roll
       SET stock_status = COALESCE(?, stock_status),
           qc_status = COALESCE(?, qc_status),
           location_bin = COALESCE(?, location_bin)
     WHERE id = ? AND company_id = ?
  `, [stock_status || null, qc_status || null, location_bin || null, id, companyId]);

  res.json({ data: { success: true, id } });
}));

/* ==============================================================================
   PART B: YARN PURCHASE & YARN GRN (GREY / DYED, DIRECT KG / PACK-BAG)
   ============================================================================== */

/**
 * 5. POST /api/yarn-purchase-orders/convert-from-quotation
 * Converts an approved yarn quotation to a Yarn PO
 */
fabricYarnProcurementRouter.post('/yarn-purchase-orders/convert-from-quotation', requirePermission('PURCHASE.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const { quotation_id, required_date, remarks, billing_address, shipping_address, shipping_to_party_id } = req.body;

  if (!quotation_id) throw BadRequest('Quotation ID is required');

  const quote = await queryOne<any>(`
    SELECT q.*, cur.id AS currency_id
      FROM trx_quotation q
      LEFT JOIN cfg_currency cur ON cur.id = q.currency_id
     WHERE q.id = ? AND q.company_id = ?
  `, [quotation_id, companyId]);

  if (!quote) throw NotFound('Quotation not found');

  const quoteLines = await query<any>(`
    SELECT ql.*, y.yarn_name, y.yarn_type AS master_yarn_type, y.composition
      FROM trx_quotation_line ql
      LEFT JOIN mst_yarn y ON y.id = ql.yarn_id
     WHERE ql.quotation_id = ?
  `, [quotation_id]);

  if (quoteLines.length === 0) throw BadRequest('Quotation has no yarn lines');

  let finalPoNo = '';

  const poId = await transaction(async (tx) => {
    finalPoNo = await nextDocNumber(tx, companyId, 'PURCHASE_ORDER');

    const poRes = await txQueryOne<{ insertId: number }>(tx, `
      INSERT INTO trx_purchase_order (
        company_id, po_no, internal_ir_no, po_date, supplier_id,
        po_type, order_type, quotation_id, style_id, currency_id,
        exchange_rate, delivery_date, payment_terms, total_amount,
        tax_amount, grand_total, approval_state, remarks,
        billing_address, shipping_address, shipping_to_party_id, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      finalPoNo,
      quote.job_no || 'IR-2026-0001',
      new Date().toISOString().slice(0, 10),
      quote.supplier_id || quote.buyer_id,
      'MATERIAL',
      'PRODUCTION',
      quotation_id,
      quoteLines[0]?.style_id || null,
      quote.currency_id || 1,
      quote.exchange_rate || 1.0,
      required_date || null,
      quote.payment_terms || null,
      quote.taxable_value || quote.total_amount || 0,
      quote.igst_amount || 0,
      quote.total_amount || 0,
      'APPROVED',
      remarks || `Converted from Yarn Quotation ${quote.quotation_no}`,
      billing_address || null,
      shipping_address || null,
      shipping_to_party_id ? Number(shipping_to_party_id) : null,
      userId,
    ]);

    const newPoId = poRes!.insertId;

    for (const ql of quoteLines) {
      const isDyed = ql.yarn_type?.toLowerCase().includes('dyed');
      await txExecute(tx, `
        INSERT INTO trx_purchase_order_line (
          po_id, material_type, yarn_id, description,
          yarn_type, purchase_basis, yarn_count_str, yarn_category, composition, shade_code,
          qty, uom_id, rate, amount, gst_rate, received_qty
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newPoId,
        'YARN',
        ql.yarn_id,
        ql.description || ql.yarn_name || 'Yarn Purchase Item',
        isDyed ? 'Dyed Yarn' : 'Grey Yarn',
        'DIRECT_KG',
        ql.yarn_count || '30s',
        'Ring Spun',
        ql.composition || '100% Cotton',
        isDyed ? (ql.yarn_count || 'NB045') : null,
        Number(ql.qty),
        5, // KG
        Number(ql.unit_price || ql.quotation_rate || 185),
        Number(ql.amount),
        Number(ql.gst_rate || 5.0),
        0,
      ]);
    }

    return newPoId;
  });

  await audit(req, 'trx_purchase_order', poId, 'INSERT', null, { po_no: finalPoNo, quotation_id });

  res.json({ data: { id: poId, po_no: finalPoNo } });
}));

/**
 * 6. POST /api/yarn-grns
 * Creates a Yarn GRN and updates stock ledger in KG
 */
fabricYarnProcurementRouter.post('/yarn-grns', requirePermission('GRN.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const body = req.body;

  let finalGrnNo = body.grn_no;

  const grnId = await transaction(async (tx) => {
    if (!finalGrnNo) {
      finalGrnNo = await nextDocNumber(tx, companyId, 'GRN');
    }

    const grnRes = await txQueryOne<{ insertId: number }>(tx, `
      INSERT INTO trx_grn (
        company_id, grn_no, internal_ir_no, grn_date, po_id, style_id,
        supplier_id, warehouse_id, supplier_dc_no, supplier_inv_no,
        vehicle_no, gate_inward_id, qc_status, remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      finalGrnNo,
      body.internal_ir_no || 'IR-2026-0001',
      body.grn_date || new Date().toISOString().slice(0, 10),
      body.po_id ? Number(body.po_id) : null,
      body.style_id ? Number(body.style_id) : null,
      Number(body.supplier_id),
      Number(body.warehouse_id),
      body.supplier_dc_no || null,
      body.supplier_inv_no || null,
      body.vehicle_no || null,
      body.gate_inward_id ? Number(body.gate_inward_id) : null,
      body.qc_status || 'ACCEPTED',
      body.remarks || null,
      userId,
    ]);

    const newGrnId = grnRes!.insertId;

    if (body.gate_inward_id) {
      await txExecute(tx, `
        UPDATE trx_gate_inward
           SET status = 'GRN_COMPLETED'
         WHERE id = ? AND company_id = ?
      `, [Number(body.gate_inward_id), companyId]);
    }

    const lines = Array.isArray(body.lines) ? body.lines : [];
    for (const line of lines) {
      const recKg = Number(line.received_qty) || 0;
      const accKg = Number(line.accepted_qty !== undefined ? line.accepted_qty : recKg);
      const rejKg = Number(line.rejected_qty) || 0;
      const holdKg = Number(line.hold_qty) || 0;
      const poKg = Number(line.po_qty) || recKg;
      const balanceKg = Math.max(0, poKg - accKg);

      await txExecute(tx, `
        INSERT INTO trx_grn_line (
          grn_id, po_line_id, material_type, yarn_id,
          received_qty, received_weight, no_of_rolls,
          accepted_qty, rejected_qty, hold_qty, balance_qty,
          lot_no, qc_status, uom_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newGrnId,
        line.po_line_id ? Number(line.po_line_id) : null,
        'YARN',
        Number(line.yarn_id),
        recKg,
        recKg,
        Number(line.packs || line.no_of_rolls || 1),
        accKg,
        rejKg,
        holdKg,
        balanceKg,
        line.lot_no || 'LOT-YARN-DEFAULT',
        line.qc_status || body.qc_status || 'ACCEPTED',
        5, // KG
      ]);

      if (line.po_line_id) {
        await txExecute(tx, `
          UPDATE trx_purchase_order_line
             SET received_qty = COALESCE(received_qty, 0) + ?
           WHERE id = ?
        `, [accKg, line.po_line_id]);
      }

      if (accKg > 0 && body.qc_status !== 'REJECTED') {
        await txExecute(tx, `
          INSERT INTO trx_stock_ledger (
            company_id, warehouse_id, material_type, yarn_id,
            txn_type, ref_type, ref_id, qty_in, qty_out, uom_id, rate
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [
          companyId,
          Number(body.warehouse_id),
          'YARN',
          Number(line.yarn_id),
          'GRN',
          'GRN',
          newGrnId,
          accKg,
          0,
          5, // KG
          Number(line.rate || 0),
        ]);
      }
    }

    return newGrnId;
  });

  res.json({ data: { id: grnId, grn_no: finalGrnNo } });
}));

/**
 * GET /api/yarn-grns
 */
fabricYarnProcurementRouter.get('/yarn-grns', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const rows = await query<any>(`
    SELECT g.*,
           sup.party_name AS supplier_name,
           wh.warehouse_name,
           po.po_no,
           st.style_code,
           gin.entry_no AS gate_entry_no,
           COALESCE((SELECT SUM(gl.received_qty) FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'YARN'), 0) AS total_kg,
           COALESCE((SELECT SUM(gl.no_of_rolls) FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'YARN'), 0) AS total_packs
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_warehouse wh ON wh.id = g.warehouse_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      LEFT JOIN mst_style st ON st.id = g.style_id
      LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
     WHERE g.company_id = ?
       AND (EXISTS (SELECT 1 FROM trx_grn_line gl WHERE gl.grn_id = g.id AND gl.material_type = 'YARN')
            OR po.po_no LIKE 'YPO%' OR g.grn_no LIKE 'YGRN%')
     ORDER BY g.id DESC
  `, [companyId]);
  res.json({ data: rows });
}));

/**
 * GET /api/yarn-grns/:id
 */
fabricYarnProcurementRouter.get('/yarn-grns/:id', requirePermission('GRN.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  const grn = await queryOne<any>(`
    SELECT g.*,
           sup.party_name AS supplier_name,
           wh.warehouse_name,
           po.po_no,
           st.style_code,
           gin.entry_no AS gate_entry_no
      FROM trx_grn g
      LEFT JOIN mst_party sup ON sup.id = g.supplier_id
      LEFT JOIN mst_warehouse wh ON wh.id = g.warehouse_id
      LEFT JOIN trx_purchase_order po ON po.id = g.po_id
      LEFT JOIN mst_style st ON st.id = g.style_id
      LEFT JOIN trx_gate_inward gin ON gin.id = g.gate_inward_id
     WHERE g.id = ? AND g.company_id = ?
  `, [id, companyId]);

  if (!grn) throw NotFound('Yarn GRN not found');

  const lines = await query<any>(`
    SELECT gl.*, y.yarn_name, y.yarn_code, y.yarn_type, y.composition, u.code AS uom_code
      FROM trx_grn_line gl
      LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
     WHERE gl.grn_id = ?
  `, [id]);

  res.json({ data: { ...grn, lines } });
}));

