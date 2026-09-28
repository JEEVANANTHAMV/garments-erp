import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Trash2, FileSpreadsheet, FolderOpen, FilePlus2, Search, Printer, Save, CheckCircle2, X, ScanLine,
  Target, TrendingUp, ClipboardCheck, AlertTriangle, RotateCcw, Layers,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { Card, Badge, Button, Input, Select, Tabs, Modal, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useAuth } from '../../lib/auth';
import {
  type BundleInfo, n, pct, groupByJob, JobHeaderRow, SummaryCard, distinct, EMPTY_FILTERS, applyFilters,
  summarize, SummaryTable, DocumentsModal, DocStatus, printDocument, printRowsByJob, type RowFilters,
} from './linePlanUi';

/**
 * Daily Output Entry – Sewing (client image 1) and Checking Entry (QC) —
 * developer doc §14, same layout.
 *
 * Checking: Good → checked stock for ironing, Reject → reject stock, Rework →
 * back to the sewing line (open sewing input) for correction and re-checking.
 *
 * Load a confirmed sewing daily plan for a line, enter per bundle the input,
 * rework and reject PCS (good = input − rework − reject, so Input = Good +
 * Rework + Reject always holds), then Confirm Output. Confirming posts to the
 * bundle ledger exactly like the sewing floor screen (sewing input if the PCS
 * are not on the line yet, then sewing output), and updates plan achieved /
 * allocation completed.
 */

type Row = BundleInfo & {
  plan_detail_id: number | null; ready_qty?: number;
  planned_qty?: number; achieved_qty?: number; allocation_qty?: number; previous_output?: number;
  input_qty: number; rework_qty: number; reject_qty: number;
  defect_id: string; operator_name: string; start_time: string; end_time: string; remarks: string;
};
type PlanRow = BundleInfo & { id: number; line_id: number; planned_qty: number; achieved_qty: number; allocation_qty: number; previous_output: number; remaining_qty: number; status: string };

const good = (r: Row) => r.input_qty - r.rework_qty - r.reject_qty;
const TABS = [
  { key: 'bundle', label: 'Bundle Entry' },
  { key: 'size', label: 'Size Wise Summary' },
  { key: 'defect', label: 'Defect Details' },
  { key: 'rework', label: 'Rework Details' },
  { key: 'remarks', label: 'Remarks' },
];

type OutProc = 'sewing' | 'checking';
const TITLE: Record<OutProc, string> = { sewing: 'Daily Output Entry – Sewing', checking: 'Checking Entry (QC)' };

