import type { Request } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, execute, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { computeResult, overallResult, splitList, FORMULA_VERSION, type Criteria, type ParamDef, type Reading, type EvalStatus } from './labCalc.js';

/** Lab module shared helpers: permissions, numbering, audit timeline, notifications, files, sample ledger,
 *  trial evaluation and request status. */

export const P = {
  VIEW: 'LAB.VIEW', CREATE: 'LAB.CREATE', UPDATE: 'LAB.UPDATE', APPROVE: 'LAB.APPROVE', QA: 'LAB.QA_APPROVE',
  OVERRIDE: 'LAB.OVERRIDE', ADMIN: 'LAB.ADMIN',
} as const;

export const TEST_SCOPES = ['WASHING', 'GARMENT', 'TEXTILE_PHYSICAL', 'TEXTILE_CHEMICAL', 'BUYER_SPECIFIC', 'COMBINED'] as const;
export const SOURCES = ['MERCHANDISING', 'PRODUCTION', 'QA', 'BUYER', 'OTHER'] as const;
export const SAMPLE_TYPES = ['FABRIC_SWATCH', 'CUT_PANEL', 'GARMENT', 'TRIM', 'WASHED_GARMENT', 'CONTROL'] as const;
export const SAMPLE_UOMS = ['PCS', 'KG', 'MTR', 'SWATCH'] as const;
export const TRIAL_TYPES = ['INITIAL', 'RECIPE_REVISION', 'RETEST', 'CONFIRMATION', 'BUYER_REPEAT'] as const;
export const DOSAGE_UOMS = ['G_L', 'ML_L', 'PCT_OWG', 'G', 'ML', 'KG', 'L'] as const;
export const DRYING = ['TUMBLE', 'LINE', 'FLAT', 'DRIP', 'NONE'] as const;
export const ATTACHMENT_TYPES = ['BUYER_PROTOCOL', 'SAMPLE_PHOTO', 'BEFORE_PHOTO', 'AFTER_PHOTO', 'EVIDENCE', 'CERTIFICATE', 'OTHER'] as const;

/** Trial states in which data may still change (before submission). */
export const TRIAL_EDITABLE = ['DRAFT', 'PLANNED', 'IN_PROGRESS', 'COMPLETED'];
export const TRIAL_RECIPE_TARGET_EDITABLE = ['DRAFT', 'PLANNED'];
export const TRIAL_RESULT_EDITABLE = ['IN_PROGRESS', 'COMPLETED'];
export const REQUEST_OPEN_FOR_SAMPLES = ['SUBMITTED', 'SAMPLE_RECEIVED', 'IN_TESTING', 'PENDING_LAB_REVIEW', 'PENDING_QA_APPROVAL', 'RETEST_REQUIRED', 'REJECTED', 'APPROVED'];

export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const reasonReq = z.string().trim().min(3, 'Give a reason (3+ characters)').max(255);
export const idemKey = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_.:-]+$/, 'Invalid idempotency key').nullish();

export const cidOf = (req: Request) => req.user!.companyId;
export const uidOf = (req: Request) => req.user!.id;
export const idParam = (req: Request, k = 'id') => {
  const v = Number(req.params[k]);
  if (!Number.isInteger(v) || v <= 0) throw NotFound();
  return v;
};
export const hasPerm = (req: Request, code: string) => !!req.user && (req.user.isSuperAdmin || req.user.permissions.has(code));
export function needPerm(req: Request, code: string, what = '') {
  if (!hasPerm(req, code)) throw Forbidden(`Missing required permission: ${code}${what ? ` (${what})` : ''}`);
}
export const n = (v: unknown) => (v == null || v === '' ? 0 : Number(v));
export const nn = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
export const idemFrom = (req: Request, body: { idempotency_key?: string | null }) =>
  (body.idempotency_key ?? (typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null)) || null;

