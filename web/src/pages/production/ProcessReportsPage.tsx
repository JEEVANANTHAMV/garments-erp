import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Download, RefreshCw } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import {
  PageHeader, LoadingBlock, EmptyState, ErrorState, Badge, Input,
} from '../../components/ui';

/**
 * Yarn process reports (doc §28).
 *
 * Each report is a server-side query returning flat rows, so the page stays a
 * thin viewer: pick a report, optionally narrow by date or text, read or export.
 * Machine Utilization and Stripe/Feeder Allocation from the document's list are
 * absent because machine and feeder planning are out of scope here.
 */

type Filter = 'none' | 'dates' | 'lot' | 'io';

interface ReportDef {
  key: string;
  label: string;
  group: string;
  hint: string;
  filter?: Filter;
  /** Endpoint when it does not live under /reports/. */
  path?: string;
}

const REPORTS: ReportDef[] = [
  { key: 'process-register', label: 'Process Program Register', group: 'Process',
    hint: 'Every dyeing, winding and twisting process with issued, output and loss', filter: 'dates' },
  { key: 'yarn-requirement-vs-stock', label: 'Yarn Requirement vs Available Stock', group: 'Yarn',
    hint: 'Open demand across all documents against stock on hand' },
  { key: 'yarn-reservations', label: 'Yarn Reservation Register', group: 'Yarn',
    hint: 'Live reservations and how much of each is still outstanding' },
  { key: 'yarn-shortage', label: 'Yarn Reservation / Shortage', group: 'Yarn',
    hint: 'Where reserved demand exceeds free stock' },
  { key: 'lot-traceability', label: 'Lot-wise Yarn Traceability', group: 'Yarn',
    hint: 'Issues grouped by yarn lot and yarn PO', filter: 'lot' },
  { key: 'dyeing-batch', label: 'Yarn Dyeing Batch Report', group: 'Process',
    hint: 'Batch, shade, temperature and output per dyeing process', filter: 'dates' },
  { key: 'winding-cones', label: 'Winding Cone Production', group: 'Process',
    hint: 'Target vs good and rejected cones, with wastage' },
  { key: 'twisting-production', label: 'Twisting Production', group: 'Process',
    hint: 'Ply, TPI, twist direction and output lots' },
  { key: 'knitting-vs-production', label: 'Knitting Program vs Production', group: 'Knitting',
    hint: 'Planned fabric against produced and rolls received' },
  { key: 'yarn-consumption-variance', label: 'Yarn Consumption Variance', group: 'Knitting',
    hint: 'Planned vs issued vs actually consumed yarn per program' },
  { key: 'fabric-roll-production', label: 'Fabric Roll Production', group: 'Knitting',
    hint: 'Roll-wise net weight, GSM and QC status' },
  { key: 'collar-size-wise', label: 'Collar Size-wise Planned vs Produced', group: 'Collar',
    hint: 'Per-size pieces planned against produced' },
  { key: 'collar-variance', label: 'Collar KG-to-PCS Consumption Variance', group: 'Collar',
    hint: 'Standard gm/pc against the weight actually achieved' },
  { key: 'collar-stock', label: 'Collar Stock (PCS)', group: 'Collar', path: '/collar-stock',
    hint: 'Finished collars in stock, counted in pieces, with the yarn KG behind them' },
  { key: 'process-wastage', label: 'Process Wastage / Rejection', group: 'Process',
    hint: 'Loss and rejection percentage by process type' },
  { key: 'job-work-pending', label: 'Job Work Pending / Return', group: 'Process',
    hint: 'Material sent to vendors against what has come back' },
  { key: 'complete-traceability', label: 'Complete Process Traceability', group: 'Traceability',
    hint: 'One row per movement across processes, issues, receipts and rolls', filter: 'io' },
];

const GROUPS = ['Process', 'Yarn', 'Knitting', 'Collar', 'Traceability'];

/** Columns that read better right-aligned. */
const isNumericKey = (k: string) =>
  /(_kg|_pcs|_qty|qty_|_pct|count|meters|weight|variance|shortage|balance)/i.test(k);

const prettyHeader = (k: string) =>
  k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
   .replace(/\bKg\b/, 'KG').replace(/\bPcs\b/, 'PCS').replace(/\bPct\b/, '%')
   .replace(/\bGsm\b/, 'GSM').replace(/\bQc\b/, 'QC').replace(/\bIo\b/, 'I/O')
   .replace(/\bPo\b/, 'PO').replace(/\bGm\b/, 'gm').replace(/\bTpi\b/, 'TPI');

