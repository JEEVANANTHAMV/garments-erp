import { Router, type Request } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { s } from '../resources/schemas.js';
import { gradeToNumber, splitList } from './labCalc.js';
import {
  P, TRIAL_TYPES, DOSAGE_UOMS, DRYING, TRIAL_EDITABLE, TRIAL_RECIPE_TARGET_EDITABLE, TRIAL_RESULT_EDITABLE, reasonReq, idemKey,
  cidOf, uidOf, idParam, n, nn, idemFrom, labAudit, notify, sampleMove, refreshRequestStatus, evaluateTrial, submissionBlockers,
  parseSnap, getRequest, getTrial, assertRowVersion, labUsers, labNumber, type PlanSnapshot,
} from './labCore.js';

/**
 * Trials (spec §4.3), wash recipe (§4.4), measurements + server-side calculation / evaluation (§4.6, §4.7), deviations
 * and submission to the Lab In-charge (§5.2). A trial is never overwritten: the target recipe freezes when the trial
 * starts, results freeze at submission, and every retest / recipe revision is a new linked trial.
 *
 *   DRAFT → (plan) PLANNED → start → IN_PROGRESS → complete → COMPLETED → submit → SUBMITTED
 *   → (Lab In-charge) LAB_REVIEWED → (QA) APPROVED | REJECTED | RETEST_REQUIRED; a return sends it back to COMPLETED.
 */
export const labTrialRouter = Router();
const VIEW = requirePermission(P.VIEW);
const TECH = requirePermission(P.UPDATE);
const dt = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/, 'Use YYYY-MM-DD HH:MM').transform((v) => v.replace('T', ' '));

const pad2 = (x: number) => String(x).padStart(2, '0');

/* ================================================================ register */
const TRIAL_SQL = `
  SELECT t.*, r.request_no, r.status AS request_status, r.priority, r.required_date, r.test_scope, r.buyer_id, r.style_id, r.color_id,
         b.party_name AS buyer_name, st.style_code, c.color_name, sm.sample_no, u.full_name AS technician_name, m.machine_code, m.name AS machine_name,
         pt.trial_no AS parent_trial_no, wp.name AS wash_process_name,
         (SELECT rp.id FROM trx_lab_report rp WHERE rp.trial_id = t.id ORDER BY rp.id DESC LIMIT 1) AS report_id,
         (SELECT rp.report_status FROM trx_lab_report rp WHERE rp.trial_id = t.id ORDER BY rp.id DESC LIMIT 1) AS report_status
    FROM trx_lab_trial t JOIN trx_lab_request r ON r.id = t.request_id
    LEFT JOIN mst_party b ON b.id = r.buyer_id LEFT JOIN mst_style st ON st.id = r.style_id LEFT JOIN mst_color c ON c.id = r.color_id
    LEFT JOIN trx_lab_sample sm ON sm.id = t.sample_id LEFT JOIN mst_user u ON u.id = t.technician_id LEFT JOIN mst_lab_machine m ON m.id = t.machine_id
    LEFT JOIN trx_lab_trial pt ON pt.id = t.parent_trial_id LEFT JOIN mst_lab_wash_process wp ON wp.company_id = t.company_id AND wp.code = t.wash_process_code`;

labTrialRouter.get('/trials', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ status: z.string().trim().max(200).optional(), request_id: s.id(), technician_id: s.id(), mine: z.enum(['0', '1']).optional(),
    result: z.enum(['PASS', 'FAIL']).optional(), q: z.string().trim().max(60).optional() }).parse(req.query);
  const where = ['t.company_id = ?']; const p: unknown[] = [cid];
  if (q.status) { where.push('t.status IN (?)'); p.push(splitList(q.status)); }
  if (q.request_id) { where.push('t.request_id = ?'); p.push(q.request_id); }
  if (q.technician_id) { where.push('t.technician_id = ?'); p.push(q.technician_id); }
  if (q.mine === '1') { where.push('t.technician_id = ?'); p.push(uidOf(req)); }
  if (q.result) { where.push('t.overall_result = ?'); p.push(q.result); }
  if (q.q) { where.push('(t.trial_no LIKE ? OR r.request_no LIKE ? OR st.style_code LIKE ? OR sm.sample_no LIKE ?)'); p.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const rows = await query<any>(`${TRIAL_SQL} WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 500`, p);
  res.json({ data: rows.map((r) => ({ ...r, plan_snapshot: undefined, test_scope: splitList(r.test_scope) })) });
}));

/* ================================================================ create */
const createSchema = z.object({
  request_id: s.idReq(), sample_id: s.id(), issue_qty: z.coerce.number().min(0).default(0), trial_type: z.enum(TRIAL_TYPES).default('INITIAL'),
  parent_trial_id: s.id(), technician_id: s.idReq(), machine_id: s.id(), planned_at: dt.nullish(), reason: s.nullableStr(255), remarks: s.nullableStr(500),
  wash_process_code: s.nullableStr(30), idempotency_key: idemKey,
});

