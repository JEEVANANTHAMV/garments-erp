import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Eye, PackageCheck, Boxes } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal } from '../../lib/format';
import { Badge } from '../../components/ui';

export default function TrimGRNsPage() {
  const nav = useNavigate();
  const [activeTab, setActiveTab] = useState<'grns' | 'stock'>('grns');
  const [search, setSearch] = useState('');

  // GRN List
  const { data: grns = [], isLoading } = useQuery({
    queryKey: ['trim-grns'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/trim-grns');
      return res.data || [];
    },
  });

  // Trim Real-Time Stock
  const { data: trimStock = [], isLoading: isStockLoading } = useQuery({
    queryKey: ['trim-stock'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/trim-stock');
      return res.data || [];
    },
    enabled: activeTab === 'stock',
  });

  const filteredGrns = useMemo(() => {
    return grns.filter((g) => {
      return (
        !search ||
        g.grn_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.io_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.supplier_name?.toLowerCase().includes(search.toLowerCase()) ||
        g.po_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.supplier_inv_no?.toLowerCase().includes(search.toLowerCase())
      );
    });
  }, [grns, search]);

  const filteredStock = useMemo(() => {
    return trimStock.filter((s) => {
      return (
        !search ||
        s.trim_name?.toLowerCase().includes(search.toLowerCase()) ||
        s.trim_code?.toLowerCase().includes(search.toLowerCase()) ||
        s.internal_lot_no?.toLowerCase().includes(search.toLowerCase()) ||
        s.color_name?.toLowerCase().includes(search.toLowerCase())
      );
    });
  }, [trimStock, search]);

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-indigo-100 text-indigo-700">
              <PackageCheck size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Trim Goods Receipt (GRN) & Stock</h1>
              <p className="text-xs text-slate-500">
                Inward receiving, accepted vs rejected QC split, internal lot tracking, and unrestricted inventory
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => nav('/procurement/trim/orders')}
            className="btn-secondary text-xs"
          >
            Trim Purchase Orders
          </button>
          <button
            type="button"
            onClick={() => nav('/procurement/trim/grn/new')}
            className="btn-primary text-xs flex items-center gap-1.5 shadow-sm"
          >
            <Plus size={14} /> New Trim GRN
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 gap-4 text-xs font-semibold">
        <button
          onClick={() => setActiveTab('grns')}
          className={`pb-2.5 flex items-center gap-1.5 border-b-2 transition ${
            activeTab === 'grns'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <PackageCheck size={15} /> Goods Receipt Notes ({grns.length})
        </button>
        <button
          onClick={() => setActiveTab('stock')}
          className={`pb-2.5 flex items-center gap-1.5 border-b-2 transition ${
            activeTab === 'stock'
              ? 'border-emerald-600 text-emerald-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Boxes size={15} /> Current Unrestricted Trim Stock
        </button>
      </div>

      {/* Search Bar */}
      <div className="card p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            type="text"
            placeholder={
              activeTab === 'grns'
                ? 'Search by GRN No, IO No, Supplier, PO No, Invoice...'
                : 'Search stock by Trim Item, Code, Internal Lot, Color...'
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-9 text-xs"
          />
        </div>
      </div>

      {activeTab === 'grns' ? (
        /* GRN TABLE */
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 uppercase font-semibold">
                <tr>
                  <th className="py-3 px-4 text-left">GRN No</th>
                  <th className="py-3 px-4 text-left">Date</th>
                  <th className="py-3 px-4 text-left">PO No</th>
                  <th className="py-3 px-4 text-left">I/O No</th>
                  <th className="py-3 px-4 text-left">Supplier</th>
                  <th className="py-3 px-4 text-left">Warehouse</th>
                  <th className="py-3 px-4 text-right">Received Qty</th>
                  <th className="py-3 px-4 text-right">Accepted Qty</th>
                  <th className="py-3 px-4 text-right">Rejected</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {isLoading ? (
                  <tr>
                    <td colSpan={11} className="py-8 text-center text-slate-400">Loading trim GRNs...</td>
                  </tr>
                ) : filteredGrns.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-8 text-center text-slate-400">No trim goods receipts found</td>
                  </tr>
                ) : (
                  filteredGrns.map((g) => (
                    <tr key={g.id} className="hover:bg-slate-50/70 transition">
                      <td className="py-3 px-4 font-semibold text-indigo-700">{g.grn_no}</td>
                      <td className="py-3 px-4 text-slate-500">{fmtDate(g.grn_date)}</td>
                      <td className="py-3 px-4 font-medium text-slate-800">{g.po_no || '-'}</td>
                      <td className="py-3 px-4 font-semibold text-slate-900">{g.io_no}</td>
                      <td className="py-3 px-4">{g.supplier_name}</td>
                      <td className="py-3 px-4 text-slate-600">{g.warehouse_name || 'Main Trims Store'}</td>
                      <td className="py-3 px-4 text-right font-medium">{fmtDecimal(g.total_received_qty)}</td>
                      <td className="py-3 px-4 text-right font-bold text-emerald-700">{fmtDecimal(g.total_accepted_qty)}</td>
                      <td className="py-3 px-4 text-right font-medium text-red-600">{fmtDecimal(g.total_rejected_qty)}</td>
                      <td className="py-3 px-4 text-center">
                        <Badge variant={g.status === 'POSTED' ? 'success' : 'neutral'}>{g.status}</Badge>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <button
                          onClick={() => nav(`/procurement/trim/grn/${g.id}`)}
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
      ) : (
        /* REAL-TIME TRIM STOCK TABLE */
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="table w-full text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200 uppercase font-semibold">
                <tr>
                  <th className="py-3 px-4 text-left">Trim Item</th>
                  <th className="py-3 px-4 text-left">Category / Type</th>
                  <th className="py-3 px-4 text-left">Internal Lot No</th>
                  <th className="py-3 px-4 text-left">Color / Size</th>
                  <th className="py-3 px-4 text-left">Warehouse</th>
                  <th className="py-3 px-4 text-left">Bin</th>
                  <th className="py-3 px-4 text-right">In Stock</th>
                  <th className="py-3 px-4 text-right">Available Qty</th>
                  <th className="py-3 px-4 text-left">UOM</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {isStockLoading ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-400">Loading trim stock...</td>
                  </tr>
                ) : filteredStock.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-400">No active trim stock found</td>
                  </tr>
                ) : (
                  filteredStock.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50/70 transition">
                      <td className="py-3 px-4 font-semibold text-slate-900">{s.trim_name}</td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-100 font-medium text-slate-700">
                          {s.trim_type || s.trim_code}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-indigo-700">{s.internal_lot_no}</td>
                      <td className="py-3 px-4 text-slate-600">{s.color_name || '-'} / {s.trim_size || '-'}</td>
                      <td className="py-3 px-4">{s.warehouse_name}</td>
                      <td className="py-3 px-4 font-mono text-slate-500">{s.bin_location || '-'}</td>
                      <td className="py-3 px-4 text-right font-bold text-slate-900">{fmtDecimal(s.stock_qty)}</td>
                      <td className="py-3 px-4 text-right font-bold text-emerald-700">{fmtDecimal(s.available_qty)}</td>
                      <td className="py-3 px-4 font-medium text-slate-500">{s.uom_code || 'PCS'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
