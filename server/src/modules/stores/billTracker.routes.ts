import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { n, r2, cidOf, uidOf, idOpt, strOpt, dateStr, reasonSchema, idParam } from './common.js';
import {
  istToday, normNo, can, need, LIVE_WF, LINK_TYPES, TARGETS, loadTarget, searchTargets, billedAgainst, categoryOf, tolAmount,
  evaluate, touched, duplicateCandidates, runMatching, statusFromResults, OVERRIDABLE, addMovement, userName, logDecision, ensureFollowup, autoClose,
  adapterFor, settingOn, storeAttachment, missingLabel, type LinkType,
} from './billCore.js';

/**
 * Bill tracker (client tracker 14-Oct-2026; extended 24-Oct-2026 from the client's "Bill Tracker, Document Inward, Matching &
 * Accounting Auto-Posting" spec). The receipt → handover → received back → submitted to accounts steps stay as they were and now
 * also write custody movements; on top: bill category + required documents, several links (DC / GRN / PO / Bills Inward / process),
 * duplicate check, matching with tolerances, follow-ups, verification → approval (maker-checker), posting queue (MANUAL adapter).
 * Nothing is deleted (DELETE under /stores answers 400).
 */
export const billTrackerRouter = Router();

const BT_VIEW = requireAny('FINANCE.VIEW', 'PURCHASE.VIEW', 'GRN.VIEW');
const EDIT_CODES = ['FINANCE.CREATE', 'FINANCE.UPDATE', 'PURCHASE.CREATE', 'GRN.CREATE'];
const BT_EDIT = requireAny(...EDIT_CODES);
const BT_VERIFY = requirePermission('BILL_TRACKER.VERIFY');
const BT_APPROVE = requirePermission('BILL_TRACKER.APPROVE');
const BT_POST = requirePermission('BILL_TRACKER.POST');
const BT_CONFIG = requirePermission('BILL_TRACKER.CONFIG');
const VERIFY_OR_APPROVE = requireAny('BILL_TRACKER.VERIFY', 'BILL_TRACKER.APPROVE');

export const CATEGORIES = ['PURCHASE', 'PROCESS', 'EXPENSE', 'FREIGHT', 'SERVICE', 'OTHER'] as const;
const numOpt = (min = 0) => z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().min(min).nullable());
const num0 = z.preprocess((v) => (v === '' || v === null || v === undefined ? 0 : v), z.coerce.number());
const rowVersion = z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), z.coerce.number().int().positive().optional());

const btSchema = z.object({
  entry_date: dateStr.default(istToday), received_from: z.enum(['VENDOR', 'DEPARTMENT']).default('VENDOR'), received_from_dept: strOpt(80),
  bill_no: z.string().trim().min(1, 'Enter the bill no').max(60), bill_date: dateStr.nullish(), supplier_id: idOpt,
  purchase_or_process: strOpt(120), amount: z.coerce.number().min(0).default(0), supplier_bill_id: idOpt, grn_id: idOpt, remarks: strOpt(500),
  bill_category: z.enum(CATEGORIES).default('PURCHASE'), bill_qty: numOpt(), taxable_value: numOpt(),
  cgst_amount: num0, sgst_amount: num0, igst_amount: num0, other_charges: num0, round_off: num0,
  currency_code: z.string().trim().length(3).default('INR').transform((s) => s.toUpperCase()), exchange_rate: z.coerce.number().positive().default(1),
  cost_department: strOpt(80), payment_due_date: dateStr.nullish(), inward_id: idOpt, duplicate_reason: strOpt(255), row_version: rowVersion,
});
type BtIn = z.infer<typeof btSchema>;

// ================================================================== helpers
export async function masterDept(cid: number, name: string | null | undefined, keep?: string | null) {
  const v = String(name ?? '').trim();
  if (!v) return null;
  if (keep && v === String(keep).trim()) return v;
  const d = await queryOne<any>(`SELECT dept_name FROM mst_department WHERE company_id = ? AND is_active = 1 AND LOWER(dept_name) = LOWER(?)`, [cid, v]);
  if (!d) throw BadRequest(`Department "${v}" is not in the Department master — add it under Masters → Departments`);
  return d.dept_name as string;
}

const ROW_SQL = (where: string) =>
  `SELECT b.*, p.party_name supplier_name, sb.bill_no linked_bill_no, g.grn_no linked_grn_no, uc.full_name prepared_by, uv.full_name verified_by_name,
          ua.full_name approved_by_name, cat.category_name, din.inward_no, DATEDIFF(?, b.entry_date) age_days,
          (SELECT COUNT(*) FROM trx_bill_tracker_link l WHERE l.bill_id = b.id AND l.removed_at IS NULL) link_count,
          (SELECT COUNT(*) FROM trx_bill_followup f WHERE f.bill_id = b.id AND f.status = 'OPEN') open_followups
     FROM trx_bill_tracker b LEFT JOIN mst_party p ON p.id = b.supplier_id LEFT JOIN trx_supplier_bill sb ON sb.id = b.supplier_bill_id
     LEFT JOIN trx_grn g ON g.id = b.grn_id LEFT JOIN mst_user uc ON uc.id = b.created_by LEFT JOIN mst_user uv ON uv.id = b.verified_by
     LEFT JOIN mst_user ua ON ua.id = b.approved_by LEFT JOIN cfg_bill_category cat ON cat.company_id = b.company_id AND cat.category_code = b.bill_category
     LEFT JOIN trx_document_inward din ON din.id = b.inward_id
    WHERE ${where}`;

/** Where the bill stands (one line) and what has to happen next — derived from the separate status dimensions. */
export function stageOf(b: any): { stage: string; next_action: string } {
  const wf = b.workflow_status; const miss = String(b.missing_docs ?? '').split(',').filter(Boolean);
  const lbl = missingLabel(b.missing_docs).join(', ');
  const s = (stage: string, next_action: string) => ({ stage, next_action });
  if (wf === 'CANCELLED') return s('Cancelled', '—');
  if (wf === 'REVERSED') return s('Reversed', 'Reopen to correct and post again');
  if (wf === 'REJECTED') return s('Rejected', 'Reopen or cancel');
  if (wf === 'ON_HOLD') return s('On hold', 'Release the hold');
  if (b.posting_status === 'POSTED') return s('Posted', '—');
  if (['FAILED', 'UNKNOWN', 'RECON_REQUIRED'].includes(b.posting_status)) return s('Posting failed', 'Accounts: retry posting');
  if (b.posting_status === 'QUEUED') return s('Posting queued', 'Accounts: post the voucher and enter its no');
  if (wf === 'APPROVED') return s('Approved for posting', 'Accounts: queue for posting');
  if (wf === 'PENDING_APPROVAL') return s('Pending approval', 'Approver: approve or return');
  if (wf === 'PENDING_VERIFICATION') return s('Pending verification', miss.length ? `Link: ${lbl}` : 'Accounts: verify');
  if (b.duplicate_status === 'SUSPECTED') return s('Duplicate suspected', 'Approver: clear the duplicate or cancel the bill');
  if (miss.includes('DATA')) return s('Data entry pending', 'Enter supplier, invoice date and amount');
  if (miss.includes('DC')) return s('Awaiting DC', `Link: ${lbl}`);
  if (miss.includes('GRN')) return s('Awaiting GRN', `Link: ${lbl}`);
  if (miss.includes('PROCESS')) return s('Awaiting process receipt', `Link: ${lbl}`);
  if (miss.length) return s('Awaiting documents', `Link: ${lbl}`);
  if (b.match_status === 'BLOCKED') return s('Mismatch', 'Resolve the matching exceptions');
  if (b.match_status === 'NOT_RUN' || b.completeness_status === 'NOT_EVALUATED') return s('Awaiting matching', 'Run matching');
  return s('Ready to submit', 'Submit to accounts / for verification');
}
const decorate = (r: any) => (r ? { ...r, ...stageOf(r), missing_labels: missingLabel(r.missing_docs) } : r);

