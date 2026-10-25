import { Router, type Request } from 'express';
import fs from 'fs';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { n, r2, cidOf, uidOf, idOpt, strOpt, dateStr, reasonSchema, idParam } from './common.js';
import { istToday, addDays, normNo, LIVE_WF, TARGETS, loadTarget, storeAttachment, attachmentPath, touched, type LinkType } from './billCore.js';
import { refreshInward, createBill, addLink, lockBill, masterDept, createFollowup, CATEGORIES } from './billTracker.routes.js';

/**
 * Document inward register (client spec 24-Oct-2026 §7): every incoming document — bill, DC, GRN copy, PO copy, process challan,
 * freight proof, certificate, email attachment, other — gets its own Inward No. the moment it arrives, even when the supplier, the
 * document no or the related PO / GRN is not known yet. Receiving a DC never creates a GRN or a bill; a bill-type document becomes a
 * tracked bill only when someone registers it (create-bill), after the duplicate check.
 * Files: private (server/uploads/bill-docs, random names, sha256), downloaded only through /stores/bill-docs/attachments/:id/download.
 */
export const documentInwardRouter = Router();

const VIEW = requireAny('FINANCE.VIEW', 'PURCHASE.VIEW', 'GRN.VIEW');
const EDIT = requireAny('FINANCE.CREATE', 'FINANCE.UPDATE', 'PURCHASE.CREATE', 'GRN.CREATE');
const CLEAR = requireAny('BILL_TRACKER.VERIFY', 'BILL_TRACKER.APPROVE');

export const DOC_TYPES = ['BILL', 'DC', 'GRN_COPY', 'PO_COPY', 'PROCESS_CHALLAN', 'FREIGHT_PROOF', 'CERTIFICATE', 'EMAIL_ATTACHMENT', 'OTHER'] as const;
export const CHANNELS = ['PHYSICAL', 'EMAIL', 'SCAN', 'PORTAL', 'OTHER'] as const;
const DOC_LINK_TYPES = ['INWARD', 'PO', 'TRIM_PO', 'GRN', 'TRIM_GRN', 'GATE_INWARD', 'JOBWORK_CHALLAN', 'SUPPLIER_BILL'] as const;
const numOpt = z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), z.coerce.number().min(0).nullable());
const dtOpt = z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/, 'Date-time must be YYYY-MM-DD HH:MM').nullable());
const fileSchema = z.object({ filename: z.string().trim().min(1).max(255), data: z.string().min(1) });

const docSchema = z.object({
  doc_type: z.enum(DOC_TYPES), channel: z.enum(CHANNELS).default('PHYSICAL'), receipt_date: dateStr.default(istToday), received_dept: strOpt(80),
  sender_name: strOpt(150), party_id: idOpt, doc_no: strOpt(60), doc_date: dateStr.nullish(), amount: numOpt, assigned_to: idOpt, due_date: dateStr.nullish(),
  notes: strOpt(1000), tags: strOpt(200), mailbox: strOpt(120), email_from: strOpt(200), email_subject: strOpt(300), email_message_id: strOpt(255),
  email_received_at: dtOpt, email_attachment_ref: strOpt(255), row_version: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().int().positive().optional()),
  file: fileSchema.nullish(),
});
type DocIn = z.infer<typeof docSchema>;

const ROW = (where: string) =>
  `SELECT d.*, p.party_name, ur.full_name received_by_name, uo.full_name owner_name,
          (SELECT COUNT(*) FROM trx_bill_doc_attachment a WHERE a.inward_id = d.id AND a.is_removed = 0) attachment_count,
          (SELECT GROUP_CONCAT(DISTINCT b.entry_no ORDER BY b.entry_no) FROM trx_bill_tracker b
            WHERE b.workflow_status <> 'CANCELLED' AND (b.inward_id = d.id OR b.id IN (SELECT l.bill_id FROM trx_bill_tracker_link l WHERE l.link_type = 'DOC_INWARD' AND l.target_id = d.id AND l.removed_at IS NULL))) bills
     FROM trx_document_inward d LEFT JOIN mst_party p ON p.id = d.party_id LEFT JOIN mst_user ur ON ur.id = d.received_by LEFT JOIN mst_user uo ON uo.id = d.assigned_to
    WHERE ${where}`;
