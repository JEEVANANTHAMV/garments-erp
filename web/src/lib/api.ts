import axios, { AxiosError, type AxiosInstance } from 'axios';

export interface ApiErrorShape { code: string; message: string; details?: unknown; }

/** Normalised error surfaced to the UI. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level validation messages, when the API returned them. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { field?: string; message?: string }[]) {
        if (d?.field) out[d.field] = d.message ?? 'Invalid value';
      }
    }
    return out;
  }
}

const ACCESS_KEY = 'erp.accessToken';
const REFRESH_KEY = 'erp.refreshToken';

export const tokenStore = {
  get access()  { return localStorage.getItem(ACCESS_KEY); },
  get refresh() { return localStorage.getItem(REFRESH_KEY); },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export const api: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

api.interceptors.request.use((config) => {
  const t = tokenStore.access;
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// Refresh once, then retry. Parallel 401s share one in-flight refresh.
let refreshing: Promise<string> | null = null;

async function doRefresh(): Promise<string> {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken) throw new Error('no refresh token');
  const { data } = await axios.post(
    `${import.meta.env.VITE_API_BASE_URL || '/api'}/auth/refresh`, { refreshToken });
  tokenStore.set(data.data.accessToken, data.data.refreshToken);
  return data.data.accessToken;
}

api.interceptors.response.use(
  (r) => {
    const w = (r.data as any)?.notices;   // server notices with a successful save (e.g. purchase excess in WARN mode)
    if (Array.isArray(w) && w.length) window.dispatchEvent(new CustomEvent('erp-warnings', { detail: w }));
    return r;
  },
  async (error: AxiosError<{ error?: ApiErrorShape }>) => {
    const original = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
    const status = error.response?.status ?? 0;

    if (status === 401 && original && !original._retried && tokenStore.refresh) {
      original._retried = true;
      try {
        refreshing ??= doRefresh().finally(() => { refreshing = null; });
        const token = await refreshing;
        original.headers = original.headers ?? {};
        (original.headers as Record<string, string>).Authorization = `Bearer ${token}`;
        return api.request(original);
      } catch {
        tokenStore.clear();
        if (!location.pathname.startsWith('/login')) location.href = '/login';
      }
    }

    // 502 / 503 / 504 / no answer = the server is restarting (an update is being installed) or unreachable.
    // Reads are retried quietly (safe to repeat); a save is not repeated — the user is told what happened.
    const down = !error.response || [502, 503, 504].includes(status);
    if (down && original) {
      const o = original as typeof original & { _downTries?: number };
      if ((o.method ?? 'get').toLowerCase() === 'get' && (o._downTries ?? 0) < 4) {
        o._downTries = (o._downTries ?? 0) + 1;
        await new Promise((r) => setTimeout(r, 3000));
        return api.request(o);
      }
      if ((o.method ?? 'get').toLowerCase() !== 'get') {
        throw new ApiError(status, 'SERVER_RESTARTING',
          'The ERP server is restarting (an update is being installed) and did not answer. Wait a minute, check whether this was saved, then try again.');
      }
    }

    const body = error.response?.data?.error;
    throw new ApiError(
      status,
      body?.code ?? 'NETWORK_ERROR',
      body?.message ?? error.message ?? 'Unable to reach the server',
      body?.details,
    );
  },
);

export interface Pagination { page: number; pageSize: number; total: number; totalPages: number; }
export interface ListResponse<T> { data: T[]; pagination: Pagination; }
export interface ItemResponse<T> { data: T; }

export const http = {
  get:   async <T>(url: string, params?: unknown) => (await api.get<T>(url, { params })).data,
  post:  async <T>(url: string, body?: unknown)   => (await api.post<T>(url, body)).data,
  put:   async <T>(url: string, body?: unknown)   => (await api.put<T>(url, body)).data,
  patch: async <T>(url: string, body?: unknown)   => (await api.patch<T>(url, body)).data,
  del:   async <T>(url: string)                   => (await api.delete<T>(url)).data,
};
