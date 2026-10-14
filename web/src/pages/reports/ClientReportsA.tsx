/**
 * Client report set A — orders, budget, production, logistics.
 * The client's own report formats (tracker "Business Process(New)" rows 121-158),
 * shown separately from the default reports. Server: /api/client-reports/*.
 */
import { ReportSection, type ReportColumn, type ReportDef, type ReportFilter } from './clientReportKit';

/* ------------------------------------------------------------ drill-down targets */
const soLink = (r: any) => (r.so_id ? `/sales/orders/${r.so_id}` : null);
const invoiceLink = (r: any) => (r.invoice_id ? `/export/invoices?q=${encodeURIComponent(r.invoice_no ?? '')}` : null);
const dispatchLink = (r: any) => (r.dispatch_id ? `/logistics/dispatches/${r.dispatch_id}` : null);
const shipmentLink = (r: any) => (r.shipment_id ? `/logistics/shipments/${r.shipment_id}` : null);
const outputLink = (r: any) => {
  if (r.src === 'DC_INWARD') return `/production/jobwork-challans?dc=${r.dc_id}`;
  if (r.src === 'SEWING_OUTPUT') return '/production/sewing-finishing';
  if (r.src === 'SEWING_DAILY') return '/production/sewing-daily-output';
  if (r.src === 'DAILY_OUTPUT') return '/production/daily-outputs';
  return null;
};

/* ------------------------------------------------------------------ filters */
const today = new Date();
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = iso(new Date(today.getFullYear(), today.getMonth(), 1));

