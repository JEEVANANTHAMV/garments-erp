import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { assertJobLots } from '../stock/jobStock.routes.js';
import { YP, can, r3, r2, n, EPS, date, processType, whName, partyName, coneHistory, lotRow, lotOut, lotGrn, lotIn } from './yarnEngine.common.js';

/**
 * Yarn Process engine (Garment_ERP_Yarn_Process_Developer_Document) — dyeing / winding / twisting
 * and re-dye / re-wind / re-twist, driven by mst_yarn_process_type (process mode, ply, tolerance,
 * QC, billing):
 *
 *   Yarn lot ─ Outward DC (multi job / lot / cone; draft → confirm issues the lots)
 *     → Inward / GRN (multi job; output cones from input cones — cone→cone, one→many (winding),
 *       many→one with ply (twisting); good / reject / loss; partial; Draft → QC → Posted)
 *       good → new yarn lot (traceable to its input lots), reject → reject store lot
 *   Return / reprocess / contractor bill / cone tracking / reports: yarnEngineAfter.routes.ts
 */
export const yarnEngineRouter = Router();

// =====================================================================================
// Masters
// =====================================================================================
yarnEngineRouter.get('/yarn-process/types', requirePermission(YP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const types = await query<any>('SELECT * FROM mst_yarn_process_type WHERE company_id = ? ORDER BY sort_order, name', [cid]);
  const params = await query<any>(`SELECT * FROM mst_fabric_process_qc_param WHERE company_id = ? AND process_code IN (?) ORDER BY process_code, sort_order, id`,
    [cid, types.length ? types.map((t) => t.code) : ['-']]);
  res.json({ data: types.map((t) => ({ ...t, qc_params: params.filter((p) => p.process_code === t.code) })) });
}));

const typeSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and _'),
  name: s.strReq(80),
  base_process: z.enum(['YARN_DYEING', 'WINDING', 'TWISTING']),
  process_mode: z.enum(['CONE_TO_CONE', 'ONE_TO_MANY', 'MANY_TO_ONE']),
  changes_shade: z.coerce.boolean().default(false),
  default_ply: z.coerce.number().int().min(1).max(12).nullish(),
  ply_options: s.nullableStr(40),
  loss_tolerance_pct: z.coerce.number().min(0).max(100).default(0),
  requires_qc: z.coerce.boolean().default(false),
  allow_reprocess: z.coerce.boolean().default(true),
  is_reprocess: z.coerce.boolean().default(false),
  billable: z.coerce.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
  is_active: z.coerce.boolean().default(true),
});
const typeVals = (b: Omit<z.infer<typeof typeSchema>, 'code'>) => [b.name, b.base_process, b.process_mode, b.changes_shade ? 1 : 0, b.default_ply ?? null, b.ply_options ?? null,
  b.loss_tolerance_pct, b.requires_qc ? 1 : 0, b.allow_reprocess ? 1 : 0, b.is_reprocess ? 1 : 0, b.billable ? 1 : 0, b.sort_order, b.is_active ? 1 : 0];
