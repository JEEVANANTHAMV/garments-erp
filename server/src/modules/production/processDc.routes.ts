import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import {
  lockBundle, applyBundle, addMovement, availAt, bundleAvail, resolveBundleIds, ironingRequiresChecking, ironingAvail,
  TERMINAL, type BundleRow, type Counter, type Level,
} from './bundleLedger.js';
import {
  linkProcOf, openLineAllocations, releaseLineAllocation, restoreLineAllocations,
  sourceProcOf, lineInfo, lineOpenBundles, recordLineOutput, stitchDcPending, type LinkProc,
} from './lineAllocationLink.js';
import { postBundleSewingOutput, postCheckingQc } from './productionFloor.routes.js';

/**
 * PCS a bundle can put on a DC that carries a line's output: what the stage
 * already has (base) plus what the DC may post as that line's output first
 * (room): sewing WIP / cut panels for a sewing line, PCS waiting for checking
 * for a checking line (strict checking). Ironing lines post their output on
 * the floor, so no room there.
 */
function fromLineAvail(b: BundleRow, st: StageInfo, src: LinkProc, strictChk: boolean, atContractor = 0) {
  const a = bundleAvail({ ...b, balance_qty: b.balance_qty ?? b.qty });
  const base = strictChk ? a.checked : availAt(b, st.level);
  if (src === 'sewing' && st.level === 'SEWN') return { base, room: Math.max(a.cut + a.sewing_wip - atContractor, 0) };
  if (src === 'checking' && strictChk) return { base, room: a.checking };
  return { base, room: 0 };
}
type FromLine = { proc: LinkProc; lineId: number; line: { line_code: string; line_name: string } };

async function resolveFromLine(tx: Tx | null, cid: number, st: StageInfo, lineId: number | null | undefined): Promise<FromLine | null> {
  if (!lineId) return null;
  const proc = sourceProcOf(st);
  if (!proc) throw BadRequest(`${st.stage_name} does not follow an in-house line — "From line" is for checking, washing, ironing and packing DCs`);
  const line = await lineInfo(tx, cid, proc, lineId);
  if (!line) throw BadRequest(`${proc} line #${lineId} not found`);
  return { proc, lineId, line };
}
import { contractorRates } from './processMaster.routes.js';

/**
 * Process DCs with bundle numbers (client voice note 1, doc §15, §19, §20).
 *
 * A job-work delivery challan (trx_jobwork_challan) for Stitching, Ironing,
 * Packing or any other outsourced process lists one line per bundle. Issuing
 * the DC moves the bundle PCS to the vendor through the bundle ledger; the
 * receipt against the DC brings back good / reject / shortage per bundle.
 * Posted DCs are never deleted — they are cancelled (no receipts yet) or
 * closed short with a reason.
 *
 *   Stitching (STITCH)          cut balance  → sewing in; receipt good = sewn good
 *   Ironing / Finishing         sewn good    → finishing in; receipt good = finished good
 *   Packing (PACK)              finished PCS → out to packer and back (round trip)
 *   Print / Embroidery (before stitching)   cut panels out and back (round trip)
 *   Washing etc. (after stitching)          sewn PCS out and back (round trip)
 */
export const processDcRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const reasonReq = z.string().trim().min(3, 'Give a reason (min 3 characters)').max(255);

type DcKind = 'SEWING' | 'FINISHING' | 'ROUNDTRIP';
interface StageInfo { id: number; stage_code: string; stage_name: string; sort_order: number; kind: DcKind; level: Level }

const SEW_CODES = ['STITCH', 'STITCHING', 'SEW', 'SEWING'];
const FIN_CODES = ['IRON', 'IRONING', 'FINISH', 'FINISHING', 'PRESS'];
const PACK_CODES = ['PACK', 'PACKING'];
const FABRIC_CODES = ['KNIT', 'KNITTING', 'DYE', 'DYEING', 'CUT', 'CUTTING', 'COMPACT', 'COMPACTING'];

function classify(st: any, stitchSort: number): StageInfo | null {
  const code = String(st.stage_code).toUpperCase();
  const base = { id: Number(st.id), stage_code: st.stage_code, stage_name: st.stage_name, sort_order: n(st.sort_order) };
  if (FABRIC_CODES.includes(code)) return null;
  if (SEW_CODES.includes(code)) return { ...base, kind: 'SEWING', level: 'CUT' };
  if (FIN_CODES.includes(code)) return { ...base, kind: 'FINISHING', level: 'SEWN' };
  if (PACK_CODES.includes(code)) return { ...base, kind: 'ROUNDTRIP', level: 'PACK' };
  return { ...base, kind: 'ROUNDTRIP', level: n(st.sort_order) < stitchSort ? 'CUT' : 'SEWN' };
}

async function bundleStages(cid: number): Promise<StageInfo[]> {
  const rows = await query<any>(
    `SELECT id, stage_code, stage_name, sort_order FROM cfg_process_stage WHERE company_id = ? AND is_active = 1 ORDER BY sort_order, id`, [cid]);
  const stitch = rows.find((r) => SEW_CODES.includes(String(r.stage_code).toUpperCase()));
  const stitchSort = stitch ? n(stitch.sort_order) : 1e9;
  return rows.map((r) => classify(r, stitchSort)).filter(Boolean) as StageInfo[];
}

async function stageInfo(cid: number, stageId: number): Promise<StageInfo> {
  const st = (await bundleStages(cid)).find((x) => x.id === Number(stageId));
  if (!st) throw BadRequest('Choose a bundle process (Stitching, Ironing, Packing, Printing …) — fabric stages cannot take bundle DCs');
  return st;
}

/** Ledger deltas for issuing q PCS on a DC of this stage. */
function issueDelta(st: StageInfo, q: number): Partial<Record<Counter, number>> {
  if (st.kind === 'SEWING') return { balance_qty: -q, sew_in_qty: q };
  if (st.kind === 'FINISHING') return { fin_in_qty: q };
  if (st.level === 'CUT') return { balance_qty: -q, out_cut_qty: q };
  if (st.level === 'SEWN') return { out_sewn_qty: q };
  return { out_pack_qty: q };
}
function receiptDelta(st: StageInfo, good: number, loss: number): Partial<Record<Counter, number>> {
  if (st.kind === 'SEWING') return { sew_good_qty: good, sew_reject_qty: loss };
  if (st.kind === 'FINISHING') return { fin_good_qty: good, fin_reject_qty: loss };
  if (st.level === 'CUT') return { out_cut_qty: -(good + loss), balance_qty: good, cut_loss_qty: loss };
  if (st.level === 'SEWN') return { out_sewn_qty: -(good + loss), sewn_loss_qty: loss };
  return { out_pack_qty: -(good + loss), pack_loss_qty: loss };
}
const negate = (d: Partial<Record<Counter, number>>) =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, -(v as number)])) as Partial<Record<Counter, number>>;

const LEVEL_LABEL: Record<Level, string> = {
  CUT: 'cut PCS at cutting', SEWN: 'sewn good PCS', FIN: 'finished PCS awaiting QC', PACK: 'finished PCS ready to pack',
};

/** Open DC lines of a stage still holding a bundle (draft qty or pending receipt). */
async function openDcHolds(runner: Tx | null, cid: number, stageId: number, bundleIds: number[], excludeChallanId?: number) {
  if (!bundleIds.length) return new Map<number, string>();
  const sql = `SELECT jl.bundle_id, jc.challan_no FROM trx_jobwork_challan_line jl
                 JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id
                WHERE jc.company_id = ? AND jc.stage_id = ? AND jc.status IN ('DRAFT','ISSUED','PARTIAL_RECEIVED')
                  AND jl.bundle_id IN (?) AND jc.id <> ?
                  AND (jc.status = 'DRAFT' OR jl.qty > jl.received_qty + jl.rejected_qty + jl.shortage_qty)`;
  const params = [cid, stageId, bundleIds, excludeChallanId ?? 0];
  const rows = runner ? await txQuery<any>(runner, sql, params) : await query<any>(sql, params);
  return new Map(rows.map((r) => [Number(r.bundle_id), String(r.challan_no)]));
}

interface JobInfo { io_no: string; so_id: number; so_no: string | null; order_type: string | null; buyer_name: string | null; buyer_po_no: string | null }

/** Buyer / buyer PO / SO of each job (IO no) — one DC can carry several jobs. */
export async function jobInfo(cid: number, ioNos: (string | null | undefined)[]) {
  const ios = [...new Set(ioNos.filter((x): x is string => !!x))];
  if (!ios.length) return new Map<string, JobInfo>();
  // The SO is found by its own IO no, else through the cutting plan / production order of that IO.
  const rows = await query<any>(
    `SELECT x.io_no, so.id AS so_id, so.so_no, so.order_type, so.buyer_po_no, p.party_name AS buyer_name, x.pri
       FROM (SELECT io_no, id AS so_id, 1 AS pri FROM trx_sales_order WHERE company_id = ? AND io_no IN (?)
             UNION ALL
             SELECT io_no, so_id, 2 FROM trx_cutting_plan WHERE company_id = ? AND io_no IN (?) AND so_id IS NOT NULL
             UNION ALL
             SELECT io_no, so_id, 3 FROM trx_production_order WHERE company_id = ? AND io_no IN (?) AND so_id IS NOT NULL) x
       JOIN trx_sales_order so ON so.id = x.so_id AND so.is_deleted = 0
       LEFT JOIN mst_party p ON p.id = so.buyer_id
      ORDER BY x.pri, so.id DESC`, [cid, ios, cid, ios, cid, ios]);
  const out = new Map<string, JobInfo>();
  for (const r of rows) if (!out.has(r.io_no)) out.set(r.io_no, r);
  return out;
}