async function assertTechnician(cid: number, uid: number) {
  if (!(await labUsers(cid, P.UPDATE)).some((u) => Number(u.id) === uid)) throw BadRequest('The technician must be an active lab user (LAB.UPDATE)');
}
async function assertMachine(tx: Tx, cid: number, id: number | null | undefined) {
  if (!id) return;
  const m = await txQueryOne<any>(tx, `SELECT status, is_active FROM mst_lab_machine WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!m || !Number(m.is_active)) throw BadRequest('Machine not found or inactive');
  if (['MAINTENANCE', 'OUT_OF_ORDER'].includes(m.status)) throw BadRequest(`The machine is ${m.status.toLowerCase().replace(/_/g, ' ')}`);
}

/** Copies a trial's recipe (stages + chemicals) into another trial. */
async function copyRecipe(tx: Tx, fromId: number, toId: number) {
  await txExecute(tx, `INSERT INTO trx_lab_trial_stage (trial_id, stage_no, process_code, target_temp, target_duration_min, water_qty_l, liquor_ratio, ph_start, ph_end, water_hardness, rpm, rinse_count, notes)
                       SELECT ?, stage_no, process_code, target_temp, target_duration_min, water_qty_l, liquor_ratio, ph_start, ph_end, water_hardness, rpm, rinse_count, notes
                         FROM trx_lab_trial_stage WHERE trial_id = ? ORDER BY stage_no`, [toId, fromId]);
  await txExecute(tx, `INSERT INTO trx_lab_trial_chemical (trial_id, stage_no, trim_id, chemical_name, chemical_lot, target_dosage, dosage_uom, added_at, remarks)
                       SELECT ?, stage_no, trim_id, chemical_name, chemical_lot, target_dosage, dosage_uom, added_at, remarks FROM trx_lab_trial_chemical WHERE trial_id = ? ORDER BY id`, [toId, fromId]);
}

/** Creates a trial inside a transaction (also used by retest / revise). Request row is locked so TRIAL-nn is unique. */
export async function createTrial(req: Request, tx: Tx, b: z.infer<typeof createSchema> & { revises_report_id?: number | null; copy_measurements_from?: number | null }) {
  const cid = cidOf(req);
  const r = await getRequest(cid, b.request_id, tx, true);
  if (!['SAMPLE_RECEIVED', 'IN_TESTING', 'PENDING_LAB_REVIEW', 'PENDING_QA_APPROVAL', 'RETEST_REQUIRED', 'REJECTED', 'APPROVED'].includes(r.status))
    throw Conflict(r.status === 'SUBMITTED' ? 'Receive the sample before creating a trial' : `A ${r.status.toLowerCase().replace(/_/g, ' ')} request cannot take a new trial`);
  if (!r.plan_snapshot) throw Conflict('The request has no test plan snapshot');
  if (b.trial_type !== 'INITIAL' && !(b.reason ?? '').trim()) throw BadRequest('Give the purpose of the variation / reason for the retest');
  let parent: any = null;
  if (b.parent_trial_id) {
    parent = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_trial WHERE id = ? AND request_id = ?`, [b.parent_trial_id, r.id]);
    if (!parent) throw BadRequest('The previous trial belongs to another request');
  } else if (['RETEST', 'RECIPE_REVISION'].includes(b.trial_type)) throw BadRequest('Choose the previous trial this one follows');
  if (b.sample_id) {
    const sm = await txQueryOne<any>(tx, `SELECT id FROM trx_lab_sample WHERE id = ? AND request_id = ?`, [b.sample_id, r.id]);
    if (!sm) throw BadRequest('The sample belongs to another request');
  }
  if (b.issue_qty > 0 && !b.sample_id) throw BadRequest('Choose the sample to issue');
  await assertMachine(tx, cid, b.machine_id);
  if (b.wash_process_code && !(await txQueryOne(tx, `SELECT id FROM mst_lab_wash_process WHERE company_id = ? AND code = ? AND is_active = 1`, [cid, b.wash_process_code])))
    throw BadRequest('Wash process not found');
  const mx = await txQueryOne<any>(tx, `SELECT COALESCE(MAX(trial_seq), 0) seq, COALESCE(MAX(recipe_revision), 0) rev FROM trx_lab_trial WHERE request_id = ?`, [r.id]);
  const seq = n(mx?.seq) + 1;
  // a retest / confirmation / buyer repeat re-runs the parent's recipe; anything else is a new recipe revision
  const sameRecipe = parent && ['RETEST', 'CONFIRMATION', 'BUYER_REPEAT'].includes(b.trial_type);
  const recipeRev = sameRecipe ? Number(parent.recipe_revision) : n(mx?.rev) + 1;
  const ins = await txExecute(tx,
    `INSERT INTO trx_lab_trial (company_id, request_id, trial_seq, trial_no, sample_id, trial_type, parent_trial_id, revises_report_id, recipe_revision, technician_id,
            machine_id, planned_at, status, reason, remarks, wash_process_code, plan_snapshot, created_by,
            batch_ref, load_weight_kg, water_qty_l, liquor_ratio, drying_method, drying_temp, drying_duration_min, finish_notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, r.id, seq, `TRIAL-${pad2(seq)}`, b.sample_id ?? parent?.sample_id ?? null, b.trial_type, parent?.id ?? null, b.revises_report_id ?? null, recipeRev,
      b.technician_id, b.machine_id ?? parent?.machine_id ?? null, b.planned_at ?? null, b.planned_at ? 'PLANNED' : 'DRAFT', b.reason ?? null, b.remarks ?? null,
      b.wash_process_code ?? parent?.wash_process_code ?? null, r.plan_snapshot, uidOf(req),
      parent?.batch_ref ?? null, parent?.load_weight_kg ?? null, parent?.water_qty_l ?? null, parent?.liquor_ratio ?? null, parent?.drying_method ?? null,
      parent?.drying_temp ?? null, parent?.drying_duration_min ?? null, parent?.finish_notes ?? null]);
  const id = Number(ins.insertId);
  if (parent) await copyRecipe(tx, Number(parent.id), id);
  if (b.copy_measurements_from) {
    await txExecute(tx, `INSERT INTO trx_lab_trial_measurement (trial_id, parameter_id, reading_stage, reading_no, numeric_value, text_value, measured_at, measured_by, remarks)
                         SELECT ?, parameter_id, reading_stage, reading_no, numeric_value, text_value, measured_at, measured_by, remarks FROM trx_lab_trial_measurement WHERE trial_id = ?`,
    [id, b.copy_measurements_from]);
    await txExecute(tx, `INSERT INTO trx_lab_trial_result (trial_id, parameter_id, result_source, external_lab_name, certificate_no, certificate_date, certificate_attachment_id, observation)
                         SELECT ?, parameter_id, result_source, external_lab_name, certificate_no, certificate_date, certificate_attachment_id, observation FROM trx_lab_trial_result WHERE trial_id = ?`,
    [id, b.copy_measurements_from]);
  }
  if (b.issue_qty > 0) await sampleMove(req, tx, Number(b.sample_id), { type: 'ISSUE', quantity: b.issue_qty, trial_id: id, reason: 'Issued at trial creation', idempotency_key: idemFrom(req, b) });
  await labAudit(req, tx, { request_id: r.id, entity_type: 'TRIAL', entity_id: id, action: 'CREATE',
    after: { trial_no: `TRIAL-${pad2(seq)}`, type: b.trial_type, parent: parent?.trial_no ?? null, recipe_revision: recipeRev, issue_qty: b.issue_qty }, remarks: b.reason ?? null });
  await refreshRequestStatus(tx, r.id);
  return { id, trial_no: `TRIAL-${pad2(seq)}`, request_no: r.request_no };
}

labTrialRouter.post('/trials', TECH, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = createSchema.parse(req.body ?? {});
  await assertTechnician(cid, b.technician_id);
  const key = idemFrom(req, b);
  if (key) {
    const prior = await queryOne<any>(`SELECT trial_id FROM trx_lab_sample_txn WHERE company_id = ? AND idempotency_key = ?`, [cid, key]);
    if (prior?.trial_id) { res.json({ data: await trialDetail(cid, Number(prior.trial_id)), replayed: true }); return; }
  }
  const out = await transaction((tx) => createTrial(req, tx, b));
  void notify(req, { userIds: [b.technician_id], title: `Trial ${out.trial_no} of ${out.request_no} assigned`, body: b.planned_at ? `Planned ${b.planned_at}` : 'New trial', ref_type: 'LAB_TRIAL', ref_id: out.id });
  res.status(201).json({ data: await trialDetail(cid, out.id) });
}));

/* ================================================================ detail */
export async function trialDetail(cid: number, id: number) {
  const t = await queryOne<any>(`${TRIAL_SQL} WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
  if (!t) throw NotFound('Trial not found');
  const snap = parseSnap(t.plan_snapshot);
  const [stages, chemicals, measurements, results, deviations, attachments, reports, children, ledger] = await Promise.all([
    query<any>(`SELECT * FROM trx_lab_trial_stage WHERE trial_id = ? ORDER BY stage_no`, [id]),
    query<any>(`SELECT ch.*, tr.trim_code FROM trx_lab_trial_chemical ch LEFT JOIN mst_trim tr ON tr.id = ch.trim_id WHERE ch.trial_id = ? ORDER BY ch.id`, [id]),
    query<any>(`SELECT ms.*, u.full_name AS measured_by_name FROM trx_lab_trial_measurement ms LEFT JOIN mst_user u ON u.id = ms.measured_by WHERE ms.trial_id = ? ORDER BY ms.parameter_id, ms.reading_stage, ms.reading_no`, [id]),
    query<any>(`SELECT rs.*, u.full_name AS overridden_by_name FROM trx_lab_trial_result rs LEFT JOIN mst_user u ON u.id = rs.overridden_by WHERE rs.trial_id = ?`, [id]),
    query<any>(`SELECT d.*, u.full_name AS reported_by_name, v.full_name AS resolved_by_name FROM trx_lab_trial_deviation d LEFT JOIN mst_user u ON u.id = d.reported_by
                  LEFT JOIN mst_user v ON v.id = d.resolved_by WHERE d.trial_id = ? ORDER BY d.id`, [id]),
    query<any>(`SELECT id, attachment_type, parameter_id, original_name, mime_type, byte_size, caption, uploaded_at FROM trx_lab_attachment WHERE trial_id = ? AND is_removed = 0 ORDER BY id`, [id]),
    query<any>(`SELECT id, report_no, revision_no, report_status, overall_result, disposition, prepared_at FROM trx_lab_report WHERE trial_id = ? ORDER BY id`, [id]),
    query<any>(`SELECT id, trial_no, trial_type, status FROM trx_lab_trial WHERE parent_trial_id = ? ORDER BY trial_seq`, [id]),
    query<any>(`SELECT l.*, sm.sample_no FROM trx_lab_sample_txn l JOIN trx_lab_sample sm ON sm.id = l.sample_id WHERE l.trial_id = ? ORDER BY l.id`, [id]),
  ]);
  const samples = await query<any>(`SELECT id, sample_no, sample_type, uom, status FROM trx_lab_sample WHERE request_id = ? ORDER BY id`, [t.request_id]);
  const issued = ledger.reduce((a, l) => a + (l.txn_type === 'ISSUE' ? n(l.quantity) : l.txn_type === 'RETURN' || l.txn_type === 'CONSUME' ? -n(l.quantity) : 0), 0);
  const totalTarget = stages.reduce((a, x) => a + n(x.target_duration_min), 0);
  const totalActual = stages.reduce((a, x) => a + n(x.actual_duration_min), 0);
  const params = (snap?.params ?? []).map((p) => ({
    ...p, result: results.find((r) => Number(r.parameter_id) === p.parameter_id) ?? null,
    readings: measurements.filter((m) => Number(m.parameter_id) === p.parameter_id),
    evidence_count: attachments.filter((a) => Number(a.parameter_id) === p.parameter_id).length,
  }));
  return {
    ...t, test_scope: splitList(t.test_scope), plan_snapshot: undefined, plan: snap ? { plan_id: snap.plan_id, plan_code: snap.plan_code, name: snap.name, version_no: snap.version_no } : null,
    params, stages, chemicals, deviations, attachments, reports, children, ledger, samples,
    sample_outstanding: Math.round(issued * 1e6) / 1e6, total_target_min: totalTarget, total_actual_min: totalActual,
    target_frozen: !TRIAL_RECIPE_TARGET_EDITABLE.includes(t.status), editable: TRIAL_EDITABLE.includes(t.status), results_editable: TRIAL_RESULT_EDITABLE.includes(t.status),
  };
}

