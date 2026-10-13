import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { r2, r4, type Kind } from './mpCalc.js';
import { n, has } from './mpShared.js';

/**
 * Embroidery / printing reports and dashboard (embroidery doc §29–§30, printing doc §27–§29).
 * Built from approved production and its frozen costing snapshot (status=all adds submitted entries),
 * so every figure reconciles with the transactions.
 */
const filterSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  machine_id: z.coerce.number().int().positive().optional(),
  job_id: z.coerce.number().int().positive().optional(),
  shift_id: z.coerce.number().int().positive().optional(),
  design_id: z.coerce.number().int().positive().optional(),
  style_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['approved', 'all']).default('approved'),
});
type F = z.infer<typeof filterSchema>;

const pct = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : null);
const COST_KEYS = new Set(['job-cost', 'cost-sheet', 'machine-cost', 'costing', 'standard-vs-actual']);

export function mountReports(router: Router, kind: Kind) {
  const P = (v: string) => `${kind}.${v}`;

  /** WHERE over production p (+ job j, latest costing c). */
  function where(cid: number, f: F) {
    const w = ['p.company_id = ?', 'p.process_kind = ?', f.status === 'all' ? `p.status IN ('SUBMITTED','APPROVED')` : `p.status = 'APPROVED'`];
    const params: unknown[] = [cid, kind];
    if (f.from) { w.push('p.prod_date >= ?'); params.push(f.from); }
    if (f.to) { w.push('p.prod_date <= ?'); params.push(f.to); }
    for (const k of ['machine_id', 'job_id', 'shift_id'] as const) if (f[k]) { w.push(`p.${k} = ?`); params.push(f[k]); }
    if (f.design_id) { w.push('j.design_id = ?'); params.push(f.design_id); }
    if (f.style_id) { w.push('j.style_id = ?'); params.push(f.style_id); }
    return { sql: w.join(' AND '), params };
  }
  const FROM = `FROM trx_mp_production p JOIN trx_mp_job j ON j.id = p.job_id JOIN mst_mp_machine m ON m.id = p.machine_id
    LEFT JOIN trx_mp_costing c ON c.id = (SELECT c2.id FROM trx_mp_costing c2 WHERE c2.production_id = p.id ORDER BY c2.is_final DESC, c2.id DESC LIMIT 1)`;
  const OUT = `COUNT(*) entries, SUM(p.input_qty) input, SUM(p.good_qty) good, SUM(p.reject_qty) reject, SUM(p.rework_qty) rework,
    SUM(c.net_run_hours) run_hours, SUM(c.standard_hours) std_hours, SUM(COALESCE(p.total_stitches,0)) stitches, SUM(p.downtime_minutes) downtime_min,
    SUM(c.material_cost) material, SUM(c.thread_cost) thread, SUM(c.consumable_cost) consumable, SUM(c.machine_cost) machine, SUM(c.labour_cost) labour,
    SUM(c.overhead_cost) overhead, SUM(c.other_cost) other, SUM(c.total_cost) total, SUM(c.std_total_cost) std_total,
    SUM(c.gross_minutes - p.break_minutes) attended_min`;
  const derive = (r: any) => {
    const run = n(r.run_hours);
    return {
      ...r,
      reject_pct: pct(n(r.reject), n(r.input)), rework_pct: pct(n(r.rework), n(r.input)),
      output_per_hour: run > 0 ? r4(n(r.good) / run) : null, stitches_per_hour: run > 0 && n(r.stitches) > 0 ? r4(n(r.stitches) / run) : null,
      efficiency_pct: run > 0 && n(r.std_hours) > 0 ? r2((n(r.std_hours) / run) * 100 * (n(r.input) > 0 ? n(r.good) / n(r.input) : 1)) : null,
      utilization_pct: n(r.attended_min) > 0 ? r2((run * 60 / n(r.attended_min)) * 100) : null,
      cost_per_good: n(r.good) > 0 && r.total != null ? r4(n(r.total) / n(r.good)) : null,
      cost_per_1000_stitches: n(r.stitches) > 0 && r.total != null ? r4(n(r.total) / n(r.stitches) * 1000) : null,
      variance: r.std_total != null ? r4(n(r.total) - n(r.std_total)) : null,
      variance_pct: n(r.std_total) > 0 ? r2(((n(r.total) - n(r.std_total)) / n(r.std_total)) * 100) : null,
    };
  };

  async function report(req: Request, key: string, f: F) {
    const cid = req.user!.companyId;
    const w = where(cid, f);
    switch (key) {
      case 'machine-output': {
        const rows = await query<any>(`SELECT m.id machine_id, m.machine_code, m.machine_name, m.head_count, AVG(p.heads_used) avg_heads, ${OUT} ${FROM}
          WHERE ${w.sql} GROUP BY m.id ORDER BY m.machine_code`, w.params);
        return rows.map(derive);
      }
      case 'daily-production': {
        const rows = await query<any>(`SELECT p.prod_date, sh.shift_code, m.machine_code, ${OUT} ${FROM} LEFT JOIN cfg_shift sh ON sh.id = p.shift_id
          WHERE ${w.sql} GROUP BY p.prod_date, sh.shift_code, m.machine_code ORDER BY p.prod_date DESC, sh.shift_code, m.machine_code`, w.params);
        return rows.map(derive);
      }
      case 'job-cost': case 'costing': {
        const rows = await query<any>(`SELECT j.id job_id, j.job_no, j.io_no, j.planned_qty, j.status job_status, st.style_code, pt.party_name buyer_name,
            d.design_code, ${OUT} ${FROM} LEFT JOIN mst_style st ON st.id = j.style_id LEFT JOIN mst_party pt ON pt.id = j.buyer_id LEFT JOIN mst_mp_design d ON d.id = j.design_id
          WHERE ${w.sql} GROUP BY j.id ORDER BY j.job_no`, w.params);
        return rows.map(derive);
      }
      case 'design-productivity': {
        const rows = await query<any>(`SELECT d.id design_id, d.design_code, d.version_no, d.total_stitches stitches_per_pc, d.std_minutes_per_pc, ${OUT} ${FROM}
            LEFT JOIN mst_mp_design d ON d.id = j.design_id WHERE ${w.sql} GROUP BY d.id ORDER BY d.design_code`, w.params);
        return rows.map(derive);
      }
      case 'machine-efficiency': {
        const rows = await query<any>(`SELECT m.id machine_id, m.machine_code, m.capacity_per_hour, m.capacity_stitches_hour, m.capacity_uom, ${OUT} ${FROM}
          WHERE ${w.sql} GROUP BY m.id ORDER BY m.machine_code`, w.params);
        return rows.map(derive);
      }
      case 'downtime': {
        return query<any>(`SELECT m.machine_code, r.reason_code, r.reason_name, COUNT(*) occurrences, SUM(dt.minutes) minutes
            FROM trx_mp_downtime dt JOIN trx_mp_production p ON p.id = dt.production_id JOIN trx_mp_job j ON j.id = p.job_id
            JOIN mst_mp_machine m ON m.id = p.machine_id JOIN mst_mp_reason r ON r.id = dt.reason_id
           WHERE ${w.sql} GROUP BY m.machine_code, r.reason_code, r.reason_name ORDER BY minutes DESC`, w.params);
      }
      case 'consumption': case 'variance': {
        const rows = await query<any>(`SELECT ${key === 'variance' ? 'j.job_no, j.io_no,' : ''} t.trim_code, t.trim_name, cn.material_role, u.code uom_code,
              SUM(cn.standard_qty) standard_qty, SUM(cn.actual_qty) actual_qty, SUM(cn.wastage_qty) wastage_qty,
              SUM(cn.standard_qty * cn.unit_cost) standard_cost, SUM(cn.total_cost) actual_cost, GROUP_CONCAT(DISTINCT cn.lot_nos) lots
            FROM trx_mp_consumption cn JOIN trx_mp_production p ON p.id = cn.production_id JOIN trx_mp_job j ON j.id = p.job_id
            JOIN mst_trim t ON t.id = cn.trim_id LEFT JOIN cfg_uom u ON u.id = cn.uom_id
           WHERE ${w.sql} GROUP BY ${key === 'variance' ? 'j.id, ' : ''}t.id, cn.material_role, u.code ORDER BY ${key === 'variance' ? 'j.job_no, ' : ''}t.trim_code`, w.params);
        return rows.map((r) => ({ ...r, variance_qty: r4(n(r.actual_qty) - n(r.standard_qty)),
          variance_pct: n(r.standard_qty) > 0 ? r2(((n(r.actual_qty) - n(r.standard_qty)) / n(r.standard_qty)) * 100) : null,
          variance_cost: r4(n(r.actual_cost) - n(r.standard_cost)) }));
      }
      case 'reject-rework': {
        const rows = await query<any>(`SELECT o.output_type, r.reason_code, r.reason_name, SUM(o.qty) qty, COUNT(DISTINCT p.id) entries,
              SUM(o.qty * COALESCE(c.cost_per_unit, 0)) cost_impact
            FROM trx_mp_production_output o JOIN trx_mp_production p ON p.id = o.production_id JOIN trx_mp_job j ON j.id = p.job_id
            JOIN mst_mp_reason r ON r.id = o.reason_id
            LEFT JOIN trx_mp_costing c ON c.id = (SELECT c2.id FROM trx_mp_costing c2 WHERE c2.production_id = p.id ORDER BY c2.is_final DESC, c2.id DESC LIMIT 1)
           WHERE ${w.sql} GROUP BY o.output_type, r.reason_code, r.reason_name ORDER BY qty DESC`, w.params);
        const tot = await queryOne<any>(`SELECT SUM(p.input_qty) input ${FROM} WHERE ${w.sql}`, w.params);
        return rows.map((r) => ({ ...r, pct_of_input: pct(n(r.qty), n(tot?.input)), cost_impact: r4(n(r.cost_impact)) }));
      }
      case 'cost-sheet': {
        return query<any>(`SELECT p.id, p.production_no, p.prod_date, p.status, j.job_no, m.machine_code, p.input_qty, p.good_qty, p.reject_qty, p.rework_qty,
              p.total_stitches, c.net_run_hours, c.costing_hours, c.thread_cost, c.consumable_cost, c.material_cost, c.machine_cost, c.labour_cost,
              c.overhead_cost, c.other_cost, c.total_cost, c.std_total_cost, c.cost_per_unit, c.cost_per_kg, c.cost_per_1000_stitches, c.is_final
            ${FROM} WHERE ${w.sql} ORDER BY p.prod_date DESC, p.id DESC LIMIT 2000`, w.params);
      }
      case 'operator': {
        const rows = await query<any>(`SELECT COALESCE(p.operator_name, '—') operator_name, ${OUT} ${FROM}
          WHERE ${w.sql} GROUP BY COALESCE(p.operator_name, '—') ORDER BY good DESC`, w.params);
        return rows.map(derive).map((r) => ({ ...r, attended_hours: r4(n(r.attended_min) / 60) }));
      }
      case 'pending-jobs': {
        const rows = await query<any>(`SELECT j.id, j.job_no, j.job_date, j.status, j.io_no, j.planned_qty, j.uom, j.planned_end, st.style_code, d.design_code, mc.machine_code,
              COALESCE(SUM(CASE WHEN p.status = 'APPROVED' THEN p.input_qty END),0) input_done,
              COALESCE(SUM(CASE WHEN p.status = 'APPROVED' THEN p.good_qty END),0) good_done,
              COALESCE(SUM(CASE WHEN p.status IN ('DRAFT','SUBMITTED') THEN 1 ELSE 0 END),0) open_entries
            FROM trx_mp_job j LEFT JOIN trx_mp_production p ON p.job_id = j.id LEFT JOIN mst_style st ON st.id = j.style_id
            LEFT JOIN mst_mp_design d ON d.id = j.design_id LEFT JOIN mst_mp_machine mc ON mc.id = j.machine_id
           WHERE j.company_id = ? AND j.process_kind = ? AND j.status IN ('DRAFT','PLANNED','RUNNING')
           GROUP BY j.id ORDER BY COALESCE(j.planned_end, j.job_date)`, [cid, kind]);
        const today = new Date().toISOString().slice(0, 10);
        return rows.map((r) => ({ ...r, balance: r4(Math.max(n(r.planned_qty) - n(r.input_done), 0)), done_pct: pct(n(r.input_done), n(r.planned_qty)),
          overdue: !!r.planned_end && String(r.planned_end) < today }));
      }
      case 'machine-cost': {
        const rows = await query<any>(`SELECT m.machine_code, m.machine_name, DATE_FORMAT(p.prod_date, '%Y-%m') period, ${OUT} ${FROM}
          WHERE ${w.sql} GROUP BY m.machine_code, m.machine_name, period ORDER BY period DESC, m.machine_code`, w.params);
        return rows.map(derive);
      }
      case 'standard-vs-actual': {
        const r = await queryOne<any>(`SELECT SUM(c.material_cost) material, SUM(c.std_material_cost) std_material, SUM(c.thread_cost) thread, SUM(c.consumable_cost) consumable,
              SUM(c.machine_cost) machine, SUM(c.std_machine_cost) std_machine, SUM(c.labour_cost) labour, SUM(c.std_labour_cost) std_labour,
              SUM(c.overhead_cost) overhead, SUM(c.std_overhead_cost) std_overhead, SUM(c.other_cost) other, SUM(c.total_cost) total, SUM(c.std_total_cost) std_total
            ${FROM} WHERE ${w.sql}`, w.params);
        const heads: [string, string, string | null][] = [['Material', 'material', 'std_material'], ['Machine', 'machine', 'std_machine'], ['Labour', 'labour', 'std_labour'],
          ['Overhead', 'overhead', 'std_overhead'], ['Other', 'other', null], ['Total', 'total', 'std_total']];
        return heads.map(([head, a, s]) => {
          const actual = r4(n(r?.[a])); const standard = s ? r4(n(r?.[s])) : 0;
          return { head, standard, actual, variance: r4(actual - standard), variance_pct: standard > 0 ? r2(((actual - standard) / standard) * 100) : null };
        });
      }
      default: throw BadRequest(`Unknown report "${key}"`);
    }
  }

  router.get('/reports/:key', requirePermission(P('VIEW')), ah(async (req, res) => {
    const key = String(req.params.key);
    if (COST_KEYS.has(key) && !has(req, P('COSTING'), P('APPROVE'), P('SUBMIT'), P('MASTER'))) {
      throw BadRequest('This report shows cost — it needs the costing permission');
    }
    const f = filterSchema.parse(req.query);
    let rows = await report(req, key, f);
    if (!has(req, P('COSTING'), P('APPROVE'), P('SUBMIT'), P('MASTER'))) {
      rows = rows.map((r: any) => { const o = { ...r }; for (const k of ['material', 'thread', 'consumable', 'machine', 'labour', 'overhead', 'other', 'total', 'std_total', 'cost_per_good', 'cost_per_1000_stitches', 'variance', 'variance_pct', 'standard_cost', 'actual_cost', 'variance_cost', 'cost_impact']) delete o[k]; return o; });
    }
    res.json({ data: rows, meta: { key, filters: f } });
  }));

  /** GET /dashboard?from&to — output, efficiency, downtime and cost KPIs. */
  router.get('/dashboard', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const f = filterSchema.parse(req.query);
    const w = where(cid, f);
    const t = derive(await queryOne<any>(`SELECT ${OUT}, SUM(p.heads_used * c.net_run_hours) head_hours, COUNT(DISTINCT p.job_id) jobs_run ${FROM} WHERE ${w.sql}`, w.params) ?? {});
    const jobsWhere = ['company_id = ?', 'process_kind = ?'];
    const jp: unknown[] = [cid, kind];
    if (f.from) { jobsWhere.push('job_date >= ?'); jp.push(f.from); }
    if (f.to) { jobsWhere.push('job_date <= ?'); jp.push(f.to); }
    const jobs = await queryOne<any>(`SELECT COUNT(*) jobs, SUM(planned_qty) planned, SUM(status IN ('DRAFT','PLANNED','RUNNING')) open_jobs FROM trx_mp_job WHERE ${jobsWhere.join(' AND ')} AND status <> 'CANCELLED'`, jp);
    const pending = await queryOne<any>(`SELECT SUM(status = 'DRAFT') drafts, SUM(status = 'SUBMITTED') submitted FROM trx_mp_production WHERE company_id = ? AND process_kind = ?`, [cid, kind]);
    const topDowntime = (await report(req, 'downtime', f) as any[]).reduce((acc: any[], r: any) => {
      const x = acc.find((a) => a.reason_code === r.reason_code);
      if (x) { x.minutes += n(r.minutes); x.occurrences += n(r.occurrences); } else acc.push({ reason_code: r.reason_code, reason_name: r.reason_name, minutes: n(r.minutes), occurrences: n(r.occurrences) });
      return acc;
    }, []).sort((a: any, b: any) => b.minutes - a.minutes).slice(0, 5);
    const showCost = has(req, P('COSTING'), P('APPROVE'), P('SUBMIT'), P('MASTER'));
    const highVariance = showCost ? (await report(req, 'job-cost', f) as any[]).filter((r) => r.variance_pct != null && Math.abs(r.variance_pct) >= 5)
      .sort((a, b) => Math.abs(b.variance_pct) - Math.abs(a.variance_pct)).slice(0, 10) : [];
    const daily = await query<any>(`SELECT p.prod_date, SUM(p.good_qty) good, SUM(p.reject_qty) reject, SUM(c.net_run_hours) run_hours ${showCost ? ', SUM(c.total_cost) total' : ''}
      ${FROM} WHERE ${w.sql} GROUP BY p.prod_date ORDER BY p.prod_date DESC LIMIT 31`, w.params);
    const kpi: any = {
      total_jobs: n(jobs?.jobs), open_jobs: n(jobs?.open_jobs), jobs_run: n(t.jobs_run), planned_qty: n(jobs?.planned),
      entries: n(t.entries), input_qty: n(t.input), good_output: n(t.good), reject_qty: n(t.reject), reject_pct: t.reject_pct,
      rework_qty: n(t.rework), rework_pct: t.rework_pct, machine_hours: r4(n(t.run_hours)), head_hours: r4(n(t.head_hours)),
      stitches: n(t.stitches), stitches_per_hour: t.stitches_per_hour, output_per_hour: t.output_per_hour,
      utilization_pct: t.utilization_pct, efficiency_pct: t.efficiency_pct, downtime_minutes: n(t.downtime_min),
      pending_drafts: n(pending?.drafts), pending_approval: n(pending?.submitted),
    };
    if (showCost) Object.assign(kpi, {
      thread_cost: r4(n(t.thread)), consumable_cost: r4(n(t.consumable)), material_cost: r4(n(t.material)), machine_cost: r4(n(t.machine)),
      labour_cost: r4(n(t.labour)), overhead_cost: r4(n(t.overhead)), other_cost: r4(n(t.other)), total_cost: r4(n(t.total)),
      cost_per_good: t.cost_per_good, cost_per_1000_stitches: t.cost_per_1000_stitches, std_total_cost: r4(n(t.std_total)), variance_pct: t.variance_pct,
    });
    res.json({ data: { kpi, top_downtime: topDowntime, high_variance_jobs: highVariance, daily: daily.reverse() } });
  }));
}
