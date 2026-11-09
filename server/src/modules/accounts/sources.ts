import { query, queryOne, transaction, txQuery, txQueryOne, execute, type Tx } from '../../config/db.js';
import { AppError, Unprocessable } from '../../core/errors.js';
import {
  createVoucher, ledgerForRole, partyLedger, bankLedger, repairPartyGroups, r2, sourceKey,
  type EntryInput, type VoucherInput, type VoucherType, type Actor,
} from './voucherEngine.js';
import { POSTING_EVENTS, ensureAccountsSetup } from './accountsSetup.js';
import { enqueueTally } from './tally.js';
import { syncBillTracker } from './billSync.js';

/**
 * ERP document → voucher adapters (spec §3.1, §4.1, §5) and the scan that turns final documents into vouchers.
 *
 * Why a scan instead of hooks inside each module: several documents are final the moment they are saved (process bills,
 * contractor payments) and some can be reopened (Bills Inward APPROVED → DISPUTED, commercial invoice FINAL → DRAFT).
 * The scan never blocks the business document: a voucher that cannot be built (missing ledger mapping, totals that do
 * not add up, locked period) is listed under Accounts → Inbox → Issues with the reason, and is retried on the next scan.
 * A document that changes after its voucher was made is listed under "Changed after posting" for accounts to reverse.
 *
 * Posting rule per event (acc_posting_rule): OFF / REVIEW (voucher waits for approval) / AUTO (posted at once);
 * documents dated before effective_from are left out (accounts can still create one from the inbox).
 */

const DATA = (m: string) => Unprocessable(m, { code: 'DATA' });

/** Lines for an amount split over jobs (sales orders) in proportion to parts; remainder on the last line. */
function splitByJob(amount: number, parts: { so_id: number | null; amount: number }[]): { so_id: number | null; amount: number }[] {
  const amt = r2(amount);
  const grouped = new Map<number | null, number>();
  for (const p of parts) grouped.set(p.so_id ?? null, r2((grouped.get(p.so_id ?? null) ?? 0) + Number(p.amount || 0)));
  const pos = [...grouped.entries()].filter(([, a]) => a > 0);
  const base = r2(pos.reduce((t, [, a]) => t + a, 0));
  if (!pos.length || base <= 0 || amt === 0) return [{ so_id: null, amount: amt }];
  let left = amt;
  return pos.map(([so, a], i) => {
    const v = i === pos.length - 1 ? r2(left) : r2(amt * a / base);
    left = r2(left - v);
    return { so_id: so, amount: v };
  }).filter((x) => x.amount !== 0);
}

async function soIdsByIo(tx: Tx, cid: number, ios: (string | null | undefined)[]) {
  const list = [...new Set(ios.map((x) => String(x ?? '').trim()).filter(Boolean))];
  const m = new Map<string, number>();
  if (!list.length) return m;
  const rows = await txQuery<any>(tx, `SELECT id, io_no FROM trx_sales_order WHERE company_id = ? AND io_no IN (?)`, [cid, list]);
  for (const r of rows) m.set(String(r.io_no), Number(r.id));
  return m;
}

const gstSplit = (gst: number, cgst: number, sgst: number, igst: number, inter: boolean) => {
  if (cgst || sgst || igst) return { cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst) };
  if (!gst) return { cgst: 0, sgst: 0, igst: 0 };
  if (inter) return { cgst: 0, sgst: 0, igst: r2(gst) };
  const c = r2(gst / 2);
  return { cgst: c, sgst: r2(gst - c), igst: 0 };
};

/**
 * Bill-style voucher (purchase / job work): expense + taxes + charges Dr, deductions + party Cr.
 * Any difference up to ₹1 goes to Round Off; more than that is a data error (the bill's own totals do not add up).
 */
async function billVoucher(tx: Tx, cid: number, b: {
  type: VoucherType; date: string; partyLedgerId: number; partyAmount: number; billRef: string; dueDate?: string | null;
  refNo?: string | null; refDate?: string | null; narration: string;
  expense: { role: string; amount: number; so_id?: number | null }[];
  gst: { cgst: number; sgst: number; igst: number };
  dr?: { role: string; amount: number }[];      // freight / other charges / TCS
  cr?: { role: string; amount: number }[];      // TDS / deductions
  /** Part of the party credit that knocks off earlier advances (bill-wise "against" the advance refs). */
  advanceAdjusted?: number;
  /** Part of the bill paid to the party but recoverable from them (contractor excess kept as advance) → party Dr as an advance. */
  partyAdvance?: { amount: number; ref: string | null };
  source: VoucherInput['source'];
}): Promise<VoucherInput> {
  const e: EntryInput[] = [];
  const add = (ledger_id: number, amt: number, extra: Partial<EntryInput> = {}) => {
    const a = r2(amt);
    if (!a) return;
    e.push(a > 0 ? { ledger_id, debit: a, ...extra } : { ledger_id, credit: -a, ...extra });
  };
  for (const x of b.expense) add(await ledgerForRole(tx, cid, x.role), x.amount, { so_id: x.so_id ?? null });
  if (b.gst.cgst) add(await ledgerForRole(tx, cid, 'INPUT_CGST'), b.gst.cgst, { tax_kind: 'CGST' });
  if (b.gst.sgst) add(await ledgerForRole(tx, cid, 'INPUT_SGST'), b.gst.sgst, { tax_kind: 'SGST' });
  if (b.gst.igst) add(await ledgerForRole(tx, cid, 'INPUT_IGST'), b.gst.igst, { tax_kind: 'IGST' });
  for (const x of b.dr ?? []) if (r2(x.amount)) add(await ledgerForRole(tx, cid, x.role), x.amount);
  for (const x of b.cr ?? []) if (r2(x.amount)) add(await ledgerForRole(tx, cid, x.role), -x.amount);
  const party = r2(b.partyAmount);
  if (party <= 0) throw DATA(`Bill amount payable is ${party.toFixed(2)} — nothing to post`);
  const adv = Math.min(r2(b.advanceAdjusted ?? 0), party);
  if (adv > 0) {
    // knock off open advances of this party, oldest first; what is not found stays on account
    const open = await txQuery<any>(tx,
      `SELECT e.bill_ref_no, ROUND(SUM(e.debit - e.credit), 2) amt, MIN(v.voucher_date) d FROM acc_voucher_entry e JOIN acc_voucher v ON v.id = e.voucher_id
        WHERE e.ledger_id = ? AND v.status IN ('PENDING_APPROVAL','POSTED') AND e.bill_ref_no IN (
              SELECT DISTINCT e2.bill_ref_no FROM acc_voucher_entry e2 WHERE e2.ledger_id = ? AND e2.bill_ref_type = 'ADVANCE')
        GROUP BY e.bill_ref_no HAVING amt > 0 ORDER BY d, e.bill_ref_no`, [b.partyLedgerId, b.partyLedgerId]);
    let left = adv;
    for (const o of open) {
      if (left <= 0) break;
      const take = r2(Math.min(left, Number(o.amt)));
      e.push({ ledger_id: b.partyLedgerId, credit: take, bill_ref_type: 'AGAINST', bill_ref_no: o.bill_ref_no, narration: 'Advance adjusted' });
      left = r2(left - take);
    }
    if (left > 0) e.push({ ledger_id: b.partyLedgerId, credit: left, bill_ref_type: 'ON_ACCOUNT', narration: 'Advance adjusted (no open advance found)' });
  }
  if (party - adv > 0) e.push({ ledger_id: b.partyLedgerId, credit: r2(party - adv), bill_ref_type: 'NEW', bill_ref_no: b.billRef, bill_due_date: b.dueDate || null });
  if (b.partyAdvance && r2(b.partyAdvance.amount) > 0) {
    e.push({ ledger_id: b.partyLedgerId, debit: r2(b.partyAdvance.amount), bill_ref_type: b.partyAdvance.ref ? 'ADVANCE' : 'ON_ACCOUNT', bill_ref_no: b.partyAdvance.ref,
      narration: 'Excess over our rate kept as advance (recoverable)' });
  }
  const dr = r2(e.reduce((t, l) => t + Number(l.debit || 0), 0));
  const cr = r2(e.reduce((t, l) => t + Number(l.credit || 0), 0));
  const diff = r2(cr - dr);
  if (Math.abs(diff) > 1) throw DATA(`Bill totals do not add up: debits ${dr.toFixed(2)} vs credits ${cr.toFixed(2)} (difference ${diff.toFixed(2)}) — check the bill's taxable / GST / TDS / net values`);
  if (diff) add(await ledgerForRole(tx, cid, 'ROUND_OFF'), diff, { narration: 'Rounding' });
  return {
    type_code: b.type, voucher_date: b.date, narration: b.narration, ref_no: b.refNo ?? b.billRef, ref_date: b.refDate ?? null,
    party_ledger_id: b.partyLedgerId, entries: e, source: b.source,
  };
}

