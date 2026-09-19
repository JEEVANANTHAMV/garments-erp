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

/**
 * GET /for-job — Find Active BOM and materials for a Job / Sales Order / Style
 * Used by Yarn, Fabric, Trim, and General POs to load and filter only planned BOM materials.
 */
bomRouter.get('/for-job', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = req.query.so_id ? Number(req.query.so_id) : undefined;
  let styleId = req.query.style_id ? Number(req.query.style_id) : undefined;
  const ioNo = req.query.io_no ? String(req.query.io_no).trim() : undefined;

  let orderQty = 1000;
  let soRecord: any = null;

  if (soId) {
    soRecord = await queryOne<any>(`
      SELECT so.*, st.id AS style_id, st.style_code, st.style_name
        FROM trx_sales_order so
        LEFT JOIN mst_style st ON st.id = so.style_id
       WHERE so.id = ? AND so.company_id = ?
    `, [soId, cid]);
    if (soRecord) {
      if (!styleId && soRecord.style_id) styleId = Number(soRecord.style_id);
      orderQty = Number(soRecord.total_qty || soRecord.order_qty || 1000);
    }
  } else if (ioNo) {
    soRecord = await queryOne<any>(`
      SELECT so.*, st.id AS style_id, st.style_code, st.style_name
        FROM trx_sales_order so
        LEFT JOIN mst_style st ON st.id = so.style_id
       WHERE (so.so_no = ? OR so.buyer_po_no = ?) AND so.company_id = ?
       LIMIT 1
    `, [ioNo, ioNo, cid]);
    if (soRecord) {
      if (!styleId && soRecord.style_id) styleId = Number(soRecord.style_id);
      orderQty = Number(soRecord.total_qty || soRecord.order_qty || 1000);
    }
  }

  if (!styleId && !soId) {
    return res.json({ success: true, data: null, message: 'Please provide so_id, style_id or io_no' });
  }

  // 1. Order-specific active BOM
  let bom: any = null;
  if (soId && styleId) {
    bom = await queryOne<any>(`
      SELECT b.*, st.style_code, st.style_name, so.so_no, so.buyer_po_no
        FROM trx_bom b
        LEFT JOIN mst_style st ON st.id = b.style_id
        LEFT JOIN trx_sales_order so ON so.id = b.so_id
       WHERE b.company_id = ? AND b.is_active = 1 AND b.so_id = ? AND b.style_id = ?
       ORDER BY b.version DESC, b.id DESC LIMIT 1
    `, [cid, soId, styleId]);
  }

  // 2. Fallback to Style Master active BOM
  if (!bom && styleId) {
    bom = await queryOne<any>(`
      SELECT b.*, st.style_code, st.style_name, so.so_no, so.buyer_po_no
        FROM trx_bom b
        LEFT JOIN mst_style st ON st.id = b.style_id
        LEFT JOIN trx_sales_order so ON so.id = b.so_id
       WHERE b.company_id = ? AND b.is_active = 1 AND b.style_id = ? AND (b.so_id IS NULL OR b.so_id = ?)
       ORDER BY b.version DESC, b.id DESC LIMIT 1
    `, [cid, styleId, soId || 0]);
  }

  if (!bom) {
    return res.json({
      success: true,
      data: null,
      message: 'No active BOM found for this Job / Style',
    });
  }

  const lines = await query<any>(LINE_SELECT, [bom.id]);

  const items = lines.map((l) => {
    const cons = Number(l.consumption) || 0;
    const waste = Number(l.wastage_pct) || 0;
    const reqPerGmt = cons * (1 + waste / 100);
    const orderReqQty = Number((reqPerGmt * orderQty).toFixed(4));
    return {
      ...l,
      consumption: cons,
      wastage_pct: waste,
      order_qty: orderQty,
      order_required_qty: orderReqQty,
      std_rate: Number(l.std_rate) || 0,
      estimated_amount: Number((orderReqQty * (Number(l.std_rate) || 0)).toFixed(2)),
    };
  });

  res.json({
    success: true,
    data: {
      bom,
      order_qty: orderQty,
      so: soRecord,
      lines: items,
      yarns: items.filter((i) => i.material_type === 'YARN'),
      fabrics: items.filter((i) => i.material_type === 'FABRIC'),
      trims: items.filter((i) => i.material_type === 'TRIM'),
    },
  });
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

/** GET /latest-cad/:styleId — Check for approved CAD Auto-Consumption for style */
bomRouter.get('/latest-cad/:styleId', requirePermission('BOM.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const styleId = Number(req.params.styleId);

  const cadReq = await queryOne<any>(`
    SELECT cmr.id AS cmr_id, cmr.total_fabric_kg, cmr.total_yarn_kg, cmr.created_at AS approved_at,
           cr.id AS cad_req_id, cr.req_no, cr.order_qty, cr.marker_efficiency, cr.cad_version
      FROM trx_cad_material_requirement cmr
      JOIN trx_cad_requirement cr ON cr.id = cmr.cad_req_id
     WHERE cmr.company_id = ? AND cmr.style_id = ? AND cmr.status = 'APPROVED'
     ORDER BY cmr.id DESC LIMIT 1
  `, [cid, styleId]);

  if (!cadReq) {
    return res.json({ success: true, data: null });
  }

  const orderQty = Number(cadReq.order_qty) || 1000;
  const totalFabric = Number(cadReq.total_fabric_kg) || 0;
  const totalYarn = Number(cadReq.total_yarn_kg) || 0;

  res.json({
    success: true,
    data: {
      ...cadReq,
      fabric_consumption_per_pc: totalFabric > 0 ? Number((totalFabric / orderQty).toFixed(5)) : 0.82,
      yarn_consumption_per_pc: totalYarn > 0 ? Number((totalYarn / orderQty).toFixed(5)) : 0.86,
    },
  });
}));