async function btRow(cid: number, id: number) {
  return decorate(await queryOne<any>(ROW_SQL('b.id = ? AND b.company_id = ?'), [istToday(), id, cid]));
}
export async function lockBill(tx: Tx, cid: number, id: number, rv?: number) {
  const b = await txQueryOne<any>(tx, 'SELECT * FROM trx_bill_tracker WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
  if (!b) throw NotFound('Bill not found');
  if (rv !== undefined && Number(b.row_version) !== rv)
    throw Conflict(`Bill ${b.bill_no} was changed by someone else (version ${b.row_version}, yours ${rv}) — reload and try again`, { current_version: b.row_version });
  return b;
}
function needWf(b: any, allowed: string[], action: string) {
  if (!allowed.includes(b.workflow_status))
    throw BadRequest(`Bill ${b.bill_no} is ${String(b.workflow_status).replace(/_/g, ' ').toLowerCase()} — it cannot be ${action}`);
}

/** Bills not evaluated since migration 145 get their required-document check once. */
async function ensureEvaluated(cid: number) {
  const ids = await query<any>(`SELECT id FROM trx_bill_tracker WHERE company_id = ? AND completeness_status = 'NOT_EVALUATED' LIMIT 500`, [cid]);
  for (const r of ids) await transaction((tx) => evaluate(tx, cid, Number(r.id)).then(() => undefined)).catch(() => undefined);
}

/** Keeps the old single Bills Inward / GRN columns pointing at a live link (old report, client report B). */
async function syncLegacyLinks(tx: Tx, billId: number) {
  await txExecute(tx,
    `UPDATE trx_bill_tracker b SET
        b.supplier_bill_id = (SELECT MIN(l.target_id) FROM trx_bill_tracker_link l WHERE l.bill_id = b.id AND l.link_type = 'SUPPLIER_BILL' AND l.removed_at IS NULL),
        b.grn_id = (SELECT MIN(l.target_id) FROM trx_bill_tracker_link l WHERE l.bill_id = b.id AND l.link_type = 'GRN' AND l.removed_at IS NULL)
      WHERE b.id = ?`, [billId]);
}

function validateAmounts(b: BtIn) {
  const today = istToday();
  if (b.entry_date > today) throw BadRequest('The received date cannot be in the future');
  if (b.bill_date && b.bill_date > today) throw BadRequest('The invoice date cannot be in the future');
  if (b.taxable_value !== null && b.taxable_value !== undefined) {
    const calc = n(b.taxable_value) + n(b.cgst_amount) + n(b.sgst_amount) + n(b.igst_amount) + n(b.other_charges) + n(b.round_off);
    if (Math.abs(calc - n(b.amount)) > 1)
      throw BadRequest(`Taxable value + GST + other charges + round off = ${r2(calc).toFixed(2)}, but the bill total is ${r2(n(b.amount)).toFixed(2)}`);
  }
  if (b.currency_code !== 'INR' && n(b.exchange_rate) === 1) throw BadRequest(`Enter the exchange rate for the ${b.currency_code} bill`);
}

// ------------------------------------------------------------------ links (shared by create / PUT / link endpoint)
const linkSchema = z.object({
  link_type: z.enum(LINK_TYPES), target_id: z.coerce.number().int().positive(), linked_amount: numOpt(), linked_qty: numOpt(),
  note: strOpt(255), allow_other_party: z.coerce.boolean().default(false),
});
export async function addLink(tx: Tx, req: Request, b: any, inp: z.infer<typeof linkSchema>) {
  const cid = cidOf(req);
  const def = TARGETS[inp.link_type];
  const t = await loadTarget(cid, inp.link_type, inp.target_id, tx);
  if (!t) throw BadRequest(`${def.label} not found`);
  if (!Number(t.ok)) throw BadRequest(`${def.label} ${t.no} is cancelled — it cannot be linked`);
  const same = await txQueryOne<any>(tx, 'SELECT id FROM trx_bill_tracker_link WHERE bill_id = ? AND link_type = ? AND target_id = ? AND removed_at IS NULL', [b.id, inp.link_type, inp.target_id]);
  if (same) throw BadRequest(`${def.label} ${t.no} is already linked to this bill`);
  if (b.supplier_id && t.party_id && Number(t.party_id) !== Number(b.supplier_id) && !inp.allow_other_party) {
    const p = await txQueryOne<any>(tx, 'SELECT party_name FROM mst_party WHERE id = ?', [t.party_id]);
    throw BadRequest(`${def.label} ${t.no} is of ${p?.party_name ?? 'another party'}, not the bill's supplier. Tick "other party" to link it anyway (an approver must override it).`);
  }
  let needsOverride = 0; let notice: string | null = null;
  let amt = inp.linked_amount; let qty = inp.linked_qty;
  if (def.valued && t.amount !== null) {
    const used = (await billedAgainst(cid, inp.link_type, [inp.target_id], b.id, tx)).get(inp.target_id);
    if (inp.link_type === 'SUPPLIER_BILL' && used?.bills) throw BadRequest(`Bills Inward entry ${t.no} is already linked to ${used.bills} — a bill can be entered only once`);
    const remaining = r2(Math.max(0, n(t.amount) - n(used?.amount)));
    if (amt === null || amt === undefined) amt = remaining;
    const cat = await categoryOf(cid, b.bill_category, tx);
    const tol = tolAmount(cat, n(t.amount));
    if (n(amt) > remaining + tol) {
      const msg = `${def.label} ${t.no}: value ${r2(n(t.amount)).toFixed(2)}, already billed ${r2(n(used?.amount)).toFixed(2)}${used?.bills ? ` (${used.bills})` : ''}, remaining ${remaining.toFixed(2)} — this bill links ${r2(n(amt)).toFixed(2)}`;
      if (cat.over_billing === 'BLOCK') throw BadRequest(`Over-billing: ${msg}`);
      needsOverride = 1; notice = `Over-billing — needs an approver's override: ${msg}`;
    }
    if (t.qty !== null && (qty === null || qty === undefined)) qty = Math.max(0, n(t.qty) - n(used?.qty));
  }
  const r = await txExecute(tx,
    `INSERT INTO trx_bill_tracker_link (company_id, bill_id, link_type, target_id, target_no, target_date, target_party_id, target_qty, target_amount, linked_qty, linked_amount,
                                        needs_override, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, b.id, inp.link_type, inp.target_id, String(t.no ?? '').slice(0, 60), t.dt ?? null, t.party_id ?? null, t.qty === null ? null : n(t.qty),
     t.amount === null ? null : r2(n(t.amount)), qty ?? null, amt === null || amt === undefined ? null : r2(n(amt)), needsOverride, inp.note, uidOf(req)]);
  await audit(req, 'trx_bill_tracker_link', r.insertId, 'INSERT', undefined, { bill_id: b.id, link_type: inp.link_type, target_id: inp.target_id, target_no: t.no, linked_amount: amt, linked_qty: qty, needs_override: needsOverride }, tx);
  if (inp.link_type === 'DOC_INWARD') await refreshInward(tx, cid, inp.target_id);
  return { id: r.insertId as number, notice };
}

/** Inward document completeness (also used by the document inward routes). */
export async function refreshInward(tx: Tx, cid: number, inwardId: number) {
  const d = await txQueryOne<any>(tx, 'SELECT * FROM trx_document_inward WHERE id = ? AND company_id = ?', [inwardId, cid]);
  if (!d) return null;
  const linked = n((await txQueryOne<any>(tx,
    `SELECT (SELECT COUNT(*) FROM trx_bill_tracker_link l JOIN trx_bill_tracker b ON b.id = l.bill_id WHERE l.link_type = 'DOC_INWARD' AND l.target_id = ? AND l.removed_at IS NULL AND b.workflow_status <> 'CANCELLED')
          + (SELECT COUNT(*) FROM trx_bill_tracker b WHERE b.inward_id = ? AND b.workflow_status <> 'CANCELLED')
          + (SELECT COUNT(*) FROM trx_document_link x WHERE x.inward_id = ? AND x.removed_at IS NULL)
          + (SELECT COUNT(*) FROM trx_document_link x WHERE x.target_type = 'INWARD' AND x.target_id = ? AND x.removed_at IS NULL) c`, [inwardId, inwardId, inwardId, inwardId]))?.c);
  const needMeta = ['BILL', 'DC', 'GRN_COPY', 'PO_COPY', 'PROCESS_CHALLAN'].includes(d.doc_type);
  const dupNote = d.duplicate_cleared ? null : d.duplicate_note;
  const state = d.status === 'REJECTED' ? 'REJECTED' : dupNote ? 'DUPLICATE_SUSPECTED'
    : (needMeta && (!d.party_id || !d.doc_no || !d.doc_date)) || (d.channel === 'EMAIL' && !d.email_from) ? 'INCOMPLETE'
    : !linked ? 'AWAITING_LINK' : 'COMPLETE';
  await txExecute(tx, 'UPDATE trx_document_inward SET completeness = ? WHERE id = ?', [state, inwardId]);
  return state;
}

/** Duplicate rule on save: another live bill of the supplier with the same normalized invoice no → 409, or saved as SUSPECTED with a reason. */
async function duplicateGate(cid: number, b: BtIn, exceptId: number | null) {
  const d = await duplicateCandidates(cid, b.supplier_id, b.bill_no, exceptId);
  if (!d.duplicates.length) return { status: null as string | null, note: null as string | null, d };
  const list = d.duplicates.map((x: any) => `${x.entry_no} (${x.bill_no})`).join(', ');
  if (!b.duplicate_reason || b.duplicate_reason.length < 3)
    throw Conflict(`Duplicate bill: the same supplier invoice no is already on ${list}. If this really is a different bill, give the reason.`, d);
  return { status: 'SUSPECTED', note: `Same supplier + invoice no as ${list} — saved with reason: ${b.duplicate_reason}`.slice(0, 255), d };
}

// ================================================================== list / dashboard
const listQ = z.object({
  from: dateStr.optional(), to: dateStr.optional(), q: z.string().trim().max(100).optional().transform((v) => v || undefined),
  status: z.string().trim().max(24).optional().transform((v) => v || undefined), workflow: z.string().trim().max(24).optional().transform((v) => v || undefined),
  category: z.string().trim().max(12).optional().transform((v) => v || undefined), supplier_id: z.coerce.number().int().positive().optional(),
  holder_dept: z.string().trim().max(80).optional().transform((v) => v || undefined), match: z.string().trim().max(12).optional().transform((v) => v || undefined),
  posting: z.string().trim().max(16).optional().transform((v) => v || undefined), kpi: z.string().trim().max(30).optional().transform((v) => v || undefined),
  age: z.enum(['0-3', '4-7', '8-15', '16-30', '31+']).optional(), page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).optional(), limit: z.coerce.number().int().min(1).max(2000).optional(),
});
const PRE_APPROVAL = `b.workflow_status IN ('OPEN','PENDING_VERIFICATION','ON_HOLD')`;
const OPEN_BILL = `b.workflow_status IN ${LIVE_WF} AND b.posting_status NOT IN ('POSTED','REVERSED')`;
const KPI: Record<string, (today: string) => string> = {
  open: () => OPEN_BILL,
  data_pending: () => `${PRE_APPROVAL} AND b.completeness_status = 'INCOMPLETE'`,
  dc_awaited: () => `${PRE_APPROVAL} AND FIND_IN_SET('DC', b.missing_docs)`,
  grn_awaited: () => `${PRE_APPROVAL} AND (FIND_IN_SET('GRN', b.missing_docs) OR FIND_IN_SET('PROCESS', b.missing_docs))`,
  docs_awaited: () => `${PRE_APPROVAL} AND b.completeness_status = 'AWAITING_LINK'`,
  awaiting_matching: () => `${PRE_APPROVAL} AND b.completeness_status = 'COMPLETE' AND b.match_status = 'NOT_RUN'`,
  mismatch: () => `b.workflow_status IN ${LIVE_WF} AND (b.match_status = 'BLOCKED' OR b.duplicate_status = 'SUSPECTED')`,
  duplicate: () => `b.workflow_status IN ${LIVE_WF} AND b.duplicate_status = 'SUSPECTED'`,
  verification_pending: () => `b.workflow_status = 'PENDING_VERIFICATION'`,
  approval_pending: () => `b.workflow_status = 'PENDING_APPROVAL'`,
  on_hold: () => `b.workflow_status = 'ON_HOLD'`,
  approved_not_queued: () => `b.workflow_status = 'APPROVED' AND b.posting_status = 'NOT_ELIGIBLE'`,
  posting_queued: () => `b.posting_status = 'QUEUED'`,
  posting_failed: () => `b.posting_status IN ('FAILED','UNKNOWN','RECON_REQUIRED')`,
  posted: () => `b.posting_status = 'POSTED'`,
  overdue_custody: (t) => `b.workflow_status <> 'CANCELLED' AND b.holder_expected_back IS NOT NULL AND b.holder_expected_back < '${t}'`,
};
const AGE: Record<string, [number, number]> = { '0-3': [0, 3], '4-7': [4, 7], '8-15': [8, 15], '16-30': [16, 30], '31+': [31, 100000] };

function listFilter(cid: number, q: z.infer<typeof listQ>, today: string) {
  const w = ['b.company_id = ?']; const p: unknown[] = [cid];
  if (q.from) { w.push('b.entry_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('b.entry_date <= ?'); p.push(q.to); }
  if (q.status) { w.push('b.status = ?'); p.push(q.status); }
  if (q.workflow) { w.push('b.workflow_status = ?'); p.push(q.workflow); }
  if (q.category) { w.push('b.bill_category = ?'); p.push(q.category); }
  if (q.supplier_id) { w.push('b.supplier_id = ?'); p.push(q.supplier_id); }
  if (q.holder_dept) { w.push('b.holder_dept = ?'); p.push(q.holder_dept); }
  if (q.match) { w.push('b.match_status = ?'); p.push(q.match); }
  if (q.posting) { w.push('b.posting_status = ?'); p.push(q.posting); }
  if (q.kpi) { const k = KPI[q.kpi]; if (!k) throw BadRequest(`Unknown filter ${q.kpi}`); w.push(`(${k(today)})`); }
  if (q.age) { const [a, z2] = AGE[q.age]; w.push(`${OPEN_BILL} AND DATEDIFF(?, b.entry_date) BETWEEN ? AND ?`); p.push(today, a, z2); }
  if (q.q) {
    w.push('(b.bill_no LIKE ? OR b.entry_no LIKE ? OR p.party_name LIKE ? OR b.purchase_or_process LIKE ? OR b.handed_over_to LIKE ? OR b.holder_name LIKE ? OR b.normalized_bill_no LIKE ?)');
    const like = `%${q.q}%`; p.push(like, like, like, like, like, like, `%${normNo(q.q)}%`);
  }
  return { where: w.join(' AND '), params: p };
}

billTrackerRouter.get('/bill-tracker', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const q = listQ.parse(req.query); const today = istToday();
  await ensureEvaluated(cid);
  const f = listFilter(cid, q, today);
  const size = q.page_size ?? q.limit ?? 500;
  const total = n((await queryOne<any>(`SELECT COUNT(*) c FROM trx_bill_tracker b LEFT JOIN mst_party p ON p.id = b.supplier_id WHERE ${f.where}`, f.params))?.c);
  const rows = await query<any>(ROW_SQL(f.where) + ` ORDER BY b.entry_date DESC, b.id DESC LIMIT ${size} OFFSET ${(q.page - 1) * size}`, [today, ...f.params]);
  res.json({ data: rows.map(decorate), pagination: { page: q.page, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) } });
}));

billTrackerRouter.get('/bill-tracker/dashboard', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const today = istToday();
  await ensureEvaluated(cid);
  const count = async (k: string) => n((await queryOne<any>(`SELECT COUNT(*) c FROM trx_bill_tracker b WHERE b.company_id = ? AND (${KPI[k](today)})`, [cid]))?.c);
  const kpis: Record<string, number> = {};
  for (const k of Object.keys(KPI)) kpis[k] = await count(k);
  kpis.bills_awaited = n((await queryOne<any>(
    `SELECT COUNT(*) c FROM trx_document_inward d WHERE d.company_id = ? AND d.status = 'ACTIVE' AND d.doc_type IN ('DC','PROCESS_CHALLAN','GRN_COPY')
        AND NOT EXISTS (SELECT 1 FROM trx_bill_tracker_link l JOIN trx_bill_tracker b ON b.id = l.bill_id
                         WHERE l.link_type = 'DOC_INWARD' AND l.target_id = d.id AND l.removed_at IS NULL AND b.workflow_status <> 'CANCELLED')`, [cid]))?.c);
  kpis.overdue_followups = n((await queryOne<any>(`SELECT COUNT(*) c FROM trx_bill_followup WHERE company_id = ? AND status = 'OPEN' AND due_date < ?`, [cid, today]))?.c);
  kpis.inward_unresolved = n((await queryOne<any>(`SELECT COUNT(*) c FROM trx_document_inward WHERE company_id = ? AND status = 'ACTIVE' AND completeness <> 'COMPLETE'`, [cid]))?.c);
  kpis.inward_overdue = n((await queryOne<any>(`SELECT COUNT(*) c FROM trx_document_inward WHERE company_id = ? AND status = 'ACTIVE' AND completeness <> 'COMPLETE' AND due_date < ?`, [cid, today]))?.c);
  const ageing = await query<any>(
    `SELECT CASE WHEN a <= 3 THEN '0-3' WHEN a <= 7 THEN '4-7' WHEN a <= 15 THEN '8-15' WHEN a <= 30 THEN '16-30' ELSE '31+' END bucket, COUNT(*) bills, SUM(amount) amount
       FROM (SELECT DATEDIFF(?, b.entry_date) a, b.amount FROM trx_bill_tracker b WHERE b.company_id = ? AND ${OPEN_BILL}) x GROUP BY bucket`, [today, cid]);
  const holders = await query<any>(
    `SELECT COALESCE(b.holder_dept, b.holder_location, '—') dept, COUNT(*) bills, SUM(b.amount) amount,
            SUM(b.holder_expected_back IS NOT NULL AND b.holder_expected_back < ?) overdue
       FROM trx_bill_tracker b WHERE b.company_id = ? AND ${OPEN_BILL} GROUP BY dept ORDER BY bills DESC`, [today, cid]);
  const dwell = await query<any>(
    `SELECT COALESCE(to_dept, to_location, '—') dept, COUNT(*) moves, ROUND(AVG(TIMESTAMPDIFF(HOUR, moved_at, next_at)) / 24, 1) avg_days
       FROM (SELECT m.to_dept, m.to_location, m.moved_at, LEAD(m.moved_at) OVER (PARTITION BY m.bill_id ORDER BY m.seq) next_at
               FROM trx_bill_movement m WHERE m.company_id = ? AND m.moved_at >= DATE_SUB(NOW(), INTERVAL 180 DAY)) x
      WHERE next_at IS NOT NULL GROUP BY dept ORDER BY avg_days DESC`, [cid]);
  res.json({ data: { kpis, ageing: ['0-3', '4-7', '8-15', '16-30', '31+'].map((k) => ({ bucket: k, bills: n(ageing.find((a) => a.bucket === k)?.bills), amount: r2(n(ageing.find((a) => a.bucket === k)?.amount)) })), holders, dwell, today } });
}));

/** Supplier bills (Bills Inward) and GRNs of a supplier (kept for the old screen). */
billTrackerRouter.get('/bill-tracker/sources', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const { supplier_id } = z.object({ supplier_id: z.coerce.number().int().positive() }).parse(req.query);
  const [bills, grns] = await Promise.all([
    query<any>(`SELECT id, bill_no, bill_date, COALESCE(supplier_inv_no, bill_no) inv_no, total_amount, bill_type FROM trx_supplier_bill
                 WHERE company_id = ? AND supplier_id = ? AND status <> 'CANCELLED' ORDER BY bill_date DESC, id DESC LIMIT 200`, [cid, supplier_id]),
    query<any>(`SELECT id, grn_no, grn_date, supplier_inv_no, net_amount FROM trx_grn WHERE company_id = ? AND supplier_id = ? ORDER BY grn_date DESC, id DESC LIMIT 200`, [cid, supplier_id]),
  ]);
  res.json({ data: { bills, grns } });
}));

billTrackerRouter.get('/bill-tracker/link-candidates', BT_VIEW, ah(async (req, res) => {
  const q = z.object({ type: z.enum(LINK_TYPES), supplier_id: z.coerce.number().int().positive().optional(), q: z.string().trim().max(60).optional(),
    bill_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  res.json({ data: await searchTargets(cidOf(req), q.type, q.supplier_id ?? null, q.q || undefined, q.bill_id ?? null),
    meta: { label: TARGETS[q.type].label, types: LINK_TYPES.map((t) => ({ value: t, label: TARGETS[t].label })) } });
}));

billTrackerRouter.get('/bill-tracker/duplicates', BT_VIEW, ah(async (req, res) => {
  const q = z.object({ supplier_id: z.coerce.number().int().positive(), bill_no: z.string().trim().min(1).max(60), exclude_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  res.json({ data: await duplicateCandidates(cidOf(req), q.supplier_id, q.bill_no, q.exclude_id ?? null) });
}));

// ------------------------------------------------------------------ categories (required-document matrix)
billTrackerRouter.get('/bill-tracker/categories', BT_VIEW, ah(async (req, res) => {
  res.json({ data: await query<any>('SELECT * FROM cfg_bill_category WHERE company_id = ? ORDER BY sort_order, id', [cidOf(req)]) });
}));
const catSchema = z.object({
  category_name: z.string().trim().min(2).max(60), req_dc: z.coerce.boolean(), req_receipt: z.coerce.boolean(), req_po: z.coerce.boolean(),
  req_bill_entry: z.coerce.boolean(), req_process: z.coerce.boolean(), req_attachment: z.coerce.boolean(),
  amount_tol_pct: z.coerce.number().min(0).max(100), amount_tol_abs: z.coerce.number().min(0).max(1e7), qty_tol_pct: z.coerce.number().min(0).max(100),
  over_billing: z.enum(['BLOCK', 'APPROVAL']), high_value_limit: z.coerce.number().min(0), is_active: z.coerce.boolean().default(true), row_version: rowVersion,
});
billTrackerRouter.put('/bill-tracker/categories/:id', BT_CONFIG, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const b = catSchema.parse(req.body);
  const before = await queryOne<any>('SELECT * FROM cfg_bill_category WHERE id = ? AND company_id = ?', [id, cid]);
  if (!before) throw NotFound('Category not found');
  await transaction(async (tx) => {
    const r = await txExecute(tx,
      `UPDATE cfg_bill_category SET category_name = ?, req_dc = ?, req_receipt = ?, req_po = ?, req_bill_entry = ?, req_process = ?, req_attachment = ?, amount_tol_pct = ?,
              amount_tol_abs = ?, qty_tol_pct = ?, over_billing = ?, high_value_limit = ?, is_active = ?, updated_by = ?, row_version = row_version + 1
        WHERE id = ? AND company_id = ? ${b.row_version ? 'AND row_version = ?' : ''}`,
      [b.category_name, +b.req_dc, +b.req_receipt, +b.req_po, +b.req_bill_entry, +b.req_process, +b.req_attachment, b.amount_tol_pct, b.amount_tol_abs, b.qty_tol_pct,
       b.over_billing, b.high_value_limit, +b.is_active, uidOf(req), id, cid, ...(b.row_version ? [b.row_version] : [])]);
    if (!r.affectedRows) throw Conflict('The category was changed by someone else — reload and try again');
    // live bills of the category: required documents re-checked under the new rule
    const bills = await txQuery<any>(tx, `SELECT id FROM trx_bill_tracker WHERE company_id = ? AND bill_category = ? AND workflow_status IN ${LIVE_WF}`, [cid, before.category_code]);
    for (const x of bills) await touched(tx, cid, Number(x.id));
  });
  const after = await queryOne<any>('SELECT * FROM cfg_bill_category WHERE id = ?', [id]);
  await audit(req, 'cfg_bill_category', id, 'UPDATE', before, after);
  res.json({ data: after, message: `${after.category_name}: saved` });
}));

// ------------------------------------------------------------------ inboxes
billTrackerRouter.get('/bill-tracker/approval-inbox', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const rows = await query<any>(ROW_SQL(`b.company_id = ? AND b.workflow_status IN ('PENDING_VERIFICATION','PENDING_APPROVAL')`) + ' ORDER BY b.submitted_at, b.id LIMIT 500', [istToday(), cid]);
  const uid = uidOf(req); const mc = await settingOn(cid, 'BT_MAKER_CHECKER');
  res.json({ data: rows.map((r) => ({ ...decorate(r), own_entry: mc && Number(r.created_by) === uid })) });
}));

billTrackerRouter.get('/bill-tracker/posting-queue', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ status: z.string().trim().max(16).optional() }).parse(req.query);
  const rows = await query<any>(
    `SELECT pq.*, b.entry_no, b.bill_no, b.bill_date, b.amount, b.workflow_status, p.party_name supplier_name, u.full_name posted_by_name
       FROM trx_bill_posting pq JOIN trx_bill_tracker b ON b.id = pq.bill_id LEFT JOIN mst_party p ON p.id = b.supplier_id LEFT JOIN mst_user u ON u.id = pq.posted_by
      WHERE pq.company_id = ? ${q.status ? 'AND pq.status = ?' : ''} ORDER BY FIELD(pq.status, 'FAILED', 'UNKNOWN', 'RECON_REQUIRED', 'QUEUED', 'POSTING') DESC, pq.created_at DESC LIMIT 1000`,
    q.status ? [cid, q.status] : [cid]);
  res.json({ data: rows.map(({ payload_json, ...r }) => r) });
}));

/** ERP-approved vs accounting-posted: approved but not queued, queued, failed, posted, posted amount ≠ bill amount, one voucher on two bills. */
billTrackerRouter.get('/bill-tracker/reconciliation', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const rows = await query<any>(
    `SELECT b.id, b.entry_no, b.bill_no, b.bill_date, b.amount, b.workflow_status, b.posting_status, b.approved_at, p.party_name supplier_name,
            pq.id posting_id, pq.status queue_status, pq.idempotency_key, pq.attempts, pq.payload_amount, pq.external_voucher_no, pq.external_voucher_date, pq.posted_at,
            pq.last_error_summary,
            (SELECT COUNT(*) FROM trx_bill_posting x WHERE x.company_id = b.company_id AND x.status = 'POSTED' AND x.external_voucher_no = pq.external_voucher_no AND x.id <> pq.id) voucher_reused
       FROM trx_bill_tracker b LEFT JOIN mst_party p ON p.id = b.supplier_id
       LEFT JOIN trx_bill_posting pq ON pq.id = (SELECT MAX(y.id) FROM trx_bill_posting y WHERE y.bill_id = b.id)
      WHERE b.company_id = ? AND (b.workflow_status IN ('APPROVED','REVERSED') OR pq.id IS NOT NULL) ORDER BY b.approved_at DESC, b.id DESC LIMIT 2000`, [cid]);
  const out = rows.map((r) => {
    let recon = 'OK';
    if (r.workflow_status === 'APPROVED' && !r.posting_id) recon = 'APPROVED_NOT_QUEUED';
    else if (r.queue_status === 'CANCELLED' && r.workflow_status === 'APPROVED') recon = 'APPROVED_NOT_QUEUED';
    else if (['QUEUED', 'POSTING'].includes(r.queue_status)) recon = 'PENDING_POSTING';
    else if (['FAILED', 'UNKNOWN'].includes(r.queue_status)) recon = 'FAILED';
    else if (r.queue_status === 'POSTED' && Math.abs(n(r.payload_amount) - n(r.amount)) > 0.005) recon = 'AMOUNT_DIFFERS';
    else if (r.queue_status === 'POSTED' && n(r.voucher_reused)) recon = 'VOUCHER_REUSED';
    else if (r.queue_status === 'RECON_REQUIRED') recon = 'RECON_REQUIRED';
    else if (r.queue_status === 'POSTED') recon = 'POSTED';
    else if (r.queue_status === 'REVERSED') recon = 'REVERSED';
    return { ...r, recon };
  });
  const summary: Record<string, { bills: number; amount: number }> = {};
  for (const r of out) { summary[r.recon] ??= { bills: 0, amount: 0 }; summary[r.recon].bills++; summary[r.recon].amount = r2(summary[r.recon].amount + n(r.amount)); }
  res.json({ data: out, summary });
}));

// ------------------------------------------------------------------ follow-ups
const fuSchema = z.object({
  issue_type: z.enum(['MISSING_BILL', 'MISSING_DC', 'MISSING_GRN', 'MISMATCH', 'DUPLICATE', 'SUPPLIER_CLARIFICATION', 'APPROVAL_DELAY', 'POSTING_FAILURE', 'DATA_COMPLETION', 'OTHER']),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'), owner_id: idOpt, due_date: dateStr, reason: z.string().trim().min(3, 'Give the reason').max(500),
  notes: strOpt(1000), last_contact_date: dateStr.nullish(), next_followup_date: dateStr.nullish(),
});
export async function createFollowup(req: Request, target: { bill_id?: number | null; inward_id?: number | null }) {
  const cid = cidOf(req); const b = fuSchema.parse(req.body);
  if (b.owner_id && !(await queryOne('SELECT id FROM mst_user WHERE id = ? AND is_deleted = 0', [b.owner_id]))) throw BadRequest('Owner not found');
  const r = await query<any>(
    `INSERT INTO trx_bill_followup (company_id, bill_id, inward_id, issue_type, priority, owner_id, due_date, reason, notes, last_contact_date, next_followup_date, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, target.bill_id ?? null, target.inward_id ?? null, b.issue_type, b.priority, b.owner_id ?? uidOf(req), b.due_date, b.reason, b.notes, b.last_contact_date ?? null,
     b.next_followup_date ?? null, uidOf(req)]) as any;
  const id = Number(r.insertId);
  await audit(req, 'trx_bill_followup', id, 'INSERT', undefined, { ...b, bill_id: target.bill_id ?? null, inward_id: target.inward_id ?? null });
  return id;
}
const FU_SQL = `SELECT f.*, uo.full_name owner_name, uc.full_name created_by_name, b.entry_no, b.bill_no, d.inward_no, p.party_name
                  FROM trx_bill_followup f LEFT JOIN mst_user uo ON uo.id = f.owner_id LEFT JOIN mst_user uc ON uc.id = f.created_by
                  LEFT JOIN trx_bill_tracker b ON b.id = f.bill_id LEFT JOIN trx_document_inward d ON d.id = f.inward_id
                  LEFT JOIN mst_party p ON p.id = COALESCE(b.supplier_id, d.party_id)`;
billTrackerRouter.get('/bill-tracker/followups', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const today = istToday();
  const q = z.object({ status: z.enum(['OPEN', 'CLOSED', 'CANCELLED', 'ALL']).default('OPEN'), mine: z.coerce.boolean().default(false), overdue: z.coerce.boolean().default(false),
    issue_type: z.string().max(24).optional() }).parse(req.query);
  const w = ['f.company_id = ?']; const p: unknown[] = [cid];
  if (q.status !== 'ALL') { w.push('f.status = ?'); p.push(q.status); }
  if (q.mine) { w.push('f.owner_id = ?'); p.push(uidOf(req)); }
  if (q.overdue) { w.push('f.due_date < ?'); p.push(today); }
  if (q.issue_type) { w.push('f.issue_type = ?'); p.push(q.issue_type); }
  const rows = await query<any>(`${FU_SQL} WHERE ${w.join(' AND ')} ORDER BY f.status = 'OPEN' DESC, f.due_date, f.id LIMIT 1000`, p);
  res.json({ data: rows.map((r) => ({ ...r, overdue: r.status === 'OPEN' && String(r.due_date) < today })) });
}));
billTrackerRouter.put('/bill-tracker/followups/:id', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']), owner_id: idOpt, due_date: dateStr, notes: strOpt(1000), last_contact_date: dateStr.nullish(),
    next_followup_date: dateStr.nullish(), row_version: z.coerce.number().int().positive() }).parse(req.body);
  const before = await queryOne<any>('SELECT * FROM trx_bill_followup WHERE id = ? AND company_id = ?', [id, cid]);
  if (!before) throw NotFound('Follow-up not found');
  if (before.status !== 'OPEN') throw BadRequest('The follow-up is closed');
  const r = await query<any>(
    `UPDATE trx_bill_followup SET priority = ?, owner_id = ?, due_date = ?, notes = ?, last_contact_date = ?, next_followup_date = ?, updated_by = ?, row_version = row_version + 1
      WHERE id = ? AND company_id = ? AND row_version = ?`,
    [b.priority, b.owner_id, b.due_date, b.notes, b.last_contact_date ?? null, b.next_followup_date ?? null, uidOf(req), id, cid, b.row_version]) as any;
  if (!r.affectedRows) throw Conflict('The follow-up was changed by someone else — reload and try again');
  const after = await queryOne<any>(`${FU_SQL} WHERE f.id = ?`, [id]);
  await audit(req, 'trx_bill_followup', id, 'UPDATE', before, { ...b, bill_id: before.bill_id, inward_id: before.inward_id });
  res.json({ data: after, message: 'Follow-up saved' });
}));
billTrackerRouter.post('/bill-tracker/followups/:id/close', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ resolution_note: z.string().trim().min(3, 'Write how it was resolved').max(500), status: z.enum(['CLOSED', 'CANCELLED']).default('CLOSED') }).parse(req.body);
  const before = await queryOne<any>('SELECT * FROM trx_bill_followup WHERE id = ? AND company_id = ?', [id, cid]);
  if (!before) throw NotFound('Follow-up not found');
  if (before.status !== 'OPEN') throw BadRequest('The follow-up is already closed');
  await query(`UPDATE trx_bill_followup SET status = ?, resolution_note = ?, closed_by = ?, closed_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [b.status, b.resolution_note, uidOf(req), id]);
  await audit(req, 'trx_bill_followup', id, 'UPDATE', { status: 'OPEN' }, { status: b.status, resolution_note: b.resolution_note, bill_id: before.bill_id, inward_id: before.inward_id });
  res.json({ data: await queryOne<any>(`${FU_SQL} WHERE f.id = ?`, [id]), message: b.status === 'CLOSED' ? 'Follow-up closed' : 'Follow-up cancelled' });
}));

// ------------------------------------------------------------------ custody acknowledgement (the only change ever made to a movement row)
billTrackerRouter.post('/bill-tracker/movements/:id/acknowledge', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ decision: z.enum(['ACKNOWLEDGED', 'DISPUTED']), note: strOpt(255) }).parse(req.body);
  const m = await queryOne<any>('SELECT * FROM trx_bill_movement WHERE id = ? AND company_id = ?', [id, cid]);
  if (!m) throw NotFound('Movement not found');
  if (Number(m.to_user_id) !== uidOf(req)) throw Forbidden('Only the person the bill was handed to can acknowledge it');
  if (m.ack_status !== 'PENDING') throw BadRequest('This handover is already acknowledged');
  if (b.decision === 'DISPUTED' && !b.note) throw BadRequest('Say what is wrong (e.g. the bill was not received)');
  await query(`UPDATE trx_bill_movement SET ack_status = ?, ack_by = ?, ack_at = NOW(), ack_note = ? WHERE id = ? AND ack_status = 'PENDING'`, [b.decision, uidOf(req), b.note, id]);
  await audit(req, 'trx_bill_movement', id, 'UPDATE', { ack_status: 'PENDING' }, { ack_status: b.decision, note: b.note, bill_id: m.bill_id });
  res.json({ data: await queryOne<any>('SELECT * FROM trx_bill_movement WHERE id = ?', [id]), message: b.decision === 'ACKNOWLEDGED' ? 'Receipt of the bill acknowledged' : 'Handover disputed' });
}));

// ------------------------------------------------------------------ posting queue: scheduler run (manual trigger, idempotent)
billTrackerRouter.post('/bill-tracker/posting/enqueue-eligible', BT_POST, ah(async (req, res) => {
  const cid = cidOf(req);
  const ids = await query<any>(`SELECT id, entry_no FROM trx_bill_tracker WHERE company_id = ? AND workflow_status = 'APPROVED' AND posting_status = 'NOT_ELIGIBLE' ORDER BY approved_at LIMIT 500`, [cid]);
  const queued: string[] = []; const skipped: { entry_no: string; reason: string }[] = [];
  for (const r of ids) {
    try {
      const out = await transaction(async (tx) => enqueue(tx, req, await lockBill(tx, cid, Number(r.id))));
      if (out.created) queued.push(r.entry_no);
    } catch (e: any) { skipped.push({ entry_no: r.entry_no, reason: e?.message ?? String(e) }); }
  }
  res.json({ data: { queued, skipped }, message: `${queued.length} bill(s) queued for posting${skipped.length ? `, ${skipped.length} not eligible` : ''}` });
}));

// ================================================================== one bill
billTrackerRouter.get('/bill-tracker/:id', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const row = await btRow(cid, id);
  if (!row) throw NotFound('Bill not found');
  if (row.completeness_status === 'NOT_EVALUATED') { await transaction((tx) => evaluate(tx, cid, id)); Object.assign(row, await btRow(cid, id)); }
  const [links, movements, approvals, followups, postings, attachments, category] = await Promise.all([
    query<any>(`SELECT l.*, p.party_name target_party, u.full_name created_by_name, ur.full_name removed_by_name FROM trx_bill_tracker_link l
                  LEFT JOIN mst_party p ON p.id = l.target_party_id LEFT JOIN mst_user u ON u.id = l.created_by LEFT JOIN mst_user ur ON ur.id = l.removed_by
                 WHERE l.bill_id = ? ORDER BY l.removed_at IS NOT NULL, l.id`, [id]),
    query<any>(`SELECT m.*, uh.full_name recorded_by_name, ua.full_name ack_by_name FROM trx_bill_movement m LEFT JOIN mst_user uh ON uh.id = m.handed_over_by
                  LEFT JOIN mst_user ua ON ua.id = m.ack_by WHERE m.bill_id = ? ORDER BY m.seq DESC`, [id]),
    query<any>(`SELECT a.*, u.full_name actor_name FROM trx_bill_approval a LEFT JOIN mst_user u ON u.id = a.actor_id WHERE a.bill_id = ? ORDER BY a.id DESC`, [id]),
    query<any>(`${FU_SQL} WHERE f.bill_id = ? OR (f.inward_id IS NOT NULL AND f.inward_id = ?) ORDER BY f.status = 'OPEN' DESC, f.due_date`, [id, row.inward_id ?? 0]),
    query<any>(`SELECT pq.id, pq.idempotency_key, pq.adapter, pq.payload_version, pq.payload_amount, pq.status, pq.attempts, pq.next_attempt_at, pq.external_voucher_id,
                       pq.external_voucher_no, pq.external_voucher_date, pq.posted_at, pq.last_error_code, pq.last_error_summary, pq.reversal_voucher_no, pq.created_at, u.full_name posted_by_name
                  FROM trx_bill_posting pq LEFT JOIN mst_user u ON u.id = pq.posted_by WHERE pq.bill_id = ? ORDER BY pq.id DESC`, [id]),
    query<any>(`SELECT a.id, a.inward_id, a.bill_id, a.original_name, a.mime_type, a.byte_size, a.sha256, a.duplicate_of_id, a.uploaded_at, a.is_removed, a.remove_reason,
                       u.full_name uploaded_by_name, d.inward_no FROM trx_bill_doc_attachment a LEFT JOIN mst_user u ON u.id = a.uploaded_by
                       LEFT JOIN trx_document_inward d ON d.id = a.inward_id
                 WHERE a.company_id = ? AND (a.bill_id = ? OR a.inward_id = ? OR a.inward_id IN (SELECT l.target_id FROM trx_bill_tracker_link l WHERE l.bill_id = ? AND l.link_type = 'DOC_INWARD' AND l.removed_at IS NULL))
                 ORDER BY a.is_removed, a.id`, [cid, id, row.inward_id ?? 0, id]),
    queryOne<any>('SELECT * FROM cfg_bill_category WHERE company_id = ? AND category_code = ?', [cid, row.bill_category]),
  ]);
  const attempts = postings.length ? await query<any>(`SELECT t.*, u.full_name actor_name FROM trx_bill_posting_attempt t LEFT JOIN mst_user u ON u.id = t.actor_id
                                                         WHERE t.posting_id IN (?) ORDER BY t.id DESC`, [postings.map((p) => p.id)]) : [];
  const run = n((await queryOne<any>('SELECT MAX(run_no) m FROM trx_bill_match_result WHERE bill_id = ?', [id]))?.m);
  const matching = run ? await query<any>(`SELECT r.*, u.full_name overridden_by_name FROM trx_bill_match_result r LEFT JOIN mst_user u ON u.id = r.overridden_by
                                            WHERE r.bill_id = ? AND r.run_no = ? ORDER BY FIELD(r.severity, 'BLOCKING', 'WARNING', 'INFO', 'PASS'), r.id`, [id, run]) : [];
  const dup = await duplicateCandidates(cid, row.supplier_id, row.bill_no, id);
  const linkedEntries = new Set(links.filter((l) => !l.removed_at && l.link_type === 'SUPPLIER_BILL').map((l) => Number(l.target_id)));
  const uid = uidOf(req); const mc = await settingOn(cid, 'BT_MAKER_CHECKER');
  res.json({ data: {
    ...row, category,
    links: links.map((l) => ({ ...l, type_label: TARGETS[l.link_type as LinkType]?.label ?? l.link_type })),
    movements, approvals, followups, attachments, matching, match_run: run || null,
    postings: postings.map((p) => ({ ...p, attempts: attempts.filter((a) => a.posting_id === p.id) })),
    duplicates: dup.duplicates, suggestions: dup.bill_entries.filter((e: any) => !linkedEntries.has(Number(e.id)) && !e.linked_to),
    rights: {
      edit: EDIT_CODES.some((c) => can(req, c)), verify: can(req, 'BILL_TRACKER.VERIFY'), approve: can(req, 'BILL_TRACKER.APPROVE'),
      approve_high: can(req, 'BILL_TRACKER.APPROVE_HIGH'), post: can(req, 'BILL_TRACKER.POST'), own_entry: mc && Number(row.created_by) === uid,
    },
  } });
}));

const AUDIT_TABLES = ['trx_bill_tracker_link', 'trx_bill_movement', 'trx_bill_followup', 'trx_bill_posting', 'trx_bill_doc_attachment', 'trx_bill_match_result'];
billTrackerRouter.get('/bill-tracker/:id/audit', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  if (!(await queryOne('SELECT id FROM trx_bill_tracker WHERE id = ? AND company_id = ?', [id, cid]))) throw NotFound('Bill not found');
  const rows = await query<any>(
    `SELECT a.id, a.table_name, a.record_id, a.action, a.old_values, a.new_values, a.changed_at, a.ip_address, u.full_name changed_by_name
       FROM log_audit a LEFT JOIN mst_user u ON u.id = a.changed_by
      WHERE a.company_id = ? AND ((a.table_name = 'trx_bill_tracker' AND a.record_id = ?)
         OR (a.table_name IN (?) AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.new_values, '$.bill_id')) AS UNSIGNED) = ?))
      ORDER BY a.id DESC LIMIT 1000`, [cid, id, AUDIT_TABLES, id]);
  res.json({ data: rows });
}));

// ------------------------------------------------------------------ create / edit
billTrackerRouter.post('/bill-tracker', BT_EDIT, ah(async (req, res) => {
  const out = await createBill(req, req.body);
  res.status(201).json({ data: out.row, notices: out.notices.length ? out.notices : undefined, message: out.message });
}));

/** Registers a bill (from the bill screen, or from a document inward entry). */
export async function createBill(req: Request, raw: unknown) {
  const cid = cidOf(req); const uid = uidOf(req);
  const b = btSchema.parse(raw);
  if (b.received_from === 'VENDOR' && !b.supplier_id) throw BadRequest('Select the supplier the bill came from');
  if (b.received_from === 'DEPARTMENT' && !b.received_from_dept) throw BadRequest('Enter the department the bill came from');
  b.received_from_dept = b.received_from === 'DEPARTMENT' ? await masterDept(cid, b.received_from_dept) : null;
  b.cost_department = await masterDept(cid, b.cost_department);
  validateAmounts(b);
  await categoryOf(cid, b.bill_category);
  const dupe = await duplicateGate(cid, b, null);
  const notices: string[] = [];
  const id = await transaction(async (tx) => {
    let inward: any = null;
    if (b.inward_id) {
      inward = await txQueryOne<any>(tx, 'SELECT * FROM trx_document_inward WHERE id = ? AND company_id = ? FOR UPDATE', [b.inward_id, cid]);
      if (!inward || inward.status !== 'ACTIVE') throw BadRequest('The inward document is not found or not active');
    }
    const no = await nextDocNumber(tx, cid, 'BILL_TRACKER');
    const r = await txExecute(tx,
      `INSERT INTO trx_bill_tracker (company_id, entry_no, entry_date, received_from, received_from_dept, bill_no, normalized_bill_no, bill_date, supplier_id, purchase_or_process,
                                     amount, supplier_bill_id, grn_id, status, remarks, created_by, bill_category, inward_id, bill_qty, taxable_value, cgst_amount, sgst_amount,
                                     igst_amount, other_charges, round_off, currency_code, exchange_rate, cost_department, payment_due_date, duplicate_status, duplicate_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'RECEIVED',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.entry_date, b.received_from, b.received_from_dept, b.bill_no, normNo(b.bill_no), b.bill_date ?? null, b.supplier_id, b.purchase_or_process, r2(b.amount),
       b.remarks, uid, b.bill_category, b.inward_id, b.bill_qty, b.taxable_value === null ? null : r2(n(b.taxable_value)), r2(b.cgst_amount), r2(b.sgst_amount), r2(b.igst_amount),
       r2(b.other_charges), r2(b.round_off), b.currency_code, b.exchange_rate, b.cost_department, b.payment_due_date ?? null, dupe.status ?? 'NONE', dupe.note]);
    const billId = r.insertId as number;
    const bill = { id: billId, supplier_id: b.supplier_id, bill_category: b.bill_category };
    const from = b.received_from === 'DEPARTMENT' ? { holder: b.received_from_dept, user_id: null, dept: b.received_from_dept, location: null }
      : { holder: (await txQueryOne<any>(tx, 'SELECT party_name FROM mst_party WHERE id = ?', [b.supplier_id]))?.party_name ?? 'Vendor', user_id: null, dept: null, location: null };
    await addMovement(tx, cid, billId, uid, { movement_type: 'RECEIPT', from, to_holder: await userName(tx, uid), to_user_id: uid, to_dept: inward?.received_dept ?? null,
      to_location: 'Bill inward desk', purpose: 'Bill received', business_date: b.entry_date, inward_id: b.inward_id });
    if (b.inward_id) { const l = await addLink(tx, req, bill, { link_type: 'DOC_INWARD', target_id: b.inward_id, linked_amount: null, linked_qty: null, note: 'Registered from this inward document', allow_other_party: true }); if (l.notice) notices.push(l.notice); }
    if (b.supplier_bill_id) { const l = await addLink(tx, req, bill, { link_type: 'SUPPLIER_BILL', target_id: b.supplier_bill_id, linked_amount: null, linked_qty: null, note: null, allow_other_party: false }); if (l.notice) notices.push(l.notice); }
    if (b.grn_id) { const l = await addLink(tx, req, bill, { link_type: 'GRN', target_id: b.grn_id, linked_amount: null, linked_qty: null, note: null, allow_other_party: false }); if (l.notice) notices.push(l.notice); }
    await syncLegacyLinks(tx, billId);
    await evaluate(tx, cid, billId);
    if (dupe.status) {
      await logDecision(tx, cid, billId, uid, 'DUPLICATE', 'SUSPECTED', null, null, dupe.note, r2(b.amount));
      await ensureFollowup(tx, cid, billId, 'DUPLICATE', uid, `Auto: ${dupe.note}`, uid, 'HIGH');
    }
    if (b.inward_id) await refreshInward(tx, cid, b.inward_id);
    return billId;
  });
  const row = await btRow(cid, id);
  await audit(req, 'trx_bill_tracker', id, 'INSERT', undefined, row);
  if (dupe.d.bill_entries.length) notices.push(`Bills Inward has ${dupe.d.bill_entries.map((e: any) => e.bill_no).join(', ')} with this invoice no — link it under Documents & Links`);
  return { row, notices, message: `Bill ${b.bill_no} received (${row.entry_no})${dupe.status ? ' — marked as a suspected duplicate' : ''}` };
}

