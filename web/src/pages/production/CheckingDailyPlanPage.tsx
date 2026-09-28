import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, ChevronDown, ChevronRight, Trash2, Zap, Copy, XCircle, FileSpreadsheet,
  Layers, Boxes, AlertTriangle, CheckCircle2, Settings2,
  Search, Printer, Save, Check, X,
} from 'lucide-react';
import { Card, Badge, Button, Input, Select, Tabs } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';

/**
 * Checking Daily Plan — Full-featured page matching Image 3 reference.
 *
 * Features:
 * - Pending for Checking summary (from Sewing Inward)
 * - Line Capacity today
 * - Multiple tab views: Line Plan, Job Wise Plan, Style Wise Plan, Colour Wise, Size Wise, Pending Stock
 * - Auto Plan, Copy Previous Day, Clear Plan, Import from Excel
 * - Checking Line Plan table with expandable line detail
 * - Line/Job/Style wise plan summaries at bottom
 *
 * Same pattern is used for Sewing Daily Plan as well.
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

type LinePlan = {
  line: CheckingLine;
  supervisor: string;
  target_qty: number;
  assigned_qty: number;
  balance: number;
  utilization: number;
  operators: number;
  status: string;
  bundles: (Bundle & { planned_qty: number; remarks: string })[];
};

const n = (v: unknown) => Number(v ?? 0) || 0;

type TabKey = 'line' | 'job' | 'style' | 'colour' | 'size' | 'pending';
const PLAN_TABS: { key: TabKey; label: string }[] = [
  { key: 'line', label: 'Line Plan' },
  { key: 'job', label: 'Job Wise Plan' },
  { key: 'style', label: 'Style Wise Plan' },
  { key: 'colour', label: 'Colour Wise Plan' },
  { key: 'size', label: 'Size Wise Plan' },
  { key: 'pending', label: 'Pending Stock' },
];

// Reusable page for both Sewing and Checking daily plan
function DailyPlanPage({ processType }: { processType: 'sewing' | 'checking' }) {
  const toast = useToast();
  const shifts = useLookup('shifts');
  const isChecking = processType === 'checking';
  const title = isChecking ? 'Daily Plan – Checking' : 'Daily Plan – Sewing';
  const lineEndpoint = isChecking ? '/checking/lines' : '/sewing/lines';
  const bundleEndpoint = isChecking ? '/checking/unallocated-bundles' : '/sewing/unallocated-bundles';
  const planEndpoint = isChecking ? '/checking/daily-plan' : '/sewing/daily-plan';

  // Header
  const [planDate, setPlanDate] = useState(today());
  const [floorName, setFloorName] = useState(isChecking ? 'Checking Floor-1' : 'Sewing Floor-1');
  const [shiftId, setShiftId] = useState<string>('');
  const [planType, setPlanType] = useState<'LINE_WISE' | 'JOB_WISE'>('LINE_WISE');

  // Filters
  const [filterJob, setFilterJob] = useState('');
  const [filterPO, setFilterPO] = useState('');
  const [filterStyle, setFilterStyle] = useState('');
  const [filterColour, setFilterColour] = useState('');
  const [filterSize, setFilterSize] = useState('');

  // Data
  const [lines, setLines] = useState<CheckingLine[]>([]);
  const [pendingBundles, setPendingBundles] = useState<Bundle[]>([]);
  const [linePlans, setLinePlans] = useState<Map<number, LinePlan>>(new Map());
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('line');
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const [linesRes, bundlesRes] = await Promise.all([
        api.get(lineEndpoint),
        api.get(bundleEndpoint),
      ]);
      const loadedLines: CheckingLine[] = linesRes.data.data || [];
      setLines(loadedLines);
      setPendingBundles(bundlesRes.data.data || []);

      // Initialize line plans
      const plans = new Map<number, LinePlan>();
      for (const l of loadedLines) {
        plans.set(l.id, {
          line: l,
          supervisor: '',
          target_qty: n(l.capacity_pcs_day),
          assigned_qty: 0,
          balance: n(l.capacity_pcs_day),
          utilization: 0,
          operators: n(l.manpower),
          status: 'Planned',
          bundles: [],
        });
      }
      setLinePlans(plans);
      if (loadedLines.length) setExpandedLines(new Set([loadedLines[0].id]));
    } catch (e: any) {
      toast(e?.message || 'Failed to load', 'error');
    }
  }, [lineEndpoint, bundleEndpoint, toast]);

  useEffect(() => { load(); }, [load]);

  // Summaries
  const pendingSummary = useMemo(() => {
    const totalBundles = pendingBundles.length;
    const totalQty = pendingBundles.reduce((a, b) => a + n(b.bundle_qty), 0);
    const allocQty = [...linePlans.values()].reduce((a, p) => a + p.assigned_qty, 0);
    return { totalBundles, totalQty, allocated: allocQty, unallocated: totalQty - allocQty };
  }, [pendingBundles, linePlans]);

  const lineCapSummary = useMemo(() => {
    const totalCap = lines.reduce((a, l) => a + n(l.capacity_pcs_day), 0);
    const allocQty = [...linePlans.values()].reduce((a, p) => a + p.assigned_qty, 0);
    const plannedQty = [...linePlans.values()].reduce((a, p) => a + p.target_qty, 0);
    return {
      totalLines: lines.length,
      totalCapacity: totalCap,
      plannedQty,
      utilization: totalCap > 0 ? Math.round((allocQty / totalCap) * 100) : 0,
    };
  }, [lines, linePlans]);

  // Add bundle to a line
  const addBundleToLine = (lineId: number, bundle: Bundle) => {
    setLinePlans(prev => {
      const plans = new Map(prev);
      const plan = plans.get(lineId);
      if (!plan) return plans;
      if (plan.bundles.some(b => b.bundle_id === bundle.bundle_id)) return plans;
      const newBundles = [...plan.bundles, { ...bundle, planned_qty: bundle.bundle_qty, remarks: '' }];
      const assignedQty = newBundles.reduce((a, b) => a + n(b.planned_qty), 0);
      plans.set(lineId, {
        ...plan,
        bundles: newBundles,
        assigned_qty: assignedQty,
        balance: plan.target_qty - assignedQty,
        utilization: plan.target_qty > 0 ? Math.round((assignedQty / plan.target_qty) * 100) : 0,
      });
      return plans;
    });
    // Remove from pending
    setPendingBundles(prev => prev.filter(b => b.bundle_id !== bundle.bundle_id));
  };

  const removeBundleFromLine = (lineId: number, bundleId: number) => {
    let removed: Bundle | undefined;
    setLinePlans(prev => {
      const plans = new Map(prev);
      const plan = plans.get(lineId);
      if (!plan) return plans;
      removed = plan.bundles.find(b => b.bundle_id === bundleId);
      const newBundles = plan.bundles.filter(b => b.bundle_id !== bundleId);
      const assignedQty = newBundles.reduce((a, b) => a + n(b.planned_qty), 0);
      plans.set(lineId, {
        ...plan,
        bundles: newBundles,
        assigned_qty: assignedQty,
        balance: plan.target_qty - assignedQty,
        utilization: plan.target_qty > 0 ? Math.round((assignedQty / plan.target_qty) * 100) : 0,
      });
      return plans;
    });
    if (removed) {
      setPendingBundles(prev => [...prev, removed!]);
    }
  };

  const toggleLine = (id: number) => {
    const s = new Set(expandedLines);
    if (s.has(id)) s.delete(id); else s.add(id);
    setExpandedLines(s);
  };

  // Auto plan - distribute bundles evenly across lines
  const autoPlan = () => {
    const available = [...pendingBundles];
    if (!available.length) { toast('No pending bundles to plan', 'warning'); return; }

    const plans = new Map(linePlans);
    let lineIdx = 0;
    const lineIds = lines.map(l => l.id);

    for (const bundle of available) {
      if (!lineIds.length) break;
      const lineId = lineIds[lineIdx % lineIds.length];
      const plan = plans.get(lineId)!;
      const newBundles = [...plan.bundles, { ...bundle, planned_qty: bundle.bundle_qty, remarks: '' }];
      const assignedQty = newBundles.reduce((a, b) => a + n(b.planned_qty), 0);
      plans.set(lineId, {
        ...plan,
        bundles: newBundles,
        assigned_qty: assignedQty,
        balance: plan.target_qty - assignedQty,
        utilization: plan.target_qty > 0 ? Math.round((assignedQty / plan.target_qty) * 100) : 0,
      });
      lineIdx++;
    }

    setLinePlans(plans);
    setPendingBundles([]);
    toast(`Auto-planned ${available.length} bundles across ${lineIds.length} lines`);
  };

  const clearPlan = () => {
    const allBundles: Bundle[] = [];
    for (const [, plan] of linePlans) {
      allBundles.push(...plan.bundles);
    }
    setPendingBundles(prev => [...prev, ...allBundles]);
    setLinePlans(prev => {
      const plans = new Map(prev);
      for (const [id, plan] of plans) {
        plans.set(id, { ...plan, bundles: [], assigned_qty: 0, balance: plan.target_qty, utilization: 0 });
      }
      return plans;
    });
    toast('Plan cleared');
  };

  // Save
  const savePlan = async (confirm = false) => {
    setSaving(true);
    try {
      const allDetails: any[] = [];
      for (const [lineId, plan] of linePlans) {
        for (const b of plan.bundles) {
          allDetails.push({
            line_id: lineId, bundle_id: b.bundle_id, job_id: b.job_id,
            style_id: b.style_id, colour_id: b.colour_id, size_id: b.size_id,
            po_no: b.po_no, style_description: b.style_description,
            bundle_qty: b.bundle_qty, planned_qty: b.planned_qty,
            remarks: b.remarks || null,
          });
        }
      }

      if (!allDetails.length) { toast('Add at least one bundle to the plan', 'warning'); setSaving(false); return; }

      const body = {
        plan_date: planDate, floor_name: floorName,
        shift_id: shiftId ? Number(shiftId) : null, plan_type: planType,
        total_bundles: allDetails.length,
        total_qty: allDetails.reduce((a, d) => a + n(d.bundle_qty), 0),
        allocated_qty: allDetails.reduce((a, d) => a + n(d.planned_qty), 0),
        unallocated_qty: pendingBundles.reduce((a, b) => a + n(b.bundle_qty), 0),
        status: confirm ? undefined : 'SAVED',
        confirm,
        details: allDetails,
      };

      const res = await api.post(planEndpoint, body);
      toast(`Plan ${res.data.data.plan_no} ${confirm ? 'confirmed' : 'saved'} — ${allDetails.length} bundles planned`);
      load();
    } catch (e: any) {
      toast(e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Job-wise plan summary
  const jobSummary = useMemo(() => {
    const map = new Map<string, { job_no: string; style_no: string; planned_qty: number; pct: number }>();
    const total = [...linePlans.values()].reduce((a, p) => a + p.assigned_qty, 0);
    for (const [, plan] of linePlans) {
      for (const b of plan.bundles) {
        const key = b.job_no || '—';
        if (!map.has(key)) map.set(key, { job_no: key, style_no: b.style_no || '—', planned_qty: 0, pct: 0 });
        map.get(key)!.planned_qty += n(b.planned_qty);
      }
    }
    for (const [, v] of map) v.pct = total > 0 ? Math.round((v.planned_qty / total) * 100) : 0;
    return [...map.values()];
  }, [linePlans]);

  // Style-wise plan summary
  const styleSummary = useMemo(() => {
    const map = new Map<string, { style_no: string; description: string; planned_qty: number; pct: number }>();
    const total = [...linePlans.values()].reduce((a, p) => a + p.assigned_qty, 0);
    for (const [, plan] of linePlans) {
      for (const b of plan.bundles) {
        const key = b.style_no || '—';
        if (!map.has(key)) map.set(key, { style_no: key, description: b.style_description || '—', planned_qty: 0, pct: 0 });
        map.get(key)!.planned_qty += n(b.planned_qty);
      }
    }
    for (const [, v] of map) v.pct = total > 0 ? Math.round((v.planned_qty / total) * 100) : 0;
    return [...map.values()];
  }, [linePlans]);

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{title}</h1>
          <p className="text-sm text-slate-500">
            Plan daily {processType} targets by line with bundle-level detail
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>Production</span> <span>›</span> <span className="capitalize">{processType}</span> <span>›</span>
          <span className="font-medium text-slate-700">Daily Plan</span>
        </div>
      </div>

      {/* Filters */}
      <Card className="!p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Input label="Plan Date *" type="date" className="w-40" value={planDate}
            onChange={(e) => setPlanDate(e.target.value)} />
          <Input label={isChecking ? 'Checking Floor' : 'Sewing Floor'} className="w-44" value={floorName}
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
        {/* Filter row */}
        <div className="flex flex-wrap items-end gap-2 mt-2 pt-2 border-t border-slate-100">
          <Select label="Job No" className="w-28" value={filterJob}
            onChange={(e) => setFilterJob(e.target.value)} placeholder="All"
            options={[...new Set(pendingBundles.map(b => b.job_no))].map(j => ({ value: j, label: j }))} />
          <Select label="PO No" className="w-28" value={filterPO}
            onChange={(e) => setFilterPO(e.target.value)} placeholder="All"
            options={[...new Set(pendingBundles.map(b => b.po_no).filter(Boolean))].map(p => ({ value: p!, label: p! }))} />
          <Select label="Style No" className="w-28" value={filterStyle}
            onChange={(e) => setFilterStyle(e.target.value)} placeholder="All"
            options={[...new Set(pendingBundles.map(b => b.style_no).filter(Boolean))].map(s => ({ value: s!, label: s! }))} />
          <Select label="Colour" className="w-28" value={filterColour}
            onChange={(e) => setFilterColour(e.target.value)} placeholder="All"
            options={[...new Set(pendingBundles.map(b => b.colour).filter(Boolean))].map(c => ({ value: c!, label: c! }))} />
          <Select label="Size" className="w-24" value={filterSize}
            onChange={(e) => setFilterSize(e.target.value)} placeholder="All"
            options={[...new Set(pendingBundles.map(b => b.size).filter(Boolean))].map(s => ({ value: s!, label: s! }))} />
        </div>
      </Card>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
        {/* Pending for Checking */}
        <SumCard label="Total Bundles" value={pendingSummary.totalBundles} icon={<Boxes size={18} />}
          tone="bg-blue-50 border-blue-200 text-blue-800" />
        <SumCard label="Total Qty (PCS)" value={fmtNumber(pendingSummary.totalQty)} icon={<Layers size={18} />}
          tone="bg-violet-50 border-violet-200 text-violet-800" />
        <SumCard label="Allocated" value={fmtNumber(pendingSummary.allocated)} icon={<CheckCircle2 size={18} />}
          tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
        <SumCard label="Unallocated" value={fmtNumber(pendingSummary.unallocated)} icon={<AlertTriangle size={18} />}
          tone="bg-red-50 border-red-200 text-red-800" />
        {/* Line Capacity */}
        <SumCard label="Total Lines" value={lineCapSummary.totalLines} icon={<Layers size={18} />}
          tone="bg-slate-50 border-slate-200 text-slate-800" />
        <SumCard label="Total Capacity (PCS)" value={fmtNumber(lineCapSummary.totalCapacity)} icon={<CheckCircle2 size={18} />}
          tone="bg-cyan-50 border-cyan-200 text-cyan-800" />
        <SumCard label="Planned Qty (PCS)" value={fmtNumber(lineCapSummary.plannedQty)} icon={<CheckCircle2 size={18} />}
          tone="bg-brand-50 border-brand-200 text-brand-800" />
        <SumCard label="Utilization" value={`${lineCapSummary.utilization}%`} icon={<Settings2 size={18} />}
          tone={`${lineCapSummary.utilization >= 80 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`} />
      </div>

      {/* Tabs + Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs tabs={PLAN_TABS} active={activeTab} onChange={(k) => setActiveTab(k as TabKey)} />
        <div className="flex gap-2">
          <Button size="sm" onClick={autoPlan}><Zap size={13} className="mr-1" /> Auto Plan</Button>
          <Button size="sm" variant="secondary"><Copy size={13} className="mr-1" /> Copy Previous Day</Button>
          <Button size="sm" variant="danger" onClick={clearPlan}><XCircle size={13} className="mr-1" /> Clear Plan</Button>
          <Button size="sm" variant="secondary"><FileSpreadsheet size={13} className="mr-1" /> Import from Excel</Button>
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'line' && (
        <div className="space-y-4">
          {/* Line Plan Header */}
          <Card title={`${isChecking ? 'Checking' : 'Sewing'} Line Plan – ${fmtDate(planDate)} (${shiftId ? 'Day Shift' : 'Day Shift'})`}>
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="w-8 px-2 py-2"><input type="checkbox" /></th>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Line Code</th>
                  <th className="px-2 py-2 text-left">Line Name</th>
                  <th className="px-2 py-2 text-left">Supervisor</th>
                  <th className="px-2 py-2 text-right">Target Qty (PCS)</th>
                  <th className="px-2 py-2 text-right">Assigned Qty (PCS)</th>
                  <th className="px-2 py-2 text-right">Balance (PCS)</th>
                  <th className="px-2 py-2 text-left">Utilization</th>
                  <th className="px-2 py-2 text-right">No. of Operators</th>
                  <th className="px-2 py-2 text-left">Status</th>
                  <th className="px-2 py-2 text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const plan = linePlans.get(l.id);
                  if (!plan) return null;
                  return (
                    <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-2 py-2 text-center"><input type="checkbox" /></td>
                      <td className="px-2 py-2 text-slate-400">{i + 1}</td>
                      <td className="px-2 py-2 font-mono font-semibold text-brand-700">{l.line_code}</td>
                      <td className="px-2 py-2 font-medium">{l.line_name}</td>
                      <td className="px-2 py-2">
                        <select className="input h-6 w-24 text-[11px]">
                          <option>—</option>
                        </select>
                      </td>
                      <td className="px-2 py-2 text-right font-medium">{fmtNumber(plan.target_qty)}</td>
                      <td className="px-2 py-2 text-right font-medium text-emerald-700">{fmtNumber(plan.assigned_qty)}</td>
                      <td className={`px-2 py-2 text-right font-medium ${plan.balance < 0 ? 'text-red-600' : ''}`}>
                        {fmtNumber(plan.balance)}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-2.5 w-16 overflow-hidden rounded-full bg-slate-100">
                            <div className={`h-full rounded-full ${plan.utilization >= 90 ? 'bg-emerald-500' : plan.utilization >= 70 ? 'bg-blue-500' : plan.utilization >= 50 ? 'bg-amber-500' : 'bg-red-400'}`}
                              style={{ width: `${Math.min(100, plan.utilization)}%` }} />
                          </div>
                          <span className="text-[11px]">{plan.utilization}%</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right">{plan.operators}</td>
                      <td className="px-2 py-2"><Badge tone="blue">Planned</Badge></td>
                      <td className="px-2 py-2 text-center">
                        <button className="text-brand-600 hover:text-brand-800" onClick={() => toggleLine(l.id)}>
                          {expandedLines.has(l.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* Expanded Line Details */}
          {lines.map((l, li) => {
            if (!expandedLines.has(l.id)) return null;
            const plan = linePlans.get(l.id);
            if (!plan) return null;

            return (
              <Card key={l.id}>
                <div className="flex items-center justify-between px-4 py-2 bg-brand-50 border-b border-brand-100 rounded-t-xl">
                  <span className="font-bold text-sm text-brand-900">
                    Line {String(li + 1).padStart(2, '0')} – {l.line_code}
                    <span className="ml-2 font-normal text-slate-600">
                      (Target: {fmtNumber(plan.target_qty)} PCS | Assigned: {fmtNumber(plan.assigned_qty)} PCS)
                    </span>
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => {
                      if (pendingBundles.length > 0) addBundleToLine(l.id, pendingBundles[0]);
                    }}>
                      <Plus size={12} className="mr-1" /> Add Job
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => {
                      if (pendingBundles.length > 0) addBundleToLine(l.id, pendingBundles[0]);
                    }}>
                      <Plus size={12} className="mr-1" /> Add Bundle
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => {
                      for (const b of plan.bundles) removeBundleFromLine(l.id, b.bundle_id);
                    }}>Remove Selected</Button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  {plan.bundles.length > 0 ? (
                    <table className="w-full text-xs">
                      <thead className="bg-white text-slate-500">
                        <tr>
                          <th className="w-8 px-2 py-1.5"><input type="checkbox" /></th>
                          <th className="px-2 py-1.5 text-left">#</th>
                          <th className="px-2 py-1.5 text-left">Job No</th>
                          <th className="px-2 py-1.5 text-left">PO No</th>
                          <th className="px-2 py-1.5 text-left">Style No</th>
                          <th className="px-2 py-1.5 text-left">Style Description</th>
                          <th className="px-2 py-1.5 text-left">Colour</th>
                          <th className="px-2 py-1.5 text-left">Size</th>
                          <th className="px-2 py-1.5 text-left">Bundle ID</th>
                          <th className="px-2 py-1.5 text-right">Bundle Qty (PCS)</th>
                          <th className="px-2 py-1.5 text-right">Planned Qty (PCS)</th>
                          <th className="px-2 py-1.5 text-left">Remarks</th>
                          <th className="px-2 py-1.5 text-center">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.bundles.map((b, bi) => (
                          <tr key={b.bundle_id} className="border-t border-slate-100">
                            <td className="px-2 py-1 text-center"><input type="checkbox" /></td>
                            <td className="px-2 py-1 text-slate-400">{bi + 1}</td>
                            <td className="px-2 py-1 font-mono text-brand-700">{b.job_no}</td>
                            <td className="px-2 py-1">{b.po_no || '—'}</td>
                            <td className="px-2 py-1 font-medium">{b.style_no || '—'}</td>
                            <td className="px-2 py-1 text-slate-500">{b.style_description || '—'}</td>
                            <td className="px-2 py-1">{b.colour || '—'}</td>
                            <td className="px-2 py-1 font-semibold">{b.size || '—'}</td>
                            <td className="px-2 py-1 font-mono font-semibold text-slate-800">{b.bundle_no}</td>
                            <td className="px-2 py-1 text-right">{fmtNumber(b.bundle_qty)}</td>
                            <td className="px-2 py-1 text-right font-medium">{fmtNumber(b.planned_qty)}</td>
                            <td className="px-2 py-1">
                              <input className="input h-6 w-20 text-[11px]" placeholder="..." />
                            </td>
                            <td className="px-2 py-1 text-center">
                              <button className="text-red-500 hover:text-red-700"
                                onClick={() => removeBundleFromLine(l.id, b.bundle_id)}>
                                <Trash2 size={14} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="py-6 text-center text-sm text-slate-400">
                      No bundles assigned. Use Auto Plan or add bundles manually.
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Bottom Summaries */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Line Wise Summary */}
        <Card title="Line Wise Plan Summary">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-2 py-1.5 text-left">Line Code</th>
                <th className="px-2 py-1.5 text-left">Line Name</th>
                <th className="px-2 py-1.5 text-right">Target Qty</th>
                <th className="px-2 py-1.5 text-right">Assigned Qty</th>
                <th className="px-2 py-1.5 text-right">Balance</th>
                <th className="px-2 py-1.5 text-left">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const plan = linePlans.get(l.id);
                if (!plan) return null;
                return (
                  <tr key={l.id} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-mono text-brand-700">{l.line_code}</td>
                    <td className="px-2 py-1">{l.line_name}</td>
                    <td className="px-2 py-1 text-right">{fmtNumber(plan.target_qty)}</td>
                    <td className="px-2 py-1 text-right font-medium">{fmtNumber(plan.assigned_qty)}</td>
                    <td className="px-2 py-1 text-right">{fmtNumber(plan.balance)}</td>
                    <td className="px-2 py-1">
                      <div className="flex items-center gap-1.5">
                        <div className="h-2 w-12 overflow-hidden rounded-full bg-slate-100">
                          <div className={`h-full rounded-full ${plan.utilization >= 90 ? 'bg-emerald-500' : plan.utilization >= 50 ? 'bg-amber-500' : 'bg-red-400'}`}
                            style={{ width: `${Math.min(100, plan.utilization)}%` }} />
                        </div>
                        <span>{plan.utilization}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        {/* Job Wise Summary */}
        <Card title="Job Wise Plan Summary">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-2 py-1.5 text-left">Job No</th>
                <th className="px-2 py-1.5 text-left">Style No</th>
                <th className="px-2 py-1.5 text-right">Planned Qty (PCS)</th>
                <th className="px-2 py-1.5 text-left">%</th>
              </tr>
            </thead>
            <tbody>
              {jobSummary.map(j => (
                <tr key={j.job_no} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono text-brand-700">{j.job_no}</td>
                  <td className="px-2 py-1">{j.style_no}</td>
                  <td className="px-2 py-1 text-right font-medium">{fmtNumber(j.planned_qty)}</td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-12 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${j.pct}%` }} />
                      </div>
                      <span>{j.pct}%</span>
                    </div>
                  </td>
                </tr>
              ))}
              {!jobSummary.length && (
                <tr><td colSpan={4} className="px-4 py-4 text-center text-slate-400">No data</td></tr>
              )}
            </tbody>
          </table>
        </Card>

        {/* Style Wise Summary */}
        <Card title="Style Wise Plan Summary">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-2 py-1.5 text-left">Style No</th>
                <th className="px-2 py-1.5 text-left">Description</th>
                <th className="px-2 py-1.5 text-right">Planned Qty (PCS)</th>
                <th className="px-2 py-1.5 text-left">%</th>
              </tr>
            </thead>
            <tbody>
              {styleSummary.map(s => (
                <tr key={s.style_no} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-medium">{s.style_no}</td>
                  <td className="px-2 py-1 text-slate-500">{s.description}</td>
                  <td className="px-2 py-1 text-right font-medium">{fmtNumber(s.planned_qty)}</td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2 w-12 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-violet-500" style={{ width: `${s.pct}%` }} />
                      </div>
                      <span>{s.pct}%</span>
                    </div>
                  </td>
                </tr>
              ))}
              {!styleSummary.length && (
                <tr><td colSpan={4} className="px-4 py-4 text-center text-slate-400">No data</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      {/* Footer Actions */}
      <Card className="!p-0">
        <div className="flex flex-wrap items-center justify-end gap-3 px-4 py-3 bg-gradient-to-r from-brand-900 to-brand-800 rounded-xl">
          <Button variant="secondary" className="!bg-white/10 !text-white !border-white/20 hover:!bg-white/20">
            <X size={14} className="mr-1" /> Cancel
          </Button>
          <Button variant="secondary" className="!bg-blue-500 !text-white !border-blue-400 hover:!bg-blue-600"
            loading={saving} onClick={() => savePlan(false)}>
            <Save size={14} className="mr-1" /> Save Plan
          </Button>
          <Button className="!bg-emerald-500 hover:!bg-emerald-600 !border-emerald-400"
            loading={saving} onClick={() => savePlan(true)}>
            <Check size={14} className="mr-1" /> Save & Confirm Plan
          </Button>
          <Button variant="secondary" className="!bg-white/10 !text-white !border-white/20 hover:!bg-white/20">
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

// Export both Sewing and Checking daily plan pages
export function SewingDailyPlanPage() {
  return <DailyPlanPage processType="sewing" />;
}

export function CheckingDailyPlanPage() {
  return <DailyPlanPage processType="checking" />;
}

export default CheckingDailyPlanPage;
