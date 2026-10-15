import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { http, tokenStore } from './api';

export interface AuthUser {
  id: number; username: string; fullName: string; companyId: number;
  roles: string[]; permissions: string[]; branchIds: number[]; isSuperAdmin: boolean;
}
export interface Company {
  id: number; company_code: string; legal_name: string; trade_name: string | null;
  gstin?: string | null; pan?: string | null; city?: string | null; state?: string | null;
  logo_path: string | null; is_current?: number;
}
export interface Branch { id: number; branch_code: string; branch_name: string; is_head_office: number; }
export interface MenuNode { code: string; name: string; children: MenuNode[]; }

export interface LoginResult {
  requiresCompanySelection?: boolean;
  companies?: Company[];
}

interface AuthState {
  user: AuthUser | null;
  company: Company | null;
  companies: Company[];
  branches: Branch[];
  menu: MenuNode[];
  loading: boolean;
  login: (username: string, password: string, companyId?: number) => Promise<LoginResult | void>;
  switchCompany: (companyId: number) => Promise<void>;
  logout: () => Promise<void>;
  /** True when the user holds the permission (super admin always true). */
  can: (code: string) => boolean;
  /** True when the user holds ANY of the codes. */
  canAny: (...codes: string[]) => boolean;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [menu, setMenu] = useState<MenuNode[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProfile = async () => {
    const res = await http.get<{ data: {
      user: AuthUser; company: Company; branches: Branch[]; menu: MenuNode[]; companies?: Company[];
    } }>('/auth/me');
    setUser(res.data.user);
    setCompany(res.data.company);
    setBranches(res.data.branches ?? []);
    setMenu(res.data.menu ?? []);
    setCompanies(res.data.companies ?? (res.data.company ? [res.data.company] : []));
  };

  // Restore the session on first mount when a token is present.
  useEffect(() => {
    (async () => {
      if (!tokenStore.access) { setLoading(false); return; }
      try { await loadProfile(); }
      catch { tokenStore.clear(); }
      finally { setLoading(false); }
    })();
  }, []);

  const login = async (username: string, password: string, companyId?: number): Promise<LoginResult | void> => {
    const res = await http.post<{ data: {
      accessToken?: string;
      refreshToken?: string;
      user?: AuthUser;
      requiresCompanySelection?: boolean;
      companies?: Company[];
    } }>('/auth/login', { username, password, companyId });

    if (res.data.requiresCompanySelection) {
      return {
        requiresCompanySelection: true,
        companies: res.data.companies ?? [],
      };
    }

    if (res.data.accessToken && res.data.refreshToken) {
      tokenStore.set(res.data.accessToken, res.data.refreshToken);
      await loadProfile();
    }
  };

  const switchCompany = async (companyId: number) => {
    const res = await http.post<{ data: {
      accessToken: string;
      refreshToken: string;
      user: AuthUser;
      company: Company;
    } }>('/auth/switch-company', { companyId });
    tokenStore.set(res.data.accessToken, res.data.refreshToken);
    await loadProfile();
    window.location.reload();
  };

  const logout = async () => {
    try { await http.post('/auth/logout'); } catch { /* token may already be invalid */ }
    tokenStore.clear();
    setUser(null); setCompany(null); setCompanies([]); setBranches([]); setMenu([]);
    // Hard redirect — clears React Query cache and all in-memory state
    window.location.href = '/login';
  };

  const permSet = useMemo(() => new Set(user?.permissions ?? []), [user]);
  const can = (code: string) => !!user && (user.isSuperAdmin || permSet.has(code));
  const canAny = (...codes: string[]) =>
    !!user && (user.isSuperAdmin || codes.some((c) => permSet.has(c)));

  return (
    <AuthCtx.Provider value={{ user, company, companies, branches, menu, loading, login, switchCompany, logout, can, canAny }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