yarnEngineRouter.post('/yarn-process/types', requirePermission(YP.MASTER), ah(async (req, res) => {
  const b = typeSchema.parse(req.body);
  if (await queryOne('SELECT id FROM mst_yarn_process_type WHERE company_id = ? AND code = ?', [req.user!.companyId, b.code])) throw BadRequest(`Process ${b.code} already exists`);
  await query(`INSERT INTO mst_yarn_process_type (company_id, code, name, base_process, process_mode, changes_shade, default_ply, ply_options, loss_tolerance_pct,
                 requires_qc, allow_reprocess, is_reprocess, billable, sort_order, is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [req.user!.companyId, b.code, ...typeVals(b)]);
  await audit(req, 'mst_yarn_process_type', 0, 'INSERT', undefined, b);
  res.status(201).json({ message: `Process ${b.name} added` });
}));
yarnEngineRouter.put('/yarn-process/types/:id', requirePermission(YP.MASTER), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const before = await queryOne<any>('SELECT * FROM mst_yarn_process_type WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!before) throw NotFound('Process type not found');
  const b = typeSchema.omit({ code: true }).parse(req.body);
  await query(`UPDATE mst_yarn_process_type SET name = ?, base_process = ?, process_mode = ?, changes_shade = ?, default_ply = ?, ply_options = ?, loss_tolerance_pct = ?,
                 requires_qc = ?, allow_reprocess = ?, is_reprocess = ?, billable = ?, sort_order = ?, is_active = ? WHERE id = ?`, [...typeVals(b), id]);
  await audit(req, 'mst_yarn_process_type', id, 'UPDATE', before, b);
  res.json({ message: `${b.name} saved` });
}));

/** GET /yarn-process/programs — released yarn process programs (optional link on a DC line). */
yarnEngineRouter.get('/yarn-process/programs', requirePermission(YP.VIEW), ah(async (req, res) => {
  const q = z.object({ base: z.string().optional(), so_id: z.coerce.number().int().optional(), io_no: z.string().optional() }).parse(req.query);
  const where = ['yp.company_id = ?', `yp.status NOT IN ('DRAFT','CANCELLED','CLOSED')`]; const p: unknown[] = [req.user!.companyId];
  if (q.base) { where.push('yp.process_type = ?'); p.push(q.base); }
  if (q.so_id) { where.push('(yp.so_id = ? OR yp.io_no IN (SELECT COALESCE(io_no, so_no) FROM trx_sales_order WHERE id = ?))'); p.push(q.so_id, q.so_id); }
  else if (q.io_no) { where.push('yp.io_no = ?'); p.push(q.io_no); }
  res.json({ data: await query<any>(`SELECT yp.id, yp.process_no, yp.process_type, yp.io_no, yp.so_id, yp.status, yp.yarn_id, y.yarn_name, d.colour_name
                                        FROM trx_yarn_process yp LEFT JOIN mst_yarn y ON y.id = yp.yarn_id LEFT JOIN trx_yarn_process_dyeing d ON d.process_id = yp.id
                                       WHERE ${where.join(' AND ')} ORDER BY yp.id DESC LIMIT 300`, p) });
}));

// =====================================================================================
// Outward DC
// =====================================================================================
const outwardSchema = z.object({
  ypo_date: date,
  process_code: z.string().trim().min(2).max(40),
  vendor_id: s.idReq(),
  from_warehouse_id: s.id(),
  to_location: s.nullableStr(120),
  vehicle_no: s.nullableStr(30),
  challan_no: s.nullableStr(60),
  target_shade: s.nullableStr(80),
  expected_return_date: date.nullish(),
  remarks: s.text(),
  lines: z.array(z.object({
    so_id: s.id(),
    process_id: s.id(),
    grn_line_id: s.idReq(),
    qty_kg: z.coerce.number().positive(),
    cone_no: s.nullableStr(60),
    no_of_cones: z.coerce.number().int().min(0).default(0),
    target_shade: s.nullableStr(80),
  })).min(1, 'Add at least one yarn lot / cone'),
});
type OutwardBody = z.infer<typeof outwardSchema>;
type OutLine = OutwardBody['lines'][number];

const jobInfo = async (tx: Tx, cid: number, soId: number | null | undefined) => soId ? await txQueryOne<any>(tx,
  `SELECT so.id, COALESCE(so.io_no, so.so_no) AS io_no, so.buyer_po_no,
          (SELECT sol.style_id FROM trx_sales_order_line sol WHERE sol.so_id = so.id ORDER BY sol.id LIMIT 1) AS style_id
     FROM trx_sales_order so WHERE so.id = ? AND so.company_id = ?`, [soId, cid]) : null;

/**
 * Validates DC lines against the yarn lots and writes them; `issue` takes the KG out of the lots.
 * allowRejected: reprocess DCs send reject / returned lots.
 */
export async function writeOutwardLines(tx: Tx, req: Request, ypo: any, lines: OutLine[], issue: boolean, opts: { allowRejected?: boolean } = {}) {
  const cid = req.user!.companyId;
  const pt = await processType(cid, ypo.process_code, tx);
  const seen = new Set<string>();
  const lots = new Map<number, any>();
  for (const l of lines) {
    const k = `${l.grn_line_id}|${(l.cone_no ?? '').trim().toUpperCase()}`;
    if (seen.has(k)) throw BadRequest(`The same lot / cone is on the DC twice${l.cone_no ? ` (cone ${l.cone_no})` : ''}`);
    seen.add(k);
    if (!lots.has(l.grn_line_id)) lots.set(l.grn_line_id, await lotRow(tx, cid, l.grn_line_id, true));
  }
  if (opts.allowRejected) {
    // reprocess: reject / returned lots, KG left on the lot
    const used = new Map<number, number>();
    for (const l of lines) {
      const lot = lots.get(l.grn_line_id);
      const u = (used.get(l.grn_line_id) ?? 0) + l.qty_kg;
      if (u > lot.balance_kg + EPS) throw BadRequest(`Lot ${lot.lot_no}: only ${lot.balance_kg} KG left`);
      used.set(l.grn_line_id, u);
    }
  } else {
    for (const l of lines) {
      const lot = lots.get(l.grn_line_id);
      if (lot.qc_status !== 'ACCEPTED' && lot.qc_status !== 'PARTIAL_ACCEPTED') throw BadRequest(`Lot ${lot.lot_no} (${lot.grn_no}) is not QC accepted (${lot.qc_status})`);
    }
    // the lot must be held by the line's job (or general stock), with enough KG across the DC
    await assertJobLots(cid, lines.map((l) => ({ grn_line_id: l.grn_line_id, so_id: l.so_id ?? null, yarn_id: Number(lots.get(l.grn_line_id).yarn_id),
      issued_qty_kg: l.qty_kg, label: `Lot ${lots.get(l.grn_line_id).lot_no}` })));
  }
  const vendor = await partyName(tx, ypo.vendor_id);
  let total = 0;
  for (const l of lines) {
    const lot = lots.get(l.grn_line_id);
    const soId = l.so_id ?? (lot.so_id ? Number(lot.so_id) : null);
    const job = await jobInfo(tx, cid, soId);
    if (l.process_id) {
      const pr = await txQueryOne<any>(tx, 'SELECT id, process_no, process_type, io_no, so_id FROM trx_yarn_process WHERE id = ? AND company_id = ?', [l.process_id, cid]);
      if (!pr) throw BadRequest('Yarn process program not found');
      if (pr.process_type !== pt.base_process) throw BadRequest(`${pr.process_no} is a ${pr.process_type.toLowerCase().replace('_', ' ')} program, not ${pt.name}`);
      if (job && pr.io_no && pr.io_no !== job.io_no && Number(pr.so_id) !== Number(job.id)) throw BadRequest(`${pr.process_no} is for job ${pr.io_no}, not ${job.io_no}`);
    }
    const ins = await txExecute(tx,
      `INSERT INTO trx_yarn_process_order_line (ypo_id, so_id, io_no, buyer_po_no, style_id, process_id, yarn_id, grn_line_id, lot_no, cone_no, no_of_cones,
         shade, target_shade, qty_kg, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ypo.id, job?.id ?? null, job?.io_no ?? null, job?.buyer_po_no ?? null, job?.style_id ?? lot.style_id ?? null, l.process_id ?? null, lot.yarn_id ?? null,
       lot.id, lot.lot_no, l.cone_no ?? lot.cone_no ?? null, l.no_of_cones, lot.color_name || lot.shade_code || null,
       l.target_shade || ypo.target_shade || null, r3(l.qty_kg), issue ? 'AT_UNIT' : 'DRAFT']);
    const lineId = Number(ins.insertId);
    total += l.qty_kg;
    if (issue) {
      const issueId = await lotOut(tx, req, { lot, qty: l.qty_kg, srcType: 'YARN_PROC_DC', srcId: ypo.id, srcLineId: lineId, date: String(ypo.ypo_date).slice(0, 10),
        dcNo: ypo.ypo_no, vendorId: ypo.vendor_id, vehicleNo: ypo.vehicle_no, cones: l.no_of_cones, soId: job?.id ?? null, ioNo: job?.io_no ?? null,
        refType: ypo.is_reprocess ? 'YARN_REPROCESS_DC' : 'YARN_PROC_DC', remarks: `${pt.name} DC ${ypo.ypo_no}` });
      await txExecute(tx, 'UPDATE trx_yarn_process_order_line SET issue_id = ? WHERE id = ?', [issueId, lineId]);
      await coneHistory(tx, req, { grn_line_id: lot.id, lot_no: lot.lot_no, cone_no: l.cone_no ?? lot.cone_no ?? null, event: ypo.is_reprocess ? 'REPROCESS_OUTWARD' : 'PROCESS_OUTWARD',
        ref_type: 'YPO', ref_id: ypo.id, ref_no: ypo.ypo_no, process_code: pt.code, from: lot.warehouse_name, to: vendor, qty: l.qty_kg, so_id: job?.id ?? null,
        remarks: `Sent for ${pt.name.toLowerCase()}${l.target_shade || ypo.target_shade ? ` → ${l.target_shade || ypo.target_shade}` : ''}` });
    }
  }
  await txExecute(tx, 'UPDATE trx_yarn_process_order SET total_kg = ? WHERE id = ?', [r3(total), ypo.id]);
  return r3(total);
}

export async function insertOutwardHeader(tx: Tx, req: Request, b: Omit<OutwardBody, 'lines'>, extra: { status: string; is_reprocess?: boolean; reprocess_id?: number | null }) {
  const cid = req.user!.companyId;
  const pt = await processType(cid, b.process_code, tx);
  const no = await nextDocNumber(tx, cid, 'YP_OUTWARD');
  const confirmed = extra.status === 'CONFIRMED';
  const r = await txExecute(tx,
    `INSERT INTO trx_yarn_process_order (company_id, ypo_no, ypo_date, process_code, vendor_id, from_warehouse_id, to_location, vehicle_no, challan_no,
       target_shade, expected_return_date, status, is_reprocess, reprocess_id, remarks, created_by, confirmed_by, confirmed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, no, b.ypo_date, pt.code, b.vendor_id, b.from_warehouse_id ?? null, b.to_location ?? null, b.vehicle_no ?? null, b.challan_no ?? null,
     b.target_shade ?? null, b.expected_return_date ?? null, extra.status, extra.is_reprocess ? 1 : 0, extra.reprocess_id ?? null, b.remarks ?? null,
     req.user!.id, confirmed ? req.user!.id : null, confirmed ? new Date() : null]);
  return { id: Number(r.insertId), ypo_no: no, ypo_date: b.ypo_date, process_code: pt.code, vendor_id: b.vendor_id, vehicle_no: b.vehicle_no ?? null,
    target_shade: b.target_shade ?? null, is_reprocess: !!extra.is_reprocess };
}

/** Job-wise reconciliation of a DC (doc §16): outward = good + reject + loss + balance. */
export async function reconciliation(ypoId: number) {
  const rows = await query<any>(
    `SELECT l.so_id, COALESCE(l.io_no, 'STOCK') AS io_no, l.buyer_po_no, st.style_code, COUNT(*) AS line_count, SUM(l.no_of_cones) AS cones,
            SUM(l.qty_kg) AS outward_kg, SUM(l.good_kg) AS good_kg, SUM(l.reject_kg) AS reject_kg, SUM(l.loss_kg) AS loss_kg
       FROM trx_yarn_process_order_line l LEFT JOIN mst_style st ON st.id = l.style_id
      WHERE l.ypo_id = ? GROUP BY l.so_id, l.io_no, l.buyer_po_no, st.style_code ORDER BY l.io_no`, [ypoId]);
  const jobs = rows.map((r) => {
    const o = n(r.outward_kg), g = n(r.good_kg), rj = n(r.reject_kg), l = n(r.loss_kg), bal = Math.max(0, o - g - rj - l);
    return { so_id: r.so_id, io_no: r.io_no, buyer_po_no: r.buyer_po_no, style_code: r.style_code, lines: Number(r.line_count), cones: Number(r.cones),
      outward_kg: r3(o), good_kg: r3(g), reject_kg: r3(rj), loss_kg: r3(l), balance_kg: r3(bal), status: bal <= EPS ? 'COMPLETED' : 'PENDING' };
  });
  const sum = (k: 'outward_kg' | 'good_kg' | 'reject_kg' | 'loss_kg' | 'balance_kg') => r3(jobs.reduce((a, j) => a + j[k], 0));
  return { jobs, total: { outward_kg: sum('outward_kg'), good_kg: sum('good_kg'), reject_kg: sum('reject_kg'), loss_kg: sum('loss_kg'), balance_kg: sum('balance_kg') } };
}

yarnEngineRouter.get('/yarn-process/outward', requirePermission(YP.VIEW), ah(async (req, res) => {
  const q = z.object({ status: z.string().optional(), vendor_id: z.coerce.number().int().optional(), process_code: z.string().optional(),
    reprocess: z.coerce.number().int().optional(), open: z.coerce.number().int().optional() }).parse(req.query);
  const where = ['o.company_id = ?']; const p: unknown[] = [req.user!.companyId];
  if (q.status) { where.push('o.status = ?'); p.push(q.status); }
  if (q.vendor_id) { where.push('o.vendor_id = ?'); p.push(q.vendor_id); }
  if (q.process_code) { where.push('o.process_code = ?'); p.push(q.process_code); }
  if (q.reprocess !== undefined) { where.push('o.is_reprocess = ?'); p.push(q.reprocess ? 1 : 0); }
  if (q.open) where.push(`o.status IN ('CONFIRMED','PARTIALLY_RECEIVED')`);
  const rows = await query<any>(
    `SELECT o.*, v.party_name AS vendor_name, pt.name AS process_name, pt.process_mode, w.warehouse_name AS from_store,
            COUNT(l.id) AS line_count, COUNT(DISTINCT l.so_id) AS job_count, COALESCE(SUM(l.no_of_cones), 0) AS cones,
            GROUP_CONCAT(DISTINCT l.io_no ORDER BY l.io_no SEPARATOR ', ') AS jobs,
            COALESCE(SUM(l.qty_kg), 0) AS outward_kg, COALESCE(SUM(l.good_kg), 0) AS good_kg, COALESCE(SUM(l.reject_kg), 0) AS reject_kg, COALESCE(SUM(l.loss_kg), 0) AS loss_kg
       FROM trx_yarn_process_order o
       LEFT JOIN trx_yarn_process_order_line l ON l.ypo_id = o.id
       LEFT JOIN mst_party v ON v.id = o.vendor_id
       LEFT JOIN mst_yarn_process_type pt ON pt.company_id = o.company_id AND pt.code = o.process_code
       LEFT JOIN mst_warehouse w ON w.id = o.from_warehouse_id
      WHERE ${where.join(' AND ')} GROUP BY o.id ORDER BY o.id DESC LIMIT 1000`, p);
  res.json({ data: rows.map((o) => {
    const bal = ['CANCELLED', 'DRAFT'].includes(o.status) ? 0 : r3(n(o.outward_kg) - n(o.good_kg) - n(o.reject_kg) - n(o.loss_kg));
    return { ...o, outward_kg: n(o.outward_kg), good_kg: n(o.good_kg), reject_kg: n(o.reject_kg), loss_kg: n(o.loss_kg), balance_kg: Math.max(0, bal) };
  }) });
}));

yarnEngineRouter.get('/yarn-process/outward/:id', requirePermission(YP.VIEW), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const o = await queryOne<any>(
    `SELECT o.*, v.party_name AS vendor_name, v.gstin AS vendor_gstin, pt.name AS process_name, pt.process_mode, pt.default_ply, pt.ply_options, pt.changes_shade,
            pt.loss_tolerance_pct, pt.requires_qc, w.warehouse_name AS from_store, rp.reprocess_no
       FROM trx_yarn_process_order o LEFT JOIN mst_party v ON v.id = o.vendor_id
       LEFT JOIN mst_yarn_process_type pt ON pt.company_id = o.company_id AND pt.code = o.process_code
       LEFT JOIN mst_warehouse w ON w.id = o.from_warehouse_id LEFT JOIN trx_yarn_reprocess rp ON rp.id = o.reprocess_id
      WHERE o.id = ? AND o.company_id = ?`, [id, req.user!.companyId]);
  if (!o) throw NotFound('Yarn process DC not found');
  const lines = await query<any>(
    `SELECT l.*, y.yarn_name, st.style_code, g.grn_no, yp.process_no, ROUND(l.qty_kg - l.good_kg - l.reject_kg - l.loss_kg, 3) AS balance_kg
       FROM trx_yarn_process_order_line l LEFT JOIN mst_yarn y ON y.id = l.yarn_id LEFT JOIN mst_style st ON st.id = l.style_id
       LEFT JOIN trx_grn_line gl ON gl.id = l.grn_line_id LEFT JOIN trx_grn g ON g.id = gl.grn_id LEFT JOIN trx_yarn_process yp ON yp.id = l.process_id
      WHERE l.ypo_id = ? ORDER BY l.io_no, l.id`, [id]);
  const inwards = await query<any>('SELECT id, inward_no, inward_date, good_kg, reject_kg, loss_kg, challan_no, status FROM trx_yarn_process_inward WHERE ypo_id = ? ORDER BY id', [id]);
  res.json({ data: { ...o, lines: lines.map((l) => ({ ...l, qty_kg: n(l.qty_kg), balance_kg: Math.max(0, n(l.balance_kg)) })), inwards, reconciliation: await reconciliation(id) } });
}));

/** POST /yarn-process/outward — Save Draft (no stock moved) or Confirm DC (lots issued). */
yarnEngineRouter.post('/yarn-process/outward', requirePermission(YP.CREATE), ah(async (req, res) => {
  const body = outwardSchema.parse(req.body);
  const confirm = Boolean(req.body?.confirm);
  if (confirm && !can(req, YP.CONFIRM)) throw Forbidden('You can save the DC as draft; confirming needs the confirm right');
  const pt = await processType(req.user!.companyId, body.process_code);
  if (pt.is_reprocess) throw BadRequest(`${pt.name} DCs are created from the Reprocess screen`);
  const out = await transaction(async (tx) => {
    const h = await insertOutwardHeader(tx, req, body, { status: confirm ? 'CONFIRMED' : 'DRAFT' });
    const kg = await writeOutwardLines(tx, req, h, body.lines, confirm);
    return { id: h.id, ypo_no: h.ypo_no, status: confirm ? 'CONFIRMED' : 'DRAFT', outward_kg: kg };
  });
  await audit(req, 'trx_yarn_process_order', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.ypo_no} ${confirm ? `confirmed — ${out.outward_kg} KG issued` : 'saved as draft'}` });
}));

