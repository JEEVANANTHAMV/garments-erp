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
  lockBundle, assertActive, applyBundle, addMovement, availAt, bundleAvail, packingRequiresQc,
  resolveBundleIds, linkBundlesToCarton, unlinkBundleFromCarton, type BundleRow,
} from './bundleLedger.js';
import { buildBundleTrace } from './bundleTrace.js';

/**
 * Floor stages after cutting (doc §14, §15, §20): bundle scan / split /
 * merge, sewing input & output, finishing input & output, final QC and the
 * carton ← bundle link. Every quantity is checked against the bundle's
 * stage balance with the bundle row locked, and every movement writes
 * trx_bundle_movement.
 */
export const productionFloorRouter = Router();

const n = (v: unknown) => Number(v ?? 0) || 0;
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const qtyOpt = z.coerce.number().int().min(0).default(0);
const reasonReq = z.string().trim().min(3, 'Give a reason (min 3 characters)').max(255);

/** A bundle is referenced by id or by scanned barcode / bundle no. */
const bundleRef = {
  bundle_id: s.id(),
  barcode: s.nullableStr(120),
};
function refOf(b: { bundle_id?: number | null; barcode?: string | null }) {
  if (!b.bundle_id && !b.barcode) throw BadRequest('Scan a bundle barcode or choose a bundle');
  return { id: b.bundle_id ?? null, code: b.barcode ?? null };
}

async function strictQcNoTx(cid: number) {
  const row = await queryOne<{ setting_value: string }>(
    `SELECT setting_value FROM cfg_system_setting WHERE company_id = ? AND setting_key = 'PACKING_REQUIRES_FINAL_QC'`, [cid]);
  return String(row?.setting_value ?? '0').trim() === '1';
}

