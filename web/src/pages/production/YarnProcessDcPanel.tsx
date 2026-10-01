import { useEffect, useState } from 'react';
import { Plus, Trash2, Truck, PackageCheck, Printer } from 'lucide-react';
import { http } from '../../lib/api';
import { fmtDate, fmtDecimal, today } from '../../lib/format';
import { useToast } from '../../hooks/useToast';
import { Modal, Input, Select, Button, Badge, Checkbox } from '../../components/ui';

/**
 * Yarn process outward DC and inward (client voice note 1): like the knitting
 * DC, yarn goes to the dyer / winder / twister on a DC and comes back as an
 * inward against that DC; pending KG at the processor is shown per DC.
 */

type DcLine = { yarn_id: string; grn_line_id: string; issued_qty_kg: string; no_of_cones: string };
/** One job (yarn process) on the DC; a DC may carry several jobs of the same process to one processor. */
type DcJob = { process_id: number; process_no: string; io_no: string | null; so_id: number | null; lots: any[]; lines: DcLine[] };

export function YarnProcessDcPanel({ process, yarns, parties, warehouses, onChanged }: {
  process: any; yarns: any[]; parties: any[]; warehouses: any[]; onChanged: () => void;
}) {
  const toast = useToast();
  const [dcs, setDcs] = useState<any[]>([]);
  const [outOpen, setOutOpen] = useState(false);
  const [inDc, setInDc] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);

  const blankLine = (yarnId?: number | null): DcLine => ({ yarn_id: yarnId ? String(yarnId) : '', grn_line_id: '', issued_qty_kg: '', no_of_cones: '' });
  const [jobs, setJobs] = useState<DcJob[]>([]);
  const [others, setOthers] = useState<any[]>([]);
  const [addId, setAddId] = useState('');
  const jobOf = async (p: any): Promise<DcJob> => {
    const qs = new URLSearchParams(p.so_id ? { so_id: String(p.so_id) } : { io_no: p.io_no ?? '' });
    const lots = (await http.get<{ data: any[] }>(`/yarn-stock/job-lots?${qs}`)).data ?? [];
    const first = lots.find((l: any) => !p.yarn_id || Number(l.yarn_id) === Number(p.yarn_id));
    return { process_id: p.id, process_no: p.process_no, io_no: p.io_no ?? null, so_id: p.so_id ?? null, lots,
      lines: [{ ...blankLine(p.yarn_id), grn_line_id: first ? String(first.grn_line_id) : '' }] };
  };
  const [out, setOut] = useState({ dc_date: today(), vendor_id: '', vehicle_no: '', warehouse_id: '', remarks: '', allow_override: false, override_reason: '' });
  const [inw, setInw] = useState({ receipt_date: today(), party_dc_no: '', vehicle_no: '', input_qty: '', output_qty: '', rejected_qty: '', output_lot_no: '', warehouse_id: '', qc_status: 'PENDING', post_stock: false, remarks: '' });

  const load = () => http.get<{ data: any[] }>(`/yarn-process-dcs?process_id=${process.id}`).then((r) => setDcs(r.data || [])).catch(() => setDcs([]));
  useEffect(() => { load(); }, [process.id]);

  const openOutward = async () => {
    setOut({ dc_date: today(), vendor_id: process.vendor_id ? String(process.vendor_id) : '', vehicle_no: '', warehouse_id: process.warehouse_id ? String(process.warehouse_id) : '', remarks: '', allow_override: false, override_reason: '' });
    setJobs([await jobOf(process)]);
    // other released jobs of the same process type can go on the same DC
    http.get<{ data: any[] }>('/yarn-processes').then((r) => setOthers((r.data ?? []).filter((p: any) => p.id !== process.id && p.process_type === process.process_type && !['DRAFT', 'CANCELLED', 'COMPLETED'].includes(p.status)))).catch(() => setOthers([]));
    setOutOpen(true);
  };
  const addJob = async () => {
    const p = others.find((x) => String(x.id) === addId);
    if (!p || jobs.some((j) => j.process_id === p.id)) return;
    setJobs([...jobs, await jobOf(p)]); setAddId('');
  };
  const setJobLine = (ji: number, li: number, patch: Partial<DcLine>) => setJobs((js) => js.map((j, a) => (a !== ji ? j : { ...j, lines: j.lines.map((l, b) => (b === li ? { ...l, ...patch } : l)) })));
  const openInward = async (dc: any) => {
    // inward is job-wise: this job's pending KG on the (possibly shared) DC
    const d = (await http.get<{ data: any }>(`/yarn-process-dcs/${encodeURIComponent(dc.dc_no)}`)).data;
    const mine = (d.jobs ?? []).find((j: any) => Number(j.process_id) === Number(process.id));
    const pend = mine ? mine.pending_kg : dc.pending_kg;
    setInw({ receipt_date: today(), party_dc_no: '', vehicle_no: '', input_qty: String(pend), output_qty: '', rejected_qty: '', output_lot_no: '', warehouse_id: process.warehouse_id ? String(process.warehouse_id) : '', qc_status: 'PENDING', post_stock: false, remarks: '' });
    setInDc({ ...dc, issued_kg: mine?.issued_kg ?? dc.issued_kg, received_kg: mine?.received_kg ?? dc.received_kg, pending_kg: pend });
  };

  const saveOutward = async () => {
    setSaving(true);
    try {
      const r = await http.post<{ data: any }>('/yarn-process-dcs', {
        dc_date: out.dc_date, vendor_id: out.vendor_id ? Number(out.vendor_id) : null,
        vehicle_no: out.vehicle_no || null, warehouse_id: out.warehouse_id ? Number(out.warehouse_id) : null,
        remarks: out.remarks || null, allow_override: out.allow_override, override_reason: out.override_reason || null,
        jobs: jobs.map((j) => ({ process_id: j.process_id, lines: j.lines.map((l) => ({ yarn_id: l.yarn_id ? Number(l.yarn_id) : null,
          grn_line_id: l.grn_line_id ? Number(l.grn_line_id) : null, issued_qty_kg: Number(l.issued_qty_kg) || 0, no_of_cones: Number(l.no_of_cones) || 0 })) })),
      });
      toast(`Outward DC ${r.data.dc_no} saved — ${fmtDecimal(r.data.issued_kg, 3)} KG sent`);
      setOutOpen(false); load(); onChanged();
    } catch (e: any) {
      toast(e?.message || 'Could not save the DC', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveInward = async () => {
    if (!inDc) return;
    setSaving(true);
    try {
      const r = await http.post<{ data: any }>('/process-receipts', {
        src_type: 'YARN_PROCESS', src_id: process.id, ref_dc_no: inDc.dc_no, receipt_date: inw.receipt_date,
        party_dc_no: inw.party_dc_no || null, vehicle_no: inw.vehicle_no || null,
        input_qty: Number(inw.input_qty) || 0, output_qty: Number(inw.output_qty) || 0, rejected_qty: Number(inw.rejected_qty) || 0,
        output_lot_no: inw.output_lot_no || null, warehouse_id: Number(inw.warehouse_id), qc_status: inw.qc_status,
        post_stock: inw.post_stock, remarks: inw.remarks || null,
      });
      toast(`Inward ${r.data.receipt_no} saved against DC ${inDc.dc_no} (loss ${fmtDecimal(r.data.loss_qty, 3)} KG)`);
      setInDc(null); load(); onChanged();
    } catch (e: any) {
      toast(e?.message || 'Could not save the inward', 'error');
    } finally {
      setSaving(false);
    }
  };

  const printDc = async (dcNo: string) => {
    const d = (await http.get<{ data: any }>(`/yarn-process-dcs/${encodeURIComponent(dcNo)}`)).data;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.dc_no)}</title>
      <style>body{font:12px Arial;margin:24px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #999;padding:5px}th{background:#eee}</style></head><body>
      <h2>${esc(d.process?.process_label ?? 'Yarn Process')} — Delivery Challan ${esc(d.dc_no)}</h2>
      <p><b>Date:</b> ${esc(fmtDate(d.dc_date))} &nbsp; <b>Supplier / Vendor:</b> ${esc(d.vendor_name)} &nbsp; <b>Vehicle:</b> ${esc(d.vehicle_no ?? '—')}
      &nbsp; <b>Jobs:</b> ${esc((d.jobs ?? []).length)}</p>
      <table><thead><tr><th>#</th><th>Job (IO)</th><th>Process</th><th>Yarn</th><th>Lot (GRN)</th><th>Cones</th><th>KG</th></tr></thead><tbody>
      ${d.lines.map((l: any, i: number) => { const j = (d.jobs ?? []).find((x: any) => Number(x.process_id) === Number(l.src_id)); return `<tr><td>${i + 1}</td><td>${esc(j?.io_no ?? l.io_no ?? '—')}</td><td>${esc(j?.process_no ?? '')}</td><td>${esc(l.yarn_code)} ${esc(l.yarn_name)}</td><td>${esc(l.lot_no ?? '')}${l.grn_no ? ` (${esc(l.grn_no)})` : ''}</td><td>${esc(l.no_of_cones)}</td><td>${esc(fmtDecimal(l.issued_qty_kg, 3))}</td></tr>`; }).join('')}
      <tr><th colspan="5">Total</th><th>${esc(d.cones)}</th><th>${esc(fmtDecimal(d.issued_kg, 3))}</th></tr></tbody></table>
      <p style="margin-top:40px">Receiver's signature ____________________ &nbsp;&nbsp; Authorised signatory ____________________</p>
      <script>window.onload=()=>window.print()</script></body></html>`);
    w.document.close();
  };

  const vendorOpts = parties.map((p: any) => ({ value: p.id, label: p.label }));
  const whOpts = warehouses.map((w: any) => ({ value: w.id, label: w.label }));
  const yarnOpts = yarns.map((y: any) => ({ value: y.id, label: `${y.code} — ${y.label}` }));
  const pendingTotal = dcs.reduce((a, d) => a + Number(d.pending_kg || 0), 0);

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
        <p className="text-[12px] font-semibold text-slate-700">
          Outward DC / Inward <span className="font-normal text-slate-500">— pending at processor: <b className="text-amber-700">{fmtDecimal(pendingTotal, 3)} KG</b></span>
        </p>
        <Button size="sm" onClick={openOutward} disabled={['DRAFT', 'CANCELLED', 'COMPLETED'].includes(process.status)}>
          <Truck size={13} className="mr-1" /> Outward DC
        </Button>
      </div>
      <table className="w-full text-[11px]">
        <thead className="text-slate-500">
          <tr>{['DC No', 'Date', 'Supplier / Vendor', 'Jobs', 'Cones', 'Sent KG', 'Received KG', 'Output KG', 'Pending KG', 'Status', ''].map((h) => <th key={h} className="px-2 py-1.5 text-left">{h}</th>)}</tr>
        </thead>
        <tbody>
          {dcs.map((d) => (
            <tr key={d.dc_no} className="border-t border-slate-100">
              <td className="px-2 py-1 font-mono font-semibold text-brand-700">{d.dc_no}</td>
              <td className="px-2 py-1">{fmtDate(d.dc_date)}</td>
              <td className="px-2 py-1">{d.vendor_name ?? '—'}</td>
              <td className="px-2 py-1">{d.io_no || '—'}{Number(d.job_count) > 1 ? <span className="ml-1 text-slate-400">({d.job_count})</span> : null}</td>
              <td className="px-2 py-1">{d.cones}</td>
              <td className="px-2 py-1">{fmtDecimal(d.issued_kg, 3)}</td>
              <td className="px-2 py-1">{fmtDecimal(d.received_kg, 3)}</td>
              <td className="px-2 py-1">{fmtDecimal(d.output_kg, 3)}</td>
              <td className="px-2 py-1 font-semibold text-amber-700">{fmtDecimal(d.pending_kg, 3)}</td>
              <td className="px-2 py-1"><Badge tone={d.status === 'RECEIVED' ? 'emerald' : d.status === 'PARTIAL_RECEIVED' ? 'amber' : 'blue'}>{d.status.replace(/_/g, ' ')}</Badge></td>
              <td className="px-2 py-1 text-right whitespace-nowrap">
                {d.pending_kg > 0 && <Button size="sm" variant="secondary" onClick={() => openInward(d)}><PackageCheck size={12} className="mr-1" /> Inward</Button>}
                <button className="ml-2 text-slate-500 hover:text-slate-800" title="Print DC" onClick={() => printDc(d.dc_no)}><Printer size={13} /></button>
              </td>
            </tr>
          ))}
          {!dcs.length && <tr><td colSpan={11} className="px-3 py-4 text-center text-slate-400">No outward DC yet</td></tr>}
        </tbody>
      </table>

      <Modal open={outOpen} onClose={() => setOutOpen(false)} title={`Outward DC — ${jobs.map((j) => j.process_no).join(', ') || process.process_no}`} size="xl"
        footer={<><Button variant="secondary" onClick={() => setOutOpen(false)}>Cancel</Button><Button loading={saving} onClick={saveOutward}>Save DC</Button></>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Input label="DC date *" type="date" value={out.dc_date} onChange={(e) => setOut({ ...out, dc_date: e.target.value })} />
          <Select label="Processor (Supplier / Vendor) *" value={out.vendor_id} onChange={(e) => setOut({ ...out, vendor_id: e.target.value })} placeholder="Select" options={vendorOpts} />
          <Select label="From store *" value={out.warehouse_id} onChange={(e) => setOut({ ...out, warehouse_id: e.target.value })} placeholder="Select" options={whOpts} />
          <Input label="Vehicle no" value={out.vehicle_no} onChange={(e) => setOut({ ...out, vehicle_no: e.target.value })} />
        </div>
        {jobs.map((j, ji) => (
          <div key={j.process_id} className="mt-3 rounded border border-slate-200">
            <div className="flex items-center justify-between bg-sky-50 px-2 py-1.5 text-[12px] font-semibold text-sky-900">
              <span>Job {j.io_no ?? 'stock'} · {j.process_no}</span>
              {ji > 0 && <button className="text-slate-500 hover:text-red-600" onClick={() => setJobs(jobs.filter((_, a) => a !== ji))}><Trash2 size={13} /></button>}
            </div>
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1.5 text-left">Yarn</th><th className="px-2 py-1.5 text-left">Yarn lot (GRN / PO / supplier) — this job's yarn first</th><th className="px-2 py-1.5 text-right">Cones</th><th className="px-2 py-1.5 text-right">KG</th><th /></tr></thead>
              <tbody>
                {j.lines.map((l, li) => {
                  const opts = j.lots.filter((o: any) => !l.yarn_id || Number(o.yarn_id) === Number(l.yarn_id));
                  return (
                    <tr key={li} className="border-t border-slate-100">
                      <td className="px-2 py-1"><select className="input h-8 w-full text-xs" value={l.yarn_id} onChange={(e) => setJobLine(ji, li, { yarn_id: e.target.value, grn_line_id: '' })}>
                        <option value="">Select yarn</option>{yarnOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
                      <td className="px-2 py-1"><select className="input h-8 w-full min-w-[300px] text-xs" value={l.grn_line_id} onChange={(e) => setJobLine(ji, li, { grn_line_id: e.target.value })}>
                        <option value="">{opts.length ? '— pick lot —' : 'No stock for this job — transfer yarn to the job first'}</option>
                        {opts.map((o: any) => <option key={`${o.grn_line_id}-${o.holder_so_id}`} value={o.grn_line_id}>{o.lot_no} · {o.grn_no}{o.po_no ? ` · PO ${o.po_no}` : ''}{o.supplier_name ? ` · ${o.supplier_name}` : ''} · {fmtDecimal(o.available_kg, 3)} KG ({o.holder_job})</option>)}
                      </select></td>
                      <td className="px-2 py-1 text-right"><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={l.no_of_cones} onChange={(e) => setJobLine(ji, li, { no_of_cones: e.target.value })} /></td>
                      <td className="px-2 py-1 text-right"><input type="number" min={0} step="0.001" className="input h-8 w-24 text-right text-xs" value={l.issued_qty_kg} onChange={(e) => setJobLine(ji, li, { issued_qty_kg: e.target.value })} /></td>
                      <td className="px-2 py-1 text-center">{j.lines.length > 1 && <button className="text-red-500" onClick={() => setJobs(jobs.map((x, a) => (a !== ji ? x : { ...x, lines: x.lines.filter((_, b) => b !== li) })))}><Trash2 size={13} /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button size="sm" variant="secondary" className="m-2" onClick={() => setJobs(jobs.map((x, a) => (a !== ji ? x : { ...x, lines: [...x.lines, blankLine()] })))}><Plus size={12} className="mr-1" /> Add yarn line</Button>
          </div>
        ))}
        <div className="mt-3 flex items-end gap-2">
          <Select label="Add another job (same process) to this DC" className="w-80" value={addId} placeholder="— Released job —" onChange={(e) => setAddId(e.target.value)}
            options={others.filter((p) => !jobs.some((j) => j.process_id === p.id)).map((p) => ({ value: p.id, label: `${p.process_no} · ${p.io_no ?? 'stock'}` }))} />
          <Button size="sm" variant="secondary" disabled={!addId} onClick={addJob}><Plus size={12} className="mr-1" /> Add job</Button>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Remarks" value={out.remarks} onChange={(e) => setOut({ ...out, remarks: e.target.value })} />
          <div className="space-y-2">
            <Checkbox label="Issue beyond free stock (needs right)" checked={out.allow_override} onChange={(v: boolean) => setOut({ ...out, allow_override: v })} />
            {out.allow_override && <Input label="Override reason" value={out.override_reason} onChange={(e) => setOut({ ...out, override_reason: e.target.value })} />}
          </div>
        </div>
      </Modal>

      <Modal open={!!inDc} onClose={() => setInDc(null)} title={`Inward against DC ${inDc?.dc_no ?? ''}`}
        footer={<><Button variant="secondary" onClick={() => setInDc(null)}>Cancel</Button><Button loading={saving} onClick={saveInward}>Save Inward</Button></>}>
        <p className="mb-3 text-xs text-slate-600">Sent {fmtDecimal(inDc?.issued_kg, 3)} KG · received {fmtDecimal(inDc?.received_kg, 3)} KG · <b>pending {fmtDecimal(inDc?.pending_kg, 3)} KG</b>. Loss = received − output − rejected.</p>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Inward date *" type="date" value={inw.receipt_date} onChange={(e) => setInw({ ...inw, receipt_date: e.target.value })} />
          <Input label="Processor DC no" value={inw.party_dc_no} onChange={(e) => setInw({ ...inw, party_dc_no: e.target.value })} />
          <Input label="Yarn received against DC (KG) *" type="number" value={inw.input_qty} onChange={(e) => setInw({ ...inw, input_qty: e.target.value })} />
          <Input label="Output KG (good)" type="number" value={inw.output_qty} onChange={(e) => setInw({ ...inw, output_qty: e.target.value })} />
          <Input label="Rejected KG" type="number" value={inw.rejected_qty} onChange={(e) => setInw({ ...inw, rejected_qty: e.target.value })} />
          <Input label="Output lot no" value={inw.output_lot_no} onChange={(e) => setInw({ ...inw, output_lot_no: e.target.value })} />
          <Select label="To store *" value={inw.warehouse_id} onChange={(e) => setInw({ ...inw, warehouse_id: e.target.value })} placeholder="Select" options={whOpts} />
          <Input label="Vehicle no" value={inw.vehicle_no} onChange={(e) => setInw({ ...inw, vehicle_no: e.target.value })} />
          <Select label="QC status" value={inw.qc_status} onChange={(e) => setInw({ ...inw, qc_status: e.target.value, post_stock: e.target.value === 'PASSED' ? inw.post_stock : false })}
            options={['PENDING', 'PASSED', 'HOLD', 'REJECTED'].map((v) => ({ value: v, label: v }))} />
          <div className="pt-6"><Checkbox label="Post to yarn stock now (QC passed)" checked={inw.post_stock} disabled={inw.qc_status !== 'PASSED'} onChange={(v: boolean) => setInw({ ...inw, post_stock: v })} /></div>
        </div>
      </Modal>
    </div>
  );
}
