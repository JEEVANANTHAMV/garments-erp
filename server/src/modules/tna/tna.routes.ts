import { Router } from 'express';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';
import {
  loadCalendarConfig,
  scheduleBackward,
  evaluateTnaHealth,
  syncErpEventsToTna,
} from './tna.engine.js';

export const tnaRouter = Router();

/* ==============================================================================
   1. LIST & DASHBOARD ENDPOINTS
   ============================================================================== */

/**
 * GET /api/tna/dashboard
 * Central executive dashboard stats as specified in Section 19.
 */
tnaRouter.get('/dashboard', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;

  const summary = await queryOne<any>(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN shipment_risk = 'ON_TRACK' THEN 1 ELSE 0 END) AS on_track,
      SUM(CASE WHEN shipment_risk = 'AT_RISK' THEN 1 ELSE 0 END) AS at_risk,
      SUM(CASE WHEN shipment_risk = 'CRITICAL' THEN 1 ELSE 0 END) AS critical,
      COALESCE(AVG(completion_percentage), 0) AS avg_completion
    FROM trx_tna_header
    WHERE company_id = ? AND status <> 'CLOSED' AND status <> 'CANCELLED'
  `, [companyId]);

  // Delay by category
  const categoryDelays = await query<any>(`
    SELECT
      a.category,
      COUNT(*) AS delay_count
    FROM trx_tna_activity a
    JOIN trx_tna_header h ON h.id = a.tna_id
    WHERE h.company_id = ? AND h.status <> 'CLOSED'
      AND a.health_status IN ('DELAYED', 'CRITICAL')
    GROUP BY a.category
  `, [companyId]);

  const catMap: Record<string, number> = {};
  for (const c of categoryDelays) {
    catMap[c.category] = Number(c.delay_count);
  }

  // High risk orders watchlist
  const criticalOrders = await query<any>(`
    SELECT
      h.id, h.tna_no, h.shipment_date, h.order_qty, h.completion_percentage,
      h.shipment_risk, h.status,
      b.party_name AS buyer_name,
      st.style_code, st.style_name,
      so.so_no, so.io_no
    FROM trx_tna_header h
    LEFT JOIN mst_party b ON b.id = h.buyer_id
    LEFT JOIN mst_style st ON st.id = h.style_id
    LEFT JOIN trx_sales_order so ON so.id = h.sales_order_id
    WHERE h.company_id = ? AND h.shipment_risk IN ('CRITICAL', 'AT_RISK')
      AND h.status <> 'CLOSED'
    ORDER BY h.shipment_date ASC LIMIT 10
  `, [companyId]);

  res.json({
    data: {
      total_orders: Number(summary?.total_orders || 0),
      on_track: Number(summary?.on_track || 0),
      at_risk: Number(summary?.at_risk || 0),
      critical: Number(summary?.critical || 0),
      avg_completion: Number(Number(summary?.avg_completion || 0).toFixed(1)),
      fabric_delays: catMap['FABRIC'] || 0,
      trim_delays: catMap['TRIM'] || 0,
      sample_delays: catMap['SAMPLING'] || 0,
      production_delays: catMap['PRODUCTION'] || 0,
      shipment_risk_orders: Number(summary?.critical || 0) + Number(summary?.at_risk || 0),
      critical_watchlist: criticalOrders,
    },
  });
}));

/**
 * GET /api/tna/templates
 * List available T&A templates.
 */
tnaRouter.get('/templates', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const rows = await query<any>(`
    SELECT t.*, COUNT(a.id) AS activity_count
      FROM mst_tna_template_header t
      LEFT JOIN mst_tna_template_activity a ON a.template_id = t.id
     WHERE t.company_id = ? AND t.active = 1
     GROUP BY t.id
     ORDER BY t.id ASC
  `, [companyId]);
  res.json({ data: rows });
}));

/**
 * GET /api/tna/templates/:id
 * Get template with its activity sequence.
 */
tnaRouter.get('/templates/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const tplId = Number(req.params.id);

  const tpl = await queryOne<any>(`
    SELECT * FROM mst_tna_template_header WHERE id = ? AND company_id = ?
  `, [tplId, companyId]);
  if (!tpl) throw NotFound('Template not found');

  const activities = await query<any>(`
    SELECT * FROM mst_tna_template_activity WHERE template_id = ? ORDER BY sequence_no ASC
  `, [tplId]);

  res.json({ data: { ...tpl, activities } });
}));

/**
 * GET /api/tna
 * List T&A records with filters by buyer, style, IO, status, risk.
 */
tnaRouter.get('/', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const { buyer_id, style_id, status, risk, search } = req.query;

  let sql = `
    SELECT h.*,
           b.party_name AS buyer_name,
           st.style_code, st.style_name, st.buyer_style_ref,
           so.so_no, so.io_no, so.buyer_po_no,
           tpl.template_name,
           u.full_name AS merchandiser_name
      FROM trx_tna_header h
      LEFT JOIN mst_party b ON b.id = h.buyer_id
      LEFT JOIN mst_style st ON st.id = h.style_id
      LEFT JOIN trx_sales_order so ON so.id = h.sales_order_id
      LEFT JOIN mst_tna_template_header tpl ON tpl.id = h.template_id
      LEFT JOIN sec_user u ON u.id = h.merchandiser_id
     WHERE h.company_id = ?
  `;
  const params: any[] = [companyId];

  if (buyer_id) {
    sql += ` AND h.buyer_id = ?`;
    params.push(Number(buyer_id));
  }
  if (style_id) {
    sql += ` AND h.style_id = ?`;
    params.push(Number(style_id));
  }
  if (status) {
    sql += ` AND h.status = ?`;
    params.push(String(status));
  }
  if (risk) {
    sql += ` AND h.shipment_risk = ?`;
    params.push(String(risk));
  }
  if (search) {
    sql += ` AND (h.tna_no LIKE ? OR st.style_code LIKE ? OR so.so_no LIKE ? OR so.io_no LIKE ?)`;
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  sql += ` ORDER BY h.shipment_date ASC, h.id DESC`;

  const rows = await query<any>(sql, params);
  res.json({ data: rows });
}));

/**
 * POST /api/tna
 * Create a new Time & Action plan.
 */
tnaRouter.post('/', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const b = req.body;

  if (!b.sales_order_id) throw BadRequest('Sales Order is mandatory.');
  if (!b.shipment_date) throw BadRequest('Shipment Date is mandatory.');

  const so = await queryOne<any>(`
    SELECT so.*, b.id AS buyer_party_id, st.id AS order_style_id
      FROM trx_sales_order so
      LEFT JOIN mst_party b ON b.id = so.buyer_id
      LEFT JOIN trx_sales_order_line sol ON sol.so_id = so.id
      LEFT JOIN mst_style st ON st.id = sol.style_id
     WHERE so.id = ? AND so.company_id = ?
  `, [b.sales_order_id, companyId]);

  if (!so) throw NotFound('Sales order not found');

  const buyerId = b.buyer_id || so.buyer_id;
  const styleId = b.style_id || so.order_style_id || 1;
  const orderQty = b.order_qty || so.order_qty || 0;
  const orderDate = b.order_date || (so.so_date ? new Date(so.so_date).toISOString().slice(0, 10) : null);
  const shipmentDate = b.shipment_date || (so.ship_date ? new Date(so.ship_date).toISOString().slice(0, 10) : null);

  // Spec §26: Duplicate active T&A for the same order/IO must be prevented
  const existingActive = await queryOne<any>(`
    SELECT id, tna_no FROM trx_tna_header
     WHERE company_id = ? AND sales_order_id = ? AND status NOT IN ('CANCELLED', 'CLOSED')
  `, [companyId, b.sales_order_id]);
  if (existingActive) {
    throw BadRequest(`Active T&A (${existingActive.tna_no}) already exists for this Sales Order.`);
  }

  // Spec §26: Shipment Date cannot be earlier than Order Date
  if (orderDate && shipmentDate && new Date(shipmentDate) < new Date(orderDate)) {
    throw BadRequest('Shipment Date cannot be earlier than Order Date.');
  }

  const result = await transaction(async (tx) => {
    let tnaNo = b.tna_no;
    if (!tnaNo) {
      tnaNo = await nextDocNumber(tx, companyId, 'TNA');
    }

    const [ins] = await tx.execute(`
      INSERT INTO trx_tna_header (
        company_id, tna_no, tna_date, buyer_id, style_id, io_id, sales_order_id,
        order_qty, order_date, shipment_date, template_id, merchandiser_id,
        status, completion_percentage, shipment_risk, version, remarks, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 0.00, 'ON_TRACK', 1, ?, ?)
    `, [
      companyId, tnaNo, b.tna_date || new Date().toISOString().slice(0, 10),
      buyerId, styleId, b.io_id || null, b.sales_order_id,
      orderQty, orderDate, shipmentDate, b.template_id || 1,
      b.merchandiser_id || so.merchandiser_id || userId,
      b.remarks || null, userId,
    ]);

    const newId = (ins as any).insertId;

    // If template_id provided, auto-generate activities immediately
    if (b.template_id) {
      const tplActs = await txQuery<any>(tx, `
        SELECT * FROM mst_tna_template_activity WHERE template_id = ? AND active = 1 ORDER BY sequence_no ASC
      `, [b.template_id]);

      if (tplActs.length > 0) {
        const cal = await loadCalendarConfig(companyId, tx);
        const scheduled = await scheduleBackward(shipmentDate, tplActs, cal);

        for (const act of scheduled) {
          await tx.execute(`
            INSERT INTO trx_tna_activity (
              tna_id, activity_code, activity_name, category, sequence_no,
              planned_start_date, planned_end_date, department_name,
              dependency_sequence, dependency_type, priority, weight, mandatory,
              status, health_status, delay_days
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MEDIUM', ?, ?, 'NOT_STARTED', 'ON_TRACK', 0)
          `, [
            newId, act.activity_code, act.activity_name, act.category, act.sequence_no,
            act.planned_start_date, act.planned_end_date, act.department_name || null,
            act.dependency_sequence || null, act.dependency_type || 'FINISH_TO_START',
            act.weight || 1.0, act.mandatory !== undefined ? act.mandatory : 1,
          ]);
        }

        await tx.execute(`UPDATE trx_tna_header SET status = 'GENERATED' WHERE id = ?`, [newId]);
        await evaluateTnaHealth(newId, companyId, tx);
      }
    }

    return txQueryOne(tx, `SELECT * FROM trx_tna_header WHERE id = ?`, [newId]);
  });

  await audit(req, 'trx_tna_header', (result as any).id, 'INSERT', undefined, result);
  res.json({ data: result });
}));

/**
 * GET /api/tna/:id
 * Get T&A detail with summary KPIs, order info, and activities.
 */
tnaRouter.get('/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);

  const header = await queryOne<any>(`
    SELECT h.*,
           b.party_name AS buyer_name,
           st.style_code, st.style_name, st.buyer_style_ref,
           so.so_no, so.io_no, so.buyer_po_no,
           tpl.template_name, tpl.template_code,
           u.full_name AS merchandiser_name,
           appr.full_name AS approved_by_name
      FROM trx_tna_header h
      LEFT JOIN mst_party b ON b.id = h.buyer_id
      LEFT JOIN mst_style st ON st.id = h.style_id
      LEFT JOIN trx_sales_order so ON so.id = h.sales_order_id
      LEFT JOIN mst_tna_template_header tpl ON tpl.id = h.template_id
      LEFT JOIN sec_user u ON u.id = h.merchandiser_id
      LEFT JOIN sec_user appr ON appr.id = h.approved_by
     WHERE h.id = ? AND h.company_id = ?
  `, [id, companyId]);

  if (!header) throw NotFound('Time & Action record not found');

  const activities = await query<any>(`
    SELECT a.*, u.full_name AS responsible_user_name, c.full_name AS completed_by_name
      FROM trx_tna_activity a
      LEFT JOIN sec_user u ON u.id = a.responsible_user_id
      LEFT JOIN sec_user c ON c.id = a.completed_by
     WHERE a.tna_id = ?
     ORDER BY a.sequence_no ASC
  `, [id]);

  // Statistics
  const total = activities.length;
  const completed = activities.filter((a) => a.status === 'COMPLETED').length;
  const pending = activities.filter((a) => a.status !== 'COMPLETED' && a.status !== 'CANCELLED').length;
  const delayed = activities.filter((a) => a.health_status === 'DELAYED' || a.health_status === 'CRITICAL').length;
  const atRisk = activities.filter((a) => a.health_status === 'AT_RISK').length;

  res.json({
    data: {
      header,
      summary: {
        total,
        completed,
        pending,
        delayed,
        at_risk: atRisk,
        completion_percentage: Number(header.completion_percentage || 0),
        shipment_risk: header.shipment_risk,
      },
      activities,
    },
  });
}));

/**
 * POST /api/tna/:id/generate
 * Auto-generate or regenerate activities from template with backward scheduling.
 */
tnaRouter.post('/:id/generate', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  const templateId = req.body.template_id;

  const header = await queryOne<any>(`SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!header) throw NotFound('T&A not found');
  if (header.status === 'APPROVED' || header.status === 'CLOSED') {
    throw BadRequest('Cannot regenerate activities for an approved or closed T&A. Please create a revision.');
  }

  const tplId = templateId || header.template_id || 1;
  const tplActs = await query<any>(`
    SELECT * FROM mst_tna_template_activity WHERE template_id = ? AND active = 1 ORDER BY sequence_no ASC
  `, [tplId]);
  if (!tplActs.length) throw BadRequest('Selected template has no activities.');

  const cal = await loadCalendarConfig(companyId);
  const scheduled = await scheduleBackward(header.shipment_date, tplActs, cal);

  await transaction(async (tx) => {
    // Delete existing activities
    await tx.execute(`DELETE FROM trx_tna_activity WHERE tna_id = ?`, [id]);

    for (const act of scheduled) {
      await tx.execute(`
        INSERT INTO trx_tna_activity (
          tna_id, activity_code, activity_name, category, sequence_no,
          planned_start_date, planned_end_date, department_name,
          dependency_sequence, dependency_type, priority, weight, mandatory,
          status, health_status, delay_days
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MEDIUM', ?, ?, 'NOT_STARTED', 'ON_TRACK', 0)
      `, [
        id, act.activity_code, act.activity_name, act.category, act.sequence_no,
        act.planned_start_date, act.planned_end_date, act.department_name || null,
        act.dependency_sequence || null, act.dependency_type || 'FINISH_TO_START',
        act.weight || 1.0, act.mandatory !== undefined ? act.mandatory : 1,
      ]);
    }

    await tx.execute(`UPDATE trx_tna_header SET template_id = ?, status = 'GENERATED' WHERE id = ?`, [tplId, id]);
    await evaluateTnaHealth(id, companyId, tx);
  });

  const updated = await queryOne(`SELECT * FROM trx_tna_header WHERE id = ?`, [id]);
  res.json({ data: updated, message: 'Activities successfully generated from template with backward scheduling.' });
}));

