import type { Request } from 'express';
import { query, queryOne, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../core/errors.js';

/**
 * Export benefits engine (client voice note 24-Oct-2026 + specs v1 "Receipt Tracking" / v2 "Configurable Schemes").
 *
 * One claim row (trx_export_incentive) per shipping bill + scheme; every money / scrip movement is a dated event
 * (trx_export_benefit_event). Balances and the derived status come only from POSTED events, recalculated in the
 * same transaction that changes them (recalcClaim). A claim keeps the scheme configuration version it was created with,
 * so later master edits never change the meaning of history.
 */

export const n = (v: unknown) => Number(v ?? 0) || 0;
export const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export const r4 = (v: number) => Math.round((v + Number.EPSILON) * 10000) / 10000;
export const iso = (d: unknown) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
export const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
export const daysBetween = (from: string | null, to: string) => (from ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) : null);
const parseJson = <T>(v: unknown, d: T): T => { if (v == null) return d; if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return d; } } return v as T; };

/* ================================================================ vocabulary (served to the UI by /export-benefits/meta) */
export const TRACKING_MODES = ['CASH', 'SCRIP', 'NON_CASH', 'HYBRID'] as const;
export type TrackingMode = typeof TRACKING_MODES[number];
export const TRACKING_LABEL: Record<string, string> = { CASH: 'Cash receivable', SCRIP: 'Scrip lifecycle', NON_CASH: 'Non-cash credit', HYBRID: 'Hybrid (cash + scrip)' };
export const CATEGORIES = ['DUTY_DRAWBACK', 'CASH_REFUND', 'SCRIP', 'CREDIT', 'REBATE', 'OTHER'] as const;
export const CATEGORY_LABEL: Record<string, string> = { DUTY_DRAWBACK: 'Duty drawback', CASH_REFUND: 'Cash refund', SCRIP: 'Scrip', CREDIT: 'Credit', REBATE: 'Rebate', OTHER: 'Other' };
export const SETTLEMENT_BASES = ['DECLARED', 'CLAIMED', 'APPROVED'] as const;
export const BASIS_LABEL: Record<string, string> = { DECLARED: 'Declared (shipping bill)', CLAIMED: 'Claimed amount', APPROVED: 'Approved / sanctioned amount' };
export const AGEING_BASES = ['SB_DATE', 'LEO_DATE', 'CLAIM_FILED', 'APPROVAL'] as const;
export const AGEING_LABEL: Record<string, string> = { SB_DATE: 'Shipping bill date', LEO_DATE: 'LEO date', CLAIM_FILED: 'Claim filed date', APPROVAL: 'Approval date' };
export const POLICIES = ['EXCLUDE', 'ACCRUE_BASIS', 'REALISED_ONLY', 'APPROVED_ONLY'] as const;
export const POLICY_LABEL: Record<string, string> = {
  EXCLUDE: 'Exclude from order profit',
  ACCRUE_BASIS: 'Basis amount while open, settled value once closed',
  REALISED_ONLY: 'Only realised (cash, sale proceeds, adjusted, scrip utilised)',
  APPROVED_ONLY: 'Only once approved (approved amount, settled value once closed)',
};
export const CLAIM_STAGES = ['ENTERED', 'FILED', 'QUERY', 'APPROVED', 'REJECTED', 'SHORT_CLOSED'] as const;

type EvKind = 'CASH' | 'PROCEEDS' | 'ADJUST' | 'SCRIP_IN' | 'TRANSFER_IN' | 'SCRIP_OUT' | 'CLAIM' | 'APPROVAL' | 'REVERSAL';
export const EVENT_TYPES: Record<string, { label: string; kind: EvKind; modes: TrackingMode[]; bank?: boolean; scrip?: boolean; reason?: boolean; settles?: boolean }> = {
  BANK_RECEIPT:      { label: 'Bank receipt', kind: 'CASH', modes: ['CASH', 'HYBRID'], bank: true, settles: true },
  REFUND_CREDIT:     { label: 'Refund credit', kind: 'CASH', modes: ['CASH', 'HYBRID'], bank: true, settles: true },
  SCRIP_ISSUE:       { label: 'Scrip / credit issued', kind: 'SCRIP_IN', modes: ['SCRIP', 'NON_CASH', 'HYBRID'], scrip: true, settles: true },
  SCRIP_UTILISATION: { label: 'Scrip utilised', kind: 'SCRIP_OUT', modes: ['SCRIP', 'NON_CASH', 'HYBRID'], scrip: true },
  SCRIP_SALE:        { label: 'Scrip sold', kind: 'SCRIP_OUT', modes: ['SCRIP', 'HYBRID'], scrip: true },
  SALE_PROCEEDS:     { label: 'Scrip sale proceeds (cash)', kind: 'PROCEEDS', modes: ['SCRIP', 'HYBRID'], bank: true },
  TRANSFER_IN:       { label: 'Scrip transfer in', kind: 'TRANSFER_IN', modes: ['SCRIP', 'NON_CASH', 'HYBRID'], scrip: true },
  TRANSFER_OUT:      { label: 'Scrip transfer out', kind: 'SCRIP_OUT', modes: ['SCRIP', 'NON_CASH', 'HYBRID'], scrip: true },
  EXPIRY:            { label: 'Scrip expired / lapsed', kind: 'SCRIP_OUT', modes: ['SCRIP', 'NON_CASH', 'HYBRID'], reason: true },
  ADJUSTMENT:        { label: 'Adjustment (set-off)', kind: 'ADJUST', modes: ['CASH', 'SCRIP', 'NON_CASH', 'HYBRID'], reason: true, settles: true },
  CLAIM_FILED:       { label: 'Claim filed', kind: 'CLAIM', modes: ['CASH', 'SCRIP', 'NON_CASH', 'HYBRID'] },
  APPROVAL:          { label: 'Approved / sanctioned', kind: 'APPROVAL', modes: ['CASH', 'SCRIP', 'NON_CASH', 'HYBRID'] },
  REVERSAL:          { label: 'Reversal', kind: 'REVERSAL', modes: ['CASH', 'SCRIP', 'NON_CASH', 'HYBRID'], reason: true },
};
export const CASH_EVENTS = ['BANK_RECEIPT', 'REFUND_CREDIT', 'SALE_PROCEEDS'];
export const SCRIP_EVENTS = Object.keys(EVENT_TYPES).filter((k) => ['SCRIP_IN', 'SCRIP_OUT', 'TRANSFER_IN'].includes(EVENT_TYPES[k].kind));

