import { Router } from 'express';
import { z } from 'zod';
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
    SELECT ql.*, fb.fabric_name, fb.fabric_type AS master_fabric_type, comp.description AS construction
      FROM trx_quotation_line ql
      LEFT JOIN mst_fabric fb ON fb.id = ql.fabric_id
      LEFT JOIN mst_composition comp ON comp.id = fb.composition_id
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
      const isDyed = ql.fabric_category === 'Dyed Fabric' || Boolean(ql.color_name || ql.shade_code);
      const category = ql.fabric_category || (isDyed ? 'Dyed Fabric' : 'Grey Fabric');

      await txExecute(tx, `
        INSERT INTO trx_purchase_order_line (
          po_id, material_type, fabric_id, description,
          fabric_type, fabric_category, pantone_spec, color_name,
          dia, gsm, composition, shade_code,
          print_flag, print_color, finish,
          qty, uom_id, rate, amount, gst_rate, received_qty
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newPoId,
        'FABRIC',
        ql.fabric_id,
        ql.description || ql.fabric_name || 'Fabric Purchase Item',
        ql.fabric_type || ql.master_fabric_type || 'Knitted',
        category,
        ql.pantone_spec || null,
        ql.color_name || null,
        ql.dia || '30"',
        ql.gsm || '180',
        ql.composition || ql.construction || '100% Cotton',
        ql.shade_code || (isDyed ? (ql.color_name || 'NVY-01') : null),
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

    // 1. Calculate totals across lines
    const lines = Array.isArray(body.lines) ? body.lines : [];
    let totTaxable = 0;
    let totCgst = 0;
    let totSgst = 0;
    let totIgst = 0;
    const isInterstate = Boolean(body.is_interstate);

    const calculatedLines = lines.map((line: any) => {
      const recQty = Number(line.received_qty) || 0;
      const accQty = Number(line.accepted_qty !== undefined ? line.accepted_qty : recQty);
      const rejQty = Number(line.rejected_qty) || 0;
      const holdQty = Number(line.hold_qty) || 0;
      const poQty = Number(line.po_qty) || recQty;
      const balanceQty = Math.max(0, poQty - accQty);
      const rate = Number(line.rate) || 0;
      const taxable = Number(line.taxable_amount !== undefined ? line.taxable_amount : (accQty * rate));
      const gstRate = Number(line.gst_rate !== undefined ? line.gst_rate : 5);

      let cgst = 0;
      let sgst = 0;
      let igst = 0;
      if (isInterstate) {
        igst = Number(((taxable * gstRate) / 100).toFixed(4));
      } else {
        cgst = Number(((taxable * (gstRate / 2)) / 100).toFixed(4));
        sgst = Number(((taxable * (gstRate / 2)) / 100).toFixed(4));
      }
      const taxAmt = cgst + sgst + igst;
      const lineTotal = taxable + taxAmt;

      totTaxable += taxable;
      totCgst += cgst;
      totSgst += sgst;
      totIgst += igst;

      return {
        ...line,
        recQty,
        accQty,
        rejQty,
        holdQty,
        balanceQty,
        rate,
        taxable,
        gstRate,
        cgst,
        sgst,
        igst,
        taxAmt,
        lineTotal,
      };
    });

    const totTax = totCgst + totSgst + totIgst;
    const netAmount = totTaxable + totTax;

    const freightCharges = Number(body.freight_charges) || 0;
    const otherCharges = Number(body.other_charges) || 0;
    const roundOff = Number(body.round_off) || 0;
    const tcsApplicable = Boolean(body.tcs_applicable);
    const tcsSection = tcsApplicable ? (body.tcs_section || '206C(1H)') : null;
    const tcsRate = tcsApplicable ? (Number(body.tcs_rate) || 0) : 0;
    const baseBeforeTcs = netAmount + freightCharges + otherCharges;
    const tcsAmount = tcsApplicable
      ? Number(((baseBeforeTcs * tcsRate) / 100).toFixed(4))
      : 0;
    const grandTotal = Number((baseBeforeTcs + tcsAmount + roundOff).toFixed(4));

    const poIds = Array.isArray(body.po_ids)
      ? body.po_ids.map(Number).filter((n: number) => n > 0)
      : (body.po_id ? [Number(body.po_id)] : []);
    const primaryPoId = poIds[0] || (body.po_id ? Number(body.po_id) : null);
    const poIdsJson = poIds.length > 0 ? JSON.stringify(poIds) : null;

    // 2. Create GRN Header
    const grnRes = await txExecute(tx, `
      INSERT INTO trx_grn (
        company_id, grn_no, internal_ir_no, grn_date, po_id, po_ids, style_id,
        supplier_id, warehouse_id, supplier_dc_no, supplier_inv_no,
        vehicle_no, gate_inward_id, qc_status, is_interstate,
        taxable_amount, tax_amount, cgst_amount, sgst_amount, igst_amount, net_amount,
        freight_charges, other_charges, round_off,
        tcs_applicable, tcs_section, tcs_rate, tcs_amount, grand_total,
        remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      finalGrnNo,
      body.internal_ir_no || 'IR-2026-0001',
      body.grn_date || new Date().toISOString().slice(0, 10),
      primaryPoId,
      poIdsJson,
      body.style_id ? Number(body.style_id) : null,
      Number(body.supplier_id),
      Number(body.warehouse_id),
      body.supplier_dc_no || null,
      body.supplier_inv_no || null,
      body.vehicle_no || null,
      body.gate_inward_id ? Number(body.gate_inward_id) : null,
      body.qc_status || 'ACCEPTED',
      isInterstate ? 1 : 0,
      totTaxable,
      totTax,
      totCgst,
      totSgst,
      totIgst,
      netAmount,
      freightCharges,
      otherCharges,
      roundOff,
      tcsApplicable ? 1 : 0,
      tcsSection,
      tcsRate,
      tcsAmount,
      grandTotal,
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

    // 3. Insert GRN Lines
    for (const line of calculatedLines) {
      const linePoId = line.po_id ? Number(line.po_id) : primaryPoId;
      const lineRes = await txExecute(tx, `
        INSERT INTO trx_grn_line (
          grn_id, po_id, po_line_id, so_id, style_id, material_type, fabric_id,
          fabric_category, pantone_spec, color_name, shade_code,
          received_qty, received_weight, no_of_rolls,
          accepted_qty, rejected_qty, hold_qty, balance_qty,
          rate, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, total_amount,
          lot_no, qc_status, uom_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newGrnId,
        linePoId,
        line.po_line_id ? Number(line.po_line_id) : null,
        line.so_id ? Number(line.so_id) : (body.so_id ? Number(body.so_id) : null),
        line.style_id ? Number(line.style_id) : (body.style_id ? Number(body.style_id) : null),
        'FABRIC',
        Number(line.fabric_id),
        line.fabric_category || 'Grey Fabric',
        line.pantone_spec || null,
        line.color_name || null,
        line.shade_code || null,
        line.recQty,
        Number(line.received_weight || line.recQty * 0.25),
        Number(line.no_of_rolls || 1),
        line.accQty,
        line.rejQty,
        line.holdQty,
        line.balanceQty,
        line.rate,
        line.taxable,
        line.gstRate,
        line.cgst,
        line.sgst,
        line.igst,
        line.lineTotal,
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
        `, [line.accQty, line.po_line_id]);
      }

      // 5. Post to Stock Ledger if Accepted
      if (line.accQty > 0 && body.qc_status !== 'REJECTED') {
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
          line.accQty,
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
    SELECT gl.*, po.po_no, fb.fabric_name, fb.fabric_code, comp.description AS construction, u.code AS uom_code
      FROM trx_grn_line gl
      LEFT JOIN trx_purchase_order po ON po.id = gl.po_id
      LEFT JOIN mst_fabric fb ON fb.id = gl.fabric_id
      LEFT JOIN mst_composition comp ON comp.id = fb.composition_id
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

/* ------------------------------------------------------------------------------
   Shared helpers for the roll / yarn stock lists
   ------------------------------------------------------------------------------ */

/**
 * Tables that only exist once later migrations ran. Production schemas can lag
 * behind local, so optional sources are probed once per process instead of
 * letting a missing table 500 the whole stock list.
 */
const tableExistsCache = new Map<string, boolean>();
async function tableExists(name: string): Promise<boolean> {
  const hit = tableExistsCache.get(name);
  if (hit !== undefined) return hit;
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [name]);
  const ok = Number(row?.n ?? 0) > 0;
  tableExistsCache.set(name, ok);
  return ok;
}
async function columnExists(table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  const hit = tableExistsCache.get(key);
  if (hit !== undefined) return hit;
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  const ok = Number(row?.n ?? 0) > 0;
  tableExistsCache.set(key, ok);
  return ok;
}

/**
 * Job (IO) + style traceability joins for anything hanging off a GRN line.
 * Expects aliases `gl` (trx_grn_line) and `grn` (trx_grn). Resolution order is
 * most-specific first: GRN line → PO line → line sales order → PO header →
 * GRN header → PO's sales order → the IO's CAD requirement. A sales order only contributes a style when
 * it carries exactly one style (otherwise it would be a guess).
 */
const TRACE_JOINS = `
      LEFT JOIN trx_purchase_order_line pol ON pol.id = gl.po_line_id
      LEFT JOIN trx_purchase_order po
             ON po.id = COALESCE(gl.po_id, pol.po_id, grn.po_id) AND po.company_id = grn.company_id
      LEFT JOIN trx_sales_order so_l
             ON so_l.id = COALESCE(gl.so_id, pol.so_id) AND so_l.company_id = grn.company_id
      LEFT JOIN trx_sales_order so_h
             ON so_h.id = po.so_id AND so_h.company_id = grn.company_id
      LEFT JOIN (SELECT so_id, MIN(style_id) AS style_id
                   FROM trx_sales_order_line
                  GROUP BY so_id
                 HAVING COUNT(DISTINCT style_id) = 1) sol_l ON sol_l.so_id = so_l.id
      LEFT JOIN (SELECT so_id, MIN(style_id) AS style_id
                   FROM trx_sales_order_line
                  GROUP BY so_id
                 HAVING COUNT(DISTINCT style_id) = 1) sol_h ON sol_h.so_id = so_h.id
      LEFT JOIN (SELECT company_id, internal_ir_no, MIN(style_id) AS style_id
                   FROM trx_cad_requirement
                  WHERE internal_ir_no IS NOT NULL AND internal_ir_no <> '' AND style_id IS NOT NULL
                  GROUP BY company_id, internal_ir_no
                 HAVING COUNT(DISTINCT style_id) = 1) cad_io
             ON cad_io.company_id = grn.company_id
            AND cad_io.internal_ir_no = COALESCE(NULLIF(grn.internal_ir_no,''), NULLIF(po.internal_ir_no,''))`;

// Last resort: the internal order's CAD requirement, which is where job-wise
// fabric/yarn buying usually starts (the GRN often carries only the IO no).
const TRACE_STYLE_ID = `COALESCE(gl.style_id, pol.style_id, sol_l.style_id, po.style_id, grn.style_id, sol_h.style_id, cad_io.style_id)`;
const TRACE_IO_NO = `COALESCE(NULLIF(so_l.io_no,''), NULLIF(grn.internal_ir_no,''), NULLIF(po.internal_ir_no,''), NULLIF(so_h.io_no,''))`;
const TRACE_SO_NO = `COALESCE(so_l.so_no, so_h.so_no)`;

const rollListQuery = z.object({
  fabric_id: z.coerce.number().int().positive().optional(),
  grn_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  style_id: z.coerce.number().int().positive().optional(),
  io_no: z.string().trim().max(60).optional().transform((v) => v || undefined),
  lot_no: z.string().trim().max(60).optional().transform((v) => v || undefined),
  shade: z.string().trim().max(80).optional().transform((v) => v || undefined),
  qc_status: z.enum(['PENDING', 'ACCEPTED', 'HOLD', 'REJECTED']).optional(),
  stock_status: z.enum(['AVAILABLE', 'RESERVED', 'ISSUED', 'PARTIAL', 'CLOSED']).optional(),
  search: z.string().trim().max(100).optional().transform((v) => v || undefined),
});

/**
 * 3. GET /api/fabric-rolls
 * Search and list physical fabric roll stock, with the job (IO) and style the
 * roll was bought for resolved from the roll's own GRN line.
 */
fabricYarnProcurementRouter.get('/fabric-rolls', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const q = rollListQuery.parse(req.query);

  const where: string[] = [];
  const params: any[] = [companyId];

  if (q.fabric_id) { where.push(`t.fabric_id = ?`); params.push(q.fabric_id); }
  if (q.grn_id) { where.push(`t.grn_id = ?`); params.push(q.grn_id); }
  if (q.lot_no) { where.push(`t.lot_no LIKE ?`); params.push(`%${q.lot_no}%`); }
  if (q.shade) { where.push(`t.shade LIKE ?`); params.push(`%${q.shade}%`); }
  if (q.qc_status) { where.push(`t.qc_status = ?`); params.push(q.qc_status); }
  if (q.stock_status) { where.push(`t.stock_status = ?`); params.push(q.stock_status); }
  if (q.warehouse_id) { where.push(`t.warehouse_id = ?`); params.push(q.warehouse_id); }
  if (q.io_no) { where.push(`t.internal_ir_no = ?`); params.push(q.io_no); }
  if (q.style_id) { where.push(`t.style_id = ?`); params.push(q.style_id); }
  if (q.search) {
    where.push(`(t.roll_no LIKE ? OR t.lot_no LIKE ? OR t.fabric_name LIKE ? OR t.fabric_code LIKE ?
             OR t.shade LIKE ? OR t.grn_no LIKE ? OR t.po_no LIKE ? OR t.internal_ir_no LIKE ?
             OR t.style_code LIKE ? OR t.style_name LIKE ? OR t.location_bin LIKE ?)`);
    const term = `%${q.search}%`;
    params.push(term, term, term, term, term, term, term, term, term, term, term);
  }

  const rows = await query<any>(`
    SELECT t.* FROM (
      SELECT fr.*,
             (COALESCE(fr.weight_kg,0) - COALESCE(fr.issued_kg,0)) AS balance_kg,
             fb.fabric_name, fb.fabric_code,
             wh.warehouse_name,
             grn.grn_no, grn.grn_date,
             po.po_no,
             ${TRACE_SO_NO}   AS so_no,
             ${TRACE_IO_NO}   AS internal_ir_no,
             ${TRACE_STYLE_ID} AS style_id,
             st.style_code, st.style_name,
             sup.party_name AS supplier_name
        FROM trx_fabric_roll fr
        JOIN trx_grn grn ON grn.id = fr.grn_id AND grn.company_id = fr.company_id
        LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id AND gl.grn_id = grn.id
        ${TRACE_JOINS}
        LEFT JOIN mst_style st ON st.id = ${TRACE_STYLE_ID} AND st.company_id = grn.company_id
        LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
        LEFT JOIN mst_warehouse wh ON wh.id = fr.warehouse_id
        LEFT JOIN mst_party sup ON sup.id = grn.supplier_id
       WHERE fr.company_id = ?
    ) t
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.id DESC
  `, params);

  const facets = await query<any>(`
    SELECT DISTINCT ${TRACE_IO_NO} AS io_no, ${TRACE_STYLE_ID} AS style_id, st.style_code, st.style_name
      FROM trx_fabric_roll fr
      JOIN trx_grn grn ON grn.id = fr.grn_id AND grn.company_id = fr.company_id
      LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id AND gl.grn_id = grn.id
      ${TRACE_JOINS}
      LEFT JOIN mst_style st ON st.id = ${TRACE_STYLE_ID} AND st.company_id = grn.company_id
     WHERE fr.company_id = ?
  `, [companyId]);

  res.json({ data: rows, facets: buildTraceFacets(facets) });
}));

