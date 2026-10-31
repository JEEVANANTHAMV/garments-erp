import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Eye, Filter, Disc, PackageCheck } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber } from '../../lib/format';
import { StatusBadge } from '../../components/ui';
import { ReceiptStatusBadge } from '../../lib/poReceipt';

export default function YarnPurchaseOrdersPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const { data: pos = [], isLoading } = useQuery({
    queryKey: ['yarn-purchase-orders'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/purchase-orders?po_type=MATERIAL&material_type=YARN');
      return res.data || [];
    },
  });

  const filtered = useMemo(() => {
    return pos.filter((p) => {
      const matchesSearch =
        !search ||
        p.po_no?.toLowerCase().includes(search.toLowerCase()) ||
        p.internal_ir_no?.toLowerCase().includes(search.toLowerCase()) ||
        p.supplier_name?.toLowerCase().includes(search.toLowerCase()) ||
        p.style_code?.toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        statusFilter === 'ALL' || p.approval_state === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [pos, search, statusFilter]);

  const kpis = useMemo(() => {
    const totalOrders = pos.length;
    const approvedOrders = pos.filter((p) => p.approval_state === 'APPROVED').length;
    const totalVal = pos.reduce((s, p) => s + (Number(p.grand_total) || 0), 0);
    return { totalOrders, approvedOrders, totalVal };
  }, [pos]);

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-surface-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-amber-100 text-amber-700">
              <Disc size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-ink tracking-tight">Yarn Purchase Orders</h1>
              <p className="text-xs text-ink-secondary">
                Procure Grey and Dyed yarn, Direct KG & Bag/Pack purchase, spinning mills, and quotations
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/yarn/grn')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-surface-input bg-white hover:bg-surface-muted text-ink shadow-sm transition"
          >
            <PackageCheck size={14} className="text-amber-600" />
            <span>Yarn Inward GRNs</span>
          </button>
          <button
            onClick={() => nav('/procurement/yarn/orders/new')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white shadow-sm transition"
          >
            <Plus size={15} />
            <span>New Yarn PO</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Total Yarn Orders</div>
          <div className="text-2xl font-bold text-ink mt-1">{fmtNumber(kpis.totalOrders)}</div>
          <div className="text-caption text-ink-muted mt-0.5">Grey & Dyed contracts</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Approved & Active</div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{fmtNumber(kpis.approvedOrders)}</div>
          <div className="text-caption text-ink-muted mt-0.5">Ready for spinning & receipt</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Total Purchase Value</div>
          <div className="text-2xl font-bold text-amber-700 mt-1">₹{fmtDecimal(kpis.totalVal)}</div>
          <div className="text-caption text-ink-muted mt-0.5">Cumulative commitment</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-surface-border/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-ink-muted" />
          <input
            type="text"
            placeholder="Search PO No, Mill, IO No, Style..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-surface-input focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter size={15} className="text-ink-muted" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          >
            <option value="ALL">All Statuses</option>
            <option value="APPROVED">Approved</option>
            <option value="DRAFT">Draft</option>
            <option value="PENDING">Pending</option>
            <option value="CLOSED">Closed</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-surface-border/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-surface-muted/80 text-ink-secondary font-semibold border-b border-surface-border">
                <th className="py-3 px-4">PO Number & Date</th>
                <th className="py-3 px-3">IO No (Internal Order)</th>
                <th className="py-3 px-3">Spinning Mill / Supplier</th>
                <th className="py-3 px-3">Style Code</th>
                <th className="py-3 px-3">Delivery Date</th>
                <th className="py-3 px-3 text-right">Grand Total (₹)</th>
                <th className="py-3 px-3 text-center">Receipt</th>
                <th className="py-3 px-3 text-center">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-divider text-ink">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-ink-muted">
                    Loading yarn purchase orders...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-ink-muted">
                    <Disc size={36} className="mx-auto text-ink-disabled mb-2" />
                    <p className="text-sm font-medium text-ink-secondary">No yarn purchase orders found</p>
                    <p className="text-xs text-ink-muted mt-1">Create a new Yarn PO or convert from an approved quotation</p>
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => nav(`/procurement/yarn/orders/${p.id}`)}
                    className="hover:bg-surface-muted/70 transition cursor-pointer"
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-amber-700">{p.po_no}</div>
                      <div className="text-caption text-ink-muted">{fmtDate(p.po_date)}</div>
                    </td>
                    <td className="py-3 px-3 tabular-nums text-caption text-ink">
                      {p.internal_ir_no || '—'}
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-ink">{p.supplier_name || 'Spinning Mill'}</div>
                    </td>
                    <td className="py-3 px-3">
                      <span className="tabular-nums text-caption text-ink bg-surface-header px-1.5 py-0.5 rounded">
                        {p.style_code || 'GEN'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-ink-secondary">{fmtDate(p.delivery_date) || '—'}</td>
                    <td className="py-3 px-3 text-right font-medium text-ink">
                      ₹{fmtDecimal(p.grand_total)}
                    </td>
                    <td className="py-3 px-3 text-center"><ReceiptStatusBadge value={p.receipt_status} /></td>
                    <td className="py-3 px-3 text-center">
                      <StatusBadge value={p.approval_state || 'APPROVED'} />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          nav(`/procurement/yarn/orders/${p.id}`);
                        }}
                        className="p-1 text-ink-muted hover:text-amber-700 hover:bg-amber-50 rounded transition"
                        title="View PO"
                      >
                        <Eye size={15} />
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
  );
}
