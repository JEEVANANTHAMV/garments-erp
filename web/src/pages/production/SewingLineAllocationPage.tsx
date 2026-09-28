import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, ChevronDown, ChevronRight, Trash2, ArrowRight, ChevronsRight,
  Layers, Boxes, AlertTriangle, CheckCircle2, Settings2,
  Search, Printer, Save, Check, X,
} from 'lucide-react';
import { Card, Badge, Button, Input, Select, SearchInput, useDebounced } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';

/**
 * Sewing Line Allocation — Full-featured page matching the reference design.
 *
 * Layout:
 * - Top: Header filters (Date, Floor, Shift, Plan Type)
 * - Summary cards: Total Jobs, Total Bundles, Pending, Allocated, Unallocated
 * - Line Capacity cards
 * - Left panel: Job/Style Details (pending jobs) + Unallocated Bundles
 * - Right panel: Sewing Lines with capacity + Line Allocation Groups (bundle→line mapping)
 * - Transfer controls: Allocate (>), Allocate All (>>), Remove (<)
 * - Footer: Plan Summary + Action buttons
 */

type Bundle = {
  bundle_id: number; bundle_no: string; barcode?: string; bundle_qty: number;
  job_id: number; job_no: string; io_no?: string; po_no?: string;
  style_id?: number; style_no?: string; style_description?: string;
  colour_id?: number; colour?: string; size_id?: number; size?: string;
  buyer?: string; available_qty: number; weight_kg?: number;
  inward_date?: string; plan_no?: string;
};

type SewingLine = {
  id: number; line_code: string; line_name: string;
  capacity_pcs: number; manpower: number; sam_per_pcs?: number;
  capacity_pcs_day: number;
};

type AllocatedBundle = Bundle & { line_id: number };

const n = (v: unknown) => Number(v ?? 0) || 0;

const JOB_TONES = [
  'bg-blue-50 border-blue-200', 'bg-emerald-50 border-emerald-200', 'bg-amber-50 border-amber-200',
  'bg-violet-50 border-violet-200', 'bg-rose-50 border-rose-200', 'bg-cyan-50 border-cyan-200',
];

