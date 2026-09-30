import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { postLedger, UOM_KG } from '../../core/processEngine.js';
import { refreshFabricRollStatus } from '../production/cuttingEngine.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const fabricProcessingRouter = Router();

const fpoSchema = z.object({
  fpo_no: s.nullableStr(50),
  fpo_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.nullableStr(60),
  so_id: s.id(),
  customer_po_no: s.nullableStr(60),
  style_id: s.id(),
  expected_return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  vehicle_no: s.nullableStr(30),
  fabric_id: s.id(),
  sub_process: z.enum([
    'DYEING', 'COMPACTING', 'HEAT_SETTING', 'WASHING', 'PRINTING',
    'RELAX_DRYER', 'TUMBLE_DRYER', 'STENTERING', 'COMMON_PROCESS', 'BITTING_SLITTING'
  ]).default('DYEING'),
  vendor_id: s.id(),
  shade_code: s.nullableStr(80),
  color_name: s.nullableStr(80),
  target_dia: s.nullableStr(40),
  target_gsm: s.nullableStr(40),
  status: z.enum(['DRAFT', 'DISPATCHED', 'IN_PROCESS', 'COMPLETED', 'CANCELLED']).default('DISPATCHED'),
  remarks: s.text(),
  input_rolls: z.array(z.object({
    knitting_roll_id: s.id(),
    // Grey roll from fabric roll stock (knitting program inward).
    fabric_roll_id: s.id(),
    roll_no: s.strReq(60),
    lot_no: s.nullableStr(80),
    weight_kg: z.coerce.number().positive(),
    meters: z.coerce.number().min(0).default(0),
  })).default([]),
});

const outputRollSchema = z.object({
  fpo_id: s.idReq(),
  roll_no: s.strReq(60),
  lot_no: s.strReq(80),
  finish_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dia: s.nullableStr(40),
  gsm: s.nullableStr(40),
  meters: z.coerce.number().min(0).default(0),
  weight_kg: z.coerce.number().positive(),
  shrinkage_length_pct: z.coerce.number().default(0),
  shrinkage_width_pct: z.coerce.number().default(0),
  qc_status: z.enum(['ACCEPTED', 'HOLD', 'REJECTED']).default('ACCEPTED'),
  shade_match: s.str(50).default('PASS'),
  defect_points: z.coerce.number().int().min(0).default(0),
  remarks: s.text(),
});

/** GET /fabric-processing/orders — List process orders */
fabricProcessingRouter.get('/fabric-processing/orders', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id, sub_process, status } = req.query;

  let where = 'WHERE fpo.company_id = ?';
  const params: any[] = [cid];

  if (io_no) {
    where += ' AND fpo.io_no LIKE ?';
    params.push(`%${io_no}%`);
  }
  if (style_id) {
    where += ' AND fpo.style_id = ?';
    params.push(style_id);
  }
  if (sub_process) {
    where += ' AND fpo.sub_process = ?';
    params.push(sub_process);
  }
  if (status) {
    where += ' AND fpo.status = ?';
    params.push(status);
  }

  const rows = await query(
    `SELECT fpo.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            p.party_name AS vendor_name,
            COUNT(DISTINCT fpri.id) AS total_input_rolls_count,
            COALESCE(SUM(DISTINCT fpri.weight_kg), 0) AS total_input_weight_calc,
            COALESCE(SUM(DISTINCT fpro.weight_kg), 0) AS total_output_weight_calc,
            COUNT(DISTINCT fpro.id) AS total_output_rolls_count
       FROM trx_fabric_process_order fpo
       LEFT JOIN mst_style st ON st.id = fpo.style_id
       LEFT JOIN mst_fabric fab ON fab.id = fpo.fabric_id
       LEFT JOIN mst_party p ON p.id = fpo.vendor_id
       LEFT JOIN trx_fabric_process_roll_in fpri ON fpri.fpo_id = fpo.id
       LEFT JOIN trx_fabric_process_roll_out fpro ON fpro.fpo_id = fpo.id
      ${where}
      GROUP BY fpo.id
      ORDER BY fpo.id DESC`,
    params
  );

  res.json({ success: true, data: rows });
}));

