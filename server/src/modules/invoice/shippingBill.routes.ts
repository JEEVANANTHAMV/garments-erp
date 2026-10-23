import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import XLSX from 'xlsx';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { extractShippingBill } from './sbPdf.js';

/**
 * Shipping bill (ICEGATE "LET EXPORT COPY") from the commercial invoice — client voice note 23-Oct-2026 with the
 * yellow-marked PDF: picking the (final) commercial invoice brings the invoice no / date / value / currency / exchange
 * rate / ports / packages; the SB no + date, FOB ₹, freight, insurance, customs exchange rate, DBK claim, IGST amount,
 * RoDTEP and RoSCTL are entered. The incentives are entered here once: they are kept as Finance claims
 * (trx_export_incentive, source SHIPPING_BILL — Finance records what is received / credited) and go to the order P&L.
 */
export const shippingBillRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const iso = (d: unknown) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optDate = z.union([dateStr, z.literal(''), z.null()]).transform((v) => v || null).nullish();
const money = z.coerce.number().min(0, 'Cannot be negative').nullish();

/** Incentives kept by a shipping bill (claim amount = the shipping bill's figure). */
const SB_INCENTIVES = [['DUTY_DRAWBACK', 'drawback_amount'], ['RODTEP', 'rodtep_amount'], ['ROSCTL', 'rosctl_amount'], ['GST_REFUND', 'igst_amount']] as const;

/** BRC realisation date: the end of the month, 9 months after the shipping bill (RBI realisation period). */
export function brcDue(sbDate: string) {
  const d = new Date(`${sbDate}T00:00:00Z`);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 10, 0));
  return end.toISOString().slice(0, 10);
}

/** The invoice fields a shipping bill takes over (the non-yellow ones of the client's PDF). */
async function invoiceSource(cid: number, invoiceId: number) {
  const ci = await queryOne<any>(`SELECT ci.*, cu.code AS currency_code, so.so_no, b.party_name AS buyer_name FROM trx_commercial_invoice ci
      LEFT JOIN cfg_currency cu ON cu.id = ci.currency_id LEFT JOIN trx_sales_order so ON so.id = ci.so_id LEFT JOIN mst_party b ON b.id = ci.buyer_id
     WHERE ci.id = ? AND ci.company_id = ?`, [invoiceId, cid]);
  if (!ci) throw NotFound('Commercial invoice not found');
  const ln = await query<any>(`SELECT line_kind, amount, gst_rate FROM trx_commercial_invoice_line WHERE invoice_id = ?`, [invoiceId]);
  const xr = n(ci.exchange_rate);
  const igstValue = r2(ln.reduce((t, l) => t + n(l.amount), 0) * xr);
  const igst = ci.gst_supply_type === 'IGST'
    ? r2(ln.reduce((t, l) => t + r2(n(l.amount) * xr) * n(l.gst_rate ?? (l.line_kind === 'CHARGE' ? ci.charges_gst_rate : ci.goods_gst_rate)) / 100, 0)) : 0;
  return {
    invoice_id: Number(ci.id), invoice_no: ci.invoice_no, invoice_date: iso(ci.invoice_date), doc_status: ci.doc_status, currency_code: ci.currency_code,
    invoice_value_fc: r2(n(ci.total_value)), fob_fc_invoice: r2(n(ci.fob_value) || n(ci.total_value)), exchange_rate: xr || null,
    invoice_term: ci.incoterm ?? null, port_of_loading: ci.port_of_loading, port_of_discharge: ci.port_of_discharge, country_dest: ci.country_dest_text,
    packages: ci.total_cartons, gross_weight_kg: ci.gross_weight_kg == null ? null : n(ci.gross_weight_kg), lut: ci.gst_supply_type === 'LUT',
    igst_value: ci.gst_supply_type === 'IGST' ? igstValue : 0, igst_amount: igst, so_id: ci.so_id, so_no: ci.so_no, buyer_name: ci.buyer_name,
  };
}

