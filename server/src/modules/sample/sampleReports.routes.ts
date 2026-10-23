import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { requirePermission } from '../../middleware/auth.js';
import {
  OPEN_STATUSES, COUNTED, n, r2, todayIso, dayDiff, setting, calendar, costTotals, allocTotals, metrics, currentStage, nextAction,
  processAgeDays, DONE,
} from './sampleCore.js';

/**
 * Sample register, dashboard and reports (spec §6.1, §6.2, §13). Every figure is worked out from the same rows
 * (sampleCore.metrics), so a KPI card, the register it opens and the reports always agree.
 */
export const sampleReportsRouter = Router();
const VIEW = requirePermission('SAMPLE.VIEW');
const dateQ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

const KPIS = ['active', 'due_today', 'overdue', 'on_hold', 'pending_internal', 'pending_buyer', 'completed_month', 'unassigned', 'idle',
  'awaiting_resubmission', 'cost_approval', 'alloc_pending', 'alloc_exception', 'purchases_to_import', 'target_changed'] as const;

const filterQ = z.object({
  q: z.string().trim().max(60).optional(),
  status: z.string().trim().max(300).optional(),
  sample_type_id: z.coerce.number().int().optional(),
  buyer_id: z.coerce.number().int().optional(),
  style_id: z.coerce.number().int().optional(),
  priority: z.string().trim().max(10).optional(),
  merchandiser_id: z.coerce.number().int().optional(),
  department_id: z.coerce.number().int().optional(),
  owner_user_id: z.coerce.number().int().optional(),
  owner_contractor_id: z.coerce.number().int().optional(),
  from: dateQ, to: dateQ, target_from: dateQ, target_to: dateQ,
  kpi: z.enum(KPIS).optional(),
  include_closed: z.coerce.boolean().optional(),
});
type Filter = z.infer<typeof filterQ>;

