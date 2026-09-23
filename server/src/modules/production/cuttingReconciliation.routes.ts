/**
 * Cutting reconciliation & close (doc §16, §17, §20).
 *
 *   Issued KG (DC − returns) − Lay consumption − Losses = Unaccounted
 *
 * Close is blocked while |unaccounted| exceeds CUTTING_RECON_TOLERANCE_PCT
 * of issued KG unless a PRODUCTION.APPROVE user approved the variance with a
 * reason. Closing makes the cut order CLOSED (read-only) and finalises the
 * DC roll statuses; reopening needs PRODUCTION.APPROVE + a reason.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';
import {
  KG_EPS, assertPlanOpen, computeConsumption, nextUniqueDocNo, computeReconFigures, lockPlan, num,
  refreshDcRollStatus, refreshFabricRollStatus, refreshPlanStatus, round,
} from './cuttingEngine.js';

export const cuttingReconciliationRouter = Router();

const LOSS_TYPES = ['CUTTING_WASTE', 'END_LOSS', 'SELVEDGE_LOSS', 'REMNANT', 'OTHER'] as const;

/** Things that should be settled before closing — shown as warnings; open lays block. */
async function closeWarnings(tx: any, cid: number, planId: number) {
  const run = <T = any>(sql: string, p: any[]) => (tx ? txQuery<T>(tx, sql, p) : query<T>(sql, p));
  const [openLays, openRolls, unbundled] = await Promise.all([
    run<any>(`SELECT lay_no, status FROM trx_lay_plan WHERE company_id = ? AND cutting_plan_id = ? AND status IN ('PLANNED','SPREAD')`, [cid, planId]),
    run<any>(
      `SELECT fir.roll_no, ROUND(COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg, 4) AS remaining_kg
         FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
        WHERE fi.company_id = ? AND fi.cutting_plan_id = ? AND COALESCE(fir.issue_kg,0) - fir.consumed_kg - fir.returned_kg > ${KG_EPS}`,
      [cid, planId]),
    run<any>(
      `SELECT COALESCE(SUM(co.good_qty - co.bundled_qty),0) AS pcs FROM trx_cut_output co
        WHERE co.company_id = ? AND co.cutting_plan_id = ? AND co.status = 'OPEN'`, [cid, planId]),
  ]);
  const warnings: string[] = [];
  const blockers: string[] = [];
  if (openLays.length) blockers.push(`${openLays.length} lay(s) not executed: ${openLays.map((l: any) => l.lay_no).join(', ')} — execute or cancel them first`);
  if (openRolls.length) {
    const kg = round(openRolls.reduce((a: number, r: any) => a + num(r.remaining_kg), 0), 3);
    warnings.push(`${openRolls.length} DC roll(s) still show ${kg} KG not consumed or returned — record it as remnant/loss or return it to store, otherwise it stays unaccounted`);
  }
  if (num(unbundled[0]?.pcs) > 0) warnings.push(`${num(unbundled[0].pcs)} PCS of good cut output are not bundled yet`);
  return { warnings, blockers, open_rolls: openRolls };
}

const RECON_SELECT = `SELECT r.*, cp.plan_no, cp.io_no, cp.status AS plan_status, st.style_code,
       ua.full_name AS approved_by_name, uc.full_name AS closed_by_name, 'KG' AS uom
  FROM trx_cutting_reconciliation r
  JOIN trx_cutting_plan cp ON cp.id = r.cutting_plan_id
  LEFT JOIN mst_style st ON st.id = cp.style_id
  LEFT JOIN mst_user ua ON ua.id = r.approved_by
  LEFT JOIN mst_user uc ON uc.id = r.closed_by`;

/** GET /cutting-reconciliations */
cuttingReconciliationRouter.get('/cutting-reconciliations', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: any[] = [cid];
  let where = 'WHERE r.company_id = ?';
  if (req.query.status) { where += ' AND r.status = ?'; params.push(String(req.query.status)); }
  const rows = await query(`${RECON_SELECT} ${where} ORDER BY r.id DESC`, params);
  res.json({ data: rows });
}));

