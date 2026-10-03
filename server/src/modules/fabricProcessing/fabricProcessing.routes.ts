import { Router, type Request } from 'express';
import { z } from 'zod';
import { calcRollFor, ROLL_CALC_COLS, rollCalcVals } from '../../core/fabricRollCalc.js';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { refreshFabricRollStatus } from '../production/cuttingEngine.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { checkDcQuotation, useGateEntry } from '../../core/inwardControls.js';

/**
 * Fabric Process engine (Garment_ERP_Fabric_Process_Developer_Document_v2).
 * One configurable engine for dyeing / washing / compacting / brushing / raising / printing …
 * driven by mst_fabric_process_type:
 *
 *   Store roll ─ Outward DC (multi job, multi roll; draft → confirm issues stock)
 *     → Inward / GRN (multi job; each input roll → one or more output rolls with good / reject /
 *       loss KG; good → processed store, reject → reject store; partial receipt)
 *     → Return (quality issue against a GRN roll → return store)
 *     → Reprocess (re-dye / re-wash … with billing treatment; creates a reprocess DC, received
 *       back through the same Inward / GRN)
 *     → Contractor bill (GRN good KG × rate + billable reprocess − recovery; non-billable excluded)
 *   Every roll movement is written to trx_fabric_roll_history (roll tracking).
 */
export const fabricProcessingRouter = Router();

/**
 * Fabric process permissions (doc §17 / §32) — granted per role in Admin › Roles
 * (seeded: Store User, Production User, Process Manager, ERP Admin).
 */
export const FP = {
  VIEW: 'FABRIC_PROCESS.VIEW', CREATE: 'FABRIC_PROCESS.CREATE', EDIT_DRAFT: 'FABRIC_PROCESS.EDIT_DRAFT', CONFIRM: 'FABRIC_PROCESS.CONFIRM',
  QC: 'FABRIC_PROCESS.QC', RETURN: 'FABRIC_PROCESS.RETURN', REPROCESS: 'FABRIC_PROCESS.REPROCESS', BILLING_APPROVE: 'FABRIC_PROCESS.BILLING_APPROVE',
  BILLING_CHANGE: 'FABRIC_PROCESS.BILLING_CHANGE', BILL: 'FABRIC_PROCESS.BILL', BILL_CANCEL: 'FABRIC_PROCESS.BILL_CANCEL', CANCEL: 'FABRIC_PROCESS.CANCEL',
  MASTER: 'FABRIC_PROCESS.MASTER',
} as const;
const can = (req: Request, code: string) => !!req.user?.isSuperAdmin || !!req.user?.permissions.has(code);

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const n = (v: unknown) => Number(v ?? 0) || 0;
const EPS = 0.0005;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function processType(cid: number, code: string, runner?: Tx) {
  const sql = 'SELECT * FROM mst_fabric_process_type WHERE company_id = ? AND code = ? AND is_active = 1';
  const row = runner ? await txQueryOne<any>(runner, sql, [cid, code]) : await queryOne<any>(sql, [cid, code]);
  if (!row) throw BadRequest(`Unknown process "${code}"`);
  return row;
}

/** One line of roll history (roll tracking). */
async function history(tx: Tx, req: Request, h: {
  roll_id?: number | null; roll_no: string; event: string; ref_type: string; ref_id?: number | null; ref_no?: string | null;
  sub_process?: string | null; from?: string | null; to?: string | null; qty: number; so_id?: number | null; related_roll_id?: number | null; remarks?: string | null;
}) {
  await txExecute(tx,
    `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, sub_process,
       from_place, to_place, qty_kg, so_id, related_roll_id, remarks, user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, h.roll_id ?? null, h.roll_no, h.event, h.ref_type, h.ref_id ?? null, h.ref_no ?? null, h.sub_process ?? null,
     h.from ?? null, h.to ?? null, r3(h.qty), h.so_id ?? null, h.related_roll_id ?? null, h.remarks ?? null, req.user!.id]);
}

const whName = async (tx: Tx, id: number | null) =>
  id ? String((await txQueryOne<any>(tx, 'SELECT warehouse_name FROM mst_warehouse WHERE id = ?', [id]))?.warehouse_name ?? `Store ${id}`) : null;
const partyName = async (tx: Tx, id: number | null) =>
  id ? String((await txQueryOne<any>(tx, 'SELECT party_name FROM mst_party WHERE id = ?', [id]))?.party_name ?? '') : null;

// =====================================================================================
// Masters / lookups
// =====================================================================================
fabricProcessingRouter.get('/fabric-process/types', requirePermission(FP.VIEW), ah(async (req, res) => {
  const rows = await query<any>('SELECT * FROM mst_fabric_process_type WHERE company_id = ? AND is_active = 1 ORDER BY sort_order, name', [req.user!.companyId]);
  res.json({ data: rows });
}));
fabricProcessingRouter.get('/fabric-process/reasons', requirePermission(FP.VIEW), ah(async (req, res) => {
  const rows = await query<any>('SELECT * FROM mst_fabric_process_reason WHERE company_id = ? AND is_active = 1 ORDER BY code', [req.user!.companyId]);
  res.json({ data: rows });
}));

/**
 * GET /fabric-process/store-rolls — rolls that can go on a DC: QC-accepted store rolls with KG left
 * (fabric GRN, knitting inward, processed). ?returned=1 lists rolls in the return / reject store
 * (for reprocess). Each roll carries its job (trx_fabric_roll.so_id).
 */
const STORE_ROLL_SQL = `
  SELECT fr.id, fr.roll_no, fr.lot_no, fr.fabric_id, fb.fabric_name, fb.fabric_code,
         fr.meters, fr.weight_kg, COALESCE(fr.issued_kg, 0) AS issued_kg,
         ROUND(COALESCE(fr.weight_kg, 0) - COALESCE(fr.issued_kg, 0), 3) AS balance_kg,
         fr.gsm, fr.dia, fr.shade, fr.color_name, fr.process_state, fr.stock_status, fr.qc_status,
         fr.warehouse_id, w.warehouse_name, g.grn_no, g.grn_date,
         fr.so_id, so.so_no, COALESCE(so.io_no, so.so_no, g.internal_ir_no) AS io_no, so.buyer_po_no,
         (SELECT sol.style_id FROM trx_sales_order_line sol WHERE sol.so_id = fr.so_id ORDER BY sol.id LIMIT 1) AS style_id,
         (SELECT st.style_code FROM trx_sales_order_line sol JOIN mst_style st ON st.id = sol.style_id WHERE sol.so_id = fr.so_id ORDER BY sol.id LIMIT 1) AS style_code
    FROM trx_fabric_roll fr
    JOIN trx_grn g ON g.id = fr.grn_id
    LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
    LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
    LEFT JOIN trx_sales_order so ON so.id = fr.so_id`;

fabricProcessingRouter.get(['/fabric-process/store-rolls', '/fabric-processing/store-rolls'], requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({
    so_id: z.coerce.number().int().positive().optional(),
    fabric_id: z.coerce.number().int().positive().optional(),
    warehouse_id: z.coerce.number().int().positive().optional(),
    state: z.string().trim().max(20).optional(),
    returned: z.coerce.number().int().optional(),
    q: z.string().trim().max(60).optional(),
  }).parse(req.query);
  const where = ['fr.company_id = ?', `fr.stock_status <> 'CLOSED'`, 'COALESCE(fr.weight_kg, 0) - COALESCE(fr.issued_kg, 0) > 0.0005'];
  const params: unknown[] = [cid];
  if (q.returned) where.push(`fr.process_state = 'RETURNED'`);
  else where.push(`fr.qc_status = 'ACCEPTED'`);
  if (q.so_id) { where.push('fr.so_id = ?'); params.push(q.so_id); }
  if (q.fabric_id) { where.push('fr.fabric_id = ?'); params.push(q.fabric_id); }
  if (q.warehouse_id) { where.push('fr.warehouse_id = ?'); params.push(q.warehouse_id); }
  if (q.state) { where.push('fr.process_state = ?'); params.push(q.state); }
  if (q.q) { where.push('(fr.roll_no = ? OR fr.roll_no LIKE ? OR fr.lot_no LIKE ? OR g.grn_no LIKE ?)'); params.push(q.q, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const rows = await query<any>(`${STORE_ROLL_SQL} WHERE ${where.join(' AND ')} ORDER BY g.grn_date DESC, fr.id DESC LIMIT 3000`, params);
  res.json({ data: rows.map((r) => ({ ...r, balance_kg: n(r.balance_kg), weight_kg: n(r.weight_kg), meters: n(r.meters) })) });
}));

// =====================================================================================
// Outward DC
// =====================================================================================
const outwardSchema = z.object({
  fpo_date: date,
  sub_process: z.string().trim().min(2).max(40),
  vendor_id: s.idReq(),
  from_warehouse_id: s.id(),
  to_location: s.nullableStr(120),
  vehicle_no: s.nullableStr(30),
  challan_no: s.nullableStr(60),
  color_name: s.nullableStr(80),
  shade_code: s.nullableStr(80),
  target_dia: s.nullableStr(40),
  target_gsm: s.nullableStr(40),
  expected_return_date: date.nullish(),
  remarks: s.text(),
  /** Approved process quotation of the process unit (job-work rate). */
  quotation_id: s.id(),
  quotation_line_id: s.id(),
  rate_per_kg: z.coerce.number().min(0).nullish(),
  rolls: z.array(z.object({
    fabric_roll_id: s.idReq(),
    so_id: s.id(),
    weight_kg: z.coerce.number().positive(),
    meters: z.coerce.number().min(0).default(0),
    color_name: s.nullableStr(80),
  })).min(1, 'Add at least one roll'),
});
type OutwardBody = z.infer<typeof outwardSchema>;

/** Dyeing (and re-dyeing) DCs carry a fabric colour + dye colour per roll; other processes keep the roll's colour. */
export const isDyeing = (code: unknown) => /DYE/i.test(String(code ?? ''));

/** Validates the DC rolls against store stock and writes them (stock is issued only when `issue`). */
async function writeOutwardRolls(tx: Tx, req: Request, fpoId: number, fpo: any, rolls: OutwardBody['rolls'], issue: boolean, opts: { allowReturned?: boolean } = {}) {
  const cid = req.user!.companyId;
  const seen = new Set<number>();
  let total = 0;
  const vendor = await partyName(tx, fpo.vendor_id);
  for (const r of rolls) {
    if (seen.has(r.fabric_roll_id)) throw BadRequest('The same roll is on the DC twice');
    seen.add(r.fabric_roll_id);
    const fr = await txQueryOne<any>(tx,
      `SELECT fr.*, so.io_no, so.so_no, so.buyer_po_no FROM trx_fabric_roll fr LEFT JOIN trx_sales_order so ON so.id = fr.so_id
        WHERE fr.id = ? AND fr.company_id = ? FOR UPDATE`, [r.fabric_roll_id, cid]);
    if (!fr) throw BadRequest('Roll not found in store');
    if (!(fr.qc_status === 'ACCEPTED' || (opts.allowReturned && fr.process_state === 'RETURNED'))) {
      throw BadRequest(`Roll ${fr.roll_no} is not QC accepted (${fr.qc_status})`);
    }
    if (fr.stock_status === 'CLOSED') throw BadRequest(`Roll ${fr.roll_no} is closed`);
    const avail = n(fr.weight_kg) - n(fr.issued_kg);
    if (r.weight_kg > avail + 1e-9) throw BadRequest(`Roll ${fr.roll_no} has only ${avail.toFixed(3)} KG in store`);
    // Roll must belong to the selected job (doc §15) — a roll without a job can go for any job
    const soId = r.so_id ?? (fr.so_id ? Number(fr.so_id) : null);
    if (r.so_id && fr.so_id && Number(fr.so_id) !== Number(r.so_id)) {
      throw BadRequest(`Roll ${fr.roll_no} belongs to job ${fr.io_no || fr.so_no} — transfer it to the job first`);
    }
    const job = soId ? await txQueryOne<any>(tx,
      `SELECT so.id, COALESCE(so.io_no, so.so_no) AS io_no, so.buyer_po_no,
              (SELECT sol.style_id FROM trx_sales_order_line sol WHERE sol.so_id = so.id ORDER BY sol.id LIMIT 1) AS style_id
         FROM trx_sales_order so WHERE so.id = ? AND so.company_id = ?`, [soId, cid]) : null;
    const meters = r.meters || (n(fr.weight_kg) > 0 ? r2(n(fr.meters) * (r.weight_kg / n(fr.weight_kg))) : 0);
    // fabric colour = the roll as it goes out (grey / melange / …); color_name = the dye colour on a dyeing DC
    const fabricColor = fr.color_name || (fr.process_state === 'GREY' ? 'GREY' : null);
    const dyeing = isDyeing(fpo.sub_process);
    const colour = r.color_name || fpo.color_name || (dyeing && !fpo.is_reprocess ? null : fr.color_name) || null;
    if (dyeing && issue && !colour) throw BadRequest(`Roll ${fr.roll_no}: enter the dye colour`);
    await txExecute(tx,
      `INSERT INTO trx_fabric_process_roll_in (fpo_id, fabric_roll_id, roll_no, lot_no, weight_kg, meters, warehouse_id,
         so_id, io_no, buyer_po_no, style_id, fabric_id, color_name, fabric_color, gsm, dia, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fpoId, fr.id, fr.roll_no, fr.lot_no ?? null, r3(r.weight_kg), meters, fr.warehouse_id ?? null,
       job?.id ?? null, job?.io_no ?? null, job?.buyer_po_no ?? null, job?.style_id ?? null, fr.fabric_id ?? null,
       colour, fabricColor, fr.gsm ?? null, fr.dia ?? null, issue ? 'AT_VENDOR' : 'DRAFT']);
    total += r.weight_kg;
    if (issue) {
      await txExecute(tx, 'UPDATE trx_fabric_roll SET issued_kg = COALESCE(issued_kg, 0) + ? WHERE id = ?', [r3(r.weight_kg), fr.id]);
      await refreshFabricRollStatus(tx, fr.id);
      if (fr.warehouse_id) {
        await postLedger(tx, {
          companyId: cid, warehouseId: Number(fr.warehouse_id), materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null,
          txnType: 'ISSUE', refType: fpo.is_reprocess ? 'FAB_REPROCESS_DC' : 'FAB_PROC_DC', refId: fpoId, qtyOut: r3(r.weight_kg), uomId: UOM_KG, createdBy: req.user!.id,
        });
      }
      await history(tx, req, {
        roll_id: fr.id, roll_no: fr.roll_no, event: fpo.is_reprocess ? 'REPROCESS_OUTWARD' : 'PROCESS_OUTWARD', ref_type: 'FPO', ref_id: fpoId, ref_no: fpo.fpo_no,
        sub_process: fpo.sub_process, from: await whName(tx, fr.warehouse_id ? Number(fr.warehouse_id) : null), to: vendor, qty: r.weight_kg, so_id: job?.id ?? null,
        remarks: `Sent for ${String(fpo.sub_process).toLowerCase().replace(/_/g, ' ')}`,
      });
    }
  }
  const jobs = new Set(rolls.map((r) => r.so_id).filter(Boolean));
  await txExecute(tx,
    `UPDATE trx_fabric_process_order SET total_input_rolls = ?, input_weight_kg = ?,
            io_no = ?, so_id = ? WHERE id = ?`,
    [rolls.length, r3(total), jobs.size > 1 ? 'MULTI' : (jobs.size === 1 ? (await txQueryOne<any>(tx, 'SELECT COALESCE(io_no, so_no) AS j FROM trx_sales_order WHERE id = ?', [[...jobs][0]]))?.j ?? 'STOCK' : 'STOCK'),
     jobs.size === 1 ? [...jobs][0] : null, fpoId]);
  return r3(total);
}

