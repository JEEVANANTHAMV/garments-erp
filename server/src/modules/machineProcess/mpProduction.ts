import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { BadRequest, NotFound, Forbidden } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { settingFlag } from '../../core/inwardControls.js';
import { s } from '../resources/schemas.js';
import {
  calculateProductionCost, calculateActualConsumption, calculateStandardConsumption, calculateVariance, validateOutputBalance,
  r4, r6, type Kind, type RecipeLine,
} from './mpCalc.js';
import {
  n, LABEL, DOC, has, settingNum, sqlDateTime, dt, machineOf, rateOn, jobUnitCost, lotUnitCost, dcStageIds,
} from './mpShared.js';

/**
 * Jobs, material issue / return and machine production of the embroidery / printing engine
 * (embroidery doc §7–§19, §28; printing doc §5–§17, §26). Workflow: Draft → Submitted → Approved / Rejected
 * → Cancelled. Costing is recalculated on the server on every save; approval freezes the snapshot.
 */
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const dateTimeStr = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, 'Use YYYY-MM-DDTHH:mm');
const reasonReq = z.string().trim().min(3, 'Give a reason (min 3 characters)').max(255);
const qtyNum = () => z.coerce.number().min(0, 'Cannot be negative').max(1e9).default(0);
const EPS = 0.00001;
const ACTIVE_PROD = `('SUBMITTED','APPROVED')`;