/** GET /fabric-processing/orders/:id — Detail with input rolls and output rolls */
fabricProcessingRouter.get('/fabric-processing/orders/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const order = await queryOne(
    `SELECT fpo.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            p.party_name AS vendor_name
       FROM trx_fabric_process_order fpo
       LEFT JOIN mst_style st ON st.id = fpo.style_id
       LEFT JOIN mst_fabric fab ON fab.id = fpo.fabric_id
       LEFT JOIN mst_party p ON p.id = fpo.vendor_id
      WHERE fpo.id = ? AND fpo.company_id = ?`,
    [req.params.id, cid]
  );

  if (!order) throw NotFound('Fabric process work order not found');

  const inputRolls = await query(
    `SELECT fpri.*
       FROM trx_fabric_process_roll_in fpri
      WHERE fpri.fpo_id = ?
      ORDER BY fpri.id ASC`,
    [order.id]
  );

  const outputRolls = await query(
    `SELECT fpro.*, fab.fabric_name
       FROM trx_fabric_process_roll_out fpro
       LEFT JOIN mst_fabric fab ON fab.id = fpro.fabric_id
      WHERE fpro.fpo_id = ?
      ORDER BY fpro.id ASC`,
    [order.id]
  );

  const totalInputWeight = inputRolls.reduce((sum: number, r: any) => sum + Number(r.weight_kg || 0), 0);
  const totalOutputWeight = outputRolls.reduce((sum: number, r: any) => sum + Number(r.weight_kg || 0), 0);
  const lossKg = Math.max(0, totalInputWeight - totalOutputWeight);
  const lossPct = totalInputWeight > 0 ? (lossKg / totalInputWeight) * 100 : 0;

  res.json({
    success: true,
    data: {
      ...order,
      input_rolls: inputRolls,
      output_rolls: outputRolls,
      summary: {
        total_input_rolls: inputRolls.length,
        total_input_weight_kg: totalInputWeight,
        total_output_rolls: outputRolls.length,
        total_output_weight_kg: totalOutputWeight,
        process_loss_kg: lossKg,
        process_loss_pct: Number(lossPct.toFixed(2)),
      }
    }
  });
}));

/**
 * POST /fabric-processing/orders — Processing DC (outward): rolls from STORE stock (fabric GRN,
 * knitting inward or an earlier processing receipt) go to the dyer / washer / printer.
 * Each roll may be sent in full or in part (KG); store stock goes down (issued_kg + a stock
 * ledger ISSUE), and the KG stays "at the processor" until it is received back.
 */
