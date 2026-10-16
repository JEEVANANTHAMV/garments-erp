import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { effectiveBasis, billedQty, BillBasis, BILL_BASIS_LABEL } from './billBasis.js';
import { cmtCoversCutToFinish } from '../costing/preCostingCalc.js';

/**
 * Process master, operations and contractor bills (client review 24-Sep-2026).
 *
 *   Process (cfg_process_stage)  → operations (mst_process_operation) such as
 *   power table / singer / overlock under Stitching, each with a default rate;
 *   each contractor can have its own rate per operation (mst_contractor_op_rate).
 *   A DC picks the operations it is sent for and its rate / PCS is their sum.
 *
 *   Contractor bills pass process inwards for payment: good PCS (plus mistake
 *   PCS when the process pays for them) × the DC rate, less TDS / deductions.
 */
export const processMasterRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (v: number) => Math.round(v * 100) / 100;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const reasonReq = z.string().trim().min(3, 'Give a reason (min 3 characters)').max(255);

// ============================================================
// Processes + operations
// ============================================================
processMasterRouter.get('/process-master', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const stages = await query<any>(
    `SELECT id, stage_code, stage_name, sort_order, is_outsourceable, bill_include_mistake, is_active
       FROM cfg_process_stage WHERE company_id = ? ORDER BY sort_order, id`, [cid]);
  const ops = await query<any>(
    `SELECT id, stage_id, op_code, op_name, default_rate, sort_order, is_active
       FROM mst_process_operation WHERE company_id = ? ORDER BY sort_order, op_name`, [cid]);
  res.json({ data: stages.map((st) => ({ ...st, operations: ops.filter((o) => Number(o.stage_id) === Number(st.id)) })) });
}));

const stageSchema = z.object({
  stage_code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase()),
  stage_name: z.string().trim().min(1).max(80),
  sort_order: z.coerce.number().int().min(0).max(9999).default(0),
  is_outsourceable: z.coerce.boolean().default(true),
  bill_include_mistake: z.coerce.boolean().default(false),
  is_active: z.coerce.boolean().default(true),
});

processMasterRouter.post('/process-master/stages', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = stageSchema.parse(req.body);
  const dup = await queryOne(`SELECT id FROM cfg_process_stage WHERE company_id = ? AND stage_code = ?`, [cid, b.stage_code]);
  if (dup) throw BadRequest(`Process code ${b.stage_code} already exists`);
  const r = await execute(
    `INSERT INTO cfg_process_stage (company_id, stage_code, stage_name, sort_order, is_outsourceable, bill_include_mistake, is_active)
     VALUES (?,?,?,?,?,?,?)`,
    [cid, b.stage_code, b.stage_name, b.sort_order, b.is_outsourceable ? 1 : 0, b.bill_include_mistake ? 1 : 0, b.is_active ? 1 : 0]);
  await audit(req, 'cfg_process_stage', r.insertId, 'INSERT', undefined, b);
  res.status(201).json({ data: { id: r.insertId } });
}));

processMasterRouter.put('/process-master/stages/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = stageSchema.parse(req.body);
  const before = await queryOne<any>(`SELECT * FROM cfg_process_stage WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!before) throw NotFound('Process not found');
  const dup = await queryOne(`SELECT id FROM cfg_process_stage WHERE company_id = ? AND stage_code = ? AND id <> ?`, [cid, b.stage_code, id]);
  if (dup) throw BadRequest(`Process code ${b.stage_code} already exists`);
  await execute(
    `UPDATE cfg_process_stage SET stage_code = ?, stage_name = ?, sort_order = ?, is_outsourceable = ?, bill_include_mistake = ?, is_active = ?
      WHERE id = ?`,
    [b.stage_code, b.stage_name, b.sort_order, b.is_outsourceable ? 1 : 0, b.bill_include_mistake ? 1 : 0, b.is_active ? 1 : 0, id]);
  await audit(req, 'cfg_process_stage', id, 'UPDATE', before, b);
  res.json({ data: { id } });
}));

const opSchema = z.object({
  stage_id: s.idReq(),
  op_code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase().replace(/\s+/g, '_')),
  op_name: z.string().trim().min(1).max(80),
  default_rate: z.coerce.number().min(0).max(100000).default(0),
  sort_order: z.coerce.number().int().min(0).max(9999).default(0),
  is_active: z.coerce.boolean().default(true),
});

async function opCheck(cid: number, b: z.infer<typeof opSchema>, id = 0) {
  const st = await queryOne(`SELECT id FROM cfg_process_stage WHERE id = ? AND company_id = ?`, [b.stage_id, cid]);
  if (!st) throw BadRequest('Process not found');
  const dup = await queryOne(`SELECT id FROM mst_process_operation WHERE company_id = ? AND op_code = ? AND id <> ?`, [cid, b.op_code, id]);
  if (dup) throw BadRequest(`Operation code ${b.op_code} already exists`);
}

processMasterRouter.post('/process-master/operations', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = opSchema.parse(req.body);
  await opCheck(cid, b);
  const r = await execute(
    `INSERT INTO mst_process_operation (company_id, stage_id, op_code, op_name, default_rate, sort_order, is_active) VALUES (?,?,?,?,?,?,?)`,
    [cid, b.stage_id, b.op_code, b.op_name, b.default_rate, b.sort_order, b.is_active ? 1 : 0]);
  await audit(req, 'mst_process_operation', r.insertId, 'INSERT', undefined, b);
  res.status(201).json({ data: { id: r.insertId } });
}));

processMasterRouter.put('/process-master/operations/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = opSchema.parse(req.body);
  const before = await queryOne<any>(`SELECT * FROM mst_process_operation WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!before) throw NotFound('Operation not found');
  await opCheck(cid, b, id);
  await execute(
    `UPDATE mst_process_operation SET stage_id = ?, op_code = ?, op_name = ?, default_rate = ?, sort_order = ?, is_active = ? WHERE id = ?`,
    [b.stage_id, b.op_code, b.op_name, b.default_rate, b.sort_order, b.is_active ? 1 : 0, id]);
  await audit(req, 'mst_process_operation', id, 'UPDATE', before, b);
  res.json({ data: { id } });
}));

// ============================================================
// Contractor rates per operation
// ============================================================
/** Current rate per operation for a contractor (latest effective, active row). */
export async function contractorRates(cid: number, vendorId: number | null, stageId?: number | null) {
  const where = ['o.company_id = ?', 'o.is_active = 1'];
  const params: unknown[] = [vendorId ?? 0, cid];
  if (stageId) { where.push('o.stage_id = ?'); params.push(stageId); }
  return query<any>(
    `SELECT o.id, o.stage_id, o.op_code, o.op_name, o.default_rate, o.sort_order,
            (SELECT r.rate FROM mst_contractor_op_rate r
              WHERE r.company_id = o.company_id AND r.vendor_id = ? AND r.operation_id = o.id AND r.is_active = 1
                AND (r.effective_from IS NULL OR r.effective_from <= CURDATE())
              ORDER BY r.effective_from DESC, r.id DESC LIMIT 1) AS contractor_rate
       FROM mst_process_operation o
      WHERE ${where.join(' AND ')}
      ORDER BY o.sort_order, o.op_name`, params).then((rows) => rows.map((o) => ({
    ...o, rate: o.contractor_rate != null ? n(o.contractor_rate) : n(o.default_rate),
  })));
}

/**
 * GET /process-master/operations?stage_id=&vendor_id=&io_no= — operations with the rate that applies:
 * the job's rate card when io_no is given and the job has one, else the contractor's rate, else the default.
 */
processMasterRouter.get('/process-master/operations', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const qp = z.object({ stage_id: s.id(), vendor_id: s.id(), io_no: z.string().trim().max(40).optional() }).parse(req.query);
  const ops = await contractorRates(cid, qp.vendor_id ?? null, qp.stage_id ?? null);
  if (!qp.io_no) { res.json({ data: ops }); return; }
  const eff = (await effectiveJobCard(cid, qp.io_no))!;
  const card = eff.rows;
  const byOp = new Map(card.map((c) => [c.operation_id, c.rate]));
  res.json({
    data: ops.map((o) => (byOp.has(Number(o.id))
      ? { ...o, rate: byOp.get(Number(o.id)), job_rate: byOp.get(Number(o.id)), in_job_card: true }
      : { ...o, in_job_card: false })),
    meta: { io_no: qp.io_no, job_card_ops: card.length, card_status: eff.inForce ? 'LOCKED' : eff.status, card_revision: eff.inRevision ? eff.revision - 1 : eff.revision, card_in_revision: eff.inRevision },
  });
}));

processMasterRouter.put('/process-master/contractor-rates', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    vendor_id: s.idReq(),
    rates: z.array(z.object({ operation_id: s.idReq(), rate: z.coerce.number().min(0).max(100000).nullable() })).max(500),
  }).parse(req.body);
  const v = await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.vendor_id, cid]);
  if (!v) throw BadRequest('Contractor not found');
  await transaction(async (tx) => {
    for (const r of b.rates) {
      const op = await txQueryOne(tx, `SELECT id FROM mst_process_operation WHERE id = ? AND company_id = ?`, [r.operation_id, cid]);
      if (!op) throw BadRequest('Operation not found');
      // One active rate per contractor + operation: blank clears it (falls back to the default rate).
      await txExecute(tx,
        `UPDATE mst_contractor_op_rate SET is_active = 0 WHERE company_id = ? AND vendor_id = ? AND operation_id = ? AND is_active = 1`,
        [cid, b.vendor_id, r.operation_id]);
      if (r.rate != null) {
        await txExecute(tx,
          `INSERT INTO mst_contractor_op_rate (company_id, vendor_id, operation_id, rate, effective_from) VALUES (?,?,?,?,CURDATE())`,
          [cid, b.vendor_id, r.operation_id, r.rate]);
      }
    }
    await audit(req, 'mst_contractor_op_rate', b.vendor_id, 'UPDATE', undefined, { rates: b.rates }, tx);
  });
  res.json({ data: await contractorRates(cid, b.vendor_id) });
}));

// ============================================================
// Job rate card — per job (IO no) only the operations it needs, with its rate
// (client voice note 29-Sep-2026: power table / singer / flatlock rates fixed
//  job-wise; not every job uses every operation of the master)
// ============================================================

/** Job rate card of a job for a process: every operation of the process, with the job's rate where picked. */
async function jobRateCard(cid: number, ioNo: string, stageId: number) {
  const rows = await query<any>(
    `SELECT o.id AS operation_id, o.op_code, o.op_name, o.default_rate, o.sort_order,
            j.id AS card_id, j.rate AS job_rate, j.smv, j.remarks
       FROM mst_process_operation o
       LEFT JOIN trx_job_op_rate j ON j.operation_id = o.id AND j.company_id = o.company_id AND j.io_no = ?
      WHERE o.company_id = ? AND o.stage_id = ? AND (o.is_active = 1 OR j.id IS NOT NULL)
      ORDER BY o.sort_order, o.op_name`, [ioNo, cid, stageId]);
  return rows.map((r) => ({ ...r, selected: !!r.card_id, job_rate: r.job_rate == null ? null : n(r.job_rate), smv: r.smv == null ? null : n(r.smv), default_rate: n(r.default_rate) }));
}

