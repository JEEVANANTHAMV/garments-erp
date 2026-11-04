/**
 * Transport masters (spec §4.3, §4.4, §2.1): vehicles (owned + rental), staff drivers, request types,
 * plus the pickers the request form and the trip planner need. No hard delete — deactivate instead.
 * Mounted at /api/transport.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute, txQueryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { audit } from '../../core/audit.js';
import { NotFound, Unprocessable, Conflict } from '../../core/errors.js';
import { P, must, assertVersion, overlapping, expiryWarnings, RUNNING_TRIP } from './transportCore.js';

export const transportMastersRouter = Router();

const id = (v: unknown) => z.coerce.number().int().positive().parse(v);
const optStr = (max: number) => z.union([z.string().trim().max(max), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish();
const optDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish();
const optNum = z.union([z.coerce.number().min(0, 'Must not be negative'), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish();
const mobile = z.string().trim().regex(/^[+]?[\d\s-]{7,20}$/, 'Enter a reachable mobile number');

export const VEHICLE_TYPES = ['CAR', 'VAN', 'PICKUP', 'MINI_TRUCK', 'TRUCK', 'TWO_WHEELER', 'BUS', 'OTHER'] as const;
const normReg = (v: string) => v.toUpperCase().replace(/[\s\-.]/g, '');

/* ====================================================================== vehicles */
const vehicleSchema = z.object({
  vehicle_code: optStr(30),
  registration_no: z.string().trim().min(4, 'Registration number is required').max(20).transform(normReg)
    .refine((v) => /^[A-Z0-9]{4,15}$/.test(v), 'Registration number: letters and digits only'),
  ownership_type: z.enum(['OWNED', 'RENTAL']),
  vehicle_type: z.enum(VEHICLE_TYPES),
  make: optStr(60), model: optStr(60),
  capacity: optNum, capacity_uom: optStr(20), seating: z.union([z.coerce.number().int().min(0), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish(),
  rental_party_id: z.union([z.coerce.number().int().positive(), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish(),
  rental_provider_name: optStr(160), rental_provider_contact: optStr(60),
  rental_rate: optNum, rental_rate_basis: z.union([z.enum(['TRIP', 'DAY', 'KM', 'MONTH']), z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish(),
  availability_status: z.enum(['AVAILABLE', 'MAINTENANCE', 'INACTIVE']).default('AVAILABLE'),
  insurance_expiry: optDate, permit_expiry: optDate, fitness_expiry: optDate, pollution_expiry: optDate,
  remarks: optStr(500),
  is_active: z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).default(1),
  row_version: z.coerce.number().int().nullish(),
});

/** Live state: IN_TRIP / ASSIGNED come from trips, the rest from the master. */
const VEHICLE_SELECT = `SELECT v.*, p.party_name AS rental_party_name,
    (SELECT t.trip_no FROM trx_transport_trip t WHERE t.vehicle_id = v.id AND t.status IN ('STARTED','IN_PROGRESS') ORDER BY t.id DESC LIMIT 1) AS running_trip_no,
    (SELECT COUNT(*) FROM trx_transport_trip t WHERE t.vehicle_id = v.id AND t.status IN ('ASSIGNED','DRIVER_ACCEPTED') AND t.planned_end_at >= UTC_TIMESTAMP()) AS upcoming_trips
  FROM mst_transport_vehicle v LEFT JOIN mst_party p ON p.id = v.rental_party_id`;
const liveVehicle = (v: any) => v && ({
  ...v,
  live_status: !v.is_active ? 'INACTIVE' : v.availability_status !== 'AVAILABLE' ? v.availability_status
    : v.running_trip_no ? 'IN_TRIP' : Number(v.upcoming_trips) > 0 ? 'ASSIGNED' : 'AVAILABLE',
  warnings: expiryWarnings('vehicle', v, new Date()),
});

transportMastersRouter.get('/vehicles', ah(async (req, res) => {
  must(req, P.MASTER, P.VIEW, P.ASSIGN);
  const q = z.object({ q: z.string().optional(), ownership_type: z.string().optional(), active: z.string().optional() }).parse(req.query);
  const where = ['v.company_id = ?']; const args: unknown[] = [req.user!.companyId];
  if (q.ownership_type) { where.push('v.ownership_type = ?'); args.push(q.ownership_type); }
  if (q.active === '1') where.push('v.is_active = 1');
  if (q.q) { where.push('(v.registration_no LIKE ? OR v.vehicle_code LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR v.rental_provider_name LIKE ?)'); const l = `%${q.q.replace(/\s/g, '')}%`; const l2 = `%${q.q}%`; args.push(l, l2, l2, l2, l2); }
  const rows = await query(`${VEHICLE_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.is_active DESC, v.vehicle_code`, args);
  res.json({ data: rows.map(liveVehicle) });
}));

transportMastersRouter.get('/vehicles/:id', ah(async (req, res) => {
  must(req, P.MASTER, P.VIEW, P.ASSIGN);
  const row = await queryOne(`${VEHICLE_SELECT} WHERE v.id = ? AND v.company_id = ?`, [id(req.params.id), req.user!.companyId]);
  if (!row) throw NotFound('Vehicle not found');
  res.json({ data: liveVehicle(row) });
}));

async function vehiclePayload(companyId: number, b: z.infer<typeof vehicleSchema>) {
  if (b.ownership_type === 'RENTAL') {
    if (b.rental_party_id) {
      const p = await queryOne<any>(`SELECT party_name, phone FROM mst_party WHERE id = ? AND company_id = ? AND is_deleted = 0`, [b.rental_party_id, companyId]);
      if (!p) throw Unprocessable('Rental provider (transporter) not found', [{ field: 'rental_party_id', message: 'Not found' }]);
      b.rental_provider_name = b.rental_provider_name || p.party_name;
      b.rental_provider_contact = b.rental_provider_contact || p.phone;
    }
    if (!b.rental_provider_name) throw Unprocessable('Rental provider is required for a rental vehicle', [{ field: 'rental_provider_name', message: 'Rental provider is required for a rental vehicle' }]);
  } else {
    b.rental_party_id = null; b.rental_provider_name = null; b.rental_provider_contact = null; b.rental_rate = null; b.rental_rate_basis = null;
  }
  if (!b.is_active) b.availability_status = 'INACTIVE';
  const { row_version: _rv, ...data } = b;
  return { ...data, vehicle_code: (b.vehicle_code || b.registration_no).toUpperCase() };
}

transportMastersRouter.post('/vehicles', ah(async (req, res) => {
  must(req, P.MASTER);
  const b = vehicleSchema.parse(req.body);
  const data = await vehiclePayload(req.user!.companyId, b);
  const dup = await queryOne(`SELECT id FROM mst_transport_vehicle WHERE company_id = ? AND (registration_no = ? OR vehicle_code = ?)`, [req.user!.companyId, data.registration_no, data.vehicle_code]);
  if (dup) throw Conflict(`Vehicle ${data.registration_no} already exists — edit that record instead of adding a duplicate`);
  const cols = Object.keys(data);
  const created = await transaction(async (tx) => {
    const r = await txExecute(tx, `INSERT INTO mst_transport_vehicle (company_id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
      [req.user!.companyId, ...cols.map((c) => (data as any)[c] ?? null), req.user!.id]);
    const row = await txQueryOne(tx, `SELECT * FROM mst_transport_vehicle WHERE id = ?`, [r.insertId]);
    await audit(req, 'mst_transport_vehicle', r.insertId, 'INSERT', undefined, row, tx);
    return row;
  });
  res.status(201).json({ data: created });
}));

transportMastersRouter.put('/vehicles/:id', ah(async (req, res) => {
  must(req, P.MASTER);
  const vid = id(req.params.id);
  const b = vehicleSchema.parse(req.body);
  const data = await vehiclePayload(req.user!.companyId, b);
  const notices: string[] = [];
  const after = await transaction(async (tx) => {
    const before = await txQueryOne<any>(tx, `SELECT * FROM mst_transport_vehicle WHERE id = ? AND company_id = ? FOR UPDATE`, [vid, req.user!.companyId]);
    if (!before) throw NotFound('Vehicle not found');
    assertVersion(before, b.row_version);
    const dup = await txQueryOne(tx, `SELECT id FROM mst_transport_vehicle WHERE company_id = ? AND (registration_no = ? OR vehicle_code = ?) AND id <> ?`, [req.user!.companyId, data.registration_no, data.vehicle_code, vid]);
    if (dup) throw Conflict(`Another vehicle already has registration / code ${data.registration_no}`);
    if (data.availability_status !== 'AVAILABLE') {
      const running = await txQueryOne<any>(tx, `SELECT trip_no FROM trx_transport_trip WHERE vehicle_id = ? AND status IN ('STARTED','IN_PROGRESS') LIMIT 1`, [vid]);
      if (running) throw Conflict(`Vehicle is on trip ${running.trip_no} — finish the trip before marking it ${data.availability_status.toLowerCase()}`);
      const upcoming = await overlapping(tx, req.user!.companyId, new Date(), new Date('2999-01-01'), { vehicleId: vid });
      if (upcoming.length) notices.push(`Vehicle still allocated to ${upcoming.map((t) => t.trip_no).join(', ')} — reassign those trips`);
    }
    const cols = Object.keys(data);
    await txExecute(tx, `UPDATE mst_transport_vehicle SET ${cols.map((c) => `${c} = ?`).join(', ')}, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [...cols.map((c) => (data as any)[c] ?? null), req.user!.id, vid]);
    const row = await txQueryOne(tx, `SELECT * FROM mst_transport_vehicle WHERE id = ?`, [vid]);
    await audit(req, 'mst_transport_vehicle', vid, 'UPDATE', before, row, tx);
    return row;
  });
  res.json({ data: after, ...(notices.length ? { notices } : {}) });
}));

/* ====================================================================== drivers */
const driverSchema = z.object({
  user_id: z.coerce.number().int().positive('Select the staff member'),
  licence_no: z.string().trim().min(5, 'Licence number is required').max(30).transform((v) => v.toUpperCase()),
  licence_class: optStr(40),
  licence_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Licence expiry is required'),
  mobile_no: mobile,
  emergency_contact_name: optStr(80),
  emergency_contact_mobile: z.union([mobile, z.literal(''), z.null()]).transform((v) => (v === '' ? null : v)).nullish(),
  availability_status: z.enum(['AVAILABLE', 'ON_LEAVE', 'INACTIVE']).default('AVAILABLE'),
  remarks: optStr(500),
  is_active: z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).default(1),
  row_version: z.coerce.number().int().nullish(),
});

const DRIVER_SELECT = `SELECT d.*, u.full_name AS driver_name, u.username, u.employee_code, u.is_active AS user_active,
    (SELECT t.trip_no FROM trx_transport_trip t WHERE t.driver_id = d.id AND t.status IN ('STARTED','IN_PROGRESS') ORDER BY t.id DESC LIMIT 1) AS running_trip_no,
    (SELECT COUNT(*) FROM trx_transport_trip t WHERE t.driver_id = d.id AND t.status IN ('ASSIGNED','DRIVER_ACCEPTED') AND t.planned_end_at >= UTC_TIMESTAMP()) AS upcoming_trips
  FROM mst_transport_driver d JOIN mst_user u ON u.id = d.user_id`;
const liveDriver = (d: any) => d && ({
  ...d,
  live_status: !d.is_active || !d.user_active ? 'INACTIVE' : d.availability_status !== 'AVAILABLE' ? d.availability_status
    : d.running_trip_no ? 'ON_TRIP' : Number(d.upcoming_trips) > 0 ? 'ASSIGNED' : 'AVAILABLE',
  warnings: expiryWarnings('driver', d, new Date()),
});

/** Staff the company can pick as a driver: active users of this company (home company or given access). */
transportMastersRouter.get('/driver-candidates', ah(async (req, res) => {
  must(req, P.MASTER);
  const rows = await query(
    `SELECT u.id, u.full_name AS label, u.username AS code, u.mobile, u.employee_code,
            (SELECT d.id FROM mst_transport_driver d WHERE d.company_id = ? AND d.user_id = u.id) AS driver_id
       FROM mst_user u
      WHERE u.is_active = 1 AND u.is_deleted = 0
        AND (u.company_id = ? OR EXISTS (SELECT 1 FROM map_user_company uc WHERE uc.user_id = u.id AND uc.company_id = ?))
      ORDER BY u.full_name`, [req.user!.companyId, req.user!.companyId, req.user!.companyId]);
  res.json({ data: rows });
}));

transportMastersRouter.get('/drivers', ah(async (req, res) => {
  must(req, P.MASTER, P.VIEW, P.ASSIGN);
  const q = z.object({ q: z.string().optional(), active: z.string().optional() }).parse(req.query);
  const where = ['d.company_id = ?']; const args: unknown[] = [req.user!.companyId];
  if (q.active === '1') where.push('d.is_active = 1');
  if (q.q) { where.push('(u.full_name LIKE ? OR d.licence_no LIKE ? OR d.mobile_no LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const rows = await query(`${DRIVER_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.is_active DESC, u.full_name`, args);
  res.json({ data: rows.map(liveDriver) });
}));

transportMastersRouter.get('/drivers/:id', ah(async (req, res) => {
  must(req, P.MASTER, P.VIEW, P.ASSIGN);
  const row = await queryOne(`${DRIVER_SELECT} WHERE d.id = ? AND d.company_id = ?`, [id(req.params.id), req.user!.companyId]);
  if (!row) throw NotFound('Driver not found');
  res.json({ data: liveDriver(row) });
}));

async function assertStaff(companyId: number, userId: number) {
  const u = await queryOne<any>(
    `SELECT u.id FROM mst_user u WHERE u.id = ? AND u.is_active = 1 AND u.is_deleted = 0
        AND (u.company_id = ? OR EXISTS (SELECT 1 FROM map_user_company uc WHERE uc.user_id = u.id AND uc.company_id = ?))`, [userId, companyId, companyId]);
  if (!u) throw Unprocessable('The driver must be an active staff user of this company', [{ field: 'user_id', message: 'Not an active staff user of this company' }]);
}

transportMastersRouter.post('/drivers', ah(async (req, res) => {
  must(req, P.MASTER);
  const b = driverSchema.parse(req.body);
  await assertStaff(req.user!.companyId, b.user_id);
  const { row_version: _rv, ...data } = b;
  if (!data.is_active) data.availability_status = 'INACTIVE';
  const dup = await queryOne(`SELECT id FROM mst_transport_driver WHERE company_id = ? AND user_id = ?`, [req.user!.companyId, b.user_id]);
  if (dup) throw Conflict('This staff member already has a driver profile');
  const cols = Object.keys(data);
  const created = await transaction(async (tx) => {
    const r = await txExecute(tx, `INSERT INTO mst_transport_driver (company_id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
      [req.user!.companyId, ...cols.map((c) => (data as any)[c] ?? null), req.user!.id]);
    const row = await txQueryOne(tx, `SELECT * FROM mst_transport_driver WHERE id = ?`, [r.insertId]);
    await audit(req, 'mst_transport_driver', r.insertId, 'INSERT', undefined, row, tx);
    return row;
  });
  res.status(201).json({ data: created });
}));

transportMastersRouter.put('/drivers/:id', ah(async (req, res) => {
  must(req, P.MASTER);
  const did = id(req.params.id);
  const b = driverSchema.parse(req.body);
  await assertStaff(req.user!.companyId, b.user_id);
  const { row_version, ...data } = b;
  if (!data.is_active) data.availability_status = 'INACTIVE';
  const notices: string[] = [];
  const after = await transaction(async (tx) => {
    const before = await txQueryOne<any>(tx, `SELECT * FROM mst_transport_driver WHERE id = ? AND company_id = ? FOR UPDATE`, [did, req.user!.companyId]);
    if (!before) throw NotFound('Driver not found');
    assertVersion(before, row_version);
    if (Number(before.user_id) !== b.user_id) {
      const dup = await txQueryOne(tx, `SELECT id FROM mst_transport_driver WHERE company_id = ? AND user_id = ? AND id <> ?`, [req.user!.companyId, b.user_id, did]);
      if (dup) throw Conflict('This staff member already has a driver profile');
    }
    if (data.availability_status !== 'AVAILABLE') {
      const running = await txQueryOne<any>(tx, `SELECT trip_no FROM trx_transport_trip WHERE driver_id = ? AND status IN (${RUNNING_TRIP.map(() => '?').join(',')}) LIMIT 1`, [did, ...RUNNING_TRIP]);
      if (running) throw Conflict(`Driver is on trip ${running.trip_no} — finish the trip first`);
      const upcoming = await overlapping(tx, req.user!.companyId, new Date(), new Date('2999-01-01'), { driverId: did });
      if (upcoming.length) notices.push(`Driver still allocated to ${upcoming.map((t) => t.trip_no).join(', ')} — reassign those trips`);
    }
    const cols = Object.keys(data);
    await txExecute(tx, `UPDATE mst_transport_driver SET ${cols.map((c) => `${c} = ?`).join(', ')}, row_version = row_version + 1, updated_by = ? WHERE id = ?`,
      [...cols.map((c) => (data as any)[c] ?? null), req.user!.id, did]);
    const row = await txQueryOne(tx, `SELECT * FROM mst_transport_driver WHERE id = ?`, [did]);
    await audit(req, 'mst_transport_driver', did, 'UPDATE', before, row, tx);
    return row;
  });
  res.json({ data: after, ...(notices.length ? { notices } : {}) });
}));

/* ====================================================================== request types */
const typeSchema = z.object({
  type_code: z.string().trim().min(2).max(30).transform((v) => v.toUpperCase().replace(/[^A-Z0-9_]/g, '_')),
  type_name: z.string().trim().min(2, 'Name is required').max(80),
  requires_pickup: z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).default(1),
  requires_destination: z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).default(1),
  requires_material: z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).default(0),
  requires_proof: z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).default(0),
  sort_order: z.coerce.number().int().default(0),
  is_active: z.union([z.boolean(), z.coerce.number()]).transform((v) => (v ? 1 : 0)).default(1),
});

/** Any request raiser reads the active types (the form needs them); masters see all. */
transportMastersRouter.get('/request-types', ah(async (req, res) => {
  must(req, P.REQUEST, P.VIEW, P.MASTER);
  const all = req.query.all === '1';
  const rows = await query(`SELECT * FROM cfg_transport_request_type WHERE company_id = ? ${all ? '' : 'AND is_active = 1'} ORDER BY sort_order, type_name`, [req.user!.companyId]);
  res.json({ data: rows });
}));

transportMastersRouter.post('/request-types', ah(async (req, res) => {
  must(req, P.MASTER);
  const b = typeSchema.parse(req.body);
  const dup = await queryOne(`SELECT id FROM cfg_transport_request_type WHERE company_id = ? AND type_code = ?`, [req.user!.companyId, b.type_code]);
  if (dup) throw Conflict(`Request type ${b.type_code} already exists`);
  const cols = Object.keys(b);
  const created = await transaction(async (tx) => {
    const r = await txExecute(tx, `INSERT INTO cfg_transport_request_type (company_id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
      [req.user!.companyId, ...cols.map((c) => (b as any)[c]), req.user!.id]);
    const row = await txQueryOne(tx, `SELECT * FROM cfg_transport_request_type WHERE id = ?`, [r.insertId]);
    await audit(req, 'cfg_transport_request_type', r.insertId, 'INSERT', undefined, row, tx);
    return row;
  });
  res.status(201).json({ data: created });
}));

transportMastersRouter.put('/request-types/:id', ah(async (req, res) => {
  must(req, P.MASTER);
  const tid = id(req.params.id);
  const b = typeSchema.parse(req.body);
  const after = await transaction(async (tx) => {
    const before = await txQueryOne<any>(tx, `SELECT * FROM cfg_transport_request_type WHERE id = ? AND company_id = ? FOR UPDATE`, [tid, req.user!.companyId]);
    if (!before) throw NotFound('Request type not found');
    if (before.type_code !== b.type_code) {
      const used = await txQueryOne(tx, `SELECT id FROM trx_transport_request WHERE request_type_id = ? LIMIT 1`, [tid]);
      if (used) throw Conflict('The code of a type already used on requests cannot change — rename it instead');
    }
    const cols = Object.keys(b);
    await txExecute(tx, `UPDATE cfg_transport_request_type SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_by = ? WHERE id = ?`, [...cols.map((c) => (b as any)[c]), req.user!.id, tid]);
    const row = await txQueryOne(tx, `SELECT * FROM cfg_transport_request_type WHERE id = ?`, [tid]);
    await audit(req, 'cfg_transport_request_type', tid, 'UPDATE', before, row, tx);
    return row;
  });
  res.json({ data: after });
}));

/* ====================================================================== locations (request form picker) */
/** Our units and trading partners with their address — the request form's location picker (spec: ERP location lookup). */
transportMastersRouter.get('/locations', ah(async (req, res) => {
  must(req, P.REQUEST, P.VIEW);
  const cid = req.user!.companyId;
  const [units, parties] = await Promise.all([
    query(`SELECT id, unit_name AS name, CONCAT_WS(', ', address_line1, city) AS address FROM mst_unit WHERE company_id = ? AND is_active = 1 AND is_deleted = 0 ORDER BY unit_name`, [cid]),
    query(`SELECT p.id, p.party_name AS name, p.phone,
              (SELECT CONCAT_WS(', ', pa.address_line1, pa.address_line2, pa.city, pa.state, pa.pincode) FROM mst_party_address pa
                WHERE pa.party_id = p.id AND pa.is_active = 1 ORDER BY pa.is_default DESC, pa.id LIMIT 1) AS address
         FROM mst_party p WHERE p.company_id = ? AND p.is_active = 1 AND p.is_deleted = 0
          AND (p.is_buyer = 1 OR p.is_customer = 1 OR p.is_supplier = 1 OR p.is_vendor = 1 OR p.is_contractor = 1 OR p.is_transporter = 1)
        ORDER BY p.party_name`, [cid]),
  ]);
  res.json({ data: { units, parties } });
}));