/** Distinct IO numbers + styles for the stock list filter dropdowns. */
function buildTraceFacets(facets: any[]) {
  const ioNos = [...new Set(facets.map((f) => f.io_no).filter(Boolean))].sort();
  const styleMap = new Map<number, { id: number; style_code: string; style_name: string }>();
  for (const f of facets) {
    if (f.style_id && !styleMap.has(Number(f.style_id))) {
      styleMap.set(Number(f.style_id), { id: Number(f.style_id), style_code: f.style_code, style_name: f.style_name });
    }
  }
  return {
    io_nos: ioNos,
    styles: [...styleMap.values()].sort((a, b) => String(a.style_code).localeCompare(String(b.style_code))),
  };
}


/**
 * 4. POST /api/fabric-rolls/:id/status
 * Update roll stock status (e.g. AVAILABLE, RESERVED, ISSUED, CLOSED)
 */
const rollStatusSchema = z.object({
  stock_status: z.enum(['AVAILABLE', 'RESERVED', 'ISSUED', 'PARTIAL', 'CLOSED']).optional(),
  qc_status: z.enum(['PENDING', 'ACCEPTED', 'HOLD', 'REJECTED']).optional(),
  location_bin: z.string().trim().max(50).optional(),
});

fabricYarnProcurementRouter.post('/fabric-rolls/:id/status', requirePermission('INVENTORY.ADJUST'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid roll id');
  const body = rollStatusSchema.parse(req.body ?? {});

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
  `, [body.stock_status ?? null, body.qc_status ?? null, body.location_bin || null, id, companyId]);

  await audit(req, 'trx_fabric_roll', id, 'UPDATE',
    { stock_status: roll.stock_status, qc_status: roll.qc_status, location_bin: roll.location_bin },
    body);

  res.json({ data: { success: true, id } });
}));

/* ==============================================================================
   PART A-5: YARN STOCK LIST (batch/lot level)
   ============================================================================== */

const yarnStockQuery = z.object({
  yarn_id: z.coerce.number().int().positive().optional(),
  grn_id: z.coerce.number().int().positive().optional(),
  warehouse_id: z.coerce.number().int().positive().optional(),
  style_id: z.coerce.number().int().positive().optional(),
  io_no: z.string().trim().max(60).optional().transform((v) => v || undefined),
  lot_no: z.string().trim().max(60).optional().transform((v) => v || undefined),
  shade: z.string().trim().max(80).optional().transform((v) => v || undefined),
  qc_status: z.enum(['PENDING', 'ACCEPTED', 'PARTIAL_ACCEPTED', 'HOLD', 'REJECTED']).optional(),
  stock_status: z.enum(['AVAILABLE', 'PARTIAL', 'CLOSED', 'PENDING', 'HOLD', 'REJECTED']).optional(),
  search: z.string().trim().max(100).optional().transform((v) => v || undefined),
});

/**
 * Yarn issued out of stock, keyed by yarn + lot. Every issue screen in the
 * system (knitting work order, knitting program, yarn process) records the lot
 * it drew from rather than the GRN line, so issues are summed per yarn/lot and
 * then spread FIFO over that lot's GRN lines in the main query.
 */
async function yarnLotIssueSql(companyId: number): Promise<{ sql: string; params: any[] }> {
  const parts: string[] = [];
  const params: any[] = [];
  if (await tableExists('trx_knitting_yarn_issue')) {
    parts.push(`SELECT yarn_id, yarn_lot_no AS lot_no, issued_weight_kg AS qty
                  FROM trx_knitting_yarn_issue WHERE company_id = ?`);
    params.push(companyId);
  }
  if (await tableExists('trx_knitting_program_yarn_issues')) {
    parts.push(`SELECT yarn_id, yarn_lot_no AS lot_no, issued_qty_kg AS qty
                  FROM trx_knitting_program_yarn_issues WHERE company_id = ?`);
    params.push(companyId);
  }
  if (await tableExists('trx_process_issue')) {
    parts.push(`SELECT yarn_id, lot_no, issued_qty_kg AS qty
                  FROM trx_process_issue WHERE company_id = ?`);
    params.push(companyId);
  }
  if (!parts.length) {
    return { sql: `SELECT NULL AS yarn_id, NULL AS lot_no, 0 AS issued_qty FROM DUAL WHERE 1 = 0`, params };
  }
  return {
    sql: `SELECT x.yarn_id, x.lot_no, SUM(x.qty) AS issued_qty
            FROM (${parts.join(' UNION ALL ')}) x
           WHERE x.yarn_id IS NOT NULL AND x.lot_no IS NOT NULL AND x.lot_no <> ''
           GROUP BY x.yarn_id, x.lot_no`,
    params,
  };
}

/**
 * GET /api/yarn-stock
 * Yarn stock per GRN lot line with Internal Order No & Style traceability.
 * Mirrors /fabric-rolls but for yarn — yarn is tracked at batch/lot level, not
 * individual roll.
 *
 * Balance = accepted − purchase returns − yarn issued from that lot. Note that
 * trx_grn_line.balance_qty is the PO quantity still to be received, NOT stock,
 * so it is exposed as po_pending_qty and never used as the stock balance.
 */
fabricYarnProcurementRouter.get('/yarn-stock', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const q = yarnStockQuery.parse(req.query);

  const lotIssue = await yarnLotIssueSql(companyId);
  const hasReturns = await tableExists('trx_purchase_return_line') && await tableExists('trx_purchase_return');
  const hasMatIssue = await tableExists('trx_material_issue_line') && await tableExists('trx_material_issue');

  // A return only takes yarn out of the store once its stock is posted.
  const returnPostedCond = hasReturns && await columnExists('trx_purchase_return', 'stock_posted')
    ? 'AND pr.stock_posted = 1' : '';
  const returnedSql = hasReturns
    ? `COALESCE((SELECT SUM(prl.return_qty)
                   FROM trx_purchase_return_line prl
                   JOIN trx_purchase_return pr ON pr.id = prl.return_id
                  WHERE prl.grn_line_id = gl.id AND pr.company_id = grn.company_id
                    AND pr.status <> 'CANCELLED' ${returnPostedCond}), 0)`
    : '0';
  // General material issues reference the batch, not the lot.
  const matIssueSql = hasMatIssue
    ? `CASE WHEN gl.batch_id IS NULL THEN 0 ELSE COALESCE((
         SELECT SUM(mil.issued_qty)
           FROM trx_material_issue_line mil
           JOIN trx_material_issue mi ON mi.id = mil.issue_id
          WHERE mi.company_id = grn.company_id AND mil.material_type = 'YARN'
            AND mil.yarn_id = gl.yarn_id AND mil.batch_id = gl.batch_id), 0) END`
    : '0';

  const where: string[] = [];
  const filterParams: any[] = [];
  if (q.yarn_id) { where.push(`s.yarn_id = ?`); filterParams.push(q.yarn_id); }
  if (q.grn_id) { where.push(`s.grn_id = ?`); filterParams.push(q.grn_id); }
  if (q.warehouse_id) { where.push(`s.warehouse_id = ?`); filterParams.push(q.warehouse_id); }
  if (q.style_id) { where.push(`s.style_id = ?`); filterParams.push(q.style_id); }
  if (q.io_no) { where.push(`s.internal_ir_no = ?`); filterParams.push(q.io_no); }
  if (q.lot_no) { where.push(`s.lot_no LIKE ?`); filterParams.push(`%${q.lot_no}%`); }
  if (q.shade) { where.push(`(s.shade LIKE ? OR s.color_name LIKE ?)`); filterParams.push(`%${q.shade}%`, `%${q.shade}%`); }
  if (q.qc_status) { where.push(`s.qc_status = ?`); filterParams.push(q.qc_status); }
  if (q.stock_status) { where.push(`s.stock_status = ?`); filterParams.push(q.stock_status); }
  if (q.search) {
    where.push(`(s.lot_no LIKE ? OR s.yarn_name LIKE ? OR s.yarn_code LIKE ? OR s.shade LIKE ?
             OR s.color_name LIKE ? OR s.internal_ir_no LIKE ? OR s.style_code LIKE ? OR s.style_name LIKE ?
             OR s.grn_no LIKE ? OR s.po_no LIKE ? OR s.supplier_name LIKE ? OR s.location_bin LIKE ?)`);
    const term = `%${q.search}%`;
    filterParams.push(term, term, term, term, term, term, term, term, term, term, term, term);
  }

  const rows = await query<any>(`
    WITH base AS (
      SELECT
        gl.id, gl.grn_id, gl.yarn_id, gl.lot_no, gl.batch_id,
        gl.shade_code                        AS shade,
        gl.color_name,
        gl.yarn_type                         AS grn_yarn_type,
        gl.received_qty, gl.accepted_qty, gl.rejected_qty, gl.hold_qty,
        gl.balance_qty                       AS po_pending_qty,
        gl.qc_status,
        gl.received_weight                   AS weight_kg,
        gl.no_of_rolls                       AS packs,
        gl.bin_id, gl.uom_id,
        u.code                               AS uom_code,
        yn.yarn_name, yn.yarn_code,
        yn.yarn_type,
        yn.count_value, yn.count_type, yn.ply,
        CONCAT_WS(' ', CONCAT(yn.count_value, IF(yn.count_type IS NULL, '', CONCAT(' ', yn.count_type))),
                  IF(yn.ply IS NULL OR yn.ply <= 1, NULL, CONCAT(yn.ply, '-ply'))) AS count_str,
        grn.warehouse_id, wh.warehouse_name,
        wb.bin_code                          AS location_bin, wb.rack,
        grn.grn_no, grn.grn_date,
        po.po_no,
        sup.party_name                       AS supplier_name,
        ${TRACE_SO_NO}                       AS so_no,
        ${TRACE_IO_NO}                       AS internal_ir_no,
        ${TRACE_STYLE_ID}                    AS style_id,
        st.style_code, st.style_name,
        (gl.accepted_qty - ${returnedSql})   AS net_in_qty,
        ${returnedSql}                       AS returned_qty,
        ${matIssueSql}                       AS batch_issued_qty
      FROM trx_grn_line gl
      JOIN trx_grn grn ON grn.id = gl.grn_id
      ${TRACE_JOINS}
      LEFT JOIN mst_style st ON st.id = ${TRACE_STYLE_ID} AND st.company_id = grn.company_id
      LEFT JOIN mst_yarn yn ON yn.id = gl.yarn_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
      LEFT JOIN mst_warehouse wh ON wh.id = grn.warehouse_id
      LEFT JOIN mst_warehouse_bin wb ON wb.id = gl.bin_id
      LEFT JOIN mst_party sup ON sup.id = grn.supplier_id
      WHERE grn.company_id = ?
        AND gl.material_type = 'YARN'
        AND gl.yarn_id IS NOT NULL
    ),
    lot_issue AS (${lotIssue.sql}),
    fifo AS (
      SELECT b.*,
             COALESCE(li.issued_qty, 0) AS lot_issued_qty,
             COALESCE(SUM(GREATEST(b.net_in_qty, 0)) OVER (
               PARTITION BY b.yarn_id, b.lot_no ORDER BY b.grn_date, b.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS lot_in_before
        FROM base b
        LEFT JOIN lot_issue li ON li.yarn_id = b.yarn_id AND li.lot_no = b.lot_no
    ),
    calc AS (
      SELECT f.*,
             (LEAST(GREATEST(f.net_in_qty, 0), GREATEST(f.lot_issued_qty - f.lot_in_before, 0))
               + f.batch_issued_qty) AS issued_qty
        FROM fifo f
    ),
    s AS (
      SELECT c.*,
             GREATEST(c.net_in_qty - c.issued_qty, 0) AS stock_qty,
             CASE
               WHEN c.qc_status = 'REJECTED'                         THEN 'REJECTED'
               WHEN c.qc_status = 'PENDING'                          THEN 'PENDING'
               WHEN c.qc_status = 'HOLD' AND c.accepted_qty <= 0     THEN 'HOLD'
               WHEN c.net_in_qty - c.issued_qty <= 0.0005            THEN 'CLOSED'
               WHEN c.issued_qty > 0                                 THEN 'PARTIAL'
               ELSE 'AVAILABLE'
             END AS stock_status
        FROM calc c
    )
    SELECT s.*, s.stock_qty AS balance_qty
      FROM s
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.grn_date DESC, s.id DESC
  `, [companyId, ...lotIssue.params, ...filterParams]);

  // Dropdown options come from the whole company's yarn stock so choosing one
  // filter never makes the other choices disappear.
  const facets = await query<any>(`
    SELECT DISTINCT ${TRACE_IO_NO} AS io_no, ${TRACE_STYLE_ID} AS style_id, st.style_code, st.style_name
      FROM trx_grn_line gl
      JOIN trx_grn grn ON grn.id = gl.grn_id
      ${TRACE_JOINS}
      LEFT JOIN mst_style st ON st.id = ${TRACE_STYLE_ID} AND st.company_id = grn.company_id
     WHERE grn.company_id = ? AND gl.material_type = 'YARN' AND gl.yarn_id IS NOT NULL
  `, [companyId]);

  res.json({ data: rows, facets: buildTraceFacets(facets) });
}));

/**
 * GET /api/yarn-stock/:id/bins
 * Bins of the warehouse the yarn lot sits in — feeds the bin assignment modal
 * without requiring WAREHOUSE master rights.
 */
fabricYarnProcurementRouter.get('/yarn-stock/:id/bins', requirePermission('INVENTORY.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid yarn stock id');

  const line = await queryOne<any>(`
    SELECT gl.id, grn.warehouse_id FROM trx_grn_line gl
      JOIN trx_grn grn ON grn.id = gl.grn_id
     WHERE gl.id = ? AND grn.company_id = ? AND gl.material_type = 'YARN'
  `, [id, companyId]);
  if (!line) throw NotFound('Yarn stock entry not found');

  const bins = await query<any>(`
    SELECT wb.id, wb.bin_code, wb.rack, wb.warehouse_id, wh.warehouse_name
      FROM mst_warehouse_bin wb
      JOIN mst_warehouse wh ON wh.id = wb.warehouse_id
     WHERE wb.warehouse_id = ? AND wh.company_id = ? AND wb.is_active = 1
     ORDER BY wb.rack, wb.bin_code
  `, [line.warehouse_id, companyId]);

  res.json({ data: bins });
}));

/**
 * POST /api/yarn-stock/:id/bin
 * Assign (or clear, with bin_id = null) the bin/rack of a yarn GRN lot line.
 * The bin must belong to the GRN's own warehouse.
 */
const yarnBinSchema = z.object({
  bin_id: z.coerce.number().int().positive().nullable(),
});

fabricYarnProcurementRouter.post('/yarn-stock/:id/bin', requirePermission('INVENTORY.ADJUST'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid yarn stock id');
  const body = yarnBinSchema.parse(req.body ?? {});

  const result = await transaction(async (tx) => {
    const line = await txQueryOne<any>(tx, `
      SELECT gl.id, gl.bin_id, grn.warehouse_id, grn.grn_no, gl.lot_no
        FROM trx_grn_line gl
        JOIN trx_grn grn ON grn.id = gl.grn_id
       WHERE gl.id = ? AND grn.company_id = ? AND gl.material_type = 'YARN'
       FOR UPDATE
    `, [id, companyId]);
    if (!line) throw NotFound('Yarn stock entry not found');

    let bin: any = null;
    if (body.bin_id != null) {
      bin = await txQueryOne<any>(tx, `
        SELECT wb.id, wb.bin_code, wb.warehouse_id, wb.is_active
          FROM mst_warehouse_bin wb
          JOIN mst_warehouse wh ON wh.id = wb.warehouse_id
         WHERE wb.id = ? AND wh.company_id = ?
      `, [body.bin_id, companyId]);
      if (!bin) throw BadRequest('Bin not found');
      if (Number(bin.warehouse_id) !== Number(line.warehouse_id)) {
        throw BadRequest(`Bin ${bin.bin_code} is not in the warehouse of GRN ${line.grn_no}`);
      }
      if (!Number(bin.is_active)) throw BadRequest(`Bin ${bin.bin_code} is inactive`);
    }

    await txExecute(tx, `UPDATE trx_grn_line SET bin_id = ? WHERE id = ?`, [body.bin_id, id]);
    await audit(req, 'trx_grn_line', id, 'UPDATE', { bin_id: line.bin_id }, { bin_id: body.bin_id }, tx);
    return { id, bin_id: body.bin_id, location_bin: bin?.bin_code ?? null };
  });

  res.json({ data: { success: true, ...result } });
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
    SELECT ql.*, y.yarn_name, y.yarn_type AS master_yarn_type, comp.description AS composition
      FROM trx_quotation_line ql
      LEFT JOIN mst_yarn y ON y.id = ql.yarn_id
      LEFT JOIN mst_composition comp ON comp.id = y.composition_id
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

    // 1. Calculate totals across lines
    const lines = Array.isArray(body.lines) ? body.lines : [];
    let totTaxable = 0;
    let totCgst = 0;
    let totSgst = 0;
    let totIgst = 0;
    const isInterstate = Boolean(body.is_interstate);

    const calculatedLines = lines.map((line: any) => {
      const recKg = Number(line.received_qty) || 0;
      const accKg = Number(line.accepted_qty !== undefined ? line.accepted_qty : recKg);
      const rejKg = Number(line.rejected_qty) || 0;
      const holdKg = Number(line.hold_qty) || 0;
      const poKg = Number(line.po_qty) || recKg;
      const balanceKg = Math.max(0, poKg - accKg);
      const rate = Number(line.rate) || 0;
      const taxable = Number(line.taxable_amount !== undefined ? line.taxable_amount : (accKg * rate));
      const gstRate = Number(line.gst_rate !== undefined ? line.gst_rate : 5);

      let cgst = 0;
      let sgst = 0;
      let igst = 0;
      if (isInterstate) {
        igst = Number(((taxable * gstRate) / 100).toFixed(4));
      } else {
        cgst = Number(((taxable * (gstRate / 2)) / 100).toFixed(4));
        sgst = Number(((taxable * (gstRate / 2)) / 100).toFixed(4));
      }
      const taxAmt = cgst + sgst + igst;
      const lineTotal = taxable + taxAmt;

      totTaxable += taxable;
      totCgst += cgst;
      totSgst += sgst;
      totIgst += igst;

      return {
        ...line,
        recKg,
        accKg,
        rejKg,
        holdKg,
        balanceKg,
        rate,
        taxable,
        gstRate,
        cgst,
        sgst,
        igst,
        taxAmt,
        lineTotal,
      };
    });

    const totTax = totCgst + totSgst + totIgst;
    const netAmount = totTaxable + totTax;

    const freightCharges = Number(body.freight_charges) || 0;
    const otherCharges = Number(body.other_charges) || 0;
    const roundOff = Number(body.round_off) || 0;
    const tcsApplicable = Boolean(body.tcs_applicable);
    const tcsSection = tcsApplicable ? (body.tcs_section || '206C(1H)') : null;
    const tcsRate = tcsApplicable ? (Number(body.tcs_rate) || 0) : 0;
    const baseBeforeTcs = netAmount + freightCharges + otherCharges;
    const tcsAmount = tcsApplicable
      ? Number(((baseBeforeTcs * tcsRate) / 100).toFixed(4))
      : 0;
    const grandTotal = Number((baseBeforeTcs + tcsAmount + roundOff).toFixed(4));

    const poIds = Array.isArray(body.po_ids)
      ? body.po_ids.map(Number).filter((n: number) => n > 0)
      : (body.po_id ? [Number(body.po_id)] : []);
    const primaryPoId = poIds[0] || (body.po_id ? Number(body.po_id) : null);
    const poIdsJson = poIds.length > 0 ? JSON.stringify(poIds) : null;

    const grnRes = await txExecute(tx, `
      INSERT INTO trx_grn (
        company_id, grn_no, internal_ir_no, grn_date, po_id, po_ids, style_id,
        supplier_id, warehouse_id, supplier_dc_no, supplier_inv_no,
        vehicle_no, gate_inward_id, qc_status, is_interstate,
        taxable_amount, tax_amount, cgst_amount, sgst_amount, igst_amount, net_amount,
        freight_charges, other_charges, round_off,
        tcs_applicable, tcs_section, tcs_rate, tcs_amount, grand_total,
        remarks, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      finalGrnNo,
      body.internal_ir_no || 'IR-2026-0001',
      body.grn_date || new Date().toISOString().slice(0, 10),
      primaryPoId,
      poIdsJson,
      body.style_id ? Number(body.style_id) : null,
      Number(body.supplier_id),
      Number(body.warehouse_id),
      body.supplier_dc_no || null,
      body.supplier_inv_no || null,
      body.vehicle_no || null,
      body.gate_inward_id ? Number(body.gate_inward_id) : null,
      body.qc_status || 'ACCEPTED',
      isInterstate ? 1 : 0,
      totTaxable,
      totTax,
      totCgst,
      totSgst,
      totIgst,
      netAmount,
      freightCharges,
      otherCharges,
      roundOff,
      tcsApplicable ? 1 : 0,
      tcsSection,
      tcsRate,
      tcsAmount,
      grandTotal,
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

    for (const line of calculatedLines) {
      const linePoId = line.po_id ? Number(line.po_id) : primaryPoId;
      await txExecute(tx, `
        INSERT INTO trx_grn_line (
          grn_id, po_id, po_line_id, so_id, style_id, material_type, yarn_id,
          yarn_type, shade_code, color_name,
          received_qty, received_weight, no_of_rolls,
          accepted_qty, rejected_qty, hold_qty, balance_qty,
          rate, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, total_amount,
          lot_no, qc_status, uom_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        newGrnId,
        linePoId,
        line.po_line_id ? Number(line.po_line_id) : null,
        line.so_id ? Number(line.so_id) : (body.so_id ? Number(body.so_id) : null),
        line.style_id ? Number(line.style_id) : (body.style_id ? Number(body.style_id) : null),
        'YARN',
        Number(line.yarn_id),
        line.yarn_type || 'Grey Yarn',
        line.shade_code || null,
        line.color_name || null,
        line.recKg,
        line.recKg,
        Number(line.packs || line.no_of_rolls || 1),
        line.accKg,
        line.rejKg,
        line.holdKg,
        line.balanceKg,
        line.rate,
        line.taxable,
        line.gstRate,
        line.cgst,
        line.sgst,
        line.igst,
        line.lineTotal,
        line.lot_no || 'LOT-YARN-DEFAULT',
        line.qc_status || body.qc_status || 'ACCEPTED',
        5, // KG
      ]);

      if (line.po_line_id) {
        await txExecute(tx, `
          UPDATE trx_purchase_order_line
             SET received_qty = COALESCE(received_qty, 0) + ?
           WHERE id = ?
        `, [line.accKg, line.po_line_id]);
      }

      if (line.accKg > 0 && body.qc_status !== 'REJECTED') {
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
          line.accKg,
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
    SELECT gl.*, po.po_no, y.yarn_name, y.yarn_code, comp.description AS composition, y.yarn_type AS yarn_base_type, COALESCE(gl.yarn_type, 'Grey Yarn') AS yarn_type, u.code AS uom_code
      FROM trx_grn_line gl
      LEFT JOIN trx_purchase_order po ON po.id = gl.po_id
      LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
      LEFT JOIN mst_composition comp ON comp.id = y.composition_id
      LEFT JOIN cfg_uom u ON u.id = gl.uom_id
     WHERE gl.grn_id = ?
  `, [id]);

  res.json({ data: { ...grn, lines } });
}));

