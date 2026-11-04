import { Router } from 'express';
import fs from 'fs';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute, txQuery, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { s } from '../resources/schemas.js';
import {
  P, TEST_SCOPES, SOURCES, SAMPLE_TYPES, SAMPLE_UOMS, ATTACHMENT_TYPES, REQUEST_OPEN_FOR_SAMPLES, TRIAL_EDITABLE, dateStr, reasonReq, idemKey,
  cidOf, uidOf, idParam, hasPerm, needPerm, nn, idemFrom, labNumber, labAudit, notify, storeFile, filePath, sampleBalance, sampleMove,
  refreshRequestStatus, buildPlanSnapshot, getRequest, assertRowVersion, splitList,
} from './labCore.js';
import { renderSampleLabel } from './labPdf.js';

/**
 * Lab requests (spec §4.1), sample inward + custody ledger (§4.2) and private attachments.
 *   DRAFT → submit → SUBMITTED ⇄ (return) CLARIFICATION_REQUIRED → … sample inward → SAMPLE_RECEIVED → (trials drive the rest)
 * After submission the key fields are amendment-controlled (reason, audited); cancel needs a reason.
 */
export const labRequestRouter = Router();
const VIEW = requirePermission(P.VIEW);

/* ================================================================ jobs for the lab (I/O picker without purchase rights) */
labRequestRouter.get('/jobs', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const jobs = await query<any>(
    `SELECT so.id, so.so_no, so.io_no, so.buyer_po_no, so.buyer_id, b.party_name AS buyer_name
       FROM trx_sales_order so LEFT JOIN mst_party b ON b.id = so.buyer_id
      WHERE so.company_id = ? AND so.is_deleted = 0 AND COALESCE(so.approval_state, 'DRAFT') NOT IN ('CANCELLED', 'REJECTED')
      ORDER BY so.so_date DESC, so.id DESC LIMIT 1000`, [cid]);
  const styles = jobs.length ? await query<any>(
    `SELECT DISTINCT sol.so_id, sol.style_id, st.style_code, st.style_name FROM trx_sales_order_line sol JOIN mst_style st ON st.id = sol.style_id
      WHERE sol.so_id IN (?) ORDER BY st.style_code`, [jobs.map((j) => j.id)]) : [];
  res.json({ data: jobs.map((j) => {
    const st = styles.filter((x) => Number(x.so_id) === Number(j.id)).map((x) => ({ style_id: Number(x.style_id), style_code: x.style_code, style_name: x.style_name }));
    const jobNo = j.io_no || j.so_no;
    return { ...j, job_no: jobNo, styles: st, label: `${jobNo} · ${j.buyer_name ?? '—'} · ${st.map((x) => x.style_code).join(', ') || 'no style'}` };
  }) });
}));

/* ================================================================ request register */
const LIST_SQL = `
  SELECT r.*, b.party_name AS buyer_name, so.so_no, COALESCE(NULLIF(so.io_no, ''), so.so_no) AS job_no, st.style_code, st.style_name,
         c.color_name, f.fabric_name, pl.plan_code, u.full_name AS requester_name,
         (SELECT COUNT(*) FROM trx_lab_sample x WHERE x.request_id = r.id) AS sample_count,
         (SELECT COUNT(*) FROM trx_lab_trial t WHERE t.request_id = r.id AND t.status <> 'CANCELLED') AS trial_count,
         (SELECT COUNT(*) FROM trx_lab_report rp WHERE rp.request_id = r.id) AS report_count,
         DATEDIFF(r.required_date, CURDATE()) AS days_to_due
    FROM trx_lab_request r
    LEFT JOIN mst_party b ON b.id = r.buyer_id LEFT JOIN trx_sales_order so ON so.id = r.so_id
    LEFT JOIN mst_style st ON st.id = r.style_id LEFT JOIN mst_color c ON c.id = r.color_id
    LEFT JOIN mst_fabric f ON f.id = r.fabric_id LEFT JOIN mst_lab_test_plan pl ON pl.id = r.test_plan_id
    LEFT JOIN mst_user u ON u.id = r.requester_id`;

