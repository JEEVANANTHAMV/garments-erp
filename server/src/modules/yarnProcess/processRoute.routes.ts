import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';

/**
 * Process Route Master (doc §4) — the process sequence is configuration,
 * never hard-coded, so a style can run Dyeing -> Winding -> Knitting while
 * another runs Winding -> Twisting -> Knitting.
 */
export const processRouteRouter = Router();

const routeLineSchema = z.object({
  id: z.coerce.number().int().optional(),
  seq_no: z.coerce.number().int().min(1).default(1),
  process_type: z.enum(['YARN_DYEING', 'WINDING', 'TWISTING', 'KNITTING', 'COLLAR_KNITTING']),
  is_mandatory: z.coerce.boolean().default(true),
  default_loss_pct: z.coerce.number().min(0).max(100).default(0),
  allowed_unit: z.enum(['INTERNAL', 'JOB_WORK', 'BOTH']).default('BOTH'),
  is_active: z.coerce.boolean().default(true),
});

const routeSchema = z.object({
  route_code: s.strReq(40),
  route_name: s.strReq(150),
  yarn_id: s.id(),
  fabric_id: s.id(),
  remarks: s.nullableStr(500),
  is_active: z.coerce.boolean().default(true),
  lines: z.array(routeLineSchema).default([]),
});

async function loadRoute(id: number, cid: number) {
  const route = await queryOne<any>(
    `SELECT r.*, y.yarn_name, f.fabric_name
       FROM mst_process_route r
       LEFT JOIN mst_yarn y ON y.id = r.yarn_id
       LEFT JOIN mst_fabric f ON f.id = r.fabric_id
      WHERE r.id = ? AND r.company_id = ?`, [id, cid]);
  if (!route) return null;
  route.lines = await query(
    `SELECT * FROM mst_process_route_line WHERE route_id = ? ORDER BY seq_no`, [id]);
  return route;
}

processRouteRouter.get('/process-routes', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { q, is_active } = req.query;
  let where = 'WHERE r.company_id = ?';
  const params: any[] = [cid];
  if (q) { where += ' AND (r.route_code LIKE ? OR r.route_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  if (is_active !== undefined && is_active !== '') { where += ' AND r.is_active = ?'; params.push(Number(is_active)); }

  const rows = await query(
    `SELECT r.*, y.yarn_name, f.fabric_name,
            (SELECT COUNT(*) FROM mst_process_route_line l WHERE l.route_id = r.id) AS step_count,
            (SELECT GROUP_CONCAT(l.process_type ORDER BY l.seq_no SEPARATOR ' → ')
               FROM mst_process_route_line l WHERE l.route_id = r.id) AS sequence_text
       FROM mst_process_route r
       LEFT JOIN mst_yarn y ON y.id = r.yarn_id
       LEFT JOIN mst_fabric f ON f.id = r.fabric_id
       ${where}
      ORDER BY r.route_code`, params);
  res.json({ success: true, data: rows });
}));

processRouteRouter.get('/process-routes/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const route = await loadRoute(Number(req.params.id), req.user!.companyId);
  if (!route) throw NotFound('Process route not found');
  res.json({ success: true, data: route });
}));

processRouteRouter.post('/process-routes', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = routeSchema.parse(req.body);
  if (!body.lines.length) throw BadRequest('A route needs at least one process step');

  const dup = await queryOne(
    `SELECT id FROM mst_process_route WHERE company_id = ? AND route_code = ?`, [cid, body.route_code]);
  if (dup) throw BadRequest(`Route code "${body.route_code}" already exists`);

  const result = await transaction(async (tx) => {
    const r = await txExecute(tx,
      `INSERT INTO mst_process_route
         (company_id, route_code, route_name, yarn_id, fabric_id, remarks, is_active, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [cid, body.route_code, body.route_name, body.yarn_id ?? null, body.fabric_id ?? null,
       body.remarks ?? null, body.is_active ? 1 : 0, req.user!.id]);
    const id = r.insertId;
    for (const l of body.lines) {
      await txExecute(tx,
        `INSERT INTO mst_process_route_line
           (route_id, seq_no, process_type, is_mandatory, default_loss_pct, allowed_unit, is_active)
         VALUES (?,?,?,?,?,?,?)`,
        [id, l.seq_no, l.process_type, l.is_mandatory ? 1 : 0, l.default_loss_pct,
         l.allowed_unit, l.is_active ? 1 : 0]);
    }
    return { id };
  });

  await audit(req, 'mst_process_route', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: await loadRoute(result.id, cid) });
}));

processRouteRouter.put('/process-routes/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = routeSchema.partial().parse(req.body);

  const existing = await queryOne(
    `SELECT * FROM mst_process_route WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Process route not found');

  await transaction(async (tx) => {
    // Only the keys actually supplied are written, so a partial update cannot
    // blank out fields the caller never mentioned.
    const FIELDS = ['route_code', 'route_name', 'yarn_id', 'fabric_id', 'remarks'] as const;
    const sets: string[] = []; const vals: any[] = [];
    for (const f of FIELDS) {
      const v = (body as Record<string, any>)[f];
      if (v === undefined) continue;
      sets.push(`${f} = ?`); vals.push(v);
    }
    if (body.is_active !== undefined) { sets.push('is_active = ?'); vals.push(body.is_active ? 1 : 0); }
    if (sets.length) {
      await txExecute(tx,
        `UPDATE mst_process_route SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`,
        [...vals, id, cid]);
    }
    if (body.lines !== undefined) {
      await txExecute(tx, `DELETE FROM mst_process_route_line WHERE route_id = ?`, [id]);
      for (const l of body.lines ?? []) {
        await txExecute(tx,
          `INSERT INTO mst_process_route_line
             (route_id, seq_no, process_type, is_mandatory, default_loss_pct, allowed_unit, is_active)
           VALUES (?,?,?,?,?,?,?)`,
          [id, l.seq_no, l.process_type, l.is_mandatory ? 1 : 0, l.default_loss_pct,
           l.allowed_unit, l.is_active ? 1 : 0]);
      }
    }
  });

  await audit(req, 'mst_process_route', id, 'UPDATE', existing, body);
  res.json({ success: true, data: await loadRoute(id, cid) });
}));

processRouteRouter.delete('/process-routes/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const route = await queryOne(
    `SELECT id FROM mst_process_route WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!route) throw NotFound('Process route not found');

  const inUse = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM trx_yarn_process WHERE route_id = ?`, [id]);
  if (Number(inUse?.n ?? 0) > 0) {
    throw BadRequest('This route is used by existing processes; deactivate it instead of deleting.');
  }

  await query(`DELETE FROM mst_process_route WHERE id = ?`, [id]);
  await audit(req, 'mst_process_route', id, 'DELETE', route);
  res.json({ success: true, message: 'Process route deleted' });
}));