function DailyOutputPage({ proc }: { proc: OutProc }) {
  const label = proc === 'sewing' ? 'Sewing' : 'Checking';
  const toast = useToast();
  const { can } = useAuth();
  const shifts = useLookup('shifts');
  const lines = useLookup(`${proc}-lines`);
  const defects = useLookup('defects');
  const fileRef = useRef<HTMLInputElement>(null);

  const [docId, setDocId] = useState<number | null>(null);
  const [docNo, setDocNo] = useState<string | null>(null);
  const [docStatus, setDocStatus] = useState<string | null>(null);
  const editable = !docStatus || docStatus === 'DRAFT';

  const [outDate, setOutDate] = useState(today());
  const [shiftId, setShiftId] = useState('');
  const [floorName, setFloorName] = useState(`${label} Floor-1`);
  const [lineId, setLineId] = useState('');
  const [planNo, setPlanNo] = useState('');
  const [plan, setPlan] = useState<any>(null);
  const [planRows, setPlanRows] = useState<PlanRow[]>([]);
  const [supervisor, setSupervisor] = useState('');
  const [remarks, setRemarks] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [filters, setFilters] = useState<RowFilters>(EMPTY_FILTERS);
  const [operatorFilter, setOperatorFilter] = useState('');
  const [tab, setTab] = useState('bundle');
  const [scan, setScan] = useState('');
  const [picker, setPicker] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const line = lines.data?.find((l: any) => String(l.id) === lineId);
  useEffect(() => { if (line && !supervisor) setSupervisor(String((line as any).supervisor_name ?? '')); }, [line, supervisor]);

  const fromPlanRow = (p: PlanRow): Row => ({
    ...p, plan_detail_id: p.id, input_qty: p.remaining_qty, rework_qty: 0, reject_qty: 0,
    defect_id: '', operator_name: '', start_time: '', end_time: '', remarks: '',
  });

  const loadPlan = async (keepRows = false) => {
    if (!planNo.trim()) { toast('Enter the daily plan no', 'warning'); return; }
    if (!lineId) { toast('Choose the sewing line first', 'warning'); return; }
    try {
      const r = await api.get(`/${proc}/daily-output/load-plan`, { params: { plan_no: planNo.trim(), line_id: lineId } });
      const d = r.data.data;
      setPlan(d.plan);
      setPlanRows(d.details || []);
      if (d.plan.shift_id && !shiftId) setShiftId(String(d.plan.shift_id));
      const pl = (d.lines || []).find((x: any) => String(x.line_id) === lineId);
      if (pl?.supervisor_name) setSupervisor(String(pl.supervisor_name));
      if (!keepRows) {
        const open = (d.details || []).filter((p: PlanRow) => p.remaining_qty > 0);
        setRows(open.map(fromPlanRow));
        toast(open.length ? `Loaded ${open.length} bundle(s) from plan ${d.plan.plan_no}` : `Plan ${d.plan.plan_no} has nothing left on this line`, open.length ? 'success' : 'warning');
      }
    } catch (e: any) {
      toast(e?.message || 'Could not load plan', 'error');
    }
  };

  const resetNew = () => {
    setDocId(null); setDocNo(null); setDocStatus(null); setRows([]); setPlan(null); setPlanRows([]); setPlanNo(''); setRemarks('');
  };

  const openDoc = async (id: number) => {
    try {
      const r = await api.get(`/${proc}/daily-output/${id}`);
      const d = r.data.data;
      setDocId(d.id); setDocNo(d.output_no); setDocStatus(d.status);
      setOutDate(String(d.output_date).slice(0, 10)); setShiftId(d.shift_id ? String(d.shift_id) : '');
      setFloorName(d.floor_name || ''); setLineId(String(d.line_id)); setSupervisor(d.supervisor_name || '');
      setRemarks(d.remarks || ''); setPlanNo(d.plan_no || '');
      setRows((d.lines || []).map((l: any) => ({
        ...l, bundle_id: Number(l.bundle_id), plan_detail_id: l.plan_detail_id ? Number(l.plan_detail_id) : null,
        input_qty: n(l.input_qty), rework_qty: n(l.rework_qty), reject_qty: n(l.reject_qty),
        defect_id: l.defect_id ? String(l.defect_id) : '', operator_name: l.operator_name || '',
        start_time: l.start_time ? String(l.start_time).slice(0, 5) : '', end_time: l.end_time ? String(l.end_time).slice(0, 5) : '',
        remarks: l.remarks || '',
      })));
      if (d.plan_id) {
        const p = await api.get(`/${proc}/daily-output/load-plan`, { params: { plan_id: d.plan_id, line_id: d.line_id } }).catch(() => null);
        if (p) { setPlan(p.data.data.plan); setPlanRows(p.data.data.details || []); }
      } else { setPlan(null); setPlanRows([]); }
    } catch (e: any) {
      toast(e?.message || 'Could not open output entry', 'error');
    }
  };

  const addScanned = async (code: string) => {
    if (!code.trim()) return;
    const inPlan = planRows.find((p) => p.bundle_no === code || p.barcode === code);
    if (inPlan) {
      if (rows.some((r) => r.bundle_id === inPlan.bundle_id)) { toast(`${inPlan.bundle_no} is already in the entry`, 'warning'); return; }
      setRows((x) => [...x, fromPlanRow(inPlan)]);
      setScan('');
      return;
    }
    try {
      const r = await api.get(`/${proc}/daily-output/bundle`, { params: { code: code.trim() } });
      const b = r.data.data;
      if (rows.some((x) => x.bundle_id === b.bundle_id)) { toast(`${b.bundle_no} is already in the entry`, 'warning'); return; }
      setRows((x) => [...x, { ...b, plan_detail_id: null, input_qty: b.ready_qty, rework_qty: 0, reject_qty: 0, defect_id: '', operator_name: '', start_time: '', end_time: '', remarks: '' }]);
      toast(`${b.bundle_no} added (not on the plan)`, 'info');
      setScan('');
    } catch (e: any) {
      toast(e?.message || 'Bundle not found', 'error');
    }
  };

  const importExcel = async (file: File) => {
    try {
      const wb = XLSX.read(await file.arrayBuffer());
      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      const norm = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase().replace(/[^a-z]/g, ''), v]));
      let hit = 0; const miss: string[] = [];
      const next = [...rows];
      for (const raw of data) {
        const r = norm(raw);
        const code = String(r.bundleid ?? r.bundleno ?? r.bundle ?? r.barcode ?? '').trim();
        if (!code) continue;
        const k = next.findIndex((x) => x.bundle_no === code || x.barcode === code);
        const p = planRows.find((x) => x.bundle_no === code || x.barcode === code);
        const defect = String(r.defectreason ?? r.defect ?? '').trim().toLowerCase();
        const patch = {
          input_qty: n(r.inputqty ?? r.input), rework_qty: n(r.reworkqty ?? r.rework), reject_qty: n(r.rejectqty ?? r.reject),
          operator_name: String(r.operator ?? ''), start_time: String(r.starttime ?? '').slice(0, 5), end_time: String(r.endtime ?? '').slice(0, 5),
          defect_id: String(defects.data?.find((d: any) => String(d.label).toLowerCase() === defect)?.id ?? ''),
        };
        if (k >= 0) { next[k] = { ...next[k], ...patch }; hit++; }
        else if (p) { next.push({ ...fromPlanRow(p), ...patch }); hit++; }
        else miss.push(code);
      }
      setRows(next);
      toast(`Imported ${hit} bundle(s)${miss.length ? ` — not on the plan: ${miss.slice(0, 5).join(', ')}` : ''}`, miss.length ? 'warning' : 'success');
    } catch (e: any) {
      toast(e?.message || 'Could not read the Excel file', 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const patch = (id: number, p: Partial<Row>) => setRows((x) => x.map((r) => (r.bundle_id === id ? { ...r, ...p } : r)));
  const shown = useMemo(() => applyFilters(rows, filters).filter((r) => !operatorFilter || r.operator_name === operatorFilter), [rows, filters, operatorFilter]);

  const totals = useMemo(() => {
    const input = rows.reduce((a, r) => a + r.input_qty, 0);
    const g = rows.reduce((a, r) => a + good(r), 0);
    const rw = rows.reduce((a, r) => a + r.rework_qty, 0);
    const rj = rows.reduce((a, r) => a + r.reject_qty, 0);
    const lineRows = planRows;
    const plannedTotal = lineRows.reduce((a, p) => a + n(p.allocation_qty), 0);
    const previous = lineRows.reduce((a, p) => a + n(p.previous_output), 0);
    const target = lineRows.reduce((a, p) => a + n(p.remaining_qty), 0) || input;
    return { input, good: g, rework: rw, reject: rj, plannedTotal, previous, target, remaining: Math.max(target - g, 0) };
  }, [rows, planRows]);
  const invalid = rows.filter((r) => good(r) < 0 || r.input_qty <= 0 || (r.start_time && r.end_time && r.end_time < r.start_time));

  const defectName = (id: string) => defects.data?.find((d: any) => String(d.id) === id)?.label ?? '';
  const defectSummary = summarize(rows.filter((r) => r.rework_qty + r.reject_qty > 0), (r) => defectName(r.defect_id) || 'Not given', (r) => r.rework_qty + r.reject_qty);
  const bySize = useMemo(() => {
    const m = new Map<string, { size: string; sort: number; input: number; good: number; rework: number; reject: number }>();
    for (const r of rows) {
      const k = r.size ?? '—';
      if (!m.has(k)) m.set(k, { size: k, sort: n(r.size_sort), input: 0, good: 0, rework: 0, reject: 0 });
      const s = m.get(k)!;
      s.input += r.input_qty; s.good += good(r); s.rework += r.rework_qty; s.reject += r.reject_qty;
    }
    return [...m.values()].sort((a, b) => a.sort - b.sort || a.size.localeCompare(b.size));
  }, [rows]);

  const save = async (confirm: boolean) => {
    if (!lineId) { toast('Choose the sewing line', 'warning'); return; }
    if (!rows.length) { toast('Add at least one bundle', 'warning'); return; }
    if (invalid.length) { toast(`Fix ${invalid.length} row(s): good cannot be negative, input must be > 0 and end time after start time`, 'warning'); return; }
    const body = {
      output_date: outDate, shift_id: shiftId ? Number(shiftId) : null, floor_name: floorName || null,
      line_id: Number(lineId), plan_id: plan?.id ?? null, supervisor_name: supervisor || null, remarks: remarks || null, confirm,
      lines: rows.map((r) => ({
        bundle_id: r.bundle_id, plan_detail_id: r.plan_detail_id, input_qty: r.input_qty, good_qty: good(r),
        rework_qty: r.rework_qty, reject_qty: r.reject_qty, defect_id: r.defect_id ? Number(r.defect_id) : null,
        operator_name: r.operator_name || null, start_time: r.start_time || null, end_time: r.end_time || null, remarks: r.remarks || null,
      })),
    };
    setSaving(true);
    try {
      const r = docId ? await api.put(`/${proc}/daily-output/${docId}`, body) : await api.post(`/${proc}/daily-output`, body);
      const d = r.data.data;
      toast(confirm ? `${d.output_no} confirmed — posted to bundle stock${d.rework_sent_to_sewing?.length ? ` (rework sent back to sewing: ${d.rework_sent_to_sewing.map((x: any) => `${x.qty} PCS → ${x.line_name}`).join(', ')})` : ''}` : `Draft ${d.output_no} saved`);
      await openDoc(d.id);
    } catch (e: any) {
      toast(e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const cancelDoc = async () => {
    try {
      await api.post(`/${proc}/daily-output/${docId}/cancel`, { reason: cancelReason });
      toast(`Draft ${docNo} cancelled`);
      setCancelOpen(false); setCancelReason(''); resetNew();
    } catch (e: any) {
      toast(e?.message || 'Cancel failed', 'error');
    }
  };

  const print = () => {
    if (!rows.length) { toast('Nothing to print', 'warning'); return; }
    const pr = printRowsByJob(rows, (r) => [r.bundle_no, r.lay_no ?? '', r.cut_no ?? '', r.colour, r.size, r.input_qty, good(r), r.rework_qty, r.reject_qty,
      defectName(r.defect_id), r.operator_name, r.start_time, r.end_time]);
    printDocument(`${TITLE[proc]} ${docNo ?? '(unsaved)'}`, [
      ['Date', fmtDate(outDate)], ['Shift', shifts.data?.find((s: any) => String(s.id) === shiftId)?.label ?? '—'],
      ['Line', line ? `${line.code} ${line.label}` : '—'], ['Plan', plan?.plan_no ?? '—'], ['Supervisor', supervisor || '—'],
      ['Good', `${totals.good} (${pct(totals.good, totals.input)}%)`], ['Rework', totals.rework], ['Reject', totals.reject],
    ], [{ heading: 'Bundle entry', columns: ['Bundle', 'Lay', 'Cut', 'Colour', 'Size', 'Input', 'Good', 'Rework', 'Reject', 'Defect', 'Operator', 'Start', 'End'], ...pr }]);
  };

  const goodPct = pct(totals.good, totals.input);
  const achievement = pct(totals.good, totals.target);
  const addable = planRows.filter((p) => p.remaining_qty > 0 && !rows.some((r) => r.bundle_id === p.bundle_id));
  const styleInfo = planRows[0] ?? rows[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{TITLE[proc]}</h1>
          <p className="text-sm text-slate-500">{proc === 'sewing' ? 'Bundle-wise good / rework / reject against the day\'s plan' : 'Input = Good + Rework + Reject · good goes to ironing, rework back to sewing, reject to reject stock'}</p>
        </div>
        <div className="flex items-center gap-2">
          <DocStatus no={docNo} status={docStatus} />
          <Button size="sm" variant="secondary" onClick={() => setShowDocs(true)}><FolderOpen size={13} className="mr-1" /> Open</Button>
          <Button size="sm" variant="secondary" onClick={resetNew}><FilePlus2 size={13} className="mr-1" /> New</Button>
        </div>
      </div>

      <Card className="!p-3">
        <div className="flex flex-wrap items-end gap-3">
          <Input label="Date *" type="date" className="w-40" value={outDate} disabled={!editable} onChange={(e) => setOutDate(e.target.value)} />
          <Select label="Shift *" className="w-44" value={shiftId} disabled={!editable} onChange={(e) => setShiftId(e.target.value)} placeholder="Select shift" options={toOptions(shifts.data)} />
          <Input label={`${label} Floor`} className="w-40" value={floorName} disabled={!editable} onChange={(e) => setFloorName(e.target.value)} />
          <Select label="Line *" className="w-52" value={lineId} disabled={!editable} onChange={(e) => { setLineId(e.target.value); setSupervisor(''); }} placeholder="Select line"
            options={(lines.data || []).map((l: any) => ({ value: l.id, label: `${l.code} (${l.label})` }))} />
          <Input label="Output No" className="w-36" value={docNo ?? 'AUTO'} disabled />
          <div className="flex items-end gap-1">
            <Input label="Daily Plan No" className="w-40" value={planNo} disabled={!editable} onChange={(e) => setPlanNo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') loadPlan(); }} placeholder={proc === 'sewing' ? 'SDP-00001' : 'CDP-00001'} />
            <Button className="!h-10" onClick={() => loadPlan()} disabled={!editable}><Search size={14} className="mr-1" /> Load Plan</Button>
          </div>
          <Input label="Supervisor" className="w-40" value={supervisor} disabled={!editable} onChange={(e) => setSupervisor(e.target.value)} />
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
          {([
            ['job', 'Job No', distinct(rows, (b) => b.io_no)], ['po', 'PO No', distinct(rows, (b) => b.po_no)],
            ['style', 'Style No', distinct(rows, (b) => b.style_no)], ['buyer', 'Buyer', distinct(rows, (b) => b.buyer)],
            ['colour', 'Colour', distinct(rows, (b) => b.colour)], ['size', 'Size', distinct(rows, (b) => b.size)],
          ] as const).map(([k, lbl, opts]) => (
            <Select key={k} label={lbl} className="w-32" value={filters[k]} placeholder="All" options={opts as any}
              onChange={(e) => setFilters((f) => ({ ...f, [k]: e.target.value }))} />
          ))}
          <Select label="Operator" className="w-32" value={operatorFilter} placeholder="All" options={distinct(rows, (r) => r.operator_name)} onChange={(e) => setOperatorFilter(e.target.value)} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_2fr_1fr]">
        <Card title="Plan Information">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-3 text-xs">
            <dt className="text-slate-500">Plan</dt><dd className="font-medium">{plan ? `${plan.plan_no} · ${fmtDate(plan.plan_date)}` : '—'}</dd>
            <dt className="text-slate-500">Job / Style</dt><dd className="font-medium">{styleInfo ? `${styleInfo.io_no ?? '—'} · ${styleInfo.style_no ?? '—'}` : '—'}</dd>
            <dt className="text-slate-500">Style Description</dt><dd>{styleInfo?.style_description || '—'}</dd>
            <dt className="text-slate-500">Buyer / PO</dt><dd>{styleInfo ? `${styleInfo.buyer || '—'} / ${styleInfo.po_no || '—'}` : '—'}</dd>
            <dt className="text-slate-500">Allocated Qty</dt><dd>{fmtNumber(totals.plannedTotal)} PCS</dd>
            <dt className="text-slate-500">UOM</dt><dd>PCS</dd>
          </dl>
        </Card>
        <Card title={`Daily Plan Summary${line ? ` (${line.code})` : ''}`}>
          <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-5">
            <SummaryCard icon={<Layers size={18} />} label="Planned Qty" value={fmtNumber(totals.plannedTotal)} sub="PCS allocated" tone="bg-blue-50 border-blue-200 text-blue-800" />
            <SummaryCard icon={<CheckCircle2 size={18} />} label="Previous Output" value={fmtNumber(totals.previous)} sub="PCS" tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
            <SummaryCard icon={<Target size={18} />} label="Today's Target" value={fmtNumber(totals.target)} sub="PCS" tone="bg-amber-50 border-amber-200 text-amber-800" />
            <SummaryCard icon={<TrendingUp size={18} />} label="Today's Output" value={fmtNumber(totals.good)} sub="PCS good" tone="bg-violet-50 border-violet-200 text-violet-800" />
            <SummaryCard icon={<AlertTriangle size={18} />} label="Remaining" value={fmtNumber(totals.remaining)} sub="PCS" tone="bg-red-50 border-red-200 text-red-800" />
          </div>
        </Card>
        <Card title="Line Productivity (Today)">
          <div className="flex items-center gap-4 p-3">
            <Donut value={goodPct} />
            <table className="flex-1 text-xs">
              <tbody>
                {[['Good', totals.good, 'text-emerald-700'], ['Rework', totals.rework, 'text-amber-700'], ['Reject', totals.reject, 'text-red-700']].map(([k, v, c]) => (
                  <tr key={k as string}><td className="py-0.5">{k}</td><td className={`py-0.5 text-right font-semibold ${c}`}>{fmtNumber(v)}</td><td className="py-0.5 text-right text-slate-500">{pct(v as number, totals.input)}%</td></tr>
                ))}
                <tr className="border-t font-semibold"><td className="py-0.5">Total</td><td className="py-0.5 text-right">{fmtNumber(totals.input)}</td><td className="py-0.5 text-right">100%</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
          <Tabs tabs={TABS.map((t) => (t.key === 'bundle' ? { ...t, count: rows.length } : t))} active={tab} onChange={setTab} />
          {editable && tab === 'bundle' && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setPicker(true)} disabled={!addable.length}><Plus size={13} className="mr-1" /> Add Bundle</Button>
              <div className="flex items-center gap-1">
                <input className="input h-8 w-40 text-xs" placeholder="Scan bundle barcode" value={scan}
                  onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addScanned(scan); }} />
                <Button size="sm" variant="secondary" onClick={() => addScanned(scan)}><ScanLine size={13} className="mr-1" /> Scan Bundle</Button>
              </div>
              <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}><FileSpreadsheet size={13} className="mr-1" /> Import Excel</Button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && importExcel(e.target.files[0])} />
              <Button size="sm" variant="danger" onClick={() => setRows([])} disabled={!rows.length}><Trash2 size={13} className="mr-1" /> Clear All</Button>
            </div>
          )}
        </div>

        {tab === 'bundle' && (
          <div className="max-h-[55vh] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-2 py-2 text-left">Bundle ID</th>
                  <th className="px-2 py-2 text-left">Lay No</th>
                  <th className="px-2 py-2 text-left">Cut No</th>
                  <th className="px-2 py-2 text-left">Colour</th>
                  <th className="px-2 py-2 text-left">Size</th>
                  <th className="px-2 py-2 text-right">Input</th>
                  <th className="px-2 py-2 text-right">Good</th>
                  <th className="px-2 py-2 text-right">Rework</th>
                  <th className="px-2 py-2 text-right">Reject</th>
                  <th className="px-2 py-2 text-left">Defect Reason</th>
                  <th className="px-2 py-2 text-left">Operator</th>
                  <th className="px-2 py-2 text-left">Start</th>
                  <th className="px-2 py-2 text-left">End</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {groupByJob(shown).map((g) => [
                  <JobHeaderRow key={g.key} group={g} colSpan={14} qty={g.rows.reduce((a, r) => a + r.input_qty, 0)} />,
                  ...g.rows.map((r) => {
                    const bad = good(r) < 0;
                    return (
                      <tr key={r.bundle_id} className={`border-t border-slate-100 ${bad ? 'bg-red-50' : ''}`}>
                        <td className="px-2 py-1 font-mono font-semibold">
                          {r.bundle_no}{!r.plan_detail_id && <Badge tone="amber" className="ml-1">not planned</Badge>}
                        </td>
                        <td className="px-2 py-1 text-slate-500">{r.lay_no || '—'}</td>
                        <td className="px-2 py-1 text-slate-500">{r.cut_no || '—'}</td>
                        <td className="px-2 py-1">{r.colour || '—'}</td>
                        <td className="px-2 py-1 font-semibold">{r.size || '—'}</td>
                        <td className="px-2 py-1 text-right"><NumCell v={r.input_qty} disabled={!editable} onChange={(v) => patch(r.bundle_id, { input_qty: v })} /></td>
                        <td className={`px-2 py-1 text-right font-semibold ${bad ? 'text-red-600' : 'text-emerald-700'}`}>{fmtNumber(good(r))}</td>
                        <td className="px-2 py-1 text-right"><NumCell v={r.rework_qty} disabled={!editable} onChange={(v) => patch(r.bundle_id, { rework_qty: v })} /></td>
                        <td className="px-2 py-1 text-right"><NumCell v={r.reject_qty} disabled={!editable} onChange={(v) => patch(r.bundle_id, { reject_qty: v })} /></td>
                        <td className="px-2 py-1">
                          <select className="input h-6 w-32 text-[11px]" disabled={!editable} value={r.defect_id} onChange={(e) => patch(r.bundle_id, { defect_id: e.target.value })}>
                            <option value="">—</option>
                            {(defects.data || []).map((d: any) => <option key={d.id} value={d.id}>{d.label}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <input className="input h-6 w-24 text-[11px]" disabled={!editable} value={r.operator_name} onChange={(e) => patch(r.bundle_id, { operator_name: e.target.value })} />
                        </td>
                        <td className="px-2 py-1"><input type="time" className="input h-6 w-24 text-[11px]" disabled={!editable} value={r.start_time} onChange={(e) => patch(r.bundle_id, { start_time: e.target.value })} /></td>
                        <td className="px-2 py-1"><input type="time" className="input h-6 w-24 text-[11px]" disabled={!editable} value={r.end_time} onChange={(e) => patch(r.bundle_id, { end_time: e.target.value })} /></td>
                        <td className="px-2 py-1 text-center">
                          {editable && <button className="text-red-500 hover:text-red-700" onClick={() => setRows((x) => x.filter((y) => y.bundle_id !== r.bundle_id))}><Trash2 size={14} /></button>}
                        </td>
                      </tr>
                    );
                  }),
                ])}
                {!shown.length && <tr><td colSpan={14} className="px-4 py-10 text-center text-slate-400">Choose the line, enter the daily plan no and click Load Plan — or scan bundles</td></tr>}
              </tbody>
              {rows.length > 0 && (
                <tfoot className="sticky bottom-0 border-t border-slate-200 bg-slate-50 font-semibold">
                  <tr>
                    <td className="px-2 py-1.5" colSpan={5}>Total</td>
                    <td className="px-2 py-1.5 text-right">{fmtNumber(totals.input)}</td>
                    <td className="px-2 py-1.5 text-right text-emerald-700">{fmtNumber(totals.good)}</td>
                    <td className="px-2 py-1.5 text-right text-amber-700">{fmtNumber(totals.rework)}</td>
                    <td className="px-2 py-1.5 text-right text-red-700">{fmtNumber(totals.reject)}</td>
                    <td colSpan={5} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        {tab === 'size' && <SizeTable rows={bySize} />}
        {tab === 'defect' && <SummaryTable keyLabel="Defect Reason" data={defectSummary} />}
        {tab === 'rework' && (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2 text-left">Bundle</th><th className="px-3 py-2 text-left">Job</th><th className="px-3 py-2 text-left">Size</th><th className="px-3 py-2 text-right">Rework</th><th className="px-3 py-2 text-right">Reject</th><th className="px-3 py-2 text-left">Defect</th><th className="px-3 py-2 text-left">Operator</th></tr></thead>
            <tbody>
              {rows.filter((r) => r.rework_qty + r.reject_qty > 0).map((r) => (
                <tr key={r.bundle_id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 font-mono">{r.bundle_no}</td><td className="px-3 py-1.5">{r.io_no}</td><td className="px-3 py-1.5">{r.size}</td>
                  <td className="px-3 py-1.5 text-right text-amber-700">{r.rework_qty}</td><td className="px-3 py-1.5 text-right text-red-700">{r.reject_qty}</td>
                  <td className="px-3 py-1.5">{defectName(r.defect_id) || '—'}</td><td className="px-3 py-1.5">{r.operator_name || '—'}</td>
                </tr>
              ))}
              {!rows.some((r) => r.rework_qty + r.reject_qty > 0) && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No rework or reject entered</td></tr>}
            </tbody>
          </table>
        )}
        {tab === 'remarks' && <div className="p-3"><Textarea label="Remarks" rows={4} value={remarks} disabled={!editable} onChange={(e) => setRemarks(e.target.value)} /></div>}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Size Wise Output (Today)"><SizeTable rows={bySize} /></Card>
        <Card title="Defect Summary (Today)"><SummaryTable keyLabel="Defect Reason" data={defectSummary} /></Card>
        <Card title="Output Summary (Today)">
          <div className="grid grid-cols-3 gap-2 p-3">
            <SummaryCard icon={<ClipboardCheck size={18} />} label="Good Qty" value={fmtNumber(totals.good)} sub={`${goodPct}%`} tone="bg-emerald-50 border-emerald-200 text-emerald-800" />
            <SummaryCard icon={<RotateCcw size={18} />} label="Rework Qty" value={fmtNumber(totals.rework)} sub={`${pct(totals.rework, totals.input)}%`} tone="bg-amber-50 border-amber-200 text-amber-800" />
            <SummaryCard icon={<AlertTriangle size={18} />} label="Reject Qty" value={fmtNumber(totals.reject)} sub={`${pct(totals.reject, totals.input)}%`} tone="bg-red-50 border-red-200 text-red-800" />
          </div>
          <div className="px-3 pb-3">
            <div className="mb-1 flex justify-between text-xs"><b>Achievement vs Target</b><span>{fmtNumber(totals.good)} / {fmtNumber(totals.target)} PCS · <b>{achievement}%</b></span></div>
            <div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, achievement)}%` }} /></div>
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {docId && docStatus === 'DRAFT' && <Button variant="secondary" onClick={() => setCancelOpen(true)}><X size={14} className="mr-1" /> Cancel Draft</Button>}
        {!docId && <Button variant="secondary" onClick={resetNew}><X size={14} className="mr-1" /> Cancel</Button>}
        {editable && (
          <>
            <Button variant="secondary" loading={saving} onClick={() => save(false)}><Save size={14} className="mr-1" /> Save Draft</Button>
            <Button className="!border-emerald-500 !bg-emerald-600" loading={saving} onClick={() => save(true)} disabled={!can('PRODUCTION.UPDATE')}>
              <CheckCircle2 size={14} className="mr-1" /> Confirm Output
            </Button>
          </>
        )}
        <Button variant="secondary" onClick={print}><Printer size={14} className="mr-1" /> Print</Button>
      </div>

      <DocumentsModal open={showDocs} onClose={() => setShowDocs(false)} url={`/${proc}/daily-output`} title={`${TITLE[proc]} — documents`}
        noKey="output_no" dateKey="output_date" onPick={(r) => openDoc(r.id)}
        columns={[{ key: 'line_code', header: 'Line', render: (r) => r.line_code }, { key: 'plan_no', header: 'Plan', render: (r) => r.plan_no || '—' },
          { key: 'good_qty', header: 'Good' }, { key: 'reject_qty', header: 'Reject' }]} />

      <Modal open={picker} onClose={() => setPicker(false)} title="Add bundles from the plan" size="lg"
        footer={<Button variant="secondary" onClick={() => setPicker(false)}>Close</Button>}>
        <table className="w-full text-xs">
          <tbody>
            {groupByJob(addable).map((g) => [
              <JobHeaderRow key={g.key} group={g} colSpan={5} qty={g.rows.reduce((a, r) => a + r.remaining_qty, 0)}
                extra={<Button size="sm" onClick={() => { setRows((x) => [...x, ...g.rows.map(fromPlanRow)]); }}>Add job</Button>} />,
              ...g.rows.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-2 py-1 font-mono font-semibold">{p.bundle_no}</td>
                  <td className="px-2 py-1">{p.colour}</td><td className="px-2 py-1 font-semibold">{p.size}</td>
                  <td className="px-2 py-1 text-right">{fmtNumber(p.remaining_qty)} PCS left</td>
                  <td className="px-2 py-1 text-right"><Button size="sm" variant="secondary" onClick={() => setRows((x) => [...x, fromPlanRow(p)])}>Add</Button></td>
                </tr>
              )),
            ])}
            {!addable.length && <tr><td className="px-3 py-8 text-center text-slate-400">All planned bundles are already in the entry</td></tr>}
          </tbody>
        </table>
      </Modal>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={`Cancel draft ${docNo ?? ''}`} size="sm"
        footer={<><Button variant="secondary" onClick={() => setCancelOpen(false)}>Back</Button><Button variant="danger" onClick={cancelDoc} disabled={cancelReason.trim().length < 3}>Cancel draft</Button></>}>
        <Input label="Reason *" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
      </Modal>
    </div>
  );
}

function NumCell({ v, onChange, disabled }: { v: number; onChange: (v: number) => void; disabled?: boolean }) {
  if (disabled) return <span>{fmtNumber(v)}</span>;
  return <input type="number" min={0} className="input h-6 w-16 text-right text-[11px]" value={v}
    onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value)) || 0))} />;
}

function SizeTable({ rows }: { rows: { size: string; input: number; good: number; rework: number; reject: number }[] }) {
  const t = rows.reduce((a, r) => ({ input: a.input + r.input, good: a.good + r.good, rework: a.rework + r.rework, reject: a.reject + r.reject }), { input: 0, good: 0, rework: 0, reject: 0 });
  return (
    <table className="w-full text-xs">
      <thead className="bg-slate-50 text-slate-500">
        <tr><th className="px-3 py-2 text-left">Size</th><th className="px-3 py-2 text-right">Input</th><th className="px-3 py-2 text-right">Good</th><th className="px-3 py-2 text-right">Rework</th><th className="px-3 py-2 text-right">Reject</th><th className="px-3 py-2 text-right">Achievement</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.size} className="border-t border-slate-100">
            <td className="px-3 py-1.5 font-semibold">{r.size}</td><td className="px-3 py-1.5 text-right">{fmtNumber(r.input)}</td>
            <td className="px-3 py-1.5 text-right text-emerald-700">{fmtNumber(r.good)}</td><td className="px-3 py-1.5 text-right text-amber-700">{fmtNumber(r.rework)}</td>
            <td className="px-3 py-1.5 text-right text-red-700">{fmtNumber(r.reject)}</td><td className="px-3 py-1.5 text-right">{pct(r.good, r.input)}%</td>
          </tr>
        ))}
        {!rows.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No data</td></tr>}
      </tbody>
      {rows.length > 0 && (
        <tfoot className="border-t bg-slate-50 font-semibold">
          <tr><td className="px-3 py-1.5">Total</td><td className="px-3 py-1.5 text-right">{fmtNumber(t.input)}</td><td className="px-3 py-1.5 text-right">{fmtNumber(t.good)}</td>
            <td className="px-3 py-1.5 text-right">{fmtNumber(t.rework)}</td><td className="px-3 py-1.5 text-right">{fmtNumber(t.reject)}</td><td className="px-3 py-1.5 text-right text-brand-700">{pct(t.good, t.input)}%</td></tr>
        </tfoot>
      )}
    </table>
  );
}

function Donut({ value }: { value: number }) {
  const r = 34; const c = 2 * Math.PI * r;
  return (
    <svg width="92" height="92" viewBox="0 0 92 92" role="img" aria-label={`Good ${value}%`}>
      <circle cx="46" cy="46" r={r} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      <circle cx="46" cy="46" r={r} fill="none" stroke="#10b981" strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${(Math.min(value, 100) / 100) * c} ${c}`} transform="rotate(-90 46 46)" />
      <text x="46" y="51" textAnchor="middle" className="fill-slate-800" style={{ font: '700 15px sans-serif' }}>{value}%</text>
    </svg>
  );
}

export function SewingDailyOutputPage() {
  return <DailyOutputPage proc="sewing" />;
}

export function CheckingQcEntryPage() {
  return <DailyOutputPage proc="checking" />;
}

export default SewingDailyOutputPage;
