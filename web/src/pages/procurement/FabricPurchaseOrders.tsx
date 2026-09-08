import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Eye, Filter, Layers, PackageCheck } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { StatusBadge, Badge } from '../../components/ui';

export default function FabricPurchaseOrdersPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const { data: pos = [], isLoading } = useQuery({
    queryKey: ['fabric-purchase-orders'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/purchase-orders?po_type=MATERIAL');
      // Filter fabric orders
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
            <span className="p-2 rounded-lg bg-sky-100 text-sky-700">
              <Layers size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Fabric Purchase Orders</h1>
              <p className="text-xs text-slate-500">
                Manage knitted and woven fabric procurement, roll specifications, and quotations
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => nav('/procurement/fabric/grn/new')}
            className="btn-secondary text-xs flex items-center gap-1.5"
          >
            <PackageCheck size={14} /> Goods Receipt (GRN)
          </button>
          <button
            type="button"
            onClick={() => nav('/procurement/fabric/orders/new')}
            className="btn-primary text-xs flex items-center gap-1.5"
          >
            <Plus size={14} /> New Fabric PO
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-4 rounded-xl border border-slate-200 bg-white shadow-xs">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Fabric POs</p>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-2xl font-black text-slate-900">{kpis.totalOrders}</span>
            <Badge tone="sky">Active</Badge>
          </div>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 bg-white shadow-xs">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Approved Orders</p>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-2xl font-black text-emerald-600">{kpis.approvedOrders}</span>
            <span className="text-xs text-slate-500">Ready for GRN</span>
          </div>
        </div>
        <div className="p-4 rounded-xl border border-slate-200 bg-white shadow-xs">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total PO Value</p>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-2xl font-black text-slate-900">₹{fmtDecimal(kpis.totalVal, 2)}</span>
            <span className="text-xs font-mono text-slate-400">INR</span>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200 shadow-xs">
        <div className="relative w-full sm:w-80">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search PO no, IR no, Supplier, Style..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9 text-xs w-full py-1.5"
          />
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <Filter size={14} className="text-slate-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="input text-xs py-1.5"
          >
            <option value="ALL">All States</option>
            <option value="DRAFT">Draft</option>
            <option value="APPROVED">Approved</option>
            <option value="CLOSED">Closed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Orders Table */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">PO Number</th>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Internal / IR No</th>
                <th className="py-3 px-4">Style</th>
                <th className="py-3 px-4">Supplier</th>
                <th className="py-3 px-4">Order Type</th>
                <th className="py-3 px-4 text-right">Value (₹)</th>
                <th className="py-3 px-4 text-center">State</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    Loading fabric purchase orders...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center">
                    <Layers size={32} className="mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-semibold text-slate-700">No Fabric Purchase Orders Found</p>
                    <p className="text-xs text-slate-400 mt-1">Create a new Fabric PO or convert from an approved quotation.</p>
                  </td>
                </tr>
              ) : (
                filtered.map((r: any) => (
                  <tr
                    key={r.id}
                    onClick={() => nav(`/procurement/fabric/orders/${r.id}`)}
                    className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4 font-mono font-bold text-brand-700">
                      {r.po_no}
                    </td>
                    <td className="py-3 px-4 text-slate-600">
                      {fmtDate(r.po_date)}
                    </td>
                    <td className="py-3 px-4 font-mono font-medium text-slate-800">
                      {r.internal_ir_no || '—'}
                    </td>
                    <td className="py-3 px-4">
                      <span className="font-semibold text-slate-900">{r.style_code || '—'}</span>
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-800">
                      {r.supplier_name || '—'}
                    </td>
                    <td className="py-3 px-4">
                      <Badge tone="sky">{r.order_type || 'Production'}</Badge>
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-bold text-slate-900">
                      ₹{fmtDecimal(r.grand_total, 2)}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <StatusBadge value={r.approval_state || 'DRAFT'} />
                    </td>
                    <td className="py-3 px-4 text-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => nav(`/procurement/fabric/orders/${r.id}`)}
                        className="btn-ghost btn-xs text-brand-700"
                        title="View Details"
                      >
                        <Eye size={14} />
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
