import type { Request } from 'express';
import { query, queryOne, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors.js';

/**
 * Sample development → order profitability (client 23-Oct-2026, "Complete Sample-to-Order Profitability" spec).
 * Shared rules: the sample status model, process gates, the cost formulas of spec §9 and the sample timeline.
 */

export const SAMPLE_STATUSES = [
  'DRAFT', 'SUBMITTED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_INTERNAL_APPROVAL', 'INTERNALLY_APPROVED',
  'SUBMITTED_TO_BUYER', 'REVISION_REQUIRED', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED',
] as const;
export type SampleStatus = typeof SAMPLE_STATUSES[number];
/** Workflow running: stages can be worked on. */
export const RUNNING: string[] = ['SUBMITTED', 'IN_PROGRESS', 'ON_HOLD'];
/** Statuses the stage progress decides (a rework / reopened stage brings these back to In progress). */
const DERIVED: string[] = ['SUBMITTED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_INTERNAL_APPROVAL', 'INTERNALLY_APPROVED'];
export const CLOSED: string[] = ['COMPLETED', 'CANCELLED'];
export const OPEN_STATUSES = SAMPLE_STATUSES.filter((s) => !['DRAFT', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED'].includes(s));

export const PRIORITIES = ['NORMAL', 'HIGH', 'CRITICAL'] as const;
export const COST_CATEGORIES = ['MATERIAL', 'LABOUR', 'CAD_PATTERN', 'SUBCONTRACT', 'CONSUMABLE', 'COURIER', 'REWORK', 'OVERHEAD', 'ADJUSTMENT'] as const;
export const ALLOC_METHODS = ['PERCENT', 'QUANTITY', 'VALUE', 'EQUAL', 'MANUAL'] as const;
/** Cost that counts (spec §9: approved / posted, reversals signed). A reversed original keeps counting — its negative twin offsets it. */
export const COUNTED = `('APPROVED','POSTED','REVERSED')`;
/** Cost that can be allocated: posted only. */
export const POSTED = `('POSTED','REVERSED')`;
/** Allocation lines that are in an order's P&L. */
export const LIVE_ALLOC = `l.status = 'ACTIVE' AND b.status IN ('POSTED','PARTIALLY_REVERSED')`;

export const n = (v: unknown) => Number(v ?? 0) || 0;
export const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export const r4 = (v: number) => Math.round((v + Number.EPSILON) * 10000) / 10000;
export const todayIso = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10); // business date (IST)
const DAY = 86_400_000;
export const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

export async function setting(cid: number, key: string, dflt: string) {
  const r = await queryOne<any>(`SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?`, [cid, key]);
  return r?.setting_value ?? dflt;
}
export async function eligibleCategories(cid: number): Promise<string[]> {
  const v = String(await setting(cid, 'SAMPLE_ALLOC_CATEGORIES', COST_CATEGORIES.join(',')));
  return v.split(',').map((x) => x.trim().toUpperCase()).filter((x) => (COST_CATEGORIES as readonly string[]).includes(x));
}
/** Segregation of duties (setting SAMPLE_SEGREGATION = 1): whoever entered it cannot approve / post it. */
export async function assertSegregation(req: Request, createdBy: unknown, what: string) {
  if (Number(createdBy) !== req.user!.id) return;
  if (String(await setting(req.user!.companyId, 'SAMPLE_SEGREGATION', '0')) === '1') {
    throw Forbidden(`Segregation of duties: the person who entered this ${what} cannot approve or post it`);
  }
}
export function hasPerm(req: Request, code: string) {
  return !!req.user && (req.user.isSuperAdmin || req.user.permissions.has(code));
}
export function needPerm(req: Request, code: string, what?: string) {
  if (!hasPerm(req, code)) throw Forbidden(`Missing required permission: ${code}${what ? ` (${what})` : ''}`);
}

/** Sample row of this company, locked for the transaction. */
export async function lockSample(tx: Tx, cid: number, id: number) {
  const s = await txQueryOne<any>(tx, `SELECT * FROM trx_sample WHERE id = ? AND company_id = ? AND is_deleted = 0 FOR UPDATE`, [id, cid]);
  if (!s) throw NotFound('Sample not found');
  return s;
}
export async function getSample(cid: number, id: number) {
  const s = await queryOne<any>(`SELECT * FROM trx_sample WHERE id = ? AND company_id = ? AND is_deleted = 0`, [id, cid]);
  if (!s) throw NotFound('Sample not found');
  return s;
}
export function assertVersion(s: any, rowVersion: number | null | undefined) {
  if (rowVersion != null && Number(rowVersion) !== Number(s.row_version)) {
    throw Conflict('This sample was changed by someone else — reload it and try again', { row_version: s.row_version });
  }
}

/** Legacy status / approval fields follow the status model (other screens and the T&A read them). */
const LEGACY_STATUS: Record<string, string> = {
  DRAFT: 'REQUESTED', SUBMITTED: 'REQUESTED', IN_PROGRESS: 'IN_PROGRESS', ON_HOLD: 'IN_PROGRESS',
  PENDING_INTERNAL_APPROVAL: 'IN_PROGRESS', INTERNALLY_APPROVED: 'IN_PROGRESS', REVISION_REQUIRED: 'IN_PROGRESS',
  SUBMITTED_TO_BUYER: 'SUBMITTED', APPROVED: 'APPROVED', COMPLETED: 'APPROVED', REJECTED: 'REJECTED', CANCELLED: 'REJECTED',
};
export async function setStatus(tx: Tx, s: any, status: string, extra: Record<string, unknown> = {}) {
  const legacy = await txQueryOne<any>(tx, `SELECT id FROM cfg_status WHERE domain = 'SAMPLE' AND code = ?`, [LEGACY_STATUS[status] ?? 'IN_PROGRESS']);
  const approval = status === 'APPROVED' || status === 'COMPLETED' ? 'APPROVED' : status === 'REJECTED' ? 'REJECTED' : 'PENDING';
  const cols: Record<string, unknown> = { status, status_id: legacy?.id ?? s.status_id, approval_status: approval, ...extra };
  const keys = Object.keys(cols);
  await txExecute(tx, `UPDATE trx_sample SET ${keys.map((k) => `${k} = ?`).join(', ')}, row_version = row_version + 1 WHERE id = ?`,
    [...keys.map((k) => cols[k]), s.id]);
  s.status = status; s.row_version = Number(s.row_version) + 1;
}
export async function bumpVersion(tx: Tx, id: number) {
  await txExecute(tx, `UPDATE trx_sample SET row_version = row_version + 1 WHERE id = ?`, [id]);
}

/** Sample timeline entry (spec §12: who / when / what / why). */
export async function logSample(tx: Tx, req: Request, sampleId: number, entity: string, entityId: number | null, action: string,
  oldV?: unknown, newV?: unknown, reason?: string | null) {
  await txExecute(tx, `INSERT INTO trx_sample_audit (company_id, sample_id, entity, entity_id, action, old_values, new_values, reason, user_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, sampleId, entity, entityId, action, oldV === undefined ? null : JSON.stringify(oldV),
      newV === undefined ? null : JSON.stringify(newV), reason ?? null, req.user!.id]);
}

/* ================================================================ workflow */

/** Stage instances of the sample's workflow version for one revision (all stages, or the chosen ones on a revision). */
export async function instantiateStages(tx: Tx, s: any, revisionNo: number, stageIds?: number[]) {
  const stages = await txQuery<any>(tx, `SELECT * FROM mst_sample_workflow_stage WHERE workflow_id = ? ORDER BY seq_no, id`, [s.workflow_id]);
  const pick = stageIds?.length ? stages.filter((x) => stageIds.includes(Number(x.id))) : stages;
  if (!pick.length) throw BadRequest('The workflow of this sample type has no stages — add stages in Sample types first');
  for (const st of pick) {
    await txExecute(tx, `INSERT INTO trx_sample_process (sample_id, revision_no, workflow_stage_id, seq_no, step_group, stage_code, stage_name, department_id,
        is_mandatory, sla_days, needs_output, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [s.id, revisionNo, st.id, st.seq_no, st.step_group, st.stage_code, st.stage_name, st.department_id, st.is_mandatory, st.sla_days, st.needs_output]);
  }
  return pick.length;
}

export const DONE = (p: any) => p.status === 'COMPLETED' || p.status === 'SKIPPED';
/** A stage may start when every mandatory stage of an earlier group of the same revision is completed or skipped. */
export function blockers(p: any, all: any[]) {
  return all.filter((x) => Number(x.revision_no) === Number(p.revision_no) && x.id !== p.id && x.status !== 'CANCELLED'
    && Number(x.step_group) < Number(p.step_group) && Number(x.is_mandatory) === 1 && !DONE(x));
}

/**
 * Sample status from its stages (only while the workflow decides it): all mandatory stages done → Pending internal
 * approval (optional stages not used are skipped); anything running → In progress; only held → On hold.
 */
export async function deriveStatus(tx: Tx, req: Request, s: any) {
  if (!DERIVED.includes(s.status)) return;
  const procs = await txQuery<any>(tx, `SELECT * FROM trx_sample_process WHERE sample_id = ? AND revision_no = ? AND status <> 'CANCELLED'`, [s.id, s.revision_no]);
  if (!procs.length) return;
  const mandatoryDone = procs.filter((p) => Number(p.is_mandatory) === 1).every(DONE);
  const running = procs.some((p) => p.status === 'IN_PROGRESS');
  const held = procs.some((p) => p.status === 'ON_HOLD');
  let next: string;
  if (mandatoryDone && !running && !held) {
    for (const p of procs.filter((x) => x.status === 'NOT_STARTED')) {
      await txExecute(tx, `UPDATE trx_sample_process SET status = 'SKIPPED', skip_reason = 'Optional stage not used' WHERE id = ?`, [p.id]);
      await txExecute(tx, `INSERT INTO trx_sample_process_log (sample_id, process_id, action, from_status, to_status, reason, user_id) VALUES (?,?,?,?,?,?,?)`,
        [s.id, p.id, 'SKIP', 'NOT_STARTED', 'SKIPPED', 'Optional stage not used', req.user!.id]);
    }
    next = s.status === 'INTERNALLY_APPROVED' ? 'INTERNALLY_APPROVED' : 'PENDING_INTERNAL_APPROVAL';
    if (s.status !== next || !s.completed_date) {
      await setStatus(tx, s, next, { completed_date: s.completed_date ?? todayIso() });
      s.completed_date = s.completed_date ?? todayIso();
      await logSample(tx, req, s.id, 'SAMPLE', s.id, 'STAGES_DONE', undefined, { status: next });
    }
    return;
  }
  next = running ? 'IN_PROGRESS' : held ? 'ON_HOLD' : procs.some(DONE) ? 'IN_PROGRESS' : 'SUBMITTED';
  if (next !== s.status || s.completed_date) {
    await setStatus(tx, s, next, { completed_date: null });
    s.completed_date = null;
  }
}

/* ================================================================ calendar & formulas (spec §9) */

export async function calendar(cid: number) {
  const [wk, hol] = await Promise.all([
    query<any>(`SELECT day_of_week, is_working_day FROM cfg_working_calendar WHERE company_id = ?`, [cid]),
    query<any>(`SELECT holiday_date FROM cfg_holiday WHERE company_id = ? AND COALESCE(is_optional, 0) = 0`, [cid]),
  ]);
  const off = new Set(wk.filter((w) => !Number(w.is_working_day)).map((w) => Number(w.day_of_week)));
  if (!wk.length) off.add(0); // no calendar: Sunday off
  return { off, holidays: new Set(hol.map((h) => String(h.holiday_date).slice(0, 10))) };
}
/** Working days after `from` up to and including `to` (weekly offs and holidays left out). */
export function workingDays(cal: { off: Set<number>; holidays: Set<string> }, from: string, to: string) {
  const days = dayDiff(from, to);
  if (days <= 0) return 0;
  let w = 0;
  const start = Date.parse(`${from}T00:00:00Z`);
  for (let i = 1; i <= Math.min(days, 3660); i++) {
    const d = new Date(start + i * DAY);
    if (!cal.off.has(d.getUTCDay()) && !cal.holidays.has(d.toISOString().slice(0, 10))) w++;
  }
  return w;
}

export interface CostRow { sample_id: number; cumulative: number; today: number; posted_eligible: number; pending: number; awaiting: number; by_cat?: Record<string, number> }

/** Approved / posted cost per sample (cumulative to the as-of date, the as-of date alone, posted eligible, waiting). */
export async function costTotals(cid: number, ids: number[], asOf = todayIso()) {
  const out = new Map<number, CostRow>();
  if (!ids.length) return out;
  const cats = await eligibleCategories(cid);
  const rows = await query<any>(
    `SELECT sample_id,
            SUM(CASE WHEN status IN ${COUNTED} AND cost_date <= ? THEN amount ELSE 0 END) AS cumulative,
            SUM(CASE WHEN status IN ${COUNTED} AND cost_date = ? THEN amount ELSE 0 END) AS today,
            SUM(CASE WHEN status IN ${POSTED} AND category IN (?) THEN amount ELSE 0 END) AS posted_eligible,
            SUM(CASE WHEN status IN ('DRAFT','SUBMITTED') THEN amount ELSE 0 END) AS pending,
            SUM(CASE WHEN status IN ('SUBMITTED','APPROVED') THEN 1 ELSE 0 END) AS awaiting
       FROM trx_sample_cost WHERE company_id = ? AND sample_id IN (?) GROUP BY sample_id`,
    [asOf, asOf, cats.length ? cats : ['-'], cid, ids]);
  for (const r of rows) {
    out.set(Number(r.sample_id), { sample_id: Number(r.sample_id), cumulative: r2(n(r.cumulative)), today: r2(n(r.today)),
      posted_eligible: r2(n(r.posted_eligible)), pending: r2(n(r.pending)), awaiting: n(r.awaiting) });
  }
  return out;
}

/** Posted allocations per sample (live lines) and pending (submitted / approved, not yet posted). */
export async function allocTotals(ids: number[]) {
  const out = new Map<number, { allocated: number; pending: number; orders: number }>();
  if (!ids.length) return out;
  const rows = await query<any>(
    `SELECT b.sample_id,
            SUM(CASE WHEN ${LIVE_ALLOC} THEN l.allocated_amount ELSE 0 END) AS allocated,
            SUM(CASE WHEN b.status IN ('PENDING_APPROVAL','APPROVED') THEN l.allocated_amount ELSE 0 END) AS pending,
            COUNT(DISTINCT CASE WHEN ${LIVE_ALLOC} THEN l.so_id END) AS orders
       FROM trx_sample_alloc_batch b JOIN trx_sample_alloc_line l ON l.batch_id = b.id
      WHERE b.sample_id IN (?) GROUP BY b.sample_id`, [ids]);
  for (const r of rows) out.set(Number(r.sample_id), { allocated: r2(n(r.allocated)), pending: r2(n(r.pending)), orders: n(r.orders) });
  return out;
}

/**
 * The metrics of spec §9 for one sample. Elapsed days run from the request date to the completion date (all stages
 * done) or the business date; delay is days past the target. Per-piece figures are N/A (null) on a zero divisor.
 */
export function metrics(s: any, c: CostRow | undefined, a: { allocated: number; pending: number; orders: number } | undefined,
  cal: { off: Set<number>; holidays: Set<string> }, asOf = todayIso()) {
  const qty = n(s.qty);
  const good = s.good_qty == null ? null : n(s.good_qty);
  const reqDate = s.request_date ? String(s.request_date).slice(0, 10) : null;
  const end = s.completed_date ? String(s.completed_date).slice(0, 10) : asOf;
  const elapsed = reqDate ? Math.max(0, dayDiff(reqDate, end)) : null;
  const elapsedWorking = reqDate ? workingDays(cal, reqDate, end) : null;
  const target = s.target_date ? String(s.target_date).slice(0, 10) : null;
  const delay = target ? Math.max(0, dayDiff(target, end)) : null;
  const cumulative = c?.cumulative ?? 0;
  const today = c?.today ?? 0;
  const eligible = r2(Math.max(0, (c?.posted_eligible ?? 0) - n(s.recovered_amount)));
  const allocated = a?.allocated ?? 0;
  const unallocated = r2(eligible - allocated);
  const allocation_state = allocated - eligible > 0.005 ? 'EXCEPTION'
    : allocated > 0.005 ? (unallocated > 0.005 ? 'PARTIAL' : 'FULL')
      : eligible > 0.005 ? 'ELIGIBLE' : 'NO_COST';
  return {
    elapsed_days: elapsed, elapsed_working_days: elapsedWorking, delay_days: delay,
    today_cost: today, cumulative_cost: cumulative,
    cost_per_piece: qty > 0 ? r2(cumulative / qty) : null,
    cost_per_good_piece: good && good > 0 ? r2(cumulative / good) : null,
    avg_daily_cost_per_piece: qty > 0 && elapsed && elapsed > 0 ? r2(cumulative / elapsed / qty) : null,
    today_cost_per_piece: qty > 0 ? r2(today / qty) : null,
    pending_cost: c?.pending ?? 0, costs_awaiting_approval: c?.awaiting ?? 0,
    eligible_cost: eligible, allocated_cost: allocated, pending_allocation: a?.pending ?? 0, unallocated_cost: unallocated,
    allocated_orders: a?.orders ?? 0, allocation_state,
  };
}

/** Process age in days: now − start − time on hold. */
export function processAgeDays(p: any) {
  if (!p.started_at || !['IN_PROGRESS', 'ON_HOLD'].includes(p.status)) return null;
  const now = Date.now();
  let held = n(p.hold_minutes) * 60_000;
  if (p.status === 'ON_HOLD' && p.hold_since) held += now - new Date(p.hold_since).getTime();
  return r2(Math.max(0, now - new Date(p.started_at).getTime() - held) / DAY);
}

/** What the sample needs next (register "Next action"). */
export function nextAction(s: any, current: any | null) {
  switch (s.status) {
    case 'DRAFT': return 'Submit the request';
    case 'SUBMITTED': case 'IN_PROGRESS': case 'ON_HOLD':
      if (!current) return 'Create the stages';
      return `${current.status === 'ON_HOLD' ? 'Resume' : current.status === 'IN_PROGRESS' ? 'Complete' : 'Start'} ${current.stage_name}`;
    case 'PENDING_INTERNAL_APPROVAL': return 'Internal approval';
    case 'INTERNALLY_APPROVED': return 'Submit to buyer';
    case 'SUBMITTED_TO_BUYER': return 'Record buyer response';
    case 'REVISION_REQUIRED': case 'REJECTED': return 'Start revision / resubmit';
    case 'APPROVED': return 'Allocate cost to order / close';
    default: return '—';
  }
}

/** Current stage of each sample: the running / held one, else the first not started whose gate is open. */
export function currentStage(s: any, procs: any[]) {
  const mine = procs.filter((p) => Number(p.sample_id) === Number(s.id) && Number(p.revision_no) === Number(s.revision_no) && p.status !== 'CANCELLED');
  mine.sort((x, y) => Number(x.seq_no) - Number(y.seq_no) || Number(x.id) - Number(y.id));
  return mine.find((p) => p.status === 'IN_PROGRESS') ?? mine.find((p) => p.status === 'ON_HOLD')
    ?? mine.find((p) => p.status === 'NOT_STARTED' && !blockers(p, mine).length) ?? mine.find((p) => p.status === 'NOT_STARTED') ?? null;
}

export async function txSample(tx: Tx, id: number) {
  return txQueryOne<any>(tx, `SELECT * FROM trx_sample WHERE id = ?`, [id]);
}
