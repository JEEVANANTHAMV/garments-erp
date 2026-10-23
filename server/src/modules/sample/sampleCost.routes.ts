import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, transaction, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { s } from '../resources/schemas.js';
import {
  COST_CATEGORIES, COUNTED, n, r2, r4, todayIso, needPerm, getSample, assertSegregation, logSample, bumpVersion,
  costTotals, allocTotals, metrics, calendar, eligibleCategories,
} from './sampleCore.js';

/**
 * Sample cost ledger (spec §6.5, §9). One entry per cost; Draft → Submitted → Approved → Posted. A posted entry is never
 * edited: it is reversed (a negative posted twin, original marked Reversed) and replaced. A source line (general
 * purchase line booked to the sample, stage labour) can have one live entry only (source_key unique).
 * Totals: today's / cumulative cost count approved + posted entries (reversals signed); only posted cost can be
 * allocated to orders.
 */
export const sampleCostRouter = Router();

const VIEW = requirePermission('SAMPLE.VIEW');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const costSchema = z.object({
  cost_date: dateStr,
  category: z.enum(COST_CATEGORIES),
  description: z.string().trim().min(2, 'Describe the cost').max(255),
  process_id: s.id(),
  qty: z.coerce.number().min(0).nullish(),
  uom_id: s.id(),
  rate: z.coerce.number().min(0).nullish(),
  amount_fc: z.coerce.number().nullish(),
  currency_id: s.id(),
  exchange_rate: z.coerce.number().positive().nullish(),
  basis: z.enum(['ACTUAL', 'STANDARD', 'ALLOCATED']).default('ACTUAL'),
  source_ref: s.nullableStr(80),
  submit: z.coerce.boolean().default(false),
});

/** Amount of an entry: qty × rate when both are given, else the amount typed; INR = amount × exchange rate. */
async function amounts(tx: Tx, b: z.infer<typeof costSchema>) {
  const fc = b.qty != null && b.rate != null && b.qty > 0 && b.rate > 0 ? r2(b.qty * b.rate) : n(b.amount_fc);
  if (b.category !== 'ADJUSTMENT' && fc <= 0) throw BadRequest('Enter the amount (or quantity × rate)', [{ field: 'amount_fc', message: 'Required' }]);
  if (b.category === 'ADJUSTMENT' && fc === 0) throw BadRequest('An adjustment needs a non-zero amount', [{ field: 'amount_fc', message: 'Required' }]);
  let xr = 1;
  if (b.currency_id) {
    const cur = await txQueryOne<any>(tx, `SELECT code FROM cfg_currency WHERE id = ?`, [b.currency_id]);
    if (!cur) throw BadRequest('Currency not found');
    if (cur.code !== 'INR') {
      if (!b.exchange_rate || b.exchange_rate <= 0) throw BadRequest(`Enter the exchange rate (₹ per 1 ${cur.code})`, [{ field: 'exchange_rate', message: 'Required' }]);
      xr = b.exchange_rate;
    }
  }
  if (b.basis === 'ALLOCATED' && b.category !== 'OVERHEAD') throw BadRequest('Only overhead is entered as an allocated (not actual) cost');
  return { fc, xr, inr: r2(fc * xr) };
}

async function lockCost(tx: Tx, cid: number, sampleId: number, costId: number) {
  const c = await txQueryOne<any>(tx, `SELECT * FROM trx_sample_cost WHERE id = ? AND sample_id = ? AND company_id = ? FOR UPDATE`, [costId, sampleId, cid]);
  if (!c) throw NotFound('Cost entry not found');
  return c;
}

const COST_SELECT = `
  SELECT c.*, cu.code AS currency_code, um.code AS uom_code, p.stage_name, cb.full_name AS created_by_name, ab.full_name AS approved_by_name,
         pb.full_name AS posted_by_name, rv.id AS reversed_by_entry_id
    FROM trx_sample_cost c
    LEFT JOIN cfg_currency cu ON cu.id = c.currency_id
    LEFT JOIN cfg_uom um ON um.id = c.uom_id
    LEFT JOIN trx_sample_process p ON p.id = c.process_id
    LEFT JOIN mst_user cb ON cb.id = c.created_by
    LEFT JOIN mst_user ab ON ab.id = c.approved_by
    LEFT JOIN mst_user pb ON pb.id = c.posted_by
    LEFT JOIN trx_sample_cost rv ON rv.reversal_of_id = c.id`;

