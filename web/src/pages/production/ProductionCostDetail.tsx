import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Save, RefreshCw, Calculator, Lock, CheckCircle,
  Copy, Printer, ExternalLink, Layers, Factory
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { StatusBadge } from '../../components/ui';
import { fmtDate, fmtNumber, today, toDateInput } from '../../lib/format';

export default function ProductionCostDetailPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const [saving, setSaving] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [activeTab, setActiveTab] = useState<
    'Overview' | 'Fabric' | 'Trims' | 'Process' | 'Cutting' | 'Sewing' |
    'Finishing' | 'Packing' | 'Labour' | 'Machine' | 'Overhead' | 'Variance' | 'Traceability'
  >('Overview');

  const [drilldownModalOpen, setDrilldownModalOpen] = useState(false);
  const [drilldownData, setDrilldownData] = useState<any | null>(null);

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
    buyer_style_ref: '',
    buyer_id: '',
    buyer_name: '',
    buyer_po_no: '',
    so_no: '',
    io_no: 'IO-2026-001',
    season: 'AW-26',
    unit_name: 'Unit 1 (Tiruppur)',
    order_qty: 0,
    planned_qty: 0,
    produced_qty: 0,
    good_qty: 0,
    rejection_qty: 0,
    rework_qty: 0,
    currency_code: 'INR',
    merchandiser_costing_no: 'CST-APPR-01',
    costing_period: 'Sep-2026',
    costing_type: 'ACTUAL',
    version: 1,
    status: 'DRAFT',
    remarks: '',
    approved_by_name: '',
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
    cost_per_good_piece: 0,
    estimated_cost_per_piece: 0,
    total_estimated_cost: 0,
    variance_amount: 0,
    variance_pct: 0,
  });

  // Granular 12-Tab State
  const [tabsData, setTabsData] = useState<any>({
    fabric: [],
    trims: [],
    process: [],
    cutting: [],
    sewing: [],
    finishing: [],
    packing: [],
    labour: [],
    machine: [],
    overhead: [],
    variance: [],
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
    queryFn: async () => (await http.get<{ data: any }>(`/production-costing/${id}`)).data,
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
      buyer_style_ref: c.buyer_style_ref || 'BST-2026',
      buyer_id: String(c.buyer_id || ''),
      buyer_name: c.buyer_name || '',
      buyer_po_no: c.buyer_po_no || '',
      so_no: c.so_no || '',
      io_no: c.io_no || 'IO-2026-001',
      season: c.season || 'AW-26',
      unit_name: c.unit_name || 'Unit 1 (Tiruppur)',
      order_qty: Number(c.order_qty) || 0,
      planned_qty: Number(c.planned_qty) || 0,
      produced_qty: Number(c.produced_qty) || 0,
      good_qty: Number(c.good_qty) || Number(c.produced_qty) || 0,
      rejection_qty: Number(c.rejection_qty) || 0,
      rework_qty: Number(c.rework_qty) || 0,
      currency_code: 'INR',
      merchandiser_costing_no: c.merchandiser_costing_no || 'CST-APPR-01',
      costing_period: c.costing_period || 'Sep-2026',
      costing_type: c.costing_type || 'ACTUAL',
      version: Number(c.version) || 1,
      status: c.status || 'DRAFT',
      remarks: c.remarks || '',
      approved_by_name: c.approved_by_name || '',
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
      cost_per_good_piece: Number(c.cost_per_good_piece) || Number(c.cost_per_piece) || 0,
      estimated_cost_per_piece: Number(c.estimated_cost) || 0,
      total_estimated_cost: (Number(c.estimated_cost) || 0) * (Number(c.produced_qty) || 1),
      variance_amount: Number(c.variance) || 0,
      variance_pct: Number(c.variance_pct) || 0,
    });

    if (c.data_json) {
      try {
        const parsed = typeof c.data_json === 'string' ? JSON.parse(c.data_json) : c.data_json;
        if (parsed.tabs) setTabsData(parsed.tabs);
        if (parsed.breakdownHeads) setBreakdownHeads(parsed.breakdownHeads);
        if (parsed.stageWip) setStageWip(parsed.stageWip);
        if (parsed.sources) setSources(parsed.sources);
      } catch (err) {}
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
        buyer_style_ref: d.order.buyer_style_ref || 'BST-2026',
        buyer_id: String(d.order.buyer_id || ''),
        buyer_name: d.order.buyer_name || '',
        buyer_po_no: d.order.buyer_po_no || '',
        so_no: d.order.so_no || '',
        io_no: d.order.io_no || 'IO-2026-001',
        season: d.order.season || 'AW-26',
        unit_name: d.order.unit_name || 'Unit 1 (Tiruppur)',
        order_qty: d.order.order_qty,
        planned_qty: d.order.planned_qty,
        produced_qty: d.order.produced_qty,
        good_qty: d.order.good_qty || (d.order.produced_qty - 40),
        rejection_qty: d.order.rejection_qty || 40,
        rework_qty: d.order.rework_qty || 25,
        currency_code: d.order.currency_code || 'INR',
        merchandiser_costing_no: d.order.merchandiser_costing_no || 'CST-APPR-01',
        status: prev.status === 'APPROVED' || prev.status === 'FINALIZED' ? prev.status : 'CALCULATED',
      }));

      setSummary(d.summary);
      if (d.tabs) setTabsData(d.tabs);
      setBreakdownHeads(d.breakdownHeads || []);
      setStageWip(d.stageWip || []);
      setSources(d.sources || {});

      toast(`Loaded transaction-driven costing for ${d.order.po_prod_no} (${d.order.style_code})`);
    } catch (err) {
      toast((err as ApiError).message || 'Failed to load production order data', 'error');
    } finally {
      setLoadingData(false);
    }
  };

  const isLocked = head.status === 'APPROVED' || head.status === 'FINALIZED' || head.status === 'LOCKED';

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
        good_qty: head.good_qty,
        rejection_qty: head.rejection_qty,
        rework_qty: head.rework_qty,
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
        cost_per_good_piece: summary.cost_per_good_piece,
        estimated_cost: summary.estimated_cost_per_piece,
        variance: summary.variance_amount,
        variance_pct: summary.variance_pct,
        status: statusOverride || head.status,
        remarks: head.remarks,
        lines,
        data_json: {
          tabs: tabsData,
          breakdownHeads,
          stageWip,
          sources,
        },
      };

      const res = await http.post<{ data: any }>('/production-costing', payload);
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

  // Submit for Review
  const handleSubmit = async () => {
    if (!costId) return;
    try {
      await http.post(`/production-costing/${costId}/submit`, {});
      setHead((h) => ({ ...h, status: 'SUBMITTED' }));
      toast('Costing sheet submitted for review.');
      qc.invalidateQueries({ queryKey: ['production-costs'] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to submit costing', 'error');
    }
  };

  // Approve & Lock
  const handleApprove = async () => {
    if (!costId) return;
    if (!confirm('Approve and lock this production costing sheet? Locked costings cannot be directly edited.')) return;
    setSaving(true);
    try {
      const res = await http.post<{ message: string }>(`/production-costing/${costId}/approve`, {});
      setHead((h) => ({ ...h, status: 'APPROVED' }));
      toast(res.message || 'Costing approved and locked.');
      qc.invalidateQueries({ queryKey: ['production-costs'] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to approve costing', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Create Revision
  const handleRevise = async () => {
    if (!costId) return;
    if (!confirm('Create a new revision (e.g. V2)? Current snapshot will be retained for audit.')) return;
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

  // Open Traceability Drilldown Modal
  const handleOpenDrilldown = async () => {
    if (!costId) {
      toast('Please save the costing sheet first to inspect drilldowns.', 'info');
      return;
    }
    try {
      const res = await http.get<{ data: any }>(`/production-costing/${costId}/drilldown`);
      setDrilldownData(res.data);
      setDrilldownModalOpen(true);
    } catch (err) {
      toast((err as ApiError).message || 'Failed to load drilldown data', 'error');
    }
  };

  const tabs = [
    'Overview', 'Fabric', 'Trims', 'Process', 'Cutting', 'Sewing',
    'Finishing', 'Packing', 'Labour', 'Machine', 'Overhead', 'Variance', 'Traceability'
  ] as const;

  return (
    <div className="space-y-4 pb-14">
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
              Transaction-driven manufacturing costing, standard vs actual variance and cost per good piece
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
              {loadingData ? 'Collecting ERP Data…' : 'Calculate from ERP'}
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

          {!isLocked && costId && head.status !== 'SUBMITTED' && (
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={handleSubmit}
            >
              Submit
            </button>
          )}

          {!isLocked && costId && can('PRODUCTION.APPROVE') && (
            <button
              type="button"
              className="btn-success btn-sm flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-xs"
              onClick={handleApprove}
              disabled={saving}
            >
              <CheckCircle size={14} /> Approve & Lock
            </button>
          )}

          {isLocked && can('PRODUCTION.CREATE') && (
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={handleRevise}
              disabled={saving}
            >
              <Copy size={14} /> Revise (V{head.version + 1})
            </button>
          )}

          <button
            type="button"
            className="btn-secondary btn-sm flex items-center gap-1.5"
            onClick={handleOpenDrilldown}
            title="Traceability Drilldown"
          >
            <ExternalLink size={14} /> Drilldown
          </button>

          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => window.print()}
            title="Print Cost Sheet"
          >
            <Printer size={15} />
          </button>
        </div>
      </div>

      {/* 2. Header Grid Card (Developer Spec Section 4) */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-3 text-xs">
          <div>
            <label className="text-slate-400 block text-[11px]">Production Order</label>
            {isNew ? (
              <select
                value={head.prod_order_id}
                onChange={(e) => {
                  const pId = e.target.value;
                  setHead({ ...head, prod_order_id: pId });
                  if (pId) handleLoadOrderData(pId);
                }}
                className="input text-xs w-full mt-0.5"
              >
                <option value="">Select Production Order...</option>
                {toOptions(prodOrders.data).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <span className="font-bold text-slate-900 font-mono">{head.po_prod_no || '—'}</span>
            )}
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Costing Date</span>
            <span className="font-semibold text-slate-900">{fmtDate(head.cost_date)}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Buyer</span>
            <span className="font-semibold text-slate-900">{head.buyer_name || '—'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Buyer Style No</span>
            <span className="font-semibold text-slate-900 font-mono">{head.buyer_style_ref || 'BST-2026'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Internal Style No</span>
            <span className="font-semibold text-slate-900 font-mono">
              {head.style_code} {head.style_name ? `• ${head.style_name}` : ''}
            </span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Internal Order (IO)</span>
            <span className="font-bold text-brand-700 font-mono">{head.io_no || 'IO-2026-001'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Sales Order No</span>
            <span className="font-medium text-slate-900">{head.so_no || 'SO-00001'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Order Qty</span>
            <span className="font-bold text-slate-900">{fmtNumber(head.order_qty)} pcs</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Produced Qty</span>
            <span className="font-bold text-slate-900">{fmtNumber(head.produced_qty)} pcs</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Good Qty</span>
            <span className="font-bold text-emerald-700">{fmtNumber(head.good_qty)} pcs</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Rejection / Rework</span>
            <span className="font-medium text-rose-600">{head.rejection_qty} rej / {head.rework_qty} rew</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Approved Std Costing</span>
            <span className="font-medium text-indigo-700 font-mono">{head.merchandiser_costing_no}</span>
          </div>
        </div>
      </div>

      {/* 3. Main Workspace: Left 12 Tabs Content + Right Sticky Cost Summary Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
        {/* Left 3 Columns: 12 Tabs Container */}
        <div className="lg:col-span-3 space-y-3">
          {/* Tabs bar */}
          <div className="border-b border-slate-200 bg-white rounded-t-xl px-2 pt-1">
            <div className="flex gap-1 overflow-x-auto">
              {tabs.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`px-3 py-2 text-xs font-bold border-b-2 whitespace-nowrap transition-colors ${
                    activeTab === t
                      ? 'border-brand-600 text-brand-700 bg-brand-50/40'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                  onClick={() => setActiveTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Tab 1: OVERVIEW */}
          {activeTab === 'Overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Produced Qty</span>
                  <div className="text-2xl font-bold text-slate-900 mt-1">{fmtNumber(head.produced_qty)} pcs</div>
                  <span className="text-[11px] text-slate-500">From production entries</span>
                </div>

                <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5 shadow-xs">
                  <span className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider">Good Finished Qty</span>
                  <div className="text-2xl font-bold text-emerald-700 mt-1">{fmtNumber(head.good_qty)} pcs</div>
                  <span className="text-[11px] text-emerald-600">Accepted FG quantity</span>
                </div>

                <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3.5 shadow-xs">
                  <span className="text-[11px] font-bold text-rose-800 uppercase tracking-wider">Rejections</span>
                  <div className="text-2xl font-bold text-rose-700 mt-1">{fmtNumber(head.rejection_qty)} pcs</div>
                  <span className="text-[11px] text-rose-600">QC rejected units</span>
                </div>

                <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3.5 shadow-xs">
                  <span className="text-[11px] font-bold text-indigo-800 uppercase tracking-wider">Standard Cost / Pc</span>
                  <div className="text-2xl font-bold text-indigo-700 mt-1">₹{summary.estimated_cost_per_piece.toFixed(2)}</div>
                  <span className="text-[11px] text-indigo-600">Approved Merchandiser Pre-Costing</span>
                </div>

                <div className="rounded-xl border border-brand-200 bg-brand-50/50 p-3.5 shadow-xs">
                  <span className="text-[11px] font-bold text-brand-800 uppercase tracking-wider">Actual Cost / Good Pc</span>
                  <div className="text-2xl font-bold text-brand-700 mt-1">₹{summary.cost_per_good_piece.toFixed(2)}</div>
                  <span className="text-[11px] text-brand-600">Total Cost ÷ Good Quantity</span>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Variance / Pc</span>
                  <div className={`text-2xl font-bold mt-1 ${summary.variance_amount > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                    {summary.variance_amount >= 0 ? `+₹${(summary.variance_amount / (head.produced_qty || 1)).toFixed(2)}` : `-₹${Math.abs(summary.variance_amount / (head.produced_qty || 1)).toFixed(2)}`}
                  </div>
                  <span className="text-[11px] text-slate-500">
                    {summary.variance_pct >= 0 ? `+${summary.variance_pct.toFixed(2)}%` : `${summary.variance_pct.toFixed(2)}%`} vs Standard
                  </span>
                </div>
              </div>

              {/* Head-wise comparison bar chart summary */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Cost Head Distribution</h3>
                <div className="space-y-3 text-xs">
                  {breakdownHeads.map((h, i) => (
                    <div key={i} className="space-y-1">
                      <div className="flex justify-between font-semibold">
                        <span className="text-slate-700">{h.head}</span>
                        <span className="text-slate-900 font-mono">₹{fmtNumber(h.actual)}</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden flex">
                        <div
                          className="h-2 rounded-full bg-brand-600"
                          style={{ width: `${Math.min(100, Math.max(0, summary.total_actual_cost > 0 ? (h.actual / summary.total_actual_cost) * 100 : 0))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: FABRIC */}
          {activeTab === 'Fabric' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Fabric Actual Issue Valuation</span>
                <span className="text-[11px] text-slate-500">Formula: Actual Issue Qty × Stock Valuation Rate</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Code</th>
                      <th className="py-2.5 px-3">Fabric Name</th>
                      <th className="py-2.5 px-3">Lot No</th>
                      <th className="py-2.5 px-3">Roll No</th>
                      <th className="py-2.5 px-3 text-right">Std Qty</th>
                      <th className="py-2.5 px-3 text-right">Issue Qty</th>
                      <th className="py-2.5 px-3 text-right">Rate</th>
                      <th className="py-2.5 px-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.fabric || []).map((f: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-mono font-bold text-brand-700">{f.code}</td>
                        <td className="py-2.5 px-3 font-medium text-slate-900">{f.fabric_name}</td>
                        <td className="py-2.5 px-3 font-mono">{f.lot_no}</td>
                        <td className="py-2.5 px-3 font-mono">{f.roll_no}</td>
                        <td className="py-2.5 px-3 text-right font-mono">{f.std_qty} kg</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold">{f.issue_qty} kg</td>
                        <td className="py-2.5 px-3 text-right font-mono">₹{f.rate}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{fmtNumber(f.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 3: TRIMS */}
          {activeTab === 'Trims' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Trims & Accessories Consumption</span>
                <span className="text-[11px] text-slate-500">Net Consumption = Issue Qty − Return Qty</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Trim Name</th>
                      <th className="py-2.5 px-3 text-center">UOM</th>
                      <th className="py-2.5 px-3 text-right">Std Qty</th>
                      <th className="py-2.5 px-3 text-right">Issue Qty</th>
                      <th className="py-2.5 px-3 text-right">Return Qty</th>
                      <th className="py-2.5 px-3 text-right">Net Qty</th>
                      <th className="py-2.5 px-3 text-right">Rate</th>
                      <th className="py-2.5 px-3 text-right">Actual Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.trims || []).map((t: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-semibold text-slate-900">{t.trim_name}</td>
                        <td className="py-2.5 px-3 text-center font-mono">{t.uom}</td>
                        <td className="py-2.5 px-3 text-right font-mono">{fmtNumber(t.std_qty)}</td>
                        <td className="py-2.5 px-3 text-right font-mono">{fmtNumber(t.issue_qty)}</td>
                        <td className="py-2.5 px-3 text-right font-mono">{fmtNumber(t.return_qty)}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">{fmtNumber(t.net_qty)}</td>
                        <td className="py-2.5 px-3 text-right font-mono">₹{t.rate.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-700">₹{fmtNumber(t.actual_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 4: PROCESS */}
          {activeTab === 'Process' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Outsourced & In-house Process Movements</span>
                <span className="text-[11px] text-slate-500">Track Input, Output, Loss & Jobwork Rate</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Process</th>
                      <th className="py-2.5 px-3 text-right">Input Qty</th>
                      <th className="py-2.5 px-3 text-right">Output Qty</th>
                      <th className="py-2.5 px-3 text-right">Loss Qty</th>
                      <th className="py-2.5 px-3 text-right">Rate</th>
                      <th className="py-2.5 px-3 text-right">Actual Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.process || []).map((p: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-semibold text-slate-900">{p.process_name}</td>
                        <td className="py-2.5 px-3 text-right font-mono">{fmtNumber(p.input_qty)}</td>
                        <td className="py-2.5 px-3 text-right font-mono text-emerald-700 font-medium">{fmtNumber(p.output_qty)}</td>
                        <td className="py-2.5 px-3 text-right font-mono text-rose-600">{fmtNumber(p.loss_qty)}</td>
                        <td className="py-2.5 px-3 text-right font-mono">₹{p.rate.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{fmtNumber(p.actual_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 5: CUTTING */}
          {activeTab === 'Cutting' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Cutting Stage Breakdown</span>
                <span className="text-[11px] text-slate-500">Integrated with CAD, Marker & Lay Spreading</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Cutting Component</th>
                      <th className="py-2.5 px-3 text-right">Actual Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.cutting || []).map((c: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-medium text-slate-900">{c.component}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{fmtNumber(c.actual_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 6: SEWING (SAM COSTING) */}
          {activeTab === 'Sewing' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Sewing Operation SAM Costing</span>
                <span className="text-[11px] text-slate-500">Formula: SAM × Rate/Min = Cost/Piece</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Operation</th>
                      <th className="py-2.5 px-3 text-center">SAM</th>
                      <th className="py-2.5 px-3 text-right">Rate / Min</th>
                      <th className="py-2.5 px-3 text-right">Cost / Pc</th>
                      <th className="py-2.5 px-3 text-right">Total Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.sewing || []).map((s: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-semibold text-slate-900">{s.operation}</td>
                        <td className="py-2.5 px-3 text-center font-mono font-bold text-indigo-700">{s.sam} min</td>
                        <td className="py-2.5 px-3 text-right font-mono">₹{s.rate_per_min.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{s.cost_per_pc.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-emerald-700">₹{fmtNumber(s.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 7: FINISHING */}
          {activeTab === 'Finishing' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Finishing Department Cost Breakdown</span>
                <span className="text-[11px] text-slate-500">Thread cleaning, ironing, QC checking & folding</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Finishing Component</th>
                      <th className="py-2.5 px-3 text-right">Actual Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.finishing || []).map((f: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-medium text-slate-900">{f.component}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{fmtNumber(f.actual_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 8: PACKING */}
          {activeTab === 'Packing' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Packing Materials & Labour</span>
                <span className="text-[11px] text-slate-500">Polybag, master cartons, stickers, strapping</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Item / Description</th>
                      <th className="py-2.5 px-3 text-right">Quantity</th>
                      <th className="py-2.5 px-3 text-right">Rate</th>
                      <th className="py-2.5 px-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.packing || []).map((pk: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-semibold text-slate-900">{pk.item_name}</td>
                        <td className="py-2.5 px-3 text-right font-mono">{fmtNumber(pk.qty)}</td>
                        <td className="py-2.5 px-3 text-right font-mono">₹{pk.rate.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{fmtNumber(pk.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 9: LABOUR */}
          {activeTab === 'Labour' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Departmental Labour Hours & Rates</span>
                <span className="text-[11px] text-slate-500">Direct & Indirect Factory Labour</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Department</th>
                      <th className="py-2.5 px-3 text-center">Type</th>
                      <th className="py-2.5 px-3 text-right">Hours</th>
                      <th className="py-2.5 px-3 text-right">Rate / Hr</th>
                      <th className="py-2.5 px-3 text-right">Actual Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.labour || []).map((l: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-semibold text-slate-900">{l.department_name}</td>
                        <td className="py-2.5 px-3 text-center font-mono">
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-slate-100">{l.labour_type}</span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono">{l.hours} hrs</td>
                        <td className="py-2.5 px-3 text-right font-mono">₹{l.rate_per_hour.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{fmtNumber(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 10: MACHINE */}
          {activeTab === 'Machine' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Machine Hours, Power & Amortisation</span>
                <span className="text-[11px] text-slate-500">Formula: (Hours × Rate) + Power + Maintenance + Depreciation</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Machine Group</th>
                      <th className="py-2.5 px-3">Department</th>
                      <th className="py-2.5 px-3 text-right">Hours</th>
                      <th className="py-2.5 px-3 text-right">Rate / Hr</th>
                      <th className="py-2.5 px-3 text-right">Power / Maint / Deprec</th>
                      <th className="py-2.5 px-3 text-right">Total Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.machine || []).map((m: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-semibold text-slate-900">{m.machine_name}</td>
                        <td className="py-2.5 px-3 text-slate-600">{m.department_name}</td>
                        <td className="py-2.5 px-3 text-right font-mono">{m.machine_hours} hrs</td>
                        <td className="py-2.5 px-3 text-right font-mono">₹{m.hourly_rate.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-right font-mono text-slate-500">
                          ₹{fmtNumber(m.electricity_cost + m.maintenance_cost + m.depreciation_cost)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{fmtNumber(m.total_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 11: OVERHEAD */}
          {activeTab === 'Overhead' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Factory Administration & Overheads</span>
                <span className="text-[11px] text-slate-500">Electricity, rent, supervisory salary and compliance</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Overhead Head</th>
                      <th className="py-2.5 px-3 text-center">Allocation Basis</th>
                      <th className="py-2.5 px-3 text-right">Rate / Pc</th>
                      <th className="py-2.5 px-3 text-right">Total Allocated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.overhead || []).map((o: any, i: number) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-semibold text-slate-900">{o.overhead_head}</td>
                        <td className="py-2.5 px-3 text-center font-mono">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">{o.allocation_basis}</span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono">₹{o.rate.toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">₹{fmtNumber(o.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 12: VARIANCE (Developer Spec Section 18) */}
          {activeTab === 'Variance' && (
            <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
              <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
                <span className="font-bold text-slate-700">Standard vs Actual Variance Analysis</span>
                <span className="text-[11px] text-slate-500">Variance = Actual Cost − Standard Cost</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold text-[11px]">
                    <tr>
                      <th className="py-2.5 px-3">Cost Head</th>
                      <th className="py-2.5 px-3 text-right">Standard / Pc</th>
                      <th className="py-2.5 px-3 text-right">Actual / Pc</th>
                      <th className="py-2.5 px-3 text-right">Variance / Pc</th>
                      <th className="py-2.5 px-3 text-right">Variance %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {(tabsData.variance || []).map((r: any, i: number) => {
                      const isTotal = r.cost_head === 'TOTAL';
                      const isPositive = r.variance > 0;
                      return (
                        <tr key={i} className={isTotal ? 'bg-slate-50/90 font-bold border-t-2 border-slate-300' : 'hover:bg-slate-50'}>
                          <td className={`py-2.5 px-3 ${isTotal ? 'text-slate-900 font-bold' : 'font-medium'}`}>{r.cost_head}</td>
                          <td className="py-2.5 px-3 text-right font-mono">₹{r.standard_pc.toFixed(2)}</td>
                          <td className="py-2.5 px-3 text-right font-mono font-bold">₹{r.actual_pc.toFixed(2)}</td>
                          <td className={`py-2.5 px-3 text-right font-mono font-bold ${isPositive ? 'text-rose-600' : 'text-emerald-600'}`}>
                            {isPositive ? `+₹${r.variance.toFixed(2)}` : `-₹${Math.abs(r.variance).toFixed(2)}`}
                          </td>
                          <td className={`py-2.5 px-3 text-right font-mono font-bold ${isPositive ? 'text-rose-600' : 'text-emerald-600'}`}>
                            {isPositive ? `+${r.variance_pct.toFixed(2)}%` : `${r.variance_pct.toFixed(2)}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Optional Tab: TRACEABILITY PIPELINE */}
          {activeTab === 'Traceability' && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Production Floor Stage WIP Pipeline
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
                {stageWip.map((st, i) => (
                  <div key={i} className="p-3 rounded-lg border border-slate-200 bg-slate-50 space-y-1">
                    <span className="text-[11px] font-bold text-slate-500 uppercase">{st.stage}</span>
                    <div className="text-lg font-bold text-slate-900">{fmtNumber(st.output)} pcs</div>
                    <div className="text-[11px] text-slate-500 flex justify-between">
                      <span>WIP: {fmtNumber(st.wip)}</span>
                      {st.rejected > 0 && <span className="text-rose-600 font-bold">Rej: {st.rejected}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right 1 Column: STICKY COST SUMMARY (Developer Spec Section 17) */}
        <div className="sticky top-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3.5">
          <div className="border-b border-slate-100 pb-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
              <Calculator size={15} className="text-brand-600" />
              Actual Cost Summary
            </h3>
            <p className="text-[11px] text-slate-400">Live per-piece economics</p>
          </div>

          <div className="space-y-2 text-xs">
            <div className="flex justify-between items-center py-1 border-b border-slate-100">
              <span className="text-slate-500">Standard Cost / Pc</span>
              <span className="font-mono font-semibold text-slate-700">₹{summary.estimated_cost_per_piece.toFixed(2)}</span>
            </div>

            <div className="flex justify-between items-center py-1 border-b border-slate-100">
              <span className="text-slate-500">Actual Cost / Pc</span>
              <span className="font-mono font-bold text-slate-900">₹{summary.actual_cost_per_piece.toFixed(2)}</span>
            </div>

            <div className="flex justify-between items-center py-1 border-b border-slate-100">
              <span className="text-slate-500">Variance / Pc</span>
              <span className={`font-mono font-bold ${summary.variance_amount > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                {summary.variance_amount >= 0 ? `+₹${(summary.variance_amount / (head.produced_qty || 1)).toFixed(2)}` : `-₹${Math.abs(summary.variance_amount / (head.produced_qty || 1)).toFixed(2)}`}
              </span>
            </div>

            <div className="flex justify-between items-center py-1 border-b border-slate-100">
              <span className="text-slate-500">Variance %</span>
              <span className={`font-mono font-bold ${summary.variance_pct > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                {summary.variance_pct >= 0 ? `+${summary.variance_pct.toFixed(2)}%` : `${summary.variance_pct.toFixed(2)}%`}
              </span>
            </div>

            <div className="pt-2 space-y-1.5 text-[11px] text-slate-600">
              <div className="flex justify-between">
                <span>Material Cost</span>
                <span className="font-mono font-semibold">₹{(summary.material_cost / (head.produced_qty || 1)).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Process Cost</span>
                <span className="font-mono font-semibold">₹{(summary.process_cost / (head.produced_qty || 1)).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Labour Cost</span>
                <span className="font-mono font-semibold">₹{(summary.labour_cost / (head.produced_qty || 1)).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Machine Cost</span>
                <span className="font-mono font-semibold">₹{(summary.machine_cost / (head.produced_qty || 1)).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span>Overhead Cost</span>
                <span className="font-mono font-semibold">₹{(summary.overhead_cost / (head.produced_qty || 1)).toFixed(2)}</span>
              </div>
            </div>

            {/* Total Actual Production Cost Card */}
            <div className="mt-3 p-2.5 rounded-lg bg-slate-900 text-white space-y-1">
              <div className="text-[10px] text-slate-400 uppercase font-semibold">Total Actual Cost</div>
              <div className="text-lg font-bold font-mono">₹{fmtNumber(summary.total_actual_cost)}</div>
            </div>

            {/* Cost Per Good Finished Piece (Spec §19) */}
            <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-950 space-y-1">
              <div className="text-[10px] font-bold text-emerald-800 uppercase flex justify-between">
                <span>Cost / Good Finished Pc</span>
                <span>{fmtNumber(head.good_qty)} Pcs</span>
              </div>
              <div className="text-xl font-bold font-mono text-emerald-700">
                ₹{summary.cost_per_good_piece.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Traceability Drilldown Modal (Developer Spec Section 27) */}
      {drilldownModalOpen && drilldownData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-3xl max-h-[85vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col">
            <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50 rounded-t-2xl">
              <div>
                <h3 className="font-bold text-slate-900 text-sm flex items-center gap-2">
                  <ExternalLink size={16} className="text-brand-600" />
                  Transaction Traceability & Audit Drilldown
                </h3>
                <p className="text-xs text-slate-500">
                  Trace actual costing back to source Fabric Issues, Rolls, Lots, GRNs and Process Orders
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost btn-sm text-slate-400 hover:text-slate-700"
                onClick={() => setDrilldownModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto">
              {/* Fabric Issues Drilldown */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2 flex items-center gap-1.5">
                  <Layers size={14} className="text-indigo-600" /> 1. Fabric Issue → Roll → Lot → GRN → Supplier
                </h4>
                <div className="rounded-lg border border-slate-200 overflow-hidden text-xs">
                  <table className="w-full text-left">
                    <thead className="bg-slate-100 text-slate-600 text-[11px]">
                      <tr>
                        <th className="p-2">Issue No</th>
                        <th className="p-2">Fabric</th>
                        <th className="p-2">Roll No</th>
                        <th className="p-2">Lot No</th>
                        <th className="p-2">GRN No</th>
                        <th className="p-2">Supplier</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(drilldownData.fabric || []).length === 0 ? (
                        <tr><td colSpan={6} className="p-3 text-center text-slate-400">No fabric issue lines found</td></tr>
                      ) : (
                        drilldownData.fabric.map((f: any, i: number) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="p-2 font-mono font-bold text-brand-700">{f.issue_no}</td>
                            <td className="p-2">{f.fabric_name}</td>
                            <td className="p-2 font-mono">{f.roll_no}</td>
                            <td className="p-2 font-mono">{f.lot_no}</td>
                            <td className="p-2 font-mono text-emerald-700">{f.grn_no}</td>
                            <td className="p-2 font-semibold">{f.supplier_name}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Process Challans Drilldown */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2 flex items-center gap-1.5">
                  <Factory size={14} className="text-amber-600" /> 2. Process Challan → Process GRN → Vendor
                </h4>
                <div className="rounded-lg border border-slate-200 overflow-hidden text-xs">
                  <table className="w-full text-left">
                    <thead className="bg-slate-100 text-slate-600 text-[11px]">
                      <tr>
                        <th className="p-2">Challan No</th>
                        <th className="p-2">Process Stage</th>
                        <th className="p-2 text-right">Input Qty</th>
                        <th className="p-2 text-right">Output Qty</th>
                        <th className="p-2">Receipt No</th>
                        <th className="p-2">Vendor Name</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(drilldownData.process || []).length === 0 ? (
                        <tr><td colSpan={6} className="p-3 text-center text-slate-400">No process jobwork transactions found</td></tr>
                      ) : (
                        drilldownData.process.map((p: any, i: number) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <td className="p-2 font-mono font-bold text-indigo-700">{p.challan_no}</td>
                            <td className="p-2">{p.stage_name}</td>
                            <td className="p-2 text-right font-mono">{p.input_qty}</td>
                            <td className="p-2 text-right font-mono font-bold text-emerald-700">{p.output_qty}</td>
                            <td className="p-2 font-mono">{p.receipt_no || '—'}</td>
                            <td className="p-2 font-semibold">{p.vendor_name || 'In-House'}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50 flex justify-end rounded-b-2xl">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setDrilldownModalOpen(false)}
              >
                Close Drilldown
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