yarnEngineRouter.put('/yarn-process/outward/:id', requirePermission(YP.EDIT_DRAFT), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = outwardSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!o) throw NotFound('Yarn process DC not found');
    if (o.status !== 'DRAFT') throw BadRequest(`${o.ypo_no} is confirmed — confirmed DCs cannot be edited`);
    const pt = await processType(cid, body.process_code, tx);
    await txExecute(tx,
      `UPDATE trx_yarn_process_order SET ypo_date = ?, process_code = ?, vendor_id = ?, from_warehouse_id = ?, to_location = ?, vehicle_no = ?, challan_no = ?,
              target_shade = ?, expected_return_date = ?, remarks = ? WHERE id = ?`,
      [body.ypo_date, pt.code, body.vendor_id, body.from_warehouse_id ?? null, body.to_location ?? null, body.vehicle_no ?? null, body.challan_no ?? null,
       body.target_shade ?? null, body.expected_return_date ?? null, body.remarks ?? null, id]);
    await txExecute(tx, 'DELETE FROM trx_yarn_process_order_line WHERE ypo_id = ?', [id]);
    const kg = await writeOutwardLines(tx, req, { ...o, ...body, process_code: pt.code }, body.lines, false);
    return { id, ypo_no: o.ypo_no, outward_kg: kg };
  });
  await audit(req, 'trx_yarn_process_order', id, 'UPDATE', undefined, out);
  res.json({ data: out, message: `${out.ypo_no} saved` });
}));

