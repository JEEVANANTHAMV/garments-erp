import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { txResolvePartName } from '../../core/partName.js';
import {
  PROCESS_STATUSES, assertEditable, checkStock, reserveYarn, postLedger, UOM_PCS,
} from '../../core/processEngine.js';

/**
 * Collar Knitting (doc §16, §17).
 *
 * A separate process because the output is PCS while yarn is consumed in KG.
 * The standard weight per piece is a PLANNING figure only: actual production
 * records actual KG and actual PCS, and the actual gm/pc is derived from those
 * two, never from a fixed conversion factor (doc §17, §29).
 */
export const collarRouter = Router();

/* ================================================================
   Collar master / collar BOM (doc §16.1)
================================================================ */

const collarSchema = z.object({
  collar_code: s.strReq(40),
  style_id: s.id(),
  collar_type: s.nullableStr(60),
  construction: s.nullableStr(60),
  size_id: s.id(),
  colour: s.nullableStr(80),
  yarn_id: s.id(),
  std_weight_gm: z.coerce.number().min(0).default(0),
  is_active: z.coerce.boolean().default(true),
});

collarRouter.get('/collars', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { style_id, q } = req.query;
  let where = 'WHERE c.company_id = ?';
  const params: any[] = [cid];
  if (style_id) { where += ' AND c.style_id = ?'; params.push(style_id); }
  if (q) { where += ' AND (c.collar_code LIKE ? OR c.collar_type LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  const rows = await query(
    `SELECT c.*, st.style_code, sz.size_code, y.yarn_code, y.yarn_name,
            ROUND(c.std_weight_gm / 1000, 5) AS std_consumption_kg_pc
       FROM mst_collar c
       LEFT JOIN mst_style st ON st.id = c.style_id
       LEFT JOIN mst_size sz ON sz.id = c.size_id
       LEFT JOIN mst_yarn y ON y.id = c.yarn_id
       ${where} ORDER BY c.collar_code`, params);
  res.json({ success: true, data: rows });
}));

collarRouter.post('/collars', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = collarSchema.parse(req.body);
  const dup = await queryOne(
    `SELECT id FROM mst_collar WHERE company_id = ? AND collar_code = ?`, [cid, body.collar_code]);
  if (dup) throw BadRequest(`Collar code "${body.collar_code}" already exists`);

  const r = await query<any>(
    `INSERT INTO mst_collar
       (company_id, collar_code, style_id, collar_type, construction, size_id, colour,
        yarn_id, std_weight_gm, is_active, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, body.collar_code, body.style_id ?? null, body.collar_type ?? null,
     body.construction ?? null, body.size_id ?? null, body.colour ?? null,
     body.yarn_id ?? null, body.std_weight_gm, body.is_active ? 1 : 0, req.user!.id]);
  const id = (r as any).insertId;
  await audit(req, 'mst_collar', id, 'INSERT', undefined, body);
  res.status(201).json({ success: true, data: { id } });
}));

collarRouter.put('/collars/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = collarSchema.partial().parse(req.body);
  const existing = await queryOne(`SELECT * FROM mst_collar WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Collar not found');

  const FIELDS = ['collar_code', 'style_id', 'collar_type', 'construction', 'size_id',
                  'colour', 'yarn_id', 'std_weight_gm'] as const;
  const sets: string[] = []; const vals: any[] = [];
  for (const f of FIELDS) {
    const v = (body as Record<string, any>)[f];
    if (v === undefined) continue;
    sets.push(`${f} = ?`); vals.push(v);
  }
  if (body.is_active !== undefined) { sets.push('is_active = ?'); vals.push(body.is_active ? 1 : 0); }
  if (sets.length) {
    await query(`UPDATE mst_collar SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`,
      [...vals, id, cid]);
  }
  await audit(req, 'mst_collar', id, 'UPDATE', existing, body);
  res.json({ success: true, data: await queryOne(`SELECT * FROM mst_collar WHERE id = ?`, [id]) });
}));