/** Bank / cash ledger for a payment: our bank account, cash, or the default bank account. */
async function payLedger(tx: Tx, cid: number, bankAccountId: number | null, mode: string | null): Promise<number> {
  if (bankAccountId) return bankLedger(tx, cid, bankAccountId);
  if (String(mode ?? '').toUpperCase() === 'CASH') return ledgerForRole(tx, cid, 'CASH');
  const d = await txQueryOne<any>(tx,
    `SELECT id FROM mst_company_bank_account WHERE company_id = ? AND is_active = 1 ORDER BY is_default DESC, id LIMIT 1`, [cid]);
  if (!d) throw Unprocessable('No bank account to pay from — add one in Masters → Our Bank Accounts', { code: 'MAPPING' });
  return bankLedger(tx, cid, Number(d.id));
}

function payVoucher(type: VoucherType, date: string, partyLedgerId: number, moneyLedgerId: number, amount: number,
  ref: { type: 'AGAINST' | 'ADVANCE' | 'ON_ACCOUNT'; no: string | null }, narration: string, refNo: string | null, source: VoucherInput['source']): VoucherInput {
  const a = r2(amount);
  if (a <= 0) throw DATA('Amount is zero — nothing to post');
  const partySide: EntryInput = { ledger_id: partyLedgerId, bill_ref_type: ref.type, bill_ref_no: ref.no };
  const money: EntryInput = { ledger_id: moneyLedgerId };
  const entries = type === 'RECEIPT'
    ? [{ ...money, debit: a }, { ...partySide, credit: a }]
    : [{ ...partySide, debit: a }, { ...money, credit: a }];
  return { type_code: type, voucher_date: date, narration, ref_no: refNo, party_ledger_id: partyLedgerId, entries, source };
}

// ============================================================== adapters
export interface SourceDef {
  event: string;              // acc_posting_rule.event_code
  module: string;             // source_module
  postingEvent: string;       // posting_event
  label: string;
  link: (id: number) => string;   // web route of the source document
  /** Eligible documents without a live voucher: rows {id, no, date, amount}. */
  candidates: (cid: number, from: string | null, limit: number) => Promise<any[]>;
  /** Current state of a document: still eligible + amount the voucher should carry on the party / money side. */
  current: (cid: number, ids: number[]) => Promise<Map<number, { eligible: boolean; amount: number; no: string }>>;
  build: (tx: Tx, cid: number, id: number) => Promise<VoucherInput>;
}

const keyOf = (mod: string, evt: string) => `CONCAT('${mod}:${evt}:', t.id, ':1')`;
const notPosted = (mod: string, evt: string) =>
  `NOT EXISTS (SELECT 1 FROM acc_voucher v WHERE v.company_id = t.company_id AND v.source_key = ${keyOf(mod, evt)})`;

function simpleSource(o: {
  event: string; module: string; postingEvent: string; label: string; link: (id: number) => string;
  table: string; noCol: string; dateCol: string; amountExpr: string; eligibleWhere: string;
  build: SourceDef['build'];
}): SourceDef {
  return {
    event: o.event, module: o.module, postingEvent: o.postingEvent, label: o.label, link: o.link, build: o.build,
    candidates: (cid, from, limit) => query<any>(
      `SELECT t.id, t.${o.noCol} AS no, DATE_FORMAT(t.${o.dateCol}, '%Y-%m-%d') AS date, ROUND(${o.amountExpr}, 2) AS amount
         FROM ${o.table} t
        WHERE t.company_id = ? AND ${o.eligibleWhere} AND (? IS NULL OR t.${o.dateCol} >= ?) AND ${notPosted(o.module, o.postingEvent)}
        ORDER BY t.${o.dateCol}, t.id LIMIT ${Number(limit)}`, [cid, from, from]),
    current: async (cid, ids) => {
      const m = new Map<number, { eligible: boolean; amount: number; no: string }>();
      if (!ids.length) return m;
      const rows = await query<any>(
        `SELECT t.id, t.${o.noCol} AS no, (${o.eligibleWhere}) AS ok, ROUND(${o.amountExpr}, 2) AS amount FROM ${o.table} t WHERE t.company_id = ? AND t.id IN (?)`, [cid, ids]);
      for (const r of rows) m.set(Number(r.id), { eligible: !!Number(r.ok), amount: Number(r.amount), no: r.no });
      return m;
    },
  };
}

const SUPPLIER_BILL_ROLE: Record<string, string> = {
  YARN_PURCHASE: 'PURCHASE_YARN', FABRIC_PURCHASE: 'PURCHASE_FABRIC', TRIMS_PURCHASE: 'PURCHASE_TRIMS', GENERAL: 'PURCHASE_GENERAL',
  IMPORT_PURCHASE: 'PURCHASE_GENERAL', YARN_PROCESS: 'JOBWORK_YARN_PROCESS', FABRIC_PROCESS: 'JOBWORK_FABRIC_PROCESS',
  TRIMS_PROCESS: 'JOBWORK_OTHER', IMPORT_PROCESS: 'JOBWORK_OTHER',
};
const LINE_ROLE: Record<string, string> = { YARN: 'PURCHASE_YARN', FABRIC: 'PURCHASE_FABRIC', TRIM: 'PURCHASE_TRIMS' };

