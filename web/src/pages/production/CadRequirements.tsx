import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Cpu, Plus, Search, Eye, Filter, Layers, RefreshCw
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, fmtNumber } from '../../lib/format';
import { Badge } from '../../components/ui';

export default function CadRequirementsPage() {
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const { data: reqs = [], isLoading, refetch } = useQuery({
    queryKey: ['cad-requirements'],
    queryFn: async () => {
      const res = await http.get<{ data: any[] }>('/cad-requirements');
      return res.data || [];
    },
  });

  const filtered = useMemo(() => {
    return reqs.filter((r) => {
      const matchesSearch =
        !search ||
        r.req_no?.toLowerCase().includes(search.toLowerCase()) ||
        r.internal_ir_no?.toLowerCase().includes(search.toLowerCase()) ||
        r.style_code?.toLowerCase().includes(search.toLowerCase()) ||
        r.style_name?.toLowerCase().includes(search.toLowerCase()) ||
        r.buyer_name?.toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        statusFilter === 'ALL' || r.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [reqs, search, statusFilter]);

  const kpis = useMemo(() => {
    const totalReqs = reqs.length;
    const totalPcs = reqs.reduce((s, r) => s + (Number(r.order_qty) || 0), 0);
    const approved = reqs.filter((r) => r.status === 'APPROVED').length;
    const totalFabricKg = reqs.reduce((s, r) => s + (Number(r.total_fabric_kg) || 0), 0);
    return { totalReqs, totalPcs, approved, totalFabricKg };
  }, [reqs]);

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-indigo-100 text-indigo-700">
              <Cpu size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight">CAD Requirement & Auto-Consumption</h1>
              <p className="text-xs text-slate-500">
                Pattern piece mapping, multi-materials (foam/interlining), 3-colour stripe ratios, and yarn conversion
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/fabric/orders')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <Layers size={14} className="text-sky-600" />
            <span>Fabric Orders</span>
          </button>
          <button
            onClick={() => nav('/production/cad-requirements/new')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm transition"
          >
            <Plus size={15} />
            <span>New CAD Requirement</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total CAD Requirements</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{fmtNumber(kpis.totalReqs)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Style marker calculations</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Total Order Volume</div>
          <div className="text-2xl font-bold text-indigo-600 mt-1">{fmtNumber(kpis.totalPcs)} Pcs</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Garment pieces planned</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Approved for Production</div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{fmtNumber(kpis.approved)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Handed off to PPC & Sourcing</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Calculated Fabric Need</div>
          <div className="text-2xl font-bold text-sky-600 mt-1">{fmtDecimal(kpis.totalFabricKg)} KG</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Auto-consumption output</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search Req No, Style, IR No, Buyer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter size={15} className="text-slate-400" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
          >
            <option value="ALL">All Status</option>
            <option value="DRAFT">Draft</option>
            <option value="CALCULATED">Calculated</option>
            <option value="APPROVED">Approved</option>
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
                <th className="py-3 px-4">CAD Req No & Date</th>
                <th className="py-3 px-3">Style Code & Name</th>
                <th className="py-3 px-3">Internal / IR No</th>
                <th className="py-3 px-3">Buyer</th>
                <th className="py-3 px-3 text-right">Order Qty</th>
                <th className="py-3 px-3 text-center">CAD Pieces</th>
                <th className="py-3 px-3 text-right">Avg Gms / Pc</th>
                <th className="py-3 px-3 text-right">Total Fabric (KG)</th>
                <th className="py-3 px-3 text-center">Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-400">
                    Loading CAD requirements...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    <Cpu size={36} className="mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-medium text-slate-600">No CAD requirement records found</p>
                    <p className="text-xs text-slate-400 mt-1">Create CAD piece mapping to run auto-consumption</p>
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => nav(`/production/cad-requirements/${r.id}`)}
                    className="hover:bg-slate-50/70 transition cursor-pointer"
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-indigo-700">{r.req_no}</div>
                      <div className="text-[11px] text-slate-400">{fmtDate(r.req_date)}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-semibold text-slate-800">{r.style_code}</div>
                      <div className="text-[11px] text-slate-400">{r.style_name || 'T-Shirt / Polo'}</div>
                    </td>
                    <td className="py-3 px-3 font-mono text-[11px] text-slate-700">
                      {r.internal_ir_no || '—'}
                    </td>
                    <td className="py-3 px-3 text-slate-800 font-medium">
                      {r.buyer_name || 'Direct Buyer'}
                    </td>
                    <td className="py-3 px-3 text-right font-bold text-slate-900">
                      {fmtNumber(r.order_qty)} Pcs
                    </td>
                    <td className="py-3 px-3 text-center font-medium text-sky-700">
                      {r.piece_count ? `${r.piece_count} pieces` : '6 pieces'}
                    </td>
                    <td className="py-3 px-3 text-right font-medium text-slate-700">
                      {fmtDecimal(r.total_fabric_kg && r.order_qty ? (r.total_fabric_kg * 1000) / r.order_qty : 210)} g
                    </td>
                    <td className="py-3 px-3 text-right font-bold text-indigo-700">
                      {fmtDecimal(r.total_fabric_kg || 1050)} KG
                    </td>
                    <td className="py-3 px-3 text-center">
                      <Badge
                        tone={
                          r.status === 'APPROVED'
                            ? 'green'
                            : r.status === 'CALCULATED'
                            ? 'blue'
                            : 'slate'
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          nav(`/production/cad-requirements/${r.id}`);
                        }}
                        className="p-1 text-slate-400 hover:text-indigo-700 hover:bg-indigo-50 rounded transition"
                        title="View CAD Auto-Consumption Cockpit"
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