// ------------------------------------------------------------
// Production rate fixing — approve & lock (client audio 15-Oct-2026: "for
// stitching we need to set and lock the rates of each process for production;
// only based on that can we carry it forward everywhere").
// A job's card (trx_job_rate_card over its trx_job_op_rate rows) is
//   DRAFT → SUBMITTED (production) → LOCKED (PRODUCTION.APPROVE).
// Locked: rates cannot be edited; every DC of the job (contractor and, with
// PRODUCTION_RATE_LOCK_ENFORCED = 1, in-house units) takes the card rate, a DC
// with no operations for a carded process takes all the card's operations of
// that process, and production costing prices the job from it. A change needs
// Revise (reason, revision no + 1) → DRAFT; every step is kept in
// trx_job_rate_card_rev with the rates at that moment.
// ------------------------------------------------------------
export type CardStatus = 'DRAFT' | 'SUBMITTED' | 'LOCKED';

export async function rateCardHeader(cid: number, ioNo: string) {
  return queryOne<any>(`SELECT * FROM trx_job_rate_card WHERE company_id = ? AND io_no = ?`, [cid, ioNo]);
}

export type JobRate = { operation_id: number; stage_id: number; rate: number; op_name: string | null };
export type EffectiveCard = { status: CardStatus | null; revision: number; inRevision: boolean; inForce: boolean; rows: JobRate[];
  /** production overhead ₹ / PC in force (client 16-Oct-2026: "production costing needs overhead") */
  overheadPc: number | null; costPerMin: number | null };

/** Production overhead ₹ / PC of a card: ₹ / PC, or % of the card's conversion rate (Σ operation rates). */
export function cardOverheadPc(basis: unknown, value: unknown, conversion: number) {
  if (value == null || value === '' || !basis) return null;
  const v = n(value);
  return Math.round((String(basis) === 'PCT' ? (conversion * v) / 100 : v) * 10000) / 10000;
}

/**
 * The rates IN FORCE for jobs: a LOCKED card → its rates; a card opened for revision (not locked, but locked before) →
 * the rates of its last approval until the revision is locked again (draft rates never reach DCs, bills or costing);
 * a card never locked → its current rates (as before the lock existed).
 */
export async function effectiveJobRates(cid: number, ioNos: string[]): Promise<Map<string, EffectiveCard>> {
  const ios = [...new Set(ioNos.filter(Boolean))];
  const out = new Map<string, EffectiveCard>();
  if (!ios.length) return out;
  const heads = await query<any>(`SELECT io_no, status, revision_no, cost_per_min, overhead_basis, overhead_value FROM trx_job_rate_card WHERE company_id = ? AND io_no IN (?)`, [cid, ios]);
  const cur = await query<any>(
    `SELECT j.io_no, j.operation_id, j.stage_id, j.rate, o.op_name FROM trx_job_op_rate j
       LEFT JOIN mst_process_operation o ON o.id = j.operation_id WHERE j.company_id = ? AND j.io_no IN (?)`, [cid, ios]);
  const unlocked = heads.filter((h) => h.status !== 'LOCKED').map((h) => h.io_no);
  const snaps = unlocked.length ? await query<any>(
    `SELECT r.io_no, r.rates_json, r.overhead_pc, r.cost_per_min FROM trx_job_rate_card_rev r
      WHERE r.company_id = ? AND r.io_no IN (?) AND r.action = 'LOCK'
        AND r.id = (SELECT MAX(r2.id) FROM trx_job_rate_card_rev r2 WHERE r2.card_id = r.card_id AND r2.action = 'LOCK')`, [cid, unlocked]) : [];
  const snapOps = new Set<number>();
  const parsed = new Map<string, any[]>();
  const snapHead = new Map(snaps.map((sn) => [sn.io_no, sn]));
  for (const sn of snaps) {
    let rj: any = sn.rates_json;
    try { rj = typeof rj === 'string' ? JSON.parse(rj) : rj; } catch { rj = []; }
    const list = Array.isArray(rj) ? rj : [];
    parsed.set(sn.io_no, list); list.forEach((x) => snapOps.add(Number(x.operation_id)));
  }
  const opRows = snapOps.size ? await query<any>(`SELECT id, stage_id, op_name FROM mst_process_operation WHERE id IN (?)`, [[...snapOps]]) : [];
  const opOf = new Map(opRows.map((o) => [Number(o.id), o]));
  for (const io of ios) {
    const h = heads.find((x) => x.io_no === io);
    const status = (h?.status ?? null) as CardStatus | null;
    const snap = parsed.get(io);
    const inRevision = !!h && status !== 'LOCKED' && !!snap;
    const rows: JobRate[] = inRevision
      ? snap!.map((x) => ({ operation_id: Number(x.operation_id), stage_id: Number(x.stage_id ?? opOf.get(Number(x.operation_id))?.stage_id),
          rate: n(x.rate), op_name: x.op_name ?? opOf.get(Number(x.operation_id))?.op_name ?? null }))
      : cur.filter((c) => c.io_no === io).map((c) => ({ operation_id: Number(c.operation_id), stage_id: Number(c.stage_id), rate: n(c.rate), op_name: c.op_name }));
    const conv = rows.reduce((a, r) => a + r.rate, 0);
    const sh = snapHead.get(io);
    const overheadPc = inRevision ? (sh?.overhead_pc == null ? null : n(sh.overhead_pc)) : cardOverheadPc(h?.overhead_basis, h?.overhead_value, conv);
    const costPerMin = inRevision ? (sh?.cost_per_min == null ? null : n(sh.cost_per_min)) : (h?.cost_per_min == null ? null : n(h.cost_per_min));
    out.set(io, { status: status ?? (rows.length ? 'DRAFT' : null), revision: h ? Number(h.revision_no) : 0, inRevision, inForce: status === 'LOCKED' || inRevision, rows,
      overheadPc, costPerMin });
  }
  return out;
}
export async function effectiveJobCard(cid: number, ioNo: string | null | undefined) {
  return ioNo ? (await effectiveJobRates(cid, [ioNo])).get(ioNo)! : null;
}

/** The job's approved (locked) rates in force — also while a revision is pending — else null; enforced = PRODUCTION_RATE_LOCK_ENFORCED. */
export async function lockedJobCard(cid: number, ioNo: string | null | undefined) {
  const e = await effectiveJobCard(cid, ioNo);
  if (!e?.inForce) return null;
  const setting = await queryOne<any>(`SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'PRODUCTION_RATE_LOCK_ENFORCED'`, [cid]);
  const enforced = String(setting?.setting_value ?? '1').trim() !== '0';
  return {
    enforced, revision: e.inRevision ? e.revision - 1 : e.revision, inRevision: e.inRevision,
    rates: new Map(e.rows.map((r) => [r.operation_id, { rate: r.rate, stage_id: r.stage_id, op_name: r.op_name as string }])),
  };
}

/** Rates can change only while the card is DRAFT / SUBMITTED; an edit of a SUBMITTED card sends it back to DRAFT. */
async function assertCardEditable(cid: number, ioNo: string) {
  const h = await rateCardHeader(cid, ioNo);
  if (h?.status === 'LOCKED') {
    throw BadRequest(`Job ${ioNo} rate card is Approved & Locked (revision ${h.revision_no}) — use Revise with a reason to change it`);
  }
  return h;
}
async function touchCardDraft(tx: any, cid: number, ioNo: string, styleId: number | null, userId: number) {
  await txExecute(tx,
    `INSERT INTO trx_job_rate_card (company_id, io_no, style_id, status, created_by) VALUES (?,?,?,'DRAFT',?)
     ON DUPLICATE KEY UPDATE status = IF(status = 'LOCKED', status, 'DRAFT'), style_id = COALESCE(VALUES(style_id), style_id),
                             submitted_by = IF(status = 'LOCKED', submitted_by, NULL), submitted_at = IF(status = 'LOCKED', submitted_at, NULL)`,
    [cid, ioNo, styleId, userId]);
}

async function cardRates(cid: number, ioNo: string) {
  return query<any>(
    `SELECT j.operation_id, o.op_code, o.op_name, j.stage_id, ps.stage_name, j.rate, j.smv
       FROM trx_job_op_rate j
       LEFT JOIN mst_process_operation o ON o.id = j.operation_id
       LEFT JOIN cfg_process_stage ps ON ps.id = j.stage_id
      WHERE j.company_id = ? AND j.io_no = ? ORDER BY ps.sort_order, o.sort_order, o.op_name`, [cid, ioNo]);
}

async function cardStatus(cid: number, ioNo: string) {
  const h = await rateCardHeader(cid, ioNo);
  const eff = (await effectiveJobCard(cid, ioNo))!;
  const rates = await cardRates(cid, ioNo);
  const history = h ? await query<any>(
    `SELECT r.id, r.revision_no, r.action, r.reason, r.total_rate, r.overhead_pc, r.cost_per_min, r.rates_json, r.created_at, u.full_name AS by_name
       FROM trx_job_rate_card_rev r LEFT JOIN mst_user u ON u.id = r.created_by
      WHERE r.card_id = ? ORDER BY r.id DESC LIMIT 200`, [h.id]) : [];
  const users = h ? await query<any>(`SELECT id, full_name FROM mst_user WHERE id IN (?)`, [[h.submitted_by ?? 0, h.locked_by ?? 0]]) : [];
  const nameOf = (id: unknown) => users.find((u) => Number(u.id) === Number(id))?.full_name ?? null;
  return {
    io_no: ioNo,
    status: (h?.status ?? (rates.length ? 'DRAFT' : null)) as CardStatus | null,
    revision_no: h ? Number(h.revision_no) : 0,
    submitted_at: h?.submitted_at ?? null, submitted_by: nameOf(h?.submitted_by),
    locked_at: h?.locked_at ?? null, locked_by: nameOf(h?.locked_by),
    operations: rates.length,
    total_rate: Math.round(rates.reduce((a, r) => a + n(r.rate), 0) * 10000) / 10000,
    // a revision is pending: the last approved rates stay in force until it is locked again
    in_revision: eff.inRevision,
    in_force_total: Math.round(eff.rows.reduce((a, r) => a + r.rate, 0) * 10000) / 10000,
    cost_per_min: h?.cost_per_min == null ? null : n(h.cost_per_min),
    total_smv: Math.round(rates.reduce((a, r) => a + n(r.smv), 0) * 10000) / 10000,
    overhead_basis: h?.overhead_basis ?? null, overhead_value: h?.overhead_value == null ? null : n(h.overhead_value),
    overhead_pc: cardOverheadPc(h?.overhead_basis, h?.overhead_value, rates.reduce((a, r) => a + n(r.rate), 0)),
    in_force_overhead_pc: eff.overheadPc,
    history: history.map((r) => {
      let rj: any = r.rates_json;
      try { rj = typeof rj === 'string' ? JSON.parse(rj) : rj; } catch { rj = null; }
      return { ...r, total_rate: n(r.total_rate), overhead_pc: r.overhead_pc == null ? null : n(r.overhead_pc), rates_json: undefined, rates: Array.isArray(rj) ? rj : [] };
    }),
  };
}