async function insertOutwardHeader(tx: Tx, req: Request, b: OutwardBody, extra: { status: string; is_reprocess?: boolean; reprocess_id?: number | null }) {
  const cid = req.user!.companyId;
  const pt = await processType(cid, b.sub_process, tx);
  // the approved quotation of the process unit — required when the DC is confirmed (not for reprocess DCs)
  const quote = await checkDcQuotation(cid, { vendor_id: Number(b.vendor_id), quotation_id: b.quotation_id, quotation_line_id: b.quotation_line_id, rate: b.rate_per_kg ?? null,
    label: `${pt.name} DC`, required: extra.status === 'DISPATCHED' && !extra.is_reprocess ? undefined : false });
  const fpoNo = await nextDocNumber(tx, cid, 'FPO');
  const r = await txExecute(tx,
    `INSERT INTO trx_fabric_process_order
       (company_id, fpo_no, fpo_date, io_no, sub_process, vendor_id, from_warehouse_id, to_location, vehicle_no, challan_no,
        shade_code, color_name, target_dia, target_gsm, expected_return_date, status, remarks, created_by,
        is_reprocess, reprocess_id, confirmed_by, confirmed_at, quotation_id, quotation_line_id, rate_per_kg)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, fpoNo, b.fpo_date, 'STOCK', pt.code, b.vendor_id, b.from_warehouse_id ?? null, b.to_location ?? null, b.vehicle_no ?? null,
     b.challan_no ?? null, b.shade_code ?? null, b.color_name ?? null, b.target_dia ?? null, b.target_gsm ?? null,
     b.expected_return_date ?? null, extra.status, b.remarks ?? null, req.user!.id, extra.is_reprocess ? 1 : 0, extra.reprocess_id ?? null,
     extra.status === 'DISPATCHED' ? req.user!.id : null, extra.status === 'DISPATCHED' ? new Date() : null, quote.quotation_id, quote.quotation_line_id, quote.rate]);
  return { id: Number(r.insertId), fpo_no: fpoNo, sub_process: pt.code, vendor_id: b.vendor_id, color_name: b.color_name ?? null, is_reprocess: !!extra.is_reprocess };
}

/** GET /fabric-process/outward — DC register with job count and reconciliation totals. */
fabricProcessingRouter.get(['/fabric-process/outward', '/fabric-processing/orders'], requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ status: z.string().optional(), vendor_id: z.coerce.number().int().optional(), sub_process: z.string().optional(),
    reprocess: z.coerce.number().int().optional(), open: z.coerce.number().int().optional() }).parse(req.query);
  const where = ['o.company_id = ?']; const p: unknown[] = [cid];
  if (q.status) { where.push('o.status = ?'); p.push(q.status); }
  if (q.vendor_id) { where.push('o.vendor_id = ?'); p.push(q.vendor_id); }
  if (q.sub_process) { where.push('o.sub_process = ?'); p.push(q.sub_process); }
  if (q.reprocess !== undefined) { where.push('o.is_reprocess = ?'); p.push(q.reprocess ? 1 : 0); }
  if (q.open) where.push(`o.status IN ('DISPATCHED','IN_PROCESS','PARTIALLY_RECEIVED')`);
  const rows = await query<any>(
    `SELECT o.*, v.party_name AS vendor_name, pt.name AS process_name, w.warehouse_name AS from_store,
            COUNT(ri.id) AS roll_count, COUNT(DISTINCT ri.so_id) AS job_count,
            GROUP_CONCAT(DISTINCT ri.io_no ORDER BY ri.io_no SEPARATOR ', ') AS jobs,
            COALESCE(SUM(ri.weight_kg), 0) AS outward_kg, COALESCE(SUM(ri.good_kg), 0) AS good_kg,
            COALESCE(SUM(ri.reject_kg), 0) AS reject_kg, COALESCE(SUM(ri.loss_kg), 0) AS loss_kg
       FROM trx_fabric_process_order o
       LEFT JOIN trx_fabric_process_roll_in ri ON ri.fpo_id = o.id
       LEFT JOIN mst_party v ON v.id = o.vendor_id
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = o.company_id AND pt.code = o.sub_process
       LEFT JOIN mst_warehouse w ON w.id = o.from_warehouse_id
      WHERE ${where.join(' AND ')}
      GROUP BY o.id ORDER BY o.id DESC LIMIT 1000`, p);
  res.json({
    data: rows.map((o) => {
      const bal = ['CANCELLED', 'DRAFT'].includes(o.status) ? 0 : r3(n(o.outward_kg) - n(o.good_kg) - n(o.reject_kg) - n(o.loss_kg));
      return { ...o, outward_kg: n(o.outward_kg), good_kg: n(o.good_kg), reject_kg: n(o.reject_kg), loss_kg: n(o.loss_kg), balance_kg: Math.max(0, bal),
        input_weight_kg: n(o.outward_kg), output_weight_kg: n(o.good_kg) };
    }),
  });
}));

/** Job-wise reconciliation of a DC (doc §10): outward = good + reject + loss + balance. */
async function reconciliation(fpoId: number) {
  const rows = await query<any>(
    `SELECT ri.so_id, COALESCE(ri.io_no, 'STOCK') AS io_no, ri.buyer_po_no, st.style_code, ri.color_name,
            COUNT(*) AS rolls, SUM(ri.weight_kg) AS outward_kg, SUM(ri.good_kg) AS good_kg, SUM(ri.reject_kg) AS reject_kg, SUM(ri.loss_kg) AS loss_kg
       FROM trx_fabric_process_roll_in ri LEFT JOIN mst_style st ON st.id = ri.style_id
      WHERE ri.fpo_id = ? GROUP BY ri.so_id, ri.io_no, ri.buyer_po_no, st.style_code, ri.color_name ORDER BY ri.io_no`, [fpoId]);
  const jobs = rows.map((r) => {
    const o = n(r.outward_kg), g = n(r.good_kg), rj = n(r.reject_kg), l = n(r.loss_kg);
    return { so_id: r.so_id, io_no: r.io_no, buyer_po_no: r.buyer_po_no, style_code: r.style_code, color_name: r.color_name, rolls: Number(r.rolls),
      outward_kg: r3(o), good_kg: r3(g), reject_kg: r3(rj), loss_kg: r3(l), balance_kg: r3(Math.max(0, o - g - rj - l)) };
  });
  const sum = (k: 'outward_kg' | 'good_kg' | 'reject_kg' | 'loss_kg' | 'balance_kg') => r3(jobs.reduce((a, j) => a + j[k], 0));
  return { jobs, total: { outward_kg: sum('outward_kg'), good_kg: sum('good_kg'), reject_kg: sum('reject_kg'), loss_kg: sum('loss_kg'), balance_kg: sum('balance_kg') } };
}

fabricProcessingRouter.get(['/fabric-process/outward/:id', '/fabric-processing/orders/:id'], requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const o = await queryOne<any>(
    `SELECT o.*, v.party_name AS vendor_name, v.gstin AS vendor_gstin, pt.name AS process_name, w.warehouse_name AS from_store, rp.reprocess_no
       FROM trx_fabric_process_order o
       LEFT JOIN mst_party v ON v.id = o.vendor_id
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = o.company_id AND pt.code = o.sub_process
       LEFT JOIN mst_warehouse w ON w.id = o.from_warehouse_id
       LEFT JOIN trx_fabric_reprocess rp ON rp.id = o.reprocess_id
      WHERE o.id = ? AND o.company_id = ?`, [id, cid]);
  if (!o) throw NotFound('Process DC not found');
  const rolls = await query<any>(
    `SELECT ri.*, st.style_code, fb.fabric_name, fr.process_state AS source_state,
            ROUND(ri.weight_kg - ri.good_kg - ri.reject_kg - ri.loss_kg, 3) AS balance_kg
       FROM trx_fabric_process_roll_in ri
       LEFT JOIN mst_style st ON st.id = ri.style_id
       LEFT JOIN mst_fabric fb ON fb.id = ri.fabric_id
       LEFT JOIN trx_fabric_roll fr ON fr.id = ri.fabric_roll_id
      WHERE ri.fpo_id = ? ORDER BY ri.io_no, ri.id`, [id]);
  const inwards = await query<any>('SELECT id, inward_no, inward_date, good_kg, reject_kg, loss_kg, challan_no, status FROM trx_fabric_process_inward WHERE fpo_id = ? ORDER BY id', [id]);
  res.json({ data: { ...o, rolls: rolls.map((r) => ({ ...r, balance_kg: Math.max(0, n(r.balance_kg)) })), inwards, reconciliation: await reconciliation(id) } });
}));

/** POST /fabric-process/outward — Save Draft (no stock moved) or Confirm DC (stock issued). */
fabricProcessingRouter.post('/fabric-process/outward', requirePermission(FP.CREATE), ah(async (req, res) => {
  const body = outwardSchema.parse(req.body);
  const confirm = Boolean(req.body?.confirm);
  if (confirm && !can(req, FP.CONFIRM)) throw Forbidden('You can save the DC as draft; confirming needs the confirm right');
  const out = await transaction(async (tx) => {
    const h = await insertOutwardHeader(tx, req, body, { status: confirm ? 'DISPATCHED' : 'DRAFT' });
    const kg = await writeOutwardRolls(tx, req, h.id, h, body.rolls, confirm);
    return { id: h.id, fpo_no: h.fpo_no, status: confirm ? 'DISPATCHED' : 'DRAFT', outward_kg: kg };
  });
  await audit(req, 'trx_fabric_process_order', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out });
}));

/** PUT /fabric-process/outward/:id — edit a DRAFT DC (header + rolls replaced). */
fabricProcessingRouter.put('/fabric-process/outward/:id', requirePermission(FP.EDIT_DRAFT), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = outwardSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!o) throw NotFound('Process DC not found');
    if (o.status !== 'DRAFT') throw BadRequest(`${o.fpo_no} is confirmed — posted DCs cannot be edited`);
    const pt = await processType(cid, body.sub_process, tx);
    await txExecute(tx,
      `UPDATE trx_fabric_process_order SET fpo_date = ?, sub_process = ?, vendor_id = ?, from_warehouse_id = ?, to_location = ?, vehicle_no = ?,
              challan_no = ?, shade_code = ?, color_name = ?, target_dia = ?, target_gsm = ?, expected_return_date = ?, remarks = ?,
              quotation_id = ?, quotation_line_id = ?, rate_per_kg = ? WHERE id = ?`,
      [body.fpo_date, pt.code, body.vendor_id, body.from_warehouse_id ?? null, body.to_location ?? null, body.vehicle_no ?? null, body.challan_no ?? null,
       body.shade_code ?? null, body.color_name ?? null, body.target_dia ?? null, body.target_gsm ?? null, body.expected_return_date ?? null, body.remarks ?? null,
       body.quotation_id ?? null, body.quotation_line_id ?? null, body.rate_per_kg ?? null, id]);
    await txExecute(tx, 'DELETE FROM trx_fabric_process_roll_in WHERE fpo_id = ?', [id]);
    const kg = await writeOutwardRolls(tx, req, id, { ...o, sub_process: pt.code, vendor_id: body.vendor_id, color_name: body.color_name }, body.rolls, false);
    return { id, fpo_no: o.fpo_no, outward_kg: kg };
  });
  await audit(req, 'trx_fabric_process_order', id, 'UPDATE', undefined, out);
  res.json({ data: out });
}));

/** POST /fabric-process/outward/:id/confirm — Confirm DC: issues every roll from the store. */
fabricProcessingRouter.post('/fabric-process/outward/:id/confirm', requirePermission(FP.CONFIRM), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const out = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!o) throw NotFound('Process DC not found');
    if (o.status !== 'DRAFT') throw BadRequest(`${o.fpo_no} is already ${o.status}`);
    const rolls = await txQuery<any>(tx, 'SELECT * FROM trx_fabric_process_roll_in WHERE fpo_id = ? ORDER BY id', [id]);
    if (!rolls.length) throw BadRequest('The DC has no rolls');
    await txExecute(tx, 'DELETE FROM trx_fabric_process_roll_in WHERE fpo_id = ?', [id]);
    const kg = await writeOutwardRolls(tx, req, id, o,
      rolls.map((r) => ({ fabric_roll_id: Number(r.fabric_roll_id), so_id: r.so_id ? Number(r.so_id) : null, weight_kg: n(r.weight_kg), meters: n(r.meters), color_name: r.color_name })), true);
    if (!o.is_reprocess) {
      const quote = await checkDcQuotation(cid, { vendor_id: Number(o.vendor_id), quotation_id: o.quotation_id, quotation_line_id: o.quotation_line_id, rate: o.rate_per_kg, label: `${o.fpo_no}` });
      await txExecute(tx, 'UPDATE trx_fabric_process_order SET rate_per_kg = ? WHERE id = ?', [quote.rate, id]);
    }
    await txExecute(tx, `UPDATE trx_fabric_process_order SET status = 'DISPATCHED', confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`, [req.user!.id, id]);
    return { id, fpo_no: o.fpo_no, outward_kg: kg };
  });
  await audit(req, 'trx_fabric_process_order', id, 'UPDATE', undefined, { confirm: out });
  res.json({ data: out, message: `${out.fpo_no} confirmed — ${out.outward_kg.toFixed(3)} KG issued` });
}));

/** POST /fabric-process/outward/:id/cancel — draft: cancelled; confirmed with nothing received: rolls back to store. */
fabricProcessingRouter.post(['/fabric-process/outward/:id/cancel', '/fabric-processing/orders/:id/cancel'], requirePermission(FP.CANCEL), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const reason = z.string().trim().max(255).optional().parse(req.body?.reason);
  const out = await transaction(async (tx) => {
    const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!o) throw NotFound('Process DC not found');
    if (o.status === 'CANCELLED') throw BadRequest(`${o.fpo_no} is already cancelled`);
    const recd = await txQueryOne<any>(tx, 'SELECT COUNT(*) AS c FROM trx_fabric_process_inward WHERE fpo_id = ? AND status <> \'CANCELLED\'', [id]);
    const recdOld = await txQueryOne<any>(tx, 'SELECT COUNT(*) AS c FROM trx_fabric_process_roll_out WHERE fpo_id = ?', [id]);
    if (Number(recd?.c) > 0 || Number(recdOld?.c) > 0) throw BadRequest(`${o.fpo_no} already has fabric received — it cannot be cancelled`);
    let returned = 0;
    if (o.status !== 'DRAFT') {
      const rolls = await txQuery<any>(tx, 'SELECT * FROM trx_fabric_process_roll_in WHERE fpo_id = ?', [id]);
      for (const r of rolls) {
        if (!r.fabric_roll_id) continue;
        const fr = await txQueryOne<any>(tx, 'SELECT id, roll_no, fabric_id, warehouse_id FROM trx_fabric_roll WHERE id = ? FOR UPDATE', [r.fabric_roll_id]);
        if (!fr) continue;
        await txExecute(tx, 'UPDATE trx_fabric_roll SET issued_kg = GREATEST(COALESCE(issued_kg, 0) - ?, 0) WHERE id = ?', [r.weight_kg, fr.id]);
        await refreshFabricRollStatus(tx, fr.id, { reopen: true });
        const wh = Number(r.warehouse_id || fr.warehouse_id) || 0;
        if (wh) {
          await postLedger(tx, { companyId: cid, warehouseId: wh, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null,
            txnType: 'RETURN', refType: 'FAB_PROC_DC_CANCEL', refId: id, qtyIn: n(r.weight_kg), uomId: UOM_KG, createdBy: req.user!.id });
        }
        await history(tx, req, { roll_id: fr.id, roll_no: fr.roll_no, event: 'DC_CANCELLED', ref_type: 'FPO', ref_id: id, ref_no: o.fpo_no,
          sub_process: o.sub_process, to: await whName(tx, wh || null), qty: n(r.weight_kg), so_id: r.so_id, remarks: reason ?? 'DC cancelled — back to store' });
        returned += n(r.weight_kg);
      }
      if (o.reprocess_id) await txExecute(tx, `UPDATE trx_fabric_reprocess SET status = 'CANCELLED' WHERE id = ?`, [o.reprocess_id]);
    }
    await txExecute(tx, `UPDATE trx_fabric_process_order SET status = 'CANCELLED', cancel_reason = ? WHERE id = ?`, [reason ?? null, id]);
    return { fpo_no: o.fpo_no, returned_kg: r3(returned) };
  });
  await audit(req, 'trx_fabric_process_order', id, 'UPDATE', undefined, { cancel: out, reason });
  res.json({ data: out, message: `${out.fpo_no} cancelled${out.returned_kg ? ` — ${out.returned_kg.toFixed(3)} KG back in store` : ''}` });
}));

// =====================================================================================
// Inward / GRN
// =====================================================================================
const inwardSchema = z.object({
  fpo_id: s.idReq(),
  inward_date: date,
  challan_no: s.nullableStr(60),
  vehicle_no: s.nullableStr(30),
  received_by: s.strReq(80),
  warehouse_id: s.idReq(),
  reject_warehouse_id: s.id(),
  gate_inward_id: s.id(),
  remarks: s.text(),
  lines: z.array(z.object({
    roll_in_id: s.idReq(),
    output_roll_no: s.nullableStr(60),
    good_kg: z.coerce.number().min(0),
    reject_kg: z.coerce.number().min(0).default(0),
    loss_kg: z.coerce.number().min(0).default(0),
    meters: z.coerce.number().min(0).default(0),
    gsm: s.nullableStr(40),
    dia: s.nullableStr(40),
    color_name: s.nullableStr(80),
    shade_no: s.nullableStr(40),
    reject_reason: s.nullableStr(120),
    qc_status: z.enum(['ACCEPTED', 'HOLD']).default('ACCEPTED'),
  })).min(1, 'Enter the received rolls'),
});

fabricProcessingRouter.get('/fabric-process/inward', requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ fpo_id: z.coerce.number().int().optional(), vendor_id: z.coerce.number().int().optional(), unbilled: z.coerce.number().int().optional() }).parse(req.query);
  const where = ['i.company_id = ?']; const p: unknown[] = [cid];
  if (q.fpo_id) { where.push('i.fpo_id = ?'); p.push(q.fpo_id); }
  if (q.vendor_id) { where.push('i.vendor_id = ?'); p.push(q.vendor_id); }
  if (q.unbilled) where.push(`i.bill_id IS NULL AND i.is_reprocess = 0 AND i.status = 'POSTED'`);
  if (req.query.posted) where.push(`i.status = 'POSTED'`);
  const rows = await query<any>(
    `SELECT i.*, o.fpo_no, v.party_name AS vendor_name, pt.name AS process_name, w.warehouse_name,
            (SELECT GROUP_CONCAT(DISTINCT ri.io_no SEPARATOR ', ') FROM trx_fabric_process_roll_out ro JOIN trx_fabric_process_roll_in ri ON ri.id = ro.roll_in_id WHERE ro.inward_id = i.id) AS jobs,
            (SELECT COUNT(*) FROM trx_fabric_process_roll_out ro WHERE ro.inward_id = i.id) AS roll_count
       FROM trx_fabric_process_inward i
       JOIN trx_fabric_process_order o ON o.id = i.fpo_id
       LEFT JOIN mst_party v ON v.id = i.vendor_id
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = i.company_id AND pt.code = i.sub_process
       LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id
      WHERE ${where.join(' AND ')} ORDER BY i.id DESC LIMIT 1000`, p);
  // drafts carry their line count in draft_json
  rows.forEach((r: any) => { if (r.status !== 'POSTED' && r.draft_json) { const d = parseDraft(r.draft_json); r.roll_count = d.lines.length; } delete r.draft_json; });
  res.json({ data: rows });
}));

fabricProcessingRouter.get('/fabric-process/inward/:id', requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const i = await queryOne<any>(
    `SELECT i.*, o.fpo_no, o.fpo_date, v.party_name AS vendor_name, pt.name AS process_name, w.warehouse_name, rw.warehouse_name AS reject_store
       FROM trx_fabric_process_inward i JOIN trx_fabric_process_order o ON o.id = i.fpo_id
       LEFT JOIN mst_party v ON v.id = i.vendor_id
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = i.company_id AND pt.code = i.sub_process
       LEFT JOIN mst_warehouse w ON w.id = i.warehouse_id LEFT JOIN mst_warehouse rw ON rw.id = i.reject_warehouse_id
      WHERE i.id = ? AND i.company_id = ?`, [id, cid]);
  if (!i) throw NotFound('Process GRN not found');
  const lines = await query<any>(
    `SELECT ro.*, ri.roll_no AS input_roll_no, ri.io_no, ri.buyer_po_no, ri.weight_kg AS input_roll_kg, ri.fabric_color, st.style_code,
            fr.roll_no AS output_roll_no_stock, ROUND(fr.weight_kg - COALESCE(fr.issued_kg, 0), 3) AS stock_balance_kg
       FROM trx_fabric_process_roll_out ro
       LEFT JOIN trx_fabric_process_roll_in ri ON ri.id = ro.roll_in_id
       LEFT JOIN mst_style st ON st.id = ri.style_id
       LEFT JOIN trx_fabric_roll fr ON fr.id = ro.fabric_roll_id
      WHERE ro.inward_id = ? ORDER BY ri.io_no, ro.id`, [id]);
  // not posted yet: the draft lines (with their input roll) + QC parameters and results
  let draft: any = null;
  if (i.status !== 'POSTED' && i.draft_json) {
    const d = parseDraft(i.draft_json);
    const rins = await query<any>(`SELECT ri.*, st.style_code, ROUND(ri.weight_kg - ri.good_kg - ri.reject_kg - ri.loss_kg, 3) AS open_kg
                                     FROM trx_fabric_process_roll_in ri LEFT JOIN mst_style st ON st.id = ri.style_id WHERE ri.fpo_id = ?`, [i.fpo_id]);
    draft = { ...d, lines: d.lines.map((l, k) => { const ri = rins.find((x) => Number(x.id) === Number(l.roll_in_id)); return { ...l, line_index: k, input_roll_no: ri?.roll_no, fabric_color: ri?.fabric_color ?? null, io_no: ri?.io_no, buyer_po_no: ri?.buyer_po_no, style_code: ri?.style_code, open_kg: n(ri?.open_kg), input_roll_kg: n(ri?.weight_kg) }; }) };
  }
  const qcParams = await query<any>('SELECT * FROM mst_fabric_process_qc_param WHERE company_id = ? AND process_code = ? AND is_active = 1 ORDER BY sort_order, id', [cid, i.sub_process]);
  const qcResults = await query<any>('SELECT * FROM trx_fabric_process_qc WHERE inward_id = ? ORDER BY line_index, id', [id]);
  const pt = await queryOne<any>('SELECT requires_qc FROM mst_fabric_process_type WHERE company_id = ? AND code = ?', [cid, i.sub_process]);
  res.json({ data: { ...i, draft_json: undefined, lines, draft, qc_params: qcParams, qc_results: qcResults, requires_qc: !!Number(pt?.requires_qc), reconciliation: await reconciliation(Number(i.fpo_id)) } });
}));

/**
 * POST /fabric-process/inward — Process GRN against a DC: per input roll one or more output rolls
 * with good / reject / loss KG (good + reject + loss ≤ input). Good rolls go to the processed store
 * (state from the process type, colour, the input roll's job); reject KG to the reject store.
 */
type InwardBody = z.infer<typeof inwardSchema>;

/** Loads the DC + process type and validates GRN lines (good + reject + loss ≤ what is still open per input roll). */
async function checkInward(tx: Tx, req: Request, body: InwardBody) {
  const cid = req.user!.companyId;
  const o = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [body.fpo_id, cid]);
  if (!o) throw NotFound('Process DC not found');
  if (!['DISPATCHED', 'IN_PROCESS', 'PARTIALLY_RECEIVED'].includes(o.status)) throw BadRequest(`${o.fpo_no} is ${o.status} — nothing to receive`);
  const pt = await processType(cid, o.sub_process, tx);
  const rollIns = await txQuery<any>(tx, 'SELECT * FROM trx_fabric_process_roll_in WHERE fpo_id = ? FOR UPDATE', [o.id]);
  const byId = new Map(rollIns.map((r) => [Number(r.id), r]));

  // validate per input roll: good + reject + loss (this GRN + earlier) ≤ input KG; reject needs a reason
  const add = new Map<number, { g: number; rj: number; l: number }>();
  for (const l of body.lines) {
    const ri = byId.get(l.roll_in_id);
    if (!ri) throw BadRequest('A line is not a roll of this DC');
    if (l.good_kg + l.reject_kg + l.loss_kg <= 0) throw BadRequest(`Roll ${ri.roll_no}: enter good, reject or loss KG`);
    if (l.reject_kg > 0 && !l.reject_reason) throw BadRequest(`Roll ${ri.roll_no}: reject KG needs a reason`);
    const a = add.get(l.roll_in_id) ?? { g: 0, rj: 0, l: 0 };
    a.g += l.good_kg; a.rj += l.reject_kg; a.l += l.loss_kg; add.set(l.roll_in_id, a);
  }
  if (!pt.allow_split) {
    const counts = new Map<number, number>();
    body.lines.filter((l) => l.good_kg > 0).forEach((l) => counts.set(l.roll_in_id, (counts.get(l.roll_in_id) ?? 0) + 1));
    if ([...counts.values()].some((c) => c > 1)) throw BadRequest(`${pt.name} does not allow splitting a roll into several output rolls`);
  }
  for (const [rid, a] of add) {
    const ri = byId.get(rid)!;
    const done = n(ri.good_kg) + n(ri.reject_kg) + n(ri.loss_kg);
    if (done + a.g + a.rj + a.l > n(ri.weight_kg) + EPS) {
      throw BadRequest(`Roll ${ri.roll_no}: good + reject + loss ${r3(done + a.g + a.rj + a.l)} KG is more than the ${r3(n(ri.weight_kg))} KG sent`);
    }
  }

  return { o, pt, byId, add, rollIns };
}

/** Posts a process GRN (stock, rolls, ledger, DC status) — directly, or a draft that passed QC (`existing`). */
async function postInward(tx: Tx, req: Request, body: InwardBody, existing?: { id: number; inward_no: string }) {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const { o, pt, byId, add, rollIns } = await checkInward(tx, req, body);
  const inwardNo = existing?.inward_no ?? await nextDocNumber(tx, cid, 'FP_INWARD');
  const totG = r3(body.lines.reduce((s, l) => s + l.good_kg, 0));
  const totR = r3(body.lines.reduce((s, l) => s + l.reject_kg, 0));
  const totL = r3(body.lines.reduce((s, l) => s + l.loss_kg, 0));
  const rejectWh = body.reject_warehouse_id ?? body.warehouse_id;
  const gate = await useGateEntry(tx, cid, { gate_inward_id: body.gate_inward_id, party_id: o.vendor_id, label: `GRN on ${o.fpo_no}` });
  // Stock GRN the rolls hang off (fabric roll stock / cutting read trx_fabric_roll via trx_grn)
  const g = await txExecute(tx,
    `INSERT INTO trx_grn (company_id, grn_no, internal_ir_no, grn_date, supplier_id, warehouse_id, supplier_dc_no, vehicle_no, qc_status, remarks, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, inwardNo, o.io_no ?? null, body.inward_date, o.vendor_id ?? null, body.warehouse_id, body.challan_no ?? null, body.vehicle_no ?? null,
     totR > 0 ? 'PARTIAL_ACCEPTED' : 'ACCEPTED', `${pt.name} inward on ${o.fpo_no}`, uid]);
  const grnId = Number(g.insertId);
  let inwardId: number;
  if (existing) {
    await txExecute(tx,
      `UPDATE trx_fabric_process_inward SET inward_date = ?, challan_no = ?, vehicle_no = ?, received_by = ?, warehouse_id = ?, reject_warehouse_id = ?, grn_id = ?,
              input_kg = ?, good_kg = ?, reject_kg = ?, loss_kg = ?, remarks = ?, status = 'POSTED', posted_by = ?, posted_at = NOW() WHERE id = ?`,
      [body.inward_date, body.challan_no ?? null, body.vehicle_no ?? null, body.received_by, body.warehouse_id, rejectWh, grnId,
       r3(totG + totR + totL), totG, totR, totL, body.remarks ?? null, uid, existing.id]);
    inwardId = existing.id;
  } else {
    const ins = await txExecute(tx,
      `INSERT INTO trx_fabric_process_inward (company_id, inward_no, inward_date, fpo_id, vendor_id, sub_process, challan_no, vehicle_no, received_by,
         warehouse_id, reject_warehouse_id, grn_id, input_kg, good_kg, reject_kg, loss_kg, is_reprocess, remarks, created_by, status, posted_by, posted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'POSTED',?,NOW())`,
      [cid, inwardNo, body.inward_date, o.id, o.vendor_id ?? null, o.sub_process, body.challan_no ?? null, body.vehicle_no ?? null, body.received_by,
       body.warehouse_id, rejectWh, grnId, r3(totG + totR + totL), totG, totR, totL, o.is_reprocess ? 1 : 0, body.remarks ?? null, uid, uid]);
    inwardId = Number(ins.insertId);
  }
  if (gate) await txExecute(tx, 'UPDATE trx_fabric_process_inward SET gate_inward_id = ? WHERE id = ?', [gate.id, inwardId]);

  // one GRN line per job + fabric (stock grouping), created on demand
  const grnLines = new Map<string, number>();
  const grnLineFor = async (ri: any, colour: string | null) => {
    const k = `${ri.so_id ?? 0}|${ri.fabric_id ?? 0}|${colour ?? ''}`;
    if (grnLines.has(k)) return grnLines.get(k)!;
    const gl = await txExecute(tx,
      `INSERT INTO trx_grn_line (grn_id, so_id, style_id, material_type, fabric_id, fabric_category, color_name, lot_no, qc_status,
         received_qty, received_weight, no_of_rolls, accepted_qty, rejected_qty, balance_qty, uom_id)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,0,0,?)`,
      [grnId, ri.so_id ?? null, ri.style_id ?? null, 'FABRIC', ri.fabric_id ?? null, pt.output_state === 'DYED' ? 'Dyed Fabric' : 'Grey Fabric', colour,
       `${o.fpo_no}-${inwardNo}`, 'ACCEPTED', UOM_KG]);
    grnLines.set(k, Number(gl.insertId));
    return Number(gl.insertId);
  };

  const vendor = await partyName(tx, o.vendor_id);
  const goodStore = await whName(tx, body.warehouse_id);
  const rejStore = await whName(tx, rejectWh);
  let seq = 0;
  const created: any[] = [];
  for (const l of body.lines) {
    const ri = byId.get(l.roll_in_id)!;
    const colour = l.color_name || ri.color_name || o.color_name || null;
    const glId = await grnLineFor(ri, colour);
    const src = ri.fabric_roll_id ? await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ?', [ri.fabric_roll_id]) : null;
    let goodRollId: number | null = null;
    let rejectRollId: number | null = null;
    const outNo = l.output_roll_no || `${inwardNo}-${String(++seq).padStart(2, '0')}`;
    if (l.good_kg > 0) {
      // GSM / Dia / meter of the processed roll: target = the GSM entered on the GRN (finished GSM) else the input roll's;
      // a measured meter gives the actual GSM. Recorded with the variance (the process QC decides hold / reject).
      const c = await calcRollFor(cid, {
        fabric_id: ri.fabric_id ?? src?.fabric_id ?? null, weight_kg: r3(l.good_kg), on: body.inward_date,
        target_gsm: Number.parseFloat(String(l.gsm ?? '')) || Number(src?.target_gsm) || Number.parseFloat(String(ri.gsm ?? '')) || null,
        dia: l.dia ?? ri.dia ?? null, fabric_form: src?.fabric_form ?? null, actual_meters: l.meters || null,
      }, tx);
      const fr = await txExecute(tx,
        `INSERT INTO trx_fabric_roll (company_id, grn_id, grn_line_id, fabric_id, roll_no, lot_no, meters, weight_kg, gsm, dia, shade,
           warehouse_id, qc_status, stock_status, remarks, process_state, color_name, source_fpo_id, so_id, parent_roll_id, ${ROLL_CALC_COLS})
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, grnId, glId, ri.fabric_id ?? src?.fabric_id ?? null, outNo, src?.lot_no ?? null, c.meters ?? (l.meters || null), r3(l.good_kg),
         Number.parseInt(String(l.gsm ?? ri.gsm ?? ''), 10) || null, l.dia ?? ri.dia ?? null, l.shade_no ?? o.shade_code ?? colour,
         body.warehouse_id, l.qc_status, l.qc_status === 'ACCEPTED' ? 'AVAILABLE' : 'RESERVED', `${pt.name} on ${o.fpo_no}`,
         pt.output_state, colour, o.id, ri.so_id ?? null, ri.fabric_roll_id ?? null, ...rollCalcVals(c)]);
      goodRollId = Number(fr.insertId);
      await history(tx, req, { roll_id: goodRollId, roll_no: outNo, event: o.is_reprocess ? 'REPROCESS_INWARD' : 'PROCESS_INWARD', ref_type: 'FPI', ref_id: inwardId,
        ref_no: inwardNo, sub_process: o.sub_process, from: vendor, to: goodStore, qty: l.good_kg, so_id: ri.so_id, related_roll_id: ri.fabric_roll_id,
        remarks: `${pt.output_state}${colour ? ` — ${colour}` : ''} from ${ri.roll_no}` });
    }
    if (l.reject_kg > 0) {
      const rr = await txExecute(tx,
        `INSERT INTO trx_fabric_roll (company_id, grn_id, grn_line_id, fabric_id, roll_no, lot_no, meters, weight_kg, gsm, dia, shade,
           warehouse_id, qc_status, stock_status, remarks, process_state, color_name, source_fpo_id, so_id, parent_roll_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'REJECTED','RESERVED',?,'RETURNED',?,?,?,?)`,
        [cid, grnId, glId, ri.fabric_id ?? null, `${outNo}-RJ`, src?.lot_no ?? null, null, r3(l.reject_kg),
         Number.parseInt(String(l.gsm ?? ri.gsm ?? ''), 10) || null, l.dia ?? ri.dia ?? null, colour,
         rejectWh, `Reject: ${l.reject_reason}`, colour, o.id, ri.so_id ?? null, ri.fabric_roll_id ?? null]);
      rejectRollId = Number(rr.insertId);
      await history(tx, req, { roll_id: rejectRollId, roll_no: `${outNo}-RJ`, event: 'REJECT', ref_type: 'FPI', ref_id: inwardId, ref_no: inwardNo,
        sub_process: o.sub_process, from: vendor, to: rejStore, qty: l.reject_kg, so_id: ri.so_id, related_roll_id: ri.fabric_roll_id, remarks: l.reject_reason });
    }
    if (l.loss_kg > 0 && ri.fabric_roll_id) {
      await history(tx, req, { roll_id: ri.fabric_roll_id, roll_no: ri.roll_no, event: 'PROCESS_LOSS', ref_type: 'FPI', ref_id: inwardId, ref_no: inwardNo,
        sub_process: o.sub_process, from: vendor, qty: l.loss_kg, so_id: ri.so_id, remarks: 'Process loss' });
    }
    await txExecute(tx,
      `INSERT INTO trx_fabric_process_roll_out (company_id, fpo_id, inward_id, roll_in_id, so_id, roll_no, lot_no, io_no, style_id, fabric_id, finish_date,
         dia, gsm, meters, weight_kg, input_kg, reject_kg, loss_kg, color_name, shade_no, reject_reason, qc_status, fabric_roll_id, reject_roll_id, grn_id, party_dc_no)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, o.id, inwardId, ri.id, ri.so_id ?? null, outNo, src?.lot_no ?? outNo, ri.io_no || 'STOCK', ri.style_id ?? null, ri.fabric_id ?? null, body.inward_date,
       l.dia ?? ri.dia ?? null, l.gsm ?? ri.gsm ?? null, l.meters, r3(l.good_kg), r3(l.good_kg + l.reject_kg + l.loss_kg), r3(l.reject_kg), r3(l.loss_kg),
       colour, l.shade_no ?? null, l.reject_reason ?? null, l.qc_status, goodRollId, rejectRollId, grnId, body.challan_no ?? null]);
    // GRN line totals
    await txExecute(tx,
      `UPDATE trx_grn_line SET received_qty = received_qty + ?, received_weight = received_weight + ?, accepted_qty = accepted_qty + ?,
              rejected_qty = rejected_qty + ?, no_of_rolls = no_of_rolls + ? WHERE id = ?`,
      [r3(l.good_kg + l.reject_kg), r3(l.good_kg + l.reject_kg), r3(l.good_kg), r3(l.reject_kg), l.good_kg > 0 ? 1 : 0, glId]);
    created.push({ input_roll: ri.roll_no, output_roll: outNo, good_kg: l.good_kg, reject_kg: l.reject_kg, loss_kg: l.loss_kg, roll_id: goodRollId, reject_roll_id: rejectRollId });
  }

  // input rolls: accounted KG + status
  for (const [rid, a] of add) {
    const ri = byId.get(rid)!;
    const done = n(ri.good_kg) + n(ri.reject_kg) + n(ri.loss_kg) + a.g + a.rj + a.l;
    await txExecute(tx,
      `UPDATE trx_fabric_process_roll_in SET good_kg = good_kg + ?, reject_kg = reject_kg + ?, loss_kg = loss_kg + ?, status = ? WHERE id = ?`,
      [r3(a.g), r3(a.rj), r3(a.l), done + EPS >= n(ri.weight_kg) ? 'RECEIVED' : 'PARTIAL', rid]);
  }

  // stock ledger: good into the processed store, reject into the reject store
  const fabricId = Number(rollIns[0]?.fabric_id) || null;
  if (totG > 0) await postLedger(tx, { companyId: cid, warehouseId: body.warehouse_id, materialType: 'FABRIC', fabricId, txnType: 'PRODUCTION_IN', refType: 'FAB_PROC_GRN', refId: inwardId, qtyIn: totG, uomId: UOM_KG, createdBy: uid });
  if (totR > 0) await postLedger(tx, { companyId: cid, warehouseId: rejectWh, materialType: 'FABRIC', fabricId, txnType: 'PRODUCTION_IN', refType: 'FAB_PROC_REJECT', refId: inwardId, qtyIn: totR, uomId: UOM_KG, createdBy: uid });

  // DC status: fully received when every roll is accounted
  const left = await txQueryOne<any>(tx, `SELECT COUNT(*) AS c FROM trx_fabric_process_roll_in WHERE fpo_id = ? AND status <> 'RECEIVED'`, [o.id]);
  const fpoStatus = Number(left?.c) === 0 ? 'COMPLETED' : 'PARTIALLY_RECEIVED';
  const agg = await txQueryOne<any>(tx, 'SELECT SUM(weight_kg) w, SUM(good_kg) g, SUM(reject_kg) r, SUM(loss_kg) l FROM trx_fabric_process_roll_in WHERE fpo_id = ?', [o.id]);
  await txExecute(tx, `UPDATE trx_fabric_process_order SET status = ?, output_weight_kg = ?, process_loss_kg = ?, process_loss_pct = ? WHERE id = ?`,
    [fpoStatus, r3(n(agg?.g)), r3(n(agg?.l)), n(agg?.w) > 0 ? r2((n(agg?.l) / n(agg?.w)) * 100) : 0, o.id]);
  if (o.reprocess_id) await txExecute(tx, `UPDATE trx_fabric_reprocess SET status = ? WHERE id = ?`, [fpoStatus === 'COMPLETED' ? 'COMPLETED' : 'IN_PROCESS', o.reprocess_id]);

  return { id: inwardId, inward_no: inwardNo, fpo_no: o.fpo_no, fpo_status: fpoStatus, good_kg: totG, reject_kg: totR, loss_kg: totL, rolls: created };
}