/** Assort colour of each job + style + colour, from the sales order lines ("colour and assort colour both should come"). */
async function assortColors(jobs: Map<string, JobInfo>, rows: { io_no?: string | null; style_id?: number | null; color_id?: number | null }[]) {
  const soIds = [...new Set([...jobs.values()].map((j) => j.so_id))];
  const out = new Map<string, string>();
  if (!soIds.length) return out;
  const lines = await query<any>(
    `SELECT so_id, style_id, color_id, assort_color FROM trx_sales_order_line
      WHERE so_id IN (?) AND assort_color IS NOT NULL AND assort_color <> '' ORDER BY id`, [soIds]);
  for (const r of rows) {
    const j = r.io_no ? jobs.get(r.io_no) : undefined;
    if (!j) continue;
    const hit = lines.find((l) => Number(l.so_id) === Number(j.so_id) && Number(l.style_id) === Number(r.style_id)
      && (l.color_id == null || Number(l.color_id) === Number(r.color_id)));
    if (hit) out.set(`${r.io_no}|${r.style_id}|${r.color_id}`, hit.assort_color);
  }
  return out;
}
const assortKey = (r: { io_no?: string | null; style_id?: number | null; color_id?: number | null }) => `${r.io_no}|${r.style_id}|${r.color_id}`;

// ============================================================
// Lookups
// ============================================================
processDcRouter.get('/process-dcs/stages', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const stages = await bundleStages(req.user!.companyId);
  res.json({ data: stages.map((st) => ({ ...st, source: LEVEL_LABEL[st.level] })) });
}));

const availQuery = z.object({
  level: z.enum(['CUT', 'SEWN', 'FIN', 'PACK']).optional(),
  stage_id: z.coerce.number().int().positive().optional(),
  io_no: z.string().trim().max(40).optional(),
  cutting_plan_id: z.coerce.number().int().positive().optional(),
  lay_id: z.coerce.number().int().positive().optional(),
  style_id: z.coerce.number().int().positive().optional(),
  color_id: z.coerce.number().int().positive().optional(),
  size_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(120).optional(),
  include_zero: z.coerce.boolean().optional(),
  // Only bundles allocated to this line of the process before the stage (DC carries its output).
  from_line_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

/** Contractors for DCs: job workers (vendors) and in-house contractors. */
processDcRouter.get('/process-dcs/contractors', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const rows = await query<any>(
    `SELECT id, party_code AS code, party_name AS label, is_contractor, is_vendor
       FROM mst_party WHERE company_id = ? AND (is_vendor = 1 OR is_contractor = 1) AND is_active = 1 AND is_deleted = 0
      ORDER BY is_contractor DESC, party_name`, [req.user!.companyId]);
  res.json({ data: rows.map((r) => ({ ...r, label: r.is_contractor ? `${r.label} (in-house)` : r.label })) });
}));

/**
 * GET /bundle-stock/available — bundle picker for DCs and the floor.
 *   level=CUT|SEWN|FIN|PACK  or  stage_id (level from the stage; flags bundles on another open DC of it)
 *   io_no, cutting_plan_id, lay_id, style_id, color_id, size_id, q (bundle no / barcode), limit
 */
processDcRouter.get('/bundle-stock/available', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const qp = availQuery.parse(req.query);
  res.json(await availableBundles(cid, qp));
}));

/**
 * GET /bundle-stock/available-jobs?stage_id= — jobs (IO no) with bundles ready
 * for the process, for "Add job" on a multi-job DC.
 */
processDcRouter.get('/bundle-stock/available-jobs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const qp = availQuery.parse({ ...req.query, limit: 5000 });
  const { data, meta } = await availableBundles(cid, qp);
  const jobs = new Map<string, any>();
  for (const b of data) {
    const key = b.io_no ?? '—';
    if (!jobs.has(key)) {
      jobs.set(key, {
        io_no: b.io_no, style_codes: new Set<string>(), buyer_name: b.buyer_name, buyer_po_no: b.buyer_po_no,
        bundles: 0, free_bundles: 0, qty: 0,
      });
    }
    const j = jobs.get(key);
    if (b.style_code) j.style_codes.add(b.style_code);
    j.bundles++;
    if (!b.open_dc_no) { j.free_bundles++; j.qty += b.available_qty; }
  }
  res.json({
    data: [...jobs.values()].map((j) => ({ ...j, style_codes: [...j.style_codes] }))
      .sort((a, b) => String(a.io_no).localeCompare(String(b.io_no))),
    meta,
  });
}));

async function availableBundles(cid: number, qp: z.infer<typeof availQuery>, onlyIds?: number[]) {
  const st = qp.stage_id ? await stageInfo(cid, qp.stage_id) : null;
  const level: Level = st?.level ?? qp.level ?? 'CUT';
  const fromLine = st && qp.from_line_id ? await resolveFromLine(null, cid, st, qp.from_line_id) : null;
  const lineOpen = fromLine ? await lineOpenBundles(null, cid, fromLine.proc, fromLine.lineId) : null;
  if (lineOpen) {
    const ids = [...lineOpen.keys()].filter((id) => !onlyIds || onlyIds.includes(id));
    if (!ids.length) return { data: [], meta: { level, stage: st, from_line: fromLine } };
    onlyIds = ids;
  }

  const where = ['COALESCE(cb.company_id, c.company_id) = ?', `cb.status NOT IN (${TERMINAL.map(() => '?').join(',')})`];
  const params: unknown[] = [cid, ...TERMINAL];
  if (onlyIds?.length) { where.push(`cb.id IN (${onlyIds.map(() => '?').join(',')})`); params.push(...onlyIds); }
  if (qp.io_no) { where.push('cb.io_no = ?'); params.push(qp.io_no); }
  if (qp.cutting_plan_id) {
    where.push('COALESCE(co.cutting_plan_id, lp.cutting_plan_id, c.cutting_plan_id) = ?'); params.push(qp.cutting_plan_id);
  }
  if (qp.lay_id) { where.push('COALESCE(cb.lay_id, c.lay_id) = ?'); params.push(qp.lay_id); }
  if (qp.style_id) { where.push('cb.style_id = ?'); params.push(qp.style_id); }
  if (qp.color_id) { where.push('cb.color_id = ?'); params.push(qp.color_id); }
  if (qp.size_id) { where.push('cb.size_id = ?'); params.push(qp.size_id); }
  if (qp.q) { where.push('(cb.bundle_no LIKE ? OR cb.barcode LIKE ?)'); params.push(`%${qp.q}%`, `%${qp.q}%`); }
  if (!qp.include_zero && !lineOpen) {
    where.push(level === 'CUT' ? 'cb.balance_qty > 0' : level === 'SEWN' ? 'cb.sew_good_qty > 0' : 'cb.fin_good_qty > 0');
  }
  const rows = await query<any>(
    `SELECT cb.*, st.style_code, col.color_name, sz.size_code, sz.sort_order AS size_sort,
            lp.lay_no, c.cut_no, cp.plan_no, COALESCE(co.cutting_plan_id, lp.cutting_plan_id, c.cutting_plan_id) AS cutting_plan_id_resolved
       FROM trx_cutting_bundle cb
       LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
       LEFT JOIN trx_cut_output co ON co.id = cb.cut_output_id
       LEFT JOIN trx_lay_plan lp ON lp.id = COALESCE(cb.lay_id, c.lay_id)
       LEFT JOIN trx_cutting_plan cp ON cp.id = COALESCE(co.cutting_plan_id, lp.cutting_plan_id, c.cutting_plan_id)
       LEFT JOIN mst_style st ON st.id = cb.style_id
       LEFT JOIN mst_color col ON col.id = cb.color_id
       LEFT JOIN mst_size sz ON sz.id = cb.size_id
      WHERE ${where.join(' AND ')}
      ORDER BY col.color_name, sz.sort_order, sz.size_code, cb.bundle_seq, cb.id
      LIMIT ${qp.limit}`, params);
  const strictChk = st?.kind === 'FINISHING' && await ironingRequiresChecking(null, cid);
  const holds = st ? await openDcHolds(null, cid, st.id, rows.map((r) => Number(r.id))) : new Map();
  const linkProc = st ? linkProcOf(st) : null;
  const lineAllocs = linkProc ? await openLineAllocations(null, cid, linkProc, rows.map((r) => Number(r.id))) : new Map();
  const contractorPending = fromLine?.proc === 'sewing' ? await stitchDcPending(null, cid, rows.map((r) => Number(r.id))) : new Map<number, number>();
  const jobs = await jobInfo(cid, rows.map((r) => r.io_no));
  const assort = await assortColors(jobs, rows);
  const data = rows.map((b) => ({
    id: b.id, bundle_no: b.bundle_no, barcode: b.barcode, io_no: b.io_no, part_name: b.part_name,
    style_id: b.style_id, style_code: b.style_code, color_id: b.color_id, color_name: b.color_name,
    size_id: b.size_id, size_code: b.size_code, size_sort: b.size_sort, qty: b.qty, status: b.status,
    lay_no: b.lay_no, cut_no: b.cut_no, plan_no: b.plan_no, cutting_plan_id: b.cutting_plan_id_resolved,
    buyer_name: jobs.get(b.io_no)?.buyer_name ?? null, buyer_po_no: jobs.get(b.io_no)?.buyer_po_no ?? null,
    assort_color: assort.get(assortKey(b)) ?? null,
    available_qty: fromLine
      ? (() => { const f = fromLineAvail(b, st!, fromLine.proc, strictChk, contractorPending.get(Number(b.id)) ?? 0); return f.base + f.room; })()
      : strictChk ? ironingAvail(b, true) : availAt(b, level),
    avail: bundleAvail(b), open_dc_no: holds.get(Number(b.id)) ?? null,
    line_alloc: lineAllocs.get(Number(b.id)) ?? null,
    from_line_open_qty: lineOpen?.get(Number(b.id))?.open_qty ?? null,
  })).filter((b) => qp.include_zero || b.available_qty > 0);
  return { data, meta: { level, stage: st, from_line: fromLine } };
}

