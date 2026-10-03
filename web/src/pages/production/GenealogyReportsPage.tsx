import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup } from '../../hooks/useLookup';
import { PageHeader, Button, Input, Select, Tabs, LoadingBlock } from '../../components/ui';
import { JobSelect } from '../../components/JobSelect';
import { fmtDate, fmtDecimal } from '../../lib/format';

/**
 * Job material genealogy reports (client document 03-Oct-2026, §22). The roll genealogy and yarn-to-fabric trace of
 * one roll / one job are on Material Traceability; process loss, unit-wise pending and reject / reprocess are on the
 * Fabric Process reports.
 */
type Col = [key: string, label: string, kind?: 'kg' | 'amt' | 'pct' | 'date'];
const REPORTS: { key: string; label: string; filters: ('job' | 'vendor' | 'dates' | 'roll')[]; cols: Col[] }[] = [
  { key: 'job-lifecycle', label: 'Complete job lifecycle', filters: ['job'], cols: [['job_no', 'Job'], ['so_date', 'SO date', 'date'], ['buyer', 'Buyer'], ['styles', 'Styles'], ['planned_yarn_kg', 'Planned yarn', 'kg'], ['yarn_purchased_kg', 'Yarn bought', 'kg'], ['yarn_issued_kg', 'Yarn to knitting', 'kg'], ['fabric_knitted_kg', 'Fabric knitted', 'kg'], ['sent_to_process_kg', 'Sent to process', 'kg'], ['processed_good_kg', 'Processed good', 'kg'], ['issued_to_cutting_kg', 'To cutting', 'kg'], ['fabric_in_stock_kg', 'Fabric in stock', 'kg']] },
  { key: 'job-fabric-availability', label: 'Job-wise fabric availability', filters: ['job'], cols: [['job_no', 'Job'], ['fabric_name', 'Fabric'], ['process_state', 'State'], ['colour', 'Colour'], ['gsm', 'GSM'], ['dia', 'Dia'], ['rolls', 'Rolls'], ['available_kg', 'Available', 'kg'], ['on_quotation_kg', 'On live quotations', 'kg']] },
  { key: 'bom-vs-actual-yarn', label: 'BOM vs actual yarn', filters: ['job'], cols: [['job_no', 'Job'], ['yarn', 'Yarn'], ['plan_source', 'Plan from'], ['planned_kg', 'Planned', 'kg'], ['purchased_kg', 'Purchased', 'kg'], ['issued_kg', 'Issued to knitting', 'kg'], ['variance_kg', 'Issued − planned', 'kg'], ['variance_pct', 'Variance %', 'pct']] },
  { key: 'yarn-input-fabric-output', label: 'Yarn input vs fabric output', filters: ['job'], cols: [['program_no', 'Program'], ['job_no', 'Job'], ['fabric_type', 'Fabric'], ['knitter', 'Knitter'], ['yarn_issued_kg', 'Yarn issued', 'kg'], ['yarn_consumed_kg', 'Yarn consumed', 'kg'], ['fabric_good_kg', 'Fabric good', 'kg'], ['fabric_reject_kg', 'Reject', 'kg'], ['loss_kg', 'Loss', 'kg'], ['yield_pct', 'Yield %', 'pct']] },
  { key: 'roll-ledger', label: 'Fabric roll stock ledger', filters: ['job', 'roll'], cols: [['roll_no', 'Roll'], ['job_no', 'Job'], ['state', 'State'], ['date', 'Date', 'date'], ['ref', 'Ref'], ['movement', 'Movement'], ['in_kg', 'In', 'kg'], ['out_kg', 'Out', 'kg'], ['balance_kg', 'Balance', 'kg']] },
  { key: 'pending-process', label: 'Pending dyeing / washing / compacting', filters: ['job'], cols: [['job_no', 'Job'], ['process', 'Process'], ['dcs', 'DCs'], ['oldest_dc', 'Oldest DC', 'date'], ['sent_kg', 'Sent', 'kg'], ['back_kg', 'Back', 'kg'], ['pending_kg', 'Pending at unit', 'kg'], ['grey_not_sent_kg', 'Grey not yet sent', 'kg']] },
  { key: 'job-process-cost', label: 'Job-wise process cost', filters: ['job', 'dates'], cols: [['job_no', 'Job'], ['process', 'Process'], ['dcs', 'DCs'], ['input_kg', 'Input', 'kg'], ['good_kg', 'Good', 'kg'], ['avg_rate', 'Rate / KG', 'amt'], ['amount', 'Amount', 'amt'], ['cost_per_input_kg', 'Cost / input KG', 'amt']] },
  { key: 'vendor-process-cost', label: 'Vendor-wise process cost', filters: ['vendor', 'dates'], cols: [['vendor', 'Process unit'], ['process', 'Process'], ['grns', 'GRNs'], ['input_kg', 'Input', 'kg'], ['good_kg', 'Good', 'kg'], ['value', 'Value', 'amt'], ['billed', 'Billed', 'amt'], ['unbilled_grns', 'Unbilled GRNs']] },
  { key: 'split-merge', label: 'Roll split / merge history', filters: ['job'], cols: [['date', 'Date', 'date'], ['event', 'Event'], ['roll_no', 'Roll'], ['related_roll', 'Related roll'], ['qty_kg', 'KG', 'kg'], ['job_no', 'Job'], ['reason', 'Reason'], ['user', 'By']] },
];
const fmt = (v: unknown, kind?: string) => (v == null || v === '' ? '—' : kind === 'kg' ? fmtDecimal(Number(v), 3) : kind === 'amt' ? fmtDecimal(Number(v), 2) : kind === 'pct' ? `${fmtDecimal(Number(v), 2)}%` : kind === 'date' ? fmtDate(String(v)) : String(v));