billTrackerRouter.put('/bill-tracker/:id', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const before = await queryOne<any>('SELECT * FROM trx_bill_tracker WHERE id = ? AND company_id = ?', [id, cid]);
  if (!before) throw NotFound('Bill not found');
  if (before.workflow_status !== 'OPEN' || before.status === 'CANCELLED') {
    throw BadRequest(`Bill ${before.bill_no} is ${String(before.workflow_status === 'OPEN' ? before.status : before.workflow_status).replace(/_/g, ' ').toLowerCase()} — it cannot be edited. Verified values are never overwritten: return it for correction first.`);
  }
  // fields the caller did not send keep their value (an older screen sends only the first set of fields)
  const keep: Record<string, unknown> = {};
  for (const k of ['bill_category', 'bill_qty', 'taxable_value', 'cgst_amount', 'sgst_amount', 'igst_amount', 'other_charges', 'round_off', 'currency_code', 'exchange_rate',
    'cost_department', 'payment_due_date', 'inward_id']) if (!(k in (req.body ?? {}))) keep[k] = before[k];
  const b = btSchema.parse({ ...keep, ...req.body });
  if (b.received_from === 'VENDOR' && !b.supplier_id) throw BadRequest('Select the supplier the bill came from');
  if (b.received_from === 'DEPARTMENT' && !b.received_from_dept) throw BadRequest('Enter the department the bill came from');
  b.received_from_dept = b.received_from === 'DEPARTMENT' ? await masterDept(cid, b.received_from_dept, before.received_from_dept) : null;
  b.cost_department = await masterDept(cid, b.cost_department, before.cost_department);
  validateAmounts(b);
  await categoryOf(cid, b.bill_category);
  const changedKey = Number(b.supplier_id ?? 0) !== Number(before.supplier_id ?? 0) || normNo(b.bill_no) !== before.normalized_bill_no;
  const dupe = changedKey ? await duplicateGate(cid, b, id) : { status: null, note: null, d: { duplicates: [], bill_entries: [] } };
  const notices: string[] = [];
  await transaction(async (tx) => {
    const cur = await lockBill(tx, cid, id, b.row_version);
    needWf(cur, ['OPEN'], 'edited');
    await txExecute(tx,
      `UPDATE trx_bill_tracker SET entry_date = ?, received_from = ?, received_from_dept = ?, bill_no = ?, normalized_bill_no = ?, bill_date = ?, supplier_id = ?, purchase_or_process = ?,
              amount = ?, remarks = ?, bill_category = ?, bill_qty = ?, taxable_value = ?, cgst_amount = ?, sgst_amount = ?, igst_amount = ?, other_charges = ?, round_off = ?,
              currency_code = ?, exchange_rate = ?, cost_department = ?, payment_due_date = ?,
              duplicate_status = IF(?, ?, duplicate_status), duplicate_note = IF(?, ?, duplicate_note), updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
      [b.entry_date, b.received_from, b.received_from_dept, b.bill_no, normNo(b.bill_no), b.bill_date ?? null, b.supplier_id, b.purchase_or_process, r2(b.amount), b.remarks,
       b.bill_category, b.bill_qty, b.taxable_value === null ? null : r2(n(b.taxable_value)), r2(b.cgst_amount), r2(b.sgst_amount), r2(b.igst_amount), r2(b.other_charges),
       r2(b.round_off), b.currency_code, b.exchange_rate, b.cost_department, b.payment_due_date ?? null,
       changedKey ? 1 : 0, dupe.status ?? 'NONE', changedKey ? 1 : 0, dupe.note, uidOf(req), id]);
    const bill = { ...cur, supplier_id: b.supplier_id, bill_category: b.bill_category };
    for (const [type, tid] of [['SUPPLIER_BILL', b.supplier_bill_id], ['GRN', b.grn_id]] as const) {
      if (!tid) continue;
      const has = await txQueryOne(tx, 'SELECT id FROM trx_bill_tracker_link WHERE bill_id = ? AND link_type = ? AND target_id = ? AND removed_at IS NULL', [id, type, tid]);
      if (!has) { const l = await addLink(tx, req, bill, { link_type: type, target_id: tid, linked_amount: null, linked_qty: null, note: null, allow_other_party: false }); if (l.notice) notices.push(l.notice); }
    }
    await syncLegacyLinks(tx, id);
    await touched(tx, cid, id);
    if (dupe.status) {
      await logDecision(tx, cid, id, uidOf(req), 'DUPLICATE', 'SUSPECTED', null, null, dupe.note, r2(b.amount));
      await ensureFollowup(tx, cid, id, 'DUPLICATE', uidOf(req), `Auto: ${dupe.note}`, uidOf(req), 'HIGH');
    }
  });
  const row = await btRow(cid, id);
  await audit(req, 'trx_bill_tracker', id, 'UPDATE', before, row);
  res.json({ data: row, notices: notices.length ? notices : undefined, message: `Bill ${b.bill_no} saved` });
}));

// ------------------------------------------------------------------ custody steps the client already uses (now also movement rows)
const STEPS = {
  handover: { from: ['RECEIVED', 'RECEIVED_BACK'], to: 'HANDED_OVER', schema: z.object({
    handed_over_to: z.string().trim().min(1, 'Enter who it was handed to').max(120), handover_department: z.string().trim().min(1, 'Enter the department').max(80),
    handover_date: dateStr.default(istToday), to_user_id: idOpt, purpose: strOpt(120), expected_return_date: dateStr.nullish(), to_location: strOpt(80) }) },
  'received-back': { from: ['HANDED_OVER'], to: 'RECEIVED_BACK', schema: z.object({ received_back_date: dateStr.default(istToday) }) },
  'submit-accounts': { from: ['RECEIVED', 'HANDED_OVER', 'RECEIVED_BACK'], to: 'SUBMITTED', schema: z.object({
    submitted_to_accounts_on: dateStr.default(istToday), accounts_recipient: z.string().trim().min(1, 'Enter the accounts person who received it').max(120), to_user_id: idOpt }) },
} as const;
const LEGACY_COLS = ['handed_over_to', 'handover_department', 'handover_date', 'received_back_date', 'submitted_to_accounts_on', 'accounts_recipient'];

for (const [step, cfg] of Object.entries(STEPS)) {
  billTrackerRouter.post(`/bill-tracker/:id/${step}`, BT_EDIT, ah(async (req, res) => {
    const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
    const b = cfg.schema.parse(req.body) as Record<string, any>;
    const pre = await queryOne<any>('SELECT * FROM trx_bill_tracker WHERE id = ? AND company_id = ?', [id, cid]);
    if (!pre) throw NotFound('Bill not found');
    if (!(cfg.from as readonly string[]).includes(pre.status))
      throw BadRequest(`Bill ${pre.bill_no} is ${pre.status.replace(/_/g, ' ').toLowerCase()} — it cannot be moved to ${cfg.to.replace(/_/g, ' ').toLowerCase()}`);
    if ('handover_department' in b) b.handover_department = (await masterDept(cid, b.handover_department))!;
    const dates = Object.entries(b).filter(([k, v]) => v && (k.endsWith('_date') || k.endsWith('_on')) && k !== 'expected_return_date');
    for (const [, d] of dates) {
      if (d < String(pre.entry_date).slice(0, 10)) throw BadRequest('The date cannot be before the bill receipt date');
      if (d > istToday()) throw BadRequest('The date cannot be in the future');
    }
    if (b.expected_return_date && b.expected_return_date < istToday()) throw BadRequest('The expected return date has already passed');
    const after = await transaction(async (tx) => {
      const cur = await lockBill(tx, cid, id);
      if (cur.status !== pre.status) throw Conflict('The bill was moved by someone else — reload');
      const cols = Object.keys(b).filter((c) => LEGACY_COLS.includes(c));
      await txExecute(tx, `UPDATE trx_bill_tracker SET ${cols.map((c) => `${c} = ?`).join(', ')}, status = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
        [...cols.map((c) => b[c]), cfg.to, uid, id]);
      const me = await userName(tx, uid);
      if (step === 'handover') {
        const toName = b.to_user_id ? (await userName(tx, b.to_user_id)) ?? b.handed_over_to : b.handed_over_to;
        await addMovement(tx, cid, id, uid, { movement_type: 'HANDOVER', to_holder: toName, to_user_id: b.to_user_id, to_dept: b.handover_department, to_location: b.to_location,
          purpose: b.purpose ?? 'Handed over to the department', business_date: b.handover_date, expected_return_date: b.expected_return_date ?? null });
      } else if (step === 'received-back') {
        await addMovement(tx, cid, id, uid, { movement_type: 'RETURN', to_holder: me, to_user_id: uid, to_location: 'Bill inward desk', purpose: 'Received back from the department', business_date: b.received_back_date });
      } else {
        await addMovement(tx, cid, id, uid, { movement_type: 'TO_ACCOUNTS', to_holder: b.to_user_id ? (await userName(tx, b.to_user_id)) ?? b.accounts_recipient : b.accounts_recipient,
          to_user_id: b.to_user_id, to_dept: 'Accounts', to_location: 'Accounts', purpose: 'Submitted to accounts for verification and posting', business_date: b.submitted_to_accounts_on });
        if (cur.workflow_status === 'OPEN') {
          await txExecute(tx, `UPDATE trx_bill_tracker SET workflow_status = 'PENDING_VERIFICATION', submitted_by = ?, submitted_at = NOW() WHERE id = ?`, [uid, id]);
          await logDecision(tx, cid, id, uid, 'SUBMIT', 'SUBMITTED', 'OPEN', 'PENDING_VERIFICATION', `Submitted to accounts (${b.accounts_recipient})`, n(cur.amount));
          await runMatching(tx, cid, id, uid);
        }
      }
      return b;
    });
    const row = await btRow(cid, id);
    await audit(req, 'trx_bill_tracker', id, 'UPDATE', { status: pre.status }, { status: cfg.to, ...after });
    res.json({ data: row, message: `Bill ${pre.bill_no}: ${cfg.to.replace(/_/g, ' ').toLowerCase()}` });
  }));
}