collarRouter.delete('/collars/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const inUse = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM trx_collar_program WHERE collar_id = ?`, [id]);
  if (Number(inUse?.n ?? 0) > 0) throw BadRequest('Collar is used by programs; deactivate it instead');
  const c = await queryOne(`SELECT id FROM mst_collar WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!c) throw NotFound('Collar not found');
  await query(`DELETE FROM mst_collar WHERE id = ?`, [id]);
  await audit(req, 'mst_collar', id, 'DELETE', c);
  res.json({ success: true, message: 'Collar deleted' });
}));

/* ================================================================
   Collar knitting program (doc §16.2, §16.3)
================================================================ */

const sizeLineSchema = z.object({
  id: z.coerce.number().int().optional(),
  size_id: s.id(),
  size_code: s.nullableStr(40),
  std_weight_gm: z.coerce.number().min(0).default(0),
  planned_pcs: z.coerce.number().int().min(0).default(0),
});

const programSchema = z.object({
  program_no: s.nullableStr(60),
  program_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  so_id: s.id(), so_line_id: s.id(),
  io_no: s.nullableStr(60), buyer_po_no: s.nullableStr(60),
  style_id: s.id(),
  part_name: s.nullableStr(50),
  collar_id: s.id(),
  collar_type: s.nullableStr(60),
  colour: s.nullableStr(80),
  yarn_id: s.id(),
  gauge_needle: s.nullableStr(40),
  required_date: s.date(),
  job_work_type: z.enum(['INTERNAL', 'JOB_WORK']).default('INTERNAL'),
  vendor_id: s.id(),
  status: z.enum(PROCESS_STATUSES).default('DRAFT'),
  remarks: s.text(),
  sizes: z.array(sizeLineSchema).default([]),
});

const programUpdateSchema = programSchema.omit({ program_no: true }).partial().extend({
  sizes: z.array(sizeLineSchema).optional(),
});

/**
 * Size-wise planning maths (doc §16.3): each size contributes
 * planned_pcs * std_weight_gm / 1000 KG. These are planning figures only.
 */
function planSizes(sizes: z.infer<typeof sizeLineSchema>[]) {
  let totalKg = 0, totalPcs = 0;
  const rows = sizes.map((s) => {
    const kg = Math.round((s.planned_pcs * s.std_weight_gm) / 1000 * 1000) / 1000;
    totalKg += kg; totalPcs += s.planned_pcs;
    return { ...s, std_yarn_kg: kg };
  });
  return { rows, totalKg: Math.round(totalKg * 1000) / 1000, totalPcs };
}

async function loadProgram(id: number, cid: number) {
  const p = await queryOne<any>(
    `SELECT cp.*, c.collar_code, c.construction, st.style_code, st.style_name,
            y.yarn_code, y.yarn_name, pa.party_name AS vendor_name
       FROM trx_collar_program cp
       LEFT JOIN mst_collar c ON c.id = cp.collar_id
       LEFT JOIN mst_style st ON st.id = cp.style_id
       LEFT JOIN mst_yarn y ON y.id = cp.yarn_id
       LEFT JOIN mst_party pa ON pa.id = cp.vendor_id
      WHERE cp.id = ? AND cp.company_id = ?`, [id, cid]);
  if (!p) return null;

  p.sizes = await query(
    `SELECT s.*, sz.size_code AS size_master_code
       FROM trx_collar_program_size s
       LEFT JOIN mst_size sz ON sz.id = s.size_id
      WHERE s.program_id = ? ORDER BY s.id`, [id]);

  p.productions = await query(
    `SELECT pr.*, sz.size_code
       FROM trx_collar_production pr
       LEFT JOIN mst_size sz ON sz.id = pr.size_id
      WHERE pr.program_id = ? ORDER BY pr.id`, [id]);

  p.issues = await query(
    `SELECT i.*, y.yarn_code, y.yarn_name FROM trx_process_issue i
       LEFT JOIN mst_yarn y ON y.id = i.yarn_id
      WHERE i.src_type = 'COLLAR_PROGRAM' AND i.src_id = ? ORDER BY i.id`, [id]);

  p.receipts = await query(
    `SELECT rc.*, sz.size_code AS size_master_code
       FROM trx_collar_receipt rc
       LEFT JOIN mst_size sz ON sz.id = rc.size_id
      WHERE rc.program_id = ? ORDER BY rc.id`, [id]);

  // Variance: planned vs actual, in both PCS and KG (doc §17, §28).
  const actualKg = (p.productions as any[]).reduce((n, r) => n + Number(r.actual_yarn_kg || 0), 0);
  const producedPcs = (p.productions as any[]).reduce((n, r) => n + Number(r.produced_pcs || 0), 0);
  const goodPcs = (p.productions as any[]).reduce((n, r) => n + Number(r.good_pcs || 0), 0);
  p.summary = {
    planned_yarn_kg: Number(p.planned_yarn_kg),
    expected_pcs: Number(p.expected_pcs),
    actual_yarn_kg: Math.round(actualKg * 1000) / 1000,
    produced_pcs: producedPcs,
    good_pcs: goodPcs,
    // Derived from actuals, not from the standard weight.
    actual_wt_gm_pc: producedPcs > 0 ? Math.round((actualKg * 1000) / producedPcs * 1000) / 1000 : null,
    yarn_variance_kg: Math.round((actualKg - Number(p.planned_yarn_kg)) * 1000) / 1000,
    pcs_variance: producedPcs - Number(p.expected_pcs),
    // Stock actually received, in pieces (doc §16.5).
    received_pcs: (p.receipts as any[]).reduce((n, r) => n + Number(r.good_pcs || 0), 0),
    in_stock_pcs: (p.receipts as any[])
      .filter((r) => r.is_stock_posted)
      .reduce((n, r) => n + Number(r.good_pcs || 0), 0),
  };
  return p;
}

collarRouter.get('/collar-programs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { status, style_id, q } = req.query;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 25)));

  let where = 'WHERE cp.company_id = ?';
  const params: any[] = [cid];
  if (status) { where += ' AND cp.status = ?'; params.push(status); }
  if (style_id) { where += ' AND cp.style_id = ?'; params.push(style_id); }
  if (q) { where += ' AND (cp.program_no LIKE ? OR cp.io_no LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }

  const offset = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    query(
      `SELECT cp.*, st.style_code, y.yarn_code,
              COALESCE((SELECT SUM(pr.produced_pcs) FROM trx_collar_production pr
                         WHERE pr.program_id = cp.id),0) AS produced_pcs,
              COALESCE((SELECT SUM(pr.actual_yarn_kg) FROM trx_collar_production pr
                         WHERE pr.program_id = cp.id),0) AS actual_yarn_kg
         FROM trx_collar_program cp
         LEFT JOIN mst_style st ON st.id = cp.style_id
         LEFT JOIN mst_yarn y ON y.id = cp.yarn_id
         ${where} ORDER BY cp.id DESC LIMIT ${pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM trx_collar_program cp ${where}`, params),
  ]);

  res.json({
    success: true, data: rows,
    pagination: { page, pageSize, total: total?.total ?? 0,
                  totalPages: Math.ceil((total?.total ?? 0) / pageSize) },
  });
}));

collarRouter.get('/collar-programs/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const p = await loadProgram(Number(req.params.id), req.user!.companyId);
  if (!p) throw NotFound('Collar program not found');
  res.json({ success: true, data: p });
}));

collarRouter.post('/collar-programs', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = programSchema.parse(req.body);
  const { rows, totalKg, totalPcs } = planSizes(body.sizes);

  const result = await transaction(async (tx) => {
    const programNo = body.program_no || await nextDocNumber(tx, cid, 'COLLAR_PROGRAM');
    const partName = await txResolvePartName(tx, body.so_line_id, body.part_name, 'COLLAR');

    const r = await txExecute(tx,
      `INSERT INTO trx_collar_program
         (company_id, program_no, program_date, so_id, so_line_id, io_no, buyer_po_no,
          style_id, part_name, collar_id, collar_type, colour, yarn_id, gauge_needle,
          planned_yarn_kg, expected_pcs, required_date, job_work_type, vendor_id,
          status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, programNo, body.program_date, body.so_id ?? null, body.so_line_id ?? null,
       body.io_no ?? null, body.buyer_po_no ?? null, body.style_id ?? null, partName,
       body.collar_id ?? null, body.collar_type ?? null, body.colour ?? null,
       body.yarn_id ?? null, body.gauge_needle ?? null, totalKg, totalPcs,
       body.required_date ?? null, body.job_work_type, body.vendor_id ?? null,
       body.status, body.remarks ?? null, req.user!.id]);
    const id = r.insertId;

    for (const sz of rows) {
      await txExecute(tx,
        `INSERT INTO trx_collar_program_size
           (program_id, size_id, size_code, std_weight_gm, planned_pcs, std_yarn_kg)
         VALUES (?,?,?,?,?,?)`,
        [id, sz.size_id ?? null, sz.size_code ?? null, sz.std_weight_gm,
         sz.planned_pcs, sz.std_yarn_kg]);
    }
    return { id, program_no: programNo };
  });

  await audit(req, 'trx_collar_program', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: await loadProgram(result.id, cid) });
}));