/**
 * POST /fabric-process/inward — Process GRN (doc §6, §16). action:
 *   POST (default)  post now (not allowed for a process type that requires QC);
 *   DRAFT / QC      save as Draft / send for QC — no stock moves until it is posted.
 */
fabricProcessingRouter.post('/fabric-process/inward', requirePermission(FP.CREATE), ah(async (req, res) => {
  const body = inwardSchema.parse(req.body);
  const action = String(req.body?.action ?? 'POST').toUpperCase();
  if (action === 'DRAFT' || action === 'QC') {
    const out = await transaction(async (tx) => {
      const { o } = await checkInward(tx, req, body);
      return saveInwardDraft(tx, req, body, o, action === 'QC' ? 'QC_PENDING' : 'DRAFT');
    });
    await audit(req, 'trx_fabric_process_inward', out.id, 'INSERT', undefined, out);
    res.status(201).json({ data: out, message: `${out.inward_no} ${out.status === 'QC_PENDING' ? 'sent for QC' : 'saved as draft'}` });
    return;
  }
  if (!can(req, FP.CONFIRM)) throw Forbidden('You can save the GRN as draft; posting needs the confirm right');
  const out = await transaction(async (tx) => {
    const { pt } = await checkInward(tx, req, body);
    if (pt.requires_qc) throw BadRequest(`${pt.name} requires QC — save the GRN and send it for QC before posting`);
    return postInward(tx, req, body);
  });
  await audit(req, 'trx_fabric_process_inward', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.inward_no} posted — good ${out.good_kg} KG, reject ${out.reject_kg} KG, loss ${out.loss_kg} KG` });
}));

/** Saves / replaces a GRN draft (lines kept in draft_json, totals for the register). */
async function saveInwardDraft(tx: Tx, req: Request, body: InwardBody, o: any, status: 'DRAFT' | 'QC_PENDING', existingId?: number) {
  const cid = req.user!.companyId;
  const tot = (k: 'good_kg' | 'reject_kg' | 'loss_kg') => r3(body.lines.reduce((a, l) => a + n(l[k]), 0));
  const json = JSON.stringify({ ...body, lines: body.lines.map((l) => ({ ...l, qc: null })) });
  if (existingId) {
    await txExecute(tx,
      `UPDATE trx_fabric_process_inward SET inward_date = ?, challan_no = ?, vehicle_no = ?, received_by = ?, warehouse_id = ?, reject_warehouse_id = ?,
              input_kg = ?, good_kg = ?, reject_kg = ?, loss_kg = ?, remarks = ?, draft_json = ?, status = ?, qc_by = NULL, qc_at = NULL WHERE id = ?`,
      [body.inward_date, body.challan_no ?? null, body.vehicle_no ?? null, body.received_by, body.warehouse_id, body.reject_warehouse_id ?? body.warehouse_id,
       r3(tot('good_kg') + tot('reject_kg') + tot('loss_kg')), tot('good_kg'), tot('reject_kg'), tot('loss_kg'), body.remarks ?? null, json, status, existingId]);
    await txExecute(tx, 'DELETE FROM trx_fabric_process_qc WHERE inward_id = ?', [existingId]);
    const r = await txQueryOne<any>(tx, 'SELECT inward_no FROM trx_fabric_process_inward WHERE id = ?', [existingId]);
    return { id: existingId, inward_no: r.inward_no, status };
  }
  const no = await nextDocNumber(tx, cid, 'FP_INWARD');
  const ins = await txExecute(tx,
    `INSERT INTO trx_fabric_process_inward (company_id, inward_no, inward_date, fpo_id, vendor_id, sub_process, challan_no, vehicle_no, received_by,
       warehouse_id, reject_warehouse_id, input_kg, good_kg, reject_kg, loss_kg, is_reprocess, remarks, created_by, status, draft_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [cid, no, body.inward_date, o.id, o.vendor_id ?? null, o.sub_process, body.challan_no ?? null, body.vehicle_no ?? null, body.received_by,
     body.warehouse_id, body.reject_warehouse_id ?? body.warehouse_id, r3(tot('good_kg') + tot('reject_kg') + tot('loss_kg')), tot('good_kg'), tot('reject_kg'), tot('loss_kg'),
     o.is_reprocess ? 1 : 0, body.remarks ?? null, req.user!.id, status, json]);
  return { id: Number(ins.insertId), inward_no: no, status };
}

type DraftLine = InwardBody['lines'][number] & { qc?: any };
const parseDraft = (x: any) => (typeof x === 'string' ? JSON.parse(x) : x) as Omit<InwardBody, 'lines'> & { lines: DraftLine[] };
const DRAFT_STATES = ['DRAFT', 'QC_PENDING', 'ACCEPTED', 'PARTIAL', 'REJECTED'];

/** PUT /fabric-process/inward/:id — edit a GRN that is not posted yet (QC starts again). */
fabricProcessingRouter.put('/fabric-process/inward/:id', requirePermission(FP.EDIT_DRAFT), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = inwardSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const i = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_inward WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!i) throw NotFound('Process GRN not found');
    if (!DRAFT_STATES.includes(i.status)) throw BadRequest(`${i.inward_no} is ${i.status} — posted GRNs cannot be edited`);
    if (Number(body.fpo_id) !== Number(i.fpo_id)) throw BadRequest('The outward DC of a GRN cannot change');
    const { o } = await checkInward(tx, req, body);
    return saveInwardDraft(tx, req, body, o, String(req.body?.action ?? '').toUpperCase() === 'QC' ? 'QC_PENDING' : 'DRAFT', id);
  });
  await audit(req, 'trx_fabric_process_inward', id, 'UPDATE', undefined, out);
  res.json({ data: out, message: `${out.inward_no} saved` });
}));