/** Any custody hand-off (person, department, or a digital queue). */
billTrackerRouter.post('/bill-tracker/:id/movements', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
  const b = z.object({ to_holder: strOpt(150), to_user_id: idOpt, to_dept: strOpt(80), to_location: strOpt(80), purpose: z.string().trim().min(2, 'Give the purpose').max(120),
    business_date: dateStr.default(istToday), expected_return_date: dateStr.nullish(), note: strOpt(255) }).parse(req.body);
  if (!b.to_holder && !b.to_user_id && !b.to_dept && !b.to_location) throw BadRequest('Say who / which department or queue the bill goes to');
  if (b.business_date > istToday()) throw BadRequest('The date cannot be in the future');
  if (b.expected_return_date && b.expected_return_date < istToday()) throw BadRequest('The expected return date has already passed');
  b.to_dept = await masterDept(cid, b.to_dept);
  const mid = await transaction(async (tx) => {
    const cur = await lockBill(tx, cid, id);
    if (b.business_date < String(cur.entry_date)) throw BadRequest('The date cannot be before the bill receipt date');
    const toName = b.to_user_id ? (await userName(tx, b.to_user_id)) : b.to_holder;
    if (b.to_user_id && !toName) throw BadRequest('User not found');
    return addMovement(tx, cid, id, uid, { movement_type: 'TRANSFER', to_holder: toName ?? b.to_dept ?? b.to_location, to_user_id: b.to_user_id, to_dept: b.to_dept,
      to_location: b.to_location, purpose: b.purpose, business_date: b.business_date, expected_return_date: b.expected_return_date ?? null, note: b.note });
  });
  await audit(req, 'trx_bill_movement', mid, 'INSERT', undefined, { ...b, bill_id: id });
  res.status(201).json({ data: await btRow(cid, id), message: 'Movement recorded' });
}));

