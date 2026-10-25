import { Router, type Request } from 'express';
import { z } from 'zod';
import XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { query, queryOne, execute, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { AppError, BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { s } from '../resources/schemas.js';
import {
  n, r2, r4, iso, todayIst, daysBetween, EVENT_TYPES, CASH_EVENTS, SCRIP_EVENTS, STATUS_META, OPEN_STATUSES, TRACKING_MODES, TRACKING_LABEL, CATEGORIES, CATEGORY_LABEL,
  SETTLEMENT_BASES, BASIS_LABEL, AGEING_BASES, AGEING_LABEL, POLICIES, POLICY_LABEL, setting, tolerance, schemeOut, snapshotOf, validateSchemeConfig, validateCustomValues,
  claimConfig, recalcClaim, ensureFresh, ensureSchemes, demand, can, createClaim, companySchemes, schemeByCode, deleteClaims, postedCount,
  type SchemeConfig,
} from './exportBenefitEngine.js';

/**
 * Export benefits workspace API (client voice note 24-Oct-2026: "we enter the shipping bill first; on the day each amount
 * arrives we pick the SB and record it — drawback one day, RoDTEP / RoSCTL later; and we must be able to add a new
 * claim type ourselves"). Specs v1 (receipt tracking) + v2 (configurable schemes; v2 wins where they differ).
 *
 * Mounted at the API root next to the shipping bill router. The /export-incentives/* endpoints of 23-Oct are kept as
 * adapters over the same engine (posting a "receipt" posts an event; deleting one reverses it).
 */
export const exportIncentiveRouter = Router();
const R = exportIncentiveRouter;
const VIEW = requireAny('FINANCE.VIEW', 'EXPORT.VIEW');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optDate = z.union([dateStr, z.literal(''), z.null()]).transform((v) => v || null).nullish();
const clean = (q: Record<string, unknown>) => Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v != null));
const parseJson = <T>(v: unknown, d: T): T => { if (v == null) return d; if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return d; } } return v as T; };
const statusOf = (k: string | null) => ({ status: k, status_label: STATUS_META[k ?? '']?.label ?? k ?? '—', status_tone: STATUS_META[k ?? '']?.tone ?? 'slate' });
const DOC_DIR = () => path.resolve(process.cwd(), 'uploads', 'export-benefits');

/* ================================================================ meta (labels and options come from here, not React) */
R.get('/export-benefits/meta', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  await ensureSchemes(cid);
  const schemes = await companySchemes(cid);
  res.json({ data: {
    event_types: Object.entries(EVENT_TYPES).map(([k, v]) => ({ value: k, label: v.label, kind: v.kind, modes: v.modes, needs_bank: !!v.bank, needs_scrip: !!v.scrip, needs_reason: !!v.reason, settles: !!v.settles })),
    statuses: Object.entries(STATUS_META).map(([k, v]) => ({ value: k, ...v, open: OPEN_STATUSES.includes(k) })),
    tracking_modes: TRACKING_MODES.map((k) => ({ value: k, label: TRACKING_LABEL[k] })),
    categories: CATEGORIES.map((k) => ({ value: k, label: CATEGORY_LABEL[k] })),
    settlement_bases: SETTLEMENT_BASES.map((k) => ({ value: k, label: BASIS_LABEL[k] })),
    ageing_bases: AGEING_BASES.map((k) => ({ value: k, label: AGEING_LABEL[k] })),
    policies: POLICIES.map((k) => ({ value: k, label: POLICY_LABEL[k] })),
    field_types: ['text', 'number', 'date', 'select', 'checkbox'],
    doc_stages: [{ value: 'CLAIM', label: 'On the claim' }, { value: 'RECEIPT', label: 'With a cash receipt' }, { value: 'SCRIP', label: 'With a scrip event' }, { value: 'SETTLEMENT', label: 'With any settling event' }],
    buckets: ['0-30', '31-60', '61-90', '90+'],
    settings: { dup_ref_policy: await setting(cid, 'EXPORT_BENEFIT_DUP_REF_POLICY', 'WARN'), tolerance: await tolerance(cid), base_currency: 'INR' },
    schemes: schemes.map((x) => ({ id: x.id, code: x.code, display_name: x.display_name, short_name: x.short_name, tracking_mode: x.tracking_mode, is_active: x.is_active,
      is_suggested: x.is_suggested, sb_field: x.sb_field, sort_order: x.sort_order, effective_from: x.effective_from, effective_to: x.effective_to, allow_multiple: x.allow_multiple,
      custom_fields: x.custom_fields, allowed_events: x.allowed_events, ageing_basis: x.ageing_basis, ageing_label: AGEING_LABEL[x.ageing_basis] })),
    rights: { post: can(req, 'FINANCE.UPDATE'), approve: can(req, 'EXPORT_BENEFIT.APPROVE'), admin: can(req, 'EXPORT_BENEFIT.ADMIN'), export: can(req, 'EXPORT.UPDATE'),
      draft: can(req, 'FINANCE.CREATE') || can(req, 'FINANCE.UPDATE') || can(req, 'EXPORT.UPDATE'), na: can(req, 'EXPORT.APPROVE') || can(req, 'EXPORT_BENEFIT.APPROVE') },
  } });
}));

/* ================================================================ scheme master */
const fieldSchema = z.object({
  key: z.string().trim().max(40), label: z.string().trim().max(80), type: z.enum(['text', 'number', 'date', 'select', 'checkbox']), required: z.boolean().optional().default(false),
  applies_to: z.enum(['CLAIM', 'EVENT']).default('EVENT'), options: z.array(z.string().trim().max(80)).max(50).optional(), min: z.coerce.number().nullish(), max: z.coerce.number().nullish(),
  max_length: z.coerce.number().int().min(1).max(500).nullish(), pattern: z.string().max(200).nullish(), event_types: z.array(z.string()).max(20).optional(), help: z.string().max(200).nullish(),
});
const docSchema = z.object({ doc_type: z.string().trim().toUpperCase().max(40), label: z.string().trim().max(80), stage: z.enum(['CLAIM', 'RECEIPT', 'SCRIP', 'SETTLEMENT']),
  policy: z.enum(['WARN', 'BLOCK']).default('WARN'), event_types: z.array(z.string()).max(20).optional() });
