import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';
import { yarnJobLots } from '../stock/jobStock.routes.js';
import { YP, can, r3, r2, n, EPS, date, processType, whName, coneHistory, lotRow, lotOut, lotGrn, lotIn } from './yarnEngine.common.js';
import { insertOutwardHeader, writeOutwardLines } from './yarnEngine.routes.js';

/**
 * Yarn Process engine, part 2: return, reprocess (billable / non-billable + cost treatment),
 * contractor bill, cone tracking, ledger, job reconciliation and reports
 * (Garment_ERP_Yarn_Process_Developer_Document §12–§16, §23–§25).
 */
export const yarnEngineAfterRouter = Router();

// =====================================================================================
// Lot pickers
// =====================================================================================
/** GET /yarn-process/lots?so_id= — lots a job can send (its own + general stock), with GRN / PO / supplier. */
yarnEngineAfterRouter.get('/yarn-process/lots', requirePermission(YP.VIEW), ah(async (req, res) => {
  const q = z.object({ so_id: z.coerce.number().int().min(0).optional(), yarn_id: z.coerce.number().int().optional() }).parse(req.query);
  const rows = await yarnJobLots(req.user!.companyId, { so_id: q.so_id ?? 0, yarn_id: q.yarn_id, includeGeneral: true });
  const ids = rows.map((r) => r.grn_line_id);
  const extra = ids.length ? await query<any>('SELECT id, cone_no, no_of_rolls, source_ypo_id FROM trx_grn_line WHERE id IN (?)', [ids]) : [];
  res.json({ data: rows.map((r) => { const x = extra.find((e) => Number(e.id) === r.grn_line_id); return { ...r, cone_no: x?.cone_no ?? null, cones: Number(x?.no_of_rolls) || 0, processed: !!x?.source_ypo_id }; }) });
}));

/** GET /yarn-process/reject-lots — reject / returned yarn lots with KG left (eligible for reprocess). */
yarnEngineAfterRouter.get('/yarn-process/reject-lots', requirePermission(YP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query<any>(
    `SELECT gl.id AS grn_line_id, gl.lot_no, gl.cone_no, gl.yarn_id, y.yarn_name, gl.color_name AS shade, gl.so_id, COALESCE(so.io_no, so.so_no) AS io_no, g.grn_no, g.warehouse_id, w.warehouse_name,
            gl.accepted_qty - COALESCE((SELECT SUM(pi.issued_qty_kg) FROM trx_process_issue pi WHERE pi.grn_line_id = gl.id), 0) AS balance_kg,
            (SELECT rl.return_id FROM trx_yarn_process_return_line rl WHERE rl.return_grn_line_id = gl.id LIMIT 1) AS return_id,
            (SELECT r.return_no FROM trx_yarn_process_return_line rl JOIN trx_yarn_process_return r ON r.id = rl.return_id WHERE rl.return_grn_line_id = gl.id LIMIT 1) AS return_no,
            pg.grn_no AS source_doc
       FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = gl.so_id LEFT JOIN trx_grn_line pgl ON pgl.id = gl.parent_grn_line_id LEFT JOIN trx_grn pg ON pg.id = pgl.grn_id
      WHERE g.company_id = ? AND gl.material_type = 'YARN' AND gl.qc_status = 'REJECTED' AND gl.source_ypo_id IS NOT NULL
     HAVING balance_kg > 0.0005 ORDER BY gl.id DESC`, [cid]);
  res.json({ data: rows.map((r) => ({ ...r, balance_kg: r3(n(r.balance_kg)) })) });
}));

/** GET /yarn-process/processed-lots?inward_id= — good output lots of posted GRNs with KG left (for a return). */
yarnEngineAfterRouter.get('/yarn-process/processed-lots', requirePermission(YP.VIEW), ah(async (req, res) => {
  const q = z.object({ inward_id: z.coerce.number().int().optional() }).parse(req.query);
  const where = ['i.company_id = ?', `i.status = 'POSTED'`]; const p: unknown[] = [req.user!.companyId];
  if (q.inward_id) { where.push('i.id = ?'); p.push(q.inward_id); }
  const rows = await query<any>(
    `SELECT gl.id AS grn_line_id, gl.lot_no, gl.cone_no, gl.yarn_id, y.yarn_name, gl.color_name AS shade, gl.so_id, x.io_no, i.inward_no, i.id AS inward_id, w.warehouse_name,
            gl.accepted_qty - COALESCE((SELECT SUM(pi.issued_qty_kg) FROM trx_process_issue pi WHERE pi.grn_line_id = gl.id), 0) AS balance_kg
       FROM trx_yarn_process_inward_out x JOIN trx_yarn_process_inward i ON i.id = x.inward_id JOIN trx_grn_line gl ON gl.id = x.grn_line_id
       JOIN trx_grn g ON g.id = gl.grn_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id
      WHERE ${where.join(' AND ')} HAVING balance_kg > 0.0005 ORDER BY i.id DESC, x.id`, p);
  res.json({ data: rows.map((r) => ({ ...r, balance_kg: r3(n(r.balance_kg)) })) });
}));

// =====================================================================================
// Return (doc §12)
// =====================================================================================
const returnSchema = z.object({
  return_date: date,
  inward_id: s.id(),
  return_type: z.enum(['QUALITY', 'REPROCESS', 'OTHER']).default('QUALITY'),
  reason_id: s.idReq(),
  warehouse_id: s.idReq(),
  remarks: s.text(),
  lines: z.array(z.object({ source_grn_line_id: s.idReq(), qty_kg: z.coerce.number().positive(), defect_reason: s.nullableStr(160) })).min(1, 'Pick the cones / lots to return'),
});

yarnEngineAfterRouter.get('/yarn-process/returns', requirePermission(YP.VIEW), ah(async (req, res) => {
  res.json({ data: await query<any>(
    `SELECT r.*, i.inward_no, o.ypo_no, v.party_name AS vendor_name, rs.reason, w.warehouse_name,
            (SELECT GROUP_CONCAT(DISTINCT COALESCE(so.io_no, so.so_no) SEPARATOR ', ') FROM trx_yarn_process_return_line rl LEFT JOIN trx_sales_order so ON so.id = rl.so_id WHERE rl.return_id = r.id) AS jobs
       FROM trx_yarn_process_return r LEFT JOIN trx_yarn_process_inward i ON i.id = r.inward_id LEFT JOIN trx_yarn_process_order o ON o.id = r.ypo_id
       LEFT JOIN mst_party v ON v.id = r.vendor_id LEFT JOIN mst_fabric_process_reason rs ON rs.id = r.reason_id LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id
      WHERE r.company_id = ? ORDER BY r.id DESC LIMIT 1000`, [req.user!.companyId]) });
}));
yarnEngineAfterRouter.get('/yarn-process/returns/:id', requirePermission(YP.VIEW), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const r = await queryOne<any>(
    `SELECT r.*, i.inward_no, o.ypo_no, v.party_name AS vendor_name, rs.reason, w.warehouse_name FROM trx_yarn_process_return r
       LEFT JOIN trx_yarn_process_inward i ON i.id = r.inward_id LEFT JOIN trx_yarn_process_order o ON o.id = r.ypo_id LEFT JOIN mst_party v ON v.id = r.vendor_id
       LEFT JOIN mst_fabric_process_reason rs ON rs.id = r.reason_id LEFT JOIN mst_warehouse w ON w.id = r.warehouse_id WHERE r.id = ? AND r.company_id = ?`, [id, req.user!.companyId]);
  if (!r) throw NotFound('Return not found');
  const lines = await query<any>(
    `SELECT rl.*, COALESCE(so.io_no, so.so_no) AS io_no, gl.lot_no AS return_lot_no,
            gl.accepted_qty - COALESCE((SELECT SUM(pi.issued_qty_kg) FROM trx_process_issue pi WHERE pi.grn_line_id = gl.id), 0) AS eligible_kg
       FROM trx_yarn_process_return_line rl LEFT JOIN trx_sales_order so ON so.id = rl.so_id LEFT JOIN trx_grn_line gl ON gl.id = rl.return_grn_line_id
      WHERE rl.return_id = ? ORDER BY rl.id`, [id]);
  res.json({ data: { ...r, lines: lines.map((l) => ({ ...l, eligible_kg: r3(n(l.eligible_kg)) })) } });
}));