// ============================================================
// DC list / detail
// ============================================================
processDcRouter.get('/process-dcs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['jc.company_id = ?'];
  const params: unknown[] = [cid];
  if (req.query.status === 'OPEN') where.push(`jc.status IN ('ISSUED','PARTIAL_RECEIVED')`);
  else if (req.query.status) { where.push('jc.status = ?'); params.push(String(req.query.status)); }
  if (req.query.stage_id) { where.push('jc.stage_id = ?'); params.push(Number(req.query.stage_id)); }
  if (req.query.vendor_id) { where.push('jc.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.io_no) {
    where.push('(jc.io_no = ? OR EXISTS (SELECT 1 FROM trx_jobwork_challan_line l3 WHERE l3.challan_id = jc.id AND l3.io_no = ?))');
    params.push(String(req.query.io_no), String(req.query.io_no));
  }
  if (req.query.from) { where.push('jc.challan_date >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('jc.challan_date <= ?'); params.push(String(req.query.to)); }
  if (req.query.q) {
    where.push(`(jc.challan_no LIKE ? OR EXISTS (SELECT 1 FROM trx_jobwork_challan_line l2 JOIN trx_cutting_bundle b2 ON b2.id = l2.bundle_id
                 WHERE l2.challan_id = jc.id AND (b2.bundle_no LIKE ? OR b2.barcode LIKE ?)))`);
    const q = `%${String(req.query.q)}%`;
    params.push(q, q, q);
  }
  const rows = await query(
    `SELECT jc.id, jc.challan_no, jc.challan_date, jc.status, jc.io_no, jc.expected_return, jc.vehicle_no, jc.vendor_id, jc.stage_id,
            jc.total_qty, jc.rate, jc.total_amount, jc.is_bundle_dc, jc.cancel_reason, jc.close_reason,
            v.party_name AS vendor_name, ps.stage_name, ps.stage_code, st.style_code,
            jc.ref_no, COUNT(DISTINCT jl.io_no) AS job_count, v.is_contractor,
            (SELECT GROUP_CONCAT(o.op_name ORDER BY o.sort_order SEPARATOR ', ') FROM trx_jobwork_challan_op co
               JOIN mst_process_operation o ON o.id = co.operation_id WHERE co.challan_id = jc.id) AS operations,
            GROUP_CONCAT(DISTINCT jl.io_no ORDER BY jl.io_no SEPARATOR ', ') AS io_list,
            SUM(jl.weight_kg) AS total_weight_kg,
            COUNT(jl.id) AS bundle_count, COALESCE(SUM(jl.qty),0) AS issued_pcs,
            COALESCE(SUM(jl.received_qty),0) AS received_pcs, COALESCE(SUM(jl.rejected_qty),0) AS rejected_pcs,
            COALESCE(SUM(jl.shortage_qty),0) AS shortage_pcs,
            COALESCE(SUM(jl.qty - jl.received_qty - jl.rejected_qty - jl.shortage_qty),0) AS pending_pcs
       FROM trx_jobwork_challan jc
       LEFT JOIN trx_jobwork_challan_line jl ON jl.challan_id = jc.id
       LEFT JOIN mst_party v ON v.id = jc.vendor_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
       LEFT JOIN mst_style st ON st.id = jc.style_id
      WHERE ${where.join(' AND ')}
      GROUP BY jc.id ORDER BY jc.challan_date DESC, jc.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

async function loadDc(cid: number, id: number) {
  const dc = await queryOne<any>(
    `SELECT jc.*, v.party_name AS vendor_name, v.party_code AS vendor_code, v.gstin AS vendor_gstin, v.phone AS vendor_phone,
            ps.stage_name, ps.stage_code, st.style_code, st.style_name, cp.plan_no,
            wf.warehouse_name AS from_location, wt.warehouse_name AS to_location,
            ui.full_name AS issued_by_name, uc.full_name AS cancelled_by_name, ucr.full_name AS created_by_name
       FROM trx_jobwork_challan jc
       LEFT JOIN mst_party v ON v.id = jc.vendor_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
       LEFT JOIN mst_warehouse wf ON wf.id = jc.from_warehouse_id
       LEFT JOIN mst_warehouse wt ON wt.id = jc.to_warehouse_id
       LEFT JOIN mst_style st ON st.id = jc.style_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = jc.cutting_plan_id
       LEFT JOIN mst_user ui ON ui.id = jc.issued_by
       LEFT JOIN mst_user uc ON uc.id = jc.cancelled_by
       LEFT JOIN mst_user ucr ON ucr.id = jc.created_by
      WHERE jc.id = ? AND jc.company_id = ?`, [id, cid]);
  if (!dc) throw NotFound('DC not found');
  const lines = await query<any>(
    `SELECT jl.*, cb.bundle_no, cb.barcode, cb.status AS bundle_status, cb.qty AS bundle_qty, cb.io_no AS bundle_io_no,
            COALESCE(jl.io_no, cb.io_no) AS job_io_no, lp.lay_no, c.cut_no, cb.status AS stock_stage, op.op_name AS operation_name,
            COALESCE(jl.part_name, cb.part_name) AS part, st.style_code, col.color_name, sz.size_code, sz.sort_order AS size_sort,
            (jl.qty - jl.received_qty - jl.rejected_qty - jl.shortage_qty) AS pending_qty,
            cb.balance_qty, cb.sew_in_qty, cb.sew_good_qty, cb.sew_reject_qty, cb.fin_in_qty, cb.fin_good_qty,
            cb.fin_reject_qty, cb.qc_pass_qty, cb.qc_reject_qty, cb.packed_qty, cb.cut_loss_qty, cb.sewn_loss_qty,
            cb.pack_loss_qty, cb.out_cut_qty, cb.out_sewn_qty, cb.out_pack_qty
       FROM trx_jobwork_challan_line jl
       LEFT JOIN trx_cutting_bundle cb ON cb.id = jl.bundle_id
       LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
       LEFT JOIN trx_lay_plan lp ON lp.id = COALESCE(cb.lay_id, c.lay_id)
       LEFT JOIN mst_style st ON st.id = COALESCE(jl.style_id, cb.style_id)
       LEFT JOIN mst_color col ON col.id = COALESCE(jl.color_id, cb.color_id)
       LEFT JOIN mst_size sz ON sz.id = COALESCE(jl.size_id, cb.size_id)
       LEFT JOIN mst_process_operation op ON op.id = jl.operation_id
      WHERE jl.challan_id = ?
      ORDER BY COALESCE(jl.io_no, cb.io_no), col.color_name, sz.sort_order, sz.size_code, cb.bundle_seq, jl.id`, [id]);
  const operations = await query<any>(
    `SELECT co.operation_id, co.rate, o.op_code, o.op_name FROM trx_jobwork_challan_op co
       JOIN mst_process_operation o ON o.id = co.operation_id WHERE co.challan_id = ? ORDER BY o.sort_order, o.op_name`, [id]);
  const receipts = await query<any>(
    `SELECT r.*, u.full_name AS created_by_name, w.warehouse_name AS to_location
       FROM trx_jobwork_receipt r LEFT JOIN mst_user u ON u.id = r.created_by
       LEFT JOIN mst_warehouse w ON w.id = r.to_warehouse_id
      WHERE r.challan_id = ? AND r.company_id = ? ORDER BY r.id`, [id, cid]);
  const rlines = receipts.length ? await query<any>(
    `SELECT rl.*, cb.bundle_no, op.op_name AS operation_name FROM trx_jobwork_receipt_line rl
       LEFT JOIN trx_cutting_bundle cb ON cb.id = rl.bundle_id LEFT JOIN mst_process_operation op ON op.id = rl.operation_id
      WHERE rl.receipt_id IN (?) ORDER BY rl.id`, [receipts.map((r) => r.id)]) : [];
  for (const r of receipts) r.lines = rlines.filter((l) => l.receipt_id === r.id);

  // Totals by colour → size (the DC print and screen group the same way).
  const byColor = new Map<string, { color_name: string; sizes: Map<string, any>; bundles: number; qty: number; pending: number }>();
  const sizeOrder = new Map<string, number>();
  for (const l of lines) {
    const ck = l.color_name ?? '—';
    const sk = l.size_code ?? '—';
    sizeOrder.set(sk, n(l.size_sort));
    if (!byColor.has(ck)) byColor.set(ck, { color_name: ck, sizes: new Map(), bundles: 0, qty: 0, pending: 0 });
    const c = byColor.get(ck)!;
    if (!c.sizes.has(sk)) c.sizes.set(sk, { size_code: sk, bundles: 0, qty: 0, pending: 0 });
    const z1 = c.sizes.get(sk);
    z1.bundles++; z1.qty += n(l.qty); z1.pending += n(l.pending_qty);
    c.bundles++; c.qty += n(l.qty); c.pending += n(l.pending_qty);
  }
  const sizes = [...sizeOrder.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const colors = [...byColor.values()].map((c) => ({
    color_name: c.color_name, bundles: c.bundles, qty: c.qty, pending: c.pending,
    sizes: sizes.map((sk) => c.sizes.get(sk) ?? { size_code: sk, bundles: 0, qty: 0, pending: 0 }),
  }));
  const sizeTotals = sizes.map((sk) => ({
    size_code: sk,
    bundles: colors.reduce((a, c) => a + (c.sizes.find((x) => x.size_code === sk)?.bundles ?? 0), 0),
    qty: colors.reduce((a, c) => a + (c.sizes.find((x) => x.size_code === sk)?.qty ?? 0), 0),
  }));
  const tally = (ls: any[]) => ({
    bundles: ls.length,
    qty: ls.reduce((a, l) => a + n(l.qty), 0),
    weight_kg: Math.round(ls.reduce((a, l) => a + n(l.weight_kg), 0) * 1000) / 1000,
    received: ls.reduce((a, l) => a + n(l.received_qty), 0),
    rejected: ls.reduce((a, l) => a + n(l.rejected_qty), 0),
    shortage: ls.reduce((a, l) => a + n(l.shortage_qty), 0),
    pending: ls.reduce((a, l) => a + Math.max(n(l.pending_qty), 0), 0),
  });
  const totals = tally(lines);

  // Job-wise sections (one DC can carry several jobs / styles / POs).
  const info = await jobInfo(cid, lines.map((l) => l.job_io_no));
  const assort = await assortColors(info, lines.map((l) => ({ io_no: l.job_io_no, style_id: l.style_id ?? null, color_id: l.color_id ?? null })));
  for (const l of lines) l.assort_color = assort.get(assortKey({ io_no: l.job_io_no, style_id: l.style_id, color_id: l.color_id })) ?? null;
  const jobKeys = [...new Set(lines.map((l) => l.job_io_no ?? '—'))];
  const jobs = jobKeys.map((k) => {
    const ls = lines.filter((l) => (l.job_io_no ?? '—') === k);
    const ji = info.get(k);
    return {
      io_no: k === '—' ? null : k, so_no: ji?.so_no ?? null, order_type: ji?.order_type ?? null, buyer_name: ji?.buyer_name ?? null,
      buyer_po_no: ji?.buyer_po_no ?? null, style_codes: [...new Set(ls.map((l) => l.style_code).filter(Boolean))],
      ...tally(ls),
    };
  });
  return { ...dc, lines, operations, receipts, summary: { sizes, colors, sizeTotals, totals, jobs } };
}

processDcRouter.get('/process-dcs/receipts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT r.*, jc.challan_no, jc.status AS dc_status, ps.stage_name, v.party_name AS vendor_name,
            (SELECT COUNT(*) FROM trx_jobwork_receipt_line rl WHERE rl.receipt_id = r.id) AS line_count,
            (SELECT GROUP_CONCAT(DISTINCT jl.io_no ORDER BY jl.io_no SEPARATOR ', ')
               FROM trx_jobwork_receipt_line rl JOIN trx_jobwork_challan_line jl ON jl.id = rl.challan_line_id
              WHERE rl.receipt_id = r.id) AS io_list
       FROM trx_jobwork_receipt r
       JOIN trx_jobwork_challan jc ON jc.id = r.challan_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
       LEFT JOIN mst_party v ON v.id = r.vendor_id
      WHERE r.company_id = ? ${req.query.group ? 'AND r.inward_group_no = ?' : ''}
      ORDER BY r.receipt_date DESC, r.id DESC LIMIT 500`, req.query.group ? [cid, String(req.query.group)] : [cid]);
  res.json({ data: rows });
}));

processDcRouter.get('/process-dcs/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  res.json({ data: await loadDc(req.user!.companyId, Number(req.params.id)) });
}));

