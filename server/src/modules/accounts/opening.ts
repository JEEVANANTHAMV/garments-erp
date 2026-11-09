import { Router, type Request } from 'express';
import { z } from 'zod';
import XLSX from 'xlsx';
import { query, queryOne, transaction, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Unprocessable } from '../../core/errors.js';
import { requireAny, requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { r2 } from './voucherEngine.js';

/**
 * Opening balances (go-live item, 09-Nov-2026; spec §7.1 "opening balances require import validation").
 *   GET  /accounts/opening                 current openings (+ Dr / Cr totals and difference)
 *   GET  /accounts/opening/template.xlsx   every active ledger with its opening + a "Pending bills" sheet
 *   POST /accounts/opening/preview         check a filled template — or the balances of the loaded Tally ledger list
 *   POST /accounts/opening/apply           same input, written in one transaction (audited)
 * Bill-wise: a party's pending bills on the books-beginning date (acc_opening_bill). When bills are given, the ledger's
 * opening must equal their total (or is taken from it). Payments made later "against" these bill numbers knock them off.
 */
export const openingRouter = Router();
const VIEW = requireAny('ACCOUNTS.VIEW', 'ACCOUNTS.ENTRY', 'ACCOUNTS.APPROVE', 'ACCOUNTS.ADMIN');
const ADMIN = requirePermission('ACCOUNTS.ADMIN');
const cidOf = (req: Request) => req.user!.companyId;
const D = /^\d{4}-\d{2}-\d{2}$/;

openingRouter.get('/opening', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const rows = await query<any>(`SELECT l.id, l.ledger_name, l.ledger_code, g.group_name, l.opening_balance, l.opening_dr_cr, DATE_FORMAT(l.opening_date,'%Y-%m-%d') opening_date,
        (SELECT COUNT(*) FROM acc_opening_bill b WHERE b.ledger_id = l.id) bills
       FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id WHERE l.company_id = ? AND l.opening_balance <> 0 ORDER BY g.sort_order, l.ledger_name`, [cid]);
  const dr = r2(rows.filter((r) => r.opening_dr_cr === 'DR').reduce((t, r) => t + Number(r.opening_balance), 0));
  const cr = r2(rows.filter((r) => r.opening_dr_cr === 'CR').reduce((t, r) => t + Number(r.opening_balance), 0));
  const bills = await query<any>(`SELECT b.id, b.ledger_id, l.ledger_name, b.bill_ref_no, DATE_FORMAT(b.bill_date,'%Y-%m-%d') bill_date, DATE_FORMAT(b.due_date,'%Y-%m-%d') due_date, b.amount
      FROM acc_opening_bill b JOIN acc_ledger l ON l.id = b.ledger_id WHERE b.company_id = ? ORDER BY l.ledger_name, b.bill_date`, [cid]);
  res.json({ data: { ledgers: rows, bills, total_dr: dr, total_cr: cr, difference: r2(dr - cr) } });
}));

openingRouter.get('/opening/template.xlsx', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const leds = await query<any>(`SELECT l.ledger_name, g.group_name, l.opening_balance, l.opening_dr_cr FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id
      WHERE l.company_id = ? AND l.is_active = 1 ORDER BY g.sort_order, l.ledger_name`, [cid]);
  const bills = await query<any>(`SELECT l.ledger_name, b.bill_ref_no, DATE_FORMAT(b.bill_date,'%Y-%m-%d') d, DATE_FORMAT(b.due_date,'%Y-%m-%d') due, b.amount
      FROM acc_opening_bill b JOIN acc_ledger l ON l.id = b.ledger_id WHERE b.company_id = ? ORDER BY l.ledger_name`, [cid]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Ledger', 'Group (for reference)', 'Dr', 'Cr'],
    ...leds.map((l) => [l.ledger_name, l.group_name, l.opening_dr_cr === 'DR' && Number(l.opening_balance) ? Number(l.opening_balance) : null,
      l.opening_dr_cr === 'CR' && Number(l.opening_balance) ? Number(l.opening_balance) : null]),
  ]), 'Ledger balances');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Party ledger', 'Bill no', 'Bill date (YYYY-MM-DD)', 'Due date (YYYY-MM-DD)', 'Dr', 'Cr'],
    ...bills.map((b) => [b.ledger_name, b.bill_ref_no, b.d, b.due, Number(b.amount) > 0 ? Number(b.amount) : null, Number(b.amount) < 0 ? -Number(b.amount) : null]),
  ]), 'Pending bills');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="opening-balances.xlsx"');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));

const inputSchema = z.object({
  as_on: z.string().regex(D, 'Enter the books-beginning date'),
  source: z.enum(['FILE', 'TALLY']),
  filename: z.string().max(200).optional(),
  content_base64: z.string().optional(),
  tally_company_id: z.coerce.number().int().positive().optional(),
});

interface Plan {
  ledgers: { ledger_id: number; ledger_name: string; amount: number; bills: number }[];
  bills: { ledger_id: number; ledger_name: string; bill_ref_no: string; bill_date: string | null; due_date: string | null; amount: number }[];
  errors: { row: string; message: string }[];
  warnings: string[];
  total_dr: number; total_cr: number; difference: number;
}