export const STATUS_META: Record<string, { label: string; tone: string }> = {
  ENTERED: { label: 'Pending', tone: 'amber' }, FILED: { label: 'Filed · pending', tone: 'amber' }, APPROVED: { label: 'Approved · pending', tone: 'amber' },
  QUERY: { label: 'Under query', tone: 'violet' }, PART_RECEIVED: { label: 'Part received', tone: 'blue' }, RECEIVED: { label: 'Received', tone: 'green' },
  NOT_ISSUED: { label: 'Scrip not issued', tone: 'amber' }, SCRIP_PART_ISSUED: { label: 'Scrip partially issued', tone: 'blue' },
  SCRIP_ISSUED: { label: 'Scrip issued', tone: 'indigo' }, PART_UTILISED: { label: 'Part utilised / sold', tone: 'indigo' }, SETTLED: { label: 'Settled', tone: 'green' },
  SHORT_CLOSED: { label: 'Short-closed', tone: 'slate' }, REJECTED: { label: 'Rejected', tone: 'red' }, NOT_APPLICABLE: { label: 'Not applicable', tone: 'gray' },
};
/** Statuses where something is still to come (the "pending" filter). */
export const OPEN_STATUSES = ['ENTERED', 'FILED', 'APPROVED', 'QUERY', 'PART_RECEIVED', 'NOT_ISSUED', 'SCRIP_PART_ISSUED'];

/* ================================================================ settings */
export async function setting(cid: number, key: string, dflt: string, tx?: Tx): Promise<string> {
  const sql = `SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = ?`;
  const r = tx ? await txQueryOne<any>(tx, sql, [cid, key]) : await queryOne<any>(sql, [cid, key]);
  return r?.v != null && r.v !== '' ? String(r.v) : dflt;
}
export const tolerance = async (cid: number, tx?: Tx) => Math.max(0, n(await setting(cid, 'EXPORT_BENEFIT_TOLERANCE', '1', tx)));

/* ================================================================ scheme configuration */
export interface CustomField {
  key: string; label: string; type: 'text' | 'number' | 'date' | 'select' | 'checkbox'; required?: boolean; applies_to: 'CLAIM' | 'EVENT';
  options?: string[]; min?: number | null; max?: number | null; max_length?: number | null; pattern?: string | null; event_types?: string[]; help?: string | null;
}
export interface RequiredDoc { doc_type: string; label: string; stage: 'CLAIM' | 'RECEIPT' | 'SCRIP' | 'SETTLEMENT'; policy: 'WARN' | 'BLOCK'; event_types?: string[] }
export interface SchemeConfig {
  id: number; code: string; display_name: string; short_name: string | null; description: string | null; category: string; tracking_mode: TrackingMode;
  default_currency: string; effective_from: string | null; effective_to: string | null; default_status: string;
  allowed_events: string[]; required_documents: RequiredDoc[]; custom_fields: CustomField[];
  settlement_basis: string; ageing_basis: string; profitability_policy: string; ledger_account_id: number | null; sb_field: string | null;
  is_suggested: number; allow_multiple: number; sort_order: number; is_active: number; config_version: number;
}
export const CONFIG_KEYS = ['code', 'display_name', 'short_name', 'description', 'category', 'tracking_mode', 'default_currency', 'effective_from', 'effective_to', 'default_status',
  'allowed_events', 'required_documents', 'custom_fields', 'settlement_basis', 'ageing_basis', 'profitability_policy', 'ledger_account_id', 'sb_field', 'is_suggested',
  'allow_multiple', 'sort_order', 'is_active'] as const;

export function schemeOut(r: any): SchemeConfig {
  return {
    ...r, id: Number(r.id), effective_from: iso(r.effective_from), effective_to: iso(r.effective_to),
    allowed_events: parseJson<string[]>(r.allowed_events, []), required_documents: parseJson<RequiredDoc[]>(r.required_documents, []),
    custom_fields: parseJson<CustomField[]>(r.custom_fields, []), is_suggested: Number(r.is_suggested), allow_multiple: Number(r.allow_multiple),
    sort_order: Number(r.sort_order), is_active: Number(r.is_active), config_version: Number(r.config_version), ledger_account_id: r.ledger_account_id == null ? null : Number(r.ledger_account_id),
  };
}
export const snapshotOf = (c: SchemeConfig) => Object.fromEntries(CONFIG_KEYS.map((k) => [k, (c as any)[k] ?? null]));

/**
 * Semantic validation of a scheme configuration (spec v2 §4.2 / §17): blocks activation of an incomplete or
 * inconsistent scheme with actionable, field-level messages.
 */