/** POST /:id/sync-cad — Sync CAD auto-consumption into BOM Yarn & Fabric lines */
bomRouter.post('/:id/sync-cad', requirePermission('BOM.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const cid = req.user!.companyId;

  const bom = await queryOne<any>(`
    SELECT b.* FROM trx_bom b WHERE b.id = ? AND b.company_id = ?
  `, [id, cid]);
  if (!bom) throw NotFound('BOM not found');

  // Look for approved CAD material requirement
  const cadReq = await queryOne<any>(`
    SELECT cmr.*, cr.req_no, cr.order_qty, cr.marker_efficiency, cr.data_json
      FROM trx_cad_material_requirement cmr
      JOIN trx_cad_requirement cr ON cr.id = cmr.cad_req_id
     WHERE cmr.company_id = ? AND cmr.style_id = ?
     ORDER BY cmr.id DESC LIMIT 1
  `, [cid, bom.style_id]);

  if (!cadReq) {
    throw BadRequest('No approved CAD Auto-Consumption found for this Style. Please create & approve a CAD requirement first.');
  }

  const orderQty = Number(cadReq.order_qty) || 1000;
  const totalFabricKg = Number(cadReq.total_fabric_kg) || 0;
  const totalYarnKg = Number(cadReq.total_yarn_kg) || 0;

  const fabricConsPerGmt = totalFabricKg > 0 ? Number((totalFabricKg / orderQty).toFixed(5)) : 0.82;
  const yarnConsPerGmt = totalYarnKg > 0 ? Number((totalYarnKg / orderQty).toFixed(5)) : Number((fabricConsPerGmt * 1.05).toFixed(5));

  const defaultFabric = await queryOne<any>(`SELECT id, base_uom FROM mst_fabric WHERE company_id = ? AND is_active = 1 LIMIT 1`, [cid]);
  const defaultYarn = await queryOne<any>(`SELECT id, base_uom FROM mst_yarn WHERE company_id = ? AND is_active = 1 LIMIT 1`, [cid]);
  const kgUom = await queryOne<any>(`SELECT id FROM cfg_uom WHERE (code = 'KG' OR code = 'KGS') AND (company_id = ? OR company_id IS NULL) LIMIT 1`, [cid]);
  const uomId = kgUom?.id || defaultFabric?.base_uom || defaultYarn?.base_uom || 1;

  await transaction(async (tx) => {
    const existingFabric = await txQueryOne<any>(tx, `
      SELECT id FROM trx_bom_line WHERE bom_id = ? AND material_type = 'FABRIC' LIMIT 1
    `, [id]);

    if (existingFabric) {
      await txExecute(tx, `
        UPDATE trx_bom_line
           SET consumption = ?, wastage_pct = 5.0, remarks = CONCAT('CAD Auto-Synced: ', ?)
         WHERE id = ?
      `, [fabricConsPerGmt, cadReq.req_no || 'CAD V01', existingFabric.id]);
    } else if (defaultFabric) {
      await txExecute(tx, `
        INSERT INTO trx_bom_line (bom_id, material_type, fabric_id, consumption, uom_id, wastage_pct, remarks)
        VALUES (?, 'FABRIC', ?, ?, ?, 5.0, ?)
      `, [id, defaultFabric.id, fabricConsPerGmt, uomId, `CAD Auto-Synced (${cadReq.req_no || 'CAD'})`]);
    }

    const existingYarn = await txQueryOne<any>(tx, `
      SELECT id FROM trx_bom_line WHERE bom_id = ? AND material_type = 'YARN' LIMIT 1
    `, [id]);

    if (existingYarn) {
      await txExecute(tx, `
        UPDATE trx_bom_line
           SET consumption = ?, wastage_pct = 3.0, remarks = CONCAT('CAD Auto-Synced: ', ?)
         WHERE id = ?
      `, [yarnConsPerGmt, cadReq.req_no || 'CAD V01', existingYarn.id]);
    } else if (defaultYarn) {
      await txExecute(tx, `
        INSERT INTO trx_bom_line (bom_id, material_type, yarn_id, consumption, uom_id, wastage_pct, remarks)
        VALUES (?, 'YARN', ?, ?, ?, 3.0, ?)
      `, [id, defaultYarn.id, yarnConsPerGmt, uomId, `CAD Auto-Synced (${cadReq.req_no || 'CAD'})`]);
    }
  });

  const updatedLines = await query(LINE_SELECT, [id]);
  res.json({
    success: true,
    message: `Successfully synced CAD auto-consumption from ${cadReq.req_no || 'CAD'} (Fabric: ${fabricConsPerGmt} KG/pc, Yarn: ${yarnConsPerGmt} KG/pc)`,
    data: { ...bom, lines: updatedLines },
  });
}));