const excelDate = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null; }
  const s = String(v).trim();
  if (D.test(s)) return s;
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : 'BAD';
};
const num = (v: unknown) => { if (v == null || v === '') return 0; const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };

async function buildPlan(cid: number, b: z.infer<typeof inputSchema>): Promise<Plan> {
  const leds = await query<any>(`SELECT l.id, l.ledger_name, l.ledger_code, l.tally_name, l.is_bill_wise FROM acc_ledger l WHERE l.company_id = ?`, [cid]);
  const find = (name: string) => {
    const k = name.trim().toLowerCase();
    return leds.find((l) => String(l.ledger_name).toLowerCase() === k) ?? leds.find((l) => String(l.ledger_code).toLowerCase() === k)
      ?? leds.find((l) => l.tally_name && String(l.tally_name).toLowerCase() === k);
  };
  const plan: Plan = { ledgers: [], bills: [], errors: [], warnings: [], total_dr: 0, total_cr: 0, difference: 0 };
  const ledAmt = new Map<number, number>();
  const billSum = new Map<number, number>();
  const seenBill = new Set<string>();
  const addBill = (rowLabel: string, l: any, no: string, date: string | null, due: string | null, amount: number) => {
    if (!no) { plan.errors.push({ row: rowLabel, message: 'Bill no is empty' }); return; }
    if (date === 'BAD' || due === 'BAD') { plan.errors.push({ row: rowLabel, message: 'Dates must be YYYY-MM-DD or DD-MM-YYYY' }); return; }
    if (date && date > b.as_on) { plan.errors.push({ row: rowLabel, message: `Bill date ${date} is after the books-beginning date ${b.as_on}` }); return; }
    const k = `${l.id}|${no.toLowerCase()}`;
    if (seenBill.has(k)) { plan.errors.push({ row: rowLabel, message: `Bill ${no} is listed twice for ${l.ledger_name}` }); return; }
    seenBill.add(k);
    plan.bills.push({ ledger_id: Number(l.id), ledger_name: l.ledger_name, bill_ref_no: no.slice(0, 60), bill_date: date, due_date: due, amount: r2(amount) });
    billSum.set(Number(l.id), r2((billSum.get(Number(l.id)) ?? 0) + amount));
  };

  if (b.source === 'FILE') {
    if (!b.content_base64) throw BadRequest('Choose the filled template');
    const wb = XLSX.read(Buffer.from(b.content_base64, 'base64'), { type: 'buffer' });
    const sheet = (name: string) => wb.Sheets[wb.SheetNames.find((s) => s.toLowerCase().startsWith(name)) ?? ''];
    const bal = sheet('ledger');
    if (!bal) throw BadRequest('The file has no "Ledger balances" sheet — download the template');
    XLSX.utils.sheet_to_json<any[]>(bal, { header: 1, defval: null }).slice(1).forEach((r, i) => {
      const name = String(r[0] ?? '').trim(); if (!name) return;
      const label = `Ledger balances row ${i + 2}`;
      const dr = num(r[2]); const cr = num(r[3]);
      if (Number.isNaN(dr) || Number.isNaN(cr) || dr < 0 || cr < 0) { plan.errors.push({ row: label, message: `${name}: Dr / Cr must be positive numbers` }); return; }
      if (dr && cr) { plan.errors.push({ row: label, message: `${name}: fill either Dr or Cr, not both` }); return; }
      const l = find(name);
      if (!l) { plan.errors.push({ row: label, message: `No ledger "${name}" — create it (Ledgers & groups) or fix the name` }); return; }
      if (ledAmt.has(Number(l.id))) { plan.errors.push({ row: label, message: `${name} is listed twice` }); return; }
      ledAmt.set(Number(l.id), r2(dr - cr));
    });
    const bs = sheet('pending');
    if (bs) XLSX.utils.sheet_to_json<any[]>(bs, { header: 1, defval: null }).slice(1).forEach((r, i) => {
      const name = String(r[0] ?? '').trim(); if (!name) return;
      const label = `Pending bills row ${i + 2}`;
      const l = find(name);
      if (!l) { plan.errors.push({ row: label, message: `No ledger "${name}"` }); return; }
      const dr = num(r[4]); const cr = num(r[5]);
      if (Number.isNaN(dr) || Number.isNaN(cr) || (dr && cr) || (!dr && !cr)) { plan.errors.push({ row: label, message: `${name}: fill the bill amount in Dr or Cr` }); return; }
      addBill(label, l, String(r[1] ?? '').trim(), excelDate(r[2]), excelDate(r[3]), r2(dr - cr));
    });
  } else {
    if (!b.tally_company_id) throw BadRequest('Pick the Tally company whose ledger list was loaded');
    const tl = await query<any>(`SELECT tally_name, opening_balance, bills_json FROM acc_tally_ledger WHERE company_id = ? AND tally_company_id = ?`, [cid, b.tally_company_id]);
    if (!tl.length) throw BadRequest('Load the Tally ledger list first (Tally → Ledger matching)');
    const byName = new Map(tl.map((t) => [String(t.tally_name).toLowerCase(), t]));
    let unmatched = 0;
    for (const l of leds) {
      const t = byName.get(String(l.tally_name || l.ledger_name).toLowerCase());
      if (!t) continue;
      if (t.opening_balance != null) ledAmt.set(Number(l.id), r2(Number(t.opening_balance)));
      const bills = typeof t.bills_json === 'string' ? JSON.parse(t.bills_json) : (t.bills_json ?? []);
      for (const x of bills) addBill(`Tally ${t.tally_name}`, l, String(x.name ?? ''), x.date ?? null, x.due ?? null, Number(x.amount));
    }
    for (const t of tl) if (Number(t.opening_balance) && !leds.some((l) => String(l.tally_name || l.ledger_name).toLowerCase() === String(t.tally_name).toLowerCase())) unmatched += 1;
    if (unmatched) plan.warnings.push(`${unmatched} Tally ledger(s) with an opening balance have no ERP ledger — match or create them first (their balances are not brought in)`);
  }

  // bills ↔ ledger opening
  for (const [lid, sum] of billSum) {
    const l = leds.find((x) => Number(x.id) === lid)!;
    if (!Number(l.is_bill_wise)) plan.warnings.push(`${l.ledger_name} is not bill-wise — its pending bills are kept for outstanding, consider turning bill-wise on`);
    if (!ledAmt.has(lid)) ledAmt.set(lid, sum);
    else if (Math.abs(ledAmt.get(lid)! - sum) > 0.009) {
      plan.errors.push({ row: l.ledger_name, message: `Opening ${ledAmt.get(lid)!.toFixed(2)} (Dr +) ≠ pending bills ${sum.toFixed(2)} — they must agree` });
    }
  }
  for (const [lid, amt] of ledAmt) {
    const l = leds.find((x) => Number(x.id) === lid)!;
    plan.ledgers.push({ ledger_id: lid, ledger_name: l.ledger_name, amount: amt, bills: plan.bills.filter((x) => x.ledger_id === lid).length });
  }
  plan.total_dr = r2(plan.ledgers.filter((l) => l.amount > 0).reduce((t, l) => t + l.amount, 0));
  plan.total_cr = r2(-plan.ledgers.filter((l) => l.amount < 0).reduce((t, l) => t + l.amount, 0));
  plan.difference = r2(plan.total_dr - plan.total_cr);
  if (Math.abs(plan.difference) > 0.009) plan.warnings.push(`Opening Dr and Cr differ by ${Math.abs(plan.difference).toFixed(2)} — the trial balance and balance sheet will show this "difference in opening balances"`);
  return plan;
}

