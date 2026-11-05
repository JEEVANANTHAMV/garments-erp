/**
 * Gate & transport reports (client voice notes 04-Nov-2026 clip 2; transport spec §10) and the coordinator dashboard.
 * Read-only, company scoped. Mounted at /api/gate-reports; the dashboard at /api/transport/dashboard.
 *   visitors              visitor / contractor register: in / out, duration, still inside, photo
 *   transport-requests    request register: ageing, approval and turnaround times, trip / vehicle / driver
 *   pending-requests      open requests: required time, overdue hours, delay reason, coordinator
 *   requests-by-department requests per department + requester by status
 *   trip-sheet            daily trip sheet: planned vs actual, stops, km
 *   vehicle-utilisation   per vehicle: trips, hours, km, issues, availability (owned / rental)
 *   driver-utilisation    per driver: trips, hours, rejections, issues
 *   service-performance   pickup & delivery: on-time rate, average completion, failed / partial per request type
 * Date filters are IST calendar days. Date-times are returned as "DD-MM-YYYY HH:mm" IST text.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { Forbidden } from '../../core/errors.js';
import { P, has, must, istDayStart, istDayEnd, istText, istToday, hoursBetween, ACTIVE_TRIP } from './transportCore.js';
import { QUEUES } from './transportRequests.routes.js';

export const gateReportsRouter = Router();
export const transportDashboardRouter = Router();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const num = (v: unknown) => (v == null ? 0 : Number(v));
const round2 = (v: number) => Math.round(v * 100) / 100;
/** Default window: the last 30 days (IST). */
function range(q: { from?: string; to?: string }) {
  const to = q.to ?? istToday();
  const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  return { from, to, start: istDayStart(from), end: istDayEnd(to) };
}
const mustGate = (req: Request) => {
  if (!(req.user!.isSuperAdmin || req.user!.permissions.has('GATE_INWARD.VIEW') || has(req, P.VIEW))) throw Forbidden('Requires GATE_INWARD.VIEW');
};

/* ====================================================================== visitors */
/** "HH:MM" strings → minutes between (same day; out before in = next day). */
const minutes = (a?: string | null, b?: string | null) => {
  const m = (s: string) => { const [h, mi] = s.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(mi) ? h * 60 + mi : null; };
  if (!a || !b) return null;
  const x = m(a); const y = m(b); if (x == null || y == null) return null;
  return y >= x ? y - x : y + 1440 - x;
};
const nowIstHm = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(11, 16);

gateReportsRouter.get('/visitors', ah(async (req, res) => {
  mustGate(req);
  const q = z.object({ from: ymd, to: ymd, visitor_type: z.string().optional(), status: z.string().optional(), inside: z.string().optional(),
    department_id: z.coerce.number().optional(), purpose: z.string().optional(), company: z.string().optional(), host: z.string().optional() }).parse(req.query);
  const r = range(q);
  const where = ['v.company_id = ?', 'v.visit_date BETWEEN ? AND ?']; const args: unknown[] = [req.user!.companyId, r.from, r.to];
  if (q.visitor_type) { where.push('v.visitor_type = ?'); args.push(q.visitor_type); }
  if (q.status) { where.push('v.status = ?'); args.push(q.status); }
  if (q.inside === 'Y') where.push(`v.status = 'IN'`);
  if (q.department_id) { where.push('v.host_department_id = ?'); args.push(q.department_id); }
  if (q.purpose) { where.push('v.purpose LIKE ?'); args.push(`%${q.purpose}%`); }
  if (q.company) { where.push('(v.organisation LIKE ? OR p.party_name LIKE ?)'); args.push(`%${q.company}%`, `%${q.company}%`); }
  if (q.host) { where.push('v.whom_to_meet LIKE ?'); args.push(`%${q.host}%`); }
  const rows = await query<any>(`SELECT v.*, p.party_name, d.dept_name FROM trx_gate_visitor v LEFT JOIN mst_party p ON p.id = v.party_id LEFT JOIN mst_department d ON d.id = v.host_department_id
      WHERE ${where.join(' AND ')} ORDER BY v.visit_date DESC, v.in_time DESC, v.id DESC`, args);
  const today = istToday();
  const data = rows.map((v) => {
    const inside = v.status === 'IN';
    const outRef = v.out_time || (inside && String(v.visit_date).slice(0, 10) === today ? nowIstHm() : null);
    const dur = minutes(v.in_time, outRef);
    return {
      id: v.id, entry_no: v.entry_no, visit_date: v.visit_date, visitor_type: v.visitor_type, person_name: v.person_name, person_count: v.person_count,
      company: v.organisation || v.party_name || null, phone: v.phone, purpose: v.purpose, whom_to_meet: v.whom_to_meet, department: v.dept_name,
      in_time: v.in_time, out_time: v.out_time, duration_min: dur, duration: dur == null ? null : `${Math.floor(dur / 60)}h ${String(dur % 60).padStart(2, '0')}m`,
      still_inside: inside ? 'Y' : 'N', status: v.status, vehicle_no: v.vehicle_no, id_proof: v.id_proof, security_guard: v.security_guard, photo_url: v.photo_url,
      has_photo: v.photo_url ? 'Y' : 'N',
    };
  });
  const inside = data.filter((d) => d.still_inside === 'Y').length;
  res.json({ data, meta: { footnotes: [`${r.from} to ${r.to} · ${data.length} entries · ${data.reduce((a, d) => a + num(d.person_count), 0)} persons · ${inside} still inside`,
    'Duration of a visitor still inside today runs to the current time.'] } });
}));

