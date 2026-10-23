import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, Conflict, NotFound } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import {
  ALLOC_METHODS, LIVE_ALLOC, POSTED, n, r2, r4, needPerm, getSample, lockSample, assertSegregation, logSample, bumpVersion,
  eligibleCategories,
} from './sampleCore.js';

/**
 * Sample cost → order allocation (spec §6.7, §9, §9.1). The sample cost ledger stays the single source; an allocation
 * batch attributes part of the sample's POSTED eligible cost to one or more CONFIRMED sales orders (approved / closed,
 * not sample or projection orders). Amounts are always worked out here, never taken from the client. A batch is
 * Draft → Pending approval → Approved → Posted; posting locks the sample and re-checks the unallocated balance, so two
 * users can never allocate the same balance twice, and a repeated post changes nothing. Posted lines are reversed
 * (whole batch or line by line) with a reason; history stays. Accounting mode is ANALYTICAL: the order P&L shows the
 * allocation, no GL journal is made (the ERP's GL is not in use), so the expense is never counted twice.
 */
export const sampleAllocRouter = Router();

const CONFIRMED = `so.approval_state IN ('APPROVED','CLOSED') AND so.order_type NOT IN ('SAMPLE','PROJECTION') AND so.is_deleted = 0`;

/** Unallocated balance of a sample = posted eligible cost − buyer-paid charge − live posted allocations (optionally less a batch). */
async function balances(db: Tx | null, cid: number, sm: any, excludeBatch?: number) {
  const cats = await eligibleCategories(cid);
  // inside a transaction: locking reads, so the check sees what other transactions committed while this one waited for
  // the sample lock (a plain read would use the snapshot taken before the wait — two submits could both pass)
  const q = <T = any>(sql: string, p: unknown[]) => (db ? txQueryOne<T>(db, `${sql} FOR SHARE`, p) : queryOne<T>(sql, p));
  const posted = await q<any>(`SELECT COALESCE(SUM(amount),0) v FROM trx_sample_cost WHERE company_id = ? AND sample_id = ? AND status IN ${POSTED} AND category IN (?)`,
    [cid, sm.id, cats.length ? cats : ['-']]);
  const alloc = await q<any>(`SELECT COALESCE(SUM(CASE WHEN ${LIVE_ALLOC} THEN l.allocated_amount ELSE 0 END),0) v,
      COALESCE(SUM(CASE WHEN b.status IN ('PENDING_APPROVAL','APPROVED') THEN l.allocated_amount ELSE 0 END),0) p
      FROM trx_sample_alloc_batch b JOIN trx_sample_alloc_line l ON l.batch_id = b.id WHERE b.sample_id = ? AND b.id <> ?`, [sm.id, excludeBatch ?? 0]);
  const eligible = r2(Math.max(0, n(posted?.v) - n(sm.recovered_amount)));
  return { eligible, allocated: r2(n(alloc?.v)), reserved: r2(n(alloc?.p)), unallocated: r2(eligible - n(alloc?.v)), available: r2(eligible - n(alloc?.v) - n(alloc?.p)) };
}

/** INR rate of an order: INR = 1; else its own rate when above 1, else the latest exchange-rate entry. */
async function inrRate(so: any) {
  if (so.currency_code === 'INR' || !so.currency_code) return 1;
  if (n(so.exchange_rate) > 1) return n(so.exchange_rate);
  const x = await queryOne<any>(`SELECT x.rate FROM trx_exchange_rate x JOIN cfg_currency i ON i.id = x.to_currency AND i.code = 'INR'
    WHERE x.from_currency = ? ORDER BY x.rate_date DESC LIMIT 1`, [so.currency_id]);
  return x && n(x.rate) > 0 ? n(x.rate) : null;
}

