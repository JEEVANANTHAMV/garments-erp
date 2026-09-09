import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Plus, Search, Eye, Trash2,
  AlertTriangle, X, Layers, Box, FileText, Check, Printer
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Badge } from '../../components/ui';

export default function FabricProcessingPage() {
  const qc = useQueryClient();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [subProcessFilter, setSubProcessFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPrintVoucher, setShowPrintVoucher] = useState(false);
  const [activeFpoId, setActiveFpoId] = useState<number | null>(null);

  // Lookups
  const { data: styles = [] } = useQuery({
    queryKey: ['lookups', 'styles'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/styles')).data || [],
  });

  const { data: fabrics = [] } = useQuery({
    queryKey: ['lookups', 'fabrics'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/fabrics')).data || [],
  });

  const { data: parties = [] } = useQuery({
    queryKey: ['lookups', 'parties'],
    queryFn: async () => (await http.get<{ data: any[] }>('/lookups/parties')).data || [],
  });

  // Available grey rolls from knitting
  const { data: availableGreyRolls = [] } = useQuery({
    queryKey: ['available-grey-rolls'],
    queryFn: async () => (await http.get<{ data: any[] }>('/knitting/available-grey-rolls')).data || [],
  });

  // Orders list
  const { data: orders = [], isLoading, refetch } = useQuery({
    queryKey: ['fabric-process-orders'],
    queryFn: async () => (await http.get<{ data: any[] }>('/fabric-processing/orders')).data || [],
  });

  // Single Order Details
  const { data: activeOrder, refetch: refetchActive } = useQuery({
    queryKey: ['fabric-process-order', activeFpoId],
    queryFn: async () => {
      if (!activeFpoId) return null;
      return (await http.get<{ data: any }>(`/fabric-processing/orders/${activeFpoId}`)).data;
    },
    enabled: !!activeFpoId,
  });

  // Create Form State
  const [newOrder, setNewOrder] = useState({
    fpo_no: '',
    fpo_date: today(),
    io_no: 'IO-2026-001',
    customer_po_no: '',
    style_id: '',
    fabric_id: '',
    sub_process: 'DYEING',
    vendor_id: '',
    shade_code: 'NVY-01',
    color_name: 'Navy Blue',
    target_dia: '30"',
    target_gsm: '180',
    status: 'DISPATCHED',
    remarks: '',
    selected_rolls: [] as any[],
  });

  // Output Roll Form State
  const [outputRoll, setOutputRoll] = useState({
    roll_no: '',
    lot_no: '',
    finish_date: today(),
    dia: '30"',
    gsm: '180',
    meters: 95,
    weight_kg: 24,
    shrinkage_length_pct: 3.5,
    shrinkage_width_pct: 2.0,
    qc_status: 'ACCEPTED',
    shade_match: 'PASS',
    defect_points: 0,
    remarks: '',
  });

  // Auto-fill output defaults when active order loads
  useEffect(() => {
    if (activeOrder) {
      const nextRollIdx = (activeOrder.output_rolls?.length || 0) + 1;
      setOutputRoll(prev => ({
        ...prev,
        roll_no: `${activeOrder.fpo_no}-P${String(nextRollIdx).padStart(2, '0')}`,
        lot_no: `LOT-${activeOrder.shade_code || activeOrder.io_no}`,
        dia: activeOrder.target_dia || '30"',
        gsm: activeOrder.target_gsm || '180',
      }));
    }
  }, [activeOrder]);

  // Filtering
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const matchSearch =
        !search ||
        o.fpo_no?.toLowerCase().includes(search.toLowerCase()) ||
        o.io_no?.toLowerCase().includes(search.toLowerCase()) ||
        o.color_name?.toLowerCase().includes(search.toLowerCase()) ||
        o.shade_code?.toLowerCase().includes(search.toLowerCase()) ||
        o.style_name?.toLowerCase().includes(search.toLowerCase());

      const matchSub = subProcessFilter === 'ALL' || o.sub_process === subProcessFilter;
      const matchStatus = statusFilter === 'ALL' || o.status === statusFilter;

      return matchSearch && matchSub && matchStatus;
    });
  }, [orders, search, subProcessFilter, statusFilter]);

  // KPI Calculations
  const kpis = useMemo(() => {
    const totalOrders = orders.length;
    const totalInput = orders.reduce((s, o) => s + (Number(o.input_weight_kg) || 0), 0);
    const totalOutput = orders.reduce((s, o) => s + (Number(o.output_weight_kg) || 0), 0);
    const lossKg = Math.max(0, totalInput - totalOutput);
    const lossPct = totalInput > 0 ? (lossKg / totalInput) * 100 : 0;
    return { totalOrders, totalInput, totalOutput, lossPct };
  }, [orders]);

  // Create Process Order
  const createMutation = useMutation({
    mutationFn: async (payload: any) => http.post('/fabric-processing/orders', payload),
    onSuccess: () => {
      toast('Fabric Process Order created successfully');
      setShowCreateModal(false);
      qc.invalidateQueries({ queryKey: ['fabric-process-orders'] });
      qc.invalidateQueries({ queryKey: ['available-grey-rolls'] });
    },
    onError: (err: any) => toast(err?.response?.data?.error?.message || 'Failed to create process order', 'error'),
  });

  // Add Output Roll
  const rollMutation = useMutation({
    mutationFn: async (payload: any) => http.post('/fabric-processing/rolls', payload),
    onSuccess: () => {
      toast('Processed roll recorded');
      refetchActive();
      qc.invalidateQueries({ queryKey: ['fabric-process-orders'] });
    },
    onError: (err: any) => toast(err?.response?.data?.error?.message || 'Failed to record output roll', 'error'),
  });

  // Delete Output Roll
  const deleteRollMutation = useMutation({
    mutationFn: async (id: number) => http.del(`/fabric-processing/rolls/${id}`),
    onSuccess: () => {
      toast('Processed roll removed');
      refetchActive();
      qc.invalidateQueries({ queryKey: ['fabric-process-orders'] });
    },
    onError: (err: any) => toast(err?.response?.data?.error?.message || 'Failed to remove roll', 'error'),
  });

  const toggleGreyRollSelection = (roll: any) => {
    setNewOrder(prev => {
      const exists = prev.selected_rolls.some(r => r.knitting_roll_id === roll.id);
      if (exists) {
        return {
          ...prev,
          selected_rolls: prev.selected_rolls.filter(r => r.knitting_roll_id !== roll.id),
        };
      } else {
        return {
          ...prev,
          selected_rolls: [
            ...prev.selected_rolls,
            {
              knitting_roll_id: roll.id,
              roll_no: roll.roll_no,
              lot_no: roll.lot_no,
              weight_kg: Number(roll.weight_kg),
              meters: Number(roll.meters),
            }
          ]
        };
      }
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-xl bg-purple-100 text-purple-700 shadow-sm">
              <RefreshCw size={22} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Fabric Processing</h1>
              <p className="text-xs text-slate-500">
                Dyeing, compacting, heat setting, washing, printing, stentering & slitting output management
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
            <Plus size={15} /> New Process Work Order
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card p-4 flex items-center gap-3.5 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-2.5 rounded-xl bg-purple-50 text-purple-600">
            <FileText size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Active Process Orders</p>
            <p className="text-xl font-bold text-slate-900">{kpis.totalOrders}</p>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-3.5 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-2.5 rounded-xl bg-sky-50 text-sky-600">
            <Layers size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Input Grey Fabric</p>
            <p className="text-xl font-bold text-slate-900">{fmtDecimal(kpis.totalInput)} <span className="text-xs font-normal text-slate-500">kg</span></p>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-3.5 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-600">
            <Box size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Finished Fabric Output</p>
            <p className="text-xl font-bold text-slate-900">{fmtDecimal(kpis.totalOutput)} <span className="text-xs font-normal text-slate-500">kg</span></p>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-3.5 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-2.5 rounded-xl bg-amber-50 text-amber-600">
            <AlertTriangle size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Avg Process Loss</p>
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
              placeholder="Search by FPO No, IO No, Shade, Color, Style..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-9 text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={subProcessFilter}
              onChange={(e) => setSubProcessFilter(e.target.value)}
              className="input text-xs w-48"
            >
              <option value="ALL">All Sub-processes</option>
              <option value="DYEING">Dyeing</option>
              <option value="COMPACTING">Compacting</option>
              <option value="HEAT_SETTING">Heat Setting</option>
              <option value="WASHING">Washing</option>
              <option value="PRINTING">Printing</option>
              <option value="RELAX_DRYER">Relax Dryer</option>
              <option value="TUMBLE_DRYER">Tumble Dryer</option>
              <option value="STENTERING">Stentering</option>
              <option value="COMMON_PROCESS">Common Process</option>
              <option value="BITTING_SLITTING">Bitting / Slitting</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input text-xs w-36"
            >
              <option value="ALL">All Status</option>
              <option value="DISPATCHED">Dispatched</option>
              <option value="IN_PROCESS">In Process</option>
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
                <th className="py-3 px-4 text-left">FPO No</th>
                <th className="py-3 px-4 text-left">Date</th>
                <th className="py-3 px-4 text-left">IO No</th>
                <th className="py-3 px-4 text-left">Style</th>
                <th className="py-3 px-4 text-left">Sub-Process</th>
                <th className="py-3 px-4 text-left">Color / Shade</th>
                <th className="py-3 px-4 text-right">Input Fabric</th>
                <th className="py-3 px-4 text-right">Output Fabric</th>
                <th className="py-3 px-4 text-right">Process Loss</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-slate-400">Loading fabric processing orders...</td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-slate-400">No fabric process orders found</td>
                </tr>
              ) : (
                filteredOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50/70 transition">
                    <td className="py-3 px-4 font-semibold text-purple-700">{o.fpo_no}</td>
                    <td className="py-3 px-4 text-slate-500">{fmtDate(o.fpo_date)}</td>
                    <td className="py-3 px-4 font-medium text-slate-900">
                      <div>{o.io_no}</div>
                      {o.customer_po_no && (
                        <div className="text-[10px] text-purple-600 font-normal">PO: {o.customer_po_no}</div>
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
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-100 text-purple-800">
                        {o.sub_process}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{o.color_name || '-'}</div>
                      <div className="text-[10px] text-slate-400">Shade: {o.shade_code || '-'}</div>
                    </td>
                    <td className="py-3 px-4 text-right font-medium text-sky-700">
                      {fmtDecimal(o.input_weight_kg)} kg
                      <span className="text-[10px] text-slate-400 block">({o.total_input_rolls || 0} rolls)</span>
                    </td>
                    <td className="py-3 px-4 text-right font-medium text-emerald-700">
                      {fmtDecimal(o.output_weight_kg)} kg
                    </td>
                    <td className="py-3 px-4 text-right font-medium text-amber-700">
                      {fmtDecimal(o.process_loss_kg)} kg ({fmtDecimal(o.process_loss_pct)}%)
                    </td>
                    <td className="py-3 px-4 text-center">
                      <Badge variant={o.status === 'COMPLETED' ? 'success' : o.status === 'IN_PROCESS' ? 'warning' : 'neutral'}>
                        {o.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => setActiveFpoId(o.id)}
                        className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 mx-auto"
                      >
                        <Eye size={12} /> Manage
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CREATE WORK ORDER MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden border border-slate-100 max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
              <div className="flex items-center gap-2">
                <span className="p-1.5 bg-purple-100 text-purple-700 rounded-lg">
                  <RefreshCw size={18} />
                </span>
                <h3 className="text-base font-bold text-slate-900">New Fabric Process Order</h3>
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
                  fabric_id: newOrder.fabric_id ? Number(newOrder.fabric_id) : null,
                  vendor_id: newOrder.vendor_id ? Number(newOrder.vendor_id) : null,
                  input_rolls: newOrder.selected_rolls,
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
                    placeholder="IO-2026-001"
                    className="input text-xs font-semibold"
                  />
                </div>
                <div>
                  <label className="label">Customer PO No</label>
                  <input
                    type="text"
                    value={newOrder.customer_po_no}
                    onChange={(e) => setNewOrder({ ...newOrder, customer_po_no: e.target.value })}
                    placeholder="PO-2026-A12"
                    className="input text-xs font-semibold"
                  />
                </div>
                <div>
                  <label className="label">Order Date *</label>
                  <input
                    type="date"
                    required
                    value={newOrder.fpo_date}
                    onChange={(e) => setNewOrder({ ...newOrder, fpo_date: e.target.value })}
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
                    <option value="DYEING">Dyeing</option>
                    <option value="COMPACTING">Compacting</option>
                    <option value="HEAT_SETTING">Heat Setting</option>
                    <option value="WASHING">Washing</option>
                    <option value="PRINTING">Printing</option>
                    <option value="RELAX_DRYER">Relax Dryer</option>
                    <option value="TUMBLE_DRYER">Tumble Dryer</option>
                    <option value="STENTERING">Stentering</option>
                    <option value="COMMON_PROCESS">Common Process</option>
                    <option value="BITTING_SLITTING">Bitting / Slitting</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  <label className="label">Target Fabric</label>
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
                  <label className="label">Dyeing / Processing Vendor</label>
                  <select
                    value={newOrder.vendor_id}
                    onChange={(e) => setNewOrder({ ...newOrder, vendor_id: e.target.value })}
                    className="input text-xs"
                  >
                    <option value="">-- In-House Mill or Select Vendor --</option>
                    {parties.map((p: any) => (
                      <option key={p.id} value={p.id}>{p.party_name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="label">Color Name</label>
                  <input
                    type="text"
                    value={newOrder.color_name}
                    onChange={(e) => setNewOrder({ ...newOrder, color_name: e.target.value })}
                    placeholder="Navy Blue"
                    className="input text-xs"
                  />
                </div>
                <div>
                  <label className="label">Shade Code</label>
                  <input
                    type="text"
                    value={newOrder.shade_code}
                    onChange={(e) => setNewOrder({ ...newOrder, shade_code: e.target.value })}
                    placeholder="NVY-01"
                    className="input text-xs"
                  />
                </div>
                <div>
                  <label className="label">Target Dia</label>
                  <input
                    type="text"
                    value={newOrder.target_dia}
                    onChange={(e) => setNewOrder({ ...newOrder, target_dia: e.target.value })}
                    placeholder="30&quot;"
                    className="input text-xs"
                  />
                </div>
                <div>
                  <label className="label">Target GSM</label>
                  <input
                    type="text"
                    value={newOrder.target_gsm}
                    onChange={(e) => setNewOrder({ ...newOrder, target_gsm: e.target.value })}
                    placeholder="180"
                    className="input text-xs"
                  />
                </div>
              </div>

              {/* Input Grey Rolls Dispatch Selector */}
              <div className="space-y-2 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between">
                  <label className="label mb-0 font-semibold text-purple-950 flex items-center gap-1.5">
                    <Box size={14} /> Dispatch Knitting Grey Rolls into Process
                  </label>
                  <span className="text-[11px] text-slate-500">
                    Selected: <strong className="text-purple-700">{newOrder.selected_rolls.length} rolls</strong> ({fmtDecimal(newOrder.selected_rolls.reduce((s, r) => s + r.weight_kg, 0))} kg)
                  </span>
                </div>

                <div className="max-h-44 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
                  {availableGreyRolls.length === 0 ? (
                    <div className="p-4 text-center text-slate-400">
                      No available grey rolls from knitting yet. (You can still create order without pre-allocating rolls).
                    </div>
                  ) : (
                    availableGreyRolls.map((roll: any) => {
                      const isSelected = newOrder.selected_rolls.some(r => r.knitting_roll_id === roll.id);
                      return (
                        <div
                          key={roll.id}
                          onClick={() => toggleGreyRollSelection(roll)}
                          className={`p-2.5 flex items-center justify-between cursor-pointer transition ${
                            isSelected ? 'bg-purple-50 text-purple-900 font-medium' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {}}
                              className="rounded text-purple-600 focus:ring-purple-500"
                            />
                            <div>
                              <span className="font-semibold">{roll.roll_no}</span>
                              <span className="text-slate-400 text-[10px] ml-2 font-mono">Lot: {roll.lot_no}</span>
                              <span className="text-slate-400 text-[10px] ml-2">IO: {roll.io_no}</span>
                            </div>
                          </div>
                          <div className="text-right font-bold text-slate-700">
                            {fmtDecimal(roll.weight_kg)} kg <span className="text-slate-400 font-normal">({fmtDecimal(roll.meters)} m)</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div>
                <label className="label">Remarks</label>
                <textarea
                  rows={2}
                  value={newOrder.remarks}
                  onChange={(e) => setNewOrder({ ...newOrder, remarks: e.target.value })}
                  className="input text-xs"
                  placeholder="Recipe details, shrinkage tolerance, finish specifications..."
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
                  <Check size={14} /> Create Process Order
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MANAGE OUTPUT & QC MODAL */}
      {activeOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden border border-slate-100 max-h-[92vh] flex flex-col">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-base text-slate-900">{activeOrder.fpo_no}</span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-800">
                    {activeOrder.sub_process}
                  </span>
                  <span className="font-semibold text-xs text-slate-600">
                    {activeOrder.color_name} ({activeOrder.shade_code})
                  </span>
                  <Badge variant={activeOrder.status === 'COMPLETED' ? 'success' : 'warning'}>
                    {activeOrder.status}
                  </Badge>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  I/O No: <span className="font-semibold text-slate-800">{activeOrder.io_no}</span>
                  {activeOrder.customer_po_no && (
                    <> | Customer PO: <span className="font-semibold text-purple-700">{activeOrder.customer_po_no}</span></>
                  )}
                  {' '}| Style: <span className="font-medium text-slate-800">{activeOrder.style_code || '-'}</span> | Target: <span className="font-medium text-slate-800">{activeOrder.target_dia || '-'}, {activeOrder.target_gsm || '-'} GSM</span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowPrintVoucher(true)}
                  className="btn-secondary text-xs flex items-center gap-1.5 py-1 px-3 border border-slate-300 hover:bg-slate-100 shadow-sm"
                >
                  <Printer size={14} /> Print Voucher
                </button>
                <button onClick={() => setActiveFpoId(null)} className="text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Production Summary Cards */}
            <div className="px-6 py-3 bg-slate-100/50 border-b border-slate-100 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="p-2.5 bg-white rounded-xl border border-slate-200/60">
                <span className="text-slate-400 block text-[10px]">Input Grey Fabric</span>
                <span className="text-sm font-bold text-sky-700">
                  {fmtDecimal(activeOrder.summary?.total_input_weight_kg)} kg
                </span>
                <span className="text-[10px] text-slate-400 ml-1">({activeOrder.summary?.total_input_rolls} rolls)</span>
              </div>
              <div className="p-2.5 bg-white rounded-xl border border-slate-200/60">
                <span className="text-slate-400 block text-[10px]">Finished Output Fabric</span>
                <span className="text-sm font-bold text-emerald-700">
                  {fmtDecimal(activeOrder.summary?.total_output_weight_kg)} kg
                </span>
                <span className="text-[10px] text-slate-400 ml-1">({activeOrder.summary?.total_output_rolls} rolls)</span>
              </div>
              <div className="p-2.5 bg-white rounded-xl border border-slate-200/60">
                <span className="text-slate-400 block text-[10px]">Process Loss (Kg)</span>
                <span className="text-sm font-bold text-amber-700">
                  {fmtDecimal(activeOrder.summary?.process_loss_kg)} kg
                </span>
              </div>
              <div className="p-2.5 bg-white rounded-xl border border-slate-200/60">
                <span className="text-slate-400 block text-[10px]">Process Loss (%)</span>
                <span className="text-sm font-bold text-slate-800">
                  {fmtDecimal(activeOrder.summary?.process_loss_pct)}%
                </span>
              </div>
            </div>

            <div className="p-6 overflow-y-auto flex-1 space-y-6 text-xs">
              {/* Output Roll Entry Form */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  rollMutation.mutate({
                    ...outputRoll,
                    fpo_id: activeOrder.id,
                    meters: Number(outputRoll.meters),
                    weight_kg: Number(outputRoll.weight_kg),
                    shrinkage_length_pct: Number(outputRoll.shrinkage_length_pct),
                    shrinkage_width_pct: Number(outputRoll.shrinkage_width_pct),
                    defect_points: Number(outputRoll.defect_points),
                  });
                }}
                className="p-4 bg-purple-50/40 rounded-xl border border-purple-100 space-y-3"
              >
                <h4 className="font-semibold text-purple-950 flex items-center gap-1.5">
                  <Plus size={14} /> Record Processed Output Roll & QC
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div>
                    <label className="label">Roll No *</label>
                    <input
                      type="text"
                      required
                      value={outputRoll.roll_no}
                      onChange={(e) => setOutputRoll({ ...outputRoll, roll_no: e.target.value })}
                      className="input text-xs font-semibold text-purple-800"
                    />
                  </div>
                  <div>
                    <label className="label">Processed Lot No *</label>
                    <input
                      type="text"
                      required
                      value={outputRoll.lot_no}
                      onChange={(e) => setOutputRoll({ ...outputRoll, lot_no: e.target.value })}
                      className="input text-xs"
                    />
                  </div>
                  <div>
                    <label className="label">Finish Date *</label>
                    <input
                      type="date"
                      required
                      value={outputRoll.finish_date}
                      onChange={(e) => setOutputRoll({ ...outputRoll, finish_date: e.target.value })}
                      className="input text-xs"
                    />
                  </div>
                  <div>
                    <label className="label">QC Disposition *</label>
                    <select
                      value={outputRoll.qc_status}
                      onChange={(e) => setOutputRoll({ ...outputRoll, qc_status: e.target.value })}
                      className="input text-xs font-semibold"
                    >
                      <option value="ACCEPTED">ACCEPTED (Pass to Cutting)</option>
                      <option value="HOLD">HOLD (Quarantine)</option>
                      <option value="REJECTED">REJECTED</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
                  <div>
                    <label className="label">Dia (Inches)</label>
                    <input
                      type="text"
                      value={outputRoll.dia}
                      onChange={(e) => setOutputRoll({ ...outputRoll, dia: e.target.value })}
                      className="input text-xs"
                    />
                  </div>
                  <div>
                    <label className="label">GSM</label>
                    <input
                      type="text"
                      value={outputRoll.gsm}
                      onChange={(e) => setOutputRoll({ ...outputRoll, gsm: e.target.value })}
                      className="input text-xs"
                    />
                  </div>
                  <div>
                    <label className="label">Meters</label>
                    <input
                      type="number"
                      step="0.01"
                      value={outputRoll.meters}
                      onChange={(e) => setOutputRoll({ ...outputRoll, meters: Number(e.target.value) })}
                      className="input text-xs"
                    />
                  </div>
                  <div>
                    <label className="label">Weight (Kg) *</label>
                    <input
                      type="number"
                      step="0.01"
                      required
                      value={outputRoll.weight_kg}
                      onChange={(e) => setOutputRoll({ ...outputRoll, weight_kg: Number(e.target.value) })}
                      className="input text-xs font-bold text-purple-700"
                    />
                  </div>
                  <div>
                    <label className="label">Shrinkage L/W %</label>
                    <div className="flex gap-1">
                      <input
                        type="number"
                        step="0.1"
                        placeholder="L"
                        value={outputRoll.shrinkage_length_pct}
                        onChange={(e) => setOutputRoll({ ...outputRoll, shrinkage_length_pct: Number(e.target.value) })}
                        className="input text-xs w-1/2 p-1 text-center"
                      />
                      <input
                        type="number"
                        step="0.1"
                        placeholder="W"
                        value={outputRoll.shrinkage_width_pct}
                        onChange={(e) => setOutputRoll({ ...outputRoll, shrinkage_width_pct: Number(e.target.value) })}
                        className="input text-xs w-1/2 p-1 text-center"
                      />
                    </div>
                  </div>
                  <div>
                    <button
                      type="submit"
                      disabled={rollMutation.isPending}
                      className="btn-primary text-xs w-full py-2 flex items-center justify-center gap-1.5"
                    >
                      <Plus size={14} /> Add Roll
                    </button>
                  </div>
                </div>
              </form>

              {/* Output Rolls List Table */}
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
                      <th className="py-2.5 px-3 text-center">Shrinkage</th>
                      <th className="py-2.5 px-3 text-center">QC Status</th>
                      <th className="py-2.5 px-3 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activeOrder.output_rolls?.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-6 text-center text-slate-400">No output rolls recorded yet</td>
                      </tr>
                    ) : (
                      activeOrder.output_rolls?.map((ro: any) => (
                        <tr key={ro.id} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-semibold text-purple-700">{ro.roll_no}</td>
                          <td className="py-2 px-3 font-mono text-slate-600">{ro.lot_no}</td>
                          <td className="py-2 px-3 text-slate-500">{fmtDate(ro.finish_date)}</td>
                          <td className="py-2 px-3 text-slate-600">{ro.dia || '-'} / {ro.gsm || '-'} GSM</td>
                          <td className="py-2 px-3 text-right font-medium">{fmtDecimal(ro.meters)} m</td>
                          <td className="py-2 px-3 text-right font-bold text-purple-700">{fmtDecimal(ro.weight_kg)} kg</td>
                          <td className="py-2 px-3 text-center text-slate-500 font-mono">
                            {ro.shrinkage_length_pct}% / {ro.shrinkage_width_pct}%
                          </td>
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
          </div>
        </div>
      )}

      {/* PRINTABLE WORK ORDER VOUCHER MODAL */}
      {showPrintVoucher && activeOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden border border-slate-200 my-auto flex flex-col max-h-[96vh]">
            <div className="px-6 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50 no-print">
              <span className="font-bold text-sm text-slate-800 flex items-center gap-2">
                <Printer size={16} className="text-purple-600" /> Print Work Order Voucher
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
                <p className="text-xs text-slate-500 font-medium">Textile Processing Division — Work Order & Route Card</p>
                <div className="inline-block mt-2 px-4 py-1 rounded bg-purple-100 text-purple-900 font-bold text-sm tracking-wide">
                  {activeOrder.sub_process} WORK ORDER
                </div>
              </div>

              {/* Order Meta Grid */}
              <div className="grid grid-cols-2 gap-4 border border-slate-300 rounded-lg p-3.5 mb-4 bg-slate-50/50">
                <div className="space-y-1.5">
                  <div><span className="text-slate-500 font-medium">FPO Order No:</span> <span className="font-bold text-slate-900 font-mono text-sm">{activeOrder.fpo_no}</span></div>
                  <div><span className="text-slate-500 font-medium">Order Date:</span> <span className="font-semibold text-slate-800">{fmtDate(activeOrder.fpo_date)}</span></div>
                  <div><span className="text-slate-500 font-medium">Sub-Process:</span> <span className="font-bold text-purple-700">{activeOrder.sub_process}</span></div>
                  <div><span className="text-slate-500 font-medium">Processing Vendor/Mill:</span> <span className="font-semibold text-slate-800">{activeOrder.vendor_name || 'In-House Mill'}</span></div>
                </div>
                <div className="space-y-1.5 border-l border-slate-200 pl-4">
                  <div><span className="text-slate-500 font-medium">Internal Order (I/O No):</span> <span className="font-bold text-sky-800 font-mono">{activeOrder.io_no}</span></div>
                  <div><span className="text-slate-500 font-medium">Customer PO No:</span> <span className="font-bold text-purple-800 font-mono">{activeOrder.customer_po_no || 'N/A'}</span></div>
                  <div><span className="text-slate-500 font-medium">Style:</span> <span className="font-semibold text-slate-800">{activeOrder.style_code ? `${activeOrder.style_code} - ${activeOrder.style_name || ''}` : '-'}</span></div>
                  <div><span className="text-slate-500 font-medium">Fabric:</span> <span className="font-semibold text-slate-800">{activeOrder.fabric_name || '-'}</span></div>
                </div>
              </div>

              {/* Technical Specifications */}
              <div className="border border-slate-300 rounded-lg p-3.5 mb-4">
                <h4 className="font-bold text-xs uppercase tracking-wider text-slate-700 mb-2 border-b border-slate-200 pb-1">
                  Technical Specifications
                </h4>
                <div className="grid grid-cols-4 gap-3 text-center">
                  <div className="p-2 bg-slate-50 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Target GSM</span>
                    <span className="text-sm font-bold text-purple-700">{activeOrder.target_gsm || '-'} GSM</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Target Dia / Width</span>
                    <span className="text-sm font-bold text-slate-800">{activeOrder.target_dia || '-'}</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Color Name</span>
                    <span className="text-sm font-bold text-slate-800">{activeOrder.color_name || '-'}</span>
                  </div>
                  <div className="p-2 bg-slate-50 rounded border border-slate-200">
                    <span className="text-[10px] text-slate-500 block uppercase font-medium">Shade Code</span>
                    <span className="text-sm font-bold text-slate-800">{activeOrder.shade_code || '-'}</span>
                  </div>
                </div>
              </div>

              {/* Mass Balance Reconciliation */}
              <div className="grid grid-cols-3 gap-3 mb-4 text-center">
                <div className="p-2.5 border border-sky-200 bg-sky-50 rounded-lg">
                  <span className="text-[10px] uppercase font-bold text-sky-700 block">Total Input Fabric</span>
                  <span className="text-base font-black text-sky-900">{fmtDecimal(activeOrder.summary?.total_input_weight_kg)} kg</span>
                  <span className="text-[10px] text-sky-600 block">({activeOrder.summary?.total_input_rolls} input rolls)</span>
                </div>
                <div className="p-2.5 border border-emerald-200 bg-emerald-50 rounded-lg">
                  <span className="text-[10px] uppercase font-bold text-emerald-700 block">Total Output Fabric</span>
                  <span className="text-base font-black text-emerald-900">{fmtDecimal(activeOrder.summary?.total_output_weight_kg)} kg</span>
                  <span className="text-[10px] text-emerald-600 block">({activeOrder.summary?.total_output_rolls} finished rolls)</span>
                </div>
                <div className="p-2.5 border border-amber-200 bg-amber-50 rounded-lg">
                  <span className="text-[10px] uppercase font-bold text-amber-700 block">Process Loss</span>
                  <span className="text-base font-black text-amber-900">{fmtDecimal(activeOrder.summary?.process_loss_kg)} kg</span>
                  <span className="text-[10px] text-amber-600 block">({fmtDecimal(activeOrder.summary?.process_loss_pct)}% loss)</span>
                </div>
              </div>

              {/* Output Processed Rolls Table */}
              <div className="mb-6">
                <h4 className="font-bold text-xs uppercase tracking-wider text-slate-700 mb-2">
                  Output Rolls & Inspection Gate
                </h4>
                <table className="w-full border-collapse border border-slate-300 text-[11px]">
                  <thead>
                    <tr className="bg-slate-100 text-slate-700">
                      <th className="border border-slate-300 py-1.5 px-2 text-left">Roll No</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-left">Lot No</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-center">Dia / GSM</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Meters</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-right">Weight (kg)</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-center">Shrinkage %</th>
                      <th className="border border-slate-300 py-1.5 px-2 text-center">QC Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!activeOrder.output_rolls || activeOrder.output_rolls.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="border border-slate-300 py-3 text-center text-slate-400 italic">
                          No processed output rolls recorded yet.
                        </td>
                      </tr>
                    ) : (
                      activeOrder.output_rolls.map((ro: any, idx: number) => (
                        <tr key={ro.id || idx}>
                          <td className="border border-slate-300 py-1 px-2 font-mono font-semibold">{ro.roll_no}</td>
                          <td className="border border-slate-300 py-1 px-2">{ro.lot_no}</td>
                          <td className="border border-slate-300 py-1 px-2 text-center">{ro.dia || '-'} / {ro.gsm || '-'} GSM</td>
                          <td className="border border-slate-300 py-1 px-2 text-right">{fmtDecimal(ro.meters)} m</td>
                          <td className="border border-slate-300 py-1 px-2 text-right font-semibold">{fmtDecimal(ro.weight_kg)} kg</td>
                          <td className="border border-slate-300 py-1 px-2 text-center font-mono">{ro.shrinkage_length_pct}% / {ro.shrinkage_width_pct}%</td>
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
                  <span className="font-semibold text-slate-700">Processing Master</span>
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