fabricProcessingRouter.post('/fabric-processing/orders', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = fpoSchema.parse(req.body);
  if (!body.input_rolls.length) throw BadRequest('Pick the rolls to send for processing');
  if (!body.vendor_id) throw BadRequest('Choose the processor (dyer / washer / printer)');

  const totalInputWeight = body.input_rolls.reduce((sum, r) => sum + r.weight_kg, 0);

  const result = await transaction(async (tx) => {
    const fpoNo = body.fpo_no || await nextDocNumber(tx, cid, 'FPO');
    // Job: the SO picked on the DC, else the IO typed (or STOCK)
    let ioNo = body.io_no || null;
    if (body.so_id) {
      const so = await txQueryOne<any>(tx, 'SELECT COALESCE(io_no, so_no) AS job FROM trx_sales_order WHERE id = ? AND company_id = ?', [body.so_id, cid]);
      if (!so) throw BadRequest('Job not found');
      ioNo = so.job;
    }

    const resOrder = await txExecute(
      tx,
      `INSERT INTO trx_fabric_process_order
         (company_id, fpo_no, fpo_date, io_no, so_id, customer_po_no, style_id, fabric_id, sub_process, vendor_id,
          shade_code, color_name, target_dia, target_gsm, total_input_rolls, input_weight_kg,
          expected_return_date, vehicle_no, status, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, fpoNo, body.fpo_date, ioNo || 'STOCK', body.so_id ?? null, body.customer_po_no ?? null, body.style_id ?? null,
        body.fabric_id ?? null, body.sub_process, body.vendor_id ?? null, body.shade_code ?? null,
        body.color_name ?? null, body.target_dia ?? null, body.target_gsm ?? null,
        body.input_rolls.length, totalInputWeight, body.expected_return_date ?? null, body.vehicle_no ?? null,
        'DISPATCHED', body.remarks ?? null, uid
      ]
    );

    const fpoId = resOrder.insertId;
    const seen = new Set<number>();

    for (const roll of body.input_rolls) {
      let warehouseId: number | null = null;
      if (roll.fabric_roll_id) {
        if (seen.has(roll.fabric_roll_id)) throw BadRequest(`Roll ${roll.roll_no} is on the DC twice`);
        seen.add(roll.fabric_roll_id);
        const fr = await txQueryOne<any>(
          tx,
          `SELECT id, roll_no, fabric_id, weight_kg, issued_kg, qc_status, stock_status, warehouse_id
             FROM trx_fabric_roll WHERE id = ? AND company_id = ? FOR UPDATE`,
          [roll.fabric_roll_id, cid]
        );
        if (!fr) throw BadRequest(`Roll ${roll.roll_no} not found in roll stock`);
        if (fr.qc_status !== 'ACCEPTED') throw BadRequest(`Roll ${fr.roll_no} is not QC accepted (${fr.qc_status})`);
        if (fr.stock_status === 'CLOSED') throw BadRequest(`Roll ${fr.roll_no} is closed`);
        if (body.fabric_id && fr.fabric_id && Number(fr.fabric_id) !== Number(body.fabric_id)) {
          throw BadRequest(`Roll ${fr.roll_no} is a different fabric than the DC`);
        }
        const avail = Number(fr.weight_kg || 0) - Number(fr.issued_kg || 0);
        if (roll.weight_kg > avail + 1e-9) {
          throw BadRequest(`Roll ${fr.roll_no} has only ${avail.toFixed(3)} KG in store`);
        }
        warehouseId = fr.warehouse_id ? Number(fr.warehouse_id) : null;
        await txExecute(tx, `UPDATE trx_fabric_roll SET issued_kg = COALESCE(issued_kg, 0) + ? WHERE id = ?`, [roll.weight_kg, roll.fabric_roll_id]);
        await refreshFabricRollStatus(tx, roll.fabric_roll_id);
        if (warehouseId) {
          await postLedger(tx, {
            companyId: cid, warehouseId, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || body.fabric_id || null,
            txnType: 'ISSUE', refType: 'FAB_PROC_DC', refId: fpoId, qtyOut: roll.weight_kg, uomId: UOM_KG, createdBy: uid,
          });
        }
      }

      await txExecute(
        tx,
        `INSERT INTO trx_fabric_process_roll_in (fpo_id, knitting_roll_id, fabric_roll_id, roll_no, lot_no, weight_kg, meters, warehouse_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [fpoId, roll.knitting_roll_id || null, roll.fabric_roll_id || null, roll.roll_no, roll.lot_no ?? null, roll.weight_kg, roll.meters, warehouseId]
      );

      if (roll.knitting_roll_id) {
        await txExecute(
          tx,
          `UPDATE trx_knitting_roll_output SET is_dispatched_to_process = 1 WHERE id = ?`,
          [roll.knitting_roll_id]
        );
      }
    }

    return { id: fpoId, fpo_no: fpoNo };
  });

  await audit(req, 'trx_fabric_process_order', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/**
 * GET /fabric-processing/store-rolls — rolls in the store that can be sent for processing:
 * every QC-accepted roll with KG left (fabric GRN, knitting inward, earlier processing).
 */
fabricProcessingRouter.get('/fabric-processing/store-rolls', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const q = z.object({
    fabric_id: z.coerce.number().int().positive().optional(),
    io_no: z.string().trim().max(60).optional(),
    state: z.string().trim().max(20).optional(),
    q: z.string().trim().max(60).optional(),
  }).parse(req.query);
  const where = [`fr.company_id = ?`, `fr.qc_status = 'ACCEPTED'`, `fr.stock_status <> 'CLOSED'`,
    `COALESCE(fr.weight_kg, 0) - COALESCE(fr.issued_kg, 0) > 0.0005`];
  const params: unknown[] = [cid];
  if (q.fabric_id) { where.push('fr.fabric_id = ?'); params.push(q.fabric_id); }
  if (q.io_no) { where.push('g.internal_ir_no = ?'); params.push(q.io_no); }
  if (q.state) { where.push('fr.process_state = ?'); params.push(q.state); }
  if (q.q) { where.push('(fr.roll_no LIKE ? OR fr.lot_no LIKE ? OR g.grn_no LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const rows = await query<any>(
    `SELECT fr.id, fr.roll_no, fr.lot_no, fr.fabric_id, fb.fabric_name, fb.fabric_code,
            fr.meters, fr.weight_kg, COALESCE(fr.issued_kg, 0) AS issued_kg,
            ROUND(COALESCE(fr.weight_kg, 0) - COALESCE(fr.issued_kg, 0), 3) AS balance_kg,
            fr.gsm, fr.dia, fr.shade, fr.color_name, fr.process_state, fr.stock_status,
            fr.warehouse_id, w.warehouse_name, g.grn_no, g.grn_date, g.internal_ir_no AS io_no
       FROM trx_fabric_roll fr
       JOIN trx_grn g ON g.id = fr.grn_id
       LEFT JOIN mst_fabric fb ON fb.id = fr.fabric_id
       LEFT JOIN mst_warehouse w ON w.id = fr.warehouse_id
      WHERE ${where.join(' AND ')}
      ORDER BY g.grn_date DESC, fr.id DESC
      LIMIT 2000`, params);
  res.json({ data: rows.map((r) => ({ ...r, balance_kg: Number(r.balance_kg), weight_kg: Number(r.weight_kg), meters: Number(r.meters) || 0 })) });
}));

const PROCESS_STATE: Record<string, string> = {
  DYEING: 'DYED', PRINTING: 'PRINTED', WASHING: 'WASHED', COMPACTING: 'COMPACTED', HEAT_SETTING: 'FINISHED',
  RELAX_DRYER: 'FINISHED', TUMBLE_DRYER: 'FINISHED', STENTERING: 'FINISHED', COMMON_PROCESS: 'FINISHED', BITTING_SLITTING: 'FINISHED',
};

const receiveSchema = z.object({
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  party_dc_no: s.strReq(60),
  warehouse_id: s.idReq(),
  vehicle_no: s.nullableStr(30),
  color_name: s.nullableStr(80),
  /** Close the DC: whatever KG is still at the processor is written off as process loss. */
  complete: z.coerce.boolean().default(false),
  remarks: s.text(),
  rolls: z.array(z.object({
    roll_no: s.nullableStr(60),
    lot_no: s.nullableStr(80),
    weight_kg: z.coerce.number().positive(),
    meters: z.coerce.number().min(0).default(0),
    dia: s.nullableStr(40),
    gsm: s.nullableStr(40),
    shrinkage_length_pct: z.coerce.number().default(0),
    shrinkage_width_pct: z.coerce.number().default(0),
    qc_status: z.enum(['ACCEPTED', 'HOLD', 'REJECTED']).default('ACCEPTED'),
    shade_match: s.str(50).default('PASS'),
    defect_points: z.coerce.number().int().min(0).default(0),
    remarks: s.text(),
  })).min(1),
});

/**
 * POST /fabric-processing/orders/:id/receive — processed fabric back from the processor.
 * Creates a GRN (supplier = processor) and one STORE roll per received roll (state DYED /
 * WASHED / PRINTED …, with its colour), posts the stock ledger, and records the output
 * rolls on the DC. Fabric issue to cutting then picks these rolls up like any other.
 */
fabricProcessingRouter.post('/fabric-processing/orders/:id/receive', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = receiveSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const fpo = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!fpo) throw NotFound('Processing DC not found');
    if (['CANCELLED', 'COMPLETED'].includes(fpo.status)) throw BadRequest(`Processing DC ${fpo.fpo_no} is ${fpo.status}`);
    const sent = await txQuery<any>(tx, 'SELECT * FROM trx_fabric_process_roll_in WHERE fpo_id = ? ORDER BY id', [id]);
    const fabricId = Number(fpo.fabric_id) || null;
    const srcFabric = fabricId ?? (sent[0]?.fabric_roll_id
      ? Number((await txQueryOne<any>(tx, 'SELECT fabric_id FROM trx_fabric_roll WHERE id = ?', [sent[0].fabric_roll_id]))?.fabric_id) || null : null);
    if (!srcFabric) throw BadRequest('The DC has no fabric — cannot post processed fabric to stock');

    const sentKg = sent.reduce((a, r) => a + Number(r.weight_kg || 0), 0);
    const prevOut = Number((await txQueryOne<any>(tx, 'SELECT COALESCE(SUM(weight_kg), 0) AS kg FROM trx_fabric_process_roll_out WHERE fpo_id = ?', [id]))?.kg) || 0;
    const nowKg = body.rolls.reduce((a, r) => a + r.weight_kg, 0);
    // Dyeing can add a little weight (moisture / chemicals) — allow up to 10 % over what was sent
    if (prevOut + nowKg > sentKg * 1.1 + 1e-6) {
      throw BadRequest(`Received ${(prevOut + nowKg).toFixed(3)} KG is more than the ${sentKg.toFixed(3)} KG sent on ${fpo.fpo_no} (+10 %)`);
    }

    const state = PROCESS_STATE[fpo.sub_process] || 'FINISHED';
    const colour = body.color_name || fpo.color_name || null;
    const receiptNo = await nextDocNumber(tx, cid, 'GRN');
    const lotBase = `${fpo.fpo_no}-${receiptNo}`;
    const acceptedKg = body.rolls.filter((r) => r.qc_status === 'ACCEPTED').reduce((a, r) => a + r.weight_kg, 0);
    const rejectedKg = body.rolls.filter((r) => r.qc_status === 'REJECTED').reduce((a, r) => a + r.weight_kg, 0);

    const g = await txExecute(tx,
      `INSERT INTO trx_grn
         (company_id, grn_no, internal_ir_no, grn_date, style_id, supplier_id, warehouse_id,
          supplier_dc_no, vehicle_no, qc_status, remarks, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [cid, receiptNo, fpo.io_no ?? null, body.receipt_date, fpo.style_id ?? null, fpo.vendor_id ?? null,
       body.warehouse_id, body.party_dc_no, body.vehicle_no ?? null, rejectedKg > 0 && acceptedKg > 0 ? 'PARTIAL_ACCEPTED' : acceptedKg > 0 ? 'ACCEPTED' : 'HOLD',
       `Processed fabric (${fpo.sub_process}) back on ${fpo.fpo_no}, party DC ${body.party_dc_no}`, uid]);
    const grnId = g.insertId;
    const gl = await txExecute(tx,
      `INSERT INTO trx_grn_line
         (grn_id, so_id, style_id, material_type, fabric_id, fabric_category, color_name, lot_no, qc_status,
          received_qty, received_weight, no_of_rolls, accepted_qty, rejected_qty, balance_qty, uom_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [grnId, fpo.so_id ?? null, fpo.style_id ?? null, 'FABRIC', srcFabric, state === 'DYED' ? 'Dyed Fabric' : 'Grey Fabric', colour,
       lotBase, rejectedKg > 0 && acceptedKg > 0 ? 'PARTIAL_ACCEPTED' : acceptedKg > 0 ? 'ACCEPTED' : 'HOLD',
       nowKg, nowKg, body.rolls.length, acceptedKg, rejectedKg, 0, UOM_KG]);
    const grnLineId = gl.insertId;

    const rolls = [];
    for (let i = 0; i < body.rolls.length; i++) {
      const r = body.rolls[i];
      const rollNo = r.roll_no || `${receiptNo}-${String(i + 1).padStart(2, '0')}`;
      const lotNo = r.lot_no || lotBase;
      const fr = await txExecute(tx,
        `INSERT INTO trx_fabric_roll
           (company_id, grn_id, grn_line_id, fabric_id, roll_no, lot_no, meters, weight_kg, gsm, dia, shade,
            warehouse_id, qc_status, stock_status, remarks, process_state, color_name, source_fpo_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, grnId, grnLineId, srcFabric, rollNo, lotNo, r.meters || null, r.weight_kg,
         Number.parseInt(String(r.gsm ?? fpo.target_gsm ?? ''), 10) || null, r.dia ?? fpo.target_dia ?? null,
         fpo.shade_code ?? colour, body.warehouse_id, r.qc_status === 'REJECTED' ? 'REJECTED' : r.qc_status === 'HOLD' ? 'HOLD' : 'ACCEPTED',
         r.qc_status === 'ACCEPTED' ? 'AVAILABLE' : 'RESERVED', `${state} on ${fpo.fpo_no}`, state, colour, id]);
      await txExecute(tx,
        `INSERT INTO trx_fabric_process_roll_out
           (company_id, fpo_id, roll_no, lot_no, io_no, style_id, fabric_id, finish_date, dia, gsm, meters, weight_kg,
            shrinkage_length_pct, shrinkage_width_pct, qc_status, shade_match, defect_points, remarks,
            fabric_roll_id, grn_id, party_dc_no)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid, id, rollNo, lotNo, fpo.io_no || 'STOCK', fpo.style_id ?? null, srcFabric, body.receipt_date,
         r.dia ?? fpo.target_dia ?? null, r.gsm ?? fpo.target_gsm ?? null, r.meters, r.weight_kg,
         r.shrinkage_length_pct, r.shrinkage_width_pct, r.qc_status, r.shade_match, r.defect_points, r.remarks ?? null,
         fr.insertId, grnId, body.party_dc_no]);
      rolls.push({ id: fr.insertId, roll_no: rollNo, weight_kg: r.weight_kg, qc_status: r.qc_status });
    }

    if (acceptedKg > 0) {
      await postLedger(tx, {
        companyId: cid, warehouseId: body.warehouse_id, materialType: 'FABRIC', fabricId: srcFabric,
        txnType: 'PRODUCTION_IN', refType: 'FAB_PROC_RECEIPT', refId: grnId, qtyIn: acceptedKg, uomId: UOM_KG, createdBy: uid,
      });
    }

    const outKg = prevOut + nowKg;
    const lossKg = Math.max(0, sentKg - outKg);
    const lossPct = sentKg > 0 ? (lossKg / sentKg) * 100 : 0;
    await txExecute(tx,
      `UPDATE trx_fabric_process_order
          SET output_weight_kg = ?, process_loss_kg = ?, process_loss_pct = ?, status = ?
        WHERE id = ?`,
      [outKg, lossKg, lossPct, body.complete ? 'COMPLETED' : 'IN_PROCESS', id]);

    return { grn_id: grnId, grn_no: receiptNo, fpo_no: fpo.fpo_no, received_kg: nowKg, accepted_kg: acceptedKg,
             sent_kg: sentKg, total_received_kg: outKg, pending_kg: Math.max(0, sentKg - outKg), loss_pct: Number(lossPct.toFixed(2)),
             status: body.complete ? 'COMPLETED' : 'IN_PROCESS', process_state: state, rolls };
  });

  await audit(req, 'trx_fabric_process_order', id, 'UPDATE', undefined, { receive: result });
  res.status(201).json({ success: true, data: result });
}));