const linesOf = async (tx: Tx, ypoId: number) => (await txQuery<any>(tx, 'SELECT * FROM trx_yarn_process_order_line WHERE ypo_id = ? ORDER BY id', [ypoId]))
  .map((l) => ({ so_id: l.so_id ? Number(l.so_id) : null, process_id: l.process_id ? Number(l.process_id) : null, grn_line_id: Number(l.grn_line_id), qty_kg: n(l.qty_kg),
    cone_no: l.cone_no, no_of_cones: Number(l.no_of_cones) || 0, target_shade: l.target_shade }));

yarnEngineRouter.post('/yarn-process/outward/:id/confirm', requirePermission(YP.CONFIRM), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const out = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!o) throw NotFound('Yarn process DC not found');
    if (o.status !== 'DRAFT') throw BadRequest(`${o.ypo_no} is already ${o.status}`);
    const lines = await linesOf(tx, id);
    if (!lines.length) throw BadRequest('The DC has no lines');
    await txExecute(tx, 'DELETE FROM trx_yarn_process_order_line WHERE ypo_id = ?', [id]);
    const kg = await writeOutwardLines(tx, req, o, lines, true);
    await txExecute(tx, `UPDATE trx_yarn_process_order SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`, [req.user!.id, id]);
    return { id, ypo_no: o.ypo_no, outward_kg: kg };
  });
  await audit(req, 'trx_yarn_process_order', id, 'UPDATE', undefined, { confirm: out });
  res.json({ data: out, message: `${out.ypo_no} confirmed — ${out.outward_kg} KG issued` });
}));

/** Cancel: a draft, or a confirmed DC with nothing received (the lots get their KG back). */
yarnEngineRouter.post('/yarn-process/outward/:id/cancel', requirePermission(YP.CANCEL), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const reason = z.string().trim().max(255).optional().parse(req.body?.reason);
  const out = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!o) throw NotFound('Yarn process DC not found');
    if (['CANCELLED', 'CLOSED'].includes(o.status)) throw BadRequest(`${o.ypo_no} is ${o.status.toLowerCase()}`);
    const recd = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_yarn_process_inward WHERE ypo_id = ? AND status <> 'CANCELLED'`, [id]);
    if (Number(recd?.c) > 0) throw BadRequest(`${o.ypo_no} already has yarn received — close it instead`);
    let back = 0;
    if (o.status !== 'DRAFT') {
      for (const l of await txQuery<any>(tx, 'SELECT * FROM trx_yarn_process_order_line WHERE ypo_id = ?', [id])) {
        const lot = await lotRow(tx, cid, Number(l.grn_line_id), true);
        await lotOut(tx, req, { lot, qty: -n(l.qty_kg), srcType: 'YARN_PROC_DC', srcId: id, srcLineId: l.id, date: new Date().toISOString().slice(0, 10), dcNo: o.ypo_no,
          vendorId: o.vendor_id, soId: l.so_id, ioNo: l.io_no, refType: 'YARN_PROC_DC_CANCEL', remarks: `DC ${o.ypo_no} cancelled` });
        await coneHistory(tx, req, { grn_line_id: lot.id, lot_no: lot.lot_no, cone_no: l.cone_no, event: 'DC_CANCELLED', ref_type: 'YPO', ref_id: id, ref_no: o.ypo_no,
          process_code: o.process_code, to: lot.warehouse_name, qty: n(l.qty_kg), so_id: l.so_id, remarks: reason ?? 'DC cancelled — back to store' });
        back += n(l.qty_kg);
      }
      if (o.reprocess_id) await txExecute(tx, `UPDATE trx_yarn_reprocess SET status = 'APPROVED', ypo_id = NULL WHERE id = ?`, [o.reprocess_id]);
    }
    await txExecute(tx, `UPDATE trx_yarn_process_order SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason ?? null, id]);
    return { ypo_no: o.ypo_no, returned_kg: r3(back) };
  });
  await audit(req, 'trx_yarn_process_order', id, 'UPDATE', undefined, { cancel: out, reason });
  res.json({ data: out, message: `${out.ypo_no} cancelled${out.returned_kg ? ` — ${out.returned_kg} KG back in the lots` : ''}` });
}));