async function cardStep(req: any, ioNo: string, action: 'SUBMIT' | 'LOCK' | 'REJECT' | 'REVISE', reason: string | null) {
  const cid = req.user!.companyId;
  await transaction(async (tx) => {
    const h = await txQueryOne<any>(tx, `SELECT * FROM trx_job_rate_card WHERE company_id = ? AND io_no = ? FOR UPDATE`, [cid, ioNo]);
    const rates = await txQuery<any>(tx,
      `SELECT j.operation_id, j.stage_id, o.op_name, ps.stage_name, j.rate, j.smv FROM trx_job_op_rate j
         LEFT JOIN mst_process_operation o ON o.id = j.operation_id LEFT JOIN cfg_process_stage ps ON ps.id = j.stage_id
        WHERE j.company_id = ? AND j.io_no = ?`, [cid, ioNo]);
    if (!h || !rates.length) throw BadRequest(`Job ${ioNo} has no rates on its card yet`);
    const st = h.status as CardStatus;
    let rev = Number(h.revision_no);
    if (action === 'SUBMIT') {
      if (st !== 'DRAFT') throw BadRequest(`Only a Draft card can be submitted (it is ${st})`);
      await txExecute(tx, `UPDATE trx_job_rate_card SET status = 'SUBMITTED', submitted_by = ?, submitted_at = NOW() WHERE id = ?`, [req.user!.id, h.id]);
    } else if (action === 'LOCK') {
      if (st === 'LOCKED') throw BadRequest('The card is already locked');
      if (rates.some((r) => n(r.rate) <= 0)) throw BadRequest(`Every operation needs a rate above 0 before locking (${rates.filter((r) => n(r.rate) <= 0).map((r) => r.op_name).join(', ')})`);
      const costing = h.style_id ? await txQueryOne<any>(tx,
        `SELECT c.id FROM trx_costing c LEFT JOIN cfg_status s ON s.id = c.status_id
          WHERE c.company_id = ? AND c.style_id = ? AND c.is_deleted = 0 AND c.costing_type = 'PRE_COSTING'
          ORDER BY (s.code = 'APPROVED') DESC, c.approved_at DESC, c.version DESC, c.id DESC LIMIT 1`, [cid, h.style_id]) : null;
      await txExecute(tx,
        `UPDATE trx_job_rate_card SET status = 'LOCKED', locked_by = ?, locked_at = NOW(), costing_id = ?,
                submitted_by = COALESCE(submitted_by, ?), submitted_at = COALESCE(submitted_at, NOW()) WHERE id = ?`,
        [req.user!.id, costing?.id ?? null, req.user!.id, h.id]);
    } else if (action === 'REJECT') {
      if (st !== 'SUBMITTED') throw BadRequest(`Only a Submitted card can be sent back (it is ${st})`);
      await txExecute(tx, `UPDATE trx_job_rate_card SET status = 'DRAFT', submitted_by = NULL, submitted_at = NULL WHERE id = ?`, [h.id]);
    } else {
      if (st !== 'LOCKED') throw BadRequest(`Only a Locked card can be revised (it is ${st})`);
      rev += 1;
      await txExecute(tx,
        `UPDATE trx_job_rate_card SET status = 'DRAFT', revision_no = ?, locked_by = NULL, locked_at = NULL, submitted_by = NULL, submitted_at = NULL WHERE id = ?`,
        [rev, h.id]);
    }
    const snap = rates.map((r) => ({ operation_id: Number(r.operation_id), stage_id: Number(r.stage_id), op_name: r.op_name, stage_name: r.stage_name, rate: n(r.rate),
      smv: r.smv == null ? null : n(r.smv) }));
    const conv = snap.reduce((a, r) => a + r.rate, 0);
    await txExecute(tx,
      `INSERT INTO trx_job_rate_card_rev (card_id, company_id, io_no, revision_no, action, reason, total_rate, overhead_pc, cost_per_min, rates_json, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [h.id, cid, ioNo, rev, action, reason, conv, cardOverheadPc(h.overhead_basis, h.overhead_value, conv), h.cost_per_min ?? null, JSON.stringify(snap), req.user!.id]);
    await audit(req, 'trx_job_rate_card', Number(h.id), 'UPDATE', { status: st, revision_no: h.revision_no },
      { status: action === 'SUBMIT' ? 'SUBMITTED' : action === 'LOCK' ? 'LOCKED' : 'DRAFT', revision_no: rev, reason }, tx);
  });
  return cardStatus(cid, ioNo);
}

const ioBody = z.object({ io_no: z.string().trim().min(1).max(40), reason: s.nullableStr(500) });

/** GET /job-rate-cards/status?io_no= — lock status, revision and history of a job's card. */
processMasterRouter.get('/job-rate-cards/status', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ io_no: z.string().trim().min(1).max(40) }).parse(req.query);
  res.json({ data: await cardStatus(req.user!.companyId, qp.io_no) });
}));
processMasterRouter.post('/job-rate-cards/submit', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const b = ioBody.parse(req.body);
  res.json({ data: await cardStep(req, b.io_no, 'SUBMIT', b.reason ?? null) });
}));
processMasterRouter.post('/job-rate-cards/lock', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const b = ioBody.parse(req.body);
  res.json({ data: await cardStep(req, b.io_no, 'LOCK', b.reason ?? null) });
}));
processMasterRouter.post('/job-rate-cards/reject', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const b = ioBody.parse(req.body);
  if (!b.reason?.trim()) throw BadRequest('Give a reason for sending the card back');
  res.json({ data: await cardStep(req, b.io_no, 'REJECT', b.reason.trim()) });
}));
processMasterRouter.post('/job-rate-cards/revise', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const b = ioBody.parse(req.body);
  if (!b.reason?.trim()) throw BadRequest('Give a reason for revising a locked rate card');
  res.json({ data: await cardStep(req, b.io_no, 'REVISE', b.reason.trim()) });
}));

/** GET /job-rate-cards — jobs that have a rate card, per process, with the total rate / PCS and the card's lock status. */
processMasterRouter.get('/job-rate-cards', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query<any>(
    `SELECT j.io_no, j.stage_id, ps.stage_name, MAX(j.style_id) AS style_id, MAX(st.style_code) AS style_code,
            COUNT(*) AS operations, SUM(j.rate) AS total_rate, MAX(COALESCE(j.updated_at, j.created_at)) AS updated_at,
            MAX(COALESCE(c.status, 'DRAFT')) AS card_status, MAX(COALESCE(c.revision_no, 0)) AS revision_no
       FROM trx_job_op_rate j
       LEFT JOIN cfg_process_stage ps ON ps.id = j.stage_id
       LEFT JOIN mst_style st ON st.id = j.style_id
       LEFT JOIN trx_job_rate_card c ON c.company_id = j.company_id AND c.io_no = j.io_no
      WHERE j.company_id = ? ${req.query.io_no ? 'AND j.io_no = ?' : ''}
      GROUP BY j.io_no, j.stage_id, ps.stage_name ORDER BY updated_at DESC LIMIT 500`,
    req.query.io_no ? [cid, String(req.query.io_no)] : [cid]);
  res.json({ data: rows.map((r) => ({ ...r, total_rate: r2(n(r.total_rate)), revision_no: Number(r.revision_no) })) });
}));

/** GET /job-rate-cards/card?io_no=&stage_id= — the card to edit. */
processMasterRouter.get('/job-rate-cards/card', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ io_no: z.string().trim().min(1).max(40), stage_id: s.idReq() }).parse(req.query);
  res.json({ data: await jobRateCard(req.user!.companyId, qp.io_no, qp.stage_id) });
}));

/** PUT /job-rate-cards — replace a job's picked operations + rates for one process. */
processMasterRouter.put('/job-rate-cards', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    io_no: z.string().trim().min(1).max(40),
    style_id: s.id(),
    stage_id: s.idReq(),
    operations: z.array(z.object({
      operation_id: s.idReq(),
      rate: z.coerce.number().min(0).max(100000).optional(),
      // production enters SMV (client 16-Oct-2026): rate = SMV × the card's ₹ / min, worked out here
      smv: z.coerce.number().min(0).max(1000).nullish(),
      remarks: s.nullableStr(255),
    })).max(200),
  }).parse(req.body);
  await jobOfIo(cid, b.io_no);
  const hdr = await assertCardEditable(cid, b.io_no);
  const cpm = hdr?.cost_per_min == null ? null : n(hdr.cost_per_min);
  for (const o of b.operations) {
    if (o.smv != null) {
      if (!cpm) throw BadRequest('Set the cost per minute (₹ / min) of the job first — SMV operations are priced SMV × ₹ / min');
      o.rate = Math.round(o.smv * cpm * 10000) / 10000;
    } else if (o.rate == null) throw BadRequest('Give a rate, or an SMV, for every picked operation');
  }
  const ids = b.operations.map((o) => o.operation_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('An operation is listed twice');
  if (ids.length) {
    const ops = await query<any>(`SELECT id, stage_id FROM mst_process_operation WHERE company_id = ? AND id IN (?)`, [cid, ids]);
    if (ops.length !== ids.length) throw BadRequest('Operation not found');
    if (ops.some((o) => Number(o.stage_id) !== b.stage_id)) throw BadRequest('Every operation must belong to the chosen process');
  }
  await transaction(async (tx) => {
    const before = await txQuery<any>(tx, `SELECT operation_id, rate FROM trx_job_op_rate WHERE company_id = ? AND io_no = ? AND stage_id = ?`, [cid, b.io_no, b.stage_id]);
    await txExecute(tx, `DELETE FROM trx_job_op_rate WHERE company_id = ? AND io_no = ? AND stage_id = ?`, [cid, b.io_no, b.stage_id]);
    for (const o of b.operations) {
      await txExecute(tx,
        `INSERT INTO trx_job_op_rate (company_id, io_no, style_id, stage_id, operation_id, rate, smv, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
        [cid, b.io_no, b.style_id ?? null, b.stage_id, o.operation_id, o.rate, o.smv ?? null, o.remarks ?? null, req.user!.id]);
    }
    await touchCardDraft(tx, cid, b.io_no, b.style_id ?? null, req.user!.id);
    await audit(req, 'trx_job_op_rate', 0, 'UPDATE', { io_no: b.io_no, stage_id: b.stage_id, operations: before },
      { io_no: b.io_no, stage_id: b.stage_id, operations: b.operations }, tx);
  });
  res.json({ data: await jobRateCard(cid, b.io_no, b.stage_id) });
}));

/**
 * PUT /job-rate-cards/settings — the job's production costing settings (client 16-Oct-2026: "production
 * costing needs overhead; SMV operations are entered there"): ₹ per standard minute (every SMV operation is
 * re-priced SMV × ₹ / min) and production overhead (₹ / PC or % of the conversion rate). Draft / submitted only.
 */
processMasterRouter.put('/job-rate-cards/settings', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    io_no: z.string().trim().min(1).max(40),
    cost_per_min: z.coerce.number().min(0).max(1000).nullish(),
    overhead_basis: z.enum(['PER_PC', 'PCT']).nullish(),
    overhead_value: z.coerce.number().min(0).max(100000).nullish(),
  }).parse(req.body);
  if (b.overhead_basis === 'PCT' && (b.overhead_value ?? 0) >= 100) throw BadRequest('Overhead % must be below 100');
  const { styleId } = await jobOfIo(cid, b.io_no);
  await assertCardEditable(cid, b.io_no);
  await transaction(async (tx) => {
    const before = await txQueryOne<any>(tx, `SELECT cost_per_min, overhead_basis, overhead_value FROM trx_job_rate_card WHERE company_id = ? AND io_no = ?`, [cid, b.io_no]);
    await touchCardDraft(tx, cid, b.io_no, styleId, req.user!.id);
    const set: string[] = []; const vals: unknown[] = [];
    if (b.cost_per_min !== undefined) { set.push('cost_per_min = ?'); vals.push(b.cost_per_min || null); }
    if (b.overhead_basis !== undefined) { set.push('overhead_basis = ?'); vals.push(b.overhead_basis ?? null); }
    if (b.overhead_value !== undefined) { set.push('overhead_value = ?'); vals.push(b.overhead_value ?? null); }
    if (set.length) await txExecute(tx, `UPDATE trx_job_rate_card SET ${set.join(', ')} WHERE company_id = ? AND io_no = ?`, [...vals, cid, b.io_no]);
    if (b.cost_per_min) {
      await txExecute(tx, `UPDATE trx_job_op_rate SET rate = ROUND(smv * ?, 4) WHERE company_id = ? AND io_no = ? AND smv IS NOT NULL`, [b.cost_per_min, cid, b.io_no]);
    }
    await audit(req, 'trx_job_rate_card', 0, 'UPDATE', { io_no: b.io_no, ...before }, b, tx);
  });
  res.json({ data: await cardStatus(cid, b.io_no) });
}));

