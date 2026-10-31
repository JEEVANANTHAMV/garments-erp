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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-surface-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-amber-100 text-amber-700">
              <PackageCheck size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-ink tracking-tight">Yarn Goods Receipt Notes (GRN)</h1>
              <p className="text-xs text-ink-secondary">
                Weighed KG verification, bag/pack counting, lot quality check, and yarn stock ledger inward
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => nav('/procurement/yarn/orders')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-surface-input bg-white hover:bg-surface-muted text-ink shadow-sm transition"
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
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Total Yarn Inward Batches</div>
          <div className="text-2xl font-bold text-ink mt-1">{fmtNumber(kpis.totalGrns)}</div>
          <div className="text-caption text-ink-muted mt-0.5">Recorded GRN shipments</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Total Weighed Yarn (KG)</div>
          <div className="text-2xl font-bold text-amber-600 mt-1">{fmtDecimal(kpis.totalKg)} KG</div>
          <div className="text-caption text-ink-muted mt-0.5">Actual net inward weight</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-surface-border/80 shadow-sm">
          <div className="text-xs font-medium text-ink-secondary">Total Bags / Packs Received</div>
          <div className="text-2xl font-bold text-indigo-600 mt-1">{fmtNumber(kpis.totalPacks)} Bags</div>
          <div className="text-caption text-ink-muted mt-0.5">Physical pack count</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-surface-border/80 shadow-sm">
        <div className="relative w-full sm:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-ink-muted" />
          <input
            type="text"
            placeholder="Search GRN, PO, Gate Entry, Mill, Style, IO No..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-surface-input focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter size={15} className="text-ink-muted" />
          <select
            value={qcFilter}
            onChange={(e) => setQcFilter(e.target.value)}
            className="text-xs rounded-lg border border-surface-input py-1.5 px-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500"
          >
            <option value="ALL">All QC Status</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="CONDITIONAL">Conditional</option>
            <option value="REJECTED">Rejected</option>
          </select>

          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-lg border border-surface-input hover:bg-surface-muted text-ink-secondary transition"
            title="Refresh list"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-surface-border/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-surface-muted/80 text-ink-secondary font-semibold border-b border-surface-border">
                <th className="py-3 px-4">GRN No & Date</th>
                <th className="py-3 px-3">PO & IO No</th>
                <th className="py-3 px-3">Gate Entry</th>
                <th className="py-3 px-3">Spinning Mill / Supplier</th>
                <th className="py-3 px-3">Style</th>
                <th className="py-3 px-3">Warehouse</th>
                <th className="py-3 px-3 text-right">Weighed Weight (KG)</th>
                <th className="py-3 px-3 text-center">Bags / Packs</th>
                <th className="py-3 px-3 text-center">QC Status</th>
                <th className="py-3 px-4 text-center">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-divider text-ink">
              {isLoading ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-ink-muted">
                    Loading yarn GRNs...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-ink-muted">
                    <PackageCheck size={36} className="mx-auto text-ink-disabled mb-2" />
                    <p className="text-sm font-medium text-ink-secondary">No yarn GRN records found</p>
                    <p className="text-xs text-ink-muted mt-1">Inward received yarn against approved POs</p>
                  </td>
                </tr>
              ) : (
                filtered.map((g) => (
                  <tr
                    key={g.id}
                    onClick={() => nav(`/procurement/yarn/grn/${g.id}`)}
                    className="hover:bg-surface-muted/70 transition cursor-pointer"
                  >
                    <td className="py-3 px-4">
                      <div className="font-semibold text-amber-700">{g.grn_no}</div>
                      <div className="text-caption text-ink-muted">{fmtDate(g.grn_date)}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-ink">{g.po_no || '—'}</div>
                      <div className="text-micro text-ink-secondary tabular-nums">{g.internal_ir_no || '—'}</div>
                    </td>
                    <td className="py-3 px-3">
                      {g.gate_entry_no ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-caption font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                          {g.gate_entry_no}
                        </span>
                      ) : (
                        <span className="text-ink-muted text-caption">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-medium text-ink">{g.supplier_name || 'Spinning Mill'}</div>
                      {g.supplier_dc_no && (
                        <div className="text-micro text-ink-muted">DC: {g.supplier_dc_no}</div>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <span className="tabular-nums text-caption text-ink bg-surface-header px-1.5 py-0.5 rounded">
                        {g.style_code || 'GEN'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-ink-secondary text-caption">
                      {g.warehouse_name || 'Yarn Store'}
                    </td>
                    <td className="py-3 px-3 text-right font-bold text-amber-700">
                      {fmtDecimal(g.total_kg)} KG
                    </td>
                    <td className="py-3 px-3 text-center font-medium text-ink">
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
                        className="p-1 text-ink-muted hover:text-amber-700 hover:bg-amber-50 rounded transition"
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
