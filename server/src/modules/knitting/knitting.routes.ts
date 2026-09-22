import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

/* ================================================================
   KNITTING PROGRAM — schemas
================================================================ */

const PARTS = ['TOP', 'BOTTOM', 'COLLAR', 'CUFF', 'FOLDING', 'OTHER'] as const;
const KNITTING_TYPES = ['SOLID', 'STRIPE', 'FEEDER_STRIPE', 'ENGINEERED_STRIPE', 'MULTI_YARN', 'OTHER'] as const;
const KP_STATUS = [
  'DRAFT', 'STOCK_CHECK', 'RESERVED', 'RELEASED',
  'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED',
  'OUTPUT_RECEIPT', 'COMPLETED', 'CANCELLED',
] as const;

const kpYarnSchema = z.object({
  id: z.coerce.number().int().optional(),
  seq_no: z.coerce.number().int().min(1).default(1),
  yarn_id: s.id(),
  yarn_name_manual: s.nullableStr(150),
  count_value: s.nullableStr(30),
  colour: s.nullableStr(80),
  yarn_po_no: s.nullableStr(80),
  yarn_lot_no: s.nullableStr(80),
  planning_ratio_pct: z.coerce.number().min(0).max(100).nullable().optional(),
  planned_qty_kg: z.coerce.number().min(0).default(0),
  reserved_qty_kg: z.coerce.number().min(0).default(0),
  issued_qty_kg: z.coerce.number().min(0).default(0),
});

const kpStripeSchema = z.object({
  id: z.coerce.number().int().optional(),
  seq_no: z.coerce.number().int().min(1).default(1),
  program_yarn_id: s.id(),
  yarn_label: s.nullableStr(80),
  colour: s.nullableStr(80),
  courses: z.coerce.number().int().min(0).default(0),
  notes: s.nullableStr(255),
});

const kpSchema = z.object({
  program_no: s.nullableStr(60),
  program_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  so_id: s.id(),
  io_no: s.nullableStr(60),
  buyer_po_no: s.nullableStr(60),
  style_id: s.id(),
  part_name: z.enum(PARTS).nullable().optional(),
  fabric_id: s.id(),
  fabric_type: s.nullableStr(80),
  knitting_type: z.enum(KNITTING_TYPES).default('SOLID'),
  gsm: s.nullableStr(40),
  dia: s.nullableStr(40),
  gauge: s.nullableStr(40),
  loop_length: s.nullableStr(40),
  required_qty_kg: z.coerce.number().min(0).default(0),
  required_date: s.date(),
  job_work_type: z.enum(['INTERNAL', 'JOB_WORK']).default('INTERNAL'),
  vendor_id: s.id(),
  status: z.enum(KP_STATUS).default('DRAFT'),
  remarks: s.text(),
  yarns: z.array(kpYarnSchema).default([]),
  stripes: z.array(kpStripeSchema).default([]),
});

/**
 * Update schema for PUT. Built field-by-field WITHOUT `.default()` so that an
 * omitted key stays `undefined` rather than being silently reset to a default
 * (a `.partial()` of kpSchema would still apply defaults, which would reset
 * knitting_type to SOLID, required_qty_kg to 0 and wipe the yarn/stripe rows).
 */
const kpUpdateSchema = z.object({
  program_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  so_id: s.id(),
  io_no: s.nullableStr(60),
  buyer_po_no: s.nullableStr(60),
  style_id: s.id(),
  part_name: z.enum(PARTS).nullable().optional(),
  fabric_id: s.id(),
  fabric_type: s.nullableStr(80),
  knitting_type: z.enum(KNITTING_TYPES).optional(),
  gsm: s.nullableStr(40),
  dia: s.nullableStr(40),
  gauge: s.nullableStr(40),
  loop_length: s.nullableStr(40),
  required_qty_kg: z.coerce.number().min(0).optional(),
  required_date: s.date(),
  job_work_type: z.enum(['INTERNAL', 'JOB_WORK']).optional(),
  vendor_id: s.id(),
  status: z.enum(KP_STATUS).optional(),
  remarks: s.text(),
  yarns: z.array(kpYarnSchema).optional(),
  stripes: z.array(kpStripeSchema).optional(),
});