export function validateSchemeConfig(c: Partial<SchemeConfig>): { field: string; message: string }[] {
  const e: { field: string; message: string }[] = [];
  if (!c.code || !/^[A-Z][A-Z0-9_]{1,39}$/.test(c.code)) e.push({ field: 'code', message: 'Code: 2–40 capitals, digits or _ (starts with a letter)' });
  if (!c.display_name?.trim()) e.push({ field: 'display_name', message: 'Display name is required' });
  if (!TRACKING_MODES.includes(c.tracking_mode as TrackingMode)) e.push({ field: 'tracking_mode', message: 'Pick a tracking mode' });
  if (!SETTLEMENT_BASES.includes(c.settlement_basis as any)) e.push({ field: 'settlement_basis', message: 'Pick the settlement basis' });
  if (!AGEING_BASES.includes(c.ageing_basis as any)) e.push({ field: 'ageing_basis', message: 'Pick the ageing basis' });
  if (!POLICIES.includes(c.profitability_policy as any)) e.push({ field: 'profitability_policy', message: 'Pick the order-profit treatment' });
  if (c.default_currency && !/^[A-Z]{3}$/.test(c.default_currency)) e.push({ field: 'default_currency', message: 'Currency: 3-letter code' });
  if (c.effective_from && c.effective_to && c.effective_to < c.effective_from) e.push({ field: 'effective_to', message: 'Effective to is before effective from' });
  const ev = c.allowed_events ?? [];
  if (!ev.length) e.push({ field: 'allowed_events', message: 'Select the events this scheme allows' });
  for (const t of ev) {
    const m = EVENT_TYPES[t];
    if (!m) e.push({ field: 'allowed_events', message: `Unknown event type ${t}` });
    else if (c.tracking_mode && !m.modes.includes(c.tracking_mode as TrackingMode)) e.push({ field: 'allowed_events', message: `${m.label} is not possible with tracking mode ${TRACKING_LABEL[c.tracking_mode] ?? c.tracking_mode}` });
  }
  const settles = ev.filter((t) => EVENT_TYPES[t]?.settles && t !== 'ADJUSTMENT');
  if (ev.length && !settles.length) e.push({ field: 'allowed_events', message: c.tracking_mode === 'CASH' ? 'A cash scheme needs Bank receipt or Refund credit' : 'Add the event that settles the benefit (receipt or scrip issue)' });
  if ((c.tracking_mode === 'SCRIP' || c.tracking_mode === 'NON_CASH') && !ev.includes('SCRIP_ISSUE')) e.push({ field: 'allowed_events', message: 'A scrip / credit scheme needs Scrip issued' });
  if (ev.includes('SALE_PROCEEDS') && !ev.includes('SCRIP_SALE')) e.push({ field: 'allowed_events', message: 'Sale proceeds needs Scrip sold' });
  const keys = new Set<string>();
  (c.custom_fields ?? []).forEach((f, i) => {
    const at = `custom_fields.${i}`;
    if (!f.key || !/^[a-z][a-z0-9_]{0,39}$/.test(f.key)) e.push({ field: `${at}.key`, message: `Field ${i + 1}: key must be lower-case letters, digits or _` });
    else if (keys.has(f.key)) e.push({ field: `${at}.key`, message: `Field key ${f.key} is used twice` });
    keys.add(f.key);
    if (!f.label?.trim()) e.push({ field: `${at}.label`, message: `Field ${i + 1}: label is required` });
    if (!['text', 'number', 'date', 'select', 'checkbox'].includes(f.type)) e.push({ field: `${at}.type`, message: `Field ${i + 1}: unknown type` });
    if (!['CLAIM', 'EVENT'].includes(f.applies_to)) e.push({ field: `${at}.applies_to`, message: `Field ${i + 1}: applies to claim or event` });
    if (f.type === 'select' && !(f.options ?? []).filter((o) => String(o).trim()).length) e.push({ field: `${at}.options`, message: `Field ${f.label || i + 1}: a dropdown needs options` });
    if (f.min != null && f.max != null && Number(f.min) > Number(f.max)) e.push({ field: `${at}.min`, message: `Field ${f.label || i + 1}: min is more than max` });
    if (f.pattern) { try { new RegExp(f.pattern); } catch { e.push({ field: `${at}.pattern`, message: `Field ${f.label || i + 1}: the pattern is not a valid expression` }); } }
    for (const t of f.event_types ?? []) if (!ev.includes(t)) e.push({ field: `${at}.event_types`, message: `Field ${f.label || i + 1}: event ${t} is not allowed by the scheme` });
  });
  (c.required_documents ?? []).forEach((d, i) => {
    const at = `required_documents.${i}`;
    if (!d.doc_type || !/^[A-Z0-9_]{2,40}$/.test(d.doc_type)) e.push({ field: `${at}.doc_type`, message: `Document ${i + 1}: type code in capitals (e.g. BANK_ADVICE)` });
    if (!d.label?.trim()) e.push({ field: `${at}.label`, message: `Document ${i + 1}: label is required` });
    if (!['CLAIM', 'RECEIPT', 'SCRIP', 'SETTLEMENT'].includes(d.stage)) e.push({ field: `${at}.stage`, message: `Document ${i + 1}: pick when it is required` });
    if (!['WARN', 'BLOCK'].includes(d.policy)) e.push({ field: `${at}.policy`, message: `Document ${i + 1}: warn or block` });
  });
  return e;
}

/** Validate dynamic field values against the configuration (server side — never trust the client). */
export function validateCustomValues(fields: CustomField[], appliesTo: 'CLAIM' | 'EVENT', eventType: string | null, values: Record<string, unknown> | null | undefined) {
  const errors: { field: string; message: string }[] = [];
  const out: Record<string, unknown> = {};
  const defs = fields.filter((f) => f.applies_to === appliesTo && (appliesTo === 'CLAIM' || !f.event_types?.length || (eventType && f.event_types.includes(eventType))));
  const v = values ?? {};
  for (const k of Object.keys(v)) if (!defs.some((f) => f.key === k)) errors.push({ field: `custom.${k}`, message: `${k} is not a field of this scheme${appliesTo === 'EVENT' ? ' / event' : ''}` });
  for (const f of defs) {
    const raw = v[f.key];
    const blank = raw == null || raw === '' || (f.type === 'checkbox' && raw === false && f.required);
    if (blank) { if (f.required) errors.push({ field: `custom.${f.key}`, message: `${f.label} is required` }); continue; }
    if (f.type === 'number') {
      const x = Number(raw);
      if (!Number.isFinite(x)) { errors.push({ field: `custom.${f.key}`, message: `${f.label} must be a number` }); continue; }
      if (f.min != null && x < Number(f.min)) errors.push({ field: `custom.${f.key}`, message: `${f.label} must be at least ${f.min}` });
      if (f.max != null && x > Number(f.max)) errors.push({ field: `custom.${f.key}`, message: `${f.label} must be at most ${f.max}` });
      out[f.key] = x;
    } else if (f.type === 'date') {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) errors.push({ field: `custom.${f.key}`, message: `${f.label}: use YYYY-MM-DD` });
      else out[f.key] = raw;
    } else if (f.type === 'checkbox') {
      out[f.key] = raw === true || raw === 1 || raw === '1' || raw === 'true';
    } else if (f.type === 'select') {
      if (!(f.options ?? []).includes(String(raw))) errors.push({ field: `custom.${f.key}`, message: `${f.label}: pick one of ${(f.options ?? []).join(', ')}` });
      else out[f.key] = String(raw);
    } else {
      const sv = String(raw).trim();
      if (sv.length > (f.max_length ?? 200)) errors.push({ field: `custom.${f.key}`, message: `${f.label}: at most ${f.max_length ?? 200} characters` });
      if (f.pattern) { try { if (!new RegExp(`^(?:${f.pattern})$`).test(sv)) errors.push({ field: `custom.${f.key}`, message: `${f.label}: not in the expected format` }); } catch { /* invalid pattern blocked at activation */ } }
      out[f.key] = sv;
    }
  }
  return { errors, values: Object.keys(out).length ? out : null };
}

