import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, Disc, PackageCheck, FileSpreadsheet } from 'lucide-react';
import { CrudPage } from '../../components/CrudPage';
import { StatusBadge, Badge } from '../../components/ui';
import { fmtDate, fmtNumber, fmtDecimal, humanize, today } from '../../lib/format';

export function EnquiriesPage() {
  return <CrudPage
    path="enquiries" title="Enquiries" permission="ENQUIRY" singular="Enquiry"
    subtitle="Buyer enquiries — the top of the order funnel"
    defaultSort={{ key: 'enquiry_date', dir: 'desc' }}
    columns={[
      { key: 'enquiry_no', header: 'Enquiry no', sortable: true,
        render: (r: any) => <span className="font-mono text-[12px] font-medium text-brand-700">{r.enquiry_no}</span> },
      { key: 'enquiry_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.enquiry_date) },
      { key: 'buyer_name', header: 'Buyer' },
      { key: 'season', header: 'Season' },
      { key: 'expected_qty', header: 'Expected qty', align: 'right', render: (r: any) => fmtNumber(r.expected_qty) },
      { key: 'target_price', header: 'Target price', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.target_price, 2)}` },
      { key: 'delivery_target', header: 'Delivery', render: (r: any) => fmtDate(r.delivery_target) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'buyer_id', label: 'Buyer', lookup: 'buyers' },
      { name: 'status_id', label: 'Status', statusDomain: 'ENQUIRY' },
      { name: 'merchandiser_id', label: 'Merchandiser', lookup: 'users' },
    ]}
    fields={[
      { name: 'enquiry_no', label: 'Enquiry no', hint: 'Leave blank to auto-generate' },
      { name: 'enquiry_date', label: 'Enquiry date', type: 'date', required: true, defaultValue: today() },
      { name: 'buyer_id', label: 'Buyer', required: true, lookup: 'buyers' },
      { name: 'agent_id', label: 'Agent', lookup: 'agents' },
      { name: 'merchandiser_id', label: 'Merchandiser', lookup: 'users' },
      { name: 'season', label: 'Season', placeholder: 'e.g. SS26' },
      { name: 'currency_id', label: 'Currency', lookup: 'currencies' },
      { name: 'target_price', label: 'Target price', type: 'number' },
      { name: 'expected_qty', label: 'Expected quantity', type: 'number' },
      { name: 'delivery_target', label: 'Target delivery', type: 'date' },
      { name: 'status_id', label: 'Status', statusDomain: 'ENQUIRY' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ]} />;
}

export function QuotationsPage() {
  const nav = useNavigate();
  const [activeTab, setActiveTab] = useState<'ALL' | 'FABRIC' | 'YARN' | 'GENERAL' | 'BUYER'>('ALL');

  const baseParams = useMemo(() => {
    if (activeTab === 'FABRIC') return { quotation_type: 'FABRIC' };
    if (activeTab === 'YARN') return { quotation_type: 'YARN' };
    if (activeTab === 'GENERAL') return { quotation_type: 'GENERAL' };
    if (activeTab === 'BUYER') return { quotation_type: 'BUYER' };
    return undefined;
  }, [activeTab]);

  return (
    <div className="space-y-3">
      {/* Departmental Quotation Tabs */}
      <div className="flex border-b border-slate-200 space-x-2 bg-white px-2 pt-2 rounded-t-xl overflow-x-auto">
        {[
          { id: 'ALL', label: 'All Quotations', icon: Layers, tone: 'slate' },
          { id: 'FABRIC', label: 'Fabric Quotations', icon: Layers, tone: 'sky' },
          { id: 'YARN', label: 'Yarn Quotations', icon: Disc, tone: 'amber' },
          { id: 'GENERAL', label: 'General & Trims', icon: PackageCheck, tone: 'rose' },
          { id: 'BUYER', label: 'Buyer & Sales', icon: FileSpreadsheet, tone: 'emerald' },
        ].map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as any)}
              className={`flex items-center gap-1.5 py-2 px-3 text-xs font-semibold border-b-2 transition whitespace-nowrap ${
                active
                  ? 'border-brand-600 text-brand-700 bg-brand-50/50'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Icon size={14} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      <CrudPage
        key={activeTab}
        baseParams={baseParams}
        path="quotations" title="Quotations" permission="QUOTATION" singular="Quotation"
        subtitle="Domestic & import price offers for buyers and suppliers"
        defaultSort={{ key: 'quotation_date', dir: 'desc' }}
        onNew={() => nav('/sales/quotations/new')}
        onRowClick={(r: any) => nav(`/sales/quotations/${r.id}`)}
    columns={[
      { key: 'quotation_no', header: 'Quotation no', sortable: true,
        render: (r: any) => (
          <span className="font-mono text-[12px] font-medium text-brand-700">
            {r.quotation_no}
            <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${Number(r.version) > 1 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'}`}
              title={Number(r.version) > 1 ? `Edited — ${Number(r.version) - 1} earlier version(s)` : 'First version'}>V{Number(r.version) || 1}</span>
          </span>
        ) },
      { key: 'quotation_type', header: 'Type / Purpose',
        render: (r: any) => {
          let badgeTone: any = 'sky';
          let label = r.quotation_type || 'Domestic';
          if (r.quotation_type === 'FABRIC') { badgeTone = 'sky'; label = 'Fabric'; }
          else if (r.quotation_type === 'YARN') { badgeTone = 'amber'; label = 'Yarn'; }
          else if (r.quotation_type === 'TRIMS') { badgeTone = 'rose'; label = 'Trims'; }
          else if (r.quotation_type === 'GENERAL') { badgeTone = 'slate'; label = r.is_io_wise ? 'General (I/O)' : 'General'; }
          else if (r.quotation_type === 'BUYER') { badgeTone = 'emerald'; label = 'Buyer (Export)'; }
          else if (r.quotation_type === 'IMPORT') { badgeTone = 'violet'; label = 'Import'; }

          const isProc = r.quotation_category === 'PROCESS';
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <Badge tone={badgeTone}>{label}</Badge>
                {isProc && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">
                    Process
                  </span>
                )}
              </div>
              {isProc && r.process_name && (
                <span className="text-[11px] text-amber-700 font-semibold">
                  ⚙️ {r.process_name}
                </span>
              )}
            </div>
          );
        } },
      { key: 'quotation_date', header: 'Date', sortable: true, render: (r: any) => fmtDate(r.quotation_date) },
      { key: 'buyer_name', header: 'Buyer / Supplier',
        render: (r: any) => <span className="font-medium text-slate-800">{r.buyer_name || r.supplier_name || '—'}</span> },
      { key: 'incoterm', header: 'Incoterm' },
      { key: 'currency_code', header: 'Ccy', align: 'center' },
      { key: 'total_amount', header: 'Amount', align: 'right',
        render: (r: any) => `${r.currency_code ?? ''} ${fmtDecimal(r.total_amount, 2)}` },
      { key: 'valid_until', header: 'Valid until', render: (r: any) => fmtDate(r.valid_until) },
      { key: 'status_label', header: 'Status', render: (r: any) => <StatusBadge value={r.status_label} /> },
    ]}
    filters={[
      { name: 'quotation_type', label: 'Type', options: [
        { value: 'FABRIC', label: 'Fabric' },
        { value: 'YARN', label: 'Yarn' },
        { value: 'TRIMS', label: 'Trims' },
        { value: 'GENERAL', label: 'General / Sample' },
        { value: 'BUYER', label: 'Buyer (Export)' },
        { value: 'IMPORT', label: 'Import' },
        { value: 'DOMESTIC', label: 'Domestic' },
      ] },
      { name: 'quotation_category', label: 'Purpose', options: [
        { value: 'PURCHASE', label: 'Material Purchase' },
        { value: 'PROCESS', label: 'Process / Job Work' },
      ] },
      { name: 'buyer_id', label: 'Buyer', lookup: 'buyers' },
      { name: 'supplier_id', label: 'Supplier / job worker', lookup: 'payables' },
      { name: 'status_id', label: 'Status', statusDomain: 'QUOTATION' },
    ]}
    fields={[]} />
    </div>
  );
}
