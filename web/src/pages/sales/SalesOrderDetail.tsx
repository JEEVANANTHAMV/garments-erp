import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2, Save, CheckCircle2, Sparkles, Check, X } from 'lucide-react';
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
  excess_pct?: number | '';
  plan_cut_qty?: number;
  ship_date: string;
  /** skuId -> qty */
  skus: Record<number, number>;
}

let keySeq = 0;
const newLine = (): Line => ({
  _key: `l${++keySeq}`, style_id: '', color_id: '', description: '',
  unit_price: '', excess_pct: '', plan_cut_qty: 0, ship_date: '', skus: {},
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
    so_date: today(),
    incoterm: 'FOB',
    payment_term: 'LC',
    exchange_rate: 1,
    excess_pct: 5,
    tolerance_plus_pct: 5,
    tolerance_minus_pct: 3,
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
      excess_pct: d.excess_pct !== null && d.excess_pct !== undefined ? Number(d.excess_pct) : 5,
      tolerance_plus_pct: d.tolerance_plus_pct !== null && d.tolerance_plus_pct !== undefined ? Number(d.tolerance_plus_pct) : 5,
      tolerance_minus_pct: d.tolerance_minus_pct !== null && d.tolerance_minus_pct !== undefined ? Number(d.tolerance_minus_pct) : 3,
      so_date: toDateInput(d.so_date), buyer_po_date: toDateInput(d.buyer_po_date),
      lc_date: toDateInput(d.lc_date), lc_expiry: toDateInput(d.lc_expiry),
      ship_date: toDateInput(d.ship_date), delivery_date: toDateInput(d.delivery_date),
    });
    setLines((d.lines ?? []).map((l: any) => ({
      _key: `l${++keySeq}`, id: l.id, style_id: l.style_id, color_id: l.color_id ?? '',
      description: l.description ?? '', unit_price: Number(l.unit_price),
      excess_pct: l.excess_pct !== null && l.excess_pct !== undefined ? Number(l.excess_pct) : '',
      plan_cut_qty: Number(l.plan_cut_qty || 0),
      ship_date: toDateInput(l.ship_date),
      skus: Object.fromEntries((l.skus ?? []).map((s: any) => [s.sku_id, Number(s.qty)])),
    })));
  }, [detail.data]);

  const totals = useMemo(() => {
    let qty = 0, amount = 0, planCutQty = 0;
    const defaultExcess = Number(head.excess_pct) || 0;
    for (const l of lines) {
      const q = Object.values(l.skus).reduce((a, b) => a + (Number(b) || 0), 0);
      const lineExcess = (l.excess_pct !== '' && l.excess_pct !== undefined) ? Number(l.excess_pct) : defaultExcess;
      const linePlanCut = Math.round(q * (1 + (lineExcess || 0) / 100));
      qty += q;
      planCutQty += linePlanCut;
      amount += q * (Number(l.unit_price) || 0);
    }
    const excessQty = Math.max(0, planCutQty - qty);
    const excessPct = qty > 0 ? (excessQty / qty) * 100 : defaultExcess;
    const tolPlusPct = Number(head.tolerance_plus_pct) || 0;
    const tolMinusPct = Number(head.tolerance_minus_pct) || 0;
    const maxShipment = Math.round(qty * (1 + tolPlusPct / 100));
    const minShipment = Math.round(qty * (1 - tolMinusPct / 100));

    return { qty, amount, planCutQty, excessQty, excessPct, tolPlusPct, tolMinusPct, maxShipment, minShipment };
  }, [lines, head.excess_pct, head.tolerance_plus_pct, head.tolerance_minus_pct]);

  const selectedCurrency = currencies.data?.find((c) => c.id === Number(head.currency_id));
  const currencyCode = String(selectedCurrency?.code ?? 'USD');
  const currencySymbol = String((selectedCurrency as any)?.symbol ?? (currencyCode === 'INR' ? '₹' : '$'));
  const isForeign = currencyCode !== 'INR';
  const exchangeRate = Number(head.exchange_rate) > 0 ? Number(head.exchange_rate) : (isForeign ? 83.5 : 1);
  const inrAmount = totals.amount * (Number(head.exchange_rate) || 1);

  const locked = !isNew && ['APPROVED', 'CLOSED', 'CANCELLED'].includes(head.approval_state);
  const editable = (isNew ? can('SALES_ORDER.CREATE') : can('SALES_ORDER.UPDATE')) && !locked;

  const setH = (k: string, v: unknown) => setHead((s) => ({ ...s, [k]: v }));
  const setLine = (key: string, patch: Partial<Line>) =>
    setLines((s) => s.map((l) => (l._key === key ? { ...l, ...patch } : l)));

  const handleBuyerChange = (bId: string) => {
    setH('buyer_id', bId);
    const buyer = buyers.data?.find((b: any) => b.id === Number(bId));
    if (buyer?.currency_id && (!head.currency_id || isNew)) {
      setH('currency_id', buyer.currency_id);
      const curr = currencies.data?.find((c: any) => c.id === Number(buyer.currency_id));
      if (curr?.code === 'USD' && (!head.exchange_rate || Number(head.exchange_rate) === 1)) setH('exchange_rate', 83.5);
      else if (curr?.code === 'EUR' && (!head.exchange_rate || Number(head.exchange_rate) === 1)) setH('exchange_rate', 91.0);
      else if (curr?.code === 'GBP' && (!head.exchange_rate || Number(head.exchange_rate) === 1)) setH('exchange_rate', 106.0);
      else if (curr?.code === 'INR') setH('exchange_rate', 1);
    }
  };

  const handleCurrencyChange = (cId: string) => {
    setH('currency_id', cId);
    const curr = currencies.data?.find((c: any) => c.id === Number(cId));
    if (curr?.code === 'USD' && (!head.exchange_rate || Number(head.exchange_rate) === 1)) setH('exchange_rate', 83.5);
    else if (curr?.code === 'EUR' && (!head.exchange_rate || Number(head.exchange_rate) === 1)) setH('exchange_rate', 91.0);
    else if (curr?.code === 'GBP' && (!head.exchange_rate || Number(head.exchange_rate) === 1)) setH('exchange_rate', 106.0);
    else if (curr?.code === 'INR') setH('exchange_rate', 1);
  };

  const save = async () => {
    setErrors({}); setSaving(true);
    try {
      const defaultExcess = Number(head.excess_pct) || 0;
      const payload = {
        ...head,
        excess_pct: Number(head.excess_pct || 0),
        tolerance_plus_pct: Number(head.tolerance_plus_pct || 0),
        tolerance_minus_pct: Number(head.tolerance_minus_pct || 0),
        lines: lines
          .filter((l) => l.style_id)
          .map((l) => {
            const lineQty = Object.values(l.skus).reduce((a, b) => a + (Number(b) || 0), 0);
            const lineExcess = (l.excess_pct !== '' && l.excess_pct !== undefined) ? Number(l.excess_pct) : defaultExcess;
            const planCut = Math.round(lineQty * (1 + lineExcess / 100));
            return {
              style_id: Number(l.style_id),
              color_id: l.color_id === '' ? null : Number(l.color_id),
              description: l.description || null,
              unit_price: Number(l.unit_price) || 0,
              excess_pct: l.excess_pct === '' || l.excess_pct === undefined ? null : Number(l.excess_pct),
              plan_cut_qty: planCut,
              ship_date: l.ship_date || null,
              skus: Object.entries(l.skus)
                .filter(([, q]) => Number(q) > 0)
                .map(([sku_id, qty]) => ({ sku_id: Number(sku_id), qty: Number(qty) })),
            };
          }),
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
            value={head.buyer_id ?? ''} onChange={(e) => handleBuyerChange(e.target.value)}
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
            value={head.currency_id ?? ''} onChange={(e) => handleCurrencyChange(e.target.value)}
            disabled={!editable} error={errors.currency_id} />
          <Input
            label="Exchange rate (to INR)"
            type="number"
            step="0.0001"
            value={head.exchange_rate ?? ''}
            hint={isForeign ? `1 ${currencyCode} = ₹ ${exchangeRate.toFixed(2)} INR` : '1.00 for INR'}
            placeholder={isForeign ? '83.50' : '1.00'}
            onChange={(e) => setH('exchange_rate', e.target.value)}
            disabled={!editable}
          />
          <Input
            label="Excess cutting % (Factory Buffer)"
            type="number"
            step="0.1"
            min="0"
            placeholder="5.0"
            value={head.excess_pct ?? ''}
            hint="Extra cutting buffer for defect allowance (e.g. 5%)"
            onChange={(e) => setH('excess_pct', e.target.value === '' ? '' : Number(e.target.value))}
            disabled={!editable}
          />
          <Input
            label="Shipment Tolerance + % (Max Overage)"
            type="number"
            step="0.1"
            min="0"
            placeholder="5.0"
            value={head.tolerance_plus_pct ?? ''}
            hint="Buyer contract max overage (e.g. +5%)"
            onChange={(e) => setH('tolerance_plus_pct', e.target.value === '' ? '' : Number(e.target.value))}
            disabled={!editable}
          />
          <Input
            label="Shipment Tolerance - % (Max Shortage)"
            type="number"
            step="0.1"
            min="0"
            placeholder="3.0"
            value={head.tolerance_minus_pct ?? ''}
            hint="Buyer contract max shortage (e.g. -3%)"
            onChange={(e) => setH('tolerance_minus_pct', e.target.value === '' ? '' : Number(e.target.value))}
            disabled={!editable}
          />

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
            <LineCard
              key={line._key}
              line={line}
              index={idx}
              editable={editable}
              currencyCode={currencyCode}
              currencySymbol={currencySymbol}
              exchangeRate={exchangeRate}
              isForeign={isForeign}
              headExcessPct={Number(head.excess_pct) || 5}
              onChange={(patch) => setLine(line._key, patch)}
              onRemove={() => setLines((s) => s.filter((l) => l._key !== line._key))}
              canRemove={lines.length > 1}
            />
          ))}

          {editable && (
            <button className="btn-secondary w-full justify-center border-dashed py-2.5"
              onClick={() => setLines((s) => [...s, newLine()])}>
              <Plus size={15} /> Add order line
            </button>
          )}

          <div className="card flex flex-wrap items-center justify-between gap-6 p-4.5 bg-gradient-to-r from-slate-50 to-brand-50/20 border border-surface-border rounded-xl shadow-card">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {isForeign ? (
                <div className="inline-flex items-center gap-2 rounded-lg bg-white border border-brand-200/80 px-3 py-1.5 shadow-xs">
                  <span className="text-slate-500 font-medium">Applied Exchange Rate:</span>
                  <span className="font-mono font-bold text-brand-800">
                    1 {currencyCode} = ₹ {exchangeRate.toFixed(2)} INR
                  </span>
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-lg bg-white border border-slate-200 px-3 py-1.5 shadow-xs">
                  <span className="text-slate-500 font-medium">Order Currency:</span>
                  <span className="font-mono font-bold text-slate-800">INR (Domestic)</span>
                </div>
              )}
              {totals.qty > 0 && (
                <div className="inline-flex items-center gap-2 rounded-lg bg-white border border-slate-200 px-3 py-1.5 shadow-xs" title="Buyer contract allowed shipment window">
                  <span className="text-slate-500 font-medium">Shipment Window:</span>
                  <span className="font-mono font-bold text-slate-800">
                    {fmtNumber(totals.minShipment)} – {fmtNumber(totals.maxShipment)} pcs
                  </span>
                  <span className="text-[10.5px] text-slate-400">
                    (-{totals.tolMinusPct}% / +{totals.tolPlusPct}%)
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-5 sm:gap-6">
              <div className="text-right">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">Order Qty (Invoice)</p>
                <p className="text-[20px] font-bold tabular-nums text-slate-900">
                  {fmtNumber(totals.qty)} <span className="text-xs font-normal text-slate-500">pcs</span>
                </p>
              </div>

              <div className="text-right border-l border-slate-200/80 pl-4">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-amber-700">
                  Excess Buffer ({totals.excessPct.toFixed(1)}%)
                </p>
                <p className="text-[20px] font-bold tabular-nums text-amber-800">
                  +{fmtNumber(totals.excessQty)} <span className="text-xs font-normal text-slate-500">pcs</span>
                </p>
              </div>

              <div className="text-right border-l border-slate-200/80 pl-4">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-brand-700">Planned Cut Qty</p>
                <p className="text-[20px] font-extrabold tabular-nums text-brand-900">
                  {fmtNumber(totals.planCutQty)} <span className="text-xs font-normal text-slate-500">pcs</span>
                </p>
              </div>

              <div className="text-right border-l border-slate-200/80 pl-4">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-500">
                  Total Value ({currencyCode})
                </p>
                <p className="text-[20px] font-bold tabular-nums text-slate-900">
                  {currencyCode} {currencySymbol}{' '}
                  {totals.amount.toLocaleString(isForeign ? 'en-US' : 'en-IN', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
              </div>

              {isForeign && (
                <div className="text-right border-l border-brand-200 pl-4 bg-brand-50/70 py-1.5 px-3 rounded-lg border border-brand-200">
                  <p className="text-[11px] uppercase tracking-wider font-bold text-brand-700">
                    Total Value in INR (₹)
                  </p>
                  <p className="text-[20px] font-extrabold tabular-nums text-brand-800">
                    ₹ {inrAmount.toLocaleString('en-IN', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                </div>
              )}
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

/** Hare-Niemeyer Largest Remainder Distribution for exact integer split with 0 rounding discrepancies */
function distributeByRatio(
  targetQty: number,
  ratios: { key: string; ratio: number }[]
): Record<string, number> {
  const valid = ratios.map((r) => ({ ...r, ratio: Math.max(0, Number(r.ratio) || 0) }));
  const totalRatio = valid.reduce((sum, r) => sum + r.ratio, 0);

  if (totalRatio <= 0 || targetQty <= 0) {
    return Object.fromEntries(valid.map((r) => [r.key, 0]));
  }

  const allocations = valid.map((r) => {
    const exact = (targetQty * r.ratio) / totalRatio;
    const base = Math.floor(exact);
    const remainder = exact - base;
    return { key: r.key, base, remainder, ratio: r.ratio };
  });

  const currentSum = allocations.reduce((sum, a) => sum + a.base, 0);
  const diff = targetQty - currentSum;

  const sorted = [...allocations].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < diff; i++) {
    sorted[i % sorted.length].base += 1;
  }

  return Object.fromEntries(sorted.map((a) => [a.key, a.base]));
}

/* ------------------------------------------------------ Ratio Split Assistant */
function RatioSplitAssistant({
  sizes,
  colorGroups,
  activeColorId,
  excessPct = 0,
  onApply,
  onClear,
  onClose,
}: {
  sizes: { size_code: string; sort_order: number }[];
  colorGroups: [string, any[]][];
  activeColorId?: number | '';
  excessPct?: number;
  onApply: (skusToSet: Record<number, number>) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'target' | 'pack'>('target');
  const [targetQty, setTargetQty] = useState<string>('10000');
  const [packCount, setPackCount] = useState<string>('500');
  const [ratioStr, setRatioStr] = useState<string>('');
  const [selectedColor, setSelectedColor] = useState<string>('ALL');
  const [splitMultiColor, setSplitMultiColor] = useState<'each' | 'equal'>('each');

  // Initial default ratio (1 for each size or standard preset)
  const [ratios, setRatios] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    if (sizes.length === 4) {
      [1, 2, 2, 1].forEach((r, idx) => { if (sizes[idx]) init[sizes[idx].size_code] = r; });
    } else if (sizes.length === 5) {
      [1, 2, 3, 2, 1].forEach((r, idx) => { if (sizes[idx]) init[sizes[idx].size_code] = r; });
    } else if (sizes.length === 6) {
      [1, 2, 3, 3, 2, 1].forEach((r, idx) => { if (sizes[idx]) init[sizes[idx].size_code] = r; });
    } else {
      sizes.forEach((s) => { init[s.size_code] = 1; });
    }
    return init;
  });

  const totalRatioUnits = useMemo(() => {
    return sizes.reduce((sum, s) => sum + (Number(ratios[s.size_code]) || 0), 0);
  }, [sizes, ratios]);

  // Handle quick text ratio string change (e.g. "1:2:3:2:1" or "1 2 3 2 1" or "1-2-2-1")
  const applyRatioString = (str: string) => {
    setRatioStr(str);
    const parts = str.trim().split(/[:\s,\-_/]+/).map((v) => Number(v)).filter((v) => !isNaN(v) && v >= 0);
    if (parts.length > 0) {
      const next: Record<string, number> = { ...ratios };
      sizes.forEach((s, idx) => {
        if (idx < parts.length) {
          next[s.size_code] = parts[idx];
        }
      });
      setRatios(next);
    }
  };

  const applyPreset = (preset: number[]) => {
    const next: Record<string, number> = { ...ratios };
    sizes.forEach((s, idx) => {
      next[s.size_code] = idx < preset.length ? preset[idx] : 1;
    });
    setRatios(next);
    setRatioStr(preset.join(':'));
  };

  // Determine presets based on size count
  const presets: { label: string; values: number[] }[] = useMemo(() => {
    if (sizes.length === 4) {
      return [
        { label: '1 : 2 : 2 : 1 (6-pack)', values: [1, 2, 2, 1] },
        { label: '1 : 2 : 3 : 2 (8-pack)', values: [1, 2, 3, 2] },
        { label: '2 : 3 : 3 : 2 (10-pack)', values: [2, 3, 3, 2] },
        { label: '1 : 1 : 1 : 1 (Equal)', values: [1, 1, 1, 1] },
      ];
    }
    if (sizes.length === 5) {
      return [
        { label: '1 : 2 : 3 : 2 : 1 (9-pack)', values: [1, 2, 3, 2, 1] },
        { label: '1 : 2 : 2 : 2 : 1 (8-pack)', values: [1, 2, 2, 2, 1] },
        { label: '1 : 3 : 4 : 3 : 1 (12-pack)', values: [1, 3, 4, 3, 1] },
        { label: '2 : 3 : 4 : 3 : 2 (14-pack)', values: [2, 3, 4, 3, 2] },
        { label: '1 : 1 : 1 : 1 : 1 (Equal)', values: [1, 1, 1, 1, 1] },
      ];
    }
    if (sizes.length === 6) {
      return [
        { label: '1 : 2 : 3 : 3 : 2 : 1 (12-pack)', values: [1, 2, 3, 3, 2, 1] },
        { label: '1 : 2 : 4 : 4 : 2 : 1 (14-pack)', values: [1, 2, 4, 4, 2, 1] },
        { label: '1 : 1 : 1 : 1 : 1 : 1 (Equal)', values: [1, 1, 1, 1, 1, 1] },
      ];
    }
    return [
      { label: 'Equal (1:1:...:1)', values: sizes.map(() => 1) },
    ];
  }, [sizes]);

  // Target per color calculation
  const effectiveTargetPerColor = useMemo(() => {
    if (mode === 'pack') {
      const p = Number(packCount) || 0;
      return p * totalRatioUnits;
    }
    const t = Number(targetQty) || 0;
    const targetColorsCount = (selectedColor === 'ALL' && !activeColorId) ? colorGroups.length : 1;
    if (targetColorsCount > 1 && splitMultiColor === 'equal') {
      return Math.round(t / targetColorsCount);
    }
    return t;
  }, [mode, packCount, targetQty, totalRatioUnits, selectedColor, activeColorId, colorGroups.length, splitMultiColor]);

  // Size distribution breakdown per color
  const sizeDistribution = useMemo(() => {
    if (mode === 'pack') {
      const p = Number(packCount) || 0;
      const res: Record<string, number> = {};
      sizes.forEach((s) => {
        res[s.size_code] = (Number(ratios[s.size_code]) || 0) * p;
      });
      return res;
    }
    const ratioItems = sizes.map((s) => ({ key: s.size_code, ratio: Number(ratios[s.size_code]) || 0 }));
    return distributeByRatio(effectiveTargetPerColor, ratioItems);
  }, [mode, packCount, sizes, ratios, effectiveTargetPerColor]);

  const previewColorCount = (selectedColor === 'ALL' && !activeColorId) ? colorGroups.length : 1;
  const singleColorTotal = Object.values(sizeDistribution).reduce((a, b) => a + b, 0);
  const grandTotalPreview = singleColorTotal * previewColorCount;

  // Handle Apply
  const handleApply = () => {
    const nextSkus: Record<number, number> = {};
    const targetGroups = (selectedColor === 'ALL' && !activeColorId)
      ? colorGroups
      : colorGroups.filter(([cName]) => cName === selectedColor || activeColorId);

    targetGroups.forEach(([, skusList]) => {
      skusList.forEach((sku) => {
        const qty = sizeDistribution[sku.size_code] ?? 0;
        nextSkus[sku.id] = qty;
      });
    });

    onApply(nextSkus);
  };

  return (
    <div className="mb-4 rounded-xl border-2 border-brand-300 bg-gradient-to-br from-brand-50/40 via-white to-slate-50 p-4 shadow-md">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-100 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-xs">
            <Sparkles size={16} />
          </div>
          <div>
            <h4 className="text-sm font-bold text-slate-900">⚡ Ratio-Based Size Split Assistant</h4>
            <p className="text-xs text-slate-500">Auto-distribute bulk order quantities or pre-pack cartons across sizes</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-rose-600 hover:text-rose-800 font-semibold px-2 py-1 hover:bg-rose-50 rounded"
          >
            Clear Quantities
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Modes & Settings */}
      <div className="mt-3.5 grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {/* Mode Selector */}
        <div>
          <label className="text-[11.5px] font-bold text-slate-700 uppercase tracking-wide block mb-1.5">
            Distribution Mode
          </label>
          <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setMode('target')}
              className={`text-xs py-1.5 px-2 rounded-md font-semibold transition-all ${
                mode === 'target'
                  ? 'bg-white text-brand-800 shadow-xs border border-brand-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              🎯 Total Qty Split
            </button>
            <button
              type="button"
              onClick={() => setMode('pack')}
              className={`text-xs py-1.5 px-2 rounded-md font-semibold transition-all ${
                mode === 'pack'
                  ? 'bg-white text-brand-800 shadow-xs border border-brand-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              📦 Pack Multiplier
            </button>
          </div>
        </div>

        {/* Input Target */}
        <div>
          <label className="text-[11.5px] font-bold text-slate-700 uppercase tracking-wide block mb-1.5">
            {mode === 'target' ? 'Target Total Quantity (pcs)' : 'Number of Packs / Cartons'}
          </label>
          <input
            type="number"
            min="1"
            className="input font-bold text-base text-brand-800"
            value={mode === 'target' ? targetQty : packCount}
            onChange={(e) => mode === 'target' ? setTargetQty(e.target.value) : setPackCount(e.target.value)}
            placeholder={mode === 'target' ? 'e.g. 10000' : 'e.g. 500'}
          />
          {mode === 'target' && Number(targetQty) > 0 && excessPct > 0 && (
            <p className="mt-1 text-[11px] text-amber-800 font-medium">
              +{excessPct}% Cutting Buffer: +{fmtNumber(Math.round(Number(targetQty) * excessPct / 100))} pcs → <strong className="font-bold">{fmtNumber(Math.round(Number(targetQty) * (1 + excessPct / 100)))} pcs Planned Cut</strong>
            </p>
          )}
        </div>

        {/* Colour Scope */}
        {colorGroups.length > 1 && !activeColorId ? (
          <div>
            <label className="text-[11.5px] font-bold text-slate-700 uppercase tracking-wide block mb-1.5">
              Apply to Colour
            </label>
            <select
              className="input text-xs"
              value={selectedColor}
              onChange={(e) => setSelectedColor(e.target.value)}
            >
              <option value="ALL">All {colorGroups.length} Colours</option>
              {colorGroups.map(([cName]) => (
                <option key={cName} value={cName}>{cName}</option>
              ))}
            </select>
            {selectedColor === 'ALL' && mode === 'target' && (
              <div className="mt-1.5 flex items-center gap-3 text-[11px] text-slate-600">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="multiColorMode"
                    checked={splitMultiColor === 'each'}
                    onChange={() => setSplitMultiColor('each')}
                  />
                  <span>Each colour</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="multiColorMode"
                    checked={splitMultiColor === 'equal'}
                    onChange={() => setSplitMultiColor('equal')}
                  />
                  <span>Split equally</span>
                </label>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center pt-5">
            <span className="text-xs text-slate-500 bg-slate-100 px-3 py-2 rounded-lg border border-slate-200">
              Applying to: <strong className="text-slate-800">{colorGroups[0]?.[0] || 'Selected Colour'}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Preset Quick Buttons & Text Parser */}
      <div className="mt-3 pt-3 border-t border-slate-200">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <span className="text-[11.5px] font-bold text-slate-700 uppercase tracking-wide">
            Industry Ratio Presets:
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500 font-medium">Quick Paste Ratio:</span>
            <input
              type="text"
              placeholder="e.g. 1:2:3:2:1"
              value={ratioStr}
              onChange={(e) => applyRatioString(e.target.value)}
              className="w-28 rounded border border-slate-300 px-2 py-0.5 text-xs font-mono focus:border-brand-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.values)}
              className="text-xs bg-white hover:bg-brand-50 text-slate-700 hover:text-brand-700 border border-slate-200 hover:border-brand-300 px-2.5 py-1 rounded-lg font-medium shadow-2xs transition-colors"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Interactive Size Ratio Inputs */}
      <div className="mt-3.5 rounded-lg bg-slate-50/80 p-3 border border-slate-200">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-slate-800">Set Ratio per Size:</span>
          <span className="text-xs font-semibold px-2.5 py-0.5 bg-brand-100 text-brand-800 rounded-full border border-brand-200">
            Pack Ratio Sum: <strong className="font-bold">{totalRatioUnits}</strong> units
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
          {sizes.map((s) => {
            const pieces = sizeDistribution[s.size_code] ?? 0;
            const pct = singleColorTotal > 0 ? ((pieces / singleColorTotal) * 100).toFixed(1) : '0';

            return (
              <div
                key={s.size_code}
                className="flex flex-col rounded-lg bg-white p-2 border border-slate-200 shadow-2xs text-center"
              >
                <span className="text-xs font-extrabold text-slate-900 mb-1">{s.size_code}</span>
                <div className="flex items-center justify-center gap-1 mb-1.5">
                  <span className="text-[11px] text-slate-400 font-semibold">Ratio:</span>
                  <input
                    type="number"
                    min="0"
                    value={ratios[s.size_code] ?? ''}
                    onChange={(e) => {
                      const val = e.target.value === '' ? 0 : Math.max(0, Number(e.target.value));
                      setRatios((prev) => ({ ...prev, [s.size_code]: val }));
                    }}
                    className="w-12 rounded border border-slate-300 py-0.5 px-1 text-center font-bold text-brand-700 text-sm focus:border-brand-500 focus:outline-none"
                  />
                </div>
                <div className="mt-auto border-t border-slate-100 pt-1 text-[11px]">
                  <p className="font-bold text-slate-800 tabular-nums">{fmtNumber(pieces)} pcs</p>
                  <p className="text-[10px] text-slate-400 font-medium">{pct}%</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Live Preview Summary Bar & Apply Button */}
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-brand-100">
        <div className="text-xs text-slate-600">
          <span>Will distribute: </span>
          <strong className="text-sm font-bold text-brand-800 tabular-nums">
            {fmtNumber(grandTotalPreview)} pcs
          </strong>
          {previewColorCount > 1 && (
            <span className="text-slate-500">
              {' '}({fmtNumber(singleColorTotal)} pcs $\times$ {previewColorCount} colours)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="btn-primary btn-sm flex items-center gap-1.5 shadow-sm font-semibold"
          >
            <Check size={14} />
            Apply Ratio to Order Grid
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ order line card */
function LineCard({
  line, index, editable, currencyCode, currencySymbol, exchangeRate, isForeign, headExcessPct, onChange, onRemove, canRemove
}: {
  line: Line; index: number; editable: boolean;
  currencyCode: string; currencySymbol: string; exchangeRate: number; isForeign: boolean;
  headExcessPct: number;
  onChange: (p: Partial<Line>) => void; onRemove: () => void; canRemove: boolean;
}) {
  const toast = useToast();
  const [showRatioTool, setShowRatioTool] = useState(false);
  const styles = useLookup('styles');
  const colors = useStyleColors(line.style_id ? Number(line.style_id) : null);
  const skus = useStyleSkus(line.style_id ? Number(line.style_id) : null);

  // Only show sizes for the colour chosen on this line.
  const visibleSkus = useMemo(() => {
    const all = skus.data ?? [];
    return line.color_id ? all.filter((s) => s.color_id === Number(line.color_id)) : all;
  }, [skus.data, line.color_id]);

  const distinctSizes = useMemo(() => {
    return [...new Map(visibleSkus.map((s) => [s.size_code, s])).values()]
      .sort((a, b) => a.sort_order - b.sort_order);
  }, [visibleSkus]);

  const colorGroups = useMemo(() => groupByColor(visibleSkus), [visibleSkus]);

  const lineQty = Object.entries(line.skus)
    .filter(([id]) => visibleSkus.some((s) => s.id === Number(id)))
    .reduce((a, [, q]) => a + (Number(q) || 0), 0);
  const lineAmount = lineQty * (Number(line.unit_price) || 0);

  const lineExcessPct = (line.excess_pct !== '' && line.excess_pct !== undefined)
    ? Number(line.excess_pct)
    : headExcessPct;
  const linePlanCutQty = Math.round(lineQty * (1 + (lineExcessPct || 0) / 100));
  const lineExcessPcs = Math.max(0, linePlanCutQty - lineQty);

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

      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-5">
        <Select label="Style" required options={toOptions(styles.data)} placeholder="— Select style —"
          value={line.style_id} disabled={!editable}
          onChange={(e) => onChange({
            style_id: e.target.value ? Number(e.target.value) : '', color_id: '', skus: {},
          })} />
        <Select label="Colour" options={colors.data?.map((c) => ({ value: c.id, label: c.label })) ?? []}
          placeholder={line.style_id ? '— All colours —' : 'Select a style first'}
          value={line.color_id} disabled={!editable || !line.style_id}
          onChange={(e) => onChange({ color_id: e.target.value ? Number(e.target.value) : '', skus: {} })} />
        <Input label={`Unit price (${currencyCode})`} type="number" step="0.0001" placeholder="0.00" value={line.unit_price}
          disabled={!editable}
          onChange={(e) => onChange({ unit_price: e.target.value === '' ? '' : Number(e.target.value) })} />
        <Input
          label="Excess % (Cut buffer)"
          type="number"
          step="0.1"
          min="0"
          placeholder={`${headExcessPct}%`}
          value={line.excess_pct !== undefined ? line.excess_pct : ''}
          disabled={!editable}
          hint={line.excess_pct !== '' && line.excess_pct !== undefined ? `${line.excess_pct}% custom` : `Default (${headExcessPct}%)`}
          onChange={(e) => onChange({ excess_pct: e.target.value === '' ? '' : Number(e.target.value) })}
        />
        <Input label="Line ship date" type="date" value={line.ship_date} disabled={!editable}
          onChange={(e) => onChange({ ship_date: e.target.value })} />
      </div>

      {/* Size grid */}
      <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <p className="text-[12px] font-semibold text-slate-700">Size-wise breakdown</p>
            {editable && line.style_id && visibleSkus.length > 0 && (
              <button
                type="button"
                onClick={() => setShowRatioTool((s) => !s)}
                className={`btn-xs flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-all ${
                  showRatioTool
                    ? 'border-brand-400 bg-brand-100 text-brand-900 shadow-xs'
                    : 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100 hover:border-brand-300'
                }`}
                title="Open ratio calculator to auto-split quantities by size ratio"
              >
                <Sparkles size={13} className="text-brand-600" />
                {showRatioTool ? 'Close Ratio Tool' : '⚡ Ratio Split / Auto-Distribute'}
              </button>
            )}
          </div>
          {lineQty > 0 && (
            <div className="flex flex-wrap items-center gap-2.5 text-[11.5px]">
              <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-700 border border-slate-200">
                Order: <strong className="font-bold text-slate-900">{fmtNumber(lineQty)}</strong> pcs
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 font-medium text-amber-800 border border-amber-200" title={`Cutting allowance: +${lineExcessPct}%`}>
                +{lineExcessPct}% Excess: <strong className="font-bold text-amber-900">+{fmtNumber(lineExcessPcs)} pcs</strong>
              </span>
              <span className="inline-flex items-center gap-1 rounded bg-brand-50 px-2 py-0.5 font-semibold text-brand-800 border border-brand-200" title="Total planned cutting quantity with buffer">
                Planned Cut: <strong className="font-bold text-brand-950">{fmtNumber(linePlanCutQty)}</strong> pcs
              </span>
              <span className="font-semibold text-slate-800 ml-1">
                {currencyCode} {currencySymbol}{lineAmount.toLocaleString(isForeign ? 'en-US' : 'en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {isForeign && (
                <span className="font-bold text-brand-700">
                  (₹ {(lineAmount * exchangeRate).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                </span>
              )}
            </div>
          )}
        </div>

        {/* Ratio Split Assistant Drawer */}
        {showRatioTool && distinctSizes.length > 0 && (
          <RatioSplitAssistant
            sizes={distinctSizes}
            colorGroups={colorGroups}
            activeColorId={line.color_id}
            excessPct={lineExcessPct}
            onApply={(newSkus) => {
              onChange({ skus: { ...line.skus, ...newSkus } });
              toast('Applied ratio split across sizes');
              setShowRatioTool(false);
            }}
            onClear={() => {
              const resetSkus: Record<number, number> = {};
              visibleSkus.forEach((s) => { resetSkus[s.id] = 0; });
              onChange({ skus: { ...line.skus, ...resetSkus } });
              toast('Cleared size quantities');
            }}
            onClose={() => setShowRatioTool(false)}
          />
        )}

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