/**
 * GET /cutting-reconciliation/preview/:planId — live figures, tolerance,
 * consumption comparison, close warnings and the latest reconciliation.
 */
cuttingReconciliationRouter.get('/cutting-reconciliation/preview/:planId', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const planId = Number(req.params.planId);
  const plan = await queryOne<any>(
    `SELECT cp.*, st.style_code, fb.fabric_name FROM trx_cutting_plan cp
       LEFT JOIN mst_style st ON st.id = cp.style_id LEFT JOIN mst_fabric fb ON fb.id = cp.fabric_id
      WHERE cp.id = ? AND cp.company_id = ?`, [planId, cid]);
  if (!plan) throw NotFound('Cut order not found');
  const [figures, consumption, checks, latest, losses, lays] = await Promise.all([
    computeReconFigures(null, cid, planId),
    computeConsumption(null, cid, planId),
    closeWarnings(null, cid, planId),
    queryOne(`${RECON_SELECT} WHERE r.company_id = ? AND r.cutting_plan_id = ? ORDER BY r.id DESC LIMIT 1`, [cid, planId]),
    query(
      `SELECT cl.*, lp.lay_no, 'KG' AS uom FROM trx_cutting_loss cl LEFT JOIN trx_lay_plan lp ON lp.id = cl.lay_id
        WHERE cl.company_id = ? AND cl.cutting_plan_id = ? ORDER BY cl.id`, [cid, planId]),
    query(
      `SELECT lp.id, lp.lay_no, lp.status, lp.actual_kg, lp.actual_cut_qty, lp.planned_kg, lp.expected_pieces
         FROM trx_lay_plan lp WHERE lp.company_id = ? AND lp.cutting_plan_id = ? ORDER BY lp.id`, [cid, planId]),
  ]);
  res.json({
    data: {
      plan: { id: plan.id, plan_no: plan.plan_no, io_no: plan.io_no, style_code: plan.style_code,
        fabric_name: plan.fabric_name, status: plan.status, order_qty: plan.order_qty,
        planned_cut_qty: plan.planned_cut_qty, actual_cut_qty: plan.actual_cut_qty },
      figures, consumption, ...checks, reconciliation: latest, losses, lays,
      can_close: checks.blockers.length === 0 && (figures.within_tolerance
        || ((latest as any)?.status === 'APPROVED' && Math.abs(num((latest as any)?.approved_unaccounted_kg) - figures.unaccounted_kg) <= KG_EPS)),
    },
  });
}));

/** POST /cutting-plans/:id/losses — record a loss outside lay execution (e.g. remnant at close) */
cuttingReconciliationRouter.post('/cutting-plans/:id/losses', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const planId = Number(req.params.id);
  const body = z.object({
    loss_type: z.enum(LOSS_TYPES),
    qty_kg: z.coerce.number().positive(),
    lay_id: s.id(),
    reason: s.nullableStr(255),
  }).parse(req.body);
  const id = await transaction(async (tx) => {
    const plan = await lockPlan(tx, cid, planId);
    assertPlanOpen(plan, 'record losses');
    if (body.lay_id) {
      const lay = await txQueryOne<any>(tx, `SELECT id, status FROM trx_lay_plan WHERE id = ? AND cutting_plan_id = ?`, [body.lay_id, planId]);
      if (!lay) throw BadRequest('Lay does not belong to this cut order');
      if (!['CUT', 'APPROVED'].includes(lay.status)) throw BadRequest('Losses can only be booked against an executed lay');
    }
    const r = await txExecute(tx,
      `INSERT INTO trx_cutting_loss (company_id, cutting_plan_id, lay_id, loss_type, qty_kg, reason, created_by)
       VALUES (?,?,?,?,?,?,?)`, [cid, planId, body.lay_id ?? null, body.loss_type, body.qty_kg, body.reason ?? null, req.user!.id]);
    await markReconStale(tx, cid, planId);
    return r.insertId;
  });
  await audit(req, 'trx_cutting_loss', id, 'INSERT', undefined, body);
  res.status(201).json({ data: await queryOne(`SELECT * FROM trx_cutting_loss WHERE id = ?`, [id]) });
}));