/** A wrong hand-off is reversed by a new CORRECTION row — the earlier row stays as it was. */
billTrackerRouter.post('/bill-tracker/:id/movements/:mid/correct', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
  const mid = z.coerce.number().int().positive().parse(req.params.mid);
  const { reason } = reasonSchema.parse(req.body);
  const newId = await transaction(async (tx) => {
    const cur = await lockBill(tx, cid, id);
    const m = await txQueryOne<any>(tx, 'SELECT * FROM trx_bill_movement WHERE id = ? AND bill_id = ?', [mid, id]);
    if (!m) throw NotFound('Movement not found');
    const last = await txQueryOne<any>(tx, 'SELECT id FROM trx_bill_movement WHERE bill_id = ? ORDER BY seq DESC LIMIT 1', [id]);
    if (Number(last?.id) !== mid) throw BadRequest('Only the latest movement can be corrected');
    if (!['HANDOVER', 'RETURN', 'TRANSFER'].includes(m.movement_type))
      throw BadRequest(m.movement_type === 'TO_ACCOUNTS' ? 'A bill submitted to accounts is returned by accounts (Return for correction)' : 'This movement cannot be corrected');
    const legacy = m.movement_type === 'HANDOVER' && cur.status === 'HANDED_OVER' ? (cur.received_back_date ? 'RECEIVED_BACK' : 'RECEIVED')
      : m.movement_type === 'RETURN' && cur.status === 'RECEIVED_BACK' ? 'HANDED_OVER' : null;
    if (legacy) await txExecute(tx, 'UPDATE trx_bill_tracker SET status = ? WHERE id = ?', [legacy, id]);
    return addMovement(tx, cid, id, uid, { movement_type: 'CORRECTION', from: { holder: m.to_holder, user_id: m.to_user_id, dept: m.to_dept, location: m.to_location },
      to_holder: m.from_holder, to_user_id: m.from_user_id, to_dept: m.from_dept, to_location: m.from_location, purpose: `Correction of movement #${m.seq}`,
      business_date: istToday(), note: reason, corrects_movement_id: mid });
  });
  await audit(req, 'trx_bill_movement', newId, 'INSERT', undefined, { bill_id: id, corrects_movement_id: mid, reason });
  res.status(201).json({ data: await btRow(cid, id), message: 'Movement corrected (a correction entry was added)' });
}));