const F = {
  status: (def = 'open'): ReportFilter => ({
    key: 'status', label: 'Order status', type: 'select', default: def, required: true,
    options: [
      { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' },
      { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' },
    ],
  }),
  buyer: { key: 'buyer_id', label: 'Buyer', type: 'select', lookup: 'buyers' } as ReportFilter,
  season: { key: 'season', label: 'Season', type: 'text', placeholder: 'e.g. SS26' } as ReportFilter,
  from: (label = 'From', def?: string): ReportFilter => ({ key: 'dateFrom', label, type: 'date', default: def }),
  to: (label = 'To'): ReportFilter => ({ key: 'dateTo', label, type: 'date' }),
};

/* ------------------------------------------------------- budget vs actual columns */
const bvaPair = (key: string, label: string, withDiff = true): ReportColumn[] => [
  { key: `${key}_budget`, header: `${label} Budget`, type: 'money', total: true },
  { key: `${key}_actual`, header: `${label} Actual`, type: 'money', total: true },
  ...(withDiff ? [{ key: `${key}_diff`, header: `Diff ${label} Budget Vs Actual`, type: 'money' as const, total: true }] : []),
];

const bvaColumns = (consolidated: boolean): ReportColumn[] => [
  { key: 'buyer_name', header: 'BUYER' },
  { key: 'inv_month', header: 'INV MONTH' },
  { key: 'so_no', header: 'SO NO', link: consolidated ? undefined : soLink },
  ...(consolidated ? [{ key: 'orders', header: 'Orders', type: 'int' as const, total: true }] : []),
  { key: 'currency', header: 'Currency' },
  { key: 'exchange_rate', header: 'Exchange Rate', type: 'qty' },
  { key: 'actual_exrate', header: 'Actual Exrate', type: 'qty',
    footnote: 'Weighted exchange rate of the order\'s commercial invoices; blank until invoiced.' },
  { key: 'order_qty', header: 'Order Qty', type: 'qty', total: true },
  { key: 'cut_qty', header: 'Cut Qty', type: 'qty', total: true },
  { key: 'ship_qty', header: 'Ship Qty', type: 'qty', total: true },
  { key: 'order_to_cut_diff', header: 'Order To Cut Diff', type: 'qty', total: true },
  { key: 'cut_to_ship_diff', header: 'Cut To Ship Diff', type: 'qty', total: true },
  { key: 'order_to_ship_diff', header: 'Order To Ship Diff', type: 'qty', total: true },
  { key: 'sale_budget', header: 'Sale Value - Budget', type: 'money', total: true },
  { key: 'sale_actual', header: 'Sale Value -Actual', type: 'money', total: true },
  { key: 'sale_diff', header: 'Diff Sale Value Budget Vs Actual', type: 'money', total: true },
  ...bvaPair('y2f', 'Yarn to Fab'),
  ...bvaPair('cmt', 'CMT Cost'),
  ...bvaPair('sew_trims', 'Sew Trims'),
  ...bvaPair('pack_trims', 'Pack Trims'),
  { key: 'var_oh_budget', header: 'Variable OH Budget', type: 'money', total: true },
  { key: 'var_oh_actual', header: 'Variable OH Actual', type: 'money', total: true,
    footnote: 'Commission, freight, testing and finance actuals are not posted against orders in the ERP — left blank.' },
  { key: 'var_oh_diff', header: 'Diff Variable OH Budget Vs Actual', type: 'money', total: true },
  ...bvaPair('fixed_oh', 'Fixed OH'),
  ...bvaPair('total_exp', 'Total Exp'),
  ...bvaPair('net_profit', 'Net Profit'),
  { key: 'profit_pct_budget', header: 'Budget Profit %', type: 'pct' },
  { key: 'profit_pct_actual', header: 'Actual Profit %', type: 'pct' },
  { key: 'profit_pct_diff', header: 'Difference in Profit %', type: 'pct' },
  ...(consolidated ? [] : [
    { key: 'costing_nos', header: 'Pre-costing', link: (r: any) => (r.costing_id ? `/sales/pre-costings/${r.costing_id}` : null) },
    { key: 'cost_nos', header: 'Production costing', link: (r: any) => (r.cost_id ? `/production/costs/${r.cost_id}` : null) },
  ]),
];

/* ------------------------------------------------------------------ reports */
export const CLIENT_REPORTS_A: ReportDef[] = [
  {
    key: 'orders-in-hand', title: 'Sale Order Report — Orders in Hand',
    subtitle: 'Open / closed / cancelled / all sale orders with production, shipment, balance and over-due days',
    endpoint: '/client-reports/orders-in-hand',
    filters: [F.status('open'), F.buyer, F.season, F.from('Order from'), F.to('Order to')],
    columns: [
      { key: 'buyer_name', header: 'Buyername' },
      { key: 'so_no', header: 'Sale Order No', link: soLink },
      { key: 'buyer_po_no', header: 'PO Number' },
      { key: 'season', header: 'Season' },
      { key: 'style_no', header: 'Style No' },
      { key: 'so_date', header: 'Ord Rec Date', type: 'date' },
      { key: 'delivery_date', header: 'Del Date', type: 'date' },
      { key: 'order_qty', header: 'Ord Qty', type: 'qty', total: true },
      { key: 'prod_qty', header: 'Prod Qty', type: 'qty', total: true },
      { key: 'uom', header: 'Uom' },
      { key: 'shipped_qty', header: 'Shipped Qty', type: 'qty', total: true },
      { key: 'ship_balance', header: 'Ship Bal', type: 'qty', total: true },
      { key: 'currency', header: 'Currency' },
      { key: 'balance_value', header: 'Balance value', type: 'money', total: true },
      { key: 'overdue_days', header: 'Over Due Days', type: 'int',
        render: (r) => (Number(r.overdue_days) > 0 ? <span className="font-semibold text-red-600">{r.overdue_days}</span> : '0') },
      { key: 'status', header: 'Status' },
    ],
  },
  {
    key: 'order-status', title: 'Order Status',
    subtitle: 'Purchase / receipt completeness against the job\'s material requirement, and the current production stage',
    endpoint: '/client-reports/order-status',
    filters: [F.status('open'), F.buyer, F.season, F.from('Order from'), F.to('Order to')],
    columns: [
      { key: 'so_no', header: 'Order Nr.', link: soLink },
      { key: 'customer_name', header: 'Customer Name' },
      { key: 'all_po_raised', header: 'All Purchase Orders raised (Yes / No)', type: 'yn' },
      { key: 'all_goods_received', header: 'All Goods Received (Yes / No)', type: 'yn' },
      { key: 'planned_despatch_date', header: 'Planned despatch date', type: 'date' },
      { key: 'order_qty', header: 'Order Quantity', type: 'qty', total: true },
      { key: 'balance_to_despatch', header: 'Balance qty to be despatched', type: 'qty', total: true },
      { key: 'current_stage', header: 'Current Stage (Yarn / Fabric / Cut panel / Garment)' },
      { key: 'req_items', header: 'Req. items', type: 'int' },
      { key: 'po_pending_items', header: 'PO pending items', type: 'int' },
      { key: 'grn_pending_items', header: 'GRN pending items', type: 'int' },
      { key: 'cut_qty', header: 'Cut qty', type: 'qty', total: true },
      { key: 'garment_qty', header: 'Garment qty', type: 'qty', total: true },
    ],
  },
  {
    key: 'ocr', title: 'Order Completion Report (OCR)',
    subtitle: 'Closed orders — budget vs actual per sale order',
    endpoint: '/client-reports/budget-vs-actuals',
    filters: [F.status('closed'), F.buyer, F.season, F.from('Order from'), F.to('Order to')],
    columns: bvaColumns(false),
  },
  {
    key: 'budget-sheet', title: 'Budget Sheet',
    subtitle: 'Approved pre-costing × order quantity, by cost head (INR)',
    endpoint: '/client-reports/budget-vs-actuals',
    filters: [F.status('open'), F.buyer, F.season, F.from('Order from'), F.to('Order to')],
    columns: [
      { key: 'buyer_name', header: 'Buyer' },
      { key: 'so_no', header: 'SO No', link: soLink },
      { key: 'costing_nos', header: 'Pre-costing', link: (r) => (r.costing_id ? `/sales/pre-costings/${r.costing_id}` : null) },
      { key: 'currency', header: 'Currency' },
      { key: 'exchange_rate', header: 'Exchange Rate', type: 'qty' },
      { key: 'order_qty', header: 'Order Qty', type: 'qty', total: true },
      { key: 'sale_budget', header: 'Sale Value', type: 'money', total: true },
      { key: 'y2f_budget', header: 'Yarn to Fab', type: 'money', total: true },
      { key: 'cmt_budget', header: 'CMT Cost', type: 'money', total: true },
      { key: 'sew_trims_budget', header: 'Sew Trims', type: 'money', total: true },
      { key: 'pack_trims_budget', header: 'Pack Trims', type: 'money', total: true },
      { key: 'var_oh_budget', header: 'Variable OH', type: 'money', total: true },
      { key: 'fixed_oh_budget', header: 'Fixed OH', type: 'money', total: true },
      { key: 'total_exp_budget', header: 'Total Exp', type: 'money', total: true },
      { key: 'net_profit_budget', header: 'Net Profit', type: 'money', total: true },
      { key: 'profit_pct_budget', header: 'Profit %', type: 'pct' },
    ],
  },
  {
    key: 'budget-vs-actuals', title: 'Budget vs Actuals',
    subtitle: 'Per sale order — sale value and cost heads, budget against actual (INR)',
    endpoint: '/client-reports/budget-vs-actuals',
    filters: [F.status('all'), F.buyer, F.season, F.from('Order from'), F.to('Order to')],
    columns: bvaColumns(false),
  },
  {
    key: 'consolidated-bva', title: 'Consolidated Budget vs Actuals',
    subtitle: 'Buyer × invoice month — totals of the per-order budget vs actuals (INR)',
    endpoint: '/client-reports/budget-vs-actuals?group=buyer',
    filters: [F.status('all'), F.buyer, F.season, F.from('Order from'), F.to('Order to')],
    columns: bvaColumns(true),
  },
  {
    key: 'production-output', title: 'Production Output Report',
    subtitle: 'Activity-wise output — contractor DC inwards and in-house line output, budget vs bill',
    endpoint: '/client-reports/production-output',
    filters: [
      F.from('Output from', monthStart), F.to('Output to'), F.buyer,
      { key: 'source', label: 'Company shift', type: 'select', placeholder: 'All',
        options: [{ value: 'inhouse', label: 'Yes (in-house)' }, { value: 'contractor', label: 'No (contractor)' }] },
    ],
    columns: [
      { key: 'output_date', header: 'Output Date', type: 'date' },
      { key: 'doc_no', header: 'Entry', link: outputLink },
      { key: 'sale_order', header: 'Sale Order', link: soLink },
      { key: 'style_description', header: 'Style Description' },
      { key: 'party', header: 'Party' },
      { key: 'company_shift', header: 'Company Shift (Yes / No)' },
      { key: 'process', header: 'Process' },
      { key: 'process_group', header: 'Process Group' },
      { key: 'output_qty', header: 'Output Qty', type: 'qty', total: true },
      { key: 'budget_rate', header: 'Budget Rate', type: 'money' },
      { key: 'budget_amount', header: 'Budget Amount', type: 'money', total: true },
      { key: 'bill_rate', header: 'Bill Rate', type: 'money' },
      { key: 'bill_amount', header: 'Bill Amount', type: 'money', total: true },
      { key: 'production_unit', header: 'Production Unit' },
    ],
  },
  {
    key: 'invoice-despatch-pending', title: 'Invoice Made, Despatch Pending',
    subtitle: 'Despatch pending — invoice raised, but not despatched',
    endpoint: '/client-reports/invoice-despatch-pending',
    filters: [F.buyer, F.from('Invoice from'), F.to('Invoice to')],
    columns: [
      { key: 'buyer_name', header: 'Buyer Name' },
      { key: 'invoice_no', header: 'Inv No', link: invoiceLink },
      { key: 'invoice_date', header: 'Invoice Date', type: 'date' },
      { key: 'so_no', header: 'Sale Order', link: soLink },
      { key: 'style_no', header: 'Style No' },
      { key: 'qty', header: 'Qty', type: 'qty', total: true },
      { key: 'price', header: 'Price', type: 'money' },
      { key: 'amount', header: 'Amt', type: 'money', total: true },
      { key: 'hanger_amt', header: 'Hanger Amt', type: 'money',
        footnote: 'Commercial invoices carry no separate hanger charge in the ERP — left blank.' },
      { key: 'currency', header: 'Currency' },
      { key: 'value_inr', header: 'Value (INR)', type: 'money', total: true },
      { key: 'hanger_value', header: 'Hanger Value', type: 'money' },
      { key: 'total_inr', header: 'Total INR Value', type: 'money', total: true },
      { key: 'ship_port', header: 'Ship Port' },
      { key: 'age', header: 'Age', type: 'int' },
    ],
  },
  {
    key: 'despatch-sb-pending', title: 'Despatches Made, Shipping Bill Pending',
    subtitle: 'Despatches whose shipment / invoice has no shipping bill yet',
    endpoint: '/client-reports/despatch-sb-pending',
    filters: [F.buyer, F.from('Despatch from'), F.to('Despatch to')],
    columns: [
      { key: 'dispatch_no', header: 'Despatch No', link: dispatchLink },
      { key: 'dispatch_date', header: 'Despatch Date', type: 'date' },
      { key: 'buyer_name', header: 'Buyer' },
      { key: 'so_no', header: 'Sale Order', link: soLink },
      { key: 'io_no', header: 'IO No' },
      { key: 'shipment_no', header: 'Shipment', link: shipmentLink },
      { key: 'invoice_no', header: 'Invoice', link: invoiceLink },
      { key: 'mode', header: 'Mode' },
      { key: 'vehicle_no', header: 'Vehicle' },
      { key: 'total_cartons', header: 'Cartons', type: 'int', total: true },
      { key: 'total_qty', header: 'Qty', type: 'qty', total: true },
      { key: 'port', header: 'Port' },
      { key: 'age', header: 'Age (days)', type: 'int' },
    ],
  },
  {
    key: 'orders-closed', title: 'Orders Closed During a Period',
    subtitle: 'Closed and short-closed sale orders by closing date',
    endpoint: '/client-reports/orders-closed?kind=closed',
    filters: [F.from('Closed from'), F.to('Closed to'), F.buyer, F.season],
    columns: closedCols('Closed'),
  },
  {
    key: 'orders-cancelled', title: 'Orders Cancelled During a Period',
    subtitle: 'Cancelled sale orders by cancellation date',
    endpoint: '/client-reports/orders-closed?kind=cancelled',
    filters: [F.from('Cancelled from'), F.to('Cancelled to'), F.buyer, F.season],
    columns: closedCols('Cancelled'),
  },
  {
    key: 'tna-status', title: 'Time & Action — Plan and Status',
    subtitle: 'Every T&A activity with planned vs actual dates and delay',
    endpoint: '/client-reports/tna-status',
    filters: [
      F.buyer, F.from('Due from'), F.to('Due to'),
      { key: 'health', label: 'Activity status', type: 'select', placeholder: 'All',
        options: [{ value: 'pending', label: 'Pending' }, { value: 'delayed', label: 'Delayed' }, { value: 'completed', label: 'Completed' }] },
    ],
    columns: [
      { key: 'tna_no', header: 'T&A No', link: (r) => `/tna/${r.tna_id}` },
      { key: 'so_no', header: 'Sale Order', link: soLink },
      { key: 'buyer_name', header: 'Buyer' },
      { key: 'style_no', header: 'Style' },
      { key: 'shipment_date', header: 'Ship Date', type: 'date' },
      { key: 'sequence_no', header: 'Seq', type: 'int' },
      { key: 'activity_name', header: 'Activity' },
      { key: 'department_name', header: 'Department' },
      { key: 'responsible', header: 'Responsible' },
      { key: 'planned_start_date', header: 'Planned Start', type: 'date' },
      { key: 'planned_end_date', header: 'Planned End', type: 'date' },
      { key: 'actual_start_date', header: 'Actual Start', type: 'date' },
      { key: 'actual_end_date', header: 'Actual End', type: 'date' },
      { key: 'status', header: 'Status' },
      { key: 'delay_days', header: 'Delay Days', type: 'int',
        render: (r) => (Number(r.delay_days) > 0 ? <span className="font-semibold text-red-600">{r.delay_days}</span> : '0') },
    ],
  },
  {
    key: 'master-chart-exports', title: 'Master Chart — Exports',
    subtitle: 'Every export invoice with its order, shipment and shipping bill',
    endpoint: '/client-reports/master-chart-exports',
    filters: [F.buyer, F.season, F.from('Invoice from'), F.to('Invoice to')],
    columns: [
      { key: 'invoice_no', header: 'Invoice No', link: invoiceLink },
      { key: 'invoice_date', header: 'Invoice Date', type: 'date' },
      { key: 'buyer_name', header: 'Buyer' },
      { key: 'so_no', header: 'Sale Order', link: soLink },
      { key: 'buyer_po_no', header: 'PO Number' },
      { key: 'season', header: 'Season' },
      { key: 'style_no', header: 'Style' },
      { key: 'qty', header: 'Qty', type: 'qty', total: true },
      { key: 'currency', header: 'Currency' },
      { key: 'incoterm', header: 'Incoterm' },
      { key: 'fob_value', header: 'FOB Value', type: 'money', total: true },
      { key: 'total_value', header: 'Invoice Value', type: 'money', total: true },
      { key: 'exchange_rate', header: 'Ex Rate', type: 'qty' },
      { key: 'value_inr', header: 'Value (INR)', type: 'money', total: true },
      { key: 'port_of_loading', header: 'Port of Loading' },
      { key: 'port_of_discharge', header: 'Port of Discharge' },
      { key: 'final_destination', header: 'Destination' },
      { key: 'shipment_no', header: 'Shipment', link: shipmentLink },
      { key: 'vessel_name', header: 'Vessel' },
      { key: 'bl_no', header: 'BL No' },
      { key: 'bl_date', header: 'BL Date', type: 'date' },
      { key: 'sb_no', header: 'Shipping Bill', link: (r) => (r.shipping_bill_id ? '/export/shipping-bills' : null) },
      { key: 'sb_date', header: 'SB Date', type: 'date' },
      { key: 'leo_date', header: 'LEO Date', type: 'date' },
      { key: 'drawback_amount', header: 'Drawback', type: 'money', total: true },
      { key: 'rodtep_amount', header: 'RoDTEP', type: 'money', total: true },
      { key: 'invoice_status', header: 'Status' },
    ],
  },
];

function closedCols(what: string): ReportColumn[] {
  return [
    { key: 'action_date', header: `${what} Date`, type: 'date' },
    { key: 'buyer_name', header: 'Buyer' },
    { key: 'so_no', header: 'Sale Order No', link: soLink },
    { key: 'buyer_po_no', header: 'PO Number' },
    { key: 'season', header: 'Season' },
    { key: 'style_no', header: 'Style No' },
    { key: 'so_date', header: 'Ord Rec Date', type: 'date' },
    { key: 'order_qty', header: 'Ord Qty', type: 'qty', total: true },
    { key: 'shipped_qty', header: 'Shipped Qty', type: 'qty', total: true },
    { key: 'unshipped_qty', header: 'Unshipped Qty', type: 'qty', total: true },
    { key: 'currency', header: 'Currency' },
    { key: 'order_value', header: 'Order Value', type: 'money', total: true },
    { key: 'unshipped_value', header: 'Unshipped Value', type: 'money', total: true },
    { key: 'reason', header: 'Reason' },
    { key: 'action_by', header: `${what} By` },
  ];
}

export default function ClientReportsAPage() {
  return (
    <ReportSection
      title="Client Reports — Orders, Budget, Production & Logistics"
      subtitle="Your report formats. Click any document number to open the entry; Excel exports the filtered rows with totals."
      defs={CLIENT_REPORTS_A}
    />
  );
}
