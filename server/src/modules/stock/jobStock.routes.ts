import { Router, type Request } from 'express';
import { settingFlag } from '../../core/inwardControls.js';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { refreshFabricRollStatus } from '../production/cuttingEngine.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { yarnStockRows, yarnStockQuery } from '../procurement/fabricYarnProcurement.routes.js';
import { jobBomRequirement } from '../bom/bom.routes.js';

/**
 * Job-wise stock (client voice notes 01-Oct-2026):
 *   • yarn lots, fabric rolls and trim stock belong to the job they were bought for;
 *   • job → job (or general → job) transfers move that ownership with full traceability;
 *   • the knitting / yarn-process DC lot picker shows only the selected job's yarn;
 *   • traceability: fabric roll ← processing ← knitting ← yarn lot ← GRN / PO / supplier invoice,
 *     and forward to cutting.
 */
export const jobStockRouter = Router();
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const n = (v: unknown) => Number(v ?? 0) || 0;
const key = (so: unknown) => Number(so) || 0;

/**
 * Yarn lot balances per holding job: the lot's own job (from GRN line / PO line / PO) holds what was
 * accepted less legacy (lot-wise) issues; transfers move KG between jobs; DC lines that name the lot
 * (grn_line_id) take it from the job of the line.
 */
export async function yarnJobLots(cid: number, f: { so_id?: number | null; yarn_id?: number; warehouse_id?: number; grn_line_ids?: number[]; includeGeneral?: boolean }) {
  const rows = await yarnStockRows(cid, yarnStockQuery.parse({ yarn_id: f.yarn_id, warehouse_id: f.warehouse_id }));
  const lots = rows.filter((r: any) => !['REJECTED', 'PENDING'].includes(r.qc_status) && (!f.grn_line_ids || f.grn_line_ids.includes(Number(r.id))));
  if (!lots.length) return [];
  const ids = lots.map((r: any) => Number(r.id));
  // transfers and lot issues replayed in the order they happened
  const tr = await query<any>(
    `SELECT l.grn_line_id, t.from_so_id, t.to_so_id, l.qty, t.created_at at, l.id seq, t.transfer_no FROM trx_job_transfer_line l JOIN trx_job_transfer t ON t.id = l.transfer_id
      WHERE t.company_id = ? AND t.material_type = 'YARN' AND t.status = 'POSTED' AND l.grn_line_id IN (?)`, [cid, ids]);
  const di = await query<any>(`SELECT grn_line_id, so_id, issued_qty_kg qty, created_at at, id seq FROM trx_process_issue WHERE company_id = ? AND grn_line_id IN (?)`, [cid, ids]);
  const out: any[] = [];
  for (const r of lots) {
    const gl = Number(r.id);
    const owner = key(r.owner_so_id);
    const hold = new Map<number, number>();
    hold.set(owner, n(r.net_in_qty) - (n(r.issued_qty) - n(r.direct_issued_qty)));
    const events = [...tr.filter((x) => Number(x.grn_line_id) === gl).map((t) => ({ kind: 'T' as const, ...t })), ...di.filter((x) => Number(x.grn_line_id) === gl).map((d) => ({ kind: 'I' as const, ...d }))]
      .sort((x, y) => (new Date(x.at).getTime() - new Date(y.at).getTime()) || (x.kind === y.kind ? Number(x.seq) - Number(y.seq) : x.kind === 'T' ? -1 : 1));
    for (const ev of events) {
      if (ev.kind === 'T') {
        hold.set(key(ev.from_so_id), (hold.get(key(ev.from_so_id)) ?? 0) - n(ev.qty));
        hold.set(key(ev.to_so_id), (hold.get(key(ev.to_so_id)) ?? 0) + n(ev.qty));
        continue;
      }
      const d = ev;
      // an issue comes out of its own job's part; a general (no job) issue, or a job with no part of its
      // own, out of the general part — never more than that part holds; the rest from the owner's part
      const k = key(d.so_id);
      const first = hold.has(k) && (hold.get(k) ?? 0) > 0.0005 ? k : hold.has(0) && (hold.get(0) ?? 0) > 0.0005 ? 0 : owner;
      let qty = n(d.qty);
      if (qty < 0) { const back = hold.has(k) ? k : hold.has(0) ? 0 : owner; hold.set(back, (hold.get(back) ?? 0) - qty); continue; }   // reversal (DC cancelled)
      for (const h of [first, owner, ...hold.keys()]) {
        if (qty <= 0) break;
        const take = h === owner && h !== first ? qty : Math.min(qty, Math.max(0, hold.get(h) ?? 0));
        if (take <= 0) continue;
        hold.set(h, (hold.get(h) ?? 0) - take);
        qty -= take;
      }
      if (qty > 0) hold.set(owner, (hold.get(owner) ?? 0) - qty);
    }
    for (const [so, qty] of hold) {
      if (qty <= 0.0005) continue;
      if (f.so_id !== undefined && f.so_id !== null && so !== key(f.so_id) && !(f.includeGeneral && so === 0)) continue;
      out.push({
        grn_line_id: gl, holder_so_id: so || null, own_lot: so === owner, available_kg: r4(qty),
        yarn_id: r.yarn_id, yarn_name: r.yarn_name, yarn_code: r.yarn_code, count_str: r.count_str, lot_no: r.lot_no, shade: r.shade, color_name: r.color_name,
        grn_id: r.grn_id, grn_no: r.grn_no, grn_date: r.grn_date, po_no: r.po_no, supplier_name: r.supplier_name, warehouse_id: r.warehouse_id, warehouse_name: r.warehouse_name,
        owner_so_id: r.owner_so_id, io_no: r.internal_ir_no, uom_code: r.uom_code,
        // how the job came to hold it: its own purchase (PO / GRN) or job transfer(s) into it
        transfer_nos: so === owner ? null : [...new Set(tr.filter((t) => Number(t.grn_line_id) === gl && key(t.to_so_id) === so).map((t) => t.transfer_no))].join(', ') || null,
      });
    }
  }
  if (out.length) {
    const sos = [...new Set(out.map((o) => o.holder_so_id).filter(Boolean))];
    const names = sos.length ? await query<any>('SELECT id, COALESCE(io_no, so_no) job FROM trx_sales_order WHERE id IN (?)', [sos]) : [];
    out.forEach((o) => { o.holder_job = o.holder_so_id ? names.find((x) => Number(x.id) === Number(o.holder_so_id))?.job ?? null : 'GENERAL'; });
  }
  return out.sort((a, b) => String(a.grn_date).localeCompare(String(b.grn_date)) || a.grn_line_id - b.grn_line_id);
}

/**
 * Checks DC lines that name a yarn lot: the lot must be held by the line's job (or general stock)
 * with enough KG — counting earlier lines of the same DC.
 */
export async function assertJobLots(cid: number, lines: { grn_line_id?: number | null; so_id?: number | null; yarn_id: number; issued_qty_kg: number; label: string }[]) {
  const withLot = lines.filter((l) => l.grn_line_id);
  if (!withLot.length) return;
  const lots = await yarnJobLots(cid, { grn_line_ids: [...new Set(withLot.map((l) => Number(l.grn_line_id)))] });
  const used = new Map<string, number>();
  for (const l of withLot) {
    const rows = lots.filter((x) => x.grn_line_id === Number(l.grn_line_id));
    if (!rows.length) throw BadRequest(`${l.label}: the yarn lot has no stock`);
    if (rows[0].yarn_id && Number(rows[0].yarn_id) !== Number(l.yarn_id)) throw BadRequest(`${l.label}: the lot is a different yarn`);
    const mine = rows.find((x) => key(x.holder_so_id) === key(l.so_id)) ?? rows.find((x) => !x.holder_so_id);
    if (!mine) {
      throw BadRequest(`${l.label}: lot ${rows[0].lot_no} (${rows[0].grn_no}) belongs to job ${rows.map((x) => x.holder_job).join(', ')} — transfer it to this job first`);
    }
    const k = `${l.grn_line_id}|${key(mine.holder_so_id)}`;
    const left = mine.available_kg - (used.get(k) ?? 0);
    if (l.issued_qty_kg > left + 1e-6) throw BadRequest(`${l.label}: lot ${mine.lot_no} has only ${r4(left)} KG for this job`);
    used.set(k, (used.get(k) ?? 0) + l.issued_qty_kg);
  }
}

