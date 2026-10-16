import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Send, Ban, Plus, Printer, ScanLine } from 'lucide-react';
import { PageHeader, Card, Button, Tabs, LoadingBlock, ErrorState, EmptyState, Modal, FormSection, Input } from '../../../components/ui';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useToast } from '../../../hooks/useToast';
import { fmtDate, fmtDateTime, fmtNumber } from '../../../lib/format';
import { PackingNav, PkStatus, Stat, useOrder, errMsg, n, CartonEditor, ReasonModal, TableHead, printCartonLabel } from './packingShared';

/** Screen A detail — plan & balance, cartons, polybag entries, reconciliation; approve / post / complete / cancel. */
export function PackingOrderDetailPage() {
  const id = Number(useParams().id);
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const order = useOrder(id);
  const [tab, setTab] = useState('plan');
  const [busy, setBusy] = useState('');
  const [newCarton, setNewCarton] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [varianceNote, setVarianceNote] = useState<string | null>(null);
  const [plan, setPlan] = useState<Record<string, string> | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['packing-order', id] }); qc.invalidateQueries({ queryKey: ['packing-orders'] }); qc.invalidateQueries({ queryKey: ['packing-recon', id] }); };
  const act = async (key: string, fn: () => Promise<any>, done: string) => {
    setBusy(key);
    try { const r = await fn(); toast(typeof done === 'string' ? done : 'Done'); refresh(); return r; } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(''); }
  };

  if (order.isLoading) return <LoadingBlock />;
  if (order.error || !order.data) return <ErrorState error={order.error} onRetry={() => order.refetch()} />;
  const o = order.data;
  const rule = o.rule!;
  const working = ['APPROVED', 'IN_PROGRESS'].includes(o.order_status);
  const open = ['DRAFT', 'APPROVED', 'IN_PROGRESS'].includes(o.order_status);
  const lines = o.lines ?? [];
  const tot = (k: keyof typeof lines[number]) => lines.reduce((a, l) => a + n(l[k]), 0);
  const readyToPost = (o.cartons ?? []).filter((c) => !n(c.is_posted) && ['VERIFIED', 'SEALED'].includes(c.carton_status)).length;

  return (
    <div>
      <PageHeader title={<span className="font-mono">{o.pack_no}</span>} breadcrumb={['Logistics', 'Packing', 'Orders']}
        subtitle={<>{o.job_no} · {o.buyer_name} · {o.style_code} {o.style_name}{o.buyer_po_no ? ` · PO ${o.buyer_po_no}` : ''} · <PkStatus value={o.order_status} /></>}
        actions={<>
          {o.order_status === 'DRAFT' && can('PACKING.APPROVE') && <Button id="approve-order" loading={busy === 'approve'} onClick={() => act('approve', () => http.post(`/packing/orders/${id}/approve`), 'Packing order approved')}><CheckCircle2 size={15} />Approve</Button>}
          {working && can('PACKING.CREATE') && <Button variant="secondary" id="order-new-carton" onClick={() => setNewCarton(true)}><Plus size={15} />New carton</Button>}
          {working && readyToPost > 0 && can('PACKING.UPDATE') && <Button id="post-order" loading={busy === 'post'} onClick={() => act('post', () => http.post(`/packing/orders/${id}/post`), `Posted — packaging stock deducted, bundles packed`)}><Send size={15} />Post {readyToPost} carton{readyToPost > 1 ? 's' : ''}</Button>}
          {o.variance_needs_approval && can('PACKING.APPROVE') && <Button variant="secondary" onClick={() => setVarianceNote('')}>Approve variance</Button>}
          {working && can('PACKING.UPDATE') && <Button variant="secondary" loading={busy === 'complete'} onClick={() => act('complete', () => http.post(`/packing/orders/${id}/complete`), 'Packing order completed')}>Complete</Button>}
          {open && can('PACKING.UPDATE') && <Button variant="danger" onClick={() => setCancel(true)}><Ban size={15} />Cancel order</Button>}
        </>} />
      <PackingNav active="/logistics/packing/orders" />
      {o.rule_latest?.newer && open && (
        <div id="rule-newer" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
          <span>
            This order uses rule <b>{rule.rule_code} rev {o.rule_revision}</b> ({o.packing_mode === 'INDIVIDUAL_PIECE' ? 'individual piece' : 'bundle / qty'}).
            {o.rule_latest.is_active
              ? <> The rule was changed after the order was made — now rev <b>{o.rule_latest.revision}</b> ({o.rule_latest.packing_mode === 'INDIVIDUAL_PIECE' ? 'individual piece' : 'bundle / qty'}).</>
              : <> That rule has been deactivated.</>}
          </span>
          {o.can_apply_rule && can('PACKING.UPDATE')
            ? <Button size="sm" id="apply-rule" loading={busy === 'rule'} onClick={() => act('rule', () => http.post(`/packing/orders/${id}/apply-rule`), 'Latest packing rule applied to the order')}>Apply latest rule</Button>
            : <span className="text-[11.5px]">The order has polybags / cartons — void them, or cancel the order and create a new one.</span>}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Order qty" value={fmtNumber(tot('order_qty'))} />
        <Stat label="Eligible" value={fmtNumber(tot('eligible'))} hint="ready − held by others" />
        <Stat label="Planned" value={fmtNumber(o.planned_qty)} hint={`${o.planned_polybags} bags · ${o.planned_cartons} ctns`} />
        <Stat label="Packed (posted)" value={fmtNumber(o.pieces_posted)} tone="green" />
        <Stat label="In unposted cartons" value={fmtNumber(o.pieces_unposted)} tone={n(o.pieces_unposted) ? 'amber' : undefined} />
        <Stat label="Balance" value={fmtNumber(Math.max(n(o.planned_qty) - n(o.pieces_posted), 0))} />
        <Stat label="Polybags act / exp" value={`${o.variance?.polybags.actual ?? 0} / ${o.variance?.polybags.expected ?? 0}`} tone={o.variance?.polybags.variance ? 'amber' : undefined} hint={`${o.variance?.polybags.variance_pct ?? 0}% (tol ${o.variance?.tolerance_pct}%)`} />
        <Stat label="Cartons act / exp" value={`${o.variance?.cartons.actual ?? 0} / ${o.variance?.cartons.expected ?? 0}`} hint={`${n(o.cartons_total)} incl. unposted`} />
      </div>
      {o.variance_needs_approval && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">Packaging variance is beyond the {o.variance?.tolerance_pct}% tolerance — a supervisor must approve it before more cartons post.</div>}
      {o.variance_approved_at && <div className="mb-3 text-[12px] text-slate-500">Variance approved {fmtDateTime(o.variance_approved_at)}: {o.variance_note}</div>}

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'plan', label: 'Plan & balance' }, { key: 'cartons', label: 'Cartons', count: (o.cartons ?? []).filter((c) => c.carton_status !== 'VOID').length },
        { key: 'polybags', label: 'Polybag entries' }, { key: 'recon', label: 'Reconciliation' }, { key: 'info', label: 'Rule & details' },
      ]} />

      {tab === 'plan' && (
        <Card>
          <div className="p-3">
            <TableHead title="Colour × size" actions={open && can('PACKING.UPDATE') && (plan
              ? <><Button size="sm" variant="secondary" onClick={() => setPlan(null)}>Cancel</Button>
                  <Button size="sm" loading={busy === 'plan'} onClick={() => act('plan', () => http.put(`/packing/orders/${id}`, {
                    target_date: o.target_date ? String(o.target_date).slice(0, 10) : null, warehouse_id: o.warehouse_id, remarks: o.remarks,
                    lines: lines.map((l) => ({ color_id: l.color_id, size_id: l.size_id, planned_qty: n(plan[`${l.color_id}:${l.size_id}`]) })),
                  }).then(() => setPlan(null)), 'Plan saved')}>Save plan</Button></>
              : <Button size="sm" variant="secondary" onClick={() => setPlan(Object.fromEntries(lines.map((l) => [`${l.color_id}:${l.size_id}`, String(l.planned)])))}>Edit plan</Button>)} />
            <table className="w-full text-[12.5px]" id="order-lines">
              <thead><tr><th className="th">Colour</th><th className="th">Size</th><th className="th text-right">Order</th><th className="th text-right" title="PCS in the FG store (received on FG receipts, not yet packed)">Ready (FG store)</th><th className="th text-right">Held by others</th>
                <th className="th text-right">Eligible</th><th className="th text-right">Planned</th><th className="th text-right">Bagged</th><th className="th text-right">Unposted</th><th className="th text-right">Packed</th><th className="th text-right">Balance</th><th className="th text-right">Can add</th></tr></thead>
              <tbody>{lines.map((l) => (
                <tr key={`${l.color_id}:${l.size_id}`}>
                  <td className="td">{l.color_name}</td><td className="td">{l.size_code}</td><td className="td text-right">{fmtNumber(l.order_qty)}</td><td className="td text-right">{fmtNumber(l.ready)}{l.awaiting_fg ? <div className="text-[11px] text-amber-700" title="Finished (ironed) PCS not yet received on an FG receipt">{l.awaiting_fg} waiting for FG receipt</div> : null}</td>
                  <td className="td text-right">{fmtNumber(l.reserved_other)}</td><td className="td text-right">{fmtNumber(l.eligible)}</td>
                  <td className="td text-right font-medium">{plan ? <input className="input w-20 text-right" value={plan[`${l.color_id}:${l.size_id}`] ?? ''} onChange={(e) => setPlan({ ...plan, [`${l.color_id}:${l.size_id}`]: e.target.value.replace(/\D/g, '') })} /> : fmtNumber(l.planned)}</td>
                  <td className="td text-right">{fmtNumber(l.bagged)}</td><td className="td text-right">{fmtNumber(l.draft)}</td><td className="td text-right text-emerald-700">{fmtNumber(l.posted)}</td>
                  <td className="td text-right">{fmtNumber(l.balance)}</td><td className="td text-right">{fmtNumber(l.available)}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr className="font-semibold"><td className="td" colSpan={2}>Total</td>{(['order_qty', 'ready', 'reserved_other', 'eligible', 'planned', 'bagged', 'draft', 'posted', 'balance', 'available'] as const).map((k) => <td key={k} className="td text-right">{fmtNumber(tot(k))}</td>)}</tr></tfoot>
            </table>
          </div>
        </Card>
      )}

      {tab === 'cartons' && (
        <Card>
          {!(o.cartons ?? []).length ? <EmptyState title="No cartons yet" message={working ? 'Add the first carton.' : 'Approve the order to start packing.'} /> : (
            <table className="w-full text-[12.5px]" id="order-cartons">
              <thead><tr><th className="th">#</th><th className="th">Carton no</th><th className="th">Contents</th><th className="th text-right">Pcs</th><th className="th text-right">Polybags (std)</th>
                <th className="th">Type</th><th className="th text-right">Net / gross kg</th><th className="th">Status</th><th className="th" /></tr></thead>
              <tbody>{o.cartons!.map((c) => (
                <tr key={c.id} className={c.carton_status === 'VOID' ? 'opacity-50' : ''}>
                  <td className="td">{c.carton_seq}</td><td className="td font-mono">{c.carton_no}</td><td className="td">{c.contents}</td>
                  <td className="td text-right">{c.pieces_total}{n(c.is_partial) ? <span className="ml-1 text-[11px] text-amber-700">partial</span> : null}</td>
                  <td className="td text-right">{c.polybag_qty} ({c.std_polybag_qty})</td><td className="td">{c.carton_trim_name}</td>
                  <td className="td text-right">{c.net_weight_kg ?? '—'} / {c.gross_weight_kg ?? '—'}</td>
                  <td className="td"><PkStatus value={c.carton_status} posted={c.is_posted} /></td>
                  <td className="td whitespace-nowrap text-right">
                    <Link className="mr-2 inline-flex items-center gap-1 text-brand-700 hover:underline" to={`/logistics/packing/verify?code=${encodeURIComponent(c.carton_no)}`}><ScanLine size={13} />Open</Link>
                    {c.carton_status !== 'VOID' && <button className="inline-flex items-center gap-1 text-slate-600 hover:underline" onClick={() => printCartonLabel(c.id)}><Printer size={13} />Label</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
      )}

      {tab === 'polybags' && <PolybagList orderId={id} />}
      {tab === 'recon' && <Reconciliation orderId={id} />}
      {tab === 'info' && (
        <Card><div className="grid gap-x-6 gap-y-2 p-4 text-[12.5px] sm:grid-cols-2 lg:grid-cols-3">
          <div>Rule: <b>{rule.rule_code}</b> {rule.rule_name} (rev {rule.revision}, {rule.scope ?? 'snapshot'})</div>
          <div>Mode: <b>{o.packing_mode === 'INDIVIDUAL_PIECE' ? 'Individual piece' : 'Bundle / quantity'}</b></div>
          <div>Carton: <b>{rule.standard_pieces_per_carton}</b> pcs · polybag: <b>{rule.pieces_per_polybag}</b> pc</div>
          <div>Mixed sizes: {n(rule.allow_mixed_sizes) ? 'yes' : 'no'} · mixed colours: {n(rule.allow_mixed_colours) ? 'yes' : 'no'}</div>
          <div>Partial cartons: {n(rule.allow_partial_carton) ? 'yes' : 'no'} · overpack: {n(rule.allow_overpack) ? 'yes' : 'no'}</div>
          <div>Packaging store: {o.warehouse_name ?? 'any'} · target {fmtDate(o.target_date)}</div>
          <div>Approved: {o.approved_at ? `${fmtDateTime(o.approved_at)} ${o.approved_by_name ?? ''}` : '—'}</div>
          {o.cancel_reason && <div className="text-red-700">Cancelled: {o.cancel_reason}</div>}
          <div>Remarks: {o.remarks ?? '—'}</div>
          <div><Link className="text-brand-700 hover:underline" to="/logistics/packing-lists">Buyer packing list →</Link></div>
        </div></Card>
      )}

      {newCarton && <CartonEditor order={o} onClose={() => setNewCarton(false)} onSaved={(c) => { setNewCarton(false); toast(`Carton ${c.carton_no} saved`); refresh(); }} />}
      <ReasonModal open={cancel} title={`Cancel ${o.pack_no}`} subtitle="Unposted cartons are voided; posted cartons must be reversed first." confirm="Cancel order" danger busy={busy === 'cancel'}
        onClose={() => setCancel(false)} onSubmit={(reason) => act('cancel', () => http.post(`/packing/orders/${id}/cancel`, { reason }), 'Packing order cancelled').then(() => setCancel(false))} />
      <Modal open={varianceNote !== null} onClose={() => setVarianceNote(null)} title={`Approve packaging variance · ${o.pack_no}`} size="sm"
        subtitle={`Polybags ${o.variance?.polybags.actual} vs ${o.variance?.polybags.expected} expected; cartons ${o.variance?.cartons.actual} vs ${o.variance?.cartons.expected}.`}
        footer={<><Button variant="secondary" onClick={() => setVarianceNote(null)}>Cancel</Button>
          <Button disabled={(varianceNote ?? '').trim().length < 3} loading={busy === 'var'} onClick={() => act('var', () => http.post(`/packing/orders/${id}/approve-variance`, { note: varianceNote }), 'Variance approved').then(() => setVarianceNote(null))}>Approve</Button></>}>
        <FormSection cols={1}><Input label="Note" required value={varianceNote ?? ''} onChange={(e) => setVarianceNote(e.target.value)} /></FormSection>
      </Modal>
    </div>
  );
}

function PolybagList({ orderId }: { orderId: number }) {
  const q = useQuery({ queryKey: ['packing-polybags', orderId], queryFn: async () => (await http.get<{ data: any[] }>(`/packing/orders/${orderId}/polybags`)).data });
  if (q.isLoading) return <LoadingBlock />;
  return (
    <Card>
      {!q.data?.length ? <EmptyState title="No polybag entries" message="Bag pieces on the Piece / polybag entry screen." /> : (
        <table className="w-full text-[12.5px]">
          <thead><tr><th className="th">Time</th><th className="th">Bundle</th><th className="th">Colour / size</th><th className="th text-right">Pieces</th><th className="th text-right">Bags</th><th className="th text-right">In cartons</th><th className="th">Operator</th><th className="th">Status</th></tr></thead>
          <tbody>{q.data.map((b) => (
            <tr key={b.id}><td className="td">{fmtDateTime(b.created_at)}</td><td className="td font-mono">{b.bundle_no}</td><td className="td">{b.color_name} / {b.size_code}</td>
              <td className="td text-right">{b.pieces}</td><td className="td text-right">{b.polybag_qty}</td><td className="td text-right">{b.cartoned_qty}</td><td className="td">{b.operator_name}</td><td className="td"><PkStatus value={b.status} /></td></tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function Reconciliation({ orderId }: { orderId: number }) {
  const q = useQuery({ queryKey: ['packing-recon', orderId], queryFn: async () => (await http.get<{ data: any }>(`/packing/orders/${orderId}/reconciliation`)).data });
  if (q.isLoading || !q.data) return <LoadingBlock />;
  const r = q.data;
  return (
    <div className="grid gap-3 lg:grid-cols-2" id="reconciliation">
      <Card title="Pieces"><div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
        <Stat label="Eligible" value={fmtNumber(r.totals.eligible)} /><Stat label="Planned" value={fmtNumber(r.totals.planned)} />
        <Stat label="Packed (posted)" value={fmtNumber(r.totals.posted)} tone="green" /><Stat label="Balance" value={fmtNumber(r.totals.balance)} />
        <Stat label="Unposted" value={fmtNumber(r.totals.unposted)} /><Stat label="Bagged" value={fmtNumber(r.polybag_entries.pieces)} hint={`${r.polybag_entries.bags} bags`} />
        <Stat label="Full cartons" value={r.cartons.full} /><Stat label="Partial cartons" value={r.cartons.partial} />
      </div></Card>
      <Card title="Packaging variance" subtitle={`Tolerance ${r.variance.tolerance_pct}%${r.variance_needs_approval ? ' · approval needed' : ''}`}>
        <table className="w-full text-[12.5px]"><thead><tr><th className="th" /><th className="th text-right">Expected</th><th className="th text-right">Actual</th><th className="th text-right">Variance</th><th className="th text-right">%</th></tr></thead>
          <tbody>{(['polybags', 'cartons'] as const).map((k) => (
            <tr key={k}><td className="td capitalize">{k}</td><td className="td text-right">{r.variance[k].expected}</td><td className="td text-right">{r.variance[k].actual}</td>
              <td className={`td text-right ${r.variance[k].variance ? 'text-amber-700' : ''}`}>{r.variance[k].variance > 0 ? '+' : ''}{r.variance[k].variance}</td><td className="td text-right">{r.variance[k].variance_pct}%</td></tr>
          ))}</tbody></table>
        <div className="p-3">
          <TableHead title="Packaging consumed (posted)" />
          {!r.consumption.length ? <p className="text-[12px] text-slate-400">Nothing posted yet.</p> : (
            <table className="w-full text-[12.5px]"><tbody>{r.consumption.map((c: any) => (
              <tr key={`${c.material_kind}${c.trim_code}`}><td className="td">{c.material_kind}</td><td className="td">{c.trim_name}</td><td className="td text-right">{fmtNumber(c.qty, 2)}</td><td className="td text-right text-slate-400">{n(c.reversed_qty) ? `${fmtNumber(c.reversed_qty, 2)} reversed` : ''}</td></tr>
            ))}</tbody></table>
          )}
        </div>
      </Card>
    </div>
  );
}
