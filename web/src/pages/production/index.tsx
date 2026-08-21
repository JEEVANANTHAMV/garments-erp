import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, fmtDecimal, humanize, today } from '../../lib/format';

/** Shared columns for the per-stage process screens. */
const qtyCols = [
  { key: 'input_qty', header: 'Input', align: 'right' as const, render: (r: any) => fmtNumber(r.input_qty) },
  { key: 'output_qty', header: 'Output', align: 'right' as const,
    render: (r: any) => <span className="font-medium text-emerald-700">{fmtNumber(r.output_qty)}</span> },
  { key: 'rejected_qty', header: 'Rejected', align: 'right' as const,
    render: (r: any) => Number(r.rejected_qty) > 0
      ? <span className="font-medium text-red-600">{fmtNumber(r.rejected_qty)}</span> : '—' },
  { key: 'eff', header: 'Yield', align: 'right' as const, render: (r: any) => {
    const i = Number(r.input_qty), o = Number(r.output_qty);
    if (!i) return '—';
    const pct = (o / i) * 100;
    return <span className={pct >= 97 ? 'text-emerald-600' : pct >= 92 ? 'text-amber-600' : 'text-red-600'}>
      {pct.toFixed(1)}%</span>;
  } },
];

const qtyFields = [
  { name: 'input_qty', label: 'Input qty', type: 'number' as const },
  { name: 'output_qty', label: 'Output qty', type: 'number' as const },
  { name: 'rejected_qty', label: 'Rejected qty', type: 'number' as const },
];