async function logScan(req: Request, code: string, bundleId: number | null, context: string | null) {
  try {
    await execute(
      `INSERT INTO trx_bundle_scan_log (company_id, bundle_id, scanned_code, context, result, user_id, workstation, ip_address)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, bundleId, code.slice(0, 120), context ? context.slice(0, 40) : null,
       bundleId ? 'FOUND' : 'NOT_FOUND', req.user!.id,
       String(req.get('x-workstation') || req.get('user-agent') || '').slice(0, 120) || null,
       (req.ip ?? '').slice(0, 64) || null]);
  } catch (err) {
    console.error('[bundle-scan] log failed:', (err as Error).message);
  }
}

function requireStyle(b: BundleRow) {
  if (!b.style_id || !b.io_no) throw BadRequest(`Bundle ${b.bundle_no} has no style / IO no — fix the cutting record first`);
}

// ============================================================
// BUNDLE SCAN / TRACE (doc §14)
// ============================================================
productionFloorRouter.get('/bundles/scan/:code', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const code = String(req.params.code ?? '').trim();
  const context = req.query.context ? String(req.query.context).trim().toUpperCase() : 'TRACE';
  if (!code) throw BadRequest('Scan a bundle barcode');

  const rows = await query<{ id: number; barcode: string }>(
    `SELECT cb.id, cb.barcode FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      WHERE (cb.barcode = ? OR cb.bundle_no = ?) AND COALESCE(cb.company_id, c.company_id) = ?
      ORDER BY (cb.barcode = ?) DESC, cb.id DESC LIMIT 2`, [code, code, cid, code]);
  await logScan(req, code, rows[0]?.id ?? null, context);
  if (!rows.length) throw NotFound(`Bundle barcode ${code} not recognised`);
  if (rows.length > 1 && rows[0].barcode !== code) {
    throw BadRequest(`Bundle no "${code}" matches more than one bundle — scan the barcode instead`);
  }
  const trace = await buildBundleTrace(cid, rows[0].id, await strictQcNoTx(cid));
  res.json({ data: trace });
}));

productionFloorRouter.get('/bundles/scan-log', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: unknown[] = [cid];
  let where = 'l.company_id = ?';
  if (req.query.bundle_id) { where += ' AND l.bundle_id = ?'; params.push(Number(req.query.bundle_id)); }
  if (req.query.context) { where += ' AND l.context = ?'; params.push(String(req.query.context)); }
  const rows = await query(
    `SELECT l.*, u.full_name AS user_name, cb.bundle_no FROM trx_bundle_scan_log l
       LEFT JOIN mst_user u ON u.id = l.user_id LEFT JOIN trx_cutting_bundle cb ON cb.id = l.bundle_id
      WHERE ${where} ORDER BY l.id DESC LIMIT 200`, params);
  res.json({ data: rows });
}));

// ============================================================
// BUNDLE SPLIT / MERGE (doc §14, §20)
// ============================================================

/** Split and merge are only allowed while every PCS is still at cutting. */
async function assertAtCutting(tx: Tx, b: BundleRow, action: string) {
  assertActive(b);
  if (n(b.sew_in_qty) || n(b.out_cut_qty) || n(b.fin_in_qty) || n(b.packed_qty) || n(b.out_pack_qty)) {
    throw BadRequest(`Bundle ${b.bundle_no} has already moved past cutting — it cannot be ${action}`);
  }
  const onDc = await txQueryOne<any>(tx,
    `SELECT jc.challan_no FROM trx_jobwork_challan_line jl JOIN trx_jobwork_challan jc ON jc.id = jl.challan_id
      WHERE jl.bundle_id = ? AND jc.status IN ('DRAFT','ISSUED','PARTIAL_RECEIVED') LIMIT 1`, [b.id]);
  if (onDc) throw BadRequest(`Bundle ${b.bundle_no} is on DC ${onDc.challan_no} — remove it from the DC first`);
  if (n(b.balance_qty) <= 0) throw BadRequest(`Bundle ${b.bundle_no} has no balance PCS`);
}

async function newBarcode(tx: Tx, cid: number): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = await nextDocNumber(tx, cid, 'BUNDLE_BARCODE');
    const clash = await txQueryOne(tx, `SELECT id FROM trx_cutting_bundle WHERE barcode = ?`, [code]);
    if (!clash) return code;
  }
  throw BadRequest('Could not allocate a unique bundle barcode — check the BUNDLE_BARCODE number series');
}

async function insertChildBundle(tx: Tx, src: BundleRow, over: Record<string, unknown>) {
  const cols: Record<string, unknown> = {
    company_id: src.company_id, cutting_id: src.cutting_id, lay_id: src.lay_id ?? null,
    cut_output_id: src.cut_output_id ?? null, marker_version_id: src.marker_version_id ?? null,
    io_no: src.io_no, style_id: src.style_id, color_id: src.color_id, size_id: src.size_id,
    part_name: src.part_name, component: src.component ?? null, sku_id: src.sku_id,
    bundle_seq: src.bundle_seq ?? null, total_bundles: src.total_bundles ?? null,
    allocation_method: src.allocation_method ?? null, allocation_source: src.allocation_source ?? null,
    ...over,
  };
  const keys = Object.keys(cols);
  const r = await txExecute(tx,
    `INSERT INTO trx_cutting_bundle (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((k) => cols[k] ?? null));
  return r.insertId;
}

const round5 = (v: number) => Math.round(v * 100000) / 100000;

productionFloorRouter.post('/bundles/:id/split', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid bundle id');
  const body = z.object({
    qtys: z.array(z.coerce.number().int().positive('Each split qty must be at least 1 PCS')).min(1).max(50),
    reason: reasonReq,
  }).parse(req.body);

  const result = await transaction(async (tx) => {
    const b = await lockBundle(tx, cid, { id });
    await assertAtCutting(tx, b, 'split');
    const avail = n(b.balance_qty);
    const qtys = [...body.qtys];
    const total = qtys.reduce((a, q) => a + q, 0);
    if (total > avail) throw BadRequest(`Split total ${total} PCS exceeds bundle ${b.bundle_no} balance of ${avail} PCS`);
    if (total < avail) qtys.push(avail - total);   // remainder stays traceable as its own child
    if (qtys.length < 2) throw BadRequest('A split needs at least two child bundles');

    const kgPerPc = b.allocated_kg != null && n(b.qty) > 0 ? n(b.allocated_kg) / n(b.qty) : null;
    const components = await txQuery<any>(tx, `SELECT component FROM trx_cutting_bundle_detail WHERE bundle_id = ?`, [b.id]);
    const children: any[] = [];
    for (let i = 0; i < qtys.length; i++) {
      const q = qtys[i];
      const barcode = await newBarcode(tx, cid);
      const bundleNo = `${b.bundle_no}-S${i + 1}`.slice(0, 40);
      const childId = await insertChildBundle(tx, b, {
        parent_bundle_id: b.id, bundle_no: bundleNo, barcode, qty: q, balance_qty: q,
        allocated_kg: kgPerPc == null ? null : round5(kgPerPc * q),
        status: b.status === 'CHECKED' ? 'CHECKED' : 'GENERATED', created_by: req.user!.id,
      });
      for (const c of components) {
        await txExecute(tx, `INSERT INTO trx_cutting_bundle_detail (bundle_id, component, piece_qty) VALUES (?,?,?)`, [childId, c.component, q]);
      }
      const child = { ...b, id: childId, bundle_no: bundleNo, barcode, qty: q, status: 'GENERATED' } as BundleRow;
      await addMovement(tx, req, child, {
        txn_type: 'SPLIT_FROM', from_stage: 'SPLIT', to_stage: child.status, qty: q, good: q,
        ref_table: 'trx_cutting_bundle', ref_id: b.id, remarks: `Split from ${b.bundle_no}: ${body.reason}`.slice(0, 255),
      });
      children.push({ id: childId, bundle_no: bundleNo, barcode, qty: q, allocated_kg: kgPerPc == null ? null : round5(kgPerPc * q) });
    }
    await applyBundle(tx, b, { balance_qty: -avail }, 'SPLIT');
    await addMovement(tx, req, b, {
      txn_type: 'SPLIT', from_stage: b.status, to_stage: 'SPLIT', qty: avail,
      ref_table: 'trx_cutting_bundle', ref_id: b.id,
      remarks: `${body.reason} → ${children.map((c) => c.bundle_no).join(', ')}`.slice(0, 255),
    });
    await audit(req, 'trx_cutting_bundle', b.id, 'UPDATE', { status: b.status, balance_qty: avail },
      { status: 'SPLIT', balance_qty: 0, reason: body.reason, children }, tx);
    return { parent_id: b.id, parent_bundle_no: b.bundle_no, children };
  });
  res.status(201).json({ data: result });
}));

