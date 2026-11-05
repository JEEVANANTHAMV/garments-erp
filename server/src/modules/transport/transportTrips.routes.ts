/**
 * Trip / program planning (spec §4.5, §8.3) and the driver screen API (§4.6).
 *   /api/transport/trips…       coordinator: plan, assign driver + vehicle + requests + ordered stops, reassign, cancel,
 *                               exception close, resolve issues; /api/transport/availability for the planner.
 *   /api/driver/…               the signed-in driver's own trips only (user → driver profile), milestone actions with
 *                               idempotency keys (a retried tap never duplicates events or notifications).
 *
 * Assignment runs in one transaction: trip, driver, vehicle and request rows are locked FOR UPDATE before the overlap
 * check and the writes, so two coordinators can never double-book a driver or a vehicle.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute, txQuery, txQueryOne, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { audit } from '../../core/audit.js';
import { Conflict, Forbidden, NotFound, Unprocessable } from '../../core/errors.js';
import {
  P, has, must, assertFrom, assertVersion, zBizTime, nextTransportNo, logStatus, notify, planners, lockTrip, overlapping,
  expiryWarnings, refreshRequestFromLines, retryDeadlock, tripRequesters, istDayStart, istDayEnd, istText, humanStatus, ACTIVE_TRIP, type TripStatus,
  deliveryPhotoOn,
} from './transportCore.js';

export const transportTripsRouter = Router();
export const driverRouter = Router();

const idOf = (v: unknown) => z.coerce.number().int().positive().parse(v);
const optStr = (max: number) => z.union([z.string().trim().max(max), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish();
const optTime = z.union([zBizTime, z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish();
const photoUrl = z.string().trim().regex(/^\/uploads\/(attachments|documents)\/[\w.-]+$/, 'Upload the photo first').max(300);

/* ====================================================================== plan payload */
const stopSchema = z.object({
  stop_type: z.enum(['PICKUP', 'DELIVERY', 'PICKUP_DELIVERY', 'OTHER']),
  location_name: z.string().trim().min(2, 'Stop location is required').max(160),
  address: optStr(500), expected_arrival_at: optTime,
  contact_name: optStr(80), contact_mobile: optStr(20),
  is_mandatory: z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).default(1),
  remarks: optStr(500),
  request_ids: z.array(z.coerce.number().int().positive()).optional(),
  requests: z.array(z.object({ request_id: z.coerce.number().int().positive(), service_type: z.enum(['PICKUP', 'DELIVERY']), expected_qty: z.coerce.number().min(0).nullish() })).optional(),
});
const planSchema = z.object({
  planned_start_at: zBizTime, planned_end_at: zBizTime,
  origin: optStr(160), destination: optStr(160), purpose: optStr(255), remarks: optStr(1000),
  driver_id: z.coerce.number().int().positive('Select the driver'),
  vehicle_id: z.coerce.number().int().positive('Select the vehicle'),
  request_ids: z.array(z.coerce.number().int().positive()).min(1, 'Attach at least one approved request').max(50),
  stops: z.array(stopSchema).max(60).optional(),
  row_version: z.coerce.number().int().nullish(),
}).refine((b) => b.planned_end_at > b.planned_start_at, { message: 'Planned end must be after planned start', path: ['planned_end_at'] });
type Plan = z.infer<typeof planSchema>;
const draftSchema = z.object({
  planned_start_at: zBizTime, planned_end_at: zBizTime,
  origin: optStr(160), destination: optStr(160), purpose: optStr(255), remarks: optStr(1000),
  row_version: z.coerce.number().int().nullish(),
}).refine((b) => b.planned_end_at > b.planned_start_at, { message: 'Planned end must be after planned start', path: ['planned_end_at'] });

const tripUrl = (id: number) => `/transport/trips/${id}`;
const driverUrl = (id: number) => `/driver/trips/${id}`;

/** Lock and validate a driver for the window: active staff, available, licence valid; returns user id + warnings. */
async function lockDriver(tx: Tx, companyId: number, driverId: number, start: Date) {
  const d = await txQueryOne<any>(tx, `SELECT d.*, u.full_name, u.is_active AS user_active, u.is_deleted AS user_deleted
      FROM mst_transport_driver d JOIN mst_user u ON u.id = d.user_id WHERE d.id = ? AND d.company_id = ? FOR UPDATE`, [driverId, companyId]);
  if (!d) throw Unprocessable('Driver not found', [{ field: 'driver_id', message: 'Driver not found' }]);
  if (!Number(d.is_active) || !Number(d.user_active) || Number(d.user_deleted)) throw Conflict(`Driver ${d.full_name} is inactive`);
  if (d.availability_status !== 'AVAILABLE') throw Conflict(`Driver ${d.full_name} is ${humanStatus(d.availability_status).toLowerCase()}`);
  const exp = expiryWarnings('driver', d, start);
  if (exp.length) throw Conflict(`Driver ${d.full_name}: ${exp.join(', ')} — not eligible`);
  return d;
}
async function lockVehicle(tx: Tx, companyId: number, vehicleId: number, start: Date) {
  const v = await txQueryOne<any>(tx, `SELECT * FROM mst_transport_vehicle WHERE id = ? AND company_id = ? FOR UPDATE`, [vehicleId, companyId]);
  if (!v) throw Unprocessable('Vehicle not found', [{ field: 'vehicle_id', message: 'Vehicle not found' }]);
  if (!Number(v.is_active)) throw Conflict(`Vehicle ${v.registration_no} is inactive`);
  if (v.availability_status !== 'AVAILABLE') throw Conflict(`Vehicle ${v.registration_no} is under ${humanStatus(v.availability_status).toLowerCase()}`);
  return { v, warnings: expiryWarnings('vehicle', v, start).map((w) => `${v.registration_no}: ${w}`) };
}
async function assertNoOverlap(tx: Tx, companyId: number, tripId: number, start: Date, end: Date, driverId: number | null, vehicleId: number | null) {
  const clash = await overlapping(tx, companyId, start, end, { driverId, vehicleId }, tripId);
  if (clash.length) {
    const lines = clash.map((t) => `${t.trip_no} (${humanStatus(t.status)}, ${istText(t.planned_start_at)} – ${istText(t.planned_end_at)}) uses the same ${driverId && Number(t.driver_id) === driverId ? 'driver' : 'vehicle'}`);
    throw Conflict(`Double booking: ${lines.join('; ')}`, { conflicts: clash });
  }
}

/** Ordered stops: as sent, or generated from the requests (a pickup stop per pickup place, then a drop per destination). */
function buildStops(plan: Plan, reqs: any[]) {
  if (plan.stops?.length) {
    return plan.stops.map((s, i) => {
      const lines = s.requests?.length ? s.requests
        : (s.request_ids ?? []).map((rid) => ({ request_id: rid, service_type: (s.stop_type === 'DELIVERY' ? 'DELIVERY' : 'PICKUP') as 'PICKUP' | 'DELIVERY', expected_qty: null as number | null | undefined }));
      return { ...s, stop_no: i + 1, lines };
    });
  }
  type Gen = { stop_type: 'PICKUP' | 'DELIVERY'; location_name: string; address: string | null; contact_name: string | null; contact_mobile: string | null; is_mandatory: number; lines: { request_id: number; service_type: 'PICKUP' | 'DELIVERY'; expected_qty: number | null }[] };
  const pick: Gen[] = []; const drop: Gen[] = [];
  const add = (arr: Gen[], type: 'PICKUP' | 'DELIVERY', name: string, addr: string | null, r: any) => {
    const key = `${name}|${addr ?? ''}`.toLowerCase();
    let s = arr.find((x) => `${x.location_name}|${x.address ?? ''}`.toLowerCase() === key);
    if (!s) { s = { stop_type: type, location_name: name, address: addr, contact_name: r.contact_name, contact_mobile: r.contact_mobile, is_mandatory: 1, lines: [] }; arr.push(s); }
    s.lines.push({ request_id: r.id, service_type: type, expected_qty: r.package_qty ?? null });
  };
  for (const r of reqs) {
    if (r.pickup_location) add(pick, 'PICKUP', r.pickup_location, r.pickup_address, r);
    if (r.destination_location) add(drop, 'DELIVERY', r.destination_location, r.destination_address, r);
    if (!r.pickup_location && !r.destination_location) add(drop, 'DELIVERY', r.purpose.slice(0, 160), null, r);
  }
  return [...pick, ...drop].map((s, i) => ({ ...s, stop_no: i + 1, expected_arrival_at: null as Date | null, remarks: null as string | null }));
}

/**
 * Assign / re-plan a trip that has not started: lock trip → driver → vehicle → requests, check overlaps and request
 * states, then replace the request links and stops. Requests leaving the trip go back to the approved queue.
 */
