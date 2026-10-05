import { useEffect, useMemo, useRef, useState } from 'react';
import { barcodeHtml } from '../../lib/printBarcode';
import { useSearchParams, Link } from 'react-router-dom';
import {
  Printer, Plus, ScanLine, X, PackageCheck, Ban, Lock, Send, ChevronDown, ChevronRight, Trash2,
  Layers, Boxes, Shirt, Weight, CheckCircle2, ListPlus, FileInput, Combine, FileSpreadsheet, Paperclip, History, Eye,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Card, Badge, Button, Input, Select, Textarea, Modal, DataTable, StatusBadge, SearchInput, useDebounced } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';

/**
 * Process Outward (DC) and Process Inward with bundle numbers.
 *
 * One DC can carry several jobs (IO no / style / buyer PO) — client review
 * 24-Sep-2026 and the sample "multiple jobs per DC" screens. Outward and
 * inward both show the bundles job-wise with per-job and DC-level totals.
 */

type Stage = { id: number; stage_code: string; stage_name: string; kind: string; level: string; source: string };
type Avail = {
  id: number; bundle_no: string; barcode: string; io_no: string | null; part_name: string; style_code: string;
  color_name: string; size_code: string; size_sort: number; qty: number; status: string; lay_no: string | null;
  cut_no: string | null; plan_no: string; available_qty: number; open_dc_no: string | null;
  buyer_name: string | null; buyer_po_no: string | null; assort_color?: string | null;
  /** Open in-house line allocation of the bundle for this process (stitching / ironing / packing DC). */
  line_alloc?: { allocation_no: string; line_code: string; open_qty: number } | null;
  /** DC "from line": PCS of the bundle still open on that line's allocation. */
  from_line_open_qty?: number | null;
};

/** Line process whose output a DC of this stage moves on (checking / washing ← sewing, ironing ← checking, packing ← ironing). */
function sourceProcOf(stage?: Stage | null): 'sewing' | 'checking' | 'ironing' | null {
  if (!stage) return null;
  const code = String(stage.stage_code).toUpperCase();
  if (['CHECK', 'CHECKING', 'WASH', 'WASHING'].includes(code)) return 'sewing';
  if (stage.kind === 'FINISHING') return 'checking';
  if (['PACK', 'PACKING'].includes(code)) return 'ironing';
  return null;
}
type Line = Avail & { issue_qty: number; weight_kg: string; remarks: string; operation_id: string; operator_line: string };
type Job = { key: string; io_no: string | null; buyer_name: string | null; buyer_po_no: string | null; style_codes: string[]; order_type?: string | null };
type Op = { id: number; op_code: string; op_name: string; default_rate: number; contractor_rate: number | null; rate: number; in_job_card?: boolean };

/** Every active operation (any process) — for the per-bundle "process completed". */
function useAllOperations() {
  const [rows, setRows] = useState<Op[]>([]);
  useEffect(() => { api.get('/process-master/operations').then((r) => setRows(r.data.data || [])).catch(() => setRows([])); }, []);
  return rows;
}

/** Contractors for DCs — job workers and in-house contractors. */
function useContractors() {
  const [rows, setRows] = useState<{ id: number; label: string; is_contractor: number }[]>([]);
  useEffect(() => { api.get('/process-dcs/contractors').then((r) => setRows(r.data.data || [])).catch(() => setRows([])); }, []);
  return rows;
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'amber', ISSUED: 'blue', PARTIAL_RECEIVED: 'violet', FULLY_RECEIVED: 'green', CLOSED: 'slate', CANCELLED: 'red',
};
const STATUSES = ['DRAFT', 'ISSUED', 'PARTIAL_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED'];
/** Job section header colours, cycled like the sample screens. */
const JOB_TONES = [
  'bg-blue-50 border-blue-200', 'bg-emerald-50 border-emerald-200', 'bg-amber-50 border-amber-200',
  'bg-violet-50 border-violet-200', 'bg-rose-50 border-rose-200', 'bg-cyan-50 border-cyan-200',
];
const human = (s: string) => s.replace(/_/g, ' ');
const errMsg = (e: any) => e?.message || 'Request failed';
const num = (v: unknown) => Number(v ?? 0) || 0;
const kg = (v: number) => (v ? `${v.toFixed(2)} KG` : '—');

function StatusChip({ value }: { value: string }) {
  return <Badge tone={STATUS_TONE[value] ?? 'slate'}>{human(value)}</Badge>;
}

/** Group rows colour → size, sizes in size order. */
function groupByColorSize<T extends { color_name: string; size_code: string; size_sort?: number }>(rows: T[]) {
  const colors = new Map<string, Map<string, T[]>>();
  const order = new Map<string, number>();
  for (const r of rows) {
    const c = r.color_name || '—'; const s = r.size_code || '—';
    order.set(s, Number(r.size_sort ?? 0));
    if (!colors.has(c)) colors.set(c, new Map());
    const m = colors.get(c)!;
    if (!m.has(s)) m.set(s, []);
    m.get(s)!.push(r);
  }
  const sizeKeys = [...order.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  return [...colors.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([color, m]) => ({
    color,
    sizes: sizeKeys.filter((s) => m.has(s)).map((s) => ({ size: s, rows: m.get(s)! })),
  }));
}

/** Group rows by job (IO no) in first-seen order; rows inside keep colour → size → bundle order. */
function groupByJob<T extends { io_no?: string | null; color_name: string; size_code: string; size_sort?: number }>(rows: T[]) {
  const jobs = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.io_no || '—';
    if (!jobs.has(k)) jobs.set(k, []);
    jobs.get(k)!.push(r);
  }
  return [...jobs.entries()].map(([key, rs]) => ({
    key,
    rows: groupByColorSize(rs).flatMap((g) => g.sizes.flatMap((s) => s.rows)),
  }));
}

function jobTitle(j: { io_no: string | null; buyer_name?: string | null; buyer_po_no?: string | null; style_codes?: string[]; order_type?: string | null }) {
  return (
    <>
      <span>{j.io_no ?? 'No job'}</span>
      {j.order_type && <span className="ml-1 rounded bg-white/70 px-1 text-[10px] font-semibold text-slate-500">{j.order_type}</span>}
      {j.buyer_name && <span className="font-medium text-slate-600"> — {j.buyer_name}</span>}
      {j.buyer_po_no && <span className="font-medium text-slate-600"> (PO {j.buyer_po_no})</span>}
      {!!j.style_codes?.length && <span className="font-medium text-slate-600"> · Style: {j.style_codes.join(', ')}</span>}
    </>
  );
}

