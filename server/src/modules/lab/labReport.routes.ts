import { Router, type Request } from 'express';
import fs from 'fs';
import XLSX from 'xlsx';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { s } from '../resources/schemas.js';
import {
  P, reasonReq, idemKey, dateStr, cidOf, uidOf, idParam, hasPerm, n, nn, idemFrom, labAudit, notify, refreshRequestStatus, getReport, getTrial,
  writeFile, filePath, splitList,
} from './labCore.js';
import { createTrial } from './labTrial.routes.js';
import { renderLabReportPdf } from './labPdf.js';

/**
 * Lab reports and dual approval (spec §5, §6, §8.3):
 *   PENDING_LAB → (Lab In-charge) APPROVE → PENDING_QA → (QA Manager) APPROVE / CONDITIONAL → APPROVED → release → RELEASED
 *   either level: RETURN (trial back to COMPLETED, approvals void, resubmission = next revision) · REJECT · RETEST (new linked trial)
 * Each decision names the revision it was made on (stale revision → 409), is maker-checker checked (the person who
 * entered / submitted results cannot approve them, the Lab In-charge cannot also give the QA approval) unless an
 * audited LAB.OVERRIDE emergency override is used, and may carry an idempotency key. The snapshot never changes; a
 * change after final approval goes through /revise (new trial → next report revision; release supersedes the old one).
 */
export const labReportRouter = Router();
const VIEW = requirePermission(P.VIEW);

const REPORT_SQL = `
  SELECT rp.id, rp.company_id, rp.report_no, rp.revision_no, rp.request_id, rp.trial_id, rp.report_status, rp.overall_result, rp.disposition, rp.conditional_reason,
         rp.conditional_scope, rp.conditional_expiry, rp.recommendation, rp.revision_reason, rp.supersedes_report_id, rp.prepared_by, rp.prepared_at,
         rp.lab_approved_by, rp.lab_approved_at, rp.qa_approved_by, rp.qa_approved_at, rp.released_by, rp.released_at, rp.report_file_sha256, rp.snapshot_hash,
         rp.row_version, rp.created_at, r.request_no, r.priority, r.required_date, r.buyer_id, r.style_id, r.color_id, r.fabric_lot, r.so_id, r.buyer_po_no,
         b.party_name AS buyer_name, st.style_code, c.color_name, t.trial_no, t.trial_type, t.recipe_revision, t.technician_id,
         COALESCE(NULLIF(so.io_no, ''), so.so_no) AS job_no, pu.full_name AS prepared_by_name, lu.full_name AS lab_approved_by_name, qu.full_name AS qa_approved_by_name,
         DATEDIFF(CURDATE(), DATE(COALESCE(rp.lab_approved_at, rp.prepared_at))) AS age_days
    FROM trx_lab_report rp JOIN trx_lab_request r ON r.id = rp.request_id JOIN trx_lab_trial t ON t.id = rp.trial_id
    LEFT JOIN mst_party b ON b.id = r.buyer_id LEFT JOIN mst_style st ON st.id = r.style_id LEFT JOIN mst_color c ON c.id = r.color_id
    LEFT JOIN trx_sales_order so ON so.id = r.so_id LEFT JOIN mst_user pu ON pu.id = rp.prepared_by LEFT JOIN mst_user lu ON lu.id = rp.lab_approved_by
    LEFT JOIN mst_user qu ON qu.id = rp.qa_approved_by`;

function reportFilters(req: Request) {
  const q = z.object({
    status: z.string().trim().max(200).optional(), queue: z.enum(['lab', 'qa', 'release']).optional(), buyer_id: s.id(), style_id: s.id(), color_id: s.id(),
    result: z.enum(['PASS', 'FAIL', 'CONDITIONAL']).optional(), from: dateStr.optional(), to: dateStr.optional(), q: z.string().trim().max(60).optional(),
    latest: z.enum(['0', '1']).optional(),
  }).parse(req.query);
  const where = ['rp.company_id = ?']; const p: unknown[] = [cidOf(req)];
  if (q.status) { where.push('rp.report_status IN (?)'); p.push(splitList(q.status)); }
  if (q.queue === 'lab') where.push(`rp.report_status = 'PENDING_LAB'`);
  if (q.queue === 'qa') where.push(`rp.report_status = 'PENDING_QA'`);
  if (q.queue === 'release') where.push(`rp.report_status = 'APPROVED'`);
  for (const k of ['buyer_id', 'style_id', 'color_id'] as const) if (q[k]) { where.push(`r.${k} = ?`); p.push(q[k]); }
  if (q.result) { where.push('rp.overall_result = ?'); p.push(q.result); }
  if (q.from) { where.push('DATE(rp.prepared_at) >= ?'); p.push(q.from); }
  if (q.to) { where.push('DATE(rp.prepared_at) <= ?'); p.push(q.to); }
  if (q.q) { where.push('(rp.report_no LIKE ? OR r.request_no LIKE ? OR st.style_code LIKE ? OR b.party_name LIKE ? OR t.trial_no LIKE ?)'); for (let i = 0; i < 5; i++) p.push(`%${q.q}%`); }
  if (q.latest === '1') where.push('rp.revision_no = (SELECT MAX(x.revision_no) FROM trx_lab_report x WHERE x.company_id = rp.company_id AND x.report_no = rp.report_no)');
  return { where: where.join(' AND '), p };
}