/** GET /samples/:id/costs — ledger, summary (spec §9) and the split by category. */
sampleCostRouter.get('/samples/:id/costs', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const sm = await getSample(cid, id);
  const asOf = typeof req.query.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of) ? req.query.as_of : todayIso();
  const [rows, byCat, trend, cal, c, a, cats] = await Promise.all([
    query<any>(`${COST_SELECT} WHERE c.company_id = ? AND c.sample_id = ? ORDER BY c.cost_date DESC, c.id DESC`, [cid, id]),
    query<any>(`SELECT category, SUM(CASE WHEN status IN ${COUNTED} AND cost_date <= ? THEN amount ELSE 0 END) amount,
                       SUM(CASE WHEN status IN ('POSTED','REVERSED') THEN amount ELSE 0 END) posted
                  FROM trx_sample_cost WHERE company_id = ? AND sample_id = ? GROUP BY category`, [asOf, cid, id]),
    query<any>(`SELECT cost_date, SUM(amount) amount FROM trx_sample_cost WHERE company_id = ? AND sample_id = ? AND status IN ${COUNTED} AND cost_date <= ?
                 GROUP BY cost_date ORDER BY cost_date`, [cid, id, asOf]),
    calendar(cid), costTotals(cid, [id], asOf), allocTotals([id]), eligibleCategories(cid),
  ]);
  res.json({ data: rows, summary: { as_of: asOf, ...metrics(sm, c.get(id), a.get(id), cal, asOf), qty: n(sm.qty), good_qty: sm.good_qty == null ? null : n(sm.good_qty),
    recovered_amount: n(sm.recovered_amount), eligible_categories: cats,
    by_category: byCat.map((r) => ({ category: r.category, amount: r2(n(r.amount)), posted: r2(n(r.posted)), eligible: cats.includes(r.category) })),
    daily: trend.map((r) => ({ date: r.cost_date, amount: r2(n(r.amount)) })) } });
}));

sampleCostRouter.post('/samples/:id/costs', requirePermission('SAMPLE.COST'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = costSchema.parse(req.body ?? {});
  const sm = await getSample(cid, id);
  const out = await transaction(async (tx) => {
    if (b.process_id && !(await txQueryOne(tx, `SELECT id FROM trx_sample_process WHERE id = ? AND sample_id = ?`, [b.process_id, id]))) throw BadRequest('Stage not found');
    const a = await amounts(tx, b);
    const r = await txExecute(tx, `INSERT INTO trx_sample_cost (company_id, sample_id, process_id, revision_no, cost_date, category, description, qty, uom_id, rate, currency_id, exchange_rate,
        amount_fc, amount, basis, source_type, source_ref, status, created_by, submitted_by, submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'MANUAL',?,?,?,?,?)`,
      [cid, id, b.process_id ?? null, sm.revision_no, b.cost_date, b.category, b.description, b.qty ?? null, b.uom_id ?? null, b.rate ?? null, b.currency_id ?? null, a.xr,
        a.fc, a.inr, b.basis, b.source_ref ?? null, b.submit ? 'SUBMITTED' : 'DRAFT', req.user!.id, b.submit ? req.user!.id : null, b.submit ? new Date() : null]);
    await logSample(tx, req, id, 'COST', Number(r.insertId), 'CREATE', undefined, { category: b.category, amount: a.inr, status: b.submit ? 'SUBMITTED' : 'DRAFT' });
    await bumpVersion(tx, id);
    return { id: Number(r.insertId), amount: a.inr };
  });
  res.status(201).json({ data: out });
}));

