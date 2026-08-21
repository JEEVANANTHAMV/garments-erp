import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, fmtDecimal, humanize, today } from '../../lib/format';

/* --------------------------------------------------------- Packings */
export function PackingsPage() {
  return <CrudPage
    path="packings" title="Packing" permission="PACKING" singular="Packing"
    subtitle="Carton packing records linked to production orders"
    defaultSort={{ key: 'pack_date', dir: 'desc' }}
    columns={[
      { key: 'packing_no', header: 'Packing no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.packing_no}</span> },
      { key: 'pack_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.pack_date) },
      { key: 'so_no', header: 'Sales order',
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.so_no}</span> },
      { key: 'carton_count', header: 'Cartons', align: 'right', render: (r: any) => fmtNumber(r.carton_count) },
      { key: 'total_qty', header: 'Total qty', align: 'right', render: (r: any) => fmtNumber(r.total_qty) },
      { key: 'net_weight_kg', header: 'Net wt (kg)', align: 'right', render: (r: any) => fmtDecimal(r.net_weight_kg) },
      { key: 'gross_weight_kg', header: 'Gross wt (kg)', align: 'right', render: (r: any) => fmtDecimal(r.gross_weight_kg) },
      { key: 'cbm', header: 'CBM', align: 'right', render: (r: any) => fmtDecimal(r.cbm, 3) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'so_id', label: 'Sales order', lookup: 'sales-orders' },
      { name: 'status_id', label: 'Status', statusDomain: 'PACKING' },
    ]}
    fields={[
      { name: 'packing_no', label: 'Packing no', hint: 'Blank to auto-generate' },
      { name: 'pack_date', label: 'Pack date', type: 'date', required: true, defaultValue: today() },
      { name: 'so_id', label: 'Sales order', required: true, lookup: 'sales-orders' },
      { name: 'prod_order_id', label: 'Production order', lookup: 'prod-orders' },
      { name: 'warehouse_id', label: 'Warehouse', lookup: 'warehouses' },
      { name: 'status_id', label: 'Status', statusDomain: 'PACKING' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* -------------------------------------------------------- Dispatches */
export function DispatchesPage() {
  return <CrudPage
    path="dispatches" title="Dispatch" permission="DISPATCH" singular="Dispatch"
    subtitle="Outbound dispatch records to freight forwarders"
    defaultSort={{ key: 'dispatch_date', dir: 'desc' }}
    columns={[
      { key: 'dispatch_no', header: 'Dispatch no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.dispatch_no}</span> },
      { key: 'dispatch_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.dispatch_date) },
      { key: 'so_no', header: 'Sales order',
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.so_no}</span> },
      { key: 'carton_count', header: 'Cartons', align: 'right' },
      { key: 'total_qty', header: 'Qty', align: 'right', render: (r: any) => fmtNumber(r.total_qty) },
      { key: 'vehicle_no', header: 'Vehicle no' },
      { key: 'driver_name', header: 'Driver' },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'so_id', label: 'Sales order', lookup: 'sales-orders' },
      { name: 'status_id', label: 'Status', statusDomain: 'DISPATCH' },
    ]}
    fields={[
      { name: 'dispatch_no', label: 'Dispatch no', hint: 'Blank to auto-generate' },
      { name: 'dispatch_date', label: 'Dispatch date', type: 'date', required: true, defaultValue: today() },
      { name: 'so_id', label: 'Sales order', required: true, lookup: 'sales-orders' },
      { name: 'forwarding_agent_id', label: 'Freight forwarder', lookup: 'agents' },
      { name: 'vehicle_no', label: 'Vehicle no' },
      { name: 'driver_name', label: 'Driver name' },
      { name: 'driver_phone', label: 'Driver phone' },
      { name: 'seal_no', label: 'Seal no' },
      { name: 'status_id', label: 'Status', statusDomain: 'DISPATCH' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* ------------------------------------------------------ Containers */
export function ContainersPage() {
  const TYPES = ['20_FT', '40_FT', '40_HC', 'LCL'];
  return <CrudPage
    path="containers" title="Containers" permission="DISPATCH" singular="Container"
    subtitle="Shipping container details per dispatch"
    defaultSort={{ key: 'id', dir: 'desc' }}
    columns={[
      { key: 'container_no', header: 'Container no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.container_no}</span> },
      { key: 'container_type', header: 'Type', render: (r: any) => <Badge tone="blue">{humanize(r.container_type)}</Badge> },
      { key: 'seal_no', header: 'Seal no' },
      { key: 'dispatch_no', header: 'Dispatch' },
      { key: 'gross_weight_kg', header: 'Gross wt (kg)', align: 'right', render: (r: any) => fmtDecimal(r.gross_weight_kg) },
      { key: 'cbm', header: 'CBM', align: 'right', render: (r: any) => fmtDecimal(r.cbm, 3) },
    ]}
    filters={[
      { name: 'container_type', label: 'Container type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })) },
    ]}
    fields={[
      { name: 'container_no', label: 'Container no', required: true },
      { name: 'container_type', label: 'Container type', options: TYPES.map((v) => ({ value: v, label: humanize(v) })), defaultValue: '40_FT' },
      { name: 'seal_no', label: 'Seal no' },
      { name: 'dispatch_id', label: 'Dispatch', lookup: 'dispatches' },
      { name: 'gross_weight_kg', label: 'Gross weight (kg)', type: 'number' },
      { name: 'net_weight_kg', label: 'Net weight (kg)', type: 'number' },
      { name: 'cbm', label: 'CBM', type: 'number' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* ----------------------------------------------- Commercial invoices */
export function ExportInvoicesPage() {
  return <CrudPage
    path="commercial-invoices" title="Commercial Invoices" permission="EXPORT" singular="Invoice"
    subtitle="Export commercial invoices issued to buyers"
    defaultSort={{ key: 'invoice_date', dir: 'desc' }}
    columns={[
      { key: 'invoice_no', header: 'Invoice no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.invoice_no}</span> },
      { key: 'invoice_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.invoice_date) },
      { key: 'so_no', header: 'SO',
        render: (r: any) => <span className="font-mono text-[12px] text-brand-700">{r.so_no}</span> },
      { key: 'buyer_name', header: 'Buyer' },
      { key: 'incoterm', header: 'Incoterm' },
      { key: 'total_qty', header: 'Qty', align: 'right', render: (r: any) => fmtNumber(r.total_qty) },
      { key: 'total_value', header: 'Value', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.total_value, 2)}` },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'buyer_id', label: 'Buyer', lookup: 'buyers' },
      { name: 'status_id', label: 'Status', statusDomain: 'EXPORT_INVOICE' },
    ]}
    fields={[
      { name: 'invoice_no', label: 'Invoice no', hint: 'Blank to auto-generate' },
      { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true, defaultValue: today() },
      { name: 'so_id', label: 'Sales order', required: true, lookup: 'sales-orders' },
      { name: 'dispatch_id', label: 'Dispatch', lookup: 'dispatches' },
      { name: 'currency_id', label: 'Currency', lookup: 'currencies' },
      { name: 'incoterm', label: 'Incoterm', options: ['FOB','CIF','CFR','EXW','DDP'].map((v) => ({ value: v, label: v })) },
      { name: 'payment_terms', label: 'Payment terms' },
      { name: 'bank_id', label: 'Bank account', lookup: 'bank-accounts' },
      { name: 'status_id', label: 'Status', statusDomain: 'EXPORT_INVOICE' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* --------------------------------------------------- Shipping bills */
export function ShippingBillsPage() {
  return <CrudPage
    path="shipping-bills" title="Shipping Bills" permission="EXPORT" singular="Shipping Bill"
    subtitle="Customs shipping bill (ARE-1) for export clearance"
    defaultSort={{ key: 'sb_date', dir: 'desc' }}
    columns={[
      { key: 'sb_no', header: 'SB no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.sb_no}</span> },
      { key: 'sb_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.sb_date) },
      { key: 'invoice_no', header: 'Invoice' },
      { key: 'port_of_export', header: 'Port' },
      { key: 'total_fob_value', header: 'FOB value', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.total_fob_value, 2)}` },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[{ name: 'status_id', label: 'Status', statusDomain: 'SHIPPING_BILL' }]}
    fields={[
      { name: 'sb_no', label: 'SB no', hint: 'Blank to auto-generate' },
      { name: 'sb_date', label: 'SB date', type: 'date', required: true, defaultValue: today() },
      { name: 'invoice_id', label: 'Commercial invoice', required: true, lookup: 'export-invoices' },
      { name: 'port_of_export', label: 'Port of export', defaultValue: 'Chennai' },
      { name: 'customs_officer', label: 'Customs officer' },
      { name: 'let_export_date', label: 'Let-export date', type: 'date' },
      { name: 'total_fob_value', label: 'Total FOB value', type: 'number' },
      { name: 'currency_id', label: 'Currency', lookup: 'currencies' },
      { name: 'status_id', label: 'Status', statusDomain: 'SHIPPING_BILL' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* ------------------------------------------------------- Shipments */
export function ShipmentsPage() {
  return <CrudPage
    path="shipments" title="Shipments" permission="EXPORT" singular="Shipment"
    subtitle="BL-level shipment tracking from port to delivery"
    defaultSort={{ key: 'etd', dir: 'desc' }}
    columns={[
      { key: 'shipment_no', header: 'Shipment no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.shipment_no}</span> },
      { key: 'bl_no', header: 'BL no' },
      { key: 'vessel_name', header: 'Vessel' },
      { key: 'etd', header: 'ETD', sortable: true, render: (r: any) => fmtDate(r.etd) },
      { key: 'eta', header: 'ETA', render: (r: any) => fmtDate(r.eta) },
      { key: 'port_of_loading', header: 'POL' },
      { key: 'port_of_discharge', header: 'POD' },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[{ name: 'status_id', label: 'Status', statusDomain: 'SHIPMENT' }]}
    fields={[
      { name: 'shipment_no', label: 'Shipment no', hint: 'Blank to auto-generate' },
      { name: 'sb_id', label: 'Shipping bill', lookup: 'shipping-bills' },
      { name: 'bl_no', label: 'BL / AWB no' },
      { name: 'vessel_name', label: 'Vessel / carrier' },
      { name: 'voyage_no', label: 'Voyage no' },
      { name: 'port_of_loading', label: 'Port of loading' },
      { name: 'port_of_discharge', label: 'Port of discharge' },
      { name: 'etd', label: 'ETD', type: 'date' },
      { name: 'eta', label: 'ETA', type: 'date' },
      { name: 'actual_arrival', label: 'Actual arrival', type: 'date' },
      { name: 'freight_amt', label: 'Freight amount', type: 'number' },
      { name: 'freight_currency_id', label: 'Freight currency', lookup: 'currencies' },
      { name: 'status_id', label: 'Status', statusDomain: 'SHIPMENT' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* --------------------------------------------------- Certificates */
export function CertificatesPage() {
  return <CrudPage
    path="certificates" title="Certificates" permission="EXPORT" singular="Certificate"
    subtitle="Quality / compliance certificates attached to export shipments"
    defaultSort={{ key: 'issue_date', dir: 'desc' }}
    columns={[
      { key: 'cert_no', header: 'Cert no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.cert_no}</span> },
      { key: 'cert_type_name', header: 'Type' },
      { key: 'issue_date', header: 'Issue date', sortable: true, render: (r: any) => fmtDate(r.issue_date) },
      { key: 'expiry_date', header: 'Expiry', render: (r: any) => fmtDate(r.expiry_date) },
      { key: 'issuing_body', header: 'Issuing body' },
      { key: 'invoice_no', header: 'Invoice' },
    ]}
    filters={[{ name: 'cert_type_id', label: 'Certificate type', lookup: 'cert-types' }]}
    fields={[
      { name: 'cert_no', label: 'Certificate no', required: true },
      { name: 'cert_type_id', label: 'Certificate type', required: true, lookup: 'cert-types' },
      { name: 'invoice_id', label: 'Export invoice', lookup: 'export-invoices' },
      { name: 'issuing_body', label: 'Issuing body' },
      { name: 'issue_date', label: 'Issue date', type: 'date', defaultValue: today() },
      { name: 'expiry_date', label: 'Expiry date', type: 'date' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

/* --------------------------------------------------- Packing lists */
export function PackingListsPage() {
  return <CrudPage
    path="packing-lists" title="Packing Lists" permission="EXPORT" singular="Packing List"
    subtitle="Export packing lists per commercial invoice"
    defaultSort={{ key: 'pl_date', dir: 'desc' }}
    columns={[
      { key: 'pl_no', header: 'PL no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.pl_no}</span> },
      { key: 'pl_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.pl_date) },
      { key: 'invoice_no', header: 'Invoice' },
      { key: 'carton_count', header: 'Cartons', align: 'right' },
      { key: 'total_qty', header: 'Total qty', align: 'right', render: (r: any) => fmtNumber(r.total_qty) },
      { key: 'gross_weight_kg', header: 'Gross wt', align: 'right', render: (r: any) => fmtDecimal(r.gross_weight_kg) },
    ]}
    filters={[{ name: 'invoice_id', label: 'Invoice', lookup: 'export-invoices' }]}
    fields={[
      { name: 'pl_no', label: 'Packing list no', hint: 'Blank to auto-generate' },
      { name: 'pl_date', label: 'PL date', type: 'date', required: true, defaultValue: today() },
      { name: 'invoice_id', label: 'Commercial invoice', required: true, lookup: 'export-invoices' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}
