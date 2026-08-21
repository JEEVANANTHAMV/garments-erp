import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, humanize, today } from '../../lib/format';

export function QcInspectionsPage() {
  const TYPES = ['INCOMING','INLINE','END_LINE','FINAL','PRE_FINAL','AQL','PACKING'];
  const RESULTS = ['PASS','FAIL','PENDING','REINSPECT'];
  return <CrudPage
    path="qc-inspections" title="QC Inspections" permission="QC" singular="Inspection"
    subtitle="Inline, end-line and final AQL inspections"
    defaultSort={{ key: 'qc_date', dir: 'desc' }}
    columns={[
      { key: 'qc_no', header: 'QC no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.qc_no}</span> },
      { key: 'qc_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.qc_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'inspection_type', header: 'Type', render: (r: any) => <Badge tone="violet">{humanize(r.inspection_type)}</Badge> },
      { key: 'aql_level', header: 'AQL' },
      { key: 'sample_size', header: 'Sample', align: 'right', render: (r: any) => fmtNumber(r.sample_size) },
      { key: 'passed_qty', header: 'Passed', align: 'right',
        render: (r: any) => <span className="text-emerald-700">{fmtNumber(r.passed_qty)}</span> },
      { key: 'defects', header: 'Defects (C/M/m)', align: 'center', render: (r: any) => (
        <span className="font-mono text-[11.5px] tabular-nums">
          <span className="text-red-600">{r.critical_defects}</span>/
          <span className="text-amber-600">{r.major_defects}</span>/
          <span className="text-slate-500">{r.minor_defects}</span>
        </span>) },
      { key: 'inspector_name', header: 'Inspector' },
      { key: 'buyer_qc', header: 'Buyer QC',
        render: (r: any) => r.buyer_qc ? <Badge tone="amber">Buyer / 3rd party</Badge> : null },
      { key: 'result', header: 'Result', render: (r: any) => <StatusBadge value={r.result} /> },
    ]}
    filters={[
      { name: 'inspection_type', label: 'Type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'result', label: 'Result', options: RESULTS.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'inspector_id', label: 'Inspector', lookup: 'users' },
    ]}
    modalSize="lg"
    fields={[
      { name: 'qc_no', label: 'QC no', hint: 'Blank to auto-generate' },
      { name: 'qc_date', label: 'Inspection date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'stage_id', label: 'Process stage', lookup: 'process-stages' },
      { name: 'inspection_type', label: 'Inspection type', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'aql_level', label: 'AQL level', placeholder: 'e.g. 2.5' },
      { name: 'lot_size', label: 'Lot size', type: 'number' },
      { name: 'sample_size', label: 'Sample size', type: 'number' },
      { name: 'inspected_qty', label: 'Inspected qty', type: 'number' },
      { name: 'passed_qty', label: 'Passed qty', type: 'number' },
      { name: 'critical_defects', label: 'Critical defects', type: 'number' },
      { name: 'major_defects', label: 'Major defects', type: 'number' },
      { name: 'minor_defects', label: 'Minor defects', type: 'number' },
      { name: 'result', label: 'Result', options: RESULTS.map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'PENDING' },
      { name: 'inspector_id', label: 'Inspector', lookup: 'users' },
      { name: 'buyer_qc', label: 'Buyer / third-party inspection', type: 'checkbox' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

export function DefectsPage() {
  const TYPES = ['CRITICAL','MAJOR','MINOR'];
  return <CrudPage
    path="defects" title="Defect Master" permission="QC" singular="Defect"
    subtitle="AQL defect catalogue used during inspections"
    defaultSort={{ key: 'defect_name', dir: 'asc' }}
    columns={[
      { key: 'defect_code', header: 'Code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.defect_code}</span> },
      { key: 'defect_name', header: 'Defect', sortable: true },
      { key: 'defect_type', header: 'Severity', render: (r: any) => (
        <Badge tone={r.defect_type === 'CRITICAL' ? 'red' : r.defect_type === 'MAJOR' ? 'amber' : 'slate'}>
          {humanize(r.defect_type)}</Badge>) },
      { key: 'stage', header: 'Typical stage' },
    ]}
    filters={[{ name: 'defect_type', label: 'Severity', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) }]}
    fields={[
      { name: 'defect_code', label: 'Defect code', required: true },
      { name: 'defect_name', label: 'Defect name', required: true },
      { name: 'defect_type', label: 'Severity', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'MINOR' },
      { name: 'stage', label: 'Typical stage', placeholder: 'e.g. STITCH' },
      { name: 'is_active', label: 'Active', type: 'checkbox', defaultValue: 1 },
    ]} />;
}
