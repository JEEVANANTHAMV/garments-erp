import { query, queryOne, txQuery, txExecute } from '../../config/db.js';

export interface WorkingCalendarConfig {
  workingDays: Set<number>; // 0=Sunday, 1=Monday, etc.
  holidays: Set<string>;   // 'YYYY-MM-DD'
}

/**
 * Load company working days and holidays.
 */
export async function loadCalendarConfig(companyId: number, tx?: any): Promise<WorkingCalendarConfig> {
  const runner = tx ? (sql: string, params: any[]) => txQuery(tx, sql, params) : query;

  const calRows = await runner(
    `SELECT day_of_week, is_working_day FROM cfg_working_calendar WHERE company_id = ?`,
    [companyId]
  );
  const holRows = await runner(
    `SELECT holiday_date FROM cfg_holiday WHERE company_id = ?`,
    [companyId]
  );

  const workingDays = new Set<number>();
  if (calRows.length > 0) {
    for (const r of calRows) {
      if (r.is_working_day) workingDays.add(Number(r.day_of_week));
    }
  } else {
    // Default Mon(1) to Sat(6), Sun(0) off
    for (let i = 1; i <= 6; i++) workingDays.add(i);
  }

  const holidays = new Set<string>();
  for (const h of holRows) {
    const dStr = new Date(h.holiday_date).toISOString().slice(0, 10);
    holidays.add(dStr);
  }

  return { workingDays, holidays };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isWorkingDay(d: Date, cal: WorkingCalendarConfig): boolean {
  const day = d.getDay();
  if (!cal.workingDays.has(day)) return false;
  const dateStr = formatDate(d);
  if (cal.holidays.has(dateStr)) return false;
  return true;
}

/**
 * Add working days to a start date.
 */
export function addWorkingDays(startDateStr: string, days: number, cal: WorkingCalendarConfig): string {
  const d = new Date(startDateStr);
  let added = 0;
  // Ensure start date itself is counted if working
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d, cal)) {
      added++;
    }
  }
  return formatDate(d);
}

/**
 * Subtract working days from an end date (for backward planning).
 */
export function subtractWorkingDays(endDateStr: string, days: number, cal: WorkingCalendarConfig): string {
  const d = new Date(endDateStr);
  let subtracted = 0;
  while (subtracted < days) {
    d.setDate(d.getDate() - 1);
    if (isWorkingDay(d, cal)) {
      subtracted++;
    }
  }
  return formatDate(d);
}

/**
 * Backward planning algorithm:
 * Given shipment date, works backwards through dependency sequence and activity durations.
 */
export async function scheduleBackward(
  shipmentDateStr: string,
  templateActivities: any[],
  cal: WorkingCalendarConfig
): Promise<any[]> {
  // Sort descending by sequence_no
  const sorted = [...templateActivities].sort((a, b) => b.sequence_no - a.sequence_no);
  const plannedMap = new Map<number, { planned_start_date: string; planned_end_date: string }>();

  // The last activity ends on shipmentDate
  let currentEnd = shipmentDateStr;

  for (const act of sorted) {
    const duration = Math.max(1, Number(act.default_duration) || 1);

    // If activity has dependents that rely on it, its planned_end cannot be later than min(dependent.planned_start - 1 working day)
    let actEnd = currentEnd;
    const dependents = templateActivities.filter((t) => t.dependency_sequence === act.sequence_no);
    if (dependents.length > 0) {
      let earliestDepStart: string | null = null;
      for (const dep of dependents) {
        const depPlan = plannedMap.get(dep.sequence_no);
        if (depPlan) {
          if (!earliestDepStart || depPlan.planned_start_date < earliestDepStart) {
            earliestDepStart = depPlan.planned_start_date;
          }
        }
      }
      if (earliestDepStart) {
        actEnd = subtractWorkingDays(earliestDepStart, 1, cal);
      }
    }

    const actStart = duration > 1 ? subtractWorkingDays(actEnd, duration - 1, cal) : actEnd;
    plannedMap.set(act.sequence_no, { planned_start_date: actStart, planned_end_date: actEnd });
    currentEnd = actStart;
  }

  return templateActivities.map((act) => {
    const plan = plannedMap.get(act.sequence_no) || {
      planned_start_date: shipmentDateStr,
      planned_end_date: shipmentDateStr,
    };
    return {
      ...act,
      planned_start_date: plan.planned_start_date,
      planned_end_date: plan.planned_end_date,
    };
  });
}

