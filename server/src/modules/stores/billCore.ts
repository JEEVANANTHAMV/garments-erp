import type { Request } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query, queryOne, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors.js';
import { n, r2 } from './common.js';

/**
 * Bill tracker core (client voice note 24-Oct-2026 — "Bill Tracker, Document Inward, Matching & Accounting Auto-Posting" spec):
 * link registry, required-document evaluation, matching engine, custody movements, posting adapter, private file storage.
 *
 * Status dimensions are kept apart on trx_bill_tracker:
 *   status              custody step the client already uses (RECEIVED / HANDED_OVER / RECEIVED_BACK / SUBMITTED / CANCELLED)
 *   workflow_status     OPEN → PENDING_VERIFICATION → PENDING_APPROVAL → APPROVED (+ ON_HOLD / REJECTED / CANCELLED / REVERSED)
 *   completeness_status COMPLETE / INCOMPLETE (data missing) / AWAITING_LINK (required documents missing) — missing_docs says which
 *   match_status        NOT_RUN / MATCHED / WARNING / BLOCKED / RESOLVED
 *   duplicate_status    NONE / SUSPECTED / CLEARED
 *   posting_status      NOT_ELIGIBLE / QUEUED / POSTED / FAILED / UNKNOWN / RECON_REQUIRED / REVERSED
 *   holder_*            current custody from the latest movement
 */

export const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
export const addDays = (d: string, k: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + k * 86400e3).toISOString().slice(0, 10);
export const normNo = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const NORM_SQL = (col: string) => `REGEXP_REPLACE(UPPER(COALESCE(${col}, '')), '[^A-Z0-9]', '')`;
export const can = (req: Request, code: string) => !!req.user && (req.user.isSuperAdmin || req.user.permissions.has(code));
export function need(req: Request, ...codes: string[]) {
  if (!codes.some((c) => can(req, c))) throw Forbidden(`Requires one of: ${codes.join(', ')}`);
}

/** Workflow states in which the bill still counts (cumulative billing, duplicates). */
export const LIVE_WF = `('OPEN','PENDING_VERIFICATION','PENDING_APPROVAL','APPROVED','ON_HOLD')`;

// ================================================================== link registry
export type Evidence = 'DC' | 'RECEIPT' | 'PO' | 'BILL_ENTRY' | 'PROCESS';
export const LINK_TYPES = ['DOC_INWARD', 'GATE_INWARD', 'JOBWORK_CHALLAN', 'GRN', 'TRIM_GRN', 'PO', 'TRIM_PO', 'SUPPLIER_BILL',
  'KNITTING_BILL', 'FABRIC_PROCESS_BILL', 'YARN_PROCESS_BILL', 'CONTRACTOR_BILL'] as const;
export type LinkType = typeof LINK_TYPES[number];

interface TargetDef {
  label: string;
  /** SELECT … id, no, ref, dt, party_id, qty, amount, ok (1 = usable), doc_type — FROM … alias t, company-scoped with `t.company_id = ?`. */
  sql: string;
  evidence: (row: any) => Evidence[];
  /** Has a value against which cumulative billing is checked. */
  valued: boolean;
}

const procBill = (table: string, label: string): TargetDef => ({
  label,
  sql: `SELECT t.id, t.bill_no no, t.party_bill_no ref, COALESCE(t.party_bill_date, t.bill_date) dt, t.vendor_id party_id, NULL qty, t.net_amount amount,
               IF(t.status = 'CANCELLED', 0, 1) ok, NULL doc_type FROM ${table} t WHERE t.company_id = ?`,
  evidence: () => ['BILL_ENTRY', 'PROCESS'], valued: true,
});

