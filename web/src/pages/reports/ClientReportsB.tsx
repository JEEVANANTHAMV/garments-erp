/**
 * Client report set B (client tracker, "Business Process(New)" rows 121-158): purchase, stores, gate, bills, users.
 * Kept separate from the default reports, as the client asked. Server: /api/client-reports/b/*.
 * Every report: filters, quick search, totals, Excel export and drill-down to the source document (clientReportKit).
 */
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { http } from '../../lib/api';
import { ClientReport, type ReportDef, type ReportFilter } from './clientReportKit';
import { useAuth } from '../../lib/auth';

const DONE_PENDING: ReportFilter = { key: 'status', label: 'Status', type: 'select', default: 'pending',
  options: [{ value: 'pending', label: 'Pending' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }] };
const FROM: ReportFilter = { key: 'dateFrom', label: 'From', type: 'date' };
const TO: ReportFilter = { key: 'dateTo', label: 'To', type: 'date' };
const PARTY: ReportFilter = { key: 'party_id', label: 'Supplier / job worker', type: 'select', lookup: 'payables' };
const ITEM_GROUPS = [{ value: 'YARN', label: 'Yarn' }, { value: 'FABRIC', label: 'Fabric' }, { value: 'TRIM', label: 'Trims / accessories' },
  { value: 'WIP', label: 'WIP (cut panel / garment)' }, { value: 'FINISHED', label: 'Finished goods' }];
const link = (k: string) => (r: any) => r[k] || null;

/* ------------------------------------------------------------------ report definitions */
const grir: ReportDef = {
  key: 'grir', title: 'GR / IR Report', subtitle: 'Goods received, invoice not accounted — GRN vs bill passed (done / pending / all)',
  endpoint: '/client-reports/b/grir',
  filters: [DONE_PENDING, { key: 'source', label: 'GRN source', type: 'select', options: [
    { value: 'PURCHASE', label: 'Yarn / fabric purchase' }, { value: 'TRIM', label: 'Trims' }, { value: 'GENERAL', label: 'General purchase' },
    { value: 'FABRIC_PROCESS', label: 'Fabric process inward' }, { value: 'YARN_PROCESS', label: 'Yarn process inward' }, { value: 'KNITTING', label: 'Knitting GRN' },
    { value: 'JOBWORK', label: 'Garment process inward' }] }, PARTY, FROM, TO],
  columns: [
    { key: 'grn_no', header: 'GRN No', link: link('grn_link') },
    { key: 'grn_date', header: 'GRN Date', type: 'date' },
    { key: 'grn_type', header: 'GRN Type' },
    { key: 'unit', header: 'Unit' },
    { key: 'party_dc_no', header: 'Party DC No' },
    { key: 'party_dc_date', header: 'Supplier DC Date', type: 'date' },
    { key: 'po_no', header: 'PO No', link: link('po_link') },
    { key: 'party', header: 'Party' },
    { key: 'location', header: 'Rec Location' },
    { key: 'item', header: 'Item Description' },
    { key: 'uom', header: 'UOM' },
    { key: 'in_qty', header: 'In Qty', type: 'qty', total: true },
    { key: 'in_amt', header: 'In Amt', type: 'money', total: true },
    { key: 'in_amt_gst', header: 'Item Value (GST)', type: 'money', total: true },
    { key: 'bill_qty', header: 'Bill Qty', type: 'qty', total: true },
    { key: 'bill_amt', header: 'Bill Amt', type: 'money', total: true },
    { key: 'bal_qty', header: 'Bal Qty', type: 'qty', total: true },
    { key: 'bal_amt', header: 'Bal Amt', type: 'money', total: true },
    { key: 'age', header: 'Age From GR Date', type: 'int' },
    { key: 'stores_passed_date', header: 'Stores Passed Date', type: 'date' },
    { key: 'gate_entry_no', header: 'Gate Entry No', link: link('gate_link') },
    { key: 'bill_no', header: 'Bill No', link: link('bill_link') },
    { key: 'bill_date', header: 'Bill Date' },
    { key: 'prepared_by', header: 'Prepared By' },
    { key: 'status', header: 'Status' },
  ],
};

