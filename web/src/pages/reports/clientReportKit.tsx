/**
 * clientReportKit — the shared report screen for the client's own report set
 * (Client Reports A and B). One component renders a whole report:
 * filter bar → quick search → sortable table → totals row → footnotes → Excel export.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   import { ClientReport, type ReportDef } from './clientReportKit';
 *
 *   const def: ReportDef = {
 *     key: 'orders-in-hand',                       // unique, also used for data-report attr + file name
 *     title: 'Orders in Hand',
 *     subtitle: 'Sale order report',
 *     endpoint: '/client-reports/orders-in-hand',  // GET, relative to /api
 *     filters: [
 *       { key: 'status', label: 'Status', type: 'select', default: 'open', required: true,
 *         options: [{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }] },
 *       { key: 'buyer_id', label: 'Buyer', type: 'select', lookup: 'buyers' },  // GET /lookups/buyers → {id,label}
 *       { key: 'dateFrom', label: 'From', type: 'date' },
 *       { key: 'dateTo',   label: 'To',   type: 'date' },
 *       { key: 'season',   label: 'Season', type: 'text' },
 *     ],
 *     columns: [
 *       { key: 'so_no', header: 'SO No', link: (r) => `/sales/orders/${r.so_id}` },  // drill-down
 *       { key: 'so_date', header: 'Ord Rec Date', type: 'date' },
 *       { key: 'order_qty', header: 'Ord Qty', type: 'qty', total: true },
 *       { key: 'balance_value', header: 'Balance value', type: 'money', total: true },
 *       { key: 'actual_exrate', header: 'Actual Exrate', footnote: 'Not captured in the ERP yet' },
 *     ],
 *     footnotes: ['Static note shown under the table'],
 *   };
 *   <ClientReport def={def} />
 *
 * ── Server contract ───────────────────────────────────────────────────────────
 *   GET <endpoint>?<filter values…>  →  { data: Row[], meta?: { footnotes?: string[] } }
 *   Empty filter values are not sent. meta.footnotes are appended to def.footnotes.
 *
 * ── Column types ──────────────────────────────────────────────────────────────
 *   text (default) | qty (0–3 decimals) | int | money (2 decimals) | pct (2 dp + %) | date | yn (Yes/No badge)
 *   total: true      → column summed over the visible (filtered) rows, shown in the footer and the Excel totals row
 *   link: row → url  → cell rendered as a <Link>; null/'' → plain text. Use it for drill-down to the source document.
 *   render: row → ReactNode overrides the cell (Excel still exports the raw value, or exportValue(row)).
 *   footnote: string → header gets a marker (¹ ²…) and the note is listed under the table (for blank-by-design columns).
 *
 * ── Other exports ─────────────────────────────────────────────────────────────
 *   exportRowsToExcel(fileName, sheetName, columns, rows, title?) — the same export, callable directly.
 *   ReportSection / ReportPicker — a left-list / right-report layout used by the report pages.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import { ArrowDown, ArrowUp, Download, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { http } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Badge, ErrorState, LoadingBlock, SearchInput, Select, useDebounced } from '../../components/ui';

/* ------------------------------------------------------------------ types */
export type ColType = 'text' | 'qty' | 'int' | 'money' | 'pct' | 'date' | 'yn';

export interface ReportColumn {
  key: string;
  header: string;
  type?: ColType;
  total?: boolean;
  link?: (row: any) => string | null | undefined;
  render?: (row: any) => ReactNode;
  exportValue?: (row: any) => unknown;
  footnote?: string;
  className?: string;
}

export interface ReportFilter {
  key: string;
  label: string;
  type: 'select' | 'date' | 'text';
  options?: { value: string | number; label: string }[];
  /** Generic lookup name (GET /lookups/<name> → [{ id, label }]) used to fill a select. */
  lookup?: string;
  default?: string;
  placeholder?: string;
  /** select only: no empty "All" option (use with a default). */
  required?: boolean;
}

export interface ReportDef {
  key: string;
  title: string;
  subtitle?: string;
  endpoint: string;
  filters?: ReportFilter[];
  columns: ReportColumn[];
  footnotes?: string[];
  /** Row key; defaults to row index. */
  rowKey?: (row: any, i: number) => string | number;
}

