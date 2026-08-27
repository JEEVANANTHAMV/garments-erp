import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const bomRouter = Router();

const lineSchema = z.object({
  material_type: z.enum(['YARN', 'FABRIC', 'TRIM']),
  yarn_id: s.id(), fabric_id: s.id(), trim_id: s.id(),
  color_id: s.id(), size_id: s.id(),
  consumption: z.coerce.number().positive('Consumption must be greater than zero'),
  uom_id: s.idReq(),
  wastage_pct: z.coerce.number().min(0).max(100).default(0),
  remarks: s.nullableStr(255),
}).refine(
  (l) => (l.material_type === 'YARN' && l.yarn_id) ||
         (l.material_type === 'FABRIC' && l.fabric_id) ||
         (l.material_type === 'TRIM' && l.trim_id),
  { message: 'Select a material matching the chosen material type' },
);

const bomSchema = z.object({
  style_id: s.idReq(),
  so_id: s.id().nullish(),
  bom_no: s.nullableStr(40),
  version: z.coerce.number().int().min(1).default(1),
  effective_date: s.date(),
  status_id: s.id(),
  remarks: s.nullableStr(500),
  is_active: s.bool(),
  lines: z.array(lineSchema).default([]),
});

const LINE_SELECT = `
  SELECT l.*, y.yarn_name, y.yarn_code, fb.fabric_name, fb.fabric_code,
         tr.trim_name, tr.trim_code, c.color_name, sz.size_code, u.code AS uom_code,
         COALESCE(y.std_rate, fb.std_rate, tr.std_rate, 0) AS std_rate
    FROM trx_bom_line l
    LEFT JOIN mst_yarn y   ON y.id  = l.yarn_id
    LEFT JOIN mst_fabric fb ON fb.id = l.fabric_id
    LEFT JOIN mst_trim tr  ON tr.id = l.trim_id
    LEFT JOIN mst_color c  ON c.id  = l.color_id
    LEFT JOIN mst_size sz  ON sz.id = l.size_id
    LEFT JOIN cfg_uom u    ON u.id  = l.uom_id
   WHERE l.bom_id = ? ORDER BY l.material_type, l.id`;

bomRouter.get('/', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    style_id: z.coerce.number().int().optional(),
    so_id: z.coerce.number().int().optional(),
    q: z.string().trim().optional(),
  }).parse(req.query);

  const where = ['b.company_id = ?', 'b.is_active = 1'];
  const params: unknown[] = [req.user!.companyId];
  if (q.style_id) { where.push('b.style_id = ?'); params.push(q.style_id); }
  if (q.so_id)    { where.push('b.so_id = ?'); params.push(q.so_id); }
  if (q.q) {
    where.push('(b.bom_no LIKE ? OR st.style_code LIKE ? OR so.so_no LIKE ? OR so.buyer_po_no LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
  }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(`SELECT b.*, st.style_code, st.style_name, cs.label AS status_label,
                  so.so_no, so.buyer_po_no,
                  (SELECT COUNT(*) FROM trx_bom_line l WHERE l.bom_id = b.id) AS line_count
             FROM trx_bom b
             LEFT JOIN mst_style st ON st.id = b.style_id
             LEFT JOIN trx_sales_order so ON so.id = b.so_id
             LEFT JOIN cfg_status cs ON cs.id = b.status_id
            WHERE ${clause} ORDER BY b.id DESC LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(
      `SELECT COUNT(*) AS total FROM trx_bom b
         LEFT JOIN mst_style st ON st.id = b.style_id
         LEFT JOIN trx_sales_order so ON so.id = b.so_id
        WHERE ${clause}`, params),
  ]);
  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

bomRouter.get('/:id', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const bom = await queryOne(
    `SELECT b.*, st.style_code, st.style_name, cs.label AS status_label,
            so.so_no, so.buyer_po_no
       FROM trx_bom b
       LEFT JOIN mst_style st ON st.id = b.style_id
       LEFT JOIN trx_sales_order so ON so.id = b.so_id
       LEFT JOIN cfg_status cs ON cs.id = b.status_id
      WHERE b.id = ? AND b.company_id = ?`, [id, req.user!.companyId]);
  if (!bom) throw NotFound('BOM not found');
  res.json({ data: { ...bom, lines: await query(LINE_SELECT, [id]) } });
}));

async function writeLines(tx: any, bomId: number, lines: z.infer<typeof lineSchema>[]) {
  for (const l of lines) {
    await txExecute(tx,
      `INSERT INTO trx_bom_line
         (bom_id, material_type, yarn_id, fabric_id, trim_id, color_id, size_id,
          consumption, uom_id, wastage_pct, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [bomId, l.material_type, l.yarn_id ?? null, l.fabric_id ?? null, l.trim_id ?? null,
       l.color_id ?? null, l.size_id ?? null, l.consumption, l.uom_id, l.wastage_pct ?? 0,
       l.remarks ?? null]);
  }
}