export function mountProduction(router: Router, kind: Kind) {
  const P = (v: string) => `${kind}.${v}`;
  const L = LABEL[kind];
  const canSeeCost = (req: Request) => has(req, P('COSTING'), P('APPROVE'), P('SUBMIT'), P('MASTER'));

  // ===================================================================== JOBS
  const jobSchema = z.object({
    job_date: dateStr,
    so_id: s.id(), io_no: s.nullableStr(40), style_id: s.id(), color_id: s.id(),
    design_id: s.id(), recipe_id: s.id(), machine_id: s.id(), challan_id: s.id(),
    placement: s.nullableStr(60), print_type: s.nullableStr(40),
    input_type: z.enum(['CUT_PANEL', 'GARMENT', 'FABRIC', 'OTHER']).default('CUT_PANEL'),
    planned_qty: z.coerce.number().positive('Planned qty must be more than 0').max(1e9),
    uom: z.enum(['PCS', 'KG', 'MTR']).default('PCS'),
    planned_start: s.date(), planned_end: s.date(),
    remarks: s.nullableStr(500),
  }).refine((j) => !j.planned_start || !j.planned_end || j.planned_end >= j.planned_start, { message: 'Planned end is before planned start', path: ['planned_end'] });

  /** Resolve and check everything a job points to (approved design / recipe of this process, machine, DC, job). */
  async function checkJob(cid: number, b: z.infer<typeof jobSchema>, current?: any) {
    const out: any = { ...b, buyer_id: null, stitches_per_pc: null };
    if (b.design_id) {
      const d = await queryOne<any>(`SELECT * FROM mst_mp_design WHERE id = ? AND company_id = ? AND process_kind = ?`, [b.design_id, cid, kind]);
      if (!d) throw BadRequest(`${L} design not found`);
      if (d.status !== 'APPROVED' && Number(current?.design_id) !== d.id) throw BadRequest(`Design ${d.design_code} v${d.version_no} is ${d.status} — only an approved design can be used on a job`);
      out.stitches_per_pc = d.total_stitches ?? null;
      out.placement = b.placement ?? d.placement ?? null;
      out.print_type = b.print_type ?? d.print_type ?? null;
    }
    if (b.recipe_id) {
      const r = await queryOne<any>(`SELECT * FROM mst_mp_recipe WHERE id = ? AND company_id = ? AND process_kind = ?`, [b.recipe_id, cid, kind]);
      if (!r) throw BadRequest(`${L} recipe not found`);
      if (r.status !== 'APPROVED' && Number(current?.recipe_id) !== r.id) throw BadRequest(`Recipe ${r.recipe_no} v${r.version_no} is ${r.status} — only an approved recipe can be used on a job`);
      if (r.design_id && b.design_id && Number(r.design_id) !== Number(b.design_id)) throw BadRequest(`Recipe ${r.recipe_no} is made for another design`);
    }
    if (b.machine_id) {
      const m = await machineOf(cid, kind, b.machine_id);
      if (!m.is_active && Number(current?.machine_id) !== m.id) throw BadRequest(`Machine ${m.machine_code} is inactive`);
    }
    if (b.challan_id) {
      const stages = await dcStageIds(cid, kind);
      const dc = await queryOne<any>(`SELECT id, stage_id, io_no, style_id, challan_no, status FROM trx_jobwork_challan WHERE id = ? AND company_id = ?`, [b.challan_id, cid]);
      if (!dc) throw BadRequest('Process DC not found');
      if (!stages.includes(Number(dc.stage_id))) throw BadRequest(`DC ${dc.challan_no} is not a ${L} DC`);
      if (dc.status === 'CANCELLED') throw BadRequest(`DC ${dc.challan_no} is cancelled`);
      out.io_no = b.io_no ?? dc.io_no ?? null;
      out.style_id = b.style_id ?? dc.style_id ?? null;
    }
    if (b.so_id) {
      const so = await queryOne<any>(`SELECT id, io_no, so_no, buyer_id FROM trx_sales_order WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.so_id, cid]);
      if (!so) throw BadRequest('Sales order (job) not found');
      out.io_no = out.io_no ?? so.io_no ?? so.so_no;
      out.buyer_id = so.buyer_id ?? null;
    } else if (out.io_no) {
      const so = await queryOne<any>(`SELECT id, buyer_id FROM trx_sales_order WHERE company_id = ? AND (io_no = ? OR so_no = ?) AND is_deleted = 0 ORDER BY id DESC LIMIT 1`, [cid, out.io_no, out.io_no]);
      if (so) { out.so_id = so.id; out.buyer_id = so.buyer_id ?? null; }
    }
    if (out.style_id) {
      const st = await queryOne(`SELECT id FROM mst_style WHERE id = ? AND company_id = ?`, [out.style_id, cid]);
      if (!st) throw BadRequest('Style not found');
    }
    return out;
  }

  async function jobRow(cid: number, id: number) {
    const j = await queryOne<any>(
      `SELECT j.*, st.style_code, st.style_name, col.color_name, p.party_name AS buyer_name, so.so_no, so.buyer_po_no,
              d.design_code, d.version_no AS design_version, d.design_name, d.total_stitches, d.std_minutes_per_pc, d.file_url AS design_file_url, d.no_of_colors,
              r.recipe_no, r.version_no AS recipe_version, r.recipe_name, r.base_qty, r.base_uom,
              m.machine_code, m.machine_name, jc.challan_no, jc.status AS dc_status, jc.challan_date AS dc_date, v.party_name AS dc_vendor,
              uc.full_name AS created_by_name
         FROM trx_mp_job j
         LEFT JOIN mst_style st ON st.id = j.style_id LEFT JOIN mst_color col ON col.id = j.color_id
         LEFT JOIN mst_party p ON p.id = j.buyer_id LEFT JOIN trx_sales_order so ON so.id = j.so_id
         LEFT JOIN mst_mp_design d ON d.id = j.design_id LEFT JOIN mst_mp_recipe r ON r.id = j.recipe_id
         LEFT JOIN mst_mp_machine m ON m.id = j.machine_id
         LEFT JOIN trx_jobwork_challan jc ON jc.id = j.challan_id LEFT JOIN mst_party v ON v.id = jc.vendor_id
         LEFT JOIN mst_user uc ON uc.id = j.created_by
        WHERE j.id = ? AND j.company_id = ? AND j.process_kind = ?`, [id, cid, kind]);
    if (!j) throw NotFound(`${L} job not found`);
    return j;
  }

  async function recipeLines(recipeId: number | null, tx?: Tx): Promise<(RecipeLine & { trim_code: string; trim_name: string; uom_code: string; stock_uom_id: number; stock_uom_code: string; id: number })[]> {
    if (!recipeId) return [];
    const sql = `SELECT i.*, t.trim_code, t.trim_name, u.code AS uom_code, t.base_uom AS stock_uom_id, bu.code AS stock_uom_code
                   FROM mst_mp_recipe_item i JOIN mst_trim t ON t.id = i.trim_id LEFT JOIN cfg_uom u ON u.id = i.uom_id LEFT JOIN cfg_uom bu ON bu.id = t.base_uom
                  WHERE i.recipe_id = ? ORDER BY i.seq_no, i.id`;
    const rows = tx ? await txQuery<any>(tx, sql, [recipeId]) : await query<any>(sql, [recipeId]);
    return rows.map((r) => ({ ...r, std_qty: n(r.std_qty), loss_pct: n(r.loss_pct), per_stock_unit: n(r.per_stock_unit) || 1 }));
  }

  /** Material balance of a job per material, in stock units: issued, returned, consumed by submitted / approved production. */
  async function materialBalance(jobId: number, tx?: Tx) {
    const q1 = `SELECT t.trim_id, tr.trim_code, tr.trim_name, u.code AS uom_code,
                       SUM(CASE WHEN t.txn_type='ISSUE' THEN t.qty ELSE 0 END) issued, SUM(CASE WHEN t.txn_type='RETURN' THEN t.qty ELSE 0 END) returned,
                       SUM(CASE WHEN t.txn_type='ISSUE' THEN t.amount ELSE -t.amount END) amount
                  FROM trx_mp_material_txn t JOIN mst_trim tr ON tr.id = t.trim_id LEFT JOIN cfg_uom u ON u.id = tr.base_uom
                 WHERE t.job_id = ? AND t.status = 'POSTED' GROUP BY t.trim_id, tr.trim_code, tr.trim_name, u.code`;
    const q2 = `SELECT c.trim_id, SUM(c.actual_qty / NULLIF(c.per_stock_unit,0)) consumed, SUM(c.total_cost) cost
                  FROM trx_mp_consumption c JOIN trx_mp_production p ON p.id = c.production_id
                 WHERE p.job_id = ? AND p.status IN ${ACTIVE_PROD} GROUP BY c.trim_id`;
    const iss = tx ? await txQuery<any>(tx, q1, [jobId]) : await query<any>(q1, [jobId]);
    const con = tx ? await txQuery<any>(tx, q2, [jobId]) : await query<any>(q2, [jobId]);
    const map = new Map<number, any>();
    for (const r of iss) map.set(Number(r.trim_id), { trim_id: Number(r.trim_id), trim_code: r.trim_code, trim_name: r.trim_name, uom_code: r.uom_code, issued: n(r.issued), returned: n(r.returned), amount: n(r.amount), consumed: 0, consumed_cost: 0 });
    for (const r of con) {
      const k = Number(r.trim_id);
      if (!map.has(k)) {
        const t = await queryOne<any>(`SELECT tr.trim_code, tr.trim_name, u.code AS uom_code FROM mst_trim tr LEFT JOIN cfg_uom u ON u.id = tr.base_uom WHERE tr.id = ?`, [k]);
        map.set(k, { trim_id: k, trim_code: t?.trim_code, trim_name: t?.trim_name, uom_code: t?.uom_code, issued: 0, returned: 0, amount: 0, consumed: 0, consumed_cost: 0 });
      }
      map.get(k).consumed = r6(n(r.consumed)); map.get(k).consumed_cost = r4(n(r.cost));
    }
    return [...map.values()].map((m) => ({ ...m, net_issued: r6(m.issued - m.returned), balance: r6(m.issued - m.returned - m.consumed) }));
  }

  router.get('/jobs', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const where = ['j.company_id = ?', 'j.process_kind = ?'];
    const params: unknown[] = [cid, kind];
    const qp = req.query as Record<string, string>;
    if (qp.status === 'OPEN') where.push(`j.status IN ('DRAFT','PLANNED','RUNNING')`);
    else if (qp.status) { where.push('j.status = ?'); params.push(qp.status); }
    if (qp.from) { where.push('j.job_date >= ?'); params.push(qp.from); }
    if (qp.to) { where.push('j.job_date <= ?'); params.push(qp.to); }
    for (const k of ['buyer_id', 'style_id', 'design_id', 'machine_id', 'so_id']) if (qp[k]) { where.push(`j.${k} = ?`); params.push(Number(qp[k])); }
    if (qp.q) { where.push('(j.job_no LIKE ? OR j.io_no LIKE ? OR st.style_code LIKE ?)'); params.push(`%${qp.q}%`, `%${qp.q}%`, `%${qp.q}%`); }
    const rows = await query<any>(
      `SELECT j.id, j.job_no, j.job_date, j.status, j.io_no, j.planned_qty, j.uom, j.placement, j.input_type, j.planned_start, j.planned_end,
              st.style_code, col.color_name, p.party_name AS buyer_name, d.design_code, d.version_no AS design_version,
              r.recipe_no, r.version_no AS recipe_version, m.machine_code, jc.challan_no,
              COALESCE(SUM(CASE WHEN pr.status = 'APPROVED' THEN pr.input_qty END),0) AS input_done,
              COALESCE(SUM(CASE WHEN pr.status = 'APPROVED' THEN pr.good_qty END),0) AS good_done,
              COALESCE(SUM(CASE WHEN pr.status = 'APPROVED' THEN pr.reject_qty END),0) AS reject_done,
              COALESCE(SUM(CASE WHEN pr.status IN ('DRAFT','SUBMITTED') THEN 1 ELSE 0 END),0) AS open_entries
         FROM trx_mp_job j
         LEFT JOIN mst_style st ON st.id = j.style_id LEFT JOIN mst_color col ON col.id = j.color_id
         LEFT JOIN mst_party p ON p.id = j.buyer_id LEFT JOIN mst_mp_design d ON d.id = j.design_id
         LEFT JOIN mst_mp_recipe r ON r.id = j.recipe_id LEFT JOIN mst_mp_machine m ON m.id = j.machine_id
         LEFT JOIN trx_jobwork_challan jc ON jc.id = j.challan_id
         LEFT JOIN trx_mp_production pr ON pr.job_id = j.id
        WHERE ${where.join(' AND ')}
        GROUP BY j.id ORDER BY j.job_date DESC, j.id DESC LIMIT 1000`, params);
    res.json({ data: rows });
  }));

  router.get('/jobs/:id', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const j = await jobRow(cid, id);
    const lines = await recipeLines(j.recipe_id);
    const requirement = calculateStandardConsumption(lines, n(j.planned_qty), n(j.base_qty) || 1, j.stitches_per_pc ? n(j.stitches_per_pc) : null)
      .map((l: any) => ({ ...l, stock_qty: r6(l.standard_qty / (n(l.per_stock_unit) || 1)) }));
    const productions = await query<any>(
      `SELECT p.id, p.production_no, p.prod_date, p.status, p.input_qty, p.good_qty, p.reject_qty, p.rework_qty, p.total_stitches, p.rework_of_id,
              m.machine_code, sh.shift_code, ${dt('p.start_at', 'start_at')}, ${dt('p.end_at', 'end_at')},
              c.total_cost, c.cost_per_unit, c.net_run_hours
         FROM trx_mp_production p JOIN mst_mp_machine m ON m.id = p.machine_id LEFT JOIN cfg_shift sh ON sh.id = p.shift_id
         LEFT JOIN trx_mp_costing c ON c.id = (SELECT c2.id FROM trx_mp_costing c2 WHERE c2.production_id = p.id ORDER BY c2.is_final DESC, c2.id DESC LIMIT 1)
        WHERE p.job_id = ? ORDER BY p.prod_date, p.start_at, p.id`, [id]);
    const approved = productions.filter((p) => p.status === 'APPROVED');
    const sum = (k: string, rows = approved) => r4(rows.reduce((a, p) => a + n(p[k]), 0));
    const output = {
      input: sum('input_qty'), good: sum('good_qty'), reject: sum('reject_qty'), rework: sum('rework_qty'),
      pending_entries: productions.filter((p) => ['DRAFT', 'SUBMITTED'].includes(p.status)).length,
      balance_to_produce: r4(Math.max(n(j.planned_qty) - sum('input_qty'), 0)),
    };
    let cost: any = null;
    if (canSeeCost(req)) {
      const c = await queryOne<any>(
        `SELECT COALESCE(SUM(c.material_cost),0) material, COALESCE(SUM(c.machine_cost),0) machine, COALESCE(SUM(c.labour_cost),0) labour,
                COALESCE(SUM(c.overhead_cost),0) overhead, COALESCE(SUM(c.other_cost),0) other, COALESCE(SUM(c.total_cost),0) total,
                COALESCE(SUM(c.std_total_cost),0) std_total, COALESCE(SUM(c.good_qty),0) good, COALESCE(SUM(c.total_stitches),0) stitches
           FROM trx_mp_costing c JOIN trx_mp_production p ON p.id = c.production_id
          WHERE p.job_id = ? AND p.status = 'APPROVED' AND c.is_final = 1`, [id]);
      cost = c ? { ...c, cost_per_good: n(c.good) > 0 ? r4(n(c.total) / n(c.good)) : null,
        cost_per_1000_stitches: n(c.stitches) > 0 ? r4(n(c.total) / n(c.stitches) * 1000) : null,
        variance: calculateVariance(n(c.total), n(c.std_total)) } : null;
    }
    let dc: any = null;
    if (j.challan_id) {
      dc = await queryOne<any>(
        `SELECT jc.id, jc.challan_no, jc.challan_date, jc.status, v.party_name AS vendor_name, COALESCE(SUM(l.qty),0) issued, COALESCE(SUM(l.received_qty),0) received,
                COALESCE(SUM(l.rejected_qty),0) rejected, COALESCE(SUM(l.rework_open_qty),0) rework_open
           FROM trx_jobwork_challan jc LEFT JOIN trx_jobwork_challan_line l ON l.challan_id = jc.id LEFT JOIN mst_party v ON v.id = jc.vendor_id
          WHERE jc.id = ? GROUP BY jc.id`, [j.challan_id]);
    }
    res.json({ data: { ...j, requirement, materials: await materialBalance(id), productions: productions.map((p) => canSeeCost(req) ? p : { ...p, total_cost: undefined, cost_per_unit: undefined }), output, cost, dc } });
  }));

  router.post('/jobs', requirePermission(P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = jobSchema.parse(req.body);
    const v = await checkJob(cid, b);
    const id = await transaction(async (tx) => {
      const no = await nextDocNumber(tx, cid, DOC[kind].job);
      const r = await txExecute(tx,
        `INSERT INTO trx_mp_job (company_id, process_kind, job_no, job_date, so_id, io_no, buyer_id, style_id, color_id, design_id, recipe_id, machine_id,
           challan_id, placement, print_type, input_type, planned_qty, uom, stitches_per_pc, planned_start, planned_end, status, remarks, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,
        [cid, kind, no, v.job_date, v.so_id ?? null, v.io_no ?? null, v.buyer_id, v.style_id ?? null, v.color_id ?? null, v.design_id ?? null,
         v.recipe_id ?? null, v.machine_id ?? null, v.challan_id ?? null, v.placement ?? null, v.print_type ?? null, v.input_type, v.planned_qty, v.uom,
         v.stitches_per_pc, v.planned_start ?? null, v.planned_end ?? null, v.remarks ?? null, req.user!.id]);
      await audit(req, 'trx_mp_job', r.insertId, 'INSERT', undefined, { job_no: no, ...b }, tx);
      return r.insertId;
    });
    res.status(201).json({ data: await jobRow(cid, id) });
  }));

  router.put('/jobs/:id', requirePermission(P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const b = jobSchema.parse(req.body);
    await transaction(async (tx) => {
      const before = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_job WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!before) throw NotFound(`${L} job not found`);
      if (!['DRAFT', 'PLANNED', 'RUNNING'].includes(before.status)) throw BadRequest(`Job ${before.job_no} is ${before.status} — it cannot be edited`);
      const used = await txQueryOne<any>(tx, `SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN status IN ${ACTIVE_PROD} THEN input_qty END),0) q FROM trx_mp_production WHERE job_id = ? AND status <> 'CANCELLED'`, [id]);
      const issued = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_mp_material_txn WHERE job_id = ? AND status = 'POSTED'`, [id]);
      // The design / recipe version a job ran on is immutable (doc §28).
      if (n(used?.c) || n(issued?.c)) {
        for (const k of ['design_id', 'recipe_id', 'uom'] as const) {
          if (String(before[k] ?? '') !== String((b as any)[k] ?? '')) throw BadRequest(`Job ${before.job_no} already has production / material — its ${k.replace('_id', '')} cannot change`);
        }
      }
      if (b.planned_qty + EPS < n(used?.q)) throw BadRequest(`Planned qty cannot go below the ${n(used?.q)} already produced`);
      const v = await checkJob(cid, b, before);
      await txExecute(tx,
        `UPDATE trx_mp_job SET job_date = ?, so_id = ?, io_no = ?, buyer_id = ?, style_id = ?, color_id = ?, design_id = ?, recipe_id = ?, machine_id = ?,
           challan_id = ?, placement = ?, print_type = ?, input_type = ?, planned_qty = ?, uom = ?, stitches_per_pc = ?, planned_start = ?, planned_end = ?,
           remarks = ?, updated_by = ? WHERE id = ?`,
        [v.job_date, v.so_id ?? null, v.io_no ?? null, v.buyer_id, v.style_id ?? null, v.color_id ?? null, v.design_id ?? null, v.recipe_id ?? null,
         v.machine_id ?? null, v.challan_id ?? null, v.placement ?? null, v.print_type ?? null, v.input_type, v.planned_qty, v.uom,
         n(used?.c) ? before.stitches_per_pc : v.stitches_per_pc, v.planned_start ?? null, v.planned_end ?? null, v.remarks ?? null, req.user!.id, id]);
      await audit(req, 'trx_mp_job', id, 'UPDATE', before, b, tx);
    });
    res.json({ data: await jobRow(cid, id) });
  }));

  /** POST /jobs/:id/plan — release a draft job to the floor (approved recipe, and design for embroidery). */
  router.post('/jobs/:id/plan', requirePermission(P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    await transaction(async (tx) => {
      const j = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_job WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!j) throw NotFound(`${L} job not found`);
      if (j.status !== 'DRAFT') throw BadRequest(`Job ${j.job_no} is already ${j.status}`);
      if (kind === 'EMBROIDERY' && !j.design_id) throw BadRequest('Choose the approved embroidery design before planning the job');
      if (!j.recipe_id) throw BadRequest(`Choose the approved ${kind === 'EMBROIDERY' ? 'thread / consumable' : 'dyes & chemicals'} recipe before planning the job`);
      await txExecute(tx, `UPDATE trx_mp_job SET status = 'PLANNED', updated_by = ? WHERE id = ?`, [req.user!.id, id]);
      await audit(req, 'trx_mp_job', id, 'UPDATE', { status: 'DRAFT' }, { status: 'PLANNED' }, tx);
    });
    res.json({ data: await jobRow(cid, id) });
  }));

  router.post('/jobs/:id/complete', requirePermission(P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const b = z.object({ remarks: s.nullableStr(255), material_balance_reason: s.nullableStr(255) }).parse(req.body ?? {});
    await transaction(async (tx) => {
      const j = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_job WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!j) throw NotFound(`${L} job not found`);
      if (!['PLANNED', 'RUNNING'].includes(j.status)) throw BadRequest(`Job ${j.job_no} is ${j.status} — it cannot be completed`);
      const open = await txQueryOne<any>(tx, `SELECT GROUP_CONCAT(production_no) nos FROM trx_mp_production WHERE job_id = ? AND status IN ('DRAFT','SUBMITTED')`, [id]);
      if (open?.nos) throw BadRequest(`Approve, reject or cancel the open production entries first: ${open.nos}`);
      const approved = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_mp_production WHERE job_id = ? AND status = 'APPROVED'`, [id]);
      if (!n(approved?.c)) throw BadRequest('The job has no approved production — cancel it instead');
      const left = (await materialBalance(id, tx)).filter((m) => m.balance > 0.0001);
      if (left.length && !b.material_balance_reason?.trim()) {
        throw BadRequest(`Unused material is still with the machine: ${left.map((m) => `${m.trim_code} ${r4(m.balance)} ${m.uom_code ?? ''}`).join(', ')} — return it to store or give the reason`);
      }
      await txExecute(tx, `UPDATE trx_mp_job SET status = 'COMPLETED', completed_by = ?, completed_at = NOW(), updated_by = ? WHERE id = ?`, [req.user!.id, req.user!.id, id]);
      await audit(req, 'trx_mp_job', id, 'UPDATE', { status: j.status }, { status: 'COMPLETED', remarks: b.remarks, material_left: left, material_balance_reason: b.material_balance_reason }, tx);
    });
    res.json({ data: await jobRow(cid, id) });
  }));

  router.post('/jobs/:id/cancel', requirePermission(P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const { reason } = z.object({ reason: reasonReq }).parse(req.body ?? {});
    await transaction(async (tx) => {
      const j = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_job WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!j) throw NotFound(`${L} job not found`);
      if (['COMPLETED', 'CANCELLED'].includes(j.status)) throw BadRequest(`Job ${j.job_no} is ${j.status}`);
      const live = await txQueryOne<any>(tx, `SELECT GROUP_CONCAT(production_no) nos FROM trx_mp_production WHERE job_id = ? AND status IN ${ACTIVE_PROD}`, [id]);
      if (live?.nos) throw BadRequest(`Submitted / approved production exists (${live.nos}) — cancel those first`);
      const left = (await materialBalance(id, tx)).filter((m) => m.net_issued > 0.0001);
      if (left.length) throw BadRequest(`Return the issued material to store first: ${left.map((m) => `${m.trim_code} ${r4(m.net_issued)} ${m.uom_code ?? ''}`).join(', ')}`);
      const drafts = await txQuery<any>(tx, `SELECT id FROM trx_mp_production WHERE job_id = ? AND status IN ('DRAFT','REJECTED')`, [id]);
      for (const d of drafts) {
        await txExecute(tx, `UPDATE trx_mp_production SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?`, [req.user!.id, `Job cancelled: ${reason}`.slice(0, 255), d.id]);
        await txExecute(tx, `INSERT INTO trx_mp_approval (production_id, action, from_status, to_status, remarks, acted_by) VALUES (?, 'CANCEL', NULL, 'CANCELLED', ?, ?)`, [d.id, 'Job cancelled', req.user!.id]);
      }
      await txExecute(tx, `UPDATE trx_mp_job SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW(), updated_by = ? WHERE id = ?`, [reason, req.user!.id, req.user!.id, id]);
      await audit(req, 'trx_mp_job', id, 'UPDATE', { status: j.status }, { status: 'CANCELLED', reason }, tx);
    });
    res.json({ data: await jobRow(cid, id) });
  }));

  /** Process DCs of this process (to link a job to the panels / garments that came on them). */
  router.get('/dc-options', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const stages = await dcStageIds(cid, kind);
    if (!stages.length) return void res.json({ data: [] });
    const rows = await query<any>(
      `SELECT jc.id, jc.challan_no, jc.challan_date, jc.status, jc.io_no, jc.style_id, st.style_code, v.party_name AS vendor_name, jc.total_qty
         FROM trx_jobwork_challan jc LEFT JOIN mst_style st ON st.id = jc.style_id LEFT JOIN mst_party v ON v.id = jc.vendor_id
        WHERE jc.company_id = ? AND jc.stage_id IN (?) AND jc.status <> 'CANCELLED'
        ORDER BY jc.challan_date DESC, jc.id DESC LIMIT 300`, [cid, stages]);
    res.json({ data: rows });
  }));

  // ===================================================================== MATERIAL ISSUE / RETURN
  /** Trims stock lots available to issue (general stock or the job's own). */
  router.get('/material-stock', requireAny(P('STORE'), P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const where = ['ts.company_id = ?', 'ts.stock_qty - ts.allocated_qty > 0'];
    const params: unknown[] = [cid];
    if (req.query.trim_id) { where.push('ts.trim_id = ?'); params.push(Number(req.query.trim_id)); }
    if (req.query.job_id) {
      const j = await queryOne<any>(`SELECT so_id FROM trx_mp_job WHERE id = ? AND company_id = ?`, [Number(req.query.job_id), cid]);
      where.push('(ts.so_key = 0 OR ts.so_id = ?)'); params.push(j?.so_id ?? -1);
    }
    const rows = await query<any>(
      `SELECT ts.id AS trim_stock_id, ts.trim_id, t.trim_code, t.trim_name, t.trim_type, ts.internal_lot_no AS lot_no, ts.color_name, ts.warehouse_id,
              w.warehouse_name, (ts.stock_qty - ts.allocated_qty) AS available_qty, ts.uom_id, u.code AS uom_code, ts.so_id, so.io_no AS stock_job,
              (SELECT g.rate FROM trx_trim_grn_line g WHERE g.trim_id = ts.trim_id AND g.internal_lot_no = ts.internal_lot_no AND g.rate > 0 ORDER BY g.id DESC LIMIT 1) AS lot_rate,
              t.std_rate
         FROM trx_trim_stock ts JOIN mst_trim t ON t.id = ts.trim_id JOIN mst_warehouse w ON w.id = ts.warehouse_id
         LEFT JOIN cfg_uom u ON u.id = ts.uom_id LEFT JOIN trx_sales_order so ON so.id = ts.so_id
        WHERE ${where.join(' AND ')} ORDER BY t.trim_name, ts.internal_lot_no`, params);
    res.json({ data: rows.map((r) => ({ ...r, unit_cost: n(r.lot_rate) || n(r.std_rate) })) });
  }));

  router.get('/material-txns', requireAny(P('VIEW'), P('STORE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const where = ['t.company_id = ?', 't.process_kind = ?'];
    const params: unknown[] = [cid, kind];
    const qp = req.query as Record<string, string>;
    if (qp.job_id) { where.push('t.job_id = ?'); params.push(Number(qp.job_id)); }
    if (qp.type) { where.push('t.txn_type = ?'); params.push(qp.type); }
    if (qp.from) { where.push('t.txn_date >= ?'); params.push(qp.from); }
    if (qp.to) { where.push('t.txn_date <= ?'); params.push(qp.to); }
    const rows = await query<any>(
      `SELECT t.*, j.job_no, tr.trim_code, tr.trim_name, u.code AS uom_code, w.warehouse_name, p.production_no, uc.full_name AS created_by_name
         FROM trx_mp_material_txn t JOIN trx_mp_job j ON j.id = t.job_id JOIN mst_trim tr ON tr.id = t.trim_id
         LEFT JOIN cfg_uom u ON u.id = t.uom_id LEFT JOIN mst_warehouse w ON w.id = t.warehouse_id
         LEFT JOIN trx_mp_production p ON p.id = t.production_id LEFT JOIN mst_user uc ON uc.id = t.created_by
        WHERE ${where.join(' AND ')} ORDER BY t.txn_date DESC, t.id DESC LIMIT 1000`, params);
    res.json({ data: canSeeCost(req) || has(req, P('STORE')) ? rows : rows.map((r) => ({ ...r, unit_cost: undefined, amount: undefined })) });
  }));

  const matSchema = z.object({
    job_id: s.idReq(),
    txn_date: dateStr,
    production_id: s.id(),
    remarks: s.nullableStr(255),
    lines: z.array(z.object({ trim_stock_id: s.idReq(), qty: z.coerce.number().positive('Qty must be more than 0').max(1e9) })).min(1).max(100),
  });

  async function matJob(tx: Tx, cid: number, b: z.infer<typeof matSchema>) {
    const j = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_job WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [b.job_id, cid, kind]);
    if (!j) throw NotFound(`${L} job not found`);
    if (b.production_id) {
      const p = await txQueryOne<any>(tx, `SELECT id, status FROM trx_mp_production WHERE id = ? AND job_id = ?`, [b.production_id, j.id]);
      if (!p) throw BadRequest('That production entry is not on this job');
      if (['APPROVED', 'CANCELLED'].includes(p.status)) throw BadRequest(`Production entry is ${p.status} — issue against the job instead`);
    }
    return j;
  }

  router.post('/material-issues', requirePermission(P('STORE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = matSchema.parse(req.body);
    const out = await transaction(async (tx) => {
      const j = await matJob(tx, cid, b);
      if (!['PLANNED', 'RUNNING'].includes(j.status)) throw BadRequest(`Job ${j.job_no} is ${j.status} — material is issued to a planned / running job`);
      const no = await nextDocNumber(tx, cid, DOC[kind].mat);
      const ids = [...new Set(b.lines.map((l) => l.trim_stock_id))].sort((a, c) => a - c);
      if (ids.length !== b.lines.length) throw BadRequest('The same lot is listed twice');
      for (const sid of ids) {
        const l = b.lines.find((x) => x.trim_stock_id === sid)!;
        const ts = await txQueryOne<any>(tx, `SELECT ts.*, t.trim_code FROM trx_trim_stock ts JOIN mst_trim t ON t.id = ts.trim_id WHERE ts.id = ? AND ts.company_id = ? FOR UPDATE`, [sid, cid]);
        if (!ts) throw BadRequest(`Stock lot #${sid} not found`);
        if (ts.so_id && Number(ts.so_key) !== 0 && Number(ts.so_id) !== Number(j.so_id)) {
          throw BadRequest(`Lot ${ts.internal_lot_no} of ${ts.trim_code} belongs to another job — transfer it to this job first (Job Transfer)`);
        }
        const avail = n(ts.stock_qty) - n(ts.allocated_qty);
        if (l.qty > avail + EPS) throw BadRequest(`${ts.trim_code} lot ${ts.internal_lot_no}: ${l.qty} requested, only ${r4(avail)} in stock`);
        const cost = await lotUnitCost(tx, Number(ts.trim_id), ts.internal_lot_no);
        await txExecute(tx, `UPDATE trx_trim_stock SET stock_qty = stock_qty - ? WHERE id = ?`, [l.qty, sid]);
        await txExecute(tx,
          `INSERT INTO trx_mp_material_txn (company_id, process_kind, txn_no, txn_type, txn_date, job_id, production_id, trim_stock_id, warehouse_id, trim_id, lot_no,
             qty, uom_id, unit_cost, amount, remarks, created_by) VALUES (?,?,?,'ISSUE',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [cid, kind, no, b.txn_date, j.id, b.production_id ?? null, sid, ts.warehouse_id, ts.trim_id, ts.internal_lot_no, l.qty, ts.uom_id,
           cost, r4(cost * l.qty), b.remarks ?? null, req.user!.id]);
      }
      await audit(req, 'trx_mp_material_txn', j.id, 'INSERT', undefined, { txn_no: no, type: 'ISSUE', job: j.job_no, lines: b.lines }, tx);
      return { txn_no: no };
    });
    res.status(201).json({ data: { ...out, materials: await materialBalance(b.job_id) } });
  }));

  router.post('/material-returns', requirePermission(P('STORE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = matSchema.parse(req.body);
    const out = await transaction(async (tx) => {
      const j = await matJob(tx, cid, b);
      if (j.status === 'CANCELLED') throw BadRequest(`Job ${j.job_no} is cancelled`);
      const no = await nextDocNumber(tx, cid, DOC[kind].mat);
      const bal = await materialBalance(j.id, tx);
      const ids = [...new Set(b.lines.map((l) => l.trim_stock_id))].sort((a, c) => a - c);
      if (ids.length !== b.lines.length) throw BadRequest('The same lot is listed twice');
      const byTrim = new Map<number, number>();
      for (const sid of ids) {
        const l = b.lines.find((x) => x.trim_stock_id === sid)!;
        const ts = await txQueryOne<any>(tx, `SELECT ts.*, t.trim_code FROM trx_trim_stock ts JOIN mst_trim t ON t.id = ts.trim_id WHERE ts.id = ? AND ts.company_id = ? FOR UPDATE`, [sid, cid]);
        if (!ts) throw BadRequest(`Stock lot #${sid} not found`);
        const lot = await txQueryOne<any>(tx,
          `SELECT COALESCE(SUM(CASE WHEN txn_type='ISSUE' THEN qty ELSE -qty END),0) q, COALESCE(SUM(CASE WHEN txn_type='ISSUE' THEN amount ELSE -amount END),0) a
             FROM trx_mp_material_txn WHERE job_id = ? AND trim_stock_id = ? AND status = 'POSTED'`, [j.id, sid]);
        if (l.qty > n(lot?.q) + EPS) throw BadRequest(`${ts.trim_code} lot ${ts.internal_lot_no}: only ${r4(n(lot?.q))} was issued to job ${j.job_no} (net of returns)`);
        const m = bal.find((x) => x.trim_id === Number(ts.trim_id));
        const already = byTrim.get(Number(ts.trim_id)) ?? 0;
        if (m && l.qty + already > m.balance + EPS) throw BadRequest(`${ts.trim_code}: ${r4(m.consumed)} is already consumed by production — only ${r4(Math.max(m.balance - already, 0))} can come back`);
        byTrim.set(Number(ts.trim_id), already + l.qty);
        const cost = n(lot?.q) > 0 ? n(lot?.a) / n(lot?.q) : await lotUnitCost(tx, Number(ts.trim_id), ts.internal_lot_no);
        await txExecute(tx, `UPDATE trx_trim_stock SET stock_qty = stock_qty + ? WHERE id = ?`, [l.qty, sid]);
        await txExecute(tx,
          `INSERT INTO trx_mp_material_txn (company_id, process_kind, txn_no, txn_type, txn_date, job_id, production_id, trim_stock_id, warehouse_id, trim_id, lot_no,
             qty, uom_id, unit_cost, amount, remarks, created_by) VALUES (?,?,?,'RETURN',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [cid, kind, no, b.txn_date, j.id, b.production_id ?? null, sid, ts.warehouse_id, ts.trim_id, ts.internal_lot_no, l.qty, ts.uom_id,
           r4(cost), r4(cost * l.qty), b.remarks ?? null, req.user!.id]);
      }
      await audit(req, 'trx_mp_material_txn', j.id, 'INSERT', undefined, { txn_no: no, type: 'RETURN', job: j.job_no, lines: b.lines }, tx);
      return { txn_no: no };
    });
    res.status(201).json({ data: { ...out, materials: await materialBalance(b.job_id) } });
  }));

  /** Cancel an issue / return line (reversal — never deleted). */
  router.post('/material-txns/:id/cancel', requirePermission(P('STORE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const { reason } = z.object({ reason: reasonReq }).parse(req.body ?? {});
    const jobId = await transaction(async (tx) => {
      const t = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_material_txn WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!t) throw NotFound('Material transaction not found');
      if (t.status === 'CANCELLED') throw BadRequest('Already cancelled');
      await txQueryOne(tx, `SELECT id FROM trx_mp_job WHERE id = ? FOR UPDATE`, [t.job_id]);
      const ts = await txQueryOne<any>(tx, `SELECT * FROM trx_trim_stock WHERE id = ? FOR UPDATE`, [t.trim_stock_id]);
      if (t.txn_type === 'ISSUE') {
        const m = (await materialBalance(t.job_id, tx)).find((x) => x.trim_id === Number(t.trim_id));
        if (m && n(t.qty) > m.balance + EPS) throw BadRequest(`Production has already consumed this material — only ${r4(m.balance)} is unconsumed on the job`);
        await txExecute(tx, `UPDATE trx_trim_stock SET stock_qty = stock_qty + ? WHERE id = ?`, [t.qty, t.trim_stock_id]);
      } else {
        if (n(ts?.stock_qty) - n(ts?.allocated_qty) + EPS < n(t.qty)) throw BadRequest('The returned qty is no longer in that stock lot — it cannot be reversed');
        await txExecute(tx, `UPDATE trx_trim_stock SET stock_qty = stock_qty - ? WHERE id = ?`, [t.qty, t.trim_stock_id]);
      }
      await txExecute(tx, `UPDATE trx_mp_material_txn SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`, [reason, req.user!.id, id]);
      await audit(req, 'trx_mp_material_txn', id, 'UPDATE', { status: 'POSTED' }, { status: 'CANCELLED', reason }, tx);
      return Number(t.job_id);
    });
    res.json({ data: { id, materials: await materialBalance(jobId) } });
  }));

  // ===================================================================== PRODUCTION
  const prodSchema = z.object({
    prod_date: dateStr,
    shift_id: s.idReq(),
    job_id: s.idReq(),
    machine_id: s.idReq(),
    heads_used: z.coerce.number().int().min(1).max(200).default(1),
    operator_name: s.nullableStr(80), helper_name: s.nullableStr(80),
    operator_count: z.coerce.number().min(0).max(50).default(1),
    helper_count: z.coerce.number().min(0).max(50).default(0),
    start_at: dateTimeStr, end_at: dateTimeStr,
    break_minutes: z.coerce.number().int().min(0).max(1440).default(0),
    setup_minutes: z.coerce.number().int().min(0).max(1440).default(0),
    input_qty: qtyNum(), good_qty: qtyNum(), reject_qty: qtyNum(), rework_qty: qtyNum(),
    adjustment_reason: s.nullableStr(255),
    output_uom: z.enum(['PCS', 'KG', 'MTR']).nullish(),
    good_weight_kg: z.coerce.number().min(0).max(1e9).nullish(),
    total_stitches: z.coerce.number().int().min(0).max(1e12).nullish(),
    counter_ids: z.array(z.coerce.number().int().positive()).max(200).default([]),
    other_cost: z.coerce.number().min(0).max(1e9).default(0),
    other_cost_reason: s.nullableStr(255),
    rework_of_id: s.id(),
    remarks: s.nullableStr(500),
    outputs: z.array(z.object({
      output_type: z.enum(['REJECT', 'REWORK']), reason_id: s.idReq(),
      qty: z.coerce.number().positive().max(1e9), remarks: s.nullableStr(255),
    })).max(100).default([]),
    downtime: z.array(z.object({
      reason_id: s.idReq(), start_at: dateTimeStr.nullish(), end_at: dateTimeStr.nullish(),
      minutes: z.coerce.number().int().min(0).max(1440).nullish(), remarks: s.nullableStr(255),
    })).max(100).default([]),
    consumption: z.array(z.object({
      trim_id: s.idReq(), actual_qty: z.coerce.number().min(0).max(1e9).nullish(), wastage_qty: z.coerce.number().min(0).max(1e9).default(0),
    })).max(100).default([]),
  });
  type ProdBody = z.infer<typeof prodSchema>;

  /** Validate a production entry and calculate its consumption and cost (server side — never trusts client totals). */
  async function prepareProduction(tx: Tx, cid: number, b: ProdBody, existingId: number | null) {
    const job = await txQueryOne<any>(tx,
      `SELECT j.*, d.std_minutes_per_pc, d.total_stitches AS design_stitches, r.base_qty
         FROM trx_mp_job j LEFT JOIN mst_mp_design d ON d.id = j.design_id LEFT JOIN mst_mp_recipe r ON r.id = j.recipe_id
        WHERE j.id = ? AND j.company_id = ? AND j.process_kind = ?`, [b.job_id, cid, kind]);
    if (!job) throw BadRequest(`${L} job not found`);
    if (job.status === 'DRAFT') throw BadRequest(`Job ${job.job_no} is a draft — plan it first`);
    if (!['PLANNED', 'RUNNING'].includes(job.status)) throw BadRequest(`Job ${job.job_no} is ${job.status} — no more production can be entered`);
    const machine = await machineOf(cid, kind, b.machine_id, tx);
    if (!machine.is_active) throw BadRequest(`Machine ${machine.machine_code} is inactive`);
    if (b.heads_used > n(machine.head_count)) throw BadRequest(`Machine ${machine.machine_code} has ${machine.head_count} heads — ${b.heads_used} heads used is not possible`);
    const shift = await txQueryOne<any>(tx, `SELECT id FROM cfg_shift WHERE id = ? AND company_id = ? AND is_active = 1`, [b.shift_id, cid]);
    if (!shift) throw BadRequest('Shift not found');

    const start = sqlDateTime(b.start_at); const end = sqlDateTime(b.end_at);
    if (end <= start) throw BadRequest('End time must be after the start time');
    const startDay = start.slice(0, 10);
    const nextDay = new Date(`${b.prod_date}T00:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (startDay !== b.prod_date && startDay !== nextDay.toISOString().slice(0, 10)) throw BadRequest(`Start time ${start} is not on the production date ${b.prod_date}`);
    if ((new Date(end.replace(' ', 'T')).getTime() - new Date(start.replace(' ', 'T')).getTime()) > 24 * 3600 * 1000) throw BadRequest('One production entry cannot run more than 24 hours');

    // Machine availability: no overlapping entry on the same machine.
    const clash = await txQueryOne<any>(tx,
      `SELECT production_no FROM trx_mp_production WHERE machine_id = ? AND status NOT IN ('CANCELLED','REJECTED') AND id <> ?
          AND start_at < ? AND end_at > ? LIMIT 1`, [machine.id, existingId ?? 0, end, start]);
    if (clash) throw BadRequest(`Machine ${machine.machine_code} is already booked in that time on ${clash.production_no}`);

    // Downtime
    const reasons = await txQuery<any>(tx, `SELECT * FROM mst_mp_reason WHERE company_id = ? AND process_kind = ?`, [cid, kind]);
    const reason = (id: number, type: string) => {
      const r = reasons.find((x) => Number(x.id) === Number(id));
      if (!r || r.reason_type !== type) throw BadRequest(`${type === 'DOWNTIME' ? 'Downtime' : 'Reject / rework'} reason #${id} not found`);
      return r;
    };
    const downtime = b.downtime.map((d) => {
      const r = reason(d.reason_id, 'DOWNTIME');
      let mins = d.minutes ?? 0;
      let ds: string | null = null; let de: string | null = null;
      if (d.start_at && d.end_at) {
        ds = sqlDateTime(d.start_at); de = sqlDateTime(d.end_at);
        if (de <= ds) throw BadRequest(`Downtime ${r.reason_code}: end must be after start`);
        if (ds < start || de > end) throw BadRequest(`Downtime ${r.reason_code} must be within the production start / end`);
        mins = Math.round((new Date(de.replace(' ', 'T')).getTime() - new Date(ds.replace(' ', 'T')).getTime()) / 60000);
      }
      if (!(mins > 0)) throw BadRequest(`Downtime ${r.reason_code}: give the minutes or the start / end`);
      return { reason_id: r.id, reason_code: r.reason_code, start_at: ds, end_at: de, minutes: mins, remarks: d.remarks ?? null };
    });
    const downtimeMinutes = downtime.reduce((a, d) => a + d.minutes, 0);
    const gross = (new Date(end.replace(' ', 'T')).getTime() - new Date(start.replace(' ', 'T')).getTime()) / 60000;
    if (b.break_minutes + b.setup_minutes + downtimeMinutes > gross + EPS) {
      throw BadRequest(`Break + setup + downtime (${b.break_minutes + b.setup_minutes + downtimeMinutes} min) is more than the ${Math.round(gross)} min between start and end`);
    }
    const netRun = gross - b.break_minutes - b.setup_minutes - downtimeMinutes;
    if (b.good_qty > 0 && netRun <= 0) throw BadRequest('Good output needs machine run time (start / end leave no run time)');

    // Output balance and reasons
    const bal = validateOutputBalance(b);
    if (bal.errors.length) throw BadRequest(bal.errors.join('; '));
    if (!(b.input_qty > 0)) throw BadRequest('Input qty must be more than 0');
    if (!bal.balanced && !b.adjustment_reason?.trim()) {
      throw BadRequest(`Input ${b.input_qty} ≠ good + reject + rework (${r4(b.good_qty + b.reject_qty + b.rework_qty)}) — give the adjustment reason for the ${bal.adjustment_qty} difference`);
    }
    const outputs = b.outputs.map((o) => ({ ...o, reason_code: reason(o.reason_id, 'REJECT').reason_code }));
    const sumOf = (t: string) => r4(outputs.filter((o) => o.output_type === t).reduce((a, o) => a + o.qty, 0));
    if (Math.abs(sumOf('REJECT') - b.reject_qty) > EPS) throw BadRequest(`Reject ${b.reject_qty} must be split by reason (reasons give ${sumOf('REJECT')})`);
    if (Math.abs(sumOf('REWORK') - b.rework_qty) > EPS) throw BadRequest(`Rework ${b.rework_qty} must be split by reason (reasons give ${sumOf('REWORK')})`);
    if (b.other_cost > 0 && !b.other_cost_reason?.trim()) throw BadRequest('Give the reason for the other cost (it is approved with the entry)');

    // Rework run: keeps the original job and production reference.
    if (b.rework_of_id) {
      const orig = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_production WHERE id = ? AND company_id = ?`, [b.rework_of_id, cid]);
      if (!orig || Number(orig.job_id) !== Number(job.id)) throw BadRequest('The original production for this rework must be on the same job');
      if (orig.status !== 'APPROVED') throw BadRequest(`Original production ${orig.production_no} is ${orig.status} — rework is run against approved production`);
      const done = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(input_qty),0) q FROM trx_mp_production WHERE rework_of_id = ? AND id <> ? AND status NOT IN ('CANCELLED','REJECTED')`, [orig.id, existingId ?? 0]);
      if (n(done?.q) + b.input_qty > n(orig.rework_qty) + EPS) throw BadRequest(`${orig.production_no} sent ${n(orig.rework_qty)} for rework; ${n(done?.q)} already re-run — ${r4(n(orig.rework_qty) - n(done?.q))} left`);
    }

    // Machine counter readings (source evidence) give the stitches.
    let counterStitches: number | null = null;
    if (b.counter_ids.length) {
      const ctr = await txQuery<any>(tx, `SELECT * FROM trx_mp_machine_counter WHERE company_id = ? AND id IN (?)`, [cid, b.counter_ids]);
      if (ctr.length !== new Set(b.counter_ids).size) throw BadRequest('A machine counter reading was not found');
      if (ctr.some((c) => Number(c.machine_id) !== Number(machine.id))) throw BadRequest('Counter readings must be from the same machine');
      if (ctr.some((c) => c.production_id && Number(c.production_id) !== Number(existingId))) throw BadRequest('A counter reading is already linked to another production entry');
      counterStitches = ctr.reduce((a, c) => a + n(c.stitches), 0) || null;
    }
    const spp = job.stitches_per_pc ? n(job.stitches_per_pc) : null;
    let totalStitches: number | null = null; let source: string | null = null;
    if (b.total_stitches) { totalStitches = b.total_stitches; source = counterStitches ? 'COUNTER' : 'MANUAL'; }
    else if (counterStitches) { totalStitches = counterStitches; source = 'COUNTER'; }
    else if (spp) { totalStitches = Math.round((b.good_qty + b.reject_qty + b.rework_qty) * spp); source = 'DESIGN'; }

    // Consumption: recipe standard for the input qty vs actual.
    const lines = await recipeLines(job.recipe_id, tx);
    const linked = existingId ? await txQuery<any>(tx,
      `SELECT trim_id, SUM(CASE WHEN txn_type='ISSUE' THEN qty ELSE 0 END) issued, SUM(CASE WHEN txn_type='RETURN' THEN qty ELSE 0 END) returned,
              GROUP_CONCAT(DISTINCT lot_no) lots
         FROM trx_mp_material_txn WHERE production_id = ? AND status = 'POSTED' GROUP BY trim_id`, [existingId]) : [];
    const wanted = new Map(b.consumption.map((c) => [Number(c.trim_id), c]));
    const trimIds = [...new Set([...lines.map((l) => Number(l.trim_id)), ...wanted.keys(), ...linked.map((x) => Number(x.trim_id))])];
    const consumption: any[] = [];
    for (const tid of trimIds) {
      const recipeLine = lines.find((l) => Number(l.trim_id) === tid);
      const t = recipeLine ? null : await txQueryOne<any>(tx, `SELECT id, base_uom FROM mst_trim WHERE id = ? AND company_id = ?`, [tid, cid]);
      if (!recipeLine && !t) throw BadRequest(`Material #${tid} not found`);
      const factor = recipeLine ? n(recipeLine.per_stock_unit) || 1 : 1;
      const std = recipeLine ? calculateStandardConsumption([recipeLine], b.input_qty, n(job.base_qty) || 1, spp)[0].standard_qty : 0;
      const lk = linked.find((x) => Number(x.trim_id) === tid);
      const issued = r6(n(lk?.issued) * factor); const returned = r6(n(lk?.returned) * factor);
      const w = wanted.get(tid);
      const actual = calculateActualConsumption({ actual_qty: w?.actual_qty ?? null, issued_qty: issued, returned_qty: returned, standard_qty: std });
      const wastage = r6(n(w?.wastage_qty));
      if (wastage > actual + EPS) throw BadRequest('Wastage is part of the actual consumption — it cannot be more than the actual');
      const unitCost = r6((await jobUnitCost(job.id, tid, tx)) / factor);
      consumption.push({
        trim_id: tid, recipe_item_id: recipeLine?.id ?? null, material_role: recipeLine?.material_role ?? 'OTHER',
        uom_id: recipeLine ? recipeLine.uom_id : Number(t.base_uom), per_stock_unit: factor,
        standard_qty: std, issued_qty: issued, returned_qty: returned, actual_qty: actual, wastage_qty: wastage,
        unit_cost: unitCost, total_cost: r4(actual * unitCost), lot_nos: lk?.lots ?? null,
      });
    }

    const rate = await rateOn(machine.id, b.prod_date, tx);
    if (!rate) throw BadRequest(`Machine ${machine.machine_code} has no rate in force on ${b.prod_date} — add one in the machine master`);
    const setupInCosting = await settingFlag(cid, 'MP_SETUP_IN_COSTING', false);
    const outputUom = b.output_uom ?? job.uom;
    const cost = calculateProductionCost(kind, {
      machine: { head_count: n(machine.head_count), capacity_stitches_hour: machine.capacity_stitches_hour != null ? n(machine.capacity_stitches_hour) : null, capacity_per_hour: machine.capacity_per_hour != null ? n(machine.capacity_per_hour) : null },
      rate, setupInCosting, start_at: start.replace(' ', 'T'), end_at: end.replace(' ', 'T'),
      break_minutes: b.break_minutes, setup_minutes: b.setup_minutes, downtime_minutes: downtimeMinutes,
      heads_used: b.heads_used, operator_count: b.operator_count, helper_count: b.helper_count,
      input_qty: b.input_qty, good_qty: b.good_qty, reject_qty: b.reject_qty, rework_qty: b.rework_qty,
      good_weight_kg: b.good_weight_kg ?? null, output_uom: outputUom, total_stitches: totalStitches, stitches_per_pc: spp,
      std_minutes_per_pc: job.std_minutes_per_pc != null ? n(job.std_minutes_per_pc) : null, other_cost: b.other_cost,
      consumption: consumption.map((c) => ({ trim_id: c.trim_id, material_role: c.material_role, standard_qty: c.standard_qty, actual_qty: c.actual_qty, unit_cost: c.unit_cost })),
    });
    return {
      job, machine, start, end, downtime, downtimeMinutes, outputs, consumption, rate, cost, outputUom,
      adjustment: bal.adjustment_qty, totalStitches, source, setupInCosting,
    };
  }
  type Prepared = Awaited<ReturnType<typeof prepareProduction>>;

  async function writeProduction(tx: Tx, req: Request, id: number, b: ProdBody, p: Prepared, finalCosting = false) {
    await txExecute(tx,
      `UPDATE trx_mp_production SET prod_date = ?, shift_id = ?, job_id = ?, machine_id = ?, heads_used = ?, operator_name = ?, helper_name = ?,
         operator_count = ?, helper_count = ?, start_at = ?, end_at = ?, break_minutes = ?, setup_minutes = ?, downtime_minutes = ?, input_qty = ?,
         good_qty = ?, reject_qty = ?, rework_qty = ?, adjustment_qty = ?, adjustment_reason = ?, output_uom = ?, good_weight_kg = ?,
         total_stitches = ?, stitches_source = ?, other_cost = ?, other_cost_reason = ?, rework_of_id = ?, remarks = ?, updated_by = ? WHERE id = ?`,
      [b.prod_date, b.shift_id, b.job_id, b.machine_id, b.heads_used, b.operator_name ?? null, b.helper_name ?? null, b.operator_count, b.helper_count,
       p.start, p.end, b.break_minutes, b.setup_minutes, p.downtimeMinutes, b.input_qty, b.good_qty, b.reject_qty, b.rework_qty, p.adjustment,
       p.adjustment ? b.adjustment_reason ?? null : null, p.outputUom, b.good_weight_kg ?? null, p.totalStitches, p.source, b.other_cost,
       b.other_cost > 0 ? b.other_cost_reason ?? null : null, b.rework_of_id ?? null, b.remarks ?? null, req.user!.id, id]);
    await txExecute(tx, `DELETE FROM trx_mp_production_output WHERE production_id = ?`, [id]);
    for (const o of p.outputs) {
      await txExecute(tx, `INSERT INTO trx_mp_production_output (production_id, output_type, reason_id, qty, remarks) VALUES (?,?,?,?,?)`, [id, o.output_type, o.reason_id, o.qty, o.remarks ?? null]);
    }
    await txExecute(tx, `DELETE FROM trx_mp_downtime WHERE production_id = ?`, [id]);
    for (const d of p.downtime) {
      await txExecute(tx, `INSERT INTO trx_mp_downtime (production_id, reason_id, start_at, end_at, minutes, remarks) VALUES (?,?,?,?,?,?)`, [id, d.reason_id, d.start_at, d.end_at, d.minutes, d.remarks]);
    }
    await txExecute(tx, `DELETE FROM trx_mp_consumption WHERE production_id = ?`, [id]);
    for (const c of p.consumption) {
      await txExecute(tx,
        `INSERT INTO trx_mp_consumption (production_id, trim_id, recipe_item_id, material_role, uom_id, per_stock_unit, standard_qty, issued_qty, returned_qty,
           actual_qty, wastage_qty, unit_cost, total_cost, lot_nos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, c.trim_id, c.recipe_item_id, c.material_role, c.uom_id, c.per_stock_unit, c.standard_qty, c.issued_qty, c.returned_qty, c.actual_qty,
         c.wastage_qty, c.unit_cost, c.total_cost, c.lot_nos]);
    }
    await txExecute(tx, `UPDATE trx_mp_machine_counter SET production_id = NULL WHERE production_id = ?`, [id]);
    if (b.counter_ids.length) await txQuery(tx, `UPDATE trx_mp_machine_counter SET production_id = ? WHERE id IN (?)`, [id, b.counter_ids]);
    await writeCosting(tx, req, id, p, finalCosting);
  }

  async function writeCosting(tx: Tx, req: Request, id: number, p: Prepared, isFinal: boolean) {
    const c = p.cost;
    await txExecute(tx, `DELETE FROM trx_mp_costing WHERE production_id = ? AND is_final = 0`, [id]);
    await txExecute(tx,
      `INSERT INTO trx_mp_costing (production_id, machine_rate_id, rate_snapshot, gross_minutes, net_run_hours, costing_hours, standard_hours,
         thread_cost, consumable_cost, material_cost, machine_cost, labour_cost, overhead_cost, other_cost, total_cost,
         std_material_cost, std_machine_cost, std_labour_cost, std_overhead_cost, std_total_cost, good_qty, good_weight_kg, total_stitches,
         cost_per_unit, cost_per_kg, cost_per_1000_stitches, output_per_hour, stitches_per_hour, efficiency_pct, utilization_pct, reject_pct, rework_pct,
         is_final, calculated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, p.rate.id, JSON.stringify({ ...p.rate, setup_in_costing: p.setupInCosting, labour_hours: c.labour_hours }), c.gross_minutes, c.net_run_hours, c.costing_hours, c.standard_hours,
       c.thread_cost, c.consumable_cost, c.material_cost, c.machine_cost, c.labour_cost, c.overhead_cost, c.other_cost, c.total_cost,
       c.std_material_cost, c.std_machine_cost, c.std_labour_cost, c.std_overhead_cost, c.std_total_cost, c.good_qty, c.good_weight_kg, c.total_stitches,
       c.cost_per_unit, c.cost_per_kg, c.cost_per_1000_stitches, c.output_per_hour, c.stitches_per_hour, c.efficiency_pct, c.utilization_pct, c.reject_pct, c.rework_pct,
       isFinal ? 1 : 0, req.user!.id]);
  }

  /** Actual consumption of the job cannot run past what the store issued (setting MP_CONSUMPTION_WITHIN_ISSUE). */
  async function checkWithinIssue(tx: Tx, cid: number, id: number, p: Prepared) {
    if (!(await settingFlag(cid, 'MP_CONSUMPTION_WITHIN_ISSUE', true))) return;
    const bal = await materialBalance(p.job.id, tx);
    const problems: string[] = [];
    for (const c of p.consumption) {
      if (!(c.actual_qty > 0)) continue;
      const m = bal.find((x) => x.trim_id === c.trim_id);
      const other = await txQueryOne<any>(tx,
        `SELECT COALESCE(SUM(c.actual_qty / NULLIF(c.per_stock_unit,0)),0) q FROM trx_mp_consumption c JOIN trx_mp_production p ON p.id = c.production_id
          WHERE p.job_id = ? AND p.status IN ${ACTIVE_PROD} AND p.id <> ? AND c.trim_id = ?`, [p.job.id, id, c.trim_id]);
      const need = n(other?.q) + c.actual_qty / (c.per_stock_unit || 1);
      const net = m?.net_issued ?? 0;
      if (need > net + 0.0001) {
        const t = await txQueryOne<any>(tx, `SELECT tr.trim_code, u.code FROM mst_trim tr LEFT JOIN cfg_uom u ON u.id = tr.base_uom WHERE tr.id = ?`, [c.trim_id]);
        problems.push(`${t?.trim_code}: job consumption ${r4(need)} ${t?.code ?? ''} > issued ${r4(net)}`);
      }
    }
    if (problems.length) throw BadRequest(`Issue the material from store before submitting — ${problems.join('; ')}`);
  }

  /** Fresh input of the job against its planned qty (rework runs re-process the same pieces, so they never count). */
  async function overPlan(tx: Tx, cid: number, id: number, p: Prepared, b: ProdBody) {
    const tol = await settingNum(cid, 'MP_OUTPUT_TOLERANCE_PCT', 2);
    if (b.rework_of_id) return { over: false, total: 0, planned: n(p.job.planned_qty), tol };
    const inputQty = b.input_qty;
    const done = await txQueryOne<any>(tx, `SELECT COALESCE(SUM(input_qty),0) q FROM trx_mp_production WHERE job_id = ? AND id <> ? AND status IN ${ACTIVE_PROD} AND rework_of_id IS NULL`, [p.job.id, id]);
    const total = n(done?.q) + inputQty;
    return { over: total > n(p.job.planned_qty) * (1 + tol / 100) + EPS, total: r4(total), planned: n(p.job.planned_qty), tol };
  }

  async function loadProduction(req: Request, id: number) {
    const cid = req.user!.companyId;
    const p = await queryOne<any>(
      `SELECT p.*, ${dt('p.start_at', 'start_at')}, ${dt('p.end_at', 'end_at')},
              j.job_no, j.io_no, j.planned_qty, j.uom AS job_uom, j.status AS job_status, j.stitches_per_pc, j.placement,
              st.style_code, st.style_name, col.color_name, pt.party_name AS buyer_name, d.design_code, d.version_no AS design_version, d.design_name,
              r.recipe_no, r.version_no AS recipe_version, m.machine_code, m.machine_name, m.head_count, sh.shift_code, sh.shift_name,
              ro.production_no AS rework_of_no,
              uc.full_name AS created_by_name, us.full_name AS submitted_by_name, ua.full_name AS approved_by_name, ur.full_name AS rejected_by_name, ux.full_name AS cancelled_by_name
         FROM trx_mp_production p JOIN trx_mp_job j ON j.id = p.job_id JOIN mst_mp_machine m ON m.id = p.machine_id
         LEFT JOIN cfg_shift sh ON sh.id = p.shift_id LEFT JOIN mst_style st ON st.id = j.style_id LEFT JOIN mst_color col ON col.id = j.color_id
         LEFT JOIN mst_party pt ON pt.id = j.buyer_id LEFT JOIN mst_mp_design d ON d.id = j.design_id LEFT JOIN mst_mp_recipe r ON r.id = j.recipe_id
         LEFT JOIN trx_mp_production ro ON ro.id = p.rework_of_id
         LEFT JOIN mst_user uc ON uc.id = p.created_by LEFT JOIN mst_user us ON us.id = p.submitted_by LEFT JOIN mst_user ua ON ua.id = p.approved_by
         LEFT JOIN mst_user ur ON ur.id = p.rejected_by LEFT JOIN mst_user ux ON ux.id = p.cancelled_by
        WHERE p.id = ? AND p.company_id = ? AND p.process_kind = ?`, [id, cid, kind]);
    if (!p) throw NotFound(`${L} production entry not found`);
    p.outputs = await query(`SELECT o.*, r.reason_code, r.reason_name FROM trx_mp_production_output o JOIN mst_mp_reason r ON r.id = o.reason_id WHERE o.production_id = ? ORDER BY o.id`, [id]);
    p.downtime = await query(`SELECT d.id, d.reason_id, d.minutes, d.remarks, ${dt('d.start_at', 'start_at')}, ${dt('d.end_at', 'end_at')}, r.reason_code, r.reason_name, r.needs_approval
                                FROM trx_mp_downtime d JOIN mst_mp_reason r ON r.id = d.reason_id WHERE d.production_id = ? ORDER BY d.id`, [id]);
    const cons = await query<any>(
      `SELECT c.*, t.trim_code, t.trim_name, u.code AS uom_code FROM trx_mp_consumption c JOIN mst_trim t ON t.id = c.trim_id LEFT JOIN cfg_uom u ON u.id = c.uom_id
        WHERE c.production_id = ? ORDER BY c.id`, [id]);
    const showCost = canSeeCost(req);
    p.consumption = cons.map((c) => ({ ...c, ...calculateVariance(n(c.actual_qty), n(c.standard_qty)), ...(showCost ? {} : { unit_cost: undefined, total_cost: undefined }) }));
    p.counters = await query(`SELECT id, ${dt('reading_from', 'reading_from')}, ${dt('reading_to', 'reading_to')}, stitches, pieces, run_minutes, source_ref FROM trx_mp_machine_counter WHERE production_id = ?`, [id]);
    p.costing = showCost ? await queryOne<any>(`SELECT * FROM trx_mp_costing WHERE production_id = ? ORDER BY is_final DESC, id DESC LIMIT 1`, [id]) : null;
    if (p.costing && typeof p.costing.rate_snapshot === 'string') { try { p.costing.rate_snapshot = JSON.parse(p.costing.rate_snapshot); } catch { /* keep */ } }
    if (!showCost) { p.other_cost = undefined; }
    p.approvals = await query(`SELECT a.*, u.full_name AS acted_by_name FROM trx_mp_approval a LEFT JOIN mst_user u ON u.id = a.acted_by WHERE a.production_id = ? ORDER BY a.id`, [id]);
    p.audit = await query(`SELECT a.action, a.old_values, a.new_values, a.changed_at, u.full_name AS changed_by_name FROM log_audit a LEFT JOIN mst_user u ON u.id = a.changed_by
                            WHERE a.company_id = ? AND a.table_name = 'trx_mp_production' AND a.record_id = ? ORDER BY a.id DESC LIMIT 100`, [cid, id]);
    return p;
  }

  router.get('/production', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const where = ['p.company_id = ?', 'p.process_kind = ?'];
    const params: unknown[] = [cid, kind];
    const qp = req.query as Record<string, string>;
    if (qp.status) { where.push('p.status = ?'); params.push(qp.status); }
    if (qp.from) { where.push('p.prod_date >= ?'); params.push(qp.from); }
    if (qp.to) { where.push('p.prod_date <= ?'); params.push(qp.to); }
    for (const k of ['machine_id', 'job_id', 'shift_id']) if (qp[k]) { where.push(`p.${k} = ?`); params.push(Number(qp[k])); }
    if (qp.q) { where.push('(p.production_no LIKE ? OR j.job_no LIKE ? OR j.io_no LIKE ? OR p.operator_name LIKE ?)'); params.push(...Array(4).fill(`%${qp.q}%`)); }
    const rows = await query<any>(
      `SELECT p.id, p.production_no, p.prod_date, p.status, p.input_qty, p.good_qty, p.reject_qty, p.rework_qty, p.heads_used, p.total_stitches,
              p.operator_name, p.downtime_minutes, p.over_plan, p.rework_of_id, ${dt('p.start_at', 'start_at')}, ${dt('p.end_at', 'end_at')},
              j.job_no, j.io_no, st.style_code, d.design_code, m.machine_code, sh.shift_code,
              c.net_run_hours, c.efficiency_pct, c.output_per_hour, c.total_cost, c.cost_per_unit, c.is_final
         FROM trx_mp_production p JOIN trx_mp_job j ON j.id = p.job_id JOIN mst_mp_machine m ON m.id = p.machine_id
         LEFT JOIN cfg_shift sh ON sh.id = p.shift_id LEFT JOIN mst_style st ON st.id = j.style_id LEFT JOIN mst_mp_design d ON d.id = j.design_id
         LEFT JOIN trx_mp_costing c ON c.id = (SELECT c2.id FROM trx_mp_costing c2 WHERE c2.production_id = p.id ORDER BY c2.is_final DESC, c2.id DESC LIMIT 1)
        WHERE ${where.join(' AND ')} ORDER BY p.prod_date DESC, p.start_at DESC, p.id DESC LIMIT 1000`, params);
    const show = canSeeCost(req);
    res.json({ data: show ? rows : rows.map((r) => ({ ...r, total_cost: undefined, cost_per_unit: undefined })) });
  }));

  router.get('/production/:id', requirePermission(P('VIEW')), ah(async (req, res) => {
    res.json({ data: await loadProduction(req, Number(req.params.id)) });
  }));

  /** POST /production/preview — validate + calculate without saving (the screen shows server totals while typing). */
  router.post('/production/preview', requireAny(P('CREATE'), P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = prodSchema.parse(req.body);
    const existingId = req.query.id ? Number(req.query.id) : null;
    const p = await transaction((tx) => prepareProduction(tx, cid, b, existingId));
    const show = canSeeCost(req);
    const names = p.consumption.length ? await query<any>(
      `SELECT t.id, t.trim_code, t.trim_name FROM mst_trim t WHERE t.id IN (?)`, [p.consumption.map((c) => c.trim_id)]) : [];
    const uoms = await query<any>(`SELECT id, code FROM cfg_uom`);
    res.json({ data: {
      adjustment_qty: p.adjustment, total_stitches: p.totalStitches, stitches_source: p.source, downtime_minutes: p.downtimeMinutes,
      consumption: p.consumption.map((c) => {
        const t = names.find((x) => Number(x.id) === c.trim_id);
        return { ...c, trim_code: t?.trim_code, trim_name: t?.trim_name, uom_code: uoms.find((u) => Number(u.id) === Number(c.uom_id))?.code,
          ...calculateVariance(c.actual_qty, c.standard_qty), ...(show ? {} : { unit_cost: undefined, total_cost: undefined }) };
      }),
      cost: show ? p.cost : {
        net_run_hours: p.cost.net_run_hours, costing_hours: p.cost.costing_hours, output_per_hour: p.cost.output_per_hour, stitches_per_hour: p.cost.stitches_per_hour,
        efficiency_pct: p.cost.efficiency_pct, utilization_pct: p.cost.utilization_pct, reject_pct: p.cost.reject_pct, rework_pct: p.cost.rework_pct,
      },
    } });
  }));

  router.post('/production', requireAny(P('CREATE'), P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = prodSchema.parse(req.body);
    const submit = req.query.submit === '1';
    if (submit && !has(req, P('SUBMIT'))) throw Forbidden(`Missing required permission: ${P('SUBMIT')}`);
    const id = await transaction(async (tx) => {
      await txQueryOne(tx, `SELECT id FROM trx_mp_job WHERE id = ? FOR UPDATE`, [b.job_id]);
      const p = await prepareProduction(tx, cid, b, null);
      const no = await nextDocNumber(tx, cid, DOC[kind].prod);
      const r = await txExecute(tx,
        `INSERT INTO trx_mp_production (company_id, process_kind, production_no, prod_date, shift_id, job_id, machine_id, start_at, end_at, status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,'DRAFT',?)`, [cid, kind, no, b.prod_date, b.shift_id, b.job_id, b.machine_id, p.start, p.end, req.user!.id]);
      await writeProduction(tx, req, r.insertId, b, p);
      await audit(req, 'trx_mp_production', r.insertId, 'INSERT', undefined, { production_no: no, ...b }, tx);
      if (submit) await doSubmit(tx, req, r.insertId, p, b);
      return r.insertId;
    });
    res.status(201).json({ data: await loadProduction(req, id) });
  }));

  router.put('/production/:id', requireAny(P('CREATE'), P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const b = prodSchema.parse(req.body);
    await transaction(async (tx) => {
      const before = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_production WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!before) throw NotFound(`${L} production entry not found`);
      if (['APPROVED', 'CANCELLED'].includes(before.status)) throw BadRequest(`${before.production_no} is ${before.status} — it cannot be edited${before.status === 'APPROVED' ? ' (cancel / reverse it and enter it again)' : ''}`);
      if (before.status === 'SUBMITTED' && !has(req, P('SUBMIT'))) throw Forbidden(`${before.production_no} is submitted — only a supervisor can edit it`);
      if (Number(before.job_id) !== b.job_id) {
        const mat = await txQueryOne<any>(tx, `SELECT COUNT(*) c FROM trx_mp_material_txn WHERE production_id = ? AND status = 'POSTED'`, [id]);
        if (n(mat?.c)) throw BadRequest('Material was issued against this entry — the job cannot change');
      }
      await txQueryOne(tx, `SELECT id FROM trx_mp_job WHERE id = ? FOR UPDATE`, [b.job_id]);
      const p = await prepareProduction(tx, cid, b, id);
      if (before.status === 'SUBMITTED') {
        await checkWithinIssue(tx, cid, id, p);
        const op = await overPlan(tx, cid, id, p, b);
        await txExecute(tx, `UPDATE trx_mp_production SET over_plan = ? WHERE id = ?`, [op.over ? 1 : 0, id]);
      }
      await writeProduction(tx, req, id, b, p);
      // A rejected entry that is corrected goes back to draft (to be submitted again).
      if (before.status === 'REJECTED') {
        await txExecute(tx, `UPDATE trx_mp_production SET status = 'DRAFT' WHERE id = ?`, [id]);
        await txExecute(tx, `INSERT INTO trx_mp_approval (production_id, action, from_status, to_status, remarks, acted_by) VALUES (?, 'REOPEN', 'REJECTED', 'DRAFT', 'Corrected after rejection', ?)`, [id, req.user!.id]);
      }
      const old = { ...before, start_at: String(before.start_at), end_at: String(before.end_at) };
      await audit(req, 'trx_mp_production', id, 'UPDATE', old, b, tx);
    });
    res.json({ data: await loadProduction(req, id) });
  }));

  async function bodyOf(tx: Tx, id: number): Promise<ProdBody> {
    const p = await txQueryOne<any>(tx, `SELECT *, ${dt('start_at', 's_at')}, ${dt('end_at', 'e_at')} FROM trx_mp_production WHERE id = ?`, [id]);
    const outputs = await txQuery<any>(tx, `SELECT output_type, reason_id, qty, remarks FROM trx_mp_production_output WHERE production_id = ?`, [id]);
    const downtime = await txQuery<any>(tx, `SELECT reason_id, ${dt('start_at', 'start_at')}, ${dt('end_at', 'end_at')}, minutes, remarks FROM trx_mp_downtime WHERE production_id = ?`, [id]);
    const cons = await txQuery<any>(tx, `SELECT trim_id, actual_qty, wastage_qty FROM trx_mp_consumption WHERE production_id = ?`, [id]);
    const ctr = await txQuery<any>(tx, `SELECT id FROM trx_mp_machine_counter WHERE production_id = ?`, [id]);
    return prodSchema.parse({
      prod_date: p.prod_date, shift_id: p.shift_id, job_id: p.job_id, machine_id: p.machine_id, heads_used: p.heads_used,
      operator_name: p.operator_name, helper_name: p.helper_name, operator_count: p.operator_count, helper_count: p.helper_count,
      start_at: p.s_at, end_at: p.e_at, break_minutes: p.break_minutes, setup_minutes: p.setup_minutes,
      input_qty: p.input_qty, good_qty: p.good_qty, reject_qty: p.reject_qty, rework_qty: p.rework_qty, adjustment_reason: p.adjustment_reason,
      output_uom: p.output_uom, good_weight_kg: p.good_weight_kg, total_stitches: p.stitches_source === 'DESIGN' ? null : p.total_stitches,
      counter_ids: ctr.map((c) => c.id), other_cost: p.other_cost, other_cost_reason: p.other_cost_reason, rework_of_id: p.rework_of_id, remarks: p.remarks,
      outputs, downtime: downtime.map((d) => (d.start_at && d.end_at ? d : { ...d, start_at: null, end_at: null })),
      consumption: cons.map((c) => ({ trim_id: c.trim_id, actual_qty: c.actual_qty, wastage_qty: c.wastage_qty })),
    });
  }

  async function doSubmit(tx: Tx, req: Request, id: number, p: Prepared, b: ProdBody) {
    const cid = req.user!.companyId;
    await checkWithinIssue(tx, cid, id, p);
    const op = await overPlan(tx, cid, id, p, b);
    await txExecute(tx, `UPDATE trx_mp_production SET status = 'SUBMITTED', over_plan = ?, submitted_by = ?, submitted_at = NOW() WHERE id = ?`, [op.over ? 1 : 0, req.user!.id, id]);
    await txExecute(tx, `INSERT INTO trx_mp_approval (production_id, action, from_status, to_status, remarks, acted_by) VALUES (?, 'SUBMIT', 'DRAFT', 'SUBMITTED', ?, ?)`,
      [id, op.over ? `Over plan: ${op.total} vs planned ${op.planned} (+${op.tol}%)` : null, req.user!.id]);
    if (p.job.status === 'PLANNED') await txExecute(tx, `UPDATE trx_mp_job SET status = 'RUNNING' WHERE id = ?`, [p.job.id]);
    await audit(req, 'trx_mp_production', id, 'UPDATE', { status: 'DRAFT' }, { status: 'SUBMITTED', over_plan: op }, tx);
  }

  router.post('/production/:id/submit', requirePermission(P('SUBMIT')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    await transaction(async (tx) => {
      const pr = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_production WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!pr) throw NotFound(`${L} production entry not found`);
      if (pr.status !== 'DRAFT') throw BadRequest(`${pr.production_no} is ${pr.status} — only a draft can be submitted`);
      await txQueryOne(tx, `SELECT id FROM trx_mp_job WHERE id = ? FOR UPDATE`, [pr.job_id]);
      const b = await bodyOf(tx, id);
      const p = await prepareProduction(tx, cid, b, id);
      await writeCosting(tx, req, id, p, false);
      await doSubmit(tx, req, id, p, b);
    });
    res.json({ data: await loadProduction(req, id) });
  }));

  router.post('/production/:id/approve', requirePermission(P('APPROVE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const body = z.object({ remarks: s.nullableStr(255), over_plan_reason: s.nullableStr(255) }).parse(req.body ?? {});
    await transaction(async (tx) => {
      const pr = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_production WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!pr) throw NotFound(`${L} production entry not found`);
      if (pr.status !== 'SUBMITTED') throw BadRequest(`${pr.production_no} is ${pr.status} — only a submitted entry can be approved`);
      await txQueryOne(tx, `SELECT id FROM trx_mp_job WHERE id = ? FOR UPDATE`, [pr.job_id]);
      const b = await bodyOf(tx, id);
      const p = await prepareProduction(tx, cid, b, id);
      await checkWithinIssue(tx, cid, id, p);
      const op = await overPlan(tx, cid, id, p, b);
      if (op.over && !body.over_plan_reason?.trim()) {
        throw BadRequest(`Job ${p.job.job_no} output goes to ${op.total} against ${op.planned} planned (tolerance ${op.tol}%) — give the over-plan reason to approve`);
      }
      // Recalculated once more and frozen: later rate / recipe changes never alter it.
      await writeCosting(tx, req, id, p, true);
      await txExecute(tx, `UPDATE trx_mp_production SET status = 'APPROVED', over_plan = ?, over_plan_reason = ?, approved_by = ?, approved_at = NOW() WHERE id = ?`,
        [op.over ? 1 : 0, op.over ? body.over_plan_reason : null, req.user!.id, id]);
      await txExecute(tx, `INSERT INTO trx_mp_approval (production_id, action, from_status, to_status, remarks, acted_by) VALUES (?, 'APPROVE', 'SUBMITTED', 'APPROVED', ?, ?)`,
        [id, [body.remarks, op.over ? `Over plan: ${body.over_plan_reason}` : null].filter(Boolean).join(' · ') || null, req.user!.id]);
      if (p.job.status === 'PLANNED') await txExecute(tx, `UPDATE trx_mp_job SET status = 'RUNNING' WHERE id = ?`, [p.job.id]);
      await audit(req, 'trx_mp_production', id, 'UPDATE', { status: 'SUBMITTED' }, { status: 'APPROVED', total_cost: p.cost.total_cost, cost_per_unit: p.cost.cost_per_unit, remarks: body.remarks }, tx);
    });
    res.json({ data: await loadProduction(req, id) });
  }));

  router.post('/production/:id/reject', requirePermission(P('APPROVE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const { remarks } = z.object({ remarks: reasonReq }).parse(req.body ?? {});
    await transaction(async (tx) => {
      const pr = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_production WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!pr) throw NotFound(`${L} production entry not found`);
      if (pr.status !== 'SUBMITTED') throw BadRequest(`${pr.production_no} is ${pr.status} — only a submitted entry can be rejected`);
      await txExecute(tx, `UPDATE trx_mp_production SET status = 'REJECTED', rejected_by = ?, rejected_at = NOW(), reject_remarks = ? WHERE id = ?`, [req.user!.id, remarks, id]);
      await txExecute(tx, `INSERT INTO trx_mp_approval (production_id, action, from_status, to_status, remarks, acted_by) VALUES (?, 'REJECT', 'SUBMITTED', 'REJECTED', ?, ?)`, [id, remarks, req.user!.id]);
      await audit(req, 'trx_mp_production', id, 'UPDATE', { status: 'SUBMITTED' }, { status: 'REJECTED', remarks }, tx);
    });
    res.json({ data: await loadProduction(req, id) });
  }));

  /** Cancel: drafts / rejected by the floor, submitted by a supervisor, approved only by an approver (a reversal with reason). */
  router.post('/production/:id/cancel', requireAny(P('CREATE'), P('SUBMIT'), P('APPROVE')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const id = Number(req.params.id);
    const { reason } = z.object({ reason: reasonReq }).parse(req.body ?? {});
    await transaction(async (tx) => {
      const pr = await txQueryOne<any>(tx, `SELECT * FROM trx_mp_production WHERE id = ? AND company_id = ? AND process_kind = ? FOR UPDATE`, [id, cid, kind]);
      if (!pr) throw NotFound(`${L} production entry not found`);
      if (pr.status === 'CANCELLED') throw BadRequest('Already cancelled');
      const need = pr.status === 'APPROVED' ? P('APPROVE') : pr.status === 'SUBMITTED' ? P('SUBMIT') : null;
      if (need && !has(req, need)) throw Forbidden(`A ${pr.status.toLowerCase()} entry needs ${need} to cancel`);
      if (pr.status === 'APPROVED') {
        const rw = await txQueryOne<any>(tx, `SELECT GROUP_CONCAT(production_no) nos FROM trx_mp_production WHERE rework_of_id = ? AND status <> 'CANCELLED'`, [id]);
        if (rw?.nos) throw BadRequest(`Rework runs ${rw.nos} point to this entry — cancel them first`);
        const job = await txQueryOne<any>(tx, `SELECT status, job_no FROM trx_mp_job WHERE id = ? FOR UPDATE`, [pr.job_id]);
        if (job?.status === 'COMPLETED') throw BadRequest(`Job ${job.job_no} is completed — its production cannot be reversed`);
      }
      await txExecute(tx, `UPDATE trx_mp_production SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?`, [req.user!.id, reason, id]);
      await txExecute(tx, `UPDATE trx_mp_machine_counter SET production_id = NULL WHERE production_id = ?`, [id]);
      await txExecute(tx, `INSERT INTO trx_mp_approval (production_id, action, from_status, to_status, remarks, acted_by) VALUES (?, 'CANCEL', ?, 'CANCELLED', ?, ?)`, [id, pr.status, reason, req.user!.id]);
      await audit(req, 'trx_mp_production', id, 'UPDATE', { status: pr.status }, { status: 'CANCELLED', reason }, tx);
    });
    res.json({ data: await loadProduction(req, id) });
  }));

  /** GET /costing/:productionId — the costing snapshot with standard vs actual by cost head. */
  router.get('/costing/:productionId', requireAny(P('COSTING'), P('APPROVE'), P('SUBMIT'), P('MASTER')), ah(async (req, res) => {
    const id = Number(req.params.productionId);
    const p = await loadProduction(req, id);
    if (!p.costing) throw NotFound('No costing calculated for this entry yet');
    const c = p.costing;
    const heads = [
      ['Material', c.material_cost, c.std_material_cost], ['Machine', c.machine_cost, c.std_machine_cost], ['Labour', c.labour_cost, c.std_labour_cost],
      ['Overhead', c.overhead_cost, c.std_overhead_cost], ['Other', c.other_cost, 0], ['Total', c.total_cost, c.std_total_cost],
    ].map(([head, actual, std]) => ({ head, actual: n(actual), standard: n(std), ...calculateVariance(n(actual), n(std)) }));
    res.json({ data: { production_id: id, production_no: p.production_no, status: p.status, is_final: !!c.is_final, costing: c, heads, consumption: p.consumption } });
  }));

  // ===================================================================== MACHINE COUNTER IMPORT
  const counterSchema = z.object({
    rows: z.array(z.object({
      machine_id: s.id(), machine_code: s.nullableStr(40),
      reading_from: dateTimeStr, reading_to: dateTimeStr,
      stitches: z.coerce.number().int().min(0).nullish(), pieces: z.coerce.number().min(0).nullish(), run_minutes: z.coerce.number().min(0).nullish(),
      machine_status: s.nullableStr(30), source_ref: s.nullableStr(120),
    })).min(1).max(5000),
  });
  /** POST /machine-counter — stitch counter / run time readings from the machine (kept as source evidence). */
  router.post('/machine-counter', requireAny(P('CREATE'), P('MASTER')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const b = counterSchema.parse(req.body);
    const machines = await query<any>(`SELECT id, machine_code FROM mst_mp_machine WHERE company_id = ? AND process_kind = ?`, [cid, kind]);
    const ids = await transaction(async (tx) => {
      const out: number[] = [];
      for (const [i, r] of b.rows.entries()) {
        const m = machines.find((x) => (r.machine_id && Number(x.id) === r.machine_id) || (r.machine_code && x.machine_code === r.machine_code));
        if (!m) throw BadRequest(`Row ${i + 1}: machine ${r.machine_code ?? r.machine_id} not found`);
        const from = sqlDateTime(r.reading_from); const to = sqlDateTime(r.reading_to);
        if (to <= from) throw BadRequest(`Row ${i + 1}: reading end must be after the start`);
        const dup = await txQueryOne(tx, `SELECT id FROM trx_mp_machine_counter WHERE machine_id = ? AND reading_from = ? AND reading_to = ?`, [m.id, from, to]);
        if (dup) throw BadRequest(`Row ${i + 1}: a reading for ${m.machine_code} ${from} – ${to} is already imported`);
        const ins = await txExecute(tx,
          `INSERT INTO trx_mp_machine_counter (company_id, machine_id, reading_from, reading_to, stitches, pieces, run_minutes, machine_status, source_ref, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`, [cid, m.id, from, to, r.stitches ?? null, r.pieces ?? null, r.run_minutes ?? null, r.machine_status ?? null, r.source_ref ?? null, req.user!.id]);
        out.push(ins.insertId);
      }
      return out;
    });
    res.status(201).json({ data: { imported: ids.length, ids } });
  }));
  router.get('/machine-counter', requirePermission(P('VIEW')), ah(async (req, res) => {
    const cid = req.user!.companyId;
    const where = ['c.company_id = ?', 'm.process_kind = ?'];
    const params: unknown[] = [cid, kind];
    if (req.query.machine_id) { where.push('c.machine_id = ?'); params.push(Number(req.query.machine_id)); }
    if (req.query.unlinked === '1') where.push('c.production_id IS NULL');
    if (req.query.from) { where.push('c.reading_from >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { where.push('c.reading_from <= ?'); params.push(`${req.query.to} 23:59:59`); }
    const rows = await query(
      `SELECT c.id, c.machine_id, m.machine_code, ${dt('c.reading_from', 'reading_from')}, ${dt('c.reading_to', 'reading_to')}, c.stitches, c.pieces, c.run_minutes,
              c.machine_status, c.source_ref, c.production_id, p.production_no
         FROM trx_mp_machine_counter c JOIN mst_mp_machine m ON m.id = c.machine_id LEFT JOIN trx_mp_production p ON p.id = c.production_id
        WHERE ${where.join(' AND ')} ORDER BY c.reading_from DESC LIMIT 1000`, params);
    res.json({ data: rows });
  }));
}
