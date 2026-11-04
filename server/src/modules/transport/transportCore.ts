/**
 * Transport management core (db/150, client voice notes 04-Nov-2026, Transport spec v1.0 Phase 1).
 *
 * Request  = an employee's need (pickup / drop / courier …), its own status machine.
 * Trip     = the physical journey: ONE driver + ONE vehicle, ordered stops, one or more requests.
 * Stop     = a place on the trip; each stop services requests (PICKUP / DELIVERY lines) with their own result.
 * Request, trip and stop statuses are independent; transitions live here, never in generic CRUD.
 *
 * All business timestamps are server time stored as UTC (the pool runs with timezone 'Z'); screens show IST.
 */
import type { Request } from 'express';
import { z } from 'zod';
import { txExecute, txQuery, txQueryOne, query, type Tx } from '../../config/db.js';
import { Conflict, Forbidden, Unprocessable } from '../../core/errors.js';
import { nextDocNumber } from '../../core/numbering.js';

/* ------------------------------------------------------------------ permissions */
export const P = {
  REQUEST: 'TRANSPORT.REQUEST',
  VIEW: 'TRANSPORT.VIEW',
  APPROVE: 'TRANSPORT.APPROVE',
  APPROVE_OWN: 'TRANSPORT.APPROVE_OWN',
  ASSIGN: 'TRANSPORT.ASSIGN',
  MASTER: 'TRANSPORT.MASTER',
  DRIVER: 'TRANSPORT.DRIVER',
} as const;

export const has = (req: Request, code: string) => !!req.user && (req.user.isSuperAdmin || req.user.permissions.has(code));
export const hasAny = (req: Request, ...codes: string[]) => codes.some((c) => has(req, c));
export function must(req: Request, ...codes: string[]) {
  if (!hasAny(req, ...codes)) throw Forbidden(`Requires one of: ${codes.join(', ')}`);
}

/* ------------------------------------------------------------------ statuses */
export const REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED', 'APPROVED', 'REJECTED', 'ASSIGNED',
  'IN_PROGRESS', 'PICKUP_COMPLETED', 'DELIVERED', 'COMPLETED', 'CANCELLED'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
export const TRIP_STATUSES = ['DRAFT', 'ASSIGNED', 'DRIVER_ACCEPTED', 'STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXCEPTION'] as const;
export type TripStatus = typeof TRIP_STATUSES[number];
/** Trips that hold their driver and vehicle (overlap check). */
export const ACTIVE_TRIP: TripStatus[] = ['ASSIGNED', 'DRIVER_ACCEPTED', 'STARTED', 'IN_PROGRESS'];
export const RUNNING_TRIP: TripStatus[] = ['STARTED', 'IN_PROGRESS'];
/** Request statuses still open (not final). */
export const OPEN_REQUEST: RequestStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'PICKUP_COMPLETED', 'DELIVERED'];

