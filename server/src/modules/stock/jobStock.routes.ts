import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { refreshFabricRollStatus } from '../production/cuttingEngine.js';
import { yarnStockRows, yarnStockQuery } from '../procurement/fabricYarnProcurement.routes.js';

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
  const tr = await query<any>(
    `SELECT l.grn_line_id, t.from_so_id, t.to_so_id, SUM(l.qty) qty FROM trx_job_transfer_line l JOIN trx_job_transfer t ON t.id = l.transfer_id
      WHERE t.company_id = ? AND t.material_type = 'YARN' AND t.status = 'POSTED' AND l.grn_line_id IN (?) GROUP BY l.grn_line_id, t.from_so_id, t.to_so_id`, [cid, ids]);
  const di = await query<any>(`SELECT grn_line_id, so_id, SUM(issued_qty_kg) qty FROM trx_process_issue WHERE company_id = ? AND grn_line_id IN (?) GROUP BY grn_line_id, so_id`, [cid, ids]);
  const out: any[] = [];
  for (const r of lots) {
    const gl = Number(r.id);
    const owner = key(r.owner_so_id);
    const hold = new Map<number, number>();
    hold.set(owner, n(r.net_in_qty) - (n(r.issued_qty) - n(r.direct_issued_qty)));
    for (const t of tr.filter((x) => Number(x.grn_line_id) === gl)) {
      hold.set(key(t.from_so_id), (hold.get(key(t.from_so_id)) ?? 0) - n(t.qty));
      hold.set(key(t.to_so_id), (hold.get(key(t.to_so_id)) ?? 0) + n(t.qty));
    }
    for (const d of di.filter((x) => Number(x.grn_line_id) === gl)) {
      const h = d.so_id && hold.has(key(d.so_id)) ? key(d.so_id) : owner;
      hold.set(h, (hold.get(h) ?? 0) - n(d.qty));
    }
    for (const [so, qty] of hold) {
      if (qty <= 0.0005) continue;
      if (f.so_id !== undefined && f.so_id !== null && so !== key(f.so_id) && !(f.includeGeneral && so === 0)) continue;
      out.push({
        grn_line_id: gl, holder_so_id: so || null, own_lot: so === owner, available_kg: r4(qty),
        yarn_id: r.yarn_id, yarn_name: r.yarn_name, yarn_code: r.yarn_code, count_str: r.count_str, lot_no: r.lot_no, shade: r.shade, color_name: r.color_name,
        grn_id: r.grn_id, grn_no: r.grn_no, grn_date: r.grn_date, po_no: r.po_no, supplier_name: r.supplier_name, warehouse_id: r.warehouse_id, warehouse_name: r.warehouse_name,
        owner_so_id: r.owner_so_id, io_no: r.internal_ir_no, uom_code: r.uom_code,
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

/** GET /yarn-stock/job-lots?so_id=&yarn_id=&warehouse_id= — the job's yarn lots (bought for it or transferred to it) + general stock. */
jobStockRouter.get('/yarn-stock/job-lots', requireAny('PRODUCTION.VIEW', 'INVENTORY.VIEW'), ah(async (req, res) => {
  const q = z.object({ so_id: z.coerce.number().int().positive().optional(), yarn_id: z.coerce.number().int().positive().optional(),
    warehouse_id: z.coerce.number().int().positive().optional(), general: z.coerce.number().int().optional() }).parse(req.query);
  const rows = await yarnJobLots(req.user!.companyId, { so_id: q.so_id ?? null, yarn_id: q.yarn_id, warehouse_id: q.warehouse_id, includeGeneral: q.general !== 0 });
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

async function fabricHistory(tx: Tx, req: Request, h: { roll_id: number; roll_no: string; ref_id: number; ref_no: string; qty: number; so_id: number | null; related: number | null; remarks: string }) {
  await txExecute(tx,
    `INSERT INTO trx_fabric_roll_history (company_id, roll_id, roll_no, event, ref_type, ref_id, ref_no, qty_kg, so_id, related_roll_id, remarks, user_id)
     VALUES (?,?,?,'JOB_TRANSFER','JTR',?,?,?,?,?,?,?)`,
    [req.user!.companyId, h.roll_id, h.roll_no, h.ref_id, h.ref_no, h.qty, h.so_id, h.related, h.remarks, req.user!.id]);
}

/** POST /job-transfers — move yarn lots / fabric rolls / trim stock from one job (or general) to another. */
jobStockRouter.post('/job-transfers', requireAny('INVENTORY.ADJUST', 'INVENTORY.CREATE', 'PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = transferSchema.parse(req.body);
  if (b.from_so_id === b.to_so_id) throw BadRequest('From and to job are the same');
  const jobName = async (id: number) => id ? (await queryOne<any>('SELECT COALESCE(io_no, so_no) j FROM trx_sales_order WHERE id = ? AND company_id = ?', [id, cid]))?.j : 'GENERAL';
  const fromJob = await jobName(b.from_so_id), toJob = await jobName(b.to_so_id);
  if (!fromJob || !toJob) throw BadRequest('Job not found');
  const out = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'JOB_TRANSFER');
    const t = await txExecute(tx,
      `INSERT INTO trx_job_transfer (company_id, transfer_no, transfer_date, material_type, from_so_id, to_so_id, to_style_id, reason, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [cid, no, b.transfer_date, b.material_type, b.from_so_id || null, b.to_so_id || null, b.to_style_id ?? null, b.reason, req.user!.id]);
    const tid = Number(t.insertId);
    let total = 0;
    if (b.material_type === 'YARN') {
      const lots = await yarnJobLots(cid, { grn_line_ids: b.lines.map((l) => l.ref_id) });
      for (const l of b.lines) {
        const h = lots.find((x) => x.grn_line_id === l.ref_id && key(x.holder_so_id) === b.from_so_id);
        if (!h) throw BadRequest(`Yarn lot ${l.ref_id} is not held by ${fromJob}`);
        if (l.qty > h.available_kg + 1e-6) throw BadRequest(`Lot ${h.lot_no}: only ${h.available_kg} KG held by ${fromJob}`);
        await txExecute(tx, 'INSERT INTO trx_job_transfer_line (transfer_id, grn_line_id, item_label, lot_no, qty) VALUES (?,?,?,?,?)',
          [tid, l.ref_id, `${h.yarn_name}${h.count_str ? ` ${h.count_str}` : ''} · ${h.grn_no}`, h.lot_no, r4(l.qty)]);
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
        total += l.qty;
      }
    }
    await txExecute(tx, 'UPDATE trx_job_transfer SET total_qty = ? WHERE id = ?', [r4(total), tid]);
    return { id: tid, transfer_no: no, total_qty: r4(total), from: fromJob, to: toJob };
  });
  await audit(req, 'trx_job_transfer', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.transfer_no}: ${out.total_qty} moved ${out.from} → ${out.to}` });
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
    `SELECT fr.id, fr.roll_no, fr.lot_no, fr.weight_kg, fr.process_state, fr.color_name, fr.source_fpo_id, fr.parent_roll_id, fr.so_id,
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

/** GET /traceability/fabric-roll?roll_no= | ?roll_id= — upward chain to yarn / fabric PO, GRN, supplier invoice and bills; forward use in cutting. */
jobStockRouter.get('/traceability/fabric-roll', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ roll_no: z.string().trim().max(60).optional(), roll_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const start = q.roll_id ? { id: q.roll_id } : await queryOne<any>('SELECT id FROM trx_fabric_roll WHERE company_id = ? AND roll_no = ? ORDER BY id DESC LIMIT 1', [cid, q.roll_no]);
  if (!start) throw NotFound(`Roll ${q.roll_no} not found`);
  const chain: any[] = [];
  const seen = new Set<number>();
  let ids: number[] = [Number(start.id)];
  for (let depth = 0; depth < 12 && ids.length; depth++) {
    const next: number[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const r = await rollSource(id);
      if (!r) continue;
      const step: any = { depth, roll: r };
      if (r.parent_roll_id) next.push(Number(r.parent_roll_id));
      else if (r.source_fpo_id) {
        const ins = await query<any>('SELECT DISTINCT fabric_roll_id FROM trx_fabric_process_roll_in WHERE fpo_id = ? AND fabric_roll_id IS NOT NULL', [r.source_fpo_id]);
        next.push(...ins.map((x) => Number(x.fabric_roll_id)));
        step.process = await queryOne<any>('SELECT fpo_no, fpo_date, sub_process, p.party_name vendor FROM trx_fabric_process_order o LEFT JOIN mst_party p ON p.id = o.vendor_id WHERE o.id = ?', [r.source_fpo_id]);
      }
      if (r.src_type === 'KNITTING_PROGRAM' && r.src_id) {
        step.knitting = await queryOne<any>('SELECT program_no, io_no, p.party_name knitter FROM trx_knitting_program kp LEFT JOIN mst_party p ON p.id = kp.vendor_id WHERE kp.id = ?', [r.src_id]);
        step.yarn = await yarnForProgram(cid, Number(r.src_id), r.ref_dc_no ?? null);
      }
      if (!r.parent_roll_id && !r.source_fpo_id) step.bills = await billsForGrn([Number(r.grn_id)]);
      chain.push(step);
    }
    ids = next;
  }
  const forward = await query<any>(
    `SELECT fi.issue_no, fi.issue_date, cp.plan_no, fir.issue_kg, fr.roll_no FROM trx_fabric_issue_roll fir JOIN trx_fabric_issue fi ON fi.id = fir.fabric_issue_id
       LEFT JOIN trx_cutting_plan cp ON cp.id = fi.cutting_plan_id JOIN trx_fabric_roll fr ON fr.id = fir.fabric_roll_id WHERE fir.fabric_roll_id IN (?)`, [[...seen]]);
  res.json({ data: { chain, cutting: forward } });
}));

/** GET /traceability/job/:soId — every yarn lot / fabric roll of a job with its source and downstream use. */
jobStockRouter.get('/traceability/job/:soId', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const soId = z.coerce.number().int().positive().parse(req.params.soId);
  const so = await queryOne<any>('SELECT id, so_no, io_no, buyer_po_no FROM trx_sales_order WHERE id = ? AND company_id = ?', [soId, cid]);
  if (!so) throw NotFound('Job not found');
  const yarn = await yarnJobLots(cid, { so_id: soId, includeGeneral: false });
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