/** Close a part-received DC: the KG still at the unit is written off as process loss (doc §23 → Closed). */
yarnEngineRouter.post('/yarn-process/outward/:id/close', requirePermission(YP.CONFIRM), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const reason = z.string().trim().min(3, 'Give the reason for closing').max(255).parse(req.body?.reason);
  const out = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!o) throw NotFound('Yarn process DC not found');
    if (!['CONFIRMED', 'PARTIALLY_RECEIVED', 'COMPLETED'].includes(o.status)) throw BadRequest(`${o.ypo_no} is ${o.status}`);
    const open = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_yarn_process_inward WHERE ypo_id = ? AND status NOT IN ('POSTED','CANCELLED')`, [id]);
    if (Number(open?.c)) throw BadRequest(`${o.ypo_no} has a GRN not posted yet — post or cancel it first`);
    let short = 0;
    for (const l of await txQuery<any>(tx, 'SELECT * FROM trx_yarn_process_order_line WHERE ypo_id = ?', [id])) {
      const bal = r3(n(l.qty_kg) - n(l.good_kg) - n(l.reject_kg) - n(l.loss_kg));
      if (bal > EPS) {
        await txExecute(tx, `UPDATE trx_yarn_process_order_line SET loss_kg = loss_kg + ?, status = 'RECEIVED' WHERE id = ?`, [bal, l.id]);
        await coneHistory(tx, req, { grn_line_id: l.grn_line_id, lot_no: l.lot_no, cone_no: l.cone_no, event: 'SHORT_CLOSED', ref_type: 'YPO', ref_id: id, ref_no: o.ypo_no,
          process_code: o.process_code, qty: bal, so_id: l.so_id, remarks: reason });
        short += bal;
      }
    }
    await txExecute(tx, `UPDATE trx_yarn_process_order SET status = 'CLOSED', close_reason = ? WHERE id = ?`, [reason, id]);
    return { ypo_no: o.ypo_no, short_kg: r3(short) };
  });
  await audit(req, 'trx_yarn_process_order', id, 'UPDATE', undefined, { close: out, reason });
  res.json({ data: out, message: `${out.ypo_no} closed${out.short_kg ? ` — ${out.short_kg} KG short written off as loss` : ''}` });
}));

// =====================================================================================
// Inward / GRN
// =====================================================================================
const inwardSchema = z.object({
  ypo_id: s.idReq(),
  inward_date: date,
  challan_no: s.nullableStr(60),
  vehicle_no: s.nullableStr(30),
  received_by: s.strReq(80),
  warehouse_id: s.idReq(),
  reject_warehouse_id: s.id(),
  loss_override_reason: s.nullableStr(255),
  remarks: s.text(),
  outputs: z.array(z.object({
    inputs: z.array(z.object({ ypo_line_id: s.idReq(), input_kg: z.coerce.number().positive(), cone_no: s.nullableStr(60) })).min(1, 'Map the input cone(s)'),
    output_cone_no: s.nullableStr(60),
    output_lot_no: s.nullableStr(80),
    yarn_id: s.id(),
    shade: s.nullableStr(80),
    ply: z.coerce.number().int().min(1).max(12).nullish(),
    no_of_cones: z.coerce.number().int().min(0).default(0),
    good_kg: z.coerce.number().min(0),
    reject_kg: z.coerce.number().min(0).default(0),
    loss_kg: z.coerce.number().min(0).default(0),
    reject_reason: s.nullableStr(160),
  })).min(1, 'Enter the output cones received'),
});
type InwardBody = z.infer<typeof inwardSchema>;
type DraftOut = InwardBody['outputs'][number] & { qc?: any };
const parseDraft = (x: any) => (typeof x === 'string' ? JSON.parse(x) : x) as Omit<InwardBody, 'outputs'> & { outputs: DraftOut[] };
const DRAFT_STATES = ['DRAFT', 'QC_PENDING', 'ACCEPTED', 'PARTIAL', 'REJECTED'];

/** Validates a GRN: process mode (one→many / many→one + ply), input KG open per DC line, tolerance, reasons. */
async function checkInward(tx: Tx, req: Request, body: InwardBody) {
  const cid = req.user!.companyId;
  const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [body.ypo_id, cid]);
  if (!o) throw NotFound('Yarn process DC not found');
  if (!['CONFIRMED', 'PARTIALLY_RECEIVED'].includes(o.status)) throw BadRequest(`${o.ypo_no} is ${o.status} — nothing to receive`);
  const pt = await processType(cid, o.process_code, tx);
  const lines = await txQuery<any>(tx, 'SELECT * FROM trx_yarn_process_order_line WHERE ypo_id = ? FOR UPDATE', [o.id]);
  const byId = new Map(lines.map((l) => [Number(l.id), l]));
  const plyOk = String(pt.ply_options ?? '').split(',').map((x) => Number(x.trim())).filter(Boolean);
  const use = new Map<number, number>();
  let inTot = 0, lossTot = 0;
  body.outputs.forEach((op, k) => {
    const label = `Output ${op.output_cone_no || `#${k + 1}`}`;
    const ins = op.inputs.map((i) => ({ ...i, line: byId.get(i.ypo_line_id) }));
    if (ins.some((i) => !i.line)) throw BadRequest(`${label}: an input is not a line of ${o.ypo_no}`);
    if (op.good_kg + op.reject_kg + op.loss_kg <= 0) throw BadRequest(`${label}: enter good, reject or loss KG`);
    if (op.reject_kg > 0 && !op.reject_reason) throw BadRequest(`${label}: reject KG needs a reason`);
    const inKg = r3(ins.reduce((a, i) => a + i.input_kg, 0));
    if (Math.abs(inKg - r3(op.good_kg + op.reject_kg + op.loss_kg)) > EPS) {
      throw BadRequest(`${label}: input ${inKg} KG must equal good + reject + loss (${r3(op.good_kg + op.reject_kg + op.loss_kg)} KG)`);
    }
    if (pt.process_mode === 'MANY_TO_ONE') {
      const ply = op.ply ?? pt.default_ply ?? null;
      if (ply && ins.length !== ply) throw BadRequest(`${label}: ${ply}-ply needs ${ply} input cones (${ins.length} given)`);
      if (ply && plyOk.length && !plyOk.includes(ply)) throw BadRequest(`${label}: ${ply}-ply is not allowed for ${pt.name} (${plyOk.join(' / ')})`);
    } else if (ins.length !== 1) throw BadRequest(`${label}: ${pt.name} takes one input cone per output cone`);
    if (new Set(ins.map((i) => Number(i.line.so_id) || 0)).size > 1) throw BadRequest(`${label}: input cones of different jobs cannot make one output cone`);
    ins.forEach((i) => use.set(i.ypo_line_id, (use.get(i.ypo_line_id) ?? 0) + i.input_kg));
    inTot += inKg; lossTot += op.loss_kg;
  });
  for (const [lid, kg] of use) {
    const l = byId.get(lid)!;
    const done = n(l.good_kg) + n(l.reject_kg) + n(l.loss_kg);
    if (done + kg > n(l.qty_kg) + EPS) throw BadRequest(`Lot ${l.lot_no}${l.cone_no ? ` cone ${l.cone_no}` : ''}: ${r3(done + kg)} KG accounted is more than the ${r3(n(l.qty_kg))} KG sent`);
  }
  const lossPct = inTot > 0 ? (lossTot / inTot) * 100 : 0;
  if (n(pt.loss_tolerance_pct) > 0 && lossPct > n(pt.loss_tolerance_pct) + 1e-9 && !body.loss_override_reason) {
    throw BadRequest(`Process loss ${r2(lossPct)}% is above the ${n(pt.loss_tolerance_pct)}% tolerance for ${pt.name} — give the reason to accept it`);
  }
  return { o, pt, byId };
}

/** Posts a GRN: output lots (good → store, reject → reject store), input lines accounted, DC / reprocess status. */
async function postInward(tx: Tx, req: Request, body: InwardBody, existing?: { id: number; inward_no: string }, qcRejected: Set<number> = new Set()) {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const { o, pt, byId } = await checkInward(tx, req, body);
  const no = existing?.inward_no ?? await nextDocNumber(tx, cid, 'YP_INWARD');
  // QC-rejected output cones: their good KG goes to the reject store
  const outs = body.outputs.map((op, k) => qcRejected.has(k) && op.good_kg > 0
    ? { ...op, reject_kg: r3(op.reject_kg + op.good_kg), good_kg: 0, reject_reason: op.reject_reason || 'QC rejected' } : op);
  const totG = r3(outs.reduce((a, x) => a + x.good_kg, 0)), totR = r3(outs.reduce((a, x) => a + x.reject_kg, 0)), totL = r3(outs.reduce((a, x) => a + x.loss_kg, 0));
  const rejectWh = body.reject_warehouse_id ?? body.warehouse_id;
  const vendor = await partyName(tx, o.vendor_id);
  const goodStore = await whName(tx, body.warehouse_id), rejStore = await whName(tx, rejectWh);
  const ioNos = [...new Set(outs.flatMap((op) => op.inputs.map((i) => byId.get(i.ypo_line_id)!.io_no).filter(Boolean)))];
  const grnId = totG > 0 ? await lotGrn(tx, req, { no, date: body.inward_date, warehouseId: body.warehouse_id, supplierId: o.vendor_id, ioNo: ioNos.length === 1 ? ioNos[0] : null,
    dcNo: body.challan_no, vehicleNo: body.vehicle_no, remarks: `${pt.name} output on ${o.ypo_no}` }) : null;
  const rejGrnId = totR > 0 ? await lotGrn(tx, req, { no: `${no}-RJ`, date: body.inward_date, warehouseId: rejectWh, supplierId: o.vendor_id, ioNo: ioNos.length === 1 ? ioNos[0] : null,
    dcNo: body.challan_no, remarks: `${pt.name} reject on ${o.ypo_no}`, rejected: true }) : null;
  let inwardId: number;
  const head = [body.inward_date, body.challan_no ?? null, body.vehicle_no ?? null, body.received_by, body.warehouse_id, rejectWh, grnId, rejGrnId,
    r3(totG + totR + totL), totG, totR, totL, body.remarks ?? null];
  if (existing) {
    await txExecute(tx, `UPDATE trx_yarn_process_inward SET inward_date = ?, challan_no = ?, vehicle_no = ?, received_by = ?, warehouse_id = ?, reject_warehouse_id = ?, grn_id = ?,
                           reject_grn_id = ?, input_kg = ?, good_kg = ?, reject_kg = ?, loss_kg = ?, remarks = ?, status = 'POSTED', posted_by = ?, posted_at = NOW() WHERE id = ?`, [...head, uid, existing.id]);
    inwardId = existing.id;
  } else {
    const r = await txExecute(tx,
      `INSERT INTO trx_yarn_process_inward (inward_date, challan_no, vehicle_no, received_by, warehouse_id, reject_warehouse_id, grn_id, reject_grn_id, input_kg, good_kg,
         reject_kg, loss_kg, remarks, company_id, inward_no, ypo_id, vendor_id, process_code, is_reprocess, created_by, status, posted_by, posted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'POSTED',?,NOW())`,
      [...head, cid, no, o.id, o.vendor_id, o.process_code, o.is_reprocess ? 1 : 0, uid, uid]);
    inwardId = Number(r.insertId);
  }
  const acc = new Map<number, { g: number; rj: number; l: number }>();
  const created: any[] = [];
  let seq = 0;
  for (const op of outs) {
    const ins = op.inputs.map((i) => ({ ...i, line: byId.get(i.ypo_line_id)! }));
    const first = ins[0].line;
    const inKg = ins.reduce((a, i) => a + i.input_kg, 0);
    const lotNo = op.output_lot_no || `${no}-${String(++seq).padStart(2, '0')}`;
    const cone = op.output_cone_no || null;
    const shade = op.shade || first.target_shade || (pt.changes_shade ? o.target_shade : first.shade) || null;
    const yarnId = op.yarn_id ?? (first.yarn_id ? Number(first.yarn_id) : null);
    const yarnType = pt.base_process === 'YARN_DYEING' ? 'Dyed Yarn' : pt.base_process === 'WINDING' ? 'Wound Yarn' : `${op.ply ?? pt.default_ply ?? ''}-ply Twisted`.replace(/^-/, '');
    let glId: number | null = null, rjId: number | null = null;
    if (op.good_kg > 0) {
      glId = await lotIn(tx, { grnId: grnId!, soId: first.so_id, styleId: first.style_id, yarnId, yarnType, shade, lotNo, coneNo: cone, cones: op.no_of_cones,
        qty: op.good_kg, parentId: Number(first.grn_line_id), ypoId: o.id });
      await coneHistory(tx, req, { grn_line_id: glId, lot_no: lotNo, cone_no: cone, event: o.is_reprocess ? 'REPROCESS_INWARD' : 'PROCESS_INWARD', ref_type: 'YPI', ref_id: inwardId,
        ref_no: no, process_code: pt.code, from: vendor, to: goodStore, qty: op.good_kg, so_id: first.so_id, related_grn_line_id: Number(first.grn_line_id),
        remarks: `${pt.name}${shade ? ` — ${shade}` : ''} from ${ins.map((i) => `${i.line.lot_no}${i.cone_no || i.line.cone_no ? `/${i.cone_no || i.line.cone_no}` : ''}`).join(' + ')}` });
    }
    if (op.reject_kg > 0) {
      rjId = await lotIn(tx, { grnId: rejGrnId!, soId: first.so_id, styleId: first.style_id, yarnId, yarnType, shade, lotNo: `${lotNo}-RJ`, coneNo: cone, qty: op.reject_kg,
        rejected: true, parentId: Number(first.grn_line_id), ypoId: o.id });
      await coneHistory(tx, req, { grn_line_id: rjId, lot_no: `${lotNo}-RJ`, cone_no: cone, event: 'REJECT', ref_type: 'YPI', ref_id: inwardId, ref_no: no, process_code: pt.code,
        from: vendor, to: rejStore, qty: op.reject_kg, so_id: first.so_id, related_grn_line_id: Number(first.grn_line_id), remarks: op.reject_reason });
    }
    if (op.loss_kg > 0) {
      await coneHistory(tx, req, { grn_line_id: Number(first.grn_line_id), lot_no: first.lot_no, cone_no: first.cone_no, event: 'PROCESS_LOSS', ref_type: 'YPI', ref_id: inwardId, ref_no: no,
        process_code: pt.code, from: vendor, qty: op.loss_kg, so_id: first.so_id, remarks: body.loss_override_reason ? `Process loss (${body.loss_override_reason})` : 'Process loss' });
    }
    const oi = await txExecute(tx,
      `INSERT INTO trx_yarn_process_inward_out (inward_id, ypo_id, so_id, io_no, yarn_id, output_cone_no, output_lot_no, shade, ply, no_of_cones, input_kg, good_kg, reject_kg,
         loss_kg, reject_reason, qc_status, grn_line_id, reject_grn_line_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [inwardId, o.id, first.so_id ?? null, first.io_no ?? null, yarnId, cone, lotNo, shade, op.ply ?? (pt.process_mode === 'MANY_TO_ONE' ? pt.default_ply : null), op.no_of_cones,
       r3(inKg), r3(op.good_kg), r3(op.reject_kg), r3(op.loss_kg), op.reject_reason ?? null, op.good_kg > 0 ? 'ACCEPTED' : 'REJECTED', glId, rjId]);
    // spread the output's good / reject / loss over its input cones (by input KG)
    let gL = op.good_kg, rL = op.reject_kg, lL = op.loss_kg;
    ins.forEach((i, idx) => {
      const last = idx === ins.length - 1;
      const f = inKg > 0 ? i.input_kg / inKg : 0;
      const g = last ? gL : r3(op.good_kg * f), rj = last ? rL : r3(op.reject_kg * f), l = last ? lL : r3(op.loss_kg * f);
      gL = r3(gL - g); rL = r3(rL - rj); lL = r3(lL - l);
      const a = acc.get(i.ypo_line_id) ?? { g: 0, rj: 0, l: 0 };
      a.g += g; a.rj += rj; a.l += l; acc.set(i.ypo_line_id, a);
    });
    for (const i of ins) {
      await txExecute(tx, 'INSERT INTO trx_yarn_process_inward_in (out_id, ypo_line_id, cone_no, input_kg) VALUES (?,?,?,?)', [Number(oi.insertId), i.ypo_line_id, i.cone_no ?? i.line.cone_no ?? null, r3(i.input_kg)]);
    }
    created.push({ output_lot_no: lotNo, output_cone_no: cone, good_kg: op.good_kg, reject_kg: op.reject_kg, loss_kg: op.loss_kg, grn_line_id: glId, reject_grn_line_id: rjId,
      inputs: ins.map((i) => i.line.lot_no) });
  }
  for (const [lid, a] of acc) {
    const l = byId.get(lid)!;
    const done = n(l.good_kg) + n(l.reject_kg) + n(l.loss_kg) + a.g + a.rj + a.l;
    await txExecute(tx, 'UPDATE trx_yarn_process_order_line SET good_kg = good_kg + ?, reject_kg = reject_kg + ?, loss_kg = loss_kg + ?, status = ? WHERE id = ?',
      [r3(a.g), r3(a.rj), r3(a.l), done + EPS >= n(l.qty_kg) ? 'RECEIVED' : 'PARTIAL', lid]);
  }
  const yarnId = Number([...byId.values()][0]?.yarn_id) || null;
  if (totG > 0) await postLedger(tx, { companyId: cid, warehouseId: body.warehouse_id, materialType: 'YARN', yarnId, txnType: 'PRODUCTION_IN', refType: 'YARN_PROC_GRN', refId: inwardId, qtyIn: totG, uomId: UOM_KG, createdBy: uid });
  if (totR > 0) await postLedger(tx, { companyId: cid, warehouseId: rejectWh, materialType: 'YARN', yarnId, txnType: 'PRODUCTION_IN', refType: 'YARN_PROC_REJECT', refId: inwardId, qtyIn: totR, uomId: UOM_KG, createdBy: uid });
  const left = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_yarn_process_order_line WHERE ypo_id = ? AND status <> 'RECEIVED'`, [o.id]);
  const st = Number(left?.c) === 0 ? 'COMPLETED' : 'PARTIALLY_RECEIVED';
  await txExecute(tx, 'UPDATE trx_yarn_process_order SET status = ? WHERE id = ?', [st, o.id]);
  if (o.reprocess_id) await txExecute(tx, 'UPDATE trx_yarn_reprocess SET status = ? WHERE id = ?', [st === 'COMPLETED' ? 'COMPLETED' : 'INWARD_PENDING', o.reprocess_id]);
  return { id: inwardId, inward_no: no, ypo_no: o.ypo_no, ypo_status: st, good_kg: totG, reject_kg: totR, loss_kg: totL, outputs: created };
}

async function saveDraft(tx: Tx, req: Request, body: InwardBody, o: any, status: 'DRAFT' | 'QC_PENDING', existingId?: number) {
  const cid = req.user!.companyId;
  const tot = (k: 'good_kg' | 'reject_kg' | 'loss_kg') => r3(body.outputs.reduce((a, x) => a + n(x[k]), 0));
  const json = JSON.stringify({ ...body, outputs: body.outputs.map((x) => ({ ...x, qc: null })) });
  const vals = [body.inward_date, body.challan_no ?? null, body.vehicle_no ?? null, body.received_by, body.warehouse_id, body.reject_warehouse_id ?? body.warehouse_id,
    r3(tot('good_kg') + tot('reject_kg') + tot('loss_kg')), tot('good_kg'), tot('reject_kg'), tot('loss_kg'), body.remarks ?? null, json, status];
  if (existingId) {
    await txExecute(tx, `UPDATE trx_yarn_process_inward SET inward_date = ?, challan_no = ?, vehicle_no = ?, received_by = ?, warehouse_id = ?, reject_warehouse_id = ?,
                           input_kg = ?, good_kg = ?, reject_kg = ?, loss_kg = ?, remarks = ?, draft_json = ?, status = ?, qc_by = NULL, qc_at = NULL WHERE id = ?`, [...vals, existingId]);
    await txExecute(tx, 'DELETE FROM trx_yarn_process_qc WHERE inward_id = ?', [existingId]);
    const r = await txQueryOne<any>(tx, 'SELECT inward_no FROM trx_yarn_process_inward WHERE id = ?', [existingId]);
    return { id: existingId, inward_no: r.inward_no, status };
  }
  const no = await nextDocNumber(tx, cid, 'YP_INWARD');
  const r = await txExecute(tx,
    `INSERT INTO trx_yarn_process_inward (inward_date, challan_no, vehicle_no, received_by, warehouse_id, reject_warehouse_id, input_kg, good_kg, reject_kg, loss_kg, remarks,
       draft_json, status, company_id, inward_no, ypo_id, vendor_id, process_code, is_reprocess, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [...vals, cid, no, o.id, o.vendor_id, o.process_code, o.is_reprocess ? 1 : 0, req.user!.id]);
  return { id: Number(r.insertId), inward_no: no, status };
}

