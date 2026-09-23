import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import {
  GitBranch, Search, Filter, RefreshCw, Edit3, PackageCheck, Boxes, Download, X, AlertCircle,
} from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDecimal, fmtNumber, fmtDate } from '../../lib/format';
import { Badge, Modal, useDebounced } from '../../components/ui';
import { useToast } from '../../hooks/useToast';

interface YarnStockRow {
  id: number;
  grn_id: number;
  yarn_id: number;
  yarn_name: string | null;
  yarn_code: string | null;
  yarn_type: string | null;
  grn_yarn_type: string | null;
  count_str: string | null;
  lot_no: string | null;
  shade: string | null;
  color_name: string | null;
  received_qty: string | number;
  accepted_qty: string | number;
  rejected_qty: string | number | null;
  returned_qty: string | number;
  issued_qty: string | number;
  balance_qty: string | number;
  weight_kg: string | number | null;
  packs: number | null;
  uom_code: string | null;
  warehouse_id: number;
  warehouse_name: string | null;
  bin_id: number | null;
  location_bin: string | null;
  rack: string | null;
  grn_no: string;
  grn_date: string;
  po_no: string | null;
  so_no: string | null;
  supplier_name: string | null;
  internal_ir_no: string | null;
  style_id: number | null;
  style_code: string | null;
  style_name: string | null;
  qc_status: string;
  stock_status: string;
}

interface Facets {
  io_nos: string[];
  styles: { id: number; style_code: string; style_name: string }[];
}

interface Bin { id: number; bin_code: string; rack: string | null; warehouse_name: string }

const STOCK_STATUSES: { value: string; label: string }[] = [
  { value: 'AVAILABLE', label: 'Available' },
  { value: 'PARTIAL', label: 'Partly Issued' },
  { value: 'CLOSED', label: 'Closed (Fully Issued)' },
  { value: 'PENDING', label: 'Pending QC' },
  { value: 'HOLD', label: 'QC Hold' },
  { value: 'REJECTED', label: 'Rejected' },
];

const selectCls =
  'text-xs rounded-lg border border-slate-300 py-1.5 px-2.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500';

const num = (v: unknown) => Number(v) || 0;
const uom = (r: YarnStockRow) => r.uom_code || 'KG';