// ------------------------------------------------------------------ links
billTrackerRouter.post('/bill-tracker/:id/links', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const inp = linkSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const b = await lockBill(tx, cid, id);
    needWf(b, ['OPEN', 'PENDING_VERIFICATION'], 'linked to more documents (return it for correction first)');
    const l = await addLink(tx, req, b, inp);
    await syncLegacyLinks(tx, id);
    const ev = await touched(tx, cid, id);
    return { ...l, missing: ev.missing };
  });
  res.status(201).json({ data: await btRow(cid, id), notices: out.notice ? [out.notice] : undefined, message: `${TARGETS[inp.link_type].label} linked` });
}));

billTrackerRouter.post('/bill-tracker/:id/links/:lid/remove', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const lid = z.coerce.number().int().positive().parse(req.params.lid);
  const { reason } = reasonSchema.parse(req.body);
  const l = await transaction(async (tx) => {
    const b = await lockBill(tx, cid, id);
    needWf(b, ['OPEN', 'PENDING_VERIFICATION'], 'unlinked (return it for correction first)');
    const l = await txQueryOne<any>(tx, 'SELECT * FROM trx_bill_tracker_link WHERE id = ? AND bill_id = ? AND removed_at IS NULL', [lid, id]);
    if (!l) throw NotFound('Link not found');
    await txExecute(tx, 'UPDATE trx_bill_tracker_link SET removed_by = ?, removed_at = NOW(), remove_reason = ? WHERE id = ?', [uidOf(req), reason, lid]);
    await syncLegacyLinks(tx, id);
    await touched(tx, cid, id);
    if (l.link_type === 'DOC_INWARD') await refreshInward(tx, cid, Number(l.target_id));
    return l;
  });
  await audit(req, 'trx_bill_tracker_link', lid, 'UPDATE', { removed_at: null }, { bill_id: id, removed: true, reason, link_type: l.link_type, target_no: l.target_no });
  res.json({ data: await btRow(cid, id), message: `${TARGETS[l.link_type as LinkType]?.label ?? 'Link'} ${l.target_no} unlinked` });
}));

// ------------------------------------------------------------------ attachments on the bill
billTrackerRouter.post('/bill-tracker/:id/attachments', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const f = z.object({ filename: z.string().trim().min(1).max(255), data: z.string().min(1) }).parse(req.body);
  const out = await transaction(async (tx) => {
    const b = await lockBill(tx, cid, id);
    if (b.workflow_status === 'CANCELLED') throw BadRequest('The bill is cancelled');
    const a = await storeAttachment(tx, cid, uidOf(req), { bill_id: id }, f.filename, f.data);
    let flagged = false;
    if (a.duplicate) {
      const d = await txQueryOne<any>(tx, 'SELECT bill_id, inward_id FROM trx_bill_doc_attachment WHERE id = ?', [a.duplicate.id]);
      const ownInward = d?.inward_id && (Number(d.inward_id) === Number(b.inward_id ?? 0) ||
        !!(await txQueryOne(tx, `SELECT id FROM trx_bill_tracker_link WHERE bill_id = ? AND link_type = 'DOC_INWARD' AND target_id = ? AND removed_at IS NULL`, [id, d.inward_id])));
      if (!ownInward && Number(d?.bill_id ?? 0) !== id && b.duplicate_status !== 'CLEARED') {
        const note = `The same file is already on ${a.duplicate.where ?? 'another document'} (${a.duplicate.name})`;
        await txExecute(tx, `UPDATE trx_bill_tracker SET duplicate_status = 'SUSPECTED', duplicate_note = ?, row_version = row_version + 1 WHERE id = ?`, [note.slice(0, 255), id]);
        await logDecision(tx, cid, id, uidOf(req), 'DUPLICATE', 'SUSPECTED', null, null, note, n(b.amount));
        await ensureFollowup(tx, cid, id, 'DUPLICATE', uidOf(req), `Auto: ${note}`, uidOf(req), 'HIGH');
        flagged = true;
      }
    }
    await touched(tx, cid, id);
    return { ...a, flagged };
  });
  await audit(req, 'trx_bill_doc_attachment', out.id, 'INSERT', undefined, { bill_id: id, filename: f.filename, sha256: out.sha256, duplicate_of_id: out.duplicate?.id ?? null });
  res.status(201).json({ data: { id: out.id, sha256: out.sha256, duplicate: out.duplicate }, notices: out.duplicate ? [`Same file already uploaded on ${out.duplicate.where ?? 'another record'}${out.flagged ? ' — bill marked as a suspected duplicate' : ''}`] : undefined,
    message: 'File attached' });
}));

// ------------------------------------------------------------------ matching
billTrackerRouter.post('/bill-tracker/:id/match', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const out = await transaction(async (tx) => {
    const b = await lockBill(tx, cid, id);
    if (['CANCELLED', 'REVERSED'].includes(b.workflow_status)) throw BadRequest('The bill is closed');
    const m = await runMatching(tx, cid, id, uidOf(req));
    await afterMatch(tx, cid, b, m, uidOf(req));
    return m;
  });
  await audit(req, 'trx_bill_match_result', id, 'INSERT', undefined, { bill_id: id, run_no: out.run_no, match_status: out.match_status });
  const blocking = out.results.filter((r) => r.severity === 'BLOCKING').length;
  res.json({ data: await btRow(cid, id), match: out, message: `Matching: ${out.match_status.toLowerCase()}${blocking ? ` — ${blocking} blocking difference(s)` : ''}` });
}));

async function afterMatch(tx: Tx, cid: number, b: any, m: { match_status: string; results: any[] }, uid: number) {
  if (m.match_status === 'BLOCKED') {
    const why = m.results.filter((r) => r.severity === 'BLOCKING').map((r) => r.label).join('; ');
    await ensureFollowup(tx, cid, b.id, 'MISMATCH', b.holder_user_id ?? b.created_by, `Auto: matching — ${why}`, uid, 'HIGH');
  } else await autoClose(tx, b.id, 'MISMATCH', `Matching ${m.match_status.toLowerCase()} on re-run`, uid);
}

billTrackerRouter.post('/bill-tracker/:id/match-results/:rid/override', BT_APPROVE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const rid = z.coerce.number().int().positive().parse(req.params.rid);
  const { reason } = reasonSchema.parse(req.body);
  const status = await transaction(async (tx) => {
    const b = await lockBill(tx, cid, id);
    needWf(b, ['OPEN', 'PENDING_VERIFICATION', 'PENDING_APPROVAL'], 'overridden');
    if (await settingOn(cid, 'BT_MAKER_CHECKER') && Number(b.created_by) === uidOf(req)) throw Forbidden('You entered this bill — another approver must override its exceptions');
    const r = await txQueryOne<any>(tx, 'SELECT * FROM trx_bill_match_result WHERE id = ? AND bill_id = ?', [rid, id]);
    if (!r) throw NotFound('Matching result not found');
    const last = n((await txQueryOne<any>(tx, 'SELECT MAX(run_no) m FROM trx_bill_match_result WHERE bill_id = ?', [id]))?.m);
    if (Number(r.run_no) !== last) throw BadRequest('This result is from an older matching run — run matching again');
    if (r.severity !== 'BLOCKING' || r.result_status !== 'OPEN') throw BadRequest('Only an open blocking difference can be overridden');
    if (!OVERRIDABLE.has(r.rule_code)) throw BadRequest('This exception cannot be overridden — fix it (enter the data, link the document, clear the duplicate)');
    await txExecute(tx, `UPDATE trx_bill_match_result SET result_status = 'OVERRIDDEN', override_reason = ?, overridden_by = ?, overridden_at = NOW() WHERE id = ?`, [reason, uidOf(req), rid]);
    const st = await statusFromResults(tx, id, last);
    await txExecute(tx, 'UPDATE trx_bill_tracker SET match_status = ?, row_version = row_version + 1 WHERE id = ?', [st, id]);
    await logDecision(tx, cid, id, uidOf(req), 'OVERRIDE', 'OVERRIDDEN', null, null, `${r.label}: ${reason}`, n(b.amount));
    if (st !== 'BLOCKED') await autoClose(tx, id, 'MISMATCH', `Overridden: ${reason}`, uidOf(req));
    return st;
  });
  await audit(req, 'trx_bill_match_result', rid, 'UPDATE', { result_status: 'OPEN' }, { bill_id: id, result_status: 'OVERRIDDEN', reason });
  res.json({ data: await btRow(cid, id), message: `Exception overridden — matching ${status.toLowerCase()}` });
}));

billTrackerRouter.post('/bill-tracker/:id/duplicate/clear', BT_APPROVE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  await transaction(async (tx) => {
    const b = await lockBill(tx, cid, id);
    if (b.duplicate_status !== 'SUSPECTED') throw BadRequest('The bill is not marked as a suspected duplicate');
    if (await settingOn(cid, 'BT_MAKER_CHECKER') && Number(b.created_by) === uidOf(req)) throw Forbidden('You entered this bill — another approver must clear the duplicate');
    await txExecute(tx, `UPDATE trx_bill_tracker SET duplicate_status = 'CLEARED', duplicate_note = ?, match_status = 'NOT_RUN', row_version = row_version + 1 WHERE id = ?`,
      [`${b.duplicate_note ?? ''} · cleared: ${reason}`.slice(0, 255), id]);
    await logDecision(tx, cid, id, uidOf(req), 'DUPLICATE', 'CLEARED', null, null, reason, n(b.amount));
    await autoClose(tx, id, 'DUPLICATE', `Not a duplicate: ${reason}`, uidOf(req));
  });
  await audit(req, 'trx_bill_tracker', id, 'UPDATE', { duplicate_status: 'SUSPECTED' }, { duplicate_status: 'CLEARED', reason });
  res.json({ data: await btRow(cid, id), message: 'Duplicate cleared' });
}));

// ------------------------------------------------------------------ workflow: submit → verify → approve (maker-checker), return / reject / hold
const wfBody = z.object({ remarks: strOpt(500), reason: strOpt(500), row_version: rowVersion });

/** Gates before verification / approval / posting: required documents, matching without open blocking, no suspected duplicate. */
async function gates(tx: Tx, cid: number, b: any, uid: number) {
  const m = await runMatching(tx, cid, b.id, uid);
  await afterMatch(tx, cid, b, m, uid);
  const fresh = await txQueryOne<any>(tx, 'SELECT * FROM trx_bill_tracker WHERE id = ?', [b.id]);
  const fail: string[] = [];
  if (fresh.completeness_status !== 'COMPLETE') fail.push(`missing: ${missingLabel(fresh.missing_docs).join(', ')}`);
  if (fresh.duplicate_status === 'SUSPECTED') fail.push('suspected duplicate not cleared');
  if (m.match_status === 'BLOCKED') fail.push(`blocking differences: ${m.results.filter((r) => r.severity === 'BLOCKING').map((r) => r.label).join('; ')}`);
  return { fail, fresh, m };
}