/** POST /fabric-process/inward/:id/submit-qc — Draft → QC Pending. */
fabricProcessingRouter.post('/fabric-process/inward/:id/submit-qc', requirePermission(FP.CREATE), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const i = await queryOne<any>('SELECT * FROM trx_fabric_process_inward WHERE id = ? AND company_id = ?', [id, cid]);
  if (!i) throw NotFound('Process GRN not found');
  if (i.status !== 'DRAFT') throw BadRequest(`${i.inward_no} is ${i.status}`);
  await query(`UPDATE trx_fabric_process_inward SET status = 'QC_PENDING' WHERE id = ?`, [id]);
  await audit(req, 'trx_fabric_process_inward', id, 'UPDATE', { status: 'DRAFT' }, { status: 'QC_PENDING' });
  res.json({ message: `${i.inward_no} sent for QC` });
}));

/**
 * POST /fabric-process/inward/:id/qc — QC result per output roll: the process type's QC parameters
 * (value vs min / max → PASS / FAIL) and the roll's status (Accepted / Hold / Rejected).
 * A roll with a failed parameter cannot be accepted. GRN → Accepted / Partial / Rejected.
 */
fabricProcessingRouter.post('/fabric-process/inward/:id/qc', requirePermission(FP.QC), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = z.object({
    remarks: s.nullableStr(255),
    results: z.array(z.object({
      line_index: z.coerce.number().int().min(0),
      qc_status: z.enum(['ACCEPTED', 'HOLD', 'REJECTED']).optional(),
      values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).default({}),
      remarks: s.nullableStr(255),
    })).min(1),
  }).parse(req.body);
  const out = await transaction(async (tx) => {
    const i = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_inward WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!i) throw NotFound('Process GRN not found');
    if (!['QC_PENDING', 'ACCEPTED', 'PARTIAL', 'REJECTED'].includes(i.status)) throw BadRequest(`${i.inward_no} is ${i.status} — send it for QC first`);
    const d = parseDraft(i.draft_json);
    const params = await txQuery<any>(tx, 'SELECT * FROM mst_fabric_process_qc_param WHERE company_id = ? AND process_code = ? AND is_active = 1 ORDER BY sort_order, id', [cid, i.sub_process]);
    await txExecute(tx, 'DELETE FROM trx_fabric_process_qc WHERE inward_id = ?', [id]);
    const good = d.lines.map((l, k) => ({ k, l })).filter((x) => n(x.l.good_kg) > 0);
    for (const x of good) {
      const r = b.results.find((y) => y.line_index === x.k);
      if (!r) throw BadRequest(`Output roll ${x.l.output_roll_no || `#${x.k + 1}`}: enter its QC result`);
      const fails: string[] = [];
      for (const p of params) {
        const raw = r.values[String(p.id)];
        const v = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        if (v === null && p.is_mandatory) throw BadRequest(`Output roll ${x.l.output_roll_no || `#${x.k + 1}`}: ${p.param_name} is required`);
        const fail = v !== null && ((p.min_value !== null && v < Number(p.min_value)) || (p.max_value !== null && v > Number(p.max_value)));
        if (fail) fails.push(p.param_name);
        await txExecute(tx,
          `INSERT INTO trx_fabric_process_qc (inward_id, line_index, output_roll_no, param_id, param_name, value, min_value, max_value, result, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, x.k, x.l.output_roll_no ?? null, p.id, p.param_name, v, p.min_value, p.max_value, v === null ? 'NA' : fail ? 'FAIL' : 'PASS', req.user!.id]);
      }
      const status = r.qc_status ?? (fails.length ? 'REJECTED' : 'ACCEPTED');
      if (status === 'ACCEPTED' && fails.length) throw BadRequest(`Output roll ${x.l.output_roll_no || `#${x.k + 1}`}: ${fails.join(', ')} out of range — mark it Hold or Rejected`);
      d.lines[x.k].qc = { status, fails, remarks: r.remarks ?? null, values: r.values };
    }
    const st = good.map((x) => d.lines[x.k].qc.status);
    const head = st.every((x) => x === 'ACCEPTED') ? 'ACCEPTED' : st.every((x) => x === 'REJECTED') ? 'REJECTED' : 'PARTIAL';
    await txExecute(tx, 'UPDATE trx_fabric_process_inward SET draft_json = ?, status = ?, qc_by = ?, qc_at = NOW(), qc_remarks = ? WHERE id = ?',
      [JSON.stringify(d), head, req.user!.id, b.remarks ?? null, id]);
    return { inward_no: i.inward_no, status: head, accepted: st.filter((x) => x === 'ACCEPTED').length, hold: st.filter((x) => x === 'HOLD').length, rejected: st.filter((x) => x === 'REJECTED').length };
  });
  await audit(req, 'trx_fabric_process_inward', id, 'UPDATE', undefined, { qc: out });
  res.json({ data: out, message: `${out.inward_no} QC: ${out.status.toLowerCase()} (${out.accepted} accepted, ${out.hold} hold, ${out.rejected} rejected)` });
}));

/** POST /fabric-process/inward/:id/post — post a draft / QC'd GRN: QC-rejected rolls go to the reject store, hold rolls stay on hold. */
fabricProcessingRouter.post('/fabric-process/inward/:id/post', requirePermission(FP.CONFIRM), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const out = await transaction(async (tx) => {
    const i = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_inward WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!i) throw NotFound('Process GRN not found');
    if (i.status === 'POSTED') throw BadRequest(`${i.inward_no} is already posted`);
    if (i.status === 'QC_PENDING') throw BadRequest(`${i.inward_no} is waiting for QC`);
    if (!DRAFT_STATES.includes(i.status)) throw BadRequest(`${i.inward_no} is ${i.status}`);
    const pt = await processType(cid, i.sub_process, tx);
    if (pt.requires_qc && i.status === 'DRAFT') throw BadRequest(`${pt.name} requires QC — send the GRN for QC first`);
    const d = parseDraft(i.draft_json);
    const lines = d.lines.map((l) => {
      const qc = l.qc;
      if (qc?.status === 'REJECTED' && n(l.good_kg) > 0) {
        return { ...l, reject_kg: r3(n(l.reject_kg) + n(l.good_kg)), good_kg: 0, reject_reason: l.reject_reason || `QC rejected${qc.fails?.length ? `: ${qc.fails.join(', ')}` : ''}`, qc_status: 'ACCEPTED' as const };
      }
      return { ...l, qc_status: qc?.status === 'HOLD' ? 'HOLD' as const : 'ACCEPTED' as const };
    });
    const body = inwardSchema.parse({ ...d, lines });
    return postInward(tx, req, body, { id, inward_no: i.inward_no });
  });
  await audit(req, 'trx_fabric_process_inward', id, 'UPDATE', undefined, { post: out });
  res.json({ data: out, message: `${out.inward_no} posted — good ${out.good_kg} KG, reject ${out.reject_kg} KG, loss ${out.loss_kg} KG` });
}));

/** POST /fabric-process/inward/:id/cancel — drop a GRN that is not posted. */
fabricProcessingRouter.post('/fabric-process/inward/:id/cancel', requirePermission(FP.EDIT_DRAFT), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const i = await queryOne<any>('SELECT * FROM trx_fabric_process_inward WHERE id = ? AND company_id = ?', [id, cid]);
  if (!i) throw NotFound('Process GRN not found');
  if (!DRAFT_STATES.includes(i.status)) throw BadRequest(`${i.inward_no} is ${i.status} — posted GRNs cannot be cancelled`);
  await query(`UPDATE trx_fabric_process_inward SET status = 'CANCELLED' WHERE id = ?`, [id]);
  await audit(req, 'trx_fabric_process_inward', id, 'UPDATE', { status: i.status }, { status: 'CANCELLED' });
  res.json({ message: `${i.inward_no} cancelled` });
}));

// =====================================================================================
// Process Return
// =====================================================================================
const returnSchema = z.object({
  return_date: date,
  inward_id: s.id(),
  return_type: z.enum(['QUALITY_REJECT', 'REPROCESS', 'OTHER']).default('QUALITY_REJECT'),
  reason_id: s.idReq(),
  warehouse_id: s.idReq(),
  remarks: s.text(),
  lines: z.array(z.object({
    source_roll_id: s.idReq(),
    qty_kg: z.coerce.number().positive(),
    defect_reason: s.nullableStr(120),
  })).min(1, 'Pick the rolls to return'),
});

fabricProcessingRouter.get('/fabric-process/returns', requirePermission(FP.VIEW), ah(async (req, res) => {
  const rows = await query<any>(
    `SELECT r.*, i.inward_no, o.fpo_no, v.party_name AS vendor_name, rs.reason, w.warehouse_name,
            (SELECT GROUP_CONCAT(DISTINCT COALESCE(so.io_no, so.so_no) SEPARATOR ', ') FROM trx_fabric_process_return_line rl LEFT JOIN trx_sales_order so ON so.id = rl.so_id WHERE rl.return_id = r.id) AS jobs
       FROM trx_fabric_process_return r
       LEFT JOIN trx_fabric_process_inward i ON i.id = r.inward_id
       LEFT JOIN trx_fabric_process_order o ON o.id = r.fpo_id
       LEFT JOIN mst_party v ON v.id = r.vendor_id
       LEFT JOIN mst_fabric_process_reason rs ON rs.id = r.reason_id
       LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id
      WHERE r.company_id = ? ORDER BY r.id DESC LIMIT 1000`, [req.user!.companyId]);
  res.json({ data: rows });
}));

fabricProcessingRouter.get('/fabric-process/returns/:id', requirePermission(FP.VIEW), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const r = await queryOne<any>(
    `SELECT r.*, i.inward_no, o.fpo_no, v.party_name AS vendor_name, rs.reason, w.warehouse_name
       FROM trx_fabric_process_return r LEFT JOIN trx_fabric_process_inward i ON i.id = r.inward_id
       LEFT JOIN trx_fabric_process_order o ON o.id = r.fpo_id LEFT JOIN mst_party v ON v.id = r.vendor_id
       LEFT JOIN mst_fabric_process_reason rs ON rs.id = r.reason_id LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id
      WHERE r.id = ? AND r.company_id = ?`, [id, req.user!.companyId]);
  if (!r) throw NotFound('Return not found');
  const lines = await query<any>(
    `SELECT rl.*, COALESCE(so.io_no, so.so_no) AS io_no, fr.warehouse_id AS return_store_id,
            ROUND(COALESCE(rf.weight_kg, 0) - COALESCE(rf.issued_kg, 0), 3) AS eligible_kg
       FROM trx_fabric_process_return_line rl LEFT JOIN trx_sales_order so ON so.id = rl.so_id
       LEFT JOIN trx_fabric_roll fr ON fr.id = rl.source_roll_id LEFT JOIN trx_fabric_roll rf ON rf.id = rl.return_roll_id
      WHERE rl.return_id = ? ORDER BY rl.id`, [id]);
  res.json({ data: { ...r, lines } });
}));

/**
 * POST /fabric-process/returns — quality issue on processed rolls (against a GRN): the returned KG
 * leaves the processed roll and goes to the return store as a RETURNED roll (eligible for reprocess).
 */
fabricProcessingRouter.post('/fabric-process/returns', requirePermission(FP.RETURN), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = returnSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const inw = body.inward_id ? await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_inward WHERE id = ? AND company_id = ?', [body.inward_id, cid]) : null;
    if (body.inward_id && !inw) throw BadRequest('Original GRN not found');
    if (inw && inw.status !== 'POSTED') throw BadRequest(`GRN ${inw.inward_no} is not posted yet`);
    const returnNo = await nextDocNumber(tx, cid, 'FP_RETURN');
    const toStore = await whName(tx, body.warehouse_id);
    const r = await txExecute(tx,
      `INSERT INTO trx_fabric_process_return (company_id, return_no, return_date, inward_id, fpo_id, vendor_id, sub_process, return_type, reason_id, warehouse_id, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, returnNo, body.return_date, inw?.id ?? null, inw?.fpo_id ?? null, inw?.vendor_id ?? null, inw?.sub_process ?? null, body.return_type,
       body.reason_id, body.warehouse_id, 'CONFIRMED', body.remarks ?? null, req.user!.id]);
    const returnId = Number(r.insertId);
    let total = 0;
    const seen = new Set<number>();
    for (const l of body.lines) {
      if (seen.has(l.source_roll_id)) throw BadRequest('The same roll is returned twice');
      seen.add(l.source_roll_id);
      const fr = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ? FOR UPDATE', [l.source_roll_id, cid]);
      if (!fr) throw BadRequest('Roll not found');
      if (!fr.source_fpo_id) throw BadRequest(`Roll ${fr.roll_no} is not a processed roll`);
      if (inw && Number(fr.grn_id) !== Number(inw.grn_id)) throw BadRequest(`Roll ${fr.roll_no} is not from GRN ${inw.inward_no}`);
      const avail = n(fr.weight_kg) - n(fr.issued_kg);
      if (l.qty_kg > avail + 1e-9) throw BadRequest(`Roll ${fr.roll_no} has only ${avail.toFixed(3)} KG left`);
      await txExecute(tx, 'UPDATE trx_fabric_roll SET issued_kg = COALESCE(issued_kg, 0) + ? WHERE id = ?', [r3(l.qty_kg), fr.id]);
      await refreshFabricRollStatus(tx, fr.id);
      const rr = await txExecute(tx,
        `INSERT INTO trx_fabric_roll (company_id, grn_id, grn_line_id, fabric_id, roll_no, lot_no, meters, weight_kg, gsm, dia, shade,
           warehouse_id, qc_status, stock_status, remarks, process_state, color_name, source_fpo_id, so_id, parent_roll_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'REJECTED','RESERVED',?,'RETURNED',?,?,?,?)`,
        [cid, fr.grn_id, fr.grn_line_id, fr.fabric_id, `${fr.roll_no}-R`, fr.lot_no, n(fr.weight_kg) > 0 ? r2(n(fr.meters) * l.qty_kg / n(fr.weight_kg)) : null,
         r3(l.qty_kg), fr.gsm, fr.dia, fr.shade, body.warehouse_id, `Returned on ${returnNo}: ${l.defect_reason ?? ''}`, fr.color_name, fr.source_fpo_id, fr.so_id, fr.id]);
      const returnRollId = Number(rr.insertId);
      await txExecute(tx,
        `INSERT INTO trx_fabric_process_return_line (return_id, source_roll_id, return_roll_id, so_id, roll_no, color_name, qty_kg, meters, defect_reason)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [returnId, fr.id, returnRollId, fr.so_id ?? null, fr.roll_no, fr.color_name ?? null, r3(l.qty_kg), 0, l.defect_reason ?? null]);
      if (fr.warehouse_id) await postLedger(tx, { companyId: cid, warehouseId: Number(fr.warehouse_id), materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null, txnType: 'ISSUE', refType: 'FAB_PROC_RETURN', refId: returnId, qtyOut: r3(l.qty_kg), uomId: UOM_KG, createdBy: req.user!.id });
      await postLedger(tx, { companyId: cid, warehouseId: body.warehouse_id, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null, txnType: 'RETURN', refType: 'FAB_PROC_RETURN', refId: returnId, qtyIn: r3(l.qty_kg), uomId: UOM_KG, createdBy: req.user!.id });
      await history(tx, req, { roll_id: fr.id, roll_no: fr.roll_no, event: 'RETURN', ref_type: 'FPR', ref_id: returnId, ref_no: returnNo, sub_process: inw?.sub_process ?? null,
        from: await whName(tx, fr.warehouse_id ? Number(fr.warehouse_id) : null), to: toStore, qty: l.qty_kg, so_id: fr.so_id, related_roll_id: returnRollId, remarks: l.defect_reason });
      await history(tx, req, { roll_id: returnRollId, roll_no: `${fr.roll_no}-R`, event: 'RETURN', ref_type: 'FPR', ref_id: returnId, ref_no: returnNo, sub_process: inw?.sub_process ?? null,
        to: toStore, qty: l.qty_kg, so_id: fr.so_id, related_roll_id: fr.id, remarks: l.defect_reason });
      total += l.qty_kg;
    }
    await txExecute(tx, 'UPDATE trx_fabric_process_return SET total_kg = ? WHERE id = ?', [r3(total), returnId]);
    return { id: returnId, return_no: returnNo, total_kg: r3(total) };
  });
  await audit(req, 'trx_fabric_process_return', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.return_no} confirmed — ${out.total_kg} KG to the return store` });
}));

// =====================================================================================
// Reprocess (with billing treatment)
// =====================================================================================
const BILLING_TYPES = ['BILLABLE', 'NON_BILLABLE', 'INTERNAL_COST', 'FREE', 'RECOVERY'] as const;
const billingSchema = z.object({
  billing_type: z.enum(BILLING_TYPES),
  bill_required: z.coerce.boolean().default(false),
  billing_reason_id: s.id(),
  cost_treatment: z.enum(['CONTRACTOR_CHARGE', 'INTERNAL_COST', 'FREE', 'RECOVERY']).nullish(),
  rate_per_kg: z.coerce.number().min(0).default(0),
  bill_amount: z.coerce.number().min(0).nullish(),
  internal_cost: z.coerce.number().min(0).default(0),
  billing_remarks: s.text(),
});
const reprocessSchema = billingSchema.extend({
  reprocess_date: date,
  source_type: z.enum(['RETURN', 'STOCK']).default('RETURN'),
  return_id: s.id(),
  sub_process: z.string().trim().min(2).max(40),
  vendor_id: s.idReq(),
  color_name: s.nullableStr(80),
  reason_id: s.idReq(),
  remarks: s.text(),
  lines: z.array(z.object({ source_roll_id: s.idReq(), qty_kg: z.coerce.number().positive(), return_line_id: s.id() })).min(1, 'Pick the rolls to reprocess'),
});

/** Billing rules (doc §26): returns the normalised billing fields. */
function billingFields(b: z.infer<typeof billingSchema>, qty: number) {
  const amount = r2(b.bill_amount != null && b.bill_amount > 0 ? b.bill_amount : b.rate_per_kg * qty);
  switch (b.billing_type) {
    case 'BILLABLE':
      if (!b.bill_required) throw BadRequest('Billable reprocess needs "Bill required = Yes"');
      if (!(amount > 0)) throw BadRequest('Billable reprocess needs a rate per KG or an approved amount');
      return { bill_required: 1, cost_treatment: b.cost_treatment ?? 'CONTRACTOR_CHARGE', rate_per_kg: b.rate_per_kg, bill_amount: amount, billing_status: 'PENDING' };
    case 'RECOVERY':
      if (!(amount > 0)) throw BadRequest('Recovery from contractor needs the amount to recover');
      return { bill_required: 0, cost_treatment: 'RECOVERY', rate_per_kg: b.rate_per_kg, bill_amount: amount, billing_status: 'PENDING' };
    default:
      // Non-billable / internal cost / free: never on a contractor bill (rate / amount stay zero)
      return { bill_required: 0, cost_treatment: b.billing_type === 'INTERNAL_COST' ? 'INTERNAL_COST' : (b.cost_treatment ?? (b.billing_type === 'FREE' ? 'FREE' : 'INTERNAL_COST')),
        rate_per_kg: 0, bill_amount: 0, billing_status: 'EXCLUDED' };
  }
}

fabricProcessingRouter.get('/fabric-process/reprocess', requirePermission(FP.VIEW), ah(async (req, res) => {
  const rows = await query<any>(
    `SELECT rp.*, v.party_name AS vendor_name, pt.name AS process_name, rs.reason, br.reason AS billing_reason, rt.return_no, o.fpo_no, o.status AS dc_status,
            (SELECT GROUP_CONCAT(DISTINCT COALESCE(so.io_no, so.so_no) SEPARATOR ', ') FROM trx_fabric_reprocess_line l LEFT JOIN trx_sales_order so ON so.id = l.so_id WHERE l.reprocess_id = rp.id) AS jobs,
            b.bill_no
       FROM trx_fabric_reprocess rp
       LEFT JOIN mst_party v ON v.id = rp.vendor_id
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = rp.company_id AND pt.code = rp.sub_process
       LEFT JOIN mst_fabric_process_reason rs ON rs.id = rp.reason_id
       LEFT JOIN mst_fabric_process_reason br ON br.id = rp.billing_reason_id
       LEFT JOIN trx_fabric_process_return rt ON rt.id = rp.return_id
       LEFT JOIN trx_fabric_process_order o ON o.id = rp.fpo_id
       LEFT JOIN trx_fabric_process_bill b ON b.id = rp.contractor_bill_id
      WHERE rp.company_id = ? ORDER BY rp.id DESC LIMIT 1000`, [req.user!.companyId]);
  res.json({ data: rows });
}));

fabricProcessingRouter.get('/fabric-process/reprocess/:id', requirePermission(FP.VIEW), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const rp = await queryOne<any>(
    `SELECT rp.*, v.party_name AS vendor_name, pt.name AS process_name, rs.reason, br.reason AS billing_reason, rt.return_no, o.fpo_no, o.status AS dc_status, b.bill_no
       FROM trx_fabric_reprocess rp LEFT JOIN mst_party v ON v.id = rp.vendor_id
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = rp.company_id AND pt.code = rp.sub_process
       LEFT JOIN mst_fabric_process_reason rs ON rs.id = rp.reason_id LEFT JOIN mst_fabric_process_reason br ON br.id = rp.billing_reason_id
       LEFT JOIN trx_fabric_process_return rt ON rt.id = rp.return_id LEFT JOIN trx_fabric_process_order o ON o.id = rp.fpo_id
       LEFT JOIN trx_fabric_process_bill b ON b.id = rp.contractor_bill_id
      WHERE rp.id = ? AND rp.company_id = ?`, [id, req.user!.companyId]);
  if (!rp) throw NotFound('Reprocess not found');
  const lines = await query<any>(
    `SELECT l.*, COALESCE(so.io_no, so.so_no) AS io_no, fr.color_name, fr.process_state FROM trx_fabric_reprocess_line l
       LEFT JOIN trx_sales_order so ON so.id = l.so_id LEFT JOIN trx_fabric_roll fr ON fr.id = l.source_roll_id WHERE l.reprocess_id = ? ORDER BY l.id`, [id]);
  res.json({ data: { ...rp, lines } });
}));