/** POST /yarn-process/returns — processed yarn back to the return / rework store (eligible for reprocess). */
yarnEngineAfterRouter.post('/yarn-process/returns', requirePermission(YP.RETURN), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = returnSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const inw = body.inward_id ? await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_inward WHERE id = ? AND company_id = ?', [body.inward_id, cid]) : null;
    if (body.inward_id && !inw) throw BadRequest('Original GRN not found');
    if (inw && inw.status !== 'POSTED') throw BadRequest(`GRN ${inw.inward_no} is not posted yet`);
    const no = await nextDocNumber(tx, cid, 'YP_RETURN');
    const r = await txExecute(tx,
      `INSERT INTO trx_yarn_process_return (company_id, return_no, return_date, inward_id, ypo_id, vendor_id, process_code, return_type, reason_id, warehouse_id, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, body.return_date, inw?.id ?? null, inw?.ypo_id ?? null, inw?.vendor_id ?? null, inw?.process_code ?? null, body.return_type, body.reason_id, body.warehouse_id, body.remarks ?? null, req.user!.id]);
    const returnId = Number(r.insertId);
    const grnId = await lotGrn(tx, req, { no, date: body.return_date, warehouseId: body.warehouse_id, supplierId: inw?.vendor_id ?? null, remarks: `Yarn process return ${no}`, rejected: true });
    const toStore = await whName(tx, body.warehouse_id);
    const seen = new Set<number>();
    let total = 0;
    for (const l of body.lines) {
      if (seen.has(l.source_grn_line_id)) throw BadRequest('The same lot is returned twice');
      seen.add(l.source_grn_line_id);
      const lot = await lotRow(tx, cid, l.source_grn_line_id, true);
      if (!lot.source_ypo_id) throw BadRequest(`Lot ${lot.lot_no} is not a processed yarn lot`);
      if (inw && Number(lot.grn_id) !== Number(inw.grn_id)) throw BadRequest(`Lot ${lot.lot_no} is not from GRN ${inw.inward_no}`);
      if (l.qty_kg > lot.balance_kg + EPS) throw BadRequest(`Lot ${lot.lot_no} has only ${lot.balance_kg} KG left`);
      await lotOut(tx, req, { lot, qty: l.qty_kg, srcType: 'YARN_LOT_MOVE', srcId: returnId, date: body.return_date, soId: lot.so_id, ioNo: lot.job_no, refType: 'YARN_PROC_RETURN', remarks: `Return ${no}` });
      const rl = await lotIn(tx, { grnId, soId: lot.so_id, styleId: lot.style_id, yarnId: lot.yarn_id, yarnType: lot.yarn_type, shade: lot.color_name, lotNo: `${lot.lot_no}-R`,
        coneNo: lot.cone_no, qty: l.qty_kg, rejected: true, parentId: lot.id, ypoId: lot.source_ypo_id });
      await txExecute(tx, 'INSERT INTO trx_yarn_process_return_line (return_id, source_grn_line_id, return_grn_line_id, so_id, lot_no, cone_no, qty_kg, defect_reason) VALUES (?,?,?,?,?,?,?,?)',
        [returnId, lot.id, rl, lot.so_id ?? null, lot.lot_no, lot.cone_no ?? null, r3(l.qty_kg), l.defect_reason ?? null]);
      await coneHistory(tx, req, { grn_line_id: lot.id, lot_no: lot.lot_no, cone_no: lot.cone_no, event: 'RETURN', ref_type: 'YPR', ref_id: returnId, ref_no: no, process_code: inw?.process_code ?? null,
        from: lot.warehouse_name, to: toStore, qty: l.qty_kg, so_id: lot.so_id, related_grn_line_id: rl, remarks: l.defect_reason });
      await coneHistory(tx, req, { grn_line_id: rl, lot_no: `${lot.lot_no}-R`, cone_no: lot.cone_no, event: 'RETURN', ref_type: 'YPR', ref_id: returnId, ref_no: no, process_code: inw?.process_code ?? null,
        to: toStore, qty: l.qty_kg, so_id: lot.so_id, related_grn_line_id: lot.id, remarks: l.defect_reason });
      total += l.qty_kg;
    }
    await txExecute(tx, 'UPDATE trx_yarn_process_return SET total_kg = ?, grn_id = ? WHERE id = ?', [r3(total), grnId, returnId]);
    return { id: returnId, return_no: no, total_kg: r3(total) };
  });
  await audit(req, 'trx_yarn_process_return', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.return_no} confirmed — ${out.total_kg} KG to the return store` });
}));

/** POST /yarn-process/returns/:id/close — the KG not reprocessed is rejected / written off (Return → Closed). */
yarnEngineAfterRouter.post('/yarn-process/returns/:id/close', requirePermission(YP.CONFIRM), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const reason = z.string().trim().min(3, 'Give the reason').max(255).parse(req.body?.reason);
  const out = await transaction(async (tx) => {
    const r = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_return WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!r) throw NotFound('Return not found');
    if (r.status === 'CLOSED') throw BadRequest(`${r.return_no} is already closed`);
    let off = 0;
    for (const l of await txQuery<any>(tx, 'SELECT * FROM trx_yarn_process_return_line WHERE return_id = ?', [id])) {
      const lot = await lotRow(tx, cid, Number(l.return_grn_line_id), true);
      if (lot.balance_kg <= EPS) continue;
      await lotOut(tx, req, { lot, qty: lot.balance_kg, srcType: 'YARN_LOT_MOVE', srcId: id, date: new Date().toISOString().slice(0, 10), soId: lot.so_id, refType: 'YARN_RETURN_WRITE_OFF', remarks: `Rejected: ${reason}` });
      await coneHistory(tx, req, { grn_line_id: lot.id, lot_no: lot.lot_no, cone_no: lot.cone_no, event: 'REJECTED_WRITE_OFF', ref_type: 'YPR', ref_id: id, ref_no: r.return_no, qty: lot.balance_kg, so_id: lot.so_id, remarks: reason });
      off += lot.balance_kg;
    }
    await txExecute(tx, `UPDATE trx_yarn_process_return SET status = 'CLOSED', rejected_kg = ?, remarks = CONCAT(COALESCE(remarks, ''), ?) WHERE id = ?`, [r3(off), `\nClosed: ${reason}`, id]);
    return { return_no: r.return_no, rejected_kg: r3(off) };
  });
  await audit(req, 'trx_yarn_process_return', id, 'UPDATE', undefined, { close: out, reason });
  res.json({ data: out, message: `${out.return_no} closed${out.rejected_kg ? ` — ${out.rejected_kg} KG rejected / written off` : ''}` });
}));

// =====================================================================================
// Reprocess (doc §13) — billing type + cost treatment
// =====================================================================================
const billingSchema = z.object({
  billing_type: z.enum(['BILLABLE', 'NON_BILLABLE']),
  cost_treatment: z.enum(['CONTRACTOR', 'INTERNAL', 'FREE', 'RECOVERY']).default('CONTRACTOR'),
  billing_reason_id: s.id(),
  rate_per_kg: z.coerce.number().min(0).default(0),
  bill_amount: z.coerce.number().min(0).nullish(),
  internal_cost: z.coerce.number().min(0).default(0),
  billing_remarks: s.text(),
});
const reprocessSchema = billingSchema.extend({
  reprocess_date: date,
  source_type: z.enum(['RETURN', 'REJECT']).default('RETURN'),
  return_id: s.id(),
  process_code: z.string().trim().min(2).max(40),
  vendor_id: s.idReq(),
  target_shade: s.nullableStr(80),
  reason_id: s.idReq(),
  remarks: s.text(),
  lines: z.array(z.object({ source_grn_line_id: s.idReq(), qty_kg: z.coerce.number().positive() })).min(1, 'Pick the cones / lots to reprocess'),
});

/**
 * Billing rules (doc §13): Billable → contractor bill (cost treatment Contractor); Non-billable →
 * Internal / Free (no bill, cost kept) or Recovery (debited from the contractor).
 */
function billingFields(b: z.infer<typeof billingSchema>, qty: number) {
  const amount = r2(b.bill_amount != null && b.bill_amount > 0 ? b.bill_amount : b.rate_per_kg * qty);
  if (b.billing_type === 'BILLABLE') {
    if (b.cost_treatment !== 'CONTRACTOR') throw BadRequest('Billable reprocess is charged by the contractor — cost treatment must be Contractor');
    if (!(amount > 0)) throw BadRequest('Billable reprocess needs a rate per KG or an approved amount');
    return { cost_treatment: 'CONTRACTOR', rate_per_kg: b.rate_per_kg, bill_amount: amount, billing_status: 'PENDING' };
  }
  if (b.cost_treatment === 'CONTRACTOR') throw BadRequest('Non-billable reprocess: choose Internal, Free or Recovery as the cost treatment');
  if (b.cost_treatment === 'RECOVERY') {
    if (!(amount > 0)) throw BadRequest('Recovery from the contractor needs the amount to recover');
    return { cost_treatment: 'RECOVERY', rate_per_kg: b.rate_per_kg, bill_amount: amount, billing_status: 'PENDING' };
  }
  return { cost_treatment: b.cost_treatment, rate_per_kg: 0, bill_amount: 0, billing_status: 'EXCLUDED' };
}
const onBill = (rp: { billing_type: string; cost_treatment: string }) => rp.billing_type === 'BILLABLE' || rp.cost_treatment === 'RECOVERY';

