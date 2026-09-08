import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Eye, Filter, Disc, PackageCheck } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber } from '../../lib/format';
import { StatusBadge } from '../../components/ui';

export default function YarnPurchaseOrdersPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const { data: pos = [], isLoading } = useQuery({
    queryKey: ['yarn-purchase-orders'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/purchase-orders?po_type=MATERIAL');
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-amber-100 text-amber-700">
              <Disc size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Yarn Purchase Orders</h1>
              <p className="text-xs text-slate-500">
                Procure Grey and Dyed yarn, Direct KG & Bag/Pack purchase, spinning mills, and quotations
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/yarn/grn')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
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
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Yarn Orders</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{fmtNumber(kpis.totalOrders)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Grey & Dyed contracts</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Approved & Active</div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{fmtNumber(kpis.approvedOrders)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Ready for spinning & receipt</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Purchase Value</div>
          <div className="text-2xl font-bold text-amber-700 mt-1">₹{fmtDecimal(kpis.totalVal)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Cumulative commitment</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search PO No, Mill, IR No, Style..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter size={15} className="text-slate-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
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
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50/80 text-slate-600 font-semibold border-b border-slate-200">
                <th className="py-3 px-4">PO Number & Date</th>
                <th className="py-3 px-3">Internal / IR No</th>
                <th className="py-3 px-3">Spinning Mill / Supplier</th>
                <th className="py-3 px-3">Style Code</th>
                <th className="py-3 px-3">Delivery Date</th>
                <th className="py-3 px-3 text-right">Grand Total (₹)</th>
                <th className="py-3 px-3 text-center">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-400">
                    Loading yarn purchase orders...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    <Disc size={36} className="mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-medium text-slate-600">No yarn purchase orders found</p>
                    <p className="text-xs text-slate-400 mt-1">Create a new Yarn PO or convert from an approved quotation</p>
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => nav(`/procurement/yarn/orders/${p.id}`)}
                    className="hover:bg-slate-50/70 transition cursor-pointer"
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-amber-700">{p.po_no}</div>
                      <div className="text-[11px] text-slate-400">{fmtDate(p.po_date)}</div>
                    </td>
                    <td className="py-3 px-3 font-mono text-[11px] text-slate-700">
                      {p.internal_ir_no || '—'}
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-800">{p.supplier_name || 'Spinning Mill'}</div>
                    </td>
                    <td className="py-3 px-3">
                      <span className="font-mono text-[11px] text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">
                        {p.style_code || 'GEN'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-slate-600">{fmtDate(p.delivery_date) || '—'}</td>
                    <td className="py-3 px-3 text-right font-medium text-slate-900">
                      ₹{fmtDecimal(p.grand_total)}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <StatusBadge value={p.approval_state || 'APPROVED'} />
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          nav(`/procurement/yarn/orders/${p.id}`);
                        }}
                        className="p-1 text-slate-400 hover:text-amber-700 hover:bg-amber-50 rounded transition"
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