async function assignPlan(tx: Tx, req: Request, trip: any, plan: Plan): Promise<string[]> {
  const cid = req.user!.companyId;
  const notices: string[] = [];
  assertFrom<TripStatus>(trip.status, ['DRAFT', 'ASSIGNED', 'DRIVER_ACCEPTED', 'EXCEPTION'], 'assign this trip');
  const start = plan.planned_start_at; const end = plan.planned_end_at;
  const driver = await lockDriver(tx, cid, plan.driver_id, start);
  const { v: vehicle, warnings } = await lockVehicle(tx, cid, plan.vehicle_id, start);
  notices.push(...warnings);
  await assertNoOverlap(tx, cid, trip.id, start, end, plan.driver_id, plan.vehicle_id);

  const ids = [...new Set(plan.request_ids)].sort((a, b) => a - b);
  const reqs = await txQuery<any>(tx, `SELECT r.*, t.type_name FROM trx_transport_request r JOIN cfg_transport_request_type t ON t.id = r.request_type_id
      WHERE r.company_id = ? AND r.id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id FOR UPDATE`, [cid, ...ids]);
  if (reqs.length !== ids.length) throw Unprocessable('Some requests were not found', [{ field: 'request_ids', message: 'Request not found' }]);
  for (const r of reqs) {
    const onThis = r.status === 'ASSIGNED' && Number(r.current_trip_id) === Number(trip.id);
    if (!onThis && r.status !== 'APPROVED') {
      throw Conflict(r.current_trip_id && Number(r.current_trip_id) !== Number(trip.id)
        ? `${r.request_no} is already on another trip`
        : `${r.request_no} is ${humanStatus(r.status).toLowerCase()} — only approved requests can be assigned`, { request_id: r.id });
    }
    const req_at = new Date(r.required_at).getTime();
    if (req_at < start.getTime() - 4 * 3_600_000 || req_at > end.getTime()) notices.push(`${r.request_no} is needed at ${istText(r.required_at)} — outside the trip window`);
  }
  const stops = buildStops(plan, reqs);
  const covered = new Set(stops.flatMap((s) => s.lines.map((l) => l.request_id)));
  for (const s of stops) for (const l of s.lines) if (!ids.includes(l.request_id)) throw Unprocessable(`Stop ${s.stop_no} lists a request that is not on the trip`);
  const missing = reqs.filter((r) => !covered.has(r.id));
  if (missing.length) throw Unprocessable(`Add a stop for ${missing.map((r) => r.request_no).join(', ')}`);

  const now = new Date();
  // requests leaving the trip go back to the queue
  const oldLinks = await txQuery<any>(tx, `SELECT tr.request_id, r.status, r.request_no FROM trx_transport_trip_request tr JOIN trx_transport_request r ON r.id = tr.request_id
      WHERE tr.trip_id = ? AND tr.is_active = 1 FOR UPDATE`, [trip.id]);
  for (const l of oldLinks.filter((x) => !ids.includes(Number(x.request_id)))) {
    await txExecute(tx, `UPDATE trx_transport_trip_request SET is_active = 0, unlinked_by = ?, unlinked_at = ?, unlink_reason = 'Removed from trip' WHERE trip_id = ? AND request_id = ? AND is_active = 1`, [req.user!.id, now, trip.id, l.request_id]);
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'APPROVED', current_trip_id = NULL, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [req.user!.id, l.request_id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: l.request_id, tripId: trip.id, from: l.status, to: 'APPROVED', event: 'REMOVED_FROM_TRIP', note: trip.trip_no });
  }
  let seq = 0;
  for (const r of reqs) {
    seq++;
    const linked = oldLinks.some((x) => Number(x.request_id) === r.id);
    if (linked) await txExecute(tx, `UPDATE trx_transport_trip_request SET sequence_no = ? WHERE trip_id = ? AND request_id = ? AND is_active = 1`, [seq, trip.id, r.id]);
    else {
      await txExecute(tx, `INSERT INTO trx_transport_trip_request (company_id, trip_id, request_id, sequence_no, is_active, linked_by, linked_at) VALUES (?,?,?,?,1,?,?)`, [cid, trip.id, r.id, seq, req.user!.id, now]);
      await txExecute(tx, `UPDATE trx_transport_request SET status = 'ASSIGNED', current_trip_id = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [trip.id, req.user!.id, r.id]);
      await logStatus(tx, req, { entity: 'REQUEST', id: r.id, tripId: trip.id, from: r.status, to: 'ASSIGNED', event: 'ASSIGNED', note: `${trip.trip_no} · ${vehicle.registration_no} · ${driver.full_name}` });
    }
  }
  // stops: the plan is replaced (old stops are kept inactive for history)
  await txExecute(tx, `UPDATE trx_transport_trip_stop SET is_active = 0, status = 'CANCELLED' WHERE trip_id = ? AND is_active = 1`, [trip.id]);
  for (const s of stops) {
    const ins = await txExecute(tx, `INSERT INTO trx_transport_trip_stop (company_id, trip_id, stop_no, stop_type, location_name, address, expected_arrival_at, contact_name, contact_mobile, is_mandatory, remarks)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [cid, trip.id, s.stop_no, s.stop_type, s.location_name, s.address ?? null, s.expected_arrival_at ?? null, s.contact_name ?? null, s.contact_mobile ?? null, s.is_mandatory ?? 1, s.remarks ?? null]);
    const seen = new Set<string>();
    for (const l of s.lines) {
      const k = `${l.request_id}|${l.service_type}`; if (seen.has(k)) continue; seen.add(k);
      await txExecute(tx, `INSERT INTO trx_transport_stop_request (company_id, stop_id, request_id, service_type, expected_qty) VALUES (?,?,?,?,?)`, [cid, ins.insertId, l.request_id, l.service_type, l.expected_qty ?? null]);
    }
  }
  const driverChanged = Number(trip.driver_id) !== plan.driver_id;
  const vehicleChanged = Number(trip.vehicle_id) !== plan.vehicle_id;
  const keepAccepted = trip.status === 'DRIVER_ACCEPTED' && !driverChanged;
  const next: TripStatus = keepAccepted ? 'DRIVER_ACCEPTED' : 'ASSIGNED';
  await txExecute(tx, `UPDATE trx_transport_trip SET status = ?, planned_start_at = ?, planned_end_at = ?, origin = ?, destination = ?, purpose = ?, remarks = ?,
      driver_id = ?, vehicle_id = ?, assigned_by = ?, assigned_at = ?, accepted_at = IF(?, accepted_at, NULL), driver_rejected_at = IF(?, NULL, driver_rejected_at),
      row_version = row_version + 1, updated_by = ? WHERE id = ?`,
    [next, start, end, plan.origin ?? stops[0]?.location_name ?? null, plan.destination ?? stops[stops.length - 1]?.location_name ?? null, plan.purpose ?? null, plan.remarks ?? null,
      plan.driver_id, plan.vehicle_id, req.user!.id, now, keepAccepted ? 1 : 0, driverChanged ? 1 : 0, req.user!.id, trip.id]);
  await logStatus(tx, req, { entity: 'TRIP', id: trip.id, tripId: trip.id, from: trip.status, to: next, event: trip.status === 'DRAFT' ? 'ASSIGNED' : 'REPLANNED',
    note: `${vehicle.registration_no} (${vehicle.ownership_type.toLowerCase()}) · ${driver.full_name} · ${stops.length} stop(s) · ${reqs.length} request(s)`,
    before: trip.status === 'DRAFT' ? undefined : { driver_id: trip.driver_id, vehicle_id: trip.vehicle_id, planned_start_at: trip.planned_start_at, planned_end_at: trip.planned_end_at },
    after: { driver_id: plan.driver_id, vehicle_id: plan.vehicle_id, planned_start_at: start, planned_end_at: end, request_ids: ids } });
  await audit(req, 'trx_transport_trip', trip.id, 'UPDATE', { status: trip.status, driver_id: trip.driver_id, vehicle_id: trip.vehicle_id },
    { status: next, driver_id: plan.driver_id, vehicle_id: plan.vehicle_id, request_ids: ids, stops: stops.length }, tx);

  const body = `${vehicle.registration_no} · driver ${driver.full_name} · reporting ${istText(start)} · ${stops.length} stop(s)`;
  if (driverChanged || trip.status === 'DRAFT' || trip.status === 'EXCEPTION') {
    await notify(tx, req, [driver.user_id], { key: `TRIP:${trip.id}:ASSIGNED:${trip.row_version}`, refType: 'TRANSPORT_TRIP', refId: trip.id, url: driverUrl(trip.id), title: `New trip ${trip.trip_no} assigned to you`, body });
    if (trip.driver_id && driverChanged) {
      const old = await txQueryOne<any>(tx, `SELECT user_id FROM mst_transport_driver WHERE id = ?`, [trip.driver_id]);
      await notify(tx, req, [old?.user_id], { key: `TRIP:${trip.id}:UNASSIGNED:${trip.row_version}`, refType: 'TRANSPORT_TRIP', refId: trip.id, url: driverUrl(trip.id), title: `Trip ${trip.trip_no} moved to another driver`, body: '' });
    }
  } else if (vehicleChanged) {
    await notify(tx, req, [driver.user_id], { key: `TRIP:${trip.id}:CHANGED:${trip.row_version}`, refType: 'TRANSPORT_TRIP', refId: trip.id, url: driverUrl(trip.id), title: `Trip ${trip.trip_no} changed`, body });
  }
  for (const r of reqs) {
    await notify(tx, req, [r.requested_by], { key: `TRN:${r.id}:ALLOCATED:${trip.id}:${plan.driver_id}:${plan.vehicle_id}`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: `/transport/requests/${r.id}`,
      title: `Vehicle allocated for ${r.request_no}`, body: `Trip ${trip.trip_no} · ${body}` });
  }
  return notices;
}

/* ====================================================================== trips: list / detail */
transportTripsRouter.get('/trips', ah(async (req, res) => {
  must(req, P.VIEW, P.ASSIGN);
  const q = z.object({
    status: z.string().optional(), driver_id: z.coerce.number().optional(), vehicle_id: z.coerce.number().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), q: z.string().optional(),
  }).parse(req.query);
  const where = ['t.company_id = ?']; const args: unknown[] = [req.user!.companyId];
  if (q.status) { const st = q.status.split(',').filter(Boolean); where.push(`t.status IN (${st.map(() => '?').join(',')})`); args.push(...st); }
  if (q.driver_id) { where.push('t.driver_id = ?'); args.push(q.driver_id); }
  if (q.vehicle_id) { where.push('t.vehicle_id = ?'); args.push(q.vehicle_id); }
  if (q.from) { where.push('t.planned_start_at >= ?'); args.push(istDayStart(q.from)); }
  if (q.to) { where.push('t.planned_start_at < ?'); args.push(istDayEnd(q.to)); }
  if (q.q) { where.push('(t.trip_no LIKE ? OR v.registration_no LIKE ? OR du.full_name LIKE ? OR t.purpose LIKE ? OR EXISTS (SELECT 1 FROM trx_transport_trip_request x JOIN trx_transport_request r ON r.id = x.request_id WHERE x.trip_id = t.id AND r.request_no LIKE ?))'); const l = `%${q.q}%`; args.push(l, l, l, l, l); }
  const rows = await query(`SELECT t.*, v.registration_no AS vehicle_no, v.ownership_type, v.vehicle_type, du.full_name AS driver_name, d.mobile_no AS driver_mobile,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1) AS stop_count,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1 AND s.status IN ('COMPLETED','FAILED')) AS stops_done,
      (SELECT COUNT(*) FROM trx_transport_trip_request x WHERE x.trip_id = t.id AND x.is_active = 1) AS request_count,
      (SELECT GROUP_CONCAT(r.request_no ORDER BY x.sequence_no SEPARATOR ', ') FROM trx_transport_trip_request x JOIN trx_transport_request r ON r.id = x.request_id WHERE x.trip_id = t.id AND x.is_active = 1) AS request_nos,
      (SELECT COUNT(*) FROM trx_transport_trip_issue i WHERE i.trip_id = t.id AND i.resolved_at IS NULL) AS open_issues
    FROM trx_transport_trip t LEFT JOIN mst_transport_vehicle v ON v.id = t.vehicle_id LEFT JOIN mst_transport_driver d ON d.id = t.driver_id LEFT JOIN mst_user du ON du.id = d.user_id
    WHERE ${where.join(' AND ')} ORDER BY FIELD(t.status,'IN_PROGRESS','STARTED','DRIVER_ACCEPTED','ASSIGNED','EXCEPTION','DRAFT','COMPLETED','CANCELLED'), t.planned_start_at DESC LIMIT 500`, args);
  res.json({ data: rows });
}));

