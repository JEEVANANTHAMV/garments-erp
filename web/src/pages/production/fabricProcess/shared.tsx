import type { ReactNode } from 'react';
import { barcodeHtml } from '../../../lib/printBarcode';
import { useQuery } from '@tanstack/react-query';
import { http, ApiError } from '../../../lib/api';
import { fmtDecimal } from '../../../lib/format';

/** Shared bits of the Fabric Process screens (outward DC, inward GRN, return, reprocess, bill, tracking, ledger). */
export const n = (v: unknown) => Number(v ?? 0) || 0;
export const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const kg = (v: unknown) => fmtDecimal(n(v), 3);
export const errText = (e: unknown) => {
  if (e instanceof ApiError) {
    const det = Array.isArray(e.details) ? (e.details as any[]).map((d) => `${d.field}: ${d.message}`).join('; ') : '';
    return `${e.message}${det ? ` — ${det}` : ''}`;
  }
  return (e as any)?.message || 'Failed';
};
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export interface ProcessType { id: number; code: string; name: string; output_state: string; changes_colour: number; is_reprocess: number; allow_split: number; requires_qc?: number }
export interface Reason { id: number; code: string; reason: string; kind: string; default_billing: string | null }
export interface Job { id: number; job_no: string; buyer_name?: string; buyer_po_no?: string; styles: { style_id: number; style_code: string; style_name: string }[] }
export interface StoreRoll {
  id: number; roll_no: string; lot_no: string | null; fabric_id: number; fabric_name: string; weight_kg: number; meters: number; balance_kg: number;
  gsm: number | null; dia: string | null; color_name: string | null; process_state: string; warehouse_id: number; warehouse_name: string | null;
  grn_no: string; so_id: number | null; io_no: string | null; buyer_po_no: string | null; style_code: string | null;
}

export function useProcessTypes() {
  return useQuery({ queryKey: ['fabric-process', 'types'], queryFn: async () => (await http.get<{ data: ProcessType[] }>('/fabric-process/types')).data ?? [], staleTime: 300_000 });
}
export function useReasons() {
  return useQuery({ queryKey: ['fabric-process', 'reasons'], queryFn: async () => (await http.get<{ data: Reason[] }>('/fabric-process/reasons')).data ?? [], staleTime: 300_000 });
}
export function useJobs() {
  return useQuery({ queryKey: ['procurement-jobs'], queryFn: async () => (await http.get<{ data: Job[] }>('/procurement/jobs')).data ?? [], staleTime: 60_000 });
}

/** Status chip with the document's wording (Draft / Confirmed / Partially received …). */
const STATUS_LABEL: Record<string, [string, string]> = {
  DRAFT: ['Draft', 'bg-slate-100 text-slate-700'], DISPATCHED: ['Confirmed', 'bg-sky-100 text-sky-800'], IN_PROCESS: ['In process', 'bg-amber-100 text-amber-800'],
  PARTIALLY_RECEIVED: ['Partially received', 'bg-amber-100 text-amber-800'], COMPLETED: ['Fully received', 'bg-emerald-100 text-emerald-800'],
  CLOSED: ['Closed', 'bg-slate-200 text-slate-700'], CANCELLED: ['Cancelled', 'bg-red-100 text-red-700'], POSTED: ['Posted', 'bg-emerald-100 text-emerald-800'],
  CONFIRMED: ['Confirmed', 'bg-sky-100 text-sky-800'], SENT_TO_REPROCESS: ['Sent to reprocess', 'bg-purple-100 text-purple-800'],
  PENDING: ['Pending', 'bg-amber-100 text-amber-800'], APPROVED: ['Approved', 'bg-emerald-100 text-emerald-800'], BILLED: ['Billed', 'bg-indigo-100 text-indigo-800'],
  EXCLUDED: ['Excluded', 'bg-slate-100 text-slate-600'], REVERSED: ['Reversed', 'bg-red-100 text-red-700'], PARTIAL: ['Partial', 'bg-amber-100 text-amber-800'],
  AT_VENDOR: ['At vendor', 'bg-sky-100 text-sky-800'], RECEIVED: ['Received', 'bg-emerald-100 text-emerald-800'],
  QC_PENDING: ['QC pending', 'bg-orange-100 text-orange-800'], ACCEPTED: ['QC accepted', 'bg-teal-100 text-teal-800'], REJECTED: ['QC rejected', 'bg-red-100 text-red-700'],
  HOLD: ['Hold', 'bg-orange-100 text-orange-800'],
  INWARD_PENDING: ['Inward pending', 'bg-amber-100 text-amber-800'], AT_UNIT: ['At unit', 'bg-sky-100 text-sky-800'], ISSUED: ['Issued', 'bg-sky-100 text-sky-800'],
};
export function FpStatus({ value }: { value: string }) {
  const [label, cls] = STATUS_LABEL[value] ?? [value, 'bg-slate-100 text-slate-700'];
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>;
}

