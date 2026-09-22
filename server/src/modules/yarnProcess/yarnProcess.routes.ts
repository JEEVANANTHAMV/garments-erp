import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { txResolvePartName } from '../../core/partName.js';
import {
  PROCESS_STATUSES, assertEditable, checkStock, reserveYarn, consumeReservation,
  postLedger, yarnStockOnHand, yarnReservedQty, UOM_KG,
} from '../../core/processEngine.js';

/**
 * Yarn Dyeing (doc §7), Winding (doc §8) and Twisting (doc §9).
 *
 * All three share one header table and one engine — the document asks for a
 * common process architecture behind separate screens (doc §5, §29). Each
 * process keeps its own attribute table and its own endpoints so the UIs stay
 * process-specific.
 *
 * Excluded per business instruction: dye recipe master, machine allocation.
 */
export const yarnProcessRouter = Router();

const PROCESS_TYPES = ['YARN_DYEING', 'WINDING', 'TWISTING'] as const;
type ProcessType = (typeof PROCESS_TYPES)[number];

/** Doc type used for the auto number of each process. */
const DOC_TYPE: Record<ProcessType, string> = {
  YARN_DYEING: 'YARN_DYEING',
  WINDING: 'WINDING',
  TWISTING: 'TWISTING',
};

const dyeingSchema = z.object({
  colour_code: s.nullableStr(60), colour_name: s.nullableStr(120),
  shade_code: s.nullableStr(60), shade_name: s.nullableStr(120),
  batch_no: s.nullableStr(60), temperature: s.nullableStr(40),
  duration_min: z.coerce.number().int().min(0).nullable().optional(),
  liquor_ratio: s.nullableStr(40),
});

const windingSchema = z.object({
  cone_type: s.nullableStr(60),
  target_cone_wt_kg: z.coerce.number().min(0).nullable().optional(),
  speed_rpm: s.nullableStr(40), operator: s.nullableStr(120), shift: s.nullableStr(40),
});

const twistingSchema = z.object({
  twist_type: z.enum(['S', 'Z']).nullable().optional(),
  ply: z.coerce.number().int().min(1).nullable().optional(),
  target_count: s.nullableStr(40),
  tpi: z.coerce.number().min(0).nullable().optional(),
  spindle_speed: s.nullableStr(40), operator: s.nullableStr(120), shift: s.nullableStr(40),
});

const processSchema = z.object({
  process_no: s.nullableStr(60),
  process_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  process_type: z.enum(PROCESS_TYPES),
  route_id: s.id(), route_seq_no: z.coerce.number().int().nullable().optional(),
  so_id: s.id(), so_line_id: s.id(),
  io_no: s.nullableStr(60), buyer_po_no: s.nullableStr(60),
  style_id: s.id(),
  part_name: s.nullableStr(50),
  yarn_id: s.id(),
  input_qty_kg: z.coerce.number().min(0).default(0),
  expected_loss_pct: z.coerce.number().min(0).max(100).default(0),
  required_date: s.date(),
  priority: z.enum(['NORMAL', 'URGENT', 'HOLD']).default('NORMAL'),
  job_work_type: z.enum(['INTERNAL', 'JOB_WORK']).default('INTERNAL'),
  vendor_id: s.id(), warehouse_id: s.id(),
  status: z.enum(PROCESS_STATUSES).default('DRAFT'),
  remarks: s.text(),
  dyeing: dyeingSchema.optional(),
  winding: windingSchema.optional(),
  twisting: twistingSchema.optional(),
});

/** Partial variant with no defaults, so an omitted key never resets a column. */
const processUpdateSchema = z.object({
  process_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  route_id: s.id(), route_seq_no: z.coerce.number().int().nullable().optional(),
  so_id: s.id(), so_line_id: s.id(),
  io_no: s.nullableStr(60), buyer_po_no: s.nullableStr(60),
  style_id: s.id(), part_name: s.nullableStr(50), yarn_id: s.id(),
  input_qty_kg: z.coerce.number().min(0).optional(),
  expected_loss_pct: z.coerce.number().min(0).max(100).optional(),
  required_date: s.date(),
  priority: z.enum(['NORMAL', 'URGENT', 'HOLD']).optional(),
  job_work_type: z.enum(['INTERNAL', 'JOB_WORK']).optional(),
  vendor_id: s.id(), warehouse_id: s.id(),
  status: z.enum(PROCESS_STATUSES).optional(),
  remarks: s.text(),
  dyeing: dyeingSchema.optional(),
  winding: windingSchema.optional(),
  twisting: twistingSchema.optional(),
});

