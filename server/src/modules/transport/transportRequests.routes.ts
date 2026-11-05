/**
 * Staff vehicle requests (spec §4.1, §4.2, §5): create / draft / submit / amend / clarify / approve / reject / cancel,
 * coordinator queue with counters, timeline and attachments. Mounted at /api/transport.
 *
 * Who sees what: a requester sees own requests; TRANSPORT.VIEW sees all of the company. Other companies' rows are 404.
 * Identity (requested_by, approver) always comes from the login — never from the body.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute, txQueryOne, type Tx } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { audit } from '../../core/audit.js';
import { Forbidden, NotFound, Unprocessable, Conflict } from '../../core/errors.js';
import {
  P, has, must, REQUEST_FLOW, assertFrom, assertVersion, zBizTime, nextTransportNo, logStatus, notify, coordinators,
  lockRequest, istDayStart, istDayEnd, humanStatus, istText, type RequestStatus, deliveryPhotoOn, planners,
} from './transportCore.js';

export const transportRequestsRouter = Router();

const idOf = (v: unknown) => z.coerce.number().int().positive().parse(v);
const optStr = (max: number) => z.union([z.string().trim().max(max), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish();
const optId = z.union([z.coerce.number().int().positive(), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish();
const optNum = z.union([z.coerce.number().min(0, 'Must not be negative'), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish();

/** Route + schedule + material fields (shared by create, draft edit and amendment). */
const detailFields = {
  required_at: zBizTime,
  pickup_unit_id: optId, pickup_party_id: optId, pickup_location: optStr(160), pickup_address: optStr(500),
  destination_unit_id: optId, destination_party_id: optId, destination_location: optStr(160), destination_address: optStr(500),
  contact_name: z.string().trim().min(2, 'Contact name is required').max(80),
  contact_mobile: z.string().trim().regex(/^[+]?[\d\s-]{7,20}$/, 'Enter a reachable mobile number'),
  material_description: optStr(500), package_qty: optNum, package_uom: optStr(20),
  passenger_count: z.union([z.coerce.number().int().min(0), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish(),
  remarks: optStr(1000),
};
const requestSchema = z.object({
  request_type_id: z.coerce.number().int().positive('Select the request type'),
  department_id: optId,
  purpose: z.string().trim().min(3, 'Purpose is required').max(255),
  priority: z.enum(['NORMAL', 'URGENT', 'CRITICAL']).default('NORMAL'),
  priority_reason: optStr(255),
  ...detailFields,
  clarification_response: optStr(500),
  submit: z.boolean().optional(),
  row_version: z.coerce.number().int().nullish(),
});
type RequestBody = z.infer<typeof requestSchema>;
const amendSchema = z.object({ ...detailFields, reason: z.string().trim().min(3, 'Reason for the amendment is required').max(500), row_version: z.coerce.number().int().nullish() });

const fieldErr = (field: string, message: string) => Unprocessable(message, [{ field, message }]);

/** Location ids → name / address from the masters (company scoped); typed text wins when given. */
async function resolveLocations(tx: Tx, companyId: number, b: Partial<RequestBody>) {
  for (const side of ['pickup', 'destination'] as const) {
    const unitId = (b as any)[`${side}_unit_id`]; const partyId = (b as any)[`${side}_party_id`];
    if (unitId && partyId) throw fieldErr(`${side}_location`, `Choose either our unit or a party for the ${side}, not both`);
    if (unitId) {
      const u = await txQueryOne<any>(tx, `SELECT unit_name, CONCAT_WS(', ', address_line1, city) addr FROM mst_unit WHERE id = ? AND company_id = ?`, [unitId, companyId]);
      if (!u) throw fieldErr(`${side}_unit_id`, 'Unit not found');
      (b as any)[`${side}_location`] ||= u.unit_name; (b as any)[`${side}_address`] ||= u.addr || null;
    }
    if (partyId) {
      const p = await txQueryOne<any>(tx, `SELECT party_name, (SELECT CONCAT_WS(', ', pa.address_line1, pa.address_line2, pa.city, pa.state, pa.pincode) FROM mst_party_address pa WHERE pa.party_id = p.id AND pa.is_active = 1 ORDER BY pa.is_default DESC, pa.id LIMIT 1) addr
        FROM mst_party p WHERE p.id = ? AND p.company_id = ? AND p.is_deleted = 0`, [partyId, companyId]);
      if (!p) throw fieldErr(`${side}_party_id`, 'Party not found');
      (b as any)[`${side}_location`] ||= p.party_name; (b as any)[`${side}_address`] ||= p.addr || null;
    }
  }
}

/** Type-driven mandatory fields (§2.1), checked on submit and on amendments. */
function validateForSubmit(r: any, type: any) {
  if (Number(type.requires_pickup) && !r.pickup_location) throw fieldErr('pickup_location', `Pickup location is required for ${type.type_name}`);
  if (Number(type.requires_destination) && !r.destination_location) throw fieldErr('destination_location', `Destination is required for ${type.type_name}`);
  if (Number(type.requires_material) && !r.material_description) throw fieldErr('material_description', `Material / parcel description is required for ${type.type_name}`);
  if (r.priority !== 'NORMAL' && !r.priority_reason) throw fieldErr('priority_reason', `Give the reason for ${r.priority.toLowerCase()} priority`);
}

async function loadType(tx: Tx, companyId: number, typeId: number) {
  const t = await txQueryOne<any>(tx, `SELECT * FROM cfg_transport_request_type WHERE id = ? AND company_id = ?`, [typeId, companyId]);
  if (!t) throw fieldErr('request_type_id', 'Request type not found');
  if (!Number(t.is_active)) throw fieldErr('request_type_id', `Request type ${t.type_name} is not active`);
  return t;
}
async function checkDepartment(tx: Tx, companyId: number, deptId: number | null | undefined) {
  if (!deptId) return;
  const d = await txQueryOne(tx, `SELECT id FROM mst_department WHERE id = ? AND company_id = ?`, [deptId, companyId]);
  if (!d) throw fieldErr('department_id', 'Department not found');
}

const reqUrl = (id: number) => `/transport/requests/${id}`;

async function notifySubmitted(tx: Tx, req: Request, r: any, again = false) {
  const users = await coordinators(tx, req.user!.companyId);
  await notify(tx, req, users, {
    key: `TRN:${r.id}:SUBMITTED:${r.row_version}`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: reqUrl(r.id),
    title: `${again ? 'Vehicle request updated' : 'New vehicle request'} ${r.request_no}${r.priority !== 'NORMAL' ? ` · ${r.priority}` : ''}`,
    body: `${req.user!.fullName} · ${r.type_name ?? ''} · ${r.purpose} · needed ${istText(r.required_at)}`,
  });
}

/* ====================================================================== list + queue */
const listQuery = z.object({
  scope: z.enum(['mine', 'all']).optional(),
  status: z.string().optional(), request_type_id: z.coerce.number().optional(), department_id: z.coerce.number().optional(),
  requested_by: z.coerce.number().optional(), priority: z.string().optional(), queue: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  location: z.string().optional(), q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

/** Coordinator counters (§4.2): New, Under review, Approved-unassigned, Assigned, In progress, Delayed, Completed today, Rejected. */
export const QUEUES: Record<string, string> = {
  NEW: `r.status = 'SUBMITTED'`,
  UNDER_REVIEW: `r.status IN ('UNDER_REVIEW','CLARIFICATION_REQUIRED')`,
  APPROVED_UNASSIGNED: `r.status = 'APPROVED'`,
  ASSIGNED: `r.status = 'ASSIGNED'`,
  IN_PROGRESS: `r.status IN ('IN_PROGRESS','PICKUP_COMPLETED','DELIVERED')`,
  DELAYED: `r.status IN ('SUBMITTED','UNDER_REVIEW','CLARIFICATION_REQUIRED','APPROVED','ASSIGNED','IN_PROGRESS','PICKUP_COMPLETED','DELIVERED') AND r.required_at < UTC_TIMESTAMP()`,
  COMPLETED_TODAY: `r.status IN ('COMPLETED','RECEIVED') AND r.completed_at >= ?`,
  // delivered, the requester has not confirmed the material received yet (client 05-Nov-2026)
  PENDING_RECEIPT: `r.status IN ('DELIVERED','COMPLETED')`,
  RECEIVED: `r.status = 'RECEIVED'`,
  REJECTED: `r.status = 'REJECTED'`,
};

const REQ_SELECT = `SELECT r.*, t.type_code, t.type_name, t.requires_pickup, t.requires_destination, t.requires_material, t.requires_proof,
    u.full_name AS requested_by_name, d.dept_name AS department_name, ap.full_name AS approved_by_name,
    tr.trip_no, tr.status AS trip_status, tr.planned_start_at AS trip_start_at, v.registration_no AS vehicle_no, du.full_name AS driver_name
  FROM trx_transport_request r
  JOIN cfg_transport_request_type t ON t.id = r.request_type_id
  JOIN mst_user u ON u.id = r.requested_by
  LEFT JOIN mst_department d ON d.id = r.department_id
  LEFT JOIN mst_user ap ON ap.id = r.approved_by
  LEFT JOIN trx_transport_trip tr ON tr.id = r.current_trip_id
  LEFT JOIN mst_transport_vehicle v ON v.id = tr.vehicle_id
  LEFT JOIN mst_transport_driver dr ON dr.id = tr.driver_id
  LEFT JOIN mst_user du ON du.id = dr.user_id`;

transportRequestsRouter.get('/requests', ah(async (req, res) => {
  must(req, P.REQUEST, P.VIEW);
  const q = listQuery.parse(req.query);
  const all = has(req, P.VIEW) && q.scope !== 'mine';
  const where = ['r.company_id = ?']; const args: unknown[] = [req.user!.companyId];
  if (!all) { where.push('r.requested_by = ?'); args.push(req.user!.id); }
  const todayStart = istDayStart(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
  if (q.queue && QUEUES[q.queue]) { where.push(QUEUES[q.queue]); if (q.queue === 'COMPLETED_TODAY') args.push(todayStart); }
  if (q.status) { const st = q.status.split(',').filter(Boolean); where.push(`r.status IN (${st.map(() => '?').join(',')})`); args.push(...st); }
  if (q.request_type_id) { where.push('r.request_type_id = ?'); args.push(q.request_type_id); }
  if (q.department_id) { where.push('r.department_id = ?'); args.push(q.department_id); }
  if (q.requested_by) { where.push('r.requested_by = ?'); args.push(q.requested_by); }
  if (q.priority) { where.push('r.priority = ?'); args.push(q.priority); }
  if (q.from) { where.push('r.required_at >= ?'); args.push(istDayStart(q.from)); }
  if (q.to) { where.push('r.required_at < ?'); args.push(istDayEnd(q.to)); }
  if (q.location) { where.push('(r.pickup_location LIKE ? OR r.destination_location LIKE ? OR r.pickup_address LIKE ? OR r.destination_address LIKE ?)'); const l = `%${q.location}%`; args.push(l, l, l, l); }
  if (q.q) { where.push('(r.request_no LIKE ? OR r.purpose LIKE ? OR u.full_name LIKE ? OR r.contact_name LIKE ? OR r.material_description LIKE ?)'); const l = `%${q.q}%`; args.push(l, l, l, l, l); }
  const w = where.join(' AND ');
  const [{ n }] = await query<{ n: number }>(`SELECT COUNT(*) n FROM trx_transport_request r JOIN mst_user u ON u.id = r.requested_by WHERE ${w}`, args);
  const rows = await query(`${REQ_SELECT} WHERE ${w}
      ORDER BY FIELD(r.status,'SUBMITTED','UNDER_REVIEW','CLARIFICATION_REQUIRED','APPROVED','ASSIGNED','IN_PROGRESS','PICKUP_COMPLETED','DELIVERED','DRAFT','COMPLETED','RECEIVED','REJECTED','CANCELLED'),
               FIELD(r.priority,'CRITICAL','URGENT','NORMAL'), r.required_at, r.id DESC
      LIMIT ? OFFSET ?`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
  // counters over the same visibility (not the queue / status filter)
  const base = all ? 'r.company_id = ?' : 'r.company_id = ? AND r.requested_by = ?';
  const baseArgs = all ? [req.user!.companyId] : [req.user!.companyId, req.user!.id];
  const counters: Record<string, number> = {};
  const parts = Object.entries(QUEUES).map(([k, cond]) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) AS \`${k}\``);
  const c = await queryOne<any>(`SELECT ${parts.join(', ')}, SUM(r.status = 'DRAFT') AS DRAFT FROM trx_transport_request r WHERE ${base}`, [todayStart, ...baseArgs]);
  for (const k of [...Object.keys(QUEUES), 'DRAFT']) counters[k] = Number(c?.[k] ?? 0);
  // the signed-in user's own requests waiting for "Confirm material received" (also for coordinators viewing all)
  const mineWaiting = await queryOne<any>(`SELECT COUNT(*) n FROM trx_transport_request r WHERE r.company_id = ? AND r.requested_by = ? AND ${QUEUES.PENDING_RECEIPT}`, [req.user!.companyId, req.user!.id]);
  counters.MY_PENDING_RECEIPT = Number(mineWaiting?.n ?? 0);
  res.json({ data: rows, counters, scope: all ? 'all' : 'mine',
    pagination: { page: q.page, pageSize: q.pageSize, total: Number(n), totalPages: Math.max(1, Math.ceil(Number(n) / q.pageSize)) } });
}));

/** A request the user may see: own, or any with TRANSPORT.VIEW; drivers see requests on their trips via /driver. */
async function visibleRequest(req: Request, id: number) {
  const r = await queryOne<any>(`${REQ_SELECT} WHERE r.id = ? AND r.company_id = ?`, [id, req.user!.companyId]);
  if (!r) throw NotFound('Vehicle request not found');
  if (Number(r.requested_by) !== req.user!.id && !has(req, P.VIEW)) throw NotFound('Vehicle request not found');
  return r;
}

transportRequestsRouter.get('/requests/:id', ah(async (req, res) => {
  must(req, P.REQUEST, P.VIEW);
  const r = await visibleRequest(req, idOf(req.params.id));
  const [timeline, attachments, trips, proofs, lines] = await Promise.all([
    query(`SELECT l.id, l.entity_type, l.old_status, l.new_status, l.event_code, l.event_note, l.before_json, l.after_json, l.event_at, u.full_name AS actor_name, t.trip_no
             FROM trx_transport_status_log l LEFT JOIN mst_user u ON u.id = l.actor_user_id LEFT JOIN trx_transport_trip t ON t.id = l.trip_id
            WHERE l.company_id = ? AND ((l.entity_type = 'REQUEST' AND l.entity_id = ?)
               OR (l.entity_type IN ('TRIP','STOP') AND l.trip_id IN (SELECT trip_id FROM trx_transport_trip_request WHERE request_id = ?)))
            ORDER BY l.event_at, l.id`, [req.user!.companyId, r.id, r.id]),
    query(`SELECT a.*, u.full_name AS uploaded_by_name FROM trx_transport_request_attachment a LEFT JOIN mst_user u ON u.id = a.uploaded_by WHERE a.request_id = ? AND a.is_active = 1 ORDER BY a.id`, [r.id]),
    query(`SELECT tr.trip_id, tr.is_active, tr.linked_at, tr.unlinked_at, tr.unlink_reason, t.trip_no, t.status, t.planned_start_at, t.planned_end_at,
                  v.registration_no AS vehicle_no, v.ownership_type, du.full_name AS driver_name, d.mobile_no AS driver_mobile
             FROM trx_transport_trip_request tr JOIN trx_transport_trip t ON t.id = tr.trip_id
             LEFT JOIN mst_transport_vehicle v ON v.id = t.vehicle_id LEFT JOIN mst_transport_driver d ON d.id = t.driver_id LEFT JOIN mst_user du ON du.id = d.user_id
            WHERE tr.request_id = ? ORDER BY tr.id`, [r.id]),
    query(`SELECT p.*, s.location_name FROM trx_transport_proof p LEFT JOIN trx_transport_trip_stop s ON s.id = p.stop_id WHERE p.request_id = ? ORDER BY p.id`, [r.id]),
    query(`SELECT sr.*, s.stop_no, s.location_name, s.status AS stop_status, s.actual_arrival_at, t.trip_no
             FROM trx_transport_stop_request sr JOIN trx_transport_trip_stop s ON s.id = sr.stop_id AND s.is_active = 1 JOIN trx_transport_trip t ON t.id = s.trip_id
            WHERE sr.request_id = ? ORDER BY t.id, s.stop_no`, [r.id]),
  ]);
  const mine = Number(r.requested_by) === req.user!.id;
  const st = r.status as RequestStatus;
  const canApprove = has(req, P.APPROVE) && (!mine || has(req, P.APPROVE_OWN));
  res.json({ data: { ...r, timeline, attachments, trips, proofs, service_lines: lines,
    actions: {
      edit: mine && REQUEST_FLOW.edit.includes(st),
      submit: mine && REQUEST_FLOW.submit.includes(st),
      amend: (mine || has(req, P.APPROVE)) && REQUEST_FLOW.amend.includes(st),
      review: has(req, P.APPROVE) && REQUEST_FLOW.review.includes(st),
      clarify: has(req, P.APPROVE) && REQUEST_FLOW.clarify.includes(st),
      approve: canApprove && REQUEST_FLOW.approve.includes(st),
      reject: has(req, P.APPROVE) && REQUEST_FLOW.reject.includes(st),
      cancel: (has(req, P.APPROVE) && REQUEST_FLOW.cancelAny.includes(st)) || (mine && REQUEST_FLOW.cancelOwn.includes(st) && (st !== 'ASSIGNED' || !['STARTED', 'IN_PROGRESS'].includes(r.trip_status))),
      assign: has(req, P.ASSIGN) && st === 'APPROVED',
      confirm_received: (mine || has(req, P.APPROVE)) && REQUEST_FLOW.confirmReceived.includes(st),
    }, delivery_photo: await deliveryPhotoOn(req.user!.companyId) } });
}));

/** Screen switches for the transport pages (any transport user). */
transportRequestsRouter.get('/settings', ah(async (req, res) => {
  must(req, P.REQUEST, P.VIEW, P.ASSIGN, P.DRIVER, P.APPROVE);
  res.json({ data: { delivery_photo: await deliveryPhotoOn(req.user!.companyId) } });
}));

/* ====================================================================== create / edit draft */
transportRequestsRouter.post('/requests', ah(async (req, res) => {
  must(req, P.REQUEST);
  const b = requestSchema.parse(req.body);
  const created = await transaction(async (tx) => {
    const type = await loadType(tx, req.user!.companyId, b.request_type_id);
    await checkDepartment(tx, req.user!.companyId, b.department_id);
    await resolveLocations(tx, req.user!.companyId, b);
    if (b.submit) validateForSubmit(b, type);
    const requestNo = await nextTransportNo(tx, req.user!.companyId, 'REQ');
    const status: RequestStatus = b.submit ? 'SUBMITTED' : 'DRAFT';
    const now = new Date();
    const r = await txExecute(tx,
      `INSERT INTO trx_transport_request (company_id, request_no, requested_by, department_id, request_type_id, purpose, priority, priority_reason, status, required_at,
         pickup_unit_id, pickup_party_id, pickup_location, pickup_address, destination_unit_id, destination_party_id, destination_location, destination_address,
         contact_name, contact_mobile, material_description, package_qty, package_uom, passenger_count, remarks, submitted_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, requestNo, req.user!.id, b.department_id ?? null, b.request_type_id, b.purpose, b.priority, b.priority_reason ?? null, status, b.required_at,
        b.pickup_unit_id ?? null, b.pickup_party_id ?? null, b.pickup_location ?? null, b.pickup_address ?? null,
        b.destination_unit_id ?? null, b.destination_party_id ?? null, b.destination_location ?? null, b.destination_address ?? null,
        b.contact_name, b.contact_mobile, b.material_description ?? null, b.package_qty ?? null, b.package_uom ?? null, b.passenger_count ?? null, b.remarks ?? null,
        b.submit ? now : null, req.user!.id]);
    const id = r.insertId;
    await logStatus(tx, req, { entity: 'REQUEST', id, from: null, to: 'DRAFT', event: 'CREATED' });
    if (b.submit) await logStatus(tx, req, { entity: 'REQUEST', id, from: 'DRAFT', to: 'SUBMITTED', event: 'SUBMITTED' });
    const row = await txQueryOne<any>(tx, `SELECT * FROM trx_transport_request WHERE id = ?`, [id]);
    await audit(req, 'trx_transport_request', id, 'INSERT', undefined, row, tx);
    if (b.submit) await notifySubmitted(tx, req, { ...row, type_name: type.type_name });
    return row;
  });
  res.status(201).json({ data: created, message: `Request ${created.request_no} ${created.status === 'SUBMITTED' ? 'submitted — next: coordinator review' : 'saved as draft'}` });
}));

transportRequestsRouter.put('/requests/:id', ah(async (req, res) => {
  must(req, P.REQUEST);
  const id = idOf(req.params.id);
  const b = requestSchema.parse(req.body);
  const after = await transaction(async (tx) => {
    const before = await lockRequest(tx, req.user!.companyId, id);
    if (!before || (Number(before.requested_by) !== req.user!.id && !has(req, P.VIEW))) throw NotFound('Vehicle request not found');
    if (Number(before.requested_by) !== req.user!.id) throw Forbidden('Only the requester edits a draft — use an amendment');
    assertFrom(before.status, REQUEST_FLOW.edit, 'edit this request');
    assertVersion(before, b.row_version);
    const type = await loadType(tx, req.user!.companyId, b.request_type_id);
    await checkDepartment(tx, req.user!.companyId, b.department_id);
    await resolveLocations(tx, req.user!.companyId, b);
    const submit = !!b.submit;
    if (submit) validateForSubmit(b, type);
    if (submit && before.status === 'CLARIFICATION_REQUIRED' && !b.clarification_response) throw fieldErr('clarification_response', 'Answer the coordinator\'s question');
    const next: RequestStatus = submit ? 'SUBMITTED' : before.status;
    await txExecute(tx,
      `UPDATE trx_transport_request SET department_id = ?, request_type_id = ?, purpose = ?, priority = ?, priority_reason = ?, required_at = ?,
         pickup_unit_id = ?, pickup_party_id = ?, pickup_location = ?, pickup_address = ?, destination_unit_id = ?, destination_party_id = ?, destination_location = ?, destination_address = ?,
         contact_name = ?, contact_mobile = ?, material_description = ?, package_qty = ?, package_uom = ?, passenger_count = ?, remarks = ?,
         clarification_response = COALESCE(?, clarification_response), status = ?, submitted_at = IF(?, ?, submitted_at), row_version = row_version + 1, updated_by = ?
       WHERE id = ?`,
      [b.department_id ?? null, b.request_type_id, b.purpose, b.priority, b.priority_reason ?? null, b.required_at,
        b.pickup_unit_id ?? null, b.pickup_party_id ?? null, b.pickup_location ?? null, b.pickup_address ?? null,
        b.destination_unit_id ?? null, b.destination_party_id ?? null, b.destination_location ?? null, b.destination_address ?? null,
        b.contact_name, b.contact_mobile, b.material_description ?? null, b.package_qty ?? null, b.package_uom ?? null, b.passenger_count ?? null, b.remarks ?? null,
        b.clarification_response ?? null, next, submit ? 1 : 0, new Date(), req.user!.id, id]);
    const row = await txQueryOne<any>(tx, `SELECT * FROM trx_transport_request WHERE id = ?`, [id]);
    await audit(req, 'trx_transport_request', id, 'UPDATE', before, row, tx);
    if (submit) {
      await logStatus(tx, req, { entity: 'REQUEST', id, from: before.status, to: 'SUBMITTED', event: before.status === 'CLARIFICATION_REQUIRED' ? 'CLARIFICATION_ANSWERED' : 'SUBMITTED', note: b.clarification_response ?? null });
      await notifySubmitted(tx, req, { ...row, type_name: type.type_name }, before.status === 'CLARIFICATION_REQUIRED');
    } else {
      await logStatus(tx, req, { entity: 'REQUEST', id, from: before.status, to: before.status, event: 'EDITED' });
    }
    return row;
  });
  res.json({ data: after });
}));

/* ====================================================================== actions */
const reasonSchema = (label: string, required: boolean) => z.object({
  [required ? 'reason' : 'remarks']: required ? z.string().trim().min(3, `${label} is required`).max(500) : z.string().trim().max(500).nullish(),
  row_version: z.coerce.number().int().nullish(),
});

/** Run one guarded request transition: lock, check visibility / state / version, then apply. */
async function act(req: Request, id: number, fn: (tx: Tx, r: any) => Promise<void>) {
  return transaction(async (tx) => {
    const r = await lockRequest(tx, req.user!.companyId, id);
    if (!r || (Number(r.requested_by) !== req.user!.id && !has(req, P.VIEW))) throw NotFound('Vehicle request not found');
    await fn(tx, r);
    return txQueryOne<any>(tx, `SELECT * FROM trx_transport_request WHERE id = ?`, [id]);
  });
}

transportRequestsRouter.post('/requests/:id/submit', ah(async (req, res) => {
  must(req, P.REQUEST);
  const b = z.object({ clarification_response: z.string().trim().max(500).nullish(), row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {});
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    if (Number(r.requested_by) !== req.user!.id) throw Forbidden('Only the requester submits the request');
    assertFrom(r.status, REQUEST_FLOW.submit, 'submit this request');
    assertVersion(r, b.row_version);
    validateForSubmit(r, r);
    if (r.status === 'CLARIFICATION_REQUIRED' && !b.clarification_response && !r.clarification_response) throw fieldErr('clarification_response', 'Answer the coordinator\'s question');
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'SUBMITTED', submitted_at = ?, clarification_response = COALESCE(?, clarification_response), row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [new Date(), b.clarification_response ?? null, req.user!.id, r.id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, from: r.status, to: 'SUBMITTED', event: r.status === 'CLARIFICATION_REQUIRED' ? 'CLARIFICATION_ANSWERED' : 'SUBMITTED', note: b.clarification_response ?? null });
    await audit(req, 'trx_transport_request', r.id, 'UPDATE', { status: r.status }, { status: 'SUBMITTED' }, tx);
    await notifySubmitted(tx, req, { ...r, row_version: r.row_version + 1 }, r.status === 'CLARIFICATION_REQUIRED');
  });
  res.json({ data: row, message: `Request ${row.request_no} submitted — next: coordinator review` });
}));

transportRequestsRouter.post('/requests/:id/review', ah(async (req, res) => {
  must(req, P.APPROVE);
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    assertFrom(r.status, REQUEST_FLOW.review, 'take this request for review');
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'UNDER_REVIEW', reviewed_by = ?, reviewed_at = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [req.user!.id, new Date(), req.user!.id, r.id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, from: r.status, to: 'UNDER_REVIEW', event: 'UNDER_REVIEW' });
  });
  res.json({ data: row });
}));

transportRequestsRouter.post('/requests/:id/clarification', ah(async (req, res) => {
  must(req, P.APPROVE);
  const b = z.object({ question: z.string().trim().min(3, 'Write the question for the requester').max(500), row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {});
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    assertFrom(r.status, REQUEST_FLOW.clarify, 'ask for clarification');
    assertVersion(r, b.row_version);
    const now = new Date();
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'CLARIFICATION_REQUIRED', clarification_question = ?, clarification_by = ?, clarification_at = ?, clarification_response = NULL,
        reviewed_by = COALESCE(reviewed_by, ?), reviewed_at = COALESCE(reviewed_at, ?), row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [b.question, req.user!.id, now, req.user!.id, now, req.user!.id, r.id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, from: r.status, to: 'CLARIFICATION_REQUIRED', event: 'CLARIFICATION_REQUESTED', note: b.question });
    await audit(req, 'trx_transport_request', r.id, 'UPDATE', { status: r.status }, { status: 'CLARIFICATION_REQUIRED', question: b.question }, tx);
    await notify(tx, req, [r.requested_by], { key: `TRN:${r.id}:CLARIFY:${r.row_version}`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: reqUrl(r.id),
      title: `Clarification needed on ${r.request_no}`, body: b.question });
  });
  res.json({ data: row });
}));

transportRequestsRouter.post('/requests/:id/approve', ah(async (req, res) => {
  must(req, P.APPROVE);
  const b = z.object({ remarks: z.string().trim().max(500).nullish(), row_version: z.coerce.number().int().nullish() }).parse(req.body ?? {});
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    if (Number(r.requested_by) === req.user!.id && !has(req, P.APPROVE_OWN)) throw Forbidden('You cannot approve your own vehicle request');
    assertFrom(r.status, REQUEST_FLOW.approve, 'approve this request');
    assertVersion(r, b.row_version);
    const now = new Date();
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'APPROVED', approved_by = ?, approved_at = ?, approval_remarks = ?,
        reviewed_by = COALESCE(reviewed_by, ?), reviewed_at = COALESCE(reviewed_at, ?), row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [req.user!.id, now, b.remarks ?? null, req.user!.id, now, req.user!.id, r.id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, from: r.status, to: 'APPROVED', event: 'APPROVED', note: b.remarks ?? null });
    await audit(req, 'trx_transport_request', r.id, 'UPDATE', { status: r.status }, { status: 'APPROVED', remarks: b.remarks ?? null }, tx);
    await notify(tx, req, [r.requested_by], { key: `TRN:${r.id}:APPROVED:${r.row_version}`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: reqUrl(r.id),
      title: `Vehicle request ${r.request_no} approved`, body: `${b.remarks ? `${b.remarks} · ` : ''}Next: a vehicle and driver will be allocated` });
  });
  res.json({ data: row });
}));

transportRequestsRouter.post('/requests/:id/reject', ah(async (req, res) => {
  must(req, P.APPROVE);
  const b = reasonSchema('Rejection reason', true).parse(req.body ?? {}) as { reason: string; row_version?: number | null };
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    assertFrom(r.status, REQUEST_FLOW.reject, 'reject this request');
    assertVersion(r, b.row_version);
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'REJECTED', rejected_by = ?, rejected_at = ?, rejection_reason = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [req.user!.id, new Date(), b.reason, req.user!.id, r.id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, from: r.status, to: 'REJECTED', event: 'REJECTED', note: b.reason });
    await audit(req, 'trx_transport_request', r.id, 'UPDATE', { status: r.status }, { status: 'REJECTED', reason: b.reason }, tx);
    await notify(tx, req, [r.requested_by], { key: `TRN:${r.id}:REJECTED:${r.row_version}`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: reqUrl(r.id),
      title: `Vehicle request ${r.request_no} rejected`, body: b.reason });
  });
  res.json({ data: row });
}));

/**
 * Cancel (§5): requester until the trip starts, coordinator also afterwards. An assigned request leaves its trip:
 * the link is closed and its pending stop lines are marked failed ("request cancelled").
 */
transportRequestsRouter.post('/requests/:id/cancel', ah(async (req, res) => {
  must(req, P.REQUEST, P.APPROVE);
  const b = reasonSchema('Cancellation reason', true).parse(req.body ?? {}) as { reason: string; row_version?: number | null };
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    const mine = Number(r.requested_by) === req.user!.id;
    const coord = has(req, P.APPROVE);
    const trip = r.current_trip_id ? await txQueryOne<any>(tx, `SELECT * FROM trx_transport_trip WHERE id = ? FOR UPDATE`, [r.current_trip_id]) : null;
    const started = trip && ['STARTED', 'IN_PROGRESS'].includes(trip.status);
    if (coord) assertFrom(r.status, REQUEST_FLOW.cancelAny, 'cancel this request');
    else if (mine) {
      assertFrom(r.status, REQUEST_FLOW.cancelOwn, 'cancel this request');
      if (started) throw Conflict(`Trip ${trip.trip_no} has started — only the transport coordinator can cancel now`);
    } else throw Forbidden('Only the requester or the transport coordinator can cancel');
    assertVersion(r, b.row_version);
    if (trip) {
      await txExecute(tx, `UPDATE trx_transport_trip_request SET is_active = 0, unlinked_by = ?, unlinked_at = ?, unlink_reason = ? WHERE trip_id = ? AND request_id = ? AND is_active = 1`,
        [req.user!.id, new Date(), `Request cancelled: ${b.reason}`, trip.id, r.id]);
      await txExecute(tx, `UPDATE trx_transport_stop_request sr JOIN trx_transport_trip_stop s ON s.id = sr.stop_id SET sr.result = 'FAILED', sr.result_note = 'Request cancelled'
          WHERE s.trip_id = ? AND sr.request_id = ? AND sr.result = 'PENDING'`, [trip.id, r.id]);
      await logStatus(tx, req, { entity: 'TRIP', id: trip.id, tripId: trip.id, from: trip.status, to: trip.status, event: 'REQUEST_REMOVED', note: `${r.request_no} cancelled: ${b.reason}` });
      const drv = trip.driver_id ? await txQueryOne<any>(tx, `SELECT user_id FROM mst_transport_driver WHERE id = ?`, [trip.driver_id]) : null;
      await notify(tx, req, [drv?.user_id], { key: `TRIP:${trip.id}:REQCANCEL:${r.id}`, refType: 'TRANSPORT_TRIP', refId: trip.id, url: `/driver/trips/${trip.id}`,
        title: `${r.request_no} cancelled on trip ${trip.trip_no}`, body: b.reason });
    }
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?, cancel_reason = ?, current_trip_id = NULL, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [req.user!.id, new Date(), b.reason, req.user!.id, r.id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, tripId: trip?.id ?? null, from: r.status, to: 'CANCELLED', event: 'CANCELLED', note: b.reason });
    await audit(req, 'trx_transport_request', r.id, 'UPDATE', { status: r.status }, { status: 'CANCELLED', reason: b.reason }, tx);
    if (!mine) await notify(tx, req, [r.requested_by], { key: `TRN:${r.id}:CANCELLED`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: reqUrl(r.id), title: `Vehicle request ${r.request_no} cancelled`, body: b.reason });
    else if (r.status !== 'DRAFT') await notify(tx, req, await coordinators(tx, req.user!.companyId), { key: `TRN:${r.id}:CANCELLED`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: reqUrl(r.id), title: `Vehicle request ${r.request_no} cancelled by requester`, body: b.reason });
  });
  res.json({ data: row });
}));

/**
 * Requester confirms the material received (client 05-Nov-2026): "when we receive the material, OUR person must update
 * received". From Delivered / Completed → RECEIVED (final) with the received date-time (default now), qty (default the
 * requested qty), condition OK / SHORT / DAMAGED (remarks required when not OK). The requester, or a coordinator
 * (TRANSPORT.APPROVE) on their behalf. The coordinators are notified; a short / damaged receipt is flagged.
 */
const receivedSchema = z.object({
  received_at: z.union([zBizTime, z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish(),
  received_qty: optNum,
  condition: z.enum(['OK', 'SHORT', 'DAMAGED']).default('OK'),
  remarks: optStr(500),
  row_version: z.coerce.number().int().nullish(),
});
transportRequestsRouter.post('/requests/:id/confirm-received', ah(async (req, res) => {
  must(req, P.REQUEST, P.APPROVE);
  const b = receivedSchema.parse(req.body ?? {});
  const now = new Date();
  const at = b.received_at ?? now;
  if (at.getTime() > now.getTime() + 5 * 60_000) throw fieldErr('received_at', 'Received time cannot be in the future');
  if (b.condition !== 'OK' && !b.remarks) throw fieldErr('remarks', `Say what was ${b.condition === 'SHORT' ? 'short' : 'damaged'} in the remarks`);
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    const mine = Number(r.requested_by) === req.user!.id;
    if (!mine && !has(req, P.APPROVE)) throw Forbidden('Only the requester (or the transport coordinator) confirms the material received');
    assertFrom(r.status, REQUEST_FLOW.confirmReceived, 'confirm the material received');
    assertVersion(r, b.row_version);
    // the screen sends minutes only (datetime-local) — a minute of tolerance
    if (r.submitted_at && at.getTime() < new Date(r.submitted_at).getTime() - 60_000) throw fieldErr('received_at', 'Received time is before the request was raised');
    const qty = b.received_qty ?? (r.package_qty != null ? Number(r.package_qty) : null);
    if (b.condition === 'OK' && qty != null && r.package_qty != null && qty < Number(r.package_qty)) throw fieldErr('condition', `Received ${qty} of ${Number(r.package_qty)} — mark the condition Short and say what is missing`);
    await txExecute(tx, `UPDATE trx_transport_request SET status = 'RECEIVED', received_at = ?, received_by = ?, received_qty = ?, received_condition = ?, received_remarks = ?,
        received_recorded_at = ?, completed_at = COALESCE(completed_at, ?), row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [at, req.user!.id, qty, b.condition, b.remarks ?? null, now, at, req.user!.id, r.id]);
    const note = [`${b.condition === 'OK' ? 'Received OK' : `Received — ${b.condition.toLowerCase()}`}${qty != null ? ` · qty ${qty}${r.package_uom ? ` ${r.package_uom}` : ''}` : ''}`, istText(at), mine ? null : `recorded by ${req.user!.fullName} for the requester`, b.remarks].filter(Boolean).join(' · ');
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, tripId: r.current_trip_id ?? null, from: r.status, to: 'RECEIVED', event: 'MATERIAL_RECEIVED', note });
    await audit(req, 'trx_transport_request', r.id, 'UPDATE', { status: r.status }, { status: 'RECEIVED', received_at: at, received_qty: qty, condition: b.condition, remarks: b.remarks ?? null }, tx);
    const who = [...await coordinators(tx, req.user!.companyId), ...await planners(tx, req.user!.companyId), ...(mine ? [] : [Number(r.requested_by)])];
    await notify(tx, req, who, { key: `TRN:${r.id}:RECEIVED`, refType: 'TRANSPORT_REQUEST', refId: r.id, url: reqUrl(r.id),
      title: `${b.condition === 'OK' ? '' : '⚠ '}${r.request_no} material received${b.condition === 'OK' ? '' : ` — ${b.condition.toLowerCase()}`}`, body: note });
  });
  res.json({ data: row });
}));

/**
 * Amendment after submission (§4.1): route / time / material / contact changes with a reason; before / after values kept
 * in the timeline. A requester's change to an approved request sends it back for review.
 */
transportRequestsRouter.post('/requests/:id/amendment', ah(async (req, res) => {
  must(req, P.REQUEST, P.APPROVE);
  const b = amendSchema.parse(req.body ?? {});
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    const mine = Number(r.requested_by) === req.user!.id;
    if (!mine && !has(req, P.APPROVE)) throw Forbidden('Only the requester or the transport coordinator can amend');
    assertFrom(r.status, REQUEST_FLOW.amend, 'amend this request');
    assertVersion(r, b.row_version);
    await resolveLocations(tx, req.user!.companyId, b as any);
    const keys = ['required_at', 'pickup_unit_id', 'pickup_party_id', 'pickup_location', 'pickup_address', 'destination_unit_id', 'destination_party_id', 'destination_location', 'destination_address',
      'contact_name', 'contact_mobile', 'material_description', 'package_qty', 'package_uom', 'passenger_count', 'remarks'] as const;
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
    const before: Record<string, unknown> = {}; const after: Record<string, unknown> = {};
    for (const k of keys) {
      const nv = (b as any)[k] ?? null;
      if (norm(r[k]) !== norm(nv) && !(typeof nv === 'number' && Number(r[k]) === nv)) { before[k] = r[k]; after[k] = nv; }
    }
    if (!Object.keys(after).length) throw Unprocessable('Nothing changed');
    validateForSubmit({ ...r, ...after }, r);
    const backToReview = mine && !has(req, P.APPROVE) && r.status === 'APPROVED';
    const next: RequestStatus = backToReview ? 'SUBMITTED' : r.status;
    await txExecute(tx, `UPDATE trx_transport_request SET ${Object.keys(after).map((k) => `${k} = ?`).join(', ')}, status = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [...Object.values(after), next, req.user!.id, r.id]);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, from: r.status, to: next, event: 'AMENDED', note: b.reason, before, after });
    await audit(req, 'trx_transport_request', r.id, 'UPDATE', before, after, tx);
    const msg = { refType: 'TRANSPORT_REQUEST', refId: r.id, url: reqUrl(r.id), title: `Vehicle request ${r.request_no} amended${backToReview ? ' — needs review again' : ''}`, body: `${b.reason} · ${Object.keys(after).map(humanStatus).join(', ')}` };
    if (mine) await notify(tx, req, await coordinators(tx, req.user!.companyId), { ...msg, key: `TRN:${r.id}:AMENDED:${r.row_version}` });
    else await notify(tx, req, [r.requested_by], { ...msg, key: `TRN:${r.id}:AMENDED:${r.row_version}` });
  });
  res.json({ data: row });
}));

/* ====================================================================== attachments */
transportRequestsRouter.post('/requests/:id/attachments', ah(async (req, res) => {
  must(req, P.REQUEST, P.APPROVE);
  const b = z.object({
    file_name: z.string().trim().min(1).max(200),
    file_url: z.string().trim().regex(/^\/uploads\/(attachments|documents)\/[\w.-]+$/, 'Upload the file first'),
    mime_type: z.string().trim().max(80).nullish(), file_size: z.coerce.number().int().min(0).max(10 * 1024 * 1024).nullish(),
  }).parse(req.body ?? {});
  const row = await act(req, idOf(req.params.id), async (tx, r) => {
    if (Number(r.requested_by) !== req.user!.id && !has(req, P.APPROVE)) throw Forbidden();
    if (['CANCELLED', 'REJECTED', 'COMPLETED'].includes(r.status)) throw Conflict(`Request is ${humanStatus(r.status)}`);
    const ins = await txExecute(tx, `INSERT INTO trx_transport_request_attachment (company_id, request_id, file_name, file_url, mime_type, file_size, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, r.id, b.file_name, b.file_url, b.mime_type ?? null, b.file_size ?? null, req.user!.id, new Date()]);
    await audit(req, 'trx_transport_request_attachment', ins.insertId, 'INSERT', undefined, b, tx);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, from: r.status, to: r.status, event: 'ATTACHMENT_ADDED', note: b.file_name });
  });
  res.status(201).json({ data: row });
}));