labReportRouter.get('/reports', VIEW, ah(async (req, res) => {
  const f = reportFilters(req);
  res.json({ data: await query(`${REPORT_SQL} WHERE ${f.where} ORDER BY rp.id DESC LIMIT 500`, f.p) });
}));

/* ================================================================ Excel export (filters of the register) */
labReportRouter.get('/reports/export', VIEW, ah(async (req, res) => {
  const f = reportFilters(req);
  const rows = await query<any>(`${REPORT_SQL} WHERE ${f.where} ORDER BY rp.id DESC LIMIT 5000`, f.p);
  const ids = rows.map((r) => r.id);
  const snaps = ids.length ? await query<any>(`SELECT id, snapshot_json FROM trx_lab_report WHERE id IN (?)`, [ids]) : [];
  const d = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');
  const head = ['Report no', 'Rev', 'Status', 'Overall', 'Disposition', 'Lab request', 'Trial', 'Recipe rev', 'Buyer', 'Order', 'Buyer PO', 'Style', 'Colour', 'Lot',
    'Prepared', 'Prepared by', 'Lab approved', 'Lab In-charge', 'QA approved', 'QA Manager', 'Released'];
  const reg = [head, ...rows.map((r) => [r.report_no, r.revision_no, r.report_status, r.overall_result ?? '', r.disposition ?? '', r.request_no, r.trial_no, r.recipe_revision,
    r.buyer_name ?? '', r.job_no ?? '', r.buyer_po_no ?? '', r.style_code ?? '', r.color_name ?? '', r.fabric_lot ?? '', d(r.prepared_at), r.prepared_by_name ?? '',
    d(r.lab_approved_at), r.lab_approved_by_name ?? '', d(r.qa_approved_at), r.qa_approved_by_name ?? '', d(r.released_at)])];
  const resHead = ['Report no', 'Rev', 'Style', 'Colour', 'Parameter', 'Method', 'Unit', 'Acceptance', 'Mandatory', 'Before', 'After', 'Result', 'Full precision', 'Status', 'Override', 'Source'];
  const resRows: unknown[][] = [resHead];
  for (const r of rows) {
    const snap = JSON.parse(snaps.find((x) => x.id === r.id)?.snapshot_json ?? '{}');
    for (const x of snap.results ?? []) resRows.push([r.report_no, r.revision_no, r.style_code ?? '', r.color_name ?? '', x.name, x.method_code ?? '', x.unit ?? '', x.criteria_text ?? '',
      x.is_mandatory ? 'Y' : 'N', x.raw_before ?? '', x.raw_after ?? '', x.display_value ?? '', x.calculated_value ?? '', x.evaluation_status, x.is_override ? `Y: ${x.override_reason ?? ''}` : '',
      x.result_source === 'EXTERNAL' ? `${x.external_lab_name ?? ''} ${x.certificate_no ?? ''}` : 'Internal']);
  }
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(reg); ws1['!cols'] = head.map((h) => ({ wch: Math.max(10, h.length + 2) }));
  const ws2 = XLSX.utils.aoa_to_sheet(resRows); ws2['!cols'] = resHead.map((h, i) => ({ wch: i === 4 ? 40 : Math.max(10, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Lab reports');
  XLSX.utils.book_append_sheet(wb, ws2, 'Test results');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="lab-reports-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));

/* ================================================================ detail */
export async function reportDetail(cid: number, id: number) {
  const r = await queryOne<any>(`${REPORT_SQL} WHERE rp.id = ? AND rp.company_id = ?`, [id, cid]);
  if (!r) throw NotFound('Lab report not found');
  const raw = await queryOne<any>(`SELECT snapshot_json FROM trx_lab_report WHERE id = ?`, [id]);
  const [approvals, revisions, prodRefs] = await Promise.all([
    query<any>(`SELECT * FROM trx_lab_report_approval WHERE report_id = ? ORDER BY id`, [id]),
    query<any>(`SELECT id, revision_no, report_status, overall_result, prepared_at, released_at, revision_reason FROM trx_lab_report WHERE company_id = ? AND report_no = ? ORDER BY revision_no`, [cid, r.report_no]),
    query<any>(`SELECT pr.*, st.style_code, c.color_name, COALESCE(NULLIF(so.io_no, ''), so.so_no) AS job_no, au.full_name AS acknowledged_by_name, cu.full_name AS created_by_name
                  FROM trx_lab_production_ref pr LEFT JOIN mst_style st ON st.id = pr.style_id LEFT JOIN mst_color c ON c.id = pr.color_id
                  LEFT JOIN trx_sales_order so ON so.id = pr.so_id LEFT JOIN mst_user au ON au.id = pr.acknowledged_by LEFT JOIN mst_user cu ON cu.id = pr.created_by
                 WHERE pr.report_id = ? ORDER BY pr.id`, [id]),
  ]);
  const open = await queryOne<any>(`SELECT id, trial_no, status FROM trx_lab_trial WHERE revises_report_id = ? AND status NOT IN ('CANCELLED','APPROVED','REJECTED') ORDER BY id DESC LIMIT 1`, [id]);
  return { ...r, snapshot: JSON.parse(raw.snapshot_json), approvals, revisions, production_refs: prodRefs, open_revision_trial: open };
}
labReportRouter.get('/reports/:id', VIEW, ah(async (req, res) => { res.json({ data: await reportDetail(cidOf(req), idParam(req)) }); }));

/* ================================================================ decisions */
const decisionSchema = z.object({
  decision: z.enum(['APPROVE', 'RETURN', 'REJECT', 'RETEST', 'CONDITIONAL']), remarks: s.nullableStr(500), report_revision: z.coerce.number().int().min(1),
  override: z.coerce.boolean().default(false), idempotency_key: idemKey,
  conditional_reason: s.nullableStr(255), conditional_scope: s.nullableStr(255), conditional_expiry: dateStr.nullish(),
});
type Decision = z.infer<typeof decisionSchema>;

async function approverRoles(req: Request) { return (req.user!.roles ?? []).join(', ').slice(0, 255); }

/** People who produced the results of the trial (maker side). */
async function makers(tx: Tx, trialId: number) {
  const t = await txQueryOne<any>(tx, `SELECT submitted_by, results_by FROM trx_lab_trial WHERE id = ?`, [trialId]);
  const m = await txQuery<any>(tx, `SELECT DISTINCT measured_by FROM trx_lab_trial_measurement WHERE trial_id = ? AND measured_by IS NOT NULL`, [trialId]);
  return new Set([t?.submitted_by, t?.results_by, ...m.map((x) => x.measured_by)].filter(Boolean).map(Number));
}

/** Retest → a new linked trial (DRAFT, same sample, parent's recipe), keeping the old trial and report unchanged. */
async function retestTrial(req: Request, tx: Tx, trial: any, reason: string) {
  return createTrial(req, tx, { request_id: Number(trial.request_id), sample_id: nn(trial.sample_id), issue_qty: 0, trial_type: 'RETEST', parent_trial_id: Number(trial.id),
    technician_id: Number(trial.technician_id), machine_id: nn(trial.machine_id), planned_at: null, reason, remarks: null, wash_process_code: trial.wash_process_code ?? null, idempotency_key: null });
}

async function decide(req: Request, id: number, level: 'LAB' | 'QA', b: Decision) {
  const cid = cidOf(req); const uid = uidOf(req);
  const key = idemFrom(req, b);
  if (key) {
    const prior = await queryOne<any>(`SELECT * FROM trx_lab_report_approval WHERE company_id = ? AND idempotency_key = ?`, [cid, key]);
    if (prior) {
      if (Number(prior.report_id) !== id || prior.approval_level !== level) throw Conflict('This idempotency key was already used for another decision');
      return { replayed: true, new_trial: null as any, report: null as any, decision: prior.decision };
    }
  }
  if (['RETURN', 'REJECT', 'RETEST', 'CONDITIONAL'].includes(b.decision) && !(b.remarks ?? '').trim()) throw BadRequest('Remarks are required for this decision');
  if (b.decision === 'CONDITIONAL') {
    if (level !== 'QA') throw BadRequest('Conditional approval is a QA Manager decision');
    if (!hasPerm(req, P.OVERRIDE)) throw Forbidden('Conditional approval needs the LAB.OVERRIDE permission');
    if (!b.conditional_reason || !b.conditional_scope || !b.conditional_expiry) throw BadRequest('Conditional approval needs a reason, scope and expiry date');
    if (b.conditional_expiry <= new Date().toISOString().slice(0, 10)) throw BadRequest('The conditional expiry must be a future date');
  }
  if (b.override) {
    if (!hasPerm(req, P.OVERRIDE)) throw Forbidden('The maker-checker override needs the LAB.OVERRIDE permission');
    if ((b.remarks ?? '').trim().length < 10) throw BadRequest('Explain the emergency override in the remarks (10+ characters)');
  }
  return transaction(async (tx) => {
    const r = await getReport(cid, id, tx, true);
    const want = level === 'LAB' ? 'PENDING_LAB' : 'PENDING_QA';
    if (r.report_status !== want) {
      if (level === 'QA' && r.report_status === 'PENDING_LAB') throw Conflict('QA approval comes after the Lab In-charge approval');
      throw Conflict(`The report is ${r.report_status.toLowerCase().replace(/_/g, ' ')} — no ${level === 'LAB' ? 'lab' : 'QA'} decision is pending`);
    }
    if (b.report_revision !== Number(r.revision_no)) throw Conflict(`You are deciding revision ${b.report_revision} but the report is at revision ${r.revision_no} — reload`);
    const t = await getTrial(cid, Number(r.trial_id), tx, true);
    // maker-checker
    const mk = await makers(tx, Number(t.id));
    let overrideUsed = false;
    const conflict = level === 'LAB' ? mk.has(uid) : mk.has(uid) || Number(r.lab_approved_by) === uid;
    if (conflict) {
      if (!b.override) throw Forbidden(level === 'LAB' ? 'You entered or submitted these results — another Lab In-charge must review them'
        : 'QA approval must be independent: you entered these results or gave the lab approval');
      overrideUsed = true;
    }
    if (b.decision === 'APPROVE' && level === 'QA' && r.overall_result !== 'PASS')
      throw Conflict(`The overall result is ${r.overall_result ?? 'incomplete'} — reject, ask for a retest or give a conditional approval`);
    const me = await txQueryOne<any>(tx, `SELECT full_name FROM mst_user WHERE id = ?`, [uid]);
    await txExecute(tx,
      `INSERT INTO trx_lab_report_approval (company_id, report_id, approval_level, approver_user_id, approver_name, approver_roles, decision, remarks, report_revision, snapshot_hash, override_used, idempotency_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, id, level, uid, me?.full_name ?? null, await approverRoles(req), b.decision, b.remarks ?? null, r.revision_no, r.snapshot_hash, overrideUsed ? 1 : 0, key]);
    let newTrial: { id: number; trial_no: string } | null = null;
    const reqId = Number(r.request_id);
    switch (b.decision) {
      case 'APPROVE':
      case 'CONDITIONAL':
        if (level === 'LAB') {
          await txExecute(tx, `UPDATE trx_lab_report SET report_status = 'PENDING_QA', lab_approved_by = ?, lab_approved_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [uid, id]);
          await txExecute(tx, `UPDATE trx_lab_trial SET status = 'LAB_REVIEWED', lab_approved_by = ?, row_version = row_version + 1 WHERE id = ?`, [uid, t.id]);
        } else {
          const cond = b.decision === 'CONDITIONAL';
          await txExecute(tx, `UPDATE trx_lab_report SET report_status = 'APPROVED', disposition = ?, overall_result = IF(?, 'CONDITIONAL', overall_result),
                                 conditional_reason = ?, conditional_scope = ?, conditional_expiry = ?, qa_approved_by = ?, qa_approved_at = NOW(), row_version = row_version + 1 WHERE id = ?`,
            [cond ? 'CONDITIONAL' : 'APPROVED', cond ? 1 : 0, cond ? b.conditional_reason : null, cond ? b.conditional_scope : null, cond ? b.conditional_expiry : null, uid, id]);
          await txExecute(tx, `UPDATE trx_lab_trial SET status = 'APPROVED', row_version = row_version + 1 WHERE id = ?`, [t.id]);
        }
        break;
      case 'RETURN':
        // approvals of this revision become void; the trial reopens for correction and resubmission makes the next revision
        await txExecute(tx, `UPDATE trx_lab_report SET report_status = 'RETURNED', row_version = row_version + 1 WHERE id = ?`, [id]);
        await txExecute(tx, `UPDATE trx_lab_trial SET status = 'COMPLETED', submitted_at = NULL, lab_approved_by = NULL, row_version = row_version + 1 WHERE id = ?`, [t.id]);
        break;
      case 'REJECT':
        await txExecute(tx, `UPDATE trx_lab_report SET report_status = 'REJECTED', disposition = 'REJECTED', row_version = row_version + 1 WHERE id = ?`, [id]);
        await txExecute(tx, `UPDATE trx_lab_trial SET status = 'REJECTED', row_version = row_version + 1 WHERE id = ?`, [t.id]);
        break;
      case 'RETEST':
        await txExecute(tx, `UPDATE trx_lab_report SET report_status = 'RETEST_REQUIRED', disposition = 'RETEST_REQUIRED', row_version = row_version + 1 WHERE id = ?`, [id]);
        await txExecute(tx, `UPDATE trx_lab_trial SET status = 'RETEST_REQUIRED', row_version = row_version + 1 WHERE id = ?`, [t.id]);
        newTrial = await retestTrial(req, tx, t, b.remarks!);
        break;
      default: break;
    }
    await labAudit(req, tx, { request_id: reqId, entity_type: 'REPORT', entity_id: id, action: `${level}_${b.decision}`, before: { status: r.report_status },
      after: { revision: r.revision_no, hash: r.snapshot_hash, override: overrideUsed, new_trial: newTrial?.trial_no ?? null }, remarks: b.remarks ?? null });
    await refreshRequestStatus(tx, reqId);
    const rq = await txQueryOne<any>(tx, `SELECT request_no, requester_id FROM trx_lab_request WHERE id = ?`, [reqId]);
    return { replayed: false, new_trial: newTrial, report: r, trial: t, request: rq, decision: b.decision };
  });
}

function notifyDecision(req: Request, level: 'LAB' | 'QA', out: any) {
  if (out.replayed) return;
  const r = out.report; const t = out.trial; const rq = out.request;
  const tag = `${r.report_no} rev ${r.revision_no} (${rq.request_no} ${t.trial_no})`;
  if (out.decision === 'APPROVE' && level === 'LAB') void notify(req, { perms: [P.QA], title: `Lab approved ${tag} — QA approval pending`, body: 'Final QA review required', ref_type: 'LAB_REPORT', ref_id: Number(r.id) });
  else if (out.decision === 'RETURN') void notify(req, { userIds: [t.technician_id, t.submitted_by], title: `${tag} returned for correction`, body: 'See the report remarks', ref_type: 'LAB_REPORT', ref_id: Number(r.id) });
  else if (out.decision === 'RETEST') void notify(req, { userIds: [t.technician_id, rq.requester_id, r.lab_approved_by], perms: level === 'QA' ? [P.APPROVE] : [], title: `Retest required — ${tag}`, body: `New trial ${out.new_trial?.trial_no}`, ref_type: 'LAB_TRIAL', ref_id: out.new_trial?.id ?? Number(t.id) });
  else if (level === 'QA') void notify(req, { userIds: [rq.requester_id, r.lab_approved_by], title: `QA ${out.decision === 'REJECT' ? 'rejected' : 'approved'} ${tag}`, body: out.decision, ref_type: 'LAB_REPORT', ref_id: Number(r.id) });
  else if (out.decision === 'REJECT') void notify(req, { userIds: [rq.requester_id, t.technician_id], title: `Lab rejected ${tag}`, body: 'Rejected at lab review', ref_type: 'LAB_REPORT', ref_id: Number(r.id) });
}

labReportRouter.post('/reports/:id/lab-approve', requirePermission(P.APPROVE), ah(async (req, res) => {
  const id = idParam(req);
  const b = decisionSchema.parse(req.body ?? {});
  if (b.decision === 'CONDITIONAL') throw BadRequest('Conditional approval is a QA Manager decision');
  const out = await decide(req, id, 'LAB', b);
  notifyDecision(req, 'LAB', out);
  res.json({ data: { ...(await reportDetail(cidOf(req), id)), new_trial: out.new_trial, replayed: out.replayed } });
}));
labReportRouter.post('/reports/:id/qa-approve', requirePermission(P.QA), ah(async (req, res) => {
  const id = idParam(req);
  const b = decisionSchema.parse(req.body ?? {});
  const out = await decide(req, id, 'QA', b);
  notifyDecision(req, 'QA', out);
  res.json({ data: { ...(await reportDetail(cidOf(req), id)), new_trial: out.new_trial, replayed: out.replayed } });
}));
/** Return / retest at whichever level is pending (convenience endpoints from the spec). */
for (const [path, decision] of [['return', 'RETURN'], ['retest', 'RETEST']] as const) {
  labReportRouter.post(`/reports/:id/${path}`, requireAny(P.APPROVE, P.QA), ah(async (req, res) => {
    const id = idParam(req);
    const r = await getReport(cidOf(req), id);
    const level = r.report_status === 'PENDING_QA' ? 'QA' : 'LAB';
    if (!hasPerm(req, level === 'QA' ? P.QA : P.APPROVE)) throw Forbidden(`Missing required permission: ${level === 'QA' ? P.QA : P.APPROVE}`);
    const b = decisionSchema.parse({ ...(req.body ?? {}), decision, report_revision: req.body?.report_revision ?? r.revision_no });
    const out = await decide(req, id, level, b);
    notifyDecision(req, level, out);
    res.json({ data: { ...(await reportDetail(cidOf(req), id)), new_trial: out.new_trial, replayed: out.replayed } });
  }));
}

/* ================================================================ PDF */
async function pdfFor(cid: number, id: number) {
  const d = await reportDetail(cid, id);
  const images: { caption: string; path: string; mime: string }[] = [];
  const atts = (d.snapshot.attachments ?? []).filter((a: any) => /^image\/(png|jpeg)$/.test(a.mime_type));
  for (const a of atts.slice(0, 6)) {
    const row = await queryOne<any>(`SELECT storage_key FROM trx_lab_attachment WHERE id = ? AND company_id = ?`, [a.id, cid]);
    if (row) { const p = filePath(row.storage_key); if (fs.existsSync(p)) images.push({ caption: a.caption || String(a.attachment_type).replace(/_/g, ' '), path: p, mime: a.mime_type }); }
  }
  return { d, pdf: await renderLabReportPdf({ report: d, snapshot: d.snapshot, approvals: d.approvals, images }) };
}

labReportRouter.get('/reports/:id/pdf', VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const r = await getReport(cid, id);
  let buf: Buffer;
  if (r.report_status === 'RELEASED' || r.report_status === 'SUPERSEDED') {
    // a released revision is served from its stored file (byte-identical every time)
    if (!r.report_file_key) throw NotFound('The released PDF is missing');
    const p = filePath(r.report_file_key);
    if (!fs.existsSync(p)) throw NotFound('The released PDF is missing on the server');
    buf = fs.readFileSync(p);
  } else buf = (await pdfFor(cid, id)).pdf;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${r.report_no}-rev${r.revision_no}.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buf);
}));

/* ================================================================ release / supersede */
labReportRouter.post('/reports/:id/release', requirePermission(P.QA), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ remarks: s.nullableStr(500), idempotency_key: idemKey }).parse(req.body ?? {});
  const cur = await getReport(cid, id);
  if (cur.report_status === 'RELEASED') { res.json({ data: await reportDetail(cid, id), replayed: true }); return; }
  if (cur.report_status !== 'APPROVED') throw Conflict('Only a report with both approvals can be released');
  const { pdf } = await pdfFor(cid, id); // generated before the status flips — content comes only from the frozen snapshot
  const f = writeFile(cid, pdf, '.pdf', 'application/pdf');
  const out = await transaction(async (tx) => {
    const r = await getReport(cid, id, tx, true);
    if (r.report_status !== 'APPROVED') throw Conflict('Only a report with both approvals can be released');
    const lab = await txQueryOne<any>(tx, `SELECT id FROM trx_lab_report_approval WHERE report_id = ? AND approval_level = 'LAB' AND decision = 'APPROVE' AND report_revision = ?`, [id, r.revision_no]);
    const qa = await txQueryOne<any>(tx, `SELECT id FROM trx_lab_report_approval WHERE report_id = ? AND approval_level = 'QA' AND decision IN ('APPROVE','CONDITIONAL') AND report_revision = ?`, [id, r.revision_no]);
    if (!lab || !qa) throw Conflict('Both approvals of this revision are required');
    await txExecute(tx, `UPDATE trx_lab_report SET report_status = 'RELEASED', released_by = ?, released_at = NOW(), report_file_key = ?, report_file_sha256 = ?, row_version = row_version + 1 WHERE id = ?`,
      [uidOf(req), f.key, f.sha256, id]);
    const sup = await txQuery<any>(tx, `SELECT id FROM trx_lab_report WHERE company_id = ? AND report_no = ? AND revision_no < ? AND report_status IN ('RELEASED','APPROVED')`, [cid, r.report_no, r.revision_no]);
    if (sup.length) {
      await txQuery(tx, `UPDATE trx_lab_report SET report_status = 'SUPERSEDED', row_version = row_version + 1 WHERE id IN (?)`, [sup.map((x) => x.id)]);
      await txQuery(tx, `UPDATE trx_lab_production_ref SET status = 'REVOKED', revoked_by = ?, revoked_at = NOW(), revoke_reason = ? WHERE report_id IN (?) AND status = 'ACTIVE'`,
        [uidOf(req), `Superseded by ${r.report_no} rev ${r.revision_no}`, sup.map((x) => x.id)]);
    }
    const me = await txQueryOne<any>(tx, `SELECT full_name FROM mst_user WHERE id = ?`, [uidOf(req)]);
    await txExecute(tx, `INSERT INTO trx_lab_report_approval (company_id, report_id, approval_level, approver_user_id, approver_name, approver_roles, decision, remarks, report_revision, snapshot_hash, idempotency_key)
                         VALUES (?,?,'RELEASE',?,?,?,'RELEASE',?,?,?,?)`, [cid, id, uidOf(req), me?.full_name ?? null, await approverRoles(req), b.remarks ?? null, r.revision_no, r.snapshot_hash, idemFrom(req, b)]);
    await labAudit(req, tx, { request_id: Number(r.request_id), entity_type: 'REPORT', entity_id: id, action: 'RELEASE', after: { pdf_sha256: f.sha256, superseded: sup.map((x) => x.id) }, remarks: b.remarks ?? null });
    const rq = await txQueryOne<any>(tx, `SELECT requester_id, request_no FROM trx_lab_request WHERE id = ?`, [r.request_id]);
    return { r, rq };
  });
  void notify(req, { userIds: [out.rq?.requester_id], perms: ['PRODUCTION.VIEW'], title: `Approved lab report ${out.r.report_no} rev ${out.r.revision_no} released`,
    body: `Lab request ${out.rq?.request_no} — approved recipe / report reference`, ref_type: 'LAB_REPORT', ref_id: id });
  res.json({ data: await reportDetail(cid, id) });
}));

