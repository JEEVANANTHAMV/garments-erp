import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import {
  PRIORITIES, RUNNING, CLOSED, n, r2, todayIso, setting, needPerm, hasPerm, lockSample, getSample, assertVersion,
  setStatus, bumpVersion, logSample, instantiateStages, blockers, deriveStatus, calendar, costTotals, allocTotals, metrics,
  processAgeDays, nextAction, currentStage, DONE,
} from './sampleCore.js';

/**
 * Sample requests (client 23-Oct-2026, "Sample-to-Order Profitability" spec §4–§6): versioned stage templates per
 * sample type, the request, its stages (owner, start / hold / resume / complete / skip / reassign / reopen, output,
 * labour), QC, internal approval, buyer submission and decision, revisions, cancel / reopen / close, attachments and
 * the timeline. Costs: sampleCost.routes.ts; allocation to orders: sampleAlloc.routes.ts.
 */
export const sampleRouter = Router();

const VIEW = requirePermission('SAMPLE.VIEW');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const reasonReq = z.string().trim().min(3, 'Give a reason').max(255);

/* ================================================================ sample types & workflow templates */

const stageSchema = z.object({
  stage_code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase().replace(/\s+/g, '_')),
  stage_name: z.string().trim().min(1, 'Stage name is required').max(80),
  step_group: z.coerce.number().int().min(1).max(99),
  department_id: s.id(),
  is_mandatory: z.coerce.boolean().default(true),
  sla_days: z.coerce.number().min(0).max(365).nullish(),
  needs_output: z.coerce.boolean().default(false),
});
const typeSchema = z.object({
  type_code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase().replace(/\s+/g, '_')),
  type_name: z.string().trim().min(1, 'Name is required').max(80),
  category: z.enum(['DEVELOPMENT', 'FIT', 'SALES', 'PRE_PRODUCTION', 'OTHER']).default('OTHER'),
  description: s.nullableStr(255),
  sort_order: z.coerce.number().int().default(0),
  is_active: z.coerce.boolean().default(true),
});

async function typesWithStages(cid: number, onlyActive: boolean) {
  const types = await query<any>(
    `SELECT t.*, w.id AS workflow_id, w.version_no, w.effective_from, w.remarks AS workflow_remarks,
            (SELECT COUNT(*) FROM trx_sample x WHERE x.sample_type_id = t.id AND x.is_deleted = 0) AS sample_count
       FROM mst_sample_type t LEFT JOIN mst_sample_workflow w ON w.sample_type_id = t.id AND w.is_current = 1
      WHERE t.company_id = ? ${onlyActive ? 'AND t.is_active = 1' : ''} ORDER BY t.sort_order, t.type_name`, [cid]);
  const wfIds = types.map((t) => t.workflow_id).filter(Boolean);
  const stages = wfIds.length ? await query<any>(
    `SELECT st.*, d.dept_name FROM mst_sample_workflow_stage st LEFT JOIN mst_department d ON d.id = st.department_id
      WHERE st.workflow_id IN (?) ORDER BY st.seq_no, st.id`, [wfIds]) : [];
  return types.map((t) => ({ ...t, stages: stages.filter((x) => Number(x.workflow_id) === Number(t.workflow_id)) }));
}

sampleRouter.get('/sample-types', requireAny('SAMPLE.VIEW', 'SAMPLE.ADMIN'), ah(async (req, res) => {
  res.json({ data: await typesWithStages(req.user!.companyId, req.query.active === '1') });
}));

sampleRouter.get('/sample-types/:id/versions', requireAny('SAMPLE.VIEW', 'SAMPLE.ADMIN'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const wfs = await query<any>(`SELECT w.*, u.full_name AS created_by_name, (SELECT COUNT(*) FROM trx_sample x WHERE x.workflow_id = w.id) AS sample_count
    FROM mst_sample_workflow w LEFT JOIN mst_user u ON u.id = w.created_by WHERE w.company_id = ? AND w.sample_type_id = ? ORDER BY w.version_no DESC`, [cid, id]);
  const stages = wfs.length ? await query<any>(`SELECT st.*, d.dept_name FROM mst_sample_workflow_stage st LEFT JOIN mst_department d ON d.id = st.department_id
    WHERE st.workflow_id IN (?) ORDER BY st.seq_no`, [wfs.map((w) => w.id)]) : [];
  res.json({ data: wfs.map((w) => ({ ...w, stages: stages.filter((x) => Number(x.workflow_id) === Number(w.id)) })) });
}));

sampleRouter.post('/sample-types', requirePermission('SAMPLE.ADMIN'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = typeSchema.parse(req.body ?? {});
  if (await queryOne(`SELECT id FROM mst_sample_type WHERE company_id = ? AND type_code = ?`, [cid, b.type_code])) throw Conflict(`Sample type ${b.type_code} already exists`);
  const id = await transaction(async (tx) => {
    const r = await txExecute(tx, `INSERT INTO mst_sample_type (company_id, type_code, type_name, category, description, sort_order, is_active) VALUES (?,?,?,?,?,?,?)`,
      [cid, b.type_code, b.type_name, b.category, b.description ?? null, b.sort_order, b.is_active ? 1 : 0]);
    await txExecute(tx, `INSERT INTO mst_sample_workflow (company_id, sample_type_id, version_no, is_current, effective_from, created_by) VALUES (?,?,1,1,CURDATE(),?)`,
      [cid, r.insertId, req.user!.id]);
    return Number(r.insertId);
  });
  await audit(req, 'mst_sample_type', id, 'INSERT', undefined, b);
  res.status(201).json({ data: { id } });
}));