collarRouter.put('/collar-programs/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = programUpdateSchema.parse(req.body);

  const existing = await queryOne<any>(
    `SELECT * FROM trx_collar_program WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Collar program not found');
  if (body.status !== existing.status) assertEditable(existing.status, 'collar program');

  await transaction(async (tx) => {
    const FIELDS = ['program_date', 'so_id', 'so_line_id', 'io_no', 'buyer_po_no', 'style_id',
                    'part_name', 'collar_id', 'collar_type', 'colour', 'yarn_id',
                    'gauge_needle', 'required_date', 'job_work_type', 'vendor_id',
                    'status', 'remarks'] as const;
    const sets: string[] = []; const vals: any[] = [];
    for (const f of FIELDS) {
      const v = (body as Record<string, any>)[f];
      if (v === undefined) continue;
      sets.push(`${f} = ?`); vals.push(v);
    }
    if (body.so_line_id !== undefined) {
      const linked = await txResolvePartName(tx, body.so_line_id, body.part_name, 'COLLAR');
      if (linked) {
        const i = sets.indexOf('part_name = ?');
        if (i >= 0) vals[i] = linked; else { sets.push('part_name = ?'); vals.push(linked); }
      }
    }

    // Replacing the size grid re-derives the planning totals from it.
    if (body.sizes !== undefined) {
      const { rows, totalKg, totalPcs } = planSizes(body.sizes ?? []);
      await txExecute(tx, `DELETE FROM trx_collar_program_size WHERE program_id = ?`, [id]);
      for (const sz of rows) {
        await txExecute(tx,
          `INSERT INTO trx_collar_program_size
             (program_id, size_id, size_code, std_weight_gm, planned_pcs, std_yarn_kg)
           VALUES (?,?,?,?,?,?)`,
          [id, sz.size_id ?? null, sz.size_code ?? null, sz.std_weight_gm,
           sz.planned_pcs, sz.std_yarn_kg]);
      }
      sets.push('planned_yarn_kg = ?'); vals.push(totalKg);
      sets.push('expected_pcs = ?'); vals.push(totalPcs);
    }

    if (sets.length) {
      await txExecute(tx,
        `UPDATE trx_collar_program SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`,
        [...vals, id, cid]);
    }
  });

  await audit(req, 'trx_collar_program', id, 'UPDATE', existing, body);
  res.json({ success: true, data: await loadProgram(id, cid) });
}));

collarRouter.delete('/collar-programs/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const p = await queryOne<any>(
    `SELECT id, status FROM trx_collar_program WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!p) throw NotFound('Collar program not found');
  if (!['DRAFT', 'CANCELLED'].includes(p.status)) {
    throw BadRequest('Only DRAFT or CANCELLED programs can be deleted');
  }
  await query(`DELETE FROM trx_collar_program WHERE id = ?`, [id]);
  await audit(req, 'trx_collar_program', id, 'DELETE', p);
  res.json({ success: true, message: 'Collar program deleted' });
}));

