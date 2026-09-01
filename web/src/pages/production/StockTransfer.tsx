import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtDecimal, humanize, today } from '../../lib/format';

export function StockTransfersPage() {
  const TYPES = ['INTER_STORE', 'FLOOR_TRANSFER', 'UNIT_TRANSFER', 'REJECTION_MOVE'];
  const STATES = ['DRAFT', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'];

  return (
    <CrudPage
      path="stock-transfers"
      title="Stock Transfers"
      permission="INVENTORY"
      singular="Transfer"
      subtitle="Inter-warehouse and shopfloor material movements"
      defaultSort={{ key: 'transfer_date', dir: 'desc' }}
      columns={[
        {
          key: 'transfer_no',
          header: 'Transfer no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.transfer_no}</span>
          ),
        },
        { key: 'transfer_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.transfer_date) },
        { key: 'from_warehouse_name', header: 'From Warehouse' },
        { key: 'to_warehouse_name', header: 'To Warehouse' },
        {
          key: 'transfer_type',
          header: 'Type',
          render: (r: any) => <Badge tone="slate">{humanize(r.transfer_type)}</Badge>,
        },
        { key: 'po_prod_no', header: 'Work order' },
        {
          key: 'total_qty',
          header: 'Total Qty',
          align: 'right',
          render: (r: any) => fmtDecimal(r.total_qty, 2),
        },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'from_warehouse', label: 'From warehouse', lookup: 'warehouses' },
        { name: 'to_warehouse', label: 'To warehouse', lookup: 'warehouses' },
        { name: 'transfer_type', label: 'Type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'transfer_no', label: 'Transfer no', hint: 'Blank to auto-generate' },
        { name: 'transfer_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
        { name: 'from_warehouse', label: 'From warehouse', required: true, lookup: 'warehouses' },
        { name: 'to_warehouse', label: 'To warehouse', required: true, lookup: 'warehouses' },
        {
          name: 'transfer_type',
          label: 'Transfer type',
          options: TYPES.map((v) => ({ value: v, label: humanize(v) })),
          defaultValue: 'INTER_STORE',
        },
        { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
        { name: 'total_qty', label: 'Total quantity', type: 'number' },
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
