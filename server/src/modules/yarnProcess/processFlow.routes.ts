import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import {
  assertEditable, consumeReservation, postLedger,
  yarnStockOnHand, yarnReservedQty, UOM_KG, UOM_PCS, type SrcType,
} from '../../core/processEngine.js';

/**
 * Shared process flow endpoints (doc §18, §19, §20).
 *
 * Issue, receipt and QC are identical in shape across yarn processes, knitting
 * programs and collar programs, so they are served once here and addressed by
 * (src_type, src_id) rather than duplicated per process.
 */
export const processFlowRouter = Router();

const SRC_TYPES = ['YARN_PROCESS', 'KNITTING_PROGRAM', 'COLLAR_PROGRAM'] as const;

/** Header table and label for each source document. */
const SRC_TABLE: Record<SrcType, { table: string; label: string }> = {
  YARN_PROCESS: { table: 'trx_yarn_process', label: 'process' },
  KNITTING_PROGRAM: { table: 'trx_knitting_program', label: 'knitting program' },
  COLLAR_PROGRAM: { table: 'trx_collar_program', label: 'collar program' },
};

async function loadSrc(srcType: SrcType, srcId: number, cid: number) {
  const { table, label } = SRC_TABLE[srcType];
  const row = await queryOne<any>(
    `SELECT * FROM ${table} WHERE id = ? AND company_id = ?`, [srcId, cid]);
  if (!row) throw NotFound(`Referenced ${label} not found`);
  return row;
}

/* ================================================================
   MATERIAL ISSUE (doc §18) — moves stock
================================================================ */

const issueSchema = z.object({
  src_type: z.enum(SRC_TYPES),
  src_id: s.idReq(),
  src_line_id: s.id(),
  reservation_id: s.id(),
  issue_no: s.nullableStr(60),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  yarn_id: s.idReq(),
  batch_id: s.id(),
  lot_no: s.nullableStr(80),
  yarn_po_no: s.nullableStr(80),
  warehouse_id: s.idReq(),
  issued_qty_kg: z.coerce.number().positive(),
  // Doc §22: issue may exceed available/reserved only with authorisation.
  allow_override: z.coerce.boolean().default(false),
  override_reason: s.nullableStr(255),
  remarks: s.text(),
});

processFlowRouter.get('/process-issues', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { src_type, src_id } = req.query;
  let where = 'WHERE i.company_id = ?';
  const params: any[] = [cid];
  if (src_type) { where += ' AND i.src_type = ?'; params.push(src_type); }
  if (src_id) { where += ' AND i.src_id = ?'; params.push(src_id); }
  const rows = await query(
    `SELECT i.*, y.yarn_code, y.yarn_name, w.warehouse_name
       FROM trx_process_issue i
       LEFT JOIN mst_yarn y ON y.id = i.yarn_id
       LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id
       ${where} ORDER BY i.id DESC LIMIT 500`, params);
  res.json({ success: true, data: rows });
}));