export function ProductionPlansPage() {
  return <CrudPage
    path="production-plans" title="Production Plans" permission="PRODUCTION" singular="Plan"
    subtitle="Time & Action plans against sales orders"
    defaultSort={{ key: 'plan_date', dir: 'desc' }}
    columns={[
      { key: 'plan_no', header: 'Plan no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.plan_no}</span> },
      { key: 'plan_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.plan_date) },
      { key: 'so_no', header: 'Sales order' },
      { key: 'unit_name', header: 'Unit' },
      { key: 'plan_start', header: 'Start', render: (r: any) => fmtDate(r.plan_start) },
      { key: 'plan_end', header: 'End', render: (r: any) => fmtDate(r.plan_end) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[{ name: 'so_id', label: 'Sales order', lookup: 'sales-orders' },
              { name: 'unit_id', label: 'Unit', lookup: 'units' }]}
    fields={[
      { name: 'plan_no', label: 'Plan no', hint: 'Blank to auto-generate' },
      { name: 'plan_date', label: 'Plan date', type: 'date', required: true, defaultValue: today() },
      { name: 'so_id', label: 'Sales order', required: true, lookup: 'sales-orders' },
      { name: 'unit_id', label: 'Unit', lookup: 'units' },
      { name: 'plan_start', label: 'Planned start', type: 'date' },
      { name: 'plan_end', label: 'Planned end', type: 'date' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROD_PLAN' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

export function ProductionOrdersPage() {
  const STATES = ['DRAFT','APPROVED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED'];
  return <CrudPage
    path="production-orders" title="Production Orders" permission="PRODUCTION" singular="Work Order"
    subtitle="Work orders issued to units and job-work vendors"
    defaultSort={{ key: 'prod_date', dir: 'desc' }}
    columns={[
      { key: 'po_prod_no', header: 'Work order', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.po_prod_no}</span> },
      { key: 'prod_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.prod_date) },
      { key: 'so_no', header: 'Sales order' },
      { key: 'style_code', header: 'Style',
        render: (r: any) => <div><p className="font-medium">{r.style_code}</p>
          <p className="text-[11px] text-slate-500">{r.color_name}</p></div> },
      { key: 'unit_name', header: 'Unit' },
      { key: 'order_qty', header: 'Order qty', align: 'right', render: (r: any) => fmtNumber(r.order_qty) },
      { key: 'progress', header: 'Produced', align: 'right', render: (r: any) => {
        const pct = Number(r.order_qty) > 0 ? (Number(r.produced_qty) / Number(r.order_qty)) * 100 : 0;
        return (
          <div className="min-w-[100px]">
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="tabular-nums">{fmtNumber(r.produced_qty)}</span>
              <span className="text-slate-400">{pct.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
                style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>); } },
      { key: 'is_jobwork', header: 'Job work',
        render: (r: any) => r.is_jobwork ? <Badge tone="amber">{r.vendor_name ?? 'Outsourced'}</Badge> : null },
      { key: 'approval_state', header: 'State', render: (r: any) => <StatusBadge value={r.approval_state} /> },
    ]}
    filters={[
      { name: 'so_id', label: 'Sales order', lookup: 'sales-orders' },
      { name: 'style_id', label: 'Style', lookup: 'styles' },
      { name: 'unit_id', label: 'Unit', lookup: 'units' },
      { name: 'approval_state', label: 'State', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
    ]}
    modalSize="lg"
    fields={[
      { name: 'po_prod_no', label: 'Work order no', hint: 'Blank to auto-generate' },
      { name: 'prod_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'so_id', label: 'Sales order', required: true, lookup: 'sales-orders' },
      { name: 'plan_id', label: 'Production plan', lookup: 'production-plans' },
      { name: 'style_id', label: 'Style', required: true, lookup: 'styles' },
      { name: 'color_id', label: 'Colour', lookup: 'colors' },
      { name: 'unit_id', label: 'Unit', lookup: 'units' },
      { name: 'order_qty', label: 'Order quantity', type: 'number', required: true },
      { name: 'planned_qty', label: 'Planned quantity', type: 'number' },
      { name: 'produced_qty', label: 'Produced quantity', type: 'number' },
      { name: 'is_jobwork', label: 'Outsourced (job work)', type: 'checkbox' },
      { name: 'vendor_id', label: 'Job-work vendor', lookup: 'vendors' },
      { name: 'approval_state', label: 'State', options: STATES.map((v) => ({ value: v, label: humanize(v) })), defaultValue: 'DRAFT' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROD_ORDER' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

export function CuttingPage() {
  return <CrudPage
    path="cuttings" title="Cutting" permission="PRODUCTION" singular="Cutting"
    subtitle="Lay planning, marker efficiency and bundle output"
    defaultSort={{ key: 'cut_date', dir: 'desc' }}
    columns={[
      { key: 'cut_no', header: 'Cut no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.cut_no}</span> },
      { key: 'cut_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.cut_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'fabric_name', header: 'Fabric' },
      { key: 'lay_length_m', header: 'Lay (m)', align: 'right', render: (r: any) => fmtDecimal(r.lay_length_m, 2) },
      { key: 'ply_count', header: 'Ply', align: 'right' },
      { key: 'marker_eff_pct', header: 'Marker eff.', align: 'right',
        render: (r: any) => r.marker_eff_pct ? `${fmtDecimal(r.marker_eff_pct, 1)}%` : '—' },
      { key: 'fabric_used_kg', header: 'Fabric (kg)', align: 'right', render: (r: any) => fmtDecimal(r.fabric_used_kg, 3) },
      { key: 'total_pieces', header: 'Pieces', align: 'right',
        render: (r: any) => <span className="font-medium">{fmtNumber(r.total_pieces)}</span> },
    ]}
    filters={[{ name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
              { name: 'fabric_id', label: 'Fabric', lookup: 'fabrics' }]}
    fields={[
      { name: 'cut_no', label: 'Cut no', hint: 'Blank to auto-generate' },
      { name: 'cut_date', label: 'Cut date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'fabric_id', label: 'Fabric', lookup: 'fabrics' },
      { name: 'batch_id', label: 'Batch', lookup: 'batches' },
      { name: 'lay_length_m', label: 'Lay length (m)', type: 'number' },
      { name: 'ply_count', label: 'Ply count', type: 'number' },
      { name: 'marker_ref', label: 'Marker reference' },
      { name: 'marker_eff_pct', label: 'Marker efficiency %', type: 'number' },
      { name: 'fabric_used_kg', label: 'Fabric used (kg)', type: 'number' },
      { name: 'total_pieces', label: 'Total pieces cut', type: 'number' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROCESS' },
    ]} />;
}

export function StitchingPage() {
  return <CrudPage
    path="stitchings" title="Stitching" permission="PRODUCTION" singular="Stitching"
    subtitle="Sewing line output and efficiency"
    defaultSort={{ key: 'stitch_date', dir: 'desc' }}
    columns={[
      { key: 'stitch_no', header: 'Stitch no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.stitch_no}</span> },
      { key: 'stitch_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.stitch_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'unit_name', header: 'Unit' },
      { key: 'line_no', header: 'Line' },
      ...qtyCols,
      { key: 'smv', header: 'SMV', align: 'right', render: (r: any) => fmtDecimal(r.smv, 2) },
    ]}
    filters={[{ name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
              { name: 'unit_id', label: 'Unit', lookup: 'units' }]}
    fields={[
      { name: 'stitch_no', label: 'Stitch no', hint: 'Blank to auto-generate' },
      { name: 'stitch_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'unit_id', label: 'Unit', lookup: 'units' },
      { name: 'line_no', label: 'Line number' },
      { name: 'vendor_id', label: 'CMT vendor', lookup: 'vendors' },
      ...qtyFields,
      { name: 'smv', label: 'SMV', type: 'number', hint: 'Standard minute value' },
      { name: 'rate', label: 'Rate per piece', type: 'number' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROCESS' },
    ]} />;
}

export function PrintingPage() {
  const TYPES = ['SCREEN','DIGITAL','SUBLIMATION','RUBBER','DISCHARGE','FOIL','PUFF','OTHER'];
  return <CrudPage
    path="printings" title="Printing" permission="PRODUCTION" singular="Printing"
    subtitle="Screen, digital and speciality printing"
    defaultSort={{ key: 'print_date', dir: 'desc' }}
    columns={[
      { key: 'print_no', header: 'Print no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.print_no}</span> },
      { key: 'print_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.print_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'print_type', header: 'Type', render: (r: any) => <Badge tone="violet">{humanize(r.print_type)}</Badge> },
      { key: 'placement', header: 'Placement' },
      { key: 'vendor_name', header: 'Vendor' },
      ...qtyCols,
    ]}
    filters={[{ name: 'print_type', label: 'Print type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
              { name: 'vendor_id', label: 'Vendor', lookup: 'vendors' }]}
    fields={[
      { name: 'print_no', label: 'Print no', hint: 'Blank to auto-generate' },
      { name: 'print_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'print_type', label: 'Print type', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'placement', label: 'Placement', placeholder: 'e.g. Front chest' },
      { name: 'no_of_colors', label: 'Number of colours', type: 'number' },
      { name: 'vendor_id', label: 'Vendor', lookup: 'vendors' },
      ...qtyFields,
      { name: 'rate', label: 'Rate per piece', type: 'number' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROCESS' },
    ]} />;
}

export function EmbroideryPage() {
  return <CrudPage
    path="embroideries" title="Embroidery" permission="PRODUCTION" singular="Embroidery"
    subtitle="Embroidery jobs and stitch counts"
    defaultSort={{ key: 'emb_date', dir: 'desc' }}
    columns={[
      { key: 'emb_no', header: 'Emb no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.emb_no}</span> },
      { key: 'emb_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.emb_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'design_ref', header: 'Design' },
      { key: 'stitch_count', header: 'Stitches', align: 'right', render: (r: any) => fmtNumber(r.stitch_count) },
      { key: 'placement', header: 'Placement' },
      { key: 'vendor_name', header: 'Vendor' },
      ...qtyCols,
    ]}
    filters={[{ name: 'vendor_id', label: 'Vendor', lookup: 'vendors' }]}
    fields={[
      { name: 'emb_no', label: 'Embroidery no', hint: 'Blank to auto-generate' },
      { name: 'emb_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'design_ref', label: 'Design reference' },
      { name: 'stitch_count', label: 'Stitch count', type: 'number' },
      { name: 'placement', label: 'Placement' },
      { name: 'vendor_id', label: 'Vendor', lookup: 'vendors' },
      ...qtyFields,
      { name: 'rate', label: 'Rate per piece', type: 'number' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROCESS' },
    ]} />;
}

export function WashingPage() {
  const TYPES = ['NORMAL','ENZYME','STONE','ACID','BLEACH','GARMENT_DYE','SILICON','OTHER'];
  return <CrudPage
    path="washings" title="Washing" permission="PRODUCTION" singular="Washing"
    subtitle="Garment wash processes and shrinkage"
    defaultSort={{ key: 'wash_date', dir: 'desc' }}
    columns={[
      { key: 'wash_no', header: 'Wash no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.wash_no}</span> },
      { key: 'wash_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.wash_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'wash_type', header: 'Type', render: (r: any) => <Badge tone="blue">{humanize(r.wash_type)}</Badge> },
      { key: 'vendor_name', header: 'Vendor' },
      ...qtyCols,
      { key: 'shrinkage_pct', header: 'Shrinkage', align: 'right',
        render: (r: any) => r.shrinkage_pct ? `${fmtDecimal(r.shrinkage_pct, 2)}%` : '—' },
    ]}
    filters={[{ name: 'wash_type', label: 'Wash type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
              { name: 'vendor_id', label: 'Vendor', lookup: 'vendors' }]}
    fields={[
      { name: 'wash_no', label: 'Wash no', hint: 'Blank to auto-generate' },
      { name: 'wash_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'wash_type', label: 'Wash type', required: true, options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
      { name: 'vendor_id', label: 'Vendor', lookup: 'vendors' },
      ...qtyFields,
      { name: 'shrinkage_pct', label: 'Shrinkage %', type: 'number' },
      { name: 'rate', label: 'Rate per piece', type: 'number' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROCESS' },
    ]} />;
}

export function FinishingPage() {
  return <CrudPage
    path="finishings" title="Finishing" permission="PRODUCTION" singular="Finishing"
    subtitle="Trimming, ironing, checking and get-up"
    defaultSort={{ key: 'finish_date', dir: 'desc' }}
    columns={[
      { key: 'finish_no', header: 'Finish no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.finish_no}</span> },
      { key: 'finish_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.finish_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'unit_name', header: 'Unit' },
      { key: 'activity', header: 'Activities',
        render: (r: any) => r.activity
          ? <div className="flex flex-wrap gap-1">{String(r.activity).split(',').map((a) =>
              <Badge key={a} tone="slate">{humanize(a)}</Badge>)}</div> : '—' },
      ...qtyCols,
    ]}
    filters={[{ name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
              { name: 'unit_id', label: 'Unit', lookup: 'units' }]}
    fields={[
      { name: 'finish_no', label: 'Finish no', hint: 'Blank to auto-generate' },
      { name: 'finish_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'unit_id', label: 'Unit', lookup: 'units' },
      { name: 'activity', label: 'Activities', span: 2,
        hint: 'Comma-separated: TRIMMING, IRONING, CHECKING, TAGGING, FOLDING, GET_UP' },
      ...qtyFields,
      { name: 'status_id', label: 'Status', statusDomain: 'PROCESS' },
    ]} />;
}

export function ProcessTransactionsPage() {
  return <CrudPage
    path="process-transactions" title="Process Movements" permission="PRODUCTION" singular="Movement"
    subtitle="WIP movement between stages, units and job-work vendors"
    defaultSort={{ key: 'txn_date', dir: 'desc' }}
    columns={[
      { key: 'txn_no', header: 'Txn no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.txn_no}</span> },
      { key: 'txn_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.txn_date) },
      { key: 'po_prod_no', header: 'Work order' },
      { key: 'stage_name', header: 'Stage', render: (r: any) => <Badge tone="violet">{r.stage_name}</Badge> },
      { key: 'vendor_name', header: 'Vendor' },
      ...qtyCols,
      { key: 'received_qty', header: 'Returned', align: 'right', render: (r: any) => fmtNumber(r.received_qty) },
    ]}
    filters={[
      { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
      { name: 'stage_id', label: 'Stage', lookup: 'process-stages' },
      { name: 'vendor_id', label: 'Vendor', lookup: 'vendors' },
    ]}
    fields={[
      { name: 'txn_no', label: 'Transaction no', hint: 'Blank to auto-generate' },
      { name: 'txn_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
      { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
      { name: 'stage_id', label: 'Process stage', required: true, lookup: 'process-stages' },
      { name: 'from_unit', label: 'From unit', lookup: 'units' },
      { name: 'to_unit', label: 'To unit', lookup: 'units' },
      { name: 'vendor_id', label: 'Job-work vendor', lookup: 'vendors' },
      ...qtyFields,
      { name: 'received_qty', label: 'Received back qty', type: 'number' },
      { name: 'jobwork_rate', label: 'Job-work rate', type: 'number' },
      { name: 'status_id', label: 'Status', statusDomain: 'PROCESS' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}