/** Every sample matching the filter, with its stage, ageing, cost and allocation figures. */
export async function loadRegister(cid: number, f: Filter) {
  const where = ['t.company_id = ?', 't.is_deleted = 0']; const p: unknown[] = [cid];
  if (f.q) { where.push('(t.sample_no LIKE ? OR st.style_code LIKE ? OR st.style_name LIKE ? OR b.party_name LIKE ?)'); p.push(...Array(4).fill(`%${f.q}%`)); }
  if (f.status) { where.push('t.status IN (?)'); p.push(f.status.split(',').map((x) => x.trim().toUpperCase())); }
  for (const k of ['sample_type_id', 'buyer_id', 'style_id', 'merchandiser_id'] as const) if (f[k]) { where.push(`t.${k} = ?`); p.push(f[k]); }
  if (f.priority) { where.push('t.priority = ?'); p.push(f.priority); }
  if (f.from) { where.push('t.request_date >= ?'); p.push(f.from); }
  if (f.to) { where.push('t.request_date <= ?'); p.push(f.to); }
  if (f.target_from) { where.push('t.target_date >= ?'); p.push(f.target_from); }
  if (f.target_to) { where.push('t.target_date <= ?'); p.push(f.target_to); }
  const rows = await query<any>(`
    SELECT t.id, t.sample_no, t.sample_type, t.sample_type_id, ty.type_name, t.style_id, st.style_code, st.style_name, t.buyer_id, b.party_name AS buyer_name,
           t.priority, t.qty, um.code AS uom_code, t.request_date, t.target_date, t.completed_date, t.closed_at, t.status, t.revision_no, t.good_qty,
           t.recovered_amount, t.merchandiser_id, mu.full_name AS merchandiser_name, t.created_at, t.updated_at, t.row_version
      FROM trx_sample t
      LEFT JOIN mst_style st ON st.id = t.style_id LEFT JOIN mst_party b ON b.id = t.buyer_id
      LEFT JOIN mst_sample_type ty ON ty.id = t.sample_type_id LEFT JOIN cfg_uom um ON um.id = t.uom_id
      LEFT JOIN mst_user mu ON mu.id = t.merchandiser_id
     WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 5000`, p);
  const ids = rows.map((r) => Number(r.id));
  if (!ids.length) return [];
  const asOf = todayIso();
  const idleDays = n(await setting(cid, 'SAMPLE_IDLE_DAYS', '3')) || 3;
  const [procs, cal, c, a, targetChg, gpWaiting, lastAct] = await Promise.all([
    query<any>(`SELECT p.id, p.sample_id, p.revision_no, p.seq_no, p.step_group, p.is_mandatory, p.stage_name, p.status, p.department_id, d.dept_name,
                       p.assigned_user_id, u.full_name AS assigned_user_name, p.assigned_contractor_id, c.party_name AS assigned_contractor_name,
                       p.started_at, p.hold_since, p.hold_minutes, p.good_qty, p.reject_qty, p.rework_qty, p.sla_days, p.last_activity_at
                  FROM trx_sample_process p JOIN trx_sample t ON t.id = p.sample_id AND p.revision_no = t.revision_no
                  LEFT JOIN mst_department d ON d.id = p.department_id LEFT JOIN mst_user u ON u.id = p.assigned_user_id LEFT JOIN mst_party c ON c.id = p.assigned_contractor_id
                 WHERE p.sample_id IN (?) AND p.status <> 'CANCELLED'`, [ids]),
    calendar(cid), costTotals(cid, ids, asOf), allocTotals(ids),
    query<any>(`SELECT sample_id, COUNT(*) c FROM trx_sample_audit WHERE company_id = ? AND sample_id IN (?) AND action = 'TARGET_CHANGED' GROUP BY sample_id`, [cid, ids]),
    query<any>(`SELECT l.sample_id, COUNT(*) c FROM trx_general_purchase_line l JOIN trx_general_purchase g ON g.id = l.purchase_id
                 WHERE g.company_id = ? AND l.sample_id IN (?) AND l.allocation_type = 'SAMPLE' AND COALESCE(g.approval_state,'DRAFT') IN ('APPROVED','POSTED')
                   AND NOT EXISTS (SELECT 1 FROM trx_sample_cost x WHERE x.company_id = g.company_id AND x.source_key = CONCAT('GP_LINE:', l.id))
                 GROUP BY l.sample_id`, [cid, ids]),
    query<any>(`SELECT sample_id, MAX(created_at) at FROM trx_sample_audit WHERE company_id = ? AND sample_id IN (?) GROUP BY sample_id`, [cid, ids]),
  ]);
  const TC = new Map(targetChg.map((r) => [Number(r.sample_id), n(r.c)]));
  const GP = new Map(gpWaiting.map((r) => [Number(r.sample_id), n(r.c)]));
  const LA = new Map(lastAct.map((r) => [Number(r.sample_id), r.at ? new Date(r.at).getTime() : 0]));
  const byS = new Map<number, any[]>();
  for (const pr of procs) { const k = Number(pr.sample_id); const arr = byS.get(k) ?? []; arr.push(pr); byS.set(k, arr); }
  const monthStart = asOf.slice(0, 8) + '01';
  return rows.map((s) => {
    const mine = byS.get(Number(s.id)) ?? [];
    const cur = currentStage(s, mine);
    const m = metrics(s, c.get(Number(s.id)), a.get(Number(s.id)), cal, asOf);
    const open = (OPEN_STATUSES as readonly string[]).includes(s.status);
    const lastActivity = Math.max(LA.get(Number(s.id)) ?? 0, ...mine.map((x) => (x.last_activity_at ? new Date(x.last_activity_at).getTime() : 0)), s.updated_at ? new Date(s.updated_at).getTime() : 0);
    const idle = open && lastActivity > 0 && Date.now() - lastActivity > idleDays * 86_400_000;
    const unassigned = open && !!cur && !cur.assigned_user_id && !cur.assigned_contractor_id;
    const target = s.target_date ? String(s.target_date).slice(0, 10) : null;
    const productionOpen = open && !s.completed_date;
    return {
      ...s, ...m,
      current_stage: cur?.stage_name ?? null, current_stage_status: cur?.status ?? null,
      pending_department: cur?.dept_name ?? null, pending_department_id: cur?.department_id ?? null,
      pending_owner: cur ? cur.assigned_user_name ?? cur.assigned_contractor_name ?? null : null,
      pending_owner_user_id: cur?.assigned_user_id ?? null, pending_owner_contractor_id: cur?.assigned_contractor_id ?? null,
      process_age_days: cur ? processAgeDays(cur) : null,
      stages_done: mine.filter(DONE).length, stages_total: mine.length,
      good_qty_total: mine.reduce((t, x) => t + n(x.good_qty), 0), reject_qty_total: mine.reduce((t, x) => t + n(x.reject_qty), 0), rework_qty_total: mine.reduce((t, x) => t + n(x.rework_qty), 0),
      next_action: nextAction(s, cur), is_open: open,
      due_today: productionOpen && target === asOf, overdue: productionOpen && !!target && target < asOf,
      unassigned, idle, target_changed: (TC.get(Number(s.id)) ?? 0) > 0, purchases_to_import: GP.get(Number(s.id)) ?? 0,
      completed_this_month: !!s.completed_date && String(s.completed_date).slice(0, 10) >= monthStart,
      last_activity_at: lastActivity ? new Date(lastActivity) : null,
    };
  });
}