/** POST /fabric-processing/orders/:id/cancel — only while nothing came back: rolls return to the store. */
fabricProcessingRouter.post('/fabric-processing/orders/:id/cancel', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const out = await transaction(async (tx) => {
    const fpo = await txQueryOne<any>(tx, 'SELECT * FROM trx_fabric_process_order WHERE id = ? AND company_id = ? FOR UPDATE', [id, cid]);
    if (!fpo) throw NotFound('Processing DC not found');
    if (fpo.status === 'CANCELLED') throw BadRequest(`Processing DC ${fpo.fpo_no} is already cancelled`);
    const recd = await txQueryOne<any>(tx, 'SELECT COUNT(*) AS n FROM trx_fabric_process_roll_out WHERE fpo_id = ?', [id]);
    if (Number(recd?.n) > 0) throw BadRequest(`${fpo.fpo_no} already has processed fabric received — it cannot be cancelled`);
    const sent = await txQuery<any>(tx, 'SELECT * FROM trx_fabric_process_roll_in WHERE fpo_id = ?', [id]);
    let returned = 0;
    for (const r of sent) {
      if (!r.fabric_roll_id) continue;
      const fr = await txQueryOne<any>(tx, 'SELECT id, fabric_id, warehouse_id FROM trx_fabric_roll WHERE id = ? FOR UPDATE', [r.fabric_roll_id]);
      if (!fr) continue;
      await txExecute(tx, 'UPDATE trx_fabric_roll SET issued_kg = GREATEST(COALESCE(issued_kg, 0) - ?, 0) WHERE id = ?', [r.weight_kg, fr.id]);
      await refreshFabricRollStatus(tx, fr.id, { reopen: true });
      const wh = Number(r.warehouse_id || fr.warehouse_id) || 0;
      if (wh) {
        await postLedger(tx, {
          companyId: cid, warehouseId: wh, materialType: 'FABRIC', fabricId: Number(fr.fabric_id) || null,
          txnType: 'RETURN', refType: 'FAB_PROC_DC_CANCEL', refId: id, qtyIn: Number(r.weight_kg), uomId: UOM_KG, createdBy: uid,
        });
      }
      returned += Number(r.weight_kg);
    }
    await txExecute(tx, `UPDATE trx_fabric_process_order SET status = 'CANCELLED' WHERE id = ?`, [id]);
    return { fpo_no: fpo.fpo_no, returned_kg: returned };
  });
  await audit(req, 'trx_fabric_process_order', id, 'UPDATE', undefined, { cancel: out });
  res.json({ success: true, data: out, message: `${out.fpo_no} cancelled — ${out.returned_kg.toFixed(3)} KG back in store` });
}));

