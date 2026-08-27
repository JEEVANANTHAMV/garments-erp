import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useList, useListState } from '../../hooks/useResource';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, StatusBadge, Select, useDebounced
} from '../../components/ui';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { fmtDate, fmtNumber, fmtDecimal } from '../../lib/format';

const STATES = ['DRAFT','PENDING','APPROVED','REJECTED','ON_HOLD','CLOSED','CANCELLED'];

export default function SalesOrdersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const { page, setPage, search, setSearch, sort, onSort } = useListState({ key: 'so_date', dir: 'desc' });
  const debounced = useDebounced(search);
  const [buyerId, setBuyerId] = useState('');
  const [state, setState] = useState('');

  const buyers = useLookup('buyers');
  const list = useList<any>('sales-orders', {
    page, pageSize: 25, q: debounced || undefined,
    buyer_id: buyerId || undefined, approval_state: state || undefined,
  });

  return (
    <>
      <PageHeader title="Sales Orders" subtitle="Confirmed export orders and their production progress"
        actions={can('SALES_ORDER.CREATE') && (
          <button className="btn-primary" onClick={() => nav('/sales/orders/new')}>
            <Plus size={15} /> New Order
          </button>)} />

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <SearchInput value={search} onChange={setSearch} placeholder="Search SO no, buyer PO, LC…" />
        <Select placeholder="All buyers" options={toOptions(buyers.data)}
          value={buyerId} onChange={(e) => { setBuyerId(e.target.value); setPage(1); }} />
        <Select placeholder="All states" options={STATES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
          value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} />
      </div>

      <DataTable
        columns={[
          { key: 'so_no', header: 'SO no', sortable: true,
            render: (r: any) => <Link to={`/sales/orders/${r.id}`}
              className="font-mono text-[12px] font-medium text-brand-700 hover:underline">{r.so_no}</Link> },
          { key: 'so_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.so_date) },
          { key: 'buyer_name', header: 'Buyer', render: (r: any) => (
            <div><p className="font-medium text-slate-800">{r.buyer_name}</p>
              {r.buyer_po_no && <p className="text-[11px] text-slate-500">PO: {r.buyer_po_no}</p>}</div>) },
          { key: 'season', header: 'Season' },
          { key: 'order_qty', header: 'Order qty', align: 'right', sortable: true,
            render: (r: any) => (
              <div className="text-right">
                <p className="font-semibold text-slate-800 tabular-nums">{fmtNumber(r.order_qty)} pcs</p>
                {Number(r.plan_cut_qty) > Number(r.order_qty) && (
                  <p className="text-[10.5px] text-amber-700 font-medium tabular-nums" title="Planned Cutting Qty with buffer">
                    Plan: {fmtNumber(r.plan_cut_qty)} ({r.excess_pct ? `+${Number(r.excess_pct)}%` : ''})
                  </p>
                )}
              </div>
            ) },
          { key: 'progress', header: 'Produced', align: 'right', render: (r: any) => {
            const pct = Number(r.order_qty) > 0 ? (Number(r.produced_qty) / Number(r.order_qty)) * 100 : 0;
            return (
              <div className="min-w-[110px]">
                <div className="mb-1 flex justify-between text-[11px]">
                  <span className="tabular-nums text-slate-600">{fmtNumber(r.produced_qty)}</span>
                  <span className="text-slate-400">{pct.toFixed(0)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
                    style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </div>);
          } },
          { key: 'total_amount', header: 'Value', align: 'right',
            render: (r: any) => <span className="font-medium tabular-nums">
              {r.currency_code} {fmtDecimal(r.total_amount, 2)}</span> },
          { key: 'ship_date', header: 'Ship date', sortable: true, render: (r: any) => fmtDate(r.ship_date) },
          { key: 'approval_state', header: 'State', render: (r: any) => <StatusBadge value={r.approval_state} /> },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => nav(`/sales/orders/${r.id}`)}
        sort={sort} onSort={onSort}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No sales orders"
        emptyMessage="Confirmed buyer orders will appear here."
        emptyAction={can('SALES_ORDER.CREATE')
          ? <button className="btn-primary" onClick={() => nav('/sales/orders/new')}>
              <Plus size={15} /> New Order</button>
          : undefined} />
    </>
  );
}
