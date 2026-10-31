import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, Button, LoadingBlock, Modal, SearchInput, Select, StatusBadge, useDebounced } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber } from '../../lib/format';

/**
 * Shared pieces of the line allocation / daily plan / daily output screens.
 *
 * Client call 28-Sep-2026: every production screen from stitching to the
 * finished goods store shows bundles the same way — one heading per job
 * (IO no, style, buyer, PO) with that job's bundles as rows underneath, never
 * a separate grid per bundle.
 */

export type Proc = 'sewing' | 'checking' | 'ironing' | 'packing';
export const PROC_LABEL: Record<Proc, string> = { sewing: 'Sewing', checking: 'Checking', ironing: 'Ironing', packing: 'Packing' };
/** Where each process takes its bundles from (bundle ledger). */
export const PROC_SOURCE: Record<Proc, string> = {
  sewing: 'from Cutting / Sewing Inward', checking: 'sewn good, waiting for checking',
  ironing: 'checked good / in finishing', packing: 'finished, ready to pack',
};

export const n = (v: unknown) => Number(v ?? 0) || 0;
export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export interface BundleInfo {
  bundle_id: number; bundle_no: string; barcode?: string | null;
  io_no?: string | null; job_no?: string | null; po_no?: string | null; buyer?: string | null;
  style_id?: number | null; style_no?: string | null; style_description?: string | null;
  colour_id?: number | null; colour?: string | null; size_id?: number | null; size?: string | null; size_sort?: number;
  lay_no?: string | null; cut_no?: string | null; part_name?: string | null;
  bundle_qty: number; weight_kg?: number | null; inward_date?: string | null;
  fabric_name?: string | null; fabric_type?: string | null; gsm?: number | null;
}

export interface JobGroup<T> {
  key: string; io_no: string; style_no: string; style_description: string; buyer: string; po_no: string;
  colours: string[]; rows: T[];
}

/** Group rows under one heading per job (IO no + style). */
export function groupByJob<T extends Partial<BundleInfo>>(rows: T[]): JobGroup<T>[] {
  const map = new Map<string, JobGroup<T>>();
  for (const r of rows) {
    const key = `${r.io_no ?? '—'}|${r.style_no ?? ''}`;
    if (!map.has(key)) {
      map.set(key, {
        key, io_no: r.io_no ?? '—', style_no: r.style_no ?? '—', style_description: r.style_description ?? '',
        buyer: r.buyer ?? '', po_no: r.po_no ?? '', colours: [], rows: [],
      });
    }
    const g = map.get(key)!;
    g.rows.push(r);
    if (r.colour && !g.colours.includes(r.colour)) g.colours.push(r.colour);
  }
  for (const g of map.values()) {
    g.rows.sort((a, b) => String(a.colour ?? '').localeCompare(String(b.colour ?? ''))
      || n(a.size_sort) - n(b.size_sort)
      || String(a.bundle_no ?? '').localeCompare(String(b.bundle_no ?? ''), undefined, { numeric: true }));
  }
  return [...map.values()].sort((a, b) => a.io_no.localeCompare(b.io_no));
}