/** GET /shipping-bills/invoices — final commercial invoices without a shipping bill (the picker). */
shippingBillRouter.get('/shipping-bills/invoices', requirePermission('EXPORT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query<any>(`SELECT ci.id, ci.invoice_no, ci.invoice_date, ci.total_value, cu.code AS currency_code, b.party_name AS buyer_name, ci.doc_status,
      (SELECT sb.sb_no FROM trx_shipping_bill sb WHERE sb.invoice_id = ci.id LIMIT 1) AS sb_no
     FROM trx_commercial_invoice ci LEFT JOIN cfg_currency cu ON cu.id = ci.currency_id LEFT JOIN mst_party b ON b.id = ci.buyer_id
    WHERE ci.company_id = ? ORDER BY ci.invoice_date DESC, ci.id DESC LIMIT 300`, [cid]);
  res.json({ data: rows.map((r) => ({ ...r, invoice_date: iso(r.invoice_date), selectable: r.doc_status === 'FINAL' && !r.sb_no })) });
}));

shippingBillRouter.get('/shipping-bills/invoice-source/:invoiceId', requirePermission('EXPORT.VIEW'), ah(async (req, res) => {
  res.json({ data: await invoiceSource(req.user!.companyId, Number(req.params.invoiceId)) });
}));

const sbSchema = z.object({
  invoice_id: s.idReq(),
  sb_no: z.string().trim().min(1, 'Enter the shipping bill no').max(40),
  sb_date: dateStr,
  port_code: s.nullableStr(20), mode: z.union([z.enum(['SEA', 'AIR']), z.literal(''), z.null()]).transform((v) => v || null).nullish(),
  port_of_loading: s.nullableStr(80), port_of_discharge: s.nullableStr(80), country_dest: s.nullableStr(60),
  exchange_rate: z.coerce.number().positive('Enter the exchange rate').nullish(),
  fob_inr: money, freight_inr: money, insurance_inr: money,
  drawback_amount: money, igst_value: money, igst_amount: money, rodtep_amount: money, rosctl_amount: money,
  leo_no: s.nullableStr(30), leo_date: optDate, cha_name: s.nullableStr(150), cha_ref: s.nullableStr(60), ad_code: s.nullableStr(20),
  packages: z.coerce.number().int().min(0).nullish(), gross_weight_kg: money, bl_awb_no: s.nullableStr(40), bl_awb_date: optDate,
  brc_due_date: optDate, scheme_code: s.nullableStr(20), remarks: s.nullableStr(500),
  // the customs PDF attached by /shipping-bills/import-pdf (null removes it; left out keeps it)
  sb_pdf_url: z.union([z.string().regex(/^\/uploads\/shipping-bills\/[\w.-]+\.pdf$/, 'Not an uploaded shipping bill PDF'), z.null()]).optional(),
  sb_pdf_name: s.nullableStr(200), sb_pdf_pages: z.coerce.number().int().min(0).nullish(),
  pdf_read_fields: z.record(z.string(), z.unknown()).nullish(),
  row_version: z.coerce.number().int().nullish(),
});
type SbIn = z.infer<typeof sbSchema>;

async function syncIncentives(tx: Tx, cid: number, sbId: number, b: SbIn & { lut: boolean }, invoiceId: number) {
  const warnings: string[] = [];
  for (const [type, k] of SB_INCENTIVES) {
    const amt = type === 'GST_REFUND' && b.lut ? 0 : r2(n((b as any)[k]));
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_export_incentive WHERE company_id = ? AND shipping_bill_id = ? AND incentive_type = ? AND source = 'SHIPPING_BILL' FOR UPDATE`, [cid, sbId, type]);
    if (!cur) {
      if (amt > 0) await txExecute(tx, `INSERT INTO trx_export_incentive (company_id, incentive_type, shipping_bill_id, invoice_id, claim_amount, claim_date, status, source)
          VALUES (?,?,?,?,?,?, 'CLAIMED', 'SHIPPING_BILL')`, [cid, type, sbId, invoiceId, amt, b.sb_date]);
      continue;
    }
    if (amt <= 0 && n(cur.received_amount) <= 0) { await txExecute(tx, `DELETE FROM trx_export_incentive WHERE id = ?`, [cur.id]); continue; }
    if (n(cur.received_amount) > amt + 0.005) warnings.push(`${type.replace('_', ' ')}: ₹${n(cur.received_amount)} already received is more than the new claim ₹${amt}`);
    await txExecute(tx, `UPDATE trx_export_incentive SET claim_amount = ?, invoice_id = ?, claim_date = COALESCE(claim_date, ?) WHERE id = ?`, [amt, invoiceId, b.sb_date, cur.id]);
    await recalcIncentive(tx, Number(cur.id));
  }
  return warnings;
}