const decorate = (r: any, today = istToday()) => (r ? { ...r, overdue: r.status === 'ACTIVE' && r.completeness !== 'COMPLETE' && r.due_date && String(r.due_date) < today } : r);
async function docRow(cid: number, id: number) { return decorate(await queryOne<any>(ROW('d.id = ? AND d.company_id = ?'), [id, cid])); }

function validate(b: DocIn) {
  const today = istToday();
  if (b.receipt_date > today) throw BadRequest('The receipt date cannot be in the future');
  if (b.doc_date && b.doc_date > today) throw BadRequest('The document date cannot be in the future');
  if (b.doc_date && b.doc_date > b.receipt_date) throw BadRequest('The document date cannot be after the date it was received');
  if (b.channel === 'EMAIL' && !b.email_from) throw BadRequest('Enter the sender email for a document received by email');
}

/** Same party + document no on another live inward bill / tracked bill → duplicate note (registration is never refused). */
async function duplicateNote(tx: Tx, cid: number, id: number | null, b: { doc_type: string; party_id: number | null; doc_no: string | null }) {
  if (!b.party_id || !b.doc_no || !['BILL', 'EMAIL_ATTACHMENT'].includes(b.doc_type)) return null;
  const norm = normNo(b.doc_no);
  const other = await txQueryOne<any>(tx,
    `SELECT GROUP_CONCAT(inward_no) nos FROM trx_document_inward WHERE company_id = ? AND party_id = ? AND normalized_doc_no = ? AND status = 'ACTIVE'
        AND doc_type IN ('BILL','EMAIL_ATTACHMENT') AND id <> ?`, [cid, b.party_id, norm, id ?? 0]);
  const bills = await txQueryOne<any>(tx,
    `SELECT GROUP_CONCAT(b.entry_no) nos FROM trx_bill_tracker b WHERE b.company_id = ? AND b.supplier_id = ? AND b.normalized_bill_no = ? AND b.workflow_status IN ${LIVE_WF}
        AND (b.inward_id IS NULL OR b.inward_id <> ?)
        AND NOT EXISTS (SELECT 1 FROM trx_bill_tracker_link l WHERE l.bill_id = b.id AND l.link_type = 'DOC_INWARD' AND l.target_id = ? AND l.removed_at IS NULL)`,
    [cid, b.party_id, norm, id ?? 0, id ?? 0]);
  const parts = [other?.nos ? `same party + document no as ${other.nos}` : null, bills?.nos ? `already registered as bill ${bills.nos}` : null].filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

async function attachToInward(tx: Tx, req: Request, cid: number, d: any, f: { filename: string; data: string }) {
  const a = await storeAttachment(tx, cid, uidOf(req), { inward_id: d.id }, f.filename, f.data);
  let note: string | null = null;
  if (a.duplicate) {
    const x = await txQueryOne<any>(tx, 'SELECT bill_id, inward_id FROM trx_bill_doc_attachment WHERE id = ?', [a.duplicate.id]);
    const ownBill = x?.bill_id && !!(await txQueryOne(tx,
      `SELECT id FROM trx_bill_tracker b WHERE b.id = ? AND (b.inward_id = ? OR EXISTS (SELECT 1 FROM trx_bill_tracker_link l WHERE l.bill_id = b.id AND l.link_type = 'DOC_INWARD' AND l.target_id = ? AND l.removed_at IS NULL))`,
      [x.bill_id, d.id, d.id]));
    if (Number(x?.inward_id ?? 0) !== Number(d.id) && !ownBill) {
      note = `The same file is already on ${a.duplicate.where ?? 'another record'} (${a.duplicate.name})`;
      await txExecute(tx, 'UPDATE trx_document_inward SET duplicate_note = ?, duplicate_cleared = 0, row_version = row_version + 1 WHERE id = ?', [note.slice(0, 255), d.id]);
    }
  }
  await audit(req, 'trx_bill_doc_attachment', a.id, 'INSERT', undefined, { inward_id: d.id, filename: f.filename, sha256: a.sha256, duplicate_of_id: a.duplicate?.id ?? null }, tx);
  return { ...a, note };
}

async function ownerDefaults(tx: Tx, cid: number, id: number, uid: number) {
  const d = await txQueryOne<any>(tx, 'SELECT * FROM trx_document_inward WHERE id = ?', [id]);
  if (!d || d.completeness === 'COMPLETE' || d.status !== 'ACTIVE') return;
  const days = n((await txQueryOne<any>(tx, `SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'BT_INWARD_DUE_DAYS'`, [cid]))?.v) || 2;
  if (!d.assigned_to || !d.due_date)
    await txExecute(tx, 'UPDATE trx_document_inward SET assigned_to = COALESCE(assigned_to, ?), due_date = COALESCE(due_date, ?) WHERE id = ?', [uid, addDays(String(d.receipt_date), days), id]);
}

// ================================================================== list / one
const listQ = z.object({
  from: dateStr.optional(), to: dateStr.optional(), q: z.string().trim().max(100).optional().transform((v) => v || undefined),
  doc_type: z.string().max(20).optional().transform((v) => v || undefined), channel: z.string().max(10).optional().transform((v) => v || undefined),
  completeness: z.string().max(20).optional().transform((v) => v || undefined), status: z.string().max(10).optional().transform((v) => v || undefined),
  party_id: z.coerce.number().int().positive().optional(), mine: z.coerce.boolean().default(false), overdue: z.coerce.boolean().default(false),
  awaiting_bill: z.coerce.boolean().default(false), page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(500).default(100),
});
documentInwardRouter.get('/document-inward', VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const q = listQ.parse(req.query); const today = istToday();
  const w = ['d.company_id = ?']; const p: unknown[] = [cid];
  if (q.from) { w.push('d.receipt_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('d.receipt_date <= ?'); p.push(q.to); }
  if (q.doc_type) { w.push('d.doc_type = ?'); p.push(q.doc_type); }
  if (q.channel) { w.push('d.channel = ?'); p.push(q.channel); }
  if (q.completeness) { w.push('d.completeness = ?'); p.push(q.completeness); }
  if (q.status) { w.push('d.status = ?'); p.push(q.status); }
  if (q.party_id) { w.push('d.party_id = ?'); p.push(q.party_id); }
  if (q.mine) { w.push('d.assigned_to = ?'); p.push(uidOf(req)); }
  if (q.overdue) { w.push(`d.status = 'ACTIVE' AND d.completeness <> 'COMPLETE' AND d.due_date < ?`); p.push(today); }
  if (q.awaiting_bill) w.push(`d.status = 'ACTIVE' AND d.doc_type IN ('DC','PROCESS_CHALLAN','GRN_COPY') AND NOT EXISTS (SELECT 1 FROM trx_bill_tracker_link l JOIN trx_bill_tracker b ON b.id = l.bill_id
                                WHERE l.link_type = 'DOC_INWARD' AND l.target_id = d.id AND l.removed_at IS NULL AND b.workflow_status <> 'CANCELLED')`);
  if (q.q) {
    w.push('(d.inward_no LIKE ? OR d.doc_no LIKE ? OR p.party_name LIKE ? OR d.sender_name LIKE ? OR d.email_from LIKE ? OR d.email_subject LIKE ? OR d.tags LIKE ?)');
    for (let i = 0; i < 7; i++) p.push(`%${q.q}%`);
  }
  const where = w.join(' AND ');
  const total = n((await queryOne<any>(`SELECT COUNT(*) c FROM trx_document_inward d LEFT JOIN mst_party p ON p.id = d.party_id WHERE ${where}`, p))?.c);
  const rows = await query<any>(ROW(where) + ` ORDER BY d.received_at DESC, d.id DESC LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p);
  res.json({ data: rows.map((r) => decorate(r, today)), pagination: { page: q.page, pageSize: q.page_size, total, totalPages: Math.max(1, Math.ceil(total / q.page_size)) } });
}));

documentInwardRouter.get('/document-inward/:id', VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const row = await docRow(cid, id);
  if (!row) throw NotFound('Inward document not found');
  const [attachments, links, linkedFrom, bills, followups] = await Promise.all([
    query<any>(`SELECT a.id, a.original_name, a.mime_type, a.byte_size, a.sha256, a.duplicate_of_id, a.uploaded_at, a.is_removed, a.remove_reason, u.full_name uploaded_by_name
                  FROM trx_bill_doc_attachment a LEFT JOIN mst_user u ON u.id = a.uploaded_by WHERE a.inward_id = ? ORDER BY a.is_removed, a.id`, [id]),
    query<any>(`SELECT x.*, u.full_name linked_by_name FROM trx_document_link x LEFT JOIN mst_user u ON u.id = x.linked_by WHERE x.inward_id = ? ORDER BY x.removed_at IS NOT NULL, x.id`, [id]),
    query<any>(`SELECT x.*, d.inward_no source_no, d.doc_type source_type FROM trx_document_link x JOIN trx_document_inward d ON d.id = x.inward_id
                 WHERE x.target_type = 'INWARD' AND x.target_id = ? AND x.removed_at IS NULL`, [id]),
    query<any>(`SELECT b.id, b.entry_no, b.bill_no, b.bill_date, b.amount, b.workflow_status, b.posting_status, p.party_name FROM trx_bill_tracker b LEFT JOIN mst_party p ON p.id = b.supplier_id
                 WHERE b.company_id = ? AND (b.inward_id = ? OR b.id IN (SELECT l.bill_id FROM trx_bill_tracker_link l WHERE l.link_type = 'DOC_INWARD' AND l.target_id = ? AND l.removed_at IS NULL))`, [cid, id, id]),
    query<any>(`SELECT f.*, uo.full_name owner_name FROM trx_bill_followup f LEFT JOIN mst_user uo ON uo.id = f.owner_id WHERE f.inward_id = ? ORDER BY f.status = 'OPEN' DESC, f.due_date`, [id]),
  ]);
  res.json({ data: { ...row, attachments, links: links.map((l) => ({ ...l, type_label: l.target_type === 'INWARD' ? 'Inward document' : TARGETS[l.target_type as LinkType]?.label ?? l.target_type })),
    linked_from: linkedFrom, bills, followups } });
}));

// ================================================================== create / edit
documentInwardRouter.post('/document-inward', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const uid = uidOf(req);
  const b = docSchema.parse(req.body);
  validate(b);
  b.received_dept = await masterDept(cid, b.received_dept);
  if (b.party_id && !(await queryOne('SELECT id FROM mst_party WHERE id = ? AND company_id = ?', [b.party_id, cid]))) throw BadRequest('Party not found');
  if (b.email_message_id) {
    const seen = await queryOne<any>(`SELECT inward_no FROM trx_document_inward WHERE company_id = ? AND email_message_id = ? AND status = 'ACTIVE' LIMIT 1`, [cid, b.email_message_id]);
    if (seen && !b.file) throw Conflict(`This email (message id) is already registered as ${seen.inward_no} — attach the file to see if it is a new attachment`);
  }
  const notices: string[] = [];
  const out = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'DOC_INWARD');
    const r = await txExecute(tx,
      `INSERT INTO trx_document_inward (company_id, inward_no, doc_type, channel, receipt_date, received_by, received_dept, sender_name, party_id, doc_no, normalized_doc_no, doc_date,
                                        amount, assigned_to, due_date, notes, tags, mailbox, email_from, email_subject, email_message_id, email_received_at, email_attachment_ref, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.doc_type, b.channel, b.receipt_date, uid, b.received_dept, b.sender_name, b.party_id, b.doc_no, b.doc_no ? normNo(b.doc_no) : null, b.doc_date ?? null,
       b.amount === null ? null : r2(n(b.amount)), b.assigned_to, b.due_date ?? null, b.notes, b.tags, b.mailbox, b.email_from, b.email_subject, b.email_message_id,
       b.email_received_at ? String(b.email_received_at).replace('T', ' ').slice(0, 19) : null, b.email_attachment_ref, uid]);
    const id = r.insertId as number;
    const dn = await duplicateNote(tx, cid, id, b);
    if (dn) { await txExecute(tx, 'UPDATE trx_document_inward SET duplicate_note = ? WHERE id = ?', [dn.slice(0, 255), id]); notices.push(`Duplicate suspected: ${dn}`); }
    let att = null;
    if (b.file) { att = await attachToInward(tx, req, cid, { id }, b.file); if (att.note) notices.push(`Duplicate file: ${att.note}`); }
    await refreshInward(tx, cid, id);
    await ownerDefaults(tx, cid, id, uid);
    return { id, no, att };
  });
  const row = await docRow(cid, out.id);
  await audit(req, 'trx_document_inward', out.id, 'INSERT', undefined, { ...row, attachment_sha256: out.att?.sha256 ?? null });
  res.status(201).json({ data: { ...row, attachment: out.att ? { id: out.att.id, sha256: out.att.sha256, duplicate: out.att.duplicate } : null },
    notices: notices.length ? notices : undefined, message: `${out.no} registered${row.completeness !== 'COMPLETE' ? ` — ${row.completeness.replace(/_/g, ' ').toLowerCase()}` : ''}` });
}));