async function isForeign(tx: Tx, currencyId: number | null, xr: number) {
  if (!currencyId) return false;
  const c = await txQueryOne<any>(tx, `SELECT code FROM cfg_currency WHERE id = ?`, [currencyId]);
  return !!c && String(c.code).toUpperCase() !== 'INR' && Number(xr) !== 1;
}

const supplierBillApprove = simpleSource({
  event: 'SUPPLIER_BILL.APPROVE', module: 'SUPPLIER_BILL', postingEvent: 'APPROVE', label: 'Bills Inward',
  link: (id) => `/procurement/supplier-bills/${id}`,
  table: 'trx_supplier_bill', noCol: 'bill_no', dateCol: 'bill_date', amountExpr: 't.total_amount',
  eligibleWhere: `t.status IN ('APPROVED','PAID')`,
  build: async (tx, cid, id) => {
    const b = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.bill_date,'%Y-%m-%d') d, DATE_FORMAT(t.supplier_inv_date,'%Y-%m-%d') sid,
        DATE_FORMAT(t.payment_due_date,'%Y-%m-%d') due FROM trx_supplier_bill t WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!b) throw DATA('Bill not found');
    if (await isForeign(tx, b.currency_id, b.exchange_rate)) {
      throw DATA('Foreign-currency (import) bill — enter it as a manual Purchase voucher (BOE duty / exchange treatment is decided by accounts)');
    }
    const lines = await txQuery<any>(tx,
      `SELECT l.material_type, l.amount, COALESCE(gl.so_id, pol.so_id) so_id
         FROM trx_supplier_bill_line l
         LEFT JOIN trx_grn_line gl ON gl.id = l.grn_line_id
         LEFT JOIN trx_purchase_order_line pol ON pol.id = l.po_line_id
        WHERE l.bill_id = ?`, [id]);
    const headRole = SUPPLIER_BILL_ROLE[String(b.bill_type)] ?? 'PURCHASE_GENERAL';
    const isProcess = /_PROCESS$/.test(String(b.bill_type));
    const taxable = r2(b.subtotal);
    // group line amounts by (role, job), then scale to the bill's taxable value
    const byRole = new Map<string, { so_id: number | null; amount: number }[]>();
    for (const l of lines) {
      const role = isProcess ? headRole : (LINE_ROLE[String(l.material_type)] ?? headRole);
      byRole.set(role, [...(byRole.get(role) ?? []), { so_id: l.so_id ? Number(l.so_id) : null, amount: Number(l.amount || 0) }]);
    }
    const lineTotal = r2(lines.reduce((t, l) => t + Number(l.amount || 0), 0));
    const expense: { role: string; amount: number; so_id?: number | null }[] = [];
    if (!lines.length || lineTotal <= 0) expense.push({ role: headRole, amount: taxable });
    else {
      let left = taxable;
      const roles = [...byRole.entries()];
      roles.forEach(([role, parts], i) => {
        const share = i === roles.length - 1 ? r2(left) : r2(taxable * parts.reduce((t, p) => t + p.amount, 0) / lineTotal);
        left = r2(left - share);
        for (const s of splitByJob(share, parts)) expense.push({ role, amount: s.amount, so_id: s.so_id });
      });
    }
    const inter = b.gst_type === 'INTER_STATE' || b.gst_type === 'IMPORT';
    const supplier = await partyLedger(tx, cid, Number(b.supplier_id), 'CREDITOR');
    const ref = String(b.supplier_inv_no || b.bill_no);
    return billVoucher(tx, cid, {
      type: 'PURCHASE', date: b.d, partyLedgerId: supplier, partyAmount: Number(b.total_amount), billRef: ref, dueDate: b.due,
      refNo: ref, refDate: b.sid, narration: `Bills Inward ${b.bill_no} — supplier invoice ${ref}${b.remarks ? ` · ${String(b.remarks).slice(0, 200)}` : ''}`,
      expense, gst: gstSplit(Number(b.gst_amount), Number(b.cgst_amount), Number(b.sgst_amount), Number(b.igst_amount), inter),
      dr: [
        { role: 'FREIGHT_INWARD', amount: Number(b.freight_charges || 0) + Number(b.insurance || 0) + Number(b.customs_duty || 0) + Number(b.clearing_charges || 0) },
        { role: 'PURCHASE_OTHER_CHARGES', amount: Number(b.other_charges || 0) * (Number(b.other_charges_sign) < 0 ? -1 : 1) },
        { role: 'TCS_RECEIVABLE', amount: Number(b.tcs_amount || 0) },
      ],
      cr: [{ role: 'TDS_PAYABLE', amount: Number(b.tds_amount || 0) }],
      source: { module: 'SUPPLIER_BILL', id, no: b.bill_no, event: 'APPROVE' },
    });
  },
});

const supplierBillPay = simpleSource({
  event: 'SUPPLIER_BILL.PAY', module: 'SUPPLIER_BILL', postingEvent: 'PAY', label: 'Bills Inward payment',
  link: (id) => `/procurement/supplier-bills/${id}`,
  table: 'trx_supplier_bill', noCol: 'bill_no', dateCol: 'paid_date', amountExpr: 'COALESCE(t.paid_amount, t.total_amount)',
  eligibleWhere: `t.status = 'PAID' AND t.paid_date IS NOT NULL`,
  build: async (tx, cid, id) => {
    const b = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.paid_date,'%Y-%m-%d') pd FROM trx_supplier_bill t WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!b) throw DATA('Bill not found');
    const supplier = await partyLedger(tx, cid, Number(b.supplier_id), 'CREDITOR');
    const money = await payLedger(tx, cid, b.paid_bank_account_id ? Number(b.paid_bank_account_id) : null, b.payment_mode);
    const ref = String(b.supplier_inv_no || b.bill_no);
    return payVoucher('PAYMENT', b.pd, supplier, money, Number(b.paid_amount ?? b.total_amount), { type: 'AGAINST', no: ref },
      `Payment of ${b.bill_no} (invoice ${ref}) by ${b.payment_mode}${b.payment_ref ? ` ref ${b.payment_ref}` : ''}`, b.payment_ref,
      { module: 'SUPPLIER_BILL', id, no: b.bill_no, event: 'PAY' });
  },
});