async function writeSb(tx: Tx, req: Request, b: SbIn, id: number | null) {
  const cid = req.user!.companyId;
  const src = await invoiceSource(cid, b.invoice_id);
  if (src.doc_status !== 'FINAL') throw BadRequest(`Invoice ${src.invoice_no} is a draft — finalise the commercial invoice first (its values go on the shipping bill)`);
  const other = await txQueryOne<any>(tx, `SELECT id, sb_no FROM trx_shipping_bill WHERE company_id = ? AND invoice_id = ? AND id <> ? FOR UPDATE`, [cid, b.invoice_id, id ?? 0]);
  if (other) throw Conflict(`Invoice ${src.invoice_no} is already on shipping bill ${other.sb_no}`);
  const dup = await txQueryOne<any>(tx, `SELECT id FROM trx_shipping_bill WHERE company_id = ? AND sb_no = ? AND id <> ?`, [cid, b.sb_no, id ?? 0]);
  if (dup) throw Conflict(`Shipping bill no ${b.sb_no} already exists`);
  if (b.sb_date < (src.invoice_date ?? b.sb_date)) throw BadRequest('The shipping bill date is before the invoice date', [{ field: 'sb_date', message: 'Before the invoice' }]);
  if (b.leo_date && b.leo_date < b.sb_date) throw BadRequest('The LEO date is before the shipping bill date', [{ field: 'leo_date', message: 'Before the SB date' }]);
  const xr = src.currency_code === 'INR' ? 1 : n(b.exchange_rate ?? src.exchange_rate);
  if (!(xr > 0)) throw BadRequest(`Enter the exchange rate (₹ per 1 ${src.currency_code})`, [{ field: 'exchange_rate', message: 'Required' }]);
  const freight = r2(n(b.freight_inr)); const ins = r2(n(b.insurance_inr));
  // FOB ₹ = invoice value × rate − freight − insurance (CF / CIF invoices), unless entered from the shipping bill
  const fobInr = b.fob_inr != null ? r2(n(b.fob_inr)) : r2(src.invoice_value_fc * xr - freight - ins);
  if (fobInr <= 0) throw BadRequest('FOB value (₹) must be more than 0 — check freight / insurance');
  const fobFc = r2(fobInr / xr);
  const lut = src.lut;
  if (lut && n(b.igst_amount) > 0) throw BadRequest('The invoice is an export under LUT — IGST amount must be 0', [{ field: 'igst_amount', message: 'LUT export' }]);
  const cols: Record<string, unknown> = {
    sb_no: b.sb_no, sb_date: b.sb_date, invoice_id: b.invoice_id, port_code: b.port_code ?? null, mode: b.mode ?? null,
    port_of_loading: b.port_of_loading ?? src.port_of_loading ?? null, port_of_discharge: b.port_of_discharge ?? src.port_of_discharge ?? null, country_dest: b.country_dest ?? src.country_dest ?? null,
    invoice_no: src.invoice_no, invoice_date: src.invoice_date, currency_code: src.currency_code, invoice_value_fc: src.invoice_value_fc, invoice_term: src.invoice_term,
    exchange_rate: xr, fob_inr: fobInr, fob_fc: fobFc, freight_inr: freight, insurance_inr: ins,
    drawback_amount: r2(n(b.drawback_amount)), igst_value: r2(n(b.igst_value)), igst_amount: lut ? 0 : r2(n(b.igst_amount)), rodtep_amount: r2(n(b.rodtep_amount)), rosctl_amount: r2(n(b.rosctl_amount)),
    lut: lut ? 1 : 0, leo_no: b.leo_no ?? null, leo_date: b.leo_date ?? null, cha_name: b.cha_name ?? null, cha_ref: b.cha_ref ?? null, ad_code: b.ad_code ?? null,
    packages: b.packages ?? src.packages ?? null, gross_weight_kg: b.gross_weight_kg ?? src.gross_weight_kg ?? null, bl_awb_no: b.bl_awb_no ?? null, bl_awb_date: b.bl_awb_date ?? null,
    brc_due_date: b.brc_due_date ?? brcDue(b.sb_date), scheme_code: b.scheme_code ?? null, remarks: b.remarks ?? null,
  };
  if (b.sb_pdf_url !== undefined) {
    Object.assign(cols, { sb_pdf_url: b.sb_pdf_url, sb_pdf_name: b.sb_pdf_url ? b.sb_pdf_name ?? null : null, sb_pdf_pages: b.sb_pdf_url ? b.sb_pdf_pages ?? null : null,
      pdf_read_fields: b.sb_pdf_url && b.pdf_read_fields ? JSON.stringify(b.pdf_read_fields) : null });
  }
  let sbId = id;
  const keys = Object.keys(cols);
  if (id == null) {
    const r = await txExecute(tx, `INSERT INTO trx_shipping_bill (company_id, created_by, ${keys.join(', ')}) VALUES (?,?,${keys.map(() => '?').join(',')})`, [cid, req.user!.id, ...keys.map((k) => cols[k] as any)]);
    sbId = Number(r.insertId);
  } else {
    await txExecute(tx, `UPDATE trx_shipping_bill SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, row_version = row_version + 1 WHERE id = ?`, [...keys.map((k) => cols[k] as any), req.user!.id, id]);
  }
  const warnings = await syncIncentives(tx, cid, sbId!, { ...b, lut }, b.invoice_id);
  if (Math.abs(fobFc - src.fob_fc_invoice) > Math.max(1, src.fob_fc_invoice * 0.02) && b.fob_inr != null) warnings.push(`FOB ${src.currency_code} ${fobFc} differs from the invoice FOB ${src.fob_fc_invoice} by more than 2 %`);
  return { id: sbId!, warnings, fob_inr: fobInr };
}

