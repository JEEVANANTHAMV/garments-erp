import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

/** Embroidery / printing machine output & costing — shared bits of the screens (one engine, two processes). */
export type Kind = 'EMBROIDERY' | 'PRINTING';
export const BASE: Record<Kind, string> = { EMBROIDERY: '/embroidery', PRINTING: '/printing' };
export const LABEL: Record<Kind, string> = { EMBROIDERY: 'Embroidery', PRINTING: 'Printing' };
export const MACHINE_TYPES: Record<Kind, string[]> = {
  EMBROIDERY: ['SINGLE_HEAD', 'MULTI_HEAD', 'COMPUTERIZED', 'MANUAL'],
  PRINTING: ['FLAT_BED', 'ROTARY', 'AUTOMATIC', 'MANUAL', 'DIGITAL'],
};
export const ROLES: Record<Kind, string[]> = {
  EMBROIDERY: ['THREAD', 'BOBBIN', 'BACKING', 'TOPPING', 'ADHESIVE', 'OTHER'],
  PRINTING: ['DYE', 'PIGMENT', 'CHEMICAL', 'BINDER', 'INK', 'OTHER'],
};
export const PRINT_TYPES = ['PIGMENT', 'REACTIVE', 'DISCHARGE', 'DIGITAL', 'SCREEN', 'ROTARY', 'SUBLIMATION', 'RUBBER', 'PUFF', 'FOIL', 'OTHER'];

export const errMsg = (e: any) => e?.message || 'Request failed';
export const num = (v: unknown) => Number(v ?? 0) || 0;
export const human = (s: unknown) => String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const money = (v: unknown) => (v == null || v === '' ? '—' : `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
export const qty = (v: unknown, dp = 2) => (v == null || v === '' ? '—' : num(v).toLocaleString('en-IN', { maximumFractionDigits: dp }));
export const pctTxt = (v: unknown) => (v == null || v === '' ? '—' : `${num(v).toFixed(2)}%`);
export const ST_TONE: Record<string, string> = {
  DRAFT: 'slate', PLANNED: 'blue', RUNNING: 'amber', COMPLETED: 'green', CANCELLED: 'red',
  SUBMITTED: 'violet', APPROVED: 'green', REJECTED: 'red', OBSOLETE: 'gray', POSTED: 'green',
};

/** What the signed-in user may do on this process (doc §27 / §25 role split). */
export function usePerm(kind: Kind) {
  const { can } = useAuth();
  const c = (v: string) => can(`${kind}.${v}`);
  return {
    view: c('VIEW'), create: c('CREATE'), submit: c('SUBMIT'), approve: c('APPROVE'), store: c('STORE'), master: c('MASTER'),
    costing: c('COSTING') || c('APPROVE') || c('SUBMIT') || c('MASTER'),
  };
}

/** GET a list / record and reload on demand. */
export function useGet<T = any>(path: string | null, params?: Record<string, unknown>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(params ?? {});
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { const r = await api.get(path, { params }); setData(r.data.data); setError(null); } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, loading, error, reload, setData };
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-2">
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">{title}</h4>
        {actions}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

export function Kv({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className={strong ? 'font-bold text-slate-900' : 'font-medium text-slate-800'}>{value ?? '—'}</span>
    </div>
  );
}

/** Small table used inside detail panels. */
export function MiniTable({ cols, rows, empty = 'Nothing yet' }: {
  cols: { h: string; r: (row: any) => ReactNode; right?: boolean }[]; rows: any[]; empty?: string;
}) {
  if (!rows.length) return <p className="py-2 text-xs text-slate-400">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr>{cols.map((c) => <th key={c.h} className={`px-2 py-1 font-semibold ${c.right ? 'text-right' : 'text-left'}`}>{c.h}</th>)}</tr></thead>
        <tbody>{rows.map((row, i) => (
          <tr key={row.id ?? i} className="border-t border-slate-100">{cols.map((c) => <td key={c.h} className={`px-2 py-1 ${c.right ? 'text-right tabular-nums' : ''}`}>{c.r(row)}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** Reads a file into a data URI and stores it with POST /uploads (folder "designs"). */
export async function uploadFile(file: File) {
  const data = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error('Could not read the file'));
    fr.readAsDataURL(file);
  });
  // DST / DSB / EMB have no browser mime type — send them as octet-stream.
  const uri = data.startsWith('data:;base64,') ? data.replace('data:;base64,', 'data:application/octet-stream;base64,') : data;
  const r = await api.post('/uploads', { filename: file.name, data: uri, folder: 'designs' });
  return r.data.data as { url: string; originalName: string };
}

export function toCsv(rows: any[], cols: { key: string; label: string }[]) {
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\n');
}
export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
