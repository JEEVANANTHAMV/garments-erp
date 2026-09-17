import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Plus, Zap, ShoppingCart, Receipt } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useList, useListState } from '../../hooks/useResource';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { DataTable } from '../../components/DataTable';
import { PageHeader, SearchInput, Select, Badge, StatusBadge, useDebounced } from '../../components/ui';
import { fmtDecimal, fmtDate, humanize } from '../../lib/format';

export function GeneralPurchasesPage() {
  const nav = useNavigate();
  const location = useLocation();
  const isPoMode = location.pathname.includes('general-orders');
  const { can } = useAuth();
  const suppliers = useLookup('suppliers');

  const { page, setPage, search, setSearch, sort, onSort } = useListState({
    key: 'purchase_date',
    dir: 'desc',
  });
  const debounced = useDebounced(search);

  const [supplierFilter, setSupplierFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const list = useList<any>('general-purchases', {
    page,
    pageSize: 25,
    q: debounced || undefined,
    supplier_id: supplierFilter || undefined,
    purchase_type: typeFilter || undefined,
    approval_state: statusFilter || (isPoMode ? undefined : undefined),
  });

  const getPurchaseTypeTone = (type: string) => {
    switch (type) {
      case 'EMERGENCY':
        return 'rose';
      case 'ORDER_SPECIFIC':
        return 'sky';
      case 'SAMPLE':
        return 'amber';
      case 'MAINTENANCE':
        return 'violet';
      case 'STOCK':
        return 'emerald';
      default:
        return 'slate';
    }
  };

  return (
    <>
      <PageHeader
        title={isPoMode ? "General Purchase Orders (General PO)" : "General Goods Receipt (General GRN & Inward)"}
        subtitle={
          isPoMode
            ? "Consumables, packaging materials, maintenance spares & office procurement orders with Inter-State IGST"
            : "Inward Gate Entry pass linkage, QC verification, direct job allocation, and stock ledger posting"
        }
        actions={
          <div className="flex items-center gap-2">
            {/* Mode Switcher Pills */}
            <div className="flex items-center rounded-lg bg-slate-100 p-1 border border-slate-200 text-xs">
              <button
                type="button"
                onClick={() => nav('/procurement/general-orders')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md font-medium transition ${
                  isPoMode
                    ? 'bg-white text-brand-700 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <ShoppingCart size={13} />
                <span>General POs</span>
              </button>
              <button
                type="button"
                onClick={() => nav('/procurement/general-purchases')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md font-medium transition ${
                  !isPoMode
                    ? 'bg-white text-emerald-700 shadow-xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Receipt size={13} />
                <span>General GRN</span>
              </button>
            </div>

            {can('PURCHASE.CREATE') && (
              <button
                className="btn-primary flex items-center gap-1.5"
                onClick={() => nav(isPoMode ? '/procurement/general-orders/new' : '/procurement/general-purchases/new')}
              >
                <Plus size={15} /> {isPoMode ? 'New General PO' : 'New General GRN'}
              </button>
            )}
          </div>
        }
      />

      {/* Filter Toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-surface-border bg-white p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search GP no, invoice, notes…"
            />
          </div>
          <div className="w-48">
            <Select
              placeholder="All Suppliers"
              options={toOptions(suppliers.data || [])}
              value={supplierFilter}
              onChange={(e) => {
                setSupplierFilter(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="w-44">
            <Select
              placeholder="All Purchase Types"
              options={[
                { value: 'GENERAL', label: 'General' },
                { value: 'STOCK', label: 'Stock Purchase' },
                { value: 'ORDER_SPECIFIC', label: 'Order Specific' },
                { value: 'EMERGENCY', label: 'Emergency / Direct' },
                { value: 'SAMPLE', label: 'Sample Purchase' },
                { value: 'MAINTENANCE', label: 'Maintenance Spares' },
              ]}
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="w-40">
            <Select
              placeholder="All States"
              options={[
                { value: 'DRAFT', label: 'Draft' },
                { value: 'PENDING', label: 'Pending' },
                { value: 'APPROVED', label: 'Approved' },
                { value: 'POSTED', label: 'Posted' },
                { value: 'CANCELLED', label: 'Cancelled' },
              ]}
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>

        <div className="text-xs text-slate-500 font-medium">
          Total: <span className="font-bold text-slate-800">{list.data?.pagination?.total ?? 0}</span> records
        </div>
      </div>

      {/* Purchases Data Table */}
      <DataTable
        columns={[
          {
            key: 'purchase_no',
            header: isPoMode ? 'PO No' : 'GRN No',
            sortable: true,
            render: (r: any) => (
              <button
                type="button"
                onClick={() => nav(isPoMode ? `/procurement/general-orders/${r.id}` : `/procurement/general-purchases/${r.id}`)}
                className="font-mono text-[12px] font-bold text-brand-700 hover:underline text-left flex items-center gap-1.5"
              >
                {r.purchase_no}
                {r.purchase_type === 'EMERGENCY' && (
                  <span title="Emergency Direct Purchase" className="inline-flex text-rose-500">
                    <Zap size={13} className="fill-rose-500" />
                  </span>
                )}
              </button>
            ),
          },
          {
            key: 'purchase_date',
            header: 'Date',
            sortable: true,
            render: (r: any) => fmtDate(r.purchase_date),
          },
          {
            key: 'supplier_name',
            header: 'Supplier',
            render: (r: any) => (
              <span className="font-medium text-slate-800">{r.supplier_name || '—'}</span>
            ),
          },
          {
            key: 'purchase_type',
            header: 'Purchase Type',
            render: (r: any) => (
              <Badge tone={getPurchaseTypeTone(r.purchase_type)}>
                {humanize(r.purchase_type)}
              </Badge>
            ),
          },
          {
            key: 'supplier_inv_no',
            header: 'Supplier Bill / DC',
            render: (r: any) => (
              r.supplier_inv_no ? (
                <div className="text-xs">
                  <span className="font-mono font-medium text-slate-700">{r.supplier_inv_no}</span>
                  {r.supplier_inv_date && (
                    <div className="text-[10px] text-slate-400">{fmtDate(r.supplier_inv_date)}</div>
                  )}
                </div>
              ) : (
                <span className="text-slate-400 text-xs">—</span>
              )
            ),
          },
          {
            key: 'item_count',
            header: 'Items',
            align: 'center',
            render: (r: any) => (
              <span className="inline-flex items-center justify-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                {r.item_count || 0}
              </span>
            ),
          },
          {
            key: 'grand_total',
            header: 'Grand Total',
            align: 'right',
            sortable: true,
            render: (r: any) => (
              <span className="font-semibold text-slate-900 font-mono">
                {r.currency_code || 'INR'} {fmtDecimal(r.grand_total, 2)}
              </span>
            ),
          },
          {
            key: 'approval_state',
            header: 'State',
            render: (r: any) => <StatusBadge value={r.approval_state || 'DRAFT'} />,
          },
          {
            key: 'actions',
            header: '',
            align: 'right',
            render: (r: any) => (
              <button
                type="button"
                className="btn-secondary py-1 px-2.5 text-xs font-medium"
                onClick={() => nav(isPoMode ? `/procurement/general-orders/${r.id}` : `/procurement/general-purchases/${r.id}`)}
              >
                View
              </button>
            ),
          },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(r: any) => r.id}
        sort={sort}
        onSort={onSort}
        pagination={list.data?.pagination}
        onPage={setPage}
      />
    </>
  );
}
