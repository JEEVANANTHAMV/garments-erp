import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, ChevronDown, ChevronRight, Trash2, ArrowRight, ChevronsRight, ChevronLeft,
  Layers, Boxes, AlertTriangle, CheckCircle2, Settings2, Zap, FolderOpen, FilePlus2,
  Search, Printer, Save, Check, X,
} from 'lucide-react';
import { Card, Badge, Button, Input, Select, SearchInput, Tabs, Modal, useDebounced } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import {
  type Proc, type BundleInfo, PROC_LABEL, n, pct, groupByJob, JobHeaderRow, SummaryCard, UtilBar, distinct,
  EMPTY_FILTERS, applyFilters, summarize, SummaryTable, DocumentsModal, DocStatus, printDocument, printRowsByJob,
  type RowFilters,
} from './linePlanUi';

/**
 * Line Allocation (Sewing / Checking) — developer doc §4–§7, §11; client call 28-Sep-2026.
 *
 * Left: pending jobs and unallocated bundles (one heading per job, bundles beneath).
 * Right: lines with capacity and the bundles allocated to each line.
 * Bundle-wise: tick bundles → Allocate. Job-wise: tick jobs → Allocate moves all their bundles.
 * The server re-checks stock, duplicates, inactive lines and capacity on every save.
 */

type Stock = BundleInfo & { ready_qty: number; allocated_elsewhere: number; available_qty: number };
type Line = {
  id: number; line_code: string; line_name: string; capacity_pcs: number; manpower: number; sam_per_pcs: number;
  supervisor_name?: string | null; floor_name?: string | null; is_active: number; allocated_other: number;
};
type Alloc = Stock & { line_id: number; allocated_qty: number; remarks: string };

const TABS = [
  { key: 'line', label: 'Line Allocation' },
  { key: 'job', label: 'Job Summary' },
  { key: 'style', label: 'Style Summary' },
  { key: 'colour', label: 'Colour Summary' },
  { key: 'size', label: 'Size Summary' },
];

