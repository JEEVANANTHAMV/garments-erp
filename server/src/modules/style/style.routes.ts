import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound, Conflict } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';

export const styleRouter = Router();

const styleSchema = z.object({
  style_code: s.strReq(50),
  style_name: s.strReq(150),
  product_id: s.idReq(),
  buyer_id: s.id(),
  buyer_style_ref: s.nullableStr(80),
  season: s.nullableStr(40),
  size_group_id: s.id(),
  fabric_id: s.id(),
  description: s.text(),
  status_id: s.id(),
  is_active: s.bool(),
  colorIds: z.array(z.coerce.number().int().positive()).optional(),
});

const SKU_SELECT = `
  SELECT k.*, c.color_name, c.color_code, c.hex_value,
         sz.size_code, sz.size_label, sz.sort_order AS size_sort
    FROM mst_style_sku k
    JOIN mst_color c ON c.id = k.color_id
    JOIN mst_size sz ON sz.id = k.size_id
   WHERE k.style_id = ?
   ORDER BY c.color_name, sz.sort_order, sz.id`;

// ---------------------------------------------------------------- LIST
styleRouter.get('/', requirePermission('STYLE.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    q: z.string().trim().optional(),
    buyer_id: z.coerce.number().int().optional(),
    product_id: z.coerce.number().int().optional(),
    season: z.string().trim().optional(),
    status_id: z.coerce.number().int().optional(),
    includeInactive: z.coerce.boolean().default(false),
  }).parse(req.query);

  const where = ['t.company_id = ?', 't.is_deleted = 0'];
  const params: unknown[] = [req.user!.companyId];
  if (!q.includeInactive) where.push('t.is_active = 1');
  if (q.q) {
    where.push('(t.style_code LIKE ? OR t.style_name LIKE ? OR t.buyer_style_ref LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  for (const k of ['buyer_id', 'product_id', 'status_id', 'season'] as const) {
    if ((q as any)[k] !== undefined) { where.push(`t.${k} = ?`); params.push((q as any)[k]); }
  }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(
      `SELECT t.*, p.product_name, p.product_type, b.party_name AS buyer_name,
              fb.fabric_name, sg.group_name AS size_group_name, cs.label AS status_label,
              (SELECT COUNT(*) FROM mst_style_sku k WHERE k.style_id = t.id) AS sku_count
         FROM mst_style t
         LEFT JOIN mst_product p    ON p.id  = t.product_id
         LEFT JOIN mst_party b      ON b.id  = t.buyer_id
         LEFT JOIN mst_fabric fb    ON fb.id = t.fabric_id
         LEFT JOIN mst_size_group sg ON sg.id = t.size_group_id
         LEFT JOIN cfg_status cs    ON cs.id = t.status_id
        WHERE ${clause}
        ORDER BY t.style_code
        LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM mst_style t WHERE ${clause}`, params),
  ]);

  res.json({
    data: rows,
    pagination: { page: q.page, pageSize: q.pageSize, total: total?.total ?? 0,
      totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) },
  });
}));

