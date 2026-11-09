import { txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest, Conflict, NotFound, Unprocessable } from '../../core/errors.js';

/**
 * Accounts voucher engine (spec §4, §9). The ONLY code that writes acc_voucher / acc_voucher_entry.
 *
 *  - Every voucher balances (Σ Dr = Σ Cr, 2 dp) and has ≥ 2 lines; each line is either Dr or Cr.
 *  - Posted vouchers are immutable. Corrections = reversal voucher (Dr/Cr swapped, linked both ways).
 *  - Voucher numbers are given at posting (per company / FY / type, gap-free), drafts show DRAFT-<id>.
 *  - A voucher generated from an ERP document carries source_key = MODULE:EVENT:id:rev (unique per company), so the
 *    same document event can never be posted twice. Cancelling / reversing frees the key (suffix #X<id>) so a corrected
 *    document can be posted again.
 *  - Dates inside a locked period (acc_period_lock) or a closed financial year are refused.
 */

export type VoucherType = 'JOURNAL' | 'PAYMENT' | 'RECEIPT' | 'CONTRA' | 'SALES' | 'PURCHASE' | 'DEBIT_NOTE' | 'CREDIT_NOTE';
export const VOUCHER_TYPES: VoucherType[] = ['JOURNAL', 'PAYMENT', 'RECEIPT', 'CONTRA', 'SALES', 'PURCHASE', 'DEBIT_NOTE', 'CREDIT_NOTE'];
export const LIVE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'POSTED'];

export interface EntryInput {
  ledger_id: number;
  debit?: number | null;
  credit?: number | null;
  fc_amount?: number | null;
  narration?: string | null;
  bill_ref_type?: 'NEW' | 'AGAINST' | 'ADVANCE' | 'ON_ACCOUNT' | null;
  bill_ref_no?: string | null;
  bill_due_date?: string | null;
  cost_centre_id?: number | null;
  so_id?: number | null;
  style_id?: number | null;
  tax_kind?: string | null;
  tax_rate?: number | null;
  taxable_value?: number | null;
  hsn_code?: string | null;
}

export interface VoucherInput {
  type_code: VoucherType;
  voucher_date: string;               // YYYY-MM-DD
  narration?: string | null;
  ref_no?: string | null;
  ref_date?: string | null;
  party_ledger_id?: number | null;
  currency_code?: string | null;
  exchange_rate?: number | null;
  fc_amount?: number | null;
  entries: EntryInput[];
  source?: { module: string; id: number; no?: string | null; event: string; revision?: number } | null;
}

export interface Actor { companyId: number; userId: number | null }

