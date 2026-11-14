import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, execute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { sealSecret } from '../../core/secretBox.js';
import {
  createVoucher, updateDraft, postVoucher, cancelVoucher, reverseVoucher, lockVoucher, partyLedger, r2,
  VOUCHER_TYPES, type VoucherInput, type Actor,
} from './voucherEngine.js';
import { ensureAccountsSetup, POSTING_ROLES, POSTING_EVENTS } from './accountsSetup.js';
import { SOURCES, sourceByEvent, scanCompany, pendingDocuments, staleVouchers, voucherFromSource } from './sources.js';
import { enqueueTally, enqueueBacklog, exportXml, healthCheck, submitQueueRow, scheduleBillSync } from './tally.js';
import { tallyLedgersRouter } from './tallyLedgers.js';
import { openingRouter } from './opening.js';

/**
 * Accounts module (client spec "Complete Accounts & TallyPrime", voice note 09-Nov-2026). Mounted at /api/accounts.
 * Books live in acc_* tables; every write goes through voucherEngine.ts. See sources.ts for the ERP → voucher rules
 * and tally.ts for the Tally mirror.
 */
export const accountsRouter = Router();

export const P = {
  VIEW: 'ACCOUNTS.VIEW', ENTRY: 'ACCOUNTS.ENTRY', APPROVE: 'ACCOUNTS.APPROVE', ADMIN: 'ACCOUNTS.ADMIN', TALLY: 'ACCOUNTS.TALLY',
} as const;
const VIEW = requireAny(P.VIEW, P.ENTRY, P.APPROVE, P.ADMIN);
const ENTRY = requirePermission(P.ENTRY);
const APPROVE = requirePermission(P.APPROVE);
const ADMIN = requirePermission(P.ADMIN);
const TALLY = requireAny(P.TALLY, P.ADMIN);

const cidOf = (req: Request) => req.user!.companyId;
const actor = (req: Request): Actor => ({ companyId: req.user!.companyId, userId: req.user!.id });
const idParam = (req: Request, k = 'id') => { const v = Number(req.params[k]); if (!Number.isInteger(v) || v <= 0) throw NotFound(); return v; };
const has = (req: Request, code: string) => !!req.user && (req.user.isSuperAdmin || req.user.permissions.has(code));
const date = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date (YYYY-MM-DD)');
const optDate = z.union([date, z.literal(''), z.null()]).optional().transform((v) => v || null);
const money = z.coerce.number().finite();
const reasonOf = (b: any, min = 5) => {
  const r = String(b?.reason ?? '').trim();
  if (r.length < min) throw BadRequest(`Enter the reason (at least ${min} characters)`);
  return r.slice(0, 500);
};
const parse = <T extends z.ZodTypeAny>(s: T, body: unknown): z.infer<T> => {
  const p = s.safeParse(body ?? {});
  if (!p.success) throw BadRequest(p.error.issues[0]?.message || 'Invalid input', p.error.issues);
  return p.data;
};

accountsRouter.use(ah(async (req, _res, next) => { await ensureAccountsSetup(cidOf(req)); next(); }));
accountsRouter.use(tallyLedgersRouter);   // /tally/companies/:id/ledgers*, /tally/ledger-map/:id
accountsRouter.use(openingRouter);        // /opening*

// ================================================================ dashboard
accountsRouter.get('/dashboard', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const s = await queryOne<any>(`SELECT
      SUM(status = 'PENDING_APPROVAL') pending, SUM(status = 'DRAFT') drafts, SUM(status = 'REJECTED') rejected,
      SUM(status = 'POSTED') posted, SUM(status = 'POSTED' AND tally_status IN ('PENDING','PROCESSING')) tally_pending,
      SUM(status = 'POSTED' AND tally_status = 'FAILED') tally_failed, SUM(status = 'POSTED' AND tally_status = 'UNKNOWN') tally_unknown
    FROM acc_voucher WHERE company_id = ?`, [cid]);
  const issues = await queryOne<any>(`SELECT COUNT(*) n FROM acc_posting_issue WHERE company_id = ?`, [cid]);
  const month = await query<any>(`SELECT v.type_code, COUNT(*) n, ROUND(SUM(v.total_debit), 2) amount FROM acc_voucher v
      WHERE v.company_id = ? AND v.status = 'POSTED' AND v.voucher_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01') GROUP BY v.type_code`, [cid]);
  const lock = await queryOne<any>(`SELECT DATE_FORMAT(locked_upto,'%Y-%m-%d') d FROM acc_period_lock WHERE company_id = ?`, [cid]);
  const fy = await queryOne<any>(`SELECT fy_code, DATE_FORMAT(start_date,'%Y-%m-%d') s, DATE_FORMAT(end_date,'%Y-%m-%d') e FROM mst_financial_year WHERE company_id = ? AND is_current = 1 LIMIT 1`, [cid]);
  const tally = await query<any>(`SELECT id, tally_company_name, connector, is_active, last_health_ok, last_health_msg FROM acc_tally_company WHERE company_id = ?`, [cid]);
  const rules = await query<any>(`SELECT mode, COUNT(*) n FROM acc_posting_rule WHERE company_id = ? GROUP BY mode`, [cid]);
  res.json({ data: {
    vouchers: Object.fromEntries(Object.entries(s ?? {}).map(([k, v]) => [k, Number(v ?? 0)])),
    issues: Number(issues?.n ?? 0), month, locked_upto: lock?.d ?? null, fy, tally, rules,
  } });
}));

// ================================================================ groups
accountsRouter.get('/groups', VIEW, ah(async (req, res) => {
  const rows = await query<any>(`SELECT g.*, p.group_name parent_name,
      (SELECT COUNT(*) FROM acc_ledger l WHERE l.group_id = g.id) ledgers,
      (SELECT COUNT(*) FROM acc_account_group c WHERE c.parent_id = g.id) children
     FROM acc_account_group g LEFT JOIN acc_account_group p ON p.id = g.parent_id
    WHERE g.company_id = ? ORDER BY g.sort_order, g.group_name`, [cidOf(req)]);
  res.json({ data: rows });
}));

