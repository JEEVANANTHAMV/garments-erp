import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, ScanLine, Download, Save, CheckCircle2, Printer, Trash2, Ban, PackageCheck } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { http } from '../../../lib/api';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { Button, Modal, Input, Select, Textarea, SearchInput, LoadingBlock } from '../../../components/ui';
import { fmtDate, today } from '../../../lib/format';
import { FpTitle, FpStatus, ReconCards, useProcessTypes, useJobs, errText, kg, n, r3, esc, printDoc, groupByJob, type StoreRoll, type Job } from './shared';

/**
 * Fabric Process — Outward DC (doc §5): one DC, many jobs, many rolls per job.
 * Rows are grouped by job with a subtotal and a sticky total; Save Draft keeps the store untouched,
 * Confirm DC issues the rolls (whole or part KG).
 */
interface DcRow {
  fabric_roll_id: number; roll_no: string; lot_no: string | null; fabric_name: string; so_id: number | null; io_no: string | null;
  buyer_po_no: string | null; style_code: string | null; color_name: string; gsm: string | number | null; dia: string | null;
  available_kg: number; weight_kg: number; meters: number;
}

export default function FabricProcessOutwardPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  if (id) return <OutwardEditor id={id === 'new' ? null : Number(id)} onBack={() => setParams({})} onOpen={(x) => setParams({ id: String(x) })} />;
  return <OutwardList onOpen={(x) => setParams({ id: String(x) })} />;
}