openingRouter.post('/opening/preview', ADMIN, ah(async (req, res) => {
  const b = inputSchema.parse(req.body ?? {});
  res.json({ data: await buildPlan(cidOf(req), b) });
}));

openingRouter.post('/opening/apply', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = inputSchema.parse(req.body ?? {});
  const lock = await queryOne<any>(`SELECT DATE_FORMAT(locked_upto,'%Y-%m-%d') d FROM acc_period_lock WHERE company_id = ?`, [cid]);
  if (lock?.d && lock.d >= b.as_on) throw Unprocessable(`Books are locked up to ${lock.d} — unlock them to change opening balances`);
  const plan = await buildPlan(cid, b);
  if (plan.errors.length) throw Unprocessable(`${plan.errors.length} row(s) have errors — fix them in Preview first`, { errors: plan.errors.slice(0, 50) });
  if (!plan.ledgers.length) throw BadRequest('Nothing to apply');
  await transaction(async (tx) => {
    for (const l of plan.ledgers) {
      await txExecute(tx, `UPDATE acc_ledger SET opening_balance = ?, opening_dr_cr = ?, opening_date = ?, updated_by = ? WHERE id = ? AND company_id = ?`,
        [Math.abs(l.amount), l.amount < 0 ? 'CR' : 'DR', b.as_on, req.user!.id, l.ledger_id, cid]);
      await txExecute(tx, `DELETE FROM acc_opening_bill WHERE ledger_id = ? AND company_id = ?`, [l.ledger_id, cid]);
    }
    for (const x of plan.bills) {
      await txExecute(tx, `INSERT INTO acc_opening_bill (company_id, ledger_id, bill_ref_no, bill_date, due_date, amount, created_by) VALUES (?,?,?,?,?,?,?)`,
        [cid, x.ledger_id, x.bill_ref_no, x.bill_date, x.due_date, x.amount, req.user!.id]);
    }
  });
  await audit(req, 'acc_ledger', 0, 'UPDATE', undefined, { action: 'OPENING_BALANCES', source: b.source, as_on: b.as_on, ledgers: plan.ledgers.length, bills: plan.bills.length,
    total_dr: plan.total_dr, total_cr: plan.total_cr, file: b.filename ?? null });
  res.json({ data: { ledgers: plan.ledgers.length, bills: plan.bills.length, difference: plan.difference },
    message: `Opening balances set for ${plan.ledgers.length} ledger(s)${plan.bills.length ? ` with ${plan.bills.length} pending bill(s)` : ''}` });
}));
