import { useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { CrudPage } from '../../components/CrudPage';
import { Badge } from '../../components/ui';
import { http, ApiError } from '../../lib/api';
import { fmtDecimal, fmtDate, humanize } from '../../lib/format';

/** Local system date (YYYY-MM-DD) and time (HH:MM) for gate entries. */
const nowStamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
};

const ENTRY_TYPES = [
  { value: 'PURCHASE_INWARD', label: 'Purchase Inward (Mill / Supplier)' },
  { value: 'JOBWORK_RETURN', label: 'Job-work Return (Printer / Dyeing / Wash)' },
  { value: 'SAMPLE_INWARD', label: 'Sample / Lab Inward' },
  { value: 'SALES_RETURN', label: 'Sales / Buyer Return' },
  { value: 'GENERAL_INWARD', label: 'General / Machinery / Stores Inward' },
];

const MATERIAL_TYPES = [
  { value: 'FABRIC', label: 'Fabric (Rolls / Knitted)' },
  { value: 'YARN', label: 'Yarn (Bags / Cones)' },
  { value: 'TRIM', label: 'Trims & Accessories' },
  { value: 'GARMENT', label: 'Garments / Cut Panels' },
  { value: 'GENERAL', label: 'General Consumables' },
  { value: 'MACHINERY', label: 'Machinery & Spares' },
];

const INWARD_STATUSES = [
  { value: 'GATE_IN', label: 'Gate In (Security Checked)' },
  { value: 'INSPECTED', label: 'Inspected by QA' },
  { value: 'GRN_COMPLETED', label: 'GRN Completed (In Store)' },
  { value: 'REJECTED', label: 'Rejected at Gate' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

const PASS_TYPES = [
  { value: 'RETURNABLE_JOBWORK', label: 'Returnable - Job-work (Print/Emb/Wash)' },
  { value: 'RETURNABLE_GENERAL', label: 'Returnable - Machinery / Tools / Assets' },
  { value: 'NON_RETURNABLE_DISPATCH', label: 'Non-Returnable - Export / Sales Dispatch' },
  { value: 'NON_RETURNABLE_SCRAP', label: 'Non-Returnable - Scrap / Waste' },
  { value: 'NON_RETURNABLE_SAMPLE', label: 'Non-Returnable - Buyer Samples' },
];

const OUTWARD_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'GATE_OUT', label: 'Gate Out (Dispatched)' },
  { value: 'RETURNED_PARTIAL', label: 'Returned (Partial)' },
  { value: 'RETURNED_FULL', label: 'Returned (Full)' },
  { value: 'CLOSED', label: 'Closed' },
];


/**
 * Scan the barcode on our DC print (client voice note 01-Oct-2026): the DC loads into the gate pass
 * (outward) or — when the material comes back — into the gate entry (inward).
 */