const groupSchema = z.object({
  group_name: z.string().trim().min(2, 'Enter the group name').max(100),
  group_code: z.string().trim().max(30).optional().nullable(),
  parent_id: z.coerce.number().int().positive({ message: 'Pick the parent group' }),
  tally_name: z.string().trim().max(100).optional().nullable(),
  is_active: z.coerce.boolean().optional(),
});
accountsRouter.post('/groups', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(groupSchema, req.body);
  const parent = await queryOne<any>(`SELECT * FROM acc_account_group WHERE id = ? AND company_id = ?`, [b.parent_id, cid]);
  if (!parent) throw BadRequest('Pick a parent group of this company');
  const code = (b.group_code || b.group_name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 30);
  const r: any = await execute(`INSERT INTO acc_account_group (company_id, group_code, group_name, parent_id, nature, affects_gross_profit, sort_order, tally_name, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`, [cid, code, b.group_name, parent.id, parent.nature, parent.affects_gross_profit, Number(parent.sort_order) + 1, b.tally_name || null, req.user!.id]);
  await audit(req, 'acc_account_group', r.insertId, 'INSERT', undefined, b);
  res.status(201).json({ data: { id: r.insertId }, message: `Group ${b.group_name} created under ${parent.group_name}` });
}));
accountsRouter.put('/groups/:id', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const g = await queryOne<any>(`SELECT * FROM acc_account_group WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!g) throw NotFound('Group not found');
  const b = parse(groupSchema.partial(), req.body);
  if (Number(g.is_system)) {
    // Tally predefined group: only the Tally name can change (structure and nature stay)
    await execute(`UPDATE acc_account_group SET tally_name = ? WHERE id = ?`, [b.tally_name || null, id]);
  } else {
    let parent = g.parent_id;
    let nature = g.nature; let gp = g.affects_gross_profit;
    if (b.parent_id && b.parent_id !== Number(g.parent_id)) {
      const p = await queryOne<any>(`SELECT * FROM acc_account_group WHERE id = ? AND company_id = ?`, [b.parent_id, cid]);
      if (!p) throw BadRequest('Pick a parent group of this company');
      // no cycles
      let cur: any = p;
      while (cur) { if (Number(cur.id) === id) throw BadRequest('A group cannot be placed under itself'); cur = cur.parent_id ? await queryOne<any>(`SELECT id, parent_id FROM acc_account_group WHERE id = ?`, [cur.parent_id]) : null; }
      parent = p.id; nature = p.nature; gp = p.affects_gross_profit;
    }
    if (b.is_active === false) {
      const used = await queryOne<any>(`SELECT (SELECT COUNT(*) FROM acc_ledger WHERE group_id = ? AND is_active = 1) + (SELECT COUNT(*) FROM acc_account_group WHERE parent_id = ? AND is_active = 1) n`, [id, id]);
      if (Number(used?.n)) throw Conflict('Group has active ledgers or sub-groups — move or deactivate them first');
    }
    await execute(`UPDATE acc_account_group SET group_name = COALESCE(?, group_name), parent_id = ?, nature = ?, affects_gross_profit = ?, tally_name = ?, is_active = COALESCE(?, is_active) WHERE id = ?`,
      [b.group_name ?? null, parent, nature, gp, b.tally_name === undefined ? g.tally_name : (b.tally_name || null), b.is_active === undefined ? null : (b.is_active ? 1 : 0), id]);
  }
  await audit(req, 'acc_account_group', id, 'UPDATE', g, b);
  res.json({ data: { id }, message: 'Group saved' });
}));

// ================================================================ ledgers
const BAL_SQL = `ROUND(IF(l.opening_dr_cr = 'DR', l.opening_balance, -l.opening_balance)
      + COALESCE((SELECT SUM(e.debit - e.credit) FROM acc_voucher_entry e JOIN acc_voucher v ON v.id = e.voucher_id
                   WHERE e.ledger_id = l.id AND v.status IN ('POSTED','REVERSED')), 0), 2)`;

accountsRouter.get('/ledgers', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const q = String(req.query.q ?? '').trim();
  const where: string[] = ['l.company_id = ?']; const p: any[] = [cid];
  if (q) { where.push('(l.ledger_name LIKE ? OR l.ledger_code LIKE ? OR l.tally_name LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (req.query.group_id) { where.push('l.group_id = ?'); p.push(Number(req.query.group_id)); }
  if (req.query.type) { where.push('l.ledger_type = ?'); p.push(String(req.query.type)); }
  if (req.query.active === '1') where.push('l.is_active = 1');
  const rows = await query<any>(`SELECT l.*, g.group_name, g.nature, DATE_FORMAT(l.opening_date,'%Y-%m-%d') opening_date, ${BAL_SQL} AS balance,
        (SELECT COUNT(*) FROM acc_voucher_entry e WHERE e.ledger_id = l.id) used,
        (SELECT GROUP_CONCAT(r.role_code) FROM acc_ledger_role r WHERE r.ledger_id = l.id) roles,
        pt.party_code, ba.account_no bank_account_no
       FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id
       LEFT JOIN mst_party pt ON pt.id = l.party_id LEFT JOIN mst_company_bank_account ba ON ba.id = l.bank_account_id
      WHERE ${where.join(' AND ')} ORDER BY g.sort_order, l.ledger_name LIMIT 3000`, p);
  res.json({ data: rows });
}));

/** Compact list for pickers. */
accountsRouter.get('/ledger-options', VIEW, ah(async (req, res) => {
  const rows = await query<any>(`SELECT l.id, l.ledger_name label, l.ledger_code code, l.ledger_type, l.is_bill_wise, l.party_id, g.group_name, g.nature
      FROM acc_ledger l JOIN acc_account_group g ON g.id = l.group_id WHERE l.company_id = ? AND l.is_active = 1 ORDER BY l.ledger_name`, [cidOf(req)]);
  res.json({ data: rows });
}));

const ledgerSchema = z.object({
  ledger_name: z.string().trim().min(2, 'Enter the ledger name').max(150),
  ledger_code: z.string().trim().max(40).optional().nullable(),
  group_id: z.coerce.number().int().positive({ message: 'Pick the group' }),
  ledger_type: z.enum(['GENERAL', 'PARTY', 'BANK', 'CASH', 'TAX', 'STOCK']).optional(),
  party_id: z.coerce.number().int().positive().optional().nullable(),
  bank_account_id: z.coerce.number().int().positive().optional().nullable(),
  is_bill_wise: z.coerce.boolean().optional(),
  is_cost_centre_on: z.coerce.boolean().optional(),
  tax_kind: z.enum(['CGST', 'SGST', 'IGST', 'CESS', 'TDS', 'TCS']).optional().nullable(),
  tax_direction: z.enum(['IN', 'OUT']).optional().nullable(),
  tax_rate: z.coerce.number().min(0).max(100).optional().nullable(),
  gstin: z.string().trim().max(15).optional().nullable(),
  opening_balance: money.min(0, 'Opening balance is a positive amount — pick Dr or Cr').optional(),
  opening_dr_cr: z.enum(['DR', 'CR']).optional(),
  opening_date: optDate,
  tally_name: z.string().trim().max(150).optional().nullable(),
  remarks: z.string().trim().max(300).optional().nullable(),
  is_active: z.coerce.boolean().optional(),
});

async function checkLedgerLinks(cid: number, b: any, selfId?: number) {
  if (b.group_id) {
    const g = await queryOne<any>(`SELECT id FROM acc_account_group WHERE id = ? AND company_id = ? AND is_active = 1`, [b.group_id, cid]);
    if (!g) throw BadRequest('Pick an active group of this company');
  }
  if (b.party_id) {
    const p = await queryOne<any>(`SELECT id FROM mst_party WHERE id = ? AND company_id = ?`, [b.party_id, cid]);
    if (!p) throw BadRequest('Pick a party of this company');
    const dup = await queryOne<any>(`SELECT ledger_name FROM acc_ledger WHERE company_id = ? AND party_id = ? AND id <> ?`, [cid, b.party_id, selfId ?? 0]);
    if (dup) throw Conflict(`That party already has ledger "${dup.ledger_name}"`);
  }
  if (b.bank_account_id) {
    const a = await queryOne<any>(`SELECT id FROM mst_company_bank_account WHERE id = ? AND company_id = ?`, [b.bank_account_id, cid]);
    if (!a) throw BadRequest('Pick one of our bank accounts');
    const dup = await queryOne<any>(`SELECT ledger_name FROM acc_ledger WHERE company_id = ? AND bank_account_id = ? AND id <> ?`, [cid, b.bank_account_id, selfId ?? 0]);
    if (dup) throw Conflict(`That bank account already has ledger "${dup.ledger_name}"`);
  }
}

accountsRouter.post('/ledgers', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(ledgerSchema, req.body);
  await checkLedgerLinks(cid, b);
  const code = (b.ledger_code || `L-${b.ledger_name}`).toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/-+/g, '-').slice(0, 40);
  const type = b.ledger_type ?? (b.party_id ? 'PARTY' : b.bank_account_id ? 'BANK' : 'GENERAL');
  const r: any = await execute(`INSERT INTO acc_ledger (company_id, ledger_code, ledger_name, group_id, ledger_type, party_id, bank_account_id, is_bill_wise,
        is_cost_centre_on, tax_kind, tax_direction, tax_rate, gstin, state_code, opening_balance, opening_dr_cr, opening_date, tally_name, remarks, is_active, created_by)
      VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, code, b.ledger_name, b.group_id, type, b.party_id ?? null, b.bank_account_id ?? null, b.is_bill_wise ?? !!b.party_id ? 1 : 0,
      b.is_cost_centre_on ? 1 : 0, b.tax_kind ?? null, b.tax_direction ?? null, b.tax_rate ?? null, b.gstin || null, b.gstin ? b.gstin.slice(0, 2) : null,
      r2(b.opening_balance ?? 0), b.opening_dr_cr ?? 'DR', b.opening_date ?? null, b.tally_name || null, b.remarks || null, b.is_active === false ? 0 : 1, req.user!.id]);
  await audit(req, 'acc_ledger', r.insertId, 'INSERT', undefined, b);
  res.status(201).json({ data: { id: r.insertId }, message: `Ledger ${b.ledger_name} created` });
}));