/** Knitting / fabric process / yarn process bill (same money columns, final when saved). */
function processBillSource(o: { event: string; module: string; table: string; lineTable: string; role: string; label: string; link: string; hasSo: boolean; hasRecovery: boolean }) {
  return simpleSource({
    event: o.event, module: o.module, postingEvent: 'POST', label: o.label, link: (id) => `${o.link}${id}`,
    table: o.table, noCol: 'bill_no', dateCol: 'bill_date', amountExpr: 't.net_amount', eligibleWhere: `t.status = 'POSTED'`,
    build: async (tx, cid, id) => {
      const b = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.bill_date,'%Y-%m-%d') d, DATE_FORMAT(t.party_bill_date,'%Y-%m-%d') pbd,
          DATE_FORMAT(t.due_date,'%Y-%m-%d') due FROM ${o.table} t WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
      if (!b) throw DATA('Bill not found');
      const lines = await txQuery<any>(tx, `SELECT io_no, ${o.hasSo ? 'so_id' : 'NULL so_id'}, amount FROM ${o.lineTable} WHERE bill_id = ?`, [id]);
      const ioMap = await soIdsByIo(tx, cid, lines.map((l) => l.io_no));
      const parts = lines.map((l) => ({ so_id: l.so_id ? Number(l.so_id) : (ioMap.get(String(l.io_no ?? '').trim()) ?? null), amount: Number(l.amount || 0) }));
      const taxable = Number(b.calc_version) >= 2 && b.taxable_amount != null
        ? r2(b.taxable_amount)
        : r2(Number(b.gross_amount || 0) - Number(o.hasRecovery ? b.recovery_amount || 0 : 0) - Number(b.discount_amount || 0) - Number(b.debit_amount || 0));
      const vendor = await partyLedger(tx, cid, Number(b.vendor_id), 'CREDITOR');
      const ref = String(b.party_bill_no || b.bill_no);
      return billVoucher(tx, cid, {
        type: 'PURCHASE', date: b.d, partyLedgerId: vendor, partyAmount: Number(b.net_amount), billRef: ref, dueDate: b.due,
        refNo: ref, refDate: b.pbd, narration: `${o.label} ${b.bill_no}${b.party_bill_no ? ` — party bill ${b.party_bill_no}` : ''}`,
        expense: splitByJob(taxable, parts).map((s) => ({ role: o.role, amount: s.amount, so_id: s.so_id })),
        gst: gstSplit(Number(b.gst_amount || 0), Number(b.cgst_amount || 0), Number(b.sgst_amount || 0), Number(b.igst_amount || 0), b.gst_type === 'INTER_STATE'),
        dr: [
          { role: 'FREIGHT_INWARD', amount: Number(b.freight_charges || 0) },
          { role: 'PURCHASE_OTHER_CHARGES', amount: Number(b.other_charges || 0) * (Number(b.other_charges_sign) < 0 ? -1 : 1) },
          { role: 'TCS_RECEIVABLE', amount: Number(b.tcs_amount || 0) },
        ],
        cr: [{ role: 'TDS_PAYABLE', amount: Number(b.tds_amount || 0) }],
        source: { module: o.module, id, no: b.bill_no, event: 'POST' },
      });
    },
  });
}

const contractorBill = simpleSource({
  event: 'CONTRACTOR_BILL.APPROVE', module: 'CONTRACTOR_BILL', postingEvent: 'APPROVE', label: 'Contractor bill',
  link: (id) => `/production/contractor-bills/${id}`,
  table: 'trx_contractor_bill', noCol: 'bill_no', dateCol: 'bill_date', amountExpr: 't.net_amount + COALESCE(t.advance_adjusted,0) - COALESCE(t.excess_as_advance,0)',
  eligibleWhere: `t.status = 'APPROVED'`,
  build: async (tx, cid, id) => {
    const b = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.bill_date,'%Y-%m-%d') d FROM trx_contractor_bill t WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!b) throw DATA('Bill not found');
    const lines = await txQuery<any>(tx,
      `SELECT c.io_no, l.amount FROM trx_contractor_bill_line l LEFT JOIN trx_jobwork_challan c ON c.id = l.challan_id WHERE l.bill_id = ?`, [id]);
    const ioMap = await soIdsByIo(tx, cid, lines.map((l) => l.io_no));
    const parts = lines.map((l) => ({ so_id: ioMap.get(String(l.io_no ?? '').trim()) ?? null, amount: Number(l.amount || 0) }));
    const excessRef = Number(b.excess_as_advance || 0) > 0 ? await txQueryOne<any>(tx,
      `SELECT advance_no FROM trx_contractor_advance WHERE bill_id = ? AND source = 'BILL_EXCESS' AND status <> 'CANCELLED' ORDER BY id DESC LIMIT 1`, [id]) : null;
    const vendor = await partyLedger(tx, cid, Number(b.vendor_id), 'CREDITOR');
    // Advances were paid to the contractor's ledger (Dr party), so the bill credits the party before the advance deduction.
    return billVoucher(tx, cid, {
      type: 'PURCHASE', date: b.d, partyLedgerId: vendor, partyAmount: Number(b.net_amount || 0) + Number(b.advance_adjusted || 0),
      advanceAdjusted: Number(b.advance_adjusted || 0),
      // excess over our rate paid but kept as advance: not stitching cost — a recoverable advance (the BILL_EXCESS advance)
      partyAdvance: Number(b.excess_as_advance || 0) > 0 ? { amount: Number(b.excess_as_advance), ref: excessRef?.advance_no ?? null } : undefined,
      billRef: String(b.bill_no), refNo: b.bill_no, narration: `Contractor bill ${b.bill_no}${b.period_from ? ` (${String(b.period_from).slice(0, 10)} – ${String(b.period_to ?? '').slice(0, 10)})` : ''}`,
      expense: splitByJob(r2(Number(b.gross_amount || 0) - Number(b.excess_as_advance || 0)), parts).map((s) => ({ role: 'JOBWORK_STITCHING', amount: s.amount, so_id: s.so_id })),
      gst: gstSplit(Number(b.gst_amount || 0), 0, 0, 0, !!Number(b.is_interstate)),
      cr: [
        { role: 'TDS_PAYABLE', amount: Number(b.tds_amount || 0) },
        { role: 'JOBWORK_DEDUCTION', amount: Number(b.deduction_amount || 0) + Number(b.other_deduction || 0) + Number(b.debit_note_amount || 0) },
      ],
      source: { module: 'CONTRACTOR_BILL', id, no: b.bill_no, event: 'APPROVE' },
    });
  },
});

const contractorPayment = simpleSource({
  event: 'CONTRACTOR_PAYMENT.POST', module: 'CONTRACTOR_PAYMENT', postingEvent: 'POST', label: 'Contractor payment',
  link: () => `/production/contractor-payments`,
  table: 'trx_contractor_payment', noCol: 'payment_no', dateCol: 'payment_date', amountExpr: 't.amount', eligibleWhere: `t.status = 'POSTED'`,
  build: async (tx, cid, id) => {
    const p = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.payment_date,'%Y-%m-%d') d, b.bill_no FROM trx_contractor_payment t
        LEFT JOIN trx_contractor_bill b ON b.id = t.bill_id WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!p) throw DATA('Payment not found');
    const vendor = await partyLedger(tx, cid, Number(p.vendor_id), 'CREDITOR');
    const money = await payLedger(tx, cid, null, p.mode);
    return payVoucher('PAYMENT', p.d, vendor, money, Number(p.amount), p.bill_no ? { type: 'AGAINST', no: p.bill_no } : { type: 'ON_ACCOUNT', no: null },
      `Contractor payment ${p.payment_no}${p.bill_no ? ` against ${p.bill_no}` : ''} by ${p.mode}${p.reference_no ? ` ref ${p.reference_no}` : ''}`,
      p.reference_no, { module: 'CONTRACTOR_PAYMENT', id, no: p.payment_no, event: 'POST' });
  },
});