documentInwardRouter.put('/document-inward/:id', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const uid = uidOf(req);
  const before = await queryOne<any>('SELECT * FROM trx_document_inward WHERE id = ? AND company_id = ?', [id, cid]);
  if (!before) throw NotFound('Inward document not found');
  if (before.status !== 'ACTIVE') throw BadRequest(`${before.inward_no} is ${before.status.toLowerCase()} — it cannot be edited`);
  const b = docSchema.parse({ ...req.body, file: null });
  validate(b);
  b.received_dept = await masterDept(cid, b.received_dept, before.received_dept);
  const notices: string[] = [];
  await transaction(async (tx) => {
    const r = await txExecute(tx,
      `UPDATE trx_document_inward SET doc_type = ?, channel = ?, receipt_date = ?, received_dept = ?, sender_name = ?, party_id = ?, doc_no = ?, normalized_doc_no = ?, doc_date = ?,
              amount = ?, assigned_to = ?, due_date = ?, notes = ?, tags = ?, mailbox = ?, email_from = ?, email_subject = ?, email_message_id = ?, email_received_at = ?,
              email_attachment_ref = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ? AND company_id = ? ${b.row_version ? 'AND row_version = ?' : ''}`,
      [b.doc_type, b.channel, b.receipt_date, b.received_dept, b.sender_name, b.party_id, b.doc_no, b.doc_no ? normNo(b.doc_no) : null, b.doc_date ?? null,
       b.amount === null ? null : r2(n(b.amount)), b.assigned_to, b.due_date ?? null, b.notes, b.tags, b.mailbox, b.email_from, b.email_subject, b.email_message_id,
       b.email_received_at ? String(b.email_received_at).replace('T', ' ').slice(0, 19) : null, b.email_attachment_ref, uid, id, cid, ...(b.row_version ? [b.row_version] : [])]);
    if (!r.affectedRows) throw Conflict(`${before.inward_no} was changed by someone else — reload and try again`);
    if (before.duplicate_cleared === 0 || normNo(b.doc_no) !== before.normalized_doc_no || Number(b.party_id ?? 0) !== Number(before.party_id ?? 0)) {
      const dn = await duplicateNote(tx, cid, id, b);
      const fileDup = before.duplicate_note && String(before.duplicate_note).startsWith('The same file') ? before.duplicate_note : null;
      await txExecute(tx, 'UPDATE trx_document_inward SET duplicate_note = ?, duplicate_cleared = IF(? IS NULL, duplicate_cleared, 0) WHERE id = ?', [(dn ?? fileDup)?.slice(0, 255) ?? null, dn ?? fileDup, id]);
      if (dn) notices.push(`Duplicate suspected: ${dn}`);
    }
    await refreshInward(tx, cid, id);
    await ownerDefaults(tx, cid, id, uid);
  });
  const row = await docRow(cid, id);
  await audit(req, 'trx_document_inward', id, 'UPDATE', before, row);
  res.json({ data: row, notices: notices.length ? notices : undefined, message: `${row.inward_no} saved` });
}));

