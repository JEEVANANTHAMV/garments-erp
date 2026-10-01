import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { PageHeader, Button, Input, Select, Tabs, LoadingBlock } from '../../components/ui';
import { fmtDate, fmtDecimal } from '../../lib/format';

/**
 * Material traceability (client voice note 01-Oct-2026): from a fabric roll back through
 * processing and knitting to the yarn lots — with the PO, GRN, supplier invoice and bill each
 * came from (for a debit / return) — and forward to cutting; or everything of one job.
 */
const kg = (v: unknown) => fmtDecimal(Number(v ?? 0), 3);
export default function MaterialTracePage() {
  const [tab, setTab] = useState('roll');
  const [roll, setRoll] = useState('');
  const [rollQ, setRollQ] = useState('');
  const [job, setJob] = useState('');
  const jobs = useQuery({ queryKey: ['procurement-jobs'], queryFn: async () => (await http.get<{ data: any[] }>('/procurement/jobs')).data ?? [] });
  const rt = useQuery({ queryKey: ['trace-roll', rollQ], queryFn: async () => (await http.get<{ data: any }>(`/traceability/fabric-roll?roll_no=${encodeURIComponent(rollQ)}`)).data, enabled: !!rollQ, retry: false });
  const jt = useQuery({ queryKey: ['trace-job', job], queryFn: async () => (await http.get<{ data: any }>(`/traceability/job/${job}`)).data, enabled: !!job });
  return (
    <>
      <PageHeader breadcrumb={['Production', 'Material Traceability']} title="Material Traceability" subtitle="Yarn PO / GRN / lot → knitting → processing → fabric roll → cutting" />
      <div className="card mb-3 px-4 pt-2"><Tabs tabs={[{ key: 'roll', label: 'By fabric roll' }, { key: 'job', label: 'By job' }]} active={tab} onChange={setTab} /></div>
      {tab === 'roll' && (
        <>
          <div className="card mb-3 flex items-end gap-2 p-4">
            <Input label="Fabric roll no" className="w-64" value={roll} onChange={(e) => setRoll(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setRollQ(roll.trim()); }} />
            <Button onClick={() => setRollQ(roll.trim())}><Search size={14} className="mr-1" /> Trace</Button>
          </div>
          {rt.isLoading && <LoadingBlock />}
          {rt.error && <div className="card p-6 text-sm text-red-700">{rt.error instanceof ApiError ? rt.error.message : 'Not found'}</div>}
          {rt.data && (
            <div className="space-y-3">
              {rt.data.chain.map((c: any, i: number) => (
                <div key={i} className="card p-4 text-xs" style={{ marginLeft: Math.min(c.depth, 6) * 18 }}>
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-mono font-bold text-brand-700">{c.roll.roll_no}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${c.roll.process_state === 'GREY' ? 'bg-slate-100 text-slate-700' : 'bg-purple-100 text-purple-800'}`}>{c.roll.process_state}</span>
                    <span>{c.roll.fabric_name}</span>{c.roll.color_name && <span>· {c.roll.color_name}</span>}<span>· {kg(c.roll.weight_kg)} KG</span>{c.roll.io_no && <span>· job {c.roll.io_no}</span>}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4">
                    <div><span className="text-slate-500">GRN:</span> <b>{c.roll.grn_no}</b> {fmtDate(c.roll.grn_date)}</div>
                    {c.roll.supplier && <div><span className="text-slate-500">Supplier:</span> <b>{c.roll.supplier}</b></div>}
                    {c.roll.po_no && <div><span className="text-slate-500">PO:</span> <b>{c.roll.po_no}</b></div>}
                    {c.roll.supplier_inv_no && <div><span className="text-slate-500">Supplier invoice:</span> <b>{c.roll.supplier_inv_no}</b></div>}
                    {c.roll.supplier_dc_no && <div><span className="text-slate-500">Supplier DC:</span> {c.roll.supplier_dc_no}</div>}
                    {c.process && <div className="col-span-2"><span className="text-slate-500">Processed on:</span> <b>{c.process.fpo_no}</b> ({c.process.sub_process}) at {c.process.vendor}{c.process_bill ? ` · billed on ${c.process_bill.bill_no}` : ''}</div>}
                    {c.knitting && <div className="col-span-2"><span className="text-slate-500">Knitted on program:</span> <b>{c.knitting.program_no}</b> by {c.knitting.knitter}</div>}
                    {c.bills?.length > 0 && <div className="col-span-2"><span className="text-slate-500">Supplier bill:</span> {c.bills.map((b: any) => `${b.bill_no} (${fmtDate(b.bill_date)})`).join(', ')}</div>}
                  </div>
                  {c.yarn?.length > 0 && (
                    <table className="mt-2 w-full">
                      <thead className="bg-slate-50 text-slate-500"><tr>{['Yarn', 'Lot', 'DC', 'KG', 'GRN', 'PO', 'Supplier', 'Invoice', 'Link', 'Lot origin'].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                      <tbody>{c.yarn.map((y: any, k: number) => <tr key={k} className="border-t border-slate-100"><td className="px-2 py-1">{y.yarn_name}</td><td className="px-2 py-1">{y.lot_no}</td><td className="px-2 py-1 font-mono">{y.dc_no}</td><td className="px-2 py-1">{kg(y.issued_qty_kg)}</td>
                        <td className="px-2 py-1 font-mono">{y.grn_no || '—'}</td><td className="px-2 py-1">{y.po_no || '—'}</td><td className="px-2 py-1">{y.supplier || '—'}</td><td className="px-2 py-1">{y.supplier_inv_no || '—'}</td>
                        <td className="px-2 py-1">{y.link === 'exact' ? 'exact lot' : <span className="text-amber-700">lot no match</span>}</td><td className="px-2 py-1"><Origin o={y.origin} /></td></tr>)}</tbody>
                    </table>
                  )}
                </div>
              ))}
              <div className="card p-4 text-xs">
                <h3 className="mb-1 font-semibold">Forward — used in cutting</h3>
                {rt.data.cutting.length ? rt.data.cutting.map((x: any, i: number) => <div key={i}>{x.roll_no}: {kg(x.issue_kg)} KG on {x.issue_no} ({fmtDate(x.issue_date)}) for cut order {x.plan_no ?? '—'}</div>) : <span className="text-slate-400">Not issued to cutting yet</span>}
              </div>
            </div>
          )}
        </>
      )}
      {tab === 'job' && (
        <>
          <div className="card mb-3 p-4"><Select label="Job" className="w-80" value={job} placeholder="— Job / IO —" onChange={(e) => setJob(e.target.value)} options={(jobs.data ?? []).map((j) => ({ value: j.id, label: j.job_no }))} /></div>
          {jt.isLoading && <LoadingBlock />}
          {jt.data && (
            <div className="space-y-3 text-xs">
              <Section title={`Yarn lots held (${jt.data.yarn_lots.length})`} cols={['Yarn', 'Lot', 'GRN', 'PO', 'Supplier', 'Available KG', 'Lot origin']}
                rows={jt.data.yarn_lots.map((y: any) => [y.yarn_name, y.lot_no, y.grn_no, y.po_no, y.supplier_name, kg(y.available_kg), <Origin key="o" o={y.origin} />])} />
              <Section title={`Yarn sent on DCs (${jt.data.yarn_issued.length})`} cols={['DC', 'Date', 'For', 'Yarn', 'Lot', 'KG', 'GRN', 'PO', 'Supplier', 'Invoice', 'To']}
                rows={jt.data.yarn_issued.map((y: any) => [y.dc_no, fmtDate(y.issue_date), y.src_type === 'KNITTING_PROGRAM' ? 'Knitting' : 'Yarn process', y.yarn_name, y.lot_no, kg(y.issued_qty_kg), y.grn_no, y.po_no, y.supplier, y.supplier_inv_no, y.vendor])} />
              <Section title={`Fabric rolls (${jt.data.fabric_rolls.length})`} cols={['Roll', 'Fabric', 'State', 'Colour', 'KG', 'In store', 'GRN', 'PO', 'Supplier', 'Invoice', 'Cut orders']}
                rows={jt.data.fabric_rolls.map((r: any) => [r.roll_no, r.fabric_name, r.process_state, r.color_name, kg(r.weight_kg), kg(r.balance_kg), r.grn_no, r.po_no, r.supplier, r.supplier_inv_no, r.cut_plans])} />
              <Section title={`Transfers (${jt.data.transfers.length})`} cols={['Transfer', 'Date', 'Material', 'From', 'To', 'Qty', 'Reason']}
                rows={jt.data.transfers.map((t: any) => [t.transfer_no, fmtDate(t.transfer_date), t.material_type, t.from_job, t.to_job, kg(t.total_qty), t.reason])} />
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Where a yarn lot came from: purchased (PO / GRN / supplier) or made by yarn dyeing / winding / twisting from earlier lots. */
function Origin({ o }: { o: any }) {
  if (!o) return <span className="text-slate-400">—</span>;
  if (o.kind !== 'PROCESSED') return <span>Purchased · {o.po_no ? `PO ${o.po_no} · ` : ''}GRN {o.grn_no}{o.supplier ? ` · ${o.supplier}` : ''}</span>;
  return (
    <span>
      <span className="rounded bg-purple-100 px-1 text-[10.5px] font-bold text-purple-800">{o.process.process_type}</span> by {o.process.vendor || '—'} on {o.process.process_no} (receipt {o.process.receipt_no}{o.process.ref_dc_no ? `, DC ${o.process.ref_dc_no}` : ''})
      {(o.from ?? []).map((f: any, i: number) => <span key={i} className="block pl-3 text-slate-600">← lot {f.lot_no} · {kg(f.issued_qty_kg)} KG on {f.dc_no}: <Origin o={f.origin} /></span>)}
    </span>
  );
}

function Section({ title, cols, rows }: { title: string; cols: string[]; rows: unknown[][] }) {
  return (
    <div className="card overflow-x-auto">
      <h3 className="px-4 pt-3 text-[13px] font-semibold text-slate-800">{title}</h3>
      <table className="mt-2 w-full">
        <thead className="bg-slate-50 text-slate-500"><tr>{cols.map((c) => <th key={c} className="px-2 py-1.5 text-left">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{r.map((c, k) => <td key={k} className="px-2 py-1">{c !== null && typeof c === 'object' ? (c as ReactNode) : String(c ?? '—') || '—'}</td>)}</tr>)}
          {!rows.length && <tr><td colSpan={cols.length} className="px-3 py-4 text-center text-slate-400">None</td></tr>}</tbody>
      </table>
    </div>
  );
}