/** A change after final approval: new trial (copy of the approved recipe + readings) → next report revision on submit. */
labReportRouter.post('/reports/:id/revise', requirePermission(P.UPDATE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ reason: reasonReq, technician_id: s.id() }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const r = await getReport(cid, id, tx, true);
    if (!['APPROVED', 'RELEASED'].includes(r.report_status)) throw Conflict('Only an approved / released report is revised — otherwise use return or retest');
    const newer = await txQueryOne<any>(tx, `SELECT revision_no FROM trx_lab_report WHERE company_id = ? AND report_no = ? AND revision_no > ? LIMIT 1`, [cid, r.report_no, r.revision_no]);
    if (newer) throw Conflict(`Revision ${newer.revision_no} already exists — revise the latest revision`);
    const open = await txQueryOne<any>(tx, `SELECT trial_no FROM trx_lab_trial WHERE revises_report_id = ? AND status NOT IN ('CANCELLED','APPROVED','REJECTED') LIMIT 1`, [id]);
    if (open) throw Conflict(`${open.trial_no} is already revising this report`);
    const t = await getTrial(cid, Number(r.trial_id), tx);
    const nt = await createTrial(req, tx, { request_id: Number(r.request_id), sample_id: nn(t.sample_id), issue_qty: 0, trial_type: 'RECIPE_REVISION', parent_trial_id: Number(t.id),
      technician_id: b.technician_id ?? Number(t.technician_id), machine_id: nn(t.machine_id), planned_at: null, reason: b.reason, remarks: `Revision of ${r.report_no} rev ${r.revision_no}`,
      wash_process_code: t.wash_process_code ?? null, idempotency_key: null, revises_report_id: id, copy_measurements_from: Number(t.id) });
    await labAudit(req, tx, { request_id: Number(r.request_id), entity_type: 'REPORT', entity_id: id, action: 'REVISE', after: { trial: nt.trial_no }, remarks: b.reason });
    return nt;
  });
  res.status(201).json({ data: { trial_id: out.id, trial_no: out.trial_no } });
}));