processFlowRouter.post('/process-issues', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = issueSchema.parse(req.body);

  const src = await loadSrc(body.src_type, body.src_id, cid);
  assertEditable(src.status, SRC_TABLE[body.src_type].label);

  // Doc §18/§22: an issue cannot exceed what is physically available unless it
  // is explicitly authorised, and the override is recorded on the document.
  const onHand = await yarnStockOnHand(cid, body.yarn_id, body.warehouse_id);
  const reservedElsewhere = await yarnReservedQty(cid, body.yarn_id);
  const available = onHand - Math.max(0, reservedElsewhere);
  const exceeds = body.issued_qty_kg > available;

  if (exceeds && !body.allow_override) {
    throw BadRequest(
      `Issue of ${body.issued_qty_kg} KG exceeds available stock ` +
      `(${onHand} KG on hand, ${reservedElsewhere} KG reserved, ${available} KG free). ` +
      `Re-submit with allow_override and a reason to proceed.`,
    );
  }
  if (exceeds && !body.override_reason) {
    throw BadRequest('An override reason is required when issuing beyond available stock');
  }

  const result = await transaction(async (tx) => {
    const issueNo = body.issue_no || await nextDocNumber(tx, cid, 'PROC_ISSUE');
    const r = await txExecute(tx,
      `INSERT INTO trx_process_issue
         (company_id, issue_no, issue_date, src_type, src_id, src_line_id, reservation_id,
          yarn_id, batch_id, lot_no, yarn_po_no, warehouse_id, issued_qty_kg,
          is_override, override_reason, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, issueNo, body.issue_date, body.src_type, body.src_id, body.src_line_id ?? null,
       body.reservation_id ?? null, body.yarn_id, body.batch_id ?? null, body.lot_no ?? null,
       body.yarn_po_no ?? null, body.warehouse_id, body.issued_qty_kg,
       exceeds ? 1 : 0, exceeds ? body.override_reason ?? null : null,
       body.remarks ?? null, uid]);
    const issueId = r.insertId;

    // Issue is the step that actually moves stock (doc §5).
    await postLedger(tx, {
      companyId: cid, warehouseId: body.warehouse_id, materialType: 'YARN',
      yarnId: body.yarn_id, batchId: body.batch_id ?? null,
      txnType: 'ISSUE', refType: 'PROCESS_ISSUE', refId: issueId,
      qtyOut: body.issued_qty_kg, uomId: UOM_KG, createdBy: uid,
    });

    if (body.reservation_id) await consumeReservation(tx, body.reservation_id, body.issued_qty_kg);

    // Knitting program yarn lines keep their own issued running total.
    if (body.src_type === 'KNITTING_PROGRAM' && body.src_line_id) {
      await txExecute(tx,
        `UPDATE trx_knitting_program_yarns SET issued_qty_kg = issued_qty_kg + ?
          WHERE id = ? AND program_id = ?`,
        [body.issued_qty_kg, body.src_line_id, body.src_id]);
    }

    const { table } = SRC_TABLE[body.src_type];
    await txExecute(tx,
      `UPDATE ${table} SET status = 'MATERIAL_ISSUED'
        WHERE id = ? AND status IN ('RELEASED','RESERVED','STOCK_CHECK')`, [body.src_id]);

    return { id: issueId, issue_no: issueNo, is_override: exceeds };
  });

  await audit(req, 'trx_process_issue', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/* ================================================================
   PROCESS RECEIPT (doc §19) — output, loss and destination lot
================================================================ */

const coneSchema = z.object({
  cone_no: s.strReq(60),
  source_lot_no: s.nullableStr(80),
  weight_kg: z.coerce.number().min(0).default(0),
  status: z.enum(['GOOD', 'REJECTED']).default('GOOD'),
});

const receiptSchema = z.object({
  src_type: z.enum(SRC_TYPES),
  src_id: s.idReq(),
  receipt_no: s.nullableStr(60),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  input_qty: z.coerce.number().min(0).default(0),
  output_qty: z.coerce.number().min(0).default(0),
  output_uom_id: z.coerce.number().int().optional(),
  rejected_qty: z.coerce.number().min(0).default(0),
  output_lot_no: s.nullableStr(80),
  warehouse_id: s.idReq(),
  qc_status: z.enum(['PENDING', 'PASSED', 'HOLD', 'REJECTED']).default('PENDING'),
  post_stock: z.coerce.boolean().default(false),
  remarks: s.text(),
  cones: z.array(coneSchema).default([]),
});

processFlowRouter.post('/process-receipts', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = receiptSchema.parse(req.body);

  const src = await loadSrc(body.src_type, body.src_id, cid);
  assertEditable(src.status, SRC_TABLE[body.src_type].label);

  // Loss is derived, never typed in, so input = output + loss + rejected holds.
  const loss = Math.max(0,
    Math.round((body.input_qty - body.output_qty - body.rejected_qty) * 1000) / 1000);

  const result = await transaction(async (tx) => {
    const receiptNo = body.receipt_no || await nextDocNumber(tx, cid, 'PROC_RECEIPT');
    const lotNo = body.output_lot_no
      || `${String(src.process_no ?? src.program_no ?? body.src_id)}-${receiptNo}`;

    const r = await txExecute(tx,
      `INSERT INTO trx_process_receipt
         (company_id, receipt_no, receipt_date, src_type, src_id, input_qty, output_qty,
          output_uom_id, loss_qty, rejected_qty, output_lot_no, warehouse_id,
          qc_status, is_stock_posted, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, body.receipt_date, body.src_type, body.src_id,
       body.input_qty, body.output_qty, body.output_uom_id ?? UOM_KG, loss,
       body.rejected_qty, lotNo, body.warehouse_id, body.qc_status,
       body.post_stock ? 1 : 0, body.remarks ?? null, uid]);
    const receiptId = r.insertId;

    // Winding turns one yarn lot into many cones, each individually traceable.
    for (const c of body.cones) {
      await txExecute(tx,
        `INSERT INTO trx_winding_cone
           (receipt_id, process_id, cone_no, source_lot_no, weight_kg, status)
         VALUES (?,?,?,?,?,?)`,
        [receiptId, body.src_id, c.cone_no, c.source_lot_no ?? null, c.weight_kg, c.status]);
    }

    // Stock is posted only once QC has passed (doc §21 puts QC before stock).
    if (body.post_stock) {
      if (body.qc_status !== 'PASSED') {
        throw BadRequest('Stock can only be posted for a receipt whose QC status is PASSED');
      }
      await postLedger(tx, {
        companyId: cid, warehouseId: body.warehouse_id,
        materialType: body.src_type === 'COLLAR_PROGRAM' ? 'WIP' : 'YARN',
        yarnId: src.yarn_id ?? null,
        txnType: 'PRODUCTION_IN', refType: 'PROCESS_RECEIPT', refId: receiptId,
        qtyIn: body.output_qty, uomId: body.output_uom_id ?? UOM_KG, createdBy: uid,
      });
    }

    const { table } = SRC_TABLE[body.src_type];
    await txExecute(tx,
      `UPDATE ${table} SET status = ?
        WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED')`,
      [body.post_stock ? 'STOCK_POSTED' : 'OUTPUT_RECEIPT', body.src_id]);

    return { id: receiptId, receipt_no: receiptNo, output_lot_no: lotNo, loss_qty: loss };
  });

  await audit(req, 'trx_process_receipt', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

processFlowRouter.get('/process-receipts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { src_type, src_id } = req.query;
  let where = 'WHERE r.company_id = ?';
  const params: any[] = [cid];
  if (src_type) { where += ' AND r.src_type = ?'; params.push(src_type); }
  if (src_id) { where += ' AND r.src_id = ?'; params.push(src_id); }
  const rows = await query(
    `SELECT r.*, u.code AS output_uom_code, w.warehouse_name
       FROM trx_process_receipt r
       LEFT JOIN cfg_uom u ON u.id = r.output_uom_id
       LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id
       ${where} ORDER BY r.id DESC LIMIT 500`, params);
  res.json({ success: true, data: rows });
}));