labRequestRouter.get('/requests', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({
    status: z.string().trim().max(200).optional(), buyer_id: s.id(), style_id: s.id(), color_id: s.id(), so_id: s.id(),
    priority: z.enum(['NORMAL', 'URGENT']).optional(), scope: z.enum(TEST_SCOPES).optional(), from: dateStr.optional(), to: dateStr.optional(),
    q: z.string().trim().max(60).optional(), open: z.enum(['0', '1']).optional(),
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50),
  }).parse(req.query);
  const where = ['r.company_id = ?']; const p: unknown[] = [cid];
  const statuses = splitList(q.status);
  if (statuses.length) { where.push('r.status IN (?)'); p.push(statuses); }
  if (q.open === '1') where.push(`r.status NOT IN ('APPROVED','REJECTED','CANCELLED','CLOSED')`);
  for (const k of ['buyer_id', 'style_id', 'color_id', 'so_id'] as const) if (q[k]) { where.push(`r.${k} = ?`); p.push(q[k]); }
  if (q.priority) { where.push('r.priority = ?'); p.push(q.priority); }
  if (q.scope) { where.push('FIND_IN_SET(?, r.test_scope)'); p.push(q.scope); }
  if (q.from) { where.push('r.request_date >= ?'); p.push(q.from); }
  if (q.to) { where.push('r.request_date <= ?'); p.push(q.to); }
  if (q.q) { where.push('(r.request_no LIKE ? OR st.style_code LIKE ? OR b.party_name LIKE ? OR so.so_no LIKE ? OR so.io_no LIKE ? OR r.buyer_po_no LIKE ? OR r.fabric_lot LIKE ?)'); for (let i = 0; i < 7; i++) p.push(`%${q.q}%`); }
  const total = Number((await queryOne<any>(`SELECT COUNT(*) c FROM (${LIST_SQL} WHERE ${where.join(' AND ')}) z`, p))?.c ?? 0);
  const rows = await query<any>(`${LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
  res.json({ data: rows.map((r) => ({ ...r, test_scope: splitList(r.test_scope), plan_snapshot: undefined })), meta: { total, page: q.page, pageSize: q.pageSize } });
}));

/* ================================================================ request create / update */
const itemSchema = z.object({
  item_description: s.nullableStr(200), size_id: s.id(), sample_type: z.enum(SAMPLE_TYPES),
  requested_qty: z.coerce.number().positive('Quantity must be greater than zero'), uom: z.enum(SAMPLE_UOMS).default('PCS'),
  due_date: dateStr.nullish(), remarks: s.nullableStr(255),
});
const requestSchema = z.object({
  request_date: dateStr.nullish(), required_date: dateStr, source: z.enum(SOURCES).default('MERCHANDISING'),
  buyer_id: s.id(), so_id: s.id(), buyer_po_no: s.nullableStr(60), style_id: s.id(), color_id: s.id(), size_id: s.id(),
  item_description: s.nullableStr(200), fabric_id: s.id(), composition: s.nullableStr(120), gsm: z.coerce.number().positive().nullish(),
  fabric_lot: s.nullableStr(60), test_scope: z.array(z.enum(TEST_SCOPES)).min(1, 'Choose the test scope'), test_plan_id: s.id(),
  priority: z.enum(['NORMAL', 'URGENT']).default('NORMAL'), is_development: z.coerce.boolean().default(false),
  development_ref: s.nullableStr(60), development_reason: s.nullableStr(255), buyer_standard: s.nullableStr(255), remarks: s.nullableStr(500),
  items: z.array(itemSchema).min(1, 'Add the sample requirement').max(50),
  row_version: z.coerce.number().int().nullish(), submit: z.coerce.boolean().default(false),
});
type RequestBody = z.infer<typeof requestSchema>;

/** Master checks + derived fields (buyer from the order, PO from the order, composition / GSM from the fabric). */
async function resolveRequest(cid: number, b: RequestBody) {
  const out = { ...b };
  if (b.so_id) {
    const so = await queryOne<any>(`SELECT id, buyer_id, buyer_po_no FROM trx_sales_order WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.so_id, cid]);
    if (!so) throw BadRequest('Order not found');
    if (b.buyer_id && so.buyer_id && Number(so.buyer_id) !== b.buyer_id) throw BadRequest('The buyer does not match the order');
    out.buyer_id = b.buyer_id ?? nn(so.buyer_id);
    out.buyer_po_no = b.buyer_po_no ?? so.buyer_po_no ?? null;
    if (b.style_id && !(await queryOne(`SELECT id FROM trx_sales_order_line WHERE so_id = ? AND style_id = ? LIMIT 1`, [b.so_id, b.style_id])))
      throw BadRequest('The style is not on this order');
  }
  if (out.buyer_id && !(await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ?`, [out.buyer_id, cid]))) throw BadRequest('Buyer not found');
  if (b.style_id) {
    const st = await queryOne<any>(`SELECT id, buyer_id FROM mst_style WHERE id = ? AND company_id = ?`, [b.style_id, cid]);
    if (!st) throw BadRequest('Style not found');
    if (!out.buyer_id && st.buyer_id) out.buyer_id = Number(st.buyer_id);
  }
  if (b.color_id && !(await queryOne(`SELECT id FROM mst_color WHERE id = ? AND company_id = ?`, [b.color_id, cid]))) throw BadRequest('Colour not found');
  if (b.fabric_id) {
    const f = await queryOne<any>(`SELECT f.id, c.description AS composition, g.gsm_value FROM mst_fabric f LEFT JOIN mst_composition c ON c.id = f.composition_id
                                    LEFT JOIN mst_gsm g ON g.id = f.gsm_id WHERE f.id = ? AND f.company_id = ?`, [b.fabric_id, cid]);
    if (!f) throw BadRequest('Fabric not found');
    out.composition = b.composition ?? f.composition ?? null;
    out.gsm = b.gsm ?? nn(f.gsm_value);
  }
  if (b.test_plan_id && !(await queryOne(`SELECT id FROM mst_lab_test_plan WHERE id = ? AND company_id = ?`, [b.test_plan_id, cid]))) throw BadRequest('Test plan not found');
  return out;
}

/** Submission rules (spec §4.1): order / style for order work, a development reference + reason otherwise, an active,
 *  in-date, applicable plan, required date not before the request date. */
async function submitChecks(tx: Tx, cid: number, r: any) {
  const errs: string[] = [];
  if (r.required_date < r.request_date) errs.push('Required date is before the request date');
  if (Number(r.is_development)) {
    if (!r.development_ref) errs.push('Development / proto reference is required for a non-order sample');
    if (!r.development_reason) errs.push('Give the reason for a non-order request');
  } else {
    if (!r.so_id) errs.push('Order (I/O) is required — or mark it as a development sample');
    if (!r.style_id) errs.push('Style is required');
  }
  if (!r.test_plan_id) errs.push('Choose the test plan');
  const items = await txQuery<any>(tx, `SELECT id FROM trx_lab_request_item WHERE request_id = ?`, [r.id]);
  if (!items.length) errs.push('Add the sample requirement');
  if (r.test_plan_id) {
    const pl = await txQueryOne<any>(tx, `SELECT * FROM mst_lab_test_plan WHERE id = ? AND company_id = ?`, [r.test_plan_id, cid]);
    if (!pl || pl.status !== 'ACTIVE') errs.push('The test plan is not active');
    else {
      const today = new Date().toISOString().slice(0, 10);
      const ef = pl.effective_from ? String(pl.effective_from).slice(0, 10) : null; const et = pl.effective_to ? String(pl.effective_to).slice(0, 10) : null;
      if ((ef && ef > today) || (et && et < today)) errs.push('The test plan is outside its effective dates');
      if (pl.buyer_id && Number(pl.buyer_id) !== Number(r.buyer_id)) errs.push('The test plan belongs to another buyer');
      if (pl.style_id && Number(pl.style_id) !== Number(r.style_id)) errs.push('The test plan belongs to another style');
      const ps = splitList(pl.test_scope); const rs = splitList(r.test_scope);
      if (ps.length && !ps.includes('COMBINED') && !rs.some((x) => ps.includes(x))) errs.push(`The test plan is for ${ps.join(', ')} requests`);
    }
  }
  if (errs.length) throw BadRequest(errs[0], errs.map((m) => ({ field: '', message: m })));
}

async function doSubmit(req: any, tx: Tx, id: number) {
  const cid = cidOf(req);
  const r = await getRequest(cid, id, tx, true);
  if (!['DRAFT', 'CLARIFICATION_REQUIRED'].includes(r.status)) throw Conflict(`A ${r.status.toLowerCase().replace(/_/g, ' ')} request cannot be submitted`);
  await submitChecks(tx, cid, r);
  const snap = await buildPlanSnapshot(tx, cid, Number(r.test_plan_id));
  await txExecute(tx, `UPDATE trx_lab_request SET status = 'SUBMITTED', submitted_at = NOW(), status_reason = NULL, test_plan_version = ?, plan_snapshot = ?,
                       row_version = row_version + 1, updated_by = ? WHERE id = ?`, [snap.version_no, JSON.stringify(snap), uidOf(req), id]);
  await labAudit(req, tx, { request_id: id, entity_type: 'REQUEST', entity_id: id, action: 'SUBMIT', after: { plan: `${snap.plan_code} v${snap.version_no}` } });
  return r;
}

async function writeItems(tx: Tx, id: number, items: RequestBody['items']) {
  await txExecute(tx, `DELETE FROM trx_lab_request_item WHERE request_id = ? AND id NOT IN (SELECT request_item_id FROM trx_lab_sample WHERE request_id = ? AND request_item_id IS NOT NULL)`, [id, id]);
  const kept = await txQuery<any>(tx, `SELECT id FROM trx_lab_request_item WHERE request_id = ?`, [id]);
  if (kept.length) throw Conflict('A sample was already received against a requirement line — amend instead of replacing lines');
  for (const it of items) {
    await txExecute(tx, `INSERT INTO trx_lab_request_item (request_id, item_description, size_id, sample_type, requested_qty, uom, due_date, remarks) VALUES (?,?,?,?,?,?,?,?)`,
      [id, it.item_description ?? null, it.size_id ?? null, it.sample_type, it.requested_qty, it.uom, it.due_date ?? null, it.remarks ?? null]);
  }
}

labRequestRouter.post('/requests', requirePermission(P.CREATE), ah(async (req, res) => {
  const cid = cidOf(req);
  const b = await resolveRequest(cid, requestSchema.parse(req.body ?? {}));
  const requestDate = b.request_date ?? new Date().toISOString().slice(0, 10);
  if (b.required_date < requestDate) throw BadRequest('Required date is before the request date');
  const out = await transaction(async (tx) => {
    const no = await labNumber(tx, cid, 'LAB_REQUEST', Number(requestDate.slice(0, 4)));
    const r = await txExecute(tx,
      `INSERT INTO trx_lab_request (company_id, request_no, request_date, required_date, source, buyer_id, so_id, buyer_po_no, style_id, color_id, size_id,
              item_description, fabric_id, composition, gsm, fabric_lot, test_scope, test_plan_id, priority, is_development, development_ref, development_reason,
              buyer_standard, remarks, status, requester_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,
      [cid, no, requestDate, b.required_date, b.source, b.buyer_id ?? null, b.so_id ?? null, b.buyer_po_no ?? null, b.style_id ?? null, b.color_id ?? null,
        b.size_id ?? null, b.item_description ?? null, b.fabric_id ?? null, b.composition ?? null, b.gsm ?? null, b.fabric_lot ?? null, b.test_scope.join(','),
        b.test_plan_id ?? null, b.priority, b.is_development ? 1 : 0, b.development_ref ?? null, b.development_reason ?? null, b.buyer_standard ?? null,
        b.remarks ?? null, uidOf(req), uidOf(req)]);
    const id = Number(r.insertId);
    await writeItems(tx, id, b.items);
    await labAudit(req, tx, { request_id: id, entity_type: 'REQUEST', entity_id: id, action: 'CREATE', after: { request_no: no } });
    if (b.submit) await doSubmit(req, tx, id);
    return { id, request_no: no };
  });
  if (b.submit) void notify(req, { perms: [P.APPROVE], title: `Lab request ${out.request_no} submitted`, body: `Due ${b.required_date} · ${b.test_scope.join(', ')}`, ref_type: 'LAB_REQUEST', ref_id: out.id });
  res.status(201).json({ data: await requestDetail(cid, out.id) });
}));