const poGrnBill: ReportDef = {
  key: 'po-grn-bill', title: 'PO vs GRN vs Bill Pass', subtitle: 'Quantity and rate at each stage, per PO line',
  endpoint: '/client-reports/b/po-grn-bill',
  filters: [{ key: 'status', label: 'Status', type: 'select', default: 'all', options: [
    { value: 'all', label: 'All' }, { value: 'grn_pending', label: 'GRN pending' }, { value: 'bill_pending', label: 'Bill pending' },
    { value: 'complete', label: 'Complete' }, { value: 'variance', label: 'Qty / rate variance' }] }, PARTY, FROM, TO],
  columns: [
    { key: 'kind', header: 'Type' },
    { key: 'po_no', header: 'PO No', link: link('po_link') },
    { key: 'po_date', header: 'PO Date', type: 'date' },
    { key: 'party', header: 'Supplier' },
    { key: 'item', header: 'Item' },
    { key: 'uom', header: 'UOM' },
    { key: 'po_qty', header: 'PO Qty', type: 'qty', total: true },
    { key: 'po_rate', header: 'PO Rate', type: 'money' },
    { key: 'po_amt', header: 'PO Amt', type: 'money', total: true },
    { key: 'grn_nos', header: 'GRN No(s)', link: link('grn_link') },
    { key: 'grn_qty', header: 'GRN Qty', type: 'qty', total: true },
    { key: 'grn_rate', header: 'GRN Rate', type: 'money' },
    { key: 'grn_amt', header: 'GRN Amt', type: 'money', total: true },
    { key: 'bill_nos', header: 'Bill No(s)', link: link('bill_link') },
    { key: 'bill_qty', header: 'Bill Qty', type: 'qty', total: true },
    { key: 'bill_rate', header: 'Bill Rate', type: 'money' },
    { key: 'bill_amt', header: 'Bill Amt', type: 'money', total: true },
    { key: 'po_grn_bal', header: 'PO → GRN Bal', type: 'qty', total: true },
    { key: 'grn_bill_bal', header: 'GRN → Bill Bal', type: 'qty', total: true },
    { key: 'qty_variance', header: 'Qty Var (GRN−PO)', type: 'qty' },
    { key: 'rate_variance', header: 'Rate Var (Bill−PO)', type: 'money' },
    { key: 'short_closed', header: 'Short Closed', type: 'yn' },
    { key: 'status', header: 'Status' },
  ],
};

const DC_TYPES = [{ value: 'JW_CHALLAN', label: 'Process / job-work DC' }, { value: 'FABRIC_PROCESS_DC', label: 'Fabric process DC' },
  { value: 'YARN_PROCESS_DC', label: 'Yarn process DC' }, { value: 'KNITTING_DC', label: 'Knitting DC' }, { value: 'YARN_DC', label: 'Yarn issue DC' },
  { value: 'PURCHASE_RETURN', label: 'Purchase return DC' }, { value: 'DISPATCH', label: 'Dispatch' },
  { value: 'STOCK_DELIVERY', label: 'Stock delivery' }, { value: 'GENERAL_DELIVERY', label: 'General delivery' }];
const dcGateCols: ReportDef['columns'] = [
  { key: 'del_type', header: 'Del Type' },
  { key: 'del_no', header: 'Del No', link: link('dc_link') },
  { key: 'del_date', header: 'Del Date', type: 'date' },
  { key: 'created_on', header: 'Created On', type: 'date' },
  { key: 'from_location', header: 'From Location' },
  { key: 'to_party', header: 'To Party / Location' },
  { key: 'prepared_by', header: 'Prepared By' },
  { key: 'gate_pass_no', header: 'Gate Pass No', link: link('gate_link') },
  { key: 'gate_entry_time', header: 'Gate Entry Time' },
  { key: 'gate_status', header: 'Gate Status' },
  { key: 'unit', header: 'Unit' },
  { key: 'del_qty', header: 'Del Qty', type: 'qty', total: true },
  { key: 'uom', header: 'UOM' },
  { key: 'incharge', header: 'Incharge' },
  { key: 'age', header: 'Age', type: 'int' },
  { key: 'job_close', header: 'Job Close', type: 'date' },
  { key: 'job_status', header: 'Job Status' },
];
const dcGate: ReportDef = {
  key: 'dc-gate-outward', title: 'Our DC vs Gate Outward', subtitle: 'Gate delivery pending register — every outward DC and its gate pass',
  endpoint: '/client-reports/b/dc-gate-outward',
  filters: [DONE_PENDING, { key: 'dc_type', label: 'DC type', type: 'select', options: DC_TYPES }, FROM, TO],
  columns: dcGateCols,
};
const dcGatePending: ReportDef = { ...dcGate, key: 'dc-gate-pending', title: 'DC made, gate outward pending', subtitle: 'Our DCs with no gate pass yet',
  filters: [{ ...DONE_PENDING, default: 'pending' }, { key: 'dc_type', label: 'DC type', type: 'select', options: DC_TYPES }, FROM, TO] };