export function SewingLineAllocationPage() {
  const toast = useToast();
  const shifts = useLookup('shifts');

  // Header state
  const [allocDate, setAllocDate] = useState(today());
  const [floorName, setFloorName] = useState('Sewing Floor-1');
  const [shiftId, setShiftId] = useState<string>('');
  const [planType, setPlanType] = useState<'LINE_WISE' | 'JOB_WISE'>('LINE_WISE');

  // Data state
  const [lines, setLines] = useState<SewingLine[]>([]);
  const [unallocated, setUnallocated] = useState<Bundle[]>([]);
  const [allocated, setAllocated] = useState<Map<number, AllocatedBundle[]>>(new Map()); // line_id → bundles
  const [saving, setSaving] = useState(false);

  // Selection state
  const [selectedUnalloc, setSelectedUnalloc] = useState<Set<number>>(new Set());
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());
  const [searchQ, setSearchQ] = useState('');
  const dq = useDebounced(searchQ);

  // Filters
  const [filterJob, setFilterJob] = useState('');
  const [filterSize, setFilterSize] = useState('');

  // Load sewing lines and unallocated bundles
  const load = useCallback(async () => {
    try {
      const [linesRes, bundlesRes] = await Promise.all([
        api.get('/sewing/lines'),
        api.get('/sewing/unallocated-bundles'),
      ]);
      setLines(linesRes.data.data || []);
      setUnallocated(bundlesRes.data.data || []);
      // Auto expand first line
      const ls = linesRes.data.data || [];
      if (ls.length > 0) {
        setSelectedLine(ls[0].id);
        setExpandedLines(new Set([ls[0].id]));
      }
    } catch (e: any) {
      toast(e?.message || 'Failed to load data', 'error');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // Filter unallocated bundles
  const filteredUnalloc = useMemo(() => {
    let result = unallocated;
    if (dq) {
      const q = dq.toLowerCase();
      result = result.filter(b =>
        b.bundle_no?.toLowerCase().includes(q) ||
        b.job_no?.toLowerCase().includes(q) ||
        b.style_no?.toLowerCase().includes(q) ||
        b.colour?.toLowerCase().includes(q)
      );
    }
    if (filterJob) result = result.filter(b => String(b.job_id) === filterJob);
    if (filterSize) result = result.filter(b => b.size === filterSize);
    return result;
  }, [unallocated, dq, filterJob, filterSize]);

  // Group unallocated by job for the job/style grid
  const jobGroups = useMemo(() => {
    const map = new Map<string, { job_id: number; job_no: string; io_no?: string; buyer?: string; po_no?: string; style_no?: string; style_description?: string; pending_qty: number; allocated_qty: number; unallocated_qty: number; bundles: Bundle[] }>();
    for (const b of unallocated) {
      const key = String(b.job_id);
      if (!map.has(key)) {
        map.set(key, {
          job_id: b.job_id, job_no: b.job_no, io_no: b.io_no, buyer: b.buyer,
          po_no: b.po_no, style_no: b.style_no, style_description: b.style_description,
          pending_qty: 0, allocated_qty: 0, unallocated_qty: 0, bundles: [],
        });
      }
      const grp = map.get(key)!;
      grp.bundles.push(b);
      grp.pending_qty += n(b.bundle_qty);
      grp.unallocated_qty += n(b.available_qty);
    }
    // Add allocated counts
    for (const [, bundles] of allocated) {
      for (const b of bundles) {
        const key = String(b.job_id);
        const grp = map.get(key);
        if (grp) grp.allocated_qty += n(b.bundle_qty);
      }
    }
    return [...map.values()];
  }, [unallocated, allocated]);

  // Line capacity summary
  const lineCapacity = useMemo(() => {
    const totalCap = lines.reduce((a, l) => a + n(l.capacity_pcs_day), 0);
    const totalAlloc = [...allocated.values()].flat().reduce((a, b) => a + n(b.bundle_qty), 0);
    return {
      totalLines: lines.length,
      totalCapacity: totalCap,
      totalAllocated: totalAlloc,
      utilization: totalCap > 0 ? Math.round((totalAlloc / totalCap) * 100) : 0,
    };
  }, [lines, allocated]);

  // Summary totals
  const summary = useMemo(() => {
    const totalBundles = unallocated.length + [...allocated.values()].flat().length;
    const totalQty = unallocated.reduce((a, b) => a + n(b.bundle_qty), 0) +
                     [...allocated.values()].flat().reduce((a, b) => a + n(b.bundle_qty), 0);
    const allocQty = [...allocated.values()].flat().reduce((a, b) => a + n(b.bundle_qty), 0);
    const unallocQty = unallocated.reduce((a, b) => a + n(b.bundle_qty), 0);
    return {
      totalJobs: jobGroups.length,
      totalBundles,
      pendingQty: totalQty,
      allocatedQty: allocQty,
      unallocatedQty: unallocQty,
    };
  }, [unallocated, allocated, jobGroups]);

  // Allocation actions
  const allocateSelected = () => {
    if (!selectedLine) { toast('Select a sewing line first', 'warning'); return; }
    const selected = unallocated.filter(b => selectedUnalloc.has(b.bundle_id));
    if (!selected.length) { toast('Select bundles to allocate', 'warning'); return; }

    const newAllocated = new Map(allocated);
    const existing = newAllocated.get(selectedLine) || [];
    const toAdd = selected.filter(b => !existing.some(e => e.bundle_id === b.bundle_id))
      .map(b => ({ ...b, line_id: selectedLine! }));

    newAllocated.set(selectedLine, [...existing, ...toAdd]);
    setAllocated(newAllocated);
    setUnallocated(prev => prev.filter(b => !selectedUnalloc.has(b.bundle_id)));
    setSelectedUnalloc(new Set());
    toast(`${toAdd.length} bundle(s) allocated to ${lines.find(l => l.id === selectedLine)?.line_name}`);
  };

  const allocateAll = () => {
    if (!selectedLine) { toast('Select a sewing line first', 'warning'); return; }
    const toAllocate = filteredUnalloc;
    if (!toAllocate.length) return;

    const newAllocated = new Map(allocated);
    const existing = newAllocated.get(selectedLine) || [];
    const ids = new Set(existing.map(e => e.bundle_id));
    const toAdd = toAllocate.filter(b => !ids.has(b.bundle_id)).map(b => ({ ...b, line_id: selectedLine! }));

    newAllocated.set(selectedLine, [...existing, ...toAdd]);
    setAllocated(newAllocated);
    setUnallocated(prev => prev.filter(b => !toAllocate.some(t => t.bundle_id === b.bundle_id)));
    setSelectedUnalloc(new Set());
    toast(`${toAdd.length} bundle(s) allocated`);
  };

  const removeBundles = (lineId: number, bundleIds: number[]) => {
    const newAllocated = new Map(allocated);
    const existing = newAllocated.get(lineId) || [];
    const removed = existing.filter(b => bundleIds.includes(b.bundle_id));
    newAllocated.set(lineId, existing.filter(b => !bundleIds.includes(b.bundle_id)));
    setAllocated(newAllocated);
    // Move back to unallocated
    setUnallocated(prev => [...prev, ...removed.map(b => {
      const { line_id, ...rest } = b;
      return rest as Bundle;
    })]);
  };

  const toggleUnalloc = (id: number) => {
    const s = new Set(selectedUnalloc);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelectedUnalloc(s);
  };

  const toggleLine = (id: number) => {
    const s = new Set(expandedLines);
    if (s.has(id)) s.delete(id); else s.add(id);
    setExpandedLines(s);
  };

  // Save
  const save = async (confirm = false) => {
    setSaving(true);
    try {
      const allDetails: any[] = [];
      for (const [lineId, bundles] of allocated) {
        for (const b of bundles) {
          allDetails.push({
            line_id: lineId, bundle_id: b.bundle_id, job_id: b.job_id,
            style_id: b.style_id, colour_id: b.colour_id, size_id: b.size_id,
            po_no: b.po_no, allocated_qty: b.bundle_qty, sam: 0,
            planned_qty: b.bundle_qty,
          });
        }
      }

      const body = {
        allocation_date: allocDate, floor_name: floorName,
        shift_id: shiftId ? Number(shiftId) : null, plan_type: planType,
        total_jobs: summary.totalJobs, total_bundles: allDetails.length,
        pending_qty: summary.pendingQty, allocated_qty: summary.allocatedQty,
        unallocated_qty: summary.unallocatedQty,
        status: confirm ? undefined : 'SAVED',
        confirm,
        details: allDetails,
      };

      const res = await api.post('/sewing/line-allocation', body);
      toast(`Allocation ${res.data.data.allocation_no} ${confirm ? 'confirmed' : 'saved'} — ${allDetails.length} bundles allocated`);
      load();
    } catch (e: any) {
      toast(e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const getLineAllocQty = (lineId: number) =>
    (allocated.get(lineId) || []).reduce((a, b) => a + n(b.bundle_qty), 0);

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Sewing Line Allocation</h1>
          <p className="text-sm text-slate-500">Allocate styles and bundles to sewing lines with start/end dates</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>Production</span> <span>›</span> <span>Sewing</span> <span>›</span>
          <span className="font-medium text-slate-700">Line Allocation</span>
        </div>
      </div>

      {/* Filters */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Input label="Date *" type="date" className="w-40" value={allocDate}
            onChange={(e) => setAllocDate(e.target.value)} />
          <Input label="Sewing Floor" className="w-44" value={floorName}
            onChange={(e) => setFloorName(e.target.value)} />
          <Select label="Shift" className="w-36" value={shiftId}
            onChange={(e) => setShiftId(e.target.value)}
            placeholder="Day Shift" options={toOptions(shifts.data)} />
          <div className="flex items-center gap-3 px-3 py-1 border border-slate-200 rounded-lg bg-white">
            <span className="text-xs font-medium text-slate-600">Plan Type</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" checked={planType === 'LINE_WISE'} onChange={() => setPlanType('LINE_WISE')}
                className="accent-brand-600" />
              <span className="text-xs">Line Wise</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" checked={planType === 'JOB_WISE'} onChange={() => setPlanType('JOB_WISE')}
                className="accent-brand-600" />
              <span className="text-xs">Job Wise</span>
            </label>
          </div>
          <div className="ml-auto flex gap-2">
            <Select label="Job No" className="w-32" value={filterJob}
              onChange={(e) => setFilterJob(e.target.value)} placeholder="All"
              options={jobGroups.map(j => ({ value: j.job_id, label: j.job_no }))} />
            <Select label="Size" className="w-28" value={filterSize}
              onChange={(e) => setFilterSize(e.target.value)} placeholder="All"
              options={[...new Set(unallocated.map(b => b.size).filter(Boolean))].map(s => ({ value: s!, label: s! }))} />
          </div>
          <Button variant="secondary" className="!h-10" onClick={load}>
            <Search size={14} className="mr-1" /> Load Pending
          </Button>
        </div>
      </Card>

      {/* Summary Cards Row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <SummaryCard icon={<Layers size={20} />} label="Total Jobs" value={summary.totalJobs}
          tone="bg-blue-50 border-blue-200 text-blue-800" />
        <SummaryCard icon={<Boxes size={20} />} label="Total Bundles" value={summary.totalBundles}
          tone="bg-violet-50 border-violet-200 text-violet-800" />
        <SummaryCard icon={<AlertTriangle size={20} />} label="Pending Qty (PCS)" value={fmtNumber(summary.pendingQty)}
          tone="bg-amber-50 border-amber-200 text-amber-800" />
        <SummaryCard icon={<CheckCircle2 size={20} />} label="Allocated Qty (PCS)" value={fmtNumber(summary.allocatedQty)}
          tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
        <SummaryCard icon={<AlertTriangle size={20} />} label="Unallocated Qty (PCS)" value={fmtNumber(summary.unallocatedQty)}
          tone="bg-red-50 border-red-200 text-red-800" />
      </div>

      {/* Line Capacity + Add Line */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3 px-4 py-2 rounded-lg border border-brand-200 bg-brand-50">
          <span className="text-xs font-bold text-brand-800">Line Capacity (Today)</span>
          <span className="text-xs text-brand-700">Total Lines: <b>{lineCapacity.totalLines}</b></span>
          <span className="text-xs text-brand-700">Total Capacity (PCS): <b>{fmtNumber(lineCapacity.totalCapacity)}</b></span>
          <span className="text-xs text-brand-700">Allocated (PCS): <b className="text-emerald-700">{fmtNumber(lineCapacity.totalAllocated)}</b></span>
          <span className="text-xs text-brand-700">Utilization: <b className={lineCapacity.utilization >= 80 ? 'text-emerald-700' : 'text-amber-700'}>{lineCapacity.utilization}%</b></span>
        </div>
        <Button size="sm" variant="secondary"><Plus size={13} className="mr-1" /> Add Line</Button>
        <Button size="sm" variant="secondary"><Settings2 size={13} className="mr-1" /> Line Capacity Setup</Button>
      </div>

      {/* Main Content: 2-column layout */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* LEFT — Job/Style Details + Unallocated Bundles */}
        <div className="space-y-4">
          {/* Job / Style Details */}
          <Card title="Job / Style Details (Pending for Sewing)">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="w-8 px-2 py-2"><input type="checkbox" /></th>
                    <th className="px-2 py-2 text-left">#</th>
                    <th className="px-2 py-2 text-left">Job No</th>
                    <th className="px-2 py-2 text-left">Buyer</th>
                    <th className="px-2 py-2 text-left">PO No</th>
                    <th className="px-2 py-2 text-left">Style No</th>
                    <th className="px-2 py-2 text-left">Description</th>
                    <th className="px-2 py-2 text-right">Pending Qty (PCS)</th>
                    <th className="px-2 py-2 text-right">Allocated Qty (PCS)</th>
                    <th className="px-2 py-2 text-right">Unallocated Qty (PCS)</th>
                  </tr>
                </thead>
                <tbody>
                  {jobGroups.map((j, i) => (
                    <tr key={j.job_id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={() => setFilterJob(filterJob === String(j.job_id) ? '' : String(j.job_id))}>
                      <td className="px-2 py-1.5 text-center"><input type="checkbox" checked={filterJob === String(j.job_id)} readOnly /></td>
                      <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                      <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">{j.job_no}</td>
                      <td className="px-2 py-1.5">{j.buyer || '—'}</td>
                      <td className="px-2 py-1.5">{j.po_no || '—'}</td>
                      <td className="px-2 py-1.5 font-medium">{j.style_no || '—'}</td>
                      <td className="px-2 py-1.5 text-slate-500">{j.style_description || '—'}</td>
                      <td className="px-2 py-1.5 text-right font-medium">{fmtNumber(j.pending_qty)}</td>
                      <td className="px-2 py-1.5 text-right font-medium text-emerald-700">{fmtNumber(j.allocated_qty)}</td>
                      <td className="px-2 py-1.5 text-right font-medium text-amber-700">{fmtNumber(j.unallocated_qty)}</td>
                    </tr>
                  ))}
                  {!jobGroups.length && (
                    <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">No pending jobs found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Unallocated Bundles */}
          <Card title="Unallocated Bundles (From Cutting/Sewing Inward)">
            <div className="border-b border-slate-100 p-2">
              <SearchInput value={searchQ} onChange={setSearchQ} placeholder="Search bundle, job, style..." className="w-full" />
            </div>
            <div className="max-h-[45vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="w-8 px-2 py-2">
                      <input type="checkbox"
                        checked={filteredUnalloc.length > 0 && filteredUnalloc.every(b => selectedUnalloc.has(b.bundle_id))}
                        onChange={() => {
                          if (filteredUnalloc.every(b => selectedUnalloc.has(b.bundle_id)))
                            setSelectedUnalloc(new Set());
                          else
                            setSelectedUnalloc(new Set(filteredUnalloc.map(b => b.bundle_id)));
                        }} />
                    </th>
                    <th className="px-2 py-2 text-left">#</th>
                    <th className="px-2 py-2 text-left">Bundle ID</th>
                    <th className="px-2 py-2 text-left">Job No</th>
                    <th className="px-2 py-2 text-left">PO No</th>
                    <th className="px-2 py-2 text-left">Style No</th>
                    <th className="px-2 py-2 text-left">Colour</th>
                    <th className="px-2 py-2 text-left">Size</th>
                    <th className="px-2 py-2 text-right">Qty (PCS)</th>
                    <th className="px-2 py-2 text-right">Weight (KG)</th>
                    <th className="px-2 py-2 text-left">Inward Date</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUnalloc.map((b, i) => (
                    <tr key={b.bundle_id}
                      className={`border-t border-slate-100 cursor-pointer ${selectedUnalloc.has(b.bundle_id) ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                      onClick={() => toggleUnalloc(b.bundle_id)}>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={selectedUnalloc.has(b.bundle_id)} readOnly />
                      </td>
                      <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                      <td className="px-2 py-1.5 font-mono font-semibold text-slate-800">{b.bundle_no}</td>
                      <td className="px-2 py-1.5 font-mono text-brand-700">{b.job_no}</td>
                      <td className="px-2 py-1.5">{b.po_no || '—'}</td>
                      <td className="px-2 py-1.5">{b.style_no || '—'}</td>
                      <td className="px-2 py-1.5">{b.colour || '—'}</td>
                      <td className="px-2 py-1.5 font-semibold">{b.size || '—'}</td>
                      <td className="px-2 py-1.5 text-right font-medium">{fmtNumber(b.bundle_qty)}</td>
                      <td className="px-2 py-1.5 text-right text-slate-500">{n(b.weight_kg) ? Number(b.weight_kg).toFixed(2) : '—'}</td>
                      <td className="px-2 py-1.5 text-slate-500">{b.inward_date ? fmtDate(b.inward_date) : '—'}</td>
                    </tr>
                  ))}
                  {!filteredUnalloc.length && (
                    <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-400">No unallocated bundles</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* CENTER — Transfer Controls + RIGHT — Sewing Lines & Allocation */}
        <div className="space-y-4">
          {/* Transfer Controls */}
          <div className="flex items-center justify-center gap-2">
            <Button variant="secondary" size="sm" onClick={allocateSelected}
              disabled={!selectedUnalloc.size || !selectedLine}>
              <ArrowRight size={16} /> Allocate
            </Button>
            <Button variant="secondary" size="sm" onClick={allocateAll}
              disabled={!filteredUnalloc.length || !selectedLine}>
              <ChevronsRight size={16} /> Allocate All
            </Button>
          </div>

          {/* Sewing Lines */}
          <Card title="Sewing Lines">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="w-8 px-2 py-2"><input type="checkbox" /></th>
                    <th className="px-2 py-2 text-left">#</th>
                    <th className="px-2 py-2 text-left">Line Code</th>
                    <th className="px-2 py-2 text-left">Line Name</th>
                    <th className="px-2 py-2 text-right">No. of Machines</th>
                    <th className="px-2 py-2 text-right">SAM / Pcs</th>
                    <th className="px-2 py-2 text-right">Capacity (PCS/Day)</th>
                    <th className="px-2 py-2 text-right">Allocated (PCS)</th>
                    <th className="px-2 py-2 text-right">Balance (PCS)</th>
                    <th className="px-2 py-2 text-left">Utilization</th>
                    <th className="px-2 py-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const allocQty = getLineAllocQty(l.id);
                    const balance = n(l.capacity_pcs_day) - allocQty;
                    const util = n(l.capacity_pcs_day) > 0 ? Math.round((allocQty / n(l.capacity_pcs_day)) * 100) : 0;
                    const isSelected = selectedLine === l.id;
                    return (
                      <tr key={l.id}
                        className={`border-t border-slate-100 cursor-pointer ${isSelected ? 'bg-brand-50 ring-1 ring-brand-300' : 'hover:bg-slate-50'}`}
                        onClick={() => setSelectedLine(l.id)}>
                        <td className="px-2 py-1.5 text-center">
                          <input type="radio" checked={isSelected} readOnly className="accent-brand-600" />
                        </td>
                        <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                        <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">{l.line_code}</td>
                        <td className="px-2 py-1.5 font-medium">{l.line_name}</td>
                        <td className="px-2 py-1.5 text-right">{l.manpower || '—'}</td>
                        <td className="px-2 py-1.5 text-right">{n(l.sam_per_pcs) ? Number(l.sam_per_pcs).toFixed(2) : '—'}</td>
                        <td className="px-2 py-1.5 text-right font-medium">{fmtNumber(l.capacity_pcs_day)}</td>
                        <td className="px-2 py-1.5 text-right font-medium text-emerald-700">{fmtNumber(allocQty)}</td>
                        <td className={`px-2 py-1.5 text-right font-medium ${balance < 0 ? 'text-red-600' : 'text-slate-600'}`}>{fmtNumber(balance)}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-2">
                            <div className="h-2.5 w-20 overflow-hidden rounded-full bg-slate-100">
                              <div className={`h-full rounded-full ${util >= 90 ? 'bg-emerald-500' : util >= 70 ? 'bg-blue-500' : util >= 50 ? 'bg-amber-500' : 'bg-red-400'}`}
                                style={{ width: `${Math.min(100, util)}%` }} />
                            </div>
                            <span className="text-[11px] font-medium">{util}%</span>
                          </div>
                        </td>
                        <td className="px-2 py-1.5"><Badge tone={allocQty > 0 ? 'green' : 'slate'}>{allocQty > 0 ? 'Active' : 'Idle'}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Line Allocation Groups */}
          <Card title="Line Allocation">
            <div className="space-y-2 p-2">
              {lines.map((line, li) => {
                const bundles = allocated.get(line.id) || [];
                const isExpanded = expandedLines.has(line.id);
                const allocQty = bundles.reduce((a, b) => a + n(b.bundle_qty), 0);
                const cap = n(line.capacity_pcs_day);
                const balance = cap - allocQty;

                // Group bundles by job
                const jobBundles = new Map<string, AllocatedBundle[]>();
                for (const b of bundles) {
                  const key = b.job_no || '—';
                  if (!jobBundles.has(key)) jobBundles.set(key, []);
                  jobBundles.get(key)!.push(b);
                }

                return (
                  <div key={line.id} className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${isExpanded ? JOB_TONES[li % JOB_TONES.length] : 'bg-slate-50'} border-b`}
                      onClick={() => toggleLine(line.id)}>
                      {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span className="font-bold text-sm text-slate-800">
                        Line {String(li + 1).padStart(2, '0')} – {line.line_code} ({line.line_name})
                      </span>
                      <span className="ml-auto text-xs">
                        <span className="text-slate-600">Target: <b>{fmtNumber(cap)} PCS</b></span>
                        <span className="mx-2 text-slate-300">|</span>
                        <span className="text-emerald-700">Allocated: <b>{fmtNumber(allocQty)} PCS</b></span>
                        <span className="mx-2 text-slate-300">|</span>
                        <span className={balance < 0 ? 'text-red-600' : 'text-slate-600'}>Balance: <b>{fmtNumber(balance)} PCS</b></span>
                      </span>
                      <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); }}>
                        <Plus size={12} /> Add Bundle
                      </Button>
                      <Button size="sm" variant="danger" onClick={(e) => {
                        e.stopPropagation();
                        removeBundles(line.id, bundles.map(b => b.bundle_id));
                      }}>Remove</Button>
                    </div>
                    {isExpanded && (
                      <div className="overflow-x-auto">
                        {bundles.length > 0 ? (
                          <table className="w-full text-xs">
                            <thead className="bg-white text-slate-500">
                              <tr>
                                <th className="w-8 px-2 py-1.5"><input type="checkbox" /></th>
                                <th className="px-2 py-1.5 text-left">#</th>
                                <th className="px-2 py-1.5 text-left">Bundle ID</th>
                                <th className="px-2 py-1.5 text-left">Job No</th>
                                <th className="px-2 py-1.5 text-left">PO No</th>
                                <th className="px-2 py-1.5 text-left">Style No</th>
                                <th className="px-2 py-1.5 text-left">Colour</th>
                                <th className="px-2 py-1.5 text-left">Size</th>
                                <th className="px-2 py-1.5 text-right">Qty (PCS)</th>
                                <th className="px-2 py-1.5 text-left">Remarks</th>
                                <th className="px-2 py-1.5 text-center">Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bundles.map((b, bi) => (
                                <tr key={b.bundle_id} className="border-t border-slate-100">
                                  <td className="px-2 py-1 text-center"><input type="checkbox" /></td>
                                  <td className="px-2 py-1 text-slate-400">{bi + 1}</td>
                                  <td className="px-2 py-1 font-mono font-semibold text-slate-800">{b.bundle_no}</td>
                                  <td className="px-2 py-1 font-mono text-brand-700">{b.job_no}</td>
                                  <td className="px-2 py-1">{b.po_no || '—'}</td>
                                  <td className="px-2 py-1">{b.style_no || '—'}</td>
                                  <td className="px-2 py-1">{b.colour || '—'}</td>
                                  <td className="px-2 py-1 font-semibold">{b.size || '—'}</td>
                                  <td className="px-2 py-1 text-right font-medium">{fmtNumber(b.bundle_qty)}</td>
                                  <td className="px-2 py-1"><input className="input h-6 w-24 text-[11px]" placeholder="..." /></td>
                                  <td className="px-2 py-1 text-center">
                                    <button className="text-red-500 hover:text-red-700"
                                      onClick={() => removeBundles(line.id, [b.bundle_id])}>
                                      <Trash2 size={14} />
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <p className="py-6 text-center text-sm text-slate-400">
                            No bundles allocated to this line. Select bundles and click Allocate.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>

      {/* Footer: Plan Summary + Actions */}
      <Card className="!p-0">
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 bg-gradient-to-r from-brand-900 to-brand-800 rounded-xl text-white">
          <div className="flex gap-6">
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wider opacity-80">Total Bundles</p>
              <p className="text-xl font-bold">{[...allocated.values()].flat().length}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wider opacity-80">Total Qty (PCS)</p>
              <p className="text-xl font-bold">{fmtNumber(summary.pendingQty)}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wider opacity-80">Allocated Qty (PCS)</p>
              <p className="text-xl font-bold text-emerald-300">{fmtNumber(summary.allocatedQty)}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wider opacity-80">Unallocated Qty (PCS)</p>
              <p className="text-xl font-bold text-amber-300">{fmtNumber(summary.unallocatedQty)}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" className="!bg-white/10 !text-white !border-white/20 hover:!bg-white/20">
              <X size={14} className="mr-1" /> Cancel
            </Button>
            <Button variant="secondary" className="!bg-blue-500 !text-white !border-blue-400 hover:!bg-blue-600"
              loading={saving} onClick={() => save(false)}>
              <Save size={14} className="mr-1" /> Save Plan
            </Button>
            <Button className="!bg-emerald-500 hover:!bg-emerald-600 !border-emerald-400"
              loading={saving} onClick={() => save(true)}>
              <Check size={14} className="mr-1" /> Save & Confirm Plan
            </Button>
            <Button variant="secondary" className="!bg-white/10 !text-white !border-white/20 hover:!bg-white/20">
              <Printer size={14} className="mr-1" /> Print Plan
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function SummaryCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string | number; tone: string }) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${tone}`}>
      <span className="opacity-70">{icon}</span>
      <div>
        <p className="text-[11px] font-medium opacity-80">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
      </div>
    </div>
  );
}

export default SewingLineAllocationPage;