labTrialRouter.get('/trials/:id', VIEW, ah(async (req, res) => { res.json({ data: await trialDetail(cidOf(req), idParam(req)) }); }));

/* ================================================================ update header + recipe */
const stageSchema = z.object({
  stage_no: z.coerce.number().int().min(1).max(99), process_code: z.string().trim().min(1, 'Stage process is required').max(30).transform((v) => v.toUpperCase().replace(/\s+/g, '_')),
  target_temp: z.coerce.number().min(0).max(200).nullish(), actual_temp: z.coerce.number().min(0).max(200).nullish(),
  target_duration_min: z.coerce.number().min(0).max(10000).nullish(), actual_duration_min: z.coerce.number().min(0).max(10000).nullish(),
  water_qty_l: z.coerce.number().min(0).nullish(), liquor_ratio: z.coerce.number().positive().nullish(),
  ph_start: z.coerce.number().min(0).max(14).nullish(), ph_end: z.coerce.number().min(0).max(14).nullish(), water_hardness: z.coerce.number().min(0).nullish(),
  rpm: z.coerce.number().min(0).nullish(), rinse_count: z.coerce.number().int().min(0).max(50).nullish(), notes: s.nullableStr(255),
});
const chemSchema = z.object({
  stage_no: z.coerce.number().int().min(1).max(99).nullish(), trim_id: s.id(), chemical_name: s.strReq(120), chemical_lot: s.nullableStr(60),
  target_dosage: z.coerce.number().min(0, 'Dosage cannot be negative').nullish(), actual_dosage: z.coerce.number().min(0, 'Dosage cannot be negative').nullish(),
  dosage_uom: z.enum(DOSAGE_UOMS).default('G_L'), added_at: s.nullableStr(40), remarks: s.nullableStr(255),
});
const updateSchema = z.object({
  row_version: z.coerce.number().int(), technician_id: s.id(), machine_id: s.id(), planned_at: dt.nullish(), remarks: s.nullableStr(500), reason: s.nullableStr(255),
  wash_process_code: s.nullableStr(30), batch_ref: s.nullableStr(40), load_weight_kg: z.coerce.number().positive().nullish(), water_qty_l: z.coerce.number().min(0).nullish(),
  drying_method: z.enum(DRYING).nullish(), drying_temp: z.coerce.number().min(0).max(200).nullish(), drying_duration_min: z.coerce.number().min(0).nullish(),
  finish_notes: s.nullableStr(255), operator_name: s.nullableStr(100), verified_by: s.id(),
  stages: z.array(stageSchema).max(40).optional(), chemicals: z.array(chemSchema).max(100).optional(),
});

const TARGET_STAGE = ['stage_no', 'process_code', 'target_temp', 'target_duration_min', 'water_qty_l', 'ph_start', 'rpm', 'rinse_count'] as const;
const same = (a: unknown, b: unknown) => (a == null || a === '' ? null : Number.isNaN(Number(a)) ? String(a) : Number(a)) === (b == null || b === '' ? null : Number.isNaN(Number(b)) ? String(b) : Number(b));