/** Allowed request transitions by action (§5). Anything else is a 409. */
export const REQUEST_FLOW: Record<string, RequestStatus[]> = {
  submit: ['DRAFT', 'CLARIFICATION_REQUIRED'],
  review: ['SUBMITTED'],
  clarify: ['SUBMITTED', 'UNDER_REVIEW'],
  approve: ['SUBMITTED', 'UNDER_REVIEW'],
  reject: ['SUBMITTED', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED'],
  amend: ['SUBMITTED', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED', 'APPROVED'],
  edit: ['DRAFT', 'CLARIFICATION_REQUIRED'],
  // requester: before the trip starts; coordinator: also once it is moving
  cancelOwn: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED', 'APPROVED', 'ASSIGNED'],
  cancelAny: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CLARIFICATION_REQUIRED', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'PICKUP_COMPLETED'],
};

export function assertFrom<T extends string>(current: T, allowed: readonly T[], what: string) {
  if (!allowed.includes(current)) {
    throw Conflict(`Cannot ${what} — it is ${humanStatus(current)} (allowed from ${allowed.map(humanStatus).join(', ')})`, { status: current });
  }
}
export const humanStatus = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Optimistic concurrency: a stale row_version from the screen is a 409 (spec §7.1). */
export function assertVersion(row: { row_version: number }, sent: number | null | undefined) {
  if (sent != null && Number(sent) !== Number(row.row_version)) {
    throw Conflict('This record was changed by someone else — reload and try again', { row_version: row.row_version });
  }
}

/* ------------------------------------------------------------------ time */
/**
 * Parse a client date-time. ISO with an offset is used as is; a bare "YYYY-MM-DDTHH:mm" (datetime-local input)
 * is business time Asia/Kolkata.
 */
export function parseBizTime(v: string): Date {
  const s = v.trim();
  const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s.length === 16 ? `${s}:00` : s}+05:30`;
  const d = new Date(withZone);
  if (Number.isNaN(d.getTime())) throw Unprocessable(`Invalid date-time: ${v}`);
  return d;
}
export const zBizTime = z.string().trim().min(10, 'Enter date and time').transform((v, ctx) => {
  try { return parseBizTime(v); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid date-time' }); return z.NEVER; }
});
const IST_MS = 330 * 60_000;
/** "YYYY-MM-DD" (IST) → UTC Date at 00:00 IST of that day. */
export const istDayStart = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00+05:30`));
export const istDayEnd = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00+05:30`) + 86_400_000);
export const istToday = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
export const istYear = () => istToday().slice(0, 4);
/** "DD-MM-YYYY HH:mm" in IST for reports / Excel. */
export function istText(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const x = new Date(d.getTime() + IST_MS).toISOString();
  return `${x.slice(8, 10)}-${x.slice(5, 7)}-${x.slice(0, 4)} ${x.slice(11, 16)}`;
}
export const hoursBetween = (a: unknown, b: unknown) => {
  if (!a || !b) return null;
  const ms = new Date(String(b instanceof Date ? b.toISOString() : b)).getTime() - new Date(String(a instanceof Date ? a.toISOString() : a)).getTime();
  return Number.isFinite(ms) ? Math.round((ms / 3_600_000) * 100) / 100 : null;
};

/* ------------------------------------------------------------------ numbering */
/** TRN-YYYY-000001 / TRIP-YYYY-000001 (Appendix A) — the series restarts every calendar year. */
export async function nextTransportNo(tx: Tx, companyId: number, kind: 'REQ' | 'TRIP'): Promise<string> {
  const yyyy = istYear();
  const docType = kind === 'REQ' ? `TRANSPORT_REQ_${yyyy}` : `TRANSPORT_TRIP_${yyyy}`;
  const prefix = kind === 'REQ' ? `TRN-${yyyy}-` : `TRIP-${yyyy}-`;
  await txExecute(tx,
    `INSERT INTO cfg_number_series (company_id, branch_id, doc_type, fy_id, prefix, next_number, padding)
     SELECT ?, NULL, ?, NULL, ?, 1, 6 FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM cfg_number_series WHERE company_id = ? AND doc_type = ? AND branch_id IS NULL AND fy_id IS NULL)`,
    [companyId, docType, prefix, companyId, docType]);
  return nextDocNumber(tx, companyId, docType);
}

/* ------------------------------------------------------------------ status log */
export async function logStatus(tx: Tx, req: Request, e: {
  entity: 'REQUEST' | 'TRIP' | 'STOP'; id: number; tripId?: number | null; from?: string | null; to?: string | null;
  event: string; note?: string | null; before?: unknown; after?: unknown;
}) {
  await txExecute(tx,
    `INSERT INTO trx_transport_status_log (company_id, entity_type, entity_id, trip_id, old_status, new_status, event_code, event_note,
       before_json, after_json, actor_user_id, event_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user!.companyId, e.entity, e.id, e.tripId ?? null, e.from ?? null, e.to ?? null, e.event, e.note ?? null,
      e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after),
      req.user!.id, new Date()]);
}