sampleRouter.put('/sample-types/:id', requirePermission('SAMPLE.ADMIN'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const before = await queryOne<any>(`SELECT * FROM mst_sample_type WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!before) throw NotFound('Sample type not found');
  const b = typeSchema.omit({ type_code: true }).parse(req.body ?? {});
  await execute(`UPDATE mst_sample_type SET type_name = ?, category = ?, description = ?, sort_order = ?, is_active = ? WHERE id = ?`,
    [b.type_name, b.category, b.description ?? null, b.sort_order, b.is_active ? 1 : 0, id]);
  await audit(req, 'mst_sample_type', id, 'UPDATE', before, b);
  res.json({ data: { id } });
}));

/**
 * PUT /sample-types/:id/workflow { stages, remarks } — the stage template. A version already used by a sample is never
 * changed: a new version is made and becomes current (samples keep the version they were created with, spec §4).
 */
sampleRouter.put('/sample-types/:id/workflow', requirePermission('SAMPLE.ADMIN'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ stages: z.array(stageSchema).min(1, 'Add at least one stage').max(40), remarks: s.nullableStr(255) }).parse(req.body ?? {});
  const codes = b.stages.map((x) => x.stage_code);
  if (new Set(codes).size !== codes.length) throw BadRequest('Each stage needs its own code');
  if (!b.stages.some((x) => x.is_mandatory)) throw BadRequest('At least one stage must be mandatory');
  const out = await transaction(async (tx) => {
    const t = await txQueryOne<any>(tx, `SELECT * FROM mst_sample_type WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!t) throw NotFound('Sample type not found');
    const cur = await txQueryOne<any>(tx, `SELECT * FROM mst_sample_workflow WHERE sample_type_id = ? AND is_current = 1 ORDER BY version_no DESC LIMIT 1`, [id]);
    const used = cur ? Number((await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_sample WHERE workflow_id = ?`, [cur.id]))?.c) > 0 : true;
    let wfId: number; let version: number;
    if (cur && !used) {
      wfId = Number(cur.id); version = Number(cur.version_no);
      await txExecute(tx, `DELETE FROM mst_sample_workflow_stage WHERE workflow_id = ?`, [wfId]);
      await txExecute(tx, `UPDATE mst_sample_workflow SET remarks = ?, effective_from = CURDATE() WHERE id = ?`, [b.remarks ?? null, wfId]);
    } else {
      const mx = await txQueryOne<any>(tx, `SELECT COALESCE(MAX(version_no),0) m FROM mst_sample_workflow WHERE sample_type_id = ?`, [id]);
      version = Number(mx?.m) + 1;
      await txExecute(tx, `UPDATE mst_sample_workflow SET is_current = 0 WHERE sample_type_id = ?`, [id]);
      const r = await txExecute(tx, `INSERT INTO mst_sample_workflow (company_id, sample_type_id, version_no, is_current, effective_from, remarks, created_by) VALUES (?,?,?,1,CURDATE(),?,?)`,
        [cid, id, version, b.remarks ?? null, req.user!.id]);
      wfId = Number(r.insertId);
    }
    let seq = 0;
    for (const st of b.stages) {
      if (st.department_id && !(await txQueryOne(tx, `SELECT id FROM mst_department WHERE id = ? AND company_id = ?`, [st.department_id, cid]))) throw BadRequest(`Department of stage ${st.stage_name} not found`);
      await txExecute(tx, `INSERT INTO mst_sample_workflow_stage (workflow_id, seq_no, step_group, stage_code, stage_name, department_id, is_mandatory, sla_days, needs_output) VALUES (?,?,?,?,?,?,?,?,?)`,
        [wfId, ++seq, st.step_group, st.stage_code, st.stage_name, st.department_id ?? null, st.is_mandatory ? 1 : 0, st.sla_days ?? null, st.needs_output ? 1 : 0]);
    }
    return { workflow_id: wfId, version_no: version, new_version: !(cur && !used) };
  });
  await audit(req, 'mst_sample_type', id, 'UPDATE', undefined, { workflow: out, stages: b.stages.map((x) => x.stage_name) });
  res.json({ data: out });
}));

/* ================================================================ register / detail */

const sampleSchema = z.object({
  sample_no: s.nullableStr(40),
  sample_type_id: s.idReq(),
  style_id: s.idReq(),
  buyer_id: s.id(),
  enquiry_id: s.id(),
  branch_id: s.id(),
  qty: z.coerce.number({ error: 'Quantity is required' }).int('Whole pieces').positive('Quantity must be more than 0'),
  uom_id: s.id(),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  request_date: dateStr,
  target_date: dateStr,
  merchandiser_id: s.id(),
  coordinator_id: s.id(),
  instructions: s.text(),
  recovered_amount: z.coerce.number().min(0).nullish(),
  courier_awb: s.nullableStr(60),
  change_reason: s.nullableStr(255),
  row_version: z.coerce.number().int().nullish(),
});

/** Validates the masters of a request (company scope, style ↔ buyer). Returns the buyer to use. */
async function checkMasters(cid: number, b: any) {
  const st = await queryOne<any>(`SELECT id, buyer_id FROM mst_style WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.style_id, cid]);
  if (!st) throw BadRequest('Style not found', [{ field: 'style_id', message: 'Style not found' }]);
  const buyer = b.buyer_id ?? st.buyer_id ?? null;
  if (!buyer) throw BadRequest('Select the buyer (the style has none)', [{ field: 'buyer_id', message: 'Buyer is required' }]);
  if (st.buyer_id && Number(st.buyer_id) !== Number(buyer)) throw BadRequest('The style belongs to another buyer', [{ field: 'buyer_id', message: 'Not the buyer of this style' }]);
  if (!(await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ?`, [buyer, cid]))) throw BadRequest('Buyer not found');
  if (b.enquiry_id && !(await queryOne(`SELECT id FROM trx_enquiry WHERE id = ? AND company_id = ?`, [b.enquiry_id, cid]))) throw BadRequest('Enquiry not found');
  for (const k of ['merchandiser_id', 'coordinator_id'] as const) {
    if (b[k] && !(await queryOne(`SELECT id FROM mst_user WHERE id = ? AND company_id = ?`, [b[k], cid]))) throw BadRequest('User not found', [{ field: k, message: 'Not a user of this company' }]);
  }
  return Number(buyer);
}
function checkDates(req: Request, b: any) {
  if (b.target_date < b.request_date) {
    if (!hasPerm(req, 'SAMPLE.APPROVE')) throw BadRequest('Target date is before the request date', [{ field: 'target_date', message: 'Before the request date' }]);
    if (!b.change_reason) throw BadRequest('Target date is before the request date — give a reason', [{ field: 'change_reason', message: 'Reason required' }]);
  }
}

sampleRouter.post('/samples', requirePermission('SAMPLE.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = sampleSchema.parse(req.body ?? {});
  const submitNow = req.query.submit === '1' || req.body?.submit === true;
  checkDates(req, b);
  const buyer = await checkMasters(cid, b);
  const type = await queryOne<any>(`SELECT t.*, w.id AS workflow_id FROM mst_sample_type t LEFT JOIN mst_sample_workflow w ON w.sample_type_id = t.id AND w.is_current = 1
    WHERE t.id = ? AND t.company_id = ? AND t.is_active = 1`, [b.sample_type_id, cid]);
  if (!type) throw BadRequest('Sample type not found or inactive', [{ field: 'sample_type_id', message: 'Pick a sample type' }]);
  if (b.recovered_amount && !hasPerm(req, 'SAMPLE.COST')) needPerm(req, 'SAMPLE.COST', 'buyer-paid sample charge');
  const id = await transaction(async (tx) => {
    let no = b.sample_no?.trim().toUpperCase() || null;
    if (no) { if (await txQueryOne(tx, `SELECT id FROM trx_sample WHERE company_id = ? AND sample_no = ?`, [cid, no])) throw Conflict(`Sample no ${no} is already used`); }
    else {
      // skip numbers already used (a sample typed with its own number may sit ahead of the series)
      for (let i = 0; i < 200; i++) { no = await nextDocNumber(tx, cid, 'SAMPLE'); if (!(await txQueryOne(tx, `SELECT id FROM trx_sample WHERE company_id = ? AND sample_no = ?`, [cid, no]))) break; }
    }
    const legacy = await txQueryOne<any>(tx, `SELECT id FROM cfg_status WHERE domain = 'SAMPLE' AND code = 'REQUESTED'`);
    const r = await txExecute(tx, `INSERT INTO trx_sample (company_id, branch_id, sample_no, enquiry_id, style_id, buyer_id, sample_type, sample_type_id, workflow_id,
        request_date, target_date, qty, uom_id, priority, status_id, status, approval_status, merchandiser_id, coordinator_id, instructions, recovered_amount, courier_awb, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT','PENDING',?,?,?,?,?,?)`,
      [cid, b.branch_id ?? null, no, b.enquiry_id ?? null, b.style_id, buyer, type.type_code, type.id, type.workflow_id ?? null,
        b.request_date, b.target_date, b.qty, b.uom_id ?? null, b.priority, legacy?.id ?? null,
        b.merchandiser_id ?? req.user!.id, b.coordinator_id ?? null, b.instructions ?? null, b.recovered_amount ?? 0, b.courier_awb ?? null, req.user!.id]);
    const sid = Number(r.insertId);
    await logSample(tx, req, sid, 'SAMPLE', sid, 'CREATE', undefined, { sample_no: no, type: type.type_code, qty: b.qty, target_date: b.target_date }, b.change_reason);
    if (submitNow) await submit(tx, req, await lockSample(tx, cid, sid));
    return sid;
  });
  await audit(req, 'trx_sample', id, 'INSERT', undefined, b);
  res.status(201).json({ data: { id } });
}));

/** DRAFT → SUBMITTED: the workflow version's stages are created for revision 0. */
async function submit(tx: Tx, req: Request, s: any) {
  if (s.status !== 'DRAFT') throw BadRequest(`Only a draft can be submitted (this sample is ${s.status})`);
  if (!s.workflow_id) {
    const wf = await txQueryOne<any>(tx, `SELECT id FROM mst_sample_workflow WHERE sample_type_id = ? AND is_current = 1`, [s.sample_type_id]);
    if (!wf) throw BadRequest('This sample type has no workflow — set it up in Sample types');
    await txExecute(tx, `UPDATE trx_sample SET workflow_id = ? WHERE id = ?`, [wf.id, s.id]);
    s.workflow_id = wf.id;
  }
  const count = await instantiateStages(tx, s, 0);
  await txExecute(tx, `INSERT IGNORE INTO trx_sample_revision (sample_id, revision_no, revision_type, status, requested_by) VALUES (?,0,'INITIAL','OPEN',?)`, [s.id, req.user!.id]);
  await setStatus(tx, s, 'SUBMITTED');
  await logSample(tx, req, s.id, 'SAMPLE', s.id, 'SUBMIT', { status: 'DRAFT' }, { status: 'SUBMITTED', stages: count });
}