const contractorAdvance = simpleSource({
  event: 'CONTRACTOR_ADVANCE.POST', module: 'CONTRACTOR_ADVANCE', postingEvent: 'POST', label: 'Contractor advance',
  link: () => `/production/contractor-advances`,
  table: 'trx_contractor_advance', noCol: 'advance_no', dateCol: 'advance_date', amountExpr: 't.amount',
  eligibleWhere: `t.status = 'ACTIVE' AND t.source = 'PAYMENT'`,
  build: async (tx, cid, id) => {
    const a = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.advance_date,'%Y-%m-%d') d FROM trx_contractor_advance t WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!a) throw DATA('Advance not found');
    const vendor = await partyLedger(tx, cid, Number(a.vendor_id), 'CREDITOR');
    const money = await payLedger(tx, cid, null, a.pay_mode);
    return payVoucher('PAYMENT', a.d, vendor, money, Number(a.amount), { type: 'ADVANCE', no: a.advance_no },
      `Advance ${a.advance_no} to contractor${a.ref_no ? ` ref ${a.ref_no}` : ''}`, a.ref_no, { module: 'CONTRACTOR_ADVANCE', id, no: a.advance_no, event: 'POST' });
  },
});

/** CGST + SGST when the party is in our state (or has no GSTIN), IGST otherwise — for documents that carry one GST figure. */
async function gstByState(tx: Tx, cid: number, partyId: number, gst: number) {
  if (!r2(gst)) return { cgst: 0, sgst: 0, igst: 0 };
  const c = await txQueryOne<any>(tx, `SELECT COALESCE(state_gst_code, LEFT(gstin, 2)) st FROM mst_company WHERE id = ?`, [cid]);
  const p = await txQueryOne<any>(tx, `SELECT LEFT(gstin, 2) st FROM mst_party WHERE id = ?`, [partyId]);
  return gstSplit(gst, 0, 0, 0, !!(p?.st && c?.st && String(p.st) !== String(c.st)));
}

/** Contractor credit note (extra amount owed to the contractor) → Purchase: stitching Dr (+ GST) / contractor Cr. */
const contractorCreditNote = simpleSource({
  event: 'CONTRACTOR_CREDIT_NOTE.POST', module: 'CONTRACTOR_CREDIT_NOTE', postingEvent: 'POST', label: 'Contractor credit note',
  link: () => `/production/contractor-accounts`,
  table: 'trx_contractor_credit_note', noCol: 'cn_no', dateCol: 'cn_date', amountExpr: 't.amount + COALESCE(t.tax, 0)', eligibleWhere: `t.status = 'OPEN'`,
  build: async (tx, cid, id) => {
    const c = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.cn_date,'%Y-%m-%d') d FROM trx_contractor_credit_note t WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!c) throw DATA('Credit note not found');
    const so = c.io_no ? (await soIdsByIo(tx, cid, [c.io_no])).get(String(c.io_no).trim()) ?? null : null;
    const vendor = await partyLedger(tx, cid, Number(c.vendor_id), 'CREDITOR');
    return billVoucher(tx, cid, {
      type: 'PURCHASE', date: c.d, partyLedgerId: vendor, partyAmount: r2(Number(c.amount || 0) + Number(c.tax || 0)), billRef: String(c.cn_no), refNo: c.cn_no,
      narration: `Contractor credit note ${c.cn_no}${c.io_no ? ` · IO ${c.io_no}` : ''}${c.reason ? ` — ${String(c.reason).slice(0, 200)}` : ''}`,
      expense: [{ role: 'JOBWORK_STITCHING', amount: Number(c.amount || 0), so_id: so }],
      gst: await gstByState(tx, cid, Number(c.vendor_id), Number(c.tax || 0)),
      source: { module: 'CONTRACTOR_CREDIT_NOTE', id, no: c.cn_no, event: 'POST' },
    });
  },
});

const purchaseCreditNote = simpleSource({
  event: 'PURCHASE_CREDIT_NOTE.ISSUE', module: 'PURCHASE_CREDIT_NOTE', postingEvent: 'ISSUE', label: 'Purchase return credit note',
  link: (id) => `/procurement/purchase-returns?credit_note=${id}`,
  table: 'trx_purchase_credit_note', noCol: 'credit_note_no', dateCol: 'credit_note_date', amountExpr: 't.total_amount',
  eligibleWhere: `t.status IN ('ISSUED','ADJUSTED')`,
  build: async (tx, cid, id) => {
    const c = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.credit_note_date,'%Y-%m-%d') d, r.material_category, r.return_no
        FROM trx_purchase_credit_note t LEFT JOIN trx_purchase_return r ON r.id = t.purchase_return_id WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!c) throw DATA('Credit note not found');
    const supplier = await partyLedger(tx, cid, Number(c.supplier_id), 'CREDITOR');
    const e: EntryInput[] = [];
    const total = r2(c.total_amount);
    e.push({ ledger_id: supplier, debit: total, bill_ref_type: c.supplier_invoice_no ? 'AGAINST' : 'ON_ACCOUNT', bill_ref_no: c.supplier_invoice_no || null });
    e.push({ ledger_id: await ledgerForRole(tx, cid, 'PURCHASE_RETURN'), credit: r2(c.taxable_amount) });
    for (const [k, role] of [['cgst_amount', 'INPUT_CGST'], ['sgst_amount', 'INPUT_SGST'], ['igst_amount', 'INPUT_IGST']] as const) {
      if (r2(c[k])) e.push({ ledger_id: await ledgerForRole(tx, cid, role), credit: r2(c[k]), tax_kind: role.slice(6) });
    }
    const diff = r2(total - e.slice(1).reduce((t, l) => t + Number(l.credit || 0), 0));
    if (Math.abs(diff) > 1) throw DATA(`Credit note totals do not add up (difference ${diff.toFixed(2)})`);
    if (diff) e.push({ ledger_id: await ledgerForRole(tx, cid, 'ROUND_OFF'), credit: diff > 0 ? diff : 0, debit: diff < 0 ? -diff : 0 });
    if (total <= 0) throw DATA('Credit note total is zero');
    return { type_code: 'DEBIT_NOTE', voucher_date: c.d, party_ledger_id: supplier, ref_no: c.credit_note_no,
      narration: `Purchase return ${c.return_no ?? ''} — credit note ${c.credit_note_no}${c.supplier_invoice_no ? ` against invoice ${c.supplier_invoice_no}` : ''}`,
      entries: e, source: { module: 'PURCHASE_CREDIT_NOTE', id, no: c.credit_note_no, event: 'ISSUE' } };
  },
});

