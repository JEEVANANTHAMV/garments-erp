import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, Button, Modal, SearchInput, StatusBadge, useDebounced } from '../../components/ui';
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

export type Proc = 'sewing' | 'checking';
export const PROC_LABEL: Record<Proc, string> = { sewing: 'Sewing', checking: 'Checking' };

export const n = (v: unknown) => Number(v ?? 0) || 0;
export const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

export interface BundleInfo {
  bundle_id: number; bundle_no: string; barcode?: string | null;
  io_no?: string | null; job_no?: string | null; po_no?: string | null; buyer?: string | null;
  style_id?: number | null; style_no?: string | null; style_description?: string | null;
  colour_id?: number | null; colour?: string | null; size_id?: number | null; size?: string | null; size_sort?: number;
  lay_no?: string | null; cut_no?: string | null; part_name?: string | null;
  bundle_qty: number; weight_kg?: number | null; inward_date?: string | null;
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          {onToggle && (
            <button type="button" onClick={onToggle} className="text-brand-700">
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          {onCheck && <input type="checkbox" checked={!!checked} onChange={onCheck} />}
          <span>Job / IO: <b className="font-mono text-brand-800">{group.io_no}</b></span>
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
        <p className="text-[11px] font-medium opacity-80">{label}</p>
        <p className="text-xl font-bold leading-tight">{value}</p>
        {sub && <p className="text-[10px] opacity-75">{sub}</p>}
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
      <span className={`text-[11px] font-medium ${value > 100 ? 'text-red-600' : ''}`}>{value}%</span>
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
    <Modal open={open} onClose={onClose} title={title} size="lg">
      <SearchInput value={search} onChange={setSearch} placeholder="Search document no…" className="mb-3 w-full" />
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
              <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">{r[noKey]}</td>
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
    </Modal>
  );
}

export function DocStatus({ no, status }: { no?: string | null; status?: string | null }) {
  if (!no) return <Badge tone="blue">New document</Badge>;
  return <span className="flex items-center gap-2 text-xs"><span className="font-mono font-semibold text-brand-700">{no}</span><StatusBadge value={status} /></span>;
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