// ------------------------------------------------------------
// Job rate card from the pre-costing (client call 14-Oct-2026: "if the costing
// is saved, take that amount as the rate per piece — power table, singer …
// in-house rates come from the costing"). The job's style's latest APPROVED
// pre-costing (else the latest) gives a rate per operation row:
//   Sewing (SMV) row → SMV × the costing's ₹ / min · Cutting row → rate ·
//   Processes row → its ₹ / PC (per-KG rows: kg / pc × rate).
// Rows are matched to the operations master by name or op code (case-insensitive,
// trimmed); confirm upserts trx_job_op_rate for the IO, which in-house unit DCs
// and contractor bills already read.
// ------------------------------------------------------------
const opKey = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[\s_\-]+/g, ' ');

async function jobOfIo(cid: number, ioNo: string) {
  const so = await queryOne<any>(
    `SELECT so.id, (SELECT sol.style_id FROM trx_sales_order_line sol WHERE sol.so_id = so.id ORDER BY sol.id LIMIT 1) AS style_id
       FROM trx_sales_order so WHERE so.company_id = ? AND so.is_deleted = 0
        AND (so.io_no = ? OR (COALESCE(so.io_no, '') = '' AND so.so_no = ?)) ORDER BY so.id DESC LIMIT 1`, [cid, ioNo, ioNo]);
  const cut = so?.style_id ? null
    : await queryOne<any>(`SELECT style_id FROM trx_cutting_bundle WHERE company_id = ? AND io_no = ? AND style_id IS NOT NULL LIMIT 1`, [cid, ioNo]);
  const anyCut = so || cut ? true : !!(await queryOne(`SELECT id FROM trx_cutting_bundle WHERE company_id = ? AND io_no = ? LIMIT 1`, [cid, ioNo]));
  if (!so && !anyCut) throw BadRequest(`Job ${ioNo} not found (no sales order or cutting with that IO no)`);
  return { styleId: so?.style_id ? Number(so.style_id) : cut?.style_id ? Number(cut.style_id) : null };
}

async function costingRatePreview(cid: number, ioNo: string, costingId?: number | null) {
  const { styleId } = await jobOfIo(cid, ioNo);
  const costing = costingId
    ? await queryOne<any>(
      `SELECT c.*, st.code AS status_code, sty.style_code FROM trx_costing c
         LEFT JOIN cfg_status st ON st.id = c.status_id LEFT JOIN mst_style sty ON sty.id = c.style_id
        WHERE c.id = ? AND c.company_id = ? AND c.is_deleted = 0`, [costingId, cid])
    : styleId ? await queryOne<any>(
      `SELECT c.*, st.code AS status_code, sty.style_code FROM trx_costing c
         LEFT JOIN cfg_status st ON st.id = c.status_id LEFT JOIN mst_style sty ON sty.id = c.style_id
        WHERE c.company_id = ? AND c.style_id = ? AND c.is_deleted = 0 AND c.costing_type = 'PRE_COSTING'
        ORDER BY (st.code = 'APPROVED') DESC, c.approved_at DESC, c.version DESC, COALESCE(c.updated_at, c.created_at) DESC, c.id DESC LIMIT 1`, [cid, styleId])
      : null;
  if (costingId && !costing) throw NotFound('Costing not found');
  const ops = await query<any>(
    `SELECT o.id, o.op_code, o.op_name, o.stage_id, o.default_rate, ps.stage_name
       FROM mst_process_operation o LEFT JOIN cfg_process_stage ps ON ps.id = o.stage_id
      WHERE o.company_id = ? AND o.is_active = 1 ORDER BY ps.sort_order, o.sort_order, o.op_name`, [cid]);
  const card = await query<any>(`SELECT operation_id, rate FROM trx_job_op_rate WHERE company_id = ? AND io_no = ?`, [cid, ioNo]);
  const cardRate = new Map(card.map((c) => [Number(c.operation_id), n(c.rate)]));
  const operations = ops.map((o) => ({ id: Number(o.id), op_code: o.op_code, op_name: o.op_name, stage_id: Number(o.stage_id), stage_name: o.stage_name,
    current_rate: cardRate.has(Number(o.id)) ? cardRate.get(Number(o.id))! : null }));
  if (!costing) return { style_id: styleId, costing: null, rows: [], operations };

  let dj: any = {};
  try { dj = typeof costing.data_json === 'string' ? JSON.parse(costing.data_json || '{}') : (costing.data_json ?? {}); } catch { dj = {}; }
  const perMin = n(costing.smv_rate_per_min);
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const src: { source: 'SEWING' | 'CUTTING' | 'PROCESS'; name: string; smv?: number; costing_rate: number }[] = [];
  // Flat CMT (client 16-Oct-2026: the merchandiser's main way): the SMV rows are not part of the costing, so they
  // are not loaded; production enters SMV on this card. A flat covering cutting → finishing also leaves out cutting rows.
  const flat = dj.useFlatSewingRate === true;
  const cmtAll = cmtCoversCutToFinish(dj);
  for (const r of flat ? [] : Array.isArray(dj.sewingOps) ? dj.sewingOps : []) {
    if (String(r?.operation ?? '').trim()) src.push({ source: 'SEWING', name: String(r.operation).trim(), smv: n(r.smv), costing_rate: r4(n(r.smv) * perMin) });
  }
  for (const r of cmtAll ? [] : Array.isArray(dj.cuttingOps) ? dj.cuttingOps : []) {
    if (String(r?.operation ?? '').trim()) src.push({ source: 'CUTTING', name: String(r.operation).trim(), costing_rate: r4(n(r.rate)) });
  }
  for (const r of Array.isArray(dj.processes) ? dj.processes : []) {
    if (!String(r?.process_name ?? '').trim()) continue;
    const basis = String(r?.basis ?? '').toUpperCase().replace(/[\s-]/g, '_');
    const rate = basis === 'PER_KG' || basis === 'KG' ? n(r.consumption) * n(r.rate) : n(r.rate);
    src.push({ source: 'PROCESS', name: String(r.process_name).trim(), costing_rate: r4(rate) });
  }
  const rows = src.map((r) => {
    const k = opKey(r.name);
    const op = ops.find((o) => opKey(o.op_name) === k) ?? ops.find((o) => opKey(o.op_code) === k);
    const current = op && cardRate.has(Number(op.id)) ? cardRate.get(Number(op.id))! : null;
    return {
      ...r,
      operation_id: op ? Number(op.id) : null,
      op_name: op?.op_name ?? null, op_code: op?.op_code ?? null, stage_name: op?.stage_name ?? null,
      current_rate: current,
      action: !op ? 'NO_MATCH' : current == null ? 'NEW' : Math.abs(current - r.costing_rate) < 0.00005 ? 'SAME' : 'UPDATE',
    };
  });
  return {
    style_id: styleId,
    costing: { id: Number(costing.id), costing_no: costing.costing_no, version: costing.version, status: costing.status_code ?? 'DRAFT',
      style_code: costing.style_code, smv_rate_per_min: perMin, use_flat_sewing_rate: flat,
      flat_cmt: flat ? { rate: n(dj.flatSewingRate), scope: cmtAll ? 'CUT_TO_FINISH' : 'STITCHING', description: dj.flatSewingDesc ?? null } : null,
      overhead_cost: n(costing.overhead_cost) },
    rows, operations,
  };
}

/** GET /job-rate-cards/from-costing?io_no=&costing_id= — preview of the job's costing rates against its rate card. */
processMasterRouter.get('/job-rate-cards/from-costing', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ io_no: z.string().trim().min(1).max(40), costing_id: s.id() }).parse(req.query);
  res.json({ data: await costingRatePreview(req.user!.companyId, qp.io_no, qp.costing_id ?? null) });
}));

/**
 * POST /job-rate-cards/from-costing — upsert the job's rate card from its costing.
 * Body rows = the confirmed preview ({operation_id, rate}); rows mapped to the same
 * operation are added together. Without rows every matched preview row is applied.
 * Operations not in the costing keep their card rate.
 */
processMasterRouter.post('/job-rate-cards/from-costing', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    io_no: z.string().trim().min(1).max(40),
    costing_id: s.id(),
    rows: z.array(z.object({ operation_id: s.idReq(), rate: z.coerce.number().min(0).max(100000), smv: z.coerce.number().min(0).max(1000).nullish() })).max(500).optional(),
  }).parse(req.body);
  await assertCardEditable(cid, b.io_no);
  const pv = await costingRatePreview(cid, b.io_no, b.costing_id ?? null);
  if (!pv.costing) throw BadRequest(`No pre-costing found for the style of job ${b.io_no}`);
  const picked: { operation_id: number; rate: number; smv?: number | null }[] = b.rows
    ?? pv.rows.filter((r) => r.operation_id).map((r) => ({ operation_id: r.operation_id!, rate: r.costing_rate, smv: r.source === 'SEWING' ? r.smv ?? null : null }));
  if (!picked.length) throw BadRequest('No costing row is mapped to an operation');
  const sum = new Map<number, number>();
  const smvOf = new Map<number, number>();
  for (const r of picked) {
    sum.set(r.operation_id, (sum.get(r.operation_id) ?? 0) + r.rate);
    if (r.smv != null) smvOf.set(r.operation_id, (smvOf.get(r.operation_id) ?? 0) + r.smv);
  }
  const ids = [...sum.keys()];
  const ops = await query<any>(`SELECT id, stage_id FROM mst_process_operation WHERE company_id = ? AND id IN (?)`, [cid, ids]);
  if (ops.length !== ids.length) throw BadRequest('Operation not found');
  const stageOf = new Map(ops.map((o) => [Number(o.id), Number(o.stage_id)]));
  const remarks = `From costing ${pv.costing.costing_no}`.slice(0, 255);
  await transaction(async (tx) => {
    const before = await txQuery<any>(tx, `SELECT operation_id, rate FROM trx_job_op_rate WHERE company_id = ? AND io_no = ? AND operation_id IN (?)`, [cid, b.io_no, ids]);
    for (const [opId, rate] of sum) {
      await txExecute(tx,
        `INSERT INTO trx_job_op_rate (company_id, io_no, style_id, stage_id, operation_id, rate, smv, remarks, created_by) VALUES (?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE rate = VALUES(rate), smv = VALUES(smv), stage_id = VALUES(stage_id), style_id = COALESCE(VALUES(style_id), style_id), remarks = VALUES(remarks)`,
        [cid, b.io_no, pv.style_id, stageOf.get(opId), opId, Math.round(rate * 10000) / 10000, smvOf.get(opId) ?? null, remarks, req.user!.id]);
    }
    await touchCardDraft(tx, cid, b.io_no, pv.style_id, req.user!.id);
    // SMV rows came in at the costing's ₹ / min: that becomes the card's ₹ / min when it has none
    if (smvOf.size && pv.costing!.smv_rate_per_min > 0) {
      await txExecute(tx, `UPDATE trx_job_rate_card SET cost_per_min = COALESCE(cost_per_min, ?) WHERE company_id = ? AND io_no = ?`, [pv.costing!.smv_rate_per_min, cid, b.io_no]);
    }
    // SMV operations are always SMV × the card's ₹ / min
    await txExecute(tx,
      `UPDATE trx_job_op_rate j JOIN trx_job_rate_card c ON c.company_id = j.company_id AND c.io_no = j.io_no
          SET j.rate = ROUND(j.smv * c.cost_per_min, 4)
        WHERE j.company_id = ? AND j.io_no = ? AND j.smv IS NOT NULL AND c.cost_per_min > 0`, [cid, b.io_no]);
    await audit(req, 'trx_job_op_rate', 0, 'UPDATE', { io_no: b.io_no, operations: before },
      { io_no: b.io_no, costing_id: pv.costing!.id, operations: [...sum].map(([operation_id, rate]) => ({ operation_id, rate })) }, tx);
  });
  res.json({ data: { io_no: b.io_no, costing: pv.costing, applied: sum.size, stages: [...new Set(ops.map((o) => Number(o.stage_id)))] } });
}));