bomRouter.post('/', requirePermission('BOM.CREATE'), ah(async (req, res) => {
  const body = bomSchema.parse(req.body);
  const created = await transaction(async (tx) => {
    const bomNo = body.bom_no || await nextDocNumber(tx, req.user!.companyId, 'BOM');
    const r = await txExecute(tx,
      `INSERT INTO trx_bom (company_id, style_id, so_id, bom_no, version, effective_date,
                            status_id, remarks, is_active, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, body.style_id, body.so_id ?? null, bomNo, body.version, body.effective_date ?? null,
       body.status_id ?? null, body.remarks ?? null, body.is_active ?? 1, req.user!.id]);
    await writeLines(tx, r.insertId, body.lines);
    return txQueryOne(tx, `SELECT * FROM trx_bom WHERE id = ?`, [r.insertId]);
  });
  await audit(req, 'trx_bom', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

bomRouter.put('/:id', requirePermission('BOM.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('BOM not found');
  const body = bomSchema.partial().parse(req.body);

  const after = await transaction(async (tx) => {
    const { lines, ...head } = body;
    const cols = { ...head, updated_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => (cols as any)[k] !== undefined);
    if (keys.length) {
      await txExecute(tx,
        `UPDATE trx_bom SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND company_id = ?`,
        [...keys.map((k) => (cols as any)[k]), id, req.user!.companyId]);
    }
    if (lines) {
      await txExecute(tx, `DELETE FROM trx_bom_line WHERE bom_id = ?`, [id]);
      await writeLines(tx, id, lines);
    }
    return txQueryOne(tx, `SELECT * FROM trx_bom WHERE id = ?`, [id]);
  });
  await audit(req, 'trx_bom', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

bomRouter.delete('/:id', requirePermission('BOM.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('BOM not found');
  await transaction((tx) => txExecute(tx, `UPDATE trx_bom SET is_active = 0, updated_by = ? WHERE id = ?`,
    [req.user!.id, id]));
  await audit(req, 'trx_bom', id, 'DELETE', before, undefined);
  res.json({ data: { id, deleted: true } });
}));

/** Explode a BOM for a given garment quantity — the costing/MRP preview. */
bomRouter.get('/:id/explode', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const qty = z.coerce.number().int().positive().default(1).parse(req.query.qty ?? 1);
  const bom = await queryOne(`SELECT * FROM trx_bom WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!bom) throw NotFound('BOM not found');

  const lines = await query<any>(LINE_SELECT, [id]);
  const exploded = lines.map((l) => {
    const perGarment = Number(l.consumption);
    const withWastage = perGarment * (1 + Number(l.wastage_pct ?? 0) / 100);
    const required = withWastage * qty;
    return {
      ...l,
      per_garment: perGarment,
      per_garment_with_wastage: Number(withWastage.toFixed(5)),
      total_required: Number(required.toFixed(5)),
      estimated_cost: Number((required * Number(l.std_rate ?? 0)).toFixed(4)),
    };
  });

  res.json({
    data: {
      bom, qty, lines: exploded,
      total_estimated_cost: Number(exploded.reduce((a, l) => a + l.estimated_cost, 0).toFixed(4)),
    },
  });
}));