const RP_SELECT = `SELECT rp.*, v.party_name AS vendor_name, pt.name AS process_name, rs.reason, br.reason AS billing_reason, rt.return_no, o.ypo_no, o.status AS dc_status, b.bill_no,
                          (SELECT GROUP_CONCAT(DISTINCT COALESCE(so.io_no, so.so_no) SEPARATOR ', ') FROM trx_yarn_reprocess_line l LEFT JOIN trx_sales_order so ON so.id = l.so_id WHERE l.reprocess_id = rp.id) AS jobs
                     FROM trx_yarn_reprocess rp LEFT JOIN mst_party v ON v.id = rp.vendor_id
                     LEFT JOIN mst_yarn_process_type pt ON pt.company_id = rp.company_id AND pt.code = rp.process_code
                     LEFT JOIN mst_fabric_process_reason rs ON rs.id = rp.reason_id LEFT JOIN mst_fabric_process_reason br ON br.id = rp.billing_reason_id
                     LEFT JOIN trx_yarn_process_return rt ON rt.id = rp.return_id LEFT JOIN trx_yarn_process_order o ON o.id = rp.ypo_id
                     LEFT JOIN trx_yarn_process_bill b ON b.id = rp.contractor_bill_id`;
yarnEngineAfterRouter.get('/yarn-process/reprocess', requirePermission(YP.VIEW), ah(async (req, res) => {
  res.json({ data: await query<any>(`${RP_SELECT} WHERE rp.company_id = ? ORDER BY rp.id DESC LIMIT 1000`, [req.user!.companyId]) });
}));
yarnEngineAfterRouter.get('/yarn-process/reprocess/:id', requirePermission(YP.VIEW), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const rp = await queryOne<any>(`${RP_SELECT} WHERE rp.id = ? AND rp.company_id = ?`, [id, req.user!.companyId]);
  if (!rp) throw NotFound('Reprocess not found');
  const lines = await query<any>(`SELECT l.*, COALESCE(so.io_no, so.so_no) AS io_no, gl.color_name AS shade, y.yarn_name FROM trx_yarn_reprocess_line l
                                    LEFT JOIN trx_sales_order so ON so.id = l.so_id LEFT JOIN trx_grn_line gl ON gl.id = l.source_grn_line_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id
                                   WHERE l.reprocess_id = ? ORDER BY l.id`, [id]);
  res.json({ data: { ...rp, lines } });
}));

/** Confirms an approved reprocess: its reprocess DC issues the reject / returned lots to the unit. */
async function confirmReprocess(tx: Tx, req: Request, rp: any) {
  if (rp.status !== 'APPROVED') throw BadRequest(`${rp.reprocess_no} is ${rp.status} — the reprocess must be approved before its DC is issued`);
  const lines = await txQuery<any>(tx, 'SELECT * FROM trx_yarn_reprocess_line WHERE reprocess_id = ? ORDER BY id', [rp.id]);
  const h = await insertOutwardHeader(tx, req, { ypo_date: String(rp.reprocess_date).slice(0, 10), process_code: rp.process_code, vendor_id: Number(rp.vendor_id),
    target_shade: rp.target_shade ?? null, remarks: `Reprocess ${rp.reprocess_no}`, from_warehouse_id: null, to_location: null, vehicle_no: null, challan_no: null, expected_return_date: null },
    { status: 'CONFIRMED', is_reprocess: true, reprocess_id: rp.id });
  await writeOutwardLines(tx, req, h, lines.map((l) => ({ so_id: l.so_id ? Number(l.so_id) : null, process_id: null, grn_line_id: Number(l.source_grn_line_id), qty_kg: n(l.qty_kg),
    cone_no: l.cone_no, no_of_cones: 0, target_shade: rp.target_shade ?? null })), true, { allowRejected: true });
  for (const l of lines) if (l.return_line_id) await txExecute(tx, 'UPDATE trx_yarn_process_return_line SET reprocessed_kg = reprocessed_kg + ? WHERE id = ?', [l.qty_kg, l.return_line_id]);
  if (rp.return_id) {
    const t = await txQueryOne<any>(tx, 'SELECT SUM(qty_kg) q, SUM(reprocessed_kg) d FROM trx_yarn_process_return_line WHERE return_id = ?', [rp.return_id]);
    await txExecute(tx, 'UPDATE trx_yarn_process_return SET reprocessed_kg = ?, status = ? WHERE id = ?', [r3(n(t?.d)), n(t?.d) + EPS >= n(t?.q) ? 'SENT_TO_REPROCESS' : 'CONFIRMED', rp.return_id]);
  }
  await txExecute(tx, `UPDATE trx_yarn_reprocess SET status = 'IN_PROCESS', ypo_id = ?, confirmed_by = ?, confirmed_at = NOW() WHERE id = ?`, [h.id, req.user!.id, rp.id]);
  return h;
}

yarnEngineAfterRouter.post('/yarn-process/reprocess', requirePermission(YP.REPROCESS), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = reprocessSchema.parse(req.body);
  const confirm = Boolean(req.body?.confirm);
  if (confirm && !can(req, YP.CONFIRM)) throw Forbidden('You can save the reprocess as draft; issuing its DC needs the confirm right');
  const out = await transaction(async (tx) => {
    const pt = await processType(cid, body.process_code, tx);
    if (!pt.is_reprocess && !pt.allow_reprocess) throw BadRequest(`${pt.name} cannot be used for reprocess`);
    const ret = body.return_id ? await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_return WHERE id = ? AND company_id = ?', [body.return_id, cid]) : null;
    if (body.source_type === 'RETURN' && !ret) throw BadRequest('Choose the return to reprocess');
    if (ret?.status === 'CLOSED') throw BadRequest(`${ret.return_no} is closed`);
    let total = 0;
    const rows: any[] = [];
    for (const l of body.lines) {
      const lot = await lotRow(tx, cid, l.source_grn_line_id);
      if (lot.qc_status !== 'REJECTED' || !lot.source_ypo_id) throw BadRequest(`Lot ${lot.lot_no} is not a reject / returned yarn lot`);
      if (l.qty_kg > lot.balance_kg + EPS) throw BadRequest(`Lot ${lot.lot_no}: reprocess ${l.qty_kg} KG is more than the eligible ${lot.balance_kg} KG`);
      let rl: any = null;
      if (body.source_type === 'RETURN') {
        rl = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_return_line WHERE return_id = ? AND return_grn_line_id = ?', [ret.id, lot.id]);
        if (!rl) throw BadRequest(`Lot ${lot.lot_no} is not on return ${ret.return_no}`);
        if (l.qty_kg > n(rl.qty_kg) - n(rl.reprocessed_kg) + EPS) throw BadRequest(`Lot ${lot.lot_no}: only ${r3(n(rl.qty_kg) - n(rl.reprocessed_kg))} KG of the return is left to reprocess`);
      }
      rows.push({ ...l, lot, rl });
      total += l.qty_kg;
    }
    const bf = billingFields(body, total);
    // a Process Manager / Admin decides the billing; other users only request it (doc §25)
    const approver = can(req, YP.BILLING_APPROVE);
    const billingStatus = approver ? (bf.billing_status === 'PENDING' ? 'APPROVED' : bf.billing_status) : 'PENDING';
    const no = await nextDocNumber(tx, cid, 'YP_REPROCESS');
    const r = await txExecute(tx,
      `INSERT INTO trx_yarn_reprocess (company_id, reprocess_no, reprocess_date, source_type, return_id, original_inward_id, process_code, vendor_id, target_shade, reason_id, total_kg,
         billing_type, cost_treatment, billing_reason_id, rate_per_kg, bill_amount, internal_cost, billing_status, billing_approved_by, billing_approved_at, billing_remarks, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, body.reprocess_date, body.source_type, ret?.id ?? null, ret?.inward_id ?? null, pt.code, body.vendor_id, body.target_shade ?? null, body.reason_id, r3(total),
       body.billing_type, bf.cost_treatment, body.billing_reason_id ?? null, bf.rate_per_kg, bf.bill_amount, r2(body.internal_cost), billingStatus,
       approver ? req.user!.id : null, approver ? new Date() : null, body.billing_remarks ?? null, approver ? 'APPROVED' : 'DRAFT', body.remarks ?? null, req.user!.id]);
    const id = Number(r.insertId);
    for (const l of rows) {
      await txExecute(tx, 'INSERT INTO trx_yarn_reprocess_line (reprocess_id, source_grn_line_id, return_line_id, so_id, lot_no, cone_no, qty_kg) VALUES (?,?,?,?,?,?,?)',
        [id, l.lot.id, l.rl?.id ?? null, l.lot.so_id ?? null, l.lot.lot_no, l.lot.cone_no ?? null, r3(l.qty_kg)]);
    }
    let dc: any = null;
    if (confirm) dc = await confirmReprocess(tx, req, { id, reprocess_no: no, reprocess_date: body.reprocess_date, process_code: pt.code, vendor_id: body.vendor_id,
      target_shade: body.target_shade, return_id: ret?.id ?? null, status: approver ? 'APPROVED' : 'DRAFT' });
    return { id, reprocess_no: no, total_kg: r3(total), billing_type: body.billing_type, cost_treatment: bf.cost_treatment, bill_amount: bf.bill_amount, billing_status: billingStatus,
      status: dc ? 'IN_PROCESS' : approver ? 'APPROVED' : 'DRAFT', ypo_no: dc?.ypo_no ?? null, ypo_id: dc?.id ?? null };
  });
  await audit(req, 'trx_yarn_reprocess', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.reprocess_no} ${out.ypo_no ? `confirmed — reprocess DC ${out.ypo_no} issued` : out.status === 'APPROVED' ? 'approved' : 'saved — waiting for approval'}` });
}));