/* ---------------- stock check / reserve ---------------- */
collarRouter.post('/collar-programs/:id/check-stock', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const p = await queryOne<any>(
    `SELECT * FROM trx_collar_program WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!p) throw NotFound('Collar program not found');
  if (!p.yarn_id) throw BadRequest('Select a yarn before running the stock check');
  const rows = await checkStock(cid, [{ yarn_id: p.yarn_id, required_qty_kg: Number(p.planned_yarn_kg) }]);
  if (p.status === 'DRAFT') {
    await query(`UPDATE trx_collar_program SET status = 'STOCK_CHECK' WHERE id = ?`, [id]);
  }
  res.json({ success: true, data: rows });
}));

collarRouter.post('/collar-programs/:id/reserve', requirePermission('PROCESS.RESERVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const p = await queryOne<any>(
    `SELECT * FROM trx_collar_program WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!p) throw NotFound('Collar program not found');
  assertEditable(p.status, 'collar program');
  if (!p.yarn_id) throw BadRequest('Select a yarn before reserving');

  const qty = req.body?.reserved_qty_kg !== undefined
    ? Number(req.body.reserved_qty_kg) : Number(p.planned_yarn_kg);

  await transaction(async (tx) => {
    await reserveYarn(tx, {
      companyId: cid, srcType: 'COLLAR_PROGRAM', srcId: id, yarnId: p.yarn_id,
      requiredQtyKg: Number(p.planned_yarn_kg), reservedQtyKg: qty, createdBy: req.user!.id,
    });
    await txExecute(tx,
      `UPDATE trx_collar_program SET status = 'RESERVED'
        WHERE id = ? AND status IN ('DRAFT','STOCK_CHECK')`, [id]);
  });

  res.json({ success: true, data: await loadProgram(id, cid) });
}));