/** Print data: DC + company + vendor address. */
processDcRouter.get('/process-dcs/:id/print', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const dc = await loadDc(cid, Number(req.params.id));
  const [company, vendorAddress] = await Promise.all([
    queryOne(`SELECT legal_name, trade_name, address_line1, address_line2, city, state, pincode, gstin, phone, email
                FROM mst_company WHERE id = ?`, [cid]),
    queryOne(`SELECT address_line1, address_line2, address_line3, city, state, pincode, phone, mobile
                FROM mst_party_address WHERE party_id = ? AND is_active = 1 ORDER BY is_default DESC, id LIMIT 1`, [dc.vendor_id]),
  ]);
  res.json({ data: { ...dc, company, vendor_address: vendorAddress } });
}));

// ============================================================
// Create / edit (draft) / issue
// ============================================================
const lineSchema = z.object({
  bundle_id: s.id(),
  barcode: s.nullableStr(120),
  qty: z.coerce.number().int().positive().nullish(),
  weight_kg: z.coerce.number().min(0).max(99999).nullish(),
  description: s.nullableStr(255),
  remarks: s.nullableStr(255),
  operation_id: s.id(),            // operation completed on the bundle (sample "Process Completed")
  operator_line: s.nullableStr(60),
});
const dcSchema = z.object({
  challan_no: s.nullableStr(40),
  challan_date: dateStr,
  stage_id: s.idReq(),
  vendor_id: s.idReq(),
  prod_order_id: s.id(),
  cutting_plan_id: s.id(),
  ref_no: s.nullableStr(60),
  from_warehouse_id: s.id(),
  to_warehouse_id: s.id(),
  expected_return: s.date(),
  rate: z.coerce.number().min(0).nullish(),
  vehicle_no: s.nullableStr(30),
  driver_name: s.nullableStr(80),
  transporter: s.nullableStr(120),
  gate_outward_id: s.id(),
  remarks: s.nullableStr(500),
  lines: z.array(lineSchema).min(1, 'Add at least one bundle').max(2000),
  operations: z.array(z.object({ operation_id: s.idReq(), rate: z.coerce.number().min(0).nullish() })).max(50).default([]),
  issue: z.coerce.boolean().default(false),
  // Bundles allocated to an in-house line may go on this DC only when their allocation is released.
  release_line_allocation: z.coerce.boolean().default(false),
  // Line of the previous process whose bundles this DC moves on (issuing = that line's output).
  from_line_id: z.coerce.number().int().positive().nullish(),
});

interface PreparedLine {
  bundle: BundleRow; qty: number; weight_kg: number | null; description: string | null; remarks: string | null;
  operation_id: number | null; operator_line: string | null;
}

/** Validate DC lines against bundle balances and other open DCs (bundles locked by the caller). */
async function prepareLines(tx: Tx, cid: number, st: StageInfo, lines: z.infer<typeof lineSchema>[], challanId?: number, releaseAlloc = false, fromLine: FromLine | null = null) {
  const ids: number[] = [];
  const byId = new Map<number, z.infer<typeof lineSchema>>();
  for (const l of lines) {
    const [id] = await resolveBundleIds(tx, cid, l.bundle_id ? [l.bundle_id] : [], l.barcode ? [l.barcode] : []);
    if (!id) throw BadRequest('Each DC line needs a bundle');
    if (byId.has(id)) throw BadRequest('The same bundle is listed twice on the DC');
    byId.set(id, l); ids.push(id);
  }
  ids.sort((a, b) => a - b);
  const holds = await openDcHolds(tx, cid, st.id, ids, challanId);
  const linkProc = linkProcOf(st);
  const lineAllocs = linkProc ? await openLineAllocations(tx, cid, linkProc, ids) : new Map();
  const strictChk = st.kind === 'FINISHING' && await ironingRequiresChecking(tx, cid);
  const unit = fromLine ? `PCS on ${fromLine.proc} line ${fromLine.line.line_code}`
    : strictChk ? 'checking-passed PCS (checking QC required before ironing)' : LEVEL_LABEL[st.level];
  const lineOpen = fromLine ? await lineOpenBundles(tx, cid, fromLine.proc, fromLine.lineId) : null;
  const contractorPending = fromLine?.proc === 'sewing' ? await stitchDcPending(tx, cid, ids) : new Map<number, number>();
  const out: PreparedLine[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    const b = await lockBundle(tx, cid, { id });
    const l = byId.get(id)!;
    if (TERMINAL.includes(b.status)) { problems.push(`${b.bundle_no} is ${b.status}`); continue; }
    if (!b.style_id) { problems.push(`${b.bundle_no} has no style`); continue; }
    if (holds.has(id)) { problems.push(`${b.bundle_no} is already on open ${st.stage_name} DC ${holds.get(id)}`); continue; }
    const la = lineAllocs.get(id);
    if (la && !releaseAlloc) {
      problems.push(`${b.bundle_no} is allocated to in-house ${linkProc} line ${la.line_code} (${la.allocation_no}, ${la.open_qty} PCS) — tick "Release in-house line allocation" to send it on this DC`);
      continue;
    }
    if (lineOpen && !lineOpen.has(id)) {
      problems.push(`${b.bundle_no} is not allocated to ${fromLine!.proc} line ${fromLine!.line.line_code}`);
      continue;
    }
    const avail = fromLine
      ? (() => { const f = fromLineAvail(b, st, fromLine.proc, strictChk, contractorPending.get(id) ?? 0); return f.base + f.room; })()
      : strictChk ? ironingAvail(b, true) : availAt(b, st.level);
    const qty = l.qty ?? avail;
    if (avail <= 0) { problems.push(`${b.bundle_no} has no ${unit}`); continue; }
    if (qty > avail) { problems.push(`${b.bundle_no}: ${qty} PCS requested, only ${avail} ${unit}`); continue; }
    out.push({
      bundle: b, qty, weight_kg: l.weight_kg ?? null, description: l.description ?? null, remarks: l.remarks ?? null,
      operation_id: l.operation_id ?? null, operator_line: l.operator_line ?? null,
    });
  }
  if (problems.length) {
    throw BadRequest(problems.length === 1 ? problems[0] : `${problems.length} bundles cannot go on this DC: ${problems.slice(0, 8).join('; ')}${problems.length > 8 ? ' …' : ''}`,
      problems.map((message) => ({ message })));
  }
  return out;
}

