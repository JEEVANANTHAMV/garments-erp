import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, ScanLine, Download, Save, CheckCircle2, Printer, Trash2, Ban, PackageCheck, Lock } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { http } from '../../../lib/api';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { Button, Modal, Input, Select, Textarea, SearchInput, LoadingBlock } from '../../../components/ui';
import { fmtDate, today } from '../../../lib/format';
import { YpTitle, YpStatus, ReconCards, useJobs, useYarnTypes, errText, kg, n, r3, esc, printDoc, groupByJob, MODE_LABEL, type Job, type YarnLot } from './shared';

/**
 * Yarn Process — Outward DC (doc §6 / §8): one DC to a dyer / winder / twister carries many jobs,
 * lots and cones. Lines are grouped by job; Save Draft keeps the stock, Confirm DC issues the lots.
 */
interface Row {
  key: string; grn_line_id: number; so_id: number | null; io_no: string; buyer_po_no: string | null; lot_no: string; yarn_name: string; shade: string; grn_no: string;
  available_kg: number; qty_kg: number; cone_no: string; no_of_cones: number; target_shade: string; process_id: string;
}
let seq = 0;
const STATUSES: [string, string][] = [['DRAFT', 'Draft'], ['CONFIRMED', 'Confirmed'], ['PARTIALLY_RECEIVED', 'Partially received'], ['COMPLETED', 'Fully received'], ['CLOSED', 'Closed'], ['CANCELLED', 'Cancelled']];

export default function YarnProcessOutwardPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  if (id) return <OutwardEditor id={id === 'new' ? null : Number(id)} onBack={() => setParams({})} onOpen={(x) => setParams({ id: String(x) })} />;
  return <OutwardList onOpen={(x) => setParams({ id: String(x) })} />;
}