const schemeSchema = z.object({
  code: z.string().trim().toUpperCase().min(2).max(40), display_name: z.string().trim().min(1, 'Display name is required').max(120), short_name: s.nullableStr(30),
  description: s.nullableStr(1000), category: z.enum(CATEGORIES).default('OTHER'), tracking_mode: z.enum(TRACKING_MODES), default_currency: z.string().trim().toUpperCase().length(3).default('INR'),
  effective_from: optDate, effective_to: optDate, default_status: z.enum(['ENTERED', 'FILED', 'QUERY']).default('ENTERED'),
  allowed_events: z.array(z.string().trim().toUpperCase()).max(20).default([]), required_documents: z.array(docSchema).max(20).default([]), custom_fields: z.array(fieldSchema).max(30).default([]),
  settlement_basis: z.enum(SETTLEMENT_BASES).default('DECLARED'), ageing_basis: z.enum(AGEING_BASES).default('SB_DATE'), profitability_policy: z.enum(POLICIES).default('EXCLUDE'),
  ledger_account_id: s.id(), is_suggested: z.coerce.boolean().default(false), allow_multiple: z.coerce.boolean().default(false), sort_order: z.coerce.number().int().min(0).max(9999).default(100),
  is_active: z.coerce.boolean().default(false),
  reason: s.nullableStr(500), confirm_mode_change: z.boolean().optional(),
});
type SchemeIn = z.infer<typeof schemeSchema>;
const toConfig = (b: SchemeIn, base: Partial<SchemeConfig> = {}): Partial<SchemeConfig> => ({
  ...base, code: b.code, display_name: b.display_name, short_name: b.short_name ?? null, description: b.description ?? null, category: b.category, tracking_mode: b.tracking_mode,
  default_currency: b.default_currency, effective_from: b.effective_from ?? null, effective_to: b.effective_to ?? null, default_status: b.default_status,
  allowed_events: [...new Set(b.allowed_events)], required_documents: b.required_documents as any, custom_fields: b.custom_fields.map((f) => ({ ...f, options: f.type === 'select' ? f.options ?? [] : undefined })) as any,
  settlement_basis: b.settlement_basis, ageing_basis: b.ageing_basis, profitability_policy: b.profitability_policy, ledger_account_id: b.ledger_account_id ?? null,
  is_suggested: b.is_suggested ? 1 : 0, allow_multiple: b.allow_multiple ? 1 : 0, sort_order: b.sort_order, is_active: b.is_active ? 1 : 0,
});
async function schemeUsage(schemeId: number, tx?: Tx) {
  const sql = `SELECT COUNT(*) claims, SUM(benefit_status IN (${OPEN_STATUSES.map(() => '?').join(',')})) open_claims,
      (SELECT COUNT(*) FROM trx_export_benefit_event e JOIN trx_export_incentive y ON y.id = e.claim_id WHERE y.scheme_id = ?) events
     FROM trx_export_incentive WHERE scheme_id = ?`;
  const p = [...OPEN_STATUSES, schemeId, schemeId];
  const r = tx ? await txQueryOne<any>(tx, sql, p) : await queryOne<any>(sql, p);
  return { claims: n(r?.claims), open_claims: n(r?.open_claims), events: n(r?.events) };
}
async function logScheme(tx: Tx, req: Request, sc: SchemeConfig, change: string, reason: string | null, old: SchemeConfig | null) {
  await txExecute(tx, `INSERT INTO log_export_benefit_scheme (company_id, scheme_id, config_version, change_type, snapshot, old_snapshot, reason, changed_by) VALUES (?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, sc.id, sc.config_version, change, JSON.stringify(snapshotOf(sc)), old ? JSON.stringify(snapshotOf(old)) : null, reason, req.user!.id]);
}
const SCHEME_COLS = ['code', 'display_name', 'short_name', 'description', 'category', 'tracking_mode', 'default_currency', 'effective_from', 'effective_to', 'default_status',
  'allowed_events', 'required_documents', 'custom_fields', 'settlement_basis', 'ageing_basis', 'profitability_policy', 'ledger_account_id', 'is_suggested', 'allow_multiple', 'sort_order', 'is_active'] as const;
const colVal = (c: Partial<SchemeConfig>, k: string) => (['allowed_events', 'required_documents', 'custom_fields'].includes(k) ? JSON.stringify((c as any)[k] ?? []) : (c as any)[k] ?? null);
async function loadScheme(cid: number, id: number, tx?: Tx) {
  const sql = `SELECT * FROM mst_export_benefit_scheme WHERE id = ? AND company_id = ?${tx ? ' FOR UPDATE' : ''}`;
  const r = tx ? await txQueryOne<any>(tx, sql, [id, cid]) : await queryOne<any>(sql, [id, cid]);
  if (!r) throw NotFound('Benefit scheme not found');
  return schemeOut(r);
}

R.get('/export-benefits/schemes', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  await ensureSchemes(cid);
  const rows = await query<any>(`SELECT s.*, (SELECT COUNT(*) FROM trx_export_incentive x WHERE x.scheme_id = s.id) AS claims,
      (SELECT COUNT(*) FROM trx_export_incentive x WHERE x.scheme_id = s.id AND x.pending_amount > 0) AS open_claims, u.full_name AS updated_by_name
     FROM mst_export_benefit_scheme s LEFT JOIN mst_user u ON u.id = COALESCE(s.updated_by, s.created_by) WHERE s.company_id = ? ORDER BY s.is_active DESC, s.sort_order, s.id`, [cid]);
  res.json({ data: rows.map((r) => { const c = schemeOut(r); return { ...c, claims: n(r.claims), open_claims: n(r.open_claims), is_used: n(r.claims) > 0, updated_by_name: r.updated_by_name,
    updated_at: r.updated_at ?? r.created_at, mode_label: TRACKING_LABEL[c.tracking_mode], ageing_label: AGEING_LABEL[c.ageing_basis], policy_label: POLICY_LABEL[c.profitability_policy],
    readiness: validateSchemeConfig(c) }; }) });
}));

R.get('/export-benefits/schemes/:id', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sc = await loadScheme(cid, Number(req.params.id));
  const hist = await query<any>(`SELECT l.id, l.config_version, l.change_type, l.snapshot, l.old_snapshot, l.reason, l.changed_at, u.full_name AS changed_by_name
      FROM log_export_benefit_scheme l LEFT JOIN mst_user u ON u.id = l.changed_by WHERE l.scheme_id = ? ORDER BY l.id DESC`, [sc.id]);
  res.json({ data: { ...sc, usage: await schemeUsage(sc.id), readiness: validateSchemeConfig(sc),
    history: hist.map((h) => ({ ...h, snapshot: parseJson(h.snapshot, {}), old_snapshot: parseJson(h.old_snapshot, null) })) } });
}));

/** POST /export-benefits/schemes/validate — the config builder's live check (nothing saved). */
R.post('/export-benefits/schemes/validate', VIEW, ah(async (req, res) => {
  const b = schemeSchema.parse(req.body ?? {});
  res.json({ data: { errors: validateSchemeConfig(toConfig(b)) } });
}));

R.post('/export-benefits/schemes', ah(async (req, res) => {
  await demand(req, ['EXPORT_BENEFIT.ADMIN'], 'add an export benefit scheme');
  const cid = req.user!.companyId;
  const b = schemeSchema.parse(req.body ?? {});
  const cfg = toConfig(b);
  const errs = validateSchemeConfig(cfg);
  if (b.is_active && errs.length) throw BadRequest(`The scheme cannot be active yet — ${errs[0].message}`, errs);
  if (errs.some((e) => e.field === 'code')) throw BadRequest(errs.find((e) => e.field === 'code')!.message, errs.filter((e) => e.field === 'code'));
  const id = await transaction(async (tx) => {
    if (await txQueryOne(tx, `SELECT id FROM mst_export_benefit_scheme WHERE company_id = ? AND code = ?`, [cid, b.code])) throw Conflict(`Scheme code ${b.code} already exists (codes are never reused)`);
    const r = await txExecute(tx, `INSERT INTO mst_export_benefit_scheme (company_id, ${SCHEME_COLS.join(', ')}, config_version, created_by) VALUES (?, ${SCHEME_COLS.map(() => '?').join(',')}, 1, ?)`,
      [cid, ...SCHEME_COLS.map((k) => colVal(cfg, k)), req.user!.id]);
    const sc = await loadScheme(cid, Number(r.insertId), tx);
    await logScheme(tx, req, sc, 'CREATE', b.reason ?? null, null);
    return sc.id;
  });
  await audit(req, 'mst_export_benefit_scheme', id, 'INSERT', undefined, b);
  res.status(201).json({ data: await loadScheme(cid, id) });
}));

/** What changing the tracking mode would affect (spec v2 AT-06: impact preview). */
async function modeImpact(sc: SchemeConfig, mode: string) {
  const u = await schemeUsage(sc.id);
  const evs = await query<any>(`SELECT e.event_type, COUNT(*) c FROM trx_export_benefit_event e JOIN trx_export_incentive x ON x.id = e.claim_id
     WHERE x.scheme_id = ? AND e.status <> 'DRAFT' GROUP BY e.event_type`, [sc.id]);
  const incompatible = evs.filter((e) => EVENT_TYPES[e.event_type] && !EVENT_TYPES[e.event_type].modes.includes(mode as any)).map((e) => ({ event_type: e.event_type, label: EVENT_TYPES[e.event_type].label, count: n(e.c) }));
  return { ...u, from: sc.tracking_mode, to: mode, incompatible_events: incompatible,
    note: 'Existing claims keep the configuration version they were created with (their mode and events stay as they are); only new claims use the new mode.' };
}
R.get('/export-benefits/schemes/:id/impact', VIEW, ah(async (req, res) => {
  const sc = await loadScheme(req.user!.companyId, Number(req.params.id));
  const mode = z.enum(TRACKING_MODES).parse(req.query.tracking_mode);
  res.json({ data: await modeImpact(sc, mode) });
}));

/** PUT — versioned update. Once used: code fixed, a reason is required, a tracking-mode change needs approval + confirmation. */
R.put('/export-benefits/schemes/:id', ah(async (req, res) => {
  await demand(req, ['EXPORT_BENEFIT.ADMIN'], 'change an export benefit scheme');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = schemeSchema.parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const old = await loadScheme(cid, id, tx);
    const used = (await schemeUsage(id, tx)).claims > 0;
    const cfg = toConfig(b, old);
    if (used && b.code !== old.code) throw BadRequest(`The code ${old.code} is in use and cannot change`, [{ field: 'code', message: 'Immutable after use' }]);
    if (!used && b.code !== old.code && await txQueryOne(tx, `SELECT id FROM mst_export_benefit_scheme WHERE company_id = ? AND code = ? AND id <> ?`, [cid, b.code, id])) throw Conflict(`Scheme code ${b.code} already exists`);
    const changed = SCHEME_COLS.filter((k) => JSON.stringify(colVal(cfg, k)) !== JSON.stringify(colVal(old, k)));
    if (!changed.length) return { sc: old, changed };
    if (used && (b.reason ?? '').length < 3) throw BadRequest('The scheme is in use — give the reason for the change', [{ field: 'reason', message: 'Required' }]);
    const modeChange = used && b.tracking_mode !== old.tracking_mode;
    if (modeChange) {
      await demand(req, ['EXPORT_BENEFIT.APPROVE'], 'change the tracking mode of a scheme in use');
      if (!b.confirm_mode_change) throw new AppError(409, `Changing ${old.display_name} from ${TRACKING_LABEL[old.tracking_mode]} to ${TRACKING_LABEL[b.tracking_mode]} — review the impact and confirm`, 'CONFIRM_MODE_CHANGE', await modeImpact(old, b.tracking_mode));
    }
    const errs = validateSchemeConfig(cfg);
    if (cfg.is_active && errs.length) throw BadRequest(`The scheme cannot be active with this configuration — ${errs[0].message}`, errs);
    if (cfg.sb_field && b.tracking_mode !== old.tracking_mode && !used) { /* allowed: no history yet */ }
    await txExecute(tx, `UPDATE mst_export_benefit_scheme SET ${SCHEME_COLS.map((k) => `${k} = ?`).join(', ')}, config_version = config_version + 1, updated_by = ? WHERE id = ?`,
      [...SCHEME_COLS.map((k) => colVal(cfg, k)), req.user!.id, id]);
    const sc = await loadScheme(cid, id, tx);
    await logScheme(tx, req, sc, modeChange ? 'MODE_CHANGE' : 'UPDATE', b.reason ?? null, old);
    await audit(req, 'mst_export_benefit_scheme', id, 'UPDATE', snapshotOf(old), { ...snapshotOf(sc), reason: b.reason }, tx);
    return { sc, changed };
  });
  res.json({ data: { ...out.sc, changed: out.changed } });
}));

R.post('/export-benefits/schemes/:id/activate', ah(async (req, res) => {
  await demand(req, ['EXPORT_BENEFIT.ADMIN'], 'activate an export benefit scheme');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const reason = z.object({ reason: s.nullableStr(500) }).parse(req.body ?? {}).reason ?? null;
  const sc = await transaction(async (tx) => {
    const cur = await loadScheme(cid, id, tx);
    if (cur.is_active) return cur;
    const errs = validateSchemeConfig(cur);
    if (errs.length) throw BadRequest(`Complete the scheme before activating it — ${errs.map((e) => e.message).join('; ')}`, errs);
    await txExecute(tx, `UPDATE mst_export_benefit_scheme SET is_active = 1, updated_by = ? WHERE id = ?`, [req.user!.id, id]);
    const sc2 = await loadScheme(cid, id, tx);
    await logScheme(tx, req, sc2, 'ACTIVATE', reason, cur);
    return sc2;
  });
  await audit(req, 'mst_export_benefit_scheme', id, 'UPDATE', { is_active: 0 }, { is_active: 1, reason });
  res.json({ data: sc });
}));

R.post('/export-benefits/schemes/:id/deactivate', ah(async (req, res) => {
  await demand(req, ['EXPORT_BENEFIT.ADMIN'], 'deactivate an export benefit scheme');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const reason = z.object({ reason: z.string().trim().min(3, 'Give the reason').max(500) }).parse(req.body ?? {}).reason;
  const sc = await transaction(async (tx) => {
    const cur = await loadScheme(cid, id, tx);
    if (!cur.is_active) return cur;
    await txExecute(tx, `UPDATE mst_export_benefit_scheme SET is_active = 0, updated_by = ? WHERE id = ?`, [req.user!.id, id]);
    const sc2 = await loadScheme(cid, id, tx);
    await logScheme(tx, req, sc2, 'DEACTIVATE', reason, cur);
    return sc2;
  });
  await audit(req, 'mst_export_benefit_scheme', id, 'UPDATE', { is_active: 1 }, { is_active: 0, reason });
  res.json({ data: { ...sc, usage: await schemeUsage(id) } });
}));

R.delete('/export-benefits/schemes/:id', ah(async (req, res) => {
  await demand(req, ['EXPORT_BENEFIT.ADMIN'], 'delete an export benefit scheme');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const sc = await loadScheme(cid, id);
  if ((await schemeUsage(id)).claims) throw BadRequest(`${sc.display_name} has claims — it can only be deactivated (history stays)`);
  await transaction(async (tx) => {
    await txExecute(tx, `DELETE FROM log_export_benefit_scheme WHERE scheme_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM mst_export_benefit_scheme WHERE id = ?`, [id]);
  });
  await audit(req, 'mst_export_benefit_scheme', id, 'DELETE', snapshotOf(sc));
  res.json({ data: { id, deleted: true } });
}));

/* ================================================================ register (one row per shipping bill + scheme) */
const regFilter = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(1000).default(25),
  sort: z.enum(['sb_date', 'sb_no', 'scheme', 'declared', 'basis', 'cash', 'scrip_available', 'pending', 'excess', 'last_event', 'days', 'status']).default('sb_date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().trim().max(60).optional(), scheme_id: z.string().regex(/^[\d,]+$/).optional(), scheme: z.string().trim().max(200).optional(),
  status: z.string().trim().max(300).optional(), stage: z.string().trim().max(20).optional(), mode: z.enum(TRACKING_MODES).optional(),
  from: dateStr.optional(), to: dateStr.optional(), pending: z.coerce.number().int().optional(), bucket: z.enum(['0-30', '31-60', '61-90', '90+']).optional(),
  event_kind: z.enum(['CASH', 'RECEIPT', 'PROCEEDS', 'SCRIP_ISSUE', 'SCRIP_ANY', 'ANY']).optional(), event_from: dateStr.optional(), event_to: dateStr.optional(),
  sb_id: z.coerce.number().int().optional(), applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']).optional(), excess: z.coerce.number().int().optional(),
  followup: z.enum(['OPEN', 'OVERDUE']).optional(), as_of: dateStr.optional(), so_id: z.coerce.number().int().optional(),
});
type RegQ = z.infer<typeof regFilter>;
const EVENT_KIND_TYPES: Record<string, string[]> = { CASH: ['BANK_RECEIPT', 'REFUND_CREDIT', 'SALE_PROCEEDS'], RECEIPT: ['BANK_RECEIPT', 'REFUND_CREDIT'], PROCEEDS: ['SALE_PROCEEDS'],
  SCRIP_ISSUE: ['SCRIP_ISSUE'], SCRIP_ANY: SCRIP_EVENTS, ANY: Object.keys(EVENT_TYPES).filter((k) => k !== 'REVERSAL') };
const CLAIM_FROM = `FROM trx_export_incentive x JOIN mst_export_benefit_scheme s ON s.id = x.scheme_id
    LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id
    LEFT JOIN trx_commercial_invoice ci ON ci.id = COALESCE(x.invoice_id, sb.invoice_id)
    LEFT JOIN trx_sales_order so ON so.id = ci.so_id LEFT JOIN mst_party b ON b.id = ci.buyer_id`;
const daysExpr = (asOf: string) => `IF(x.pending_amount > 0 AND x.ageing_date IS NOT NULL, GREATEST(0, DATEDIFF('${asOf}', x.ageing_date)), NULL)`;
const CLAIM_COLS = (asOf: string) => `x.id, x.incentive_type, x.scheme_id, x.shipping_bill_id, x.invoice_id, x.declared_amount, x.claimed_amount, x.approved_amount, x.claim_filed_date, x.approved_date,
    x.approval_ref, x.currency_code, x.applicability, x.not_applicable_reason, x.claim_stage, x.benefit_status, x.basis_amount, x.basis_source, x.cash_received, x.sale_proceeds,
    x.adjusted_amount, x.scrip_issued, x.scrip_available, x.scrip_utilised, x.scrip_sold, x.scrip_expired, x.pending_amount, x.excess_amount, x.last_event_date, x.ageing_date,
    x.custom_field_values, x.remarks, x.source, x.closed_reason, x.claim_date, x.scheme_config_version, x.row_version, x.scrip_no, x.created_at,
    s.code AS scheme_code, s.display_name AS scheme_name, s.short_name, s.tracking_mode, s.ageing_basis, s.settlement_basis, s.profitability_policy, s.is_active AS scheme_active, s.sort_order,
    sb.sb_no, sb.sb_date, sb.port_code, ci.invoice_no, so.so_no, so.id AS so_id, b.party_name AS buyer_name, ${daysExpr(asOf)} AS days_pending,
    (SELECT COUNT(*) FROM trx_export_benefit_event e WHERE e.claim_id = x.id AND e.status <> 'DRAFT' AND e.event_type <> 'REVERSAL') AS events_count,
    (SELECT COUNT(*) FROM trx_export_benefit_event e WHERE e.claim_id = x.id AND e.status = 'DRAFT') AS drafts_count,
    (SELECT COUNT(*) FROM trx_export_benefit_followup f WHERE f.claim_id = x.id AND f.status = 'OPEN') AS open_followups`;
const NUMS = ['declared_amount', 'claimed_amount', 'approved_amount', 'basis_amount', 'cash_received', 'sale_proceeds', 'adjusted_amount', 'scrip_issued', 'scrip_available', 'scrip_utilised',
  'scrip_sold', 'scrip_expired', 'pending_amount', 'excess_amount'];
function claimOut(r: any) {
  const o: any = { ...r, ...statusOf(r.benefit_status), sb_date: iso(r.sb_date), claim_date: iso(r.claim_date), claim_filed_date: iso(r.claim_filed_date), approved_date: iso(r.approved_date),
    last_event_date: iso(r.last_event_date), ageing_date: iso(r.ageing_date), custom_field_values: parseJson(r.custom_field_values, null),
    mode_label: TRACKING_LABEL[r.tracking_mode] ?? r.tracking_mode, ageing_label: AGEING_LABEL[r.ageing_basis] ?? r.ageing_basis, basis_label: BASIS_LABEL[r.basis_source] ?? (r.basis_source ? r.basis_source : 'Not known yet'),
    days_pending: r.days_pending == null ? null : Number(r.days_pending), events_count: n(r.events_count), drafts_count: n(r.drafts_count), open_followups: n(r.open_followups),
    scrip_capable: r.tracking_mode !== 'CASH', scheme_active: Number(r.scheme_active) };
  for (const k of NUMS) o[k] = r[k] == null ? null : r4(n(r[k]));
  o.net_cash = r4(n(r.cash_received) + n(r.sale_proceeds));
  return o;
}
function regWhere(cid: number, q: RegQ) {
  const asOf = q.as_of ?? todayIst();
  const w = ['x.company_id = ?']; const p: unknown[] = [cid];
  if (q.q) { w.push(`(sb.sb_no LIKE ? OR ci.invoice_no LIKE ? OR so.so_no LIKE ? OR b.party_name LIKE ? OR x.scrip_no LIKE ? OR s.display_name LIKE ?
      OR EXISTS (SELECT 1 FROM trx_export_benefit_event e WHERE e.claim_id = x.id AND (e.bank_reference LIKE ? OR e.scrip_number LIKE ?)))`); p.push(...Array(8).fill(`%${q.q}%`)); }
  if (q.scheme_id) { w.push('x.scheme_id IN (?)'); p.push(q.scheme_id.split(',').filter(Boolean).map(Number)); }
  if (q.scheme) { w.push('s.code IN (?)'); p.push(q.scheme.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)); }
  if (q.status) {
    const st = q.status.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    const list = st.flatMap((x) => (x === 'OPEN' ? OPEN_STATUSES : [x]));
    w.push('x.benefit_status IN (?)'); p.push(list);
  }
  if (q.stage) { w.push('x.claim_stage = ?'); p.push(q.stage); }
  if (q.mode) { w.push('s.tracking_mode = ?'); p.push(q.mode); }
  if (q.from) { w.push('COALESCE(sb.sb_date, x.claim_date) >= ?'); p.push(q.from); }
  if (q.to) { w.push('COALESCE(sb.sb_date, x.claim_date) <= ?'); p.push(q.to); }
  if (q.pending) w.push('x.pending_amount > 0');
  if (q.excess) w.push('x.excess_amount > 0');
  if (q.sb_id) { w.push('x.shipping_bill_id = ?'); p.push(q.sb_id); }
  if (q.so_id) { w.push('so.id = ?'); p.push(q.so_id); }
  if (q.applicability) { w.push('x.applicability = ?'); p.push(q.applicability); }
  if (q.bucket) {
    const d = daysExpr(asOf);
    const [lo, hi] = q.bucket === '90+' ? [91, 1000000] : q.bucket.split('-').map(Number);
    w.push(`(${d} BETWEEN ${lo} AND ${hi})`);
  }
  if (q.event_kind || q.event_from || q.event_to) {
    const types = EVENT_KIND_TYPES[q.event_kind ?? 'ANY'];
    const ew = ['e.claim_id = x.id', `e.status = 'POSTED'`, 'e.event_type IN (?)']; const ep: unknown[] = [types];
    if (q.event_from) { ew.push('e.event_date >= ?'); ep.push(q.event_from); }
    if (q.event_to) { ew.push('e.event_date <= ?'); ep.push(q.event_to); }
    w.push(`EXISTS (SELECT 1 FROM trx_export_benefit_event e WHERE ${ew.join(' AND ')})`); p.push(...ep);
  }
  if (q.followup) w.push(`EXISTS (SELECT 1 FROM trx_export_benefit_followup f WHERE f.claim_id = x.id AND f.status = 'OPEN'${q.followup === 'OVERDUE' ? ` AND f.due_date < '${asOf}'` : ''})`);
  return { where: w.join(' AND '), params: p, asOf };
}
const SORTS: Record<string, string> = { sb_date: 'COALESCE(sb.sb_date, x.claim_date)', sb_no: 'sb.sb_no', scheme: 's.sort_order', declared: 'x.declared_amount', basis: 'x.basis_amount',
  cash: '(x.cash_received + x.sale_proceeds)', scrip_available: 'x.scrip_available', pending: 'x.pending_amount', excess: 'x.excess_amount', last_event: 'x.last_event_date', days: 'days_pending', status: 'x.benefit_status' };

export async function register(cid: number, q: RegQ) {
  await ensureFresh(cid);
  const { where, params, asOf } = regWhere(cid, q);
  const order = `${SORTS[q.sort]} ${q.dir === 'asc' ? 'ASC' : 'DESC'}, COALESCE(sb.sb_date, x.claim_date) DESC, x.shipping_bill_id DESC, s.sort_order, x.id`;
  const [rows, tot, by] = await Promise.all([
    query<any>(`SELECT ${CLAIM_COLS(asOf)} ${CLAIM_FROM} WHERE ${where} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, params),
    queryOne<any>(`SELECT COUNT(*) c ${CLAIM_FROM} WHERE ${where}`, params),
    query<any>(`SELECT s.id AS scheme_id, s.code, s.display_name, s.short_name, s.tracking_mode, s.ageing_basis, COUNT(*) AS claims, SUM(x.pending_amount > 0) AS open_claims,
        SUM(COALESCE(x.declared_amount, 0)) declared, SUM(COALESCE(x.basis_amount, 0)) basis, SUM(x.cash_received) cash, SUM(x.sale_proceeds) proceeds, SUM(x.adjusted_amount) adjusted,
        SUM(x.scrip_issued) scrip_issued, SUM(x.scrip_available) scrip_available, SUM(x.scrip_utilised) scrip_utilised, SUM(x.scrip_sold) scrip_sold,
        SUM(x.pending_amount) pending, SUM(x.excess_amount) excess
       ${CLAIM_FROM} WHERE ${where} GROUP BY s.id ORDER BY s.sort_order, s.id`, params),
  ]);
  const byScheme = by.map((r) => ({ ...r, scheme_id: Number(r.scheme_id), claims: n(r.claims), open_claims: n(r.open_claims), mode_label: TRACKING_LABEL[r.tracking_mode], ageing_label: AGEING_LABEL[r.ageing_basis],
    ...Object.fromEntries(['declared', 'basis', 'cash', 'proceeds', 'adjusted', 'scrip_issued', 'scrip_available', 'scrip_utilised', 'scrip_sold', 'pending', 'excess'].map((k) => [k, r2(n(r[k]))])) }));
  const sum = (k: string) => r2(byScheme.reduce((t, r: any) => t + r[k], 0));
  const total = n(tot?.c);
  return { rows: rows.map(claimOut), pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) },
    totals: { claims: total, declared: sum('declared'), basis: sum('basis'), cash: sum('cash'), proceeds: sum('proceeds'), adjusted: sum('adjusted'), scrip_issued: sum('scrip_issued'),
      scrip_available: sum('scrip_available'), pending: sum('pending'), excess: sum('excess'), by_scheme: byScheme }, as_of: asOf };
}