/** Job id of a program / process / DC line: its so_id, else the sales order of its IO no. */
export async function resolveSoId(cid: number, soId: unknown, ioNo: unknown): Promise<number | null> {
  if (Number(soId)) return Number(soId);
  if (!ioNo) return null;
  const so = await queryOne<any>('SELECT id FROM trx_sales_order WHERE company_id = ? AND (io_no = ? OR so_no = ?) ORDER BY (io_no = ?) DESC LIMIT 1', [cid, ioNo, ioNo, ioNo]);
  return so ? Number(so.id) : null;
}

/** GET /yarn-stock/job-lots?so_id=&yarn_id=&warehouse_id= — the job's yarn lots (bought for it or transferred to it) + general stock. */
jobStockRouter.get('/yarn-stock/job-lots', requireAny('PRODUCTION.VIEW', 'INVENTORY.VIEW'), ah(async (req, res) => {
  const q = z.object({ so_id: z.coerce.number().int().positive().optional(), io_no: z.string().trim().max(60).optional(), yarn_id: z.coerce.number().int().positive().optional(),
    warehouse_id: z.coerce.number().int().positive().optional(), general: z.coerce.number().int().optional() }).parse(req.query);
  // job by id or IO no; a job-less program / process (io_no given, no sales order) sees general stock only
  const so = q.so_id || q.io_no !== undefined ? (await resolveSoId(req.user!.companyId, q.so_id, q.io_no)) ?? 0 : null;
  const rows = await yarnJobLots(req.user!.companyId, { so_id: so, yarn_id: q.yarn_id, warehouse_id: q.warehouse_id, includeGeneral: q.general !== 0 });
  res.json({ data: rows });
}));

// =====================================================================================
// Job → job stock transfer (yarn lot / fabric roll / trim stock)
// =====================================================================================
/** GET /job-stock?material=&so_id= — what a job (or general stock: so_id=0) holds, for the transfer screen. */
jobStockRouter.get('/job-stock', requireAny('INVENTORY.VIEW', 'PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ material: z.enum(['YARN', 'FABRIC', 'TRIM']), so_id: z.coerce.number().int().min(0) }).parse(req.query);
  if (q.material === 'YARN') {
    const rows = (await yarnJobLots(cid, { so_id: q.so_id || null })).filter((r) => key(r.holder_so_id) === q.so_id);
    res.json({ data: rows.map((r) => ({ ref_id: r.grn_line_id, item: `${r.yarn_name}${r.count_str ? ` · ${r.count_str}` : ''}`, lot_no: r.lot_no, colour: r.color_name || r.shade, available: r.available_kg, uom: r.uom_code || 'KG',
      source: `${r.grn_no}${r.po_no ? ` · PO ${r.po_no}` : ''} · ${r.supplier_name ?? ''}`, store: r.warehouse_name })) });
    return;
  }
  if (q.material === 'FABRIC') {
    const rows = await query<any>(
      `SELECT fr.id, fr.roll_no, fr.lot_no, fb.fabric_name, fr.color_name, fr.process_state, ROUND(fr.weight_kg - COALESCE(fr.issued_kg, 0), 3) bal, g.grn_no, w.warehouse_name
         FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
        WHERE fr.company_id = ? AND ${q.so_id ? 'fr.so_id = ?' : 'fr.so_id IS NULL'} AND fr.qc_status = 'ACCEPTED' AND fr.stock_status <> 'CLOSED'
          AND fr.weight_kg - COALESCE(fr.issued_kg, 0) > 0.0005 ORDER BY fr.id DESC LIMIT 2000`, q.so_id ? [cid, q.so_id] : [cid]);
    res.json({ data: rows.map((r) => ({ ref_id: r.id, item: `${r.fabric_name ?? ''} · roll ${r.roll_no}`, lot_no: r.lot_no, colour: r.color_name, state: r.process_state, available: n(r.bal), uom: 'KG', source: r.grn_no, store: r.warehouse_name })) });
    return;
  }
  const rows = await query<any>(
    `SELECT ts.id, t.trim_name, ts.color_name, ts.trim_size, ts.internal_lot_no, ts.stock_qty - ts.allocated_qty bal, u.code uom, w.warehouse_name
       FROM trx_trim_stock ts JOIN mst_trim t ON t.id = ts.trim_id LEFT JOIN cfg_uom u ON u.id = ts.uom_id LEFT JOIN mst_warehouse w ON w.id = ts.warehouse_id
      WHERE ts.company_id = ? AND ts.so_key = ? AND ts.stock_qty - ts.allocated_qty > 0.0005 ORDER BY t.trim_name`, [cid, q.so_id]);
  res.json({ data: rows.map((r) => ({ ref_id: r.id, item: `${r.trim_name}${r.trim_size ? ` · ${r.trim_size}` : ''}`, lot_no: r.internal_lot_no, colour: r.color_name, available: n(r.bal), uom: r.uom || 'PCS', source: r.internal_lot_no, store: r.warehouse_name })) });
}));

const transferSchema = z.object({
  material_type: z.enum(['YARN', 'FABRIC', 'TRIM']),
  transfer_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  from_so_id: z.coerce.number().int().min(0),
  to_so_id: z.coerce.number().int().min(0),
  to_style_id: z.coerce.number().int().positive().nullish(),
  reason: z.string().trim().min(3, 'Give the reason for the transfer').max(255),
  lines: z.array(z.object({ ref_id: z.coerce.number().int().positive(), qty: z.coerce.number().positive() })).min(1, 'Pick what to transfer'),
});

/** Job transfer in the stock ledger: same store, out of the old job and into the new one. */
async function transferLedger(tx: Tx, req: Request, m: { warehouseId: number | null; material: 'YARN' | 'FABRIC' | 'TRIM'; itemId: number | null; qty: number; uomId: number; tid: number; from: number; to: number }) {
  if (!m.warehouseId) return;
  const base = { companyId: req.user!.companyId, warehouseId: m.warehouseId, materialType: m.material, refType: 'JOB_TRANSFER', refId: m.tid, uomId: m.uomId, createdBy: req.user!.id,
    yarnId: m.material === 'YARN' ? m.itemId : null, fabricId: m.material === 'FABRIC' ? m.itemId : null, trimId: m.material === 'TRIM' ? m.itemId : null } as const;
  await postLedger(tx, { ...base, txnType: 'TRANSFER_OUT', qtyOut: m.qty, soId: m.from || null });
  await postLedger(tx, { ...base, txnType: 'TRANSFER_IN', qtyIn: m.qty, soId: m.to || null });
}

async function fabricHistory(tx: Tx, req: Request, h: { roll_id: number; roll_no: string; ref_id: number; ref_no: string; qty: number; so_id: number | null; related: number | null; remarks: string }) {
  await txExecute(tx,
    `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, qty_kg, so_id, related_roll_id, remarks, user_id)
     VALUES (?,?,?,'JOB_TRANSFER','JTR',?,?,?,?,?,?,?)`,
    [req.user!.companyId, h.roll_id, h.roll_no, h.ref_id, h.ref_no, h.qty, h.so_id, h.related, h.remarks, req.user!.id]);
}