/** Draft / submitted entries can be corrected (back to submitted); approved and posted ones cannot. */
sampleCostRouter.put('/samples/:id/costs/:cid', requirePermission('SAMPLE.COST'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = costSchema.parse(req.body ?? {});
  await getSample(cid, id);
  const out = await transaction(async (tx) => {
    const c = await lockCost(tx, cid, id, Number(req.params.cid));
    if (!['DRAFT', 'SUBMITTED'].includes(c.status)) throw BadRequest(`A ${c.status.toLowerCase()} cost cannot be edited${c.status === 'POSTED' ? ' — reverse it and enter the correct one' : ''}`);
    if (b.process_id && !(await txQueryOne(tx, `SELECT id FROM trx_sample_process WHERE id = ? AND sample_id = ?`, [b.process_id, id]))) throw BadRequest('Stage not found');
    const a = await amounts(tx, b);
    // a linked entry keeps the amount of its source (the bill / labour log) — reject it instead of changing it
    if (c.source_type !== 'MANUAL' && Math.abs(a.inr - n(c.amount)) > 0.005) throw BadRequest('The amount of a linked entry comes from its source document — reject it instead of changing it');
    const status = b.submit || c.status === 'SUBMITTED' ? 'SUBMITTED' : 'DRAFT';
    await txExecute(tx, `UPDATE trx_sample_cost SET cost_date = ?, category = ?, description = ?, process_id = ?, qty = ?, uom_id = ?, rate = ?, currency_id = ?, exchange_rate = ?,
        amount_fc = ?, amount = ?, basis = ?, source_ref = ?, status = ?, submitted_by = IF(? = 'SUBMITTED', COALESCE(submitted_by, ?), NULL),
        submitted_at = IF(? = 'SUBMITTED', COALESCE(submitted_at, NOW()), NULL) WHERE id = ?`,
      [b.cost_date, b.category, b.description, b.process_id ?? null, b.qty ?? null, b.uom_id ?? null, b.rate ?? null, b.currency_id ?? null, a.xr, a.fc, a.inr, b.basis,
        b.source_ref ?? null, status, status, req.user!.id, status, c.id]);
    await logSample(tx, req, id, 'COST', Number(c.id), 'UPDATE', { amount: n(c.amount), category: c.category, cost_date: c.cost_date }, { amount: a.inr, category: b.category, cost_date: b.cost_date });
    await bumpVersion(tx, id);
    return { id: Number(c.id), amount: a.inr, status };
  });
  res.json({ data: out });
}));

sampleCostRouter.delete('/samples/:id/costs/:cid', requirePermission('SAMPLE.COST'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await getSample(cid, id);
  await transaction(async (tx) => {
    const c = await lockCost(tx, cid, id, Number(req.params.cid));
    if (c.status !== 'DRAFT') throw BadRequest('Only a draft cost can be deleted — reject a submitted one');
    await txExecute(tx, `DELETE FROM trx_sample_cost WHERE id = ?`, [c.id]);
    await logSample(tx, req, id, 'COST', Number(c.id), 'DELETE', { category: c.category, amount: n(c.amount), description: c.description });
    await bumpVersion(tx, id);
  });
  res.json({ data: { deleted: true } });
}));

/* ---------------------------------------------------------------- state machine */
const ACTIONS = ['submit', 'approve', 'post', 'reject', 'reverse'] as const;
type CostAction = typeof ACTIONS[number];