async function writeLines(tx: Tx, challanId: number, st: StageInfo, lines: PreparedLine[]) {
  for (const l of lines) {
    await txExecute(tx,
      `INSERT INTO trx_jobwork_challan_line
         (challan_id, sku_id, bundle_id, io_no, description, qty, weight_kg, style_id, color_id, size_id, part_name,
          source_level, remarks, operation_id, operator_line)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [challanId, l.bundle.sku_id ?? null, l.bundle.id, l.bundle.io_no ?? null,
       l.description ?? `Bundle ${l.bundle.bundle_no}`.slice(0, 255), l.qty, l.weight_kg,
       l.bundle.style_id ?? null, l.bundle.color_id ?? null, l.bundle.size_id ?? null,
       l.bundle.part_name ?? null, st.level, l.remarks, l.operation_id, l.operator_line]);
  }
}

function headerFrom(lines: PreparedLine[]) {
  const one = <T,>(vals: T[]) => (new Set(vals).size === 1 ? vals[0] : null);
  return {
    io_no: one(lines.map((l) => l.bundle.io_no ?? null)),
    style_id: one(lines.map((l) => l.bundle.style_id ?? null)),
    total_qty: lines.reduce((a, l) => a + l.qty, 0),
  };
}

/**
 * Operations the DC is sent for, with the agreed rate (entered, else the
 * contractor's rate, else the operation default). Their sum is the DC rate
 * unless a rate / PCS was typed in.
 */
async function resolveOps(cid: number, st: StageInfo, vendorId: number, ops: z.infer<typeof dcSchema>['operations']) {
  if (!ops.length) return [];
  const known = await contractorRates(cid, vendorId, st.id);
  return ops.map((o) => {
    const k = known.find((x) => Number(x.id) === o.operation_id);
    if (!k) throw BadRequest(`Operation ${o.operation_id} does not belong to ${st.stage_name}`);
    return { operation_id: o.operation_id, rate: o.rate ?? k.rate };
  });
}
async function writeOps(tx: Tx, challanId: number, ops: { operation_id: number; rate: number }[]) {
  await txExecute(tx, `DELETE FROM trx_jobwork_challan_op WHERE challan_id = ?`, [challanId]);
  for (const o of ops) {
    await txExecute(tx, `INSERT INTO trx_jobwork_challan_op (challan_id, operation_id, rate) VALUES (?,?,?)`, [challanId, o.operation_id, o.rate]);
  }
}
const opsRate = (ops: { rate: number }[]) => Math.round(ops.reduce((a, o) => a + n(o.rate), 0) * 10000) / 10000;

async function vendorCheck(cid: number, vendorId: number) {
  const v = await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0`, [vendorId, cid]);
  if (!v) throw BadRequest('Vendor not found');
}

/** Operations named on lines must be the company's. */
async function opsCheck(cid: number, ids: (number | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is number => !!x))];
  if (!want.length) return;
  const rows = await query<any>(`SELECT id FROM mst_process_operation WHERE company_id = ? AND id IN (?)`, [cid, want]);
  if (rows.length !== want.length) throw BadRequest('An operation on a line was not found');
}

async function locationCheck(cid: number, ...ids: (number | null | undefined)[]) {
  for (const wid of ids) {
    if (!wid) continue;
    const w = await queryOne(`SELECT id FROM mst_warehouse WHERE id = ? AND company_id = ?`, [wid, cid]);
    if (!w) throw BadRequest('Location (store) not found');
  }
}

/** Post an issued DC through the bundle ledger (bundles already locked in prepareLines). */
async function postIssue(tx: Tx, req: Request, dc: any, st: StageInfo, lines: PreparedLine[], vendorName: string, releaseAlloc = false, fromLine: FromLine | null = null) {
  const cid = req.user!.companyId;
  const lineRows = await txQuery<any>(tx, `SELECT id, bundle_id, qty FROM trx_jobwork_challan_line WHERE challan_id = ?`, [dc.id]);
  const linkProc = releaseAlloc ? linkProcOf(st) : null;
  const strictChk = st.kind === 'FINISHING' && await ironingRequiresChecking(tx, cid);
  const dcDate = String(dc.challan_date ?? new Date().toISOString()).slice(0, 10);
  for (const l of lines) {
    // DC from a line: PCS not yet posted as that line's output are posted now, then booked to its plan.
    if (fromLine) {
      const b0 = await lockBundle(tx, cid, { id: l.bundle.id });
      const short = l.qty - fromLineAvail(b0, st, fromLine.proc, strictChk).base;
      if (short > 0 && fromLine.proc === 'sewing') {
        await postBundleSewingOutput(tx, req, b0.id, {
          date: dcDate, line_name: fromLine.line.line_code, line_aliases: [fromLine.line.line_name],
          good: short, reject: 0, rework: 0, remarks: `Output on ${st.stage_name} DC ${dc.challan_no}`,
        });
      } else if (short > 0 && fromLine.proc === 'checking') {
        await postCheckingQc(tx, req, b0.id, {
          date: dcDate, line_name: fromLine.line.line_code, good: short, reject: 0, rework: 0,
          remarks: `Passed on ${st.stage_name} DC ${dc.challan_no}`,
        });
      }
      await recordLineOutput(tx, req, fromLine.proc, fromLine.lineId, b0.id, l.qty, dcDate, `${st.stage_name} DC ${dc.challan_no}`);
      l.bundle = await lockBundle(tx, cid, { id: b0.id });
    }
    // PCS leaving on the DC come off the bundle's in-house line allocation / daily plan.
    if (linkProc) await releaseLineAllocation(tx, req, linkProc, l.bundle.id, l.qty, `${st.stage_name} DC ${dc.challan_no}`, Number(dc.id));
    const after = await applyBundle(tx, l.bundle, issueDelta(st, l.qty));
    const lr = lineRows.find((r) => Number(r.bundle_id) === l.bundle.id);
    await addMovement(tx, req, l.bundle, {
      txn_type: 'DC_ISSUE', from_stage: l.bundle.status, to_stage: after.status, qty: l.qty, good: l.qty,
      destination: vendorName, location: st.stage_name, work_center: vendorName,
      ref_table: 'trx_jobwork_challan_line', ref_id: lr?.id ?? dc.id, remarks: `${st.stage_name} DC ${dc.challan_no}`,
    });
  }
  await txExecute(tx,
    `UPDATE trx_jobwork_challan SET status = 'ISSUED', issued_by = ?, issued_at = NOW(), updated_by = ? WHERE id = ?`,
    [req.user!.id, req.user!.id, dc.id]);
}

processDcRouter.post('/process-dcs', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = dcSchema.parse(req.body);
  const st = await stageInfo(cid, body.stage_id);
  await vendorCheck(cid, body.vendor_id);
  await locationCheck(cid, body.from_warehouse_id, body.to_warehouse_id);
  await opsCheck(cid, body.lines.map((l) => l.operation_id));
  const vendor = await queryOne<any>(`SELECT party_name FROM mst_party WHERE id = ?`, [body.vendor_id]);
  const ops = await resolveOps(cid, st, body.vendor_id, body.operations);
  if (body.rate == null && ops.length) body.rate = opsRate(ops);

  const id = await transaction(async (tx) => {
    const fromLine = await resolveFromLine(tx, cid, st, body.from_line_id);
    const lines = await prepareLines(tx, cid, st, body.lines, undefined, body.release_line_allocation, fromLine);
    const h = headerFrom(lines);
    const challanNo = body.challan_no || await nextDocNumber(tx, cid, 'JW_CHALLAN');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_jobwork_challan WHERE company_id = ? AND challan_no = ?`, [cid, challanNo]);
    if (dup) throw BadRequest(`DC no ${challanNo} already exists`);
    const r = await txExecute(tx,
      `INSERT INTO trx_jobwork_challan
         (company_id, challan_no, challan_date, prod_order_id, vendor_id, stage_id, gate_outward_id, total_qty, rate,
          total_amount, expected_return, status, remarks, io_no, cutting_plan_id, style_id, is_bundle_dc,
          vehicle_no, driver_name, transporter, ref_no, from_warehouse_id, to_warehouse_id, release_line_alloc,
          from_line_proc, from_line_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`,
      [cid, challanNo, body.challan_date, body.prod_order_id ?? null, body.vendor_id, st.id, body.gate_outward_id ?? null,
       h.total_qty, body.rate ?? null, body.rate != null ? Math.round(body.rate * h.total_qty * 100) / 100 : null,
       body.expected_return ?? null, body.remarks ?? null, h.io_no, body.cutting_plan_id ?? null, h.style_id,
       body.vehicle_no ?? null, body.driver_name ?? null, body.transporter ?? null, body.ref_no ?? null,
       body.from_warehouse_id ?? null, body.to_warehouse_id ?? null, body.release_line_allocation ? 1 : 0,
       fromLine?.proc ?? null, fromLine?.lineId ?? null, req.user!.id]);
    const dc = { id: r.insertId, challan_no: challanNo, challan_date: body.challan_date };
    await writeLines(tx, dc.id, st, lines);
    await writeOps(tx, dc.id, ops);
    if (body.issue) await postIssue(tx, req, dc, st, lines, vendor?.party_name ?? 'Vendor', body.release_line_allocation, fromLine);
    await audit(req, 'trx_jobwork_challan', dc.id, 'INSERT', undefined,
      { challan_no: challanNo, stage: st.stage_code, bundles: lines.length, qty: h.total_qty, issued: body.issue }, tx);
    return dc.id;
  });
  res.status(201).json({ data: await loadDc(cid, id) });
}));

processDcRouter.put('/process-dcs/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = dcSchema.parse(req.body);
  const st = await stageInfo(cid, body.stage_id);
  await vendorCheck(cid, body.vendor_id);
  await locationCheck(cid, body.from_warehouse_id, body.to_warehouse_id);
  await opsCheck(cid, body.lines.map((l) => l.operation_id));
  const vendor = await queryOne<any>(`SELECT party_name FROM mst_party WHERE id = ?`, [body.vendor_id]);
  const ops = await resolveOps(cid, st, body.vendor_id, body.operations);
  if (body.rate == null && ops.length) body.rate = opsRate(ops);

  await transaction(async (tx) => {
    const before = await txQueryOne<any>(tx, `SELECT * FROM trx_jobwork_challan WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!before) throw NotFound('DC not found');
    if (before.status !== 'DRAFT') throw BadRequest(`DC ${before.challan_no} is ${before.status} — only a draft DC can be edited`);
    const fromLine = await resolveFromLine(tx, cid, st, body.from_line_id);
    const lines = await prepareLines(tx, cid, st, body.lines, id, body.release_line_allocation, fromLine);
    const h = headerFrom(lines);
    await txExecute(tx,
      `UPDATE trx_jobwork_challan SET challan_date = ?, prod_order_id = ?, vendor_id = ?, stage_id = ?, gate_outward_id = ?,
              total_qty = ?, rate = ?, total_amount = ?, expected_return = ?, remarks = ?, io_no = ?, cutting_plan_id = ?,
              style_id = ?, vehicle_no = ?, driver_name = ?, transporter = ?, ref_no = ?, from_warehouse_id = ?,
              to_warehouse_id = ?, release_line_alloc = ?, from_line_proc = ?, from_line_id = ?, updated_by = ?
        WHERE id = ?`,
      [body.challan_date, body.prod_order_id ?? null, body.vendor_id, st.id, body.gate_outward_id ?? null,
       h.total_qty, body.rate ?? null, body.rate != null ? Math.round(body.rate * h.total_qty * 100) / 100 : null,
       body.expected_return ?? null, body.remarks ?? null, h.io_no, body.cutting_plan_id ?? null, h.style_id,
       body.vehicle_no ?? null, body.driver_name ?? null, body.transporter ?? null, body.ref_no ?? null,
       body.from_warehouse_id ?? null, body.to_warehouse_id ?? null, body.release_line_allocation ? 1 : 0,
       fromLine?.proc ?? null, fromLine?.lineId ?? null, req.user!.id, id]);
    // Draft lines have no ledger effect yet, so replacing them is safe.
    await txExecute(tx, `DELETE FROM trx_jobwork_challan_line WHERE challan_id = ?`, [id]);
    await writeLines(tx, id, st, lines);
    await writeOps(tx, id, ops);
    if (body.issue) await postIssue(tx, req, { ...before, challan_date: body.challan_date }, st, lines, vendor?.party_name ?? 'Vendor', body.release_line_allocation, fromLine);
    await audit(req, 'trx_jobwork_challan', id, 'UPDATE', before,
      { bundles: lines.length, qty: h.total_qty, issued: body.issue }, tx);
  });
  res.json({ data: await loadDc(cid, id) });
}));