export function kpiMatch(r: any, k: typeof KPIS[number]) {
  switch (k) {
    case 'active': return r.is_open;
    case 'due_today': return r.due_today;
    case 'overdue': return r.overdue;
    case 'on_hold': return r.status === 'ON_HOLD';
    case 'pending_internal': return r.status === 'PENDING_INTERNAL_APPROVAL';
    case 'pending_buyer': return r.status === 'SUBMITTED_TO_BUYER';
    case 'completed_month': return r.completed_this_month;
    case 'unassigned': return r.unassigned;
    case 'idle': return r.idle;
    case 'awaiting_resubmission': return r.status === 'REVISION_REQUIRED' || r.status === 'REJECTED';
    case 'cost_approval': return r.costs_awaiting_approval > 0;
    case 'alloc_pending': return ['ELIGIBLE', 'PARTIAL'].includes(r.allocation_state) && r.status !== 'CANCELLED';
    case 'alloc_exception': return r.allocation_state === 'EXCEPTION';
    case 'purchases_to_import': return r.purchases_to_import > 0;
    case 'target_changed': return r.target_changed && r.is_open;
  }
}

function applyComputed(rows: any[], f: Filter) {
  return rows.filter((r) => (!f.kpi || kpiMatch(r, f.kpi))
    && (!f.department_id || Number(r.pending_department_id) === f.department_id)
    && (!f.owner_user_id || Number(r.pending_owner_user_id) === f.owner_user_id)
    && (!f.owner_contractor_id || Number(r.pending_owner_contractor_id) === f.owner_contractor_id)
    && (f.include_closed !== false || !['COMPLETED', 'CANCELLED'].includes(r.status) || !!f.status || !!f.kpi));
}

sampleReportsRouter.get('/samples', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const f = filterQ.extend({
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(25),
    sort: z.string().trim().max(40).optional(), dir: z.enum(['asc', 'desc']).default('desc'),
  }).parse(req.query);
  let rows = applyComputed(await loadRegister(cid, f), f);
  if (f.sort && /^[a-z_]+$/.test(f.sort)) {
    const k = f.sort; const d = f.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((x, y) => {
      const a = x[k]; const b = y[k];
      if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
      return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * d;
    });
  }
  const total = rows.length;
  const totals = { qty: rows.reduce((t, r) => t + n(r.qty), 0), today_cost: r2(rows.reduce((t, r) => t + n(r.today_cost), 0)),
    cumulative_cost: r2(rows.reduce((t, r) => t + n(r.cumulative_cost), 0)), allocated_cost: r2(rows.reduce((t, r) => t + n(r.allocated_cost), 0)),
    unallocated_cost: r2(rows.reduce((t, r) => t + Math.max(0, n(r.unallocated_cost)), 0)) };
  res.json({ data: rows.slice((f.page - 1) * f.pageSize, f.page * f.pageSize), totals,
    pagination: { page: f.page, pageSize: f.pageSize, total, totalPages: Math.max(1, Math.ceil(total / f.pageSize)) } });
}));

