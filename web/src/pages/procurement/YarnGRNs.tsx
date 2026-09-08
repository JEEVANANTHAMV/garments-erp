import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Eye, Filter, Disc, PackageCheck, RefreshCw } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber } from '../../lib/format';
import { Badge } from '../../components/ui';

export default function YarnGRNsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [qcFilter, setQcFilter] = useState('ALL');

  const { data: grns = [], isLoading, refetch } = useQuery({
    queryKey: ['yarn-grns'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/yarn-grns');
      return res.data || [];
    },
  });

  const filtered = useMemo(() => {
    return grns.filter((g) => {
      const matchesSearch =
        !search ||
        g.grn_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.po_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.internal_ir_no?.toLowerCase().includes(search.toLowerCase()) ||
        g.supplier_name?.toLowerCase().includes(search.toLowerCase()) ||
        g.style_code?.toLowerCase().includes(search.toLowerCase());

      const matchesQc = qcFilter === 'ALL' || g.qc_status === qcFilter;

      return matchesSearch && matchesQc;
    });
  }, [grns, search, qcFilter]);

  const kpis = useMemo(() => {
    const totalGrns = grns.length;
    const totalKg = grns.reduce((s, g) => s + (Number(g.total_kg) || 0), 0);
    const totalPacks = grns.reduce((s, g) => s + (Number(g.total_packs) || 0), 0);
    return { totalGrns, totalKg, totalPacks };
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
            <span className="p-2 rounded-lg bg-amber-100 text-amber-700">
              <PackageCheck size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">Yarn Goods Receipt Notes (GRN)</h1>
              <p className="text-xs text-slate-500">
                Weighed KG verification, bag/pack counting, lot quality check, and yarn stock ledger inward
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/yarn/orders')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <Disc size={14} className="text-amber-600" />
            <span>Yarn Orders</span>
          </button>
          <button
            onClick={() => nav('/procurement/yarn/grn/new')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white shadow-sm transition"
          >
            <Plus size={15} />
            <span>New Yarn GRN</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Yarn Inward Batches</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{fmtNumber(kpis.totalGrns)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Recorded GRN shipments</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Weighed Yarn (KG)</div>
          <div className="text-2xl font-bold text-amber-600 mt-1">{fmtDecimal(kpis.totalKg)} KG</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Actual net inward weight</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Bags / Packs Received</div>
          <div className="text-2xl font-bold text-indigo-600 mt-1">{fmtNumber(kpis.totalPacks)} Bags</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Physical pack count</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search GRN, PO, Mill, Style, IR..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter size={15} className="text-slate-400" />
          <select
            value={qcFilter}
            onChange={(e) => setQcFilter(e.target.value)}
            className="text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
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
                <th className="py-3 px-4">GRN No & Date</th>
                <th className="py-3 px-3">PO & IR No</th>
                <th className="py-3 px-3">Spinning Mill / Supplier</th>
                <th className="py-3 px-3">Style</th>
                <th className="py-3 px-3">Warehouse</th>
                <th className="py-3 px-3 text-right">Weighed Weight (KG)</th>
                <th className="py-3 px-3 text-center">Bags / Packs</th>
                <th className="py-3 px-3 text-center">QC Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-400">
                    Loading yarn GRNs...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    <PackageCheck size={36} className="mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-medium text-slate-600">No yarn GRN records found</p>
                    <p className="text-xs text-slate-400 mt-1">Inward received yarn against approved POs</p>
                  </td>
                </tr>
              ) : (
                filtered.map((g) => (
                  <tr
                    key={g.id}
                    onClick={() => nav(`/procurement/yarn/grn/${g.id}`)}
                    className="hover:bg-slate-50/70 transition cursor-pointer"
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-amber-700">{g.grn_no}</div>
                      <div className="text-[11px] text-slate-400">{fmtDate(g.grn_date)}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-800">{g.po_no || '—'}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{g.internal_ir_no || '—'}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-slate-800">{g.supplier_name || 'Spinning Mill'}</div>
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
                      {g.warehouse_name || 'Yarn Store'}
                    </td>
                    <td className="py-3 px-3 text-right font-bold text-amber-700">
                      {fmtDecimal(g.total_kg)} KG
                    </td>
                    <td className="py-3 px-3 text-center font-medium text-slate-800">
                      {fmtNumber(g.total_packs)} Bags
                    </td>
                    <td className="py-3 px-3 text-center">
                      <Badge tone={getQcBadgeTone(g.qc_status)}>{g.qc_status || 'ACCEPTED'}</Badge>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          nav(`/procurement/yarn/grn/${g.id}`);
                        }}
                        className="p-1 text-slate-400 hover:text-amber-700 hover:bg-amber-50 rounded transition"
                        title="View GRN"
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