collarRouter.post('/collar-programs/:id/release', requirePermission('PROCESS.RELEASE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const p = await queryOne<any>(
    `SELECT * FROM trx_collar_program WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!p) throw NotFound('Collar program not found');
  assertEditable(p.status, 'collar program');

  const missing: string[] = [];
  if (!p.yarn_id) missing.push('yarn');
  if (!(Number(p.expected_pcs) > 0)) missing.push('size-wise planned quantity');
  if (!p.required_date) missing.push('required date');
  if (p.job_work_type === 'JOB_WORK' && !p.vendor_id) missing.push('vendor (job work)');
  if (missing.length) throw BadRequest(`Cannot release — missing: ${missing.join(', ')}`);

  await query(`UPDATE trx_collar_program SET status = 'RELEASED' WHERE id = ?`, [id]);
  res.json({ success: true, data: await loadProgram(id, cid) });
}));

/* ================================================================
   Collar production entry (doc §16.4)
================================================================ */

const productionSchema = z.object({
  program_id: s.idReq(),
  entry_no: s.nullableStr(60),
  production_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  size_id: s.id(),
  shift: s.nullableStr(40),
  planned_pcs: z.coerce.number().int().min(0).default(0),
  produced_pcs: z.coerce.number().int().min(0).default(0),
  rejected_pcs: z.coerce.number().int().min(0).default(0),
  actual_yarn_kg: z.coerce.number().min(0).default(0),
  remarks: s.text(),
});

collarRouter.post('/collar-productions', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = productionSchema.parse(req.body);

  const prog = await queryOne<any>(
    `SELECT * FROM trx_collar_program WHERE id = ? AND company_id = ?`, [body.program_id, cid]);
  if (!prog) throw NotFound('Collar program not found');
  assertEditable(prog.status, 'collar program');

  if (body.rejected_pcs > body.produced_pcs) {
    throw BadRequest('Rejected pieces cannot exceed produced pieces');
  }
  const goodPcs = body.produced_pcs - body.rejected_pcs;

  const result = await transaction(async (tx) => {
    const entryNo = body.entry_no || await nextDocNumber(tx, cid, 'COLLAR_PROD');
    const r = await txExecute(tx,
      `INSERT INTO trx_collar_production
         (company_id, program_id, entry_no, production_date, size_id, shift,
          planned_pcs, produced_pcs, rejected_pcs, good_pcs, actual_yarn_kg, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, body.program_id, entryNo, body.production_date, body.size_id ?? null,
       body.shift ?? null, body.planned_pcs, body.produced_pcs, body.rejected_pcs,
       goodPcs, body.actual_yarn_kg, body.remarks ?? null, req.user!.id]);

    // Roll the produced pieces up onto the matching size row.
    if (body.size_id) {
      await txExecute(tx,
        `UPDATE trx_collar_program_size SET produced_pcs = produced_pcs + ?
          WHERE program_id = ? AND size_id = ?`, [body.produced_pcs, body.program_id, body.size_id]);
    }
    await txExecute(tx,
      `UPDATE trx_collar_program SET status = 'IN_PROGRESS'
        WHERE id = ? AND status IN ('RELEASED','MATERIAL_ISSUED','RESERVED')`, [body.program_id]);

    return { id: r.insertId, entry_no: entryNo, good_pcs: goodPcs };
  });

  await audit(req, 'trx_collar_production', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: await loadProgram(body.program_id, cid) });
}));

