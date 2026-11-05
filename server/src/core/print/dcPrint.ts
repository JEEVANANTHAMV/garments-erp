/**
 * Shared bits for every Delivery Challan PDF on the print engine (docPdf.ts) — client voice notes 05-Nov-2026:
 * one design for all DCs, billing (us) + shipping (the party / processor / unit) always printed and never empty,
 * Prepared By / Checked By / Received By, e-way bill details (+ QR only from a verified provider payload),
 * IO No (never Job No), no rate / amount (except a valued challan, decided by the caller).
 *
 *   router.get('/x/:id/print', requirePermission('X.VIEW'), ah(async (req, res) => {
 *     const q = dcPrintQuery.parse(req.query);
 *     const reprint = await countDcPrint(req, 'trx_x', id, dcNo, q.purpose, countable);
 *     const pdf = await renderDocPdf({ ... reprint: reprintLabel(reprint) ... });
 *     sendPdf(res, pdf, dcNo, q);
 *   }));
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../../config/db.js';
import { companyAddressLines } from './printCompany.js';
import type { EwaySpec, PartyBlock, PrintCompany } from './docPdf.js';

const str = (v: unknown) => { const t = String(v ?? '').trim(); return t || null; };

/** ?purpose=preview|print|download &download=1 &template=colour|bw */
export const dcPrintQuery = z.object({
  purpose: z.enum(['preview', 'print', 'download']).default('preview'),
  download: z.coerce.number().int().optional(),
  template: z.string().max(20).optional(),
});
export type DcPrintQuery = z.infer<typeof dcPrintQuery>;

/** "05-Nov-2026 10:24 AM" in IST. */
export function istNowText(d = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod ?? '').toUpperCase()}`.trim();
}
/** DATE / DATETIME / 'YYYY-MM-DD…' → "05-Nov-2026" ('-' when empty). */
export function dmy(v: unknown): string {
  if (!v) return '-';
  const s = v instanceof Date ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString() : String(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(s.slice(5, 7)) - 1] ?? s.slice(5, 7);
  return `${s.slice(8, 10)}-${m}-${s.slice(0, 4)}`;
}
/** UTC DATETIME → "05-Nov-2026 10:24 AM" IST, null when empty. */
export function istText(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(`${String(v).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z'}`);
  return Number.isNaN(d.getTime()) ? null : istNowText(d);
}

/**
 * Counts a print: preview never counts; print / download of a countable (issued) DC writes an audit row and
 * returns its number (1 = first print, 2+ = reprint). No schema change — the count comes from log_audit.
 */
export async function countDcPrint(req: Request, table: string, id: number, docNo: string, purpose: DcPrintQuery['purpose'], countable: boolean): Promise<number> {
  if (purpose === 'preview' || !countable) return 0;
  const cid = req.user!.companyId;
  const prev = await queryOne<any>(
    `SELECT COUNT(*) c FROM log_audit WHERE table_name = ? AND record_id = ? AND company_id = ? AND JSON_EXTRACT(new_values, '$.print_no') IS NOT NULL`,
    [table, id, cid]);
  const no = Number(prev?.c ?? 0) + 1;
  try {
    await execute(`INSERT INTO log_audit (company_id, table_name, record_id, action, old_values, new_values, changed_by, ip_address) VALUES (?,?,?,?,?,?,?,?)`,
      [cid, table, id, 'UPDATE', null, JSON.stringify({ print_no: no, purpose, doc_no: docNo, event: no > 1 ? 'REPRINT' : 'PRINT' }), req.user!.id, req.ip ?? null]);
  } catch (e) { console.error('[print] audit failed:', (e as Error).message); }
  return no;
}
export const reprintLabel = (no: number) => (no > 1 ? `Reprint ${no}` : null);

/** Name of the signed-in user for "Printed by". */
export async function printedBy(req: Request): Promise<string | null> {
  const u = req.user as any;
  if (u?.fullName) return String(u.fullName);
  const me = await queryOne<any>('SELECT full_name, username FROM mst_user WHERE id = ?', [req.user!.id]);
  return me?.full_name ?? me?.username ?? null;
}