shippingBillRouter.post('/shipping-bills', requirePermission('EXPORT.CREATE'), ah(async (req, res) => {
  const b = sbSchema.parse(req.body ?? {});
  const out = await transaction((tx) => writeSb(tx, req, b, null));
  await audit(req, 'trx_shipping_bill', out.id, 'INSERT', undefined, b);
  res.status(201).json({ data: out });
}));

shippingBillRouter.put('/shipping-bills/:id', requirePermission('EXPORT.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = sbSchema.parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_shipping_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!cur) throw NotFound('Shipping bill not found');
    if (b.row_version != null && Number(b.row_version) !== Number(cur.row_version)) throw Conflict('This shipping bill was changed by someone else — reload it');
    return writeSb(tx, req, b, id);
  });
  await audit(req, 'trx_shipping_bill', id, 'UPDATE', undefined, b);
  res.json({ data: out });
}));

shippingBillRouter.delete('/shipping-bills/:id', requirePermission('EXPORT.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_shipping_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!cur) throw NotFound('Shipping bill not found');
    const got = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_export_incentive WHERE shipping_bill_id = ? AND (received_amount > 0 OR status = 'CREDITED')`, [id]);
    if (Number(got?.c)) throw BadRequest('An incentive of this shipping bill is already received in Finance — it cannot be deleted');
    const used = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_shipment WHERE shipping_bill_id = ?`, [id]).catch(() => ({ c: 0 }));
    if (Number(used?.c)) throw BadRequest('A shipment uses this shipping bill — remove it there first');
    await txExecute(tx, `DELETE FROM trx_export_incentive WHERE shipping_bill_id = ? AND source = 'SHIPPING_BILL'`, [id]);
    await txExecute(tx, `UPDATE trx_export_incentive SET shipping_bill_id = NULL WHERE shipping_bill_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM trx_shipping_bill WHERE id = ?`, [id]);
  });
  await audit(req, 'trx_shipping_bill', id, 'DELETE');
  res.json({ data: { id, deleted: true } });
}));