/** Expected output after planning loss (doc §7.1). */
const expectedOutput = (inputKg: number, lossPct: number) =>
  Math.round(inputKg * (1 - lossPct / 100) * 1000) / 1000;

async function loadProcess(id: number, cid: number) {
  const p = await queryOne<any>(
    `SELECT yp.*, y.yarn_code, y.yarn_name, y.count_value,
            st.style_code, st.style_name, pa.party_name AS vendor_name,
            r.route_code, r.route_name, w.warehouse_name
       FROM trx_yarn_process yp
       LEFT JOIN mst_yarn y ON y.id = yp.yarn_id
       LEFT JOIN mst_style st ON st.id = yp.style_id
       LEFT JOIN mst_party pa ON pa.id = yp.vendor_id
       LEFT JOIN mst_process_route r ON r.id = yp.route_id
       LEFT JOIN mst_warehouse w ON w.id = yp.warehouse_id
      WHERE yp.id = ? AND yp.company_id = ?`, [id, cid]);
  if (!p) return null;

  if (p.process_type === 'YARN_DYEING') {
    p.dyeing = await queryOne(`SELECT * FROM trx_yarn_process_dyeing WHERE process_id = ?`, [id]);
  } else if (p.process_type === 'WINDING') {
    p.winding = await queryOne(`SELECT * FROM trx_yarn_process_winding WHERE process_id = ?`, [id]);
  } else if (p.process_type === 'TWISTING') {
    p.twisting = await queryOne(`SELECT * FROM trx_yarn_process_twisting WHERE process_id = ?`, [id]);
  }

  p.reservations = await query(
    `SELECT r.*, y.yarn_code, y.yarn_name
       FROM trx_process_reservation r
       LEFT JOIN mst_yarn y ON y.id = r.yarn_id
      WHERE r.src_type = 'YARN_PROCESS' AND r.src_id = ?`, [id]);
  p.issues = await query(
    `SELECT i.*, y.yarn_code, y.yarn_name
       FROM trx_process_issue i
       LEFT JOIN mst_yarn y ON y.id = i.yarn_id
      WHERE i.src_type = 'YARN_PROCESS' AND i.src_id = ? ORDER BY i.id`, [id]);
  p.receipts = await query(
    `SELECT * FROM trx_process_receipt
      WHERE src_type = 'YARN_PROCESS' AND src_id = ? ORDER BY id`, [id]);
  for (const rc of p.receipts as any[]) {
    if (p.process_type === 'WINDING') {
      rc.cones = await query(`SELECT * FROM trx_winding_cone WHERE receipt_id = ? ORDER BY id`, [rc.id]);
    }
  }
  p.qc = await query(
    `SELECT * FROM trx_process_qc
      WHERE src_type = 'YARN_PROCESS' AND src_id = ? ORDER BY id`, [id]);
  for (const q of p.qc as any[]) {
    q.lines = await query(`SELECT * FROM trx_process_qc_line WHERE qc_id = ? ORDER BY id`, [q.id]);
  }
  return p;
}

