import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, ChevronDown, ChevronRight, Trash2, Zap, Copy, XCircle, FileSpreadsheet, FolderOpen, FilePlus2,
  Layers, Boxes, AlertTriangle, CheckCircle2, Settings2, Search, Printer, Save, Check, X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Card, Badge, Button, Input, Select, Tabs, Modal, SearchInput } from '../../components/ui';
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
 * Daily Plan (Sewing / Checking) — developer doc §8–§10, §12; client images 2–3.
 *
 * A daily plan sets the target of a date + shift per line. Its rows come only
 * from CONFIRMED line allocations (a bundle is planned on the line it was
 * allocated to); the server re-checks remaining qty and line capacity on save.
 */

type Pending = BundleInfo & {
  allocation_detail_id: number; allocation_no: string; line_id: number; pending_qty: number;
  allocated_qty: number; completed_qty: number; sam: number;
};
type PlanRow = Pending & { planned_qty: number; priority: number; remarks: string };
type Line = {
  id: number; line_code: string; line_name: string; capacity_pcs: number; manpower: number;
  supervisor_name?: string | null; planned_other: number; sam_per_pcs: number;
};
type LineSetting = { supervisor_name: string; operators: number; target_qty: number; remarks: string };

type TabKey = 'line' | 'job' | 'style' | 'colour' | 'size' | 'pending';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'line', label: 'Line Plan' },
  { key: 'job', label: 'Job Wise Plan' },
  { key: 'style', label: 'Style Wise Plan' },
  { key: 'colour', label: 'Colour Wise Plan' },
  { key: 'size', label: 'Size Wise Plan' },
  { key: 'pending', label: 'Pending Stock' },
];