documentInwardRouter.post('/document-inward/:id/attachments', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const f = fileSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const d = await txQueryOne<any>(tx, 'SELECT * FROM trx_document_inward WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!d) throw NotFound('Inward document not found');
    if (d.status !== 'ACTIVE') throw BadRequest(`${d.inward_no} is ${d.status.toLowerCase()}`);
    const a = await attachToInward(tx, req, cid, d, f);
    await refreshInward(tx, cid, id);
    return a;
  });
  res.status(201).json({ data: { id: out.id, sha256: out.sha256, duplicate: out.duplicate, inward: await docRow(cid, id) },
    notices: out.note ? [`Duplicate file: ${out.note}`] : out.duplicate ? [`Same file is also on ${out.duplicate.where}`] : undefined, message: 'File attached' });
}));

// ================================================================== links
documentInwardRouter.post('/document-inward/:id/links', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ target_type: z.enum(DOC_LINK_TYPES), target_id: z.coerce.number().int().positive(), note: strOpt(255) }).parse(req.body);
  if (b.target_type === 'INWARD' && b.target_id === id) throw BadRequest('A document cannot be linked to itself');
  const lid = await transaction(async (tx) => {
    const d = await txQueryOne<any>(tx, 'SELECT * FROM trx_document_inward WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!d) throw NotFound('Inward document not found');
    if (d.status !== 'ACTIVE') throw BadRequest(`${d.inward_no} is ${d.status.toLowerCase()}`);
    const t = await loadTarget(cid, b.target_type === 'INWARD' ? 'DOC_INWARD' : b.target_type, b.target_id, tx);
    if (!t || !Number(t.ok)) throw BadRequest('The document to link is not found or cancelled');
    const same = await txQueryOne(tx, 'SELECT id FROM trx_document_link WHERE inward_id = ? AND target_type = ? AND target_id = ? AND removed_at IS NULL', [id, b.target_type, b.target_id]);
    if (same) throw BadRequest('Already linked');
    const r = await txExecute(tx, 'INSERT INTO trx_document_link (company_id, inward_id, target_type, target_id, target_no, note, linked_by) VALUES (?,?,?,?,?,?,?)',
      [cid, id, b.target_type, b.target_id, String(t.no ?? '').slice(0, 60), b.note, uidOf(req)]);
    if (!d.party_id && t.party_id) await txExecute(tx, 'UPDATE trx_document_inward SET party_id = ? WHERE id = ?', [t.party_id, id]);
    await refreshInward(tx, cid, id);
    if (b.target_type === 'INWARD') await refreshInward(tx, cid, b.target_id);
    return r.insertId as number;
  });
  await audit(req, 'trx_document_link', lid, 'INSERT', undefined, { inward_id: id, ...b });
  res.status(201).json({ data: await docRow(cid, id), message: 'Linked' });
}));

