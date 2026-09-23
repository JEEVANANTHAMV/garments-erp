import { useEffect, useState } from 'react';
import { Card, Button, DataTable, Modal, Select, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNumber } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { SearchSelect, StatusChip, Qty, UomInput, MetricTile, errMsg } from './cuttingUi';

const LOSS_TYPES = [
  { value: 'CUTTING_WASTE', label: 'Cutting / marker waste' },
  { value: 'END_LOSS', label: 'End loss' },
  { value: 'SELVEDGE_LOSS', label: 'Selvedge loss' },
  { value: 'REMNANT', label: 'Remnant' },
  { value: 'OTHER', label: 'Other approved loss' },
];

/**
 * Cutting Reconciliation & Close (doc §16, §17).
 * Issued − Consumption − Losses = Unaccounted; close is blocked beyond the
 * configured tolerance unless the variance is approved.
 */
export function CuttingReconciliationPage() {
  const toast = useToast();
  const [plans, setPlans] = useState<any[]>([]);
  const [planId, setPlanId] = useState('');
  const [data, setData] = useState<any>(null);
  const [recons, setRecons] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'close' | 'approve' | 'reopen' | 'loss'>(null);
  const [reason, setReason] = useState('');
  const [loss, setLoss] = useState<any>({ loss_type: 'REMNANT', qty_kg: '', reason: '' });

  const loadPlans = () => api.get('/cutting-plans').then(r => setPlans((r.data.data || []).filter((p: any) => p.status !== 'CANCELLED')));
  const loadRecons = () => api.get('/cutting-reconciliations').then(r => setRecons(r.data.data || []));
  const load = () => {
    if (!planId) { setData(null); return; }
    api.get(`/cutting-reconciliation/preview/${planId}`).then(r => setData(r.data.data)).catch(e => toast(errMsg(e), 'error'));
  };
  useEffect(() => { loadPlans(); loadRecons(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [planId]);

  const refreshAll = () => { load(); loadRecons(); loadPlans(); };
  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); setDialog(null); setReason(''); refreshAll(); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };

  const ensureRecon = async (): Promise<number> => {
    const r = await api.post('/cutting-reconciliation', { cutting_plan_id: Number(planId) });
    return r.data.data.id;
  };

  const f = data?.figures;
  const rec = data?.reconciliation;
  const closed = data?.plan?.status === 'CLOSED';
  const over = f && !f.within_tolerance;
  const cons = data?.consumption;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Cutting Reconciliation & Close</h1>
          <p className="text-sm text-slate-500">Issued KG − Lay consumption − Losses = Unaccounted. Cutting cannot be closed while fabric is unaccounted beyond tolerance.</p>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-4 p-4">
          <SearchSelect className="w-96" label="Cut order" value={planId} onChange={setPlanId}
            options={plans.map(p => ({ value: p.id, label: `${p.plan_no} · ${p.io_no} · ${p.style_code || ''}`, sub: p.fabric_name, right: p.status }))} />
          {data && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>Cut order</span><StatusChip status={data.plan.status} />
              {rec && <><span>Reconciliation {rec.recon_no}</span><StatusChip status={rec.status} /></>}
              {over && !closed && <StatusChip status="VARIANCE" />}
            </div>
          )}
          {data && (
            <div className="ml-auto flex gap-2">
              {!closed && <Button variant="outline" onClick={() => setDialog('loss')}>+ Record loss / remnant</Button>}
              {!closed && <Button variant="outline" onClick={() => run(ensureRecon, 'Reconciliation saved')} loading={busy}>Save reconciliation</Button>}
              {!closed && over && <Button variant="outline" onClick={() => setDialog('approve')}>Approve variance</Button>}
              {!closed && <Button onClick={() => setDialog('close')}>Close cutting…</Button>}
              {closed && rec?.status === 'CLOSED' && <Button variant="outline" onClick={() => setDialog('reopen')}>Reopen…</Button>}
            </div>
          )}
        </div>
      </Card>

      {data && f && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <MetricTile label="Fabric issued (DC)" value={fmtNumber(f.issue_kg, 3)} uom="KG" sub={`${f.dc_rolls} roll line(s)`} />
            <MetricTile label="Returned to store" value={fmtNumber(f.returned_kg, 3)} uom="KG" />
            <MetricTile label="Net issued" value={fmtNumber(f.net_issued_kg, 3)} uom="KG" tone="indigo" />
            <MetricTile label="Lay consumption" value={fmtNumber(f.consumed_kg, 3)} uom="KG" tone="emerald" />
            <MetricTile label="Unaccounted" value={fmtNumber(f.unaccounted_kg, 3)} uom="KG" tone={over ? 'red' : 'emerald'}
              sub={`tolerance ±${fmtNumber(f.tolerance_kg, 3)} KG (${f.tolerance_pct}%)`} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Reconciliation statement">
              <table className="w-full text-sm">
                <tbody>
                  {[
                    ['Fabric DC / Issued', f.issue_kg], ['Less: returned to store', -f.returned_kg],
                    ['Less: actual lay consumption', -f.consumed_kg], ['Less: cutting wastage', -f.waste_kg],
                    ['Less: end loss', -f.end_loss_kg], ['Less: selvedge loss', -f.selvedge_kg],
                    ['Less: remnant', -f.remnant_kg], ['Less: other approved loss', -f.other_loss_kg],
                  ].map(([l, v]) => (
                    <tr key={String(l)} className="border-b border-slate-100">
                      <td className="px-4 py-1.5 text-slate-600">{l}</td>
                      <td className="px-4 py-1.5 text-right"><Qty v={v} uom="KG" dp={3} /></td>
                    </tr>
                  ))}
                  <tr className={over ? 'bg-red-50 font-bold text-red-700' : 'bg-emerald-50 font-bold text-emerald-800'}>
                    <td className="px-4 py-2">Unaccounted difference</td>
                    <td className="px-4 py-2 text-right"><Qty v={f.unaccounted_kg} uom="KG" dp={3} /></td>
                  </tr>
                </tbody>
              </table>
              {rec?.variance_reason && <p className="px-4 py-2 text-xs text-slate-600">Variance approved by {rec.approved_by_name} on {fmtDateTime(rec.approved_at)}: {rec.variance_reason}</p>}
              {rec?.reopen_reason && <p className="px-4 pb-2 text-xs text-violet-700">Last reopened: {rec.reopen_reason}</p>}
            </Card>

            <Card title="Planned vs Marker vs Actual consumption" subtitle="Each figure comes from its own source; none overwrites another.">
              {cons && (
                <div className="space-y-3 p-4">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <MetricTile label="Costing / BOM" value={cons.planned.kg_per_pc != null ? fmtNumber(cons.planned.kg_per_pc, 4) : '—'} uom="KG/PC" sub={cons.planned.source || 'no BOM/costing'} />
                    <MetricTile label="Marker (CAD)" value={cons.marker.kg_per_pc != null ? fmtNumber(cons.marker.kg_per_pc, 4) : '—'} uom="KG/PC" />
                    <MetricTile label="Cutting actual" value={cons.cutting_actual.kg_per_pc != null ? fmtNumber(cons.cutting_actual.kg_per_pc, 4) : '—'} uom="KG/PC" tone="emerald" sub={`${fmtNumber(cons.good_pcs)} good PCS`} />
                    <MetricTile label="Final actual" value={cons.final_actual.kg_per_pc != null ? fmtNumber(cons.final_actual.kg_per_pc, 4) : '—'} uom="KG/PC" tone={cons.final_actual.is_final ? 'indigo' : 'slate'} sub={cons.final_actual.is_final ? 'final (closed)' : 'provisional'} />
                  </div>
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-slate-500"><th>Variance</th><th className="text-right">KG/PC</th><th className="text-right">%</th></tr></thead>
                    <tbody>
                      {[['Marker − Planned', cons.variances.marker_vs_planned], ['Actual − Planned', cons.variances.actual_vs_planned],
                        ['Actual − Marker', cons.variances.actual_vs_marker], ['Final − Planned', cons.variances.final_vs_planned]].map(([l, v]: any) => (
                        <tr key={l} className="border-t">
                          <td className="py-1">{l}</td>
                          <td className={`py-1 text-right ${Number(v.variance) > 0 ? 'text-red-600' : 'text-emerald-700'}`}>{v.variance != null ? fmtNumber(v.variance, 4) : '—'}</td>
                          <td className={`py-1 text-right ${Number(v.variance_pct) > 0 ? 'text-red-600' : 'text-emerald-700'}`}>{v.variance_pct != null ? `${fmtNumber(v.variance_pct, 2)} %` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          {(data.warnings.length > 0 || data.blockers.length > 0) && !closed && (
            <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {data.blockers.map((b: string) => <p key={b} className="font-semibold text-red-700">⛔ {b}</p>)}
              {data.warnings.map((w: string) => <p key={w}>⚠ {w}</p>)}
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Lays">
              <DataTable data={data.lays} columns={[
                { key: 'lay_no', header: 'Lay', render: (r: any) => <span className="font-mono text-xs">{r.lay_no}</span> },
                { key: 'status', header: 'Status', render: (r: any) => <StatusChip status={r.status} /> },
                { key: 'planned_kg', header: 'Planned', align: 'right' as const, render: (r: any) => <Qty v={r.planned_kg} uom="KG" dp={3} /> },
                { key: 'actual_kg', header: 'Actual', align: 'right' as const, render: (r: any) => <Qty v={r.actual_kg} uom="KG" dp={3} /> },
                { key: 'actual_cut_qty', header: 'Good', align: 'right' as const, render: (r: any) => <Qty v={r.actual_cut_qty} uom="PCS" /> },
              ]} />
            </Card>
            <Card title="Losses">
              <DataTable data={data.losses} columns={[
                { key: 'loss_type', header: 'Type', render: (r: any) => <span className={r.is_reversed ? 'text-slate-400 line-through' : ''}>{r.loss_type.replace(/_/g, ' ')}</span> },
                { key: 'lay_no', header: 'Lay', render: (r: any) => r.lay_no || '—' },
                { key: 'qty_kg', header: 'Qty', align: 'right' as const, render: (r: any) => <Qty v={r.qty_kg} uom="KG" dp={3} /> },
                { key: 'reason', header: 'Reason', render: (r: any) => <span className="text-xs">{r.is_reversed ? `Reversed: ${r.reversal_reason}` : r.reason}</span> },
                { key: 'a', header: '', render: (r: any) => !r.is_reversed && !closed ? (
                  <Button size="sm" variant="ghost" onClick={() => {
                    const why = window.prompt('Reason for reversing this loss entry');
                    if (why) run(() => api.post(`/cutting-losses/${r.id}/reverse`, { reason: why }), 'Loss reversed');
                  }}>Reverse</Button>) : null },
              ]} />
            </Card>
          </div>
        </>
      )}

      <Card title="Reconciliations">
        <DataTable data={recons} columns={[
          { key: 'recon_no', header: 'No', render: (r: any) => <button className="font-mono text-xs text-brand-700 hover:underline" onClick={() => setPlanId(String(r.cutting_plan_id))}>{r.recon_no}</button> },
          { key: 'plan_no', header: 'Cut Order' },
          { key: 'style_code', header: 'Style' },
          { key: 'issued_kg', header: 'Issued', align: 'right' as const, render: (r: any) => <Qty v={r.issued_kg} uom="KG" dp={3} /> },
          { key: 'consumed_kg', header: 'Consumed', align: 'right' as const, render: (r: any) => <Qty v={r.consumed_kg} uom="KG" dp={3} /> },
          { key: 'unaccounted_kg', header: 'Unaccounted', align: 'right' as const, render: (r: any) => <Qty v={r.unaccounted_kg} uom="KG" dp={3} /> },
          { key: 'status', header: 'Status', render: (r: any) => <StatusChip status={r.status} /> },
          { key: 'closed_at', header: 'Closed', render: (r: any) => r.closed_at ? `${fmtDate(r.closed_at)} · ${r.closed_by_name || ''}` : '—' },
        ]} />
      </Card>

      {dialog === 'close' && f && (
        <Modal open onClose={() => setDialog(null)} title="Close cutting — reconciliation check" size="md"
          footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Back</Button>
            <Button onClick={() => run(async () => { const id = await ensureRecon(); await api.post(`/cutting-reconciliation/${id}/close`, {}); }, 'Cutting closed')}
              loading={busy} disabled={data.blockers.length > 0 || !data.can_close}>Close cut order</Button></>}>
          <div className="space-y-3 text-sm">
            <p>Closing makes cut order <b>{data.plan.plan_no}</b> read-only and closes its DC rolls.</p>
            <div className={`rounded-lg border p-3 ${over ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
              Unaccounted <b>{fmtNumber(f.unaccounted_kg, 3)} KG</b> against a tolerance of <b>{fmtNumber(f.tolerance_kg, 3)} KG</b>.
              {over && (rec?.status === 'APPROVED' ? ' Variance approved — close allowed.' : ' Beyond tolerance: record the missing losses / returns, or have a supervisor approve the variance.')}
            </div>
            {data.blockers.map((b: string) => <p key={b} className="font-semibold text-red-700">⛔ {b}</p>)}
            {data.warnings.map((w: string) => <p key={w} className="text-amber-800">⚠ {w}</p>)}
          </div>
        </Modal>
      )}
      {(dialog === 'approve' || dialog === 'reopen') && (
        <Modal open onClose={() => setDialog(null)} title={dialog === 'approve' ? 'Approve cutting variance' : 'Reopen cut order'} size="sm"
          footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Back</Button>
            <Button loading={busy} onClick={() => {
              if (!reason.trim()) { toast('A reason is required', 'error'); return; }
              if (dialog === 'approve') run(async () => { const id = await ensureRecon(); await api.post(`/cutting-reconciliation/${id}/approve-variance`, { reason }); }, 'Variance approved');
              else run(() => api.post(`/cutting-reconciliation/${rec.id}/reopen`, { reason }), 'Cut order reopened');
            }}>{dialog === 'approve' ? 'Approve variance' : 'Reopen'}</Button></>}>
          <p className="mb-2 text-xs text-slate-600">{dialog === 'approve'
            ? `Approving accepts ${fmtNumber(f?.unaccounted_kg, 3)} KG unaccounted fabric. Needs PRODUCTION.APPROVE; any later change to the figures voids the approval.`
            : 'Reopening makes the cut order editable again. Needs PRODUCTION.APPROVE.'}</p>
          <Textarea label="Reason" required rows={3} value={reason} onChange={e => setReason(e.target.value)} />
        </Modal>
      )}
      {dialog === 'loss' && (
        <Modal open onClose={() => setDialog(null)} title="Record cutting loss / remnant" size="sm"
          footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Back</Button>
            <Button loading={busy} onClick={() => run(() => api.post(`/cutting-plans/${planId}/losses`, { ...loss, qty_kg: Number(loss.qty_kg) }), 'Loss recorded')}>Save</Button></>}>
          <div className="space-y-3">
            <Select label="Loss type" value={loss.loss_type} onChange={e => setLoss({ ...loss, loss_type: e.target.value })} options={LOSS_TYPES} />
            <UomInput label="Quantity" uom="KG" value={loss.qty_kg} min={0} onChange={v => setLoss({ ...loss, qty_kg: v })} />
            <Textarea label="Reason" rows={2} value={loss.reason} onChange={e => setLoss({ ...loss, reason: e.target.value })} />
          </div>
        </Modal>
      )}
    </div>
  );
}

export default CuttingReconciliationPage;