/** The scheme configuration a claim uses (its own version snapshot; the live scheme when no snapshot exists). */
export async function claimConfig(schemeId: number, version: number | null, tx?: Tx): Promise<SchemeConfig> {
  const live = tx ? await txQueryOne<any>(tx, `SELECT * FROM mst_export_benefit_scheme WHERE id = ?`, [schemeId]) : await queryOne<any>(`SELECT * FROM mst_export_benefit_scheme WHERE id = ?`, [schemeId]);
  if (!live) throw NotFound('Benefit scheme not found');
  const cur = schemeOut(live);
  if (version == null || version === cur.config_version) return cur;
  const sql = `SELECT snapshot FROM log_export_benefit_scheme WHERE scheme_id = ? AND config_version = ? ORDER BY id DESC LIMIT 1`;
  const snap = tx ? await txQueryOne<any>(tx, sql, [schemeId, version]) : await queryOne<any>(sql, [schemeId, version]);
  if (!snap) return cur;
  return schemeOut({ ...live, ...parseJson<Record<string, unknown>>(snap.snapshot, {}), id: live.id, config_version: version, is_active: live.is_active });
}

/* ================================================================ recalculation */
/**
 * Balances + derived status of one claim from its POSTED events (reversed events and reversal rows cancel out).
 * Cash: net cash = bank receipts + refund credits; pending = basis − (cash + adjusted [+ scrip issued for hybrid]).
 * Scrip: issued / available / utilised / sold / expired kept apart; a scrip issue is never cash and never "Received".
 */