processDcRouter.post('/process-dcs/:id/issue', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  await transaction(async (tx) => {
    const dc = await txQueryOne<any>(tx,
      `SELECT jc.*, v.party_name AS vendor_name FROM trx_jobwork_challan jc LEFT JOIN mst_party v ON v.id = jc.vendor_id
        WHERE jc.id = ? AND jc.company_id = ? FOR UPDATE OF jc`, [id, cid]);
    if (!dc) throw NotFound('DC not found');
    if (dc.status !== 'DRAFT') throw BadRequest(`DC ${dc.challan_no} is already ${dc.status}`);
    const st = await stageInfo(cid, dc.stage_id);
    const cur = await txQuery<any>(tx, `SELECT bundle_id, qty, description, operation_id, operator_line FROM trx_jobwork_challan_line WHERE challan_id = ?`, [id]);
    if (!cur.length) throw BadRequest('DC has no bundles');
    if (cur.some((l) => !l.bundle_id)) throw BadRequest('This DC has lines without bundles — it was not created as a bundle DC');
    const lines = await prepareLines(tx, cid, st, cur.map((l) => ({
      bundle_id: l.bundle_id, qty: l.qty, description: l.description, operation_id: l.operation_id, operator_line: l.operator_line,
    })), id, !!dc.release_line_alloc, await resolveFromLine(tx, cid, st, dc.from_line_id));
    await postIssue(tx, req, dc, st, lines, dc.vendor_name ?? 'Vendor', !!dc.release_line_alloc, await resolveFromLine(tx, cid, st, dc.from_line_id));
    await audit(req, 'trx_jobwork_challan', id, 'UPDATE', { status: 'DRAFT' }, { status: 'ISSUED' }, tx);
  });
  res.json({ data: await loadDc(cid, id) });
}));

