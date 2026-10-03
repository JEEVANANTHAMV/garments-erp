import { ensureRequirementSnapshot } from '../stock/genealogy.routes.js';
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { yarnJobLots, resolveSoId } from '../stock/jobStock.routes.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { txResolvePartName } from '../../core/partName.js';
import { checkStock, reserveYarn, assertEditable } from '../../core/processEngine.js';

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
  so_line_id: s.id(),
  io_no: s.strReq(60),   // internal order no + style are compulsory (client review 24-Sep-2026)
  buyer_po_no: s.nullableStr(60),
  style_id: s.idReq(),
  part_name: z.enum(PARTS).nullable().optional(),
  fabric_id: s.id(),
  fabric_type: s.nullableStr(80),
  knitting_type: z.enum(KNITTING_TYPES).default('SOLID'),
  gsm: s.nullableStr(40),
  dia: s.nullableStr(40),
  /** Tubular / open width — decides the Dia → width rule for the roll meter calculation. */
  fabric_form: z.enum(['TUBULAR', 'OPEN_WIDTH']).nullable().optional(),
  /** CAD = made from the job's CAD fabric program line; DIRECT = entered by hand. */
  program_source: z.enum(['CAD', 'DIRECT']).default('DIRECT'),
  cad_req_id: s.id(), cad_fp_id: s.id(), fabric_colour: s.nullableStr(80),
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
  so_line_id: s.id(),
  io_no: s.nullableStr(60),
  buyer_po_no: s.nullableStr(60),
  style_id: s.id(),
  part_name: z.enum(PARTS).nullable().optional(),
  fabric_id: s.id(),
  fabric_type: s.nullableStr(80),
  knitting_type: z.enum(KNITTING_TYPES).optional(),
  gsm: s.nullableStr(40),
  dia: s.nullableStr(40),
  fabric_form: z.enum(['TUBULAR', 'OPEN_WIDTH']).nullable().optional(),
  program_source: z.enum(['CAD', 'DIRECT']).optional(),
  cad_req_id: s.id(), cad_fp_id: s.id(), fabric_colour: s.nullableStr(80),
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
  so_line_id: s.id(),
  style_id: s.idReq(),
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
  part_name: z.enum(PARTS).nullable().optional(),
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

/**
 * A knitting program's yarn comes only from what the job holds (its own PO / GRN lots and yarn transferred to it —
 * client 03-Oct-2026), within the KG it holds. New or changed lines are checked; lines left as they were are not.
 */
async function assertJobYarns(cid: number, soIdIn: number | null, ioNo: string | null | undefined, yarns: z.infer<typeof kpYarnSchema>[], oldLines: any[]) {
  const soId = await resolveSoId(cid, soIdIn, ioNo);
  if (!soId) return;   // not a sales-order job (stock program) — nothing to hold it to
  const changed = yarns.filter((y) => {
    const was = y.id ? oldLines.find((o) => Number(o.id) === Number(y.id)) : null;
    return !was || Number(was.yarn_id ?? 0) !== Number(y.yarn_id ?? 0) || Math.abs(Number(was.planned_qty_kg) - Number(y.planned_qty_kg)) > 0.0005;
  }).filter((y) => y.yarn_id || Number(y.planned_qty_kg) > 0);
  if (!changed.length) return;
  const lots = await yarnJobLots(cid, { so_id: soId });
  for (const y of changed) {
    if (!y.yarn_id) throw BadRequest(`Yarn line ${y.seq_no}: pick the yarn from job ${ioNo ?? ''}'s stock`);
    const mine = lots.filter((l) => Number(l.yarn_id) === Number(y.yarn_id));
    const avail = mine.reduce((a, l) => a + Number(l.available_kg), 0);
    if (avail <= 0.0005) throw BadRequest(`Yarn line ${y.seq_no}: job ${ioNo ?? ''} holds no stock of this yarn — buy it for the job (PO → GRN) or transfer it to the job first`);
    const was = y.id ? oldLines.find((o) => Number(o.id) === Number(y.id)) : null;
    const need = Number(y.planned_qty_kg) - Number(was?.issued_qty_kg ?? 0);
    if (need > avail + 0.0005) throw BadRequest(`Yarn line ${y.seq_no}: planned ${Number(y.planned_qty_kg)} KG but job ${ioNo ?? ''} holds only ${Math.round(avail * 1000) / 1000} KG of this yarn`);
  }
}