/* ------------------------------------------------------------------ notifications */
/** Users of the company holding a permission (through an active role of that company). */
export async function usersWithPerm(tx: Tx, companyId: number, perm: string): Promise<number[]> {
  const rows = await txQuery<{ user_id: number }>(tx,
    `SELECT DISTINCT ur.user_id FROM map_user_role ur
       JOIN mst_role r ON r.id = ur.role_id AND r.company_id = ? AND r.is_active = 1
       JOIN map_role_permission rp ON rp.role_id = r.id
       JOIN mst_permission p ON p.id = rp.permission_id AND p.permission_code = ?
       JOIN mst_user u ON u.id = ur.user_id AND u.is_active = 1 AND u.is_deleted = 0`, [companyId, perm]);
  return rows.map((r) => Number(r.user_id));
}

/**
 * In-app notification (header messages), once per recipient + event key (unique index) — a retried driver action
 * never notifies twice. The actor is not notified of their own action.
 */
export async function notify(tx: Tx, req: Request, userIds: (number | null | undefined)[], n: {
  key: string; title: string; body?: string; url?: string; refType: string; refId: number;
}) {
  const ids = [...new Set(userIds.filter((u): u is number => !!u).map(Number))].filter((u) => u !== req.user!.id);
  for (const uid of ids) {
    await txExecute(tx,
      `INSERT IGNORE INTO trx_notification (company_id, user_id, title, body, ref_type, ref_id, channel, event_key, action_url)
       VALUES (?,?,?,?,?,?, 'INAPP', ?, ?)`,
      [req.user!.companyId, uid, n.title.slice(0, 200), n.body ?? null, n.refType, n.refId, n.key.slice(0, 120), n.url ?? null]);
  }
}
export const coordinators = (tx: Tx, companyId: number) => usersWithPerm(tx, companyId, P.APPROVE);
export const planners = (tx: Tx, companyId: number) => usersWithPerm(tx, companyId, P.ASSIGN);

/* ------------------------------------------------------------------ loaders (company scoped) */
export async function lockRequest(tx: Tx, companyId: number, id: number) {
  return txQueryOne<any>(tx, `SELECT r.*, t.type_code, t.type_name, t.requires_pickup, t.requires_destination, t.requires_material, t.requires_proof
    FROM trx_transport_request r JOIN cfg_transport_request_type t ON t.id = r.request_type_id
   WHERE r.id = ? AND r.company_id = ? FOR UPDATE`, [id, companyId]);
}
export async function lockTrip(tx: Tx, companyId: number, id: number) {
  return txQueryOne<any>(tx, `SELECT * FROM trx_transport_trip WHERE id = ? AND company_id = ? FOR UPDATE`, [id, companyId]);
}

/* ------------------------------------------------------------------ availability */
export interface Conflicting { id: number; trip_no: string; status: string; planned_start_at: Date; planned_end_at: Date; driver_id: number | null; vehicle_id: number | null }

/**
 * Active trips of the driver or vehicle overlapping [start, end). A running trip holds its vehicle at least until now
 * (it may run past its planned end).
 */