type TransferBody = z.infer<typeof transferSchema>;
const canApproveTransfer = (req: Request) => !!req.user?.isSuperAdmin || !!req.user?.permissions.has('JOB_TRANSFER.APPROVE');
export async function approvalHistory(tx: Tx, req: Request, h: { doc_type: string; doc_id: number; action: string; from?: string | null; to: string; remarks?: string | null }) {
  await txExecute(tx, 'INSERT INTO trx_yarn_approval_history (company_id, doc_type, doc_id, action, from_status, to_status, remarks, user_id) VALUES (?,?,?,?,?,?,?,?)',
    [req.user!.companyId, h.doc_type, h.doc_id, h.action, h.from ?? null, h.to, h.remarks ?? null, req.user!.id]);
}

/** Moves the stock of a transfer (yarn lots / fabric rolls / trim stock) — on posting. Returns the total qty. */
export async function postTransferLines(tx: Tx, req: Request, tid: number, no: string, b: TransferBody, fromJob: string, toJob: string) {
  const cid = req.user!.companyId;
  let total = 0;
  if (b.material_type === 'YARN') {
    const lots = await yarnJobLots(cid, { grn_line_ids: b.lines.map((l) => l.ref_id) });
    for (const l of b.lines) {
      const h = lots.find((x) => x.grn_line_id === l.ref_id && key(x.holder_so_id) === b.from_so_id);
      if (!h) throw BadRequest(`Yarn lot ${l.ref_id} is not held by ${fromJob}`);
      if (l.qty > h.available_kg + 1e-6) throw BadRequest(`Lot ${h.lot_no}: only ${h.available_kg} KG held by ${fromJob}`);
      await txExecute(tx, 'INSERT INTO trx_job_transfer_line (transfer_id, grn_line_id, item_label, lot_no, qty) VALUES (?,?,?,?,?)',
        [tid, l.ref_id, `${h.yarn_name}${h.count_str ? ` ${h.count_str}` : ''} · ${h.grn_no}`, h.lot_no, r4(l.qty)]);
      await transferLedger(tx, req, { warehouseId: h.warehouse_id ? Number(h.warehouse_id) : null, material: 'YARN', itemId: Number(h.yarn_id) || null, qty: r4(l.qty), uomId: UOM_KG, tid, from: b.from_so_id, to: b.to_so_id });
      total += l.qty;
    }
  } else if (b.material_type === 'FABRIC') {
    for (const l of b.lines) {
      const fr = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_roll WHERE id = ? AND company_id = ? FOR UPDATE', [l.ref_id, cid]);
      if (!fr) throw BadRequest('Roll not found');
      if (key(fr.so_id) !== b.from_so_id) throw BadRequest(`Roll ${fr.roll_no} is not in ${fromJob}`);
      const bal = n(fr.weight_kg) - n(fr.issued_kg);
      if (l.qty > bal + 1e-6) throw BadRequest(`Roll ${fr.roll_no} has only ${bal.toFixed(3)} KG`);
      let newRoll: number | null = null;
      if (l.qty >= bal - 0.0005 && n(fr.issued_kg) <= 0.0005) {
        // whole roll: it simply changes job
        await txExecute(tx, 'UPDATE trx_fabric_roll SET so_id = ? WHERE id = ?', [b.to_so_id || null, fr.id]);
        await fabricHistory(tx, req, { roll_id: fr.id, roll_no: fr.roll_no, ref_id: tid, ref_no: no, qty: l.qty, so_id: b.to_so_id || null, related: null, remarks: `${fromJob} → ${toJob}: ${b.reason}` });
      } else {
        // part of a roll: split — the moved KG becomes a child roll of the new job (same GRN, traceable)
        await txExecute(tx, 'UPDATE trx_fabric_roll SET issued_kg = COALESCE(issued_kg, 0) + ? WHERE id = ?', [l.qty, fr.id]);
        await refreshFabricRollStatus(tx, fr.id);
        const ins = await txExecute(tx,
          `INSERT INTO trx_fabric_roll (company_id, grn_id, grn_line_id, fabric_id, roll_no, lot_no, meters, weight_kg, gsm, dia, shade, warehouse_id, location_bin,
             qc_status, stock_status, remarks, process_state, color_name, source_fpo_id, so_id, parent_roll_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ACCEPTED','AVAILABLE',?,?,?,?,?,?)`,
          [cid, fr.grn_id, fr.grn_line_id, fr.fabric_id, `${fr.roll_no}-T${tid}`, fr.lot_no, n(fr.weight_kg) > 0 ? Math.round(n(fr.meters) * l.qty / n(fr.weight_kg) * 100) / 100 : null,
           r4(l.qty), fr.gsm, fr.dia, fr.shade, fr.warehouse_id, fr.location_bin, `Transferred ${fromJob} → ${toJob} (${no})`, fr.process_state, fr.color_name, fr.source_fpo_id, b.to_so_id || null, fr.id]);
        newRoll = Number(ins.insertId);
        await fabricHistory(tx, req, { roll_id: fr.id, roll_no: fr.roll_no, ref_id: tid, ref_no: no, qty: l.qty, so_id: b.from_so_id || null, related: newRoll, remarks: `${l.qty} KG to ${toJob}: ${b.reason}` });
        await fabricHistory(tx, req, { roll_id: newRoll, roll_no: `${fr.roll_no}-T${tid}`, ref_id: tid, ref_no: no, qty: l.qty, so_id: b.to_so_id || null, related: fr.id, remarks: `From ${fromJob} roll ${fr.roll_no}` });
      }
      await txExecute(tx, 'INSERT INTO trx_job_transfer_line (transfer_id, fabric_roll_id, new_roll_id, item_label, lot_no, qty) VALUES (?,?,?,?,?,?)',
        [tid, fr.id, newRoll, `Roll ${fr.roll_no}`, fr.lot_no, r4(l.qty)]);
      await transferLedger(tx, req, { warehouseId: fr.warehouse_id ? Number(fr.warehouse_id) : null, material: 'FABRIC', itemId: Number(fr.fabric_id) || null, qty: r4(l.qty), uomId: UOM_KG, tid, from: b.from_so_id, to: b.to_so_id });
      total += l.qty;
    }
  } else {
    for (const l of b.lines) {
      const ts = await txQueryOne<any>(tx, 'SELECT ts.*, t.trim_name FROM trx_trim_stock ts JOIN mst_trim t ON t.id = ts.trim_id WHERE ts.id = ? AND ts.company_id = ? FOR UPDATE', [l.ref_id, cid]);
      if (!ts) throw BadRequest('Trim stock not found');
      if (Number(ts.so_key) !== b.from_so_id) throw BadRequest(`${ts.trim_name} lot ${ts.internal_lot_no} is not in ${fromJob}`);
      const bal = n(ts.stock_qty) - n(ts.allocated_qty);
      if (l.qty > bal + 1e-6) throw BadRequest(`${ts.trim_name} lot ${ts.internal_lot_no}: only ${bal} free`);
      await txExecute(tx, 'UPDATE trx_trim_stock SET stock_qty = stock_qty - ? WHERE id = ?', [l.qty, ts.id]);
      await txExecute(tx,
        `INSERT INTO trx_trim_stock (company_id, warehouse_id, trim_id, color_name, trim_size, internal_lot_no, bin_location, stock_qty, uom_id, so_id, style_id, so_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE stock_qty = stock_qty + VALUES(stock_qty)`,
        [cid, ts.warehouse_id, ts.trim_id, ts.color_name, ts.trim_size, ts.internal_lot_no, ts.bin_location, l.qty, ts.uom_id, b.to_so_id || null, b.to_style_id ?? null, b.to_so_id]);
      const to = await txQueryOne<any>(tx, 'SELECT id FROM trx_trim_stock WHERE company_id = ? AND warehouse_id = ? AND trim_id = ? AND internal_lot_no = ? AND so_key = ?',
        [cid, ts.warehouse_id, ts.trim_id, ts.internal_lot_no, b.to_so_id]);
      await txExecute(tx, 'INSERT INTO trx_job_transfer_line (transfer_id, trim_stock_id, to_trim_stock_id, item_label, lot_no, qty, uom_id) VALUES (?,?,?,?,?,?,?)',
        [tid, ts.id, to?.id ?? null, ts.trim_name, ts.internal_lot_no, r4(l.qty), ts.uom_id]);
      await transferLedger(tx, req, { warehouseId: Number(ts.warehouse_id), material: 'TRIM', itemId: Number(ts.trim_id), qty: r4(l.qty), uomId: Number(ts.uom_id), tid, from: b.from_so_id, to: b.to_so_id });
      total += l.qty;
    }
  }
  await txExecute(tx, 'UPDATE trx_job_transfer SET total_qty = ? WHERE id = ?', [r4(total), tid]);
  return r4(total);
}