/** Commercial invoice (FINAL) → Sales. INR at the invoice exchange rate; IGST exports: IGST refund receivable Dr / Output IGST Cr. */
const commercialInvoice = simpleSource({
  event: 'COMMERCIAL_INVOICE.FINAL', module: 'COMMERCIAL_INVOICE', postingEvent: 'FINAL', label: 'Commercial invoice',
  link: (id) => `/export/invoices/${id}`,
  table: 'trx_commercial_invoice', noCol: 'invoice_no', dateCol: 'invoice_date', amountExpr: 't.total_value * t.exchange_rate',
  eligibleWhere: `t.doc_status = 'FINAL'`,
  build: async (tx, cid, id) => {
    const inv = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.invoice_date,'%Y-%m-%d') d, c.code ccy, p.party_type
        FROM trx_commercial_invoice t LEFT JOIN cfg_currency c ON c.id = t.currency_id LEFT JOIN mst_party p ON p.id = t.buyer_id
       WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!inv) throw DATA('Invoice not found');
    const xr = Number(inv.exchange_rate) || 0;
    if (xr <= 0) throw DATA('Invoice has no exchange rate');
    const lines = await txQuery<any>(tx, `SELECT line_kind, amount, gst_rate, so_id FROM trx_commercial_invoice_line WHERE invoice_id = ?`, [id]);
    const domestic = String(inv.party_type ?? '').toUpperCase() === 'DOMESTIC';
    const salesRole = domestic ? 'SALES_DOMESTIC' : 'SALES_EXPORT';
    const igstPaid = String(inv.gst_supply_type ?? '').toUpperCase() === 'IGST';
    let gst = 0;
    const parts: { so_id: number | null; amount: number }[] = [];
    for (const l of lines) {
      const inr = r2(Number(l.amount || 0) * xr);
      parts.push({ so_id: l.so_id ? Number(l.so_id) : (inv.so_id ? Number(inv.so_id) : null), amount: inr });
      if (igstPaid) gst += inr * (Number(l.gst_rate ?? (l.line_kind === 'CHARGE' ? inv.charges_gst_rate : inv.goods_gst_rate) ?? 0) / 100);
    }
    gst = r2(gst);
    const salesInr = r2(parts.reduce((t, p) => t + p.amount, 0));
    if (salesInr <= 0) throw DATA('Invoice value is zero');
    const fc = r2(lines.reduce((t, l) => t + Number(l.amount || 0), 0));
    const buyer = await partyLedger(tx, cid, Number(inv.buyer_id), 'DEBTOR');
    const salesLedger = await ledgerForRole(tx, cid, salesRole);
    const e: EntryInput[] = [];
    const buyerAmt = domestic ? r2(salesInr + gst) : salesInr;
    e.push({ ledger_id: buyer, debit: buyerAmt, fc_amount: fc, bill_ref_type: 'NEW', bill_ref_no: inv.invoice_no });
    for (const s of splitByJob(salesInr, parts)) e.push({ ledger_id: salesLedger, credit: s.amount, so_id: s.so_id });
    if (gst) {
      if (!domestic) e.push({ ledger_id: await ledgerForRole(tx, cid, 'IGST_REFUND_RECEIVABLE'), debit: gst, narration: 'IGST paid on export (refund claim)' });
      e.push({ ledger_id: await ledgerForRole(tx, cid, 'OUTPUT_IGST'), credit: gst, tax_kind: 'IGST' });
    }
    return { type_code: 'SALES', voucher_date: inv.d, party_ledger_id: buyer, ref_no: inv.invoice_no,
      currency_code: inv.ccy ?? null, exchange_rate: xr, fc_amount: fc,
      narration: `${domestic ? 'Sales' : 'Export'} invoice ${inv.invoice_no} — ${inv.ccy ?? ''} ${fc.toFixed(2)} @ ${xr}${igstPaid ? ' · IGST paid' : ' · under LUT'}`,
      entries: e, source: { module: 'COMMERCIAL_INVOICE', id, no: inv.invoice_no, event: 'FINAL' } };
  },
});

/**
 * Bank realisation (trx_receipt) → Receipt. Bank Dr (net of charges), Bank charges Dr, buyer Cr per invoice at the
 * invoice's booked rate (bill-wise), unallocated money = buyer advance at the realised rate, the rate difference = exchange gain / loss.
 */
const realisation = simpleSource({
  event: 'REALISATION.POST', module: 'REALISATION', postingEvent: 'POST', label: 'Bank realisation',
  link: (id) => `/accounts/realisations/${id}`,
  table: 'trx_receipt', noCol: 'receipt_no', dateCol: 'receipt_date', amountExpr: 't.amount_inr', eligibleWhere: `t.status = 'POSTED'`,
  build: async (tx, cid, id) => {
    const r = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.receipt_date,'%Y-%m-%d') d, c.code ccy FROM trx_receipt t
        LEFT JOIN cfg_currency c ON c.id = t.currency_id WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!r) throw DATA('Realisation not found');
    const allocs = await txQuery<any>(tx, `SELECT m.allocated_fc, i.invoice_no, i.exchange_rate inv_xr, i.so_id
        FROM map_receipt_invoice m JOIN trx_commercial_invoice i ON i.id = m.invoice_id WHERE m.receipt_id = ?`, [id]);
    const buyer = await partyLedger(tx, cid, Number(r.buyer_id), 'DEBTOR');
    const bank = await payLedger(tx, cid, r.bank_account_id ? Number(r.bank_account_id) : null, r.mode === 'OTHER' ? null : 'BANK');
    const gross = r2(r.amount_inr);
    const charges = r2(r.bank_charges_inr);
    if (gross <= 0) throw DATA('Realised INR amount is zero');
    if (charges >= gross) throw DATA('Bank charges cannot be more than the realised amount');
    const xr = Number(r.exchange_rate) || (Number(r.amount_fc) ? gross / Number(r.amount_fc) : 1);
    const e: EntryInput[] = [{ ledger_id: bank, debit: r2(gross - charges) }];
    if (charges) e.push({ ledger_id: await ledgerForRole(tx, cid, 'BANK_CHARGES'), debit: charges });
    let booked = 0; let allocFc = 0;
    for (const a of allocs) {
      const inr = r2(Number(a.allocated_fc) * Number(a.inv_xr || xr));
      booked = r2(booked + inr); allocFc = r2(allocFc + Number(a.allocated_fc));
      e.push({ ledger_id: buyer, credit: inr, fc_amount: r2(a.allocated_fc), bill_ref_type: 'AGAINST', bill_ref_no: a.invoice_no, so_id: a.so_id ?? null });
    }
    const unallocFc = r2(Number(r.amount_fc) - allocFc);
    if (unallocFc < -0.01) throw DATA('Invoice allocations are more than the amount received');
    if (unallocFc > 0.004) {
      const adv = r2(unallocFc * xr);
      booked = r2(booked + adv);
      e.push({ ledger_id: buyer, credit: adv, fc_amount: unallocFc, bill_ref_type: 'ADVANCE', bill_ref_no: r.receipt_no });
    }
    const fx = r2(gross - booked);   // + gain / − loss
    if (fx) e.push(fx > 0 ? { ledger_id: await ledgerForRole(tx, cid, 'FX_GAIN_LOSS'), credit: fx, narration: 'Exchange gain' }
      : { ledger_id: await ledgerForRole(tx, cid, 'FX_GAIN_LOSS'), debit: -fx, narration: 'Exchange loss' });
    return { type_code: 'RECEIPT', voucher_date: r.d, party_ledger_id: buyer, ref_no: r.bank_ref || r.brc_no || r.receipt_no,
      currency_code: r.ccy ?? null, exchange_rate: xr, fc_amount: r2(r.amount_fc),
      narration: `Realisation ${r.receipt_no}: ${r.ccy ?? ''} ${r2(r.amount_fc).toFixed(2)} @ ${xr}${allocs.length ? ` against ${allocs.map((a) => a.invoice_no).join(', ')}` : ' (advance)'}${r.firc_no ? ` · FIRC ${r.firc_no}` : ''}`,
      entries: e, source: { module: 'REALISATION', id, no: r.receipt_no, event: 'POST' } };
  },
});