// ============================================================
// Cancel / close (never delete a posted DC)
// ============================================================
processDcRouter.post('/process-dcs/:id/cancel', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  const allocRestore = await transaction(async (tx) => {
    const dc = await txQueryOne<any>(tx, `SELECT * FROM trx_jobwork_challan WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!dc) throw NotFound('DC not found');
    let restored: any[] = [];
    if (!['DRAFT', 'ISSUED'].includes(dc.status)) {
      throw BadRequest(`DC ${dc.challan_no} is ${dc.status} — goods have been received against it; close it short instead`);
    }
    const rc = await txQueryOne<any>(tx, `SELECT COUNT(*) AS c FROM trx_jobwork_receipt WHERE challan_id = ?`, [id]);
    if (n(rc?.c)) throw BadRequest('Receipts exist against this DC — close it short instead of cancelling');
    if (dc.status === 'ISSUED') {
      const st = await stageInfo(cid, dc.stage_id);
      const lines = await txQuery<any>(tx, `SELECT * FROM trx_jobwork_challan_line WHERE challan_id = ? AND bundle_id IS NOT NULL ORDER BY bundle_id`, [id]);
      for (const l of lines) {
        const b = await lockBundle(tx, cid, { id: l.bundle_id });
        const after = await applyBundle(tx, b, negate(issueDelta(st, n(l.qty))));
        await addMovement(tx, req, b, {
          txn_type: 'DC_CANCEL', from_stage: b.status, to_stage: after.status, qty: n(l.qty),
          location: st.stage_name, ref_table: 'trx_jobwork_challan_line', ref_id: l.id,
          remarks: `DC ${dc.challan_no} cancelled: ${reason}`.slice(0, 255),
        });
      }
      // PCS are back in stock: give back the line allocation / plan this DC released.
      restored = await restoreLineAllocations(tx, req, id);
    }
    await txExecute(tx,
      `UPDATE trx_jobwork_challan SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW(), updated_by = ? WHERE id = ?`,
      [reason, req.user!.id, req.user!.id, id]);
    await audit(req, 'trx_jobwork_challan', id, 'UPDATE', { status: dc.status }, { status: 'CANCELLED', reason, allocation_restored: restored }, tx);
    return restored;
  });
  res.json({ data: { ...(await loadDc(cid, id)), allocation_restore: allocRestore } });
}));

// ============================================================
// Receipt against the DC — per bundle good / reject / shortage
// ============================================================
const receiptSchema = z.object({
  receipt_no: s.nullableStr(40),
  receipt_date: dateStr,
  gate_inward_id: s.id(),
  party_dc_no: s.nullableStr(60),
  party_dc_date: s.date(),
  to_warehouse_id: s.id(),
  vehicle_no: s.nullableStr(30),
  ref_no: s.nullableStr(60),
  inward_group_no: s.nullableStr(40),
  remarks: s.nullableStr(500),
  lines: z.array(z.object({
    line_id: s.id(),
    bundle_id: s.id(),
    barcode: s.nullableStr(120),
    received_qty: z.coerce.number().int().min(0).default(0),
    rejected_qty: z.coerce.number().int().min(0).default(0),
    shortage_qty: z.coerce.number().int().min(0).default(0),
    reject_reason: s.nullableStr(255),
    weight_kg: z.coerce.number().min(0).max(99999).nullish(),
    excess_qty: z.coerce.number().int().min(0).max(100000).default(0),
    operation_id: s.id(),
    operator_line: s.nullableStr(60),
    remarks: s.nullableStr(255),
  })).min(1).max(2000),
});

async function postReceipt(tx: Tx, req: Request, dc: any, body: z.infer<typeof receiptSchema>, kind: 'RECEIPT' | 'CLOSE_SHORT') {
  const cid = req.user!.companyId;
  const st = await stageInfo(cid, dc.stage_id);
  const dcLines = await txQuery<any>(tx, `SELECT * FROM trx_jobwork_challan_line WHERE challan_id = ? FOR UPDATE`, [dc.id]);

  // Resolve each receipt line to its DC line.
  const picked: {
    line: any; good: number; rej: number; short: number; reason: string | null; weight: number | null; remarks: string | null;
    excess: number; operation_id: number | null; operator_line: string | null;
  }[] = [];
  for (const rl of body.lines) {
    let line = rl.line_id ? dcLines.find((l) => Number(l.id) === Number(rl.line_id)) : null;
    if (!line && (rl.bundle_id || rl.barcode)) {
      const [bid] = await resolveBundleIds(tx, cid, rl.bundle_id ? [rl.bundle_id] : [], rl.barcode ? [rl.barcode] : []);
      line = dcLines.find((l) => Number(l.bundle_id) === bid);
      if (!line) throw BadRequest(`Bundle ${rl.barcode ?? rl.bundle_id} is not on DC ${dc.challan_no}`);
    }
    if (!line) throw BadRequest('Each receipt line needs the DC line or bundle');
    if (picked.some((p) => p.line.id === line.id)) throw BadRequest('A bundle is listed twice in the receipt');
    const total = rl.received_qty + rl.rejected_qty + rl.shortage_qty;
    const pending = n(line.qty) - n(line.received_qty) - n(line.rejected_qty) - n(line.shortage_qty);
    if (total === 0 && rl.excess_qty > 0) {
      const bno = (await txQueryOne<any>(tx, `SELECT bundle_no FROM trx_cutting_bundle WHERE id = ?`, [line.bundle_id]))?.bundle_no;
      throw BadRequest(`Bundle ${bno ?? line.id}: excess PCS can be entered only when all ${pending} pending PCS are received / rejected / short`);
    }
    if (total === 0) continue;
    if (total > pending) {
      const bno = (await txQueryOne<any>(tx, `SELECT bundle_no FROM trx_cutting_bundle WHERE id = ?`, [line.bundle_id]))?.bundle_no;
      throw BadRequest(`Bundle ${bno ?? line.id}: received + rejected + shortage (${total} PCS) exceeds the ${pending} PCS pending on the DC`);
    }
    // Excess = PCS returned beyond what was sent: recorded only (never enters the bundle ledger),
    // and only on a bundle whose pending PCS are fully accounted for in this inward.
    if (rl.excess_qty > 0 && total !== pending) {
      const bno = (await txQueryOne<any>(tx, `SELECT bundle_no FROM trx_cutting_bundle WHERE id = ?`, [line.bundle_id]))?.bundle_no;
      throw BadRequest(`Bundle ${bno ?? line.id}: excess PCS can be entered only when all ${pending} pending PCS are received / rejected / short`);
    }
    if (rl.rejected_qty > 0 && !rl.reject_reason?.trim()) {
      const bno = (await txQueryOne<any>(tx, `SELECT bundle_no FROM trx_cutting_bundle WHERE id = ?`, [line.bundle_id]))?.bundle_no;
      throw BadRequest(`Bundle ${bno ?? line.id}: give the mistake / reject reason for the ${rl.rejected_qty} rejected PCS`);
    }
    picked.push({
      line, good: rl.received_qty, rej: rl.rejected_qty, short: rl.shortage_qty,
      reason: rl.rejected_qty ? rl.reject_reason ?? null : null, weight: rl.weight_kg ?? null, remarks: rl.remarks ?? null,
      excess: rl.excess_qty, operation_id: rl.operation_id ?? null, operator_line: rl.operator_line ?? null,
    });
  }
  if (!picked.length) throw BadRequest('Enter received, rejected or shortage PCS for at least one bundle');
  picked.sort((a, b) => n(a.line.bundle_id) - n(b.line.bundle_id));

  const tot = picked.reduce((a, p) => ({ g: a.g + p.good, r: a.r + p.rej, s: a.s + p.short, i: a.i + n(p.line.qty), x: a.x + p.excess }), { g: 0, r: 0, s: 0, i: 0, x: 0 });
  const receiptNo = body.receipt_no || await nextDocNumber(tx, cid, 'JW_RECEIPT');
  const rr = await txExecute(tx,
    `INSERT INTO trx_jobwork_receipt
       (company_id, receipt_no, receipt_date, challan_id, vendor_id, gate_inward_id, issued_qty, received_qty,
        rejected_qty, shortage_qty, rework_qty, rate, total_amount, status, remarks, party_dc_no, party_dc_date,
        to_warehouse_id, vehicle_no, ref_no, inward_group_no, excess_qty, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,'RECEIVED',?,?,?,?,?,?,?,?,?)`,
    [cid, receiptNo, body.receipt_date, dc.id, dc.vendor_id, body.gate_inward_id ?? null, tot.i, tot.g, tot.r, tot.s,
     dc.rate ?? null, dc.rate != null ? Math.round(n(dc.rate) * tot.g * 100) / 100 : null,
     (kind === 'CLOSE_SHORT' ? `Closed short: ${body.remarks ?? ''}` : body.remarks ?? null),
     body.party_dc_no ?? null, body.party_dc_date ?? null, body.to_warehouse_id ?? null, body.vehicle_no ?? null,
     body.ref_no ?? null, body.inward_group_no ?? null, tot.x, req.user!.id]);

  for (const p of picked) {
    await txExecute(tx,
      `INSERT INTO trx_jobwork_receipt_line
         (receipt_id, challan_line_id, bundle_id, sku_id, issued_qty, received_qty, rejected_qty, shortage_qty,
          reject_reason, weight_kg, remarks, excess_qty, operation_id, operator_line)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rr.insertId, p.line.id, p.line.bundle_id ?? null, p.line.sku_id ?? null, n(p.line.qty), p.good, p.rej, p.short,
       p.reason, p.weight, p.remarks, p.excess, p.operation_id, p.operator_line]);
    await txExecute(tx,
      `UPDATE trx_jobwork_challan_line SET received_qty = received_qty + ?, rejected_qty = rejected_qty + ?, shortage_qty = shortage_qty + ? WHERE id = ?`,
      [p.good, p.rej, p.short, p.line.id]);
    if (p.line.bundle_id) {
      const b = await lockBundle(tx, cid, { id: p.line.bundle_id });
      const after = await applyBundle(tx, b, receiptDelta(st, p.good, p.rej + p.short));
      await addMovement(tx, req, b, {
        txn_type: kind === 'CLOSE_SHORT' ? 'DC_SHORT_CLOSE' : 'DC_RECEIPT', from_stage: b.status, to_stage: after.status,
        qty: p.good + p.rej + p.short, good: p.good, reject: p.rej + p.short,
        location: st.stage_name, work_center: dc.vendor_name ?? null,
        ref_table: 'trx_jobwork_receipt_line', ref_id: rr.insertId,
        remarks: `${receiptNo} vs DC ${dc.challan_no}${p.short ? ` · shortage ${p.short}` : ''}${p.reason ? ` · reject: ${p.reason}` : ''}${p.remarks ? ` · ${p.remarks}` : ''}`.slice(0, 255),
      });
    }
  }
  const left = await txQueryOne<any>(tx,
    `SELECT COALESCE(SUM(qty - received_qty - rejected_qty - shortage_qty),0) AS p FROM trx_jobwork_challan_line WHERE challan_id = ?`, [dc.id]);
  const status = kind === 'CLOSE_SHORT' ? 'CLOSED' : n(left?.p) === 0 ? 'FULLY_RECEIVED' : 'PARTIAL_RECEIVED';
  await txExecute(tx, `UPDATE trx_jobwork_challan SET status = ?, updated_by = ? WHERE id = ?`, [status, req.user!.id, dc.id]);
  await audit(req, 'trx_jobwork_receipt', rr.insertId, 'INSERT', undefined,
    { receipt_no: receiptNo, challan: dc.challan_no, received: tot.g, rejected: tot.r, shortage: tot.s, excess: tot.x, dc_status: status, group: body.inward_group_no ?? null }, tx);
  return { receipt_id: rr.insertId, receipt_no: receiptNo, dc_status: status };
}

processDcRouter.post('/process-dcs/:id/receipts', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = receiptSchema.parse(req.body);
  await locationCheck(cid, body.to_warehouse_id);
  await opsCheck(cid, body.lines.map((l) => l.operation_id));
  const out = await transaction(async (tx) => {
    const dc = await txQueryOne<any>(tx,
      `SELECT jc.*, v.party_name AS vendor_name FROM trx_jobwork_challan jc LEFT JOIN mst_party v ON v.id = jc.vendor_id
        WHERE jc.id = ? AND jc.company_id = ? FOR UPDATE OF jc`, [id, cid]);
    if (!dc) throw NotFound('DC not found');
    if (!['ISSUED', 'PARTIAL_RECEIVED'].includes(dc.status)) throw BadRequest(`DC ${dc.challan_no} is ${dc.status} — nothing to receive`);
    return postReceipt(tx, req, dc, body, 'RECEIPT');
  });
  res.status(201).json({ data: { ...out, dc: await loadDc(cid, id) } });
}));

/**
 * POST /process-dcs/receipts/batch — one inward (one party DC / vehicle) covering
 * several DCs of the same contractor (legacy "Select DC's"). Each DC gets its own
 * receipt so DC balances stay exact; all share one inward group no and post in a
 * single transaction (all or nothing).
 */
const batchSchema = receiptSchema.omit({ lines: true, inward_group_no: true, receipt_no: true }).extend({
  dcs: z.array(z.object({ challan_id: s.idReq(), lines: receiptSchema.shape.lines })).min(1).max(50),
});
processDcRouter.post('/process-dcs/receipts/batch', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = batchSchema.parse(req.body);
  const ids = body.dcs.map((d) => d.challan_id);
  if (new Set(ids).size !== ids.length) throw BadRequest('The same DC is listed twice in the inward');
  await locationCheck(cid, body.to_warehouse_id);
  await opsCheck(cid, body.dcs.flatMap((d) => d.lines.map((l) => l.operation_id)));
  const out = await transaction(async (tx) => {
    // Lock the DCs in id order so concurrent inwards cannot deadlock.
    const dcs = await txQuery<any>(tx,
      `SELECT jc.*, v.party_name AS vendor_name FROM trx_jobwork_challan jc LEFT JOIN mst_party v ON v.id = jc.vendor_id
        WHERE jc.company_id = ? AND jc.id IN (${ids.map(() => '?').join(',')}) ORDER BY jc.id FOR UPDATE OF jc`, [cid, ...ids]);
    if (dcs.length !== ids.length) throw NotFound('A DC in the inward was not found');
    if (new Set(dcs.map((d) => Number(d.vendor_id))).size > 1) throw BadRequest('One inward can only cover DCs of the same contractor');
    const closed = dcs.find((d) => !['ISSUED', 'PARTIAL_RECEIVED'].includes(d.status));
    if (closed) throw BadRequest(`DC ${closed.challan_no} is ${closed.status} — nothing to receive`);
    const groupNo = await nextDocNumber(tx, cid, 'JW_INWARD_GROUP');
    const results = [];
    for (const d of body.dcs) {
      const dc = dcs.find((x) => Number(x.id) === d.challan_id)!;
      results.push({ challan_id: dc.id, challan_no: dc.challan_no,
        ...(await postReceipt(tx, req, dc, { ...body, inward_group_no: groupNo, lines: d.lines } as any, 'RECEIPT')) });
    }
    return { inward_group_no: groupNo, receipts: results };
  });
  res.status(201).json({ data: out });
}));