async function applyAction(tx: Tx, req: Request, sampleId: number, c: any, action: CostAction, reason?: string | null) {
  const uid = req.user!.id;
  switch (action) {
    case 'submit':
      needPerm(req, 'SAMPLE.COST');
      if (c.status !== 'DRAFT') throw BadRequest(`Entry ${c.id} is ${c.status.toLowerCase()}, not a draft`);
      await txExecute(tx, `UPDATE trx_sample_cost SET status = 'SUBMITTED', submitted_by = ?, submitted_at = NOW() WHERE id = ?`, [uid, c.id]);
      break;
    case 'approve':
      needPerm(req, 'SAMPLE.COST_APPROVE');
      if (c.status !== 'SUBMITTED') throw BadRequest(`Entry ${c.id} is ${c.status.toLowerCase()} — only a submitted cost can be approved`);
      await assertSegregation(req, c.created_by, 'cost');
      await txExecute(tx, `UPDATE trx_sample_cost SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?`, [uid, c.id]);
      break;
    case 'post':
      needPerm(req, 'SAMPLE.COST_APPROVE');
      if (c.status === 'POSTED') return 'already';
      if (!['SUBMITTED', 'APPROVED'].includes(c.status)) throw BadRequest(`Entry ${c.id} is ${c.status.toLowerCase()} — submit it first`);
      await assertSegregation(req, c.created_by, 'cost');
      await txExecute(tx, `UPDATE trx_sample_cost SET status = 'POSTED', approved_by = COALESCE(approved_by, ?), approved_at = COALESCE(approved_at, NOW()), posted_by = ?, posted_at = NOW() WHERE id = ?`, [uid, uid, c.id]);
      break;
    case 'reject':
      needPerm(req, 'SAMPLE.COST_APPROVE');
      if (!['SUBMITTED', 'APPROVED'].includes(c.status)) throw BadRequest(`Entry ${c.id} is ${c.status.toLowerCase()} — only a submitted or approved cost can be rejected${c.status === 'POSTED' ? ' (reverse a posted one)' : ''}`);
      if (!reason) throw BadRequest('Give the reason for rejecting', [{ field: 'reason', message: 'Required' }]);
      // the source line is free again (it can be imported again, corrected)
      await txExecute(tx, `UPDATE trx_sample_cost SET status = 'REJECTED', reason = ?, source_key = NULL WHERE id = ?`, [reason, c.id]);
      break;
    case 'reverse': {
      needPerm(req, 'SAMPLE.COST_APPROVE');
      if (c.status !== 'POSTED') throw BadRequest(`Entry ${c.id} is ${c.status.toLowerCase()} — only a posted cost is reversed`);
      if (c.reversal_of_id) throw BadRequest('A reversal entry cannot be reversed');
      if (!reason) throw BadRequest('Give the reason for reversing', [{ field: 'reason', message: 'Required' }]);
      await txExecute(tx, `UPDATE trx_sample_cost SET status = 'REVERSED', reason = ?, source_key = NULL WHERE id = ?`, [reason, c.id]);
      const r = await txExecute(tx, `INSERT INTO trx_sample_cost (company_id, sample_id, process_id, revision_no, cost_date, category, description, qty, uom_id, rate, currency_id, exchange_rate,
          amount_fc, amount, basis, source_type, source_id, source_line_id, source_ref, status, reversal_of_id, reason, created_by, submitted_by, submitted_at, approved_by, approved_at, posted_by, posted_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'REVERSAL',?,?,?,'POSTED',?,?,?,?,NOW(),?,NOW(),?,NOW())`,
        [c.company_id, c.sample_id, c.process_id, c.revision_no, todayIso(), c.category, `Reversal of #${c.id}: ${c.description}`.slice(0, 255),
          c.qty == null ? null : -n(c.qty), c.uom_id, c.rate, c.currency_id, c.exchange_rate, -n(c.amount_fc), -n(c.amount), c.basis,
          c.source_id, c.source_line_id, c.source_ref, c.id, reason, uid, uid, uid, uid]);
      return Number(r.insertId);
    }
  }
  return null;
}

/** After a reversal the posted cost may be below what is already allocated: reported so the allocation is adjusted. */
async function allocationException(cid: number, sampleId: number) {
  const sm = await getSample(cid, sampleId);
  const [c, a, cal] = await Promise.all([costTotals(cid, [sampleId]), allocTotals([sampleId]), calendar(cid)]);
  const m = metrics(sm, c.get(sampleId), a.get(sampleId), cal);
  return m.allocation_state === 'EXCEPTION'
    ? `Posted cost (₹${m.eligible_cost}) is now below the cost allocated to orders (₹${m.allocated_cost}) — reverse or adjust the allocation`
    : null;
}