// ------------------------------------------------------------- GET ONE
styleRouter.get('/:id', requirePermission('STYLE.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const style = await queryOne(
    `SELECT t.*, p.product_name, b.party_name AS buyer_name, fb.fabric_name,
            sg.group_name AS size_group_name, cs.label AS status_label
       FROM mst_style t
       LEFT JOIN mst_product p ON p.id = t.product_id
       LEFT JOIN mst_party b   ON b.id = t.buyer_id
       LEFT JOIN mst_fabric fb ON fb.id = t.fabric_id
       LEFT JOIN mst_size_group sg ON sg.id = t.size_group_id
       LEFT JOIN cfg_status cs ON cs.id = t.status_id
      WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!style) throw NotFound('Style not found');

  const [colors, skus, boms, techpacks] = await Promise.all([
    query(`SELECT sc.color_id AS id, c.color_code, c.color_name, c.hex_value
             FROM map_style_color sc JOIN mst_color c ON c.id = sc.color_id
            WHERE sc.style_id = ? ORDER BY c.color_name`, [id]),
    query(SKU_SELECT, [id]),
    query(`SELECT b.*, cs.label AS status_label, so.so_no, so.buyer_po_no FROM trx_bom b
             LEFT JOIN trx_sales_order so ON so.id = b.so_id
             LEFT JOIN cfg_status cs ON cs.id = b.status_id
            WHERE b.style_id = ? ORDER BY b.version DESC`, [id]),
    query(`SELECT * FROM trx_techpack WHERE style_id = ? ORDER BY version DESC`, [id]),
  ]);

  res.json({ data: { ...style, colors, skus, boms, techpacks } });
}));

// -------------------------------------------------------------- CREATE
styleRouter.post('/', requirePermission('STYLE.CREATE'), ah(async (req, res) => {
  const { colorIds, ...data } = styleSchema.parse(req.body);

  const created = await transaction(async (tx) => {
    const cols = { ...data, company_id: req.user!.companyId, created_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => (cols as any)[k] !== undefined);
    const r = await txExecute(tx,
      `INSERT INTO mst_style (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => (cols as any)[k]));
    const styleId = r.insertId;

    if (colorIds?.length) {
      for (const cid of colorIds) {
        await txExecute(tx, `INSERT INTO map_style_color (style_id, color_id) VALUES (?,?)`, [styleId, cid]);
      }
    }
    return txQueryOne(tx, `SELECT * FROM mst_style WHERE id = ?`, [styleId]);
  });

  await audit(req, 'mst_style', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

// -------------------------------------------------------------- UPDATE
styleRouter.put('/:id', requirePermission('STYLE.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne(`SELECT * FROM mst_style WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Style not found');

  const partial = styleSchema.partial();
  const { colorIds, ...data } = partial.parse(req.body);

  const after = await transaction(async (tx) => {
    const cols = { ...data, updated_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => (cols as any)[k] !== undefined);
    if (keys.length) {
      await txExecute(tx,
        `UPDATE mst_style SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND company_id = ?`,
        [...keys.map((k) => (cols as any)[k]), id, req.user!.companyId]);
    }

    if (colorIds) {
      // Removing a colorway must not orphan SKUs that are already in use.
      const existing = await txQuery<{ color_id: number }>(
        tx,
        `SELECT color_id FROM map_style_color WHERE style_id = ?`, [id]);
      const removed = existing.map((e) => e.color_id).filter((c) => !colorIds.includes(c));
      if (removed.length) {
        const used = await txQueryOne<{ n: number }>(
          tx,
          `SELECT COUNT(*) AS n FROM mst_style_sku k
            WHERE k.style_id = ? AND k.color_id IN (${removed.map(() => '?').join(',')})`,
          [id, ...removed]);
        if ((used?.n ?? 0) > 0) {
          throw Conflict('Cannot remove a colorway that already has SKUs. Delete those SKUs first.');
        }
      }
      await txExecute(tx, `DELETE FROM map_style_color WHERE style_id = ?`, [id]);
      for (const cid of colorIds) {
        await txExecute(tx, `INSERT INTO map_style_color (style_id, color_id) VALUES (?,?)`, [id, cid]);
      }
    }
    return txQueryOne(tx, `SELECT * FROM mst_style WHERE id = ?`, [id]);
  });

  await audit(req, 'mst_style', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

styleRouter.delete('/:id', requirePermission('STYLE.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne(`SELECT * FROM mst_style WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Style not found');
  await transaction((tx) => txExecute(tx,
    `UPDATE mst_style SET is_deleted = 1, updated_by = ? WHERE id = ?`, [req.user!.id, id]));
  await audit(req, 'mst_style', id, 'DELETE', before, undefined);
  res.json({ data: { id, deleted: true } });
}));

// ------------------------------------------------------- SKU generation
/**
 * Generate the SKU matrix for a style: every mapped colorway x every size in
 * the style's size group. Existing SKUs are preserved (idempotent).
 */
styleRouter.post('/:id/generate-skus', requirePermission('STYLE.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const style = await queryOne<{ id: number; style_code: string; size_group_id: number | null }>(
    `SELECT id, style_code, size_group_id FROM mst_style WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!style) throw NotFound('Style not found');
  if (!style.size_group_id) throw BadRequest('Assign a size group to this style before generating SKUs');

  const [colors, sizes] = await Promise.all([
    query<{ color_id: number; color_code: string }>(
      `SELECT sc.color_id, c.color_code FROM map_style_color sc
         JOIN mst_color c ON c.id = sc.color_id
        WHERE sc.style_id = ? ORDER BY c.color_name`, [id]),
    query<{ id: number; size_code: string }>(
      `SELECT id, size_code FROM mst_size
        WHERE size_group_id = ? AND is_active = 1 ORDER BY sort_order, id`, [style.size_group_id]),
  ]);
  if (!colors.length) throw BadRequest('Add at least one colorway before generating SKUs');
  if (!sizes.length) throw BadRequest('The selected size group has no active sizes');

  const created = await transaction(async (tx) => {
    const existing = await txQuery<{ color_id: number; size_id: number }>(
      tx,
      `SELECT color_id, size_id FROM mst_style_sku WHERE style_id = ?`, [id]);
    const seen = new Set(existing.map((e) => `${e.color_id}:${e.size_id}`));

    let n = 0;
    for (const c of colors) {
      for (const sz of sizes) {
        if (seen.has(`${c.color_id}:${sz.id}`)) continue;
        const skuCode = `${style.style_code}-${c.color_code}-${sz.size_code}`.toUpperCase();
        await txExecute(tx,
          `INSERT INTO mst_style_sku (style_id, color_id, size_id, sku_code) VALUES (?,?,?,?)`,
          [id, c.color_id, sz.id, skuCode]);
        n++;
      }
    }
    return n;
  });

  const skus = await query(SKU_SELECT, [id]);
  res.json({ data: { created, total: skus.length, skus } });
}));

styleRouter.get('/:id/skus', requirePermission('STYLE.VIEW'), ah(async (req, res) => {
  res.json({ data: await query(SKU_SELECT, [Number(req.params.id)]) });
}));