const inwardCols: ReportDef['columns'] = [
  { key: 'gate_entry_at', header: 'Gate Entry Date/Time' },
  { key: 'gate_inward_no', header: 'Gate Inward No', link: link('gate_link') },
  { key: 'party_dc_no', header: 'Party DC No' },
  { key: 'party_dc_date', header: 'Party DC Date', type: 'date' },
  { key: 'vehicle_no', header: 'Vehicle No' },
  { key: 'party', header: 'Party Name' },
  { key: 'department', header: 'Department' },
  { key: 'delivery_qty', header: 'Delivery Qty', type: 'qty', total: true },
  { key: 'uom', header: 'UOM' },
  { key: 'inward_status', header: 'Inward Status' },
  { key: 'remarks', header: 'Remarks' },
  { key: 'grn_nos', header: 'GRN No(s)', link: link('grn_link') },
  { key: 'grn_created_on', header: 'GRN Created On', type: 'date' },
  { key: 'unit', header: 'Unit Name' },
  { key: 'user', header: 'User Id / Name' },
  { key: 'dc_to_gate_days', header: 'DC → Gate (days)', type: 'int' },
  { key: 'age', header: 'Age', type: 'int' },
];
const dcInward: ReportDef = {
  key: 'dc-inward-grn', title: 'DC vs Inward vs GRN', subtitle: 'Party DC date vs gate inward date vs GRN date (GRN done / pending / all)',
  endpoint: '/client-reports/b/dc-inward-grn', filters: [{ ...DONE_PENDING, label: 'GRN status' }, PARTY, FROM, TO], columns: inwardCols,
};
const inwardGrnPending: ReportDef = { ...dcInward, key: 'gate-inward-grn-pending', title: 'Gate inward made, GRN pending',
  subtitle: 'Parameter: GRN status — complete / pending / all' };
const dcWithoutGate: ReportDef = {
  key: 'dc-without-gate', title: 'Party DC vs Gate inward pending', subtitle: 'Receipts recorded against a party DC with no gate inward entry',
  endpoint: '/client-reports/b/dc-without-gate', filters: [FROM, TO],
  columns: [
    { key: 'doc_type', header: 'Document' },
    { key: 'doc_no', header: 'Doc No', link: link('doc_link') },
    { key: 'doc_date', header: 'Doc Date', type: 'date' },
    { key: 'party_dc_no', header: 'Party DC No' },
    { key: 'party', header: 'Party' },
    { key: 'prepared_by', header: 'Prepared By' },
    { key: 'created_on', header: 'Created On', type: 'date' },
    { key: 'age', header: 'Age', type: 'int' },
  ],
};

const billTracker: ReportDef = {
  key: 'bill-tracker', title: 'Bill Tracker', subtitle: 'Bill movement: received → handed over → back → submitted to accounts',
  endpoint: '/client-reports/b/bill-tracker',
  filters: [{ ...DONE_PENDING, label: 'Submitted to accounts', default: 'all' }, FROM, TO],
  columns: [
    { key: 'sno', header: 'S.No', type: 'int' },
    { key: 'entry_date', header: 'Date', type: 'date' },
    { key: 'bill_no', header: 'Bill #', link: link('doc_link') },
    { key: 'bill_date', header: 'Bill Dt', type: 'date' },
    { key: 'supplier', header: 'Supplier' },
    { key: 'purchase_process', header: 'Purchase / Process Name' },
    { key: 'amount', header: 'Amount', type: 'money', total: true },
    { key: 'handed_over_to', header: 'Handed over To' },
    { key: 'department', header: 'Hand over department' },
    { key: 'handover_date', header: 'Hand over date', type: 'date' },
    { key: 'received_back_date', header: 'Received back (date)', type: 'date' },
    { key: 'submitted_to_accounts_on', header: 'Submitted to accounts on', type: 'date' },
    { key: 'ac_recipient', header: 'A/c recipient Name' },
    { key: 'status', header: 'Status' },
    { key: 'age', header: 'Age', type: 'int' },
  ],
};