// ════════════════════════════════════════════════════════════════════
// Process Outward — DC list
// ════════════════════════════════════════════════════════════════════
export function ProcessDcPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [stages, setStages] = useState<Stage[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [stageFilter, setStageFilter] = useState<number | ''>('');
  const [statusFilter, setStatusFilter] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [editing, setEditing] = useState<{ id?: number } | null>(null);
  const [converting, setConverting] = useState(false);
  const openId = params.get('dc') ? Number(params.get('dc')) : null;

  const load = () => {
    setLoading(true);
    api.get('/process-dcs', { params: { stage_id: stageFilter || undefined, status: statusFilter || undefined, q: dq || undefined } })
      .then((r) => setRows(r.data.data || []))
      .catch((e) => toast(errMsg(e), 'error'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { api.get('/process-dcs/stages').then((r) => setStages(r.data.data || [])); }, []);
  useEffect(load, [stageFilter, statusFilter, dq]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.status] = (m[r.status] || 0) + 1;
    return m;
  }, [rows]);

  const openDc = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set('dc', String(id)); else p.delete('dc');
    setParams(p, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Process Outward (DC)</h1>
          <p className="text-sm text-slate-500">One DC can carry multiple jobs / styles / POs — every bundle number, colour and size is listed job-wise</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setConverting(true)}><Combine size={14} className="inline mr-1" />Panel conversion</Button>
          <Link to="/production/jobwork-receipts" className="btn-secondary"><FileInput size={14} className="inline mr-1" />Process Inward</Link>
          <Button onClick={() => setEditing({})}><Plus size={14} className="inline mr-1" />New DC</Button>
        </div>
      </div>

      {/* Process chips */}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setStageFilter('')}
          className={`rounded-full px-3 py-1.5 text-xs font-medium border ${stageFilter === '' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
          All processes
        </button>
        {stages.map((s) => (
          <button key={s.id} onClick={() => setStageFilter(s.id)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium border ${stageFilter === s.id ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
            {s.stage_name}
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <SearchInput value={q} onChange={setQ} placeholder="DC no or bundle no / barcode…" className="w-72" />
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setStatusFilter('')}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusFilter === '' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
              All {rows.length}
            </button>
            {STATUSES.map((s) => (
              <button key={s} onClick={() => setStatusFilter(s === statusFilter ? '' : s)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusFilter === s ? 'ring-2 ring-brand-500' : ''}`}>
                <StatusChip value={s} /> {statusFilter ? '' : counts[s] ?? 0}
              </button>
            ))}
          </div>
        </div>
        <DataTable
          data={rows}
          loading={loading}
          onRowClick={(r: any) => openDc(r.id)}
          emptyTitle="No DCs yet"
          emptyMessage="Create a DC and add the jobs / bundles going to the contractor."
          columns={[
            { key: 'challan_no', header: 'DC no', render: (r: any) => <span className="font-mono text-[12px] font-semibold text-brand-700">{r.challan_no}</span> },
            { key: 'challan_date', header: 'Date', render: (r: any) => fmtDate(r.challan_date) },
            { key: 'stage_name', header: 'To process', render: (r: any) => r.stage_name ? <Badge tone="violet">{r.stage_name}</Badge> : '—' },
            {
              key: 'vendor_name', header: 'Contractor', render: (r: any) => (
                <span>{r.vendor_name}{r.is_contractor ? <Badge tone="amber" className="ml-1">In-house</Badge> : null}
                  {r.operations && <span className="block text-[11px] text-slate-400">{r.operations}</span>}</span>
              ),
            },
            {
              key: 'io_list', header: 'Jobs', render: (r: any) => (
                <span className="text-xs">
                  {Number(r.job_count) > 1 && <Badge tone="blue" className="mr-1">{r.job_count} jobs</Badge>}
                  {r.io_list ?? r.io_no ?? '—'}
                </span>
              ),
            },
            { key: 'bundle_count', header: 'Bundles', align: 'right' as const, render: (r: any) => fmtNumber(r.bundle_count) },
            { key: 'issued_pcs', header: 'Sent (PCS)', align: 'right' as const, render: (r: any) => fmtNumber(r.issued_pcs) },
            { key: 'received_pcs', header: 'Recd (PCS)', align: 'right' as const, render: (r: any) => <span className="text-emerald-700">{fmtNumber(r.received_pcs)}</span> },
            { key: 'pending_pcs', header: 'Pending (PCS)', align: 'right' as const, render: (r: any) => Number(r.pending_pcs) > 0 && !['DRAFT', 'CANCELLED'].includes(r.status) ? <span className="font-semibold text-amber-700">{fmtNumber(r.pending_pcs)}</span> : '—' },
            { key: 'status', header: 'Status', render: (r: any) => <StatusChip value={r.status} /> },
          ]}
        />
      </Card>

      {editing && (
        <DcEditor id={editing.id} stages={stages} onClose={() => setEditing(null)}
          onSaved={(id, print) => { setEditing(null); load(); openDc(id); if (print) printDc(id, toast); }} />
      )}
      {openId && !editing && (
        <DcDetail id={openId} onClose={() => openDc(null)} onChanged={load}
          onEdit={(id) => setEditing({ id })} />
      )}
      {converting && <PanelConversionModal onClose={() => setConverting(false)} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Shared bits
// ════════════════════════════════════════════════════════════════════
function SummaryTiles({ tiles }: { tiles: { label: string; value: string; icon: React.ReactNode; tone: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-5">
      {tiles.map((t) => (
        <div key={t.label} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${t.tone}`}>
          <span className="opacity-80">{t.icon}</span>
          <div>
            <p className="text-[11px] font-medium opacity-80">{t.label}</p>
            <p className="text-xl font-bold">{t.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Scan box with the last bundle found, as on the sample screens. */
function ScanCard({ value, onChange, onSubmit, disabled, placeholder, last, inputRef }: {
  value: string; onChange: (v: string) => void; onSubmit: (e: React.FormEvent) => void; disabled?: boolean;
  placeholder: string; last: { bundle_no: string; io_no: string | null; style_code: string; size_code: string; qty: number; note?: string } | null;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="mb-2 text-sm font-semibold text-slate-700">Scan bundle barcode</p>
      <form onSubmit={onSubmit} className="flex gap-2">
        <div className="relative flex-1">
          <ScanLine size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-600" />
          <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
            placeholder={placeholder} className="input pl-9 font-mono" />
        </div>
        <Button type="submit" disabled={disabled}>Scan</Button>
      </form>
      {last && (
        <div className="mt-2 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
          <CheckCircle2 size={18} className="text-emerald-600" />
          <div>
            <p className="font-semibold text-slate-800">Bundle found: <span className="font-mono">{last.bundle_no}</span></p>
            <p className="text-slate-600">Job: {last.io_no ?? '—'} · Style: {last.style_code ?? '—'} · Size: {last.size_code ?? '—'} · Qty: {last.qty}{last.note ? ` · ${last.note}` : ''}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Create / edit (draft) — Process Outward DC (multiple jobs)
// ════════════════════════════════════════════════════════════════════
function DcEditor({ id, stages, onClose, onSaved }: {
  id?: number; stages: Stage[]; onClose: () => void; onSaved: (id: number, print: boolean) => void;
}) {
  const toast = useToast();
  const contractors = useContractors();
  const warehouses = useLookup('warehouses');
  const [ops, setOps] = useState<Op[]>([]);
  const [opSel, setOpSel] = useState<Record<number, string>>({});   // operation id → rate (₹ / PCS)
  const [rateTouched, setRateTouched] = useState(false);
  const [head, setHead] = useState<any>({
    challan_no: '', challan_date: today(), stage_id: '', vendor_id: '', from_warehouse_id: '', to_warehouse_id: '',
    ref_no: '', expected_return: '', rate: '', vehicle_no: '', driver_name: '', transporter: '', remarks: '',
    release_line_allocation: false, from_line_id: '', jw_order_line_id: '', outward_override_reason: '',
  });
  const [lines, setLines] = useState<Line[]>([]);
  // Job work order lines (approved orders of this contractor for this process) — DC drawn against the order balance
  const [jwLines, setJwLines] = useState<any[]>([]);
  useEffect(() => {
    if (!head.stage_id || !head.vendor_id) { setJwLines([]); return; }
    api.get('/job-work/orders', { params: { vendor_id: head.vendor_id } }).then((r) => setJwLines((r.data.data || [])
      .filter((o: any) => ['APPROVED', 'PARTIAL_OUTWARD', 'IN_PROCESS', 'PARTIAL_INWARD', 'COMPLETED'].includes(o.status))
      .flatMap((o: any) => (o.lines || []).filter((l: any) => Number(l.stage_id) === Number(head.stage_id) && l.input_kind !== 'FABRIC')
        .map((l: any) => ({ ...l, jw_no: o.jw_no, io_no: o.io_no, style_code: o.style_code }))))).catch(() => setJwLines([]));
  }, [head.stage_id, head.vendor_id]);
  const jwLine = jwLines.find((l) => String(l.id) === String(head.jw_order_line_id));
  const sewLines = useLookup('sewing-lines');
  const chkLines = useLookup('checking-lines');
  const irnLines = useLookup('ironing-lines');
  const [jobMeta, setJobMeta] = useState<Record<string, Job>>({});
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scan, setScan] = useState('');
  const [last, setLast] = useState<Avail | null>(null);
  const [picker, setPicker] = useState<'jobs' | 'bundles' | 'import' | null>(null);
  const [saving, setSaving] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const allOps = useAllOperations();
  const stage = stages.find((s) => s.id === Number(head.stage_id));
  const readonlyNo = !!id;

  // Load an existing draft.
  useEffect(() => {
    if (!id) return;
    api.get(`/process-dcs/${id}`).then((r) => {
      const d = r.data.data;
      setHead({
        challan_no: d.challan_no, challan_date: String(d.challan_date).slice(0, 10), stage_id: d.stage_id, vendor_id: d.vendor_id,
        from_warehouse_id: d.from_warehouse_id ?? '', to_warehouse_id: d.to_warehouse_id ?? '', ref_no: d.ref_no ?? '',
        expected_return: d.expected_return ? String(d.expected_return).slice(0, 10) : '', rate: d.rate ?? '',
        vehicle_no: d.vehicle_no ?? '', driver_name: d.driver_name ?? '', transporter: d.transporter ?? '', remarks: d.remarks ?? '',
        jw_order_line_id: d.jw_order_line_id ?? '', outward_override_reason: d.outward_override_reason ?? '',
        release_line_allocation: !!d.release_line_alloc, from_line_id: d.from_line_id ?? '',
      });
      setOpSel(Object.fromEntries((d.operations || []).map((o: any) => [o.operation_id, String(Number(o.rate))])));
      setRateTouched(d.rate != null && !(d.operations || []).length);
      const meta: Record<string, Job> = {};
      for (const j of d.summary.jobs) meta[j.io_no ?? '—'] = { key: j.io_no ?? '—', ...j };
      setJobMeta(meta);
      setLines(d.lines.map((l: any) => ({
        id: l.bundle_id, bundle_no: l.bundle_no, barcode: l.barcode, io_no: l.job_io_no, part_name: l.part,
        style_code: l.style_code, color_name: l.color_name, size_code: l.size_code, size_sort: l.size_sort,
        qty: l.bundle_qty, status: l.bundle_status, lay_no: l.lay_no, cut_no: l.cut_no, plan_no: '',
        available_qty: l.qty, issue_qty: l.qty, open_dc_no: null, buyer_name: null, buyer_po_no: null, assort_color: l.assort_color,
        weight_kg: l.weight_kg != null ? String(Number(l.weight_kg)) : '', remarks: l.remarks ?? '',
        operation_id: l.operation_id ? String(l.operation_id) : '', operator_line: l.operator_line ?? '',
      })));
    }).catch((e) => toast(errMsg(e), 'error'));
  }, [id]);

  // Operations of the process with this contractor's rates.
  // One job on the DC → its job rate card decides the operations and rates (client voice note 29-Sep-2026).
  const singleIo = lines.length && lines.every((l) => l.io_no && l.io_no === lines[0].io_no) ? lines[0].io_no : null;
  useEffect(() => {
    if (!head.stage_id) { setOps([]); return; }
    api.get('/process-master/operations', { params: { stage_id: head.stage_id, vendor_id: head.vendor_id || undefined, io_no: singleIo || undefined } })
      .then((r) => {
        const rows: Op[] = r.data.data || [];
        setOps(rows);
        const card = rows.filter((o) => o.in_job_card);
        if (card.length && !id) setOpSel((cur) => (Object.keys(cur).length ? cur : Object.fromEntries(card.map((o) => [o.id, String(o.rate)]))));
      }).catch(() => setOps([]));
  }, [head.stage_id, head.vendor_id, singleIo]);
  const opsTotal = Object.values(opSel).reduce((a, v) => a + num(v), 0);
  useEffect(() => {
    if (!rateTouched && Object.keys(opSel).length) setHead((h: any) => ({ ...h, rate: String(Math.round(opsTotal * 10000) / 10000) }));
  }, [opsTotal, rateTouched]);
  const toggleOp = (o: Op) => setOpSel((cur) => {
    const next = { ...cur };
    if (o.id in next) delete next[o.id]; else next[o.id] = String(o.rate);
    return next;
  });

  const inLines = new Set(lines.map((l) => l.id));
  const srcProc = sourceProcOf(stage);
  const srcLineOpts = toOptions((srcProc === 'sewing' ? sewLines : srcProc === 'checking' ? chkLines : irnLines).data);
  const loadFromLine = async () => {
    if (!head.from_line_id || !stage) { toast('Choose the line the bundles come from', 'error'); return; }
    try {
      const r = await api.get('/bundle-stock/available', { params: { stage_id: stage.id, from_line_id: head.from_line_id, limit: 2000 } });
      const n = addBundles(r.data.data || []);
      toast(n ? `${n} bundle(s) loaded from the line` : 'Nothing left on that line for this process', n ? 'success' : 'warning');
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  const addBundles = (bs: Avail[]) => {
    const ok = bs.filter((b) => !b.open_dc_no && !inLines.has(b.id) && b.available_qty > 0);
    const skipped = bs.length - ok.length;
    if (ok.length) {
      setLines((cur) => [...cur, ...ok.map((b) => ({ ...b, issue_qty: b.available_qty, weight_kg: '', remarks: '', operation_id: '', operator_line: '' }))]);
      setJobMeta((cur) => {
        const next = { ...cur };
        for (const b of ok) {
          const k = b.io_no || '—';
          const prev = next[k];
          const styles = new Set([...(prev?.style_codes ?? []), ...(b.style_code ? [b.style_code] : [])]);
          next[k] = { key: k, io_no: b.io_no, buyer_name: b.buyer_name ?? prev?.buyer_name ?? null, buyer_po_no: b.buyer_po_no ?? prev?.buyer_po_no ?? null, style_codes: [...styles] };
        }
        return next;
      });
    }
    if (skipped) toast(`${skipped} bundle(s) skipped — already on this DC, on another open DC, or nothing available`, 'warning');
    return ok.length;
  };

  const onScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    if (!head.stage_id) { toast('Choose the To process first', 'error'); return; }
    if (lines.some((l) => l.barcode === code || l.bundle_no === code)) { toast(`${code} is already on this DC`, 'warning'); setScan(''); return; }
    try {
      const r = await api.get('/bundle-stock/available', { params: { stage_id: head.stage_id, q: code, include_zero: 1 } });
      const hit: Avail | undefined = (r.data.data || []).find((b: Avail) => b.barcode === code || b.bundle_no === code);
      if (!hit) toast(`Bundle ${code} not found`, 'error');
      else if (hit.open_dc_no) toast(`${hit.bundle_no} is already on open DC ${hit.open_dc_no}`, 'error');
      else if (hit.available_qty <= 0) toast(`${hit.bundle_no} has no PCS available for ${stage?.stage_name} (${stage?.source})`, 'error');
      else { addBundles([hit]); setLast(hit); }
    } catch (err) { toast(errMsg(err), 'error'); }
    setScan('');
    scanRef.current?.focus();
  };

  const jobs = groupByJob(lines);
  const total = lines.reduce((a, l) => a + (Number(l.issue_qty) || 0), 0);
  const totalKg = lines.reduce((a, l) => a + num(l.weight_kg), 0);
  const badQty = lines.some((l) => !(l.issue_qty > 0) || l.issue_qty > l.available_qty);
  const setLine = (bid: number, patch: Partial<Line>) => setLines((cur) => cur.map((x) => (x.id === bid ? { ...x, ...patch } : x)));
  const removeIds = (ids: Set<number>) => { setLines((cur) => cur.filter((x) => !ids.has(x.id))); setChecked(new Set()); };
  const toggle = (set: Set<any>, v: any) => { const s = new Set(set); if (s.has(v)) s.delete(v); else s.add(v); return s; };

  const save = async (issue: boolean, print = false) => {
    if (!head.stage_id || !head.vendor_id) { toast('Choose the To process and contractor', 'error'); return; }
    if (!lines.length) { toast('Add at least one job / bundle', 'error'); return; }
    if (badQty) { toast('Fix the highlighted bundle quantities', 'error'); return; }
    setSaving(true);
    const body = {
      ...head, challan_no: readonlyNo ? undefined : head.challan_no || null,
      stage_id: Number(head.stage_id), vendor_id: Number(head.vendor_id),
      from_warehouse_id: head.from_warehouse_id ? Number(head.from_warehouse_id) : null,
      to_warehouse_id: head.to_warehouse_id ? Number(head.to_warehouse_id) : null,
      rate: head.rate === '' ? null : Number(head.rate), expected_return: head.expected_return || null,
      operations: Object.entries(opSel).map(([oid, rate]) => ({ operation_id: Number(oid), rate: rate === '' ? null : Number(rate) })),
      lines: lines.map((l) => ({
        bundle_id: l.id, qty: Number(l.issue_qty), weight_kg: l.weight_kg === '' ? null : Number(l.weight_kg), remarks: l.remarks || null,
        operation_id: l.operation_id ? Number(l.operation_id) : null, operator_line: l.operator_line || null,
      })),
      issue,
      from_line_id: srcProc && head.from_line_id ? Number(head.from_line_id) : null,
      jw_order_line_id: head.jw_order_line_id ? Number(head.jw_order_line_id) : null,
      outward_override_reason: head.outward_override_reason || null,
    };
    try {
      const r = id ? await api.put(`/process-dcs/${id}`, body) : await api.post('/process-dcs', body);
      const d = r.data.data;
      toast(issue
        ? `DC ${d.challan_no} issued — ${d.summary.jobs.length} job(s), ${lines.length} bundles, ${total} PCS`
        : `Draft ${d.challan_no} saved`);
      onSaved(d.id, print);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={id ? `Edit draft DC ${head.challan_no}` : 'Process Outward DC (multiple jobs)'} size="full"
      footer={<>
        <span className="mr-auto self-center text-sm text-slate-600">
          <b>{jobs.length}</b> jobs · <b>{lines.length}</b> bundles · <b>{fmtNumber(total)}</b> PCS
        </span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" loading={saving} onClick={() => save(false)}>Save draft</Button>
        <Button variant="secondary" loading={saving} onClick={() => save(true)}><Send size={13} className="inline mr-1" />Save &amp; issue</Button>
        <Button loading={saving} onClick={() => save(true, true)}><Printer size={13} className="inline mr-1" />Save, issue &amp; print DC</Button>
      </>}>
      {/* Header + scan */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
        <div className="xl:col-span-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Input label="DC no" value={head.challan_no} disabled={readonlyNo} placeholder="Auto"
            onChange={(e) => setHead({ ...head, challan_no: e.target.value })} />
          <Input label="Date" type="date" required value={head.challan_date} onChange={(e) => setHead({ ...head, challan_date: e.target.value })} />
          <Input label="From process" value={stage ? stage.source : ''} disabled placeholder="Set by the To process" />
          <Select label="To process" required value={head.stage_id}
            onChange={(e) => { setHead({ ...head, stage_id: e.target.value }); setOpSel({}); if (lines.length) { setLines([]); setJobMeta({}); toast('Process changed — bundle lines cleared', 'info'); } }}
            placeholder="— choose —" options={stages.map((s) => ({ value: s.id, label: s.stage_name }))} />
          <Select label="Contractor" required value={head.vendor_id} onChange={(e) => setHead({ ...head, vendor_id: e.target.value })}
            placeholder="— choose —" options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
          <Select label="From location" value={head.from_warehouse_id} onChange={(e) => setHead({ ...head, from_warehouse_id: e.target.value })}
            placeholder="— store —" options={toOptions(warehouses.data)} />
          <Select label="To location" value={head.to_warehouse_id} onChange={(e) => setHead({ ...head, to_warehouse_id: e.target.value })}
            placeholder="— store —" options={toOptions(warehouses.data)} />
          <Input label="Ref / SR no" value={head.ref_no} onChange={(e) => setHead({ ...head, ref_no: e.target.value })} />
          <Input label="Expected return" type="date" value={head.expected_return} onChange={(e) => setHead({ ...head, expected_return: e.target.value })} />
          <Input label="Rate (₹ / PCS)" type="number" min={0} step="0.01" value={head.rate}
            hint={Object.keys(opSel).length && !rateTouched ? 'Sum of the operations' : undefined}
            onChange={(e) => { setRateTouched(true); setHead({ ...head, rate: e.target.value }); }} />
          <Input label="Vehicle no" value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value.toUpperCase() })} />
          <Input label="Driver" value={head.driver_name} onChange={(e) => setHead({ ...head, driver_name: e.target.value })} />
          {jwLines.length > 0 && (
            <Select label="Job work order" id="dc-jw-line" value={head.jw_order_line_id} className="md:col-span-2"
              onChange={(e) => setHead({ ...head, jw_order_line_id: e.target.value })} placeholder="— not against an order —"
              options={jwLines.map((l) => ({ value: l.id, label: `${l.jw_no} · ${l.io_no ?? ''} ${l.style_code ?? ''} · line ${l.seq_no} — ${fmtNumber(l.outward)} of ${fmtNumber(l.planned)} PCS sent` }))} />
          )}
          {jwLine && total + num(jwLine.outward) > num(jwLine.planned) && (
            <Input label={`Over the order by ${fmtNumber(total + num(jwLine.outward) - num(jwLine.planned))} PCS — manager override reason`} id="dc-jw-override" className="md:col-span-2"
              value={head.outward_override_reason} onChange={(e) => setHead({ ...head, outward_override_reason: e.target.value })} />
          )}
        </div>
        {(stage?.kind === 'SEWING' || stage?.kind === 'FINISHING' || ['PACK', 'PACKING'].includes(String(stage?.stage_code ?? '').toUpperCase())) && (
          <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${lines.some((l) => l.line_alloc) ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
            <input type="checkbox" className="mt-0.5" checked={!!head.release_line_allocation}
              onChange={(e) => setHead({ ...head, release_line_allocation: e.target.checked })} />
            <span>
              <b>Release in-house line allocation</b> — bundles already allocated to an in-house {stage?.kind === 'SEWING' ? 'sewing' : stage?.kind === 'FINISHING' ? 'ironing' : 'packing'} line
              can go on this DC only when this is ticked; issuing the DC then takes the PCS off that line allocation and its daily plan.
              {lines.some((l) => l.line_alloc) && <> <b>{lines.filter((l) => l.line_alloc).length}</b> bundle(s) on this DC are allocated in-house.</>}
            </span>
          </label>
        )}
        {srcProc && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <Select label={`From ${srcProc} line`} className="w-56" value={head.from_line_id} placeholder="— not from a line —"
              options={srcLineOpts} onChange={(e) => setHead({ ...head, from_line_id: e.target.value })} />
            <Button size="sm" variant="secondary" onClick={loadFromLine} disabled={!head.from_line_id}>Load line bundles</Button>
            <span className="max-w-xl pb-1">
              Bundles are picked from this line's allocation, and issuing the DC <b>is the line's output</b>
              (allocation completed, daily plan achieved{srcProc !== 'ironing' ? `; PCS not yet entered in ${srcProc === 'sewing' ? 'Daily Output' : 'Checking Entry'} are posted as good` : ''}) — no second entry.
            </span>
          </div>
        )}
        <ScanCard value={scan} onChange={setScan} onSubmit={onScan} disabled={!head.stage_id} inputRef={scanRef}
          placeholder={head.stage_id ? 'Scan bundle barcode + Enter' : 'Choose the To process first'}
          last={last ? { ...last, qty: last.available_qty } : null} />
      </div>

      {/* Operations of the process (rate per operation for this contractor) */}
      {ops.length > 0 && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-700">{stage?.stage_name} process (operations)</p>
            <span className="text-xs text-slate-500">
              {Object.keys(opSel).length} selected · ₹{opsTotal.toFixed(2)} / PCS
              {rateTouched && Object.keys(opSel).length > 0 && (
                <button className="ml-2 font-semibold text-brand-700" onClick={() => setRateTouched(false)}>use as DC rate</button>
              )}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
            {ops.map((o) => {
              const on = o.id in opSel;
              return (
                <label key={o.id} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${on ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-white'}`}>
                  <input type="checkbox" checked={on} onChange={() => toggleOp(o)} />
                  <span className="flex-1 font-medium text-slate-700">{o.op_name}{o.in_job_card && <span className="ml-1 rounded bg-violet-100 px-1 text-[10px] font-semibold text-violet-700" title="On this job's rate card">job</span>}</span>
                  {on ? (
                    <input type="number" min={0} step="0.01" value={opSel[o.id]} title="₹ / PCS"
                      onChange={(e) => setOpSel((cur) => ({ ...cur, [o.id]: e.target.value }))}
                      className="input h-6 w-16 px-1 text-right" />
                  ) : (
                    <span className="text-slate-400" title={o.contractor_rate != null ? 'Contractor rate' : 'Default rate'}>₹{Number(o.rate).toFixed(2)}</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2">
        <span className="mr-auto text-sm font-semibold text-slate-800">Job / style details</span>
        <Button size="sm" disabled={!head.stage_id} onClick={() => setPicker('jobs')}><Plus size={13} className="inline mr-1" />Add job</Button>
        <Button size="sm" variant="secondary" disabled={!head.stage_id} onClick={() => setPicker('bundles')}>
          <ListPlus size={13} className="inline mr-1" />Load pending bundles
        </Button>
        <Button size="sm" variant="secondary" disabled={!head.stage_id} onClick={() => setPicker('import')}>
          <FileSpreadsheet size={13} className="inline mr-1" />Import from Excel
        </Button>
        <Button size="sm" variant="danger" disabled={!checked.size} onClick={() => removeIds(checked)}>
          <Trash2 size={13} className="inline mr-1" />Remove selected ({checked.size})
        </Button>
      </div>

      {/* Job sections */}
      <div className="mt-3 space-y-3">
        {!lines.length && (
          <p className="rounded-xl border border-dashed border-slate-300 py-14 text-center text-sm text-slate-400">
            {head.stage_id ? 'Add a job, load pending bundles or scan bundle barcodes.' : 'Choose the To process to add jobs.'}
          </p>
        )}
        {jobs.map((j, ji) => {
          const meta = jobMeta[j.key] ?? { key: j.key, io_no: j.key === '—' ? null : j.key, buyer_name: null, buyer_po_no: null, style_codes: [] };
          const jQty = j.rows.reduce((a, l) => a + (Number(l.issue_qty) || 0), 0);
          const jKg = j.rows.reduce((a, l) => a + num(l.weight_kg), 0);
          const isCollapsed = collapsed.has(j.key);
          const allChecked = j.rows.every((l) => checked.has(l.id));
          return (
            <div key={j.key} className="overflow-hidden rounded-xl border border-slate-200">
              <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-3 py-2 text-sm ${JOB_TONES[ji % JOB_TONES.length]}`}>
                <button onClick={() => setCollapsed(toggle(collapsed, j.key))} className="text-slate-600" aria-label="Collapse">
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </button>
                <span className="mr-auto font-bold text-slate-800">{ji + 1}. {jobTitle(meta)}</span>
                <span className="text-xs text-slate-600">Total bundles: <b>{j.rows.length}</b></span>
                <span className="text-xs text-slate-600">Total qty: <b>{fmtNumber(jQty)} PCS</b></span>
                <span className="text-xs text-slate-600">Total weight: <b>{kg(jKg)}</b></span>
                <button onClick={() => removeIds(new Set(j.rows.map((l) => l.id)))}
                  className="rounded border border-red-200 bg-white px-2 py-0.5 text-xs font-semibold text-red-600 hover:bg-red-50">
                  Remove job
                </button>
              </div>
              {!isCollapsed && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="w-8 px-2 py-1.5">
                          <input type="checkbox" checked={allChecked} onChange={() => {
                            const s = new Set(checked);
                            for (const l of j.rows) { if (allChecked) s.delete(l.id); else s.add(l.id); }
                            setChecked(s);
                          }} />
                        </th>
                        <th className="px-2 py-1.5 text-left">#</th>
                        <th className="px-2 py-1.5 text-left">Bundle ID</th>
                        <th className="px-2 py-1.5 text-left">Lay no</th>
                        <th className="px-2 py-1.5 text-left">Cut no</th>
                        <th className="px-2 py-1.5 text-left">Part</th>
                        <th className="px-2 py-1.5 text-left">Colour</th>
                        <th className="px-2 py-1.5 text-left">Assort colour</th>
                        <th className="px-2 py-1.5 text-left">Size</th>
                        <th className="px-2 py-1.5 text-right">Available</th>
                        <th className="px-2 py-1.5 text-right">Qty (PCS)</th>
                        <th className="px-2 py-1.5 text-right">Weight (KG)</th>
                        <th className="px-2 py-1.5 text-left">Process completed</th>
                        <th className="px-2 py-1.5 text-left">Operator / line</th>
                        <th className="px-2 py-1.5 text-left">Remarks</th>
                        <th className="w-8 px-2 py-1.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {j.rows.map((l, i) => {
                        const bad = !(l.issue_qty > 0) || l.issue_qty > l.available_qty;
                        return (
                          <tr key={l.id} className="border-t border-slate-100">
                            <td className="px-2 py-1 text-center">
                              <input type="checkbox" checked={checked.has(l.id)} onChange={() => setChecked(toggle(checked, l.id))} />
                            </td>
                            <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                            <td className="px-2 py-1 font-mono font-semibold text-slate-800">
                              {l.bundle_no}
                              {l.line_alloc && <Badge tone="amber" className="ml-1">line {l.line_alloc.line_code} · {l.line_alloc.allocation_no}</Badge>}
                            </td>
                            <td className="px-2 py-1">{l.lay_no ?? '—'}</td>
                            <td className="px-2 py-1">{l.cut_no ?? '—'}</td>
                            <td className="px-2 py-1">{l.part_name ?? '—'}</td>
                            <td className="px-2 py-1">{l.color_name}</td>
                            <td className="px-2 py-1 text-slate-500">{l.assort_color ?? '—'}</td>
                            <td className="px-2 py-1 font-semibold">{l.size_code}</td>
                            <td className="px-2 py-1 text-right text-slate-400">{l.available_qty}</td>
                            <td className="px-2 py-1 text-right">
                              <input type="number" min={1} max={l.available_qty} value={l.issue_qty}
                                onChange={(e) => setLine(l.id, { issue_qty: Number(e.target.value) })}
                                className={`input h-7 w-20 px-1.5 text-right ${bad ? 'input-error' : ''}`} />
                            </td>
                            <td className="px-2 py-1 text-right">
                              <input type="number" min={0} step="0.01" value={l.weight_kg} placeholder="—"
                                onChange={(e) => setLine(l.id, { weight_kg: e.target.value })}
                                className="input h-7 w-20 px-1.5 text-right" />
                            </td>
                            <td className="px-2 py-1">
                              <select value={l.operation_id} onChange={(e) => setLine(l.id, { operation_id: e.target.value })} className="input h-7 w-36 px-1">
                                <option value="">—</option>
                                {allOps.map((o) => <option key={o.id} value={o.id}>{o.op_name}</option>)}
                              </select>
                            </td>
                            <td className="px-2 py-1">
                              <input value={l.operator_line} onChange={(e) => setLine(l.id, { operator_line: e.target.value.toUpperCase() })} className="input h-7 w-24 px-1.5" placeholder="LINE-01" />
                            </td>
                            <td className="px-2 py-1">
                              <input value={l.remarks} onChange={(e) => setLine(l.id, { remarks: e.target.value })} className="input h-7 w-40 px-1.5" />
                            </td>
                            <td className="px-2 py-1">
                              <button onClick={() => removeIds(new Set([l.id]))} className="text-slate-400 hover:text-red-600" aria-label="Remove">
                                <X size={14} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* DC level summary */}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-red-100 bg-red-50/30 p-3">
          <p className="mb-2 text-sm font-bold text-red-700">DC level summary</p>
          <SummaryTiles tiles={[
            { label: 'Total jobs', value: String(jobs.length), icon: <Layers size={20} />, tone: 'border-blue-100 bg-blue-50 text-blue-800' },
            { label: 'Total bundles', value: fmtNumber(lines.length), icon: <Boxes size={20} />, tone: 'border-violet-100 bg-violet-50 text-violet-800' },
            { label: 'Total qty (PCS)', value: fmtNumber(total), icon: <Shirt size={20} />, tone: 'border-cyan-100 bg-cyan-50 text-cyan-800' },
            { label: 'Total weight (KG)', value: totalKg ? totalKg.toFixed(2) : '—', icon: <Weight size={20} />, tone: 'border-rose-100 bg-rose-50 text-rose-800' },
          ]} />
        </div>
        <Textarea label="Remarks (overall DC)" value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} rows={4} />
      </div>
      {lines.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-500">Colour × size breakdown</summary>
          <div className="mt-2"><SizeColorMatrix rows={lines.map((l) => ({ color_name: l.color_name, size_code: l.size_code, size_sort: l.size_sort, qty: Number(l.issue_qty) || 0 }))} /></div>
        </details>
      )}

      {picker === 'jobs' && stage && (
        <JobPicker stage={stage} excluded={inLines} onClose={() => setPicker(null)}
          onAdd={(bs) => { const n = addBundles(bs); if (n) toast(`${n} bundles added`); setPicker(null); }} />
      )}
      {picker === 'bundles' && stage && (
        <BundlePicker stage={stage} excluded={inLines} fromLineId={srcProc ? head.from_line_id : ''} onClose={() => setPicker(null)}
          onAdd={(bs) => { const n = addBundles(bs); if (n) toast(`${n} bundles added`); setPicker(null); }} />
      )}
      {picker === 'import' && stage && (
        <ImportBundlesModal stage={stage} excludeChallanId={id} onClose={() => setPicker(null)}
          onAdd={(bs) => { const n = addBundles(bs.filter((b) => !inLines.has(b.id))); if (n) toast(`${n} bundles added`); setPicker(null); }} />
      )}
    </Modal>
  );
}

/** "Add job" — jobs with bundles ready for the process; picking one loads all its free bundles. */
function JobPicker({ stage, excluded, onClose, onAdd }: { stage: Stage; excluded: Set<number>; onClose: () => void; onAdd: (bs: Avail[]) => void }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.get('/bundle-stock/available-jobs', { params: { stage_id: stage.id } })
      .then((r) => setJobs(r.data.data || [])).catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  }, [stage.id]);

  const shown = jobs.filter((j) => !q || [j.io_no, j.buyer_name, j.buyer_po_no, ...(j.style_codes || [])].some((v) => String(v ?? '').toLowerCase().includes(q.toLowerCase())));

  const add = async () => {
    setAdding(true);
    try {
      const all: Avail[] = [];
      for (const io of picked) {
        const r = await api.get('/bundle-stock/available', { params: { stage_id: stage.id, io_no: io, limit: 2000 } });
        all.push(...(r.data.data || []).filter((b: Avail) => !excluded.has(b.id)));
      }
      onAdd(all);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setAdding(false); }
  };

  return (
    <Modal open onClose={onClose} size="lg" title={`Add job — bundles ready for ${stage.stage_name}`}
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-500">{stage.source}</span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={adding} disabled={!picked.size} onClick={add}>Add {picked.size || ''} job(s)</Button>
      </>}>
      <SearchInput value={q} onChange={setQ} placeholder="IO no, buyer, PO, style…" className="mb-2 w-full" />
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr>
          <th className="w-8 px-2 py-1.5" /><th className="px-2 py-1.5 text-left">IO / Job no</th><th className="px-2 py-1.5 text-left">Buyer</th>
          <th className="px-2 py-1.5 text-left">Buyer PO</th><th className="px-2 py-1.5 text-left">Style</th>
          <th className="px-2 py-1.5 text-right">Bundles free</th><th className="px-2 py-1.5 text-right">Qty (PCS)</th>
        </tr></thead>
        <tbody>
          {loading && <tr><td colSpan={7} className="py-6 text-center text-slate-400">Loading…</td></tr>}
          {!loading && !shown.length && <tr><td colSpan={7} className="py-6 text-center text-slate-400">No jobs have bundles ready for {stage.stage_name}.</td></tr>}
          {shown.map((j) => {
            const k = j.io_no ?? '';
            const disabled = !j.free_bundles;
            return (
              <tr key={k} className={`border-t border-slate-100 ${disabled ? 'opacity-50' : 'cursor-pointer hover:bg-brand-50/40'}`}
                onClick={() => { if (disabled) return; setPicked((cur) => { const s = new Set(cur); if (s.has(k)) s.delete(k); else s.add(k); return s; }); }}>
                <td className="px-2 py-1.5 text-center"><input type="checkbox" readOnly disabled={disabled} checked={picked.has(k)} /></td>
                <td className="px-2 py-1.5 font-mono font-semibold">{j.io_no ?? '—'}</td>
                <td className="px-2 py-1.5">{j.buyer_name ?? '—'}</td>
                <td className="px-2 py-1.5">{j.buyer_po_no ?? '—'}</td>
                <td className="px-2 py-1.5">{(j.style_codes || []).join(', ') || '—'}</td>
                <td className="px-2 py-1.5 text-right">{j.free_bundles}{j.bundles > j.free_bundles && <span className="text-slate-400"> / {j.bundles}</span>}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{fmtNumber(j.qty)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}

/**
 * "Import from Excel" — bundle nos / barcodes from the first column of an .xlsx /
 * .csv sheet (or pasted), checked by the server against what the process can take.
 */
function ImportBundlesModal({ stage, excludeChallanId, onClose, onAdd }: {
  stage: Stage; excludeChallanId?: number; onClose: () => void; onAdd: (bs: Avail[]) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ code: string; ok: boolean; reason?: string; bundle?: Avail }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const readFile = async (f: File) => {
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
      // First column; a header row such as "Bundle" / "Barcode" is skipped.
      const codes = rows.map((r) => String(r?.[0] ?? '').trim()).filter((v, i) => v && !(i === 0 && /bundle|barcode|code/i.test(v)));
      setText(codes.join('\n'));
      toast(`${codes.length} codes read from ${f.name}`);
    } catch { toast('Could not read the file — use .xlsx, .xls or .csv', 'error'); }
  };
  const check = async () => {
    const codes = text.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
    if (!codes.length) { toast('Paste or load bundle nos / barcodes first', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.post('/process-dcs/resolve-bundles', { stage_id: stage.id, codes, exclude_challan_id: excludeChallanId ?? null });
      setResult(r.data.data || []);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const ready = (result || []).filter((r) => r.ok && r.bundle).map((r) => r.bundle!) as Avail[];

  return (
    <Modal open onClose={onClose} size="lg" title={`Import bundles — ${stage.stage_name}`}
      footer={<>
        {result && <span className="mr-auto self-center text-xs text-slate-600"><b>{ready.length}</b> ready · <b>{result.length - ready.length}</b> rejected</span>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {!result ? <Button loading={busy} onClick={check}>Check bundles</Button>
          : <Button disabled={!ready.length} onClick={() => onAdd(ready)}>Add {ready.length} bundles</Button>}
      </>}>
      {!result ? (
        <>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} className="mb-2 block text-xs" />
          <Textarea label="Bundle nos / barcodes (first column of the sheet, or paste — one per line)" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
        </>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>
            <th className="px-2 py-1.5 text-left">Code</th><th className="px-2 py-1.5 text-left">Bundle</th><th className="px-2 py-1.5 text-left">Job</th>
            <th className="px-2 py-1.5 text-left">Colour / size</th><th className="px-2 py-1.5 text-right">Available</th><th className="px-2 py-1.5 text-left">Status</th>
          </tr></thead>
          <tbody>
            {result.map((r) => (
              <tr key={r.code} className={`border-t border-slate-100 ${r.ok ? '' : 'bg-red-50/50'}`}>
                <td className="px-2 py-1 font-mono">{r.code}</td><td className="px-2 py-1 font-mono">{r.bundle?.bundle_no ?? '—'}</td>
                <td className="px-2 py-1">{r.bundle?.io_no ?? '—'}</td>
                <td className="px-2 py-1">{r.bundle ? `${r.bundle.color_name} / ${r.bundle.size_code}` : '—'}</td>
                <td className="px-2 py-1 text-right">{r.bundle?.available_qty ?? '—'}</td>
                <td className="px-2 py-1">{r.ok ? <Badge tone="green">Ready</Badge> : <span className="text-red-600">{r.reason}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/** "Load pending bundles" — filterable bundle list grouped job → colour → size. */
function BundlePicker({ stage, excluded, fromLineId, onClose, onAdd }: { stage: Stage; excluded: Set<number>; fromLineId?: string | number; onClose: () => void; onAdd: (bs: Avail[]) => void }) {
  const toast = useToast();
  const styles = useLookup('styles');
  const colors = useLookup('colors');
  const [filters, setFilters] = useState<any>({ io_no: '', style_id: '', color_id: '', size: '', q: '' });
  const [avail, setAvail] = useState<Avail[]>([]);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const dFilters = useDebounced(filters, 300);

  useEffect(() => {
    setLoading(true);
    api.get('/bundle-stock/available', {
      params: {
        stage_id: stage.id, io_no: dFilters.io_no || undefined, style_id: dFilters.style_id || undefined,
        color_id: dFilters.color_id || undefined, q: dFilters.q || undefined,
        from_line_id: fromLineId || undefined,
      },
    }).then((r) => setAvail(r.data.data || []))
      .catch((e) => toast(errMsg(e), 'error'))
      .finally(() => setLoading(false));
  }, [stage.id, dFilters.io_no, dFilters.style_id, dFilters.color_id, dFilters.q, fromLineId]);

  const shown = avail.filter((b) => !excluded.has(b.id) && (!filters.size || b.size_code === filters.size));
  const sizesShown = [...new Set(avail.map((b) => b.size_code))];
  const free = shown.filter((b) => !b.open_dc_no);

  return (
    <Modal open onClose={onClose} size="xl" title={`Load pending bundles — ${stage.stage_name}`}
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-500">{loading ? 'Loading…' : `${shown.length} bundles available · ${stage.source}`}</span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" disabled={!free.length} onClick={() => onAdd(free)}>Add all shown ({free.length})</Button>
        <Button disabled={!checked.size} onClick={() => onAdd(shown.filter((b) => checked.has(b.id)))}>Add selected ({checked.size})</Button>
      </>}>
      <div className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Input placeholder="IO / job no" value={filters.io_no} onChange={(e) => setFilters({ ...filters, io_no: e.target.value })} />
        <Input placeholder="Bundle no / barcode" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        <Select value={filters.style_id} onChange={(e) => setFilters({ ...filters, style_id: e.target.value })} placeholder="All styles" options={toOptions(styles.data)} />
        <Select value={filters.color_id} onChange={(e) => setFilters({ ...filters, color_id: e.target.value })} placeholder="All colours" options={toOptions(colors.data)} />
      </div>
      {sizesShown.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {['', ...sizesShown].map((sz) => (
            <button key={sz || 'all'} onClick={() => setFilters({ ...filters, size: sz })}
              className={`rounded px-2 py-0.5 text-[11px] font-semibold border ${filters.size === sz ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200'}`}>
              {sz || 'All sizes'}
            </button>
          ))}
        </div>
      )}
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {groupByJob(shown).map((j, ji) => (
          <div key={j.key} className="overflow-hidden rounded-lg border border-slate-200">
            <div className={`flex items-center justify-between border-b px-3 py-1.5 text-xs ${JOB_TONES[ji % JOB_TONES.length]}`}>
              <span className="font-bold text-slate-800">{j.key === '—' ? 'No job' : j.key}
                {j.rows[0]?.buyer_name && <span className="font-medium text-slate-600"> — {j.rows[0].buyer_name}</span>}
                {j.rows[0]?.buyer_po_no && <span className="font-medium text-slate-600"> (PO {j.rows[0].buyer_po_no})</span>}
              </span>
              <span className="text-slate-600">{j.rows.length} bundles · {fmtNumber(j.rows.reduce((a, b) => a + b.available_qty, 0))} PCS</span>
            </div>
            {j.rows.map((b) => (
              <label key={b.id} className={`flex cursor-pointer items-center gap-3 border-t border-slate-50 px-3 py-1.5 text-xs hover:bg-brand-50/40 ${b.open_dc_no ? 'opacity-50' : ''}`}>
                <input type="checkbox" disabled={!!b.open_dc_no} checked={checked.has(b.id)}
                  onChange={(e) => { const n = new Set(checked); if (e.target.checked) n.add(b.id); else n.delete(b.id); setChecked(n); }} />
                <span className="w-32 font-mono font-semibold text-slate-800">{b.bundle_no}</span>
                <span className="w-24 text-slate-500">{b.style_code}</span>
                <span className="w-28">{b.color_name}</span>
                <span className="w-12 font-semibold">{b.size_code}</span>
                <span className="text-slate-400">{b.part_name}</span>
                {b.lay_no && <span className="text-slate-400">Lay {b.lay_no}</span>}
                {b.open_dc_no && <Badge tone="amber">on {b.open_dc_no}</Badge>}
                {b.line_alloc && <Badge tone="violet">in-house line {b.line_alloc.line_code} · {b.line_alloc.allocation_no} ({b.line_alloc.open_qty} PCS)</Badge>}
                <span className="ml-auto font-semibold text-slate-700">{b.available_qty} PCS</span>
              </label>
            ))}
          </div>
        ))}
        {!loading && !shown.length && <p className="py-8 text-center text-sm text-slate-400">No bundles ready for {stage.stage_name} with these filters.</p>}
      </div>
    </Modal>
  );
}

/** Colour × size PCS matrix with totals. */
function SizeColorMatrix({ rows }: { rows: { color_name: string; size_code: string; size_sort?: number; qty: number }[] }) {
  const g = groupByColorSize(rows);
  const sizes = [...new Map(rows.map((r) => [r.size_code, Number(r.size_sort ?? 0)])).entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const cell = (c: string, s: string) => g.find((x) => x.color === c)?.sizes.find((x) => x.size === s)?.rows ?? [];
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="px-3 py-1.5 text-left">Colour \ Size (PCS)</th>
            {sizes.map((s) => <th key={s} className="px-2 py-1.5 text-right">{s}</th>)}
            <th className="px-3 py-1.5 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {g.map((c) => (
            <tr key={c.color} className="border-t border-slate-100">
              <td className="px-3 py-1 font-semibold">{c.color}</td>
              {sizes.map((s) => {
                const r = cell(c.color, s);
                return <td key={s} className="px-2 py-1 text-right">{r.length ? <>{fmtNumber(r.reduce((a, x) => a + x.qty, 0))} <span className="text-slate-400">({r.length})</span></> : '—'}</td>;
              })}
              <td className="px-3 py-1 text-right font-bold">{fmtNumber(c.sizes.reduce((a, s) => a + s.rows.reduce((x, y) => x + y.qty, 0), 0))}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
            <td className="px-3 py-1">Total</td>
            {sizes.map((s) => <td key={s} className="px-2 py-1 text-right">{fmtNumber(rows.filter((r) => r.size_code === s).reduce((a, r) => a + r.qty, 0))}</td>)}
            <td className="px-3 py-1 text-right">{fmtNumber(rows.reduce((a, r) => a + r.qty, 0))}</td>
          </tr>
        </tbody>
      </table>
      <p className="px-3 py-1 text-[10px] text-slate-400">(n) = number of bundles</p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// DC detail: job-wise lines, receipts, actions, print
// ════════════════════════════════════════════════════════════════════
function lineStatus(l: any, dcStatus: string) {
  if (dcStatus === 'DRAFT') return <Badge tone="amber">Draft</Badge>;
  if (dcStatus === 'CANCELLED') return <Badge tone="red">Cancelled</Badge>;
  const pending = num(l.pending_qty);
  if (pending > 0 && num(l.received_qty) + num(l.rejected_qty) + num(l.shortage_qty) === 0) return <Badge tone="blue">Issued</Badge>;
  if (pending > 0) return <Badge tone="violet">Partial</Badge>;
  if (num(l.shortage_qty) > 0) return <Badge tone="amber">Shortage</Badge>;
  if (num(l.rejected_qty) > 0) return <Badge tone="red">Rejected</Badge>;
  return <Badge tone="green">Received</Badge>;
}

function DcDetail({ id, onClose, onChanged, onEdit }: { id: number; onClose: () => void; onChanged: () => void; onEdit: (id: number) => void }) {
  const toast = useToast();
  const [dc, setDc] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [reasonFor, setReasonFor] = useState<'cancel' | 'close' | null>(null);
  const [reason, setReason] = useState('');
  const [variance, setVariance] = useState('');
  const [returning, setReturning] = useState(false);
  const [qcFor, setQcFor] = useState<any>(null);

  const load = () => api.get(`/process-dcs/${id}`).then((r) => setDc(r.data.data)).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { load(); }, [id]);

  const act = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true);
    try { const r = await fn(); if (r?.data?.data?.lines) setDc(r.data.data); else await load(); toast(msg); onChanged(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  if (!dc) return <Modal open onClose={onClose} title="DC"><p className="text-sm text-slate-500">Loading…</p></Modal>;
  const lines = (dc.lines as any[]).map((l) => ({ ...l, io_no: l.job_io_no }));
  const jobs = groupByJob(lines);
  const jobMeta = new Map<string, any>((dc.summary.jobs as any[]).map((j) => [j.io_no ?? '—', j]));
  const canReceive = ['ISSUED', 'PARTIAL_RECEIVED'].includes(dc.status);
  const t = dc.summary.totals;

  return (
    <Modal open onClose={onClose} size="full" title={`${dc.stage_name ?? 'Job work'} DC ${dc.challan_no}`}
      footer={<>
        <div className="mr-auto flex gap-2">
          {['DRAFT', 'ISSUED'].includes(dc.status) && (
            <Button variant="danger" disabled={busy} onClick={() => { setReason(''); setReasonFor('cancel'); }}><Ban size={13} className="inline mr-1" />Cancel DC</Button>
          )}
          {canReceive && (
            <Button variant="secondary" disabled={busy} onClick={() => { setReason(''); setVariance(''); setReasonFor('close'); }}><Lock size={13} className="inline mr-1" />Close short</Button>
          )}
          {canReceive && dc.dc_kind !== 'FABRIC' && (
            <Button variant="secondary" disabled={busy} id="dc-return-btn" onClick={() => setReturning(true)}>Return unprocessed</Button>
          )}
        </div>
        <Button variant="secondary" onClick={() => printDc(id, toast, false)}><Eye size={13} className="inline mr-1" />Preview DC</Button>
        <Button variant="secondary" onClick={() => printDc(id, toast)}><Printer size={13} className="inline mr-1" />Print DC</Button>
        {dc.status === 'DRAFT' && <Button variant="secondary" onClick={() => onEdit(id)}>Edit draft</Button>}
        {dc.status === 'DRAFT' && (
          <Button loading={busy} onClick={() => act(() => api.post(`/process-dcs/${id}/issue`), `DC ${dc.challan_no} issued`)}>
            <Send size={13} className="inline mr-1" />Issue DC
          </Button>
        )}
        {canReceive && <Button onClick={() => setReceiving(true)}><PackageCheck size={13} className="inline mr-1" />Process inward</Button>}
      </>}>
      <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4 xl:grid-cols-6">
        <Info label="Status"><StatusChip value={dc.status} /></Info>
        <Info label="Contractor">{dc.vendor_name}</Info>
        <Info label="DC date">{fmtDate(dc.challan_date)}</Info>
        <Info label="To process">{dc.stage_name}</Info>
        <Info label="From → to location">{dc.from_location ?? '—'} → {dc.to_location ?? '—'}</Info>
        <Info label="Ref / SR no">{dc.ref_no ?? '—'}</Info>
        <Info label="Expected return">{fmtDate(dc.expected_return)}</Info>
        <Info label="Vehicle / driver">{dc.vehicle_no ?? '—'}{dc.driver_name ? ` · ${dc.driver_name}` : ''}</Info>
        <Info label="Issued">{dc.issued_at ? `${fmtDateTime(dc.issued_at)} · ${dc.issued_by_name ?? ''}` : '—'}</Info>
        <Info label="Rate">{dc.rate != null ? `₹${Number(dc.rate).toFixed(2)} / PCS` : '—'}</Info>
        <Info label="Operations">{dc.operations?.length ? dc.operations.map((o: any) => `${o.op_name} ₹${Number(o.rate).toFixed(2)}`).join(', ') : '—'}</Info>
        <Info label="Remarks">{dc.remarks ?? '—'}</Info>
        {dc.jw_no && <Info label="Job work order"><Link to={`/production/job-work-orders?open=${dc.jw_order_id}`} className="font-mono text-brand-700 hover:underline">{dc.jw_no}</Link>{dc.jw_line_seq ? ` · line ${dc.jw_line_seq}` : ''}</Info>}
        {dc.outward_override_reason && <Info label="Over-plan override">{dc.outward_override_reason}</Info>}
      </div>
      {dc.variance_reason && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Loss over tolerance approved by {dc.variance_approved_by_name ?? '—'}: {dc.variance_reason}</p>
      )}
      {(dc.cancel_reason || dc.close_reason) && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {dc.cancel_reason ? `Cancelled: ${dc.cancel_reason}` : `Closed short: ${dc.close_reason}`}
        </p>
      )}

      <div className="mt-4">
        <SummaryTiles tiles={[
          { label: 'Total jobs', value: String(dc.summary.jobs.length), icon: <Layers size={20} />, tone: 'border-blue-100 bg-blue-50 text-blue-800' },
          { label: 'Total bundles', value: fmtNumber(t.bundles), icon: <Boxes size={20} />, tone: 'border-violet-100 bg-violet-50 text-violet-800' },
          { label: 'Sent (PCS)', value: fmtNumber(t.qty), icon: <Shirt size={20} />, tone: 'border-cyan-100 bg-cyan-50 text-cyan-800' },
          { label: 'Received good (PCS)', value: fmtNumber(t.received), icon: <CheckCircle2 size={20} />, tone: 'border-emerald-100 bg-emerald-50 text-emerald-800' },
          { label: 'Reject + shortage + loss / pending', value: `${fmtNumber(t.rejected + t.shortage + num(t.loss))} / ${fmtNumber(['DRAFT', 'CANCELLED'].includes(dc.status) ? 0 : t.pending)}`, icon: <Weight size={20} />, tone: 'border-amber-100 bg-amber-50 text-amber-800' },
          { label: 'Returned unprocessed / rework open', value: `${fmtNumber(num(t.returned))} / ${fmtNumber(num(t.rework_open))}`, icon: <Boxes size={20} />, tone: 'border-slate-200 bg-slate-50 text-slate-700' },
        ]} />
      </div>

      <div className="mt-4 space-y-3">
        {jobs.map((j, ji) => {
          const m = jobMeta.get(j.key) ?? { io_no: j.key };
          return (
            <div key={j.key} className="overflow-hidden rounded-xl border border-slate-200">
              <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-3 py-2 text-sm ${JOB_TONES[ji % JOB_TONES.length]}`}>
                <span className="mr-auto font-bold text-slate-800">{ji + 1}. {jobTitle(m)}</span>
                <span className="text-xs text-slate-600">Bundles: <b>{m.bundles}</b></span>
                <span className="text-xs text-slate-600">Sent: <b>{fmtNumber(m.qty)}</b></span>
                <span className="text-xs text-slate-600">Received: <b>{fmtNumber(m.received)}</b></span>
                <span className="text-xs text-slate-600">Balance: <b>{fmtNumber(m.pending)}</b></span>
                {!!m.weight_kg && <span className="text-xs text-slate-600">Weight: <b>{kg(num(m.weight_kg))}</b></span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500"><tr>
                    <th className="px-2 py-1.5 text-left">#</th><th className="px-2 py-1.5 text-left">Bundle ID</th>
                    <th className="px-2 py-1.5 text-left">Lay no</th><th className="px-2 py-1.5 text-left">Cut no</th>
                    <th className="px-2 py-1.5 text-left">Part</th><th className="px-2 py-1.5 text-left">Colour</th>
                    <th className="px-2 py-1.5 text-left">Assort colour</th><th className="px-2 py-1.5 text-left">Size</th>
                    <th className="px-2 py-1.5 text-right">Sent</th><th className="px-2 py-1.5 text-right">Received</th>
                    <th className="px-2 py-1.5 text-right">Reject</th><th className="px-2 py-1.5 text-right">Shortage</th>
                    <th className="px-2 py-1.5 text-right">Loss</th><th className="px-2 py-1.5 text-right">Returned</th><th className="px-2 py-1.5 text-right">Rework open</th>
                    <th className="px-2 py-1.5 text-right">Balance</th><th className="px-2 py-1.5 text-right">Weight (KG)</th>
                    <th className="px-2 py-1.5 text-left">Process completed</th><th className="px-2 py-1.5 text-left">Operator / line</th>
                    <th className="px-2 py-1.5 text-left">Status</th><th className="px-2 py-1.5 text-left">Remarks</th>
                  </tr></thead>
                  <tbody>
                    {j.rows.map((l: any, i: number) => (
                      <tr key={l.id} className="border-t border-slate-100">
                        <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                        <td className="px-2 py-1 font-mono font-semibold">
                          <Link to={`/production/traceability?bundle=${encodeURIComponent(l.barcode ?? l.bundle_no)}`} className="text-brand-700 hover:underline">{l.bundle_no}</Link>
                        </td>
                        <td className="px-2 py-1">{l.lay_no ?? '—'}</td><td className="px-2 py-1">{l.cut_no ?? '—'}</td>
                        <td className="px-2 py-1">{l.part ?? '—'}</td><td className="px-2 py-1">{l.color_name}</td>
                        <td className="px-2 py-1 text-slate-500">{l.assort_color ?? '—'}</td>
                        <td className="px-2 py-1 font-semibold">{l.size_code}</td>
                        <td className="px-2 py-1 text-right">{l.qty}</td>
                        <td className="px-2 py-1 text-right text-emerald-700">{num(l.received_qty) || '—'}</td>
                        <td className="px-2 py-1 text-right text-red-600">{num(l.rejected_qty) || '—'}</td>
                        <td className="px-2 py-1 text-right text-orange-600">{num(l.shortage_qty) || '—'}</td>
                        <td className="px-2 py-1 text-right text-orange-600">{num(l.loss_qty) || '—'}</td>
                        <td className="px-2 py-1 text-right text-slate-600">{num(l.returned_qty) || '—'}</td>
                        <td className="px-2 py-1 text-right text-violet-700">{num(l.rework_open_qty) || '—'}</td>
                        <td className="px-2 py-1 text-right font-semibold">{['DRAFT', 'CANCELLED'].includes(dc.status) ? '—' : num(l.pending_qty)}</td>
                        <td className="px-2 py-1 text-right">{l.weight_kg != null ? Number(l.weight_kg).toFixed(2) : '—'}</td>
                        <td className="px-2 py-1">{l.operation_name ?? '—'}</td>
                        <td className="px-2 py-1">{l.operator_line ?? '—'}</td>
                        <td className="px-2 py-1">{lineStatus(l, dc.status)}</td>
                        <td className="px-2 py-1 text-slate-500">{l.remarks ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
        {dc.lines.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs font-semibold text-slate-500">Colour × size breakdown</summary>
            <div className="mt-2"><SizeColorMatrix rows={dc.lines.map((l: any) => ({ color_name: l.color_name, size_code: l.size_code, size_sort: l.size_sort, qty: Number(l.qty) }))} /></div>
          </details>
        )}
      </div>

      {dc.receipts.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-1 text-sm font-semibold text-slate-700">Process inwards against this DC</h4>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              <th className="px-2 py-1 text-left">Inward no</th><th className="px-2 py-1 text-left">Date</th>
              <th className="px-2 py-1 text-left">Party DC</th><th className="px-2 py-1 text-left">Location</th>
              <th className="px-2 py-1 text-right">Good (PCS)</th><th className="px-2 py-1 text-right">Reject (PCS)</th>
              <th className="px-2 py-1 text-right">Shortage (PCS)</th><th className="px-2 py-1 text-right">Loss</th><th className="px-2 py-1 text-right">Returned</th>
              <th className="px-2 py-1 text-right">Rework</th><th className="px-2 py-1 text-left">QC</th><th className="px-2 py-1 text-left">By</th><th className="px-2 py-1 text-left">Remarks</th>
            </tr></thead>
            <tbody>
              {dc.receipts.map((r: any) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono">{r.receipt_no}</td><td className="px-2 py-1">{fmtDate(r.receipt_date)}</td>
                  <td className="px-2 py-1">{r.party_dc_no ?? '—'}{r.party_dc_date ? ` · ${fmtDate(r.party_dc_date)}` : ''}</td>
                  <td className="px-2 py-1">{r.to_location ?? '—'}</td>
                  <td className="px-2 py-1 text-right text-emerald-700">{fmtNumber(r.received_qty)}</td>
                  <td className="px-2 py-1 text-right text-red-600">{fmtNumber(r.rejected_qty)}</td>
                  <td className="px-2 py-1 text-right text-orange-600">{fmtNumber(r.shortage_qty)}</td>
                  <td className="px-2 py-1 text-right">{num(r.loss_qty) || '—'}</td><td className="px-2 py-1 text-right">{num(r.return_qty) || '—'}</td>
                  <td className="px-2 py-1 text-right text-violet-700">{num(r.rework_qty) || '—'}</td>
                  <td className="px-2 py-1">
                    {num(r.received_qty) > 0 ? <Badge tone={r.qc_status === 'ACCEPTED' ? 'green' : r.qc_status === 'REJECTED' ? 'red' : 'amber'}>{r.qc_status ?? 'ACCEPTED'}</Badge> : '—'}
                    {num(r.received_qty) > 0 && !r.contractor_bill_id && (
                      <button className="ml-1 text-[11px] font-semibold text-brand-700 hover:underline" id={`dc-qc-${r.id}`} onClick={() => setQcFor({ ...r, status: r.qc_status === 'ACCEPTED' ? 'REJECTED' : 'ACCEPTED', remarks: '' })}>
                        {r.qc_status === 'ACCEPTED' ? 'QC reject' : 'QC accept'}
                      </button>
                    )}
                  </td>
                  <td className="px-2 py-1">{r.created_by_name}</td><td className="px-2 py-1">{r.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DcAttachments dcId={id} receipts={dc.receipts} />
      <DcAudit dcId={id} />

      {receiving && <InwardModal dcs={[dc]} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); load(); onChanged(); }} />}
      {returning && <ReturnModal dc={dc} onClose={() => setReturning(false)} onDone={() => { setReturning(false); load(); onChanged(); }} />}
      {qcFor && (
        <Modal open onClose={() => setQcFor(null)} size="sm" title={`QC ${qcFor.status === 'ACCEPTED' ? 'accept' : 'reject'} inward ${qcFor.receipt_no}`}
          footer={<>
            <Button variant="secondary" onClick={() => setQcFor(null)}>Back</Button>
            <Button variant={qcFor.status === 'ACCEPTED' ? 'primary' : 'danger'} id="dc-qc-confirm" disabled={qcFor.status === 'REJECTED' && qcFor.remarks.trim().length < 3}
              onClick={() => { const q = qcFor; setQcFor(null); act(() => api.post(`/process-dcs/receipts/${q.id}/qc`, { status: q.status, remarks: q.remarks || null }), `Inward ${q.receipt_no} QC ${q.status.toLowerCase()}`); }}>Confirm</Button>
          </>}>
          <p className="mb-2 text-xs text-slate-600">Only a QC-accepted inward goes on the contractor bill.</p>
          <Textarea label="QC remarks" required={qcFor.status === 'REJECTED'} value={qcFor.remarks} onChange={(e) => setQcFor({ ...qcFor, remarks: e.target.value })} />
        </Modal>
      )}
      {reasonFor && (
        <Modal open onClose={() => setReasonFor(null)} size="sm" title={reasonFor === 'cancel' ? `Cancel DC ${dc.challan_no}` : `Close DC ${dc.challan_no} short`}
          footer={<>
            <Button variant="secondary" onClick={() => setReasonFor(null)}>Back</Button>
            <Button variant="danger" loading={busy} disabled={reason.trim().length < 3}
              onClick={() => { const f = reasonFor; setReasonFor(null); act(() => api.post(`/process-dcs/${id}/${f}`, { reason, variance_reason: variance || null }), f === 'cancel' ? 'DC cancelled' : 'DC closed — pending PCS written off as shortage'); }}>
              Confirm
            </Button>
          </>}>
          <p className="mb-2 text-xs text-slate-600">
            {reasonFor === 'cancel'
              ? 'The DC stays on record as CANCELLED and every bundle quantity returns to where it came from.'
              : `Every pending PCS (${t.pending} PCS) is written off as contractor shortage against its bundle.`}
          </p>
          <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
          {reasonFor === 'close' && (
            <Textarea label="Variance reason (needed when reject + shortage + loss is over the tolerance)" id="dc-close-variance" className="mt-2" value={variance} onChange={(e) => setVariance(e.target.value)} />
          )}
        </Modal>
      )}
    </Modal>
  );
}

/** Unprocessed PCS given back by the contractor (job work doc §14) — back to our stock at the level they left. */
function ReturnModal({ dc, onClose, onDone }: { dc: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const open = (dc.lines as any[]).filter((l) => num(l.pending_qty) > 0);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [partyDc, setPartyDc] = useState('');
  const [busy, setBusy] = useState(false);
  const total = Object.values(qty).reduce((a, v) => a + v, 0);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/process-dcs/${dc.id}/return`, { reason, party_dc_no: partyDc || null,
        lines: open.filter((l) => qty[l.id] > 0).map((l) => ({ line_id: l.id, qty: qty[l.id] })) });
      toast(`${total} PCS returned unprocessed (${r.data.data.receipt_no}) — back in our stock`); onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={`Return unprocessed — DC ${dc.challan_no}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} id="dc-return-save" disabled={!total || reason.trim().length < 3} onClick={save}>Return {total} PCS</Button></>}>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <Input label="Reason" required id="dc-return-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <Input label="Party DC no" value={partyDc} onChange={(e) => setPartyDc(e.target.value)} />
      </div>
      <div className="mb-2 flex justify-end"><Button size="sm" variant="secondary" onClick={() => setQty(Object.fromEntries(open.map((l) => [l.id, num(l.pending_qty)])))}>All pending</Button></div>
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Bundle</th><th className="px-2 py-1 text-left">Colour</th><th className="px-2 py-1 text-left">Size</th>
          <th className="px-2 py-1 text-right">With contractor</th><th className="px-2 py-1 text-right">Return (PCS)</th></tr></thead>
        <tbody>{open.map((l) => (
          <tr key={l.id} className="border-t border-slate-100">
            <td className="px-2 py-1 font-mono">{l.bundle_no ?? '—'}</td><td className="px-2 py-1">{l.color_name}</td><td className="px-2 py-1">{l.size_code}</td>
            <td className="px-2 py-1 text-right">{num(l.pending_qty)}</td>
            <td className="px-2 py-1 text-right"><input type="number" min={0} max={num(l.pending_qty)} id={`dc-return-qty-${l.id}`} className="input h-7 w-16 px-1.5 text-right" value={qty[l.id] ?? 0}
              onChange={(e) => setQty({ ...qty, [l.id]: Math.min(num(l.pending_qty), Math.max(0, Math.floor(Number(e.target.value) || 0))) })} /></td>
          </tr>
        ))}</tbody>
      </table>
    </Modal>
  );
}

/** Files attached to the DC or its inwards — upload goes through POST /uploads (folder attachments). */
function DcAttachments({ dcId, receipts }: { dcId: number; receipts: any[] }) {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [docType, setDocType] = useState('PARTY_DC');
  const [receiptId, setReceiptId] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/process-dcs/${dcId}/attachments`).then((r) => setRows(r.data.data || [])).catch(() => setRows([]));
  useEffect(() => { load(); }, [dcId]);

  const upload = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) { toast('File is larger than 10 MB', 'error'); return; }
    setBusy(true);
    try {
      const data = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(f); });
      const up = (await api.post('/uploads', { filename: f.name, data, folder: 'attachments' })).data.data;
      await api.post(`/process-dcs/${dcId}/attachments`, {
        file_url: up.url, file_name: f.name, mime_type: up.mimeType ?? f.type, size_bytes: up.size ?? f.size,
        doc_type: docType, receipt_id: receiptId ? Number(receiptId) : null,
      });
      toast('Attachment added'); load();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const remove = async (a: any) => {
    try { await api.delete(`/process-dcs/${dcId}/attachments/${a.id}`); load(); } catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <details className="mt-4 rounded-lg border border-slate-200 p-3" open={rows.length > 0}>
      <summary className="cursor-pointer text-sm font-semibold text-slate-700"><Paperclip size={13} className="inline mr-1" />Attachments ({rows.length})</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <select value={docType} onChange={(e) => setDocType(e.target.value)} className="input h-8 w-36">
          <option value="PARTY_DC">Party DC</option><option value="PHOTO">Photo</option><option value="OTHER">Other</option>
        </select>
        <select value={receiptId} onChange={(e) => setReceiptId(e.target.value)} className="input h-8 w-44">
          <option value="">For the DC</option>
          {receipts.map((r: any) => <option key={r.id} value={r.id}>Inward {r.receipt_no}</option>)}
        </select>
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      </div>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className="border-t border-slate-100">
              <td className="py-1"><a href={a.file_url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{a.file_name ?? a.file_url}</a></td>
              <td className="py-1">{a.doc_type.replace('_', ' ')}</td><td className="py-1">{a.receipt_no ? `Inward ${a.receipt_no}` : 'DC'}</td>
              <td className="py-1 text-slate-500">{a.uploaded_by_name} · {fmtDateTime(a.uploaded_at)}</td>
              <td className="py-1 text-right"><button onClick={() => remove(a)} className="text-slate-400 hover:text-red-600" aria-label="Remove"><X size={13} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Audit trail of the DC and its inwards. */
function DcAudit({ dcId }: { dcId: number }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const load = () => { if (!rows) api.get(`/process-dcs/${dcId}/audit`).then((r) => setRows(r.data.data || [])).catch(() => setRows([])); };
  const summary = (v: any) => (v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' · ') : String(v ?? ''));
  return (
    <details className="mt-3 rounded-lg border border-slate-200 p-3" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }}>
      <summary className="cursor-pointer text-sm font-semibold text-slate-700"><History size={13} className="inline mr-1" />Audit trail</summary>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {rows == null && <tr><td className="py-2 text-slate-400">Loading…</td></tr>}
          {rows?.length === 0 && <tr><td className="py-2 text-slate-400">No audit entries.</td></tr>}
          {rows?.map((a) => (
            <tr key={a.id} className="border-t border-slate-100 align-top">
              <td className="py-1 pr-2 whitespace-nowrap text-slate-500">{fmtDateTime(a.changed_at)}</td>
              <td className="py-1 pr-2 whitespace-nowrap">{a.changed_by_name ?? '—'}</td>
              <td className="py-1 pr-2"><Badge tone={a.action === 'INSERT' ? 'green' : 'blue'}>{a.table_name === 'trx_jobwork_receipt' ? 'Inward' : 'DC'} {a.action}</Badge></td>
              <td className="py-1 text-slate-600">{summary(a.new_values)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p><div className="font-medium text-slate-800">{children}</div></div>;
}

// ════════════════════════════════════════════════════════════════════
// Process Inward against a DC — job-wise good / reject (+reason) / shortage
// ════════════════════════════════════════════════════════════════════
type InRow = { g: number; r: number; s: number; x: number; l: number; t: number; w: number; wReason: string; reason: string; kg: string; remarks: string; op: string; operator: string };

/**
 * Process Inward. One DC → POST /process-dcs/:id/receipts; several DCs of the same
 * contractor (one party DC / vehicle) → POST /process-dcs/receipts/batch.
 */
function InwardModal({ dcs, onClose, onDone }: { dcs: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const warehouses = useLookup('warehouses');
  const allOps = useAllOperations();
  const first = dcs[0];
  // Open lines of every DC, tagged with their DC.
  const open = dcs.flatMap((dc) => (dc.lines as any[]).filter((l) => num(l.pending_qty) > 0)
    .map((l) => ({ ...l, io_no: l.job_io_no, _dc: dc })));
  const jobMeta = new Map<string, any>(dcs.flatMap((dc) => (dc.summary.jobs as any[]).map((j) => [j.io_no ?? '—', j] as [string, any])));
  const blank: InRow = { g: 0, r: 0, s: 0, x: 0, l: 0, t: 0, w: 0, wReason: '', reason: '', kg: '', remarks: '', op: '', operator: '' };
  const [rows, setRows] = useState<Record<number, InRow>>(Object.fromEntries(open.map((l) => [l.id, {
    ...blank, op: l.operation_id ? String(l.operation_id) : '', operator: l.operator_line ?? '',
  }])));
  const [head, setHead] = useState({
    receipt_date: today(), party_dc_no: '', party_dc_date: '', ref_no: '', to_warehouse_id: first.to_warehouse_id ?? '', vehicle_no: '', remarks: '',
  });
  const [scan, setScan] = useState('');
  const [last, setLast] = useState<any>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const set = (id: number, patch: Partial<InRow>) => setRows((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  const clampInt = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  const entered = (id: number) => rows[id].g + rows[id].r + rows[id].s + rows[id].l + rows[id].t;

  const onScan = (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    const l = open.find((x) => x.barcode === code || x.bundle_no === code);
    if (!l) toast(`${code} is not pending on ${dcs.length > 1 ? 'these DCs' : 'this DC'}`, 'error');
    else {
      set(l.id, { g: num(l.pending_qty) - rows[l.id].r - rows[l.id].s - rows[l.id].l - rows[l.id].t - rows[l.id].w });
      setLast({ bundle_no: l.bundle_no, io_no: l.io_no, style_code: l.style_code, size_code: l.size_code, qty: num(l.pending_qty), note: `DC ${l._dc.challan_no} · filled as good` });
    }
    setScan('');
  };
  const fillGood = (ls: any[]) => setRows((cur) => {
    const next = { ...cur };
    for (const l of ls) next[l.id] = { ...next[l.id], g: num(l.pending_qty) - next[l.id].r - next[l.id].s - next[l.id].l - next[l.id].t - next[l.id].w };
    return next;
  });
  const restShortage = (ls: any[]) => setRows((cur) => {
    const next = { ...cur };
    for (const l of ls) {
      const x = next[l.id];
      const left = num(l.pending_qty) - x.g - x.r - x.s - x.l - x.t - x.w;
      if (left > 0) next[l.id] = { ...x, s: x.s + left };
    }
    return next;
  });

  const tot = open.reduce((a, l) => ({ p: a.p + num(l.pending_qty), g: a.g + rows[l.id].g, r: a.r + rows[l.id].r, s: a.s + rows[l.id].s, x: a.x + rows[l.id].x,
    l: a.l + rows[l.id].l, t: a.t + rows[l.id].t, w: a.w + rows[l.id].w }), { p: 0, g: 0, r: 0, s: 0, x: 0, l: 0, t: 0, w: 0 });
  const over = open.some((l) => entered(l.id) + rows[l.id].w > num(l.pending_qty));
  const noRework = open.some((l) => rows[l.id].w > 0 && !rows[l.id].wReason.trim());
  const noReason = open.some((l) => rows[l.id].r > 0 && !rows[l.id].reason.trim());
  const badExcess = open.some((l) => rows[l.id].x > 0 && entered(l.id) !== num(l.pending_qty));

  const linesOf = (dc: any) => open.filter((l) => l._dc.id === dc.id && (entered(l.id) > 0 || rows[l.id].x > 0 || rows[l.id].w > 0)).map((l) => ({
    line_id: l.id, received_qty: rows[l.id].g, rejected_qty: rows[l.id].r, shortage_qty: rows[l.id].s, excess_qty: rows[l.id].x,
    loss_qty: rows[l.id].l, return_qty: rows[l.id].t, rework_qty: rows[l.id].w, rework_reason: rows[l.id].wReason || null,
    reject_reason: rows[l.id].reason || null, weight_kg: rows[l.id].kg === '' ? null : Number(rows[l.id].kg), remarks: rows[l.id].remarks || null,
    operation_id: rows[l.id].op ? Number(rows[l.id].op) : null, operator_line: rows[l.id].operator || null,
  }));

  const save = async () => {
    const perDc = dcs.map((dc) => ({ challan_id: dc.id, lines: linesOf(dc) })).filter((d) => d.lines.length);
    if (!perDc.length) { toast('Enter quantities for at least one bundle', 'error'); return; }
    if (noReason) { toast('Give the mistake / reject reason for every rejected bundle', 'error'); return; }
    if (noRework) { toast('Give the rework reason for every bundle sent back for rework', 'error'); return; }
    if (badExcess) { toast('Excess PCS only on a bundle whose pending PCS are all accounted for', 'error'); return; }
    const common = {
      ...head, party_dc_no: head.party_dc_no || null, party_dc_date: head.party_dc_date || null, ref_no: head.ref_no || null,
      to_warehouse_id: head.to_warehouse_id ? Number(head.to_warehouse_id) : null, vehicle_no: head.vehicle_no || null, remarks: head.remarks || null,
    };
    setSaving(true);
    try {
      if (perDc.length === 1) {
        const r = await api.post(`/process-dcs/${perDc[0].challan_id}/receipts`, { ...common, lines: perDc[0].lines });
        toast(`Inward ${r.data.data.receipt_no} saved — DC ${human(r.data.data.dc_status)}`);
      } else {
        const r = await api.post('/process-dcs/receipts/batch', { ...common, dcs: perDc });
        toast(`Inward ${r.data.data.inward_group_no} saved — ${r.data.data.receipts.length} DCs`);
      }
      onDone();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  const status = (l: any) => {
    const x = rows[l.id]; const e = entered(l.id); const p = num(l.pending_qty);
    if (e === 0 && x.w > 0) return <Badge tone="violet">Rework</Badge>;
    if (e === 0) return <Badge tone="slate">Pending</Badge>;
    if (e > p) return <Badge tone="red">Over</Badge>;
    if (x.x > 0) return <Badge tone="blue">Excess</Badge>;
    if (x.s > 0) return <Badge tone="amber">Shortage</Badge>;
    if (x.r > 0) return <Badge tone="red">Rejected</Badge>;
    if (e < p) return <Badge tone="violet">Partial</Badge>;
    return <Badge tone="green">Received</Badge>;
  };

  // Sections: DC → job (a single DC shows jobs only).
  const sections = dcs.flatMap((dc) => groupByJob(open.filter((l) => l._dc.id === dc.id)).map((j) => ({ dc, ...j })));

  return (
    <Modal open onClose={onClose} size="full"
      title={`Process Inward — ${first.stage_name ?? ''} from ${first.vendor_name}${dcs.length > 1 ? ` (${dcs.length} DCs)` : ''}`}
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-600">
          Good <b>{tot.g}</b> · Reject <b>{tot.r}</b> · Shortage <b>{tot.s}</b>{tot.l ? <> · Loss <b>{tot.l}</b></> : null}{tot.t ? <> · Returned unprocessed <b>{tot.t}</b></> : null}{tot.w ? <> · Rework <b>{tot.w}</b></> : null}{tot.x ? <> · Excess <b>{tot.x}</b></> : null} · Still with contractor <b>{tot.p - tot.g - tot.r - tot.s - tot.l - tot.t}</b> PCS
        </span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={saving} disabled={over} onClick={save}><CheckCircle2 size={13} className="inline mr-1" />Save &amp; confirm inward</Button>
      </>}>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
        <div className="xl:col-span-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Input label="Inward no" value="" disabled placeholder="Auto" />
          <Input label={dcs.length > 1 ? 'Source DCs' : 'Source DC no'} value={dcs.map((d) => d.challan_no).join(', ')} disabled />
          <Input label="From process" value={first.stage_name ?? ''} disabled />
          <Input label="Date" type="date" required value={head.receipt_date} onChange={(e) => setHead({ ...head, receipt_date: e.target.value })} />
          <Input label="Contractor" value={first.vendor_name ?? ''} disabled />
          <Select label="Receiving location" value={head.to_warehouse_id} onChange={(e) => setHead({ ...head, to_warehouse_id: e.target.value })}
            placeholder="— store —" options={toOptions(warehouses.data)} />
          <Input label="Party DC no" value={head.party_dc_no} onChange={(e) => setHead({ ...head, party_dc_no: e.target.value })} />
          <Input label="Party DC date" type="date" value={head.party_dc_date} onChange={(e) => setHead({ ...head, party_dc_date: e.target.value })} />
          <Input label="Ref / SR no" value={head.ref_no} onChange={(e) => setHead({ ...head, ref_no: e.target.value })} />
          <Input label="Vehicle no" value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value.toUpperCase() })} />
          <Input label="Remarks" value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} className="md:col-span-2" />
        </div>
        <ScanCard value={scan} onChange={setScan} onSubmit={onScan} placeholder="Scan returned bundle — fills pending as good" last={last} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2">
        <span className="mr-auto text-sm font-semibold text-slate-800">Job / style details</span>
        <Button size="sm" variant="secondary" onClick={() => fillGood(open)}>All pending good</Button>
        <Button size="sm" variant="secondary" onClick={() => restShortage(open)}>Rest as shortage</Button>
      </div>

      <div className="mt-3 space-y-3">
        {sections.map((j, ji) => {
          const key = `${j.dc.id}|${j.key}`;
          const m = jobMeta.get(j.key) ?? { io_no: j.key };
          const jp = j.rows.reduce((a: number, l: any) => a + num(l.pending_qty), 0);
          const jg = j.rows.reduce((a: number, l: any) => a + rows[l.id].g, 0);
          const isCollapsed = collapsed.has(key);
          return (
            <div key={key} className="overflow-hidden rounded-xl border border-slate-200">
              <div className={`flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-3 py-2 text-sm ${JOB_TONES[ji % JOB_TONES.length]}`}>
                <button onClick={() => { const s2 = new Set(collapsed); if (s2.has(key)) s2.delete(key); else s2.add(key); setCollapsed(s2); }} className="text-slate-600" aria-label="Collapse">
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </button>
                <span className="mr-auto font-bold text-slate-800">
                  {ji + 1}. {dcs.length > 1 && <span className="font-mono text-xs text-slate-500">DC {j.dc.challan_no} · </span>}{jobTitle(m)}
                </span>
                <span className="text-xs text-slate-600">Bundles: <b>{j.rows.length}</b></span>
                <span className="text-xs text-slate-600">Sent (pending): <b>{fmtNumber(jp)}</b></span>
                <span className="text-xs text-slate-600">Received: <b>{fmtNumber(jg)}</b></span>
                <span className="text-xs text-slate-600">Balance: <b>{fmtNumber(jp - jg)}</b></span>
                <button onClick={() => fillGood(j.rows)} className="rounded border border-emerald-200 bg-white px-2 py-0.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">
                  Job all good
                </button>
              </div>
              {!isCollapsed && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-500"><tr>
                      <th className="px-2 py-1.5 text-left">#</th><th className="px-2 py-1.5 text-left">Bundle ID</th>
                      <th className="px-2 py-1.5 text-left">Lay no</th><th className="px-2 py-1.5 text-left">Cut no</th>
                      <th className="px-2 py-1.5 text-left">Colour</th><th className="px-2 py-1.5 text-left">Assort colour</th>
                      <th className="px-2 py-1.5 text-left">Size</th><th className="px-2 py-1.5 text-right">Sent (PCS)</th>
                      <th className="px-2 py-1.5 text-right">Received (PCS)</th>
                      <th className="px-2 py-1.5 text-right">Mistake / reject</th><th className="px-2 py-1.5 text-left">Reject reason</th>
                      <th className="px-2 py-1.5 text-right">Shortage</th>
                      <th className="px-2 py-1.5 text-right" title="Approved process loss">Loss</th>
                      <th className="px-2 py-1.5 text-right" title="Unprocessed PCS returned — back to our stock">Returned</th>
                      <th className="px-2 py-1.5 text-right" title="Sent back to the contractor for rework — stays pending">Rework</th><th className="px-2 py-1.5 text-left">Rework reason</th>
                      <th className="px-2 py-1.5 text-right">Excess</th>
                      <th className="px-2 py-1.5 text-right">Difference</th><th className="px-2 py-1.5 text-right">Weight (KG)</th>
                      <th className="px-2 py-1.5 text-left">Process completed</th><th className="px-2 py-1.5 text-left">Operator / line</th>
                      <th className="px-2 py-1.5 text-left">Status</th><th className="px-2 py-1.5 text-left">Remarks</th>
                    </tr></thead>
                    <tbody>
                      {j.rows.map((l: any, i: number) => {
                        const x = rows[l.id]; const p = num(l.pending_qty); const diff = x.g + x.x - p;
                        const bad = entered(l.id) + x.w > p || (x.x > 0 && entered(l.id) !== p);
                        return (
                          <tr key={l.id} className={`border-t border-slate-100 ${bad ? 'bg-red-50' : x.s > 0 || x.r > 0 ? 'bg-amber-50/50' : ''}`}>
                            <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                            <td className="px-2 py-1 font-mono font-semibold">{l.bundle_no}</td>
                            <td className="px-2 py-1">{l.lay_no ?? '—'}</td><td className="px-2 py-1">{l.cut_no ?? '—'}</td>
                            <td className="px-2 py-1">{l.color_name}</td><td className="px-2 py-1 text-slate-500">{l.assort_color ?? '—'}</td>
                            <td className="px-2 py-1 font-semibold">{l.size_code}</td>
                            <td className="px-2 py-1 text-right font-semibold">{p}{num(l.qty) !== p && <span className="text-slate-400"> / {l.qty}</span>}</td>
                            <td className="px-2 py-1 text-right"><input type="number" min={0} value={x.g} onChange={(e) => set(l.id, { g: clampInt(e.target.value) })} className={`input h-7 w-16 px-1.5 text-right ${bad ? 'input-error' : ''}`} /></td>
                            <td className="px-2 py-1 text-right"><input type="number" min={0} value={x.r} onChange={(e) => set(l.id, { r: clampInt(e.target.value) })} className="input h-7 w-16 px-1.5 text-right" /></td>
                            <td className="px-2 py-1">
                              <input value={x.reason} disabled={!x.r} placeholder={x.r ? 'Required' : ''} onChange={(e) => set(l.id, { reason: e.target.value })}
                                className={`input h-7 w-36 px-1.5 ${x.r && !x.reason.trim() ? 'input-error' : ''}`} />
                            </td>
                            <td className="px-2 py-1 text-right"><input type="number" min={0} value={x.s} onChange={(e) => set(l.id, { s: clampInt(e.target.value) })} className="input h-7 w-16 px-1.5 text-right" /></td>
                            <td className="px-2 py-1 text-right"><input type="number" min={0} value={x.l} id={`in-loss-${l.id}`} onChange={(e) => set(l.id, { l: clampInt(e.target.value) })} className="input h-7 w-14 px-1.5 text-right" /></td>
                            <td className="px-2 py-1 text-right"><input type="number" min={0} value={x.t} id={`in-ret-${l.id}`} onChange={(e) => set(l.id, { t: clampInt(e.target.value) })} className="input h-7 w-14 px-1.5 text-right" /></td>
                            <td className="px-2 py-1 text-right"><input type="number" min={0} value={x.w} id={`in-rework-${l.id}`} onChange={(e) => set(l.id, { w: clampInt(e.target.value) })} className="input h-7 w-14 px-1.5 text-right" /></td>
                            <td className="px-2 py-1"><input value={x.wReason} disabled={!x.w} placeholder={x.w ? 'Required' : ''} id={`in-rework-reason-${l.id}`} onChange={(e) => set(l.id, { wReason: e.target.value })}
                              className={`input h-7 w-32 px-1.5 ${x.w && !x.wReason.trim() ? 'input-error' : ''}`} /></td>
                            <td className="px-2 py-1 text-right"><input type="number" min={0} value={x.x} title="PCS returned beyond the DC qty (recorded only)" onChange={(e) => set(l.id, { x: clampInt(e.target.value) })} className="input h-7 w-14 px-1.5 text-right" /></td>
                            <td className={`px-2 py-1 text-right font-semibold ${diff < 0 ? 'text-red-600' : diff > 0 ? 'text-blue-600' : 'text-slate-500'}`}>{entered(l.id) || x.x ? diff : '—'}</td>
                            <td className="px-2 py-1 text-right"><input type="number" min={0} step="0.01" value={x.kg} placeholder={l.weight_kg != null ? Number(l.weight_kg).toFixed(2) : '—'} onChange={(e) => set(l.id, { kg: e.target.value })} className="input h-7 w-20 px-1.5 text-right" /></td>
                            <td className="px-2 py-1">
                              <select value={x.op} onChange={(e) => set(l.id, { op: e.target.value })} className="input h-7 w-32 px-1">
                                <option value="">—</option>
                                {allOps.map((o) => <option key={o.id} value={o.id}>{o.op_name}</option>)}
                              </select>
                            </td>
                            <td className="px-2 py-1"><input value={x.operator} onChange={(e) => set(l.id, { operator: e.target.value.toUpperCase() })} className="input h-7 w-24 px-1.5" /></td>
                            <td className="px-2 py-1">{status(l)}</td>
                            <td className="px-2 py-1"><input value={x.remarks} onChange={(e) => set(l.id, { remarks: e.target.value })} className="input h-7 w-36 px-1.5" /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-xl border border-red-100 bg-red-50/30 p-3">
        <p className="mb-2 text-sm font-bold text-red-700">DC level summary</p>
        <SummaryTiles tiles={[
          { label: 'Total jobs', value: String(new Set(open.map((l) => l.io_no ?? '—')).size), icon: <Layers size={20} />, tone: 'border-blue-100 bg-blue-50 text-blue-800' },
          { label: 'Total bundles', value: fmtNumber(open.length), icon: <Boxes size={20} />, tone: 'border-violet-100 bg-violet-50 text-violet-800' },
          { label: 'Sent qty (pending)', value: fmtNumber(tot.p), icon: <Shirt size={20} />, tone: 'border-cyan-100 bg-cyan-50 text-cyan-800' },
          { label: 'Total received (good)', value: fmtNumber(tot.g), icon: <CheckCircle2 size={20} />, tone: 'border-emerald-100 bg-emerald-50 text-emerald-800' },
          { label: 'Total difference', value: fmtNumber(tot.g + tot.x - tot.p), icon: <Weight size={20} />, tone: 'border-rose-100 bg-rose-50 text-rose-800' },
        ]} />
      </div>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
// DC print — challan listing bundles job-wise, grouped by colour / size
// ════════════════════════════════════════════════════════════════════
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

async function printDc(id: number, toast: (m: string, k?: any) => void, autoPrint = true) {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) { toast('Allow pop-ups to print the DC', 'error'); return; }
  try {
    const d = (await api.get(`/process-dcs/${id}/print`)).data.data;
    const c = d.company ?? {}; const va = d.vendor_address ?? {};
    const lines = (d.lines as any[]).map((l) => ({ ...l, io_no: l.job_io_no }));
    const meta = new Map<string, any>((d.summary.jobs as any[]).map((j) => [j.io_no ?? '—', j]));
    const body = groupByJob(lines).map((j, ji) => {
      const m = meta.get(j.key) ?? {};
      const title = [j.key === '—' ? 'No job' : j.key, m.buyer_name, m.buyer_po_no ? `PO ${m.buyer_po_no}` : '', m.style_codes?.length ? `Style ${m.style_codes.join(', ')}` : '']
        .filter(Boolean).join(' · ');
      const rows = groupByColorSize(j.rows).map((g) => g.sizes.map((s) => {
        const qty = s.rows.reduce((a: number, l: any) => a + Number(l.qty), 0);
        const assort = [...new Set(s.rows.map((l: any) => l.assort_color).filter(Boolean))].join(', ');
        return `<tr><td>${esc(g.color)}${assort ? `<br/><small>${esc(assort)}</small>` : ''}</td><td>${esc(s.size)}</td><td class="bundles">${s.rows.map((l: any) => `${esc(l.bundle_no)} <small>(${l.qty})</small>`).join(', ')}</td>
          <td class="r">${s.rows.length}</td><td class="r">${qty}</td></tr>`;
      }).join('')).join('');
      return `<tr class="grp"><td colspan="5">${ji + 1}. ${esc(title)}</td></tr>${rows}
        <tr class="sub"><td colspan="3">Job total</td><td class="r">${m.bundles ?? j.rows.length}</td><td class="r">${m.qty ?? ''}</td></tr>`;
    }).join('');
    const sizes: string[] = d.summary.sizes;
    const matrix = `<table class="grid"><thead><tr><th>Colour \\ Size</th>${sizes.map((s) => `<th class="r">${esc(s)}</th>`).join('')}<th class="r">Total PCS</th></tr></thead><tbody>
      ${d.summary.colors.map((cl: any) => `<tr><td>${esc(cl.color_name)}</td>${cl.sizes.map((z: any) => `<td class="r">${z.qty || '—'}</td>`).join('')}<td class="r"><b>${cl.qty}</b></td></tr>`).join('')}
      <tr class="sub"><td>Total</td>${d.summary.sizeTotals.map((z: any) => `<td class="r">${z.qty}</td>`).join('')}<td class="r">${d.summary.totals.qty}</td></tr></tbody></table>`;
    const t = d.summary.totals;
    w.document.write(`<!doctype html><html><head><title>${esc(d.challan_no)}</title><style>
      body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;margin:18px}
      h1{font-size:16px;margin:0} h2{font-size:13px;margin:6px 0;text-align:center;letter-spacing:1px}
      table{width:100%;border-collapse:collapse;margin-top:8px} th,td{border:1px solid #444;padding:3px 5px;vertical-align:top}
      th{background:#eee;text-align:left} .r{text-align:right} .grp td{background:#222;color:#fff;font-weight:bold}
      .sub td{background:#f2f2f2;font-weight:bold} .bundles{font-family:monospace;font-size:10.5px} small{color:#555}
      .hdr{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:6px}
      .meta td{border:none;padding:2px 4px} .sign{display:flex;justify-content:space-between;margin-top:48px}
      .sign div{border-top:1px solid #111;width:30%;text-align:center;padding-top:4px} .note{font-size:10px;margin-top:8px}
      @media print{button{display:none}}
    </style></head><body>
      <div class="hdr"><div><h1>${esc(c.legal_name || c.trade_name)}</h1>
        <div>${esc([c.address_line1, c.address_line2, c.city, c.state, c.pincode].filter(Boolean).join(', '))}</div>
        <div>GSTIN: ${esc(c.gstin || '—')} · Ph: ${esc(c.phone || '—')}</div></div>
        <div style="text-align:right">${barcodeHtml(d.challan_no)}<b>DC No: ${esc(d.challan_no)}</b><br/>Date: ${esc(fmtDate(d.challan_date))}<br/>
          ${d.ref_no ? `Ref / SR: ${esc(d.ref_no)}<br/>` : ''}Status: ${esc(human(d.status))}</div></div>
      <h2>DELIVERY CHALLAN — JOB WORK (${esc(String(d.stage_name || '').toUpperCase())})</h2>
      <table class="meta"><tr>
        <td style="width:50%"><b>To (contractor):</b> ${esc(d.vendor_name)} (${esc(d.vendor_code || '')})<br/>
          ${esc([va.address_line1, va.address_line2, va.address_line3, va.city, va.state, va.pincode].filter(Boolean).join(', '))}<br/>
          GSTIN: ${esc(d.vendor_gstin || '—')} · Ph: ${esc(va.mobile || va.phone || d.vendor_phone || '—')}</td>
        <td><b>Process:</b> ${esc(d.stage_name)} · <b>Jobs:</b> ${d.summary.jobs.length}<br/>
          ${d.operations?.length ? `<b>Operations:</b> ${esc(d.operations.map((o: any) => o.op_name).join(', '))}<br/>` : ''}
          <b>From / to location:</b> ${esc(d.from_location || '—')} → ${esc(d.to_location || '—')}<br/>
          <b>Vehicle:</b> ${esc(d.vehicle_no || '—')} · <b>Driver:</b> ${esc(d.driver_name || '—')}<br/>
          <b>Transporter:</b> ${esc(d.transporter || '—')} · <b>Expected return:</b> ${esc(fmtDate(d.expected_return))}</td>
      </tr></table>
      <table><thead><tr><th style="width:14%">Colour</th><th style="width:7%">Size</th><th>Bundle numbers (PCS)</th><th class="r" style="width:8%">Bundles</th><th class="r" style="width:9%">PCS</th></tr></thead>
        <tbody>${body}<tr class="sub"><td colspan="3">GRAND TOTAL — ${d.summary.jobs.length} job(s)${t.weight_kg ? ` · ${Number(t.weight_kg).toFixed(2)} KG` : ''}</td><td class="r">${t.bundles}</td><td class="r">${t.qty}</td></tr></tbody></table>
      ${matrix}
      <p class="note">Goods sent for job work and to be returned after processing — not for sale. ${esc(d.remarks || '')}</p>
      <div class="sign"><div>Prepared by</div><div>Checked / Security</div><div>Receiver's signature &amp; seal</div></div>
      <button onclick="window.print()" style="margin-top:16px">Print</button>
    </body></html>`);
    w.document.close();
    w.focus();
    if (autoPrint) setTimeout(() => w.print(), 300);
  } catch (e) { w.close(); toast(errMsg(e), 'error'); }
}

// ════════════════════════════════════════════════════════════════════
// Process Inward register + "select DC" to post a new inward
// ════════════════════════════════════════════════════════════════════
export function ProcessDcReceiptsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(false);
  const [dcs, setDcs] = useState<any[] | null>(null);
  const load = () => {
    setLoading(true);
    api.get('/process-dcs/receipts').then((r) => setRows(r.data.data || []))
      .catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const pick = async (ids: number[]) => {
    setSelecting(false);
    try { setDcs(await Promise.all(ids.map(async (id) => (await api.get(`/process-dcs/${id}`)).data.data))); } catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Process Inward</h1>
          <p className="text-sm text-slate-500">Goods received back against process DCs — job-wise good, mistake / reject and shortage per bundle</p>
        </div>
        <div className="flex gap-2">
          <Link to="/production/jobwork-challans" className="btn-secondary">Process Outward (DC)</Link>
          <Button onClick={() => setSelecting(true)}><Plus size={14} className="inline mr-1" />New inward</Button>
        </div>
      </div>
      <Card>
        <DataTable data={rows} loading={loading} emptyTitle="No inwards yet"
          columns={[
            { key: 'receipt_no', header: 'Inward no', render: (r: any) => <span className="font-mono text-[12px] font-semibold text-brand-700">{r.receipt_no}</span> },
            { key: 'receipt_date', header: 'Date', render: (r: any) => fmtDate(r.receipt_date) },
            { key: 'challan_no', header: 'Source DC', render: (r: any) => <Link className="font-mono text-brand-700 hover:underline" to={`/production/jobwork-challans?dc=${r.challan_id}`}>{r.challan_no}</Link> },
            { key: 'party_dc_no', header: 'Party DC / Ref', render: (r: any) => <span className="text-xs">{r.party_dc_no ?? '—'}{r.ref_no ? ` · ${r.ref_no}` : ''}{r.inward_group_no ? <span className="block font-mono text-[10px] text-slate-400">{r.inward_group_no}</span> : null}</span> },
            { key: 'stage_name', header: 'Process', render: (r: any) => r.stage_name ? <Badge tone="violet">{r.stage_name}</Badge> : '—' },
            { key: 'vendor_name', header: 'Contractor' },
            { key: 'io_list', header: 'Jobs', render: (r: any) => <span className="text-xs">{r.io_list ?? '—'}</span> },
            { key: 'line_count', header: 'Bundles', align: 'right' as const },
            { key: 'received_qty', header: 'Good (PCS)', align: 'right' as const, render: (r: any) => <span className="text-emerald-700">{fmtNumber(r.received_qty)}</span> },
            { key: 'rejected_qty', header: 'Reject (PCS)', align: 'right' as const, render: (r: any) => Number(r.rejected_qty) ? <span className="text-red-600">{fmtNumber(r.rejected_qty)}</span> : '—' },
            { key: 'shortage_qty', header: 'Shortage (PCS)', align: 'right' as const, render: (r: any) => Number(r.shortage_qty) ? <span className="text-orange-600">{fmtNumber(r.shortage_qty)}</span> : '—' },
            { key: 'excess_qty', header: 'Excess (PCS)', align: 'right' as const, render: (r: any) => Number(r.excess_qty) ? <span className="text-blue-600">{fmtNumber(r.excess_qty)}</span> : '—' },
            { key: 'dc_status', header: 'DC status', render: (r: any) => <StatusBadge value={r.dc_status} /> },
          ]} />
      </Card>
      {selecting && <SelectDcModal onClose={() => setSelecting(false)} onPick={pick} />}
      {dcs && <InwardModal dcs={dcs} onClose={() => setDcs(null)} onDone={() => { setDcs(null); load(); }} />}
    </div>
  );
}

/** Pending DCs to receive against (DC qty / received / balance) — legacy "Select DC's". */
function SelectDcModal({ onClose, onPick }: { onClose: () => void; onPick: (ids: number[]) => void }) {
  const toast = useToast();
  const contractors = useContractors();
  const [stages, setStages] = useState<Stage[]>([]);
  const [stageId, setStageId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const pickedVendor = rows.find((r) => picked.has(r.id))?.vendor_id;

  useEffect(() => { api.get('/process-dcs/stages').then((r) => setStages(r.data.data || [])); }, []);
  useEffect(() => {
    setLoading(true);
    api.get('/process-dcs', { params: { status: 'OPEN', stage_id: stageId || undefined, vendor_id: vendorId || undefined, q: dq || undefined } })
      .then((r) => setRows(r.data.data || [])).catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  }, [stageId, vendorId, dq]);

  return (
    <Modal open onClose={onClose} size="xl" title="Select DC(s) to receive against"
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-500">Tick several DCs of the same contractor for one inward (one party DC / vehicle)</span>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button disabled={!picked.size} onClick={() => onPick([...picked])}>Receive {picked.size || ''} DC(s)</Button>
      </>}>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-3">
        <Select value={stageId} onChange={(e) => setStageId(e.target.value)} placeholder="All processes" options={stages.map((s) => ({ value: s.id, label: s.stage_name }))} />
        <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} placeholder="All contractors" options={contractors.map((c) => ({ value: c.id, label: c.label }))} />
        <SearchInput value={q} onChange={setQ} placeholder="DC no or bundle no…" />
      </div>
      <table className="w-full text-xs">
        <thead className="bg-slate-50 text-slate-500"><tr>
          <th className="w-8 px-2 py-1.5" /><th className="px-2 py-1.5 text-left">DC no</th><th className="px-2 py-1.5 text-left">Date</th>
          <th className="px-2 py-1.5 text-left">Contractor</th><th className="px-2 py-1.5 text-left">Process</th>
          <th className="px-2 py-1.5 text-left">Jobs</th><th className="px-2 py-1.5 text-right">DC qty</th>
          <th className="px-2 py-1.5 text-right">Received qty</th><th className="px-2 py-1.5 text-right">Balance qty</th>
        </tr></thead>
        <tbody>
          {loading && <tr><td colSpan={9} className="py-6 text-center text-slate-400">Loading…</td></tr>}
          {!loading && !rows.length && <tr><td colSpan={9} className="py-6 text-center text-slate-400">No DCs pending receipt.</td></tr>}
          {rows.map((r) => {
            const other = pickedVendor != null && Number(pickedVendor) !== Number(r.vendor_id);
            return (
            <tr key={r.id} onClick={() => { if (other) return; setPicked((cur) => { const n2 = new Set(cur); if (n2.has(r.id)) n2.delete(r.id); else n2.add(r.id); return n2; }); }}
              className={`border-t border-slate-100 ${other ? 'opacity-40' : 'cursor-pointer hover:bg-brand-50/40'}`}>
              <td className="px-2 py-1.5 text-center"><input type="checkbox" readOnly disabled={other} checked={picked.has(r.id)} /></td>
              <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">{r.challan_no}</td>
              <td className="px-2 py-1.5">{fmtDate(r.challan_date)}</td>
              <td className="px-2 py-1.5">{r.vendor_name}</td>
              <td className="px-2 py-1.5">{r.stage_name}</td>
              <td className="px-2 py-1.5">{r.io_list ?? '—'}</td>
              <td className="px-2 py-1.5 text-right">{fmtNumber(r.issued_pcs)}</td>
              <td className="px-2 py-1.5 text-right text-emerald-700">{fmtNumber(Number(r.received_pcs) + Number(r.rejected_pcs) + Number(r.shortage_pcs))}</td>
              <td className="px-2 py-1.5 text-right font-semibold text-amber-700">{fmtNumber(r.pending_pcs)}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </Modal>
  );
}

// ════════════════════════════════════════════════════════════════════
// Panel conversion — front / back panels (colours may differ) combined
// into one garment piece before stitching
// ════════════════════════════════════════════════════════════════════
function PanelConversionModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const colors = useLookup('colors');
  const [panels, setPanels] = useState<Avail[]>([]);
  const [scan, setScan] = useState('');
  const [part, setPart] = useState('TOP');
  const [colorId, setColorId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<any>(null);
  const minBal = panels.length ? Math.min(...panels.map((p) => p.available_qty)) : 0;

  const onScan = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    setScan('');
    if (!code) return;
    if (panels.some((p) => p.barcode === code || p.bundle_no === code)) { toast(`${code} is already listed`, 'warning'); return; }
    try {
      const r = await api.get('/bundle-stock/available', { params: { level: 'CUT', q: code, include_zero: 1 } });
      const hit: Avail | undefined = (r.data.data || []).find((b: Avail) => b.barcode === code || b.bundle_no === code);
      if (!hit) toast(`Bundle ${code} not found`, 'error');
      else if (hit.available_qty <= 0) toast(`${hit.bundle_no} has no PCS at cutting`, 'error');
      else if (panels.length && (hit.io_no !== panels[0].io_no || hit.style_code !== panels[0].style_code || hit.size_code !== panels[0].size_code)) {
        toast('Panels must be of the same job, style and size', 'error');
      } else setPanels((cur) => [...cur, hit]);
    } catch (err) { toast(errMsg(err), 'error'); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post('/bundles/panel-convert', {
        bundle_ids: panels.map((p) => p.id), part_name: part, color_id: colorId ? Number(colorId) : null,
        qty: qty ? Number(qty) : null, reason,
      });
      setDone(r.data.data);
      toast(`Panel bundle ${r.data.data.bundle_no} created — ${r.data.data.qty} PCS`);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} size="lg" title="Panel conversion"
      footer={done ? <Button onClick={onClose}>Done</Button> : <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={saving} disabled={panels.length < 2 || !part.trim() || reason.trim().length < 3} onClick={save}>
          <Combine size={13} className="inline mr-1" />Convert {qty || minBal || ''} PCS
        </Button>
      </>}>
      {done ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
          <p className="font-semibold text-emerald-800">New bundle <span className="font-mono">{done.bundle_no}</span> · barcode <span className="font-mono">{done.barcode}</span></p>
          <p className="mt-1 text-slate-700">{done.qty} PCS of {done.part_name}, made from {done.sources.map((x: any) => `${x.bundle_no} (${x.part_name ?? '—'})`).join(' + ')}.</p>
          <p className="mt-1 text-xs text-slate-500">It is at cutting and can go on a Stitching DC; the panel bundles keep their history in traceability.</p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-500">
            Scan the panel bundles of one garment — e.g. the front in one colour and the back in another. Each panel gives the same
            number of PCS and together they become one bundle of the output part.
          </p>
          <form onSubmit={onScan} className="mb-3 flex gap-2">
            <div className="relative flex-1">
              <ScanLine size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-600" />
              <input value={scan} onChange={(e) => setScan(e.target.value)} className="input pl-9 font-mono" placeholder="Scan panel bundle + Enter" autoFocus />
            </div>
            <Button type="submit" variant="secondary">Add</Button>
          </form>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>
              <th className="px-2 py-1.5 text-left">Bundle</th><th className="px-2 py-1.5 text-left">Job</th><th className="px-2 py-1.5 text-left">Style</th>
              <th className="px-2 py-1.5 text-left">Part</th><th className="px-2 py-1.5 text-left">Colour</th><th className="px-2 py-1.5 text-left">Size</th>
              <th className="px-2 py-1.5 text-right">At cutting</th><th className="w-8" />
            </tr></thead>
            <tbody>
              {!panels.length && <tr><td colSpan={8} className="py-6 text-center text-slate-400">No panels yet.</td></tr>}
              {panels.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono font-semibold">{p.bundle_no}</td><td className="px-2 py-1">{p.io_no}</td>
                  <td className="px-2 py-1">{p.style_code}</td><td className="px-2 py-1">{p.part_name ?? '—'}</td>
                  <td className="px-2 py-1">{p.color_name}</td><td className="px-2 py-1 font-semibold">{p.size_code}</td>
                  <td className="px-2 py-1 text-right">{p.available_qty}</td>
                  <td className="px-1"><button onClick={() => setPanels((cur) => cur.filter((x) => x.id !== p.id))} className="text-slate-400 hover:text-red-600" aria-label="Remove"><X size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <Input label="Output part" required value={part} onChange={(e) => setPart(e.target.value.toUpperCase())} />
            <Select label="Output colour" value={colorId} onChange={(e) => setColorId(e.target.value)}
              placeholder={panels[0] ? `Same as ${panels[0].color_name}` : 'Same as first panel'} options={toOptions(colors.data)} />
            <Input label="PCS to convert" type="number" min={1} max={minBal || undefined} value={qty} placeholder={minBal ? String(minBal) : ''}
              onChange={(e) => setQty(e.target.value)} />
            <Textarea label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} className="md:col-span-3" rows={2} />
          </div>
        </>
      )}
    </Modal>
  );
}