/**
 * Three-way variance of a job, per process / operation (client audio 15-Oct-2026):
 *   Merchandiser  the style's pre-costing rate (same mapping as "Load rates from costing")
 *   Production    the job's rate card (locked or not — the status is returned)
 *   Actual        the job's DCs (not draft / cancelled): rate per operation on each DC,
 *                 weighted by the job's issued PCS; amount = received good PCS × rate.
 *                 DCs that name no operation are a "(DC rate)" row of their process.
 * Order value = rate × order qty; actual vs production compares on received PCS.
 */
export async function jobRateVariance(cid: number, ioNo: string) {
  const pv = await costingRatePreview(cid, ioNo, null);
  const status = await cardStatus(cid, ioNo);
  const eff = (await effectiveJobCard(cid, ioNo))!;
  const draft = eff.inRevision ? await cardRates(cid, ioNo) : [];
  const oq = await queryOne<any>(
    `SELECT COALESCE(SUM(sol.order_qty), 0) AS qty FROM trx_sales_order so JOIN trx_sales_order_line sol ON sol.so_id = so.id
      WHERE so.company_id = ? AND so.is_deleted = 0
        AND (so.io_no = ? OR (COALESCE(so.io_no, '') = '' AND so.so_no = ?))`, [cid, ioNo, ioNo]);
  const orderQty = n(oq?.qty);

  const dcs = await query<any>(
    `SELECT jc.id, jc.challan_no, jc.stage_id, jc.rate, jc.unit_id, ps.stage_name, SUM(jl.qty) AS issued
       FROM trx_jobwork_challan jc
       JOIN trx_jobwork_challan_line jl ON jl.challan_id = jc.id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE jc.company_id = ? AND jl.io_no = ? AND jc.status NOT IN ('DRAFT','CANCELLED')
      GROUP BY jc.id`, [cid, ioNo]);
  const dcIds = dcs.map((d) => Number(d.id));
  const recv = dcIds.length ? await query<any>(
    `SELECT jl.challan_id, COALESCE(SUM(rl.received_qty), 0) AS good
       FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
      WHERE jl.challan_id IN (?) AND jl.io_no = ? GROUP BY jl.challan_id`, [dcIds, ioNo]) : [];
  const dcOps = dcIds.length ? await query<any>(`SELECT challan_id, operation_id, rate FROM trx_jobwork_challan_op WHERE challan_id IN (?)`, [dcIds]) : [];
  const goodOf = new Map(recv.map((r) => [Number(r.challan_id), n(r.good)]));

  type Row = { key: string; stage_id: number | null; stage_name: string | null; operation_id: number | null; op_name: string;
    merch_rate: number | null; prod_rate: number | null; act_w: number; act_amt_issued: number; issued_qty: number; received_qty: number;
    actual_amount: number; dcs: Set<string>; inhouse_dcs: number };
  const rows = new Map<string, Row>();
  const opInfo = new Map(pv.operations.map((o) => [o.id, o]));
  const row = (opId: number | null, stageId: number | null, stageName: string | null, opName: string) => {
    const key = opId ? `op:${opId}` : `dc:${stageId}`;
    if (!rows.has(key)) {
      rows.set(key, { key, stage_id: stageId, stage_name: stageName, operation_id: opId, op_name: opName, merch_rate: null, prod_rate: null,
        act_w: 0, act_amt_issued: 0, issued_qty: 0, received_qty: 0, actual_amount: 0, dcs: new Set(), inhouse_dcs: 0 });
    }
    return rows.get(key)!;
  };
  for (const r of pv.rows) {
    if (!r.operation_id) continue;
    const o = opInfo.get(r.operation_id);
    const x = row(r.operation_id, o?.stage_id ?? null, o?.stage_name ?? null, o?.op_name ?? r.name);
    x.merch_rate = (x.merch_rate ?? 0) + r.costing_rate;
  }
  const stageName = new Map(pv.operations.map((o) => [o.stage_id, o.stage_name]));
  for (const c of eff.rows) {
    const x = row(c.operation_id, c.stage_id, stageName.get(c.stage_id) ?? null, c.op_name ?? `Operation ${c.operation_id}`);
    x.prod_rate = c.rate;
  }
  const draftRate = new Map(draft.map((d) => [Number(d.operation_id), n(d.rate)]));
  for (const d of draft) if (!rows.has(`op:${Number(d.operation_id)}`)) row(Number(d.operation_id), Number(d.stage_id), d.stage_name, d.op_name);
  for (const d of dcs) {
    const ops = dcOps.filter((o) => Number(o.challan_id) === Number(d.id));
    const issued = n(d.issued), good = goodOf.get(Number(d.id)) ?? 0;
    const parts = ops.length
      ? ops.map((o) => ({ opId: Number(o.operation_id), rate: n(o.rate), name: opInfo.get(Number(o.operation_id))?.op_name ?? `Operation ${o.operation_id}` }))
      : [{ opId: null as number | null, rate: d.rate == null ? null : n(d.rate), name: '(DC rate — no operation named)' }];
    for (const p of parts) {
      const x = row(p.opId, Number(d.stage_id), d.stage_name, p.name);
      if (!x.stage_name) x.stage_name = d.stage_name;
      // a DC with no rate (in-house unit before the card) is counted in PCS but not in the actual rate
      if (p.rate != null) { x.act_w += issued; x.act_amt_issued += issued * p.rate; x.actual_amount += good * p.rate; }
      x.issued_qty += issued; x.received_qty += good;
      x.dcs.add(d.challan_no); if (d.unit_id) x.inhouse_dcs += 1;
    }
  }
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const out = [...rows.values()].map((x) => {
    const actual_rate = x.act_w > 0 ? r4(x.act_amt_issued / x.act_w) : null;
    return {
      stage_id: x.stage_id, stage_name: x.stage_name ?? '—', operation_id: x.operation_id, op_name: x.op_name,
      merch_rate: x.merch_rate == null ? null : r4(x.merch_rate), prod_rate: x.prod_rate, actual_rate,
      draft_rate: x.operation_id != null && draftRate.has(x.operation_id) ? draftRate.get(x.operation_id)! : null,
      issued_qty: x.issued_qty, received_qty: x.received_qty, actual_amount: r2(x.actual_amount),
      prod_amount_on_received: x.prod_rate != null ? r2(x.received_qty * x.prod_rate) : null,
      var_prod_vs_merch: x.prod_rate != null && x.merch_rate != null ? r4(x.prod_rate - x.merch_rate) : null,
      var_actual_vs_prod: actual_rate != null && x.prod_rate != null ? r4(actual_rate - x.prod_rate) : null,
      off_card: x.prod_rate == null && x.issued_qty > 0,
      dcs: [...x.dcs], inhouse_dcs: x.inhouse_dcs,
    };
  }).sort((a, b) => String(a.stage_name).localeCompare(String(b.stage_name)) || String(a.op_name).localeCompare(String(b.op_name)));

  const sumOf = (k: 'merch_rate' | 'prod_rate' | 'actual_rate', list = out) => r4(list.reduce((a, r) => a + (r[k] ?? 0), 0));
  const stageNames = [...new Set(out.map((r) => r.stage_name))];
  const stages = stageNames.map((sn) => {
    const l = out.filter((r) => r.stage_name === sn);
    return { stage_name: sn, merch_rate: sumOf('merch_rate', l), prod_rate: sumOf('prod_rate', l), actual_rate: sumOf('actual_rate', l),
      actual_amount: r2(l.reduce((a, r) => a + r.actual_amount, 0)), prod_amount_on_received: r2(l.reduce((a, r) => a + (r.prod_amount_on_received ?? 0), 0)) };
  });
  // actual ₹ / PCS over the operations on the card (comparable with production); all DC rows separately
  // Cost-head mapping (costing documents §7): the merchandiser's ONE flat CMT rate is compared with production's
  // detailed operations of the same scope — cutting + sewing + finishing (or sewing only for a stitching flat).
  const stageIds = [...new Set(out.map((r) => r.stage_id).filter((x): x is number => x != null))];
  const codeOf = new Map(stageIds.length
    ? (await query<any>(`SELECT id, UPPER(stage_code) AS c FROM cfg_process_stage WHERE id IN (?)`, [stageIds])).map((x) => [Number(x.id), String(x.c)])
    : []);
  const CUT = ['CUT', 'CUTTING'], SEW = ['STITCH', 'STITCHING', 'SEW', 'SEWING'], FIN = ['CHECK', 'CHECKING', 'IRON', 'IRONING', 'FINISH', 'FINISHING', 'PRESS'];
  const fc = pv.costing?.flat_cmt ?? null;
  const cmtCodes = fc ? (fc.scope === 'CUT_TO_FINISH' ? [...CUT, ...SEW, ...FIN] : SEW) : [];
  const inCmt = (r: (typeof out)[number]) => r.stage_id != null && cmtCodes.includes(codeOf.get(r.stage_id) ?? '');
  const cmtRows = out.filter(inCmt);
  const cmtProd = cmtRows.some((r) => r.prod_rate != null) ? sumOf('prod_rate', cmtRows) : null;
  const cmtAct = cmtRows.some((r) => r.actual_rate != null) ? sumOf('actual_rate', cmtRows.filter((r) => r.prod_rate != null)) : null;
  const groups = [
    ...(fc ? [{
      key: 'cmt', label: fc.scope === 'CUT_TO_FINISH' ? 'CMT — cutting → finishing (merchandiser flat rate)' : 'Stitching (merchandiser flat rate)',
      merch_rate: fc.rate, prod_rate: cmtProd, actual_rate: cmtAct,
      var_prod_vs_merch: cmtProd != null ? r4(cmtProd - fc.rate) : null,
      var_actual_vs_prod: cmtAct != null && cmtProd != null ? r4(cmtAct - cmtProd) : null,
      operations: cmtRows.filter((r) => r.prod_rate != null).map((r) => r.op_name),
    }] : []),
    {
      key: 'overhead', label: 'Overhead',
      merch_rate: pv.costing ? pv.costing.overhead_cost : null, prod_rate: eff.overheadPc, actual_rate: null,
      var_prod_vs_merch: pv.costing && eff.overheadPc != null ? r4(eff.overheadPc - pv.costing.overhead_cost) : null,
      var_actual_vs_prod: null, operations: [],
    },
  ];
  // merchandiser ₹ / PCS of the conversion = operation rows + the flat CMT rate (its operations carry no own rate)
  const merchPc = r4(sumOf('merch_rate') + (fc?.rate ?? 0)), prodPc = sumOf('prod_rate'), actPc = sumOf('actual_rate', out.filter((r) => r.prod_rate != null)), actAllPc = sumOf('actual_rate');
  const actualAmount = r2(out.reduce((a, r) => a + r.actual_amount, 0));
  // variances compare like with like: only operations that have both figures
  const both = (k1: 'prod_rate' | 'actual_rate', k2: 'merch_rate' | 'prod_rate') => out.filter((r) => r[k1] != null && r[k2] != null);
  const onCard = out.filter((r) => r.prod_rate != null && r.received_qty > 0 && r.actual_rate != null);
  const prodOnReceived = r2(onCard.reduce((a, r) => a + (r.prod_amount_on_received ?? 0), 0));
  const actualOnCard = r2(onCard.reduce((a, r) => a + r.actual_amount, 0));
  return {
    io_no: ioNo, order_qty: orderQty,
    card: { status: status.status, revision_no: status.revision_no, locked_at: status.locked_at, locked_by: status.locked_by, in_revision: eff.inRevision },
    costing: pv.costing,
    rows: out, stages, groups,
    totals: {
      merch_rate_pc: merchPc, prod_rate_pc: prodPc, actual_rate_pc: actPc, actual_rate_pc_all: actAllPc,
      var_prod_vs_merch_pc: r4(both('prod_rate', 'merch_rate').reduce((a, r) => a + (r.prod_rate! - r.merch_rate!), 0) + (groups[0]?.key === 'cmt' ? groups[0].var_prod_vs_merch ?? 0 : 0)),
      var_actual_vs_prod_pc: r4(both('actual_rate', 'prod_rate').reduce((a, r) => a + (r.actual_rate! - r.prod_rate!), 0)),
      merch_amount: r2(merchPc * orderQty), prod_amount: r2(prodPc * orderQty),
      actual_amount: actualAmount, actual_amount_on_card: actualOnCard, prod_amount_on_received: prodOnReceived,
      var_actual_vs_prod_amount: r2(actualOnCard - prodOnReceived),
      off_card_rows: out.filter((r) => r.off_card).length,
    },
  };
}

