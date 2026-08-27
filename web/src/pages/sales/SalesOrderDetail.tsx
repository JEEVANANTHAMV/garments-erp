import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2, Save, CheckCircle2, Sparkles, Check, X, PackageSearch, Layers, PlayCircle, ExternalLink, AlertCircle, CheckCircle, FileText } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions, useStyleColors, useStyleSkus, useStatuses, toPlainOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import {
  PageHeader, Input, Select, Spinner, Badge, StatusBadge, LoadingBlock, ErrorState, Tabs, Modal
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

  const save = async (asDraft = false) => {
    setErrors({}); setSaving(true);
    try {
      const defaultExcess = Number(head.excess_pct) || 0;
      const payload = {
        ...head,
        ...(asDraft ? { approval_state: 'DRAFT' } : {}),
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
      if (!asDraft && !payload.lines.length) { toast('Add at least one order line', 'error'); setSaving(false); return; }

      const res = isNew
        ? await http.post<{ data: any }>('/sales-orders', payload)
        : await http.put<{ data: any }>(`/sales-orders/${id}`, payload);

      toast(asDraft ? 'Saved as Draft — resume anytime' : `Sales order ${isNew ? 'created' : 'updated'} successfully`);
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
          {editable && isNew && (
            <button className="btn-secondary" onClick={() => void save(true)} disabled={saving}>
              {saving ? <Spinner size={15} /> : <FileText size={15} />} Save as Draft
            </button>
          )}
          {editable && (
            <button className="btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size={15} /> : <Save size={15} />}
              {isNew ? 'Create Order' : head.approval_state === 'DRAFT' ? 'Submit Order' : 'Save'}
            </button>
          )}
        </>} />

      {locked && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900">
          This order is <strong>{head.approval_state?.toLowerCase()}</strong> and is locked for editing.
          Change its state to make further changes.
        </div>
      )}

      {!isNew && !locked && head.approval_state === 'DRAFT' && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-[13px] text-blue-900">
          <div className="flex items-center gap-2">
            <FileText size={14} className="shrink-0 text-blue-600" />
            <span>This order is saved as a <strong>Draft</strong>. Complete the details and click <strong>Submit Order</strong> when ready.</span>
          </div>
          <button className="btn-secondary btn-sm shrink-0" onClick={() => void save(true)} disabled={saving}>
            Update Draft
          </button>
        </div>
      )}

      {/* Section 1: Order & Buyer Details */}
      <div className="card mb-3 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-surface-border bg-slate-50/60 px-4 py-2.5">
          <span className="h-2 w-2 rounded-full bg-brand-500" />
          <h4 className="text-[12px] font-bold uppercase tracking-wider text-slate-700">Order &amp; Buyer Details</h4>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
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
        </div>
      </div>

      {/* Section 2: Commercial Terms & Tolerances */}
      <div className="card mb-3 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-surface-border bg-slate-50/60 px-4 py-2.5">
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <h4 className="text-[12px] font-bold uppercase tracking-wider text-slate-700">Commercial Terms &amp; Tolerances</h4>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Select label="Currency" required options={toOptions(currencies.data)} placeholder="— Select —"
            value={head.currency_id ?? ''} onChange={(e) => handleCurrencyChange(e.target.value)}
            disabled={!editable} error={errors.currency_id} />
          <Input
            label="Exchange rate (to INR)"
            type="number" step="0.0001"
            value={head.exchange_rate ?? ''}
            hint={isForeign ? `1 ${currencyCode} = ₹ ${exchangeRate.toFixed(2)}` : '1.00 for INR'}
            placeholder={isForeign ? '83.50' : '1.00'}
            onChange={(e) => setH('exchange_rate', e.target.value)}
            disabled={!editable}
          />
          <Select label="Incoterm" options={INCOTERMS.map((v) => ({ value: v, label: v }))}
            value={head.incoterm ?? 'FOB'} onChange={(e) => setH('incoterm', e.target.value)} disabled={!editable} />
          <Select label="Payment term" options={PAY_TERMS.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))}
            value={head.payment_term ?? 'LC'} onChange={(e) => setH('payment_term', e.target.value)} disabled={!editable} />
          <Input
            label="Excess Cutting %"
            type="number" step="0.1" min="0" placeholder="5.0"
            value={head.excess_pct ?? ''}
            hint="Factory defect buffer"
            onChange={(e) => setH('excess_pct', e.target.value === '' ? '' : Number(e.target.value))}
            disabled={!editable}
          />
          <Input
            label="Shipment Tolerance + %"
            type="number" step="0.1" min="0" placeholder="5.0"
            value={head.tolerance_plus_pct ?? ''}
            hint="Max allowable overage"
            onChange={(e) => setH('tolerance_plus_pct', e.target.value === '' ? '' : Number(e.target.value))}
            disabled={!editable}
          />
          <Input
            label="Shipment Tolerance - %"
            type="number" step="0.1" min="0" placeholder="3.0"
            value={head.tolerance_minus_pct ?? ''}
            hint="Max allowable shortage"
            onChange={(e) => setH('tolerance_minus_pct', e.target.value === '' ? '' : Number(e.target.value))}
            disabled={!editable}
          />
          <Select label="Status" options={toPlainOptions(statuses.data)} placeholder="— Select —"
            value={head.status_id ?? ''} onChange={(e) => setH('status_id', e.target.value)} disabled={!editable} />
        </div>
      </div>

      {/* Section 3: Shipping Logistics & LC */}
      <div className="card mb-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-surface-border bg-slate-50/60 px-4 py-2.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <h4 className="text-[12px] font-bold uppercase tracking-wider text-slate-700">Shipping &amp; Letter of Credit</h4>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input label="Port of loading" value={head.port_of_loading ?? ''}
            onChange={(e) => setH('port_of_loading', e.target.value)} disabled={!editable} />
          <Select label="Destination country" options={toOptions(countries.data)} placeholder="— Select —"
            value={head.destination_country ?? ''} onChange={(e) => setH('destination_country', e.target.value)}
            disabled={!editable} />
          <Input label="Destination port" value={head.destination_port ?? ''}
            onChange={(e) => setH('destination_port', e.target.value)} disabled={!editable} />
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
          { key: 'lines', label: 'Order Lines', count: lines.length },
          { key: 'bom', label: 'Bill of Materials' },
          { key: 'requirements', label: 'Material Requirements' },
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

          {/* Unified Order Totals & Values Card */}
          <div className="card overflow-hidden border border-slate-200/90 bg-white shadow-sm">
            {/* Contextual Top Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/80 px-5 py-2.5">
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                {isForeign ? (
                  <div className="inline-flex items-center gap-1.5 rounded-md bg-white border border-brand-200 px-2.5 py-1 text-slate-700 shadow-2xs">
                    <span className="font-semibold text-slate-500">Applied Exchange Rate:</span>
                    <span className="font-mono font-bold text-brand-800">
                      1 {currencyCode} = ₹ {exchangeRate.toFixed(2)} INR
                    </span>
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-1.5 rounded-md bg-white border border-slate-200 px-2.5 py-1 text-slate-700 shadow-2xs">
                    <span className="font-semibold text-slate-500">Order Currency:</span>
                    <span className="font-mono font-bold text-slate-800">INR (Domestic)</span>
                  </div>
                )}
                {totals.qty > 0 && (
                  <div className="inline-flex items-center gap-1.5 rounded-md bg-white border border-slate-200 px-2.5 py-1 text-slate-700 shadow-2xs">
                    <span className="font-semibold text-slate-500">Shipment Tolerance Window:</span>
                    <span className="font-mono font-bold text-slate-900">
                      {fmtNumber(totals.minShipment)} – {fmtNumber(totals.maxShipment)} pcs
                    </span>
                    <span className="text-[11px] font-medium text-slate-400">
                      (-{totals.tolMinusPct}% / +{totals.tolPlusPct}%)
                    </span>
                  </div>
                )}
              </div>

              <div className="text-xs font-medium text-slate-500">
                {lines.filter(l => l.style_id).length} Style Line{lines.filter(l => l.style_id).length === 1 ? '' : 's'}
              </div>
            </div>

            {/* Metrics KPI Grid */}
            <div className="grid grid-cols-2 gap-y-4 gap-x-2 p-5 sm:grid-cols-3 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-slate-100">
              {/* Tile 1: Order Qty */}
              <div className="flex flex-col justify-between px-3 pt-2 sm:pt-0">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1">
                    Contract Order Qty
                  </span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-black tabular-nums text-slate-900">
                      {fmtNumber(totals.qty)}
                    </span>
                    <span className="text-xs font-semibold text-slate-400">pcs</span>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-400">Buyer invoice contracted volume</p>
              </div>

              {/* Tile 2: Excess Buffer */}
              <div className="flex flex-col justify-between px-3 pt-2 sm:pt-0 sm:pl-5">
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800">
                      Cutting Buffer
                    </span>
                    <span className="rounded bg-amber-100/80 px-1.5 py-0.5 text-[10.5px] font-bold text-amber-800 border border-amber-200">
                      +{totals.excessPct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-black tabular-nums text-amber-700">
                      +{fmtNumber(totals.excessQty)}
                    </span>
                    <span className="text-xs font-semibold text-amber-600">pcs</span>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-amber-700/80">Factory reject & defect buffer</p>
              </div>

              {/* Tile 3: Planned Cut Qty */}
              <div className="flex flex-col justify-between px-3 pt-2 sm:pt-0 sm:pl-5">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-brand-800 block mb-1">
                    Planned Cut Qty
                  </span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-black tabular-nums text-brand-900">
                      {fmtNumber(totals.planCutQty)}
                    </span>
                    <span className="text-xs font-semibold text-brand-600">pcs</span>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-brand-700/80">Feeds fabric & trims MRP explosion</p>
              </div>

              {/* Tile 4: Total Value in Foreign Currency */}
              <div className="flex flex-col justify-between px-3 pt-2 sm:pt-0 sm:pl-5">
                <div>
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1">
                    Total Value ({currencyCode})
                  </span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-sm font-bold text-slate-500">{currencySymbol}</span>
                    <span className="text-2xl font-black tabular-nums text-slate-900">
                      {totals.amount.toLocaleString(isForeign ? 'en-US' : 'en-IN', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-400">Order Qty × Unit Price</p>
              </div>

              {/* Tile 5: Total Value in INR */}
              {isForeign ? (
                <div className="flex flex-col justify-between rounded-xl bg-gradient-to-br from-brand-50 to-brand-100/50 p-3.5 border border-brand-200/80 sm:ml-3">
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-brand-800 block mb-1">
                      Total Value in INR (₹)
                    </span>
                    <div className="flex items-baseline gap-1">
                      <span className="text-sm font-bold text-brand-700">₹</span>
                      <span className="text-2xl font-black tabular-nums text-brand-950">
                        {inrAmount.toLocaleString('en-IN', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  </div>
                  <p className="mt-1.5 text-[11px] font-medium text-brand-700">
                    Converted at 1 {currencyCode} = ₹{exchangeRate.toFixed(2)}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col justify-between px-3 pt-2 sm:pt-0 sm:pl-5">
                  <div>
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block mb-1">
                      Settlement Mode
                    </span>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-lg font-bold text-slate-800">Domestic (INR)</span>
                    </div>
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-400">Direct INR billing without FX</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!isNew && tab === 'bom' && (
        <BomTab lines={lines} soId={Number(id)} />
      )}

      {!isNew && tab === 'requirements' && (
        <RequirementsTab soId={Number(id)} soNo={d?.so_no ?? ''} />
      )}

      {!isNew && tab === 'production' && (
        <div className="card overflow-hidden">
          {d?.production_orders?.length ? (
            <>
              <div className="border-b border-slate-100 px-4 py-3">
                <span className="text-[12px] font-semibold text-slate-700">{d.production_orders.length} work order{d.production_orders.length !== 1 ? 's' : ''} linked to this order</span>
              </div>
              <table className="w-full">
                <thead><tr>
                  <th className="th">Work Order</th>
                  <th className="th text-right">Order Qty</th>
                  <th className="th text-right">Produced</th>
                  <th className="th">Progress</th>
                  <th className="th">State</th>
                </tr></thead>
                <tbody>
                  {d.production_orders.map((p: any) => {
                    const pct = p.order_qty > 0 ? Math.min(100, Math.round((Number(p.produced_qty) / Number(p.order_qty)) * 100)) : 0;
                    return (
                      <tr key={p.id} className="row-hover">
                        <td className="td font-mono text-[12px] text-brand-700 font-semibold">{p.po_prod_no}</td>
                        <td className="td text-right tabular-nums">{fmtNumber(p.order_qty)}</td>
                        <td className="td text-right tabular-nums">{fmtNumber(p.produced_qty)}</td>
                        <td className="td">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-28 rounded-full bg-slate-100 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${pct >= 100 ? 'bg-emerald-500' : pct > 50 ? 'bg-brand-500' : 'bg-amber-500'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-[11.5px] tabular-nums text-slate-600 font-medium">{pct}%</span>
                          </div>
                        </td>
                        <td className="td"><StatusBadge value={p.approval_state} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-14">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
                <Layers size={22} />
              </div>
              <p className="text-[13px] font-medium text-slate-500">No production orders raised yet</p>
              <p className="text-[12px] text-slate-400">Production orders will appear here once they are created against this sales order.</p>
            </div>
          )}
        </div>
      )}

      {!isNew && tab === 'invoices' && (
        <div className="card overflow-hidden">
          {d?.invoices?.length ? (
            <table className="w-full">
              <thead><tr>
                <th className="th">Invoice No.</th><th className="th">Date</th><th className="th text-right">Value</th>
              </tr></thead>
              <tbody>
                {d.invoices.map((i: any) => (
                  <tr key={i.id} className="row-hover">
                    <td className="td font-mono text-[12px] text-brand-700 font-semibold">{i.invoice_no}</td>
                    <td className="td">{fmtDate(i.invoice_date)}</td>
                    <td className="td text-right tabular-nums font-medium">{fmtDecimal(i.total_value, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 py-14">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400">
                <PackageSearch size={22} />
              </div>
              <p className="text-[13px] font-medium text-slate-500">No invoices raised yet</p>
            </div>
          )}
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

/* ============================================================ BOM TAB */
function BomTab({ lines }: { lines: Line[]; soId?: number }) {
  // Unique style IDs across all lines
  const styleIds = useMemo(() =>
    [...new Set(lines.map((l) => l.style_id).filter((id): id is number => !!id))],
    [lines]
  );

  const boms = useQuery({
    queryKey: ['boms', 'so-tab', styleIds],
    queryFn: async () => {
      if (!styleIds.length) return [];
      const results = await Promise.all(
        styleIds.map((sid) =>
          http.get<{ data: any[] }>(`/boms?style_id=${sid}&pageSize=1`).then((r) => r.data ?? [])
        )
      );
      return results.flat();
    },
    enabled: styleIds.length > 0,
  });

  // For each BOM, load its lines
  const bomIds = useMemo(() => (boms.data ?? []).map((b: any) => b.id), [boms.data]);
  const bomDetails = useQuery({
    queryKey: ['boms', 'so-tab-lines', bomIds],
    queryFn: async () => {
      if (!bomIds.length) return {};
      const details = await Promise.all(
        bomIds.map((bid: number) =>
          http.get<{ data: any }>(`/boms/${bid}`).then((r) => r.data)
        )
      );
      return Object.fromEntries(details.map((d: any) => [d.style_id, d]));
    },
    enabled: bomIds.length > 0,
  });

  if (!styleIds.length) {
    return (
      <div className="card flex flex-col items-center justify-center gap-3 py-14">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400"><PackageSearch size={22} /></div>
        <p className="text-[13px] text-slate-500">Add order lines to see Bill of Materials.</p>
      </div>
    );
  }

  if (boms.isLoading || bomDetails.isLoading) return <div className="card"><LoadingBlock rows={6} /></div>;
  if (boms.error) return <div className="card"><ErrorState error={boms.error} onRetry={() => void boms.refetch()} /></div>;

  return (
    <div className="space-y-4">
      {styleIds.map((sid) => {
        const bom = (bomDetails.data as any)?.[sid];
        return (
          <div key={sid} className="card overflow-hidden">
            {/* Style header */}
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                  <Layers size={14} />
                </div>
                <div>
                  <span className="text-[13px] font-bold text-slate-900">
                    {bom ? `${bom.style_code} — ${bom.style_name}` : `Style ID ${sid}`}
                  </span>
                  {bom && (
                    <span className="ml-2 text-[11px] text-slate-400">BOM {bom.bom_no} · v{bom.version}</span>
                  )}
                </div>
              </div>
              {bom ? (
                <div className="flex items-center gap-2">
                  <Badge tone="blue">{bom.lines?.length ?? 0} components</Badge>
                  <a
                    href={`/masters/boms/${bom.id}`}
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-600 hover:text-brand-800"
                    target="_blank" rel="noreferrer"
                  >
                    Open BOM <ExternalLink size={11} />
                  </a>
                </div>
              ) : (
                <a
                  href={`/masters/boms/new`}
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-amber-700 hover:text-amber-900 rounded-lg bg-amber-50 px-2.5 py-1 border border-amber-200"
                  target="_blank" rel="noreferrer"
                >
                  <Plus size={12} /> Create BOM
                </a>
              )}
            </div>

            {/* BOM lines table */}
            {bom?.lines?.length ? (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Type</th>
                    <th className="th">Material</th>
                    <th className="th">Colour</th>
                    <th className="th text-right">Consumption</th>
                    <th className="th">UOM</th>
                    <th className="th text-right">Wastage %</th>
                    <th className="th text-right">Gross / gmt</th>
                  </tr>
                </thead>
                <tbody>
                  {bom.lines.map((l: any) => {
                    const name = l.yarn_name || l.fabric_name || l.trim_name || '—';
                    const gross = Number(l.consumption) * (1 + Number(l.wastage_pct || 0) / 100);
                    const typeColor: Record<string, string> = {
                      YARN: 'blue', FABRIC: 'green', TRIM: 'purple',
                    };
                    return (
                      <tr key={l.id} className="row-hover">
                        <td className="td"><Badge tone={typeColor[l.material_type] as any ?? 'blue'}>{l.material_type}</Badge></td>
                        <td className="td font-medium text-slate-900">{name}</td>
                        <td className="td text-slate-500">{l.color_name ?? '—'}</td>
                        <td className="td text-right tabular-nums">{fmtDecimal(l.consumption, 4)}</td>
                        <td className="td text-slate-500">{l.uom_code}</td>
                        <td className="td text-right tabular-nums text-amber-700">
                          {Number(l.wastage_pct) > 0 ? `+${l.wastage_pct}%` : '—'}
                        </td>
                        <td className="td text-right tabular-nums font-semibold text-brand-800">{fmtDecimal(gross, 4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : !bom ? (
              <div className="flex items-center gap-2.5 px-4 py-5 text-[12.5px] text-amber-800 bg-amber-50">
                <AlertCircle size={15} />
                No active BOM found for this style. Create a BOM to enable MRP explosion and material planning.
              </div>
            ) : (
              <p className="px-4 py-5 text-[12.5px] text-slate-400">This BOM has no component lines yet.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================ REQUIREMENTS TAB */
type ReqFilter = 'ALL' | 'YARN' | 'FABRIC' | 'TRIM';

function RequirementsTab({ soId, soNo }: { soId: number; soNo: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [filter, setFilter] = useState<ReqFilter>('ALL');
  const [running, setRunning] = useState(false);

  // Fetch latest MRP run for this SO
  const mrpList = useQuery({
    queryKey: ['mrp', 'by-so', soId],
    queryFn: async () => (await http.get<{ data: any[] }>(`/mrp?so_id=${soId}&pageSize=1`)).data ?? [],
    enabled: !!soId,
  });

  const latestRun = (mrpList.data as any[])?.[0] ?? null;

  // Load requirements if a run exists
  const mrpDetail = useQuery({
    queryKey: ['mrp', 'so-tab-detail', latestRun?.id],
    queryFn: async () => (await http.get<{ data: any }>(`/mrp/${latestRun.id}`)).data,
    enabled: !!latestRun?.id,
  });

  const requirements: any[] = mrpDetail.data?.requirements ?? [];

  const filtered = filter === 'ALL' ? requirements : requirements.filter((r) => r.material_type === filter);

  const shortfalls = requirements.filter((r) => Number(r.net_required) > 0).length;
  const yarn = requirements.filter((r) => r.material_type === 'YARN').length;
  const fabric = requirements.filter((r) => r.material_type === 'FABRIC').length;
  const trim = requirements.filter((r) => r.material_type === 'TRIM').length;

  const runMrp = async () => {
    setRunning(true);
    try {
      await http.post('/mrp/run', { so_id: soId, run_date: today() });
      toast('MRP run completed — requirements loaded');
      void mrpList.refetch();
      void qc.invalidateQueries({ queryKey: ['mrp'] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'MRP run failed', 'error');
    } finally { setRunning(false); }
  };

  if (mrpList.isLoading) return <div className="card"><LoadingBlock rows={6} /></div>;

  // No MRP run yet
  if (!latestRun) {
    return (
      <div className="card">
        <div className="flex flex-col items-center justify-center gap-4 py-16">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-500">
            <PlayCircle size={28} />
          </div>
          <div className="text-center">
            <p className="text-[15px] font-bold text-slate-800">No MRP run for this order</p>
            <p className="mt-1 text-[13px] text-slate-500 max-w-sm">
              Run Material Requirements Planning to explode the BOM against this order's quantities
              and calculate yarn, fabric and accessory needs.
            </p>
          </div>
          {can('MRP.CREATE') && (
            <button className="btn-primary" onClick={() => void runMrp()} disabled={running}>
              {running ? <Spinner size={15} /> : <PlayCircle size={15} />}
              Run MRP for {soNo}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Run summary bar */}
      <div className="card p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-4 text-[12.5px]">
            <span className="font-mono font-bold text-brand-700">{latestRun.mrp_no}</span>
            <span className="text-slate-500">Run date: <strong className="text-slate-800">{fmtDate(latestRun.run_date)}</strong></span>
            {shortfalls > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-red-50 border border-red-200 px-2 py-0.5 text-[11.5px] font-semibold text-red-700">
                <AlertCircle size={12} /> {shortfalls} shortfall{shortfalls !== 1 ? 's' : ''}
              </span>
            ) : requirements.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-700">
                <CheckCircle size={12} /> All materials covered
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {can('MRP.CREATE') && (
              <button
                className="btn-secondary btn-sm"
                onClick={() => void runMrp()} disabled={running}
                title="Re-run MRP to refresh requirements"
              >
                {running ? <Spinner size={13} /> : <PlayCircle size={13} />}
                Re-run MRP
              </button>
            )}
          </div>
        </div>

        {/* Type filter pills */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100">
          {([
            { key: 'ALL', label: `All (${requirements.length})` },
            { key: 'YARN', label: `Yarn (${yarn})` },
            { key: 'FABRIC', label: `Fabric (${fabric})` },
            { key: 'TRIM', label: `Accessories (${trim})` },
          ] as { key: ReqFilter; label: string }[]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-all border ${
                filter === key
                  ? 'bg-brand-600 text-white border-brand-600 shadow-xs'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300 hover:text-brand-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Requirements table */}
        {mrpDetail.isLoading ? (
          <div className="p-4"><LoadingBlock rows={5} /></div>
        ) : filtered.length ? (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Type</th>
                <th className="th">Material</th>
                <th className="th">Style</th>
                <th className="th text-right">Gross Required</th>
                <th className="th text-right">In Stock</th>
                <th className="th text-right">On Order</th>
                <th className="th text-right">Net Required</th>
                <th className="th">UOM</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r: any) => {
                const net = Number(r.net_required);
                const name = r.yarn_name || r.fabric_name || r.trim_name || '—';
                const typeColor: Record<string, string> = { YARN: 'blue', FABRIC: 'green', TRIM: 'purple' };
                return (
                  <tr key={r.id} className={net > 0 ? 'bg-red-50/30' : ''}>
                    <td className="td">
                      <Badge tone={typeColor[r.material_type] as any ?? 'blue'}>{r.material_type}</Badge>
                    </td>
                    <td className="td font-medium text-slate-900">{name}</td>
                    <td className="td text-[12px] font-mono text-slate-500">{r.style_code ?? '—'}</td>
                    <td className="td text-right tabular-nums">{fmtDecimal(r.gross_required, 3)}</td>
                    <td className="td text-right tabular-nums text-emerald-700">{fmtDecimal(r.in_stock, 3)}</td>
                    <td className="td text-right tabular-nums text-blue-700">{fmtDecimal(r.on_order, 3)}</td>
                    <td className="td text-right">
                      <span className={`font-bold tabular-nums ${
                        net > 0 ? 'text-red-600' : 'text-emerald-600'
                      }`}>
                        {net > 0 ? `+${fmtDecimal(net, 3)}` : fmtDecimal(0, 3)}
                      </span>
                    </td>
                    <td className="td text-slate-500">{r.uom_code}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <CheckCircle className="text-emerald-500" size={22} />
            <p className="text-[13px] text-slate-500">No {filter !== 'ALL' ? filter.toLowerCase() : ''} requirements for this filter.</p>
          </div>
        )}
      </div>
    </div>
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