yarnEngineAfterRouter.post('/yarn-process/reprocess/:id/confirm', requirePermission(YP.CONFIRM), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const out = await transaction(async (tx) => {
    const rp = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_reprocess WHERE id = ? AND company_id = ? FOR UPDATE', [id, req.user!.companyId]);
    if (!rp) throw NotFound('Reprocess not found');
    const dc = await confirmReprocess(tx, req, rp);
    return { reprocess_no: rp.reprocess_no, ypo_no: dc.ypo_no, ypo_id: dc.id };
  });
  await audit(req, 'trx_yarn_reprocess', id, 'UPDATE', undefined, { confirm: out });
  res.json({ data: out, message: `${out.reprocess_no} — reprocess DC ${out.ypo_no} issued` });
}));

/** Approve: billing Pending → Approved (billable / recovery) or Excluded (internal / free); reprocess Draft → Approved. */
yarnEngineAfterRouter.post('/yarn-process/reprocess/:id/approve', requirePermission(YP.BILLING_APPROVE), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const rp = await queryOne<any>('SELECT * FROM trx_yarn_reprocess WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!rp) throw NotFound('Reprocess not found');
  if (rp.status !== 'DRAFT' && rp.billing_status !== 'PENDING') throw BadRequest(`${rp.reprocess_no} is already approved`);
  const to = rp.billing_status === 'PENDING' ? (onBill(rp) ? 'APPROVED' : 'EXCLUDED') : rp.billing_status;
  await query(`UPDATE trx_yarn_reprocess SET billing_status = ?, status = IF(status = 'DRAFT', 'APPROVED', status), billing_approved_by = ?, billing_approved_at = NOW() WHERE id = ?`, [to, req.user!.id, id]);
  await audit(req, 'trx_yarn_reprocess', id, 'UPDATE', { billing_status: rp.billing_status, status: rp.status }, { billing_status: to });
  res.json({ message: `${rp.reprocess_no} approved — billing ${to.toLowerCase()}` });
}));

/** Change billing type / cost treatment (doc §13 / §25): reason + approver kept; blocked once billed. */
yarnEngineAfterRouter.post('/yarn-process/reprocess/:id/billing', requirePermission(YP.BILLING_CHANGE), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = billingSchema.extend({ change_reason: z.string().trim().min(3, 'Reason for the change is mandatory').max(255) }).parse(req.body);
  const rp = await queryOne<any>('SELECT * FROM trx_yarn_reprocess WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!rp) throw NotFound('Reprocess not found');
  if (rp.contractor_bill_id) throw BadRequest('This reprocess is on a contractor bill — cancel / reverse the bill before changing the billing');
  if (rp.status === 'CANCELLED') throw BadRequest(`${rp.reprocess_no} is cancelled`);
  const bf = billingFields(b, n(rp.total_kg));
  const status = bf.billing_status === 'PENDING' ? 'APPROVED' : bf.billing_status;
  await query(
    `UPDATE trx_yarn_reprocess SET billing_type = ?, cost_treatment = ?, billing_reason_id = ?, rate_per_kg = ?, bill_amount = ?, internal_cost = ?, billing_status = ?,
            billing_approved_by = ?, billing_approved_at = NOW(), status = IF(status = 'DRAFT', 'APPROVED', status), billing_remarks = CONCAT(COALESCE(billing_remarks, ''), ?) WHERE id = ?`,
    [b.billing_type, bf.cost_treatment, b.billing_reason_id ?? null, bf.rate_per_kg, bf.bill_amount, r2(b.internal_cost), status, req.user!.id,
     `\n[${new Date().toISOString().slice(0, 16)}] ${rp.billing_type}/${rp.cost_treatment} → ${b.billing_type}/${bf.cost_treatment}: ${b.change_reason}`, id]);
  await audit(req, 'trx_yarn_reprocess', id, 'UPDATE', { billing_type: rp.billing_type, cost_treatment: rp.cost_treatment, bill_amount: rp.bill_amount, billing_status: rp.billing_status },
    { billing_type: b.billing_type, cost_treatment: bf.cost_treatment, bill_amount: bf.bill_amount, billing_status: status, reason: b.change_reason });
  res.json({ message: `${rp.reprocess_no}: billing ${rp.billing_type}/${rp.cost_treatment} → ${b.billing_type}/${bf.cost_treatment}` });
}));

yarnEngineAfterRouter.post('/yarn-process/reprocess/:id/cancel', requirePermission(YP.REPROCESS), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const rp = await queryOne<any>('SELECT * FROM trx_yarn_reprocess WHERE id = ? AND company_id = ?', [id, req.user!.companyId]);
  if (!rp) throw NotFound('Reprocess not found');
  if (!['DRAFT', 'APPROVED'].includes(rp.status)) throw BadRequest(`${rp.reprocess_no} is ${rp.status} — cancel its DC first`);
  await query(`UPDATE trx_yarn_reprocess SET status = 'CANCELLED' WHERE id = ?`, [id]);
  await audit(req, 'trx_yarn_reprocess', id, 'UPDATE', { status: rp.status }, { status: 'CANCELLED' });
  res.json({ message: `${rp.reprocess_no} cancelled` });
}));

// =====================================================================================
// Contractor bill (doc §14)
// =====================================================================================
yarnEngineAfterRouter.get('/yarn-process/bill-sources', requirePermission(YP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ vendor_id: z.coerce.number().int().positive(), from: date.optional(), to: date.optional(), process_code: z.string().optional(),
    io_no: z.string().optional(), billing_type: z.string().optional() }).parse(req.query);
  const f = (dcol: string, pcol: string) => {
    const w: string[] = []; const p: unknown[] = [];
    if (q.from) { w.push(`${dcol} >= ?`); p.push(q.from); }
    if (q.to) { w.push(`${dcol} <= ?`); p.push(q.to); }
    if (q.process_code) { w.push(`${pcol} = ?`); p.push(q.process_code); }
    return { w: w.length ? ` AND ${w.join(' AND ')}` : '', p };
  };
  const a = f('i.inward_date', 'i.process_code'), b = f('rp.reprocess_date', 'rp.process_code');
  let grns = await query<any>(
    `SELECT i.id AS ref_id, 'GRN' AS line_type, i.inward_no AS doc_no, i.inward_date AS doc_date, i.process_code, pt.name AS process_name, i.good_kg AS qty_kg,
            (SELECT GROUP_CONCAT(DISTINCT x.io_no SEPARATOR ', ') FROM trx_yarn_process_inward_out x WHERE x.inward_id = i.id) AS io_no,
            (SELECT bl.rate FROM trx_yarn_process_bill_line bl JOIN trx_yarn_process_bill bb ON bb.id = bl.bill_id
              WHERE bb.vendor_id = i.vendor_id AND bl.process_code = i.process_code AND bl.line_type = 'GRN' AND bb.status = 'POSTED' ORDER BY bl.id DESC LIMIT 1) AS last_rate
       FROM trx_yarn_process_inward i LEFT JOIN mst_yarn_process_type pt ON pt.company_id = i.company_id AND pt.code = i.process_code
      WHERE i.company_id = ? AND i.vendor_id = ? AND i.bill_id IS NULL AND i.is_reprocess = 0 AND i.status = 'POSTED' AND COALESCE(pt.billable, 1) = 1${a.w}
      ORDER BY i.inward_date, i.id`, [cid, q.vendor_id, ...a.p]);
  let reps = await query<any>(
    `SELECT rp.id AS ref_id, IF(rp.cost_treatment = 'RECOVERY', 'RECOVERY', 'REPROCESS') AS line_type, rp.reprocess_no AS doc_no, rp.reprocess_date AS doc_date, rp.process_code,
            pt.name AS process_name, rp.total_kg AS qty_kg, rp.rate_per_kg AS rate, rp.bill_amount, rp.billing_type, rp.cost_treatment, rp.billing_status,
            (SELECT GROUP_CONCAT(DISTINCT COALESCE(so.io_no, so.so_no) SEPARATOR ', ') FROM trx_yarn_reprocess_line l LEFT JOIN trx_sales_order so ON so.id = l.so_id WHERE l.reprocess_id = rp.id) AS io_no
       FROM trx_yarn_reprocess rp LEFT JOIN mst_yarn_process_type pt ON pt.company_id = rp.company_id AND pt.code = rp.process_code
      WHERE rp.company_id = ? AND rp.vendor_id = ? AND rp.contractor_bill_id IS NULL AND rp.status <> 'CANCELLED'
        AND (rp.billing_type = 'BILLABLE' OR rp.cost_treatment = 'RECOVERY') AND rp.billing_status IN ('APPROVED', 'REVERSED')${b.w}
      ORDER BY rp.reprocess_date, rp.id`, [cid, q.vendor_id, ...b.p]);
  if (q.io_no) { grns = grns.filter((g) => String(g.io_no ?? '').includes(q.io_no!)); reps = reps.filter((g) => String(g.io_no ?? '').includes(q.io_no!)); }
  if (q.billing_type === 'BILLABLE') reps = reps.filter((r) => r.billing_type === 'BILLABLE');
  if (q.billing_type === 'RECOVERY') { reps = reps.filter((r) => r.cost_treatment === 'RECOVERY'); grns = []; }
  const excluded = await query<any>(
    `SELECT rp.reprocess_no AS doc_no, rp.total_kg AS qty_kg, rp.billing_type, rp.cost_treatment FROM trx_yarn_reprocess rp
      WHERE rp.company_id = ? AND rp.vendor_id = ? AND rp.billing_type = 'NON_BILLABLE' AND rp.cost_treatment <> 'RECOVERY' AND rp.status <> 'CANCELLED'${b.w}`, [cid, q.vendor_id, ...b.p]);
  const pending = await query<any>(
    `SELECT rp.reprocess_no AS doc_no, rp.bill_amount FROM trx_yarn_reprocess rp WHERE rp.company_id = ? AND rp.vendor_id = ? AND rp.billing_status = 'PENDING' AND rp.status <> 'CANCELLED'`, [cid, q.vendor_id]);
  res.json({ data: { grns, reprocess: reps, excluded, pending_approval: pending } });
}));