sampleRouter.put('/samples/:id', requirePermission('SAMPLE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = sampleSchema.parse(req.body ?? {});
  checkDates(req, b);
  const buyer = await checkMasters(cid, b);
  const out = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    if (CLOSED.includes(sm.status)) throw BadRequest(`A ${sm.status.toLowerCase()} sample cannot be edited — reopen it first`);
    const draft = sm.status === 'DRAFT';
    const changes: Record<string, [unknown, unknown]> = {};
    const cmp = (k: string, v: unknown) => { const o = sm[k] == null ? null : String(sm[k]).slice(0, k.endsWith('_date') ? 10 : undefined); const nv = v == null ? null : String(v); if (o !== nv && !(o == null && nv == null)) changes[k] = [sm[k], v]; };
    if (!draft) {
      for (const k of ['sample_type_id', 'style_id'] as const) if (Number(sm[k]) !== Number(b[k])) throw BadRequest('Sample type and style cannot change once the request is submitted');
      if (Number(sm.buyer_id) !== buyer) throw BadRequest('The buyer cannot change once the request is submitted');
    }
    const cols: Record<string, unknown> = {
      enquiry_id: b.enquiry_id ?? null, qty: b.qty, uom_id: b.uom_id ?? null, priority: b.priority, request_date: b.request_date,
      target_date: b.target_date, merchandiser_id: b.merchandiser_id ?? null, coordinator_id: b.coordinator_id ?? null,
      instructions: b.instructions ?? null, courier_awb: b.courier_awb ?? null, branch_id: b.branch_id ?? sm.branch_id ?? null,
    };
    if (draft) {
      const type = await txQueryOne<any>(tx, `SELECT t.*, w.id AS workflow_id FROM mst_sample_type t LEFT JOIN mst_sample_workflow w ON w.sample_type_id = t.id AND w.is_current = 1 WHERE t.id = ? AND t.company_id = ?`, [b.sample_type_id, cid]);
      if (!type) throw BadRequest('Sample type not found');
      Object.assign(cols, { sample_type_id: type.id, sample_type: type.type_code, workflow_id: type.workflow_id ?? null, style_id: b.style_id, buyer_id: buyer });
    }
    if (b.recovered_amount != null && n(b.recovered_amount) !== n(sm.recovered_amount)) {
      needPerm(req, 'SAMPLE.COST', 'buyer-paid sample charge');
      cols.recovered_amount = b.recovered_amount;
    }
    for (const [k, v] of Object.entries(cols)) cmp(k, v);
    if (!Object.keys(changes).length) return { id, unchanged: true };
    // after the workflow starts, a change of plan (target, quantity, instructions, sample charge) is logged with its reason
    const tracked = ['target_date', 'qty', 'instructions', 'recovered_amount', 'request_date'].filter((k) => changes[k]);
    if (!draft && tracked.length && !b.change_reason) throw BadRequest(`Give the reason for changing ${tracked.join(', ').replace(/_/g, ' ')}`, [{ field: 'change_reason', message: 'Reason required' }]);
    const keys = Object.keys(cols);
    await txExecute(tx, `UPDATE trx_sample SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
      [...keys.map((k) => cols[k] as any), req.user!.id, id]);
    await logSample(tx, req, id, 'SAMPLE', id, tracked.includes('target_date') ? 'TARGET_CHANGED' : 'UPDATE',
      Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v[0]])), Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v[1]])), b.change_reason);
    return { id, changed: Object.keys(changes) };
  });
  await audit(req, 'trx_sample', id, 'UPDATE', undefined, out);
  res.json({ data: out });
}));

sampleRouter.delete('/samples/:id', requirePermission('SAMPLE.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    if (sm.status !== 'DRAFT') throw BadRequest('Only a draft can be deleted — cancel a submitted sample instead');
    const c = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_sample_cost WHERE sample_id = ?`, [id]);
    if (Number(c?.c)) throw BadRequest('This sample has cost entries — cancel it instead');
    const gp = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_general_purchase_line WHERE sample_id = ?`, [id]);
    if (Number(gp?.c)) throw BadRequest('Purchases are booked to this sample — cancel it instead');
    await txExecute(tx, `UPDATE trx_sample SET is_deleted = 1, updated_by = ? WHERE id = ?`, [req.user!.id, id]);
    await logSample(tx, req, id, 'SAMPLE', id, 'DELETE');
  });
  await audit(req, 'trx_sample', id, 'DELETE');
  res.json({ data: { id, deleted: true } });
}));

const SAMPLE_SELECT = `
  SELECT t.*, st.style_code, st.style_name, b.party_name AS buyer_name, ty.type_name, ty.category AS type_category,
         w.version_no AS workflow_version, um.code AS uom_code, mu.full_name AS merchandiser_name, cu.full_name AS coordinator_name,
         e.enquiry_no, br.branch_name, crt.full_name AS created_by_name
    FROM trx_sample t
    LEFT JOIN mst_style st ON st.id = t.style_id
    LEFT JOIN mst_party b ON b.id = t.buyer_id
    LEFT JOIN mst_sample_type ty ON ty.id = t.sample_type_id
    LEFT JOIN mst_sample_workflow w ON w.id = t.workflow_id
    LEFT JOIN cfg_uom um ON um.id = t.uom_id
    LEFT JOIN mst_user mu ON mu.id = t.merchandiser_id
    LEFT JOIN mst_user cu ON cu.id = t.coordinator_id
    LEFT JOIN trx_enquiry e ON e.id = t.enquiry_id
    LEFT JOIN mst_branch br ON br.id = t.branch_id
    LEFT JOIN mst_user crt ON crt.id = t.created_by`;

export const PROC_SELECT = `
  SELECT p.*, d.dept_name, u.full_name AS assigned_user_name, c.party_name AS assigned_contractor_name, rw.stage_name AS rework_of_stage
    FROM trx_sample_process p
    LEFT JOIN mst_department d ON d.id = p.department_id
    LEFT JOIN mst_user u ON u.id = p.assigned_user_id
    LEFT JOIN mst_party c ON c.id = p.assigned_contractor_id
    LEFT JOIN trx_sample_process rw ON rw.id = p.rework_of_process_id`;

sampleRouter.get('/samples/:id', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const sm = await queryOne<any>(`${SAMPLE_SELECT} WHERE t.id = ? AND t.company_id = ? AND t.is_deleted = 0`, [id, cid]);
  if (!sm) throw NotFound('Sample not found');
  const [procs, revisions, qcs, subs, decisions, attachments, cal, c, a, gpWaiting] = await Promise.all([
    query<any>(`${PROC_SELECT} WHERE p.sample_id = ? ORDER BY p.revision_no, p.seq_no, p.id`, [id]),
    query<any>(`SELECT r.*, u.full_name AS requested_by_name FROM trx_sample_revision r LEFT JOIN mst_user u ON u.id = r.requested_by WHERE r.sample_id = ? ORDER BY r.revision_no`, [id]),
    query<any>(`SELECT q.*, u.full_name AS inspected_by_name, p.stage_name, rp.stage_name AS rework_stage_name FROM trx_sample_qc q LEFT JOIN mst_user u ON u.id = q.inspected_by
      LEFT JOIN trx_sample_process p ON p.id = q.process_id LEFT JOIN trx_sample_process rp ON rp.id = q.rework_process_id WHERE q.sample_id = ? ORDER BY q.id DESC`, [id]),
    query<any>(`SELECT x.*, u.full_name AS recorded_by_name FROM trx_sample_submission x LEFT JOIN mst_user u ON u.id = x.recorded_by WHERE x.sample_id = ? ORDER BY x.id DESC`, [id]),
    query<any>(`SELECT x.*, u.full_name AS decided_by_name FROM trx_sample_decision x LEFT JOIN mst_user u ON u.id = x.decided_by WHERE x.sample_id = ? ORDER BY x.id DESC`, [id]),
    query<any>(`SELECT d.*, u.full_name AS uploaded_by_name FROM trx_document_attachment d LEFT JOIN mst_user u ON u.id = d.uploaded_by
      WHERE d.company_id = ? AND d.ref_table = 'trx_sample' AND d.ref_id = ? ORDER BY d.id DESC`, [cid, id]),
    calendar(cid), costTotals(cid, [id]), allocTotals([id]),
    queryOne<any>(`SELECT COUNT(*) c FROM trx_general_purchase_line l JOIN trx_general_purchase g ON g.id = l.purchase_id
      WHERE g.company_id = ? AND l.sample_id = ? AND l.allocation_type = 'SAMPLE' AND COALESCE(g.approval_state, 'DRAFT') IN ('APPROVED','POSTED')
        AND NOT EXISTS (SELECT 1 FROM trx_sample_cost x WHERE x.company_id = g.company_id AND x.source_key = CONCAT('GP_LINE:', l.id))`, [cid, id]),
  ]);
  const cur = currentStage(sm, procs);
  const curRev = procs.filter((p) => Number(p.revision_no) === Number(sm.revision_no) && p.status !== 'CANCELLED');
  const processes = procs.map((p) => {
    const blk = p.status === 'NOT_STARTED' ? blockers(p, procs) : [];
    const due = p.started_at && p.sla_days != null ? new Date(new Date(p.started_at).getTime() + n(p.sla_days) * 86_400_000 + n(p.hold_minutes) * 60_000) : null;
    return { ...p, ready: p.status === 'NOT_STARTED' && !blk.length, blocked_by: blk.map((x) => x.stage_name),
      age_days: processAgeDays(p), sla_due_at: due, sla_breached: !!due && !DONE(p) && due.getTime() < Date.now() };
  });
  const lastQc = qcs.find((q) => Number(q.revision_no) === Number(sm.revision_no));
  res.json({ data: {
    ...sm,
    metrics: metrics(sm, c.get(id), a.get(id), cal),
    progress: { done: curRev.filter(DONE).length, total: curRev.length,
      good_qty: curRev.reduce((t, p) => t + n(p.good_qty), 0), reject_qty: curRev.reduce((t, p) => t + n(p.reject_qty), 0), rework_qty: curRev.reduce((t, p) => t + n(p.rework_qty), 0) },
    current_stage: cur ? { id: cur.id, stage_name: cur.stage_name, status: cur.status, dept_name: cur.dept_name, owner: cur.assigned_user_name ?? cur.assigned_contractor_name ?? null } : null,
    next_action: nextAction(sm, cur), last_qc_result: lastQc?.result ?? null,
    labour_rate_per_min: n(await setting(cid, 'SAMPLE_LABOUR_RATE_PER_MIN', '0')),
    purchases_to_import: n(gpWaiting?.c),
    processes, revisions, qc_inspections: qcs, submissions: subs, decisions, attachments,
  } });
}));

sampleRouter.get('/samples/:id/audit', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await getSample(cid, id);
  const rows = await query<any>(`SELECT a.*, u.full_name AS user_name FROM trx_sample_audit a LEFT JOIN mst_user u ON u.id = a.user_id
    WHERE a.company_id = ? AND a.sample_id = ? ORDER BY a.id DESC LIMIT 500`, [cid, id]);
  const plog = await query<any>(`SELECT l.*, p.stage_name, u.full_name AS user_name FROM trx_sample_process_log l JOIN trx_sample_process p ON p.id = l.process_id
    LEFT JOIN mst_user u ON u.id = l.user_id WHERE l.sample_id = ? ORDER BY l.id DESC LIMIT 500`, [id]);
  res.json({ data: rows, process_log: plog });
}));

/* ================================================================ lifecycle actions */

sampleRouter.post('/samples/:id/submit', requirePermission('SAMPLE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const rv = z.object({ row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {}).row_version;
  await transaction(async (tx) => { const sm = await lockSample(tx, cid, id); assertVersion(sm, rv); await submit(tx, req, sm); });
  res.json({ data: { id, status: 'SUBMITTED' } });
}));

/** A sample made before the workflow existed (or submitted with none) gets the stages of its type's current workflow. */
sampleRouter.post('/samples/:id/create-stages', requirePermission('SAMPLE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const out = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    if (sm.status === 'DRAFT') throw BadRequest('Submit the draft — that creates the stages');
    if (CLOSED.includes(sm.status)) throw BadRequest(`The sample is ${sm.status.toLowerCase()}`);
    const has = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_sample_process WHERE sample_id = ? AND revision_no = ? AND status <> 'CANCELLED'`, [id, sm.revision_no]);
    if (Number(has?.c)) throw BadRequest('The stages of this revision already exist');
    if (!sm.workflow_id) {
      let typeId = sm.sample_type_id;
      if (!typeId) typeId = (await txQueryOne<any>(tx, `SELECT id FROM mst_sample_type WHERE company_id = ? AND type_code = ?`, [cid, sm.sample_type]))?.id;
      const wf = typeId ? await txQueryOne<any>(tx, `SELECT id FROM mst_sample_workflow WHERE sample_type_id = ? AND is_current = 1`, [typeId]) : null;
      if (!wf) throw BadRequest('The sample type has no workflow');
      await txExecute(tx, `UPDATE trx_sample SET sample_type_id = ?, workflow_id = ? WHERE id = ?`, [typeId, wf.id, id]);
      sm.workflow_id = wf.id;
    }
    const count = await instantiateStages(tx, sm, Number(sm.revision_no));
    await txExecute(tx, `INSERT IGNORE INTO trx_sample_revision (sample_id, revision_no, revision_type, status, requested_by) VALUES (?,?,'INITIAL','OPEN',?)`, [id, sm.revision_no, req.user!.id]);
    if (!RUNNING.includes(sm.status)) await setStatus(tx, sm, 'SUBMITTED');
    else await bumpVersion(tx, id);
    await logSample(tx, req, id, 'SAMPLE', id, 'CREATE_STAGES', undefined, { stages: count });
    return { stages: count };
  });
  res.json({ data: out });
}));

