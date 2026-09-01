import { CrudPage } from '../../components/CrudPage';
import { StatusBadge } from '../../components/ui';
import { fmtDate, fmtDecimal, fmtNumber, humanize, today } from '../../lib/format';

export function ProductionCostsPage() {
  const STATES = ['DRAFT', 'CALCULATED', 'APPROVED', 'CLOSED'];

  return (
    <CrudPage
      path="production-costs"
      title="Actual Production Costing"
      permission="PRODUCTION"
      singular="Cost Sheet"
      subtitle="Actual cost breakdown per piece vs estimated costing"
      defaultSort={{ key: 'cost_date', dir: 'desc' }}
      columns={[
        {
          key: 'cost_no',
          header: 'Cost no',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-medium text-brand-700">{r.cost_no}</span>
          ),
        },
        { key: 'cost_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.cost_date) },
        { key: 'po_prod_no', header: 'Work order' },
        { key: 'style_code', header: 'Style' },
        {
          key: 'produced_qty',
          header: 'Produced Qty',
          align: 'right',
          render: (r: any) => fmtNumber(r.produced_qty),
        },
        {
          key: 'total_cost',
          header: 'Total Cost',
          align: 'right',
          render: (r: any) => (
            <span className="font-medium text-slate-800">{fmtDecimal(r.total_cost, 2)}</span>
          ),
        },
        {
          key: 'cost_per_piece',
          header: 'Cost / Pc',
          align: 'right',
          render: (r: any) => (
            <span className="font-semibold text-brand-700">{fmtDecimal(r.cost_per_piece, 2)}</span>
          ),
        },
        {
          key: 'variance_pct',
          header: 'Variance',
          align: 'right',
          render: (r: any) => {
            const v = Number(r.variance_pct);
            if (!v) return '—';
            return (
              <span className={v <= 0 ? 'font-medium text-emerald-600' : 'font-medium text-red-600'}>
                {v > 0 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`}
              </span>
            );
          },
        },
        { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
      ]}
      filters={[
        { name: 'prod_order_id', label: 'Work order', lookup: 'production-orders' },
        { name: 'style_id', label: 'Style', lookup: 'styles' },
        { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
      ]}
      modalSize="lg"
      fields={[
        { name: 'cost_no', label: 'Cost sheet no', hint: 'Blank to auto-generate' },
        { name: 'cost_date', label: 'Date', type: 'date', required: true, defaultValue: today() },
        { name: 'prod_order_id', label: 'Work order', required: true, lookup: 'production-orders' },
        { name: 'style_id', label: 'Style', lookup: 'styles' },
        { name: 'produced_qty', label: 'Produced quantity', type: 'number', required: true },
        { name: 'material_cost', label: 'Material cost', type: 'number' },
        { name: 'labour_cost', label: 'Labour cost', type: 'number' },
        { name: 'machine_cost', label: 'Machine cost', type: 'number' },
        { name: 'jobwork_cost', label: 'Job work cost', type: 'number' },
        { name: 'process_cost', label: 'In-house process cost', type: 'number' },
        { name: 'overhead_cost', label: 'Overhead cost', type: 'number' },
        { name: 'packing_cost', label: 'Packing cost', type: 'number' },
        { name: 'total_cost', label: 'Total cost', type: 'number', required: true },
        { name: 'cost_per_piece', label: 'Cost per piece', type: 'number', required: true },
        { name: 'estimated_cost', label: 'Estimated cost (Pre-sales)', type: 'number' },
        { name: 'variance', label: 'Variance (Actual - Est)', type: 'number' },
        { name: 'variance_pct', label: 'Variance %', type: 'number' },
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