const directBills: ReportDef = {
  key: 'direct-bills', title: 'Direct bills passed', subtitle: 'Bills passed during a period without a PO / GRN',
  endpoint: '/client-reports/b/direct-bills', filters: [FROM, TO, PARTY],
  columns: [
    { key: 'source', header: 'Source' },
    { key: 'bill_type', header: 'Type' },
    { key: 'doc_no', header: 'Doc No', link: link('doc_link') },
    { key: 'doc_date', header: 'Date', type: 'date' },
    { key: 'party', header: 'Supplier' },
    { key: 'party_bill_no', header: 'Party Bill No' },
    { key: 'party_bill_date', header: 'Party Bill Date', type: 'date' },
    { key: 'taxable', header: 'Taxable', type: 'money', total: true },
    { key: 'gst', header: 'GST', type: 'money', total: true },
    { key: 'total', header: 'Total', type: 'money', total: true },
    { key: 'status', header: 'Status' },
    { key: 'prepared_by', header: 'Prepared By' },
  ],
};

const openingStock: ReportDef = {
  key: 'opening-stock', title: 'Opening stock register', subtitle: 'Opening stock made during a period',
  endpoint: '/client-reports/b/opening-stock',
  filters: [FROM, TO, { key: 'item_group', label: 'Item group', type: 'select', options: ITEM_GROUPS }, { key: 'warehouse_id', label: 'Location', type: 'select', lookup: 'warehouses' }],
  columns: [
    { key: 'doc_id', header: 'Docid', link: link('doc_link') },
    { key: 'doc_date', header: 'Docdate', type: 'date' },
    { key: 'party', header: 'Party Name' },
    { key: 'location', header: 'Location' },
    { key: 'process', header: 'Process Name' },
    { key: 'so_no', header: 'Sale Order No' },
    { key: 'style_no', header: 'Style No' },
    { key: 'season', header: 'Season' },
    { key: 'buyer', header: 'Buyer' },
    { key: 'item', header: 'Item Name' },
    { key: 'item_type', header: 'Item Type' },
    { key: 'color', header: 'Color' },
    { key: 'size', header: 'Sizes' },
    { key: 'description', header: 'Description' },
    { key: 'uom', header: 'Uom' },
    { key: 'qty', header: 'Qty', type: 'qty', total: true },
    { key: 'rate', header: 'Rate', type: 'money' },
    { key: 'amount', header: 'Amount', type: 'money', total: true },
    { key: 'prepared_by', header: 'Prepby' },
    { key: 'remarks', header: 'Remarks' },
    { key: 'order_type', header: 'Order Type' },
  ],
};

const userRights: ReportDef = {
  key: 'user-rights', title: 'User Rights Report', subtitle: 'User list with roles, rights and locations',
  endpoint: '/client-reports/b/user-rights',
  filters: [{ key: 'user_id', label: 'User', type: 'select', lookup: 'users' },
    { key: 'active', label: 'Users', type: 'select', default: 'active', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'all', label: 'All' }] }],
  columns: [
    { key: 'username', header: 'User Id', link: link('user_link') },
    { key: 'full_name', header: 'Name' },
    { key: 'employee_code', header: 'Emp Code' },
    { key: 'roles', header: 'Roles', link: link('role_link') },
    { key: 'locations', header: 'Locations' },
    { key: 'default_location', header: 'Default Location' },
    { key: 'perm_count', header: 'Rights (count)' },
    { key: 'rights', header: 'Rights (module: actions)', className: 'max-w-[520px] truncate' },
    { key: 'active', header: 'Active', type: 'yn' },
    { key: 'locked', header: 'Locked', type: 'yn' },
    { key: 'last_login_at', header: 'Last Login', type: 'date' },
  ],
};
const userRightsDetail: ReportDef = {
  key: 'user-rights-detail', title: 'User Rights — detail', subtitle: 'One row per user · role · permission',
  endpoint: '/client-reports/b/user-rights/detail', filters: [{ key: 'user_id', label: 'User', type: 'select', lookup: 'users' }],
  columns: [
    { key: 'username', header: 'User Id', link: link('user_link') },
    { key: 'full_name', header: 'Name' },
    { key: 'role_name', header: 'Role', link: link('role_link') },
    { key: 'module', header: 'Module' },
    { key: 'permission_code', header: 'Permission' },
    { key: 'permission_name', header: 'Description' },
  ],
};
const userLog: ReportDef = {
  key: 'user-log', title: 'Userwise Log report', subtitle: 'Who created / changed / deleted what, by date (last 30 days by default)',
  endpoint: '/client-reports/b/user-log',
  filters: [FROM, TO, { key: 'user_id', label: 'User', type: 'select', lookup: 'users' },
    { key: 'action', label: 'Action', type: 'select', options: [{ value: 'INSERT', label: 'Create' }, { value: 'UPDATE', label: 'Edit' }, { value: 'DELETE', label: 'Delete' }] },
    { key: 'table', label: 'Document type', type: 'text', placeholder: 'e.g. grn' }],
  columns: [
    { key: 'changed_at', header: 'Date / Time', render: (r) => new Date(r.changed_at).toLocaleString('en-IN'), exportValue: (r) => new Date(r.changed_at).toLocaleString('en-IN') },
    { key: 'user', header: 'User' },
    { key: 'action', header: 'Action' },
    { key: 'document_type', header: 'Document Type' },
    { key: 'document', header: 'Document', link: link('doc_link') },
    { key: 'ip_address', header: 'IP' },
  ],
};