/* ====================================================================== transport: request register */
const reqFilters = z.object({ from: ymd, to: ymd, department_id: z.coerce.number().optional(), requested_by: z.coerce.number().optional(),
  request_type_id: z.coerce.number().optional(), priority: z.string().optional(), status: z.string().optional() });

async function requestRows(req: Request, q: z.infer<typeof reqFilters>, extraWhere = '') {
  const r = range(q);
  const where = ['r.company_id = ?', `r.status <> 'DRAFT'`, 'r.required_at >= ?', 'r.required_at < ?']; const args: unknown[] = [req.user!.companyId, r.start, r.end];
  if (q.department_id) { where.push('r.department_id = ?'); args.push(q.department_id); }
  if (q.requested_by) { where.push('r.requested_by = ?'); args.push(q.requested_by); }
  if (q.request_type_id) { where.push('r.request_type_id = ?'); args.push(q.request_type_id); }
  if (q.priority) { where.push('r.priority = ?'); args.push(q.priority); }
  if (q.status) { where.push('r.status = ?'); args.push(q.status); }
  if (extraWhere) where.push(extraWhere);
  const rows = await query<any>(`SELECT r.*, t.type_name, u.full_name AS requester, d.dept_name, ap.full_name AS approver,
        tr.trip_no, tr.status AS trip_status, v.registration_no AS vehicle_no, v.ownership_type, du.full_name AS driver_name,
        (SELECT i.description FROM trx_transport_trip_issue i WHERE i.trip_id = r.current_trip_id ORDER BY i.id DESC LIMIT 1) AS last_issue,
        (SELECT MAX(sr.done_at) FROM trx_transport_stop_request sr WHERE sr.request_id = r.id AND sr.service_type = 'DELIVERY' AND sr.result IN ('DONE','PARTIAL')) AS delivered_at
      FROM trx_transport_request r JOIN cfg_transport_request_type t ON t.id = r.request_type_id JOIN mst_user u ON u.id = r.requested_by
      LEFT JOIN mst_department d ON d.id = r.department_id LEFT JOIN mst_user ap ON ap.id = r.approved_by
      LEFT JOIN trx_transport_trip tr ON tr.id = r.current_trip_id LEFT JOIN mst_transport_vehicle v ON v.id = tr.vehicle_id
      LEFT JOIN mst_transport_driver dr ON dr.id = tr.driver_id LEFT JOIN mst_user du ON du.id = dr.user_id
     WHERE ${where.join(' AND ')} ORDER BY r.required_at DESC, r.id DESC`, args);
  return { rows, r };
}

