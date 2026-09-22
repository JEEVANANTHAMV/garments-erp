import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { assertEditable, postLedger, UOM_KG } from '../../core/processEngine.js';

/**
 * Knitting production entry (doc §14) and fabric roll receipt (doc §15).
 */
export const knittingProductionRouter = Router();

const productionSchema = z.object({
  program_id: s.idReq(),
  entry_no: s.nullableStr(60),
  production_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shift: s.nullableStr(40),
  production_qty_kg: z.coerce.number().min(0).default(0),
  wastage_kg: z.coerce.number().min(0).default(0),
  rejection_kg: z.coerce.number().min(0).default(0),
  remarks: s.text(),
  // Actual yarn used, yarn-wise (doc §14).
  yarns: z.array(z.object({
    program_yarn_id: s.id(),
    yarn_id: s.id(),
    used_qty_kg: z.coerce.number().min(0).default(0),
  })).default([]),
});

knittingProductionRouter.post('/knitting-productions', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = productionSchema.parse(req.body);

  const prog = await queryOne<any>(
    `SELECT * FROM trx_knitting_program WHERE id = ? AND company_id = ?`, [body.program_id, cid]);
  if (!prog) throw NotFound('Knitting program not found');
  assertEditable(prog.status, 'knitting program');

  const result = await transaction(async (tx) => {
    const entryNo = body.entry_no || await nextDocNumber(tx, cid, 'KNIT_PROD');
    const r = await txExecute(tx,
      `INSERT INTO trx_knitting_production
         (company_id, program_id, entry_no, production_date, shift,
          production_qty_kg, wastage_kg, rejection_kg, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [cid, body.program_id, entryNo, body.production_date, body.shift ?? null,
       body.production_qty_kg, body.wastage_kg, body.rejection_kg,
       body.remarks ?? null, req.user!.id]);
    const prodId = r.insertId;

    for (const y of body.yarns) {
      await txExecute(tx,
        `INSERT INTO trx_knitting_production_yarn
           (production_id, program_yarn_id, yarn_id, used_qty_kg)
         VALUES (?,?,?,?)`,
        [prodId, y.program_yarn_id ?? null, y.yarn_id ?? null, y.used_qty_kg]);
    }

    await txExecute(tx,
      `UPDATE trx_knitting_program SET status = 'IN_PROGRESS'
        WHERE id = ? AND status IN ('RELEASED','MATERIAL_ISSUED','RESERVED')`, [body.program_id]);

    return { id: prodId, entry_no: entryNo };
  });

  await audit(req, 'trx_knitting_production', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

knittingProductionRouter.get('/knitting-productions', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { program_id } = req.query;
  let where = 'WHERE p.company_id = ?';
  const params: any[] = [cid];
  if (program_id) { where += ' AND p.program_id = ?'; params.push(program_id); }
  const rows = await query<any>(
    `SELECT p.*, kp.program_no FROM trx_knitting_production p
       LEFT JOIN trx_knitting_program kp ON kp.id = p.program_id
       ${where} ORDER BY p.id DESC LIMIT 500`, params);
  for (const r of rows) {
    r.yarns = await query(
      `SELECT py.*, y.yarn_code, y.yarn_name
         FROM trx_knitting_production_yarn py
         LEFT JOIN mst_yarn y ON y.id = py.yarn_id
        WHERE py.production_id = ?`, [r.id]);
  }
  res.json({ success: true, data: rows });
}));

/* ================================================================
   Fabric roll receipt (doc §15)
================================================================ */

const rollSchema = z.object({
  program_id: s.id(),
  production_id: s.id(),
  receipt_no: s.nullableStr(60),
  roll_no: s.nullableStr(60),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gross_weight_kg: z.coerce.number().min(0).default(0),
  tare_kg: z.coerce.number().min(0).default(0),
  meters: z.coerce.number().min(0).nullable().optional(),
  actual_gsm: s.nullableStr(40),
  actual_dia: s.nullableStr(40),
  qc_status: z.enum(['PENDING', 'PASSED', 'HOLD', 'REJECTED']).default('PENDING'),
  warehouse_id: s.idReq(),
  post_stock: z.coerce.boolean().default(false),
});

knittingProductionRouter.post('/knitting-rolls', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = rollSchema.parse(req.body);

  if (body.tare_kg > body.gross_weight_kg) {
    throw BadRequest('Tare weight cannot exceed gross weight');
  }
  if (body.post_stock && body.qc_status !== 'PASSED') {
    throw BadRequest('A roll can only be posted to stock once its QC status is PASSED');
  }

  const prog = body.program_id
    ? await queryOne<any>(`SELECT * FROM trx_knitting_program WHERE id = ? AND company_id = ?`,
        [body.program_id, cid])
    : null;
  if (body.program_id && !prog) throw NotFound('Knitting program not found');

  const result = await transaction(async (tx) => {
    const rollNo = body.roll_no || await nextDocNumber(tx, cid, 'FABRIC_ROLL');
    const net = Math.round((body.gross_weight_kg - body.tare_kg) * 1000) / 1000;

    const r = await txExecute(tx,
      `INSERT INTO trx_knitting_roll
         (company_id, program_id, production_id, receipt_no, roll_no, receipt_date,
          gross_weight_kg, tare_kg, meters, actual_gsm, actual_dia, qc_status,
          warehouse_id, is_stock_posted, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, body.program_id ?? null, body.production_id ?? null, body.receipt_no ?? null,
       rollNo, body.receipt_date, body.gross_weight_kg, body.tare_kg,
       body.meters ?? null, body.actual_gsm ?? null, body.actual_dia ?? null,
       body.qc_status, body.warehouse_id, body.post_stock ? 1 : 0, req.user!.id]);
    const rollId = r.insertId;

    if (body.post_stock) {
      await postLedger(tx, {
        companyId: cid, warehouseId: body.warehouse_id, materialType: 'FABRIC',
        fabricId: prog?.fabric_id ?? null,
        txnType: 'PRODUCTION_IN', refType: 'FABRIC_ROLL', refId: rollId,
        qtyIn: net, uomId: UOM_KG, createdBy: req.user!.id,
      });
    }

    if (body.program_id) {
      await txExecute(tx,
        `UPDATE trx_knitting_program SET status = ?
          WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED')`,
        [body.post_stock ? 'STOCK_POSTED' : 'OUTPUT_RECEIPT', body.program_id]);
    }

    return { id: rollId, roll_no: rollNo, net_weight_kg: net };
  });

  await audit(req, 'trx_knitting_roll', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

knittingProductionRouter.get('/knitting-rolls', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { program_id, qc_status } = req.query;
  let where = 'WHERE r.company_id = ?';
  const params: any[] = [cid];
  if (program_id) { where += ' AND r.program_id = ?'; params.push(program_id); }
  if (qc_status) { where += ' AND r.qc_status = ?'; params.push(qc_status); }
  const rows = await query(
    `SELECT r.*, kp.program_no, w.warehouse_name
       FROM trx_knitting_roll r
       LEFT JOIN trx_knitting_program kp ON kp.id = r.program_id
       LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id
       ${where} ORDER BY r.id DESC LIMIT 500`, params);
  res.json({ success: true, data: rows });
}));

export default knittingProductionRouter;
