import { Router, type Request } from 'express';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { r2, fyCodeOf } from './voucherEngine.js';

/**
 * Books reports (spec §13) from acc_voucher / acc_voucher_entry. Posted = status POSTED or REVERSED (a reversed voucher
 * and its reversal both stay in the books and cancel each other, like Tally).
 *
 * Stock (P&L / balance sheet): ERP owns valuation (spec §5.2) — opening / closing stock come from the ERP stock ledger
 * (qty × rate) when ACC_STOCK_FROM_ERP = 1; the Opening Stock ledger's opening balance is the books-beginning stock.
 * The order-wise profit report already built (Reports → Budget vs Actuals) stays the management P&L per IO; the
 * "Job-wise books" report here shows what the BOOKS carry per IO, with a link to it.
 */
export const accountsReportsRouter = Router();
const VIEW = requireAny('ACCOUNTS.VIEW', 'ACCOUNTS.ENTRY', 'ACCOUNTS.APPROVE', 'ACCOUNTS.ADMIN');
const POSTED = `v.status IN ('POSTED','REVERSED')`;
const cidOf = (req: Request) => req.user!.companyId;
const D = /^\d{4}-\d{2}-\d{2}$/;

function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
function dayBefore(d: string) { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10); }

async function period(req: Request) {
  const cid = cidOf(req);
  let to = String(req.query.to ?? '') || today();
  let from = String(req.query.from ?? '');
  if (!from) {
    const fy = await queryOne<any>(`SELECT DATE_FORMAT(start_date,'%Y-%m-%d') s FROM mst_financial_year WHERE company_id = ? AND ? BETWEEN start_date AND end_date LIMIT 1`, [cid, to]);
    from = fy?.s ?? `${fyCodeOf(to).slice(0, 4)}-04-01`;
  }
  if (!D.test(from) || !D.test(to)) throw BadRequest('Enter dates as YYYY-MM-DD');
  if (from > to) [from, to] = [to, from];
  return { cid, from, to };
}

/** Signed (Dr +) balance of every ledger: opening as at `from` (ledger opening + movements before), Dr / Cr in the period. */
async function ledgerBalances(cid: number, from: string, to: string) {
  return query<any>(`SELECT l.id, l.ledger_code, l.ledger_name, l.ledger_type, l.group_id, l.party_id, g.group_name, g.nature, g.affects_gross_profit, g.group_code,
        ROUND(IF(l.opening_dr_cr = 'DR', l.opening_balance, -l.opening_balance) + COALESCE(b.before_amt, 0), 2) opening,
        ROUND(COALESCE(b.dr, 0), 2) dr, ROUND(COALESCE(b.cr, 0), 2) cr
      FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id
      LEFT JOIN (SELECT e.ledger_id,
                        SUM(IF(v.voucher_date < ?, e.debit - e.credit, 0)) before_amt,
                        SUM(IF(v.voucher_date >= ? AND v.voucher_date <= ?, e.debit, 0)) dr,
                        SUM(IF(v.voucher_date >= ? AND v.voucher_date <= ?, e.credit, 0)) cr
                   FROM acc_voucher_entry e JOIN acc_voucher v ON v.id = e.voucher_id
                  WHERE v.company_id = ? AND ${POSTED} AND v.voucher_date <= ? GROUP BY e.ledger_id) b ON b.ledger_id = l.id
     WHERE l.company_id = ?`, [from, from, to, from, to, cid, to, cid]);
}

async function groups(cid: number) {
  return query<any>(`SELECT id, group_code, group_name, parent_id, nature, affects_gross_profit, sort_order FROM acc_account_group WHERE company_id = ? ORDER BY sort_order, group_name`, [cid]);
}

/** ERP stock value as at the END of a date (stock ledger qty × rate), by material. */
async function erpStock(cid: number, asOf: string) {
  const rows = await query<any>(`SELECT l.material_type, ROUND(SUM((l.qty_in - l.qty_out) * l.rate), 2) value
      FROM trx_stock_ledger l WHERE l.company_id = ? AND l.txn_date < DATE_ADD(?, INTERVAL 1 DAY) GROUP BY l.material_type`, [cid, asOf]);
  const items = rows.map((r) => ({ material: r.material_type as string, value: Math.max(0, Number(r.value) || 0) }));
  return { total: r2(items.reduce((t, i) => t + i.value, 0)), items };
}
async function stockFromErp(cid: number) {
  const s = await queryOne<any>(`SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'ACC_STOCK_FROM_ERP'`, [cid]);
  return String(s?.v ?? '0') === '1';
}

