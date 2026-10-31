import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Boxes, Search, Filter, RefreshCw, Edit3, PackageCheck, Layers, X, AlertCircle,
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, fmtNumber } from '../../lib/format';
import { Badge, Modal, Input, Button, useDebounced } from '../../components/ui';
import { useToast } from '../../hooks/useToast';

export default function FabricRollStockPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [qcFilter, setQcFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [ioFilter, setIoFilter] = useState('');
  const [styleFilter, setStyleFilter] = useState('');
  const debouncedSearch = useDebounced(search.trim());

  // Edit Roll Modal
  const [editRoll, setEditRoll] = useState<any | null>(null);
  const [editStatus, setEditStatus] = useState('AVAILABLE');
  const [editBin, setEditBin] = useState('');
  const [editQc, setEditQc] = useState('ACCEPTED');
  const [updating, setUpdating] = useState(false);

  // Filtering is done by the API so IO / style resolution (GRN line → PO →
  // sales order → GRN header) is applied consistently.
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (debouncedSearch) p.search = debouncedSearch;
    if (qcFilter) p.qc_status = qcFilter;
    if (statusFilter) p.stock_status = statusFilter;
    if (ioFilter) p.io_no = ioFilter;
    if (styleFilter) p.style_id = styleFilter;
    return p;
  }, [debouncedSearch, qcFilter, statusFilter, ioFilter, styleFilter]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['fabric-rolls', params],
    queryFn: async () =>
      http.get<{ data: any[]; facets?: { io_nos: string[]; styles: { id: number; style_code: string; style_name: string }[] } }>(
        '/fabric-rolls', params),
  });
  const rolls = data?.data ?? [];
  const filtered = rolls;
  const facets = data?.facets ?? { io_nos: [], styles: [] };
  const errorMessage = error instanceof Error ? error.message : error ? 'Unable to load fabric rolls' : null;
  const hasFilters = !!(search || qcFilter || statusFilter || ioFilter || styleFilter);
  const clearFilters = () => {
    setSearch(''); setQcFilter(''); setStatusFilter(''); setIoFilter(''); setStyleFilter('');
  };

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
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update roll status', 'error');
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-surface-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-sky-100 text-sky-700">
              <Boxes size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-ink tracking-tight">Fabric Roll Stock Ledger</h1>
              <p className="text-xs text-ink-secondary">
                Individual physical roll inventory, barcode tracking, location bins, and cutting floor allocations
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/fabric/orders')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-surface-input bg-white hover:bg-surface-muted text-ink shadow-sm transition"
          >
            <Layers size={14} className="text-emerald-600" />
            <span>Fabric Orders</span>
          </button>
          <button
            onClick={() => nav('/procurement/fabric/grn')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-surface-input bg-white hover:bg-surface-muted text-ink shadow-sm transition"
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
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Total Rolls in Store</div>
          <div className="text-2xl font-bold text-ink mt-1">{fmtNumber(kpis.totalRolls)}</div>
          <div className="text-caption text-ink-muted mt-0.5">Physical roll units</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Available Rolls</div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{fmtNumber(kpis.availableRolls)}</div>
          <div className="text-caption text-ink-muted mt-0.5">Ready for issue</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Reserved for Cutting</div>
          <div className="text-2xl font-bold text-amber-600 mt-1">{fmtNumber(kpis.reservedRolls)}</div>
          <div className="text-caption text-ink-muted mt-0.5">Allocated to jobs</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Total Stocked Meters</div>
          <div className="text-2xl font-bold text-sky-600 mt-1">{fmtDecimal(kpis.totalMeters)} m</div>
          <div className="text-caption text-ink-muted mt-0.5">Cumulative length</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Total Stocked Weight</div>
          <div className="text-2xl font-bold text-indigo-600 mt-1">{fmtDecimal(kpis.totalWeight)} kg</div>
          <div className="text-caption text-ink-muted mt-0.5">Physical gross weight</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-surface-border/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-ink-muted" />
          <input
            type="text"
            placeholder="Search Roll No, Lot, Fabric, Shade, GRN, IO No, Style..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-surface-input focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
          <Filter size={15} className="text-ink-muted" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
          >
            <option value="">All Stock Status</option>
            <option value="AVAILABLE">Available</option>
            <option value="RESERVED">Reserved</option>
            <option value="PARTIAL">Partly Issued</option>
            <option value="ISSUED">Issued</option>
            <option value="CLOSED">Closed</option>
          </select>

          <select
            value={qcFilter}
            onChange={(e) => setQcFilter(e.target.value)}
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
          >
            <option value="">All QC Status</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="PENDING">Pending</option>
            <option value="HOLD">Hold</option>
            <option value="REJECTED">Rejected</option>
          </select>

          <select
            value={ioFilter}
            onChange={(e) => setIoFilter(e.target.value)}
            title="Internal Order No"
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
          >
            <option value="">All IO No</option>
            {facets.io_nos.map((io) => <option key={io} value={io}>{io}</option>)}
          </select>

          <select
            value={styleFilter}
            onChange={(e) => setStyleFilter(e.target.value)}
            title="Style"
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-500"
          >
            <option value="">All Styles</option>
            {facets.styles.map((st) => (
              <option key={st.id} value={String(st.id)}>{st.style_code}{st.style_name ? ` — ${st.style_name}` : ''}</option>
            ))}
          </select>

          {hasFilters && (
            <button onClick={clearFilters} className="inline-flex items-center gap-1 text-xs text-ink-secondary hover:text-ink px-2 py-1">
              <X size={13} /> Clear
            </button>
          )}

          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-lg border border-surface-input hover:bg-surface-muted text-ink-secondary transition"
            title="Refresh list"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-surface-border/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-surface-muted/80 text-ink-secondary font-semibold border-b border-surface-border">
                <th className="py-3 px-4">Roll No</th>
                <th className="py-3 px-3">Fabric Item</th>
                <th className="py-3 px-3">Lot No</th>
                <th className="py-3 px-3">Shade</th>
                <th className="py-3 px-3 text-center">GSM / Dia</th>
                <th className="py-3 px-3 text-right">Length (Mtrs)</th>
                <th className="py-3 px-3 text-right">Weight (KG)</th>
                <th className="py-3 px-3">Warehouse / Bin</th>
                <th className="py-3 px-3">Internal Order / Style</th>
                <th className="py-3 px-3">Origin (GRN / PO)</th>
                <th className="py-3 px-3 text-center">QC Status</th>
                <th className="py-3 px-3 text-center">Stock Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-divider text-ink">
              {isLoading ? (
                <tr>
                  <td colSpan={13} className="py-10 text-center text-ink-muted">
                    Loading fabric roll stock...
                  </td>
                </tr>
              ) : errorMessage ? (
                <tr>
                  <td colSpan={13} className="py-12 text-center">
                    <AlertCircle size={32} className="mx-auto text-red-400 mb-2" />
                    <p className="text-sm font-medium text-ink">Unable to load fabric rolls</p>
                    <p className="text-xs text-red-600 mt-1">{errorMessage}</p>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={13} className="py-12 text-center text-ink-muted">
                    <Boxes size={36} className="mx-auto text-ink-disabled mb-2" />
                    <p className="text-sm font-medium text-ink-secondary">No fabric rolls found</p>
                    <p className="text-xs text-ink-muted mt-1">
                      {hasFilters ? 'No roll matches these filters.' : 'Rolls are created when fabric GRNs are inwarded'}
                    </p>
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-muted/70 transition">
                    <td className="py-3 px-4">
                      <div className="tabular-nums font-bold text-sky-700">{r.roll_no}</div>
                      <div className="text-micro text-ink-muted">ID #{r.id}</div>
                    </td>
                    <td className="py-3 px-3 font-semibold text-ink">
                      {r.fabric_name || 'Fabric Item'}
                      <div className="text-micro text-ink-muted font-normal">{r.fabric_code || ''}</div>
                    </td>
                    <td className="py-3 px-3 tabular-nums text-ink text-caption">{r.lot_no || '—'}</td>
                    <td className="py-3 px-3 font-medium text-ink">{r.shade || '—'}</td>
                    <td className="py-3 px-3 text-center text-ink-secondary text-caption">
                      {r.gsm} gsm / {r.dia || '30"'}
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-emerald-700">
                      {fmtDecimal(r.meters)} m
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-indigo-700">
                      {fmtDecimal(r.weight_kg)} kg
                      {Number(r.issued_kg) > 0 && (
                        <div className="text-micro text-ink-secondary font-normal">Bal {fmtDecimal(r.balance_kg)} kg</div>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <div className="text-ink font-medium">{r.warehouse_name || 'Main Fabric Store'}</div>
                      <span className="tabular-nums text-micro bg-surface-header px-1 py-0.5 rounded text-ink-secondary">
                        Bin: {r.location_bin || 'Unassigned'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-caption">
                      {r.internal_ir_no ? (
                        <button onClick={() => setIoFilter(r.internal_ir_no)} title="Filter by this IO"
                          className="tabular-nums font-semibold text-indigo-700 hover:underline">{r.internal_ir_no}</button>
                      ) : (
                        <span className="text-ink-disabled">No IO</span>
                      )}
                      {r.style_code && (
                        <div className="text-micro text-ink-secondary mt-0.5" title={r.style_name ?? ''}>{r.style_code}</div>
                      )}
                      {r.so_no && <div className="text-micro text-ink-muted">{r.so_no}</div>}
                    </td>
                    <td className="py-3 px-3 text-caption">
                      {r.grn_no && (
                        <div
                          onClick={() => nav(`/procurement/fabric/grn/${r.grn_id}`)}
                          className="text-emerald-700 hover:underline cursor-pointer font-medium"
                        >
                          {r.grn_no}
                        </div>
                      )}
                      {r.po_no && <div className="text-ink-muted text-micro">{r.po_no}</div>}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span
                        className={`text-micro px-1.5 py-0.5 rounded font-semibold ${
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
                        className="p-1 text-ink-secondary hover:text-sky-700 hover:bg-sky-50 rounded transition"
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
          title={`Edit roll ${editRoll.roll_no}`}
          subtitle="Update the stock status, QC status and rack / bin of this fabric roll"
          open={!!editRoll}
          onClose={() => setEditRoll(null)}
          size="sm"
          footer={<>
            <Button variant="secondary" onClick={() => setEditRoll(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit} loading={updating}>
              {updating ? 'Saving...' : 'Save Changes'}
            </Button>
          </>}
        >
          <div className="space-y-4 text-xs">
            <div className="p-3 bg-surface-muted rounded-lg text-ink grid grid-cols-2 gap-2 text-caption">
              <div>Fabric: <strong>{editRoll.fabric_name}</strong></div>
              <div>Lot No: <strong>{editRoll.lot_no}</strong></div>
              <div>Length: <strong>{editRoll.meters} m</strong></div>
              <div>Weight: <strong>{editRoll.weight_kg} kg</strong></div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-caption font-medium text-ink-secondary mb-1">
                  Stock Status
                </label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full text-xs rounded-lg border border-surface-input py-1.5 px-2 font-medium"
                >
                  <option value="AVAILABLE">AVAILABLE (In Store, Ready for Issue)</option>
                  <option value="RESERVED">RESERVED (Allocated to Cutting Order)</option>
                  <option value="PARTIAL">PARTIAL (Part of roll issued)</option>
                  <option value="ISSUED">ISSUED (Moved to Cutting Table)</option>
                  <option value="CLOSED">CLOSED (Consumed / Scrapped)</option>
                </select>
              </div>

              <div>
                <label className="block text-caption font-medium text-ink-secondary mb-1">
                  QC Status
                </label>
                <select
                  value={editQc}
                  onChange={(e) => setEditQc(e.target.value)}
                  className="w-full text-xs rounded-lg border border-surface-input py-1.5 px-2 font-medium"
                >
                  <option value="ACCEPTED">ACCEPTED</option>
                  <option value="PENDING">PENDING</option>
                  <option value="HOLD">HOLD</option>
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

          </div>
        </Modal>
      )}
    </div>
  );
}
