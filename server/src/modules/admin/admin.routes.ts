import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute, txQueryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden, Conflict } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { env } from '../../config/env.js';
import { s } from '../resources/schemas.js';

export const adminRouter = Router();

// ============================================================== USERS
const userCreateSchema = z.object({
  username: z.string().trim().min(3, 'Username must be at least 3 characters').max(60)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Username may contain letters, numbers, dot, underscore and hyphen only'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  full_name: z.string().trim().min(1).max(150),
  email: s.email(),
  mobile: s.nullableStr(20),
  employee_code: s.nullableStr(30),
  default_branch: s.id(),
  is_active: s.bool(),
  roleIds: z.array(z.coerce.number().int().positive()).default([]),
  branchIds: z.array(z.coerce.number().int().positive()).default([]),
});

adminRouter.get('/users', requirePermission('USER.VIEW'), ah(async (req, res) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    q: z.string().trim().optional(),
    includeInactive: z.coerce.boolean().default(false),
  }).parse(req.query);

  const where = ['u.company_id = ?', 'u.is_deleted = 0'];
  const params: unknown[] = [req.user!.companyId];
  if (!q.includeInactive) where.push('u.is_active = 1');
  if (q.q) { where.push('(u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)');
    params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const clause = where.join(' AND ');
  const offset = (q.page - 1) * q.pageSize;

  const [rows, total] = await Promise.all([
    query(`SELECT u.id, u.username, u.full_name, u.email, u.mobile, u.employee_code,
                  u.default_branch, u.is_active, u.is_locked, u.last_login_at, u.created_at,
                  b.branch_name AS default_branch_name,
                  GROUP_CONCAT(DISTINCT r.role_name ORDER BY r.role_name SEPARATOR ', ') AS role_names
             FROM mst_user u
             LEFT JOIN mst_branch b ON b.id = u.default_branch
             LEFT JOIN map_user_role ur ON ur.user_id = u.id
             LEFT JOIN mst_role r ON r.id = ur.role_id
            WHERE ${clause}
            GROUP BY u.id, u.username, u.full_name, u.email, u.mobile, u.employee_code,
                     u.default_branch, u.is_active, u.is_locked, u.last_login_at, u.created_at, b.branch_name
            ORDER BY u.full_name LIMIT ${q.pageSize} OFFSET ${offset}`, params),
    queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM mst_user u WHERE ${clause}`, params),
  ]);
  res.json({ data: rows, pagination: { page: q.page, pageSize: q.pageSize,
    total: total?.total ?? 0, totalPages: Math.ceil((total?.total ?? 0) / q.pageSize) } });
}));

adminRouter.get('/users/:id', requirePermission('USER.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const user = await queryOne(
    `SELECT id, username, full_name, email, mobile, employee_code, default_branch,
            is_active, is_locked, last_login_at, password_expiry, created_at
       FROM mst_user WHERE id = ? AND company_id = ? AND is_deleted = 0`,
    [id, req.user!.companyId]);
  if (!user) throw NotFound('User not found');

  const [roles, branches] = await Promise.all([
    query(`SELECT r.id, r.role_code, r.role_name FROM map_user_role ur
             JOIN mst_role r ON r.id = ur.role_id WHERE ur.user_id = ?`, [id]),
    query(`SELECT b.id, b.branch_code, b.branch_name FROM map_user_branch ub
             JOIN mst_branch b ON b.id = ub.branch_id WHERE ub.user_id = ?`, [id]),
  ]);
  res.json({ data: { ...user, roles, branches } });
}));

adminRouter.post('/users', requirePermission('USER.CREATE'), ah(async (req, res) => {
  const body = userCreateSchema.parse(req.body);

  const created = await transaction(async (tx) => {
    const hash = await bcrypt.hash(body.password, env.bcryptRounds);
    const r = await txExecute(tx,
      `INSERT INTO mst_user (company_id, username, password_hash, full_name, email, mobile,
                             employee_code, default_branch, is_active, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.user!.companyId, body.username, hash, body.full_name, body.email ?? null,
       body.mobile ?? null, body.employee_code ?? null, body.default_branch ?? null,
       body.is_active ?? 1, req.user!.id]);
    const userId = r.insertId;

    for (const rid of body.roleIds) {
      await txExecute(tx, `INSERT INTO map_user_role (user_id, role_id) VALUES (?,?)`, [userId, rid]);
    }
    for (const bid of body.branchIds) {
      await txExecute(tx, `INSERT INTO map_user_branch (user_id, branch_id) VALUES (?,?)`, [userId, bid]);
    }
    return txQueryOne(tx,
      `SELECT id, username, full_name, email FROM mst_user WHERE id = ?`, [userId]);
  });

  await audit(req, 'mst_user', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

const userUpdateSchema = userCreateSchema.omit({ password: true, username: true }).partial();

adminRouter.put('/users/:id', requirePermission('USER.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne<any>(
    `SELECT * FROM mst_user WHERE id = ? AND company_id = ? AND is_deleted = 0`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('User not found');

  const body = userUpdateSchema.parse(req.body);
  const { roleIds, branchIds, ...data } = body;

  const after = await transaction(async (tx) => {
    const cols: Record<string, unknown> = { ...data, updated_by: req.user!.id };
    const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (keys.length) {
      await txExecute(tx,
        `UPDATE mst_user SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND company_id = ?`,
        [...keys.map((k) => cols[k]), id, req.user!.companyId]);
    }
    if (roleIds) {
      // Guard against an admin removing their own last administrative role.
      if (id === req.user!.id && req.user!.isSuperAdmin) {
        const stillAdmin = await txQueryOne<{ n: number }>(
          tx,
          `SELECT COUNT(*) AS n FROM mst_role
            WHERE id IN (${roleIds.length ? roleIds.map(() => '?').join(',') : 'NULL'})
              AND role_code = 'SUPER_ADMIN'`, roleIds);
        if (!stillAdmin?.n) throw Forbidden('You cannot remove your own Super Admin role');
      }
      await txExecute(tx, `DELETE FROM map_user_role WHERE user_id = ?`, [id]);
      for (const rid of roleIds) {
        await txExecute(tx, `INSERT INTO map_user_role (user_id, role_id) VALUES (?,?)`, [id, rid]);
      }
    }
    if (branchIds) {
      await txExecute(tx, `DELETE FROM map_user_branch WHERE user_id = ?`, [id]);
      for (const bid of branchIds) {
        await txExecute(tx, `INSERT INTO map_user_branch (user_id, branch_id) VALUES (?,?)`, [id, bid]);
      }
    }
    return txQueryOne(tx, `SELECT id, username, full_name, email FROM mst_user WHERE id = ?`, [id]);
  });

  await audit(req, 'mst_user', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

adminRouter.post('/users/:id/reset-password', requirePermission('USER.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const { newPassword } = z.object({
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  }).parse(req.body);

  const user = await queryOne(`SELECT id FROM mst_user WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!user) throw NotFound('User not found');

  await transaction((tx) => txExecute(tx,
    `UPDATE mst_user SET password_hash = ?, is_locked = 0, updated_by = ? WHERE id = ?`,
    [bcrypt.hashSync(newPassword, env.bcryptRounds), req.user!.id, id]));
  await audit(req, 'mst_user', id, 'UPDATE', undefined, { password_reset: true });
  res.json({ data: { success: true } });
}));

adminRouter.delete('/users/:id', requirePermission('USER.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) throw Forbidden('You cannot delete your own account');
  const before = await queryOne(`SELECT * FROM mst_user WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('User not found');

  await transaction((tx) => txExecute(tx,
    `UPDATE mst_user SET is_deleted = 1, is_active = 0, updated_by = ? WHERE id = ?`,
    [req.user!.id, id]));
  await audit(req, 'mst_user', id, 'DELETE', before, undefined);
  res.json({ data: { id, deleted: true } });
}));

// ============================================================== ROLES
adminRouter.get('/roles', requirePermission('ROLE.VIEW'), ah(async (req, res) => {
  const rows = await query(
    `SELECT r.*, COUNT(DISTINCT rp.permission_id) AS permission_count,
            COUNT(DISTINCT ur.user_id) AS user_count
       FROM mst_role r
       LEFT JOIN map_role_permission rp ON rp.role_id = r.id
       LEFT JOIN map_user_role ur ON ur.role_id = r.id
      WHERE r.company_id = ?
      GROUP BY r.id ORDER BY r.role_name`, [req.user!.companyId]);
  res.json({ data: rows });
}));

adminRouter.get('/roles/:id', requirePermission('ROLE.VIEW'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const role = await queryOne(`SELECT * FROM mst_role WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!role) throw NotFound('Role not found');
  const permissions = await query(
    `SELECT p.id, p.permission_code, p.permission_name, p.module_id, m.module_name
       FROM map_role_permission rp
       JOIN mst_permission p ON p.id = rp.permission_id
       JOIN mst_module m ON m.id = p.module_id
      WHERE rp.role_id = ? ORDER BY m.sort_order, p.permission_code`, [id]);
  res.json({ data: { ...role, permissions, permissionIds: permissions.map((p: any) => p.id) } });
}));

const roleSchema = z.object({
  role_code: z.string().trim().min(1).max(40).regex(/^[A-Z0-9_]+$/, 'Use uppercase letters, numbers and underscores'),
  role_name: z.string().trim().min(1).max(100),
  description: s.nullableStr(255),
  is_active: s.bool(),
  permissionIds: z.array(z.coerce.number().int().positive()).default([]),
});

adminRouter.post('/roles', requirePermission('ROLE.CREATE'), ah(async (req, res) => {
  const body = roleSchema.parse(req.body);
  const created = await transaction(async (tx) => {
    const r = await txExecute(tx,
      `INSERT INTO mst_role (company_id, role_code, role_name, description, is_active)
       VALUES (?,?,?,?,?)`,
      [req.user!.companyId, body.role_code, body.role_name, body.description ?? null, body.is_active ?? 1]);
    for (const pid of body.permissionIds) {
      await txExecute(tx, `INSERT INTO map_role_permission (role_id, permission_id) VALUES (?,?)`,
        [r.insertId, pid]);
    }
    return txQueryOne(tx, `SELECT * FROM mst_role WHERE id = ?`, [r.insertId]);
  });
  await audit(req, 'mst_role', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

adminRouter.put('/roles/:id', requirePermission('ROLE.UPDATE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne<any>(`SELECT * FROM mst_role WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Role not found');
  if (before.is_system && before.role_code === 'SUPER_ADMIN') {
    throw Forbidden('The Super Admin role cannot be modified');
  }

  const body = roleSchema.partial().parse(req.body);
  const after = await transaction(async (tx) => {
    const { permissionIds, ...data } = body;
    const keys = Object.keys(data).filter((k) => (data as any)[k] !== undefined);
    if (keys.length) {
      await txExecute(tx,
        `UPDATE mst_role SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND company_id = ?`,
        [...keys.map((k) => (data as any)[k]), id, req.user!.companyId]);
    }
    if (permissionIds) {
      await txExecute(tx, `DELETE FROM map_role_permission WHERE role_id = ?`, [id]);
      for (const pid of permissionIds) {
        await txExecute(tx, `INSERT INTO map_role_permission (role_id, permission_id) VALUES (?,?)`,
          [id, pid]);
      }
    }
    return txQueryOne(tx, `SELECT * FROM mst_role WHERE id = ?`, [id]);
  });
  await audit(req, 'mst_role', id, 'UPDATE', before, after);
  res.json({ data: after });
}));

adminRouter.delete('/roles/:id', requirePermission('ROLE.DELETE'), ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = await queryOne<any>(`SELECT * FROM mst_role WHERE id = ? AND company_id = ?`,
    [id, req.user!.companyId]);
  if (!before) throw NotFound('Role not found');
  if (before.is_system) throw Forbidden('System roles cannot be deleted');

  const inUse = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM map_user_role WHERE role_id = ?`, [id]);
  if ((inUse?.n ?? 0) > 0) {
    throw Conflict(`This role is assigned to ${inUse!.n} user(s). Reassign them first.`);
  }

  await transaction(async (tx) => {
    await txExecute(tx, `DELETE FROM map_role_permission WHERE role_id = ?`, [id]);
    await txExecute(tx, `DELETE FROM mst_role WHERE id = ?`, [id]);
  });
  await audit(req, 'mst_role', id, 'DELETE', before, undefined);
  res.json({ data: { id, deleted: true } });
}));

// ================================================ MODULES & PERMISSIONS
adminRouter.get('/permissions', requirePermission('ROLE.VIEW'), ah(async (_req, res) => {
  const rows = await query(
    `SELECT p.id, p.permission_code, p.permission_name, p.module_id,
            m.module_code, m.module_name, m.parent_id, m.sort_order
       FROM mst_permission p
       JOIN mst_module m ON m.id = p.module_id
      ORDER BY m.sort_order, m.module_name, p.permission_code`);

  // Group by module for the permission matrix UI.
  const byModule = new Map<number, any>();
  for (const p of rows as any[]) {
    if (!byModule.has(p.module_id)) {
      byModule.set(p.module_id, {
        moduleId: p.module_id, moduleCode: p.module_code, moduleName: p.module_name,
        parentId: p.parent_id, sortOrder: p.sort_order, permissions: [],
      });
    }
    byModule.get(p.module_id).permissions.push({
      id: p.id, code: p.permission_code, name: p.permission_name,
    });
  }
  res.json({ data: [...byModule.values()] });
}));

adminRouter.get('/modules', requirePermission('ROLE.VIEW'), ah(async (_req, res) => {
  res.json({ data: await query(`SELECT * FROM mst_module ORDER BY sort_order, id`) });
}));

// ============================================================ COMPANY
adminRouter.get('/company', requirePermission('COMPANY.VIEW'), ah(async (req, res) => {
  const company = await queryOne(`SELECT * FROM mst_company WHERE id = ?`, [req.user!.companyId]);
  if (!company) throw NotFound('Company not found');
  res.json({ data: company });
}));

const companySchema = z.object({
  legal_name: z.string().trim().min(1).max(200),
  trade_name: s.nullableStr(200),
  gstin: s.nullableStr(15), pan: s.nullableStr(10),
  iec_code: s.nullableStr(20), cin: s.nullableStr(30),
  base_currency: s.id(), country_id: s.id(),
  address_line1: s.nullableStr(200), address_line2: s.nullableStr(200),
  city: s.nullableStr(80), state: s.nullableStr(80), state_gst_code: s.nullableStr(2),
  pincode: s.nullableStr(12), phone: s.nullableStr(40),
  email: s.email(), website: s.nullableStr(120), logo_path: s.nullableStr(255),
}).partial();

adminRouter.put('/company', requirePermission('COMPANY.UPDATE'), ah(async (req, res) => {
  const body = companySchema.parse(req.body);
  const before = await queryOne(`SELECT * FROM mst_company WHERE id = ?`, [req.user!.companyId]);
  const keys = Object.keys(body).filter((k) => (body as any)[k] !== undefined);
  if (!keys.length) throw BadRequest('No changes supplied');

  const after = await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE mst_company SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ? WHERE id = ?`,
      [...keys.map((k) => (body as any)[k]), req.user!.id, req.user!.companyId]);
    return txQueryOne(tx, `SELECT * FROM mst_company WHERE id = ?`, [req.user!.companyId]);
  });
  await audit(req, 'mst_company', req.user!.companyId, 'UPDATE', before, after);
  res.json({ data: after });
}));