// ---------------------------------------------------------------- trial balance
accountsReportsRouter.get('/trial-balance', VIEW, ah(async (req, res) => {
  const { cid, from, to } = await period(req);
  const rows = (await ledgerBalances(cid, from, to)).map((l) => ({ ...l, opening: Number(l.opening), dr: Number(l.dr), cr: Number(l.cr), closing: r2(Number(l.opening) + Number(l.dr) - Number(l.cr)) }))
    .filter((l) => l.opening || l.dr || l.cr || req.query.all === '1');
  const tot = rows.reduce((t, l) => ({ opening: r2(t.opening + l.opening), dr: r2(t.dr + l.dr), cr: r2(t.cr + l.cr), closing: r2(t.closing + l.closing) }), { opening: 0, dr: 0, cr: 0, closing: 0 });
  res.json({ data: { from, to, ledgers: rows, groups: await groups(cid), totals: tot,
    difference_in_opening: tot.opening, balanced: Math.abs(tot.dr - tot.cr) < 0.01 && Math.abs(tot.closing - tot.opening) < 0.01 } });
}));

// ---------------------------------------------------------------- ledger (GL / cash book / bank book)
accountsReportsRouter.get('/ledger', VIEW, ah(async (req, res) => {
  const { cid, from, to } = await period(req);
  const id = Number(req.query.ledger_id);
  if (!id) throw BadRequest('Pick a ledger');
  const l = await queryOne<any>(`SELECT l.*, g.group_name, g.nature FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id WHERE l.id = ? AND l.company_id = ?`, [id, cid]);
  if (!l) throw NotFound('Ledger not found');
  const op = await queryOne<any>(`SELECT ROUND(COALESCE(SUM(e.debit - e.credit), 0), 2) a FROM acc_voucher_entry e JOIN acc_voucher v ON v.id = e.voucher_id
      WHERE e.ledger_id = ? AND ${POSTED} AND v.voucher_date < ?`, [id, from]);
  const opening = r2((l.opening_dr_cr === 'DR' ? 1 : -1) * Number(l.opening_balance) + Number(op?.a ?? 0));
  const lines = await query<any>(`SELECT e.id, e.voucher_id, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') voucher_date, v.voucher_no, v.type_code, v.ref_no, v.narration,
        e.debit, e.credit, e.narration line_narration, e.bill_ref_type, e.bill_ref_no, v.source_module, v.source_no, so.io_no,
        (SELECT GROUP_CONCAT(DISTINCT ol.ledger_name ORDER BY oe.line_no SEPARATOR ', ') FROM acc_voucher_entry oe JOIN acc_ledger ol ON ol.id = oe.ledger_id
          WHERE oe.voucher_id = v.id AND oe.ledger_id <> e.ledger_id AND (oe.debit > 0) <> (e.debit > 0)) against
       FROM acc_voucher_entry e JOIN acc_voucher v ON v.id = e.voucher_id LEFT JOIN trx_sales_order so ON so.id = e.so_id
      WHERE e.ledger_id = ? AND ${POSTED} AND v.voucher_date BETWEEN ? AND ? ORDER BY v.voucher_date, v.id, e.line_no`, [id, from, to]);
  let bal = opening;
  const rows = lines.map((x) => { bal = r2(bal + Number(x.debit) - Number(x.credit)); return { ...x, debit: Number(x.debit), credit: Number(x.credit), balance: bal }; });
  const dr = r2(rows.reduce((t, x) => t + x.debit, 0)); const cr = r2(rows.reduce((t, x) => t + x.credit, 0));
  res.json({ data: { ledger: l, from, to, opening, rows, total_debit: dr, total_credit: cr, closing: r2(opening + dr - cr) } });
}));

// ---------------------------------------------------------------- day book
accountsReportsRouter.get('/day-book', VIEW, ah(async (req, res) => {
  const { cid, from, to } = await period(req);
  const type = String(req.query.type ?? '');
  const vs = await query<any>(`SELECT v.id, v.voucher_no, v.type_code, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') voucher_date, v.ref_no, v.narration, v.total_debit,
        v.status, v.source_module, v.source_no, pl.ledger_name party_name
       FROM acc_voucher v LEFT JOIN acc_ledger pl ON pl.id = v.party_ledger_id
      WHERE v.company_id = ? AND ${POSTED} AND v.voucher_date BETWEEN ? AND ? ${type ? 'AND v.type_code = ?' : ''}
      ORDER BY v.voucher_date, v.id LIMIT 5000`, type ? [cid, from, to, type] : [cid, from, to]);
  const es = vs.length ? await query<any>(`SELECT e.voucher_id, e.debit, e.credit, l.ledger_name FROM acc_voucher_entry e JOIN acc_ledger l ON l.id = e.ledger_id
      WHERE e.voucher_id IN (?) ORDER BY e.voucher_id, e.line_no`, [vs.map((v) => v.id)]) : [];
  res.json({ data: { from, to, vouchers: vs.map((v) => ({ ...v, entries: es.filter((e) => e.voucher_id === v.id) })) } });
}));