labTrialRouter.put('/trials/:id', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = updateSchema.parse(req.body ?? {});
  if (b.technician_id) await assertTechnician(cid, b.technician_id);
  const stageNos = (b.stages ?? []).map((x) => x.stage_no);
  if (new Set(stageNos).size !== stageNos.length) throw BadRequest('Each stage needs its own number');
  for (const c of b.chemicals ?? []) if (c.stage_no != null && !stageNos.includes(c.stage_no) && b.stages) throw BadRequest(`Chemical ${c.chemical_name}: stage ${c.stage_no} is not in the recipe`);
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    assertRowVersion(t, b.row_version);
    if (!TRIAL_EDITABLE.includes(t.status)) throw Conflict(`A ${t.status.toLowerCase().replace(/_/g, ' ')} trial cannot be changed — create a new revision / trial`);
    await assertMachine(tx, cid, b.machine_id);
    if (b.wash_process_code && !(await txQueryOne(tx, `SELECT id FROM mst_lab_wash_process WHERE company_id = ? AND code = ?`, [cid, b.wash_process_code]))) throw BadRequest('Wash process not found');
    const frozen = !TRIAL_RECIPE_TARGET_EDITABLE.includes(t.status);
    const curStages = await txQuery<any>(tx, `SELECT * FROM trx_lab_trial_stage WHERE trial_id = ? ORDER BY stage_no`, [id]);
    const curChem = await txQuery<any>(tx, `SELECT * FROM trx_lab_trial_chemical WHERE trial_id = ? ORDER BY id`, [id]);
    if (frozen) {
      // the target recipe is the immutable revision once the trial runs: only actual values may be recorded
      const msg = 'The target recipe is frozen once the trial starts — create a Recipe Revision trial to change it';
      for (const k of ['wash_process_code', 'load_weight_kg', 'water_qty_l', 'machine_id'] as const) if (b[k] !== undefined && !same(b[k], t[k])) throw Conflict(`${msg} (${k.replace(/_/g, ' ')})`);
      if (b.stages) {
        if (b.stages.length !== curStages.length) throw Conflict(msg);
        b.stages.forEach((st, i) => { for (const k of TARGET_STAGE) if (!same(st[k], curStages[i][k])) throw Conflict(`${msg} (stage ${curStages[i].stage_no} ${k.replace(/_/g, ' ')})`); });
      }
      if (b.chemicals) {
        if (b.chemicals.length !== curChem.length) throw Conflict(msg);
        b.chemicals.forEach((c, i) => { for (const k of ['stage_no', 'chemical_name', 'target_dosage', 'dosage_uom'] as const) if (!same(c[k], curChem[i][k])) throw Conflict(`${msg} (${curChem[i].chemical_name} ${k.replace(/_/g, ' ')})`); });
      }
    }
    for (const c of b.chemicals ?? []) if (c.trim_id && !(await txQueryOne(tx, `SELECT id FROM mst_trim WHERE id = ? AND company_id = ?`, [c.trim_id, cid]))) throw BadRequest(`Item for ${c.chemical_name} not found`);
    const load = b.load_weight_kg !== undefined ? b.load_weight_kg : nn(t.load_weight_kg);
    const water = b.water_qty_l !== undefined ? b.water_qty_l : nn(t.water_qty_l);
    const lr = load && water != null ? water / load : null; // liquor ratio 1 : (water L / load kg) — always server-calculated
    const set: Record<string, unknown> = {
      technician_id: b.technician_id ?? t.technician_id, machine_id: b.machine_id !== undefined ? b.machine_id : t.machine_id,
      planned_at: b.planned_at !== undefined ? b.planned_at : t.planned_at, remarks: b.remarks !== undefined ? b.remarks : t.remarks,
      reason: b.reason !== undefined ? b.reason : t.reason, wash_process_code: b.wash_process_code !== undefined ? b.wash_process_code : t.wash_process_code,
      batch_ref: b.batch_ref !== undefined ? b.batch_ref : t.batch_ref, load_weight_kg: load, water_qty_l: water, liquor_ratio: lr,
      drying_method: b.drying_method !== undefined ? b.drying_method : t.drying_method, drying_temp: b.drying_temp !== undefined ? b.drying_temp : t.drying_temp,
      drying_duration_min: b.drying_duration_min !== undefined ? b.drying_duration_min : t.drying_duration_min,
      finish_notes: b.finish_notes !== undefined ? b.finish_notes : t.finish_notes, operator_name: b.operator_name !== undefined ? b.operator_name : t.operator_name,
      verified_by: b.verified_by !== undefined ? b.verified_by : t.verified_by,
    };
    if (t.status === 'DRAFT' && set.planned_at) set.status = 'PLANNED';
    await txExecute(tx, `UPDATE trx_lab_trial SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, row_version = row_version + 1 WHERE id = ?`, [...Object.values(set), id]);
    if (b.stages) {
      await txExecute(tx, `DELETE FROM trx_lab_trial_stage WHERE trial_id = ?`, [id]);
      for (const st of b.stages) {
        const slr = st.water_qty_l != null && load ? st.water_qty_l / load : st.liquor_ratio ?? null;
        await txExecute(tx, `INSERT INTO trx_lab_trial_stage (trial_id, stage_no, process_code, target_temp, actual_temp, target_duration_min, actual_duration_min, water_qty_l, liquor_ratio,
                                ph_start, ph_end, water_hardness, rpm, rinse_count, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, st.stage_no, st.process_code, st.target_temp ?? null, st.actual_temp ?? null, st.target_duration_min ?? null, st.actual_duration_min ?? null, st.water_qty_l ?? null,
          slr, st.ph_start ?? null, st.ph_end ?? null, st.water_hardness ?? null, st.rpm ?? null, st.rinse_count ?? null, st.notes ?? null]);
      }
    }
    if (b.chemicals) {
      await txExecute(tx, `DELETE FROM trx_lab_trial_chemical WHERE trial_id = ?`, [id]);
      for (const c of b.chemicals) {
        await txExecute(tx, `INSERT INTO trx_lab_trial_chemical (trial_id, stage_no, trim_id, chemical_name, chemical_lot, target_dosage, actual_dosage, dosage_uom, added_at, remarks)
                             VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, c.stage_no ?? null, c.trim_id ?? null, c.chemical_name, c.chemical_lot ?? null, c.target_dosage ?? null, c.actual_dosage ?? null, c.dosage_uom, c.added_at ?? null, c.remarks ?? null]);
      }
    }
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'TRIAL', entity_id: id, action: frozen ? 'RECORD_ACTUALS' : 'UPDATE_RECIPE',
      before: { header: t, stages: curStages, chemicals: curChem }, after: { header: set, stages: b.stages, chemicals: b.chemicals } });
  });
  res.json({ data: await trialDetail(cid, id) });
}));