productionFloorRouter.post('/bundles/merge', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    bundle_ids: z.array(z.coerce.number().int().positive()).default([]),
    barcodes: z.array(z.string().trim().min(1).max(120)).default([]),
    reason: reasonReq,
  }).parse(req.body);

  const result = await transaction(async (tx) => {
    const ids = await resolveBundleIds(tx, cid, body.bundle_ids, body.barcodes);
    if (ids.length < 2) throw BadRequest('Choose at least two bundles to merge');
    const src: BundleRow[] = [];
    for (const id of ids) {
      const b = await lockBundle(tx, cid, { id });
      await assertAtCutting(tx, b, 'merged');
      src.push(b);
    }
    // Merge must not blur fabric traceability: same lay, cut output, marker and SKU.
    const key = (b: BundleRow) => [b.cutting_id, b.lay_id ?? '', b.cut_output_id ?? '', b.marker_version_id ?? '',
      b.io_no ?? '', b.style_id, b.color_id, b.size_id, b.part_name ?? ''].join('|');
    if (new Set(src.map(key)).size > 1) {
      throw BadRequest('Only bundles of the same cutting / lay / cut output / style / colour / size / part can be merged');
    }
    const first = src[0];
    const qty = src.reduce((a, b) => a + n(b.balance_qty), 0);
    const kg = src.every((b) => b.allocated_kg == null) ? null
      : round5(src.reduce((a, b) => a + (n(b.qty) ? n(b.allocated_kg) * n(b.balance_qty) / n(b.qty) : 0), 0));
    const barcode = await newBarcode(tx, cid);
    const bundleNo = (await nextDocNumber(tx, cid, 'BUNDLE_MERGE')).slice(0, 40);
    const mergedId = await insertChildBundle(tx, first, {
      parent_bundle_id: null, bundle_no: bundleNo, barcode, qty, balance_qty: qty, allocated_kg: kg,
      allocation_source: `MERGE of ${src.map((b) => b.bundle_no).join(', ')}`.slice(0, 160),
      status: 'GENERATED', created_by: req.user!.id,
    });
    const comps = await txQuery<any>(tx,
      `SELECT DISTINCT component FROM trx_cutting_bundle_detail WHERE bundle_id IN (?)`, [ids]);
    for (const c of comps) {
      await txExecute(tx, `INSERT INTO trx_cutting_bundle_detail (bundle_id, component, piece_qty) VALUES (?,?,?)`, [mergedId, c.component, qty]);
    }
    const merged = { ...first, id: mergedId, bundle_no: bundleNo, barcode, qty, status: 'GENERATED' } as BundleRow;
    for (const b of src) {
      const bal = n(b.balance_qty);
      await txExecute(tx,
        `INSERT INTO trx_bundle_merge_source (company_id, merged_bundle_id, source_bundle_id, qty, allocated_kg, reason, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [cid, mergedId, b.id, bal, b.allocated_kg == null || !n(b.qty) ? null : round5(n(b.allocated_kg) * bal / n(b.qty)),
         body.reason, req.user!.id]);
      await applyBundle(tx, b, { balance_qty: -bal }, 'CLOSED');
      await addMovement(tx, req, b, {
        txn_type: 'MERGE_OUT', from_stage: b.status, to_stage: 'CLOSED', qty: bal,
        ref_table: 'trx_cutting_bundle', ref_id: mergedId, remarks: `Merged into ${bundleNo}: ${body.reason}`.slice(0, 255),
      });
    }
    await addMovement(tx, req, merged, {
      txn_type: 'MERGE_IN', from_stage: 'MERGE', to_stage: 'GENERATED', qty, good: qty,
      ref_table: 'trx_bundle_merge_source', ref_id: mergedId,
      remarks: `Merged from ${src.map((b) => b.bundle_no).join(', ')}`.slice(0, 255),
    });
    await audit(req, 'trx_cutting_bundle', mergedId, 'INSERT', undefined,
      { bundle_no: bundleNo, barcode, qty, sources: src.map((b) => b.id), reason: body.reason }, tx);
    return { id: mergedId, bundle_no: bundleNo, barcode, qty, allocated_kg: kg, sources: src.map((b) => ({ id: b.id, bundle_no: b.bundle_no })) };
  });
  res.status(201).json({ data: result });
}));

// ============================================================
// SEWING INPUT & OUTPUT (doc §15)
// ============================================================
productionFloorRouter.get('/sewing/inputs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: unknown[] = [cid];
  let where = 'si.company_id = ?';
  if (req.query.status) { where += ' AND si.status = ?'; params.push(String(req.query.status)); }
  if (req.query.bundle_id) { where += ' AND si.bundle_id = ?'; params.push(Number(req.query.bundle_id)); }
  if (req.query.line_name) { where += ' AND si.line_name = ?'; params.push(String(req.query.line_name)); }
  if (req.query.io_no) { where += ' AND si.io_no = ?'; params.push(String(req.query.io_no)); }
  const rows = await query(
    `SELECT si.*, cb.bundle_no, cb.barcode, st.style_code, col.color_name, sz.size_code,
            COALESCE(o.good,0) AS output_qty, COALESCE(o.rej,0) AS reject_qty, COALESCE(o.rw,0) AS rework_qty,
            GREATEST(COALESCE(si.input_qty,0) - COALESCE(o.good,0) - COALESCE(o.rej,0), 0) AS pending_qty
       FROM trx_sewing_input si
       JOIN trx_cutting_bundle cb ON cb.id = si.bundle_id
       LEFT JOIN (SELECT sewing_input_id, SUM(output_qty) AS good, SUM(reject_qty) AS rej, SUM(rework_qty) AS rw
                    FROM trx_sewing_output GROUP BY sewing_input_id) o ON o.sewing_input_id = si.id
       LEFT JOIN mst_style st ON st.id = si.style_id
       LEFT JOIN mst_color col ON col.id = si.color_id
       LEFT JOIN mst_size sz ON sz.id = si.size_id
      WHERE ${where}
      ORDER BY si.input_date DESC, si.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

productionFloorRouter.post('/sewing/input', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    ...bundleRef,
    input_no: s.nullableStr(40),
    input_date: dateStr,
    input_qty: z.coerce.number().int().positive().nullish(),
    line_name: s.strReq(60),
    work_center: s.nullableStr(80),
    operator_name: s.nullableStr(80),
    remarks: s.nullableStr(500),
  }).parse(req.body);

  const result = await transaction(async (tx) => {
    const b = await lockBundle(tx, cid, refOf(body));
    assertActive(b);
    requireStyle(b);
    const avail = n(b.balance_qty);
    if (avail <= 0) {
      throw BadRequest(`Bundle ${b.bundle_no} is already fully issued — 0 PCS balance at cutting`
        + (n(b.out_cut_qty) ? ` (${n(b.out_cut_qty)} PCS are out on a job-work DC)` : ''));
    }
    const qty = body.input_qty ?? avail;
    if (qty > avail) throw BadRequest(`Bundle ${b.bundle_no}: only ${avail} PCS available, ${qty} requested`);

    const inputNo = body.input_no || await nextDocNumber(tx, cid, 'SEW_IN');
    const r = await txExecute(tx,
      `INSERT INTO trx_sewing_input
        (company_id, input_no, input_date, io_no, style_id, color_id, size_id, bundle_id,
         line_name, work_center, operator_name, input_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, inputNo, body.input_date, b.io_no, b.style_id, b.color_id, b.size_id, b.id,
       body.line_name, body.work_center ?? null, body.operator_name ?? null, qty, 'OPEN', body.remarks ?? null, req.user!.id]);
    const after = await applyBundle(tx, b, { balance_qty: -qty, sew_in_qty: qty });
    await addMovement(tx, req, b, {
      txn_type: 'SEWING_IN', from_stage: b.status, to_stage: after.status, qty, good: qty,
      location: body.line_name, work_center: body.work_center ?? body.line_name, destination: body.line_name,
      ref_table: 'trx_sewing_input', ref_id: r.insertId, remarks: body.remarks ?? null,
    });
    const row = await txQueryOne(tx, `SELECT * FROM trx_sewing_input WHERE id = ?`, [r.insertId]);
    await audit(req, 'trx_sewing_input', r.insertId, 'INSERT', undefined, row, tx);
    return { ...row, bundle_no: b.bundle_no, bundle_balance: n(after.balance_qty) };
  });
  res.status(201).json({ data: result });
}));

productionFloorRouter.post('/sewing/inputs/:id/cancel', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  const result = await transaction(async (tx) => {
    const pre = await txQueryOne<any>(tx, `SELECT bundle_id FROM trx_sewing_input WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!pre) throw NotFound('Sewing input not found');
    const b = await lockBundle(tx, cid, { id: pre.bundle_id });
    const si = await txQueryOne<any>(tx, `SELECT * FROM trx_sewing_input WHERE id = ? FOR UPDATE`, [id]);
    if (si.status === 'CANCELLED') throw BadRequest('Sewing input is already cancelled');
    const out = await txQueryOne<any>(tx, `SELECT COUNT(*) AS c FROM trx_sewing_output WHERE sewing_input_id = ?`, [id]);
    if (n(out?.c)) throw BadRequest('Sewing output is already recorded against this input — it cannot be cancelled');
    const qty = n(si.input_qty);
    await txExecute(tx,
      `UPDATE trx_sewing_input SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`,
      [reason, req.user!.id, id]);
    const after = await applyBundle(tx, b, { balance_qty: qty, sew_in_qty: -qty });
    await addMovement(tx, req, b, {
      txn_type: 'SEWING_IN_CANCEL', from_stage: b.status, to_stage: after.status, qty,
      location: si.line_name, ref_table: 'trx_sewing_input', ref_id: id, remarks: reason,
    });
    await audit(req, 'trx_sewing_input', id, 'UPDATE', si, { status: 'CANCELLED', reason }, tx);
    return { id, status: 'CANCELLED', bundle_balance: n(after.balance_qty) };
  });
  res.json({ data: result });
}));

