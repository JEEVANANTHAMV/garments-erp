import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarClock, Plus, Search, AlertTriangle, CheckCircle2,
  Clock, ArrowRight, ShieldAlert, Layers, RefreshCw
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtNumber } from '../../lib/format';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { StatusBadge } from '../../components/ui';

export default function TnaListPage() {
  const nav = useNavigate();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [buyerId, setBuyerId] = useState('');
  const [status, setStatus] = useState('');
  const [risk, setRisk] = useState('');
  const [newModalOpen, setNewModalOpen] = useState(false);

  // Lookups
  const buyers = useLookup('parties');
  const salesOrders = useLookup('sales-orders');
  const templatesQuery = useQuery({
    queryKey: ['tna-templates'],
    queryFn: async () => (await http.get<{ data: any[] }>('/tna/templates')).data,
  });

  // Query T&A list
  const tnaListQuery = useQuery({
    queryKey: ['tna-list', buyerId, status, risk, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (buyerId) params.set('buyer_id', buyerId);
      if (status) params.set('status', status);
      if (risk) params.set('risk', risk);
      if (search) params.set('search', search);
      return (await http.get<{ data: any[] }>(`/tna?${params.toString()}`)).data;
    },
  });

  // Query Dashboard summary for top KPIs
  const dashboardQuery = useQuery({
    queryKey: ['tna-dashboard-summary'],
    queryFn: async () => (await http.get<{ data: any }>('/tna/dashboard')).data,
  });

  const list = tnaListQuery.data || [];
  const stats = dashboardQuery.data || {
    total_orders: 0,
    on_track: 0,
    at_risk: 0,
    critical: 0,
    avg_completion: 0,
  };

  // Form state for creating new T&A
  const [soId, setSoId] = useState('');
  const [tplId, setTplId] = useState('1');
  const [shipDate, setShipDate] = useState('');
  const [orderQty, setOrderQty] = useState('');
  const [creating, setCreating] = useState(false);

  const handleSelectSo = (val: string) => {
    setSoId(val);
    const selectedSo: any = salesOrders.data?.find((s: any) => String(s.id) === val);
    if (selectedSo) {
      if (selectedSo.ship_date) {
        setShipDate(new Date(String(selectedSo.ship_date)).toISOString().slice(0, 10));
      }
      if (selectedSo.order_qty) {
        setOrderQty(String(selectedSo.order_qty));
      }
    }
  };

  const handleCreateTna = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!soId) {
      toast('Please select a Sales Order', 'warning');
      return;
    }
    if (!shipDate) {
      toast('Please specify a Shipment Date', 'warning');
      return;
    }

    setCreating(true);
    try {
      const res = await http.post<{ data: any }>('/tna', {
        sales_order_id: Number(soId),
        template_id: Number(tplId) || 1,
        shipment_date: shipDate,
        order_qty: Number(orderQty) || undefined,
      });
      toast(`T&A Plan ${res.data.tna_no} created successfully.`);
      setNewModalOpen(false);
      nav(`/tna/${res.data.id}`);
    } catch (err: any) {
      toast(err.message || 'Failed to create T&A plan', 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5 pb-12">
      {/* 1. Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <CalendarClock className="text-brand-600" size={24} />
              Time & Action (T&A) Control
            </h1>
            <span className="rounded-full bg-brand-50 border border-brand-200 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
              Order Lifecycle Management
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Centralized schedule tracking from order confirmation to export shipment with risk and dependency alerts
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm flex items-center gap-1.5"
            onClick={() => nav('/tna/dashboard')}
          >
            <ShieldAlert size={14} className="text-amber-600" /> Executive Dashboard
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm flex items-center gap-1.5"
            onClick={() => nav('/tna/templates')}
          >
            <Layers size={14} /> Templates
          </button>
          <button
            type="button"
            className="btn-primary btn-sm flex items-center gap-1.5"
            onClick={() => setNewModalOpen(true)}
          >
            <Plus size={14} /> New T&A Plan
          </button>
        </div>
      </div>

      {/* 2. Top Summary KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Live Orders</p>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold text-slate-900">{stats.total_orders}</span>
            <span className="text-xs text-slate-400">Tracked</span>
          </div>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5 shadow-xs">
          <p className="text-[11px] font-semibold text-emerald-800 uppercase tracking-wide flex items-center gap-1">
            <CheckCircle2 size={13} /> On Track
          </p>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold text-emerald-700">{stats.on_track}</span>
            <span className="text-xs font-medium text-emerald-600">Safe buffer</span>
          </div>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-3.5 shadow-xs">
          <p className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide flex items-center gap-1">
            <Clock size={13} /> At Risk
          </p>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold text-amber-700">{stats.at_risk}</span>
            <span className="text-xs font-medium text-amber-600">Attention needed</span>
          </div>
        </div>

        <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-3.5 shadow-xs">
          <p className="text-[11px] font-semibold text-rose-800 uppercase tracking-wide flex items-center gap-1">
            <AlertTriangle size={13} /> Critical Delay
          </p>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold text-rose-700">{stats.critical}</span>
            <span className="text-xs font-medium text-rose-600">Shipment threat</span>
          </div>
        </div>

        <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3.5 shadow-xs">
          <p className="text-[11px] font-semibold text-indigo-800 uppercase tracking-wide">Avg Completion</p>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-bold text-indigo-700">{stats.avg_completion}%</span>
            <span className="text-xs font-medium text-indigo-600">Overall progress</span>
          </div>
        </div>
      </div>

      {/* 3. Filters Toolbar */}
      <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[300px]">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by T&A no, style, SO, IO..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-8 py-1.5 text-xs w-full"
            />
          </div>

          <select
            value={buyerId}
            onChange={(e) => setBuyerId(e.target.value)}
            className="input py-1.5 text-xs max-w-[180px]"
          >
            <option value="">All Buyers</option>
            {toOptions(buyers.data).map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>

          <select
            value={risk}
            onChange={(e) => setRisk(e.target.value)}
            className="input py-1.5 text-xs max-w-[150px]"
          >
            <option value="">All Risk Levels</option>
            <option value="ON_TRACK">On Track</option>
            <option value="AT_RISK">At Risk</option>
            <option value="CRITICAL">Critical</option>
          </select>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="input py-1.5 text-xs max-w-[150px]"
          >
            <option value="">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="GENERATED">Generated</option>
            <option value="SUBMITTED">Submitted</option>
            <option value="APPROVED">Approved / Active</option>
            <option value="CLOSED">Closed</option>
          </select>

          {(buyerId || status || risk || search) && (
            <button
              type="button"
              className="btn-ghost btn-xs text-slate-500"
              onClick={() => {
                setBuyerId('');
                setStatus('');
                setRisk('');
                setSearch('');
              }}
            >
              Clear Filters
            </button>
          )}
        </div>

        <button
          type="button"
          className="btn-ghost btn-sm text-slate-600"
          onClick={() => tnaListQuery.refetch()}
          title="Refresh table"
        >
          <RefreshCw size={14} className={tnaListQuery.isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 4. T&A Orders Data Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3">T&A No</th>
                <th className="py-2.5 px-3">Buyer & Style</th>
                <th className="py-2.5 px-3">Sales Order & IO</th>
                <th className="py-2.5 px-3 text-right">Order Qty</th>
                <th className="py-2.5 px-3">Shipment Date</th>
                <th className="py-2.5 px-3">Template</th>
                <th className="py-2.5 px-3">Progress</th>
                <th className="py-2.5 px-3 text-center">Shipment Risk</th>
                <th className="py-2.5 px-3 text-center">Status</th>
                <th className="py-2.5 px-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {list.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-400">
                    {tnaListQuery.isLoading ? 'Loading Time & Action plans…' : 'No Time & Action records found.'}
                  </td>
                </tr>
              ) : (
                list.map((row) => {
                  const pct = Number(row.completion_percentage || 0);
                  const isCritical = row.shipment_risk === 'CRITICAL';
                  const isAtRisk = row.shipment_risk === 'AT_RISK';

                  return (
                    <tr
                      key={row.id}
                      className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                      onClick={() => nav(`/tna/${row.id}`)}
                    >
                      <td className="py-3 px-3 font-mono font-bold text-brand-700">
                        {row.tna_no}
                        {row.version > 1 && (
                          <span className="ml-1 rounded bg-indigo-50 border border-indigo-200 px-1 text-[10px] text-indigo-700">
                            v{row.version}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-semibold text-slate-900">{row.buyer_name || 'Buyer'}</div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {row.style_code} {row.style_name ? `• ${row.style_name}` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <div className="font-medium text-slate-800">{row.so_no}</div>
                        <div className="text-[11px] text-slate-500 font-mono">IO: {row.io_no || '—'}</div>
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-medium">
                        {fmtNumber(row.order_qty)} pcs
                      </td>
                      <td className="py-3 px-3">
                        <span className="font-medium text-slate-900">{fmtDate(row.shipment_date)}</span>
                      </td>
                      <td className="py-3 px-3 text-slate-600">
                        {row.template_name || 'Basic T-Shirt'}
                      </td>
                      <td className="py-3 px-3 min-w-[120px]">
                        <div className="flex items-center justify-between text-[11px] font-semibold mb-1">
                          <span>{pct.toFixed(0)}%</span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-1.5 overflow-hidden">
                          <div
                            className={`h-1.5 rounded-full ${
                              pct === 100 ? 'bg-emerald-500' :
                              pct > 60 ? 'bg-brand-500' :
                              'bg-amber-500'
                            }`}
                            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                          />
                        </div>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                            isCritical
                              ? 'bg-rose-100 text-rose-800 border border-rose-200'
                              : isAtRisk
                              ? 'bg-amber-100 text-amber-800 border border-amber-200'
                              : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                          }`}
                        >
                          {isCritical && <AlertTriangle size={11} />}
                          {isAtRisk && <Clock size={11} />}
                          {row.shipment_risk || 'ON_TRACK'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <StatusBadge value={row.status} />
                      </td>
                      <td className="py-3 px-3 text-right">
                        <button
                          type="button"
                          className="btn-ghost btn-xs text-brand-600 hover:text-brand-800 flex items-center gap-1 ml-auto"
                          onClick={(e) => {
                            e.stopPropagation();
                            nav(`/tna/${row.id}`);
                          }}
                        >
                          View <ArrowRight size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 5. Create T&A Modal */}
      {newModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 mb-1">
              <CalendarClock className="text-brand-600" size={20} />
              Create Time & Action (T&A) Plan
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Select an approved Sales Order and a manufacturing template to auto-generate order lifecycle milestones
            </p>

            <form onSubmit={handleCreateTna} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Sales Order <span className="text-rose-500">*</span>
                </label>
                <select
                  required
                  value={soId}
                  onChange={(e) => handleSelectSo(e.target.value)}
                  className="input text-xs w-full"
                >
                  <option value="">-- Select Sales Order --</option>
                  {toOptions(salesOrders.data).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  T&A Activity Template <span className="text-rose-500">*</span>
                </label>
                <select
                  required
                  value={tplId}
                  onChange={(e) => setTplId(e.target.value)}
                  className="input text-xs w-full"
                >
                  {(templatesQuery.data || []).map((t: any) => (
                    <option key={t.id} value={t.id}>
                      {t.template_name} ({t.activity_count} activities)
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Shipment Date <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={shipDate}
                    onChange={(e) => setShipDate(e.target.value)}
                    className="input text-xs w-full"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Order Quantity
                  </label>
                  <input
                    type="number"
                    value={orderQty}
                    onChange={(e) => setOrderQty(e.target.value)}
                    placeholder="e.g. 10000"
                    className="input text-xs w-full"
                  />
                </div>
              </div>

              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-[11px] text-amber-800">
                <span className="font-bold">Backward Planning Note:</span> Milestones will be automatically scheduled backward from your Shipment Date, taking into account Sunday weekly-offs and factory lead times.
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => setNewModalOpen(false)}
                  disabled={creating}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary btn-sm flex items-center gap-1.5"
                  disabled={creating}
                >
                  {creating ? 'Generating Milestones…' : 'Generate T&A Plan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