const benefitReceipt = simpleSource({
  event: 'EXPORT_BENEFIT.BANK_RECEIPT', module: 'EXPORT_BENEFIT', postingEvent: 'BANK_RECEIPT', label: 'Export incentive receipt',
  link: () => `/export/incentives`,
  table: 'trx_export_benefit_event', noCol: 'source_document_no', dateCol: 'event_date', amountExpr: 'COALESCE(t.base_amount, t.amount)',
  eligibleWhere: `t.status = 'POSTED' AND t.event_type IN ('BANK_RECEIPT','REFUND_CREDIT')`,
  build: async (tx, cid, id) => {
    const ev = await txQueryOne<any>(tx, `SELECT t.*, DATE_FORMAT(t.event_date,'%Y-%m-%d') d, i.incentive_type, i.invoice_id
        FROM trx_export_benefit_event t LEFT JOIN trx_export_incentive i ON i.id = t.claim_id WHERE t.id = ? AND t.company_id = ?`, [id, cid]);
    if (!ev) throw DATA('Benefit event not found');
    const amt = r2(ev.base_amount ?? ev.amount);
    const bank = await payLedger(tx, cid, ev.bank_account_id ? Number(ev.bank_account_id) : null, 'BANK');
    const role = ev.incentive_type === 'GST_REFUND' ? 'IGST_REFUND_RECEIVABLE' : 'EXPORT_INCENTIVE_INCOME';
    if (amt <= 0) throw DATA('Amount is zero');
    return { type_code: 'RECEIPT', voucher_date: ev.d, ref_no: ev.bank_reference || ev.source_document_no,
      narration: `${String(ev.incentive_type ?? 'Export incentive').replace(/_/g, ' ')} received${ev.bank_reference ? ` ref ${ev.bank_reference}` : ''}`,
      entries: [{ ledger_id: bank, debit: amt }, { ledger_id: await ledgerForRole(tx, cid, role), credit: amt }],
      source: { module: 'EXPORT_BENEFIT', id, no: ev.source_document_no || `EV-${id}`, event: 'BANK_RECEIPT' } };
  },
});

export const SOURCES: SourceDef[] = [
  supplierBillApprove, supplierBillPay,
  processBillSource({ event: 'KNITTING_BILL.POST', module: 'KNITTING_BILL', table: 'trx_knitting_bill', lineTable: 'trx_knitting_bill_line',
    role: 'JOBWORK_KNITTING', label: 'Knitting bill', link: '/procurement/bills-inward?tab=KNITTING&id=', hasSo: false, hasRecovery: false }),
  processBillSource({ event: 'FABRIC_PROCESS_BILL.POST', module: 'FABRIC_PROCESS_BILL', table: 'trx_fabric_process_bill', lineTable: 'trx_fabric_process_bill_line',
    role: 'JOBWORK_FABRIC_PROCESS', label: 'Fabric process bill', link: '/procurement/bills-inward?tab=FABRIC_PROCESS&id=', hasSo: true, hasRecovery: true }),
  processBillSource({ event: 'YARN_PROCESS_BILL.POST', module: 'YARN_PROCESS_BILL', table: 'trx_yarn_process_bill', lineTable: 'trx_yarn_process_bill_line',
    role: 'JOBWORK_YARN_PROCESS', label: 'Yarn process bill', link: '/procurement/bills-inward?tab=YARN_PROCESS&id=', hasSo: false, hasRecovery: true }),
  // advances before bills: a contractor bill knocks off the advances already in the books
  contractorAdvance, contractorBill, contractorCreditNote, contractorPayment, purchaseCreditNote, commercialInvoice, realisation, benefitReceipt,
];
export const sourceByEvent = (e: string) => SOURCES.find((s) => s.event === e);
for (const s of SOURCES) if (!POSTING_EVENTS.some((e) => e.code === s.event)) throw new Error(`accounts: no POSTING_EVENTS row for ${s.event}`);

// ============================================================== scan
async function rules(cid: number) {
  const rows = await query<any>(`SELECT event_code, mode, DATE_FORMAT(effective_from,'%Y-%m-%d') ef FROM acc_posting_rule WHERE company_id = ?`, [cid]);
  return new Map(rows.map((r) => [r.event_code as string, { mode: String(r.mode), from: r.ef as string | null }]));
}

async function recordIssue(cid: number, s: SourceDef, row: { id: number; no?: string; date?: string }, err: unknown) {
  const ae = err as AppError;
  const code = (ae?.details as any)?.code ?? (/locked|closed/i.test(String(ae?.message)) ? 'LOCKED' : 'OTHER');
  const msg = String(ae?.message ?? err).slice(0, 1000);
  await execute(`INSERT INTO acc_posting_issue (company_id, event_code, source_id, source_no, source_date, error_code, message)
                 VALUES (?,?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE error_code = VALUES(error_code), message = VALUES(message), source_no = VALUES(source_no),
                   source_date = VALUES(source_date), attempts = attempts + 1, last_seen_at = NOW()`,
    [cid, s.event, row.id, row.no ?? null, row.date ?? null, code, msg]);
}

/** Build + save one document's voucher in its own transaction. mode REVIEW → PENDING_APPROVAL, AUTO → POSTED. */
export async function voucherFromSource(a: Actor, s: SourceDef, sourceId: number, mode: 'REVIEW' | 'AUTO') {
  const out = await transaction(async (tx) => {
    const v = await s.build(tx, a.companyId, sourceId);
    const r = await createVoucher(tx, a, v, mode === 'AUTO' ? 'POSTED' : 'PENDING_APPROVAL');
    if (r.created && r.status === 'POSTED') await enqueueTally(tx, a.companyId, r.id);
    return r;
  });
  await execute(`DELETE FROM acc_posting_issue WHERE company_id = ? AND event_code = ? AND source_id = ?`, [a.companyId, s.event, sourceId]);
  return out;
}

export interface ScanResult { created: number; issues: number; byEvent: Record<string, { created: number; issues: number }> }