/**
 * POST /api/tna/:id/recalculate
 * Synchronize live ERP transactions and recalculate dates, delays, and shipment risk.
 */
tnaRouter.post('/:id/recalculate', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);

  const header = await queryOne<any>(`SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!header) throw NotFound('T&A not found');

  const stats = await syncErpEventsToTna(id, companyId);
  const updatedHeader = await queryOne<any>(`SELECT * FROM trx_tna_header WHERE id = ?`, [id]);
  const activities = await query<any>(`SELECT * FROM trx_tna_activity WHERE tna_id = ? ORDER BY sequence_no ASC`, [id]);

  res.json({
    data: {
      header: updatedHeader,
      summary: stats,
      activities,
    },
    message: 'T&A successfully recalculated and synchronized with ERP events.',
  });
}));

/**
 * POST /api/tna/:id/submit
 * Submit T&A for approval.
 */
tnaRouter.post('/:id/submit', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);

  const header = await queryOne<any>(`SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!header) throw NotFound('T&A not found');

  await query(`UPDATE trx_tna_header SET status = 'SUBMITTED' WHERE id = ? AND company_id = ?`, [id, companyId]);
  res.json({ message: 'T&A successfully submitted for manager approval.' });
}));

/**
 * POST /api/tna/:id/approve
 * Approve T&A plan and activate control tracking.
 */