sampleCostRouter.post('/samples/:id/costs/:cid/:action', requireAny('SAMPLE.COST', 'SAMPLE.COST_APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const action = z.enum(ACTIONS).parse(req.params.action);
  const reason = z.object({ reason: s.nullableStr(255) }).parse(req.body ?? {}).reason;
  await getSample(cid, id);
  const out = await transaction(async (tx) => {
    const c = await lockCost(tx, cid, id, Number(req.params.cid));
    const r = await applyAction(tx, req, id, c, action, reason);
    if (r !== 'already') {
      await logSample(tx, req, id, 'COST', Number(c.id), action.toUpperCase(), { status: c.status }, { amount: n(c.amount), category: c.category, ...(typeof r === 'number' ? { reversal_entry: r } : {}) }, reason);
      await bumpVersion(tx, id);
    }
    return { id: Number(c.id), action, idempotent: r === 'already', reversal_id: typeof r === 'number' ? r : null };
  });
  res.json({ data: { ...out, warning: action === 'reverse' ? await allocationException(cid, id) : null } });
}));

/** POST /samples/:id/costs-bulk { ids, action, reason? } — all or nothing. */
sampleCostRouter.post('/samples/:id/costs-bulk', requireAny('SAMPLE.COST', 'SAMPLE.COST_APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500), action: z.enum(['submit', 'approve', 'post', 'reject']), reason: s.nullableStr(255) }).parse(req.body ?? {});
  await getSample(cid, id);
  const done = await transaction(async (tx) => {
    let k = 0;
    for (const costId of [...new Set(b.ids)]) {
      const c = await lockCost(tx, cid, id, costId);
      const r = await applyAction(tx, req, id, c, b.action, b.reason);
      if (r !== 'already') { k++; await logSample(tx, req, id, 'COST', costId, b.action.toUpperCase(), { status: c.status }, { amount: n(c.amount) }, b.reason); }
    }
    await bumpVersion(tx, id);
    return k;
  });
  res.json({ data: { updated: done } });
}));

/* ---------------------------------------------------------------- linked sources: general purchases booked to the sample */
const GP_CATEGORY: Record<string, string> = { TRIM: 'MATERIAL', YARN: 'MATERIAL', FABRIC: 'MATERIAL', CONSUMABLE: 'CONSUMABLE', SPARE: 'CONSUMABLE', EXPENSE: 'ADJUSTMENT', OTHER: 'ADJUSTMENT' };
const gpCategory = (l: any) => /courier|freight|transport/i.test(`${l.expense_head ?? ''} ${l.item_description ?? ''}`) ? 'COURIER'
  : /job ?work|stitch|embroider|print|wash/i.test(`${l.expense_head ?? ''} ${l.process_name ?? ''}`) ? 'SUBCONTRACT' : GP_CATEGORY[l.material_type] ?? 'MATERIAL';

/** GET /samples/:id/cost-sources — general purchase lines booked to this sample, imported or not. */
sampleCostRouter.get('/samples/:id/cost-sources', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await getSample(cid, id);
  const rows = await query<any>(
    `SELECT l.id AS line_id, g.id AS purchase_id, COALESCE(NULLIF(g.grn_no, ''), g.purchase_no) AS doc_no, g.purchase_date, g.approval_state, sup.party_name AS supplier_name,
            l.item_description, l.material_type, l.expense_head, l.process_name, l.qty, um.code AS uom_code, l.rate, l.amount, l.tax_amount, cu.code AS currency_code,
            COALESCE(NULLIF(g.exchange_rate, 0), 1) AS exchange_rate, x.id AS cost_id, x.status AS cost_status
       FROM trx_general_purchase_line l JOIN trx_general_purchase g ON g.id = l.purchase_id
       LEFT JOIN mst_party sup ON sup.id = g.supplier_id LEFT JOIN cfg_uom um ON um.id = l.uom_id LEFT JOIN cfg_currency cu ON cu.id = g.currency_id
       LEFT JOIN trx_sample_cost x ON x.company_id = g.company_id AND x.source_key = CONCAT('GP_LINE:', l.id)
      WHERE g.company_id = ? AND l.sample_id = ? AND l.allocation_type = 'SAMPLE' AND COALESCE(g.approval_state, 'DRAFT') <> 'CANCELLED'
      ORDER BY g.purchase_date DESC, l.id`, [cid, id]);
  res.json({ data: rows.map((r) => ({ ...r, amount_inr: r2(n(r.amount) * (r.currency_code && r.currency_code !== 'INR' ? n(r.exchange_rate) : 1)),
    suggested_category: gpCategory(r), importable: !r.cost_id && ['APPROVED', 'POSTED'].includes(r.approval_state) })) });
}));

