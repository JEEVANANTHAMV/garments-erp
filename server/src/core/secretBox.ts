/**
 * Encrypt small secrets at rest (e.g. a company's SMTP password) with AES-256-GCM.
 * Key = SHA-256 of MAIL_SECRET_KEY when set, else of the JWT access secret (always present on the server).
 * Changing that secret makes stored values unreadable — the admin then re-enters the password.
 * Stored form: "v1:" + base64(iv) + ":" + base64(tag) + ":" + base64(ciphertext).
 */
import crypto from 'crypto';
import { env } from '../config/env.js';

function key(): Buffer {
  const secret = process.env.MAIL_SECRET_KEY || env.jwt.accessSecret;
  return crypto.createHash('sha256').update(`erp-secret-box:${secret}`).digest();
}

export function sealSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** The plain secret, or null when it cannot be decrypted (key changed / tampered). */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const [v, iv, tag, data] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || data === undefined) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