/* ================================================================ state changes */
labTrialRouter.post('/trials/:id/start', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    if (!['DRAFT', 'PLANNED'].includes(t.status)) throw Conflict(`A ${t.status.toLowerCase().replace(/_/g, ' ')} trial cannot be started`);
    if (!t.revises_report_id) {
      const out = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(CASE txn_type WHEN 'ISSUE' THEN quantity WHEN 'RETURN' THEN -quantity ELSE 0 END), 0) q FROM trx_lab_sample_txn WHERE trial_id = ?`, [id]);
      if (!(n(out?.q) > 0)) throw Conflict('Issue sample to the trial before starting it');
    }
    await txExecute(tx, `UPDATE trx_lab_trial SET status = 'IN_PROGRESS', started_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [id]);
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'TRIAL', entity_id: id, action: 'START', before: { status: t.status } });
    await refreshRequestStatus(tx, Number(t.request_id));
  });
  res.json({ data: await trialDetail(cid, id) });
}));

labTrialRouter.post('/trials/:id/complete', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    if (t.status !== 'IN_PROGRESS') throw Conflict('Only a trial in progress can be completed');
    const r = await getRequest(cid, Number(t.request_id), tx);
    if (splitList(r.test_scope).some((x) => x === 'WASHING' || x === 'COMBINED')) {
      const st = await txQuery<any>(tx, `SELECT stage_no, actual_temp, actual_duration_min FROM trx_lab_trial_stage WHERE trial_id = ?`, [id]);
      if (!st.length) throw Conflict('Record the wash recipe stages before completing a washing trial');
      const missing = st.filter((x) => x.actual_duration_min == null);
      if (missing.length) throw Conflict(`Record the actual time of stage ${missing.map((x) => x.stage_no).join(', ')}`);
    }
    await txExecute(tx, `UPDATE trx_lab_trial SET status = 'COMPLETED', completed_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [id]);
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'TRIAL', entity_id: id, action: 'COMPLETE' });
    await refreshRequestStatus(tx, Number(t.request_id));
  });
  res.json({ data: await trialDetail(cid, id) });
}));

labTrialRouter.post('/trials/:id/cancel', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ reason: reasonReq }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    if (!TRIAL_EDITABLE.includes(t.status)) throw Conflict(`A ${t.status.toLowerCase().replace(/_/g, ' ')} trial cannot be cancelled`);
    await txExecute(tx, `UPDATE trx_lab_trial SET status = 'CANCELLED', remarks = CONCAT_WS(' · ', remarks, ?), row_version = row_version + 1 WHERE id = ?`, [`Cancelled: ${b.reason}`, id]);
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'TRIAL', entity_id: id, action: 'CANCEL', before: { status: t.status }, remarks: b.reason });
    await refreshRequestStatus(tx, Number(t.request_id));
  });
  res.json({ data: await trialDetail(cid, id) });
}));

/* ================================================================ measurements → evaluation */
const measSchema = z.object({
  row_version: z.coerce.number().int().nullish(),
  measurements: z.array(z.object({
    parameter_id: s.id(), parameter_code: z.string().trim().max(40).nullish(),
    reading_stage: z.enum(['BEFORE', 'AFTER', 'SINGLE']).default('SINGLE'), reading_no: z.coerce.number().int().min(1).max(20).default(1),
    numeric_value: z.union([z.coerce.number(), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish(),
    text_value: s.nullableStr(255), unit: z.string().trim().max(20).nullish(), remarks: s.nullableStr(255),
  })).min(1).max(500),
});

labTrialRouter.post('/trials/:id/measurements', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = measSchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    assertRowVersion(t, b.row_version);
    if (!TRIAL_RESULT_EDITABLE.includes(t.status)) throw Conflict(t.status === 'DRAFT' || t.status === 'PLANNED' ? 'Start the trial before entering results'
      : `A ${t.status.toLowerCase().replace(/_/g, ' ')} trial is frozen — corrections need a return or a new revision`);
    const snap = parseSnap(t.plan_snapshot) as PlanSnapshot;
    const changes: unknown[] = [];
    for (const m of b.measurements) {
      const p = snap.params.find((x) => (m.parameter_id && x.parameter_id === m.parameter_id) || (m.parameter_code && x.code === m.parameter_code.toUpperCase()));
      if (!p) throw BadRequest(`${m.parameter_code ?? m.parameter_id} is not in the trial test plan`);
      const label = `${p.name} ${m.reading_stage} #${m.reading_no}`;
      if (p.input_type === 'BEFORE_AFTER' ? m.reading_stage === 'SINGLE' : m.reading_stage !== 'SINGLE') throw BadRequest(`${p.name}: reading stage must be ${p.input_type === 'BEFORE_AFTER' ? 'BEFORE or AFTER' : 'SINGLE'}`);
      if (m.reading_no > Math.max(p.repeat_count, 1) + 10) throw BadRequest(`${label}: too many readings`);
      if (m.unit && p.input_type === 'BEFORE_AFTER' && p.reading_unit && m.unit.toLowerCase() !== p.reading_unit.toLowerCase() && m.unit.toUpperCase() !== 'CM')
        throw BadRequest(`${label}: readings are in ${p.reading_unit}`);
      const isText = ['GRADE', 'PASS_FAIL', 'DROPDOWN', 'TEXT', 'PHOTO'].includes(p.input_type);
      let num: number | null = null; let text: string | null = null;
      if (isText) {
        text = m.text_value ?? (m.numeric_value != null ? String(m.numeric_value) : null);
        if (text != null && p.input_type === 'GRADE') {
          if (splitList(p.allowed_values).length && !splitList(p.allowed_values).includes(text)) throw BadRequest(`${label}: grade must be one of ${p.allowed_values}`);
          num = gradeToNumber(text);
        }
        if (text != null && p.input_type === 'PASS_FAIL') { text = text.toUpperCase(); if (!['PASS', 'FAIL'].includes(text)) throw BadRequest(`${label}: enter PASS or FAIL`); }
        if (text != null && p.input_type === 'DROPDOWN' && splitList(p.allowed_values).length && !splitList(p.allowed_values).includes(text)) throw BadRequest(`${label}: choose one of ${p.allowed_values}`);
      } else {
        if (m.text_value) throw BadRequest(`${label}: a number is required`);
        num = m.numeric_value ?? null;
        if (num != null && !Number.isFinite(num)) throw BadRequest(`${label}: invalid number`);
        if (num != null && Math.abs(num) >= 1e12) throw BadRequest(`${label}: value out of range`);
      }
      const prev = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_trial_measurement WHERE trial_id = ? AND parameter_id = ? AND reading_stage = ? AND reading_no = ?`,
        [id, p.parameter_id, m.reading_stage, m.reading_no]);
      if (num == null && text == null) {
        if (prev) { await txExecute(tx, `DELETE FROM trx_lab_trial_measurement WHERE id = ?`, [prev.id]); changes.push({ label, from: prev.numeric_value ?? prev.text_value, to: null }); }
        continue;
      }
      if (prev) {
        if (same(prev.numeric_value, num) && (prev.text_value ?? null) === text) continue;
        await txExecute(tx, `UPDATE trx_lab_trial_measurement SET numeric_value = ?, text_value = ?, measured_at = NOW(), measured_by = ?, remarks = ? WHERE id = ?`,
          [num, text, uidOf(req), m.remarks ?? prev.remarks ?? null, prev.id]);
        changes.push({ label, from: prev.numeric_value ?? prev.text_value, to: num ?? text });
      } else {
        await txExecute(tx, `INSERT INTO trx_lab_trial_measurement (trial_id, parameter_id, reading_stage, reading_no, numeric_value, text_value, measured_by, remarks) VALUES (?,?,?,?,?,?,?,?)`,
          [id, p.parameter_id, m.reading_stage, m.reading_no, num, text, uidOf(req), m.remarks ?? null]);
        changes.push({ label, to: num ?? text });
      }
    }
    if (changes.length) {
      await txExecute(tx, `UPDATE trx_lab_trial SET results_by = ?, row_version = row_version + 1 WHERE id = ?`, [uidOf(req), id]);
      await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'RESULT', entity_id: id, action: 'MEASUREMENTS', after: changes });
    }
    await evaluateTrial(tx, t);
  });
  res.json({ data: await trialDetail(cid, id) });
}));

labTrialRouter.post('/trials/:id/results/evaluate', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const out = await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    if (!TRIAL_RESULT_EDITABLE.includes(t.status)) throw Conflict('Results of a submitted trial are frozen');
    return evaluateTrial(tx, t);
  });
  res.json({ data: { ...(await trialDetail(cid, id)), evaluation: out } });
}));

/** Manual override of a calculated status: LAB.OVERRIDE, a reason, audited; cleared if the readings change the result. */
labTrialRouter.post('/trials/:id/results/:parameterId/override', requirePermission(P.OVERRIDE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const pid = idParam(req, 'parameterId');
  const b = z.object({ status: z.enum(['PASS', 'FAIL', 'BORDERLINE', 'NOT_APPLICABLE']).nullable(), reason: reasonReq }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    if (!TRIAL_RESULT_EDITABLE.includes(t.status)) throw Conflict('Results of a submitted trial are frozen');
    const r = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_trial_result WHERE trial_id = ? AND parameter_id = ? FOR UPDATE`, [id, pid]);
    if (!r) throw NotFound('Result not found — enter readings first');
    if (['PENDING', 'INVALID'].includes(r.calc_status) && b.status) throw Conflict('A missing or invalid reading cannot be overridden — enter the reading');
    if (b.status === null) {
      await txExecute(tx, `UPDATE trx_lab_trial_result SET evaluation_status = calc_status, is_override = 0, override_reason = NULL, overridden_by = NULL, overridden_at = NULL WHERE id = ?`, [r.id]);
    } else {
      await txExecute(tx, `UPDATE trx_lab_trial_result SET evaluation_status = ?, is_override = 1, override_reason = ?, overridden_by = ?, overridden_at = NOW() WHERE id = ?`, [b.status, b.reason, uidOf(req), r.id]);
    }
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'RESULT', entity_id: id, action: b.status ? 'OVERRIDE' : 'CLEAR_OVERRIDE',
      before: { parameter_id: pid, status: r.evaluation_status, calculated: r.calc_status }, after: { status: b.status ?? r.calc_status }, remarks: b.reason });
    await evaluateTrial(tx, t);
  });
  res.json({ data: await trialDetail(cid, id) });
}));