tnaRouter.post('/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const id = Number(req.params.id);

  const header = await queryOne<any>(`SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!header) throw NotFound('T&A not found');

  await query(`
    UPDATE trx_tna_header
       SET status = 'APPROVED', approved_by = ?, approved_at = NOW()
     WHERE id = ? AND company_id = ?
  `, [userId, id, companyId]);

  res.json({ message: 'T&A successfully approved and locked for live production tracking.' });
}));

/**
 * POST /api/tna/:id/revise
 * Create a new revised version (e.g. V2, V3) preserving old version history.
 */
tnaRouter.post('/:id/revise', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const id = Number(req.params.id);

  const original = await queryOne<any>(`SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!original) throw NotFound('T&A not found');

  const newRevision = await transaction(async (tx) => {
    const nextVersion = (original.version || 1) + 1;
    const nextTnaNo = `${original.tna_no}-R${nextVersion}`;

    const [ins] = await tx.execute(`
      INSERT INTO trx_tna_header (
        company_id, tna_no, tna_date, buyer_id, style_id, io_id, sales_order_id,
        order_qty, order_date, shipment_date, template_id, merchandiser_id,
        status, completion_percentage, shipment_risk, version, remarks, created_by
      ) VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'GENERATED', ?, ?, ?, ?, ?)
    `, [
      companyId, nextTnaNo, original.buyer_id, original.style_id, original.io_id, original.sales_order_id,
      original.order_qty, original.order_date, original.shipment_date, original.template_id, original.merchandiser_id,
      original.completion_percentage, original.shipment_risk, nextVersion,
      `Revision ${nextVersion} created from ${original.tna_no}`, userId,
    ]);

    const newId = (ins as any).insertId;
    const oldActs = await txQuery<any>(tx, `SELECT * FROM trx_tna_activity WHERE tna_id = ?`, [id]);

    for (const a of oldActs) {
      await tx.execute(`
        INSERT INTO trx_tna_activity (
          tna_id, activity_code, activity_name, category, sequence_no,
          planned_start_date, planned_end_date, actual_start_date, actual_end_date,
          department_name, responsible_user_id, dependency_sequence, dependency_type,
          priority, weight, mandatory, approval_required, status, health_status, delay_days, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        newId, a.activity_code, a.activity_name, a.category, a.sequence_no,
        a.planned_start_date, a.planned_end_date, a.actual_start_date, a.actual_end_date,
        a.department_name, a.responsible_user_id, a.dependency_sequence, a.dependency_type,
        a.priority, a.weight, a.mandatory, a.approval_required, a.status, a.health_status, a.delay_days, a.remarks,
      ]);
    }

    return txQueryOne(tx, `SELECT * FROM trx_tna_header WHERE id = ?`, [newId]);
  });

  res.json({ data: newRevision, message: `Created Revision V${(newRevision as any).version}` });
}));

/**
 * PATCH /api/tna/:id/activities/:activityId
 * PUT   /api/tna/:id/activities/:activityId
 * Update permitted activity fields with audit history logging.
 */
const handleUpdateActivity = ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const tnaId = Number(req.params.id);
  const actId = Number(req.params.activityId);
  const b = req.body;

  const existing = await queryOne<any>(`
    SELECT a.*, h.status AS header_status FROM trx_tna_activity a
      JOIN trx_tna_header h ON h.id = a.tna_id
     WHERE a.id = ? AND a.tna_id = ? AND h.company_id = ?
  `, [actId, tnaId, companyId]);

  if (!existing) throw NotFound('Activity not found');

  // Spec §26: Closed T&A cannot be modified without controlled revision
  if (existing.header_status === 'CLOSED') {
    throw BadRequest('Closed T&A cannot be modified without controlled revision.');
  }

  // Spec §26: Planned End cannot be before Planned Start
  const newPlannedStart = b.planned_start_date || existing.planned_start_date;
  const newPlannedEnd = b.planned_end_date || existing.planned_end_date;
  if (newPlannedStart && newPlannedEnd && new Date(newPlannedEnd) < new Date(newPlannedStart)) {
    throw BadRequest('Planned End Date cannot be before Planned Start Date.');
  }

  // Spec §26: Actual End cannot be before Actual Start
  const newActualStart = b.actual_start_date || existing.actual_start_date;
  const newActualEnd = b.actual_end_date || existing.actual_end_date;
  if (newActualStart && newActualEnd && new Date(newActualEnd) < new Date(newActualStart)) {
    throw BadRequest('Actual End Date cannot be before Actual Start Date.');
  }

  await transaction(async (tx) => {
    // Record history
    await tx.execute(`
      INSERT INTO trx_tna_activity_history (
        activity_id, old_status, new_status, old_planned_start, new_planned_start,
        old_planned_end, new_planned_end, actual_start, actual_end, changed_by, reason, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      actId, existing.status, b.status || existing.status,
      existing.planned_start_date, b.planned_start_date || existing.planned_start_date,
      existing.planned_end_date, b.planned_end_date || existing.planned_end_date,
      b.actual_start_date || existing.actual_start_date,
      b.actual_end_date || existing.actual_end_date,
      userId, b.reason || 'User update', b.remarks || null,
    ]);

    await tx.execute(`
      UPDATE trx_tna_activity SET
        planned_start_date = COALESCE(?, planned_start_date),
        planned_end_date = COALESCE(?, planned_end_date),
        actual_start_date = COALESCE(?, actual_start_date),
        actual_end_date = COALESCE(?, actual_end_date),
        department_name = COALESCE(?, department_name),
        responsible_user_id = COALESCE(?, responsible_user_id),
        priority = COALESCE(?, priority),
        status = COALESCE(?, status),
        remarks = COALESCE(?, remarks)
      WHERE id = ?
    `, [
      b.planned_start_date || null,
      b.planned_end_date || null,
      b.actual_start_date || null,
      b.actual_end_date || null,
      b.department_name || null,
      b.responsible_user_id || null,
      b.priority || null,
      b.status || null,
      b.remarks || null,
      actId,
    ]);

    await evaluateTnaHealth(tnaId, companyId, tx);
  });

  const updated = await queryOne<any>(`SELECT * FROM trx_tna_activity WHERE id = ?`, [actId]);
  res.json({ data: updated, message: 'Activity updated successfully.' });
});