/** LBR-2026-000001 style numbers: one series per document and year, created on demand, locked FOR UPDATE. */
export async function labNumber(tx: Tx, cid: number, kind: 'LAB_REQUEST' | 'LAB_SAMPLE' | 'LAB_REPORT', year = new Date().getFullYear()) {
  const docType = `${kind}_${year}`;
  const prefix = { LAB_REQUEST: 'LBR', LAB_SAMPLE: 'LBS', LAB_REPORT: 'LRP' }[kind];
  await txExecute(tx,
    `INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, suffix, next_number, padding)
     SELECT ?, NULL, ?, NULL, ?, '', 1, 6 FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series WHERE company_id = ? AND branch_id IS NULL AND doc_type = ? AND fy_id IS NULL)`,
    [cid, docType, `${prefix}-${year}-`, cid, docType]);
  return nextDocNumber(tx, cid, docType);
}

/** Timeline / audit row (lab table) + the universal audit trail. */
export async function labAudit(req: Request, tx: Tx | null, e: {
  request_id?: number | null; entity_type: string; entity_id: number; action: string; before?: unknown; after?: unknown; remarks?: string | null;
}) {
  const sql = `INSERT INTO trx_lab_audit (company_id, request_id, entity_type, entity_id, action, before_json, after_json, remarks, actor_user_id, ip_address)
               VALUES (?,?,?,?,?,?,?,?,?,?)`;
  const params = [cidOf(req), e.request_id ?? null, e.entity_type, e.entity_id, e.action,
    e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after),
    e.remarks ?? null, uidOf(req), req.ip ?? null];
  if (tx) await txExecute(tx, sql, params); else await execute(sql, params);
  const table = ({ REQUEST: 'trx_lab_request', SAMPLE: 'trx_lab_sample', TRIAL: 'trx_lab_trial', RESULT: 'trx_lab_trial_result',
    REPORT: 'trx_lab_report', PLAN: 'mst_lab_test_plan', MASTER: 'mst_lab', PRODUCTION_REF: 'trx_lab_production_ref' } as Record<string, string>)[e.entity_type] ?? 'trx_lab';
  await audit(req, table, e.entity_id, e.action === 'CREATE' ? 'INSERT' : 'UPDATE', e.before, { action: e.action, ...(e.after && typeof e.after === 'object' ? e.after : { value: e.after }), remarks: e.remarks ?? undefined }, tx ?? undefined);
}

/** In-app notification to the users holding `perm` in the company (and extra users), never to the actor. Same title
 *  + reference to the same user within 2 minutes is skipped (dedupe). Failures never break the business action. */
export async function notify(req: Request, opts: { perms?: string[]; userIds?: (number | null | undefined)[]; title: string; body: string; ref_type: string; ref_id: number }) {
  try {
    const cid = cidOf(req);
    const ids = new Set<number>((opts.userIds ?? []).filter((x): x is number => !!x).map(Number));
    if (opts.perms?.length) {
      const rows = await query<{ user_id: number }>(
        `SELECT DISTINCT ur.user_id FROM map_user_role ur
           JOIN mst_role r ON r.id = ur.role_id AND r.company_id = ? AND r.is_active = 1
           JOIN map_role_permission rp ON rp.role_id = r.id
           JOIN mst_permission p ON p.id = rp.permission_id AND p.permission_code IN (?)
           JOIN mst_user u ON u.id = ur.user_id AND u.is_active = 1 AND u.is_deleted = 0`, [cid, opts.perms]);
      for (const r of rows) ids.add(Number(r.user_id));
    }
    ids.delete(uidOf(req));
    for (const uid of ids) {
      const dup = await queryOne(`SELECT id FROM trx_notification WHERE user_id = ? AND company_id = ? AND title = ? AND ref_type = ? AND ref_id = ? AND created_at > NOW() - INTERVAL 2 MINUTE`,
        [uid, cid, opts.title.slice(0, 200), opts.ref_type, opts.ref_id]);
      if (dup) continue;
      await execute(`INSERT INTO trx_notification (company_id, user_id, title, body, ref_type, ref_id, channel) VALUES (?,?,?,?,?,?,'INAPP')`,
        [cid, uid, opts.title.slice(0, 200), opts.body, opts.ref_type, opts.ref_id]);
    }
  } catch (err) {
    console.error('[lab] notification failed:', (err as Error).message);
  }
}