accountsRouter.put('/ledgers/:id', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const cur = await queryOne<any>(`SELECT * FROM acc_ledger WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!cur) throw NotFound('Ledger not found');
  const b = parse(ledgerSchema.partial(), req.body);
  await checkLedgerLinks(cid, b, id);
  if (b.is_active === false) {
    const role = await queryOne<any>(`SELECT GROUP_CONCAT(role_code) r FROM acc_ledger_role WHERE ledger_id = ?`, [id]);
    if (role?.r) throw Conflict(`Ledger is used for automatic posting (${role.r}) — map another ledger first`);
  }
  const used = await queryOne<any>(`SELECT COUNT(*) n FROM acc_voucher_entry WHERE ledger_id = ?`, [id]);
  if (Number(used?.n) && b.group_id && Number(b.group_id) !== Number(cur.group_id)) {
    const [a, c] = await Promise.all([
      queryOne<any>(`SELECT nature FROM acc_account_group WHERE id = ?`, [cur.group_id]),
      queryOne<any>(`SELECT nature FROM acc_account_group WHERE id = ?`, [b.group_id]),
    ]);
    if (a?.nature !== c?.nature) throw Conflict('Ledger has vouchers — it can only move to a group of the same nature (asset / liability / income / expense)');
  }
  const set: string[] = []; const p: any[] = [];
  const put = (col: string, v: unknown) => { set.push(`${col} = ?`); p.push(v); };
  if (b.ledger_name !== undefined) put('ledger_name', b.ledger_name);
  if (b.ledger_code) put('ledger_code', b.ledger_code.toUpperCase().slice(0, 40));
  if (b.group_id !== undefined) put('group_id', b.group_id);
  if (b.ledger_type !== undefined && !Number(cur.is_system)) put('ledger_type', b.ledger_type);
  if (b.party_id !== undefined) put('party_id', b.party_id ?? null);
  if (b.bank_account_id !== undefined) put('bank_account_id', b.bank_account_id ?? null);
  if (b.is_bill_wise !== undefined) put('is_bill_wise', b.is_bill_wise ? 1 : 0);
  if (b.is_cost_centre_on !== undefined) put('is_cost_centre_on', b.is_cost_centre_on ? 1 : 0);
  if (b.tax_kind !== undefined) put('tax_kind', b.tax_kind ?? null);
  if (b.tax_direction !== undefined) put('tax_direction', b.tax_direction ?? null);
  if (b.tax_rate !== undefined) put('tax_rate', b.tax_rate ?? null);
  if (b.gstin !== undefined) { put('gstin', b.gstin || null); put('state_code', b.gstin ? b.gstin.slice(0, 2) : null); }
  if (b.opening_balance !== undefined) put('opening_balance', r2(b.opening_balance));
  if (b.opening_dr_cr !== undefined) put('opening_dr_cr', b.opening_dr_cr);
  if (b.opening_date !== undefined) put('opening_date', b.opening_date);
  if (b.tally_name !== undefined) put('tally_name', b.tally_name || null);
  if (b.remarks !== undefined) put('remarks', b.remarks || null);
  if (b.is_active !== undefined) put('is_active', b.is_active ? 1 : 0);
  if (set.length) await execute(`UPDATE acc_ledger SET ${set.join(', ')}, updated_by = ? WHERE id = ?`, [...p, req.user!.id, id]);
  await audit(req, 'acc_ledger', id, 'UPDATE', cur, b);
  res.json({ data: { id }, message: 'Ledger saved' });
}));

/** Create the missing party ledgers (suppliers / job workers / contractors → Sundry Creditors, buyers → Sundry Debtors). */
accountsRouter.post('/ledgers/sync-parties', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const parties = await query<any>(`SELECT p.id, (p.is_buyer = 1 OR p.is_customer = 1) AS debtor FROM mst_party p
      WHERE p.company_id = ? AND COALESCE(p.is_deleted, 0) = 0 AND COALESCE(p.is_active, 1) = 1
        AND (p.is_supplier = 1 OR p.is_vendor = 1 OR p.is_contractor = 1 OR p.is_buyer = 1 OR p.is_customer = 1)
        AND NOT EXISTS (SELECT 1 FROM acc_ledger l WHERE l.company_id = p.company_id AND l.party_id = p.id)`, [cid]);
  let n = 0;
  for (const p of parties) {
    await transaction((tx) => partyLedger(tx, cid, Number(p.id), Number(p.debtor) ? 'DEBTOR' : 'CREDITOR'));
    n += 1;
  }
  res.json({ data: { created: n }, message: n ? `${n} party ledger(s) created` : 'Every party already has a ledger' });
}));

// ================================================================ settings: posting ledgers, rules, voucher types, period lock
accountsRouter.get('/ledger-roles', VIEW, ah(async (req, res) => {
  const rows = await query<any>(`SELECT r.role_code, r.ledger_id, l.ledger_name, l.is_active FROM acc_ledger_role r LEFT JOIN acc_ledger l ON l.id = r.ledger_id WHERE r.company_id = ?`, [cidOf(req)]);
  const by = new Map(rows.map((r) => [r.role_code, r]));
  res.json({ data: POSTING_ROLES.map((x) => ({ ...x, ledger_id: by.get(x.code)?.ledger_id ?? null, ledger_name: by.get(x.code)?.ledger_name ?? null })) });
}));
accountsRouter.put('/ledger-roles', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(z.object({ role_code: z.string(), ledger_id: z.coerce.number().int().positive().nullable() }), req.body);
  if (!POSTING_ROLES.some((r) => r.code === b.role_code)) throw BadRequest('Unknown posting role');
  if (b.ledger_id) {
    const l = await queryOne<any>(`SELECT id FROM acc_ledger WHERE id = ? AND company_id = ? AND is_active = 1`, [b.ledger_id, cid]);
    if (!l) throw BadRequest('Pick an active ledger of this company');
  }
  const old = await queryOne<any>(`SELECT ledger_id FROM acc_ledger_role WHERE company_id = ? AND role_code = ?`, [cid, b.role_code]);
  await execute(`INSERT INTO acc_ledger_role (company_id, role_code, ledger_id, updated_by) VALUES (?,?,?,?)
                 ON DUPLICATE KEY UPDATE ledger_id = VALUES(ledger_id), updated_by = VALUES(updated_by)`, [cid, b.role_code, b.ledger_id, req.user!.id]);
  await audit(req, 'acc_ledger_role', 0, 'UPDATE', { role: b.role_code, ledger_id: old?.ledger_id ?? null }, { role: b.role_code, ledger_id: b.ledger_id });
  res.json({ data: b, message: 'Posting ledger saved' });
}));

accountsRouter.get('/rules', VIEW, ah(async (req, res) => {
  const rows = await query<any>(`SELECT event_code, mode, DATE_FORMAT(effective_from,'%Y-%m-%d') effective_from FROM acc_posting_rule WHERE company_id = ?`, [cidOf(req)]);
  const by = new Map(rows.map((r) => [r.event_code, r]));
  res.json({ data: POSTING_EVENTS.map((e) => ({ ...e, mode: by.get(e.code)?.mode ?? 'OFF', effective_from: by.get(e.code)?.effective_from ?? null })) });
}));
accountsRouter.put('/rules/:event', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req); const ev = String(req.params.event);
  if (!POSTING_EVENTS.some((e) => e.code === ev)) throw NotFound('Unknown posting event');
  const b = parse(z.object({ mode: z.enum(['OFF', 'REVIEW', 'AUTO']), effective_from: optDate }), req.body);
  const old = await queryOne<any>(`SELECT mode, effective_from FROM acc_posting_rule WHERE company_id = ? AND event_code = ?`, [cid, ev]);
  await execute(`INSERT INTO acc_posting_rule (company_id, event_code, mode, effective_from, updated_by) VALUES (?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE mode = VALUES(mode), effective_from = VALUES(effective_from), updated_by = VALUES(updated_by)`,
    [cid, ev, b.mode, b.effective_from, req.user!.id]);
  await audit(req, 'acc_posting_rule', 0, 'UPDATE', { event: ev, ...old }, { event: ev, ...b });
  res.json({ data: b, message: 'Posting switch saved' });
}));

accountsRouter.get('/voucher-types', VIEW, ah(async (req, res) => {
  res.json({ data: await query<any>(`SELECT * FROM acc_voucher_type WHERE company_id = ? ORDER BY FIELD(type_code, ${VOUCHER_TYPES.map(() => '?').join(',')})`, [cidOf(req), ...VOUCHER_TYPES]) });
}));
accountsRouter.put('/voucher-types/:code', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(z.object({
    type_name: z.string().trim().min(2).max(60).optional(), prefix: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9-]+$/, 'Prefix: letters, digits, -').optional(),
    tally_voucher_type: z.string().trim().min(2).max(60).optional(), approval_required: z.coerce.boolean().optional(),
  }), req.body);
  const cur = await queryOne<any>(`SELECT * FROM acc_voucher_type WHERE company_id = ? AND type_code = ?`, [cid, req.params.code]);
  if (!cur) throw NotFound('Voucher type not found');
  await execute(`UPDATE acc_voucher_type SET type_name = COALESCE(?, type_name), prefix = COALESCE(?, prefix), tally_voucher_type = COALESCE(?, tally_voucher_type),
      approval_required = COALESCE(?, approval_required) WHERE id = ?`,
    [b.type_name ?? null, b.prefix?.toUpperCase() ?? null, b.tally_voucher_type ?? null, b.approval_required === undefined ? null : (b.approval_required ? 1 : 0), cur.id]);
  await audit(req, 'acc_voucher_type', Number(cur.id), 'UPDATE', cur, b);
  res.json({ data: { ok: true }, message: 'Voucher type saved' });
}));

/** Books options (cfg_system_setting): stock in P&L / balance sheet, scan interval. */
const OPTION_KEYS = { stock_from_erp: 'ACC_STOCK_FROM_ERP', scan_minutes: 'ACC_AUTO_SWEEP_MIN' } as const;
accountsRouter.get('/options', VIEW, ah(async (req, res) => {
  const rows = await query<any>(`SELECT setting_key k, setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key IN (?)`, [cidOf(req), Object.values(OPTION_KEYS)]);
  const by = new Map(rows.map((r) => [r.k, r.v]));
  res.json({ data: { stock_from_erp: by.get(OPTION_KEYS.stock_from_erp) === '1', scan_minutes: Number(by.get(OPTION_KEYS.scan_minutes) ?? 10) } });
}));
accountsRouter.put('/options', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(z.object({ stock_from_erp: z.coerce.boolean().optional(), scan_minutes: z.coerce.number().int().min(0).max(1440).optional() }), req.body);
  const put = async (k: string, v: string) => execute(`INSERT INTO cfg_system_setting (company_id, setting_key, setting_value) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [cid, k, v]);
  if (b.stock_from_erp !== undefined) await put(OPTION_KEYS.stock_from_erp, b.stock_from_erp ? '1' : '0');
  if (b.scan_minutes !== undefined) await put(OPTION_KEYS.scan_minutes, String(b.scan_minutes));
  await audit(req, 'cfg_system_setting', 0, 'UPDATE', undefined, { accounts_options: b });
  res.json({ data: b, message: 'Books options saved' });
}));

