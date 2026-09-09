import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import { s } from '../resources/schemas.js';

export const knittingRouter = Router();

const kwoSchema = z.object({
  kwo_no: s.nullableStr(50),
  kwo_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  io_no: s.strReq(60),
  customer_po_no: s.nullableStr(60),
  style_id: s.id(),
  sub_process: z.enum(['KNITTING', 'WINDING', 'TWISTING', 'YARN_DYEING', 'COLLAR_KNITTING']).default('KNITTING'),
  vendor_id: s.id(),
  fabric_id: s.id(),
  dia: s.nullableStr(40),
  gsm: s.nullableStr(40),
  gauge: s.nullableStr(40),
  loop_length: s.nullableStr(40),
  planned_fabric_kg: z.coerce.number().min(0).default(0),
  planned_yarn_kg: z.coerce.number().min(0).default(0),
  yarn_lot_no: s.nullableStr(80),
  status: z.enum(['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).default('DRAFT'),
  remarks: s.text(),
});

const yarnIssueSchema = z.object({
  kwo_id: s.idReq(),
  issue_no: s.nullableStr(50),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  yarn_id: s.idReq(),
  yarn_lot_no: s.nullableStr(80),
  bags_cones: z.coerce.number().int().min(0).default(0),
  issued_weight_kg: z.coerce.number().positive(),
  remarks: s.text(),
});

const rollOutputSchema = z.object({
  kwo_id: s.idReq(),
  roll_no: s.strReq(60),
  lot_no: s.strReq(80),
  production_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dia: s.nullableStr(40),
  gsm: s.nullableStr(40),
  meters: z.coerce.number().min(0).default(0),
  weight_kg: z.coerce.number().positive(),
  qc_status: z.enum(['ACCEPTED', 'HOLD', 'REJECTED']).default('ACCEPTED'),
  defect_points: z.coerce.number().int().min(0).default(0),
  rejection_reason: s.nullableStr(255),
});

/** GET /knitting/orders — List all Knitting Work Orders */
knittingRouter.get('/knitting/orders', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id, sub_process, status } = req.query;

  let where = 'WHERE ko.company_id = ?';
  const params: any[] = [cid];

  if (io_no) {
    where += ' AND ko.io_no LIKE ?';
    params.push(`%${io_no}%`);
  }
  if (style_id) {
    where += ' AND ko.style_id = ?';
    params.push(style_id);
  }
  if (sub_process) {
    where += ' AND ko.sub_process = ?';
    params.push(sub_process);
  }
  if (status) {
    where += ' AND ko.status = ?';
    params.push(status);
  }

  const rows = await query(
    `SELECT ko.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            p.party_name AS vendor_name,
            COALESCE(SUM(DISTINCT kyi.issued_weight_kg), 0) AS total_yarn_issued_kg,
            COALESCE(SUM(DISTINCT kro.weight_kg), 0) AS total_fabric_produced_kg,
            COUNT(DISTINCT kro.id) AS total_rolls_count
       FROM trx_knitting_order ko
       LEFT JOIN mst_style st ON st.id = ko.style_id
       LEFT JOIN mst_fabric fab ON fab.id = ko.fabric_id
       LEFT JOIN mst_party p ON p.id = ko.vendor_id
       LEFT JOIN trx_knitting_yarn_issue kyi ON kyi.kwo_id = ko.id
       LEFT JOIN trx_knitting_roll_output kro ON kro.kwo_id = ko.id
      ${where}
      GROUP BY ko.id
      ORDER BY ko.id DESC`,
    params
  );

  res.json({ success: true, data: rows });
}));

