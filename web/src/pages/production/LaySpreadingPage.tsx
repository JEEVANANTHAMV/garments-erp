import { useState, useEffect, useMemo } from 'react';
import { Card, Button, Input, DataTable, Textarea, Modal, Tabs, Checkbox, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNumber, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { SearchSelect, ScanInput, StatusChip, Qty, UomInput, MetricTile, errMsg } from './cuttingUi';

const LOSS_TYPES = [
  { value: 'CUTTING_WASTE', label: 'Cutting / marker waste' },
  { value: 'END_LOSS', label: 'End loss' },
  { value: 'SELVEDGE_LOSS', label: 'Selvedge loss' },
  { value: 'REMNANT', label: 'Remnant' },
  { value: 'OTHER', label: 'Other approved loss' },
];

/**
 * Lay Plan & Lay Execution (doc §7–§10).
 *   Plan:     cut order + marker version + ply → expected PCS, planned KG
 *   Execute:  roll-wise before/after KG (actual consumption), losses,
 *             size-wise good / reject / re-cut output
 */
export function LaySpreadingPage() {
  const toast = useToast();
  const [tab, setTab] = useState('lays');
  const [lays, setLays] = useState<any[]>([]);
  const [plans, setPlans] = useState<any[]>([]);
  const [planFilter, setPlanFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [execLay, setExecLay] = useState<any>(null);
  const [spreadLay, setSpreadLay] = useState<any>(null);
  const [viewLay, setViewLay] = useState<any>(null);
  const [cancelLay, setCancelLay] = useState<any>(null);

  const fetchLays = () => {
    setLoading(true);
    api.get('/lay-plans', { params: planFilter ? { cutting_plan_id: planFilter } : {} })
      .then(r => setLays(r.data.data || [])).finally(() => setLoading(false));
  };
  useEffect(() => { api.get('/cutting-plans').then(r => setPlans(r.data.data || [])); }, []);
  useEffect(fetchLays, [planFilter]);

  const approve = async (lay: any) => {
    try { await api.post(`/lay-plans/${lay.id}/approve`, {}); toast(`Lay ${lay.lay_no} approved`); fetchLays(); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  const openView = (lay: any) => api.get(`/lay-plans/${lay.id}`).then(r => setViewLay(r.data.data));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Lay Plan & Lay Execution</h1>
          <p className="text-sm text-slate-500">Marker version × ply → expected PCS and planned KG; execution records roll-wise actual consumption and size-wise cut output.</p>
        </div>
        <Button onClick={() => setShowNew(true)}>+ New Lay Plan</Button>
      </div>

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'lays', label: 'Lays', count: lays.length },
        { key: 'markers', label: 'Marker Versions' },
      ]} />

      {tab === 'lays' && (
        <Card>
          <div className="flex flex-wrap items-end gap-3 border-b bg-slate-50 p-3">
            <SearchSelect className="w-80" label="Cut order" value={planFilter} onChange={setPlanFilter}
              placeholder="All cut orders"
              options={plans.map(p => ({ value: p.id, label: `${p.plan_no} · ${p.io_no} · ${p.style_code || ''}`, right: p.status }))} />
          </div>
          <DataTable
            data={lays}
            loading={loading}
            columns={[
              { key: 'lay_no', header: 'Lay No', sortable: true, render: (r: any) => (
                <button className="font-mono text-xs font-semibold text-brand-700 hover:underline" onClick={() => openView(r)}>{r.lay_no}</button>) },
              { key: 'lay_date', header: 'Date', render: (r: any) => fmtDate(r.lay_date) },
              { key: 'plan_no', header: 'Cut Order', render: (r: any) => <span className="font-mono text-xs">{r.plan_no}</span> },
              { key: 'marker', header: 'Marker', render: (r: any) => r.marker_no
                ? <span className="text-xs">{r.marker_no} <b>v{r.marker_version}</b>{r.marker_locked ? ' 🔒' : ''}</span>
                : <span className="text-xs text-slate-400">{r.marker_ref || '—'}</span> },
              { key: 'ply_count', header: 'Ply', align: 'right' as const },
              { key: 'expected_pieces', header: 'Expected', align: 'right' as const, render: (r: any) => <Qty v={r.expected_pieces} uom="PCS" /> },
              { key: 'actual_cut_qty', header: 'Good Cut', align: 'right' as const, render: (r: any) => <Qty v={r.actual_cut_qty} uom="PCS" className="font-semibold" /> },
              { key: 'planned_kg', header: 'Planned', align: 'right' as const, render: (r: any) => <Qty v={r.planned_kg} uom="KG" dp={3} /> },
              { key: 'actual_kg', header: 'Actual', align: 'right' as const, render: (r: any) => {
                const over = Number(r.planned_kg) > 0 && Number(r.actual_kg) > Number(r.planned_kg);
                return <Qty v={r.actual_kg} uom="KG" dp={3} className={over ? 'font-semibold text-red-600' : 'font-semibold text-emerald-700'} />;
              } },
              { key: 'actual_kg_per_pc', header: 'Actual KG/PC', align: 'right' as const, render: (r: any) => <Qty v={r.actual_kg_per_pc} uom="KG/PC" dp={4} /> },
              { key: 'status', header: 'Status', render: (r: any) => <StatusChip status={r.status} /> },
              { key: 'actions', header: '', align: 'right' as const, render: (r: any) => (
                <div className="flex justify-end gap-1">
                  {['PLANNED', 'SPREAD'].includes(r.status) && <>
                    <Button size="sm" variant="outline" onClick={() => setSpreadLay(r)}>Spreading</Button>
                    <Button size="sm" onClick={() => setExecLay(r)}>Execute</Button>
                  </>}
                  {r.status === 'CUT' && <Button size="sm" variant="outline" onClick={() => approve(r)}>Approve</Button>}
                  {r.status !== 'CANCELLED' && !['CLOSED', 'CANCELLED'].includes(r.plan_status) && (
                    <Button size="sm" variant="ghost" onClick={() => setCancelLay(r)}>{['CUT', 'APPROVED'].includes(r.status) ? 'Reverse' : 'Cancel'}</Button>
                  )}
                </div>
              ) },
            ]}
          />
        </Card>
      )}

      {tab === 'markers' && <MarkerVersions />}

      {showNew && <NewLayModal plans={plans} onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); fetchLays(); }} />}
      {execLay && <ExecuteModal lay={execLay} onClose={() => setExecLay(null)} onSaved={() => { setExecLay(null); fetchLays(); }} />}
      {spreadLay && <SpreadingModal lay={spreadLay} onClose={() => setSpreadLay(null)} onSaved={() => { setSpreadLay(null); fetchLays(); }} />}
      {viewLay && <LayDetailModal lay={viewLay} onClose={() => setViewLay(null)} />}
      {cancelLay && <CancelLayModal lay={cancelLay} onClose={() => setCancelLay(null)} onSaved={() => { setCancelLay(null); fetchLays(); }} />}
    </div>
  );
}