/** Result source (internal / external lab certificate) and observation of one parameter. */
labTrialRouter.put('/trials/:id/results/:parameterId/source', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const pid = idParam(req, 'parameterId');
  const b = z.object({
    result_source: z.enum(['INTERNAL', 'EXTERNAL']), external_lab_name: s.nullableStr(120), certificate_no: s.nullableStr(60), certificate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    certificate_attachment_id: s.id(), observation: s.nullableStr(500),
  }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    if (!TRIAL_RESULT_EDITABLE.includes(t.status)) throw Conflict('Results of a submitted trial are frozen');
    const snap = parseSnap(t.plan_snapshot)!;
    if (!snap.params.some((p) => p.parameter_id === pid)) throw BadRequest('That parameter is not in the trial test plan');
    if (b.certificate_attachment_id && !(await txQueryOne(tx, `SELECT id FROM trx_lab_attachment WHERE id = ? AND trial_id = ? AND is_removed = 0`, [b.certificate_attachment_id, id])))
      throw BadRequest('Attach the certificate to this trial first');
    const ext = b.result_source === 'EXTERNAL';
    const prev = await txQueryOne<any>(tx, `SELECT id FROM trx_lab_trial_result WHERE trial_id = ? AND parameter_id = ?`, [id, pid]);
    const vals = [b.result_source, ext ? b.external_lab_name ?? null : null, ext ? b.certificate_no ?? null : null, ext ? b.certificate_date ?? null : null,
      ext ? b.certificate_attachment_id ?? null : null, b.observation ?? null];
    if (prev) await txExecute(tx, `UPDATE trx_lab_trial_result SET result_source = ?, external_lab_name = ?, certificate_no = ?, certificate_date = ?, certificate_attachment_id = ?, observation = ? WHERE id = ?`, [...vals, prev.id]);
    else await txExecute(tx, `INSERT INTO trx_lab_trial_result (result_source, external_lab_name, certificate_no, certificate_date, certificate_attachment_id, observation, trial_id, parameter_id) VALUES (?,?,?,?,?,?,?,?)`, [...vals, id, pid]);
    await txExecute(tx, `UPDATE trx_lab_trial SET results_by = ?, row_version = row_version + 1 WHERE id = ?`, [uidOf(req), id]);
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'RESULT', entity_id: id, action: 'RESULT_SOURCE', after: { parameter_id: pid, ...b } });
    await evaluateTrial(tx, t);
  });
  res.json({ data: await trialDetail(cid, id) });
}));