export async function overlapping(tx: Tx | null, companyId: number, start: Date, end: Date,
  who: { driverId?: number | null; vehicleId?: number | null }, excludeTripId?: number | null): Promise<Conflicting[]> {
  const conds: string[] = []; const args: unknown[] = [];
  if (who.driverId) { conds.push('t.driver_id = ?'); args.push(who.driverId); }
  if (who.vehicleId) { conds.push('t.vehicle_id = ?'); args.push(who.vehicleId); }
  if (!conds.length) return [];
  const now = new Date();
  const sql = `SELECT t.id, t.trip_no, t.status, t.planned_start_at, t.planned_end_at, t.driver_id, t.vehicle_id
      FROM trx_transport_trip t
     WHERE t.company_id = ? AND t.id <> ? AND t.status IN (${ACTIVE_TRIP.map(() => '?').join(',')})
       AND (${conds.join(' OR ')})
       AND t.planned_start_at < ?
       AND (CASE WHEN t.status IN ('STARTED','IN_PROGRESS') AND t.planned_end_at < ? THEN ? ELSE t.planned_end_at END) > ?
     ORDER BY t.planned_start_at`;
  const params = [companyId, excludeTripId ?? 0, ...ACTIVE_TRIP, ...args, end, now, now, start];
  return tx ? txQuery<Conflicting>(tx, sql, params) : query<Conflicting>(sql, params);
}

/** Expiry warnings for a vehicle / driver on a date. */
export function expiryWarnings(kind: 'vehicle' | 'driver', row: any, on: Date): string[] {
  const out: string[] = [];
  const day = new Date(on.getTime() + IST_MS).toISOString().slice(0, 10);
  const chk = (col: string, label: string) => {
    const v = row?.[col]; if (!v) return;
    const ymd = String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
    if (ymd < day) out.push(`${label} expired on ${ymd}`);
  };
  if (kind === 'vehicle') { chk('insurance_expiry', 'Insurance'); chk('permit_expiry', 'Permit'); chk('fitness_expiry', 'Fitness'); chk('pollution_expiry', 'Pollution (PUC)'); }
  else chk('licence_expiry', 'Driving licence');
  return out;
}

/* ------------------------------------------------------------------ request status from stop results */
/**
 * Request status from its service lines on the trip (§4.5): Assigned → In progress (trip started) → Pickup completed
 * (a pickup done) → Delivered (every delivery done). Completed is set when the trip closes and every line is served.
 */
export async function refreshRequestFromLines(tx: Tx, req: Request, requestId: number, tripId: number, tripRunning: boolean) {
  const r = await txQueryOne<any>(tx, `SELECT id, status, row_version FROM trx_transport_request WHERE id = ? FOR UPDATE`, [requestId]);
  if (!r || ['CANCELLED', 'COMPLETED', 'REJECTED'].includes(r.status)) return;
  const lines = await txQuery<any>(tx,
    `SELECT sr.service_type, sr.result FROM trx_transport_stop_request sr
       JOIN trx_transport_trip_stop s ON s.id = sr.stop_id AND s.is_active = 1 AND s.trip_id = ?
      WHERE sr.request_id = ?`, [tripId, requestId]);
  const served = (l: any) => l.result === 'DONE' || l.result === 'PARTIAL';
  const dels = lines.filter((l) => l.service_type === 'DELIVERY');
  const picks = lines.filter((l) => l.service_type === 'PICKUP');
  let next: RequestStatus = r.status;
  if (dels.length && dels.every(served)) next = 'DELIVERED';
  else if (picks.some(served)) next = 'PICKUP_COMPLETED';
  else if (tripRunning) next = 'IN_PROGRESS';
  if (next !== r.status) {
    await txExecute(tx, `UPDATE trx_transport_request SET status = ?, row_version = row_version + 1, updated_by = ? WHERE id = ?`, [next, req.user!.id, requestId]);
    await logStatus(tx, req, { entity: 'REQUEST', id: requestId, tripId, from: r.status, to: next, event: `TRIP_${next}` });
  }
}

/** Requester ids of the active requests on a trip. */
export async function tripRequesters(tx: Tx, tripId: number): Promise<number[]> {
  const rows = await txQuery<{ requested_by: number }>(tx,
    `SELECT DISTINCT r.requested_by FROM trx_transport_trip_request tr JOIN trx_transport_request r ON r.id = tr.request_id
      WHERE tr.trip_id = ? AND tr.is_active = 1`, [tripId]);
  return rows.map((r) => Number(r.requested_by));
}
