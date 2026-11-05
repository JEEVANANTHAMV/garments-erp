/**
 * Purchase order Print / PDF / Email (client voice notes 04-Nov-2026) + Admin → Mail (SMTP) settings.
 *
 *   GET  /purchase-docs/:type/:id/pdf            A4 PO PDF (inline; ?download=1 → attachment; ?template=colour|bw, else the
 *                                                company default PRINT_TEMPLATE)   type = yarn|fabric|trim|general
 *   GET  /purchase-docs/:type/:id/mail-defaults  suggested To / CC / subject / body, SMTP configured?, may it be sent?
 *   GET  /purchase-docs/:type/:id/mail-log       earlier sends of this PO
 *   POST /purchase-docs/:type/:id/email          { to[], cc?[], subject, body } → PDF attached, sent, logged, audited
 *   GET  /settings/mail · PUT /settings/mail · POST /settings/mail/test   (admin: SETTINGS / COMPANY rights)
 *
 * Rights: the PDF / defaults / log need the PO's own VIEW right (yarn / fabric / general → PURCHASE.VIEW,
 * trim → PROCUREMENT.VIEW, same as the PO screens); sending needs CREATE, UPDATE or APPROVE on it.
 * Everything is company scoped — another company's PO is "not found".
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { execute, query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { AppError, BadRequest, Forbidden, NotFound, Unauthorized } from '../../core/errors.js';
import { audit } from '../../core/audit.js';
import { sealSecret } from '../../core/secretBox.js';
import { requireAny } from '../../middleware/auth.js';
import { loadPoDocument, mailBlockReason, pdfFileName, PO_PERMISSION, PO_TYPES, supplierEmails, type PoType } from './poDocument.js';
import { renderPoPdf } from './poPdf.js';
import { companyPrintTemplate, resolvePrintTemplate } from '../../core/print/printCompany.js';
import {
  fillTemplate, isMailConfigured, loadMailSettings, notConfiguredError, publicMailSettings, sendMail, splitEmails,
  DEFAULT_PO_BODY, DEFAULT_PO_SUBJECT,
} from './mailer.js';

export const purchaseDocsRouter = Router();

const MAX_RECIPIENTS = 20;

function parseType(req: Request): PoType {
  const t = String(req.params.type ?? '').toLowerCase();
  if (!(PO_TYPES as readonly string[]).includes(t)) throw NotFound(`Unknown purchase document type "${t}" (yarn, fabric, trim or general)`);
  return t as PoType;
}
const parseId = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid id');
  return id;
};

/** The PO type's own permission (VIEW, or any of the listed actions). */
const requireDocRight = (...actions: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (!req.user) throw Unauthorized();
    const type = parseType(req);
    if (req.user.isSuperAdmin) return next();
    const codes = actions.map((a) => `${PO_PERMISSION[type]}.${a}`);
    if (codes.some((c) => req.user!.permissions.has(c))) return next();
    throw Forbidden(`Requires one of: ${codes.join(', ')}`);
  } catch (e) { next(e); }
};

const userKey = (req: Request) => `u${req.user?.id ?? 0}`;
const sendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: userKey,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many mails sent in a short time — wait a few minutes and try again.' } },
});
const testLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: userKey,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many test mails — wait a few minutes and try again.' } },
});

const fmtDmy = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : d ?? '');