const kpIssueSchema = z.object({
  program_id: s.idReq(),
  program_yarn_id: s.id(),
  issue_no: s.nullableStr(60),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  yarn_id: s.id(),
  yarn_lot_no: s.nullableStr(80),
  yarn_po_no: s.nullableStr(80),
  issued_qty_kg: z.coerce.number().positive(),
  remarks: s.text(),
});

export const knittingRouter = Router();

const kwoSchema = z.object({
  kwo_no: s.nullableStr(50),
  kwo_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.strReq(60),
  customer_po_no: s.nullableStr(60),
  style_id: s.id(),
  sub_process: z.enum(['KNITTING', 'WINDING', 'TWISTING', 'YARN_DYEING', 'COLLAR_KNITTING']).default('KNITTING'),
  vendor_id: s.id(),
  fabric_id: s.id(),
  dia: s.nullableStr(40),
  gsm: s.nullableStr(40),
  gauge: s.nullableStr(40),
  loop_length: s.nullableStr(40),
  planned_fabric_kg: z.coerce.number().min(0).default(0),
  planned_yarn_kg: z.coerce.number().min(0).default(0),
  yarn_lot_no: s.nullableStr(80),
  status: z.enum(['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).default('DRAFT'),
  remarks: s.text(),
});

const yarnIssueSchema = z.object({
  kwo_id: s.idReq(),
  issue_no: s.nullableStr(50),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  yarn_id: s.idReq(),
  yarn_lot_no: s.nullableStr(80),
  bags_cones: z.coerce.number().int().min(0).default(0),
  issued_weight_kg: z.coerce.number().positive(),
  remarks: s.text(),
});

const rollOutputSchema = z.object({
  kwo_id: s.idReq(),
  roll_no: s.strReq(60),
  lot_no: s.strReq(80),
  production_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dia: s.nullableStr(40),
  gsm: s.nullableStr(40),
  meters: z.coerce.number().min(0).default(0),
  weight_kg: z.coerce.number().positive(),
  qc_status: z.enum(['ACCEPTED', 'HOLD', 'REJECTED']).default('ACCEPTED'),
  defect_points: z.coerce.number().int().min(0).default(0),
  rejection_reason: s.nullableStr(255),
});


/* ================================================================
   KNITTING PROGRAM — API Routes
   (Multi-yarn, Stripe Pattern, Yarn Traceability, Yarn Issue)
================================================================ */

async function loadKpDetail(id: number, cid: number) {
  const prog = await queryOne(
    `SELECT kp.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            p.party_name AS vendor_name,
            so.so_no, so.buyer_po_no AS so_buyer_po_no
       FROM trx_knitting_program kp
       LEFT JOIN mst_style st ON st.id = kp.style_id
       LEFT JOIN mst_fabric fab ON fab.id = kp.fabric_id
       LEFT JOIN mst_party p ON p.id = kp.vendor_id
       LEFT JOIN trx_sales_order so ON so.id = kp.so_id
      WHERE kp.id = ? AND kp.company_id = ?`,
    [id, cid]
  );
  if (!prog) return null;

  const yarns = await query(
    `SELECT kpy.*, y.yarn_code, y.yarn_name
       FROM trx_knitting_program_yarns kpy
       LEFT JOIN mst_yarn y ON y.id = kpy.yarn_id
      WHERE kpy.program_id = ? ORDER BY kpy.seq_no ASC`,
    [id]
  );

  const stripes = await query(
    `SELECT kps.*
       FROM trx_knitting_program_stripes kps
      WHERE kps.program_id = ? ORDER BY kps.seq_no ASC`,
    [id]
  );

  const issues = await query(
    `SELECT kpyi.*, y.yarn_name, y.yarn_code
       FROM trx_knitting_program_yarn_issues kpyi
       LEFT JOIN mst_yarn y ON y.id = kpyi.yarn_id
      WHERE kpyi.program_id = ? ORDER BY kpyi.id ASC`,
    [id]
  );

  return { ...prog, yarns, stripes, issues };
}

/** GET /knitting/programs — List knitting programs */
knittingRouter.get('/knitting/programs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id, part_name, status, knitting_type, q } = req.query;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 25)));

  let where = 'WHERE kp.company_id = ?';
  const params: any[] = [cid];

  if (io_no) { where += ' AND kp.io_no LIKE ?'; params.push(`%${io_no}%`); }
  if (style_id) { where += ' AND kp.style_id = ?'; params.push(style_id); }
  if (part_name) { where += ' AND kp.part_name = ?'; params.push(part_name); }
  if (status) { where += ' AND kp.status = ?'; params.push(status); }
  if (knitting_type) { where += ' AND kp.knitting_type = ?'; params.push(knitting_type); }
  if (q) {
    where += ' AND (kp.program_no LIKE ? OR kp.io_no LIKE ? OR kp.buyer_po_no LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const offset = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    query(
      `SELECT kp.*,
              st.style_code, st.style_name,
              fab.fabric_name, fab.fabric_code,
              p.party_name AS vendor_name,
              COALESCE(SUM(kpy.planned_qty_kg), 0) AS total_planned_yarn_kg,
              COALESCE(SUM(kpy.issued_qty_kg), 0) AS total_issued_yarn_kg,
              COUNT(DISTINCT kpy.id) AS yarn_line_count
         FROM trx_knitting_program kp
         LEFT JOIN mst_style st ON st.id = kp.style_id
         LEFT JOIN mst_fabric fab ON fab.id = kp.fabric_id
         LEFT JOIN mst_party p ON p.id = kp.vendor_id
         LEFT JOIN trx_knitting_program_yarns kpy ON kpy.program_id = kp.id
        ${where}
        GROUP BY kp.id
        ORDER BY kp.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    ),
    queryOne<{ total: number }>(
      `SELECT COUNT(DISTINCT kp.id) AS total FROM trx_knitting_program kp ${where}`,
      params
    ),
  ]);

  res.json({
    success: true,
    data: rows,
    pagination: { page, pageSize, total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / pageSize) },
  });
}));

/** GET /knitting/programs/:id — Detail */
knittingRouter.get('/knitting/programs/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const prog = await loadKpDetail(Number(req.params.id), cid);
  if (!prog) throw NotFound('Knitting program not found');
  res.json({ success: true, data: prog });
}));

/** POST /knitting/programs — Create */
knittingRouter.post('/knitting/programs', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = kpSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const programNo = body.program_no || await nextDocNumber(tx, cid, 'KNP');

    const res2 = await txExecute(
      tx,
      `INSERT INTO trx_knitting_program
         (company_id, program_no, program_date, so_id, io_no, buyer_po_no, style_id,
          part_name, fabric_id, fabric_type, knitting_type, gsm, dia, gauge, loop_length,
          required_qty_kg, required_date, job_work_type, vendor_id, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        cid, programNo, body.program_date, body.so_id ?? null, body.io_no ?? null, body.buyer_po_no ?? null,
        body.style_id ?? null, body.part_name ?? null, body.fabric_id ?? null, body.fabric_type ?? null,
        body.knitting_type, body.gsm ?? null, body.dia ?? null, body.gauge ?? null, body.loop_length ?? null,
        body.required_qty_kg, body.required_date ?? null, body.job_work_type,
        body.vendor_id ?? null, body.status, body.remarks ?? null, uid,
      ]
    );
    const programId = res2.insertId;

    // Insert yarn lines
    for (const yarn of body.yarns) {
      await txExecute(
        tx,
        `INSERT INTO trx_knitting_program_yarns
           (program_id, seq_no, yarn_id, yarn_name_manual, count_value, colour,
            yarn_po_no, yarn_lot_no, planning_ratio_pct, planned_qty_kg, reserved_qty_kg, issued_qty_kg)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          programId, yarn.seq_no, yarn.yarn_id ?? null, yarn.yarn_name_manual ?? null,
          yarn.count_value ?? null, yarn.colour ?? null, yarn.yarn_po_no ?? null,
          yarn.yarn_lot_no ?? null, yarn.planning_ratio_pct ?? null,
          yarn.planned_qty_kg, yarn.reserved_qty_kg, yarn.issued_qty_kg,
        ]
      );
    }

    // Insert stripe lines
    for (const stripe of body.stripes) {
      await txExecute(
        tx,
        `INSERT INTO trx_knitting_program_stripes
           (program_id, seq_no, program_yarn_id, yarn_label, colour, courses, notes)
         VALUES (?,?,?,?,?,?,?)`,
        [
          programId, stripe.seq_no, stripe.program_yarn_id ?? null,
          stripe.yarn_label ?? null, stripe.colour ?? null, stripe.courses, stripe.notes ?? null,
        ]
      );
    }

    return { id: programId, program_no: programNo };
  });

  await audit(req, 'trx_knitting_program', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** PUT /knitting/programs/:id — Update */
knittingRouter.put('/knitting/programs/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = kpUpdateSchema.parse(req.body);

  const existing = await queryOne(
    'SELECT id, program_no, status FROM trx_knitting_program WHERE id = ? AND company_id = ?',
    [id, cid]
  );
  if (!existing) throw NotFound('Knitting program not found');
  if (['COMPLETED', 'CANCELLED'].includes(existing.status) && body.status !== existing.status) {
    throw BadRequest('Completed / Cancelled programs cannot be edited directly. Create a revision.');
  }

  await transaction(async (tx) => {
    await txExecute(
      tx,
      `UPDATE trx_knitting_program
          SET program_date   = COALESCE(?, program_date),
              so_id          = COALESCE(?, so_id),
              io_no          = COALESCE(?, io_no),
              buyer_po_no    = COALESCE(?, buyer_po_no),
              style_id       = COALESCE(?, style_id),
              part_name      = COALESCE(?, part_name),
              fabric_id      = COALESCE(?, fabric_id),
              fabric_type    = COALESCE(?, fabric_type),
              knitting_type  = COALESCE(?, knitting_type),
              gsm            = COALESCE(?, gsm),
              dia            = COALESCE(?, dia),
              gauge          = COALESCE(?, gauge),
              loop_length    = COALESCE(?, loop_length),
              required_qty_kg = COALESCE(?, required_qty_kg),
              required_date  = COALESCE(?, required_date),
              job_work_type  = COALESCE(?, job_work_type),
              vendor_id      = COALESCE(?, vendor_id),
              status         = COALESCE(?, status),
              remarks        = COALESCE(?, remarks)
        WHERE id = ? AND company_id = ?`,
      [
        // mysql2 prepared statements reject `undefined`; a partial() body leaves
        // every omitted key undefined, so normalise to null (COALESCE keeps the
        // existing column value for nulls).
        body.program_date ?? null, body.so_id ?? null, body.io_no ?? null,
        body.buyer_po_no ?? null, body.style_id ?? null,
        body.part_name ?? null, body.fabric_id ?? null, body.fabric_type ?? null,
        body.knitting_type ?? null,
        body.gsm ?? null, body.dia ?? null, body.gauge ?? null, body.loop_length ?? null,
        body.required_qty_kg ?? null, body.required_date ?? null,
        body.job_work_type ?? null, body.vendor_id ?? null,
        body.status ?? null, body.remarks ?? null, id, cid,
      ]
    );

    // Replace yarn lines if provided
    if (body.yarns !== undefined) {
      await txExecute(tx, 'DELETE FROM trx_knitting_program_yarns WHERE program_id = ?', [id]);
      for (const yarn of body.yarns ?? []) {
        await txExecute(
          tx,
          `INSERT INTO trx_knitting_program_yarns
             (program_id, seq_no, yarn_id, yarn_name_manual, count_value, colour,
              yarn_po_no, yarn_lot_no, planning_ratio_pct, planned_qty_kg, reserved_qty_kg, issued_qty_kg)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id, yarn.seq_no, yarn.yarn_id ?? null, yarn.yarn_name_manual ?? null,
            yarn.count_value ?? null, yarn.colour ?? null, yarn.yarn_po_no ?? null,
            yarn.yarn_lot_no ?? null, yarn.planning_ratio_pct ?? null,
            yarn.planned_qty_kg, yarn.reserved_qty_kg, yarn.issued_qty_kg,
          ]
        );
      }
    }

    // Replace stripe lines if provided
    if (body.stripes !== undefined) {
      await txExecute(tx, 'DELETE FROM trx_knitting_program_stripes WHERE program_id = ?', [id]);
      for (const stripe of body.stripes ?? []) {
        await txExecute(
          tx,
          `INSERT INTO trx_knitting_program_stripes
             (program_id, seq_no, program_yarn_id, yarn_label, colour, courses, notes)
           VALUES (?,?,?,?,?,?,?)`,
          [
            id, stripe.seq_no, stripe.program_yarn_id ?? null,
            stripe.yarn_label ?? null, stripe.colour ?? null, stripe.courses, stripe.notes ?? null,
          ]
        );
      }
    }
  });

  await audit(req, 'trx_knitting_program', id, 'UPDATE', existing, body);
  const updated = await loadKpDetail(id, cid);
  res.json({ success: true, data: updated });
}));