gateReportsRouter.get('/transport-requests', ah(async (req, res) => {
  must(req, P.VIEW);
  const q = reqFilters.parse(req.query);
  const { rows, r } = await requestRows(req, q);
  const now = new Date();
  const final = ['COMPLETED', 'RECEIVED', 'CANCELLED', 'REJECTED'];
  const data = rows.map((x) => ({
    id: x.id, request_no: x.request_no, required_at: istText(x.required_at), type_name: x.type_name, priority: x.priority, status: x.status,
    requester: x.requester, department: x.dept_name, purpose: x.purpose, pickup: x.pickup_location, destination: x.destination_location,
    material: x.material_description, package_qty: x.package_qty, submitted_at: istText(x.submitted_at), approver: x.approver, approved_at: istText(x.approved_at),
    approval_hours: hoursBetween(x.submitted_at, x.approved_at ?? x.rejected_at),
    ageing_hours: final.includes(x.status) ? null : hoursBetween(x.submitted_at, now),
    turnaround_hours: ['COMPLETED', 'RECEIVED'].includes(x.status) ? hoursBetween(x.submitted_at, x.completed_at) : null,
    completed_at: istText(x.completed_at),
    // requester's confirmation (client 05-Nov-2026)
    received_at: istText(x.received_at), received_condition: x.received_condition ?? null, received_qty: x.received_qty ?? null, trip_no: x.trip_no, vehicle_no: x.vehicle_no, ownership: x.ownership_type, driver: x.driver_name,
    reason: x.rejection_reason ?? x.cancel_reason ?? null,
  }));
  res.json({ data, meta: { footnotes: [`Required between ${r.from} and ${r.to}; drafts excluded. Hours are clock hours from submission.`] } });
}));

gateReportsRouter.get('/pending-requests', ah(async (req, res) => {
  must(req, P.VIEW);
  const q = reqFilters.extend({ from: ymd, to: ymd }).parse(req.query);
  // open requests regardless of date unless a range is given
  const r0 = q.from || q.to ? q : { ...q, from: '2000-01-01', to: '2999-12-31' };
  const { rows } = await requestRows(req, r0, `r.status IN ('SUBMITTED','UNDER_REVIEW','CLARIFICATION_REQUIRED','APPROVED','ASSIGNED','IN_PROGRESS','PICKUP_COMPLETED','DELIVERED')`);
  const now = new Date();
  const data = rows.map((x) => {
    const overdue = hoursBetween(x.required_at, now);
    return {
      id: x.id, request_no: x.request_no, required_at: istText(x.required_at), type_name: x.type_name, priority: x.priority, status: x.status,
      requester: x.requester, department: x.dept_name, purpose: x.purpose, ageing_hours: hoursBetween(x.submitted_at, now),
      overdue_hours: overdue != null && overdue > 0 ? overdue : 0, delayed: overdue != null && overdue > 0 ? 'Y' : 'N',
      delay_reason: x.last_issue ?? (x.status === 'CLARIFICATION_REQUIRED' ? `Clarification: ${x.clarification_question}` : x.status === 'APPROVED' ? 'Vehicle not allocated yet' : x.status === 'SUBMITTED' ? 'Not reviewed yet' : null),
      coordinator: x.approver, trip_no: x.trip_no, vehicle_no: x.vehicle_no, driver: x.driver_name,
    };
  }).sort((a, b) => b.overdue_hours - a.overdue_hours);
  res.json({ data, meta: { footnotes: [`${data.filter((d) => d.delayed === 'Y').length} of ${data.length} open requests are past their required time.`] } });
}));

gateReportsRouter.get('/requests-by-department', ah(async (req, res) => {
  must(req, P.VIEW);
  const q = reqFilters.parse(req.query);
  const { rows, r } = await requestRows(req, q);
  const map = new Map<string, any>();
  for (const x of rows) {
    const k = `${x.dept_name ?? '—'}|${x.requester}`;
    const g = map.get(k) ?? { department: x.dept_name ?? '—', requester: x.requester, total: 0, completed: 0, open: 0, rejected: 0, cancelled: 0, urgent: 0, turnaround_sum: 0 };
    g.total++;
    if (x.status === 'COMPLETED' || x.status === 'RECEIVED') { g.completed++; g.turnaround_sum += hoursBetween(x.submitted_at, x.completed_at) ?? 0; }
    else if (x.status === 'REJECTED') g.rejected++;
    else if (x.status === 'CANCELLED') g.cancelled++;
    else g.open++;
    if (x.priority !== 'NORMAL') g.urgent++;
    map.set(k, g);
  }
  const data = [...map.values()].map(({ turnaround_sum, ...g }) => ({ ...g, avg_turnaround_hours: g.completed ? round2(turnaround_sum / g.completed) : null }))
    .sort((a, b) => String(a.department).localeCompare(String(b.department)) || b.total - a.total);
  res.json({ data, meta: { footnotes: [`Requests required between ${r.from} and ${r.to}; drafts excluded.`] } });
}));

