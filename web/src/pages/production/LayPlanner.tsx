import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Input, Select, Modal, Textarea, Badge } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../lib/auth';
import { JobSelect } from '../../components/JobSelect';
import { SearchSelect, StatusChip, Qty, UomInput, MetricTile, errMsg, ratioText } from './cuttingUi';

/**
 * Lay Planner — CAD marker → automatic lay calculation → roll allocation → issue → receive → spreading → cut
 * (client developer doc "CAD Marker Automatic Lay Calculation" + voice notes 04-Oct-2026):
 *   pick the job / cut order and everything up to the cutting program loads; the lay count comes from the
 *   approved CAD marker; the user changes only what differs (ply, lays) and sees the balance per lay;
 *   actuals at spreading / cutting show the variation against the CAD plan.
 */

export const LAY_FLOW = ['GENERATED', 'ROLL_RESERVED', 'PLAN_APPROVED', 'ISSUED', 'RECEIVED', 'SPREADING', 'READY_FOR_CUTTING', 'CUT', 'APPROVED'];
const FLOW_LABEL: Record<string, string> = {
  GENERATED: 'Generated', ROLL_RESERVED: 'Rolls reserved', PLAN_APPROVED: 'Plan approved', ISSUED: 'Fabric issued', RECEIVED: 'Received at cutting',
  SPREADING: 'Spreading', READY_FOR_CUTTING: 'Ready for cutting', CUT: 'Cut', APPROVED: 'Cut verified', PLANNED: 'Planned (manual)', SPREAD: 'Spread (manual)', CANCELLED: 'Cancelled',
};
export const flowLabel = (s: string) => FLOW_LABEL[s] ?? s;
const n = (v: unknown) => Number(v) || 0;