/** GET /job-rate-cards/variance?io_no= — merchandiser vs production vs actual, per operation. */
processMasterRouter.get('/job-rate-cards/variance', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ io_no: z.string().trim().min(1).max(40) }).parse(req.query);
  res.json({ data: await jobRateVariance(req.user!.companyId, qp.io_no) });
}));

/**
 * Our piece rate for PCS of a job on a DC: the job's rate card for the DC's
 * operations (or all the job's operations of that process when the DC names
 * none); operations the job card lacks keep the DC's own rate. No job card → DC rate.
 */
export async function jobPieceRates(cid: number, challanIds: number[], ioNos: string[]) {
  const out = new Map<string, number>(); // `${challanId}|${io}` → rate
  if (!challanIds.length) return out;
  const dcs = await query<any>(`SELECT id, stage_id, rate, rate_card_rev FROM trx_jobwork_challan WHERE id IN (?)`, [challanIds]);
  const dcOps = await query<any>(`SELECT challan_id, operation_id, rate FROM trx_jobwork_challan_op WHERE challan_id IN (?)`, [challanIds]);
  const ios = [...new Set(ioNos.filter(Boolean))];
  // rates in force: a pending revision's draft rates never price DCs / bills
  const eff = await effectiveJobRates(cid, ios);
  const cards = ios.flatMap((io) => (eff.get(io)?.rows ?? []).map((r) => ({ io_no: io, ...r })));
  for (const dc of dcs) {
    const ops = dcOps.filter((o) => Number(o.challan_id) === Number(dc.id));
    for (const io of ios) {
      // issued at a locked card's rates: the DC keeps them (a later revision applies to later DCs only)
      if (dc.rate_card_rev != null && ops.length) { out.set(`${dc.id}|${io}`, Math.round(ops.reduce((a, o) => a + n(o.rate), 0) * 10000) / 10000); continue; }
      const card = cards.filter((c) => c.io_no === io && Number(c.stage_id) === Number(dc.stage_id));
      if (!card.length) { out.set(`${dc.id}|${io}`, n(dc.rate)); continue; }
      const rate = ops.length
        ? ops.reduce((a, o) => a + (card.find((c) => Number(c.operation_id) === Number(o.operation_id))?.rate != null
          ? n(card.find((c) => Number(c.operation_id) === Number(o.operation_id))!.rate) : n(o.rate)), 0)
        : card.reduce((a, c) => a + n(c.rate), 0);
      out.set(`${dc.id}|${io}`, Math.round(rate * 10000) / 10000);
    }
  }
  return out;
}

// ============================================================
// Contractor bills (pass process inwards for payment)
//   our rate  = job rate card (else DC rate) per job on the inward
//   bill rate = rate on the contractor's invoice; excess over ours must be
//               ALLOWed, kept as ADVANCE (paid, recovered later) or REVISEd
//   net       = payable + GST − TDS − % deduction − other − advance − debit notes
// ============================================================
async function unbilledReceipts(cid: number, vendorId: number, from?: string, to?: string, includeBillId?: number, overrideBasis?: string | null) {
  // only QC-accepted, billable inward (job work doc §16: billing from approved output, never from outward)
  const where = ['r.company_id = ?', 'r.vendor_id = ?', includeBillId ? '(r.contractor_bill_id IS NULL OR r.contractor_bill_id = ?)' : 'r.contractor_bill_id IS NULL',
    `(r.contractor_bill_id IS NOT NULL OR (COALESCE(r.qc_status, 'ACCEPTED') = 'ACCEPTED' AND COALESCE(r.billable, 1) = 1))`];
  const params: unknown[] = includeBillId ? [cid, vendorId, includeBillId] : [cid, vendorId];
  if (from) { where.push('r.receipt_date >= ?'); params.push(from); }
  if (to) { where.push('r.receipt_date <= ?'); params.push(to); }
  const rows = await query<any>(
    `SELECT r.id AS receipt_id, r.receipt_no, r.receipt_date, r.party_dc_no, r.received_qty, r.rejected_qty,
            COALESCE(r.shortage_qty, 0) AS shortage_qty, COALESCE(r.loss_qty, 0) AS loss_qty,
            jc.id AS challan_id, jc.challan_no, jc.rate AS dc_rate, jc.bill_basis AS dc_bill_basis,
            p.jw_bill_basis AS party_bill_basis, ps.stage_name, ps.bill_include_mistake,
            (SELECT GROUP_CONCAT(DISTINCT jl.io_no ORDER BY jl.io_no SEPARATOR ', ')
               FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
              WHERE rl.receipt_id = r.id) AS io_list,
            (SELECT GROUP_CONCAT(o.op_name ORDER BY o.sort_order SEPARATOR ', ')
               FROM trx_jobwork_challan_op co JOIN mst_process_operation o ON o.id = co.operation_id
              WHERE co.challan_id = jc.id) AS operations
       FROM trx_jobwork_receipt r
       JOIN trx_jobwork_challan jc ON jc.id = r.challan_id
       LEFT JOIN mst_party p ON p.id = r.vendor_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.receipt_date, r.id`, params);
  if (!rows.length) return [];
  // Billed PCS per job on each inward, priced with the job's rate card.
  const perIo = await query<any>(
    `SELECT rl.receipt_id, jl.io_no, SUM(rl.received_qty) AS good, SUM(rl.rejected_qty) AS mistake,
            SUM(COALESCE(rl.shortage_qty, 0)) AS short, SUM(COALESCE(rl.loss_qty, 0)) AS loss
       FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
      WHERE rl.receipt_id IN (?) GROUP BY rl.receipt_id, jl.io_no`, [rows.map((r) => r.receipt_id)]);
  const rates = await jobPieceRates(cid, [...new Set(rows.map((r) => Number(r.challan_id)))], perIo.map((p) => p.io_no));
  return rows.map((r) => {
    const basis = effectiveBasis({
      override: overrideBasis,
      dc: r.dc_bill_basis,
      party: r.party_bill_basis,
      stageInclMistake: r.bill_include_mistake,
    });
    const billed = billedQty(basis, {
      good: r.received_qty,
      mistake: r.rejected_qty,
      short: r.shortage_qty,
      loss: r.loss_qty,
    });
    const parts = perIo.filter((p) => Number(p.receipt_id) === Number(r.receipt_id));
    let amount = 0; let qty = 0;
    const jobs = parts.map((p) => {
      const q = billedQty(basis, {
        good: p.good,
        mistake: p.mistake,
        short: p.short,
        loss: p.loss,
      });
      const rate = rates.get(`${r.challan_id}|${p.io_no}`) ?? n(r.dc_rate);
      amount += q * rate; qty += q;
      return { io_no: p.io_no, qty: q, rate };
    });
    // Inwards without per-bundle lines fall back to the DC rate.
    const ourRate = qty > 0 ? Math.round((amount / qty) * 10000) / 10000 : n(r.dc_rate);
    return {
      ...r,
      bill_basis: basis,
      bill_basis_label: BILL_BASIS_LABEL[basis],
      dc_rate: n(r.dc_rate),
      rate: ourRate,
      our_rate: ourRate,
      jobs,
      billed_qty: billed,
      amount: r2(billed * ourRate),
    };
  });
}

processMasterRouter.get('/contractor-bills/unbilled', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  // bill_id: also return the inwards already on that draft (to revise it).
  const qp = z.object({ vendor_id: s.idReq(), from: dateStr.optional(), to: dateStr.optional(), bill_id: s.id(), basis: z.enum(['ISSUED', 'GOOD', 'GOOD_MISTAKE']).nullish() }).parse(req.query);
  res.json({ data: await unbilledReceipts(req.user!.companyId, qp.vendor_id, qp.from, qp.to, qp.bill_id ?? undefined, qp.basis) });
}));