/* ================================================================ private files */
const ALLOWED: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv', '.txt': 'text/plain',
};
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  '.pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8, '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.xlsx': (b) => b[0] === 0x50 && b[1] === 0x4b, '.docx': (b) => b[0] === 0x50 && b[1] === 0x4b,
};
export const MAX_FILE = 10 * 1024 * 1024;
/** Lab files live under uploads/lab-files (blocked from the static route) and are served only by the API. */
export const labFilesRoot = () => path.resolve(process.cwd(), 'uploads', 'lab-files');

export function storeFile(cid: number, filename: string, data: string) {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED[ext]) throw BadRequest(`File type ${ext || '(none)'} is not allowed. Allowed: PDF, JPG, PNG, WEBP, XLSX, DOCX, CSV, TXT`);
  const m = data.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
  const buf = Buffer.from(m ? m[2] : data, 'base64');
  if (!buf.length) throw BadRequest('The file is empty');
  if (buf.length > MAX_FILE) throw BadRequest('File is larger than 10 MB');
  if (MAGIC[ext] && !MAGIC[ext](buf)) throw BadRequest(`The file content is not a real ${ext.slice(1).toUpperCase()} file`);
  return writeFile(cid, buf, ext, ALLOWED[ext]);
}
export function writeFile(cid: number, buf: Buffer, ext: string, mime: string) {
  const key = `${cid}/${crypto.randomBytes(16).toString('hex')}${ext}`;
  fs.mkdirSync(path.join(labFilesRoot(), String(cid)), { recursive: true });
  fs.writeFileSync(path.join(labFilesRoot(), key), buf, { mode: 0o640 });
  return { key, mime, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
export function filePath(key: string) {
  const p = path.resolve(labFilesRoot(), key);
  if (!p.startsWith(labFilesRoot() + path.sep)) throw NotFound('File not found');
  return p;
}

/* ================================================================ sample ledger */
export interface SampleBalance {
  inward: number; issued: number; returned: number; consumed: number; retained: number; disposed: number;
  available: number; retained_balance: number; outstanding: number;
  by_trial: { trial_id: number; issued: number; returned: number; consumed: number; outstanding: number }[];
}
const M = (x: number) => Math.round(x * 1e6);
const U = (x: number) => x / 1e6;

export async function sampleBalance(db: Tx | null, sampleId: number): Promise<SampleBalance> {
  const sql = `SELECT txn_type, trial_id, from_bucket, SUM(quantity) q FROM trx_lab_sample_txn WHERE sample_id = ? GROUP BY txn_type, trial_id, from_bucket`;
  const rows = db ? await txQuery<any>(db, sql, [sampleId]) : await query<any>(sql, [sampleId]);
  const t = { INWARD: 0, ISSUE: 0, RETURN: 0, CONSUME: 0, RETAIN: 0, DISP_A: 0, DISP_R: 0 } as Record<string, number>;
  const per = new Map<number, { issued: number; returned: number; consumed: number }>();
  for (const r of rows) {
    const q = M(Number(r.q));
    if (r.txn_type === 'DISPOSE') t[r.from_bucket === 'RETAINED' ? 'DISP_R' : 'DISP_A'] += q; else t[r.txn_type] += q;
    if (r.trial_id && ['ISSUE', 'RETURN', 'CONSUME'].includes(r.txn_type)) {
      const x = per.get(Number(r.trial_id)) ?? { issued: 0, returned: 0, consumed: 0 };
      if (r.txn_type === 'ISSUE') x.issued += q; else if (r.txn_type === 'RETURN') x.returned += q; else x.consumed += q;
      per.set(Number(r.trial_id), x);
    }
  }
  const available = t.INWARD - t.ISSUE + t.RETURN - t.RETAIN - t.DISP_A;
  const outstanding = t.ISSUE - t.RETURN - t.CONSUME;
  return {
    inward: U(t.INWARD), issued: U(t.ISSUE), returned: U(t.RETURN), consumed: U(t.CONSUME), retained: U(t.RETAIN), disposed: U(t.DISP_A + t.DISP_R),
    available: U(available), retained_balance: U(t.RETAIN - t.DISP_R), outstanding: U(outstanding),
    by_trial: [...per.entries()].map(([trial_id, x]) => ({ trial_id, issued: U(x.issued), returned: U(x.returned), consumed: U(x.consumed), outstanding: U(x.issued - x.returned - x.consumed) })),
  };
}

export function sampleStatusOf(b: SampleBalance) {
  const av = M(b.available); const out = M(b.outstanding);
  if (av <= 0 && out <= 0) return M(b.retained_balance) > 0 ? 'RETAINED' : M(b.consumed) > 0 ? 'CONSUMED' : 'DISPOSED';
  if (out > 0) return M(b.consumed) > 0 ? 'PARTIALLY_CONSUMED' : 'ISSUED';
  return M(b.consumed) > 0 ? 'PARTIALLY_CONSUMED' : 'RECEIVED';
}

/**
 * One ledger movement, inside the caller's transaction, with the sample row locked FOR UPDATE so two movements can
 * never both pass the balance check. An idempotency key already used returns the earlier movement unchanged.
 */
export async function sampleMove(req: Request, tx: Tx, sampleId: number, m: {
  type: 'INWARD' | 'ISSUE' | 'CONSUME' | 'RETURN' | 'RETAIN' | 'DISPOSE'; quantity: number; trial_id?: number | null;
  from_bucket?: 'AVAILABLE' | 'RETAINED' | null; received_by?: string | null; reason?: string | null; idempotency_key?: string | null;
}) {
  const cid = cidOf(req);
  if (m.idempotency_key) {
    const prior = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_sample_txn WHERE company_id = ? AND idempotency_key = ?`, [cid, m.idempotency_key]);
    if (prior) {
      if (Number(prior.sample_id) !== sampleId || prior.txn_type !== m.type) throw Conflict('This idempotency key was already used for another movement');
      return { id: Number(prior.id), replayed: true };
    }
  }
  const s = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_sample WHERE id = ? AND company_id = ? FOR UPDATE`, [sampleId, cid]);
  if (!s) throw NotFound('Sample not found');
  if (!(m.quantity > 0)) throw BadRequest('Quantity must be greater than zero');
  const b = await sampleBalance(tx, sampleId);
  const q = M(m.quantity);
  if (m.type !== 'INWARD' && s.status === 'DISPOSED') throw Conflict('The sample is disposed');
  if (['ISSUE', 'CONSUME', 'RETURN'].includes(m.type)) {
    if (!m.trial_id) throw BadRequest('Choose the trial');
    const t = await txQueryOne<any>(tx, `SELECT id, request_id, status, sample_id FROM trx_lab_trial WHERE id = ? AND company_id = ?`, [m.trial_id, cid]);
    if (!t) throw NotFound('Trial not found');
    if (Number(t.request_id) !== Number(s.request_id)) throw BadRequest('The trial belongs to another lab request');
    if (m.type === 'ISSUE' && ['APPROVED', 'REJECTED', 'CANCELLED', 'RETEST_REQUIRED'].includes(t.status)) throw Conflict(`Cannot issue sample to a ${t.status.toLowerCase().replace(/_/g, ' ')} trial`);
  }
  const trialOut = (b.by_trial.find((x) => x.trial_id === Number(m.trial_id))?.outstanding) ?? 0;
  switch (m.type) {
    case 'ISSUE':
      if (q > M(b.available)) throw Conflict(`Only ${b.available} ${s.uom} available — cannot issue ${m.quantity}`, { available: b.available });
      if (!Number(s.reuse_allowed)) {
        const other = b.by_trial.find((x) => x.trial_id !== Number(m.trial_id) && M(x.issued) > 0);
        if (other) throw Conflict('This sample is marked single-use and was already issued to another trial');
      }
      break;
    case 'CONSUME':
    case 'RETURN':
      if (q > M(trialOut)) throw Conflict(`Only ${trialOut} ${s.uom} is out with this trial`, { outstanding: trialOut });
      break;
    case 'RETAIN':
      if (q > M(b.available)) throw Conflict(`Only ${b.available} ${s.uom} available to retain`, { available: b.available });
      break;
    case 'DISPOSE': {
      const src = m.from_bucket === 'RETAINED' ? b.retained_balance : b.available;
      if (q > M(src)) throw Conflict(`Only ${src} ${s.uom} ${m.from_bucket === 'RETAINED' ? 'retained' : 'available'} to dispose`);
      break;
    }
    default: break;
  }
  const r = await txExecute(tx,
    `INSERT INTO trx_lab_sample_txn (company_id, sample_id, trial_id, txn_type, quantity, uom, from_bucket, issued_by, received_by, reason, idempotency_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, sampleId, m.trial_id ?? null, m.type, m.quantity, s.uom, m.type === 'DISPOSE' ? (m.from_bucket ?? 'AVAILABLE') : null,
      uidOf(req), m.received_by ?? null, m.reason ?? null, m.idempotency_key ?? null]);
  const after = await sampleBalance(tx, sampleId);
  const status = sampleStatusOf(after);
  await txExecute(tx, `UPDATE trx_lab_sample SET status = ?, row_version = row_version + 1 WHERE id = ?`, [status, sampleId]);
  if (m.type === 'ISSUE' && m.trial_id) await txExecute(tx, `UPDATE trx_lab_trial SET sample_id = COALESCE(sample_id, ?) WHERE id = ?`, [sampleId, m.trial_id]);
  if (m.type !== 'INWARD') await labAudit(req, tx, { request_id: Number(s.request_id), entity_type: 'SAMPLE', entity_id: sampleId, action: `SAMPLE_${m.type}`,
    after: { quantity: m.quantity, trial_id: m.trial_id ?? null, balance: after.available, status }, remarks: m.reason ?? null });
  return { id: Number(r.insertId), replayed: false, balance: after, status };
}

/* ================================================================ request status (derived from the latest trial) */
const FIXED_REQUEST = ['DRAFT', 'CLARIFICATION_REQUIRED', 'CANCELLED', 'CLOSED'];
export async function refreshRequestStatus(tx: Tx, requestId: number) {
  const r = await txQueryOne<any>(tx, `SELECT id, status FROM trx_lab_request WHERE id = ? FOR UPDATE`, [requestId]);
  if (!r || FIXED_REQUEST.includes(r.status)) return r?.status;
  const t = await txQueryOne<any>(tx, `SELECT status FROM trx_lab_trial WHERE request_id = ? AND status <> 'CANCELLED' ORDER BY trial_seq DESC LIMIT 1`, [requestId]);
  const anySample = await txQueryOne<any>(tx, `SELECT id FROM trx_lab_sample WHERE request_id = ? LIMIT 1`, [requestId]);
  const map: Record<string, string> = {
    DRAFT: 'SAMPLE_RECEIVED', PLANNED: 'SAMPLE_RECEIVED', IN_PROGRESS: 'IN_TESTING', COMPLETED: 'IN_TESTING', SUBMITTED: 'PENDING_LAB_REVIEW',
    LAB_REVIEWED: 'PENDING_QA_APPROVAL', APPROVED: 'APPROVED', REJECTED: 'REJECTED', RETEST_REQUIRED: 'RETEST_REQUIRED',
  };
  const status = t ? map[t.status] ?? 'IN_TESTING' : anySample ? 'SAMPLE_RECEIVED' : 'SUBMITTED';
  if (status !== r.status) await txExecute(tx, `UPDATE trx_lab_request SET status = ?, row_version = row_version + 1 WHERE id = ?`, [status, requestId]);
  return status;
}

/* ================================================================ plan snapshot */
export interface SnapParam extends Criteria {
  parameter_id: number; code: string; name: string; category: string | null; input_type: ParamDef['input_type']; formula_code: ParamDef['formula_code'];
  formula_version: number; precision_dp: number; allowed_values: string | null; unit: string | null; reading_unit: string | null;
  method_id: number | null; method_code: string | null; method_name: string | null; standard_reference: string | null; method_revision: string | null;
  seq_no: number; evidence_required: boolean;
}
export interface PlanSnapshot { plan_id: number; plan_code: string; name: string; version_no: number; captured_at: string; params: SnapParam[] }

export async function buildPlanSnapshot(db: Tx, cid: number, planId: number): Promise<PlanSnapshot> {
  const plan = await txQueryOne<any>(db, `SELECT * FROM mst_lab_test_plan WHERE id = ? AND company_id = ?`, [planId, cid]);
  if (!plan) throw BadRequest('Test plan not found');
  const rows = await txQuery<any>(db,
    `SELECT pp.*, p.code, p.name, p.input_type, p.formula_code, p.precision_dp, p.allowed_values, c.name AS category,
            u.symbol AS unit, ru.symbol AS reading_unit, m.method_code, m.name AS method_name, m.standard_reference, m.revision AS method_revision
       FROM mst_lab_test_plan_param pp JOIN mst_lab_test_parameter p ON p.id = pp.parameter_id
       LEFT JOIN mst_lab_test_category c ON c.id = p.category_id LEFT JOIN mst_lab_unit u ON u.id = p.unit_id
       LEFT JOIN mst_lab_unit ru ON ru.id = p.reading_unit_id LEFT JOIN mst_lab_test_method m ON m.id = pp.method_id
      WHERE pp.plan_id = ? ORDER BY pp.seq_no, pp.id`, [planId]);
  return {
    plan_id: Number(plan.id), plan_code: plan.plan_code, name: plan.name, version_no: Number(plan.version_no), captured_at: new Date().toISOString(),
    params: rows.map((r) => ({
      parameter_id: Number(r.parameter_id), code: r.code, name: r.name, category: r.category, input_type: r.input_type, formula_code: r.formula_code,
      formula_version: FORMULA_VERSION[r.formula_code] ?? 1, precision_dp: Number(r.precision_dp), allowed_values: r.allowed_values,
      unit: r.unit, reading_unit: r.reading_unit, method_id: nn(r.method_id), method_code: r.method_code ?? null, method_name: r.method_name ?? null,
      standard_reference: r.standard_reference ?? null, method_revision: r.method_revision ?? null, seq_no: Number(r.seq_no),
      is_mandatory: !!Number(r.is_mandatory), repeat_count: Number(r.repeat_count), min_value: nn(r.min_value), max_value: nn(r.max_value),
      target_value: nn(r.target_value), tolerance: nn(r.tolerance), borderline_band: nn(r.borderline_band), pass_values: r.pass_values ?? null,
      evidence_required: !!Number(r.evidence_required),
    })),
  };
}

export function parseSnap(v: unknown): PlanSnapshot | null {
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : (v as PlanSnapshot); } catch { return null; }
}

/* ================================================================ trial evaluation (server side, from the snapshot) */
export async function evaluateTrial(tx: Tx, trial: { id: number; plan_snapshot: unknown }) {
  const snap = parseSnap(trial.plan_snapshot);
  if (!snap) throw BadRequest('The trial has no test plan snapshot');
  const ms = await txQuery<any>(tx, `SELECT parameter_id, reading_stage, reading_no, numeric_value, text_value FROM trx_lab_trial_measurement WHERE trial_id = ?`, [trial.id]);
  const ev = await txQuery<any>(tx, `SELECT DISTINCT parameter_id FROM trx_lab_attachment WHERE trial_id = ? AND is_removed = 0 AND parameter_id IS NOT NULL`, [trial.id]);
  const evidence = new Set(ev.map((e) => Number(e.parameter_id)));
  const existing = await txQuery<any>(tx, `SELECT * FROM trx_lab_trial_result WHERE trial_id = ?`, [trial.id]);
  const out: { parameter_id: number; is_mandatory: boolean; status: EvalStatus }[] = [];
  for (const p of snap.params) {
    const readings: Reading[] = ms.filter((m) => Number(m.parameter_id) === p.parameter_id).map((m) => ({
      reading_stage: m.reading_stage, reading_no: Number(m.reading_no), numeric_value: nn(m.numeric_value), text_value: m.text_value,
    }));
    const r = computeResult(p, p, readings, evidence.has(p.parameter_id));
    const acc = JSON.stringify({ min: p.min_value, max: p.max_value, target: p.target_value, tolerance: p.tolerance, borderline_band: p.borderline_band,
      pass_values: p.pass_values, lower: r.lower, upper: r.upper, mandatory: p.is_mandatory, repeat_count: p.repeat_count,
      method: p.method_code, plan: `${snap.plan_code} v${snap.version_no}` });
    const prev = existing.find((e) => Number(e.parameter_id) === p.parameter_id);
    // an override survives re-evaluation only while the calculated outcome is unchanged
    const keepOverride = prev && Number(prev.is_override) === 1 && prev.calc_status === r.status &&
      (prev.calculated_value == null ? r.calculated_value == null : r.calculated_value != null && Math.abs(Number(prev.calculated_value) - r.calculated_value) < 1e-9);
    const status: EvalStatus = keepOverride ? prev.evaluation_status : r.status;
    const vals = [r.raw_before, r.raw_after, r.calculated_value, r.display_value, r.result_text, p.unit, acc, status, r.status, r.note,
      p.formula_code, p.formula_version, keepOverride ? 1 : 0, p.is_mandatory ? 1 : 0];
    if (prev) {
      await txExecute(tx,
        `UPDATE trx_lab_trial_result SET raw_before = ?, raw_after = ?, calculated_value = ?, display_value = ?, result_text = ?, unit_code = ?,
                acceptance_snapshot = ?, evaluation_status = ?, calc_status = ?, evaluation_note = ?, formula_code = ?, formula_version = ?,
                is_override = ?, is_mandatory = ?, evaluated_at = NOW(),
                override_reason = IF(? = 1, override_reason, NULL), overridden_by = IF(? = 1, overridden_by, NULL), overridden_at = IF(? = 1, overridden_at, NULL)
          WHERE id = ?`, [...vals, keepOverride ? 1 : 0, keepOverride ? 1 : 0, keepOverride ? 1 : 0, prev.id]);
    } else {
      await txExecute(tx,
        `INSERT INTO trx_lab_trial_result (raw_before, raw_after, calculated_value, display_value, result_text, unit_code, acceptance_snapshot,
                evaluation_status, calc_status, evaluation_note, formula_code, formula_version, is_override, is_mandatory, evaluated_at, trial_id, parameter_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?,?)`, [...vals, trial.id, p.parameter_id]);
    }
    out.push({ parameter_id: p.parameter_id, is_mandatory: p.is_mandatory, status });
  }
  const overall = overallResult(out);
  await txExecute(tx, `UPDATE trx_lab_trial SET overall_result = ?, evaluated_at = NOW() WHERE id = ?`, [overall, trial.id]);
  return { overall, results: out };
}

/** Problems that block submission (spec §4.7: missing mandatory values; §8.3: external result evidence). */
export async function submissionBlockers(tx: Tx, trial: { id: number; plan_snapshot: unknown }) {
  const snap = parseSnap(trial.plan_snapshot)!;
  const res = await txQuery<any>(tx, `SELECT * FROM trx_lab_trial_result WHERE trial_id = ?`, [trial.id]);
  const ev = await txQuery<any>(tx, `SELECT DISTINCT parameter_id FROM trx_lab_attachment WHERE trial_id = ? AND is_removed = 0 AND parameter_id IS NOT NULL`, [trial.id]);
  const evidence = new Set(ev.map((e) => Number(e.parameter_id)));
  const out: string[] = [];
  for (const p of snap.params) {
    const r = res.find((x) => Number(x.parameter_id) === p.parameter_id);
    if (p.is_mandatory && (!r || r.evaluation_status === 'PENDING')) out.push(`${p.name}: ${r?.evaluation_note ?? 'no value entered'}`);
    if (r?.evaluation_status === 'INVALID') out.push(`${p.name}: ${r.evaluation_note ?? 'invalid reading'}`);
    if (p.evidence_required && !evidence.has(p.parameter_id)) out.push(`${p.name}: evidence (photo / file) is required`);
    if (r?.result_source === 'EXTERNAL' && (!r.external_lab_name || !r.certificate_no || !r.certificate_date || !r.certificate_attachment_id))
      out.push(`${p.name}: external result needs lab name, certificate no, date and the certificate file`);
  }
  return out;
}

/* ================================================================ lookups used by several routes */
export async function getRequest(cid: number, id: number, tx?: Tx, lock = false) {
  const sql = `SELECT * FROM trx_lab_request WHERE id = ? AND company_id = ?${lock ? ' FOR UPDATE' : ''}`;
  const r = tx ? await txQueryOne<any>(tx, sql, [id, cid]) : await queryOne<any>(sql, [id, cid]);
  if (!r) throw NotFound('Lab request not found');
  return r;
}
export async function getTrial(cid: number, id: number, tx?: Tx, lock = false) {
  const sql = `SELECT * FROM trx_lab_trial WHERE id = ? AND company_id = ?${lock ? ' FOR UPDATE' : ''}`;
  const r = tx ? await txQueryOne<any>(tx, sql, [id, cid]) : await queryOne<any>(sql, [id, cid]);
  if (!r) throw NotFound('Trial not found');
  return r;
}
export async function getReport(cid: number, id: number, tx?: Tx, lock = false) {
  const sql = `SELECT * FROM trx_lab_report WHERE id = ? AND company_id = ?${lock ? ' FOR UPDATE' : ''}`;
  const r = tx ? await txQueryOne<any>(tx, sql, [id, cid]) : await queryOne<any>(sql, [id, cid]);
  if (!r) throw NotFound('Lab report not found');
  return r;
}
export function assertRowVersion(row: { row_version: number }, given: number | null | undefined) {
  if (given != null && Number(given) !== Number(row.row_version))
    throw Conflict('This record was changed by someone else — reload and try again', { current_row_version: Number(row.row_version) });
}

/** Users who can work as lab technicians (LAB.UPDATE) in the company — and platform admins. */
export async function labUsers(cid: number, perm: string) {
  return query<any>(
    `SELECT DISTINCT u.id, u.username AS code, u.full_name AS label FROM mst_user u
       JOIN map_user_role ur ON ur.user_id = u.id
       JOIN mst_role r ON r.id = ur.role_id AND r.company_id = ? AND r.is_active = 1
      WHERE u.is_active = 1 AND u.is_deleted = 0
        AND (r.role_code = 'SUPER_ADMIN' OR EXISTS (SELECT 1 FROM map_role_permission rp JOIN mst_permission p ON p.id = rp.permission_id
                                                    WHERE rp.role_id = r.id AND p.permission_code = ?))
      ORDER BY u.full_name`, [cid, perm]);
}

export { splitList };