export async function recalcClaim(tx: Tx, id: number, opts: { userId?: number | null; reason?: string | null; eventId?: number | null } = {}) {
  const x = await txQueryOne<any>(tx, `SELECT x.*, sb.sb_date, sb.leo_date FROM trx_export_incentive x LEFT JOIN trx_shipping_bill sb ON sb.id = x.shipping_bill_id WHERE x.id = ? FOR UPDATE`, [id]);
  if (!x) return;
  const cfg = x.scheme_id ? await claimConfig(Number(x.scheme_id), x.scheme_config_version == null ? null : Number(x.scheme_config_version), tx) : null;
  const tol = await tolerance(Number(x.company_id), tx);
  const evs = await txQuery<any>(tx, `SELECT id, event_type, event_date, base_amount, scrip_number, source_document_no FROM trx_export_benefit_event
     WHERE claim_id = ? AND status = 'POSTED' AND event_type <> 'REVERSAL' ORDER BY event_date, id`, [id]);
  const sum = (types: string[]) => r4(evs.filter((e) => types.includes(e.event_type)).reduce((t, e) => t + n(e.base_amount), 0));
  const cash = sum(['BANK_RECEIPT', 'REFUND_CREDIT']); const proceeds = sum(['SALE_PROCEEDS']); const adjusted = sum(['ADJUSTMENT']);
  const issued = sum(['SCRIP_ISSUE']); const tin = sum(['TRANSFER_IN']); const utilised = sum(['SCRIP_UTILISATION']);
  const sold = sum(['SCRIP_SALE', 'TRANSFER_OUT']); const expired = sum(['EXPIRY']);
  const available = r4(issued + tin - utilised - sold - expired);
  const lastOf = (types: string[]) => evs.filter((e) => types.includes(e.event_type)).pop();
  const filed = lastOf(['CLAIM_FILED']); const appr = lastOf(['APPROVAL']);
  const claimed = filed ? n(filed.base_amount) : null; const approved = appr ? n(appr.base_amount) : null;
  const declared = x.declared_amount == null ? null : n(x.declared_amount);
  const basisRule = cfg?.settlement_basis ?? 'DECLARED';
  let basis: number | null = declared; let basisSource: string | null = declared == null ? null : 'DECLARED';
  if (basisRule === 'APPROVED') { if (approved != null) { basis = approved; basisSource = 'APPROVED'; } else if (claimed != null) { basis = claimed; basisSource = 'CLAIMED'; } }
  if (basisRule === 'CLAIMED' && claimed != null) { basis = claimed; basisSource = 'CLAIMED'; }

  let stage: string = x.claim_stage ?? 'ENTERED';
  if (!['REJECTED', 'SHORT_CLOSED', 'QUERY'].includes(stage)) stage = approved != null ? 'APPROVED' : claimed != null ? 'FILED' : 'ENTERED';
  const mode = (cfg?.tracking_mode ?? 'CASH') as TrackingMode;
  const settled = r4(cash + adjusted + issued);
  const na = x.applicability === 'NOT_APPLICABLE';
  const closedShort = stage === 'SHORT_CLOSED';
  const full = basis != null && basis > tol && settled >= basis - tol;
  const scripish = mode === 'SCRIP' || mode === 'NON_CASH' || (mode === 'HYBRID' && issued + tin > 0);
  let status: string;
  if (na) status = 'NOT_APPLICABLE';
  else if (stage === 'REJECTED') status = 'REJECTED';
  else if (!scripish) status = full ? 'RECEIVED' : closedShort ? 'SHORT_CLOSED' : cash + adjusted > 0 ? 'PART_RECEIVED' : stage;
  else {
    const consumed = utilised + sold + expired;
    if (issued + tin <= 0) status = closedShort ? 'SHORT_CLOSED' : stage === 'QUERY' ? 'QUERY' : full ? 'SETTLED' : 'NOT_ISSUED';
    else if (!full && !closedShort) status = 'SCRIP_PART_ISSUED';
    else if (available <= tol) status = 'SETTLED';
    else if (consumed > 0) status = 'PART_UTILISED';
    else status = 'SCRIP_ISSUED';
  }
  const closed = na || stage === 'REJECTED' || closedShort;
  const pending = closed || basis == null ? 0 : Math.max(0, r4(basis - settled));
  const excess = basis == null ? 0 : Math.max(0, r4(settled - basis));
  const pendingOut = pending > tol ? pending : 0;
  const valueEvents = evs.filter((e) => !['CLAIM_FILED', 'APPROVAL'].includes(e.event_type));
  const lastEvent = valueEvents.length ? iso(valueEvents[valueEvents.length - 1].event_date) : null;
  const cashEvs = evs.filter((e) => ['BANK_RECEIPT', 'REFUND_CREDIT', 'SALE_PROCEEDS', 'ADJUSTMENT'].includes(e.event_type));
  const creditDate = cashEvs.length ? iso(cashEvs[cashEvs.length - 1].event_date) : null;
  const scripNo = lastOf(['SCRIP_ISSUE'])?.scrip_number ?? x.scrip_no ?? null;
  const sbDate = iso(x.sb_date) ?? iso(x.claim_date);
  const ageing = cfg?.ageing_basis ?? 'SB_DATE';
  const ageingDate = ageing === 'LEO_DATE' ? iso(x.leo_date) ?? sbDate
    : ageing === 'CLAIM_FILED' ? (filed ? iso(filed.event_date) : null) ?? sbDate
      : ageing === 'APPROVAL' ? (appr ? iso(appr.event_date) : null) ?? (filed ? iso(filed.event_date) : null) ?? sbDate : sbDate;
  const legacy = na ? 'NOT_APPLICABLE' : stage === 'REJECTED' ? 'REJECTED' : ['RECEIVED', 'SETTLED'].includes(status) || (pendingOut === 0 && settled > 0 && !closedShort) ? 'CREDITED'
    : closedShort ? 'SHORT_CLOSED' : settled > 0 ? 'PARTIAL' : 'CLAIMED';
  await txExecute(tx, `UPDATE trx_export_incentive SET claimed_amount = ?, claim_filed_date = ?, approved_amount = ?, approved_date = ?, approval_ref = ?, claim_stage = ?,
      basis_amount = ?, basis_source = ?, cash_received = ?, sale_proceeds = ?, adjusted_amount = ?, scrip_issued = ?, scrip_available = ?, scrip_utilised = ?, scrip_sold = ?,
      scrip_expired = ?, pending_amount = ?, excess_amount = ?, last_event_date = ?, ageing_date = ?, benefit_status = ?, status = ?, received_amount = ?, credit_date = ?, scrip_no = ?
     WHERE id = ?`,
  [claimed, filed ? iso(filed.event_date) : null, approved, appr ? iso(appr.event_date) : null, appr?.source_document_no ?? null, stage,
    basis, basisSource, cash, proceeds, adjusted, issued, available, utilised, sold, expired, pendingOut, excess > tol ? excess : 0, lastEvent, ageingDate, status, legacy,
    r2(cash + proceeds + adjusted), creditDate, scripNo ? String(scripNo).slice(0, 60) : null, id]);
  if (x.benefit_status && x.benefit_status !== status) {
    await txExecute(tx, `INSERT INTO log_export_benefit_status (company_id, claim_id, old_status, new_status, reason, event_id, changed_by) VALUES (?,?,?,?,?,?,?)`,
      [x.company_id, id, x.benefit_status, status, opts.reason ?? null, opts.eventId ?? null, opts.userId ?? null]);
  }
  return status;
}

/** Claims whose derived values were never calculated (made before migration 144, or reset by it). */
export async function ensureFresh(cid: number) {
  const stale = await query<any>(`SELECT id FROM trx_export_incentive WHERE company_id = ? AND (benefit_status IS NULL OR scheme_id IS NULL) LIMIT 2000`, [cid]);
  if (!stale.length) return;
  const { transaction } = await import('../../config/db.js');
  for (const s of stale) {
    await transaction(async (tx) => {
      const x = await txQueryOne<any>(tx, `SELECT id, company_id, incentive_type, scheme_id FROM trx_export_incentive WHERE id = ? FOR UPDATE`, [s.id]);
      if (!x) return;
      if (!x.scheme_id) {
        const sc = await schemeByCode(tx, cid, x.incentive_type) ?? await schemeByCode(tx, cid, 'OTHER');
        if (sc) await txExecute(tx, `UPDATE trx_export_incentive SET scheme_id = ?, scheme_config_version = ?, declared_amount = COALESCE(declared_amount, claim_amount) WHERE id = ?`, [sc.id, sc.config_version, x.id]);
      }
      await recalcClaim(tx, Number(x.id));
    });
  }
}

export async function schemeByCode(tx: Tx | null, cid: number, code: string) {
  const sql = `SELECT * FROM mst_export_benefit_scheme WHERE company_id = ? AND code = ?`;
  const r = tx ? await txQueryOne<any>(tx, sql, [cid, code]) : await queryOne<any>(sql, [cid, code]);
  return r ? schemeOut(r) : null;
}