productionFloorRouter.get('/sewing/outputs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT so.*, si.input_no, cb.bundle_no, st.style_code, col.color_name, sz.size_code
       FROM trx_sewing_output so
       LEFT JOIN trx_sewing_input si ON si.id = so.sewing_input_id
       LEFT JOIN trx_cutting_bundle cb ON cb.id = so.bundle_id
       LEFT JOIN mst_style st ON st.id = so.style_id
       LEFT JOIN mst_color col ON col.id = so.color_id
       LEFT JOIN mst_size sz ON sz.id = so.size_id
      WHERE so.company_id = ? ORDER BY so.id DESC LIMIT 500`, [cid]);
  res.json({ data: rows });
}));

productionFloorRouter.post('/sewing/output', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    output_no: s.nullableStr(40),
    output_date: dateStr,
    sewing_input_id: s.idReq(),
    output_qty: qtyOpt,
    reject_qty: qtyOpt,
    rework_qty: qtyOpt,
    remarks: s.nullableStr(500),
  }).parse(req.body);
  if (body.output_qty + body.reject_qty + body.rework_qty <= 0) throw BadRequest('Enter good, reject or rework PCS');

  const result = await transaction(async (tx) => {
    const pre = await txQueryOne<any>(tx, `SELECT bundle_id FROM trx_sewing_input WHERE id = ? AND company_id = ?`, [body.sewing_input_id, cid]);
    if (!pre) throw NotFound('Sewing input not found');
    const b = await lockBundle(tx, cid, { id: pre.bundle_id });
    const input = await txQueryOne<any>(tx, `SELECT * FROM trx_sewing_input WHERE id = ? FOR UPDATE`, [body.sewing_input_id]);
    if (input.status === 'CANCELLED') throw BadRequest('Sewing input is cancelled');
    const done = await txQueryOne<any>(tx,
      `SELECT COALESCE(SUM(output_qty),0) AS g, COALESCE(SUM(reject_qty),0) AS r FROM trx_sewing_output WHERE sewing_input_id = ?`,
      [input.id]);
    const pending = n(input.input_qty) - n(done?.g) - n(done?.r);
    const asked = body.output_qty + body.reject_qty + body.rework_qty;
    if (asked > pending) {
      throw BadRequest(`Input ${input.input_no}: good + reject + rework (${asked} PCS) exceeds the ${pending} PCS still on the line`);
    }
    const outNo = body.output_no || await nextDocNumber(tx, cid, 'SEW_OUT');
    const r = await txExecute(tx,
      `INSERT INTO trx_sewing_output
        (company_id, output_no, output_date, sewing_input_id, io_no, style_id, color_id, size_id,
         bundle_id, line_name, output_qty, reject_qty, rework_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, outNo, body.output_date, input.id, input.io_no, input.style_id, input.color_id,
       input.size_id, input.bundle_id, input.line_name, body.output_qty, body.reject_qty,
       body.rework_qty, 'COMPLETED', body.remarks ?? null, req.user!.id]);
    const left = pending - body.output_qty - body.reject_qty;
    if (left === 0) await txExecute(tx, `UPDATE trx_sewing_input SET status = 'COMPLETED' WHERE id = ?`, [input.id]);
    const after = await applyBundle(tx, b, { sew_good_qty: body.output_qty, sew_reject_qty: body.reject_qty });
    await addMovement(tx, req, b, {
      txn_type: 'SEWING_OUT', from_stage: b.status, to_stage: after.status,
      qty: body.output_qty + body.reject_qty, good: body.output_qty, reject: body.reject_qty, rework: body.rework_qty,
      location: input.line_name, work_center: input.work_center ?? input.line_name,
      ref_table: 'trx_sewing_output', ref_id: r.insertId, remarks: body.remarks ?? null,
    });
    const row = await txQueryOne(tx, `SELECT * FROM trx_sewing_output WHERE id = ?`, [r.insertId]);
    await audit(req, 'trx_sewing_output', r.insertId, 'INSERT', undefined, row, tx);
    return { ...row, input_pending_qty: left, bundle_status: after.status };
  });
  res.status(201).json({ data: result });
}));