/* ================================================================ production reference (controlled link, spec §6) */
labReportRouter.post('/reports/:id/production-reference', requirePermission(P.QA), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ so_id: s.id(), style_id: s.id(), color_id: s.id(), buyer_po_no: s.nullableStr(60), fabric_lot: s.nullableStr(60), process_code: s.nullableStr(30),
    valid_from: dateStr.nullish(), valid_to: dateStr.nullish(), remarks: s.nullableStr(255) }).parse(req.body ?? {});
  if (b.valid_from && b.valid_to && b.valid_to < b.valid_from) throw BadRequest('Valid to is before valid from');
  const r = await getReport(cid, id);
  if (!['APPROVED', 'RELEASED'].includes(r.report_status)) throw Conflict('Only a final QA-approved report can be a production reference');
  const rq = await queryOne<any>(`SELECT * FROM trx_lab_request WHERE id = ?`, [r.request_id]);
  const so = b.so_id ?? nn(rq.so_id); const style = b.style_id ?? nn(rq.style_id); const color = b.color_id ?? nn(rq.color_id);
  if (so && !(await queryOne(`SELECT id FROM trx_sales_order WHERE id = ? AND company_id = ?`, [so, cid]))) throw BadRequest('Order not found');
  if (style && !(await queryOne(`SELECT id FROM mst_style WHERE id = ? AND company_id = ?`, [style, cid]))) throw BadRequest('Style not found');
  if (color && !(await queryOne(`SELECT id FROM mst_color WHERE id = ? AND company_id = ?`, [color, cid]))) throw BadRequest('Colour not found');
  if (so && style && !(await queryOne(`SELECT id FROM trx_sales_order_line WHERE so_id = ? AND style_id = ? LIMIT 1`, [so, style]))) throw BadRequest('The style is not on this order');
  const expiry = r.disposition === 'CONDITIONAL' ? String(r.conditional_expiry ?? '').slice(0, 10) : null;
  const validTo = expiry && (!b.valid_to || b.valid_to > expiry) ? expiry : b.valid_to ?? null; // a conditional approval cannot be referenced past its expiry
  const ins = await transaction(async (tx) => {
    const x = await txExecute(tx, `INSERT INTO trx_lab_production_ref (company_id, report_id, so_id, buyer_po_no, style_id, color_id, fabric_lot, process_code, valid_from, valid_to, remarks, created_by)
                                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, id, so, b.buyer_po_no ?? rq.buyer_po_no ?? null, style, color, b.fabric_lot ?? rq.fabric_lot ?? null, b.process_code ?? null, b.valid_from ?? null, validTo, b.remarks ?? null, uidOf(req)]);
    await labAudit(req, tx, { request_id: Number(r.request_id), entity_type: 'PRODUCTION_REF', entity_id: Number(x.insertId), action: 'CREATE', after: { report_id: id, so, style, color, valid_to: validTo } });
    return Number(x.insertId);
  });
  res.status(201).json({ data: { id: ins, ...(await reportDetail(cid, id)) } });
}));

labReportRouter.get('/production-references', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ style_id: s.id(), color_id: s.id(), so_id: s.id(), status: z.enum(['ACTIVE', 'REVOKED']).optional() }).parse(req.query);
  const where = ['pr.company_id = ?']; const p: unknown[] = [cid];
  for (const k of ['style_id', 'color_id', 'so_id'] as const) if (q[k]) { where.push(`pr.${k} = ?`); p.push(q[k]); }
  if (q.status) { where.push('pr.status = ?'); p.push(q.status); }
  const rows = await query<any>(
    `SELECT pr.*, rp.report_no, rp.revision_no, rp.report_status, rp.overall_result, rp.disposition, st.style_code, c.color_name, COALESCE(NULLIF(so.io_no, ''), so.so_no) AS job_no,
            au.full_name AS acknowledged_by_name, (pr.status = 'ACTIVE' AND (pr.valid_to IS NULL OR pr.valid_to >= CURDATE()) AND (pr.valid_from IS NULL OR pr.valid_from <= CURDATE())) AS is_valid
       FROM trx_lab_production_ref pr JOIN trx_lab_report rp ON rp.id = pr.report_id LEFT JOIN mst_style st ON st.id = pr.style_id LEFT JOIN mst_color c ON c.id = pr.color_id
       LEFT JOIN trx_sales_order so ON so.id = pr.so_id LEFT JOIN mst_user au ON au.id = pr.acknowledged_by
      WHERE ${where.join(' AND ')} ORDER BY pr.style_id, pr.color_id, rp.report_no, rp.revision_no DESC, pr.id DESC LIMIT 1000`, p);
  res.json({ data: rows });
}));

labReportRouter.post('/production-references/:id/acknowledge', VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  await transaction(async (tx) => {
    const x = await txQueryOne<any>(tx, `SELECT pr.*, rp.request_id FROM trx_lab_production_ref pr JOIN trx_lab_report rp ON rp.id = pr.report_id WHERE pr.id = ? AND pr.company_id = ? FOR UPDATE`, [id, cid]);
    if (!x) throw NotFound('Production reference not found');
    if (x.status !== 'ACTIVE') throw Conflict('The reference is revoked');
    if (x.acknowledged_at) throw Conflict('Already acknowledged');
    await txExecute(tx, `UPDATE trx_lab_production_ref SET acknowledged_by = ?, acknowledged_at = NOW() WHERE id = ?`, [uidOf(req), id]);
    await labAudit(req, tx, { request_id: Number(x.request_id), entity_type: 'PRODUCTION_REF', entity_id: id, action: 'ACKNOWLEDGE' });
  });
  res.json({ data: { id, acknowledged: true } });
}));
labReportRouter.post('/production-references/:id/revoke', requirePermission(P.QA), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ reason: reasonReq }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const x = await txQueryOne<any>(tx, `SELECT pr.*, rp.request_id FROM trx_lab_production_ref pr JOIN trx_lab_report rp ON rp.id = pr.report_id WHERE pr.id = ? AND pr.company_id = ? FOR UPDATE`, [id, cid]);
    if (!x) throw NotFound('Production reference not found');
    if (x.status !== 'ACTIVE') throw Conflict('Already revoked');
    await txExecute(tx, `UPDATE trx_lab_production_ref SET status = 'REVOKED', revoked_by = ?, revoked_at = NOW(), revoke_reason = ? WHERE id = ?`, [uidOf(req), b.reason, id]);
    await labAudit(req, tx, { request_id: Number(x.request_id), entity_type: 'PRODUCTION_REF', entity_id: id, action: 'REVOKE', remarks: b.reason });
  });
  res.json({ data: { id, revoked: true } });
}));

/* ================================================================ dashboard */
labReportRouter.get('/dashboard/summary', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const one = async (sql: string, p: unknown[] = []) => n((await queryOne<any>(sql, [cid, ...p]))?.c);
  const [openReq, pendingInward, awaitingTest, inProgress, labPending, qaPending, retest, failed, approvedMonth, approvedToday, overdue] = await Promise.all([
    one(`SELECT COUNT(*) c FROM trx_lab_request WHERE company_id = ? AND status NOT IN ('DRAFT','APPROVED','REJECTED','CANCELLED','CLOSED')`),
    one(`SELECT COUNT(*) c FROM trx_lab_request WHERE company_id = ? AND status = 'SUBMITTED'`),
    one(`SELECT COUNT(*) c FROM trx_lab_request WHERE company_id = ? AND status = 'SAMPLE_RECEIVED'`),
    one(`SELECT COUNT(*) c FROM trx_lab_trial WHERE company_id = ? AND status IN ('IN_PROGRESS','COMPLETED')`),
    one(`SELECT COUNT(*) c FROM trx_lab_report WHERE company_id = ? AND report_status = 'PENDING_LAB'`),
    one(`SELECT COUNT(*) c FROM trx_lab_report WHERE company_id = ? AND report_status = 'PENDING_QA'`),
    one(`SELECT COUNT(*) c FROM trx_lab_trial t WHERE t.company_id = ? AND t.trial_type = 'RETEST' AND t.status IN ('DRAFT','PLANNED','IN_PROGRESS','COMPLETED')`),
    one(`SELECT COUNT(*) c FROM trx_lab_trial WHERE company_id = ? AND overall_result = 'FAIL' AND submitted_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`),
    one(`SELECT COUNT(*) c FROM trx_lab_report WHERE company_id = ? AND report_status IN ('APPROVED','RELEASED','SUPERSEDED') AND qa_approved_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`),
    one(`SELECT COUNT(*) c FROM trx_lab_report WHERE company_id = ? AND report_status IN ('APPROVED','RELEASED','SUPERSEDED') AND DATE(qa_approved_at) = CURDATE()`),
    one(`SELECT COUNT(*) c FROM trx_lab_request WHERE company_id = ? AND required_date < CURDATE() AND status NOT IN ('DRAFT','APPROVED','REJECTED','CANCELLED','CLOSED')`),
  ]);
  const ageing = await query<any>(
    `SELECT report_status AS stage,
            SUM(DATEDIFF(CURDATE(), DATE(COALESCE(lab_approved_at, prepared_at))) <= 1) AS d0_1,
            SUM(DATEDIFF(CURDATE(), DATE(COALESCE(lab_approved_at, prepared_at))) BETWEEN 2 AND 3) AS d2_3,
            SUM(DATEDIFF(CURDATE(), DATE(COALESCE(lab_approved_at, prepared_at))) BETWEEN 4 AND 7) AS d4_7,
            SUM(DATEDIFF(CURDATE(), DATE(COALESCE(lab_approved_at, prepared_at))) > 7) AS d8
       FROM trx_lab_report WHERE company_id = ? AND report_status IN ('PENDING_LAB','PENDING_QA') GROUP BY report_status`, [cid]);
  const failures = await query<any>(
    `SELECT p.code, p.name, COUNT(*) AS fails FROM trx_lab_trial_result rs JOIN trx_lab_trial t ON t.id = rs.trial_id JOIN mst_lab_test_parameter p ON p.id = rs.parameter_id
      WHERE t.company_id = ? AND rs.evaluation_status = 'FAIL' AND t.submitted_at >= CURDATE() - INTERVAL 90 DAY GROUP BY p.id ORDER BY fails DESC LIMIT 8`, [cid]);
  const byStatus = await query<any>(`SELECT status, COUNT(*) c FROM trx_lab_request WHERE company_id = ? GROUP BY status`, [cid]);
  res.json({ data: {
    kpis: { open_requests: openReq, pending_inward: pendingInward, samples_awaiting_testing: awaitingTest, trials_in_progress: inProgress, lab_review_pending: labPending,
      qa_approval_pending: qaPending, retest_required: retest, failed_trials_month: failed, approved_month: approvedMonth, approved_today: approvedToday, overdue_requests: overdue },
    ageing: ageing.map((a) => ({ stage: a.stage, d0_1: n(a.d0_1), d2_3: n(a.d2_3), d4_7: n(a.d4_7), d8: n(a.d8) })),
    failures, requests_by_status: byStatus,
  } });
}));