collarRouter.get('/collar-productions', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { program_id } = req.query;
  let where = 'WHERE pr.company_id = ?';
  const params: any[] = [cid];
  if (program_id) { where += ' AND pr.program_id = ?'; params.push(program_id); }
  const rows = await query(
    `SELECT pr.*, sz.size_code, cp.program_no
       FROM trx_collar_production pr
       LEFT JOIN mst_size sz ON sz.id = pr.size_id
       LEFT JOIN trx_collar_program cp ON cp.id = pr.program_id
       ${where} ORDER BY pr.id DESC LIMIT 500`, params);
  res.json({ success: true, data: rows });
}));

/* ================================================================
   Collar receipt — finished collars into stock (doc §16.5, §17)

   Stock is held in PCS. The yarn KG that produced those pieces is kept
   alongside as a costing reference only, so nothing ever converts one
   into the other with a fixed factor.
================================================================ */

const receiptSchema = z.object({
  program_id: s.idReq(),
  production_id: s.id(),
  receipt_no: s.nullableStr(60),
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  size_id: s.id(),
  size_code: s.nullableStr(40),
  received_pcs: z.coerce.number().int().min(0).default(0),
  rejected_pcs: z.coerce.number().int().min(0).default(0),
  yarn_kg_ref: z.coerce.number().min(0).default(0),
  warehouse_id: s.idReq(),
  qc_status: z.enum(['PENDING', 'PASSED', 'HOLD', 'REJECTED']).default('PENDING'),
  post_stock: z.coerce.boolean().default(false),
  remarks: s.text(),
});

collarRouter.post('/collar-receipts', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = receiptSchema.parse(req.body);

  const prog = await queryOne<any>(
    `SELECT * FROM trx_collar_program WHERE id = ? AND company_id = ?`, [body.program_id, cid]);
  if (!prog) throw NotFound('Collar program not found');
  assertEditable(prog.status, 'collar program');

  if (body.rejected_pcs > body.received_pcs) {
    throw BadRequest('Rejected pieces cannot exceed received pieces');
  }
  // Doc §21 puts QC before stock, so only passed pieces may be posted.
  if (body.post_stock && body.qc_status !== 'PASSED') {
    throw BadRequest('Collars can only be posted to stock once QC status is PASSED');
  }

  // Never receive more than was actually produced on this program.
  const produced = await queryOne<{ n: number }>(
    `SELECT COALESCE(SUM(good_pcs), 0) AS n FROM trx_collar_production WHERE program_id = ?`,
    [body.program_id]);
  const alreadyReceived = await queryOne<{ n: number }>(
    `SELECT COALESCE(SUM(good_pcs), 0) AS n FROM trx_collar_receipt WHERE program_id = ?`,
    [body.program_id]);
  const goodPcs = body.received_pcs - body.rejected_pcs;
  const available = Number(produced?.n ?? 0) - Number(alreadyReceived?.n ?? 0);
  if (goodPcs > available) {
    throw BadRequest(
      `Cannot receive ${goodPcs} pcs — only ${available} pcs of good production remain unreceived ` +
      `(${produced?.n ?? 0} produced, ${alreadyReceived?.n ?? 0} already received).`);
  }

  const result = await transaction(async (tx) => {
    const receiptNo = body.receipt_no || await nextDocNumber(tx, cid, 'COLLAR_RECEIPT');

    const r = await txExecute(tx,
      `INSERT INTO trx_collar_receipt
         (company_id, receipt_no, receipt_date, program_id, production_id, size_id, size_code,
          received_pcs, rejected_pcs, good_pcs, yarn_kg_ref, warehouse_id,
          qc_status, is_stock_posted, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, body.receipt_date, body.program_id, body.production_id ?? null,
       body.size_id ?? null, body.size_code ?? null, body.received_pcs, body.rejected_pcs,
       goodPcs, body.yarn_kg_ref, body.warehouse_id, body.qc_status,
       body.post_stock ? 1 : 0, body.remarks ?? null, req.user!.id]);
    const receiptId = r.insertId;

    if (body.post_stock) {
      // Collar stock is counted in PIECES (doc §16.5), so the ledger entry
      // carries PCS as its UOM — the yarn KG stays a reference on the receipt.
      await postLedger(tx, {
        companyId: cid, warehouseId: body.warehouse_id, materialType: 'WIP',
        txnType: 'PRODUCTION_IN', refType: 'COLLAR_RECEIPT', refId: receiptId,
        qtyIn: goodPcs, uomId: UOM_PCS, createdBy: req.user!.id,
      });
    }

    await txExecute(tx,
      `UPDATE trx_collar_program
          SET received_pcs = received_pcs + ?,
              status = CASE WHEN ? THEN 'STOCK_POSTED' ELSE 'OUTPUT_RECEIPT' END
        WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED')`,
      [goodPcs, body.post_stock ? 1 : 0, body.program_id]);

    return { id: receiptId, receipt_no: receiptNo, good_pcs: goodPcs };
  });

  await audit(req, 'trx_collar_receipt', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

collarRouter.get('/collar-receipts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { program_id } = req.query;
  let where = 'WHERE rc.company_id = ?';
  const params: any[] = [cid];
  if (program_id) { where += ' AND rc.program_id = ?'; params.push(program_id); }
  const rows = await query(
    `SELECT rc.*, cp.program_no, sz.size_code AS size_master_code, w.warehouse_name
       FROM trx_collar_receipt rc
       LEFT JOIN trx_collar_program cp ON cp.id = rc.program_id
       LEFT JOIN mst_size sz ON sz.id = rc.size_id
       LEFT JOIN mst_warehouse w ON w.id = rc.warehouse_id
       ${where} ORDER BY rc.id DESC LIMIT 500`, params);
  res.json({ success: true, data: rows });
}));