/** POST /cutting-losses/:id/reverse { reason } */
cuttingReconciliationRouter.post('/cutting-losses/:id/reverse', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ reason: s.strReq(255) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const loss = await txQueryOne<any>(tx, `SELECT * FROM trx_cutting_loss WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!loss) throw NotFound('Loss entry not found');
    if (loss.is_reversed) throw BadRequest('Loss entry is already reversed');
    const plan = await lockPlan(tx, cid, loss.cutting_plan_id);
    assertPlanOpen(plan, 'reverse losses');
    await txExecute(tx,
      `UPDATE trx_cutting_loss SET is_reversed = 1, reversed_by = ?, reversed_at = NOW(), reversal_reason = ? WHERE id = ?`,
      [req.user!.id, body.reason, id]);
    await markReconStale(tx, cid, loss.cutting_plan_id);
  });
  await audit(req, 'trx_cutting_loss', id, 'UPDATE', { is_reversed: 0 }, { is_reversed: 1, reason: body.reason });
  res.json({ data: { id, is_reversed: 1 } });
}));

/** Figures changed → an approval given for the old unaccounted KG no longer applies. */
async function markReconStale(tx: any, cid: number, planId: number) {
  await txExecute(tx,
    `UPDATE trx_cutting_reconciliation SET status = 'DRAFT'
      WHERE company_id = ? AND cutting_plan_id = ? AND status IN ('VARIANCE_PENDING','APPROVED')`, [cid, planId]);
}

/** Write the current figures onto a reconciliation row (creating it when needed). */
async function snapshotRecon(tx: any, req: any, planId: number, remarks?: string | null) {
  const cid = req.user!.companyId;
  const f = await computeReconFigures(tx, cid, planId);
  let rec = await txQueryOne<any>(tx,
    `SELECT * FROM trx_cutting_reconciliation WHERE company_id = ? AND cutting_plan_id = ? AND status <> 'CLOSED'
      ORDER BY id DESC LIMIT 1 FOR UPDATE`, [cid, planId]);
  const approvalStillValid = rec?.status === 'APPROVED'
    && Math.abs(num(rec.approved_unaccounted_kg) - f.unaccounted_kg) <= KG_EPS;
  const status = f.within_tolerance ? 'DRAFT' : (approvalStillValid ? 'APPROVED' : 'VARIANCE_PENDING');
  const vals = [f.issue_kg, f.returned_kg, f.consumed_kg, f.waste_kg, f.end_loss_kg, f.selvedge_kg, f.remnant_kg,
    f.other_loss_kg, f.unaccounted_kg, f.tolerance_pct, f.tolerance_kg];
  if (rec) {
    await txExecute(tx,
      `UPDATE trx_cutting_reconciliation SET issued_kg = ?, returned_kg = ?, consumed_kg = ?, waste_kg = ?, end_loss_kg = ?,
              selvedge_kg = ?, remnant_kg = ?, other_loss_kg = ?, unaccounted_kg = ?, tolerance_pct = ?, tolerance_kg = ?,
              status = ?, remarks = COALESCE(?, remarks), updated_by = ? WHERE id = ?`,
      [...vals, status, remarks ?? null, req.user!.id, rec.id]);
  } else {
    const no = await nextUniqueDocNo(tx, cid, 'CUT_RECON', 'trx_cutting_reconciliation', 'recon_no');
    const r = await txExecute(tx,
      `INSERT INTO trx_cutting_reconciliation
         (company_id, recon_no, cutting_plan_id, issued_kg, returned_kg, consumed_kg, waste_kg, end_loss_kg, selvedge_kg,
          remnant_kg, other_loss_kg, unaccounted_kg, tolerance_pct, tolerance_kg, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, planId, ...vals, status, remarks ?? null, req.user!.id]);
    rec = { id: r.insertId };
  }
  return { id: rec.id as number, figures: f, status };
}

