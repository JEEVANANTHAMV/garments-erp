import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { bundleAvail, TERMINAL } from './bundleLedger.js';
import { jobInfo } from './processDc.routes.js';
import { postBundleSewingOutput, postCheckingQc } from './productionFloor.routes.js';

/**
 * Sewing & Checking Line Allocation + Daily Plan, and Daily Output Entry – Sewing
 * (Sewing/Checking Line Allocation developer doc §4–§12, §24; client call 28-Sep-2026).
 *
 *   bundle stock ─► Line Allocation (planning, bundle → line) ─► Daily Plan (date/shift target)
 *                                                             ─► Daily Output (posts to the bundle ledger)
 *
 * Allocation and plan are planning documents: they never move stock. Quantities
 * come from the bundle ledger (bundleLedger.ts):
 *   sewing   — PCS at cutting + PCS already on a sewing line (sewing WIP)
 *   checking — sewn good PCS not yet checked (checking QC pending)
 *   ironing  — checked good PCS + PCS already in finishing (finishing WIP)
 *   packing  — finished PCS ready to pack
 * A bundle's open allocation (allocated − completed) is reserved across all
 * DRAFT / SAVED / CONFIRMED allocations, so the same PCS can never be allocated twice.
 */
export const lineAllocationPlanRouter = Router();

type Proc = 'sewing' | 'checking' | 'ironing' | 'packing';
const PROCS: Proc[] = ['sewing', 'checking', 'ironing', 'packing'];
const CFG = {
  sewing: {
    label: 'Sewing', line: 'cfg_sewing_line',
    alloc: 'trx_sewing_line_allocation', allocD: 'trx_sewing_line_allocation_detail',
    plan: 'trx_sewing_daily_plan', planD: 'trx_sewing_daily_plan_detail', planL: 'trx_sewing_daily_plan_line',
    allocDoc: 'SEW_LINE_ALLOC', planDoc: 'SEW_DAILY_PLAN',
  },
  checking: {
    label: 'Checking', line: 'cfg_checking_line',
    alloc: 'trx_checking_line_allocation', allocD: 'trx_checking_line_allocation_detail',
    plan: 'trx_checking_daily_plan', planD: 'trx_checking_daily_plan_detail', planL: 'trx_checking_daily_plan_line',
    allocDoc: 'CHK_LINE_ALLOC', planDoc: 'CHK_DAILY_PLAN',
  },
  ironing: {
    label: 'Ironing', line: 'cfg_ironing_line',
    alloc: 'trx_ironing_line_allocation', allocD: 'trx_ironing_line_allocation_detail',
    plan: 'trx_ironing_daily_plan', planD: 'trx_ironing_daily_plan_detail', planL: 'trx_ironing_daily_plan_line',
    allocDoc: 'IRN_LINE_ALLOC', planDoc: 'IRN_DAILY_PLAN',
  },
  packing: {
    label: 'Packing', line: 'cfg_packing_line',
    alloc: 'trx_packing_line_allocation', allocD: 'trx_packing_line_allocation_detail',
    plan: 'trx_packing_daily_plan', planD: 'trx_packing_daily_plan_detail', planL: 'trx_packing_daily_plan_line',
    allocDoc: 'PCK_LINE_ALLOC', planDoc: 'PCK_DAILY_PLAN',
  },
} as const;

const ACTIVE_ALLOC = ['DRAFT', 'SAVED', 'CONFIRMED'];
const OPEN_PLAN = ['DRAFT', 'SAVED', 'CONFIRMED', 'IN_PROGRESS'];

const n = (v: unknown) => Number(v ?? 0) || 0;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optId = z.coerce.number().int().positive().nullish();
const optStr = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const qty = z.coerce.number().int().min(0).default(0);
const reasonReq = z.string().trim().min(3, 'Give a reason (min 3 characters)').max(255);

function idParam(req: Request) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw NotFound('Document not found');
  return id;
}
const can = (req: Request, code: string) => !!req.user?.isSuperAdmin || !!req.user?.permissions.has(code);
const q = <T = any>(tx: Tx | null, sql: string, params: unknown[]) =>
  (tx ? txQuery<T>(tx, sql, params) : query<T>(sql, params));

/** Problems collected while validating, thrown together so the user fixes them in one pass. */
function fail(problems: string[]) {
  if (!problems.length) return;
  const head = problems.slice(0, 8).join('; ');
  throw BadRequest(problems.length > 8 ? `${head}; … and ${problems.length - 8} more` : head);
}

// ════════════════════════════════════════════════════════════════════
//  BUNDLE STOCK
// ════════════════════════════════════════════════════════════════════

interface BundleFilter {
  ids?: number[]; io_no?: string | null; style_id?: number | null; color_id?: number | null;
  size_id?: number | null; q?: string | null; limit?: number;
}

/** PCS of a bundle that the process can work on now. */
function readyQty(proc: Proc, b: Record<string, any>) {
  const a = bundleAvail({ ...b, balance_qty: b.balance_qty ?? b.qty });
  switch (proc) {
    case 'sewing': return a.cut + a.sewing_wip;
    case 'checking': return a.checking;
    case 'ironing': return a.checked + a.finishing_wip;
    default: return a.pack;
  }
}

/** SQL pre-filter: bundles that can hold PCS for the process at all. */
const CANDIDATE: Record<Proc, string> = {
  sewing: '(COALESCE(cb.balance_qty, cb.qty) > 0 OR COALESCE(cb.sew_in_qty,0) > COALESCE(cb.sew_good_qty,0) + COALESCE(cb.sew_reject_qty,0))',
  checking: 'COALESCE(cb.sew_good_qty,0) > 0',
  ironing: '(COALESCE(cb.chk_pass_qty,0) > 0 OR COALESCE(cb.fin_in_qty,0) > 0)',
  packing: 'COALESCE(cb.fin_good_qty,0) > 0',
};