accountsRouter.get('/period-lock', VIEW, ah(async (req, res) => {
  const r = await queryOne<any>(`SELECT DATE_FORMAT(locked_upto,'%Y-%m-%d') locked_upto, updated_at FROM acc_period_lock WHERE company_id = ?`, [cidOf(req)]);
  res.json({ data: r ?? { locked_upto: null } });
}));
accountsRouter.put('/period-lock', ADMIN, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(z.object({ locked_upto: optDate }), req.body);
  const old = await queryOne<any>(`SELECT DATE_FORMAT(locked_upto,'%Y-%m-%d') d FROM acc_period_lock WHERE company_id = ?`, [cid]);
  if (b.locked_upto) {
    const open = await queryOne<any>(`SELECT COUNT(*) n FROM acc_voucher WHERE company_id = ? AND status IN ('DRAFT','PENDING_APPROVAL') AND voucher_date <= ?`, [cid, b.locked_upto]);
    if (Number(open?.n)) throw Conflict(`${open.n} unposted voucher(s) are dated on/before ${b.locked_upto} — post or cancel them before locking`);
  }
  await execute(`INSERT INTO acc_period_lock (company_id, locked_upto, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE locked_upto = VALUES(locked_upto), updated_by = VALUES(updated_by)`,
    [cid, b.locked_upto, req.user!.id]);
  await audit(req, 'acc_period_lock', cid, 'UPDATE', old, b);
  res.json({ data: b, message: b.locked_upto ? `Books locked up to ${b.locked_upto}` : 'Books unlocked' });
}));

// ================================================================ vouchers
const entrySchema = z.object({
  ledger_id: z.coerce.number().int().positive({ message: 'Pick a ledger on every line' }),
  debit: money.optional().nullable(), credit: money.optional().nullable(),
  narration: z.string().trim().max(300).optional().nullable(),
  bill_ref_type: z.enum(['NEW', 'AGAINST', 'ADVANCE', 'ON_ACCOUNT']).optional().nullable(),
  bill_ref_no: z.string().trim().max(60).optional().nullable(),
  bill_due_date: optDate,
  so_id: z.coerce.number().int().positive().optional().nullable(),
});
const voucherSchema = z.object({
  type_code: z.enum(VOUCHER_TYPES as [string, ...string[]]),
  voucher_date: date,
  narration: z.string().trim().max(1000).optional().nullable(),
  ref_no: z.string().trim().max(60).optional().nullable(),
  ref_date: optDate,
  party_ledger_id: z.coerce.number().int().positive().optional().nullable(),
  entries: z.array(entrySchema).min(2, 'A voucher needs at least two lines'),
  submit: z.coerce.boolean().optional(),
  row_version: z.coerce.number().int().optional(),
});

/** Bill-wise party lines with no reference → On Account; party ledger defaults to the first party line. */
async function normaliseManual(cid: number, b: z.infer<typeof voucherSchema>): Promise<VoucherInput> {
  const ids = [...new Set(b.entries.map((e) => e.ledger_id))];
  const leds = await query<any>(`SELECT id, is_bill_wise, ledger_type, is_control FROM acc_ledger WHERE company_id = ? AND id IN (?)`, [cid, ids]);
  const by = new Map(leds.map((l) => [Number(l.id), l]));
  const entries = b.entries.map((e) => {
    const l = by.get(e.ledger_id);
    const bw = l && Number(l.is_bill_wise);
    return { ...e, bill_ref_type: bw ? (e.bill_ref_type ?? 'ON_ACCOUNT') : null, bill_ref_no: bw && e.bill_ref_type !== 'ON_ACCOUNT' ? (e.bill_ref_no || null) : null };
  });
  for (const [i, e] of entries.entries()) {
    if (e.bill_ref_type && e.bill_ref_type !== 'ON_ACCOUNT' && !e.bill_ref_no) throw BadRequest(`Line ${i + 1}: enter the bill reference (or choose On account)`);
  }
  const party = b.party_ledger_id ?? entries.map((e) => by.get(e.ledger_id)).find((l) => l?.ledger_type === 'PARTY')?.id ?? null;
  return { type_code: b.type_code as any, voucher_date: b.voucher_date, narration: b.narration ?? null, ref_no: b.ref_no ?? null, ref_date: b.ref_date ?? null,
    party_ledger_id: party ? Number(party) : null, entries };
}

