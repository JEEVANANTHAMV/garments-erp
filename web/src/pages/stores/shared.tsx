import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, PackageSearch, Ban } from 'lucide-react';
import { http } from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { Modal, FormSection, Input, Select, Textarea, Button, SearchInput, useDebounced, LoadingBlock, StatusBadge } from '../../components/ui';
import { fmtDate, fmtDecimal } from '../../lib/format';

/** Stores transactions (client tracker 14-Oct-2026): shared bits for the stores pages. */
export type Mat = 'YARN' | 'FABRIC' | 'TRIM' | 'GENERAL';
export const MAT_OPTIONS = [{ value: 'YARN', label: 'Yarn' }, { value: 'FABRIC', label: 'Fabric (rolls, KG)' }, { value: 'TRIM', label: 'Trims / accessories' }, { value: 'GENERAL', label: 'General items' }];
export const num = (v: unknown) => Number(v ?? 0) || 0;
export const qtyFmt = (v: unknown) => fmtDecimal(v, 3);
export const today = () => new Date().toISOString().slice(0, 10);
export const monthStart = () => today().slice(0, 8) + '01';
export const errMsg = (e: unknown) => (e as any)?.message ?? 'Something went wrong';

export interface StockRow {
  source_ref: string; material_type: Mat; warehouse_id: number; warehouse_name?: string; yarn_id?: number; fabric_id?: number; trim_id?: number;
  item_name: string; item_code?: string; item_type?: string; color_name?: string | null; sizes?: string | null; lot_no?: string | null; grn_no?: string | null;
  so_id?: number | null; job_no?: string | null; style_id?: number | null; uom_id: number; uom_code?: string; stock_qty: number; rate: number;
}

/** POST an action and refresh the lists; toasts the server message. */
export function useAction(keys: string[] = ['stores']) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ url, body, method = 'post' }: { url: string; body?: unknown; method?: 'post' | 'put' }) =>
      (method === 'put' ? http.put<any>(url, body) : http.post<any>(url, body)),
    onSuccess: (r) => { if (r?.message) toast(r.message); keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
    onError: (e) => toast(errMsg(e), 'error'),
  });
}

export function useStoresList<T = any>(path: string, params: Record<string, unknown>) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null && v !== false).map(([k, v]) => [k, String(v)])).toString();
  return useQuery({ queryKey: ['stores', path, qs], queryFn: async () => (await http.get<{ data: T[] }>(`/stores/${path}${qs ? `?${qs}` : ''}`)).data });
}

export function useStoresDoc<T = any>(path: string, id: number | null) {
  return useQuery({ queryKey: ['stores', path, 'doc', id], enabled: !!id, queryFn: async () => (await http.get<{ data: T }>(`/stores/${path}/${id}`)).data });
}

/** Date range + search + optional status filter bar. */
export function FilterBar({ f, setF, statuses, children }: {
  f: { from: string; to: string; q: string; status?: string }; setF: (f: any) => void; statuses?: string[]; children?: ReactNode;
}) {
  return (
    <div className="card mb-3 flex flex-wrap items-end gap-3 p-4">
      <Input label="From" type="date" className="w-40" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
      <Input label="To" type="date" className="w-40" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
      {statuses && <Select label="Status" className="w-44" value={f.status ?? ''} placeholder="All" onChange={(e) => setF({ ...f, status: e.target.value })}
        options={statuses.map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) }))} />}
      {children}
      <SearchInput className="min-w-[220px] flex-1" value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Search doc no, party, item…" />
    </div>
  );
}

export interface Col { key: string; label: string; kind?: 'date' | 'qty' | 'money' | 'status' | 'bool'; render?: (r: any) => ReactNode }

const cell = (c: Col, r: any): ReactNode => {
  if (c.render) return c.render(r);
  const v = r[c.key];
  if (c.kind === 'date') return v ? fmtDate(v) : '—';
  if (c.kind === 'qty') return v === null || v === undefined ? '—' : qtyFmt(v);
  if (c.kind === 'money') return v === null || v === undefined ? '—' : fmtDecimal(v, 2);
  if (c.kind === 'status') return <StatusBadge value={v} />;
  if (c.kind === 'bool') return v === null || v === undefined ? '—' : Number(v) ? 'Yes' : 'No';
  return v === null || v === undefined || v === '' ? '—' : String(v);
};
const csvVal = (c: Col, r: any) => {
  const v = r[c.key];
  if (c.kind === 'date') return v ? fmtDate(v) : '';
  if (c.kind === 'bool') return v === null || v === undefined ? '' : Number(v) ? 'Yes' : 'No';
  return v ?? '';
};

export function downloadCsv(name: string, cols: Col[], rows: any[]) {
  const lines = [cols.map((c) => c.label).join(','), ...rows.map((r) => cols.map((c) => `"${String(csvVal(c, r)).replace(/"/g, '""')}"`).join(','))];
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `${name}.csv`; a.click();
}

