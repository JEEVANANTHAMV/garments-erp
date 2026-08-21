import 'express';

export interface AuthUser {
  id: number;
  companyId: number;
  username: string;
  fullName: string;
  roles: string[];
  permissions: Set<string>;
  branchIds: number[];
  isSuperAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      sessionId?: number;
    }
  }
}