// ---------------------------------------------------------------- P&L (Tally layout: trading account → gross profit → net profit)
async function profitLoss(cid: number, from: string, to: string) {
  const bal = await ledgerBalances(cid, from, to);
  const gs = await groups(cid);
  const gById = new Map(gs.map((g) => [Number(g.id), g]));
  const primary = (gid: number) => { let g = gById.get(gid); while (g?.parent_id && gById.get(Number(g.parent_id))) g = gById.get(Number(g.parent_id)); return g; };
  const heads = new Map<string, { group_code: string; group_name: string; nature: string; trading: boolean; amount: number; ledgers: any[] }>();
  for (const l of bal) {
    if (l.nature !== 'INCOME' && l.nature !== 'EXPENSE') continue;
    const mv = r2(Number(l.dr) - Number(l.cr));     // P&L uses the period movement only
    if (!mv) continue;
    const p = primary(Number(l.group_id))!;
    const h = heads.get(p.group_code) ?? { group_code: p.group_code, group_name: p.group_name, nature: p.nature, trading: !!Number(p.affects_gross_profit), amount: 0, ledgers: [] as any[] };
    const amt = l.nature === 'INCOME' ? -mv : mv;   // income shown positive on the credit side
    h.amount = r2(h.amount + amt);
    h.ledgers.push({ id: l.id, ledger_name: l.ledger_name, group_name: l.group_name, amount: amt });
    heads.set(p.group_code, h);
  }
  const fromErp = await stockFromErp(cid);
  // stock off: Stock-in-Hand ledgers stay balance-sheet assets and stock does not enter the P&L
  const openStock = fromErp ? await erpStock(cid, dayBefore(from)) : { total: 0, items: [] };
  const closeStock = fromErp ? await erpStock(cid, to) : { total: 0, items: [] };
  const list = [...heads.values()];
  const tradingDr = list.filter((h) => h.trading && h.nature === 'EXPENSE');
  const tradingCr = list.filter((h) => h.trading && h.nature === 'INCOME');
  const plDr = list.filter((h) => !h.trading && h.nature === 'EXPENSE');
  const plCr = list.filter((h) => !h.trading && h.nature === 'INCOME');
  const sum = (a: { amount: number }[]) => r2(a.reduce((t, h) => t + h.amount, 0));
  const gross = r2(sum(tradingCr) + closeStock.total - openStock.total - sum(tradingDr));
  const net = r2(gross + sum(plCr) - sum(plDr));
  return { from, to, stock_source: fromErp ? 'ERP stock ledger (qty × rate)' : 'not included (Accounts Settings → Books options)', opening_stock: openStock, closing_stock: closeStock,
    trading: { debit: tradingDr, credit: tradingCr }, gross_profit: gross, pl: { debit: plDr, credit: plCr }, net_profit: net };
}

accountsReportsRouter.get('/profit-loss', VIEW, ah(async (req, res) => {
  const { cid, from, to } = await period(req);
  res.json({ data: await profitLoss(cid, from, to) });
}));