R.get('/export-benefits/claims', VIEW, ah(async (req, res) => {
  const q = regFilter.parse(clean(req.query as any));
  const out = await register(req.user!.companyId, q);
  if (req.query.format === 'xlsx') {
    const all = await register(req.user!.companyId, { ...q, page: 1, pageSize: 1000 });
    const head = ['SB No', 'SB Date', 'Invoice', 'Order', 'Buyer', 'Benefit', 'Mode', 'Declared', 'Claimed', 'Approved', 'Basis', 'Cash received', 'Sale proceeds', 'Adjusted',
      'Scrip issued', 'Scrip available', 'Scrip utilised', 'Scrip sold / out', 'Pending', 'Excess', 'Last event', 'Days pending', 'Ageing basis', 'Status'];
    const aoa: unknown[][] = [[`EXPORT BENEFIT REGISTER (as on ${out.as_of})`], [], head];
    for (const r of all.rows) aoa.push([r.sb_no, r.sb_date, r.invoice_no, r.so_no, r.buyer_name, r.scheme_name, r.mode_label, r.declared_amount, r.claimed_amount, r.approved_amount, r.basis_amount,
      r.cash_received, r.sale_proceeds, r.adjusted_amount, r.scrip_issued, r.scrip_available, r.scrip_utilised, r.scrip_sold, r.pending_amount, r.excess_amount, r.last_event_date, r.days_pending, r.ageing_label, r.status_label]);
    return sendXlsx(res, aoa, 'Register', `export_benefit_register_${out.as_of}.xlsx`, head.length);
  }
  res.json({ data: out.rows, pagination: out.pagination, totals: out.totals, as_of: out.as_of });
}));

function sendXlsx(res: any, aoa: unknown[][], sheet: string, file: string, cols: number) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = Array.from({ length: cols }, (_, i) => ({ wch: i < 6 ? 14 : 12 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/* ================================================================ claim detail + timeline */
async function lockClaim(tx: Tx, cid: number, id: number) {
  const x = await txQueryOne<any>(tx, `SELECT x.*, sb.sb_date, sb.sb_no FROM trx_export_incentive x LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id WHERE x.id = ? AND x.company_id = ? FOR UPDATE`, [id, cid]);
  if (!x) throw NotFound('Benefit claim not found');
  if (!x.scheme_id) throw BadRequest('This claim has no scheme yet — open the register once to update it');
  return x;
}

export async function claimDetail(cid: number, id: number) {
  await ensureFresh(cid);
  const asOf = todayIst();
  const x = await queryOne<any>(`SELECT ${CLAIM_COLS(asOf)} ${CLAIM_FROM} WHERE x.id = ? AND x.company_id = ?`, [id, cid]);
  if (!x) throw NotFound('Benefit claim not found');
  const cfg = await claimConfig(Number(x.scheme_id), x.scheme_config_version == null ? null : Number(x.scheme_config_version));
  const [evs, docs, fups, hist, aud] = await Promise.all([
    query<any>(`SELECT e.*, cu.full_name AS created_by_name, pu.full_name AS posted_by_name, ba.account_label AS bank_label,
        (SELECT COALESCE(SUM(m.matched_amount), 0) FROM trx_export_benefit_recon_match m WHERE m.event_id = e.id AND m.status = 'ACTIVE') AS matched_amount
       FROM trx_export_benefit_event e LEFT JOIN mst_user cu ON cu.id = e.created_by LEFT JOIN mst_user pu ON pu.id = e.posted_by
       LEFT JOIN mst_company_bank_account ba ON ba.id = e.bank_account_id WHERE e.claim_id = ? ORDER BY e.event_date, e.id`, [id]),
    query<any>(`SELECT d.id, d.event_id, d.doc_type, d.original_name, d.mime_type, d.size_bytes, d.uploaded_at, u.full_name AS uploaded_by_name
       FROM trx_export_benefit_document d LEFT JOIN mst_user u ON u.id = d.uploaded_by WHERE d.claim_id = ? AND d.is_deleted = 0 ORDER BY d.id`, [id]),
    query<any>(`SELECT f.*, o.full_name AS owner_name, c.full_name AS created_by_name FROM trx_export_benefit_followup f
       LEFT JOIN mst_user o ON o.id = f.owner_user_id LEFT JOIN mst_user c ON c.id = f.created_by WHERE f.claim_id = ? ORDER BY f.status = 'DONE', f.due_date, f.id`, [id]),
    query<any>(`SELECT h.*, u.full_name AS changed_by_name FROM log_export_benefit_status h LEFT JOIN mst_user u ON u.id = h.changed_by WHERE h.claim_id = ? ORDER BY h.id`, [id]),
    query<any>(`SELECT a.id, a.table_name, a.record_id, a.action, a.old_values, a.new_values, a.changed_at, u.full_name AS changed_by_name FROM log_audit a LEFT JOIN mst_user u ON u.id = a.changed_by
       WHERE (a.table_name = 'trx_export_incentive' AND a.record_id = ?) OR (a.table_name = 'trx_export_benefit_event' AND a.record_id IN (SELECT id FROM trx_export_benefit_event WHERE claim_id = ?))
          OR (a.table_name = 'trx_export_benefit_document' AND a.record_id IN (SELECT id FROM trx_export_benefit_document WHERE claim_id = ?)) ORDER BY a.id DESC LIMIT 200`, [id, id, id]),
  ]);
  const events = evs.map((e) => ({ ...e, event_date: iso(e.event_date), rate_date: iso(e.rate_date), amount: r4(n(e.amount)), base_amount: r4(n(e.base_amount)), exchange_rate: n(e.exchange_rate),
    matched_amount: r4(n(e.matched_amount)), custom_field_values: parseJson(e.custom_field_values, null), label: EVENT_TYPES[e.event_type]?.label ?? e.event_type,
    kind: EVENT_TYPES[e.event_type]?.kind ?? null, is_cash: CASH_EVENTS.includes(e.event_type), documents: docs.filter((d) => Number(d.event_id) === Number(e.id)) }));
  return { ...claimOut(x), config: { id: cfg.id, code: cfg.code, display_name: cfg.display_name, version: cfg.config_version, tracking_mode: cfg.tracking_mode, allowed_events: cfg.allowed_events,
      custom_fields: cfg.custom_fields, required_documents: cfg.required_documents, settlement_basis: cfg.settlement_basis, ageing_basis: cfg.ageing_basis, is_active: cfg.is_active },
    events, documents: docs.filter((d) => !d.event_id), all_documents: docs, followups: fups.map((f) => ({ ...f, due_date: iso(f.due_date), overdue: f.status === 'OPEN' && f.due_date && iso(f.due_date)! < asOf })),
    status_history: hist, audit: aud.map((a) => ({ ...a, old_values: parseJson(a.old_values, null), new_values: parseJson(a.new_values, null) })),
    // the 23-Oct shape (tracker / SB screen / tests): what was received or issued, each on its own date
    label: x.scheme_name, claim_amount: n(x.declared_amount), received_amount: r2(n(x.cash_received) + n(x.sale_proceeds) + n(x.adjusted_amount)), outstanding: r2(n(x.pending_amount)),
    credit_date: events.filter((e) => e.status === 'POSTED' && (e.is_cash || e.event_type === 'ADJUSTMENT')).map((e) => e.event_date).pop() ?? null,
    receipts: events.filter((e) => e.status === 'POSTED' && !['CLAIM_FILED', 'APPROVAL', 'REVERSAL'].includes(e.event_type))
      .map((e) => ({ id: e.id, receipt_date: e.event_date, amount: e.base_amount, mode: e.is_cash ? 'BANK' : e.event_type === 'ADJUSTMENT' ? 'ADJUSTED' : 'SCRIP', event_type: e.event_type, reference: e.bank_reference ?? e.scrip_number, remarks: e.remarks })) };
}

R.get('/export-benefits/claims/:id', VIEW, ah(async (req, res) => {
  res.json({ data: await claimDetail(req.user!.companyId, Number(req.params.id)) });
}));

/** PUT /export-benefits/claims/:id — currency, claim custom fields, remarks; the declared amount only for claims not made by a shipping bill column. */
R.put('/export-benefits/claims/:id', ah(async (req, res) => {
  await demand(req, ['EXPORT.UPDATE', 'FINANCE.UPDATE'], 'change a benefit claim');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ declared_amount: z.coerce.number().min(0, 'Cannot be negative').nullish(), currency_code: z.string().trim().toUpperCase().length(3).optional(),
    custom_field_values: z.record(z.string(), z.unknown()).nullish(), remarks: s.nullableStr(500), row_version: z.coerce.number().int().optional() }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const x = await lockClaim(tx, cid, id);
    if (b.row_version != null && b.row_version !== Number(x.row_version)) throw Conflict('This claim was changed by someone else — reload it');
    const sc = await claimConfig(Number(x.scheme_id), x.scheme_config_version == null ? null : Number(x.scheme_config_version), tx);
    const live = await loadScheme(cid, Number(x.scheme_id), tx);
    if (b.declared_amount !== undefined && live.sb_field && x.source === 'SHIPPING_BILL' && n(b.declared_amount) !== n(x.declared_amount)) throw BadRequest(`Change the ${sc.display_name} amount on the shipping bill`);
    let cfv = x.custom_field_values;
    if (b.custom_field_values !== undefined) {
      const cv = validateCustomValues(sc.custom_fields, 'CLAIM', null, b.custom_field_values);
      if (cv.errors.length) throw BadRequest(cv.errors[0].message, cv.errors);
      cfv = cv.values ? JSON.stringify(cv.values) : null;
    }
    const decl = b.declared_amount !== undefined ? (b.declared_amount == null ? null : r2(b.declared_amount)) : x.declared_amount;
    await txExecute(tx, `UPDATE trx_export_incentive SET declared_amount = ?, claim_amount = ?, currency_code = ?, custom_field_values = ?, remarks = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
      [decl, n(decl), b.currency_code ?? x.currency_code, cfv, b.remarks !== undefined ? b.remarks : x.remarks, req.user!.id, id]);
    await recalcClaim(tx, id, { userId: req.user!.id, reason: 'Claim edited' });
    await audit(req, 'trx_export_incentive', id, 'UPDATE', { declared_amount: x.declared_amount, custom_field_values: parseJson(x.custom_field_values, null), remarks: x.remarks }, b, tx);
  });
  res.json({ data: await claimDetail(cid, id) });
}));

/** Not applicable needs a reason and the authority to waive a claim (spec v1 §5.1, AT-19 / v2 AT-22). */
R.post('/export-benefits/claims/:id/applicability', ah(async (req, res) => {
  await demand(req, ['EXPORT.APPROVE', 'EXPORT_BENEFIT.APPROVE'], 'mark a benefit Not applicable');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ applicable: z.boolean(), reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  if (!b.applicable && (b.reason ?? '').length < 3) throw BadRequest('Give the reason it is not applicable', [{ field: 'reason', message: 'Required' }]);
  await transaction(async (tx) => {
    const x = await lockClaim(tx, cid, id);
    if (!b.applicable && n(x.cash_received) + n(x.sale_proceeds) + n(x.adjusted_amount) + n(x.scrip_issued) > 0) throw BadRequest('Receipts / scrips are posted on this benefit — reverse them before marking it Not applicable');
    await txExecute(tx, `UPDATE trx_export_incentive SET applicability = ?, not_applicable_reason = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
      [b.applicable ? 'APPLICABLE' : 'NOT_APPLICABLE', b.applicable ? null : b.reason, req.user!.id, id]);
    await recalcClaim(tx, id, { userId: req.user!.id, reason: b.applicable ? `Applicable again${b.reason ? `: ${b.reason}` : ''}` : `Not applicable: ${b.reason}` });
    await audit(req, 'trx_export_incentive', id, 'UPDATE', { applicability: x.applicability, not_applicable_reason: x.not_applicable_reason }, b, tx);
  });
  res.json({ data: await claimDetail(cid, id) });
}));

/** Claim stage: QUERY / REJECT (reason + owner + due date tracked as a follow-up), SHORT_CLOSE, REOPEN. */
const stageSchema = z.object({ action: z.enum(['QUERY', 'REJECT', 'SHORT_CLOSE', 'REOPEN']), reason: z.string().trim().max(500).optional(),
  owner_user_id: s.id(), due_date: optDate });