/** Seed the standard schemes for a company that has none (a company created after migration 144). */
export async function ensureSchemes(cid: number) {
  const c = await queryOne<any>(`SELECT COUNT(*) c FROM mst_export_benefit_scheme WHERE company_id = ?`, [cid]);
  if (n(c?.c) > 0) return;
  const { transaction } = await import('../../config/db.js');
  await transaction(async (tx) => {
    for (const s of STANDARD_SCHEMES) {
      const r = await txExecute(tx, `INSERT IGNORE INTO mst_export_benefit_scheme (company_id, code, display_name, short_name, description, category, tracking_mode, allowed_events, custom_fields,
          settlement_basis, ageing_basis, profitability_policy, sb_field, is_suggested, sort_order) VALUES (?,?,?,?,?,?,?,?,?, 'DECLARED', 'SB_DATE', ?,?,?,?)`,
      [cid, s.code, s.display_name, s.short_name, s.description, s.category, s.tracking_mode, JSON.stringify(s.allowed_events), JSON.stringify(s.custom_fields ?? []),
        s.profitability_policy, s.sb_field, s.is_suggested, s.sort_order]);
      if (r.insertId) {
        const row = schemeOut(await txQueryOne<any>(tx, `SELECT * FROM mst_export_benefit_scheme WHERE id = ?`, [r.insertId]));
        await txExecute(tx, `INSERT INTO log_export_benefit_scheme (company_id, scheme_id, config_version, change_type, snapshot, reason) VALUES (?,?,1,'CREATE',?, 'Seeded')`,
          [cid, row.id, JSON.stringify(snapshotOf(row))]);
      }
    }
  });
}
const SCRIP_EVS = ['CLAIM_FILED', 'APPROVAL', 'SCRIP_ISSUE', 'SCRIP_UTILISATION', 'SCRIP_SALE', 'SALE_PROCEEDS', 'TRANSFER_IN', 'TRANSFER_OUT', 'EXPIRY', 'ADJUSTMENT', 'REVERSAL'];
const STANDARD_SCHEMES = [
  { code: 'DUTY_DRAWBACK', display_name: 'Duty Drawback (DBK)', short_name: 'DBK', description: 'All-industry drawback credited by customs to the bank (scroll)', category: 'DUTY_DRAWBACK', tracking_mode: 'CASH',
    allowed_events: ['CLAIM_FILED', 'APPROVAL', 'BANK_RECEIPT', 'ADJUSTMENT', 'REVERSAL'], profitability_policy: 'ACCRUE_BASIS', sb_field: 'drawback_amount', is_suggested: 1, sort_order: 10,
    custom_fields: [{ key: 'scroll_no', label: 'DBK scroll no', type: 'text', required: false, applies_to: 'EVENT', event_types: ['BANK_RECEIPT'], max_length: 40 }] },
  { code: 'GST_REFUND', display_name: 'IGST Refund', short_name: 'IGST', description: 'IGST paid on export goods, refunded by customs / GSTN to the bank', category: 'CASH_REFUND', tracking_mode: 'CASH',
    allowed_events: ['CLAIM_FILED', 'APPROVAL', 'REFUND_CREDIT', 'BANK_RECEIPT', 'ADJUSTMENT', 'REVERSAL'], profitability_policy: 'EXCLUDE', sb_field: 'igst_amount', is_suggested: 1, sort_order: 20 },
  { code: 'ROSCTL', display_name: 'RoSCTL', short_name: 'RoSCTL', description: 'Rebate of State and Central Taxes and Levies — issued as an e-scrip (ICEGATE ledger)', category: 'SCRIP', tracking_mode: 'SCRIP',
    allowed_events: SCRIP_EVS, profitability_policy: 'ACCRUE_BASIS', sb_field: 'rosctl_amount', is_suggested: 1, sort_order: 30 },
  { code: 'RODTEP', display_name: 'RoDTEP', short_name: 'RoDTEP', description: 'Remission of Duties and Taxes on Exported Products — issued as an e-scrip (ICEGATE ledger)', category: 'SCRIP', tracking_mode: 'SCRIP',
    allowed_events: SCRIP_EVS, profitability_policy: 'ACCRUE_BASIS', sb_field: 'rodtep_amount', is_suggested: 1, sort_order: 40 },
  { code: 'INTEREST_EQUAL', display_name: 'Interest Equalisation', short_name: 'IES', description: 'Interest equalisation on pre / post shipment credit (bank)', category: 'CREDIT', tracking_mode: 'CASH',
    allowed_events: ['CLAIM_FILED', 'APPROVAL', 'BANK_RECEIPT', 'ADJUSTMENT', 'REVERSAL'], profitability_policy: 'EXCLUDE', sb_field: null, is_suggested: 0, sort_order: 50 },
  { code: 'OTHER', display_name: 'Other Export Incentive', short_name: 'Other', description: 'Any other export incentive (legacy claims)', category: 'OTHER', tracking_mode: 'CASH',
    allowed_events: ['CLAIM_FILED', 'APPROVAL', 'BANK_RECEIPT', 'ADJUSTMENT', 'REVERSAL'], profitability_policy: 'EXCLUDE', sb_field: null, is_suggested: 0, sort_order: 90 },
] as { code: string; display_name: string; short_name: string; description: string; category: string; tracking_mode: string; allowed_events: string[];
  profitability_policy: string; sb_field: string | null; is_suggested: number; sort_order: number; custom_fields?: unknown[] }[];

/* ================================================================ permissions with a trail */
/** Permission check that also records the denial in the audit trail (spec AT-15 / AT-17: "permission denied and logged"). */
export async function demand(req: Request, codes: string[], what: string, mode: 'any' | 'all' = 'any') {
  const u = req.user!;
  if (u.isSuperAdmin) return;
  const has = mode === 'any' ? codes.some((c) => u.permissions.has(c)) : codes.every((c) => u.permissions.has(c));
  if (has) return;
  await logDenied(req, codes, what);
  throw Forbidden(`You do not have permission to ${what} (needs ${codes.join(mode === 'any' ? ' or ' : ' and ')})`);
}
export async function logDenied(req: Request, codes: string[], what: string) {
  try {
    const { execute } = await import('../../config/db.js');
    await execute(`INSERT INTO log_audit (company_id, table_name, record_id, action, new_values, changed_by, ip_address) VALUES (?, 'security.permission_denied', 0, 'INSERT', ?, ?, ?)`,
      [req.user?.companyId ?? null, JSON.stringify({ what, required: codes, method: req.method, path: req.originalUrl }), req.user?.id ?? null, req.ip ?? null]);
  } catch { /* never block on logging */ }
}
export const can = (req: Request, code: string) => !!req.user && (req.user.isSuperAdmin || req.user.permissions.has(code));

