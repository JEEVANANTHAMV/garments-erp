import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, RefreshCw, CheckCircle, Clock, AlertTriangle,
  Layers, Edit, Save, Copy, Printer,
  Calendar as CalendarIcon, BarChart2, X
} from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { fmtDate, fmtNumber } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { useAuth } from '../../lib/auth';
import { StatusBadge } from '../../components/ui';

export default function TnaDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();

  const [activeTab, setActiveTab] = useState<'Overview' | 'Development' | 'Material' | 'Production' | 'Shipment' | 'Calendar' | 'Gantt'>('Overview');
  const [selectedActivity, setSelectedActivity] = useState<any | null>(null);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);

  // Load T&A Detail
  const tnaQuery = useQuery({
    queryKey: ['tna', id],
    queryFn: async () => (await http.get<{ data: any }>(`/tna/${id}`)).data,
    enabled: Boolean(id),
  });

  // Load Alerts
  const alertsQuery = useQuery({
    queryKey: ['tna-alerts', id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/tna/${id}/alerts`)).data,
    enabled: Boolean(id),
  });

  // Load History for selected activity
  const historyQuery = useQuery({
    queryKey: ['tna-history', id],
    queryFn: async () => (await http.get<{ data: any[] }>(`/tna/${id}/history`)).data,
    enabled: editDrawerOpen && Boolean(id),
  });

  const header = tnaQuery.data?.header || {};
  const summary = tnaQuery.data?.summary || {
    total: 0,
    completed: 0,
    pending: 0,
    delayed: 0,
    at_risk: 0,
    completion_percentage: 0,
    shipment_risk: 'ON_TRACK',
  };
  const activities: any[] = tnaQuery.data?.activities || [];
  const alerts: any[] = alertsQuery.data || [];

  // Recalculate & ERP sync
  const handleRecalculate = async () => {
    setRecalculating(true);
    try {
      const res = await http.post<{ data: any; message: string }>(`/tna/${id}/recalculate`, {});
      toast(res.message || 'T&A recalculated from live ERP events.');
      qc.invalidateQueries({ queryKey: ['tna', id] });
      qc.invalidateQueries({ queryKey: ['tna-alerts', id] });
      qc.invalidateQueries({ queryKey: ['tna-gantt', id] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to recalculate T&A', 'error');
    } finally {
      setRecalculating(false);
    }
  };

  // Regenerate activities
  const handleRegenerate = async () => {
    if (!confirm('Regenerate all activities from template? Any manual date overrides will be recalculated from Shipment Date.')) return;
    setGenerating(true);
    try {
      const res = await http.post<{ message: string }>(`/tna/${id}/generate`, {});
      toast(res.message || 'Activities regenerated.');
      qc.invalidateQueries({ queryKey: ['tna', id] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to regenerate activities', 'error');
    } finally {
      setGenerating(false);
    }
  };

  // Submit for approval
  const handleSubmit = async () => {
    try {
      const res = await http.post<{ message: string }>(`/tna/${id}/submit`, {});
      toast(res.message || 'Submitted for approval.');
      qc.invalidateQueries({ queryKey: ['tna', id] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to submit T&A', 'error');
    }
  };

  // Approve & Lock
  const handleApprove = async () => {
    if (!confirm('Approve and activate this Time & Action plan? Approved milestones serve as the locked contract schedule.')) return;
    setApproving(true);
    try {
      const res = await http.post<{ message: string }>(`/tna/${id}/approve`, {});
      toast(res.message || 'T&A plan approved.');
      qc.invalidateQueries({ queryKey: ['tna', id] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to approve T&A', 'error');
    } finally {
      setApproving(false);
    }
  };

  // Revise
  const handleRevise = async () => {
    if (!confirm('Create a new revision version (e.g. V2)? Previous milestone version will be preserved for audit.')) return;
    try {
      const res = await http.post<{ data: any; message: string }>(`/tna/${id}/revise`, {});
      toast(res.message || 'Revision created.');
      nav(`/tna/${res.data.id}`);
    } catch (err) {
      toast((err as ApiError).message || 'Failed to create revision', 'error');
    }
  };

  // Open edit activity drawer
  const openActivityDrawer = (act: any) => {
    setSelectedActivity({
      ...act,
      planned_start_date: act.planned_start_date ? new Date(act.planned_start_date).toISOString().slice(0, 10) : '',
      planned_end_date: act.planned_end_date ? new Date(act.planned_end_date).toISOString().slice(0, 10) : '',
      actual_start_date: act.actual_start_date ? new Date(act.actual_start_date).toISOString().slice(0, 10) : '',
      actual_end_date: act.actual_end_date ? new Date(act.actual_end_date).toISOString().slice(0, 10) : '',
      reason: '',
    });
    setEditDrawerOpen(true);
  };

  // Save activity updates
  const handleSaveActivity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedActivity) return;

    try {
      await http.patch(`/tna/${id}/activities/${selectedActivity.id}`, {
        planned_start_date: selectedActivity.planned_start_date || null,
        planned_end_date: selectedActivity.planned_end_date || null,
        actual_start_date: selectedActivity.actual_start_date || null,
        actual_end_date: selectedActivity.actual_end_date || null,
        department_name: selectedActivity.department_name || null,
        priority: selectedActivity.priority || 'MEDIUM',
        status: selectedActivity.status || 'NOT_STARTED',
        remarks: selectedActivity.remarks || null,
        reason: selectedActivity.reason || 'User manual adjustment',
      });
      toast('Activity updated successfully.');
      setEditDrawerOpen(false);
      qc.invalidateQueries({ queryKey: ['tna', id] });
      qc.invalidateQueries({ queryKey: ['tna-alerts', id] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to update activity', 'error');
    }
  };

  // Mark activity complete
  const handleCompleteActivity = async (actId: number) => {
    try {
      await http.post(`/tna/${id}/activities/${actId}/complete`, {
        actual_end_date: new Date().toISOString().slice(0, 10),
      });
      toast('Activity marked as COMPLETED.');
      setEditDrawerOpen(false);
      qc.invalidateQueries({ queryKey: ['tna', id] });
      qc.invalidateQueries({ queryKey: ['tna-alerts', id] });
    } catch (err) {
      toast((err as ApiError).message || 'Failed to complete activity', 'error');
    }
  };

  // Filter activities by active tab
  const filteredActivities = activities.filter((a) => {
    if (activeTab === 'Development') return a.category === 'ORDER' || a.category === 'SAMPLING';
    if (activeTab === 'Material') return a.category === 'FABRIC' || a.category === 'TRIM';
    if (activeTab === 'Production') return a.category === 'PRODUCTION';
    if (activeTab === 'Shipment') return a.category === 'QUALITY' || a.category === 'SHIPMENT';
    return true; // Overview or other tabs show all
  });

  const isApproved = header.status === 'APPROVED';
  const isClosed = header.status === 'CLOSED';
  const riskClass = header.shipment_risk === 'CRITICAL'
    ? 'bg-rose-100 text-rose-800 border-rose-200'
    : header.shipment_risk === 'AT_RISK'
    ? 'bg-amber-100 text-amber-800 border-amber-200'
    : 'bg-emerald-100 text-emerald-800 border-emerald-200';

  return (
    <div className="space-y-4 pb-14">
      {/* 1. Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => nav('/tna')}
          >
            <ArrowLeft size={16} /> Back
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 font-mono">
                {header.tna_no || 'Time & Action Plan'}
              </h1>
              <span className="rounded bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-xs font-bold text-indigo-700 font-mono">
                v{header.version || 1}
              </span>
              <StatusBadge value={header.status || 'DRAFT'} />
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold border ${riskClass} flex items-center gap-1`}>
                {header.shipment_risk === 'CRITICAL' && <AlertTriangle size={12} />}
                {header.shipment_risk === 'AT_RISK' && <Clock size={12} />}
                Risk: {header.shipment_risk || 'ON_TRACK'}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Contract schedule & milestone tracking against Sales Order {header.so_no}
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary btn-sm flex items-center gap-1.5"
            onClick={handleRecalculate}
            disabled={recalculating}
            title="Scan ERP transactions and refresh status"
          >
            <RefreshCw size={14} className={recalculating ? 'animate-spin text-brand-600' : ''} />
            {recalculating ? 'Scanning ERP…' : 'Recalculate from ERP'}
          </button>

          {!isApproved && !isClosed && (
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={handleRegenerate}
              disabled={generating}
            >
              <Layers size={14} /> Regenerate Template
            </button>
          )}

          {!isApproved && !isClosed && header.status !== 'SUBMITTED' && (
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={handleSubmit}
            >
              Submit for Review
            </button>
          )}

          {!isApproved && !isClosed && can('PRODUCTION.APPROVE') && (
            <button
              type="button"
              className="btn-success btn-sm flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-xs"
              onClick={handleApprove}
              disabled={approving}
            >
              <CheckCircle size={14} /> Approve & Lock Plan
            </button>
          )}

          {isApproved && (
            <button
              type="button"
              className="btn-secondary btn-sm flex items-center gap-1.5"
              onClick={handleRevise}
            >
              <Copy size={14} /> Revise (V{(header.version || 1) + 1})
            </button>
          )}

          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => window.print()}
            title="Print Schedule"
          >
            <Printer size={15} />
          </button>
        </div>
      </div>

      {/* 2. Order Context & Header Grid Card */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-3 text-xs">
          <div>
            <span className="text-slate-400 block text-[11px]">Buyer</span>
            <span className="font-semibold text-slate-900">{header.buyer_name || '—'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Buyer Style No</span>
            <span className="font-semibold text-slate-900 font-mono">{header.buyer_style_ref || 'BST-2026'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Internal Style</span>
            <span className="font-semibold text-slate-900 font-mono">
              {header.style_code} {header.style_name ? `(${header.style_name})` : ''}
            </span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Sales Order / PO</span>
            <span className="font-semibold text-slate-900">{header.so_no} {header.buyer_po_no ? `• PO: ${header.buyer_po_no}` : ''}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Internal Order (IO)</span>
            <span className="font-semibold text-brand-700 font-mono">{header.io_no || 'IO-2026-001'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Order Qty</span>
            <span className="font-bold text-slate-900">{fmtNumber(header.order_qty)} pcs</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Shipment Target Date</span>
            <span className="font-bold text-rose-600">{fmtDate(header.shipment_date)}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Merchandiser</span>
            <span className="font-medium text-slate-800">{header.merchandiser_name || 'Merchandiser Team'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Applied Template</span>
            <span className="font-medium text-indigo-700">{header.template_name || 'Basic T-Shirt'}</span>
          </div>

          <div>
            <span className="text-slate-400 block text-[11px]">Created Date</span>
            <span className="text-slate-700">{fmtDate(header.tna_date)}</span>
          </div>

          {header.approved_by_name && (
            <div>
              <span className="text-slate-400 block text-[11px]">Approved By</span>
              <span className="text-emerald-700 font-medium">{header.approved_by_name} ({fmtDate(header.approved_at)})</span>
            </div>
          )}
        </div>
      </div>

      {/* 3. Milestone Summary Bar */}
      <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6 text-xs">
          <div>
            <span className="text-slate-400 block text-[11px]">Total Activities</span>
            <span className="font-bold text-slate-900 text-sm">{summary.total}</span>
          </div>
          <div>
            <span className="text-slate-400 block text-[11px]">Completed</span>
            <span className="font-bold text-emerald-600 text-sm">{summary.completed}</span>
          </div>
          <div>
            <span className="text-slate-400 block text-[11px]">Pending</span>
            <span className="font-bold text-slate-700 text-sm">{summary.pending}</span>
          </div>
          <div>
            <span className="text-slate-400 block text-[11px]">Delayed</span>
            <span className={`font-bold text-sm ${summary.delayed > 0 ? 'text-rose-600' : 'text-slate-700'}`}>
              {summary.delayed}
            </span>
          </div>
          <div>
            <span className="text-slate-400 block text-[11px]">At Risk</span>
            <span className={`font-bold text-sm ${summary.at_risk > 0 ? 'text-amber-600' : 'text-slate-700'}`}>
              {summary.at_risk}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 min-w-[240px]">
          <div className="flex-1">
            <div className="flex justify-between text-xs font-semibold mb-1">
              <span className="text-slate-600">Completion</span>
              <span className="text-brand-700">{Number(summary.completion_percentage || 0).toFixed(0)}%</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden border border-slate-200">
              <div
                className="h-2 rounded-full bg-brand-600 transition-all"
                style={{ width: `${Math.min(100, Math.max(0, Number(summary.completion_percentage || 0)))}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Active Alerts Banner if any */}
      {alerts.length > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/70 p-3 flex items-start gap-2.5 text-xs text-rose-900 shadow-xs">
          <AlertTriangle size={16} className="text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-bold">Attention Required: </span>
            <span>{alerts[0].message}</span>
            {alerts.length > 1 && (
              <span className="ml-2 font-semibold underline cursor-pointer" onClick={() => setActiveTab('Overview')}>
                +{alerts.length - 1} more alerts
              </span>
            )}
          </div>
        </div>
      )}

      {/* 4. Tab Navigation */}
      <div className="border-b border-slate-200 flex items-center justify-between">
        <div className="flex gap-1 overflow-x-auto">
          {(['Overview', 'Development', 'Material', 'Production', 'Shipment', 'Calendar', 'Gantt'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`px-4 py-2 text-xs font-semibold border-b-2 transition-colors ${
                activeTab === t
                  ? 'border-brand-600 text-brand-700 bg-brand-50/50'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
              onClick={() => setActiveTab(t)}
            >
              {t === 'Calendar' && <CalendarIcon size={13} className="inline mr-1 -mt-0.5" />}
              {t === 'Gantt' && <BarChart2 size={13} className="inline mr-1 -mt-0.5" />}
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* 5. Tab Content: OVERVIEW */}
      {activeTab === 'Overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Health status summary card */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Order Health Status</h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between items-center p-2 rounded-lg bg-emerald-50 border border-emerald-100">
                  <span className="text-emerald-800 font-medium">On Track Activities</span>
                  <span className="font-bold text-emerald-700">{activities.filter((a) => a.health_status === 'ON_TRACK').length}</span>
                </div>
                <div className="flex justify-between items-center p-2 rounded-lg bg-amber-50 border border-amber-100">
                  <span className="text-amber-800 font-medium">Approaching / At Risk</span>
                  <span className="font-bold text-amber-700">{summary.at_risk}</span>
                </div>
                <div className="flex justify-between items-center p-2 rounded-lg bg-rose-50 border border-rose-100">
                  <span className="text-rose-800 font-medium">Delayed Activities</span>
                  <span className="font-bold text-rose-700">{summary.delayed}</span>
                </div>
              </div>
            </div>

            {/* Category breakdown */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Milestones by Stage</h3>
              <div className="space-y-2 text-xs">
                {(['ORDER', 'SAMPLING', 'FABRIC', 'TRIM', 'PRODUCTION', 'QUALITY', 'SHIPMENT'] as const).map((cat) => {
                  const stageActs = activities.filter((a) => a.category === cat);
                  const stageDone = stageActs.filter((a) => a.status === 'COMPLETED').length;
                  if (stageActs.length === 0) return null;
                  return (
                    <div key={cat} className="flex justify-between items-center">
                      <span className="text-slate-600 font-medium">{cat}</span>
                      <span className="text-slate-900 font-mono">
                        {stageDone} / {stageActs.length}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Active alerts box */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center justify-between">
                <span>Active Schedule Alerts</span>
                <span className="rounded-full bg-rose-100 text-rose-700 px-2 py-0.5 text-[10px] font-bold">
                  {alerts.length}
                </span>
              </h3>
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {alerts.length === 0 ? (
                  <p className="text-slate-400 text-xs py-4 text-center">No active delay alerts. Plan is healthy!</p>
                ) : (
                  alerts.map((al, i) => (
                    <div
                      key={i}
                      className={`p-2.5 rounded-lg border text-xs ${
                        al.severity === 'CRITICAL'
                          ? 'bg-rose-50/80 border-rose-200 text-rose-900'
                          : 'bg-amber-50/80 border-amber-200 text-amber-900'
                      }`}
                    >
                      <div className="font-semibold">{al.activity_name}</div>
                      <div className="text-[11px] mt-0.5">{al.message}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 6. Activity Table View (For Overview, Development, Material, Production, Shipment tabs) */}
      {activeTab !== 'Calendar' && activeTab !== 'Gantt' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-xs">
          <div className="p-3 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs">
            <span className="font-semibold text-slate-700">
              Showing {filteredActivities.length} Milestones in {activeTab}
            </span>
            <span className="text-[11px] text-slate-500">
              Click any milestone to edit dates, assign owners or mark complete
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-100/70 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="py-2.5 px-3 w-12 text-center">Seq</th>
                  <th className="py-2.5 px-3">Activity</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3">Planned Start</th>
                  <th className="py-2.5 px-3">Planned End</th>
                  <th className="py-2.5 px-3">Actual Start</th>
                  <th className="py-2.5 px-3">Actual End</th>
                  <th className="py-2.5 px-3">Department</th>
                  <th className="py-2.5 px-3 text-center">Delay</th>
                  <th className="py-2.5 px-3 text-center">Health</th>
                  <th className="py-2.5 px-3 text-center">Status</th>
                  <th className="py-2.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {filteredActivities.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-8 text-center text-slate-400">
                      No activities recorded for this stage.
                    </td>
                  </tr>
                ) : (
                  filteredActivities.map((act) => {
                    const isDone = act.status === 'COMPLETED';
                    const delay = Number(act.delay_days || 0);

                    return (
                      <tr
                        key={act.id}
                        className={`hover:bg-slate-50 transition-colors cursor-pointer ${
                          act.health_status === 'DELAYED' || act.health_status === 'CRITICAL' ? 'bg-rose-50/20' : ''
                        }`}
                        onClick={() => openActivityDrawer(act)}
                      >
                        <td className="py-2.5 px-3 text-center font-mono font-medium text-slate-500">
                          {act.sequence_no}
                        </td>
                        <td className="py-2.5 px-3 font-medium text-slate-900">
                          <div className="flex items-center gap-1.5">
                            <span>{act.activity_name}</span>
                            {Boolean(act.mandatory) && (
                              <span className="text-rose-500 font-bold" title="Mandatory activity">*</span>
                            )}
                          </div>
                          {act.remarks && (
                            <div className="text-[11px] text-slate-500 truncate max-w-xs">{act.remarks}</div>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-700">
                            {act.category}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-mono">{fmtDate(act.planned_start_date)}</td>
                        <td className="py-2.5 px-3 font-mono font-medium text-slate-900">{fmtDate(act.planned_end_date)}</td>
                        <td className="py-2.5 px-3 font-mono text-slate-600">{fmtDate(act.actual_start_date) || '—'}</td>
                        <td className="py-2.5 px-3 font-mono text-emerald-700 font-medium">{fmtDate(act.actual_end_date) || '—'}</td>
                        <td className="py-2.5 px-3 text-slate-600">{act.department_name || '—'}</td>
                        <td className="py-2.5 px-3 text-center">
                          {delay > 0 ? (
                            <span className="rounded bg-rose-100 text-rose-800 font-bold px-1.5 py-0.5 text-[10px]">
                              +{delay} d
                            </span>
                          ) : (
                            <span className="text-slate-400 font-mono text-[11px]">0</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              act.health_status === 'CRITICAL'
                                ? 'bg-rose-100 text-rose-800'
                                : act.health_status === 'DELAYED'
                                ? 'bg-rose-100 text-rose-700'
                                : act.health_status === 'AT_RISK'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {act.health_status}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-center">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              isDone
                                ? 'bg-emerald-100 text-emerald-800'
                                : act.status === 'IN_PROGRESS'
                                ? 'bg-blue-100 text-blue-800'
                                : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {act.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                            {!isDone && (
                              <button
                                type="button"
                                className="btn-success btn-xs"
                                onClick={() => handleCompleteActivity(act.id)}
                                title="Mark Completed"
                              >
                                Done
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn-ghost btn-xs text-slate-600"
                              onClick={() => openActivityDrawer(act)}
                              title="Edit Activity"
                            >
                              <Edit size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 7. Tab Content: GANTT CHART VIEW */}
      {activeTab === 'Gantt' && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                <BarChart2 size={16} className="text-brand-600" />
                Interactive Time & Action Gantt Timeline
              </h3>
              <p className="text-xs text-slate-500">Visual critical path and sequence dependencies</p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> Completed</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-brand-500 inline-block" /> On Track</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /> At Risk</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" /> Delayed</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[800px] space-y-2">
              {activities.map((t) => {
                const isCompleted = t.status === 'COMPLETED';
                const isDelayed = t.health_status === 'DELAYED' || t.health_status === 'CRITICAL';
                const isAtRisk = t.health_status === 'AT_RISK';

                const barColor = isCompleted ? 'bg-emerald-500' : isDelayed ? 'bg-rose-500' : isAtRisk ? 'bg-amber-500' : 'bg-brand-500';

                return (
                  <div key={t.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-slate-50 hover:bg-slate-50/80 px-2 rounded">
                    <div className="w-48 shrink-0 truncate font-medium text-slate-800">
                      <span className="font-mono text-slate-400 mr-1.5">{t.sequence_no}.</span>
                      {t.activity_name}
                    </div>
                    <div className="w-24 shrink-0 text-[11px] font-mono text-slate-500">
                      {fmtDate(t.planned_start_date)}
                    </div>
                    <div className="flex-1 bg-slate-100 rounded-full h-4 relative overflow-hidden">
                      <div
                        className={`h-4 rounded-full ${barColor} transition-all opacity-85 flex items-center justify-end px-2 text-[10px] text-white font-bold`}
                        style={{ width: isCompleted ? '100%' : '65%' }}
                      >
                        {isCompleted ? '✓' : ''}
                      </div>
                    </div>
                    <div className="w-24 shrink-0 text-[11px] font-mono font-semibold text-slate-800 text-right">
                      {fmtDate(t.planned_end_date)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 8. Tab Content: CALENDAR VIEW */}
      {activeTab === 'Calendar' && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs space-y-3">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              <CalendarIcon size={16} className="text-brand-600" />
              T&A Milestone Calendar View
            </h3>
            <span className="text-xs text-slate-500">Color-coded by category and health status</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {activities.map((act) => {
              const isDone = act.status === 'COMPLETED';
              return (
                <div
                  key={act.id}
                  onClick={() => openActivityDrawer(act)}
                  className={`rounded-lg border p-3 cursor-pointer hover:shadow-sm transition-all text-xs ${
                    isDone
                      ? 'bg-emerald-50/50 border-emerald-200'
                      : act.health_status === 'DELAYED' || act.health_status === 'CRITICAL'
                      ? 'bg-rose-50/50 border-rose-200'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="text-[10px] font-bold text-slate-500">{act.category}</span>
                    <span
                      className={`text-[9px] font-bold rounded px-1 ${
                        isDone ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {act.status}
                    </span>
                  </div>
                  <h4 className="font-bold text-slate-900 line-clamp-1">{act.activity_name}</h4>
                  <div className="mt-2 text-[11px] text-slate-500 font-mono">
                    Due: <span className="font-semibold text-slate-800">{fmtDate(act.planned_end_date)}</span>
                  </div>
                  {act.delay_days > 0 && (
                    <div className="text-[10px] text-rose-600 font-bold mt-1">
                      Delayed by {act.delay_days} days
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 9. Activity Detail Edit Drawer / Modal */}
      {editDrawerOpen && selectedActivity && (
        <div className="fixed inset-0 z-50 flex items-center justify-end bg-slate-900/50 backdrop-blur-xs">
          <div className="w-full max-w-md h-full bg-white shadow-2xl p-5 overflow-y-auto flex flex-col justify-between">
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Seq #{selectedActivity.sequence_no} • {selectedActivity.category}
                  </span>
                  <h2 className="text-base font-bold text-slate-900">{selectedActivity.activity_name}</h2>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-sm text-slate-400 hover:text-slate-700"
                  onClick={() => setEditDrawerOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleSaveActivity} className="space-y-3.5">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Planned Start</label>
                    <input
                      type="date"
                      value={selectedActivity.planned_start_date}
                      onChange={(e) => setSelectedActivity({ ...selectedActivity, planned_start_date: e.target.value })}
                      className="input text-xs w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Planned End</label>
                    <input
                      type="date"
                      value={selectedActivity.planned_end_date}
                      onChange={(e) => setSelectedActivity({ ...selectedActivity, planned_end_date: e.target.value })}
                      className="input text-xs w-full"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Actual Start</label>
                    <input
                      type="date"
                      value={selectedActivity.actual_start_date}
                      onChange={(e) => setSelectedActivity({ ...selectedActivity, actual_start_date: e.target.value })}
                      className="input text-xs w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Actual End</label>
                    <input
                      type="date"
                      value={selectedActivity.actual_end_date}
                      onChange={(e) => setSelectedActivity({ ...selectedActivity, actual_end_date: e.target.value })}
                      className="input text-xs w-full"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Status</label>
                    <select
                      value={selectedActivity.status}
                      onChange={(e) => setSelectedActivity({ ...selectedActivity, status: e.target.value })}
                      className="input text-xs w-full"
                    >
                      <option value="NOT_STARTED">NOT_STARTED</option>
                      <option value="IN_PROGRESS">IN_PROGRESS</option>
                      <option value="COMPLETED">COMPLETED</option>
                      <option value="ON_HOLD">ON_HOLD</option>
                      <option value="CANCELLED">CANCELLED</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">Priority</label>
                    <select
                      value={selectedActivity.priority}
                      onChange={(e) => setSelectedActivity({ ...selectedActivity, priority: e.target.value })}
                      className="input text-xs w-full"
                    >
                      <option value="LOW">LOW</option>
                      <option value="MEDIUM">MEDIUM</option>
                      <option value="HIGH">HIGH</option>
                      <option value="CRITICAL">CRITICAL</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Responsible Department</label>
                  <input
                    type="text"
                    value={selectedActivity.department_name || ''}
                    onChange={(e) => setSelectedActivity({ ...selectedActivity, department_name: e.target.value })}
                    className="input text-xs w-full"
                    placeholder="e.g. Purchase / Merchandising"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">Remarks & Status Notes</label>
                  <textarea
                    rows={2}
                    value={selectedActivity.remarks || ''}
                    onChange={(e) => setSelectedActivity({ ...selectedActivity, remarks: e.target.value })}
                    className="input text-xs w-full"
                    placeholder="Notes regarding delay reason or status..."
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Reason for Date Change (Audit Log)
                  </label>
                  <input
                    type="text"
                    value={selectedActivity.reason || ''}
                    onChange={(e) => setSelectedActivity({ ...selectedActivity, reason: e.target.value })}
                    className="input text-xs w-full"
                    placeholder="e.g. Buyer lab dip approval delayed"
                  />
                </div>

                <div className="pt-3 border-t border-slate-200 flex items-center justify-between gap-2">
                  {selectedActivity.status !== 'COMPLETED' && (
                    <button
                      type="button"
                      className="btn-success btn-sm flex items-center gap-1 text-white bg-emerald-600 hover:bg-emerald-700"
                      onClick={() => handleCompleteActivity(selectedActivity.id)}
                    >
                      <CheckCircle size={14} /> Mark Done
                    </button>
                  )}
                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => setEditDrawerOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn-primary btn-sm flex items-center gap-1.5"
                    >
                      <Save size={14} /> Save Changes
                    </button>
                  </div>
                </div>
              </form>

              {/* Activity Change History List */}
              <div className="pt-4 border-t border-slate-200">
                <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Audit History</h4>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {(historyQuery.data || []).filter((h) => h.activity_id === selectedActivity.id).length === 0 ? (
                    <p className="text-[11px] text-slate-400">No revisions logged yet.</p>
                  ) : (
                    (historyQuery.data || [])
                      .filter((h) => h.activity_id === selectedActivity.id)
                      .map((h, i) => (
                        <div key={i} className="text-[11px] bg-slate-50 p-2 rounded border border-slate-100">
                          <div className="font-semibold text-slate-800 flex justify-between">
                            <span>{h.changed_by_name || 'User'}</span>
                            <span className="text-slate-400 font-mono">{fmtDate(h.changed_at)}</span>
                          </div>
                          <div className="text-slate-600 mt-0.5">{h.reason || 'Status updated'}</div>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