/* ====================================================================== trips */
const tripFilters = z.object({ from: ymd, to: ymd, driver_id: z.coerce.number().optional(), vehicle_id: z.coerce.number().optional(), status: z.string().optional(), ownership_type: z.string().optional() });
async function tripRows(req: Request, q: z.infer<typeof tripFilters>) {
  const r = range(q);
  const where = ['t.company_id = ?', 't.planned_start_at >= ?', 't.planned_start_at < ?', `t.status <> 'DRAFT'`]; const args: unknown[] = [req.user!.companyId, r.start, r.end];
  if (q.driver_id) { where.push('t.driver_id = ?'); args.push(q.driver_id); }
  if (q.vehicle_id) { where.push('t.vehicle_id = ?'); args.push(q.vehicle_id); }
  if (q.status) { where.push('t.status = ?'); args.push(q.status); }
  if (q.ownership_type) { where.push('v.ownership_type = ?'); args.push(q.ownership_type); }
  const rows = await query<any>(`SELECT t.*, v.registration_no AS vehicle_no, v.ownership_type, v.vehicle_type, du.full_name AS driver_name,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1) AS stops,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1 AND s.status = 'COMPLETED') AS stops_completed,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1 AND s.status = 'FAILED') AS stops_failed,
      (SELECT COUNT(DISTINCT x.request_id) FROM trx_transport_trip_request x WHERE x.trip_id = t.id AND (x.is_active = 1 OR x.unlink_reason NOT LIKE 'Removed%')) AS requests,
      (SELECT GROUP_CONCAT(DISTINCT r.request_no ORDER BY r.request_no SEPARATOR ', ') FROM trx_transport_trip_request x JOIN trx_transport_request r ON r.id = x.request_id WHERE x.trip_id = t.id AND x.is_active = 1) AS request_nos,
      (SELECT COUNT(*) FROM trx_transport_trip_issue i WHERE i.trip_id = t.id) AS issues
    FROM trx_transport_trip t LEFT JOIN mst_transport_vehicle v ON v.id = t.vehicle_id LEFT JOIN mst_transport_driver d ON d.id = t.driver_id LEFT JOIN mst_user du ON du.id = d.user_id
   WHERE ${where.join(' AND ')} ORDER BY t.planned_start_at, t.id`, args);
  return { rows, r };
}
const km = (t: any) => (t.start_odometer != null && t.end_odometer != null ? round2(Number(t.end_odometer) - Number(t.start_odometer)) : null);

gateReportsRouter.get('/trip-sheet', ah(async (req, res) => {
  must(req, P.VIEW);
  const q = tripFilters.parse(req.query);
  const { rows, r } = await tripRows(req, q);
  const data = rows.map((t) => ({
    id: t.id, trip_no: t.trip_no, trip_date: istText(t.planned_start_at)?.slice(0, 10), status: t.status, vehicle_no: t.vehicle_no, ownership: t.ownership_type, driver: t.driver_name,
    purpose: t.purpose, origin: t.origin, destination: t.destination, planned_start: istText(t.planned_start_at), planned_end: istText(t.planned_end_at),
    actual_start: istText(t.started_at), actual_end: istText(t.completed_at), planned_hours: hoursBetween(t.planned_start_at, t.planned_end_at),
    actual_hours: hoursBetween(t.started_at, t.completed_at), start_delay_min: t.started_at ? Math.round((new Date(t.started_at).getTime() - new Date(t.planned_start_at).getTime()) / 60000) : null,
    stops: num(t.stops), stops_completed: num(t.stops_completed), stops_failed: num(t.stops_failed), requests: num(t.requests), request_nos: t.request_nos,
    start_odometer: t.start_odometer, end_odometer: t.end_odometer, km: km(t), issues: num(t.issues), exception: t.exception_closed ? 'Y' : 'N',
    remarks: t.exception_reason ?? t.cancellation_reason ?? t.driver_reject_reason ?? null,
  }));
  res.json({ data, meta: { footnotes: [`Trips planned between ${r.from} and ${r.to}; drafts excluded. Start delay = actual start − planned start (minutes).`] } });
}));