tnaRouter.patch('/:id/activities/:activityId', requirePermission('PRODUCTION.CREATE'), handleUpdateActivity);
tnaRouter.put('/:id/activities/:activityId', requirePermission('PRODUCTION.CREATE'), handleUpdateActivity);

/**
 * POST /api/tna/:id/activities/:activityId/complete
 * Mark activity as complete with actual end date.
 */
tnaRouter.post('/:id/activities/:activityId/complete', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const tnaId = Number(req.params.id);
  const actId = Number(req.params.activityId);
  const { actual_end_date, remarks } = req.body;

  const existing = await queryOne<any>(`
    SELECT a.*, h.status AS header_status FROM trx_tna_activity a
      JOIN trx_tna_header h ON h.id = a.tna_id
     WHERE a.id = ? AND a.tna_id = ? AND h.company_id = ?
  `, [actId, tnaId, companyId]);

  if (!existing) throw NotFound('Activity not found');
  if (existing.header_status === 'CLOSED') {
    throw BadRequest('Closed T&A cannot be modified without controlled revision.');
  }

  const endDate = actual_end_date || new Date().toISOString().slice(0, 10);

  await transaction(async (tx) => {
    await tx.execute(`
      UPDATE trx_tna_activity SET
        status = 'COMPLETED',
        actual_end_date = ?,
        actual_start_date = COALESCE(actual_start_date, ?),
        remarks = COALESCE(?, remarks),
        completed_by = ?,
        completed_at = NOW()
      WHERE id = ? AND tna_id = ?
    `, [endDate, endDate, remarks || null, userId, actId, tnaId]);

    await evaluateTnaHealth(tnaId, companyId, tx);
  });

  res.json({ message: 'Activity marked as COMPLETED.' });
}));