sampleReportsRouter.get('/samples-dashboard', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const f = filterQ.parse(req.query);
  const all = await loadRegister(cid, { ...f, kpi: undefined });
  const rows = applyComputed(all, { ...f, kpi: undefined, include_closed: true });
  const open = rows.filter((r) => r.is_open);
  const count = (k: typeof KPIS[number]) => rows.filter((r) => kpiMatch(r, k)).length;
  const withCost = rows.filter((r) => n(r.cumulative_cost) !== 0);
  const kpis = {
    active: count('active'), due_today: count('due_today'), overdue: count('overdue'), on_hold: count('on_hold'),
    pending_internal: count('pending_internal'), pending_buyer: count('pending_buyer'), completed_month: count('completed_month'),
    cumulative_cost: r2(rows.reduce((t, r) => t + n(r.cumulative_cost), 0)),
    today_cost: r2(rows.reduce((t, r) => t + n(r.today_cost), 0)),
    avg_cost_per_piece: withCost.length ? r2(withCost.reduce((t, r) => t + n(r.cumulative_cost), 0) / Math.max(1, withCost.reduce((t, r) => t + n(r.qty), 0))) : null,
    unallocated_cost: r2(rows.filter((r) => r.status !== 'CANCELLED').reduce((t, r) => t + Math.max(0, n(r.unallocated_cost)), 0)),
    allocated_cost: r2(rows.reduce((t, r) => t + n(r.allocated_cost), 0)),
  };
  const bucket = (d: number | null) => (d == null ? 'n/a' : d <= 2 ? '0–2 days' : d <= 5 ? '3–5 days' : d <= 10 ? '6–10 days' : '> 10 days');
  const group = (arr: any[], key: (r: any) => string, val: (r: any) => number = () => 1) => {
    const m = new Map<string, number>();
    for (const r of arr) m.set(key(r), r2((m.get(key(r)) ?? 0) + val(r)));
    return [...m.entries()].map(([label, value]) => ({ label, value }));
  };
  const ageing = ['0–2 days', '3–5 days', '6–10 days', '> 10 days'].map((label) => ({ label, value: open.filter((r) => bucket(r.elapsed_days) === label).length }));
  const stageDist = group(open, (r) => (r.status === 'ON_HOLD' ? 'On hold' : r.current_stage ?? r.status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c: string) => c.toUpperCase()))).sort((a, b) => b.value - a.value);
  const buyerLoad = group(open, (r) => r.buyer_name ?? '—').sort((a, b) => b.value - a.value).slice(0, 10);
  const costByType = group(rows, (r) => r.type_name ?? r.sample_type, (r) => n(r.cumulative_cost)).filter((x) => x.value !== 0).sort((a, b) => b.value - a.value);
  const since = new Date(Date.parse(`${todayIso()}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  const idsAll = rows.map((r) => Number(r.id));
  const trendRows = idsAll.length ? await query<any>(`SELECT cost_date, SUM(amount) amount FROM trx_sample_cost WHERE company_id = ? AND sample_id IN (?) AND status IN ${COUNTED} AND cost_date >= ?
    GROUP BY cost_date ORDER BY cost_date`, [cid, idsAll, since]) : [];
  const T = new Map(trendRows.map((t) => [String(t.cost_date).slice(0, 10), r2(n(t.amount))]));
  const trend = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.parse(`${since}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10); return { date: d, amount: T.get(d) ?? 0 }; });
  const EXC: [typeof KPIS[number], string][] = [
    ['unassigned', 'No owner on the current stage'], ['idle', 'No activity'], ['target_changed', 'Target date changed'],
    ['awaiting_resubmission', 'Rejected / changes requested — awaiting resubmission'], ['cost_approval', 'Costs awaiting approval'],
    ['alloc_exception', 'Allocated more than the posted cost (cost reversed)'], ['purchases_to_import', 'Purchases booked to the sample not in its cost'],
    ['alloc_pending', 'Cost not yet allocated to an order'],
  ];
  const exceptions = EXC.map(([key, label]) => ({ key, label, count: count(key),
    samples: rows.filter((r) => kpiMatch(r, key)).slice(0, 5).map((r) => ({ id: r.id, sample_no: r.sample_no })) })).filter((e) => e.count > 0);
  // pending work by department / person (spec §13)
  const pend = new Map<string, any>();
  for (const r of open.filter((x) => x.current_stage)) {
    const k = `${r.pending_department ?? 'No department'}|${r.pending_owner ?? 'Unassigned'}`;
    const e = pend.get(k) ?? { department: r.pending_department ?? 'No department', owner: r.pending_owner ?? 'Unassigned', open: 0, overdue: 0, oldest_days: 0, ages: [] as number[] };
    e.open++; if (r.overdue) e.overdue++;
    const age = r.process_age_days ?? r.elapsed_days ?? 0; e.ages.push(age); e.oldest_days = Math.max(e.oldest_days, age);
    pend.set(k, e);
  }
  const pending = [...pend.values()].map((e) => ({ department: e.department, owner: e.owner, open: e.open, overdue: e.overdue, oldest_days: r2(e.oldest_days),
    avg_days: r2(e.ages.reduce((a: number, b: number) => a + b, 0) / Math.max(1, e.ages.length)) })).sort((a, b) => b.open - a.open);
  res.json({ data: { kpis, ageing, stage_distribution: stageDist, buyer_load: buyerLoad, cost_by_type: costByType, daily_cost: trend, exceptions, pending_by_owner: pending, as_of: todayIso() } });
}));