transportRequestsRouter.delete('/requests/:id/attachments/:attId', ah(async (req, res) => {
  must(req, P.REQUEST, P.APPROVE);
  const attId = idOf(req.params.attId);
  await act(req, idOf(req.params.id), async (tx, r) => {
    if (Number(r.requested_by) !== req.user!.id && !has(req, P.APPROVE)) throw Forbidden();
    const a = await txQueryOne<any>(tx, `SELECT * FROM trx_transport_request_attachment WHERE id = ? AND request_id = ? AND is_active = 1`, [attId, r.id]);
    if (!a) throw NotFound('Attachment not found');
    await txExecute(tx, `UPDATE trx_transport_request_attachment SET is_active = 0 WHERE id = ?`, [attId]);
    await audit(req, 'trx_transport_request_attachment', attId, 'UPDATE', { is_active: 1 }, { is_active: 0 }, tx);
    await logStatus(tx, req, { entity: 'REQUEST', id: r.id, from: r.status, to: r.status, event: 'ATTACHMENT_REMOVED', note: a.file_name });
  });
  res.json({ data: { success: true } });
}));

/** Approved requests not on a trip yet — the trip planner's picker. */
transportRequestsRouter.get('/assignable-requests', ah(async (req, res) => {
  must(req, P.ASSIGN);
  const tripId = z.coerce.number().int().optional().parse(req.query.trip_id);
  const rows = await txlessAssignable(req.user!.companyId, tripId ?? null);
  res.json({ data: rows });
}));
async function txlessAssignable(companyId: number, tripId: number | null) {
  return query(`${REQ_SELECT} WHERE r.company_id = ? AND (r.status = 'APPROVED' OR (r.status = 'ASSIGNED' AND r.current_trip_id = ?))
      ORDER BY FIELD(r.priority,'CRITICAL','URGENT','NORMAL'), r.required_at`, [companyId, tripId ?? 0]);
}
