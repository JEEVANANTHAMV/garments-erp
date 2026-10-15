import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query, queryOne, execute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { Unauthorized, BadRequest, Forbidden, NotFound } from '../../core/errors.js';
import { env } from '../../config/env.js';
import {
  authenticate, loadAuthUser, signAccessToken, signRefreshToken, verifyRefreshToken,
} from '../../middleware/auth.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // brute-force guard is for production; local development runs many automated logins
  skip: () => !env.isProd,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again in 15 minutes.' } },
});

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  companyId: z.coerce.number().int().positive().optional(),
  companyCode: z.string().trim().optional(),
});

type LoginRow = {
  id: number; company_id: number; username: string; full_name: string;
  password_hash: string; is_active: number; is_deleted: number; is_locked: number;
};
type CompanyRow = {
  id: number; company_code: string; legal_name: string; trade_name: string | null;
  gstin: string | null; logo_path: string | null; is_default: number;
};

/** SUPER_ADMIN in the user's HOME company — the only users who may enter / administer every company. */
async function platformSuperAdmin(userId: number, homeCid: number): Promise<boolean> {
  const r = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM map_user_role ur
       JOIN mst_role r ON r.id = ur.role_id AND r.is_active = 1 AND r.company_id = ? AND r.role_code = 'SUPER_ADMIN'
      WHERE ur.user_id = ?`, [homeCid, userId]);
  return Number(r?.n ?? 0) > 0;
}

/**
 * Active companies a user may enter: their home company, every company granted in map_user_company, and — for a
 * platform super admin — every active company. One rule for login, switch-company and /me.
 */
async function companiesFor(userId: number, homeCid: number, isPlatform: boolean): Promise<CompanyRow[]> {
  return query<CompanyRow>(
    `SELECT c.id, c.company_code, c.legal_name, c.trade_name, c.gstin, c.logo_path,
            CASE WHEN muc.is_default = 1 OR (muc.user_id IS NULL AND c.id = ?) THEN 1 ELSE 0 END AS is_default
       FROM mst_company c
       LEFT JOIN map_user_company muc ON muc.company_id = c.id AND muc.user_id = ?
      WHERE c.is_active = 1 AND c.is_deleted = 0
        AND (? = 1 OR c.id = ? OR muc.user_id IS NOT NULL)
      ORDER BY is_default DESC, (c.id = ?) DESC, c.legal_name`,
    [homeCid, userId, isPlatform ? 1 : 0, homeCid, homeCid]);
}

authRouter.post('/login', loginLimiter, ah(async (req, res) => {
  const { username, password, companyId, companyCode } = loginSchema.parse(req.body);

  // Usernames are unique per company only, so the same name can exist in two companies: try every account with that
  // name and keep the one whose password matches (preferring the company asked for).
  const candidates = await query<LoginRow>(
    `SELECT u.id, u.company_id, u.username, u.full_name, u.password_hash, u.is_active, u.is_deleted, u.is_locked
       FROM mst_user u WHERE u.username = ? AND u.is_deleted = 0 ORDER BY u.id`, [username]);
  const invalid = Unauthorized('Invalid username or password');   // uniform — no account enumeration
  if (!candidates.length) { await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva'); throw invalid; }
  const matches: LoginRow[] = [];
  for (const c of candidates) if (await bcrypt.compare(password, c.password_hash)) matches.push(c);
  if (!matches.length) throw invalid;
  const user = matches.find((m) => companyId && m.company_id === companyId) ?? matches[0];
  if (!user.is_active) throw Unauthorized('This account has been deactivated');
  if (user.is_locked) throw Unauthorized('This account is locked. Contact your administrator.');

  const isPlatformSuperAdmin = await platformSuperAdmin(user.id, user.company_id);
  const accessibleCompanies = await companiesFor(user.id, user.company_id, isPlatformSuperAdmin);
  if (!accessibleCompanies.length) throw Unauthorized('No active company is available for this account');

  // A requested company must be one this account may enter — never an arbitrary / inactive id.
  let chosenCompany: CompanyRow | undefined;
  if (companyId) {
    chosenCompany = accessibleCompanies.find((c) => c.id === companyId);
    if (!chosenCompany) throw Forbidden('You do not have access to this company');
  } else if (companyCode) {
    chosenCompany = accessibleCompanies.find((c) => c.company_code.toLowerCase() === companyCode.toLowerCase());
    if (!chosenCompany) throw Forbidden('You do not have access to this company');
  } else if (accessibleCompanies.length > 1) {
    // several companies → the login screen asks which one (password already verified)
    res.json({ data: { requiresCompanySelection: true, companies: accessibleCompanies,
      user: { id: user.id, username: user.username, fullName: user.full_name } } });
    return;
  } else {
    chosenCompany = accessibleCompanies[0];
  }
  const effectiveCompanyId = chosenCompany.id;

  const session = await execute(
    `INSERT INTO trx_user_session (user_id, ip_address, user_agent) VALUES (?,?,?)`,
    [user.id, req.ip ?? null, (req.headers['user-agent'] ?? '').slice(0, 255)],
  );
  await execute(`UPDATE mst_user SET last_login_at = NOW() WHERE id = ?`, [user.id]);

  const payload = { sub: user.id, cid: effectiveCompanyId, sid: session.insertId, username: user.username };
  const profile = await loadAuthUser(user.id, effectiveCompanyId);

  res.json({
    data: {
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
      user: serializeUser(profile),
      company: chosenCompany ?? null,
      companies: accessibleCompanies,
    },
  });
}));

authRouter.post('/refresh', ah(async (req, res) => {
  const token = z.object({ refreshToken: z.string().min(1) }).parse(req.body).refreshToken;
  const payload = verifyRefreshToken(token);
  const profile = await loadAuthUser(payload.sub, payload.cid);   // re-validates active/locked with company scope
  const next = { sub: profile.id, cid: profile.companyId, sid: payload.sid, username: profile.username };
  res.json({
    data: {
      accessToken: signAccessToken(next),
      refreshToken: signRefreshToken(next),
      user: serializeUser(profile),
    },
  });
}));

authRouter.post('/switch-company', authenticate, ah(async (req, res) => {
  const { companyId } = z.object({ companyId: z.coerce.number().int().positive() }).parse(req.body);
  const targetCompany = await queryOne<{
    id: number; company_code: string; legal_name: string; trade_name: string | null; gstin: string | null; logo_path: string | null;
  }>(`SELECT id, company_code, legal_name, trade_name, gstin, logo_path FROM mst_company WHERE id = ? AND is_active = 1 AND is_deleted = 0`, [companyId]);
  if (!targetCompany) throw NotFound('Company not found or inactive');

  // same rule as login: home company, granted companies, or every company for a platform super admin
  // (isSuperAdmin is per-company — a SUPER_ADMIN role in one company is not access to all)
  const allowed = await companiesFor(req.user!.id, req.user!.homeCompanyId, req.user!.isPlatformSuperAdmin);
  if (!allowed.some((c) => c.id === companyId)) throw Forbidden('You do not have access to this company');

  const payload = { sub: req.user!.id, cid: companyId, sid: req.sessionId, username: req.user!.username };
  const profile = await loadAuthUser(req.user!.id, companyId);

  res.json({
    data: {
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
      user: serializeUser(profile),
      company: targetCompany,
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
    `SELECT id, company_code, legal_name, trade_name, base_currency, logo_path, gstin, pan, city, state
       FROM mst_company WHERE id = ?`, [req.user!.companyId]);
  const branches = await query(
    `SELECT b.id, b.branch_code, b.branch_name, b.is_head_office
       FROM mst_branch b
      WHERE b.company_id = ? AND b.is_active = 1 AND b.is_deleted = 0
        ${req.user!.isSuperAdmin ? '' : 'AND b.id IN (SELECT branch_id FROM map_user_branch WHERE user_id = ?)'}
      ORDER BY b.is_head_office DESC, b.branch_name`,
    req.user!.isSuperAdmin ? [req.user!.companyId] : [req.user!.companyId, req.user!.id]);

  const companies = (await companiesFor(req.user!.id, req.user!.homeCompanyId, req.user!.isPlatformSuperAdmin))
    .map((c) => ({ ...c, is_current: c.id === req.user!.companyId ? 1 : 0 }))
    .sort((x, y) => y.is_current - x.is_current);

  res.json({
    data: {
      user: serializeUser(req.user!),
      company,
      branches,
      companies,
      menu: await buildMenu(req.user!),
    },
  });
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
         JOIN mst_role r             ON r.id = ur.role_id AND r.is_active = 1 AND r.company_id = ?
         JOIN map_role_permission rp ON rp.role_id = ur.role_id
         JOIN mst_permission p       ON p.id = rp.permission_id
        WHERE ur.user_id = ?`, [u.companyId, u.id]);
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
