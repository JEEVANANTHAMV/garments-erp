import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { PAYMENT_MODES, UTR_RE } from '../../core/supplierBillRules.js';

/**
 * Bills Inward — payment reference after approval (client voice note 05-Nov-2026):
 *   "Once the bill is approved its values must not change (we auto-post to Tally). The only thing after approval:
 *    when we pay, mark it paid and save the bank reference / UTR number."
 *
 *   POST /supplier-bills/:id/mark-paid        APPROVED → PAID with paid date, mode, bank ref / UTR, amount, our bank a/c
 *   POST /supplier-bills/:id/reverse-payment  PAID → APPROVED with a reason (wrong entry); payment fields cleared, audited
 * Mounted before the generic /supplier-bills resource, whose PUT refuses APPROVED → PAID (supplierBillRules.ts).
 */
export const supplierBillPaymentRouter = Router();

const TABLE = 'trx_supplier_bill';
const PAY_COLS = ['status', 'paid_date', 'payment_mode', 'payment_ref', 'paid_amount', 'paid_bank_account_id', 'payment_remarks', 'paid_by', 'paid_at'];

/** Today in business time (India). */
function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const markPaidSchema = z.object({
  paid_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the paid date'),
  payment_mode: z.enum(PAYMENT_MODES, { message: `Payment mode must be one of ${PAYMENT_MODES.join(', ')}` }),
  payment_ref: z.string().trim().max(30).optional().nullable(),
  paid_amount: z.coerce.number().positive('Paid amount must be more than 0').optional().nullable(),
  paid_bank_account_id: z.coerce.number().int().positive().optional().nullable(),
  payment_remarks: z.string().trim().max(300).optional().nullable(),
});

const pick = (row: any) => Object.fromEntries(PAY_COLS.map((k) => [k, row?.[k] ?? null]));