/** Orders with their allocation basis for the sample's style (quantity and INR value of the style's lines). */
async function ordersWithBasis(cid: number, sm: any, soIds: number[] | null, search?: string) {
  const where = [`so.company_id = ?`, CONFIRMED];
  const p: unknown[] = [cid];
  if (soIds) { if (!soIds.length) return []; where.push(`so.id IN (?)`); p.push(soIds); }
  else if (search) { where.push(`(so.so_no LIKE ? OR so.buyer_po_no LIKE ? OR so.io_no LIKE ?)`); p.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  else { where.push(`so.buyer_id = ? AND EXISTS (SELECT 1 FROM trx_sales_order_line x WHERE x.so_id = so.id AND x.style_id = ?)`); p.push(sm.buyer_id, sm.style_id); }
  const rows = await query<any>(`
    SELECT so.id AS so_id, so.so_no, so.io_no, so.buyer_po_no, so.so_date, so.ship_date, so.approval_state, so.buyer_id, b.party_name AS buyer_name,
           so.currency_id, cu.code AS currency_code, so.exchange_rate, so.order_qty, so.total_amount,
           SUM(CASE WHEN l.style_id = ? THEN GREATEST(0, l.order_qty - COALESCE(l.cancelled_qty,0)) ELSE 0 END) AS style_qty,
           SUM(CASE WHEN l.style_id = ? THEN COALESCE(NULLIF(l.amount,0), l.order_qty * l.unit_price) ELSE 0 END) AS style_value,
           SUM(GREATEST(0, l.order_qty - COALESCE(l.cancelled_qty,0))) AS all_qty,
           SUM(COALESCE(NULLIF(l.amount,0), l.order_qty * l.unit_price)) AS all_value,
           MAX(l.style_id = ?) AS has_style
      FROM trx_sales_order so
      LEFT JOIN trx_sales_order_line l ON l.so_id = so.id
      LEFT JOIN mst_party b ON b.id = so.buyer_id
      LEFT JOIN cfg_currency cu ON cu.id = so.currency_id
     WHERE ${where.join(' AND ')}
     GROUP BY so.id ORDER BY so.so_date DESC, so.id DESC LIMIT 100`, [sm.style_id, sm.style_id, sm.style_id, ...p]);
  const ids = rows.map((r) => Number(r.so_id));
  const already = ids.length ? await query<any>(`SELECT l.so_id, SUM(l.allocated_amount) v FROM trx_sample_alloc_line l JOIN trx_sample_alloc_batch b ON b.id = l.batch_id
    WHERE b.sample_id = ? AND ${LIVE_ALLOC} AND l.so_id IN (?) GROUP BY l.so_id`, [sm.id, ids]) : [];
  const A = new Map(already.map((a) => [Number(a.so_id), r2(n(a.v))]));
  const out = [];
  for (const r of rows) {
    const fx = await inrRate(r);
    const matched = Number(r.buyer_id) === Number(sm.buyer_id) && Number(r.has_style) === 1;
    const qty = Number(r.has_style) ? n(r.style_qty) : n(r.all_qty);
    const val = Number(r.has_style) ? n(r.style_value) : n(r.all_value);
    out.push({ ...r, matched, override: !matched, fx_to_inr: fx, basis_qty: qty, basis_value: fx == null ? null : r2(val * fx),
      already_allocated: A.get(Number(r.so_id)) ?? 0 });
  }
  return out;
}

sampleAllocRouter.get('/samples/:id/eligible-orders', requirePermission('SAMPLE.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sm = await getSample(cid, Number(req.params.id));
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 40) : '';
  const [matched, others, bal] = await Promise.all([
    ordersWithBasis(cid, sm, null), q ? ordersWithBasis(cid, sm, null, q) : Promise.resolve([]), balances(null, cid, sm),
  ]);
  res.json({ data: { matched, others: others.filter((o) => !matched.some((m) => m.so_id === o.so_id)), balance: bal,
    buyer_approved: ['APPROVED', 'COMPLETED'].includes(sm.status), sample_status: sm.status } });
}));

