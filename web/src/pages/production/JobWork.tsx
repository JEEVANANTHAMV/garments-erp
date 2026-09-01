import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, fmtDecimal, humanize, today } from '../../lib/format';

export function JobWorkChallansPage() {
  const STATES = ['DRAFT', 'ISSUED', 'PARTIAL_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED'];
  return (
    <CrudPage
      path="jobwork-challans"
      title="Job Work Challans"
      permission="PRODUCTION"
      singular="Challan"
      subtitle="Outward delivery challans issued to job-work vendors"
      defaultSort={{ key: 'challan_date', dir: 'desc' }}
      columns={[
        {
          key: 'challan_no',
          header: 'Challan no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.challan_no}</span>
          ),
        },
        { key: 'challan_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.challan_date) },
        { key: 'po_prod_no', header: 'Work order' },
        { key: 'vendor_name', header: 'Vendor' },
        {
          key: 'stage_name',
          header: 'Process',
          render: (r: any) => (r.stage_name ? <Badge tone="violet">{r.stage_name}</Badge> : '—'),
        },
        { key: 'total_qty', header: 'Qty', align: 'right', render: (r: any) => fmtNumber(r.total_qty) },
        { key: 'rate', header: 'Rate', align: 'right', render: (r: any) => fmtDecimal(r.rate, 2) },
        { key: 'total_amount', header: 'Amount', align: 'right', render: (r: any) => fmtDecimal(r.total_amount, 2) },
        { key: 'expected_return', header: 'Exp. Return', render: (r: any) => fmtDate(r.expected_return) },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
        { name: 'vendor_id', label: 'Vendor', lookup: 'vendors' },
        { name: 'stage_id', label: 'Process stage', lookup: 'process-stages' },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'challan_no', label: 'Challan no', hint: 'Blank to auto-generate' },
        { name: 'challan_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
        { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
        { name: 'vendor_id', label: 'Job-work vendor', required: true, lookup: 'vendors' },
        { name: 'stage_id', label: 'Process stage', lookup: 'process-stages' },
        { name: 'gate_outward_id', label: 'Outward gate pass', lookup: 'gate-outwards' },
        { name: 'total_qty', label: 'Total quantity', type: 'number', required: true },
        { name: 'rate', label: 'Rate per piece', type: 'number' },
        { name: 'total_amount', label: 'Total amount', type: 'number' },
        { name: 'expected_return', label: 'Expected return date', type: 'date' },
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

export function JobWorkReceiptsPage() {
  const STATES = ['DRAFT', 'RECEIVED', 'QC_PENDING', 'ACCEPTED', 'CLOSED'];
  return (
    <CrudPage
      path="jobwork-receipts"
      title="Job Work Receipts"
      permission="PRODUCTION"
      singular="Receipt"
      subtitle="Inward material receipt & reconciliation from job workers"
      defaultSort={{ key: 'receipt_date', dir: 'desc' }}
      columns={[
        {
          key: 'receipt_no',
          header: 'Receipt no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.receipt_no}</span>
          ),
        },
        { key: 'receipt_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.receipt_date) },
        { key: 'challan_no', header: 'Challan no' },
        { key: 'vendor_name', header: 'Vendor' },
        { key: 'issued_qty', header: 'Issued', align: 'right', render: (r: any) => fmtNumber(r.issued_qty) },
        {
          key: 'received_qty',
          header: 'Received',
          align: 'right',
          render: (r: any) => <span className="font-medium text-emerald-700">{fmtNumber(r.received_qty)}</span>,
        },
        {
          key: 'rejected_qty',
          header: 'Reject',
          align: 'right',
          render: (r: any) =>
            Number(r.rejected_qty) > 0 ? (
              <span className="font-medium text-red-600">{fmtNumber(r.rejected_qty)}</span>
            ) : (
              '—'
            ),
        },
        {
          key: 'shortage_qty',
          header: 'Shortage',
          align: 'right',
          render: (r: any) =>
            Number(r.shortage_qty) > 0 ? (
              <span className="font-medium text-orange-600">{fmtNumber(r.shortage_qty)}</span>
            ) : (
              '—'
            ),
        },
        {
          key: 'rework_qty',
          header: 'Rework',
          align: 'right',
          render: (r: any) =>
            Number(r.rework_qty) > 0 ? (
              <span className="font-medium text-amber-600">{fmtNumber(r.rework_qty)}</span>
            ) : (
              '—'
            ),
        },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'challan_id', label: 'Challan', lookup: 'jobwork-challans' },
        { name: 'vendor_id', label: 'Vendor', lookup: 'vendors' },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'receipt_no', label: 'Receipt no', hint: 'Blank to auto-generate' },
        { name: 'receipt_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
        { name: 'challan_id', label: 'Job work challan', required: true, lookup: 'jobwork-challans' },
        { name: 'vendor_id', label: 'Vendor', required: true, lookup: 'vendors' },
        { name: 'gate_inward_id', label: 'Inward gate entry', lookup: 'gate-inwards' },
        { name: 'issued_qty', label: 'Issued quantity', type: 'number' },
        { name: 'received_qty', label: 'Received quantity', type: 'number', required: true },
        { name: 'rejected_qty', label: 'Rejected quantity', type: 'number' },
        { name: 'shortage_qty', label: 'Shortage quantity', type: 'number' },
        { name: 'rework_qty', label: 'Rework quantity', type: 'number' },
        { name: 'rate', label: 'Job-work rate', type: 'number' },
        { name: 'total_amount', label: 'Total amount', type: 'number' },
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

export function JobWorkInsPage() {
  const STATES = [
    'DRAFT',
    'RECEIVED',
    'IN_PROCESS',
    'QC_DONE',
    'READY_TO_DISPATCH',
    'DISPATCHED',
    'INVOICED',
    'CLOSED',
  ];
  return (
    <CrudPage
      path="jobwork-ins"
      title="Job Work In"
      permission="PRODUCTION"
      singular="Job Work In"
      subtitle="Customer material processing at our factory (Printing, Embroidery, Washing etc.)"
      defaultSort={{ key: 'jwin_date', dir: 'desc' }}
      columns={[
        {
          key: 'jwin_no',
          header: 'JW In no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.jwin_no}</span>
          ),
        },
        { key: 'jwin_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.jwin_date) },
        { key: 'customer_name', header: 'Customer' },
        { key: 'customer_dc_no', header: 'Customer DC' },
        { key: 'process_type', header: 'Process', render: (r: any) => <Badge tone="cyan">{r.process_type || 'General'}</Badge> },
        { key: 'total_qty', header: 'Qty', align: 'right', render: (r: any) => fmtNumber(r.total_qty) },
        { key: 'rate', header: 'Rate', align: 'right', render: (r: any) => fmtDecimal(r.rate, 2) },
        { key: 'total_amount', header: 'Amount', align: 'right', render: (r: any) => fmtDecimal(r.total_amount, 2) },
        { key: 'expected_delivery', header: 'Delivery', render: (r: any) => fmtDate(r.expected_delivery) },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'customer_id', label: 'Customer', lookup: 'customers' },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'jwin_no', label: 'Job Work In no', hint: 'Blank to auto-generate' },
        { name: 'jwin_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
        { name: 'customer_id', label: 'Customer', required: true, lookup: 'customers' },
        { name: 'gate_inward_id', label: 'Inward gate entry', lookup: 'gate-inwards' },
        { name: 'customer_dc_no', label: 'Customer DC no' },
        { name: 'customer_po_ref', label: 'Customer PO ref' },
        { name: 'process_type', label: 'Process type', placeholder: 'e.g. Screen Printing, Enzyme Wash' },
        { name: 'total_qty', label: 'Total quantity', type: 'number', required: true },
        { name: 'rate', label: 'Rate per piece', type: 'number' },
        { name: 'total_amount', label: 'Total amount', type: 'number' },
        { name: 'expected_delivery', label: 'Expected delivery date', type: 'date' },
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

export function JobWorkInvoicesPage() {
  const TYPES = ['RECEIVABLE', 'PAYABLE'];
  const STATES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'CANCELLED'];
  return (
    <CrudPage
      path="jobwork-invoices"
      title="Job Work Invoices"
      permission="PRODUCTION"
      singular="JW Invoice"
      subtitle="Billing for job work processing (receivable / payable)"
      defaultSort={{ key: 'invoice_date', dir: 'desc' }}
      columns={[
        {
          key: 'invoice_no',
          header: 'Invoice no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.invoice_no}</span>
          ),
        },
        { key: 'invoice_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.invoice_date) },
        { key: 'party_name', header: 'Party' },
        {
          key: 'invoice_type',
          header: 'Type',
          render: (r: any) => (
            <Badge tone={r.invoice_type === 'RECEIVABLE' ? 'emerald' : 'amber'}>{r.invoice_type}</Badge>
          ),
        },
        { key: 'total_qty', header: 'Qty', align: 'right', render: (r: any) => fmtNumber(r.total_qty) },
        { key: 'taxable_amount', header: 'Taxable', align: 'right', render: (r: any) => fmtDecimal(r.taxable_amount, 2) },
        { key: 'gst_amount', header: 'GST', align: 'right', render: (r: any) => fmtDecimal(r.gst_amount, 2) },
        {
          key: 'total_amount',
          header: 'Total',
          align: 'right',
          render: (r: any) => (
            <span className="font-medium text-brand-700">{fmtDecimal(r.total_amount, 2)}</span>
          ),
        },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'party_id', label: 'Party', lookup: 'parties' },
        { name: 'invoice_type', label: 'Type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'invoice_no', label: 'Invoice no', hint: 'Blank to auto-generate' },
        { name: 'invoice_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
        { name: 'invoice_type', label: 'Invoice type', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
        { name: 'party_id', label: 'Party (Customer/Vendor)', required: true, lookup: 'parties' },
        { name: 'jwin_id', label: 'Job Work In Ref', lookup: 'jobwork-ins' },
        { name: 'challan_id', label: 'Job Work Challan Ref', lookup: 'jobwork-challans' },
        { name: 'currency_id', label: 'Currency', required: true, lookup: 'currencies' },
        { name: 'total_qty', label: 'Total quantity', type: 'number' },
        { name: 'rate', label: 'Rate', type: 'number' },
        { name: 'taxable_amount', label: 'Taxable amount', type: 'number', required: true },
        { name: 'gst_amount', label: 'GST amount', type: 'number' },
        { name: 'total_amount', label: 'Total amount', type: 'number', required: true },
        { name: 'hsn_code', label: 'HSN code', placeholder: '9988' },
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