/** Post stock for a receipt that has since passed QC. */
processFlowRouter.post('/process-receipts/:id/post-stock', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const rc = await queryOne<any>(
    `SELECT * FROM trx_process_receipt WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!rc) throw NotFound('Receipt not found');
  if (rc.is_stock_posted) throw BadRequest('Stock has already been posted for this receipt');
  if (rc.qc_status !== 'PASSED') throw BadRequest('QC must be PASSED before stock can be posted');

  const src = await loadSrc(rc.src_type as SrcType, rc.src_id, cid);

  await transaction(async (tx) => {
    await postLedger(tx, {
      companyId: cid, warehouseId: rc.warehouse_id,
      materialType: rc.src_type === 'COLLAR_PROGRAM' ? 'WIP' : 'YARN',
      yarnId: src.yarn_id ?? null,
      txnType: 'PRODUCTION_IN', refType: 'PROCESS_RECEIPT', refId: id,
      qtyIn: Number(rc.output_qty), uomId: rc.output_uom_id ?? UOM_KG, createdBy: req.user!.id,
    });
    await txExecute(tx, `UPDATE trx_process_receipt SET is_stock_posted = 1 WHERE id = ?`, [id]);
    const { table } = SRC_TABLE[rc.src_type as SrcType];
    await txExecute(tx,
      `UPDATE ${table} SET status = 'STOCK_POSTED'
        WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED')`, [rc.src_id]);
  });

  await audit(req, 'trx_process_receipt', id, 'UPDATE', rc, { is_stock_posted: 1 });
  res.json({ success: true, message: 'Stock posted' });
}));

/* ================================================================
   PROCESS QC (doc §20)
================================================================ */

/** Default QC parameters per process, from the doc §20 matrix. */
const QC_MATRIX: Record<string, string[]> = {
  YARN_DYEING: ['Shade', 'Colour difference', 'Fastness', 'Moisture', 'Weight', 'Appearance'],
  WINDING: ['Cone weight', 'Tension', 'Package build', 'Yarn breakage', 'Appearance'],
  TWISTING: ['Count', 'Ply', 'TPI', 'Twist direction', 'Strength', 'Appearance'],
  KNITTING: ['GSM', 'Dia', 'Stitch', 'Weight', 'Appearance', 'Stripe repeat', 'Defects'],
  COLLAR_KNITTING: ['Size', 'Width', 'Height', 'Colour', 'Stitch', 'Rib quality', 'Weight per piece'],
};

processFlowRouter.get('/process-qc/parameters/:processType', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const params = QC_MATRIX[String(req.params.processType).toUpperCase()] ?? [];
  res.json({ success: true, data: params });
}));