function OutwardList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['fabric-process', 'outward'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/outward')).data ?? [] });
  const rows = (list.data ?? []).filter((o) => (!status || o.status === status) &&
    (!q || [o.fpo_no, o.vendor_name, o.jobs, o.color_name, o.challan_no].some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase()))));
  return (
    <div>
      <FpTitle no={1} title="Process Outward DC" sub="Fabric to dyeing / washing / compacting / printing … — multiple jobs and rolls per DC"
        actions={can('FABRIC_PROCESS.CREATE') ? <Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Outward DC</Button> : null} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap gap-2 border-b border-surface-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="DC no, supplier / vendor, job, colour…" className="w-72" />
          <select className="input w-48 py-1.5 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {[['DRAFT', 'Draft'], ['DISPATCHED', 'Confirmed'], ['PARTIALLY_RECEIVED', 'Partially received'], ['COMPLETED', 'Fully received'], ['CANCELLED', 'Cancelled']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {list.isLoading ? <LoadingBlock /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                {['DC no', 'Date', 'Process', 'Supplier / Vendor', 'Jobs', 'Rolls', 'Outward KG', 'Good', 'Reject', 'Loss', 'Balance', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|Good|Reject|Loss|Balance|Rolls/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(o.id)}>
                    <td className="px-3 py-2 font-mono font-semibold text-brand-700">{o.fpo_no}{o.is_reprocess ? <span className="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-800">Reprocess</span> : null}</td>
                    <td className="px-3 py-2">{fmtDate(o.fpo_date)}</td>
                    <td className="px-3 py-2">{o.process_name || o.sub_process}</td>
                    <td className="px-3 py-2">{o.vendor_name}</td>
                    <td className="px-3 py-2">{o.jobs || '—'} <span className="text-slate-400">({o.job_count})</span></td>
                    <td className="px-3 py-2 text-right">{o.roll_count}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{kg(o.outward_kg)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{kg(o.good_kg)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-700">{kg(o.reject_kg)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-700">{kg(o.loss_kg)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${o.balance_kg > 0 ? 'font-semibold text-orange-700' : 'text-slate-400'}`}>{kg(o.balance_kg)}</td>
                    <td className="px-3 py-2"><FpStatus value={o.status} /></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={12} className="px-3 py-10 text-center text-slate-400">No outward DCs yet</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function OutwardEditor({ id, onBack, onOpen }: { id: number | null; onBack: () => void; onOpen: (id: number) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const types = useProcessTypes();
  const jobs = useJobs();
  const suppliers = useLookup('suppliers');
  const warehouses = useLookup('warehouses');
  const detail = useQuery({ queryKey: ['fabric-process', 'outward', id], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/outward/${id}`)).data, enabled: !!id });
  const d = detail.data;
  const editable = !id || d?.status === 'DRAFT';
  const [head, setHead] = useState({ fpo_date: today(), sub_process: 'DYEING', vendor_id: '', from_warehouse_id: '', to_location: '', vehicle_no: '', challan_no: '',
    color_name: '', shade_code: '', target_dia: '', target_gsm: '', expected_return_date: '', remarks: '' });
  const [rows, setRows] = useState<DcRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<null | 'job' | 'scan' | 'import'>(null);

  useEffect(() => {
    if (!d) return;
    setHead({ fpo_date: String(d.fpo_date).slice(0, 10), sub_process: d.sub_process, vendor_id: String(d.vendor_id ?? ''), from_warehouse_id: d.from_warehouse_id ? String(d.from_warehouse_id) : '',
      to_location: d.to_location ?? '', vehicle_no: d.vehicle_no ?? '', challan_no: d.challan_no ?? '', color_name: d.color_name ?? '', shade_code: d.shade_code ?? '',
      target_dia: d.target_dia ?? '', target_gsm: d.target_gsm ?? '', expected_return_date: d.expected_return_date ? String(d.expected_return_date).slice(0, 10) : '', remarks: d.remarks ?? '' });
    setRows((d.rolls ?? []).map((r: any) => ({ fabric_roll_id: Number(r.fabric_roll_id), roll_no: r.roll_no, lot_no: r.lot_no, fabric_name: r.fabric_name, so_id: r.so_id, io_no: r.io_no,
      buyer_po_no: r.buyer_po_no, style_code: r.style_code, color_name: r.color_name ?? '', gsm: r.gsm, dia: r.dia, available_kg: n(r.weight_kg), weight_kg: n(r.weight_kg), meters: n(r.meters) })));
  }, [d]);

  const groups = useMemo(() => groupByJob(rows), [rows]);
  const total = rows.reduce((a, r) => a + n(r.weight_kg), 0);
  const addRolls = (picked: StoreRoll[], job: Job | null, kgOf: (r: StoreRoll) => number) => {
    setRows((prev) => {
      const next = [...prev];
      for (const r of picked) {
        if (next.some((x) => x.fabric_roll_id === r.id)) continue;
        next.push({ fabric_roll_id: r.id, roll_no: r.roll_no, lot_no: r.lot_no, fabric_name: r.fabric_name, so_id: job?.id ?? r.so_id, io_no: job?.job_no ?? r.io_no,
          buyer_po_no: job?.buyer_po_no ?? r.buyer_po_no, style_code: job?.styles?.[0]?.style_code ?? r.style_code, color_name: head.color_name || r.color_name || '',
          gsm: r.gsm, dia: r.dia, available_kg: r.balance_kg, weight_kg: kgOf(r), meters: 0 });
      }
      return next;
    });
  };
  const set = (rid: number, p: Partial<DcRow>) => setRows((rs) => rs.map((r) => (r.fabric_roll_id === rid ? { ...r, ...p } : r)));

  const payload = () => ({
    ...head, vendor_id: Number(head.vendor_id), from_warehouse_id: head.from_warehouse_id ? Number(head.from_warehouse_id) : null, expected_return_date: head.expected_return_date || null,
    rolls: rows.map((r) => ({ fabric_roll_id: r.fabric_roll_id, so_id: r.so_id, weight_kg: n(r.weight_kg), meters: n(r.meters), color_name: r.color_name || null })),
  });
  const save = async (confirm: boolean) => {
    if (!head.vendor_id) { toast('Choose the process unit (supplier / vendor)', 'warning'); return; }
    if (!rows.length) { toast('Add jobs and rolls', 'warning'); return; }
    const bad = rows.find((r) => n(r.weight_kg) <= 0 || n(r.weight_kg) > r.available_kg + 1e-6);
    if (bad) { toast(`Roll ${bad.roll_no}: KG must be between 0 and ${kg(bad.available_kg)}`, 'warning'); return; }
    setBusy(true);
    try {
      if (!id) {
        const r = await http.post<{ data: any }>('/fabric-process/outward', { ...payload(), confirm });
        toast(`${r.data.fpo_no} ${confirm ? 'confirmed — stock issued' : 'saved as draft'}`, 'success');
        void qc.invalidateQueries({ queryKey: ['fabric-process'] });
        onOpen(r.data.id);
      } else {
        await http.put(`/fabric-process/outward/${id}`, payload());
        if (confirm) await http.post(`/fabric-process/outward/${id}/confirm`, {});
        toast(confirm ? `${d.fpo_no} confirmed — stock issued` : `${d.fpo_no} saved`, 'success');
        void qc.invalidateQueries({ queryKey: ['fabric-process'] });
      }
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const cancel = async () => {
    const reason = window.prompt(`Cancel ${d.fpo_no}? Reason:`);
    if (reason === null) return;
    setBusy(true);
    try {
      const r = await http.post<{ message: string }>(`/fabric-process/outward/${id}/cancel`, { reason });
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['fabric-process'] });
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const print = () => {
    const vendor = suppliers.data?.find((s: any) => String(s.id) === head.vendor_id)?.label ?? d?.vendor_name ?? '';
    const proc = types.data?.find((t) => t.code === head.sub_process)?.name ?? head.sub_process;
    const body = groups.map((g) => `<tr class="grp"><td colspan="9">Job ${esc(g.io_no)}${g.rows[0].buyer_po_no ? ` · PO ${esc(g.rows[0].buyer_po_no)}` : ''}${g.rows[0].style_code ? ` · Style ${esc(g.rows[0].style_code)}` : ''}</td></tr>` +
      g.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.roll_no)}</td><td>${esc(r.lot_no ?? '')}</td><td>${esc(r.fabric_name ?? '')}</td><td>${esc(r.color_name)}</td><td>${esc(r.gsm ?? '')}</td><td>${esc(r.dia ?? '')}</td><td class="r">${kg(r.weight_kg)}</td><td class="r">${n(r.meters) ? n(r.meters).toFixed(2) : ''}</td></tr>`).join('') +
      `<tr class="sub"><td colspan="7">Job total — ${g.rows.length} roll(s)</td><td class="r">${kg(g.rows.reduce((a, r) => a + n(r.weight_kg), 0))}</td><td></td></tr>`).join('');
    printDoc(d?.fpo_no ?? 'Outward DC',
      `<h1>DELIVERY CHALLAN — FABRIC ${esc(proc.toUpperCase())}</h1><table class="meta"><tr><td><b>DC No:</b> ${esc(d?.fpo_no ?? '(draft)')}</td><td><b>Date:</b> ${esc(fmtDate(head.fpo_date))}</td><td><b>Challan:</b> ${esc(head.challan_no || '—')}</td></tr>
       <tr><td><b>Supplier / Vendor:</b> ${esc(vendor)}</td><td><b>To:</b> ${esc(head.to_location || '—')}</td><td><b>Vehicle:</b> ${esc(head.vehicle_no || '—')}</td></tr>
       <tr><td><b>Colour / shade:</b> ${esc([head.color_name, head.shade_code].filter(Boolean).join(' / ') || '—')}</td><td><b>Target dia / GSM:</b> ${esc(head.target_dia || '—')} / ${esc(head.target_gsm || '—')}</td><td><b>Jobs:</b> ${groups.length}</td></tr></table>`,
      `<table><thead><tr><th>#</th><th>Roll</th><th>Lot</th><th>Fabric</th><th>Colour</th><th>GSM</th><th>Dia</th><th class="r">KG</th><th class="r">Mtr</th></tr></thead><tbody>${body}
       <tr class="sub"><td colspan="7">GRAND TOTAL — ${rows.length} roll(s), ${groups.length} job(s)</td><td class="r">${kg(total)}</td><td></td></tr></tbody></table>
       <p>Goods sent for job work (${esc(proc)}) and to be returned after processing — not for sale. ${esc(head.remarks)}</p>`);
  };

  if (id && detail.isLoading) return <LoadingBlock />;
  return (
    <div>
      <FpTitle no={1} title={id ? `Process Outward DC — ${d?.fpo_no}` : 'New Process Outward DC'} sub={d?.is_reprocess ? `Reprocess DC for ${d.reprocess_no}` : 'Multiple jobs / multiple rolls'}
        actions={<>
          {d && <FpStatus value={d.status} />}
          <Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>
        </>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Input label="DC date *" type="date" value={head.fpo_date} disabled={!editable} onChange={(e) => setHead({ ...head, fpo_date: e.target.value })} />
        <Select label="Process *" value={head.sub_process} disabled={!editable} onChange={(e) => setHead({ ...head, sub_process: e.target.value })}
          options={(types.data ?? []).filter((t) => !t.is_reprocess || head.sub_process === t.code).map((t) => ({ value: t.code, label: t.name }))} />
        <Select label="Process unit (Supplier / Vendor) *" value={head.vendor_id} disabled={!editable} placeholder="— Supplier / vendor —" onChange={(e) => setHead({ ...head, vendor_id: e.target.value })} options={toOptions(suppliers.data)} />
        <Select label="From store" value={head.from_warehouse_id} disabled={!editable} placeholder="— Any store —" onChange={(e) => setHead({ ...head, from_warehouse_id: e.target.value })} options={toOptions(warehouses.data)} />
        <Input label="To process location" value={head.to_location} disabled={!editable} placeholder="Unit / location" onChange={(e) => setHead({ ...head, to_location: e.target.value })} />
        <Input label="Challan no" value={head.challan_no} disabled={!editable} onChange={(e) => setHead({ ...head, challan_no: e.target.value })} />
        <Input label="Vehicle no" value={head.vehicle_no} disabled={!editable} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} />
        <Input label="Colour to dye / print" value={head.color_name} disabled={!editable} onChange={(e) => setHead({ ...head, color_name: e.target.value })} />
        <Input label="Shade / lab dip" value={head.shade_code} disabled={!editable} onChange={(e) => setHead({ ...head, shade_code: e.target.value })} />
        <Input label="Target dia" value={head.target_dia} disabled={!editable} placeholder='e.g. 34' onChange={(e) => setHead({ ...head, target_dia: e.target.value })} />
        <Input label="Target GSM" value={head.target_gsm} disabled={!editable} onChange={(e) => setHead({ ...head, target_gsm: e.target.value })} />
        <Input label="Expected return" type="date" value={head.expected_return_date} disabled={!editable} onChange={(e) => setHead({ ...head, expected_return_date: e.target.value })} />
        <Textarea label="Remarks" className="col-span-2 md:col-span-6" rows={1} value={head.remarks} disabled={!editable} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-slate-800">Job entry <span className="font-normal text-slate-500">· {groups.length} job(s), {rows.length} roll(s)</span></h3>
          {editable && <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setPicker('job')}><Plus size={13} className="mr-1" /> Add Job</Button>
            <Button size="sm" variant="secondary" onClick={() => setPicker('scan')}><ScanLine size={13} className="mr-1" /> Scan Roll</Button>
            <Button size="sm" variant="secondary" onClick={() => setPicker('import')}><Download size={13} className="mr-1" /> Import from Job</Button>
            <Button size="sm" variant="danger" disabled={!rows.length} onClick={() => setRows([])}><Trash2 size={13} className="mr-1" /> Clear all</Button>
          </div>}
        </div>
        <div className="max-h-[55vh] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500"><tr>
              {['#', 'Job no', 'PO no', 'Style no', 'Colour', 'Roll no', 'Lot no', 'Fabric', 'GSM', 'Dia', 'In store KG', 'Qty (KG)', 'Mtr', ''].map((h) => <th key={h} className={`px-2 py-2 ${/KG|Mtr/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
            </tr></thead>
            <tbody>
              {groups.map((g) => (
                <JobGroup key={g.io_no} g={g} editable={editable} set={set} remove={(rid) => setRows((rs) => rs.filter((r) => r.fabric_roll_id !== rid))} />
              ))}
              {!rows.length && <tr><td colSpan={14} className="px-3 py-10 text-center text-slate-400">Click “Add Job” to pick a job and its rolls from the store (or scan / import rolls)</td></tr>}
            </tbody>
            <tfoot className="sticky bottom-0 bg-slate-100 font-bold text-slate-800">
              <tr><td colSpan={11} className="px-2 py-2 text-right">Total rolls: {rows.length} · jobs: {groups.length}</td><td className="px-2 py-2 text-right tabular-nums">{kg(total)}</td><td colSpan={2} /></tr>
            </tfoot>
          </table>
        </div>
      </div>

      {d && d.status !== 'DRAFT' && (
        <div className="card mt-3 space-y-3 p-4">
          <h3 className="text-[13px] font-semibold text-slate-800">Reconciliation — DC vs GRN</h3>
          <ReconCards t={d.reconciliation.total} />
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'PO', 'Style', 'Colour', 'Rolls', 'Outward KG', 'Good KG', 'Reject KG', 'Loss KG', 'Balance'].map((h) => <th key={h} className={`px-2 py-1.5 ${/KG|Balance|Rolls/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>{d.reconciliation.jobs.map((j: any) => (
              <tr key={`${j.io_no}${j.color_name}`} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{j.io_no}</td><td className="px-2 py-1">{j.buyer_po_no || '—'}</td><td className="px-2 py-1">{j.style_code || '—'}</td><td className="px-2 py-1">{j.color_name || '—'}</td>
                <td className="px-2 py-1 text-right">{j.rolls}</td><td className="px-2 py-1 text-right">{kg(j.outward_kg)}</td><td className="px-2 py-1 text-right text-emerald-700">{kg(j.good_kg)}</td><td className="px-2 py-1 text-right text-red-700">{kg(j.reject_kg)}</td>
                <td className="px-2 py-1 text-right text-amber-700">{kg(j.loss_kg)}</td><td className={`px-2 py-1 text-right ${j.balance_kg > 0 ? 'font-semibold text-orange-700' : ''}`}>{kg(j.balance_kg)}</td></tr>
            ))}</tbody>
          </table>
          {d.inwards?.length > 0 && <p className="text-xs text-slate-600">GRNs: {d.inwards.map((i: any) => `${i.inward_no} (${fmtDate(i.inward_date)}, good ${kg(i.good_kg)} KG)`).join(' · ')}</p>}
        </div>
      )}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {editable && can(id ? 'FABRIC_PROCESS.EDIT_DRAFT' : 'FABRIC_PROCESS.CREATE') && <Button variant="secondary" loading={busy} onClick={() => save(false)}><Save size={14} className="mr-1" /> Save Draft</Button>}
        {editable && can('FABRIC_PROCESS.CONFIRM') && <Button loading={busy} onClick={() => save(true)}><CheckCircle2 size={14} className="mr-1" /> Confirm DC</Button>}
        {d && ['DRAFT', 'DISPATCHED'].includes(d.status) && !d.inwards?.length && can(d.status === 'DRAFT' ? 'FABRIC_PROCESS.EDIT_DRAFT' : 'FABRIC_PROCESS.CANCEL') && <Button variant="danger" loading={busy} onClick={cancel}><Ban size={14} className="mr-1" /> Cancel DC</Button>}
        {d && ['DISPATCHED', 'PARTIALLY_RECEIVED', 'IN_PROCESS'].includes(d.status) && can('FABRIC_PROCESS.CREATE') && <Button onClick={() => nav(`/production/fabric-process/inward?fpo=${id}`)}><PackageCheck size={14} className="mr-1" /> Receive (GRN)</Button>}
        <Button variant="secondary" disabled={!rows.length} onClick={print}><Printer size={14} className="mr-1" /> Print DC</Button>
      </div>

      {picker && <RollPicker mode={picker} jobs={jobs.data ?? []} warehouseId={head.from_warehouse_id} taken={rows.map((r) => r.fabric_roll_id)}
        onClose={() => setPicker(null)} onAdd={(picked, job, kgOf) => { addRolls(picked, job, kgOf); setPicker(null); toast(`${picked.length} roll(s) added${job ? ` to ${job.job_no}` : ''}`, 'success'); }} />}
    </div>
  );
}

function JobGroup({ g, editable, set, remove }: { g: { io_no: string; rows: DcRow[] }; editable: boolean; set: (id: number, p: Partial<DcRow>) => void; remove: (id: number) => void }) {
  const sub = g.rows.reduce((a, r) => a + n(r.weight_kg), 0);
  return (
    <>
      <tr className="bg-sky-50/70"><td colSpan={14} className="px-2 py-1.5 text-[11.5px] font-semibold text-sky-900">Job {g.io_no}{g.rows[0].buyer_po_no ? ` · PO ${g.rows[0].buyer_po_no}` : ''}{g.rows[0].style_code ? ` · Style ${g.rows[0].style_code}` : ''}</td></tr>
      {g.rows.map((r, i) => (
        <tr key={r.fabric_roll_id} className="border-t border-slate-100">
          <td className="px-2 py-1 text-slate-400">{i + 1}</td>
          <td className="px-2 py-1 font-semibold">{r.io_no || 'STOCK'}</td>
          <td className="px-2 py-1">{r.buyer_po_no || '—'}</td>
          <td className="px-2 py-1">{r.style_code || '—'}</td>
          <td className="px-2 py-1">{editable ? <input className="input w-24 py-0.5 text-xs" value={r.color_name} onChange={(e) => set(r.fabric_roll_id, { color_name: e.target.value })} /> : (r.color_name || '—')}</td>
          <td className="px-2 py-1 font-mono">{r.roll_no}</td>
          <td className="px-2 py-1">{r.lot_no || '—'}</td>
          <td className="px-2 py-1">{r.fabric_name}</td>
          <td className="px-2 py-1">{r.gsm || '—'}</td>
          <td className="px-2 py-1">{r.dia || '—'}</td>
          <td className="px-2 py-1 text-right tabular-nums text-slate-500">{kg(r.available_kg)}</td>
          <td className="px-2 py-1 text-right">{editable
            ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={r.weight_kg} onChange={(e) => set(r.fabric_roll_id, { weight_kg: Number(e.target.value) })} />
            : <span className="tabular-nums">{kg(r.weight_kg)}</span>}</td>
          <td className="px-2 py-1 text-right">{n(r.meters) ? n(r.meters).toFixed(2) : ''}</td>
          <td className="px-2 py-1 text-right">{editable && <button className="p-1 text-slate-400 hover:text-red-600" onClick={() => remove(r.fabric_roll_id)}><Trash2 size={13} /></button>}</td>
        </tr>
      ))}
      <tr className="bg-slate-50 font-semibold"><td colSpan={11} className="px-2 py-1 text-right text-slate-600">Job {g.io_no} subtotal · {g.rows.length} roll(s)</td><td className="px-2 py-1 text-right tabular-nums">{kg(sub)}</td><td colSpan={2} /></tr>
    </>
  );
}

/** Add Job (job → its store rolls + rolls without a job), Scan Roll, Import from Job (all rolls of the job). */
function RollPicker({ mode, jobs, warehouseId, taken, onClose, onAdd }: {
  mode: 'job' | 'scan' | 'import'; jobs: Job[]; warehouseId: string; taken: number[];
  onClose: () => void; onAdd: (rolls: StoreRoll[], job: Job | null, kgOf: (r: StoreRoll) => number) => void;
}) {
  const toast = useToast();
  const [jobId, setJobId] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Record<number, number>>({});
  const job = jobs.find((j) => String(j.id) === jobId) ?? null;
  const rolls = useQuery({
    queryKey: ['fabric-process', 'store-rolls', mode, jobId, warehouseId],
    queryFn: async () => {
      const p = new URLSearchParams();
      if (warehouseId) p.set('warehouse_id', warehouseId);
      const all = (await http.get<{ data: StoreRoll[] }>(`/fabric-process/store-rolls?${p}`)).data ?? [];
      return all.filter((r) => !taken.includes(r.id));
    },
    enabled: mode === 'scan' || !!jobId,
  });
  const forJob = (rolls.data ?? []).filter((r) => (mode === 'import' ? r.so_id === job?.id : (!r.so_id || r.so_id === job?.id)));
  const shown = forJob.filter((r) => !q || [r.roll_no, r.lot_no, r.grn_no, r.fabric_name].some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase())));

  if (mode === 'scan') {
    const scan = () => {
      const r = (rolls.data ?? []).find((x) => x.roll_no.toLowerCase() === q.trim().toLowerCase());
      if (!r) { toast(`Roll ${q} is not in the store (or already on the DC)`, 'warning'); return; }
      const j = r.so_id ? jobs.find((x) => x.id === r.so_id) ?? null : job;
      if (!j && !jobId && !r.so_id) { toast('The roll has no job — choose the job first', 'warning'); return; }
      onAdd([r], j, (x) => x.balance_kg);
    };
    return (
      <Modal open onClose={onClose} title="Scan roll" size="md" footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={scan}>Add roll</Button></>}>
        <div className="grid gap-3">
          <Input label="Roll no / barcode" autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') scan(); }} />
          <Select label="Job (for rolls without a job)" value={jobId} placeholder="— roll's own job —" onChange={(e) => setJobId(e.target.value)} options={jobs.map((j) => ({ value: j.id, label: j.job_no }))} />
        </div>
      </Modal>
    );
  }
  const picked = shown.filter((r) => sel[r.id] !== undefined);
  return (
    <Modal open onClose={onClose} size="xl" title={mode === 'import' ? 'Import all store rolls of a job' : 'Add job — pick its rolls from the store'}
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-600">{mode === 'import' ? `${forJob.length} roll(s), ${kg(forJob.reduce((a, r) => a + r.balance_kg, 0))} KG` : `${picked.length} selected · ${kg(picked.reduce((a, r) => a + n(sel[r.id]), 0))} KG`}</span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!job || (mode === 'import' ? !forJob.length : !picked.length)}
          onClick={() => (mode === 'import' ? onAdd(forJob, job, (r) => r.balance_kg) : onAdd(picked, job, (r) => n(sel[r.id]) || r.balance_kg))}>
          {mode === 'import' ? 'Import rolls' : 'Add rolls'}
        </Button>
      </>}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Select label="Job *" className="w-64" value={jobId} placeholder="— Job / IO —" onChange={(e) => { setJobId(e.target.value); setSel({}); }} options={jobs.map((j) => ({ value: j.id, label: `${j.job_no}${j.buyer_name ? ` · ${j.buyer_name}` : ''}` }))} />
        {mode === 'job' && <SearchInput value={q} onChange={setQ} placeholder="Roll, lot, GRN, fabric…" className="w-64" />}
        {job && <span className="text-xs text-slate-500">Rolls of {job.job_no}{mode === 'job' ? ' + rolls without a job' : ''}</span>}
      </div>
      <div className="max-h-[50vh] overflow-auto rounded border border-slate-200">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr>{[mode === 'job' ? '' : null, 'Roll', 'Lot', 'Fabric', 'Job', 'State', 'Colour', 'GSM', 'Dia', 'GRN', 'Store', 'In store KG', mode === 'job' ? 'Send KG' : null].filter((x) => x !== null).map((h, i) => <th key={i} className={`px-2 py-1.5 ${/KG/.test(String(h)) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {!job && <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">Choose the job first</td></tr>}
            {job && rolls.isLoading && <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">Loading…</td></tr>}
            {job && shown.map((r) => {
              const on = sel[r.id] !== undefined;
              return (
                <tr key={r.id} className={`border-t border-slate-100 ${on ? 'bg-emerald-50' : ''}`}>
                  {mode === 'job' && <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setSel((s) => { const x = { ...s }; if (on) delete x[r.id]; else x[r.id] = r.balance_kg; return x; })} /></td>}
                  <td className="px-2 py-1 font-mono font-semibold">{r.roll_no}</td><td className="px-2 py-1">{r.lot_no || '—'}</td><td className="px-2 py-1">{r.fabric_name}</td>
                  <td className="px-2 py-1">{r.so_id ? r.io_no : <span className="text-slate-400">no job</span>}</td>
                  <td className="px-2 py-1"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${r.process_state === 'GREY' ? 'bg-slate-100 text-slate-600' : 'bg-purple-100 text-purple-800'}`}>{r.process_state}</span></td>
                  <td className="px-2 py-1">{r.color_name || '—'}</td><td className="px-2 py-1">{r.gsm || '—'}</td><td className="px-2 py-1">{r.dia || '—'}</td>
                  <td className="px-2 py-1 font-mono">{r.grn_no}</td><td className="px-2 py-1">{r.warehouse_name || '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{kg(r.balance_kg)}</td>
                  {mode === 'job' && <td className="px-2 py-1 text-right">{on ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={sel[r.id]} onChange={(e) => setSel((s) => ({ ...s, [r.id]: r3(Number(e.target.value)) }))} /> : '—'}</td>}
                </tr>
              );
            })}
            {job && !rolls.isLoading && !shown.length && <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">No rolls in the store for this job</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