export interface PrintParty { id: number; name: string; code: string | null; gstin: string | null; phone: string | null; email: string | null; address: string[] }

/** A party as printed: name, GSTIN, phone and its delivery address (shipping / factory, else default, else any active). */
export async function partyForPrint(cid: number, partyId: number | null | undefined): Promise<PrintParty | null> {
  if (!partyId) return null;
  const p = await queryOne<any>('SELECT id, party_name, legal_name, party_code, gstin, phone, email FROM mst_party WHERE id = ? AND company_id = ?', [partyId, cid]);
  if (!p) return null;
  const a = await queryOne<any>(
    `SELECT * FROM mst_party_address WHERE party_id = ? AND is_active = 1
      ORDER BY address_type IN ('SHIPPING', 'FACTORY', 'WAREHOUSE') DESC, is_default DESC, id LIMIT 1`, [partyId]);
  const address = a ? [a.address_line1, a.address_line2, a.address_line3, [a.city, a.district && a.district !== a.city ? a.district : null, a.state].filter(Boolean).join(', ') + (a.pincode ? ` - ${a.pincode}` : '')]
    .map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  return { id: Number(p.id), name: String(p.party_name || p.legal_name || ''), code: str(p.party_code), gstin: str(p.gstin),
    phone: str(a?.mobile) ?? str(a?.phone) ?? str(p.phone), email: str(p.email), address };
}

/** "GSTIN: …", "Ph: …" lines under a party name. */
export const partyIdLines = (p: { gstin?: string | null; phone?: string | null; code?: string | null } | null, withCode = false) =>
  [withCode && p?.code ? `Code: ${p.code}` : null, p?.gstin ? `GSTIN: ${p.gstin}` : null, p?.phone ? `Ph: ${p.phone}` : null].filter(Boolean) as string[];

/** Address text stored on a document ("line\nline" or "a, b, c") → lines. */
export const addressText = (v: unknown) => String(v ?? '').split(/\n/).map((x) => x.trim()).filter(Boolean);

/**
 * The two address blocks every DC prints: billing = our company; shipping / delivery = the given name + lines,
 * falling back to our own name + address (as the knitting DC) so it is never empty.
 */
export function dcAddresses(company: PrintCompany, ship: { heading?: string; name?: string | null; lines?: string[]; gstin?: string | null } | null): [PartyBlock, PartyBlock] {
  const lines = [...(ship?.lines ?? [])];
  if (ship?.gstin && lines.length && !lines.some((l) => l.includes(ship.gstin!))) lines.push(`GSTIN: ${ship.gstin}`);
  const has = lines.length > 0;
  return [
    { heading: 'Billing Address', name: company.name, lines: companyAddressLines(company) },
    { heading: ship?.heading ?? 'Shipping / Delivery Address', name: has ? (ship?.name || company.name) : company.name,
      lines: has ? lines : companyAddressLines(company) },
  ];
}

/** QR content only from a verified source: a QR string inside an official provider response (never MANUAL entry). */
async function verifiedQr(ewbId: number): Promise<string | null> {
  const evs = await query<any>(`SELECT response FROM trx_eway_bill_event WHERE ewb_id = ? AND ok = 1 AND response IS NOT NULL AND provider <> 'MANUAL' ORDER BY id DESC LIMIT 5`, [ewbId]);
  const find = (o: any, depth = 0): string | null => {
    if (!o || typeof o !== 'object' || depth > 5) return null;
    for (const [k, v] of Object.entries(o)) {
      if (/^(qr|qrcode|qr_code|qrCode|QRCode|qrData)$/i.test(k) && typeof v === 'string' && v.length > 10 && !/^https?:/i.test(v)) return v;
      const x = find(v, depth + 1); if (x) return x;
    }
    return null;
  };
  for (const e of evs) {
    const r = typeof e.response === 'string' ? (() => { try { return JSON.parse(e.response); } catch { return null; } })() : e.response;
    const q = find(r);
    if (q) return q;
  }
  return null;
}

