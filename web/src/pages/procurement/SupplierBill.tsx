import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtDecimal, humanize, today } from '../../lib/format';

export function SupplierBillsPage() {
  const MATCH_STATUSES = ['UNMATCHED', 'PARTIAL', 'FULLY_MATCHED', 'DISCREPANCY'];
  const STATES = ['DRAFT', 'VERIFIED', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED'];

  return (
    <CrudPage
      path="supplier-bills"
      title="Supplier Invoices & Bills"
      permission="PURCHASE"
      singular="Supplier Bill"
      subtitle="Supplier invoice entry with automated 3-way & 4-way matching (PO → DC → GRN → Bill)"
      defaultSort={{ key: 'bill_date', dir: 'desc' }}
      columns={[
        {
          key: 'bill_no',
          header: 'Bill no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.bill_no}</span>
          ),
        },
        { key: 'bill_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.bill_date) },
        { key: 'supplier_name', header: 'Supplier' },
        { key: 'supplier_inv_no', header: 'Invoice ref' },
        { key: 'po_no', header: 'PO no' },
        { key: 'grn_no', header: 'GRN no' },
        {
          key: 'total_amount',
          header: 'Total Amount',
          align: 'right',
          render: (r: any) => (
            <span className="font-medium text-brand-700">{fmtDecimal(r.total_amount, 2)}</span>
          ),
        },
        {
          key: 'match_status',
          header: 'Matching',
          render: (r: any) => {
            const tone =
              r.match_status === 'FULLY_MATCHED'
                ? 'emerald'
                : r.match_status === 'PARTIAL'
                ? 'amber'
                : r.match_status === 'DISCREPANCY'
                ? 'red'
                : 'slate';
            return <Badge tone={tone}>{humanize(r.match_status || 'UNMATCHED')}</Badge>;
          },
        },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'supplier_id', label: 'Supplier', lookup: 'suppliers' },
        { name: 'po_id', label: 'PO', lookup: 'purchase-orders' },
        { name: 'grn_id', label: 'GRN', lookup: 'grns' },
        {
          name: 'match_status',
          label: 'Matching',
          options: MATCH_STATUSES.map((v) => ({ value: v, label: humanize(v) })),
        },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'bill_no', label: 'Internal Bill no', hint: 'Blank to auto-generate' },
        { name: 'bill_date', label: 'Bill date', type: 'date', required: true, defaultValue: today() },
        { name: 'supplier_id', label: 'Supplier', required: true, lookup: 'suppliers' },
        { name: 'supplier_inv_no', label: 'Supplier invoice / bill no' },
        { name: 'supplier_inv_date', label: 'Supplier invoice date', type: 'date' },
        { name: 'po_id', label: 'Purchase order ref', lookup: 'purchase-orders' },
        { name: 'grn_id', label: 'GRN ref', lookup: 'grns' },
        { name: 'gate_inward_id', label: 'Gate entry ref', lookup: 'gate-inwards' },
        { name: 'currency_id', label: 'Currency', required: true, lookup: 'currencies' },
        { name: 'subtotal', label: 'Taxable subtotal', type: 'number', required: true },
        { name: 'gst_amount', label: 'GST amount', type: 'number' },
        { name: 'tds_amount', label: 'TDS amount', type: 'number' },
        { name: 'total_amount', label: 'Grand total', type: 'number', required: true },
        { name: 'po_matched', label: 'PO matched', type: 'checkbox' },
        { name: 'grn_matched', label: 'GRN matched', type: 'checkbox' },
        { name: 'gate_matched', label: 'Gate entry matched', type: 'checkbox' },
        {
          name: 'match_status',
          label: 'Match status',
          options: MATCH_STATUSES.map((v) => ({ value: v, label: humanize(v) })),
          defaultValue: 'UNMATCHED',
        },
        { name: 'payment_due_date', label: 'Payment due date', type: 'date' },
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