/**
 * Recalculate health status, delay days, completion %, and shipment risk for a T&A.
 */
export async function evaluateTnaHealth(tnaId: number, companyId: number, tx?: any) {
  const runner = tx ? (sql: string, params: any[]) => txQuery(tx, sql, params) : query;
  const exec = tx ? (sql: string, params: any[]) => txExecute(tx, sql, params) : query;

  const tna = await (tx ? txQuery(tx, `SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [tnaId, companyId])
                         : query(`SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [tnaId, companyId]));
  if (!tna || !tna[0]) return null;
  const header = tna[0];

  const activities = await runner(
    `SELECT * FROM trx_tna_activity WHERE tna_id = ? ORDER BY sequence_no ASC`,
    [tnaId]
  );

  const todayStr = new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr).getTime();

  let totalMandatory = 0;
  let completedMandatory = 0;
  let delayedCount = 0;
  let atRiskCount = 0;
  let criticalCount = 0;

  for (const act of activities) {
    let delayDays = 0;
    let health: 'ON_TRACK' | 'AT_RISK' | 'DELAYED' | 'CRITICAL' = 'ON_TRACK';

    const isMandatory = Boolean(act.mandatory);
    if (isMandatory) totalMandatory++;

    if (act.status === 'COMPLETED') {
      if (isMandatory) completedMandatory++;
      if (act.actual_end_date && act.planned_end_date) {
        const actualEnd = new Date(act.actual_end_date).getTime();
        const plannedEnd = new Date(act.planned_end_date).getTime();
        const diffDays = Math.round((actualEnd - plannedEnd) / (1000 * 3600 * 24));
        delayDays = Math.max(0, diffDays);
        health = delayDays > 0 ? 'DELAYED' : 'ON_TRACK';
      }
    } else {
      // Incomplete
      if (act.planned_end_date) {
        const plannedEnd = new Date(act.planned_end_date).getTime();
        const diffDays = Math.round((today - plannedEnd) / (1000 * 3600 * 24));
        if (diffDays > 0) {
          delayDays = diffDays;
          health = delayDays > 4 ? 'CRITICAL' : 'DELAYED';
          delayedCount++;
          if (delayDays > 4) criticalCount++;
        } else if (Math.abs(diffDays) <= (act.alert_before_days || 2)) {
          health = 'AT_RISK';
          atRiskCount++;
        }
      }
    }

    await exec(
      `UPDATE trx_tna_activity
          SET delay_days = ?, health_status = ?
        WHERE id = ?`,
      [delayDays, health, act.id]
    );
  }

  // Calculate overall completion %
  const completionPct = totalMandatory > 0 ? (completedMandatory / totalMandatory) * 100 : 0;

  // Calculate shipment risk
  let shipmentRisk: 'ON_TRACK' | 'AT_RISK' | 'CRITICAL' = 'ON_TRACK';
  const shipDate = new Date(header.shipment_date).getTime();
  const daysToShipment = Math.round((shipDate - today) / (1000 * 3600 * 24));

  if (daysToShipment < 0 && completionPct < 100) {
    shipmentRisk = 'CRITICAL';
  } else if (criticalCount > 0 || (daysToShipment <= 7 && completionPct < 75)) {
    shipmentRisk = 'CRITICAL';
  } else if (delayedCount > 2 || atRiskCount > 3 || (daysToShipment <= 14 && completionPct < 50)) {
    shipmentRisk = 'AT_RISK';
  } else {
    shipmentRisk = 'ON_TRACK';
  }

  await exec(
    `UPDATE trx_tna_header
        SET completion_percentage = ?, shipment_risk = ?
      WHERE id = ?`,
    [completionPct.toFixed(2), shipmentRisk, tnaId]
  );

  return {
    completionPercentage: Number(completionPct.toFixed(2)),
    shipmentRisk,
    totalActivities: activities.length,
    completedCount: completedMandatory,
    delayedCount,
    atRiskCount,
    criticalCount,
  };
}