accountsRouter.get('/vouchers', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const w: string[] = ['v.company_id = ?']; const p: any[] = [cid];
  const qs = req.query as Record<string, string>;
  if (qs.type) { w.push('v.type_code = ?'); p.push(qs.type); }
  if (qs.status) { w.push(`v.status IN (?)`); p.push(qs.status.split(',')); }
  if (qs.tally_status) { w.push(`v.tally_status IN (?)`); p.push(qs.tally_status.split(',')); }
  if (qs.from) { w.push('v.voucher_date >= ?'); p.push(qs.from); }
  if (qs.to) { w.push('v.voucher_date <= ?'); p.push(qs.to); }
  if (qs.source) { w.push(qs.source === 'MANUAL' ? 'v.source_module IS NULL' : 'v.source_module = ?'); if (qs.source !== 'MANUAL') p.push(qs.source); }
  if (qs.ledger_id) { w.push('EXISTS (SELECT 1 FROM acc_voucher_entry e WHERE e.voucher_id = v.id AND e.ledger_id = ?)'); p.push(Number(qs.ledger_id)); }
  if (qs.q) { w.push('(v.voucher_no LIKE ? OR v.ref_no LIKE ? OR v.source_no LIKE ? OR v.narration LIKE ? OR pl.ledger_name LIKE ?)'); p.push(...Array(5).fill(`%${qs.q}%`)); }
  const page = Math.max(1, Number(qs.page) || 1); const size = Math.min(200, Math.max(10, Number(qs.pageSize) || 50));
  const total = await queryOne<any>(`SELECT COUNT(*) n FROM acc_voucher v LEFT JOIN acc_ledger pl ON pl.id = v.party_ledger_id WHERE ${w.join(' AND ')}`, p);
  const rows = await query<any>(`SELECT v.id, v.type_code, v.voucher_no, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') voucher_date, v.ref_no, v.narration, v.total_debit,
        v.status, v.is_auto, v.source_module, v.source_id, v.source_no, v.tally_status, v.tally_voucher_no, pl.ledger_name party_name,
        uc.full_name created_by_name, ua.full_name approved_by_name, v.currency_code, v.fc_amount
       FROM acc_voucher v LEFT JOIN acc_ledger pl ON pl.id = v.party_ledger_id
       LEFT JOIN mst_user uc ON uc.id = v.created_by LEFT JOIN mst_user ua ON ua.id = v.approved_by
      WHERE ${w.join(' AND ')} ORDER BY v.voucher_date DESC, v.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, p);
  res.json({ data: rows, pagination: { page, pageSize: size, total: Number(total?.n ?? 0) } });
}));

accountsRouter.get('/vouchers/:id', VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const v = await queryOne<any>(`SELECT v.*, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') voucher_date, DATE_FORMAT(v.ref_date,'%Y-%m-%d') ref_date,
        pl.ledger_name party_name, uc.full_name created_by_name, us.full_name submitted_by_name, ua.full_name approved_by_name,
        rv.voucher_no reversal_of_no, rb.voucher_no reversed_by_no
       FROM acc_voucher v LEFT JOIN acc_ledger pl ON pl.id = v.party_ledger_id
       LEFT JOIN mst_user uc ON uc.id = v.created_by LEFT JOIN mst_user us ON us.id = v.submitted_by LEFT JOIN mst_user ua ON ua.id = v.approved_by
       LEFT JOIN acc_voucher rv ON rv.id = v.reversal_of_id LEFT JOIN acc_voucher rb ON rb.id = v.reversed_by_id
      WHERE v.id = ? AND v.company_id = ?`, [id, cid]);
  if (!v) throw NotFound('Voucher not found');
  const entries = await query<any>(`SELECT e.*, DATE_FORMAT(e.bill_due_date,'%Y-%m-%d') bill_due_date, l.ledger_name, l.ledger_code, l.is_bill_wise, g.group_name, so.io_no
      FROM acc_voucher_entry e JOIN acc_ledger l ON l.id = e.ledger_id JOIN acc_account_group g ON g.id = l.group_id
      LEFT JOIN trx_sales_order so ON so.id = e.so_id WHERE e.voucher_id = ? ORDER BY e.line_no`, [id]);
  const tally = await query<any>(`SELECT q.*, t.tally_company_name, t.connector FROM acc_tally_queue q JOIN acc_tally_company t ON t.id = q.tally_company_id WHERE q.voucher_id = ?`, [id]);
  const src = v.source_module ? SOURCES.find((s) => s.module === v.source_module && s.postingEvent === v.posting_event) : null;
  const history = await query<any>(`SELECT a.id, a.changed_at, a.new_values, u.full_name user_name FROM log_audit a LEFT JOIN mst_user u ON u.id = a.changed_by
      WHERE a.company_id = ? AND a.table_name = 'acc_voucher' AND a.record_id = ? ORDER BY a.id DESC LIMIT 50`, [cid, id]);
  res.json({ data: { ...v, entries, tally, source_label: src?.label ?? null, source_link: src && v.source_id ? src.link(Number(v.source_id)) : null,
    history: history.map((h) => ({ ...h, new_values: typeof h.new_values === 'string' ? JSON.parse(h.new_values) : h.new_values })) } });
}));

accountsRouter.post('/vouchers', ENTRY, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(voucherSchema, req.body);
  const input = await normaliseManual(cid, b);
  const out = await transaction(async (tx) => {
    const r = await createVoucher(tx, actor(req), input, b.submit ? 'PENDING_APPROVAL' : 'DRAFT');
    await audit(req, 'acc_voucher', r.id, 'INSERT', undefined, { action: b.submit ? 'CREATE_SUBMIT' : 'CREATE', type: b.type_code, date: b.voucher_date }, tx);
    return r;
  });
  res.status(201).json({ data: out, message: b.submit ? 'Voucher submitted for approval' : 'Draft saved' });
}));

accountsRouter.put('/vouchers/:id', ENTRY, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const b = parse(voucherSchema, req.body);
  const input = await normaliseManual(cid, b);
  await transaction(async (tx) => {
    await updateDraft(tx, actor(req), id, input, b.row_version);
    if (b.submit) await txExecute(tx, `UPDATE acc_voucher SET status = 'PENDING_APPROVAL', submitted_by = ?, submitted_at = NOW() WHERE id = ?`, [req.user!.id, id]);
    await audit(req, 'acc_voucher', id, 'UPDATE', undefined, { action: b.submit ? 'EDIT_SUBMIT' : 'EDIT' }, tx);
  });
  res.json({ data: { id }, message: b.submit ? 'Voucher submitted for approval' : 'Draft saved' });
}));

accountsRouter.post('/vouchers/:id/submit', ENTRY, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  await transaction(async (tx) => {
    const v = await lockVoucher(tx, cid, id);
    if (!['DRAFT', 'REJECTED'].includes(v.status)) throw Conflict('Only a draft can be submitted');
    await txExecute(tx, `UPDATE acc_voucher SET status = 'PENDING_APPROVAL', submitted_by = ?, submitted_at = NOW(), reject_reason = NULL, row_version = row_version + 1 WHERE id = ?`, [req.user!.id, id]);
    await audit(req, 'acc_voucher', id, 'UPDATE', { status: v.status }, { action: 'SUBMIT', status: 'PENDING_APPROVAL' }, tx);
  });
  res.json({ data: { id }, message: 'Submitted for approval' });
}));

async function approveOne(req: Request, id: number) {
  return transaction(async (tx) => {
    const v = await postVoucher(tx, actor(req), id);
    await enqueueTally(tx, cidOf(req), id);
    await audit(req, 'acc_voucher', id, 'UPDATE', { status: 'PENDING_APPROVAL' }, { action: 'APPROVE', status: 'POSTED', voucher_no: v.voucher_no }, tx);
    return v;
  });
}

accountsRouter.post('/vouchers/:id/approve', APPROVE, ah(async (req, res) => {
  const v = await approveOne(req, idParam(req));
  res.json({ data: { id: v.id, voucher_no: v.voucher_no }, message: `Posted as ${v.voucher_no}` });
}));

/** Approve several (e.g. the auto vouchers of a day). Each in its own transaction; failures are reported, not fatal. */
accountsRouter.post('/vouchers/approve-many', APPROVE, ah(async (req, res) => {
  const ids = parse(z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500) }), req.body).ids;
  const ok: any[] = []; const failed: any[] = [];
  for (const id of ids) {
    try { const v = await approveOne(req, id); ok.push({ id, voucher_no: v.voucher_no }); } catch (err) { failed.push({ id, message: (err as Error).message }); }
  }
  res.json({ data: { ok, failed }, message: `${ok.length} posted${failed.length ? `, ${failed.length} not posted` : ''}` });
}));

accountsRouter.post('/vouchers/:id/reject', APPROVE, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const reason = reasonOf(req.body);
  await transaction(async (tx) => {
    const v = await lockVoucher(tx, cid, id);
    if (v.status !== 'PENDING_APPROVAL') throw Conflict('Only a voucher waiting for approval can be rejected');
    if (v.is_auto) {
      // an automatic voucher is cancelled (frees the document so a corrected document posts again)
      await cancelVoucher(tx, actor(req), id, `Rejected: ${reason}`);
    } else {
      await txExecute(tx, `UPDATE acc_voucher SET status = 'REJECTED', reject_reason = ?, row_version = row_version + 1 WHERE id = ?`, [reason, id]);
    }
    await audit(req, 'acc_voucher', id, 'UPDATE', { status: v.status }, { action: 'REJECT', reason }, tx);
  });
  res.json({ data: { id }, message: 'Voucher rejected' });
}));

accountsRouter.post('/vouchers/:id/cancel', ENTRY, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const reason = reasonOf(req.body);
  await transaction(async (tx) => {
    const v = await cancelVoucher(tx, actor(req), id, reason);
    await audit(req, 'acc_voucher', id, 'UPDATE', { status: v.status }, { action: 'CANCEL', reason }, tx);
  });
  void cid;
  res.json({ data: { id }, message: 'Voucher cancelled' });
}));

accountsRouter.post('/vouchers/:id/reverse', APPROVE, ah(async (req, res) => {
  const id = idParam(req);
  const b = parse(z.object({ reason: z.string().trim().min(5, 'Enter the reason (at least 5 characters)').max(500), date: optDate }), req.body);
  const out = await transaction(async (tx) => {
    const r = await reverseVoucher(tx, actor(req), id, b.reason, b.date);
    await enqueueTally(tx, cidOf(req), r.reversal.id);
    await audit(req, 'acc_voucher', id, 'UPDATE', { status: 'POSTED' }, { action: 'REVERSE', reason: b.reason, reversal_id: r.reversal.id, reversal_no: r.reversal.voucher_no }, tx);
    return r;
  });
  res.json({ data: { id, reversal_id: out.reversal.id, reversal_no: out.reversal.voucher_no },
    message: `Reversed by ${out.reversal.voucher_no}${out.original.source_module ? ' — the document can be posted again after correction' : ''}` });
}));

// ================================================================ inbox: ERP documents → vouchers
accountsRouter.get('/inbox/pending', VIEW, ah(async (req, res) => {
  res.json({ data: await pendingDocuments(cidOf(req), req.query.event ? String(req.query.event) : undefined) });
}));
accountsRouter.get('/inbox/changed', VIEW, ah(async (req, res) => {
  res.json({ data: await staleVouchers(cidOf(req)) });
}));
accountsRouter.post('/inbox/scan', ENTRY, ah(async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.map(String) : undefined;
  const r = await scanCompany(cidOf(req), req.user!.id, events);
  res.json({ data: r, message: `${r.created} voucher(s) created${r.issues ? `, ${r.issues} document(s) need attention` : ''}` });
}));
/** Create the voucher of one document now (also documents before the effective date or with the switch OFF). */
accountsRouter.post('/inbox/create', ENTRY, ah(async (req, res) => {
  const b = parse(z.object({ event: z.string(), source_id: z.coerce.number().int().positive(), post: z.coerce.boolean().optional() }), req.body);
  const s = sourceByEvent(b.event);
  if (!s) throw NotFound('Unknown posting event');
  if (b.post && !has(req, P.APPROVE)) throw Forbidden('Posting directly needs ACCOUNTS.APPROVE');
  try {
    const r = await voucherFromSource(actor(req), s, b.source_id, b.post ? 'AUTO' : 'REVIEW');
    res.json({ data: r, message: r.created ? (r.status === 'POSTED' ? `Posted as ${r.voucher_no}` : 'Voucher created — waiting for approval') : 'This document already has a voucher' });
  } catch (err) {
    const row = (await s.candidates(cidOf(req), null, 5000)).find((c) => Number(c.id) === b.source_id);
    await execute(`INSERT INTO acc_posting_issue (company_id, event_code, source_id, source_no, source_date, error_code, message) VALUES (?,?,?,?,?,?,?)
                   ON DUPLICATE KEY UPDATE message = VALUES(message), error_code = VALUES(error_code), attempts = attempts + 1, last_seen_at = NOW()`,
      [cidOf(req), s.event, b.source_id, row?.no ?? null, row?.date ?? null, ((err as any)?.details?.code) ?? 'OTHER', String((err as Error).message).slice(0, 1000)]);
    throw err;
  }
}));

// ================================================================ bank realisation (buyer money)
const realSchema = z.object({
  receipt_date: date,
  buyer_id: z.coerce.number().int().positive({ message: 'Pick the buyer' }),
  currency_id: z.coerce.number().int().positive({ message: 'Pick the currency' }),
  exchange_rate: z.coerce.number().positive('Enter the realised exchange rate'),
  amount_fc: z.coerce.number().positive('Enter the amount received (foreign currency)'),
  amount_inr: z.coerce.number().positive().optional().nullable(),
  bank_charges_inr: z.coerce.number().min(0).optional().nullable(),
  bank_account_id: z.coerce.number().int().positive({ message: 'Pick our bank account credited' }),
  mode: z.enum(['TT', 'LC', 'ADVANCE', 'CHEQUE', 'ONLINE', 'OTHER']).default('TT'),
  bank_ref: z.string().trim().max(60).optional().nullable(),
  brc_no: z.string().trim().max(60).optional().nullable(),
  firc_no: z.string().trim().max(60).optional().nullable(),
  remarks: z.string().trim().max(500).optional().nullable(),
  allocations: z.array(z.object({ invoice_id: z.coerce.number().int().positive(), allocated_fc: z.coerce.number().positive('Allocated amount must be more than 0') })).default([]),
  draft: z.coerce.boolean().optional(),
});

/** Final invoices of a buyer with what is still open (FC) — realisations that are not cancelled count. */
async function openInvoices(cid: number, buyerId: number, currencyId?: number | null, exceptReceipt?: number | null) {
  return query<any>(`SELECT i.id, i.invoice_no, DATE_FORMAT(i.invoice_date,'%Y-%m-%d') invoice_date, i.currency_id, c.code currency, i.exchange_rate,
        ROUND(i.total_value, 2) total_fc,
        ROUND(COALESCE((SELECT SUM(m.allocated_fc) FROM map_receipt_invoice m JOIN trx_receipt r ON r.id = m.receipt_id
                         WHERE m.invoice_id = i.id AND r.status <> 'CANCELLED' AND r.id <> ?), 0), 2) realised_fc,
        so.io_no
       FROM trx_commercial_invoice i LEFT JOIN cfg_currency c ON c.id = i.currency_id LEFT JOIN trx_sales_order so ON so.id = i.so_id
      WHERE i.company_id = ? AND i.buyer_id = ? AND i.doc_status = 'FINAL' AND (? IS NULL OR i.currency_id = ?)
      ORDER BY i.invoice_date, i.id`, [exceptReceipt ?? 0, cid, buyerId, currencyId ?? null, currencyId ?? null]);
}

accountsRouter.get('/realisations/open-invoices', VIEW, ah(async (req, res) => {
  const buyer = Number(req.query.buyer_id);
  if (!buyer) throw BadRequest('Pick the buyer');
  const rows = await openInvoices(cidOf(req), buyer, req.query.currency_id ? Number(req.query.currency_id) : null, req.query.except ? Number(req.query.except) : null);
  res.json({ data: rows.map((r) => ({ ...r, open_fc: r2(Number(r.total_fc) - Number(r.realised_fc)) })) });
}));

accountsRouter.get('/realisations', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const rows = await query<any>(`SELECT r.id, r.receipt_no, DATE_FORMAT(r.receipt_date,'%Y-%m-%d') receipt_date, r.buyer_id, p.party_name buyer_name, c.code currency,
        r.amount_fc, r.exchange_rate, r.amount_inr, r.bank_charges_inr, r.bank_ref, r.brc_no, r.firc_no, r.status, r.mode,
        (SELECT GROUP_CONCAT(i.invoice_no ORDER BY i.invoice_no SEPARATOR ', ') FROM map_receipt_invoice m JOIN trx_commercial_invoice i ON i.id = m.invoice_id WHERE m.receipt_id = r.id) invoices,
        (SELECT ROUND(SUM(m.allocated_fc),2) FROM map_receipt_invoice m WHERE m.receipt_id = r.id) allocated_fc,
        v.id voucher_id, v.voucher_no, v.status voucher_status, ba.bank_name
       FROM trx_receipt r LEFT JOIN mst_party p ON p.id = r.buyer_id LEFT JOIN cfg_currency c ON c.id = r.currency_id
       LEFT JOIN mst_company_bank_account ba ON ba.id = r.bank_account_id
       LEFT JOIN acc_voucher v ON v.company_id = r.company_id AND v.source_key = CONCAT('REALISATION:POST:', r.id, ':1')
      WHERE r.company_id = ? ORDER BY r.receipt_date DESC, r.id DESC LIMIT 1000`, [cid]);
  res.json({ data: rows });
}));

accountsRouter.get('/realisations/:id', VIEW, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const r = await queryOne<any>(`SELECT r.*, DATE_FORMAT(r.receipt_date,'%Y-%m-%d') receipt_date, p.party_name buyer_name, c.code currency
      FROM trx_receipt r LEFT JOIN mst_party p ON p.id = r.buyer_id LEFT JOIN cfg_currency c ON c.id = r.currency_id WHERE r.id = ? AND r.company_id = ?`, [id, cid]);
  if (!r) throw NotFound('Realisation not found');
  const allocations = await query<any>(`SELECT m.invoice_id, m.allocated_fc, m.allocated_inr, i.invoice_no, DATE_FORMAT(i.invoice_date,'%Y-%m-%d') invoice_date, i.exchange_rate invoice_rate, ROUND(i.total_value,2) total_fc
      FROM map_receipt_invoice m JOIN trx_commercial_invoice i ON i.id = m.invoice_id WHERE m.receipt_id = ?`, [id]);
  const vouchers = await query<any>(`SELECT id, voucher_no, status, DATE_FORMAT(voucher_date,'%Y-%m-%d') voucher_date, total_debit FROM acc_voucher
      WHERE company_id = ? AND source_module = 'REALISATION' AND source_id = ? ORDER BY id`, [cid, id]);
  res.json({ data: { ...r, allocations, vouchers } });
}));

async function writeRealisation(req: Request, id: number | null) {
  const cid = cidOf(req);
  const b = parse(realSchema, req.body);
  const inr = r2(b.amount_inr ?? b.amount_fc * b.exchange_rate);
  const charges = r2(b.bank_charges_inr ?? 0);
  if (charges >= inr) throw BadRequest('Bank charges cannot be more than the realised INR amount');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  if (b.receipt_date > today) throw BadRequest('Realisation date cannot be in the future');
  const ids = b.allocations.map((a) => a.invoice_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('Each invoice can appear only once');
  const allocTotal = r2(b.allocations.reduce((t, a) => t + a.allocated_fc, 0));
  if (allocTotal - b.amount_fc > 0.009) throw BadRequest(`Invoice allocations (${allocTotal.toFixed(2)}) are more than the amount received (${b.amount_fc.toFixed(2)})`);
  return transaction(async (tx) => {
    const buyer = await txQueryOne<any>(tx, `SELECT id, party_name FROM mst_party WHERE id = ? AND company_id = ?`, [b.buyer_id, cid]);
    if (!buyer) throw BadRequest('Pick a buyer of this company');
    const bank = await txQueryOne<any>(tx, `SELECT id FROM mst_company_bank_account WHERE id = ? AND company_id = ? AND is_active = 1`, [b.bank_account_id, cid]);
    if (!bank) throw BadRequest('Pick one of our active bank accounts');
    if (b.bank_ref) {
      const dup = await txQueryOne<any>(tx, `SELECT receipt_no FROM trx_receipt WHERE company_id = ? AND bank_ref = ? AND status <> 'CANCELLED' AND id <> ? LIMIT 1`, [cid, b.bank_ref, id ?? 0]);
      if (dup) throw Conflict(`Bank reference ${b.bank_ref} is already on realisation ${dup.receipt_no}`);
    }
    const open = await openInvoices(cid, b.buyer_id, null, id);
    for (const a of b.allocations) {
      const inv = open.find((o) => Number(o.id) === a.invoice_id);
      if (!inv) throw BadRequest('Allocate only to FINAL invoices of this buyer');
      if (Number(inv.currency_id) !== b.currency_id) throw BadRequest(`Invoice ${inv.invoice_no} is in ${inv.currency} — the realisation currency must match`);
      const left = r2(Number(inv.total_fc) - Number(inv.realised_fc));
      if (a.allocated_fc - left > 0.009) throw BadRequest(`Invoice ${inv.invoice_no}: only ${left.toFixed(2)} ${inv.currency} is still open`);
    }
    let rid = id;
    const status = b.draft ? 'DRAFT' : 'POSTED';
    if (rid) {
      const cur = await txQueryOne<any>(tx, `SELECT status FROM trx_receipt WHERE id = ? AND company_id = ? FOR UPDATE`, [rid, cid]);
      if (!cur) throw NotFound('Realisation not found');
      if (cur.status !== 'DRAFT') throw Conflict('Only a draft realisation can be edited — cancel and enter it again');
      await txExecute(tx, `UPDATE trx_receipt SET receipt_date = ?, buyer_id = ?, mode = ?, currency_id = ?, exchange_rate = ?, amount_fc = ?, amount_inr = ?,
          bank_ref = ?, brc_no = ?, firc_no = ?, is_advance = ?, remarks = ?, bank_account_id = ?, bank_charges_inr = ?, status = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
        [b.receipt_date, b.buyer_id, b.mode, b.currency_id, b.exchange_rate, r2(b.amount_fc), inr, b.bank_ref || null, b.brc_no || null, b.firc_no || null,
          allocTotal < b.amount_fc - 0.009 ? 1 : 0, b.remarks || null, b.bank_account_id, charges, status, req.user!.id, rid]);
      await txExecute(tx, `DELETE FROM map_receipt_invoice WHERE receipt_id = ?`, [rid]);
    } else {
      await txExecute(tx, `INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, suffix, next_number, padding)
          SELECT ?, NULL, 'REALISATION', NULL, 'BRL-', '', 1, 5 FROM DUAL
           WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series WHERE company_id = ? AND branch_id IS NULL AND doc_type = 'REALISATION' AND fy_id IS NULL)`, [cid, cid]);
      const no = await nextDocNumber(tx, cid, 'REALISATION');
      const ins: any = await txExecute(tx, `INSERT INTO trx_receipt (company_id, receipt_no, receipt_date, buyer_id, mode, currency_id, exchange_rate, amount_fc, amount_inr,
          bank_ref, brc_no, firc_no, is_advance, remarks, bank_account_id, bank_charges_inr, status, created_by)
          VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`,
        [cid, no, b.receipt_date, b.buyer_id, b.mode, b.currency_id, b.exchange_rate, r2(b.amount_fc), inr, b.bank_ref || null, b.brc_no || null, b.firc_no || null,
          allocTotal < b.amount_fc - 0.009 ? 1 : 0, b.remarks || null, b.bank_account_id, charges, status, req.user!.id]);
      rid = Number(ins.insertId);
    }
    for (const a of b.allocations) {
      await txExecute(tx, `INSERT INTO map_receipt_invoice (receipt_id, invoice_id, allocated_fc, allocated_inr) VALUES (?,?,?,?)`,
        [rid, a.invoice_id, r2(a.allocated_fc), r2(a.allocated_fc * b.exchange_rate)]);
    }
    await audit(req, 'trx_receipt', rid!, id ? 'UPDATE' : 'INSERT', undefined, { ...b, amount_inr: inr, status }, tx);
    const row = await txQueryOne<any>(tx, `SELECT receipt_no FROM trx_receipt WHERE id = ?`, [rid]);
    return { id: rid!, receipt_no: row?.receipt_no as string, status };
  });
}