/* --------------------------------------------------------------- helpers */
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isNumType = (t?: ColType) => t === 'qty' || t === 'int' || t === 'money' || t === 'pct';
const SUP = ['¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

export function formatCell(v: unknown, type?: ColType): string {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'qty': return num(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
    case 'int': return Math.round(num(v)).toLocaleString('en-IN');
    case 'money': return num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'pct': return `${num(v).toFixed(2)}%`;
    case 'date': return fmtDate(v);
    case 'yn': return v === true || v === 1 || v === 'Y' || v === 'Yes' || v === '1' ? 'Yes' : 'No';
    default: return String(v);
  }
}

function rawExport(c: ReportColumn, r: any): unknown {
  if (c.exportValue) return c.exportValue(r);
  const v = r[c.key];
  if (v === null || v === undefined) return '';
  if (isNumType(c.type)) return num(v);
  if (c.type === 'date') return String(v).slice(0, 10);
  if (c.type === 'yn') return formatCell(v, 'yn');
  return v;
}

export function sumColumns(columns: ReportColumn[], rows: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of columns) if (c.total) out[c.key] = rows.reduce((a, r) => a + num(r[c.key]), 0);
  return out;
}

/** Excel export: title row (optional), header row, data rows, totals row. */
export function exportRowsToExcel(fileName: string, sheetName: string, columns: ReportColumn[], rows: any[], title?: string) {
  const aoa: unknown[][] = [];
  if (title) aoa.push([title], []);
  aoa.push(columns.map((c) => c.header));
  for (const r of rows) aoa.push(columns.map((c) => rawExport(c, r)));
  if (columns.some((c) => c.total)) {
    const t = sumColumns(columns, rows);
    aoa.push(columns.map((c, i) => (c.total ? Math.round(t[c.key] * 1000) / 1000 : i === 0 ? 'TOTAL' : '')));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map((c) => ({ wch: Math.max(10, Math.min(40, c.header.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  XLSX.writeFile(wb, `${fileName}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* ---------------------------------------------------- lookup-backed select */
function LookupSelect({ f, value, onChange }: { f: ReportFilter; value: string; onChange: (v: string) => void }) {
  const q = useQuery({
    queryKey: ['lookup', f.lookup],
    queryFn: async () => (await http.get<{ data: any[] }>(`/lookups/${f.lookup}`)).data ?? [],
    enabled: !!f.lookup,
    staleTime: 5 * 60_000,
  });
  const opts = f.options ?? (q.data ?? []).map((o: any) => ({ value: o.id, label: o.label ?? o.code ?? String(o.id) }));
  return (
    <Select label={f.label} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={f.required ? undefined : (f.placeholder ?? 'All')} options={opts} data-filter={f.key} />
  );
}

/* ------------------------------------------------------------- the report */
export function ClientReport({ def }: { def: ReportDef }) {
  const initial = useMemo(() => Object.fromEntries((def.filters ?? []).map((f) => [f.key, f.default ?? ''])), [def]);
  const [filters, setFilters] = useState<Record<string, string>>(initial);
  const [search, setSearch] = useState('');
  const debSearch = useDebounced(search, 200);
  const debFilters = useDebounced(filters, 300);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  useEffect(() => { setFilters(initial); setSearch(''); setSort(null); }, [initial]);

  const params = useMemo(
    () => Object.fromEntries(Object.entries(debFilters).filter(([, v]) => v !== '' && v != null)),
    [debFilters]);

  const q = useQuery({
    queryKey: ['client-report', def.endpoint, params],
    queryFn: () => http.get<{ data: any[]; meta?: { footnotes?: string[] } }>(def.endpoint, params),
  });

  const rows = useMemo(() => {
    let r = q.data?.data ?? [];
    const s = debSearch.trim().toLowerCase();
    if (s) r = r.filter((row) => def.columns.some((c) => String(row[c.key] ?? '').toLowerCase().includes(s)));
    if (sort) {
      const col = def.columns.find((c) => c.key === sort.key);
      const numeric = isNumType(col?.type);
      r = [...r].sort((a, b) => {
        const av = a[sort.key]; const bv = b[sort.key];
        const cmp = numeric ? num(av) - num(bv) : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true });
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return r;
  }, [q.data, debSearch, sort, def.columns]);

  const totals = useMemo(() => sumColumns(def.columns, rows), [def.columns, rows]);
  const hasTotals = def.columns.some((c) => c.total);
  const notedCols = def.columns.filter((c) => c.footnote);
  const notes = [...(def.footnotes ?? []), ...(q.data?.meta?.footnotes ?? [])];

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));

  return (
    <div data-report={def.key}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-title-lg font-semibold text-slate-900">{def.title}</h2>
          {def.subtitle && <p className="text-body text-slate-500">{def.subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => void q.refetch()} title="Refresh">
            <RefreshCw size={14} className={clsx(q.isFetching && 'animate-spin')} /> Refresh
          </button>
          <button className="btn-primary inline-flex items-center gap-1.5" data-action="export-excel"
            disabled={!rows.length}
            onClick={() => exportRowsToExcel(def.key, def.title, def.columns, rows, def.title)}>
            <Download size={14} /> Excel
          </button>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        {(def.filters ?? []).map((f) => {
          const set = (v: string) => setFilters((p) => ({ ...p, [f.key]: v }));
          if (f.type === 'select') return <LookupSelect key={f.key} f={f} value={filters[f.key] ?? ''} onChange={set} />;
          return (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              <input className="input" type={f.type === 'date' ? 'date' : 'text'} data-filter={f.key}
                placeholder={f.placeholder} value={filters[f.key] ?? ''} onChange={(e) => set(e.target.value)} />
            </div>
          );
        })}
        <div className="col-span-2 self-end">
          <SearchInput value={search} onChange={setSearch} placeholder="Search in results…" />
        </div>
      </div>

      {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <div className="card overflow-auto" style={{ maxHeight: '68vh' }}>
          <table className="min-w-full text-body" data-report-table={def.key}>
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                {def.columns.map((c) => {
                  const ni = notedCols.indexOf(c);
                  return (
                    <th key={c.key} onClick={() => toggleSort(c.key)} data-col={c.key}
                      className={clsx('cursor-pointer select-none whitespace-nowrap border-b border-surface-border px-2.5 py-2 font-semibold text-slate-600',
                        isNumType(c.type) ? 'text-right' : 'text-left')}>
                      <span className="inline-flex items-center gap-1">
                        {c.header}{ni >= 0 && <sup className="text-amber-600">{SUP[ni] ?? '*'}</sup>}
                        {sort?.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {!rows.length && (
                <tr><td colSpan={def.columns.length} className="px-3 py-10 text-center text-slate-400">No records for these filters</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={def.rowKey ? def.rowKey(r, i) : i} className="border-b border-slate-100 hover:bg-brand-50/40">
                  {def.columns.map((c) => {
                    const href = c.link?.(r);
                    const body = c.render ? c.render(r)
                      : c.type === 'yn' && r[c.key] != null && r[c.key] !== ''
                        ? <Badge tone={formatCell(r[c.key], 'yn') === 'Yes' ? 'green' : 'amber'}>{formatCell(r[c.key], 'yn')}</Badge>
                        : formatCell(r[c.key], c.type);
                    return (
                      <td key={c.key} className={clsx('whitespace-nowrap px-2.5 py-1.5', isNumType(c.type) && 'text-right tabular-nums', c.className)}>
                        {href ? <Link to={href} className="font-medium text-brand-700 hover:underline" data-drill={c.key}>{body || '—'}</Link> : body}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {hasTotals && rows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-slate-100 font-semibold">
                <tr>
                  {def.columns.map((c, i) => (
                    <td key={c.key} data-total={c.total ? c.key : undefined}
                      className={clsx('whitespace-nowrap px-2.5 py-2', isNumType(c.type) && 'text-right tabular-nums')}>
                      {c.total ? formatCell(totals[c.key], c.type === 'pct' ? 'money' : c.type) : i === 0 ? `Total (${rows.length})` : ''}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {(notedCols.length > 0 || notes.length > 0) && (
        <div className="mt-2 space-y-0.5 text-small text-slate-500">
          {notedCols.map((c, i) => <p key={c.key}><span className="text-amber-600">{SUP[i] ?? '*'}</span> {c.header}: {c.footnote}</p>)}
          {notes.map((n, i) => <p key={`n${i}`}>• {n}</p>)}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------- section layout (list + report) */
export function ReportSection({ title, subtitle, defs, initialKey }: {
  title: string; subtitle?: string; defs: ReportDef[]; initialKey?: string;
}) {
  const fromHash = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
  const [active, setActive] = useState(defs.find((d) => d.key === fromHash)?.key ?? initialKey ?? defs[0]?.key);
  const def = defs.find((d) => d.key === active) ?? defs[0];
  const pick = (k: string) => { setActive(k); try { window.history.replaceState(null, '', `#${k}`); } catch { /* ignore */ } };
  return (
    <>
      <div className="mb-4">
        <h1 className="text-page font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-body text-slate-500">{subtitle}</p>}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[230px_1fr]">
        <nav className="card h-fit p-1.5" data-report-list>
          {defs.map((d) => (
            <button key={d.key} data-report-key={d.key} onClick={() => pick(d.key)}
              className={clsx('block w-full rounded-md px-3 py-2 text-left text-body',
                d.key === def?.key ? 'bg-brand-50 font-semibold text-brand-700' : 'text-slate-600 hover:bg-slate-50')}>
              {d.title}
            </button>
          ))}
        </nav>
        <div className="min-w-0">{def && <ClientReport key={def.key} def={def} />}</div>
      </div>
    </>
  );
}