function DcScanBar({ mode, onLoad }: { mode: 'OUT' | 'IN'; onLoad: (values: Record<string, unknown>) => void }) {
  const [code, setCode] = useState('');
  const [dc, setDc] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const scan = async () => {
    const c = code.trim(); if (!c) return;
    setBusy(true); setErr(''); setDc(null);
    try {
      const d = (await http.get<{ data: any }>(`/dc-lookup?code=${encodeURIComponent(c)}`)).data;
      setDc(d);
      if (!d.warnings?.length) use(d);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'DC not found'); } finally { setBusy(false); setCode(''); ref.current?.focus(); }
  };
  const use = (d: any) => {
    const ref_ = { ref_type: d.ref_type, ref_id: d.ref_id, ref_no: d.dc_no };
    onLoad(mode === 'OUT'
      ? { ...ref_, pass_type: d.returnable ? 'RETURNABLE_JOBWORK' : 'NON_RETURNABLE_DISPATCH', party_id: d.party_id, vehicle_no: d.vehicle_no ?? '', purpose: d.purpose,
          package_count: d.packages || 1, total_qty: d.qty, uom_id: d.uom_id, expected_return_date: d.expected_return_date ? String(d.expected_return_date).slice(0, 10) : '',
          status: 'GATE_OUT', remarks: [d.dc_label, d.jobs ? `Jobs: ${d.jobs}` : ''].filter(Boolean).join(' · ') }
      : { ...ref_, entry_type: d.returnable ? 'JOBWORK_RETURN' : 'GENERAL_INWARD', party_id: d.party_id, material_type: d.material_type, package_count: d.packages || 1,
          remarks: `Coming back against our ${d.dc_label} ${d.dc_no}${d.jobs ? ` (jobs ${d.jobs})` : ''}` });
  };
  return (
    <div className="card mb-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ScanLine size={18} className="text-brand-600" />
        <span className="text-[13px] font-semibold text-slate-800">{mode === 'OUT' ? 'Scan DC barcode → gate pass' : 'Scan our DC barcode (job-work return) → gate entry'}</span>
        <input ref={ref} id={`dc-scan-${mode}`} className="input w-72 py-1.5 font-mono text-sm" placeholder="Scan or type DC no and press Enter" value={code} autoFocus
          onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void scan(); } }} />
        <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void scan()}>{busy ? 'Looking up…' : 'Load DC'}</button>
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
      {dc && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
          <span className="font-mono font-bold text-brand-700">{dc.dc_no}</span><span>{dc.dc_label}</span><span>{fmtDate(dc.dc_date)}</span>
          <span className="font-semibold">{dc.party_name ?? '—'}</span><span>{fmtDecimal(dc.qty, 3)} {dc.uom_code}{dc.packages ? ` · ${dc.packages} pkgs` : ''}</span>
          {dc.jobs && <span>Jobs: {dc.jobs}</span>}<span>Status: {humanize(dc.status)}</span>
          {dc.gate_passes?.length > 0 && <span>Gate out: {dc.gate_passes.map((p: any) => `${p.pass_no} (${fmtDate(p.pass_date)} ${p.pass_time ?? ''})`).join(', ')}</span>}
          {dc.gate_inwards?.length > 0 && <span>Gate in: {dc.gate_inwards.map((p: any) => p.entry_no).join(', ')}</span>}
          {dc.warnings?.map((w: string) => <span key={w} className="font-semibold text-amber-700">⚠ {w}</span>)}
          {dc.warnings?.length > 0 && <button type="button" className="btn-primary ml-auto py-1 text-xs" onClick={() => use(dc)}>{mode === 'OUT' ? 'Make gate pass anyway' : 'Make gate entry anyway'}</button>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------ Inward Gate Entry (IGP) */
export function GateInwardsPage() {
  const [nw, setNw] = useState<{ key: number; values: Record<string, unknown> } | null>(null);
  return (
    <>
    <DcScanBar mode="IN" onLoad={(values) => setNw({ key: Date.now(), values })} />
    <CrudPage
      newWith={nw}
      path="gate-inwards"
      title="Inward Gate Entry"
      permission="GATE_INWARD"
      singular="Inward Entry"
      subtitle="Security gate log for incoming trucks, fabric rolls, yarns, and supplier delivery challans"
      searchPlaceholder="Search entry no, vehicle no, DC no, or driver…"
      defaultSort={{ key: 'entry_date', dir: 'desc' }}
      modalSize="xl"
      columns={[
        {
          key: 'entry_no',
          header: 'Entry No',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-bold text-brand-700">{r.entry_no}</span>
          ),
        },
        {
          key: 'entry_date',
          header: 'Date & Time',
          sortable: true,
          render: (r: any) => (
            <div className="text-xs">
              <span className="font-semibold text-slate-800">{fmtDate(r.entry_date)}</span>
              {r.entry_time && <span className="ml-1 text-slate-500 font-mono">{r.entry_time}</span>}
            </div>
          ),
        },
        {
          key: 'entry_type',
          header: 'Type',
          render: (r: any) => (
            <Badge tone={r.entry_type === 'PURCHASE_INWARD' ? 'blue' : 'violet'}>
              {humanize(r.entry_type)}
            </Badge>
          ),
        },
        {
          key: 'party_name',
          header: 'Supplier / Vendor',
          sortable: true,
          render: (r: any) => <span className="font-medium text-slate-800">{r.party_name}</span>,
        },
        {
          key: 'vehicle_no',
          header: 'Vehicle No',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-800">
              {r.vehicle_no}
            </span>
          ),
        },
        {
          key: 'ref_no',
          header: 'Against our DC',
          render: (r: any) => (r.ref_no ? <span className="font-mono text-xs font-semibold text-brand-700">{r.ref_no}</span> : <span className="text-slate-400">—</span>),
        },
        {
          key: 'dc_inv',
          header: 'DC / Inv No',
          render: (r: any) => (
            <span className="text-xs text-slate-600">
              {r.supplier_dc_no ? `DC: ${r.supplier_dc_no}` : r.supplier_inv_no ? `Inv: ${r.supplier_inv_no}` : '—'}
            </span>
          ),
        },
        {
          key: 'material_type',
          header: 'Material & Rolls',
          render: (r: any) => (
            <span className="text-xs font-medium text-slate-700">
              {humanize(r.material_type)} ({r.package_count || 1} {r.material_type === 'FABRIC' ? 'Rolls' : 'Pkgs'})
            </span>
          ),
        },
        {
          key: 'net_weight_kg',
          header: 'Net Wt (Kg)',
          align: 'right',
          render: (r: any) => (Number(r.net_weight_kg) > 0 ? fmtDecimal(r.net_weight_kg, 2) : '—'),
        },
        {
          key: 'status',
          header: 'Status',
          render: (r: any) => {
            const tone =
              r.status === 'GRN_COMPLETED' ? 'green' :
              r.status === 'GATE_IN' ? 'blue' :
              r.status === 'INSPECTED' ? 'amber' : 'red';
            return <Badge tone={tone}>{humanize(r.status)}</Badge>;
          },
        },
      ]}
      filters={[
        { name: 'entry_type', label: 'Entry Type', options: ENTRY_TYPES },
        { name: 'material_type', label: 'Material', options: MATERIAL_TYPES },
        { name: 'status', label: 'Status', options: INWARD_STATUSES },
        { name: 'party_id', label: 'Supplier', lookup: 'parties' },
      ]}
      fields={[
        // Stamped from the system clock when the entry is opened (and by the server on save)
        { name: 'entry_date', label: 'Entry Date', type: 'date', readOnly: true, defaultValue: () => nowStamp().date, hint: 'System date' },
        { name: 'entry_time', label: 'Entry Time', type: 'time', readOnly: true, defaultValue: () => nowStamp().time, hint: 'System time' },
        { name: 'ref_no', label: 'Against our DC (scanned)', readOnly: true, hint: 'Filled by scanning our DC barcode' },
        { name: 'entry_type', label: 'Entry Type', required: true, options: ENTRY_TYPES, defaultValue: 'PURCHASE_INWARD' },
        { name: 'party_id', label: 'Supplier / Vendor', required: true, lookup: 'parties' },
        { name: 'vehicle_no', label: 'Vehicle Number', required: true, placeholder: 'e.g. TN 38 BJ 1234' },
        { name: 'driver_name', label: 'Driver Name', placeholder: 'Driver full name' },
        { name: 'driver_phone', label: 'Driver Phone', placeholder: '+91 98765 43210' },
        { name: 'transporter_name', label: 'Transporter / Logistics Co.', placeholder: 'e.g. VRL Logistics / Local Auto' },
        { name: 'lr_no', label: 'Lorry Receipt (LR) No.' },
        { name: 'supplier_dc_no', label: 'Supplier Delivery Challan (DC) No.' },
        { name: 'supplier_dc_date', label: 'DC Date', type: 'date' },
        { name: 'supplier_inv_no', label: 'Supplier Invoice No.' },
        { name: 'supplier_inv_date', label: 'Invoice Date', type: 'date' },
        { name: 'material_type', label: 'Material Type', required: true, options: MATERIAL_TYPES, defaultValue: 'FABRIC' },
        { name: 'package_count', label: 'No. of Packages (Rolls / Bags / Boxes)', type: 'number', defaultValue: 1 },
        { name: 'gross_weight_kg', label: 'Gross Weight (Kg)', type: 'number' },
        { name: 'tare_weight_kg', label: 'Tare Weight (Kg)', type: 'number' },
        { name: 'net_weight_kg', label: 'Net Weight (Kg)', type: 'number' },
        { name: 'warehouse_id', label: 'Target Receiving Store', lookup: 'warehouses' },
        { name: 'status', label: 'Gate Status', options: INWARD_STATUSES, defaultValue: 'GATE_IN' },
        { name: 'security_guard', label: 'Security Guard Name' },
        { name: 'remarks', label: 'Remarks / Notes', type: 'textarea', span: 2 },
      ]}
    />
    </>
  );
}

