import { useState } from 'react';
import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtDecimal, humanize, today } from '../../lib/format';

export const BILL_TYPES = [
  { value: 'YARN_PURCHASE', label: 'Yarn Purchase Bill', icon: '🧵', tone: 'indigo' },
  { value: 'YARN_PROCESS', label: 'Yarn Process Bill', icon: '⚙️', tone: 'sky' },
  { value: 'FABRIC_PURCHASE', label: 'Fabric Purchase Bill', icon: '🧶', tone: 'purple' },
  { value: 'FABRIC_PROCESS', label: 'Fabric Process Bill', icon: '🎨', tone: 'pink' },
  { value: 'TRIMS_PURCHASE', label: 'Trims Purchase Bill', icon: '✂️', tone: 'amber' },
  { value: 'TRIMS_PROCESS', label: 'Trims Process Bill', icon: '🛠️', tone: 'orange' },
  { value: 'GENERAL', label: 'General Bill', icon: '📦', tone: 'slate' },
] as const;

export function SupplierBillsPage() {
  const [activeTab, setActiveTab] = useState<string>('ALL');

  const MATCH_STATUSES = ['UNMATCHED', 'PARTIAL', 'FULLY_MATCHED', 'DISCREPANCY'];
  const STATES = ['DRAFT', 'VERIFIED', 'APPROVED', 'PAID', 'DISPUTED', 'CANCELLED'];

  const typeConfig: Record<string, { label: string; tone: any }> = {
    YARN_PURCHASE: { label: 'Yarn Purchase', tone: 'indigo' },
    YARN_PROCESS: { label: 'Yarn Process', tone: 'sky' },
    FABRIC_PURCHASE: { label: 'Fabric Purchase', tone: 'purple' },
    FABRIC_PROCESS: { label: 'Fabric Process', tone: 'pink' },
    TRIMS_PURCHASE: { label: 'Trims Purchase', tone: 'amber' },
    TRIMS_PROCESS: { label: 'Trims Process', tone: 'orange' },
    GENERAL: { label: 'General Bill', tone: 'slate' },
  };

  return (
    <div className="space-y-4">
      {/* Category Tabs according to Bills Inward Specification */}
      <div className="bg-white border border-slate-200 rounded-xl p-2 shadow-xs flex flex-wrap items-center gap-1.5 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('ALL')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            activeTab === 'ALL'
              ? 'bg-slate-900 text-white shadow-xs'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          All Bills Inward
        </button>
        {BILL_TYPES.map((bt) => (
          <button
            key={bt.value}
            type="button"
            onClick={() => setActiveTab(bt.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              activeTab === bt.value
                ? 'bg-brand-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <span>{bt.icon}</span>
            <span>{bt.label}</span>
          </button>
        ))}
      </div>

      <CrudPage
        key={activeTab}
        path="supplier-bills"
        title={activeTab === 'ALL' ? 'Bills Inward (All Invoices)' : `${BILL_TYPES.find(b => b.value === activeTab)?.label ?? 'Bills Inward'}`}
        permission="PURCHASE"
        singular="Inward Bill"
        subtitle="Inward invoice processing for materials (PO/GRN) and processing job-work (Knitting/Fabric processing)"
        defaultSort={{ key: 'bill_date', dir: 'desc' }}
        baseParams={activeTab !== 'ALL' ? { bill_type: activeTab } : undefined}
        columns={[
          {
            key: 'bill_no',
            header: 'Bill no',
            sortable: true,
            render: (r: any) => (
              <span className="font-mono text-[12px] font-medium text-brand-700">{r.bill_no}</span>
            ),
          },
          {
            key: 'bill_type',
            header: 'Bill Type',
            render: (r: any) => {
              const cfg = typeConfig[r.bill_type] || { label: r.bill_type || 'General', tone: 'slate' };
              return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
            },
          },
          { key: 'bill_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.bill_date) },
          { key: 'supplier_name', header: 'Supplier / Processor' },
          { key: 'supplier_inv_no', header: 'Supplier Inv No' },
          {
            key: 'reference_docs',
            header: 'Linked Reference',
            render: (r: any) => {
              if (r.po_no || r.grn_no) {
                return (
                  <div className="text-[11px] font-mono leading-tight space-y-0.5">
                    {r.po_no && <div><span className="text-slate-400">PO:</span> {r.po_no}</div>}
                    {r.grn_no && <div><span className="text-slate-400">GRN:</span> {r.grn_no}</div>}
                  </div>
                );
              }
              if (r.knitting_order_no) {
                return (
                  <div className="text-[11px] font-mono text-sky-700">
                    <span className="text-slate-400">Knit Order:</span> {r.knitting_order_no}
                  </div>
                );
              }
              if (r.fabric_process_order_no) {
                return (
                  <div className="text-[11px] font-mono text-pink-700">
                    <span className="text-slate-400">Proc Order:</span> {r.fabric_process_order_no}
                  </div>
                );
              }
              return <span className="text-slate-400">—</span>;
            },
          },
          {
            key: 'total_amount',
            header: 'Total Amount',
            align: 'right',
            render: (r: any) => (
              <span className="font-medium text-brand-700">{fmtDecimal(r.total_amount, 2)}</span>
            ),
          },
          {
            key: 'match_status',
            header: 'Matching',
            render: (r: any) => {
              const tone =
                r.match_status === 'FULLY_MATCHED'
                  ? 'emerald'
                  : r.match_status === 'PARTIAL'
                  ? 'amber'
                  : r.match_status === 'DISCREPANCY'
                  ? 'red'
                  : 'slate';
              return <Badge tone={tone}>{humanize(r.match_status || 'UNMATCHED')}</Badge>;
            },
          },
          { key: 'status', header: 'Status', render: (r: any) => <StatusBadge value={r.status} /> },
        ]}
        filters={[
          {
            name: 'bill_type',
            label: 'Bill Category',
            options: BILL_TYPES.map((b) => ({ value: b.value, label: b.label })),
          },
          { name: 'supplier_id', label: 'Supplier', lookup: 'suppliers' },
          { name: 'po_id', label: 'PO', lookup: 'purchase-orders' },
          { name: 'grn_id', label: 'GRN', lookup: 'grns' },
          {
            name: 'match_status',
            label: 'Matching',
            options: MATCH_STATUSES.map((v) => ({ value: v, label: humanize(v) })),
          },
          { name: 'status', label: 'Status', options: STATES.map((v) => ({ value: v, label: humanize(v) })) },
        ]}
        modalSize="lg"
        fields={[
          { name: 'bill_no', label: 'Internal Bill no', hint: 'Blank to auto-generate' },
          {
            name: 'bill_type',
            label: 'Inward Bill Category',
            options: BILL_TYPES.map((b) => ({ value: b.value, label: `${b.icon} ${b.label}` })),
            defaultValue: activeTab !== 'ALL' ? activeTab : 'GENERAL',
            required: true,
          },
          { name: 'bill_date', label: 'Bill date', type: 'date', required: true, defaultValue: today() },
          { name: 'supplier_id', label: 'Supplier / Processor', required: true, lookup: 'suppliers' },
          { name: 'supplier_inv_no', label: 'Supplier invoice / bill no' },
          { name: 'supplier_inv_date', label: 'Supplier invoice date', type: 'date' },
          { name: 'po_id', label: 'Purchase order ref (Purchase bills)', lookup: 'purchase-orders' },
          { name: 'grn_id', label: 'GRN ref (Purchase bills)', lookup: 'grns' },
          { name: 'knitting_order_id', label: 'Knitting Jobwork ref (Yarn Process)', lookup: 'knitting-orders' },
          { name: 'fabric_process_order_id', label: 'Fabric Processing ref (Fabric Process)', lookup: 'fabric-process-orders' },
          { name: 'gate_inward_id', label: 'Gate entry ref', lookup: 'gate-inwards' },
          { name: 'currency_id', label: 'Currency', required: true, lookup: 'currencies' },
          { name: 'subtotal', label: 'Taxable subtotal', type: 'number', required: true },
          { name: 'gst_amount', label: 'GST amount', type: 'number' },
          { name: 'tds_amount', label: 'TDS amount', type: 'number' },
          { name: 'total_amount', label: 'Grand total', type: 'number', required: true },
          { name: 'po_matched', label: 'PO / Order matched', type: 'checkbox' },
          { name: 'grn_matched', label: 'GRN / Inward matched', type: 'checkbox' },
          { name: 'gate_matched', label: 'Gate entry matched', type: 'checkbox' },
          {
            name: 'match_status',
            label: 'Match status',
            options: MATCH_STATUSES.map((v) => ({ value: v, label: humanize(v) })),
            defaultValue: 'UNMATCHED',
          },
          { name: 'payment_due_date', label: 'Payment due date', type: 'date' },
          {
            name: 'status',
            label: 'Status',
            options: STATES.map((v) => ({ value: v, label: humanize(v) })),
            defaultValue: 'DRAFT',
          },
          { name: 'remarks', label: 'Remarks', type: 'textarea' },
        ]}
      />
    </div>
  );
}
