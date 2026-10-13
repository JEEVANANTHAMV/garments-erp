import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { requirePermission } from '../../middleware/auth.js';
import { bundleAvail, TERMINAL } from './bundleLedger.js';
import { DC_PENDING } from './processDc.routes.js';
import { rollCost } from '../stock/genealogy.routes.js';

/**
 * Process DC reports (client call 13-Oct-2026):
 *   • operation status — per process operation (Power Table, Singer, Trimming …): PCS sent, back good, lost, pending,
 *     so each operation can be followed on its own;
 *   • WIP stock value — where the job's PCS are (cutting, each store / unit / contractor, stitching WIP, stitched …)
 *     and their value = fabric (bundle weight × fabric cost / KG down its lineage) + cutting rate + the rates of the
 *     processes already done (contractor rate, or the internal rate on an in-house DC). Asked by the auditors.
 */
export const processDcReportsRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const r4 = (v: number) => Math.round((v + Number.EPSILON) * 10000) / 10000;

const statusQuery = z.object({
  stage_id: z.coerce.number().int().positive().optional(),
  io_no: z.string().trim().max(40).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** GET /process-dcs/operation-status — sent / good / lost / pending per process operation, job and colour. */
processDcReportsRouter.get('/process-dcs/operation-status', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = statusQuery.parse(req.query);
  const where = ['jc.company_id = ?', `jc.status NOT IN ('CANCELLED','DRAFT')`];
  const params: unknown[] = [cid];
  if (q.stage_id) { where.push('jc.stage_id = ?'); params.push(q.stage_id); }
  if (q.io_no) { where.push('COALESCE(jl.io_no, jc.io_no) = ?'); params.push(q.io_no); }
  if (q.from) { where.push('jc.challan_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('jc.challan_date <= ?'); params.push(q.to); }
  // a bundle's operation is its own (set on the line), else every operation the DC was sent for
  const rows = await query<any>(
    `SELECT ps.stage_name, COALESCE(o1.op_name, o2.op_name, '(no operation)') AS operation, COALESCE(o1.sort_order, o2.sort_order, 9999) AS op_sort,
            COALESCE(jl.io_no, jc.io_no) AS io_no, st.style_code, col.color_name,
            COUNT(DISTINCT jc.id) AS dcs, COUNT(DISTINCT jl.bundle_id) AS bundles,
            SUM(jl.qty) AS sent, SUM(jl.received_qty) AS good, SUM(jl.rejected_qty + jl.shortage_qty + jl.loss_qty) AS lost,
            SUM(jl.returned_qty) AS returned, SUM(${DC_PENDING('jl.')}) AS pending,
            GROUP_CONCAT(DISTINCT COALESCE(v.party_name, un.unit_name) ORDER BY 1 SEPARATOR ', ') AS sent_to
       FROM trx_jobwork_challan jc
       JOIN trx_jobwork_challan_line jl ON jl.challan_id = jc.id
       JOIN cfg_process_stage ps ON ps.id = jc.stage_id
       LEFT JOIN mst_process_operation o1 ON o1.id = jl.operation_id
       LEFT JOIN trx_jobwork_challan_op co ON jl.operation_id IS NULL AND co.challan_id = jc.id
       LEFT JOIN mst_process_operation o2 ON o2.id = co.operation_id
       LEFT JOIN mst_style st ON st.id = jl.style_id
       LEFT JOIN mst_color col ON col.id = jl.color_id
       LEFT JOIN mst_party v ON v.id = jc.vendor_id
       LEFT JOIN mst_unit un ON un.id = jc.unit_id
      WHERE ${where.join(' AND ')}
      GROUP BY ps.stage_name, operation, op_sort, io_no, st.style_code, col.color_name
      ORDER BY ps.stage_name, op_sort, io_no, col.color_name`, params);
  res.json({ data: rows.map((r) => ({ ...r, sent: n(r.sent), good: n(r.good), lost: n(r.lost), returned: n(r.returned), pending: n(r.pending) })) });
}));

/** Fabric cost per KG of a bundle: its lay's rolls (weighted by what each roll gave), else the job's fabric GRNs. */
async function fabricCostPerKg(cid: number, layIds: number[], soByIo: Map<string, number>) {
  const memo = new Map<number, any>();
  const byLay = new Map<number, number>();
  if (layIds.length) {
    const rolls = await query<any>(
      `SELECT lr.lay_id, lr.fabric_roll_id, COALESCE(NULLIF(lr.actual_consumed_kg, 0), lr.before_kg - lr.after_kg, 1) AS kg
         FROM trx_lay_roll lr WHERE lr.company_id = ? AND lr.lay_id IN (?) AND lr.fabric_roll_id IS NOT NULL`, [cid, layIds]);
    const acc = new Map<number, { v: number; kg: number }>();
    for (const r of rolls) {
      const c = await rollCost(cid, Number(r.fabric_roll_id), memo).catch(() => ({ cost_per_kg: 0 }));
      const kg = Math.max(n(r.kg), 0.0001);
      const a = acc.get(Number(r.lay_id)) ?? { v: 0, kg: 0 };
      a.v += c.cost_per_kg * kg; a.kg += kg;
      acc.set(Number(r.lay_id), a);
    }
    for (const [lay, a] of acc) if (a.kg > 0 && a.v > 0) byLay.set(lay, a.v / a.kg);
  }
  const byJob = new Map<string, number>();
  for (const [io, soId] of soByIo) {
    const g = await queryOne<any>(
      `SELECT SUM(gl.accepted_qty * gl.rate) / NULLIF(SUM(gl.accepted_qty), 0) AS r FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
        WHERE g.company_id = ? AND gl.so_id = ? AND gl.material_type = 'FABRIC' AND gl.rate > 0`, [cid, soId]);
    if (n(g?.r) > 0) byJob.set(io, n(g?.r));
  }
  return { byLay, byJob };
}

const valueQuery = z.object({
  io_no: z.string().trim().max(40).optional(),
  group_by: z.enum(['location', 'stage', 'job', 'detail']).default('location'),
});

/** GET /process-dcs/stock-value — PCS and value of open jobs by location / stage / job. */
processDcReportsRouter.get('/process-dcs/stock-value', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = valueQuery.parse(req.query);
  const where = [`COALESCE(cb.company_id, c.company_id) = ?`, `cb.status NOT IN (${TERMINAL.map(() => '?').join(',')})`];
  const params: unknown[] = [cid, ...TERMINAL];
  if (q.io_no) { where.push('cb.io_no = ?'); params.push(q.io_no); }
  const bundles = await query<any>(
    `SELECT cb.*, COALESCE(cb.lay_id, c.lay_id) AS lay_ref, st.style_code, col.color_name
       FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
       LEFT JOIN mst_style st ON st.id = cb.style_id LEFT JOIN mst_color col ON col.id = cb.color_id
      WHERE ${where.join(' AND ')} LIMIT 20000`, params);
  if (!bundles.length) return void res.json({ data: [], meta: { bundles: 0 } });
  const ids = bundles.map((b) => Number(b.id));

  // jobs → sales order (for the GRN fabric rate fallback)
  const ios = [...new Set(bundles.map((b) => b.io_no).filter(Boolean))];
  const sos = ios.length ? await query<any>(`SELECT id, COALESCE(NULLIF(io_no, ''), so_no) AS job FROM trx_sales_order WHERE company_id = ? AND (io_no IN (?) OR so_no IN (?)) AND is_deleted = 0`, [cid, ios, ios]) : [];
  const soByIo = new Map(sos.map((s) => [String(s.job), Number(s.id)]));
  const cost = await fabricCostPerKg(cid, [...new Set(bundles.map((b) => Number(b.lay_ref)).filter(Boolean))], soByIo);
  const cutRateRow = await queryOne<any>(`SELECT setting_value v FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'COSTING_CUTTING_RATE_PER_PC'`, [cid]);
  const cutRate = n(cutRateRow?.v);

  // DC lines of these bundles: done (received) processes add their rate; pending lines say where PCS are
  const dcl = await query<any>(
    `SELECT jl.bundle_id, jl.qty, jl.received_qty, ${DC_PENDING('jl.')} AS pending, jc.rate, jc.id AS challan_id, jc.challan_no,
            ps.stage_name, ps.stage_code, COALESCE(v.party_name, CONCAT(un.unit_name, ' (in-house)')) AS party, wt.warehouse_name AS to_store,
            jc.source_level, jl.id AS line_id
       FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id JOIN cfg_process_stage ps ON ps.id = jc.stage_id
       LEFT JOIN mst_party v ON v.id = jc.vendor_id LEFT JOIN mst_unit un ON un.id = jc.unit_id LEFT JOIN mst_warehouse wt ON wt.id = jc.to_warehouse_id
      WHERE jc.company_id = ? AND jc.status IN ('ISSUED','PARTIAL_RECEIVED','FULLY_RECEIVED','CLOSED') AND jl.bundle_id IN (?)
      ORDER BY jc.id`, [cid, ids]);
  // store each bundle's PCS came back to (last inward's to-location, else the DC's from-location)
  const back = await query<any>(
    `SELECT rl.bundle_id, COALESCE(w1.warehouse_name, w2.warehouse_name) AS store
       FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_receipt r ON r.id = rl.receipt_id JOIN trx_jobwork_challan jc ON jc.id = r.challan_id
       LEFT JOIN mst_warehouse w1 ON w1.id = r.to_warehouse_id LEFT JOIN mst_warehouse w2 ON w2.id = jc.from_warehouse_id
      WHERE r.company_id = ? AND rl.bundle_id IN (?) AND rl.received_qty > 0 ORDER BY r.id`, [cid, ids]);
  const storeOf = new Map<number, string>();
  for (const b of back) if (b.store) storeOf.set(Number(b.bundle_id), b.store);

  type Row = { location: string; stage: string; io_no: string; style_code: string; color_name: string; pcs: number; fabric: number; process: number };
  const out: Row[] = [];
  for (const b of bundles) {
    const bid = Number(b.id);
    const a = bundleAvail(b);
    const perPcKg = n(b.qty) > 0 ? n(b.allocated_kg) / n(b.qty) : 0;
    const kgRate = cost.byLay.get(Number(b.lay_ref)) ?? cost.byJob.get(b.io_no) ?? 0;
    const fabricPc = perPcKg * kgRate;
    const lines = dcl.filter((l) => Number(l.bundle_id) === bid);
    // processes done: rate of every DC the bundle came back from (good PCS)
    const donePc = lines.filter((l) => n(l.received_qty) > 0).reduce((s, l) => s + n(l.rate), 0);
    const base = { io_no: b.io_no ?? '—', style_code: b.style_code ?? '—', color_name: b.color_name ?? '—' };
    const add = (location: string, stage: string, pcs: number, extraPc = 0) => {
      if (pcs <= 0) return;
      out.push({ ...base, location, stage, pcs, fabric: fabricPc * pcs, process: (cutRate + donePc + extraPc) * pcs });
    };
    // PCS out at a process right now (pending on its DC) — at that unit / contractor
    let atStitchDc = 0; let atFinDc = 0;
    for (const l of lines) {
      const p = n(l.pending);
      if (p <= 0) continue;
      const code = String(l.stage_code).toUpperCase();
      if (['STITCH', 'STITCHING', 'SEW', 'SEWING'].includes(code) && (l.source_level ?? 'CUT') === 'CUT') atStitchDc += p;
      if (['IRON', 'IRONING', 'FINISH', 'FINISHING', 'PRESS'].includes(code)) atFinDc += p;
      add(l.party ?? 'Contractor', `At ${l.stage_name} (DC ${l.challan_no})`, p);
    }
    const store = storeOf.get(bid);
    add('Cutting', 'Cut panels (not issued)', a.cut);
    add(store ?? 'Stitching floor', 'Stitching in progress', a.sewing_wip - atStitchDc);
    add(store ?? 'Stitching store', 'Stitched (waiting checking / next process)', a.sewn);
    add(store ?? 'Finishing', 'Ironing / finishing in progress', a.finishing_wip - atFinDc);
    add(store ?? 'Finishing', 'Finished (QC / packing)', a.pack);
    add(store ?? 'Packing', 'Packed', n(b.packed_qty));
  }

  const key = (r: Row) => (q.group_by === 'location' ? `${r.location}` : q.group_by === 'stage' ? r.stage.replace(/ \(DC .*\)$/, '')
    : q.group_by === 'job' ? `${r.io_no}|${r.style_code}|${r.color_name}` : `${r.location}|${r.stage}|${r.io_no}|${r.style_code}|${r.color_name}`);
  const agg = new Map<string, Row & { jobs: Set<string> }>();
  for (const r of out) {
    const k = key(r);
    const x = agg.get(k) ?? { ...r, pcs: 0, fabric: 0, process: 0, jobs: new Set<string>(),
      stage: q.group_by === 'stage' ? r.stage.replace(/ \(DC .*\)$/, '') : r.stage };
    x.pcs += r.pcs; x.fabric += r.fabric; x.process += r.process; x.jobs.add(r.io_no);
    agg.set(k, x);
  }
  const data = [...agg.values()].map((x) => ({
    location: q.group_by === 'stage' || q.group_by === 'job' ? null : x.location,
    stage: q.group_by === 'location' || q.group_by === 'job' ? null : x.stage,
    io_no: q.group_by === 'job' || q.group_by === 'detail' ? x.io_no : null,
    style_code: q.group_by === 'job' || q.group_by === 'detail' ? x.style_code : null,
    color_name: q.group_by === 'job' || q.group_by === 'detail' ? x.color_name : null,
    jobs: x.jobs.size, pcs: x.pcs, fabric_value: r2(x.fabric), process_value: r2(x.process), total_value: r2(x.fabric + x.process),
    value_per_pc: x.pcs ? r4((x.fabric + x.process) / x.pcs) : null,
  })).sort((a, b) => b.total_value - a.total_value);
  res.json({ data, meta: { bundles: bundles.length, cutting_rate_per_pc: cutRate, group_by: q.group_by,
    note: 'Fabric = bundle weight × fabric cost/KG (lay rolls, else job fabric GRN rate) · process = cutting rate + rates of processes completed' } });
}));