gateReportsRouter.get('/vehicle-utilisation', ah(async (req, res) => {
  must(req, P.VIEW);
  const q = tripFilters.parse(req.query);
  const { rows, r } = await tripRows(req, { ...q, status: undefined });
  const vehicles = await query<any>(`SELECT v.* FROM mst_transport_vehicle v WHERE v.company_id = ? ${q.ownership_type ? 'AND v.ownership_type = ?' : ''} ${q.vehicle_id ? 'AND v.id = ?' : ''} ORDER BY v.vehicle_code`,
    [req.user!.companyId, ...(q.ownership_type ? [q.ownership_type] : []), ...(q.vehicle_id ? [q.vehicle_id] : [])]);
  const days = Math.round((r.end.getTime() - r.start.getTime()) / 86_400_000);
  const data = vehicles.map((v) => {
    const ts = rows.filter((t) => Number(t.vehicle_id) === Number(v.id));
    const done = ts.filter((t) => t.status === 'COMPLETED');
    const assignedHours = ts.filter((t) => t.status !== 'CANCELLED').reduce((a, t) => a + (hoursBetween(t.planned_start_at, t.planned_end_at) ?? 0), 0);
    const actualHours = done.reduce((a, t) => a + (hoursBetween(t.started_at, t.completed_at) ?? 0), 0);
    return {
      id: v.id, vehicle_code: v.vehicle_code, vehicle_no: v.registration_no, ownership: v.ownership_type, vehicle_type: v.vehicle_type, rental_provider: v.rental_provider_name,
      current_status: !v.is_active ? 'INACTIVE' : v.availability_status, trips: ts.length, completed: done.length, cancelled: ts.filter((t) => t.status === 'CANCELLED').length,
      in_progress: ts.filter((t) => ACTIVE_TRIP.includes(t.status)).length, assigned_hours: round2(assignedHours), actual_hours: round2(actualHours),
      km: round2(done.reduce((a, t) => a + (km(t) ?? 0), 0)), issues: ts.reduce((a, t) => a + num(t.issues), 0),
      utilisation_pct: days > 0 ? round2((assignedHours / (days * 10)) * 100) : null,
    };
  });
  res.json({ data, meta: { footnotes: [`${r.from} to ${r.to} (${days} days). Utilisation % = assigned (planned) hours ÷ (days × 10 working hours).`,
    'Downtime (maintenance days) is not tracked in Phase 1 — current status shows Maintenance / Inactive.'] } });
}));

gateReportsRouter.get('/driver-utilisation', ah(async (req, res) => {
  must(req, P.VIEW);
  const q = tripFilters.parse(req.query);
  const { rows, r } = await tripRows(req, { ...q, status: undefined });
  const drivers = await query<any>(`SELECT d.*, u.full_name FROM mst_transport_driver d JOIN mst_user u ON u.id = d.user_id WHERE d.company_id = ? ${q.driver_id ? 'AND d.id = ?' : ''} ORDER BY u.full_name`,
    [req.user!.companyId, ...(q.driver_id ? [q.driver_id] : [])]);
  const rejByUser = await query<any>(`SELECT l.actor_user_id, COUNT(*) n FROM trx_transport_status_log l JOIN trx_transport_trip t ON t.id = l.entity_id
      WHERE l.company_id = ? AND l.entity_type = 'TRIP' AND l.event_code = 'DRIVER_REJECTED' AND t.planned_start_at >= ? AND t.planned_start_at < ? GROUP BY l.actor_user_id`, [req.user!.companyId, r.start, r.end]);
  const data = drivers.map((d) => {
    const ts = rows.filter((t) => Number(t.driver_id) === Number(d.id));
    const done = ts.filter((t) => t.status === 'COMPLETED');
    return {
      id: d.id, driver: d.full_name, mobile: d.mobile_no, licence_expiry: d.licence_expiry, current_status: !d.is_active ? 'INACTIVE' : d.availability_status,
      trips: ts.length, completed: done.length, cancelled: ts.filter((t) => t.status === 'CANCELLED').length,
      rejections: num(rejByUser.find((x) => Number(x.actor_user_id) === Number(d.user_id))?.n),
      assigned_hours: round2(ts.filter((t) => t.status !== 'CANCELLED').reduce((a, t) => a + (hoursBetween(t.planned_start_at, t.planned_end_at) ?? 0), 0)),
      actual_hours: round2(done.reduce((a, t) => a + (hoursBetween(t.started_at, t.completed_at) ?? 0), 0)),
      km: round2(done.reduce((a, t) => a + (km(t) ?? 0), 0)), issues: ts.reduce((a, t) => a + num(t.issues), 0),
    };
  });
  res.json({ data, meta: { footnotes: [`Trips planned between ${r.from} and ${r.to}. A trip the driver rejected and was reassigned counts under the new driver; the rejection stays with the one who rejected.`] } });
}));