/**
 * GET /knitting/programs/cad-fabrics?io_no=&style_id= — the job's CAD fabric program (F.PRGM: fabric, GSM, Dia,
 * colour, required KG) for a program made "from CAD"; each line with the KG already programmed against it and the
 * fabric master it matches (job BOM fabric first).
 */
knittingRouter.get('/knitting/programs/cad-fabrics', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ io_no: z.string().trim().min(1).max(60), style_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const cad = await queryOne<any>(
    `SELECT cr.id, cr.req_no, cr.status, cr.style_id, st.style_code FROM trx_cad_requirement cr LEFT JOIN mst_style st ON st.id = cr.style_id
      WHERE cr.company_id = ? AND cr.internal_ir_no = ? ${q.style_id ? 'AND cr.style_id = ?' : ''}
      ORDER BY (cr.status = 'APPROVED') DESC, cr.id DESC LIMIT 1`, q.style_id ? [cid, q.io_no, q.style_id] : [cid, q.io_no]);
  if (!cad) { res.json({ data: null }); return; }
  const rows = await query<any>(`SELECT * FROM trx_cad_fabric_program WHERE cad_req_id = ? AND sheet_type = 'FABRIC_PROGRAM' ORDER BY sort_order, id`, [cad.id]);
  const soId = await resolveSoId(cid, null, q.io_no);
  const bomFabrics = await query<any>(
    `SELECT DISTINCT fb.id, fb.fabric_name, fb.width_form FROM trx_bom b JOIN trx_bom_line bl ON bl.bom_id = b.id JOIN mst_fabric fb ON fb.id = bl.fabric_id
      WHERE b.company_id = ? AND b.is_active = 1 AND bl.material_type = 'FABRIC' AND ((? IS NOT NULL AND b.so_id = ?) OR b.style_id = ?)`, [cid, soId, soId, cad.style_id ?? 0]);
  const norm = (x: unknown) => String(x ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const done = rows.length ? await query<any>(`SELECT cad_fp_id, SUM(required_qty_kg) kg, GROUP_CONCAT(program_no) nos FROM trx_knitting_program
                                                 WHERE company_id = ? AND cad_fp_id IN (?) AND status <> 'CANCELLED' GROUP BY cad_fp_id`, [cid, rows.map((r) => r.id)]) : [];
  const data = [];
  let allFabrics: any[] | undefined;
  for (const r of rows) {
    let fab = bomFabrics.find((f) => norm(f.fabric_name).includes(norm(r.fabric_type)) || norm(r.fabric_type).includes(norm(f.fabric_name)));
    if (!fab) {
      // fabric master by name, spacing / punctuation ignored (the CAD names the fabric as text)
      allFabrics ??= await query<any>('SELECT id, fabric_name, width_form FROM mst_fabric WHERE company_id = ? AND is_deleted = 0 AND is_active = 1 ORDER BY id', [cid]);
      const t = norm(r.fabric_type);
      fab = t ? allFabrics.find((f) => norm(f.fabric_name) === t) ?? allFabrics.find((f) => norm(f.fabric_name).startsWith(t) || t.startsWith(norm(f.fabric_name))) ?? allFabrics.find((f) => norm(f.fabric_name).includes(t)) : undefined;
    }
    const diaTxt = String(r.dia_spec ?? r.dia_val ?? '');
    const form = /TUBE|TUBULAR/i.test(diaTxt) ? 'TUBULAR' : /OPEN/i.test(diaTxt) ? 'OPEN_WIDTH' : (fab?.width_form ?? null);
    const d = done.find((x) => Number(x.cad_fp_id) === Number(r.id));
    data.push({ cad_fp_id: Number(r.id), fabric_type: r.fabric_type, gsm: r.gsm != null ? String(Number(r.gsm)) : null, dia: r.dia_val || diaTxt.replace(/\s*(OPEN|TUBE|TUBULAR)\s*/i, '').trim() || null,
      fabric_form: form, colour: r.color_name, order_pcs: Number(r.order_qty_pcs) || 0, required_kg: Number(r.grand_total_qty) || 0, uom: r.uom,
      fabric_id: fab ? Number(fab.id) : null, fabric_name: fab?.fabric_name ?? null, programmed_kg: Number(d?.kg ?? 0), programs: d?.nos ?? null });
  }
  res.json({ data: { cad_id: Number(cad.id), req_no: cad.req_no, status: cad.status, style_id: cad.style_id, style_code: cad.style_code, rows: data } });
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
  await assertJobYarns(cid, body.so_id ?? null, body.io_no, body.yarns, []);

  const result = await transaction(async (tx) => {
    const programNo = body.program_no || await nextDocNumber(tx, cid, 'KNP');

    // The Sales Order line owns the part; it wins over whatever the client sent
    // so the part cannot drift between stages (Audio 5 carry-forward).
    const partName = await txResolvePartName(tx, body.so_line_id, body.part_name);

    const res2 = await txExecute(
      tx,
      `INSERT INTO trx_knitting_program
         (company_id, program_no, program_date, so_id, so_line_id, io_no, buyer_po_no, style_id,
          part_name, fabric_id, fabric_type, knitting_type, gsm, dia, fabric_form, gauge, loop_length,
          required_qty_kg, required_date, job_work_type, vendor_id, status, remarks, created_by,
          program_source, cad_req_id, cad_fp_id, fabric_colour)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        cid, programNo, body.program_date, body.so_id ?? null, body.so_line_id ?? null,
        body.io_no ?? null, body.buyer_po_no ?? null,
        body.style_id ?? null, partName, body.fabric_id ?? null, body.fabric_type ?? null,
        body.knitting_type, body.gsm ?? null, body.dia ?? null, body.fabric_form ?? null, body.gauge ?? null, body.loop_length ?? null,
        body.required_qty_kg, body.required_date ?? null, body.job_work_type,
        body.vendor_id ?? null, body.status, body.remarks ?? null, uid,
        body.program_source, body.cad_req_id ?? null, body.cad_fp_id ?? null, body.fabric_colour ?? null,
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

    // the job's planned requirement is frozen before production (genealogy doc §5.1 / §29)
    const jobId = body.so_id ?? (await txQueryOne<any>(tx, `SELECT id FROM trx_sales_order WHERE company_id = ? AND is_deleted = 0 AND (io_no = ? OR so_no = ?) ORDER BY id DESC LIMIT 1`, [cid, body.io_no, body.io_no]))?.id;
    await ensureRequirementSnapshot(tx, cid, jobId ? Number(jobId) : null, req.user!.id);
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
  if (body.yarns !== undefined) {
    const cur = await queryOne<any>('SELECT so_id, io_no FROM trx_knitting_program WHERE id = ?', [id]);
    const oldLines = await query<any>('SELECT id, yarn_id, planned_qty_kg, issued_qty_kg FROM trx_knitting_program_yarns WHERE program_id = ?', [id]);
    await assertJobYarns(cid, body.so_id !== undefined ? body.so_id ?? null : cur?.so_id ?? null, body.io_no ?? cur?.io_no ?? null, body.yarns ?? [], oldLines);
  }

  await transaction(async (tx) => {
    // Build the UPDATE from only the keys actually present in the request, so
    // an omitted field is left untouched while an explicit null clears it.
    const FIELDS = [
      'program_date', 'so_id', 'so_line_id', 'io_no', 'buyer_po_no', 'style_id', 'part_name',
      'fabric_id', 'fabric_type', 'knitting_type', 'gsm', 'dia', 'fabric_form', 'gauge',
      'loop_length', 'required_qty_kg', 'required_date', 'job_work_type',
      'vendor_id', 'status', 'remarks', 'program_source', 'cad_req_id', 'cad_fp_id', 'fabric_colour',
    ] as const;

    const sets: string[] = [];
    const vals: any[] = [];
    for (const f of FIELDS) {
      const v = (body as Record<string, any>)[f];
      if (v === undefined) continue;          // not supplied → leave as-is
      sets.push(`${f} = ?`);
      vals.push(v);                            // explicit null → clears the column
    }

    // Re-link to a Sales Order line → the part follows that line, overriding
    // any part_name the client may have sent alongside it.
    if (body.so_line_id !== undefined) {
      const linked = await txResolvePartName(tx, body.so_line_id, body.part_name);
      if (linked) {
        const i = sets.indexOf('part_name = ?');
        if (i >= 0) vals[i] = linked;
        else { sets.push('part_name = ?'); vals.push(linked); }
      }
    }

    if (sets.length) {
      await txExecute(
        tx,
        `UPDATE trx_knitting_program SET ${sets.join(', ')} WHERE id = ? AND company_id = ?`,
        [...vals, id, cid]
      );
    }

    // Yarn lines: kept by id (DC issues, reservations and substitutions point at them), new ones added,
    // removed ones deleted — a line yarn was already issued on cannot be removed or switched to another yarn.
    if (body.yarns !== undefined) {
      const old = await txQuery<any>(tx, 'SELECT * FROM trx_knitting_program_yarns WHERE program_id = ?', [id]);
      const keep = new Set((body.yarns ?? []).filter((y) => y.id).map((y) => Number(y.id)));
      for (const o of old) {
        if (keep.has(Number(o.id))) continue;
        if (Number(o.issued_qty_kg) > 0) throw BadRequest(`Yarn line ${o.seq_no} already has ${Number(o.issued_qty_kg)} KG issued on a DC — it cannot be removed`);
        await txExecute(tx, 'DELETE FROM trx_knitting_program_yarns WHERE id = ?', [o.id]);
      }
      for (const yarn of body.yarns ?? []) {
        const was = yarn.id ? old.find((o) => Number(o.id) === Number(yarn.id)) : null;
        if (was) {
          if (Number(was.issued_qty_kg) > 0 && Number(was.yarn_id ?? 0) !== Number(yarn.yarn_id ?? 0)) throw BadRequest(`Yarn line ${was.seq_no} already has yarn issued — it cannot be changed to another yarn (use a yarn substitution)`);
          await txExecute(tx,
            `UPDATE trx_knitting_program_yarns SET seq_no = ?, yarn_id = ?, yarn_name_manual = ?, count_value = ?, colour = ?, yarn_po_no = ?, yarn_lot_no = ?,
                    planning_ratio_pct = ?, planned_qty_kg = ? WHERE id = ?`,
            [yarn.seq_no, yarn.yarn_id ?? null, yarn.yarn_name_manual ?? null, yarn.count_value ?? null, yarn.colour ?? null, yarn.yarn_po_no ?? null,
             yarn.yarn_lot_no ?? null, yarn.planning_ratio_pct ?? null, yarn.planned_qty_kg, was.id]);
          continue;
        }
        await txExecute(
          tx,
          `INSERT INTO trx_knitting_program_yarns
             (program_id, seq_no, yarn_id, yarn_name_manual, count_value, colour,
              yarn_po_no, yarn_lot_no, planning_ratio_pct, planned_qty_kg, reserved_qty_kg, issued_qty_kg)
           VALUES (?,?,?,?,?,?,?,?,?,?,0,0)`,
          [
            id, yarn.seq_no, yarn.yarn_id ?? null, yarn.yarn_name_manual ?? null,
            yarn.count_value ?? null, yarn.colour ?? null, yarn.yarn_po_no ?? null,
            yarn.yarn_lot_no ?? null, yarn.planning_ratio_pct ?? null,
            yarn.planned_qty_kg,
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
   KNITTING PROGRAM — stock check, reservation and release
   (doc §12, §21). A program has many yarn lines, so each step works
   across every line rather than a single material.
================================================================ */

/** POST /knitting/programs/:id/check-stock — required vs available, per yarn line. */
knittingRouter.post('/knitting/programs/:id/check-stock', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const prog = await queryOne<any>(
    'SELECT * FROM trx_knitting_program WHERE id = ? AND company_id = ?', [id, cid]);
  if (!prog) throw NotFound('Knitting program not found');

  const lines = await query<any>(
    `SELECT kpy.id, kpy.yarn_id, kpy.planned_qty_kg, kpy.colour, y.yarn_code, y.yarn_name
       FROM trx_knitting_program_yarns kpy
       LEFT JOIN mst_yarn y ON y.id = kpy.yarn_id
      WHERE kpy.program_id = ? ORDER BY kpy.seq_no`, [id]);
  const withYarn = lines.filter((l) => l.yarn_id);
  if (!withYarn.length) throw BadRequest('No yarn lines with a yarn selected');

  const stock = await checkStock(
    cid, withYarn.map((l) => ({ yarn_id: Number(l.yarn_id), required_qty_kg: Number(l.planned_qty_kg) })));

  // Pair each result back to its program line so the UI can show it in place.
  const data = withYarn.map((l, i) => ({
    ...stock[i],                       // yarn_id, required/on-hand/available/shortage
    program_yarn_id: l.id,
    yarn_code: l.yarn_code, yarn_name: l.yarn_name, colour: l.colour,
  }));

  if (prog.status === 'DRAFT') {
    await query(`UPDATE trx_knitting_program SET status = 'STOCK_CHECK' WHERE id = ?`, [id]);
  }
  res.json({ success: true, data });
}));

/** POST /knitting/programs/:id/reserve — reserve each yarn line (no stock movement). */
knittingRouter.post('/knitting/programs/:id/reserve', requirePermission('PROCESS.RESERVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const prog = await queryOne<any>(
    'SELECT * FROM trx_knitting_program WHERE id = ? AND company_id = ?', [id, cid]);
  if (!prog) throw NotFound('Knitting program not found');
  assertEditable(prog.status, 'knitting program');

  const lines = await query<any>(
    `SELECT id, yarn_id, planned_qty_kg FROM trx_knitting_program_yarns
      WHERE program_id = ? AND yarn_id IS NOT NULL ORDER BY seq_no`, [id]);
  if (!lines.length) throw BadRequest('No yarn lines with a yarn selected');

  // Optional per-line overrides: { reservations: [{ program_yarn_id, reserved_qty_kg }] }
  const overrides = new Map<number, number>();
  for (const r of (req.body?.reservations ?? [])) {
    if (r?.program_yarn_id != null) overrides.set(Number(r.program_yarn_id), Number(r.reserved_qty_kg ?? 0));
  }

  await transaction(async (tx) => {
    for (const l of lines) {
      const qty = overrides.has(Number(l.id))
        ? overrides.get(Number(l.id))! : Number(l.planned_qty_kg);
      if (!(qty > 0)) continue;
      await reserveYarn(tx, {
        companyId: cid, srcType: 'KNITTING_PROGRAM', srcId: id, srcLineId: Number(l.id),
        yarnId: Number(l.yarn_id), requiredQtyKg: Number(l.planned_qty_kg),
        reservedQtyKg: qty, createdBy: req.user!.id,
      });
      await txExecute(tx,
        `UPDATE trx_knitting_program_yarns SET reserved_qty_kg = ? WHERE id = ?`, [qty, l.id]);
    }
    await txExecute(tx,
      `UPDATE trx_knitting_program SET status = 'RESERVED'
        WHERE id = ? AND status IN ('DRAFT','STOCK_CHECK')`, [id]);
  });

  await audit(req, 'trx_knitting_program', id, 'UPDATE', prog, { action: 'RESERVE' });
  res.json({ success: true, data: await loadKpDetail(id, cid) });
}));

/** POST /knitting/programs/:id/release — mandatory-field gate before release (doc §22). */
knittingRouter.post('/knitting/programs/:id/release', requirePermission('PROCESS.RELEASE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const prog = await queryOne<any>(
    'SELECT * FROM trx_knitting_program WHERE id = ? AND company_id = ?', [id, cid]);
  if (!prog) throw NotFound('Knitting program not found');
  assertEditable(prog.status, 'knitting program');

  const yarns = await query<any>(
    `SELECT id, yarn_id, planning_ratio_pct FROM trx_knitting_program_yarns WHERE program_id = ?`, [id]);
  const stripes = await query<any>(
    `SELECT courses FROM trx_knitting_program_stripes WHERE program_id = ?`, [id]);

  const missing: string[] = [];
  if (!(Number(prog.required_qty_kg) > 0)) missing.push('required quantity');
  if (!prog.required_date) missing.push('required date');
  if (!yarns.length) missing.push('at least one yarn line');
  if (prog.job_work_type === 'JOB_WORK' && !prog.vendor_id) missing.push('vendor (job work)');

  // Doc §22: pattern rules for striped fabric.
  const isPatterned = ['STRIPE', 'FEEDER_STRIPE', 'ENGINEERED_STRIPE'].includes(prog.knitting_type);
  if (isPatterned) {
    if (!stripes.length) missing.push('stripe pattern');
    if (yarns.length < 2) missing.push('at least two yarn lines for a stripe pattern');
    const repeat = stripes.reduce((n, s) => n + Number(s.courses || 0), 0);
    if (stripes.length && repeat <= 0) missing.push('course repeat length greater than zero');
  }
  if (missing.length) throw BadRequest(`Cannot release — missing: ${missing.join(', ')}`);

  // Ratio mode must total 100% when ratios are used at all.
  const ratios = yarns.filter((y) => y.planning_ratio_pct != null);
  if (ratios.length) {
    const total = ratios.reduce((n, y) => n + Number(y.planning_ratio_pct), 0);
    if (Math.abs(total - 100) > 0.01) {
      throw BadRequest(`Planning ratios must total 100% (currently ${total.toFixed(2)}%)`);
    }
  }

  await query(`UPDATE trx_knitting_program SET status = 'RELEASED' WHERE id = ?`, [id]);
  await audit(req, 'trx_knitting_program', id, 'UPDATE', prog, { status: 'RELEASED' });
  res.json({ success: true, data: await loadKpDetail(id, cid) });
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

    // Sales Order line owns the part (Audio 5 carry-forward).
    const partName = await txResolvePartName(tx, body.so_line_id, body.part_name);

    const resOrder = await txExecute(
      tx,
      `INSERT INTO trx_knitting_order
         (company_id, kwo_no, kwo_date, io_no, customer_po_no, so_line_id, style_id, sub_process, vendor_id, fabric_id,
          dia, gsm, gauge, loop_length, planned_fabric_kg, planned_yarn_kg, yarn_lot_no, part_name, status, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, kwoNo, body.kwo_date, body.io_no, body.customer_po_no ?? null, body.so_line_id ?? null, body.style_id ?? null, body.sub_process, body.vendor_id ?? null, body.fabric_id ?? null,
        body.dia ?? null, body.gsm ?? null, body.gauge ?? null, body.loop_length ?? null, body.planned_fabric_kg ?? 0, body.planned_yarn_kg ?? 0,
        body.yarn_lot_no ?? null, partName, body.status ?? 'DRAFT', body.remarks ?? null, uid
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

  const rows = await query<any>(
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
  for (const r of rows) {
    r.source = 'KWO';
    r.row_key = `KWO-${r.id}`;
    r.knitting_roll_id = r.id;
    r.fabric_roll_id = null;
  }

  // Grey rolls received against a knitting program DC live in fabric roll
  // stock (trx_fabric_roll via the inward's GRN); offer the unissued ones too.
  let kpWhere = `WHERE fr.company_id = ? AND fr.qc_status = 'ACCEPTED'
                   AND fr.stock_status IN ('AVAILABLE','PARTIAL')
                   AND COALESCE(fr.weight_kg,0) - COALESCE(fr.issued_kg,0) > 0`;
  const kpParams: any[] = [cid];
  if (io_no) { kpWhere += ' AND kp.io_no = ?'; kpParams.push(io_no); }
  if (style_id) { kpWhere += ' AND kp.style_id = ?'; kpParams.push(style_id); }
  const kpRows = await query<any>(
    `SELECT fr.id AS fabric_roll_id, fr.roll_no, fr.lot_no, fr.dia, fr.gsm, fr.meters,
            ROUND(COALESCE(fr.weight_kg,0) - COALESCE(fr.issued_kg,0), 3) AS weight_kg,
            fr.fabric_id, kp.io_no, kp.style_id, kp.program_no, rc.receipt_no, rc.party_dc_no,
            st.style_code, st.style_name, fab.fabric_name, fab.fabric_code
       FROM trx_fabric_roll fr
       JOIN trx_process_receipt rc ON rc.grn_id = fr.grn_id AND rc.company_id = fr.company_id
                                  AND rc.src_type = 'KNITTING_PROGRAM'
       JOIN trx_knitting_program kp ON kp.id = rc.src_id
       LEFT JOIN mst_style st ON st.id = kp.style_id
       LEFT JOIN mst_fabric fab ON fab.id = fr.fabric_id
      ${kpWhere}
      ORDER BY fr.id DESC`,
    kpParams
  );
  for (const r of kpRows) {
    r.source = 'KP';
    r.row_key = `KP-${r.fabric_roll_id}`;
    r.id = r.fabric_roll_id;
    r.knitting_roll_id = null;
  }

  res.json({ success: true, data: [...kpRows, ...rows] });
}));