function OutwardList({ onOpen }: { onOpen: (id: number | 'new') => void }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['yarn-process', 'outward'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/outward')).data ?? [] });
  const rows = (list.data ?? []).filter((o) => (!status || o.status === status) && (!q || [o.ypo_no, o.vendor_name, o.jobs, o.target_shade, o.challan_no].some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase()))));
  return (
    <div>
      <YpTitle no={1} title="Yarn Process Outward DC" sub="Yarn to dyeing / winding / twisting — multiple jobs, lots and cones per DC"
        actions={can('YARN_PROCESS.CREATE') ? <Button onClick={() => onOpen('new')}><Plus size={14} className="mr-1" /> New Outward DC</Button> : null} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap gap-2 border-b border-surface-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="DC no, process unit, job, shade…" className="w-72" />
          <select className="input w-48 py-1.5 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {list.isLoading ? <LoadingBlock /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr>
                {['DC no', 'Date', 'Process', 'Process unit', 'Jobs', 'Lines', 'Cones', 'Outward KG', 'Good', 'Reject', 'Loss', 'Balance', 'Status'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|Good|Reject|Loss|Balance|Lines|Cones/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(o.id)}>
                    <td className="px-3 py-2 font-mono font-semibold text-brand-700">{o.ypo_no}{o.is_reprocess ? <span className="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-800">Reprocess</span> : null}</td>
                    <td className="px-3 py-2">{fmtDate(o.ypo_date)}</td><td className="px-3 py-2">{o.process_name || o.process_code}</td><td className="px-3 py-2">{o.vendor_name}</td>
                    <td className="px-3 py-2">{o.jobs || '—'} <span className="text-slate-400">({o.job_count})</span></td>
                    <td className="px-3 py-2 text-right">{o.line_count}</td><td className="px-3 py-2 text-right">{o.cones || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{kg(o.outward_kg)}</td><td className="px-3 py-2 text-right tabular-nums text-emerald-700">{kg(o.good_kg)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-700">{kg(o.reject_kg)}</td><td className="px-3 py-2 text-right tabular-nums text-amber-700">{kg(o.loss_kg)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${o.balance_kg > 0 ? 'font-semibold text-orange-700' : 'text-slate-400'}`}>{kg(o.balance_kg)}</td>
                    <td className="px-3 py-2"><YpStatus value={o.status} /></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">No yarn process DCs yet</td></tr>}
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
  const types = useYarnTypes();
  const jobs = useJobs();
  const suppliers = useLookup('suppliers');
  const warehouses = useLookup('warehouses');
  const detail = useQuery({ queryKey: ['yarn-process', 'outward', id], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/outward/${id}`)).data, enabled: !!id });
  const d = detail.data;
  const editable = !id || d?.status === 'DRAFT';
  const [head, setHead] = useState({ ypo_date: today(), process_code: 'YARN_DYEING', vendor_id: '', from_warehouse_id: '', to_location: '', vehicle_no: '', challan_no: '', target_shade: '', expected_return_date: '', remarks: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<null | 'job' | 'scan' | 'import'>(null);
  const pt = (types.data ?? []).find((t) => t.code === head.process_code);
  const programs = useQuery({ queryKey: ['yarn-process', 'programs', pt?.base_process], queryFn: async () => (await http.get<{ data: any[] }>(`/yarn-process/programs?base=${pt?.base_process}`)).data ?? [], enabled: !!pt && editable });

  useEffect(() => {
    if (!d) return;
    setHead({ ypo_date: String(d.ypo_date).slice(0, 10), process_code: d.process_code, vendor_id: String(d.vendor_id ?? ''), from_warehouse_id: d.from_warehouse_id ? String(d.from_warehouse_id) : '',
      to_location: d.to_location ?? '', vehicle_no: d.vehicle_no ?? '', challan_no: d.challan_no ?? '', target_shade: d.target_shade ?? '',
      expected_return_date: d.expected_return_date ? String(d.expected_return_date).slice(0, 10) : '', remarks: d.remarks ?? '' });
    setRows((d.lines ?? []).map((l: any) => ({ key: `r${++seq}`, grn_line_id: Number(l.grn_line_id), so_id: l.so_id, io_no: l.io_no || 'STOCK', buyer_po_no: l.buyer_po_no, lot_no: l.lot_no,
      yarn_name: l.yarn_name, shade: l.shade ?? '', grn_no: l.grn_no, available_kg: n(l.qty_kg), qty_kg: n(l.qty_kg), cone_no: l.cone_no ?? '', no_of_cones: Number(l.no_of_cones) || 0,
      target_shade: l.target_shade ?? '', process_id: l.process_id ? String(l.process_id) : '' })));
  }, [d]);

  const groups = useMemo(() => groupByJob(rows), [rows]);
  const total = rows.reduce((a, r) => a + n(r.qty_kg), 0);
  const cones = rows.reduce((a, r) => a + n(r.no_of_cones), 0);
  const addLots = (picked: { lot: YarnLot; kg: number; cone_no?: string; cones?: number }[], job: Job | null) => setRows((prev) => {
    // the same lot / cone (e.g. the job's part + the general part of one lot) becomes one DC line
    const next = [...prev];
    const fresh: typeof picked = [];
    for (const p of picked) {
      const cone = p.cone_no ?? p.lot.cone_no ?? '';
      const hit = next.find((r) => r.grn_line_id === p.lot.grn_line_id && (r.cone_no || '') === cone);
      if (hit) { hit.qty_kg = r3(hit.qty_kg + p.kg); hit.available_kg = r3(hit.available_kg + p.lot.available_kg); } else fresh.push(p);
    }
    return [...next, ...fresh.map(({ lot, kg: q, cone_no, cones: c }) => ({
    key: `r${++seq}`, grn_line_id: lot.grn_line_id, so_id: job?.id ?? lot.holder_so_id, io_no: job?.job_no ?? (lot.holder_so_id ? lot.holder_job : 'STOCK'), buyer_po_no: job?.buyer_po_no ?? null,
    lot_no: lot.lot_no, yarn_name: `${lot.yarn_name}${lot.count_str ? ` ${lot.count_str}` : ''}`, shade: lot.color_name || lot.shade || '', grn_no: lot.grn_no, available_kg: lot.available_kg,
    qty_kg: r3(q), cone_no: cone_no ?? lot.cone_no ?? '', no_of_cones: c ?? lot.cones ?? 0, target_shade: head.target_shade, process_id: '' }))];
  });
  const set = (k: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...p } : r)));

  const payload = () => ({
    ...head, vendor_id: Number(head.vendor_id), from_warehouse_id: head.from_warehouse_id ? Number(head.from_warehouse_id) : null, expected_return_date: head.expected_return_date || null,
    lines: rows.map((r) => ({ grn_line_id: r.grn_line_id, so_id: r.so_id, qty_kg: n(r.qty_kg), cone_no: r.cone_no || null, no_of_cones: n(r.no_of_cones), target_shade: r.target_shade || null,
      process_id: r.process_id ? Number(r.process_id) : null })),
  });
  const save = async (confirm: boolean) => {
    if (!head.vendor_id) { toast('Choose the process unit (supplier / vendor)', 'warning'); return; }
    if (!rows.length) { toast('Add jobs and yarn lots / cones', 'warning'); return; }
    const bad = rows.find((r) => n(r.qty_kg) <= 0 || n(r.qty_kg) > r.available_kg + 1e-6);
    if (bad) { toast(`Lot ${bad.lot_no}: KG must be between 0 and ${kg(bad.available_kg)}`, 'warning'); return; }
    setBusy(true);
    try {
      if (!id) {
        const r = await http.post<{ data: any; message: string }>('/yarn-process/outward', { ...payload(), confirm });
        toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); onOpen(r.data.id);
      } else {
        await http.put(`/yarn-process/outward/${id}`, payload());
        if (confirm) await http.post(`/yarn-process/outward/${id}/confirm`, {});
        toast(confirm ? `${d.ypo_no} confirmed — yarn issued` : `${d.ypo_no} saved`, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] });
      }
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const act = async (path: string, ask: string, need = false) => {
    const reason = window.prompt(ask);
    if (reason === null || (need && reason.trim().length < 3)) return;
    setBusy(true);
    try { const r = await http.post<{ message: string }>(`/yarn-process/outward/${id}/${path}`, { reason }); toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); }
    catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  const print = () => {
    const vendor = suppliers.data?.find((s: any) => String(s.id) === head.vendor_id)?.label ?? d?.vendor_name ?? '';
    const proc = pt?.name ?? head.process_code;
    const body = groups.map((g) => `<tr class="grp"><td colspan="9">Job ${esc(g.io_no)}${g.rows[0].buyer_po_no ? ` · PO ${esc(g.rows[0].buyer_po_no)}` : ''}</td></tr>` +
      g.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.yarn_name)}</td><td>${esc(r.shade)}</td><td>${esc(r.lot_no)}</td><td>${esc(r.cone_no)}</td><td class="r">${r.no_of_cones || ''}</td><td>${esc(r.target_shade)}</td><td>${esc(r.grn_no)}</td><td class="r">${kg(r.qty_kg)}</td></tr>`).join('') +
      `<tr class="sub"><td colspan="8">Job total</td><td class="r">${kg(g.rows.reduce((a, r) => a + n(r.qty_kg), 0))}</td></tr>`).join('');
    printDoc(d?.ypo_no ?? 'Yarn Outward DC',
      `<h1>DELIVERY CHALLAN — YARN ${esc(proc.toUpperCase())}</h1><table class="meta"><tr><td><b>DC No:</b> ${esc(d?.ypo_no ?? '(draft)')}</td><td><b>Date:</b> ${esc(fmtDate(head.ypo_date))}</td><td><b>Challan:</b> ${esc(head.challan_no || '—')}</td></tr>
       <tr><td><b>Process unit:</b> ${esc(vendor)}</td><td><b>To:</b> ${esc(head.to_location || '—')}</td><td><b>Vehicle:</b> ${esc(head.vehicle_no || '—')}</td></tr></table>`,
      `<table><thead><tr><th>#</th><th>Yarn</th><th>Shade</th><th>Lot</th><th>Cone</th><th class="r">Cones</th><th>Target shade</th><th>GRN</th><th class="r">KG</th></tr></thead><tbody>${body}
       <tr class="sub"><td colspan="5">GRAND TOTAL — ${groups.length} job(s)</td><td class="r">${cones || ''}</td><td colspan="2"></td><td class="r">${kg(total)}</td></tr></tbody></table>
       <p>Yarn sent for job work (${esc(proc)}) — to be returned after processing, not for sale. ${esc(head.remarks)}</p>`);
  };

  if (id && detail.isLoading) return <LoadingBlock />;
  return (
    <div>
      <YpTitle no={1} title={id ? `Yarn Process DC — ${d?.ypo_no}` : 'New Yarn Process Outward DC'} sub={d?.is_reprocess ? `Reprocess DC for ${d.reprocess_no}` : pt ? `${pt.name} · ${MODE_LABEL[pt.process_mode]}` : ''}
        actions={<>{d && <YpStatus value={d.status} />}<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Input label="DC date *" type="date" value={head.ypo_date} disabled={!editable} onChange={(e) => setHead({ ...head, ypo_date: e.target.value })} />
        <Select label="Process *" value={head.process_code} disabled={!editable} onChange={(e) => setHead({ ...head, process_code: e.target.value })}
          options={(types.data ?? []).filter((t) => t.is_active && (!t.is_reprocess || head.process_code === t.code)).map((t) => ({ value: t.code, label: t.name }))} />
        <Select label="Process unit (Supplier / Vendor) *" value={head.vendor_id} disabled={!editable} placeholder="— Process unit —" onChange={(e) => setHead({ ...head, vendor_id: e.target.value })} options={toOptions(suppliers.data)} />
        <Select label="From store" value={head.from_warehouse_id} disabled={!editable} placeholder="— Yarn store —" onChange={(e) => setHead({ ...head, from_warehouse_id: e.target.value })} options={toOptions(warehouses.data)} />
        <Input label="To process location" value={head.to_location} disabled={!editable} onChange={(e) => setHead({ ...head, to_location: e.target.value })} />
        <Input label="Challan no" value={head.challan_no} disabled={!editable} onChange={(e) => setHead({ ...head, challan_no: e.target.value })} />
        <Input label="Vehicle no" value={head.vehicle_no} disabled={!editable} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} />
        {pt?.changes_shade ? <Input label="Target shade (all lines)" value={head.target_shade} disabled={!editable} onChange={(e) => setHead({ ...head, target_shade: e.target.value })} /> : null}
        <Input label="Expected return" type="date" value={head.expected_return_date} disabled={!editable} onChange={(e) => setHead({ ...head, expected_return_date: e.target.value })} />
        <Textarea label="Remarks" className="col-span-2 md:col-span-3" rows={1} value={head.remarks} disabled={!editable} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-slate-800">Job / lot / cone entry <span className="font-normal text-slate-500">· {groups.length} job(s), {rows.length} line(s), {cones} cone(s)</span></h3>
          {editable && <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setPicker('job')}><Plus size={13} className="mr-1" /> Add Job</Button>
            <Button size="sm" variant="secondary" onClick={() => setPicker('scan')}><ScanLine size={13} className="mr-1" /> Scan Cone / Lot</Button>
            <Button size="sm" variant="secondary" onClick={() => setPicker('import')}><Download size={13} className="mr-1" /> Import from Job</Button>
            <Button size="sm" variant="danger" disabled={!rows.length} onClick={() => setRows([])}><Trash2 size={13} className="mr-1" /> Clear all</Button>
          </div>}
        </div>
        <div className="max-h-[55vh] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500"><tr>
              {['#', 'Job', 'Yarn item', 'Shade', 'Lot', 'GRN', 'Cone no', 'Cones', pt?.changes_shade ? 'Target shade' : null, 'Program', 'Available KG', 'Qty KG', ''].filter((x) => x !== null).map((h, i) => <th key={i} className={`px-2 py-2 ${/KG|Cones/.test(String(h)) ? 'text-right' : 'text-left'}`}>{h}</th>)}
            </tr></thead>
            <tbody>
              {groups.map((g) => (
                <JobRows key={g.io_no} g={g} editable={editable} shade={!!pt?.changes_shade} set={set} remove={(k) => setRows((rs) => rs.filter((r) => r.key !== k))}
                  programs={(programs.data ?? []).filter((p) => !g.rows[0].so_id || p.io_no === g.io_no || Number(p.so_id) === Number(g.rows[0].so_id))} />
              ))}
              {!rows.length && <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">“Add Job” picks a job and its yarn lots (its own + general stock); scan a lot / cone, or import every lot of a job</td></tr>}
            </tbody>
            <tfoot className="sticky bottom-0 bg-slate-100 font-bold"><tr><td colSpan={pt?.changes_shade ? 11 : 10} className="px-2 py-2 text-right">Total · {groups.length} job(s) · {cones} cone(s)</td><td className="px-2 py-2 text-right tabular-nums">{kg(total)}</td><td /></tr></tfoot>
          </table>
        </div>
      </div>

      {d && d.status !== 'DRAFT' && (
        <div className="card mt-3 space-y-3 p-4">
          <h3 className="text-[13px] font-semibold text-slate-800">Job-wise reconciliation — Outward = Good + Reject + Loss + Balance</h3>
          <ReconCards t={d.reconciliation.total} />
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'PO', 'Style', 'Lines', 'Outward KG', 'Good KG', 'Reject KG', 'Loss KG', 'Balance', 'Status'].map((h) => <th key={h} className={`px-2 py-1.5 ${/KG|Balance|Lines/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>{d.reconciliation.jobs.map((j: any) => (
              <tr key={j.io_no} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{j.io_no}</td><td className="px-2 py-1">{j.buyer_po_no || '—'}</td><td className="px-2 py-1">{j.style_code || '—'}</td>
                <td className="px-2 py-1 text-right">{j.lines}</td><td className="px-2 py-1 text-right">{kg(j.outward_kg)}</td><td className="px-2 py-1 text-right text-emerald-700">{kg(j.good_kg)}</td>
                <td className="px-2 py-1 text-right text-red-700">{kg(j.reject_kg)}</td><td className="px-2 py-1 text-right text-amber-700">{kg(j.loss_kg)}</td>
                <td className={`px-2 py-1 text-right ${j.balance_kg > 0 ? 'font-semibold text-orange-700' : ''}`}>{kg(j.balance_kg)}</td><td className="px-2 py-1"><YpStatus value={j.status} /></td></tr>
            ))}</tbody>
          </table>
          {d.inwards?.length > 0 && <p className="text-xs text-slate-600">GRNs: {d.inwards.map((i: any) => `${i.inward_no} (${fmtDate(i.inward_date)}, ${i.status === 'POSTED' ? `good ${kg(i.good_kg)} KG` : i.status.toLowerCase()})`).join(' · ')}</p>}
        </div>
      )}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {editable && can(id ? 'YARN_PROCESS.EDIT_DRAFT' : 'YARN_PROCESS.CREATE') && <Button variant="secondary" loading={busy} onClick={() => save(false)}><Save size={14} className="mr-1" /> Save Draft</Button>}
        {editable && can('YARN_PROCESS.CONFIRM') && <Button loading={busy} onClick={() => save(true)}><CheckCircle2 size={14} className="mr-1" /> Confirm DC</Button>}
        {d && (d.status === 'DRAFT' || (d.status === 'CONFIRMED' && !d.inwards?.some((i: any) => i.status !== 'CANCELLED'))) && can('YARN_PROCESS.CANCEL') && <Button variant="danger" loading={busy} onClick={() => act('cancel', `Cancel ${d.ypo_no}? Reason:`)}><Ban size={14} className="mr-1" /> Cancel DC</Button>}
        {d && ['CONFIRMED', 'PARTIALLY_RECEIVED'].includes(d.status) && can('YARN_PROCESS.CREATE') && <Button onClick={() => nav(`/production/yarn-process/inward?ypo=${id}`)}><PackageCheck size={14} className="mr-1" /> Receive (GRN)</Button>}
        {d && ['PARTIALLY_RECEIVED', 'COMPLETED'].includes(d.status) && can('YARN_PROCESS.CONFIRM') && <Button variant="secondary" loading={busy} onClick={() => act('close', `Close ${d.ypo_no}? KG still at the unit is written off as loss. Reason:`, true)}><Lock size={14} className="mr-1" /> Close DC</Button>}
        <Button variant="secondary" disabled={!rows.length} onClick={print}><Printer size={14} className="mr-1" /> Print DC</Button>
      </div>

      {picker && <LotPicker mode={picker} jobs={jobs.data ?? []} taken={rows} onClose={() => setPicker(null)}
        onAdd={(picked, job) => { addLots(picked, job); setPicker(null); toast(`${picked.length} line(s) added${job ? ` to ${job.job_no}` : ''}`, 'success'); }} />}
    </div>
  );
}

function JobRows({ g, editable, shade, set, remove, programs }: { g: { io_no: string; rows: Row[] }; editable: boolean; shade: boolean; set: (k: string, p: Partial<Row>) => void; remove: (k: string) => void; programs: any[] }) {
  const sub = g.rows.reduce((a, r) => a + n(r.qty_kg), 0);
  const inp = 'input py-0.5 text-xs';
  return (
    <>
      <tr className="bg-sky-50/70"><td colSpan={13} className="px-2 py-1.5 text-[11.5px] font-semibold text-sky-900">Job {g.io_no}{g.rows[0].buyer_po_no ? ` · PO ${g.rows[0].buyer_po_no}` : ''}</td></tr>
      {g.rows.map((r, i) => (
        <tr key={r.key} className="border-t border-slate-100">
          <td className="px-2 py-1 text-slate-400">{i + 1}</td><td className="px-2 py-1 font-semibold">{r.io_no}</td><td className="px-2 py-1">{r.yarn_name}</td><td className="px-2 py-1">{r.shade || '—'}</td>
          <td className="px-2 py-1 font-mono">{r.lot_no}</td><td className="px-2 py-1 font-mono text-slate-500">{r.grn_no}</td>
          <td className="px-1 py-1">{editable ? <input className={`${inp} w-20`} value={r.cone_no} onChange={(e) => set(r.key, { cone_no: e.target.value })} /> : (r.cone_no || '—')}</td>
          <td className="px-1 py-1 text-right">{editable ? <input type="number" className={`${inp} w-14 text-right`} value={r.no_of_cones} onChange={(e) => set(r.key, { no_of_cones: Number(e.target.value) })} /> : (r.no_of_cones || '—')}</td>
          {shade && <td className="px-1 py-1">{editable ? <input className={`${inp} w-24`} value={r.target_shade} onChange={(e) => set(r.key, { target_shade: e.target.value })} /> : (r.target_shade || '—')}</td>}
          <td className="px-1 py-1">{editable ? <select className={`${inp} w-28`} value={r.process_id} onChange={(e) => set(r.key, { process_id: e.target.value })}><option value="">—</option>{programs.map((p) => <option key={p.id} value={p.id}>{p.process_no}</option>)}</select> : (r.process_id ? programs.find((p) => String(p.id) === r.process_id)?.process_no ?? '✓' : '—')}</td>
          <td className="px-2 py-1 text-right tabular-nums text-slate-500">{editable ? kg(r.available_kg) : '—'}</td>
          <td className="px-1 py-1 text-right">{editable ? <input type="number" step="0.001" className={`${inp} w-24 text-right`} value={r.qty_kg} onChange={(e) => set(r.key, { qty_kg: Number(e.target.value) })} /> : <span className="tabular-nums">{kg(r.qty_kg)}</span>}</td>
          <td className="px-1 py-1 text-right">{editable && <button className="p-1 text-slate-400 hover:text-red-600" onClick={() => remove(r.key)}><Trash2 size={13} /></button>}</td>
        </tr>
      ))}
      <tr className="bg-slate-50 font-semibold"><td colSpan={shade ? 11 : 10} className="px-2 py-1 text-right text-slate-600">Job {g.io_no} subtotal · {g.rows.length} line(s)</td><td className="px-2 py-1 text-right tabular-nums">{kg(sub)}</td><td /></tr>
    </>
  );
}

/** Add Job (its lots + general stock, KG / cone per lot), Scan Cone / Lot, Import from Job (every lot the job holds). */
function LotPicker({ mode, jobs, taken, onClose, onAdd }: {
  mode: 'job' | 'scan' | 'import'; jobs: Job[]; taken: Row[]; onClose: () => void;
  onAdd: (lots: { lot: YarnLot; kg: number; cone_no?: string; cones?: number }[], job: Job | null) => void;
}) {
  const toast = useToast();
  const [jobId, setJobId] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Record<string, { kg: number; cone: string; cones: number }>>({});
  const K = (l: YarnLot) => `${l.grn_line_id}|${l.holder_so_id ?? 0}`;
  const job = jobs.find((j) => String(j.id) === jobId) ?? null;
  const lots = useQuery({
    queryKey: ['yarn-process', 'lots', jobId || 'general'],
    queryFn: async () => (await http.get<{ data: YarnLot[] }>(`/yarn-process/lots?so_id=${jobId || 0}`)).data ?? [],
    enabled: mode === 'scan' || !!jobId,
  });
  // KG already on the DC per lot
  // KG of the lot already on the DC (taken from the job's own part first)
  const used = (gl: number) => taken.filter((t) => t.grn_line_id === gl).reduce((a, t) => a + n(t.qty_kg), 0);
  const left = new Map<number, number>();
  const all = [...(lots.data ?? [])].sort((x, y) => Number(!!y.holder_so_id) - Number(!!x.holder_so_id)).map((l) => {
    const u = left.has(l.grn_line_id) ? left.get(l.grn_line_id)! : used(l.grn_line_id);
    const take = Math.min(u, l.available_kg);
    left.set(l.grn_line_id, u - take);
    return { ...l, available_kg: r3(l.available_kg - take) };
  }).filter((l) => l.available_kg > 0.0005);
  const forJob = mode === 'import' ? all.filter((l) => l.holder_so_id === job?.id) : all;
  const shown = forJob.filter((l) => !q || [l.lot_no, l.grn_no, l.yarn_name, l.cone_no, l.po_no, l.supplier_name].some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase())));

  if (mode === 'scan') {
    const scan = () => {
      const t = q.trim().toLowerCase();
      const l = all.find((x) => x.lot_no.toLowerCase() === t || String(x.cone_no ?? '').toLowerCase() === t);
      if (!l) { toast(`Lot / cone ${q} has no stock for ${job ? job.job_no : 'general stock'} (or is already on the DC)`, 'warning'); return; }
      onAdd([{ lot: l, kg: l.available_kg }], job);
    };
    return (
      <Modal open onClose={onClose} title="Scan cone / lot" size="md" footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={scan}>Add</Button></>}>
        <div className="grid gap-3">
          <Select label="Job" value={jobId} placeholder="— General stock —" onChange={(e) => setJobId(e.target.value)} options={jobs.map((j) => ({ value: j.id, label: j.job_no }))} />
          <Input label="Lot no / cone no / barcode" autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') scan(); }} />
        </div>
      </Modal>
    );
  }
  const picked = shown.filter((l) => sel[K(l)]);
  return (
    <Modal open onClose={onClose} size="xl" title={mode === 'import' ? 'Import every yarn lot of a job' : 'Add job — pick its yarn lots / cones'}
      footer={<>
        <span className="mr-auto self-center text-xs text-slate-600">{mode === 'import' ? `${forJob.length} lot(s), ${kg(forJob.reduce((a, l) => a + l.available_kg, 0))} KG` : `${picked.length} selected · ${kg(picked.reduce((a, l) => a + n(sel[K(l)].kg), 0))} KG`}</span>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!job || (mode === 'import' ? !forJob.length : !picked.length)}
          onClick={() => onAdd(mode === 'import' ? forJob.map((l) => ({ lot: l, kg: l.available_kg })) : picked.map((l) => ({ lot: l, kg: sel[K(l)].kg, cone_no: sel[K(l)].cone, cones: sel[K(l)].cones })), job)}>
          {mode === 'import' ? 'Import lots' : 'Add lots'}
        </Button>
      </>}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Select label="Job *" className="w-64" value={jobId} placeholder="— Job / IO —" onChange={(e) => { setJobId(e.target.value); setSel({}); }} options={jobs.map((j) => ({ value: j.id, label: `${j.job_no}${j.buyer_name ? ` · ${j.buyer_name}` : ''}` }))} />
        {mode === 'job' && <SearchInput value={q} onChange={setQ} placeholder="Lot, cone, GRN, yarn, PO, supplier…" className="w-72" />}
        {job && <span className="text-xs text-slate-500">{mode === 'job' ? `Lots held by ${job.job_no} + general stock` : `Lots held by ${job.job_no}`}</span>}
      </div>
      <div className="max-h-[50vh] overflow-auto rounded border border-slate-200">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr>{[mode === 'job' ? '' : null, 'Lot', 'Yarn', 'Shade', 'Held by', 'GRN', 'PO', 'Supplier', 'Store', 'Available KG', mode === 'job' ? 'Send KG' : null, mode === 'job' ? 'Cone no' : null, mode === 'job' ? 'Cones' : null].filter((x) => x !== null).map((h, i) => <th key={i} className={`px-2 py-1.5 ${/KG|Cones/.test(String(h)) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {!job && <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">Choose the job first</td></tr>}
            {job && lots.isLoading && <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">Loading…</td></tr>}
            {job && shown.map((l) => {
              const on = !!sel[K(l)];
              return (
                <tr key={K(l)} className={`border-t border-slate-100 ${on ? 'bg-emerald-50' : ''}`}>
                  {mode === 'job' && <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => setSel((s) => { const x = { ...s }; if (on) delete x[K(l)]; else x[K(l)] = { kg: l.available_kg, cone: l.cone_no ?? '', cones: l.cones ?? 0 }; return x; })} /></td>}
                  <td className="px-2 py-1 font-mono font-semibold">{l.lot_no}{l.processed ? <span className="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-800">processed</span> : null}</td>
                  <td className="px-2 py-1">{l.yarn_name}{l.count_str ? ` ${l.count_str}` : ''}</td><td className="px-2 py-1">{l.color_name || l.shade || '—'}</td>
                  <td className="px-2 py-1">{l.holder_job}</td><td className="px-2 py-1 font-mono">{l.grn_no}</td><td className="px-2 py-1">{l.po_no || '—'}</td><td className="px-2 py-1">{l.supplier_name || '—'}</td>
                  <td className="px-2 py-1">{l.warehouse_name || '—'}</td><td className="px-2 py-1 text-right tabular-nums">{kg(l.available_kg)}</td>
                  {mode === 'job' && <td className="px-2 py-1 text-right">{on ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={sel[K(l)].kg} onChange={(e) => setSel((s) => ({ ...s, [K(l)]: { ...s[K(l)], kg: r3(Number(e.target.value)) } }))} /> : '—'}</td>}
                  {mode === 'job' && <td className="px-2 py-1">{on ? <input className="input w-20 py-0.5 text-xs" value={sel[K(l)].cone} onChange={(e) => setSel((s) => ({ ...s, [K(l)]: { ...s[K(l)], cone: e.target.value } }))} /> : (l.cone_no || '—')}</td>}
                  {mode === 'job' && <td className="px-2 py-1 text-right">{on ? <input type="number" className="input w-14 py-0.5 text-right text-xs" value={sel[K(l)].cones} onChange={(e) => setSel((s) => ({ ...s, [K(l)]: { ...s[K(l)], cones: Number(e.target.value) } }))} /> : (l.cones || '—')}</td>}
                </tr>
              );
            })}
            {job && !lots.isLoading && !shown.length && <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">No yarn stock for this job</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
