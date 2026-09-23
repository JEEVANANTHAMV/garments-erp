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

/** Packing must belong to the caller's company. */
async function companyPacking(packingId: number, cid: number) {
  if (!Number.isInteger(packingId) || packingId <= 0) throw BadRequest('Invalid packing id');
  const p = await queryOne<any>(`SELECT * FROM trx_packing WHERE id = ? AND company_id = ?`, [packingId, cid]);
  if (!p) throw NotFound('Packing record not found');
  return p;
}

/**
 * Cartons of a packing that is already on a CONFIRMED / CLOSED packing list are
 * frozen: the list was issued to the buyer with exactly those cartons.
 */
async function assertPackingOpen(packingId: number, cid: number) {
  const pl = await queryOne<{ pl_no: string; status: string }>(
    `SELECT pl_no, status FROM trx_packing_list
      WHERE company_id = ? AND packing_id = ? AND status IN ('CONFIRMED','CLOSED') LIMIT 1`, [cid, packingId]);
  if (pl) throw BadRequest(`Packing is on ${pl.status.toLowerCase()} packing list ${pl.pl_no}; cartons can no longer be changed`);
}

cartonRouter.get('/packings/:packingId/cartons', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const packingId = Number(req.params.packingId);
  await companyPacking(packingId, req.user!.companyId);
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

  await companyPacking(packingId, req.user!.companyId);
  await assertPackingOpen(packingId, req.user!.companyId);

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

  await companyPacking(packingId, req.user!.companyId);
  await assertPackingOpen(packingId, req.user!.companyId);

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

/**
 * DELETE /cartons/:id — only a DRAFT carton may be removed: never one whose
 * packing is on a confirmed/closed packing list, one that is allocated to a
 * shipment or shipment plan, one referenced by a confirmed packing-list row,
 * or one that still holds scanned bundles. The full carton (with contents)
 * is written to the audit trail.
 */
cartonRouter.delete('/cartons/:id', requirePermission('PACKING.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid carton id');

  const snapshot = await transaction(async (tx) => {
    const carton = await txQueryOne<any>(tx,
      `SELECT c.* FROM trx_carton c
         JOIN trx_packing p ON p.id = c.packing_id
        WHERE c.id = ? AND p.company_id = ? FOR UPDATE`, [id, cid]);
    if (!carton) throw NotFound('Carton not found');

    const pl = await txQueryOne<any>(tx,
      `SELECT pl_no, status FROM trx_packing_list
        WHERE company_id = ? AND status IN ('CONFIRMED','CLOSED')
          AND (packing_id = ? OR id IN (SELECT r.packing_list_id FROM trx_packing_list_row r
                                         WHERE r.company_id = ? AND JSON_CONTAINS(r.source_carton_ids, CAST(? AS JSON))))
        LIMIT 1`, [cid, carton.packing_id, cid, String(id)]);
    if (pl) throw BadRequest(`Carton ${carton.carton_no} is on ${pl.status.toLowerCase()} packing list ${pl.pl_no} and cannot be deleted`);
    const ship = await txQueryOne<any>(tx,
      `SELECT sh.shipment_no, sp.status FROM trx_shipment_package sp JOIN trx_shipment sh ON sh.id = sp.shipment_id
        WHERE sp.carton_id = ? AND sp.status <> 'CANCELLED' LIMIT 1`, [id]);
    if (ship) throw BadRequest(`Carton ${carton.carton_no} is ${ship.status.toLowerCase()} on shipment ${ship.shipment_no} and cannot be deleted`);
    const plan = await txQueryOne<any>(tx,
      `SELECT sp.plan_no FROM trx_shipment_plan_package spp JOIN trx_shipment_plan sp ON sp.id = spp.plan_id
        WHERE spp.carton_id = ? AND sp.status IN ('DRAFT','CONFIRMED') LIMIT 1`, [id]);
    if (plan) throw BadRequest(`Carton ${carton.carton_no} is planned on shipment plan ${plan.plan_no}; remove it from the plan first`);
    const bundles = await txQueryOne<any>(tx, `SELECT COUNT(*) AS n FROM trx_carton_bundle WHERE carton_id = ?`, [id]);
    if (Number(bundles?.n || 0) > 0) throw BadRequest(`Carton ${carton.carton_no} still holds ${bundles.n} bundle(s); unpack them first`);

    const contents = await txQueryOne<any>(tx,
      `SELECT JSON_ARRAYAGG(JSON_OBJECT('sku_id', sku_id, 'qty', qty)) AS j FROM trx_carton_content WHERE carton_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM trx_carton_content WHERE carton_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM trx_carton WHERE id = ?`, [id]);
    await recalcPacking(tx, carton.packing_id);
    const snap = { ...carton, contents: contents?.j ?? [] };
    await audit(req, 'trx_carton', id, 'DELETE', snap, undefined, tx);
    return snap;
  });
  res.json({ data: { id, deleted: true, carton_no: snapshot.carton_no } });
}));

/** Packing summary by SKU — feeds the packing list document. */
cartonRouter.get('/packings/:packingId/summary', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const packingId = Number(req.params.packingId);
  await companyPacking(packingId, req.user!.companyId);
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