/** PUT /fabric-processing/orders/:id — Update order */
fabricProcessingRouter.put('/fabric-processing/orders/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = fpoSchema.partial().parse(req.body);

  const existing = await queryOne('SELECT id FROM trx_fabric_process_order WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!existing) throw NotFound('Process order not found');
  // Cancel / complete go through their own actions (stock is returned / received there)
  if (body.status === 'CANCELLED') throw BadRequest('Use Cancel DC — it returns the rolls to the store');
  if (body.status === 'COMPLETED') throw BadRequest('Receive the processed fabric (tick "complete") to close the DC');

  await query(
    `UPDATE trx_fabric_process_order
        SET fpo_date = COALESCE(?, fpo_date),
            io_no = COALESCE(?, io_no),
            customer_po_no = COALESCE(?, customer_po_no),
            style_id = COALESCE(?, style_id),
            fabric_id = COALESCE(?, fabric_id),
            sub_process = COALESCE(?, sub_process),
            vendor_id = COALESCE(?, vendor_id),
            shade_code = COALESCE(?, shade_code),
            color_name = COALESCE(?, color_name),
            target_dia = COALESCE(?, target_dia),
            target_gsm = COALESCE(?, target_gsm),
            status = COALESCE(?, status),
            remarks = COALESCE(?, remarks)
      WHERE id = ? AND company_id = ?`,
    [
      body.fpo_date, body.io_no, body.customer_po_no, body.style_id, body.fabric_id, body.sub_process, body.vendor_id,
      body.shade_code, body.color_name, body.target_dia, body.target_gsm, body.status, body.remarks,
      req.params.id, cid
    ]
  );

  await audit(req, 'trx_fabric_process_order', Number(req.params.id), 'UPDATE', existing, body);
  res.json({ success: true, message: 'Process order updated' });
}));

