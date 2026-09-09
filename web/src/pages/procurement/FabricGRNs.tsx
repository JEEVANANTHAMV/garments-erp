import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Eye, Filter, PackageCheck, Layers, Boxes, RefreshCw } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber } from '../../lib/format';
import { Badge } from '../../components/ui';

export default function FabricGRNsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [qcFilter, setQcFilter] = useState('ALL');

  const { data: grns = [], isLoading, refetch } = useQuery({
    queryKey: ['fabric-grns'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/fabric-grns');
      return res.data || [];
    },
  });

  const filtered = useMemo(() => {
    return grns.filter((g) => {
      const matchesSearch =
        !search ||
        g.grn_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.po_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.gate_entry_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.internal_ir_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.supplier_name?.toLowerCase().includes(search.toLowerCase()) ||
        g.style_code?.toLowerCase().includes(search.toLowerCase());

      const matchesQc = qcFilter === 'ALL' || g.qc_status === qcFilter;

      return matchesSearch && matchesQc;
    });
  }, [grns, search, qcFilter]);

  const kpis = useMemo(() => {
    const totalGrns = grns.length;
    const totalMeters = grns.reduce((s, g) => s + (Number(g.total_meters) || 0), 0);
    const totalWeight = grns.reduce((s, g) => s + (Number(g.total_weight_kg) || 0), 0);
    const totalRolls = grns.reduce((s, g) => s + (Number(g.roll_count) || 0), 0);
    return { totalGrns, totalMeters, totalWeight, totalRolls };
  }, [grns]);

  const getQcBadgeTone = (st?: string) => {
    switch (st) {
      case 'ACCEPTED':
        return 'green';
      case 'CONDITIONAL':
        return 'amber';
      case 'REJECTED':
        return 'red';
      default:
        return 'blue';
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-emerald-100 text-emerald-700">
              <PackageCheck size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Fabric Goods Receipt Notes (GRN)</h1>
              <p className="text-xs text-slate-500">
                Roll-level physical inspection, QC verification, yardage/weight tracking, and stock ledger posting
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/fabric/roll-stock')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <Boxes size={14} className="text-sky-600" />
            <span>Roll Stock Inventory</span>
          </button>
          <button
            onClick={() => nav('/procurement/fabric/orders')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <Layers size={14} className="text-emerald-600" />
            <span>Fabric Orders</span>
          </button>
          <button
            onClick={() => nav('/procurement/fabric/grn/new')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition"
          >
            <Plus size={15} />
            <span>New Fabric GRN</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total GRNs</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{fmtNumber(kpis.totalGrns)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Receipt batches recorded</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Meters Received</div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{fmtDecimal(kpis.totalMeters)} m</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Fabric yardage inspected</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Weight (KG)</div>
          <div className="text-2xl font-bold text-indigo-600 mt-1">{fmtDecimal(kpis.totalWeight)} kg</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Actual gross weight</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Physical Rolls Logged</div>
          <div className="text-2xl font-bold text-sky-600 mt-1">{fmtNumber(kpis.totalRolls)} rolls</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Barcode / roll tags created</div>
        </div>
      </div>

      {/* Search & Filter bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by GRN#, PO#, Gate Entry#, Supplier..."
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Filter size={13} />
            <span>QC Status:</span>
          </div>
          <select
            value={qcFilter}
            onChange={(e) => setQcFilter(e.target.value)}
            className="text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-white"
          >
            <option value="ALL">All Statuses</option>
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
                <th className="py-3 px-4">GRN No & Date</th>
                <th className="py-3 px-3">PO & IR No</th>
                <th className="py-3 px-3">Gate Entry</th>
                <th className="py-3 px-3">Supplier / Mill</th>
                <th className="py-3 px-3">Style</th>
                <th className="py-3 px-3">Warehouse</th>
                <th className="py-3 px-3 text-right">Meters</th>
                <th className="py-3 px-3 text-right">Weight (KG)</th>
                <th className="py-3 px-3 text-center">Rolls</th>
                <th className="py-3 px-3 text-center">QC Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-slate-400">
                    Loading fabric GRNs...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-slate-400">
                    <PackageCheck size={36} className="mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-medium text-slate-600">No fabric GRN records found</p>
                    <p className="text-xs text-slate-400 mt-1">Receive fabric rolls from approved Fabric POs</p>
                  </td>
                </tr>
              ) : (
                filtered.map((g) => (
                  <tr
                    key={g.id}
                    onClick={() => nav(`/procurement/fabric/grn/${g.id}`)}
                    className="hover:bg-slate-50/70 transition cursor-pointer"
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-emerald-700">{g.grn_no}</div>
                      <div className="text-[11px] text-slate-400">{fmtDate(g.grn_date)}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-800">{g.po_no || '—'}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{g.internal_ir_no || '—'}</div>
                    </td>
                    <td className="py-3 px-3">
                      {g.gate_entry_no ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                          {g.gate_entry_no}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-800 truncate max-w-[150px]">
                        {g.supplier_name || 'General Mill'}
                      </div>
                      {g.supplier_dc_no && (
                        <div className="text-[10px] text-slate-400">DC: {g.supplier_dc_no}</div>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <span className="font-mono text-[11px] text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded">
                        {g.style_code || 'GEN'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-slate-600 text-[11px]">
                      {g.warehouse_name || 'Main Fabric Store'}
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-emerald-700">
                      {fmtDecimal(g.total_meters)} m
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-slate-800">
                      {fmtDecimal(g.total_weight_kg)} kg
                    </td>
                    <td className="py-3 px-3 text-center font-semibold text-sky-700">
                      {fmtNumber(g.roll_count)}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <Badge tone={getQcBadgeTone(g.qc_status)}>{g.qc_status || 'ACCEPTED'}</Badge>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          nav(`/procurement/fabric/grn/${g.id}`);
                        }}
                        className="p-1 text-slate-400 hover:text-emerald-700 hover:bg-emerald-50 rounded transition"
                        title="View details & rolls"
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