gateReportsRouter.get('/service-performance', ah(async (req, res) => {
  must(req, P.VIEW);
  const q = reqFilters.parse(req.query);
  const { rows, r } = await requestRows(req, q);
  const ids = rows.map((x) => x.id);
  const lines = ids.length ? await query<any>(`SELECT sr.request_id, sr.service_type, sr.result, sr.done_at FROM trx_transport_stop_request sr
      JOIN trx_transport_trip_stop s ON s.id = sr.stop_id AND s.is_active = 1 WHERE sr.request_id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  const map = new Map<string, any>();
  for (const x of rows) {
    const g = map.get(x.type_name) ?? { request_type: x.type_name, requests: 0, completed: 0, on_time: 0, pickups_done: 0, deliveries_done: 0, partial: 0, failed: 0, completion_sum: 0 };
    g.requests++;
    const ls = lines.filter((l) => Number(l.request_id) === Number(x.id));
    g.pickups_done += ls.filter((l) => l.service_type === 'PICKUP' && ['DONE', 'PARTIAL'].includes(l.result)).length;
    g.deliveries_done += ls.filter((l) => l.service_type === 'DELIVERY' && ['DONE', 'PARTIAL'].includes(l.result)).length;
    g.partial += ls.filter((l) => l.result === 'PARTIAL').length;
    g.failed += ls.filter((l) => l.result === 'FAILED').length;
    if (x.status === 'COMPLETED' || x.status === 'RECEIVED') {
      g.completed++;
      g.completion_sum += hoursBetween(x.submitted_at, x.completed_at) ?? 0;
      const served = x.delivered_at ?? x.completed_at;
      if (served && new Date(served).getTime() <= new Date(x.required_at).getTime() + 30 * 60_000) g.on_time++;
    }
    map.set(x.type_name, g);
  }
  const data = [...map.values()].map(({ completion_sum, ...g }) => ({ ...g, on_time_pct: g.completed ? round2((g.on_time / g.completed) * 100) : null,
    avg_completion_hours: g.completed ? round2(completion_sum / g.completed) : null }));
  res.json({ data, meta: { footnotes: [`Requests required between ${r.from} and ${r.to}. On time = delivered (or completed) within 30 minutes of the required time.`] } });
}));

/* ====================================================================== dashboard (§10 KPIs) */
transportDashboardRouter.get('/dashboard', ah(async (req, res) => {
  must(req, P.VIEW);
  const cid = req.user!.companyId;
  const today = istToday();
  const t0 = istDayStart(today); const t1 = istDayEnd(today);
  const parts = Object.entries(QUEUES).map(([k, cond]) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) AS \`${k}\``);
  const counters = await queryOne<any>(`SELECT ${parts.join(', ')} FROM trx_transport_request r WHERE r.company_id = ?`, [t0, cid]);
  const trips = await queryOne<any>(`SELECT SUM(status IN ('STARTED','IN_PROGRESS')) running, SUM(status IN ('ASSIGNED','DRIVER_ACCEPTED')) planned, SUM(status = 'EXCEPTION') exceptions,
      SUM(status = 'COMPLETED' AND completed_at >= ? AND completed_at < ?) completed_today FROM trx_transport_trip WHERE company_id = ?`, [t0, t1, cid]);
  const month = `${today.slice(0, 7)}-01`;
  const own = await query<any>(`SELECT v.ownership_type, COUNT(*) n FROM trx_transport_trip t JOIN mst_transport_vehicle v ON v.id = t.vehicle_id
      WHERE t.company_id = ? AND t.status NOT IN ('DRAFT','CANCELLED') AND t.planned_start_at >= ? GROUP BY v.ownership_type`, [cid, istDayStart(month)]);
  const vehicles = await query<any>(`SELECT v.id, v.availability_status, v.is_active,
      EXISTS (SELECT 1 FROM trx_transport_trip t WHERE t.vehicle_id = v.id AND t.status IN ('STARTED','IN_PROGRESS')) busy FROM mst_transport_vehicle v WHERE v.company_id = ?`, [cid]);
  const drivers = await query<any>(`SELECT d.id, d.availability_status, d.is_active,
      EXISTS (SELECT 1 FROM trx_transport_trip t WHERE t.driver_id = d.id AND t.status IN ('STARTED','IN_PROGRESS')) busy FROM mst_transport_driver d WHERE d.company_id = ?`, [cid]);
  const schedule = await query<any>(`SELECT t.id, t.trip_no, t.status, t.planned_start_at, t.planned_end_at, t.purpose, v.registration_no AS vehicle_no, du.full_name AS driver_name,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1) stops,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1 AND s.status IN ('COMPLETED','FAILED')) stops_done
    FROM trx_transport_trip t LEFT JOIN mst_transport_vehicle v ON v.id = t.vehicle_id LEFT JOIN mst_transport_driver d ON d.id = t.driver_id LEFT JOIN mst_user du ON du.id = d.user_id
   WHERE t.company_id = ? AND t.status NOT IN ('DRAFT','CANCELLED') AND ((t.planned_start_at >= ? AND t.planned_start_at < ?) OR t.status IN ('STARTED','IN_PROGRESS','EXCEPTION'))
   ORDER BY t.planned_start_at`, [cid, t0, t1]);
  const queue = await query<any>(`SELECT r.id, r.request_no, r.status, r.priority, r.purpose, r.required_at, u.full_name AS requester, ty.type_name
      FROM trx_transport_request r JOIN mst_user u ON u.id = r.requested_by JOIN cfg_transport_request_type ty ON ty.id = r.request_type_id
     WHERE r.company_id = ? AND r.status IN ('SUBMITTED','UNDER_REVIEW','APPROVED') ORDER BY FIELD(r.priority,'CRITICAL','URGENT','NORMAL'), r.required_at LIMIT 15`, [cid]);
  const issues = await query<any>(`SELECT i.id, i.trip_id, i.issue_type, i.severity, i.description, i.reported_at, t.trip_no FROM trx_transport_trip_issue i JOIN trx_transport_trip t ON t.id = i.trip_id
     WHERE i.company_id = ? AND i.resolved_at IS NULL ORDER BY i.id DESC LIMIT 15`, [cid]);
  const expiring = await query<any>(`SELECT 'VEHICLE' kind, v.id, v.registration_no AS name, LEAST(COALESCE(v.insurance_expiry,'2999-12-31'), COALESCE(v.permit_expiry,'2999-12-31'), COALESCE(v.fitness_expiry,'2999-12-31'), COALESCE(v.pollution_expiry,'2999-12-31')) AS expiry
      FROM mst_transport_vehicle v WHERE v.company_id = ? AND v.is_active = 1
     UNION ALL SELECT 'DRIVER', d.id, u.full_name, d.licence_expiry FROM mst_transport_driver d JOIN mst_user u ON u.id = d.user_id WHERE d.company_id = ? AND d.is_active = 1`, [cid, cid]);
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  res.json({ data: {
    kpis: {
      new_requests: num(counters?.NEW), under_review: num(counters?.UNDER_REVIEW), approved_unassigned: num(counters?.APPROVED_UNASSIGNED), assigned: num(counters?.ASSIGNED),
      in_progress: num(counters?.IN_PROGRESS), delayed: num(counters?.DELAYED), completed_today: num(counters?.COMPLETED_TODAY), rejected: num(counters?.REJECTED),
      trips_running: num(trips?.running), trips_planned: num(trips?.planned), trip_exceptions: num(trips?.exceptions), trips_completed_today: num(trips?.completed_today),
      available_vehicles: vehicles.filter((v) => Number(v.is_active) && v.availability_status === 'AVAILABLE' && !Number(v.busy)).length, vehicles: vehicles.filter((v) => Number(v.is_active)).length,
      available_drivers: drivers.filter((d) => Number(d.is_active) && d.availability_status === 'AVAILABLE' && !Number(d.busy)).length, drivers: drivers.filter((d) => Number(d.is_active)).length,
      owned_trips_month: num(own.find((o) => o.ownership_type === 'OWNED')?.n), rental_trips_month: num(own.find((o) => o.ownership_type === 'RENTAL')?.n),
      open_issues: issues.length,
      pending_receipt: num(counters?.PENDING_RECEIPT), received: num(counters?.RECEIVED),
    },
    schedule, queue, issues,
    expiring: expiring.filter((e) => String(e.expiry).slice(0, 10) <= soon).map((e) => ({ ...e, expiry: String(e.expiry).slice(0, 10), expired: String(e.expiry).slice(0, 10) < today })),
  } });
}));