/* ---------------- list ---------------- */
yarnProcessRouter.get('/yarn-processes', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { process_type, status, yarn_id, io_no, q } = req.query;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 25)));

  let where = 'WHERE yp.company_id = ?';
  const params: any[] = [cid];
  if (process_type) { where += ' AND yp.process_type = ?'; params.push(process_type); }
  if (status) { where += ' AND yp.status = ?'; params.push(status); }
  if (yarn_id) { where += ' AND yp.yarn_id = ?'; params.push(yarn_id); }
  if (io_no) { where += ' AND yp.io_no LIKE ?'; params.push(`%${io_no}%`); }
  if (q) { where += ' AND (yp.process_no LIKE ? OR yp.io_no LIKE ? OR yp.buyer_po_no LIKE ?)';
           params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const offset = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    query(
      `SELECT yp.*, y.yarn_code, y.yarn_name, st.style_code, pa.party_name AS vendor_name,
              COALESCE((SELECT SUM(i.issued_qty_kg) FROM trx_process_issue i
                         WHERE i.src_type='YARN_PROCESS' AND i.src_id=yp.id),0) AS issued_kg,
              COALESCE((SELECT SUM(rc.output_qty) FROM trx_process_receipt rc
                         WHERE rc.src_type='YARN_PROCESS' AND rc.src_id=yp.id),0) AS received_qty
         FROM trx_yarn_process yp
         LEFT JOIN mst_yarn y ON y.id = yp.yarn_id
         LEFT JOIN mst_style st ON st.id = yp.style_id
         LEFT JOIN mst_party pa ON pa.id = yp.vendor_id
         ${where}
        ORDER BY yp.id DESC LIMIT ${pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM trx_yarn_process yp ${where}`, params),
  ]);

  res.json({
    success: true, data: rows,
    pagination: { page, pageSize, total: total?.total ?? 0,
                  totalPages: Math.ceil((total?.total ?? 0) / pageSize) },
  });
}));

yarnProcessRouter.get('/yarn-processes/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const p = await loadProcess(Number(req.params.id), req.user!.companyId);
  if (!p) throw NotFound('Process not found');
  res.json({ success: true, data: p });
}));