yarnEngineRouter.get('/yarn-process/inward', requirePermission(YP.VIEW), ah(async (req, res) => {
  const q = z.object({ ypo_id: z.coerce.number().int().optional(), vendor_id: z.coerce.number().int().optional(), posted: z.coerce.number().int().optional() }).parse(req.query);
  const where = ['i.company_id = ?']; const p: unknown[] = [req.user!.companyId];
  if (q.ypo_id) { where.push('i.ypo_id = ?'); p.push(q.ypo_id); }
  if (q.vendor_id) { where.push('i.vendor_id = ?'); p.push(q.vendor_id); }
  if (q.posted) where.push(`i.status = 'POSTED'`);
  const rows = await query<any>(
    `SELECT i.*, o.ypo_no, v.party_name AS vendor_name, pt.name AS process_name, w.warehouse_name,
            (SELECT GROUP_CONCAT(DISTINCT x.io_no SEPARATOR ', ') FROM trx_yarn_process_inward_out x WHERE x.inward_id = i.id) AS jobs,
            (SELECT COUNT(*) FROM trx_yarn_process_inward_out x WHERE x.inward_id = i.id) AS cone_count
       FROM trx_yarn_process_inward i JOIN trx_yarn_process_order o ON o.id = i.ypo_id
       LEFT JOIN mst_party v ON v.id = i.vendor_id LEFT JOIN mst_yarn_process_type pt ON pt.company_id = i.company_id AND pt.code = i.process_code
       LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id
      WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT 1000`, p);
  rows.forEach((r: any) => { if (r.status !== 'POSTED' && r.draft_json) r.cone_count = parseDraft(r.draft_json).outputs.length; delete r.draft_json; });
  res.json({ data: rows });
}));

