/**
 * Per-company outgoing mail (SMTP) — cfg_company_mail (db/149). Each company sends from its own mail server and
 * address; the password is sealed with AES-256-GCM (core/secretBox) and never leaves the server.
 */
import nodemailer from 'nodemailer';
import { queryOne } from '../../config/db.js';
import { AppError } from '../../core/errors.js';
import { openSecret } from '../../core/secretBox.js';

export const DEFAULT_PO_SUBJECT = 'Purchase Order {PO_NO} - {COMPANY}';
export const DEFAULT_PO_BODY = [
  'Dear {SUPPLIER},',
  '',
  'Please find attached our Purchase Order {PO_NO} dated {PO_DATE}.',
  'Kindly acknowledge receipt and confirm the delivery schedule.',
  '',
  'Regards,',
  '{COMPANY}',
].join('\n');

/** Hard limit on one SMTP send (connect + greet + upload). */
export const SEND_TIMEOUT_MS = 20_000;

export interface MailSettingsRow {
  company_id: number; smtp_host: string | null; smtp_port: number; smtp_secure: number; smtp_username: string | null;
  smtp_password_enc: string | null; from_name: string | null; from_email: string | null; reply_to: string | null;
  default_cc: string | null; po_subject_tpl: string | null; po_body_tpl: string | null; is_active: number;
  updated_by: number | null; updated_at: string | null;
}

export async function loadMailSettings(companyId: number): Promise<MailSettingsRow | null> {
  return queryOne<MailSettingsRow>(`SELECT * FROM cfg_company_mail WHERE company_id = ?`, [companyId]);
}

export const isMailConfigured = (s: MailSettingsRow | null): s is MailSettingsRow =>
  !!(s && Number(s.is_active) && s.smtp_host && s.from_email);

/** Settings as the API shows them: never the password, only whether one is stored. */
export function publicMailSettings(s: MailSettingsRow | null) {
  return {
    smtp_host: s?.smtp_host ?? '',
    smtp_port: s?.smtp_port ?? 587,
    smtp_secure: !!Number(s?.smtp_secure ?? 0),
    smtp_username: s?.smtp_username ?? '',
    has_password: !!s?.smtp_password_enc,
    from_name: s?.from_name ?? '',
    from_email: s?.from_email ?? '',
    reply_to: s?.reply_to ?? '',
    default_cc: s?.default_cc ?? '',
    po_subject_tpl: s?.po_subject_tpl || DEFAULT_PO_SUBJECT,
    po_body_tpl: s?.po_body_tpl || DEFAULT_PO_BODY,
    is_active: s ? !!Number(s.is_active) : true,
    configured: isMailConfigured(s),
    updated_at: s?.updated_at ?? null,
  };
}

export const MAIL_NOT_SET_UP = 'Mail is not set up — Admin → Mail settings';

export function notConfiguredError() {
  return new AppError(409, MAIL_NOT_SET_UP, 'MAIL_NOT_CONFIGURED');
}

/** {PO_NO}, {SUPPLIER}, {COMPANY}, {PO_DATE} … (unknown placeholders are left as typed). */
export function fillTemplate(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{([A-Z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export const splitEmails = (v: string | null | undefined) =>
  String(v ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export interface OutgoingMail {
  to: string[]; cc?: string[]; subject: string; text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

/** Send through the company's SMTP server. Throws AppError(422) with the server's reason when it fails. */
export async function sendMail(s: MailSettingsRow, m: OutgoingMail): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
  const password = s.smtp_password_enc ? openSecret(s.smtp_password_enc) : null;
  if (s.smtp_password_enc && password === null) {
    throw new AppError(409, 'The saved SMTP password can no longer be read (the server key changed) — enter it again in Admin → Mail settings', 'MAIL_PASSWORD_UNREADABLE');
  }
  const transport = nodemailer.createTransport({
    host: s.smtp_host!,
    port: Number(s.smtp_port) || 587,
    secure: !!Number(s.smtp_secure),
    auth: s.smtp_username ? { user: s.smtp_username, pass: password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: SEND_TIMEOUT_MS,
  });
  const from = s.from_name ? { name: s.from_name, address: s.from_email! } : s.from_email!;
  const oneLine = (x: string) => x.replace(/[\r\n]+/g, ' ').trim();
  let timer: NodeJS.Timeout | undefined;
  try {
    const info = await Promise.race([
      transport.sendMail({
        from, to: m.to, cc: m.cc?.length ? m.cc : undefined,
        replyTo: s.reply_to || undefined,
        subject: oneLine(m.subject),
        text: m.text,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${esc(m.text).replace(/\n/g, '<br>')}</div>`,
        attachments: m.attachments,
      }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`the mail server did not answer within ${SEND_TIMEOUT_MS / 1000} seconds`)), SEND_TIMEOUT_MS); }),
    ]);
    return {
      messageId: String(info.messageId ?? ''),
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const err = e as { message?: string; code?: string; responseCode?: number; response?: string };
    const why = err.code === 'EAUTH' ? 'the mail server rejected the username / password'
      : err.code === 'ECONNECTION' || err.code === 'ESOCKET' || err.code === 'ETIMEDOUT' || err.code === 'EDNS' ? `could not connect to ${s.smtp_host}:${s.smtp_port} (${err.message ?? err.code})`
        : err.response || err.message || 'unknown error';
    throw new AppError(422, `Mail not sent: ${String(why).slice(0, 400)}`, 'MAIL_SEND_FAILED');
  } finally {
    if (timer) clearTimeout(timer);
    transport.close();
  }
}
