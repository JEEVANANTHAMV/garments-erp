import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import {
  lockBundle, applyBundle, addMovement, availAt, bundleAvail, resolveBundleIds,
  TERMINAL, type BundleRow, type Counter, type Level,
} from './bundleLedger.js';

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

// ============================================================
// Lookups
// ============================================================
processDcRouter.get('/process-dcs/stages', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const stages = await bundleStages(req.user!.companyId);
  res.json({ data: stages.map((st) => ({ ...st, source: LEVEL_LABEL[st.level] })) });
}));

/**
 * GET /bundle-stock/available — bundle picker for DCs and the floor.
 *   level=CUT|SEWN|FIN|PACK  or  stage_id (level from the stage; flags bundles on another open DC of it)
 *   io_no, cutting_plan_id, lay_id, style_id, color_id, size_id, q (bundle no / barcode), limit
 */
processDcRouter.get('/bundle-stock/available', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const qp = z.object({
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
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  }).parse(req.query);
  const st = qp.stage_id ? await stageInfo(cid, qp.stage_id) : null;
  const level: Level = st?.level ?? qp.level ?? 'CUT';

  const where = ['COALESCE(cb.company_id, c.company_id) = ?', `cb.status NOT IN (${TERMINAL.map(() => '?').join(',')})`];
  const params: unknown[] = [cid, ...TERMINAL];
  if (qp.io_no) { where.push('cb.io_no = ?'); params.push(qp.io_no); }
  if (qp.cutting_plan_id) {
    where.push('COALESCE(co.cutting_plan_id, lp.cutting_plan_id, c.cutting_plan_id) = ?'); params.push(qp.cutting_plan_id);
  }
  if (qp.lay_id) { where.push('COALESCE(cb.lay_id, c.lay_id) = ?'); params.push(qp.lay_id); }
  if (qp.style_id) { where.push('cb.style_id = ?'); params.push(qp.style_id); }
  if (qp.color_id) { where.push('cb.color_id = ?'); params.push(qp.color_id); }
  if (qp.size_id) { where.push('cb.size_id = ?'); params.push(qp.size_id); }
  if (qp.q) { where.push('(cb.bundle_no LIKE ? OR cb.barcode LIKE ?)'); params.push(`%${qp.q}%`, `%${qp.q}%`); }
  if (!qp.include_zero) {
    where.push(level === 'CUT' ? 'cb.balance_qty > 0' : level === 'SEWN' ? 'cb.sew_good_qty > 0' : 'cb.fin_good_qty > 0');
  }
  const rows = await query<any>(
    `SELECT cb.*, st.style_code, col.color_name, sz.size_code, sz.sort_order AS size_sort,
            lp.lay_no, cp.plan_no, COALESCE(co.cutting_plan_id, lp.cutting_plan_id, c.cutting_plan_id) AS cutting_plan_id_resolved
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
  const holds = st ? await openDcHolds(null, cid, st.id, rows.map((r) => Number(r.id))) : new Map();
  const data = rows.map((b) => ({
    id: b.id, bundle_no: b.bundle_no, barcode: b.barcode, io_no: b.io_no, part_name: b.part_name,
    style_id: b.style_id, style_code: b.style_code, color_id: b.color_id, color_name: b.color_name,
    size_id: b.size_id, size_code: b.size_code, size_sort: b.size_sort, qty: b.qty, status: b.status,
    lay_no: b.lay_no, plan_no: b.plan_no, cutting_plan_id: b.cutting_plan_id_resolved,
    available_qty: availAt(b, level), avail: bundleAvail(b), open_dc_no: holds.get(Number(b.id)) ?? null,
  })).filter((b) => qp.include_zero || b.available_qty > 0);
  res.json({ data, meta: { level, stage: st } });
}));

// ============================================================
// DC list / detail
// ============================================================
processDcRouter.get('/process-dcs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const where = ['jc.company_id = ?'];
  const params: unknown[] = [cid];
  if (req.query.status) { where.push('jc.status = ?'); params.push(String(req.query.status)); }
  if (req.query.stage_id) { where.push('jc.stage_id = ?'); params.push(Number(req.query.stage_id)); }
  if (req.query.vendor_id) { where.push('jc.vendor_id = ?'); params.push(Number(req.query.vendor_id)); }
  if (req.query.io_no) { where.push('jc.io_no = ?'); params.push(String(req.query.io_no)); }
  if (req.query.from) { where.push('jc.challan_date >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('jc.challan_date <= ?'); params.push(String(req.query.to)); }
  if (req.query.q) {
    where.push(`(jc.challan_no LIKE ? OR EXISTS (SELECT 1 FROM trx_jobwork_challan_line l2 JOIN trx_cutting_bundle b2 ON b2.id = l2.bundle_id
                 WHERE l2.challan_id = jc.id AND (b2.bundle_no LIKE ? OR b2.barcode LIKE ?)))`);
    const q = `%${String(req.query.q)}%`;
    params.push(q, q, q);
  }
  const rows = await query(
    `SELECT jc.id, jc.challan_no, jc.challan_date, jc.status, jc.io_no, jc.expected_return, jc.vehicle_no,
            jc.total_qty, jc.rate, jc.total_amount, jc.is_bundle_dc, jc.cancel_reason, jc.close_reason,
            v.party_name AS vendor_name, ps.stage_name, ps.stage_code, st.style_code,
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
            ui.full_name AS issued_by_name, uc.full_name AS cancelled_by_name, ucr.full_name AS created_by_name
       FROM trx_jobwork_challan jc
       LEFT JOIN mst_party v ON v.id = jc.vendor_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
       LEFT JOIN mst_style st ON st.id = jc.style_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = jc.cutting_plan_id
       LEFT JOIN mst_user ui ON ui.id = jc.issued_by
       LEFT JOIN mst_user uc ON uc.id = jc.cancelled_by
       LEFT JOIN mst_user ucr ON ucr.id = jc.created_by
      WHERE jc.id = ? AND jc.company_id = ?`, [id, cid]);
  if (!dc) throw NotFound('DC not found');
  const lines = await query<any>(
    `SELECT jl.*, cb.bundle_no, cb.barcode, cb.status AS bundle_status, cb.qty AS bundle_qty, cb.io_no AS bundle_io_no,
            COALESCE(jl.part_name, cb.part_name) AS part, st.style_code, col.color_name, sz.size_code, sz.sort_order AS size_sort,
            (jl.qty - jl.received_qty - jl.rejected_qty - jl.shortage_qty) AS pending_qty,
            cb.balance_qty, cb.sew_in_qty, cb.sew_good_qty, cb.sew_reject_qty, cb.fin_in_qty, cb.fin_good_qty,
            cb.fin_reject_qty, cb.qc_pass_qty, cb.qc_reject_qty, cb.packed_qty, cb.cut_loss_qty, cb.sewn_loss_qty,
            cb.pack_loss_qty, cb.out_cut_qty, cb.out_sewn_qty, cb.out_pack_qty
       FROM trx_jobwork_challan_line jl
       LEFT JOIN trx_cutting_bundle cb ON cb.id = jl.bundle_id
       LEFT JOIN mst_style st ON st.id = COALESCE(jl.style_id, cb.style_id)
       LEFT JOIN mst_color col ON col.id = COALESCE(jl.color_id, cb.color_id)
       LEFT JOIN mst_size sz ON sz.id = COALESCE(jl.size_id, cb.size_id)
      WHERE jl.challan_id = ?
      ORDER BY col.color_name, sz.sort_order, sz.size_code, cb.bundle_seq, jl.id`, [id]);
  const receipts = await query<any>(
    `SELECT r.*, u.full_name AS created_by_name FROM trx_jobwork_receipt r LEFT JOIN mst_user u ON u.id = r.created_by
      WHERE r.challan_id = ? AND r.company_id = ? ORDER BY r.id`, [id, cid]);
  const rlines = receipts.length ? await query<any>(
    `SELECT rl.*, cb.bundle_no FROM trx_jobwork_receipt_line rl LEFT JOIN trx_cutting_bundle cb ON cb.id = rl.bundle_id
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
  const totals = {
    bundles: lines.length,
    qty: lines.reduce((a, l) => a + n(l.qty), 0),
    received: lines.reduce((a, l) => a + n(l.received_qty), 0),
    rejected: lines.reduce((a, l) => a + n(l.rejected_qty), 0),
    shortage: lines.reduce((a, l) => a + n(l.shortage_qty), 0),
    pending: lines.reduce((a, l) => a + Math.max(n(l.pending_qty), 0), 0),
  };
  return { ...dc, lines, receipts, summary: { sizes, colors, sizeTotals, totals } };
}

processDcRouter.get('/process-dcs/receipts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT r.*, jc.challan_no, jc.status AS dc_status, ps.stage_name, v.party_name AS vendor_name,
            (SELECT COUNT(*) FROM trx_jobwork_receipt_line rl WHERE rl.receipt_id = r.id) AS line_count
       FROM trx_jobwork_receipt r
       JOIN trx_jobwork_challan jc ON jc.id = r.challan_id
       LEFT JOIN cfg_process_stage ps ON ps.id = jc.stage_id
       LEFT JOIN mst_party v ON v.id = r.vendor_id
      WHERE r.company_id = ? ORDER BY r.receipt_date DESC, r.id DESC LIMIT 500`, [cid]);
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
  description: s.nullableStr(255),
});
const dcSchema = z.object({
  challan_no: s.nullableStr(40),
  challan_date: dateStr,
  stage_id: s.idReq(),
  vendor_id: s.idReq(),
  prod_order_id: s.id(),
  cutting_plan_id: s.id(),
  expected_return: s.date(),
  rate: z.coerce.number().min(0).nullish(),
  vehicle_no: s.nullableStr(30),
  driver_name: s.nullableStr(80),
  transporter: s.nullableStr(120),
  gate_outward_id: s.id(),
  remarks: s.nullableStr(500),
  lines: z.array(lineSchema).min(1, 'Add at least one bundle').max(2000),
  issue: z.coerce.boolean().default(false),
});

interface PreparedLine { bundle: BundleRow; qty: number; description: string | null }

/** Validate DC lines against bundle balances and other open DCs (bundles locked by the caller). */
async function prepareLines(tx: Tx, cid: number, st: StageInfo, lines: z.infer<typeof lineSchema>[], challanId?: number) {
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
  const out: PreparedLine[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    const b = await lockBundle(tx, cid, { id });
    const l = byId.get(id)!;
    if (TERMINAL.includes(b.status)) { problems.push(`${b.bundle_no} is ${b.status}`); continue; }
    if (!b.style_id) { problems.push(`${b.bundle_no} has no style`); continue; }
    if (holds.has(id)) { problems.push(`${b.bundle_no} is already on open ${st.stage_name} DC ${holds.get(id)}`); continue; }
    const avail = availAt(b, st.level);
    const qty = l.qty ?? avail;
    if (avail <= 0) { problems.push(`${b.bundle_no} has no ${LEVEL_LABEL[st.level]}`); continue; }
    if (qty > avail) { problems.push(`${b.bundle_no}: ${qty} PCS requested, only ${avail} ${LEVEL_LABEL[st.level]}`); continue; }
    out.push({ bundle: b, qty, description: l.description ?? null });
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
         (challan_id, sku_id, bundle_id, description, qty, style_id, color_id, size_id, part_name, source_level)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [challanId, l.bundle.sku_id ?? null, l.bundle.id,
       l.description ?? `Bundle ${l.bundle.bundle_no}`.slice(0, 255), l.qty,
       l.bundle.style_id ?? null, l.bundle.color_id ?? null, l.bundle.size_id ?? null,
       l.bundle.part_name ?? null, st.level]);
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

async function vendorCheck(cid: number, vendorId: number) {
  const v = await queryOne(`SELECT id FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0`, [vendorId, cid]);
  if (!v) throw BadRequest('Vendor not found');
}

/** Post an issued DC through the bundle ledger (bundles already locked in prepareLines). */
async function postIssue(tx: Tx, req: Request, dc: any, st: StageInfo, lines: PreparedLine[], vendorName: string) {
  const lineRows = await txQuery<any>(tx, `SELECT id, bundle_id, qty FROM trx_jobwork_challan_line WHERE challan_id = ?`, [dc.id]);
  for (const l of lines) {
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
  const vendor = await queryOne<any>(`SELECT party_name FROM mst_party WHERE id = ?`, [body.vendor_id]);

  const id = await transaction(async (tx) => {
    const lines = await prepareLines(tx, cid, st, body.lines);
    const h = headerFrom(lines);
    const challanNo = body.challan_no || await nextDocNumber(tx, cid, 'JW_CHALLAN');
    const dup = await txQueryOne(tx, `SELECT id FROM trx_jobwork_challan WHERE company_id = ? AND challan_no = ?`, [cid, challanNo]);
    if (dup) throw BadRequest(`DC no ${challanNo} already exists`);
    const r = await txExecute(tx,
      `INSERT INTO trx_jobwork_challan
         (company_id, challan_no, challan_date, prod_order_id, vendor_id, stage_id, gate_outward_id, total_qty, rate,
          total_amount, expected_return, status, remarks, io_no, cutting_plan_id, style_id, is_bundle_dc,
          vehicle_no, driver_name, transporter, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?,1,?,?,?,?)`,
      [cid, challanNo, body.challan_date, body.prod_order_id ?? null, body.vendor_id, st.id, body.gate_outward_id ?? null,
       h.total_qty, body.rate ?? null, body.rate != null ? Math.round(body.rate * h.total_qty * 100) / 100 : null,
       body.expected_return ?? null, body.remarks ?? null, h.io_no, body.cutting_plan_id ?? null, h.style_id,
       body.vehicle_no ?? null, body.driver_name ?? null, body.transporter ?? null, req.user!.id]);
    const dc = { id: r.insertId, challan_no: challanNo };
    await writeLines(tx, dc.id, st, lines);
    if (body.issue) await postIssue(tx, req, dc, st, lines, vendor?.party_name ?? 'Vendor');
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
  const vendor = await queryOne<any>(`SELECT party_name FROM mst_party WHERE id = ?`, [body.vendor_id]);

  await transaction(async (tx) => {
    const before = await txQueryOne<any>(tx, `SELECT * FROM trx_jobwork_challan WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!before) throw NotFound('DC not found');
    if (before.status !== 'DRAFT') throw BadRequest(`DC ${before.challan_no} is ${before.status} — only a draft DC can be edited`);
    const lines = await prepareLines(tx, cid, st, body.lines, id);
    const h = headerFrom(lines);
    await txExecute(tx,
      `UPDATE trx_jobwork_challan SET challan_date = ?, prod_order_id = ?, vendor_id = ?, stage_id = ?, gate_outward_id = ?,
              total_qty = ?, rate = ?, total_amount = ?, expected_return = ?, remarks = ?, io_no = ?, cutting_plan_id = ?,
              style_id = ?, vehicle_no = ?, driver_name = ?, transporter = ?, updated_by = ?
        WHERE id = ?`,
      [body.challan_date, body.prod_order_id ?? null, body.vendor_id, st.id, body.gate_outward_id ?? null,
       h.total_qty, body.rate ?? null, body.rate != null ? Math.round(body.rate * h.total_qty * 100) / 100 : null,
       body.expected_return ?? null, body.remarks ?? null, h.io_no, body.cutting_plan_id ?? null, h.style_id,
       body.vehicle_no ?? null, body.driver_name ?? null, body.transporter ?? null, req.user!.id, id]);
    // Draft lines have no ledger effect yet, so replacing them is safe.
    await txExecute(tx, `DELETE FROM trx_jobwork_challan_line WHERE challan_id = ?`, [id]);
    await writeLines(tx, id, st, lines);
    if (body.issue) await postIssue(tx, req, before, st, lines, vendor?.party_name ?? 'Vendor');
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
    const cur = await txQuery<any>(tx, `SELECT bundle_id, qty, description FROM trx_jobwork_challan_line WHERE challan_id = ?`, [id]);
    if (!cur.length) throw BadRequest('DC has no bundles');
    if (cur.some((l) => !l.bundle_id)) throw BadRequest('This DC has lines without bundles — it was not created as a bundle DC');
    const lines = await prepareLines(tx, cid, st, cur.map((l) => ({ bundle_id: l.bundle_id, qty: l.qty, description: l.description })), id);
    await postIssue(tx, req, dc, st, lines, dc.vendor_name ?? 'Vendor');
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
  await transaction(async (tx) => {
    const dc = await txQueryOne<any>(tx, `SELECT * FROM trx_jobwork_challan WHERE id = ? AND company_id = ? FOR UPDATE`, [id, cid]);
    if (!dc) throw NotFound('DC not found');
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
    }
    await txExecute(tx,
      `UPDATE trx_jobwork_challan SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW(), updated_by = ? WHERE id = ?`,
      [reason, req.user!.id, req.user!.id, id]);
    await audit(req, 'trx_jobwork_challan', id, 'UPDATE', { status: dc.status }, { status: 'CANCELLED', reason }, tx);
  });
  res.json({ data: await loadDc(cid, id) });
}));