yarnEngineRouter.get('/yarn-process/inward/:id', requirePermission(YP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const i = await queryOne<any>(
    `SELECT i.*, o.ypo_no, o.ypo_date, v.party_name AS vendor_name, pt.name AS process_name, pt.process_mode, pt.requires_qc, w.warehouse_name, rw.warehouse_name AS reject_store
       FROM trx_yarn_process_inward i JOIN trx_yarn_process_order o ON o.id = i.ypo_id LEFT JOIN mst_party v ON v.id = i.vendor_id
       LEFT JOIN mst_yarn_process_type pt ON pt.company_id = i.company_id AND pt.code = i.process_code
       LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id LEFT JOIN mst_warehouse rw ON rw.id = i.reject_warehouse_id
      WHERE i.id = ? AND i.company_id = ?`, [id, cid]);
  if (!i) throw NotFound('Yarn process GRN not found');
  const outputs = await query<any>(
    `SELECT x.*, y.yarn_name, (SELECT GROUP_CONCAT(CONCAT(l.lot_no, IF(COALESCE(ii.cone_no, l.cone_no) IS NULL, '', CONCAT('/', COALESCE(ii.cone_no, l.cone_no))), ' (', ii.input_kg, ')') SEPARATOR ' + ')
                                 FROM trx_yarn_process_inward_in ii JOIN trx_yarn_process_order_line l ON l.id = ii.ypo_line_id WHERE ii.out_id = x.id) AS inputs
       FROM trx_yarn_process_inward_out x LEFT JOIN mst_yarn y ON y.id = x.yarn_id WHERE x.inward_id = ? ORDER BY x.io_no, x.id`, [id]);
  let draft: any = null;
  if (i.status !== 'POSTED' && i.draft_json) {
    const d = parseDraft(i.draft_json);
    const ls = await query<any>('SELECT * FROM trx_yarn_process_order_line WHERE ypo_id = ?', [i.ypo_id]);
    draft = { ...d, outputs: d.outputs.map((op, k) => ({ ...op, line_index: k, io_no: ls.find((l) => Number(l.id) === Number(op.inputs[0]?.ypo_line_id))?.io_no ?? null,
      input_text: op.inputs.map((x) => { const l = ls.find((y) => Number(y.id) === Number(x.ypo_line_id)); return `${l?.lot_no ?? '?'}${x.cone_no || l?.cone_no ? `/${x.cone_no || l?.cone_no}` : ''} (${x.input_kg})`; }).join(' + ') })) };
  }
  const qcParams = await query<any>('SELECT * FROM mst_fabric_process_qc_param WHERE company_id = ? AND process_code = ? AND is_active = 1 ORDER BY sort_order, id', [cid, i.process_code]);
  const qcResults = await query<any>('SELECT * FROM trx_yarn_process_qc WHERE inward_id = ? ORDER BY line_index, id', [id]);
  res.json({ data: { ...i, draft_json: undefined, requires_qc: !!Number(i.requires_qc), outputs, draft, qc_params: qcParams, qc_results: qcResults, reconciliation: await reconciliation(Number(i.ypo_id)) } });
}));

