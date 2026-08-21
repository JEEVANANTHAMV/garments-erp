import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query, queryOne, execute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { Unauthorized, BadRequest } from '../../core/errors.js';
import {
  authenticate, loadAuthUser, signAccessToken, signRefreshToken, verifyRefreshToken,
} from '../../middleware/auth.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again in 15 minutes.' } },
});

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  companyCode: z.string().trim().optional(),
});

authRouter.post('/login', loginLimiter, ah(async (req, res) => {
  const { username, password, companyCode } = loginSchema.parse(req.body);

  const user = await queryOne<{
    id: number; company_id: number; username: string; full_name: string;
    password_hash: string; is_active: number; is_deleted: number; is_locked: number;
  }>(
    `SELECT u.id, u.company_id, u.username, u.full_name, u.password_hash,
            u.is_active, u.is_deleted, u.is_locked
       FROM mst_user u
       JOIN mst_company c ON c.id = u.company_id
      WHERE u.username = ?
        ${companyCode ? 'AND c.company_code = ?' : ''}
      LIMIT 1`,
    companyCode ? [username, companyCode] : [username],
  );

  // Uniform error for unknown user vs bad password — no account enumeration.
  const invalid = Unauthorized('Invalid username or password');
  if (!user) { await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva'); throw invalid; }
  if (user.is_deleted || !user.is_active) throw Unauthorized('This account has been deactivated');
  if (user.is_locked) throw Unauthorized('This account is locked. Contact your administrator.');
  if (!(await bcrypt.compare(password, user.password_hash))) throw invalid;

  const session = await execute(
    `INSERT INTO trx_user_session (user_id, ip_address, user_agent) VALUES (?,?,?)`,
    [user.id, req.ip ?? null, (req.headers['user-agent'] ?? '').slice(0, 255)],
  );
  await execute(`UPDATE mst_user SET last_login_at = NOW() WHERE id = ?`, [user.id]);

  const payload = { sub: user.id, cid: user.company_id, sid: session.insertId, username: user.username };
  const profile = await loadAuthUser(user.id);

  res.json({
    data: {
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
      user: serializeUser(profile),
    },
  });
}));

authRouter.post('/refresh', ah(async (req, res) => {
  const token = z.object({ refreshToken: z.string().min(1) }).parse(req.body).refreshToken;
  const payload = verifyRefreshToken(token);
  const profile = await loadAuthUser(payload.sub);   // re-validates active/locked
  const next = { sub: profile.id, cid: profile.companyId, sid: payload.sid, username: profile.username };
  res.json({
    data: {
      accessToken: signAccessToken(next),
      refreshToken: signRefreshToken(next),
      user: serializeUser(profile),
    },
  });
}));

authRouter.post('/logout', authenticate, ah(async (req, res) => {
  if (req.sessionId) {
    await execute(`UPDATE trx_user_session SET logout_at = NOW() WHERE id = ? AND user_id = ?`,
      [req.sessionId, req.user!.id]);
  }
  res.json({ data: { success: true } });
}));

authRouter.get('/me', authenticate, ah(async (req, res) => {
  const company = await queryOne(
    `SELECT id, company_code, legal_name, trade_name, base_currency, logo_path
       FROM mst_company WHERE id = ?`, [req.user!.companyId]);
  const branches = await query(
    `SELECT b.id, b.branch_code, b.branch_name, b.is_head_office
       FROM mst_branch b
      WHERE b.company_id = ? AND b.is_active = 1 AND b.is_deleted = 0
        ${req.user!.isSuperAdmin ? '' : 'AND b.id IN (SELECT branch_id FROM map_user_branch WHERE user_id = ?)'}
      ORDER BY b.is_head_office DESC, b.branch_name`,
    req.user!.isSuperAdmin ? [req.user!.companyId] : [req.user!.companyId, req.user!.id]);

  res.json({ data: { user: serializeUser(req.user!), company, branches, menu: await buildMenu(req.user!) } });
}));

const changePwSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

authRouter.post('/change-password', authenticate, ah(async (req, res) => {
  const { currentPassword, newPassword } = changePwSchema.parse(req.body);
  const row = await queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM mst_user WHERE id = ?`, [req.user!.id]);
  if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
    throw BadRequest('Your current password is incorrect');
  }
  const { env } = await import('../../config/env.js');
  await execute(`UPDATE mst_user SET password_hash = ?, updated_by = ? WHERE id = ?`,
    [await bcrypt.hash(newPassword, env.bcryptRounds), req.user!.id, req.user!.id]);
  res.json({ data: { success: true } });
}));

function serializeUser(u: import('../../types/express.js').AuthUser) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    companyId: u.companyId,
    roles: u.roles,
    permissions: [...u.permissions],
    branchIds: u.branchIds,
    isSuperAdmin: u.isSuperAdmin,
  };
}

/**
 * Build the navigation tree the user may see: a module is visible if the user
 * holds any permission belonging to it (super admin sees everything).
 */
async function buildMenu(u: import('../../types/express.js').AuthUser) {
  const modules = await query<{
    id: number; module_code: string; module_name: string; parent_id: number | null; sort_order: number;
  }>(`SELECT id, module_code, module_name, parent_id, sort_order FROM mst_module ORDER BY sort_order, id`);

  let allowed: Set<number>;
  if (u.isSuperAdmin) {
    allowed = new Set(modules.map((m) => m.id));
  } else {
    const rows = await query<{ module_id: number }>(
      `SELECT DISTINCT p.module_id
         FROM map_user_role ur
         JOIN map_role_permission rp ON rp.role_id = ur.role_id
         JOIN mst_permission p       ON p.id = rp.permission_id
        WHERE ur.user_id = ?`, [u.id]);
    allowed = new Set(rows.map((r) => r.module_id));
    // A parent stays visible when any descendant is visible.
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of modules) {
        if (m.parent_id && allowed.has(m.id) && !allowed.has(m.parent_id)) {
          allowed.add(m.parent_id); changed = true;
        }
      }
    }
  }

  const visible = modules.filter((m) => allowed.has(m.id));
  const byParent = new Map<number | null, typeof visible>();
  for (const m of visible) {
    const k = m.parent_id ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(m);
  }
  const build = (parent: number | null): any[] =>
    (byParent.get(parent) ?? []).map((m) => ({
      code: m.module_code, name: m.module_name, children: build(m.id),
    }));
  return build(null);
}