/** POST /cutting-reconciliation { cutting_plan_id, remarks } — create / refresh the reconciliation */
cuttingReconciliationRouter.post('/cutting-reconciliation', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({ cutting_plan_id: s.idReq(), remarks: s.nullableStr(500) }).parse(req.body);
  const snap = await transaction(async (tx) => {
    const plan = await lockPlan(tx, cid, body.cutting_plan_id);
    assertPlanOpen(plan, 'reconcile');
    return snapshotRecon(tx, req, plan.id, body.remarks);
  });
  await audit(req, 'trx_cutting_reconciliation', snap.id, 'UPDATE', undefined, snap);
  res.status(201).json({ data: await queryOne(`${RECON_SELECT} WHERE r.id = ?`, [snap.id]), figures: snap.figures });
}));

/** POST /cutting-reconciliation/:id/approve-variance { reason } — authorised variance approval */
cuttingReconciliationRouter.post('/cutting-reconciliation/:id/approve-variance', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ reason: s.strReq(500) }).parse(req.body ?? {});
  const snap = await transaction(async (tx) => {
    const rec = await txQueryOne<any>(tx, `SELECT * FROM trx_cutting_reconciliation WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!rec) throw NotFound('Reconciliation not found');
    if (rec.status === 'CLOSED') throw BadRequest('Reconciliation is already closed');
    const plan = await lockPlan(tx, cid, rec.cutting_plan_id);
    assertPlanOpen(plan, 'approve a variance');
    const f = await computeReconFigures(tx, cid, rec.cutting_plan_id);
    await txExecute(tx,
      `UPDATE trx_cutting_reconciliation SET issued_kg = ?, returned_kg = ?, consumed_kg = ?, waste_kg = ?, end_loss_kg = ?,
              selvedge_kg = ?, remnant_kg = ?, other_loss_kg = ?, unaccounted_kg = ?, tolerance_pct = ?, tolerance_kg = ?,
              status = 'APPROVED', variance_reason = ?, approved_by = ?, approved_at = NOW(), approved_unaccounted_kg = ?,
              updated_by = ?
        WHERE id = ?`,
      [f.issue_kg, f.returned_kg, f.consumed_kg, f.waste_kg, f.end_loss_kg, f.selvedge_kg, f.remnant_kg, f.other_loss_kg,
       f.unaccounted_kg, f.tolerance_pct, f.tolerance_kg, body.reason, req.user!.id, f.unaccounted_kg, req.user!.id, id]);
    return f;
  });
  await audit(req, 'trx_cutting_reconciliation', id, 'UPDATE', undefined, { status: 'APPROVED', reason: body.reason, figures: snap });
  res.json({ data: await queryOne(`${RECON_SELECT} WHERE r.id = ?`, [id]) });
}));

/** POST /cutting-reconciliation/:id/close — close the cut order (blocked beyond tolerance without approval) */
cuttingReconciliationRouter.post('/cutting-reconciliation/:id/close', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ remarks: s.nullableStr(500) }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const rec = await txQueryOne<any>(tx, `SELECT * FROM trx_cutting_reconciliation WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!rec) throw NotFound('Reconciliation not found');
    if (rec.status === 'CLOSED') throw BadRequest('Reconciliation is already closed');
    const plan = await lockPlan(tx, cid, rec.cutting_plan_id);
    assertPlanOpen(plan, 'close');
    if (plan.status === 'DRAFT') throw BadRequest('A DRAFT cut order cannot be closed — cancel it instead');
    const checks = await closeWarnings(tx, cid, plan.id);
    if (checks.blockers.length) throw BadRequest(`Cutting close blocked: ${checks.blockers.join('; ')}`);

    const snap = await snapshotRecon(tx, req, plan.id, body.remarks);
    const f = snap.figures;
    if (!f.within_tolerance && snap.status !== 'APPROVED') {
      throw BadRequest(
        `Cutting close blocked: ${f.unaccounted_kg} KG unaccounted exceeds the tolerance of ${f.tolerance_kg} KG `
        + `(${f.tolerance_pct}% of ${f.net_issued_kg} KG issued). Record the missing losses/returns or get the variance approved.`,
        { figures: f });
    }

    await txExecute(tx,
      `UPDATE trx_cutting_reconciliation SET status = 'CLOSED', closed_by = ?, closed_at = NOW() WHERE id = ?`, [req.user!.id, snap.id]);
    await txExecute(tx,
      `UPDATE trx_cutting_plan SET status = 'CLOSED', closed_by = ?, closed_at = NOW(), updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [req.user!.id, req.user!.id, plan.id]);
    // Final roll statuses: every DC roll of the cut order is closed; the stock
    // roll is CLOSED when fully issued, otherwise it stays PARTIAL in store.
    const dcRolls = await txQuery<any>(tx,
      `SELECT fir.id, fir.fabric_roll_id FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
        WHERE fi.company_id = ? AND fi.cutting_plan_id = ? FOR UPDATE`, [cid, plan.id]);
    for (const r of dcRolls) {
      await refreshDcRollStatus(tx, r.id, { forceClose: true });
      if (r.fabric_roll_id) await refreshFabricRollStatus(tx, r.fabric_roll_id, { close: true });
    }
    return { reconciliation_id: snap.id, cutting_plan_id: plan.id, plan_no: plan.plan_no, figures: f, warnings: checks.warnings };
  });
  await audit(req, 'trx_cutting_reconciliation', id, 'UPDATE', undefined, { status: 'CLOSED', ...out });
  await audit(req, 'trx_cutting_plan', out.cutting_plan_id, 'UPDATE', undefined, { status: 'CLOSED', reconciliation_id: id });
  res.json({ data: out });
}));

/** POST /cutting-reconciliation/:id/reopen { reason } — PRODUCTION.APPROVE */
cuttingReconciliationRouter.post('/cutting-reconciliation/:id/reopen', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = z.object({ reason: s.strReq(500) }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const rec = await txQueryOne<any>(tx, `SELECT * FROM trx_cutting_reconciliation WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!rec) throw NotFound('Reconciliation not found');
    if (rec.status !== 'CLOSED') throw BadRequest('Only a CLOSED reconciliation can be reopened');
    const plan = await lockPlan(tx, cid, rec.cutting_plan_id);
    if (plan.status !== 'CLOSED') throw BadRequest('Cut order is not closed');
    await txExecute(tx,
      `UPDATE trx_cutting_reconciliation SET status = 'REOPENED', reopen_reason = ?, reopened_by = ?, reopened_at = NOW(),
              updated_by = ? WHERE id = ?`, [body.reason, req.user!.id, req.user!.id, id]);
    // Back to RELEASED, then let lay execution re-derive the real status.
    await txExecute(tx,
      `UPDATE trx_cutting_plan SET status = 'RELEASED', status_reason = ?, closed_by = NULL, closed_at = NULL,
              updated_by = ?, updated_at = NOW() WHERE id = ?`, [`Reopened: ${body.reason}`.slice(0, 255), req.user!.id, plan.id]);
    const state = await refreshPlanStatus(tx, plan.id);
    const dcRolls = await txQuery<any>(tx,
      `SELECT fir.id, fir.fabric_roll_id FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
        WHERE fi.company_id = ? AND fi.cutting_plan_id = ? FOR UPDATE`, [cid, plan.id]);
    for (const r of dcRolls) {
      await refreshDcRollStatus(tx, r.id);
      if (r.fabric_roll_id) await refreshFabricRollStatus(tx, r.fabric_roll_id, { reopen: true });
    }
    return { reconciliation_id: id, cutting_plan_id: plan.id, cut_order: state };
  });
  await audit(req, 'trx_cutting_reconciliation', id, 'UPDATE', { status: 'CLOSED' }, { status: 'REOPENED', reason: body.reason });
  await audit(req, 'trx_cutting_plan', out.cutting_plan_id, 'UPDATE', { status: 'CLOSED' }, { ...out.cut_order, reason: body.reason });
  res.json({ data: out });
}));
