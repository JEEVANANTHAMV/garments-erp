import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, fmtDecimal, humanize, today } from '../../lib/format';

// Job work DCs and receipts are bundle-wise documents with their own
// issue / receive / cancel flow (processDc.routes.ts) — not generic CRUD.
export { ProcessDcPage as JobWorkChallansPage, ProcessDcReceiptsPage as JobWorkReceiptsPage } from './ProcessDcPage';

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
