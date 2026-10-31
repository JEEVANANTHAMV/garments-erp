import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useList, useListState } from '../../hooks/useResource';
import { DataTable } from '../../components/DataTable';
import {
  PageHeader, SearchInput, Select, Badge, Modal, useDebounced,
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
              <h3 className="text-body-lg font-semibold text-ink group-hover:text-brand-700">{r.label}</h3>
              <p className="mt-1.5 text-body leading-relaxed text-ink-secondary">{r.desc}</p>
              <div className="mt-3 flex items-center gap-1.5 text-small font-medium text-brand-600">
                {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                <span>{isBusy ? 'Generating CSV…' : 'Export CSV'}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Client's own report set (Fashion Knits business-process tracker, 14-Oct-2026) — kept separate below the defaults */}
      <div className="mb-3 mt-8 flex items-end justify-between border-b border-surface-border pb-1.5" id="client-reports">
        <div>
          <h2 className="text-small font-semibold uppercase tracking-wider text-ink-secondary">Client reports</h2>
          <p className="text-small text-ink-muted">In the formats from the business-process sheet — filters, totals, Excel export and drill-down to the entry</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {CLIENT_SETS.map((c) => (
          <Link key={c.to} to={c.to} className="card group p-5 transition-shadow hover:shadow-md">
            <h3 className="text-body-lg font-semibold text-ink group-hover:text-brand-700">{c.label}</h3>
            <p className="mt-1.5 text-body leading-relaxed text-ink-secondary">{c.reports.join(' · ')}</p>
            <div className="mt-3 text-small font-medium text-brand-600">Open reports →</div>
          </Link>
        ))}
      </div>
    </>
  );
}

const CLIENT_SETS = [
  {
    to: '/reports/client-a', label: 'Orders, budget, production & logistics',
    reports: ['Orders in hand', 'Order status', 'Order completion (OCR)', 'Budget sheet / Budget vs actuals', 'Consolidated budget vs actuals',
      'Production output', 'Invoice made despatch pending', 'Orders closed / cancelled', 'T&A status', 'Despatch – shipping bill pending', 'Master chart – exports'],
  },
  {
    to: '/reports/client-b', label: 'Purchase, stores, gate, bills & users',
    reports: ['GR / IR', 'PO vs GRN vs bill', 'Our DC vs gate outward', 'DC vs inward vs GRN', 'Gate inward – GRN pending', 'Consolidated stock statement',
      'Opening stock', 'Bill tracker', 'Direct bills', 'User rights', 'Userwise log'],
  },
];

/* ---------------------------------------------------------- Audit trail */