/* ------------------------------------------------ Outward Gate Pass (OGP) */
export function GateOutwardsPage() {
  const [nw, setNw] = useState<{ key: number; values: Record<string, unknown> } | null>(null);
  return (
    <>
    <DcScanBar mode="OUT" onLoad={(values) => setNw({ key: Date.now(), values })} />
    <CrudPage
      newWith={nw}
      path="gate-outwards"
      title="Outward Gate Pass"
      permission="GATE_OUTWARD"
      singular="Gate Pass"
      subtitle="Job-work returnable passes, factory unit transfers, and non-returnable export dispatches"
      searchPlaceholder="Search pass no, vehicle no, driver, or purpose…"
      defaultSort={{ key: 'pass_date', dir: 'desc' }}
      modalSize="xl"
      columns={[
        {
          key: 'pass_no',
          header: 'Pass No',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-[12px] font-bold text-brand-700">{r.pass_no}</span>
          ),
        },
        {
          key: 'pass_date',
          header: 'Date & Time',
          sortable: true,
          render: (r: any) => (
            <div className="text-xs">
              <span className="font-semibold text-slate-800">{fmtDate(r.pass_date)}</span>
              {r.pass_time && <span className="ml-1 text-slate-500 font-mono">{r.pass_time}</span>}
            </div>
          ),
        },
        {
          key: 'ref_no',
          header: 'DC',
          render: (r: any) => (r.ref_no ? <span className="font-mono text-xs font-semibold text-brand-700">{r.ref_no}</span> : <span className="text-slate-400">—</span>),
        },
        {
          key: 'pass_type',
          header: 'Pass Type',
          render: (r: any) => {
            const isReturnable = r.pass_type.startsWith('RETURNABLE');
            return <Badge tone={isReturnable ? 'amber' : 'green'}>{humanize(r.pass_type)}</Badge>;
          },
        },
        {
          key: 'destination',
          header: 'Destination (Vendor / Unit)',
          render: (r: any) => (
            <span className="font-medium text-slate-800">
              {r.party_name || r.to_unit_name || '—'}
            </span>
          ),
        },
        {
          key: 'vehicle_no',
          header: 'Vehicle No',
          sortable: true,
          render: (r: any) => (
            <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-800">
              {r.vehicle_no}
            </span>
          ),
        },
        {
          key: 'total_qty',
          header: 'Qty & Pkgs',
          align: 'right',
          render: (r: any) => (
            <span className="text-xs font-semibold text-slate-800 tabular-nums">
              {fmtDecimal(r.total_qty, 2)} {r.uom_code || ''} ({r.package_count || 1} Pkgs)
            </span>
          ),
        },
        {
          key: 'expected_return_date',
          header: 'Expected Return',
          render: (r: any) => (
            r.expected_return_date ? (
              <span className="text-xs text-amber-700 font-medium">
                {fmtDate(r.expected_return_date)}
              </span>
            ) : <span className="text-slate-400">N/A</span>
          ),
        },
        {
          key: 'status',
          header: 'Status',
          render: (r: any) => {
            const tone =
              r.status === 'RETURNED_FULL' || r.status === 'CLOSED' ? 'green' :
              r.status === 'RETURNED_PARTIAL' ? 'amber' :
              r.status === 'GATE_OUT' ? 'blue' : 'slate';
            return <Badge tone={tone}>{humanize(r.status)}</Badge>;
          },
        },
      ]}
      filters={[
        { name: 'pass_type', label: 'Pass Type', options: PASS_TYPES },
        { name: 'status', label: 'Status', options: OUTWARD_STATUSES },
        { name: 'party_id', label: 'Recipient Vendor', lookup: 'parties' },
      ]}
      fields={[
        { name: 'pass_date', label: 'Pass Date', type: 'date', readOnly: true, defaultValue: () => nowStamp().date, hint: 'System date' },
        { name: 'pass_time', label: 'Pass Time', type: 'time', readOnly: true, defaultValue: () => nowStamp().time, hint: 'System time' },
        { name: 'ref_no', label: 'DC (scanned)', readOnly: true, hint: 'Filled by scanning the DC barcode' },
        { name: 'pass_type', label: 'Pass Type', required: true, options: PASS_TYPES, defaultValue: 'RETURNABLE_JOBWORK' },
        { name: 'party_id', label: 'Recipient Vendor / Subcontractor', lookup: 'parties' },
        { name: 'to_unit_id', label: 'Or Internal Destination Unit', lookup: 'units' },
        { name: 'vehicle_no', label: 'Vehicle Number', required: true, placeholder: 'e.g. TN 38 BJ 5678' },
        { name: 'driver_name', label: 'Driver Name', placeholder: 'Driver full name' },
        { name: 'driver_phone', label: 'Driver Phone', placeholder: '+91 98765 43210' },
        { name: 'transporter_name', label: 'Transporter Name' },
        { name: 'purpose', label: 'Purpose of Gate Pass', required: true, placeholder: 'e.g. Sent for Chest Printing / Embroidery / Washing' },
        { name: 'package_count', label: 'Number of Packages / Bundles / Cartons', type: 'number', defaultValue: 1 },
        { name: 'total_qty', label: 'Total Quantity', type: 'number', required: true },
        { name: 'uom_id', label: 'Unit of Measure', required: true, lookup: 'uoms' },
        { name: 'expected_return_date', label: 'Expected Return Date (For Returnable Pass)', type: 'date' },
        { name: 'status', label: 'Pass Status', options: OUTWARD_STATUSES, defaultValue: 'GATE_OUT' },
        { name: 'security_guard', label: 'Security Officer Name' },
        { name: 'remarks', label: 'Remarks / Notes', type: 'textarea', span: 2 },
      ]}
    />
    </>
  );
}