/** Confirms a reprocess: creates its reprocess DC (rolls issued from the return store). */
async function confirmReprocess(tx: Tx, req: Request, rp: any) {
  const lines = await txQuery<any>(tx, 'SELECT * FROM trx_fabric_reprocess_line WHERE reprocess_id = ? ORDER BY id', [rp.id]);
  const h = await insertOutwardHeader(tx, req, {
    fpo_date: String(rp.reprocess_date).slice(0, 10), sub_process: rp.sub_process, vendor_id: Number(rp.vendor_id), color_name: rp.color_name ?? null,
    remarks: `Reprocess ${rp.reprocess_no}`, rolls: [], from_warehouse_id: null, to_location: null, vehicle_no: null, challan_no: null,
    shade_code: null, target_dia: null, target_gsm: null, expected_return_date: null,
  } as any, { status: 'DISPATCHED', is_reprocess: true, reprocess_id: rp.id });
  await writeOutwardRolls(tx, req, h.id, h,
    lines.map((l) => ({ fabric_roll_id: Number(l.source_roll_id), so_id: l.so_id ? Number(l.so_id) : null, weight_kg: n(l.qty_kg), meters: 0, color_name: rp.color_name ?? null })),
    true, { allowReturned: true });
  for (const l of lines) {
    if (l.return_line_id) await txExecute(tx, 'UPDATE trx_fabric_process_return_line SET reprocessed_kg = reprocessed_kg + ? WHERE id = ?', [l.qty_kg, l.return_line_id]);
  }
  if (rp.return_id) {
    const tot = await txQueryOne<any>(tx, 'SELECT SUM(qty_kg) q, SUM(reprocessed_kg) d FROM trx_fabric_process_return_line WHERE return_id = ?', [rp.return_id]);
    await txExecute(tx, 'UPDATE trx_fabric_process_return SET reprocessed_kg = ?, status = ? WHERE id = ?',
      [r3(n(tot?.d)), n(tot?.d) + EPS >= n(tot?.q) ? 'SENT_TO_REPROCESS' : 'CONFIRMED', rp.return_id]);
  }
  await txExecute(tx, `UPDATE trx_fabric_reprocess SET status = 'IN_PROCESS', fpo_id = ?, confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`, [h.id, req.user!.id, rp.id]);
  return h;
}