documentInwardRouter.post('/document-inward/:id/links/:lid/remove', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const lid = z.coerce.number().int().positive().parse(req.params.lid);
  const { reason } = reasonSchema.parse(req.body);
  await transaction(async (tx) => {
    const l = await txQueryOne<any>(tx, 'SELECT * FROM trx_document_link WHERE id = ? AND inward_id = ? AND company_id = ? AND removed_at IS NULL', [lid, id, cid]);
    if (!l) throw NotFound('Link not found');
    await txExecute(tx, 'UPDATE trx_document_link SET removed_by = ?, removed_at = NOW(), remove_reason = ? WHERE id = ?', [uidOf(req), reason, lid]);
    await refreshInward(tx, cid, id);
    if (l.target_type === 'INWARD') await refreshInward(tx, cid, Number(l.target_id));
  });
  await audit(req, 'trx_document_link', lid, 'UPDATE', { removed_at: null }, { inward_id: id, removed: true, reason });
  res.json({ data: await docRow(cid, id), message: 'Unlinked' });
}));

/** Link this document (DC, GRN copy, freight proof…) to a tracked bill. */
documentInwardRouter.post('/document-inward/:id/link-bill', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = z.object({ bill_id: z.coerce.number().int().positive(), note: strOpt(255) }).parse(req.body);
  const notice = await transaction(async (tx) => {
    const bill = await lockBill(tx, cid, b.bill_id);
    if (!['OPEN', 'PENDING_VERIFICATION'].includes(bill.workflow_status)) throw BadRequest(`Bill ${bill.entry_no} is ${bill.workflow_status.replace(/_/g, ' ').toLowerCase()} — it cannot take more documents`);
    const l = await addLink(tx, req, bill, { link_type: 'DOC_INWARD', target_id: id, linked_amount: null, linked_qty: null, note: b.note, allow_other_party: false });
    await touched(tx, cid, b.bill_id);
    return l.notice;
  });
  res.status(201).json({ data: await docRow(cid, id), notices: notice ? [notice] : undefined, message: 'Linked to the bill' });
}));