function DailyPlanPage({ proc }: { proc: Proc }) {
  const toast = useToast();
  const { can } = useAuth();
  const shifts = useLookup('shifts');
  const label = PROC_LABEL[proc];
  const fileRef = useRef<HTMLInputElement>(null);

  const [docId, setDocId] = useState<number | null>(null);
  const [docNo, setDocNo] = useState<string | null>(null);
  const [docStatus, setDocStatus] = useState<string | null>(null);
  const [planDate, setPlanDate] = useState(today());
  const [floorName, setFloorName] = useState(`${label} Floor-1`);
  const [shiftId, setShiftId] = useState('');
  const [planType, setPlanType] = useState<'LINE_WISE' | 'JOB_WISE'>('LINE_WISE');
  const [remarks, setRemarks] = useState('');
  const [override, setOverride] = useState(false);
  const editable = !docStatus || ['DRAFT', 'SAVED'].includes(docStatus);

  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [settings, setSettings] = useState<Record<number, LineSetting>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const [tab, setTab] = useState<TabKey>('line');
  const [filters, setFilters] = useState<RowFilters>(EMPTY_FILTERS);
  const [openLines, setOpenLines] = useState<Set<number>>(new Set());
  const [sel, setSel] = useState<Set<number>>(new Set());          // selected plan rows (allocation_detail_id)
  const [selPending, setSelPending] = useState<Set<number>>(new Set());
  const [picker, setPicker] = useState<{ lineId: number; mode: 'job' | 'bundle' } | null>(null);
  const [showDocs, setShowDocs] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const shiftNo = shiftId ? Number(shiftId) : null;
  const shiftName = shifts.data?.find((s: any) => String(s.id) === shiftId)?.label ?? 'All shifts';

  const load = useCallback(async (excludeId: number | null) => {
    setLoading(true);
    try {
      const [l, p] = await Promise.all([
        api.get(`/${proc}/lines`, { params: { date: planDate, shift_id: shiftNo ?? undefined, exclude_id: excludeId ?? 0 } }),
        api.get(`/${proc}/daily-plan/pending`, { params: { plan_date: planDate, exclude_id: excludeId ?? 0 } }),
      ]);
      const ls: Line[] = l.data.data || [];
      setLines(ls);
      setPending(p.data.data || []);
      setSettings((prev) => {
        const next = { ...prev };
        for (const x of ls) if (!next[x.id]) next[x.id] = { supervisor_name: x.supervisor_name || '', operators: n(x.manpower), target_qty: n(x.capacity_pcs), remarks: '' };
        return next;
      });
      setOpenLines((o) => (o.size ? o : new Set(ls.slice(0, 1).map((x) => x.id))));
    } catch (e: any) {
      toast(e?.message || 'Failed to load pending stock', 'error');
    } finally {
      setLoading(false);
    }
  }, [proc, planDate, shiftNo, toast]);

  useEffect(() => { load(docId); }, [load, docId]);

  const resetNew = () => {
    setDocId(null); setDocNo(null); setDocStatus(null); setRows([]); setRemarks(''); setOverride(false); setSel(new Set());
    setSettings({});
  };

  const openDoc = async (id: number) => {
    try {
      const r = await api.get(`/${proc}/daily-plan/${id}`);
      const d = r.data.data;
      setDocId(d.id); setDocNo(d.plan_no); setDocStatus(d.status);
      setPlanDate(String(d.plan_date).slice(0, 10)); setFloorName(d.floor_name || '');
      setShiftId(d.shift_id ? String(d.shift_id) : ''); setPlanType(d.plan_type || 'LINE_WISE'); setRemarks(d.remarks || '');
      const st: Record<number, LineSetting> = {};
      for (const l of d.lines || []) st[Number(l.line_id)] = { supervisor_name: l.supervisor_name || '', operators: n(l.operators), target_qty: n(l.target_qty), remarks: l.remarks || '' };
      setSettings(st);
      setRows((d.details || []).map((x: any) => ({
        ...x, allocation_detail_id: Number(x.allocation_detail_id), line_id: Number(x.line_id), bundle_id: Number(x.bundle_id),
        planned_qty: n(x.planned_qty), priority: n(x.priority), remarks: x.remarks || '', pending_qty: n(x.planned_qty),
      })));
      setOpenLines(new Set((d.details || []).map((x: any) => Number(x.line_id))));
      setSel(new Set());
    } catch (e: any) {
      toast(e?.message || 'Could not open plan', 'error');
    }
  };

  // Pending rows keyed by allocation row, and what is still free after this plan.
  const pendingMap = useMemo(() => new Map(pending.map((p) => [p.allocation_detail_id, p])), [pending]);
  const maxOf = (r: PlanRow) => pendingMap.get(r.allocation_detail_id)?.pending_qty ?? r.planned_qty;
  const planned = useMemo(() => new Map(rows.map((r) => [r.allocation_detail_id, r.planned_qty])), [rows]);
  const freePending = useMemo(() => pending
    .map((p) => ({ ...p, free_qty: p.pending_qty - (planned.get(p.allocation_detail_id) ?? 0) }))
    .filter((p) => p.free_qty > 0), [pending, planned]);

  const shownRows = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const shownPending = useMemo(() => applyFilters(freePending, filters), [freePending, filters]);

  const lineStat = (l: Line) => {
    const assigned = rows.filter((r) => r.line_id === l.id).reduce((a, r) => a + r.planned_qty, 0);
    const target = n(settings[l.id]?.target_qty) || n(l.capacity_pcs);
    const used = assigned + n(l.planned_other);
    return { assigned, target, used, balance: target - used, util: target ? Math.round((used / target) * 100) : 0, overCap: n(l.capacity_pcs) > 0 && used > n(l.capacity_pcs) };
  };
  const overLines = lines.filter((l) => lineStat(l).overCap);

  const totals = useMemo(() => {
    const plannedQty = rows.reduce((a, r) => a + r.planned_qty, 0);
    const unplanned = freePending.reduce((a, r) => a + r.free_qty, 0);
    const capacity = lines.reduce((a, l) => a + n(l.capacity_pcs), 0);
    return {
      bundles: new Set([...pending.map((p) => p.bundle_id), ...rows.map((r) => r.bundle_id)]).size,
      total: plannedQty + unplanned, planned: plannedQty, unplanned, capacity,
      util: capacity ? Math.round(((plannedQty + lines.reduce((a, l) => a + n(l.planned_other), 0)) / capacity) * 100) : 0,
    };
  }, [rows, freePending, pending, lines]);

  // ── Row actions ──
  const addRows = (items: (Pending & { free_qty: number })[], qtyOf?: (p: Pending & { free_qty: number }) => number) => {
    if (!editable || !items.length) return;
    setRows((prev) => {
      const next = [...prev];
      for (const p of items) {
        const q = Math.min(qtyOf ? qtyOf(p) : p.free_qty, p.free_qty);
        if (q <= 0) continue;
        const k = next.findIndex((r) => r.allocation_detail_id === p.allocation_detail_id);
        if (k >= 0) next[k] = { ...next[k], planned_qty: next[k].planned_qty + q };
        else next.push({ ...p, planned_qty: q, priority: 0, remarks: '' });
      }
      return next;
    });
    setOpenLines((o) => { const x = new Set(o); items.forEach((i) => x.add(i.line_id)); return x; });
  };
  const removeRows = (ids: number[]) => {
    if (!editable) return;
    const s = new Set(ids);
    setRows((prev) => prev.filter((r) => !s.has(r.allocation_detail_id)));
    setSel((x) => { const y = new Set(x); ids.forEach((i) => y.delete(i)); return y; });
  };
  const patchRow = (id: number, patch: Partial<PlanRow>) => setRows((prev) => prev.map((r) => (r.allocation_detail_id === id ? { ...r, ...patch } : r)));
  const patchSetting = (lineId: number, patch: Partial<LineSetting>) => setSettings((s) => ({ ...s, [lineId]: { ...s[lineId], ...patch } }));

  const autoPlan = async () => {
    try {
      const targets: Record<string, number> = {};
      for (const l of lines) targets[String(l.id)] = Math.max(lineStat(l).target - lineStat(l).assigned, 0) + n(l.planned_other);
      const r = await api.post(`/${proc}/daily-plan/auto-plan`, { plan_date: planDate, shift_id: shiftNo, exclude_id: docId ?? 0, targets });
      const prop: { allocation_detail_id: number; planned_qty: number }[] = r.data.data || [];
      const byId = new Map(freePending.map((p) => [p.allocation_detail_id, p]));
      const items = prop.map((x) => byId.get(x.allocation_detail_id)).filter(Boolean) as (Pending & { free_qty: number })[];
      const q = new Map(prop.map((x) => [x.allocation_detail_id, x.planned_qty]));
      addRows(items, (p) => q.get(p.allocation_detail_id) ?? 0);
      toast(items.length ? `Auto plan added ${items.length} bundle(s) within line targets` : 'Nothing left to plan within the line targets', items.length ? 'success' : 'warning');
    } catch (e: any) {
      toast(e?.message || 'Auto plan failed', 'error');
    }
  };

  const copyPrevious = async () => {
    try {
      const r = await api.post(`/${proc}/daily-plan/copy-previous`, { plan_date: planDate, shift_id: shiftNo, exclude_id: docId ?? 0 });
      const d = r.data.data;
      const byId = new Map(freePending.map((p) => [p.allocation_detail_id, p]));
      const q = new Map<number, number>((d.details || []).map((x: any) => [Number(x.allocation_detail_id), n(x.planned_qty)]));
      const items = [...q.keys()].map((id) => byId.get(id)).filter(Boolean) as (Pending & { free_qty: number })[];
      addRows(items, (p) => q.get(p.allocation_detail_id) ?? 0);
      for (const l of d.lines || []) patchSetting(Number(l.line_id), { supervisor_name: l.supervisor_name || '', operators: n(l.operators), target_qty: n(l.target_qty) });
      toast(`Copied ${items.length} bundle(s) from ${d.source_plan_no} (${fmtDate(d.source_plan_date)})${d.skipped ? ` — ${d.skipped} finished bundle(s) skipped` : ''}`);
    } catch (e: any) {
      toast(e?.message || 'Nothing to copy', 'warning');
    }
  };

  const clearPlan = () => { if (editable) { setRows([]); setSel(new Set()); toast('Plan cleared'); } };

  const importExcel = async (file: File) => {
    try {
      const wb = XLSX.read(await file.arrayBuffer());
      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      const norm = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[^a-z]/g, ''), v]));
      const items: (Pending & { free_qty: number })[] = [];
      const q = new Map<number, number>();
      const missing: string[] = [];
      for (const raw of data) {
        const r = norm(raw);
        const code = String(r.bundleid ?? r.bundleno ?? r.bundle ?? r.barcode ?? '').trim();
        if (!code) continue;
        const lineCode = String(r.linecode ?? r.line ?? '').trim();
        const hit = freePending.find((p) => (p.bundle_no === code || p.barcode === code)
          && (!lineCode || lines.find((l) => l.id === p.line_id)?.line_code === lineCode));
        if (!hit) { missing.push(code); continue; }
        items.push(hit);
        q.set(hit.allocation_detail_id, n(r.plannedqty ?? r.qty) || hit.free_qty);
      }
      addRows(items, (p) => q.get(p.allocation_detail_id) ?? p.free_qty);
      toast(`Imported ${items.length} row(s)${missing.length ? ` — not pending: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` : ''}`, missing.length ? 'warning' : 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not read the Excel file', 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const save = async (confirm: boolean) => {
    if (!rows.length) { toast('Add at least one bundle to the plan', 'warning'); return; }
    if (overLines.length && !override) { toast(`Over capacity on ${overLines.map((l) => l.line_code).join(', ')} — reduce or tick "Override capacity"`, 'warning'); return; }
    const usedLines = new Set(rows.map((r) => r.line_id));
    const body = {
      plan_date: planDate, floor_name: floorName || null, shift_id: shiftNo, plan_type: planType,
      unallocated_qty: totals.unplanned, remarks: remarks || null, capacity_override: override, confirm,
      lines: [...usedLines].map((id) => ({ line_id: id, supervisor_name: settings[id]?.supervisor_name || null, operators: n(settings[id]?.operators), target_qty: n(settings[id]?.target_qty), remarks: settings[id]?.remarks || null })),
      details: rows.map((r) => ({ allocation_detail_id: r.allocation_detail_id, line_id: r.line_id, planned_qty: r.planned_qty, priority: r.priority, remarks: r.remarks || null })),
    };
    setSaving(true);
    try {
      const r = docId ? await api.put(`/${proc}/daily-plan/${docId}`, body) : await api.post(`/${proc}/daily-plan`, body);
      const d = r.data.data;
      toast(`Plan ${d.plan_no} ${confirm ? 'confirmed' : 'saved'} — ${d.total_bundles} bundles, ${fmtNumber(d.allocated_qty)} PCS`);
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
      await api.post(`/${proc}/daily-plan/${docId}/cancel`, { reason: cancelReason });
      toast(`Plan ${docNo} cancelled`);
      setCancelOpen(false); setCancelReason('');
      resetNew();
      load(null);
    } catch (e: any) {
      toast(e?.message || 'Cancel failed', 'error');
    }
  };

  const print = () => {
    if (!rows.length) { toast('Nothing to print', 'warning'); return; }
    printDocument(`${label} Daily Plan ${docNo ?? '(unsaved)'}`, [
      ['Plan date', fmtDate(planDate)], ['Floor', floorName], ['Shift', shiftName], ['Status', docStatus ?? 'Unsaved'],
      ['Bundles', rows.length], ['Planned PCS', totals.planned],
    ], lines.filter((l) => rows.some((r) => r.line_id === l.id)).map((l) => {
      const s = lineStat(l);
      const pr = printRowsByJob(rows.filter((r) => r.line_id === l.id), (r) => [r.bundle_no, r.colour, r.size, r.bundle_qty, r.planned_qty, r.priority ? 'Urgent' : 'Normal', r.remarks]);
      return {
        heading: `${l.line_code} — ${l.line_name} · Supervisor ${settings[l.id]?.supervisor_name || '—'} · Target ${s.target} · Assigned ${s.assigned} PCS`,
        columns: ['Bundle', 'Colour', 'Size', 'Bundle Qty', 'Planned Qty', 'Priority', 'Remarks'], ...pr,
      };
    }));
  };

  const qtyOf = (r: PlanRow) => r.planned_qty;
  const supervisors = [...new Set(lines.map((l) => l.supervisor_name).filter(Boolean))] as string[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Daily Plan – {label}</h1>
          <p className="text-sm text-slate-500">Plan the day's {label.toLowerCase()} target per line from confirmed line allocations</p>
        </div>
        <div className="flex items-center gap-2">
          <DocStatus no={docNo} status={docStatus} />
          <Button size="sm" variant="secondary" onClick={() => setShowDocs(true)}><FolderOpen size={13} className="mr-1" /> Open</Button>
          <Button size="sm" variant="secondary" onClick={() => { resetNew(); load(null); }}><FilePlus2 size={13} className="mr-1" /> New</Button>
        </div>
      </div>

      <Card className="!p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Input label="Plan Date *" type="date" className="w-40" value={planDate} disabled={!editable} onChange={(e) => setPlanDate(e.target.value)} />
          <Input label={`${label} Floor`} className="w-44" value={floorName} disabled={!editable} onChange={(e) => setFloorName(e.target.value)} />
          <Select label="Shift" className="w-44" value={shiftId} disabled={!editable} onChange={(e) => setShiftId(e.target.value)} placeholder="Select shift" options={toOptions(shifts.data)} />
          <div className="flex h-10 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3">
            <span className="text-xs font-medium text-slate-600">Plan Type</span>
            {(['LINE_WISE', 'JOB_WISE'] as const).map((t) => (
              <label key={t} className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" className="accent-brand-600" checked={planType === t}
                  onChange={() => { setPlanType(t); setTab(t === 'JOB_WISE' ? 'job' : 'line'); }} />
                <span className="text-xs">{t === 'LINE_WISE' ? 'Line Wise' : 'Job Wise'}</span>
              </label>
            ))}
          </div>
          <Button variant="secondary" className="!h-10 ml-auto" onClick={() => load(docId)} loading={loading}><Search size={14} className="mr-1" /> Load Pending</Button>
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
          {([
            ['job', 'Job No', distinct([...pending, ...rows], (b) => b.io_no)],
            ['po', 'PO No', distinct([...pending, ...rows], (b) => b.po_no)],
            ['style', 'Style No', distinct([...pending, ...rows], (b) => b.style_no)],
            ['buyer', 'Buyer', distinct([...pending, ...rows], (b) => b.buyer)],
            ['colour', 'Colour', distinct([...pending, ...rows], (b) => b.colour)],
            ['size', 'Size', distinct([...pending, ...rows], (b) => b.size)],
          ] as const).map(([k, lbl, opts]) => (
            <Select key={k} label={lbl} className="w-36" value={filters[k]} placeholder="All" options={opts as any}
              onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))} />
          ))}
          {Object.values(filters).some(Boolean) && <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button>}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Card title={`Pending for ${label} (from confirmed line allocation)`}>
          <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
            <SummaryCard icon={<Boxes size={18} />} label="Total Bundles" value={totals.bundles} tone="bg-violet-50 border-violet-200 text-violet-800" />
            <SummaryCard icon={<Layers size={18} />} label="Total Qty (PCS)" value={fmtNumber(totals.total)} tone="bg-blue-50 border-blue-200 text-blue-800" />
            <SummaryCard icon={<CheckCircle2 size={18} />} label="Planned" value={fmtNumber(totals.planned)} tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
            <SummaryCard icon={<AlertTriangle size={18} />} label="Unplanned" value={fmtNumber(totals.unplanned)} tone="bg-red-50 border-red-200 text-red-800" />
          </div>
        </Card>
        <Card title={`Line Capacity (${fmtDate(planDate)} · ${shiftName})`}>
          <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
            <SummaryCard icon={<Layers size={18} />} label="Total Lines" value={lines.length} tone="bg-slate-50 border-slate-200 text-slate-800" />
            <SummaryCard icon={<CheckCircle2 size={18} />} label="Total Capacity (PCS)" value={fmtNumber(totals.capacity)} tone="bg-cyan-50 border-cyan-200 text-cyan-800" />
            <SummaryCard icon={<AlertTriangle size={18} />} label="Planned Qty (PCS)" value={fmtNumber(totals.planned + lines.reduce((a, l) => a + n(l.planned_other), 0))} tone="bg-rose-50 border-rose-200 text-rose-800" />
            <SummaryCard icon={<Settings2 size={18} />} label="Utilization" value={`${totals.util}%`} tone="bg-blue-50 border-blue-200 text-blue-800" />
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs tabs={TABS.map((t) => (t.key === 'pending' ? { ...t, count: shownPending.length } : t))} active={tab} onChange={(k) => setTab(k as TabKey)} />
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={autoPlan} disabled={!freePending.length}><Zap size={13} className="mr-1" /> Auto Plan</Button>
            <Button size="sm" variant="secondary" onClick={copyPrevious}><Copy size={13} className="mr-1" /> Copy Previous Day</Button>
            <Button size="sm" variant="danger" onClick={clearPlan} disabled={!rows.length}><XCircle size={13} className="mr-1" /> Clear Plan</Button>
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}><FileSpreadsheet size={13} className="mr-1" /> Import from Excel</Button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && importExcel(e.target.files[0])} />
          </div>
        )}
      </div>

      {tab === 'line' && (
        <div className="space-y-4">
          <Card title={`${label} Line Plan – ${fmtDate(planDate)} (${shiftName})`}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-2 py-2 text-left">Line Code</th>
                    <th className="px-2 py-2 text-left">Line Name</th>
                    <th className="px-2 py-2 text-left">Supervisor</th>
                    <th className="px-2 py-2 text-right">Target Qty</th>
                    <th className="px-2 py-2 text-right">Assigned Qty</th>
                    <th className="px-2 py-2 text-right">Balance</th>
                    <th className="px-2 py-2 text-left">Utilization</th>
                    <th className="px-2 py-2 text-right">Operators</th>
                    <th className="px-2 py-2 text-left">Status</th>
                    <th className="px-2 py-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const s = lineStat(l);
                    const st = settings[l.id];
                    return (
                      <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-2 py-1.5 font-mono font-semibold text-brand-700">{l.line_code}</td>
                        <td className="px-2 py-1.5 font-medium">{l.line_name}</td>
                        <td className="px-2 py-1.5">
                          <input list={`sup-${proc}`} className="input h-7 w-32 text-[11px]" disabled={!editable} value={st?.supervisor_name ?? ''}
                            onChange={(e) => patchSetting(l.id, { supervisor_name: e.target.value })} />
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <input type="number" min={0} className="input h-7 w-24 text-right text-[11px]" disabled={!editable} value={st?.target_qty ?? 0}
                            onChange={(e) => patchSetting(l.id, { target_qty: Math.max(0, Number(e.target.value) || 0) })} />
                        </td>
                        <td className="px-2 py-1.5 text-right font-medium text-emerald-700" title={l.planned_other ? `${l.planned_other} PCS on other plans of this date/shift` : undefined}>
                          {fmtNumber(s.used)}
                        </td>
                        <td className={`px-2 py-1.5 text-right font-medium ${s.balance < 0 ? 'text-red-600' : ''}`}>{fmtNumber(s.balance)}</td>
                        <td className="px-2 py-1.5"><UtilBar value={s.util} /></td>
                        <td className="px-2 py-1.5 text-right">
                          <input type="number" min={0} className="input h-7 w-16 text-right text-[11px]" disabled={!editable} value={st?.operators ?? 0}
                            onChange={(e) => patchSetting(l.id, { operators: Math.max(0, Number(e.target.value) || 0) })} />
                        </td>
                        <td className="px-2 py-1.5">
                          {s.assigned ? <Badge tone={s.overCap ? 'red' : 'green'}>{s.overCap ? 'Over capacity' : 'Planned'}</Badge> : <Badge tone="slate">Not planned</Badge>}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <button className="text-brand-600 hover:text-brand-800" onClick={() => setOpenLines((o) => { const x = new Set(o); x.has(l.id) ? x.delete(l.id) : x.add(l.id); return x; })}>
                            {openLines.has(l.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!lines.length && <tr><td colSpan={10} className="px-4 py-6 text-center text-slate-400">No active {label.toLowerCase()} lines</td></tr>}
                </tbody>
              </table>
              <datalist id={`sup-${proc}`}>{supervisors.map((s) => <option key={s} value={s} />)}</datalist>
            </div>
          </Card>

          {lines.filter((l) => openLines.has(l.id)).map((l) => {
            const s = lineStat(l);
            const lineRows = shownRows.filter((r) => r.line_id === l.id);
            const ids = lineRows.map((r) => r.allocation_detail_id);
            const selHere = ids.filter((i) => sel.has(i));
            return (
              <Card key={l.id}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-brand-50 px-4 py-2">
                  <span className="text-sm font-bold text-brand-900">
                    {l.line_code} – {l.line_name}
                    <span className="ml-2 font-normal text-slate-600">(Target: {fmtNumber(s.target)} PCS | Assigned: {fmtNumber(s.assigned)} PCS)</span>
                  </span>
                  {editable && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setPicker({ lineId: l.id, mode: 'job' })}><Plus size={12} className="mr-1" /> Add Job</Button>
                      <Button size="sm" variant="secondary" onClick={() => setPicker({ lineId: l.id, mode: 'bundle' })}><Plus size={12} className="mr-1" /> Add Bundle</Button>
                      <Button size="sm" variant="danger" disabled={!selHere.length} onClick={() => removeRows(selHere)}>Remove Selected</Button>
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto">
                  {lineRows.length ? (
                    <table className="w-full text-xs">
                      <thead className="bg-white text-slate-500">
                        <tr>
                          <th className="w-8 px-2 py-1.5">
                            <input type="checkbox" disabled={!editable} checked={ids.length > 0 && selHere.length === ids.length}
                              onChange={() => setSel((x) => { const y = new Set(x); const all = selHere.length === ids.length; ids.forEach((i) => (all ? y.delete(i) : y.add(i))); return y; })} />
                          </th>
                          <th className="px-2 py-1.5 text-left">Bundle ID</th>
                          <th className="px-2 py-1.5 text-left">Colour</th>
                          <th className="px-2 py-1.5 text-left">Size</th>
                          <th className="px-2 py-1.5 text-right">Bundle Qty</th>
                          <th className="px-2 py-1.5 text-right">Left to Plan</th>
                          <th className="px-2 py-1.5 text-right">Planned Qty</th>
                          <th className="px-2 py-1.5 text-left">Priority</th>
                          <th className="px-2 py-1.5 text-left">Remarks</th>
                          <th className="px-2 py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {groupByJob(lineRows).map((g) => [
                          <JobHeaderRow key={g.key} group={g} colSpan={10} qty={g.rows.reduce((a, r) => a + r.planned_qty, 0)} />,
                          ...g.rows.map((r) => (
                            <tr key={r.allocation_detail_id} className="border-t border-slate-100">
                              <td className="px-2 py-1 text-center">
                                <input type="checkbox" disabled={!editable} checked={sel.has(r.allocation_detail_id)}
                                  onChange={() => setSel((x) => { const y = new Set(x); y.has(r.allocation_detail_id) ? y.delete(r.allocation_detail_id) : y.add(r.allocation_detail_id); return y; })} />
                              </td>
                              <td className="px-2 py-1 font-mono font-semibold">{r.bundle_no}</td>
                              <td className="px-2 py-1">{r.colour || '—'}</td>
                              <td className="px-2 py-1 font-semibold">{r.size || '—'}</td>
                              <td className="px-2 py-1 text-right">{fmtNumber(r.bundle_qty)}</td>
                              <td className="px-2 py-1 text-right text-slate-500">{fmtNumber(maxOf(r))}</td>
                              <td className="px-2 py-1 text-right">
                                {editable ? (
                                  <input type="number" min={1} max={maxOf(r)} className="input h-6 w-20 text-right text-[11px]" value={r.planned_qty}
                                    onChange={(e) => patchRow(r.allocation_detail_id, { planned_qty: Math.max(1, Math.min(Math.floor(Number(e.target.value)) || 1, maxOf(r))) })} />
                                ) : fmtNumber(r.planned_qty)}
                              </td>
                              <td className="px-2 py-1">
                                <select className="input h-6 w-24 text-[11px]" disabled={!editable} value={r.priority}
                                  onChange={(e) => patchRow(r.allocation_detail_id, { priority: Number(e.target.value) })}>
                                  <option value={0}>Normal</option><option value={1}>Urgent</option>
                                </select>
                              </td>
                              <td className="px-2 py-1">
                                <input className="input h-6 w-36 text-[11px]" disabled={!editable} value={r.remarks}
                                  onChange={(e) => patchRow(r.allocation_detail_id, { remarks: e.target.value })} />
                              </td>
                              <td className="px-2 py-1 text-center">
                                {editable && <button className="text-red-500 hover:text-red-700" onClick={() => removeRows([r.allocation_detail_id])}><Trash2 size={14} /></button>}
                              </td>
                            </tr>
                          )),
                        ])}
                      </tbody>
                    </table>
                  ) : (
                    <p className="py-6 text-center text-sm text-slate-400">
                      No bundles planned. {freePending.some((p) => p.line_id === l.id) ? 'Use Add Job / Add Bundle or Auto Plan.' : 'Nothing is allocated to this line — confirm a line allocation first.'}
                    </p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {tab === 'job' && <Card><SummaryTable keyLabel="Job No" labelHeader="Style" data={summarize(shownRows, (r) => r.io_no ?? '', qtyOf, (r) => r.style_no ?? '')} /></Card>}
      {tab === 'style' && <Card><SummaryTable keyLabel="Style No" labelHeader="Description" data={summarize(shownRows, (r) => r.style_no ?? '', qtyOf, (r) => r.style_description ?? '')} /></Card>}
      {tab === 'colour' && <Card><SummaryTable keyLabel="Colour" data={summarize(shownRows, (r) => r.colour ?? '', qtyOf)} /></Card>}
      {tab === 'size' && <Card><SummaryTable keyLabel="Size" data={summarize(shownRows, (r) => r.size ?? '', qtyOf)} /></Card>}
      {tab === 'pending' && (
        <Card title="Pending stock (confirmed allocation, not yet planned)"
          actions={editable && <Button size="sm" disabled={!selPending.size} onClick={() => { addRows(shownPending.filter((p) => selPending.has(p.allocation_detail_id))); setSelPending(new Set()); }}>
            <Plus size={12} className="mr-1" /> Add {selPending.size || ''} to plan</Button>}>
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="px-2 py-2 text-left">Line</th>
                  <th className="px-2 py-2 text-left">Bundle ID</th>
                  <th className="px-2 py-2 text-left">Colour</th>
                  <th className="px-2 py-2 text-left">Size</th>
                  <th className="px-2 py-2 text-left">Allocation</th>
                  <th className="px-2 py-2 text-right">Pending (PCS)</th>
                </tr>
              </thead>
              <tbody>
                {groupByJob(shownPending).map((g) => {
                  const ids = g.rows.map((r) => r.allocation_detail_id);
                  const all = ids.every((i) => selPending.has(i));
                  return [
                    <JobHeaderRow key={g.key} group={g} colSpan={7} qty={g.rows.reduce((a, r) => a + r.free_qty, 0)} checked={all}
                      onCheck={editable ? () => setSelPending((x) => { const y = new Set(x); ids.forEach((i) => (all ? y.delete(i) : y.add(i))); return y; }) : undefined} />,
                    ...g.rows.map((p) => (
                      <tr key={p.allocation_detail_id} className="border-t border-slate-100">
                        <td className="px-2 py-1 text-center">
                          <input type="checkbox" disabled={!editable} checked={selPending.has(p.allocation_detail_id)}
                            onChange={() => setSelPending((x) => { const y = new Set(x); y.has(p.allocation_detail_id) ? y.delete(p.allocation_detail_id) : y.add(p.allocation_detail_id); return y; })} />
                        </td>
                        <td className="px-2 py-1 font-mono text-brand-700">{lines.find((l) => l.id === p.line_id)?.line_code ?? p.line_id}</td>
                        <td className="px-2 py-1 font-mono font-semibold">{p.bundle_no}</td>
                        <td className="px-2 py-1">{p.colour || '—'}</td>
                        <td className="px-2 py-1 font-semibold">{p.size || '—'}</td>
                        <td className="px-2 py-1 text-slate-500">{p.allocation_no}</td>
                        <td className="px-2 py-1 text-right font-medium">{fmtNumber(p.free_qty)}</td>
                      </tr>
                    )),
                  ];
                })}
                {!shownPending.length && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">{loading ? 'Loading…' : 'Nothing pending — confirm a line allocation to plan its bundles'}</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Bottom summaries (image 3) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Line Wise Plan Summary">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-2 py-1.5 text-left">Line</th>
                <th className="px-2 py-1.5 text-right">Target</th>
                <th className="px-2 py-1.5 text-right">Assigned</th>
                <th className="px-2 py-1.5 text-right">Balance</th>
                <th className="px-2 py-1.5 text-left">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const s = lineStat(l);
                return (
                  <tr key={l.id} className="border-t border-slate-100">
                    <td className="px-2 py-1 font-mono text-brand-700">{l.line_code}</td>
                    <td className="px-2 py-1 text-right">{fmtNumber(s.target)}</td>
                    <td className="px-2 py-1 text-right font-medium">{fmtNumber(s.used)}</td>
                    <td className={`px-2 py-1 text-right ${s.balance < 0 ? 'text-red-600' : ''}`}>{fmtNumber(s.balance)}</td>
                    <td className="px-2 py-1"><UtilBar value={s.util} width="w-14" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        <Card title="Job Wise Plan Summary"><SummaryTable keyLabel="Job No" labelHeader="Style" data={summarize(rows, (r) => r.io_no ?? '', qtyOf, (r) => r.style_no ?? '')} /></Card>
        <Card title="Style Wise Plan Summary"><SummaryTable keyLabel="Style No" labelHeader="Description" data={summarize(rows, (r) => r.style_no ?? '', qtyOf, (r) => r.style_description ?? '')} /></Card>
      </div>

      <Card className="!p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-brand-900 to-brand-800 px-4 py-3 text-white">
          <div className="flex gap-6">
            {[['Bundles', rows.length], ['Planned (PCS)', fmtNumber(totals.planned)], ['Unplanned (PCS)', fmtNumber(totals.unplanned)], ['Planned %', `${pct(totals.planned, totals.total)}%`]].map(([k, v]) => (
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
            {docId && !['CANCELLED', 'COMPLETED', 'CLOSED'].includes(docStatus ?? '') && (
              <Button variant="secondary" className="!border-white/20 !bg-white/10 !text-white" onClick={() => setCancelOpen(true)}><X size={14} className="mr-1" /> Cancel Plan</Button>
            )}
            {editable && (
              <>
                <Button variant="secondary" className="!border-blue-400 !bg-blue-500 !text-white" loading={saving} onClick={() => save(false)}><Save size={14} className="mr-1" /> Save Plan</Button>
                <Button className="!border-emerald-400 !bg-emerald-500" loading={saving} onClick={() => save(true)} disabled={!can('PRODUCTION.UPDATE')}><Check size={14} className="mr-1" /> Save & Confirm Plan</Button>
              </>
            )}
            <Button variant="secondary" className="!border-white/20 !bg-white/10 !text-white" onClick={print}><Printer size={14} className="mr-1" /> Print Plan</Button>
          </div>
        </div>
      </Card>

      <DocumentsModal open={showDocs} onClose={() => setShowDocs(false)} url={`/${proc}/daily-plan`} title={`${label} Daily Plans`}
        noKey="plan_no" dateKey="plan_date" onPick={(r) => openDoc(r.id)}
        columns={[{ key: 'total_bundles', header: 'Bundles' }, { key: 'allocated_qty', header: 'Planned' }, { key: 'achieved_qty', header: 'Achieved' }]} />

      <PendingPicker picker={picker} onClose={() => setPicker(null)} rows={freePending}
        lineCode={lines.find((l) => l.id === picker?.lineId)?.line_code ?? ''}
        onPick={(items) => { addRows(items); setPicker(null); }} />

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={`Cancel plan ${docNo ?? ''}`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setCancelOpen(false)}>Back</Button><Button variant="danger" onClick={cancelDoc} disabled={cancelReason.trim().length < 3}>Cancel plan</Button></>}>
        <p className="mb-2 text-sm text-slate-600">The planned bundles become available to plan again.</p>
        <Input label="Reason *" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
      </Modal>
    </div>
  );
}

/** Add Job (whole jobs) or Add Bundle (single bundles) of one line from pending stock. */
function PendingPicker({ picker, onClose, rows, lineCode, onPick }: {
  picker: { lineId: number; mode: 'job' | 'bundle' } | null; onClose: () => void;
  rows: (Pending & { free_qty: number })[]; lineCode: string; onPick: (rows: (Pending & { free_qty: number })[]) => void;
}) {
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  useEffect(() => { setSel(new Set()); setSearch(''); }, [picker]);
  if (!picker) return null;
  const mine = rows.filter((r) => r.line_id === picker.lineId
    && (!search || [r.bundle_no, r.io_no, r.style_no, r.colour, r.size].some((x) => String(x ?? '').toLowerCase().includes(search.toLowerCase()))));
  const groups = groupByJob(mine);
  const toggle = (ids: number[], on: boolean) => setSel((x) => { const y = new Set(x); ids.forEach((i) => (on ? y.add(i) : y.delete(i))); return y; });
  return (
    <Modal open onClose={onClose} title={`${picker.mode === 'job' ? 'Add Job' : 'Add Bundle'} — ${lineCode}`} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={!sel.size} onClick={() => onPick(mine.filter((r) => sel.has(r.allocation_detail_id)))}>Add {sel.size} bundle(s)</Button></>}>
      <SearchInput value={search} onChange={setSearch} placeholder="Search bundle, job, style…" className="mb-2 w-full" />
      {!mine.length && <p className="py-8 text-center text-sm text-slate-400">Nothing allocated to {lineCode} is left to plan.</p>}
      <table className="w-full text-xs">
        <tbody>
          {groups.map((g) => {
            const ids = g.rows.map((r) => r.allocation_detail_id);
            const all = ids.every((i) => sel.has(i));
            return [
              <JobHeaderRow key={g.key} group={g} colSpan={5} qty={g.rows.reduce((a, r) => a + r.free_qty, 0)} checked={all} onCheck={() => toggle(ids, !all)} />,
              ...(picker.mode === 'bundle' ? g.rows.map((r) => (
                <tr key={r.allocation_detail_id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => toggle([r.allocation_detail_id], !sel.has(r.allocation_detail_id))}>
                  <td className="w-8 px-2 py-1 text-center"><input type="checkbox" checked={sel.has(r.allocation_detail_id)} readOnly /></td>
                  <td className="px-2 py-1 font-mono font-semibold">{r.bundle_no}</td>
                  <td className="px-2 py-1">{r.colour}</td>
                  <td className="px-2 py-1 font-semibold">{r.size}</td>
                  <td className="px-2 py-1 text-right">{fmtNumber(r.free_qty)} PCS</td>
                </tr>
              )) : []),
            ];
          })}
        </tbody>
      </table>
    </Modal>
  );
}

export function SewingDailyPlanPage() {
  return <DailyPlanPage proc="sewing" />;
}

export function CheckingDailyPlanPage() {
  return <DailyPlanPage proc="checking" />;
}

export function IroningDailyPlanPage() {
  return <DailyPlanPage proc="ironing" />;
}

export function PackingDailyPlanPage() {
  return <DailyPlanPage proc="packing" />;
}

export default CheckingDailyPlanPage;
