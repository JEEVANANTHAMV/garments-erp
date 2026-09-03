import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, fmtDecimal, humanize, today } from '../../lib/format';
import { useNavigate } from 'react-router-dom';

const INCOTERMS = ['FOB','CIF','CFR','EXW','DDP','DAP','FCA'].map((v) => ({ value: v, label: v }));

export function EnquiriesPage() {
  return <CrudPage
    path="enquiries" title="Enquiries" permission="ENQUIRY" singular="Enquiry"
    subtitle="Buyer enquiries — the top of the order funnel"
    defaultSort={{ key: 'enquiry_date', dir: 'desc' }}
    columns={[
      { key: 'enquiry_no', header: 'Enquiry no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.enquiry_no}</span> },
      { key: 'enquiry_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.enquiry_date) },
      { key: 'buyer_name', header: 'Buyer' },
      { key: 'season', header: 'Season' },
      { key: 'expected_qty', header: 'Expected qty', align: 'right', render: (r: any) => fmtNumber(r.expected_qty) },
      { key: 'target_price', header: 'Target price', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.target_price, 2)}` },
      { key: 'delivery_target', header: 'Delivery', render: (r: any) => fmtDate(r.delivery_target) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'buyer_id', label: 'Buyer', lookup: 'buyers' },
      { name: 'status_id', label: 'Status', statusDomain: 'ENQUIRY' },
      { name: 'merchandiser_id', label: 'Merchandiser', lookup: 'users' },
    ]}
    fields={[
      { name: 'enquiry_no', label: 'Enquiry no', hint: 'Leave blank to auto-generate' },
      { name: 'enquiry_date', label: 'Enquiry date', type: 'date', required: true, defaultValue: today() },
      { name: 'buyer_id', label: 'Buyer', required: true, lookup: 'buyers' },
      { name: 'agent_id', label: 'Agent', lookup: 'agents' },
      { name: 'merchandiser_id', label: 'Merchandiser', lookup: 'users' },
      { name: 'season', label: 'Season', placeholder: 'e.g. SS26' },
      { name: 'currency_id', label: 'Currency', lookup: 'currencies' },
      { name: 'target_price', label: 'Target price', type: 'number' },
      { name: 'expected_qty', label: 'Expected quantity', type: 'number' },
      { name: 'delivery_target', label: 'Target delivery', type: 'date' },
      { name: 'status_id', label: 'Status', statusDomain: 'ENQUIRY' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

export function SamplesPage() {
  const TYPES = ['PROTO','FIT','SMS','SIZE_SET','PP','TOP','SHIPMENT','PHOTO'];
  const APPROVALS = ['PENDING','APPROVED','REJECTED','APPROVED_WITH_COMMENTS'];
  return <CrudPage
    path="samples" title="Samples" permission="SAMPLE" singular="Sample"
    subtitle="Sampling lifecycle from proto through to TOP"
    defaultSort={{ key: 'request_date', dir: 'desc' }}
    columns={[
      { key: 'sample_no', header: 'Sample no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.sample_no}</span> },
      { key: 'sample_type', header: 'Type', render: (r: any) => <Badge tone="violet">{humanize(r.sample_type)}</Badge> },
      { key: 'style_code', header: 'Style',
        render: (r: any) => <div><p className="font-medium">{r.style_code}</p>
          <p className="text-[11px] text-slate-500">{r.style_name}</p></div> },
      { key: 'buyer_name', header: 'Buyer' },
      { key: 'request_date', header: 'Requested', sortable: true, render: (r: any) => fmtDate(r.request_date) },
      { key: 'target_date', header: 'Target', sortable: true, render: (r: any) => fmtDate(r.target_date) },
      { key: 'qty', header: 'Qty', align: 'right' },
      { key: 'approval_status', header: 'Approval', render: (r: any) => <StatusBadge value={r.approval_status} /> },
    ]}
    filters={[
      { name: 'sample_type', label: 'Sample type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'approval_status', label: 'Approval', options: APPROVALS.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'buyer_id', label: 'Buyer', lookup: 'buyers' },
      { name: 'style_id', label: 'Style', lookup: 'styles' },
    ]}
    fields={[
      { name: 'sample_no', label: 'Sample no', hint: 'Leave blank to auto-generate' },
      { name: 'sample_type', label: 'Sample type', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'style_id', label: 'Style', required: true, lookup: 'styles' },
      { name: 'buyer_id', label: 'Buyer', lookup: 'buyers' },
      { name: 'enquiry_id', label: 'Enquiry', lookup: 'enquiries' },
      { name: 'qty', label: 'Quantity', type: 'number', defaultValue: 1 },
      { name: 'request_date', label: 'Request date', type: 'date', defaultValue: today() },
      { name: 'target_date', label: 'Target date', type: 'date' },
      { name: 'submit_date', label: 'Submitted date', type: 'date' },
      { name: 'approval_status', label: 'Approval status', options: APPROVALS.map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'PENDING' },
      { name: 'status_id', label: 'Status', statusDomain: 'SAMPLE' },
      { name: 'courier_awb', label: 'Courier AWB' },
      { name: 'buyer_comments', label: 'Buyer comments', type: 'textarea' },
    ]} />;
}

export function QuotationsPage() {
  const nav = useNavigate();
  return <CrudPage
    path="quotations" title="Quotations" permission="QUOTATION" singular="Quotation"
    subtitle="Domestic & import price offers for buyers and suppliers"
    defaultSort={{ key: 'quotation_date', dir: 'desc' }}
    onNew={() => nav('/sales/quotations/new')}
    onRowClick={(r: any) => nav(`/sales/quotations/${r.id}`)}
    columns={[
      { key: 'quotation_no', header: 'Quotation no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.quotation_no}</span> },
      { key: 'quotation_type', header: 'Type',
        render: (r: any) => r.quotation_type === 'BUYER'
          ? <Badge tone="emerald">Buyer</Badge>
          : r.quotation_type === 'IMPORT'
            ? <Badge tone="violet">Import</Badge>
            : <Badge tone="sky">Domestic</Badge> },
      { key: 'quotation_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.quotation_date) },
      { key: 'buyer_name', header: 'Buyer / Supplier',
        render: (r: any) => <span className="font-medium text-slate-800">{r.buyer_name || r.supplier_name || '—'}</span> },
      { key: 'incoterm', header: 'Incoterm' },
      { key: 'currency_code', header: 'Ccy', align: 'center' },
      { key: 'total_amount', header: 'Amount', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.total_amount, 2)}` },
      { key: 'valid_until', header: 'Valid until', render: (r: any) => fmtDate(r.valid_until) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'quotation_type', label: 'Type', options: [{ value: 'BUYER', label: 'Buyer' }, { value: 'DOMESTIC', label: 'Domestic' }, { value: 'IMPORT', label: 'Import' }] },
      { name: 'buyer_id', label: 'Buyer', lookup: 'buyers' },
      { name: 'supplier_id', label: 'Supplier', lookup: 'suppliers' },
      { name: 'status_id', label: 'Status', statusDomain: 'QUOTATION' },
    ]}
    hideCreateButton
    fields={[]} />;
}