// ---------------------------------------------------------------- balance sheet
accountsReportsRouter.get('/balance-sheet', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const asOf = String(req.query.to ?? req.query.as_of ?? '') || today();
  if (!D.test(asOf)) throw BadRequest('Enter the date as YYYY-MM-DD');
  const bal = await ledgerBalances(cid, '1900-01-01', asOf);
  const gs = await groups(cid);
  const gById = new Map(gs.map((g) => [Number(g.id), g]));
  const primary = (gid: number) => { let g = gById.get(gid); while (g?.parent_id && gById.get(Number(g.parent_id))) g = gById.get(Number(g.parent_id)); return g; };
  const fromErp = await stockFromErp(cid);
  const closeStock = fromErp ? await erpStock(cid, asOf) : { total: 0, items: [] };
  const heads = new Map<string, { group_code: string; group_name: string; side: 'L' | 'A'; amount: number; ledgers: any[] }>();
  let plCum = 0; let diffOpening = 0;
  for (const l of bal) {
    const closing = r2(Number(l.opening) + Number(l.dr) - Number(l.cr));   // Dr +
    diffOpening = r2(diffOpening + Number(l.opening));
    if (l.nature === 'INCOME' || l.nature === 'EXPENSE') { plCum = r2(plCum - closing); continue; }
    if (fromErp && l.group_code === 'STOCK_IN_HAND') {
      plCum = r2(plCum - closing);   // books opening stock is consumed into P&L; closing stock replaces it below
      continue;
    }
    if (!closing) continue;
    const p = primary(Number(l.group_id))!;
    // a ledger sits on the side its balance points to (e.g. a supplier with a debit balance shows under assets)
    const side: 'L' | 'A' = p.nature === 'LIABILITY' ? 'L' : 'A';
    const key = `${p.group_code}`;
    const h = heads.get(key) ?? { group_code: p.group_code, group_name: p.group_name, side, amount: 0, ledgers: [] as any[] };
    const amt = side === 'L' ? -closing : closing;
    h.amount = r2(h.amount + amt);
    h.ledgers.push({ id: l.id, ledger_name: l.ledger_name, group_name: l.group_name, amount: amt });
    heads.set(key, h);
  }
  plCum = r2(plCum + closeStock.total);
  const liabilities = [...heads.values()].filter((h) => h.side === 'L');
  const assets = [...heads.values()].filter((h) => h.side === 'A');
  const totL = r2(liabilities.reduce((t, h) => t + h.amount, 0) + plCum);
  const totA = r2(assets.reduce((t, h) => t + h.amount, 0) + closeStock.total);
  res.json({ data: { as_of: asOf, liabilities, assets, profit_loss: plCum, closing_stock: closeStock, stock_source: fromErp ? 'ERP stock ledger (qty × rate)' : 'not included (Accounts Settings → Books options)',
    total_liabilities: totL, total_assets: totA, difference: r2(totA - totL), difference_in_opening: diffOpening } });
}));

// ---------------------------------------------------------------- bill-wise outstanding + ageing
accountsReportsRouter.get('/outstanding', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const kind = String(req.query.kind ?? 'payables') === 'receivables' ? 'receivables' : 'payables';
  const asOf = String(req.query.to ?? '') || today();
  if (!D.test(asOf)) throw BadRequest('Enter the date as YYYY-MM-DD');
  const grp = kind === 'payables' ? 'SUNDRY_CREDITORS' : 'SUNDRY_DEBTORS';
  const rows = await query<any>(`SELECT l.id ledger_id, l.ledger_name, e.bill_ref_no, e.bill_ref_type,
        MIN(IF(e.bill_ref_type = 'NEW', v.voucher_date, NULL)) bill_date, MAX(IF(e.bill_ref_type = 'NEW', e.bill_due_date, NULL)) due_date,
        MIN(v.voucher_date) first_date, ROUND(SUM(e.debit - e.credit), 2) amount, ROUND(SUM(COALESCE(e.fc_amount,0) * IF(e.debit > 0, 1, -1)), 2) fc
       FROM acc_voucher_entry e JOIN acc_voucher v ON v.id = e.voucher_id JOIN acc_ledger l ON l.id = e.ledger_id
       JOIN acc_account_group g ON g.id = l.group_id
      WHERE v.company_id = ? AND ${POSTED} AND v.voucher_date <= ? AND (g.group_code = ? OR l.party_id IS NOT NULL)
      GROUP BY l.id, l.ledger_name, e.bill_ref_no, e.bill_ref_type
      HAVING ABS(amount) >= 0.01`, [cid, asOf, grp]);
  // merge NEW + AGAINST of the same bill
  const bills = new Map<string, any>();
  for (const r of rows) {
    // NEW / AGAINST / ADVANCE with the same reference are one bill (an advance is knocked off "against" its reference)
    const refd = !!r.bill_ref_no && r.bill_ref_type !== 'ON_ACCOUNT';
    const key = refd ? `${r.ledger_id}|B|${r.bill_ref_no}` : `${r.ledger_id}|ON_ACCOUNT`;
    const b = bills.get(key) ?? { ledger_id: r.ledger_id, ledger_name: r.ledger_name, bill_ref_no: refd ? r.bill_ref_no : 'On account', kind: refd ? 'BILL' : 'ON_ACCOUNT', bill_date: null, due_date: null, amount: 0, fc: 0 };
    if (r.bill_ref_type === 'ADVANCE') b.kind = 'ADVANCE';
    b.amount = r2(b.amount + Number(r.amount)); b.fc = r2(b.fc + Number(r.fc));
    if (r.bill_date) b.bill_date = String(r.bill_date).slice(0, 10);
    if (r.due_date) b.due_date = String(r.due_date).slice(0, 10);
    if (!b.bill_date) b.bill_date = String(r.first_date).slice(0, 10);
    bills.set(key, b);
  }
  // opening balances of party ledgers = on account
  const ops = await query<any>(`SELECT l.id, l.ledger_name, IF(l.opening_dr_cr = 'DR', l.opening_balance, -l.opening_balance) amt, DATE_FORMAT(l.opening_date,'%Y-%m-%d') d
      FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id WHERE l.company_id = ? AND l.opening_balance <> 0 AND (g.group_code = ? OR l.party_id IS NOT NULL)`, [cid, grp]);
  for (const o of ops) bills.set(`${o.id}|OPENING`, { ledger_id: o.id, ledger_name: o.ledger_name, bill_ref_no: 'Opening balance', kind: 'OPENING', bill_date: o.d, due_date: null, amount: r2(o.amt), fc: 0 });
  const sign = kind === 'payables' ? -1 : 1;   // payables shown positive when we owe (credit)
  const asOfT = new Date(`${asOf}T00:00:00Z`).getTime();
  const out = [...bills.values()].filter((b) => Math.abs(b.amount) >= 0.01).map((b) => {
    const days = b.bill_date ? Math.floor((asOfT - new Date(`${b.bill_date}T00:00:00Z`).getTime()) / 86400000) : 0;
    const overdue = b.due_date ? Math.floor((asOfT - new Date(`${b.due_date}T00:00:00Z`).getTime()) / 86400000) : null;
    return { ...b, pending: r2(b.amount * sign), age_days: days, overdue_days: overdue != null && overdue > 0 ? overdue : 0,
      bucket: days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : days <= 180 ? '91-180' : '180+' };
  });
  // party filter: only parties of the right side (a buyer ledger never shows in payables unless it has a credit bill)
  const parties = new Map<number, { ledger_id: number; ledger_name: string; pending: number; buckets: Record<string, number> }>();
  for (const b of out) {
    const p = parties.get(b.ledger_id) ?? { ledger_id: b.ledger_id, ledger_name: b.ledger_name, pending: 0, buckets: {} as Record<string, number> };
    p.pending = r2(p.pending + b.pending);
    p.buckets[b.bucket] = r2((p.buckets[b.bucket] ?? 0) + b.pending);
    parties.set(b.ledger_id, p);
  }
  const partyRows = [...parties.values()].filter((p) => Math.abs(p.pending) >= 0.01).sort((a, b) => b.pending - a.pending);
  const keep = new Set(partyRows.map((p) => p.ledger_id));
  res.json({ data: { kind, as_of: asOf, parties: partyRows, bills: out.filter((b) => keep.has(b.ledger_id)).sort((a, b) => a.ledger_name.localeCompare(b.ledger_name) || String(a.bill_date).localeCompare(String(b.bill_date))),
    total: r2(partyRows.reduce((t, p) => t + p.pending, 0)) } });
}));

