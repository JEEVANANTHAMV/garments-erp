import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, humanize, today } from '../../lib/format';

export function DailyProductionPlansPage() {
  const STATES = ['DRAFT','PLANNED','IN_PROGRESS','COMPLETED','CANCELLED'];
  return <CrudPage
    path="daily-production-plans" title="Daily Production Plans" permission="PRODUCTION" singular="Daily Plan"
    subtitle="Shift-level, line-level production plans with size/colour grids"
    defaultSort={{ key: 'plan_date', dir: 'desc' }}
    columns={[
      { key: 'plan_no', header: 'Plan no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.plan_no}</span> },
      { key: 'plan_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.plan_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'style_code', header: 'Style',
        render: (r: any) => <div><p className="font-medium">{r.style_code}</p>
          <p className="text-[11px] text-slate-500">{r.style_name}</p></div> },
      { key: 'line_name', header: 'Line',
        render: (r: any) => r.line_name ? <Badge tone="indigo">{r.line_name}</Badge> : '—' },
      { key: 'shift_name', header: 'Shift',
        render: (r: any) => r.shift_name ? <Badge tone="slate">{r.shift_name}</Badge> : '—' },
      { key: 'supervisor_name', header: 'Supervisor' },
      { key: 'today_target', header: 'Target', align: 'right',
        render: (r: any) => <span className="font-medium">{fmtNumber(r.today_target)}</span> },
      { key: 'planned_qty', header: 'Planned', align: 'right', render: (r: any) => fmtNumber(r.planned_qty) },
      { key: 'previous_output', header: 'Prev output', align: 'right', render: (r: any) => fmtNumber(r.previous_output) },
      { key: 'balance_qty', header: 'Balance', align: 'right',
        render: (r: any) => <span className={Number(r.balance_qty) > 0 ? 'text-amber-600 font-medium' : 'text-emerald-600'}>
          {fmtNumber(r.balance_qty)}</span> },
      { key: 'capacity_pcs', header: 'Capacity', align: 'right', render: (r: any) => fmtNumber(r.capacity_pcs) },
      { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
    ]}
    filters={[
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'style_id', label: 'Style', lookup: 'styles' },
      { name: 'line_id', label: 'Sewing line', lookup: 'sewing-lines' },
      { name: 'shift_id', label: 'Shift', lookup: 'shifts' },
      { name: 'unit_id', label: 'Unit', lookup: 'units' },
      { name: 'status', label: 'Status', options: STATES.map(v => ({ value: v, label: humanize(v) })) },
    ]}
    modalSize="lg"
    fields={[
      { name: 'plan_no', label: 'Plan no', hint: 'Blank to auto-generate' },
      { name: 'plan_date', label: 'Plan date', type: 'date', required: true, defaultValue: today() },
      { name: 'unit_id', label: 'Factory / Unit', lookup: 'units' },
      { name: 'line_id', label: 'Sewing line', lookup: 'sewing-lines' },
      { name: 'shift_id', label: 'Shift', lookup: 'shifts' },
      { name: 'supervisor_id', label: 'Supervisor', lookup: 'users' },
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'style_id', label: 'Style', lookup: 'styles' },
      { name: 'planned_qty', label: 'Planned qty', type: 'number' },
      { name: 'previous_output', label: 'Previous output', type: 'number' },
      { name: 'balance_qty', label: 'Balance qty', type: 'number' },
      { name: 'today_target', label: "Today's target", type: 'number', required: true },
      { name: 'smv', label: 'SMV', type: 'number', hint: 'Standard minute value' },
      { name: 'line_efficiency', label: 'Line efficiency %', type: 'number' },
      { name: 'capacity_pcs', label: 'Capacity (pcs)', type: 'number', hint: 'Auto-calculated from SMV × manpower × hours × efficiency' },
      { name: 'status', label: 'Status', options: STATES.map(v => ({ value: v, label: humanize(v) })), defaultValue: 'DRAFT' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

export function DailyOutputsPage() {
  const STATES = ['DRAFT','SUBMITTED','APPROVED'];
  return <CrudPage
    path="daily-outputs" title="Daily Output Entry" permission="PRODUCTION" singular="Daily Output"
    subtitle="End-of-day actual production entry with good / reject / rework tracking"
    defaultSort={{ key: 'output_date', dir: 'desc' }}
    columns={[
      { key: 'output_no', header: 'Output no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.output_no}</span> },
      { key: 'output_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.output_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'style_code', header: 'Style' },
      { key: 'line_name', header: 'Line',
        render: (r: any) => r.line_name ? <Badge tone="indigo">{r.line_name}</Badge> : '—' },
      { key: 'stage_name', header: 'Operation',
        render: (r: any) => r.stage_name ? <Badge tone="violet">{r.stage_name}</Badge> : '—' },
      { key: 'shift_name', header: 'Shift' },
      { key: 'target_qty', header: 'Target', align: 'right', render: (r: any) => fmtNumber(r.target_qty) },
      { key: 'actual_good', header: 'Good', align: 'right',
        render: (r: any) => <span className="font-medium text-emerald-700">{fmtNumber(r.actual_good)}</span> },
      { key: 'reject_qty', header: 'Reject', align: 'right',
        render: (r: any) => Number(r.reject_qty) > 0
          ? <span className="font-medium text-red-600">{fmtNumber(r.reject_qty)}</span> : '—' },
      { key: 'rework_qty', header: 'Rework', align: 'right',
        render: (r: any) => Number(r.rework_qty) > 0
          ? <span className="font-medium text-amber-600">{fmtNumber(r.rework_qty)}</span> : '—' },
      { key: 'achievement_pct', header: 'Achieved', align: 'right',
        render: (r: any) => {
          const pct = Number(r.achievement_pct);
          return <span className={pct >= 95 ? 'text-emerald-600 font-medium' : pct >= 85 ? 'text-amber-600' : 'text-red-600 font-medium'}>
            {pct.toFixed(1)}%</span>;
        } },
      { key: 'delay_reason_name', header: 'Delay reason' },
      { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
    ]}
    filters={[
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'style_id', label: 'Style', lookup: 'styles' },
      { name: 'line_id', label: 'Line', lookup: 'sewing-lines' },
      { name: 'shift_id', label: 'Shift', lookup: 'shifts' },
      { name: 'stage_id', label: 'Operation', lookup: 'process-stages' },
      { name: 'delay_reason_id', label: 'Delay reason', lookup: 'delay-reasons' },
      { name: 'status', label: 'Status', options: STATES.map(v => ({ value: v, label: humanize(v) })) },
    ]}
    modalSize="lg"
    fields={[
      { name: 'output_no', label: 'Output no', hint: 'Blank to auto-generate' },
      { name: 'output_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'daily_plan_id', label: 'Daily plan', lookup: 'daily-production-plans' },
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'style_id', label: 'Style', lookup: 'styles' },
      { name: 'line_id', label: 'Line', lookup: 'sewing-lines' },
      { name: 'shift_id', label: 'Shift', lookup: 'shifts' },
      { name: 'stage_id', label: 'Operation / Stage', lookup: 'process-stages' },
      { name: 'target_qty', label: 'Target qty', type: 'number' },
      { name: 'actual_good', label: 'Actual good', type: 'number', required: true },
      { name: 'reject_qty', label: 'Reject qty', type: 'number' },
      { name: 'rework_qty', label: 'Rework qty', type: 'number' },
      { name: 'total_output', label: 'Total output', type: 'number', hint: 'Good + Reject + Rework' },
      { name: 'achievement_pct', label: 'Achievement %', type: 'number' },
      { name: 'delay_reason_id', label: 'Delay reason', lookup: 'delay-reasons' },
      { name: 'status', label: 'Status', options: STATES.map(v => ({ value: v, label: humanize(v) })), defaultValue: 'DRAFT' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}