// ============================================================
// FINISHING & FINAL QC (doc §15)
// ============================================================
productionFloorRouter.get('/finishing/inputs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: unknown[] = [cid];
  let where = 'fi.company_id = ?';
  if (req.query.status) { where += ' AND fi.status = ?'; params.push(String(req.query.status)); }
  if (req.query.bundle_id) { where += ' AND fi.bundle_id = ?'; params.push(Number(req.query.bundle_id)); }
  const rows = await query(
    `SELECT fi.*, cb.bundle_no, cb.barcode, st.style_code, col.color_name, sz.size_code,
            COALESCE(o.good,0) AS output_qty, COALESCE(o.rej,0) AS reject_qty, COALESCE(o.rw,0) AS rework_qty,
            GREATEST(COALESCE(fi.input_qty,0) - COALESCE(o.good,0) - COALESCE(o.rej,0), 0) AS pending_qty
       FROM trx_finishing_input fi
       LEFT JOIN trx_cutting_bundle cb ON cb.id = fi.bundle_id
       LEFT JOIN (SELECT finishing_input_id, SUM(output_qty) AS good, SUM(reject_qty) AS rej, SUM(rework_qty) AS rw
                    FROM trx_finishing_output GROUP BY finishing_input_id) o ON o.finishing_input_id = fi.id
       LEFT JOIN mst_style st ON st.id = fi.style_id
       LEFT JOIN mst_color col ON col.id = fi.color_id
       LEFT JOIN mst_size sz ON sz.id = fi.size_id
      WHERE ${where} ORDER BY fi.input_date DESC, fi.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

productionFloorRouter.post('/finishing/input', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    ...bundleRef,
    input_no: s.nullableStr(40),
    input_date: dateStr,
    sewing_output_id: s.id(),
    input_qty: z.coerce.number().int().positive().nullish(),
    line_name: s.nullableStr(60),
    work_center: s.nullableStr(80),
    remarks: s.nullableStr(500),
  }).parse(req.body);

  const result = await transaction(async (tx) => {
    let ref = { id: body.bundle_id ?? null, code: body.barcode ?? null };
    if (!ref.id && !ref.code && body.sewing_output_id) {
      const so = await txQueryOne<any>(tx, `SELECT bundle_id FROM trx_sewing_output WHERE id = ? AND company_id = ?`, [body.sewing_output_id, cid]);
      if (!so) throw NotFound('Sewing output not found');
      if (!so.bundle_id) throw BadRequest('That sewing output has no bundle — finishing must reference a bundle');
      ref = { id: so.bundle_id, code: null };
    }
    const b = await lockBundle(tx, cid, refOf({ bundle_id: ref.id, barcode: ref.code }));
    assertActive(b);
    requireStyle(b);
    const avail = availAt(b, 'SEWN');
    if (avail <= 0) throw BadRequest(`Bundle ${b.bundle_no} has no sewn good PCS waiting for finishing`);
    const qty = body.input_qty ?? avail;
    if (qty > avail) throw BadRequest(`Bundle ${b.bundle_no}: only ${avail} sewn good PCS available, ${qty} requested`);

    let sewOutId = body.sewing_output_id ?? null;
    if (sewOutId) {
      const so = await txQueryOne<any>(tx, `SELECT bundle_id FROM trx_sewing_output WHERE id = ? AND company_id = ?`, [sewOutId, cid]);
      if (!so || (so.bundle_id && Number(so.bundle_id) !== b.id)) throw BadRequest('Sewing output does not belong to this bundle');
    } else {
      const last = await txQueryOne<any>(tx, `SELECT id FROM trx_sewing_output WHERE bundle_id = ? AND company_id = ? ORDER BY id DESC LIMIT 1`, [b.id, cid]);
      sewOutId = last?.id ?? null;
    }
    const finNo = body.input_no || await nextDocNumber(tx, cid, 'FIN_IN');
    const r = await txExecute(tx,
      `INSERT INTO trx_finishing_input
        (company_id, input_no, input_date, io_no, style_id, color_id, size_id, bundle_id,
         sewing_output_id, line_name, work_center, input_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, finNo, body.input_date, b.io_no, b.style_id, b.color_id, b.size_id, b.id,
       sewOutId, body.line_name ?? null, body.work_center ?? null, qty, 'OPEN', body.remarks ?? null, req.user!.id]);
    const after = await applyBundle(tx, b, { fin_in_qty: qty });
    await addMovement(tx, req, b, {
      txn_type: 'FINISHING_IN', from_stage: b.status, to_stage: after.status, qty, good: qty,
      location: body.line_name ?? 'FINISHING', work_center: body.work_center ?? body.line_name ?? null,
      ref_table: 'trx_finishing_input', ref_id: r.insertId, remarks: body.remarks ?? null,
    });
    const row = await txQueryOne(tx, `SELECT * FROM trx_finishing_input WHERE id = ?`, [r.insertId]);
    await audit(req, 'trx_finishing_input', r.insertId, 'INSERT', undefined, row, tx);
    return { ...row, bundle_no: b.bundle_no, sewn_available: availAt(after, 'SEWN') };
  });
  res.status(201).json({ data: result });
}));