/** One job heading row inside a bundle table. */
export function JobHeaderRow({ group, colSpan, qty, extra, checked, onCheck, open, onToggle }: {
  group: JobGroup<any>; colSpan: number; qty: number; extra?: ReactNode;
  checked?: boolean; onCheck?: () => void; open?: boolean; onToggle?: () => void;
}) {
  return (
    <tr className="border-t border-brand-100 bg-brand-50/70">
      <td colSpan={colSpan} className="px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
          {onToggle && (
            <button type="button" onClick={onToggle} className="text-brand-700">
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          {onCheck && <input type="checkbox" checked={!!checked} onChange={onCheck} />}
          <span>Job / IO: <b className="tabular-nums text-brand-800">{group.io_no}</b></span>
          <span>Style: <b>{group.style_no}</b>{group.style_description ? <span className="text-slate-500"> · {group.style_description}</span> : null}</span>
          {group.buyer && <span>Buyer: <b>{group.buyer}</b></span>}
          {group.po_no && <span>PO: <b>{group.po_no}</b></span>}
          {group.colours.length > 0 && <span>Colour: <b>{group.colours.join(', ')}</b></span>}
          <span className="ml-auto text-slate-600">{group.rows.length} bundle(s) · <b>{fmtNumber(qty)}</b> PCS</span>
          {extra}
        </div>
      </td>
    </tr>
  );
}

export function SummaryCard({ icon, label, value, tone, sub }: { icon: ReactNode; label: string; value: ReactNode; tone: string; sub?: ReactNode }) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${tone}`}>
      <span className="opacity-70">{icon}</span>
      <div>
        <p className="text-caption font-medium opacity-80">{label}</p>
        <p className="text-xl font-bold leading-tight">{value}</p>
        {sub && <p className="text-micro opacity-75">{sub}</p>}
      </div>
    </div>
  );
}

export function UtilBar({ value, width = 'w-20' }: { value: number; width?: string }) {
  const tone = value > 100 ? 'bg-red-500' : value >= 90 ? 'bg-emerald-500' : value >= 70 ? 'bg-blue-500' : value >= 50 ? 'bg-amber-500' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2">
      <div className={`h-2.5 ${width} overflow-hidden rounded-full bg-slate-100`}>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className={`text-caption font-medium ${value > 100 ? 'text-red-600' : ''}`}>{value}%</span>
    </div>
  );
}

/** Distinct option list for a filter select. */
export function distinct<T>(rows: T[], get: (r: T) => string | null | undefined) {
  return [...new Set(rows.map(get).filter((x): x is string => !!x))].sort().map((v) => ({ value: v, label: v }));
}

export interface RowFilters { job: string; po: string; style: string; buyer: string; colour: string; size: string }
export const EMPTY_FILTERS: RowFilters = { job: '', po: '', style: '', buyer: '', colour: '', size: '' };
export function applyFilters<T extends Partial<BundleInfo>>(rows: T[], f: RowFilters) {
  return rows.filter((r) => (!f.job || r.io_no === f.job) && (!f.po || r.po_no === f.po) && (!f.style || r.style_no === f.style)
    && (!f.buyer || r.buyer === f.buyer) && (!f.colour || r.colour === f.colour) && (!f.size || r.size === f.size));
}

/* ── Cascading filters (client call 14-Oct-2026) ──────────────────────────
 * "When I choose the job, everything else should load automatically." Each
 * dropdown lists only the values found in rows that match every OTHER active
 * filter; when that narrowing leaves a single buyer / PO / style it is picked
 * automatically (colour and size never are). Pure functions first so they can
 * be tested without React. */

export type FilterKey = keyof RowFilters;
export const FILTER_FIELDS: { key: FilterKey; label: string; get: (r: Partial<BundleInfo>) => string | null | undefined }[] = [
  { key: 'job', label: 'Job No', get: (r) => r.io_no },
  { key: 'po', label: 'PO No', get: (r) => r.po_no },
  { key: 'style', label: 'Style No', get: (r) => r.style_no },
  { key: 'buyer', label: 'Buyer', get: (r) => r.buyer },
  { key: 'colour', label: 'Colour', get: (r) => r.colour },
  { key: 'size', label: 'Size', get: (r) => r.size },
];
/** Filters filled in by themselves when only one value is left. */
export const AUTO_FILTER_KEYS: FilterKey[] = ['buyer', 'po', 'style'];
export interface FilterOption { value: string; label: string; count: number }

const matchesExcept = (r: Partial<BundleInfo>, f: RowFilters, skip: FilterKey) =>
  FILTER_FIELDS.every((d) => d.key === skip || !f[d.key] || d.get(r) === f[d.key]);

/** Options for every filter, each computed over the rows matching all the other filters. */
export function cascadeOptions<T extends Partial<BundleInfo>>(rows: T[], f: RowFilters): Record<FilterKey, FilterOption[]> {
  const out = {} as Record<FilterKey, FilterOption[]>;
  for (const d of FILTER_FIELDS) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!matchesExcept(r, f, d.key)) continue;
      const v = d.get(r);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    out[d.key] = [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([value, count]) => ({ value, label: `${value} (${count})`, count }));
  }
  return out;
}

export interface FilterState { filters: RowFilters; auto: FilterKey[] }

/**
 * Bring filters back in line with the rows after a change.
 * - `changed`: the filter the user just set. Every auto-picked value is dropped
 *   first and re-derived, so clearing the job clears the buyer it implied.
 * - `suppress`: auto keys the user deliberately emptied — not refilled.
 * A chosen value that no longer exists under the other filters goes back to All.
 */
export function reconcileFilters<T extends Partial<BundleInfo>>(rows: T[], state: FilterState, changed?: FilterKey, suppress: FilterKey[] = []): FilterState {
  const f: RowFilters = { ...state.filters };
  const auto = new Set(state.auto);
  if (changed) {
    auto.delete(changed);
    for (const k of auto) f[k] = '';
    auto.clear();
  }
  for (let guard = 0; guard < 12; guard++) {
    const opts = cascadeOptions(rows, f);
    let moved = false;
    for (const d of FILTER_FIELDS) {
      const k = d.key;
      if (f[k] && k !== changed && !opts[k].some((o) => o.value === f[k])) { f[k] = ''; auto.delete(k); moved = true; }
    }
    if (moved) continue;
    const hasManual = FILTER_FIELDS.some((d) => f[d.key] && !auto.has(d.key));
    if (!hasManual) {
      for (const k of auto) f[k] = '';
      auto.clear();
      break;
    }
    for (const k of AUTO_FILTER_KEYS) {
      if (!f[k] && !suppress.includes(k) && opts[k].length === 1) { f[k] = opts[k][0].value; auto.add(k); moved = true; }
    }
    if (!moved) break;
  }
  return { filters: f, auto: FILTER_FIELDS.map((d) => d.key).filter((k) => auto.has(k)) };
}

const sameState = (a: FilterState, b: FilterState) =>
  FILTER_FIELDS.every((d) => a.filters[d.key] === b.filters[d.key]) && a.auto.join() === b.auto.join();

/**
 * Cascading job / PO / style / buyer / colour / size filters over `rows`
 * (the full list the screen can show). Used by line allocation (all four
 * processes), daily plans and daily output.
 */
export function useCascadingFilters<T extends Partial<BundleInfo>>(rows: T[]) {
  const [state, setState] = useState<FilterState>({ filters: EMPTY_FILTERS, auto: [] });
  const [suppress, setSuppress] = useState<FilterKey[]>([]);

  // Rows reloaded (stock refreshed, bundles allocated): drop values that vanished.
  useEffect(() => {
    if (!rows.length) return;
    setState((s) => { const next = reconcileFilters(rows, s, undefined, suppress); return sameState(s, next) ? s : next; });
  }, [rows, suppress]);

  const setFilter = useCallback((k: FilterKey, v: string) => {
    const sup = !v && AUTO_FILTER_KEYS.includes(k) ? [k] : [];
    setSuppress(sup);
    setState((s) => reconcileFilters(rows, { ...s, filters: { ...s.filters, [k]: v } }, k, sup));
  }, [rows]);
  const clear = useCallback(() => { setSuppress([]); setState({ filters: EMPTY_FILTERS, auto: [] }); }, []);
  const options = useMemo(() => {
    const o = cascadeOptions(rows, state.filters);
    // Keep a chosen value listed even while rows are reloading.
    for (const d of FILTER_FIELDS) {
      const v = state.filters[d.key];
      if (v && !o[d.key].some((x) => x.value === v)) o[d.key] = [{ value: v, label: `${v} (0)`, count: 0 }, ...o[d.key]];
    }
    return o;
  }, [rows, state.filters]);
  const active = FILTER_FIELDS.some((d) => state.filters[d.key]);
  return { filters: state.filters, auto: state.auto, options, setFilter, clear, active };
}
export type CascadingFilters = ReturnType<typeof useCascadingFilters>;

/** The filter dropdowns + "Clear filters" link for a cascading filter set. */
export function CascadingFilterBar({ cf, width = 'w-36', children }: { cf: CascadingFilters; width?: string; children?: ReactNode }) {
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2" data-filter-bar>
      {FILTER_FIELDS.map((d) => {
        const isAuto = cf.auto.includes(d.key);
        return (
          <Select key={d.key} label={isAuto ? `${d.label} · auto` : d.label} className={width} value={cf.filters[d.key]} placeholder="All"
            options={cf.options[d.key]} data-filter={d.key} data-auto={isAuto ? '1' : undefined}
            title={isAuto ? 'Filled in automatically from the other filters — choose All to clear' : undefined}
            onChange={(e) => cf.setFilter(d.key, e.target.value)} />
        );
      })}
      {children}
      {cf.active && (
        <button type="button" data-clear-filters onClick={cf.clear}
          className="mb-2.5 text-xs font-medium text-brand-600 hover:text-brand-800 hover:underline">Clear filters</button>
      )}
    </div>
  );
}

/** "Select all shown" / "Clear" links over a checkbox grid. Only touches the shown rows. */
export function SelectShown<K>({ shown, selected, onChange, disabled }: {
  shown: K[]; selected: Set<K>; onChange: (next: Set<K>) => void; disabled?: boolean;
}) {
  const picked = shown.filter((k) => selected.has(k)).length;
  return (
    <span className="flex items-center gap-2 text-xs">
      <button type="button" data-select-shown disabled={disabled || !shown.length || picked === shown.length}
        className="font-medium text-brand-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
        onClick={() => onChange(new Set([...selected, ...shown]))}>Select all shown ({shown.length})</button>
      {selected.size > 0 && (
        <button type="button" data-clear-selection disabled={disabled} className="text-slate-500 hover:underline"
          onClick={() => onChange(new Set())}>Clear selection ({selected.size})</button>
      )}
    </span>
  );
}

/** Header-checkbox toggle limited to the shown rows (others keep their state). */
export function toggleShown<K>(selected: Set<K>, shown: K[]): Set<K> {
  const all = shown.length > 0 && shown.every((k) => selected.has(k));
  const next = new Set(selected);
  shown.forEach((k) => (all ? next.delete(k) : next.add(k)));
  return next;
}

/** Summary by any key (job / style / colour / size) for the summary tabs. */
export function summarize<T>(rows: T[], key: (r: T) => string, qty: (r: T) => number, label?: (r: T) => string) {
  const map = new Map<string, { key: string; label: string; bundles: number; qty: number; pct: number }>();
  let total = 0;
  for (const r of rows) {
    const k = key(r) || '—';
    if (!map.has(k)) map.set(k, { key: k, label: label ? label(r) : '', bundles: 0, qty: 0, pct: 0 });
    const m = map.get(k)!;
    m.bundles++; m.qty += qty(r); total += qty(r);
  }
  for (const m of map.values()) m.pct = pct(m.qty, total);
  return { rows: [...map.values()].sort((a, b) => b.qty - a.qty), total };
}

export function SummaryTable({ title, keyLabel, labelHeader, data }: {
  title?: string; keyLabel: string; labelHeader?: string;
  data: { rows: { key: string; label: string; bundles: number; qty: number; pct: number }[]; total: number };
}) {
  return (
    <div className="overflow-x-auto">
      {title && <p className="px-3 pt-3 text-xs font-semibold text-slate-700">{title}</p>}
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left">{keyLabel}</th>
            {labelHeader && <th className="px-3 py-2 text-left">{labelHeader}</th>}
            <th className="px-3 py-2 text-right">Bundles</th>
            <th className="px-3 py-2 text-right">Qty (PCS)</th>
            <th className="px-3 py-2 text-left">%</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.key} className="border-t border-slate-100">
              <td className="px-3 py-1.5 font-medium">{r.key}</td>
              {labelHeader && <td className="px-3 py-1.5 text-slate-500">{r.label || '—'}</td>}
              <td className="px-3 py-1.5 text-right">{r.bundles}</td>
              <td className="px-3 py-1.5 text-right font-medium">{fmtNumber(r.qty)}</td>
              <td className="px-3 py-1.5"><UtilBar value={r.pct} width="w-16" /></td>
            </tr>
          ))}
          {!data.rows.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No data</td></tr>}
        </tbody>
        {data.rows.length > 0 && (
          <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold">
            <tr>
              <td className="px-3 py-1.5" colSpan={labelHeader ? 3 : 2}>Total</td>
              <td className="px-3 py-1.5 text-right">{fmtNumber(data.total)}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Saved documents of a screen (allocations / plans / outputs) to reopen. */
export function DocumentsModal({ open, onClose, url, title, noKey, dateKey, onPick, columns }: {
  open: boolean; onClose: () => void; url: string; title: string; noKey: string; dateKey: string;
  onPick: (row: any) => void; columns?: { key: string; header: string; render?: (r: any) => ReactNode }[];
}) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const dq = useDebounced(search);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get(url).then((r) => setRows(r.data.data || [])).catch(() => setRows([])).finally(() => setLoading(false));
  }, [open, url]);
  const shown = useMemo(() => rows.filter((r) => !dq || String(r[noKey]).toLowerCase().includes(dq.toLowerCase())), [rows, dq, noKey]);
  return (
    <Modal open={open} onClose={onClose} title={title} size="xl" subtitle="Pick a saved document to open it">
      <SearchInput value={search} onChange={setSearch} placeholder="Search document no…" className="mb-3 w-full" />
      {loading && !rows.length ? <LoadingBlock /> : (
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-2 py-2 text-left">Document</th>
            <th className="px-2 py-2 text-left">Date</th>
            <th className="px-2 py-2 text-left">Shift</th>
            {columns?.map((c) => <th key={c.key} className="px-2 py-2 text-right">{c.header}</th>)}
            <th className="px-2 py-2 text-left">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="px-2 py-1.5 tabular-nums font-semibold text-brand-700">{r[noKey]}</td>
              <td className="px-2 py-1.5">{fmtDate(r[dateKey])}</td>
              <td className="px-2 py-1.5">{r.shift_name || '—'}</td>
              {columns?.map((c) => <td key={c.key} className="px-2 py-1.5 text-right">{c.render ? c.render(r) : fmtNumber(r[c.key])}</td>)}
              <td className="px-2 py-1.5"><StatusBadge value={r.status} /></td>
              <td className="px-2 py-1.5 text-right"><Button size="sm" variant="secondary" onClick={() => { onPick(r); onClose(); }}>Open</Button></td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={6 + (columns?.length ?? 0)} className="px-3 py-8 text-center text-slate-400">{loading ? 'Loading…' : 'No documents yet'}</td></tr>}
        </tbody>
      </table>
      )}
    </Modal>
  );
}

export function DocStatus({ no, status }: { no?: string | null; status?: string | null }) {
  if (!no) return <Badge tone="blue">New document</Badge>;
  return <span className="flex items-center gap-2 text-xs"><span className="tabular-nums font-semibold text-brand-700">{no}</span><StatusBadge value={status} /></span>;
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Print a plain, printer-friendly document in a new window. */
export function printDocument(title: string, meta: [string, unknown][], sections: { heading: string; columns: string[]; rows: unknown[][]; groupRows?: Set<number> }[]) {
  const w = window.open('', '_blank', 'width=1100,height=800');
  if (!w) return;
  const body = sections.map((s) => `
    <h3>${esc(s.heading)}</h3>
    <table><thead><tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${s.rows.map((r, i) => s.groupRows?.has(i)
      ? `<tr class="grp"><td colspan="${s.columns.length}">${esc(r[0])}</td></tr>`
      : `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>body{font:12px Arial,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 8px}h3{font-size:13px;margin:18px 0 6px}
    .meta{display:flex;flex-wrap:wrap;gap:6px 24px;margin-bottom:8px}table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}th{background:#eef2f7}tr.grp td{background:#f5f7fb;font-weight:bold}
    @media print{button{display:none}}</style></head><body>
    <h1>${esc(title)}</h1><div class="meta">${meta.map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>
    ${body}<script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}

/** Rows for a printed table, with a job heading row before each job's bundles. */
export function printRowsByJob<T extends Partial<BundleInfo>>(rows: T[], cells: (r: T) => unknown[]) {
  const out: unknown[][] = [];
  const groupRows = new Set<number>();
  for (const g of groupByJob(rows)) {
    groupRows.add(out.length);
    out.push([`Job ${g.io_no} · Style ${g.style_no}${g.buyer ? ` · ${g.buyer}` : ''}${g.po_no ? ` · PO ${g.po_no}` : ''}`]);
    for (const r of g.rows) out.push(cells(r));
  }
  return { rows: out, groupRows };
}