export function AuditPage() {
  const { page, setPage, search, setSearch } = useListState({ key: 'id', dir: 'desc' });
  const debounced = useDebounced(search);
  const [table, setTable] = useState('');
  const [action, setAction] = useState('');
  const [inspectRow, setInspectRow] = useState<any | null>(null);

  const list = useList<any>('reports/audit-log', {
    page, pageSize: 50, q: debounced || undefined,
    table_name: table || undefined, action: action || undefined,
  });

  const ACTIONS = ['INSERT', 'UPDATE', 'DELETE'];

  const formatJson = (val: any) => {
    if (!val) return '—';
    if (typeof val === 'object') {
      try {
        return JSON.stringify(val, null, 2);
      } catch {
        return String(val);
      }
    }
    try {
      const parsed = JSON.parse(val);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(val);
    }
  };

  const previewJson = (val: any) => {
    if (!val) return '—';
    if (typeof val === 'object') {
      try {
        return JSON.stringify(val);
      } catch {
        return String(val);
      }
    }
    return String(val);
  };

  return (
    <>
      <PageHeader title="Audit Trail" subtitle="Immutable log of every data change across the system" />

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search user, table or record ID…" />
        <Select placeholder="All tables" value={table} onChange={(e) => { setTable(e.target.value); setPage(1); }}
          options={[
            'trx_sales_order', 'mst_style', 'trx_production_order', 'trx_mrp_run',
            'trx_material_issue', 'mst_party', 'trx_voucher', 'trx_export_invoice',
            'trx_shipment', 'trx_qc_inspection', 'trx_jobwork_challan', 'trx_jobwork_receipt',
            'trx_jobwork_in', 'trx_daily_production_plan', 'trx_daily_output',
            'trx_sewing_operation', 'trx_line_allocation', 'trx_supplier_bill',
            'trx_purchase_return', 'trx_stock_transfer', 'trx_fg_receipt', 'trx_production_cost',
          ].map((v) => ({ value: v, label: v }))} />
        <Select placeholder="All actions" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}
          options={ACTIONS.map((v) => ({ value: v, label: v }))} />
      </div>

      <DataTable
        columns={[
          { key: 'id', header: '#', align: 'right', width: 'w-16',
            render: (r: any) => <span className="tabular-nums text-ink-muted">{r.id}</span> },
          { key: 'action', header: 'Action', width: 'w-20',
            render: (r: any) => {
              const tone = r.action === 'INSERT' ? 'green' : r.action === 'DELETE' ? 'red' : 'amber';
              return <Badge tone={tone}>{r.action}</Badge>;
            } },
          { key: 'table_name', header: 'Table',
            render: (r: any) => <span className="tabular-nums text-small text-ink-secondary">{r.table_name}</span> },
          { key: 'record_id', header: 'Record', align: 'right',
            render: (r: any) => <span className="tabular-nums text-small text-ink-secondary">#{r.record_id}</span> },
          { key: 'changed_by_name', header: 'Changed by',
            render: (r: any) => <span className="font-medium text-ink">{r.changed_by_name || `User #${r.changed_by ?? '?'}`}</span> },
          { key: 'changed_at', header: 'Timestamp', sortable: true,
            render: (r: any) => <span className="tabular-nums text-small text-ink-secondary">{fmtDateTime(r.changed_at)}</span> },
          { key: 'details', header: 'Snapshot Preview', className: 'max-w-[280px]',
            render: (r: any) => {
              const text = r.new_values ? previewJson(r.new_values) : (r.old_values ? previewJson(r.old_values) : '—');
              return (
                <code className="block max-w-[280px] truncate text-caption text-ink-secondary">
                  {text}
                </code>
              );
            } },
        ]}
        rows={list.data?.data ?? []}
        loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
        rowKey={(r) => r.id}
        onRowClick={(r) => setInspectRow(r)}
        pagination={list.data?.pagination} onPage={setPage}
        emptyTitle="No audit entries yet"
        emptyMessage="Every INSERT, UPDATE and DELETE will appear here." />

      {inspectRow && (
        <Modal
          open={!!inspectRow}
          onClose={() => setInspectRow(null)}
          title={`Audit entry #${inspectRow.id}`}
          subtitle={`${inspectRow.action} on ${inspectRow.table_name} (record #${inspectRow.record_id})`}
          size="lg"
          footer={<button className="btn-secondary" onClick={() => setInspectRow(null)}>Close</button>}>
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-surface-border bg-surface-muted p-3 text-small">
              <div>
                <span className="font-semibold text-ink-secondary">Changed By:</span>{' '}
                <span className="text-ink">{inspectRow.changed_by_name || `User #${inspectRow.changed_by}`}</span>
              </div>
              <div>
                <span className="font-semibold text-ink-secondary">IP Address:</span>{' '}
                <span className="tabular-nums text-ink">{inspectRow.ip_address || '—'}</span>
              </div>
              <div>
                <span className="font-semibold text-ink-secondary">Timestamp:</span>{' '}
                <span className="text-ink">{fmtDateTime(inspectRow.changed_at)}</span>
              </div>
              <div>
                <span className="font-semibold text-ink-secondary">Action:</span>{' '}
                <Badge tone={inspectRow.action === 'INSERT' ? 'green' : inspectRow.action === 'DELETE' ? 'red' : 'amber'}>
                  {inspectRow.action}
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {inspectRow.old_values && (
                <div>
                  <h4 className="mb-2 border-b border-surface-divider pb-1.5 text-small font-semibold uppercase tracking-wider text-ink-secondary">Previous Values (Before)</h4>
                  <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-caption leading-relaxed text-slate-200">
                    {formatJson(inspectRow.old_values)}
                  </pre>
                </div>
              )}
              {inspectRow.new_values && (
                <div className={inspectRow.old_values ? '' : 'lg:col-span-2'}>
                  <h4 className="mb-2 border-b border-surface-divider pb-1.5 text-small font-semibold uppercase tracking-wider text-ink-secondary">New Values (After)</h4>
                  <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-caption leading-relaxed text-emerald-300">
                    {formatJson(inspectRow.new_values)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