async function tripDetail(companyId: number, id: number) {
  const t = await queryOne<any>(`SELECT t.*, v.registration_no AS vehicle_no, v.vehicle_code, v.ownership_type, v.vehicle_type, v.make, v.model, v.rental_provider_name,
      du.full_name AS driver_name, d.mobile_no AS driver_mobile, d.user_id AS driver_user_id, ab.full_name AS assigned_by_name
    FROM trx_transport_trip t LEFT JOIN mst_transport_vehicle v ON v.id = t.vehicle_id LEFT JOIN mst_transport_driver d ON d.id = t.driver_id
    LEFT JOIN mst_user du ON du.id = d.user_id LEFT JOIN mst_user ab ON ab.id = t.assigned_by
   WHERE t.id = ? AND t.company_id = ?`, [id, companyId]);
  if (!t) return null;
  const [stops, lines, requests, timeline, issues, proofs] = await Promise.all([
    query(`SELECT * FROM trx_transport_trip_stop WHERE trip_id = ? AND is_active = 1 ORDER BY stop_no`, [id]),
    query(`SELECT sr.*, r.request_no, r.purpose, r.contact_name, r.contact_mobile, r.material_description, r.package_uom, r.status AS request_status, ty.type_name, ty.requires_proof
             FROM trx_transport_stop_request sr JOIN trx_transport_trip_stop s ON s.id = sr.stop_id AND s.is_active = 1 AND s.trip_id = ?
             JOIN trx_transport_request r ON r.id = sr.request_id JOIN cfg_transport_request_type ty ON ty.id = r.request_type_id ORDER BY sr.id`, [id]),
    query(`SELECT r.id, r.request_no, r.status, r.priority, r.purpose, r.required_at, r.pickup_location, r.destination_location, r.contact_name, r.contact_mobile,
                  r.material_description, r.package_qty, r.package_uom, ty.type_name, u.full_name AS requested_by_name, x.sequence_no
             FROM trx_transport_trip_request x JOIN trx_transport_request r ON r.id = x.request_id JOIN cfg_transport_request_type ty ON ty.id = r.request_type_id
             JOIN mst_user u ON u.id = r.requested_by WHERE x.trip_id = ? AND x.is_active = 1 ORDER BY x.sequence_no`, [id]),
    query(`SELECT l.*, u.full_name AS actor_name FROM trx_transport_status_log l LEFT JOIN mst_user u ON u.id = l.actor_user_id
            WHERE l.company_id = ? AND (l.trip_id = ? OR (l.entity_type = 'TRIP' AND l.entity_id = ?)) ORDER BY l.event_at, l.id`, [companyId, id, id]),
    query(`SELECT i.*, u.full_name AS reported_by_name, s.location_name, rv.full_name AS resolved_by_name FROM trx_transport_trip_issue i LEFT JOIN mst_user u ON u.id = i.reported_by
             LEFT JOIN mst_user rv ON rv.id = i.resolved_by LEFT JOIN trx_transport_trip_stop s ON s.id = i.stop_id WHERE i.trip_id = ? ORDER BY i.id`, [id]),
    query(`SELECT p.*, r.request_no FROM trx_transport_proof p LEFT JOIN trx_transport_request r ON r.id = p.request_id WHERE p.trip_id = ? ORDER BY p.id`, [id]),
  ]);
  return { ...t, stops: stops.map((s: any) => ({ ...s, lines: lines.filter((l: any) => Number(l.stop_id) === Number(s.id)) })), requests, timeline, issues, proofs };
}

transportTripsRouter.get('/trips/:id', ah(async (req, res) => {
  must(req, P.VIEW, P.ASSIGN);
  const t = await tripDetail(req.user!.companyId, idOf(req.params.id));
  if (!t) throw NotFound('Trip not found');
  const conflicts = t.driver_id && ACTIVE_TRIP.includes(t.status) ? await overlapping(null, req.user!.companyId, new Date(t.planned_start_at), new Date(t.planned_end_at), { driverId: t.driver_id, vehicleId: t.vehicle_id }, t.id) : [];
  const can = has(req, P.ASSIGN);
  res.json({ data: { ...t, conflicts, actions: {
    assign: can && ['DRAFT', 'ASSIGNED', 'DRIVER_ACCEPTED', 'EXCEPTION'].includes(t.status),
    reassign: can && ['ASSIGNED', 'DRIVER_ACCEPTED', 'EXCEPTION', 'STARTED', 'IN_PROGRESS'].includes(t.status),
    cancel: can && ['DRAFT', 'ASSIGNED', 'DRIVER_ACCEPTED', 'EXCEPTION'].includes(t.status),
    exceptionClose: can && ['STARTED', 'IN_PROGRESS'].includes(t.status),
  } } });
}));

/* ====================================================================== availability (planner) */
transportTripsRouter.get('/availability', ah(async (req, res) => {
  must(req, P.ASSIGN, P.VIEW);
  const q = z.object({ start: zBizTime, end: zBizTime, trip_id: z.coerce.number().int().optional() }).parse(req.query);
  const cid = req.user!.companyId;
  const [vehicles, drivers] = await Promise.all([
    query<any>(`SELECT * FROM mst_transport_vehicle WHERE company_id = ? AND is_active = 1 ORDER BY vehicle_code`, [cid]),
    query<any>(`SELECT d.*, u.full_name AS driver_name FROM mst_transport_driver d JOIN mst_user u ON u.id = d.user_id AND u.is_active = 1 AND u.is_deleted = 0
                 WHERE d.company_id = ? AND d.is_active = 1 ORDER BY u.full_name`, [cid]),
  ]);
  const vOut = []; const dOut = [];
  for (const v of vehicles) {
    const clash = await overlapping(null, cid, q.start, q.end, { vehicleId: v.id }, q.trip_id ?? null);
    const warnings = expiryWarnings('vehicle', v, q.start);
    vOut.push({ id: v.id, vehicle_code: v.vehicle_code, registration_no: v.registration_no, ownership_type: v.ownership_type, vehicle_type: v.vehicle_type,
      capacity: v.capacity, capacity_uom: v.capacity_uom, availability_status: v.availability_status, rental_provider_name: v.rental_provider_name,
      conflicts: clash.map((t) => ({ trip_no: t.trip_no, status: t.status, from: t.planned_start_at, to: t.planned_end_at })), warnings,
      assignable: v.availability_status === 'AVAILABLE' && !clash.length });
  }
  for (const d of drivers) {
    const clash = await overlapping(null, cid, q.start, q.end, { driverId: d.id }, q.trip_id ?? null);
    const warnings = expiryWarnings('driver', d, q.start);
    dOut.push({ id: d.id, driver_name: d.driver_name, mobile_no: d.mobile_no, licence_class: d.licence_class, licence_expiry: d.licence_expiry, availability_status: d.availability_status,
      conflicts: clash.map((t) => ({ trip_no: t.trip_no, status: t.status, from: t.planned_start_at, to: t.planned_end_at })), warnings,
      assignable: d.availability_status === 'AVAILABLE' && !clash.length && !warnings.length });
  }
  res.json({ data: { vehicles: vOut, drivers: dOut } });
}));

/* ====================================================================== trips: create / assign / reassign / cancel */
transportTripsRouter.post('/trips', ah(async (req, res) => {
  must(req, P.ASSIGN);
  const assign = req.body?.assign !== false && req.body?.driver_id != null;
  const plan = assign ? planSchema.parse(req.body) : null;
  const header = plan ?? draftSchema.parse(req.body);
  let notices: string[] = [];
  const out = await retryDeadlock(() => transaction(async (tx) => {
    const tripNo = await nextTransportNo(tx, req.user!.companyId, 'TRIP');
    const ins = await txExecute(tx, `INSERT INTO trx_transport_trip (company_id, trip_no, status, planned_start_at, planned_end_at, origin, destination, purpose, remarks, created_by, updated_by)
        VALUES (?,?, 'DRAFT', ?,?,?,?,?,?,?,?)`, [req.user!.companyId, tripNo, header.planned_start_at, header.planned_end_at, header.origin ?? null, header.destination ?? null, header.purpose ?? null, header.remarks ?? null, req.user!.id, req.user!.id]);
    await logStatus(tx, req, { entity: 'TRIP', id: ins.insertId, tripId: ins.insertId, from: null, to: 'DRAFT', event: 'CREATED' });
    await audit(req, 'trx_transport_trip', ins.insertId, 'INSERT', undefined, { trip_no: tripNo, ...header }, tx);
    if (plan) {
      const trip = await lockTrip(tx, req.user!.companyId, ins.insertId);
      notices = await assignPlan(tx, req, trip, plan);
    }
    return txQueryOne<any>(tx, `SELECT * FROM trx_transport_trip WHERE id = ?`, [ins.insertId]);
  }));
  res.status(201).json({ data: out, message: `Trip ${out.trip_no} ${out.status === 'ASSIGNED' ? 'assigned — the driver has been notified' : 'saved as draft'}`, ...(notices.length ? { notices } : {}) });
}));