/** POST /fabric-process/reprocess — reprocess entry (draft, or confirm = reprocess DC issued). */
fabricProcessingRouter.post('/fabric-process/reprocess', requirePermission(FP.REPROCESS), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = reprocessSchema.parse(req.body);
  const confirm = Boolean(req.body?.confirm);
  const out = await transaction(async (tx) => {
    const pt = await processType(cid, body.sub_process, tx);
    if (!pt.is_reprocess && !pt.allow_reprocess) throw BadRequest(`${pt.name} cannot be used for reprocess`);
    const ret = body.return_id ? await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_return WHERE id = ? AND company_id = ?', [body.return_id, cid]) : null;
    if (body.source_type === 'RETURN' && !ret) throw BadRequest('Choose the return to reprocess');
    // eligibility: a return line's open KG / the roll's balance
    let total = 0;
    const rows: any[] = [];
    for (const l of body.lines) {
      const fr = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ?', [l.source_roll_id, cid]);
      if (!fr) throw BadRequest('Roll not found');
      const avail = n(fr.weight_kg) - n(fr.issued_kg);
      if (l.qty_kg > avail + 1e-9) throw BadRequest(`Roll ${fr.roll_no}: reprocess ${l.qty_kg} KG is more than the eligible ${avail.toFixed(3)} KG`);
      if (body.source_type === 'RETURN') {
        const rl = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_return_line WHERE return_id = ? AND return_roll_id = ?', [ret.id, fr.id]);
        if (!rl) throw BadRequest(`Roll ${fr.roll_no} is not on return ${ret.return_no}`);
        if (l.qty_kg > n(rl.qty_kg) - n(rl.reprocessed_kg) + 1e-9) throw BadRequest(`Roll ${fr.roll_no}: only ${r3(n(rl.qty_kg) - n(rl.reprocessed_kg))} KG of the return is left to reprocess`);
        rows.push({ ...l, return_line_id: rl.id, fr });
      } else rows.push({ ...l, fr });
      total += l.qty_kg;
    }
    if (confirm && !can(req, FP.CONFIRM)) throw Forbidden('You can save the reprocess as draft; confirming needs the confirm right');
    const bf = billingFields(body, total);
    // doc §32: a Process Manager / Admin selecting the billing type decides it; other users only request it
    if (can(req, FP.BILLING_APPROVE)) { if (bf.billing_status === 'PENDING') bf.billing_status = 'APPROVED'; }
    else bf.billing_status = 'PENDING';
    const no = await nextDocNumber(tx, cid, 'FP_REPROCESS');
    const r = await txExecute(tx,
      `INSERT INTO trx_fabric_reprocess (company_id, reprocess_no, reprocess_date, source_type, return_id, original_inward_id, sub_process, vendor_id, color_name,
         reason_id, total_kg, billing_type, bill_required, billing_reason_id, cost_treatment, rate_per_kg, bill_amount, internal_cost, billing_status,
         billing_remarks, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, body.reprocess_date, body.source_type, ret?.id ?? null, ret?.inward_id ?? null, pt.code, body.vendor_id, body.color_name ?? null,
       body.reason_id, r3(total), body.billing_type, bf.bill_required, body.billing_reason_id ?? null, bf.cost_treatment, bf.rate_per_kg, bf.bill_amount,
       r2(body.internal_cost), bf.billing_status, body.billing_remarks ?? null, 'DRAFT', body.remarks ?? null, req.user!.id]);
    const id = Number(r.insertId);
    for (const l of rows) {
      await txExecute(tx, 'INSERT INTO trx_fabric_reprocess_line (reprocess_id, source_roll_id, return_line_id, so_id, roll_no, qty_kg) VALUES (?,?,?,?,?,?)',
        [id, l.fr.id, l.return_line_id ?? null, l.fr.so_id ?? null, l.fr.roll_no, r3(l.qty_kg)]);
    }
    let dc: any = null;
    if (confirm) dc = await confirmReprocess(tx, req, { id, reprocess_no: no, reprocess_date: body.reprocess_date, sub_process: pt.code, vendor_id: body.vendor_id, color_name: body.color_name, return_id: ret?.id ?? null });
    return { id, reprocess_no: no, total_kg: r3(total), billing_type: body.billing_type, bill_amount: bf.bill_amount, billing_status: bf.billing_status, status: confirm ? 'IN_PROCESS' : 'DRAFT', fpo_no: dc?.fpo_no ?? null, fpo_id: dc?.id ?? null };
  });
  await audit(req, 'trx_fabric_reprocess', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.reprocess_no} ${out.status === 'DRAFT' ? 'saved as draft' : `confirmed — reprocess DC ${out.fpo_no} issued`}` });
}));

fabricProcessingRouter.post('/fabric-process/reprocess/:id/confirm', requirePermission(FP.CONFIRM), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const out = await transaction(async (tx) => {
    const rp = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_reprocess WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!rp) throw NotFound('Reprocess not found');
    if (rp.status !== 'DRAFT') throw BadRequest(`${rp.reprocess_no} is already ${rp.status}`);
    const dc = await confirmReprocess(tx, req, rp);
    return { reprocess_no: rp.reprocess_no, fpo_no: dc.fpo_no, fpo_id: dc.id };
  });
  await audit(req, 'trx_fabric_reprocess', id, 'UPDATE', undefined, { confirm: out });
  res.json({ data: out, message: `${out.reprocess_no} confirmed — reprocess DC ${out.fpo_no} issued` });
}));

/** POST /fabric-process/reprocess/:id/approve-billing — Process Manager approves the billing treatment. */
fabricProcessingRouter.post('/fabric-process/reprocess/:id/approve-billing', requirePermission(FP.BILLING_APPROVE), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const rp = await queryOne<any>('SELECT * FROM trx_fabric_reprocess WHERE id = ? AND company_id = ?', [id, cid]);
  if (!rp) throw NotFound('Reprocess not found');
  if (rp.billing_status !== 'PENDING') throw BadRequest(`Billing is already ${rp.billing_status}`);
  // billable / recovery → can go on a contractor bill; non-billable / internal / free → excluded
  const to = ['BILLABLE', 'RECOVERY'].includes(rp.billing_type) ? 'APPROVED' : 'EXCLUDED';
  await query(`UPDATE trx_fabric_reprocess SET billing_status = ?, billing_approved_by = ?, billing_approved_at = NOW() WHERE id = ?`, [to, req.user!.id, id]);
  await audit(req, 'trx_fabric_reprocess', id, 'UPDATE', { billing_status: rp.billing_status }, { billing_status: to });
  res.json({ message: `${rp.reprocess_no} billing approved (${rp.billing_type.replace('_', '-').toLowerCase()})` });
}));

/**
 * POST /fabric-process/reprocess/:id/billing — change the billing treatment (doc §26 / §35):
 * needs approval rights and a reason; a billed reprocess must have its bill cancelled first.
 */
fabricProcessingRouter.post('/fabric-process/reprocess/:id/billing', requirePermission(FP.BILLING_CHANGE), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = billingSchema.extend({ change_reason: z.string().trim().min(3, 'Reason for the change is mandatory').max(255) }).parse(req.body);
  const rp = await queryOne<any>('SELECT * FROM trx_fabric_reprocess WHERE id = ? AND company_id = ?', [id, cid]);
  if (!rp) throw NotFound('Reprocess not found');
  if (rp.contractor_bill_id) throw BadRequest('This reprocess is on a contractor bill — cancel / reverse the bill before changing the billing type');
  const bf = billingFields(b, n(rp.total_kg));
  // after confirmation the change counts as approved by the approver making it
  const status = rp.status !== 'DRAFT' && bf.billing_status === 'PENDING' ? 'APPROVED' : bf.billing_status;
  await query(
    `UPDATE trx_fabric_reprocess SET billing_type = ?, bill_required = ?, billing_reason_id = ?, cost_treatment = ?, rate_per_kg = ?, bill_amount = ?,
            internal_cost = ?, billing_status = ?, billing_approved_by = ?, billing_approved_at = NOW(),
            billing_remarks = CONCAT(COALESCE(billing_remarks, ''), ?) WHERE id = ?`,
    [b.billing_type, bf.bill_required, b.billing_reason_id ?? null, bf.cost_treatment, bf.rate_per_kg, bf.bill_amount, r2(b.internal_cost), status, req.user!.id,
     `\n[${new Date().toISOString().slice(0, 16)}] ${rp.billing_type} → ${b.billing_type}: ${b.change_reason}`, id]);
  await audit(req, 'trx_fabric_reprocess', id, 'UPDATE',
    { billing_type: rp.billing_type, bill_amount: rp.bill_amount, billing_status: rp.billing_status },
    { billing_type: b.billing_type, bill_amount: bf.bill_amount, billing_status: status, reason: b.change_reason });
  res.json({ message: `${rp.reprocess_no}: billing ${rp.billing_type} → ${b.billing_type}` });
}));

// =====================================================================================
// Contractor bill (fabric process)
// =====================================================================================
/** GET /fabric-process/bill-sources?vendor_id= — unbilled GRNs, approved billable reprocess, pending recovery. */
fabricProcessingRouter.get('/fabric-process/bill-sources', requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ vendor_id: z.coerce.number().int().positive(), from: date.optional(), to: date.optional() }).parse(req.query);
  const dp = (col: string) => `${q.from ? ` AND ${col} >= ?` : ''}${q.to ? ` AND ${col} <= ?` : ''}`;
  const dv = [...(q.from ? [q.from] : []), ...(q.to ? [q.to] : [])];
  const grns = await query<any>(
    `SELECT i.id AS ref_id, 'GRN' AS line_type, i.inward_no AS doc_no, i.inward_date AS doc_date, i.sub_process, pt.name AS process_name, i.good_kg AS qty_kg,
            (SELECT GROUP_CONCAT(DISTINCT ri.io_no SEPARATOR ', ') FROM trx_fabric_process_roll_out ro JOIN trx_fabric_process_roll_in ri ON ri.id = ro.roll_in_id WHERE ro.inward_id = i.id) AS io_no,
            (SELECT bl.rate FROM trx_fabric_process_bill_line bl JOIN trx_fabric_process_bill b ON b.id = bl.bill_id
              WHERE b.vendor_id = i.vendor_id AND bl.sub_process = i.sub_process AND bl.line_type = 'GRN' AND b.status = 'POSTED' ORDER BY bl.id DESC LIMIT 1) AS last_rate,
            (SELECT o2.rate_per_kg FROM trx_fabric_process_order o2 WHERE o2.id = i.fpo_id) AS quotation_rate
       FROM trx_fabric_process_inward i
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = i.company_id AND pt.code = i.sub_process
      WHERE i.company_id = ? AND i.vendor_id = ? AND i.bill_id IS NULL AND i.is_reprocess = 0 AND i.status = 'POSTED'${dp('i.inward_date')}
      ORDER BY i.inward_date, i.id`, [cid, q.vendor_id, ...dv]);
  const reps = await query<any>(
    `SELECT rp.id AS ref_id, IF(rp.billing_type = 'RECOVERY', 'RECOVERY', 'REPROCESS') AS line_type, rp.reprocess_no AS doc_no, rp.reprocess_date AS doc_date,
            rp.sub_process, pt.name AS process_name, rp.total_kg AS qty_kg, rp.rate_per_kg AS rate, rp.bill_amount, rp.billing_type, rp.billing_status,
            (SELECT GROUP_CONCAT(DISTINCT COALESCE(so.io_no, so.so_no) SEPARATOR ', ') FROM trx_fabric_reprocess_line l LEFT JOIN trx_sales_order so ON so.id = l.so_id WHERE l.reprocess_id = rp.id) AS io_no
       FROM trx_fabric_reprocess rp
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = rp.company_id AND pt.code = rp.sub_process
      WHERE rp.company_id = ? AND rp.vendor_id = ? AND rp.contractor_bill_id IS NULL AND rp.status <> 'CANCELLED'
        AND rp.billing_type IN ('BILLABLE', 'RECOVERY') AND rp.billing_status = 'APPROVED'${dp('rp.reprocess_date')}
      ORDER BY rp.reprocess_date, rp.id`, [cid, q.vendor_id, ...dv]);
  // non-billable reprocess stays visible (excluded) for the summary
  const excluded = await query<any>(
    `SELECT rp.reprocess_no AS doc_no, rp.total_kg AS qty_kg, rp.billing_type FROM trx_fabric_reprocess rp
      WHERE rp.company_id = ? AND rp.vendor_id = ? AND rp.billing_type NOT IN ('BILLABLE', 'RECOVERY') AND rp.status <> 'CANCELLED'${dp('rp.reprocess_date')}`, [cid, q.vendor_id, ...dv]);
  const pendingApproval = await query<any>(
    `SELECT rp.reprocess_no AS doc_no, rp.bill_amount FROM trx_fabric_reprocess rp WHERE rp.company_id = ? AND rp.vendor_id = ? AND rp.billing_type IN ('BILLABLE','RECOVERY')
        AND rp.billing_status = 'PENDING' AND rp.status <> 'CANCELLED'`, [cid, q.vendor_id]);
  res.json({ data: { grns, reprocess: reps, excluded, pending_approval: pendingApproval } });
}));

const billSchema = z.object({
  vendor_id: s.idReq(),
  bill_date: date,
  party_bill_no: s.nullableStr(60),
  from_date: date.nullish(),
  to_date: date.nullish(),
  discount_amount: z.coerce.number().min(0).default(0),
  other_charges: z.coerce.number().default(0),
  gst_pct: z.coerce.number().min(0).max(28).default(0),
  remarks: s.text(),
  rate_change_reason: s.nullableStr(255),
  lines: z.array(z.object({ line_type: z.enum(['GRN', 'REPROCESS', 'RECOVERY']), ref_id: s.idReq(), rate: z.coerce.number().min(0).default(0) })).min(1, 'Add at least one GRN / reprocess'),
});

fabricProcessingRouter.get('/fabric-process/bills', requirePermission(FP.VIEW), ah(async (req, res) => {
  const rows = await query<any>(
    `SELECT b.*, v.party_name AS vendor_name, (SELECT COUNT(*) FROM trx_fabric_process_bill_line l WHERE l.bill_id = b.id) AS line_count
       FROM trx_fabric_process_bill b LEFT JOIN mst_party v ON v.id = b.vendor_id WHERE b.company_id = ? ORDER BY b.id DESC LIMIT 500`, [req.user!.companyId]);
  res.json({ data: rows });
}));
fabricProcessingRouter.get('/fabric-process/bills/:id', requirePermission(FP.VIEW), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = await queryOne<any>('SELECT b.*, v.party_name AS vendor_name FROM trx_fabric_process_bill b LEFT JOIN mst_party v ON v.id = b.vendor_id WHERE b.id = ? AND b.company_id = ?', [id, req.user!.companyId]);
  if (!b) throw NotFound('Bill not found');
  const lines = await query<any>('SELECT * FROM trx_fabric_process_bill_line WHERE bill_id = ? ORDER BY id', [id]);
  res.json({ data: { ...b, lines } });
}));