/** Bill-type document → tracked bill (duplicate check applies). */
documentInwardRouter.post('/document-inward/:id/create-bill', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const d = await queryOne<any>('SELECT * FROM trx_document_inward WHERE id = ? AND company_id = ?', [id, cid]);
  if (!d) throw NotFound('Inward document not found');
  if (d.status !== 'ACTIVE') throw BadRequest(`${d.inward_no} is ${d.status.toLowerCase()}`);
  if (!['BILL', 'EMAIL_ATTACHMENT', 'FREIGHT_PROOF', 'OTHER'].includes(d.doc_type)) throw BadRequest('Only a bill (or an emailed bill) is registered as a bill. A DC / GRN copy is linked to a bill instead.');
  const existing = await queryOne<any>(`SELECT entry_no FROM trx_bill_tracker WHERE inward_id = ? AND workflow_status <> 'CANCELLED'`, [id]);
  if (existing) throw BadRequest(`${d.inward_no} is already registered as bill ${existing.entry_no}`);
  if (!d.doc_no) throw BadRequest('Enter the supplier invoice no on the inward document first');
  const o = z.object({ bill_category: z.enum(CATEGORIES).default('PURCHASE') }).passthrough().parse(req.body ?? {});
  const out = await createBill(req, {
    entry_date: d.receipt_date, received_from: 'VENDOR', bill_no: d.doc_no, bill_date: d.doc_date, supplier_id: d.party_id, amount: n(d.amount),
    remarks: d.notes, ...o, inward_id: id,
  });
  res.status(201).json({ data: out.row, notices: out.notices.length ? out.notices : undefined, message: out.message });
}));