/** After a realisation is POSTED: make its Receipt voucher per the posting switch (problems land in the inbox). */
async function realisationVoucher(req: Request, id: number) {
  const rule = await queryOne<any>(`SELECT mode FROM acc_posting_rule WHERE company_id = ? AND event_code = 'REALISATION.POST'`, [cidOf(req)]);
  if (!rule || rule.mode === 'OFF') return { note: 'Receipt voucher not made (posting switch is OFF)' };
  const s = sourceByEvent('REALISATION.POST')!;
  try {
    const v = await voucherFromSource(actor(req), s, id, rule.mode === 'AUTO' ? 'AUTO' : 'REVIEW');
    return { voucher_id: v.id, note: v.status === 'POSTED' ? `Receipt voucher ${v.voucher_no} posted` : 'Receipt voucher waiting for approval' };
  } catch (err) {
    await execute(`INSERT INTO acc_posting_issue (company_id, event_code, source_id, error_code, message) VALUES (?, 'REALISATION.POST', ?, ?, ?)
                   ON DUPLICATE KEY UPDATE message = VALUES(message), attempts = attempts + 1, last_seen_at = NOW()`,
      [cidOf(req), id, ((err as any)?.details?.code) ?? 'OTHER', String((err as Error).message).slice(0, 1000)]);
    return { note: `Receipt voucher not made: ${(err as Error).message}` };
  }
}

