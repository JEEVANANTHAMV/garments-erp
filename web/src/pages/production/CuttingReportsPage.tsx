import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Filter, RefreshCw, Scissors, X } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';
import {
  PageHeader, LoadingBlock, EmptyState, ErrorState, Badge, Input, Select, Pager,
} from '../../components/ui';

/**
 * Cutting → shipment fabric reports (traceability document §22).
 *
 * The server returns column metadata (label, type, UOM, drill-down kind) with
 * every report, so this page is a generic viewer: pick a report, set filters,
 * read the table with its totals row, drill into bundles / rolls, export CSV.
 */

type ColType = 'text' | 'date' | 'datetime' | 'int' | 'kg' | 'kgpc' | 'pct' | 'days';
interface Col { key: string; label: string; type?: ColType; uom?: string; sum?: boolean; link?: 'bundle' | 'roll' | 'lot' }
interface ReportResponse {
  columns: Col[];
  data: any[];
  totals: Record<string, number | null>;
  notes: string[];
  meta: { page: number; page_size: number; total: number; truncated: boolean; max_rows: number };
}

type FilterKey = 'dates' | 'io_no' | 'style' | 'cut_order' | 'fabric' | 'lot_no' | 'roll_no' | 'status'
  | 'bundle' | 'shipment' | 'exceptions_only';

interface ReportDef { key: string; label: string; group: string; hint: string; filters: FilterKey[]; statuses: string[] }