// ================================================================== status changes (never deleted)
for (const [action, to] of [['reject', 'REJECTED'], ['cancel', 'CANCELLED']] as const) {
  documentInwardRouter.post(`/document-inward/:id/${action}`, EDIT, ah(async (req, res) => {
    const cid = cidOf(req); const id = idParam(req);
    const { reason } = reasonSchema.parse(req.body);
    const d = await queryOne<any>('SELECT * FROM trx_document_inward WHERE id = ? AND company_id = ?', [id, cid]);
    if (!d) throw NotFound('Inward document not found');
    if (d.status !== 'ACTIVE') throw BadRequest(`${d.inward_no} is already ${d.status.toLowerCase()}`);
    const live = await queryOne<any>(`SELECT b.entry_no FROM trx_bill_tracker b WHERE b.workflow_status <> 'CANCELLED' AND (b.inward_id = ? OR b.id IN
                                       (SELECT l.bill_id FROM trx_bill_tracker_link l WHERE l.link_type = 'DOC_INWARD' AND l.target_id = ? AND l.removed_at IS NULL)) LIMIT 1`, [id, id]);
    if (live) throw BadRequest(`${d.inward_no} is linked to bill ${live.entry_no} — unlink it there first`);
    await transaction(async (tx) => {
      await txExecute(tx, 'UPDATE trx_document_inward SET status = ?, status_reason = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?', [to, reason, uidOf(req), id]);
      await refreshInward(tx, cid, id);
      await txExecute(tx, `UPDATE trx_bill_followup SET status = 'CANCELLED', resolution_note = ?, closed_by = ?, closed_at = NOW() WHERE inward_id = ? AND status = 'OPEN'`, [`Document ${to.toLowerCase()}`, uidOf(req), id]);
    });
    await audit(req, 'trx_document_inward', id, 'UPDATE', { status: 'ACTIVE' }, { status: to, reason });
    res.json({ data: await docRow(cid, id), message: `${d.inward_no} ${to.toLowerCase()}` });
  }));
}