export function LineAllocationPage({ proc }: { proc: Proc }) {
  const toast = useToast();
  const nav = useNavigate();
  const { can } = useAuth();
  const shifts = useLookup('shifts');
  const label = PROC_LABEL[proc];

  // Header
  const [docId, setDocId] = useState<number | null>(null);
  const [docNo, setDocNo] = useState<string | null>(null);
  const [docStatus, setDocStatus] = useState<string | null>(null);
  const [allocDate, setAllocDate] = useState(today());
  const [floorName, setFloorName] = useState(`${label} Floor-1`);
  const [shiftId, setShiftId] = useState('');
  const [planType, setPlanType] = useState<'LINE_WISE' | 'JOB_WISE'>('LINE_WISE');
  const [remarks, setRemarks] = useState('');
  const [override, setOverride] = useState(false);
  const editable = !docStatus || ['DRAFT', 'SAVED'].includes(docStatus);

  // Data
  const [lines, setLines] = useState<Line[]>([]);
  const [stock, setStock] = useState<Stock[]>([]);
  const [allocs, setAllocs] = useState<Alloc[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Selection / view
  const [selBundles, setSelBundles] = useState<Set<number>>(new Set());
  const [selJobs, setSelJobs] = useState<Set<string>>(new Set());
  const [selAlloc, setSelAlloc] = useState<Set<number>>(new Set());
  const [targetLine, setTargetLine] = useState<number | null>(null);
  const [openLines, setOpenLines] = useState<Set<number>>(new Set());
  const [closedJobs, setClosedJobs] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState('line');
  const [filters, setFilters] = useState<RowFilters>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const dq = useDebounced(search);
  const [showDocs, setShowDocs] = useState(false);
  const [pickerLine, setPickerLine] = useState<number | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const loadStock = useCallback(async (excludeId: number | null, date: string) => {
    setLoading(true);
    try {
      const [l, s] = await Promise.all([
        api.get(`/${proc}/lines`, { params: { date, exclude_id: excludeId ?? 0 } }),
        api.get(`/${proc}/unallocated-bundles`, { params: { exclude_id: excludeId ?? 0 } }),
      ]);
      const ls: Line[] = l.data.data || [];
      setLines(ls);
      setStock(s.data.data || []);
      setTargetLine((t) => t ?? ls[0]?.id ?? null);
      setOpenLines((o) => (o.size ? o : new Set(ls.slice(0, 1).map((x) => x.id))));
    } catch (e: any) {
      toast(e?.message || 'Failed to load bundles', 'error');
    } finally {
      setLoading(false);
    }
  }, [proc, toast]);

  useEffect(() => { loadStock(docId, allocDate); }, [loadStock, docId, allocDate]);

  const resetNew = () => {
    setDocId(null); setDocNo(null); setDocStatus(null); setAllocs([]); setRemarks(''); setOverride(false);
    setSelBundles(new Set()); setSelJobs(new Set()); setSelAlloc(new Set());
  };

  const openDoc = async (id: number) => {
    try {
      const r = await api.get(`/${proc}/line-allocation/${id}`);
      const d = r.data.data;
      setDocId(d.id); setDocNo(d.allocation_no); setDocStatus(d.status);
      setAllocDate(String(d.allocation_date).slice(0, 10)); setFloorName(d.floor_name || '');
      setShiftId(d.shift_id ? String(d.shift_id) : ''); setPlanType(d.plan_type || 'LINE_WISE');
      setRemarks(d.remarks || ''); setOverride(!!d.capacity_override);
      setAllocs((d.details || []).map((x: any) => ({
        ...x, bundle_id: Number(x.bundle_id), line_id: Number(x.line_id), allocated_qty: n(x.allocated_qty), remarks: x.remarks || '',
        available_qty: n(x.available_qty), ready_qty: n(x.ready_qty), allocated_elsewhere: 0,
      })));
      setOpenLines(new Set((d.details || []).map((x: any) => Number(x.line_id))));
      setSelBundles(new Set()); setSelAlloc(new Set());
    } catch (e: any) {
      toast(e?.message || 'Could not open allocation', 'error');
    }
  };

  // Stock minus what this document already allocates.
  const inDoc = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of allocs) m.set(a.bundle_id, (m.get(a.bundle_id) ?? 0) + a.allocated_qty);
    return m;
  }, [allocs]);
  const free = useMemo(() => stock
    .map((s) => ({ ...s, free_qty: s.available_qty - (inDoc.get(s.bundle_id) ?? 0) }))
    .filter((s) => s.free_qty > 0), [stock, inDoc]);

  const filtered = useMemo(() => {
    let r = applyFilters(free, filters);
    if (dq) {
      const q = dq.toLowerCase();
      r = r.filter((b) => [b.bundle_no, b.barcode, b.io_no, b.style_no, b.colour].some((x) => String(x ?? '').toLowerCase().includes(q)));
    }
    return r;
  }, [free, filters, dq]);
  const freeGroups = useMemo(() => groupByJob(filtered), [filtered]);

  // Job / style grid: pending (stock) vs allocated in this document.
  const jobGrid = useMemo(() => {
    const map = new Map<string, { io_no: string; buyer: string; po_no: string; style_no: string; style_description: string; pending: number; allocated: number }>();
    const touch = (b: Partial<BundleInfo>) => {
      const k = b.io_no ?? '—';
      if (!map.has(k)) map.set(k, { io_no: k, buyer: b.buyer ?? '', po_no: b.po_no ?? '', style_no: b.style_no ?? '', style_description: b.style_description ?? '', pending: 0, allocated: 0 });
      return map.get(k)!;
    };
    for (const s of applyFilters(stock, filters)) touch(s).pending += s.available_qty;
    for (const a of applyFilters(allocs, filters)) {
      const j = touch(a);
      j.allocated += a.allocated_qty;
      if (!stock.some((s) => s.bundle_id === a.bundle_id)) j.pending += a.allocated_qty;
    }
    return [...map.values()].sort((a, b) => a.io_no.localeCompare(b.io_no));
  }, [stock, allocs, filters]);

  const lineQty = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of allocs) m.set(a.line_id, (m.get(a.line_id) ?? 0) + a.allocated_qty);
    return m;
  }, [allocs]);
  const lineStats = (l: Line) => {
    const here = lineQty.get(l.id) ?? 0;
    const used = here + n(l.allocated_other);
    return { here, used, balance: n(l.capacity_pcs) - used, util: n(l.capacity_pcs) ? Math.round((used / n(l.capacity_pcs)) * 100) : 0 };
  };
  const overLines = lines.filter((l) => n(l.capacity_pcs) > 0 && lineStats(l).balance < 0);

  const totals = useMemo(() => {
    const allocated = allocs.reduce((a, x) => a + x.allocated_qty, 0);
    const unallocated = free.reduce((a, x) => a + x.free_qty, 0);
    const capacity = lines.reduce((a, l) => a + n(l.capacity_pcs), 0);
    const usedAll = lines.reduce((a, l) => a + lineStats(l).used, 0);
    return {
      jobs: new Set([...free.map((x) => x.io_no), ...allocs.map((x) => x.io_no)]).size,
      bundles: new Set([...free.map((x) => x.bundle_id), ...allocs.map((x) => x.bundle_id)]).size,
      pending: allocated + unallocated, allocated, unallocated, capacity,
      util: capacity ? Math.round((usedAll / capacity) * 100) : 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allocs, free, lines, lineQty]);

  // ── Actions ──
  const addToLine = (lineId: number, bundles: (Stock & { free_qty: number })[]) => {
    if (!editable) return;
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    setAllocs((prev) => {
      const next = [...prev];
      for (const b of bundles) {
        const k = next.findIndex((a) => a.bundle_id === b.bundle_id && a.line_id === lineId);
        if (k >= 0) next[k] = { ...next[k], allocated_qty: next[k].allocated_qty + b.free_qty };
        else next.push({ ...b, line_id: lineId, allocated_qty: b.free_qty, remarks: '' });
      }
      return next;
    });
    setOpenLines((o) => new Set(o).add(lineId));
    toast(`${bundles.length} bundle(s) · ${fmtNumber(bundles.reduce((a, b) => a + b.free_qty, 0))} PCS → ${line.line_code}`);
  };

  const allocateSelected = () => {
    if (!targetLine) { toast('Select a line first', 'warning'); return; }
    const picked = planType === 'JOB_WISE'
      ? filtered.filter((b) => selJobs.has(b.io_no ?? '—'))
      : filtered.filter((b) => selBundles.has(b.bundle_id));
    if (!picked.length) { toast(planType === 'JOB_WISE' ? 'Tick the jobs to allocate' : 'Tick the bundles to allocate', 'warning'); return; }
    addToLine(targetLine, picked);
    setSelBundles(new Set()); setSelJobs(new Set());
  };
  const allocateAll = () => {
    if (!targetLine) { toast('Select a line first', 'warning'); return; }
    if (!filtered.length) return;
    addToLine(targetLine, filtered);
    setSelBundles(new Set()); setSelJobs(new Set());
  };
  const removeKeys = (keys: Set<number>) => {
    if (!editable || !keys.size) return;
    setAllocs((prev) => prev.filter((_, i) => !keys.has(i)));
    setSelAlloc(new Set());
  };
  const removeSelected = () => {
    if (!selAlloc.size) { toast('Tick allocated bundles on the right to remove', 'warning'); return; }
    removeKeys(selAlloc);
  };
  const setQty = (i: number, v: number) => setAllocs((prev) => prev.map((a, k) => {
    if (k !== i) return a;
    const others = prev.filter((x, j) => j !== i && x.bundle_id === a.bundle_id).reduce((s, x) => s + x.allocated_qty, 0);
    const max = a.available_qty - others;
    return { ...a, allocated_qty: Math.max(1, Math.min(Math.floor(v) || 1, max)) };
  }));
  const setRemark = (i: number, v: string) => setAllocs((prev) => prev.map((a, k) => (k === i ? { ...a, remarks: v } : a)));

  const autoPlan = async () => {
    try {
      const r = await api.post(`/${proc}/line-allocation/auto-plan`, {
        allocation_date: allocDate, exclude_id: docId ?? 0,
        bundle_ids: filtered.map((b) => b.bundle_id),
        current: allocs.map((a) => ({ line_id: a.line_id, bundle_id: a.bundle_id, allocated_qty: a.allocated_qty })),
      });
      const prop: { line_id: number; bundle_id: number; allocated_qty: number }[] = r.data.data || [];
      if (!prop.length) { toast('No bundle fits the remaining line capacity', 'warning'); return; }
      setAllocs((prev) => [...prev, ...prop.map((p) => {
        const b = stock.find((s) => s.bundle_id === p.bundle_id)!;
        return { ...b, line_id: p.line_id, allocated_qty: p.allocated_qty, remarks: '' };
      })]);
      setOpenLines(new Set(prop.map((p) => p.line_id)));
      const skipped = r.data.meta?.skipped_no_capacity ?? 0;
      toast(`Auto plan allocated ${prop.length} bundle(s)${skipped ? ` — ${skipped} left for lack of capacity` : ''}`);
    } catch (e: any) {
      toast(e?.message || 'Auto plan failed', 'error');
    }
  };

  const payload = (confirm: boolean) => ({
    allocation_date: allocDate, floor_name: floorName || null, shift_id: shiftId ? Number(shiftId) : null,
    plan_type: planType, pending_qty: totals.pending, unallocated_qty: totals.unallocated,
    remarks: remarks || null, capacity_override: override, confirm,
    details: allocs.map((a) => ({ line_id: a.line_id, bundle_id: a.bundle_id, allocated_qty: a.allocated_qty, remarks: a.remarks || null })),
  });

  const save = async (confirm: boolean) => {
    if (!allocs.length) { toast('Allocate at least one bundle', 'warning'); return; }
    if (overLines.length && !override) { toast(`Over capacity on ${overLines.map((l) => l.line_code).join(', ')} — remove bundles or tick "Override capacity"`, 'warning'); return; }
    setSaving(true);
    try {
      const r = docId
        ? await api.put(`/${proc}/line-allocation/${docId}`, payload(confirm))
        : await api.post(`/${proc}/line-allocation`, payload(confirm));
      const d = r.data.data;
      toast(`Allocation ${d.allocation_no} ${confirm ? 'confirmed' : 'saved'} — ${d.total_bundles} bundles, ${fmtNumber(d.allocated_qty)} PCS`);
      await openDoc(d.id);
    } catch (e: any) {
      toast(e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const cancelDoc = async () => {
    if (!docId) return;
    try {
      await api.post(`/${proc}/line-allocation/${docId}/cancel`, { reason: cancelReason });
      toast(`Allocation ${docNo} cancelled`);
      setCancelOpen(false); setCancelReason('');
      resetNew();
      loadStock(null, allocDate);
    } catch (e: any) {
      toast(e?.message || 'Cancel failed', 'error');
    }
  };

  const print = () => {
    if (!allocs.length) { toast('Nothing to print', 'warning'); return; }
    const sections = lines.filter((l) => lineQty.get(l.id)).map((l) => {
      const rows = allocs.filter((a) => a.line_id === l.id);
      const pr = printRowsByJob(rows, (a) => [a.bundle_no, a.colour, a.size, a.lay_no ?? '', a.cut_no ?? '', a.allocated_qty, a.remarks]);
      return { heading: `${l.line_code} — ${l.line_name} · Capacity ${l.capacity_pcs} · Allocated ${lineQty.get(l.id)} PCS`, columns: ['Bundle', 'Colour', 'Size', 'Lay', 'Cut', 'Qty', 'Remarks'], ...pr };
    });
    printDocument(`${label} Line Allocation ${docNo ?? '(unsaved)'}`, [
      ['Date', fmtDate(allocDate)], ['Floor', floorName], ['Shift', shifts.data?.find((s: any) => String(s.id) === shiftId)?.label ?? '—'],
      ['Status', docStatus ?? 'Unsaved'], ['Bundles', allocs.length], ['Allocated PCS', totals.allocated],
    ], sections);
  };

  const summarySource = allocs.length ? allocs : [];
  const qtyOf = (a: Alloc) => a.allocated_qty;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{label} Line Allocation</h1>
          <p className="text-sm text-slate-500">Allocate jobs and bundles to {label.toLowerCase()} lines within line capacity</p>
        </div>
        <div className="flex items-center gap-2">
          <DocStatus no={docNo} status={docStatus} />
          <Button size="sm" variant="secondary" onClick={() => setShowDocs(true)}><FolderOpen size={13} className="mr-1" /> Open</Button>
          <Button size="sm" variant="secondary" onClick={() => { resetNew(); loadStock(null, allocDate); }}><FilePlus2 size={13} className="mr-1" /> New</Button>
        </div>
      </div>

      {/* Header + filters */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Input label="Date *" type="date" className="w-40" value={allocDate} disabled={!editable} onChange={(e) => setAllocDate(e.target.value)} />
          <Input label={`${label} Floor`} className="w-44" value={floorName} disabled={!editable} onChange={(e) => setFloorName(e.target.value)} />
          <Select label="Shift" className="w-44" value={shiftId} disabled={!editable} onChange={(e) => setShiftId(e.target.value)} placeholder="Select shift" options={toOptions(shifts.data)} />
          <div className="flex h-10 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3">
            <span className="text-xs font-medium text-slate-600">Plan Type</span>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" checked={planType === 'LINE_WISE'} onChange={() => setPlanType('LINE_WISE')} className="accent-brand-600" />
              <span className="text-xs">Line / Bundle Wise</span>
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="radio" checked={planType === 'JOB_WISE'} onChange={() => setPlanType('JOB_WISE')} className="accent-brand-600" />
              <span className="text-xs">Job Wise</span>
            </label>
          </div>
          <Button variant="secondary" className="!h-10 ml-auto" onClick={() => loadStock(docId, allocDate)} loading={loading}>
            <Search size={14} className="mr-1" /> Load Pending
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
          {([
            ['job', 'Job No', distinct(stock, (b) => b.io_no)],
            ['po', 'PO No', distinct(stock, (b) => b.po_no)],
            ['style', 'Style No', distinct(stock, (b) => b.style_no)],
            ['buyer', 'Buyer', distinct(stock, (b) => b.buyer)],
            ['colour', 'Colour', distinct(stock, (b) => b.colour)],
            ['size', 'Size', distinct(stock, (b) => b.size)],
          ] as const).map(([k, lbl, opts]) => (
            <Select key={k} label={lbl} className="w-36" value={filters[k]} placeholder="All" options={opts as any}
              onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))} />
          ))}
          {Object.values(filters).some(Boolean) && <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button>}
        </div>
      </Card>

      {/* Summary + capacity */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <SummaryCard icon={<Layers size={20} />} label="Total Jobs" value={totals.jobs} tone="bg-blue-50 border-blue-200 text-blue-800" />
        <SummaryCard icon={<Boxes size={20} />} label="Total Bundles" value={totals.bundles} tone="bg-violet-50 border-violet-200 text-violet-800" />
        <SummaryCard icon={<Boxes size={20} />} label="Pending Qty (PCS)" value={fmtNumber(totals.pending)} tone="bg-amber-50 border-amber-200 text-amber-800" />
        <SummaryCard icon={<CheckCircle2 size={20} />} label="Allocated Qty (PCS)" value={fmtNumber(totals.allocated)} tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
        <SummaryCard icon={<AlertTriangle size={20} />} label="Unallocated Qty (PCS)" value={fmtNumber(totals.unallocated)} tone="bg-red-50 border-red-200 text-red-800" />
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-xs text-brand-800">
        <b>Line Capacity ({fmtDate(allocDate)})</b>
        <span>Total Lines: <b>{lines.length}</b></span>
        <span>Total Capacity: <b>{fmtNumber(totals.capacity)}</b> PCS</span>
        <span>Allocated: <b>{fmtNumber(lines.reduce((a, l) => a + lineStats(l).used, 0))}</b> PCS</span>
        <span>Utilization: <b>{totals.util}%</b></span>
        <span className="ml-auto flex gap-2">
          <Button size="sm" onClick={autoPlan} disabled={!editable || !free.length}><Zap size={13} className="mr-1" /> Auto Plan</Button>
          <Button size="sm" variant="secondary" onClick={() => nav(`/production/${proc}-lines`)}><Plus size={13} className="mr-1" /> Add Line</Button>
          <Button size="sm" variant="secondary" onClick={() => nav(`/production/${proc}-lines`)}><Settings2 size={13} className="mr-1" /> Line Capacity Setup</Button>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[1fr_auto_1fr]">
        {/* LEFT */}
        <div className="min-w-0 space-y-4">
          <Card title={`Job / Style Details (Pending for ${label})`}>
            <div className="max-h-[28vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="w-8 px-2 py-2" />
                    <th className="px-2 py-2 text-left">Job No</th>
                    <th className="px-2 py-2 text-left">Buyer</th>
                    <th className="px-2 py-2 text-left">PO No</th>
                    <th className="px-2 py-2 text-left">Style No</th>
                    <th className="px-2 py-2 text-left">Description</th>
                    <th className="px-2 py-2 text-right">Pending</th>
                    <th className="px-2 py-2 text-right">Allocated</th>
                    <th className="px-2 py-2 text-right">Unallocated</th>
                  </tr>
                </thead>
                <tbody>
                  {jobGrid.map((j) => (
                    <tr key={j.io_no} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={selJobs.has(j.io_no)} onChange={() => setSelJobs((s) => { const x = new Set(s); x.has(j.io_no) ? x.delete(j.io_no) : x.add(j.io_no); return x; })} />
                      </td>
                      <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">
                        <button className="hover:underline" onClick={() => setFilters((f) => ({ ...f, job: f.job === j.io_no ? '' : j.io_no }))}>{j.io_no}</button>
                      </td>
                      <td className="px-2 py-1.5">{j.buyer || '—'}</td>
                      <td className="px-2 py-1.5">{j.po_no || '—'}</td>
                      <td className="px-2 py-1.5 font-medium">{j.style_no || '—'}</td>
                      <td className="px-2 py-1.5 text-slate-500">{j.style_description || '—'}</td>
                      <td className="px-2 py-1.5 text-right">{fmtNumber(j.pending)}</td>
                      <td className="px-2 py-1.5 text-right text-emerald-700">{fmtNumber(j.allocated)}</td>
                      <td className="px-2 py-1.5 text-right font-medium text-amber-700">{fmtNumber(Math.max(j.pending - j.allocated, 0))}</td>
                    </tr>
                  ))}
                  {!jobGrid.length && <tr><td colSpan={9} className="px-4 py-6 text-center text-slate-400">{loading ? 'Loading…' : `No jobs pending for ${label.toLowerCase()}`}</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title={`Unallocated Bundles (${proc === 'sewing' ? 'from Cutting / Sewing Inward' : 'from Sewing Output'})`}
            actions={<span className="text-xs text-slate-500">{filtered.length} bundle(s) · {fmtNumber(filtered.reduce((a, b) => a + b.free_qty, 0))} PCS</span>}>
            <div className="border-b border-slate-100 p-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search bundle, barcode, job, style, colour…" className="w-full" />
            </div>
            <div className="max-h-[48vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="w-8 px-2 py-2">
                      <input type="checkbox" checked={filtered.length > 0 && filtered.every((b) => selBundles.has(b.bundle_id))}
                        onChange={() => setSelBundles(filtered.every((b) => selBundles.has(b.bundle_id)) ? new Set() : new Set(filtered.map((b) => b.bundle_id)))} />
                    </th>
                    <th className="px-2 py-2 text-left">Bundle ID</th>
                    <th className="px-2 py-2 text-left">Colour</th>
                    <th className="px-2 py-2 text-left">Size</th>
                    <th className="px-2 py-2 text-left">Lay / Cut</th>
                    <th className="px-2 py-2 text-right">Qty (PCS)</th>
                    <th className="px-2 py-2 text-right">Weight (KG)</th>
                    <th className="px-2 py-2 text-left">Inward Date</th>
                  </tr>
                </thead>
                <tbody>
                  {freeGroups.map((g) => {
                    const ids = g.rows.map((b) => b.bundle_id);
                    const all = ids.every((id) => selBundles.has(id));
                    const open = !closedJobs.has(g.key);
                    return [
                      <JobHeaderRow key={g.key} group={g} colSpan={8} qty={g.rows.reduce((a, b) => a + b.free_qty, 0)}
                        checked={all} open={open}
                        onToggle={() => setClosedJobs((s) => { const x = new Set(s); x.has(g.key) ? x.delete(g.key) : x.add(g.key); return x; })}
                        onCheck={() => setSelBundles((s) => { const x = new Set(s); ids.forEach((id) => (all ? x.delete(id) : x.add(id))); return x; })} />,
                      ...(open ? g.rows.map((b) => (
                        <tr key={b.bundle_id} onClick={() => setSelBundles((s) => { const x = new Set(s); x.has(b.bundle_id) ? x.delete(b.bundle_id) : x.add(b.bundle_id); return x; })}
                          className={`cursor-pointer border-t border-slate-100 ${selBundles.has(b.bundle_id) ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
                          <td className="px-2 py-1 text-center"><input type="checkbox" checked={selBundles.has(b.bundle_id)} readOnly /></td>
                          <td className="px-2 py-1 font-mono font-semibold text-slate-800">{b.bundle_no}</td>
                          <td className="px-2 py-1">{b.colour || '—'}</td>
                          <td className="px-2 py-1 font-semibold">{b.size || '—'}</td>
                          <td className="px-2 py-1 text-slate-500">{[b.lay_no, b.cut_no].filter(Boolean).join(' / ') || '—'}</td>
                          <td className="px-2 py-1 text-right font-medium">
                            {fmtNumber(b.free_qty)}{b.free_qty !== b.bundle_qty && <span className="text-slate-400"> / {b.bundle_qty}</span>}
                          </td>
                          <td className="px-2 py-1 text-right text-slate-500">{b.weight_kg ? Number(b.weight_kg).toFixed(2) : '—'}</td>
                          <td className="px-2 py-1 text-slate-500">{b.inward_date ? fmtDate(b.inward_date) : '—'}</td>
                        </tr>
                      )) : []),
                    ];
                  })}
                  {!filtered.length && <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">{loading ? 'Loading…' : 'No unallocated bundles'}</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* TRANSFER */}
        <div className="flex flex-row items-center justify-center gap-2 2xl:flex-col 2xl:pt-40">
          <Button onClick={allocateSelected} disabled={!editable || !targetLine} title="Allocate ticked bundles / jobs to the selected line">
            <ArrowRight size={16} className="mr-1" /> Allocate
          </Button>
          <Button variant="secondary" onClick={allocateAll} disabled={!editable || !targetLine || !filtered.length} title="Allocate every bundle shown">
            <ChevronsRight size={16} className="mr-1" /> Allocate All
          </Button>
          <Button variant="secondary" onClick={removeSelected} disabled={!editable || !selAlloc.size} title="Remove ticked allocated bundles">
            <ChevronLeft size={16} className="mr-1" /> Remove
          </Button>
        </div>

        {/* RIGHT */}
        <div className="min-w-0 space-y-4">
          <Card title={`${label} Lines`} actions={<span className="text-xs text-slate-500">Click a line to make it the allocation target</span>}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="w-8 px-2 py-2" />
                    <th className="px-2 py-2 text-left">Line Code</th>
                    <th className="px-2 py-2 text-left">Line Name</th>
                    <th className="px-2 py-2 text-left">Supervisor</th>
                    <th className="px-2 py-2 text-right">Operators</th>
                    <th className="px-2 py-2 text-right">SAM / Pcs</th>
                    <th className="px-2 py-2 text-right">Capacity</th>
                    <th className="px-2 py-2 text-right">Allocated</th>
                    <th className="px-2 py-2 text-right">Balance</th>
                    <th className="px-2 py-2 text-left">Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const s = lineStats(l);
                    return (
                      <tr key={l.id} onClick={() => setTargetLine(l.id)}
                        className={`cursor-pointer border-t border-slate-100 ${targetLine === l.id ? 'bg-brand-50 ring-1 ring-brand-300' : 'hover:bg-slate-50'}`}>
                        <td className="px-2 py-1.5 text-center"><input type="radio" checked={targetLine === l.id} readOnly className="accent-brand-600" /></td>
                        <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">{l.line_code}</td>
                        <td className="px-2 py-1.5 font-medium">{l.line_name}</td>
                        <td className="px-2 py-1.5">{l.supervisor_name || '—'}</td>
                        <td className="px-2 py-1.5 text-right">{l.manpower || '—'}</td>
                        <td className="px-2 py-1.5 text-right">{n(l.sam_per_pcs) ? n(l.sam_per_pcs).toFixed(2) : '—'}</td>
                        <td className="px-2 py-1.5 text-right">{fmtNumber(l.capacity_pcs)}</td>
                        <td className="px-2 py-1.5 text-right font-medium text-emerald-700" title={l.allocated_other ? `${l.allocated_other} PCS on other allocations of this date` : undefined}>{fmtNumber(s.used)}</td>
                        <td className={`px-2 py-1.5 text-right font-medium ${s.balance < 0 ? 'text-red-600' : ''}`}>{fmtNumber(s.balance)}</td>
                        <td className="px-2 py-1.5"><UtilBar value={s.util} /></td>
                      </tr>
                    );
                  })}
                  {!lines.length && <tr><td colSpan={10} className="px-4 py-6 text-center text-slate-400">No active {label.toLowerCase()} lines — add them under Line Capacity Setup</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <div className="px-3 pt-2"><Tabs tabs={TABS} active={tab} onChange={setTab} /></div>
            {tab === 'line' && (
              <div className="space-y-2 px-3 pb-3">
                {lines.map((line) => {
                  const rows = allocs.map((a, i) => ({ ...a, _i: i })).filter((a) => a.line_id === line.id);
                  const s = lineStats(line);
                  const open = openLines.has(line.id);
                  const groups = groupByJob(rows);
                  return (
                    <div key={line.id} className="overflow-hidden rounded-xl border border-slate-200">
                      <div className={`flex cursor-pointer flex-wrap items-center gap-3 border-b px-3 py-2 ${open ? 'bg-brand-50' : 'bg-slate-50'}`}
                        onClick={() => setOpenLines((o) => { const x = new Set(o); x.has(line.id) ? x.delete(line.id) : x.add(line.id); return x; })}>
                        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        <span className="text-sm font-bold text-slate-800">{line.line_code} – {line.line_name}{line.supervisor_name ? ` (${line.supervisor_name})` : ''}</span>
                        <span className="ml-auto text-xs">
                          Target: <b>{fmtNumber(line.capacity_pcs)}</b> | Allocated: <b className="text-emerald-700">{fmtNumber(s.here)}</b>
                          {line.allocated_other ? <span className="text-slate-500"> (+{fmtNumber(line.allocated_other)} other)</span> : null}
                          {' '}| Balance: <b className={s.balance < 0 ? 'text-red-600' : ''}>{fmtNumber(s.balance)}</b>
                        </span>
                        {editable && (
                          <>
                            <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setPickerLine(line.id); }}><Plus size={12} /> Add Bundle</Button>
                            <Button size="sm" variant="danger" disabled={!rows.length} onClick={(e) => { e.stopPropagation(); removeKeys(new Set(rows.map((r) => r._i))); }}>Remove</Button>
                          </>
                        )}
                      </div>
                      {open && (rows.length ? (
                        <table className="w-full text-xs">
                          <thead className="bg-white text-slate-500">
                            <tr>
                              <th className="w-8 px-2 py-1.5" />
                              <th className="px-2 py-1.5 text-left">Bundle ID</th>
                              <th className="px-2 py-1.5 text-left">Colour</th>
                              <th className="px-2 py-1.5 text-left">Size</th>
                              <th className="px-2 py-1.5 text-right">Qty (PCS)</th>
                              <th className="px-2 py-1.5 text-right">SAM</th>
                              <th className="px-2 py-1.5 text-left">Remarks</th>
                              <th className="px-2 py-1.5" />
                            </tr>
                          </thead>
                          <tbody>
                            {groups.map((g) => [
                              <JobHeaderRow key={g.key} group={g} colSpan={8} qty={g.rows.reduce((a, r) => a + r.allocated_qty, 0)} />,
                              ...g.rows.map((a) => (
                                <tr key={`${a.bundle_id}-${a._i}`} className="border-t border-slate-100">
                                  <td className="px-2 py-1 text-center">
                                    <input type="checkbox" disabled={!editable} checked={selAlloc.has(a._i)}
                                      onChange={() => setSelAlloc((s2) => { const x = new Set(s2); x.has(a._i) ? x.delete(a._i) : x.add(a._i); return x; })} />
                                  </td>
                                  <td className="px-2 py-1 font-mono font-semibold">{a.bundle_no}</td>
                                  <td className="px-2 py-1">{a.colour || '—'}</td>
                                  <td className="px-2 py-1 font-semibold">{a.size || '—'}</td>
                                  <td className="px-2 py-1 text-right">
                                    {editable
                                      ? <input type="number" min={1} max={a.available_qty} className="input h-6 w-20 text-right text-[11px]" value={a.allocated_qty} onChange={(e) => setQty(a._i, Number(e.target.value))} />
                                      : fmtNumber(a.allocated_qty)}
                                  </td>
                                  <td className="px-2 py-1 text-right text-slate-500">{n(line.sam_per_pcs) ? n(line.sam_per_pcs).toFixed(2) : '—'}</td>
                                  <td className="px-2 py-1">
                                    <input className="input h-6 w-32 text-[11px]" disabled={!editable} value={a.remarks} onChange={(e) => setRemark(a._i, e.target.value)} />
                                  </td>
                                  <td className="px-2 py-1 text-center">
                                    {editable && <button className="text-red-500 hover:text-red-700" onClick={() => removeKeys(new Set([a._i]))}><Trash2 size={14} /></button>}
                                  </td>
                                </tr>
                              )),
                            ])}
                          </tbody>
                        </table>
                      ) : <p className="py-5 text-center text-sm text-slate-400">No bundles yet — tick bundles on the left and click Allocate, or use Add Bundle.</p>)}
                    </div>
                  );
                })}
              </div>
            )}
            {tab === 'job' && <SummaryTable keyLabel="Job No" labelHeader="Style" data={summarize(summarySource, (a) => a.io_no ?? '', qtyOf, (a) => a.style_no ?? '')} />}
            {tab === 'style' && <SummaryTable keyLabel="Style No" labelHeader="Description" data={summarize(summarySource, (a) => a.style_no ?? '', qtyOf, (a) => a.style_description ?? '')} />}
            {tab === 'colour' && <SummaryTable keyLabel="Colour" data={summarize(summarySource, (a) => a.colour ?? '', qtyOf)} />}
            {tab === 'size' && <SummaryTable keyLabel="Size" data={summarize(summarySource, (a) => a.size ?? '', qtyOf)} />}
          </Card>
        </div>
      </div>

      {/* Footer */}
      <Card className="!p-0">
        <div className="flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-brand-900 to-brand-800 px-4 py-3 text-white">
          <div className="flex flex-wrap gap-6">
            {[['Total Bundles', allocs.length], ['Total Qty (PCS)', fmtNumber(totals.pending)],
              ['Allocated (PCS)', fmtNumber(totals.allocated)], ['Unallocated (PCS)', fmtNumber(totals.unallocated)],
              ['Allocated %', `${pct(totals.allocated, totals.pending)}%`]].map(([k, v]) => (
              <div key={k as string} className="text-center">
                <p className="text-[10px] uppercase tracking-wider opacity-80">{k}</p>
                <p className="text-xl font-bold">{v}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {overLines.length > 0 && editable && (
              <label className="flex items-center gap-1.5 rounded-lg bg-red-500/20 px-2 py-1 text-xs" title={can('PRODUCTION.APPROVE') ? '' : 'Needs PRODUCTION.APPROVE'}>
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Override capacity ({overLines.map((l) => l.line_code).join(', ')})
              </label>
            )}
            <Input className="w-56 !text-slate-800" placeholder="Remarks" value={remarks} disabled={!editable} onChange={(e) => setRemarks(e.target.value)} />
            {docId && docStatus !== 'CANCELLED' && (
              <Button variant="secondary" className="!border-white/20 !bg-white/10 !text-white" onClick={() => setCancelOpen(true)}>
                <X size={14} className="mr-1" /> Cancel Allocation
              </Button>
            )}
            {!docId && (
              <Button variant="secondary" className="!border-white/20 !bg-white/10 !text-white" onClick={() => setAllocs([])} disabled={!allocs.length}>
                <X size={14} className="mr-1" /> Clear
              </Button>
            )}
            {editable && (
              <>
                <Button variant="secondary" className="!border-blue-400 !bg-blue-500 !text-white" loading={saving} onClick={() => save(false)}>
                  <Save size={14} className="mr-1" /> Save Plan
                </Button>
                <Button className="!border-emerald-400 !bg-emerald-500" loading={saving} onClick={() => save(true)} disabled={!can('PRODUCTION.UPDATE')}>
                  <Check size={14} className="mr-1" /> Save & Confirm Plan
                </Button>
              </>
            )}
            <Button variant="secondary" className="!border-white/20 !bg-white/10 !text-white" onClick={print}>
              <Printer size={14} className="mr-1" /> Print Plan
            </Button>
          </div>
        </div>
      </Card>

      <DocumentsModal open={showDocs} onClose={() => setShowDocs(false)} url={`/${proc}/line-allocation`} title={`${label} Line Allocations`}
        noKey="allocation_no" dateKey="allocation_date" onPick={(r) => openDoc(r.id)}
        columns={[{ key: 'total_bundles', header: 'Bundles' }, { key: 'allocated_qty', header: 'Allocated' }, { key: 'line_count', header: 'Lines' }]} />

      <BundlePicker open={pickerLine !== null} onClose={() => setPickerLine(null)} rows={free}
        title={`Add bundles to ${lines.find((l) => l.id === pickerLine)?.line_code ?? ''}`}
        onPick={(picked) => { if (pickerLine) addToLine(pickerLine, picked); setPickerLine(null); }} />

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={`Cancel allocation ${docNo ?? ''}`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setCancelOpen(false)}>Back</Button><Button variant="danger" onClick={cancelDoc} disabled={cancelReason.trim().length < 3}>Cancel allocation</Button></>}>
        <p className="mb-2 text-sm text-slate-600">The bundles go back to unallocated stock. {docStatus === 'CONFIRMED' && <Badge tone="amber">Confirmed — needs approval right</Badge>}</p>
        <Input label="Reason *" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
      </Modal>
    </div>
  );
}

/** Pick bundles (grouped by job) for one line. */
function BundlePicker<T extends BundleInfo & { free_qty: number }>({ open, onClose, rows, title, onPick }: {
  open: boolean; onClose: () => void; rows: T[]; title: string; onPick: (rows: T[]) => void;
}) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  useEffect(() => { if (open) { setSel(new Set()); setSearch(''); } }, [open]);
  const shown = rows.filter((b) => !search || [b.bundle_no, b.io_no, b.style_no, b.colour, b.size].some((x) => String(x ?? '').toLowerCase().includes(search.toLowerCase())));
  return (
    <Modal open={open} onClose={onClose} title={title} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={!sel.size} onClick={() => onPick(rows.filter((r) => sel.has(r.bundle_id)))}>Add {sel.size} bundle(s)</Button></>}>
      <SearchInput value={search} onChange={setSearch} placeholder="Search bundle, job, style…" className="mb-2 w-full" />
      <table className="w-full text-xs">
        <tbody>
          {groupByJob(shown).map((g) => {
            const ids = g.rows.map((r) => r.bundle_id);
            const all = ids.every((id) => sel.has(id));
            return [
              <JobHeaderRow key={g.key} group={g} colSpan={5} qty={g.rows.reduce((a, r) => a + r.free_qty, 0)} checked={all}
                onCheck={() => setSel((s) => { const x = new Set(s); ids.forEach((id) => (all ? x.delete(id) : x.add(id))); return x; })} />,
              ...g.rows.map((b) => (
                <tr key={b.bundle_id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  onClick={() => setSel((s) => { const x = new Set(s); x.has(b.bundle_id) ? x.delete(b.bundle_id) : x.add(b.bundle_id); return x; })}>
                  <td className="w-8 px-2 py-1 text-center"><input type="checkbox" checked={sel.has(b.bundle_id)} readOnly /></td>
                  <td className="px-2 py-1 font-mono font-semibold">{b.bundle_no}</td>
                  <td className="px-2 py-1">{b.colour}</td>
                  <td className="px-2 py-1 font-semibold">{b.size}</td>
                  <td className="px-2 py-1 text-right">{fmtNumber(b.free_qty)} PCS</td>
                </tr>
              )),
            ];
          })}
          {!shown.length && <tr><td className="px-3 py-8 text-center text-slate-400">No unallocated bundles</td></tr>}
        </tbody>
      </table>
    </Modal>
  );
}

export function SewingLineAllocationPage() {
  return <LineAllocationPage proc="sewing" />;
}

export default SewingLineAllocationPage;