/** GET /process-dcs/:id/audit — who did what on the DC and its inwards. */
processDcRouter.get('/process-dcs/:id/audit', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const dc = await queryOne<any>(`SELECT id FROM trx_jobwork_challan WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!dc) throw NotFound('DC not found');
  const receiptIds = (await query<any>(`SELECT id FROM trx_jobwork_receipt WHERE challan_id = ?`, [id])).map((r) => Number(r.id));
  const rows = await query<any>(
    `SELECT a.id, a.table_name, a.record_id, a.action, a.old_values, a.new_values, a.changed_at, u.full_name AS changed_by_name
       FROM log_audit a LEFT JOIN mst_user u ON u.id = a.changed_by
      WHERE a.company_id = ? AND ((a.table_name = 'trx_jobwork_challan' AND a.record_id = ?)
            ${receiptIds.length ? `OR (a.table_name = 'trx_jobwork_receipt' AND a.record_id IN (${receiptIds.map(() => '?').join(',')}))` : ''})
      ORDER BY a.changed_at DESC, a.id DESC LIMIT 500`, [cid, id, ...receiptIds]);
  const parse = (v: unknown) => { if (v == null || typeof v !== 'string') return v ?? null; try { return JSON.parse(v); } catch { return v; } };
  res.json({ data: rows.map((r) => ({ ...r, old_values: parse(r.old_values), new_values: parse(r.new_values) })) });
}));

// ------------------------------------------------------------------ attachments
const attachSchema = z.object({
  file_url: z.string().trim().min(1).max(300).refine((v) => v.startsWith('/uploads/'), 'Upload the file first (POST /uploads)'),
  file_name: s.nullableStr(200),
  mime_type: s.nullableStr(80),
  size_bytes: z.coerce.number().int().min(0).nullish(),
  doc_type: z.enum(['PARTY_DC', 'PHOTO', 'OTHER']).default('OTHER'),
  receipt_id: s.id(),
  remarks: s.nullableStr(255),
});

/** Attachments of a DC and its inwards (party DC scans, photos …). */
processDcRouter.get('/process-dcs/:id/attachments', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const rows = await query<any>(
    `SELECT d.*, u.full_name AS uploaded_by_name, r.receipt_no
       FROM trx_document_attachment d
       LEFT JOIN mst_user u ON u.id = d.uploaded_by
       LEFT JOIN trx_jobwork_receipt r ON d.ref_table = 'trx_jobwork_receipt' AND r.id = d.ref_id
      WHERE d.company_id = ? AND ((d.ref_table = 'trx_jobwork_challan' AND d.ref_id = ?)
            OR (d.ref_table = 'trx_jobwork_receipt' AND d.ref_id IN (SELECT id FROM trx_jobwork_receipt WHERE challan_id = ?)))
      ORDER BY d.uploaded_at DESC, d.id DESC`, [cid, id, id]);
  res.json({ data: rows });
}));

processDcRouter.post('/process-dcs/:id/attachments', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const b = attachSchema.parse(req.body);
  const dc = await queryOne<any>(`SELECT id FROM trx_jobwork_challan WHERE id = ? AND company_id = ?`, [id, cid]);
  if (!dc) throw NotFound('DC not found');
  if (b.receipt_id) {
    const r = await queryOne(`SELECT id FROM trx_jobwork_receipt WHERE id = ? AND challan_id = ?`, [b.receipt_id, id]);
    if (!r) throw BadRequest('That inward does not belong to this DC');
  }
  const r = await execute(
    `INSERT INTO trx_document_attachment (company_id, ref_table, ref_id, doc_type, file_url, file_name, mime_type, size_bytes, remarks, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [cid, b.receipt_id ? 'trx_jobwork_receipt' : 'trx_jobwork_challan', b.receipt_id ?? id, b.doc_type, b.file_url,
     b.file_name ?? null, b.mime_type ?? null, b.size_bytes ?? null, b.remarks ?? null, req.user!.id]);
  await audit(req, 'trx_jobwork_challan', id, 'UPDATE', undefined, { attachment_added: b.file_name ?? b.file_url, doc_type: b.doc_type });
  res.status(201).json({ data: { id: r.insertId } });
}));

processDcRouter.delete('/process-dcs/:id/attachments/:attId', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const att = await queryOne<any>(
    `SELECT d.* FROM trx_document_attachment d WHERE d.id = ? AND d.company_id = ?
        AND ((d.ref_table = 'trx_jobwork_challan' AND d.ref_id = ?)
          OR (d.ref_table = 'trx_jobwork_receipt' AND d.ref_id IN (SELECT id FROM trx_jobwork_receipt WHERE challan_id = ?)))`,
    [Number(req.params.attId), cid, id, id]);
  if (!att) throw NotFound('Attachment not found');
  await execute(`DELETE FROM trx_document_attachment WHERE id = ?`, [att.id]);
  await audit(req, 'trx_jobwork_challan', id, 'UPDATE', { attachment: att.file_name ?? att.file_url }, { attachment_removed: true });
  res.json({ data: { id: att.id } });
}));

/**
 * POST /process-dcs/resolve-bundles — "Import from Excel": a list of bundle nos /
 * barcodes checked against what the process can take. Returns each code as ready
 * (with the bundle, like the picker) or with the reason it cannot go on the DC.
 */
processDcRouter.post('/process-dcs/resolve-bundles', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = z.object({
    stage_id: s.idReq(),
    codes: z.array(z.string().trim().max(120)).min(1).max(2000),
    exclude_challan_id: s.id(),
  }).parse(req.body);
  const st = await stageInfo(cid, b.stage_id);
  const codes = [...new Set(b.codes.map((c) => c.trim()).filter(Boolean))];
  const rows = await query<any>(
    `SELECT cb.id, cb.bundle_no, cb.barcode FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      WHERE COALESCE(cb.company_id, c.company_id) = ? AND (cb.bundle_no IN (?) OR cb.barcode IN (?))`, [cid, codes, codes]);
  const byCode = new Map<string, number>();
  for (const r of rows) { byCode.set(String(r.bundle_no), Number(r.id)); if (r.barcode) byCode.set(String(r.barcode), Number(r.id)); }
  const avail = byCode.size
    ? (await availableBundles(cid, { stage_id: st.id, include_zero: true, limit: 5000 }, [...new Set(byCode.values())])).data
    : [];
  const holds = await openDcHolds(null, cid, st.id, [...new Set(byCode.values())], b.exclude_challan_id ?? undefined);
  const result = codes.map((code) => {
    const bid = byCode.get(code);
    if (!bid) return { code, ok: false, reason: 'Bundle not found' };
    const a = avail.find((x: any) => Number(x.id) === bid);
    if (!a) return { code, ok: false, reason: 'Bundle is closed / not active' };
    if (holds.has(bid)) return { code, ok: false, reason: `Already on open ${st.stage_name} DC ${holds.get(bid)}`, bundle: a };
    if (a.available_qty <= 0) return { code, ok: false, reason: `No ${LEVEL_LABEL[st.level]}`, bundle: a };
    return { code, ok: true, bundle: a };
  });
  res.json({ data: result, meta: { ready: result.filter((r) => r.ok).length, rejected: result.filter((r) => !r.ok).length } });
}));

/** Close an issued / partly received DC: every pending PCS is written off as shortage. */
processDcRouter.post('/process-dcs/:id/close', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason, receipt_date } = z.object({ reason: reasonReq, receipt_date: dateStr.optional() }).parse(req.body);
  await transaction(async (tx) => {
    const dc = await txQueryOne<any>(tx,
      `SELECT jc.*, v.party_name AS vendor_name FROM trx_jobwork_challan jc LEFT JOIN mst_party v ON v.id = jc.vendor_id
        WHERE jc.id = ? AND jc.company_id = ? FOR UPDATE OF jc`, [id, cid]);
    if (!dc) throw NotFound('DC not found');
    if (!['ISSUED', 'PARTIAL_RECEIVED'].includes(dc.status)) throw BadRequest(`DC ${dc.challan_no} is ${dc.status} — it cannot be closed short`);
    const pending = await txQuery<any>(tx,
      `SELECT id, (qty - received_qty - rejected_qty - shortage_qty) AS p FROM trx_jobwork_challan_line
        WHERE challan_id = ? AND qty > received_qty + rejected_qty + shortage_qty`, [id]);
    if (pending.length) {
      await postReceipt(tx, req, dc, {
        receipt_date: receipt_date ?? new Date().toISOString().slice(0, 10), remarks: reason,
        lines: pending.map((l) => ({ line_id: l.id, received_qty: 0, rejected_qty: 0, shortage_qty: n(l.p) })),
      } as any, 'CLOSE_SHORT');
    } else {
      await txExecute(tx, `UPDATE trx_jobwork_challan SET status = 'CLOSED' WHERE id = ?`, [id]);
    }
    await txExecute(tx, `UPDATE trx_jobwork_challan SET close_reason = ?, closed_by = ?, closed_at = NOW() WHERE id = ?`, [reason, req.user!.id, id]);
    await audit(req, 'trx_jobwork_challan', id, 'UPDATE', { status: dc.status }, { status: 'CLOSED', reason }, tx);
  });
  res.json({ data: await loadDc(cid, id) });
}));
