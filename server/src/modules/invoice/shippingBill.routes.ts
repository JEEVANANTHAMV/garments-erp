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
    const ci = await queryOne<any>(`SELECT ci.id, ci.invoice_no, ci.invoice_date, ci.doc_status, ci.total_value, ci.gst_supply_type, cu.code AS currency_code,
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
      if (ci.gst_supply_type === 'LUT' && n(f.igst_amount) > 0) warnings.push(`The PDF shows IGST ₹${f.igst_amount}, but invoice ${ci.invoice_no} is an export under LUT — IGST is kept 0 (check the invoice's GST type)`);
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
  const inc = await query<any>(`SELECT * FROM trx_export_incentive WHERE shipping_bill_id = ? ORDER BY FIELD(incentive_type, 'DUTY_DRAWBACK', 'GST_REFUND', 'ROSCTL', 'RODTEP'), id`, [sb.id]);
  const rcp = inc.length ? await query<any>(`SELECT * FROM trx_export_incentive_receipt WHERE incentive_id IN (${inc.map(() => '?').join(',')}) ORDER BY receipt_date, id`, inc.map((x) => x.id)) : [];
  res.json({ data: { ...sbOut(sb), incentives: inc.map((x) => ({ ...incOut({ ...x, sb_date: iso(sb.sb_date) }),
      receipts: rcp.filter((r) => Number(r.incentive_id) === Number(x.id)).map((r) => ({ ...r, receipt_date: iso(r.receipt_date), amount: n(r.amount) })) })),
    source: await invoiceSource(cid, Number(sb.invoice_id)).catch(() => null) } });
}));

/* ================================================================ Export incentives: claims, receipts, tracker */
/**
 * Client voice note 23-Oct-2026 (late): drawback, IGST refund, RoSCTL and RoDTEP of a shipping bill come on different
 * dates (and sometimes in parts), so each claim keeps its receipts — date, amount, bank UTR / scroll / scrip no. The
 * received amount, last credit date and status follow from the receipts: CLAIMED → PARTIAL → CREDITED. A balance that
 * will not come is SHORT_CLOSED (or the whole claim REJECTED) with a reason. Finance records the receipts; Export and
 * Finance both see the tracker: per shipping bill, each incentive received or pending.
 */
