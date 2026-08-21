import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useList, useListState } from '../../hooks/useResource';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, Select, Badge, useDebounced,
} from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { api, tokenStore } from '../../lib/api';
import { useToast } from '../../hooks/useToast';

/* ---------------------------------------------------------- Reports hub */
export function ReportsPage() {
  const toast = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);

  const REPORTS = [
    { key: 'order-status', label: 'Order Status Report', desc: 'All open sales orders with production and shipment progress', icon: '📦' },
    { key: 'production-efficiency', label: 'Production Efficiency', desc: 'Input vs output vs rejection by stage and production order', icon: '🏭' },
    { key: 'stock-summary', label: 'Stock Summary', desc: 'Current stock on hand by warehouse and material type', icon: '📊' },
    { key: 'buyer-wise-sales', label: 'Buyer-wise Sales', desc: 'Revenue, quantity and shipment summary grouped by buyer', icon: '🌍' },
    { key: 'mrp-requirements', label: 'MRP Requirements', desc: 'Material requirements vs current stock and on-order', icon: '⚙️' },
    { key: 'qc-defects', label: 'QC Defect Analysis', desc: 'Defect frequency and rejection rates by type and stage', icon: '🔍' },
    { key: 'ta-milestone', label: 'T&A Milestone Tracker', desc: 'On-track vs delayed milestones by order and merchandiser', icon: '📅' },
    { key: 'export-realisation', label: 'Export Realisation', desc: 'BL value vs LC realisation and RODTEP/drawback status', icon: '💰' },
  ];

  const handleExport = async (reportKey: string, label: string) => {
    setDownloading(reportKey);
    try {
      const response = await api.get(`/reports/${reportKey}`, {
        params: { format: 'csv', token: tokenStore.access },
        responseType: 'blob',
      });
      const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${reportKey}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast(`${label} exported successfully`);
    } catch (err: any) {
      toast(`Export failed: ${err.message || 'Error downloading file'}`, 'error');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <>
      <PageHeader title="Reports" subtitle="Operational and management reports across all modules" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {REPORTS.map((r) => {
          const isBusy = downloading === r.key;
          return (
            <div key={r.key} className="card group cursor-pointer p-5 transition-shadow hover:shadow-md"
              onClick={() => !isBusy && void handleExport(r.key, r.label)}>
              <div className="mb-3 text-3xl">{r.icon}</div>
              <h3 className="text-[14px] font-semibold text-slate-800 group-hover:text-brand-700">{r.label}</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-500">{r.desc}</p>
              <div className="mt-3 flex items-center gap-1.5 text-[11.5px] font-medium text-brand-600">
                {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                <span>{isBusy ? 'Generating CSV…' : 'Export CSV'}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---------------------------------------------------------- Audit trail */
export function AuditPage() {
  const { page, setPage, search, setSearch } = useListState({ key: 'id', dir: 'desc' });
  const debounced = useDebounced(search);
  const [table, setTable] = useState('');
  const [action, setAction] = useState('');

  const list = useList<any>('reports/audit-log', {
    page, pageSize: 50, q: debounced || undefined,
    table_name: table || undefined, action: action || undefined,
  });

  const ACTIONS = ['INSERT', 'UPDATE', 'DELETE'];

  return (
    <>
      <PageHeader title="Audit Trail" subtitle="Immutable log of every data change across the system" />

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search user, table or record ID…" />
        <Select placeholder="All tables" value={table} onChange={(e) => { setTable(e.target.value); setPage(1); }}
          options={[
            'trx_sales_order', 'mst_style', 'trx_production_order', 'trx_mrp_run',
            'trx_material_issue', 'mst_party', 'trx_voucher', 'trx_export_invoice',
            'trx_shipment', 'trx_qc_inspection',
          ].map((v) => ({ value: v, label: v }))} />
        <Select placeholder="All actions" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
          options={ACTIONS.map((v) => ({ value: v, label: v }))} />
      </div>

      <DataTable
        columns={[
          { key: 'id', header: '#', align: 'right', width: 'w-16',
            render: (r: any) => <span className="tabular-nums text-slate-400">{r.id}</span> },
          { key: 'action', header: 'Action', width: 'w-20',
            render: (r: any) => {
              const tone = r.action === 'INSERT' ? 'green' : r.action === 'DELETE' ? 'red' : 'amber';
              return <Badge tone={tone}>{r.action}</Badge>;
            } },
          { key: 'table_name', header: 'Table',
            render: (r: any) => <span className="font-mono text-[11.5px] text-slate-600">{r.table_name}</span> },
          { key: 'record_id', header: 'Record', align: 'right',
            render: (r: any) => <span className="font-mono text-[12px] text-slate-500">#{r.record_id}</span> },
          { key: 'changed_by_name', header: 'Changed by',
            render: (r: any) => <span className="font-medium text-slate-700">{r.changed_by_name}</span> },
          { key: 'changed_at', header: 'Timestamp', sortable: true,
            render: (r: any) => <span className="tabular-nums text-[12px] text-slate-500">{fmtDateTime(r.changed_at)}</span> },
          { key: 'old_values', header: 'Old values', className: 'max-w-[280px]',
            render: (r: any) => r.old_values
              ? <code className="block max-w-[280px] truncate text-[10.5px] text-slate-400">{r.old_values}</code>
              : <span className="text-slate-300">—</span> },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No audit entries yet"
        emptyMessage="Every INSERT, UPDATE and DELETE will appear here." />
    </>
  );
}
