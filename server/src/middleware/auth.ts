import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { Forbidden, Unauthorized } from '../core/errors.js';
import type { AuthUser } from '../types/express.js';

export interface AccessTokenPayload {
  sub: number;          // user id
  cid: number;          // company id
  sid?: number;         // session id
  username: string;
}

export function signAccessToken(p: AccessTokenPayload): string {
  return jwt.sign(p, env.jwt.accessSecret, { expiresIn: env.jwt.accessTtl } as jwt.SignOptions);
}

export function signRefreshToken(p: AccessTokenPayload): string {
  return jwt.sign(p, env.jwt.refreshSecret, { expiresIn: env.jwt.refreshTtl } as jwt.SignOptions);
}

export function verifyRefreshToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.jwt.refreshSecret) as unknown as AccessTokenPayload;
  } catch {
    throw Unauthorized('Refresh token is invalid or has expired');
  }
}

/**
 * Load the full authorization profile for a user: roles, effective permissions
 * and branch scope. SUPER_ADMIN short-circuits every permission check.
 */
export async function loadAuthUser(userId: number): Promise<AuthUser> {
  const users = await query<{
    id: number; company_id: number; username: string; full_name: string;
    is_active: number; is_deleted: number; is_locked: number;
  }>(
    `SELECT id, company_id, username, full_name, is_active, is_deleted, is_locked
       FROM mst_user WHERE id = ? LIMIT 1`,
    [userId],
  );
  const u = users[0];
  if (!u) throw Unauthorized('User no longer exists');
  if (u.is_deleted || !u.is_active) throw Unauthorized('This account has been deactivated');
  if (u.is_locked) throw Unauthorized('This account is locked. Contact your administrator.');

  const [roles, perms, branches] = await Promise.all([
    query<{ role_code: string }>(
      `SELECT r.role_code FROM map_user_role ur
         JOIN mst_role r ON r.id = ur.role_id AND r.is_active = 1
        WHERE ur.user_id = ?`, [userId]),
    query<{ permission_code: string }>(
      `SELECT DISTINCT p.permission_code
         FROM map_user_role ur
         JOIN mst_role r            ON r.id  = ur.role_id AND r.is_active = 1
         JOIN map_role_permission rp ON rp.role_id = r.id
         JOIN mst_permission p       ON p.id = rp.permission_id
        WHERE ur.user_id = ?`, [userId]),
    query<{ branch_id: number }>(
      `SELECT branch_id FROM map_user_branch WHERE user_id = ?`, [userId]),
  ]);

  const roleCodes = roles.map((r) => r.role_code);
  return {
    id: u.id,
    companyId: u.company_id,
    username: u.username,
    fullName: u.full_name,
    roles: roleCodes,
    permissions: new Set(perms.map((p) => p.permission_code)),
    branchIds: branches.map((b) => b.branch_id),
    isSuperAdmin: roleCodes.includes('SUPER_ADMIN'),
  };
}

/** Require a valid bearer token; attaches req.user. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    let token: string | undefined;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      token = header.slice(7);
    } else if (typeof req.query?.token === 'string') {
      token = req.query.token;
    }
    if (!token) throw Unauthorized();

    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, env.jwt.accessSecret) as unknown as AccessTokenPayload;
    } catch (e) {
      throw Unauthorized(
        e instanceof jwt.TokenExpiredError ? 'Session expired' : 'Invalid access token',
      );
    }

    req.user = await loadAuthUser(payload.sub);
    req.sessionId = payload.sid;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require ALL of the listed permission codes.
 * SUPER_ADMIN bypasses. Use `requireAny` for OR semantics.
 */
export function requirePermission(...codes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(Unauthorized());
    if (req.user.isSuperAdmin) return next();
    const missing = codes.filter((c) => !req.user!.permissions.has(c));
    if (missing.length) {
      return next(Forbidden(`Missing required permission: ${missing.join(', ')}`));
    }
    next();
  };
}

/** Require AT LEAST ONE of the listed permission codes. */
export function requireAny(...codes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(Unauthorized());
    if (req.user.isSuperAdmin) return next();
    if (codes.some((c) => req.user!.permissions.has(c))) return next();
    next(Forbidden(`Requires one of: ${codes.join(', ')}`));
  };
}

export function requireRole(...roleCodes: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(Unauthorized());
    if (req.user.isSuperAdmin) return next();
    if (roleCodes.some((r) => req.user!.roles.includes(r))) return next();
    next(Forbidden(`Requires role: ${roleCodes.join(' or ')}`));
  };
}
