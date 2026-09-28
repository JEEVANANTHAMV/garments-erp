import { CrudPage } from '../../components/CrudPage';
import { Badge } from '../../components/ui';
import { fmtNumber } from '../../lib/format';

/**
 * Sewing / Checking line master with daily capacity (developer doc §3):
 * Capacity PCS = available minutes × efficiency % / SAM, or typed in directly.
 * Opened from "Add Line" / "Line Capacity Setup" on the allocation and plan screens.
 */
function LinesPage({ path, title }: { path: 'sewing-lines' | 'checking-lines'; title: string }) {
  return <CrudPage
    path={path} title={title} permission="PRODUCTION" singular="Line"
    subtitle="Line code, supervisor, operators, SAM and daily capacity used by line allocation and daily plan"
    defaultSort={{ key: 'line_code', dir: 'asc' }}
    columns={[
      { key: 'line_code', header: 'Line code', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-semibold text-brand-700">{r.line_code}</span> },
      { key: 'line_name', header: 'Line name', sortable: true },
      { key: 'floor_name', header: 'Floor' },
      { key: 'supervisor_name', header: 'Supervisor' },
      { key: 'manpower', header: 'Operators', align: 'right' },
      { key: 'sam_per_pcs', header: 'SAM / pc', align: 'right', render: (r: any) => (Number(r.sam_per_pcs) ? Number(r.sam_per_pcs).toFixed(2) : '—') },
      { key: 'efficiency_pct', header: 'Efficiency %', align: 'right', render: (r: any) => fmtNumber(r.efficiency_pct) },
      { key: 'capacity_pcs', header: 'Capacity / day', align: 'right', render: (r: any) => <span className="font-medium">{fmtNumber(r.capacity_pcs)}</span> },
      { key: 'is_active', header: 'Status', render: (r: any) => (r.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="slate">Inactive</Badge>) },
    ]}
    fields={[
      { name: 'line_code', label: 'Line code', required: true },
      { name: 'line_name', label: 'Line name', required: true },
      { name: 'unit_id', label: 'Unit', lookup: 'units' },
      { name: 'floor_name', label: 'Floor' },
      { name: 'supervisor_name', label: 'Supervisor' },
      { name: 'manpower', label: 'Operators', type: 'number' },
      { name: 'working_hours', label: 'Working hours / day', type: 'number', defaultValue: 8 },
      { name: 'sam_per_pcs', label: 'SAM (min / pc)', type: 'number' },
      { name: 'efficiency_pct', label: 'Efficiency %', type: 'number', defaultValue: 100 },
      { name: 'capacity_pcs', label: 'Capacity (PCS / day)', type: 'number', required: true,
        hint: 'Operators × hours × 60 × efficiency % ÷ SAM' },
      { name: 'is_active', label: 'Active', type: 'checkbox', defaultValue: 1 },
    ]} />;
}

export function SewingLinesPage() {
  return <LinesPage path="sewing-lines" title="Sewing Lines" />;
}

export function CheckingLinesPage() {
  return <LinesPage path="checking-lines" title="Checking Lines" />;
}