async function transition(req: Request, opts: { from: string[]; to: string; stage: string; decision: string; action: string; needReason?: boolean;
  check?: (tx: Tx, b: any) => Promise<void>; sets?: string; params?: unknown[]; after?: (tx: Tx, b: any) => Promise<string | void> }) {
  const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
  const body = wfBody.parse(req.body ?? {});
  const text = body.reason ?? body.remarks ?? null;
  if (opts.needReason && (!text || text.length < 3)) throw BadRequest('Give a reason (at least 3 characters)');
  let extra: string | undefined; let from = '';
  await transaction(async (tx) => {
    const b = await lockBill(tx, cid, id, body.row_version);
    needWf(b, opts.from, opts.action);
    from = b.workflow_status;
    if (opts.check) await opts.check(tx, b);
    await txExecute(tx, `UPDATE trx_bill_tracker SET workflow_status = ?, ${opts.sets ? `${opts.sets}, ` : ''}updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
      [opts.to === '$HOLD_FROM' ? b.hold_from_status : opts.to, ...(opts.params ?? []).map((p) => (p === '$TEXT' ? text : p === '$FROM' ? b.workflow_status : p)), uid, id]);
    const to = opts.to === '$HOLD_FROM' ? b.hold_from_status : opts.to;
    await logDecision(tx, cid, id, uid, opts.stage, opts.decision, b.workflow_status, to, text, n(b.amount));
    if (opts.after) extra = (await opts.after(tx, b)) || undefined;
  });
  const row = await btRow(cid, id);
  await audit(req, 'trx_bill_tracker', id, 'UPDATE', { workflow_status: from }, { workflow_status: row.workflow_status, stage: opts.stage, comments: text });
  return { row, extra };
}

billTrackerRouter.post('/bill-tracker/:id/submit-verification', BT_EDIT, ah(async (req, res) => {
  const { row } = await transition(req, { from: ['OPEN'], to: 'PENDING_VERIFICATION', stage: 'SUBMIT', decision: 'SUBMITTED', action: 'submitted for verification',
    sets: 'submitted_by = ?, submitted_at = NOW()', params: [uidOf(req)],
    after: async (tx, b) => { await runMatching(tx, cidOf(req), b.id, uidOf(req)); } });
  res.json({ data: row, message: `Bill ${row.bill_no} submitted for verification` });
}));

billTrackerRouter.post('/bill-tracker/:id/verify', BT_VERIFY, ah(async (req, res) => {
  const cid = cidOf(req);
  const { row } = await transition(req, { from: ['PENDING_VERIFICATION'], to: 'PENDING_APPROVAL', stage: 'VERIFY', decision: 'VERIFIED', action: 'verified',
    sets: 'verified_by = ?, verified_at = NOW()', params: [uidOf(req)],
    check: async (tx, b) => {
      const g = await gates(tx, cid, b, uidOf(req));
      if (g.fail.length) throw BadRequest(`Bill ${b.bill_no} cannot be verified — ${g.fail.join(' · ')}`);
    } });
  res.json({ data: row, message: `Bill ${row.bill_no} verified — waiting for approval` });
}));

billTrackerRouter.post('/bill-tracker/:id/approve', BT_APPROVE, ah(async (req, res) => {
  const cid = cidOf(req); const uid = uidOf(req);
  const { row, extra } = await transition(req, { from: ['PENDING_APPROVAL'], to: 'APPROVED', stage: 'APPROVE', decision: 'APPROVED', action: 'approved',
    sets: 'approved_by = ?, approved_at = NOW()', params: [uid],
    check: async (tx, b) => {
      if (await settingOn(cid, 'BT_MAKER_CHECKER') && Number(b.created_by) === uid) throw Forbidden('You entered this bill — another user must approve it (maker-checker)');
      const cat = await categoryOf(cid, b.bill_category, tx);
      const base = r2(n(b.amount) * n(b.exchange_rate || 1));
      if (cat.high_value_limit > 0 && base > cat.high_value_limit && !can(req, 'BILL_TRACKER.APPROVE_HIGH'))
        throw Forbidden(`Bills above ₹${cat.high_value_limit.toFixed(2)} (${cat.category_name}) need BILL_TRACKER.APPROVE_HIGH`);
      const g = await gates(tx, cid, b, uid);
      if (g.fail.length) throw BadRequest(`Bill ${b.bill_no} cannot be approved — ${g.fail.join(' · ')}`);
    },
    after: async (tx, b) => {
      const fresh = await lockBill(tx, cid, b.id);
      const q = await enqueue(tx, req, fresh, true);
      await autoClose(tx, b.id, 'APPROVAL_DELAY', 'Approved', uid);
      return q.key;
    } });
  res.json({ data: row, message: `Bill ${row.bill_no} approved — queued for posting${extra ? ` (${extra})` : ''}` });
}));

billTrackerRouter.post('/bill-tracker/:id/return', VERIFY_OR_APPROVE, ah(async (req, res) => {
  const cid = cidOf(req);
  const { row } = await transition(req, { from: ['PENDING_VERIFICATION', 'PENDING_APPROVAL', 'APPROVED'], to: 'OPEN', stage: 'RETURN', decision: 'RETURNED', needReason: true,
    action: 'returned for correction', sets: `verified_by = NULL, verified_at = NULL, approved_by = NULL, approved_at = NULL, posting_status = 'NOT_ELIGIBLE'`,
    check: async (tx, b) => {
      if (b.workflow_status === 'APPROVED') {
        need(req, 'BILL_TRACKER.APPROVE');
        const p = await txQueryOne<any>(tx, `SELECT status FROM trx_bill_posting WHERE bill_id = ? AND status IN ('POSTING','POSTED') LIMIT 1`, [b.id]);
        if (p) throw BadRequest('The bill is already posted in accounts — it can only be reversed');
      }
    },
    after: async (tx, b) => {
      const open = await txQuery<any>(tx, `SELECT id, attempts FROM trx_bill_posting WHERE bill_id = ? AND status IN ('QUEUED','FAILED','UNKNOWN','RECON_REQUIRED')`, [b.id]);
      for (const p of open) {
        await txExecute(tx, `UPDATE trx_bill_posting SET status = 'CANCELLED', row_version = row_version + 1 WHERE id = ?`, [p.id]);
        await txExecute(tx, `INSERT INTO trx_bill_posting_attempt (posting_id, attempt_no, action, outcome, reason, actor_id) VALUES (?,?,?,?,?,?)`,
          [p.id, n(p.attempts), 'CANCEL', 'CANCELLED', 'Bill returned for correction', uidOf(req)]);
      }
      await ensureFollowup(tx, cid, b.id, 'DATA_COMPLETION', b.submitted_by ?? b.created_by, `Auto: returned for correction — ${String(req.body?.reason ?? req.body?.remarks ?? '')}`, uidOf(req));
    } });
  res.json({ data: row, message: `Bill ${row.bill_no} returned for correction` });
}));

billTrackerRouter.post('/bill-tracker/:id/reject', VERIFY_OR_APPROVE, ah(async (req, res) => {
  const { row } = await transition(req, { from: ['OPEN', 'PENDING_VERIFICATION', 'PENDING_APPROVAL', 'ON_HOLD'], to: 'REJECTED', stage: 'REJECT', decision: 'REJECTED',
    needReason: true, action: 'rejected', sets: 'reject_reason = ?', params: ['$TEXT'] });
  res.json({ data: row, message: `Bill ${row.bill_no} rejected` });
}));

billTrackerRouter.post('/bill-tracker/:id/hold', VERIFY_OR_APPROVE, ah(async (req, res) => {
  const { row } = await transition(req, { from: ['OPEN', 'PENDING_VERIFICATION', 'PENDING_APPROVAL'], to: 'ON_HOLD', stage: 'HOLD', decision: 'ON_HOLD', needReason: true,
    action: 'put on hold', sets: 'hold_reason = ?, hold_from_status = ?', params: ['$TEXT', '$FROM'] });
  res.json({ data: row, message: `Bill ${row.bill_no} on hold` });
}));

billTrackerRouter.post('/bill-tracker/:id/release', VERIFY_OR_APPROVE, ah(async (req, res) => {
  const { row } = await transition(req, { from: ['ON_HOLD'], to: '$HOLD_FROM', stage: 'RELEASE', decision: 'RELEASED', needReason: true, action: 'released',
    sets: 'hold_reason = NULL, hold_from_status = NULL' });
  res.json({ data: row, message: `Bill ${row.bill_no} released from hold` });
}));

billTrackerRouter.post('/bill-tracker/:id/reopen', BT_APPROVE, ah(async (req, res) => {
  const { row } = await transition(req, { from: ['REJECTED', 'REVERSED'], to: 'OPEN', stage: 'REOPEN', decision: 'REOPENED', needReason: true, action: 'reopened',
    sets: `reject_reason = NULL, verified_by = NULL, verified_at = NULL, approved_by = NULL, approved_at = NULL, posting_status = 'NOT_ELIGIBLE', match_status = 'NOT_RUN'` });
  res.json({ data: row, message: `Bill ${row.bill_no} reopened` });
}));

billTrackerRouter.post('/bill-tracker/:id/cancel', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const before = await queryOne<any>('SELECT * FROM trx_bill_tracker WHERE id = ? AND company_id = ?', [id, cid]);
  if (!before) throw NotFound('Bill not found');
  if (!['OPEN', 'REJECTED', 'ON_HOLD'].includes(before.workflow_status) || before.status === 'CANCELLED')
    throw BadRequest(`Bill ${before.bill_no} is ${String(before.workflow_status).replace(/_/g, ' ').toLowerCase()} — it cannot be cancelled${before.workflow_status === 'PENDING_VERIFICATION' ? ' (accounts can return it first)' : ''}. Nothing is ever deleted.`);
  await transaction(async (tx) => {
    await lockBill(tx, cid, id);
    await txExecute(tx, `UPDATE trx_bill_tracker SET status = 'CANCELLED', workflow_status = 'CANCELLED', cancel_reason = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?`, [reason, uidOf(req), id]);
    await logDecision(tx, cid, id, uidOf(req), 'CANCEL', 'CANCELLED', before.workflow_status, 'CANCELLED', reason, n(before.amount));
    await txExecute(tx, `UPDATE trx_bill_followup SET status = 'CANCELLED', resolution_note = 'Bill cancelled', closed_by = ?, closed_at = NOW() WHERE bill_id = ? AND status = 'OPEN'`, [uidOf(req), id]);
    for (const l of await txQuery<any>(tx, `SELECT target_id FROM trx_bill_tracker_link WHERE bill_id = ? AND link_type = 'DOC_INWARD' AND removed_at IS NULL`, [id])) await refreshInward(tx, cid, Number(l.target_id));
    if (before.inward_id) await refreshInward(tx, cid, Number(before.inward_id));
  });
  await audit(req, 'trx_bill_tracker', id, 'UPDATE', { status: before.status, workflow_status: before.workflow_status }, { status: 'CANCELLED', workflow_status: 'CANCELLED', reason });
  res.json({ data: await btRow(cid, id), message: `Bill ${before.bill_no} cancelled` });
}));

// ------------------------------------------------------------------ follow-ups of a bill
billTrackerRouter.post('/bill-tracker/:id/followups', BT_EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  if (!(await queryOne('SELECT id FROM trx_bill_tracker WHERE id = ? AND company_id = ?', [id, cid]))) throw NotFound('Bill not found');
  const fid = await createFollowup(req, { bill_id: id });
  res.status(201).json({ data: await queryOne<any>(`${FU_SQL} WHERE f.id = ?`, [fid]), message: 'Follow-up created' });
}));

// ================================================================== accounting posting (MANUAL adapter)
/** Idempotent: one live queue row per bill; a new posting version only after a cancelled / reversed one. */
async function enqueue(tx: Tx, req: Request, b: any, checked = false) {
  const cid = cidOf(req); const uid = uidOf(req);
  const live = await txQueryOne<any>(tx, `SELECT * FROM trx_bill_posting WHERE bill_id = ? AND status NOT IN ('CANCELLED','REVERSED') ORDER BY id DESC LIMIT 1`, [b.id]);
  if (live) return { created: false, id: Number(live.id), key: live.idempotency_key as string, status: live.status as string };
  if (b.workflow_status !== 'APPROVED') throw BadRequest(`Bill ${b.bill_no} is not approved — only approved bills go to accounting`);
  const g = checked ? { fail: [] as string[], fresh: b } : await gates(tx, cid, b, uid);
  const fail = [...g.fail];
  if (!g.fresh.supplier_id) fail.push('supplier missing');
  if (fail.length) throw BadRequest(`Bill ${b.bill_no} cannot be queued for posting — ${fail.join(' · ')}`);
  const ver = n((await txQueryOne<any>(tx, 'SELECT COUNT(*) c FROM trx_bill_posting WHERE bill_id = ?', [b.id]))?.c) + 1;
  const key = `BT-${cid}-${b.id}-V${ver}`;
  const adapter = await adapterFor(cid);
  const supplier = await txQueryOne<any>(tx, 'SELECT party_name, gstin, party_code FROM mst_party WHERE id = ?', [g.fresh.supplier_id]);
  const links = await txQuery<any>(tx, 'SELECT link_type, target_no, linked_qty, linked_amount FROM trx_bill_tracker_link WHERE bill_id = ? AND removed_at IS NULL', [b.id]);
  const f = g.fresh;
  const payload = {
    payload_version: 1, idempotency_key: key, company_id: cid, bill_tracking_no: f.entry_no, category: f.bill_category,
    supplier: { id: f.supplier_id, code: supplier?.party_code ?? null, name: supplier?.party_name ?? null, gstin: supplier?.gstin ?? null },
    invoice_no: f.bill_no, invoice_date: f.bill_date, received_date: f.entry_date, currency: f.currency_code, exchange_rate: n(f.exchange_rate),
    taxable_value: f.taxable_value === null ? null : n(f.taxable_value), cgst: n(f.cgst_amount), sgst: n(f.sgst_amount), igst: n(f.igst_amount),
    other_charges: n(f.other_charges), round_off: n(f.round_off), grand_total: n(f.amount), base_amount: r2(n(f.amount) * n(f.exchange_rate || 1)),
    cost_department: f.cost_department, payment_due_date: f.payment_due_date, links, approved_by: f.approved_by, approved_at: f.approved_at,
  };
  const r = await txExecute(tx,
    `INSERT INTO trx_bill_posting (company_id, bill_id, idempotency_key, adapter, payload_version, payload_json, payload_amount, status, next_attempt_at, created_by)
     VALUES (?,?,?,?,1,?,?,'QUEUED',NOW(),?)`, [cid, b.id, key, adapter.code, JSON.stringify(payload), r2(n(f.amount)), uid]);
  await txExecute(tx, `INSERT INTO trx_bill_posting_attempt (posting_id, attempt_no, action, outcome, actor_id) VALUES (?,0,'QUEUE','QUEUED',?)`, [r.insertId, uid]);
  await txExecute(tx, `UPDATE trx_bill_tracker SET posting_status = 'QUEUED', row_version = row_version + 1 WHERE id = ?`, [b.id]);
  await audit(req, 'trx_bill_posting', r.insertId, 'INSERT', undefined, { bill_id: b.id, idempotency_key: key, adapter: adapter.code }, tx);
  return { created: true, id: r.insertId as number, key, status: 'QUEUED' };
}

billTrackerRouter.get('/bill-tracker/:id/posting-status', BT_VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = await queryOne<any>('SELECT id, entry_no, posting_status, external_voucher_no, external_voucher_date FROM trx_bill_tracker WHERE id = ? AND company_id = ?', [id, cid]);
  if (!b) throw NotFound('Bill not found');
  const postings = await query<any>(`SELECT id, idempotency_key, adapter, status, attempts, external_voucher_id, external_voucher_no, external_voucher_date, posted_at, last_error_code,
                                            last_error_summary, reversal_voucher_no, created_at FROM trx_bill_posting WHERE bill_id = ? ORDER BY id DESC`, [id]);
  const attempts = postings.length ? await query<any>('SELECT * FROM trx_bill_posting_attempt WHERE posting_id IN (?) ORDER BY id DESC', [postings.map((p) => p.id)]) : [];
  res.json({ data: { ...b, adapter: (await adapterFor(cid)).code, postings: postings.map((p) => ({ ...p, attempts: attempts.filter((a) => a.posting_id === p.id) })) } });
}));

billTrackerRouter.post('/bill-tracker/:id/queue-posting', BT_POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const out = await transaction(async (tx) => enqueue(tx, req, await lockBill(tx, cid, id)));
  res.status(out.created ? 201 : 200).json({ data: { ...out, bill: await btRow(cid, id) }, message: out.created ? `Queued for posting (${out.key})` : `Already in the posting queue (${out.key}, ${out.status.toLowerCase()})` });
}));

async function livePosting(tx: Tx, billId: number, allowed: string[]) {
  const p = await txQueryOne<any>(tx, `SELECT * FROM trx_bill_posting WHERE bill_id = ? AND status NOT IN ('CANCELLED') ORDER BY id DESC LIMIT 1 FOR UPDATE`, [billId]);
  if (!p) throw BadRequest('The bill is not in the posting queue');
  if (!allowed.includes(p.status)) throw BadRequest(`The posting is ${p.status.toLowerCase()} — not possible now`);
  return p;
}

billTrackerRouter.post('/bill-tracker/:id/mark-posted', BT_POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
  const b = z.object({ voucher_no: z.string().trim().min(1, 'Enter the voucher no from the accounts package').max(60), voucher_date: dateStr, voucher_id: strOpt(80),
    remarks: strOpt(255) }).parse(req.body);
  if (b.voucher_date > istToday()) throw BadRequest('The voucher date cannot be in the future');
  const p = await transaction(async (tx) => {
    const bill = await lockBill(tx, cid, id);
    if (bill.workflow_status !== 'APPROVED') throw BadRequest('Only an approved bill can be posted');
    const p = await livePosting(tx, id, ['QUEUED', 'POSTING', 'UNKNOWN', 'FAILED']);
    const reused = await txQueryOne<any>(tx, `SELECT b.entry_no FROM trx_bill_posting x JOIN trx_bill_tracker b ON b.id = x.bill_id
                                              WHERE x.company_id = ? AND x.status = 'POSTED' AND x.external_voucher_no = ? AND x.bill_id <> ? LIMIT 1`, [cid, b.voucher_no, id]);
    if (reused) throw Conflict(`Voucher ${b.voucher_no} is already recorded for ${reused.entry_no} — check the voucher no`);
    if (b.voucher_date < String(bill.bill_date ?? bill.entry_date)) throw BadRequest('The voucher date cannot be before the invoice date');
    await txExecute(tx, `UPDATE trx_bill_posting SET status = 'POSTED', external_voucher_no = ?, external_voucher_date = ?, external_voucher_id = ?, posted_at = NOW(), posted_by = ?,
                                attempts = attempts + 1, response_code = 'MANUAL', response_summary = ?, last_error_code = NULL, last_error_summary = NULL, row_version = row_version + 1 WHERE id = ?`,
      [b.voucher_no, b.voucher_date, b.voucher_id, uid, b.remarks ?? 'Posted manually in the accounts package', p.id]);
    await txExecute(tx, `INSERT INTO trx_bill_posting_attempt (posting_id, attempt_no, action, outcome, voucher_no, reason, actor_id) VALUES (?,?,'MANUAL_POST','POSTED',?,?,?)`,
      [p.id, n(p.attempts) + 1, b.voucher_no, b.remarks, uid]);
    await txExecute(tx, `UPDATE trx_bill_tracker SET posting_status = 'POSTED', external_voucher_no = ?, external_voucher_date = ?, row_version = row_version + 1 WHERE id = ?`, [b.voucher_no, b.voucher_date, id]);
    await autoClose(tx, id, 'POSTING_FAILURE', `Posted as voucher ${b.voucher_no}`, uid);
    return p;
  });
  await audit(req, 'trx_bill_posting', p.id, 'UPDATE', { status: p.status }, { bill_id: id, status: 'POSTED', voucher_no: b.voucher_no, voucher_date: b.voucher_date });
  res.json({ data: await btRow(cid, id), message: `Posted — voucher ${b.voucher_no}` });
}));

billTrackerRouter.post('/bill-tracker/:id/mark-failed', BT_POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
  const b = z.object({ error: z.string().trim().min(3, 'Describe the error').max(500), error_code: strOpt(40), outcome: z.enum(['FAILED', 'UNKNOWN', 'RECON_REQUIRED']).default('FAILED') }).parse(req.body);
  const p = await transaction(async (tx) => {
    const bill = await lockBill(tx, cid, id);
    const p = await livePosting(tx, id, ['QUEUED', 'POSTING', 'UNKNOWN', ...(b.outcome === 'RECON_REQUIRED' ? ['POSTED'] : [])]);
    await txExecute(tx, `UPDATE trx_bill_posting SET status = ?, attempts = attempts + 1, last_error_code = ?, last_error_summary = ?, row_version = row_version + 1 WHERE id = ?`,
      [b.outcome, b.error_code ?? 'MANUAL', b.error, p.id]);
    await txExecute(tx, `INSERT INTO trx_bill_posting_attempt (posting_id, attempt_no, action, outcome, error_code, error_summary, actor_id) VALUES (?,?,'MARK_FAILED',?,?,?,?)`,
      [p.id, n(p.attempts) + 1, b.outcome, b.error_code ?? 'MANUAL', b.error, uid]);
    await txExecute(tx, 'UPDATE trx_bill_tracker SET posting_status = ?, row_version = row_version + 1 WHERE id = ?', [b.outcome, id]);
    await ensureFollowup(tx, cid, id, 'POSTING_FAILURE', uid, `Auto: posting ${b.outcome.toLowerCase().replace('_', ' ')} — ${b.error}`, uid, 'HIGH');
    void bill;
    return p;
  });
  await audit(req, 'trx_bill_posting', p.id, 'UPDATE', { status: p.status }, { bill_id: id, status: b.outcome, error: b.error });
  res.json({ data: await btRow(cid, id), message: `Posting marked ${b.outcome.toLowerCase().replace('_', ' ')}` });
}));

billTrackerRouter.post('/bill-tracker/:id/retry-posting', BT_POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
  const { reason } = reasonSchema.parse(req.body ?? {});
  const p = await transaction(async (tx) => {
    const bill = await lockBill(tx, cid, id);
    if (bill.workflow_status !== 'APPROVED') throw BadRequest('Only an approved bill can be posted');
    const p = await livePosting(tx, id, ['FAILED', 'UNKNOWN', 'RECON_REQUIRED']);
    const adapter = await adapterFor(cid);
    // an automatic connector is asked first whether the voucher already exists (timeout / unknown outcome) — never a blind resubmit
    const found = adapter.automatic ? await adapter.lookup(p.idempotency_key) : null;
    if (found?.outcome === 'POSTED') {
      await txExecute(tx, `UPDATE trx_bill_posting SET status = 'POSTED', external_voucher_no = ?, external_voucher_id = ?, posted_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [found.voucherNo ?? null, found.voucherId ?? null, p.id]);
      await txExecute(tx, `UPDATE trx_bill_tracker SET posting_status = 'POSTED', external_voucher_no = ? WHERE id = ?`, [found.voucherNo ?? null, id]);
    } else {
      await txExecute(tx, `UPDATE trx_bill_posting SET status = 'QUEUED', next_attempt_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [p.id]);
      await txExecute(tx, `UPDATE trx_bill_tracker SET posting_status = 'QUEUED', row_version = row_version + 1 WHERE id = ?`, [id]);
    }
    await txExecute(tx, `INSERT INTO trx_bill_posting_attempt (posting_id, attempt_no, action, outcome, reason, actor_id) VALUES (?,?,'RETRY',?,?,?)`,
      [p.id, n(p.attempts), found?.outcome === 'POSTED' ? 'POSTED' : 'QUEUED', reason, uid]);
    return p;
  });
  await audit(req, 'trx_bill_posting', p.id, 'UPDATE', { status: p.status }, { bill_id: id, status: 'QUEUED', retry_reason: reason });
  res.json({ data: await btRow(cid, id), message: 'Posting queued again' });
}));

billTrackerRouter.post('/bill-tracker/:id/reverse', BT_POST, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
  const b = z.object({ reason: z.string().trim().min(3, 'Give the reason').max(255), reversal_voucher_no: z.string().trim().min(1, 'Enter the reversal voucher no').max(60) }).parse(req.body);
  const p = await transaction(async (tx) => {
    const bill = await lockBill(tx, cid, id);
    const p = await livePosting(tx, id, ['POSTED', 'RECON_REQUIRED']);
    await txExecute(tx, `UPDATE trx_bill_posting SET status = 'REVERSED', reversal_voucher_no = ?, row_version = row_version + 1 WHERE id = ?`, [b.reversal_voucher_no, p.id]);
    await txExecute(tx, `INSERT INTO trx_bill_posting_attempt (posting_id, attempt_no, action, outcome, voucher_no, reason, actor_id) VALUES (?,?,'REVERSE','REVERSED',?,?,?)`,
      [p.id, n(p.attempts), b.reversal_voucher_no, b.reason, uid]);
    await txExecute(tx, `UPDATE trx_bill_tracker SET posting_status = 'REVERSED', workflow_status = 'REVERSED', row_version = row_version + 1 WHERE id = ?`, [id]);
    await logDecision(tx, cid, id, uid, 'REVERSE', 'REVERSED', bill.workflow_status, 'REVERSED', `${b.reason} (reversal voucher ${b.reversal_voucher_no})`, n(bill.amount));
    return p;
  });
  await audit(req, 'trx_bill_posting', p.id, 'UPDATE', { status: p.status }, { bill_id: id, status: 'REVERSED', ...b });
  res.json({ data: await btRow(cid, id), message: `Posting reversed (voucher ${b.reversal_voucher_no})` });
}));

// ================================================================== report (client's Excel columns)
billTrackerRouter.get('/reports/bill-tracker', requireAny('FINANCE.VIEW', 'PURCHASE.VIEW', 'REPORT.VIEW'), ah(async (req, res) => {
  const cid = cidOf(req); const q = listQ.parse(req.query); const today = istToday();
  const f = listFilter(cid, q, today);
  const rows = await query<any>(ROW_SQL(f.where) + ' ORDER BY b.entry_date, b.id LIMIT 5000', [today, ...f.params]);
  res.json({ data: rows.map((r, i) => ({ s_no: i + 1, ...decorate(r), days_pending: ['SUBMITTED', 'CANCELLED'].includes(r.status) ? null : Math.max(0, n(r.age_days)) })) });
}));