transportTripsRouter.put('/trips/:id', ah(async (req, res) => {
  must(req, P.ASSIGN);
  const b = draftSchema.parse(req.body);
  const id = idOf(req.params.id);
  const out = await transaction(async (tx) => {
    const t = await lockTrip(tx, req.user!.companyId, id);
    if (!t) throw NotFound('Trip not found');
    assertFrom<TripStatus>(t.status, ['DRAFT'], 'edit the trip header (use Assign to re-plan an assigned trip)');
    assertVersion(t, b.row_version);
    await txExecute(tx, `UPDATE trx_transport_trip SET planned_start_at = ?, planned_end_at = ?, origin = ?, destination = ?, purpose = ?, remarks = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [b.planned_start_at, b.planned_end_at, b.origin ?? null, b.destination ?? null, b.purpose ?? null, b.remarks ?? null, req.user!.id, id]);
    await audit(req, 'trx_transport_trip', id, 'UPDATE', t, b, tx);
    return txQueryOne(tx, `SELECT * FROM trx_transport_trip WHERE id = ?`, [id]);
  });
  res.json({ data: out });
}));

transportTripsRouter.post('/trips/:id/assign', ah(async (req, res) => {
  must(req, P.ASSIGN);
  const plan = planSchema.parse(req.body);
  const id = idOf(req.params.id);
  let notices: string[] = [];
  const out = await retryDeadlock(() => transaction(async (tx) => {
    const t = await lockTrip(tx, req.user!.companyId, id);
    if (!t) throw NotFound('Trip not found');
    assertVersion(t, plan.row_version);
    notices = await assignPlan(tx, req, t, plan);
    return txQueryOne(tx, `SELECT * FROM trx_transport_trip WHERE id = ?`, [id]);
  }));
  res.json({ data: out, ...(notices.length ? { notices } : {}) });
}));

/** Change driver and / or vehicle (§4.5): before start freely; after start the reason is mandatory. */
transportTripsRouter.post('/trips/:id/reassign', ah(async (req, res) => {
  must(req, P.ASSIGN);
  const b = z.object({
    driver_id: z.coerce.number().int().positive().nullish(), vehicle_id: z.coerce.number().int().positive().nullish(),
    reason: z.string().trim().max(500).nullish(), row_version: z.coerce.number().int().nullish(),
  }).parse(req.body ?? {});
  const id = idOf(req.params.id);
  const notices: string[] = [];
  const out = await transaction(async (tx) => {
    const t = await lockTrip(tx, req.user!.companyId, id);
    if (!t) throw NotFound('Trip not found');
    assertFrom<TripStatus>(t.status, ['ASSIGNED', 'DRIVER_ACCEPTED', 'EXCEPTION', 'STARTED', 'IN_PROGRESS'], 'reassign this trip');
    assertVersion(t, b.row_version);
    const started = ['STARTED', 'IN_PROGRESS'].includes(t.status);
    if (started && (!b.reason || b.reason.length < 3)) throw Unprocessable('Reason is mandatory to reassign a trip that has started', [{ field: 'reason', message: 'Reason is required' }]);
    const driverId = b.driver_id ?? Number(t.driver_id); const vehicleId = b.vehicle_id ?? Number(t.vehicle_id);
    const driverChanged = driverId !== Number(t.driver_id); const vehicleChanged = vehicleId !== Number(t.vehicle_id);
    if (!driverChanged && !vehicleChanged && t.status !== 'EXCEPTION') throw Unprocessable('Choose a different driver or vehicle');
    const start = started ? new Date() : new Date(t.planned_start_at);
    const end = new Date(Math.max(new Date(t.planned_end_at).getTime(), start.getTime() + 60_000));
    const driver = await lockDriver(tx, req.user!.companyId, driverId, start);
    const { v: vehicle, warnings } = await lockVehicle(tx, req.user!.companyId, vehicleId, start);
    notices.push(...warnings);
    await assertNoOverlap(tx, req.user!.companyId, t.id, start, end, driverChanged || t.status === 'EXCEPTION' ? driverId : null, vehicleChanged ? vehicleId : null);
    const next: TripStatus = started ? t.status : driverChanged || t.status === 'EXCEPTION' ? 'ASSIGNED' : t.status;
    await txExecute(tx, `UPDATE trx_transport_trip SET driver_id = ?, vehicle_id = ?, status = ?, accepted_at = IF(?, NULL, accepted_at), driver_rejected_at = IF(?, NULL, driver_rejected_at),
        assigned_by = ?, assigned_at = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [driverId, vehicleId, next, !started && driverChanged ? 1 : 0, driverChanged ? 1 : 0, req.user!.id, new Date(), req.user!.id, t.id]);
    await logStatus(tx, req, { entity: 'TRIP', id: t.id, tripId: t.id, from: t.status, to: next, event: 'REASSIGNED', note: [b.reason, `${vehicle.registration_no} · ${driver.full_name}`].filter(Boolean).join(' · '),
      before: { driver_id: t.driver_id, vehicle_id: t.vehicle_id }, after: { driver_id: driverId, vehicle_id: vehicleId } });
    await audit(req, 'trx_transport_trip', t.id, 'UPDATE', { driver_id: t.driver_id, vehicle_id: t.vehicle_id, status: t.status }, { driver_id: driverId, vehicle_id: vehicleId, status: next, reason: b.reason ?? null }, tx);
    const old = t.driver_id ? await txQueryOne<any>(tx, `SELECT user_id FROM mst_transport_driver WHERE id = ?`, [t.driver_id]) : null;
    const msg = `${vehicle.registration_no} · driver ${driver.full_name}${b.reason ? ` · ${b.reason}` : ''}`;
    await notify(tx, req, [driver.user_id], { key: `TRIP:${t.id}:REASSIGN:${t.row_version}:D`, refType: 'TRANSPORT_TRIP', refId: t.id, url: driverUrl(t.id), title: driverChanged ? `Trip ${t.trip_no} assigned to you` : `Trip ${t.trip_no}: vehicle changed`, body: msg });
    if (driverChanged) await notify(tx, req, [old?.user_id], { key: `TRIP:${t.id}:REASSIGN:${t.row_version}:O`, refType: 'TRANSPORT_TRIP', refId: t.id, url: driverUrl(t.id), title: `Trip ${t.trip_no} moved to another driver`, body: b.reason ?? '' });
    await notify(tx, req, await tripRequesters(tx, t.id), { key: `TRIP:${t.id}:REASSIGN:${t.row_version}:R`, refType: 'TRANSPORT_TRIP', refId: t.id, url: tripUrl(t.id), title: `Trip ${t.trip_no} reassigned`, body: msg });
    return txQueryOne(tx, `SELECT * FROM trx_transport_trip WHERE id = ?`, [id]);
  });
  res.json({ data: out, ...(notices.length ? { notices } : {}) });
}));

/** Release every request of a trip back to the approved queue. */
async function releaseRequests(tx: Tx, req: Request, trip: any, reason: string, onlyIds?: number[]) {
  const links = await txQuery<any>(tx, `SELECT tr.request_id, r.status, r.request_no, r.requested_by FROM trx_transport_trip_request tr JOIN trx_transport_request r ON r.id = tr.request_id
      WHERE tr.trip_id = ? AND tr.is_active = 1 FOR UPDATE`, [trip.id]);
  const now = new Date();
  for (const l of links.filter((x) => !onlyIds || onlyIds.includes(Number(x.request_id)))) {
    await txExecute(tx, `UPDATE trx_transport_trip_request SET is_active = 0, unlinked_by = ?, unlinked_at = ?, unlink_reason = ? WHERE trip_id = ? AND request_id = ? AND is_active = 1`, [req.user!.id, now, reason.slice(0, 500), trip.id, l.request_id]);
    if (['CANCELLED', 'COMPLETED', 'RECEIVED'].includes(l.status)) continue;
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'APPROVED', current_trip_id = NULL, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [req.user!.id, l.request_id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: l.request_id, tripId: trip.id, from: l.status, to: 'APPROVED', event: 'BACK_TO_QUEUE', note: `${trip.trip_no}: ${reason}` });
    await notify(tx, req, [l.requested_by], { key: `TRN:${l.request_id}:REQUEUE:${trip.id}`, refType: 'TRANSPORT_REQUEST', refId: l.request_id, url: `/transport/requests/${l.request_id}`,
      title: `${l.request_no}: trip ${trip.trip_no} did not serve it — back in the queue`, body: reason });
  }
}

