import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Badge, Button, Input, Select, DataTable, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { JobSelect, onlyStyle, type Job } from '../../components/JobSelect';

/* ============================================================
   CUTTING PLANS LIST
============================================================ */
export function CuttingPlansPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    api.get('/cutting-plans').then(r => setPlans(r.data.data)).finally(() => setLoading(false));
  }, []);

  const statusColor = (s: string) => {
    const map: Record<string, string> = {
      DRAFT: 'slate', APPROVED: 'blue', RELEASED: 'indigo', IN_PROGRESS: 'amber', PARTIALLY_COMPLETED: 'amber',
      COMPLETED: 'emerald', CLOSED: 'gray', CANCELLED: 'red',
    };
    return map[s] || 'slate';
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Cutting Plans</h1>
          <p className="text-sm text-slate-500">I/O → Style → Size-wise cutting plans</p>
        </div>
        <Button onClick={() => nav('/production/cutting-plans/new')}>+ New Cutting Plan</Button>
      </div>

      <Card>
        <DataTable
          data={plans}
          loading={loading}
          columns={[
            { key: 'plan_no', header: 'Plan No', sortable: true,
              render: (r: any) => (
                <button onClick={() => nav(`/production/cutting-plans/${r.id}`)}
                  className="font-mono text-xs font-semibold text-brand-700 hover:underline">
                  {r.plan_no}
                </button>
              ) },
            { key: 'plan_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.plan_date) },
            { key: 'io_no', header: 'I/O No', render: (r: any) => (
              <Badge variant="outline" color="indigo">{r.io_no}</Badge>
            ) },
            { key: 'style_code', header: 'Style', render: (r: any) => (
              <div><p className="font-medium">{r.style_code}</p>
                <p className="text-[11px] text-slate-500">{r.style_name}</p></div>
            ) },
            { key: 'part_name', header: 'Part', render: (r: any) => {
              const part = (r.part_name || 'TOP').toUpperCase();
              const colors: Record<string, string> = { TOP: 'blue', BOTTOM: 'emerald', FOLDING: 'purple', COLLAR: 'amber', FULL_SET: 'indigo' };
              return <Badge color={colors[part] || 'slate'}>{part}</Badge>;
            } },
            { key: 'color_name', header: 'Colour' },
            { key: 'order_qty', header: 'Order Qty', align: 'right' as const, render: (r: any) => fmtNumber(r.order_qty) },
            { key: 'planned_cut_qty', header: 'Planned', align: 'right' as const,
              render: (r: any) => <span className="font-medium text-blue-700">{fmtNumber(r.planned_cut_qty)}</span> },
            { key: 'actual_cut_qty', header: 'Actual', align: 'right' as const,
              render: (r: any) => <span className="font-medium text-emerald-700">{fmtNumber(r.actual_cut_qty)}</span> },
            { key: 'status', header: 'Status', render: (r: any) => (
              <Badge color={statusColor(r.status)}>{r.status}</Badge>
            ) },
            { key: 'so_no', header: 'Sales Order' },
            { key: 'fabric_name', header: 'Fabric', render: (r: any) => <span className="text-xs">{r.fabric_name || '—'}</span> },
            { key: 'lays', header: '', render: (r: any) => ['CLOSED', 'CANCELLED'].includes(r.status) ? null : (
              <Button size="sm" variant="outline" onClick={() => nav(`/production/lay-spreading?plan=${r.id}`)}>Plan lays</Button>) },
          ]}
        />
      </Card>
    </div>
  );
}

/* ============================================================
   CUTTING PLAN DETAIL (CREATE / EDIT)
   Client voice note 04-Oct-2026: a big, detailed screen. Picking the job loads the style, buyer PO and the whole
   cutting program (CAD colour × size order / cut qty, markers, fabric); the user only fills the plan details below.
============================================================ */
const statusColorOf = (s: string) => ({
  DRAFT: 'slate', APPROVED: 'blue', RELEASED: 'indigo', IN_PROGRESS: 'amber', PARTIALLY_COMPLETED: 'amber',
  COMPLETED: 'emerald', CLOSED: 'gray', CANCELLED: 'red',
} as Record<string, string>)[s] || 'slate';

const n = (v: unknown) => Number(v) || 0;