/** POST /fabric-process/bills — contractor bill: GRN good KG × rate + billable reprocess − recovery. */
fabricProcessingRouter.post('/fabric-process/bills', requirePermission(FP.BILL), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = billSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const billNo = await nextDocNumber(tx, cid, 'FP_BILL');
    const r = await txExecute(tx,
      `INSERT INTO trx_fabric_process_bill (company_id, bill_no, bill_date, vendor_id, party_bill_no, from_date, to_date, discount_amount, other_charges, gst_pct, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, billNo, body.bill_date, body.vendor_id, body.party_bill_no ?? null, body.from_date ?? null, body.to_date ?? null, r2(body.discount_amount), r2(body.other_charges), body.gst_pct, body.remarks ?? null, req.user!.id]);
    const billId = Number(r.insertId);
    let gross = 0, recovery = 0;
    for (const l of body.lines) {
      if (l.line_type === 'GRN') {
        const i = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_inward WHERE id = ? AND company_id = ? FOR UPDATE', [l.ref_id, cid]);
        if (!i || Number(i.vendor_id) !== body.vendor_id) throw BadRequest('A GRN is not of this contractor');
        if (i.bill_id) throw BadRequest(`${i.inward_no} is already billed`);
        if (i.status !== 'POSTED') throw BadRequest(`${i.inward_no} is not posted yet`);
        if (i.is_reprocess) throw BadRequest(`${i.inward_no} is a reprocess GRN — its charge comes from the reprocess billing`);
        if (!(l.rate > 0)) throw BadRequest(`${i.inward_no}: enter the rate per KG`);
        // the approved quotation rate of the DC is the job-work rate; a different rate needs a reason
        const qr = await txQueryOne<any>(tx, 'SELECT rate_per_kg FROM trx_fabric_process_order WHERE id = ?', [i.fpo_id]);
        if (qr?.rate_per_kg != null && Math.abs(n(qr.rate_per_kg) - l.rate) > 0.005 && !(body.rate_change_reason && body.rate_change_reason.length >= 3)) {
          throw BadRequest(`${i.inward_no}: the rate ₹${l.rate} differs from the approved quotation rate ₹${n(qr.rate_per_kg)} — give the reason for the change`);
        }
        const amt = r2(n(i.good_kg) * l.rate);
        const jobs = await txQueryOne<any>(tx, 'SELECT GROUP_CONCAT(DISTINCT ri.io_no SEPARATOR \', \') j FROM trx_fabric_process_roll_out ro JOIN trx_fabric_process_roll_in ri ON ri.id = ro.roll_in_id WHERE ro.inward_id = ?', [i.id]);
        await txExecute(tx, 'INSERT INTO trx_fabric_process_bill_line (bill_id, line_type, ref_id, doc_no, doc_date, io_no, sub_process, qty_kg, rate, amount) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [billId, 'GRN', i.id, i.inward_no, i.inward_date, jobs?.j ?? null, i.sub_process, n(i.good_kg), l.rate, amt]);
        await txExecute(tx, 'UPDATE trx_fabric_process_inward SET bill_id = ? WHERE id = ?', [billId, i.id]);
        gross += amt;
      } else {
        const rp = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_reprocess WHERE id = ? AND company_id = ? FOR UPDATE', [l.ref_id, cid]);
        if (!rp || Number(rp.vendor_id) !== body.vendor_id) throw BadRequest('A reprocess is not of this contractor');
        if (rp.contractor_bill_id) throw BadRequest(`${rp.reprocess_no} is already billed`);
        // Non-billable / internal / free reprocess never flows into a contractor bill
        if (!['BILLABLE', 'RECOVERY'].includes(rp.billing_type)) throw BadRequest(`${rp.reprocess_no} is ${rp.billing_type.replace('_', '-').toLowerCase()} — excluded from contractor bills`);
        if (rp.billing_status !== 'APPROVED') throw BadRequest(`${rp.reprocess_no}: billing is not approved yet`);
        const isRec = rp.billing_type === 'RECOVERY';
        const amt = r2(n(rp.bill_amount)) * (isRec ? -1 : 1);
        await txExecute(tx, 'INSERT INTO trx_fabric_process_bill_line (bill_id, line_type, ref_id, doc_no, doc_date, sub_process, qty_kg, rate, amount) VALUES (?,?,?,?,?,?,?,?,?)',
          [billId, isRec ? 'RECOVERY' : 'REPROCESS', rp.id, rp.reprocess_no, rp.reprocess_date, rp.sub_process, n(rp.total_kg), n(rp.rate_per_kg), amt]);
        await txExecute(tx, `UPDATE trx_fabric_reprocess SET contractor_bill_id = ?, billing_status = 'BILLED' WHERE id = ?`, [billId, rp.id]);
        if (isRec) recovery += -amt; else gross += amt;
      }
    }
    const taxable = r2(gross - recovery - body.discount_amount + body.other_charges);
    const gst = r2(taxable * body.gst_pct / 100);
    const net = r2(taxable + gst);
    await txExecute(tx, 'UPDATE trx_fabric_process_bill SET gross_amount = ?, recovery_amount = ?, gst_amount = ?, net_amount = ? WHERE id = ?', [r2(gross), r2(recovery), gst, net, billId]);
    return { id: billId, bill_no: billNo, gross_amount: r2(gross), recovery_amount: r2(recovery), gst_amount: gst, net_amount: net };
  });
  await audit(req, 'trx_fabric_process_bill', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.bill_no} posted — net ₹${out.net_amount}` });
}));

/** POST /fabric-process/bills/:id/cancel — reversal: GRNs and reprocess become billable again. */
fabricProcessingRouter.post('/fabric-process/bills/:id/cancel', requirePermission(FP.BILL_CANCEL), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const reason = z.string().trim().min(3, 'Reason is mandatory').max(255).parse(req.body?.reason);
  const b = await transaction(async (tx) => {
    const b = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_bill WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!b) throw NotFound('Bill not found');
    if (b.status === 'CANCELLED') throw BadRequest(`${b.bill_no} is already cancelled`);
    await txExecute(tx, 'UPDATE trx_fabric_process_inward SET bill_id = NULL WHERE bill_id = ?', [id]);
    await txExecute(tx, `UPDATE trx_fabric_reprocess SET contractor_bill_id = NULL, billing_status = 'APPROVED' WHERE contractor_bill_id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_fabric_process_bill SET status = 'CANCELLED', remarks = CONCAT(COALESCE(remarks, ''), ?) WHERE id = ?`, [`\nCancelled: ${reason}`, id]);
    return b;
  });
  await audit(req, 'trx_fabric_process_bill', id, 'UPDATE', { status: b.status }, { status: 'CANCELLED', reason });
  res.json({ message: `${b.bill_no} cancelled — its GRNs / reprocess can be billed again` });
}));

// =====================================================================================
// Roll tracking, ledger / summary, job-wise status
// =====================================================================================
/** GET /fabric-process/roll-history?roll_no= — the roll, its ancestors and descendants, with every movement. */
fabricProcessingRouter.get('/fabric-process/roll-history', requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ roll_no: z.string().trim().min(1).max(60).optional(), roll_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const roll = q.roll_id
    ? await queryOne<any>(`${STORE_ROLL_SQL} WHERE fr.id = ? AND fr.company_id = ?`, [q.roll_id, cid])
    : await queryOne<any>(`${STORE_ROLL_SQL} WHERE fr.roll_no = ? AND fr.company_id = ? ORDER BY fr.id DESC LIMIT 1`, [q.roll_no, cid]);
  if (!roll) throw NotFound(`Roll ${q.roll_no ?? q.roll_id} not found`);
  // lineage: walk up parent_roll_id, then all descendants
  const ids = new Set<number>([Number(roll.id)]);
  let cur: any = roll;
  for (let i = 0; i < 20 && cur; i++) {
    const p = await queryOne<any>('SELECT parent_roll_id FROM trx_fabric_roll WHERE id = ?', [cur.id]);
    if (!p?.parent_roll_id || ids.has(Number(p.parent_roll_id))) break;
    ids.add(Number(p.parent_roll_id));
    cur = { id: Number(p.parent_roll_id) };
  }
  let frontier = [...ids];
  for (let i = 0; i < 20 && frontier.length; i++) {
    const kids = await query<any>('SELECT id FROM trx_fabric_roll WHERE parent_roll_id IN (?)', [frontier]);
    frontier = kids.map((k) => Number(k.id)).filter((k) => !ids.has(k));
    frontier.forEach((k) => ids.add(k));
  }
  const all = [...ids];
  const rolls = await query<any>(`${STORE_ROLL_SQL} WHERE fr.id IN (?) ORDER BY fr.id`, [all]);
  // receipt event of the original roll(s): purchase GRN / knitting inward
  const rootRows = await query<any>(
    `SELECT fr.id, fr.roll_no, g.grn_no, g.grn_date, g.supplier_dc_no, g.supplier_inv_no, p.party_name AS supplier, po.po_no, w.warehouse_name, fr.weight_kg
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
       LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) LEFT JOIN mst_party p ON p.id = g.supplier_id
       LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
      WHERE fr.id IN (?) AND fr.parent_roll_id IS NULL AND fr.source_fpo_id IS NULL`, [all]);
  const events = await query<any>(
    `SELECT h.*, COALESCE(so.io_no, so.so_no) AS io_no, u.full_name AS user_name FROM trx_fabric_roll_history h
       LEFT JOIN trx_sales_order so ON so.id = h.so_id LEFT JOIN mst_user u ON u.id = h.user_id
      WHERE h.company_id = ? AND (h.roll_id IN (?) OR h.related_roll_id IN (?)) ORDER BY h.event_time, h.id`, [cid, all, all]);
  const cutting = await query<any>(
    `SELECT fir.fabric_roll_id, fr.roll_no, fi.issue_no AS dc_no, fi.issue_date, fir.issue_kg, cp.plan_no
       FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = fi.cutting_plan_id JOIN trx_fabric_roll fr ON fr.id = fir.fabric_roll_id
      WHERE fir.fabric_roll_id IN (?)`, [all]);
  const timeline = [
    ...rootRows.map((r) => ({ when: r.grn_date, event: 'GRN', ref_no: r.grn_no, roll_no: r.roll_no, from: r.supplier || 'Supplier', to: r.warehouse_name, qty_kg: n(r.weight_kg),
      remarks: [r.po_no ? `PO ${r.po_no}` : '', r.supplier_inv_no ? `Inv ${r.supplier_inv_no}` : '', r.supplier_dc_no ? `DC ${r.supplier_dc_no}` : ''].filter(Boolean).join(' · ') || 'Initial receipt' })),
    ...events.map((e) => ({ when: e.event_time, event: e.event, ref_no: e.ref_no, roll_no: e.roll_no, process: e.sub_process, from: e.from_place, to: e.to_place, qty_kg: n(e.qty_kg), io_no: e.io_no, remarks: e.remarks, user: e.user_name })),
    ...cutting.map((c) => ({ when: c.issue_date, event: 'ISSUE_TO_CUTTING', ref_no: c.dc_no, roll_no: c.roll_no, from: 'Store', to: `Cutting ${c.plan_no ?? ''}`.trim(), qty_kg: n(c.issue_kg), remarks: 'Fabric DC to cutting' })),
  ].sort((a, b) => String(a.when).localeCompare(String(b.when)));
  res.json({ data: { roll, lineage: rolls, timeline } });
}));

/** GET /fabric-process/summary — per process: outward / good / reject / loss / return / reprocess / balance. */
fabricProcessingRouter.get('/fabric-process/summary', requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ from: date.optional(), to: date.optional(), vendor_id: z.coerce.number().int().optional() }).parse(req.query);
  const where = [`o.company_id = ?`, `o.status NOT IN ('DRAFT','CANCELLED')`]; const p: unknown[] = [cid];
  if (q.from) { where.push('o.fpo_date >= ?'); p.push(q.from); }
  if (q.to) { where.push('o.fpo_date <= ?'); p.push(q.to); }
  if (q.vendor_id) { where.push('o.vendor_id = ?'); p.push(q.vendor_id); }
  const rows = await query<any>(
    `SELECT o.sub_process, pt.name AS process_name, MAX(o.is_reprocess) AS is_reprocess,
            SUM(ri.weight_kg) outward_kg, SUM(ri.good_kg) good_kg, SUM(ri.reject_kg) reject_kg, SUM(ri.loss_kg) loss_kg
       FROM trx_fabric_process_order o JOIN trx_fabric_process_roll_in ri ON ri.fpo_id = o.id
       LEFT JOIN mst_fabric_process_type pt ON pt.company_id = o.company_id AND pt.code = o.sub_process
      WHERE ${where.join(' AND ')} GROUP BY o.sub_process, pt.name ORDER BY pt.name`, p);
  const ret = await query<any>(`SELECT sub_process, SUM(total_kg) kg FROM trx_fabric_process_return WHERE company_id = ? AND status <> 'CANCELLED' GROUP BY sub_process`, [cid]);
  const rep = await query<any>(`SELECT sub_process, SUM(total_kg) kg, SUM(IF(billing_type = 'BILLABLE', total_kg, 0)) billable_kg, SUM(IF(billing_type = 'BILLABLE', 0, total_kg)) non_billable_kg,
                                       SUM(IF(billing_type = 'BILLABLE', bill_amount, 0)) billable_amount, SUM(internal_cost) internal_cost
                                  FROM trx_fabric_reprocess WHERE company_id = ? AND status <> 'CANCELLED' GROUP BY sub_process`, [cid]);
  const data = rows.map((r) => {
    const o = n(r.outward_kg), g = n(r.good_kg), rj = n(r.reject_kg), l = n(r.loss_kg);
    return { sub_process: r.sub_process, process_name: r.process_name, is_reprocess: !!Number(r.is_reprocess),
      outward_kg: r3(o), good_kg: r3(g), reject_kg: r3(rj), loss_kg: r3(l), balance_kg: r3(Math.max(0, o - g - rj - l)),
      loss_pct: o > 0 ? r2((l / o) * 100) : 0,
      return_kg: r3(n(ret.find((x) => x.sub_process === r.sub_process)?.kg)) };
  });
  res.json({ data: { processes: data, reprocess: rep.map((x) => ({ ...x, kg: r3(n(x.kg)), billable_kg: r3(n(x.billable_kg)), non_billable_kg: r3(n(x.non_billable_kg)), billable_amount: r2(n(x.billable_amount)), internal_cost: r2(n(x.internal_cost)) })) } });
}));

/** GET /fabric-process/job-status — job-wise process status (outward / good / reject / loss / pending). */
fabricProcessingRouter.get('/fabric-process/job-status', requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ from: date.optional(), to: date.optional(), sub_process: z.string().optional() }).parse(req.query);
  const where = [`o.company_id = ?`, `o.status NOT IN ('DRAFT','CANCELLED')`]; const p: unknown[] = [cid];
  if (q.from) { where.push('o.fpo_date >= ?'); p.push(q.from); }
  if (q.to) { where.push('o.fpo_date <= ?'); p.push(q.to); }
  if (q.sub_process) { where.push('o.sub_process = ?'); p.push(q.sub_process); }
  const rows = await query<any>(
    `SELECT ri.so_id, COALESCE(ri.io_no, 'STOCK') io_no, ri.buyer_po_no, st.style_code, ri.color_name, o.sub_process,
            COUNT(DISTINCT o.id) dcs, SUM(ri.weight_kg) outward_kg, SUM(ri.good_kg) good_kg, SUM(ri.reject_kg) reject_kg, SUM(ri.loss_kg) loss_kg
       FROM trx_fabric_process_order o JOIN trx_fabric_process_roll_in ri ON ri.fpo_id = o.id LEFT JOIN mst_style st ON st.id = ri.style_id
      WHERE ${where.join(' AND ')}
      GROUP BY ri.so_id, ri.io_no, ri.buyer_po_no, st.style_code, ri.color_name, o.sub_process ORDER BY ri.io_no`, p);
  res.json({
    data: rows.map((r) => {
      const o = n(r.outward_kg), g = n(r.good_kg), rj = n(r.reject_kg), l = n(r.loss_kg), pend = Math.max(0, o - g - rj - l);
      return { ...r, outward_kg: r3(o), good_kg: r3(g), reject_kg: r3(rj), loss_kg: r3(l), pending_kg: r3(pend), status: pend <= EPS ? 'COMPLETED' : (g + rj + l > 0 ? 'PARTIAL' : 'PENDING') };
    }),
  });
}));

/** GET /fabric-process/ledger — date-wise movement (DC out, GRN in, return, reprocess). */
fabricProcessingRouter.get('/fabric-process/ledger', requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ from: date.optional(), to: date.optional(), vendor_id: z.coerce.number().int().optional(), sub_process: z.string().optional() }).parse(req.query);
  const f = (alias: string, dcol: string) => {
    const w: string[] = []; const p: unknown[] = [];
    if (q.from) { w.push(`${alias}.${dcol} >= ?`); p.push(q.from); }
    if (q.to) { w.push(`${alias}.${dcol} <= ?`); p.push(q.to); }
    if (q.vendor_id) { w.push(`${alias}.vendor_id = ?`); p.push(q.vendor_id); }
    if (q.sub_process) { w.push(`${alias}.sub_process = ?`); p.push(q.sub_process); }
    return { w: w.length ? ` AND ${w.join(' AND ')}` : '', p };
  };
  const a = f('o', 'fpo_date'), b = f('i', 'inward_date'), c = f('r', 'return_date');
  const rows = await query<any>(
    `SELECT * FROM (
       SELECT o.fpo_date AS doc_date, o.fpo_no AS doc_no, IF(o.is_reprocess, 'REPROCESS OUT', 'OUTWARD') AS txn, o.sub_process, v.party_name AS contractor, o.io_no AS jobs,
              o.input_weight_kg AS outward_kg, 0 good_kg, 0 reject_kg, 0 loss_kg, o.status, o.id AS sort_id
         FROM trx_fabric_process_order o LEFT JOIN mst_party v ON v.id = o.vendor_id
        WHERE o.company_id = ? AND o.status NOT IN ('DRAFT','CANCELLED')${a.w}
       UNION ALL
       SELECT i.inward_date, i.inward_no, IF(i.is_reprocess, 'REPROCESS IN', 'INWARD'), i.sub_process, v.party_name,
              (SELECT GROUP_CONCAT(DISTINCT ri.io_no SEPARATOR ', ') FROM trx_fabric_process_roll_out ro JOIN trx_fabric_process_roll_in ri ON ri.id = ro.roll_in_id WHERE ro.inward_id = i.id),
              0, i.good_kg, i.reject_kg, i.loss_kg, i.status, i.id
         FROM trx_fabric_process_inward i LEFT JOIN mst_party v ON v.id = i.vendor_id
        WHERE i.company_id = ? AND i.status = 'POSTED'${b.w}
       UNION ALL
       SELECT r.return_date, r.return_no, 'RETURN', r.sub_process, v.party_name, NULL, 0, 0, r.total_kg, 0, r.status, r.id
         FROM trx_fabric_process_return r LEFT JOIN mst_party v ON v.id = r.vendor_id
        WHERE r.company_id = ?${c.w}
     ) x ORDER BY doc_date, sort_id`,
    [cid, ...a.p, cid, ...b.p, cid, ...c.p]);
  let bal = 0;
  res.json({ data: rows.map((r) => {
    if (r.txn !== 'RETURN') bal += n(r.outward_kg) - n(r.good_kg) - n(r.reject_kg) - n(r.loss_kg);
    return { ...r, outward_kg: n(r.outward_kg), good_kg: n(r.good_kg), reject_kg: n(r.reject_kg), loss_kg: n(r.loss_kg), balance_kg: r3(bal) };
  }) });
}));