/** GET /knitting/orders/:id — Detail with issues and rolls */
knittingRouter.get('/knitting/orders/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const order = await queryOne(
    `SELECT ko.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            p.party_name AS vendor_name
       FROM trx_knitting_order ko
       LEFT JOIN mst_style st ON st.id = ko.style_id
       LEFT JOIN mst_fabric fab ON fab.id = ko.fabric_id
       LEFT JOIN mst_party p ON p.id = ko.vendor_id
      WHERE ko.id = ? AND ko.company_id = ?`,
    [req.params.id, cid]
  );

  if (!order) throw NotFound('Knitting work order not found');

  const yarnIssues = await query(
    `SELECT kyi.*, y.yarn_name, y.yarn_code
       FROM trx_knitting_yarn_issue kyi
       JOIN mst_yarn y ON y.id = kyi.yarn_id
      WHERE kyi.kwo_id = ?
      ORDER BY kyi.id ASC`,
    [order.id]
  );

  const rollOutputs = await query(
    `SELECT kro.*, fab.fabric_name
       FROM trx_knitting_roll_output kro
       LEFT JOIN mst_fabric fab ON fab.id = kro.fabric_id
      WHERE kro.kwo_id = ?
      ORDER BY kro.id ASC`,
    [order.id]
  );

  const totalYarnIssued = yarnIssues.reduce((sum: number, r: any) => sum + Number(r.issued_weight_kg || 0), 0);
  const totalRollsWeight = rollOutputs.reduce((sum: number, r: any) => sum + Number(r.weight_kg || 0), 0);
  const knittingLossKg = Math.max(0, totalYarnIssued - totalRollsWeight);
  const knittingLossPct = totalYarnIssued > 0 ? (knittingLossKg / totalYarnIssued) * 100 : 0;

  res.json({
    success: true,
    data: {
      ...order,
      yarn_issues: yarnIssues,
      roll_outputs: rollOutputs,
      summary: {
        total_yarn_issued_kg: totalYarnIssued,
        total_rolls_produced_kg: totalRollsWeight,
        total_rolls_count: rollOutputs.length,
        knitting_loss_kg: knittingLossKg,
        knitting_loss_pct: Number(knittingLossPct.toFixed(2)),
      }
    }
  });
}));

/** POST /knitting/orders — Create KWO */
knittingRouter.post('/knitting/orders', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = kwoSchema.parse(req.body);

  const result = await transaction(async (tx) => {
    const kwoNo = body.kwo_no || await nextDocNumber(tx, cid, 'KWO');

    const resOrder = await txExecute(
      tx,
      `INSERT INTO trx_knitting_order
         (company_id, kwo_no, kwo_date, io_no, customer_po_no, style_id, sub_process, vendor_id, fabric_id,
          dia, gsm, gauge, loop_length, planned_fabric_kg, planned_yarn_kg, yarn_lot_no, status, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, kwoNo, body.kwo_date, body.io_no, body.customer_po_no, body.style_id, body.sub_process, body.vendor_id, body.fabric_id,
        body.dia, body.gsm, body.gauge, body.loop_length, body.planned_fabric_kg, body.planned_yarn_kg,
        body.yarn_lot_no, body.status, body.remarks, uid
      ]
    );

    return { id: resOrder.insertId, kwo_no: kwoNo };
  });

  await audit(req, 'trx_knitting_order', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** PUT /knitting/orders/:id — Update KWO */
knittingRouter.put('/knitting/orders/:id', requirePermission('PRODUCTION.UPDATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = kwoSchema.partial().parse(req.body);

  const existing = await queryOne('SELECT id, kwo_no FROM trx_knitting_order WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!existing) throw NotFound('Knitting work order not found');

  await query(
    `UPDATE trx_knitting_order
        SET kwo_date = COALESCE(?, kwo_date),
            io_no = COALESCE(?, io_no),
            customer_po_no = COALESCE(?, customer_po_no),
            style_id = COALESCE(?, style_id),
            sub_process = COALESCE(?, sub_process),
            vendor_id = COALESCE(?, vendor_id),
            fabric_id = COALESCE(?, fabric_id),
            dia = COALESCE(?, dia),
            gsm = COALESCE(?, gsm),
            gauge = COALESCE(?, gauge),
            loop_length = COALESCE(?, loop_length),
            planned_fabric_kg = COALESCE(?, planned_fabric_kg),
            planned_yarn_kg = COALESCE(?, planned_yarn_kg),
            yarn_lot_no = COALESCE(?, yarn_lot_no),
            status = COALESCE(?, status),
            remarks = COALESCE(?, remarks)
      WHERE id = ? AND company_id = ?`,
    [
      body.kwo_date, body.io_no, body.customer_po_no, body.style_id, body.sub_process, body.vendor_id, body.fabric_id,
      body.dia, body.gsm, body.gauge, body.loop_length, body.planned_fabric_kg, body.planned_yarn_kg,
      body.yarn_lot_no, body.status, body.remarks, req.params.id, cid
    ]
  );

  await audit(req, 'trx_knitting_order', Number(req.params.id), 'UPDATE', existing, body);
  res.json({ success: true, message: 'Knitting work order updated' });
}));

/** POST /knitting/yarn-issues — Issue yarn against KWO */
knittingRouter.post('/knitting/yarn-issues', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const uid = req.user!.id;
  const body = yarnIssueSchema.parse(req.body);

  const kwo = await queryOne('SELECT id, io_no FROM trx_knitting_order WHERE id = ? AND company_id = ?', [body.kwo_id, cid]);
  if (!kwo) throw NotFound('Knitting work order not found');

  const result = await transaction(async (tx) => {
    const issueNo = body.issue_no || await nextDocNumber(tx, cid, 'KYI');

    const resIns = await txExecute(
      tx,
      `INSERT INTO trx_knitting_yarn_issue
         (company_id, kwo_id, issue_no, issue_date, yarn_id, yarn_lot_no, bags_cones, issued_weight_kg, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cid, body.kwo_id, issueNo, body.issue_date, body.yarn_id, body.yarn_lot_no, body.bags_cones, body.issued_weight_kg, body.remarks, uid]
    );

    await txExecute(tx, `UPDATE trx_knitting_order SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'DRAFT'`, [body.kwo_id]);
    return { id: resIns.insertId, issue_no: issueNo };
  });

  await audit(req, 'trx_knitting_yarn_issue', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** DELETE /knitting/yarn-issues/:id */
knittingRouter.delete('/knitting/yarn-issues/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const issue = await queryOne('SELECT id, kwo_id FROM trx_knitting_yarn_issue WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!issue) throw NotFound('Yarn issue not found');

  await query('DELETE FROM trx_knitting_yarn_issue WHERE id = ?', [req.params.id]);
  await audit(req, 'trx_knitting_yarn_issue', Number(req.params.id), 'DELETE', issue);
  res.json({ success: true, message: 'Yarn issue removed' });
}));