accountsRouter.post('/realisations', ENTRY, ah(async (req, res) => {
  const r = await writeRealisation(req, null);
  const v = r.status === 'POSTED' ? await realisationVoucher(req, r.id) : null;
  res.status(201).json({ data: { ...r, ...v }, message: `${r.receipt_no} ${r.status === 'DRAFT' ? 'saved as draft' : 'saved'}${v?.note ? ` — ${v.note}` : ''}` });
}));
accountsRouter.put('/realisations/:id', ENTRY, ah(async (req, res) => {
  const r = await writeRealisation(req, idParam(req));
  const v = r.status === 'POSTED' ? await realisationVoucher(req, r.id) : null;
  res.json({ data: { ...r, ...v }, message: `${r.receipt_no} saved${v?.note ? ` — ${v.note}` : ''}` });
}));
/** Cancel: an unposted voucher is cancelled with it; a posted voucher is reversed (needs ACCOUNTS.APPROVE). */
accountsRouter.post('/realisations/:id/cancel', ENTRY, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req); const reason = reasonOf(req.body);
  const out = await transaction(async (tx) => {
    const r = await txQueryOne<any>(tx, `SELECT * FROM trx_receipt WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!r) throw NotFound('Realisation not found');
    if (r.status === 'CANCELLED') throw Conflict('Already cancelled');
    const vs = await txQuery<any>(tx, `SELECT id, status, voucher_no FROM acc_voucher WHERE company_id = ? AND source_module = 'REALISATION' AND source_id = ? AND status IN ('DRAFT','PENDING_APPROVAL','POSTED')`, [cid, id]);
    let reversal: string | null = null;
    for (const v of vs) {
      if (v.status === 'POSTED') {
        if (!has(req, P.APPROVE)) throw Forbidden(`Receipt voucher ${v.voucher_no} is posted — someone with ACCOUNTS.APPROVE must cancel (it reverses the voucher)`);
        const rv = await reverseVoucher(tx, actor(req), Number(v.id), `Realisation ${r.receipt_no} cancelled: ${reason}`, null);
        await enqueueTally(tx, cid, rv.reversal.id);
        reversal = rv.reversal.voucher_no;
      } else await cancelVoucher(tx, actor(req), Number(v.id), `Realisation cancelled: ${reason}`);
    }
    await txExecute(tx, `UPDATE trx_receipt SET status = 'CANCELLED', cancel_reason = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`, [reason, req.user!.id, id]);
    await audit(req, 'trx_receipt', id, 'UPDATE', { status: r.status }, { action: 'CANCEL', reason, reversal }, tx);
    return { receipt_no: r.receipt_no, reversal };
  });
  await execute(`DELETE FROM acc_posting_issue WHERE company_id = ? AND event_code = 'REALISATION.POST' AND source_id = ?`, [cid, id]);
  res.json({ data: out, message: `${out.receipt_no} cancelled${out.reversal ? ` — voucher reversed by ${out.reversal}` : ''}` });
}));

// ================================================================ Tally
accountsRouter.get('/tally/companies', VIEW, ah(async (req, res) => {
  const rows = await query<any>(`SELECT id, tally_company_name, tally_company_guid, gstin, fy_code, connector, host, port, timeout_ms, is_active,
      secret_enc IS NOT NULL has_secret, last_health_at, last_health_ok, last_health_msg FROM acc_tally_company WHERE company_id = ? ORDER BY id`, [cidOf(req)]);
  res.json({ data: rows });
}));
const tallyCoSchema = z.object({
  tally_company_name: z.string().trim().min(2, 'Enter the company name exactly as in Tally').max(150),
  tally_company_guid: z.string().trim().max(80).optional().nullable(),
  gstin: z.string().trim().max(15).optional().nullable(),
  fy_code: z.string().trim().max(12).optional().nullable(),
  connector: z.enum(['XML_FILE', 'HTTP', 'API']).default('XML_FILE'),
  host: z.string().trim().max(200).optional().nullable(),
  port: z.coerce.number().int().min(1).max(65535).optional().nullable(),
  timeout_ms: z.coerce.number().int().min(2000).max(120000).optional(),
  secret: z.string().max(500).optional().nullable(),   // write-only; '' clears
  is_active: z.coerce.boolean().optional(),
});
async function writeTallyCo(req: Request, id: number | null) {
  const cid = cidOf(req);
  const b = parse(tallyCoSchema, req.body);
  if (b.connector === 'HTTP' && !b.host) throw BadRequest('Enter the Tally host / IP (and port, default 9000)');
  if (b.connector === 'API') throw BadRequest('The vendor API connector is added once the client confirms the Tally API — use XML file for now');
  const sec = b.secret === undefined ? undefined : (b.secret ? sealSecret(b.secret) : null);
  const same = await queryOne<any>(`SELECT id FROM acc_tally_company WHERE company_id = ? AND tally_company_name = ? AND id <> ?`, [cid, b.tally_company_name, id ?? 0]);
  if (same) throw Conflict(`A Tally company named "${b.tally_company_name}" is already set up — edit that one (Set-up tab) instead of adding it again`);
  if (id) {
    const cur = await queryOne<any>(`SELECT id FROM acc_tally_company WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!cur) throw NotFound('Tally company not found');
    await execute(`UPDATE acc_tally_company SET tally_company_name = ?, tally_company_guid = ?, gstin = ?, fy_code = ?, connector = ?, host = ?, port = ?,
        timeout_ms = COALESCE(?, timeout_ms), is_active = COALESCE(?, is_active), updated_by = ?${sec === undefined ? '' : ', secret_enc = ?'} WHERE id = ?`,
      [b.tally_company_name, b.tally_company_guid || null, b.gstin || null, b.fy_code || null, b.connector, b.host || null, b.port ?? null, b.timeout_ms ?? null,
        b.is_active === undefined ? null : (b.is_active ? 1 : 0), req.user!.id, ...(sec === undefined ? [] : [sec]), id]);
  } else {
    const r: any = await execute(`INSERT INTO acc_tally_company (company_id, tally_company_name, tally_company_guid, gstin, fy_code, connector, host, port, timeout_ms, secret_enc, is_active, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [cid, b.tally_company_name, b.tally_company_guid || null, b.gstin || null, b.fy_code || null, b.connector, b.host || null,
      b.port ?? null, b.timeout_ms ?? 20000, sec ?? null, b.is_active === false ? 0 : 1, req.user!.id]);
    id = Number(r.insertId);
  }
  const act = await query<any>(`SELECT fy_code FROM acc_tally_company WHERE company_id = ? AND is_active = 1`, [cid]);
  const keys = act.map((a) => a.fy_code || '*');
  if (new Set(keys).size !== keys.length) throw Conflict('Only one active Tally company per financial year (blank year = all years) — deactivate the other first');
  await audit(req, 'acc_tally_company', id, 'UPDATE', undefined, { ...b, secret: b.secret ? '(set)' : b.secret });
  return id;
}
accountsRouter.post('/tally/companies', ADMIN, ah(async (req, res) => {
  const id = await writeTallyCo(req, null);
  res.status(201).json({ data: { id }, message: 'Tally company saved' });
}));
accountsRouter.put('/tally/companies/:id', ADMIN, ah(async (req, res) => {
  const id = await writeTallyCo(req, idParam(req));
  res.json({ data: { id }, message: 'Tally company saved' });
}));
accountsRouter.post('/tally/companies/:id/test', TALLY, ah(async (req, res) => {
  res.json({ data: await healthCheck(cidOf(req), idParam(req)) });
}));
accountsRouter.post('/tally/enqueue-backlog', TALLY, ah(async (req, res) => {
  const n = await enqueueBacklog(cidOf(req));
  res.json({ data: { queued: n }, message: n ? `${n} posted voucher(s) queued for Tally` : 'Nothing to queue' });
}));

accountsRouter.get('/tally/queue', VIEW, ah(async (req, res) => {
  const cid = cidOf(req);
  const st = String(req.query.status ?? '');
  const rows = await query<any>(`SELECT q.id, q.status, q.attempts, q.last_error, q.last_error_code, q.tally_voucher_no, q.tally_voucher_id, q.posted_at, q.idempotency_key,
        q.next_retry_at, q.created_at, t.tally_company_name, t.connector, v.id voucher_id, v.voucher_no, v.type_code, DATE_FORMAT(v.voucher_date,'%Y-%m-%d') voucher_date,
        v.total_debit, v.source_no, pl.ledger_name party_name
       FROM acc_tally_queue q JOIN acc_tally_company t ON t.id = q.tally_company_id JOIN acc_voucher v ON v.id = q.voucher_id
       LEFT JOIN acc_ledger pl ON pl.id = v.party_ledger_id
      WHERE q.company_id = ? ${st ? 'AND q.status IN (?)' : ''} ORDER BY q.id DESC LIMIT 2000`, st ? [cid, st.split(',')] : [cid]);
  res.json({ data: rows });
}));
accountsRouter.get('/tally/queue/:id/logs', VIEW, ah(async (req, res) => {
  const q = await queryOne<any>(`SELECT id FROM acc_tally_queue WHERE id = ? AND company_id = ?`, [idParam(req), cidOf(req)]);
  if (!q) throw NotFound();
  res.json({ data: await query<any>(`SELECT l.id, l.action, l.outcome, l.http_status, l.duration_ms, l.message, l.created_at, u.full_name actor,
      LEFT(l.request_payload, 20000) request_payload, LEFT(l.response_payload, 20000) response_payload
      FROM acc_tally_log l LEFT JOIN mst_user u ON u.id = l.actor_id WHERE l.queue_id = ? ORDER BY l.id DESC`, [q.id]) });
}));

/** Download an XML file (ledgers + vouchers) for import in Tally; rows move to PROCESSING until marked posted. */
accountsRouter.post('/tally/export', TALLY, ah(async (req, res) => {
  const cid = cidOf(req);
  const ids = parse(z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(2000) }), req.body).ids;
  const out = await exportXml(cid, ids);
  await transaction(async (tx) => {
    for (const q of out.rows) {
      if (q.status === 'POSTED') continue;
      await txExecute(tx, `UPDATE acc_tally_queue SET status = 'PROCESSING', locked_at = NOW(), attempts = attempts + 1 WHERE id = ?`, [q.id]);
      await txExecute(tx, `UPDATE acc_voucher SET tally_status = 'PROCESSING' WHERE id = ?`, [q.voucher_id]);
      await txExecute(tx, `INSERT INTO acc_tally_log (queue_id, action, outcome, message, actor_id) VALUES (?, 'DOWNLOAD', 'PROCESSING', ?, ?)`,
        [q.id, `Exported in an XML file of ${out.count} voucher(s)`, req.user!.id]);
    }
  });
  const fname = `tally-${out.company.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.xml`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(out.xml);
}));

accountsRouter.post('/tally/mark-posted', TALLY, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(z.object({ items: z.array(z.object({ id: z.coerce.number().int().positive(), tally_voucher_no: z.string().trim().max(60).optional().nullable() })).min(1).max(2000) }), req.body);
  let n = 0;
  await transaction(async (tx) => {
    for (const it of b.items) {
      const q = await txQueryOne<any>(tx, `SELECT * FROM acc_tally_queue WHERE id = ? AND company_id = ? FOR UPDATE`, [it.id, cid]);
      if (!q || q.status === 'POSTED') continue;
      await txExecute(tx, `UPDATE acc_tally_queue SET status = 'POSTED', tally_voucher_no = ?, posted_at = NOW(), posted_by = ?, locked_at = NULL, last_error = NULL WHERE id = ?`,
        [it.tally_voucher_no || null, req.user!.id, q.id]);
      await txExecute(tx, `UPDATE acc_voucher SET tally_status = 'POSTED', tally_voucher_no = COALESCE(?, voucher_no) WHERE id = ?`, [it.tally_voucher_no || null, q.voucher_id]);
      await txExecute(tx, `INSERT INTO acc_tally_log (queue_id, action, outcome, message, actor_id) VALUES (?, 'MANUAL_POST', 'POSTED', ?, ?)`,
        [q.id, it.tally_voucher_no ? `Tally voucher ${it.tally_voucher_no}` : 'Imported in Tally', req.user!.id]);
      n += 1;
    }
  });
  scheduleBillSync(cid);
  res.json({ data: { posted: n }, message: `${n} voucher(s) marked posted in Tally` });
}));

accountsRouter.post('/tally/mark-failed', TALLY, ah(async (req, res) => {
  const cid = cidOf(req);
  const b = parse(z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(2000), reason: z.string().trim().min(3, 'Enter what Tally said').max(1000) }), req.body);
  await transaction(async (tx) => {
    for (const id of b.ids) {
      const q = await txQueryOne<any>(tx, `SELECT * FROM acc_tally_queue WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!q || q.status === 'POSTED') continue;
      await txExecute(tx, `UPDATE acc_tally_queue SET status = 'FAILED', last_error = ?, last_error_code = 'MANUAL', locked_at = NULL WHERE id = ?`, [b.reason, q.id]);
      await txExecute(tx, `UPDATE acc_voucher SET tally_status = 'FAILED' WHERE id = ?`, [q.voucher_id]);
      await txExecute(tx, `INSERT INTO acc_tally_log (queue_id, action, outcome, message, actor_id) VALUES (?, 'MARK_FAILED', 'FAILED', ?, ?)`, [q.id, b.reason, req.user!.id]);
    }
  });
  res.json({ data: { ok: true }, message: 'Marked failed — correct the ledger / mapping, then retry' });
}));

