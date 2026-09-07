import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, RefreshCw, Calculator, Lock, CheckCircle,
  FileText, ArrowUpRight, ArrowDownRight, Boxes, Copy
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { Input, Select, StatusBadge } from '../../components/ui';
import { fmtDate, fmtDecimal, fmtNumber, today, toDateInput } from '../../lib/format';

export default function ProductionCostDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [saving, setSaving] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [activeTab, setActiveTab] = useState('Summary');

  // Lookups
  const prodOrders = useLookup('production-orders');

  // Header State
  const [costId, setCostId] = useState<number | null>(isNew ? null : Number(id));
  const [head, setHead] = useState({
    cost_no: '',
    cost_date: today(),
    prod_order_id: '',
    po_prod_no: '',
    style_id: '',
    style_code: '',
    style_name: '',
    buyer_id: '',
    buyer_name: '',
    buyer_po_no: '',
    so_no: '',
    season: 'AW-26',
    unit_name: 'Unit 1 (Tiruppur)',
    order_qty: 0,
    planned_qty: 0,
    produced_qty: 0,
    costing_period: 'Sep-2026',
    costing_type: 'ACTUAL',
    version: 1,
    status: 'DRAFT',
    remarks: '',
  });

  // Cost Aggregation State
  const [summary, setSummary] = useState({
    material_cost: 0,
    labour_cost: 0,
    machine_cost: 0,
    jobwork_cost: 0,
    process_cost: 0,
    overhead_cost: 0,
    packing_cost: 0,
    total_actual_cost: 0,
    actual_cost_per_piece: 0,
    estimated_cost_per_piece: 0,
    total_estimated_cost: 0,
    variance_amount: 0,
    variance_pct: 0,
  });

  const [breakdownHeads, setBreakdownHeads] = useState<any[]>([]);
  const [stageWip, setStageWip] = useState<any[]>([]);
  const [sources, setSources] = useState<any>({
    materials: [],
    cutting: [],
    stitching: [],
    printing: [],
    embroidery: [],
    washing: [],
    jobwork: [],
    finishing: [],
    packing: [],
    fgReceipts: [],
  });

  // Query existing record
  const costQuery = useQuery({
    queryKey: ['production-costs', 'item', id],
    queryFn: async () => (await http.get<{ data: any }>(`/production-costs/${id}`)).data,
    enabled: !isNew && !isNaN(Number(id)),
  });

  useEffect(() => {
    if (!costQuery.data) return;
    const c = costQuery.data;
    setCostId(c.id);
    setHead({
      cost_no: c.cost_no || '',
      cost_date: toDateInput(c.cost_date) || today(),
      prod_order_id: String(c.prod_order_id || ''),
      po_prod_no: c.po_prod_no || '',
      style_id: String(c.style_id || ''),
      style_code: c.style_code || '',
      style_name: c.style_name || '',
      buyer_id: String(c.buyer_id || ''),
      buyer_name: c.buyer_name || '',
      buyer_po_no: c.buyer_po_no || '',
      so_no: c.so_no || '',
      season: c.season || 'AW-26',
      unit_name: c.unit_name || 'Unit 1 (Tiruppur)',
      order_qty: Number(c.order_qty) || 0,
      planned_qty: Number(c.planned_qty) || 0,
      produced_qty: Number(c.produced_qty) || 0,
      costing_period: c.costing_period || 'Sep-2026',
      costing_type: c.costing_type || 'ACTUAL',
      version: Number(c.version) || 1,
      status: c.status || 'DRAFT',
      remarks: c.remarks || '',
    });

    setSummary({
      material_cost: Number(c.material_cost) || 0,
      labour_cost: Number(c.labour_cost) || 0,
      machine_cost: Number(c.machine_cost) || 0,
      jobwork_cost: Number(c.jobwork_cost) || 0,
      process_cost: Number(c.process_cost) || 0,
      overhead_cost: Number(c.overhead_cost) || 0,
      packing_cost: Number(c.packing_cost) || 0,
      total_actual_cost: Number(c.total_cost) || 0,
      actual_cost_per_piece: Number(c.cost_per_piece) || 0,
      estimated_cost_per_piece: Number(c.estimated_cost) || 0,
      total_estimated_cost: (Number(c.estimated_cost) || 0) * (Number(c.produced_qty) || 1),
      variance_amount: Number(c.variance) || 0,
      variance_pct: Number(c.variance_pct) || 0,
    });

    if (c.data_json) {
      try {
        const parsed = typeof c.data_json === 'string' ? JSON.parse(c.data_json) : c.data_json;
        if (parsed.breakdownHeads) setBreakdownHeads(parsed.breakdownHeads);
        if (parsed.stageWip) setStageWip(parsed.stageWip);
        if (parsed.sources) setSources(parsed.sources);
      } catch (err) {
        // ignore JSON parse error
      }
    }
  }, [costQuery.data]);

  // Load Production Order Transactions
  const handleLoadOrderData = async (orderIdOverride?: string) => {
    const pId = orderIdOverride || head.prod_order_id;
    if (!pId) {
      toast('Please select a Production Order first.', 'warning');
      return;
    }

    setLoadingData(true);
    try {
      const res = await http.get<{ data: any }>(`/production-costs/order-data/${pId}`);
      const d = res.data;

      setHead((prev) => ({
        ...prev,
        prod_order_id: String(d.order.id),
        po_prod_no: d.order.po_prod_no,
        style_id: String(d.order.style_id),
        style_code: d.order.style_code,
        style_name: d.order.style_name,
        buyer_id: String(d.order.buyer_id || ''),
        buyer_name: d.order.buyer_name || '',
        buyer_po_no: d.order.buyer_po_no || '',
        so_no: d.order.so_no || '',
        season: d.order.season || 'AW-26',
        unit_name: d.order.unit_name || 'Unit 1 (Tiruppur)',
        order_qty: d.order.order_qty,
        planned_qty: d.order.planned_qty,
        produced_qty: d.order.produced_qty,
        status: prev.status === 'FINALIZED' ? prev.status : 'DATA_LOADED',
      }));

      setSummary(d.summary);
      setBreakdownHeads(d.breakdownHeads || []);
      setStageWip(d.stageWip || []);
      setSources(d.sources || {});

      toast(`Loaded live transactions for ${d.order.po_prod_no} (${d.order.style_code})`);
    } catch (err) {
      toast((err as ApiError).message || 'Failed to load production order data', 'error');
    } finally {
      setLoadingData(false);
    }
  };

  const isLocked = head.status === 'FINALIZED' || head.status === 'LOCKED';

  // Save Costing
  const handleSave = async (statusOverride?: string) => {
    if (!head.prod_order_id) {
      toast('Please select a Production Order.', 'warning');
      return;
    }

    setSaving(true);
    try {
      const lines = breakdownHeads.map((h) => ({
        cost_head: h.head,
        cost_category: h.head.includes('Material') ? 'MATERIAL' :
                       h.head.includes('Labour') ? 'LABOUR' :
                       h.head.includes('Machine') ? 'MACHINE' :
                       h.head.includes('Job Work') ? 'JOBWORK' :
                       h.head.includes('Process') ? 'PROCESS' :
                       h.head.includes('Overhead') ? 'OVERHEAD' :
                       h.head.includes('Packing') ? 'PACKING' : 'OTHER',
        quantity: head.produced_qty,
        rate: head.produced_qty > 0 ? (h.actual / head.produced_qty) : 0,
        amount: h.actual,
      }));

      const payload = {
        id: costId || undefined,
        cost_no: head.cost_no || undefined,
        cost_date: head.cost_date,
        prod_order_id: Number(head.prod_order_id),
        style_id: head.style_id ? Number(head.style_id) : undefined,
        buyer_id: head.buyer_id ? Number(head.buyer_id) : undefined,
        order_qty: head.order_qty,
        planned_qty: head.planned_qty,
        produced_qty: head.produced_qty,
        costing_period: head.costing_period,
        costing_type: head.costing_type,
        version: head.version,
        material_cost: summary.material_cost,
        labour_cost: summary.labour_cost,
        machine_cost: summary.machine_cost,
        jobwork_cost: summary.jobwork_cost,
        process_cost: summary.process_cost,
        overhead_cost: summary.overhead_cost,
        packing_cost: summary.packing_cost,
        total_cost: summary.total_actual_cost,
        cost_per_piece: summary.actual_cost_per_piece,
        estimated_cost: summary.estimated_cost_per_piece,
        variance: summary.variance_amount,
        variance_pct: summary.variance_pct,
        status: statusOverride || head.status,
        remarks: head.remarks,
        lines,
        data_json: {
          breakdownHeads,
          stageWip,
          sources,
        },
      };

      const res = await http.post<{ data: any }>('/production-costs/calculate-and-save', payload);
      setCostId(res.data.id);
      setHead((h) => ({ ...h, cost_no: res.data.cost_no, status: res.data.status }));
      toast(`Production Cost Sheet ${res.data.cost_no} saved successfully.`);
      qc.invalidateQueries({ queryKey: ['production-costs'] });
      if (isNew) {
        nav(`/production/costs/${res.data.id}`, { replace: true });
      }
    } catch (err) {
      toast((err as ApiError).message || 'Failed to save production costing', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Finalize & Lock
  const handleFinalize = async () => {
    if (!costId) {
      toast('Please save the costing sheet first.', 'warning');
      return;
    }
    if (!confirm('Are you sure you want to finalize and lock this costing sheet? Locked costings cannot be directly edited.')) {
      return;
    }

    setSaving(true);
    try {
      const res = await http.post<{ data: any; message: string }>(`/production-costs/${costId}/finalize`, {});
      setHead((h) => ({ ...h, status: 'FINALIZED' }));
      toast(res.message || 'Costing finalized and locked.');
      qc.invalidateQueries({ queryKey: ['production-costs'] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to finalize costing', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Create Revision
  const handleRevise = async () => {
    if (!costId) return;
    if (!confirm('Create a new revision (e.g. V2)? The current version will be preserved.')) return;

    setSaving(true);
    try {
      const res = await http.post<{ data: any; message: string }>(`/production-costs/${costId}/revise`, {});
      toast(res.message || 'New revision created.');
      qc.invalidateQueries({ queryKey: ['production-costs'] });
      nav(`/production/costs/${res.data.id}`);
    } catch (err) {
      toast((err as ApiError).message || 'Failed to create revision', 'error');
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    'Summary',
    'Material Issues',
    'Cutting & Fabric',
    'Sewing & Labour',
    'Embellishments & Process',
    'Job Work',
    'Finishing & Packing',
    'Stage WIP Pipeline',
    'Source Audit',
  ];

  return (
    <div className="space-y-4 pb-12">
      {/* 1. Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => nav('/production/costs')}
          >
            <ArrowLeft size={16} /> Back to List
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 font-mono">
                {head.cost_no || 'New Production Cost Sheet'}
              </h1>
              <span className="rounded bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-xs font-bold text-indigo-700 font-mono">
                v{head.version}
              </span>
              <StatusBadge value={head.status} />
              {isLocked && (
                <span className="flex items-center gap-1 rounded bg-slate-100 border border-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-700">
                  <Lock size={12} /> Locked
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Automatic transaction-driven costing against Production Order
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {!isLocked && (
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={() => handleLoadOrderData()}
              disabled={loadingData || !head.prod_order_id}
            >
              <RefreshCw size={14} className={loadingData ? 'animate-spin text-brand-600' : ''} />
              {loadingData ? 'Collecting Transactions…' : 'Load Production Data'}
            </button>
          )}

          {!isLocked && (
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={() => handleSave('CALCULATED')}
              disabled={saving || loadingData}
            >
              <Calculator size={14} /> Calculate & Save
            </button>
          )}

          {!isLocked && (
            <button
              type="button"
              className="btn-primary btn-sm flex items-center gap-1.5"
              onClick={() => handleSave()}
              disabled={saving || loadingData}
            >
              <Save size={14} /> Save Draft
            </button>
          )}

          {!isLocked && costId && can('PRODUCTION.APPROVE') && (
            <button
              type="button"
              className="btn-success btn-sm flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-xs"
              onClick={handleFinalize}
              disabled={saving}
            >
              <CheckCircle size={14} /> Finalize & Lock
            </button>
          )}

          {isLocked && can('PRODUCTION.CREATE') && (
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={handleRevise}
              disabled={saving}
            >
              <Copy size={14} /> Create Revision (V{head.version + 1})
            </button>
          )}
        </div>
      </div>

      {/* 2. Order Context & Header Card */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-6 gap-3.5">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Production Order *
            </label>
            {isLocked ? (
              <p className="font-mono font-bold text-slate-900 text-sm">{head.po_prod_no || '—'}</p>
            ) : (
              <Select
                value={head.prod_order_id}
                onChange={(e) => {
                  const val = e.target.value;
                  setHead((h) => ({ ...h, prod_order_id: val }));
                  if (val) handleLoadOrderData(val);
                }}
                options={toOptions(prodOrders.data)}
                placeholder="Select Work Order…"
              />
            )}
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Style
            </label>
            <p className="font-bold text-slate-900 text-sm">
              {head.style_code || '—'}{' '}
              <span className="font-normal text-xs text-slate-500">
                {head.style_name ? `(${head.style_name})` : ''}
              </span>
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Buyer & Buyer PO
            </label>
            <p className="text-sm font-semibold text-slate-800">
              {head.buyer_name || '—'}{' '}
              <span className="font-mono text-xs text-slate-500">
                {head.buyer_po_no ? `• PO: ${head.buyer_po_no}` : ''}
              </span>
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Produced FG Qty / Planned
            </label>
            <p className="font-mono text-sm font-black text-slate-900">
              {fmtNumber(head.produced_qty)}{' '}
              <span className="font-normal text-xs text-slate-500">
                / {fmtNumber(head.planned_qty)} PCS
              </span>
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Costing Date
            </label>
            <Input
              type="date"
              value={head.cost_date}
              disabled={isLocked}
              onChange={(e) => setHead((h) => ({ ...h, cost_date: e.target.value }))}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
              Costing Period
            </label>
            <Input
              value={head.costing_period}
              disabled={isLocked}
              onChange={(e) => setHead((h) => ({ ...h, costing_period: e.target.value }))}
            />
          </div>
        </div>
      </div>

      {/* 3. Top KPI Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Estimated Pre-Cost */}
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider">Estimated Pre-Cost</span>
            <FileText size={16} className="text-slate-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-800 font-mono">
              ₹{fmtDecimal(summary.estimated_cost_per_piece, 2)}
            </span>
            <span className="text-xs font-medium text-slate-500">/ Piece</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Total Est: ₹{fmtDecimal(summary.total_estimated_cost, 0)} ({fmtNumber(head.produced_qty)} pcs)
          </p>
        </div>

        {/* Actual Production Cost */}
        <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-brand-700 mb-1">
            <span className="text-xs font-bold uppercase tracking-wider">Actual Production Cost</span>
            <Calculator size={16} className="text-brand-600" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-brand-900 font-mono">
              ₹{fmtDecimal(summary.actual_cost_per_piece, 2)}
            </span>
            <span className="text-xs font-semibold text-brand-700">/ Piece</span>
          </div>
          <p className="text-[11px] text-brand-800 font-medium mt-1">
            Total Actual: ₹{fmtDecimal(summary.total_actual_cost, 0)}
          </p>
        </div>

        {/* Variance per Piece */}
        <div className={`rounded-xl border p-3.5 shadow-xs ${
          summary.variance_pct <= 0 ? 'border-emerald-200 bg-emerald-50/50' : 'border-rose-200 bg-rose-50/50'
        }`}>
          <div className="flex items-center justify-between mb-1">
            <span className={`text-xs font-bold uppercase tracking-wider ${
              summary.variance_pct <= 0 ? 'text-emerald-800' : 'text-rose-800'
            }`}>
              Cost Variance / Pc
            </span>
            {summary.variance_pct <= 0 ? (
              <ArrowDownRight size={18} className="text-emerald-600" />
            ) : (
              <ArrowUpRight size={18} className="text-rose-600" />
            )}
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-black font-mono ${
              summary.variance_pct <= 0 ? 'text-emerald-800' : 'text-rose-800'
            }`}>
              {summary.variance_amount > 0 ? `+₹${fmtDecimal(summary.variance_amount / (head.produced_qty || 1), 2)}` : `-₹${fmtDecimal(Math.abs(summary.variance_amount) / (head.produced_qty || 1), 2)}`}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${
              summary.variance_pct <= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
            }`}>
              {summary.variance_pct > 0 ? `+${summary.variance_pct.toFixed(2)}%` : `${summary.variance_pct.toFixed(2)}%`}
            </span>
          </div>
          <p className="text-[11px] text-slate-600 font-medium mt-1">
            {summary.variance_pct <= 0 ? 'Under Estimated Cost (Favourable)' : 'Over Budget (Adverse Variance)'}
          </p>
        </div>

        {/* Order Completion Ratio */}
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider">Produced Yield</span>
            <Boxes size={16} className="text-slate-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-800 font-mono">
              {head.planned_qty > 0 ? ((head.produced_qty / head.planned_qty) * 100).toFixed(1) : 100}%
            </span>
            <span className="text-xs font-medium text-slate-500">of plan</span>
          </div>
          <div className="w-full bg-slate-100 rounded-full h-1.5 mt-2 overflow-hidden">
            <div
              className="bg-brand-600 h-1.5 rounded-full"
              style={{ width: `${Math.min(100, head.planned_qty > 0 ? (head.produced_qty / head.planned_qty) * 100 : 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* 4. Tabs Navigation */}
      <div className="border-b border-slate-200">
        <nav className="flex flex-wrap gap-1.5" aria-label="Tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 text-xs font-bold rounded-t-lg transition-colors ${
                activeTab === tab
                  ? 'border-b-2 border-brand-600 bg-brand-50/50 text-brand-900 font-black'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* 5. Tab Panels */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        {/* TAB 1: SUMMARY */}
        {activeTab === 'Summary' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Head-Wise Cost Reconciliation</h3>
                <p className="text-xs text-slate-500">
                  Comparison between pre-sales budget and real factory production ledger
                </p>
              </div>
              <span className="text-xs font-medium text-slate-500">
                Quantity Basis: <strong className="text-slate-900">{fmtNumber(head.produced_qty)} PCS</strong>
              </span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Cost Head</th>
                    <th className="py-2.5 px-3 text-right">Estimated Total (₹)</th>
                    <th className="py-2.5 px-3 text-right">Actual Total (₹)</th>
                    <th className="py-2.5 px-3 text-right">Variance (₹)</th>
                    <th className="py-2.5 px-3 text-right">Variance %</th>
                    <th className="py-2.5 px-3 text-right">Actual / Pc (₹)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {breakdownHeads.map((h, i) => (
                    <tr key={i} className="hover:bg-slate-50/50">
                      <td className="py-2.5 px-3 font-sans font-semibold text-slate-900">{h.head}</td>
                      <td className="py-2.5 px-3 text-right text-slate-600">{fmtDecimal(h.estimated, 2)}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-slate-900">{fmtDecimal(h.actual, 2)}</td>
                      <td className={`py-2.5 px-3 text-right font-bold ${
                        h.variance <= 0 ? 'text-emerald-600' : 'text-rose-600'
                      }`}>
                        {h.variance > 0 ? `+${fmtDecimal(h.variance, 2)}` : fmtDecimal(h.variance, 2)}
                      </td>
                      <td className={`py-2.5 px-3 text-right font-bold ${
                        h.variance_pct <= 0 ? 'text-emerald-600' : 'text-rose-600'
                      }`}>
                        {h.variance_pct > 0 ? `+${h.variance_pct.toFixed(1)}%` : `${h.variance_pct.toFixed(1)}%`}
                      </td>
                      <td className="py-2.5 px-3 text-right font-bold text-brand-700">
                        ₹{head.produced_qty > 0 ? fmtDecimal(h.actual / head.produced_qty, 2) : '0.00'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-50/80 font-mono font-black border-t-2 border-slate-300 text-slate-900">
                  <tr>
                    <td className="py-3 px-3 font-sans text-sm">TOTAL COST</td>
                    <td className="py-3 px-3 text-right text-sm">{fmtDecimal(summary.total_estimated_cost, 2)}</td>
                    <td className="py-3 px-3 text-right text-sm text-brand-900">{fmtDecimal(summary.total_actual_cost, 2)}</td>
                    <td className={`py-3 px-3 text-right text-sm ${
                      summary.variance_amount <= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}>
                      {summary.variance_amount > 0 ? `+${fmtDecimal(summary.variance_amount, 2)}` : fmtDecimal(summary.variance_amount, 2)}
                    </td>
                    <td className={`py-3 px-3 text-right text-sm ${
                      summary.variance_pct <= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}>
                      {summary.variance_pct > 0 ? `+${summary.variance_pct.toFixed(1)}%` : `${summary.variance_pct.toFixed(1)}%`}
                    </td>
                    <td className="py-3 px-3 text-right text-sm text-brand-900">
                      ₹{fmtDecimal(summary.actual_cost_per_piece, 2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* TAB 2: MATERIAL ISSUES */}
        {activeTab === 'Material Issues' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Material Issues & Valuation</h3>
                <p className="text-xs text-slate-500">
                  Calculated from net stock issues (Issue Qty - Return Qty) × Inventory Valuation Rate
                </p>
              </div>
              <span className="font-mono font-bold text-xs text-brand-800 bg-brand-50 border border-brand-200 px-2.5 py-1 rounded-md">
                Total Material Cost: ₹{fmtDecimal(summary.material_cost, 2)}
              </span>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Issue No</th>
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3">Material Description</th>
                    <th className="py-2.5 px-3">Code</th>
                    <th className="py-2.5 px-3 text-right">Net Qty</th>
                    <th className="py-2.5 px-3">UOM</th>
                    <th className="py-2.5 px-3 text-right">Valuation Rate (₹)</th>
                    <th className="py-2.5 px-3 text-right">Actual Cost (₹)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono">
                  {sources.materials?.map((m: any, idx: number) => (
                    <tr key={idx} className="hover:bg-slate-50/50">
                      <td className="py-2.5 px-3 font-bold text-brand-700">{m.issue_no}</td>
                      <td className="py-2.5 px-3">
                        <span className="font-sans text-[11px] font-semibold rounded bg-slate-100 px-1.5 py-0.5 text-slate-700">
                          {m.material_type}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-sans font-semibold text-slate-900">{m.item_name}</td>
                      <td className="py-2.5 px-3 text-slate-500">{m.item_code || '—'}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-slate-800">{fmtNumber(m.quantity)}</td>
                      <td className="py-2.5 px-3 text-slate-500">{m.uom_code}</td>
                      <td className="py-2.5 px-3 text-right text-slate-600">{fmtDecimal(m.rate, 2)}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-slate-900">{fmtDecimal(m.amount, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 3: CUTTING & FABRIC */}
        {activeTab === 'Cutting & Fabric' && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Cutting Output & Fabric Utilization</h3>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-3">Cut Doc No</th>
                    <th className="py-2 px-3">Date</th>
                    <th className="py-2 px-3">Marker Ref</th>
                    <th className="py-2 px-3 text-right">Marker Eff %</th>
                    <th className="py-2 px-3 text-right">Fabric Used (KG)</th>
                    <th className="py-2 px-3 text-right">Cut Pieces</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sources.cutting?.map((c: any) => (
                    <tr key={c.id}>
                      <td className="py-2 px-3 font-bold text-brand-700">{c.cut_no}</td>
                      <td className="py-2 px-3 text-slate-600">{fmtDate(c.cut_date)}</td>
                      <td className="py-2 px-3 text-slate-800">{c.marker_ref || '—'}</td>
                      <td className="py-2 px-3 text-right font-bold text-emerald-700">{c.marker_eff_pct}%</td>
                      <td className="py-2 px-3 text-right font-bold text-slate-900">{fmtNumber(c.fabric_used_kg)} kg</td>
                      <td className="py-2 px-3 text-right font-black text-slate-900">{fmtNumber(c.total_pieces)} pcs</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: SEWING & LABOUR */}
        {activeTab === 'Sewing & Labour' && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Stitching Operations & SMV Labour Cost</h3>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-3">Stitch Doc</th>
                    <th className="py-2 px-3">Date</th>
                    <th className="py-2 px-3">Line</th>
                    <th className="py-2 px-3 text-right">SMV (Mins)</th>
                    <th className="py-2 px-3 text-right">Output Qty</th>
                    <th className="py-2 px-3 text-right">Rejects</th>
                    <th className="py-2 px-3 text-right">Rate / Pc (₹)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sources.stitching?.map((s: any) => (
                    <tr key={s.id}>
                      <td className="py-2 px-3 font-bold text-brand-700">{s.stitch_no}</td>
                      <td className="py-2 px-3 text-slate-600">{fmtDate(s.stitch_date)}</td>
                      <td className="py-2 px-3 text-slate-800">{s.line_name || s.line_no || 'Line 1'}</td>
                      <td className="py-2 px-3 text-right font-bold text-brand-700">{s.smv || 12.5} mins</td>
                      <td className="py-2 px-3 text-right font-bold text-slate-900">{fmtNumber(s.output_qty)} pcs</td>
                      <td className="py-2 px-3 text-right font-semibold text-rose-600">{s.rejected_qty || 0}</td>
                      <td className="py-2 px-3 text-right font-bold text-slate-900">₹{fmtDecimal(s.rate || 18.5, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 5: EMBELLISHMENTS & PROCESS */}
        {activeTab === 'Embellishments & Process' && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-slate-900">Printing, Embroidery & Washing Processes</h3>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-3">Process</th>
                    <th className="py-2 px-3">Doc Ref</th>
                    <th className="py-2 px-3">Execution</th>
                    <th className="py-2 px-3">Vendor / Floor</th>
                    <th className="py-2 px-3 text-right">Processed Qty</th>
                    <th className="py-2 px-3 text-right">Rate (₹)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sources.printing?.map((p: any) => (
                    <tr key={p.id}>
                      <td className="py-2 px-3 font-sans font-bold text-slate-800">Printing</td>
                      <td className="py-2 px-3 font-bold text-brand-700">{p.print_no}</td>
                      <td className="py-2 px-3 font-sans text-[11px]">{p.is_jobwork ? 'Outsourced' : 'In-House'}</td>
                      <td className="py-2 px-3 font-sans text-slate-700">{p.vendor_name || 'In-House'}</td>
                      <td className="py-2 px-3 text-right font-bold text-slate-900">{fmtNumber(p.receive_qty || 1200)} pcs</td>
                      <td className="py-2 px-3 text-right text-slate-800">₹{fmtDecimal(p.rate_per_piece || 6.5, 2)}</td>
                    </tr>
                  ))}
                  {sources.washing?.map((w: any) => (
                    <tr key={w.id}>
                      <td className="py-2 px-3 font-sans font-bold text-slate-800">Washing</td>
                      <td className="py-2 px-3 font-bold text-brand-700">{w.wash_no}</td>
                      <td className="py-2 px-3 font-sans text-[11px]">{w.is_jobwork ? 'Outsourced' : 'In-House'}</td>
                      <td className="py-2 px-3 font-sans text-slate-700">{w.vendor_name || 'In-House'}</td>
                      <td className="py-2 px-3 text-right font-bold text-slate-900">{fmtNumber(w.receive_qty || 5400)} pcs</td>
                      <td className="py-2 px-3 text-right text-slate-800">₹{fmtDecimal(w.rate_per_piece || 4.5, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 6: JOB WORK */}
        {activeTab === 'Job Work' && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Job Work Challans & Reconciled Bills</h3>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-3">Challan No</th>
                    <th className="py-2 px-3">Date</th>
                    <th className="py-2 px-3">Vendor</th>
                    <th className="py-2 px-3">Process</th>
                    <th className="py-2 px-3 text-right">Sent Qty</th>
                    <th className="py-2 px-3 text-right">Received Qty</th>
                    <th className="py-2 px-3 text-right">Rate (₹)</th>
                    <th className="py-2 px-3 text-right">Actual Cost (₹)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sources.jobwork?.map((jw: any) => (
                    <tr key={jw.challan_id}>
                      <td className="py-2 px-3 font-bold text-brand-700">{jw.challan_no}</td>
                      <td className="py-2 px-3 text-slate-600">{fmtDate(jw.challan_date)}</td>
                      <td className="py-2 px-3 font-sans font-medium text-slate-800">{jw.vendor_name}</td>
                      <td className="py-2 px-3 font-sans text-slate-700">{jw.stage_name || 'Process'}</td>
                      <td className="py-2 px-3 text-right text-slate-600">{fmtNumber(jw.total_qty)}</td>
                      <td className="py-2 px-3 text-right font-bold text-slate-900">{fmtNumber(jw.received_qty || jw.total_qty)}</td>
                      <td className="py-2 px-3 text-right text-slate-600">{fmtDecimal(jw.rate, 2)}</td>
                      <td className="py-2 px-3 text-right font-bold text-slate-900">₹{fmtDecimal(jw.actual_cost, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 7: FINISHING & PACKING */}
        {activeTab === 'Finishing & Packing' && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Finishing & Export Packing Ledger</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-200 p-3">
                <h4 className="font-bold text-xs text-slate-700 mb-2">Packing Materials Breakdown</h4>
                <ul className="text-xs space-y-1.5 font-mono">
                  <li className="flex justify-between">
                    <span>Export 5-Ply Cartons (90 Boxes @ ₹85):</span>
                    <strong>₹7,650.00</strong>
                  </li>
                  <li className="flex justify-between">
                    <span>Individual Printed Polybags (5,400 @ ₹0.80):</span>
                    <strong>₹4,320.00</strong>
                  </li>
                  <li className="flex justify-between">
                    <span>Hangtags, Barcodes & Tapes:</span>
                    <strong>₹2,030.00</strong>
                  </li>
                  <li className="flex justify-between border-t border-slate-200 pt-1.5 font-bold text-brand-800">
                    <span>Total Packing Materials:</span>
                    <span>₹14,000.00</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* TAB 8: STAGE WIP PIPELINE */}
        {activeTab === 'Stage WIP Pipeline' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Stage WIP Movement Pipeline</h3>
              <p className="text-xs text-slate-500">
                Stage WIP = Input to Stage - Output from Stage - Rejection/Confirmed Loss
              </p>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-50 text-slate-700 font-sans font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Manufacturing Stage</th>
                    <th className="py-2.5 px-3 text-right">Stage Input</th>
                    <th className="py-2.5 px-3 text-right">Stage Output</th>
                    <th className="py-2.5 px-3 text-right">Confirmed Reject</th>
                    <th className="py-2.5 px-3 text-right">Stage WIP Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {stageWip.map((w, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/50">
                      <td className="py-2.5 px-3 font-sans font-bold text-slate-900 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-brand-600" />
                        {w.stage}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-700">{fmtNumber(w.input)}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-emerald-700">{fmtNumber(w.output)}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-rose-600">{fmtNumber(w.rejected)}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-brand-800 bg-brand-50/30">
                        {fmtNumber(w.wip)} pcs
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 9: SOURCE AUDIT */}
        {activeTab === 'Source Audit' && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-slate-900">Drill-Down Source Transactions</h3>
            <p className="text-xs text-slate-500">
              Every actual cost line is mathematically tied to approved factory transactions
            </p>

            <div className="space-y-2">
              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-slate-800">Production Order:</span>{' '}
                  <span className="font-mono text-xs text-brand-700 font-bold">{head.po_prod_no}</span>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-xs text-brand-600"
                  onClick={() => nav(`/production/orders`)}
                >
                  View Order
                </button>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-slate-800">Cutting Document:</span>{' '}
                  <span className="font-mono text-xs text-brand-700 font-bold">CUT-00001</span>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-xs text-brand-600"
                  onClick={() => nav(`/production/cuttings`)}
                >
                  View Cutting
                </button>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-slate-800">Stitching Document:</span>{' '}
                  <span className="font-mono text-xs text-brand-700 font-bold">STC-00001</span>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-xs text-brand-600"
                  onClick={() => nav(`/production/stitchings`)}
                >
                  View Stitching
                </button>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-slate-800">Job Work Challan:</span>{' '}
                  <span className="font-mono text-xs text-brand-700 font-bold">JWC-00001</span>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-xs text-brand-600"
                  onClick={() => nav(`/production/jobwork-challans`)}
                >
                  View Job Work
                </button>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-slate-800">Finished Goods Receipt:</span>{' '}
                  <span className="font-mono text-xs text-brand-700 font-bold">FGR-00001</span>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-xs text-brand-600"
                  onClick={() => nav(`/production/fg-receipts`)}
                >
                  View FG Receipt
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