const AMENDABLE = ['required_date', 'priority', 'remarks', 'buyer_standard', 'fabric_lot', 'color_id', 'size_id', 'item_description'] as const;

/** Draft / clarification: full edit. After submission: amendment of the controlled fields with a reason (audited). */
labRequestRouter.put('/requests/:id', requirePermission(P.CREATE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const cur = await getRequest(cid, id);
  if (['DRAFT', 'CLARIFICATION_REQUIRED'].includes(cur.status)) {
    const b = await resolveRequest(cid, requestSchema.parse(req.body ?? {}));
    assertRowVersion(cur, b.row_version);
    await transaction(async (tx) => {
      const lock = await getRequest(cid, id, tx, true);
      assertRowVersion(lock, b.row_version);
      if (b.required_date < String(lock.request_date).slice(0, 10)) throw BadRequest('Required date is before the request date');
      await txExecute(tx,
        `UPDATE trx_lab_request SET required_date = ?, source = ?, buyer_id = ?, so_id = ?, buyer_po_no = ?, style_id = ?, color_id = ?, size_id = ?, item_description = ?,
                fabric_id = ?, composition = ?, gsm = ?, fabric_lot = ?, test_scope = ?, test_plan_id = ?, priority = ?, is_development = ?, development_ref = ?,
                development_reason = ?, buyer_standard = ?, remarks = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
        [b.required_date, b.source, b.buyer_id ?? null, b.so_id ?? null, b.buyer_po_no ?? null, b.style_id ?? null, b.color_id ?? null, b.size_id ?? null,
          b.item_description ?? null, b.fabric_id ?? null, b.composition ?? null, b.gsm ?? null, b.fabric_lot ?? null, b.test_scope.join(','), b.test_plan_id ?? null,
          b.priority, b.is_development ? 1 : 0, b.development_ref ?? null, b.development_reason ?? null, b.buyer_standard ?? null, b.remarks ?? null, uidOf(req), id]);
      await writeItems(tx, id, b.items);
      await labAudit(req, tx, { request_id: id, entity_type: 'REQUEST', entity_id: id, action: 'UPDATE', before: lock, after: b });
      if (b.submit) await doSubmit(req, tx, id);
    });
    if (b.submit) void notify(req, { perms: [P.APPROVE], title: `Lab request ${cur.request_no} submitted`, body: `Due ${b.required_date}`, ref_type: 'LAB_REQUEST', ref_id: id });
  } else {
    if (['CANCELLED', 'CLOSED'].includes(cur.status)) throw Conflict(`A ${cur.status.toLowerCase()} request cannot be changed`);
    const b = z.object({
      amendment_reason: reasonReq, row_version: z.coerce.number().int().nullish(), required_date: dateStr.optional(), priority: z.enum(['NORMAL', 'URGENT']).optional(),
      remarks: s.nullableStr(500), buyer_standard: s.nullableStr(255), fabric_lot: s.nullableStr(60), color_id: s.id(), size_id: s.id(), item_description: s.nullableStr(200),
    }).strict().parse(req.body ?? {});
    if (b.color_id && !(await queryOne(`SELECT id FROM mst_color WHERE id = ? AND company_id = ?`, [b.color_id, cid]))) throw BadRequest('Colour not found');
    await transaction(async (tx) => {
      const lock = await getRequest(cid, id, tx, true);
      assertRowVersion(lock, b.row_version);
      const changes: Record<string, unknown> = {}; const before: Record<string, unknown> = {};
      for (const k of AMENDABLE) if (b[k] !== undefined && String(b[k] ?? '') !== String(lock[k] ?? '').slice(0, k === 'required_date' ? 10 : undefined)) { changes[k] = b[k]; before[k] = lock[k]; }
      if (!Object.keys(changes).length) throw BadRequest('Nothing changed');
      if (changes.required_date && String(changes.required_date) < String(lock.request_date).slice(0, 10)) throw BadRequest('Required date is before the request date');
      await txExecute(tx, `UPDATE trx_lab_request SET ${Object.keys(changes).map((k) => `${k} = ?`).join(', ')}, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
        [...Object.values(changes).map((v) => v ?? null), uidOf(req), id]);
      await labAudit(req, tx, { request_id: id, entity_type: 'REQUEST', entity_id: id, action: 'AMEND', before, after: changes, remarks: b.amendment_reason });
    });
  }
  res.json({ data: await requestDetail(cid, id) });
}));

