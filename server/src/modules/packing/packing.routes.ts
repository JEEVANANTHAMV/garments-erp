import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';

export const cartonRouter = Router();

const contentSchema = z.object({
  sku_id: s.idReq(),
  qty: z.coerce.number().int().positive('Carton content quantity must be greater than zero'),
});

const cartonSchema = z.object({
  carton_no: s.strReq(40),
  carton_type: s.nullableStr(40),
  length_cm: s.dec(), width_cm: s.dec(), height_cm: s.dec(),
  net_weight_kg: s.dec(), gross_weight_kg: s.dec(),
  barcode: s.nullableStr(80),
  contents: z.array(contentSchema).default([]),
});

/** Roll carton counts / quantities / weights back onto the packing header. */
async function recalcPacking(tx: any, packingId: number) {
  const agg = await txQueryOne<{ cartons: number; net: number; gross: number; cbm: number }>(
    tx,
    `SELECT COUNT(*) AS cartons,
            COALESCE(SUM(net_weight_kg),0) AS net,
            COALESCE(SUM(gross_weight_kg),0) AS gross,
            COALESCE(SUM(cbm),0) AS cbm
       FROM trx_carton WHERE packing_id = ?`, [packingId]);
  const qty = await txQueryOne<{ q: number }>(
    tx,
    `SELECT COALESCE(SUM(cc.qty),0) AS q
       FROM trx_carton_content cc
       JOIN trx_carton c ON c.id = cc.carton_id
      WHERE c.packing_id = ?`, [packingId]);
  await txExecute(tx,
    `UPDATE trx_packing SET total_cartons = ?, total_qty = ?, net_weight_kg = ?, gross_weight_kg = ?
      WHERE id = ?`,
    [agg?.cartons ?? 0, qty?.q ?? 0, agg?.net ?? 0, agg?.gross ?? 0, packingId]);
}

/** CBM from carton dimensions in centimetres. */
const cbmOf = (l?: number | null, w?: number | null, h?: number | null) =>
  l && w && h ? Number(((l * w * h) / 1_000_000).toFixed(5)) : null;

cartonRouter.get('/packings/:packingId/cartons', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const packingId = Number(req.params.packingId);
  const cartons = await query(
    `SELECT * FROM trx_carton WHERE packing_id = ? ORDER BY carton_no`, [packingId]);
  for (const c of cartons as any[]) {
    c.contents = await query(
      `SELECT cc.*, k.sku_code, col.color_name, sz.size_code, sz.size_label
         FROM trx_carton_content cc
         JOIN mst_style_sku k ON k.id = cc.sku_id
         JOIN mst_color col ON col.id = k.color_id
         JOIN mst_size sz ON sz.id = k.size_id
        WHERE cc.carton_id = ? ORDER BY sz.sort_order`, [c.id]);
  }
  res.json({ data: cartons });
}));