productionFloorRouter.post('/finishing/inputs/:id/cancel', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  const result = await transaction(async (tx) => {
    const pre = await txQueryOne<any>(tx, `SELECT bundle_id FROM trx_finishing_input WHERE id = ? AND company_id = ?`, [id, cid]);
    if (!pre) throw NotFound('Finishing input not found');
    const b = pre.bundle_id ? await lockBundle(tx, cid, { id: pre.bundle_id }) : null;
    const fi = await txQueryOne<any>(tx, `SELECT * FROM trx_finishing_input WHERE id = ? FOR UPDATE`, [id]);
    if (fi.status === 'CANCELLED') throw BadRequest('Finishing input is already cancelled');
    const out = await txQueryOne<any>(tx, `SELECT COUNT(*) AS c FROM trx_finishing_output WHERE finishing_input_id = ?`, [id]);
    if (n(out?.c)) throw BadRequest('Finishing output is already recorded against this input — it cannot be cancelled');
    await txExecute(tx,
      `UPDATE trx_finishing_input SET status = 'CANCELLED', cancel_reason = ?, cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`,
      [reason, req.user!.id, id]);
    if (b) {
      const after = await applyBundle(tx, b, { fin_in_qty: -n(fi.input_qty) });
      await addMovement(tx, req, b, {
        txn_type: 'FINISHING_IN_CANCEL', from_stage: b.status, to_stage: after.status, qty: n(fi.input_qty),
        ref_table: 'trx_finishing_input', ref_id: id, remarks: reason,
      });
    }
    await audit(req, 'trx_finishing_input', id, 'UPDATE', fi, { status: 'CANCELLED', reason }, tx);
    return { id, status: 'CANCELLED' };
  });
  res.json({ data: result });
}));

productionFloorRouter.get('/finishing/outputs', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const params: unknown[] = [cid];
  let where = 'fo.company_id = ?';
  if (req.query.bundle_id) { where += ' AND fo.bundle_id = ?'; params.push(Number(req.query.bundle_id)); }
  const rows = await query(
    `SELECT fo.*, fi.input_no, cb.bundle_no, cb.barcode, st.style_code, col.color_name, sz.size_code,
            COALESCE((SELECT SUM(q.inspected_qty) FROM trx_final_qc q WHERE q.finishing_output_id = fo.id), 0) AS inspected_qty
       FROM trx_finishing_output fo
       LEFT JOIN trx_finishing_input fi ON fi.id = fo.finishing_input_id
       LEFT JOIN trx_cutting_bundle cb ON cb.id = fo.bundle_id
       LEFT JOIN mst_style st ON st.id = fo.style_id
       LEFT JOIN mst_color col ON col.id = fo.color_id
       LEFT JOIN mst_size sz ON sz.id = fo.size_id
      WHERE ${where} ORDER BY fo.id DESC LIMIT 500`, params);
  res.json({ data: rows });
}));