/** Post a collar receipt to stock once its QC has passed. */
collarRouter.post('/collar-receipts/:id/post-stock', requirePermission('PROCESS.PRODUCTION'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const rc = await queryOne<any>(
    `SELECT * FROM trx_collar_receipt WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!rc) throw NotFound('Collar receipt not found');
  if (rc.is_stock_posted) throw BadRequest('Stock has already been posted for this receipt');
  if (rc.qc_status !== 'PASSED') throw BadRequest('QC must be PASSED before stock can be posted');

  await transaction(async (tx) => {
    await postLedger(tx, {
      companyId: cid, warehouseId: rc.warehouse_id, materialType: 'WIP',
      txnType: 'PRODUCTION_IN', refType: 'COLLAR_RECEIPT', refId: id,
      qtyIn: Number(rc.good_pcs), uomId: UOM_PCS, createdBy: req.user!.id,
    });
    await txExecute(tx, `UPDATE trx_collar_receipt SET is_stock_posted = 1 WHERE id = ?`, [id]);
    await txExecute(tx,
      `UPDATE trx_collar_program SET status = 'STOCK_POSTED'
        WHERE id = ? AND status NOT IN ('COMPLETED','CANCELLED')`, [rc.program_id]);
  });

  await audit(req, 'trx_collar_receipt', id, 'UPDATE', rc, { is_stock_posted: 1 });
  res.json({ success: true, message: 'Collar stock posted in PCS' });
}));

/** Collar stock on hand, in pieces, per program (doc §16.5). */
collarRouter.get('/collar-stock', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT cp.id AS program_id, cp.program_no, cp.collar_type, cp.colour,
            st.style_code, y.yarn_code,
            cp.expected_pcs AS planned_pcs,
            COALESCE(SUM(rc.good_pcs), 0) AS in_stock_pcs,
            COALESCE(SUM(rc.yarn_kg_ref), 0) AS yarn_kg_reference,
            CASE WHEN SUM(rc.good_pcs) > 0
                 THEN ROUND(SUM(rc.yarn_kg_ref) * 1000 / SUM(rc.good_pcs), 3) END AS actual_gm_pc
       FROM trx_collar_program cp
       LEFT JOIN trx_collar_receipt rc
              ON rc.program_id = cp.id AND rc.is_stock_posted = 1
       LEFT JOIN mst_style st ON st.id = cp.style_id
       LEFT JOIN mst_yarn y ON y.id = cp.yarn_id
      WHERE cp.company_id = ?
      GROUP BY cp.id
     HAVING in_stock_pcs > 0
      ORDER BY cp.id DESC`, [cid]);
  res.json({ success: true, data: rows });
}));

export default collarRouter;