transportTripsRouter.post('/trips/:id/cancel', ah(async (req, res) => {
  must(req, P.ASSIGN);
  const b = z.object({ reason: z.string().trim().min(3, 'Cancellation reason is required').max(500), row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {});
  const id = idOf(req.params.id);
  const out = await transaction(async (tx) => {
    const t = await lockTrip(tx, req.user!.companyId, id);
    if (!t) throw NotFound('Trip not found');
    assertFrom<TripStatus>(t.status, ['DRAFT', 'ASSIGNED', 'DRIVER_ACCEPTED', 'EXCEPTION'], 'cancel this trip (a started trip is closed with an exception)');
    assertVersion(t, b.row_version);
    await releaseRequests(tx, req, t, `Trip cancelled: ${b.reason}`);
    await txExecute(tx, `UPDATE trx_transport_trip_stop SET status = 'CANCELLED' WHERE trip_id = ? AND is_active = 1 AND status IN ('PENDING','EN_ROUTE')`, [id]);
    await txExecute(tx, `UPDATE trx_transport_trip SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancellation_reason = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [req.user!.id, new Date(), b.reason, req.user!.id, id]);
    await logStatus(tx, req, { entity: 'TRIP', id, tripId: id, from: t.status, to: 'CANCELLED', event: 'CANCELLED', note: b.reason });
    await audit(req, 'trx_transport_trip', id, 'UPDATE', { status: t.status }, { status: 'CANCELLED', reason: b.reason }, tx);
    const drv = t.driver_id ? await txQueryOne<any>(tx, `SELECT user_id FROM mst_transport_driver WHERE id = ?`, [t.driver_id]) : null;
    await notify(tx, req, [drv?.user_id], { key: `TRIP:${id}:CANCELLED`, refType: 'TRANSPORT_TRIP', refId: id, url: driverUrl(id), title: `Trip ${t.trip_no} cancelled`, body: b.reason });
    return txQueryOne(tx, `SELECT * FROM trx_transport_trip WHERE id = ?`, [id]);
  });
  res.json({ data: out });
}));

/**
 * Close a trip (§4.6 Complete Trip): every mandatory stop must be completed or failed, unless the coordinator closes
 * with an exception (logged). Requests fully served → Completed; the others go back to the approved queue.
 */
async function completeTrip(tx: Tx, req: Request, t: any, opts: { odometer?: number | null; exception?: string | null }) {
  const stops = await txQuery<any>(tx, `SELECT * FROM trx_transport_trip_stop WHERE trip_id = ? AND is_active = 1 ORDER BY stop_no FOR UPDATE`, [t.id]);
  const pending = stops.filter((s) => Number(s.is_mandatory) && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(s.status));
  if (pending.length && !opts.exception) {
    throw Conflict(`Stops still pending: ${pending.map((s) => `${s.stop_no}. ${s.location_name}`).join(', ')} — complete them or ask the coordinator to close with an exception`);
  }
  if (opts.odometer != null && t.start_odometer != null && opts.odometer < Number(t.start_odometer)) throw Unprocessable(`End odometer ${opts.odometer} is less than the start ${t.start_odometer}`);
  const now = new Date();
  for (const s of stops.filter((x) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(x.status))) {
    await txExecute(tx, `UPDATE trx_transport_trip_stop SET status = 'FAILED', remarks = CONCAT_WS(' · ', remarks, ?) WHERE id = ?`, [opts.exception ? `Exception close: ${opts.exception}` : 'Not visited', s.id]);
    await txExecute(tx, `UPDATE trx_transport_stop_request SET result = 'FAILED', result_note = ?, done_at = ?, done_by = ? WHERE stop_id = ? AND result = 'PENDING'`, ['Stop not serviced', now, req.user!.id, s.id]);
    await logStatus(tx, req, { entity: 'STOP', id: s.id, tripId: t.id, from: s.status, to: 'FAILED', event: 'STOP_NOT_SERVICED', note: opts.exception ?? null });
  }
  const links = await txQuery<any>(tx, `SELECT r.id, r.status, r.request_no, r.requested_by FROM trx_transport_trip_request tr JOIN trx_transport_request r ON r.id = tr.request_id
      WHERE tr.trip_id = ? AND tr.is_active = 1 FOR UPDATE`, [t.id]);
  const notServed: number[] = [];
  for (const r of links) {
    if (r.status === 'CANCELLED') continue;
    if (r.status === 'RECEIVED') continue;   // the requester already confirmed the material received — final
    const lines = await txQuery<any>(tx, `SELECT sr.result FROM trx_transport_stop_request sr JOIN trx_transport_trip_stop s ON s.id = sr.stop_id AND s.is_active = 1 AND s.trip_id = ? WHERE sr.request_id = ?`, [t.id, r.id]);
    const ok = lines.length > 0 && lines.every((l) => l.result === 'DONE' || l.result === 'PARTIAL');
    if (ok) {
      await txExecute(tx, `UPDATE trx_transport_request SET status = 'COMPLETED', completed_at = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [now, req.user!.id, r.id]);
      await logStatus(tx, req, { entity: 'REQUEST', id: r.id, tripId: t.id, from: r.status, to: 'COMPLETED', event: 'COMPLETED', note: t.trip_no });
      await notify(tx, req, [r.requested_by], { key: `TRN:${r.id}:COMPLETED`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: `/transport/requests/${r.id}`,
        title: `${r.request_no} delivered — confirm the material received`, body: `Trip ${t.trip_no} completed. Open the request and press "Confirm material received" once it reaches you.` });
    } else notServed.push(Number(r.id));
  }
  if (notServed.length) await releaseRequests(tx, req, t, opts.exception ? `Exception close: ${opts.exception}` : 'Not serviced on the trip', notServed);
  const km = opts.odometer != null && t.start_odometer != null ? ` · ${opts.odometer - Number(t.start_odometer)} km` : '';
  await txExecute(tx, `UPDATE trx_transport_trip SET status = 'COMPLETED', completed_at = ?, end_odometer = COALESCE(?, end_odometer), exception_closed = ?, exception_reason = ?,
      row_version = row_version + 1, updated_by = ? WHERE id = ?`, [now, opts.odometer ?? null, opts.exception ? 1 : 0, opts.exception ?? null, req.user!.id, t.id]);
  await logStatus(tx, req, { entity: 'TRIP', id: t.id, tripId: t.id, from: t.status, to: 'COMPLETED', event: opts.exception ? 'EXCEPTION_CLOSED' : 'COMPLETED', note: [opts.exception, notServed.length ? `${notServed.length} request(s) back in queue` : null, km || null].filter(Boolean).join(' · ') || null });
  await audit(req, 'trx_transport_trip', t.id, 'UPDATE', { status: t.status }, { status: 'COMPLETED', exception: opts.exception ?? null, end_odometer: opts.odometer ?? null }, tx);
  await notify(tx, req, await planners(tx, req.user!.companyId), { key: `TRIP:${t.id}:COMPLETED`, refType: 'TRANSPORT_TRIP', refId: t.id, url: tripUrl(t.id),
    title: `Trip ${t.trip_no} completed${opts.exception ? ' (exception close)' : ''}`, body: `${links.length - notServed.length}/${links.length} request(s) served${km}` });
}

/**
 * Coordinator marks a trip delivered (client 05-Nov-2026) — for trips whose driver has no login / tab: every pending
 * stop line is recorded as done (or failed with a note), the trip is closed and the requesters are asked to confirm the
 * material received. Proof photos are never asked here.
 */
const markDeliveredSchema = z.object({
  delivered_at: z.union([zBizTime, z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish(),
  receiver_name: optStr(80), note: optStr(500), odometer: z.coerce.number().min(0).nullish(),
  lines: z.array(z.object({ request_id: z.coerce.number().int().positive(), result: z.enum(['DONE', 'FAILED']).default('DONE'),
    actual_qty: z.coerce.number().min(0).nullish(), note: optStr(500) })).optional(),
  row_version: z.coerce.number().int().nullish(),
});
transportTripsRouter.post('/trips/:id/mark-delivered', ah(async (req, res) => {
  must(req, P.ASSIGN, P.APPROVE);
  const b = markDeliveredSchema.parse(req.body ?? {});
  const id = idOf(req.params.id);
  const now = new Date();
  const at = b.delivered_at ?? now;
  if (at.getTime() > now.getTime() + 5 * 60_000) throw Unprocessable('Delivered time cannot be in the future', [{ field: 'delivered_at', message: 'Delivered time cannot be in the future' }]);
  const out = await transaction(async (tx) => {
    const t = await lockTrip(tx, req.user!.companyId, id);
    if (!t) throw NotFound('Trip not found');
    assertFrom<TripStatus>(t.status, ['ASSIGNED', 'DRIVER_ACCEPTED', 'STARTED', 'IN_PROGRESS'], 'mark this trip delivered');
    assertVersion(t, b.row_version);
    if (t.assigned_at && at.getTime() < new Date(t.assigned_at).getTime() - 60_000) throw Unprocessable('Delivered time is before the trip was assigned', [{ field: 'delivered_at', message: 'Before the trip was assigned' }]);
    const stops = await txQuery<any>(tx, `SELECT * FROM trx_transport_trip_stop WHERE trip_id = ? AND is_active = 1 ORDER BY stop_no FOR UPDATE`, [t.id]);
    const lines = await txQuery<any>(tx, `SELECT sr.*, r.request_no FROM trx_transport_stop_request sr JOIN trx_transport_trip_stop s ON s.id = sr.stop_id AND s.is_active = 1 AND s.trip_id = ?
        JOIN trx_transport_request r ON r.id = sr.request_id WHERE sr.result = 'PENDING' FOR UPDATE`, [t.id]);
    for (const l of lines) {
      const sent = b.lines?.find((x) => x.request_id === Number(l.request_id));
      const result = sent?.result ?? 'DONE';
      if (result === 'FAILED' && !(sent?.note || b.note)) throw Unprocessable(`Say why ${l.request_no} was not ${l.service_type === 'PICKUP' ? 'picked up' : 'delivered'}`);
      const qty = sent?.actual_qty ?? (l.expected_qty != null ? Number(l.expected_qty) : null);
      const final = result === 'DONE' && l.expected_qty != null && qty != null && qty < Number(l.expected_qty) ? 'PARTIAL' : result;
      await txExecute(tx, `UPDATE trx_transport_stop_request SET result = ?, actual_qty = ?, receiver_name = ?, result_note = ?, done_at = ?, done_by = ? WHERE id = ?`,
        [final, qty, l.service_type === 'DELIVERY' ? (b.receiver_name ?? null) : null, sent?.note ?? b.note ?? 'Marked by the transport coordinator', at, req.user!.id, l.id]);
    }
    for (const s of stops.filter((x) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(x.status))) {
      const served = await txQueryOne<any>(tx, `SELECT SUM(result IN ('DONE','PARTIAL')) ok, COUNT(*) n FROM trx_transport_stop_request WHERE stop_id = ?`, [s.id]);
      const next = Number(served?.n) > 0 && !Number(served?.ok) ? 'FAILED' : 'COMPLETED';
      await txExecute(tx, `UPDATE trx_transport_trip_stop SET status = ?, actual_arrival_at = COALESCE(actual_arrival_at, ?), actual_departure_at = COALESCE(actual_departure_at, ?) WHERE id = ?`, [next, at, at, s.id]);
      await logStatus(tx, req, { entity: 'STOP', id: s.id, tripId: t.id, from: s.status, to: next, event: 'MARKED_BY_COORDINATOR', note: `${s.stop_no}. ${s.location_name}` });
    }
    if (!t.started_at) await txExecute(tx, `UPDATE trx_transport_trip SET started_at = ? WHERE id = ?`, [at, t.id]);
    await logStatus(tx, req, { entity: 'TRIP', id: t.id, tripId: t.id, from: t.status, to: t.status, event: 'MARKED_DELIVERED', note: [`By ${req.user!.fullName}`, b.receiver_name ? `Receiver ${b.receiver_name}` : null, b.note].filter(Boolean).join(' · ') });
    const reqIds = await txQuery<any>(tx, `SELECT request_id FROM trx_transport_trip_request WHERE trip_id = ? AND is_active = 1`, [t.id]);
    for (const r of reqIds) await refreshRequestFromLines(tx, req, Number(r.request_id), t.id, true);
    const fresh = await lockTrip(tx, req.user!.companyId, id);
    await completeTrip(tx, req, fresh, { odometer: b.odometer ?? null });
    await txExecute(tx, `UPDATE trx_transport_trip SET completed_at = ? WHERE id = ?`, [at, t.id]);
    const drv = t.driver_id ? await txQueryOne<any>(tx, `SELECT user_id FROM mst_transport_driver WHERE id = ?`, [t.driver_id]) : null;
    await notify(tx, req, [drv?.user_id], { key: `TRIP:${t.id}:MARKED_DELIVERED`, refType: 'TRANSPORT_TRIP', refId: t.id, url: driverUrl(t.id), title: `Trip ${t.trip_no} marked delivered by the coordinator`, body: '' });
    return txQueryOne(tx, `SELECT * FROM trx_transport_trip WHERE id = ?`, [id]);
  });
  res.json({ data: out });
}));

transportTripsRouter.post('/trips/:id/close-exception', ah(async (req, res) => {
  must(req, P.ASSIGN);
  const b = z.object({ reason: z.string().trim().min(3, 'Reason for the exception close is required').max(500), odometer: z.coerce.number().min(0).nullish() }).parse(req.body ?? {});
  const id = idOf(req.params.id);
  const out = await transaction(async (tx) => {
    const t = await lockTrip(tx, req.user!.companyId, id);
    if (!t) throw NotFound('Trip not found');
    assertFrom<TripStatus>(t.status, ['STARTED', 'IN_PROGRESS'], 'close this trip with an exception');
    await completeTrip(tx, req, t, { exception: b.reason, odometer: b.odometer ?? null });
    return txQueryOne(tx, `SELECT * FROM trx_transport_trip WHERE id = ?`, [id]);
  });
  res.json({ data: out });
}));

transportTripsRouter.post('/trips/:id/issues/:issueId/resolve', ah(async (req, res) => {
  must(req, P.ASSIGN);
  const b = z.object({ note: z.string().trim().min(2, 'Resolution note is required').max(500) }).parse(req.body ?? {});
  const tripId = idOf(req.params.id); const issueId = idOf(req.params.issueId);
  await transaction(async (tx) => {
    const i = await txQueryOne<any>(tx, `SELECT i.* FROM trx_transport_trip_issue i WHERE i.id = ? AND i.trip_id = ? AND i.company_id = ? FOR UPDATE`, [issueId, tripId, req.user!.companyId]);
    if (!i) throw NotFound('Issue not found');
    if (i.resolved_at) throw Conflict('Issue already resolved');
    await txExecute(tx, `UPDATE trx_transport_trip_issue SET resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?`, [req.user!.id, new Date(), b.note, issueId]);
    await logStatus(tx, req, { entity: 'TRIP', id: tripId, tripId, event: 'ISSUE_RESOLVED', note: `${humanStatus(i.issue_type)}: ${b.note}` });
    await audit(req, 'trx_transport_trip_issue', issueId, 'UPDATE', { resolved_at: null }, { resolution_note: b.note }, tx);
  });
  res.json({ data: { success: true } });
}));

/* ====================================================================== driver API */
async function myDriver(req: Request) {
  if (!has(req, P.DRIVER)) throw Forbidden('Driver screen needs the TRANSPORT.DRIVER permission');
  const d = await queryOne<any>(`SELECT * FROM mst_transport_driver WHERE company_id = ? AND user_id = ? AND is_active = 1`, [req.user!.companyId, req.user!.id]);
  if (!d) throw Forbidden('No active driver profile is linked to your login — ask the transport coordinator');
  return d;
}
/** The driver's own trip, locked. Someone else's trip is a 404 (never revealed). */
async function myTrip(tx: Tx, req: Request, driverId: number, tripId: number) {
  const t = await lockTrip(tx, req.user!.companyId, tripId);
  if (!t || Number(t.driver_id) !== driverId || t.status === 'DRAFT') throw NotFound('Trip not found');
  return t;
}

/**
 * Idempotent driver action: the key (Idempotency-Key header or body.idempotency_key) is stored with the response in the
 * same transaction; a retry with the same key returns the stored response without running the action again.
 */
async function idempotent(req: Request, res: Response, endpoint: string, fn: (tx: Tx) => Promise<unknown>) {
  const raw = (req.get('Idempotency-Key') ?? (req.body?.idempotency_key as string | undefined) ?? '').trim();
  const key = raw ? z.string().max(80).regex(/^[\w:.-]+$/, 'Invalid idempotency key').parse(raw) : null;
  const cid = req.user!.companyId;
  if (key) {
    const prev = await queryOne<any>(`SELECT endpoint, response_json FROM trx_transport_idempotency WHERE company_id = ? AND user_id = ? AND idem_key = ?`, [cid, req.user!.id, key]);
    if (prev) {
      if (prev.endpoint !== endpoint) throw Conflict('This idempotency key was used for another action');
      res.setHeader('Idempotent-Replay', 'true');
      return res.json(typeof prev.response_json === 'string' ? JSON.parse(prev.response_json) : prev.response_json ?? { data: null });
    }
  }
  try {
    const body = await transaction(async (tx) => {
      if (key) await txExecute(tx, `INSERT INTO trx_transport_idempotency (company_id, user_id, idem_key, endpoint) VALUES (?,?,?,?)`, [cid, req.user!.id, key, endpoint]);
      const data = await fn(tx);
      const out = { data };
      if (key) await txExecute(tx, `UPDATE trx_transport_idempotency SET response_json = ? WHERE company_id = ? AND user_id = ? AND idem_key = ?`, [JSON.stringify(out), cid, req.user!.id, key]);
      return out;
    });
    return res.json(body);
  } catch (e: any) {
    if (key && e?.code === 'ER_DUP_ENTRY' && String(e?.sqlMessage ?? '').includes('uq_tid')) {
      const prev = await queryOne<any>(`SELECT response_json FROM trx_transport_idempotency WHERE company_id = ? AND user_id = ? AND idem_key = ?`, [cid, req.user!.id, key]);
      res.setHeader('Idempotent-Replay', 'true');
      return res.json(prev?.response_json ? (typeof prev.response_json === 'string' ? JSON.parse(prev.response_json) : prev.response_json) : { data: null });
    }
    throw e;
  }
}

driverRouter.get('/me', ah(async (req, res) => {
  const d = await myDriver(req);
  res.json({ data: { ...d, driver_name: req.user!.fullName } });
}));

driverRouter.get('/trips', ah(async (req, res) => {
  const d = await myDriver(req);
  const when = z.enum(['active', 'upcoming', 'today', 'recent', 'all']).default('active').parse(req.query.when ?? 'active');
  const where = ['t.company_id = ?', 't.driver_id = ?', `t.status <> 'DRAFT'`]; const args: unknown[] = [req.user!.companyId, d.id];
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  if (when === 'active') where.push(`t.status IN ('ASSIGNED','DRIVER_ACCEPTED','STARTED','IN_PROGRESS','EXCEPTION')`);
  if (when === 'upcoming') { where.push(`t.status IN ('ASSIGNED','DRIVER_ACCEPTED') AND t.planned_start_at >= ?`); args.push(istDayStart(today)); }
  if (when === 'today') { where.push('t.planned_start_at >= ? AND t.planned_start_at < ?'); args.push(istDayStart(today), istDayEnd(today)); }
  if (when === 'recent') where.push(`t.status IN ('COMPLETED','CANCELLED') AND t.updated_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)`);
  const rows = await query(`SELECT t.id, t.trip_no, t.status, t.planned_start_at, t.planned_end_at, t.origin, t.destination, t.purpose, t.remarks,
      v.registration_no AS vehicle_no, v.vehicle_type,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1) AS stop_count,
      (SELECT COUNT(*) FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1 AND s.status IN ('COMPLETED','FAILED')) AS stops_done,
      (SELECT s.location_name FROM trx_transport_trip_stop s WHERE s.trip_id = t.id AND s.is_active = 1 AND s.status IN ('PENDING','EN_ROUTE','ARRIVED') ORDER BY s.stop_no LIMIT 1) AS next_stop,
      (SELECT MAX(FIELD(r.priority,'NORMAL','URGENT','CRITICAL')) FROM trx_transport_trip_request x JOIN trx_transport_request r ON r.id = x.request_id WHERE x.trip_id = t.id AND x.is_active = 1) AS priority_rank
    FROM trx_transport_trip t LEFT JOIN mst_transport_vehicle v ON v.id = t.vehicle_id
   WHERE ${where.join(' AND ')} ORDER BY FIELD(t.status,'IN_PROGRESS','STARTED','DRIVER_ACCEPTED','ASSIGNED','EXCEPTION','COMPLETED','CANCELLED'), t.planned_start_at LIMIT 100`, args);
  res.json({ data: rows.map((r: any) => ({ ...r, priority: ['NORMAL', 'NORMAL', 'URGENT', 'CRITICAL'][Number(r.priority_rank ?? 1)] ?? 'NORMAL' })) });
}));

driverRouter.get('/trips/:id', ah(async (req, res) => {
  const d = await myDriver(req);
  const t = await tripDetail(req.user!.companyId, idOf(req.params.id));
  if (!t || Number(t.driver_id) !== Number(d.id) || t.status === 'DRAFT') throw NotFound('Trip not found');
  res.json({ data: t });
}));

driverRouter.post('/trips/:id/accept', ah(async (req, res) => {
  const d = await myDriver(req);
  await idempotent(req, res, `accept:${req.params.id}`, async (tx) => {
    const t = await myTrip(tx, req, d.id, idOf(req.params.id));
    assertFrom<TripStatus>(t.status, ['ASSIGNED'], 'accept this trip');
    await txExecute(tx, `UPDATE trx_transport_trip SET status = 'DRIVER_ACCEPTED', accepted_at = ?, row_version = row_version + 1 WHERE id = ?`, [new Date(), t.id]);
    await logStatus(tx, req, { entity: 'TRIP', id: t.id, tripId: t.id, from: t.status, to: 'DRIVER_ACCEPTED', event: 'DRIVER_ACCEPTED' });
    await notify(tx, req, await planners(tx, req.user!.companyId), { key: `TRIP:${t.id}:ACCEPTED:${t.row_version}`, refType: 'TRANSPORT_TRIP', refId: t.id, url: tripUrl(t.id), title: `${req.user!.fullName} accepted trip ${t.trip_no}`, body: '' });
    return { id: t.id, status: 'DRIVER_ACCEPTED' };
  });
}));

driverRouter.post('/trips/:id/reject', ah(async (req, res) => {
  const d = await myDriver(req);
  const b = z.object({ reason: z.string().trim().min(3, 'Reason is required to reject a trip').max(500) }).parse(req.body ?? {});
  await idempotent(req, res, `reject:${req.params.id}`, async (tx) => {
    const t = await myTrip(tx, req, d.id, idOf(req.params.id));
    assertFrom<TripStatus>(t.status, ['ASSIGNED', 'DRIVER_ACCEPTED'], 'reject this trip');
    await txExecute(tx, `UPDATE trx_transport_trip SET status = 'EXCEPTION', driver_rejected_at = ?, driver_reject_reason = ?, accepted_at = NULL, row_version = row_version + 1 WHERE id = ?`, [new Date(), b.reason, t.id]);
    await logStatus(tx, req, { entity: 'TRIP', id: t.id, tripId: t.id, from: t.status, to: 'EXCEPTION', event: 'DRIVER_REJECTED', note: b.reason });
    await audit(req, 'trx_transport_trip', t.id, 'UPDATE', { status: t.status }, { status: 'EXCEPTION', driver_reject_reason: b.reason }, tx);
    await notify(tx, req, await planners(tx, req.user!.companyId), { key: `TRIP:${t.id}:DRIVER_REJECTED:${t.row_version}`, refType: 'TRANSPORT_TRIP', refId: t.id, url: tripUrl(t.id),
      title: `⚠ ${req.user!.fullName} rejected trip ${t.trip_no} — reassign`, body: b.reason });
    return { id: t.id, status: 'EXCEPTION' };
  });
}));

driverRouter.post('/trips/:id/start', ah(async (req, res) => {
  const d = await myDriver(req);
  const b = z.object({ odometer: z.coerce.number().min(0).nullish() }).parse(req.body ?? {});
  await idempotent(req, res, `start:${req.params.id}`, async (tx) => {
    const t = await myTrip(tx, req, d.id, idOf(req.params.id));
    assertFrom<TripStatus>(t.status, ['DRIVER_ACCEPTED'], 'start this trip (accept it first)');
    const now = new Date();
    await txExecute(tx, `UPDATE trx_transport_trip SET status = 'STARTED', started_at = ?, start_odometer = ?, row_version = row_version + 1 WHERE id = ?`, [now, b.odometer ?? null, t.id]);
    await logStatus(tx, req, { entity: 'TRIP', id: t.id, tripId: t.id, from: t.status, to: 'STARTED', event: 'TRIP_STARTED', note: b.odometer != null ? `Odometer ${b.odometer}` : null });
    const first = await txQueryOne<any>(tx, `SELECT id, status FROM trx_transport_trip_stop WHERE trip_id = ? AND is_active = 1 AND status = 'PENDING' ORDER BY stop_no LIMIT 1`, [t.id]);
    if (first) {
      await txExecute(tx, `UPDATE trx_transport_trip_stop SET status = 'EN_ROUTE' WHERE id = ?`, [first.id]);
      await logStatus(tx, req, { entity: 'STOP', id: first.id, tripId: t.id, from: 'PENDING', to: 'EN_ROUTE', event: 'EN_ROUTE' });
    }
    const reqs = await txQuery<any>(tx, `SELECT request_id FROM trx_transport_trip_request WHERE trip_id = ? AND is_active = 1`, [t.id]);
    for (const r of reqs) await refreshRequestFromLines(tx, req, Number(r.request_id), t.id, true);
    await notify(tx, req, [...await planners(tx, req.user!.companyId), ...await tripRequesters(tx, t.id)], { key: `TRIP:${t.id}:STARTED`, refType: 'TRANSPORT_TRIP', refId: t.id, url: tripUrl(t.id),
      title: `Trip ${t.trip_no} started`, body: `${req.user!.fullName} started at ${istText(now)}` });
    return { id: t.id, status: 'STARTED' };
  });
}));

driverRouter.post('/stops/:id/arrive', ah(async (req, res) => {
  const d = await myDriver(req);
  const b = z.object({ note: z.string().trim().max(500).nullish() }).parse(req.body ?? {});
  const stopId = idOf(req.params.id);
  await idempotent(req, res, `arrive:${stopId}`, async (tx) => {
    const s = await txQueryOne<any>(tx, `SELECT * FROM trx_transport_trip_stop WHERE id = ? AND company_id = ? AND is_active = 1 FOR UPDATE`, [stopId, req.user!.companyId]);
    if (!s) throw NotFound('Stop not found');
    const t = await myTrip(tx, req, d.id, Number(s.trip_id));
    assertFrom<TripStatus>(t.status, ['STARTED', 'IN_PROGRESS'], 'record arrival (start the trip first)');
    assertFrom(s.status, ['PENDING', 'EN_ROUTE'], 'mark arrival at this stop');
    const now = new Date();
    await txExecute(tx, `UPDATE trx_transport_trip_stop SET status = 'ARRIVED', actual_arrival_at = ?, arrival_note = ? WHERE id = ?`, [now, b.note ?? null, s.id]);
    await logStatus(tx, req, { entity: 'STOP', id: s.id, tripId: t.id, from: s.status, to: 'ARRIVED', event: 'ARRIVED', note: [`${s.stop_no}. ${s.location_name}`, b.note].filter(Boolean).join(' · ') });
    if (t.status === 'STARTED') {
      await txExecute(tx, `UPDATE trx_transport_trip SET status = 'IN_PROGRESS', row_version = row_version + 1 WHERE id = ?`, [t.id]);
      await logStatus(tx, req, { entity: 'TRIP', id: t.id, tripId: t.id, from: 'STARTED', to: 'IN_PROGRESS', event: 'IN_PROGRESS' });
    }
    return { id: s.id, status: 'ARRIVED' };
  });
}));

const lineResult = z.object({
  request_id: z.coerce.number().int().positive(), service_type: z.enum(['PICKUP', 'DELIVERY']),
  result: z.enum(['DONE', 'PARTIAL', 'FAILED']).optional(), actual_qty: z.coerce.number().min(0).nullish(),
  receiver_name: z.string().trim().max(80).nullish(), note: z.string().trim().max(500).nullish(),
});

/**
 * Pickup / delivery done at a stop (§4.6): per request line quantity, receiver and result. A short quantity is a PARTIAL
 * (an exception issue is raised); a failed line needs a note. Deliveries need the receiver's name; request types set to
 * need proof also need a photo.
 */
driverRouter.post('/stops/:id/complete', ah(async (req, res) => {
  const d = await myDriver(req);
  const b = z.object({ lines: z.array(lineResult).optional(), receiver_name: z.string().trim().max(80).nullish(), photo_url: photoUrl.nullish(), note: z.string().trim().max(500).nullish() }).parse(req.body ?? {});
  const stopId = idOf(req.params.id);
  await idempotent(req, res, `complete-stop:${stopId}`, async (tx) => {
    const s = await txQueryOne<any>(tx, `SELECT * FROM trx_transport_trip_stop WHERE id = ? AND company_id = ? AND is_active = 1 FOR UPDATE`, [stopId, req.user!.companyId]);
    if (!s) throw NotFound('Stop not found');
    const t = await myTrip(tx, req, d.id, Number(s.trip_id));
    assertFrom<TripStatus>(t.status, ['STARTED', 'IN_PROGRESS'], 'complete a stop');
    assertFrom(s.status, ['ARRIVED'], 'complete this stop (mark arrival first)');
    const lines = await txQuery<any>(tx, `SELECT sr.*, r.request_no, r.requested_by, ty.requires_proof FROM trx_transport_stop_request sr JOIN trx_transport_request r ON r.id = sr.request_id
        JOIN cfg_transport_request_type ty ON ty.id = r.request_type_id WHERE sr.stop_id = ? FOR UPDATE`, [s.id]);
    const now = new Date();
    const photoOn = await deliveryPhotoOn(req.user!.companyId, tx);   // TRANSPORT_DELIVERY_PHOTO off → never required
    let anyServed = false; let allFailed = lines.length > 0;
    const partials: string[] = []; const failed: string[] = [];
    for (const l of lines) {
      if (l.result !== 'PENDING') { if (l.result !== 'FAILED') { anyServed = true; allFailed = false; } continue; }
      const sent = b.lines?.find((x) => x.request_id === Number(l.request_id) && x.service_type === l.service_type);
      const qty = sent?.actual_qty ?? (l.expected_qty != null ? Number(l.expected_qty) : null);
      let result = sent?.result ?? 'DONE';
      if (result === 'DONE' && l.expected_qty != null && qty != null && qty < Number(l.expected_qty)) result = 'PARTIAL';
      const receiver = sent?.receiver_name || b.receiver_name || null;
      if (result === 'FAILED' && !(sent?.note || b.note)) throw Unprocessable(`Say why ${l.request_no} could not be ${l.service_type === 'PICKUP' ? 'picked up' : 'delivered'}`);
      if (result !== 'FAILED' && l.service_type === 'DELIVERY' && !receiver) throw Unprocessable(`Receiver name is required for the delivery of ${l.request_no}`, [{ field: 'receiver_name', message: 'Receiver name is required' }]);
      if (photoOn && result !== 'FAILED' && l.service_type === 'DELIVERY' && Number(l.requires_proof) && !b.photo_url) throw Unprocessable(`${l.request_no} needs a proof photo of the delivery`, [{ field: 'photo_url', message: 'Proof photo is required' }]);
      await txExecute(tx, `UPDATE trx_transport_stop_request SET result = ?, actual_qty = ?, receiver_name = ?, result_note = ?, done_at = ?, done_by = ? WHERE id = ?`,
        [result, qty, receiver, sent?.note ?? b.note ?? null, now, req.user!.id, l.id]);
      if (result === 'FAILED') failed.push(l.request_no); else { anyServed = true; allFailed = false; }
      if (result === 'PARTIAL') partials.push(`${l.request_no} ${qty}/${l.expected_qty}`);
      if (photoOn && b.photo_url && result !== 'FAILED') {
        await txExecute(tx, `INSERT INTO trx_transport_proof (company_id, trip_id, stop_id, request_id, proof_type, receiver_name, delivered_qty, file_url, captured_at, uploaded_by) VALUES (?,?,?,?, 'PHOTO', ?,?,?,?,?)`,
          [req.user!.companyId, t.id, s.id, l.request_id, receiver, qty, b.photo_url, now, req.user!.id]);
      }
      const verb = l.service_type === 'PICKUP' ? 'picked up' : 'delivered';
      await notify(tx, req, [l.requested_by], { key: `TRN:${l.request_id}:STOP:${s.id}:${l.service_type}`, refType: 'TRANSPORT_REQUEST', refId: Number(l.request_id), url: `/transport/requests/${l.request_id}`,
        title: result === 'FAILED' ? `⚠ ${l.request_no} not ${verb} at ${s.location_name}` : `${l.request_no} ${verb}${result === 'PARTIAL' ? ' (partial)' : ''} at ${s.location_name}`,
        body: [qty != null ? `Qty ${qty}` : null, receiver ? `Receiver ${receiver}` : null, sent?.note ?? b.note ?? null].filter(Boolean).join(' · ') });
    }
    const next = allFailed && !anyServed ? 'FAILED' : 'COMPLETED';
    await txExecute(tx, `UPDATE trx_transport_trip_stop SET status = ?, actual_departure_at = ?, remarks = COALESCE(?, remarks) WHERE id = ?`, [next, now, b.note ?? null, s.id]);
    await logStatus(tx, req, { entity: 'STOP', id: s.id, tripId: t.id, from: s.status, to: next, event: next === 'FAILED' ? 'STOP_FAILED' : 'STOP_COMPLETED',
      note: [`${s.stop_no}. ${s.location_name}`, partials.length ? `Partial: ${partials.join(', ')}` : null, failed.length ? `Failed: ${failed.join(', ')}` : null, b.note].filter(Boolean).join(' · ') });
    if (partials.length || failed.length) {
      const desc = [partials.length ? `Partial: ${partials.join(', ')}` : null, failed.length ? `Not serviced: ${failed.join(', ')}` : null, b.note].filter(Boolean).join(' · ');
      const iss = await txExecute(tx, `INSERT INTO trx_transport_trip_issue (company_id, trip_id, stop_id, issue_type, severity, description, reported_by, reported_at) VALUES (?,?,?,?,?,?,?,?)`,
        [req.user!.companyId, t.id, s.id, partials.length ? 'PARTIAL_PICKUP' : 'OTHER', 'HIGH', desc.slice(0, 1000), req.user!.id, now]);
      await notify(tx, req, await planners(tx, req.user!.companyId), { key: `TRIP:${t.id}:ISSUE:${iss.insertId}`, refType: 'TRANSPORT_TRIP', refId: t.id, url: tripUrl(t.id),
        title: `⚠ Trip ${t.trip_no}: exception at ${s.location_name}`, body: desc });
    }
    for (const rid of [...new Set(lines.map((l) => Number(l.request_id)))]) await refreshRequestFromLines(tx, req, rid, t.id, true);
    const nextStop = await txQueryOne<any>(tx, `SELECT id FROM trx_transport_trip_stop WHERE trip_id = ? AND is_active = 1 AND status = 'PENDING' ORDER BY stop_no LIMIT 1`, [t.id]);
    if (nextStop) {
      await txExecute(tx, `UPDATE trx_transport_trip_stop SET status = 'EN_ROUTE' WHERE id = ?`, [nextStop.id]);
      await logStatus(tx, req, { entity: 'STOP', id: nextStop.id, tripId: t.id, from: 'PENDING', to: 'EN_ROUTE', event: 'EN_ROUTE' });
    }
    return { id: s.id, status: next };
  });
}));

driverRouter.post('/trips/:id/complete', ah(async (req, res) => {
  const d = await myDriver(req);
  const b = z.object({ odometer: z.coerce.number().min(0).nullish() }).parse(req.body ?? {});
  await idempotent(req, res, `complete:${req.params.id}`, async (tx) => {
    const t = await myTrip(tx, req, d.id, idOf(req.params.id));
    assertFrom<TripStatus>(t.status, ['STARTED', 'IN_PROGRESS'], 'complete this trip');
    await completeTrip(tx, req, t, { odometer: b.odometer ?? null });
    await notify(tx, req, await tripRequesters(tx, t.id), { key: `TRIP:${t.id}:COMPLETED:R`, refType: 'TRANSPORT_TRIP', refId: t.id, url: tripUrl(t.id), title: `Trip ${t.trip_no} completed`, body: '' });
    return { id: t.id, status: 'COMPLETED' };
  });
}));

const ISSUE_TYPES = ['DELAY', 'RECIPIENT_UNAVAILABLE', 'ITEM_NOT_READY', 'WRONG_ADDRESS', 'BREAKDOWN', 'ACCIDENT', 'OTHER'] as const;
driverRouter.post('/trips/:id/issues', ah(async (req, res) => {
  const d = await myDriver(req);
  const b = z.object({
    issue_type: z.enum(ISSUE_TYPES), description: z.string().trim().min(3, 'Describe the issue').max(1000),
    stop_id: z.coerce.number().int().positive().nullish(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullish(),
  }).parse(req.body ?? {});
  await idempotent(req, res, `issue:${req.params.id}`, async (tx) => {
    const t = await myTrip(tx, req, d.id, idOf(req.params.id));
    assertFrom<TripStatus>(t.status, ['ASSIGNED', 'DRIVER_ACCEPTED', 'STARTED', 'IN_PROGRESS'], 'report an issue');
    if (b.stop_id) {
      const s = await txQueryOne(tx, `SELECT id FROM trx_transport_trip_stop WHERE id = ? AND trip_id = ? AND is_active = 1`, [b.stop_id, t.id]);
      if (!s) throw Unprocessable('That stop is not on this trip');
    }
    const severity = b.severity ?? (['BREAKDOWN', 'ACCIDENT'].includes(b.issue_type) ? 'CRITICAL' : 'HIGH');
    const now = new Date();
    const ins = await txExecute(tx, `INSERT INTO trx_transport_trip_issue (company_id, trip_id, stop_id, issue_type, severity, description, reported_by, reported_at) VALUES (?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, t.id, b.stop_id ?? null, b.issue_type, severity, b.description, req.user!.id, now]);
    await logStatus(tx, req, { entity: 'TRIP', id: t.id, tripId: t.id, event: `ISSUE_${b.issue_type}`, note: b.description });
    await notify(tx, req, [...await planners(tx, req.user!.companyId), ...await tripRequesters(tx, t.id)], { key: `TRIP:${t.id}:ISSUE:${ins.insertId}`, refType: 'TRANSPORT_TRIP', refId: t.id, url: tripUrl(t.id),
      title: `⚠ ${humanStatus(b.issue_type)} on trip ${t.trip_no}`, body: b.description });
    return { id: ins.insertId, issue_type: b.issue_type, severity };
  });
}));

/** Proof photo for a stop already completed (driver adds it after the fact). */
driverRouter.post('/stops/:id/proof', ah(async (req, res) => {
  const d = await myDriver(req);
  const b = z.object({ photo_url: photoUrl, request_id: z.coerce.number().int().positive().nullish(), receiver_name: z.string().trim().max(80).nullish() }).parse(req.body ?? {});
  const stopId = idOf(req.params.id);
  if (!await deliveryPhotoOn(req.user!.companyId)) throw Conflict('Delivery photos are switched off for this company (Admin → Settings → TRANSPORT_DELIVERY_PHOTO)');
  await idempotent(req, res, `proof:${stopId}`, async (tx) => {
    const s = await txQueryOne<any>(tx, `SELECT * FROM trx_transport_trip_stop WHERE id = ? AND company_id = ? AND is_active = 1`, [stopId, req.user!.companyId]);
    if (!s) throw NotFound('Stop not found');
    const t = await myTrip(tx, req, d.id, Number(s.trip_id));
    if (b.request_id) {
      const l = await txQueryOne(tx, `SELECT id FROM trx_transport_stop_request WHERE stop_id = ? AND request_id = ?`, [s.id, b.request_id]);
      if (!l) throw Unprocessable('That request is not serviced at this stop');
    }
    const ins = await txExecute(tx, `INSERT INTO trx_transport_proof (company_id, trip_id, stop_id, request_id, proof_type, receiver_name, file_url, captured_at, uploaded_by) VALUES (?,?,?,?, 'PHOTO', ?,?,?,?)`,
      [req.user!.companyId, t.id, s.id, b.request_id ?? null, b.receiver_name ?? null, b.photo_url, new Date(), req.user!.id]);
    await logStatus(tx, req, { entity: 'STOP', id: s.id, tripId: t.id, event: 'PROOF_ADDED', note: `${s.stop_no}. ${s.location_name}` });
    return { id: ins.insertId };
  });
}));