const qcSchema = z.object({
  src_type: z.enum(SRC_TYPES),
  src_id: s.idReq(),
  receipt_id: s.id(),
  qc_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  process_type: s.nullableStr(40),
  overall_status: z.enum(['PENDING', 'PASSED', 'HOLD', 'REJECTED']).default('PENDING'),
  remarks: s.text(),
  lines: z.array(z.object({
    parameter: s.strReq(80),
    expected_value: s.nullableStr(80),
    actual_value: s.nullableStr(80),
    result: z.enum(['PASS', 'FAIL', 'NA']).default('NA'),
    remarks: s.nullableStr(255),
  })).default([]),
});

processFlowRouter.post('/process-qc', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = qcSchema.parse(req.body);
  await loadSrc(body.src_type, body.src_id, cid);

  const result = await transaction(async (tx) => {
    const r = await txExecute(tx,
      `INSERT INTO trx_process_qc
         (company_id, src_type, src_id, receipt_id, qc_date, process_type,
          overall_status, checked_by, remarks)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [cid, body.src_type, body.src_id, body.receipt_id ?? null, body.qc_date,
       body.process_type ?? null, body.overall_status, req.user!.id, body.remarks ?? null]);
    const qcId = r.insertId;

    for (const l of body.lines) {
      await txExecute(tx,
        `INSERT INTO trx_process_qc_line
           (qc_id, parameter, expected_value, actual_value, result, remarks)
         VALUES (?,?,?,?,?,?)`,
        [qcId, l.parameter, l.expected_value ?? null, l.actual_value ?? null,
         l.result, l.remarks ?? null]);
    }

    // The QC verdict propagates to the receipt it was performed against.
    if (body.receipt_id) {
      await txExecute(tx,
        `UPDATE trx_process_receipt SET qc_status = ? WHERE id = ? AND company_id = ?`,
        [body.overall_status, body.receipt_id, cid]);
    }

    const { table } = SRC_TABLE[body.src_type];
    await txExecute(tx,
      `UPDATE ${table} SET status = 'QC'
        WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED','STOCK_POSTED')`, [body.src_id]);

    return { id: qcId };
  });

  await audit(req, 'trx_process_qc', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

processFlowRouter.get('/process-qc', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { src_type, src_id } = req.query;
  let where = 'WHERE q.company_id = ?';
  const params: any[] = [cid];
  if (src_type) { where += ' AND q.src_type = ?'; params.push(src_type); }
  if (src_id) { where += ' AND q.src_id = ?'; params.push(src_id); }
  const rows = await query<any>(
    `SELECT q.*, u.full_name AS checked_by_name
       FROM trx_process_qc q
       LEFT JOIN mst_user u ON u.id = q.checked_by
       ${where} ORDER BY q.id DESC LIMIT 500`, params);
  for (const r of rows) {
    r.lines = await query(`SELECT * FROM trx_process_qc_line WHERE qc_id = ? ORDER BY id`, [r.id]);
  }
  res.json({ success: true, data: rows });
}));

/* ================================================================
   COMPLETE (doc §21 / §22 — QC and stock enforced before completion)
================================================================ */

processFlowRouter.post('/process-complete', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { src_type, src_id } = z.object({
    src_type: z.enum(SRC_TYPES), src_id: s.idReq(),
  }).parse(req.body);

  const src = await loadSrc(src_type, src_id, cid);
  assertEditable(src.status, SRC_TABLE[src_type].label);

  const receipts = await query<any>(
    `SELECT qc_status, is_stock_posted FROM trx_process_receipt
      WHERE src_type = ? AND src_id = ? AND company_id = ?`, [src_type, src_id, cid]);
  if (!receipts.length) throw BadRequest('Cannot complete: no output receipt has been recorded');

  const pendingQc = receipts.filter((r) => r.qc_status !== 'PASSED');
  if (pendingQc.length) {
    throw BadRequest(`Cannot complete: ${pendingQc.length} receipt(s) have not passed QC`);
  }
  const unposted = receipts.filter((r) => !r.is_stock_posted);
  if (unposted.length) {
    throw BadRequest(`Cannot complete: ${unposted.length} receipt(s) have not been posted to stock`);
  }

  const { table } = SRC_TABLE[src_type];
  await query(`UPDATE ${table} SET status = 'COMPLETED' WHERE id = ? AND company_id = ?`, [src_id, cid]);
  await audit(req, table, src_id, 'UPDATE', src, { status: 'COMPLETED' });
  res.json({ success: true, message: 'Process completed' });
}));

export default processFlowRouter;
