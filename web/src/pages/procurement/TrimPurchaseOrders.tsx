import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Eye, Filter, Scissors, PackageCheck } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { Badge } from '../../components/ui';

export default function TrimPurchaseOrdersPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const { data: pos = [], isLoading } = useQuery({
    queryKey: ['trim-purchase-orders'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/trim-pos');
      return res.data || [];
    },
  });

  const filtered = useMemo(() => {
    return pos.filter((p) => {
      const matchesSearch =
        !search ||
        p.po_no?.toLowerCase().includes(search.toLowerCase()) ||
        p.io_no?.toLowerCase().includes(search.toLowerCase()) ||
        p.supplier_name?.toLowerCase().includes(search.toLowerCase()) ||
        p.style_code?.toLowerCase().includes(search.toLowerCase()) ||
        p.style_name?.toLowerCase().includes(search.toLowerCase());

      const matchesStatus = statusFilter === 'ALL' || p.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [pos, search, statusFilter]);

  const kpis = useMemo(() => {
    const totalOrders = pos.length;
    const approvedOrders = pos.filter((p) => p.status === 'APPROVED' || p.status === 'PARTIAL').length;
    const totalVal = pos.reduce((s, p) => s + (Number(p.grand_total) || 0), 0);
    return { totalOrders, approvedOrders, totalVal };
  }, [pos]);

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-emerald-100 text-emerald-700">
              <Scissors size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Trim Purchase Orders</h1>
              <p className="text-xs text-slate-500">
                Manage accessories, buttons, zippers, labels, and thread procurement orders
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => nav('/procurement/trim/grn')}
            className="btn-secondary text-xs flex items-center gap-1.5"
          >
            <PackageCheck size={14} /> Trim GRN & Stock
          </button>
          <button
            type="button"
            onClick={() => nav('/procurement/trim/orders/new')}
            className="btn-primary text-xs flex items-center gap-1.5 shadow-sm"
          >
            <Plus size={14} /> New Trim PO
          </button>
        </div>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card p-4 flex items-center gap-4 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-3 rounded-xl bg-emerald-50 text-emerald-600">
            <Scissors size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Total Trim POs</p>
            <p className="text-xl font-bold text-slate-900">{kpis.totalOrders}</p>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-4 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-3 rounded-xl bg-blue-50 text-blue-600">
            <PackageCheck size={20} />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Active / Approved POs</p>
            <p className="text-xl font-bold text-slate-900">{kpis.approvedOrders}</p>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-4 bg-gradient-to-br from-white to-slate-50/50">
          <div className="p-3 rounded-xl bg-indigo-50 text-indigo-600">
            <span className="font-bold text-sm">₹</span>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-500">Total Purchase Value</p>
            <p className="text-xl font-bold text-slate-900">₹{fmtDecimal(kpis.totalVal)}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search by PO No, IO No, Style, Supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-9 text-xs"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter size={15} className="text-slate-400" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input text-xs w-40"
            >
              <option value="ALL">All Statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="APPROVED">Approved</option>
              <option value="PARTIAL">Partial</option>
              <option value="CLOSED">Closed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
        </div>
      </div>

      {/* PO Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table w-full text-xs">
            <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 uppercase font-semibold">
              <tr>
                <th className="py-3 px-4 text-left">PO No</th>
                <th className="py-3 px-4 text-left">Date</th>
                <th className="py-3 px-4 text-left">I/O No</th>
                <th className="py-3 px-4 text-left">Style</th>
                <th className="py-3 px-4 text-left">Supplier</th>
                <th className="py-3 px-4 text-right">Items</th>
                <th className="py-3 px-4 text-right">Order Qty</th>
                <th className="py-3 px-4 text-right">Received</th>
                <th className="py-3 px-4 text-right">Grand Total</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-slate-400">Loading trim purchase orders...</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-slate-400">No trim purchase orders found</td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/70 transition">
                    <td className="py-3 px-4 font-semibold text-emerald-700">{p.po_no}</td>
                    <td className="py-3 px-4 text-slate-500">{fmtDate(p.po_date)}</td>
                    <td className="py-3 px-4 font-semibold text-slate-900">{p.io_no}</td>
                    <td className="py-3 px-4">
                      {p.style_code ? (
                        <div>
                          <span className="font-semibold text-slate-900">{p.style_code}</span>
                          <span className="text-[10px] text-slate-400 block">{p.style_name}</span>
                        </div>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-800">{p.supplier_name}</td>
                    <td className="py-3 px-4 text-right">{p.total_items}</td>
                    <td className="py-3 px-4 text-right font-medium text-slate-900">{fmtDecimal(p.total_order_qty)}</td>
                    <td className="py-3 px-4 text-right font-medium text-indigo-600">{fmtDecimal(p.total_received_qty)}</td>
                    <td className="py-3 px-4 text-right font-bold text-slate-900">₹{fmtDecimal(p.grand_total)}</td>
                    <td className="py-3 px-4 text-center">
                      <Badge variant={p.status === 'CLOSED' ? 'success' : p.status === 'APPROVED' ? 'info' : p.status === 'PARTIAL' ? 'warning' : 'neutral'}>
                        {p.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => nav(`/procurement/trim/orders/${p.id}`)}
                        className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 mx-auto"
                      >
                        <Eye size={13} /> View
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