/** Bundles holding PCS for the process, with job / style / colour / size / lay / cut / buyer. */
async function loadBundles(tx: Tx | null, cid: number, proc: Proc, f: BundleFilter) {
  const where = ['COALESCE(cb.company_id, c.company_id) = ?', `cb.status NOT IN (${TERMINAL.map(() => '?').join(',')})`];
  const params: unknown[] = [cid, ...TERMINAL];
  if (f.ids) {
    if (!f.ids.length) return new Map<number, any>();
    where.push('cb.id IN (?)'); params.push(f.ids);
  } else {
    where.push(CANDIDATE[proc]);
  }
  if (f.io_no) { where.push('cb.io_no = ?'); params.push(f.io_no); }
  if (f.style_id) { where.push('cb.style_id = ?'); params.push(f.style_id); }
  if (f.color_id) { where.push('cb.color_id = ?'); params.push(f.color_id); }
  if (f.size_id) { where.push('cb.size_id = ?'); params.push(f.size_id); }
  if (f.q) { where.push('(cb.bundle_no LIKE ? OR cb.barcode LIKE ? OR cb.io_no LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const rows = await q<any>(tx,
    `SELECT cb.*, st.style_code, st.style_name, col.color_name, sz.size_code, sz.sort_order AS size_sort,
            lp.lay_no, c.cut_no, c.cut_date
       FROM trx_cutting_bundle cb
       LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
       LEFT JOIN trx_lay_plan lp ON lp.id = COALESCE(cb.lay_id, c.lay_id)
       LEFT JOIN mst_style st ON st.id = cb.style_id
       LEFT JOIN mst_color col ON col.id = cb.color_id
       LEFT JOIN mst_size sz ON sz.id = cb.size_id
      WHERE ${where.join(' AND ')}
      ORDER BY cb.io_no, col.color_name, sz.sort_order, sz.size_code, cb.bundle_seq, cb.id
      LIMIT ${Math.min(f.limit ?? 3000, 5000)}`, params);
  const jobs = await jobInfo(cid, rows.map((r) => r.io_no));
  const out = new Map<number, any>();
  for (const b of rows) {
    const j = jobs.get(b.io_no);
    out.set(Number(b.id), {
      bundle_id: Number(b.id), bundle_no: b.bundle_no, barcode: b.barcode, status: b.status,
      io_no: b.io_no, job_no: b.io_no, po_no: j?.buyer_po_no ?? null, buyer: j?.buyer_name ?? null,
      style_id: b.style_id, style_no: b.style_code, style_description: b.style_name,
      colour_id: b.color_id, colour: b.color_name, size_id: b.size_id, size: b.size_code, size_sort: n(b.size_sort),
      part_name: b.part_name, lay_no: b.lay_no, cut_no: b.cut_no, inward_date: b.cut_date,
      bundle_qty: n(b.qty), weight_kg: b.allocated_kg == null ? null : Number(b.allocated_kg),
      ready_qty: readyQty(proc, b),
    });
  }
  return out;
}

/** Open (not yet completed) allocated PCS per bundle across active allocations. */
async function openAllocated(tx: Tx | null, cid: number, proc: Proc, bundleIds: number[], excludeId = 0) {
  const map = new Map<number, number>();
  if (!bundleIds.length) return map;
  const c = CFG[proc];
  const rows = await q<any>(tx,
    `SELECT d.bundle_id, SUM(GREATEST(CAST(d.allocated_qty AS SIGNED) - CAST(d.completed_qty AS SIGNED), 0)) AS open_qty
       FROM ${c.allocD} d JOIN ${c.alloc} h ON h.id = d.allocation_id
      WHERE h.company_id = ? AND h.status IN (?) AND h.id <> ? AND d.status = 'ALLOCATED' AND d.bundle_id IN (?)
      GROUP BY d.bundle_id`, [cid, ACTIVE_ALLOC, excludeId, bundleIds]);
  for (const r of rows) map.set(Number(r.bundle_id), n(r.open_qty));
  return map;
}

/** Bundles with PCS not yet allocated to any line. */
async function unallocatedBundles(cid: number, proc: Proc, f: BundleFilter, excludeId = 0) {
  const bundles = await loadBundles(null, cid, proc, f);
  const open = await openAllocated(null, cid, proc, [...bundles.keys()], excludeId);
  return [...bundles.values()]
    .map((b) => ({ ...b, allocated_elsewhere: open.get(b.bundle_id) ?? 0, available_qty: Math.max(b.ready_qty - (open.get(b.bundle_id) ?? 0), 0) }))
    .filter((b) => b.available_qty > 0);
}

// ════════════════════════════════════════════════════════════════════
//  LINES & CAPACITY
// ════════════════════════════════════════════════════════════════════

async function loadLines(tx: Tx | null, cid: number, proc: Proc, ids?: number[]) {
  const c = CFG[proc];
  const rows = await q<any>(tx,
    `SELECT l.*, u.unit_name FROM ${c.line} l LEFT JOIN mst_unit u ON u.id = l.unit_id
      WHERE l.company_id = ? ${ids ? 'AND l.id IN (?)' : 'AND l.is_active = 1'} ORDER BY l.line_code`,
    ids ? [cid, ids.length ? ids : [0]] : [cid]);
  return rows.map((l) => ({ ...l, capacity_pcs: n(l.capacity_pcs), capacity_pcs_day: n(l.capacity_pcs), sam_per_pcs: n(l.sam_per_pcs) }));
}

/** PCS already allocated per line on a date by other active allocations. */
async function allocatedOnDate(tx: Tx | null, cid: number, proc: Proc, date: string, excludeId = 0) {
  const c = CFG[proc];
  const rows = await q<any>(tx,
    `SELECT d.line_id, SUM(GREATEST(CAST(d.allocated_qty AS SIGNED) - CAST(d.completed_qty AS SIGNED), 0)) AS qty
       FROM ${c.allocD} d JOIN ${c.alloc} h ON h.id = d.allocation_id
      WHERE h.company_id = ? AND h.allocation_date = ? AND h.status IN (?) AND h.id <> ? AND d.status = 'ALLOCATED'
      GROUP BY d.line_id`, [cid, date, ACTIVE_ALLOC, excludeId]);
  return new Map(rows.map((r) => [Number(r.line_id), n(r.qty)]));
}

/** PCS already planned per line on a date (+ shift) by other open plans. */
async function plannedOnDate(tx: Tx | null, cid: number, proc: Proc, date: string, shiftId: number | null, excludeId = 0) {
  const c = CFG[proc];
  const rows = await q<any>(tx,
    `SELECT d.line_id, SUM(d.planned_qty) AS qty
       FROM ${c.planD} d JOIN ${c.plan} p ON p.id = d.plan_id
      WHERE p.company_id = ? AND p.plan_date = ? AND (p.shift_id <=> ?) AND p.status IN (?) AND p.id <> ?
      GROUP BY d.line_id`, [cid, date, shiftId, [...OPEN_PLAN, 'COMPLETED'], excludeId]);
  return new Map(rows.map((r) => [Number(r.line_id), n(r.qty)]));
}

// ════════════════════════════════════════════════════════════════════
//  ALLOCATION — validation & persistence
// ════════════════════════════════════════════════════════════════════

const allocDetailSchema = z.object({
  line_id: z.coerce.number().int().positive(),
  bundle_id: z.coerce.number().int().positive(),
  allocated_qty: z.coerce.number().int().positive('Allocated qty must be more than 0'),
  remarks: optStr(255),
});
const allocSchema = z.object({
  allocation_date: dateStr,
  floor_name: optStr(40),
  shift_id: optId,
  plan_type: z.enum(['LINE_WISE', 'JOB_WISE']).default('LINE_WISE'),
  pending_qty: qty,
  unallocated_qty: qty,
  remarks: optStr(500),
  capacity_override: z.boolean().default(false),
  confirm: z.boolean().default(false),
  details: z.array(allocDetailSchema).min(1, 'Allocate at least one bundle').max(3000),
});
type AllocBody = z.infer<typeof allocSchema>;

async function validateAllocation(tx: Tx, req: Request, proc: Proc, body: Pick<AllocBody, 'allocation_date' | 'capacity_override' | 'details'>, excludeId = 0) {
  const cid = req.user!.companyId;
  const problems: string[] = [];
  const bundleIds = body.details.map((d) => d.bundle_id);
  if (new Set(bundleIds).size !== bundleIds.length) problems.push('The same bundle is allocated twice in this document');

  const lineIds = [...new Set(body.details.map((d) => d.line_id))];
  const lines = new Map((await loadLines(tx, cid, proc, lineIds)).map((l) => [Number(l.id), l]));
  for (const id of lineIds) {
    const l = lines.get(id);
    if (!l) problems.push(`Line #${id} not found`);
    else if (!l.is_active) problems.push(`Line ${l.line_code} is inactive and cannot take allocation`);
  }

  // Lock the bundle rows so two planners cannot allocate the same PCS at once.
  const sorted = [...new Set(bundleIds)].sort((a, b) => a - b);
  await txQuery(tx, `SELECT id FROM trx_cutting_bundle WHERE id IN (?) ORDER BY id FOR UPDATE`, [sorted]);
  const bundles = await loadBundles(tx, cid, proc, { ids: sorted });
  const open = await openAllocated(tx, cid, proc, sorted, excludeId);
  for (const d of body.details) {
    const b = bundles.get(d.bundle_id);
    if (!b) { problems.push(`Bundle #${d.bundle_id} is not available (closed, cancelled or another company)`); continue; }
    const avail = Math.max(b.ready_qty - (open.get(d.bundle_id) ?? 0), 0);
    if (d.allocated_qty > avail) {
      problems.push(`Bundle ${b.bundle_no}: only ${avail} PCS available for ${CFG[proc].label.toLowerCase()}`
        + ((open.get(d.bundle_id) ?? 0) ? ` (${open.get(d.bundle_id)} PCS already allocated elsewhere)` : '')
        + `, ${d.allocated_qty} requested`);
    }
  }
  fail(problems);

  // Capacity: this document + other allocations of the same date must fit the line.
  const others = await allocatedOnDate(tx, cid, proc, body.allocation_date, excludeId);
  const byLine = new Map<number, number>();
  for (const d of body.details) byLine.set(d.line_id, (byLine.get(d.line_id) ?? 0) + d.allocated_qty);
  const over: string[] = [];
  for (const [lineId, q1] of byLine) {
    const l = lines.get(lineId)!;
    const total = q1 + (others.get(lineId) ?? 0);
    if (l.capacity_pcs > 0 && total > l.capacity_pcs) over.push(`${l.line_code}: ${total} PCS vs capacity ${l.capacity_pcs}`);
  }
  if (over.length) {
    if (!body.capacity_override) throw BadRequest(`Allocation exceeds line capacity — ${over.join('; ')}. Tick "Override capacity" (needs approval right) to save anyway.`);
    if (!can(req, 'PRODUCTION.APPROVE')) throw Forbidden(`Capacity override needs PRODUCTION.APPROVE — ${over.join('; ')}`);
  }
  return { bundles, lines };
}

async function writeAllocDetails(tx: Tx, proc: Proc, allocId: number, details: AllocBody['details'], bundles: Map<number, any>, lines: Map<number, any>) {
  const c = CFG[proc];
  for (const d of details) {
    const b = bundles.get(d.bundle_id);
    await txExecute(tx,
      `INSERT INTO ${c.allocD}
         (allocation_id, line_id, bundle_id, io_no, job_id, style_id, colour_id, size_id, po_no,
          allocated_qty, sam, planned_qty, completed_qty, status, remarks)
       VALUES (?,?,?,?,NULL,?,?,?,?,?,?,0,0,'ALLOCATED',?)`,
      [allocId, d.line_id, d.bundle_id, b.io_no ?? null, b.style_id ?? null, b.colour_id ?? null, b.size_id ?? null,
       b.po_no ?? null, d.allocated_qty, n(lines.get(d.line_id)?.sam_per_pcs), d.remarks ?? null]);
  }
}

function allocTotals(details: AllocBody['details'], bundles: Map<number, any>) {
  const jobs = new Set(details.map((d) => bundles.get(d.bundle_id)?.io_no ?? ''));
  const q1 = details.reduce((a, d) => a + d.allocated_qty, 0);
  return { total_jobs: jobs.size, total_bundles: details.length, total_qty: q1, allocated_qty: q1 };
}

async function allocDetailRows(tx: Tx | null, cid: number, proc: Proc, allocId: number) {
  const c = CFG[proc];
  const rows = await q<any>(tx,
    `SELECT d.*, l.line_code, l.line_name FROM ${c.allocD} d LEFT JOIN ${c.line} l ON l.id = d.line_id
      WHERE d.allocation_id = ? ORDER BY l.line_code, d.id`, [allocId]);
  const bundles = await loadBundles(tx, cid, proc, { ids: rows.map((r) => Number(r.bundle_id)) });
  return rows.map((r) => ({ ...(bundles.get(Number(r.bundle_id)) ?? {}), ...r, allocated_qty: n(r.allocated_qty), completed_qty: n(r.completed_qty) }));
}

// ════════════════════════════════════════════════════════════════════
//  DAILY PLAN — pending from confirmed allocations
// ════════════════════════════════════════════════════════════════════

/**
 * Allocation rows still to be planned on a date: allocated − completed − PCS
 * reserved by open plans of that date or later (older unfinished plans are
 * stale, so their balance can be re-planned), capped at the bundle's stock.
 */
async function pendingForPlan(tx: Tx | null, cid: number, proc: Proc, planDate: string, excludeId = 0, lineId?: number | null) {
  const c = CFG[proc];
  const rows = await q<any>(tx,
    `SELECT d.id AS allocation_detail_id, d.allocation_id, h.allocation_no, h.allocation_date, d.line_id,
            d.bundle_id, d.allocated_qty, d.completed_qty, d.sam,
            COALESCE((SELECT SUM(GREATEST(CAST(pd.planned_qty AS SIGNED) - CAST(pd.achieved_qty AS SIGNED), 0))
                        FROM ${c.planD} pd JOIN ${c.plan} p ON p.id = pd.plan_id
                       WHERE pd.allocation_detail_id = d.id AND p.status IN (?) AND p.plan_date >= ? AND p.id <> ?), 0) AS reserved_qty
       FROM ${c.allocD} d JOIN ${c.alloc} h ON h.id = d.allocation_id
      WHERE h.company_id = ? AND h.status = 'CONFIRMED' AND d.status = 'ALLOCATED' ${lineId ? 'AND d.line_id = ?' : ''}
      ORDER BY h.allocation_date, d.id`,
    lineId ? [OPEN_PLAN, planDate, excludeId, cid, lineId] : [OPEN_PLAN, planDate, excludeId, cid]);
  const bundles = await loadBundles(tx, cid, proc, { ids: [...new Set(rows.map((r) => Number(r.bundle_id)))] });
  const out: any[] = [];
  for (const r of rows) {
    const b = bundles.get(Number(r.bundle_id));
    if (!b) continue;
    const open = n(r.allocated_qty) - n(r.completed_qty) - n(r.reserved_qty);
    const pending = Math.min(open, b.ready_qty);
    if (pending <= 0) continue;
    out.push({ ...b, ...r, allocated_qty: n(r.allocated_qty), completed_qty: n(r.completed_qty), reserved_qty: n(r.reserved_qty), sam: n(r.sam), pending_qty: pending });
  }
  out.sort((a, b) => String(a.io_no).localeCompare(String(b.io_no)) || String(a.colour).localeCompare(String(b.colour))
    || a.size_sort - b.size_sort || String(a.bundle_no).localeCompare(String(b.bundle_no), undefined, { numeric: true }));
  return out;
}

const planDetailSchema = z.object({
  allocation_detail_id: z.coerce.number().int().positive('Plan rows must come from a confirmed line allocation'),
  line_id: z.coerce.number().int().positive(),
  planned_qty: z.coerce.number().int().positive('Planned qty must be more than 0'),
  priority: z.coerce.number().int().min(0).max(9).default(0),
  remarks: optStr(255),
});
const planLineSchema = z.object({
  line_id: z.coerce.number().int().positive(),
  supervisor_name: optStr(80),
  operators: qty,
  target_qty: qty,
  remarks: optStr(255),
});
const planSchema = z.object({
  plan_date: dateStr,
  floor_name: optStr(40),
  shift_id: optId,
  plan_type: z.enum(['LINE_WISE', 'JOB_WISE']).default('LINE_WISE'),
  unallocated_qty: qty,
  remarks: optStr(500),
  capacity_override: z.boolean().default(false),
  confirm: z.boolean().default(false),
  lines: z.array(planLineSchema).max(200).default([]),
  details: z.array(planDetailSchema).min(1, 'Plan at least one bundle').max(3000),
});
type PlanBody = z.infer<typeof planSchema>;

async function validatePlan(tx: Tx, req: Request, proc: Proc, body: Pick<PlanBody, 'plan_date' | 'shift_id' | 'capacity_override' | 'details' | 'lines'>, excludeId = 0) {
  const cid = req.user!.companyId;
  const problems: string[] = [];
  const ids = body.details.map((d) => d.allocation_detail_id);
  if (new Set(ids).size !== ids.length) problems.push('The same bundle is planned twice in this document');
  const pending = new Map((await pendingForPlan(tx, cid, proc, body.plan_date, excludeId)).map((r) => [Number(r.allocation_detail_id), r]));
  for (const d of body.details) {
    const p = pending.get(d.allocation_detail_id);
    if (!p) { problems.push(`Allocation row #${d.allocation_detail_id} has nothing left to plan (not confirmed, completed or planned already)`); continue; }
    if (Number(p.line_id) !== d.line_id) problems.push(`Bundle ${p.bundle_no} is allocated to another line`);
    if (d.planned_qty > p.pending_qty) problems.push(`Bundle ${p.bundle_no}: only ${p.pending_qty} PCS left to plan, ${d.planned_qty} requested`);
  }
  const lineIds = [...new Set([...body.details.map((d) => d.line_id), ...body.lines.map((l) => l.line_id)])];
  const lines = new Map((await loadLines(tx, cid, proc, lineIds)).map((l) => [Number(l.id), l]));
  for (const id of lineIds) {
    const l = lines.get(id);
    if (!l) problems.push(`Line #${id} not found`);
    else if (!l.is_active) problems.push(`Line ${l.line_code} is inactive`);
  }
  fail(problems);

  const others = await plannedOnDate(tx, cid, proc, body.plan_date, body.shift_id ?? null, excludeId);
  const byLine = new Map<number, number>();
  for (const d of body.details) byLine.set(d.line_id, (byLine.get(d.line_id) ?? 0) + d.planned_qty);
  const over: string[] = [];
  for (const [lineId, q1] of byLine) {
    const l = lines.get(lineId)!;
    const total = q1 + (others.get(lineId) ?? 0);
    if (l.capacity_pcs > 0 && total > l.capacity_pcs) over.push(`${l.line_code}: ${total} PCS vs capacity ${l.capacity_pcs}`);
  }
  if (over.length) {
    if (!body.capacity_override) throw BadRequest(`Plan exceeds line capacity — ${over.join('; ')}. Tick "Override capacity" (needs approval right) to save anyway.`);
    if (!can(req, 'PRODUCTION.APPROVE')) throw Forbidden(`Capacity override needs PRODUCTION.APPROVE — ${over.join('; ')}`);
  }
  return { pending, lines };
}

async function writePlanRows(tx: Tx, proc: Proc, planId: number, body: Pick<PlanBody, 'details' | 'lines'>, pending: Map<number, any>, lines: Map<number, any>) {
  const c = CFG[proc];
  for (const d of body.details) {
    const p = pending.get(d.allocation_detail_id);
    await txExecute(tx,
      `INSERT INTO ${c.planD}
         (plan_id, allocation_detail_id, line_id, bundle_id, io_no, job_id, style_id, colour_id, size_id, po_no,
          style_description, bundle_qty, planned_qty, achieved_qty, sam, priority, status, remarks)
       VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,0,?,?,'PLANNED',?)`,
      [planId, d.allocation_detail_id, d.line_id, p.bundle_id, p.io_no ?? null, p.style_id ?? null, p.colour_id ?? null,
       p.size_id ?? null, p.po_no ?? null, p.style_description ?? null, n(p.bundle_qty), d.planned_qty,
       n(p.sam) || n(lines.get(d.line_id)?.sam_per_pcs), d.priority, d.remarks ?? null]);
  }
  const settings = new Map(body.lines.map((l) => [l.line_id, l]));
  for (const lineId of new Set([...body.details.map((d) => d.line_id), ...settings.keys()])) {
    const s1 = settings.get(lineId);
    const l = lines.get(lineId);
    await txExecute(tx,
      `INSERT INTO ${c.planL} (plan_id, line_id, supervisor_name, operators, target_qty, remarks) VALUES (?,?,?,?,?,?)`,
      [planId, lineId, s1?.supervisor_name ?? l?.supervisor_name ?? null, s1?.operators ?? n(l?.manpower),
       s1?.target_qty || n(l?.capacity_pcs), s1?.remarks ?? null]);
  }
}

function planTotals(details: PlanBody['details'], pending: Map<number, any>) {
  return {
    total_bundles: details.length,
    total_qty: details.reduce((a, d) => a + n(pending.get(d.allocation_detail_id)?.bundle_qty), 0),
    allocated_qty: details.reduce((a, d) => a + d.planned_qty, 0),
  };
}

async function planDetailRows(tx: Tx | null, cid: number, proc: Proc, planId: number) {
  const c = CFG[proc];
  const rows = await q<any>(tx,
    `SELECT d.*, l.line_code, l.line_name FROM ${c.planD} d LEFT JOIN ${c.line} l ON l.id = d.line_id
      WHERE d.plan_id = ? ORDER BY l.line_code, d.id`, [planId]);
  const bundles = await loadBundles(tx, cid, proc, { ids: [...new Set(rows.map((r) => Number(r.bundle_id)).filter(Boolean))] });
  return rows.map((r) => ({ ...(bundles.get(Number(r.bundle_id)) ?? {}), ...r, planned_qty: n(r.planned_qty), achieved_qty: n(r.achieved_qty), bundle_qty: n(r.bundle_qty) }));
}

// ════════════════════════════════════════════════════════════════════
//  ROUTES (same set for /sewing and /checking)
// ════════════════════════════════════════════════════════════════════

const listQuery = z.object({
  status: z.string().optional(), from: dateStr.optional(), to: dateStr.optional(),
});
const bundleQuery = z.object({
  io_no: optStr(40), style_id: optId, color_id: optId, size_id: optId, q: optStr(80),
  exclude_id: z.coerce.number().int().min(0).default(0),
});

for (const proc of PROCS) {
  const c = CFG[proc];
  const base = `/${proc}`;

  // ── Lines with capacity, allocated (date) and planned (date + shift) ──
  const linesHandler = ah(async (req, res) => {
    const cid = req.user!.companyId;
    const qp = z.object({ date: dateStr.optional(), shift_id: optId, exclude_id: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const lines = await loadLines(null, cid, proc);
    const alloc = qp.date ? await allocatedOnDate(null, cid, proc, qp.date, qp.exclude_id) : new Map();
    const planned = qp.date ? await plannedOnDate(null, cid, proc, qp.date, qp.shift_id ?? null, qp.exclude_id) : new Map();
    res.json({ data: lines.map((l) => ({ ...l, allocated_other: alloc.get(Number(l.id)) ?? 0, planned_other: planned.get(Number(l.id)) ?? 0 })) });
  });
  lineAllocationPlanRouter.get(`${base}/lines`, requirePermission('PRODUCTION.VIEW'), linesHandler);
  lineAllocationPlanRouter.get(`${base}/lines/capacity`, requirePermission('PRODUCTION.VIEW'), linesHandler);

  // ── Unallocated bundle stock ──
  lineAllocationPlanRouter.get(`${base}/unallocated-bundles`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const qp = bundleQuery.parse(req.query);
    res.json({ data: await unallocatedBundles(req.user!.companyId, proc, qp, qp.exclude_id) });
  }));

  // ── Line allocation ──
  lineAllocationPlanRouter.get(`${base}/line-allocation`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const qp = listQuery.parse(req.query);
    const where = ['a.company_id = ?']; const params: unknown[] = [cid];
    if (qp.status) { where.push('a.status = ?'); params.push(qp.status); }
    if (qp.from) { where.push('a.allocation_date >= ?'); params.push(qp.from); }
    if (qp.to) { where.push('a.allocation_date <= ?'); params.push(qp.to); }
    const rows = await query(
      `SELECT a.*, s.shift_name, u.full_name AS created_by_name,
              (SELECT COUNT(DISTINCT d.line_id) FROM ${c.allocD} d WHERE d.allocation_id = a.id) AS line_count
         FROM ${c.alloc} a
         LEFT JOIN cfg_shift s ON s.id = a.shift_id
         LEFT JOIN mst_user u ON u.id = a.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY a.allocation_date DESC, a.id DESC LIMIT 200`, params);
    res.json({ data: rows });
  }));

  lineAllocationPlanRouter.post(`${base}/line-allocation/auto-plan`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const body = z.object({
      allocation_date: dateStr,
      exclude_id: z.coerce.number().int().min(0).default(0),
      line_ids: z.array(z.coerce.number().int().positive()).optional(),
      bundle_ids: z.array(z.coerce.number().int().positive()).optional(),
      current: z.array(allocDetailSchema.pick({ line_id: true, bundle_id: true, allocated_qty: true })).default([]),
    }).parse(req.body);
    const lines = (await loadLines(null, cid, proc)).filter((l) => !body.line_ids?.length || body.line_ids.includes(Number(l.id)));
    if (!lines.length) throw BadRequest('No active lines to plan on');
    const others = await allocatedOnDate(null, cid, proc, body.allocation_date, body.exclude_id);
    const balance = new Map(lines.map((l) => [Number(l.id), l.capacity_pcs - (others.get(Number(l.id)) ?? 0)]));
    for (const d of body.current) if (balance.has(d.line_id)) balance.set(d.line_id, balance.get(d.line_id)! - d.allocated_qty);
    const taken = new Set(body.current.map((d) => d.bundle_id));
    let stock = (await unallocatedBundles(cid, proc, {}, body.exclude_id)).filter((b) => !taken.has(b.bundle_id));
    if (body.bundle_ids?.length) stock = stock.filter((b) => body.bundle_ids!.includes(b.bundle_id));

    // Keep a job + colour together on one line where it fits; whole bundles only.
    const groups = new Map<string, any[]>();
    for (const b of stock) {
      const k = `${b.io_no}|${b.colour}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(b);
    }
    const proposal: { line_id: number; bundle_id: number; allocated_qty: number }[] = [];
    let skipped = 0;
    for (const bs of groups.values()) {
      const need = bs.reduce((a, b) => a + b.available_qty, 0);
      const ranked = [...balance.entries()].sort((a, b) => b[1] - a[1]);
      const whole = ranked.find(([, bal]) => bal >= need);
      for (const b of bs) {
        const target = whole && balance.get(whole[0])! >= b.available_qty
          ? whole[0]
          : [...balance.entries()].sort((a, b2) => b2[1] - a[1]).find(([, bal]) => bal >= b.available_qty)?.[0];
        if (!target) { skipped++; continue; }
        proposal.push({ line_id: target, bundle_id: b.bundle_id, allocated_qty: b.available_qty });
        balance.set(target, balance.get(target)! - b.available_qty);
      }
    }
    res.json({ data: proposal, meta: { proposed: proposal.length, skipped_no_capacity: skipped } });
  }));

  lineAllocationPlanRouter.get(`${base}/line-allocation/:id`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const head = await queryOne(
      `SELECT a.*, s.shift_name FROM ${c.alloc} a LEFT JOIN cfg_shift s ON s.id = a.shift_id WHERE a.id = ? AND a.company_id = ?`, [id, cid]);
    if (!head) throw NotFound('Allocation not found');
    const details = await allocDetailRows(null, cid, proc, id);
    // Stock still free for each bundle when this document is edited (its own PCS count as free).
    const open = await openAllocated(null, cid, proc, details.map((d) => Number(d.bundle_id)), id);
    res.json({ data: { ...(head as any), details: details.map((d) => ({ ...d, available_qty: Math.max(n(d.ready_qty) - (open.get(Number(d.bundle_id)) ?? 0), 0) })) } });
  }));

  lineAllocationPlanRouter.post(`${base}/line-allocation`, requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const body = allocSchema.parse(req.body);
    if (body.confirm && !can(req, 'PRODUCTION.UPDATE')) throw Forbidden('Confirming needs PRODUCTION.UPDATE');
    const result = await transaction(async (tx) => {
      const { bundles, lines } = await validateAllocation(tx, req, proc, body);
      const no = await nextDocNumber(tx, cid, c.allocDoc);
      const status = body.confirm ? 'CONFIRMED' : 'SAVED';
      const t = allocTotals(body.details, bundles);
      const ins = await txExecute(tx,
        `INSERT INTO ${c.alloc}
           (company_id, allocation_no, allocation_date, floor_name, shift_id, plan_type, total_jobs, total_bundles,
            total_qty, pending_qty, allocated_qty, unallocated_qty, status, remarks, capacity_override,
            created_by, confirmed_by, confirmed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, no, body.allocation_date, body.floor_name, body.shift_id ?? null, body.plan_type, t.total_jobs, t.total_bundles,
         t.total_qty, body.pending_qty, t.allocated_qty, body.unallocated_qty, status, body.remarks, body.capacity_override ? 1 : 0,
         req.user!.id, body.confirm ? req.user!.id : null, body.confirm ? new Date() : null]);
      await writeAllocDetails(tx, proc, ins.insertId, body.details, bundles, lines);
      await audit(req, c.alloc, ins.insertId, 'INSERT', undefined, { allocation_no: no, status, ...t }, tx);
      return { id: ins.insertId, allocation_no: no, status, ...t };
    });
    res.status(201).json({ data: result });
  }));

  lineAllocationPlanRouter.put(`${base}/line-allocation/:id`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const body = allocSchema.parse(req.body);
    const result = await transaction(async (tx) => {
      const existing = await txQueryOne<any>(tx, `SELECT * FROM ${c.alloc} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!existing) throw NotFound('Allocation not found');
      if (!['DRAFT', 'SAVED'].includes(existing.status)) throw BadRequest(`Allocation ${existing.allocation_no} is ${existing.status} — only draft / saved allocations can be edited`);
      const { bundles, lines } = await validateAllocation(tx, req, proc, body, id);
      const status = body.confirm ? 'CONFIRMED' : 'SAVED';
      const t = allocTotals(body.details, bundles);
      await txExecute(tx,
        `UPDATE ${c.alloc} SET allocation_date = ?, floor_name = ?, shift_id = ?, plan_type = ?, total_jobs = ?,
            total_bundles = ?, total_qty = ?, pending_qty = ?, allocated_qty = ?, unallocated_qty = ?, status = ?,
            remarks = ?, capacity_override = ?, confirmed_by = ?, confirmed_at = ?
          WHERE id = ?`,
        [body.allocation_date, body.floor_name, body.shift_id ?? null, body.plan_type, t.total_jobs,
         t.total_bundles, t.total_qty, body.pending_qty, t.allocated_qty, body.unallocated_qty, status,
         body.remarks, body.capacity_override ? 1 : 0, body.confirm ? req.user!.id : null, body.confirm ? new Date() : null, id]);
      await txExecute(tx, `DELETE FROM ${c.allocD} WHERE allocation_id = ?`, [id]);
      await writeAllocDetails(tx, proc, id, body.details, bundles, lines);
      await audit(req, c.alloc, id, 'UPDATE', existing, { status, ...t }, tx);
      return { id, allocation_no: existing.allocation_no, status, ...t };
    });
    res.json({ data: result });
  }));

  lineAllocationPlanRouter.post(`${base}/line-allocation/:id/confirm`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const result = await transaction(async (tx) => {
      const h = await txQueryOne<any>(tx, `SELECT * FROM ${c.alloc} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!h) throw NotFound('Allocation not found');
      if (!['DRAFT', 'SAVED'].includes(h.status)) throw BadRequest(`Allocation ${h.allocation_no} is already ${h.status}`);
      const details = await txQuery<any>(tx, `SELECT line_id, bundle_id, allocated_qty, remarks FROM ${c.allocD} WHERE allocation_id = ?`, [id]);
      if (!details.length) throw BadRequest('Allocation has no bundles');
      await validateAllocation(tx, req, proc, {
        allocation_date: String(h.allocation_date instanceof Date ? h.allocation_date.toISOString() : h.allocation_date).slice(0, 10),
        capacity_override: !!h.capacity_override,
        details: details.map((d) => ({ line_id: Number(d.line_id), bundle_id: Number(d.bundle_id), allocated_qty: n(d.allocated_qty), remarks: d.remarks })),
      }, id);
      await txExecute(tx, `UPDATE ${c.alloc} SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`, [req.user!.id, id]);
      await audit(req, c.alloc, id, 'UPDATE', { status: h.status }, { status: 'CONFIRMED' }, tx);
      return { id, allocation_no: h.allocation_no, status: 'CONFIRMED' };
    });
    res.json({ data: result });
  }));

  lineAllocationPlanRouter.post(`${base}/line-allocation/:id/cancel`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const { reason } = z.object({ reason: reasonReq }).parse(req.body);
    const result = await transaction(async (tx) => {
      const h = await txQueryOne<any>(tx, `SELECT * FROM ${c.alloc} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!h) throw NotFound('Allocation not found');
      if (['CANCELLED', 'CLOSED'].includes(h.status)) throw BadRequest(`Allocation ${h.allocation_no} is already ${h.status}`);
      if (h.status === 'CONFIRMED' && !can(req, 'PRODUCTION.APPROVE')) throw Forbidden('Cancelling a confirmed allocation needs PRODUCTION.APPROVE');
      const used = await txQueryOne<any>(tx,
        `SELECT p.plan_no FROM ${c.planD} pd JOIN ${c.plan} p ON p.id = pd.plan_id JOIN ${c.allocD} d ON d.id = pd.allocation_detail_id
          WHERE d.allocation_id = ? AND p.status <> 'CANCELLED' LIMIT 1`, [id]);
      if (used) throw BadRequest(`Allocation is used by daily plan ${used.plan_no} — cancel that plan first`);
      const done = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(completed_qty),0) AS c FROM ${c.allocD} WHERE allocation_id = ?`, [id]);
      if (n(done?.c) > 0) throw BadRequest('Output is already recorded against this allocation — close it instead of cancelling');
      await txExecute(tx, `UPDATE ${c.alloc} SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
      await txExecute(tx, `UPDATE ${c.allocD} SET status = 'CANCELLED' WHERE allocation_id = ?`, [id]);
      await audit(req, c.alloc, id, 'UPDATE', { status: h.status }, { status: 'CANCELLED', reason }, tx);
      return { id, allocation_no: h.allocation_no, status: 'CANCELLED' };
    });
    res.json({ data: result });
  }));

  // ── Daily plan ──
  lineAllocationPlanRouter.get(`${base}/daily-plan`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const qp = listQuery.parse(req.query);
    const where = ['p.company_id = ?']; const params: unknown[] = [cid];
    if (qp.status) {
      const st = qp.status.split(',');
      where.push('p.status IN (?)'); params.push(st);
    }
    if (qp.from) { where.push('p.plan_date >= ?'); params.push(qp.from); }
    if (qp.to) { where.push('p.plan_date <= ?'); params.push(qp.to); }
    const rows = await query(
      `SELECT p.*, s.shift_name, u.full_name AS created_by_name,
              (SELECT COALESCE(SUM(d.achieved_qty),0) FROM ${c.planD} d WHERE d.plan_id = p.id) AS achieved_qty
         FROM ${c.plan} p
         LEFT JOIN cfg_shift s ON s.id = p.shift_id
         LEFT JOIN mst_user u ON u.id = p.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY p.plan_date DESC, p.id DESC LIMIT 200`, params);
    res.json({ data: rows });
  }));

  lineAllocationPlanRouter.get(`${base}/daily-plan/pending`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const qp = z.object({ plan_date: dateStr, exclude_id: z.coerce.number().int().min(0).default(0), line_id: optId }).parse(req.query);
    res.json({ data: await pendingForPlan(null, req.user!.companyId, proc, qp.plan_date, qp.exclude_id, qp.line_id) });
  }));

  lineAllocationPlanRouter.post(`${base}/daily-plan/auto-plan`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const body = z.object({
      plan_date: dateStr, shift_id: optId,
      exclude_id: z.coerce.number().int().min(0).default(0),
      targets: z.record(z.string(), z.coerce.number().int().min(0)).default({}),
    }).parse(req.body);
    const lines = await loadLines(null, cid, proc);
    const others = await plannedOnDate(null, cid, proc, body.plan_date, body.shift_id ?? null, body.exclude_id);
    const pending = await pendingForPlan(null, cid, proc, body.plan_date, body.exclude_id);
    const proposal: { allocation_detail_id: number; line_id: number; planned_qty: number }[] = [];
    for (const l of lines) {
      let room = (body.targets[String(l.id)] ?? l.capacity_pcs) - (others.get(Number(l.id)) ?? 0);
      for (const p of pending.filter((x) => Number(x.line_id) === Number(l.id))) {
        if (room <= 0) break;
        const take = Math.min(room, p.pending_qty);
        proposal.push({ allocation_detail_id: Number(p.allocation_detail_id), line_id: Number(l.id), planned_qty: take });
        room -= take;
      }
    }
    res.json({ data: proposal, meta: { pending_rows: pending.length, proposed: proposal.length } });
  }));

  lineAllocationPlanRouter.post(`${base}/daily-plan/copy-previous`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const body = z.object({ plan_date: dateStr, shift_id: optId, exclude_id: z.coerce.number().int().min(0).default(0) }).parse(req.body);
    const prev = await queryOne<any>(
      `SELECT * FROM ${c.plan} WHERE company_id = ? AND plan_date < ? AND status <> 'CANCELLED' AND id <> ?
        ORDER BY (shift_id <=> ?) DESC, plan_date DESC, id DESC LIMIT 1`, [cid, body.plan_date, body.exclude_id, body.shift_id ?? null]);
    if (!prev) throw NotFound(`No earlier ${c.label.toLowerCase()} plan to copy`);
    const prevRows = await query<any>(`SELECT allocation_detail_id, line_id, planned_qty, priority, remarks FROM ${c.planD} WHERE plan_id = ?`, [prev.id]);
    const lines = await query<any>(`SELECT line_id, supervisor_name, operators, target_qty, remarks FROM ${c.planL} WHERE plan_id = ?`, [prev.id]);
    const pending = new Map((await pendingForPlan(null, cid, proc, body.plan_date, body.exclude_id)).map((r) => [Number(r.allocation_detail_id), r]));
    const details = prevRows
      .map((r) => ({ ...r, planned_qty: Math.min(n(r.planned_qty), n(pending.get(Number(r.allocation_detail_id))?.pending_qty)) }))
      .filter((r) => r.planned_qty > 0);
    res.json({ data: { source_plan_no: prev.plan_no, source_plan_date: prev.plan_date, lines, details, skipped: prevRows.length - details.length } });
  }));

  lineAllocationPlanRouter.get(`${base}/daily-plan/:id`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const head = await queryOne<any>(
      `SELECT p.*, s.shift_name FROM ${c.plan} p LEFT JOIN cfg_shift s ON s.id = p.shift_id WHERE p.id = ? AND p.company_id = ?`, [id, cid]);
    if (!head) throw NotFound('Plan not found');
    const details = await planDetailRows(null, cid, proc, id);
    const lines = await query(`SELECT * FROM ${c.planL} WHERE plan_id = ?`, [id]);
    res.json({ data: { ...head, lines, details } });
  }));

  lineAllocationPlanRouter.post(`${base}/daily-plan`, requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const body = planSchema.parse(req.body);
    if (body.confirm && !can(req, 'PRODUCTION.UPDATE')) throw Forbidden('Confirming needs PRODUCTION.UPDATE');
    const result = await transaction(async (tx) => {
      const { pending, lines } = await validatePlan(tx, req, proc, body);
      const no = await nextDocNumber(tx, cid, c.planDoc);
      const status = body.confirm ? 'CONFIRMED' : 'SAVED';
      const t = planTotals(body.details, pending);
      const ins = await txExecute(tx,
        `INSERT INTO ${c.plan}
           (company_id, plan_no, plan_date, floor_name, shift_id, plan_type, total_bundles, total_qty, allocated_qty,
            unallocated_qty, status, remarks, created_by, confirmed_by, confirmed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, no, body.plan_date, body.floor_name, body.shift_id ?? null, body.plan_type, t.total_bundles, t.total_qty,
         t.allocated_qty, body.unallocated_qty, status, body.remarks, req.user!.id,
         body.confirm ? req.user!.id : null, body.confirm ? new Date() : null]);
      await writePlanRows(tx, proc, ins.insertId, body, pending, lines);
      await audit(req, c.plan, ins.insertId, 'INSERT', undefined, { plan_no: no, status, ...t }, tx);
      return { id: ins.insertId, plan_no: no, status, ...t };
    });
    res.status(201).json({ data: result });
  }));

  lineAllocationPlanRouter.put(`${base}/daily-plan/:id`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const body = planSchema.parse(req.body);
    const result = await transaction(async (tx) => {
      const existing = await txQueryOne<any>(tx, `SELECT * FROM ${c.plan} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!existing) throw NotFound('Plan not found');
      if (!['DRAFT', 'SAVED'].includes(existing.status)) throw BadRequest(`Plan ${existing.plan_no} is ${existing.status} — only draft / saved plans can be edited`);
      const { pending, lines } = await validatePlan(tx, req, proc, body, id);
      const status = body.confirm ? 'CONFIRMED' : 'SAVED';
      const t = planTotals(body.details, pending);
      await txExecute(tx,
        `UPDATE ${c.plan} SET plan_date = ?, floor_name = ?, shift_id = ?, plan_type = ?, total_bundles = ?, total_qty = ?,
            allocated_qty = ?, unallocated_qty = ?, status = ?, remarks = ?, confirmed_by = ?, confirmed_at = ?
          WHERE id = ?`,
        [body.plan_date, body.floor_name, body.shift_id ?? null, body.plan_type, t.total_bundles, t.total_qty,
         t.allocated_qty, body.unallocated_qty, status, body.remarks,
         body.confirm ? req.user!.id : null, body.confirm ? new Date() : null, id]);
      await txExecute(tx, `DELETE FROM ${c.planD} WHERE plan_id = ?`, [id]);
      await txExecute(tx, `DELETE FROM ${c.planL} WHERE plan_id = ?`, [id]);
      await writePlanRows(tx, proc, id, body, pending, lines);
      await audit(req, c.plan, id, 'UPDATE', existing, { status, ...t }, tx);
      return { id, plan_no: existing.plan_no, status, ...t };
    });
    res.json({ data: result });
  }));

  lineAllocationPlanRouter.post(`${base}/daily-plan/:id/confirm`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const result = await transaction(async (tx) => {
      const h = await txQueryOne<any>(tx, `SELECT * FROM ${c.plan} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!h) throw NotFound('Plan not found');
      if (!['DRAFT', 'SAVED'].includes(h.status)) throw BadRequest(`Plan ${h.plan_no} is already ${h.status}`);
      const details = await txQuery<any>(tx, `SELECT allocation_detail_id, line_id, planned_qty, priority, remarks FROM ${c.planD} WHERE plan_id = ?`, [id]);
      if (!details.length) throw BadRequest('Plan has no bundles');
      await validatePlan(tx, req, proc, {
        plan_date: String(h.plan_date instanceof Date ? h.plan_date.toISOString() : h.plan_date).slice(0, 10),
        shift_id: h.shift_id, capacity_override: true, lines: [],
        details: details.map((d) => ({ allocation_detail_id: Number(d.allocation_detail_id), line_id: Number(d.line_id), planned_qty: n(d.planned_qty), priority: n(d.priority), remarks: d.remarks })),
      }, id);
      await txExecute(tx, `UPDATE ${c.plan} SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`, [req.user!.id, id]);
      await audit(req, c.plan, id, 'UPDATE', { status: h.status }, { status: 'CONFIRMED' }, tx);
      return { id, plan_no: h.plan_no, status: 'CONFIRMED' };
    });
    res.json({ data: result });
  }));

  lineAllocationPlanRouter.post(`${base}/daily-plan/:id/cancel`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const { reason } = z.object({ reason: reasonReq }).parse(req.body);
    const result = await transaction(async (tx) => {
      const h = await txQueryOne<any>(tx, `SELECT * FROM ${c.plan} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!h) throw NotFound('Plan not found');
      if (['CANCELLED', 'CLOSED', 'COMPLETED'].includes(h.status)) throw BadRequest(`Plan ${h.plan_no} is already ${h.status}`);
      if (h.status !== 'DRAFT' && h.status !== 'SAVED' && !can(req, 'PRODUCTION.APPROVE')) throw Forbidden('Cancelling a confirmed plan needs PRODUCTION.APPROVE');
      const done = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(achieved_qty),0) AS a FROM ${c.planD} WHERE plan_id = ?`, [id]);
      if (n(done?.a) > 0) throw BadRequest('Output is already recorded against this plan — it cannot be cancelled');
      await txExecute(tx, `UPDATE ${c.plan} SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
      await txExecute(tx, `UPDATE ${c.planD} SET status = 'CANCELLED' WHERE plan_id = ?`, [id]);
      await audit(req, c.plan, id, 'UPDATE', { status: h.status }, { status: 'CANCELLED', reason }, tx);
      return { id, plan_no: h.plan_no, status: 'CANCELLED' };
    });
    res.json({ data: result });
  }));
}


// ════════════════════════════════════════════════════════════════════
//  DAILY OUTPUT ENTRY – SEWING  /  CHECKING ENTRY (QC)
//  Same document for both (client image 1, developer doc §10, §14):
//  Input = Good + Rework + Reject per bundle; confirming posts the bundle ledger.
// ════════════════════════════════════════════════════════════════════

type OutProc = 'sewing' | 'checking';
const OUT_PROCS: OutProc[] = ['sewing', 'checking'];
const OUT = {
  sewing: { out: 'trx_sewing_daily_output', outL: 'trx_sewing_daily_output_line', doc: 'SEW_DAILY_OUT', label: 'Output' },
  checking: { out: 'trx_checking_daily_output', outL: 'trx_checking_daily_output_line', doc: 'CHK_DAILY_OUT', label: 'Checking entry' },
} as const;

const timeStr = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM').nullish().or(z.literal('')).transform((v) => (v ? v : null));
const outLineSchema = z.object({
  bundle_id: z.coerce.number().int().positive(),
  plan_detail_id: optId,
  input_qty: qty, good_qty: qty, rework_qty: qty, reject_qty: qty,
  defect_id: optId,
  operator_name: optStr(80),
  start_time: timeStr, end_time: timeStr,
  remarks: optStr(255),
});
const outSchema = z.object({
  output_date: dateStr,
  shift_id: optId,
  floor_name: optStr(40),
  line_id: z.coerce.number().int().positive('Choose the line'),
  plan_id: optId,
  supervisor_name: optStr(80),
  remarks: optStr(500),
  confirm: z.boolean().default(false),
  lines: z.array(outLineSchema).min(1, 'Enter output for at least one bundle').max(1000),
});
type OutBody = z.infer<typeof outSchema>;

const PLAN_OPEN_FOR_OUTPUT = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'];

async function validateOutput(tx: Tx, req: Request, proc: OutProc, body: OutBody, excludeId = 0) {
  const cid = req.user!.companyId;
  const c = CFG[proc]; const o = OUT[proc];
  const problems: string[] = [];
  const line = (await loadLines(tx, cid, proc, [body.line_id]))[0];
  if (!line) throw BadRequest(`${c.label} line not found`);
  if (!line.is_active) throw BadRequest(`Line ${line.line_code} is inactive`);
  if (body.plan_id) {
    const plan = await txQueryOne<any>(tx, `SELECT * FROM ${c.plan} WHERE id = ? AND company_id = ?`, [body.plan_id, cid]);
    if (!plan) throw BadRequest('Daily plan not found');
    if (!PLAN_OPEN_FOR_OUTPUT.includes(plan.status)) throw BadRequest(`Daily plan ${plan.plan_no} is ${plan.status} — confirm the plan first`);
  }
  const ids = body.lines.map((l) => l.bundle_id);
  if (new Set(ids).size !== ids.length) problems.push('The same bundle is entered twice');
  const bundles = await loadBundles(tx, cid, proc, { ids: [...new Set(ids)] });
  const planRows = body.plan_id
    ? new Map((await txQuery<any>(tx, `SELECT * FROM ${c.planD} WHERE plan_id = ?`, [body.plan_id])).map((r) => [Number(r.id), r]))
    : new Map<number, any>();
  // PCS already sitting in other draft entries of the same bundle (not posted yet).
  const drafts = new Map((await txQuery<any>(tx,
    `SELECT l.bundle_id, SUM(l.input_qty) AS q FROM ${o.outL} l JOIN ${o.out} h ON h.id = l.output_id
      WHERE h.company_id = ? AND h.status = 'DRAFT' AND h.id <> ? AND l.bundle_id IN (?) GROUP BY l.bundle_id`,
    [cid, excludeId, ids.length ? ids : [0]])).map((r) => [Number(r.bundle_id), n(r.q)]));
  for (const l of body.lines) {
    const b = bundles.get(l.bundle_id);
    if (!b) { problems.push(`Bundle #${l.bundle_id} is not available`); continue; }
    if (l.input_qty <= 0) problems.push(`Bundle ${b.bundle_no}: input qty is 0`);
    if (l.input_qty !== l.good_qty + l.rework_qty + l.reject_qty) {
      problems.push(`Bundle ${b.bundle_no}: input ${l.input_qty} ≠ good ${l.good_qty} + rework ${l.rework_qty} + reject ${l.reject_qty}`);
    }
    const free = b.ready_qty - (drafts.get(l.bundle_id) ?? 0);
    if (l.input_qty > free) problems.push(`Bundle ${b.bundle_no}: only ${Math.max(free, 0)} PCS can still be ${proc === 'sewing' ? 'sewn' : 'checked'}, ${l.input_qty} entered`);
    if (l.plan_detail_id) {
      const pr = planRows.get(l.plan_detail_id);
      if (!pr || Number(pr.bundle_id) !== l.bundle_id) problems.push(`Bundle ${b.bundle_no} is not on the loaded plan`);
      else if (Number(pr.line_id) !== body.line_id) problems.push(`Bundle ${b.bundle_no} is planned on another line`);
    }
    if (l.start_time && l.end_time && l.end_time < l.start_time) problems.push(`Bundle ${b.bundle_no}: end time is before start time`);
  }
  fail(problems);
  return { line, bundles };
}

function outTotals(lines: OutBody['lines']) {
  return lines.reduce((a, l) => ({
    input_qty: a.input_qty + l.input_qty, good_qty: a.good_qty + l.good_qty,
    rework_qty: a.rework_qty + l.rework_qty, reject_qty: a.reject_qty + l.reject_qty,
  }), { input_qty: 0, good_qty: 0, rework_qty: 0, reject_qty: 0 });
}

async function writeOutLines(tx: Tx, proc: OutProc, outId: number, lines: OutBody['lines'], bundles: Map<number, any>) {
  for (const l of lines) {
    const b = bundles.get(l.bundle_id);
    await txExecute(tx,
      `INSERT INTO ${OUT[proc].outL}
         (output_id, bundle_id, plan_detail_id, io_no, style_id, color_id, size_id, input_qty, good_qty, rework_qty,
          reject_qty, defect_id, operator_name, start_time, end_time, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [outId, l.bundle_id, l.plan_detail_id ?? null, b.io_no ?? null, b.style_id ?? null, b.colour_id ?? null, b.size_id ?? null,
       l.input_qty, l.good_qty, l.rework_qty, l.reject_qty, l.defect_id ?? null, l.operator_name,
       l.start_time, l.end_time, l.remarks]);
  }
}

/** Post a draft entry: bundle ledger + plan achieved + allocation completed. */
async function confirmOutput(tx: Tx, req: Request, proc: OutProc, outId: number) {
  const cid = req.user!.companyId;
  const c = CFG[proc]; const o = OUT[proc];
  const h = await txQueryOne<any>(tx, `SELECT * FROM ${o.out} WHERE id = ? AND company_id = ? FOR UPDATE`, [outId, cid]);
  if (!h) throw NotFound(`${o.label} not found`);
  if (h.status !== 'DRAFT') throw BadRequest(`${o.label} ${h.output_no} is already ${h.status}`);
  const line = (await loadLines(tx, cid, proc, [Number(h.line_id)]))[0];
  const rows = await txQuery<any>(tx, `SELECT * FROM ${o.outL} WHERE output_id = ? ORDER BY bundle_id`, [outId]);
  const date = String(h.output_date).slice(0, 10);
  const posted: any[] = [];
  for (const r of rows) {
    const q1 = { good: n(r.good_qty), reject: n(r.reject_qty), rework: n(r.rework_qty) };
    if (proc === 'sewing') {
      posted.push(...await postBundleSewingOutput(tx, req, Number(r.bundle_id), {
        date, line_name: line.line_code, line_aliases: [line.line_name], ...q1,
        operator_name: r.operator_name, remarks: `Daily output ${h.output_no}`,
      }));
    } else {
      posted.push(await postCheckingQc(tx, req, Number(r.bundle_id), { date, line_name: line.line_code, ...q1, remarks: `Checking entry ${h.output_no}` }));
    }
    const produced = q1.good + q1.reject;
    let allocDetailId: number | null = null;
    if (r.plan_detail_id) {
      await txExecute(tx,
        `UPDATE ${c.planD} SET achieved_qty = achieved_qty + ?,
                status = IF(achieved_qty >= planned_qty, 'COMPLETED', 'IN_PROGRESS') WHERE id = ?`,
        [q1.good, r.plan_detail_id]);
      const pd = await txQueryOne<any>(tx, `SELECT allocation_detail_id FROM ${c.planD} WHERE id = ?`, [r.plan_detail_id]);
      allocDetailId = pd?.allocation_detail_id ? Number(pd.allocation_detail_id) : null;
    }
    if (!allocDetailId) {
      const ad = await txQueryOne<any>(tx,
        `SELECT d.id FROM ${c.allocD} d JOIN ${c.alloc} a ON a.id = d.allocation_id
          WHERE a.company_id = ? AND a.status = 'CONFIRMED' AND d.status = 'ALLOCATED' AND d.bundle_id = ? AND d.line_id = ?
          ORDER BY d.id LIMIT 1`, [cid, r.bundle_id, h.line_id]);
      allocDetailId = ad ? Number(ad.id) : null;
    }
    if (allocDetailId && produced > 0) {
      await txExecute(tx,
        `UPDATE ${c.allocD} SET completed_qty = LEAST(completed_qty + ?, allocated_qty),
                status = IF(completed_qty >= allocated_qty, 'COMPLETED', status) WHERE id = ?`,
        [produced, allocDetailId]);
    }
  }
  if (h.plan_id) {
    const s1 = await txQueryOne<any>(tx,
      `SELECT SUM(planned_qty) AS p, SUM(LEAST(achieved_qty, planned_qty)) AS a FROM ${c.planD} WHERE plan_id = ? AND status <> 'CANCELLED'`, [h.plan_id]);
    await txExecute(tx, `UPDATE ${c.plan} SET status = ? WHERE id = ? AND status IN ('CONFIRMED','IN_PROGRESS')`,
      [n(s1?.a) >= n(s1?.p) && n(s1?.p) > 0 ? 'COMPLETED' : 'IN_PROGRESS', h.plan_id]);
  }
  await txExecute(tx, `UPDATE ${o.out} SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`, [req.user!.id, outId]);
  await audit(req, o.out, outId, 'UPDATE', { status: 'DRAFT' }, { status: 'CONFIRMED' }, tx);
  const rework = posted.filter((p) => p?.rework_input).map((p) => p.rework_input);
  return { id: outId, output_no: h.output_no, status: 'CONFIRMED', ...(rework.length ? { rework_sent_to_sewing: rework } : {}) };
}

for (const proc of OUT_PROCS) {
  const c = CFG[proc]; const o = OUT[proc];
  const base = `/${proc}/daily-output`;

  lineAllocationPlanRouter.get(base, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const qp = listQuery.parse(req.query);
    const where = ['h.company_id = ?']; const params: unknown[] = [cid];
    if (qp.status) { where.push('h.status = ?'); params.push(qp.status); }
    if (qp.from) { where.push('h.output_date >= ?'); params.push(qp.from); }
    if (qp.to) { where.push('h.output_date <= ?'); params.push(qp.to); }
    const rows = await query(
      `SELECT h.*, l.line_code, l.line_name, s.shift_name, p.plan_no
         FROM ${o.out} h
         LEFT JOIN ${c.line} l ON l.id = h.line_id
         LEFT JOIN cfg_shift s ON s.id = h.shift_id
         LEFT JOIN ${c.plan} p ON p.id = h.plan_id
        WHERE ${where.join(' AND ')}
        ORDER BY h.output_date DESC, h.id DESC LIMIT 200`, params);
    res.json({ data: rows });
  }));

  /** Plan rows of a line for the entry: planned, achieved so far, allocation totals. */
  lineAllocationPlanRouter.get(`${base}/load-plan`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const qp = z.object({ plan_id: optId, plan_no: optStr(40), line_id: optId }).parse(req.query);
    if (!qp.plan_id && !qp.plan_no) throw BadRequest('Give the daily plan no');
    const plan = await queryOne<any>(
      `SELECT p.*, s.shift_name FROM ${c.plan} p LEFT JOIN cfg_shift s ON s.id = p.shift_id
        WHERE p.company_id = ? AND ${qp.plan_id ? 'p.id = ?' : 'p.plan_no = ?'}`, [cid, qp.plan_id ?? qp.plan_no]);
    if (!plan) throw NotFound('Daily plan not found');
    if (!PLAN_OPEN_FOR_OUTPUT.includes(plan.status)) throw BadRequest(`Daily plan ${plan.plan_no} is ${plan.status} — confirm it before entering output`);
    const rows = (await planDetailRows(null, cid, proc, plan.id))
      .filter((r) => r.status !== 'CANCELLED' && (!qp.line_id || Number(r.line_id) === qp.line_id));
    const planLines = await query<any>(
      `SELECT pl.*, l.line_code, l.line_name FROM ${c.planL} pl JOIN ${c.line} l ON l.id = pl.line_id WHERE pl.plan_id = ?`, [plan.id]);
    const adIds = rows.map((r) => Number(r.allocation_detail_id)).filter(Boolean);
    const alloc = adIds.length
      ? new Map((await query<any>(`SELECT id, allocated_qty, completed_qty FROM ${c.allocD} WHERE id IN (?)`, [adIds])).map((a) => [Number(a.id), a]))
      : new Map();
    res.json({
      data: {
        plan, lines: planLines,
        details: rows.map((r) => ({
          ...r,
          allocation_qty: n(alloc.get(Number(r.allocation_detail_id))?.allocated_qty),
          previous_output: n(alloc.get(Number(r.allocation_detail_id))?.completed_qty),
          remaining_qty: Math.max(Math.min(r.planned_qty - r.achieved_qty, n(r.ready_qty)), 0),
        })),
      },
    });
  }));

  /** Scan / add a bundle that is not on the plan. */
  lineAllocationPlanRouter.get(`${base}/bundle`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const { code } = z.object({ code: z.string().trim().min(1).max(120) }).parse(req.query);
    const hit = await queryOne<any>(
      `SELECT cb.id FROM trx_cutting_bundle cb LEFT JOIN trx_cutting ct ON ct.id = cb.cutting_id
        WHERE (cb.barcode = ? OR cb.bundle_no = ?) AND COALESCE(cb.company_id, ct.company_id) = ?
        ORDER BY (cb.barcode = ?) DESC LIMIT 1`, [code, code, cid, code]);
    if (!hit) throw NotFound(`Bundle ${code} not found`);
    const b = (await loadBundles(null, cid, proc, { ids: [Number(hit.id)] })).get(Number(hit.id));
    if (!b) throw BadRequest(`Bundle ${code} is closed or cancelled`);
    if (b.ready_qty <= 0) throw BadRequest(`Bundle ${b.bundle_no} has no PCS left to ${proc === 'sewing' ? 'sew' : 'check'}`);
    res.json({ data: b });
  }));

  lineAllocationPlanRouter.get(`${base}/:id`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const head = await queryOne<any>(
      `SELECT h.*, l.line_code, l.line_name, s.shift_name, p.plan_no
         FROM ${o.out} h
         LEFT JOIN ${c.line} l ON l.id = h.line_id
         LEFT JOIN cfg_shift s ON s.id = h.shift_id
         LEFT JOIN ${c.plan} p ON p.id = h.plan_id
        WHERE h.id = ? AND h.company_id = ?`, [id, cid]);
    if (!head) throw NotFound(`${o.label} not found`);
    const rows = await query<any>(
      `SELECT l.*, d.defect_name, pd.planned_qty, pd.achieved_qty
         FROM ${o.outL} l
         LEFT JOIN mst_defect d ON d.id = l.defect_id
         LEFT JOIN ${c.planD} pd ON pd.id = l.plan_detail_id
        WHERE l.output_id = ? ORDER BY l.id`, [id]);
    const bundles = await loadBundles(null, cid, proc, { ids: rows.map((r) => Number(r.bundle_id)) });
    res.json({ data: { ...head, lines: rows.map((r) => ({ ...(bundles.get(Number(r.bundle_id)) ?? {}), ...r })) } });
  }));

  const planTarget = async (tx: Tx, body: OutBody) => (body.plan_id
    ? n((await txQueryOne<any>(tx, `SELECT SUM(planned_qty) AS t FROM ${c.planD} WHERE plan_id = ? AND line_id = ?`, [body.plan_id, body.line_id]))?.t)
    : 0);

  lineAllocationPlanRouter.post(base, requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const body = outSchema.parse(req.body);
    if (body.confirm && !can(req, 'PRODUCTION.UPDATE')) throw Forbidden('Confirming needs PRODUCTION.UPDATE');
    const result = await transaction(async (tx) => {
      const { bundles } = await validateOutput(tx, req, proc, body);
      const no = await nextDocNumber(tx, cid, o.doc);
      const t = outTotals(body.lines);
      const ins = await txExecute(tx,
        `INSERT INTO ${o.out}
           (company_id, output_no, output_date, shift_id, floor_name, line_id, plan_id, supervisor_name, target_qty,
            input_qty, good_qty, rework_qty, reject_qty, status, remarks, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,
        [cid, no, body.output_date, body.shift_id ?? null, body.floor_name, body.line_id, body.plan_id ?? null,
         body.supervisor_name, await planTarget(tx, body), t.input_qty, t.good_qty, t.rework_qty, t.reject_qty, body.remarks, req.user!.id]);
      await writeOutLines(tx, proc, ins.insertId, body.lines, bundles);
      await audit(req, o.out, ins.insertId, 'INSERT', undefined, { output_no: no, ...t }, tx);
      if (body.confirm) return confirmOutput(tx, req, proc, ins.insertId);
      return { id: ins.insertId, output_no: no, status: 'DRAFT' };
    });
    res.status(201).json({ data: result });
  }));

  lineAllocationPlanRouter.put(`${base}/:id`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const body = outSchema.parse(req.body);
    const result = await transaction(async (tx) => {
      const existing = await txQueryOne<any>(tx, `SELECT * FROM ${o.out} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!existing) throw NotFound(`${o.label} not found`);
      if (existing.status !== 'DRAFT') throw BadRequest(`${o.label} ${existing.output_no} is ${existing.status} — posted entries cannot be edited`);
      const { bundles } = await validateOutput(tx, req, proc, body, id);
      const t = outTotals(body.lines);
      await txExecute(tx,
        `UPDATE ${o.out} SET output_date = ?, shift_id = ?, floor_name = ?, line_id = ?, plan_id = ?,
            supervisor_name = ?, target_qty = ?, input_qty = ?, good_qty = ?, rework_qty = ?, reject_qty = ?, remarks = ?
          WHERE id = ?`,
        [body.output_date, body.shift_id ?? null, body.floor_name, body.line_id, body.plan_id ?? null,
         body.supervisor_name, await planTarget(tx, body), t.input_qty, t.good_qty, t.rework_qty, t.reject_qty, body.remarks, id]);
      await txExecute(tx, `DELETE FROM ${o.outL} WHERE output_id = ?`, [id]);
      await writeOutLines(tx, proc, id, body.lines, bundles);
      await audit(req, o.out, id, 'UPDATE', existing, t, tx);
      if (body.confirm) return confirmOutput(tx, req, proc, id);
      return { id, output_no: existing.output_no, status: 'DRAFT' };
    });
    res.json({ data: result });
  }));

  lineAllocationPlanRouter.post(`${base}/:id/confirm`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const id = idParam(req);
    res.json({ data: await transaction((tx) => confirmOutput(tx, req, proc, id)) });
  }));

  lineAllocationPlanRouter.post(`${base}/:id/cancel`, requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = idParam(req);
    const { reason } = z.object({ reason: reasonReq }).parse(req.body);
    const result = await transaction(async (tx) => {
      const h = await txQueryOne<any>(tx, `SELECT * FROM ${o.out} WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
      if (!h) throw NotFound(`${o.label} not found`);
      if (h.status !== 'DRAFT') throw BadRequest(`${o.label} ${h.output_no} is ${h.status} — posted entries are corrected by a reversal entry, not cancelled`);
      await txExecute(tx, `UPDATE ${o.out} SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason, id]);
      await audit(req, o.out, id, 'UPDATE', { status: 'DRAFT' }, { status: 'CANCELLED', reason }, tx);
      return { id, output_no: h.output_no, status: 'CANCELLED' };
    });
    res.json({ data: result });
  }));
}

// ════════════════════════════════════════════════════════════════════
//  REPORTS (developer doc §10, §28) & DASHBOARD KPIs (§29)
// ════════════════════════════════════════════════════════════════════

const rangeQuery = z.object({ from: dateStr, to: dateStr, line_id: optId });

/** Plan vs actual per date + line: planned, good, rework, reject, balance, achievement / rework / reject %. */
async function planVsActual(cid: number, proc: Proc, from: string, to: string, lineId?: number | null) {
  const c = CFG[proc];
  const plan = await query<any>(
    `SELECT p.plan_date, d.line_id, l.line_code, l.line_name, SUM(d.planned_qty) AS planned, SUM(d.achieved_qty) AS achieved
       FROM ${c.planD} d JOIN ${c.plan} p ON p.id = d.plan_id LEFT JOIN ${c.line} l ON l.id = d.line_id
      WHERE p.company_id = ? AND p.status <> 'CANCELLED' AND d.status <> 'CANCELLED' AND p.plan_date BETWEEN ? AND ? ${lineId ? 'AND d.line_id = ?' : ''}
      GROUP BY p.plan_date, d.line_id, l.line_code, l.line_name`, lineId ? [cid, from, to, lineId] : [cid, from, to]);
  const key = (d: string, l: number) => `${String(d).slice(0, 10)}|${l}`;
  const map = new Map<string, any>();
  for (const r of plan) {
    map.set(key(r.plan_date, r.line_id), {
      date: String(r.plan_date).slice(0, 10), line_id: Number(r.line_id), line_code: r.line_code, line_name: r.line_name,
      planned: n(r.planned), good: n(r.achieved), input: 0, rework: 0, reject: 0,
    });
  }
  if (proc === 'sewing' || proc === 'checking') {
    const o = OUT[proc];
    const outs = await query<any>(
      `SELECT h.output_date, h.line_id, l.line_code, l.line_name, SUM(h.input_qty) AS input, SUM(h.good_qty) AS good,
              SUM(h.rework_qty) AS rework, SUM(h.reject_qty) AS reject
         FROM ${o.out} h LEFT JOIN ${c.line} l ON l.id = h.line_id
        WHERE h.company_id = ? AND h.status = 'CONFIRMED' AND h.output_date BETWEEN ? AND ? ${lineId ? 'AND h.line_id = ?' : ''}
        GROUP BY h.output_date, h.line_id, l.line_code, l.line_name`, lineId ? [cid, from, to, lineId] : [cid, from, to]);
    for (const r of outs) {
      const k = key(r.output_date, r.line_id);
      const m = map.get(k) ?? { date: String(r.output_date).slice(0, 10), line_id: Number(r.line_id), line_code: r.line_code, line_name: r.line_name, planned: 0, good: 0, input: 0, rework: 0, reject: 0 };
      // Actual comes from the output entries (covers unplanned bundles too).
      Object.assign(m, { input: n(r.input), good: n(r.good), rework: n(r.rework), reject: n(r.reject) });
      map.set(k, m);
    }
  }
  const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : 0);
  const rows = [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || String(a.line_code).localeCompare(String(b.line_code)))
    .map((r) => ({ ...r, balance: Math.max(r.planned - r.good, 0), achievement_pct: pctOf(r.good, r.planned), rework_pct: pctOf(r.rework, r.input), reject_pct: pctOf(r.reject, r.input) }));
  const t = rows.reduce((a, r) => ({ planned: a.planned + r.planned, good: a.good + r.good, input: a.input + r.input, rework: a.rework + r.rework, reject: a.reject + r.reject }),
    { planned: 0, good: 0, input: 0, rework: 0, reject: 0 });
  return { rows, totals: { ...t, balance: Math.max(t.planned - t.good, 0), achievement_pct: pctOf(t.good, t.planned), rework_pct: pctOf(t.rework, t.input), reject_pct: pctOf(t.reject, t.input) } };
}

for (const proc of PROCS) {
  const c = CFG[proc];

  lineAllocationPlanRouter.get(`/${proc}/reports/plan-vs-actual`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const qp = rangeQuery.parse(req.query);
    res.json({ data: await planVsActual(req.user!.companyId, proc, qp.from, qp.to, qp.line_id) });
  }));

  /** Line capacity vs allocation vs plan vs actual for one date. */
  lineAllocationPlanRouter.get(`/${proc}/reports/line-utilization`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const qp = z.object({ date: dateStr, shift_id: optId }).parse(req.query);
    const lines = await loadLines(null, cid, proc);
    const alloc = await allocatedOnDate(null, cid, proc, qp.date);
    const planned = await plannedOnDate(null, cid, proc, qp.date, qp.shift_id ?? null);
    const actual = new Map((await planVsActual(cid, proc, qp.date, qp.date)).rows.map((r) => [r.line_id, r]));
    const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : 0);
    res.json({
      data: lines.map((l) => {
        const a = alloc.get(Number(l.id)) ?? 0; const p = planned.get(Number(l.id)) ?? 0; const act = actual.get(Number(l.id));
        return {
          line_id: l.id, line_code: l.line_code, line_name: l.line_name, supervisor_name: l.supervisor_name, capacity: l.capacity_pcs,
          allocated: a, planned: p, actual: act?.good ?? 0, rework: act?.rework ?? 0, reject: act?.reject ?? 0,
          allocation_util_pct: pctOf(a, l.capacity_pcs), plan_util_pct: pctOf(p, l.capacity_pcs), achievement_pct: pctOf(act?.good ?? 0, p),
        };
      }),
    });
  }));

  /** Allocation grouped by job / style / colour / size / line. */
  lineAllocationPlanRouter.get(`/${proc}/reports/allocation-summary`, requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const qp = z.object({ from: dateStr, to: dateStr, group_by: z.enum(['job', 'style', 'colour', 'size', 'line']).default('job') }).parse(req.query);
    const col = { job: 'd.io_no', style: 'st.style_code', colour: 'col.color_name', size: 'sz.size_code', line: 'l.line_code' }[qp.group_by];
    const rows = await query<any>(
      `SELECT ${col} AS group_key, COUNT(DISTINCT d.bundle_id) AS bundles, COUNT(DISTINCT d.line_id) AS line_count,
              SUM(d.allocated_qty) AS allocated, SUM(d.completed_qty) AS completed,
              SUM(GREATEST(CAST(d.allocated_qty AS SIGNED) - CAST(d.completed_qty AS SIGNED), 0)) AS open_qty
         FROM ${c.allocD} d JOIN ${c.alloc} a ON a.id = d.allocation_id
         LEFT JOIN ${c.line} l ON l.id = d.line_id
         LEFT JOIN mst_style st ON st.id = d.style_id
         LEFT JOIN mst_color col ON col.id = d.colour_id
         LEFT JOIN mst_size sz ON sz.id = d.size_id
        WHERE a.company_id = ? AND a.status <> 'CANCELLED' AND d.status <> 'CANCELLED' AND a.allocation_date BETWEEN ? AND ?
        GROUP BY ${col} ORDER BY allocated DESC`, [cid, qp.from, qp.to]);
    res.json({ data: rows.map((r) => ({ ...r, allocated: n(r.allocated), completed: n(r.completed), open_qty: n(r.open_qty), bundles: n(r.bundles), lines: n(r.line_count) })) });
  }));
}

/** Dashboard KPIs of a date (doc §29): sewing plan/actual and checking flow. */
lineAllocationPlanRouter.get('/production-planning/kpis', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { date } = z.object({ date: dateStr }).parse(req.query);
  const capOf = async (proc: Proc) => (await loadLines(null, cid, proc)).reduce((a, l) => a + n(l.capacity_pcs), 0);
  const out: Record<string, any> = {};
  for (const proc of PROCS) {
    const pva = (await planVsActual(cid, proc, date, date)).totals;
    out[proc] = { capacity: await capOf(proc), planned: pva.planned, actual: pva.good, balance: pva.balance,
      achievement_pct: pva.achievement_pct, rework: pva.rework, reject: pva.reject, rework_pct: pva.rework_pct, reject_pct: pva.reject_pct };
  }
  // Checking flow: waiting (inward, not yet checked), allocated / unallocated, QC today, outward today.
  const stock = await loadBundles(null, cid, 'checking', {});
  const waiting = [...stock.values()].reduce((a, b) => a + b.ready_qty, 0);
  const open = await openAllocated(null, cid, 'checking', [...stock.keys()]);
  const allocated = [...stock.values()].reduce((a, b) => a + Math.min(open.get(b.bundle_id) ?? 0, b.ready_qty), 0);
  const moved = await queryOne<any>(
    `SELECT COALESCE(SUM(m.moved_qty),0) AS q FROM trx_bundle_movement m
       LEFT JOIN trx_jobwork_challan_line jl ON m.ref_table = 'trx_jobwork_challan_line' AND jl.id = m.ref_id
       LEFT JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
      WHERE m.company_id = ? AND DATE(m.moved_at) = ?
        AND (m.txn_type = 'FINISHING_IN' OR (m.txn_type = 'DC_ISSUE' AND UPPER(ps.stage_code) IN ('IRON','IRONING','FINISH','FINISHING','PRESS')))`,
    [cid, date]);
  out.checking = { ...out.checking, inward_waiting: waiting, allocated, unallocated: Math.max(waiting - allocated, 0),
    qc_good: out.checking.actual, outward: n(moved?.q) };
  res.json({ data: { date, ...out } });
}));
