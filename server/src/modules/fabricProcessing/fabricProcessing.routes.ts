import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
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
  io_no: s.strReq(60),
  style_id: s.id(),
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

/** POST /fabric-processing/orders — Create process order */
fabricProcessingRouter.post('/fabric-processing/orders', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = fpoSchema.parse(req.body);

  const totalInputWeight = body.input_rolls.reduce((sum, r) => sum + r.weight_kg, 0);

  const result = await transaction(async (tx) => {
    const fpoNo = body.fpo_no || await nextDocNumber(tx, cid, 'FPO');

    const resOrder = await txExecute(
      tx,
      `INSERT INTO trx_fabric_process_order
         (company_id, fpo_no, fpo_date, io_no, style_id, fabric_id, sub_process, vendor_id,
          shade_code, color_name, target_dia, target_gsm, total_input_rolls, input_weight_kg,
          status, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, fpoNo, body.fpo_date, body.io_no, body.style_id, body.fabric_id, body.sub_process,
        body.vendor_id, body.shade_code, body.color_name, body.target_dia, body.target_gsm,
        body.input_rolls.length, totalInputWeight, body.status, body.remarks, uid
      ]
    );

    const fpoId = resOrder.insertId;

    for (const roll of body.input_rolls) {
      await txExecute(
        tx,
        `INSERT INTO trx_fabric_process_roll_in (fpo_id, knitting_roll_id, roll_no, lot_no, weight_kg, meters)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [fpoId, roll.knitting_roll_id || null, roll.roll_no, roll.lot_no, roll.weight_kg, roll.meters]
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

/** PUT /fabric-processing/orders/:id — Update order */
fabricProcessingRouter.put('/fabric-processing/orders/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = fpoSchema.partial().parse(req.body);

  const existing = await queryOne('SELECT id FROM trx_fabric_process_order WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!existing) throw NotFound('Process order not found');

  await query(
    `UPDATE trx_fabric_process_order
        SET fpo_date = COALESCE(?, fpo_date),
            io_no = COALESCE(?, io_no),
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
      body.fpo_date, body.io_no, body.style_id, body.fabric_id, body.sub_process, body.vendor_id,
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