/** Scan every enabled event of a company for final documents without a voucher. */
export async function scanCompany(cid: number, userId: number | null, only?: string[]): Promise<ScanResult> {
  await ensureAccountsSetup(cid);
  await transaction((tx) => repairPartyGroups(tx, cid));
  const rs = await rules(cid);
  const res: ScanResult = { created: 0, issues: 0, byEvent: {} };
  for (const s of SOURCES) {
    if (only?.length && !only.includes(s.event)) continue;
    const rule = rs.get(s.event);
    if (!rule || rule.mode === 'OFF') continue;
    const cands = await s.candidates(cid, rule.from, 300);
    const st = (res.byEvent[s.event] = { created: 0, issues: 0 });
    for (const c of cands) {
      try {
        const r = await voucherFromSource({ companyId: cid, userId }, s, Number(c.id), rule.mode === 'AUTO' ? 'AUTO' : 'REVIEW');
        if (r.created) { st.created += 1; res.created += 1; }
      } catch (err) {
        st.issues += 1; res.issues += 1;
        await recordIssue(cid, s, { id: Number(c.id), no: c.no, date: c.date }, err);
      }
    }
  }
  try { await syncBillTracker(cid); } catch (err) { console.error('[accounts] bill tracker sync', cid, (err as Error).message); }
  // issues whose document is no longer pending (cancelled / already posted elsewhere) are cleared
  await execute(`DELETE i FROM acc_posting_issue i
                  WHERE i.company_id = ? AND EXISTS (SELECT 1 FROM acc_voucher v WHERE v.company_id = i.company_id
                        AND v.source_key = CONCAT(SUBSTRING_INDEX(i.event_code, '.', 1), ':', SUBSTRING_INDEX(i.event_code, '.', -1), ':', i.source_id, ':1'))`, [cid]);
  return res;
}

/** Documents waiting for a voucher (eligible, no live voucher) incl. ones before the effective date. */
export async function pendingDocuments(cid: number, event?: string) {
  await ensureAccountsSetup(cid);
  const rs = await rules(cid);
  const issues = await query<any>(`SELECT event_code, source_id, error_code, message, attempts, last_seen_at FROM acc_posting_issue WHERE company_id = ?`, [cid]);
  const iss = new Map(issues.map((i) => [`${i.event_code}:${i.source_id}`, i]));
  const out: any[] = [];
  for (const s of SOURCES) {
    if (event && s.event !== event) continue;
    const rule = rs.get(s.event);
    const rows = await s.candidates(cid, null, 500);
    for (const r of rows) {
      const i = iss.get(`${s.event}:${r.id}`);
      out.push({ event: s.event, label: s.label, source_id: Number(r.id), source_no: r.no, date: r.date, amount: Number(r.amount),
        link: s.link(Number(r.id)), mode: rule?.mode ?? 'OFF', before_effective: !!(rule?.from && r.date && r.date < rule.from),
        issue: i ? { code: i.error_code, message: i.message, attempts: i.attempts, at: i.last_seen_at } : null });
    }
  }
  return out;
}

/** Live vouchers whose document changed after the voucher was made (cancelled / reopened / amount changed). */
export async function staleVouchers(cid: number) {
  const out: any[] = [];
  for (const s of SOURCES) {
    const vs = await query<any>(
      `SELECT v.id, v.voucher_no, v.status, v.source_id, v.source_no, v.total_debit, v.party_ledger_id, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') vdate,
              (SELECT ROUND(ABS(SUM(e.debit) - SUM(e.credit)), 2) FROM acc_voucher_entry e WHERE e.voucher_id = v.id AND e.ledger_id = v.party_ledger_id) party_amt
         FROM acc_voucher v
        WHERE v.company_id = ? AND v.source_module = ? AND v.posting_event = ? AND v.status IN ('PENDING_APPROVAL','POSTED')
        ORDER BY v.id DESC LIMIT 2000`, [cid, s.module, s.postingEvent]);
    if (!vs.length) continue;
    const cur = await s.current(cid, vs.map((v) => Number(v.source_id)));
    for (const v of vs) {
      const c = cur.get(Number(v.source_id));
      let reason: string | null = null;
      if (!c) reason = 'Document deleted';
      else if (!c.eligible) reason = 'Document cancelled / reopened / no longer final';
      // realisation: the buyer is credited at invoice rates (≠ INR received), so only status changes are checked there
      else if (s.module !== 'REALISATION' && v.party_ledger_id && v.party_amt != null && Math.abs(Number(v.party_amt) - c.amount) > 1.0) {
        reason = `Amount changed: voucher ${Number(v.party_amt).toFixed(2)}, document now ${c.amount.toFixed(2)}`;
      }
      if (reason) out.push({ voucher_id: Number(v.id), voucher_no: v.voucher_no, status: v.status, event: s.event, label: s.label,
        source_id: Number(v.source_id), source_no: v.source_no, voucher_date: v.vdate, amount: Number(v.total_debit), reason, link: s.link(Number(v.source_id)) });
    }
  }
  return out;
}

// ============================================================== background scan
let timer: NodeJS.Timeout | null = null;
let running = false;
const lastRun = new Map<number, number>();

/** Every minute: scan companies whose ACC_AUTO_SWEEP_MIN interval has passed (0 = manual only). */
export function startAccountsScanner() {
  if (timer || process.env.ACC_SCANNER === '0') return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // default set-up (groups, ledgers, posting switches) for every company — also ones nobody has opened Accounts in yet
      for (const c of await query<any>(`SELECT id FROM mst_company WHERE is_active = 1`)) {
        try { await ensureAccountsSetup(Number(c.id)); } catch (err) { console.error('[accounts] setup failed for company', c.id, (err as Error).message); }
      }
      const cos = await query<any>(`SELECT c.id, COALESCE(s.setting_value, '10') mins FROM mst_company c
          LEFT JOIN cfg_system_setting s ON s.company_id = c.id AND s.setting_key = 'ACC_AUTO_SWEEP_MIN'
         WHERE c.is_active = 1 AND EXISTS (SELECT 1 FROM acc_posting_rule r WHERE r.company_id = c.id AND r.mode <> 'OFF')`);
      for (const c of cos) {
        const mins = Number(c.mins);
        if (!(mins > 0)) continue;
        const last = lastRun.get(Number(c.id)) ?? 0;
        if (Date.now() - last < mins * 60_000) continue;
        lastRun.set(Number(c.id), Date.now());
        try { await scanCompany(Number(c.id), null); } catch (err) { console.error('[accounts] scan failed for company', c.id, (err as Error).message); }
      }
    } catch (err) {
      console.error('[accounts] scanner:', (err as Error).message);
    } finally { running = false; }
  }, 60_000);
  timer.unref?.();
}

export async function sourceSummary(cid: number) {
  const r = await queryOne<any>(`SELECT COUNT(*) n FROM acc_posting_issue WHERE company_id = ?`, [cid]);
  return { issues: Number(r?.n ?? 0) };
}
export { sourceKey };