/* ---------------- create ---------------- */
yarnProcessRouter.post('/yarn-processes', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = processSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const processNo = body.process_no || await nextDocNumber(tx, cid, DOC_TYPE[body.process_type]);
    const partName = await txResolvePartName(tx, body.so_line_id, body.part_name);
    const expOut = expectedOutput(body.input_qty_kg, body.expected_loss_pct);

    const r = await txExecute(tx,
      `INSERT INTO trx_yarn_process
         (company_id, process_no, process_date, process_type, route_id, route_seq_no,
          so_id, so_line_id, io_no, buyer_po_no, style_id, part_name, yarn_id,
          input_qty_kg, expected_loss_pct, expected_output, required_date, priority,
          job_work_type, vendor_id, warehouse_id, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, processNo, body.process_date, body.process_type, body.route_id ?? null,
       body.route_seq_no ?? null, body.so_id ?? null, body.so_line_id ?? null,
       body.io_no ?? null, body.buyer_po_no ?? null, body.style_id ?? null, partName,
       body.yarn_id ?? null, body.input_qty_kg, body.expected_loss_pct, expOut,
       body.required_date ?? null, body.priority, body.job_work_type,
       body.vendor_id ?? null, body.warehouse_id ?? null, body.status, body.remarks ?? null, uid]);
    const id = r.insertId;

    if (body.process_type === 'YARN_DYEING' && body.dyeing) {
      const d = body.dyeing;
      await txExecute(tx,
        `INSERT INTO trx_yarn_process_dyeing
           (process_id, colour_code, colour_name, shade_code, shade_name, batch_no,
            temperature, duration_min, liquor_ratio)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, d.colour_code ?? null, d.colour_name ?? null, d.shade_code ?? null,
         d.shade_name ?? null, d.batch_no ?? null, d.temperature ?? null,
         d.duration_min ?? null, d.liquor_ratio ?? null]);
    }
    if (body.process_type === 'WINDING' && body.winding) {
      const w = body.winding;
      const coneCount = w.target_cone_wt_kg && Number(w.target_cone_wt_kg) > 0
        ? Math.floor(body.input_qty_kg / Number(w.target_cone_wt_kg)) : null;
      await txExecute(tx,
        `INSERT INTO trx_yarn_process_winding
           (process_id, cone_type, target_cone_wt_kg, target_cone_count, speed_rpm, operator, shift)
         VALUES (?,?,?,?,?,?,?)`,
        [id, w.cone_type ?? null, w.target_cone_wt_kg ?? null, coneCount,
         w.speed_rpm ?? null, w.operator ?? null, w.shift ?? null]);
    }
    if (body.process_type === 'TWISTING' && body.twisting) {
      const t = body.twisting;
      await txExecute(tx,
        `INSERT INTO trx_yarn_process_twisting
           (process_id, twist_type, ply, target_count, tpi, spindle_speed, operator, shift)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, t.twist_type ?? null, t.ply ?? null, t.target_count ?? null, t.tpi ?? null,
         t.spindle_speed ?? null, t.operator ?? null, t.shift ?? null]);
    }

    return { id, process_no: processNo };
  });

  await audit(req, 'trx_yarn_process', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: await loadProcess(result.id, cid) });
}));

/* ---------------- update ---------------- */
yarnProcessRouter.put('/yarn-processes/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = processUpdateSchema.parse(req.body);

  const existing = await queryOne<any>(
    `SELECT * FROM trx_yarn_process WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!existing) throw NotFound('Process not found');
  if (body.status !== existing.status) assertEditable(existing.status, 'process');

  await transaction(async (tx) => {
    const FIELDS = [
      'process_date', 'route_id', 'route_seq_no', 'so_id', 'so_line_id', 'io_no',
      'buyer_po_no', 'style_id', 'part_name', 'yarn_id', 'input_qty_kg',
      'expected_loss_pct', 'required_date', 'priority', 'job_work_type',
      'vendor_id', 'warehouse_id', 'status', 'remarks',
    ] as const;
    const sets: string[] = []; const vals: any[] = [];
    for (const f of FIELDS) {
      const v = (body as Record<string, any>)[f];
      if (v === undefined) continue;
      sets.push(`${f} = ?`); vals.push(v);
    }

    // The Sales Order line owns the part when the process is linked to one.
    if (body.so_line_id !== undefined) {
      const linked = await txResolvePartName(tx, body.so_line_id, body.part_name);
      if (linked) {
        const i = sets.indexOf('part_name = ?');
        if (i >= 0) vals[i] = linked; else { sets.push('part_name = ?'); vals.push(linked); }
      }
    }

    // Keep expected output aligned whenever input or loss changes.
    const newInput = body.input_qty_kg ?? Number(existing.input_qty_kg);
    const newLoss = body.expected_loss_pct ?? Number(existing.expected_loss_pct);
    if (body.input_qty_kg !== undefined || body.expected_loss_pct !== undefined) {
      sets.push('expected_output = ?'); vals.push(expectedOutput(newInput, newLoss));
    }

    if (sets.length) {
      await txExecute(tx,
        `UPDATE trx_yarn_process SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`,
        [...vals, id, cid]);
    }

    if (body.dyeing) {
      const d = body.dyeing;
      await txExecute(tx,
        `INSERT INTO trx_yarn_process_dyeing
           (process_id, colour_code, colour_name, shade_code, shade_name, batch_no,
            temperature, duration_min, liquor_ratio)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE colour_code=VALUES(colour_code), colour_name=VALUES(colour_name),
           shade_code=VALUES(shade_code), shade_name=VALUES(shade_name), batch_no=VALUES(batch_no),
           temperature=VALUES(temperature), duration_min=VALUES(duration_min),
           liquor_ratio=VALUES(liquor_ratio)`,
        [id, d.colour_code ?? null, d.colour_name ?? null, d.shade_code ?? null,
         d.shade_name ?? null, d.batch_no ?? null, d.temperature ?? null,
         d.duration_min ?? null, d.liquor_ratio ?? null]);
    }
    if (body.winding) {
      const w = body.winding;
      const coneCount = w.target_cone_wt_kg && Number(w.target_cone_wt_kg) > 0
        ? Math.floor(newInput / Number(w.target_cone_wt_kg)) : null;
      await txExecute(tx,
        `INSERT INTO trx_yarn_process_winding
           (process_id, cone_type, target_cone_wt_kg, target_cone_count, speed_rpm, operator, shift)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE cone_type=VALUES(cone_type),
           target_cone_wt_kg=VALUES(target_cone_wt_kg), target_cone_count=VALUES(target_cone_count),
           speed_rpm=VALUES(speed_rpm), operator=VALUES(operator), shift=VALUES(shift)`,
        [id, w.cone_type ?? null, w.target_cone_wt_kg ?? null, coneCount,
         w.speed_rpm ?? null, w.operator ?? null, w.shift ?? null]);
    }
    if (body.twisting) {
      const t = body.twisting;
      await txExecute(tx,
        `INSERT INTO trx_yarn_process_twisting
           (process_id, twist_type, ply, target_count, tpi, spindle_speed, operator, shift)
         VALUES (?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE twist_type=VALUES(twist_type), ply=VALUES(ply),
           target_count=VALUES(target_count), tpi=VALUES(tpi),
           spindle_speed=VALUES(spindle_speed), operator=VALUES(operator), shift=VALUES(shift)`,
        [id, t.twist_type ?? null, t.ply ?? null, t.target_count ?? null, t.tpi ?? null,
         t.spindle_speed ?? null, t.operator ?? null, t.shift ?? null]);
    }
  });

  await audit(req, 'trx_yarn_process', id, 'UPDATE', existing, body);
  res.json({ success: true, data: await loadProcess(id, cid) });
}));