labRequestRouter.post('/requests/:id/submit', requirePermission(P.CREATE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const r = await transaction((tx) => doSubmit(req, tx, id));
  void notify(req, { perms: [P.APPROVE], title: `Lab request ${r.request_no} submitted`, body: `Due ${String(r.required_date).slice(0, 10)} · ${r.test_scope}`, ref_type: 'LAB_REQUEST', ref_id: id });
  res.json({ data: await requestDetail(cid, id) });
}));

/** Lab returns a request for missing information — only before any sample is received. */
labRequestRouter.post('/requests/:id/return', requirePermission(P.APPROVE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ reason: reasonReq }).parse(req.body ?? {});
  const r = await transaction(async (tx) => {
    const r = await getRequest(cid, id, tx, true);
    if (r.status !== 'SUBMITTED') throw Conflict('Only a submitted request with no sample received can be returned');
    if (await txQueryOne(tx, `SELECT id FROM trx_lab_sample WHERE request_id = ? LIMIT 1`, [id])) throw Conflict('A sample is already received');
    await txExecute(tx, `UPDATE trx_lab_request SET status = 'CLARIFICATION_REQUIRED', status_reason = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [b.reason, uidOf(req), id]);
    await labAudit(req, tx, { request_id: id, entity_type: 'REQUEST', entity_id: id, action: 'RETURN', remarks: b.reason });
    return r;
  });
  void notify(req, { userIds: [r.requester_id], title: `Lab request ${r.request_no} returned`, body: b.reason, ref_type: 'LAB_REQUEST', ref_id: id });
  res.json({ data: await requestDetail(cid, id) });
}));

labRequestRouter.post('/requests/:id/cancel', requireAny(P.CREATE, P.APPROVE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ reason: reasonReq }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const r = await getRequest(cid, id, tx, true);
    if (['CANCELLED', 'CLOSED', 'APPROVED'].includes(r.status)) throw Conflict(`A ${r.status.toLowerCase()} request cannot be cancelled`);
    const busy = await txQueryOne<any>(tx, `SELECT trial_no FROM trx_lab_trial WHERE request_id = ? AND status IN ('SUBMITTED','LAB_REVIEWED') LIMIT 1`, [id]);
    if (busy) throw Conflict(`${busy.trial_no} is waiting for approval — decide it first`);
    await txExecute(tx, `UPDATE trx_lab_trial SET status = 'CANCELLED', remarks = CONCAT_WS(' · ', remarks, ?) WHERE request_id = ? AND status IN (?)`, [`Request cancelled: ${b.reason}`, id, TRIAL_EDITABLE]);
    await txExecute(tx, `UPDATE trx_lab_request SET status = 'CANCELLED', status_reason = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [b.reason, uidOf(req), id]);
    await labAudit(req, tx, { request_id: id, entity_type: 'REQUEST', entity_id: id, action: 'CANCEL', before: { status: r.status }, remarks: b.reason });
  });
  res.json({ data: await requestDetail(cid, id) });
}));

