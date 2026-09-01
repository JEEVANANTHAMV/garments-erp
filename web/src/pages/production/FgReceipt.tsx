import { CrudPage } from '../../components/CrudPage';
import { StatusBadge } from '../../components/ui';
import { fmtDate, fmtNumber, humanize, today } from '../../lib/format';

export function FgReceiptsPage() {
  const STATES = ['DRAFT', 'RECEIVED', 'CONFIRMED', 'CANCELLED'];

  return (
    <CrudPage
      path="fg-receipts"
      title="Finished Goods Receipts"
      permission="PRODUCTION"
      singular="FG Receipt"
      subtitle="Transfer and receipt of packed garments into FG Warehouse"
      defaultSort={{ key: 'receipt_date', dir: 'desc' }}
      columns={[
        {
          key: 'fg_receipt_no',
          header: 'Receipt no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.fg_receipt_no}</span>
          ),
        },
        { key: 'receipt_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.receipt_date) },
        { key: 'po_prod_no', header: 'Work order' },
        { key: 'so_no', header: 'Sales order' },
        { key: 'warehouse_name', header: 'FG Warehouse' },
        {
          key: 'total_qty',
          header: 'Total Qty',
          align: 'right',
          render: (r: any) => <span className="font-medium text-emerald-700">{fmtNumber(r.total_qty)}</span>,
        },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
        { name: 'so_id', label: 'Sales order', lookup: 'sales-orders' },
        { name: 'warehouse_id', label: 'Warehouse', lookup: 'warehouses' },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'fg_receipt_no', label: 'Receipt no', hint: 'Blank to auto-generate' },
        { name: 'receipt_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
        { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
        { name: 'so_id', label: 'Sales order', lookup: 'sales-orders' },
        { name: 'packing_id', label: 'Packing list reference', lookup: 'packings' },
        { name: 'qc_id', label: 'Final QC inspection', lookup: 'qc-inspections' },
        { name: 'warehouse_id', label: 'FG Warehouse', required: true, lookup: 'warehouses' },
        { name: 'total_qty', label: 'Total quantity (pcs)', type: 'number', required: true },
        {
          name: 'status',
          label: 'Status',
          options: STATES.map((v) => ({ value: v, label: humanize(v) })),
          defaultValue: 'DRAFT',
        },
        { name: 'remarks', label: 'Remarks', type: 'textarea' },
      ]}
    />
  );
}