export const r2 = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Indian financial year code of a date: 2026-11-09 → "2026-27". */
export function fyCodeOf(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** FY code for a date; refuses closed financial years and locked periods. */
export async function assertOpenDate(tx: Tx, cid: number, date: string): Promise<string> {
  if (!DATE_RE.test(date)) throw BadRequest('Enter a valid voucher date');
  const fy = await txQueryOne<any>(tx,
    `SELECT fy_code, is_closed FROM mst_financial_year WHERE company_id = ? AND ? BETWEEN start_date AND end_date ORDER BY id DESC LIMIT 1`, [cid, date]);
  if (fy && Number(fy.is_closed)) throw Unprocessable(`Financial year ${fy.fy_code} is closed — vouchers dated ${date} cannot be posted`);
  const lock = await txQueryOne<any>(tx, `SELECT DATE_FORMAT(locked_upto, '%Y-%m-%d') d FROM acc_period_lock WHERE company_id = ?`, [cid]);
  if (lock?.d && date <= lock.d) throw Unprocessable(`Books are locked up to ${lock.d} — a voucher dated ${date} cannot be posted, changed or reversed`);
  return fy?.fy_code ?? fyCodeOf(date);
}

/** Ledger mapped to a posting role, or a configuration error naming the role (spec §14: stop, no retry until corrected). */
export async function ledgerForRole(tx: Tx, cid: number, role: string): Promise<number> {
  const r = await txQueryOne<any>(tx,
    `SELECT r.ledger_id, l.is_active FROM acc_ledger_role r LEFT JOIN acc_ledger l ON l.id = r.ledger_id WHERE r.company_id = ? AND r.role_code = ?`, [cid, role]);
  if (!r?.ledger_id) throw Unprocessable(`Posting role ${role} has no ledger — map it in Accounts → Settings → Posting ledgers`, { code: 'MAPPING', role });
  if (!Number(r.is_active)) throw Unprocessable(`The ledger mapped to ${role} is inactive — map an active ledger`, { code: 'MAPPING', role });
  return Number(r.ledger_id);
}

/**
 * The party's ledger (one per party, bill-wise). Created on first use under Sundry Creditors (supplier / contractor)
 * or Sundry Debtors (buyer). The ledger name is the party name; a clash with another ledger adds the party code.
 */
export async function partyLedger(tx: Tx, cid: number, partyId: number, side: 'CREDITOR' | 'DEBTOR'): Promise<number> {
  const have = await txQueryOne<any>(tx, `SELECT id FROM acc_ledger WHERE company_id = ? AND party_id = ?`, [cid, partyId]);
  if (have) return Number(have.id);
  const p = await txQueryOne<any>(tx, `SELECT * FROM mst_party WHERE id = ? AND company_id = ?`, [partyId, cid]);
  if (!p) throw Unprocessable(`Party #${partyId} not found in this company`, { code: 'MAPPING' });
  const grp = await txQueryOne<any>(tx, `SELECT id FROM acc_account_group WHERE company_id = ? AND group_code = ?`,
    [cid, side === 'CREDITOR' ? 'SUNDRY_CREDITORS' : 'SUNDRY_DEBTORS']);
  if (!grp) throw Unprocessable('Account groups are not set up for this company (Sundry Debtors / Creditors missing)', { code: 'MAPPING' });
  const pname = String(p.party_name ?? p.name ?? p.legal_name ?? `Party ${partyId}`).trim().slice(0, 140);
  const pcode = String(p.party_code ?? p.code ?? partyId);
  const clash = await txQueryOne<any>(tx, `SELECT id FROM acc_ledger WHERE company_id = ? AND ledger_name = ?`, [cid, pname]);
  const name = clash ? `${pname} (${pcode})`.slice(0, 150) : pname;
  const gstin = p.gstin ?? p.gst_no ?? null;
  const r: any = await txExecute(tx,
    `INSERT INTO acc_ledger (company_id, ledger_code, ledger_name, group_id, ledger_type, party_id, is_bill_wise, gstin, state_code)
     VALUES (?,?,?,?, 'PARTY', ?, 1, ?, ?)`,
    [cid, `P-${pcode}`.slice(0, 40), name, grp.id, partyId, gstin, gstin ? String(gstin).slice(0, 2) : null]);
  return Number(r.insertId);
}

/** Bank ledger for one of our bank accounts (mst_company_bank_account); created under Bank Accounts on first use. */
export async function bankLedger(tx: Tx, cid: number, bankAccountId: number): Promise<number> {
  const have = await txQueryOne<any>(tx, `SELECT id FROM acc_ledger WHERE company_id = ? AND bank_account_id = ?`, [cid, bankAccountId]);
  if (have) return Number(have.id);
  const b = await txQueryOne<any>(tx, `SELECT * FROM mst_company_bank_account WHERE id = ? AND company_id = ?`, [bankAccountId, cid]);
  if (!b) throw Unprocessable(`Bank account #${bankAccountId} not found`, { code: 'MAPPING' });
  const grp = await txQueryOne<any>(tx, `SELECT id FROM acc_account_group WHERE company_id = ? AND group_code = 'BANK_ACCOUNTS'`, [cid]);
  if (!grp) throw Unprocessable('Account groups are not set up for this company (Bank Accounts missing)', { code: 'MAPPING' });
  const acct = String(b.account_no ?? b.account_number ?? '').trim();
  const base = `${String(b.bank_name ?? 'Bank').trim()}${acct ? ` A/c ${acct.slice(-4)}` : ''}`.slice(0, 140);
  const clash = await txQueryOne<any>(tx, `SELECT id FROM acc_ledger WHERE company_id = ? AND ledger_name = ?`, [cid, base]);
  const name = clash ? `${base} #${bankAccountId}` : base;
  const r: any = await txExecute(tx,
    `INSERT INTO acc_ledger (company_id, ledger_code, ledger_name, group_id, ledger_type, bank_account_id) VALUES (?,?,?,?, 'BANK', ?)`,
    [cid, `BANK-${bankAccountId}`, name, grp.id, bankAccountId]);
  return Number(r.insertId);
}

/** Next voucher number (gap-free per company / FY / type). */
async function nextVoucherNo(tx: Tx, cid: number, fy: string, type: string): Promise<string> {
  await txExecute(tx,
    `INSERT INTO acc_voucher_counter (company_id, fy_code, type_code, last_no) VALUES (?,?,?,LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)`, [cid, fy, type]);
  const row = await txQueryOne<any>(tx, 'SELECT LAST_INSERT_ID() n');
  const vt = await txQueryOne<any>(tx, `SELECT prefix FROM acc_voucher_type WHERE company_id = ? AND type_code = ?`, [cid, type]);
  return `${vt?.prefix ?? type.slice(0, 3)}/${fy}/${String(row?.n ?? 1).padStart(5, '0')}`;
}

/** Validate and normalise lines: active same-company ledgers, one side per line, balanced. */
async function checkEntries(tx: Tx, cid: number, entries: EntryInput[]) {
  if (!Array.isArray(entries) || entries.length < 2) throw BadRequest('A voucher needs at least two lines (one debit and one credit)');
  const ids = [...new Set(entries.map((e) => Number(e.ledger_id)).filter(Boolean))];
  const leds = ids.length ? await txQuery<any>(tx,
    `SELECT id, ledger_name, is_active, is_cost_centre_on FROM acc_ledger WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [cid, ...ids]) : [];
  const byId = new Map(leds.map((l) => [Number(l.id), l]));
  let dr = 0; let cr = 0;
  const out = entries.map((e, i) => {
    const n = i + 1;
    const l = byId.get(Number(e.ledger_id));
    if (!l) throw BadRequest(`Line ${n}: pick a ledger of this company`);
    if (!Number(l.is_active)) throw BadRequest(`Line ${n}: ledger ${l.ledger_name} is inactive`);
    const d = r2(e.debit); const c = r2(e.credit);
    if (d < 0 || c < 0) throw BadRequest(`Line ${n}: amounts cannot be negative`);
    if ((d > 0) === (c > 0)) throw BadRequest(`Line ${n} (${l.ledger_name}): enter either a debit or a credit amount`);
    dr = r2(dr + d); cr = r2(cr + c);
    return { ...e, ledger_id: Number(e.ledger_id), debit: d, credit: c };
  });
  if (Math.abs(dr - cr) > 0.004) throw Unprocessable(`Voucher does not balance: debit ${dr.toFixed(2)} ≠ credit ${cr.toFixed(2)} (difference ${(dr - cr).toFixed(2)})`);
  if (dr <= 0) throw BadRequest('Voucher total must be more than zero');
  return { lines: out, total: dr };
}

export function sourceKey(s: NonNullable<VoucherInput['source']>) {
  return `${s.module}:${s.event}:${s.id}:${s.revision ?? 1}`;
}

/** Live voucher for a source event (DRAFT / PENDING_APPROVAL / POSTED), if any. */
export async function voucherForSource(tx: Tx, cid: number, s: NonNullable<VoucherInput['source']>) {
  return txQueryOne<any>(tx, `SELECT id, status, voucher_no FROM acc_voucher WHERE company_id = ? AND source_key = ?`, [cid, sourceKey(s)]);
}

/**
 * Create a voucher. status: DRAFT (manual, editable), PENDING_APPROVAL (waits for checker), POSTED (numbered, final).
 * With a source, an existing live voucher for the same key is returned instead (idempotent).
 */
export async function createVoucher(tx: Tx, a: Actor, v: VoucherInput, status: 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED') {
  if (!VOUCHER_TYPES.includes(v.type_code)) throw BadRequest('Pick a voucher type');
  const cid = a.companyId;
  if (v.source) {
    const live = await voucherForSource(tx, cid, v.source);
    if (live) return { id: Number(live.id), created: false, status: live.status as string, voucher_no: live.voucher_no as string | null };
  }
  const fy = await assertOpenDate(tx, cid, v.voucher_date);
  const { lines, total } = await checkEntries(tx, cid, v.entries);
  const no = status === 'POSTED' ? await nextVoucherNo(tx, cid, fy, v.type_code) : null;
  const ins: any = await txExecute(tx,
    `INSERT INTO acc_voucher (company_id, fy_code, type_code, voucher_no, voucher_date, party_ledger_id, ref_no, ref_date, narration,
        currency_code, exchange_rate, fc_amount, total_debit, total_credit, status, is_auto, source_module, source_id, source_no, posting_event,
        source_revision, source_key, created_by, submitted_by, submitted_at, approved_by, approved_at)
     VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`,
    [cid, fy, v.type_code, no, v.voucher_date, v.party_ledger_id ?? null, v.ref_no ?? null, v.ref_date || null, v.narration ?? null,
      v.currency_code ?? null, v.exchange_rate ?? null, v.fc_amount ?? null, total, total, status, v.source ? 1 : 0,
      v.source?.module ?? null, v.source?.id ?? null, v.source?.no ?? null, v.source?.event ?? null,
      v.source?.revision ?? 1, v.source ? sourceKey(v.source) : null, a.userId,
      status !== 'DRAFT' ? a.userId : null, status !== 'DRAFT' ? new Date() : null,
      status === 'POSTED' ? a.userId : null, status === 'POSTED' ? new Date() : null]);
  const id = Number(ins.insertId);
  await insertEntries(tx, id, lines);
  return { id, created: true, status, voucher_no: no };
}

async function insertEntries(tx: Tx, voucherId: number, lines: EntryInput[]) {
  let n = 0;
  for (const e of lines) {
    n += 1;
    await txExecute(tx,
      `INSERT INTO acc_voucher_entry (voucher_id, line_no, ledger_id, debit, credit, fc_amount, narration, bill_ref_type, bill_ref_no, bill_due_date,
          cost_centre_id, so_id, style_id, tax_kind, tax_rate, taxable_value, hsn_code)
       VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`,
      [voucherId, n, e.ledger_id, r2(e.debit), r2(e.credit), e.fc_amount ?? null, e.narration ?? null, e.bill_ref_type ?? null,
        e.bill_ref_no ?? null, e.bill_due_date || null, e.cost_centre_id ?? null, e.so_id ?? null, e.style_id ?? null,
        e.tax_kind ?? null, e.tax_rate ?? null, e.taxable_value ?? null, e.hsn_code ?? null]);
  }
}

export async function lockVoucher(tx: Tx, cid: number, id: number) {
  const v = await txQueryOne<any>(tx,
    `SELECT v.*, DATE_FORMAT(v.voucher_date, '%Y-%m-%d') AS vdate FROM acc_voucher v WHERE v.id = ? AND v.company_id = ? FOR UPDATE`, [id, cid]);
  if (!v) throw NotFound('Voucher not found');
  return v;
}

/** Replace a DRAFT / REJECTED voucher's header + lines (manual vouchers only). */
export async function updateDraft(tx: Tx, a: Actor, id: number, v: VoucherInput, rowVersion?: number) {
  const cur = await lockVoucher(tx, a.companyId, id);
  if (!['DRAFT', 'REJECTED'].includes(cur.status)) throw Conflict(`Voucher is ${cur.status.toLowerCase().replace('_', ' ')} — only a draft can be edited`);
  if (cur.is_auto) throw Conflict('A voucher generated from an ERP document cannot be edited — reject it, correct the document, and post again');
  if (rowVersion && Number(rowVersion) !== Number(cur.row_version)) throw Conflict('Someone else changed this voucher — reload and try again');
  const fy = await assertOpenDate(tx, a.companyId, v.voucher_date);
  const { lines, total } = await checkEntries(tx, a.companyId, v.entries);
  await txExecute(tx,
    `UPDATE acc_voucher SET fy_code = ?, type_code = ?, voucher_date = ?, party_ledger_id = ?, ref_no = ?, ref_date = ?, narration = ?,
        currency_code = ?, exchange_rate = ?, fc_amount = ?, total_debit = ?, total_credit = ?, status = 'DRAFT', reject_reason = NULL,
        updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
    [fy, v.type_code, v.voucher_date, v.party_ledger_id ?? null, v.ref_no ?? null, v.ref_date || null, v.narration ?? null,
      v.currency_code ?? null, v.exchange_rate ?? null, v.fc_amount ?? null, total, total, a.userId, id]);
  await txExecute(tx, 'DELETE FROM acc_voucher_entry WHERE voucher_id = ?', [id]);
  await insertEntries(tx, id, lines);
}

/** Post (approve) a voucher: number it, freeze it. Maker-checker when the voucher type needs approval. */
export async function postVoucher(tx: Tx, a: Actor, id: number, opts: { allowSelfApprove?: boolean } = {}) {
  const v = await lockVoucher(tx, a.companyId, id);
  if (v.status === 'POSTED') return v;
  if (!['PENDING_APPROVAL', 'DRAFT'].includes(v.status)) throw Conflict(`Voucher is ${v.status.toLowerCase().replace('_', ' ')} — it cannot be posted`);
  const vt = await txQueryOne<any>(tx, `SELECT approval_required FROM acc_voucher_type WHERE company_id = ? AND type_code = ?`, [a.companyId, v.type_code]);
  const maker = Number(v.is_auto ? 0 : (v.submitted_by ?? v.created_by));
  if (Number(vt?.approval_required ?? 1) && !opts.allowSelfApprove && maker && maker === a.userId) {
    throw Conflict('Maker-checker: the voucher must be approved by another user (you created / submitted it)');
  }
  const fy = await assertOpenDate(tx, a.companyId, v.vdate);
  // re-check the balance from the stored lines (defence in depth)
  const t = await txQueryOne<any>(tx, `SELECT COUNT(*) n, ROUND(SUM(debit),2) dr, ROUND(SUM(credit),2) cr FROM acc_voucher_entry WHERE voucher_id = ?`, [id]);
  if (Number(t?.n) < 2 || Math.abs(Number(t?.dr) - Number(t?.cr)) > 0.004) throw Unprocessable('Voucher does not balance — correct it before posting');
  const no = await nextVoucherNo(tx, a.companyId, fy, v.type_code);
  await txExecute(tx,
    `UPDATE acc_voucher SET status = 'POSTED', fy_code = ?, voucher_no = ?, approved_by = ?, approved_at = NOW(),
        submitted_by = COALESCE(submitted_by, ?), submitted_at = COALESCE(submitted_at, NOW()), row_version = row_version + 1 WHERE id = ?`,
    [fy, no, a.userId, a.userId, id]);
  return { ...v, status: 'POSTED', voucher_no: no };
}

/** Cancel an unposted voucher (draft / pending / rejected). Frees the source key so the document can be posted again. */
export async function cancelVoucher(tx: Tx, a: Actor, id: number, reason: string) {
  const v = await lockVoucher(tx, a.companyId, id);
  if (!['DRAFT', 'PENDING_APPROVAL', 'REJECTED'].includes(v.status)) throw Conflict('Only an unposted voucher can be cancelled — reverse a posted voucher instead');
  await txExecute(tx,
    `UPDATE acc_voucher SET status = 'CANCELLED', cancel_reason = ?, source_key = IF(source_key IS NULL, NULL, CONCAT(source_key, '#X', id)),
        updated_by = ?, row_version = row_version + 1 WHERE id = ?`, [reason, a.userId, id]);
  return v;
}

/**
 * Reverse a posted voucher: a new POSTED voucher with Dr / Cr swapped on the reversal date (default = original date),
 * both linked. The original becomes REVERSED and its source key is freed.
 */
export async function reverseVoucher(tx: Tx, a: Actor, id: number, reason: string, date?: string | null) {
  const v = await lockVoucher(tx, a.companyId, id);
  if (v.status !== 'POSTED') throw Conflict('Only a posted voucher can be reversed');
  const on = date || v.vdate;
  if (on < v.vdate) throw BadRequest('Reversal date cannot be before the original voucher date');
  await assertOpenDate(tx, a.companyId, on);
  const lines = await txQuery<any>(tx, `SELECT * FROM acc_voucher_entry WHERE voucher_id = ? ORDER BY line_no`, [id]);
  await txExecute(tx,
    `UPDATE acc_voucher SET status = 'REVERSED', source_key = IF(source_key IS NULL, NULL, CONCAT(source_key, '#X', id)),
        cancel_reason = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?`, [reason, a.userId, id]);
  const rev = await createVoucher(tx, a, {
    type_code: v.type_code === 'SALES' ? 'CREDIT_NOTE' : v.type_code === 'PURCHASE' ? 'DEBIT_NOTE' : 'JOURNAL',
    voucher_date: on,
    narration: `Reversal of ${v.voucher_no}: ${reason}`.slice(0, 1000),
    ref_no: v.voucher_no, ref_date: v.vdate, party_ledger_id: v.party_ledger_id,
    currency_code: v.currency_code, exchange_rate: v.exchange_rate, fc_amount: v.fc_amount,
    entries: lines.map((l) => ({
      ledger_id: Number(l.ledger_id), debit: Number(l.credit), credit: Number(l.debit), fc_amount: l.fc_amount,
      narration: l.narration, bill_ref_type: l.bill_ref_no ? 'AGAINST' : null, bill_ref_no: l.bill_ref_no,
      cost_centre_id: l.cost_centre_id, so_id: l.so_id, style_id: l.style_id, tax_kind: l.tax_kind, tax_rate: l.tax_rate,
      taxable_value: l.taxable_value, hsn_code: l.hsn_code,
    })),
  }, 'POSTED');
  await txExecute(tx, `UPDATE acc_voucher SET reversal_of_id = ? WHERE id = ?`, [id, rev.id]);
  await txExecute(tx, `UPDATE acc_voucher SET reversed_by_id = ? WHERE id = ?`, [rev.id, id]);
  return { original: v, reversal: rev };
}