/**
 * POST /shipping-bills/import-pdf {filename, data (data URI / base64)} — the customs shipping bill PDF (client voice note
 * 23-Oct-2026: "import it, pick the fields, we correct what is wrong; or attach it for reference"). The file is kept under
 * uploads/shipping-bills (only its link goes in the database); pages 1–2 are read once, here, and the fields come back to
 * fill the form for review — nothing is saved until the user saves the shipping bill. A PDF that cannot be read is still
 * attached (parse_error tells why) and the fields are entered by hand.
 */
const SB_PDF_MAX = 15 * 1024 * 1024;
shippingBillRouter.post('/shipping-bills/import-pdf', requirePermission('EXPORT.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({ filename: z.string().trim().min(1).max(200), data: z.string().min(10), shipping_bill_id: s.id() }).parse(req.body ?? {});
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(b.data);
  const buf = Buffer.from(m ? m[2] : b.data, 'base64');
  if (buf.length > SB_PDF_MAX) throw BadRequest('The PDF is larger than 15 MB');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw BadRequest('This is not a PDF file — upload the shipping bill PDF downloaded from ICEGATE');

  let read: Awaited<ReturnType<typeof extractShippingBill>> | null = null;
  let parseError: string | null = null;
  try { read = await extractShippingBill(buf); } catch (e) { parseError = (e as Error).message || 'The PDF could not be read'; }

  const dir = path.resolve(process.cwd(), 'uploads', 'shipping-bills');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(b.filename, path.extname(b.filename)).replace(/[^\w-]/g, '_').slice(0, 40) || 'shipping_bill';
  const file = `${Date.now()}_${base}_${crypto.randomBytes(4).toString('hex')}.pdf`;
  fs.writeFileSync(path.join(dir, file), buf);

  const f = read?.fields;
  const warnings: string[] = [];
  let invoice: any = null;
  if (f?.invoice_no) {
    const ci = await queryOne<any>(`SELECT ci.id, ci.invoice_no, ci.invoice_date, ci.doc_status, ci.total_value, cu.code AS currency_code,
        (SELECT sb.sb_no FROM trx_shipping_bill sb WHERE sb.invoice_id = ci.id AND sb.id <> ? LIMIT 1) AS sb_no
        FROM trx_commercial_invoice ci LEFT JOIN cfg_currency cu ON cu.id = ci.currency_id
       WHERE ci.company_id = ? AND REPLACE(UPPER(ci.invoice_no), ' ', '') = REPLACE(UPPER(?), ' ', '') LIMIT 1`, [b.shipping_bill_id ?? 0, cid, f.invoice_no]);
    if (!ci) warnings.push(`Invoice ${f.invoice_no} on the PDF is not a commercial invoice here — pick the invoice yourself`);
    else {
      invoice = { id: Number(ci.id), invoice_no: ci.invoice_no, invoice_date: iso(ci.invoice_date), doc_status: ci.doc_status, sb_no: ci.sb_no,
        selectable: ci.doc_status === 'FINAL' && !ci.sb_no };
      if (ci.doc_status !== 'FINAL') warnings.push(`Invoice ${ci.invoice_no} is still a draft — finalise it before saving the shipping bill`);
      if (ci.sb_no) warnings.push(`Invoice ${ci.invoice_no} is already on shipping bill ${ci.sb_no}`);
      if (f.currency_code && ci.currency_code && f.currency_code !== ci.currency_code) warnings.push(`Currency on the PDF is ${f.currency_code}, the invoice is in ${ci.currency_code}`);
      if (f.invoice_value_fc != null && Math.abs(f.invoice_value_fc - n(ci.total_value)) > 0.5) warnings.push(`Invoice value on the PDF ${f.invoice_value_fc} differs from the invoice ${r2(n(ci.total_value))}`);
      if (f.invoice_date && iso(ci.invoice_date) && f.invoice_date !== iso(ci.invoice_date)) warnings.push(`Invoice date on the PDF ${f.invoice_date} differs from the invoice ${iso(ci.invoice_date)}`);
    }
  }
  if (f?.sb_no) {
    const dup = await queryOne<any>(`SELECT id FROM trx_shipping_bill WHERE company_id = ? AND sb_no = ? AND id <> ?`, [cid, f.sb_no, b.shipping_bill_id ?? 0]);
    if (dup) warnings.push(`Shipping bill ${f.sb_no} is already entered`);
  }
  res.json({ data: { file: { url: `/uploads/shipping-bills/${file}`, name: b.filename.slice(0, 200), pages: read?.pages ?? null, size: buf.length },
    fields: f ?? null, found: read?.found ?? 0, parse_error: parseError, invoice, warnings } });
}));