sampleRouter.post('/samples/:id/cancel', requirePermission('SAMPLE.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ reason: reasonReq, row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    if (CLOSED.includes(sm.status)) throw BadRequest(`The sample is already ${sm.status.toLowerCase()}`);
    const open = await txQuery<any>(tx, `SELECT id, status FROM trx_sample_process WHERE sample_id = ? AND status IN ('NOT_STARTED','IN_PROGRESS','ON_HOLD')`, [id]);
    for (const p of open) {
      await txExecute(tx, `UPDATE trx_sample_process SET status = 'CANCELLED', hold_since = NULL WHERE id = ?`, [p.id]);
      await txExecute(tx, `INSERT INTO trx_sample_process_log (sample_id, process_id, action, from_status, to_status, reason, user_id) VALUES (?,?,'CANCEL',?,'CANCELLED',?,?)`, [id, p.id, p.status, b.reason, req.user!.id]);
    }
    const prev = sm.status;
    await setStatus(tx, sm, 'CANCELLED', { cancel_reason: b.reason, closed_at: new Date() });
    await logSample(tx, req, id, 'SAMPLE', id, 'CANCEL', { status: prev }, { status: 'CANCELLED', stages_cancelled: open.length }, b.reason);
  });
  res.json({ data: { id, status: 'CANCELLED' } });
}));