// =====================================================================================
// Masters: process types (with QC parameters) and reasons — the configurable engine (doc §22)
// =====================================================================================
const typeSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and _'),
  name: s.strReq(80),
  output_state: z.enum(['DYED', 'WASHED', 'PRINTED', 'COMPACTED', 'FINISHED']).default('FINISHED'),
  changes_colour: z.coerce.boolean().default(false),
  allow_reprocess: z.coerce.boolean().default(true),
  allow_split: z.coerce.boolean().default(true),
  is_reprocess: z.coerce.boolean().default(false),
  requires_qc: z.coerce.boolean().default(false),
  sort_order: z.coerce.number().int().default(0),
  is_active: z.coerce.boolean().default(true),
});
fabricProcessingRouter.get('/fabric-process/types/all', requirePermission(FP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const types = await query<any>('SELECT * FROM mst_fabric_process_type WHERE company_id = ? ORDER BY sort_order, name', [cid]);
  const params = await query<any>('SELECT * FROM mst_fabric_process_qc_param WHERE company_id = ? ORDER BY process_code, sort_order, id', [cid]);
  res.json({ data: types.map((t) => ({ ...t, qc_params: params.filter((p) => p.process_code === t.code) })) });
}));
fabricProcessingRouter.post('/fabric-process/types', requirePermission(FP.MASTER), ah(async (req, res) => {
  const b = typeSchema.parse(req.body);
  const dup = await queryOne('SELECT id FROM mst_fabric_process_type WHERE company_id = ? AND code = ?', [req.user!.companyId, b.code]);
  if (dup) throw BadRequest(`Process ${b.code} already exists`);
  const r = await query<any>(`INSERT INTO mst_fabric_process_type (company_id, code, name, output_state, changes_colour, allow_reprocess, allow_split, is_reprocess, requires_qc, sort_order, is_active)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, b.code, b.name, b.output_state, b.changes_colour ? 1 : 0, b.allow_reprocess ? 1 : 0, b.allow_split ? 1 : 0, b.is_reprocess ? 1 : 0, b.requires_qc ? 1 : 0, b.sort_order, b.is_active ? 1 : 0]);
  await audit(req, 'mst_fabric_process_type', Number((r as any).insertId), 'INSERT', undefined, b);
  res.status(201).json({ message: `Process ${b.name} added` });
}));
fabricProcessingRouter.put('/fabric-process/types/:id', requirePermission(FP.MASTER), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const before = await queryOne<any>('SELECT * FROM mst_fabric_process_type WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!before) throw NotFound('Process type not found');
  const b = typeSchema.omit({ code: true }).parse(req.body);
  await query(`UPDATE mst_fabric_process_type SET name = ?, output_state = ?, changes_colour = ?, allow_reprocess = ?, allow_split = ?, is_reprocess = ?, requires_qc = ?, sort_order = ?, is_active = ? WHERE id = ?`,
    [b.name, b.output_state, b.changes_colour ? 1 : 0, b.allow_reprocess ? 1 : 0, b.allow_split ? 1 : 0, b.is_reprocess ? 1 : 0, b.requires_qc ? 1 : 0, b.sort_order, b.is_active ? 1 : 0, id]);
  await audit(req, 'mst_fabric_process_type', id, 'UPDATE', before, b);
  res.json({ message: `${b.name} saved` });
}));
const paramSchema = z.object({
  process_code: z.string().trim().min(2).max(40),
  param_name: s.strReq(80),
  uom: s.nullableStr(20),
  min_value: z.coerce.number().nullish(),
  max_value: z.coerce.number().nullish(),
  target_value: z.coerce.number().nullish(),
  is_mandatory: z.coerce.boolean().default(true),
  sort_order: z.coerce.number().int().default(0),
  is_active: z.coerce.boolean().default(true),
}).refine((p) => p.min_value == null || p.max_value == null || p.min_value <= p.max_value, { message: 'Min cannot be more than max' });
fabricProcessingRouter.post('/fabric-process/qc-params', requirePermission(FP.MASTER), ah(async (req, res) => {
  const b = paramSchema.parse(req.body);
  await query(`INSERT INTO mst_fabric_process_qc_param (company_id, process_code, param_name, uom, min_value, max_value, target_value, is_mandatory, sort_order, is_active)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, b.process_code, b.param_name, b.uom ?? null, b.min_value ?? null, b.max_value ?? null, b.target_value ?? null, b.is_mandatory ? 1 : 0, b.sort_order, b.is_active ? 1 : 0]);
  await audit(req, 'mst_fabric_process_qc_param', 0, 'INSERT', undefined, b);
  res.status(201).json({ message: `${b.param_name} added to ${b.process_code}` });
}));
fabricProcessingRouter.put('/fabric-process/qc-params/:id', requirePermission(FP.MASTER), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const before = await queryOne<any>('SELECT * FROM mst_fabric_process_qc_param WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!before) throw NotFound('QC parameter not found');
  const b = paramSchema.parse({ ...req.body, process_code: before.process_code });
  await query(`UPDATE mst_fabric_process_qc_param SET param_name = ?, uom = ?, min_value = ?, max_value = ?, target_value = ?, is_mandatory = ?, sort_order = ?, is_active = ? WHERE id = ?`,
    [b.param_name, b.uom ?? null, b.min_value ?? null, b.max_value ?? null, b.target_value ?? null, b.is_mandatory ? 1 : 0, b.sort_order, b.is_active ? 1 : 0, id]);
  await audit(req, 'mst_fabric_process_qc_param', id, 'UPDATE', before, b);
  res.json({ message: `${b.param_name} saved` });
}));
const reasonSchema = z.object({ code: z.string().trim().min(2).max(20), reason: s.strReq(120), kind: z.enum(['RETURN', 'BILLING', 'BOTH']).default('BOTH'),
  default_billing: z.enum(['BILLABLE', 'NON_BILLABLE', 'INTERNAL_COST', 'FREE', 'RECOVERY']).nullish(), is_active: z.coerce.boolean().default(true) });
fabricProcessingRouter.post('/fabric-process/reasons', requirePermission(FP.MASTER), ah(async (req, res) => {
  const b = reasonSchema.parse(req.body);
  if (await queryOne('SELECT id FROM mst_fabric_process_reason WHERE company_id = ? AND code = ?', [req.user!.companyId, b.code])) throw BadRequest(`Reason ${b.code} already exists`);
  await query('INSERT INTO mst_fabric_process_reason (company_id, code, reason, kind, default_billing, is_active) VALUES (?,?,?,?,?,?)',
    [req.user!.companyId, b.code, b.reason, b.kind, b.default_billing ?? null, b.is_active ? 1 : 0]);
  res.status(201).json({ message: `Reason ${b.code} added` });
}));
fabricProcessingRouter.put('/fabric-process/reasons/:id', requirePermission(FP.MASTER), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = reasonSchema.omit({ code: true }).parse(req.body);
  await query('UPDATE mst_fabric_process_reason SET reason = ?, kind = ?, default_billing = ?, is_active = ? WHERE id = ? AND company_id = ?',
    [b.reason, b.kind, b.default_billing ?? null, b.is_active ? 1 : 0, id, req.user!.companyId]);
  res.json({ message: 'Reason saved' });
}));
fabricProcessingRouter.get('/fabric-process/reasons/all', requirePermission(FP.VIEW), ah(async (req, res) => {
  res.json({ data: await query<any>('SELECT * FROM mst_fabric_process_reason WHERE company_id = ? ORDER BY code', [req.user!.companyId]) });
}));

// =====================================================================================
// Reports (doc §18, §34)
// =====================================================================================
const repQ = z.object({ from: date.optional(), to: date.optional(), vendor_id: z.coerce.number().int().optional(), sub_process: z.string().optional() });
const dateWhere = (alias: string, col: string, q: z.infer<typeof repQ>, vendor = true) => {
  const w: string[] = []; const p: unknown[] = [];
  if (q.from) { w.push(`${alias}.${col} >= ?`); p.push(q.from); }
  if (q.to) { w.push(`${alias}.${col} <= ?`); p.push(q.to); }
  if (vendor && q.vendor_id) { w.push(`${alias}.vendor_id = ?`); p.push(q.vendor_id); }
  if (q.sub_process) { w.push(`${alias}.sub_process = ?`); p.push(q.sub_process); }
  return { w: w.length ? ` AND ${w.join(' AND ')}` : '', p };
};

/** Process unit (contractor) wise pending KG with the oldest open DC. */
fabricProcessingRouter.get('/fabric-process/reports/unit-pending', requirePermission(FP.VIEW), ah(async (req, res) => {
  const q = repQ.parse(req.query); const f = dateWhere('o', 'fpo_date', q);
  const rows = await query<any>(
    `SELECT o.vendor_id, v.party_name vendor, o.sub_process, COUNT(DISTINCT o.id) open_dcs, MIN(o.fpo_date) oldest_dc_date,
            DATEDIFF(CURDATE(), MIN(o.fpo_date)) oldest_days, SUM(ri.weight_kg) outward_kg, SUM(ri.good_kg + ri.reject_kg + ri.loss_kg) received_kg,
            SUM(ri.weight_kg - ri.good_kg - ri.reject_kg - ri.loss_kg) pending_kg, GROUP_CONCAT(DISTINCT o.fpo_no ORDER BY o.fpo_no SEPARATOR ', ') dcs
       FROM trx_fabric_process_order o JOIN trx_fabric_process_roll_in ri ON ri.fpo_id = o.id LEFT JOIN mst_party v ON v.id = o.vendor_id
      WHERE o.company_id = ? AND o.status IN ('DISPATCHED','IN_PROCESS','PARTIALLY_RECEIVED')${f.w}
      GROUP BY o.vendor_id, v.party_name, o.sub_process HAVING pending_kg > 0.0005 ORDER BY pending_kg DESC`, [req.user!.companyId, ...f.p]);
  res.json({ data: rows.map((r) => ({ ...r, outward_kg: r3(n(r.outward_kg)), received_kg: r3(n(r.received_kg)), pending_kg: r3(n(r.pending_kg)) })) });
}));

/** Reject / return report: GRN rejects and quality returns with reasons. */
fabricProcessingRouter.get('/fabric-process/reports/reject-return', requirePermission(FP.VIEW), ah(async (req, res) => {
  const q = repQ.parse(req.query); const cid = req.user!.companyId;
  const a = dateWhere('i', 'inward_date', q), b = dateWhere('r', 'return_date', q);
  const rejects = await query<any>(
    `SELECT 'GRN REJECT' kind, i.inward_date doc_date, i.inward_no doc_no, o.fpo_no, v.party_name vendor, i.sub_process, ri.io_no, ri.roll_no input_roll, ro.roll_no output_roll,
            ro.reject_kg qty_kg, ro.reject_reason reason
       FROM trx_fabric_process_roll_out ro JOIN trx_fabric_process_inward i ON i.id = ro.inward_id JOIN trx_fabric_process_order o ON o.id = i.fpo_id
       LEFT JOIN trx_fabric_process_roll_in ri ON ri.id = ro.roll_in_id LEFT JOIN mst_party v ON v.id = i.vendor_id
      WHERE i.company_id = ? AND i.status = 'POSTED' AND ro.reject_kg > 0${a.w} ORDER BY i.inward_date`, [cid, ...a.p]);
  const returns = await query<any>(
    `SELECT 'RETURN' kind, r.return_date doc_date, r.return_no doc_no, o.fpo_no, v.party_name vendor, r.sub_process, COALESCE(so.io_no, so.so_no) io_no, rl.roll_no input_roll, NULL output_roll,
            rl.qty_kg, CONCAT(COALESCE(rs.reason, ''), IF(rl.defect_reason IS NULL, '', CONCAT(' — ', rl.defect_reason))) reason, r.return_type, rl.reprocessed_kg
       FROM trx_fabric_process_return_line rl JOIN trx_fabric_process_return r ON r.id = rl.return_id LEFT JOIN trx_fabric_process_order o ON o.id = r.fpo_id
       LEFT JOIN mst_party v ON v.id = r.vendor_id LEFT JOIN mst_fabric_process_reason rs ON rs.id = r.reason_id LEFT JOIN trx_sales_order so ON so.id = rl.so_id
      WHERE r.company_id = ? AND r.status <> 'CANCELLED'${b.w} ORDER BY r.return_date`, [cid, ...b.p]);
  res.json({ data: [...rejects, ...returns].map((x) => ({ ...x, qty_kg: r3(n(x.qty_kg)) })) });
}));

/** Reprocess pending: not yet received back, and billable reprocess still to be billed. */
fabricProcessingRouter.get('/fabric-process/reports/reprocess-pending', requirePermission(FP.VIEW), ah(async (req, res) => {
  const q = repQ.parse(req.query); const f = dateWhere('rp', 'reprocess_date', q);
  const rows = await query<any>(
    `SELECT rp.reprocess_no, rp.reprocess_date, rp.sub_process, v.party_name vendor, rp.status, rp.total_kg, rp.billing_type, rp.billing_status, rp.bill_amount,
            o.fpo_no, COALESCE(SUM(ri.good_kg + ri.reject_kg + ri.loss_kg), 0) received_kg, DATEDIFF(CURDATE(), rp.reprocess_date) days
       FROM trx_fabric_reprocess rp LEFT JOIN mst_party v ON v.id = rp.vendor_id LEFT JOIN trx_fabric_process_order o ON o.id = rp.fpo_id
       LEFT JOIN trx_fabric_process_roll_in ri ON ri.fpo_id = rp.fpo_id
      WHERE rp.company_id = ? AND rp.status <> 'CANCELLED'${f.w}
        AND (rp.status IN ('DRAFT','IN_PROCESS') OR (rp.billing_type IN ('BILLABLE','RECOVERY') AND rp.billing_status IN ('PENDING','APPROVED')) OR rp.billing_status = 'PENDING')
      GROUP BY rp.id ORDER BY rp.reprocess_date`, [req.user!.companyId, ...f.p]);
  res.json({ data: rows.map((r) => ({ ...r, pending_kg: r3(Math.max(0, n(r.total_kg) - n(r.received_kg))),
    pending_for: r.status === 'DRAFT' ? 'Confirmation' : r.status === 'IN_PROCESS' ? 'Receipt from processor' : r.billing_status === 'PENDING' ? 'Billing approval' : 'Contractor bill' })) });
}));

/** Reprocess by billing reason / treatment: qty, billable amount, internal cost (non-billable never disappears). */
fabricProcessingRouter.get('/fabric-process/reports/billing-reasons', requirePermission(FP.VIEW), ah(async (req, res) => {
  const q = repQ.parse(req.query); const f = dateWhere('rp', 'reprocess_date', q);
  const rows = await query<any>(
    `SELECT COALESCE(br.reason, rs.reason, '—') reason, rp.billing_type, v.party_name vendor, COUNT(*) entries, SUM(rp.total_kg) kg, SUM(rp.bill_amount) bill_amount, SUM(rp.internal_cost) internal_cost
       FROM trx_fabric_reprocess rp LEFT JOIN mst_fabric_process_reason br ON br.id = rp.billing_reason_id LEFT JOIN mst_fabric_process_reason rs ON rs.id = rp.reason_id
       LEFT JOIN mst_party v ON v.id = rp.vendor_id
      WHERE rp.company_id = ? AND rp.status <> 'CANCELLED'${f.w}
      GROUP BY COALESCE(br.reason, rs.reason, '—'), rp.billing_type, v.party_name ORDER BY rp.billing_type, kg DESC`, [req.user!.companyId, ...f.p]);
  res.json({ data: rows.map((r) => ({ ...r, kg: r3(n(r.kg)), bill_amount: r2(n(r.bill_amount)), internal_cost: r2(n(r.internal_cost)) })) });
}));

/** Process loss report per DC / job. */
fabricProcessingRouter.get('/fabric-process/reports/process-loss', requirePermission(FP.VIEW), ah(async (req, res) => {
  const q = repQ.parse(req.query); const f = dateWhere('o', 'fpo_date', q);
  const rows = await query<any>(
    `SELECT o.fpo_no, o.fpo_date, o.sub_process, v.party_name vendor, COALESCE(ri.io_no, 'STOCK') io_no, SUM(ri.weight_kg) outward_kg, SUM(ri.good_kg) good_kg,
            SUM(ri.reject_kg) reject_kg, SUM(ri.loss_kg) loss_kg
       FROM trx_fabric_process_order o JOIN trx_fabric_process_roll_in ri ON ri.fpo_id = o.id LEFT JOIN mst_party v ON v.id = o.vendor_id
      WHERE o.company_id = ? AND o.status NOT IN ('DRAFT','CANCELLED')${f.w}
      GROUP BY o.id, ri.io_no HAVING SUM(ri.good_kg + ri.reject_kg + ri.loss_kg) > 0 ORDER BY o.fpo_date, o.id`, [req.user!.companyId, ...f.p]);
  res.json({ data: rows.map((r) => { const o = n(r.outward_kg), acc = n(r.good_kg) + n(r.reject_kg) + n(r.loss_kg);
    return { ...r, outward_kg: r3(o), good_kg: r3(n(r.good_kg)), reject_kg: r3(n(r.reject_kg)), loss_kg: r3(n(r.loss_kg)), loss_pct: acc > 0 ? r2(n(r.loss_kg) / acc * 100) : 0, reject_pct: acc > 0 ? r2(n(r.reject_kg) / acc * 100) : 0 }; }) });
}));