documentInwardRouter.post('/document-inward/:id/clear-duplicate', CLEAR, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const d = await queryOne<any>('SELECT * FROM trx_document_inward WHERE id = ? AND company_id = ?', [id, cid]);
  if (!d) throw NotFound('Inward document not found');
  if (!d.duplicate_note || d.duplicate_cleared) throw BadRequest('No duplicate to clear');
  await transaction(async (tx) => {
    await txExecute(tx, 'UPDATE trx_document_inward SET duplicate_cleared = 1, status_reason = ?, row_version = row_version + 1 WHERE id = ?', [`Not a duplicate: ${reason}`.slice(0, 255), id]);
    await refreshInward(tx, cid, id);
  });
  await audit(req, 'trx_document_inward', id, 'UPDATE', { duplicate_note: d.duplicate_note }, { duplicate_cleared: 1, reason });
  res.json({ data: await docRow(cid, id), message: 'Duplicate flag cleared' });
}));

documentInwardRouter.post('/document-inward/:id/followups', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  if (!(await queryOne('SELECT id FROM trx_document_inward WHERE id = ? AND company_id = ?', [id, cid]))) throw NotFound('Inward document not found');
  const fid = await createFollowup(req, { inward_id: id });
  res.status(201).json({ data: { id: fid }, message: 'Follow-up created' });
}));

// ================================================================== files: authenticated, company-scoped download only
documentInwardRouter.get('/bill-docs/attachments/:id/download', VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const a = await queryOne<any>('SELECT * FROM trx_bill_doc_attachment WHERE id = ? AND company_id = ?', [id, cid]);
  if (!a) throw NotFound('File not found');
  const p = attachmentPath(a.storage_key);
  if (!fs.existsSync(p)) throw NotFound('The file is missing on the server');
  const inline = req.query.inline === '1' && /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(a.mime_type);
  res.setHeader('Content-Type', a.mime_type);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.original_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(p);
}));

documentInwardRouter.post('/bill-docs/attachments/:id/remove', EDIT, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const { reason } = reasonSchema.parse(req.body);
  const a = await queryOne<any>('SELECT * FROM trx_bill_doc_attachment WHERE id = ? AND company_id = ?', [id, cid]);
  if (!a) throw NotFound('File not found');
  if (a.is_removed) throw BadRequest('The file is already removed');
  const locked = await queryOne<any>(
    `SELECT b.entry_no FROM trx_bill_tracker b WHERE b.company_id = ? AND (b.workflow_status IN ('APPROVED','REVERSED') OR b.posting_status = 'POSTED')
        AND (b.id = ? OR b.inward_id = ? OR b.id IN (SELECT l.bill_id FROM trx_bill_tracker_link l WHERE l.link_type = 'DOC_INWARD' AND l.target_id = ? AND l.removed_at IS NULL)) LIMIT 1`,
    [cid, a.bill_id ?? 0, a.inward_id ?? 0, a.inward_id ?? 0]);
  if (locked) throw BadRequest(`Bill ${locked.entry_no} is approved / posted — its documents are kept`);
  await transaction(async (tx) => {
    await txExecute(tx, 'UPDATE trx_bill_doc_attachment SET is_removed = 1, removed_by = ?, removed_at = NOW(), remove_reason = ? WHERE id = ?', [uidOf(req), reason, id]);
    if (a.inward_id) await refreshInward(tx, cid, Number(a.inward_id));
    if (a.bill_id) await touched(tx, cid, Number(a.bill_id));
  });
  await audit(req, 'trx_bill_doc_attachment', id, 'UPDATE', { is_removed: 0 }, { is_removed: 1, reason, bill_id: a.bill_id, inward_id: a.inward_id });
  res.json({ data: { id }, message: 'File removed (kept in history)' });
}));