// ============================================================
// Receipt against the DC — per bundle good / reject / shortage
// ============================================================
const receiptSchema = z.object({
  receipt_no: s.nullableStr(40),
  receipt_date: dateStr,
  gate_inward_id: s.id(),
  remarks: s.nullableStr(500),
  lines: z.array(z.object({
    line_id: s.id(),
    bundle_id: s.id(),
    barcode: s.nullableStr(120),
    received_qty: z.coerce.number().int().min(0).default(0),
    rejected_qty: z.coerce.number().int().min(0).default(0),
    shortage_qty: z.coerce.number().int().min(0).default(0),
    remarks: s.nullableStr(255),
  })).min(1).max(2000),
});

async function postReceipt(tx: Tx, req: Request, dc: any, body: z.infer<typeof receiptSchema>, kind: 'RECEIPT' | 'CLOSE_SHORT') {
  const cid = req.user!.companyId;
  const st = await stageInfo(cid, dc.stage_id);
  const dcLines = await txQuery<any>(tx, `SELECT * FROM trx_jobwork_challan_line WHERE challan_id = ? FOR UPDATE`, [dc.id]);

  // Resolve each receipt line to its DC line.
  const picked: { line: any; good: number; rej: number; short: number; remarks: string | null }[] = [];
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
    if (total === 0) continue;
    const pending = n(line.qty) - n(line.received_qty) - n(line.rejected_qty) - n(line.shortage_qty);
    if (total > pending) {
      const bno = (await txQueryOne<any>(tx, `SELECT bundle_no FROM trx_cutting_bundle WHERE id = ?`, [line.bundle_id]))?.bundle_no;
      throw BadRequest(`Bundle ${bno ?? line.id}: received + rejected + shortage (${total} PCS) exceeds the ${pending} PCS pending on the DC`);
    }
    picked.push({ line, good: rl.received_qty, rej: rl.rejected_qty, short: rl.shortage_qty, remarks: rl.remarks ?? null });
  }
  if (!picked.length) throw BadRequest('Enter received, rejected or shortage PCS for at least one bundle');
  picked.sort((a, b) => n(a.line.bundle_id) - n(b.line.bundle_id));

  const tot = picked.reduce((a, p) => ({ g: a.g + p.good, r: a.r + p.rej, s: a.s + p.short, i: a.i + n(p.line.qty) }), { g: 0, r: 0, s: 0, i: 0 });
  const receiptNo = body.receipt_no || await nextDocNumber(tx, cid, 'JW_RECEIPT');
  const rr = await txExecute(tx,
    `INSERT INTO trx_jobwork_receipt
       (company_id, receipt_no, receipt_date, challan_id, vendor_id, gate_inward_id, issued_qty, received_qty,
        rejected_qty, shortage_qty, rework_qty, rate, total_amount, status, remarks, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,'RECEIVED',?,?)`,
    [cid, receiptNo, body.receipt_date, dc.id, dc.vendor_id, body.gate_inward_id ?? null, tot.i, tot.g, tot.r, tot.s,
     dc.rate ?? null, dc.rate != null ? Math.round(n(dc.rate) * tot.g * 100) / 100 : null,
     (kind === 'CLOSE_SHORT' ? `Closed short: ${body.remarks ?? ''}` : body.remarks ?? null), req.user!.id]);

  for (const p of picked) {
    await txExecute(tx,
      `INSERT INTO trx_jobwork_receipt_line
         (receipt_id, challan_line_id, bundle_id, sku_id, issued_qty, received_qty, rejected_qty, shortage_qty, remarks)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [rr.insertId, p.line.id, p.line.bundle_id ?? null, p.line.sku_id ?? null, n(p.line.qty), p.good, p.rej, p.short, p.remarks]);
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
        remarks: `${receiptNo} vs DC ${dc.challan_no}${p.short ? ` · shortage ${p.short}` : ''}${p.remarks ? ` · ${p.remarks}` : ''}`.slice(0, 255),
      });
    }
  }
  const left = await txQueryOne<any>(tx,
    `SELECT COALESCE(SUM(qty - received_qty - rejected_qty - shortage_qty),0) AS p FROM trx_jobwork_challan_line WHERE challan_id = ?`, [dc.id]);
  const status = kind === 'CLOSE_SHORT' ? 'CLOSED' : n(left?.p) === 0 ? 'FULLY_RECEIVED' : 'PARTIAL_RECEIVED';
  await txExecute(tx, `UPDATE trx_jobwork_challan SET status = ?, updated_by = ? WHERE id = ?`, [status, req.user!.id, dc.id]);
  await audit(req, 'trx_jobwork_receipt', rr.insertId, 'INSERT', undefined,
    { receipt_no: receiptNo, challan: dc.challan_no, received: tot.g, rejected: tot.r, shortage: tot.s, dc_status: status }, tx);
  return { receipt_id: rr.insertId, receipt_no: receiptNo, dc_status: status };
}

processDcRouter.post('/process-dcs/:id/receipts', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const body = receiptSchema.parse(req.body);
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