/**
 * The e-way bill panel of a DC: the latest non-cancelled e-way bill of the e-way bill module for the document
 * (source_type / source_id; for a DC type it has no source for, a MANUAL one made against the DC number), else the
 * e-way bill number typed on the DC itself (number + vehicle only).
 * null = nothing to print (no empty panel).
 */
export async function docEway(cid: number, sourceType: string | null, sourceId: number, fallback?: { ewbNo?: string | null; vehicle?: string | null; transporter?: string | null; docNo?: string | null }): Promise<EwaySpec | null> {
  let e = sourceType ? await queryOne<any>(
    `SELECT * FROM trx_eway_bill WHERE company_id = ? AND source_type = ? AND source_id = ? AND status <> 'CANCELLED' ORDER BY status = 'GENERATED' DESC, id DESC LIMIT 1`,
    [cid, sourceType, sourceId]) : null;
  // a DC type the e-way bill module has no source for: a MANUAL e-way bill made against this DC number
  if (!e && str(fallback?.docNo)) {
    e = await queryOne<any>(
      `SELECT * FROM trx_eway_bill WHERE company_id = ? AND source_type = 'MANUAL' AND (source_no = ? OR document_number = ?) AND status <> 'CANCELLED' ORDER BY status = 'GENERATED' DESC, id DESC LIMIT 1`,
      [cid, fallback!.docNo, String(fallback!.docNo).replace(/[^A-Za-z0-9/-]/g, '').slice(-16)]);
  }
  if (e && (e.ewb_no || !str(fallback?.ewbNo))) {
    const until = e.valid_upto ? new Date(`${String(e.valid_upto instanceof Date ? e.valid_upto.toISOString() : e.valid_upto).replace(' ', 'T').replace(/Z?$/, 'Z')}`) : null;
    const expired = !!until && !Number.isNaN(until.getTime()) && until.getTime() < Date.now();
    const qr = e.status === 'GENERATED' && e.ewb_no ? await verifiedQr(Number(e.id)) : null;
    return {
      title: 'E-Way Bill',
      fields: [
        ['E-Way Bill No.', e.ewb_no || (e.status === 'DRAFT' ? 'Pending (draft)' : '-')],
        ['E-Way Bill Date', istText(e.ewb_date) ?? '-'],
        ['Valid Until', e.valid_upto ? `${istText(e.valid_upto) ?? '-'}${expired ? '  (EXPIRED)' : ''}` : '-'],
        ['Approx. Distance', Number(e.distance_km) ? `${Number(e.distance_km)} KM` : '-'],
        ['Transport Mode', e.transport_mode || '-'],
        ['Transporter', e.transporter_name || '-'],
        ['Transporter GSTIN', e.transporter_id || '-'],
        ['Vehicle No.', e.vehicle_no || '-'],
      ],
      qrPayload: qr,
      qrCaption: 'E-Way Bill QR',
    };
  }
  if (str(fallback?.ewbNo)) {
    return {
      title: 'E-Way Bill',
      fields: [['E-Way Bill No.', String(fallback!.ewbNo).trim()], ['Vehicle No.', str(fallback?.vehicle) ?? '-'], ['Transporter', str(fallback?.transporter) ?? '-']],
      qrPayload: null,
    };
  }
  return null;
}

/** Sends the PDF (inline for preview / print, attachment for download). */
export function sendPdf(res: Response, pdf: Buffer, docNo: string, q: DcPrintQuery) {
  const name = `${String(docNo || 'DC').replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(pdf.length));
  res.setHeader('Content-Disposition', `${q.download || q.purpose === 'download' ? 'attachment' : 'inline'}; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.end(pdf);
}

/** Watermark for a document status (DRAFT / CANCELLED), null otherwise. */
export const statusWatermark = (status: unknown) => {
  const s = String(status ?? '').toUpperCase();
  return s === 'CANCELLED' ? 'CANCELLED' : s === 'DRAFT' ? 'DRAFT' : null;
};
/** "PARTIAL_RECEIVED" → "Partial received". */
export const humanStatus = (v: unknown) => { const s = String(v ?? '').replace(/_/g, ' ').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