supplierBillPaymentRouter.post('/supplier-bills/:id/mark-paid', requirePermission('PURCHASE.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const parsed = markPaidSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw BadRequest(parsed.error.issues[0]?.message || 'Invalid payment details', parsed.error.issues);
  const b = parsed.data;
  const ref = (b.payment_ref ?? '').replace(/\s+/g, '').toUpperCase();
  const mode = b.payment_mode;

  if (mode !== 'CASH') {
    if (!ref) throw BadRequest(mode === 'CHEQUE' ? 'Enter the cheque number' : 'Enter the bank reference / UTR number');
    if (mode === 'CHEQUE' ? !/^[A-Za-z0-9]{6,22}$/.test(ref) : !UTR_RE.test(ref)) {
      throw BadRequest(mode === 'CHEQUE'
        ? 'Cheque number must be 6–22 letters / digits'
        : 'Bank reference / UTR must be 8–22 letters / digits (no spaces or symbols)');
    }
  } else if (ref && !/^[A-Za-z0-9/-]{1,30}$/.test(ref)) {
    throw BadRequest('Cash receipt / voucher reference: letters, digits, / and - only');
  }

  const out = await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, 
      `SELECT t.*, DATE_FORMAT(t.bill_date, '%Y-%m-%d') AS bill_date_s FROM ${TABLE} t WHERE t.id = ? AND t.company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Bill not found');
    const no = bill.bill_no || `Bill #${id}`;
    if (bill.status === 'PAID') throw BadRequest(`${no} is already paid${bill.payment_ref ? ` (ref ${bill.payment_ref})` : ''}`);
    if (bill.status !== 'APPROVED') throw BadRequest(`${no} is ${String(bill.status || 'DRAFT').toLowerCase()} — only an approved bill is marked paid`);

    if (b.paid_date > todayIst()) throw BadRequest('Paid date cannot be in the future');
    if (bill.bill_date_s && b.paid_date < bill.bill_date_s) throw BadRequest(`Paid date cannot be before the bill date (${bill.bill_date_s})`);

    const total = Math.round(Number(bill.total_amount || 0) * 100) / 100;
    const paid = b.paid_amount == null ? total : Math.round(Number(b.paid_amount) * 100) / 100;
    if (Math.abs(paid - total) > 0.01) {
      throw BadRequest(`Paid amount ${paid.toFixed(2)} must equal the bill total ${total.toFixed(2)} — a bill is marked paid in full (part payments are not tracked on the bill)`);
    }

    if (b.paid_bank_account_id) {
      const acc = await txQueryOne<any>(tx, 'SELECT id FROM mst_company_bank_account WHERE id = ? AND company_id = ? AND is_active = 1', [b.paid_bank_account_id, cid]);
      if (!acc) throw BadRequest('Pick one of our active bank accounts');
    } else if (mode !== 'CASH') {
      const n = await txQueryOne<any>(tx, 'SELECT COUNT(*) n FROM mst_company_bank_account WHERE company_id = ? AND is_active = 1', [cid]);
      if (Number(n?.n) > 0) throw BadRequest('Pick the bank account the payment was made from');
    }

    if (ref) {
      const dup = await txQueryOne<any>(tx, 
        `SELECT bill_no FROM ${TABLE} WHERE company_id = ? AND id <> ? AND status = 'PAID' AND payment_ref = ? LIMIT 1 FOR UPDATE`, [cid, id, ref]);
      if (dup) throw Conflict(`Reference ${ref} is already used on paid bill ${dup.bill_no} — check the UTR / reference number`);
    }

    await txExecute(tx,
      `UPDATE ${TABLE} SET status = 'PAID', paid_date = ?, payment_mode = ?, payment_ref = ?, paid_amount = ?, paid_bank_account_id = ?,
              payment_remarks = ?, paid_by = ?, paid_at = NOW(), updated_by = ? WHERE id = ? AND company_id = ?`,
      [b.paid_date, mode, ref || null, paid, b.paid_bank_account_id || null, b.payment_remarks || null, req.user!.id, req.user!.id, id, cid]);
    const after = await txQueryOne<any>(tx, `SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
    await audit(req, TABLE, id, 'UPDATE', { ...pick(bill), action: 'MARK_PAID' }, { ...pick(after), action: 'MARK_PAID' }, tx);
    return after;
  });
  res.json({ data: out, message: `${out.bill_no} marked paid` });
}));

supplierBillPaymentRouter.post('/supplier-bills/:id/reverse-payment', requirePermission('PURCHASE.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const reason = String(req.body?.reason ?? '').trim();
  if (reason.length < 5) throw BadRequest('Enter the reason for reversing the payment (at least 5 characters)');
  if (reason.length > 300) throw BadRequest('Reason: at most 300 characters');

  const out = await transaction(async (tx) => {
    const bill = await txQueryOne<any>(tx, `SELECT * FROM ${TABLE} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!bill) throw NotFound('Bill not found');
    if (bill.status !== 'PAID') throw BadRequest(`${bill.bill_no} is not paid — nothing to reverse`);
    await txExecute(tx,
      `UPDATE ${TABLE} SET status = 'APPROVED', paid_date = NULL, payment_mode = NULL, payment_ref = NULL, paid_amount = NULL,
              paid_bank_account_id = NULL, payment_remarks = NULL, paid_by = NULL, paid_at = NULL,
              payment_reversal_reason = ?, payment_reversed_by = ?, payment_reversed_at = NOW(), updated_by = ?
        WHERE id = ? AND company_id = ?`, [reason, req.user!.id, req.user!.id, id, cid]);
    const after = await txQueryOne<any>(tx, `SELECT * FROM ${TABLE} WHERE id = ?`, [id]);
    await audit(req, TABLE, id, 'UPDATE', { ...pick(bill), action: 'REVERSE_PAYMENT' }, { ...pick(after), action: 'REVERSE_PAYMENT', reason }, tx);
    return after;
  });
  res.json({ data: out, message: `Payment on ${out.bill_no} reversed — the bill is back to approved` });
}));

/** Payment history of a bill (mark paid / reverse entries from the audit trail). */
supplierBillPaymentRouter.get('/supplier-bills/:id/payment-history', requirePermission('PURCHASE.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const bill = await queryOne<any>(`SELECT id FROM ${TABLE} WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!bill) throw NotFound('Bill not found');
  const rows = await query<any>(
    `SELECT a.id, a.changed_at, a.new_values, u.full_name AS user_name
       FROM log_audit a LEFT JOIN mst_user u ON u.id = a.changed_by
      WHERE a.company_id = ? AND a.table_name = ? AND a.record_id = ?
        AND JSON_VALID(a.new_values) AND JSON_UNQUOTE(JSON_EXTRACT(a.new_values, '$.action')) IN ('MARK_PAID', 'REVERSE_PAYMENT')
      ORDER BY a.id DESC LIMIT 50`, [cid, TABLE, id]);
  res.json({ data: rows.map((r) => {
    const v = typeof r.new_values === 'string' ? JSON.parse(r.new_values) : r.new_values;
    return { id: r.id, at: r.changed_at, user_name: r.user_name, action: v?.action, reason: v?.reason ?? null,
      paid_date: v?.paid_date ?? null, payment_mode: v?.payment_mode ?? null, payment_ref: v?.payment_ref ?? null, paid_amount: v?.paid_amount ?? null };
  }) });
}));