const jobNameOf = async (cid: number, id: number) => id ? (await queryOne<any>('SELECT COALESCE(io_no, so_no) j FROM trx_sales_order WHERE id = ? AND company_id = ?', [id, cid]))?.j : 'GENERAL';

/**
 * POST /job-transfers — move yarn lots / fabric rolls / trim stock from one job (or general) to another.
 * With JOB_TRANSFER_APPROVAL on, a user without the approve right only raises the request
 * (PENDING_APPROVAL, nothing moves); the Production Manager approves and it posts (doc §16, §19).
 */
jobStockRouter.post('/job-transfers', requireAny('INVENTORY.ADJUST', 'INVENTORY.CREATE', 'PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = transferSchema.parse(req.body);
  if (b.from_so_id === b.to_so_id) throw BadRequest('From and to job are the same');
  const fromJob = await jobNameOf(cid, b.from_so_id), toJob = await jobNameOf(cid, b.to_so_id);
  if (!fromJob || !toJob) throw BadRequest('Job not found');
  const needsApproval = (await settingFlag(cid, 'JOB_TRANSFER_APPROVAL', false)) && !canApproveTransfer(req);
  const priority = z.enum(['NORMAL', 'URGENT', 'EMERGENCY']).default('NORMAL').parse(req.body?.priority ?? undefined);
  const out = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'JOB_TRANSFER');
    const t = await txExecute(tx,
      `INSERT INTO trx_job_transfer (company_id, transfer_no, transfer_date, material_type, from_so_id, to_so_id, to_style_id, reason, created_by, status, priority, lines_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.transfer_date, b.material_type, b.from_so_id || null, b.to_so_id || null, b.to_style_id ?? null, b.reason, req.user!.id,
       needsApproval ? 'PENDING_APPROVAL' : 'POSTED', priority, JSON.stringify(b.lines)]);
    const tid = Number(t.insertId);
    if (needsApproval) {
      // check the stock now (dry run inside a savepoint), so a request that cannot post is refused up front
      await txQuery(tx, 'SAVEPOINT jt_check');
      await postTransferLines(tx, req, tid, no, b, fromJob, toJob);
      await txQuery(tx, 'ROLLBACK TO SAVEPOINT jt_check');
      await txExecute(tx, 'UPDATE trx_job_transfer SET total_qty = ? WHERE id = ?', [r4(b.lines.reduce((a, l) => a + l.qty, 0)), tid]);
      await approvalHistory(tx, req, { doc_type: 'JOB_TRANSFER', doc_id: tid, action: 'SUBMIT', to: 'PENDING_APPROVAL', remarks: b.reason });
      return { id: tid, transfer_no: no, total_qty: r4(b.lines.reduce((a, l) => a + l.qty, 0)), from: fromJob, to: toJob, status: 'PENDING_APPROVAL' };
    }
    const total = await postTransferLines(tx, req, tid, no, b, fromJob, toJob);
    await txExecute(tx, 'UPDATE trx_job_transfer SET approved_by = ?, approved_at = NOW(), posted_at = NOW() WHERE id = ?', [req.user!.id, tid]);
    await approvalHistory(tx, req, { doc_type: 'JOB_TRANSFER', doc_id: tid, action: 'POST', to: 'POSTED', remarks: b.reason });
    return { id: tid, transfer_no: no, total_qty: total, from: fromJob, to: toJob, status: 'POSTED' };
  });
  await audit(req, 'trx_job_transfer', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: out.status === 'POSTED' ? `${out.transfer_no}: ${out.total_qty} moved ${out.from} → ${out.to}` : `${out.transfer_no} sent for approval (${out.from} → ${out.to})` });
}));

/** POST /job-transfers/:id/approve | reject | send-back | cancel — the approval workflow. */
jobStockRouter.post('/job-transfers/:id/:action', requireAny('INVENTORY.ADJUST', 'INVENTORY.CREATE', 'PRODUCTION.CREATE', 'JOB_TRANSFER.APPROVE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const action = z.enum(['approve', 'reject', 'send-back', 'cancel']).parse(req.params.action);
  const remarks = z.string().trim().max(255).optional().parse(req.body?.remarks);
  if (action !== 'cancel' && !canApproveTransfer(req)) throw Forbidden('Only the approver (Production Manager) can approve / reject job transfers');
  const out = await transaction(async (tx) => {
    const t = await txQueryOne<any>(tx, 'SELECT * FROM trx_job_transfer WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!t) throw NotFound('Transfer not found');
    if (!['PENDING_APPROVAL', 'SEND_BACK'].includes(t.status)) throw BadRequest(`${t.transfer_no} is ${String(t.status).toLowerCase().replace('_', ' ')}`);
    if (action === 'cancel' && Number(t.created_by) !== req.user!.id && !canApproveTransfer(req)) throw Forbidden('Only the requester can cancel the request');
    if ((action === 'reject' || action === 'send-back') && (!remarks || remarks.length < 3)) throw BadRequest('Give the reason');
    if (action === 'approve') {
      if (t.status !== 'PENDING_APPROVAL') throw BadRequest(`${t.transfer_no} was sent back to the requester`);
      const b: TransferBody = { material_type: t.material_type, transfer_date: String(t.transfer_date).slice(0, 10), from_so_id: Number(t.from_so_id) || 0, to_so_id: Number(t.to_so_id) || 0,
        to_style_id: t.to_style_id ? Number(t.to_style_id) : null, reason: t.reason, lines: typeof t.lines_json === 'string' ? JSON.parse(t.lines_json) : t.lines_json };
      const total = await postTransferLines(tx, req, id, t.transfer_no, b, await jobNameOf(cid, b.from_so_id), await jobNameOf(cid, b.to_so_id));
      await txExecute(tx, `UPDATE trx_job_transfer SET status = 'POSTED', approved_by = ?, approved_at = NOW(), posted_at = NOW(), decision_remarks = ? WHERE id = ?`, [req.user!.id, remarks ?? null, id]);
      await approvalHistory(tx, req, { doc_type: 'JOB_TRANSFER', doc_id: id, action: 'APPROVE', from: t.status, to: 'POSTED', remarks });
      return { transfer_no: t.transfer_no, status: 'POSTED', total };
    }
    const to = action === 'reject' ? 'REJECTED' : action === 'send-back' ? 'SEND_BACK' : 'CANCELLED';
    await txExecute(tx, 'UPDATE trx_job_transfer SET status = ?, decision_remarks = ? WHERE id = ?', [to, remarks ?? null, id]);
    await approvalHistory(tx, req, { doc_type: 'JOB_TRANSFER', doc_id: id, action: action.toUpperCase().replace('-', '_'), from: t.status, to, remarks });
    return { transfer_no: t.transfer_no, status: to };
  });
  await audit(req, 'trx_job_transfer', id, 'UPDATE', undefined, out);
  res.json({ data: out, message: `${out.transfer_no} ${out.status.toLowerCase().replace('_', ' ')}` });
}));

jobStockRouter.get('/job-transfers', requireAny('INVENTORY.VIEW', 'PRODUCTION.VIEW'), ah(async (req, res) => {
  const rows = await query<any>(
    `SELECT t.*, COALESCE(f.io_no, f.so_no, 'GENERAL') from_job, COALESCE(s.io_no, s.so_no, 'GENERAL') to_job, st.style_code to_style, u.full_name created_by_name,
            (SELECT COUNT(*) FROM trx_job_transfer_line l WHERE l.transfer_id = t.id) line_count
       FROM trx_job_transfer t LEFT JOIN trx_sales_order f ON f.id = t.from_so_id LEFT JOIN trx_sales_order s ON s.id = t.to_so_id
       LEFT JOIN mst_style st ON st.id = t.to_style_id LEFT JOIN mst_user u ON u.id = t.created_by
      WHERE t.company_id = ? ORDER BY t.id DESC LIMIT 500`, [req.user!.companyId]);
  res.json({ data: rows });
}));
jobStockRouter.get('/job-transfers/:id', requireAny('INVENTORY.VIEW', 'PRODUCTION.VIEW'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const t = await queryOne<any>(
    `SELECT t.*, COALESCE(f.io_no, f.so_no, 'GENERAL') from_job, COALESCE(s.io_no, s.so_no, 'GENERAL') to_job FROM trx_job_transfer t
       LEFT JOIN trx_sales_order f ON f.id = t.from_so_id LEFT JOIN trx_sales_order s ON s.id = t.to_so_id WHERE t.id = ? AND t.company_id = ?`, [id, req.user!.companyId]);
  if (!t) throw NotFound('Transfer not found');
  res.json({ data: { ...t, lines: await query<any>('SELECT * FROM trx_job_transfer_line WHERE transfer_id = ? ORDER BY id', [id]) } });
}));

// =====================================================================================
// Material traceability (yarn / fabric → cutting)
// =====================================================================================
async function rollSource(rollId: number) {
  return queryOne<any>(
    `SELECT fr.id, fr.roll_no, fr.lot_no, fr.weight_kg, COALESCE(fr.issued_kg, 0) issued_kg, fr.stock_status, fr.qc_status, fr.process_state, fr.color_name, fr.source_fpo_id, fr.parent_roll_id, fr.so_id,
            COALESCE(so.io_no, so.so_no) io_no, fb.fabric_name, g.id grn_id, g.grn_no, g.grn_date, g.supplier_inv_no, g.supplier_dc_no,
            sup.party_name supplier, po.po_no, po.po_date, pr.src_type, pr.src_id, pr.ref_dc_no, pr.receipt_no
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
       LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) LEFT JOIN mst_party sup ON sup.id = g.supplier_id
       LEFT JOIN trx_process_receipt pr ON pr.grn_id = g.id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN trx_sales_order so ON so.id = fr.so_id
      WHERE fr.id = ?`, [rollId]);
}
async function billsForGrn(grnIds: number[]) {
  if (!grnIds.length) return [];
  return query<any>(
    `SELECT DISTINCT sb.id, sb.bill_no, sb.bill_date, sb.supplier_inv_no, sb.net_amount
       FROM trx_supplier_bill sb LEFT JOIN trx_supplier_bill_line sbl ON sbl.bill_id = sb.id LEFT JOIN trx_grn_line gl ON gl.id = sbl.grn_line_id
      WHERE sb.grn_id IN (?) OR gl.grn_id IN (?)`, [grnIds, grnIds]).catch(() => [] as any[]);
}

/** Yarn lots (with GRN / PO / supplier invoice) that fed a knitting program, exact lot first. */
async function yarnForProgram(cid: number, programId: number, dcNo: string | null) {
  return query<any>(
    `SELECT pi.dc_no, pi.issue_date, pi.lot_no, pi.issued_qty_kg, pi.grn_line_id, y.yarn_name,
            COALESCE(yg.grn_no, cg.grn_no) grn_no, COALESCE(yg.supplier_inv_no, cg.supplier_inv_no) supplier_inv_no, COALESCE(ypo.po_no, cpo.po_no) po_no,
            COALESCE(ys.party_name, cs.party_name) supplier, IF(pi.grn_line_id IS NULL, 'lot match', 'exact') link
       FROM trx_process_issue pi LEFT JOIN mst_yarn y ON y.id = pi.yarn_id
       LEFT JOIN trx_grn_line ygl ON ygl.id = pi.grn_line_id LEFT JOIN trx_grn yg ON yg.id = ygl.grn_id
       LEFT JOIN trx_purchase_order ypo ON ypo.id = COALESCE(ygl.po_id, yg.po_id) LEFT JOIN mst_party ys ON ys.id = yg.supplier_id
       LEFT JOIN trx_grn_line cgl ON pi.grn_line_id IS NULL AND cgl.id = (SELECT x.id FROM trx_grn_line x JOIN trx_grn xg ON xg.id = x.grn_id
              WHERE x.yarn_id = pi.yarn_id AND x.lot_no = pi.lot_no AND xg.company_id = pi.company_id ORDER BY xg.grn_date LIMIT 1)
       LEFT JOIN trx_grn cg ON cg.id = cgl.grn_id LEFT JOIN trx_purchase_order cpo ON cpo.id = COALESCE(cgl.po_id, cg.po_id) LEFT JOIN mst_party cs ON cs.id = cg.supplier_id
      WHERE pi.company_id = ? AND pi.src_type = 'KNITTING_PROGRAM' AND pi.src_id = ? ${dcNo ? 'AND pi.dc_no = ?' : ''}
      ORDER BY pi.id`, dcNo ? [cid, programId, dcNo] : [cid, programId]);
}

/**
 * Origin of a yarn lot (GRN line), recursively: a purchased lot gives its PO / GRN / supplier invoice;
 * a processed lot (dyed / wound / twisted) gives its yarn-process receipt and the lots that went in.
 */
export async function yarnLotOrigin(cid: number, grnLineId: number, depth = 0): Promise<any> {
  const l = await queryOne<any>(
    `SELECT gl.id grn_line_id, gl.lot_no, gl.color_name, gl.accepted_qty, y.yarn_name, g.id grn_id, g.grn_no, g.grn_date, g.supplier_inv_no, g.supplier_dc_no,
            p.party_name supplier, po.po_no, po.po_date
       FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
       LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) LEFT JOIN mst_party p ON p.id = g.supplier_id
      WHERE gl.id = ? AND g.company_id = ?`, [grnLineId, cid]);
  if (!l) return null;
  // made by the yarn process engine (dyeing / winding / twisting GRN, or a return / reject lot)
  const eng = await queryOne<any>(
    `SELECT x.id AS out_id, i.inward_no, i.inward_date, o.ypo_no, o.process_code, pt.name AS process_name, v.party_name AS vendor, gl.parent_grn_line_id
       FROM trx_grn_line gl LEFT JOIN trx_yarn_process_inward_out x ON x.grn_line_id = gl.id OR x.reject_grn_line_id = gl.id
       LEFT JOIN trx_yarn_process_inward i ON i.id = x.inward_id LEFT JOIN trx_yarn_process_order o ON o.id = gl.source_ypo_id
       LEFT JOIN mst_yarn_process_type pt ON pt.company_id = o.company_id AND pt.code = o.process_code LEFT JOIN mst_party v ON v.id = o.vendor_id
      WHERE gl.id = ? AND gl.source_ypo_id IS NOT NULL LIMIT 1`, [grnLineId]).catch(() => null);
  if (eng && depth <= 6) {
    const inputs = eng.out_id
      ? await query<any>(`SELECT l.ypo_id, o.ypo_no AS dc_no, o.ypo_date AS issue_date, l.lot_no, ii.input_kg AS issued_qty_kg, l.grn_line_id FROM trx_yarn_process_inward_in ii
                            JOIN trx_yarn_process_order_line l ON l.id = ii.ypo_line_id JOIN trx_yarn_process_order o ON o.id = l.ypo_id WHERE ii.out_id = ?`, [eng.out_id])
      : eng.parent_grn_line_id ? [{ dc_no: null, lot_no: null, issued_qty_kg: l.accepted_qty, grn_line_id: eng.parent_grn_line_id }] : [];
    const from = [];
    for (const i of inputs) from.push({ ...i, origin: i.grn_line_id ? await yarnLotOrigin(cid, Number(i.grn_line_id), depth + 1) : null });
    return { ...l, kind: 'PROCESSED', process: { process_no: eng.ypo_no, process_type: eng.process_code, process_name: eng.process_name, vendor: eng.vendor ?? l.supplier,
      receipt_no: eng.inward_no ?? l.grn_no, receipt_date: eng.inward_date, ref_dc_no: eng.ypo_no }, from };
  }
  const pr = await queryOne<any>(
    `SELECT pr.id, pr.receipt_no, pr.receipt_date, pr.ref_dc_no, pr.src_id, pr.input_qty, pr.output_qty, pr.loss_qty, yp.process_no, yp.process_type, v.party_name vendor
       FROM trx_process_receipt pr JOIN trx_yarn_process yp ON yp.id = pr.src_id LEFT JOIN mst_party v ON v.id = yp.vendor_id
      WHERE pr.grn_id = ? AND pr.src_type = 'YARN_PROCESS' LIMIT 1`, [l.grn_id]);
  if (!pr || depth > 6) return { ...l, kind: 'PURCHASED' };
  const inputs = await query<any>(
    `SELECT pi.dc_no, pi.issue_date, pi.lot_no, pi.issued_qty_kg, pi.grn_line_id FROM trx_process_issue pi
      WHERE pi.company_id = ? AND pi.src_type = 'YARN_PROCESS' AND pi.src_id = ? ${pr.ref_dc_no ? 'AND pi.dc_no = ?' : ''} ORDER BY pi.id`,
    pr.ref_dc_no ? [cid, pr.src_id, pr.ref_dc_no] : [cid, pr.src_id]);
  const from = [];
  for (const i of inputs) from.push({ ...i, origin: i.grn_line_id ? await yarnLotOrigin(cid, Number(i.grn_line_id), depth + 1) : null });
  // the process may carry no vendor — the processed lot's supplier is the DC's processor
  return { ...l, kind: 'PROCESSED', process: { ...pr, vendor: pr.vendor ?? l.supplier }, from };
}

/** GET /traceability/yarn-lot/:grnLineId — where a yarn lot came from (PO / GRN, or through yarn processing). */
jobStockRouter.get('/traceability/yarn-lot/:grnLineId', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.grnLineId);
  const o = await yarnLotOrigin(req.user!.companyId, id);
  if (!o) throw NotFound('Yarn lot not found');
  res.json({ data: o });
}));

/** GET /traceability/fabric-roll?roll_no= | ?roll_id= — upward chain to yarn / fabric PO, GRN, supplier invoice and bills; forward use in cutting. */
jobStockRouter.get('/traceability/fabric-roll', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ roll_no: z.string().trim().max(60).optional(), roll_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const start = q.roll_id ? await queryOne<any>('SELECT id FROM trx_fabric_roll WHERE id = ? AND company_id = ?', [q.roll_id, cid])
    : await queryOne<any>('SELECT id FROM trx_fabric_roll WHERE company_id = ? AND roll_no = ? ORDER BY id DESC LIMIT 1', [cid, q.roll_no]);
  if (!start) throw NotFound(`Roll ${q.roll_no ?? q.roll_id} not found`);
  res.json({ data: await rollTrace(cid, Number(start.id)) });
}));

/**
 * Reverse trace of a roll (genealogy doc §1, §9.2): roll → its parents (split / merge / process input) → the
 * knitting production and program → the yarn lots → PO / GRN / supplier; and forward use in cutting.
 */
export async function rollTrace(cid: number, rollId: number) {
  const chain: any[] = [];
  const seen = new Set<number>();
  let ids: number[] = [rollId];
  for (let depth = 0; depth < 12 && ids.length; depth++) {
    const next: number[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const r = await rollSource(id);
      if (!r) continue;
      const step: any = { depth, roll: r };
      // processed roll: the processing DC it came back on (a split / transferred roll shares its parent's DC)
      const parent = r.parent_roll_id ? await queryOne<any>('SELECT source_fpo_id FROM trx_fabric_roll WHERE id = ?', [r.parent_roll_id]) : null;
      if (r.source_fpo_id && (!parent || Number(parent.source_fpo_id) !== Number(r.source_fpo_id))) {
        step.process = await queryOne<any>('SELECT fpo_no, fpo_date, sub_process, p.party_name vendor FROM trx_fabric_process_order o LEFT JOIN mst_party p ON p.id = o.vendor_id WHERE o.id = ?', [r.source_fpo_id]);
      }
      // a merged roll came from several rolls (roll history MERGED_FROM)
      const merged = await query<any>(`SELECT related_roll_id FROM trx_fabric_roll_history WHERE roll_id = ? AND event = 'MERGED_FROM' AND related_roll_id IS NOT NULL`, [id]);
      if (merged.length) { step.merged_from = merged.map((m) => Number(m.related_roll_id)); next.push(...step.merged_from); }
      else if (r.parent_roll_id) next.push(Number(r.parent_roll_id));
      else if (r.source_fpo_id) {
        const ins = await query<any>('SELECT DISTINCT fabric_roll_id FROM trx_fabric_process_roll_in WHERE fpo_id = ? AND fabric_roll_id IS NOT NULL', [r.source_fpo_id]);
        next.push(...ins.map((x) => Number(x.fabric_roll_id)));
      }
      if (r.src_type === 'KNITTING_PROGRAM' && r.src_id) {
        step.knitting = await queryOne<any>('SELECT program_no, io_no, p.party_name knitter FROM trx_knitting_program kp LEFT JOIN mst_party p ON p.id = kp.vendor_id WHERE kp.id = ?', [r.src_id]);
        step.yarn = await yarnForProgram(cid, Number(r.src_id), r.ref_dc_no ?? null);
        // a dyed / wound / twisted lot: show what it was made from
        for (const y of step.yarn) if (y.grn_line_id) y.origin = await yarnLotOrigin(cid, Number(y.grn_line_id));
      }
      if (!r.parent_roll_id && !r.source_fpo_id) step.bills = await billsForGrn([Number(r.grn_id)]);
      if (step.process) step.process_bill = await queryOne<any>(`SELECT b.bill_no, b.bill_date, b.net_amount FROM trx_fabric_process_bill b JOIN trx_fabric_process_inward i ON i.bill_id = b.id WHERE i.grn_id = ? AND b.status = 'POSTED' LIMIT 1`, [r.grn_id]);
      chain.push(step);
    }
    ids = next;
  }
  const forward = await query<any>(
    `SELECT fi.issue_no, fi.issue_date, cp.plan_no, fir.issue_kg, fr.roll_no FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = fi.cutting_plan_id JOIN trx_fabric_roll fr ON fr.id = fir.fabric_roll_id WHERE fir.fabric_roll_id IN (?)`, [[...seen]]);
  return { chain, cutting: forward };
}

/** GET /traceability/job/:soId — every yarn lot / fabric roll of a job with its source and downstream use. */
jobStockRouter.get('/traceability/job/:soId', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const so = await queryOne<any>('SELECT id, so_no, io_no, buyer_po_no FROM trx_sales_order WHERE id = ? AND company_id = ?', [soId, cid]);
  if (!so) throw NotFound('Job not found');
  const yarn = await yarnJobLots(cid, { so_id: soId, includeGeneral: false });
  for (const y of yarn) y.origin = await yarnLotOrigin(cid, Number(y.grn_line_id));
  const yarnIssued = await query<any>(
    `SELECT pi.dc_no, pi.issue_date, pi.src_type, pi.lot_no, pi.issued_qty_kg, y.yarn_name, g.grn_no, po.po_no, g.supplier_inv_no, p.party_name supplier, v.party_name vendor
       FROM trx_process_issue pi LEFT JOIN mst_yarn y ON y.id = pi.yarn_id LEFT JOIN trx_grn_line gl ON gl.id = pi.grn_line_id LEFT JOIN trx_grn g ON g.id = gl.grn_id
       LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN mst_party v ON v.id = pi.vendor_id
      WHERE pi.company_id = ? AND pi.so_id = ? ORDER BY pi.issue_date, pi.id`, [cid, soId]);
  const rolls = await query<any>(
    `SELECT fr.id, fr.roll_no, fr.lot_no, fb.fabric_name, fr.process_state, fr.color_name, fr.weight_kg, ROUND(fr.weight_kg - COALESCE(fr.issued_kg, 0), 3) balance_kg,
            g.grn_no, g.grn_date, g.supplier_inv_no, sup.party_name supplier, po.po_no, fr.source_fpo_id, fr.parent_roll_id,
            (SELECT GROUP_CONCAT(DISTINCT cp.plan_no) FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id LEFT JOIN trx_cutting_plan cp ON cp.id = fi.cutting_plan_id WHERE fir.fabric_roll_id = fr.id) cut_plans
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN trx_grn_line gl ON gl.id = fr.grn_line_id
       LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id) LEFT JOIN mst_party sup ON sup.id = g.supplier_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
      WHERE fr.company_id = ? AND fr.so_id = ? ORDER BY g.grn_date, fr.id`, [cid, soId]);
  const transfers = await query<any>(
    `SELECT t.transfer_no, t.transfer_date, t.material_type, t.total_qty, t.reason, COALESCE(f.io_no, f.so_no, 'GENERAL') from_job, COALESCE(s.io_no, s.so_no, 'GENERAL') to_job
       FROM trx_job_transfer t LEFT JOIN trx_sales_order f ON f.id = t.from_so_id LEFT JOIN trx_sales_order s ON s.id = t.to_so_id
      WHERE t.company_id = ? AND (t.from_so_id = ? OR t.to_so_id = ?) ORDER BY t.id`, [cid, soId, soId]);
  res.json({ data: { job: so, yarn_lots: yarn, yarn_issued: yarnIssued, fabric_rolls: rolls, transfers } });
}));



/**
 * KG of a roll held by live process quotations (other than `excludeParam`) and not yet sent on their DCs —
 * a roll on a quotation is not offered to another quotation (genealogy doc §18 / §19: no duplicate active allocation).
 * A live quotation is one not rejected / cancelled / expired / deleted.
 */
export const OPEN_ALLOC_SQL = (rollRef: string, excludeParam: string) => `(SELECT COALESCE(SUM(GREATEST(qr.qty_kg - COALESCE((
      SELECT SUM(ri2.weight_kg) FROM trx_fabric_process_roll_in ri2 JOIN trx_fabric_process_order o2 ON o2.id = ri2.fpo_id
       WHERE ri2.fabric_roll_id = qr.fabric_roll_id AND o2.quotation_id = qr.quotation_id AND o2.status <> 'CANCELLED'), 0), 0)), 0)
    FROM trx_quotation_roll qr JOIN trx_quotation q ON q.id = qr.quotation_id LEFT JOIN cfg_status cs ON cs.id = q.status_id
   WHERE qr.fabric_roll_id = ${rollRef} AND qr.quotation_id <> ${excludeParam} AND COALESCE(q.is_deleted, 0) = 0
     AND COALESCE(cs.code, '') NOT IN ('REJECTED', 'CANCELLED', 'EXPIRED', 'LOST'))`;

// =====================================================================================
// Job material genealogy (client doc "Yarn → Fabric → Process Job Material Genealogy", 03-Oct-2026)
//   BOM = plan · genealogy = trace · stock = availability · process transaction = execution.
//   A job whose BOM has only yarn still has fabric: the rolls its knitting produced carry the job (so_id),
//   so downstream processes (dyeing quotation / DC) work from the job's actual available fabric, not a fabric BOM.
// =====================================================================================
const r3g = (x: unknown) => Math.round((Number(x) || 0) * 1000) / 1000;

/** The job's fabric rolls that can go to a process now: QC accepted, KG left, not on a draft DC; grouped for quoting. */
export async function jobFabricAvailability(cid: number, soId: number, opts: { state?: string | null; excludeQuotationId?: number | null } = {}) {
  const w = ['fr.company_id = ?', 'fr.so_id = ?', `fr.qc_status = 'ACCEPTED'`, `fr.stock_status <> 'CLOSED'`];
  const p: unknown[] = [cid, soId];
  if (opts.state) { w.push('fr.process_state = ?'); p.push(opts.state); }
  const rows = await query<any>(
    `SELECT fr.id, fr.roll_no, fr.lot_no, fr.fabric_id, fb.fabric_name, fr.process_state, fr.color_name, fr.gsm, fr.dia, fr.fabric_form,
            fr.weight_kg, COALESCE(fr.issued_kg, 0) issued_kg, fr.meters, fr.calc_meters, fr.actual_meters, w.warehouse_name, g.grn_no, g.grn_date,
            (SELECT COALESCE(SUM(ri.weight_kg), 0) FROM trx_fabric_process_roll_in ri WHERE ri.fabric_roll_id = fr.id AND ri.status = 'DRAFT') draft_kg,
            ${OPEN_ALLOC_SQL('fr.id', '?')} allocated_kg,
            (SELECT kp.program_no FROM trx_process_receipt pr JOIN trx_knitting_program kp ON kp.id = pr.src_id WHERE pr.grn_id = fr.grn_id AND pr.src_type = 'KNITTING_PROGRAM' LIMIT 1) program_no
       FROM trx_fabric_roll fr JOIN trx_grn g ON g.id = fr.grn_id LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
      WHERE ${w.join(' AND ')} ORDER BY g.grn_date, fr.id`, [opts.excludeQuotationId ?? 0, ...p]);
  const rolls = rows.map((r) => {
    const avail = r3g(Number(r.weight_kg) - Number(r.issued_kg) - Number(r.draft_kg) - Number(r.allocated_kg));
    const mPerKg = Number(r.weight_kg) > 0 ? Number(r.meters || r.calc_meters || 0) / Number(r.weight_kg) : 0;
    return { ...r, colour: r.color_name || (r.process_state === 'GREY' ? 'GREY' : null), available_kg: avail, available_m: r3g(avail * mPerKg) };
  }).filter((r) => r.available_kg > 0.0005);
  const groups = new Map<string, any>();
  for (const r of rolls) {
    const k = `${r.fabric_id}|${r.process_state}|${r.colour ?? ''}|${r.gsm ?? ''}|${r.dia ?? ''}`;
    const g = groups.get(k) ?? { key: k, fabric_id: r.fabric_id, fabric_name: r.fabric_name, process_state: r.process_state, colour: r.colour, gsm: r.gsm, dia: r.dia,
      fabric_form: r.fabric_form, rolls: 0, available_kg: 0, available_m: 0, roll_ids: [] as number[], programs: new Set<string>() };
    g.rolls += 1; g.available_kg = r3g(g.available_kg + r.available_kg); g.available_m = r3g(g.available_m + r.available_m); g.roll_ids.push(Number(r.id));
    if (r.program_no) g.programs.add(r.program_no);
    groups.set(k, g);
  }
  return { rolls, groups: [...groups.values()].map((g) => ({ ...g, programs: [...g.programs].join(', ') })) };
}

const jobRow = async (cid: number, soId: number) => queryOne<any>(
  `SELECT so.id, so.so_no, COALESCE(so.io_no, so.so_no) job_no, so.buyer_po_no, b.party_name buyer_name,
          (SELECT GROUP_CONCAT(DISTINCT st.style_code) FROM trx_sales_order_line sol JOIN mst_style st ON st.id = sol.style_id WHERE sol.so_id = so.id) styles
     FROM trx_sales_order so LEFT JOIN mst_party b ON b.id = so.buyer_id WHERE so.id = ? AND so.company_id = ? AND so.is_deleted = 0`, [soId, cid]);

/** GET /jobs/:soId/fabric-availability?state=GREY — the job's actual fabric for a process quotation / DC. */
jobStockRouter.get('/jobs/:soId/fabric-availability', requireAny('PRODUCTION.VIEW', 'QUOTATION.VIEW', 'FABRIC_PROCESS.VIEW', 'PURCHASE.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const q = z.object({ state: z.string().trim().max(20).optional(), exclude_quotation_id: z.coerce.number().int().min(0).optional() }).parse(req.query);
  const job = await jobRow(cid, soId);
  if (!job) throw NotFound('Job not found');
  res.json({ data: { job, ...(await jobFabricAvailability(cid, soId, { state: q.state || null, excludeQuotationId: q.exclude_quotation_id ?? null })) } });
}));

/** GET /jobs/:soId/yarn-availability — the yarn the job holds (own PO / GRN lots + transfers), grouped by yarn + shade. */
jobStockRouter.get('/jobs/:soId/yarn-availability', requireAny('PRODUCTION.VIEW', 'QUOTATION.VIEW', 'YARN_PROCESS.VIEW', 'PURCHASE.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const job = await jobRow(cid, soId);
  if (!job) throw NotFound('Job not found');
  const lots = await yarnJobLots(cid, { so_id: soId, includeGeneral: false });
  const groups = new Map<string, any>();
  for (const l of lots) {
    const shade = l.color_name || l.shade || null;
    const k = `${l.yarn_id}|${shade ?? ''}`;
    const g = groups.get(k) ?? { key: k, yarn_id: l.yarn_id, yarn_name: l.yarn_name, yarn_code: l.yarn_code, count_str: l.count_str, shade, lots: 0, available_kg: 0, lot_nos: [] as string[] };
    g.lots += 1; g.available_kg = r3g(g.available_kg + Number(l.available_kg)); if (l.lot_no) g.lot_nos.push(l.lot_no);
    groups.set(k, g);
  }
  res.json({ data: { job, lots, groups: [...groups.values()].map((g) => ({ ...g, lot_nos: [...new Set(g.lot_nos)].join(', ') })) } });
}));

/**
 * GET /jobs/:soId/genealogy — plan vs actual for the job (doc §11) and its lineage:
 * planned yarn (BOM) → purchased → issued to knitting → consumed → fabric good / reject / loss → fabric available
 * → each process (input / good / reject / loss).
 */
jobStockRouter.get('/jobs/:soId/genealogy', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const job = await jobRow(cid, soId);
  if (!job) throw NotFound('Job not found');
  let bom: any = null;
  try { bom = await jobBomRequirement(cid, { so_id: soId }); } catch { bom = null; }
  const planned = (t: string) => r3g((bom?.lines ?? []).filter((l: any) => l.material_type === t).reduce((a: number, l: any) => a + Number(l.final_requirement || 0), 0));
  const one = async (sql: string, p: unknown[]) => Number((await queryOne<any>(sql, p))?.v ?? 0);
  const yarnPurchased = await one(`SELECT COALESCE(SUM(gl.accepted_qty), 0) v FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
     WHERE g.company_id = ? AND gl.material_type = 'YARN' AND gl.so_id = ? AND COALESCE(gl.po_id, g.po_id) IS NOT NULL`, [cid, soId]);
  const programs = await query<any>(`SELECT id, program_no, status, fabric_type, fabric_colour, required_qty_kg, program_source FROM trx_knitting_program
     WHERE company_id = ? AND (so_id = ? OR io_no = ?) AND status <> 'CANCELLED' ORDER BY id`, [cid, soId, job.job_no]);
  const pids = programs.map((p) => p.id);
  const yarnIssued = pids.length ? await one(`SELECT COALESCE(SUM(issued_qty_kg), 0) v FROM trx_process_issue WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id IN (?)`, [cid, pids]) : 0;
  const knit = pids.length ? await queryOne<any>(`SELECT COALESCE(SUM(input_qty), 0) consumed, COALESCE(SUM(output_qty), 0) good, COALESCE(SUM(rejected_qty), 0) reject, COALESCE(SUM(loss_qty), 0) loss,
       GROUP_CONCAT(receipt_no) receipts FROM trx_process_receipt WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id IN (?)`, [cid, pids]) : null;
  const dcs = pids.length ? await query<any>(`SELECT dc_no, MIN(issue_date) dc_date, SUM(issued_qty_kg) kg FROM trx_process_issue WHERE company_id = ? AND src_type = 'KNITTING_PROGRAM' AND src_id IN (?) AND dc_no IS NOT NULL GROUP BY dc_no ORDER BY MIN(id)`, [cid, pids]) : [];
  const processes = await query<any>(`SELECT o.id, o.fpo_no, o.fpo_date, o.sub_process, o.status, p.party_name vendor, SUM(ri.weight_kg) input_kg, SUM(ri.good_kg) good_kg, SUM(ri.reject_kg) reject_kg, SUM(ri.loss_kg) loss_kg
       FROM trx_fabric_process_roll_in ri JOIN trx_fabric_process_order o ON o.id = ri.fpo_id LEFT JOIN mst_party p ON p.id = o.vendor_id
      WHERE o.company_id = ? AND ri.so_id = ? AND o.status NOT IN ('CANCELLED', 'DRAFT') GROUP BY o.id ORDER BY o.id`, [cid, soId]);
  const avail = await jobFabricAvailability(cid, soId);
  const byState = (st: string) => r3g(avail.rolls.filter((r: any) => r.process_state === st).reduce((a: number, r: any) => a + r.available_kg, 0));
  res.json({ data: {
    job,
    reconciliation: {
      planned_yarn_kg: planned('YARN'), planned_fabric_kg: planned('FABRIC'), yarn_purchased_kg: r3g(yarnPurchased), yarn_issued_kg: r3g(yarnIssued),
      yarn_consumed_kg: r3g(knit?.consumed), fabric_good_kg: r3g(knit?.good), fabric_reject_kg: r3g(knit?.reject), knitting_loss_kg: r3g(knit?.loss),
      fabric_available_kg: r3g(avail.rolls.reduce((a: number, r: any) => a + r.available_kg, 0)), grey_available_kg: byState('GREY'),
    },
    bom: bom ? { bom_no: bom.bom?.bom_no ?? null, boms: (bom.boms ?? []).map((b: any) => b.bom_no) } : null,
    programs, knitting_dcs: dcs, knitting_receipts: knit?.receipts ? String(knit.receipts).split(',') : [],
    processes: processes.map((x) => ({ ...x, input_kg: r3g(x.input_kg), good_kg: r3g(x.good_kg), reject_kg: r3g(x.reject_kg), loss_kg: r3g(x.loss_kg) })),
    fabric_groups: avail.groups,
  } });
}));
