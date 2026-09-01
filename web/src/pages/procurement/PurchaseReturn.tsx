import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtDecimal, humanize, today } from '../../lib/format';

export function PurchaseReturnsPage() {
  const REASONS = ['QUALITY_REJECT', 'EXCESS', 'WRONG_MATERIAL', 'DAMAGED', 'OTHER'];
  const STATES = ['DRAFT', 'APPROVED', 'DISPATCHED', 'ACKNOWLEDGED', 'CLOSED'];

  return (
    <CrudPage
      path="purchase-returns"
      title="Purchase Returns"
      permission="PURCHASE"
      singular="Purchase Return"
      subtitle="Physical returns of rejected or excess material back to suppliers"
      defaultSort={{ key: 'return_date', dir: 'desc' }}
      columns={[
        {
          key: 'return_no',
          header: 'Return no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.return_no}</span>
          ),
        },
        { key: 'return_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.return_date) },
        { key: 'grn_no', header: 'GRN no' },
        { key: 'supplier_name', header: 'Supplier' },
        {
          key: 'return_reason',
          header: 'Reason',
          render: (r: any) => <Badge tone="red">{humanize(r.return_reason)}</Badge>,
        },
        {
          key: 'total_qty',
          header: 'Total Qty',
          align: 'right',
          render: (r: any) => fmtDecimal(r.total_qty, 2),
        },
        {
          key: 'total_amount',
          header: 'Amount',
          align: 'right',
          render: (r: any) => fmtDecimal(r.total_amount, 2),
        },
        { key: 'warehouse_name', header: 'Warehouse' },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'grn_id', label: 'GRN', lookup: 'grns' },
        { name: 'supplier_id', label: 'Supplier', lookup: 'suppliers' },
        { name: 'return_reason', label: 'Reason', options: REASONS.map((v) => ({ value: v, label: humanize(v) })) },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'return_no', label: 'Return no', hint: 'Blank to auto-generate' },
        { name: 'return_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
        { name: 'grn_id', label: 'GRN reference', required: true, lookup: 'grns' },
        { name: 'supplier_id', label: 'Supplier', required: true, lookup: 'suppliers' },
        { name: 'warehouse_id', label: 'Warehouse (Return from)', required: true, lookup: 'warehouses' },
        { name: 'gate_outward_id', label: 'Outward gate pass', lookup: 'gate-outwards' },
        {
          name: 'return_reason',
          label: 'Return reason',
          options: REASONS.map((v) => ({ value: v, label: humanize(v) })),
          defaultValue: 'QUALITY_REJECT',
        },
        { name: 'total_qty', label: 'Total quantity', type: 'number', required: true },
        { name: 'total_amount', label: 'Total amount', type: 'number' },
        { name: 'debit_note_id', label: 'Linked Debit note voucher', lookup: 'vouchers' },
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