/** POST /yarn-process/inward — action POST (default) / DRAFT / QC. A process that requires QC cannot be posted directly. */
yarnEngineRouter.post('/yarn-process/inward', requirePermission(YP.CREATE), ah(async (req, res) => {
  const body = inwardSchema.parse(req.body);
  const action = String(req.body?.action ?? 'POST').toUpperCase();
  if (action === 'DRAFT' || action === 'QC') {
    const out = await transaction(async (tx) => { const { o } = await checkInward(tx, req, body); return saveDraft(tx, req, body, o, action === 'QC' ? 'QC_PENDING' : 'DRAFT'); });
    await audit(req, 'trx_yarn_process_inward', out.id, 'INSERT', undefined, out);
    res.status(201).json({ data: out, message: `${out.inward_no} ${out.status === 'QC_PENDING' ? 'sent for QC' : 'saved as draft'}` });
    return;
  }
  if (!can(req, YP.CONFIRM)) throw Forbidden('You can save the GRN as draft; posting needs the confirm right');
  const out = await transaction(async (tx) => {
    const { pt } = await checkInward(tx, req, body);
    if (pt.requires_qc) throw BadRequest(`${pt.name} requires QC — save the GRN and send it for QC before posting`);
    return postInward(tx, req, body);
  });
  await audit(req, 'trx_yarn_process_inward', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.inward_no} posted — good ${out.good_kg} KG, reject ${out.reject_kg} KG, loss ${out.loss_kg} KG` });
}));

yarnEngineRouter.put('/yarn-process/inward/:id', requirePermission(YP.EDIT_DRAFT), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = inwardSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const i = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_inward WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!i) throw NotFound('Yarn process GRN not found');
    if (!DRAFT_STATES.includes(i.status)) throw BadRequest(`${i.inward_no} is ${i.status} — posted GRNs cannot be edited`);
    if (Number(body.ypo_id) !== Number(i.ypo_id)) throw BadRequest('The DC of a GRN cannot change');
    const { o } = await checkInward(tx, req, body);
    return saveDraft(tx, req, body, o, String(req.body?.action ?? '').toUpperCase() === 'QC' ? 'QC_PENDING' : 'DRAFT', id);
  });
  await audit(req, 'trx_yarn_process_inward', id, 'UPDATE', undefined, out);
  res.json({ data: out, message: `${out.inward_no} saved` });
}));

yarnEngineRouter.post('/yarn-process/inward/:id/submit-qc', requirePermission(YP.CREATE), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const i = await queryOne<any>('SELECT * FROM trx_yarn_process_inward WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!i) throw NotFound('Yarn process GRN not found');
  if (i.status !== 'DRAFT') throw BadRequest(`${i.inward_no} is ${i.status}`);
  await query(`UPDATE trx_yarn_process_inward SET status = 'QC_PENDING' WHERE id = ?`, [id]);
  await audit(req, 'trx_yarn_process_inward', id, 'UPDATE', { status: 'DRAFT' }, { status: 'QC_PENDING' });
  res.json({ message: `${i.inward_no} sent for QC` });
}));

/** QC per output cone (process QC parameters → PASS / FAIL); a cone with a failed parameter cannot be accepted. */
yarnEngineRouter.post('/yarn-process/inward/:id/qc', requirePermission(YP.QC), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = z.object({
    remarks: s.nullableStr(255),
    results: z.array(z.object({ line_index: z.coerce.number().int().min(0), qc_status: z.enum(['ACCEPTED', 'REJECTED']).optional(),
      values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).default({}), remarks: s.nullableStr(255) })).min(1),
  }).parse(req.body);
  const out = await transaction(async (tx) => {
    const i = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_inward WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!i) throw NotFound('Yarn process GRN not found');
    if (!['QC_PENDING', 'ACCEPTED', 'PARTIAL', 'REJECTED'].includes(i.status)) throw BadRequest(`${i.inward_no} is ${i.status} — send it for QC first`);
    const d = parseDraft(i.draft_json);
    const params = await txQuery<any>(tx, 'SELECT * FROM mst_fabric_process_qc_param WHERE company_id = ? AND process_code = ? AND is_active = 1 ORDER BY sort_order, id', [cid, i.process_code]);
    await txExecute(tx, 'DELETE FROM trx_yarn_process_qc WHERE inward_id = ?', [id]);
    const good = d.outputs.map((op, k) => ({ k, op })).filter((x) => n(x.op.good_kg) > 0);
    for (const x of good) {
      const label = `Output ${x.op.output_cone_no || `#${x.k + 1}`}`;
      const r = b.results.find((y) => y.line_index === x.k);
      if (!r) throw BadRequest(`${label}: enter its QC result`);
      const fails: string[] = [];
      for (const p of params) {
        const raw = r.values[String(p.id)];
        const v = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        if (v === null && p.is_mandatory) throw BadRequest(`${label}: ${p.param_name} is required`);
        const fail = v !== null && ((p.min_value !== null && v < Number(p.min_value)) || (p.max_value !== null && v > Number(p.max_value)));
        if (fail) fails.push(p.param_name);
        await txExecute(tx, `INSERT INTO trx_yarn_process_qc (inward_id, line_index, output_cone_no, param_id, param_name, value, min_value, max_value, result, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, x.k, x.op.output_cone_no ?? null, p.id, p.param_name, v, p.min_value, p.max_value, v === null ? 'NA' : fail ? 'FAIL' : 'PASS', req.user!.id]);
      }
      const status = r.qc_status ?? (fails.length ? 'REJECTED' : 'ACCEPTED');
      if (status === 'ACCEPTED' && fails.length) throw BadRequest(`${label}: ${fails.join(', ')} out of range — mark it Rejected`);
      d.outputs[x.k].qc = { status, fails, remarks: r.remarks ?? null, values: r.values };
    }
    const st = good.map((x) => d.outputs[x.k].qc.status);
    const head = st.every((x) => x === 'ACCEPTED') ? 'ACCEPTED' : st.every((x) => x === 'REJECTED') ? 'REJECTED' : 'PARTIAL';
    await txExecute(tx, 'UPDATE trx_yarn_process_inward SET draft_json = ?, status = ?, qc_by = ?, qc_at = NOW(), qc_remarks = ? WHERE id = ?', [JSON.stringify(d), head, req.user!.id, b.remarks ?? null, id]);
    return { inward_no: i.inward_no, status: head, accepted: st.filter((x) => x === 'ACCEPTED').length, rejected: st.filter((x) => x === 'REJECTED').length };
  });
  await audit(req, 'trx_yarn_process_inward', id, 'UPDATE', undefined, { qc: out });
  res.json({ data: out, message: `${out.inward_no} QC: ${out.status.toLowerCase()} (${out.accepted} accepted, ${out.rejected} rejected)` });
}));

yarnEngineRouter.post('/yarn-process/inward/:id/post', requirePermission(YP.CONFIRM), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const out = await transaction(async (tx) => {
    const i = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_inward WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!i) throw NotFound('Yarn process GRN not found');
    if (i.status === 'POSTED') throw BadRequest(`${i.inward_no} is already posted`);
    if (i.status === 'QC_PENDING') throw BadRequest(`${i.inward_no} is waiting for QC`);
    if (!DRAFT_STATES.includes(i.status)) throw BadRequest(`${i.inward_no} is ${i.status}`);
    const pt = await processType(cid, i.process_code, tx);
    if (pt.requires_qc && i.status === 'DRAFT') throw BadRequest(`${pt.name} requires QC — send the GRN for QC first`);
    const d = parseDraft(i.draft_json);
    const rejected = new Set(d.outputs.map((op, k) => (op.qc?.status === 'REJECTED' ? k : -1)).filter((k) => k >= 0));
    const outs = d.outputs.map((op) => ({ ...op, reject_reason: op.qc?.status === 'REJECTED' && !op.reject_reason ? `QC rejected${op.qc.fails?.length ? `: ${op.qc.fails.join(', ')}` : ''}` : op.reject_reason }));
    return postInward(tx, req, inwardSchema.parse({ ...d, outputs: outs }), { id, inward_no: i.inward_no }, rejected);
  });
  await audit(req, 'trx_yarn_process_inward', id, 'UPDATE', undefined, { post: out });
  res.json({ data: out, message: `${out.inward_no} posted — good ${out.good_kg} KG, reject ${out.reject_kg} KG, loss ${out.loss_kg} KG` });
}));

yarnEngineRouter.post('/yarn-process/inward/:id/cancel', requirePermission(YP.EDIT_DRAFT), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const i = await queryOne<any>('SELECT * FROM trx_yarn_process_inward WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!i) throw NotFound('Yarn process GRN not found');
  if (!DRAFT_STATES.includes(i.status)) throw BadRequest(`${i.inward_no} is ${i.status} — posted GRNs cannot be cancelled`);
  await query(`UPDATE trx_yarn_process_inward SET status = 'CANCELLED' WHERE id = ?`, [id]);
  await audit(req, 'trx_yarn_process_inward', id, 'UPDATE', { status: i.status }, { status: 'CANCELLED' });
  res.json({ message: `${i.inward_no} cancelled` });
}));