/* ---------------------------------------------------------------- the split (server-side, spec §9) */
const lineIn = z.object({ so_id: z.coerce.number().int().positive(), pct: z.coerce.number().positive().max(100).nullish(), manual_amount: z.coerce.number().positive().nullish() });
const batchSchema = z.object({
  method: z.enum(ALLOC_METHODS),
  amount_to_allocate: z.coerce.number().positive().nullish(),
  reason: z.string().trim().min(3, 'Give the reason (e.g. buyer approved, order confirmed)').max(255),
  override_reason: s.nullableStr(255),
  lines: z.array(lineIn).min(1, 'Pick at least one order').max(50),
  row_version: z.coerce.number().int().nullish(),
});
type BatchIn = z.infer<typeof batchSchema>;

/** Spread `total` over weights, 2 decimals, the rounding difference on the biggest share — the lines add up exactly. */
function spread(total: number, weights: number[]) {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum <= 0) throw BadRequest('The chosen basis is zero for every order — pick another method');
  const out = weights.map((w) => r2((total * w) / sum));
  const diff = r2(total - out.reduce((a, v) => a + v, 0));
  if (diff) { const i = weights.indexOf(Math.max(...weights)); out[i] = r2(out[i] + diff); }
  return out;
}

async function compute(db: Tx | null, cid: number, sm: any, b: BatchIn, excludeBatch?: number) {
  const ids = b.lines.map((l) => l.so_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('An order is listed twice');
  const orders = await ordersWithBasis(cid, sm, ids);
  const missing = ids.filter((id) => !orders.some((o) => Number(o.so_id) === id));
  if (missing.length) throw BadRequest(`Not a confirmed order of this company: ${missing.join(', ')} — only approved / closed orders (not sample or projection orders) can take sample cost`);
  const bal = await balances(db, cid, sm, excludeBatch);
  const warnings: string[] = [];
  const lines = b.lines.map((l) => ({ ...l, o: orders.find((o) => Number(o.so_id) === l.so_id)! }));
  let amounts: number[];
  let target: number;
  switch (b.method) {
    case 'PERCENT': {
      if (lines.some((l) => !l.pct)) throw BadRequest('Enter the percentage of every order');
      const tot = lines.reduce((a, l) => a + n(l.pct), 0);
      if (tot > 100.0001) throw BadRequest(`The percentages add up to ${r4(tot)}% — not more than 100%`);
      const base = b.amount_to_allocate ?? bal.available;
      target = r2(base * tot / 100);
      amounts = spread(target, lines.map((l) => n(l.pct)));
      if (tot < 99.9999) warnings.push(`${r4(100 - tot)}% of ₹${base} stays unallocated`);
      break;
    }
    case 'MANUAL': {
      if (lines.some((l) => !l.manual_amount)) throw BadRequest('Enter the amount of every order');
      amounts = lines.map((l) => r2(n(l.manual_amount)));
      target = r2(amounts.reduce((a, v) => a + v, 0));
      break;
    }
    default: {
      target = r2(b.amount_to_allocate ?? bal.available);
      const w = b.method === 'EQUAL' ? lines.map(() => 1)
        : b.method === 'QUANTITY' ? lines.map((l) => n(l.o.basis_qty))
          : lines.map((l) => { if (l.o.basis_value == null) throw BadRequest(`Order ${l.o.so_no} has no exchange rate to INR — value basis not possible`); return n(l.o.basis_value); });
      if (w.some((x) => x <= 0)) throw BadRequest(`${b.method === 'QUANTITY' ? 'Quantity' : 'Value'} of ${lines.filter((_, i) => w[i] <= 0).map((l) => l.o.so_no).join(', ')} is zero — remove it or use another method`);
      amounts = spread(target, w);
    }
  }
  if (target <= 0) throw BadRequest(bal.eligible <= 0 ? 'This sample has no posted cost to allocate — post its costs first' : 'Nothing left to allocate');
  if (target > bal.available + 0.005) {
    throw BadRequest(`₹${target} is more than the balance that can be allocated (₹${bal.available}: posted eligible ₹${bal.eligible} − allocated ₹${bal.allocated}${bal.reserved ? ` − awaiting approval ₹${bal.reserved}` : ''})`);
  }
  const overrides = lines.filter((l) => l.o.override);
  const approved = ['APPROVED', 'COMPLETED'].includes(sm.status);
  if ((overrides.length || !approved) && !b.override_reason) {
    throw BadRequest(overrides.length ? `${overrides.map((l) => l.o.so_no).join(', ')} ${overrides.length > 1 ? 'are' : 'is'} not an order of this sample's buyer and style — give the override reason`
      : 'The sample is not approved by the buyer yet — give the override reason to allocate now', [{ field: 'override_reason', message: 'Required' }]);
  }
  if (!approved) warnings.push('Sample not buyer-approved — allocated on override');
  return {
    balance: bal, total: target, warnings,
    lines: lines.map((l, i) => ({ so_id: l.so_id, so_no: l.o.so_no, buyer_name: l.o.buyer_name, buyer_po_no: l.o.buyer_po_no, currency_code: l.o.currency_code,
      basis_pct: b.method === 'PERCENT' ? n(l.pct) : r4((amounts[i] / target) * 100), basis_qty: l.o.basis_qty, basis_value: l.o.basis_value,
      manual_amount: b.method === 'MANUAL' ? n(l.manual_amount) : null, allocated_amount: amounts[i], is_override: l.o.override ? 1 : 0 })),
  };
}

sampleAllocRouter.post('/samples/:id/allocations/preview', requireAny('SAMPLE.ALLOCATE', 'SAMPLE.ALLOC_APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sm = await getSample(cid, Number(req.params.id));
  const b = batchSchema.parse(req.body ?? {});
  res.json({ data: await compute(null, cid, sm, b, z.coerce.number().int().optional().parse(req.query.batch_id)) });
}));