/** Reopen (authorised, with reason): a cancelled sample goes back to its stages; a completed one back to Approved. */
sampleRouter.post('/samples/:id/reopen', requirePermission('SAMPLE.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ reason: reasonReq, row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {});
  const status = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    if (!CLOSED.includes(sm.status)) throw BadRequest('Only a cancelled or completed sample can be reopened');
    const prev = sm.status;
    if (sm.status === 'COMPLETED') {
      await setStatus(tx, sm, 'APPROVED', { closed_at: null });
    } else {
      // the stages the cancel stopped come back as not started (their history stays in the stage log)
      const back = await txQuery<any>(tx, `SELECT p.id FROM trx_sample_process p WHERE p.sample_id = ? AND p.revision_no = ? AND p.status = 'CANCELLED'`, [id, sm.revision_no]);
      for (const p of back) {
        await txExecute(tx, `UPDATE trx_sample_process SET status = 'NOT_STARTED', started_at = NULL WHERE id = ?`, [p.id]);
        await txExecute(tx, `INSERT INTO trx_sample_process_log (sample_id, process_id, action, from_status, to_status, reason, user_id) VALUES (?,?,'REOPEN','CANCELLED','NOT_STARTED',?,?)`, [id, p.id, b.reason, req.user!.id]);
      }
      const dec = await txQueryOne<any>(tx, `SELECT decision FROM trx_sample_decision WHERE sample_id = ? AND stage = 'BUYER' AND revision_no = ? ORDER BY id DESC LIMIT 1`, [id, sm.revision_no]);
      const procs = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_sample_process WHERE sample_id = ? AND revision_no = ?`, [id, sm.revision_no]);
      const target = dec?.decision === 'APPROVED' ? 'APPROVED' : !Number(procs?.c) && !sm.workflow_id ? 'DRAFT' : Number(procs?.c) ? 'IN_PROGRESS' : 'SUBMITTED';
      await setStatus(tx, sm, target, { cancel_reason: null, closed_at: null });
      if (target === 'IN_PROGRESS') await deriveStatus(tx, req, sm);
    }
    await logSample(tx, req, id, 'SAMPLE', id, 'REOPEN', { status: prev }, { status: sm.status }, b.reason);
    return sm.status;
  });
  res.json({ data: { id, status } });
}));

/** Close a buyer-approved sample (its cost stays allocatable). */
sampleRouter.post('/samples/:id/close', requirePermission('SAMPLE.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ remarks: s.nullableStr(255), row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    if (sm.status !== 'APPROVED' && sm.status !== 'REJECTED') throw BadRequest('Only a buyer-approved (or rejected, not to be resubmitted) sample can be closed');
    const prev = sm.status;
    await setStatus(tx, sm, prev === 'APPROVED' ? 'COMPLETED' : 'CANCELLED', { closed_at: new Date(), ...(prev === 'REJECTED' ? { cancel_reason: b.remarks ?? 'Rejected by the buyer — not resubmitted' } : {}) });
    await logSample(tx, req, id, 'SAMPLE', id, 'CLOSE', { status: prev }, { status: sm.status }, b.remarks);
  });
  res.json({ data: { id } });
}));

/* ================================================================ stage actions (spec §6.4) */

const procBase = z.object({ row_version: z.coerce.number().int().nullish() });
async function loadProc(tx: Tx, sampleId: number, pid: number) {
  const p = await txQueryOne<any>(tx, `SELECT * FROM trx_sample_process WHERE id = ? AND sample_id = ? FOR UPDATE`, [pid, sampleId]);
  if (!p) throw NotFound('Stage not found');
  return p;
}
async function plog(tx: Tx, req: Request, p: any, action: string, from: string, to: string, extra: { good?: unknown; reject?: unknown; rework?: unknown; minutes?: unknown; reason?: string | null; details?: unknown } = {}) {
  const r = await txExecute(tx, `INSERT INTO trx_sample_process_log (sample_id, process_id, action, from_status, to_status, good_qty, reject_qty, rework_qty, minutes, reason, details, user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.sample_id, p.id, action, from, to, extra.good ?? null, extra.reject ?? null, extra.rework ?? null, extra.minutes ?? null, extra.reason ?? null,
      extra.details === undefined ? null : JSON.stringify(extra.details), req.user!.id]);
  return Number(r.insertId);
}
const ownerOf = async (tx: Tx, cid: number, b: { assigned_user_id?: number | null; assigned_contractor_id?: number | null; department_id?: number | null }) => {
  if (b.assigned_user_id && !(await txQueryOne(tx, `SELECT id FROM mst_user WHERE id = ? AND company_id = ?`, [b.assigned_user_id, cid]))) throw BadRequest('Employee not found');
  if (b.assigned_contractor_id && !(await txQueryOne(tx, `SELECT id FROM mst_party WHERE id = ? AND company_id = ?`, [b.assigned_contractor_id, cid]))) throw BadRequest('Contractor not found');
  if (b.department_id && !(await txQueryOne(tx, `SELECT id FROM mst_department WHERE id = ? AND company_id = ?`, [b.department_id, cid]))) throw BadRequest('Department not found');
};

const ACTIONS = ['start', 'hold', 'resume', 'complete', 'reassign', 'skip', 'reopen'] as const;
const actionSchema = procBase.extend({
  reason: s.nullableStr(255),
  department_id: s.id(), assigned_user_id: s.id(), assigned_contractor_id: s.id(), planned_date: s.date(),
  input_qty: z.coerce.number().min(0).nullish(), good_qty: z.coerce.number().min(0).nullish(),
  reject_qty: z.coerce.number().min(0).nullish(), rework_qty: z.coerce.number().min(0).nullish(),
  labour_minutes: z.coerce.number().min(0).max(100000).nullish(), labour_rate: z.coerce.number().min(0).max(100000).nullish(),
  remarks: s.nullableStr(500),
});

sampleRouter.post('/samples/:id/processes/:pid/:action', requireAny('SAMPLE.PROCESS', 'SAMPLE.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const pid = Number(req.params.pid);
  const action = z.enum(ACTIONS).parse(req.params.action);
  const b = actionSchema.parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    const p = await loadProc(tx, id, pid);
    if (Number(p.revision_no) !== Number(sm.revision_no)) throw BadRequest('This stage belongs to an earlier revision — its history is read-only');
    const running = RUNNING.includes(sm.status);
    const from = p.status;
    let costId: number | null = null;
    switch (action) {
      case 'start': {
        needPerm(req, 'SAMPLE.PROCESS');
        if (!running) throw BadRequest(`Stages can be worked on while the sample is submitted / in progress (it is ${sm.status.replace(/_/g, ' ').toLowerCase()})`);
        if (p.status !== 'NOT_STARTED') throw BadRequest(`The stage is ${p.status.replace(/_/g, ' ').toLowerCase()}`);
        const all = await txQuery<any>(tx, `SELECT * FROM trx_sample_process WHERE sample_id = ? AND revision_no = ?`, [id, sm.revision_no]);
        const blk = blockers(p, all);
        if (blk.length) throw BadRequest(`Complete (or skip) first: ${blk.map((x) => x.stage_name).join(', ')}`);
        await ownerOf(tx, cid, b);
        const dept = b.department_id ?? p.department_id;
        const user = b.assigned_user_id ?? p.assigned_user_id;
        const con = b.assigned_contractor_id ?? p.assigned_contractor_id;
        if (!user && !con) throw BadRequest('Name the employee or contractor doing this stage', [{ field: 'assigned_user_id', message: 'Owner required' }]);
        await txExecute(tx, `UPDATE trx_sample_process SET status = 'IN_PROGRESS', started_at = NOW(), department_id = ?, assigned_user_id = ?, assigned_contractor_id = ?,
          input_qty = COALESCE(?, input_qty), remarks = COALESCE(?, remarks), last_activity_at = NOW() WHERE id = ?`,
          [dept ?? null, user ?? null, con ?? null, b.input_qty ?? null, b.remarks ?? null, pid]);
        await plog(tx, req, p, 'START', from, 'IN_PROGRESS', { details: { department_id: dept, assigned_user_id: user, assigned_contractor_id: con } });
        break;
      }
      case 'hold': {
        needPerm(req, 'SAMPLE.PROCESS');
        if (p.status !== 'IN_PROGRESS') throw BadRequest('Only a running stage can be put on hold');
        if (!b.reason || b.reason.length < 3) throw BadRequest('Give the hold reason', [{ field: 'reason', message: 'Reason required' }]);
        await txExecute(tx, `UPDATE trx_sample_process SET status = 'ON_HOLD', hold_since = NOW(), hold_reason = ?, last_activity_at = NOW() WHERE id = ?`, [b.reason, pid]);
        await plog(tx, req, p, 'HOLD', from, 'ON_HOLD', { reason: b.reason });
        break;
      }
      case 'resume': {
        needPerm(req, 'SAMPLE.PROCESS');
        if (p.status !== 'ON_HOLD') throw BadRequest('The stage is not on hold');
        await txExecute(tx, `UPDATE trx_sample_process SET status = 'IN_PROGRESS', hold_minutes = hold_minutes + GREATEST(0, TIMESTAMPDIFF(MINUTE, hold_since, NOW())),
          hold_since = NULL, last_activity_at = NOW() WHERE id = ?`, [pid]);
        await plog(tx, req, p, 'RESUME', from, 'IN_PROGRESS', { reason: b.reason });
        break;
      }
      case 'complete': {
        needPerm(req, 'SAMPLE.PROCESS');
        if (p.status !== 'IN_PROGRESS') throw BadRequest(p.status === 'ON_HOLD' ? 'Resume the stage before completing it' : 'Start the stage before completing it');
        if (Number(p.needs_output) && b.good_qty == null) throw BadRequest('Enter the good quantity of this stage', [{ field: 'good_qty', message: 'Required' }]);
        const tot = n(b.good_qty) + n(b.reject_qty) + n(b.rework_qty);
        if (Number(p.needs_output) && tot <= 0) throw BadRequest('Enter the output (good / reject / rework) of this stage');
        if (b.input_qty != null && tot > n(b.input_qty) + 0.0001) throw BadRequest('Good + reject + rework is more than the input quantity');
        await txExecute(tx, `UPDATE trx_sample_process SET status = 'COMPLETED', completed_at = NOW(), input_qty = COALESCE(?, input_qty), good_qty = ?, reject_qty = ?, rework_qty = ?,
          labour_minutes = COALESCE(labour_minutes, 0) + ?, remarks = COALESCE(?, remarks), last_activity_at = NOW() WHERE id = ?`,
          [b.input_qty ?? null, b.good_qty ?? null, b.reject_qty ?? null, b.rework_qty ?? null, n(b.labour_minutes), b.remarks ?? null, pid]);
        const logId = await plog(tx, req, p, 'COMPLETE', from, 'COMPLETED', { good: b.good_qty, reject: b.reject_qty, rework: b.rework_qty, minutes: b.labour_minutes, reason: b.remarks });
        // the last output of the revision is the sample's good quantity until a QC inspection says otherwise
        if (b.good_qty != null) await txExecute(tx, `UPDATE trx_sample SET good_qty = ? WHERE id = ?`, [b.good_qty, id]);
        // labour = actual minutes × approved rate (spec §6.5) → a cost entry for approval
        if (n(b.labour_minutes) > 0 && n(b.labour_rate) > 0) {
          needPerm(req, 'SAMPLE.COST', 'labour cost');
          const amt = r2(n(b.labour_minutes) * n(b.labour_rate));
          const who = p.assigned_user_id ? (await txQueryOne<any>(tx, `SELECT full_name FROM mst_user WHERE id = ?`, [p.assigned_user_id]))?.full_name
            : p.assigned_contractor_id ? (await txQueryOne<any>(tx, `SELECT party_name FROM mst_party WHERE id = ?`, [p.assigned_contractor_id]))?.party_name : null;
          const r = await txExecute(tx, `INSERT INTO trx_sample_cost (company_id, sample_id, process_id, revision_no, cost_date, category, description, qty, uom_id, rate, currency_id, exchange_rate,
              amount_fc, amount, basis, source_type, source_id, source_line_id, source_ref, source_key, status, created_by, submitted_by, submitted_at)
              VALUES (?,?,?,?,?,?,?,?,(SELECT id FROM cfg_uom WHERE code = 'MIN' LIMIT 1),?,NULL,1,?,?,'ACTUAL','PROCESS_LABOUR',?,?,?,?, 'SUBMITTED', ?, ?, NOW())`,
            [cid, id, pid, sm.revision_no, todayIso(), p.rework_of_process_id ? 'REWORK' : 'LABOUR',
              `${p.stage_name} labour${who ? ` — ${who}` : ''} (${n(b.labour_minutes)} min × ₹${n(b.labour_rate)}/min)`.slice(0, 255),
              b.labour_minutes, b.labour_rate, amt, amt, pid, logId, `Stage ${p.stage_code}`, `PROC_LABOUR:${pid}:${logId}`, req.user!.id, req.user!.id]);
          costId = Number(r.insertId);
          await logSample(tx, req, id, 'COST', costId, 'CREATE', undefined, { category: 'LABOUR', amount: amt, from_stage: p.stage_name });
        }
        break;
      }
      case 'reassign': {
        needPerm(req, 'SAMPLE.PROCESS');
        if (DONE(p) || p.status === 'CANCELLED') throw BadRequest('A finished stage cannot be reassigned');
        await ownerOf(tx, cid, b);
        const next = {
          department_id: b.department_id !== undefined ? b.department_id : p.department_id,
          assigned_user_id: b.assigned_user_id !== undefined ? b.assigned_user_id : p.assigned_user_id,
          assigned_contractor_id: b.assigned_contractor_id !== undefined ? b.assigned_contractor_id : p.assigned_contractor_id,
          planned_date: b.planned_date !== undefined ? b.planned_date : p.planned_date,
        };
        if (p.status !== 'NOT_STARTED' && !next.assigned_user_id && !next.assigned_contractor_id) throw BadRequest('A running stage needs an employee or contractor');
        await txExecute(tx, `UPDATE trx_sample_process SET department_id = ?, assigned_user_id = ?, assigned_contractor_id = ?, planned_date = ?, last_activity_at = NOW() WHERE id = ?`,
          [next.department_id ?? null, next.assigned_user_id ?? null, next.assigned_contractor_id ?? null, next.planned_date ?? null, pid]);
        await plog(tx, req, p, 'REASSIGN', from, from, { reason: b.reason, details: { from: { department_id: p.department_id, assigned_user_id: p.assigned_user_id, assigned_contractor_id: p.assigned_contractor_id, planned_date: p.planned_date }, to: next } });
        break;
      }
      case 'skip': {
        if (Number(p.is_mandatory)) needPerm(req, 'SAMPLE.APPROVE', 'skip a mandatory stage'); else needPerm(req, 'SAMPLE.PROCESS');
        if (!running) throw BadRequest('Stages can be skipped while the sample is in progress');
        if (p.status !== 'NOT_STARTED') throw BadRequest('Only a stage that has not started can be skipped');
        if (!b.reason || b.reason.length < 3) throw BadRequest('Give the reason for skipping', [{ field: 'reason', message: 'Reason required' }]);
        await txExecute(tx, `UPDATE trx_sample_process SET status = 'SKIPPED', skip_reason = ?, last_activity_at = NOW() WHERE id = ?`, [b.reason, pid]);
        await plog(tx, req, p, 'SKIP', from, 'SKIPPED', { reason: b.reason });
        break;
      }
      case 'reopen': {
        needPerm(req, 'SAMPLE.APPROVE', 'reopen a stage');
        if (!['COMPLETED', 'SKIPPED'].includes(p.status)) throw BadRequest('Only a completed or skipped stage can be reopened');
        if (!['SUBMITTED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_INTERNAL_APPROVAL', 'INTERNALLY_APPROVED'].includes(sm.status)) throw BadRequest(`A ${sm.status.replace(/_/g, ' ').toLowerCase()} sample's stages cannot be reopened — start a revision`);
        if (!b.reason || b.reason.length < 3) throw BadRequest('Give the reason for reopening', [{ field: 'reason', message: 'Reason required' }]);
        const back = p.status === 'COMPLETED' ? 'IN_PROGRESS' : 'NOT_STARTED';
        await txExecute(tx, `UPDATE trx_sample_process SET status = ?, completed_at = NULL, skip_reason = NULL, last_activity_at = NOW() WHERE id = ?`, [back, pid]);
        await plog(tx, req, p, 'REOPEN', from, back, { reason: b.reason });
        break;
      }
    }
    await deriveStatus(tx, req, sm);
    await bumpVersion(tx, id);
    await logSample(tx, req, id, 'PROCESS', pid, action.toUpperCase(), { status: from }, { stage: p.stage_name, status: (await txQueryOne<any>(tx, `SELECT status FROM trx_sample_process WHERE id = ?`, [pid]))?.status }, b.reason ?? b.remarks ?? null);
    const after = await txQueryOne<any>(tx, `SELECT status, row_version FROM trx_sample WHERE id = ?`, [id]);
    return { sample_status: after?.status, row_version: after?.row_version, cost_id: costId };
  });
  res.json({ data: out });
}));