/* ------------------------------------------------------------------ new lay */
function NewLayModal({ plans, onClose, onSaved }: { plans: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ lay_date: today(), cutting_plan_id: '', marker_version_id: '', ply_count: '', table_no: '', operator_name: '', remarks: '' });
  const [markers, setMarkers] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setMarkers([]);
    if (f.cutting_plan_id) api.get('/marker-versions', { params: { cutting_plan_id: f.cutting_plan_id } }).then(r => setMarkers(r.data.data || []));
  }, [f.cutting_plan_id]);
  const mv = markers.find(m => String(m.id) === String(f.marker_version_id));
  const ply = Number(f.ply_count) || 0;
  const expected = mv ? mv.pieces_per_marker * ply : 0;
  const plannedKg = mv?.marker_kg_per_ply ? Number(mv.marker_kg_per_ply) * ply : null;
  const plan = plans.find(p => String(p.id) === String(f.cutting_plan_id));

  const save = async () => {
    if (!f.cutting_plan_id || !f.marker_version_id || ply <= 0) return toast('Cut order, marker version and ply are required', 'error');
    setSaving(true);
    try {
      await api.post('/lay-plans', { ...f, cutting_plan_id: Number(f.cutting_plan_id), marker_version_id: Number(f.marker_version_id), ply_count: ply });
      toast('Lay planned'); onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title="New Lay Plan" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={saving}>Create Lay</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SearchSelect label="Cut Order" required value={f.cutting_plan_id} onChange={v => setF({ ...f, cutting_plan_id: v, marker_version_id: '' })}
            options={plans.filter(p => !['CLOSED', 'CANCELLED'].includes(p.status)).map(p => ({ value: p.id, label: `${p.plan_no} · ${p.io_no} · ${p.style_code || ''}`, right: p.status }))} />
          <SearchSelect label="Marker / Version" required value={f.marker_version_id} onChange={v => setF({ ...f, marker_version_id: v })}
            placeholder={f.cutting_plan_id ? (markers.length ? 'Select marker version' : 'No marker versions — create one in Marker Versions') : 'Select a cut order first'}
            options={markers.map(m => ({ value: m.id, label: `${m.marker_no} v${m.version} · ${m.ratio_text}`, sub: `${m.pieces_per_marker} PCS/marker · ${m.length_m ?? '—'} M · ${m.marker_kg_per_ply ?? '—'} KG/ply${m.is_locked ? ' · locked' : ''}`, right: m.approved_at ? 'Approved' : '' }))} />
          <Input label="Lay Date" type="date" value={f.lay_date} onChange={e => setF({ ...f, lay_date: e.target.value })} />
          <UomInput label="Ply" uom="PLY" value={f.ply_count} step="1" min={1} onChange={v => setF({ ...f, ply_count: v })} />
          <Input label="Table No" value={f.table_no} onChange={e => setF({ ...f, table_no: e.target.value })} />
          <Input label="Operator" value={f.operator_name} onChange={e => setF({ ...f, operator_name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricTile label="Pieces / marker" value={mv ? mv.pieces_per_marker : '—'} uom="PCS" />
          <MetricTile label="Expected pieces" value={fmtNumber(expected)} uom="PCS" tone="indigo" sub="marker pieces × ply" />
          <MetricTile label="Planned fabric" value={plannedKg != null ? fmtNumber(plannedKg, 3) : '—'} uom="KG" tone="indigo" />
          <MetricTile label="Cut order balance" value={plan ? fmtNumber(plan.balance_qty) : '—'} uom="PCS" />
        </div>
        <Textarea label="Remarks" rows={2} value={f.remarks} onChange={e => setF({ ...f, remarks: e.target.value })} />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- execution */
function ExecuteModal({ lay, onClose, onSaved }: { lay: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [detail, setDetail] = useState<any>(null);
  const [dcRolls, setDcRolls] = useState<any[]>([]);
  const [sizes, setSizes] = useState<any[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [losses, setLosses] = useState<any[]>([]);
  const [outputs, setOutputs] = useState<Record<number, { good: string; reject: string; recut: string }>>({});
  const [ply, setPly] = useState<string>(String(lay.ply_count || ''));
  const [operator, setOperator] = useState(lay.operator_name || '');
  const [override, setOverride] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(`/lay-plans/${lay.id}`).then(r => setDetail(r.data.data));
    api.get(`/cutting-plans/${lay.cutting_plan_id}/dc-rolls`).then(r => setDcRolls(r.data.data || []));
    api.get(`/cutting-plans/${lay.cutting_plan_id}`).then(r => {
      const sz = r.data.data.sizes || [];
      setSizes(sz);
      setOutputs(Object.fromEntries(sz.map((s: any) => [s.size_id, { good: '', reject: '', recut: '' }])));
    });
  }, [lay.id, lay.cutting_plan_id]);

  const mv = detail?.marker_version;
  const plyN = Number(ply) || 0;
  const expected = mv ? mv.pieces_per_marker * plyN : Number(lay.expected_pieces) || 0;
  const plannedKg = mv?.marker_kg_per_ply ? Number(mv.marker_kg_per_ply) * plyN : Number(lay.planned_kg) || null;
  const actualKg = rolls.reduce((a, r) => a + Math.max(0, (Number(r.before_kg) || 0) - (Number(r.after_kg) || 0)), 0);
  const lossKg = losses.reduce((a, l) => a + (Number(l.qty_kg) || 0), 0);
  const good = Object.values(outputs).reduce((a, o) => a + (Number(o.good) || 0), 0);
  const rejects = Object.values(outputs).reduce((a, o) => a + (Number(o.reject) || 0), 0);
  const overExpected = expected > 0 && good > expected;

  const fillFromRatio = () => {
    if (!mv) return;
    const next: any = { ...outputs };
    for (const s of sizes) {
      const idx = (mv.sizes as string[]).findIndex(x => x.toUpperCase() === String(s.size_code).toUpperCase());
      if (idx >= 0) next[s.size_id] = { ...(next[s.size_id] || {}), good: String((mv.ratios[idx] || 0) * (mv.pieces_per_marker / mv.ratios.reduce((a: number, b: number) => a + b, 0)) * plyN) };
    }
    setOutputs(next);
  };

  const addRoll = (dc: any) => {
    if (!dc) return;
    if (dc.roll_status === 'CLOSED') return toast(`Roll ${dc.roll_no} is CLOSED on its DC`, 'error');
    if (rolls.some(r => r.fabric_issue_roll_id === dc.fabric_issue_roll_id)) return toast('Roll already in this lay', 'warning');
    setRolls(rs => [...rs, { fabric_issue_roll_id: dc.fabric_issue_roll_id, dc, before_kg: String(dc.remaining_kg), after_kg: '', plies: '', close_roll: false }]);
  };
  const onScan = (code: string) => {
    const dc = dcRolls.find(d => String(d.roll_no).toUpperCase() === code.toUpperCase() && d.roll_status !== 'CLOSED');
    if (!dc) return toast(`Roll ${code} is not an open DC roll of this cut order`, 'error');
    addRoll(dc);
  };

  const submit = async () => {
    if (!rolls.length) return toast('Add the rolls used in this lay', 'error');
    for (const r of rolls) {
      if (r.after_kg === '' || Number(r.after_kg) > Number(r.before_kg)) return toast(`Roll ${r.dc.roll_no}: enter remaining KG (cannot exceed weight before lay)`, 'error');
      if (Number(r.before_kg) > Number(r.dc.remaining_kg) + 0.0005) return toast(`Roll ${r.dc.roll_no}: weight before lay exceeds DC remaining ${r.dc.remaining_kg} KG`, 'error');
    }
    if (good <= 0) return toast('Enter size-wise good cut PCS', 'error');
    setSaving(true);
    try {
      await api.post(`/lay-plans/${lay.id}/execute`, {
        operator_name: operator || null, ply_count: plyN || undefined,
        rolls: rolls.map(r => ({ fabric_issue_roll_id: r.fabric_issue_roll_id, before_kg: Number(r.before_kg), after_kg: Number(r.after_kg), plies: Number(r.plies) || 0, close_roll: r.close_roll })),
        losses: losses.filter(l => Number(l.qty_kg) > 0).map(l => ({ loss_type: l.loss_type, qty_kg: Number(l.qty_kg), reason: l.reason || null })),
        outputs: Object.entries(outputs).filter(([, o]) => Number(o.good) > 0 || Number(o.reject) > 0 || Number(o.recut) > 0)
          .map(([sid, o]) => ({ size_id: Number(sid), good_qty: Number(o.good) || 0, reject_qty: Number(o.reject) || 0, recut_qty: Number(o.recut) || 0 })),
        override_reason: override || null,
      });
      toast(`Lay ${lay.lay_no} executed`); onSaved();
    } catch (e) { toast(errMsg(e, 'Execution failed'), 'error'); } finally { setSaving(false); }
  };

  const kgVar = plannedKg ? actualKg - plannedKg : null;
  return (
    <Modal open onClose={onClose} title={`Execute Lay ${lay.lay_no}`} size="full"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={saving}>Post Lay Execution</Button></>}>
      <div className="space-y-5">
        {/* Planned vs actual — kept at the top so the operator sees it while keying */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <MetricTile label="Marker" value={mv ? `${mv.marker_no} v${mv.version}` : (lay.marker_ref || '—')} sub={mv?.ratio_text} />
          <MetricTile label="Expected pieces" value={fmtNumber(expected)} uom="PCS" tone="indigo" />
          <MetricTile label="Good cut" value={fmtNumber(good)} uom="PCS" tone={overExpected ? 'red' : good ? 'emerald' : 'slate'} sub={rejects ? `${rejects} PCS reject` : undefined} />
          <MetricTile label="Planned fabric" value={plannedKg != null ? fmtNumber(plannedKg, 3) : '—'} uom="KG" tone="indigo" />
          <MetricTile label="Actual consumption" value={fmtNumber(actualKg, 3)} uom="KG" tone={kgVar != null && kgVar > 0 ? 'amber' : 'emerald'}
            sub={kgVar != null ? `${kgVar >= 0 ? '+' : ''}${fmtNumber(kgVar, 3)} KG vs plan` : undefined} />
          <MetricTile label="Actual KG / PC" value={good ? fmtNumber(actualKg / good, 4) : '—'} uom="KG/PC"
            sub={mv?.cad_kg_per_pc ? `Marker ${fmtNumber(mv.cad_kg_per_pc, 4)} KG/PC` : undefined} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <UomInput label="Actual ply" uom="PLY" value={ply} step="1" min={1} onChange={setPly} />
          <Input label="Operator" value={operator} onChange={e => setOperator(e.target.value)} />
          <SearchSelect className="md:col-span-1" label="Add DC roll" value="" onChange={v => addRoll(dcRolls.find(d => String(d.fabric_issue_roll_id) === v))}
            options={dcRolls.map(d => ({ value: d.fabric_issue_roll_id, label: `${d.roll_no} · Lot ${d.lot_no || '—'}`, sub: `DC ${d.issue_no} · ${d.roll_status}`, right: `${fmtNumber(d.remaining_kg, 3)} KG`, disabled: d.roll_status === 'CLOSED' }))} />
          <ScanInput label="Scan roll barcode" onScan={onScan} />
        </div>

        <section>
          <h4 className="mb-2 text-sm font-semibold text-slate-700">Roll-wise consumption <span className="font-normal text-slate-400">(Before − Remaining = Actual)</span></h4>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="border-b bg-slate-50 text-left text-slate-600">
                <tr><th className="p-2">Roll</th><th className="p-2 text-right">DC remaining</th><th className="p-2 w-36">Before lay (KG)</th>
                  <th className="p-2 w-36">Remaining after (KG)</th><th className="p-2 w-24">Plies</th><th className="p-2 text-right">Consumed</th>
                  <th className="p-2">Roll finished</th><th className="w-8" /></tr>
              </thead>
              <tbody>
                {rolls.length === 0 && <tr><td colSpan={8} className="p-3 text-center text-slate-400">Add or scan the rolls laid.</td></tr>}
                {rolls.map((r, i) => {
                  const c = (Number(r.before_kg) || 0) - (Number(r.after_kg) || 0);
                  const bad = r.after_kg !== '' && c < 0;
                  const set = (k: string, v: any) => setRolls(rs => rs.map((x, j) => j === i ? { ...x, [k]: v } : x));
                  return (
                    <tr key={r.fabric_issue_roll_id} className="border-b">
                      <td className="p-2"><span className="font-mono font-semibold">{r.dc.roll_no}</span> <span className="text-slate-400">{r.dc.lot_no}</span></td>
                      <td className="p-2 text-right"><Qty v={r.dc.remaining_kg} uom="KG" dp={3} /></td>
                      <td className="p-1.5"><UomInput uom="KG" value={r.before_kg} min={0} onChange={v => set('before_kg', v)} /></td>
                      <td className="p-1.5"><UomInput uom="KG" value={r.after_kg} min={0} onChange={v => set('after_kg', v)} /></td>
                      <td className="p-1.5"><UomInput uom="PLY" value={r.plies} step="1" min={0} onChange={v => set('plies', v)} /></td>
                      <td className={`p-2 text-right font-semibold ${bad ? 'text-red-600' : 'text-emerald-700'}`}>
                        {bad ? 'Negative!' : <Qty v={Math.max(c, 0)} uom="KG" dp={3} />}
                      </td>
                      <td className="p-2"><Checkbox label="Close" checked={r.close_roll} onChange={v => set('close_roll', v)} /></td>
                      <td className="p-2"><button className="font-bold text-red-500" onClick={() => setRolls(rs => rs.filter((_, j) => j !== i))}>×</button></td>
                    </tr>
                  );
                })}
              </tbody>
              {rolls.length > 0 && <tfoot><tr className="font-semibold"><td className="p-2" colSpan={5}>Lay actual consumption</td>
                <td className="p-2 text-right"><Qty v={actualKg} uom="KG" dp={3} /></td><td colSpan={2} /></tr></tfoot>}
            </table>
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-700">Losses <span className="font-normal text-slate-400">(recorded separately from garment-use consumption)</span></h4>
            <Button size="sm" variant="outline" onClick={() => setLosses(ls => [...ls, { loss_type: 'END_LOSS', qty_kg: '', reason: '' }])}>+ Add loss</Button>
          </div>
          {losses.length === 0 ? <p className="text-xs text-slate-400">No losses recorded.</p> : (
            <div className="space-y-2">
              {losses.map((l, i) => {
                const set = (k: string, v: any) => setLosses(ls => ls.map((x, j) => j === i ? { ...x, [k]: v } : x));
                return (
                  <div key={i} className="grid grid-cols-12 items-end gap-2">
                    <Select className="col-span-4" value={l.loss_type} onChange={e => set('loss_type', e.target.value)} options={LOSS_TYPES} />
                    <UomInput className="col-span-2" uom="KG" value={l.qty_kg} min={0} onChange={v => set('qty_kg', v)} />
                    <input className="input col-span-5" placeholder="Reason" value={l.reason} onChange={e => set('reason', e.target.value)} />
                    <button className="col-span-1 font-bold text-red-500" onClick={() => setLosses(ls => ls.filter((_, j) => j !== i))}>×</button>
                  </div>
                );
              })}
              <p className="text-right text-xs font-semibold text-slate-600">Total losses <Qty v={lossKg} uom="KG" dp={3} /></p>
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-sm font-semibold text-slate-700">Size-wise cut output</h4>
            {mv && <Button size="sm" variant="outline" onClick={fillFromRatio}>Fill good PCS from ratio × ply</Button>}
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="border-b bg-slate-50 text-left text-slate-600">
                <tr><th className="p-2">Size</th><th className="p-2 text-right">Planned</th><th className="p-2 text-right">Already cut</th>
                  <th className="p-2 w-32">Good (PCS)</th><th className="p-2 w-32">Reject (PCS)</th><th className="p-2 w-32">Re-cut (PCS)</th></tr>
              </thead>
              <tbody>
                {sizes.length === 0 && <tr><td colSpan={6} className="p-3 text-center text-slate-400">The cut order has no size breakdown.</td></tr>}
                {sizes.map((s: any) => {
                  const o = outputs[s.size_id] || { good: '', reject: '', recut: '' };
                  const set = (k: string, v: string) => setOutputs(os => ({ ...os, [s.size_id]: { ...o, [k]: v } }));
                  return (
                    <tr key={s.size_id} className="border-b">
                      <td className="p-2 font-semibold">{s.size_code}</td>
                      <td className="p-2 text-right"><Qty v={s.planned_qty} uom="PCS" /></td>
                      <td className="p-2 text-right"><Qty v={s.actual_qty} uom="PCS" /></td>
                      <td className="p-1.5"><UomInput uom="PCS" value={o.good} step="1" min={0} onChange={v => set('good', v)} /></td>
                      <td className="p-1.5"><UomInput uom="PCS" value={o.reject} step="1" min={0} onChange={v => set('reject', v)} /></td>
                      <td className="p-1.5"><UomInput uom="PCS" value={o.recut} step="1" min={0} onChange={v => set('recut', v)} /></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr className="font-semibold"><td className="p-2" colSpan={3}>Total</td>
                <td className="p-2"><Qty v={good} uom="PCS" /></td><td className="p-2"><Qty v={rejects} uom="PCS" /></td><td /></tr></tfoot>
            </table>
          </div>
          {overExpected && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              Good cut {good} PCS exceeds expected {expected} PCS. A user with PRODUCTION.APPROVE must authorise it:
              <Input className="mt-2" placeholder="Override reason" value={override} onChange={e => setOverride(e.target.value)} />
            </div>
          )}
          {!overExpected && (
            <Input className="mt-2" label="Over-cut authorisation reason (only if the cut order allowance is exceeded)" value={override} onChange={e => setOverride(e.target.value)} />
          )}
        </section>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ spreading */
function SpreadingModal({ lay, onClose, onSaved }: { lay: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<any>({ spreading_date: today(), roll_no: '', start_mtr: '', end_mtr: '', ply_count: lay.ply_count || '', fabric_width_cm: '', gsm: '', shade: '', operator_name: lay.operator_name || '', qc_status: 'PASS', remarks: '' });
  const [saving, setSaving] = useState(false);
  const used = f.start_mtr !== '' && f.end_mtr !== '' ? Number(f.start_mtr) - Number(f.end_mtr) : null;
  const save = async () => {
    setSaving(true);
    try {
      const n = (v: any) => (v === '' ? null : Number(v));
      await api.post(`/lay-plans/${lay.id}/spreading`, { ...f, start_mtr: n(f.start_mtr), end_mtr: n(f.end_mtr), actual_used_mtr: used, ply_count: Number(f.ply_count) || 0, fabric_width_cm: n(f.fabric_width_cm), gsm: n(f.gsm) });
      toast('Spreading recorded'); onSaved();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Spreading — ${lay.lay_no}`} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={saving}>Save Spreading</Button></>}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Input label="Date" type="date" value={f.spreading_date} onChange={e => setF({ ...f, spreading_date: e.target.value })} />
        <Input label="Roll No" value={f.roll_no} onChange={e => setF({ ...f, roll_no: e.target.value })} />
        <Input label="Operator" value={f.operator_name} onChange={e => setF({ ...f, operator_name: e.target.value })} />
        <UomInput label="Start" uom="MTR" value={f.start_mtr} onChange={v => setF({ ...f, start_mtr: v })} />
        <UomInput label="End" uom="MTR" value={f.end_mtr} onChange={v => setF({ ...f, end_mtr: v })} />
        <div><label className="label">Used (MTR)</label><div className="input bg-slate-50 text-right font-semibold">{used != null ? fmtNumber(used, 3) : '—'} MTR</div></div>
        <UomInput label="Ply" uom="PLY" step="1" value={f.ply_count} onChange={v => setF({ ...f, ply_count: v })} />
        <UomInput label="Width" uom="CM" value={f.fabric_width_cm} onChange={v => setF({ ...f, fabric_width_cm: v })} />
        <UomInput label="GSM" uom="GSM" value={f.gsm} onChange={v => setF({ ...f, gsm: v })} />
        <Input label="Shade" value={f.shade} onChange={e => setF({ ...f, shade: e.target.value })} />
        <Select label="QC" value={f.qc_status} onChange={e => setF({ ...f, qc_status: e.target.value })} options={[{ value: 'PASS', label: 'Pass' }, { value: 'HOLD', label: 'Hold' }, { value: 'REJECT', label: 'Reject' }]} />
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------- cancel/reverse */
function CancelLayModal({ lay, onClose, onSaved }: { lay: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const executed = ['CUT', 'APPROVED'].includes(lay.status);
  const go = async () => {
    if (!reason.trim()) return toast('A reason is required', 'error');
    setSaving(true);
    try { await api.post(`/lay-plans/${lay.id}/cancel`, { reason }); toast(executed ? 'Lay reversed' : 'Lay cancelled'); onSaved(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={`${executed ? 'Reverse' : 'Cancel'} lay ${lay.lay_no}`} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant="danger" onClick={go} loading={saving}>{executed ? 'Reverse lay' : 'Cancel lay'}</Button></>}>
      {executed && <p className="mb-3 text-xs text-amber-800">Reversal returns the consumed KG to the DC rolls, reverses the losses and cut output, and cancels its bundles. It is blocked once any bundle has moved beyond GENERATED. Needs PRODUCTION.APPROVE.</p>}
      <Textarea label="Reason" required rows={3} value={reason} onChange={e => setReason(e.target.value)} />
    </Modal>
  );
}

/* ---------------------------------------------------------------- detail */
function LayDetailModal({ lay, onClose }: { lay: any; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`Lay ${lay.lay_no}`} size="xl">
      <div className="space-y-4 text-xs">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <MetricTile label="Status" value={<StatusChip status={lay.status} />} />
          <MetricTile label="Expected" value={fmtNumber(lay.expected_pieces)} uom="PCS" />
          <MetricTile label="Good cut" value={fmtNumber(lay.actual_cut_qty)} uom="PCS" />
          <MetricTile label="Planned" value={fmtNumber(lay.planned_kg, 3)} uom="KG" />
          <MetricTile label="Actual" value={fmtNumber(lay.actual_kg, 3)} uom="KG" />
          <MetricTile label="Actual KG/PC" value={fmtNumber(lay.actual_kg_per_pc, 4)} uom="KG/PC" />
        </div>
        {lay.marker_version && <p>Marker <b>{lay.marker_version.marker_no} v{lay.marker_version.version}</b> · ratio {lay.marker_version.sizes.map((s: string, i: number) => `${s}${lay.marker_version.ratios[i]}`).join(' ')} · {lay.marker_version.pieces_per_marker} PCS/marker · {lay.marker_version.is_locked ? 'locked' : 'unlocked'}</p>}
        {lay.executed_at && <p>Executed {fmtDateTime(lay.executed_at)}{lay.override_reason ? ` · override: ${lay.override_reason}` : ''}{lay.cancel_reason ? ` · cancelled: ${lay.cancel_reason}` : ''}</p>}
        <table className="w-full border"><thead className="bg-slate-50"><tr><th className="p-1.5 text-left">Roll</th><th className="p-1.5 text-right">Before</th><th className="p-1.5 text-right">After</th><th className="p-1.5 text-right">Consumed</th></tr></thead>
          <tbody>{lay.rolls.map((r: any) => <tr key={r.id} className="border-t"><td className="p-1.5 font-mono">{r.roll_no} <span className="text-slate-400">{r.issue_no}</span></td><td className="p-1.5 text-right"><Qty v={r.before_kg} uom="KG" dp={3} /></td><td className="p-1.5 text-right"><Qty v={r.after_kg} uom="KG" dp={3} /></td><td className="p-1.5 text-right font-semibold"><Qty v={r.actual_consumed_kg} uom="KG" dp={3} /></td></tr>)}</tbody></table>
        {lay.losses.length > 0 && <table className="w-full border"><thead className="bg-slate-50"><tr><th className="p-1.5 text-left">Loss</th><th className="p-1.5 text-right">KG</th><th className="p-1.5 text-left">Reason</th></tr></thead>
          <tbody>{lay.losses.map((l: any) => <tr key={l.id} className={`border-t ${l.is_reversed ? 'line-through text-slate-400' : ''}`}><td className="p-1.5">{l.loss_type}</td><td className="p-1.5 text-right"><Qty v={l.qty_kg} uom="KG" dp={3} /></td><td className="p-1.5">{l.reason}</td></tr>)}</tbody></table>}
        <table className="w-full border"><thead className="bg-slate-50"><tr><th className="p-1.5 text-left">Output</th><th className="p-1.5">Size</th><th className="p-1.5 text-right">Good</th><th className="p-1.5 text-right">Reject</th><th className="p-1.5 text-right">Re-cut</th><th className="p-1.5 text-right">Actual KG</th><th className="p-1.5 text-right">Bundled</th><th className="p-1.5">Status</th></tr></thead>
          <tbody>{lay.outputs.map((o: any) => <tr key={o.id} className="border-t"><td className="p-1.5 font-mono">{o.output_no}</td><td className="p-1.5 text-center font-semibold">{o.size_code}</td><td className="p-1.5 text-right"><Qty v={o.good_qty} uom="PCS" /></td><td className="p-1.5 text-right"><Qty v={o.reject_qty} uom="PCS" /></td><td className="p-1.5 text-right"><Qty v={o.recut_qty} uom="PCS" /></td><td className="p-1.5 text-right"><Qty v={o.actual_kg} uom="KG" dp={3} /></td><td className="p-1.5 text-right"><Qty v={o.bundled_qty} uom="PCS" /></td><td className="p-1.5"><StatusChip status={o.status} /></td></tr>)}</tbody></table>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------- marker versions */
function MarkerVersions() {
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [cads, setCads] = useState<any[]>([]);
  const [styles, setStyles] = useState<any[]>([]);
  const [fabrics, setFabrics] = useState<any[]>([]);
  const [cadId, setCadId] = useState('');
  const [cadMarkers, setCadMarkers] = useState<any[]>([]);
  const [snap, setSnap] = useState<any>({ marker_ref: '', fabric_id: '' });
  const [manual, setManual] = useState<any>(null);
  const load = () => api.get('/marker-versions').then(r => setRows(r.data.data || []));
  useEffect(() => {
    load();
    api.get('/cad-requirements').then(r => setCads(r.data.data || [])).catch(() => setCads([]));
    api.get('/lookups/styles').then(r => setStyles(r.data.data || []));
    api.get('/lookups/fabrics').then(r => setFabrics(r.data.data || []));
  }, []);
  useEffect(() => {
    setCadMarkers([]);
    if (cadId) api.get(`/cad-requirements/${cadId}`).then(r => setCadMarkers(r.data.data?.markers || []));
  }, [cadId]);

  const doSnapshot = async () => {
    if (!cadId || !snap.marker_ref) return toast('Select CAD requirement and marker', 'error');
    try {
      const r = await api.post('/marker-versions/snapshot', { cad_req_id: Number(cadId), marker_ref: snap.marker_ref, fabric_id: snap.fabric_id ? Number(snap.fabric_id) : null });
      toast(r.data.created ? `Marker ${r.data.data.marker_no} v${r.data.data.version} created` : `No change — v${r.data.data.version} is current`);
      load();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const saveManual = async () => {
    try {
      const sizes = String(manual.sizes).split(/[,\s]+/).filter(Boolean);
      const ratios = String(manual.ratios).split(/[,\s]+/).filter(Boolean).map(Number);
      const r = await api.post('/marker-versions', { ...manual, style_id: Number(manual.style_id), fabric_id: manual.fabric_id ? Number(manual.fabric_id) : null, sizes, ratios,
        length_m: manual.length_m ? Number(manual.length_m) : undefined, width_in: manual.width_in ? Number(manual.width_in) : undefined,
        marker_kg_per_ply: manual.marker_kg_per_ply ? Number(manual.marker_kg_per_ply) : undefined, gsm: manual.gsm ? Number(manual.gsm) : undefined });
      toast(r.data.created ? `Marker v${r.data.data.version} saved` : 'No change — existing version kept');
      setManual(null); load();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const approve = async (id: number) => {
    try { await api.post(`/marker-versions/${id}/approve`, {}); toast('Marker version approved'); load(); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const cadOptions = useMemo(() => cads.map((c: any) => ({ value: c.id, label: `${c.req_no} · ${c.style_code || ''} · ${c.internal_ir_no || ''}`, right: c.status })), [cads]);

  return (
    <div className="space-y-4">
      <Card title="Snapshot a CAD marker" subtitle="Values are copied into an immutable version; a new version is created only when the CAD marker changed.">
        <div className="grid grid-cols-1 items-end gap-3 p-4 md:grid-cols-4">
          <SearchSelect label="CAD requirement" value={cadId} onChange={setCadId} options={cadOptions} />
          <SearchSelect label="Marker" value={snap.marker_ref} onChange={v => setSnap({ ...snap, marker_ref: v })}
            options={cadMarkers.map((m: any) => ({ value: m.marker_ref, label: `${m.marker_ref} · ${(m.sizes || []).map((s: any, i: number) => `${s}${m.ratios?.[i] ?? ''}`).join(' ')}`, right: `${m.no_of_pcs_lay} PCS` }))} />
          <SearchSelect label="Fabric" value={snap.fabric_id} onChange={v => setSnap({ ...snap, fabric_id: v })}
            options={fabrics.map((f: any) => ({ value: f.id, label: f.label || f.code }))} />
          <div className="flex gap-2"><Button onClick={doSnapshot}>Snapshot</Button><Button variant="outline" onClick={() => setManual({ marker_no: '', style_id: '', fabric_id: '', sizes: 'S M L XL', ratios: '2 3 3 2', length_m: '', width_in: '', marker_kg_per_ply: '', gsm: '' })}>Manual marker</Button></div>
        </div>
      </Card>
      <Card>
        <DataTable data={rows} columns={[
          { key: 'marker_no', header: 'Marker', render: (r: any) => <span className="font-mono text-xs font-semibold">{r.marker_no} v{r.version}</span> },
          { key: 'source', header: 'Source', render: (r: any) => <span className="text-xs">{r.source}{r.cad_req_no ? ` · ${r.cad_req_no}` : ''}</span> },
          { key: 'style_code', header: 'Style' },
          { key: 'fabric_name', header: 'Fabric' },
          { key: 'ratio_text', header: 'Ratio' },
          { key: 'pieces_per_marker', header: 'PCS/marker', align: 'right' as const, render: (r: any) => <Qty v={r.pieces_per_marker} uom="PCS" /> },
          { key: 'length_m', header: 'Length', align: 'right' as const, render: (r: any) => <Qty v={r.length_m} uom="M" dp={3} /> },
          { key: 'width_in', header: 'Width', align: 'right' as const, render: (r: any) => <Qty v={r.width_in} uom="IN" dp={2} /> },
          { key: 'marker_kg_per_ply', header: 'Per ply', align: 'right' as const, render: (r: any) => <Qty v={r.marker_kg_per_ply} uom={r.uom} dp={4} /> },
          { key: 'cad_kg_per_pc', header: 'CAD / PC', align: 'right' as const, render: (r: any) => <Qty v={r.cad_kg_per_pc} uom={`${r.uom}/PC`} dp={4} /> },
          { key: 'size_consumption', header: 'Size-wise', render: (r: any) => r.size_consumption ? <span className="text-[11px]">{Object.entries(r.size_consumption).map(([k, v]) => `${k}:${v}`).join(' ')}</span> : '—' },
          { key: 'lock', header: 'State', render: (r: any) => <span className="text-xs">{r.is_locked ? '🔒 Locked' : r.approved_at ? 'Approved' : 'Draft'} · {r.lay_count} lay(s)</span> },
          { key: 'a', header: '', render: (r: any) => !r.is_locked && !r.approved_at ? <Button size="sm" variant="outline" onClick={() => approve(r.id)}>Approve</Button> : null },
        ]} />
      </Card>
      {manual && (
        <Modal open onClose={() => setManual(null)} title="Manual marker (Marker Master)" size="lg"
          footer={<><Button variant="ghost" onClick={() => setManual(null)}>Cancel</Button><Button onClick={saveManual}>Save version</Button></>}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Input label="Marker No" value={manual.marker_no} onChange={e => setManual({ ...manual, marker_no: e.target.value })} />
            <SearchSelect label="Style" required value={manual.style_id} onChange={v => setManual({ ...manual, style_id: v })} options={styles.map((s: any) => ({ value: s.id, label: s.label || s.code }))} />
            <SearchSelect label="Fabric" value={manual.fabric_id} onChange={v => setManual({ ...manual, fabric_id: v })} options={fabrics.map((f: any) => ({ value: f.id, label: f.label || f.code }))} />
            <Input label="Sizes (space separated)" value={manual.sizes} onChange={e => setManual({ ...manual, sizes: e.target.value })} />
            <Input label="Ratio (same order)" value={manual.ratios} onChange={e => setManual({ ...manual, ratios: e.target.value })} />
            <UomInput label="Marker length" uom="M" value={manual.length_m} onChange={v => setManual({ ...manual, length_m: v })} />
            <UomInput label="Width" uom="IN" value={manual.width_in} onChange={v => setManual({ ...manual, width_in: v })} />
            <UomInput label="GSM" uom="GSM" value={manual.gsm} onChange={v => setManual({ ...manual, gsm: v })} />
            <UomInput label="Fabric per ply" uom="KG" value={manual.marker_kg_per_ply} onChange={v => setManual({ ...manual, marker_kg_per_ply: v })} />
          </div>
        </Modal>
      )}
    </div>
  );
}
