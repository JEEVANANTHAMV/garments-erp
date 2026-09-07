import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Sparkles, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { DataTable } from '../../components/DataTable';
import { PageHeader, SearchInput, Select, StatusBadge, useDebounced } from '../../components/ui';
import { fmtDate, fmtDecimal, fmtNumber } from '../../lib/format';

export default function PreCostingsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'costing_date', dir: 'desc' });
  const debounced = useDebounced(search);
  const [buyerId, setBuyerId] = useState('');
  const [styleId, setStyleId] = useState('');

  const buyers = useLookup('buyers');
  const styles = useLookup('styles');

  const list = useList<any>('costings', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    buyer_id: buyerId || undefined,
    style_id: styleId || undefined,
    costing_type: 'PRE_COSTING',
    sort: sort.key,
    dir: sort.dir,
  });

  const rows = list.data?.data ?? [];

  return (
    <>
      <PageHeader
        breadcrumb={['Pre-Sales', 'Merchandiser Pre-Costing']}
        title="Merchandiser Pre-Costing"
        subtitle="Commercial style costing engine with Style BOM auto-loading, fabric/yarn recipe, SMV sewing engine and markup"
        actions={
          can('COSTING.CREATE') && (
            <button className="btn-primary flex items-center gap-1.5" onClick={() => nav('/sales/pre-costings/new')}>
              <Plus size={15} /> New Pre-Costing
            </button>
          )
        }
      />

      {/* Top Level Screen Switcher */}
      <div className="mb-4 flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={() => nav('/sales/costings')}
          className="px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 flex items-center gap-1.5"
        >
          <FileSpreadsheet size={14} /> Costing Sheets (Classic F14)
        </button>
        <button
          type="button"
          className="px-3 py-1.5 text-xs font-bold rounded-lg bg-brand-600 text-white shadow-xs flex items-center gap-1.5"
        >
          <Sparkles size={14} /> Merchandiser Pre-Costing (V2 Engine)
        </button>
      </div>

      {/* KPI Cards */}
      <div className="mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Active Styles Costed</span>
          <p className="text-2xl font-black text-slate-900 mt-1 font-mono">{rows.length}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">Commercial pre-orders</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Avg Cost / Piece</span>
          <p className="text-2xl font-black text-slate-800 mt-1 font-mono">
            ₹{fmtDecimal(
              rows.length > 0 ? rows.reduce((s: number, r: any) => s + (Number(r.total_cost) || 0), 0) / rows.length : 0,
              2
            )}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">Calculated target cost</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Avg Quoted FOB</span>
          <p className="text-2xl font-black text-brand-700 mt-1 font-mono">
            ₹{fmtDecimal(
              rows.length > 0 ? rows.reduce((s: number, r: any) => s + (Number(r.fob_price) || 0), 0) / rows.length : 0,
              2
            )}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">Average selling target</p>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3.5 shadow-xs">
          <span className="text-xs font-bold uppercase tracking-wider text-emerald-800">Avg Margin Target</span>
          <p className="text-2xl font-black text-emerald-900 mt-1 font-mono">
            {rows.length > 0 ? (rows.reduce((s: number, r: any) => s + (Number(r.margin_pct) || 0), 0) / rows.length).toFixed(1) : '15.0'}%
          </p>
          <p className="text-[11px] text-emerald-700 mt-0.5">Target commercial profitability</p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search costing number or style code…"
          className="w-full max-w-md"
        />
        <div className="w-56">
          <Select
            placeholder="All Buyers"
            options={toOptions(buyers.data)}
            value={buyerId}
            onChange={(e) => {
              setBuyerId(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-56">
          <Select
            placeholder="All Styles"
            options={toOptions(styles.data)}
            value={styleId}
            onChange={(e) => {
              setStyleId(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {(buyerId || styleId) && (
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setBuyerId('');
              setStyleId('');
              setPage(1);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <DataTable
        columns={[
          {
            key: 'costing_no',
            header: 'Costing No',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono text-[12.5px] font-bold text-brand-700">{r.costing_no}</span>
            ),
          },
          {
            key: 'version',
            header: 'Rev',
            align: 'center',
            render: (r: any) => (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-700">
                v{r.version || 1}
              </span>
            ),
          },
          {
            key: 'costing_date',
            header: 'Date',
            sortable: true,
            render: (r: any) => fmtDate(r.costing_date),
          },
          {
            key: 'style_code',
            header: 'Style',
            render: (r: any) => (
              <div>
                <p className="font-bold text-slate-900">{r.style_code || '—'}</p>
                <p className="text-[11px] text-slate-500">{r.style_name || '—'}</p>
              </div>
            ),
          },
          {
            key: 'buyer_name',
            header: 'Buyer',
            render: (r: any) => <span className="font-medium text-slate-800">{r.buyer_name || '—'}</span>,
          },
          {
            key: 'order_qty',
            header: 'Order Qty',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-semibold text-slate-700">
                {r.order_qty ? `${fmtNumber(r.order_qty)} pcs` : '—'}
              </span>
            ),
          },
          {
            key: 'total_cost',
            header: 'Cost / Pc',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-medium text-slate-700">
                ₹{fmtDecimal(r.total_cost || 0, 2)}
              </span>
            ),
          },
          {
            key: 'fob_price',
            header: 'Quoted FOB',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-black text-emerald-700 text-[13px]">
                ₹{fmtDecimal(r.fob_price || 0, 2)}
              </span>
            ),
          },
          {
            key: 'margin_pct',
            header: 'Margin',
            align: 'right',
            render: (r: any) => {
              const m = Number(r.margin_pct) || 0;
              return (
                <span className={`font-mono font-bold text-xs ${m >= 15 ? 'text-emerald-600' : m >= 10 ? 'text-amber-600' : 'text-rose-600'}`}>
                  {m.toFixed(1)}%
                </span>
              );
            },
          },
          {
            key: 'status_label',
            header: 'Status',
            render: (r: any) => <StatusBadge value={r.status_label || 'Draft'} />,
          },
        ]}
        rows={rows}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/sales/pre-costings/${r.id}`)}
        sort={sort}
        onSort={onSort}
        pagination={list.data?.pagination}
        onPage={setPage}
        emptyTitle="No merchandiser pre-costings found"
        emptyMessage="Create a style pre-costing sheet using Style BOM, Yarn/Fabric recipe, and SMV sewing engine."
      />
    </>
  );
}