/** Retry: HTTP connector re-sends now (safe: same REMOTEID); XML file connector puts the row back to "waiting". */
accountsRouter.post('/tally/queue/:id/retry', TALLY, ah(async (req, res) => {
  const cid = cidOf(req); const id = idParam(req);
  const q = await queryOne<any>(`SELECT q.*, t.connector, (q.locked_at IS NOT NULL AND q.locked_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)) lock_fresh
      FROM acc_tally_queue q JOIN acc_tally_company t ON t.id = q.tally_company_id WHERE q.id = ? AND q.company_id = ?`, [id, cid]);
  if (!q) throw NotFound();
  if (q.status === 'POSTED') throw Conflict('Already posted in Tally — nothing to retry');
  if (q.status === 'PROCESSING' && q.connector === 'HTTP' && Number(q.lock_fresh)) throw Conflict('Being sent to Tally right now — wait a minute and refresh');
  if (q.connector === 'HTTP') {
    await execute(`UPDATE acc_tally_queue SET status = 'PENDING', locked_at = NULL WHERE id = ?`, [id]);
    const r = await submitQueueRow(cid, id, req.user!.id);
    return res.json({ data: r, message: r.skipped ? 'Already being sent' : r.outcome === 'POSTED' ? 'Posted in Tally' : r.outcome === 'WAITING' ? `Waiting for Tally: ${r.message}` : `Tally: ${r.message ?? r.outcome}` });
  }
  await execute(`UPDATE acc_tally_queue SET status = 'PENDING', locked_at = NULL WHERE id = ?`, [id]);
  await execute(`UPDATE acc_voucher SET tally_status = 'PENDING' WHERE id = ?`, [q.voucher_id]);
  await execute(`INSERT INTO acc_tally_log (queue_id, action, outcome, message, actor_id) VALUES (?, 'RETRY', 'PENDING', 'Back to waiting for export', ?)`, [id, req.user!.id]);
  res.json({ data: { ok: true }, message: 'Back in the export list' });
}));