/**
 * GET /api/tna/:id/gantt
 * Formatted Gantt chart dataset with milestones and status colors.
 */
tnaRouter.get('/:id/gantt', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);

  const header = await queryOne<any>(`SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!header) throw NotFound('T&A not found');

  const activities = await query<any>(`
    SELECT a.*, u.full_name AS owner_name
      FROM trx_tna_activity a
      LEFT JOIN sec_user u ON u.id = a.responsible_user_id
     WHERE a.tna_id = ?
     ORDER BY a.sequence_no ASC
  `, [id]);

  const ganttTasks = activities.map((a) => {
    return {
      id: a.id,
      sequence: a.sequence_no,
      name: a.activity_name,
      code: a.activity_code,
      category: a.category,
      planned_start: a.planned_start_date,
      planned_end: a.planned_end_date,
      actual_start: a.actual_start_date,
      actual_end: a.actual_end_date,
      status: a.status,
      health: a.health_status,
      delay_days: a.delay_days,
      dependency_seq: a.dependency_sequence,
      owner: a.owner_name || a.department_name || 'Unassigned',
      is_mandatory: Boolean(a.mandatory),
    };
  });

  res.json({
    data: {
      order_no: header.tna_no,
      shipment_date: header.shipment_date,
      tasks: ganttTasks,
    },
  });
}));

/**
 * GET /api/tna/:id/calendar
 * Calendar events dataset.
 */
tnaRouter.get('/:id/calendar', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const activities = await query<any>(`
    SELECT id, activity_name, category, planned_start_date, planned_end_date,
           actual_start_date, actual_end_date, status, health_status, department_name
      FROM trx_tna_activity
     WHERE tna_id = ?
     ORDER BY sequence_no ASC
  `, [id]);

  res.json({ data: activities });
}));

/**
 * GET /api/tna/:id/alerts
 * Active alerts (Overdue, Due today, Approaching, Dependency blocked).
 */
tnaRouter.get('/:id/alerts', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const activities = await query<any>(`
    SELECT * FROM trx_tna_activity
     WHERE tna_id = ? AND status <> 'COMPLETED' AND status <> 'CANCELLED'
     ORDER BY sequence_no ASC
  `, [id]);

  const todayStr = new Date().toISOString().slice(0, 10);
  const alerts: any[] = [];

  for (const act of activities) {
    if (!act.planned_end_date) continue;
    const pEnd = new Date(act.planned_end_date).toISOString().slice(0, 10);

    if (pEnd < todayStr) {
      alerts.push({
        type: 'OVERDUE',
        severity: 'CRITICAL',
        activity_id: act.id,
        activity_name: act.activity_name,
        category: act.category,
        message: `Activity is ${act.delay_days || 1} days overdue! (Planned End: ${pEnd})`,
        planned_end: pEnd,
      });
    } else if (pEnd === todayStr) {
      alerts.push({
        type: 'DUE_TODAY',
        severity: 'WARNING',
        activity_id: act.id,
        activity_name: act.activity_name,
        category: act.category,
        message: `Activity is due today (${pEnd})`,
        planned_end: pEnd,
      });
    } else if (act.health_status === 'AT_RISK') {
      alerts.push({
        type: 'APPROACHING',
        severity: 'INFO',
        activity_id: act.id,
        activity_name: act.activity_name,
        category: act.category,
        message: `Activity deadline approaching on ${pEnd}`,
        planned_end: pEnd,
      });
    }
  }

  res.json({ data: alerts });
}));

/**
 * GET /api/tna/:id/history
 * Audit log of activity changes.
 */
tnaRouter.get('/:id/history', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const rows = await query<any>(`
    SELECT h.*, a.activity_name, a.activity_code, u.full_name AS changed_by_name
      FROM trx_tna_activity_history h
      JOIN trx_tna_activity a ON a.id = h.activity_id
      LEFT JOIN sec_user u ON u.id = h.changed_by
     WHERE a.tna_id = ?
     ORDER BY h.changed_at DESC
  `, [id]);

  res.json({ data: rows });
}));