/** DELETE /knitting/programs/:id */
knittingRouter.delete('/knitting/programs/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const prog = await queryOne(
    'SELECT id, status FROM trx_knitting_program WHERE id = ? AND company_id = ?',
    [id, cid]
  );
  if (!prog) throw NotFound('Knitting program not found');
  if (!['DRAFT', 'CANCELLED'].includes(prog.status)) {
    throw BadRequest('Only DRAFT or CANCELLED programs can be deleted');
  }
  await query('DELETE FROM trx_knitting_program WHERE id = ?', [id]);
  await audit(req, 'trx_knitting_program', id, 'DELETE', prog);
  res.json({ success: true, message: 'Knitting program deleted' });
}));

/** POST /knitting/programs/yarn-issue — Issue yarn against a Knitting Program */
knittingRouter.post('/knitting/programs/yarn-issue', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = kpIssueSchema.parse(req.body);

  const prog = await queryOne(
    'SELECT id, status FROM trx_knitting_program WHERE id = ? AND company_id = ?',
    [body.program_id, cid]
  );
  if (!prog) throw NotFound('Knitting program not found');
  if (['COMPLETED', 'CANCELLED'].includes(prog.status)) {
    throw BadRequest('Cannot issue yarn to a completed or cancelled program');
  }

  const result = await transaction(async (tx) => {
    const issueNo = body.issue_no || await nextDocNumber(tx, cid, 'KNP_YI');
    const res2 = await txExecute(
      tx,
      `INSERT INTO trx_knitting_program_yarn_issues
         (company_id, program_id, program_yarn_id, issue_no, issue_date,
          yarn_id, yarn_lot_no, yarn_po_no, issued_qty_kg, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        cid, body.program_id, body.program_yarn_id ?? null, issueNo, body.issue_date,
        body.yarn_id ?? null, body.yarn_lot_no ?? null, body.yarn_po_no ?? null,
        body.issued_qty_kg, body.remarks ?? null, uid,
      ]
    );

    // Update issued_qty_kg on the yarn line
    if (body.program_yarn_id) {
      await txExecute(
        tx,
        `UPDATE trx_knitting_program_yarns
            SET issued_qty_kg = issued_qty_kg + ?
          WHERE id = ? AND program_id = ?`,
        [body.issued_qty_kg, body.program_yarn_id, body.program_id]
      );
    }

    // Advance status to MATERIAL_ISSUED if still RELEASED
    await txExecute(
      tx,
      `UPDATE trx_knitting_program SET status = 'MATERIAL_ISSUED'
        WHERE id = ? AND status IN ('RELEASED', 'RESERVED', 'STOCK_CHECK')`,
      [body.program_id]
    );

    return { id: res2.insertId, issue_no: issueNo };
  });

  await audit(req, 'trx_knitting_program_yarn_issues', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/* ================================================================
   LEGACY KNITTING WORK ORDER (KWO) — unchanged routes below
================================================================ */

/** GET /knitting/orders — List all Knitting Work Orders */
knittingRouter.get('/knitting/orders', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id, sub_process, status } = req.query;

  let where = 'WHERE ko.company_id = ?';
  const params: any[] = [cid];

  if (io_no) {
    where += ' AND ko.io_no LIKE ?';
    params.push(`%${io_no}%`);
  }
  if (style_id) {
    where += ' AND ko.style_id = ?';
    params.push(style_id);
  }
  if (sub_process) {
    where += ' AND ko.sub_process = ?';
    params.push(sub_process);
  }
  if (status) {
    where += ' AND ko.status = ?';
    params.push(status);
  }

  const rows = await query(
    `SELECT ko.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            p.party_name AS vendor_name,
            COALESCE(SUM(DISTINCT kyi.issued_weight_kg), 0) AS total_yarn_issued_kg,
            COALESCE(SUM(DISTINCT kro.weight_kg), 0) AS total_fabric_produced_kg,
            COUNT(DISTINCT kro.id) AS total_rolls_count
       FROM trx_knitting_order ko
       LEFT JOIN mst_style st ON st.id = ko.style_id
       LEFT JOIN mst_fabric fab ON fab.id = ko.fabric_id
       LEFT JOIN mst_party p ON p.id = ko.vendor_id
       LEFT JOIN trx_knitting_yarn_issue kyi ON kyi.kwo_id = ko.id
       LEFT JOIN trx_knitting_roll_output kro ON kro.kwo_id = ko.id
      ${where}
      GROUP BY ko.id
      ORDER BY ko.id DESC`,
    params
  );

  res.json({ success: true, data: rows });
}));

/** GET /knitting/orders/:id — Detail with issues and rolls */
knittingRouter.get('/knitting/orders/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const order = await queryOne(
    `SELECT ko.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            p.party_name AS vendor_name
       FROM trx_knitting_order ko
       LEFT JOIN mst_style st ON st.id = ko.style_id
       LEFT JOIN mst_fabric fab ON fab.id = ko.fabric_id
       LEFT JOIN mst_party p ON p.id = ko.vendor_id
      WHERE ko.id = ? AND ko.company_id = ?`,
    [req.params.id, cid]
  );

  if (!order) throw NotFound('Knitting work order not found');

  const yarnIssues = await query(
    `SELECT kyi.*, y.yarn_name, y.yarn_code
       FROM trx_knitting_yarn_issue kyi
       JOIN mst_yarn y ON y.id = kyi.yarn_id
      WHERE kyi.kwo_id = ?
      ORDER BY kyi.id ASC`,
    [order.id]
  );

  const rollOutputs = await query(
    `SELECT kro.*, fab.fabric_name
       FROM trx_knitting_roll_output kro
       LEFT JOIN mst_fabric fab ON fab.id = kro.fabric_id
      WHERE kro.kwo_id = ?
      ORDER BY kro.id ASC`,
    [order.id]
  );

  const totalYarnIssued = yarnIssues.reduce((sum: number, r: any) => sum + Number(r.issued_weight_kg || 0), 0);
  const totalRollsWeight = rollOutputs.reduce((sum: number, r: any) => sum + Number(r.weight_kg || 0), 0);
  const totalRollsMeters = rollOutputs.reduce((sum: number, r: any) => sum + Number(r.meters || 0), 0);
  const knittingLossKg = Math.max(0, totalYarnIssued - totalRollsWeight);
  const knittingLossPct = totalYarnIssued > 0 ? (knittingLossKg / totalYarnIssued) * 100 : 0;

  res.json({
    success: true,
    data: {
      ...order,
      yarn_issues: yarnIssues,
      roll_outputs: rollOutputs,
      summary: {
        total_yarn_issued_kg: totalYarnIssued,
        total_rolls_produced_kg: totalRollsWeight,
        total_rolls_produced_meters: totalRollsMeters,
        total_rolls_count: rollOutputs.length,
        knitting_loss_kg: knittingLossKg,
        knitting_loss_pct: Number(knittingLossPct.toFixed(2)),
      }
    }
  });
}));

/** POST /knitting/orders — Create KWO */
knittingRouter.post('/knitting/orders', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = kwoSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const kwoNo = body.kwo_no || await nextDocNumber(tx, cid, 'KWO');

    const resOrder = await txExecute(
      tx,
      `INSERT INTO trx_knitting_order
         (company_id, kwo_no, kwo_date, io_no, customer_po_no, style_id, sub_process, vendor_id, fabric_id,
          dia, gsm, gauge, loop_length, planned_fabric_kg, planned_yarn_kg, yarn_lot_no, status, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, kwoNo, body.kwo_date, body.io_no, body.customer_po_no ?? null, body.style_id ?? null, body.sub_process, body.vendor_id ?? null, body.fabric_id ?? null,
        body.dia ?? null, body.gsm ?? null, body.gauge ?? null, body.loop_length ?? null, body.planned_fabric_kg ?? 0, body.planned_yarn_kg ?? 0,
        body.yarn_lot_no ?? null, body.status ?? 'DRAFT', body.remarks ?? null, uid
      ]
    );

    return { id: resOrder.insertId, kwo_no: kwoNo };
  });

  await audit(req, 'trx_knitting_order', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** PUT /knitting/orders/:id — Update KWO */
knittingRouter.put('/knitting/orders/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = kwoSchema.partial().parse(req.body);

  const existing = await queryOne('SELECT id, kwo_no FROM trx_knitting_order WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!existing) throw NotFound('Knitting work order not found');

  await query(
    `UPDATE trx_knitting_order
        SET kwo_date = COALESCE(?, kwo_date),
            io_no = COALESCE(?, io_no),
            customer_po_no = COALESCE(?, customer_po_no),
            style_id = COALESCE(?, style_id),
            sub_process = COALESCE(?, sub_process),
            vendor_id = COALESCE(?, vendor_id),
            fabric_id = COALESCE(?, fabric_id),
            dia = COALESCE(?, dia),
            gsm = COALESCE(?, gsm),
            gauge = COALESCE(?, gauge),
            loop_length = COALESCE(?, loop_length),
            planned_fabric_kg = COALESCE(?, planned_fabric_kg),
            planned_yarn_kg = COALESCE(?, planned_yarn_kg),
            yarn_lot_no = COALESCE(?, yarn_lot_no),
            status = COALESCE(?, status),
            remarks = COALESCE(?, remarks)
      WHERE id = ? AND company_id = ?`,
    [
      body.kwo_date ?? null, body.io_no ?? null, body.customer_po_no ?? null, body.style_id ?? null, body.sub_process ?? null, body.vendor_id ?? null, body.fabric_id ?? null,
      body.dia ?? null, body.gsm ?? null, body.gauge ?? null, body.loop_length ?? null, body.planned_fabric_kg ?? null, body.planned_yarn_kg ?? null,
      body.yarn_lot_no ?? null, body.status ?? null, body.remarks ?? null, req.params.id, cid
    ]
  );

  await audit(req, 'trx_knitting_order', Number(req.params.id), 'UPDATE', existing, body);
  res.json({ success: true, message: 'Knitting work order updated' });
}));

/** POST /knitting/yarn-issues — Issue yarn against KWO */
knittingRouter.post('/knitting/yarn-issues', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = yarnIssueSchema.parse(req.body);

  const kwo = await queryOne('SELECT id, io_no FROM trx_knitting_order WHERE id = ? AND company_id = ?', [body.kwo_id, cid]);
  if (!kwo) throw NotFound('Knitting work order not found');

  const result = await transaction(async (tx) => {
    const issueNo = body.issue_no || await nextDocNumber(tx, cid, 'KYI');

    const resIns = await txExecute(
      tx,
      `INSERT INTO trx_knitting_yarn_issue
         (company_id, kwo_id, issue_no, issue_date, yarn_id, yarn_lot_no, bags_cones, issued_weight_kg, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cid, body.kwo_id, issueNo, body.issue_date, body.yarn_id, body.yarn_lot_no ?? null, body.bags_cones ?? 0, body.issued_weight_kg, body.remarks ?? null, uid]
    );

    await txExecute(tx, `UPDATE trx_knitting_order SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'DRAFT'`, [body.kwo_id]);
    return { id: resIns.insertId, issue_no: issueNo };
  });

  await audit(req, 'trx_knitting_yarn_issue', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** DELETE /knitting/yarn-issues/:id */
knittingRouter.delete('/knitting/yarn-issues/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const issue = await queryOne('SELECT id, kwo_id FROM trx_knitting_yarn_issue WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!issue) throw NotFound('Yarn issue not found');

  await query('DELETE FROM trx_knitting_yarn_issue WHERE id = ?', [req.params.id]);
  await audit(req, 'trx_knitting_yarn_issue', Number(req.params.id), 'DELETE', issue);
  res.json({ success: true, message: 'Yarn issue removed' });
}));

/** POST /knitting/rolls — Record produced grey rolls */
knittingRouter.post('/knitting/rolls', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = rollOutputSchema.parse(req.body);

  const kwo = await queryOne(
    'SELECT id, io_no, style_id, fabric_id FROM trx_knitting_order WHERE id = ? AND company_id = ?',
    [body.kwo_id, cid]
  );
  if (!kwo) throw NotFound('Knitting work order not found');

  const result = await transaction(async (tx) => {
    const resIns = await txExecute(
      tx,
      `INSERT INTO trx_knitting_roll_output
         (company_id, kwo_id, roll_no, lot_no, io_no, style_id, fabric_id, production_date, dia, gsm, meters, weight_kg, qc_status, defect_points, rejection_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, body.kwo_id, body.roll_no, body.lot_no, kwo.io_no, kwo.style_id ?? null, kwo.fabric_id ?? null,
        body.production_date, body.dia ?? null, body.gsm ?? null, body.meters ?? 0, body.weight_kg, body.qc_status ?? 'ACCEPTED',
        body.defect_points ?? 0, body.rejection_reason ?? null
      ]
    );

    await txExecute(tx, `UPDATE trx_knitting_order SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'DRAFT'`, [body.kwo_id]);
    return { id: resIns.insertId, roll_no: body.roll_no };
  });

  await audit(req, 'trx_knitting_roll_output', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** DELETE /knitting/rolls/:id */
knittingRouter.delete('/knitting/rolls/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const roll = await queryOne('SELECT id, is_dispatched_to_process FROM trx_knitting_roll_output WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!roll) throw NotFound('Roll output not found');
  if (roll.is_dispatched_to_process) throw BadRequest('Cannot delete roll that has already been dispatched to fabric processing');

  await query('DELETE FROM trx_knitting_roll_output WHERE id = ?', [req.params.id]);
  await audit(req, 'trx_knitting_roll_output', Number(req.params.id), 'DELETE', roll);
  res.json({ success: true, message: 'Roll output removed' });
}));

/** GET /knitting/available-grey-rolls — Available for Fabric Processing */
knittingRouter.get('/knitting/available-grey-rolls', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id } = req.query;

  let where = `WHERE kro.company_id = ? AND kro.qc_status = 'ACCEPTED' AND kro.is_dispatched_to_process = 0`;
  const params: any[] = [cid];

  if (io_no) {
    where += ' AND kro.io_no = ?';
    params.push(io_no);
  }
  if (style_id) {
    where += ' AND kro.style_id = ?';
    params.push(style_id);
  }

  const rows = await query(
    `SELECT kro.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            ko.kwo_no
       FROM trx_knitting_roll_output kro
       JOIN trx_knitting_order ko ON ko.id = kro.kwo_id
       LEFT JOIN mst_style st ON st.id = kro.style_id
       LEFT JOIN mst_fabric fab ON fab.id = kro.fabric_id
      ${where}
      ORDER BY kro.id DESC`,
    params
  );

  res.json({ success: true, data: rows });
}));