function FlowChip({ status }: { status: string }) {
  const tone: Record<string, string> = {
    GENERATED: 'bg-slate-100 text-slate-700', ROLL_RESERVED: 'bg-sky-100 text-sky-800', PLAN_APPROVED: 'bg-indigo-100 text-indigo-800',
    ISSUED: 'bg-violet-100 text-violet-800', RECEIVED: 'bg-teal-100 text-teal-800', SPREADING: 'bg-amber-100 text-amber-800',
    READY_FOR_CUTTING: 'bg-orange-100 text-orange-800', CUT: 'bg-emerald-100 text-emerald-800', APPROVED: 'bg-emerald-200 text-emerald-900',
    CANCELLED: 'bg-red-100 text-red-700',
  };
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone[status] ?? 'bg-slate-100 text-slate-700'}`}>{flowLabel(status)}</span>;
}

/* ================================================================== workbench */

export function LayPlannerTab({ initialPlanId, onExecute, onChanged, reloadSignal }: { initialPlanId?: string | null; onExecute: (lay: any) => void; onChanged?: () => void; reloadSignal?: number }) {
  const toast = useToast();
  const { canAny } = useAuth();
  const canApproveMarker = canAny('PRODUCTION.APPROVE', 'CAD_MARKER.APPROVE');
  const [jobId, setJobId] = useState<number | null>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [planId, setPlanId] = useState<string>(initialPlanId ?? '');
  const [wb, setWb] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<number[]>([]);
  const [opts, setOpts] = useState<any>({ max_ply: '', min_ply: '', table_id: '', strategy: 'COVER' });
  const [preview, setPreview] = useState<any>(null);
  const [edit, setEdit] = useState<{ marker_version_id: number; ply: number }[] | null>(null);
  const [override, setOverride] = useState('');
  const [layDate, setLayDate] = useState(today());
  const [busy, setBusy] = useState(false);

  const loadPlans = (soId: number | null) => {
    api.get('/cutting-plans').then((r) => {
      const all = (r.data.data || []).filter((p: any) => !['CLOSED', 'CANCELLED'].includes(p.status));
      setPlans(soId ? all.filter((p: any) => Number(p.so_id) === soId) : all);
    });
  };
  useEffect(() => { loadPlans(null); }, []);

  const load = (pid = planId) => {
    if (!pid) { setWb(null); return; }
    setLoading(true);
    api.get(`/cutting-plans/${pid}/lay-workbench`).then((r) => {
      const d = r.data.data;
      setWb(d);
      setPreview(null); setEdit(null); setOverride('');
      // default: every approved marker whose fabric matches and that cuts this colour (CAD sort order)
      setSel(d.markers.filter((m: any) => m.usable && m.fabric_match !== false && m.has_colour).map((m: any) => m.usable.id));
      setOpts((o: any) => ({ ...o, max_ply: o.max_ply || String(d.settings.max_ply), min_ply: o.min_ply || String(d.settings.min_ply) }));
      if (!jobId && d.plan.so_id) { setJobId(Number(d.plan.so_id)); loadPlans(Number(d.plan.so_id)); }
    }).catch((e) => toast(errMsg(e), 'error')).finally(() => setLoading(false));
  };
  useEffect(() => { load(planId); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [planId, reloadSignal]);
  const refresh = () => { load(); onChanged?.(); };

  const snapshot = async (m: any, approve: boolean) => {
    if (!wb?.cad) return;
    setBusy(true);
    try {
      const r = await api.post('/marker-versions/snapshot', { cad_req_id: wb.cad.id, marker_ref: m.marker_ref, fabric_id: wb.plan.fabric_id || null, approve });
      const v = r.data.data;
      toast(r.data.created ? `Marker ${v.marker_no} v${v.version} imported from CAD${r.data.approved ? ' and approved' : ' — approve it to plan lays'}` : `No change in CAD — v${v.version} (${v.status}) is current${r.data.approved ? ', now approved' : ''}`);
      load();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const approveMarker = async (id: number) => {
    setBusy(true);
    try { await api.post(`/marker-versions/${id}/approve`, {}); toast('Marker version approved'); load(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  const body = (extra: any = {}) => ({
    marker_version_ids: sel, strategy: opts.strategy,
    max_ply: opts.max_ply ? Number(opts.max_ply) : undefined, min_ply: opts.min_ply ? Number(opts.min_ply) : undefined,
    table_id: opts.table_id ? Number(opts.table_id) : undefined, ...extra,
  });
  const runPreview = async (lays?: { marker_version_id: number; ply: number }[] | null) => {
    if (!sel.length) return toast('Tick at least one approved marker', 'error');
    setBusy(true);
    try {
      const r = await api.post(`/cutting-plans/${planId}/generate-lay`, body({ preview: true, lays: lays ?? undefined }));
      setPreview(r.data.data);
      setEdit((r.data.data.lays || []).map((l: any) => ({ marker_version_id: l.marker_version_id, ply: l.ply })));
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const saveLays = async () => {
    if (!edit?.length) return;
    setBusy(true);
    try {
      const r = await api.post(`/cutting-plans/${planId}/generate-lay`, body({ lays: edit.filter((x) => x.ply > 0), lay_date: layDate, override_reason: override || null }));
      toast(`${r.data.data.lays.length} lay(s) saved: ${r.data.data.lays.map((l: any) => l.lay_no).join(', ')}`);
      refresh();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  const markersById = useMemo(() => {
    const m = new Map<number, any>();
    (wb?.markers || []).forEach((x: any) => x.versions.forEach((v: any) => m.set(v.id, { ...v, key: x.key })));
    return m;
  }, [wb]);
  const plan = wb?.plan;
  const req = wb?.requirement;
  const overTol = (preview?.sizes || []).filter((x: any) => x.over_tolerance);

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid grid-cols-1 items-end gap-3 p-4 md:grid-cols-4">
          <JobSelect by="so_id" value={jobId} id="lp-job" onPick={(j) => { setJobId(j?.id ?? null); loadPlans(j?.id ?? null); setPlanId(''); }} />
          <SearchSelect className="md:col-span-2" label="Cut order (colour)" value={planId} onChange={setPlanId}
            placeholder={plans.length ? 'Select the cut order' : 'No open cut order — create one in Cutting Plans'}
            options={plans.map((p: any) => ({ value: p.id, label: `${p.plan_no} · ${p.style_code || ''} · ${p.color_name || 'all colours'}`, sub: p.fabric_name || undefined, right: p.status }))} />
          <div className="text-xs text-slate-500">{loading ? 'Loading…' : wb ? `${wb.lays.length} lay(s) on this cut order` : 'Pick the job, then the cut order'}</div>
        </div>
      </Card>

      {wb && (
        <>
          {/* §12 Header */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-8" id="lp-header">
            <MetricTile label="Job" value={plan.io_no} sub={plan.so_no} />
            <MetricTile label="Buyer" value={plan.buyer_name || '—'} />
            <MetricTile label="Buyer PO" value={plan.buyer_po_no || '—'} />
            <MetricTile label="Style" value={plan.style_code} sub={plan.style_name} />
            <MetricTile label="Colour" value={plan.color_name || '—'} />
            <MetricTile label="Fabric" value={plan.fabric_name || '—'} />
            <MetricTile label="Order qty" value={fmtNumber(plan.order_qty)} uom="PCS" sub={`plan ${fmtNumber(plan.planned_cut_qty)}`} />
            <MetricTile label="Cut order" value={<StatusChip status={plan.status} />} sub={plan.plan_no} />
          </div>

          {/* §12 CAD */}
          <Card title="CAD markers" subtitle={wb.cad ? `CAD ${wb.cad.req_no} (${wb.cad.status}) · efficiency ${wb.cad.marker_efficiency}% · rejection ${wb.cad.rejection_pct}% — only an APPROVED marker version plans lays` : 'No CAD linked to this job + style — import markers in the Marker Versions tab'}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" id="lp-markers">
                <thead className="border-b bg-slate-50 text-left text-slate-600">
                  <tr><th className="p-2 w-8">Use</th><th className="p-2">Marker</th><th className="p-2">Version</th><th className="p-2">Approval</th><th className="p-2">Fabric</th>
                    <th className="p-2">Size ratio</th><th className="p-2 text-right">PCS/marker</th><th className="p-2 text-right">Length</th><th className="p-2 text-right">Width</th>
                    <th className="p-2 text-right">KG/ply</th><th className="p-2 text-right">Efficiency</th><th className="p-2 text-right">CAD plies</th><th className="p-2" /></tr>
                </thead>
                <tbody>
                  {wb.markers.length === 0 && <tr><td colSpan={13} className="p-3 text-center text-slate-400">No marker for this style.</td></tr>}
                  {wb.markers.map((m: any) => {
                    const v = m.usable ?? m.latest;
                    const checked = !!m.usable && sel.includes(m.usable.id);
                    return (
                      <tr key={m.key} className={`border-b ${m.fabric_match === false || !m.has_colour ? 'text-slate-400' : ''}`}>
                        <td className="p-2"><input type="checkbox" disabled={!m.usable} checked={checked} id={`lp-use-${m.marker_ref}`}
                          onChange={(e) => setSel((s) => (e.target.checked ? [...s, m.usable.id] : s.filter((x) => x !== m.usable.id)))} /></td>
                        <td className="p-2 font-semibold">{m.marker_ref} <span className="font-normal text-slate-400">{m.source}</span></td>
                        <td className="p-2">{v ? `v${v.version}` : '—'}{m.versions.length > 1 && <span className="text-slate-400"> ({m.versions.length})</span>}</td>
                        <td className="p-2">{v ? <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${v.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{v.status}</span> : <span className="text-amber-700">not imported</span>}
                          {v?.approved_by_name && <span className="block text-[10px] text-slate-400">{v.approved_by_name}</span>}</td>
                        <td className="p-2">{m.fabric_type || '—'}{m.fabric_match === false && <span className="block text-[10px] text-red-600">other fabric</span>}{!m.has_colour && <span className="block text-[10px] text-red-600">colour not on marker</span>}</td>
                        <td className="p-2 font-mono">{ratioText(m.sizes, m.ratios)}</td>
                        <td className="p-2 text-right"><Qty v={m.ppm} uom="PCS" /></td>
                        <td className="p-2 text-right"><Qty v={v?.length_m ?? m.length_m} uom="M" dp={3} /></td>
                        <td className="p-2 text-right"><Qty v={v?.width_in ?? m.width_in} uom="IN" dp={1} /></td>
                        <td className="p-2 text-right"><Qty v={v?.marker_kg_per_ply ?? m.kg_per_ply} uom={v?.uom === 'MTR' ? 'M' : 'KG'} dp={3} /></td>
                        <td className="p-2 text-right">{v?.efficiency_pct ?? wb.cad?.marker_efficiency ?? '—'}%</td>
                        <td className="p-2 text-right font-semibold text-indigo-700">{m.cad_plies ?? '—'}</td>
                        <td className="p-2 text-right whitespace-nowrap">
                          {m.source === 'CAD' && <Button size="sm" variant="outline" disabled={busy} id={`lp-import-${m.marker_ref}`} onClick={() => snapshot(m, false)}>{m.latest ? 'Re-import' : 'Import'}</Button>}
                          {m.source === 'CAD' && !m.usable && canApproveMarker && <Button size="sm" className="ml-1" disabled={busy} id={`lp-import-approve-${m.marker_ref}`} onClick={() => snapshot(m, true)}>Import & approve</Button>}
                          {m.latest && m.latest.status !== 'APPROVED' && !['REJECTED', 'OBSOLETE'].includes(m.latest.status) && canApproveMarker && m.source !== 'CAD' && <Button size="sm" className="ml-1" disabled={busy} onClick={() => approveMarker(m.latest.id)}>Approve</Button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* §12 Calculation */}
          <Card title="Automatic lay calculation" subtitle="Pending = cut order target − already cut − already on open lays. Lays = plies split by the max ply of the table.">
            <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-6" id="lp-calc">
              <MetricTile label="Target" value={fmtNumber(req.totals.target)} uom="PCS" />
              <MetricTile label="Already cut" value={fmtNumber(req.totals.cut)} uom="PCS" tone="emerald" />
              <MetricTile label="On open lays" value={fmtNumber(req.totals.on_open_lays)} uom="PCS" />
              <MetricTile label="Pending" value={fmtNumber(req.totals.pending)} uom="PCS" tone="indigo" />
              <MetricTile label="Eligible fabric" value={fmtNumber(wb.fabric.eligible_kg, 3)} uom="KG" sub={`${wb.fabric.eligible_rolls} roll(s)${wb.fabric.eligible_m != null ? ` · ${fmtNumber(wb.fabric.eligible_m, 1)} m` : ''}`} tone="emerald" />
              <MetricTile label="Reserved / with cutting" value={`${fmtNumber(wb.fabric.reserved_kg, 1)} / ${fmtNumber(wb.fabric.with_cutting_kg, 1)}`} uom="KG" />
            </div>
            <div className="overflow-x-auto px-4">
              <table className="w-full text-xs">
                <thead className="border-b text-slate-500"><tr><th className="p-1.5 text-left">Size</th>{req.sizes.map((x: any) => <th key={x.size_id} className="p-1.5 text-right">{x.size_code}</th>)}</tr></thead>
                <tbody>
                  {[['Target', 'target'], ['Cut', 'cut'], ['On open lays', 'on_open_lays'], ['Pending', 'pending']].map(([l, k]) => (
                    <tr key={k} className={`border-b ${k === 'pending' ? 'font-semibold text-indigo-700' : ''}`}><td className="p-1.5">{l}</td>{req.sizes.map((x: any) => <td key={x.size_id} className="p-1.5 text-right tabular-nums">{fmtNumber(x[k])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-2 items-end gap-3 p-4 md:grid-cols-6">
              <Select label="Cutting table" value={opts.table_id} id="lp-table" onChange={(e) => {
                const t = wb.tables.find((x: any) => String(x.id) === e.target.value);
                setOpts({ ...opts, table_id: e.target.value, max_ply: t ? String(t.max_ply) : String(wb.settings.max_ply), min_ply: t ? String(t.min_ply) : String(wb.settings.min_ply) });
              }} options={[{ value: '', label: `Default (max ${wb.settings.max_ply} ply)` }, ...wb.tables.map((t: any) => ({ value: t.id, label: `${t.table_code} · max ${t.max_ply} ply${t.length_m ? ` · ${t.length_m} m` : ''}` }))]} />
              <UomInput label="Max ply / lay" uom="PLY" value={opts.max_ply} step="1" min={1} onChange={(v) => setOpts({ ...opts, max_ply: v })} />
              <UomInput label="Min ply / lay" uom="PLY" value={opts.min_ply} step="1" min={1} onChange={(v) => setOpts({ ...opts, min_ply: v })} />
              <Select label="Plies" value={opts.strategy} id="lp-strategy" onChange={(e) => setOpts({ ...opts, strategy: e.target.value })}
                options={[{ value: 'COVER', label: 'Cover every size (CAD plies)' }, { value: 'NO_OVER', label: 'No over-production (residual left)' }]} />
              <Input label="Lay date" type="date" value={layDate} onChange={(e) => setLayDate(e.target.value)} />
              <Button id="lp-generate" loading={busy} disabled={!sel.length || req.totals.pending <= 0} onClick={() => runPreview(null)}>Generate lays</Button>
            </div>
            {req.totals.pending <= 0 && <p className="px-4 pb-3 text-xs font-semibold text-emerald-700">Everything on this cut order is already cut or on a lay.</p>}
          </Card>

          {preview && edit && (
            <Card title="Proposed lays" subtitle="Change only what differs — ply per lay, add or drop a lay — and recalculate. Each lay shows what is left to plan and the fabric left after it."
              actions={<><Button size="sm" variant="outline" onClick={() => setEdit([...edit, { marker_version_id: edit[edit.length - 1]?.marker_version_id ?? sel[0], ply: 0 }])}>+ Lay</Button>
                <Button size="sm" variant="outline" id="lp-recalc" loading={busy} onClick={() => runPreview(edit)}>Recalculate</Button></>}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" id="lp-proposal">
                  <thead className="border-b bg-slate-50 text-left text-slate-600">
                    <tr><th className="p-2">Lay</th><th className="p-2">Marker</th><th className="p-2 w-28">Ply</th><th className="p-2 text-right">Output</th>
                      {(preview.requirement?.sizes || []).map((x: any) => <th key={x.size_id} className="p-2 text-right">{x.size_code}</th>)}
                      <th className="p-2 text-right">Length</th><th className="p-2 text-right">Fabric</th><th className="p-2 text-right">PCS left</th><th className="p-2 text-right">Fabric left</th><th className="w-8" /></tr>
                  </thead>
                  <tbody>
                    {edit.map((e, i) => {
                      const pl = preview.lays[i];
                      const mv = markersById.get(e.marker_version_id);
                      return (
                        <tr key={i} className="border-b">
                          <td className="p-2 font-semibold">{i + 1}</td>
                          <td className="p-2"><select className="input py-1 text-xs" value={e.marker_version_id} onChange={(x) => setEdit(edit.map((y, j) => (j === i ? { ...y, marker_version_id: Number(x.target.value) } : y)))}>
                            {sel.map((id) => { const v = markersById.get(id); return <option key={id} value={id}>{v ? `${v.marker_no} v${v.version}` : id}</option>; })}
                          </select></td>
                          <td className="p-1.5"><UomInput uom="PLY" value={e.ply} step="1" min={0} onChange={(v) => setEdit(edit.map((y, j) => (j === i ? { ...y, ply: Number(v) || 0 } : y)))} /></td>
                          <td className="p-2 text-right font-semibold">{pl ? fmtNumber(pl.output_pcs) : (mv ? fmtNumber(mv.pieces_per_marker * e.ply) : '—')}</td>
                          {(preview.requirement?.sizes || []).map((x: any) => <td key={x.size_id} className="p-2 text-right tabular-nums">{pl ? fmtNumber(pl.output?.[String(x.size_code).toUpperCase()] ?? 0) : '…'}</td>)}
                          <td className="p-2 text-right"><Qty v={pl?.length_m} uom="M" dp={2} /></td>
                          <td className="p-2 text-right"><Qty v={pl?.kg} uom="KG" dp={3} /></td>
                          <td className={`p-2 text-right font-semibold ${pl && pl.balance_pcs < 0 ? 'text-amber-700' : 'text-indigo-700'}`}>{pl ? fmtNumber(pl.balance_pcs) : '…'}</td>
                          <td className={`p-2 text-right font-semibold ${pl && pl.fabric_balance_kg < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{pl ? <Qty v={pl.fabric_balance_kg} uom="KG" dp={2} /> : '…'}</td>
                          <td className="p-2"><button className="font-bold text-red-500" onClick={() => setEdit(edit.filter((_, j) => j !== i))}>×</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot><tr className="font-semibold"><td className="p-2" colSpan={2}>Total {preview.totals.lays} lay(s)</td><td className="p-2">{preview.totals.plies} ply</td>
                    <td className="p-2 text-right">{fmtNumber(preview.totals.planned)}</td>{(preview.requirement?.sizes || []).map((x: any) => <td key={x.size_id} />)}
                    <td className="p-2 text-right"><Qty v={preview.totals.fabric_m} uom="M" dp={1} /></td><td className="p-2 text-right"><Qty v={preview.totals.fabric_kg} uom="KG" dp={2} /></td><td colSpan={3} /></tr></tfoot>
                </table>
              </div>
              <div className="grid gap-4 p-4 md:grid-cols-2">
                <div>
                  <h4 className="mb-1 text-xs font-semibold text-slate-600">Size ratio validation (doc §7)</h4>
                  <table className="w-full text-xs" id="lp-size-check">
                    <thead className="border-b text-slate-500"><tr><th className="p-1 text-left">Size</th><th className="p-1 text-right">Required</th><th className="p-1 text-right">Planned</th><th className="p-1 text-right">Residual</th><th className="p-1 text-right">Over</th></tr></thead>
                    <tbody>{preview.sizes.map((x: any) => (
                      <tr key={x.size} className={`border-b ${x.over_tolerance ? 'bg-red-50 text-red-700' : ''}`}><td className="p-1 font-semibold">{x.size}</td><td className="p-1 text-right">{fmtNumber(x.required)}</td>
                        <td className="p-1 text-right">{fmtNumber(x.planned)}</td><td className={`p-1 text-right ${x.residual > 0 ? 'font-semibold text-amber-700' : ''}`}>{fmtNumber(x.residual)}</td>
                        <td className="p-1 text-right">{x.over > 0 ? `+${fmtNumber(x.over)} (${x.over_pct}%)` : '—'}</td></tr>))}</tbody>
                  </table>
                  <p className="mt-1 text-[11px] text-slate-500">Tolerance {preview.settings?.size_tolerance_pct}% per size (Admin › Settings › CUT_SIZE_TOLERANCE_PCT).</p>
                </div>
                <div className="space-y-2">
                  {preview.markers.map((m: any) => <p key={m.marker_version_id} className="text-xs">Marker <b>{m.marker_no} v{m.version}</b>: {m.ppm} PCS/marker · required marker units <b>{m.required_marker_units}</b> · {m.plies} plies in {m.lays} lay(s) · {fmtNumber(m.output_pcs)} PCS</p>)}
                  {(preview.warnings || []).map((w: string) => <p key={w} className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">{w}</p>)}
                  {overTol.length > 0 && <Input label="Reason for planning beyond the size tolerance *" value={override} onChange={(e) => setOverride(e.target.value)} id="lp-override" />}
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="ghost" onClick={() => { setPreview(null); setEdit(null); }}>Discard</Button>
                    <Button id="lp-save-lays" loading={busy} disabled={overTol.length > 0 && !override.trim()} onClick={saveLays}>Save {edit.filter((x) => x.ply > 0).length} lay(s)</Button>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* §12 Grid + actions */}
          <Card title="Lays of this cut order" subtitle="Generate → reserve rolls → approve → issue → receive → spread → cut. Each action is on its lay.">
            <LayGrid lays={wb.lays} onExecute={onExecute} onDone={refresh} />
          </Card>

          <PlannedVsActual planId={planId} key={`pva-${planId}-${wb.lays.map((l: any) => l.status).join()}`} />
        </>
      )}
    </div>
  );
}