// ===================================================================== PDF
purchaseDocsRouter.get('/purchase-docs/:type/:id/pdf', requireDocRight('VIEW'), ah(async (req, res) => {
  const type = parseType(req);
  const doc = await loadPoDocument(type, parseId(req), req.user!.companyId);
  // ?template=colour|bw for this print, else the company default (Admin → Settings PRINT_TEMPLATE)
  const template = await resolvePrintTemplate(req.user!.companyId, req.query.template);
  const pdf = await renderPoPdf(doc, { template, printedBy: req.user!.fullName || req.user!.username });
  const name = pdfFileName(doc);
  const disposition = req.query.download === '1' || req.query.download === 'true' ? 'attachment' : 'inline';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(pdf.length));
  res.setHeader('Content-Disposition', `${disposition}; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Document-No', encodeURIComponent(doc.no));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Document-No');
  res.end(pdf);
}));

// ===================================================================== mail defaults / log
async function lastSends(companyId: number, docType: string, docId: number, limit = 20) {
  return query<any>(
    `SELECT l.id, l.to_emails, l.cc_emails, l.subject, l.attachment, l.status, l.error_message, l.message_id, l.sent_at,
            u.full_name AS sent_by_name, u.username AS sent_by_username
       FROM trx_document_mail_log l LEFT JOIN mst_user u ON u.id = l.sent_by
      WHERE l.company_id = ? AND l.doc_type = ? AND l.doc_id = ?
      ORDER BY l.sent_at DESC, l.id DESC LIMIT ${Number(limit)}`, [companyId, docType, docId]);
}

purchaseDocsRouter.get('/purchase-docs/:type/:id/mail-defaults', requireDocRight('VIEW'), ah(async (req, res) => {
  const type = parseType(req);
  const cid = req.user!.companyId;
  const doc = await loadPoDocument(type, parseId(req), cid);
  const s = await loadMailSettings(cid);
  const vars = { PO_NO: doc.no, SUPPLIER: doc.supplier.name, COMPANY: doc.company.name, PO_DATE: fmtDmy(doc.date) };
  const last = (await lastSends(cid, doc.docType, doc.id, 1))[0] ?? null;
  res.json({
    data: {
      doc_type: doc.docType, doc_no: doc.no, status: doc.status,
      to: await supplierEmails(doc.supplier.id, cid),
      cc: splitEmails(s?.default_cc),
      subject: fillTemplate(s?.po_subject_tpl || DEFAULT_PO_SUBJECT, vars),
      body: fillTemplate(s?.po_body_tpl || DEFAULT_PO_BODY, vars),
      attachment: pdfFileName(doc),
      supplier_name: doc.supplier.name,
      configured: isMailConfigured(s),
      not_configured_message: isMailConfigured(s) ? null : 'Mail is not set up — Admin → Mail settings',
      blocked_reason: mailBlockReason(doc),
      from: isMailConfigured(s) ? (s.from_name ? `${s.from_name} <${s.from_email}>` : s.from_email) : null,
      last_sent: last,
    },
  });
}));

purchaseDocsRouter.get('/purchase-docs/:type/:id/mail-log', requireDocRight('VIEW'), ah(async (req, res) => {
  const type = parseType(req);
  const cid = req.user!.companyId;
  const doc = await loadPoDocument(type, parseId(req), cid);   // 404 for another company's PO
  res.json({ data: await lastSends(cid, doc.docType, doc.id, 50) });
}));

// ===================================================================== send
const emailList = (max: number) => z.array(z.string().trim().toLowerCase().pipe(z.email('Enter a valid e-mail address'))).max(max);
const sendSchema = z.object({
  to: emailList(MAX_RECIPIENTS).min(1, 'Add at least one recipient'),
  cc: emailList(MAX_RECIPIENTS).optional().default([]),
  subject: z.string().trim().min(1, 'Subject is required').max(300),
  body: z.string().max(20_000).optional().default(''),
});

/** zod issues → 400 with field messages (the brief asks 400 for bad addresses, not the generic 422). */
function parseOr400<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw BadRequest(details[0] ? `${details[0].field ? `${details[0].field}: ` : ''}${details[0].message}` : 'Invalid request', details);
  }
  return r.data;
}

async function logSend(row: {
  companyId: number; docType: string; docId: number; docNo: string; to: string[]; cc: string[]; subject: string;
  attachment: string | null; status: 'SENT' | 'FAILED'; error?: string | null; messageId?: string | null; userId: number;
}) {
  const r = await execute(
    `INSERT INTO trx_document_mail_log
       (company_id, doc_type, doc_id, doc_no, to_emails, cc_emails, subject, attachment, status, error_message, message_id, sent_by, sent_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP())`,   // UTC like the pool (timezone 'Z'), whatever the DB server's zone
    [row.companyId, row.docType, row.docId, row.docNo, row.to.join(', ').slice(0, 2000), row.cc.join(', ').slice(0, 2000) || null,
      row.subject.slice(0, 300), row.attachment, row.status, row.error?.slice(0, 1000) ?? null, row.messageId?.slice(0, 300) ?? null, row.userId]);
  return Number(r.insertId);
}

purchaseDocsRouter.post('/purchase-docs/:type/:id/email', requireDocRight('CREATE', 'UPDATE', 'APPROVE'), sendLimiter, ah(async (req, res) => {
  const type = parseType(req);
  const cid = req.user!.companyId;
  const body = parseOr400(sendSchema, req.body);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const to = uniq(body.to);
  const cc = uniq(body.cc).filter((x) => !to.includes(x));
  if (to.length + cc.length > MAX_RECIPIENTS) throw BadRequest(`At most ${MAX_RECIPIENTS} recipients (To + CC) per mail`);

  const doc = await loadPoDocument(type, parseId(req), cid);
  const blocked = mailBlockReason(doc);
  if (blocked) throw new AppError(409, blocked, 'PO_NOT_SENDABLE');
  const s = await loadMailSettings(cid);
  if (!isMailConfigured(s)) throw notConfiguredError();

  // mailed PDFs always use the company's default template
  const pdf = await renderPoPdf(doc, { template: await companyPrintTemplate(cid), printedBy: req.user!.fullName || req.user!.username });
  const filename = pdfFileName(doc);
  try {
    const info = await sendMail(s, {
      to, cc, subject: body.subject, text: body.body,
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
    });
    const logId = await logSend({ companyId: cid, docType: doc.docType, docId: doc.id, docNo: doc.no, to, cc, subject: body.subject, attachment: filename, status: 'SENT', messageId: info.messageId, userId: req.user!.id });
    await audit(req, 'trx_document_mail_log', logId, 'INSERT', undefined, { action: 'PO_EMAILED', doc_type: doc.docType, doc_id: doc.id, doc_no: doc.no, to, cc, subject: body.subject, message_id: info.messageId });
    res.json({ data: { sent: true, message_id: info.messageId, accepted: info.accepted, rejected: info.rejected, to, cc, attachment: filename, log_id: logId } });
  } catch (e) {
    const msg = (e as Error).message;
    const logId = await logSend({ companyId: cid, docType: doc.docType, docId: doc.id, docNo: doc.no, to, cc, subject: body.subject, attachment: filename, status: 'FAILED', error: msg, userId: req.user!.id });
    await audit(req, 'trx_document_mail_log', logId, 'INSERT', undefined, { action: 'PO_EMAIL_FAILED', doc_type: doc.docType, doc_id: doc.id, doc_no: doc.no, to, cc, error: msg });
    throw e;
  }
}));

// ===================================================================== Admin → Mail (SMTP) settings
const canViewSettings = requireAny('SETTINGS.VIEW', 'COMPANY.VIEW');
const canEditSettings = requireAny('SETTINGS.UPDATE', 'COMPANY.UPDATE');

purchaseDocsRouter.get('/settings/mail', canViewSettings, ah(async (req, res) => {
  res.json({ data: publicMailSettings(await loadMailSettings(req.user!.companyId)) });
}));

const optEmail = z.union([z.literal(''), z.null(), z.string().trim().toLowerCase().pipe(z.email('Enter a valid e-mail address'))]).optional();
const settingsSchema = z.object({
  smtp_host: z.string().trim().max(200).regex(/^[A-Za-z0-9.-]*$/, 'Host name only, e.g. smtp.gmail.com').optional().nullable(),
  smtp_port: z.coerce.number().int().min(1).max(65535).optional(),
  smtp_secure: z.coerce.boolean().optional(),
  smtp_username: z.string().trim().max(200).optional().nullable(),
  /** undefined / '' = keep the stored password; clear_password = remove it */
  smtp_password: z.string().max(500).optional().nullable(),
  clear_password: z.coerce.boolean().optional(),
  from_name: z.string().trim().max(150).optional().nullable(),
  from_email: optEmail,
  reply_to: optEmail,
  default_cc: z.string().trim().max(1000).optional().nullable(),
  po_subject_tpl: z.string().trim().max(300).optional().nullable(),
  po_body_tpl: z.string().max(5000).optional().nullable(),
  is_active: z.coerce.boolean().optional(),
});

purchaseDocsRouter.put('/settings/mail', canEditSettings, ah(async (req, res) => {
  const b = parseOr400(settingsSchema, req.body);
  const cid = req.user!.companyId;
  const before = await loadMailSettings(cid);
  const cc = b.default_cc === undefined ? undefined : splitEmails(b.default_cc);
  if (cc) {
    const bad = cc.filter((x) => !z.email().safeParse(x).success);
    if (bad.length) throw BadRequest(`default_cc: not a valid e-mail address: ${bad.join(', ')}`);
    if (cc.length > 10) throw BadRequest('default_cc: at most 10 addresses');
  }
  const pick = <K extends keyof NonNullable<typeof before>>(k: K, v: unknown) => (v === undefined ? (before ? before[k] : null) : v);
  const host = pick('smtp_host', b.smtp_host === undefined ? undefined : (b.smtp_host || null)) as string | null;
  const fromEmail = pick('from_email', b.from_email === undefined ? undefined : (b.from_email || null)) as string | null;
  const active = b.is_active === undefined ? (before ? Number(before.is_active) : 1) : (b.is_active ? 1 : 0);
  if (active && host && !fromEmail) throw BadRequest('from_email: the sender e-mail address is required');
  const passwordEnc = b.clear_password ? null : b.smtp_password ? sealSecret(b.smtp_password) : (before?.smtp_password_enc ?? null);

  const row = {
    smtp_host: host,
    smtp_port: b.smtp_port ?? before?.smtp_port ?? 587,
    smtp_secure: b.smtp_secure === undefined ? Number(before?.smtp_secure ?? 0) : (b.smtp_secure ? 1 : 0),
    smtp_username: pick('smtp_username', b.smtp_username === undefined ? undefined : (b.smtp_username || null)),
    smtp_password_enc: passwordEnc,
    from_name: pick('from_name', b.from_name === undefined ? undefined : (b.from_name || null)),
    from_email: fromEmail,
    reply_to: pick('reply_to', b.reply_to === undefined ? undefined : (b.reply_to || null)),
    default_cc: cc === undefined ? (before?.default_cc ?? null) : (cc.join(', ') || null),
    po_subject_tpl: pick('po_subject_tpl', b.po_subject_tpl === undefined ? undefined : (b.po_subject_tpl || null)),
    po_body_tpl: pick('po_body_tpl', b.po_body_tpl === undefined ? undefined : (b.po_body_tpl || null)),
    is_active: active,
  };
  const cols = Object.keys(row) as (keyof typeof row)[];
  await execute(
    `INSERT INTO cfg_company_mail (company_id, ${cols.join(', ')}, updated_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
     ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}, updated_by = VALUES(updated_by)`,
    [cid, ...cols.map((c) => row[c] as any), req.user!.id]);
  const after = await loadMailSettings(cid);
  const redact = (s: typeof before) => (s ? { ...publicMailSettings(s) } : null);   // the audit never holds the password either
  await audit(req, 'cfg_company_mail', cid, before ? 'UPDATE' : 'INSERT', redact(before), { ...redact(after), password_changed: !!b.smtp_password || !!b.clear_password });
  res.json({ data: publicMailSettings(after) });
}));

purchaseDocsRouter.post('/settings/mail/test', canEditSettings, testLimiter, ah(async (req, res) => {
  const { to } = parseOr400(z.object({ to: z.string().trim().toLowerCase().pipe(z.email('Enter a valid e-mail address')) }), req.body);
  const cid = req.user!.companyId;
  const s = await loadMailSettings(cid);
  if (!isMailConfigured(s)) throw notConfiguredError();
  const co = await queryOne<any>(`SELECT legal_name, trade_name FROM mst_company WHERE id = ?`, [cid]);
  const info = await sendMail(s, {
    to: [to], subject: `Test mail from ${co?.trade_name || co?.legal_name || 'Garment ERP'}`,
    text: `This is a test mail from the ERP (Admin → Mail settings).\n\nIf you received it, purchase orders can be e-mailed to suppliers from ${s.from_email}.\n\nSent by ${req.user!.fullName || req.user!.username}.`,
  });
  await audit(req, 'cfg_company_mail', cid, 'UPDATE', undefined, { action: 'SMTP_TEST', to, message_id: info.messageId });
  res.json({ data: { sent: true, message_id: info.messageId, to } });
}));