/**
 * Synchronize live ERP transactions with T&A activities.
 */
export async function syncErpEventsToTna(tnaId: number, companyId: number, tx?: any) {
  const runner = tx ? (sql: string, params: any[]) => txQuery(tx, sql, params) : query;
  const exec = tx ? (sql: string, params: any[]) => txExecute(tx, sql, params) : query;

  const tnaRes = await runner(`SELECT * FROM trx_tna_header WHERE id = ? AND company_id = ?`, [tnaId, companyId]);
  if (!tnaRes || !tnaRes[0]) return;
  const tna = tnaRes[0];
  const soId = tna.sales_order_id;
  const styleId = tna.style_id;

  const activities = await runner(`SELECT * FROM trx_tna_activity WHERE tna_id = ?`, [tnaId]);
  const actMap = new Map<string, any>();
  for (const a of activities) actMap.set(a.activity_code, a);

  // 1. Sales Order Confirmation (ACT_PO_REC)
  const so = await runner(`SELECT approval_state, so_date FROM trx_sales_order WHERE id = ?`, [soId]);
  if (so.length > 0 && so[0].approval_state === 'APPROVED' && actMap.has('ACT_PO_REC')) {
    const act = actMap.get('ACT_PO_REC');
    if (act.status !== 'COMPLETED') {
      const d = so[0].so_date ? new Date(so[0].so_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
      await exec(
        `UPDATE trx_tna_activity
            SET status = 'COMPLETED', actual_start_date = COALESCE(actual_start_date, ?),
                actual_end_date = ?, source_event = 'SALES_ORDER_APPROVED', completed_at = NOW()
          WHERE id = ?`,
        [d, d, act.id]
      );
    }
  }

  // 2. Costing / Pre-Costing Approved (ACT_BOM_COST)
  const costing = await runner(
    `SELECT id, created_at, status FROM trx_costing WHERE style_id = ? AND company_id = ? ORDER BY version DESC LIMIT 1`,
    [styleId, companyId]
  );
  if (costing.length > 0 && actMap.has('ACT_BOM_COST')) {
    const act = actMap.get('ACT_BOM_COST');
    if (act.status !== 'COMPLETED') {
      const d = new Date(costing[0].created_at).toISOString().slice(0, 10);
      await exec(
        `UPDATE trx_tna_activity
            SET status = 'COMPLETED', actual_start_date = COALESCE(actual_start_date, ?),
                actual_end_date = ?, source_event = 'COSTING_APPROVED', completed_at = NOW()
          WHERE id = ?`,
        [d, d, act.id]
      );
    }
  }

  // 3. Fabric In-house (ACT_FAB_INHOUSE)
  const fabGrn = await runner(
    `SELECT id, grn_no, grn_date FROM trx_fabric_grn WHERE company_id = ? AND (style_id = ? OR remarks LIKE ?) LIMIT 1`,
    [companyId, styleId, `%SO-${soId}%`]
  );
  if (fabGrn.length > 0 && actMap.has('ACT_FAB_INHOUSE')) {
    const act = actMap.get('ACT_FAB_INHOUSE');
    if (act.status !== 'COMPLETED') {
      const d = fabGrn[0].grn_date ? new Date(fabGrn[0].grn_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
      await exec(
        `UPDATE trx_tna_activity
            SET status = 'COMPLETED', actual_start_date = COALESCE(actual_start_date, ?),
                actual_end_date = ?, source_event = 'FABRIC_GRN_POSTED', remarks = ?, completed_at = NOW()
          WHERE id = ?`,
        [d, d, `Auto-updated from Fabric GRN ${fabGrn[0].grn_no}`, act.id]
      );
    }
  }

  // 4. Cutting Production (ACT_CUTTING)
  const cut = await runner(
    `SELECT id, cut_date, total_pieces FROM trx_cutting WHERE company_id = ? AND style_id = ? LIMIT 1`,
    [companyId, styleId]
  );
  if (cut.length > 0 && actMap.has('ACT_CUTTING')) {
    const act = actMap.get('ACT_CUTTING');
    const d = cut[0].cut_date ? new Date(cut[0].cut_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (act.status === 'NOT_STARTED') {
      await exec(
        `UPDATE trx_tna_activity
            SET status = 'IN_PROGRESS', actual_start_date = ?, source_event = 'CUTTING_STARTED'
          WHERE id = ?`,
        [d, act.id]
      );
    }
  }

  // 5. Sewing Production (ACT_SEWING)
  const sew = await runner(
    `SELECT id, prod_date, output_qty FROM trx_stitching WHERE company_id = ? AND prod_order_id IN (SELECT id FROM trx_production_order WHERE so_id = ?) LIMIT 1`,
    [companyId, soId]
  );
  if (sew.length > 0 && actMap.has('ACT_SEWING')) {
    const act = actMap.get('ACT_SEWING');
    const d = sew[0].prod_date ? new Date(sew[0].prod_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (act.status === 'NOT_STARTED') {
      await exec(
        `UPDATE trx_tna_activity
            SET status = 'IN_PROGRESS', actual_start_date = ?, source_event = 'SEWING_STARTED'
          WHERE id = ?`,
        [d, act.id]
      );
    }
  }

  // 6. Finishing (ACT_FINISHING)
  const fin = await runner(
    `SELECT id, prod_date, passed_qty FROM trx_finishing WHERE company_id = ? AND prod_order_id IN (SELECT id FROM trx_production_order WHERE so_id = ?) LIMIT 1`,
    [companyId, soId]
  );
  if (fin.length > 0 && actMap.has('ACT_FINISHING')) {
    const act = actMap.get('ACT_FINISHING');
    const d = fin[0].prod_date ? new Date(fin[0].prod_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (act.status === 'NOT_STARTED') {
      await exec(
        `UPDATE trx_tna_activity
            SET status = 'IN_PROGRESS', actual_start_date = ?, source_event = 'FINISHING_STARTED'
          WHERE id = ?`,
        [d, act.id]
      );
    }
  }

  // 7. Packing (ACT_PACKING)
  const pack = await runner(
    `SELECT id, pack_date, total_pieces FROM trx_packing WHERE company_id = ? AND prod_order_id IN (SELECT id FROM trx_production_order WHERE so_id = ?) LIMIT 1`,
    [companyId, soId]
  );
  if (pack.length > 0 && actMap.has('ACT_PACKING')) {
    const act = actMap.get('ACT_PACKING');
    const d = pack[0].pack_date ? new Date(pack[0].pack_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    if (act.status === 'NOT_STARTED') {
      await exec(
        `UPDATE trx_tna_activity
            SET status = 'IN_PROGRESS', actual_start_date = ?, source_event = 'PACKING_STARTED'
          WHERE id = ?`,
        [d, act.id]
      );
    }
  }

  // 8. Shipment (ACT_SHIPMENT)
  const ship = await runner(
    `SELECT id, dispatch_no, dispatch_date FROM trx_dispatch WHERE company_id = ? AND (buyer_id = ? OR remarks LIKE ?) LIMIT 1`,
    [companyId, tna.buyer_id, `%SO-${soId}%`]
  );
  if (ship.length > 0 && actMap.has('ACT_SHIPMENT')) {
    const act = actMap.get('ACT_SHIPMENT');
    const d = ship[0].dispatch_date ? new Date(ship[0].dispatch_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    await exec(
      `UPDATE trx_tna_activity
          SET status = 'COMPLETED', actual_start_date = COALESCE(actual_start_date, ?),
              actual_end_date = ?, source_event = 'SHIPMENT_POSTED', completed_at = NOW()
        WHERE id = ?`,
      [d, d, act.id]
    );
    await exec(`UPDATE trx_tna_header SET status = 'CLOSED' WHERE id = ?`, [tnaId]);
  }

  // Recalculate health & status after sync
  return evaluateTnaHealth(tnaId, companyId, tx);
}