/** POST /fabric-processing/rolls — Record output roll */
fabricProcessingRouter.post('/fabric-processing/rolls', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = outputRollSchema.parse(req.body);

  const order = await queryOne(
    'SELECT id, io_no, style_id, fabric_id, input_weight_kg FROM trx_fabric_process_order WHERE id = ? AND company_id = ?',
    [body.fpo_id, cid]
  );
  if (!order) throw NotFound('Process order not found');

  const result = await transaction(async (tx) => {
    const resIns = await txExecute(
      tx,
      `INSERT INTO trx_fabric_process_roll_out
         (company_id, fpo_id, roll_no, lot_no, io_no, style_id, fabric_id, finish_date,
          dia, gsm, meters, weight_kg, shrinkage_length_pct, shrinkage_width_pct,
          qc_status, shade_match, defect_points, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, body.fpo_id, body.roll_no, body.lot_no, order.io_no, order.style_id, order.fabric_id,
        body.finish_date, body.dia, body.gsm, body.meters, body.weight_kg,
        body.shrinkage_length_pct, body.shrinkage_width_pct, body.qc_status,
        body.shade_match, body.defect_points, body.remarks
      ]
    );

    // Recalculate output weight and process loss on order
    const rolls = await query('SELECT weight_kg FROM trx_fabric_process_roll_out WHERE fpo_id = ?', [body.fpo_id]);
    const totOutput = rolls.reduce((acc: number, r: any) => acc + Number(r.weight_kg || 0), 0);
    const inputKg = Number(order.input_weight_kg || 0);
    const lossKg = Math.max(0, inputKg - totOutput);
    const lossPct = inputKg > 0 ? (lossKg / inputKg) * 100 : 0;

    await txExecute(
      tx,
      `UPDATE trx_fabric_process_order
          SET output_weight_kg = ?, process_loss_kg = ?, process_loss_pct = ?,
              status = IF(status = 'DISPATCHED', 'IN_PROCESS', status)
        WHERE id = ?`,
      [totOutput, lossKg, lossPct, body.fpo_id]
    );

    return { id: resIns.insertId, roll_no: body.roll_no };
  });

  await audit(req, 'trx_fabric_process_roll_out', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** DELETE /fabric-processing/rolls/:id */
fabricProcessingRouter.delete('/fabric-processing/rolls/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const roll = await queryOne('SELECT id, fpo_id, is_issued_to_cutting FROM trx_fabric_process_roll_out WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!roll) throw NotFound('Output roll not found');
  if (roll.is_issued_to_cutting) throw BadRequest('Cannot delete roll already issued to cutting');

  await query('DELETE FROM trx_fabric_process_roll_out WHERE id = ?', [req.params.id]);

  // Recalculate
  const order = await queryOne('SELECT input_weight_kg FROM trx_fabric_process_order WHERE id = ?', [roll.fpo_id]);
  const rolls = await query('SELECT weight_kg FROM trx_fabric_process_roll_out WHERE fpo_id = ?', [roll.fpo_id]);
  const totOutput = rolls.reduce((acc: number, r: any) => acc + Number(r.weight_kg || 0), 0);
  const inputKg = Number(order?.input_weight_kg || 0);
  const lossKg = Math.max(0, inputKg - totOutput);
  const lossPct = inputKg > 0 ? (lossKg / inputKg) * 100 : 0;

  await query(
    `UPDATE trx_fabric_process_order SET output_weight_kg = ?, process_loss_kg = ?, process_loss_pct = ? WHERE id = ?`,
    [totOutput, lossKg, lossPct, roll.fpo_id]
  );

  await audit(req, 'trx_fabric_process_roll_out', Number(req.params.id), 'DELETE', roll);
  res.json({ success: true, message: 'Output roll removed' });
}));

/** GET /fabric-processing/available-rolls — Accepted rolls ready for Cutting Issue */
fabricProcessingRouter.get('/fabric-processing/available-rolls', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id } = req.query;

  let where = `WHERE fpro.company_id = ? AND fpro.qc_status = 'ACCEPTED' AND fpro.is_issued_to_cutting = 0`;
  const params: any[] = [cid];

  if (io_no) {
    where += ' AND fpro.io_no = ?';
    params.push(io_no);
  }
  if (style_id) {
    where += ' AND fpro.style_id = ?';
    params.push(style_id);
  }

  const rows = await query(
    `SELECT fpro.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            fpo.fpo_no, fpo.sub_process, fpo.color_name, fpo.shade_code
       FROM trx_fabric_process_roll_out fpro
       JOIN trx_fabric_process_order fpo ON fpo.id = fpro.fpo_id
       LEFT JOIN mst_style st ON st.id = fpro.style_id
       LEFT JOIN mst_fabric fab ON fab.id = fpro.fabric_id
      ${where}
      ORDER BY fpro.id DESC`,
    params
  );

  res.json({ success: true, data: rows });
}));