/* ================================================================ QC (spec §6.6) */

const qcSchema = z.object({
  process_id: s.id(),
  inspection_date: dateStr,
  checked_qty: z.coerce.number().positive('Checked quantity must be more than 0'),
  passed_qty: z.coerce.number().min(0),
  rejected_qty: z.coerce.number().min(0).default(0),
  rework_qty: z.coerce.number().min(0).default(0),
  measurement_result: z.enum(['OK', 'OUT_OF_TOLERANCE', 'NOT_CHECKED']).default('NOT_CHECKED'),
  measurements: z.array(z.object({ point: z.string().trim().max(80), spec: z.string().trim().max(30).nullish(), actual: z.string().trim().max(30).nullish(), tolerance: z.string().trim().max(30).nullish(), ok: z.coerce.boolean().nullish() })).max(100).nullish(),
  defects: z.array(z.object({ defect_id: s.id(), defect_name: z.string().trim().max(120), severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']).default('MINOR'), qty: z.coerce.number().min(0).default(1) })).max(100).nullish(),
  disposition: z.enum(['ACCEPT', 'REWORK', 'REJECT']),
  rework_of_process_id: s.id(),
  remarks: s.nullableStr(500),
  row_version: z.coerce.number().int().nullish(),
});

sampleRouter.post('/samples/:id/qc-inspections', requirePermission('SAMPLE.QC'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = qcSchema.parse(req.body ?? {});
  if (b.passed_qty + b.rejected_qty + b.rework_qty > b.checked_qty + 0.0001) throw BadRequest('Passed + rejected + rework is more than the checked quantity');
  const result = b.disposition === 'ACCEPT' && b.passed_qty > 0 && b.measurement_result !== 'OUT_OF_TOLERANCE' && !(b.defects ?? []).some((d) => d.severity === 'CRITICAL') ? 'PASS' : 'FAIL';
  if (b.disposition === 'ACCEPT' && result === 'FAIL') throw BadRequest('Cannot accept: no passed pieces, measurements out of tolerance or a critical defect — choose Rework or Reject');
  const out = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    if (['DRAFT', ...CLOSED].includes(sm.status)) throw BadRequest(`QC is not possible on a ${sm.status.toLowerCase()} sample`);
    if (b.process_id) { const p = await txQueryOne(tx, `SELECT id FROM trx_sample_process WHERE id = ? AND sample_id = ?`, [b.process_id, id]); if (!p) throw BadRequest('Stage not found'); }
    let reworkPid: number | null = null;
    if (b.disposition === 'REWORK') {
      // rework loop (spec §6.4): a new mandatory stage linked to the stage to redo, after the last stage of the revision
      const src = b.rework_of_process_id ? await txQueryOne<any>(tx, `SELECT * FROM trx_sample_process WHERE id = ? AND sample_id = ? AND revision_no = ?`, [b.rework_of_process_id, id, sm.revision_no]) : null;
      if (!src) throw BadRequest('Pick the stage to rework', [{ field: 'rework_of_process_id', message: 'Required for rework' }]);
      const mx = await txQueryOne<any>(tx, `SELECT COALESCE(MAX(seq_no),0) s, COALESCE(MAX(step_group),0) g FROM trx_sample_process WHERE sample_id = ? AND revision_no = ?`, [id, sm.revision_no]);
      const r = await txExecute(tx, `INSERT INTO trx_sample_process (sample_id, revision_no, workflow_stage_id, seq_no, step_group, stage_code, stage_name, department_id, is_mandatory, sla_days, needs_output,
          assigned_user_id, assigned_contractor_id, rework_of_process_id, remarks, last_activity_at) VALUES (?,?,?,?,?,?,?,?,1,?,1,?,?,?,?,NOW())`,
        [id, sm.revision_no, src.workflow_stage_id, Number(mx?.s) + 1, Number(mx?.g) + 1, `RW_${src.stage_code}`.slice(0, 30), `Rework — ${src.stage_name}`.slice(0, 80),
          src.department_id, src.sla_days, src.assigned_user_id, src.assigned_contractor_id, src.id, (b.remarks ?? 'QC rework').slice(0, 500)]);
      reworkPid = Number(r.insertId);
    }
    const r = await txExecute(tx, `INSERT INTO trx_sample_qc (sample_id, revision_no, process_id, inspection_date, checked_qty, passed_qty, rejected_qty, rework_qty, measurement_result,
        measurements, defects, result, disposition, rework_process_id, remarks, inspected_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, sm.revision_no, b.process_id ?? null, b.inspection_date, b.checked_qty, b.passed_qty, b.rejected_qty, b.rework_qty, b.measurement_result,
        b.measurements?.length ? JSON.stringify(b.measurements) : null, b.defects?.length ? JSON.stringify(b.defects) : null, result, b.disposition, reworkPid, b.remarks ?? null, req.user!.id]);
    await txExecute(tx, `UPDATE trx_sample SET good_qty = ? WHERE id = ?`, [b.passed_qty, id]);
    if (reworkPid) {
      // stages done and internally approved before the rework go back to running
      if (['PENDING_INTERNAL_APPROVAL', 'INTERNALLY_APPROVED'].includes(sm.status)) await setStatus(tx, sm, 'IN_PROGRESS', { completed_date: null });
      await deriveStatus(tx, req, sm);
    }
    await bumpVersion(tx, id);
    await logSample(tx, req, id, 'QC', Number(r.insertId), 'QC_' + result, undefined, { checked: b.checked_qty, passed: b.passed_qty, rejected: b.rejected_qty, disposition: b.disposition, rework_stage: reworkPid }, b.remarks);
    return { id: Number(r.insertId), result, rework_process_id: reworkPid };
  });
  res.status(201).json({ data: out });
}));

/* ================================================================ approvals, submissions, revisions (spec §6.6) */

const decisionSchema = z.object({
  stage: z.enum(['INTERNAL', 'BUYER']),
  decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
  decision_date: dateStr,
  comments: s.text(),
  row_version: z.coerce.number().int().nullish(),
});
sampleRouter.post('/samples/:id/approvals', requirePermission('SAMPLE.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = decisionSchema.parse(req.body ?? {});
  if (b.decision !== 'APPROVED' && !b.comments?.trim()) throw BadRequest('Write the comments (what is wrong / what has to change)', [{ field: 'comments', message: 'Required' }]);
  const status = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    let next: string;
    if (b.stage === 'INTERNAL') {
      if (sm.status !== 'PENDING_INTERNAL_APPROVAL') throw BadRequest(sm.status === 'INTERNALLY_APPROVED' ? 'Already approved internally' : 'Internal approval comes after every mandatory stage is done');
      if (b.decision === 'APPROVED') {
        const lastQc = await txQueryOne<any>(tx, `SELECT result FROM trx_sample_qc WHERE sample_id = ? AND revision_no = ? ORDER BY id DESC LIMIT 1`, [id, sm.revision_no]);
        if (lastQc?.result === 'FAIL') throw BadRequest('The latest QC inspection of this revision failed — record a passing inspection first');
        next = 'INTERNALLY_APPROVED';
      } else next = 'REVISION_REQUIRED';
    } else {
      if (sm.status !== 'SUBMITTED_TO_BUYER') throw BadRequest('Record the buyer decision after the sample is submitted to the buyer');
      next = b.decision === 'APPROVED' ? 'APPROVED' : b.decision === 'REJECTED' ? 'REJECTED' : 'REVISION_REQUIRED';
    }
    const r = await txExecute(tx, `INSERT INTO trx_sample_decision (sample_id, revision_no, stage, decision, decision_date, comments, decided_by) VALUES (?,?,?,?,?,?,?)`,
      [id, sm.revision_no, b.stage, b.decision, b.decision_date, b.comments ?? null, req.user!.id]);
    const revStatus = next === 'APPROVED' ? 'APPROVED' : next === 'REJECTED' ? 'REJECTED' : null;
    if (revStatus) await txExecute(tx, `UPDATE trx_sample_revision SET status = ?, closed_at = NOW() WHERE sample_id = ? AND revision_no = ?`, [revStatus, id, sm.revision_no]);
    const prev = sm.status;
    await setStatus(tx, sm, next, b.stage === 'BUYER' ? { buyer_decision: b.decision, buyer_comments: b.comments ?? sm.buyer_comments } : {});
    await logSample(tx, req, id, 'DECISION', Number(r.insertId), `${b.stage}_${b.decision}`, { status: prev }, { status: next }, b.comments);
    return next;
  });
  res.status(201).json({ data: { id, status } });
}));

const submissionSchema = z.object({
  submission_date: dateStr,
  qty: z.coerce.number().positive('Quantity must be more than 0'),
  courier_name: s.nullableStr(80), tracking_no: s.nullableStr(60), sent_to: s.nullableStr(120),
  evidence_url: s.nullableStr(300), remarks: s.nullableStr(500),
  row_version: z.coerce.number().int().nullish(),
});
sampleRouter.post('/samples/:id/submissions', requirePermission('SAMPLE.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = submissionSchema.parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    if (sm.status !== 'INTERNALLY_APPROVED' && sm.status !== 'SUBMITTED_TO_BUYER') throw BadRequest('Submit to the buyer after internal approval');
    const r = await txExecute(tx, `INSERT INTO trx_sample_submission (sample_id, revision_no, submission_date, qty, courier_name, tracking_no, sent_to, evidence_url, remarks, recorded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, sm.revision_no, b.submission_date, b.qty, b.courier_name ?? null, b.tracking_no ?? null, b.sent_to ?? null, b.evidence_url ?? null, b.remarks ?? null, req.user!.id]);
    await txExecute(tx, `UPDATE trx_sample_revision SET status = 'SUBMITTED', submitted_at = COALESCE(submitted_at, NOW()) WHERE sample_id = ? AND revision_no = ?`, [id, sm.revision_no]);
    const prev = sm.status;
    await setStatus(tx, sm, 'SUBMITTED_TO_BUYER', { submit_date: b.submission_date, courier_awb: b.tracking_no ?? sm.courier_awb });
    await logSample(tx, req, id, 'SUBMISSION', Number(r.insertId), 'SUBMIT_TO_BUYER', { status: prev }, { qty: b.qty, courier: b.courier_name, tracking: b.tracking_no }, b.remarks);
    return { id: Number(r.insertId) };
  });
  res.status(201).json({ data: out });
}));