/** Plain table for registers and reports. */
export function SimpleTable({ cols, rows, loading, onRow, empty = 'Nothing here for the selected period', footer }: {
  cols: Col[]; rows: any[]; loading?: boolean; onRow?: (r: any) => void; empty?: string; footer?: ReactNode;
}) {
  if (loading) return <div className="card"><LoadingBlock /></div>;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500">
          <tr>{cols.map((c) => <th key={c.key} className={`whitespace-nowrap px-3 py-2 ${c.kind === 'qty' || c.kind === 'money' ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} onClick={onRow ? () => onRow(r) : undefined} className={`border-t border-slate-100 ${onRow ? 'cursor-pointer hover:bg-slate-50' : ''}`}>
              {cols.map((c) => <td key={c.key} className={`whitespace-nowrap px-3 py-1.5 ${c.kind === 'qty' || c.kind === 'money' ? 'text-right tabular-nums' : ''}`}>{cell(c, r)}</td>)}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={cols.length} className="px-3 py-10 text-center text-slate-400">{empty}</td></tr>}
        </tbody>
        {footer}
      </table>
    </div>
  );
}

/** A report sheet (client's Excel columns): date range + search + CSV. */
export function ReportView({ path, cols, title, extra, extraParams }: { path: string; cols: Col[]; title: string; extra?: ReactNode; extraParams?: Record<string, unknown> }) {
  const [f, setF] = useState({ from: monthStart(), to: today(), q: '' });
  const q = useDebounced(f.q);
  const list = useStoresList(`reports/${path}`, { from: f.from, to: f.to, q, ...extraParams });
  const rows = list.data ?? [];
  return (
    <>
      <FilterBar f={f} setF={setF}>
        {extra}
        <Button variant="secondary" disabled={!rows.length} onClick={() => downloadCsv(`${title} ${f.from} to ${f.to}`, cols, rows)}><Download size={14} className="mr-1 inline" /> Excel (CSV)</Button>
      </FilterBar>
      <SimpleTable cols={cols} rows={rows} loading={list.isLoading} />
    </>
  );
}

/** Asks for a reason (cancel / reject / close) — documents are never deleted. */
export function ReasonModal({ title, subtitle, confirm = 'Cancel document', onClose, onConfirm, busy }: {
  title: string; subtitle?: string; confirm?: string; onClose: () => void; onConfirm: (reason: string) => void; busy?: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal open onClose={onClose} title={title} subtitle={subtitle} icon={<Ban size={16} />} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Back</Button>
        <Button variant="danger" id="reason-confirm" disabled={reason.trim().length < 3} loading={busy} onClick={() => onConfirm(reason.trim())}>{confirm}</Button>
      </>}>
      <Textarea label="Reason" required rows={3} id="reason-text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? (kept on the document and in the audit trail)" />
    </Modal>
  );
}

/** Pick stock lots / rolls / trim lots / general items of one location. */
export function StockPicker({ material, warehouseId, onClose, onPick, exclude = [], allowTypeChange = false }: {
  material: Mat; warehouseId: number; onClose: () => void; onPick: (rows: StockRow[]) => void; exclude?: string[]; allowTypeChange?: boolean;
}) {
  const [mt, setMt] = useState<Mat>(material);
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [sel, setSel] = useState<Record<string, StockRow>>({});
  const list = useQuery({
    queryKey: ['stores', 'stock-items', mt, warehouseId, q],
    queryFn: async () => (await http.get<{ data: StockRow[] }>(`/stores/stock-items?material_type=${mt}&warehouse_id=${warehouseId}${q ? `&q=${encodeURIComponent(q)}` : ''}`)).data,
  });
  const rows = (list.data ?? []).filter((r) => !exclude.includes(r.source_ref));
  const picked = Object.values(sel);
  return (
    <Modal open onClose={onClose} title="Pick from stock" subtitle="Stock on hand at the selected location, per lot / roll / item" icon={<PackageSearch size={16} />} size="xl"
      footerStart={<>{picked.length} selected</>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="picker-add" disabled={!picked.length} onClick={() => onPick(picked)}>Add {picked.length || ''} item{picked.length === 1 ? '' : 's'}</Button>
      </>}>
      <FormSection cols={allowTypeChange ? 2 : 1}>
        {allowTypeChange && <Select label="Material" value={mt} onChange={(e) => { setMt(e.target.value as Mat); setSel({}); }} options={MAT_OPTIONS} />}
        <SearchInput value={search} onChange={setSearch} placeholder="Search item, lot, roll, colour…" />
      </FormSection>
      {list.isLoading ? <LoadingBlock /> : (
        <div className="max-h-[55vh] overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr>
              <th className="w-8 px-2 py-2" /><th className="px-2 py-2 text-left">Item</th><th className="px-2 py-2 text-left">Lot / roll</th><th className="px-2 py-2 text-left">Colour</th>
              <th className="px-2 py-2 text-left">GRN</th><th className="px-2 py-2 text-left">Job</th><th className="px-2 py-2 text-right">Stock</th><th className="px-2 py-2 text-left">UOM</th><th className="px-2 py-2 text-right">Rate</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.source_ref} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 stock-pick-row"
                  onClick={() => setSel((s) => { const n = { ...s }; if (n[r.source_ref]) delete n[r.source_ref]; else n[r.source_ref] = r; return n; })}>
                  <td className="px-2 py-1.5"><input type="checkbox" readOnly checked={!!sel[r.source_ref]} className="h-4 w-4" /></td>
                  <td className="px-2 py-1.5 font-medium">{r.item_name}</td><td className="px-2 py-1.5">{r.lot_no || '—'}</td><td className="px-2 py-1.5">{r.color_name || '—'}</td>
                  <td className="px-2 py-1.5">{r.grn_no || '—'}</td><td className="px-2 py-1.5">{r.job_no || 'General'}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{qtyFmt(r.stock_qty)}</td><td className="px-2 py-1.5">{r.uom_code}</td><td className="px-2 py-1.5 text-right tabular-nums">{fmtDecimal(r.rate, 2)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">No stock of this kind at this location</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/** Small read-only label / value grid for view popups. */
export function InfoGrid({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-body sm:grid-cols-4">
      {items.map(([k, v]) => <div key={k}><dt className="text-caption uppercase tracking-wider text-slate-400">{k}</dt><dd className="font-medium text-slate-800">{v ?? '—'}</dd></div>)}
    </dl>
  );
}

export const TH = 'whitespace-nowrap px-2 py-2';
export const TD = 'px-2 py-1';
export const tableHead = 'text-small font-semibold uppercase tracking-wider text-slate-500';