processMasterRouter.get('/contractor-bills', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['b.company_id = ?'];
  const params: unknown[] = [cid];
  if (req.query.vendor_id) { where.push('b.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.status) { where.push('b.status = ?'); params.push(String(req.query.status)); }
  const rows = await query(
    `SELECT b.*, p.party_name AS vendor_name, p.is_contractor,
            (SELECT COUNT(*) FROM trx_contractor_bill_line l WHERE l.bill_id = b.id) AS line_count,
            (SELECT COUNT(*) FROM trx_contractor_bill_line l WHERE l.bill_id = b.id AND l.variance_action = 'REVISE' AND l.bill_rate > l.our_rate) AS to_revise
       FROM trx_contractor_bill b LEFT JOIN mst_party p ON p.id = b.vendor_id
      WHERE ${where.join(' AND ')} ORDER BY b.bill_date DESC, b.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

async function loadBill(cid: number, id: number) {
  const bill = await queryOne<any>(
    `SELECT b.*, p.party_name AS vendor_name, p.party_code AS vendor_code, p.gstin AS vendor_gstin, p.is_contractor,
            u.full_name AS created_by_name, ua.full_name AS approved_by_name
       FROM trx_contractor_bill b LEFT JOIN mst_party p ON p.id = b.vendor_id
       LEFT JOIN mst_user u ON u.id = b.created_by LEFT JOIN mst_user ua ON ua.id = b.approved_by
      WHERE b.id = ? AND b.company_id = ?`, [id, cid]);
  if (!bill) throw NotFound('Contractor bill not found');
  bill.lines = await query<any>(
    `SELECT l.*, r.receipt_no, r.receipt_date, r.party_dc_no, jc.challan_no, ps.stage_name,
            (SELECT GROUP_CONCAT(DISTINCT jl.io_no ORDER BY jl.io_no SEPARATOR ', ')
               FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
              WHERE rl.receipt_id = r.id) AS io_list,
            (SELECT GROUP_CONCAT(o.op_name ORDER BY o.sort_order SEPARATOR ', ')
               FROM trx_jobwork_challan_op co JOIN mst_process_operation o ON o.id = co.operation_id
              WHERE co.challan_id = jc.id) AS operations
       FROM trx_contractor_bill_line l
       JOIN trx_jobwork_receipt r ON r.id = l.receipt_id
       JOIN trx_jobwork_challan jc ON jc.id = l.challan_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE l.bill_id = ? ORDER BY r.receipt_date, r.id`, [id]);
  bill.debit_notes = await query<any>(`SELECT * FROM trx_contractor_debit_note WHERE bill_id = ? AND status <> 'CANCELLED' ORDER BY id`, [id]);
  return bill;
}

processMasterRouter.get('/contractor-bills/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const bill = await loadBill(cid, Number(req.params.id));
  const company = await queryOne(
    `SELECT legal_name, trade_name, address_line1, address_line2, city, state, pincode, gstin, phone FROM mst_company WHERE id = ?`, [cid]);
  res.json({ data: { ...bill, company } });
}));

const VARIANCE = ['NONE', 'ALLOW', 'ADVANCE', 'REVISE'] as const;
const billSchema = z.object({
  bill_no: s.nullableStr(40),
  bill_date: dateStr,
  vendor_id: s.idReq(),
  period_from: s.date(),
  period_to: s.date(),
  bill_basis: z.enum(['ISSUED', 'GOOD', 'GOOD_MISTAKE']).nullish(),
  receipt_ids: z.array(s.idReq()).min(1, 'Pick at least one process inward').max(1000),
  // Contractor's invoice rate per inward and what to do with any excess over our rate.
  lines: z.array(z.object({
    receipt_id: s.idReq(),
    bill_rate: z.coerce.number().min(0).max(100000).nullish(),
    bill_basis: z.enum(['ISSUED', 'GOOD', 'GOOD_MISTAKE']).nullish(),
    variance_action: z.enum(VARIANCE).default('NONE'),
  })).max(1000).default([]),
  tds_pct: z.coerce.number().min(0).max(30).default(0),
  gst_pct: z.coerce.number().min(0).max(28).default(0),      // job work GST (e.g. 5 / 12 / 18) — optional
  is_interstate: z.coerce.boolean().default(false),
  deduction_pct: z.coerce.number().min(0).max(50).default(0),   // e.g. retention / quality %
  deduction_label: s.nullableStr(80),
  other_deduction_label: s.nullableStr(80),
  other_deduction: z.coerce.number().min(0).default(0),
  advance_adjust: z.coerce.number().min(0).default(0),
  debit_note_ids: z.array(s.idReq()).max(200).default([]),
  remarks: s.nullableStr(500),
});
type BillBody = z.infer<typeof billSchema>;

/** Open advance of a contractor: advances given − advances already adjusted on live bills. */
async function advanceBalance(runner: 'q' | any, cid: number, vendorId: number, excludeBillId = 0) {
  const run = (sql: string, p: unknown[]) => (runner === 'q' ? query<any>(sql, p) : txQuery<any>(runner, sql, p));
  const [a] = await run(`SELECT COALESCE(SUM(amount),0) AS amt FROM trx_contractor_advance WHERE company_id = ? AND vendor_id = ? AND status = 'ACTIVE'`, [cid, vendorId]);
  const [u] = await run(`SELECT COALESCE(SUM(advance_adjusted),0) AS amt FROM trx_contractor_bill WHERE company_id = ? AND vendor_id = ? AND status IN ('DRAFT','APPROVED') AND id <> ?`, [cid, vendorId, excludeBillId]);
  return { advanced: r2(n(a?.amt)), adjusted: r2(n(u?.amt)), balance: r2(n(a?.amt) - n(u?.amt)) };
}

/** Validate + price a bill (create or edit). Inwards and debit notes are locked by the caller's transaction. */
async function buildBill(tx: any, cid: number, b: BillBody, billId = 0) {
  const ids = [...new Set(b.receipt_ids)].sort((x, y) => x - y);
  const locked = await txQuery<any>(tx,
    `SELECT id, receipt_no, vendor_id, contractor_bill_id FROM trx_jobwork_receipt WHERE company_id = ? AND id IN (?) FOR UPDATE`, [cid, ids]);
  if (locked.length !== ids.length) throw BadRequest('Some process inwards were not found');
  const wrong = locked.find((r) => Number(r.vendor_id) !== b.vendor_id);
  if (wrong) throw BadRequest(`Inward ${wrong.receipt_no} belongs to another contractor`);
  const billedAlready = locked.find((r) => r.contractor_bill_id && Number(r.contractor_bill_id) !== billId);
  if (billedAlready) throw BadRequest(`Inward ${billedAlready.receipt_no} is already on a contractor bill`);

  const input = new Map(b.lines.map((l) => [l.receipt_id, l]));
  const priced = (await unbilledReceipts(cid, b.vendor_id, undefined, undefined, billId || undefined, b.bill_basis)).filter((r) => ids.includes(Number(r.receipt_id)));
  const lines = priced.map((r) => {
    const inp = input.get(Number(r.receipt_id));
    const basis = (inp?.bill_basis || b.bill_basis || r.bill_basis) as BillBasis;
    const billed = basis !== r.bill_basis ? billedQty(basis, { good: r.received_qty, mistake: r.rejected_qty, short: r.shortage_qty, loss: r.loss_qty }) : r.billed_qty;
    const billRate = inp?.bill_rate != null ? n(inp.bill_rate) : r.our_rate;
    const over = billRate > r.our_rate + 0.00005;
    const action = over ? (inp?.variance_action ?? 'NONE') : 'NONE';
    // Pay the lower of the two unless the excess is allowed / kept as advance.
    const payRate = over && (action === 'ALLOW' || action === 'ADVANCE') ? billRate : Math.min(billRate, r.our_rate);
    const excess = over ? r2((billRate - r.our_rate) * billed) : 0;
    return { ...r, bill_basis: basis, billed_qty: billed, bill_rate: billRate, variance_action: action, pay_rate: payRate, excess, amount: r2(billed * payRate) };
  });
  const qty = lines.reduce((a, l) => a + l.billed_qty, 0);
  const gross = r2(lines.reduce((a, l) => a + l.amount, 0));
  const excessTotal = r2(lines.reduce((a, l) => a + l.excess, 0));
  const excessAsAdvance = r2(lines.filter((l) => l.variance_action === 'ADVANCE').reduce((a, l) => a + l.excess, 0));

  // Debit notes of this contractor, open (or already on this bill).
  const dnIds = [...new Set(b.debit_note_ids)];
  const dns = dnIds.length
    ? await txQuery<any>(tx, `SELECT * FROM trx_contractor_debit_note WHERE company_id = ? AND id IN (?) FOR UPDATE`, [cid, dnIds])
    : [];
  for (const d of dns) {
    if (Number(d.vendor_id) !== b.vendor_id) throw BadRequest(`Debit note ${d.dn_no} belongs to another contractor`);
    if (d.status === 'CANCELLED') throw BadRequest(`Debit note ${d.dn_no} is cancelled`);
    if (d.status === 'ADJUSTED' && Number(d.bill_id) !== billId) throw BadRequest(`Debit note ${d.dn_no} is already deducted on another bill`);
  }
  if (dns.length !== dnIds.length) throw BadRequest('Debit note not found');
  const dnAmount = r2(dns.reduce((a, d) => a + n(d.amount), 0));

  const adv = await advanceBalance(tx, cid, b.vendor_id, billId);
  if (b.advance_adjust > adv.balance + 0.005) throw BadRequest(`Only ₹${adv.balance} advance is open for this contractor — ₹${b.advance_adjust} cannot be adjusted`);

  // GST on the job-work value; TDS (194C) and the % deduction on the value before GST.
  const gst = r2(gross * b.gst_pct / 100);
  const tds = r2(gross * b.tds_pct / 100);
  const pctDed = r2(gross * b.deduction_pct / 100);
  const beforeRound = gross + gst - tds - pctDed - b.other_deduction - b.advance_adjust - dnAmount;
  if (beforeRound < 0) throw BadRequest('Deductions exceed the bill amount');
  const net = Math.round(beforeRound);
  return { ids, lines, qty, gross, gst, tds, pctDed, dnAmount, dns, excessTotal, excessAsAdvance, beforeRound, net };
}

async function writeBillLines(tx: any, billId: number, lines: any[]) {
  for (const l of lines) {
    await txExecute(tx,
      `INSERT INTO trx_contractor_bill_line
         (bill_id, receipt_id, challan_id, good_qty, mistake_qty, short_loss_qty, billed_qty, bill_basis, rate, our_rate, bill_rate, variance_action, excess_amount, amount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [billId, l.receipt_id, l.challan_id, n(l.received_qty), n(l.rejected_qty), n(l.shortage_qty) + n(l.loss_qty), l.billed_qty,
       l.bill_basis ?? null, l.pay_rate, l.our_rate, l.bill_rate, l.variance_action, l.excess, l.amount]);
  }
}

processMasterRouter.post('/contractor-bills', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = billSchema.parse(req.body);
  const id = await transaction(async (tx) => {
    const x = await buildBill(tx, cid, b);
    const billNo = b.bill_no || await nextDocNumber(tx, cid, 'CONTRACTOR_BILL');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_contractor_bill WHERE company_id = ? AND bill_no = ?`, [cid, billNo]);
    if (dup) throw BadRequest(`Bill no ${billNo} already exists`);
    const r = await txExecute(tx,
      `INSERT INTO trx_contractor_bill
         (company_id, bill_no, bill_date, vendor_id, period_from, period_to, billed_qty, gross_amount, gst_pct, gst_amount,
          is_interstate, tds_pct, tds_amount, other_deduction_label, other_deduction, deduction_pct, deduction_label, deduction_amount,
          advance_adjusted, debit_note_amount, excess_amount, excess_as_advance, round_off, net_amount, status, remarks, bill_basis, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?)`,
      [cid, billNo, b.bill_date, b.vendor_id, b.period_from ?? null, b.period_to ?? null, x.qty, x.gross, b.gst_pct, x.gst,
       b.is_interstate ? 1 : 0, b.tds_pct, x.tds, b.other_deduction_label ?? null, b.other_deduction,
       b.deduction_pct, b.deduction_label ?? null, x.pctDed, b.advance_adjust, x.dnAmount, x.excessTotal, x.excessAsAdvance,
       r2(x.net - x.beforeRound), x.net, b.remarks ?? null, b.bill_basis ?? null, req.user!.id]);
    await writeBillLines(tx, r.insertId, x.lines);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = ? WHERE id IN (${x.ids.map(() => '?').join(',')})`, [r.insertId, ...x.ids]);
    if (x.dns.length) {
      await txExecute(tx, `UPDATE trx_contractor_debit_note SET status = 'ADJUSTED', bill_id = ? WHERE id IN (${x.dns.map(() => '?').join(',')})`,
        [r.insertId, ...x.dns.map((d: any) => Number(d.id))]);
    }
    await audit(req, 'trx_contractor_bill', r.insertId, 'INSERT', undefined,
      { bill_no: billNo, inwards: x.ids.length, gross: x.gross, gst: x.gst, tds: x.tds, deduction: x.pctDed, advance: b.advance_adjust, debit_notes: x.dnAmount, net: x.net }, tx);
    return r.insertId;
  });
  res.status(201).json({ data: await loadBill(cid, id) });
}));

