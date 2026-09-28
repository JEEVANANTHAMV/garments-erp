import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Trash2, ArrowRight, ChevronsRight,
  Layers, Boxes, AlertTriangle, CheckCircle2, Settings2,
  Search, Printer, Save, Check, X,
} from 'lucide-react';
import { Card, Button, Input, Select, SearchInput, useDebounced } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';

/**
 * Checking Line Allocation — Same pattern as Sewing Line Allocation.
 * Allocates bundles from sewing output to checking lines.
 */

type Bundle = {
  bundle_id: number; bundle_no: string; barcode?: string; bundle_qty: number;
  job_id: number; job_no: string; io_no?: string; po_no?: string;
  style_id?: number; style_no?: string; style_description?: string;
  colour_id?: number; colour?: string; size_id?: number; size?: string;
  available_qty: number; weight_kg?: number;
};

type CheckingLine = {
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

export function CheckingLineAllocationPage() {
  const toast = useToast();
  const shifts = useLookup('shifts');

  const [allocDate, setAllocDate] = useState(today());
  const [floorName, setFloorName] = useState('Checking Floor-1');
  const [shiftId, setShiftId] = useState<string>('');
  const [planType, setPlanType] = useState<'LINE_WISE' | 'JOB_WISE'>('LINE_WISE');

  const [lines, setLines] = useState<CheckingLine[]>([]);
  const [unallocated, setUnallocated] = useState<Bundle[]>([]);
  const [allocated, setAllocated] = useState<Map<number, AllocatedBundle[]>>(new Map());
  const [saving, setSaving] = useState(false);
  const [selectedUnalloc, setSelectedUnalloc] = useState<Set<number>>(new Set());
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());
  const [searchQ, setSearchQ] = useState('');
  const dq = useDebounced(searchQ);

  const load = useCallback(async () => {
    try {
      const [linesRes, bundlesRes] = await Promise.all([
        api.get('/checking/lines'),
        api.get('/checking/unallocated-bundles'),
      ]);
      setLines(linesRes.data.data || []);
      setUnallocated(bundlesRes.data.data || []);
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

  const filteredUnalloc = useMemo(() => {
    if (!dq) return unallocated;
    const q = dq.toLowerCase();
    return unallocated.filter(b =>
      b.bundle_no?.toLowerCase().includes(q) ||
      b.job_no?.toLowerCase().includes(q) ||
      b.style_no?.toLowerCase().includes(q)
    );
  }, [unallocated, dq]);

  const summary = useMemo(() => {
    const allocQty = [...allocated.values()].flat().reduce((a, b) => a + n(b.bundle_qty), 0);
    const unallocQty = unallocated.reduce((a, b) => a + n(b.bundle_qty), 0);
    return {
      totalBundles: unallocated.length + [...allocated.values()].flat().length,
      totalQty: allocQty + unallocQty,
      allocatedQty: allocQty,
      unallocatedQty: unallocQty,
    };
  }, [unallocated, allocated]);

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

  const allocateSelected = () => {
    if (!selectedLine) { toast('Select a checking line first', 'warning'); return; }
    const selected = unallocated.filter(b => selectedUnalloc.has(b.bundle_id));
    if (!selected.length) return;
    const newAllocated = new Map(allocated);
    const existing = newAllocated.get(selectedLine) || [];
    const toAdd = selected.filter(b => !existing.some(e => e.bundle_id === b.bundle_id))
      .map(b => ({ ...b, line_id: selectedLine! }));
    newAllocated.set(selectedLine, [...existing, ...toAdd]);
    setAllocated(newAllocated);
    setUnallocated(prev => prev.filter(b => !selectedUnalloc.has(b.bundle_id)));
    setSelectedUnalloc(new Set());
  };

  const allocateAll = () => {
    if (!selectedLine) { toast('Select a checking line first', 'warning'); return; }
    const newAllocated = new Map(allocated);
    const existing = newAllocated.get(selectedLine) || [];
    const ids = new Set(existing.map(e => e.bundle_id));
    const toAdd = filteredUnalloc.filter(b => !ids.has(b.bundle_id)).map(b => ({ ...b, line_id: selectedLine! }));
    newAllocated.set(selectedLine, [...existing, ...toAdd]);
    setAllocated(newAllocated);
    setUnallocated(prev => prev.filter(b => !filteredUnalloc.some(t => t.bundle_id === b.bundle_id)));
    setSelectedUnalloc(new Set());
  };

  const removeBundles = (lineId: number, bundleIds: number[]) => {
    const newAllocated = new Map(allocated);
    const existing = newAllocated.get(lineId) || [];
    const removed = existing.filter(b => bundleIds.includes(b.bundle_id));
    newAllocated.set(lineId, existing.filter(b => !bundleIds.includes(b.bundle_id)));
    setAllocated(newAllocated);
    setUnallocated(prev => [...prev, ...removed.map(({ line_id, ...rest }) => rest as Bundle)]);
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

  const save = async (confirm = false) => {
    setSaving(true);
    try {
      const allDetails: any[] = [];
      for (const [lineId, bundles] of allocated) {
        for (const b of bundles) {
          allDetails.push({
            line_id: lineId, bundle_id: b.bundle_id, job_id: b.job_id,
            style_id: b.style_id, colour_id: b.colour_id, size_id: b.size_id,
            po_no: b.po_no, allocated_qty: b.bundle_qty, planned_qty: b.bundle_qty,
          });
        }
      }

      const body = {
        allocation_date: allocDate, floor_name: floorName,
        shift_id: shiftId ? Number(shiftId) : null, plan_type: planType,
        total_bundles: allDetails.length,
        total_qty: summary.totalQty,
        allocated_qty: summary.allocatedQty,
        unallocated_qty: summary.unallocatedQty,
        status: confirm ? undefined : 'SAVED',
        confirm,
        details: allDetails,
      };

      const res = await api.post('/checking/line-allocation', body);
      toast(`Allocation ${res.data.data.allocation_no} ${confirm ? 'confirmed' : 'saved'}`);
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Checking Line Allocation</h1>
          <p className="text-sm text-slate-500">Allocate bundles from sewing output to checking lines</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>Production</span> <span>›</span> <span>Checking</span> <span>›</span>
          <span className="font-medium text-slate-700">Line Allocation</span>
        </div>
      </div>

      {/* Filters */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Input label="Date *" type="date" className="w-40" value={allocDate}
            onChange={(e) => setAllocDate(e.target.value)} />
          <Input label="Checking Floor" className="w-44" value={floorName}
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
          <Button variant="secondary" className="!h-10 ml-auto" onClick={load}>
            <Search size={14} className="mr-1" /> Load Pending
          </Button>
        </div>
      </Card>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <SumCard icon={<Boxes size={18} />} label="Total Bundles" value={summary.totalBundles}
          tone="bg-blue-50 border-blue-200 text-blue-800" />
        <SumCard icon={<Layers size={18} />} label="Total Qty (PCS)" value={fmtNumber(summary.totalQty)}
          tone="bg-violet-50 border-violet-200 text-violet-800" />
        <SumCard icon={<CheckCircle2 size={18} />} label="Allocated" value={fmtNumber(summary.allocatedQty)}
          tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
        <SumCard icon={<AlertTriangle size={18} />} label="Unallocated" value={fmtNumber(summary.unallocatedQty)}
          tone="bg-red-50 border-red-200 text-red-800" />
        <SumCard icon={<Layers size={18} />} label="Total Lines" value={lineCapacity.totalLines}
          tone="bg-slate-50 border-slate-200 text-slate-800" />
        <SumCard icon={<CheckCircle2 size={18} />} label="Total Capacity" value={fmtNumber(lineCapacity.totalCapacity)}
          tone="bg-cyan-50 border-cyan-200 text-cyan-800" />
        <SumCard icon={<CheckCircle2 size={18} />} label="Allocated (PCS)" value={fmtNumber(lineCapacity.totalAllocated)}
          tone="bg-brand-50 border-brand-200 text-brand-800" />
        <SumCard icon={<Settings2 size={18} />} label="Utilization"
          value={`${lineCapacity.utilization}%`}
          tone={lineCapacity.utilization >= 80 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'} />
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* LEFT — Unallocated Bundles */}
        <Card title="Unallocated Bundles (From Sewing)">
          <div className="border-b border-slate-100 p-2">
            <SearchInput value={searchQ} onChange={setSearchQ} placeholder="Search bundle, job, style..." className="w-full" />
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  <th className="w-8 px-2 py-2">
                    <input type="checkbox"
                      checked={filteredUnalloc.length > 0 && filteredUnalloc.every(b => selectedUnalloc.has(b.bundle_id))}
                      onChange={() => {
                        if (filteredUnalloc.every(b => selectedUnalloc.has(b.bundle_id))) setSelectedUnalloc(new Set());
                        else setSelectedUnalloc(new Set(filteredUnalloc.map(b => b.bundle_id)));
                      }} />
                  </th>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Bundle ID</th>
                  <th className="px-2 py-2 text-left">Job No</th>
                  <th className="px-2 py-2 text-left">Style No</th>
                  <th className="px-2 py-2 text-left">Colour</th>
                  <th className="px-2 py-2 text-left">Size</th>
                  <th className="px-2 py-2 text-right">Qty (PCS)</th>
                </tr>
              </thead>
              <tbody>
                {filteredUnalloc.map((b, i) => (
                  <tr key={b.bundle_id}
                    className={`border-t border-slate-100 cursor-pointer ${selectedUnalloc.has(b.bundle_id) ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    onClick={() => toggleUnalloc(b.bundle_id)}>
                    <td className="px-2 py-1.5 text-center"><input type="checkbox" checked={selectedUnalloc.has(b.bundle_id)} readOnly /></td>
                    <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                    <td className="px-2 py-1.5 font-mono font-semibold text-slate-800">{b.bundle_no}</td>
                    <td className="px-2 py-1.5 font-mono text-brand-700">{b.job_no}</td>
                    <td className="px-2 py-1.5">{b.style_no || '—'}</td>
                    <td className="px-2 py-1.5">{b.colour || '—'}</td>
                    <td className="px-2 py-1.5 font-semibold">{b.size || '—'}</td>
                    <td className="px-2 py-1.5 text-right font-medium">{fmtNumber(b.bundle_qty)}</td>
                  </tr>
                ))}
                {!filteredUnalloc.length && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">No unallocated bundles</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Transfer controls */}
          <div className="flex items-center justify-center gap-3 border-t border-slate-100 p-3">
            <Button size="sm" onClick={allocateSelected} disabled={!selectedUnalloc.size || !selectedLine}>
              <ArrowRight size={14} className="mr-1" /> Allocate
            </Button>
            <Button size="sm" variant="secondary" onClick={allocateAll} disabled={!filteredUnalloc.length || !selectedLine}>
              <ChevronsRight size={14} className="mr-1" /> Allocate All
            </Button>
          </div>
        </Card>

        {/* RIGHT — Checking Lines + Allocation */}
        <div className="space-y-4">
          {/* Lines table */}
          <Card title="Checking Lines">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Line Code</th>
                  <th className="px-2 py-2 text-left">Line Name</th>
                  <th className="px-2 py-2 text-right">Capacity</th>
                  <th className="px-2 py-2 text-right">Allocated</th>
                  <th className="px-2 py-2 text-right">Balance</th>
                  <th className="px-2 py-2 text-left">Utilization</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const allocQty = getLineAllocQty(l.id);
                  const balance = n(l.capacity_pcs_day) - allocQty;
                  const util = n(l.capacity_pcs_day) > 0 ? Math.round((allocQty / n(l.capacity_pcs_day)) * 100) : 0;
                  return (
                    <tr key={l.id}
                      className={`border-t border-slate-100 cursor-pointer ${selectedLine === l.id ? 'bg-brand-50 ring-1 ring-brand-300' : 'hover:bg-slate-50'}`}
                      onClick={() => setSelectedLine(l.id)}>
                      <td className="px-2 py-1.5 text-center">
                        <input type="radio" checked={selectedLine === l.id} readOnly className="accent-brand-600" />
                      </td>
                      <td className="px-2 py-1.5 text-slate-400">{i + 1}</td>
                      <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">{l.line_code}</td>
                      <td className="px-2 py-1.5 font-medium">{l.line_name}</td>
                      <td className="px-2 py-1.5 text-right">{fmtNumber(l.capacity_pcs_day)}</td>
                      <td className="px-2 py-1.5 text-right font-medium text-emerald-700">{fmtNumber(allocQty)}</td>
                      <td className={`px-2 py-1.5 text-right ${balance < 0 ? 'text-red-600 font-medium' : ''}`}>{fmtNumber(balance)}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <div className="h-2.5 w-16 overflow-hidden rounded-full bg-slate-100">
                            <div className={`h-full rounded-full ${util >= 80 ? 'bg-emerald-500' : util >= 50 ? 'bg-amber-500' : 'bg-red-400'}`}
                              style={{ width: `${Math.min(100, util)}%` }} />
                          </div>
                          <span className="text-[11px]">{util}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* Allocated bundles per line */}
          {lines.map((line, li) => {
            const bundles = allocated.get(line.id) || [];
            if (!bundles.length && !expandedLines.has(line.id)) return null;
            const allocQty = bundles.reduce((a, b) => a + n(b.bundle_qty), 0);
            const cap = n(line.capacity_pcs_day);

            return (
              <div key={line.id} className="rounded-xl border border-slate-200 overflow-hidden">
                <div className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${JOB_TONES[li % JOB_TONES.length]} border-b`}
                  onClick={() => toggleLine(line.id)}>
                  {expandedLines.has(line.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span className="font-bold text-sm text-slate-800">
                    Line {String(li + 1).padStart(2, '0')} – {line.line_code}
                  </span>
                  <span className="ml-auto text-xs text-slate-600">
                    Target: <b>{fmtNumber(cap)}</b> | Allocated: <b className="text-emerald-700">{fmtNumber(allocQty)}</b> | Balance: <b>{fmtNumber(cap - allocQty)}</b>
                  </span>
                  <Button size="sm" variant="danger" onClick={(e) => {
                    e.stopPropagation();
                    removeBundles(line.id, bundles.map(b => b.bundle_id));
                  }}>Remove</Button>
                </div>
                {expandedLines.has(line.id) && bundles.length > 0 && (
                  <table className="w-full text-xs">
                    <thead className="bg-white text-slate-500">
                      <tr>
                        <th className="px-2 py-1.5 text-left">#</th>
                        <th className="px-2 py-1.5 text-left">Bundle ID</th>
                        <th className="px-2 py-1.5 text-left">Job No</th>
                        <th className="px-2 py-1.5 text-left">Style No</th>
                        <th className="px-2 py-1.5 text-left">Colour</th>
                        <th className="px-2 py-1.5 text-left">Size</th>
                        <th className="px-2 py-1.5 text-right">Qty (PCS)</th>
                        <th className="px-2 py-1.5 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bundles.map((b, bi) => (
                        <tr key={b.bundle_id} className="border-t border-slate-100">
                          <td className="px-2 py-1 text-slate-400">{bi + 1}</td>
                          <td className="px-2 py-1 font-mono font-semibold text-slate-800">{b.bundle_no}</td>
                          <td className="px-2 py-1 font-mono text-brand-700">{b.job_no}</td>
                          <td className="px-2 py-1">{b.style_no || '—'}</td>
                          <td className="px-2 py-1">{b.colour || '—'}</td>
                          <td className="px-2 py-1 font-semibold">{b.size || '—'}</td>
                          <td className="px-2 py-1 text-right font-medium">{fmtNumber(b.bundle_qty)}</td>
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
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <Card className="!p-0">
        <div className="flex flex-wrap items-center justify-end gap-3 px-4 py-3 bg-gradient-to-r from-brand-900 to-brand-800 rounded-xl">
          <Button variant="secondary" className="!bg-white/10 !text-white !border-white/20">
            <X size={14} className="mr-1" /> Cancel
          </Button>
          <Button variant="secondary" className="!bg-blue-500 !text-white !border-blue-400"
            loading={saving} onClick={() => save(false)}>
            <Save size={14} className="mr-1" /> Save Plan
          </Button>
          <Button className="!bg-emerald-500 !border-emerald-400"
            loading={saving} onClick={() => save(true)}>
            <Check size={14} className="mr-1" /> Save & Confirm Plan
          </Button>
          <Button variant="secondary" className="!bg-white/10 !text-white !border-white/20">
            <Printer size={14} className="mr-1" /> Print Plan
          </Button>
        </div>
      </Card>
    </div>
  );
}

function SumCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string | number; tone: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 ${tone}`}>
      <span className="opacity-70">{icon}</span>
      <div>
        <p className="text-[10px] font-medium opacity-80">{label}</p>
        <p className="text-lg font-bold">{value}</p>
      </div>
    </div>
  );
}

export default CheckingLineAllocationPage;