/** Numbered page title like the reference screens. */
export function FpTitle({ no, title, sub, actions }: { no: number; title: string; sub?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 text-lg font-bold text-white">{no}</span>
        <div>
          <h1 className="text-lg font-bold text-slate-900">{title}</h1>
          {sub && <p className="text-[12px] text-slate-500">{sub}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/** Outward / Good / Reject / Loss / Balance cards (doc §6 summary). */
export function ReconCards({ t }: { t: { outward_kg: number; good_kg: number; reject_kg: number; loss_kg: number; balance_kg: number } }) {
  const cards: [string, number, string][] = [
    ['Outward', t.outward_kg, 'bg-sky-50 border-sky-200 text-sky-900'], ['Good', t.good_kg, 'bg-emerald-50 border-emerald-200 text-emerald-900'],
    ['Reject', t.reject_kg, 'bg-red-50 border-red-200 text-red-900'], ['Process loss', t.loss_kg, 'bg-amber-50 border-amber-200 text-amber-900'],
    ['Balance', t.balance_kg, t.balance_kg > 0.0005 ? 'bg-orange-50 border-orange-300 text-orange-900' : 'bg-slate-50 border-slate-200 text-slate-700'],
  ];
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      {cards.map(([k, v, cls]) => (
        <div key={k} className={`rounded-lg border px-3 py-2 ${cls}`}>
          <div className="text-[10.5px] font-semibold uppercase tracking-wider opacity-75">{k} (KG)</div>
          <div className="text-lg font-bold tabular-nums">{kg(v)}</div>
        </div>
      ))}
    </div>
  );
}

/** Opens a print window with a plain challan / GRN layout. */
export function printDoc(title: string, headHtml: string, bodyHtml: string) {
  const w = window.open('', '_blank', 'width=1000,height=1000');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font:12px Arial,Helvetica,sans-serif;margin:22px;color:#111}h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;margin:12px 0 4px}
    table{width:100%;border-collapse:collapse;margin-top:6px}th,td{border:1px solid #888;padding:4px 6px;text-align:left}th{background:#eee}
    .r{text-align:right}.grp td{background:#e8f0f7;font-weight:bold}.sub td{background:#f6f6f6;font-weight:bold}.meta td{border:none;padding:2px 6px}
    .sign{display:flex;justify-content:space-between;margin-top:48px}.sign div{border-top:1px solid #000;width:30%;text-align:center;padding-top:4px}
    @media print{button{display:none}}</style></head><body>${barcodeHtml(title)}${headHtml}${bodyHtml}
    <div class="sign"><div>Prepared by</div><div>Security / Checked</div><div>Receiver's signature</div></div>
    <script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}

/** Groups rows by job (io_no) keeping order — DC / GRN grids show a job heading + subtotal. */
export function groupByJob<T extends { io_no?: string | null }>(rows: T[]) {
  const out: { io_no: string; rows: T[] }[] = [];
  for (const r of rows) {
    const k = r.io_no || 'STOCK';
    let g = out.find((x) => x.io_no === k);
    if (!g) { g = { io_no: k, rows: [] }; out.push(g); }
    g.rows.push(r);
  }
  return out;
}

/** Dyeing (and re-dyeing) DCs / GRNs show the issued colour + the dye colour; other processes keep the colour as is. */
export const isDyeing = (code: unknown) => /DYE/i.test(String(code ?? ''));

/** Dye colour from the process quotation: the job's own line first, else the picked rate line, else any line with a colour. */
export function quoteColour(q: any | null, lineId: string, ioNo?: string | null): string {
  const ls: any[] = (q?.lines ?? []).filter((l: any) => l.color_name);
  const norm = (x: unknown) => String(x ?? '').trim().toUpperCase();
  return (ls.find((l) => ioNo && norm(l.job_no) === norm(ioNo)) ?? ls.find((l) => String(l.id) === lineId) ?? ls[0])?.color_name ?? '';
}
