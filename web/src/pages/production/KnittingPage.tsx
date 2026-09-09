import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity, Plus, Search, Eye, Trash2,
  AlertTriangle, RefreshCw, X, Layers, Box, FileText, Check, Printer
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Badge } from '../../components/ui';

export default function KnittingPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [subProcessFilter, setSubProcessFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPrintVoucher, setShowPrintVoucher] = useState(false);
  const [activeKwoId, setActiveKwoId] = useState<number | null>(null);
  const [manageTab, setManageTab] = useState<'issues' | 'rolls'>('issues');

  // Lookups
  const { data: styles = [] } = useQuery({
    queryKey: ['lookups', 'styles'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/styles')).data || [],
  });

  const { data: fabrics = [] } = useQuery({
    queryKey: ['lookups', 'fabrics'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/fabrics')).data || [],
  });

  const { data: yarns = [] } = useQuery({
    queryKey: ['lookups', 'yarns'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/yarns')).data || [],
  });

  const { data: parties = [] } = useQuery({
    queryKey: ['lookups', 'parties'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/parties')).data || [],
  });

  // Orders list
  const { data: orders = [], isLoading, refetch } = useQuery({
    queryKey: ['knitting-orders'],
    queryFn: async () => (await http.get<{ data: any[] }>('/knitting/orders')).data || [],
  });

  // Single Order Details
  const { data: activeOrder, refetch: refetchActive } = useQuery({
    queryKey: ['knitting-order', activeKwoId],
    queryFn: async () => {
      if (!activeKwoId) return null;
      return (await http.get<{ data: any }>(`/knitting/orders/${activeKwoId}`)).data;
    },
    enabled: !!activeKwoId,
  });

  // Create Form State
  const [newOrder, setNewOrder] = useState({
    kwo_no: '',
    kwo_date: today(),
    io_no: 'IO-2026-001',
    customer_po_no: '',
    style_id: '',
    sub_process: 'KNITTING',
    vendor_id: '',
    fabric_id: '',
    dia: '30"',
    gsm: '180',
    gauge: '24 GG',
    loop_length: '2.80',
    planned_fabric_kg: 500,
    planned_yarn_kg: 520,
    yarn_lot_no: 'Y-LOT-01',
    status: 'DRAFT',
    remarks: '',
  });

  // Yarn Issue Form State
  const [yarnIssue, setYarnIssue] = useState({
    issue_date: today(),
    yarn_id: '',
    yarn_lot_no: '',
    bags_cones: 10,
    issued_weight_kg: 260,
    remarks: '',
  });

  // Roll Output Form State
  const [rollOut, setRollOut] = useState({
    roll_no: '',
    lot_no: '',
    production_date: today(),
    dia: '30"',
    gsm: '180',
    meters: 100,
    weight_kg: 25,
    qc_status: 'ACCEPTED',
    defect_points: 0,
    rejection_reason: '',
  });

  // Auto-fill roll defaults when active order loads
  useEffect(() => {
    if (activeOrder) {
      const nextRollIdx = (activeOrder.roll_outputs?.length || 0) + 1;
      setRollOut(prev => ({
        ...prev,
        roll_no: `${activeOrder.kwo_no}-R${String(nextRollIdx).padStart(2, '0')}`,
        lot_no: activeOrder.yarn_lot_no || `LOT-${activeOrder.io_no}`,
        dia: activeOrder.dia || '30"',
        gsm: activeOrder.gsm || '180',
      }));
      setYarnIssue(prev => ({
        ...prev,
        yarn_lot_no: activeOrder.yarn_lot_no || '',
      }));
    }
  }, [activeOrder]);

  // Filtering
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const matchSearch =
        !search ||
        o.kwo_no?.toLowerCase().includes(search.toLowerCase()) ||
        o.io_no?.toLowerCase().includes(search.toLowerCase()) ||
        o.style_name?.toLowerCase().includes(search.toLowerCase()) ||
        o.fabric_name?.toLowerCase().includes(search.toLowerCase());

      const matchSub = subProcessFilter === 'ALL' || o.sub_process === subProcessFilter;
      const matchStatus = statusFilter === 'ALL' || o.status === statusFilter;

      return matchSearch && matchSub && matchStatus;
    });
  }, [orders, search, subProcessFilter, statusFilter]);

  // KPI Calculations
  const kpis = useMemo(() => {
    const totalOrders = orders.length;
    const totalYarn = orders.reduce((s, o) => s + (Number(o.total_yarn_issued_kg) || 0), 0);
    const totalFabric = orders.reduce((s, o) => s + (Number(o.total_fabric_produced_kg) || 0), 0);
    const lossKg = Math.max(0, totalYarn - totalFabric);
    const lossPct = totalYarn > 0 ? (lossKg / totalYarn) * 100 : 0;
    return { totalOrders, totalYarn, totalFabric, lossPct };
  }, [orders]);

  // Create KWO
  const createMutation = useMutation({
    mutationFn: async (payload: any) => http.post('/knitting/orders', payload),
    onSuccess: () => {
      toast('Knitting Work Order created successfully');
      setShowCreateModal(false);
      qc.invalidateQueries({ queryKey: ['knitting-orders'] });
    },
    onError: (err: any) => toast(err?.response?.data?.error?.message || 'Failed to create KWO', 'error'),
  });

  // Add Yarn Issue
  const issueMutation = useMutation({
    mutationFn: async (payload: any) => http.post('/knitting/yarn-issues', payload),
    onSuccess: () => {
      toast('Yarn issued successfully');
      refetchActive();
      qc.invalidateQueries({ queryKey: ['knitting-orders'] });
    },
    onError: (err: any) => toast(err?.response?.data?.error?.message || 'Failed to issue yarn', 'error'),
  });

  // Add Roll Output
  const rollMutation = useMutation({
    mutationFn: async (payload: any) => http.post('/knitting/rolls', payload),
    onSuccess: () => {
      toast('Grey fabric roll recorded');
      refetchActive();
      qc.invalidateQueries({ queryKey: ['knitting-orders'] });
    },
    onError: (err: any) => toast(err?.response?.data?.error?.message || 'Failed to record roll', 'error'),
  });

  // Delete Roll
  const deleteRollMutation = useMutation({
    mutationFn: async (id: number) => http.del(`/knitting/rolls/${id}`),
    onSuccess: () => {
      toast('Roll removed');
      refetchActive();
      qc.invalidateQueries({ queryKey: ['knitting-orders'] });
    },
    onError: (err: any) => toast(err?.response?.data?.error?.message || 'Failed to remove roll', 'error'),
  });

  // Delete Yarn Issue
  const deleteIssueMutation = useMutation({
    mutationFn: async (id: number) => http.del(`/knitting/yarn-issues/${id}`),
    onSuccess: () => {
      toast('Yarn issue removed');
      refetchActive();
      qc.invalidateQueries({ queryKey: ['knitting-orders'] });
    },
    onError: (err: any) => toast(err?.response?.data?.error?.message || 'Failed to remove yarn issue', 'error'),
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-xl bg-teal-100 text-teal-700 shadow-sm">
              <Activity size={22} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Knitting Work Orders</h1>
              <p className="text-xs text-slate-500">
                Yarn issue, grey fabric knitting, winding, twisting & roll QC output tracking
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="p-2 border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 transition"
            title="Refresh"
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="btn-primary text-xs flex items-center gap-1.5 shadow-sm"
          >
            <Plus size={15} /> New Knitting Order
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card p-4 flex items-center gap-3.5 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-2.5 rounded-xl bg-teal-50 text-teal-600">
            <FileText size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Total KWOs</p>
            <p className="text-xl font-bold text-slate-900">{kpis.totalOrders}</p>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-3.5 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-2.5 rounded-xl bg-indigo-50 text-indigo-600">
            <Layers size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Yarn Issued</p>
            <p className="text-xl font-bold text-slate-900">{fmtDecimal(kpis.totalYarn)} <span className="text-xs font-normal text-slate-500">kg</span></p>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-3.5 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-600">
            <Box size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Grey Rolls Produced</p>
            <p className="text-xl font-bold text-slate-900">{fmtDecimal(kpis.totalFabric)} <span className="text-xs font-normal text-slate-500">kg</span></p>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-3.5 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-2.5 rounded-xl bg-amber-50 text-amber-600">
            <AlertTriangle size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Avg Knitting Loss</p>
            <p className="text-xl font-bold text-slate-900">{fmtDecimal(kpis.lossPct)}%</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search by KWO No, IO No, Style, Fabric..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-9 text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={subProcessFilter}
              onChange={(e) => setSubProcessFilter(e.target.value)}
              className="input text-xs w-44"
            >
              <option value="ALL">All Sub-processes</option>
              <option value="KNITTING">Knitting</option>
              <option value="WINDING">Winding</option>
              <option value="TWISTING">Twisting</option>
              <option value="YARN_DYEING">Yarn Dyeing</option>
              <option value="COLLAR_KNITTING">Collar Knitting</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input text-xs w-36"
            >
              <option value="ALL">All Status</option>
              <option value="DRAFT">Draft</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="COMPLETED">Completed</option>
            </select>
          </div>
        </div>
      </div>

      {/* Orders Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table w-full text-xs">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 uppercase font-semibold">
              <tr>
                <th className="py-3 px-4 text-left">KWO No</th>
                <th className="py-3 px-4 text-left">Date</th>
                <th className="py-3 px-4 text-left">IO No</th>
                <th className="py-3 px-4 text-left">Style</th>
                <th className="py-3 px-4 text-left">Sub-Process</th>
                <th className="py-3 px-4 text-left">Fabric Target</th>
                <th className="py-3 px-4 text-right">Planned (Kg)</th>
                <th className="py-3 px-4 text-right">Yarn Issued</th>
                <th className="py-3 px-4 text-right">Fabric Produced</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-slate-400">Loading knitting orders...</td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-slate-400">No knitting work orders found</td>
                </tr>
              ) : (
                filteredOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50/70 transition">
                    <td className="py-3 px-4 font-semibold text-teal-700">{o.kwo_no}</td>
                    <td className="py-3 px-4 text-slate-500">{fmtDate(o.kwo_date)}</td>
                    <td className="py-3 px-4 font-medium text-slate-900">
                      <div>{o.io_no}</div>
                      {o.customer_po_no && (
                        <div className="text-[10px] text-teal-600 font-normal">PO: {o.customer_po_no}</div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      {o.style_code ? (
                        <div>
                          <span className="font-semibold text-slate-900">{o.style_code}</span>
                          <span className="text-slate-400 text-[10px] block">{o.style_name}</span>
                        </div>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-700">
                        {o.sub_process}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-800">{o.fabric_name || 'Single Jersey'}</div>
                      <div className="text-[10px] text-slate-400">Dia: {o.dia || '-'} | GSM: {o.gsm || '-'}</div>
                    </td>
                    <td className="py-3 px-4 text-right font-medium">{fmtDecimal(o.planned_fabric_kg)}</td>
                    <td className="py-3 px-4 text-right font-medium text-indigo-600">{fmtDecimal(o.total_yarn_issued_kg)} kg</td>
                    <td className="py-3 px-4 text-right font-medium text-emerald-600">
                      {fmtDecimal(o.total_fabric_produced_kg)} kg
                      <span className="text-[10px] text-slate-400 block">({o.total_rolls_count || 0} rolls)</span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <Badge variant={o.status === 'COMPLETED' ? 'success' : o.status === 'IN_PROGRESS' ? 'warning' : 'neutral'}>
                        {o.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => {
                          setActiveKwoId(o.id);
                          setManageTab('issues');
                        }}
                        className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 mx-auto"
                      >
                        <Eye size={13} /> Manage
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CREATE KWO MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl overflow-hidden border border-slate-100 max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-2">
                <span className="p-1.5 rounded-lg bg-teal-100 text-teal-700">
                  <Activity size={18} />
                </span>
                <h3 className="text-base font-bold text-slate-900">New Knitting Work Order</h3>
              </div>
              <button onClick={() => setShowCreateModal(false)} className="text-slate-400 hover:text-slate-600">
                <X size={18} />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate({
                  ...newOrder,
                  style_id: newOrder.style_id ? Number(newOrder.style_id) : null,
                  vendor_id: newOrder.vendor_id ? Number(newOrder.vendor_id) : null,
                  fabric_id: newOrder.fabric_id ? Number(newOrder.fabric_id) : null,
                  planned_fabric_kg: Number(newOrder.planned_fabric_kg),
                  planned_yarn_kg: Number(newOrder.planned_yarn_kg),
                });
              }}
              className="p-6 space-y-4 overflow-y-auto flex-1 text-xs"
            >
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="label">I/O No (Internal Order) *</label>
                  <input
                    type="text"
                    required
                    value={newOrder.io_no}
                    onChange={(e) => setNewOrder({ ...newOrder, io_no: e.target.value })}
                    placeholder="e.g. IO-2026-001"
                    className="input text-xs font-semibold"
                  />
                </div>
                <div>
                  <label className="label">Customer PO No</label>
                  <input
                    type="text"
                    value={newOrder.customer_po_no}
                    onChange={(e) => setNewOrder({ ...newOrder, customer_po_no: e.target.value })}
                    placeholder="e.g. PO-2026-A12"
                    className="input text-xs font-semibold"
                  />
                </div>
                <div>
                  <label className="label">Order Date *</label>
                  <input
                    type="date"
                    required
                    value={newOrder.kwo_date}
                    onChange={(e) => setNewOrder({ ...newOrder, kwo_date: e.target.value })}
                    className="input text-xs"
                  />
                </div>
                <div>
                  <label className="label">Sub-Process *</label>
                  <select
                    value={newOrder.sub_process}
                    onChange={(e) => setNewOrder({ ...newOrder, sub_process: e.target.value })}
                    className="input text-xs font-medium"
                  >
                    <option value="KNITTING">Knitting</option>
                    <option value="WINDING">Winding</option>
                    <option value="TWISTING">Twisting</option>
                    <option value="YARN_DYEING">Yarn Dyeing</option>
                    <option value="COLLAR_KNITTING">Collar Knitting</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="label">Style Reference</label>
                  <select
                    value={newOrder.style_id}
                    onChange={(e) => setNewOrder({ ...newOrder, style_id: e.target.value })}
                    className="input text-xs"
                  >
                    <option value="">-- Select Style --</option>
                    {styles.map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {s.style_code} - {s.style_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Knitting Vendor / Unit</label>
                  <select
                    value={newOrder.vendor_id}
                    onChange={(e) => setNewOrder({ ...newOrder, vendor_id: e.target.value })}
                    className="input text-xs"
                  >
                    <option value="">-- In-House or Select Party --</option>
                    {parties.map((p: any) => (
                      <option key={p.id} value={p.id}>{p.party_name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="label">Target Fabric *</label>
                  <select
                    value={newOrder.fabric_id}
                    onChange={(e) => setNewOrder({ ...newOrder, fabric_id: e.target.value })}
                    className="input text-xs"
                  >
                    <option value="">-- Select Fabric Master --</option>
                    {fabrics.map((f: any) => (
                      <option key={f.id} value={f.id}>{f.fabric_name} ({f.fabric_code})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Dia (Inches)</label>
                  <input
                    type="text"
                    value={newOrder.dia}
                    onChange={(e) => setNewOrder({ ...newOrder, dia: e.target.value })}
                    placeholder="30&quot;"
                    className="input text-xs"
                  />
                </div>
                <div>
                  <label className="label">GSM</label>
                  <input
                    type="text"
                    value={newOrder.gsm}
                    onChange={(e) => setNewOrder({ ...newOrder, gsm: e.target.value })}
                    placeholder="180"
                    className="input text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="label">Planned Fabric (Kg) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={newOrder.planned_fabric_kg}
                    onChange={(e) => setNewOrder({ ...newOrder, planned_fabric_kg: Number(e.target.value) })}
                    className="input text-xs font-semibold text-emerald-700"
                  />
                </div>
                <div>
                  <label className="label">Planned Yarn (Kg) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={newOrder.planned_yarn_kg}
                    onChange={(e) => setNewOrder({ ...newOrder, planned_yarn_kg: Number(e.target.value) })}
                    className="input text-xs font-semibold text-indigo-700"
                  />
                </div>
                <div>
                  <label className="label">Gauge</label>
                  <input
                    type="text"
                    value={newOrder.gauge}
                    onChange={(e) => setNewOrder({ ...newOrder, gauge: e.target.value })}
                    placeholder="24 GG"
                    className="input text-xs"
                  />
                </div>
                <div>
                  <label className="label">Yarn Lot No</label>
                  <input
                    type="text"
                    value={newOrder.yarn_lot_no}
                    onChange={(e) => setNewOrder({ ...newOrder, yarn_lot_no: e.target.value })}
                    placeholder="Y-LOT-01"
                    className="input text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="label">Remarks</label>
                <textarea
                  rows={2}
                  value={newOrder.remarks}
                  onChange={(e) => setNewOrder({ ...newOrder, remarks: e.target.value })}
                  className="input text-xs"
                  placeholder="Special instructions, loop length, yarn count, etc."
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="btn-primary text-xs flex items-center gap-1.5"
                >
                  <Check size={14} /> Create Work Order
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MANAGE KWO DETAIL MODAL */}
      {activeOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden border border-slate-100 max-h-[92vh] flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-base text-slate-900">{activeOrder.kwo_no}</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-teal-100 text-teal-800">
                    {activeOrder.sub_process}
                  </span>
                  <Badge variant={activeOrder.status === 'COMPLETED' ? 'success' : 'warning'}>
                    {activeOrder.status}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  I/O No: <span className="font-semibold text-slate-800">{activeOrder.io_no}</span>
                  {activeOrder.customer_po_no && (
                    <> | Customer PO: <span className="font-semibold text-teal-700">{activeOrder.customer_po_no}</span></>
                  )}
                  {' '}| Style: <span className="font-medium text-slate-800">{activeOrder.style_code || '-'}</span> | Target: <span className="font-medium text-slate-800">{activeOrder.fabric_name} ({activeOrder.dia || '-'}, {activeOrder.gsm || '-'} GSM)</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowPrintVoucher(true)}
                  className="btn-secondary text-xs flex items-center gap-1.5 py-1 px-3 border border-slate-300 hover:bg-slate-100 shadow-sm"
                >
                  <Printer size={14} /> Print Work Order
                </button>
                <button onClick={() => setActiveKwoId(null)} className="text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Production Summary Cards */}
            <div className="px-6 py-3 bg-slate-100/50 border-b border-slate-100 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="p-2.5 bg-white rounded-xl border border-slate-200/60">
                <span className="text-slate-400 block text-[10px]">Total Yarn Issued</span>
                <span className="text-sm font-bold text-indigo-700">
                  {fmtDecimal(activeOrder.summary?.total_yarn_issued_kg)} kg
                </span>
              </div>
              <div className="p-2.5 bg-white rounded-xl border border-slate-200/60">
                <span className="text-slate-400 block text-[10px]">Total Fabric Produced</span>
                <span className="text-sm font-bold text-emerald-700">
                  {fmtDecimal(activeOrder.summary?.total_rolls_produced_kg)} kg
                </span>
                <span className="text-[10px] text-slate-400 ml-1">({activeOrder.summary?.total_rolls_count} rolls)</span>
              </div>
              <div className="p-2.5 bg-white rounded-xl border border-slate-200/60">
                <span className="text-slate-400 block text-[10px]">Knitting Loss (Kg)</span>
                <span className="text-sm font-bold text-amber-700">
                  {fmtDecimal(activeOrder.summary?.knitting_loss_kg)} kg
                </span>
              </div>
              <div className="p-2.5 bg-white rounded-xl border border-slate-200/60">
                <span className="text-slate-400 block text-[10px]">Knitting Loss (%)</span>
                <span className="text-sm font-bold text-slate-800">
                  {fmtDecimal(activeOrder.summary?.knitting_loss_pct)}%
                </span>
              </div>
            </div>

            {/* Tab Navigation */}
            <div className="flex border-b border-slate-200 px-6 pt-2 bg-white gap-4 text-xs font-semibold">
              <button
                onClick={() => setManageTab('issues')}
                className={`pb-2.5 flex items-center gap-1.5 border-b-2 transition ${
                  manageTab === 'issues'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                <Layers size={14} /> 1. Yarn Issue to Knitting ({activeOrder.yarn_issues?.length || 0})
              </button>
              <button
                onClick={() => setManageTab('rolls')}
                className={`pb-2.5 flex items-center gap-1.5 border-b-2 transition ${
                  manageTab === 'rolls'
                    ? 'border-teal-600 text-teal-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                <Box size={14} /> 2. Grey Fabric Roll Entry & QC ({activeOrder.roll_outputs?.length || 0})
              </button>
            </div>

            {/* Tab Content */}
            <div className="p-6 overflow-y-auto flex-1 space-y-6 text-xs">
              {manageTab === 'issues' ? (
                /* TAB 1: YARN ISSUE */
                <div className="space-y-4">
                  {/* Issue Form */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      issueMutation.mutate({
                        ...yarnIssue,
                        kwo_id: activeOrder.id,
                        yarn_id: Number(yarnIssue.yarn_id),
                        bags_cones: Number(yarnIssue.bags_cones),
                        issued_weight_kg: Number(yarnIssue.issued_weight_kg),
                      });
                    }}
                    className="p-4 bg-indigo-50/40 rounded-xl border border-indigo-100 space-y-3"
                  >
                    <h4 className="font-semibold text-indigo-950 flex items-center gap-1.5">
                      <Plus size={14} /> Record Yarn Issue to Knitting
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                      <div>
                        <label className="label">Issue Date *</label>
                        <input
                          type="date"
                          required
                          value={yarnIssue.issue_date}
                          onChange={(e) => setYarnIssue({ ...yarnIssue, issue_date: e.target.value })}
                          className="input text-xs"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="label">Select Yarn Master *</label>
                        <select
                          required
                          value={yarnIssue.yarn_id}
                          onChange={(e) => setYarnIssue({ ...yarnIssue, yarn_id: e.target.value })}
                          className="input text-xs"
                        >
                          <option value="">-- Choose Yarn --</option>
                          {yarns.map((y: any) => (
                            <option key={y.id} value={y.id}>{y.yarn_name} ({y.yarn_code})</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="label">Yarn Lot No</label>
                        <input
                          type="text"
                          value={yarnIssue.yarn_lot_no}
                          onChange={(e) => setYarnIssue({ ...yarnIssue, yarn_lot_no: e.target.value })}
                          className="input text-xs"
                          placeholder="e.g. YLOT-10"
                        />
                      </div>
                      <div>
                        <label className="label">Bags / Cones</label>
                        <input
                          type="number"
                          value={yarnIssue.bags_cones}
                          onChange={(e) => setYarnIssue({ ...yarnIssue, bags_cones: Number(e.target.value) })}
                          className="input text-xs"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                      <div>
                        <label className="label">Issued Weight (Kg) *</label>
                        <input
                          type="number"
                          step="0.01"
                          required
                          value={yarnIssue.issued_weight_kg}
                          onChange={(e) => setYarnIssue({ ...yarnIssue, issued_weight_kg: Number(e.target.value) })}
                          className="input text-xs font-bold text-indigo-700"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="label">Remarks</label>
                        <input
                          type="text"
                          value={yarnIssue.remarks}
                          onChange={(e) => setYarnIssue({ ...yarnIssue, remarks: e.target.value })}
                          className="input text-xs"
                          placeholder="Batch info, storage bin..."
                        />
                      </div>
                      <div>
                        <button
                          type="submit"
                          disabled={issueMutation.isPending}
                          className="btn-primary text-xs w-full py-2 flex items-center justify-center gap-1.5"
                        >
                          <Plus size={14} /> Add Issue Entry
                        </button>
                      </div>
                    </div>
                  </form>

                  {/* Issues List Table */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="table w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                        <tr>
                          <th className="py-2.5 px-3 text-left">Issue No</th>
                          <th className="py-2.5 px-3 text-left">Date</th>
                          <th className="py-2.5 px-3 text-left">Yarn</th>
                          <th className="py-2.5 px-3 text-left">Lot No</th>
                          <th className="py-2.5 px-3 text-right">Bags/Cones</th>
                          <th className="py-2.5 px-3 text-right">Issued (Kg)</th>
                          <th className="py-2.5 px-3 text-center">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {activeOrder.yarn_issues?.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="py-6 text-center text-slate-400">No yarn issued yet</td>
                          </tr>
                        ) : (
                          activeOrder.yarn_issues?.map((yi: any) => (
                            <tr key={yi.id} className="hover:bg-slate-50">
                              <td className="py-2 px-3 font-semibold text-indigo-700">{yi.issue_no}</td>
                              <td className="py-2 px-3 text-slate-500">{fmtDate(yi.issue_date)}</td>
                              <td className="py-2 px-3 font-medium text-slate-800">{yi.yarn_name}</td>
                              <td className="py-2 px-3 font-mono text-slate-600">{yi.yarn_lot_no || '-'}</td>
                              <td className="py-2 px-3 text-right">{yi.bags_cones}</td>
                              <td className="py-2 px-3 text-right font-bold text-indigo-700">{fmtDecimal(yi.issued_weight_kg)} kg</td>
                              <td className="py-2 px-3 text-center">
                                <button
                                  onClick={() => deleteIssueMutation.mutate(yi.id)}
                                  className="text-red-500 hover:text-red-700 p-1 rounded"
                                  title="Delete Issue"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                /* TAB 2: ROLL PRODUCTION ENTRY */
                <div className="space-y-4">
                  {/* Roll Form */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      rollMutation.mutate({
                        ...rollOut,
                        kwo_id: activeOrder.id,
                        meters: Number(rollOut.meters),
                        weight_kg: Number(rollOut.weight_kg),
                        defect_points: Number(rollOut.defect_points),
                      });
                    }}
                    className="p-4 bg-teal-50/40 rounded-xl border border-teal-100 space-y-3"
                  >
                    <h4 className="font-semibold text-teal-950 flex items-center gap-1.5">
                      <Plus size={14} /> Record Grey Fabric Roll Output & QC
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div>
                        <label className="label">Roll No *</label>
                        <input
                          type="text"
                          required
                          value={rollOut.roll_no}
                          onChange={(e) => setRollOut({ ...rollOut, roll_no: e.target.value })}
                          className="input text-xs font-semibold text-teal-800"
                        />
                      </div>
                      <div>
                        <label className="label">Grey Fabric Lot No *</label>
                        <input
                          type="text"
                          required
                          value={rollOut.lot_no}
                          onChange={(e) => setRollOut({ ...rollOut, lot_no: e.target.value })}
                          className="input text-xs"
                        />
                      </div>
                      <div>
                        <label className="label">Production Date *</label>
                        <input
                          type="date"
                          required
                          value={rollOut.production_date}
                          onChange={(e) => setRollOut({ ...rollOut, production_date: e.target.value })}
                          className="input text-xs"
                        />
                      </div>
                      <div>
                        <label className="label">QC Disposition *</label>
                        <select
                          value={rollOut.qc_status}
                          onChange={(e) => setRollOut({ ...rollOut, qc_status: e.target.value })}
                          className="input text-xs font-semibold"
                        >
                          <option value="ACCEPTED">ACCEPTED (Pass to Process)</option>
                          <option value="HOLD">HOLD (Quarantine)</option>
                          <option value="REJECTED">REJECTED</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                      <div>
                        <label className="label">Dia (Inches)</label>
                        <input
                          type="text"
                          value={rollOut.dia}
                          onChange={(e) => setRollOut({ ...rollOut, dia: e.target.value })}
                          className="input text-xs"
                        />
                      </div>
                      <div>
                        <label className="label">GSM</label>
                        <input
                          type="text"
                          value={rollOut.gsm}
                          onChange={(e) => setRollOut({ ...rollOut, gsm: e.target.value })}
                          className="input text-xs"
                        />
                      </div>
                      <div>
                        <label className="label">Meters</label>
                        <input
                          type="number"
                          step="0.01"
                          value={rollOut.meters}
                          onChange={(e) => setRollOut({ ...rollOut, meters: Number(e.target.value) })}
                          className="input text-xs"
                        />
                      </div>
                      <div>
                        <label className="label">Weight (Kg) *</label>
                        <input
                          type="number"
                          step="0.01"
                          required
                          value={rollOut.weight_kg}
                          onChange={(e) => setRollOut({ ...rollOut, weight_kg: Number(e.target.value) })}
                          className="input text-xs font-bold text-teal-700"
                        />
                      </div>
                      <div>
                        <button
                          type="submit"
                          disabled={rollMutation.isPending}
                          className="btn-primary text-xs w-full py-2 flex items-center justify-center gap-1.5"
                        >
                          <Plus size={14} /> Add Roll Output
                        </button>
                      </div>
                    </div>
                  </form>

                  {/* Rolls List Table */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <table className="table w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                        <tr>
                          <th className="py-2.5 px-3 text-left">Roll No</th>
                          <th className="py-2.5 px-3 text-left">Lot No</th>
                          <th className="py-2.5 px-3 text-left">Date</th>
                          <th className="py-2.5 px-3 text-left">Dia / GSM</th>
                          <th className="py-2.5 px-3 text-right">Meters</th>
                          <th className="py-2.5 px-3 text-right">Weight (Kg)</th>
                          <th className="py-2.5 px-3 text-center">QC Status</th>
                          <th className="py-2.5 px-3 text-center">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {activeOrder.roll_outputs?.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="py-6 text-center text-slate-400">No rolls produced yet</td>
                          </tr>
                        ) : (
                          activeOrder.roll_outputs?.map((ro: any) => (
                            <tr key={ro.id} className="hover:bg-slate-50">
                              <td className="py-2 px-3 font-semibold text-teal-700">{ro.roll_no}</td>
                              <td className="py-2 px-3 font-mono text-slate-600">{ro.lot_no}</td>
                              <td className="py-2 px-3 text-slate-500">{fmtDate(ro.production_date)}</td>
                              <td className="py-2 px-3 text-slate-600">{ro.dia || '-'} / {ro.gsm || '-'} GSM</td>
                              <td className="py-2 px-3 text-right font-medium">{fmtDecimal(ro.meters)} m</td>
                              <td className="py-2 px-3 text-right font-bold text-teal-700">{fmtDecimal(ro.weight_kg)} kg</td>
                              <td className="py-2 px-3 text-center">
                                <Badge variant={ro.qc_status === 'ACCEPTED' ? 'success' : ro.qc_status === 'HOLD' ? 'warning' : 'danger'}>
                                  {ro.qc_status}
                                </Badge>
                              </td>
                              <td className="py-2 px-3 text-center">
                                <button
                                  onClick={() => deleteRollMutation.mutate(ro.id)}
                                  className="text-red-500 hover:text-red-700 p-1 rounded"
                                  title="Delete Roll"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PRINTABLE KNITTING WORK ORDER VOUCHER MODAL */}
      {showPrintVoucher && activeOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden border border-slate-200 my-auto flex flex-col max-h-[96vh]">
            <div className="px-6 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50 no-print">
              <span className="font-bold text-sm text-slate-800 flex items-center gap-2">
                <Printer size={16} className="text-teal-600" /> Print Knitting Work Order
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="btn-primary text-xs py-1.5 px-4 flex items-center gap-1.5"
                >
                  <Printer size={14} /> Print Now
                </button>
                <button
                  type="button"
                  onClick={() => setShowPrintVoucher(false)}
                  className="btn-secondary text-xs py-1.5 px-3"
                >
                  Close
                </button>
              </div>
            </div>

            {/* Printable Document Sheet */}
            <div className="p-8 overflow-y-auto print-container text-slate-900 bg-white font-sans text-xs">
              {/* Company & Document Title */}
              <div className="border-b-2 border-slate-800 pb-4 mb-4 text-center">
                <h1 className="text-xl font-black uppercase tracking-wider text-slate-900">GARMENT MANUFACTURING ERP</h1>
                <p className="text-xs text-slate-500 font-medium">Knitting Division — Work Order & Yarn Issuance Card</p>
                <div className="inline-block mt-2 px-4 py-1 rounded bg-teal-100 text-teal-900 font-bold text-sm tracking-wide">
                  {activeOrder.sub_process} WORK ORDER
                </div>
              </div>

              {/* Order Meta Grid */}
              <div className="grid grid-cols-2 gap-4 border border-slate-300 rounded-lg p-3.5 mb-4 bg-slate-50/50">
                <div className="space-y-1.5">
                  <div><span className="text-slate-500 font-medium">KWO Order No:</span> <span className="font-bold text-slate-900 font-mono text-sm">{activeOrder.kwo_no}</span></div>
                  <div><span className="text-slate-500 font-medium">Order Date:</span> <span className="font-semibold text-slate-800">{fmtDate(activeOrder.kwo_date)}</span></div>
                  <div><span className="text-slate-500 font-medium">Sub-Process:</span> <span className="font-bold text-teal-700">{activeOrder.sub_process}</span></div>
                  <div><span className="text-slate-500 font-medium">Knitting Vendor:</span> <span className="font-semibold text-slate-800">{activeOrder.vendor_name || 'In-House Unit'}</span></div>
                </div>
                <div className="space-y-1.5 border-l border-slate-200 pl-4">
                  <div><span className="text-slate-500 font-medium">Internal Order (I/O No):</span> <span className="font-bold text-sky-800 font-mono">{activeOrder.io_no}</span></div>
                  <div><span className="text-slate-500 font-medium">Customer PO No:</span> <span className="font-bold text-teal-800 font-mono">{activeOrder.customer_po_no || 'N/A'}</span></div>
                  <div><span className="text-slate-500 font-medium">Style:</span> <span className="font-semibold text-slate-800">{activeOrder.style_code ? `${activeOrder.style_code} - ${activeOrder.style_name || ''}` : '-'}</span></div>
                  <div><span className="text-slate-500 font-medium">Fabric:</span> <span className="font-semibold text-slate-800">{activeOrder.fabric_name || '-'}</span></div>
                </div>
              </div>

              {/* Technical Specifications */}
              <div className="border border-slate-300 rounded-lg p-3.5 mb-4">
                <h4 className="font-bold text-xs uppercase tracking-wider text-slate-700 mb-2 border-b border-slate-200 pb-1">
                  Technical Specifications & Yarn Plan
                </h4>
                <div className="grid grid-cols-4 gap-3 text-center">
                  <div className="p-2 bg-slate-50 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Fabric GSM</span>
                    <span className="text-sm font-bold text-teal-700">{activeOrder.gsm || '-'} GSM</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Dia / Width</span>
                    <span className="text-sm font-bold text-slate-800">{activeOrder.dia || '-'}</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Gauge / Loop</span>
                    <span className="text-sm font-bold text-slate-800">{activeOrder.gauge || '-'} / {activeOrder.loop_length || '-'}</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Yarn Lot No</span>
                    <span className="text-sm font-bold text-slate-800 font-mono">{activeOrder.yarn_lot_no || '-'}</span>
                  </div>
                </div>
              </div>

              {/* Planned vs Actual Quantities */}
              <div className="grid grid-cols-4 gap-3 mb-4 text-center">
                <div className="p-2.5 border border-slate-200 bg-slate-50 rounded-lg">
                  <span className="text-[10px] uppercase font-bold text-slate-600 block">Planned Fabric</span>
                  <span className="text-sm font-black text-slate-900">{fmtDecimal(activeOrder.planned_fabric_kg)} kg</span>
                </div>
                <div className="p-2.5 border border-indigo-200 bg-indigo-50 rounded-lg">
                  <span className="text-[10px] uppercase font-bold text-indigo-700 block">Total Yarn Issued</span>
                  <span className="text-sm font-black text-indigo-900">{fmtDecimal(activeOrder.summary?.total_yarn_issued_kg)} kg</span>
                </div>
                <div className="p-2.5 border border-emerald-200 bg-emerald-50 rounded-lg">
                  <span className="text-[10px] uppercase font-bold text-emerald-700 block">Total Produced</span>
                  <span className="text-sm font-black text-emerald-900">{fmtDecimal(activeOrder.summary?.total_rolls_produced_kg)} kg</span>
                  <span className="text-[10px] text-emerald-600 block">({activeOrder.summary?.total_rolls_count} rolls)</span>
                </div>
                <div className="p-2.5 border border-amber-200 bg-amber-50 rounded-lg">
                  <span className="text-[10px] uppercase font-bold text-amber-700 block">Knitting Loss</span>
                  <span className="text-sm font-black text-amber-900">{fmtDecimal(activeOrder.summary?.knitting_loss_kg)} kg</span>
                  <span className="text-[10px] text-amber-600 block">({fmtDecimal(activeOrder.summary?.knitting_loss_pct)}%)</span>
                </div>
              </div>

              {/* Yarn Issued Lines Table */}
              <div className="mb-4">
                <h4 className="font-bold text-xs uppercase tracking-wider text-slate-700 mb-1.5">
                  Yarn Issuance Details
                </h4>
                <table className="w-full border-collapse border border-slate-300 text-[11px]">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700">
                      <th className="border border-slate-300 py-1 px-2 text-left">Issue No</th>
                      <th className="border border-slate-300 py-1 px-2 text-left">Date</th>
                      <th className="border border-slate-300 py-1 px-2 text-left">Yarn</th>
                      <th className="border border-slate-300 py-1 px-2 text-left">Lot No</th>
                      <th className="border border-slate-300 py-1 px-2 text-right">Bags/Cones</th>
                      <th className="border border-slate-300 py-1 px-2 text-right">Issued Wt (kg)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!activeOrder.yarn_issues || activeOrder.yarn_issues.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="border border-slate-300 py-2 text-center text-slate-400 italic">
                          No yarn issued yet.
                        </td>
                      </tr>
                    ) : (
                      activeOrder.yarn_issues.map((yi: any, idx: number) => (
                        <tr key={yi.id || idx}>
                          <td className="border border-slate-300 py-1 px-2 font-mono">{yi.issue_no}</td>
                          <td className="border border-slate-300 py-1 px-2">{fmtDate(yi.issue_date)}</td>
                          <td className="border border-slate-300 py-1 px-2">{yi.yarn_name}</td>
                          <td className="border border-slate-300 py-1 px-2">{yi.yarn_lot_no || '-'}</td>
                          <td className="border border-slate-300 py-1 px-2 text-right">{yi.bags_cones}</td>
                          <td className="border border-slate-300 py-1 px-2 text-right font-semibold">{fmtDecimal(yi.issued_weight_kg)} kg</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Grey Rolls Produced Table */}
              <div className="mb-6">
                <h4 className="font-bold text-xs uppercase tracking-wider text-slate-700 mb-1.5">
                  Grey Fabric Rolls Produced
                </h4>
                <table className="w-full border-collapse border border-slate-300 text-[11px]">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700">
                      <th className="border border-slate-300 py-1 px-2 text-left">Roll No</th>
                      <th className="border border-slate-300 py-1 px-2 text-left">Lot No</th>
                      <th className="border border-slate-300 py-1 px-2 text-center">Dia / GSM</th>
                      <th className="border border-slate-300 py-1 px-2 text-right">Meters</th>
                      <th className="border border-slate-300 py-1 px-2 text-right">Weight (kg)</th>
                      <th className="border border-slate-300 py-1 px-2 text-center">QC Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!activeOrder.roll_outputs || activeOrder.roll_outputs.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="border border-slate-300 py-2 text-center text-slate-400 italic">
                          No produced rolls recorded yet.
                        </td>
                      </tr>
                    ) : (
                      activeOrder.roll_outputs.map((ro: any, idx: number) => (
                        <tr key={ro.id || idx}>
                          <td className="border border-slate-300 py-1 px-2 font-mono font-semibold">{ro.roll_no}</td>
                          <td className="border border-slate-300 py-1 px-2">{ro.lot_no}</td>
                          <td className="border border-slate-300 py-1 px-2 text-center">{ro.dia || '-'} / {ro.gsm || '-'} GSM</td>
                          <td className="border border-slate-300 py-1 px-2 text-right">{fmtDecimal(ro.meters)} m</td>
                          <td className="border border-slate-300 py-1 px-2 text-right font-semibold">{fmtDecimal(ro.weight_kg)} kg</td>
                          <td className="border border-slate-300 py-1 px-2 text-center font-semibold text-emerald-700">{ro.qc_status}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Signatures */}
              <div className="grid grid-cols-4 gap-4 pt-8 mt-6 border-t border-slate-300 text-center text-[10px]">
                <div>
                  <div className="border-b border-slate-400 h-8 mb-1"></div>
                  <span className="font-semibold text-slate-700">Prepared By</span>
                </div>
                <div>
                  <div className="border-b border-slate-400 h-8 mb-1"></div>
                  <span className="font-semibold text-slate-700">Knitting Master</span>
                </div>
                <div>
                  <div className="border-b border-slate-400 h-8 mb-1"></div>
                  <span className="font-semibold text-slate-700">QC Inspector</span>
                </div>
                <div>
                  <div className="border-b border-slate-400 h-8 mb-1"></div>
                  <span className="font-semibold text-slate-700">Authorized Signatory</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