const PLAN_STATUSES = ['DRAFT', 'APPROVED', 'RELEASED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'CLOSED', 'CANCELLED'];
const LAY_STATUSES = ['PLANNED', 'SPREAD', 'CUT', 'APPROVED', 'CANCELLED'];
const BUNDLE_STATUSES = ['GENERATED', 'CHECKED', 'ISSUED', 'IN_SEWING', 'COMPLETED', 'FINISHING', 'PACKED', 'SHIPPED', 'SPLIT', 'CLOSED', 'CANCELLED'];
const BASE: FilterKey[] = ['dates', 'io_no', 'style', 'cut_order', 'fabric', 'lot_no', 'roll_no', 'status'];

const REPORTS: ReportDef[] = [
  { key: 'fabric-dc-vs-consumption', label: 'Fabric DC vs Actual Consumption', group: 'Fabric',
    hint: 'Per cut order: issued, returned, consumed in lays, losses by type and the unaccounted balance',
    filters: BASE, statuses: PLAN_STATUSES },
  { key: 'roll-utilization', label: 'Roll-wise Fabric Utilization', group: 'Fabric',
    hint: 'Each roll: received, issued, consumed in lays, returned and utilisation %',
    filters: BASE, statuses: ['OPEN', 'PARTIALLY_USED', 'CLOSED'] },
  { key: 'wastage-remnant', label: 'Cutting Wastage & Remnant', group: 'Fabric',
    hint: 'Cutting waste, end loss, selvedge, remnant and other loss as a share of issued fabric',
    filters: BASE, statuses: PLAN_STATUSES },
  { key: 'unaccounted-fabric', label: 'Unaccounted Fabric', group: 'Fabric',
    hint: 'Cut orders whose unaccounted fabric exceeds the reconciliation tolerance',
    filters: [...BASE, 'exceptions_only'], statuses: PLAN_STATUSES },
  { key: 'cut-order-status', label: 'Cut Order Status', group: 'Cutting',
    hint: 'Order, planned and actual cut quantity, balance and % complete',
    filters: BASE, statuses: PLAN_STATUSES },
  { key: 'lay-consumption', label: 'Lay-wise Consumption', group: 'Cutting',
    hint: 'Each lay: rolls, before / after weight, consumed, pieces and KG per piece vs plan',
    filters: BASE, statuses: LAY_STATUSES },
  { key: 'recut-reject', label: 'Re-cut / Reject', group: 'Cutting',
    hint: 'Rejected and re-cut pieces from cut output and cut-piece QC',
    filters: BASE, statuses: ['OPEN', 'COMPLETED', 'APPROVED', 'CONDITIONAL', 'REJECTED'] },
  { key: 'marker-consumption', label: 'Marker Consumption', group: 'Consumption',
    hint: 'Each marker version: CAD KG/PC against the actual KG/PC of the lays that used it',
    filters: BASE, statuses: ['LOCKED', 'OPEN'] },
  { key: 'style-color-size-consumption', label: 'Style / Color / Size Consumption', group: 'Consumption',
    hint: 'Good pieces, actual KG and KG per piece by size, against the approved size consumption',
    filters: BASE, statuses: ['OPEN', 'COMPLETED', 'REVERSED'] },
  { key: 'planned-vs-actual', label: 'Planned vs Actual Variance', group: 'Consumption',
    hint: 'Costing, BOM, marker and cutting-actual KG/PC side by side with the variance',
    filters: BASE, statuses: PLAN_STATUSES },
  { key: 'bundle-traceability', label: 'Bundle Traceability', group: 'Traceability',
    hint: 'Bundle → cut output → lay → marker → rolls / lots, with cartons and shipments',
    filters: [...BASE, 'bundle'], statuses: BUNDLE_STATUSES },
  { key: 'bundle-aging', label: 'Bundle Status / Aging', group: 'Traceability',
    hint: 'Open bundles by status with days since creation and since the last movement',
    filters: [...BASE, 'bundle'], statuses: BUNDLE_STATUSES },
  { key: 'lot-to-shipment', label: 'Fabric Lot → Shipment', group: 'Traceability',
    hint: 'Forward trace: each fabric lot to lays, bundles, cartons and shipments',
    filters: BASE, statuses: LAY_STATUSES },
  { key: 'shipment-to-roll', label: 'Shipment → Fabric Roll', group: 'Traceability',
    hint: 'Reverse trace: each shipment back to the rolls and lots its pieces were cut from',
    filters: [...BASE, 'shipment'], statuses: ['BOOKED', 'GATED_IN', 'LOADED', 'SAILED', 'TRANSIT', 'ARRIVED', 'DELIVERED'] },
];
const GROUPS = ['Fabric', 'Cutting', 'Consumption', 'Traceability'];

type Filters = Partial<Record<Exclude<FilterKey, 'dates'> | 'from_date' | 'to_date', string>>;
const EMPTY: Filters = {};

const isNumeric = (t?: ColType) => !!t && t !== 'text' && t !== 'date' && t !== 'datetime';

function fmtValue(c: Col, v: any): string {
  if (v == null || v === '') return '';
  switch (c.type) {
    case 'date': return fmtDate(v);
    case 'datetime': return fmtDateTime(v);
    case 'int': case 'days': return Number(v).toLocaleString('en-IN');
    case 'kg': return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    case 'kgpc': return Number(v).toFixed(4);
    case 'pct': return `${Number(v).toFixed(2)}`;
    default: return String(v);
  }
}

const header = (c: Col) => (c.uom ? `${c.label} (${c.uom})` : c.label);

export default function CuttingReportsPage() {
  const [active, setActive] = useState<ReportDef>(REPORTS[0]);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const pageSize = 100;

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(applied)) if (v) p[k] = v;
    return p;
  }, [applied]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['cutting-report', active.key, params, page],
    queryFn: () => http.get<ReportResponse>(`/cutting-reports/${active.key}`,
      { ...params, page, page_size: pageSize }),
  });

  const pick = (r: ReportDef) => {
    setActive(r);
    setPage(1);
    // Keep filters that the new report understands; drop the rest.
    const keep = (f: Filters) => Object.fromEntries(Object.entries(f).filter(([k]) =>
      r.filters.includes(k as FilterKey) || ((k === 'from_date' || k === 'to_date') && r.filters.includes('dates'))
      ).filter(([k, v]) => k !== 'status' || r.statuses.includes(String(v)))) as Filters;
    setDraft(keep(draft));
    setApplied(keep(applied));
  };
  const apply = () => { setApplied(draft); setPage(1); };
  const clear = () => { setDraft(EMPTY); setApplied(EMPTY); setPage(1); };
  const set = (k: keyof Filters, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  /** Lot drill-down stays in this page: roll-wise utilisation filtered to the lot. */
  const drillLot = (lot: string) => {
    const r = REPORTS.find((x) => x.key === 'roll-utilization')!;
    setActive(r); setPage(1);
    setDraft({ lot_no: lot }); setApplied({ lot_no: lot });
  };

  const columns = data?.columns ?? [];
  const rows = data?.data ?? [];
  const totals = data?.totals ?? {};
  const hasTotals = columns.some((c) => totals[c.key] != null);

  /** Export every filtered row (all pages), not just the page on screen. */
  const exportCsv = async () => {
    if (!data?.meta.total) return;
    setExporting(true);
    try {
      const all: any[] = [];
      const size = 1000;
      for (let p = 1; p <= Math.ceil(data.meta.total / size); p++) {
        const res = await http.get<ReportResponse>(`/cutting-reports/${active.key}`, { ...params, page: p, page_size: size });
        all.push(...res.data);
      }
      const esc = (v: any) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [
        columns.map((c) => esc(header(c))).join(','),
        ...all.map((r) => columns.map((c) => esc(r[c.key])).join(',')),
      ];
      if (hasTotals) lines.push(columns.map((c, i) => esc(i === 0 ? 'TOTAL' : totals[c.key] ?? '')).join(','));
      const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${active.key}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  function renderCell(c: Col, v: any) {
    if (v == null || v === '') return <span className="text-slate-300">—</span>;
    if (c.link) {
      const parts = String(v).split(', ').filter(Boolean);
      return (
        <span className="flex flex-wrap gap-x-1.5">
          {parts.map((p, i) => (
            <Fragment key={p}>
              {c.link === 'lot'
                ? <button type="button" className="text-brand-700 hover:underline" onClick={() => drillLot(p)}
                    title="Show rolls of this lot">{p}</button>
                : <Link className="text-brand-700 hover:underline"
                    to={`/production/traceability?${c.link}=${encodeURIComponent(p)}`}
                    title={`Trace this ${c.link}`}>{p}</Link>}
              {i < parts.length - 1 && <span className="text-slate-300">,</span>}
            </Fragment>
          ))}
        </span>
      );
    }
    if (c.key === 'status' || c.key.endsWith('_status') || c.key === 'breach') {
      const s = String(v);
      const tone = /COMPLETED|CLOSED|APPROVED|WITHIN|SHIPPED|DELIVERED|PACKED/i.test(s) ? 'emerald'
        : /CANCEL|REJECT|OVER|REVERSED/i.test(s) ? 'rose'
        : /PROGRESS|PENDING|DRAFT|OPEN|PARTIAL|CONDITIONAL/i.test(s) ? 'amber' : 'slate';
      return <Badge tone={tone}>{s.replace(/_/g, ' ')}</Badge>;
    }
    const txt = fmtValue(c, v);
    if ((c.key.startsWith('variance') || c.key === 'unaccounted_kg') && Number(v) !== 0) {
      return <span className={Number(v) > 0 ? 'text-rose-600' : 'text-emerald-700'}>{txt}</span>;
    }
    return txt;
  }

  const statusOpts = active.statuses.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }));
  const has = (k: FilterKey) => active.filters.includes(k);
  const activeCount = Object.values(applied).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cutting Reports"
        subtitle="Fabric DC, lay consumption, wastage, variance and bundle-to-shipment traceability"
        actions={
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => void refetch()} id="btn-cr-refresh">
              <RefreshCw size={14} /> Refresh
            </button>
            <button className="btn-primary" onClick={() => void exportCsv()}
              disabled={!data?.meta.total || exporting} id="btn-cr-export">
              <Download size={14} /> {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
        {/* Report picker */}
        <div className="card space-y-3 p-3 lg:self-start">
          {GROUPS.map((g) => (
            <div key={g}>
              <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{g}</p>
              <div className="space-y-0.5">
                {REPORTS.filter((r) => r.group === g).map((r) => (
                  <button key={r.key} id={`cr-${r.key}`}
                    className={`block w-full rounded px-2 py-1.5 text-left text-[12px] transition ${
                      active.key === r.key ? 'bg-brand-50 font-semibold text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
                    onClick={() => pick(r)}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="min-w-0 space-y-3">
          {/* Filters */}
          <div className="card p-3">
            <h3 className="text-[13px] font-bold text-slate-800">{active.label}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">{active.hint}</p>
            <form className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5"
              onSubmit={(e) => { e.preventDefault(); apply(); }}>
              {has('dates') && <>
                <Input label="From" type="date" value={draft.from_date ?? ''} onChange={(e) => set('from_date', e.target.value)} id="cr-from" />
                <Input label="To" type="date" value={draft.to_date ?? ''} onChange={(e) => set('to_date', e.target.value)} id="cr-to" />
              </>}
              {has('io_no') && <Input label="IO No" value={draft.io_no ?? ''} onChange={(e) => set('io_no', e.target.value)} id="cr-io" />}
              {has('style') && <Input label="Style" value={draft.style ?? ''} onChange={(e) => set('style', e.target.value)} id="cr-style" />}
              {has('cut_order') && <Input label="Cut Order" value={draft.cut_order ?? ''} onChange={(e) => set('cut_order', e.target.value)} id="cr-co" />}
              {has('fabric') && <Input label="Fabric" value={draft.fabric ?? ''} onChange={(e) => set('fabric', e.target.value)} id="cr-fabric" />}
              {has('lot_no') && <Input label="Lot No" value={draft.lot_no ?? ''} onChange={(e) => set('lot_no', e.target.value)} id="cr-lot" />}
              {has('roll_no') && <Input label="Roll No" value={draft.roll_no ?? ''} onChange={(e) => set('roll_no', e.target.value)} id="cr-roll" />}
              {has('bundle') && <Input label="Bundle / Barcode" value={draft.bundle ?? ''} onChange={(e) => set('bundle', e.target.value)} id="cr-bundle" />}
              {has('shipment') && <Input label="Shipment No" value={draft.shipment ?? ''} onChange={(e) => set('shipment', e.target.value)} id="cr-shipment" />}
              {has('status') && <Select label="Status" value={draft.status ?? ''} placeholder="All"
                options={statusOpts} onChange={(e) => set('status', e.target.value)} id="cr-status" />}
              {has('exceptions_only') && <Select label="Show" value={draft.exceptions_only ?? '1'}
                options={[{ value: '1', label: 'Outside tolerance only' }, { value: '0', label: 'All cut orders' }]}
                onChange={(e) => set('exceptions_only', e.target.value)} id="cr-exc" />}
              <div className="col-span-2 flex items-end gap-2 sm:col-span-1">
                <button type="submit" className="btn-primary" id="btn-cr-apply"><Filter size={14} /> Apply</button>
                {activeCount > 0 && (
                  <button type="button" className="btn-secondary" onClick={clear} id="btn-cr-clear">
                    <X size={14} /> Clear
                  </button>
                )}
              </div>
            </form>
          </div>

          {error ? <ErrorState error={error} onRetry={() => void refetch()} />
            : isLoading ? <LoadingBlock label="Running report…" />
            : !data || data.meta.total === 0 ? (
              <EmptyState icon={<Scissors size={22} />} title="Nothing to show"
                message="This report returned no rows for the current filters." />
            ) : (
              <div className="card p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
                  <span className="text-[11px] font-semibold text-slate-500">
                    {data.meta.total.toLocaleString('en-IN')} row{data.meta.total === 1 ? '' : 's'}
                    {data.meta.truncated && ` (first ${data.meta.max_rows.toLocaleString('en-IN')} — narrow the filters)`}
                  </span>
                  {isFetching && <span className="text-[11px] text-slate-400">Updating…</span>}
                </div>
                <div className="max-h-[65vh] overflow-auto">
                  <table className="w-full text-[11.5px]">
                    <thead className="sticky top-0 z-10 bg-slate-50">
                      <tr>
                        {columns.map((c) => (
                          <th key={c.key} className={`th whitespace-nowrap ${isNumeric(c.type) ? 'text-right' : 'text-left'}`}>
                            {header(c)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/60">
                          {columns.map((c) => (
                            <td key={c.key} className={`td whitespace-nowrap ${isNumeric(c.type) ? 'text-right tabular-nums' : ''}`}>
                              {renderCell(c, r[c.key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                    {hasTotals && (
                      <tfoot className="sticky bottom-0 bg-slate-100 font-semibold">
                        <tr className="border-t-2 border-slate-300">
                          {columns.map((c, i) => (
                            <td key={c.key} className={`td whitespace-nowrap ${isNumeric(c.type) ? 'text-right tabular-nums' : ''}`}>
                              {i === 0 ? `Total${data.meta.total > rows.length ? ' (all pages)' : ''}`
                                : totals[c.key] != null ? fmtValue(c, totals[c.key]) : ''}
                            </td>
                          ))}
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                <Pager page={page} pageSize={pageSize} total={data.meta.total}
                  totalPages={Math.ceil(data.meta.total / pageSize)} onPage={setPage} />
                {data.notes.length > 0 && (
                  <div className="space-y-0.5 border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500">
                    {data.notes.map((nt) => <p key={nt}>{nt}</p>)}
                  </div>
                )}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