export function CuttingPlanDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const isNew = !id || id === 'new';

  const [header, setHeader] = useState<any>({
    plan_no: '', plan_date: today(), io_no: '', so_id: null, so_line_id: null, prod_order_id: null,
    style_id: null, color_id: null, part_name: 'TOP', order_qty: 0, planned_cut_qty: 0,
    required_date: '', marker_ref: '', marker_eff_pct: '', fabric_id: null,
    fabric_req_kg: '', fabric_req_mtr: '', status: 'DRAFT', remarks: '',
    over_cut_pct: 0, over_cut_reason: '', cutting_location: '', status_reason: '', cad_req_id: null, buyer_po_no: '',
  });
  const [loaded, setLoaded] = useState<any>(null);
  const [sizes, setSizes] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [program, setProgram] = useState<any>(null);
  const [progLoading, setProgLoading] = useState(false);
  const [colourName, setColourName] = useState('');
  const [showLinks, setShowLinks] = useState(false);

  // Lookups
  const [soLines, setSoLines] = useState<any[]>([]);
  const [prodOrders, setProdOrders] = useState<any[]>([]);
  const [styles, setStyles] = useState<any[]>([]);
  const [colors, setColors] = useState<any[]>([]);
  const [fabrics, setFabrics] = useState<any[]>([]);
  const [availSizes, setAvailSizes] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      api.get('/lookups/sales-order-lines'),
      api.get('/lookups/production-orders'),
      api.get('/lookups/styles'),
      api.get('/lookups/colors'),
      api.get('/lookups/fabrics'),
      api.get('/lookups/sizes'),
    ]).then(([sol, po, st, col, fab, sz]) => {
      setSoLines(sol.data.data || []);
      setProdOrders(po.data.data || []);
      setStyles(st.data.data || []);
      setColors(col.data.data || []);
      setFabrics(fab.data.data || []);
      setAvailSizes(sz.data.data || []);
    });
  }, []);

  const toast = useToast();

  const loadProgram = async (soId: number | null, styleId?: number | null) => {
    if (!soId) { setProgram(null); return null; }
    setProgLoading(true);
    try {
      const r = await api.get('/cutting-plans/job-program', { params: { so_id: soId, style_id: styleId || undefined } });
      setProgram(r.data.data);
      return r.data.data;
    } catch (e: any) {
      toast(e?.message || 'Could not load the cutting program', 'error');
      setProgram(null);
      return null;
    } finally { setProgLoading(false); }
  };

  useEffect(() => {
    if (!isNew) {
      api.get(`/cutting-plans/${id}`).then(r => {
        const d = r.data.data;
        setHeader({
          plan_no: d.plan_no || '', plan_date: d.plan_date?.slice(0, 10) || today(),
          io_no: d.io_no || '', so_id: d.so_id, so_line_id: d.so_line_id, prod_order_id: d.prod_order_id,
          style_id: d.style_id, color_id: d.color_id,
          part_name: d.part_name || 'TOP',
          order_qty: d.order_qty || 0, planned_cut_qty: d.planned_cut_qty || 0,
          required_date: d.required_date?.slice(0, 10) || '',
          marker_ref: d.marker_ref || '', marker_eff_pct: d.marker_eff_pct || '',
          fabric_id: d.fabric_id, fabric_req_kg: d.fabric_req_kg || '',
          fabric_req_mtr: d.fabric_req_mtr || '', status: d.status || 'DRAFT',
          remarks: d.remarks || '',
          over_cut_pct: Number(d.over_cut_pct) || 0, over_cut_reason: d.over_cut_reason || '',
          cutting_location: d.cutting_location || '', status_reason: '', cad_req_id: d.cad_req_id ?? null, buyer_po_no: d.buyer_po_no || '',
        });
        setLoaded(d);
        setSizes(d.sizes || []);
        setColourName(d.color_name || '');
        if (d.so_id) void loadProgram(Number(d.so_id), Number(d.style_id));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew]);

  const setField = (k: string, v: any) => setHeader((p: any) => ({ ...p, [k]: v }));

  const addSizeLine = () => setSizes(prev => [...prev, { size_id: null, sku_id: null, order_qty: 0, planned_qty: 0 }]);
  const updateSize = (idx: number, k: string, v: any) => setSizes(prev => prev.map((s, i) => i === idx ? { ...s, [k]: v } : s));
  const removeSize = (idx: number) => setSizes(prev => prev.filter((_, i) => i !== idx));

  // Server-enforced transitions (doc §5): IN_PROGRESS / PARTIALLY_COMPLETED /
  // COMPLETED follow lay execution and CLOSED comes from Cutting Reconciliation.
  const MANUAL: Record<string, string[]> = {
    DRAFT: ['DRAFT', 'APPROVED', 'RELEASED', 'CANCELLED'],
    APPROVED: ['APPROVED', 'DRAFT', 'RELEASED', 'CANCELLED'],
    RELEASED: ['RELEASED', 'APPROVED', 'CANCELLED'],
  };
  const savedStatus = loaded?.status || 'DRAFT';
  const STATUSES = isNew ? ['DRAFT', 'APPROVED', 'RELEASED'] : (MANUAL[savedStatus] || [savedStatus]);
  const readOnly = !isNew && ['CLOSED', 'CANCELLED'].includes(savedStatus);
  const sizesLocked = !isNew && !['DRAFT', 'APPROVED'].includes(savedStatus);
  const jobLocked = !isNew && n(loaded?.actual_cut_qty) > 0;

  /** Picking the job loads the style (when the job has one), buyer PO and the cutting program. */
  const onJobPick = async (job: Job | null) => {
    setColourName('');
    if (!job) {
      setHeader((p: any) => ({ ...p, so_id: null, io_no: '', buyer_po_no: '', style_id: null, cad_req_id: null }));
      setProgram(null);
      return;
    }
    const styleId = onlyStyle(job);
    setHeader((p: any) => ({ ...p, so_id: job.id, io_no: job.job_no, buyer_po_no: job.buyer_po_no || '', style_id: styleId, so_line_id: null, color_id: null, cad_req_id: null }));
    if (isNew) setSizes([]);
    await loadProgram(job.id, styleId);
  };

  const onStylePick = async (styleId: number | null) => {
    setColourName('');
    setHeader((p: any) => ({ ...p, style_id: styleId, color_id: null, cad_req_id: null }));
    if (isNew) setSizes([]);
    if (header.so_id && styleId) await loadProgram(Number(header.so_id), styleId);
  };

  /** The fabric of the markers the colour is cut from: the first marker's fabric (body), mapped to the fabric master. */
  const mainFabric = (prog: any) => (prog?.fabrics || []).find((f: any) => f.fabric_id) ?? null;

  /** Choosing a colour fills the cut plan from the program: sizes (CAD cut qty, else SO qty + excess), fabric, CAD, KG. */
  const applyColour = (c: any) => {
    if (!program) return;
    setColourName(c.color_name);
    const fab = mainFabric(program);
    const fabMarkers: any[] = (program.markers || []).filter((m: any) => !fab || (fab.markers || []).includes(m.marker_ref));
    const kg = fabMarkers.reduce((a: number, m: any) => {
      const pl = (c.marker_plies || []).find((x: any) => x.marker_ref === m.marker_ref)?.plies;
      return a + (pl && m.kg_per_ply ? pl * m.kg_per_ply : 0);
    }, 0);
    const mtr = fabMarkers.reduce((a: number, m: any) => {
      const pl = (c.marker_plies || []).find((x: any) => x.marker_ref === m.marker_ref)?.plies;
      return a + (pl && m.length_m ? pl * m.length_m : 0);
    }, 0);
    const lines = (c.sizes || []).filter((x: any) => x.size_id).map((x: any) => ({
      size_id: x.size_id, size_code: x.size_code, sku_id: null,
      order_qty: n(x.order_qty),
      planned_qty: Math.max(0, n(x.suggested_qty) - n(x.planned_other)),
      actual_qty: 0,
    })).filter((x: any) => x.order_qty > 0 || x.planned_qty > 0);
    if (isNew && lines.length && lines.every((x: any) => x.planned_qty <= 0)) {
      toast(`Everything of ${c.color_name} is already on cut plan(s) ${(c.plans || []).map((p: any) => p.plan_no).join(', ') || ''} — nothing left to plan`, 'warning');
      return;
    }
    if (!sizesLocked) setSizes(lines);
    // The CAD cut qty carries the rejection % (rounded up per size): authorise exactly that over-cut, so the plan
    // saves without an override — the largest size-wise % decides (every size line is checked on its own).
    const ordT = lines.reduce((a: number, x: any) => a + x.order_qty, 0);
    const plT = lines.reduce((a: number, x: any) => a + x.planned_qty, 0);
    const pcts = [ordT > 0 ? (plT - ordT) / ordT * 100 : 0, ...lines.map((x: any) => (x.order_qty > 0 ? (x.planned_qty - x.order_qty) / x.order_qty * 100 : 0))];
    const needPct = Math.ceil(Math.max(0, ...pcts) * 100 - 1e-6) / 100;
    setHeader((p: any) => ({
      ...p,
      over_cut_pct: needPct > n(p.over_cut_pct) ? needPct : p.over_cut_pct,
      over_cut_reason: needPct > 0 && !p.over_cut_reason ? `CAD rejection allowance (${program.cad?.rejection_pct ?? needPct}% per size, rounded up)` : p.over_cut_reason,
      color_id: c.color_id ?? p.color_id,
      order_qty: lines.reduce((a: number, x: any) => a + x.order_qty, 0),
      planned_cut_qty: lines.reduce((a: number, x: any) => a + x.planned_qty, 0),
      fabric_id: fab?.fabric_id ?? p.fabric_id,
      cad_req_id: program.cad?.id ?? null,
      marker_ref: fabMarkers.map((m: any) => m.marker_ref).join(', ').slice(0, 60) || p.marker_ref,
      marker_eff_pct: program.cad?.marker_efficiency || p.marker_eff_pct,
      fabric_req_kg: kg > 0 ? Math.round(kg * 1000) / 1000 : p.fabric_req_kg,
      fabric_req_mtr: mtr > 0 ? Math.round(mtr * 100) / 100 : p.fabric_req_mtr,
    }));
    if (!c.color_id) toast(`Colour "${c.color_name}" is not in the colour master — pick the colour below`, 'warning');
  };

  const handleSave = async () => {
    if (!header.io_no || !header.style_id) { toast('Pick the job and style first', 'error'); return; }
    if (!sizes.length) { toast('The size breakdown is empty — pick a colour from the cutting program', 'error'); return; }
    if (sizes.some((x) => !x.size_id)) { toast('Every size line needs a size', 'error'); return; }
    setSaving(true);
    try {
      const payload = { ...header, cad_req_id: header.cad_req_id || null, buyer_po_no: header.buyer_po_no || null,
        sizes: sizes.map((x) => ({ size_id: x.size_id, sku_id: x.sku_id ?? null, order_qty: n(x.order_qty), planned_qty: n(x.planned_qty) })) };
      if (isNew) {
        const r = await api.post('/cutting-plans', payload);
        toast(`Cut plan ${r.data.data.plan_no} created — plan its lays next`);
        nav(`/production/cutting-plans/${r.data.data.id}`);
      } else {
        await api.put(`/cutting-plans/${id}`, payload);
        toast('Cutting plan updated');
        api.get(`/cutting-plans/${id}`).then(r => { setLoaded(r.data.data); setSizes(r.data.data.sizes || []); setField('status', r.data.data.status); });
      }
    } catch (e: any) {
      toast(e?.message || e?.response?.data?.error?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  // The Sales Order line owns the garment part (the server enforces this too).
  const handleSoLineSelect = (val: string) => {
    const lineId = val ? Number(val) : null;
    const line = soLines.find((l: any) => l.id === lineId);
    setHeader((prev: any) => ({
      ...prev, so_line_id: lineId, so_id: line?.so_id ?? prev.so_id, style_id: line?.style_id ?? prev.style_id,
      color_id: line?.color_id ?? prev.color_id, part_name: line?.part_name ?? prev.part_name,
    }));
  };
  const handlePoSelect = (poIdVal: string) => {
    const poId = poIdVal ? Number(poIdVal) : null;
    setHeader((prev: any) => ({ ...prev, prod_order_id: poId }));
  };

  const sizeOrder: string[] = (program?.sizes || []).map((x: any) => x.size_code);
  const totals = {
    order: sizes.reduce((s, l) => s + n(l.order_qty), 0),
    planned: sizes.reduce((s, l) => s + n(l.planned_qty), 0),
    cut: sizes.reduce((s, l) => s + n(l.actual_qty), 0),
  };
  const fab = mainFabric(program);
  const selectedColour = (program?.colours || []).find((c: any) => c.color_name === colourName);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {isNew ? 'New Cutting Plan' : `Cutting Plan — ${header.plan_no}`}
          </h1>
          <p className="text-sm text-slate-500">Pick the job — the style, buyer PO and the CAD cutting program load; choose the colour and fill the plan details.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/production/cutting-plans')}>← Back</Button>
          {!isNew && <Button variant="outline" id="cp-open-lays" onClick={() => nav(`/production/lay-spreading?plan=${id}`)}>Plan lays →</Button>}
          {!readOnly && <Button onClick={handleSave} loading={saving} id="cp-save">Save</Button>}
        </div>
      </div>

      {/* 1. Job → style → cutting program */}
      <Card title="Job & cutting program" subtitle="Everything up to the cutting program loads from the job">
        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-6">
          <JobSelect className="md:col-span-2" by="so_id" value={header.so_id} required disabled={jobLocked || readOnly} id="cp-job"
            onPick={(j) => void onJobPick(j)} />
          <Select label="Style *" value={header.style_id || ''} disabled={jobLocked || readOnly} id="cp-style"
            onChange={e => void onStylePick(e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select style —' }, ...((program?.styles?.length ? program.styles.map((s: any) => ({ value: s.style_id, label: `${s.style_code} · ${s.style_name}` }))
              : styles.map((s: any) => ({ value: s.id, label: s.label || s.code }))))]} />
          <div><p className="label">Buyer</p><p className="input bg-slate-50" id="cp-buyer">{program?.job?.buyer_name || '—'}</p></div>
          <div><p className="label">Buyer PO</p><p className="input bg-slate-50 font-mono" id="cp-buyer-po">{header.buyer_po_no || program?.job?.buyer_po_no || '—'}</p></div>
          <div><p className="label">I/O no</p><p className="input bg-slate-50 font-mono" id="cp-io">{header.io_no || '—'}</p></div>
        </div>
        {progLoading && <p className="px-4 pb-3 text-xs text-slate-500">Loading the cutting program…</p>}
        {program?.needs_style && <p className="px-4 pb-3 text-xs font-semibold text-amber-700">This job has more than one style — pick the style.</p>}
        {program && !program.needs_style && (
          <div className="space-y-3 border-t px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {program.cad ? (
                <span id="cp-cad" className="rounded bg-indigo-50 px-2 py-1 font-semibold text-indigo-800">CAD {program.cad.req_no} · {program.cad.status} · rejection {program.cad.rejection_pct}% · efficiency {program.cad.marker_efficiency}%</span>
              ) : <span className="rounded bg-amber-50 px-2 py-1 font-semibold text-amber-800">No CAD for this job + style — sales order quantities only</span>}
              <span className="rounded bg-slate-100 px-2 py-1">Order {fmtNumber(program.style?.order_qty)} PCS</span>
              {fab && <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-800">Fabric {fab.fabric_name || fab.fabric_type}{fab.gsm ? ` · ${fab.gsm} GSM` : ''}</span>}
              {(program.warnings || []).map((w: string) => <span key={w} className="rounded bg-amber-50 px-2 py-1 text-amber-800">{w}</span>)}
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs" id="cp-program">
                <thead className="border-b bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-2 text-left">Colour</th>
                    <th className="p-2 text-left">Qty</th>
                    {sizeOrder.map((sz) => <th key={sz} className="p-2 text-right">{sz}</th>)}
                    <th className="p-2 text-right">Total</th>
                    <th className="p-2 text-left">Plies (CAD)</th>
                    <th className="p-2 text-left">Cut plans</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {(program.colours || []).map((c: any, ci: number) => {
                    const cell = (sz: string) => (c.sizes || []).find((x: any) => x.size_code === sz) || {};
                    const active = colourName === c.color_name;
                    const rows: [string, string, (x: any) => number][] = [
                      ['so', 'Sales order', (x) => n(x.so_qty)],
                      ['cad', 'CAD cut (incl. rej.)', (x) => n(x.cad_cut_qty)],
                      ['other', 'In other cut plans', (x) => n(x.planned_other)],
                      ['todo', 'To plan', (x) => Math.max(0, n(x.suggested_qty) - n(x.planned_other))],
                    ];
                    return rows.map(([k, label, f], ri) => (
                      <tr key={`${c.color_name}-${k}`} className={`${ri === rows.length - 1 ? 'border-b-2' : 'border-b'} ${active ? 'bg-indigo-50/60' : ''}`}>
                        {ri === 0 && <td rowSpan={rows.length} className="p-2 align-top font-semibold text-slate-800">{c.color_name}{!c.color_id && <span className="block text-[10px] font-normal text-amber-700">not in colour master</span>}</td>}
                        <td className={`p-1.5 text-slate-500 ${k === 'todo' ? 'font-semibold text-indigo-700' : ''}`}>{label}</td>
                        {sizeOrder.map((sz) => <td key={sz} className={`p-1.5 text-right tabular-nums ${k === 'todo' ? 'font-semibold text-indigo-700' : ''}`}>{fmtNumber(f(cell(sz)))}</td>)}
                        <td className={`p-1.5 text-right font-semibold tabular-nums ${k === 'todo' ? 'text-indigo-700' : ''}`}>{fmtNumber((c.sizes || []).reduce((a: number, x: any) => a + f(x), 0))}</td>
                        {ri === 0 && <td rowSpan={rows.length} className="p-2 align-top">{(c.marker_plies || []).filter((m: any) => m.plies != null).map((m: any) => <div key={m.marker_ref}>{m.marker_ref}: <b>{m.plies}</b></div>)}{!(c.marker_plies || []).some((m: any) => m.plies != null) && <span className="text-slate-400">—</span>}</td>}
                        {ri === 0 && <td rowSpan={rows.length} className="p-2 align-top">{(c.plans || []).map((p: any) => <div key={p.id}><button className="font-mono text-brand-700 hover:underline" onClick={() => nav(`/production/cutting-plans/${p.id}`)}>{p.plan_no}</button> <span className="text-slate-400">{p.status}</span></div>)}{!(c.plans || []).length && <span className="text-slate-400">none</span>}</td>}
                        {ri === 0 && <td rowSpan={rows.length} className="p-2 align-top">
                          {isNew || !sizesLocked
                            ? <Button size="sm" variant={active ? 'primary' : 'outline'} id={`cp-colour-${ci}`} disabled={readOnly} onClick={() => applyColour(c)}>{active ? 'Selected ✓' : 'Use this colour'}</Button>
                            : active ? <Badge color="indigo">This plan</Badge> : null}
                        </td>}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>

            {(program.markers || []).length > 0 && (
              <div className="flex flex-wrap gap-2 text-[11px]" id="cp-markers">
                {program.markers.map((m: any) => (
                  <span key={m.marker_ref} className="rounded border bg-white px-2 py-1">
                    <b>{m.marker_ref}</b> · {m.fabric_type || '—'} · {m.sizes.map((s: string, i: number) => `${s}${m.ratios[i]}`).join(' ')} · {m.ppm} PCS/marker
                    {m.length_m ? ` · ${m.length_m} m` : ''}{m.kg_per_ply ? ` · ${m.kg_per_ply} KG/ply` : ''}
                    {selectedColour ? (() => { const pl = (selectedColour.marker_plies || []).find((x: any) => x.marker_ref === m.marker_ref)?.plies; return pl != null ? <b className="text-indigo-700"> · {pl} plies</b> : null; })() : null}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {loaded && !isNew && (
        <Card title="Cutting progress & consumption">
          <div className="grid grid-cols-2 gap-4 p-4 md:grid-cols-6 text-sm">
            <div><p className="text-xs text-slate-500">Status</p><Badge color={statusColorOf(loaded.status)}>{loaded.status}</Badge></div>
            <div><p className="text-xs text-slate-500">Order qty</p><p className="font-semibold">{fmtNumber(loaded.order_qty)} PCS</p></div>
            <div><p className="text-xs text-slate-500">Actual cut</p><p className="font-semibold text-emerald-700">{fmtNumber(loaded.actual_cut_qty)} PCS</p></div>
            <div><p className="text-xs text-slate-500">Balance</p><p className="font-semibold">{fmtNumber(loaded.balance_qty)} PCS</p></div>
            <div><p className="text-xs text-slate-500">Max without override</p><p className="font-semibold">{loaded.max_cut_qty != null ? `${fmtNumber(loaded.max_cut_qty)} PCS` : '—'}</p></div>
            <div><p className="text-xs text-slate-500">Unaccounted fabric</p><p className="font-semibold">{fmtNumber(loaded.reconciliation?.unaccounted_kg, 3)} KG</p></div>
            <div><p className="text-xs text-slate-500">Planned (BOM)</p><p className="font-semibold">{loaded.consumption?.planned?.kg_per_pc ?? '—'} KG/PC</p></div>
            <div><p className="text-xs text-slate-500">Marker (CAD)</p><p className="font-semibold">{loaded.consumption?.marker?.kg_per_pc ?? '—'} KG/PC</p></div>
            <div><p className="text-xs text-slate-500">Cutting actual</p><p className="font-semibold">{loaded.consumption?.cutting_actual?.kg_per_pc ?? '—'} KG/PC</p></div>
            <div><p className="text-xs text-slate-500">Actual − Planned</p><p className="font-semibold">{loaded.consumption?.variances?.actual_vs_planned?.variance_pct != null ? `${loaded.consumption.variances.actual_vs_planned.variance_pct} %` : '—'}</p></div>
            <div><p className="text-xs text-slate-500">Lays</p><p className="font-semibold">{loaded.lays?.length ?? 0}</p></div>
            <div><p className="text-xs text-slate-500">Fabric DCs</p><p className="font-semibold">{loaded.fabric_issues?.length ?? 0} · {fmtNumber(loaded.reconciliation?.net_issued_kg, 3)} KG net</p></div>
          </div>
        </Card>
      )}

      {/* 2. Size breakdown — filled from the chosen colour, still editable before release */}
      <Card title={`Size-wise breakdown${colourName ? ` — ${colourName}` : ''}`} subtitle="Planned qty defaults to the CAD cut qty (order + rejection %) less what other cut plans already hold">
        <div className="p-4">
          <table className="w-full text-sm" id="cp-sizes">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="pb-2 pr-3">Size</th>
                <th className="pb-2 pr-3 text-right">Order Qty (PCS)</th>
                <th className="pb-2 pr-3 text-right">Planned Qty (PCS)</th>
                <th className="pb-2 pr-3 text-right">Cut (PCS)</th>
                <th className="pb-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {sizes.length === 0 && <tr><td colSpan={5} className="py-3 text-center text-xs text-slate-400">Pick the job and a colour from the cutting program above.</td></tr>}
              {sizes.map((sz, idx) => (
                <tr key={idx} className="border-b border-slate-100">
                  <td className="py-2 pr-3">
                    <Select value={sz.size_id || ''} disabled={sizesLocked || readOnly}
                      onChange={e => updateSize(idx, 'size_id', e.target.value ? Number(e.target.value) : null)}
                      options={[{ value: '', label: '— Size —' }, ...availSizes.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
                  </td>
                  <td className="py-2 pr-3">
                    <Input type="number" value={sz.order_qty} disabled={sizesLocked || readOnly}
                      onChange={e => updateSize(idx, 'order_qty', Number(e.target.value))} className="text-right" />
                  </td>
                  <td className="py-2 pr-3">
                    <Input type="number" value={sz.planned_qty} disabled={sizesLocked || readOnly} id={`cp-size-${idx}-planned`}
                      onChange={e => updateSize(idx, 'planned_qty', Number(e.target.value))} className="text-right" />
                  </td>
                  <td className="py-2 pr-3 text-right font-semibold text-emerald-700">{fmtNumber(sz.actual_qty || 0)}</td>
                  <td className="py-2">
                    {!sizesLocked && !readOnly && <button onClick={() => removeSize(idx)} className="text-red-500 hover:text-red-700 text-xs">✕</button>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="pt-3">
                  {sizesLocked ? <span className="text-xs text-slate-400">Size breakdown is locked once the cut order is released.</span>
                    : !readOnly && <Button variant="ghost" size="sm" onClick={addSizeLine}>+ Add Size</Button>}
                </td>
              </tr>
              {sizes.length > 0 && (
                <tr className="border-t font-semibold">
                  <td className="pt-2">Total</td>
                  <td className="pt-2 text-right">{fmtNumber(totals.order)}</td>
                  <td className="pt-2 text-right" id="cp-total-planned">{fmtNumber(totals.planned)}</td>
                  <td className="pt-2 text-right">{fmtNumber(totals.cut)}</td>
                  <td></td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </Card>

      {/* 3. What the user fills */}
      <Card title="Plan details" actions={<button className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => setShowLinks((v) => !v)}>{showLinks ? 'Hide' : 'Show'} production order / SO line / part</button>}>
        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-4">
          <Input label="Plan No" value={header.plan_no} onChange={e => setField('plan_no', e.target.value)} placeholder="Auto-generate" disabled={!isNew} />
          <Input label="Plan Date" type="date" value={header.plan_date} onChange={e => setField('plan_date', e.target.value)} required id="cp-plan-date" />
          <Input label="Required Date" type="date" value={header.required_date} onChange={e => setField('required_date', e.target.value)} id="cp-required-date" />
          <Input label="Cutting Location" value={header.cutting_location} onChange={e => setField('cutting_location', e.target.value)} placeholder="e.g. CUT-FLOOR-1" />
          <Select label="Colour" value={header.color_id || ''} id="cp-colour"
            onChange={e => setField('color_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Colour —' }, ...colors.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Select label="Fabric" value={header.fabric_id || ''} id="cp-fabric" disabled={jobLocked}
            onChange={e => setField('fabric_id', e.target.value ? Number(e.target.value) : null)}
            options={[{ value: '', label: '— Select —' }, ...fabrics.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
          <Input label="Fabric Req (KG)" type="number" value={header.fabric_req_kg} onChange={e => setField('fabric_req_kg', e.target.value)} hint={program?.cad ? 'CAD plies × KG per ply' : undefined} />
          <Input label="Fabric Req (MTR)" type="number" value={header.fabric_req_mtr} onChange={e => setField('fabric_req_mtr', e.target.value)} />
          <Input label="Order Qty (PCS)" type="number" value={header.order_qty} onChange={e => setField('order_qty', Number(e.target.value))} />
          <Input label="Planned Cut Qty (PCS)" type="number" value={header.planned_cut_qty} onChange={e => setField('planned_cut_qty', Number(e.target.value))} id="cp-planned-qty" />
          <Input label="Authorised over-cut (%)" type="number" value={header.over_cut_pct}
            onChange={e => setField('over_cut_pct', Number(e.target.value))}
            hint={`Max ${fmtNumber(Math.floor((Number(header.order_qty) || 0) * (1 + (Number(header.over_cut_pct) || 0) / 100)))} PCS without override`} />
          <Input label="Over-cut reason (approver only)" value={header.over_cut_reason} onChange={e => setField('over_cut_reason', e.target.value)} />
          <Input label="Marker Ref" value={header.marker_ref} onChange={e => setField('marker_ref', e.target.value)} />
          <Input label="Marker Eff %" type="number" value={header.marker_eff_pct} onChange={e => setField('marker_eff_pct', e.target.value)} />
          <Select label="Status" value={header.status} id="cp-status" onChange={e => setField('status', e.target.value)} options={STATUSES.map(s => ({ value: s, label: s }))} />
          {header.status === 'CANCELLED' && savedStatus !== 'CANCELLED' && (
            <Input label="Cancel reason *" value={header.status_reason} onChange={e => setField('status_reason', e.target.value)} />
          )}
          {showLinks && <>
            <Select label="Production Order" value={header.prod_order_id || ''}
              onChange={e => handlePoSelect(e.target.value)}
              options={[{ value: '', label: '— None —' }, ...prodOrders.map((s: any) => ({ value: s.id, label: s.label || s.code }))]} />
            <Select label="Sales Order Line" value={header.so_line_id || ''}
              onChange={e => handleSoLineSelect(e.target.value)}
              options={[{ value: '', label: '— Not linked —' }, ...soLines.filter((l: any) => !header.so_id || Number(l.so_id) === Number(header.so_id)).map((l: any) => ({ value: l.id, label: l.label }))]} />
            <Select label="Garment Part" value={header.part_name || 'TOP'} disabled={Boolean(header.so_line_id)}
              hint={header.so_line_id ? 'Follows the linked Sales Order line' : undefined}
              onChange={e => setField('part_name', e.target.value)}
              options={[
                { value: 'TOP', label: 'TOP (Shirt / T-Shirt / Body)' },
                { value: 'BOTTOM', label: 'BOTTOM (Pants / Shorts / Pyjama)' },
                { value: 'FOLDING', label: 'FOLDING (Waistband / Fold)' },
                { value: 'COLLAR', label: 'COLLAR' },
                { value: 'FULL_SET', label: 'FULL SET' },
              ]} />
          </>}
        </div>
        <div className="px-4 pb-4">
          <Textarea label="Remarks" value={header.remarks} rows={2} onChange={e => setField('remarks', e.target.value)} />
        </div>
        {readOnly && <p className="px-4 pb-3 text-xs font-semibold text-slate-500">This cut order is {savedStatus} and read-only{savedStatus === 'CLOSED' ? ' — reopen it from Cutting Reconciliation to change it' : ''}.</p>}
        {!readOnly && (
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            {!isNew && <Button variant="outline" onClick={() => nav(`/production/lay-spreading?plan=${id}`)}>Plan lays →</Button>}
            <Button onClick={handleSave} loading={saving} id="cp-save-bottom">Save cutting plan</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

export default CuttingPlansPage;
