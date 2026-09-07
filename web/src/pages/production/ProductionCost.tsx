import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Calculator, FileText, ArrowDownRight, Boxes } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { DataTable } from '../../components/DataTable';
import { PageHeader, SearchInput, Select, StatusBadge, useDebounced } from '../../components/ui';
import { fmtDate, fmtDecimal, fmtNumber } from '../../lib/format';

export function ProductionCostsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'cost_date', dir: 'desc' });
  const debounced = useDebounced(search);

  const [orderId, setOrderId] = useState('');
  const [styleId, setStyleId] = useState('');
  const [status, setStatus] = useState('');

  const prodOrders = useLookup('production-orders');
  const styles = useLookup('styles');

  const list = useList<any>('production-costs', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    prod_order_id: orderId || undefined,
    style_id: styleId || undefined,
    status: status || undefined,
    sort: sort.key,
    dir: sort.dir,
  });

  const rows = list.data?.data ?? [];

  // Summary Metrics
  const totalCost = rows.reduce((s: number, r: any) => s + (Number(r.total_cost) || 0), 0);
  const totalProduced = rows.reduce((s: number, r: any) => s + (Number(r.produced_qty) || 0), 0);
  const avgCostPerPc = totalProduced > 0 ? totalCost / totalProduced : 0;

  return (
    <>
      <PageHeader
        breadcrumb={['Production', 'Production Costing']}
        title="Actual Production Costing"
        subtitle="Automatic calculation & variance tracking from approved production transactions"
        actions={
          can('PRODUCTION.CREATE') && (
            <button
              className="btn-primary flex items-center gap-1.5"
              onClick={() => nav('/production/costs/new')}
            >
              <Plus size={15} /> New Costing Sheet
            </button>
          )
        }
      />

      {/* Top Metric Cards */}
      <div className="mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider">Total Actual Cost</span>
            <Calculator size={16} className="text-brand-600" />
          </div>
          <span className="text-2xl font-black text-slate-900 font-mono">
            ₹{fmtDecimal(totalCost, 0)}
          </span>
          <p className="text-[11px] text-slate-500 mt-1">Across all filtered cost sheets</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider">Produced Volume</span>
            <Boxes size={16} className="text-slate-400" />
          </div>
          <span className="text-2xl font-black text-slate-900 font-mono">
            {fmtNumber(totalProduced)}
          </span>
          <p className="text-[11px] text-slate-500 mt-1">Total pieces completed</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-slate-500 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider">Weighted Cost / Pc</span>
            <FileText size={16} className="text-slate-400" />
          </div>
          <span className="text-2xl font-black text-brand-700 font-mono">
            ₹{fmtDecimal(avgCostPerPc, 2)}
          </span>
          <p className="text-[11px] text-slate-500 mt-1">Average per garment execution</p>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-emerald-800 mb-1">
            <span className="text-xs font-bold uppercase tracking-wider">Cost Sheets Count</span>
            <ArrowDownRight size={16} className="text-emerald-600" />
          </div>
          <span className="text-2xl font-black text-emerald-900 font-mono">
            {rows.length}
          </span>
          <p className="text-[11px] text-emerald-700 font-medium mt-1">Controlled & Auditable</p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search costing sheet number…"
          className="w-full max-w-xs"
        />
        <div className="w-52">
          <Select
            placeholder="All Work Orders"
            options={toOptions(prodOrders.data)}
            value={orderId}
            onChange={(e) => {
              setOrderId(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-48">
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
        <div className="w-40">
          <Select
            placeholder="All Statuses"
            options={[
              { value: 'DRAFT', label: 'Draft' },
              { value: 'DATA_LOADED', label: 'Data Loaded' },
              { value: 'CALCULATED', label: 'Calculated' },
              { value: 'APPROVED', label: 'Approved' },
              { value: 'FINALIZED', label: 'Finalized / Locked' },
            ]}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          />
        </div>
        {(orderId || styleId || status) && (
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setOrderId('');
              setStyleId('');
              setStatus('');
              setPage(1);
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Data Table */}
      <DataTable
        columns={[
          {
            key: 'cost_no',
            header: 'Cost Sheet No',
            sortable: true,
            render: (r: any) => (
              <div>
                <span className="font-mono text-[12.5px] font-bold text-brand-700">{r.cost_no}</span>
                <span className="ml-2 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-bold text-slate-600 font-mono">
                  v{r.version || 1}
                </span>
              </div>
            ),
          },
          {
            key: 'cost_date',
            header: 'Date',
            sortable: true,
            render: (r: any) => fmtDate(r.cost_date),
          },
          {
            key: 'po_prod_no',
            header: 'Production Order',
            render: (r: any) => (
              <span className="font-mono text-xs font-bold text-slate-900">{r.po_prod_no || '—'}</span>
            ),
          },
          {
            key: 'style_code',
            header: 'Style',
            render: (r: any) => (
              <div>
                <p className="font-bold text-slate-900 text-xs">{r.style_code || '—'}</p>
                <p className="text-[11px] text-slate-500">{r.style_name || '—'}</p>
              </div>
            ),
          },
          {
            key: 'buyer_name',
            header: 'Buyer',
            render: (r: any) => <span className="font-medium text-slate-700 text-xs">{r.buyer_name || '—'}</span>,
          },
          {
            key: 'produced_qty',
            header: 'Produced Qty',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-bold text-slate-800 text-xs">
                {fmtNumber(r.produced_qty)} pcs
              </span>
            ),
          },
          {
            key: 'total_cost',
            header: 'Total Cost (₹)',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-bold text-slate-900 text-xs">
                ₹{fmtDecimal(r.total_cost, 2)}
              </span>
            ),
          },
          {
            key: 'cost_per_piece',
            header: 'Actual / Pc',
            align: 'right',
            render: (r: any) => (
              <span className="font-mono font-black text-brand-700 text-xs">
                ₹{fmtDecimal(r.cost_per_piece, 2)}
              </span>
            ),
          },
          {
            key: 'variance_pct',
            header: 'Variance',
            align: 'right',
            render: (r: any) => {
              const v = Number(r.variance_pct);
              if (!v) return <span className="text-slate-400 font-mono text-xs">0.0%</span>;
              return (
                <span className={`font-mono text-xs font-bold ${
                  v <= 0 ? 'text-emerald-600' : 'text-rose-600'
                }`}>
                  {v > 0 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`}
                </span>
              );
            },
          },
          {
            key: 'status',
            header: 'Status',
            render: (r: any) => <StatusBadge value={r.status} />,
          },
        ]}
        rows={rows}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/production/costs/${r.id}`)}
        sort={sort}
        onSort={onSort}
        pagination={list.data?.pagination}
        onPage={setPage}
        emptyTitle="No production costing sheets found"
        emptyMessage="Select a Production Order and calculate automatic actual costing against factory transactions."
      />
    </>
  );
}