cartonRouter.post('/packings/:packingId/cartons', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const packingId = Number(req.params.packingId);
  const body = cartonSchema.parse(req.body);

  const packing = await queryOne(`SELECT * FROM trx_packing WHERE id = ? AND company_id = ?`,
    [packingId, req.user!.companyId]);
  if (!packing) throw NotFound('Packing record not found');

  const created = await transaction(async (tx) => {
    const r = await txExecute(tx,
      `INSERT INTO trx_carton (packing_id, carton_no, carton_type, length_cm, width_cm, height_cm,
                               net_weight_kg, gross_weight_kg, cbm, barcode)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [packingId, body.carton_no, body.carton_type ?? null, body.length_cm ?? null,
       body.width_cm ?? null, body.height_cm ?? null, body.net_weight_kg ?? null,
       body.gross_weight_kg ?? null, cbmOf(body.length_cm, body.width_cm, body.height_cm),
       body.barcode ?? null]);
    const cartonId = r.insertId;

    for (const c of body.contents) {
      await txExecute(tx, `INSERT INTO trx_carton_content (carton_id, sku_id, qty) VALUES (?,?,?)`,
        [cartonId, c.sku_id, c.qty]);
    }
    await recalcPacking(tx, packingId);
    return txQueryOne(tx, `SELECT * FROM trx_carton WHERE id = ?`, [cartonId]);
  });

  await audit(req, 'trx_carton', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

/**
 * Bulk-generate identical cartons from a ratio pack — the common case where a
 * buyer orders N cartons each containing the same size assortment.
 */
const bulkSchema = z.object({
  carton_count: z.coerce.number().int().min(1).max(2000),
  start_number: z.coerce.number().int().min(1).default(1),
  prefix: z.string().trim().max(20).default('CTN-'),
  carton_type: s.nullableStr(40),
  length_cm: s.dec(), width_cm: s.dec(), height_cm: s.dec(),
  net_weight_kg: s.dec(), gross_weight_kg: s.dec(),
  contents: z.array(contentSchema).min(1, 'Specify the SKU assortment for each carton'),
});

cartonRouter.post('/packings/:packingId/cartons/bulk', requirePermission('PACKING.CREATE'), ah(async (req, res) => {
  const packingId = Number(req.params.packingId);
  const body = bulkSchema.parse(req.body);

  const packing = await queryOne(`SELECT * FROM trx_packing WHERE id = ? AND company_id = ?`,
    [packingId, req.user!.companyId]);
  if (!packing) throw NotFound('Packing record not found');

  const count = await transaction(async (tx) => {
    const cbm = cbmOf(body.length_cm, body.width_cm, body.height_cm);
    for (let i = 0; i < body.carton_count; i++) {
      const cartonNo = `${body.prefix}${String(body.start_number + i).padStart(4, '0')}`;
      const r = await txExecute(tx,
        `INSERT INTO trx_carton (packing_id, carton_no, carton_type, length_cm, width_cm, height_cm,
                                 net_weight_kg, gross_weight_kg, cbm)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [packingId, cartonNo, body.carton_type ?? null, body.length_cm ?? null,
         body.width_cm ?? null, body.height_cm ?? null, body.net_weight_kg ?? null,
         body.gross_weight_kg ?? null, cbm]);
      for (const c of body.contents) {
        await txExecute(tx, `INSERT INTO trx_carton_content (carton_id, sku_id, qty) VALUES (?,?,?)`,
          [r.insertId, c.sku_id, c.qty]);
      }
    }
    await recalcPacking(tx, packingId);
    return body.carton_count;
  });

  res.status(201).json({ data: { created: count } });
}));

cartonRouter.delete('/cartons/:id', requirePermission('PACKING.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const carton = await queryOne<{ id: number; packing_id: number }>(
    `SELECT c.id, c.packing_id FROM trx_carton c
       JOIN trx_packing p ON p.id = c.packing_id
      WHERE c.id = ? AND p.company_id = ?`, [id, req.user!.companyId]);
  if (!carton) throw NotFound('Carton not found');

  await transaction(async (tx) => {
    await txExecute(tx, `DELETE FROM trx_carton_content WHERE carton_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM trx_carton WHERE id = ?`, [id]);
    await recalcPacking(tx, carton.packing_id);
  });
  await audit(req, 'trx_carton', id, 'DELETE', carton, undefined);
  res.json({ data: { id, deleted: true } });
}));

/** Packing summary by SKU — feeds the packing list document. */
cartonRouter.get('/packings/:packingId/summary', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const packingId = Number(req.params.packingId);
  const rows = await query(
    `SELECT k.id AS sku_id, k.sku_code, col.color_name, sz.size_code, sz.sort_order,
            SUM(cc.qty) AS total_qty, COUNT(DISTINCT c.id) AS carton_count
       FROM trx_carton_content cc
       JOIN trx_carton c ON c.id = cc.carton_id
       JOIN mst_style_sku k ON k.id = cc.sku_id
       JOIN mst_color col ON col.id = k.color_id
       JOIN mst_size sz ON sz.id = k.size_id
      WHERE c.packing_id = ?
      GROUP BY k.id, k.sku_code, col.color_name, sz.size_code, sz.sort_order
      ORDER BY col.color_name, sz.sort_order`, [packingId]);
  res.json({ data: rows });
}));