export async function stageAction(req: Request, id: number, b: z.infer<typeof stageSchema>) {
  const cid = req.user!.companyId;
  if (b.action !== 'REOPEN' && (b.reason ?? '').length < 3) throw BadRequest('Give the reason', [{ field: 'reason', message: 'Required' }]);
  await transaction(async (tx) => {
    const x = await lockClaim(tx, cid, id);
    const settled = n(x.cash_received) + n(x.adjusted_amount) + n(x.scrip_issued);
    if (x.applicability === 'NOT_APPLICABLE') throw BadRequest('The benefit is Not applicable');
    if (b.action === 'REOPEN') {
      if (!['REJECTED', 'SHORT_CLOSED', 'QUERY'].includes(x.claim_stage)) throw BadRequest('The claim is not closed or under query');
      await txExecute(tx, `UPDATE trx_export_incentive SET claim_stage = 'ENTERED', closed_reason = NULL, closed_at = NULL, updated_by = ? WHERE id = ?`, [req.user!.id, id]);
    } else {
      if (['REJECTED', 'SHORT_CLOSED'].includes(x.claim_stage)) throw BadRequest('The claim is already closed — reopen it first');
      if (['RECEIVED', 'SETTLED'].includes(x.benefit_status) || (n(x.pending_amount) <= 0 && settled > 0)) throw BadRequest('The claim is fully received / settled');
      if (b.action === 'REJECT' && settled > 0) throw BadRequest('Money / scrip is already posted on this claim — short-close the balance instead');
      if (b.action === 'SHORT_CLOSE' && !(settled > 0)) throw BadRequest('Nothing is received yet — reject the claim instead');
      const stage = b.action === 'QUERY' ? 'QUERY' : b.action === 'REJECT' ? 'REJECTED' : 'SHORT_CLOSED';
      await txExecute(tx, `UPDATE trx_export_incentive SET claim_stage = ?, closed_reason = ?, closed_at = IF(? = 'QUERY', NULL, NOW()), updated_by = ? WHERE id = ?`, [stage, b.reason, stage, req.user!.id, id]);
      if (b.action !== 'SHORT_CLOSE') {
        const due = b.due_date ?? new Date(Date.parse(`${todayIst()}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
        await txExecute(tx, `INSERT INTO trx_export_benefit_followup (company_id, claim_id, reason_code, action_note, owner_user_id, due_date, created_by) VALUES (?,?,?,?,?,?,?)`,
          [cid, id, b.action === 'QUERY' ? 'QUERY' : 'REJECTED', b.reason, b.owner_user_id ?? req.user!.id, due, req.user!.id]);
      }
    }
    await recalcClaim(tx, id, { userId: req.user!.id, reason: `${b.action}${b.reason ? `: ${b.reason}` : ''}` });
    await audit(req, 'trx_export_incentive', id, 'UPDATE', { claim_stage: x.claim_stage }, b, tx);
  });
}
R.post('/export-benefits/claims/:id/stage', ah(async (req, res) => {
  await demand(req, ['EXPORT.UPDATE', 'FINANCE.UPDATE'], 'change the claim status');
  await stageAction(req, Number(req.params.id), stageSchema.parse(req.body ?? {}));
  res.json({ data: await claimDetail(req.user!.companyId, Number(req.params.id)) });
}));

/** Remove a benefit row that never had a posted event (spec v2 §6: allowed in draft only). */
R.delete('/export-benefits/claims/:id', ah(async (req, res) => {
  await demand(req, ['EXPORT.UPDATE', 'FINANCE.DELETE'], 'remove a benefit');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const x = await lockClaim(tx, cid, id);
    const live = await loadScheme(cid, Number(x.scheme_id), tx);
    if (live.sb_field && x.source === 'SHIPPING_BILL') throw BadRequest(`Set the ${live.display_name} amount to 0 on the shipping bill (or mark it Not applicable)`);
    await deleteClaims(tx, [id]);
    await audit(req, 'trx_export_incentive', id, 'DELETE', { scheme: x.incentive_type, declared_amount: x.declared_amount, shipping_bill_id: x.shipping_bill_id }, undefined, tx);
  });
  res.json({ data: { id, deleted: true } });
}));

/* ================================================================ events */
const docIn = z.object({ filename: z.string().trim().min(1).max(200), data: z.string().min(8), doc_type: z.string().trim().toUpperCase().max(40).default('OTHER') });
const eventSchema = z.object({
  event_type: z.string().trim().toUpperCase().min(1, 'Pick the event'),
  event_date: dateStr,
  amount: z.coerce.number({ error: 'Enter the amount' }).positive('The amount must be more than 0 (corrections are reversals)'),
  currency_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('INR'),
  exchange_rate: z.coerce.number().positive('Enter the exchange rate').nullish(), rate_date: optDate,
  bank_account_id: s.id(), bank_reference: s.nullableStr(120), scrip_number: s.nullableStr(120), source_document_no: s.nullableStr(120),
  custom_field_values: z.record(z.string(), z.unknown()).nullish(), remarks: s.nullableStr(1000),
  post: z.boolean().default(true),
  allow_excess: z.boolean().optional(), allow_early_date: z.boolean().optional(), allow_inactive: z.boolean().optional(), ack_duplicate: z.boolean().optional(),
  exception_reason: s.nullableStr(500),
  document: docIn.nullish(),
});
type EventIn = z.infer<typeof eventSchema>;

/** Every rule of spec v1 §15 / v2 §17 that applies when an event is POSTED. Returns warnings; throws on a block. */
async function checkPosting(tx: Tx, req: Request, x: any, cfg: SchemeConfig, ev: EventIn & { id?: number }, extraDocType: string | null) {
  const cid = req.user!.companyId;
  const meta = EVENT_TYPES[ev.event_type];
  const warnings: string[] = []; const exceptions: string[] = [];
  const tol = await tolerance(cid, tx);
  const needApproval = async (what: string) => {
    if ((ev.exception_reason ?? '').length < 3) throw BadRequest(`${what} — give the exception reason`, [{ field: 'exception_reason', message: 'Required for an exception' }]);
    await demand(req, ['EXPORT_BENEFIT.APPROVE'], `post an exception (${what})`);
    exceptions.push(what);
  };
  const value = !['CLAIM_FILED', 'APPROVAL'].includes(ev.event_type);
  if (x.applicability === 'NOT_APPLICABLE') throw BadRequest('This benefit is marked Not applicable — mark it applicable first');
  if (value && x.claim_stage === 'REJECTED') throw BadRequest('The claim is rejected — reopen it first');
  if (meta.settles && x.claim_stage === 'SHORT_CLOSED') throw BadRequest('The balance of this claim is short-closed — reopen it first');
  const live = await txQueryOne<any>(tx, `SELECT is_active, effective_to FROM mst_export_benefit_scheme WHERE id = ?`, [x.scheme_id]);
  if (!Number(live?.is_active)) {
    if (!ev.allow_inactive) throw new AppError(400, `${cfg.display_name} is inactive — posting on a historical claim is an authorised exception (tick the exception and give the reason)`, 'INACTIVE_SCHEME');
    await needApproval('Inactive scheme');
  }
  const today = todayIst();
  if (ev.event_date > today) throw BadRequest('The event date is in the future', [{ field: 'event_date', message: 'Future date' }]);
  const from = iso(x.sb_date) ?? iso(x.claim_date);
  if (from && ev.event_date < from) {
    if (!ev.allow_early_date) throw BadRequest(`The date is before the ${x.sb_date ? 'shipping bill' : 'claim'} date (${from})`, [{ field: 'event_date', message: 'Too early' }]);
    await needApproval(`Date before the ${x.sb_date ? 'shipping bill' : 'claim'} date`);
  }
  if (meta.bank) {
    if (!ev.bank_account_id) throw BadRequest('Pick the bank account it was credited to', [{ field: 'bank_account_id', message: 'Required' }]);
    const ba = await txQueryOne<any>(tx, `SELECT id, is_active FROM mst_company_bank_account WHERE id = ? AND company_id = ?`, [ev.bank_account_id, cid]);
    if (!ba) throw BadRequest('Bank account not found', [{ field: 'bank_account_id', message: 'Not found' }]);
  }
  if (meta.scrip && !ev.scrip_number) throw BadRequest('Enter the scrip number', [{ field: 'scrip_number', message: 'Required' }]);
  if ((meta.reason || ev.event_type === 'ADJUSTMENT') && !(ev.remarks ?? '').trim() && !(ev.exception_reason ?? '').trim()) throw BadRequest(`${meta.label}: give the reason in remarks`, [{ field: 'remarks', message: 'Required' }]);
  const base = ev.currency_code === 'INR' ? r4(ev.amount) : r4(ev.amount * n(ev.exchange_rate));
  if (ev.currency_code !== 'INR' && (!ev.exchange_rate || !ev.rate_date)) throw BadRequest(`Amount in ${ev.currency_code}: enter the exchange rate and its date (₹ amount = amount × rate)`, [{ field: 'exchange_rate', message: 'Required' }]);
  // balances (the claim row is locked FOR UPDATE and current)
  if (meta.kind === 'SCRIP_OUT') {
    const avail = r4(n(x.scrip_available));
    if (base > avail + 0.005) throw BadRequest(`Only ₹${avail.toFixed(2)} scrip is available on this claim`, [{ field: 'amount', message: `More than available ₹${avail.toFixed(2)}` }]);
  }
  if (meta.settles) {
    const basis = x.basis_amount == null ? null : n(x.basis_amount);
    const settledNow = n(x.cash_received) + n(x.adjusted_amount) + n(x.scrip_issued);
    if (basis == null) warnings.push('The amount basis is not known yet — nothing to compare the receipt with');
    else {
      const over = r4(settledNow + base - basis);
      if (over > tol) {
        if (!ev.allow_excess) throw new AppError(400, `Only ₹${Math.max(0, r2(basis - settledNow)).toFixed(2)} is pending on this claim — ₹${r2(over).toFixed(2)} would be an over-receipt (tick "over-receipt exception" and give the reason)`, 'OVER_RECEIPT', [{ field: 'amount', message: `More than pending ₹${Math.max(0, r2(basis - settledNow)).toFixed(2)}` }]);
        await needApproval(`Over-receipt ₹${r2(over).toFixed(2)}`);
        warnings.push(`₹${r2(over).toFixed(2)} more than the ${BASIS_LABEL[x.basis_source] ?? 'basis'} — shown as excess`);
      }
    }
  }
  if (ev.event_type === 'SALE_PROCEEDS' && n(x.sale_proceeds) + base > n(x.scrip_sold) + tol) warnings.push('Sale proceeds are more than the face value of scrip sold — check the sale entry');
  if (ev.bank_reference) {
    const dup = await txQuery<any>(tx, `SELECT e.id, e.event_date, e.base_amount, sb.sb_no, s.display_name FROM trx_export_benefit_event e JOIN trx_export_incentive y ON y.id = e.claim_id
        JOIN mst_export_benefit_scheme s ON s.id = y.scheme_id LEFT JOIN trx_shipping_bill sb ON sb.id = y.shipping_bill_id
       WHERE e.company_id = ? AND UPPER(TRIM(e.bank_reference)) = UPPER(TRIM(?)) AND e.status <> 'REVERSED' AND e.event_type <> 'REVERSAL' AND e.id <> ? LIMIT 5`, [cid, ev.bank_reference, ev.id ?? 0]);
    if (dup.length) {
      const policy = await setting(cid, 'EXPORT_BENEFIT_DUP_REF_POLICY', 'WARN', tx);
      const where = dup.map((d) => `${d.display_name} ${d.sb_no ? `SB ${d.sb_no}` : ''} on ${iso(d.event_date)} ₹${r2(n(d.base_amount))}`).join('; ');
      if (policy === 'BLOCK') throw new AppError(409, `UTR / reference ${ev.bank_reference} is already recorded (${where})`, 'DUPLICATE_REFERENCE', dup);
      if (!ev.ack_duplicate) throw new AppError(409, `UTR / reference ${ev.bank_reference} is already recorded (${where}) — confirm to record it again`, 'DUPLICATE_REFERENCE', dup);
      warnings.push(`Duplicate reference ${ev.bank_reference} confirmed`); exceptions.push('Duplicate reference confirmed');
    }
  }
  const stage = meta.kind === 'CASH' || meta.kind === 'PROCEEDS' ? 'RECEIPT' : ['SCRIP_IN', 'SCRIP_OUT', 'TRANSFER_IN'].includes(meta.kind) ? 'SCRIP' : null;
  const reqDocs = cfg.required_documents.filter((d) => (d.event_types?.length ? d.event_types.includes(ev.event_type) : d.stage === stage || (d.stage === 'SETTLEMENT' && meta.settles)));
  if (reqDocs.length) {
    const have = new Set((await txQuery<any>(tx, `SELECT doc_type FROM trx_export_benefit_document WHERE claim_id = ? AND is_deleted = 0 AND (event_id IS NULL OR event_id = ?)`, [x.id, ev.id ?? 0])).map((d) => d.doc_type));
    if (extraDocType) have.add(extraDocType);
    for (const d of reqDocs) if (!have.has(d.doc_type)) {
      if (d.policy === 'BLOCK') throw BadRequest(`Attach the ${d.label} (required by ${cfg.display_name})`, [{ field: 'document', message: `${d.label} required` }]);
      warnings.push(`${d.label} is not attached`);
    }
  }
  return { warnings, exceptions, base };
}

/** Light checks for any save (draft or post). */
function checkShape(cfg: SchemeConfig, ev: EventIn) {
  const meta = EVENT_TYPES[ev.event_type];
  if (!meta || ev.event_type === 'REVERSAL') throw BadRequest('Pick a valid event', [{ field: 'event_type', message: 'Invalid' }]);
  if (!cfg.allowed_events.includes(ev.event_type)) throw BadRequest(`${meta.label} is not allowed for ${cfg.display_name}`, [{ field: 'event_type', message: 'Not allowed by the scheme' }]);
  if (!meta.modes.includes(cfg.tracking_mode)) throw BadRequest(`${meta.label} is not possible for a ${TRACKING_LABEL[cfg.tracking_mode]} scheme`, [{ field: 'event_type', message: 'Mode' }]);
  if (ev.event_date > todayIst()) throw BadRequest('The event date is in the future', [{ field: 'event_date', message: 'Future date' }]);
  const cv = validateCustomValues(cfg.custom_fields, 'EVENT', ev.event_type, ev.custom_field_values);
  if (cv.errors.length) throw BadRequest(cv.errors[0].message, cv.errors);
  return cv.values;
}
async function eventRights(req: Request, type: string, post: boolean) {
  if (['CLAIM_FILED', 'APPROVAL'].includes(type)) return demand(req, ['EXPORT.UPDATE', 'FINANCE.UPDATE'], 'record claim filing / approval');
  if (post) return demand(req, ['FINANCE.UPDATE'], 'post export benefit receipts / scrip events');
  return demand(req, ['FINANCE.CREATE', 'FINANCE.UPDATE', 'EXPORT.UPDATE'], 'save a draft benefit event');
}

const DOC_MAX = 10 * 1024 * 1024;
const DOC_EXT: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', csv: 'text/csv', txt: 'text/plain',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel' };
function decodeDoc(d: z.infer<typeof docIn>) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(d.data);
  const buf = Buffer.from(m ? m[2] : d.data, 'base64');
  if (!buf.length) throw BadRequest('The file is empty');
  if (buf.length > DOC_MAX) throw BadRequest('The file is larger than 10 MB');
  const ext = path.extname(d.filename).slice(1).toLowerCase();
  const mime = DOC_EXT[ext];
  if (!mime) throw BadRequest('Attach a PDF, image, Excel or CSV file');
  const head = buf.subarray(0, 8);
  const ok = ext === 'pdf' ? head.subarray(0, 5).toString('latin1') === '%PDF-' : ext === 'png' ? head[0] === 0x89 && head[1] === 0x50 : ['jpg', 'jpeg'].includes(ext) ? head[0] === 0xff && head[1] === 0xd8
    : ext === 'xlsx' ? head[0] === 0x50 && head[1] === 0x4b : true;
  if (!ok) throw BadRequest(`The file content is not a ${ext.toUpperCase()}`);
  return { buf, mime };
}
async function saveDoc(tx: Tx, req: Request, claimId: number, eventId: number | null, d: z.infer<typeof docIn>) {
  const { buf, mime } = decodeDoc(d);
  const dir = DOC_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(20).toString('hex');
  fs.writeFileSync(path.join(dir, key), buf);
  const r = await txExecute(tx, `INSERT INTO trx_export_benefit_document (company_id, claim_id, event_id, doc_type, storage_key, original_name, mime_type, size_bytes, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, claimId, eventId, d.doc_type || 'OTHER', key, d.filename.slice(0, 200), mime, buf.length, req.user!.id]);
  await audit(req, 'trx_export_benefit_document', Number(r.insertId), 'INSERT', undefined, { claim_id: claimId, event_id: eventId, doc_type: d.doc_type, name: d.filename }, tx);
  return Number(r.insertId);
}

export async function addEvent(req: Request, claimId: number, ev: EventIn) {
  const cid = req.user!.companyId;
  await eventRights(req, ev.event_type, ev.post);
  if (ev.allow_excess || ev.allow_early_date || ev.allow_inactive) { /* checked in checkPosting with the approval right */ }
  return transaction(async (tx) => {
    const x = await lockClaim(tx, cid, claimId);
    const cfg = await claimConfig(Number(x.scheme_id), x.scheme_config_version == null ? null : Number(x.scheme_config_version), tx);
    const cfv = checkShape(cfg, ev);
    let warnings: string[] = []; let exceptions: string[] = []; let base = ev.currency_code === 'INR' ? r4(ev.amount) : r4(ev.amount * n(ev.exchange_rate));
    if (ev.post) ({ warnings, exceptions, base } = await checkPosting(tx, req, x, cfg, ev, ev.document?.doc_type ?? null));
    else if (ev.currency_code !== 'INR' && !ev.exchange_rate) throw BadRequest('Enter the exchange rate', [{ field: 'exchange_rate', message: 'Required' }]);
    const r = await txExecute(tx, `INSERT INTO trx_export_benefit_event (company_id, claim_id, event_type, event_date, amount, currency_code, exchange_rate, rate_date, base_amount, bank_account_id,
        bank_reference, scrip_number, source_document_no, status, is_exception, exception_reason, custom_field_values, remarks, scheme_config_version, created_by, posted_by, posted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ${ev.post ? 'NOW()' : 'NULL'})`,
    [cid, claimId, ev.event_type, ev.event_date, r4(ev.amount), ev.currency_code, ev.currency_code === 'INR' ? 1 : n(ev.exchange_rate), ev.rate_date ?? null, base, ev.bank_account_id ?? null,
      ev.bank_reference ?? null, ev.scrip_number ?? null, ev.source_document_no ?? null, ev.post ? 'POSTED' : 'DRAFT', exceptions.length ? 1 : 0,
      exceptions.length ? `${exceptions.join('; ')}: ${ev.exception_reason ?? ''}`.slice(0, 500) : null, cfv ? JSON.stringify(cfv) : null, ev.remarks ?? null,
      cfg.config_version, req.user!.id, ev.post ? req.user!.id : null]);
    const id = Number(r.insertId);
    if (ev.document) await saveDoc(tx, req, claimId, id, ev.document);
    if (ev.post) await recalcClaim(tx, claimId, { userId: req.user!.id, eventId: id, reason: EVENT_TYPES[ev.event_type].label });
    await audit(req, 'trx_export_benefit_event', id, 'INSERT', undefined, { claim_id: claimId, ...ev, document: ev.document ? ev.document.filename : undefined, exceptions }, tx);
    return { id, warnings };
  });
}

R.post('/export-benefits/claims/:id/events', ah(async (req, res) => {
  const ev = eventSchema.parse(req.body ?? {});
  const out = await addEvent(req, Number(req.params.id), ev);
  res.status(201).json({ data: { event_id: out.id, warnings: out.warnings, claim: await claimDetail(req.user!.companyId, Number(req.params.id)) } });
}));

/** Post a draft event (all posting rules apply now). */
R.post('/export-benefits/events/:id/post', ah(async (req, res) => {
  const cid = req.user!.companyId;
  const eid = Number(req.params.id);
  const flags = z.object({ allow_excess: z.boolean().optional(), allow_early_date: z.boolean().optional(), allow_inactive: z.boolean().optional(), ack_duplicate: z.boolean().optional(),
    exception_reason: s.nullableStr(500) }).parse(req.body ?? {});
  const e0 = await queryOne<any>(`SELECT * FROM trx_export_benefit_event WHERE id = ? AND company_id = ?`, [eid, cid]);
  if (!e0) throw NotFound('Event not found');
  await eventRights(req, e0.event_type, true);
  const out = await transaction(async (tx) => {
    const x = await lockClaim(tx, cid, Number(e0.claim_id));
    const e = await txQueryOne<any>(tx, `SELECT * FROM trx_export_benefit_event WHERE id = ? FOR UPDATE`, [eid]);
    if (e.status !== 'DRAFT') throw BadRequest('The event is already posted');
    const cfg = await claimConfig(Number(x.scheme_id), x.scheme_config_version == null ? null : Number(x.scheme_config_version), tx);
    const ev: EventIn & { id: number } = { id: eid, event_type: e.event_type, event_date: iso(e.event_date)!, amount: n(e.amount), currency_code: e.currency_code, exchange_rate: n(e.exchange_rate),
      rate_date: iso(e.rate_date), bank_account_id: e.bank_account_id, bank_reference: e.bank_reference, scrip_number: e.scrip_number, source_document_no: e.source_document_no,
      custom_field_values: parseJson(e.custom_field_values, null), remarks: e.remarks, post: true, ...flags };
    checkShape(cfg, ev);
    const { warnings, exceptions, base } = await checkPosting(tx, req, x, cfg, ev, null);
    await txExecute(tx, `UPDATE trx_export_benefit_event SET status = 'POSTED', base_amount = ?, posted_by = ?, posted_at = NOW(), is_exception = ?, exception_reason = ? WHERE id = ?`,
      [base, req.user!.id, exceptions.length ? 1 : 0, exceptions.length ? `${exceptions.join('; ')}: ${flags.exception_reason ?? ''}`.slice(0, 500) : null, eid]);
    await recalcClaim(tx, Number(e.claim_id), { userId: req.user!.id, eventId: eid, reason: `${EVENT_TYPES[e.event_type]?.label} posted` });
    await audit(req, 'trx_export_benefit_event', eid, 'UPDATE', { status: 'DRAFT' }, { status: 'POSTED', ...flags }, tx);
    return { claim_id: Number(e.claim_id), warnings };
  });
  res.json({ data: { warnings: out.warnings, claim: await claimDetail(cid, out.claim_id) } });
}));

/** Only a draft can be deleted; a posted event is reversed. */
R.delete('/export-benefits/events/:id', ah(async (req, res) => {
  const cid = req.user!.companyId;
  const eid = Number(req.params.id);
  await demand(req, ['FINANCE.CREATE', 'FINANCE.UPDATE', 'EXPORT.UPDATE'], 'delete a draft benefit event');
  const claimId = await transaction(async (tx) => {
    const e = await txQueryOne<any>(tx, `SELECT * FROM trx_export_benefit_event WHERE id = ? AND company_id = ? FOR UPDATE`, [eid, cid]);
    if (!e) throw NotFound('Event not found');
    if (e.status !== 'DRAFT') throw BadRequest('A posted event is never deleted — reverse it (with a reason)');
    await txExecute(tx, `UPDATE trx_export_benefit_document SET is_deleted = 1, event_id = NULL WHERE event_id = ?`, [eid]);
    await txExecute(tx, `DELETE FROM trx_export_benefit_event WHERE id = ?`, [eid]);
    await audit(req, 'trx_export_benefit_event', eid, 'DELETE', e, undefined, tx);
    return Number(e.claim_id);
  });
  res.json({ data: await claimDetail(cid, claimId) });
}));

/** Reverse a posted event: the original stays visible (REVERSED) and a linked REVERSAL row nets it out. */
export async function reverseEvent(req: Request, eid: number, reason: string, reversalDate?: string | null) {
  const cid = req.user!.companyId;
  await demand(req, ['FINANCE.UPDATE'], 'reverse a benefit event');
  await demand(req, ['EXPORT_BENEFIT.APPROVE'], 'reverse a posted benefit event (approval)');
  if ((reason ?? '').trim().length < 3) throw BadRequest('Give the reason for the reversal', [{ field: 'reason', message: 'Required' }]);
  return transaction(async (tx) => {
    const e0 = await txQueryOne<any>(tx, `SELECT claim_id FROM trx_export_benefit_event WHERE id = ? AND company_id = ?`, [eid, cid]);
    if (!e0) throw NotFound('Event not found');
    const x = await lockClaim(tx, cid, Number(e0.claim_id));
    const e = await txQueryOne<any>(tx, `SELECT * FROM trx_export_benefit_event WHERE id = ? FOR UPDATE`, [eid]);
    if (e.status === 'DRAFT') throw BadRequest('A draft is deleted, not reversed');
    if (e.status === 'REVERSED') throw BadRequest('The event is already reversed');
    if (e.event_type === 'REVERSAL') throw BadRequest('A reversal cannot be reversed — post the event again');
    const kind = EVENT_TYPES[e.event_type]?.kind;
    if ((kind === 'SCRIP_IN' || kind === 'TRANSFER_IN') && n(x.scrip_available) - n(e.base_amount) < -0.005) throw BadRequest('Part of this scrip is already utilised / sold — reverse those events first');
    const m = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_export_benefit_recon_match WHERE event_id = ? AND status = 'ACTIVE'`, [eid]);
    if (n(m?.c)) throw BadRequest('This receipt is matched to a bank statement line — undo the match first');
    const on = reversalDate ?? todayIst();
    if (on > todayIst() || on < iso(e.event_date)!) throw BadRequest('The reversal date must be between the event date and today');
    const r = await txExecute(tx, `INSERT INTO trx_export_benefit_event (company_id, claim_id, event_type, event_date, amount, currency_code, exchange_rate, rate_date, base_amount, bank_account_id,
        bank_reference, scrip_number, reverses_event_id, status, remarks, scheme_config_version, created_by, posted_by, posted_at) VALUES (?,?, 'REVERSAL', ?,?,?,?,?,?,?,?,?,?, 'POSTED', ?,?,?,?, NOW())`,
    [cid, e.claim_id, on, e.amount, e.currency_code, e.exchange_rate, e.rate_date, e.base_amount, e.bank_account_id, e.bank_reference, e.scrip_number, eid, reason, e.scheme_config_version, req.user!.id, req.user!.id]);
    const rid = Number(r.insertId);
    await txExecute(tx, `UPDATE trx_export_benefit_event SET status = 'REVERSED', reversed_by_event_id = ? WHERE id = ?`, [rid, eid]);
    await recalcClaim(tx, Number(e.claim_id), { userId: req.user!.id, eventId: rid, reason: `Reversed ${EVENT_TYPES[e.event_type]?.label}: ${reason}` });
    await audit(req, 'trx_export_benefit_event', eid, 'UPDATE', { status: e.status }, { status: 'REVERSED', reversal_event_id: rid, reason }, tx);
    return { claim_id: Number(e.claim_id), reversal_id: rid };
  });
}
R.post('/export-benefits/events/:id/reverse', ah(async (req, res) => {
  const b = z.object({ reason: z.string().trim().max(500).default(''), reversal_date: optDate }).parse(req.body ?? {});
  const out = await reverseEvent(req, Number(req.params.id), b.reason, b.reversal_date);
  res.json({ data: { reversal_id: out.reversal_id, claim: await claimDetail(req.user!.companyId, out.claim_id) } });
}));

/* ================================================================ documents (never through the public /uploads path) */
R.post('/export-benefits/claims/:id/documents', ah(async (req, res) => {
  await demand(req, ['EXPORT.UPDATE', 'FINANCE.UPDATE', 'FINANCE.CREATE'], 'attach benefit documents');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = docIn.extend({ event_id: s.id() }).parse(req.body ?? {});
  const docId = await transaction(async (tx) => {
    await lockClaim(tx, cid, id);
    if (b.event_id && !(await txQueryOne(tx, `SELECT id FROM trx_export_benefit_event WHERE id = ? AND claim_id = ?`, [b.event_id, id]))) throw BadRequest('Event not found on this claim');
    return saveDoc(tx, req, id, b.event_id ?? null, b);
  });
  res.status(201).json({ data: { id: docId, claim: await claimDetail(cid, id) } });
}));

R.get('/export-benefits/documents/:id/file', VIEW, ah(async (req, res) => {
  const d = await queryOne<any>(`SELECT * FROM trx_export_benefit_document WHERE id = ? AND company_id = ? AND is_deleted = 0`, [Number(req.params.id), req.user!.companyId]);
  if (!d) throw NotFound('Document not found');
  const file = path.join(DOC_DIR(), path.basename(d.storage_key));
  if (!fs.existsSync(file)) throw NotFound('The file is missing on the server');
  res.setHeader('Content-Type', d.mime_type);
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${String(d.original_name).replace(/["\\\r\n]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(file).pipe(res);
}));

R.delete('/export-benefits/documents/:id', ah(async (req, res) => {
  await demand(req, ['EXPORT.UPDATE', 'FINANCE.UPDATE'], 'remove a benefit document');
  const cid = req.user!.companyId;
  const d = await queryOne<any>(`SELECT * FROM trx_export_benefit_document WHERE id = ? AND company_id = ? AND is_deleted = 0`, [Number(req.params.id), cid]);
  if (!d) throw NotFound('Document not found');
  if (d.event_id) {
    const e = await queryOne<any>(`SELECT status FROM trx_export_benefit_event WHERE id = ?`, [d.event_id]);
    if (e && e.status !== 'DRAFT') throw BadRequest('The document is evidence of a posted event — it stays (retention)');
  }
  await execute(`UPDATE trx_export_benefit_document SET is_deleted = 1 WHERE id = ?`, [d.id]);
  await audit(req, 'trx_export_benefit_document', Number(d.id), 'DELETE', { name: d.original_name, doc_type: d.doc_type });
  res.json({ data: await claimDetail(cid, Number(d.claim_id)) });
}));

/* ================================================================ follow-ups */
R.get('/export-benefits/followups', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ status: z.enum(['OPEN', 'DONE', 'ALL']).default('OPEN'), mine: z.coerce.number().int().optional(), overdue: z.coerce.number().int().optional(),
    scheme_id: z.coerce.number().int().optional() }).parse(clean(req.query as any));
  const today = todayIst();
  const w = ['f.company_id = ?']; const p: unknown[] = [cid];
  if (q.status !== 'ALL') { w.push('f.status = ?'); p.push(q.status); }
  if (q.mine) { w.push('f.owner_user_id = ?'); p.push(req.user!.id); }
  if (q.overdue) { w.push(`f.status = 'OPEN' AND f.due_date < ?`); p.push(today); }
  if (q.scheme_id) { w.push('x.scheme_id = ?'); p.push(q.scheme_id); }
  const rows = await query<any>(`SELECT f.*, o.full_name AS owner_name, x.benefit_status, x.pending_amount, x.claim_stage, x.closed_reason, s.display_name AS scheme_name, sb.sb_no, sb.sb_date, sb.id AS sb_id
     FROM trx_export_benefit_followup f JOIN trx_export_incentive x ON x.id = f.claim_id JOIN mst_export_benefit_scheme s ON s.id = x.scheme_id
     LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id LEFT JOIN mst_user o ON o.id = f.owner_user_id
    WHERE ${w.join(' AND ')} ORDER BY f.status = 'DONE', f.due_date IS NULL, f.due_date, f.id LIMIT 500`, p);
  res.json({ data: rows.map((f) => ({ ...f, ...statusOf(f.benefit_status), due_date: iso(f.due_date), sb_date: iso(f.sb_date), pending_amount: r2(n(f.pending_amount)),
    days_outstanding: daysBetween(iso(f.created_at), today), overdue: f.status === 'OPEN' && !!f.due_date && iso(f.due_date)! < today })) });
}));
R.post('/export-benefits/claims/:id/followups', ah(async (req, res) => {
  await demand(req, ['EXPORT.UPDATE', 'FINANCE.UPDATE'], 'add a follow-up');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ action_note: z.string().trim().min(3, 'Write the next action').max(500), owner_user_id: s.id(), due_date: optDate,
    reason_code: z.enum(['FOLLOW_UP', 'QUERY', 'REJECTED', 'DELAY']).default('FOLLOW_UP') }).parse(req.body ?? {});
  if (!(await queryOne(`SELECT id FROM trx_export_incentive WHERE id = ? AND company_id = ?`, [id, cid]))) throw NotFound('Benefit claim not found');
  if (b.owner_user_id && !(await queryOne(`SELECT id FROM mst_user WHERE id = ?`, [b.owner_user_id]))) throw BadRequest('Owner not found');
  const r = await execute(`INSERT INTO trx_export_benefit_followup (company_id, claim_id, reason_code, action_note, owner_user_id, due_date, created_by) VALUES (?,?,?,?,?,?,?)`,
    [cid, id, b.reason_code, b.action_note, b.owner_user_id ?? req.user!.id, b.due_date ?? null, req.user!.id]);
  await audit(req, 'trx_export_benefit_followup', Number(r.insertId), 'INSERT', undefined, { claim_id: id, ...b });
  res.status(201).json({ data: await claimDetail(cid, id) });
}));
R.post('/export-benefits/followups/:id/done', ah(async (req, res) => {
  await demand(req, ['EXPORT.UPDATE', 'FINANCE.UPDATE'], 'close a follow-up');
  const cid = req.user!.companyId;
  const b = z.object({ done_note: s.nullableStr(500) }).parse(req.body ?? {});
  const f = await queryOne<any>(`SELECT * FROM trx_export_benefit_followup WHERE id = ? AND company_id = ?`, [Number(req.params.id), cid]);
  if (!f) throw NotFound('Follow-up not found');
  if (f.status === 'DONE') throw BadRequest('Already done');
  await execute(`UPDATE trx_export_benefit_followup SET status = 'DONE', done_note = ?, done_by = ?, done_at = NOW() WHERE id = ?`, [b.done_note ?? null, req.user!.id, f.id]);
  await audit(req, 'trx_export_benefit_followup', Number(f.id), 'UPDATE', { status: 'OPEN' }, { status: 'DONE', ...b });
  res.json({ data: { id: Number(f.id), status: 'DONE' } });
}));


/* ================================================================ dashboard */
const BUCKETS = [['0-30', 0, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['90+', 91, 1_000_000]] as const;
async function ageingData(cid: number, asOf: string, schemeId?: number) {
  const w = [`x.company_id = ?`, `x.pending_amount > 0`]; const p: unknown[] = [cid];
  if (schemeId) { w.push('x.scheme_id = ?'); p.push(schemeId); }
  const rows = await query<any>(`SELECT ${CLAIM_COLS(asOf)} ${CLAIM_FROM} WHERE ${w.join(' AND ')} ORDER BY days_pending DESC LIMIT 2000`, p);
  const claims = rows.map(claimOut);
  const bucketOf = (d: number | null) => BUCKETS.find(([, lo, hi]) => (d ?? 0) >= lo && (d ?? 0) <= hi)![0];
  const schemes = new Map<number, any>();
  const total = Object.fromEntries(BUCKETS.map(([k]) => [k, { amount: 0, count: 0 }])) as Record<string, { amount: number; count: number }>;
  for (const c of claims) {
    const k = bucketOf(c.days_pending);
    if (!schemes.has(c.scheme_id)) schemes.set(c.scheme_id, { scheme_id: c.scheme_id, code: c.scheme_code, display_name: c.scheme_name, short_name: c.short_name, ageing_basis: c.ageing_basis,
      ageing_label: c.ageing_label, buckets: Object.fromEntries(BUCKETS.map(([b]) => [b, { amount: 0, count: 0 }])), pending: 0, count: 0, sort: n(c.sort_order) });
    const sg = schemes.get(c.scheme_id);
    sg.buckets[k].amount = r2(sg.buckets[k].amount + n(c.pending_amount)); sg.buckets[k].count++; sg.pending = r2(sg.pending + n(c.pending_amount)); sg.count++;
    total[k].amount = r2(total[k].amount + n(c.pending_amount)); total[k].count++;
    c.bucket = k;
  }
  return { as_of: asOf, buckets: BUCKETS.map(([k]) => k), total, by_scheme: [...schemes.values()].sort((a, b) => a.sort - b.sort), rows: claims };
}

R.get('/export-benefits/dashboard', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  await ensureSchemes(cid); await ensureFresh(cid);
  const asOf = z.object({ as_of: dateStr.optional() }).parse(clean(req.query as any)).as_of ?? todayIst();
  const month0 = `${asOf.slice(0, 7)}-01`;
  const sumEv = async (types: string[], from: string, to: string) => {
    const r = await queryOne<any>(`SELECT COALESCE(SUM(base_amount), 0) amt, COUNT(*) c FROM trx_export_benefit_event WHERE company_id = ? AND status = 'POSTED' AND event_type IN (?) AND event_date BETWEEN ? AND ?`, [cid, types, from, to]);
    return { amount: r2(n(r?.amt)), count: n(r?.c) };
  };
  const [cashToday, cashMonth, procToday, procMonth, scripToday, scripMonth, utilMonth] = await Promise.all([
    sumEv(['BANK_RECEIPT', 'REFUND_CREDIT'], asOf, asOf), sumEv(['BANK_RECEIPT', 'REFUND_CREDIT'], month0, asOf),
    sumEv(['SALE_PROCEEDS'], asOf, asOf), sumEv(['SALE_PROCEEDS'], month0, asOf),
    sumEv(['SCRIP_ISSUE'], asOf, asOf), sumEv(['SCRIP_ISSUE'], month0, asOf), sumEv(['SCRIP_UTILISATION', 'SCRIP_SALE', 'TRANSFER_OUT'], month0, asOf),
  ]);
  const reg = await register(cid, regFilter.parse({ pageSize: 1 }));
  const age = await ageingData(cid, asOf);
  const [fu, exc, recon, trend, drafts] = await Promise.all([
    queryOne<any>(`SELECT SUM(status = 'OPEN') open, SUM(status = 'OPEN' AND due_date < ?) overdue FROM trx_export_benefit_followup WHERE company_id = ?`, [asOf, cid]),
    queryOne<any>(`SELECT SUM(excess_amount > 0) excess_n, SUM(excess_amount) excess, SUM(benefit_status = 'QUERY') query_n, SUM(benefit_status = 'REJECTED') rejected_n,
        SUM(applicability = 'NOT_APPLICABLE') na_n FROM trx_export_incentive WHERE company_id = ?`, [cid]),
    queryOne<any>(`SELECT SUM(match_status IN ('UNMATCHED', 'PARTIAL')) open_n, SUM(IF(match_status IN ('UNMATCHED', 'PARTIAL'), amount - matched_amount, 0)) open_amt FROM trx_export_benefit_bank_line WHERE company_id = ?`, [cid]),
    query<any>(`SELECT DATE_FORMAT(event_date, '%Y-%m') ym, SUM(IF(event_type IN ('BANK_RECEIPT','REFUND_CREDIT'), base_amount, 0)) cash,
        SUM(IF(event_type = 'SALE_PROCEEDS', base_amount, 0)) proceeds, SUM(IF(event_type = 'SCRIP_ISSUE', base_amount, 0)) scrip
       FROM trx_export_benefit_event WHERE company_id = ? AND status = 'POSTED' AND event_date >= DATE_SUB(?, INTERVAL 5 MONTH) GROUP BY ym ORDER BY ym`, [cid, month0]),
    queryOne<any>(`SELECT COUNT(*) c FROM trx_export_benefit_event WHERE company_id = ? AND status = 'DRAFT'`, [cid]),
  ]);
  const card = (key: string, label: string, v: { amount: number; count: number }, filter: Record<string, unknown>, tone: string, sub?: string) => ({ key, label, amount: v.amount, count: v.count, filter, tone, sub });
  res.json({ data: {
    as_of: asOf,
    cards: [
      card('cash_today', 'Cash received today', cashToday, { event_kind: 'RECEIPT', event_from: asOf, event_to: asOf }, 'green', 'Bank receipts + refund credits'),
      card('cash_month', 'Cash received this month', cashMonth, { event_kind: 'RECEIPT', event_from: month0, event_to: asOf }, 'green', 'Bank receipts + refund credits'),
      card('proceeds_month', 'Scrip sale proceeds this month', procMonth, { event_kind: 'PROCEEDS', event_from: month0, event_to: asOf }, 'green', `today ₹${procToday.amount.toFixed(2)}`),
      card('scrip_month', 'Scrip issued this month (not cash)', scripMonth, { event_kind: 'SCRIP_ISSUE', event_from: month0, event_to: asOf }, 'indigo', `today ₹${scripToday.amount.toFixed(2)} · used / sold ₹${utilMonth.amount.toFixed(2)}`),
      card('pending', 'Pending to receive / issue', { amount: reg.totals.pending, count: reg.totals.by_scheme.reduce((t: number, r: any) => t + r.open_claims, 0) }, { pending: 1 }, 'amber'),
      card('over90', 'Pending over 90 days', age.total['90+'], { pending: 1, bucket: '90+' }, 'red'),
      card('scrip_available', 'Scrip available (face value)', { amount: reg.totals.scrip_available, count: 0 }, { status: 'SCRIP_ISSUED,PART_UTILISED,SCRIP_PART_ISSUED' }, 'indigo', 'Issued, not yet utilised / sold'),
      card('excess', 'Over-receipts (exceptions)', { amount: r2(n(exc?.excess)), count: n(exc?.excess_n) }, { excess: 1 }, 'red'),
    ],
    by_scheme: reg.totals.by_scheme,
    ageing: { buckets: age.buckets, total: age.total, by_scheme: age.by_scheme.map(({ buckets, ...r }) => ({ ...r, buckets })) },
    queues: { followups_open: n(fu?.open), followups_overdue: n(fu?.overdue), query: n(exc?.query_n), rejected: n(exc?.rejected_n), not_applicable: n(exc?.na_n),
      bank_unmatched: n(recon?.open_n), bank_unmatched_amount: r2(n(recon?.open_amt)), drafts: n(drafts?.c) },
    trend: trend.map((t) => ({ month: t.ym, cash: r2(n(t.cash)), proceeds: r2(n(t.proceeds)), scrip: r2(n(t.scrip)) })),
  } });
}));

/* ================================================================ reports */
R.get('/export-benefits/reports/ageing', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  await ensureFresh(cid);
  const q = z.object({ as_of: dateStr.optional(), scheme_id: z.coerce.number().int().optional() }).parse(clean(req.query as any));
  const out = await ageingData(cid, q.as_of ?? todayIst(), q.scheme_id);
  if (req.query.format === 'xlsx') {
    const head = ['Benefit', 'Ageing basis', ...out.buckets.map((b) => `${b} days`), 'Pending'];
    const aoa: unknown[][] = [[`EXPORT BENEFITS — PENDING AGEING (as on ${out.as_of})`], [], head];
    for (const sg of out.by_scheme) aoa.push([sg.display_name, sg.ageing_label, ...out.buckets.map((b) => sg.buckets[b].amount), sg.pending]);
    aoa.push([], ['SB No', 'SB Date', 'Benefit', 'Ageing from', 'Days', 'Bucket', 'Pending', 'Status']);
    for (const r of out.rows) aoa.push([r.sb_no, r.sb_date, r.scheme_name, r.ageing_date, r.days_pending, r.bucket, r.pending_amount, r.status_label]);
    return sendXlsx(res, aoa, 'Ageing', `export_benefit_ageing_${out.as_of}.xlsx`, 8);
  }
  res.json({ data: out });
}));

/** Receipt-date report: every event by its actual date (cash and scrip apart; reversals as minus rows). */
R.get('/export-benefits/reports/receipts', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ from: dateStr.optional(), to: dateStr.optional(), scheme_id: z.coerce.number().int().optional(), kind: z.enum(['CASH', 'SCRIP', 'ALL']).default('CASH'),
    bank_account_id: z.coerce.number().int().optional() }).parse(clean(req.query as any));
  const to = q.to ?? todayIst(); const from = q.from ?? `${to.slice(0, 7)}-01`;
  const types = q.kind === 'CASH' ? CASH_EVENTS : q.kind === 'SCRIP' ? SCRIP_EVENTS : Object.keys(EVENT_TYPES).filter((k) => k !== 'REVERSAL');
  const w = ['e.company_id = ?', 'e.event_date BETWEEN ? AND ?', `e.status <> 'DRAFT'`, `(e.event_type IN (?) OR (e.event_type = 'REVERSAL' AND o.event_type IN (?)))`];
  const p: unknown[] = [cid, from, to, types, types];
  if (q.scheme_id) { w.push('x.scheme_id = ?'); p.push(q.scheme_id); }
  if (q.bank_account_id) { w.push('e.bank_account_id = ?'); p.push(q.bank_account_id); }
  const rows = await query<any>(`SELECT e.id, e.claim_id, e.event_type, e.event_date, e.base_amount, e.amount, e.currency_code, e.status, e.bank_reference, e.scrip_number, e.posted_at, e.created_at, e.remarks,
      o.event_type AS reversed_type, ba.account_label AS bank_label, s.display_name AS scheme_name, s.short_name, sb.sb_no, sb.sb_date, ci.invoice_no, u.full_name AS posted_by_name
     FROM trx_export_benefit_event e JOIN trx_export_incentive x ON x.id = e.claim_id JOIN mst_export_benefit_scheme s ON s.id = x.scheme_id
     LEFT JOIN trx_export_benefit_event o ON o.id = e.reverses_event_id LEFT JOIN mst_company_bank_account ba ON ba.id = e.bank_account_id
     LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id LEFT JOIN trx_commercial_invoice ci ON ci.id = COALESCE(x.invoice_id, sb.invoice_id) LEFT JOIN mst_user u ON u.id = e.posted_by
    WHERE ${w.join(' AND ')} ORDER BY e.event_date, e.id LIMIT 5000`, p);
  const out = rows.map((r) => {
    const sign = r.event_type === 'REVERSAL' ? -1 : 1;
    return { ...r, event_date: iso(r.event_date), sb_date: iso(r.sb_date), signed_amount: r2(sign * n(r.base_amount)),
      label: r.event_type === 'REVERSAL' ? `Reversal of ${EVENT_TYPES[r.reversed_type]?.label ?? r.reversed_type}` : EVENT_TYPES[r.event_type]?.label ?? r.event_type };
  });
  const daily = new Map<string, number>();
  for (const r of out) daily.set(r.event_date!, r2((daily.get(r.event_date!) ?? 0) + r.signed_amount));
  const total = r2(out.reduce((t, r) => t + r.signed_amount, 0));
  if (req.query.format === 'xlsx') {
    const head = ['Date', 'Benefit', 'Event', 'SB No', 'Invoice', 'Amount ₹', 'Bank', 'UTR / reference', 'Scrip no', 'Posted at', 'By'];
    const aoa: unknown[][] = [[`EXPORT BENEFIT ${q.kind === 'CASH' ? 'RECEIPTS' : 'EVENTS'} ${from} to ${to}`], [], head];
    for (const r of out) aoa.push([r.event_date, r.scheme_name, r.label, r.sb_no, r.invoice_no, r.signed_amount, r.bank_label, r.bank_reference, r.scrip_number, r.posted_at ? new Date(r.posted_at).toISOString().slice(0, 16).replace('T', ' ') : '', r.posted_by_name]);
    aoa.push(['TOTAL', '', '', '', '', total]);
    return sendXlsx(res, aoa, 'Receipts', `export_benefit_receipts_${from}_${to}.xlsx`, head.length);
  }
  res.json({ data: out, daily: [...daily.entries()].map(([date, amount]) => ({ date, amount })), total, from, to, kind: q.kind });
}));

/* ================================================================ bank statement reconciliation */
function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let t = String(v).trim().replace(/[₹,\s]/g, '').replace(/^INR/i, '');
  let sign = 1;
  if (/(CR|Cr|cr)\.?$/.test(t)) t = t.replace(/(CR|Cr|cr)\.?$/, '');
  if (/(DR|Dr|dr)\.?$/.test(t)) { t = t.replace(/(DR|Dr|dr)\.?$/, ''); sign = -1; }
  if (/^\(.*\)$/.test(t)) { t = t.slice(1, -1); sign = -1; }
  const x = Number(t);
  return Number.isFinite(x) ? sign * x : null;
}
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(0, 10);
  const t = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t);   // Indian statements: dd/mm/yyyy
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2,4})/.exec(t);
  if (m && MON[m[2].toLowerCase()]) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return null;
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
/** Bank statement → credit lines (CSV or Excel; header row found by its column names). */
export function readStatement(filename: string, buf: Buffer) {
  let grid: unknown[][];
  if (/\.(csv|txt)$/i.test(filename)) grid = parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
  else {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  }
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  let hi = -1; let cols: Record<string, number> = {};
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const h = (grid[i] ?? []).map(norm);
    const find = (re: RegExp, not?: RegExp) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
    const date = find(/^(txn |tran |transaction |posting |value )?date$|^(txn|tran|transaction|value) date|^date/);
    const credit = find(/credit|deposit|^cr( amount)?\.?$/, /debit|card/);
    const amount = find(/^(txn |transaction )?amount/);
    if (date >= 0 && (credit >= 0 || amount >= 0)) {
      hi = i;
      cols = { date, credit, amount, debit: find(/debit|withdrawal|^dr( amount)?\.?$/), drcr: find(/^(cr\/dr|dr\/cr|type|txn type)$/),
        ref: find(/utr|ref|chq|cheque|instrument/), narr: find(/narration|description|particulars|remarks|details/) };
      break;
    }
  }
  if (hi < 0) throw BadRequest('Could not find the header row — the statement needs a Date column and a Credit (or Amount) column');
  const lines: { txn_date: string; amount: number; reference: string | null; narration: string | null }[] = [];
  let skipped = 0;
  for (const row of grid.slice(hi + 1)) {
    if (!row || !row.some((c) => c != null && c !== '')) continue;
    const date = parseDate(row[cols.date]);
    let amt: number | null = null;
    if (cols.credit >= 0) amt = parseNum(row[cols.credit]);
    else if (cols.amount >= 0) {
      amt = parseNum(row[cols.amount]);
      if (cols.drcr >= 0 && !/^c/i.test(String(row[cols.drcr] ?? ''))) amt = null;
    }
    if (!date || amt == null || !(amt > 0)) { skipped++; continue; }
    const narration = cols.narr >= 0 && row[cols.narr] != null ? String(row[cols.narr]).trim().slice(0, 500) : null;
    let reference = cols.ref >= 0 && row[cols.ref] != null && String(row[cols.ref]).trim() ? String(row[cols.ref]).trim().slice(0, 120) : null;
    if (!reference && narration) { const m = /\b([A-Z]{4}[A-Z0-9]*\d{6,}[A-Z0-9]*)\b/.exec(narration.toUpperCase()); if (m) reference = m[1].slice(0, 120); }
    lines.push({ txn_date: date, amount: r2(amt), reference, narration });
  }
  return { lines, skipped, header_row: hi + 1 };
}

R.post('/export-benefits/bank-statements/import', ah(async (req, res) => {
  await demand(req, ['FINANCE.UPDATE'], 'import bank statements');
  const cid = req.user!.companyId;
  const b = z.object({ filename: z.string().trim().min(1).max(200), data: z.string().min(8), bank_account_id: s.id() }).parse(req.body ?? {});
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(b.data);
  const buf = Buffer.from(m ? m[2] : b.data, 'base64');
  if (buf.length > 10 * 1024 * 1024) throw BadRequest('The statement is larger than 10 MB');
  if (!/\.(csv|txt|xlsx|xls)$/i.test(b.filename)) throw BadRequest('Upload the statement as CSV or Excel');
  if (b.bank_account_id && !(await queryOne(`SELECT id FROM mst_company_bank_account WHERE id = ? AND company_id = ?`, [b.bank_account_id, cid]))) throw BadRequest('Bank account not found');
  const st = readStatement(b.filename, buf);
  const out = await transaction(async (tx) => {
    const imp = await txExecute(tx, `INSERT INTO trx_export_benefit_bank_import (company_id, bank_account_id, file_name, lines_read, imported_by) VALUES (?,?,?,?,?)`,
      [cid, b.bank_account_id ?? null, b.filename, st.lines.length, req.user!.id]);
    const seen = new Map<string, number>(); let added = 0;
    for (const l of st.lines) {
      const k = [b.bank_account_id ?? 0, l.txn_date, l.amount.toFixed(2), (l.reference ?? '').toUpperCase(), (l.narration ?? '').toUpperCase()].join('|');
      const occ = (seen.get(k) ?? 0) + 1; seen.set(k, occ);
      const hash = crypto.createHash('sha1').update(`${k}|${occ}`).digest('hex');
      const r = await txExecute(tx, `INSERT IGNORE INTO trx_export_benefit_bank_line (company_id, import_id, bank_account_id, txn_date, amount, reference, narration, line_hash) VALUES (?,?,?,?,?,?,?,?)`,
        [cid, imp.insertId, b.bank_account_id ?? null, l.txn_date, l.amount, l.reference, l.narration, hash]);
      if (r.affectedRows) added++;
    }
    await txExecute(tx, `UPDATE trx_export_benefit_bank_import SET lines_new = ? WHERE id = ?`, [added, imp.insertId]);
    return { import_id: Number(imp.insertId), lines_read: st.lines.length, lines_new: added, duplicates: st.lines.length - added, skipped: st.skipped };
  });
  await audit(req, 'trx_export_benefit_bank_import', out.import_id, 'INSERT', undefined, { file: b.filename, ...out });
  const auto = await autoMatch(req, b.bank_account_id ?? null);
  res.status(201).json({ data: { ...out, auto_matched: auto } });
}));

const lineStatus = (amount: number, matched: number) => (matched <= 0.005 ? 'UNMATCHED' : matched >= amount - 0.005 ? 'MATCHED' : 'PARTIAL');
const normRef = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function eventRemaining(tx: Tx, eid: number) {
  const r = await txQueryOne<any>(tx, `SELECT e.base_amount - COALESCE((SELECT SUM(m.matched_amount) FROM trx_export_benefit_recon_match m WHERE m.event_id = e.id AND m.status = 'ACTIVE'), 0) rem
     FROM trx_export_benefit_event e WHERE e.id = ?`, [eid]);
  return r4(n(r?.rem));
}
/** One allocation of a bank line to a receipt event; the line and the event are locked so nothing is allocated twice. */
async function matchOne(tx: Tx, req: Request, lineId: number, eventId: number, amount: number | null, reason: string | null, type: 'AUTO' | 'MANUAL') {
  const cid = req.user!.companyId;
  const line = await txQueryOne<any>(tx, `SELECT * FROM trx_export_benefit_bank_line WHERE id = ? AND company_id = ? FOR UPDATE`, [lineId, cid]);
  if (!line) throw NotFound('Bank line not found');
  if (line.match_status === 'IGNORED') throw BadRequest('The bank line is marked "not a benefit credit" — restore it first');
  const ev = await txQueryOne<any>(tx, `SELECT * FROM trx_export_benefit_event WHERE id = ? AND company_id = ? FOR UPDATE`, [eventId, cid]);
  if (!ev) throw NotFound('Receipt not found');
  if (ev.status !== 'POSTED' || !CASH_EVENTS.includes(ev.event_type)) throw BadRequest('Only a posted cash receipt (bank receipt, refund credit, sale proceeds) can be matched');
  const lineRem = r4(n(line.amount) - n(line.matched_amount));
  const evRem = await eventRemaining(tx, eventId);
  const amt = r4(amount ?? Math.min(lineRem, evRem));
  if (amt <= 0.005 || lineRem <= 0.005) throw Conflict('This bank line is already fully allocated');
  if (evRem <= 0.005) throw Conflict('This receipt is already fully matched to the bank');
  if (amt > lineRem + 0.005) throw Conflict(`Only ₹${lineRem.toFixed(2)} of the bank line is unallocated — it cannot be allocated twice`);
  if (amt > evRem + 0.005) throw Conflict(`Only ₹${evRem.toFixed(2)} of the receipt is unmatched`);
  const differs = (line.reference && ev.bank_reference && normRef(line.reference) !== normRef(ev.bank_reference)) || Math.abs(n(line.amount) - n(ev.base_amount)) > 0.005
    || (line.bank_account_id && ev.bank_account_id && Number(line.bank_account_id) !== Number(ev.bank_account_id));
  if (type === 'MANUAL' && differs && (reason ?? '').trim().length < 3) throw BadRequest('The reference, amount or bank account differ — give the reason for this match', [{ field: 'reason', message: 'Required' }]);
  const r = await txExecute(tx, `INSERT INTO trx_export_benefit_recon_match (company_id, bank_line_id, event_id, matched_amount, match_type, reason, matched_by) VALUES (?,?,?,?,?,?,?)`,
    [cid, lineId, eventId, amt, type, reason, req.user!.id]);
  const matched = r4(n(line.matched_amount) + amt);
  await txExecute(tx, `UPDATE trx_export_benefit_bank_line SET matched_amount = ?, match_status = ? WHERE id = ?`, [matched, lineStatus(n(line.amount), matched), lineId]);
  await audit(req, 'trx_export_benefit_recon_match', Number(r.insertId), 'INSERT', undefined, { bank_line_id: lineId, event_id: eventId, amount: amt, type, reason }, tx);
  return Number(r.insertId);
}
/** Auto-match: same UTR and amount; else the same amount within 5 days on the same bank when exactly one receipt fits. */
async function autoMatch(req: Request, bankAccountId: number | null) {
  const cid = req.user!.companyId;
  const lines = await query<any>(`SELECT * FROM trx_export_benefit_bank_line WHERE company_id = ? AND match_status = 'UNMATCHED'${bankAccountId ? ' AND bank_account_id = ?' : ''} ORDER BY txn_date, id LIMIT 2000`,
    bankAccountId ? [cid, bankAccountId] : [cid]);
  if (!lines.length) return 0;
  const evs = await query<any>(`SELECT e.id, e.event_date, e.base_amount, e.bank_reference, e.bank_account_id,
      e.base_amount - COALESCE((SELECT SUM(m.matched_amount) FROM trx_export_benefit_recon_match m WHERE m.event_id = e.id AND m.status = 'ACTIVE'), 0) AS rem
     FROM trx_export_benefit_event e WHERE e.company_id = ? AND e.status = 'POSTED' AND e.event_type IN (?)`, [cid, CASH_EVENTS]);
  const open = evs.filter((e) => n(e.rem) > 0.005);
  let done = 0;
  for (const l of lines) {
    const amt = n(l.amount);
    let hit = open.filter((e) => e.bank_reference && l.reference && normRef(e.bank_reference) === normRef(l.reference) && Math.abs(n(e.rem) - amt) <= 0.005);
    if (hit.length !== 1) hit = open.filter((e) => e.bank_reference && l.narration && normRef(l.narration).includes(normRef(e.bank_reference)) && normRef(e.bank_reference).length >= 6 && Math.abs(n(e.rem) - amt) <= 0.005);
    if (hit.length !== 1) hit = open.filter((e) => Math.abs(n(e.rem) - amt) <= 0.005 && Math.abs(daysBetween(iso(e.event_date), iso(l.txn_date)!) ?? 99) <= 5
      && (!l.bank_account_id || !e.bank_account_id || Number(l.bank_account_id) === Number(e.bank_account_id)));
    if (hit.length !== 1) continue;
    try {
      await transaction((tx) => matchOne(tx, req, Number(l.id), Number(hit[0].id), null, null, 'AUTO'));
      hit[0].rem = 0; done++;
    } catch { /* taken meanwhile — leave for manual */ }
  }
  return done;
}

R.post('/export-benefits/reconciliation/auto', ah(async (req, res) => {
  await demand(req, ['FINANCE.UPDATE'], 'reconcile bank statements');
  const b = z.object({ bank_account_id: s.id() }).parse(req.body ?? {});
  res.json({ data: { matched: await autoMatch(req, b.bank_account_id ?? null) } });
}));
R.post('/export-benefits/reconciliation/match', ah(async (req, res) => {
  await demand(req, ['FINANCE.UPDATE'], 'reconcile bank statements');
  const b = z.object({ bank_line_id: s.idReq(), event_id: s.idReq(), amount: z.coerce.number().positive().nullish(), reason: s.nullableStr(300) }).parse(req.body ?? {});
  const id = await transaction((tx) => matchOne(tx, req, b.bank_line_id, b.event_id, b.amount ?? null, b.reason ?? null, 'MANUAL'));
  res.status(201).json({ data: { id } });
}));
R.post('/export-benefits/reconciliation/matches/:id/undo', ah(async (req, res) => {
  await demand(req, ['FINANCE.UPDATE'], 'undo a bank match');
  const cid = req.user!.companyId;
  const reason = z.object({ reason: z.string().trim().min(3, 'Give the reason').max(300) }).parse(req.body ?? {}).reason;
  await transaction(async (tx) => {
    const m = await txQueryOne<any>(tx, `SELECT * FROM trx_export_benefit_recon_match WHERE id = ? AND company_id = ? FOR UPDATE`, [Number(req.params.id), cid]);
    if (!m || m.status !== 'ACTIVE') throw NotFound('Active match not found');
    const line = await txQueryOne<any>(tx, `SELECT * FROM trx_export_benefit_bank_line WHERE id = ? FOR UPDATE`, [m.bank_line_id]);
    await txExecute(tx, `UPDATE trx_export_benefit_recon_match SET status = 'UNDONE', undone_by = ?, undone_at = NOW(), reason = CONCAT(COALESCE(reason, ''), ' | undone: ', ?) WHERE id = ?`, [req.user!.id, reason, m.id]);
    const matched = Math.max(0, r4(n(line.matched_amount) - n(m.matched_amount)));
    await txExecute(tx, `UPDATE trx_export_benefit_bank_line SET matched_amount = ?, match_status = ? WHERE id = ?`, [matched, lineStatus(n(line.amount), matched), line.id]);
    await audit(req, 'trx_export_benefit_recon_match', Number(m.id), 'UPDATE', { status: 'ACTIVE' }, { status: 'UNDONE', reason }, tx);
  });
  res.json({ data: { id: Number(req.params.id), undone: true } });
}));
R.post('/export-benefits/bank-lines/:id/ignore', ah(async (req, res) => {
  await demand(req, ['FINANCE.UPDATE'], 'reconcile bank statements');
  const cid = req.user!.companyId;
  const b = z.object({ ignore: z.boolean().default(true), reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
  const l = await queryOne<any>(`SELECT * FROM trx_export_benefit_bank_line WHERE id = ? AND company_id = ?`, [Number(req.params.id), cid]);
  if (!l) throw NotFound('Bank line not found');
  if (b.ignore) {
    if (n(l.matched_amount) > 0) throw BadRequest('The line is matched — undo the match first');
    if ((b.reason ?? '').length < 3) throw BadRequest('Give the reason', [{ field: 'reason', message: 'Required' }]);
    await execute(`UPDATE trx_export_benefit_bank_line SET match_status = 'IGNORED', ignore_reason = ? WHERE id = ?`, [b.reason, l.id]);
  } else await execute(`UPDATE trx_export_benefit_bank_line SET match_status = ?, ignore_reason = NULL WHERE id = ?`, [lineStatus(n(l.amount), n(l.matched_amount)), l.id]);
  await audit(req, 'trx_export_benefit_bank_line', Number(l.id), 'UPDATE', { match_status: l.match_status }, b);
  res.json({ data: { id: Number(l.id) } });
}));

R.get('/export-benefits/bank-lines', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ status: z.string().trim().max(40).optional(), bank_account_id: z.coerce.number().int().optional(), from: dateStr.optional(), to: dateStr.optional(),
    q: z.string().trim().max(60).optional() }).parse(clean(req.query as any));
  const w = ['l.company_id = ?']; const p: unknown[] = [cid];
  if (q.status) { w.push('l.match_status IN (?)'); p.push(q.status.split(',')); }
  if (q.bank_account_id) { w.push('l.bank_account_id = ?'); p.push(q.bank_account_id); }
  if (q.from) { w.push('l.txn_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('l.txn_date <= ?'); p.push(q.to); }
  if (q.q) { w.push('(l.reference LIKE ? OR l.narration LIKE ?)'); p.push(`%${q.q}%`, `%${q.q}%`); }
  const lines = await query<any>(`SELECT l.*, ba.account_label AS bank_label FROM trx_export_benefit_bank_line l LEFT JOIN mst_company_bank_account ba ON ba.id = l.bank_account_id
     WHERE ${w.join(' AND ')} ORDER BY l.txn_date DESC, l.id DESC LIMIT 1000`, p);
  const ms = lines.length ? await query<any>(`SELECT m.*, e.event_type, e.event_date, e.base_amount, e.bank_reference, x.id AS claim_id, s.display_name AS scheme_name, sb.sb_no, u.full_name AS matched_by_name
     FROM trx_export_benefit_recon_match m JOIN trx_export_benefit_event e ON e.id = m.event_id JOIN trx_export_incentive x ON x.id = e.claim_id JOIN mst_export_benefit_scheme s ON s.id = x.scheme_id
     LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id LEFT JOIN mst_user u ON u.id = m.matched_by WHERE m.bank_line_id IN (?) AND m.status = 'ACTIVE'`, [lines.map((l) => l.id)]) : [];
  const out = lines.map((l) => ({ ...l, txn_date: iso(l.txn_date), amount: r2(n(l.amount)), matched_amount: r2(n(l.matched_amount)), unallocated: r2(n(l.amount) - n(l.matched_amount)),
    matches: ms.filter((m) => Number(m.bank_line_id) === Number(l.id)).map((m) => ({ ...m, event_date: iso(m.event_date), matched_amount: r2(n(m.matched_amount)) })) }));
  const tot = (st: string[]) => ({ count: out.filter((l) => st.includes(l.match_status)).length, amount: r2(out.filter((l) => st.includes(l.match_status)).reduce((t, l) => t + l.unallocated, 0)) });
  res.json({ data: out, totals: { unmatched: tot(['UNMATCHED']), partial: tot(['PARTIAL']), matched: { count: out.filter((l) => l.match_status === 'MATCHED').length }, ignored: { count: out.filter((l) => l.match_status === 'IGNORED').length } } });
}));

/** Receipts not (fully) matched to a bank line, and the candidates for one line. */
R.get('/export-benefits/reconciliation/events', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ status: z.enum(['UNMATCHED', 'PARTIAL', 'MATCHED', 'OPEN', 'ALL']).default('OPEN'), bank_line_id: z.coerce.number().int().optional(),
    from: dateStr.optional(), to: dateStr.optional() }).parse(clean(req.query as any));
  const w = ['e.company_id = ?', `e.status = 'POSTED'`, 'e.event_type IN (?)']; const p: unknown[] = [cid, CASH_EVENTS];
  if (q.from) { w.push('e.event_date >= ?'); p.push(q.from); }
  if (q.to) { w.push('e.event_date <= ?'); p.push(q.to); }
  const rows = await query<any>(`SELECT e.id, e.claim_id, e.event_type, e.event_date, e.base_amount, e.bank_reference, e.bank_account_id, ba.account_label AS bank_label, s.display_name AS scheme_name, sb.sb_no,
      COALESCE((SELECT SUM(m.matched_amount) FROM trx_export_benefit_recon_match m WHERE m.event_id = e.id AND m.status = 'ACTIVE'), 0) AS matched_amount
     FROM trx_export_benefit_event e JOIN trx_export_incentive x ON x.id = e.claim_id JOIN mst_export_benefit_scheme s ON s.id = x.scheme_id
     LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id LEFT JOIN mst_company_bank_account ba ON ba.id = e.bank_account_id
    WHERE ${w.join(' AND ')} ORDER BY e.event_date DESC, e.id DESC LIMIT 2000`, p);
  let out = rows.map((e) => { const amt = r2(n(e.base_amount)); const m = r2(n(e.matched_amount)); return { ...e, event_date: iso(e.event_date), base_amount: amt, matched_amount: m,
    unmatched: r2(amt - m), match_status: lineStatus(amt, m), label: EVENT_TYPES[e.event_type]?.label }; });
  if (q.status === 'OPEN') out = out.filter((e) => e.match_status !== 'MATCHED');
  else if (q.status !== 'ALL') out = out.filter((e) => e.match_status === q.status);
  if (q.bank_line_id) {
    const l = await queryOne<any>(`SELECT * FROM trx_export_benefit_bank_line WHERE id = ? AND company_id = ?`, [q.bank_line_id, cid]);
    if (!l) throw NotFound('Bank line not found');
    const score = (e: any) => (l.reference && e.bank_reference && normRef(l.reference) === normRef(e.bank_reference) ? 100 : 0) + (Math.abs(e.unmatched - (n(l.amount) - n(l.matched_amount))) <= 0.005 ? 50 : 0)
      - Math.min(40, Math.abs(daysBetween(e.event_date, iso(l.txn_date)!) ?? 40)) + (l.bank_account_id && Number(l.bank_account_id) === Number(e.bank_account_id) ? 10 : 0);
    out = out.filter((e) => e.unmatched > 0.005).map((e) => ({ ...e, score: score(e) })).sort((a, b) => b.score - a.score).slice(0, 25);
  }
  res.json({ data: out });
}));

R.get('/export-benefits/reports/reconciliation', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const [lines, evs, scrip] = await Promise.all([
    query<any>(`SELECT match_status, COUNT(*) c, SUM(amount) amt, SUM(amount - matched_amount) open_amt FROM trx_export_benefit_bank_line WHERE company_id = ? GROUP BY match_status`, [cid]),
    query<any>(`SELECT e.base_amount, COALESCE((SELECT SUM(m.matched_amount) FROM trx_export_benefit_recon_match m WHERE m.event_id = e.id AND m.status = 'ACTIVE'), 0) matched
       FROM trx_export_benefit_event e WHERE e.company_id = ? AND e.status = 'POSTED' AND e.event_type IN (?)`, [cid, CASH_EVENTS]),
    // scrip register by scrip number (issue vs utilised / sold) — compare with the ICEGATE e-scrip ledger
    query<any>(`SELECT e.scrip_number, s.display_name AS scheme_name, SUM(IF(e.event_type IN ('SCRIP_ISSUE','TRANSFER_IN'), e.base_amount, 0)) issued,
        SUM(IF(e.event_type IN ('SCRIP_UTILISATION'), e.base_amount, 0)) utilised, SUM(IF(e.event_type IN ('SCRIP_SALE','TRANSFER_OUT'), e.base_amount, 0)) sold,
        SUM(IF(e.event_type = 'EXPIRY', e.base_amount, 0)) expired, MIN(e.event_date) first_date, MAX(e.event_date) last_date
       FROM trx_export_benefit_event e JOIN trx_export_incentive x ON x.id = e.claim_id JOIN mst_export_benefit_scheme s ON s.id = x.scheme_id
      WHERE e.company_id = ? AND e.status = 'POSTED' AND e.scrip_number IS NOT NULL AND e.event_type IN (?) GROUP BY e.scrip_number, s.id ORDER BY last_date DESC LIMIT 500`, [cid, SCRIP_EVENTS]),
  ]);
  const ev = { unmatched: { count: 0, amount: 0 }, partial: { count: 0, amount: 0 }, matched: { count: 0, amount: 0 } };
  for (const e of evs) { const st = lineStatus(n(e.base_amount), n(e.matched)).toLowerCase() as 'unmatched' | 'partial' | 'matched'; ev[st].count++; ev[st].amount = r2(ev[st].amount + n(e.base_amount) - n(e.matched)); }
  res.json({ data: { bank_lines: lines.map((l) => ({ status: l.match_status, count: n(l.c), amount: r2(n(l.amt)), unallocated: r2(n(l.open_amt)) })), receipts: ev,
    scrips: scrip.map((x) => ({ ...x, first_date: iso(x.first_date), last_date: iso(x.last_date), issued: r2(n(x.issued)), utilised: r2(n(x.utilised)), sold: r2(n(x.sold)), expired: r2(n(x.expired)),
      balance: r2(n(x.issued) - n(x.utilised) - n(x.sold) - n(x.expired)) })) } });
}));

/* ================================================================ shipping bill: add benefits to an existing SB */
const sbBenefitSchema = z.object({ benefits: z.array(z.object({ scheme_id: s.id(), scheme_code: z.string().trim().toUpperCase().max(40).nullish(),
  declared_amount: z.coerce.number().min(0, 'Cannot be negative').nullish(), currency_code: z.string().trim().toUpperCase().length(3).nullish(),
  custom_field_values: z.record(z.string(), z.unknown()).nullish(), remarks: s.nullableStr(500) })).min(1).max(20) });
R.post('/shipping-bills/:id/benefits', ah(async (req, res) => {
  await demand(req, ['EXPORT.UPDATE'], 'add benefits to a shipping bill');
  const cid = req.user!.companyId;
  const sbId = Number(req.params.id);
  const b = sbBenefitSchema.parse(req.body ?? {});
  const ids = await transaction(async (tx) => {
    const sb = await txQueryOne<any>(tx, `SELECT * FROM trx_shipping_bill WHERE id = ? AND company_id = ? FOR UPDATE`, [sbId, cid]);
    if (!sb) throw NotFound('Shipping bill not found');
    const schemes = await companySchemes(cid, tx);
    const made: number[] = [];
    for (const row of b.benefits) {
      const sc = schemes.find((x) => (row.scheme_id && x.id === row.scheme_id) || (row.scheme_code && x.code === row.scheme_code));
      if (!sc) throw BadRequest(`Benefit scheme ${row.scheme_code ?? row.scheme_id} not found`);
      if (sc.sb_field) {
        if (sc.sb_field === 'igst_amount' && Number(sb.lut)) throw BadRequest('The shipping bill is an export under LUT — no IGST refund');
        const col = ['drawback_amount', 'igst_amount', 'rodtep_amount', 'rosctl_amount'].includes(sc.sb_field) ? sc.sb_field : null;
        if (col) await txExecute(tx, `UPDATE trx_shipping_bill SET ${col} = ?, updated_by = ? WHERE id = ?`, [r2(n(row.declared_amount)), req.user!.id, sbId]);
      }
      const id = await createClaim(tx, req, { scheme: sc, shipping_bill_id: sbId, invoice_id: Number(sb.invoice_id), declared_amount: row.declared_amount ?? null, currency_code: row.currency_code,
        claim_date: iso(sb.sb_date), custom_field_values: row.custom_field_values ?? null, remarks: row.remarks ?? null, source: 'SHIPPING_BILL' });
      await audit(req, 'trx_export_incentive', id, 'INSERT', undefined, { shipping_bill_id: sbId, scheme: sc.code, ...row, via: 'add benefit' }, tx);
      made.push(id);
    }
    return made;
  });
  res.status(201).json({ data: { ids } });
}));

/* ================================================================ 23-Oct endpoints, kept as adapters over the engine */
const legacyRow = (c: any) => ({ ...c, claim_amount: n(c.declared_amount), received_amount: r2(n(c.cash_received) + n(c.sale_proceeds) + n(c.adjusted_amount)), outstanding: r2(n(c.pending_amount)),
  short_amount: c.claim_stage === 'SHORT_CLOSED' ? r2(Math.max(0, n(c.basis_amount) - n(c.cash_received) - n(c.adjusted_amount) - n(c.scrip_issued))) : 0,
  label: c.scheme_name, credit_date: c.last_event_date, receipts_count: c.events_count, pending_days: c.days_pending, legacy_status: undefined });
const legacyFilter = z.object({ status: z.string().trim().max(20).optional(), incentive_type: z.string().trim().max(40).optional(), q: z.string().trim().max(60).optional(),
  from: dateStr.optional(), to: dateStr.optional() });

R.get('/export-incentives', VIEW, ah(async (req, res) => {
  const q = legacyFilter.parse(clean(req.query as any));
  const out = await register(req.user!.companyId, regFilter.parse(clean({ pageSize: 1000, q: q.q, from: q.from, to: q.to, scheme: q.incentive_type,
    status: q.status === 'OPEN' ? 'OPEN' : q.status === 'CREDITED' || q.status === 'RECEIVED' ? 'RECEIVED,SETTLED' : q.status })));
  const rows = out.rows.map(legacyRow);
  res.json({ data: rows, totals: { claimed: r2(rows.reduce((t, r) => t + r.claim_amount, 0)), received: r2(rows.reduce((t, r) => t + r.received_amount, 0)),
    outstanding: r2(rows.reduce((t, r) => t + r.outstanding, 0)), short: r2(rows.reduce((t, r) => t + r.short_amount, 0)), scrip_available: out.totals.scrip_available } });
}));

/** Per shipping bill, one cell per scheme in use (dynamic — new schemes appear without code). */
async function tracker(cid: number, q: z.infer<typeof legacyFilter>) {
  const reg = await register(cid, regFilter.parse(clean({ pageSize: 1000, q: q.q, from: q.from, to: q.to, scheme: q.incentive_type, sort: 'sb_date' })));
  const schemes = (await companySchemes(cid)).filter((sc) => sc.is_suggested || reg.rows.some((r: any) => r.scheme_id === sc.id));
  const by = new Map<number, any>();
  for (const c of reg.rows.filter((r: any) => r.shipping_bill_id)) {
    const k = Number(c.shipping_bill_id);
    if (!by.has(k)) by.set(k, { shipping_bill_id: k, sb_no: c.sb_no, sb_date: c.sb_date, port_code: c.port_code, invoice_id: c.invoice_id, invoice_no: c.invoice_no, so_id: c.so_id, so_no: c.so_no,
      buyer_name: c.buyer_name, cells: {} as Record<string, any>, claim: 0, received: 0, scrip_issued: 0, outstanding: 0, short: 0, pending_days: null as number | null });
    const row = by.get(k);
    const cell = { ids: [c.id], claim_id: c.id, claim: n(c.declared_amount), basis: n(c.basis_amount), received: c.net_cash, adjusted: n(c.adjusted_amount), scrip_issued: n(c.scrip_issued),
      scrip_available: n(c.scrip_available), outstanding: n(c.pending_amount), excess: n(c.excess_amount), status: c.status, status_label: c.status_label, status_tone: c.status_tone,
      last_date: c.last_event_date, days_pending: c.days_pending, scrip_capable: c.scrip_capable };
    const prev = row.cells[c.scheme_code];
    row.cells[c.scheme_code] = prev ? { ...prev, ids: [...prev.ids, c.id], claim: r2(prev.claim + cell.claim), received: r2(prev.received + cell.received), outstanding: r2(prev.outstanding + cell.outstanding),
      scrip_issued: r2(prev.scrip_issued + cell.scrip_issued) } : cell;
    row.claim = r2(row.claim + cell.claim); row.received = r2(row.received + cell.received + cell.adjusted); row.scrip_issued = r2(row.scrip_issued + cell.scrip_issued);
    row.outstanding = r2(row.outstanding + cell.outstanding);
    if (c.days_pending != null) row.pending_days = Math.max(row.pending_days ?? 0, c.days_pending);
  }
  const rows = [...by.values()].map((r) => {
    const cells = Object.values(r.cells) as any[];
    const live = cells.filter((c) => c.status !== 'NOT_APPLICABLE');
    const status = !live.length ? 'NONE' : r.outstanding > 0.005 ? (live.some((c) => c.received > 0 || c.scrip_issued > 0 || c.adjusted > 0) ? 'PARTIAL' : 'PENDING') : 'RECEIVED';
    return { ...r, status };
  });
  const shown = rows.filter((r) => (q.status === 'OPEN' ? r.status === 'PENDING' || r.status === 'PARTIAL' : q.status ? r.status === q.status : r.status !== 'NONE'));
  const sumT = (code: string, k: string) => r2(shown.reduce((a, r) => a + n(r.cells[code]?.[k]), 0));
  const totals = { claim: r2(shown.reduce((a, r) => a + r.claim, 0)), received: r2(shown.reduce((a, r) => a + r.received, 0)), scrip_issued: r2(shown.reduce((a, r) => a + r.scrip_issued, 0)),
    outstanding: r2(shown.reduce((a, r) => a + r.outstanding, 0)), short: 0,
    by_type: Object.fromEntries(schemes.map((sc) => [sc.code, { claim: sumT(sc.code, 'claim'), received: sumT(sc.code, 'received'), scrip_issued: sumT(sc.code, 'scrip_issued'), outstanding: sumT(sc.code, 'outstanding') }])),
    pending_bills: shown.filter((r) => r.outstanding > 0.005).length };
  return { rows: shown, totals, types: schemes.map((sc) => ({ value: sc.code, label: sc.short_name || sc.display_name, name: sc.display_name, tracking_mode: sc.tracking_mode, scheme_id: sc.id })) };
}
R.get('/export-incentives/tracker', VIEW, ah(async (req, res) => {
  const out = await tracker(req.user!.companyId, legacyFilter.parse(clean(req.query as any)));
  res.json({ data: out.rows, totals: out.totals, types: out.types });
}));
R.get('/export-incentives/tracker.xlsx', VIEW, ah(async (req, res) => {
  const { rows, totals, types } = await tracker(req.user!.companyId, legacyFilter.parse(clean(req.query as any)));
  const head = ['SB No', 'SB Date', 'Invoice', 'Order', 'Buyer'];
  for (const t of types) head.push(`${t.label} amount`, `${t.label} ${t.tracking_mode === 'CASH' ? 'received' : 'cash / scrip'}`, `${t.label} last date`, `${t.label} status`);
  head.push('Total amount', 'Cash received', 'Scrip issued', 'Pending', 'Days pending');
  const aoa: unknown[][] = [[`EXPORT BENEFITS — RECEIVED / PENDING (as on ${todayIst()})`], [], head];
  for (const r of rows) {
    const line: unknown[] = [r.sb_no, r.sb_date, r.invoice_no, r.so_no, r.buyer_name];
    for (const t of types) { const c = r.cells[t.value]; line.push(c ? c.claim : null, c ? (t.tracking_mode === 'CASH' ? c.received : `${c.received} / ${c.scrip_issued}`) : null, c?.last_date ?? null, c ? c.status_label : '—'); }
    line.push(r.claim, r.received, r.scrip_issued, r.outstanding, r.pending_days);
    aoa.push(line);
  }
  const tl: unknown[] = ['TOTAL', '', '', '', ''];
  for (const t of types) tl.push(totals.by_type[t.value].claim, totals.by_type[t.value].received, '', '');
  tl.push(totals.claim, totals.received, totals.scrip_issued, totals.outstanding, '');
  aoa.push(tl);
  sendXlsx(res, aoa, 'Benefits', `export_benefits_${todayIst()}.xlsx`, head.length);
}));

R.get('/export-incentives/:id', VIEW, ah(async (req, res) => {
  res.json({ data: await claimDetail(req.user!.companyId, Number(req.params.id)) });
}));

/** A claim not made by a shipping bill (interest equalisation, an old SB …). */
R.post('/export-incentives', ah(async (req, res) => {
  await demand(req, ['FINANCE.CREATE', 'EXPORT.UPDATE'], 'add a benefit claim');
  const cid = req.user!.companyId;
  const b = z.object({ incentive_type: z.string().trim().toUpperCase().max(40).nullish(), scheme_id: s.id(), shipping_bill_id: s.id(), invoice_id: s.id(),
    claim_amount: z.coerce.number().min(0, 'Cannot be negative').nullish(), declared_amount: z.coerce.number().min(0, 'Cannot be negative').nullish(), claim_date: optDate,
    currency_code: z.string().trim().toUpperCase().length(3).nullish(), custom_field_values: z.record(z.string(), z.unknown()).nullish(), remarks: s.nullableStr(500) }).parse(req.body ?? {});
  await ensureSchemes(cid);
  const sc = b.scheme_id ? (await companySchemes(cid)).find((x) => x.id === b.scheme_id) : b.incentive_type ? await schemeByCode(null, cid, b.incentive_type) : null;
  if (!sc) throw BadRequest('Pick the benefit scheme');
  const amt = b.declared_amount ?? b.claim_amount ?? null;
  if (amt == null || !(amt > 0)) throw BadRequest('Enter the claim amount', [{ field: 'claim_amount', message: 'Required' }]);
  let invoiceId = b.invoice_id ?? null;
  if (b.shipping_bill_id) {
    const sb = await queryOne<any>(`SELECT id, invoice_id FROM trx_shipping_bill WHERE id = ? AND company_id = ?`, [b.shipping_bill_id, cid]);
    if (!sb) throw BadRequest('Shipping bill not found');
    invoiceId = invoiceId ?? Number(sb.invoice_id);
  }
  if (invoiceId && !(await queryOne(`SELECT id FROM trx_commercial_invoice WHERE id = ? AND company_id = ?`, [invoiceId, cid]))) throw BadRequest('Invoice not found');
  const id = await transaction((tx) => createClaim(tx, req, { scheme: sc, shipping_bill_id: b.shipping_bill_id ?? null, invoice_id: invoiceId, declared_amount: r2(amt), currency_code: b.currency_code,
    claim_date: b.claim_date ?? todayIst(), custom_field_values: b.custom_field_values ?? null, remarks: b.remarks ?? null, source: 'MANUAL' }));
  await audit(req, 'trx_export_incentive', id, 'INSERT', undefined, b);
  res.status(201).json({ data: { id } });
}));

R.put('/export-incentives/:id', ah(async (req, res) => {
  await demand(req, ['FINANCE.UPDATE', 'EXPORT.UPDATE'], 'change a benefit claim');
  if (req.body && (req.body.received_amount != null || req.body.credit_date != null || req.body.status != null)) {
    throw BadRequest('Record what is received as a receipt (date, amount, reference) — the received amount and status follow from the receipts');
  }
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ claim_amount: z.coerce.number().min(0).nullish(), claim_date: optDate, scrip_no: s.nullableStr(60), remarks: s.nullableStr(500) }).parse(req.body ?? {});
  await transaction(async (tx) => {
    const x = await lockClaim(tx, cid, id);
    if (x.source === 'SHIPPING_BILL' && b.claim_amount != null && Math.abs(n(b.claim_amount) - n(x.declared_amount)) > 0.005) throw BadRequest('This claim comes from its shipping bill — change the amount on the shipping bill');
    const decl = x.source === 'SHIPPING_BILL' || b.claim_amount == null ? x.declared_amount : r2(b.claim_amount);
    await txExecute(tx, `UPDATE trx_export_incentive SET declared_amount = ?, claim_amount = ?, claim_date = ?, remarks = ?, updated_by = ?, row_version = row_version + 1 WHERE id = ?`,
      [decl, n(decl), b.claim_date !== undefined ? b.claim_date : iso(x.claim_date), b.remarks !== undefined ? b.remarks : x.remarks, req.user!.id, id]);
    await recalcClaim(tx, id, { userId: req.user!.id, reason: 'Claim edited' });
    await audit(req, 'trx_export_incentive', id, 'UPDATE', { declared_amount: x.declared_amount, remarks: x.remarks }, b, tx);
  });
  res.json({ data: await claimDetail(cid, id) });
}));

/** 23-Oct receipt form: BANK → bank receipt (default bank account), SCRIP → scrip issue (not cash), ADJUSTED → adjustment. */
R.post('/export-incentives/:id/receipts', ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ receipt_date: dateStr, amount: z.coerce.number().positive('Enter the amount received'), mode: z.enum(['BANK', 'SCRIP', 'ADJUSTED']).default('BANK'),
    reference: s.nullableStr(80), remarks: s.nullableStr(300), bank_account_id: s.id() }).parse(req.body ?? {});
  const x = await queryOne<any>(`SELECT x.scheme_id, x.scheme_config_version, x.incentive_type FROM trx_export_incentive x WHERE x.id = ? AND x.company_id = ?`, [id, cid]);
  if (!x) throw NotFound('Incentive claim not found');
  await ensureFresh(cid);
  const x2 = await queryOne<any>(`SELECT scheme_id, scheme_config_version FROM trx_export_incentive WHERE id = ?`, [id]);
  const cfg = await claimConfig(Number(x2.scheme_id), x2.scheme_config_version == null ? null : Number(x2.scheme_config_version));
  const type = b.mode === 'SCRIP' ? 'SCRIP_ISSUE' : b.mode === 'ADJUSTED' ? 'ADJUSTMENT' : cfg.allowed_events.includes('BANK_RECEIPT') ? 'BANK_RECEIPT' : cfg.allowed_events.includes('REFUND_CREDIT') ? 'REFUND_CREDIT' : null;
  if (!type) throw BadRequest(`${cfg.display_name} is not received in the bank — record the scrip issue / sale proceeds on the benefit`);
  let bank = b.bank_account_id ?? null;
  if (!bank && EVENT_TYPES[type].bank) bank = (await queryOne<any>(`SELECT id FROM mst_company_bank_account WHERE company_id = ? AND is_active = 1 ORDER BY is_default DESC, id LIMIT 1`, [cid]))?.id ?? null;
  const out = await addEvent(req, id, eventSchema.parse({ event_type: type, event_date: b.receipt_date, amount: b.amount, bank_account_id: bank,
    bank_reference: b.mode === 'BANK' ? b.reference : null, scrip_number: b.mode === 'SCRIP' ? b.reference : null, remarks: b.remarks ?? (b.mode === 'ADJUSTED' ? 'Adjusted' : null), post: true }));
  res.status(201).json({ data: { ...(await claimDetail(cid, id)), warnings: out.warnings } });
}));
/** Removing a 23-Oct receipt reverses its event (posted events are never deleted). */
R.delete('/export-incentives/:id/receipts/:rid', ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id); const rid = Number(req.params.rid);
  const e = await queryOne<any>(`SELECT id, status FROM trx_export_benefit_event WHERE id = ? AND claim_id = ? AND company_id = ?`, [rid, id, cid]);
  if (!e) throw NotFound('Receipt not found');
  if (e.status === 'DRAFT') { await demand(req, ['FINANCE.UPDATE'], 'delete a draft'); await execute(`DELETE FROM trx_export_benefit_event WHERE id = ?`, [rid]); }
  else await reverseEvent(req, rid, String(req.query.reason ?? 'Removed from the incentive screen'));
  res.json({ data: await claimDetail(cid, id) });
}));
R.post('/export-incentives/:id/close', ah(async (req, res) => {
  await demand(req, ['FINANCE.UPDATE', 'EXPORT.UPDATE'], 'close a benefit claim');
  const b = z.object({ action: z.enum(['SHORT_CLOSE', 'REJECT', 'REOPEN', 'QUERY']), reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
  await stageAction(req, Number(req.params.id), { action: b.action, reason: b.reason });
  res.json({ data: await claimDetail(req.user!.companyId, Number(req.params.id)) });
}));
R.delete('/export-incentives/:id', ah(async (req, res) => {
  await demand(req, ['FINANCE.DELETE'], 'delete a benefit claim');
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_export_incentive WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!cur) throw NotFound('Incentive claim not found');
    if (cur.source === 'SHIPPING_BILL') throw BadRequest('This claim belongs to its shipping bill — change the amount there');
    if (await postedCount(tx, [id])) throw BadRequest('Receipts / events are posted on this claim — it stays (reverse the events if they were wrong)');
    await deleteClaims(tx, [id]);
    await audit(req, 'trx_export_incentive', id, 'DELETE', cur, undefined, tx);
  });
  res.json({ data: { id, deleted: true } });
}));
