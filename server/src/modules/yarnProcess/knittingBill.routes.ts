import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { useGateEntry } from '../../core/inwardControls.js';

/**
 * Knitting job-work bill (Full_Knitting_Module_Developer_Document §22; client voice note 02-Oct-2026):
 * generated from eligible knitting GRNs (fabric KG × rate), one bill from many GRNs. The rate comes
 * from the approved process quotation the knitting DC went out on; a different rate needs a reason.
 * Shown inside Bills Inward with the supplier and process bills.
 */
export const knittingBillRouter = Router();
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const n = (v: unknown) => Number(v ?? 0) || 0;

/** Unbilled knitting GRNs of a knitter, with the quotation rate of their DCs. */
export async function knittingBillSources(cid: number, vendorId?: number | null) {
  const rows = await query<any>(
    `SELECT r.id AS receipt_id, r.receipt_no, r.receipt_date, r.output_qty AS fabric_kg, r.input_qty AS yarn_kg, r.receipt_type, r.party_dc_no, r.bill_id,
            kp.program_no, kp.io_no, g.supplier_id AS vendor_id, p.party_name AS vendor_name, DATEDIFF(CURDATE(), r.receipt_date) AS days,
            (SELECT GROUP_CONCAT(DISTINCT m.dc_no SEPARATOR ', ') FROM trx_knitting_inward_dc m WHERE m.receipt_id = r.id) AS dc_nos,
            (SELECT MAX(kd.rate_per_kg) FROM trx_knitting_inward_dc m JOIN trx_knitting_dc kd ON kd.company_id = r.company_id AND kd.dc_no = m.dc_no WHERE m.receipt_id = r.id) AS quotation_rate,
            (SELECT GROUP_CONCAT(DISTINCT q.quotation_no) FROM trx_knitting_inward_dc m JOIN trx_knitting_dc kd ON kd.company_id = r.company_id AND kd.dc_no = m.dc_no
               JOIN trx_quotation q ON q.id = kd.quotation_id WHERE m.receipt_id = r.id) AS quotation_no,
            b.bill_no, b.status AS bill_status
       FROM trx_process_receipt r JOIN trx_knitting_program kp ON kp.id = r.src_id JOIN trx_grn g ON g.id = r.grn_id LEFT JOIN mst_party p ON p.id = g.supplier_id
       LEFT JOIN trx_knitting_bill b ON b.id = r.bill_id
      WHERE r.company_id = ? AND r.src_type = 'KNITTING_PROGRAM' AND r.receipt_type <> 'ADJUST' AND r.output_qty > 0 AND kp.job_work_type = 'JOB_WORK'
        ${vendorId ? 'AND g.supplier_id = ?' : ''}
      ORDER BY r.receipt_date, r.id`, vendorId ? [cid, vendorId] : [cid]);
  return rows.map((r) => ({ ...r, fabric_kg: r3(n(r.fabric_kg)), quotation_rate: r.quotation_rate != null ? n(r.quotation_rate) : null }));
}

knittingBillRouter.get('/knitting-bill-sources', requireAny('PURCHASE.VIEW', 'PRODUCTION.VIEW'), ah(async (req, res) => {
  const q = z.object({ vendor_id: z.coerce.number().int().positive() }).parse(req.query);
  const rows = (await knittingBillSources(req.user!.companyId, q.vendor_id)).filter((r) => !r.bill_id || r.bill_status === 'CANCELLED');
  res.json({ data: rows });
}));

const billSchema = z.object({
  vendor_id: z.coerce.number().int().positive(),
  bill_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  party_bill_no: z.string().trim().max(60).nullish(),
  gate_inward_id: z.coerce.number().int().positive().nullish(),
  discount_amount: z.coerce.number().min(0).default(0),
  debit_amount: z.coerce.number().min(0).default(0),
  other_charges: z.coerce.number().default(0),
  gst_pct: z.coerce.number().min(0).max(28).default(5),
  rate_change_reason: z.string().trim().max(255).nullish(),
  remarks: z.string().trim().max(1000).nullish(),
  lines: z.array(z.object({ receipt_id: z.coerce.number().int().positive(), rate: z.coerce.number().positive() })).min(1, 'Pick the knitting GRNs to bill'),
});

knittingBillRouter.get('/knitting-bills', requireAny('PURCHASE.VIEW', 'PRODUCTION.VIEW'), ah(async (req, res) => {
  res.json({ data: await query<any>(`SELECT b.*, p.party_name vendor_name, (SELECT COUNT(*) FROM trx_knitting_bill_line l WHERE l.bill_id = b.id) line_count,
                                            (SELECT SUM(l.fabric_kg) FROM trx_knitting_bill_line l WHERE l.bill_id = b.id) fabric_kg
                                       FROM trx_knitting_bill b LEFT JOIN mst_party p ON p.id = b.vendor_id WHERE b.company_id = ? ORDER BY b.id DESC LIMIT 500`, [req.user!.companyId]) });
}));
knittingBillRouter.get('/knitting-bills/:id', requireAny('PURCHASE.VIEW', 'PRODUCTION.VIEW'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = await queryOne<any>(`SELECT b.*, p.party_name vendor_name, g.entry_no gate_entry_no FROM trx_knitting_bill b LEFT JOIN mst_party p ON p.id = b.vendor_id
                                  LEFT JOIN trx_gate_inward g ON g.id = b.gate_inward_id WHERE b.id = ? AND b.company_id = ?`, [id, req.user!.companyId]);
  if (!b) throw NotFound('Knitting bill not found');
  res.json({ data: { ...b, lines: await query<any>('SELECT * FROM trx_knitting_bill_line WHERE bill_id = ? ORDER BY id', [id]) } });
}));