/** PUT /contractor-bills/:id — revise a draft (contractor's rates, variance actions, deductions). */
processMasterRouter.put('/contractor-bills/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = billSchema.parse(req.body);
  await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, `SELECT * FROM trx_contractor_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Contractor bill not found');
    if (bill.status !== 'DRAFT') throw BadRequest(`Bill ${bill.bill_no} is ${bill.status} — only a draft can be revised`);
    if (Number(bill.vendor_id) !== b.vendor_id) throw BadRequest('The contractor of a bill cannot be changed');
    const x = await buildBill(tx, cid, b, id);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = NULL WHERE contractor_bill_id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_contractor_debit_note SET status = 'OPEN', bill_id = NULL WHERE bill_id = ? AND status = 'ADJUSTED'`, [id]);
    await txExecute(tx, `DELETE FROM trx_contractor_bill_line WHERE bill_id = ?`, [id]);
    await txExecute(tx,
      `UPDATE trx_contractor_bill SET bill_date = ?, period_from = ?, period_to = ?, billed_qty = ?, gross_amount = ?, gst_pct = ?, gst_amount = ?,
              is_interstate = ?, tds_pct = ?, tds_amount = ?, other_deduction_label = ?, other_deduction = ?, deduction_pct = ?, deduction_label = ?,
              deduction_amount = ?, advance_adjusted = ?, debit_note_amount = ?, excess_amount = ?, excess_as_advance = ?, round_off = ?,
              net_amount = ?, remarks = ?, bill_basis = ?
        WHERE id = ?`,
      [b.bill_date, b.period_from ?? null, b.period_to ?? null, x.qty, x.gross, b.gst_pct, x.gst, b.is_interstate ? 1 : 0, b.tds_pct, x.tds,
       b.other_deduction_label ?? null, b.other_deduction, b.deduction_pct, b.deduction_label ?? null, x.pctDed, b.advance_adjust, x.dnAmount,
       x.excessTotal, x.excessAsAdvance, r2(x.net - x.beforeRound), x.net, b.remarks ?? null, b.bill_basis ?? null, id]);
    await writeBillLines(tx, id, x.lines);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = ? WHERE id IN (${x.ids.map(() => '?').join(',')})`, [id, ...x.ids]);
    if (x.dns.length) {
      await txExecute(tx, `UPDATE trx_contractor_debit_note SET status = 'ADJUSTED', bill_id = ? WHERE id IN (${x.dns.map(() => '?').join(',')})`,
        [id, ...x.dns.map((d: any) => Number(d.id))]);
    }
    await audit(req, 'trx_contractor_bill', id, 'UPDATE', { net: bill.net_amount }, { net: x.net, gross: x.gross }, tx);
  });
  res.json({ data: await loadBill(cid, id) });
}));

processMasterRouter.post('/contractor-bills/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, `SELECT * FROM trx_contractor_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Contractor bill not found');
    if (bill.status !== 'DRAFT') throw BadRequest(`Bill ${bill.bill_no} is ${bill.status}`);
    // The contractor's rate may not exceed ours unless the excess was allowed or kept as advance.
    const open = await txQuery<any>(tx,
      `SELECT l.*, r.receipt_no FROM trx_contractor_bill_line l JOIN trx_jobwork_receipt r ON r.id = l.receipt_id
        WHERE l.bill_id = ? AND l.bill_rate > l.our_rate + 0.00005 AND l.variance_action NOT IN ('ALLOW','ADVANCE')`, [id]);
    if (open.length) {
      throw BadRequest(`Revise the bill first — ${open.map((l) => `${l.receipt_no}: billed ₹${n(l.bill_rate)} vs our ₹${n(l.our_rate)} (${l.variance_action === 'REVISE' ? 'to revise' : 'no decision'})`).join('; ')}`);
    }
    if (n(bill.advance_adjusted) > 0) {
      const adv = await advanceBalance(tx, cid, Number(bill.vendor_id), id);
      if (n(bill.advance_adjusted) > adv.balance + 0.005) throw BadRequest(`Only ₹${adv.balance} advance is open — revise the advance adjusted on this bill`);
    }
    // Excess paid but kept as advance becomes a recoverable advance to the contractor.
    if (n(bill.excess_as_advance) > 0) {
      const no = await nextDocNumber(tx, cid, 'CONTRACTOR_ADVANCE');
      await txExecute(tx,
        `INSERT INTO trx_contractor_advance (company_id, advance_no, advance_date, vendor_id, amount, source, bill_id, remarks, created_by)
         VALUES (?,?,?,?,?,'BILL_EXCESS',?,?,?)`,
        [cid, no, String(bill.bill_date).slice(0, 10), bill.vendor_id, n(bill.excess_as_advance), id,
         `Excess rate on bill ${bill.bill_no} kept as advance`, req.user!.id]);
    }
    await txExecute(tx, `UPDATE trx_contractor_bill SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [req.user!.id, id]);
    await audit(req, 'trx_contractor_bill', id, 'UPDATE', { status: 'DRAFT' }, { status: 'APPROVED', excess_as_advance: n(bill.excess_as_advance) }, tx);
  });
  res.json({ data: await loadBill(cid, id) });
}));

/** Cancel a bill: its inwards become billable again, debit notes reopen, excess advance is cancelled. */
processMasterRouter.post('/contractor-bills/:id/cancel', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, `SELECT status, bill_no FROM trx_contractor_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Contractor bill not found');
    if (bill.status === 'CANCELLED') throw BadRequest(`Bill ${bill.bill_no} is already cancelled`);
    await txExecute(tx, `UPDATE trx_jobwork_receipt SET contractor_bill_id = NULL WHERE contractor_bill_id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_contractor_debit_note SET status = 'OPEN', bill_id = NULL WHERE bill_id = ? AND status = 'ADJUSTED'`, [id]);
    await txExecute(tx, `UPDATE trx_contractor_advance SET status = 'CANCELLED', cancel_reason = ? WHERE bill_id = ? AND source = 'BILL_EXCESS' AND status = 'ACTIVE'`,
      [`Bill ${bill.bill_no} cancelled`, id]);
    await txExecute(tx, `UPDATE trx_contractor_bill SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
    await audit(req, 'trx_contractor_bill', id, 'UPDATE', { status: bill.status }, { status: 'CANCELLED', reason }, tx);
  });
  res.json({ data: await loadBill(cid, id) });
}));

// ============================================================
// Contractor advances (recovered on bills)
// ============================================================
processMasterRouter.get('/contractor-advances/balance', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const qp = z.object({ vendor_id: s.idReq(), bill_id: s.id() }).parse(req.query);
  res.json({ data: await advanceBalance('q', req.user!.companyId, qp.vendor_id, qp.bill_id ?? 0) });
}));

processMasterRouter.get('/contractor-advances', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['a.company_id = ?']; const params: unknown[] = [cid];
  if (req.query.vendor_id) { where.push('a.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  const rows = await query(
    `SELECT a.*, p.party_name AS vendor_name, b.bill_no FROM trx_contractor_advance a
       LEFT JOIN mst_party p ON p.id = a.vendor_id LEFT JOIN trx_contractor_bill b ON b.id = a.bill_id
      WHERE ${where.join(' AND ')} ORDER BY a.advance_date DESC, a.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

processMasterRouter.post('/contractor-advances', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    advance_date: dateStr, vendor_id: s.idReq(), amount: z.coerce.number().positive().max(10000000),
    pay_mode: s.nullableStr(30), ref_no: s.nullableStr(60), remarks: s.nullableStr(255),
  }).parse(req.body);
  const v = await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.vendor_id, cid]);
  if (!v) throw BadRequest('Contractor not found');
  const row = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'CONTRACTOR_ADVANCE');
    const r = await txExecute(tx,
      `INSERT INTO trx_contractor_advance (company_id, advance_no, advance_date, vendor_id, amount, source, pay_mode, ref_no, remarks, created_by)
       VALUES (?,?,?,?,?,'PAYMENT',?,?,?,?)`,
      [cid, no, b.advance_date, b.vendor_id, b.amount, b.pay_mode ?? null, b.ref_no ?? null, b.remarks ?? null, req.user!.id]);
    await audit(req, 'trx_contractor_advance', r.insertId, 'INSERT', undefined, { advance_no: no, ...b }, tx);
    return { id: r.insertId, advance_no: no };
  });
  res.status(201).json({ data: { ...row, balance: await advanceBalance('q', cid, b.vendor_id) } });
}));

processMasterRouter.post('/contractor-advances/:id/cancel', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  await transaction(async (tx) => {
    const a = await txQueryOne<any>(tx, `SELECT * FROM trx_contractor_advance WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!a) throw NotFound('Advance not found');
    if (a.status !== 'ACTIVE') throw BadRequest(`Advance ${a.advance_no} is already ${a.status}`);
    if (a.source === 'BILL_EXCESS') throw BadRequest('This advance comes from a bill — cancel the bill instead');
    const bal = await advanceBalance(tx, cid, Number(a.vendor_id));
    if (bal.balance - n(a.amount) < -0.005) throw BadRequest(`₹${r2(n(a.amount) - bal.balance)} of this advance is already adjusted on bills — it cannot be cancelled`);
    await txExecute(tx, `UPDATE trx_contractor_advance SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
    await audit(req, 'trx_contractor_advance', id, 'UPDATE', { status: 'ACTIVE' }, { status: 'CANCELLED', reason }, tx);
  });
  res.json({ data: { id, status: 'CANCELLED' } });
}));

// ============================================================
// Contractor debit notes (defective work), deducted on a bill
// ============================================================
processMasterRouter.get('/contractor-debit-notes', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['d.company_id = ?']; const params: unknown[] = [cid];
  if (req.query.vendor_id) { where.push('d.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.status) { where.push('d.status = ?'); params.push(String(req.query.status)); }
  const rows = await query(
    `SELECT d.*, p.party_name AS vendor_name, b.bill_no, r.receipt_no FROM trx_contractor_debit_note d
       LEFT JOIN mst_party p ON p.id = d.vendor_id LEFT JOIN trx_contractor_bill b ON b.id = d.bill_id
       LEFT JOIN trx_jobwork_receipt r ON r.id = d.receipt_id
      WHERE ${where.join(' AND ')} ORDER BY d.dn_date DESC, d.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

processMasterRouter.post('/contractor-debit-notes', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    dn_date: dateStr, vendor_id: s.idReq(), receipt_id: s.id(), io_no: s.nullableStr(40),
    reason: z.string().trim().min(3, 'Give the reason (e.g. wrong stitching)').max(255),
    qty: z.coerce.number().int().min(0).default(0), rate: z.coerce.number().min(0).default(0),
    amount: z.coerce.number().min(0).optional(),
  }).parse(req.body);
  const amount = r2(b.amount ?? b.qty * b.rate);
  if (!(amount > 0)) throw BadRequest('Enter the amount, or qty × rate');
  if (b.receipt_id) {
    const r = await queryOne<any>(`SELECT vendor_id FROM trx_jobwork_receipt WHERE id = ? AND company_id = ?`, [b.receipt_id, cid]);
    if (!r) throw BadRequest('Process inward not found');
    if (Number(r.vendor_id) !== b.vendor_id) throw BadRequest('That process inward belongs to another contractor');
  }
  const row = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'CONTRACTOR_DN');
    const r = await txExecute(tx,
      `INSERT INTO trx_contractor_debit_note (company_id, dn_no, dn_date, vendor_id, receipt_id, io_no, reason, qty, rate, amount, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.dn_date, b.vendor_id, b.receipt_id ?? null, b.io_no ?? null, b.reason, b.qty, b.rate, amount, req.user!.id]);
    await audit(req, 'trx_contractor_debit_note', r.insertId, 'INSERT', undefined, { dn_no: no, ...b, amount }, tx);
    return { id: r.insertId, dn_no: no, amount };
  });
  res.status(201).json({ data: row });
}));

processMasterRouter.post('/contractor-debit-notes/:id/cancel', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  const d = await queryOne<any>(`SELECT * FROM trx_contractor_debit_note WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!d) throw NotFound('Debit note not found');
  if (d.status !== 'OPEN') throw BadRequest(`Debit note ${d.dn_no} is ${d.status}${d.status === 'ADJUSTED' ? ' on a bill — remove it from the bill first' : ''}`);
  await execute(`UPDATE trx_contractor_debit_note SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
  await audit(req, 'trx_contractor_debit_note', id, 'UPDATE', { status: 'OPEN' }, { status: 'CANCELLED', reason });
  res.json({ data: { id, status: 'CANCELLED' } });
}));