function renderCell(key: string, v: any) {
  if (v == null || v === '') return <span className="text-slate-300">—</span>;
  if (/date$/.test(key)) return fmtDate(v);
  if (/status/i.test(key)) {
    const s = String(v);
    const tone = /PASS|COMPLETED|SUFFICIENT|STOCK_POSTED|OK/i.test(s) ? 'emerald'
      : /REJECT|SHORT|CANCEL|OVERRIDE/i.test(s) ? 'rose'
      : /PENDING|HOLD|DRAFT/i.test(s) ? 'amber' : 'slate';
    return <Badge tone={tone}>{s.replace(/_/g, ' ')}</Badge>;
  }
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3);
  // Numeric strings come back from DECIMAL columns; keep their precision.
  if (typeof v === 'string' && /^-?\d+\.\d+$/.test(v)) return Number(v).toFixed(3);
  return String(v);
}

export default function ProcessReportsPage() {
  const [active, setActive] = useState<ReportDef>(REPORTS[0]);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [text, setText] = useState('');

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (active.filter === 'dates') {
      if (fromDate) p.set('from_date', fromDate);
      if (toDate) p.set('to_date', toDate);
    }
    if (active.filter === 'lot' && text) p.set('lot_no', text);
    if (active.filter === 'io' && text) p.set('io_no', text);
    return p.toString();
  }, [active, fromDate, toDate, text]);

  const { data: rows = [], isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['process-report', active.key, params],
    queryFn: async () =>
      (await http.get<{ data: any[] }>(`${active.path ?? `/reports/${active.key}`}?${params}`)).data || [],
  });

  const columns = rows.length ? Object.keys(rows[0]).filter((k) => k !== 'id') : [];

  /** Export what is on screen, quoting properly so commas survive. */
  const exportCsv = () => {
    if (!rows.length) return;
    const esc = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      columns.map(prettyHeader).map(esc).join(','),
      ...rows.map((r: any) => columns.map((c) => esc(r[c])).join(',')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${active.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Process Reports"
        subtitle="Yarn, knitting and collar reporting across the whole process chain"
        actions={
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => void refetch()} id="btn-refresh-report">
              <RefreshCw size={14} /> Refresh
            </button>
            <button className="btn-primary" onClick={exportCsv} disabled={!rows.length} id="btn-export-report">
              <Download size={14} /> Export CSV
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* Report picker */}
        <div className="card space-y-3 p-3">
          {GROUPS.map((g) => {
            const items = REPORTS.filter((r) => r.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{g}</p>
                <div className="space-y-0.5">
                  {items.map((r) => (
                    <button key={r.key}
                      className={`block w-full rounded px-2 py-1.5 text-left text-[12px] transition ${
                        active.key === r.key
                          ? 'bg-brand-50 font-semibold text-brand-700'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                      onClick={() => { setActive(r); setText(''); }}
                      id={`rep-${r.key}`}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Report body */}
        <div className="space-y-3">
          <div className="card p-3">
            <h3 className="text-[13px] font-bold text-slate-800">{active.label}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">{active.hint}</p>

            {active.filter === 'dates' && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Input label="From" type="date" value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)} id="rep-from" />
                <Input label="To" type="date" value={toDate}
                  onChange={(e) => setToDate(e.target.value)} id="rep-to" />
              </div>
            )}
            {(active.filter === 'lot' || active.filter === 'io') && (
              <div className="mt-2 max-w-xs">
                <Input label={active.filter === 'lot' ? 'Lot number' : 'I/O number'}
                  value={text} placeholder="Type to filter…"
                  onChange={(e) => setText(e.target.value)} id="rep-text" />
              </div>
            )}
          </div>

          {error ? <ErrorState error={error} onRetry={() => void refetch()} />
            : isLoading ? <LoadingBlock label="Running report…" />
            : rows.length === 0 ? (
              <EmptyState icon={<BarChart3 size={22} />} title="Nothing to show"
                message="This report returned no rows for the current filters." />
            ) : (
              <div className="card p-0">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                  <span className="text-[11px] font-semibold text-slate-500">
                    {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}
                  </span>
                  {isFetching && <span className="text-[11px] text-slate-400">Updating…</span>}
                </div>
                <div className="max-h-[65vh] overflow-auto">
                  <table className="w-full text-[11.5px]">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr>
                        {columns.map((c) => (
                          <th key={c}
                            className={`th whitespace-nowrap ${isNumericKey(c) ? 'text-right' : 'text-left'}`}>
                            {prettyHeader(c)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r: any, i: number) => (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/60">
                          {columns.map((c) => (
                            <td key={c}
                              className={`td whitespace-nowrap ${isNumericKey(c) ? 'text-right tabular-nums' : ''}`}>
                              {renderCell(c, r[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