/* ================================================================ deviations */
labTrialRouter.post('/trials/:id/deviations', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ stage_no: z.coerce.number().int().min(1).nullish(), deviation_type: z.enum(['TEMPERATURE', 'TIME', 'DOSAGE', 'LIQUOR', 'PH', 'MACHINE', 'OTHER']),
    target_value: s.nullableStr(40), actual_value: s.nullableStr(40), reason: reasonReq, corrective_action: s.nullableStr(255) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    if (!TRIAL_EDITABLE.includes(t.status)) throw Conflict('The trial is submitted — deviations are frozen');
    const r = await txExecute(tx, `INSERT INTO trx_lab_trial_deviation (trial_id, stage_no, deviation_type, target_value, actual_value, reason, corrective_action, reported_by) VALUES (?,?,?,?,?,?,?,?)`,
      [id, b.stage_no ?? null, b.deviation_type, b.target_value ?? null, b.actual_value ?? null, b.reason, b.corrective_action ?? null, uidOf(req)]);
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'TRIAL', entity_id: id, action: 'DEVIATION', after: { deviation_id: Number(r.insertId), ...b } });
  });
  res.status(201).json({ data: await trialDetail(cid, id) });
}));

labTrialRouter.post('/trials/:id/deviations/:devId/resolve', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const did = idParam(req, 'devId');
  const b = z.object({ corrective_action: s.strReq(255) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    if (!TRIAL_EDITABLE.includes(t.status)) throw Conflict('The trial is submitted — deviations are frozen');
    const d = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_trial_deviation WHERE id = ? AND trial_id = ?`, [did, id]);
    if (!d) throw NotFound('Deviation not found');
    await txExecute(tx, `UPDATE trx_lab_trial_deviation SET corrective_action = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?`, [b.corrective_action, uidOf(req), did]);
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'TRIAL', entity_id: id, action: 'DEVIATION_RESOLVED', before: d, after: b });
  });
  res.json({ data: await trialDetail(cid, id) });
}));

/* ================================================================ submit → report revision (frozen snapshot) */
export async function buildReportSnapshot(tx: Tx, cid: number, trialId: number, preparedBy: number) {
  const t = await txQueryOne<any>(tx, `${TRIAL_SQL} WHERE t.id = ? AND t.company_id = ?`, [trialId, cid]);
  const r = await txQueryOne<any>(tx,
    `SELECT r.*, b.party_name AS buyer_name, COALESCE(NULLIF(so.io_no, ''), so.so_no) AS job_no, st.style_code, st.style_name, c.color_name, f.fabric_name, pr.product_name
       FROM trx_lab_request r LEFT JOIN mst_party b ON b.id = r.buyer_id LEFT JOIN trx_sales_order so ON so.id = r.so_id LEFT JOIN mst_style st ON st.id = r.style_id
       LEFT JOIN mst_product pr ON pr.id = st.product_id LEFT JOIN mst_color c ON c.id = r.color_id LEFT JOIN mst_fabric f ON f.id = r.fabric_id WHERE r.id = ?`, [t.request_id]);
  const co = await txQueryOne<any>(tx, `SELECT * FROM mst_company WHERE id = ?`, [cid]);
  const snap = parseSnap(t.plan_snapshot)!;
  const stages = await txQuery<any>(tx, `SELECT stage_no, process_code, target_temp, actual_temp, target_duration_min, actual_duration_min, water_qty_l, liquor_ratio, ph_start, ph_end, water_hardness, rpm, rinse_count, notes
                                          FROM trx_lab_trial_stage WHERE trial_id = ? ORDER BY stage_no`, [trialId]);
  const chemicals = await txQuery<any>(tx, `SELECT stage_no, trim_id, chemical_name, chemical_lot, target_dosage, actual_dosage, dosage_uom, added_at, remarks FROM trx_lab_trial_chemical WHERE trial_id = ? ORDER BY id`, [trialId]);
  const ms = await txQuery<any>(tx, `SELECT parameter_id, reading_stage, reading_no, numeric_value, text_value, measured_at, measured_by FROM trx_lab_trial_measurement WHERE trial_id = ? ORDER BY parameter_id, reading_stage, reading_no`, [trialId]);
  const res = await txQuery<any>(tx, `SELECT * FROM trx_lab_trial_result WHERE trial_id = ?`, [trialId]);
  const deviations = await txQuery<any>(tx, `SELECT stage_no, deviation_type, target_value, actual_value, reason, corrective_action, reported_at, resolved_at FROM trx_lab_trial_deviation WHERE trial_id = ? ORDER BY id`, [trialId]);
  const attachments = await txQuery<any>(tx, `SELECT id, attachment_type, parameter_id, original_name, mime_type, sha256, caption, uploaded_at FROM trx_lab_attachment
                                               WHERE is_removed = 0 AND (trial_id = ? OR (sample_id = ? AND sample_id IS NOT NULL)) ORDER BY id`, [trialId, t.sample_id ?? 0]);
  const samples = await txQuery<any>(tx, `SELECT DISTINCT sm.id, sm.sample_no, sm.sample_type, sm.received_at, sm.received_qty, sm.uom, sm.lot_reference
                                           FROM trx_lab_sample sm WHERE sm.id = ? OR sm.id IN (SELECT sample_id FROM trx_lab_sample_txn WHERE trial_id = ?) ORDER BY sm.id`, [t.sample_id ?? 0, trialId]);
  const machine = t.machine_id ? await txQueryOne<any>(tx, `SELECT machine_code, name, machine_type, capacity, capacity_uom FROM mst_lab_machine WHERE id = ?`, [t.machine_id]) : null;
  const prep = await txQueryOne<any>(tx, `SELECT full_name FROM mst_user WHERE id = ?`, [preparedBy]);
  const crit = (p: any) => {
    const lo = p.min_value ?? (p.target_value != null && p.tolerance != null ? p.target_value - p.tolerance : null);
    const hi = p.max_value ?? (p.target_value != null && p.tolerance != null ? p.target_value + p.tolerance : null);
    if (p.pass_values) return `Pass: ${p.pass_values}`;
    if (p.target_value != null && p.tolerance != null && p.min_value == null && p.max_value == null) return `${p.target_value} ± ${p.tolerance}`;
    return lo != null && hi != null ? `${lo} to ${hi}` : lo != null ? `≥ ${lo}` : hi != null ? `≤ ${hi}` : 'Report only';
  };
  const results = snap.params.map((p) => {
    const x = res.find((y) => Number(y.parameter_id) === p.parameter_id) ?? {};
    return {
      parameter_id: p.parameter_id, code: p.code, name: p.name, category: p.category, method_code: p.method_code, method_name: p.method_name, standard_reference: p.standard_reference,
      method_revision: p.method_revision, unit: p.unit, reading_unit: p.reading_unit, is_mandatory: p.is_mandatory, formula_code: p.formula_code, formula_version: p.formula_version,
      precision_dp: p.precision_dp, criteria: { min: p.min_value, max: p.max_value, target: p.target_value, tolerance: p.tolerance, borderline_band: p.borderline_band, pass_values: p.pass_values },
      criteria_text: crit(p), raw_before: nn(x.raw_before), raw_after: nn(x.raw_after), calculated_value: nn(x.calculated_value), display_value: x.display_value ?? null,
      result_text: x.result_text ?? null, evaluation_status: x.evaluation_status ?? 'PENDING', calc_status: x.calc_status ?? null, evaluation_note: x.evaluation_note ?? null,
      is_override: !!Number(x.is_override ?? 0), override_reason: x.override_reason ?? null, result_source: x.result_source ?? 'INTERNAL', external_lab_name: x.external_lab_name ?? null,
      certificate_no: x.certificate_no ?? null, certificate_date: x.certificate_date ?? null, certificate_attachment_id: nn(x.certificate_attachment_id), observation: x.observation ?? null,
      readings: ms.filter((m) => Number(m.parameter_id) === p.parameter_id).map((m) => ({ reading_stage: m.reading_stage, reading_no: Number(m.reading_no), numeric_value: nn(m.numeric_value), text_value: m.text_value })),
    };
  });
  const addr = [co?.address_line1, co?.address_line2, co?.city, co?.state, co?.pincode].filter(Boolean).join(', ');
  return {
    schema: 1,
    company: { name: co?.trade_name || co?.legal_name, legal_name: co?.legal_name, address: addr, phone: co?.phone, email: co?.email, gstin: co?.gstin },
    request: { id: Number(r.id), request_no: r.request_no, request_date: String(r.request_date).slice(0, 10), required_date: String(r.required_date).slice(0, 10), source: r.source,
      buyer_id: nn(r.buyer_id), buyer_name: r.buyer_name, so_id: nn(r.so_id), job_no: r.job_no, buyer_po_no: r.buyer_po_no, style_id: nn(r.style_id), style_code: r.style_code,
      style_name: r.style_name, product_name: r.product_name, color_id: nn(r.color_id), color_name: r.color_name, item_description: r.item_description, fabric_id: nn(r.fabric_id),
      fabric_name: r.fabric_name, composition: r.composition, gsm: nn(r.gsm), fabric_lot: r.fabric_lot, test_scope: splitList(r.test_scope), priority: r.priority,
      is_development: !!Number(r.is_development), development_ref: r.development_ref, buyer_standard: r.buyer_standard },
    plan: { plan_id: snap.plan_id, plan_code: snap.plan_code, name: snap.name, version_no: snap.version_no },
    trial: { id: Number(t.id), trial_no: t.trial_no, trial_type: t.trial_type, parent_trial_no: t.parent_trial_no, recipe_revision: Number(t.recipe_revision), reason: t.reason,
      technician_name: t.technician_name, machine, wash_process_code: t.wash_process_code, wash_process_name: t.wash_process_name, batch_ref: t.batch_ref,
      load_weight_kg: nn(t.load_weight_kg), water_qty_l: nn(t.water_qty_l), liquor_ratio: nn(t.liquor_ratio), drying_method: t.drying_method, drying_temp: nn(t.drying_temp),
      drying_duration_min: nn(t.drying_duration_min), finish_notes: t.finish_notes, operator_name: t.operator_name, planned_at: t.planned_at, started_at: t.started_at,
      completed_at: t.completed_at, total_duration_min: stages.reduce((a, x) => a + n(x.actual_duration_min ?? x.target_duration_min), 0) },
    samples, stages, chemicals, results, deviations, attachments, overall_result: t.overall_result,
    prepared_by: preparedBy, prepared_by_name: prep?.full_name ?? null, submitted_at: new Date().toISOString(),
  };
}

labTrialRouter.post('/trials/:id/submit', TECH, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ row_version: z.coerce.number().int().nullish(), recommendation: s.nullableStr(500) }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const t = await getTrial(cid, id, tx, true);
    assertRowVersion(t, b.row_version);
    if (t.status !== 'COMPLETED') throw Conflict(t.status === 'IN_PROGRESS' ? 'Complete the trial before submitting it' : `A ${t.status.toLowerCase().replace(/_/g, ' ')} trial cannot be submitted`);
    const ev = await evaluateTrial(tx, t);
    const blockers = await submissionBlockers(tx, t);
    if (blockers.length) throw BadRequest(`Cannot submit: ${blockers[0]}${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ''}`, blockers.map((m) => ({ field: '', message: m })));
    if (!ev.overall) throw BadRequest('Cannot submit: mandatory results are incomplete');
    const snapshot = await buildReportSnapshot(tx, cid, id, uidOf(req));
    const json = JSON.stringify(snapshot);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    // same trial resubmitted after a return, or a revision of an approved report → same report no, next revision
    const prevOwn = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_report WHERE trial_id = ? ORDER BY revision_no DESC LIMIT 1`, [id]);
    const revised = t.revises_report_id ? await txQueryOne<any>(tx, `SELECT * FROM trx_lab_report WHERE id = ? AND company_id = ?`, [t.revises_report_id, cid]) : null;
    const base = prevOwn ?? revised;
    let reportNo: string; let rev: number;
    if (base) {
      const mx = await txQueryOne<any>(tx, `SELECT MAX(revision_no) m FROM trx_lab_report WHERE company_id = ? AND report_no = ? FOR UPDATE`, [cid, base.report_no]);
      reportNo = base.report_no; rev = n(mx?.m) + 1;
    } else {
      reportNo = await labNumber(tx, cid, 'LAB_REPORT'); rev = 1;
    }
    const ins = await txExecute(tx,
      `INSERT INTO trx_lab_report (company_id, report_no, revision_no, request_id, trial_id, report_status, overall_result, recommendation, revision_reason, supersedes_report_id,
              prepared_by, snapshot_json, snapshot_hash) VALUES (?,?,?,?,?,'PENDING_LAB',?,?,?,?,?,?,?)`,
      [cid, reportNo, rev, t.request_id, id, ev.overall, b.recommendation ?? null, rev > 1 ? (revised ? t.reason : `Resubmitted after return`) : null, base?.id ?? null, uidOf(req), json, hash]);
    await txExecute(tx, `UPDATE trx_lab_trial SET status = 'SUBMITTED', submitted_at = NOW(), submitted_by = ?, lab_approved_by = NULL, row_version = row_version + 1 WHERE id = ?`, [uidOf(req), id]);
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'TRIAL', entity_id: id, action: 'SUBMIT', after: { report_no: reportNo, revision_no: rev, overall: ev.overall, hash } });
    await labAudit(req, tx, { request_id: Number(t.request_id), entity_type: 'REPORT', entity_id: Number(ins.insertId), action: 'CREATE', after: { report_no: reportNo, revision_no: rev, hash } });
    await refreshRequestStatus(tx, Number(t.request_id));
    return { report_id: Number(ins.insertId), report_no: reportNo, revision_no: rev, trial_no: t.trial_no };
  });
  void notify(req, { perms: [P.APPROVE], title: `${out.trial_no} submitted — lab review of ${out.report_no} rev ${out.revision_no}`, body: 'Review required', ref_type: 'LAB_REPORT', ref_id: out.report_id });
  res.json({ data: { ...(await trialDetail(cid, id)), submitted_report: out } });
}));