/* ------------------------------------------------------------- consolidated stock statement */
function StockStatement() {
  const [p, setP] = useState<Record<string, string>>({ asOn: new Date().toISOString().slice(0, 10), order_status: 'all' });
  const [bucket, setBucket] = useState<string | null>(null);
  const qs = useMemo(() => new URLSearchParams(Object.entries(p).filter(([, v]) => v)).toString(), [p]);
  const set = (k: string, v: string) => { setP((o) => ({ ...o, [k]: v })); };
  const summary: ReportDef = useMemo(() => ({
    key: 'stock-statement', title: 'Consolidated Stock Statement', subtitle: `Stock · transit · outstanding at parties · job order stock — as on ${p.asOn || 'today'}`,
    endpoint: `/client-reports/b/stock-statement?${qs}`,
    columns: [
      { key: 'stock_type', header: 'Stock Type', className: 'font-semibold' },
      { key: 'group', header: 'Group', render: (r) => r.bucket
        ? <button type="button" data-drill="bucket" data-bucket={r.bucket} className={clsx('text-brand-700 hover:underline', r.is_total && 'font-semibold')} onClick={() => setBucket(r.bucket)}>{r.group || 'Total'}</button>
        : r.group },
      { key: 'lines', header: 'Lines', type: 'int' },
      { key: 'qty', header: 'Stock Qty', type: 'qty' },
      { key: 'amount', header: 'Amount', type: 'money' },
    ],
  }), [qs, p.asOn]);
  const kind = bucket?.split(':')[0];
  const lineCols: Record<string, ReportDef['columns']> = {
    STOCK: [
      { key: 'unit', header: 'Unit Name' }, { key: 'location', header: 'Location' }, { key: 'so_no', header: 'SO No' }, { key: 'design_no', header: 'Design No' },
      { key: 'trans_no', header: 'Trans No', link: link('doc_link') }, { key: 'trans_date', header: 'Trans Date', type: 'date' }, { key: 'party', header: 'Party Name' },
      { key: 'process', header: 'Proname' }, { key: 'item', header: 'Item Details' }, { key: 'color', header: 'Color' }, { key: 'uom', header: 'UOM' },
      { key: 'plus_qty', header: 'Plus Qty', type: 'qty', total: true }, { key: 'minus_qty', header: 'Minus Qty', type: 'qty', total: true },
      { key: 'stock_qty', header: 'Stock Qty', type: 'qty', total: true }, { key: 'rate', header: 'Rate', type: 'money' }, { key: 'amount', header: 'Amount', type: 'money', total: true },
      { key: 'stock_age', header: 'Stock Age', type: 'int' }, { key: 'bin', header: 'Bin' }],
    TRANSIT: [
      { key: 'type', header: 'Type' }, { key: 'doc_no', header: 'Docid', link: link('doc_link') }, { key: 'doc_date', header: 'Doc Date', type: 'date' },
      { key: 'from_location', header: 'From Location' }, { key: 'to_location', header: 'To Location' }, { key: 'so_no', header: 'Sale Order No' }, { key: 'style_no', header: 'Style No' },
      { key: 'item', header: 'Item Name' }, { key: 'color', header: 'Color' }, { key: 'uom', header: 'Uom' }, { key: 'dc_qty', header: 'Dc Qty', type: 'qty', total: true },
      { key: 'grn_qty', header: 'Grn Qty', type: 'qty', total: true }, { key: 'bal_qty', header: 'Bal Qty', type: 'qty', total: true }, { key: 'rate', header: 'Stock Rate', type: 'money' },
      { key: 'amount', header: 'Stock Value', type: 'money', total: true }, { key: 'buyer', header: 'Buyer Name' }, { key: 'age', header: 'Age', type: 'int' }],
    OUTSTANDING: [
      { key: 'doc_no', header: 'Docid', link: link('doc_link') }, { key: 'doc_date', header: 'Doc Date', type: 'date' }, { key: 'party', header: 'Party Name' },
      { key: 'process', header: 'Proname' }, { key: 'so_no', header: 'SO No' }, { key: 'style_no', header: 'Style Number' }, { key: 'item', header: 'Fabric / Item Name' },
      { key: 'color', header: 'Color' }, { key: 'uom', header: 'UOM' }, { key: 'issue_qty', header: 'Issue Qty', type: 'qty', total: true },
      { key: 'grn_qty', header: 'Received', type: 'qty', total: true }, { key: 'bal_qty', header: 'Grn Balance', type: 'qty', total: true }, { key: 'rate', header: 'Rate', type: 'money' },
      { key: 'amount', header: 'Amount', type: 'money', total: true }, { key: 'location', header: 'Location' }, { key: 'unit', header: 'Unit Name' },
      { key: 'loss_pct', header: 'Loss %', type: 'pct' }, { key: 'age', header: 'Age', type: 'int' }],
    JOB_ORDER: [
      { key: 'doc_no', header: 'Docid', link: link('doc_link') }, { key: 'doc_date', header: 'Doc Date', type: 'date' }, { key: 'party', header: 'Customer' },
      { key: 'process', header: 'Process' }, { key: 'so_no', header: 'Customer DC' }, { key: 'item', header: 'Item' }, { key: 'uom', header: 'UOM' },
      { key: 'plus_qty', header: 'Received', type: 'qty', total: true }, { key: 'minus_qty', header: 'Returned', type: 'qty', total: true },
      { key: 'stock_qty', header: 'Stock Qty', type: 'qty', total: true }, { key: 'rate', header: 'Rate', type: 'money' }, { key: 'amount', header: 'Amount', type: 'money', total: true },
      { key: 'age', header: 'Age', type: 'int' }],
  };
  const lines: ReportDef | null = bucket && kind ? {
    key: `stock-lines-${kind.toLowerCase()}`, title: `${kind.replace('_', ' ')} — ${bucket.split(':')[1] ?? 'all'}`, subtitle: 'One line per DC / receipt — click a document number to open it',
    endpoint: `/client-reports/b/stock-statement/lines?${qs}&bucket=${encodeURIComponent(bucket)}`, columns: lineCols[kind] ?? lineCols.STOCK,
  } : null;
  const sel = (k: string, label: string, opts: { value: string; label: string }[], all = 'All') => (
    <div><label className="label">{label}</label>
      <select className="input" data-filter={k} value={p[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
        {all && <option value="">{all}</option>}{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select></div>);
  return (
    <div data-report="stock-statement-wrap">
      <div className="card mb-3 grid grid-cols-2 gap-2 p-3 md:grid-cols-4 xl:grid-cols-8">
        <div><label className="label">As on date</label><input className="input" type="date" data-filter="asOn" value={p.asOn ?? ''} onChange={(e) => set('asOn', e.target.value)} /></div>
        {sel('item_group', 'Item group', ITEM_GROUPS)}
        <LookupSel k="unit_id" label="Unit" lookup="units" value={p.unit_id} onChange={set} />
        <LookupSel k="warehouse_id" label="Location" lookup="warehouses" value={p.warehouse_id} onChange={set} />
        <LookupSel k="so_id" label="Sale Order #" lookup="sales-orders" value={p.so_id} onChange={set} />
        <LookupSel k="buyer_id" label="Customer" lookup="buyers" value={p.buyer_id} onChange={set} />
        {sel('order_status', 'Open / closed', [{ value: 'all', label: 'All' }, { value: 'open', label: 'Open orders' }, { value: 'closed', label: 'Closed orders' }], '')}
        <div><label className="label">Order type</label><input className="input" data-filter="order_type" placeholder="e.g. EXPORT" value={p.order_type ?? ''} onChange={(e) => set('order_type', e.target.value)} /></div>
      </div>
      <ClientReport key={summary.endpoint} def={summary} />
      {lines && <div className="mt-6 border-t border-surface-border pt-4" data-stock-lines={bucket}>
        <div className="mb-2 flex justify-end"><button type="button" className="btn-secondary" onClick={() => setBucket(null)}>Close drill-down</button></div>
        <ClientReport key={lines.endpoint} def={lines} />
      </div>}
    </div>
  );
}

function LookupSel({ k, label, lookup, value, onChange }: { k: string; label: string; lookup: string; value?: string; onChange: (k: string, v: string) => void }) {
  const q = useQuery({ queryKey: ['lookup', lookup], queryFn: async () => (await http.get<{ data: any[] }>(`/lookups/${lookup}`)).data ?? [], staleTime: 5 * 60_000 });
  return (
    <div><label className="label">{label}</label>
      <select className="input" data-filter={k} value={value ?? ''} onChange={(e) => onChange(k, e.target.value)}>
        <option value="">All</option>{(q.data ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.label ?? o.code}</option>)}
      </select></div>);
}

/* ------------------------------------------------------------------ page */
type Entry = { key: string; title: string; group: string; def?: ReportDef; custom?: 'stock'; perm?: string };
const ENTRIES: Entry[] = [
  { key: 'grir', title: grir.title, group: 'Purchase & bills', def: grir },
  { key: 'po-grn-bill', title: poGrnBill.title, group: 'Purchase & bills', def: poGrnBill },
  { key: 'direct-bills', title: directBills.title, group: 'Purchase & bills', def: directBills },
  { key: 'bill-tracker', title: billTracker.title, group: 'Purchase & bills', def: billTracker },
  { key: 'dc-gate-outward', title: dcGate.title, group: 'Gate', def: dcGate },
  { key: 'dc-gate-pending', title: dcGatePending.title, group: 'Gate', def: dcGatePending },
  { key: 'dc-inward-grn', title: dcInward.title, group: 'Gate', def: dcInward },
  { key: 'gate-inward-grn-pending', title: inwardGrnPending.title, group: 'Gate', def: inwardGrnPending },
  { key: 'dc-without-gate', title: dcWithoutGate.title, group: 'Gate', def: dcWithoutGate },
  { key: 'stock-statement', title: 'Consolidated Stock Statement', group: 'Stores', custom: 'stock' },
  { key: 'opening-stock', title: openingStock.title, group: 'Stores', def: openingStock },
  { key: 'user-rights', title: userRights.title, group: 'Users', def: userRights },
  { key: 'user-rights-detail', title: userRightsDetail.title, group: 'Users', def: userRightsDetail },
  { key: 'user-log', title: userLog.title, group: 'Users', def: userLog, perm: 'AUDIT.VIEW' },
];

export function ClientReportsBPage() {
  const { can } = useAuth();
  const entries = ENTRIES.filter((e) => !e.perm || can(e.perm));
  const fromHash = typeof window !== 'undefined' ? window.location.hash.replace('#', '') : '';
  const [active, setActive] = useState(entries.find((e) => e.key === fromHash)?.key ?? entries[0].key);
  const cur = entries.find((e) => e.key === active) ?? entries[0];
  const pick = (k: string) => { setActive(k); try { window.history.replaceState(null, '', `#${k}`); } catch { /* ignore */ } };
  const groups = [...new Set(entries.map((e) => e.group))];
  return (
    <div data-page="client-reports-b">
      <div className="mb-4">
        <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">Client Reports — Purchase, Stores, Gate &amp; Users</h1>
        <p className="mt-0.5 text-[13px] text-slate-500">The client's own report set (part B). Click any document number to open it; every report exports to Excel.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        <nav className="card h-fit p-1.5" data-report-list>
          {groups.map((g) => (
            <div key={g} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400">{g}</p>
              {entries.filter((e) => e.group === g).map((e) => (
                <button key={e.key} data-report-key={e.key} onClick={() => pick(e.key)}
                  className={clsx('block w-full rounded-md px-3 py-2 text-left text-[12.5px]',
                    e.key === cur.key ? 'bg-brand-50 font-semibold text-brand-700' : 'text-slate-600 hover:bg-slate-50')}>
                  {e.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          {cur.custom === 'stock' ? <StockStatement /> : cur.def ? <ClientReport key={cur.def.key} def={cur.def} /> : null}
        </div>
      </div>
    </div>
  );
}

export default ClientReportsBPage;