async function writeLines(tx: Tx, batchId: number, lines: any[]) {
  await txExecute(tx, `DELETE FROM trx_sample_alloc_line WHERE batch_id = ?`, [batchId]);
  for (const l of lines) {
    await txExecute(tx, `INSERT INTO trx_sample_alloc_line (batch_id, so_id, basis_pct, basis_qty, basis_value, manual_amount, allocated_amount, is_override) VALUES (?,?,?,?,?,?,?,?)`,
      [batchId, l.so_id, l.basis_pct, l.basis_qty, l.basis_value, l.manual_amount, l.allocated_amount, l.is_override]);
  }
}

sampleAllocRouter.post('/samples/:id/allocations', requirePermission('SAMPLE.ALLOCATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = batchSchema.parse(req.body ?? {});
  const submitNow = req.query.submit === '1';
  const out = await transaction(async (tx) => {
    const sm = await lockSample(tx, cid, id);
    if (['DRAFT', 'CANCELLED'].includes(sm.status)) throw BadRequest(`A ${sm.status.toLowerCase()} sample's cost cannot be allocated`);
    const c = await compute(tx, cid, sm, b);
    const no = await nextDocNumber(tx, cid, 'SAMPLE_ALLOC');
    const r = await txExecute(tx, `INSERT INTO trx_sample_alloc_batch (company_id, batch_no, sample_id, method, amount_to_allocate, total_allocated, status, reason, override_reason, created_by, submitted_by, submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [cid, no, id, b.method, c.total, c.total, submitNow ? 'PENDING_APPROVAL' : 'DRAFT', b.reason, b.override_reason ?? null, req.user!.id,
      submitNow ? req.user!.id : null, submitNow ? new Date() : null]);
    const bid = Number(r.insertId);
    await writeLines(tx, bid, c.lines);
    await logSample(tx, req, id, 'ALLOCATION', bid, 'CREATE', undefined, { batch_no: no, method: b.method, total: c.total, orders: c.lines.map((l) => `${l.so_no}: ₹${l.allocated_amount}`), status: submitNow ? 'PENDING_APPROVAL' : 'DRAFT' }, b.reason);
    await bumpVersion(tx, id);
    return { id: bid, batch_no: no, total: c.total, warnings: c.warnings };
  });
  res.status(201).json({ data: out });
}));

async function lockBatch(tx: Tx, cid: number, bid: number) {
  const b = await txQueryOne<any>(tx, `SELECT * FROM trx_sample_alloc_batch WHERE id = ? AND company_id = ? FOR UPDATE`, [bid, cid]);
  if (!b) throw NotFound('Allocation not found');
  return b;
}

sampleAllocRouter.put('/sample-allocations/:bid', requirePermission('SAMPLE.ALLOCATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const bid = Number(req.params.bid);
  const b = batchSchema.parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const head = await txQueryOne<any>(tx, `SELECT sample_id FROM trx_sample_alloc_batch WHERE id = ? AND company_id = ?`, [bid, cid]);
    if (!head) throw NotFound('Allocation not found');
    const sm = await lockSample(tx, cid, Number(head.sample_id));
    const bt = await lockBatch(tx, cid, bid);
    if (b.row_version != null && Number(b.row_version) !== Number(bt.row_version)) throw Conflict('This allocation was changed by someone else — reload it');
    if (bt.status !== 'DRAFT') throw BadRequest(`A ${bt.status.replace(/_/g, ' ').toLowerCase()} allocation cannot be edited`);
    const c = await compute(tx, cid, sm, b, bid);
    await txExecute(tx, `UPDATE trx_sample_alloc_batch SET method = ?, amount_to_allocate = ?, total_allocated = ?, reason = ?, override_reason = ?, row_version = row_version + 1 WHERE id = ?`,
      [b.method, c.total, c.total, b.reason, b.override_reason ?? null, bid]);
    await writeLines(tx, bid, c.lines);
    await logSample(tx, req, sm.id, 'ALLOCATION', bid, 'UPDATE', { total: n(bt.total_allocated), method: bt.method }, { total: c.total, method: b.method }, b.reason);
    return { id: bid, total: c.total, warnings: c.warnings };
  });
  res.json({ data: out });
}));

const BATCH_ACTIONS = ['submit', 'approve', 'post', 'reject', 'cancel'] as const;

sampleAllocRouter.post('/sample-allocations/:bid/:action', requireAny('SAMPLE.ALLOCATE', 'SAMPLE.ALLOC_APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const bid = Number(req.params.bid);
  const action = z.enum([...BATCH_ACTIONS, 'reverse']).parse(req.params.action);
  const body = z.object({ reason: s.nullableStr(255), line_ids: z.array(z.coerce.number().int().positive()).nullish(), row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {});
  const out = await transaction(async (tx) => {
    const head = await txQueryOne<any>(tx, `SELECT sample_id FROM trx_sample_alloc_batch WHERE id = ? AND company_id = ?`, [bid, cid]);
    if (!head) throw NotFound('Allocation not found');
    // the sample row is the lock that serialises every allocation of the sample (spec §7.1: lock / recheck the pool)
    const sm = await lockSample(tx, cid, Number(head.sample_id));
    const bt = await lockBatch(tx, cid, bid);
    if (body.row_version != null && Number(body.row_version) !== Number(bt.row_version) && action !== 'post') throw Conflict('This allocation was changed by someone else — reload it');
    const uid = req.user!.id;
    const from = bt.status;
    let idempotent = false;
    switch (action) {
      case 'submit': {
        needPerm(req, 'SAMPLE.ALLOCATE');
        if (bt.status !== 'DRAFT') throw BadRequest(`Only a draft is submitted (this one is ${bt.status.replace(/_/g, ' ').toLowerCase()})`);
        const bal = await balances(tx, cid, sm, bid);
        if (n(bt.total_allocated) > bal.available + 0.005) throw BadRequest(`₹${n(bt.total_allocated)} is more than the balance that can be allocated now (₹${bal.available}) — edit the draft`);
        await txExecute(tx, `UPDATE trx_sample_alloc_batch SET status = 'PENDING_APPROVAL', submitted_by = ?, submitted_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [uid, bid]);
        break;
      }
      case 'approve':
        needPerm(req, 'SAMPLE.ALLOC_APPROVE');
        if (bt.status !== 'PENDING_APPROVAL') throw BadRequest('Only an allocation pending approval can be approved');
        await assertSegregation(req, bt.created_by, 'allocation');
        await txExecute(tx, `UPDATE trx_sample_alloc_batch SET status = 'APPROVED', approved_by = ?, approved_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [uid, bid]);
        break;
      case 'post': {
        needPerm(req, 'SAMPLE.ALLOC_APPROVE');
        if (['POSTED', 'PARTIALLY_REVERSED', 'REVERSED'].includes(bt.status)) { idempotent = true; break; } // a retried post makes nothing twice
        if (!['PENDING_APPROVAL', 'APPROVED'].includes(bt.status)) throw BadRequest('Submit the allocation for approval first');
        await assertSegregation(req, bt.created_by, 'allocation');
        const lines = await txQuery<any>(tx, `SELECT l.*, so.so_no, so.approval_state, so.order_type, so.is_deleted FROM trx_sample_alloc_line l JOIN trx_sales_order so ON so.id = l.so_id WHERE l.batch_id = ?`, [bid]);
        const bad = lines.filter((l) => !['APPROVED', 'CLOSED'].includes(l.approval_state) || ['SAMPLE', 'PROJECTION'].includes(l.order_type) || Number(l.is_deleted));
        if (bad.length) throw BadRequest(`No longer a confirmed order: ${bad.map((l) => l.so_no).join(', ')} — reject this allocation and make a new one`);
        const bal = await balances(tx, cid, sm, bid);
        const total = r2(lines.reduce((a, l) => a + n(l.allocated_amount), 0));
        if (total > bal.unallocated + 0.005) throw Conflict(`Posting ₹${total} would allocate more than the unallocated balance (₹${bal.unallocated}) — another allocation was posted or costs were reversed. Reject this one and allocate again.`);
        await txExecute(tx, `UPDATE trx_sample_alloc_batch SET status = 'POSTED', total_allocated = ?, approved_by = COALESCE(approved_by, ?), approved_at = COALESCE(approved_at, NOW()),
          posted_by = ?, posted_at = NOW(), row_version = row_version + 1 WHERE id = ?`, [total, uid, uid, bid]);
        break;
      }
      case 'reject':
        needPerm(req, 'SAMPLE.ALLOC_APPROVE');
        if (!['PENDING_APPROVAL', 'APPROVED'].includes(bt.status)) throw BadRequest('Only an allocation awaiting approval / posting can be rejected');
        if (!body.reason) throw BadRequest('Give the reason for rejecting', [{ field: 'reason', message: 'Required' }]);
        await txExecute(tx, `UPDATE trx_sample_alloc_batch SET status = 'REJECTED', reject_reason = ?, row_version = row_version + 1 WHERE id = ?`, [body.reason, bid]);
        break;
      case 'cancel':
        needPerm(req, 'SAMPLE.ALLOCATE');
        if (bt.status !== 'DRAFT') throw BadRequest('Only a draft can be cancelled');
        await txExecute(tx, `UPDATE trx_sample_alloc_batch SET status = 'CANCELLED', reject_reason = ?, row_version = row_version + 1 WHERE id = ?`, [body.reason ?? null, bid]);
        break;
      case 'reverse': {
        needPerm(req, 'SAMPLE.ALLOC_APPROVE');
        if (!['POSTED', 'PARTIALLY_REVERSED'].includes(bt.status)) throw BadRequest('Only a posted allocation can be reversed');
        if (!body.reason || body.reason.length < 3) throw BadRequest('Give the reason for reversing (e.g. order cancelled, reallocate)', [{ field: 'reason', message: 'Required' }]);
        const live = await txQuery<any>(tx, `SELECT id FROM trx_sample_alloc_line WHERE batch_id = ? AND status = 'ACTIVE'`, [bid]);
        const pick = body.line_ids?.length ? live.filter((l) => body.line_ids!.includes(Number(l.id))) : live;
        if (!pick.length) throw BadRequest('Nothing to reverse — the chosen lines are already reversed');
        await txQuery(tx, `UPDATE trx_sample_alloc_line SET status = 'REVERSED', reversed_by = ?, reversed_at = NOW(), reverse_reason = ? WHERE id IN (?)`, [uid, body.reason, pick.map((l) => l.id)]);
        const left = live.length - pick.length;
        await txExecute(tx, `UPDATE trx_sample_alloc_batch SET status = ?, row_version = row_version + 1 WHERE id = ?`, [left ? 'PARTIALLY_REVERSED' : 'REVERSED', bid]);
        break;
      }
    }
    if (!idempotent) {
      const now = await txQueryOne<any>(tx, `SELECT status, total_allocated FROM trx_sample_alloc_batch WHERE id = ?`, [bid]);
      await logSample(tx, req, sm.id, 'ALLOCATION', bid, action.toUpperCase(), { status: from }, { status: now?.status, batch_no: bt.batch_no, total: n(now?.total_allocated) }, body.reason);
      await bumpVersion(tx, sm.id);
    }
    const now = await txQueryOne<any>(tx, `SELECT status FROM trx_sample_alloc_batch WHERE id = ?`, [bid]);
    return { id: bid, status: now?.status, idempotent };
  });
  res.json({ data: out });
}));

/* ---------------------------------------------------------------- registers */
const BATCH_SELECT = `
  SELECT b.*, s.sample_no, s.sample_type, s.style_id, st.style_code, s.buyer_id, bp.party_name AS buyer_name,
         cb.full_name AS created_by_name, ab.full_name AS approved_by_name, pb.full_name AS posted_by_name,
         (SELECT COALESCE(SUM(l.allocated_amount),0) FROM trx_sample_alloc_line l WHERE l.batch_id = b.id AND l.status = 'ACTIVE') AS live_amount,
         (SELECT GROUP_CONCAT(so.so_no ORDER BY so.so_no SEPARATOR ', ') FROM trx_sample_alloc_line l JOIN trx_sales_order so ON so.id = l.so_id WHERE l.batch_id = b.id) AS orders
    FROM trx_sample_alloc_batch b
    JOIN trx_sample s ON s.id = b.sample_id
    LEFT JOIN mst_style st ON st.id = s.style_id
    LEFT JOIN mst_party bp ON bp.id = s.buyer_id
    LEFT JOIN mst_user cb ON cb.id = b.created_by
    LEFT JOIN mst_user ab ON ab.id = b.approved_by
    LEFT JOIN mst_user pb ON pb.id = b.posted_by`;
const LINE_SELECT = `
  SELECT l.*, so.so_no, so.io_no, so.buyer_po_no, so.approval_state, b2.party_name AS buyer_name, rb.full_name AS reversed_by_name
    FROM trx_sample_alloc_line l JOIN trx_sales_order so ON so.id = l.so_id LEFT JOIN mst_party b2 ON b2.id = so.buyer_id LEFT JOIN mst_user rb ON rb.id = l.reversed_by`;

async function withLines(batches: any[]) {
  const ids = batches.map((b) => b.id);
  const lines = ids.length ? await query<any>(`${LINE_SELECT} WHERE l.batch_id IN (?) ORDER BY l.id`, [ids]) : [];
  return batches.map((b) => ({ ...b, lines: lines.filter((l) => Number(l.batch_id) === Number(b.id)) }));
}

sampleAllocRouter.get('/samples/:id/allocations', requirePermission('SAMPLE.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const sm = await getSample(cid, Number(req.params.id));
  const [batches, bal] = await Promise.all([
    query<any>(`${BATCH_SELECT} WHERE b.company_id = ? AND b.sample_id = ? ORDER BY b.id DESC`, [cid, sm.id]), balances(null, cid, sm),
  ]);
  res.json({ data: await withLines(batches), balance: bal });
}));

/** GET /sample-allocations — allocation register / approval queue (spec §13). */
sampleAllocRouter.get('/sample-allocations', requirePermission('SAMPLE.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ status: z.string().trim().max(200).optional(), q: z.string().trim().max(60).optional(), so_id: z.coerce.number().int().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
  const where = ['b.company_id = ?']; const p: unknown[] = [cid];
  if (q.status) { where.push('b.status IN (?)'); p.push(q.status.split(',').map((x) => x.trim().toUpperCase())); }
  if (q.q) { where.push(`(b.batch_no LIKE ? OR s.sample_no LIKE ? OR st.style_code LIKE ? OR bp.party_name LIKE ? OR EXISTS (SELECT 1 FROM trx_sample_alloc_line x JOIN trx_sales_order xs ON xs.id = x.so_id WHERE x.batch_id = b.id AND xs.so_no LIKE ?))`); p.push(...Array(5).fill(`%${q.q}%`)); }
  if (q.so_id) { where.push('EXISTS (SELECT 1 FROM trx_sample_alloc_line x WHERE x.batch_id = b.id AND x.so_id = ?)'); p.push(q.so_id); }
  if (q.from) { where.push('DATE(b.created_at) >= ?'); p.push(q.from); }
  if (q.to) { where.push('DATE(b.created_at) <= ?'); p.push(q.to); }
  const batches = await query<any>(`${BATCH_SELECT} WHERE ${where.join(' AND ')} ORDER BY FIELD(b.status,'PENDING_APPROVAL','APPROVED','DRAFT') DESC, b.id DESC LIMIT 500`, p);
  res.json({ data: await withLines(batches) });
}));

/** GET /sample-allocations/by-order/:soId — sample development cost in an order's P&L, with drill-down to the source cost. */
sampleAllocRouter.get('/sample-allocations/by-order/:soId', requireAny('SAMPLE.VIEW', 'SALES_ORDER.VIEW', 'REPORT.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = Number(req.params.soId);
  const so = await queryOne<any>(`SELECT id, so_no FROM trx_sales_order WHERE id = ? AND company_id = ?`, [soId, cid]);
  if (!so) throw NotFound('Sales order not found');
  const rows = await query<any>(`
    SELECT l.id AS line_id, l.allocated_amount, l.basis_pct, l.status AS line_status, l.reversed_at, l.reverse_reason, l.is_override,
           b.id AS batch_id, b.batch_no, b.method, b.status AS batch_status, b.posted_at, b.accounting_mode, b.reason,
           s.id AS sample_id, s.sample_no, s.sample_type, s.qty AS sample_qty, s.status AS sample_status, st.style_code
      FROM trx_sample_alloc_line l JOIN trx_sample_alloc_batch b ON b.id = l.batch_id JOIN trx_sample s ON s.id = b.sample_id
      LEFT JOIN mst_style st ON st.id = s.style_id
     WHERE l.so_id = ? AND b.company_id = ? AND b.status IN ('POSTED','PARTIALLY_REVERSED','REVERSED','PENDING_APPROVAL','APPROVED')
     ORDER BY b.id DESC, l.id`, [soId, cid]);
  const live = rows.filter((r) => r.line_status === 'ACTIVE' && ['POSTED', 'PARTIALLY_REVERSED'].includes(r.batch_status));
  res.json({ data: rows, total_posted: r2(live.reduce((a, r) => a + n(r.allocated_amount), 0)),
    total_pending: r2(rows.filter((r) => ['PENDING_APPROVAL', 'APPROVED'].includes(r.batch_status)).reduce((a, r) => a + n(r.allocated_amount), 0)),
    basis: 'Analytical allocation of posted sample development cost (management P&L; no GL journal — the sample expense is not counted twice).' });
}));