productionFloorRouter.post('/finishing/output', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    output_no: s.nullableStr(40),
    output_date: dateStr,
    finishing_input_id: s.idReq(),
    output_qty: qtyOpt,
    reject_qty: qtyOpt,
    rework_qty: qtyOpt,
    remarks: s.nullableStr(500),
  }).parse(req.body);
  if (body.output_qty + body.reject_qty + body.rework_qty <= 0) throw BadRequest('Enter good, reject or rework PCS');

  const result = await transaction(async (tx) => {
    const pre = await txQueryOne<any>(tx, `SELECT bundle_id FROM trx_finishing_input WHERE id = ? AND company_id = ?`, [body.finishing_input_id, cid]);
    if (!pre) throw NotFound('Finishing input not found');
    const b = pre.bundle_id ? await lockBundle(tx, cid, { id: pre.bundle_id }) : null;
    const finIn = await txQueryOne<any>(tx, `SELECT * FROM trx_finishing_input WHERE id = ? FOR UPDATE`, [body.finishing_input_id]);
    if (finIn.status === 'CANCELLED') throw BadRequest('Finishing input is cancelled');
    const done = await txQueryOne<any>(tx,
      `SELECT COALESCE(SUM(output_qty),0) AS g, COALESCE(SUM(reject_qty),0) AS r FROM trx_finishing_output WHERE finishing_input_id = ?`,
      [finIn.id]);
    const pending = n(finIn.input_qty) - n(done?.g) - n(done?.r);
    const asked = body.output_qty + body.reject_qty + body.rework_qty;
    if (asked > pending) {
      throw BadRequest(`Finishing input ${finIn.input_no}: good + reject + rework (${asked} PCS) exceeds the ${pending} PCS pending`);
    }
    const outNo = body.output_no || await nextDocNumber(tx, cid, 'FIN_OUT');
    const r = await txExecute(tx,
      `INSERT INTO trx_finishing_output
        (company_id, output_no, output_date, finishing_input_id, bundle_id, io_no, style_id, color_id, size_id,
         output_qty, reject_qty, rework_qty, status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, outNo, body.output_date, finIn.id, finIn.bundle_id ?? null, finIn.io_no, finIn.style_id,
       finIn.color_id, finIn.size_id, body.output_qty, body.reject_qty, body.rework_qty,
       'COMPLETED', body.remarks ?? null, req.user!.id]);
    const left = pending - body.output_qty - body.reject_qty;
    if (left === 0) await txExecute(tx, `UPDATE trx_finishing_input SET status = 'COMPLETED' WHERE id = ?`, [finIn.id]);
    let bundleStatus: string | null = null;
    if (b) {
      const after = await applyBundle(tx, b, { fin_good_qty: body.output_qty, fin_reject_qty: body.reject_qty });
      bundleStatus = after.status;
      await addMovement(tx, req, b, {
        txn_type: 'FINISHING_OUT', from_stage: b.status, to_stage: after.status,
        qty: body.output_qty + body.reject_qty, good: body.output_qty, reject: body.reject_qty, rework: body.rework_qty,
        location: finIn.line_name ?? 'FINISHING', work_center: finIn.work_center ?? null,
        ref_table: 'trx_finishing_output', ref_id: r.insertId, remarks: body.remarks ?? null,
      });
    }
    const row = await txQueryOne(tx, `SELECT * FROM trx_finishing_output WHERE id = ?`, [r.insertId]);
    await audit(req, 'trx_finishing_output', r.insertId, 'INSERT', undefined, row, tx);
    return { ...row, input_pending_qty: left, bundle_status: bundleStatus };
  });
  res.status(201).json({ data: result });
}));

productionFloorRouter.get('/final-qc', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const rows = await query(
    `SELECT q.*, cb.bundle_no, cb.barcode, fo.output_no, st.style_code, col.color_name, sz.size_code
       FROM trx_final_qc q
       LEFT JOIN trx_cutting_bundle cb ON cb.id = q.bundle_id
       LEFT JOIN trx_finishing_output fo ON fo.id = q.finishing_output_id
       LEFT JOIN mst_style st ON st.id = q.style_id
       LEFT JOIN mst_color col ON col.id = q.color_id
       LEFT JOIN mst_size sz ON sz.id = q.size_id
      WHERE q.company_id = ? ORDER BY q.qc_date DESC, q.id DESC LIMIT 500`, [cid]);
  res.json({ data: rows });
}));

productionFloorRouter.post('/final-qc', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = z.object({
    ...bundleRef,
    qc_no: s.nullableStr(40),
    qc_date: dateStr,
    finishing_output_id: s.id(),
    inspected_qty: z.coerce.number().int().positive(),
    passed_qty: qtyOpt,
    reject_qty: qtyOpt,
    rework_qty: qtyOpt,
    hold_qty: qtyOpt,
    qc_status: z.enum(['PASS', 'HOLD', 'REJECT']).nullish(),
    inspector_name: s.nullableStr(80),
    remarks: s.nullableStr(500),
  }).parse(req.body);
  const accounted = body.passed_qty + body.reject_qty + body.rework_qty + body.hold_qty;
  if (accounted > body.inspected_qty) {
    throw BadRequest(`Passed + reject + rework + hold (${accounted} PCS) cannot exceed inspected ${body.inspected_qty} PCS`);
  }
  const status = body.qc_status
    ?? (body.hold_qty > 0 ? 'HOLD' : body.passed_qty === 0 && body.reject_qty > 0 ? 'REJECT' : 'PASS');

  const result = await transaction(async (tx) => {
    let fo: any = null;
    if (body.finishing_output_id) {
      fo = await txQueryOne<any>(tx, `SELECT * FROM trx_finishing_output WHERE id = ? AND company_id = ?`, [body.finishing_output_id, cid]);
      if (!fo) throw NotFound('Finishing output not found');
    }
    let ref = { id: body.bundle_id ?? null, code: body.barcode ?? null };
    if (!ref.id && !ref.code && fo?.bundle_id) ref = { id: fo.bundle_id, code: null };

    let b: BundleRow | null = null;
    if (ref.id || ref.code) {
      b = await lockBundle(tx, cid, ref);
      assertActive(b);
      requireStyle(b);
      if (fo?.bundle_id && Number(fo.bundle_id) !== b.id) throw BadRequest('Finishing output does not belong to this bundle');
      const strict = await packingRequiresQc(tx, cid);
      const avail = availAt(b, 'FIN', strict);
      if (body.inspected_qty > avail) {
        throw BadRequest(`Bundle ${b.bundle_no}: only ${avail} finished PCS are waiting for final QC, ${body.inspected_qty} inspected`);
      }
    } else if (fo) {
      // Legacy finishing output without a bundle: limit to that output's good PCS.
      const prior = await txQueryOne<any>(tx,
        `SELECT COALESCE(SUM(passed_qty + reject_qty),0) AS q FROM trx_final_qc WHERE finishing_output_id = ? FOR UPDATE`, [fo.id]);
      const avail = n(fo.output_qty) - n(prior?.q);
      if (body.inspected_qty > avail) throw BadRequest(`Only ${avail} finished PCS of ${fo.output_no} remain for QC`);
    } else {
      throw BadRequest('Scan the bundle (or choose the finishing output) being inspected');
    }

    const src = b ?? fo;
    const qcNo = body.qc_no || await nextDocNumber(tx, cid, 'FINAL_QC');
    const r = await txExecute(tx,
      `INSERT INTO trx_final_qc
        (company_id, qc_no, qc_date, finishing_output_id, bundle_id, io_no, style_id, color_id, size_id,
         inspected_qty, passed_qty, reject_qty, rework_qty, hold_qty, qc_status, inspector_name, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, qcNo, body.qc_date, fo?.id ?? null, b?.id ?? null, src.io_no, src.style_id,
       src.color_id, src.size_id, body.inspected_qty, body.passed_qty, body.reject_qty,
       body.rework_qty, body.hold_qty, status, body.inspector_name ?? null, body.remarks ?? null, req.user!.id]);
    let bundleStatus: string | null = null;
    if (b) {
      const after = await applyBundle(tx, b, { qc_pass_qty: body.passed_qty, qc_reject_qty: body.reject_qty });
      bundleStatus = after.status;
      await addMovement(tx, req, b, {
        txn_type: 'FINAL_QC', from_stage: b.status, to_stage: after.status, qty: body.inspected_qty,
        good: body.passed_qty, reject: body.reject_qty, rework: body.rework_qty,
        location: 'FINAL_QC', ref_table: 'trx_final_qc', ref_id: r.insertId,
        remarks: [status, body.hold_qty ? `hold ${body.hold_qty}` : '', body.remarks ?? ''].filter(Boolean).join(' · ').slice(0, 255),
      });
    }
    const row = await txQueryOne(tx, `SELECT * FROM trx_final_qc WHERE id = ?`, [r.insertId]);
    await audit(req, 'trx_final_qc', r.insertId, 'INSERT', undefined, row, tx);
    return { ...row, bundle_status: bundleStatus };
  });
  res.status(201).json({ data: result });
}));