/** POST /samples/:id/revisions { comments, revision_type, stage_ids? } — rework / resubmission: revision + 1, stages again. */
sampleRouter.post('/samples/:id/revisions', requirePermission('SAMPLE.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({
    comments: z.string().trim().min(3, 'Write what has to change').max(5000),
    revision_type: z.enum(['BUYER', 'INTERNAL']).default('BUYER'),
    stage_ids: z.array(z.coerce.number().int().positive()).nullish(),
    target_date: s.date(),
    row_version: z.coerce.number().int().nullish(),
  }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    assertVersion(sm, b.row_version);
    if (!['REVISION_REQUIRED', 'REJECTED'].includes(sm.status)) throw BadRequest('A revision starts after the buyer (or internal review) asks for changes or rejects the sample');
    if (!sm.workflow_id) throw BadRequest('The sample has no workflow');
    const prevRev = Number(sm.revision_no);
    const rev = prevRev + 1;
    await txExecute(tx, `UPDATE trx_sample_revision SET status = IF(status IN ('APPROVED','REJECTED'), status, 'SUPERSEDED'), closed_at = COALESCE(closed_at, NOW()) WHERE sample_id = ? AND revision_no = ?`, [id, prevRev]);
    await txExecute(tx, `UPDATE trx_sample_process SET status = 'CANCELLED' WHERE sample_id = ? AND revision_no = ? AND status IN ('NOT_STARTED')`, [id, prevRev]);
    await txExecute(tx, `INSERT INTO trx_sample_revision (sample_id, revision_no, revision_type, comments, status, requested_by) VALUES (?,?,?,?,'OPEN',?)`, [id, rev, b.revision_type, b.comments, req.user!.id]);
    await txExecute(tx, `UPDATE trx_sample SET revision_no = ?, good_qty = NULL, completed_date = NULL, buyer_decision = NULL${b.target_date ? ', target_date = ?' : ''} WHERE id = ?`,
      b.target_date ? [rev, b.target_date, id] : [rev, id]);
    sm.revision_no = rev; sm.completed_date = null;
    const count = await instantiateStages(tx, sm, rev, b.stage_ids ?? undefined);
    const prev = sm.status;
    await setStatus(tx, sm, 'SUBMITTED');
    await logSample(tx, req, id, 'REVISION', rev, 'START_REVISION', { status: prev, revision_no: prevRev }, { revision_no: rev, stages: count, ...(b.target_date ? { target_date: b.target_date } : {}) }, b.comments);
    return { revision_no: rev, stages: count };
  });
  res.status(201).json({ data: out });
}));