// ---------------------------------------------------------------- job-wise books
accountsReportsRouter.get('/job-books', VIEW, ah(async (req, res) => {
  const { cid, from, to } = await period(req);
  const rows = await query<any>(`SELECT e.so_id, so.io_no, so.so_no, bp.party_name buyer_name,
        ROUND(SUM(IF(g.nature = 'INCOME', e.credit - e.debit, 0)), 2) income,
        ROUND(SUM(IF(COALESCE(pg.group_code, g.group_code) = 'PURCHASE', e.debit - e.credit, 0)), 2) purchases,
        ROUND(SUM(IF(g.nature = 'EXPENSE' AND COALESCE(pg.group_code, g.group_code) <> 'PURCHASE', e.debit - e.credit, 0)), 2) job_work,
        COUNT(DISTINCT v.id) vouchers
       FROM acc_voucher_entry e JOIN acc_voucher v ON v.id = e.voucher_id JOIN acc_ledger l ON l.id = e.ledger_id
       JOIN acc_account_group g ON g.id = l.group_id LEFT JOIN acc_account_group pg ON pg.id = g.parent_id
       LEFT JOIN trx_sales_order so ON so.id = e.so_id LEFT JOIN mst_party bp ON bp.id = so.buyer_id
      WHERE v.company_id = ? AND ${POSTED} AND v.voucher_date BETWEEN ? AND ? AND g.nature IN ('INCOME','EXPENSE')
      GROUP BY e.so_id, so.io_no, so.so_no, bp.party_name ORDER BY e.so_id IS NULL, so.io_no`, [cid, from, to]);
  res.json({ data: { from, to, rows: rows.map((r) => ({ ...r, income: Number(r.income), purchases: Number(r.purchases), job_work: Number(r.job_work),
    margin: r2(Number(r.income) - Number(r.purchases) - Number(r.job_work)) })) } });
}));
