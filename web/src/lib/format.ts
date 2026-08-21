/** Display helpers shared across screens. */

export const fmtNumber = (v: unknown, dp = 0): string => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

export const fmtDecimal = (v: unknown, dp = 2) => fmtNumber(v, dp);

export const fmtMoney = (v: unknown, currency = '', dp = 2): string => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '—';
  const s = n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return currency ? `${currency} ${s}` : s;
};

/** Compact money for dashboard tiles: 1.2M / 45.3K. */
export const fmtCompact = (v: unknown, currency = ''): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const [val, suffix] =
    abs >= 1e9 ? [n / 1e9, 'B'] :
    abs >= 1e6 ? [n / 1e6, 'M'] :
    abs >= 1e3 ? [n / 1e3, 'K'] : [n, ''];
  const s = val.toLocaleString('en-IN', { maximumFractionDigits: suffix ? 1 : 0 });
  return `${currency ? currency + ' ' : ''}${s}${suffix}`;
};

export const fmtDate = (v: unknown): string => {
  if (!v) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const fmtDateTime = (v: unknown): string => {
  if (!v) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

/** YYYY-MM-DD for <input type="date"> round-tripping. */
export const toDateInput = (v: unknown): string => {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

export const today = () => new Date().toISOString().slice(0, 10);

/** SOME_ENUM_VALUE -> Some Enum Value */
export const humanize = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
};

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
