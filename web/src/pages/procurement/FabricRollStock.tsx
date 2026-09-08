import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Boxes, Search, Filter, RefreshCw, Edit3, PackageCheck, Layers
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, fmtNumber } from '../../lib/format';
import { Badge, Modal, Input } from '../../components/ui';
import { useToast } from '../../hooks/useToast';

export default function FabricRollStockPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [qcFilter, setQcFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');

  // Edit Roll Modal
  const [editRoll, setEditRoll] = useState<any | null>(null);
  const [editStatus, setEditStatus] = useState('AVAILABLE');
  const [editBin, setEditBin] = useState('');
  const [editQc, setEditQc] = useState('ACCEPTED');
  const [updating, setUpdating] = useState(false);

  const { data: rolls = [], isLoading, refetch } = useQuery({
    queryKey: ['fabric-rolls', search, qcFilter, statusFilter],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/fabric-rolls');
      return res.data || [];
    },
  });

  const filtered = useMemo(() => {
    return rolls.filter((r) => {
      const matchesSearch =
        !search ||
        r.roll_no?.toLowerCase().includes(search.toLowerCase()) ||
        r.lot_no?.toLowerCase().includes(search.toLowerCase()) ||
        r.fabric_name?.toLowerCase().includes(search.toLowerCase()) ||
        r.shade?.toLowerCase().includes(search.toLowerCase()) ||
        r.location_bin?.toLowerCase().includes(search.toLowerCase()) ||
        r.grn_no?.toLowerCase().includes(search.toLowerCase());

      const matchesQc = qcFilter === 'ALL' || r.qc_status === qcFilter;
      const matchesStatus = statusFilter === 'ALL' || r.stock_status === statusFilter;

      return matchesSearch && matchesQc && matchesStatus;
    });
  }, [rolls, search, qcFilter, statusFilter]);

  const kpis = useMemo(() => {
    const totalRolls = rolls.length;
    const availableRolls = rolls.filter((r) => r.stock_status === 'AVAILABLE').length;
    const reservedRolls = rolls.filter((r) => r.stock_status === 'RESERVED').length;
    const totalMeters = rolls.reduce((s, r) => s + (Number(r.meters) || 0), 0);
    const totalWeight = rolls.reduce((s, r) => s + (Number(r.weight_kg) || 0), 0);
    return { totalRolls, availableRolls, reservedRolls, totalMeters, totalWeight };
  }, [rolls]);

  const handleOpenEdit = (roll: any) => {
    setEditRoll(roll);
    setEditStatus(roll.stock_status || 'AVAILABLE');
    setEditBin(roll.location_bin || '');
    setEditQc(roll.qc_status || 'ACCEPTED');
  };

  const handleSaveEdit = async () => {
    if (!editRoll) return;
    setUpdating(true);
    try {
      await http.post(`/fabric-rolls/${editRoll.id}/status`, {
        stock_status: editStatus,
        location_bin: editBin,
        qc_status: editQc,
      });
      toast(`Roll ${editRoll.roll_no} updated`, 'success');
      setEditRoll(null);
      refetch();
    } catch {
      toast('Failed to update roll status', 'error');
    } finally {
      setUpdating(false);
    }
  };

  const getStockStatusBadge = (st: string) => {
    switch (st) {
      case 'AVAILABLE':
        return <Badge tone="green">AVAILABLE</Badge>;
      case 'RESERVED':
        return <Badge tone="amber">RESERVED</Badge>;
      case 'ISSUED':
        return <Badge tone="blue">ISSUED</Badge>;
      case 'CLOSED':
        return <Badge tone="slate">CLOSED</Badge>;
      default:
        return <Badge tone="slate">{st}</Badge>;
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-sky-100 text-sky-700">
              <Boxes size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Fabric Roll Stock Ledger</h1>
              <p className="text-xs text-slate-500">
                Individual physical roll inventory, barcode tracking, location bins, and cutting floor allocations
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/fabric/orders')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <Layers size={14} className="text-emerald-600" />
            <span>Fabric Orders</span>
          </button>
          <button
            onClick={() => nav('/procurement/fabric/grn')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <PackageCheck size={14} className="text-emerald-600" />
            <span>Fabric GRNs</span>
          </button>
          <button
            onClick={() => nav('/procurement/fabric/grn/new')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition"
          >
            <PackageCheck size={14} />
            <span>Inward New Rolls</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Rolls in Store</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{fmtNumber(kpis.totalRolls)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Physical roll units</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Available Rolls</div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{fmtNumber(kpis.availableRolls)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Ready for issue</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Reserved for Cutting</div>
          <div className="text-2xl font-bold text-amber-600 mt-1">{fmtNumber(kpis.reservedRolls)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Allocated to jobs</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Stocked Meters</div>
          <div className="text-2xl font-bold text-sky-600 mt-1">{fmtDecimal(kpis.totalMeters)} m</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Cumulative length</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Stocked Weight</div>
          <div className="text-2xl font-bold text-indigo-600 mt-1">{fmtDecimal(kpis.totalWeight)} kg</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Physical gross weight</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search Roll No, Lot, Fabric, Shade, Bin..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
          <Filter size={15} className="text-slate-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
          >
            <option value="ALL">All Stock Status</option>
            <option value="AVAILABLE">Available</option>
            <option value="RESERVED">Reserved</option>
            <option value="ISSUED">Issued</option>
            <option value="CLOSED">Closed</option>
          </select>

          <select
            value={qcFilter}
            onChange={(e) => setQcFilter(e.target.value)}
            className="text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
          >
            <option value="ALL">All QC Status</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="CONDITIONAL">Conditional</option>
            <option value="REJECTED">Rejected</option>
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
                <th className="py-3 px-4">Roll No</th>
                <th className="py-3 px-3">Fabric Item</th>
                <th className="py-3 px-3">Lot No</th>
                <th className="py-3 px-3">Shade</th>
                <th className="py-3 px-3 text-center">GSM / Dia</th>
                <th className="py-3 px-3 text-right">Length (Mtrs)</th>
                <th className="py-3 px-3 text-right">Weight (KG)</th>
                <th className="py-3 px-3">Warehouse / Bin</th>
                <th className="py-3 px-3">Origin (GRN / PO)</th>
                <th className="py-3 px-3 text-center">QC Status</th>
                <th className="py-3 px-3 text-center">Stock Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={12} className="py-10 text-center text-slate-400">
                    Loading fabric roll stock...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-12 text-center text-slate-400">
                    <Boxes size={36} className="mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-medium text-slate-600">No fabric rolls found</p>
                    <p className="text-xs text-slate-400 mt-1">Rolls are created when fabric GRNs are inwarded</p>
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50/70 transition">
                    <td className="py-3 px-4">
                      <div className="font-mono font-bold text-sky-700">{r.roll_no}</div>
                      <div className="text-[10px] text-slate-400">ID #{r.id}</div>
                    </td>
                    <td className="py-3 px-3 font-semibold text-slate-900">
                      {r.fabric_name || 'Fabric Item'}
                      <div className="text-[10px] text-slate-400 font-normal">{r.fabric_code || ''}</div>
                    </td>
                    <td className="py-3 px-3 font-mono text-slate-700 text-[11px]">{r.lot_no || '—'}</td>
                    <td className="py-3 px-3 font-medium text-slate-800">{r.shade || '—'}</td>
                    <td className="py-3 px-3 text-center text-slate-600 text-[11px]">
                      {r.gsm} gsm / {r.dia || '30"'}
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-emerald-700">
                      {fmtDecimal(r.meters)} m
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-indigo-700">
                      {fmtDecimal(r.weight_kg)} kg
                    </td>
                    <td className="py-3 px-3">
                      <div className="text-slate-800 font-medium">{r.warehouse_name || 'Main Fabric Store'}</div>
                      <span className="font-mono text-[10px] bg-slate-100 px-1 py-0.5 rounded text-slate-600">
                        Bin: {r.location_bin || 'Unassigned'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-[11px]">
                      {r.grn_no && (
                        <div
                          onClick={() => nav(`/procurement/fabric/grn/${r.grn_id}`)}
                          className="text-emerald-700 hover:underline cursor-pointer font-medium"
                        >
                          {r.grn_no}
                        </div>
                      )}
                      {r.po_no && <div className="text-slate-400 text-[10px]">{r.po_no}</div>}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          r.qc_status === 'ACCEPTED'
                            ? 'bg-emerald-100 text-emerald-800'
                            : r.qc_status === 'REJECTED'
                            ? 'bg-red-100 text-red-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {r.qc_status}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-center">{getStockStatusBadge(r.stock_status)}</td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => handleOpenEdit(r)}
                        className="p-1 text-slate-500 hover:text-sky-700 hover:bg-sky-50 rounded transition"
                        title="Update Roll Status & Location"
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

      {/* Edit Roll Modal */}
      {editRoll && (
        <Modal
          title={`Update Roll: ${editRoll.roll_no}`}
          open={!!editRoll}
          onClose={() => setEditRoll(null)}
        >
          <div className="space-y-4 text-xs">
            <div className="p-3 bg-slate-50 rounded-lg text-slate-700 grid grid-cols-2 gap-2 text-[11px]">
              <div>Fabric: <strong>{editRoll.fabric_name}</strong></div>
              <div>Lot No: <strong>{editRoll.lot_no}</strong></div>
              <div>Length: <strong>{editRoll.meters} m</strong></div>
              <div>Weight: <strong>{editRoll.weight_kg} kg</strong></div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Stock Status
                </label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full text-xs rounded-lg border border-slate-300 py-1.5 px-2 font-medium"
                >
                  <option value="AVAILABLE">AVAILABLE (In Store, Ready for Issue)</option>
                  <option value="RESERVED">RESERVED (Allocated to Cutting Order)</option>
                  <option value="ISSUED">ISSUED (Moved to Cutting Table)</option>
                  <option value="CLOSED">CLOSED (Consumed / Scrapped)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  QC Status
                </label>
                <select
                  value={editQc}
                  onChange={(e) => setEditQc(e.target.value)}
                  className="w-full text-xs rounded-lg border border-slate-300 py-1.5 px-2 font-medium"
                >
                  <option value="ACCEPTED">ACCEPTED</option>
                  <option value="CONDITIONAL">CONDITIONAL</option>
                  <option value="REJECTED">REJECTED</option>
                </select>
              </div>

              <Input
                label="Rack / Location Bin"
                value={editBin}
                onChange={(e) => setEditBin(e.target.value)}
                placeholder="e.g. FAB-RACK-02-B"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => setEditRoll(null)}
                className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={updating}
                className="px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-medium disabled:opacity-50"
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