export const exportIncentiveRouter = Router();
const INC_TYPES = ['DUTY_DRAWBACK', 'RODTEP', 'ROSCTL', 'GST_REFUND', 'INTEREST_EQUAL', 'OTHER'] as const;
const INC_LABEL: Record<string, string> = { DUTY_DRAWBACK: 'Drawback', GST_REFUND: 'IGST refund', ROSCTL: 'RoSCTL', RODTEP: 'RoDTEP', INTEREST_EQUAL: 'Interest equalisation', OTHER: 'Other' };
/** The shipping bill's four columns, in the order of the shipping bill screen. */
const TRACK_TYPES = ['DUTY_DRAWBACK', 'GST_REFUND', 'ROSCTL', 'RODTEP'] as const;
const CLOSED = ['CREDITED', 'SHORT_CLOSED', 'REJECTED'];
/** What is still to come: nothing once received in full, short-closed or rejected. */
const outstandingOf = (x: { status: string; claim_amount: unknown; received_amount: unknown }) => (CLOSED.includes(x.status) ? 0 : Math.max(0, r2(n(x.claim_amount) - n(x.received_amount))));
const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const daysSince = (d: string | null) => (d ? Math.max(0, Math.round((Date.parse(`${todayIst()}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000)) : null);

/** Received amount, last credit date and status from the receipts (a closed claim stays closed unless now paid in full). */
async function recalcIncentive(tx: Tx, id: number) {
  const x = await txQueryOne<any>(tx, `SELECT id, status, claim_amount, source FROM trx_export_incentive WHERE id = ? FOR UPDATE`, [id]);
  if (!x) return;
  const s = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(amount), 0) amt, MAX(receipt_date) last FROM trx_export_incentive_receipt WHERE incentive_id = ?`, [id]);
  const got = r2(n(s?.amt)); const claim = r2(n(x.claim_amount));
  let status: string;
  if (claim > 0 && got >= claim - 0.005) status = 'CREDITED';
  else if (x.status === 'SHORT_CLOSED' || x.status === 'REJECTED') status = x.status;
  else if (got > 0) status = 'PARTIAL';
  else status = x.status === 'PENDING' && x.source !== 'SHIPPING_BILL' ? 'PENDING' : 'CLAIMED';
  await txExecute(tx, `UPDATE trx_export_incentive SET received_amount = ?, credit_date = ?, status = ? WHERE id = ?`, [got, s?.last ? iso(s.last) : null, status, id]);
}

const incOut = (r: any) => ({ ...r, claim_date: iso(r.claim_date), credit_date: iso(r.credit_date), sb_date: iso(r.sb_date), label: INC_LABEL[r.incentive_type] ?? r.incentive_type,
  claim_amount: n(r.claim_amount), received_amount: n(r.received_amount), outstanding: outstandingOf(r), short_amount: CLOSED.includes(r.status) ? Math.max(0, r2(n(r.claim_amount) - n(r.received_amount))) : 0,
  pending_days: CLOSED.includes(r.status) ? null : daysSince(iso(r.claim_date ?? r.sb_date)) });

const INC_SELECT = `SELECT x.*, sb.sb_no, sb.sb_date, ci.invoice_no, so.so_no, b.party_name AS buyer_name,
    (SELECT COUNT(*) FROM trx_export_incentive_receipt rr WHERE rr.incentive_id = x.id) AS receipts_count
    FROM trx_export_incentive x LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id
    LEFT JOIN trx_commercial_invoice ci ON ci.id = COALESCE(x.invoice_id, sb.invoice_id) LEFT JOIN trx_sales_order so ON so.id = ci.so_id LEFT JOIN mst_party b ON b.id = ci.buyer_id`;
const listFilter = z.object({ status: z.string().trim().max(20).optional(), incentive_type: z.string().trim().max(20).optional(), q: z.string().trim().max(60).optional(),
  from: dateStr.optional(), to: dateStr.optional() });

/** GET /export-incentives — the claims (one row per incentive); status OPEN = not yet fully received. */
exportIncentiveRouter.get('/export-incentives', requireAny('FINANCE.VIEW', 'EXPORT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = listFilter.parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  const w = ['x.company_id = ?']; const p: unknown[] = [cid];
  if (q.status === 'OPEN') w.push(`x.status IN ('PENDING', 'CLAIMED', 'PARTIAL')`);
  else if (q.status) { w.push('x.status = ?'); p.push(q.status); }
  if (q.incentive_type) { w.push('x.incentive_type = ?'); p.push(q.incentive_type); }
  if (q.q) { w.push('(sb.sb_no LIKE ? OR ci.invoice_no LIKE ? OR x.scrip_no LIKE ? OR so.so_no LIKE ? OR b.party_name LIKE ?)'); p.push(...Array(5).fill(`%${q.q}%`)); }
  if (q.from) { w.push('COALESCE(sb.sb_date, x.claim_date) >= ?'); p.push(q.from); }
  if (q.to) { w.push('COALESCE(sb.sb_date, x.claim_date) <= ?'); p.push(q.to); }
  const rows = await query<any>(`${INC_SELECT} WHERE ${w.join(' AND ')} ORDER BY COALESCE(x.claim_date, sb.sb_date) DESC, x.id DESC LIMIT 1000`, p);
  const out = rows.map(incOut);
  res.json({ data: out, totals: { claimed: r2(out.reduce((t, r) => t + r.claim_amount, 0)), received: r2(out.reduce((t, r) => t + r.received_amount, 0)),
    outstanding: r2(out.reduce((t, r) => t + r.outstanding, 0)), short: r2(out.reduce((t, r) => t + r.short_amount, 0)) } });
}));

/**
 * The tracker: one row per shipping bill with drawback / IGST refund / RoSCTL / RoDTEP — claim, received, last credit
 * date and status of each — and what is pending in all. status=OPEN keeps the shipping bills with something to come.
 */
async function tracker(cid: number, q: z.infer<typeof listFilter>) {
  const w = ['sb.company_id = ?']; const p: unknown[] = [cid];
  if (q.q) { w.push('(sb.sb_no LIKE ? OR ci.invoice_no LIKE ? OR so.so_no LIKE ? OR b.party_name LIKE ?)'); p.push(...Array(4).fill(`%${q.q}%`)); }
  if (q.from) { w.push('sb.sb_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('sb.sb_date <= ?'); p.push(q.to); }
  const sbs = await query<any>(`SELECT sb.id, sb.sb_no, sb.sb_date, sb.port_code, sb.invoice_id, ci.invoice_no, so.so_no, so.id AS so_id, b.party_name AS buyer_name, sb.lut
      FROM trx_shipping_bill sb LEFT JOIN trx_commercial_invoice ci ON ci.id = sb.invoice_id LEFT JOIN trx_sales_order so ON so.id = ci.so_id LEFT JOIN mst_party b ON b.id = ci.buyer_id
     WHERE ${w.join(' AND ')} ORDER BY sb.sb_date DESC, sb.id DESC LIMIT 3000`, p);
  const inc = sbs.length ? await query<any>(`SELECT * FROM trx_export_incentive WHERE company_id = ? AND shipping_bill_id IN (${sbs.map(() => '?').join(',')})`, [cid, ...sbs.map((s) => s.id)]) : [];
  const by = new Map<number, any[]>();
  for (const x of inc) { const k = Number(x.shipping_bill_id); by.set(k, [...(by.get(k) ?? []), x]); }
  const rows = sbs.map((s) => {
    const sbDate = iso(s.sb_date);
    const cells: Record<string, any> = {};
    let claim = 0, got = 0, open = 0, short = 0;
    for (const t of TRACK_TYPES) {
      const xs = (by.get(Number(s.id)) ?? []).filter((x) => x.incentive_type === t);
      if (!xs.length) { cells[t] = null; continue; }
      const c = xs.map((x) => incOut({ ...x, sb_date: sbDate }));
      const cell = { ids: c.map((x) => Number(x.id)), claim: r2(c.reduce((a, x) => a + x.claim_amount, 0)), received: r2(c.reduce((a, x) => a + x.received_amount, 0)),
        outstanding: r2(c.reduce((a, x) => a + x.outstanding, 0)), short: r2(c.reduce((a, x) => a + x.short_amount, 0)),
        last_date: c.map((x) => x.credit_date).filter(Boolean).sort().pop() ?? null,
        status: c.length === 1 ? c[0].status : c.every((x) => CLOSED.includes(x.status)) ? 'CREDITED' : c.some((x) => x.received_amount > 0) ? 'PARTIAL' : 'CLAIMED' };
      cells[t] = cell; claim += cell.claim; got += cell.received; open += cell.outstanding; short += cell.short;
    }
    const any = TRACK_TYPES.some((t) => cells[t]);
    return { shipping_bill_id: Number(s.id), sb_no: s.sb_no, sb_date: sbDate, port_code: s.port_code, invoice_id: s.invoice_id, invoice_no: s.invoice_no, so_id: s.so_id, so_no: s.so_no,
      buyer_name: s.buyer_name, cells, claim: r2(claim), received: r2(got), outstanding: r2(open), short: r2(short),
      status: !any ? 'NONE' : open > 0.005 ? (got > 0 ? 'PARTIAL' : 'PENDING') : 'RECEIVED', pending_days: open > 0.005 ? daysSince(sbDate) : null };
  });
  const st = q.status;
  const shown = rows.filter((r) => (st === 'OPEN' ? r.status === 'PENDING' || r.status === 'PARTIAL' : st ? r.status === st : r.status !== 'NONE'));
  const sumT = (t: string, k: string) => r2(shown.reduce((a, r) => a + n(r.cells[t]?.[k]), 0));
  const totals = { claim: r2(shown.reduce((a, r) => a + r.claim, 0)), received: r2(shown.reduce((a, r) => a + r.received, 0)), outstanding: r2(shown.reduce((a, r) => a + r.outstanding, 0)),
    short: r2(shown.reduce((a, r) => a + r.short, 0)),
    by_type: Object.fromEntries(TRACK_TYPES.map((t) => [t, { claim: sumT(t, 'claim'), received: sumT(t, 'received'), outstanding: sumT(t, 'outstanding') }])),
    pending_bills: shown.filter((r) => r.outstanding > 0.005).length };
  return { rows: shown, totals };
}

exportIncentiveRouter.get('/export-incentives/tracker', requireAny('FINANCE.VIEW', 'EXPORT.VIEW'), ah(async (req, res) => {
  const q = listFilter.parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  const out = await tracker(req.user!.companyId, q);
  res.json({ data: out.rows, totals: out.totals, types: TRACK_TYPES.map((t) => ({ value: t, label: INC_LABEL[t] })) });
}));

/** GET /export-incentives/tracker.xlsx — the tracker for the accounts team (same filters). */
exportIncentiveRouter.get('/export-incentives/tracker.xlsx', requireAny('FINANCE.VIEW', 'EXPORT.VIEW'), ah(async (req, res) => {
  const q = listFilter.parse(Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
  const { rows, totals } = await tracker(req.user!.companyId, q);
  const STATUS: Record<string, string> = { CLAIMED: 'Pending', PENDING: 'Pending', PARTIAL: 'Part received', CREDITED: 'Received', SHORT_CLOSED: 'Short-closed', REJECTED: 'Rejected' };
  const head1 = ['SB No', 'SB Date', 'Invoice', 'Order', 'Buyer'];
  for (const t of TRACK_TYPES) head1.push(`${INC_LABEL[t]} claim`, `${INC_LABEL[t]} received`, `${INC_LABEL[t]} date`, `${INC_LABEL[t]} status`);
  head1.push('Total claim', 'Total received', 'Pending', 'Short / rejected', 'Days pending');
  const aoa: (string | number | null)[][] = [[`EXPORT INCENTIVES — RECEIVED / PENDING (as on ${todayIst()})`], [], head1];
  for (const r of rows) {
    const line: (string | number | null)[] = [r.sb_no, r.sb_date, r.invoice_no, r.so_no, r.buyer_name];
    for (const t of TRACK_TYPES) { const c = r.cells[t]; line.push(c ? c.claim : null, c ? c.received : null, c?.last_date ?? null, c ? STATUS[c.status] ?? c.status : '—'); }
    line.push(r.claim, r.received, r.outstanding, r.short, r.pending_days);
    aoa.push(line);
  }
  const tl: (string | number | null)[] = ['TOTAL', '', '', '', ''];
  for (const t of TRACK_TYPES) tl.push(totals.by_type[t].claim, totals.by_type[t].received, '', '');
  tl.push(totals.claim, totals.received, totals.outstanding, totals.short, '');
  aoa.push(tl);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = head1.map((h, i) => ({ wch: i < 5 ? [12, 11, 14, 14, 24][i] : Math.max(11, Math.min(18, h.length)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Incentives');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export_incentives_${todayIst()}.xlsx"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));

async function loadIncentive(cid: number, id: number) {
  const x = await queryOne<any>(`${INC_SELECT} WHERE x.id = ? AND x.company_id = ?`, [id, cid]);
  if (!x) throw NotFound('Incentive claim not found');
  const receipts = await query<any>(`SELECT r.*, u.full_name AS created_by_name FROM trx_export_incentive_receipt r LEFT JOIN mst_user u ON u.id = r.created_by
     WHERE r.incentive_id = ? ORDER BY r.receipt_date, r.id`, [id]);
  return { ...incOut(x), receipts: receipts.map((r) => ({ ...r, receipt_date: iso(r.receipt_date), amount: n(r.amount) })) };
}

exportIncentiveRouter.get('/export-incentives/:id', requireAny('FINANCE.VIEW', 'EXPORT.VIEW'), ah(async (req, res) => {
  res.json({ data: await loadIncentive(req.user!.companyId, Number(req.params.id)) });
}));

const incSchema = z.object({
  incentive_type: z.enum(INC_TYPES).nullish(),
  shipping_bill_id: s.id(), invoice_id: s.id(), scrip_no: s.nullableStr(60),
  claim_amount: money, claim_date: optDate, remarks: s.nullableStr(500),
});

/** A claim not made by a shipping bill (interest equalisation, an old SB …). */
exportIncentiveRouter.post('/export-incentives', requirePermission('FINANCE.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = incSchema.parse(req.body ?? {});
  if (!b.incentive_type) throw BadRequest('Pick the incentive type');
  if (!(n(b.claim_amount) > 0)) throw BadRequest('Enter the claim amount', [{ field: 'claim_amount', message: 'Required' }]);
  if (b.shipping_bill_id && !(await queryOne(`SELECT id FROM trx_shipping_bill WHERE id = ? AND company_id = ?`, [b.shipping_bill_id, cid]))) throw BadRequest('Shipping bill not found');
  if (b.invoice_id && !(await queryOne(`SELECT id FROM trx_commercial_invoice WHERE id = ? AND company_id = ?`, [b.invoice_id, cid]))) throw BadRequest('Invoice not found');
  const r = await execute(`INSERT INTO trx_export_incentive (company_id, incentive_type, shipping_bill_id, invoice_id, scrip_no, claim_amount, received_amount, claim_date, status, remarks, source)
      VALUES (?,?,?,?,?,?,0,?, 'CLAIMED', ?, 'MANUAL')`, [cid, b.incentive_type, b.shipping_bill_id ?? null, b.invoice_id ?? null, b.scrip_no ?? null, b.claim_amount ?? 0,
    b.claim_date ?? todayIst(), b.remarks ?? null] as any[]);
  const id = Number(r.insertId);
  await audit(req, 'trx_export_incentive', id, 'INSERT', undefined, b);
  res.status(201).json({ data: { id } });
}));

/**
 * Edit a claim's details. A claim made by a shipping bill keeps the shipping bill's type and amount (change them on the
 * shipping bill). What was received is recorded as receipts — not typed here.
 */
exportIncentiveRouter.put('/export-incentives/:id', requirePermission('FINANCE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  if (req.body && (req.body.received_amount != null || req.body.credit_date != null || req.body.status != null)) {
    throw BadRequest('Record what is received as a receipt (date, amount, reference) — the received amount and status follow from the receipts');
  }
  const b = incSchema.parse(req.body ?? {});
  await transaction(async (tx) => {
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_export_incentive WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!cur) throw NotFound('Incentive claim not found');
    const fromSb = cur.source === 'SHIPPING_BILL';
    if (fromSb && b.claim_amount != null && Math.abs(n(b.claim_amount) - n(cur.claim_amount)) > 0.005) throw BadRequest('This claim comes from its shipping bill — change the amount on the shipping bill');
    const claim = fromSb ? n(cur.claim_amount) : n(b.claim_amount ?? cur.claim_amount);
    if (claim + 0.005 < n(cur.received_amount)) throw BadRequest(`₹${n(cur.received_amount)} is already received — the claim cannot be less`);
    await txExecute(tx, `UPDATE trx_export_incentive SET incentive_type = ?, scrip_no = ?, claim_amount = ?, claim_date = ?, remarks = ? WHERE id = ?`,
      [fromSb ? cur.incentive_type : b.incentive_type ?? cur.incentive_type, b.scrip_no !== undefined ? b.scrip_no : cur.scrip_no, claim,
        b.claim_date !== undefined ? b.claim_date : iso(cur.claim_date), b.remarks !== undefined ? b.remarks : cur.remarks, id]);
    await recalcIncentive(tx, id);
    await audit(req, 'trx_export_incentive', id, 'UPDATE', cur, b, tx);
  });
  res.json({ data: await loadIncentive(cid, id) });
}));

const receiptSchema = z.object({
  receipt_date: dateStr, amount: z.coerce.number().positive('Enter the amount received'),
  mode: z.enum(['BANK', 'SCRIP', 'ADJUSTED']).default('BANK'), reference: s.nullableStr(80), remarks: s.nullableStr(300),
});

/** POST /export-incentives/:id/receipts — money (or an e-scrip) received against the claim, on its own date. */
exportIncentiveRouter.post('/export-incentives/:id/receipts', requirePermission('FINANCE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = receiptSchema.parse(req.body ?? {});
  if (b.receipt_date > todayIst()) throw BadRequest('The receipt date is in the future', [{ field: 'receipt_date', message: 'Future date' }]);
  const rid = await transaction(async (tx) => {
    const x = await txQueryOne<any>(tx, `SELECT x.*, sb.sb_date FROM trx_export_incentive x LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id WHERE x.id = ? AND x.company_id = ? FOR UPDATE`, [id, cid]);
    if (!x) throw NotFound('Incentive claim not found');
    if (x.status === 'SHORT_CLOSED' || x.status === 'REJECTED') throw BadRequest(`This claim is ${x.status === 'REJECTED' ? 'rejected' : 'short-closed'} — reopen it first`);
    const from = iso(x.sb_date) ?? iso(x.claim_date);
    if (from && b.receipt_date < from) throw BadRequest(`The receipt date is before the ${x.sb_date ? 'shipping bill' : 'claim'} date (${from})`, [{ field: 'receipt_date', message: 'Too early' }]);
    const open = r2(n(x.claim_amount) - n(x.received_amount));
    if (b.amount > open + 0.005) throw BadRequest(`Only ₹${open.toFixed(2)} is pending on this claim`, [{ field: 'amount', message: `More than pending ₹${open.toFixed(2)}` }]);
    const r = await txExecute(tx, `INSERT INTO trx_export_incentive_receipt (company_id, incentive_id, receipt_date, amount, mode, reference, remarks, created_by) VALUES (?,?,?,?,?,?,?,?)`,
      [cid, id, b.receipt_date, r2(b.amount), b.mode, b.reference ?? null, b.remarks ?? null, req.user!.id]);
    if (b.mode === 'SCRIP' && b.reference && !x.scrip_no) await txExecute(tx, `UPDATE trx_export_incentive SET scrip_no = ? WHERE id = ?`, [b.reference.slice(0, 60), id]);
    await recalcIncentive(tx, id);
    return Number(r.insertId);
  });
  await audit(req, 'trx_export_incentive_receipt', rid, 'INSERT', undefined, { incentive_id: id, ...b });
  res.status(201).json({ data: await loadIncentive(cid, id) });
}));

exportIncentiveRouter.delete('/export-incentives/:id/receipts/:rid', requirePermission('FINANCE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id); const rid = Number(req.params.rid);
  await transaction(async (tx) => {
    const r = await txQueryOne<any>(tx, `SELECT r.* FROM trx_export_incentive_receipt r WHERE r.id = ? AND r.incentive_id = ? AND r.company_id = ? FOR UPDATE`, [rid, id, cid]);
    if (!r) throw NotFound('Receipt not found');
    await txExecute(tx, `DELETE FROM trx_export_incentive_receipt WHERE id = ?`, [rid]);
    await recalcIncentive(tx, id);
    await audit(req, 'trx_export_incentive_receipt', rid, 'DELETE', r, undefined, tx);
  });
  res.json({ data: await loadIncentive(cid, id) });
}));

/** POST /export-incentives/:id/close {action: SHORT_CLOSE | REJECT | REOPEN, reason} — the balance will not come / reopen. */
exportIncentiveRouter.post('/export-incentives/:id/close', requirePermission('FINANCE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ action: z.enum(['SHORT_CLOSE', 'REJECT', 'REOPEN']), reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
  if (b.action !== 'REOPEN' && (b.reason ?? '').length < 3) throw BadRequest('Give the reason', [{ field: 'reason', message: 'Required' }]);
  await transaction(async (tx) => {
    const x = await txQueryOne<any>(tx, `SELECT * FROM trx_export_incentive WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!x) throw NotFound('Incentive claim not found');
    if (b.action === 'REOPEN') {
      if (x.status !== 'SHORT_CLOSED' && x.status !== 'REJECTED') throw BadRequest('The claim is not closed');
      await txExecute(tx, `UPDATE trx_export_incentive SET status = 'CLAIMED', closed_reason = NULL, closed_at = NULL WHERE id = ?`, [id]);
    } else {
      if (CLOSED.includes(x.status)) throw BadRequest(x.status === 'CREDITED' ? 'The claim is fully received' : 'The claim is already closed');
      if (b.action === 'REJECT' && n(x.received_amount) > 0) throw BadRequest('Money is received on this claim — short-close the balance instead');
      if (b.action === 'SHORT_CLOSE' && !(n(x.received_amount) > 0)) throw BadRequest('Nothing is received yet — reject the claim instead');
      await txExecute(tx, `UPDATE trx_export_incentive SET status = ?, closed_reason = ?, closed_at = NOW() WHERE id = ?`, [b.action === 'REJECT' ? 'REJECTED' : 'SHORT_CLOSED', b.reason, id]);
    }
    await recalcIncentive(tx, id);
    await audit(req, 'trx_export_incentive', id, 'UPDATE', { status: x.status }, b, tx);
  });
  res.json({ data: await loadIncentive(cid, id) });
}));

exportIncentiveRouter.delete('/export-incentives/:id', requirePermission('FINANCE.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const cur = await queryOne<any>(`SELECT * FROM trx_export_incentive WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!cur) throw NotFound('Incentive claim not found');
  if (cur.source === 'SHIPPING_BILL') throw BadRequest('This claim belongs to its shipping bill — change the amount there');
  if (n(cur.received_amount) > 0) throw BadRequest('Money was received against this claim — delete its receipts first');
  await query(`DELETE FROM trx_export_incentive WHERE id = ?`, [id]);
  await audit(req, 'trx_export_incentive', id, 'DELETE', cur);
  res.json({ data: { id, deleted: true } });
}));