const billSchema = z.object({
  vendor_id: s.idReq(), bill_date: date, party_bill_no: s.nullableStr(60), from_date: date.nullish(), to_date: date.nullish(),
  discount_amount: z.coerce.number().min(0).default(0), other_charges: z.coerce.number().default(0), gst_pct: z.coerce.number().min(0).max(28).default(0), remarks: s.text(),
  lines: z.array(z.object({ line_type: z.enum(['GRN', 'REPROCESS', 'RECOVERY']), ref_id: s.idReq(), rate: z.coerce.number().min(0).default(0) })).min(1, 'Add at least one GRN / reprocess'),
});
yarnEngineAfterRouter.get('/yarn-process/bills', requirePermission(YP.VIEW), ah(async (req, res) => {
  res.json({ data: await query<any>(`SELECT b.*, v.party_name AS vendor_name, (SELECT COUNT(*) FROM trx_yarn_process_bill_line l WHERE l.bill_id = b.id) AS line_count
                                        FROM trx_yarn_process_bill b LEFT JOIN mst_party v ON v.id = b.vendor_id WHERE b.company_id = ? ORDER BY b.id DESC LIMIT 500`, [req.user!.companyId]) });
}));
yarnEngineAfterRouter.get('/yarn-process/bills/:id', requirePermission(YP.VIEW), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = await queryOne<any>('SELECT b.*, v.party_name AS vendor_name FROM trx_yarn_process_bill b LEFT JOIN mst_party v ON v.id = b.vendor_id WHERE b.id = ? AND b.company_id = ?', [id, req.user!.companyId]);
  if (!b) throw NotFound('Bill not found');
  res.json({ data: { ...b, lines: await query<any>('SELECT * FROM trx_yarn_process_bill_line WHERE bill_id = ? ORDER BY id', [id]) } });
}));
yarnEngineAfterRouter.post('/yarn-process/bills', requirePermission(YP.BILL), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = billSchema.parse(req.body);
  const out = await transaction(async (tx) => {
    const no = await nextDocNumber(tx, cid, 'YP_BILL');
    const r = await txExecute(tx,
      `INSERT INTO trx_yarn_process_bill (company_id, bill_no, bill_date, vendor_id, party_bill_no, from_date, to_date, discount_amount, other_charges, gst_pct, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, no, body.bill_date, body.vendor_id, body.party_bill_no ?? null, body.from_date ?? null, body.to_date ?? null, r2(body.discount_amount), r2(body.other_charges), body.gst_pct, body.remarks ?? null, req.user!.id]);
    const billId = Number(r.insertId);
    let gross = 0, recovery = 0;
    for (const l of body.lines) {
      if (l.line_type === 'GRN') {
        const i = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_inward WHERE id = ? AND company_id = ? FOR UPDATE', [l.ref_id, cid]);
        if (!i || Number(i.vendor_id) !== body.vendor_id) throw BadRequest('A GRN is not of this contractor');
        if (i.bill_id) throw BadRequest(`${i.inward_no} is already billed`);
        if (i.status !== 'POSTED') throw BadRequest(`${i.inward_no} is not posted yet`);
        if (i.is_reprocess) throw BadRequest(`${i.inward_no} is a reprocess GRN — its charge comes from the reprocess billing`);
        if (!(l.rate > 0)) throw BadRequest(`${i.inward_no}: enter the rate per KG`);
        const amt = r2(n(i.good_kg) * l.rate);
        const j = await txQueryOne<any>(tx, `SELECT GROUP_CONCAT(DISTINCT io_no SEPARATOR ', ') j FROM trx_yarn_process_inward_out WHERE inward_id = ?`, [i.id]);
        await txExecute(tx, 'INSERT INTO trx_yarn_process_bill_line (bill_id, line_type, ref_id, doc_no, doc_date, io_no, process_code, qty_kg, rate, amount) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [billId, 'GRN', i.id, i.inward_no, i.inward_date, j?.j ?? null, i.process_code, n(i.good_kg), l.rate, amt]);
        await txExecute(tx, 'UPDATE trx_yarn_process_inward SET bill_id = ? WHERE id = ?', [billId, i.id]);
        gross += amt;
      } else {
        const rp = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_reprocess WHERE id = ? AND company_id = ? FOR UPDATE', [l.ref_id, cid]);
        if (!rp || Number(rp.vendor_id) !== body.vendor_id) throw BadRequest('A reprocess is not of this contractor');
        if (rp.contractor_bill_id) throw BadRequest(`${rp.reprocess_no} is already billed`);
        // non-billable (internal / free) reprocess never flows into a contractor bill
        if (!onBill(rp)) throw BadRequest(`${rp.reprocess_no} is non-billable (${rp.cost_treatment.toLowerCase()}) — excluded from contractor bills`);
        if (!['APPROVED', 'REVERSED'].includes(rp.billing_status)) throw BadRequest(`${rp.reprocess_no}: billing is not approved yet`);
        const isRec = rp.cost_treatment === 'RECOVERY';
        const amt = r2(n(rp.bill_amount)) * (isRec ? -1 : 1);
        await txExecute(tx, 'INSERT INTO trx_yarn_process_bill_line (bill_id, line_type, ref_id, doc_no, doc_date, process_code, qty_kg, rate, amount) VALUES (?,?,?,?,?,?,?,?,?)',
          [billId, isRec ? 'RECOVERY' : 'REPROCESS', rp.id, rp.reprocess_no, rp.reprocess_date, rp.process_code, n(rp.total_kg), n(rp.rate_per_kg), amt]);
        await txExecute(tx, `UPDATE trx_yarn_reprocess SET contractor_bill_id = ?, billing_status = 'BILLED' WHERE id = ?`, [billId, rp.id]);
        if (isRec) recovery += -amt; else gross += amt;
      }
    }
    const taxable = r2(gross - recovery - body.discount_amount + body.other_charges);
    const gst = r2(taxable * body.gst_pct / 100);
    const net = r2(taxable + gst);
    await txExecute(tx, 'UPDATE trx_yarn_process_bill SET gross_amount = ?, recovery_amount = ?, gst_amount = ?, net_amount = ? WHERE id = ?', [r2(gross), r2(recovery), gst, net, billId]);
    return { id: billId, bill_no: no, gross_amount: r2(gross), recovery_amount: r2(recovery), gst_amount: gst, net_amount: net };
  });
  await audit(req, 'trx_yarn_process_bill', out.id, 'INSERT', undefined, out);
  res.status(201).json({ data: out, message: `${out.bill_no} posted — net ₹${out.net_amount}` });
}));
yarnEngineAfterRouter.post('/yarn-process/bills/:id/cancel', requirePermission(YP.BILL_CANCEL), ah(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const reason = z.string().trim().min(3, 'Reason is mandatory').max(255).parse(req.body?.reason);
  const b = await transaction(async (tx) => {
    const b = await txQueryOne<any>(tx, 'SELECT * FROM trx_yarn_process_bill WHERE id = ? AND company_id = ? FOR UPDATE', [id, req.user!.companyId]);
    if (!b) throw NotFound('Bill not found');
    if (b.status === 'CANCELLED') throw BadRequest(`${b.bill_no} is already cancelled`);
    await txExecute(tx, 'UPDATE trx_yarn_process_inward SET bill_id = NULL WHERE bill_id = ?', [id]);
    await txExecute(tx, `UPDATE trx_yarn_reprocess SET contractor_bill_id = NULL, billing_status = 'REVERSED' WHERE contractor_bill_id = ?`, [id]);
    await txExecute(tx, `UPDATE trx_yarn_process_bill SET status = 'CANCELLED', remarks = CONCAT(COALESCE(remarks, ''), ?) WHERE id = ?`, [`\nCancelled: ${reason}`, id]);
    return b;
  });
  await audit(req, 'trx_yarn_process_bill', id, 'UPDATE', { status: b.status }, { status: 'CANCELLED', reason });
  res.json({ message: `${b.bill_no} cancelled — its GRNs / reprocess can be billed again (reprocess billing Reversed)` });
}));

// =====================================================================================
// Cone tracking (doc §15)
// =====================================================================================
yarnEngineAfterRouter.get('/yarn-process/cone-history', requirePermission(YP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({ q: z.string().trim().min(1).max(80).optional(), grn_line_id: z.coerce.number().int().positive().optional() }).parse(req.query);
  const start = q.grn_line_id
    ? [{ id: q.grn_line_id }]
    : await query<any>(`SELECT gl.id FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id
                         WHERE g.company_id = ? AND gl.material_type = 'YARN' AND (gl.lot_no = ? OR gl.cone_no = ?) ORDER BY gl.id DESC LIMIT 20`, [cid, q.q, q.q]);
  if (!start.length) throw NotFound(`No yarn lot / cone "${q.q}"`);
  // lineage: up through parent lots / mapped input lots, down through child lots
  const ids = new Set<number>(start.map((x) => Number(x.id)));
  let up = [...ids];
  for (let d = 0; d < 15 && up.length; d++) {
    const par = await query<any>(
      `SELECT gl.parent_grn_line_id AS p FROM trx_grn_line gl WHERE gl.id IN (?) AND gl.parent_grn_line_id IS NOT NULL
       UNION SELECT l.grn_line_id FROM trx_yarn_process_inward_out x JOIN trx_yarn_process_inward_in ii ON ii.out_id = x.id
              JOIN trx_yarn_process_order_line l ON l.id = ii.ypo_line_id WHERE x.grn_line_id IN (?) OR x.reject_grn_line_id IN (?)`, [up, up, up]);
    up = par.map((x) => Number(x.p)).filter((x) => x && !ids.has(x));
    up.forEach((x) => ids.add(x));
  }
  let down = [...ids];
  for (let d = 0; d < 15 && down.length; d++) {
    const kids = await query<any>(
      `SELECT gl.id FROM trx_grn_line gl WHERE gl.parent_grn_line_id IN (?)
       UNION SELECT COALESCE(x.grn_line_id, x.reject_grn_line_id) FROM trx_yarn_process_order_line l JOIN trx_yarn_process_inward_in ii ON ii.ypo_line_id = l.id
              JOIN trx_yarn_process_inward_out x ON x.id = ii.out_id WHERE l.grn_line_id IN (?)`, [down, down]);
    down = kids.map((x) => Number(x.id)).filter((x) => x && !ids.has(x));
    down.forEach((x) => ids.add(x));
  }
  const all = [...ids];
  const lots = await query<any>(
    `SELECT gl.id AS grn_line_id, gl.lot_no, gl.cone_no, gl.qc_status, gl.color_name AS shade, gl.yarn_type, gl.accepted_qty, gl.parent_grn_line_id, gl.source_ypo_id, y.yarn_name,
            g.grn_no, g.grn_date, w.warehouse_name, COALESCE(so.io_no, so.so_no) AS io_no, p.party_name AS supplier, po.po_no, g.supplier_inv_no,
            gl.accepted_qty - COALESCE((SELECT SUM(pi.issued_qty_kg) FROM trx_process_issue pi WHERE pi.grn_line_id = gl.id), 0) AS balance_kg
       FROM trx_grn_line gl JOIN trx_grn g ON g.id = gl.grn_id LEFT JOIN mst_yarn y ON y.id = gl.yarn_id LEFT JOIN mst_warehouse w ON w.id = g.warehouse_id
       LEFT JOIN trx_sales_order so ON so.id = gl.so_id LEFT JOIN mst_party p ON p.id = g.supplier_id LEFT JOIN trx_purchase_order po ON po.id = COALESCE(gl.po_id, g.po_id)
      WHERE gl.id IN (?) ORDER BY gl.id`, [all]);
  const events = await query<any>(
    `SELECT h.*, COALESCE(so.io_no, so.so_no) AS io_no, u.full_name AS user_name FROM trx_yarn_cone_history h LEFT JOIN trx_sales_order so ON so.id = h.so_id
       LEFT JOIN mst_user u ON u.id = h.user_id WHERE h.company_id = ? AND h.grn_line_id IN (?) ORDER BY h.event_time, h.id`, [cid, all]);
  // other uses of these lots: knitting / old yarn process DCs, job transfers
  const issues = await query<any>(
    `SELECT pi.issue_date, pi.dc_no, pi.issue_no, pi.src_type, pi.issued_qty_kg, pi.grn_line_id, gl.lot_no, gl.cone_no, v.party_name AS vendor, kp.program_no
       FROM trx_process_issue pi JOIN trx_grn_line gl ON gl.id = pi.grn_line_id LEFT JOIN mst_party v ON v.id = pi.vendor_id
       LEFT JOIN trx_knitting_program kp ON pi.src_type = 'KNITTING_PROGRAM' AND kp.id = pi.src_id
      WHERE pi.company_id = ? AND pi.grn_line_id IN (?) AND pi.src_type IN ('KNITTING_PROGRAM', 'YARN_PROCESS', 'COLLAR_PROGRAM')`, [cid, all]);
  const transfers = await query<any>(
    `SELECT t.transfer_date, t.transfer_no, l.qty, l.grn_line_id, l.lot_no, COALESCE(f.io_no, f.so_no, 'GENERAL') AS from_job, COALESCE(tj.io_no, tj.so_no, 'GENERAL') AS to_job, t.reason
       FROM trx_job_transfer_line l JOIN trx_job_transfer t ON t.id = l.transfer_id LEFT JOIN trx_sales_order f ON f.id = t.from_so_id LEFT JOIN trx_sales_order tj ON tj.id = t.to_so_id
      WHERE t.company_id = ? AND l.grn_line_id IN (?)`, [cid, all]);
  const roots = lots.filter((l) => !l.parent_grn_line_id && !l.source_ypo_id);
  const timeline = [
    ...roots.map((l) => ({ when: l.grn_date, event: 'YARN_RECEIPT', ref_no: l.grn_no, lot_no: l.lot_no, cone_no: l.cone_no, from: l.supplier || 'Supplier', to: l.warehouse_name, qty_kg: n(l.accepted_qty),
      remarks: [l.po_no ? `PO ${l.po_no}` : '', l.supplier_inv_no ? `Inv ${l.supplier_inv_no}` : ''].filter(Boolean).join(' · ') || 'Yarn GRN' })),
    ...events.map((e) => ({ when: e.event_time, event: e.event, ref_no: e.ref_no, lot_no: e.lot_no, cone_no: e.cone_no, process: e.process_code, from: e.from_place, to: e.to_place,
      qty_kg: n(e.qty_kg), io_no: e.io_no, remarks: e.remarks, user: e.user_name })),
    ...issues.map((i) => ({ when: i.issue_date, event: i.src_type === 'KNITTING_PROGRAM' ? 'KNITTING_ISSUE' : 'ISSUE', ref_no: i.dc_no || i.issue_no, lot_no: i.lot_no, cone_no: i.cone_no,
      from: 'Yarn store', to: i.vendor || (i.program_no ? `Knitting ${i.program_no}` : 'Process'), qty_kg: n(i.issued_qty_kg), remarks: i.program_no ? `Knitting program ${i.program_no}` : i.src_type })),
    ...transfers.map((t) => ({ when: t.transfer_date, event: 'JOB_TRANSFER', ref_no: t.transfer_no, lot_no: t.lot_no, from: t.from_job, to: t.to_job, qty_kg: n(t.qty), remarks: t.reason })),
  ].sort((a, b) => String(a.when).localeCompare(String(b.when)));
  res.json({ data: { lots: lots.map((l) => ({ ...l, balance_kg: r3(n(l.balance_kg)) })), timeline } });
}));

// =====================================================================================
// Ledger, job status, summary, reports (doc §16, §24)
// =====================================================================================
const repQ = z.object({ from: date.optional(), to: date.optional(), vendor_id: z.coerce.number().int().optional(), process_code: z.string().optional() });
const fw = (alias: string, dcol: string, q: z.infer<typeof repQ>) => {
  const w: string[] = []; const p: unknown[] = [];
  if (q.from) { w.push(`${alias}.${dcol} >= ?`); p.push(q.from); }
  if (q.to) { w.push(`${alias}.${dcol} <= ?`); p.push(q.to); }
  if (q.vendor_id) { w.push(`${alias}.vendor_id = ?`); p.push(q.vendor_id); }
  if (q.process_code) { w.push(`${alias}.process_code = ?`); p.push(q.process_code); }
  return { w: w.length ? ` AND ${w.join(' AND ')}` : '', p };
};

yarnEngineAfterRouter.get('/yarn-process/ledger', requirePermission(YP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = repQ.parse(req.query);
  const a = fw('o', 'ypo_date', q), b = fw('i', 'inward_date', q), c = fw('r', 'return_date', q);
  const rows = await query<any>(
    `SELECT * FROM (
       SELECT o.ypo_date AS doc_date, o.ypo_no AS doc_no, IF(o.is_reprocess, 'REPROCESS OUT', 'OUTWARD') AS txn, o.process_code, v.party_name AS contractor,
              (SELECT GROUP_CONCAT(DISTINCT l.io_no SEPARATOR ', ') FROM trx_yarn_process_order_line l WHERE l.ypo_id = o.id) AS jobs,
              o.total_kg AS outward_kg, 0 good_kg, 0 reject_kg, 0 loss_kg, o.status, o.id AS sort_id
         FROM trx_yarn_process_order o LEFT JOIN mst_party v ON v.id = o.vendor_id WHERE o.company_id = ? AND o.status NOT IN ('DRAFT','CANCELLED')${a.w}
       UNION ALL
       SELECT i.inward_date, i.inward_no, IF(i.is_reprocess, 'REPROCESS IN', 'INWARD'), i.process_code, v.party_name,
              (SELECT GROUP_CONCAT(DISTINCT x.io_no SEPARATOR ', ') FROM trx_yarn_process_inward_out x WHERE x.inward_id = i.id), 0, i.good_kg, i.reject_kg, i.loss_kg, i.status, i.id
         FROM trx_yarn_process_inward i LEFT JOIN mst_party v ON v.id = i.vendor_id WHERE i.company_id = ? AND i.status = 'POSTED'${b.w}
       UNION ALL
       SELECT r.return_date, r.return_no, 'RETURN', r.process_code, v.party_name, NULL, 0, 0, r.total_kg, 0, r.status, r.id
         FROM trx_yarn_process_return r LEFT JOIN mst_party v ON v.id = r.vendor_id WHERE r.company_id = ?${c.w}
     ) x ORDER BY doc_date, sort_id`, [cid, ...a.p, cid, ...b.p, cid, ...c.p]);
  let bal = 0;
  res.json({ data: rows.map((r) => {
    if (r.txn !== 'RETURN') bal += n(r.outward_kg) - n(r.good_kg) - n(r.reject_kg) - n(r.loss_kg);
    return { ...r, outward_kg: n(r.outward_kg), good_kg: n(r.good_kg), reject_kg: n(r.reject_kg), loss_kg: n(r.loss_kg), balance_kg: r3(bal) };
  }) });
}));

/** Job-wise reconciliation across DCs (doc §16): outward / good / reject / loss / balance / status. */
yarnEngineAfterRouter.get('/yarn-process/job-status', requirePermission(YP.VIEW), ah(async (req, res) => {
  const q = repQ.parse(req.query); const a = fw('o', 'ypo_date', q);
  const rows = await query<any>(
    `SELECT l.so_id, COALESCE(l.io_no, 'STOCK') io_no, l.buyer_po_no, st.style_code, o.process_code, pt.name AS process_name, COUNT(DISTINCT o.id) dcs,
            SUM(l.qty_kg) outward_kg, SUM(l.good_kg) good_kg, SUM(l.reject_kg) reject_kg, SUM(l.loss_kg) loss_kg
       FROM trx_yarn_process_order o JOIN trx_yarn_process_order_line l ON l.ypo_id = o.id LEFT JOIN mst_style st ON st.id = l.style_id
       LEFT JOIN mst_yarn_process_type pt ON pt.company_id = o.company_id AND pt.code = o.process_code
      WHERE o.company_id = ? AND o.status NOT IN ('DRAFT','CANCELLED')${a.w}
      GROUP BY l.so_id, l.io_no, l.buyer_po_no, st.style_code, o.process_code, pt.name ORDER BY l.io_no, o.process_code`, [req.user!.companyId, ...a.p]);
  res.json({ data: rows.map((r) => {
    const o = n(r.outward_kg), g = n(r.good_kg), rj = n(r.reject_kg), l = n(r.loss_kg), bal = Math.max(0, o - g - rj - l);
    return { ...r, outward_kg: r3(o), good_kg: r3(g), reject_kg: r3(rj), loss_kg: r3(l), balance_kg: r3(bal), status: bal <= EPS ? 'COMPLETED' : 'PENDING' };
  }) });
}));

/** Dashboard tiles (doc §24). */
yarnEngineAfterRouter.get('/yarn-process/summary', requirePermission(YP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = repQ.parse(req.query); const a = fw('o', 'ypo_date', q), b = fw('i', 'inward_date', q), c = fw('rp', 'reprocess_date', q);
  const ow = await queryOne<any>(`SELECT COALESCE(SUM(l.qty_kg),0) out_kg, COALESCE(SUM(l.qty_kg - l.good_kg - l.reject_kg - l.loss_kg),0) pending_kg
                                    FROM trx_yarn_process_order o JOIN trx_yarn_process_order_line l ON l.ypo_id = o.id WHERE o.company_id = ? AND o.status NOT IN ('DRAFT','CANCELLED')${a.w}`, [cid, ...a.p]);
  const iw = await queryOne<any>(`SELECT COALESCE(SUM(good_kg),0) good, COALESCE(SUM(reject_kg),0) rej, COALESCE(SUM(loss_kg),0) loss FROM trx_yarn_process_inward i WHERE i.company_id = ? AND i.status = 'POSTED'${b.w}`, [cid, ...b.p]);
  const rp = await queryOne<any>(`SELECT COALESCE(SUM(total_kg),0) kg, COALESCE(SUM(IF(billing_type='BILLABLE', total_kg, 0)),0) bkg, COALESCE(SUM(IF(billing_type='BILLABLE', bill_amount, 0)),0) bamt,
                                         COALESCE(SUM(IF(billing_type='NON_BILLABLE', total_kg, 0)),0) nbkg FROM trx_yarn_reprocess rp WHERE rp.company_id = ? AND rp.status <> 'CANCELLED'${c.w}`, [cid, ...c.p]);
  const bp = await queryOne<any>(`SELECT COUNT(*) c, COALESCE(SUM(good_kg),0) kg FROM trx_yarn_process_inward WHERE company_id = ? AND status = 'POSTED' AND bill_id IS NULL AND is_reprocess = 0`, [cid]);
  res.json({ data: { outward_kg: r3(n(ow?.out_kg)), inward_kg: r3(n(iw?.good)), reject_kg: r3(n(iw?.rej)), loss_kg: r3(n(iw?.loss)), pending_kg: r3(n(ow?.pending_kg)),
    reprocess_kg: r3(n(rp?.kg)), billable_reprocess_kg: r3(n(rp?.bkg)), billable_reprocess_amount: r2(n(rp?.bamt)), non_billable_reprocess_kg: r3(n(rp?.nbkg)),
    bill_pending_grns: Number(bp?.c) || 0, bill_pending_kg: r3(n(bp?.kg)) } });
}));

yarnEngineAfterRouter.get('/yarn-process/reports/:key', requirePermission(YP.VIEW), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = repQ.parse(req.query);
  const key = String(req.params.key);
  let rows: any[] = [];
  if (key === 'unit-pending') {
    const a = fw('o', 'ypo_date', q);
    rows = await query<any>(
      `SELECT v.party_name vendor, o.process_code, COUNT(DISTINCT o.id) open_dcs, GROUP_CONCAT(DISTINCT o.ypo_no ORDER BY o.ypo_no SEPARATOR ', ') dcs, MIN(o.ypo_date) oldest_dc_date,
              DATEDIFF(CURDATE(), MIN(o.ypo_date)) oldest_days, SUM(l.qty_kg) outward_kg, SUM(l.good_kg + l.reject_kg + l.loss_kg) received_kg, SUM(l.qty_kg - l.good_kg - l.reject_kg - l.loss_kg) pending_kg
         FROM trx_yarn_process_order o JOIN trx_yarn_process_order_line l ON l.ypo_id = o.id LEFT JOIN mst_party v ON v.id = o.vendor_id
        WHERE o.company_id = ? AND o.status IN ('CONFIRMED','PARTIALLY_RECEIVED')${a.w} GROUP BY o.vendor_id, v.party_name, o.process_code HAVING pending_kg > 0.0005 ORDER BY pending_kg DESC`, [cid, ...a.p]);
  } else if (key === 'reject-return') {
    const a = fw('i', 'inward_date', q), b = fw('r', 'return_date', q);
    const rej = await query<any>(
      `SELECT 'GRN REJECT' kind, i.inward_date doc_date, i.inward_no doc_no, o.ypo_no, v.party_name vendor, i.process_code, x.io_no, x.output_lot_no lot_no, x.output_cone_no cone_no, x.reject_kg qty_kg, x.reject_reason reason
         FROM trx_yarn_process_inward_out x JOIN trx_yarn_process_inward i ON i.id = x.inward_id JOIN trx_yarn_process_order o ON o.id = i.ypo_id LEFT JOIN mst_party v ON v.id = i.vendor_id
        WHERE i.company_id = ? AND i.status = 'POSTED' AND x.reject_kg > 0${a.w}`, [cid, ...a.p]);
    const ret = await query<any>(
      `SELECT 'RETURN' kind, r.return_date doc_date, r.return_no doc_no, o.ypo_no, v.party_name vendor, r.process_code, COALESCE(so.io_no, so.so_no) io_no, rl.lot_no, rl.cone_no, rl.qty_kg,
              CONCAT(COALESCE(rs.reason, ''), IF(rl.defect_reason IS NULL, '', CONCAT(' — ', rl.defect_reason))) reason
         FROM trx_yarn_process_return_line rl JOIN trx_yarn_process_return r ON r.id = rl.return_id LEFT JOIN trx_yarn_process_order o ON o.id = r.ypo_id LEFT JOIN mst_party v ON v.id = r.vendor_id
         LEFT JOIN mst_fabric_process_reason rs ON rs.id = r.reason_id LEFT JOIN trx_sales_order so ON so.id = rl.so_id WHERE r.company_id = ?${b.w}`, [cid, ...b.p]);
    rows = [...rej, ...ret].sort((x, y) => String(x.doc_date).localeCompare(String(y.doc_date)));
  } else if (key === 'reprocess-pending') {
    const a = fw('rp', 'reprocess_date', q);
    rows = (await query<any>(
      `SELECT rp.reprocess_no, rp.reprocess_date, DATEDIFF(CURDATE(), rp.reprocess_date) days, rp.process_code, v.party_name vendor, o.ypo_no, rp.status, rp.total_kg, rp.billing_type, rp.cost_treatment,
              rp.billing_status, rp.bill_amount, COALESCE((SELECT SUM(l.good_kg + l.reject_kg + l.loss_kg) FROM trx_yarn_process_order_line l WHERE l.ypo_id = rp.ypo_id), 0) received_kg
         FROM trx_yarn_reprocess rp LEFT JOIN mst_party v ON v.id = rp.vendor_id LEFT JOIN trx_yarn_process_order o ON o.id = rp.ypo_id
        WHERE rp.company_id = ? AND rp.status <> 'CANCELLED' AND (rp.status <> 'COMPLETED' OR rp.billing_status IN ('PENDING','APPROVED','REVERSED'))${a.w} ORDER BY rp.reprocess_date`, [cid, ...a.p]))
      .map((r) => ({ ...r, pending_kg: r3(Math.max(0, n(r.total_kg) - n(r.received_kg))),
        pending_for: r.status === 'DRAFT' ? 'Approval' : r.status === 'APPROVED' ? 'Reprocess DC' : r.status === 'IN_PROCESS' || r.status === 'INWARD_PENDING' ? 'Receipt from unit' : r.billing_status === 'PENDING' ? 'Billing approval' : 'Contractor bill' }));
  } else if (key === 'billing') {
    const a = fw('rp', 'reprocess_date', q);
    rows = await query<any>(
      `SELECT COALESCE(br.reason, rs.reason, '—') reason, rp.billing_type, rp.cost_treatment, v.party_name vendor, COUNT(*) entries, SUM(rp.total_kg) kg, SUM(rp.bill_amount) bill_amount, SUM(rp.internal_cost) internal_cost
         FROM trx_yarn_reprocess rp LEFT JOIN mst_fabric_process_reason br ON br.id = rp.billing_reason_id LEFT JOIN mst_fabric_process_reason rs ON rs.id = rp.reason_id LEFT JOIN mst_party v ON v.id = rp.vendor_id
        WHERE rp.company_id = ? AND rp.status <> 'CANCELLED'${a.w} GROUP BY COALESCE(br.reason, rs.reason, '—'), rp.billing_type, rp.cost_treatment, v.party_name ORDER BY rp.billing_type, kg DESC`, [cid, ...a.p]);
  } else if (key === 'process-loss' || key === 'input-output') {
    const a = fw('i', 'inward_date', q);
    rows = (await query<any>(
      `SELECT i.inward_no, i.inward_date, o.ypo_no, i.process_code, pt.process_mode, v.party_name vendor, x.io_no, COUNT(x.id) output_cones, SUM(x.input_kg) input_kg, SUM(x.good_kg) good_kg,
              SUM(x.reject_kg) reject_kg, SUM(x.loss_kg) loss_kg, (SELECT COUNT(*) FROM trx_yarn_process_inward_in ii JOIN trx_yarn_process_inward_out xx ON xx.id = ii.out_id WHERE xx.inward_id = i.id) input_cones
         FROM trx_yarn_process_inward i JOIN trx_yarn_process_order o ON o.id = i.ypo_id JOIN trx_yarn_process_inward_out x ON x.inward_id = i.id LEFT JOIN mst_party v ON v.id = i.vendor_id
         LEFT JOIN mst_yarn_process_type pt ON pt.company_id = i.company_id AND pt.code = i.process_code
        WHERE i.company_id = ? AND i.status = 'POSTED'${a.w}${key === 'input-output' ? ` AND pt.process_mode IN ('ONE_TO_MANY','MANY_TO_ONE')` : ''}
        GROUP BY i.id, x.io_no ORDER BY i.inward_date, i.id`, [cid, ...a.p]))
      .map((r) => ({ ...r, input_kg: r3(n(r.input_kg)), good_kg: r3(n(r.good_kg)), reject_kg: r3(n(r.reject_kg)), loss_kg: r3(n(r.loss_kg)),
        loss_pct: n(r.input_kg) > 0 ? r2(n(r.loss_kg) / n(r.input_kg) * 100) : 0, yield_pct: n(r.input_kg) > 0 ? r2(n(r.good_kg) / n(r.input_kg) * 100) : 0 }));
  } else if (key === 'unit-performance') {
    const a = fw('i', 'inward_date', q);
    rows = (await query<any>(
      `SELECT v.party_name vendor, i.process_code, COUNT(DISTINCT i.id) grns, SUM(i.input_kg) input_kg, SUM(i.good_kg) good_kg, SUM(i.reject_kg) reject_kg, SUM(i.loss_kg) loss_kg,
              AVG(DATEDIFF(i.inward_date, o.ypo_date)) avg_days
         FROM trx_yarn_process_inward i JOIN trx_yarn_process_order o ON o.id = i.ypo_id LEFT JOIN mst_party v ON v.id = i.vendor_id
        WHERE i.company_id = ? AND i.status = 'POSTED'${a.w} GROUP BY i.vendor_id, v.party_name, i.process_code ORDER BY v.party_name`, [cid, ...a.p]))
      .map((r) => ({ ...r, input_kg: r3(n(r.input_kg)), good_kg: r3(n(r.good_kg)), reject_kg: r3(n(r.reject_kg)), loss_kg: r3(n(r.loss_kg)), avg_days: r2(n(r.avg_days)),
        yield_pct: n(r.input_kg) > 0 ? r2(n(r.good_kg) / n(r.input_kg) * 100) : 0, reject_pct: n(r.input_kg) > 0 ? r2(n(r.reject_kg) / n(r.input_kg) * 100) : 0,
        loss_pct: n(r.input_kg) > 0 ? r2(n(r.loss_kg) / n(r.input_kg) * 100) : 0 }));
  } else if (key === 'lot-consumption') {
    const a = fw('o', 'ypo_date', q);
    rows = await query<any>(
      `SELECT l.lot_no, y.yarn_name, g.grn_no, COALESCE(l.io_no, 'STOCK') io_no, o.process_code, COUNT(DISTINCT o.id) dcs, SUM(l.qty_kg) issued_kg, SUM(l.good_kg) good_kg, SUM(l.reject_kg) reject_kg, SUM(l.loss_kg) loss_kg
         FROM trx_yarn_process_order o JOIN trx_yarn_process_order_line l ON l.ypo_id = o.id LEFT JOIN mst_yarn y ON y.id = l.yarn_id
         LEFT JOIN trx_grn_line gl ON gl.id = l.grn_line_id LEFT JOIN trx_grn g ON g.id = gl.grn_id
        WHERE o.company_id = ? AND o.status NOT IN ('DRAFT','CANCELLED')${a.w} GROUP BY l.grn_line_id, l.lot_no, y.yarn_name, g.grn_no, l.io_no, o.process_code ORDER BY l.lot_no`, [cid, ...a.p]);
  } else throw NotFound(`Unknown report ${key}`);
  res.json({ data: rows });
}));