/* ================================================================ claims */
export interface ClaimInput { scheme: SchemeConfig; shipping_bill_id: number | null; invoice_id: number | null; declared_amount: number | null; currency_code?: string | null;
  claim_date?: string | null; custom_field_values?: Record<string, unknown> | null; remarks?: string | null; source: 'SHIPPING_BILL' | 'MANUAL' }

/** New claim of an active, effective scheme (inactive schemes block new claims — spec v2 §12). */
export async function createClaim(tx: Tx, req: Request, b: ClaimInput) {
  const cid = req.user!.companyId;
  const sc = b.scheme;
  if (!sc.is_active) throw BadRequest(`${sc.display_name} is inactive — it cannot be used for new claims`);
  const on = b.claim_date ?? todayIst();
  if ((sc.effective_from && on < sc.effective_from) || (sc.effective_to && on > sc.effective_to)) throw BadRequest(`${sc.display_name} is not effective on ${on}`);
  if (b.declared_amount != null && b.declared_amount < 0) throw BadRequest('The amount cannot be negative', [{ field: 'declared_amount', message: 'Cannot be negative' }]);
  if (b.shipping_bill_id && !sc.allow_multiple) {
    const dup = await txQueryOne<any>(tx, `SELECT id FROM trx_export_incentive WHERE company_id = ? AND shipping_bill_id = ? AND scheme_id = ? LIMIT 1`, [cid, b.shipping_bill_id, sc.id]);
    if (dup) throw Conflict(`${sc.display_name} is already on this shipping bill`);
  }
  const cv = validateCustomValues(sc.custom_fields, 'CLAIM', null, b.custom_field_values);
  if (cv.errors.length) throw BadRequest(cv.errors[0].message, cv.errors);
  const stage = CLAIM_STAGES.includes(sc.default_status as any) && !['REJECTED', 'SHORT_CLOSED', 'APPROVED'].includes(sc.default_status) ? sc.default_status : 'ENTERED';
  const r = await txExecute(tx, `INSERT INTO trx_export_incentive (company_id, incentive_type, scheme_id, scheme_config_version, shipping_bill_id, invoice_id, claim_amount, declared_amount,
      currency_code, received_amount, claim_date, status, claim_stage, custom_field_values, remarks, source, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,0,?, 'CLAIMED', ?,?,?,?,?)`,
  [cid, sc.code, sc.id, sc.config_version, b.shipping_bill_id, b.invoice_id, r2(n(b.declared_amount)), b.declared_amount, (b.currency_code || sc.default_currency || 'INR').toUpperCase(),
    on, stage, cv.values ? JSON.stringify(cv.values) : null, b.remarks ?? null, b.source, req.user!.id]);
  const id = Number(r.insertId);
  await recalcClaim(tx, id, { userId: req.user!.id });
  await txExecute(tx, `INSERT INTO log_export_benefit_status (company_id, claim_id, old_status, new_status, reason, changed_by) SELECT company_id, id, NULL, benefit_status, 'Claim created', ? FROM trx_export_incentive WHERE id = ?`, [req.user!.id, id]);
  return id;
}

