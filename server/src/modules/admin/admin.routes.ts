import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, queryOne, transaction, txExecute, txQueryOne } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest, Forbidden, Conflict } from '../../core/errors.js';
import { requirePermission, requireAny } from '../../middleware/auth.js';
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
  companyIds: z.array(z.coerce.number().int().positive()).optional(),
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

  const [roles, branches, companies] = await Promise.all([
    query(`SELECT r.id, r.role_code, r.role_name FROM map_user_role ur
             JOIN mst_role r ON r.id = ur.role_id WHERE ur.user_id = ?`, [id]),
    query(`SELECT b.id, b.branch_code, b.branch_name FROM map_user_branch ub
             JOIN mst_branch b ON b.id = ub.branch_id WHERE ub.user_id = ?`, [id]),
    query(`SELECT c.id, c.company_code, c.legal_name, c.trade_name, COALESCE(muc.is_default, 0) AS is_default
             FROM map_user_company muc
             JOIN mst_company c ON c.id = muc.company_id
            WHERE muc.user_id = ? AND c.is_deleted = 0`, [id]),
  ]);
  res.json({ data: { ...user, roles, branches, companies, companyIds: companies.map((c: any) => c.id) } });
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
    const cids = body.companyIds?.length ? body.companyIds : [req.user!.companyId];
    for (const cid of cids) {
      await txExecute(tx,
        `INSERT IGNORE INTO map_user_company (user_id, company_id, is_default, granted_by) VALUES (?,?,?,?)`,
        [userId, cid, cid === req.user!.companyId ? 1 : 0, req.user!.id]);
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
  const { roleIds, branchIds, companyIds, ...data } = body;

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
    if (companyIds) {
      await txExecute(tx, `DELETE FROM map_user_company WHERE user_id = ?`, [id]);
      for (const cid of companyIds) {
        await txExecute(tx,
          `INSERT INTO map_user_company (user_id, company_id, is_default, granted_by) VALUES (?,?,?,?)`,
          [id, cid, cid === before.company_id ? 1 : 0, req.user!.id]);
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
adminRouter.get('/companies', requireAny('COMPANY.VIEW', 'SETTINGS.VIEW'), ah(async (req, res) => {
  const rows = await query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM mst_branch b WHERE b.company_id = c.id AND b.is_deleted = 0) AS branch_count,
            (SELECT COUNT(*) FROM mst_unit u WHERE u.company_id = c.id AND u.is_deleted = 0) AS unit_count,
            (SELECT COUNT(*) FROM map_user_company muc WHERE muc.company_id = c.id) AS user_count
       FROM mst_company c
      WHERE c.is_deleted = 0
      ORDER BY c.id`,
  );
  res.json({ data: rows });
}));

const companyCreateSchema = z.object({
  company_code: z.string().trim().min(2).max(20).toUpperCase(),
  legal_name: z.string().trim().min(2).max(200),
  trade_name: s.nullableStr(200),
  gstin: s.nullableStr(15),
  pan: s.nullableStr(10),
  iec_code: s.nullableStr(20),
  cin: s.nullableStr(30),
  base_currency: z.coerce.number().int().positive().optional(),
  country_id: z.coerce.number().int().positive().optional(),
  address_line1: s.nullableStr(200),
  address_line2: s.nullableStr(200),
  city: s.nullableStr(80),
  state: s.nullableStr(80),
  state_gst_code: s.nullableStr(2),
  pincode: s.nullableStr(12),
  phone: s.nullableStr(40),
  email: s.email(),
  website: s.nullableStr(120),
  logo_path: s.nullableStr(255),
  assigned_user_ids: z.array(z.coerce.number().int().positive()).optional().default([]),
});

adminRouter.post('/companies', requireAny('COMPANY.CREATE', 'COMPANY.VIEW'), ah(async (req, res) => {
  if (!req.user!.isSuperAdmin && !req.user!.permissions.has('COMPANY.CREATE')) {
    throw Forbidden('Creating a new company requires COMPANY.CREATE or Super Administrator');
  }
  const body = companyCreateSchema.parse(req.body);

  const dup = await queryOne(`SELECT id FROM mst_company WHERE company_code = ? AND is_deleted = 0`, [body.company_code]);
  if (dup) throw Conflict(`Company code '${body.company_code}' is already in use`);

  let baseCurrency = body.base_currency;
  if (!baseCurrency) {
    const cur = await queryOne<{ id: number }>(`SELECT id FROM cfg_currency WHERE code = 'INR' LIMIT 1`);
    baseCurrency = cur?.id ?? 1;
  }
  let countryId = body.country_id;
  if (!countryId) {
    const ctry = await queryOne<{ id: number }>(`SELECT id FROM cfg_country WHERE iso2 = 'IN' LIMIT 1`);
    countryId = ctry?.id ?? 1;
  }

  const created = await transaction(async (tx) => {
    // 1. Insert into mst_company
    const compRes = await txExecute(tx,
      `INSERT INTO mst_company (
        company_code, legal_name, trade_name, gstin, pan, iec_code, cin,
        base_currency, country_id, address_line1, address_line2, city, state,
        state_gst_code, pincode, phone, email, website, logo_path, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        body.company_code, body.legal_name, body.trade_name ?? null,
        body.gstin ?? null, body.pan ?? null, body.iec_code ?? null, body.cin ?? null,
        baseCurrency, countryId, body.address_line1 ?? null, body.address_line2 ?? null,
        body.city ?? null, body.state ?? null, body.state_gst_code ?? null,
        body.pincode ?? null, body.phone ?? null, body.email ?? null,
        body.website ?? null, body.logo_path ?? null, req.user!.id,
      ],
    );
    const newCompanyId = compRes.insertId;

    // 2. Insert default Head Office branch
    const branchRes = await txExecute(tx,
      `INSERT INTO mst_branch (
        company_id, branch_code, branch_name, gstin, address_line1, city, state, pincode, phone, is_head_office, created_by
      ) VALUES (?, 'HO', 'Head Office', ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        newCompanyId, body.gstin ?? null, body.address_line1 ?? null,
        body.city ?? 'Tiruppur', body.state ?? 'Tamil Nadu', body.pincode ?? null,
        body.phone ?? null, req.user!.id,
      ],
    );
    const hoBranchId = branchRes.insertId;

    // 3. Clone standard roles from source company
    await txExecute(tx,
      `INSERT INTO mst_role (company_id, role_code, role_name, description, is_system, is_active)
       SELECT ?, role_code, role_name, description, is_system, is_active
         FROM mst_role WHERE company_id = ?`,
      [newCompanyId, req.user!.companyId],
    );

    // 4. Clone role permissions
    await txExecute(tx,
      `INSERT INTO map_role_permission (role_id, permission_id)
       SELECT new_r.id, mrp.permission_id
         FROM map_role_permission mrp
         JOIN mst_role old_r ON old_r.id = mrp.role_id AND old_r.company_id = ?
         JOIN mst_role new_r ON new_r.role_code = old_r.role_code AND new_r.company_id = ?`,
      [req.user!.companyId, newCompanyId],
    );

    // 5. Clone number series template
    await txExecute(tx,
      `INSERT IGNORE INTO cfg_number_series (company_id, doc_type, prefix, current_no, pad_length, is_active)
       SELECT ?, doc_type, prefix, 1, pad_length, 1
         FROM cfg_number_series WHERE company_id = ? AND branch_id IS NULL AND fy_id IS NULL`,
      [newCompanyId, req.user!.companyId],
    );

    // 6. Map the creator & all super admins to the new company
    await txExecute(tx,
      `INSERT IGNORE INTO map_user_company (user_id, company_id, is_default, granted_by)
       VALUES (?, ?, 0, ?)`,
      [req.user!.id, newCompanyId, req.user!.id],
    );

    await txExecute(tx,
      `INSERT IGNORE INTO map_user_company (user_id, company_id, is_default, granted_by)
       SELECT DISTINCT ur.user_id, ?, 0, ?
         FROM map_user_role ur
         JOIN mst_role r ON r.id = ur.role_id AND r.role_code = 'SUPER_ADMIN'`,
      [newCompanyId, req.user!.id],
    );

    for (const uid of body.assigned_user_ids) {
      await txExecute(tx,
        `INSERT IGNORE INTO map_user_company (user_id, company_id, is_default, granted_by)
         VALUES (?, ?, 0, ?)`,
        [uid, newCompanyId, req.user!.id],
      );
    }

    // 7. Assign creator & super admins the SUPER_ADMIN role in the new company
    const newSuperRole = await txQueryOne<{ id: number }>(tx,
      `SELECT id FROM mst_role WHERE company_id = ? AND role_code = 'SUPER_ADMIN'`,
      [newCompanyId],
    );
    if (newSuperRole) {
      await txExecute(tx,
        `INSERT IGNORE INTO map_user_role (user_id, role_id) VALUES (?, ?)`,
        [req.user!.id, newSuperRole.id],
      );
      await txExecute(tx,
        `INSERT IGNORE INTO map_user_role (user_id, role_id)
         SELECT DISTINCT muc.user_id, ?
           FROM map_user_company muc
           JOIN mst_user u ON u.id = muc.user_id
          WHERE muc.company_id = ?`,
        [newSuperRole.id, newCompanyId],
      );
    }

    await txExecute(tx,
      `INSERT IGNORE INTO map_user_branch (user_id, branch_id) VALUES (?, ?)`,
      [req.user!.id, hoBranchId],
    );

    return txQueryOne(tx, `SELECT * FROM mst_company WHERE id = ?`, [newCompanyId]);
  });

  await audit(req, 'mst_company', (created as any).id, 'INSERT', undefined, created);
  res.status(201).json({ data: created });
}));

adminRouter.get('/company-users/:companyId', requireAny('COMPANY.VIEW', 'USER.VIEW'), ah(async (req, res) => {
  const companyId = z.coerce.number().int().positive().parse(req.params.companyId);
  const rows = await query(
    `SELECT u.id, u.username, u.full_name, u.email,
            IF(muc.company_id IS NOT NULL, 1, 0) AS has_access,
            muc.is_default, muc.granted_at
       FROM mst_user u
       LEFT JOIN map_user_company muc ON muc.user_id = u.id AND muc.company_id = ?
      WHERE u.is_deleted = 0
      ORDER BY has_access DESC, u.full_name`,
    [companyId],
  );
  res.json({ data: rows });
}));

adminRouter.put('/company-users/:companyId', requireAny('COMPANY.UPDATE', 'USER.UPDATE'), ah(async (req, res) => {
  const companyId = z.coerce.number().int().positive().parse(req.params.companyId);
  const { userIds, defaultUserId } = z.object({
    userIds: z.array(z.coerce.number().int().positive()),
    defaultUserId: z.coerce.number().int().positive().optional(),
  }).parse(req.body);

  await transaction(async (tx) => {
    // Keep super admins always
    await txExecute(tx,
      `DELETE FROM map_user_company
        WHERE company_id = ?
          AND user_id NOT IN (
            SELECT ur.user_id FROM map_user_role ur
            JOIN mst_role r ON r.id = ur.role_id AND r.role_code = 'SUPER_ADMIN'
          )`,
      [companyId],
    );

    for (const uid of userIds) {
      const isDef = defaultUserId === uid ? 1 : 0;
      await txExecute(tx,
        `INSERT INTO map_user_company (user_id, company_id, is_default, granted_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE is_default = VALUES(is_default)`,
        [uid, companyId, isDef, req.user!.id],
      );
    }
  });

  res.json({ data: { success: true, count: userIds.length } });
}));

adminRouter.get('/company', requirePermission('COMPANY.VIEW'), ah(async (req, res) => {
  const targetId = req.query.company_id ? Number(req.query.company_id) : req.user!.companyId;
  const company = await queryOne(`SELECT * FROM mst_company WHERE id = ?`, [targetId]);
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
  const targetId = req.query.company_id ? Number(req.query.company_id) : req.user!.companyId;
  const body = companySchema.parse(req.body);
  const before = await queryOne(`SELECT * FROM mst_company WHERE id = ?`, [targetId]);
  if (!before) throw NotFound('Company not found');
  const keys = Object.keys(body).filter((k) => (body as any)[k] !== undefined);
  if (!keys.length) throw BadRequest('No changes supplied');

  const after = await transaction(async (tx) => {
    await txExecute(tx,
      `UPDATE mst_company SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ? WHERE id = ?`,
      [...keys.map((k) => (body as any)[k]), req.user!.id, targetId],
    );
    return txQueryOne(tx, `SELECT * FROM mst_company WHERE id = ?`, [targetId]);
  });
  await audit(req, 'mst_company', targetId, 'UPDATE', before, after);
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
/** Menu switches every signed-in user's sidebar needs (MENU_* settings, e.g. MENU_SHOW_LINE_QC) — no admin right needed. */
adminRouter.get('/ui-flags', ah(async (req, res) => {
  const rows = await query<{ k: string; v: string | null }>(
    `SELECT setting_key AS k, setting_value AS v FROM cfg_system_setting
      WHERE (company_id = ? OR company_id IS NULL) AND setting_key LIKE 'MENU\\_%' ORDER BY company_id IS NULL`, [req.user!.companyId]);
  const flags: Record<string, boolean> = {};
  for (const r of rows) if (!(r.k in flags)) flags[r.k] = String(r.v ?? '').trim() === '1';
  res.json({ data: flags });
}));

/**
 * The signed-in user's menu overrides (cfg_role_menu): a screen is SHOWN when any of the user's roles shows it,
 * HIDDEN only when every one of the user's roles hides it (most permissive role wins). Visibility only.
 */
adminRouter.get('/my-menu', ah(async (req, res) => {
  const roles = await query<{ role_id: number }>(`SELECT role_id FROM map_user_role WHERE user_id = ?`, [req.user!.id]);
  const roleIds = roles.map((r) => Number(r.role_id));
  if (!roleIds.length) { res.json({ data: { hide: [], show: [] } }); return; }
  const rows = await query<{ role_id: number; path: string; mode: 'HIDE' | 'SHOW' }>(
    `SELECT role_id, path, mode FROM cfg_role_menu WHERE company_id = ? AND role_id IN (?)`, [req.user!.companyId, roleIds]);
  const show = new Set<string>(); const hiddenBy = new Map<string, Set<number>>();
  for (const r of rows) {
    if (r.mode === 'SHOW') show.add(r.path);
    else { const s = hiddenBy.get(r.path) ?? new Set<number>(); s.add(Number(r.role_id)); hiddenBy.set(r.path, s); }
  }
  const hide = [...hiddenBy.entries()].filter(([p, s]) => !show.has(p) && s.size === roleIds.length).map(([p]) => p);
  res.json({ data: { hide, show: [...show] } });
}));

/** Admin → Menu Access: one role's overrides. */
adminRouter.get('/menu-access', requireAny('ROLE.VIEW', 'SETTINGS.VIEW'), ah(async (req, res) => {
  const roleId = z.coerce.number().int().positive().parse(req.query.role_id);
  const role = await queryOne<any>(`SELECT id FROM mst_role WHERE id = ? AND company_id = ?`, [roleId, req.user!.companyId]);
  if (!role) throw NotFound('Role not found');
  const rows = await query(`SELECT path, mode FROM cfg_role_menu WHERE company_id = ? AND role_id = ? ORDER BY path`, [req.user!.companyId, roleId]);
  res.json({ data: rows });
}));

adminRouter.put('/menu-access', requireAny('ROLE.UPDATE', 'SETTINGS.UPDATE'), ah(async (req, res) => {
  const body = z.object({
    role_id: z.coerce.number().int().positive(),
    items: z.array(z.object({ path: z.string().trim().min(1).max(120).regex(/^\//, 'path must start with /'), mode: z.enum(['HIDE', 'SHOW']).nullable() })).max(500),
  }).parse(req.body);
  const cid = req.user!.companyId;
  const role = await queryOne<any>(`SELECT id, role_code FROM mst_role WHERE id = ? AND company_id = ?`, [body.role_id, cid]);
  if (!role) throw NotFound('Role not found');
  const before = await query(`SELECT path, mode FROM cfg_role_menu WHERE company_id = ? AND role_id = ?`, [cid, body.role_id]);
  await transaction(async (tx) => {
    for (const it of body.items) {
      if (it.mode) {
        await txExecute(tx, `INSERT INTO cfg_role_menu (company_id, role_id, path, mode, updated_by) VALUES (?,?,?,?,?)
                              ON DUPLICATE KEY UPDATE mode = VALUES(mode), updated_by = VALUES(updated_by)`, [cid, body.role_id, it.path, it.mode, req.user!.id]);
      } else {
        await txExecute(tx, `DELETE FROM cfg_role_menu WHERE company_id = ? AND role_id = ? AND path = ?`, [cid, body.role_id, it.path]);
      }
    }
  });
  const after = await query(`SELECT path, mode FROM cfg_role_menu WHERE company_id = ? AND role_id = ?`, [cid, body.role_id]);
  await audit(req, 'cfg_role_menu', body.role_id, 'UPDATE', { role: role.role_code, overrides: before }, { role: role.role_code, overrides: after });
  res.json({ data: after });
}));

// the Settings menu needs SETTINGS.VIEW, the API used to need COMPANY.VIEW — either opens it
adminRouter.get('/settings', requireAny('COMPANY.VIEW', 'SETTINGS.VIEW'), ah(async (req, res) => {
  const rows = await query(
    `SELECT id, setting_key AS \`key\`, setting_value AS value, description, is_editable
       FROM cfg_system_setting
      WHERE (company_id = ? OR company_id IS NULL)
      ORDER BY setting_key`,
    [req.user!.companyId]);
  res.json({ data: rows });
}));

adminRouter.put('/settings', requireAny('COMPANY.UPDATE', 'SETTINGS.UPDATE'), ah(async (req, res) => {
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
