import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ChevronRight } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, humanize } from '../../lib/format';
import { Badge, StatusBadge, Spinner } from '../../components/ui';

export function PurchaseReturnsPage() {
  const nav = useNavigate();
  const [loading, setLoading] = useState(true);
  const [returns, setReturns] = useState<any[]>([]);
  const [category, setCategory] = useState<string>('ALL');
  const [status, setStatus] = useState<string>('ALL');
  const [search, setSearch] = useState<string>('');

  const fetchReturns = () => {
    setLoading(true);
    const params: any = {};
    if (category !== 'ALL') params.material_category = category;
    if (status !== 'ALL') params.status = status;

    http.get<{ data: any[] }>('/purchase-returns', { params })
      .then((res) => setReturns(res.data || []))
      .catch(() => setReturns([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchReturns();
  }, [category, status]);

  const filtered = returns.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.return_no?.toLowerCase().includes(q) ||
      r.supplier_name?.toLowerCase().includes(q) ||
      r.grn_no?.toLowerCase().includes(q) ||
      r.return_dc_no?.toLowerCase().includes(q)
    );
  });

  const categoryConfig: Record<string, { label: string; icon: string; tone: any }> = {
    FABRIC: { label: 'Fabric', icon: '🧶', tone: 'purple' },
    YARN: { label: 'Yarn', icon: '🧵', tone: 'indigo' },
    TRIM: { label: 'Trims', icon: '✂️', tone: 'amber' },
    GENERAL: { label: 'General', icon: '📦', tone: 'slate' },
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Purchase Returns</h1>
          <p className="text-xs text-slate-500">
            Physical returns of rejected, excess, or wrong materials back to suppliers with Return DC tracking
          </p>
        </div>
        <button
          type="button"
          onClick={() => nav('/procurement/returns/new')}
          className="btn btn-primary flex items-center gap-1.5"
        >
          <Plus className="h-4 w-4" />
          <span>New Purchase Return</span>
        </button>
      </div>

      {/* Category Tabs */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 shadow-xs flex flex-wrap items-center gap-2 overflow-x-auto">
        {[
          { id: 'ALL', label: 'All Returns', icon: '📋' },
          { id: 'FABRIC', label: 'Fabric Returns', icon: '🧶' },
          { id: 'YARN', label: 'Yarn Returns', icon: '🧵' },
          { id: 'TRIM', label: 'Trims Returns', icon: '✂️' },
          { id: 'GENERAL', label: 'General Materials', icon: '📦' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setCategory(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              category === t.id
                ? 'bg-slate-900 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200 shadow-xs">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            className="input pl-9 h-9 text-xs"
            placeholder="Search return no, supplier, GRN, DC no..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-500 font-medium">Status:</span>
          <select
            className="input h-9 py-0 text-xs"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="ALL">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="SUBMITTED">Submitted</option>
            <option value="APPROVED">Approved</option>
            <option value="RETURN_DC_CREATED">Return DC Created</option>
            <option value="STOCK_POSTED">Stock Posted</option>
            <option value="CLOSED">Closed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Returns List Table */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-xs overflow-hidden">
        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <Spinner size={24} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">
            No purchase returns found for this category or filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4">Return No</th>
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4">Category</th>
                  <th className="py-3 px-4">Supplier</th>
                  <th className="py-3 px-4">GRN Ref</th>
                  <th className="py-3 px-4">Reason</th>
                  <th className="py-3 px-4 text-right">Return Qty</th>
                  <th className="py-3 px-4 text-right">Value (₹)</th>
                  <th className="py-3 px-4">Return DC</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => {
                  const catCfg = categoryConfig[r.material_category] || { label: r.material_category, tone: 'slate' };
                  return (
                    <tr
                      key={r.id}
                      onClick={() => nav(`/procurement/returns/${r.id}`)}
                      className="hover:bg-slate-50 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-mono font-bold text-brand-700">
                        {r.return_no}
                      </td>
                      <td className="py-3 px-4 text-slate-500">
                        {fmtDate(r.return_date)}
                      </td>
                      <td className="py-3 px-4">
                        <Badge tone={catCfg.tone}>{catCfg.label}</Badge>
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-900">
                        {r.supplier_name || '—'}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600">
                        {r.grn_no || '—'}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-slate-700 font-medium">{humanize(r.return_reason)}</span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-red-700">
                        {fmtDecimal(r.total_qty, 2)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-bold text-slate-800">
                        ₹{fmtDecimal(r.total_amount, 2)}
                      </td>
                      <td className="py-3 px-4">
                        {r.return_dc_no ? (
                          <span className="font-mono text-[11px] bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded border border-indigo-200">
                            {r.return_dc_no}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <StatusBadge value={r.status} />
                      </td>
                      <td className="py-3 px-4 text-right">
                        <ChevronRight className="h-4 w-4 text-slate-400 inline" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