export default function GenealogyReportsPage() {
  const [key, setKey] = useState(REPORTS[0].key);
  const rep = REPORTS.find((r) => r.key === key)!;
  const suppliers = useLookup('suppliers');
  const [f, setF] = useState({ so_id: '', job_no: '', vendor_id: '', from: '', to: '', roll_no: '' });
  const [run, setRun] = useState(0);
  const params = new URLSearchParams(Object.entries({ so_id: f.so_id, vendor_id: f.vendor_id, from: f.from, to: f.to, roll_no: f.roll_no }).filter(([k, v]) => v && (k !== 'roll_no' || rep.filters.includes('roll'))) as [string, string][]);
  const q = useQuery({ queryKey: ['genealogy-report', key, params.toString(), run], queryFn: async () => (await http.get<{ data: any[] }>(`/genealogy-reports/${key}?${params}`)).data ?? [], retry: false,
    enabled: key !== 'roll-ledger' || !!f.so_id || !!f.roll_no });
  const rows = q.data ?? [];
  const csv = () => {
    const out = [rep.cols.map((c) => c[1]).join(','), ...rows.map((r) => rep.cols.map((c) => `"${String(r[c[0]] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'text/csv' })); a.download = `${key}.csv`; a.click();
  };
  return (
    <>
      <PageHeader breadcrumb={['Production', 'Genealogy Reports']} title="Genealogy Reports" subtitle="Job material genealogy — plan vs actual, availability, roll ledger, process cost, split / merge, lifecycle" />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={REPORTS.map((r) => ({ key: r.key, label: r.label }))} active={key} onChange={setKey} /></div>
      <div className="card mb-3 flex flex-wrap items-end gap-3 p-4">
        {rep.filters.includes('job') && <JobSelect label="Job" className="w-72" value={f.job_no} placeholder="All jobs" id="gr-job" onPick={(j) => setF({ ...f, so_id: j ? String(j.id) : '', job_no: j?.job_no ?? '' })} />}
        {rep.filters.includes('vendor') && <Select label="Process unit" className="w-64" value={f.vendor_id} placeholder="All" onChange={(e) => setF({ ...f, vendor_id: e.target.value })} options={(suppliers.data ?? []).map((s: any) => ({ value: String(s.id), label: s.label }))} />}
        {rep.filters.includes('dates') && <><Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /><Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></>}
        {rep.filters.includes('roll') && <Input label="Roll no" className="w-48" value={f.roll_no} id="gr-roll" onChange={(e) => setF({ ...f, roll_no: e.target.value })} />}
        <Button variant="secondary" onClick={() => setRun(run + 1)}><Search size={14} className="mr-1" /> Refresh</Button>
        <Button variant="secondary" onClick={csv} disabled={!rows.length}><Download size={14} className="mr-1" /> CSV</Button>
      </div>
      <div className="card overflow-x-auto">
        {key === 'roll-ledger' && !f.so_id && !f.roll_no ? <p className="p-6 text-center text-sm text-slate-500">Pick a job or enter a roll no</p>
          : q.isLoading ? <LoadingBlock />
          : q.error ? <p className="p-6 text-sm text-red-700">{q.error instanceof ApiError ? q.error.message : 'Failed'}</p>
          : (
            <table className="w-full text-xs" id="gr-table">
              <thead className="bg-slate-50 text-slate-500"><tr>{rep.cols.map(([k, l, kind]) => <th key={k} className={`px-2 py-2 ${kind && kind !== 'date' ? 'text-right' : 'text-left'}`}>{l}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => <tr key={i} className={`border-t border-slate-100 ${String(r.movement ?? '').startsWith('⚠') ? 'bg-amber-50' : ''}`}>{rep.cols.map(([k, , kind]) => <td key={k} className={`px-2 py-1 ${kind && kind !== 'date' ? 'text-right tabular-nums' : ''}`}>{fmt(r[k], kind)}</td>)}</tr>)}
                {!rows.length && <tr><td colSpan={rep.cols.length} className="px-3 py-8 text-center text-slate-400">No rows</td></tr>}
              </tbody>
            </table>
          )}
      </div>
    </>
  );
}
