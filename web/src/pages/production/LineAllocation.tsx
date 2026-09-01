import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, today } from '../../lib/format';

export function LineAllocationsPage() {
  return <CrudPage
    path="line-allocations" title="Line Allocation" permission="PRODUCTION" singular="Allocation"
    subtitle="Allocate styles and orders to sewing lines with start/end dates"
    defaultSort={{ key: 'allocation_date', dir: 'desc' }}
    columns={[
      { key: 'allocation_no', header: 'Alloc no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.allocation_no}</span> },
      { key: 'allocation_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.allocation_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'style_code', header: 'Style' },
      { key: 'color_name', header: 'Colour' },
      { key: 'line_name', header: 'Line', render: (r: any) => <Badge tone="indigo">{r.line_name}</Badge> },
      { key: 'allocated_qty', header: 'Qty', align: 'right', render: (r: any) => <span className="font-medium">{fmtNumber(r.allocated_qty)}</span> },
      { key: 'start_date', header: 'Start', render: (r: any) => fmtDate(r.start_date) },
      { key: 'end_date', header: 'End', render: (r: any) => fmtDate(r.end_date) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'style_id', label: 'Style', lookup: 'styles' },
      { name: 'line_id', label: 'Line', lookup: 'sewing-lines' },
    ]}
    fields={[
      { name: 'allocation_no', label: 'Allocation no', hint: 'Blank to auto-generate' },
      { name: 'allocation_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'style_id', label: 'Style', lookup: 'styles' },
      { name: 'color_id', label: 'Colour', lookup: 'colors' },
      { name: 'line_id', label: 'Sewing line', required: true, lookup: 'sewing-lines' },
      { name: 'allocated_qty', label: 'Allocated qty', type: 'number', required: true },
      { name: 'start_date', label: 'Start date', type: 'date' },
      { name: 'end_date', label: 'End date', type: 'date' },
      { name: 'status_id', label: 'Status', statusDomain: 'LINE_ALLOC' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

export function SewingOperationsPage() {
  return <CrudPage
    path="sewing-operations" title="Sewing Operations" permission="PRODUCTION" singular="Operation"
    subtitle="Track output per sewing operation (shoulder, side seam, sleeve, etc.)"
    defaultSort={{ key: 'operation_date', dir: 'desc' }}
    columns={[
      { key: 'operation_no', header: 'Op no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.operation_no}</span> },
      { key: 'operation_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.operation_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'operation_name', header: 'Operation', render: (r: any) => <Badge tone="violet">{r.operation_name}</Badge> },
      { key: 'line_name', header: 'Line' },
      { key: 'plan_qty', header: 'Plan', align: 'right', render: (r: any) => fmtNumber(r.plan_qty) },
      { key: 'actual_qty', header: 'Actual', align: 'right',
        render: (r: any) => <span className="font-medium text-emerald-700">{fmtNumber(r.actual_qty)}</span> },
      { key: 'rejected_qty', header: 'Reject', align: 'right',
        render: (r: any) => Number(r.rejected_qty) > 0 ? <span className="text-red-600">{fmtNumber(r.rejected_qty)}</span> : '—' },
      { key: 'rework_qty', header: 'Rework', align: 'right',
        render: (r: any) => Number(r.rework_qty) > 0 ? <span className="text-amber-600">{fmtNumber(r.rework_qty)}</span> : '—' },
      { key: 'wip_qty', header: 'WIP', align: 'right',
        render: (r: any) => Number(r.wip_qty) > 0 ? <span className="font-medium text-brand-600">{fmtNumber(r.wip_qty)}</span> : '—' },
      { key: 'operator_name', header: 'Operator' },
    ]}
    filters={[
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'line_id', label: 'Line', lookup: 'sewing-lines' },
      { name: 'operation_id', label: 'Operation', lookup: 'sewing-operation-masters' },
    ]}
    fields={[
      { name: 'operation_no', label: 'Operation no', hint: 'Blank to auto-generate' },
      { name: 'operation_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'line_id', label: 'Sewing line', lookup: 'sewing-lines' },
      { name: 'operation_id', label: 'Operation', required: true, lookup: 'sewing-operation-masters' },
      { name: 'plan_qty', label: 'Plan qty', type: 'number' },
      { name: 'actual_qty', label: 'Actual qty', type: 'number' },
      { name: 'rework_qty', label: 'Rework qty', type: 'number' },
      { name: 'rejected_qty', label: 'Rejected qty', type: 'number' },
      { name: 'wip_qty', label: 'WIP qty', type: 'number', hint: 'Plan minus actual' },
      { name: 'operator_name', label: 'Operator name' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROCESS' },
    ]} />;
}
