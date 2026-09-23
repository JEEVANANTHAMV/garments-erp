import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  GitBranch, Search, Filter, RefreshCw, Edit3, PackageCheck, Boxes,
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, fmtNumber } from '../../lib/format';
import { Badge, Modal, Input } from '../../components/ui';
import { useToast } from '../../hooks/useToast';

export default function YarnStockPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [qcFilter, setQcFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Edit Batch Modal
  const [editBatch, setEditBatch] = useState<any | null>(null);
  const [editBin, setEditBin] = useState('');
  const [updating, setUpdating] = useState(false);

  const { data: batches = [], isLoading, refetch } = useQuery({
    queryKey: ['yarn-stock', search, qcFilter, statusFilter],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/yarn-stock');
      return res.data || [];
    },
  });

  const filtered = useMemo(() => {
    return batches.filter((b) => {
      const matchesSearch =
        !search ||
        b.yarn_name?.toLowerCase().includes(search.toLowerCase()) ||
        b.yarn_code?.toLowerCase().includes(search.toLowerCase()) ||
        b.lot_no?.toLowerCase().includes(search.toLowerCase()) ||
        b.shade?.toLowerCase().includes(search.toLowerCase()) ||
        b.location_bin?.toLowerCase().includes(search.toLowerCase()) ||
        b.grn_no?.toLowerCase().includes(search.toLowerCase()) ||
        b.internal_ir_no?.toLowerCase().includes(search.toLowerCase()) ||
        b.style_code?.toLowerCase().includes(search.toLowerCase());

      const matchesQc = qcFilter === 'ALL' || b.qc_status === qcFilter;
      const matchesStatus = statusFilter === 'ALL' || b.stock_status === statusFilter;

      return matchesSearch && matchesQc && matchesStatus;
    });
  }, [batches, search, qcFilter, statusFilter]);

  const kpis = useMemo(() => {
    const totalBatches = batches.length;
    const availableBatches = batches.filter((b) => b.stock_status === 'AVAILABLE').length;
    const totalWeight = batches.reduce((s, b) => s + (Number(b.weight_kg) || 0), 0);
    const totalAccepted = batches.reduce((s, b) => s + (Number(b.accepted_qty) || 0), 0);
    return { totalBatches, availableBatches, totalWeight, totalAccepted };
  }, [batches]);

  const handleOpenEdit = (batch: any) => {
    setEditBatch(batch);
    setEditBin(batch.location_bin || '');
  };

  const handleSaveEdit = async () => {
    if (!editBatch) return;
    setUpdating(true);
    try {
      // Yarn batches update bin via general GRN line update — simple PATCH
      await http.post(`/yarn-stock/${editBatch.id}/bin`, { location_bin: editBin });
      toast(`Yarn batch ${editBatch.lot_no || '#' + editBatch.id} updated`, 'success');
      setEditBatch(null);
      refetch();
    } catch {
      toast('Failed to update bin location', 'error');
    } finally {
      setUpdating(false);
    }
  };

  const getQcBadge = (st: string) => {
    switch (st) {
      case 'ACCEPTED':        return <Badge tone="green">ACCEPTED</Badge>;
      case 'PARTIAL_ACCEPTED':return <Badge tone="amber">PART-ACCEPTED</Badge>;
      case 'HOLD':            return <Badge tone="amber">HOLD</Badge>;
      case 'REJECTED':        return <Badge tone="red">REJECTED</Badge>;
      default:                return <Badge tone="slate">{st || 'PENDING'}</Badge>;
    }
  };

  const getStockBadge = (st: string) => {
    switch (st) {
      case 'AVAILABLE': return <Badge tone="green">AVAILABLE</Badge>;
      case 'CLOSED':    return <Badge tone="slate">CLOSED</Badge>;
      case 'REJECTED':  return <Badge tone="red">REJECTED</Badge>;
      case 'PENDING':   return <Badge tone="amber">PENDING QC</Badge>;
      default:          return <Badge tone="slate">{st}</Badge>;
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-violet-100 text-violet-700">
              <GitBranch size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Yarn Stock Ledger</h1>
              <p className="text-xs text-slate-500">
                Batch-level yarn inventory — lot tracking, job allocation, and warehouse bin status
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/yarn/orders')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <GitBranch size={14} className="text-violet-600" />
            <span>Yarn Orders</span>
          </button>
          <button
            onClick={() => nav('/procurement/yarn/grn')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <PackageCheck size={14} className="text-violet-600" />
            <span>Yarn GRNs</span>
          </button>
          <button
            onClick={() => nav('/procurement/yarn/grn/new')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-violet-600 hover:bg-violet-700 text-white shadow-sm transition"
          >
            <PackageCheck size={14} />
            <span>Inward Yarn</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Batches in Store</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{fmtNumber(kpis.totalBatches)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">GRN lot entries</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Available Batches</div>
          <div className="text-2xl font-bold text-violet-600 mt-1">{fmtNumber(kpis.availableBatches)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Ready for issue</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Accepted Qty</div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{fmtDecimal(kpis.totalAccepted)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Units (KG / Cones)</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Weight (KG)</div>
          <div className="text-2xl font-bold text-indigo-600 mt-1">{fmtDecimal(kpis.totalWeight)} kg</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Received weight</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search Yarn, Lot No, Shade, GRN, IO No, Style..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
          <Filter size={15} className="text-slate-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
          >
            <option value="ALL">All Stock Status</option>
            <option value="AVAILABLE">Available</option>
            <option value="CLOSED">Closed</option>
            <option value="REJECTED">Rejected</option>
            <option value="PENDING">Pending QC</option>
          </select>

          <select
            value={qcFilter}
            onChange={(e) => setQcFilter(e.target.value)}
            className="text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
          >
            <option value="ALL">All QC Status</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="PARTIAL_ACCEPTED">Partial Accepted</option>
            <option value="HOLD">Hold</option>
            <option value="REJECTED">Rejected</option>
            <option value="PENDING">Pending</option>
          </select>

          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-600 transition"
            title="Refresh list"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50/80 text-slate-600 font-semibold border-b border-slate-200">
                <th className="py-3 px-4">Yarn Item</th>
                <th className="py-3 px-3">Lot No / Shade</th>
                <th className="py-3 px-3">Count / Type</th>
                <th className="py-3 px-3">Internal Order / Style</th>
                <th className="py-3 px-3 text-right">Received Qty</th>
                <th className="py-3 px-3 text-right">Accepted Qty</th>
                <th className="py-3 px-3 text-right">Weight (KG)</th>
                <th className="py-3 px-3">Warehouse / Bin</th>
                <th className="py-3 px-3">Origin (GRN)</th>
                <th className="py-3 px-3 text-center">QC Status</th>
                <th className="py-3 px-3 text-center">Stock Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={12} className="py-10 text-center text-slate-400">
                    Loading yarn stock...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-slate-400">
                    <Boxes size={36} className="mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-medium text-slate-600">No yarn batches found</p>
                    <p className="text-xs text-slate-400 mt-1">Yarn stock is created when Yarn GRNs are inwarded</p>
                  </td>
                </tr>
              ) : (
                filtered.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50/70 transition">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-violet-800">{b.yarn_name || 'Yarn Item'}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{b.yarn_code || ''}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-mono font-bold text-slate-800 text-[11px]">{b.lot_no || '—'}</div>
                      {b.shade && (
                        <div className="text-[10px] text-slate-500 mt-0.5">{b.shade}</div>
                      )}
                    </td>
                    <td className="py-3 px-3 text-[11px] text-slate-600">
                      <div className="font-medium">{b.count_str || '—'}</div>
                      <div className="text-[10px] text-slate-400">{b.yarn_type || ''}</div>
                    </td>
                    <td className="py-3 px-3 text-[11px]">
                      {b.internal_ir_no ? (
                        <div className="font-mono font-semibold text-indigo-700">{b.internal_ir_no}</div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                      {b.style_code && (
                        <div className="text-[10px] text-slate-500 mt-0.5">{b.style_code}</div>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-slate-700">
                      {fmtDecimal(b.received_qty)}
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-emerald-700">
                      {fmtDecimal(b.accepted_qty)}
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-indigo-700">
                      {b.weight_kg ? `${fmtDecimal(b.weight_kg)} kg` : '—'}
                    </td>
                    <td className="py-3 px-3">
                      <div className="text-slate-800 font-medium">{b.warehouse_name || 'Yarn Store'}</div>
                      <span className="font-mono text-[10px] bg-slate-100 px-1 py-0.5 rounded text-slate-600">
                        Bin: {b.location_bin || 'Unassigned'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-[11px]">
                      {b.grn_no && (
                        <div
                          onClick={() => nav(`/procurement/yarn/grn/${b.grn_id}`)}
                          className="text-violet-700 hover:underline cursor-pointer font-medium"
                        >
                          {b.grn_no}
                        </div>
                      )}
                      {b.po_no && <div className="text-slate-400 text-[10px]">{b.po_no}</div>}
                    </td>
                    <td className="py-3 px-3 text-center">{getQcBadge(b.qc_status)}</td>
                    <td className="py-3 px-3 text-center">{getStockBadge(b.stock_status)}</td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => handleOpenEdit(b)}
                        className="p-1 text-slate-500 hover:text-violet-700 hover:bg-violet-50 rounded transition"
                        title="Update Bin Location"
                      >
                        <Edit3 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Batch Modal */}
      {editBatch && (
        <Modal
          title={`Update Yarn Batch: ${editBatch.lot_no || '#' + editBatch.id}`}
          open={!!editBatch}
          onClose={() => setEditBatch(null)}
        >
          <div className="space-y-4 text-xs">
            <div className="p-3 bg-slate-50 rounded-lg text-slate-700 grid grid-cols-2 gap-2 text-[11px]">
              <div>Yarn: <strong>{editBatch.yarn_name}</strong></div>
              <div>Lot No: <strong>{editBatch.lot_no || '—'}</strong></div>
              <div>Count: <strong>{editBatch.count_str || '—'}</strong></div>
              <div>Accepted: <strong>{editBatch.accepted_qty}</strong></div>
              {editBatch.internal_ir_no && (
                <div className="col-span-2">
                  Internal Order: <strong className="text-indigo-700">{editBatch.internal_ir_no}</strong>
                  {editBatch.style_code && <span className="ml-2 text-slate-500">({editBatch.style_code})</span>}
                </div>
              )}
            </div>

            <Input
              label="Rack / Location Bin"
              value={editBin}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditBin(e.target.value)}
              placeholder="e.g. YARN-RACK-A1-02"
            />

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => setEditBatch(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={updating}
                className="px-3.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-medium disabled:opacity-50"
              >
                {updating ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