/* ================================================================== lay grid + lifecycle actions */

export function LayGrid({ lays, onExecute, onDone }: { lays: any[]; onExecute: (lay: any) => void; onDone: () => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" id="lp-lays">
        <thead className="border-b bg-slate-50 text-left text-slate-600">
          <tr><th className="p-2">Lay No</th><th className="p-2">Marker</th><th className="p-2 text-right">Ply</th><th className="p-2 text-right">Output</th><th className="p-2 text-right">Length</th>
            <th className="p-2 text-right">Fabric</th><th className="p-2">Rolls</th><th className="p-2">Shade / Lot</th><th className="p-2">DC</th><th className="p-2">Status</th><th className="p-2 text-right">Actions</th></tr>
        </thead>
        <tbody>
          {lays.length === 0 && <tr><td colSpan={11} className="p-3 text-center text-slate-400">No lays yet.</td></tr>}
          {lays.map((l) => (
            <tr key={l.id} className={`border-b ${l.status === 'CANCELLED' ? 'text-slate-400 line-through' : ''}`} id={`lay-row-${l.lay_no}`}>
              <td className="p-2 font-mono font-semibold">{l.lay_no}{l.lay_seq ? <span className="ml-1 text-slate-400">#{l.lay_seq}</span> : null}</td>
              <td className="p-2">{l.marker_no ? `${l.marker_no} v${l.marker_version}` : (l.marker_ref || '—')}</td>
              <td className="p-2 text-right">{l.ply_count}{l.actual_ply && n(l.actual_ply) !== n(l.ply_count) ? <span className="text-amber-700"> → {l.actual_ply}</span> : null}</td>
              <td className="p-2 text-right"><Qty v={l.expected_pieces} uom="PCS" />{n(l.actual_cut_qty) > 0 && <div className="text-emerald-700"><Qty v={l.actual_cut_qty} uom="cut" /></div>}</td>
              <td className="p-2 text-right"><Qty v={l.planned_length_m ?? (n(l.marker_length_m) * n(l.ply_count) || null)} uom="M" dp={2} /></td>
              <td className="p-2 text-right"><Qty v={l.planned_kg} uom="KG" dp={2} />{n(l.actual_kg) > 0 && <div className="text-emerald-700"><Qty v={l.actual_kg} uom="act" dp={2} /></div>}</td>
              <td className="p-2">{n(l.alloc_rolls) > 0 ? <>{l.alloc_rolls} · <Qty v={l.alloc_kg} uom="KG" dp={2} /></> : '—'}</td>
              <td className="p-2">{l.shade_lots || '—'}</td>
              <td className="p-2 font-mono">{l.issue_no || '—'}</td>
              <td className="p-2"><FlowChip status={l.status} /></td>
              <td className="p-2 text-right"><LayActions lay={l} onExecute={onExecute} onDone={onDone} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LayActions({ lay, onExecute, onDone }: { lay: any; onExecute: (lay: any) => void; onDone: () => void }) {
  const toast = useToast();
  const { canAny } = useAuth();
  const supervise = canAny('PRODUCTION.APPROVE', 'CUTTING.SUPERVISE');
  const [modal, setModal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const post = async (path: string, body: any, msg: string) => {
    setBusy(true);
    try { await api.post(path, body); toast(msg); onDone(); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const s = lay.status;
  const id = lay.lay_no;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {['GENERATED', 'ROLL_RESERVED', 'PLAN_APPROVED'].includes(s) && <Button size="sm" variant={s === 'GENERATED' ? 'primary' : 'outline'} id={`${id}-allocate`} onClick={() => setModal('alloc')}>{s === 'GENERATED' ? 'Allocate rolls' : 'Re-allocate'}</Button>}
      {s === 'ROLL_RESERVED' && supervise && <Button size="sm" id={`${id}-approve-plan`} loading={busy} onClick={() => post(`/lay-plans/${lay.id}/approve`, {}, `Lay ${lay.lay_no} plan approved`)}>Approve plan</Button>}
      {s === 'PLAN_APPROVED' && <Button size="sm" id={`${id}-issue`} onClick={() => setModal('issue')}>Issue fabric</Button>}
      {s === 'ISSUED' && <Button size="sm" id={`${id}-receive`} loading={busy} onClick={() => post(`/lay-plans/${lay.id}/receive`, {}, `Lay ${lay.lay_no}: fabric received at cutting`)}>Receive</Button>}
      {['RECEIVED', 'SPREADING'].includes(s) && <Button size="sm" id={`${id}-spread`} onClick={() => setModal('spread')}>{s === 'RECEIVED' ? 'Start spreading' : 'Complete spreading'}</Button>}
      {s === 'READY_FOR_CUTTING' && <Button size="sm" id={`${id}-cut`} onClick={() => onExecute(lay)}>Cut</Button>}
      {s === 'CUT' && supervise && <Button size="sm" variant="outline" id={`${id}-verify-cut`} loading={busy} onClick={() => post(`/lay-plans/${lay.id}/approve`, {}, `Lay ${lay.lay_no} cut verified`)}>Verify cut</Button>}
      {['CUT', 'APPROVED'].includes(s) && <Button size="sm" variant="outline" id={`${id}-bundles`} loading={busy} onClick={() => post(`/lay-plans/${lay.id}/bundles`, { bundle_size: 10 }, `Bundles generated for ${lay.lay_no}`)}>Bundles</Button>}
      {['ROLL_RESERVED', 'PLAN_APPROVED'].includes(s) && <Button size="sm" variant="ghost" id={`${id}-release`} onClick={() => setModal('release')}>Release</Button>}
      {s !== 'CANCELLED' && <Button size="sm" variant="ghost" id={`${id}-sheet`} onClick={() => setModal('sheet')}>Lay sheet</Button>}
      <Button size="sm" variant="ghost" id={`${id}-trace`} onClick={() => setModal('trace')}>Trace</Button>
      {['GENERATED', 'ROLL_RESERVED', 'PLAN_APPROVED'].includes(s) && <Button size="sm" variant="ghost" id={`${id}-cancel`} onClick={() => setModal('cancel')}>Cancel</Button>}
      {modal === 'alloc' && <RollAllocationModal lay={lay} onClose={() => setModal(null)} onSaved={() => { setModal(null); onDone(); }} />}
      {modal === 'issue' && <IssueModal lay={lay} onClose={() => setModal(null)} onSaved={() => { setModal(null); onDone(); }} />}
      {modal === 'spread' && <FlowSpreadingModal lay={lay} onClose={() => setModal(null)} onSaved={() => { setModal(null); onDone(); }} />}
      {modal === 'sheet' && <LaySheetModal lay={lay} onClose={() => setModal(null)} />}
      {modal === 'trace' && <GenealogyModal lay={lay} onClose={() => setModal(null)} />}
      {(modal === 'release' || modal === 'cancel') && <ReasonModal title={`${modal === 'release' ? 'Release the rolls of' : 'Cancel'} lay ${lay.lay_no}`}
        onClose={() => setModal(null)} onOk={(reason) => post(modal === 'release' ? `/lay-plans/${lay.id}/release-rolls` : `/lay-plans/${lay.id}/cancel`, { reason },
          modal === 'release' ? 'Rolls released' : 'Lay cancelled').then(() => setModal(null))} />}
    </div>
  );
}

function ReasonModal({ title, onClose, onOk }: { title: string; onClose: () => void; onOk: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal open onClose={onClose} title={title} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant="danger" id="reason-ok" disabled={!reason.trim()} onClick={() => onOk(reason)}>Confirm</Button></>}>
      <Textarea label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} id="reason-text" />
    </Modal>
  );
}

/* ------------------------------------------------------------------ roll allocation (doc §8–§10) */

function RollAllocationModal({ lay, onClose, onSaved }: { lay: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [rolls, setRolls] = useState<any[]>([]);
  const [proposal, setProposal] = useState<any>(null);
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [r, p] = await Promise.all([
      api.get(`/cutting-plans/${lay.cutting_plan_id}/eligible-rolls`, { params: { lay_id: lay.id, all: 1 } }),
      api.post(`/lay-plans/${lay.id}/auto-allocate-rolls`, {}),
    ]);
    setRolls(r.data.data || []);
    setProposal(p.data.data);
    setPicked(Object.fromEntries((p.data.data.lines || []).map((l: any) => [l.fabric_roll_id, String(l.alloc_kg)])));
  };
  useEffect(() => { load().catch((e) => toast(errMsg(e), 'error')); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lay.id]);
  const eligible = rolls.filter((r) => r.eligible);
  const ineligible = rolls.filter((r) => !r.eligible);
  const total = Object.values(picked).reduce((a, v) => a + n(v), 0);
  const need = proposal?.need;
  const save = async () => {
    const lines = Object.entries(picked).filter(([, v]) => n(v) > 0).map(([k, v]) => ({ fabric_roll_id: Number(k), alloc_kg: n(v) }));
    if (!lines.length) return toast('Pick at least one roll', 'error');
    setBusy(true);
    try {
      const auto = proposal && lines.length === proposal.lines.length && lines.every((l) => proposal.lines.some((p: any) => p.fabric_roll_id === l.fabric_roll_id && Math.abs(p.alloc_kg - l.alloc_kg) < 0.0005));
      const r = await api.post(`/lay-plans/${lay.id}/reserve`, { rolls: lines, method: auto ? 'AUTO' : 'MANUAL' });
      toast(`${r.data.data.lines.length} roll(s) reserved for ${lay.lay_no}${r.data.data.short > 0 ? ` — short by ${r.data.data.short} ${r.data.data.need.basis}` : ''}${r.data.data.mixed_shade ? ' · mixed shade/lot' : ''}`, r.data.data.short > 0 ? 'warning' : 'success');
      onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Roll allocation — lay ${lay.lay_no}`} size="full"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="outline" onClick={() => setPicked(Object.fromEntries((proposal?.lines || []).map((l: any) => [l.fabric_roll_id, String(l.alloc_kg)])))}>Auto allocate</Button>
        <Button id="alloc-reserve" loading={busy} onClick={save}>Reserve rolls</Button></>}>
      <div className="space-y-4 text-xs">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <MetricTile label="Lay needs" value={need ? fmtNumber(need.qty, 3) : '—'} uom={need?.basis === 'M' ? 'M' : 'KG'} tone="indigo" sub={`${lay.ply_count} ply`} />
          <MetricTile label="Picked" value={fmtNumber(total, 3)} uom="KG" tone={need && need.basis === 'KG' && total + 0.0005 < need.qty ? 'amber' : 'emerald'} />
          <MetricTile label="Auto proposal" value={proposal ? (proposal.mixed_shade ? 'Mixed shade/lot' : proposal.group ? `Shade/lot ${proposal.group.replace('|', ' / ') || '—'}` : '—') : '…'} sub={proposal?.short_kg > 0 ? `short ${proposal.short_kg}` : 'covers the lay'} />
          <MetricTile label="Eligible rolls" value={eligible.length} sub={`${fmtNumber(eligible.reduce((a, r) => a + r.available_kg, 0), 2)} KG free`} tone="emerald" />
          <MetricTile label="Not eligible" value={ineligible.length} tone={ineligible.length ? 'amber' : 'slate'} />
        </div>
        <p className="text-slate-500">Rule (doc §8–§10): same job, colour, fabric, QC passed, GSM / width within tolerance; same shade / lot for one lay first, then FIFO; the last roll is taken partly and keeps its balance. Nothing is consumed until the lay is cut.</p>
        <table className="w-full border" id="alloc-rolls">
          <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-1.5">Roll</th><th className="p-1.5">Shade / Lot</th><th className="p-1.5">GRN</th><th className="p-1.5 text-right">GSM</th><th className="p-1.5 text-right">Width</th>
            <th className="p-1.5 text-right">Roll KG</th><th className="p-1.5 text-right">Free KG</th><th className="p-1.5 text-right">Free M</th><th className="p-1.5">Store</th><th className="p-1.5 w-36">Allocate (KG)</th><th className="p-1.5 text-right">Balance after</th></tr></thead>
          <tbody>
            {eligible.length === 0 && <tr><td colSpan={11} className="p-3 text-center text-slate-400">No eligible roll for this cut order — see the rolls that are not eligible below.</td></tr>}
            {eligible.map((r) => {
              const v = picked[r.id] ?? '';
              const bal = r.available_kg - n(v);
              return (
                <tr key={r.id} className={`border-t ${n(v) > 0 ? 'bg-emerald-50/50' : ''}`}>
                  <td className="p-1.5 font-mono font-semibold">{r.roll_no}</td><td className="p-1.5">{r.shade || '—'} / {r.lot_no || '—'}</td>
                  <td className="p-1.5">{r.grn_no || '—'} <span className="text-slate-400">{r.grn_date ? fmtDate(r.grn_date) : ''}</span></td>
                  <td className="p-1.5 text-right">{r.gsm ?? '—'}</td><td className="p-1.5 text-right">{r.width_in ? `${r.width_in}"` : '—'}</td>
                  <td className="p-1.5 text-right"><Qty v={r.weight_kg} uom="KG" dp={2} /></td><td className="p-1.5 text-right font-semibold"><Qty v={r.available_kg} uom="KG" dp={3} /></td>
                  <td className="p-1.5 text-right"><Qty v={r.available_m} uom="M" dp={1} /></td><td className="p-1.5">{r.warehouse_name}{r.location_bin ? ` · ${r.location_bin}` : ''}</td>
                  <td className="p-1"><UomInput uom="KG" value={v} min={0} onChange={(x) => setPicked({ ...picked, [r.id]: x })} /></td>
                  <td className={`p-1.5 text-right ${bal < -0.0005 ? 'font-semibold text-red-600' : ''}`}>{n(v) > 0 ? <Qty v={bal} uom="KG" dp={3} /> : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <button className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide' : 'Show'} {ineligible.length} roll(s) that are not eligible</button>
        {showAll && (
          <table className="w-full border text-slate-500" id="alloc-ineligible">
            <thead className="bg-slate-50 text-left"><tr><th className="p-1.5">Roll</th><th className="p-1.5">Job</th><th className="p-1.5">Shade / Lot</th><th className="p-1.5 text-right">Free KG</th><th className="p-1.5">Why not</th></tr></thead>
            <tbody>{ineligible.map((r) => <tr key={r.id} className="border-t"><td className="p-1.5 font-mono">{r.roll_no}</td><td className="p-1.5">{r.roll_job || 'general'}</td><td className="p-1.5">{r.shade || '—'} / {r.lot_no || '—'}</td>
              <td className="p-1.5 text-right"><Qty v={r.available_kg} uom="KG" dp={2} /></td><td className="p-1.5 text-red-700">{r.reasons.join('; ')}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ cutting DC (doc §11) */

function IssueModal({ lay, onClose, onSaved }: { lay: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ issue_date: today(), from_location: 'FABRIC STORE', to_location: 'CUTTING', remarks: '' });
  const [allocs, setAllocs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/lay-plans/${lay.id}/allocations`).then((r) => setAllocs((r.data.data || []).filter((a: any) => a.status === 'RESERVED'))); }, [lay.id]);
  const go = async () => {
    setBusy(true);
    try { const r = await api.post(`/lay-plans/${lay.id}/issue`, f); toast(`Cutting DC ${r.data.data.issue_no} issued — ${r.data.data.rolls} roll(s), ${fmtNumber(r.data.data.total_kg, 3)} KG`); onSaved(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Issue fabric to cutting — lay ${lay.lay_no}`} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button id="issue-go" loading={busy} onClick={go}>Issue (cutting DC)</Button></>}>
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Input label="Issue date" type="date" value={f.issue_date} onChange={(e) => setF({ ...f, issue_date: e.target.value })} />
          <Input label="From" value={f.from_location} onChange={(e) => setF({ ...f, from_location: e.target.value })} />
          <Input label="To" value={f.to_location} onChange={(e) => setF({ ...f, to_location: e.target.value })} />
        </div>
        <table className="w-full border"><thead className="bg-slate-50 text-left"><tr><th className="p-1.5">Roll</th><th className="p-1.5">Shade / Lot</th><th className="p-1.5">Store</th><th className="p-1.5 text-right">Issue KG</th><th className="p-1.5 text-right">Issue M</th><th className="p-1.5 text-right">Stays on roll</th></tr></thead>
          <tbody>{allocs.map((a) => <tr key={a.id} className="border-t"><td className="p-1.5 font-mono">{a.roll_no}</td><td className="p-1.5">{a.shade || '—'} / {a.lot_no || '—'}</td><td className="p-1.5">{a.warehouse_name}{a.location_bin ? ` · ${a.location_bin}` : ''}</td>
            <td className="p-1.5 text-right font-semibold"><Qty v={a.alloc_kg} uom="KG" dp={3} /></td><td className="p-1.5 text-right"><Qty v={a.alloc_m} uom="M" dp={1} /></td><td className="p-1.5 text-right"><Qty v={a.roll_balance_kg} uom="KG" dp={3} /></td></tr>)}</tbody>
          <tfoot><tr className="font-semibold"><td className="p-1.5" colSpan={3}>Total</td><td className="p-1.5 text-right"><Qty v={allocs.reduce((x, a) => x + n(a.alloc_kg), 0)} uom="KG" dp={3} /></td><td colSpan={2} /></tr></tfoot></table>
        <p className="text-slate-500">The reserved KG goes out on a cutting DC. A partly used roll keeps its balance in store; leftovers at cutting come back with a fabric return.</p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ spreading (doc §13) */

function FlowSpreadingModal({ lay, onClose, onSaved }: { lay: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [sp, setSp] = useState<any>(null);
  const [start, setStart] = useState<any>({ operator_name: lay.operator_name || '', table_no: lay.table_no || '' });
  const [rows, setRows] = useState<Record<number, any>>({});
  const [ply, setPly] = useState('');
  const [measured, setMeasured] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const loadSp = async () => {
    const r = await api.get('/spreading', { params: { lay_id: lay.id, status: 'IN_PROGRESS' } });
    const open = (r.data.data || [])[0];
    if (!open) { setSp(null); return; }
    const d = (await api.get(`/spreading/${open.id}`)).data.data;
    setSp(d);
    setPly(String(d.ply_planned ?? lay.ply_count));
    const perPly = d.rolls.length ? Math.floor(n(d.ply_planned) / d.rolls.length) : 0;
    setRows(Object.fromEntries(d.rolls.map((x: any, i: number) => [x.id, {
      plies: String(i === 0 ? n(d.ply_planned) - perPly * (d.rolls.length - 1) : perPly),
      actual_kg: String(x.planned_kg ?? ''), actual_m: x.planned_m != null ? String(x.planned_m) : '', end_loss_m: '', splice_loss_m: '' }])));
  };
  useEffect(() => { loadSp().catch((e) => toast(errMsg(e), 'error')); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lay.id]);
  const begin = async () => {
    setBusy(true);
    try { await api.post('/spreading', { lay_id: lay.id, ...start }); toast(`Spreading started for ${lay.lay_no}`); await loadSp(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const kg = Object.values(rows).reduce((a: number, x: any) => a + n(x.actual_kg), 0);
  const m = Object.values(rows).reduce((a: number, x: any) => a + n(x.actual_m), 0);
  const plies = Object.values(rows).reduce((a: number, x: any) => a + n(x.plies), 0);
  const plannedKg = n(sp?.planned_kg);
  const plyChanged = sp && n(ply) !== n(sp.ply_planned);
  const overFabric = plannedKg > 0 && kg > plannedKg * 1.0;
  const complete = async () => {
    setBusy(true);
    try {
      const r = await api.put(`/spreading/${sp.id}/complete`, {
        actual_ply: n(ply), measured_length_m: measured ? n(measured) : undefined, variance_reason: reason || null,
        rolls: sp.rolls.map((x: any) => ({ id: x.id, plies: n(rows[x.id]?.plies), actual_kg: n(rows[x.id]?.actual_kg), actual_m: rows[x.id]?.actual_m === '' ? null : n(rows[x.id]?.actual_m),
          end_loss_m: n(rows[x.id]?.end_loss_m), splice_loss_m: n(rows[x.id]?.splice_loss_m) })),
      });
      toast(`Spreading done — ${r.data.data.actual_ply} ply, ${fmtNumber(r.data.data.actual_kg, 3)} KG${r.data.data.variance ? ' (variance recorded)' : ''}. Lay is ready for cutting.`);
      onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Spreading — lay ${lay.lay_no}`} size="full"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button>{sp ? <Button id="sp-complete" loading={busy} onClick={complete}>Complete spreading</Button> : <Button id="sp-start" loading={busy} onClick={begin}>Start spreading</Button>}</>}>
      {!sp ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Input label="Operator" value={start.operator_name} onChange={(e) => setStart({ ...start, operator_name: e.target.value })} id="sp-operator" />
          <Input label="Table" value={start.table_no} onChange={(e) => setStart({ ...start, table_no: e.target.value })} />
          <p className="self-end text-xs text-slate-500">Starts the clock and loads the issued rolls with their planned length / KG.</p>
        </div>
      ) : (
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <MetricTile label="Spreading" value={sp.spreading_no} sub={`started ${fmtDateTime(sp.start_time)}`} />
            <MetricTile label="Planned ply" value={sp.ply_planned} uom="PLY" tone="indigo" />
            <MetricTile label="Planned fabric" value={fmtNumber(sp.planned_kg, 3)} uom="KG" tone="indigo" sub={sp.planned_length_m ? `${fmtNumber(sp.planned_length_m, 2)} m` : undefined} />
            <MetricTile label="Actual fabric" value={fmtNumber(kg, 3)} uom="KG" tone={overFabric ? 'amber' : 'emerald'} sub={plannedKg ? `${kg - plannedKg >= 0 ? '+' : ''}${fmtNumber(kg - plannedKg, 3)} KG vs plan` : undefined} />
            <MetricTile label="Actual length" value={fmtNumber(m, 2)} uom="M" />
            <MetricTile label="Roll plies" value={plies} uom="PLY" tone={plies && plies !== n(ply) ? 'red' : 'slate'} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <UomInput label="Actual ply" uom="PLY" value={ply} step="1" min={1} onChange={setPly} />
            <UomInput label="Measured lay length" uom="M" value={measured} onChange={setMeasured} />
            <Input className="md:col-span-2" label={`Variance reason${plyChanged || overFabric ? ' *' : ''}`} value={reason} onChange={(e) => setReason(e.target.value)} id="sp-reason"
              hint={plyChanged ? `Ply ${ply} differs from the planned ${sp.ply_planned}` : overFabric ? 'Fabric is over the plan' : 'Only when the ply or fabric differs from the plan'} />
          </div>
          <table className="w-full border" id="sp-rolls">
            <thead className="bg-slate-50 text-left text-slate-600"><tr><th className="p-1.5">Roll</th><th className="p-1.5 text-right">Planned KG</th><th className="p-1.5 text-right">Planned M</th>
              <th className="p-1.5 w-24">Plies</th><th className="p-1.5 w-32">Actual KG</th><th className="p-1.5 w-32">Actual M</th><th className="p-1.5 w-28">End loss M</th><th className="p-1.5 w-28">Splice loss M</th></tr></thead>
            <tbody>{sp.rolls.map((x: any) => {
              const v = rows[x.id] || {};
              const set = (k: string, val: string) => setRows({ ...rows, [x.id]: { ...v, [k]: val } });
              return (
                <tr key={x.id} className="border-t">
                  <td className="p-1.5 font-mono font-semibold">{x.roll_no} <span className="font-normal text-slate-400">{x.shade || ''} {x.lot_no || ''}</span></td>
                  <td className="p-1.5 text-right"><Qty v={x.planned_kg} uom="KG" dp={3} /></td><td className="p-1.5 text-right"><Qty v={x.planned_m} uom="M" dp={1} /></td>
                  <td className="p-1"><UomInput uom="PLY" value={v.plies ?? ''} step="1" min={0} onChange={(val) => set('plies', val)} /></td>
                  <td className="p-1"><UomInput uom="KG" value={v.actual_kg ?? ''} min={0} onChange={(val) => set('actual_kg', val)} /></td>
                  <td className="p-1"><UomInput uom="M" value={v.actual_m ?? ''} min={0} onChange={(val) => set('actual_m', val)} /></td>
                  <td className="p-1"><UomInput uom="M" value={v.end_loss_m ?? ''} min={0} onChange={(val) => set('end_loss_m', val)} /></td>
                  <td className="p-1"><UomInput uom="M" value={v.splice_loss_m ?? ''} min={0} onChange={(val) => set('splice_loss_m', val)} /></td>
                </tr>
              );
            })}</tbody>
          </table>
          <p className="text-slate-500">Planned values come from the lay; key only what differs. Spreading records the actuals — stock is consumed when the lay is cut.</p>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ lay sheet (print) + genealogy */

function useGenealogy(layId: number) {
  const [g, setG] = useState<any>(null);
  useEffect(() => { api.get(`/lay-plans/${layId}/genealogy`).then((r) => setG(r.data.data)); }, [layId]);
  return g;
}

function LaySheetModal({ lay, onClose }: { lay: any; onClose: () => void }) {
  const g = useGenealogy(lay.id);
  const print = () => {
    const el = document.getElementById('lay-sheet-print');
    if (!el) return;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    w.document.write(`<html><head><title>Lay sheet ${lay.lay_no}</title><style>body{font-family:Arial,sans-serif;font-size:12px;margin:18px}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #999;padding:4px 6px;text-align:left}th{background:#eee}.r{text-align:right}h2{margin:0 0 6px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px 12px}.sig{display:flex;justify-content:space-between;margin-top:40px}</style></head><body>${el.innerHTML}</body></html>`);
    w.document.close(); w.focus(); w.print();
  };
  const l = g?.lay; const mk = g?.marker;
  const out = l?.size_output || {};
  return (
    <Modal open onClose={onClose} title={`Lay sheet — ${lay.lay_no}`} size="xl"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button id="sheet-print" onClick={print} disabled={!g}>Print lay sheet</Button></>}>
      {!g ? <p className="text-xs text-slate-500">Loading…</p> : (
        <div id="lay-sheet-print" className="text-xs">
          <h2 className="text-base font-bold">LAY SHEET — {l.lay_no}</h2>
          <div className="grid grid-cols-4 gap-x-4 gap-y-1">
            <div>Job: <b>{g.job.io_no}</b></div><div>Buyer: <b>{g.job.buyer_name || '—'}</b></div><div>Buyer PO: <b>{g.job.buyer_po_no || '—'}</b></div><div>Cut order: <b>{g.cutting_plan.plan_no}</b></div>
            <div>Style: <b>{g.cutting_plan.style_code}</b></div><div>Colour: <b>{g.cutting_plan.color_name || '—'}</b></div><div>Fabric: <b>{g.cutting_plan.fabric_name || '—'}</b></div><div>Date: <b>{fmtDate(l.lay_date)}</b></div>
            <div>Marker: <b>{mk ? `${mk.marker_no} v${mk.version}` : l.marker_ref}</b></div><div>Ratio: <b>{mk ? ratioText(mk.sizes, mk.ratios) : '—'}</b></div>
            <div>Marker length: <b>{mk?.length_m ?? l.marker_length_m ?? '—'} m</b></div><div>Width: <b>{mk?.width_in ?? '—'}"</b></div>
            <div>Ply: <b>{l.ply_count}</b></div><div>Output: <b>{l.expected_pieces} PCS</b></div><div>Fabric: <b>{l.planned_kg ?? '—'} KG · {l.planned_length_m ?? '—'} m</b></div><div>Table: <b>{l.table_no || '—'}</b></div>
          </div>
          <table className="mt-2 w-full border"><thead><tr>{Object.keys(out).map((k) => <th key={k} className="border p-1">{k}</th>)}<th className="border p-1">Total</th></tr></thead>
            <tbody><tr>{Object.values(out).map((v: any, i) => <td key={i} className="border p-1 text-right">{v}</td>)}<td className="border p-1 text-right font-bold">{Object.values(out).reduce((a: number, v: any) => a + n(v), 0)}</td></tr></tbody></table>
          <table className="mt-2 w-full border"><thead><tr><th className="border p-1">#</th><th className="border p-1">Roll</th><th className="border p-1">Shade / Lot</th><th className="border p-1">GRN</th><th className="border p-1 text-right">KG</th><th className="border p-1 text-right">M</th><th className="border p-1">Plies (actual)</th><th className="border p-1">End / splice loss</th></tr></thead>
            <tbody>{g.allocations.filter((a: any) => a.status !== 'RELEASED').map((a: any, i: number) => <tr key={a.id}><td className="border p-1">{i + 1}</td><td className="border p-1 font-mono">{a.roll_no}</td><td className="border p-1">{a.shade || '—'} / {a.lot_no || '—'}</td><td className="border p-1">{a.grn_no || '—'}</td>
              <td className="border p-1 text-right">{n(a.alloc_kg).toFixed(3)}</td><td className="border p-1 text-right">{a.alloc_m ?? ''}</td><td className="border p-1"></td><td className="border p-1"></td></tr>)}</tbody></table>
          <div className="mt-10 flex justify-between"><span>Spread by ____________</span><span>Cut by ____________</span><span>Supervisor ____________</span></div>
        </div>
      )}
    </Modal>
  );
}

function GenealogyModal({ lay, onClose }: { lay: any; onClose: () => void }) {
  const g = useGenealogy(lay.id);
  const Step = ({ title, children }: { title: string; children: any }) => (
    <div className="border-l-2 border-indigo-300 pb-3 pl-4"><p className="-ml-[23px] mb-1 flex items-center gap-2 text-xs font-bold text-indigo-800"><span className="h-3 w-3 rounded-full bg-indigo-400" />{title}</p><div className="text-xs text-slate-700">{children}</div></div>
  );
  return (
    <Modal open onClose={onClose} title={`Genealogy — lay ${lay.lay_no}`} size="xl">
      {!g ? <p className="text-xs text-slate-500">Loading…</p> : (
        <div id="lay-genealogy" className="pl-2">
          <Step title="Job">{g.job.io_no} · {g.job.so_no} · {g.job.buyer_name || '—'} · PO {g.job.buyer_po_no || '—'}</Step>
          <Step title="Cutting plan">{g.cutting_plan.plan_no} · {g.cutting_plan.style_code} · {g.cutting_plan.color_name || '—'} · {g.cutting_plan.fabric_name || '—'} · order {g.cutting_plan.order_qty} · cut {g.cutting_plan.actual_cut_qty}</Step>
          <Step title="CAD marker version">{g.marker ? <>{g.marker.marker_no} v{g.marker.version} · {g.marker.status}{g.marker.is_locked ? ' · locked' : ''} · {ratioText(g.marker.sizes, g.marker.ratios)}{g.cad ? ` · CAD ${g.cad.req_no}` : ''}</> : '—'}</Step>
          <Step title="Lay">{g.lay.lay_no} · {flowLabel(g.lay.status)} · {g.lay.ply_count} ply planned{g.lay.actual_ply ? ` · ${g.lay.actual_ply} actual` : ''} · {g.lay.expected_pieces} PCS</Step>
          <Step title="Fabric rolls (reserved / issued)">{g.allocations.length ? g.allocations.map((a: any) => <div key={a.id}><span className="font-mono">{a.roll_no}</span> · {a.shade || '—'}/{a.lot_no || '—'} · {n(a.alloc_kg).toFixed(3)} KG · {a.status} · GRN {a.grn_no || '—'}</div>) : '—'}</Step>
          <Step title="Cutting DC">{g.fabric_issue ? `${g.fabric_issue.issue_no} · ${g.fabric_issue.status}${g.fabric_issue.received_at ? ` · received ${fmtDateTime(g.fabric_issue.received_at)}` : ''}` : '—'}</Step>
          <Step title="Spreading">{g.spreading.length ? g.spreading.map((s: any) => <div key={s.id}>{s.spreading_no} · {s.status} · {s.ply_count} ply · {s.actual_kg ?? '—'} KG · end {s.end_loss_m ?? 0} m · splice {s.splice_loss_m ?? 0} m</div>) : '—'}</Step>
          <Step title="Cutting">{g.cutting.length ? g.cutting.map((c: any) => <div key={c.id}>{c.cut_no} · {c.total_pieces} PCS · {c.fabric_used_kg} KG</div>) : '—'}{g.outputs.length > 0 && <div className="mt-1">{g.outputs.map((o: any) => `${o.size_code}: ${o.good_qty}${o.reject_qty ? ` (+${o.reject_qty} rej)` : ''}`).join(' · ')}</div>}</Step>
          <Step title="Bundles → sewing">{g.bundles.length ? <>{g.totals.bundles} bundles · {g.totals.bundle_qty} PCS · {g.totals.in_sewing_or_beyond} moved on the floor<div className="mt-1 flex flex-wrap gap-1">{g.bundles.slice(0, 40).map((b: any) => <span key={b.id} className="rounded bg-slate-100 px-1 font-mono">{b.bundle_no}</span>)}</div></> : '—'}</Step>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ planned vs actual (doc §22) */

export function PlannedVsActual({ planId }: { planId: string }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { if (planId) api.get(`/cutting-plans/${planId}/planned-vs-actual`).then((r) => setD(r.data.data)); }, [planId]);
  if (!d || !d.lays.length) return null;
  const pa = (x: { planned: any; actual: any }, dp = 0, uom = '') => (
    <span className="whitespace-nowrap">{x.planned != null ? fmtNumber(x.planned, dp) : '—'} <span className="text-slate-400">/</span> <b className={x.actual != null && x.planned != null && n(x.actual) !== n(x.planned) ? 'text-amber-700' : 'text-emerald-700'}>{x.actual != null ? fmtNumber(x.actual, dp) : '—'}</b>{uom ? <span className="text-[10px] text-slate-400"> {uom}</span> : null}</span>
  );
  return (
    <Card title="Planned vs actual (CAD plan / actual)" subtitle={d.notes}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" id="lp-pva">
          <thead className="border-b bg-slate-50 text-left text-slate-600"><tr><th className="p-2">Lay</th><th className="p-2">Status</th><th className="p-2">Garment qty</th><th className="p-2">Marker length</th><th className="p-2">Ply</th>
            <th className="p-2">Fabric M</th><th className="p-2">Fabric KG</th><th className="p-2">Waste KG</th><th className="p-2">Efficiency %</th><th className="p-2">Variance reason</th></tr></thead>
          <tbody>{d.lays.map((l: any) => (
            <tr key={l.lay_id} className="border-b"><td className="p-2 font-mono">{l.lay_no}</td><td className="p-2"><FlowChip status={l.status} /></td>
              <td className="p-2">{pa(l.garment_qty, 0, 'PCS')}</td><td className="p-2">{pa(l.marker_length_m, 3, 'm')}</td><td className="p-2">{pa(l.ply)}</td>
              <td className="p-2">{pa(l.fabric_m, 2, 'm')}</td><td className="p-2">{pa(l.fabric_kg, 3, 'KG')}</td>
              <td className="p-2">{pa(l.waste_kg, 3, 'KG')}{l.waste_kg.recorded_losses ? <div className="text-[10px] text-slate-500">recorded loss {l.waste_kg.recorded_losses} KG</div> : null}</td>
              <td className="p-2">{pa(l.efficiency_pct, 2)}</td><td className="p-2 text-slate-600">{l.variance_reason || ''}</td></tr>
          ))}</tbody>
          <tfoot><tr className="font-semibold"><td className="p-2" colSpan={2}>Total</td><td className="p-2">{pa({ planned: d.totals.garment_planned, actual: d.totals.garment_actual })}</td><td />
            <td className="p-2">{pa({ planned: d.totals.ply_planned, actual: d.totals.ply_actual })}</td><td className="p-2">{pa({ planned: d.totals.fabric_m_planned, actual: d.totals.fabric_m_actual }, 2)}</td>
            <td className="p-2">{pa({ planned: d.totals.fabric_kg_planned, actual: d.totals.fabric_kg_actual }, 3)}</td><td className="p-2">{pa({ planned: d.totals.waste_kg_planned, actual: d.totals.waste_kg_actual }, 3)}</td><td colSpan={2} /></tr></tfoot>
        </table>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ dashboard (doc §25) */

export function CuttingDashboard() {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api.get('/cutting-dashboard').then((r) => setD(r.data.data)); }, []);
  if (!d) return <p className="text-xs text-slate-500">Loading…</p>;
  const t = d.tiles;
  return (
    <div className="space-y-4" id="cut-dashboard">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <MetricTile label="Cutting plans pending" value={t.cutting_plans_pending.count} sub={`${fmtNumber(t.cutting_plans_pending.pcs)} PCS to cut`} />
        <MetricTile label="CAD approval pending" value={t.cad_approval_pending.count} tone={t.cad_approval_pending.count ? 'amber' : 'slate'} />
        <MetricTile label="Lay plans pending" value={t.lay_plans_pending.count} />
        <MetricTile label="Roll reservation pending" value={t.roll_reservation_pending.count} />
        <MetricTile label="Lay approval pending" value={t.lay_approval_pending.count} />
        <MetricTile label="Fabric issue pending" value={t.fabric_issue_pending.count} />
        <MetricTile label="Cutting receive pending" value={t.cutting_receive_pending.count} />
        <MetricTile label="Spreading in progress" value={t.spreading_in_progress.count} tone="amber" />
        <MetricTile label="Cutting in progress" value={t.cutting_in_progress.count} tone="amber" />
        <MetricTile label="Bundles ready for sewing" value={t.bundles_ready_for_sewing.count} sub={`${fmtNumber(t.bundles_ready_for_sewing.pcs)} PCS`} tone="emerald" />
        <MetricTile label="Fabric planned vs actual" value={`${fmtNumber(t.fabric_planned_vs_actual.planned_kg, 1)} / ${fmtNumber(t.fabric_planned_vs_actual.actual_kg, 1)}`} uom="KG"
          sub={t.fabric_planned_vs_actual.variance_pct != null ? `${t.fabric_planned_vs_actual.variance_pct}% variance` : undefined} tone={n(t.fabric_planned_vs_actual.variance_pct) > 0 ? 'amber' : 'emerald'} />
        <MetricTile label="Roll balance pending return" value={t.roll_balance_pending_return.rolls} sub={`${fmtNumber(t.roll_balance_pending_return.kg, 2)} KG with cutting`} tone={t.roll_balance_pending_return.rolls ? 'amber' : 'slate'} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Waste / end loss / splice loss">
          <div className="space-y-1 p-4 text-xs">
            {t.waste.by_type.map((w: any) => <div key={w.loss_type} className="flex justify-between"><span>{w.loss_type.replace(/_/g, ' ')}</span><Qty v={w.kg} uom="KG" dp={3} /></div>)}
            <div className="flex justify-between border-t pt-1"><span>Spreading end loss</span><Qty v={t.waste.end_loss_m} uom="M" dp={2} /></div>
            <div className="flex justify-between"><span>Spreading splice loss</span><Qty v={t.waste.splice_loss_m} uom="M" dp={2} /></div>
          </div>
        </Card>
        <Card title="Lays by status">
          <div className="space-y-1 p-4 text-xs">{d.lay_status.map((s: any) => <div key={s.status} className="flex justify-between"><FlowChip status={s.status} /><span>{s.count} lay(s) · {fmtNumber(s.pcs)} PCS</span></div>)}</div>
        </Card>
        <Card title="Pending lays">
          <div className="max-h-64 space-y-1 overflow-y-auto p-4 text-xs">{d.pending_lays.map((l: any) => <div key={l.id} className="flex justify-between gap-2"><span className="font-mono">{l.lay_no}</span><span className="truncate">{l.plan_no} · {l.io_no}</span><FlowChip status={l.status} /></div>)}
            {!d.pending_lays.length && <p className="text-slate-400">None.</p>}</div>
        </Card>
      </div>
      <Card title="Size-wise cut balance (open cut orders)">
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-xs"><thead className="sticky top-0 border-b bg-slate-50 text-left"><tr><th className="p-1.5">Cut order</th><th className="p-1.5">Job</th><th className="p-1.5">Style</th><th className="p-1.5">Colour</th><th className="p-1.5">Size</th><th className="p-1.5 text-right">Target</th><th className="p-1.5 text-right">Cut</th><th className="p-1.5 text-right">Balance</th></tr></thead>
            <tbody>{d.size_balance.map((x: any, i: number) => <tr key={i} className="border-b"><td className="p-1.5 font-mono">{x.plan_no}</td><td className="p-1.5">{x.io_no}</td><td className="p-1.5">{x.style_code}</td><td className="p-1.5">{x.color_name || '—'}</td><td className="p-1.5 font-semibold">{x.size_code}</td>
              <td className="p-1.5 text-right">{fmtNumber(x.target)}</td><td className="p-1.5 text-right">{fmtNumber(x.cut)}</td><td className={`p-1.5 text-right font-semibold ${x.balance < 0 ? 'text-red-600' : 'text-indigo-700'}`}>{fmtNumber(x.balance)}</td></tr>)}</tbody></table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ cutting tables */

export function CuttingTables() {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState<any>(null);
  const load = () => api.get('/cutting-tables').then((r) => setRows(r.data.data || []));
  useEffect(() => { load(); }, []);
  const save = async () => {
    try {
      const body = { ...f, length_m: f.length_m ? Number(f.length_m) : null, width_in: f.width_in ? Number(f.width_in) : null, max_ply: Number(f.max_ply), min_ply: Number(f.min_ply) || 1 };
      if (f.id) await api.put(`/cutting-tables/${f.id}`, body); else await api.post('/cutting-tables', body);
      toast('Cutting table saved'); setF(null); load();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  return (
    <Card title="Cutting tables" subtitle="Max / min ply and the longest marker a table takes — the lay engine splits plies by the table's max ply." actions={<Button size="sm" id="tbl-new" onClick={() => setF({ table_code: '', table_name: '', length_m: '', width_in: '', max_ply: 60, min_ply: 1, is_active: true })}>+ Table</Button>}>
      <table className="w-full text-xs" id="tbl-list">
        <thead className="border-b bg-slate-50 text-left"><tr><th className="p-2">Code</th><th className="p-2">Name</th><th className="p-2 text-right">Length</th><th className="p-2 text-right">Width</th><th className="p-2 text-right">Max ply</th><th className="p-2 text-right">Min ply</th><th className="p-2">Active</th><th /></tr></thead>
        <tbody>{rows.map((t) => <tr key={t.id} className="border-b"><td className="p-2 font-semibold">{t.table_code}</td><td className="p-2">{t.table_name}</td><td className="p-2 text-right"><Qty v={t.length_m} uom="M" dp={2} /></td>
          <td className="p-2 text-right"><Qty v={t.width_in} uom="IN" dp={1} /></td><td className="p-2 text-right">{t.max_ply}</td><td className="p-2 text-right">{t.min_ply}</td><td className="p-2">{t.is_active ? 'Yes' : 'No'}</td>
          <td className="p-2 text-right"><Button size="sm" variant="ghost" onClick={() => setF({ ...t, is_active: !!t.is_active })}>Edit</Button></td></tr>)}
          {!rows.length && <tr><td colSpan={8} className="p-3 text-center text-slate-400">No tables — the default max ply (Admin › Settings › CUT_MAX_PLY) is used.</td></tr>}</tbody>
      </table>
      {f && (
        <Modal open onClose={() => setF(null)} title={f.id ? `Table ${f.table_code}` : 'New cutting table'} size="md" footer={<><Button variant="ghost" onClick={() => setF(null)}>Cancel</Button><Button id="tbl-save" onClick={save}>Save</Button></>}>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Code" value={f.table_code} onChange={(e) => setF({ ...f, table_code: e.target.value })} id="tbl-code" />
            <Input label="Name" value={f.table_name || ''} onChange={(e) => setF({ ...f, table_name: e.target.value })} />
            <UomInput label="Length" uom="M" value={f.length_m ?? ''} onChange={(v) => setF({ ...f, length_m: v })} />
            <UomInput label="Width" uom="IN" value={f.width_in ?? ''} onChange={(v) => setF({ ...f, width_in: v })} />
            <UomInput label="Max ply" uom="PLY" value={f.max_ply} step="1" onChange={(v) => setF({ ...f, max_ply: v })} />
            <UomInput label="Min ply" uom="PLY" value={f.min_ply} step="1" onChange={(v) => setF({ ...f, min_ply: v })} />
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active</label>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ CAD marker import (doc §4.1 phase 1) */

const IMPORT_FIELDS = ['marker_no', 'marker_version', 'job_no', 'po_no', 'style_no', 'colour', 'fabric', 'fabric_width', 'marker_length_m', 'efficiency_pct', 'pieces_per_marker', 'size_ratio', 'size_quantities', 'gsm', 'cad_file', 'cad_source'];

export function MarkerImportCard({ onImported }: { onImported: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [file, setFile] = useState<{ name: string; url?: string } | null>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (fl: File | null) => {
    setResult(null); setRows([]);
    if (!fl) return;
    try {
      const XLSX = await import('xlsx');
      const buf = await fl.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
      setRows(data);
      // keep the original CAD export for audit (doc §4.1)
      const dataUri: string = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(fl); });
      const up = await api.post('/uploads', { filename: fl.name, data: dataUri, folder: 'cad' }).catch(() => null);
      setFile({ name: fl.name, url: up?.data?.data?.url });
      toast(`${data.length} row(s) read from ${fl.name}`);
    } catch (e) { toast(errMsg(e, 'Could not read the file'), 'error'); }
  };
  const run = async (dry: boolean) => {
    if (!rows.length) return toast('Choose the CAD export (CSV / Excel) first', 'error');
    setBusy(true);
    try {
      const r = await api.post('/cad-markers/import', { rows, file_name: file?.name, file_url: file?.url, dry_run: dry });
      setResult(r.data.data);
      toast(dry ? `${r.data.data.valid} valid · ${r.data.data.errors} with errors · ${r.data.data.duplicates} already imported` : `${r.data.data.imported} marker version(s) imported`);
      if (!dry) onImported();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const template = () => {
    const csv = `${IMPORT_FIELDS.join(',')}\nM-001,V1,IO-26001,PO-1234,ST-2601,Black,Single Jersey 180,60,8.25,84.5,12,S2/M4/L4/XL2,S10/M20/L20/XL10,180,marker_m001.plx,GERBER\n`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'cad_marker_import_template.csv'; a.click();
  };
  return (
    <Card title="Import CAD markers (CSV / Excel)" subtitle="Approved CAD output comes in without re-keying. Columns: marker_no, marker_version, job_no, po_no, style_no, colour, fabric, fabric_width, marker_length_m, efficiency_pct, pieces_per_marker, size_ratio (S2/M4/L4/XL2, or 86/92:2, 98/104:4 when sizes contain a slash), size_quantities, gsm, cad_file, cad_source">
      <div className="flex flex-wrap items-end gap-3 p-4">
        <label className="text-xs"><span className="label">CAD export file</span><input type="file" accept=".csv,.xlsx,.xls,.xml" id="mi-file" onChange={(e) => onFile(e.target.files?.[0] ?? null)} /></label>
        <Button variant="outline" size="sm" onClick={template}>Download template</Button>
        <Button variant="outline" size="sm" id="mi-validate" loading={busy} disabled={!rows.length} onClick={() => run(true)}>Validate</Button>
        <Button size="sm" id="mi-import" loading={busy} disabled={!rows.length} onClick={() => run(false)}>Import</Button>
        {file && <span className="text-xs text-slate-500">{file.name} · {rows.length} row(s){file.url ? ' · original stored' : ''}</span>}
      </div>
      {result && (
        <div className="px-4 pb-4">
          <table className="w-full border text-xs" id="mi-result">
            <thead className="bg-slate-50 text-left"><tr><th className="p-1.5">Row</th><th className="p-1.5">Marker</th><th className="p-1.5">Result</th><th className="p-1.5">Detail</th></tr></thead>
            <tbody>{result.rows.map((x: any) => <tr key={x.row} className="border-t"><td className="p-1.5">{x.row}</td><td className="p-1.5 font-mono">{x.marker_no}</td>
              <td className="p-1.5"><Badge color={x.status === 'ERROR' ? 'red' : x.status === 'DUPLICATE' ? 'amber' : 'emerald'}>{x.status}</Badge></td>
              <td className="p-1.5">{x.errors?.join('; ') || x.message || (x.version ? `v${x.version}` : '') || (x.kg_per_ply ? `${x.kg_per_ply} KG/ply` : '')}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