/** POST /samples/:id/cost-sources/import { lines: [{ line_id, category? }] } — submitted cost entries, one per line. */
sampleCostRouter.post('/samples/:id/cost-sources/import', requirePermission('SAMPLE.COST'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = z.object({ lines: z.array(z.object({ line_id: z.coerce.number().int().positive(), category: z.enum(COST_CATEGORIES).nullish() })).min(1).max(200) }).parse(req.body ?? {});
  const sm = await getSample(cid, id);
  const made = await transaction(async (tx) => {
    const ids: number[] = [];
    for (const ln of b.lines) {
      const l = await txQueryOne<any>(tx, `SELECT l.*, g.purchase_no, g.grn_no, g.purchase_date, g.approval_state, g.currency_id AS gp_currency_id, COALESCE(NULLIF(g.exchange_rate, 0), 1) AS gp_xr, cu.code AS currency_code
          FROM trx_general_purchase_line l JOIN trx_general_purchase g ON g.id = l.purchase_id LEFT JOIN cfg_currency cu ON cu.id = g.currency_id
         WHERE l.id = ? AND g.company_id = ? AND l.sample_id = ? AND l.allocation_type = 'SAMPLE' FOR UPDATE`, [ln.line_id, cid, id]);
      if (!l) throw BadRequest(`Purchase line ${ln.line_id} is not booked to this sample`);
      if (!['APPROVED', 'POSTED'].includes(l.approval_state)) throw BadRequest(`Purchase ${l.purchase_no} is not approved yet`);
      const key = `GP_LINE:${l.id}`;
      if (await txQueryOne(tx, `SELECT id FROM trx_sample_cost WHERE company_id = ? AND source_key = ?`, [cid, key])) throw Conflict(`Purchase line ${l.item_description} (${l.purchase_no}) is already in the sample cost — the same source cannot be posted twice`);
      const xr = l.currency_code && l.currency_code !== 'INR' ? n(l.gp_xr) : 1;
      const fc = r2(n(l.amount));
      const r = await txExecute(tx, `INSERT INTO trx_sample_cost (company_id, sample_id, revision_no, cost_date, category, description, qty, uom_id, rate, currency_id, exchange_rate,
          amount_fc, amount, basis, source_type, source_id, source_line_id, source_ref, source_key, status, created_by, submitted_by, submitted_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTUAL','GENERAL_PURCHASE',?,?,?,?,'SUBMITTED',?,?,NOW())`,
        [cid, id, sm.revision_no, String(l.purchase_date ?? todayIso()).slice(0, 10), ln.category ?? gpCategory(l), String(l.item_description).slice(0, 255),
          l.qty, l.uom_id, l.rate, l.gp_currency_id, r4(xr), fc, r2(fc * xr), l.purchase_id, l.id, (l.grn_no || l.purchase_no || '').slice(0, 80), key, req.user!.id, req.user!.id]);
      ids.push(Number(r.insertId));
      await logSample(tx, req, id, 'COST', Number(r.insertId), 'IMPORT', undefined, { source: l.purchase_no, line: l.id, amount: r2(fc * xr) });
    }
    await bumpVersion(tx, id);
    return ids;
  });
  res.status(201).json({ data: { created: made.length, ids: made } });
}));

