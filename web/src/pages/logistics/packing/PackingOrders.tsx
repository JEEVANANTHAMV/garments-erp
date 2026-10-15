import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Package, Plus } from 'lucide-react';
import { PageHeader, Card, Button, Input, Select, Textarea, Modal, FormSection, LoadingBlock, EmptyState, SearchInput, useDebounced } from '../../../components/ui';
import { JobSelect, type Job } from '../../../components/JobSelect';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useLookup } from '../../../hooks/useLookup';
import { fmtDate, fmtNumber, today } from '../../../lib/format';
import { PackingNav, PkStatus, useOrders, errMsg, n, type EligRow, type Rule } from './packingShared';

/** Screen A — packing orders list (replaces the old generic "Packing" page). */
export function PackingOrdersPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const dq = useDebounced(q);
  const orders = useOrders({ q: dq || undefined, status: status || undefined });
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  return (
    <div>
      <PageHeader title="Packing orders" breadcrumb={['Logistics', 'Packing']}
        subtitle="Finished, QC-accepted garments → polybags → cartons. Draft cartons never count as packed; posting deducts packaging stock once."
        actions={can('PACKING.CREATE') && <Button id="new-packing-order" onClick={() => setCreating(true)}><Plus size={15} />New packing order</Button>} />
      <PackingNav active="/logistics/packing/orders" />
      <Card>
        <div className="flex flex-wrap gap-2 border-b border-surface-border p-3">
          <SearchInput className="w-72" value={q} onChange={setQ} placeholder="Order, job, PO, style…" />
          <select className="input w-48" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['DRAFT', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </div>
        {orders.isLoading ? <LoadingBlock /> : !orders.data?.length ? <EmptyState title="No packing orders" message="Create one from a job whose garments are finished and QC-accepted." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" id="packing-orders-table">
              <thead><tr>
                <th className="th">Order</th><th className="th">Date</th><th className="th">Job / PO</th><th className="th">Buyer</th><th className="th">Style</th>
                <th className="th">Mode</th><th className="th text-right">Planned</th><th className="th text-right">Packed</th><th className="th text-right">Cartons</th>
                <th className="th">Status</th>
              </tr></thead>
              <tbody>
                {orders.data.map((o) => (
                  <tr key={o.id} className="row-hover cursor-pointer" onClick={() => nav(`/logistics/packing/orders/${o.id}`)}>
                    <td className="td font-mono font-medium text-brand-700"><Link to={`/logistics/packing/orders/${o.id}`}>{o.pack_no}</Link></td>
                    <td className="td">{fmtDate(o.pack_date)}</td>
                    <td className="td">{o.job_no}{o.buyer_po_no ? <div className="text-[11px] text-slate-400">PO {o.buyer_po_no}</div> : null}</td>
                    <td className="td">{o.buyer_name}</td>
                    <td className="td">{o.style_code}</td>
                    <td className="td">{o.packing_mode === 'INDIVIDUAL_PIECE' ? 'Individual piece' : 'Bundle / qty'}</td>
                    <td className="td text-right tabular-nums">{fmtNumber(o.planned_qty)}</td>
                    <td className="td text-right tabular-nums">{fmtNumber(o.pieces_posted)}{n(o.pieces_unposted) ? <div className="text-[11px] text-amber-700">+{fmtNumber(o.pieces_unposted)} unposted</div> : null}</td>
                    <td className="td text-right tabular-nums">{n(o.cartons_posted)} / {n(o.cartons_total)} <span className="text-slate-400">(plan {o.planned_cartons})</span></td>
                    <td className="td"><PkStatus value={o.order_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewOrderModal onClose={() => setCreating(false)} onCreated={(id) => nav(`/logistics/packing/orders/${id}`)} />}
    </div>
  );
}

function NewOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [styleId, setStyleId] = useState<number | ''>('');
  const [f, setF] = useState({ target_date: '', warehouse_id: '', remarks: '', packing_mode: '' });
  const [preview, setPreview] = useState<{ rule: Rule | null; rows: EligRow[]; strict_qc: boolean } | null>(null);
  const [plan, setPlan] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const wh = useLookup('warehouses');

  useEffect(() => {
    setPreview(null); setErr('');
    if (!job || !styleId) return;
    setLoading(true);
    http.get<{ data: any }>('/packing/eligibility', { so_id: job.id, style_id: styleId })
      .then((r) => { setPreview(r.data); setPlan(Object.fromEntries(r.data.rows.map((x: EligRow) => [`${x.color_id}:${x.size_id}`, String(x.eligible)]))); })
      .catch((e) => setErr(errMsg(e))).finally(() => setLoading(false));
  }, [job, styleId]);

  const total = useMemo(() => Object.values(plan).reduce((a, v) => a + n(v), 0), [plan]);
  const rule = preview?.rule;
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const r = await http.post<{ data: any }>('/packing/orders', {
        so_id: job!.id, style_id: styleId, target_date: f.target_date || null, warehouse_id: f.warehouse_id ? Number(f.warehouse_id) : null,
        remarks: f.remarks || null, packing_mode: f.packing_mode || null, pack_date: today(),
        lines: preview!.rows.map((x) => ({ color_id: x.color_id, size_id: x.size_id, planned_qty: n(plan[`${x.color_id}:${x.size_id}`]) })).filter((l) => l.planned_qty > 0),
      });
      onCreated(r.data.id);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} size="xl" icon={<Package size={16} />} title="New packing order"
      subtitle="Pick the job and style; the plan defaults to the eligible (finished, QC-accepted, not reserved by other orders) quantity."
      footerStart={preview && <span>Planned <b>{fmtNumber(total)}</b> pcs{rule ? <> · ≈ {Math.ceil(total / Math.max(n(rule.pieces_per_polybag), 1))} polybags · rule {rule.rule_code} ({rule.scope})</> : null}</span>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="create-order" loading={busy} disabled={!preview || !rule || !total} onClick={create}>Create draft order</Button>
      </>}>
      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{err}</div>}
      <FormSection title="Job" cols={3}>
        <JobSelect id="order-job" by="so_id" required value={job?.id ?? ''} onPick={(j) => { setJob(j); setStyleId(j && j.styles.length === 1 ? j.styles[0].style_id : ''); }} />
        <Select id="order-style" label="Style" required value={styleId} onChange={(e) => setStyleId(e.target.value ? Number(e.target.value) : '')}
          placeholder="— Style —" options={(job?.styles ?? []).map((s) => ({ value: s.style_id, label: `${s.style_code} · ${s.style_name}` }))} />
        <Select label="Packing mode" value={f.packing_mode} onChange={(e) => setF({ ...f, packing_mode: e.target.value })}
          options={[{ value: '', label: rule ? `From rule (${rule.packing_mode === 'INDIVIDUAL_PIECE' ? 'individual piece' : 'bundle / qty'})` : 'From rule' },
            { value: 'BUNDLE_QUANTITY', label: 'Bundle / quantity' }, { value: 'INDIVIDUAL_PIECE', label: 'Individual piece' }]} />
      </FormSection>
      <FormSection title="Logistics" cols={3}>
        <Input label="Target date" type="date" value={f.target_date} onChange={(e) => setF({ ...f, target_date: e.target.value })} />
        <Select label="Packaging store (warehouse)" value={f.warehouse_id} onChange={(e) => setF({ ...f, warehouse_id: e.target.value })} placeholder="Any store"
          options={(wh.data ?? []).map((w) => ({ value: w.id, label: w.label }))} hint="Polybag / carton stock is taken from here" />
        <Textarea label="Remarks" rows={1} value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} />
      </FormSection>
      {loading && <LoadingBlock rows={3} />}
      {preview && !rule && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800">No active packing rule applies — <Link className="underline" to="/logistics/packing/rules">add one in Packing rules</Link> (a company default with no buyer / style / PO is enough).</div>}
      {preview && rule && (
        <div className="mb-3 text-[12px] text-slate-600">Rule <b>{rule.rule_code}</b> ({rule.scope}, rev {rule.revision}): {rule.standard_pieces_per_carton} pcs / carton, {rule.pieces_per_polybag} pc / polybag,
          {n(rule.allow_mixed_sizes) ? ' mixed sizes' : ' solid size'}, {n(rule.allow_mixed_colours) ? 'mixed colours' : 'solid colour'}, partial {n(rule.allow_partial_carton) ? 'allowed' : 'not allowed'}.</div>
      )}
      {preview && (
        <section>
          <div className="mb-2 border-b border-slate-100 pb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-slate-500">Colour × size plan{preview.strict_qc ? ' · Final QC passed pieces only' : ''}</div>
          {!preview.rows.length ? <EmptyState title="Nothing finished yet" message="No bundles of this job / style have finished pieces." /> : (
            <table className="w-full text-[12.5px]" id="order-plan-table">
              <thead><tr><th className="th">Colour</th><th className="th">Size</th><th className="th text-right">Order qty</th><th className="th text-right">Ready to pack</th>
                <th className="th text-right">Held by other orders</th><th className="th text-right">Eligible</th><th className="th text-right">Planned</th></tr></thead>
              <tbody>{preview.rows.map((x) => {
                const k = `${x.color_id}:${x.size_id}`;
                return (
                  <tr key={k}><td className="td">{x.color_name}</td><td className="td">{x.size_code}</td><td className="td text-right">{fmtNumber(x.order_qty)}</td>
                    <td className="td text-right">{fmtNumber(x.ready)}{x.qc_pending ? <div className="text-[11px] text-amber-700">{x.qc_pending} QC pending</div> : null}</td>
                    <td className="td text-right">{fmtNumber(x.reserved_other)}</td><td className="td text-right font-medium">{fmtNumber(x.eligible)}</td>
                    <td className="td w-28"><input className="input text-right" data-plan={k} inputMode="numeric" value={plan[k] ?? ''} onChange={(e) => setPlan({ ...plan, [k]: e.target.value.replace(/\D/g, '') })} /></td></tr>
                );
              })}</tbody>
            </table>
          )}
        </section>
      )}
    </Modal>
  );
}