// ======================================================== NOTIFICATIONS
adminRouter.get('/notifications', ah(async (req, res) => {
  const rows = await query(
    `SELECT * FROM trx_notification WHERE user_id = ?
      ORDER BY is_read, created_at DESC LIMIT 50`, [req.user!.id]);
  res.json({ data: rows });
}));

adminRouter.post('/notifications/:id/read', ah(async (req, res) => {
  await transaction((tx) => txExecute(tx,
    `UPDATE trx_notification SET is_read = 1 WHERE id = ? AND user_id = ?`,
    [Number(req.params.id), req.user!.id]));
  res.json({ data: { success: true } });
}));

adminRouter.post('/notifications/read-all', ah(async (req, res) => {
  await transaction((tx) => txExecute(tx,
    `UPDATE trx_notification SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [req.user!.id]));
  res.json({ data: { success: true } });
}));

// ======================================================== SYSTEM SETTINGS
adminRouter.get('/settings', requirePermission('COMPANY.VIEW'), ah(async (req, res) => {
  const rows = await query(
    `SELECT id, setting_key AS \`key\`, setting_value AS value, description, is_editable
       FROM cfg_system_setting
      WHERE (company_id = ? OR company_id IS NULL)
      ORDER BY setting_key`,
    [req.user!.companyId]);
  res.json({ data: rows });
}));

adminRouter.put('/settings', requirePermission('COMPANY.UPDATE'), ah(async (req, res) => {
  const { settings } = z.object({
    settings: z.array(z.object({
      key: z.string().trim().min(1),
      value: z.string().nullable(),
    })),
  }).parse(req.body);

  await transaction(async (tx) => {
    for (const { key, value } of settings) {
      // Upsert: update if exists and editable, insert if new (company-scoped)
      await txExecute(tx,
        `INSERT INTO cfg_system_setting (company_id, setting_key, setting_value)
              VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = IF(is_editable = 1, VALUES(setting_value), setting_value)`,
        [req.user!.companyId, key, value ?? null]);
    }
  });

  await audit(req, 'cfg_system_setting', req.user!.companyId, 'UPDATE', undefined, { settings });
  res.json({ data: { updated: settings.length } });
}));