/** Number of posted (or reversed) events — a claim with any is history and is never deleted. */
export async function postedCount(tx: Tx, claimIds: number[]) {
  if (!claimIds.length) return 0;
  const r = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_export_benefit_event WHERE claim_id IN (?) AND status <> 'DRAFT'`, [claimIds]);
  return n(r?.c);
}
/** Remove claims that never had a posted event (drafts, follow-ups, documents and status history go with them). */
export async function deleteClaims(tx: Tx, claimIds: number[]) {
  if (!claimIds.length) return;
  if (await postedCount(tx, claimIds)) throw BadRequest('A benefit of this shipping bill has posted receipts / events — it cannot be removed (reverse the events or mark it Not applicable)');
  await txQuery(tx, `DELETE FROM trx_export_benefit_document WHERE claim_id IN (?)`, [claimIds]);
  await txQuery(tx, `DELETE FROM trx_export_benefit_event WHERE claim_id IN (?) AND status = 'DRAFT'`, [claimIds]);
  await txQuery(tx, `DELETE FROM trx_export_benefit_followup WHERE claim_id IN (?)`, [claimIds]);
  await txQuery(tx, `DELETE FROM log_export_benefit_status WHERE claim_id IN (?)`, [claimIds]);
  await txQuery(tx, `DELETE FROM trx_export_incentive_receipt WHERE incentive_id IN (?)`, [claimIds]);
  await txQuery(tx, `DELETE FROM trx_export_incentive WHERE id IN (?)`, [claimIds]);
}

/* ================================================================ shipping bill → claims */
export interface SbBenefitRow { scheme_id?: number | null; scheme_code?: string | null; declared_amount?: number | null; currency_code?: string | null;
  custom_field_values?: Record<string, unknown> | null; remarks?: string | null }

/** Active schemes keyed by id / code for a company (for the shipping bill grid). */
export async function companySchemes(cid: number, tx?: Tx) {
  const rows = tx ? await txQuery<any>(tx, `SELECT * FROM mst_export_benefit_scheme WHERE company_id = ? ORDER BY sort_order, id`, [cid])
    : await query<any>(`SELECT * FROM mst_export_benefit_scheme WHERE company_id = ? ORDER BY sort_order, id`, [cid]);
  return rows.map(schemeOut);
}

/**
 * The shipping bill's benefits: the four customs fields (drawback / IGST / RoSCTL / RoDTEP columns, kept for the PDF
 * import and the SB print) are synced to their schemes as before; any other scheme row sent is added or its declared
 * amount updated. Rows not sent are never touched (spec v2 §7: adding a benefit must not alter the others).
 */
export async function syncSbBenefits(tx: Tx, req: Request, sb: { id: number; invoice_id: number; sb_date: string; lut: boolean; amounts: Record<string, number> }, extra: SbBenefitRow[]) {
  const cid = req.user!.companyId;
  const warnings: string[] = [];
  const schemes = await companySchemes(cid, tx);
  const tol = await tolerance(cid, tx);
  for (const sc of schemes.filter((s) => s.sb_field)) {
    const amt = sc.sb_field === 'igst_amount' && sb.lut ? 0 : r2(n(sb.amounts[sc.sb_field!]));
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_export_incentive WHERE company_id = ? AND shipping_bill_id = ? AND (scheme_id = ? OR (scheme_id IS NULL AND incentive_type = ?)) AND source = 'SHIPPING_BILL' ORDER BY id LIMIT 1 FOR UPDATE`,
      [cid, sb.id, sc.id, sc.code]);
    const row = extra.find((e) => e.scheme_id === sc.id || e.scheme_code === sc.code);
    if (!cur) {
      if (amt > 0) {
        if (!sc.is_active) { warnings.push(`${sc.display_name} is inactive — its amount was kept on the shipping bill but no claim was made`); continue; }
        await createClaim(tx, req, { scheme: sc, shipping_bill_id: sb.id, invoice_id: sb.invoice_id, declared_amount: amt, claim_date: sb.sb_date, source: 'SHIPPING_BILL',
          custom_field_values: row?.custom_field_values ?? null, remarks: row?.remarks ?? null });
      }
      continue;
    }
    if (amt <= 0 && !(await postedCount(tx, [Number(cur.id)]))) { await deleteClaims(tx, [Number(cur.id)]); continue; }
    const settledNow = n(cur.cash_received) + n(cur.adjusted_amount) + n(cur.scrip_issued);
    if (settledNow > amt + tol) warnings.push(`${sc.display_name}: ₹${r2(settledNow)} already received / issued is more than the new amount ₹${amt} — shown as excess`);
    let cfv = cur.custom_field_values;
    if (row?.custom_field_values !== undefined) {
      const cfg = await claimConfig(sc.id, cur.scheme_config_version == null ? null : Number(cur.scheme_config_version), tx);
      const cv = validateCustomValues(cfg.custom_fields, 'CLAIM', null, row.custom_field_values);
      if (cv.errors.length) throw BadRequest(`${sc.display_name}: ${cv.errors[0].message}`, cv.errors);
      cfv = cv.values ? JSON.stringify(cv.values) : null;
    }
    if (Math.abs(n(cur.declared_amount) - amt) > 0.0001 || cur.declared_amount == null) {
      await txExecute(tx, `INSERT INTO log_audit (company_id, table_name, record_id, action, old_values, new_values, changed_by) VALUES (?, 'trx_export_incentive', ?, 'UPDATE', ?, ?, ?)`,
        [cid, cur.id, JSON.stringify({ declared_amount: cur.declared_amount }), JSON.stringify({ declared_amount: amt, via: 'shipping bill' }), req.user!.id]);
    }
    await txExecute(tx, `UPDATE trx_export_incentive SET claim_amount = ?, declared_amount = ?, invoice_id = ?, claim_date = COALESCE(claim_date, ?), scheme_id = ?, custom_field_values = ?,
        scheme_config_version = COALESCE(scheme_config_version, ?), updated_by = ? WHERE id = ?`, [amt, amt, sb.invoice_id, sb.sb_date, sc.id, cfv, sc.config_version, req.user!.id, cur.id]);
    await recalcClaim(tx, Number(cur.id), { userId: req.user!.id, reason: 'Shipping bill amount changed' });
  }
  for (const e of extra) {
    const sc = schemes.find((s) => (e.scheme_id && s.id === Number(e.scheme_id)) || (e.scheme_code && s.code === e.scheme_code));
    if (!sc) throw BadRequest(`Benefit scheme ${e.scheme_code ?? e.scheme_id} not found`);
    if (sc.sb_field) continue;   // the four customs fields are handled above
    const cur = await txQueryOne<any>(tx, `SELECT * FROM trx_export_incentive WHERE company_id = ? AND shipping_bill_id = ? AND scheme_id = ? ORDER BY id LIMIT 1 FOR UPDATE`, [cid, sb.id, sc.id]);
    const amt = e.declared_amount == null ? null : r2(n(e.declared_amount));
    if (amt != null && amt < 0) throw BadRequest(`${sc.display_name}: the amount cannot be negative`);
    if (!cur) {
      await createClaim(tx, req, { scheme: sc, shipping_bill_id: sb.id, invoice_id: sb.invoice_id, declared_amount: amt, currency_code: e.currency_code, claim_date: sb.sb_date,
        custom_field_values: e.custom_field_values ?? null, remarks: e.remarks ?? null, source: 'SHIPPING_BILL' });
      continue;
    }
    const cfg = await claimConfig(sc.id, cur.scheme_config_version == null ? null : Number(cur.scheme_config_version), tx);
    const cv = e.custom_field_values !== undefined ? validateCustomValues(cfg.custom_fields, 'CLAIM', null, e.custom_field_values) : null;
    if (cv?.errors.length) throw BadRequest(`${sc.display_name}: ${cv.errors[0].message}`, cv.errors);
    const same = (cur.declared_amount == null ? null : n(cur.declared_amount)) === amt && (!cv || JSON.stringify(cv.values) === JSON.stringify(parseJson(cur.custom_field_values, null)));
    if (same) continue;
    await txExecute(tx, `UPDATE trx_export_incentive SET claim_amount = ?, declared_amount = ?, custom_field_values = ?, remarks = COALESCE(?, remarks), updated_by = ? WHERE id = ?`,
      [n(amt), amt, cv ? (cv.values ? JSON.stringify(cv.values) : null) : cur.custom_field_values, e.remarks ?? null, req.user!.id, cur.id]);
    await txExecute(tx, `INSERT INTO log_audit (company_id, table_name, record_id, action, old_values, new_values, changed_by) VALUES (?, 'trx_export_incentive', ?, 'UPDATE', ?, ?, ?)`,
      [cid, cur.id, JSON.stringify({ declared_amount: cur.declared_amount, custom_field_values: parseJson(cur.custom_field_values, null) }), JSON.stringify({ declared_amount: amt, custom_field_values: cv?.values, via: 'shipping bill' }), req.user!.id]);
    await recalcClaim(tx, Number(cur.id), { userId: req.user!.id, reason: 'Declared amount changed' });
  }
  return warnings;
}