const SB_SELECT = `
  SELECT sb.*, ci.invoice_no AS ci_invoice_no, ci.doc_status AS invoice_status, so.so_no, so.id AS so_id, b.party_name AS buyer_name,
         (SELECT COALESCE(SUM(x.received_amount),0) FROM trx_export_incentive x WHERE x.shipping_bill_id = sb.id) AS incentives_received
    FROM trx_shipping_bill sb
    LEFT JOIN trx_commercial_invoice ci ON ci.id = sb.invoice_id
    LEFT JOIN trx_sales_order so ON so.id = ci.so_id
    LEFT JOIN mst_party b ON b.id = ci.buyer_id`;
const sbOut = (r: any) => ({ ...r, pdf_read_fields: typeof r.pdf_read_fields === 'string' ? JSON.parse(r.pdf_read_fields) : r.pdf_read_fields ?? null, sb_date: iso(r.sb_date), leo_date: iso(r.leo_date), invoice_date: iso(r.invoice_date), bl_awb_date: iso(r.bl_awb_date), brc_due_date: iso(r.brc_due_date),
  incentives_total: r2(n(r.drawback_amount) + n(r.rodtep_amount) + n(r.rosctl_amount)) });

shippingBillRouter.get('/shipping-bills', requirePermission('EXPORT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ q: z.string().trim().max(60).optional(), from: dateStr.optional(), to: dateStr.optional(),
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25) })
    .parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  const w = ['sb.company_id = ?']; const p: unknown[] = [cid];
  if (q.q) { w.push('(sb.sb_no LIKE ? OR ci.invoice_no LIKE ? OR so.so_no LIKE ? OR b.party_name LIKE ?)'); p.push(...Array(4).fill(`%${q.q}%`)); }
  if (q.from) { w.push('sb.sb_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('sb.sb_date <= ?'); p.push(q.to); }
  const where = w.join(' AND ');
  const [rows, tot] = await Promise.all([
    query<any>(`${SB_SELECT} WHERE ${where} ORDER BY sb.sb_date DESC, sb.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p),
    queryOne<any>(`SELECT COUNT(*) c FROM trx_shipping_bill sb LEFT JOIN trx_commercial_invoice ci ON ci.id = sb.invoice_id LEFT JOIN trx_sales_order so ON so.id = ci.so_id LEFT JOIN mst_party b ON b.id = ci.buyer_id WHERE ${where}`, p),
  ]);
  res.json({ data: rows.map(sbOut), pagination: { page: q.page, pageSize: q.pageSize, total: n(tot?.c), totalPages: Math.max(1, Math.ceil(n(tot?.c) / q.pageSize)) } });
}));

shippingBillRouter.get('/shipping-bills/:id', requirePermission('EXPORT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sb = await queryOne<any>(`${SB_SELECT} WHERE sb.id = ? AND sb.company_id = ?`, [Number(req.params.id), cid]);
  if (!sb) throw NotFound('Shipping bill not found');
  const inc = await query<any>(`SELECT * FROM trx_export_incentive WHERE shipping_bill_id = ? ORDER BY id`, [sb.id]);
  res.json({ data: { ...sbOut(sb), incentives: inc.map((x) => ({ ...x, claim_date: iso(x.claim_date), credit_date: iso(x.credit_date) })),
    source: await invoiceSource(cid, Number(sb.invoice_id)).catch(() => null) } });
}));