yarnProcessRouter.delete('/yarn-processes/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const p = await queryOne<any>(
    `SELECT id, status FROM trx_yarn_process WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!p) throw NotFound('Process not found');
  if (!['DRAFT', 'CANCELLED'].includes(p.status)) {
    throw BadRequest('Only DRAFT or CANCELLED processes can be deleted');
  }
  await query(`DELETE FROM trx_yarn_process WHERE id = ?`, [id]);
  await audit(req, 'trx_yarn_process', id, 'DELETE', p);
  res.json({ success: true, message: 'Process deleted' });
}));

/* ---------------- stock check (doc §21) ---------------- */
yarnProcessRouter.post('/yarn-processes/:id/check-stock', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const p = await queryOne<any>(
    `SELECT * FROM trx_yarn_process WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!p) throw NotFound('Process not found');
  if (!p.yarn_id) throw BadRequest('Select a yarn before running the stock check');

  const rows = await checkStock(
    cid, [{ yarn_id: p.yarn_id, required_qty_kg: Number(p.input_qty_kg) }], p.warehouse_id);

  if (['DRAFT'].includes(p.status)) {
    await query(`UPDATE trx_yarn_process SET status = 'STOCK_CHECK' WHERE id = ?`, [id]);
  }
  res.json({ success: true, data: rows });
}));

/* ---------------- reserve (doc §12) ---------------- */
yarnProcessRouter.post('/yarn-processes/:id/reserve', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const p = await queryOne<any>(
    `SELECT * FROM trx_yarn_process WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!p) throw NotFound('Process not found');
  assertEditable(p.status, 'process');
  if (!p.yarn_id) throw BadRequest('Select a yarn before reserving');

  const qty = req.body?.reserved_qty_kg !== undefined
    ? Number(req.body.reserved_qty_kg) : Number(p.input_qty_kg);
  if (!(qty > 0)) throw BadRequest('Reserved quantity must be greater than zero');

  const result = await transaction(async (tx) => {
    const resId = await reserveYarn(tx, {
      companyId: cid, srcType: 'YARN_PROCESS', srcId: id,
      yarnId: p.yarn_id, requiredQtyKg: Number(p.input_qty_kg),
      reservedQtyKg: qty, createdBy: req.user!.id,
    });
    await txExecute(tx,
      `UPDATE trx_yarn_process SET status = 'RESERVED'
        WHERE id = ? AND status IN ('DRAFT','STOCK_CHECK')`, [id]);
    return { reservation_id: resId };
  });

  await audit(req, 'trx_process_reservation', result.reservation_id, 'INSERT', undefined, result);
  res.json({ success: true, data: await loadProcess(id, cid) });
}));

/* ---------------- release (doc §21) ---------------- */
yarnProcessRouter.post('/yarn-processes/:id/release', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const p = await queryOne<any>(
    `SELECT * FROM trx_yarn_process WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!p) throw NotFound('Process not found');
  assertEditable(p.status, 'process');

  // Doc §22: a program cannot be released without its mandatory details.
  const missing: string[] = [];
  if (!p.yarn_id) missing.push('yarn');
  if (!(Number(p.input_qty_kg) > 0)) missing.push('input quantity');
  if (!p.required_date) missing.push('required date');
  if (p.job_work_type === 'JOB_WORK' && !p.vendor_id) missing.push('vendor (job work)');
  if (missing.length) throw BadRequest(`Cannot release — missing: ${missing.join(', ')}`);

  await query(`UPDATE trx_yarn_process SET status = 'RELEASED' WHERE id = ?`, [id]);
  await audit(req, 'trx_yarn_process', id, 'UPDATE', p, { status: 'RELEASED' });
  res.json({ success: true, data: await loadProcess(id, cid) });
}));

export default yarnProcessRouter;