/** Unallocated sample cost (spec §13): eligible, allocated, pending, remaining, confirmed orders available. */
sampleReportsRouter.get('/sample-reports/unallocated', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = (await loadRegister(cid, filterQ.parse(req.query))).filter((r) => r.status !== 'CANCELLED' && (r.eligible_cost > 0 || r.allocated_cost > 0));
  const orders = rows.length ? await query<any>(`SELECT t.id AS sample_id, COUNT(DISTINCT so.id) c FROM trx_sample t
      JOIN trx_sales_order so ON so.company_id = t.company_id AND so.buyer_id = t.buyer_id AND so.approval_state IN ('APPROVED','CLOSED') AND so.order_type NOT IN ('SAMPLE','PROJECTION') AND so.is_deleted = 0
      JOIN trx_sales_order_line l ON l.so_id = so.id AND l.style_id = t.style_id
     WHERE t.id IN (?) GROUP BY t.id`, [rows.map((r) => r.id)]) : [];
  const O = new Map(orders.map((o) => [Number(o.sample_id), n(o.c)]));
  res.json({ data: rows.map((r) => ({
    id: r.id, sample_no: r.sample_no, type_name: r.type_name ?? r.sample_type, buyer_name: r.buyer_name, style_code: r.style_code, status: r.status,
    cumulative_cost: r.cumulative_cost, eligible_cost: r.eligible_cost, allocated_cost: r.allocated_cost, pending_allocation: r.pending_allocation,
    unallocated_cost: r.unallocated_cost, allocation_state: r.allocation_state, confirmed_orders: O.get(Number(r.id)) ?? 0,
    days_since_completion: r.completed_date ? dayDiff(String(r.completed_date).slice(0, 10), todayIso()) : null,
  })).sort((a, b) => b.unallocated_cost - a.unallocated_cost) });
}));

/** Sample cost sheet (spec §13): category split + per-piece figures for each sample. */
sampleReportsRouter.get('/sample-reports/cost-sheet', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = (await loadRegister(cid, filterQ.parse(req.query))).filter((r) => n(r.cumulative_cost) !== 0 || n(r.pending_cost) !== 0);
  const cats = rows.length ? await query<any>(`SELECT sample_id, category, SUM(amount) v FROM trx_sample_cost WHERE company_id = ? AND sample_id IN (?) AND status IN ${COUNTED}
    GROUP BY sample_id, category`, [cid, rows.map((r) => r.id)]) : [];
  res.json({ data: rows.map((r) => {
    const by: Record<string, number> = {};
    for (const c of cats.filter((x) => Number(x.sample_id) === Number(r.id))) by[String(c.category).toLowerCase()] = r2(n(c.v));
    return { id: r.id, sample_no: r.sample_no, type_name: r.type_name ?? r.sample_type, buyer_name: r.buyer_name, style_code: r.style_code, status: r.status,
      qty: r.qty, good_qty: r.good_qty, elapsed_days: r.elapsed_days, ...by, today_cost: r.today_cost, cumulative_cost: r.cumulative_cost,
      cost_per_piece: r.cost_per_piece, cost_per_good_piece: r.cost_per_good_piece, avg_daily_cost_per_piece: r.avg_daily_cost_per_piece, pending_cost: r.pending_cost };
  }) });
}));

/** Buyer / style sample history (spec §13): revisions, submissions, approvals, rejections and cost. */
sampleReportsRouter.get('/sample-reports/history', VIEW, ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await loadRegister(cid, { ...filterQ.parse(req.query), include_closed: true });
  const ids = rows.map((r) => Number(r.id));
  const [subs, decs] = ids.length ? await Promise.all([
    query<any>(`SELECT sample_id, COUNT(*) c FROM trx_sample_submission WHERE sample_id IN (?) GROUP BY sample_id`, [ids]),
    query<any>(`SELECT sample_id, SUM(stage='BUYER' AND decision='APPROVED') ap, SUM(stage='BUYER' AND decision='REJECTED') rj, SUM(stage='BUYER' AND decision='CHANGES_REQUESTED') ch
                  FROM trx_sample_decision WHERE sample_id IN (?) GROUP BY sample_id`, [ids]),
  ]) : [[], []];
  const S = new Map(subs.map((x: any) => [Number(x.sample_id), n(x.c)]));
  const D = new Map(decs.map((x: any) => [Number(x.sample_id), x]));
  res.json({ data: rows.map((r) => ({ id: r.id, sample_no: r.sample_no, type_name: r.type_name ?? r.sample_type, buyer_name: r.buyer_name, style_code: r.style_code,
    status: r.status, revisions: n(r.revision_no), submissions: S.get(Number(r.id)) ?? 0, approved: n(D.get(Number(r.id))?.ap), rejected: n(D.get(Number(r.id))?.rj),
    changes_requested: n(D.get(Number(r.id))?.ch), cumulative_cost: r.cumulative_cost, request_date: r.request_date, completed_date: r.completed_date })) });
}));