/** POST /knitting-bills — knitting job-work bill from GRNs (fabric KG × rate − discount − debit + other + GST). */
knittingBillRouter.post('/knitting-bills', requireAny('PURCHASE.CREATE', 'PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = billSchema.parse(req.body);
  if (new Set(b.lines.map((l) => l.receipt_id)).size !== b.lines.length) throw BadRequest('A GRN is on the bill twice');
  const src = await knittingBillSources(cid, b.vendor_id);
  const out = await transaction(async (tx) => {
    const gate = b.gate_inward_id ? await useGateEntry(tx, cid, { gate_inward_id: b.gate_inward_id, party_id: b.vendor_id, label: 'Knitting bill' }) : null;
    const no = await nextDocNumber(tx, cid, 'KNIT_BILL');
    const h = await txExecute(tx,
      `INSERT INTO trx_knitting_bill (company_id, bill_no, bill_date, vendor_id, party_bill_no, gate_inward_id, discount_amount, debit_amount, other_charges, gst_pct, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.bill_date, b.vendor_id, b.party_bill_no ?? null, gate?.id ?? null, r2(b.discount_amount), r2(b.debit_amount), r2(b.other_charges), b.gst_pct, b.remarks ?? null, req.user!.id]);
    const billId = Number(h.insertId);
    let gross = 0;
    const changed: string[] = [];
    for (const l of b.lines) {
      const s = src.find((x) => Number(x.receipt_id) === l.receipt_id);
      if (!s) throw BadRequest('A GRN is not a knitting GRN of this knitter');
      const cur = await txQueryOne<any>(tx, 'SELECT r.bill_id, kb.status FROM trx_process_receipt r LEFT JOIN trx_knitting_bill kb ON kb.id = r.bill_id WHERE r.id = ? FOR UPDATE', [l.receipt_id]);
      if (cur?.bill_id && cur.status !== 'CANCELLED') throw BadRequest(`${s.receipt_no} is already billed`);
      if (s.quotation_rate != null && Math.abs(s.quotation_rate - l.rate) > 0.005) changed.push(`${s.receipt_no} ₹${s.quotation_rate} → ₹${l.rate}`);
      const amt = r2(s.fabric_kg * l.rate);
      await txExecute(tx, `INSERT INTO trx_knitting_bill_line (bill_id, receipt_id, receipt_no, receipt_date, program_no, io_no, dc_nos, fabric_kg, quotation_rate, rate, amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [billId, l.receipt_id, s.receipt_no, String(s.receipt_date).slice(0, 10), s.program_no, s.io_no, s.dc_nos, s.fabric_kg, s.quotation_rate, l.rate, amt]);
      await txExecute(tx, 'UPDATE trx_process_receipt SET bill_id = ? WHERE id = ?', [billId, l.receipt_id]);
      gross += amt;
    }
    if (changed.length && (!b.rate_change_reason || b.rate_change_reason.length < 3)) {
      throw BadRequest(`The rate differs from the approved quotation (${changed.join('; ')}) — give the reason for the change`);
    }
    const taxable = r2(gross - b.discount_amount - b.debit_amount + b.other_charges);
    const gst = r2(taxable * b.gst_pct / 100);
    const net = r2(taxable + gst);
    await txExecute(tx, `UPDATE trx_knitting_bill SET gross_amount = ?, gst_amount = ?, net_amount = ?, remarks = CONCAT(COALESCE(remarks, ''), ?) WHERE id = ?`,
      [r2(gross), gst, net, changed.length ? `\nRate changed from quotation (${changed.join('; ')}): ${b.rate_change_reason}` : '', billId]);
    return { id: billId, bill_no: no, gross_amount: r2(gross), gst_amount: gst, net_amount: net, rate_changes: changed };
  });
  await audit(req, 'trx_knitting_bill', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.bill_no} posted — net ₹${out.net_amount}` });
}));

knittingBillRouter.post('/knitting-bills/:id/cancel', requireAny('PURCHASE.DELETE', 'PURCHASE.APPROVE', 'PRODUCTION.APPROVE'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const reason = z.string().trim().min(3, 'Reason is mandatory').max(255).parse(req.body?.reason);
  const b = await transaction(async (tx) => {
    const b = await txQueryOne<any>(tx, 'SELECT * FROM trx_knitting_bill WHERE id = ? AND company_id = ? FOR UPDATE', [id, req.user!.companyId]);
    if (!b) throw NotFound('Knitting bill not found');
    if (b.status === 'CANCELLED') throw BadRequest(`${b.bill_no} is already cancelled`);
    await txExecute(tx, 'UPDATE trx_process_receipt SET bill_id = NULL WHERE bill_id = ?', [id]);
    await txExecute(tx, `UPDATE trx_knitting_bill SET status = 'CANCELLED', remarks = CONCAT(COALESCE(remarks, ''), ?) WHERE id = ?`, [`\nCancelled: ${reason}`, id]);
    return b;
  });
  await audit(req, 'trx_knitting_bill', id, 'UPDATE', { status: b.status }, { status: 'CANCELLED', reason });
  res.json({ message: `${b.bill_no} cancelled — its GRNs can be billed again` });
}));