export const TARGETS: Record<LinkType, TargetDef> = {
  DOC_INWARD: {
    label: 'Inward document',
    sql: `SELECT t.id, t.inward_no no, t.doc_no ref, COALESCE(t.doc_date, t.receipt_date) dt, t.party_id, NULL qty, t.amount, IF(t.status = 'ACTIVE', 1, 0) ok, t.doc_type
            FROM trx_document_inward t WHERE t.company_id = ?`,
    evidence: (r) => (['DC', 'PROCESS_CHALLAN'].includes(r.doc_type) ? ['DC'] : []), valued: false,
  },
  GATE_INWARD: {
    label: 'Supplier DC (gate inward)',
    sql: `SELECT t.id, t.entry_no no, t.supplier_dc_no ref, COALESCE(t.supplier_dc_date, t.entry_date) dt, t.party_id, NULL qty, NULL amount,
                 IF(t.status IN ('CANCELLED', 'REJECTED'), 0, 1) ok, NULL doc_type FROM trx_gate_inward t WHERE t.company_id = ?`,
    evidence: () => ['DC'], valued: false,
  },
  JOBWORK_CHALLAN: {
    label: 'Process DC (job work)',
    sql: `SELECT t.id, t.challan_no no, t.ref_no ref, t.challan_date dt, t.vendor_id party_id, t.total_qty qty, t.total_amount amount,
                 IF(t.status = 'CANCELLED', 0, 1) ok, NULL doc_type FROM trx_jobwork_challan t WHERE t.company_id = ?`,
    evidence: (r) => (n(r.amount) > 0 ? ['DC', 'PROCESS'] : ['DC']), valued: true,
  },
  GRN: {
    label: 'GRN',
    sql: `SELECT t.id, t.grn_no no, t.supplier_inv_no ref, t.grn_date dt, t.supplier_id party_id,
                 (SELECT SUM(COALESCE(l.accepted_qty, l.received_qty)) FROM trx_grn_line l WHERE l.grn_id = t.id) qty,
                 COALESCE(NULLIF(t.grand_total, 0), t.net_amount) amount, 1 ok, NULL doc_type FROM trx_grn t WHERE t.company_id = ?`,
    evidence: () => ['RECEIPT'], valued: true,
  },
  TRIM_GRN: {
    label: 'Trim GRN',
    sql: `SELECT t.id, t.grn_no no, t.supplier_inv_no ref, t.grn_date dt, t.supplier_id party_id,
                 (SELECT SUM(COALESCE(l.accepted_qty, l.received_qty)) FROM trx_trim_grn_line l WHERE l.grn_id = t.id) qty,
                 t.net_amount amount, IF(t.status = 'CANCELLED', 0, 1) ok, NULL doc_type FROM trx_trim_grn t WHERE t.company_id = ?`,
    evidence: () => ['RECEIPT'], valued: true,
  },
  PO: {
    label: 'Purchase order',
    sql: `SELECT t.id, t.po_no no, NULL ref, t.po_date dt, t.supplier_id party_id,
                 (SELECT SUM(l.qty) FROM trx_purchase_order_line l WHERE l.po_id = t.id) qty, COALESCE(NULLIF(t.grand_total, 0), t.total_amount) amount,
                 IF(t.is_deleted = 1 OR t.approval_state IN ('CANCELLED', 'REJECTED'), 0, 1) ok, NULL doc_type FROM trx_purchase_order t WHERE t.company_id = ?`,
    evidence: () => ['PO'], valued: true,
  },
  TRIM_PO: {
    label: 'Trim PO',
    sql: `SELECT t.id, t.po_no no, NULL ref, t.po_date dt, t.supplier_id party_id,
                 (SELECT SUM(l.order_qty) FROM trx_trim_po_line l WHERE l.po_id = t.id) qty, COALESCE(NULLIF(t.grand_total, 0), t.total_amount) amount,
                 IF(t.status = 'CANCELLED', 0, 1) ok, NULL doc_type FROM trx_trim_po t WHERE t.company_id = ?`,
    evidence: () => ['PO'], valued: true,
  },
  SUPPLIER_BILL: {
    label: 'Bills Inward entry',
    sql: `SELECT t.id, t.bill_no no, t.supplier_inv_no ref, COALESCE(t.supplier_inv_date, t.bill_date) dt, t.supplier_id party_id,
                 (SELECT SUM(l.bill_qty) FROM trx_supplier_bill_line l WHERE l.bill_id = t.id) qty, t.total_amount amount,
                 IF(t.status = 'CANCELLED', 0, 1) ok, NULL doc_type FROM trx_supplier_bill t WHERE t.company_id = ?`,
    evidence: () => ['BILL_ENTRY'], valued: true,
  },
  KNITTING_BILL: procBill('trx_knitting_bill', 'Knitting bill'),
  FABRIC_PROCESS_BILL: procBill('trx_fabric_process_bill', 'Fabric process bill'),
  YARN_PROCESS_BILL: procBill('trx_yarn_process_bill', 'Yarn process bill'),
  CONTRACTOR_BILL: {
    label: 'Contractor bill',
    sql: `SELECT t.id, t.bill_no no, NULL ref, t.bill_date dt, t.vendor_id party_id, t.billed_qty qty, t.net_amount amount,
                 IF(t.status = 'CANCELLED', 0, 1) ok, NULL doc_type FROM trx_contractor_bill t WHERE t.company_id = ?`,
    evidence: () => ['BILL_ENTRY', 'PROCESS'], valued: true,
  },
};

const targetSql = async (type: LinkType) => TARGETS[type].sql;

export async function loadTarget(cid: number, type: LinkType, id: number, tx?: Tx) {
  const sql = `${await targetSql(type)} AND t.id = ?`;
  const row = tx ? await txQueryOne<any>(tx, sql, [cid, id]) : await queryOne<any>(sql, [cid, id]);
  return row;
}