/** POST /knitting/rolls — Record produced grey rolls */
knittingRouter.post('/knitting/rolls', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const body = rollOutputSchema.parse(req.body);

  const kwo = await queryOne(
    'SELECT id, io_no, style_id, fabric_id FROM trx_knitting_order WHERE id = ? AND company_id = ?',
    [body.kwo_id, cid]
  );
  if (!kwo) throw NotFound('Knitting work order not found');

  const result = await transaction(async (tx) => {
    const resIns = await txExecute(
      tx,
      `INSERT INTO trx_knitting_roll_output
         (company_id, kwo_id, roll_no, lot_no, io_no, style_id, fabric_id, production_date, dia, gsm, meters, weight_kg, qc_status, defect_points, rejection_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cid, body.kwo_id, body.roll_no, body.lot_no, kwo.io_no, kwo.style_id, kwo.fabric_id,
        body.production_date, body.dia, body.gsm, body.meters, body.weight_kg, body.qc_status,
        body.defect_points, body.rejection_reason
      ]
    );

    await txExecute(tx, `UPDATE trx_knitting_order SET status = 'IN_PROGRESS' WHERE id = ? AND status = 'DRAFT'`, [body.kwo_id]);
    return { id: resIns.insertId, roll_no: body.roll_no };
  });

  await audit(req, 'trx_knitting_roll_output', result.id, 'INSERT', undefined, result);
  res.status(201).json({ success: true, data: result });
}));

/** DELETE /knitting/rolls/:id */
knittingRouter.delete('/knitting/rolls/:id', requirePermission('PRODUCTION.DELETE'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const roll = await queryOne('SELECT id, is_dispatched_to_process FROM trx_knitting_roll_output WHERE id = ? AND company_id = ?', [req.params.id, cid]);
  if (!roll) throw NotFound('Roll output not found');
  if (roll.is_dispatched_to_process) throw BadRequest('Cannot delete roll that has already been dispatched to fabric processing');

  await query('DELETE FROM trx_knitting_roll_output WHERE id = ?', [req.params.id]);
  await audit(req, 'trx_knitting_roll_output', Number(req.params.id), 'DELETE', roll);
  res.json({ success: true, message: 'Roll output removed' });
}));

/** GET /knitting/available-grey-rolls — Available for Fabric Processing */
knittingRouter.get('/knitting/available-grey-rolls', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const cid = req.user!.companyId;
  const { io_no, style_id } = req.query;

  let where = `WHERE kro.company_id = ? AND kro.qc_status = 'ACCEPTED' AND kro.is_dispatched_to_process = 0`;
  const params: any[] = [cid];

  if (io_no) {
    where += ' AND kro.io_no = ?';
    params.push(io_no);
  }
  if (style_id) {
    where += ' AND kro.style_id = ?';
    params.push(style_id);
  }

  const rows = await query(
    `SELECT kro.*,
            st.style_code, st.style_name,
            fab.fabric_name, fab.fabric_code,
            ko.kwo_no
       FROM trx_knitting_roll_output kro
       JOIN trx_knitting_order ko ON ko.id = kro.kwo_id
       LEFT JOIN mst_style st ON st.id = kro.style_id
       LEFT JOIN mst_fabric fab ON fab.id = kro.fabric_id
      ${where}
      ORDER BY kro.id DESC`,
    params
  );

  res.json({ success: true, data: rows });
}));
