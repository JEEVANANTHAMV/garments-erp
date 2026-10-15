import 'express';

export interface AuthUser {
  id: number;
  companyId: number;
  username: string;
  fullName: string;
  roles: string[];
  permissions: Set<string>;
  branchIds: number[];
  /** SUPER_ADMIN role in the company the user is working in (companyId). */
  isSuperAdmin: boolean;
  /** The company the user account belongs to (mst_user.company_id). */
  homeCompanyId: number;
  /** SUPER_ADMIN in their HOME company — the only users who may administer other companies. */
  isPlatformSuperAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: number;
    }
  }
}