labRequestRouter.post('/requests/:id/close', requirePermission(P.APPROVE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ reason: reasonReq }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const r = await getRequest(cid, id, tx, true);
    if (!['APPROVED', 'REJECTED'].includes(r.status)) throw Conflict('Only an approved or rejected request can be closed');
    await txExecute(tx, `UPDATE trx_lab_request SET status = 'CLOSED', status_reason = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [b.reason, uidOf(req), id]);
    await labAudit(req, tx, { request_id: id, entity_type: 'REQUEST', entity_id: id, action: 'CLOSE', before: { status: r.status }, remarks: b.reason });
  });
  res.json({ data: await requestDetail(cid, id) });
}));

/* ================================================================ request detail */
export async function requestDetail(cid: number, id: number) {
  const r = await queryOne<any>(`${LIST_SQL} WHERE r.id = ? AND r.company_id = ?`, [id, cid]);
  if (!r) throw NotFound('Lab request not found');
  const [items, samples, trials, reports, attachments, timeline] = await Promise.all([
    query<any>(`SELECT i.*, sz.size_label,
                       (SELECT COALESCE(SUM(x.received_qty), 0) FROM trx_lab_sample x WHERE x.request_item_id = i.id) AS received_qty
                  FROM trx_lab_request_item i LEFT JOIN mst_size sz ON sz.id = i.size_id WHERE i.request_id = ? ORDER BY i.id`, [id]),
    query<any>(`SELECT x.*, c.color_name, u.full_name AS received_by_name FROM trx_lab_sample x LEFT JOIN mst_color c ON c.id = x.color_id
                  LEFT JOIN mst_user u ON u.id = x.received_by WHERE x.request_id = ? ORDER BY x.id`, [id]),
    query<any>(`SELECT t.id, t.trial_no, t.trial_type, t.status, t.recipe_revision, t.parent_trial_id, t.overall_result, t.planned_at, t.started_at, t.completed_at,
                       t.submitted_at, t.reason, pt.trial_no AS parent_trial_no, u.full_name AS technician_name, sm.sample_no
                  FROM trx_lab_trial t LEFT JOIN trx_lab_trial pt ON pt.id = t.parent_trial_id LEFT JOIN mst_user u ON u.id = t.technician_id
                  LEFT JOIN trx_lab_sample sm ON sm.id = t.sample_id WHERE t.request_id = ? ORDER BY t.trial_seq`, [id]),
    query<any>(`SELECT rp.id, rp.report_no, rp.revision_no, rp.report_status, rp.overall_result, rp.disposition, rp.prepared_at, rp.lab_approved_at, rp.qa_approved_at,
                       rp.released_at, t.trial_no FROM trx_lab_report rp JOIN trx_lab_trial t ON t.id = rp.trial_id WHERE rp.request_id = ? ORDER BY rp.id`, [id]),
    query<any>(`SELECT a.id, a.attachment_type, a.original_name, a.mime_type, a.byte_size, a.caption, a.uploaded_at, a.sample_id, a.trial_id, u.full_name AS uploaded_by_name
                  FROM trx_lab_attachment a LEFT JOIN mst_user u ON u.id = a.uploaded_by WHERE a.company_id = ? AND a.request_id = ? AND a.is_removed = 0 ORDER BY a.id`, [cid, id]),
    query<any>(`SELECT l.id, l.entity_type, l.entity_id, l.action, l.remarks, l.created_at, l.after_json, u.full_name AS actor
                  FROM trx_lab_audit l LEFT JOIN mst_user u ON u.id = l.actor_user_id WHERE l.company_id = ? AND l.request_id = ? ORDER BY l.id DESC LIMIT 300`, [cid, id]),
  ]);
  const withBal = [];
  for (const x of samples) withBal.push({ ...x, balance: await sampleBalance(null, Number(x.id)) });
  const snap = r.plan_snapshot ? JSON.parse(r.plan_snapshot) : null;
  return { ...r, test_scope: splitList(r.test_scope), plan_snapshot: snap, items, samples: withBal, trials, reports, attachments, timeline };
}

labRequestRouter.get('/requests/:id', VIEW, ah(async (req, res) => { res.json({ data: await requestDetail(cidOf(req), idParam(req)) }); }));

/* ================================================================ sample inward + ledger */
const inwardSchema = z.object({
  request_item_id: s.id(), received_at: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/).nullish(),
  sample_type: z.enum(SAMPLE_TYPES), received_qty: z.coerce.number().positive('Received quantity must be greater than zero'), uom: z.enum(SAMPLE_UOMS),
  sample_weight_g: z.coerce.number().positive().nullish(), dimensions: z.record(z.string(), z.union([z.string(), z.number()])).nullish(),
  color_id: s.id(), lot_reference: s.nullableStr(60), sample_condition: s.nullableStr(255), handed_over_by: s.nullableStr(100),
  storage_location: s.nullableStr(100), retention_until: dateStr.nullish(), reuse_allowed: z.coerce.boolean().default(true), remarks: s.nullableStr(255),
});

labRequestRouter.get('/requests/:id/samples', VIEW, ah(async (req, res) => {
  const d = await requestDetail(cidOf(req), idParam(req));
  res.json({ data: d.samples });
}));

labRequestRouter.post('/requests/:id/samples', requirePermission(P.UPDATE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = inwardSchema.parse(req.body ?? {});
  if (b.color_id && !(await queryOne(`SELECT id FROM mst_color WHERE id = ? AND company_id = ?`, [b.color_id, cid]))) throw BadRequest('Colour not found');
  const out = await transaction(async (tx) => {
    const r = await getRequest(cid, id, tx, true);
    if (!REQUEST_OPEN_FOR_SAMPLES.includes(r.status) || r.status === 'APPROVED') throw Conflict(r.status === 'DRAFT' || r.status === 'CLARIFICATION_REQUIRED'
      ? 'Submit the request before receiving samples' : `A ${r.status.toLowerCase().replace(/_/g, ' ')} request cannot take samples`);
    if (b.request_item_id) {
      const it = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_request_item WHERE id = ? AND request_id = ?`, [b.request_item_id, id]);
      if (!it) throw BadRequest('Requirement line not found on this request');
      if (it.uom !== b.uom) throw BadRequest(`The requirement is in ${it.uom}`);
    }
    const year = Number((b.received_at ?? new Date().toISOString()).slice(0, 4));
    const no = await labNumber(tx, cid, 'LAB_SAMPLE', year);
    const token = crypto.randomBytes(12).toString('hex');
    const ins = await txExecute(tx,
      `INSERT INTO trx_lab_sample (company_id, sample_no, qr_token, request_id, request_item_id, received_at, sample_type, received_qty, uom, sample_weight_g,
              dimensions_json, color_id, lot_reference, sample_condition, received_by, handed_over_by, storage_location, retention_until, reuse_allowed, remarks)
       VALUES (?,?,?,?,?,COALESCE(?, NOW()),?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, token, id, b.request_item_id ?? null, b.received_at ? b.received_at.replace('T', ' ') : null, b.sample_type, b.received_qty, b.uom,
        b.sample_weight_g ?? null, b.dimensions ? JSON.stringify(b.dimensions) : null, b.color_id ?? r.color_id ?? null, b.lot_reference ?? r.fabric_lot ?? null,
        b.sample_condition ?? null, uidOf(req), b.handed_over_by ?? null, b.storage_location ?? null, b.retention_until ?? null, b.reuse_allowed ? 1 : 0, b.remarks ?? null]);
    const sid = Number(ins.insertId);
    await sampleMove(req, tx, sid, { type: 'INWARD', quantity: b.received_qty, reason: 'Sample inward' });
    await labAudit(req, tx, { request_id: id, entity_type: 'SAMPLE', entity_id: sid, action: 'CREATE', after: { sample_no: no, qty: b.received_qty, uom: b.uom } });
    await refreshRequestStatus(tx, id);
    return { id: sid, sample_no: no, requester: r.requester_id, request_no: r.request_no };
  });
  void notify(req, { userIds: [out.requester], title: `Sample ${out.sample_no} received for ${out.request_no}`, body: `${b.received_qty} ${b.uom}`, ref_type: 'LAB_SAMPLE', ref_id: out.id });
  res.status(201).json({ data: await sampleDetail(cid, out.id) });
}));

const SAMPLE_SQL = `
  SELECT x.*, r.request_no, r.status AS request_status, r.style_id, st.style_code, c.color_name, b.party_name AS buyer_name, u.full_name AS received_by_name
    FROM trx_lab_sample x JOIN trx_lab_request r ON r.id = x.request_id
    LEFT JOIN mst_style st ON st.id = r.style_id LEFT JOIN mst_color c ON c.id = COALESCE(x.color_id, r.color_id)
    LEFT JOIN mst_party b ON b.id = r.buyer_id LEFT JOIN mst_user u ON u.id = x.received_by`;

export async function sampleDetail(cid: number, id: number) {
  const x = await queryOne<any>(`${SAMPLE_SQL} WHERE x.id = ? AND x.company_id = ?`, [id, cid]);
  if (!x) throw NotFound('Sample not found');
  const ledger = await query<any>(
    `SELECT l.*, t.trial_no, u.full_name AS by_name FROM trx_lab_sample_txn l LEFT JOIN trx_lab_trial t ON t.id = l.trial_id
       LEFT JOIN mst_user u ON u.id = l.issued_by WHERE l.sample_id = ? ORDER BY l.id`, [id]);
  const trials = await query<any>(`SELECT id, trial_no, status FROM trx_lab_trial WHERE request_id = ? AND status <> 'CANCELLED' ORDER BY trial_seq`, [x.request_id]);
  const attachments = await query<any>(`SELECT id, attachment_type, original_name, mime_type, caption, uploaded_at FROM trx_lab_attachment WHERE sample_id = ? AND is_removed = 0 ORDER BY id`, [id]);
  return { ...x, dimensions: x.dimensions_json ? JSON.parse(x.dimensions_json) : null, balance: await sampleBalance(null, id), ledger, trials, attachments };
}

labRequestRouter.get('/samples', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const q = z.object({ status: z.string().trim().max(100).optional(), request_id: s.id(), q: z.string().trim().max(60).optional() }).parse(req.query);
  const where = ['x.company_id = ?']; const p: unknown[] = [cid];
  if (q.status) { where.push('x.status IN (?)'); p.push(splitList(q.status)); }
  if (q.request_id) { where.push('x.request_id = ?'); p.push(q.request_id); }
  if (q.q) { where.push('(x.sample_no LIKE ? OR r.request_no LIKE ? OR st.style_code LIKE ? OR x.lot_reference LIKE ?)'); p.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const rows = await query<any>(`${SAMPLE_SQL} WHERE ${where.join(' AND ')} ORDER BY x.id DESC LIMIT 500`, p);
  const out = [];
  for (const r of rows) out.push({ ...r, balance: await sampleBalance(null, Number(r.id)) });
  res.json({ data: out });
}));

/** QR scan: the QR holds only the random token. */
labRequestRouter.get('/samples/by-qr/:token', VIEW, ah(async (req, res) => {
  const token = String(req.params.token ?? '').replace(/^LAB:S:/, '');
  if (!/^[a-f0-9]{24}$/.test(token)) throw NotFound('Sample not found');
  const x = await queryOne<any>(`SELECT id FROM trx_lab_sample WHERE qr_token = ? AND company_id = ?`, [token, cidOf(req)]);
  if (!x) throw NotFound('Sample not found');
  res.json({ data: await sampleDetail(cidOf(req), Number(x.id)) });
}));

labRequestRouter.get('/samples/:id', VIEW, ah(async (req, res) => { res.json({ data: await sampleDetail(cidOf(req), idParam(req)) }); }));

labRequestRouter.get('/samples/:id/label', VIEW, ah(async (req, res) => {
  const d = await sampleDetail(cidOf(req), idParam(req));
  const pdf = await renderSampleLabel(d);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${d.sample_no}-label.pdf"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(pdf);
}));

const moveSchema = z.object({ quantity: z.coerce.number().positive('Quantity must be greater than zero'), trial_id: s.id(), received_by: s.nullableStr(100),
  reason: s.nullableStr(255), idempotency_key: idemKey });
for (const [path, type, perm] of [['issue', 'ISSUE', P.UPDATE], ['consume', 'CONSUME', P.UPDATE], ['return', 'RETURN', P.UPDATE]] as const) {
  labRequestRouter.post(`/samples/:id/${path}`, requirePermission(perm), ah(async (req, res) => {
    const cid = cidOf(req); const id = idParam(req);
    const b = moveSchema.parse(req.body ?? {});
    if (!b.trial_id) throw BadRequest('Choose the trial');
    const out = await transaction(async (tx) => {
      const m = await sampleMove(req, tx, id, { type, quantity: b.quantity, trial_id: b.trial_id, received_by: b.received_by, reason: b.reason, idempotency_key: idemFrom(req, b) });
      const s0 = await txQueryOne<any>(tx, `SELECT request_id FROM trx_lab_sample WHERE id = ?`, [id]);
      await refreshRequestStatus(tx, Number(s0.request_id));
      return m;
    });
    res.status(out.replayed ? 200 : 201).json({ data: { ...(await sampleDetail(cid, id)), txn_id: out.id, replayed: out.replayed } });
  }));
}
labRequestRouter.post('/samples/:id/retain', requirePermission(P.UPDATE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ quantity: z.coerce.number().positive(), storage_location: s.nullableStr(100), retention_until: dateStr.nullish(), reason: s.nullableStr(255), idempotency_key: idemKey }).parse(req.body ?? {});
  await transaction(async (tx) => {
    await sampleMove(req, tx, id, { type: 'RETAIN', quantity: b.quantity, reason: b.reason ?? 'Retained sample', idempotency_key: idemFrom(req, b) });
    if (b.storage_location || b.retention_until) await txExecute(tx, `UPDATE trx_lab_sample SET storage_location = COALESCE(?, storage_location), retention_until = COALESCE(?, retention_until) WHERE id = ?`,
      [b.storage_location ?? null, b.retention_until ?? null, id]);
  });
  res.status(201).json({ data: await sampleDetail(cid, id) });
}));
/** Disposal needs an authorised user (Lab In-charge) and a reason (spec §4.2). */
labRequestRouter.post('/samples/:id/dispose', requirePermission(P.APPROVE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ quantity: z.coerce.number().positive(), from: z.enum(['AVAILABLE', 'RETAINED']).default('AVAILABLE'), reason: reasonReq, idempotency_key: idemKey }).parse(req.body ?? {});
  await transaction((tx) => sampleMove(req, tx, id, { type: 'DISPOSE', quantity: b.quantity, from_bucket: b.from, reason: b.reason, idempotency_key: idemFrom(req, b) }));
  res.status(201).json({ data: await sampleDetail(cid, id) });
}));

/* ================================================================ attachments (private) */
const attachSchema = z.object({
  request_id: s.id(), sample_id: s.id(), trial_id: s.id(), parameter_id: s.id(), attachment_type: z.enum(ATTACHMENT_TYPES).default('OTHER'),
  filename: z.string().trim().min(1).max(200), data: z.string().min(10), caption: s.nullableStr(200),
});

labRequestRouter.post('/attachments', requireAny(P.CREATE, P.UPDATE), ah(async (req, res) => {
  const cid = cidOf(req);
  const b = attachSchema.parse(req.body ?? {});
  let requestId: number | null = b.request_id ?? null;
  if (b.trial_id) {
    needPerm(req, P.UPDATE, 'trial evidence');
    const t = await queryOne<any>(`SELECT id, request_id, status, plan_snapshot FROM trx_lab_trial WHERE id = ? AND company_id = ?`, [b.trial_id, cid]);
    if (!t) throw NotFound('Trial not found');
    if (!TRIAL_EDITABLE.includes(t.status)) throw Conflict('The trial is submitted — its evidence is frozen');
    if (b.parameter_id) {
      const snap = JSON.parse(t.plan_snapshot ?? '{"params":[]}');
      if (!snap.params.some((p: any) => Number(p.parameter_id) === b.parameter_id)) throw BadRequest('That parameter is not in the trial test plan');
    }
    requestId = Number(t.request_id);
  } else if (b.sample_id) {
    const x = await queryOne<any>(`SELECT id, request_id FROM trx_lab_sample WHERE id = ? AND company_id = ?`, [b.sample_id, cid]);
    if (!x) throw NotFound('Sample not found');
    requestId = Number(x.request_id);
  }
  if (!requestId) throw BadRequest('Attach the file to a request, sample or trial');
  const r = await getRequest(cid, requestId);
  if (['CANCELLED', 'CLOSED'].includes(r.status)) throw Conflict('The request is closed');
  const f = storeFile(cid, b.filename, b.data);
  const ins = await transaction(async (tx) => {
    const x = await txExecute(tx,
      `INSERT INTO trx_lab_attachment (company_id, request_id, sample_id, trial_id, parameter_id, attachment_type, storage_key, original_name, mime_type, byte_size, sha256, caption, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, requestId, b.sample_id ?? null, b.trial_id ?? null, b.parameter_id ?? null, b.attachment_type, f.key,
        b.filename.replace(/[\u0000-\u001f"\\/<>:|?*]/g, '_').slice(0, 200), f.mime, f.size, f.sha256, b.caption ?? null, uidOf(req)]);
    await labAudit(req, tx, { request_id: requestId, entity_type: b.trial_id ? 'TRIAL' : b.sample_id ? 'SAMPLE' : 'REQUEST', entity_id: b.trial_id ?? b.sample_id ?? requestId!,
      action: 'ATTACH', after: { attachment_id: Number(x.insertId), type: b.attachment_type, name: b.filename, sha256: f.sha256 } });
    return Number(x.insertId);
  });
  res.status(201).json({ data: { id: ins, sha256: f.sha256, mime_type: f.mime, byte_size: f.size } });
}));