/* ================================================================ attachments (tech pack, photos, evidence) */

sampleRouter.post('/samples/:id/attachments', requirePermission('SAMPLE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({
    file_url: z.string().trim().min(1).max(300).refine((u) => u.startsWith('/uploads/') || /^https?:\/\//.test(u), 'Upload the file first'),
    file_name: s.nullableStr(200), mime_type: s.nullableStr(80), size_bytes: z.coerce.number().int().min(0).nullish(),
    doc_type: z.enum(['TECH_PACK', 'PHOTO', 'MEASUREMENT', 'BUYER_COMMENTS', 'COURIER', 'OTHER']).default('OTHER'),
    remarks: s.nullableStr(255),
  }).parse(req.body ?? {});
  await getSample(cid, id);
  const r = await execute(`INSERT INTO trx_document_attachment (company_id, ref_table, ref_id, doc_type, file_url, file_name, mime_type, size_bytes, remarks, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [cid, 'trx_sample', id, b.doc_type, b.file_url, b.file_name ?? null, b.mime_type ?? null, b.size_bytes ?? null, b.remarks ?? null, req.user!.id]);
  const attId = Number(r.insertId);
  await transaction((tx) => logSample(tx, req, id, 'ATTACHMENT', attId, 'ADD', undefined, { file: b.file_name ?? b.file_url, type: b.doc_type }));
  res.status(201).json({ data: { id: attId } });
}));

sampleRouter.delete('/samples/:id/attachments/:attId', requirePermission('SAMPLE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const att = await queryOne<any>(`SELECT * FROM trx_document_attachment WHERE id = ? AND company_id = ? AND ref_table = 'trx_sample' AND ref_id = ?`, [Number(req.params.attId), cid, id]);
  if (!att) throw NotFound('Attachment not found');
  await execute(`DELETE FROM trx_document_attachment WHERE id = ?`, [att.id]);
  await transaction((tx) => logSample(tx, req, id, 'ATTACHMENT', Number(att.id), 'REMOVE', { file: att.file_name ?? att.file_url, type: att.doc_type }));
  res.json({ data: { id: att.id } });
}));