/** Candidate documents to link (party first, then search), with what other live bills already cover. */
export async function searchTargets(cid: number, type: LinkType, partyId: number | null, q: string | undefined, billId?: number | null) {
  const where: string[] = []; const p: unknown[] = [cid];
  if (partyId) { where.push('party_id = ?'); p.push(partyId); }
  if (q) { where.push('(no LIKE ? OR ref LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
  const rows = await query<any>(`SELECT * FROM (${await targetSql(type)}) x WHERE ok = 1 ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY dt DESC, id DESC LIMIT 100`, p);
  const used = await billedAgainst(cid, type, rows.map((r) => Number(r.id)), billId ?? null);
  return rows.map((r) => {
    const u = used.get(Number(r.id));
    return { ...r, billed_amount: r2(n(u?.amount)), billed_qty: n(u?.qty), billed_by: u?.bills ?? null,
      remaining_amount: r.amount === null ? null : r2(Math.max(0, n(r.amount) - n(u?.amount))), remaining_qty: r.qty === null ? null : Math.max(0, n(r.qty) - n(u?.qty)) };
  });
}

/** What live bills (other than `exceptBill`) have linked against each target. */
export async function billedAgainst(cid: number, type: LinkType, ids: number[], exceptBill: number | null, tx?: Tx) {
  const m = new Map<number, { amount: number; qty: number; bills: string }>();
  if (!ids.length) return m;
  const sql = `SELECT l.target_id, SUM(COALESCE(l.linked_amount, 0)) amount, SUM(COALESCE(l.linked_qty, 0)) qty, GROUP_CONCAT(DISTINCT b.entry_no ORDER BY b.entry_no) bills
                 FROM trx_bill_tracker_link l JOIN trx_bill_tracker b ON b.id = l.bill_id
                WHERE l.company_id = ? AND l.link_type = ? AND l.target_id IN (?) AND l.removed_at IS NULL AND b.workflow_status IN ${LIVE_WF}
                  AND b.id <> ? GROUP BY l.target_id`;
  const params = [cid, type, ids, exceptBill ?? 0];
  const rows = tx ? await txQuery<any>(tx, sql, params) : await query<any>(sql, params);
  for (const r of rows) m.set(Number(r.target_id), { amount: n(r.amount), qty: n(r.qty), bills: r.bills });
  return m;
}

// ================================================================== categories
export interface Category {
  id: number; category_code: string; category_name: string; req_dc: number; req_receipt: number; req_po: number; req_bill_entry: number; req_process: number;
  req_attachment: number; amount_tol_pct: number; amount_tol_abs: number; qty_tol_pct: number; over_billing: 'BLOCK' | 'APPROVAL'; high_value_limit: number;
}
export async function categoryOf(cid: number, code: string, tx?: Tx): Promise<Category> {
  const sql = 'SELECT * FROM cfg_bill_category WHERE company_id = ? AND category_code = ?';
  const c = tx ? await txQueryOne<any>(tx, sql, [cid, code]) : await queryOne<any>(sql, [cid, code]);
  if (!c) throw BadRequest(`Bill category ${code} is not set up — see Bill Tracker → Settings`);
  for (const k of ['amount_tol_pct', 'amount_tol_abs', 'qty_tol_pct', 'high_value_limit']) c[k] = n(c[k]);
  return c;
}
export const tolAmount = (c: Category, base: number) => r2(Math.max(n(c.amount_tol_abs), Math.abs(base) * n(c.amount_tol_pct) / 100));
export const tolQty = (c: Category, base: number) => Math.abs(base) * n(c.qty_tol_pct) / 100;

const REQ_LABEL: Record<string, string> = { DC: 'DC', GRN: 'GRN', PO: 'Purchase order', BILL_ENTRY: 'Bills Inward entry', PROCESS: 'Process receipt / approved rate', FILE: 'Scanned copy', DATA: 'Bill details' };
export const missingLabel = (codes: string | null | undefined) => String(codes ?? '').split(',').filter(Boolean).map((c) => REQ_LABEL[c] ?? c);

// ================================================================== evaluation (completeness)
export async function activeLinks(tx: Tx, billId: number) {
  return txQuery<any>(tx, `SELECT * FROM trx_bill_tracker_link WHERE bill_id = ? AND removed_at IS NULL ORDER BY id`, [billId]);
}
async function linkEvidence(tx: Tx, cid: number, l: any): Promise<Evidence[]> {
  const t = TARGETS[l.link_type as LinkType];
  if (!t) return [];
  if (l.link_type === 'DOC_INWARD') {
    const d = await txQueryOne<any>(tx, 'SELECT doc_type FROM trx_document_inward WHERE id = ? AND company_id = ?', [l.target_id, cid]);
    return t.evidence(d ?? {});
  }
  return t.evidence({ amount: l.target_amount });
}
async function fileCount(tx: Tx, cid: number, bill: any) {
  const r = await txQueryOne<any>(tx,
    `SELECT COUNT(*) c FROM trx_bill_doc_attachment a WHERE a.company_id = ? AND a.is_removed = 0
        AND (a.bill_id = ? OR a.inward_id = ? OR a.inward_id IN (SELECT l.target_id FROM trx_bill_tracker_link l WHERE l.bill_id = ? AND l.link_type = 'DOC_INWARD' AND l.removed_at IS NULL))`,
    [cid, bill.id, bill.inward_id ?? 0, bill.id]);
  return n(r?.c);
}

/** Required-document check for the bill's category → missing_docs + completeness_status (stored). */
export async function evaluate(tx: Tx, cid: number, billId: number) {
  const b = await txQueryOne<any>(tx, 'SELECT * FROM trx_bill_tracker WHERE id = ? AND company_id = ?', [billId, cid]);
  if (!b) throw NotFound('Bill not found');
  const cat = await categoryOf(cid, b.bill_category, tx);
  const links = await activeLinks(tx, billId);
  const ev = new Set<Evidence>();
  for (const l of links) for (const e of await linkEvidence(tx, cid, l)) ev.add(e);
  const missing: string[] = [];
  if (!b.supplier_id || !b.bill_date || n(b.amount) <= 0) missing.push('DATA');
  if (cat.req_dc && !ev.has('DC')) missing.push('DC');
  if (cat.req_receipt && !ev.has('RECEIPT')) missing.push('GRN');
  if (cat.req_po && !ev.has('PO')) missing.push('PO');
  if (cat.req_bill_entry && !ev.has('BILL_ENTRY')) missing.push('BILL_ENTRY');
  if (cat.req_process && !ev.has('PROCESS')) missing.push('PROCESS');
  if (cat.req_attachment && !(await fileCount(tx, cid, b))) missing.push('FILE');
  const completeness = missing.includes('DATA') ? 'INCOMPLETE' : missing.length ? 'AWAITING_LINK' : 'COMPLETE';
  await txExecute(tx, 'UPDATE trx_bill_tracker SET completeness_status = ?, missing_docs = ? WHERE id = ?', [completeness, missing.join(',') || null, billId]);
  return { completeness, missing, links, evidence: ev, cat, bill: b };
}

/** Something on the bill changed: re-check completeness; a matching result is no longer current. */
export async function touched(tx: Tx, cid: number, billId: number) {
  await txExecute(tx, `UPDATE trx_bill_tracker SET match_status = 'NOT_RUN', matched_at = NULL WHERE id = ?`, [billId]);
  return evaluate(tx, cid, billId);
}

// ================================================================== duplicates
/** Same supplier + normalized invoice no: other live tracker bills (duplicates) and Bills Inward entries (to link, or duplicates when another bill has them). */
export async function duplicateCandidates(cid: number, supplierId: number | null, billNo: string, exceptBill: number | null) {
  const norm = normNo(billNo);
  if (!supplierId || !norm) return { duplicates: [] as any[], bill_entries: [] as any[] };
  const duplicates = await query<any>(
    `SELECT b.id, b.entry_no, b.bill_no, b.bill_date, b.amount, b.workflow_status FROM trx_bill_tracker b
      WHERE b.company_id = ? AND b.supplier_id = ? AND b.normalized_bill_no = ? AND b.id <> ? AND b.workflow_status IN ${LIVE_WF}`,
    [cid, supplierId, norm, exceptBill ?? 0]);
  const entries = await query<any>(
    `SELECT sb.id, sb.bill_no, sb.supplier_inv_no, COALESCE(sb.supplier_inv_date, sb.bill_date) bill_date, sb.total_amount,
            (SELECT GROUP_CONCAT(b.entry_no) FROM trx_bill_tracker_link l JOIN trx_bill_tracker b ON b.id = l.bill_id
              WHERE l.link_type = 'SUPPLIER_BILL' AND l.target_id = sb.id AND l.removed_at IS NULL AND b.workflow_status IN ${LIVE_WF} AND b.id <> ?) linked_to
       FROM trx_supplier_bill sb WHERE sb.company_id = ? AND sb.supplier_id = ? AND sb.status <> 'CANCELLED'
        AND ${NORM_SQL('COALESCE(sb.supplier_inv_no, sb.bill_no)')} = ?`,
    [exceptBill ?? 0, cid, supplierId, norm]);
  return { duplicates, bill_entries: entries };
}

// ================================================================== matching engine
export interface MatchRow { rule_code: string; label: string; severity: 'PASS' | 'INFO' | 'WARNING' | 'BLOCKING'; link_id?: number | null;
  expected?: string | null; actual?: string | null; variance?: string | null; tolerance?: string | null }
/** Rules an approver may override (with a reason). Data, required documents, duplicates and tax totals must be fixed instead. */
export const OVERRIDABLE = new Set(['OVERBILLING', 'RECEIPT_AMOUNT', 'RECEIPT_QTY', 'BILL_ENTRY_AMOUNT', 'SUPPLIER', 'PO_AMOUNT', 'PROCESS_AMOUNT']);
const money = (v: number) => r2(v).toFixed(2);
const qtyS = (v: number) => String(Math.round(v * 1000) / 1000);

/** Run every rule, refresh link snapshots, store the run (overrides carry over when the figures did not change). */
export async function runMatching(tx: Tx, cid: number, billId: number, uid: number | null) {
  // refresh the target snapshots first (a GRN may have been amended since it was linked)
  for (const l of await activeLinks(tx, billId)) {
    const t = await loadTarget(cid, l.link_type, l.target_id, tx);
    if (t) await txExecute(tx, 'UPDATE trx_bill_tracker_link SET target_qty = ?, target_amount = ?, target_party_id = ? WHERE id = ?',
      [t.qty === null ? null : n(t.qty), t.amount === null ? null : r2(n(t.amount)), t.party_id ?? null, l.id]);
  }
  const { missing, links, cat, bill: b } = await evaluate(tx, cid, billId);
  const out: MatchRow[] = [];
  const amount = n(b.amount);
  const today = istToday();

  // 1 · bill details
  if (!b.supplier_id) out.push({ rule_code: 'DATA', label: 'Supplier is not entered', severity: 'BLOCKING' });
  if (!b.bill_date) out.push({ rule_code: 'DATA', label: 'Invoice date is not entered', severity: 'BLOCKING' });
  else if (String(b.bill_date) > today) out.push({ rule_code: 'DATA', label: 'Invoice date is in the future', severity: 'BLOCKING', actual: b.bill_date });
  else if (String(b.bill_date) > String(b.entry_date)) out.push({ rule_code: 'DATA', label: 'Invoice date is after the date it was received', severity: 'WARNING', expected: `≤ ${b.entry_date}`, actual: b.bill_date });
  if (amount <= 0) out.push({ rule_code: 'DATA', label: 'Bill amount is zero', severity: 'BLOCKING' });
  if (b.currency_code && b.currency_code !== 'INR' && (n(b.exchange_rate) <= 0 || n(b.exchange_rate) === 1))
    out.push({ rule_code: 'FX', label: `Exchange rate needed for a ${b.currency_code} bill`, severity: 'BLOCKING', actual: String(b.exchange_rate) });
  if (b.taxable_value !== null && b.taxable_value !== undefined) {
    const calc = n(b.taxable_value) + n(b.cgst_amount) + n(b.sgst_amount) + n(b.igst_amount) + n(b.other_charges) + n(b.round_off);
    const v = r2(amount - calc);
    out.push({ rule_code: 'TAX_TOTAL', label: 'Taxable value + GST + other charges + round off = bill total', severity: Math.abs(v) > 1 ? 'BLOCKING' : 'PASS',
      expected: money(calc), actual: money(amount), variance: money(v), tolerance: '1.00' });
  }
  if (out.every((r) => r.rule_code !== 'DATA')) out.push({ rule_code: 'DATA', label: 'Supplier, invoice no, date and amount entered', severity: 'PASS' });

  // 2 · required documents for the category
  const reqs: [string, number, string][] = [['DC', cat.req_dc, 'DC'], ['GRN', cat.req_receipt, 'GRN'], ['PO', cat.req_po, 'Purchase order'],
    ['BILL_ENTRY', cat.req_bill_entry, 'Bills Inward entry'], ['PROCESS', cat.req_process, 'Process receipt at the approved rate'], ['FILE', cat.req_attachment, 'Scanned copy']];
  for (const [code, req, label] of reqs) {
    if (!req) continue;
    out.push({ rule_code: `REQ_${code}`, label: `${label} — required for ${cat.category_name.split(' (')[0]} bills`, severity: missing.includes(code) ? 'BLOCKING' : 'PASS',
      expected: 'Linked', actual: missing.includes(code) ? 'Missing' : 'Linked' });
  }
  if (!reqs.some(([, r]) => r)) out.push({ rule_code: 'REQ_NONE', label: `${cat.category_name.split(' (')[0]}: no supporting document is required`, severity: 'INFO' });

  // 3 · duplicates
  if (b.duplicate_status === 'SUSPECTED') out.push({ rule_code: 'DUPLICATE', label: `Duplicate suspected: ${b.duplicate_note ?? 'same supplier + invoice no'}`, severity: 'BLOCKING' });
  const dup = await duplicateCandidates(cid, b.supplier_id, b.bill_no, billId);
  if (dup.duplicates.length && b.duplicate_status !== 'CLEARED' && b.duplicate_status !== 'SUSPECTED')
    out.push({ rule_code: 'DUPLICATE', label: `Same supplier + invoice no on ${dup.duplicates.map((d: any) => d.entry_no).join(', ')}`, severity: 'BLOCKING' });

  // 4 · per link: supplier, cumulative billing (over-billing)
  const byKind = (k: Evidence) => links.filter((l) => TARGETS[l.link_type as LinkType]?.evidence({ amount: l.target_amount }).includes(k) && l.link_type !== 'DOC_INWARD');
  for (const l of links) {
    const def = TARGETS[l.link_type as LinkType];
    const name = `${def?.label ?? l.link_type} ${l.target_no ?? l.target_id}`;
    if (b.supplier_id && l.target_party_id && Number(l.target_party_id) !== Number(b.supplier_id))
      out.push({ rule_code: 'SUPPLIER', link_id: l.id, label: `${name} is of another party`, severity: 'BLOCKING', expected: String(b.supplier_id), actual: String(l.target_party_id) });
    if (def?.valued && l.target_amount !== null) {
      const others = (await billedAgainst(cid, l.link_type, [Number(l.target_id)], billId, tx)).get(Number(l.target_id));
      const total = n(others?.amount) + n(l.linked_amount);
      const tol = tolAmount(cat, n(l.target_amount));
      if (total > n(l.target_amount) + tol)
        out.push({ rule_code: 'OVERBILLING', link_id: l.id, label: `${name}: billed more than its value${others ? ` (also on ${others.bills})` : ''}`, severity: 'BLOCKING',
          expected: `≤ ${money(n(l.target_amount))}`, actual: money(total), variance: money(total - n(l.target_amount)), tolerance: money(tol) });
      if (l.link_type === 'SUPPLIER_BILL' && others?.bills)
        out.push({ rule_code: 'DUPLICATE', link_id: l.id, label: `${name} is already linked to ${others.bills}`, severity: 'BLOCKING' });
    }
  }

  // 5 · value / qty comparisons
  const sum = (ls: any[], k: 'linked_amount' | 'linked_qty') => ls.reduce((s, l) => s + n(l[k]), 0);
  const entries = byKind('BILL_ENTRY');
  if (entries.length) {
    const exp = sum(entries, 'linked_amount'); const v = r2(amount - exp); const tol = tolAmount(cat, exp);
    out.push({ rule_code: 'BILL_ENTRY_AMOUNT', label: 'Bill amount = Bills Inward entry total', severity: Math.abs(v) > tol ? 'BLOCKING' : 'PASS',
      expected: money(exp), actual: money(amount), variance: money(v), tolerance: money(tol) });
  }
  const receipts = byKind('RECEIPT');
  if (receipts.length) {
    const exp = sum(receipts, 'linked_amount'); const v = r2(amount - exp); const tol = tolAmount(cat, exp);
    out.push({ rule_code: 'RECEIPT_AMOUNT', label: `Bill amount vs GRN value (${receipts.length} GRN${receipts.length > 1 ? 's' : ''})`,
      severity: v > tol ? 'BLOCKING' : v < -tol ? 'WARNING' : 'PASS', expected: money(exp), actual: money(amount), variance: money(v), tolerance: money(tol) });
    if (b.bill_qty !== null && b.bill_qty !== undefined && receipts.some((l) => l.linked_qty !== null)) {
      const eq = sum(receipts, 'linked_qty'); const vq = n(b.bill_qty) - eq; const tq = tolQty(cat, eq);
      out.push({ rule_code: 'RECEIPT_QTY', label: 'Billed qty vs accepted qty', severity: vq > tq ? 'BLOCKING' : vq < -tq ? 'WARNING' : 'PASS',
        expected: qtyS(eq), actual: qtyS(n(b.bill_qty)), variance: qtyS(vq), tolerance: qtyS(tq) });
    }
  }
  const proc = byKind('PROCESS').filter((l) => !entries.includes(l));
  if (proc.length) {
    const exp = sum(proc, 'linked_amount'); const v = r2(amount - exp); const tol = tolAmount(cat, exp);
    out.push({ rule_code: 'PROCESS_AMOUNT', label: 'Bill amount vs process DC value at the approved rate', severity: v > tol ? 'BLOCKING' : v < -tol ? 'WARNING' : 'PASS',
      expected: money(exp), actual: money(amount), variance: money(v), tolerance: money(tol) });
  }
  const pos = byKind('PO');
  if (pos.length) {
    const exp = sum(pos, 'linked_amount'); const v = r2(amount - exp); const tol = tolAmount(cat, exp);
    out.push({ rule_code: 'PO_AMOUNT', label: 'Bill amount within the PO value', severity: v > tol ? 'WARNING' : 'PASS',
      expected: `≤ ${money(exp)}`, actual: money(amount), variance: money(v), tolerance: money(tol) });
  }
  for (const l of links.filter((x) => x.needs_override))
    if (!out.some((r) => r.rule_code === 'OVERBILLING' && r.link_id === l.id))
      out.push({ rule_code: 'OVERBILLING', link_id: l.id, label: `${l.target_no}: linked beyond the remaining value`, severity: 'BLOCKING', actual: money(n(l.linked_amount)), expected: money(n(l.target_amount)) });

  // store the run; carry an override when the same rule shows the same figures
  const prev = await txQuery<any>(tx, `SELECT * FROM trx_bill_match_result WHERE bill_id = ? AND result_status = 'OVERRIDDEN'
                                         AND run_no = (SELECT MAX(run_no) FROM trx_bill_match_result WHERE bill_id = ?)`, [billId, billId]);
  const runNo = n((await txQueryOne<any>(tx, 'SELECT MAX(run_no) m FROM trx_bill_match_result WHERE bill_id = ?', [billId]))?.m) + 1;
  for (const r of out) {
    const carry = r.severity === 'BLOCKING' && OVERRIDABLE.has(r.rule_code)
      ? prev.find((p) => p.rule_code === r.rule_code && Number(p.link_id ?? 0) === Number(r.link_id ?? 0) && (p.expected_value ?? null) === (r.expected ?? null) && (p.actual_value ?? null) === (r.actual ?? null))
      : null;
    await txExecute(tx,
      `INSERT INTO trx_bill_match_result (company_id, bill_id, run_no, rule_code, link_id, label, severity, expected_value, actual_value, variance_value, tolerance,
                                          result_status, override_reason, overridden_by, overridden_at, evaluated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, billId, runNo, r.rule_code, r.link_id ?? null, r.label.slice(0, 255), r.severity, r.expected ?? null, r.actual ?? null, r.variance ?? null, r.tolerance ?? null,
       carry ? 'OVERRIDDEN' : r.severity === 'BLOCKING' || r.severity === 'WARNING' ? 'OPEN' : 'OK', carry?.override_reason ?? null, carry?.overridden_by ?? null,
       carry?.overridden_at ?? null, uid]);
  }
  const status = await statusFromResults(tx, billId, runNo);
  await txExecute(tx, 'UPDATE trx_bill_tracker SET match_status = ?, matched_at = NOW() WHERE id = ?', [status, billId]);
  return { run_no: runNo, match_status: status, results: out };
}

export async function statusFromResults(tx: Tx, billId: number, runNo: number) {
  const rs = await txQuery<any>(tx, 'SELECT severity, result_status FROM trx_bill_match_result WHERE bill_id = ? AND run_no = ?', [billId, runNo]);
  if (rs.some((r) => r.severity === 'BLOCKING' && r.result_status === 'OPEN')) return 'BLOCKED';
  if (rs.some((r) => r.result_status === 'OVERRIDDEN')) return 'RESOLVED';
  if (rs.some((r) => r.severity === 'WARNING')) return 'WARNING';
  return 'MATCHED';
}

// ================================================================== custody movements
export interface MoveIn {
  movement_type: 'RECEIPT' | 'HANDOVER' | 'RETURN' | 'TO_ACCOUNTS' | 'TRANSFER' | 'CORRECTION';
  to_holder: string | null; to_user_id?: number | null; to_dept?: string | null; to_location?: string | null;
  purpose?: string | null; business_date: string; expected_return_date?: string | null; note?: string | null; corrects_movement_id?: number | null;
  from?: { holder: string | null; user_id: number | null; dept: string | null; location: string | null } | null; inward_id?: number | null;
}
/** Adds a movement (never edits one) and sets the bill's current holder. */
export async function addMovement(tx: Tx, cid: number, billId: number, uid: number | null, m: MoveIn) {
  const b = await txQueryOne<any>(tx, 'SELECT holder_name, holder_user_id, holder_dept, holder_location FROM trx_bill_tracker WHERE id = ? FOR UPDATE', [billId]);
  const seq = n((await txQueryOne<any>(tx, 'SELECT MAX(seq) s FROM trx_bill_movement WHERE bill_id = ?', [billId]))?.s) + 1;
  const from = m.from ?? { holder: b?.holder_name ?? null, user_id: b?.holder_user_id ?? null, dept: b?.holder_dept ?? null, location: b?.holder_location ?? null };
  const ack = m.to_user_id && m.to_user_id !== uid && m.movement_type !== 'RECEIPT' ? 'PENDING' : 'NOT_REQUIRED';
  const r = await txExecute(tx,
    `INSERT INTO trx_bill_movement (company_id, bill_id, inward_id, seq, movement_type, from_holder, from_user_id, from_dept, from_location, to_holder, to_user_id, to_dept,
                                    to_location, purpose, business_date, expected_return_date, handed_over_by, ack_status, corrects_movement_id, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, billId, m.inward_id ?? null, seq, m.movement_type, from.holder, from.user_id, from.dept, from.location, m.to_holder, m.to_user_id ?? null, m.to_dept ?? null,
     m.to_location ?? null, m.purpose ?? null, m.business_date, m.expected_return_date ?? null, uid, ack, m.corrects_movement_id ?? null, m.note ?? null]);
  await txExecute(tx,
    `UPDATE trx_bill_tracker SET holder_name = ?, holder_user_id = ?, holder_dept = ?, holder_location = ?, holder_since = NOW(), holder_expected_back = ?, row_version = row_version + 1 WHERE id = ?`,
    [m.to_holder, m.to_user_id ?? null, m.to_dept ?? null, m.to_location ?? null, m.expected_return_date ?? null, billId]);
  return r.insertId as number;
}

export async function userName(tx: Tx, uid: number | null) {
  if (!uid) return null;
  return (await txQueryOne<any>(tx, 'SELECT full_name FROM mst_user WHERE id = ?', [uid]))?.full_name ?? null;
}

// ================================================================== approvals log, follow-ups
export async function logDecision(tx: Tx, cid: number, billId: number, uid: number | null, stage: string, decision: string, from: string | null, to: string | null,
  comments: string | null, amount: number | null) {
  await txExecute(tx, `INSERT INTO trx_bill_approval (company_id, bill_id, stage, decision, from_status, to_status, comments, amount, actor_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    [cid, billId, stage, decision, from, to, comments ? comments.slice(0, 500) : null, amount, uid]);
}

/** Opens a follow-up of this type for the bill unless one is already open (automatic exceptions). */
export async function ensureFollowup(tx: Tx, cid: number, billId: number, type: string, ownerId: number | null, reason: string, uid: number | null, priority = 'NORMAL') {
  const open = await txQueryOne<any>(tx, `SELECT id FROM trx_bill_followup WHERE bill_id = ? AND issue_type = ? AND status = 'OPEN'`, [billId, type]);
  if (open) return open.id as number;
  const r = await txExecute(tx, `INSERT INTO trx_bill_followup (company_id, bill_id, issue_type, priority, owner_id, due_date, reason, next_followup_date, created_by)
                                 VALUES (?,?,?,?,?,?,?,?,?)`, [cid, billId, type, priority, ownerId, addDays(istToday(), 2), reason.slice(0, 500), addDays(istToday(), 1), uid]);
  return r.insertId as number;
}
export async function autoClose(tx: Tx, billId: number, type: string, note: string, uid: number | null) {
  await txExecute(tx, `UPDATE trx_bill_followup SET status = 'CLOSED', resolution_note = ?, closed_by = ?, closed_at = NOW(), row_version = row_version + 1
                        WHERE bill_id = ? AND issue_type = ? AND status = 'OPEN' AND created_by IS NOT NULL AND reason LIKE 'Auto:%'`, [note, uid, billId, type]);
}

// ================================================================== posting adapter
export interface PostingResult { outcome: 'POSTED' | 'FAILED' | 'UNKNOWN' | 'MANUAL'; voucherId?: string; voucherNo?: string; code?: string; summary?: string; transient?: boolean }
/**
 * Accounting connector. Only MANUAL exists: the target accounting package, its API, authentication and voucher format are not
 * confirmed (spec §12 / §21) — accounts posts the voucher there and records the voucher no here. A vendor adapter implements
 * submit() and lookup() (query by idempotency key before any resubmission, so a timeout can never create a second voucher).
 */
export interface PostingAdapter {
  code: string;
  automatic: boolean;
  submit(payload: unknown, idempotencyKey: string): Promise<PostingResult>;
  lookup(idempotencyKey: string): Promise<PostingResult | null>;
}
export const MANUAL_ADAPTER: PostingAdapter = {
  code: 'MANUAL', automatic: false,
  async submit() { return { outcome: 'MANUAL', summary: 'Waiting for accounts to post the voucher and enter its number' }; },
  async lookup() { return null; },
};
export const ADAPTERS: Record<string, PostingAdapter> = { MANUAL: MANUAL_ADAPTER };
export async function adapterFor(cid: number) {
  const s = await queryOne<any>(`SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'BT_POSTING_ADAPTER'`, [cid]);
  return ADAPTERS[String(s?.v ?? 'MANUAL').toUpperCase()] ?? MANUAL_ADAPTER;
}
export async function settingOn(cid: number, key: string, dflt = true) {
  const s = await queryOne<any>('SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?', [cid, key]);
  if (!s || s.v === null || s.v === undefined || s.v === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(s.v).trim().toLowerCase());
}

// ================================================================== private file storage
const ALLOWED: Record<string, string[]> = {
  '.pdf': ['application/pdf'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'], '.webp': ['image/webp'], '.gif': ['image/gif'],
  '.tif': ['image/tiff'], '.tiff': ['image/tiff'], '.heic': ['image/heic'], '.eml': ['message/rfc822'], '.msg': ['application/vnd.ms-outlook'],
  '.txt': ['text/plain'], '.csv': ['text/csv'], '.xls': ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  '.pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8, '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.xlsx': (b) => b[0] === 0x50 && b[1] === 0x4b, '.docx': (b) => b[0] === 0x50 && b[1] === 0x4b,
};
export const MAX_FILE = 10 * 1024 * 1024;
export const filesRoot = () => path.resolve(process.cwd(), 'uploads', 'bill-docs');

/** Validates a base64 / data-URI upload; returns the bytes, mime type, sha256. */
export function parseUpload(filename: string, data: string) {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED[ext]) throw BadRequest(`File type ${ext || '(none)'} is not allowed. Allowed: PDF, JPG, PNG, WEBP, GIF, TIFF, HEIC, EML, MSG, TXT, CSV, XLS(X), DOC(X)`);
  const m = data.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s);
  const declared = m?.[1]?.toLowerCase();
  const buf = Buffer.from(m ? m[2] : data, 'base64');
  if (!buf.length) throw BadRequest('The file is empty');
  if (buf.length > MAX_FILE) throw BadRequest('File is larger than 10 MB');
  if (MAGIC[ext] && !MAGIC[ext](buf)) throw BadRequest(`The file content is not a real ${ext.slice(1).toUpperCase()} file`);
  if (declared && declared !== 'application/octet-stream' && !ALLOWED[ext].includes(declared) && !(ext === '.csv' && declared.startsWith('text/')))
    throw BadRequest(`File type (${declared}) does not match its extension ${ext}`);
  return { buf, ext, mime: ALLOWED[ext][0], sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** Stores the file under a random name; returns the attachment id and an earlier upload of the same file (if any). */
export async function storeAttachment(tx: Tx, cid: number, uid: number | null, target: { inward_id?: number | null; bill_id?: number | null }, filename: string, data: string) {
  const f = parseUpload(filename, data);
  const sameHere = await txQueryOne<any>(tx,
    `SELECT id FROM trx_bill_doc_attachment WHERE company_id = ? AND sha256 = ? AND is_removed = 0 AND ((? IS NOT NULL AND inward_id = ?) OR (? IS NOT NULL AND bill_id = ?))`,
    [cid, f.sha256, target.inward_id ?? null, target.inward_id ?? 0, target.bill_id ?? null, target.bill_id ?? 0]);
  if (sameHere) throw Conflict('This file is already attached here');
  const dup = await txQueryOne<any>(tx,
    `SELECT a.id, a.original_name, a.inward_id, a.bill_id, d.inward_no, b.entry_no FROM trx_bill_doc_attachment a
       LEFT JOIN trx_document_inward d ON d.id = a.inward_id LEFT JOIN trx_bill_tracker b ON b.id = a.bill_id
      WHERE a.company_id = ? AND a.sha256 = ? AND a.is_removed = 0 ORDER BY a.id LIMIT 1`, [cid, f.sha256]);
  const key = `bill-docs/${cid}/${crypto.randomBytes(16).toString('hex')}`;
  const dir = path.join(filesRoot(), String(cid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(filesRoot(), '..', key), f.buf, { mode: 0o640 });
  const safeName = path.basename(filename).replace(/[\u0000-\u001f"\\/<>:|?*]/g, '_').slice(0, 200) || `file${f.ext}`;
  const r = await txExecute(tx,
    `INSERT INTO trx_bill_doc_attachment (company_id, inward_id, bill_id, storage_key, original_name, mime_type, byte_size, sha256, duplicate_of_id, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [cid, target.inward_id ?? null, target.bill_id ?? null, key, safeName, f.mime, f.buf.length, f.sha256, dup?.id ?? null, uid]);
  return { id: r.insertId as number, sha256: f.sha256, duplicate: dup ? { id: dup.id, where: dup.inward_no ?? dup.entry_no, name: dup.original_name } : null };
}

export function attachmentPath(storageKey: string) {
  const p = path.resolve(filesRoot(), '..', storageKey);
  if (!p.startsWith(filesRoot() + path.sep)) throw NotFound('File not found');
  return p;
}
