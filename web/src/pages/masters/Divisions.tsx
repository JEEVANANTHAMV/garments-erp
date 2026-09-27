import { CrudPage } from '../../components/CrudPage';
import { Badge } from '../../components/ui';
import { humanize } from '../../lib/format';

/* ------------------------------------------------------------ Divisions */
// Printing / Embroidery divisions that do and bill customer job work.
// billing_name is printed on the Job Work Invoice header; blank GSTIN /
// address / bank fall back to the company's.
export function DivisionsPage() {
  const PROCESSES = ['PRINTING', 'EMBROIDERY'];
  return <CrudPage
    path="divisions" title="Divisions" permission="UNIT" singular="Division"
    subtitle="Printing and Embroidery divisions — job work billing name and overrides"
    defaultSort={{ key: 'division_name', dir: 'asc' }}
    columns={[
      { key: 'division_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.division_code}</span> },
      { key: 'division_name', header: 'Division', sortable: true },
      { key: 'billing_name', header: 'Billing name (on invoice)' },
      { key: 'process_type', header: 'Process', render: (r: any) => <Badge tone="violet">{humanize(r.process_type)}</Badge> },
      { key: 'invoice_prefix', header: 'Invoice prefix' },
      { key: 'gstin', header: 'GSTIN', render: (r: any) => r.gstin || <span className="text-slate-400">Company</span> },
      { key: 'is_active', header: 'Active',
        render: (r: any) => r.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge> },
    ]}
    filters={[{ name: 'process_type', label: 'Process', options: PROCESSES.map((v) => ({ value: v, label: humanize(v) })) }]}
    modalSize="lg"
    fields={[
      { name: 'division_code', label: 'Division code', required: true, placeholder: 'e.g. PRN' },
      { name: 'division_name', label: 'Division name', required: true, placeholder: 'e.g. Printing Division' },
      { name: 'billing_name', label: 'Billing name', required: true, span: 2, placeholder: 'e.g. CK Exports - Printing Division', hint: 'Printed as the company name on the job work bill' },
      { name: 'process_type', label: 'Process', required: true, options: PROCESSES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'invoice_prefix', label: 'Invoice no prefix', placeholder: 'e.g. PRN-', hint: 'Own invoice number series for this division' },
      { name: 'gstin', label: 'GSTIN', hint: 'Blank = company GSTIN' },
      { name: 'phone', label: 'Phone', hint: 'Blank = company phone' },
      { name: 'address_line1', label: 'Address line 1', span: 2, hint: 'Blank = company address' },
      { name: 'address_line2', label: 'Address line 2', span: 2 },
      { name: 'city', label: 'City' }, { name: 'state', label: 'State' },
      { name: 'pincode', label: 'Pincode' }, { name: 'email', label: 'Email', type: 'email' },
      { name: 'bank_name', label: 'Bank name' }, { name: 'bank_branch', label: 'Bank branch' },
      { name: 'bank_account_no', label: 'Bank account no' }, { name: 'bank_ifsc', label: 'IFSC' },
      { name: 'remarks', label: 'Remarks', type: 'textarea', span: 2 },
      { name: 'is_active', label: 'Active', type: 'checkbox', defaultValue: 1 },
    ]} />;
}