export default function YarnStockPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [qcFilter, setQcFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [ioFilter, setIoFilter] = useState('');
  const [styleFilter, setStyleFilter] = useState('');
  const debouncedSearch = useDebounced(search.trim());

  // Bin assignment modal
  const [editBatch, setEditBatch] = useState<YarnStockRow | null>(null);
  const [editBinId, setEditBinId] = useState<string>('');
  const [updating, setUpdating] = useState(false);

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (debouncedSearch) p.search = debouncedSearch;
    if (qcFilter) p.qc_status = qcFilter;
    if (statusFilter) p.stock_status = statusFilter;
    if (ioFilter) p.io_no = ioFilter;
    if (styleFilter) p.style_id = styleFilter;
    return p;
  }, [debouncedSearch, qcFilter, statusFilter, ioFilter, styleFilter]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['yarn-stock', params],
    queryFn: async () => http.get<{ data: YarnStockRow[]; facets: Facets }>('/yarn-stock', params),
  });
  const batches = data?.data ?? [];
  const facets: Facets = data?.facets ?? { io_nos: [], styles: [] };

  const binsQuery = useQuery({
    queryKey: ['yarn-stock-bins', editBatch?.id],
    enabled: !!editBatch,
    queryFn: async () => (await http.get<{ data: Bin[] }>(`/yarn-stock/${editBatch!.id}/bins`)).data,
  });

  const kpis = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let availableKg = 0;
    for (const b of batches) {
      byStatus[b.stock_status] = (byStatus[b.stock_status] ?? 0) + 1;
      if (['AVAILABLE', 'PARTIAL'].includes(b.stock_status)) availableKg += num(b.balance_qty);
    }
    return { lots: batches.length, availableKg, byStatus };
  }, [batches]);

  const totals = useMemo(() => batches.reduce(
    (t, b) => ({
      received: t.received + num(b.received_qty),
      accepted: t.accepted + num(b.accepted_qty),
      rejected: t.rejected + num(b.rejected_qty),
      issued: t.issued + num(b.issued_qty) + num(b.returned_qty),
      balance: t.balance + num(b.balance_qty),
      weight: t.weight + num(b.weight_kg),
    }),
    { received: 0, accepted: 0, rejected: 0, issued: 0, balance: 0, weight: 0 },
  ), [batches]);
  // Totals only make sense when every row shares one unit.
  const uoms = [...new Set(batches.map(uom))];
  const totalUom = uoms.length === 1 ? uoms[0] : null;

  const hasFilters = !!(search || qcFilter || statusFilter || ioFilter || styleFilter);
  const clearFilters = () => {
    setSearch(''); setQcFilter(''); setStatusFilter(''); setIoFilter(''); setStyleFilter('');
  };

  const handleOpenEdit = (batch: YarnStockRow) => {
    setEditBatch(batch);
    setEditBinId(batch.bin_id ? String(batch.bin_id) : '');
  };

  const handleSaveEdit = async () => {
    if (!editBatch) return;
    setUpdating(true);
    try {
      await http.post(`/yarn-stock/${editBatch.id}/bin`, { bin_id: editBinId ? Number(editBinId) : null });
      toast(`Bin updated for lot ${editBatch.lot_no || '#' + editBatch.id}`, 'success');
      setEditBatch(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update bin location', 'error');
    } finally {
      setUpdating(false);
    }
  };

  const exportExcel = () => {
    if (!batches.length) return;
    const rows = batches.map((b) => ({
      'Yarn Code': b.yarn_code ?? '',
      'Yarn Name': b.yarn_name ?? '',
      'Count': b.count_str ?? '',
      'Yarn Type': b.yarn_type ?? b.grn_yarn_type ?? '',
      'Lot No': b.lot_no ?? '',
      'Shade': b.shade ?? '',
      'Colour': b.color_name ?? '',
      'Internal Order No': b.internal_ir_no ?? '',
      'Style': b.style_code ?? '',
      'Style Name': b.style_name ?? '',
      'Sales Order': b.so_no ?? '',
      'UOM': uom(b),
      'Received Qty': num(b.received_qty),
      'Accepted Qty': num(b.accepted_qty),
      'Rejected Qty': num(b.rejected_qty),
      'Issued Qty': num(b.issued_qty),
      'Returned to Supplier': num(b.returned_qty),
      'Balance Qty': num(b.balance_qty),
      'Received Weight (KG)': b.weight_kg == null ? '' : num(b.weight_kg),
      'Warehouse': b.warehouse_name ?? '',
      'Bin': b.location_bin ?? '',
      'GRN No': b.grn_no,
      'GRN Date': b.grn_date ? String(b.grn_date).slice(0, 10) : '',
      'PO No': b.po_no ?? '',
      'Supplier': b.supplier_name ?? '',
      'QC Status': b.qc_status,
      'Stock Status': b.stock_status,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Yarn Stock');
    XLSX.writeFile(wb, `yarn-stock-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const getQcBadge = (st: string) => {
    switch (st) {
      case 'ACCEPTED':        return <Badge tone="green">ACCEPTED</Badge>;
      case 'PARTIAL_ACCEPTED':return <Badge tone="amber">PART-ACCEPTED</Badge>;
      case 'HOLD':            return <Badge tone="amber">HOLD</Badge>;
      case 'REJECTED':        return <Badge tone="red">REJECTED</Badge>;
      default:                return <Badge tone="slate">{st || 'PENDING'}</Badge>;
    }
  };

  const getStockBadge = (st: string) => {
    switch (st) {
      case 'AVAILABLE': return <Badge tone="green">AVAILABLE</Badge>;
      case 'PARTIAL':   return <Badge tone="blue">PARTLY ISSUED</Badge>;
      case 'CLOSED':    return <Badge tone="slate">CLOSED</Badge>;
      case 'REJECTED':  return <Badge tone="red">REJECTED</Badge>;
      case 'HOLD':      return <Badge tone="amber">QC HOLD</Badge>;
      case 'PENDING':   return <Badge tone="amber">PENDING QC</Badge>;
      default:          return <Badge tone="slate">{st}</Badge>;
    }
  };

  const errorMessage = error instanceof Error ? error.message : error ? 'Unable to load yarn stock' : null;

  return (
    <div className="space-y-5">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-2">
          <span className="p-2 rounded-lg bg-violet-100 text-violet-700">
            <GitBranch size={20} />
          </span>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Yarn Stock List</h1>
            <p className="text-xs text-slate-500">
              Lot-wise yarn stock — which Internal Order / Style it was bought for, where it sits, and what is left
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={exportExcel}
            disabled={!batches.length}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition disabled:opacity-50"
          >
            <Download size={14} className="text-violet-600" />
            <span>Export Excel</span>
          </button>
          <button
            onClick={() => nav('/procurement/yarn/orders')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <GitBranch size={14} className="text-violet-600" />
            <span>Yarn Orders</span>
          </button>
          <button
            onClick={() => nav('/procurement/yarn/grn')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 shadow-sm transition"
          >
            <PackageCheck size={14} className="text-violet-600" />
            <span>Yarn GRNs</span>
          </button>
          <button
            onClick={() => nav('/procurement/yarn/grn/new')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-lg bg-violet-600 hover:bg-violet-700 text-white shadow-sm transition"
          >
            <PackageCheck size={14} />
            <span>Inward Yarn</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Yarn Lots Listed</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{fmtNumber(kpis.lots)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">GRN lot lines {hasFilters ? '(filtered)' : ''}</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Available to Issue</div>
          <div className="text-2xl font-bold text-violet-600 mt-1">
            {fmtDecimal(kpis.availableKg)} <span className="text-sm font-semibold">{totalUom ?? 'KG'}</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">Balance of available + partly issued lots</div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Lots by Stock Status</div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {STOCK_STATUSES.filter((s) => kpis.byStatus[s.value]).map((s) => (
              <button key={s.value} onClick={() => setStatusFilter(statusFilter === s.value ? '' : s.value)}
                className={`text-[11px] px-2 py-0.5 rounded-full border ${statusFilter === s.value ? 'bg-violet-600 text-white border-violet-600' : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
                {s.label}: <strong>{kpis.byStatus[s.value]}</strong>
              </button>
            ))}
            {!kpis.lots && <span className="text-[11px] text-slate-400">—</span>}
          </div>
        </div>
        <div className="p-4 rounded-xl bg-white border border-slate-200/80 shadow-sm">
          <div className="text-xs font-medium text-slate-500">Accepted / Issued</div>
          <div className="text-lg font-bold text-emerald-600 mt-1">
            {fmtDecimal(totals.accepted)} <span className="text-xs text-slate-400">/ {fmtDecimal(totals.issued)} {totalUom ?? ''}</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">Issued includes purchase returns</div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col lg:flex-row gap-3 lg:items-center justify-between bg-white p-3 rounded-xl border border-slate-200/80 shadow-sm">
        <div className="relative w-full lg:w-80">
          <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search yarn, lot, shade, GRN, PO, IO No, style, supplier, bin..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full lg:w-auto flex-wrap">
          <Filter size={15} className="text-slate-400" />
          <select value={ioFilter} onChange={(e) => setIoFilter(e.target.value)} className={selectCls} title="Internal Order No">
            <option value="">All IO No</option>
            {facets.io_nos.map((io) => <option key={io} value={io}>{io}</option>)}
          </select>
          <select value={styleFilter} onChange={(e) => setStyleFilter(e.target.value)} className={selectCls} title="Style">
            <option value="">All Styles</option>
            {facets.styles.map((s) => (
              <option key={s.id} value={String(s.id)}>{s.style_code}{s.style_name ? ` — ${s.style_name}` : ''}</option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={selectCls}>
            <option value="">All Stock Status</option>
            {STOCK_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select value={qcFilter} onChange={(e) => setQcFilter(e.target.value)} className={selectCls}>
            <option value="">All QC Status</option>
            <option value="ACCEPTED">Accepted</option>
            <option value="PARTIAL_ACCEPTED">Partial Accepted</option>
            <option value="HOLD">Hold</option>
            <option value="REJECTED">Rejected</option>
            <option value="PENDING">Pending</option>
          </select>
          {hasFilters && (
            <button onClick={clearFilters} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 px-2 py-1">
              <X size={13} /> Clear
            </button>
          )}
          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-600 transition"
            title="Refresh list"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-50/80 text-slate-600 font-semibold border-b border-slate-200">
                <th className="py-3 px-4">Yarn Item</th>
                <th className="py-3 px-3">Lot No / Shade</th>
                <th className="py-3 px-3">Count / Type</th>
                <th className="py-3 px-3">Internal Order / Style</th>
                <th className="py-3 px-3 text-right">Received</th>
                <th className="py-3 px-3 text-right">Accepted</th>
                <th className="py-3 px-3 text-right">Rejected</th>
                <th className="py-3 px-3 text-right">Issued</th>
                <th className="py-3 px-3 text-right">Balance</th>
                <th className="py-3 px-3 text-right">Weight</th>
                <th className="py-3 px-3">Warehouse / Bin</th>
                <th className="py-3 px-3">GRN / PO / Supplier</th>
                <th className="py-3 px-3 text-center">QC</th>
                <th className="py-3 px-3 text-center">Stock Status</th>
                <th className="py-3 px-4 text-center">Bin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {isLoading ? (
                <tr>
                  <td colSpan={15} className="py-10 text-center text-slate-400">Loading yarn stock...</td>
                </tr>
              ) : errorMessage ? (
                <tr>
                  <td colSpan={15} className="py-12 text-center">
                    <AlertCircle size={32} className="mx-auto text-red-400 mb-2" />
                    <p className="text-sm font-medium text-slate-700">Unable to load yarn stock</p>
                    <p className="text-xs text-red-600 mt-1">{errorMessage}</p>
                    <button onClick={() => refetch()} className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Try again</button>
                  </td>
                </tr>
              ) : batches.length === 0 ? (
                <tr>
                  <td colSpan={15} className="py-12 text-center text-slate-400">
                    <Boxes size={36} className="mx-auto text-slate-300 mb-2" />
                    <p className="text-sm font-medium text-slate-600">No yarn lots found</p>
                    <p className="text-xs text-slate-400 mt-1">
                      {hasFilters ? 'No lot matches these filters.' : 'Yarn stock is created when Yarn GRNs are inwarded.'}
                    </p>
                    {hasFilters && (
                      <button onClick={clearFilters} className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700">Clear filters</button>
                    )}
                  </td>
                </tr>
              ) : (
                batches.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50/70 transition">
                    <td className="py-3 px-4">
                      <div className="font-semibold text-violet-800">{b.yarn_name || 'Yarn Item'}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{b.yarn_code || ''}</div>
                    </td>
                    <td className="py-3 px-3">
                      <div className="font-mono font-bold text-slate-800 text-[11px]">{b.lot_no || '—'}</div>
                      {(b.shade || b.color_name) && (
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {[b.shade, b.color_name].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-3 text-[11px] text-slate-600">
                      <div className="font-medium">{b.count_str || '—'}</div>
                      <div className="text-[10px] text-slate-400">{b.yarn_type || b.grn_yarn_type || ''}</div>
                    </td>
                    <td className="py-3 px-3 text-[11px]">
                      {b.internal_ir_no ? (
                        <button onClick={() => setIoFilter(b.internal_ir_no!)} className="font-mono font-semibold text-indigo-700 hover:underline" title="Filter by this IO">
                          {b.internal_ir_no}
                        </button>
                      ) : (
                        <span className="text-slate-300">No IO</span>
                      )}
                      {b.style_code && (
                        <div className="text-[10px] text-slate-500 mt-0.5" title={b.style_name ?? ''}>{b.style_code}</div>
                      )}
                      {b.so_no && <div className="text-[10px] text-slate-400">{b.so_no}</div>}
                    </td>
                    <td className="py-3 px-3 text-right whitespace-nowrap">{fmtDecimal(b.received_qty, 3)} <span className="text-[10px] text-slate-400">{uom(b)}</span></td>
                    <td className="py-3 px-3 text-right whitespace-nowrap text-emerald-700">{fmtDecimal(b.accepted_qty, 3)} <span className="text-[10px] text-slate-400">{uom(b)}</span></td>
                    <td className="py-3 px-3 text-right whitespace-nowrap text-red-600">{num(b.rejected_qty) ? <>{fmtDecimal(b.rejected_qty, 3)} <span className="text-[10px] text-slate-400">{uom(b)}</span></> : '—'}</td>
                    <td className="py-3 px-3 text-right whitespace-nowrap text-slate-600" title={num(b.returned_qty) ? `Includes ${fmtDecimal(b.returned_qty, 3)} returned to supplier` : undefined}>
                      {num(b.issued_qty) + num(b.returned_qty) ? <>{fmtDecimal(num(b.issued_qty) + num(b.returned_qty), 3)} <span className="text-[10px] text-slate-400">{uom(b)}</span></> : '—'}
                    </td>
                    <td className="py-3 px-3 text-right whitespace-nowrap font-bold text-violet-700">{fmtDecimal(b.balance_qty, 3)} <span className="text-[10px] font-normal text-slate-400">{uom(b)}</span></td>
                    <td className="py-3 px-3 text-right whitespace-nowrap text-indigo-700">
                      {b.weight_kg != null ? `${fmtDecimal(b.weight_kg, 3)} KG` : '—'}
                      {b.packs ? <div className="text-[10px] text-slate-400">{b.packs} bags</div> : null}
                    </td>
                    <td className="py-3 px-3">
                      <div className="text-slate-800 font-medium">{b.warehouse_name || '—'}</div>
                      <span className={`font-mono text-[10px] px-1 py-0.5 rounded ${b.location_bin ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-700'}`}>
                        Bin: {b.location_bin || 'Unassigned'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-[11px]">
                      <button onClick={() => nav(`/procurement/yarn/grn/${b.grn_id}`)} className="text-violet-700 hover:underline font-medium">
                        {b.grn_no}
                      </button>
                      <div className="text-slate-400 text-[10px]">{fmtDate(b.grn_date)}{b.po_no ? ` · ${b.po_no}` : ''}</div>
                      {b.supplier_name && <div className="text-slate-500 text-[10px] truncate max-w-[160px]">{b.supplier_name}</div>}
                    </td>
                    <td className="py-3 px-3 text-center">{getQcBadge(b.qc_status)}</td>
                    <td className="py-3 px-3 text-center">{getStockBadge(b.stock_status)}</td>
                    <td className="py-3 px-4 text-center">
                      <button
                        onClick={() => handleOpenEdit(b)}
                        className="p-1 text-slate-500 hover:text-violet-700 hover:bg-violet-50 rounded transition"
                        title="Assign bin"
                      >
                        <Edit3 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {!isLoading && !errorMessage && batches.length > 0 && (
              <tfoot>
                <tr className="bg-slate-50 font-semibold text-slate-800 border-t-2 border-slate-200">
                  <td className="py-2.5 px-4" colSpan={4}>
                    Total — {fmtNumber(batches.length)} lot{batches.length === 1 ? '' : 's'}
                    {!totalUom && <span className="ml-2 text-[10px] font-normal text-amber-700">(mixed units — totals are indicative)</span>}
                  </td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">{fmtDecimal(totals.received, 3)} {totalUom}</td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">{fmtDecimal(totals.accepted, 3)} {totalUom}</td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">{fmtDecimal(totals.rejected, 3)} {totalUom}</td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">{fmtDecimal(totals.issued, 3)} {totalUom}</td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap text-violet-700">{fmtDecimal(totals.balance, 3)} {totalUom}</td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">{fmtDecimal(totals.weight, 3)} KG</td>
                  <td colSpan={5} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Bin assignment modal */}
      {editBatch && (
        <Modal
          title={`Assign Bin — Lot ${editBatch.lot_no || '#' + editBatch.id}`}
          open={!!editBatch}
          onClose={() => setEditBatch(null)}
          size="sm"
          footer={
            <>
              <button onClick={() => setEditBatch(null)} className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700">
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={updating || binsQuery.isLoading}
                className="px-3.5 py-1.5 text-xs rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-medium disabled:opacity-50"
              >
                {updating ? 'Saving...' : 'Save Bin'}
              </button>
            </>
          }
        >
          <div className="space-y-4 text-xs">
            <div className="p-3 bg-slate-50 rounded-lg text-slate-700 grid grid-cols-2 gap-2 text-[11px]">
              <div>Yarn: <strong>{editBatch.yarn_name}</strong></div>
              <div>Count: <strong>{editBatch.count_str || '—'}</strong></div>
              <div>GRN: <strong>{editBatch.grn_no}</strong></div>
              <div>Balance: <strong>{fmtDecimal(editBatch.balance_qty, 3)} {uom(editBatch)}</strong></div>
              <div className="col-span-2">Warehouse: <strong>{editBatch.warehouse_name || '—'}</strong></div>
              {editBatch.internal_ir_no && (
                <div className="col-span-2">
                  Internal Order: <strong className="text-indigo-700">{editBatch.internal_ir_no}</strong>
                  {editBatch.style_code && <span className="ml-2 text-slate-500">({editBatch.style_code})</span>}
                </div>
              )}
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Bin / Rack</label>
              {binsQuery.isLoading ? (
                <div className="text-slate-400">Loading bins…</div>
              ) : binsQuery.error ? (
                <div className="text-red-600">{binsQuery.error instanceof Error ? binsQuery.error.message : 'Unable to load bins'}</div>
              ) : (binsQuery.data ?? []).length === 0 ? (
                <div className="text-amber-700 bg-amber-50 rounded p-2">
                  No active bins are set up for {editBatch.warehouse_name || 'this warehouse'}. Add them under Masters → Bins &amp; Racks.
                </div>
              ) : (
                <select value={editBinId} onChange={(e) => setEditBinId(e.target.value)} className={`${selectCls} w-full`}>
                  <option value="">— Unassigned —</option>
                  {(binsQuery.data ?? []).map((bin) => (
                    <option key={bin.id} value={String(bin.id)}>
                      {bin.bin_code}{bin.rack ? ` (Rack ${bin.rack})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