labRequestRouter.get('/attachments/:id/file', VIEW, ah(async (req, res) => {
  const a = await queryOne<any>(`SELECT * FROM trx_lab_attachment WHERE id = ? AND company_id = ?`, [idParam(req), cidOf(req)]);
  if (!a) throw NotFound('File not found');
  const p = filePath(a.storage_key);
  if (!fs.existsSync(p)) throw NotFound('The file is missing on the server');
  const inline = req.query.inline === '1' && /^(application\/pdf|image\/(png|jpeg|webp))$/.test(a.mime_type);
  res.setHeader('Content-Type', a.mime_type);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.original_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(p);
}));

labRequestRouter.post('/attachments/:id/remove', requireAny(P.CREATE, P.UPDATE), ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ reason: reasonReq }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const a = await txQueryOne<any>(tx, `SELECT * FROM trx_lab_attachment WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!a || Number(a.is_removed)) throw NotFound('File not found');
    if (a.trial_id) {
      const t = await txQueryOne<any>(tx, `SELECT status FROM trx_lab_trial WHERE id = ?`, [a.trial_id]);
      if (!TRIAL_EDITABLE.includes(t?.status)) throw Conflict('The trial is submitted — its evidence is frozen');
    }
    if (await txQueryOne(tx, `SELECT id FROM trx_lab_trial_result WHERE certificate_attachment_id = ? LIMIT 1`, [id])) throw Conflict('The file is the certificate of an external result');
    await txExecute(tx, `UPDATE trx_lab_attachment SET is_removed = 1, removed_by = ?, removed_at = NOW() WHERE id = ?`, [uidOf(req), id]);
    await labAudit(req, tx, { request_id: nn(a.request_id), entity_type: 'REQUEST', entity_id: Number(a.request_id ?? 0), action: 'REMOVE_ATTACHMENT',
      before: { attachment_id: id, name: a.original_name }, remarks: b.reason });
  });
  res.json({ data: { id, removed: true } });
}));


