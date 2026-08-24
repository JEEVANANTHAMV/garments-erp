import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2, Save, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions, useStyleColors, useStyleSkus, useStatuses, toPlainOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import {
  PageHeader, Input, Select, Spinner, StatusBadge, LoadingBlock, ErrorState, Tabs, Modal
} from '../../components/ui';
import { fmtDate, fmtNumber, fmtDecimal, today, toDateInput } from '../../lib/format';

const INCOTERMS = ['FOB','CIF','CFR','EXW','DDP','DAP','FCA'];
const PAY_TERMS = ['LC','TT_ADVANCE','TT_AGAINST_DOC','DA','DP','CAD','OPEN'];
const STATES = ['DRAFT','PENDING','APPROVED','REJECTED','ON_HOLD','CLOSED','CANCELLED'];

interface Line {
  _key: string;
  id?: number;
  style_id: number | '';
  color_id: number | '';
  description: string;
  unit_price: number | '';
  ship_date: string;
  /** skuId -> qty */
  skus: Record<number, number>;
}

let keySeq = 0;
const newLine = (): Line => ({
  _key: `l${++keySeq}`, style_id: '', color_id: '', description: '',
  unit_price: '', ship_date: '', skus: {},
});

export default function SalesOrderDetail() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [tab, setTab] = useState('lines');
  const [head, setHead] = useState<Record<string, any>>({
    so_date: today(), incoterm: 'FOB', payment_term: 'LC', exchange_rate: 1,
  });
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [stateModal, setStateModal] = useState(false);

  const buyers = useLookup('buyers');
  const agents = useLookup('agents');
  const currencies = useLookup('currencies');
  const countries = useLookup('countries');
  const branches = useLookup('branches');
  const statuses = useStatuses('SALES_ORDER');

  const detail = useQuery({
    queryKey: ['sales-orders', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/sales-orders/${id}`)).data,
    enabled: !isNew,
  });

  // Hydrate the form once the record arrives.
  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data;
    setHead({
      ...d,
      so_date: toDateInput(d.so_date), buyer_po_date: toDateInput(d.buyer_po_date),
      lc_date: toDateInput(d.lc_date), lc_expiry: toDateInput(d.lc_expiry),
      ship_date: toDateInput(d.ship_date), delivery_date: toDateInput(d.delivery_date),
    });
    setLines((d.lines ?? []).map((l: any) => ({
      _key: `l${++keySeq}`, id: l.id, style_id: l.style_id, color_id: l.color_id ?? '',
      description: l.description ?? '', unit_price: Number(l.unit_price),
      ship_date: toDateInput(l.ship_date),
      skus: Object.fromEntries((l.skus ?? []).map((s: any) => [s.sku_id, Number(s.qty)])),
    })));
  }, [detail.data]);

  const totals = useMemo(() => {
    let qty = 0, amount = 0;
    for (const l of lines) {
      const q = Object.values(l.skus).reduce((a, b) => a + (Number(b) || 0), 0);
      qty += q; amount += q * (Number(l.unit_price) || 0);
    }
    return { qty, amount };
  }, [lines]);

  const locked = !isNew && ['APPROVED', 'CLOSED', 'CANCELLED'].includes(head.approval_state);
  const editable = (isNew ? can('SALES_ORDER.CREATE') : can('SALES_ORDER.UPDATE')) && !locked;

  const setH = (k: string, v: unknown) => setHead((s) => ({ ...s, [k]: v }));
  const setLine = (key: string, patch: Partial<Line>) =>
    setLines((s) => s.map((l) => (l._key === key ? { ...l, ...patch } : l)));

  const save = async () => {
    setErrors({}); setSaving(true);
    try {
      const payload = {
        ...head,
        lines: lines
          .filter((l) => l.style_id)
          .map((l) => ({
            style_id: Number(l.style_id),
            color_id: l.color_id === '' ? null : Number(l.color_id),
            description: l.description || null,
            unit_price: Number(l.unit_price) || 0,
            ship_date: l.ship_date || null,
            skus: Object.entries(l.skus)
              .filter(([, q]) => Number(q) > 0)
              .map(([sku_id, qty]) => ({ sku_id: Number(sku_id), qty: Number(qty) })),
          })),
      };
      if (!payload.lines.length) { toast('Add at least one order line', 'error'); setSaving(false); return; }

      const res = isNew
        ? await http.post<{ data: any }>('/sales-orders', payload)
        : await http.put<{ data: any }>(`/sales-orders/${id}`, payload);

      toast(`Sales order ${isNew ? 'created' : 'updated'} successfully`);
      void qc.invalidateQueries({ queryKey: ['sales-orders'] });
      if (isNew) nav(`/sales/orders/${res.data.id}`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        toast(e.message, 'error');
      }
    } finally { setSaving(false); }
  };

  const changeState = async (newState: string) => {
    try {
      await http.post(`/sales-orders/${id}/approval-state`, { approval_state: newState });
      toast(`Order moved to ${newState.replace(/_/g, ' ').toLowerCase()}`);
      void detail.refetch();
      void qc.invalidateQueries({ queryKey: ['sales-orders'] });
      setStateModal(false);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not change state', 'error');
    }
  };

  if (!isNew && detail.isLoading) return <div className="card"><LoadingBlock rows={8} /></div>;
  if (!isNew && detail.error) return <div className="card"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div>;

  const d = detail.data;

  return (
    <>
      <PageHeader
        breadcrumb={['Sales', 'Sales Orders']}
        title={isNew ? 'New Sales Order' : d?.so_no ?? 'Sales Order'}
        subtitle={isNew ? 'Capture a confirmed buyer order' : `${d?.buyer_name ?? ''} · ${fmtDate(d?.so_date)}`}
        actions={<>
          <button className="btn-secondary" onClick={() => nav('/sales/orders')}>
            <ArrowLeft size={15} /> Back
          </button>
          {!isNew && can('SALES_ORDER.APPROVE') && (
            <button className="btn-secondary" onClick={() => setStateModal(true)}>
              <CheckCircle2 size={15} /> Change state
            </button>
          )}
          {editable && (
            <button className="btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size={15} /> : <Save size={15} />} Save
            </button>
          )}
        </>} />

      {locked && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900">
          This order is <strong>{head.approval_state?.toLowerCase()}</strong> and is locked for editing.
          Change its state to make further changes.
        </div>
      )}

      {/* Header form */}
      <div className="card mb-4 p-4">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-3 lg:grid-cols-4">
          <Input label="SO number" hint={isNew ? 'Blank to auto-generate' : undefined}
            value={head.so_no ?? ''} onChange={(e) => setH('so_no', e.target.value)}
            disabled={!editable} error={errors.so_no} />
          <Input label="SO date" type="date" required value={head.so_date ?? ''}
            onChange={(e) => setH('so_date', e.target.value)} disabled={!editable} error={errors.so_date} />
          <Select label="Buyer" required options={toOptions(buyers.data)} placeholder="— Select buyer —"
            value={head.buyer_id ?? ''} onChange={(e) => setH('buyer_id', e.target.value)}
            disabled={!editable} error={errors.buyer_id} />
          <Select label="Agent" options={toOptions(agents.data)} placeholder="— None —"
            value={head.agent_id ?? ''} onChange={(e) => setH('agent_id', e.target.value)} disabled={!editable} />

          <Input label="Buyer PO no" value={head.buyer_po_no ?? ''}
            onChange={(e) => setH('buyer_po_no', e.target.value)} disabled={!editable} />
          <Input label="Buyer PO date" type="date" value={head.buyer_po_date ?? ''}
            onChange={(e) => setH('buyer_po_date', e.target.value)} disabled={!editable} />
          <Input label="Season" placeholder="e.g. SS26" value={head.season ?? ''}
            onChange={(e) => setH('season', e.target.value)} disabled={!editable} />
          <Select label="Branch" options={toOptions(branches.data)} placeholder="— Select —"
            value={head.branch_id ?? ''} onChange={(e) => setH('branch_id', e.target.value)} disabled={!editable} />

          <Select label="Currency" required options={toOptions(currencies.data)} placeholder="— Select —"
            value={head.currency_id ?? ''} onChange={(e) => setH('currency_id', e.target.value)}
            disabled={!editable} error={errors.currency_id} />
          <Input label="Exchange rate" type="number" step="0.000001" value={head.exchange_rate ?? ''}
            onChange={(e) => setH('exchange_rate', e.target.value)} disabled={!editable} />
          <Select label="Incoterm" options={INCOTERMS.map((v) => ({ value: v, label: v }))}
            value={head.incoterm ?? 'FOB'} onChange={(e) => setH('incoterm', e.target.value)} disabled={!editable} />
          <Select label="Payment term" options={PAY_TERMS.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))}
            value={head.payment_term ?? 'LC'} onChange={(e) => setH('payment_term', e.target.value)} disabled={!editable} />

          <Input label="Port of loading" value={head.port_of_loading ?? ''}
            onChange={(e) => setH('port_of_loading', e.target.value)} disabled={!editable} />
          <Select label="Destination country" options={toOptions(countries.data)} placeholder="— Select —"
            value={head.destination_country ?? ''} onChange={(e) => setH('destination_country', e.target.value)}
            disabled={!editable} />
          <Input label="Destination port" value={head.destination_port ?? ''}
            onChange={(e) => setH('destination_port', e.target.value)} disabled={!editable} />
          <Select label="Status" options={toPlainOptions(statuses.data)} placeholder="— Select —"
            value={head.status_id ?? ''} onChange={(e) => setH('status_id', e.target.value)} disabled={!editable} />

          <Input label="Ship date" type="date" value={head.ship_date ?? ''}
            onChange={(e) => setH('ship_date', e.target.value)} disabled={!editable} />
          <Input label="Delivery date" type="date" value={head.delivery_date ?? ''}
            onChange={(e) => setH('delivery_date', e.target.value)} disabled={!editable} />
          <Input label="LC number" value={head.lc_no ?? ''}
            onChange={(e) => setH('lc_no', e.target.value)} disabled={!editable} />
          <Input label="LC expiry" type="date" value={head.lc_expiry ?? ''}
            onChange={(e) => setH('lc_expiry', e.target.value)} disabled={!editable} />
        </div>
      </div>

      {!isNew && (
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'lines', label: 'Order lines', count: lines.length },
          { key: 'production', label: 'Production', count: d?.production_orders?.length ?? 0 },
          { key: 'invoices', label: 'Invoices', count: d?.invoices?.length ?? 0 },
        ]} />
      )}

      {(isNew || tab === 'lines') && (
        <div className="space-y-3">
          {lines.map((line, idx) => (
            <LineCard key={line._key} line={line} index={idx} editable={editable}
              onChange={(patch) => setLine(line._key, patch)}
              onRemove={() => setLines((s) => s.filter((l) => l._key !== line._key))}
              canRemove={lines.length > 1} />
          ))}

          {editable && (
            <button className="btn-secondary w-full justify-center border-dashed py-2.5"
              onClick={() => setLines((s) => [...s, newLine()])}>
              <Plus size={15} /> Add order line
            </button>
          )}

          <div className="card flex flex-wrap items-center justify-end gap-6 p-4">
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Total quantity</p>
              <p className="text-[19px] font-semibold tabular-nums text-slate-900">{fmtNumber(totals.qty)} pcs</p>
            </div>
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Total value</p>
              <p className="text-[19px] font-semibold tabular-nums text-slate-900">
                {currencies.data?.find((c) => c.id === Number(head.currency_id))?.code ?? ''}{' '}
                {totals.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>
        </div>
      )}

      {!isNew && tab === 'production' && (
        <div className="card overflow-hidden">
          {d?.production_orders?.length ? (
            <table className="w-full">
              <thead><tr>
                <th className="th">Work order</th><th className="th text-right">Order qty</th>
                <th className="th text-right">Produced</th><th className="th">State</th>
              </tr></thead>
              <tbody>
                {d.production_orders.map((p: any) => (
                  <tr key={p.id} className="row-hover">
                    <td className="td font-mono text-[12px] text-brand-700">{p.po_prod_no}</td>
                    <td className="td text-right tabular-nums">{fmtNumber(p.order_qty)}</td>
                    <td className="td text-right tabular-nums">{fmtNumber(p.produced_qty)}</td>
                    <td className="td"><StatusBadge value={p.approval_state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="p-8 text-center text-[13px] text-slate-400">No production orders raised yet.</p>}
        </div>
      )}

      {!isNew && tab === 'invoices' && (
        <div className="card overflow-hidden">
          {d?.invoices?.length ? (
            <table className="w-full">
              <thead><tr>
                <th className="th">Invoice</th><th className="th">Date</th><th className="th text-right">Value</th>
              </tr></thead>
              <tbody>
                {d.invoices.map((i: any) => (
                  <tr key={i.id} className="row-hover">
                    <td className="td font-mono text-[12px] text-brand-700">{i.invoice_no}</td>
                    <td className="td">{fmtDate(i.invoice_date)}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(i.total_value, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="p-8 text-center text-[13px] text-slate-400">No invoices raised yet.</p>}
        </div>
      )}

      <Modal open={stateModal} onClose={() => setStateModal(false)} title="Change order state" size="sm">
        <p className="mb-3 text-[13px] text-slate-600">
          Current state: <StatusBadge value={head.approval_state} />
        </p>
        <div className="grid grid-cols-2 gap-2">
          {STATES.filter((s) => s !== head.approval_state).map((s) => (
            <button key={s} className="btn-secondary justify-start" onClick={() => void changeState(s)}>
              {s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------ order line card */
function LineCard({ line, index, editable, onChange, onRemove, canRemove }: {
  line: Line; index: number; editable: boolean;
  onChange: (p: Partial<Line>) => void; onRemove: () => void; canRemove: boolean;
}) {
  const styles = useLookup('styles');
  const colors = useStyleColors(line.style_id ? Number(line.style_id) : null);
  const skus = useStyleSkus(line.style_id ? Number(line.style_id) : null);

  // Only show sizes for the colour chosen on this line.
  const visibleSkus = useMemo(() => {
    const all = skus.data ?? [];
    return line.color_id ? all.filter((s) => s.color_id === Number(line.color_id)) : all;
  }, [skus.data, line.color_id]);

  const lineQty = Object.entries(line.skus)
    .filter(([id]) => visibleSkus.some((s) => s.id === Number(id)))
    .reduce((a, [, q]) => a + (Number(q) || 0), 0);
  const lineAmount = lineQty * (Number(line.unit_price) || 0);

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
          Line {index + 1}
        </span>
        {editable && canRemove && (
          <button onClick={onRemove} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
            title="Remove line">
            <Trash2 size={15} />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <Select label="Style" required options={toOptions(styles.data)} placeholder="— Select style —"
          value={line.style_id} disabled={!editable}
          onChange={(e) => onChange({
            style_id: e.target.value ? Number(e.target.value) : '', color_id: '', skus: {},
          })} />
        <Select label="Colour" options={colors.data?.map((c) => ({ value: c.id, label: c.label })) ?? []}
          placeholder={line.style_id ? '— All colours —' : 'Select a style first'}
          value={line.color_id} disabled={!editable || !line.style_id}
          onChange={(e) => onChange({ color_id: e.target.value ? Number(e.target.value) : '', skus: {} })} />
        <Input label="Unit price" type="number" step="0.0001" value={line.unit_price}
          disabled={!editable}
          onChange={(e) => onChange({ unit_price: e.target.value === '' ? '' : Number(e.target.value) })} />
        <Input label="Line ship date" type="date" value={line.ship_date} disabled={!editable}
          onChange={(e) => onChange({ ship_date: e.target.value })} />
      </div>

      {/* Size grid */}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[12px] font-semibold text-slate-700">Size-wise breakdown</p>
          {lineQty > 0 && (
            <p className="text-[12px] text-slate-500">
              <span className="font-semibold text-slate-800">{fmtNumber(lineQty)}</span> pcs ·{' '}
              <span className="font-semibold text-slate-800">
                {lineAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </p>
          )}
        </div>

        {!line.style_id ? (
          <p className="rounded-lg bg-surface-muted px-3 py-3 text-[12.5px] text-slate-400">
            Select a style to enter size-wise quantities.
          </p>
        ) : skus.isLoading ? (
          <div className="skeleton h-14" />
        ) : visibleSkus.length === 0 ? (
          <p className="rounded-lg bg-amber-50 px-3 py-3 text-[12.5px] text-amber-800">
            This style has no SKUs yet. Generate them from the style screen first.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-surface-border">
            <table className="w-full">
              <thead>
                <tr>
                  {!line.color_id && <th className="th">Colour</th>}
                  {[...new Map(visibleSkus.map((s) => [s.size_code, s])).values()]
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map((s) => <th key={s.size_code} className="th text-center">{s.size_code}</th>)}
                  <th className="th text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {groupByColor(visibleSkus).map(([colorName, group]) => {
                  const rowTotal = group.reduce((a, s) => a + (Number(line.skus[s.id]) || 0), 0);
                  return (
                    <tr key={colorName}>
                      {!line.color_id && (
                        <td className="td whitespace-nowrap font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block h-3 w-3 rounded-sm border border-slate-200"
                              style={{ background: group[0]?.hex_value ?? '#f1f5f9' }} />
                            {colorName}
                          </span>
                        </td>
                      )}
                      {group.sort((a, b) => a.sort_order - b.sort_order).map((s) => (
                        <td key={s.id} className="td p-1 text-center">
                          <input type="number" min={0} disabled={!editable}
                            className="w-[68px] rounded-md border border-surface-border px-1.5 py-1 text-center
                                       text-[12.5px] tabular-nums focus:border-brand-500 focus:outline-none
                                       focus:ring-1 focus:ring-brand-500/25 disabled:bg-slate-50"
                            value={line.skus[s.id] ?? ''}
                            placeholder="0"
                            onChange={(e) => {
                              const q = e.target.value === '' ? 0 : Math.max(0, Number(e.target.value));
                              onChange({ skus: { ...line.skus, [s.id]: q } });
                            }} />
                        </td>
                      ))}
                      <td className="td text-right font-semibold tabular-nums">{fmtNumber(rowTotal)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function groupByColor(skus: { id: number; color_name: string; hex_value: string | null; size_code: string; sort_order: number }[]) {
  const map = new Map<string, typeof skus>();
  for (const s of skus) {
    if (!map.has(s.color_name)) map.set(s.color_name, []);
    map.get(s.color_name)!.push(s);
  }
  return [...map.entries()];
}