// ============================================================
// CARTON ← BUNDLE (doc §23). Packing UI: POST /cartons/:id/bundles
// { items: [{ bundle_id | barcode, qty? }] }  or  { bundle_ids: [...] } / { barcodes: [...] }
// qty defaults to the bundle's PCS ready to pack.
// ============================================================
productionFloorRouter.get('/cartons/:id/bundles', requirePermission('PACKING.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const id = Number(req.params.id);
  const carton = await queryOne(
    `SELECT ct.id, ct.carton_no, p.pack_no FROM trx_carton ct JOIN trx_packing p ON p.id = ct.packing_id
      WHERE ct.id = ? AND p.company_id = ?`, [id, cid]);
  if (!carton) throw NotFound('Carton not found');
  const rows = await query(
    `SELECT ctb.id, ctb.bundle_id, ctb.qty, ctb.created_at, cb.bundle_no, cb.barcode, cb.status,
            st.style_code, col.color_name, sz.size_code
       FROM trx_carton_bundle ctb JOIN trx_cutting_bundle cb ON cb.id = ctb.bundle_id
       LEFT JOIN mst_style st ON st.id = cb.style_id
       LEFT JOIN mst_color col ON col.id = cb.color_id
       LEFT JOIN mst_size sz ON sz.id = cb.size_id
      WHERE ctb.carton_id = ? ORDER BY ctb.id`, [id]);
  res.json({ data: { carton, bundles: rows } });
}));

productionFloorRouter.post('/cartons/:id/bundles', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw BadRequest('Invalid carton id');
  const body = z.object({
    items: z.array(z.object({ ...bundleRef, qty: z.coerce.number().int().positive().nullish() })).default([]),
    bundle_ids: z.array(z.coerce.number().int().positive()).default([]),
    barcodes: z.array(z.string().trim().min(1).max(120)).default([]),
  }).parse(req.body);
  const items = [
    ...body.items,
    ...body.bundle_ids.map((bundle_id) => ({ bundle_id })),
    ...body.barcodes.map((barcode) => ({ barcode })),
  ];
  const result = await transaction((tx) => linkBundlesToCarton(tx, req, id, items));
  res.status(201).json({ data: result });
}));

productionFloorRouter.post('/cartons/:id/bundles/:bundleId/remove', requirePermission('PACKING.UPDATE'), ah(async (req, res) => {
  const { reason } = z.object({ reason: reasonReq }).parse(req.body);
  const result = await transaction((tx) =>
    unlinkBundleFromCarton(tx, req, Number(req.params.id), Number(req.params.bundleId), reason));
  res.json({ data: result });
}));

/** Stage balances of one bundle (lightweight — no trace). */
productionFloorRouter.get('/bundles/:id/balance', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const b = await queryOne<any>(
    `SELECT cb.* FROM trx_cutting_bundle cb LEFT JOIN trx_cutting c ON c.id = cb.cutting_id
      WHERE cb.id = ? AND COALESCE(cb.company_id, c.company_id) = ?`, [Number(req.params.id), cid]);
  if (!b) throw NotFound('Bundle not found');
  res.json({ data: { id: b.id, bundle_no: b.bundle_no, status: b.status, qty: b.qty, avail: bundleAvail(b, await strictQcNoTx(cid)) } });
}));
