import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, CheckCircle2, Printer, Trash2, Split, Save, Send, Pencil, XCircle, ClipboardCheck } from 'lucide-react';
import { http } from '../../../lib/api';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../lib/auth';
import { Button, Input, Select, Textarea, SearchInput, LoadingBlock } from '../../../components/ui';
import { fmtDate, today } from '../../../lib/format';
import { YpTitle, YpStatus, ReconCards, useReasons, errText, kg, n, r3, esc, printDoc, groupByJob, MODE_LABEL } from './shared';

/**
 * Yarn Process — Inward / GRN (doc §9–§11): output cones received against the outward DC, job-wise.
 *   Cone → cone (dyeing) / one → many (winding): each input lot / cone gives one or more output cones.
 *   Many → one (twisting): each output cone is made from `ply` input cones.
 * Good / reject / loss per output cone (input = good + reject + loss); Draft → QC → Posted.
 */
interface Inp { ypo_line_id: string; input_kg: number | ''; cone_no: string }
interface Out {
  key: string; inputs: Inp[]; output_cone_no: string; output_lot_no: string; shade: string; ply: number | ''; no_of_cones: number | ''; yarn_id: string;
  good_kg: number | ''; reject_kg: number | ''; loss_kg: number | ''; reject_reason: string;
}
let seq = 0;
const blank = (p: Partial<Out>): Out => ({ key: `o${++seq}`, inputs: [], output_cone_no: '', output_lot_no: '', shade: '', ply: '', no_of_cones: '', yarn_id: '', good_kg: '', reject_kg: '', loss_kg: '', reject_reason: '', ...p });

export default function YarnProcessInwardPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id'), ypo = params.get('ypo'), edit = params.get('edit');
  if (edit) return <InwardEditor editId={Number(edit)} ypoId={null} onBack={() => setParams({ id: edit })} onDone={(x) => setParams({ id: String(x) })} onPickDc={() => undefined} />;
  if (id) return <InwardView id={Number(id)} onBack={() => setParams({})} onEdit={() => setParams({ edit: id })} />;
  if (ypo !== null) return <InwardEditor ypoId={ypo ? Number(ypo) : null} onBack={() => setParams({})} onDone={(x) => setParams({ id: String(x) })} onPickDc={(x) => setParams({ ypo: String(x) })} />;
  return <InwardList onOpen={(x) => setParams({ id: String(x) })} onNew={() => setParams({ ypo: '' })} />;
}

function InwardList({ onOpen, onNew }: { onOpen: (id: number) => void; onNew: () => void }) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const list = useQuery({ queryKey: ['yarn-process', 'inward'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/inward')).data ?? [] });
  const rows = (list.data ?? []).filter((r) => (!st || (st === 'OPEN' ? !['POSTED', 'CANCELLED'].includes(r.status) : r.status === st)) &&
    (!q || [r.inward_no, r.ypo_no, r.vendor_name, r.jobs, r.challan_no].some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase()))));
  return (
    <div>
      <YpTitle no={2} title="Yarn Process Inward / GRN" sub="Output cones received job-wise against the DC · Draft → QC → Posted"
        actions={can('YARN_PROCESS.CREATE') ? <Button onClick={onNew}><Plus size={14} className="mr-1" /> New GRN</Button> : null} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-surface-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="GRN, DC, process unit, job, challan…" className="w-72" />
          <select className="input w-44 py-1 text-xs" value={st} onChange={(e) => setSt(e.target.value)}>
            <option value="">All statuses</option><option value="OPEN">Not posted (draft / QC)</option>
            {['DRAFT', 'QC_PENDING', 'ACCEPTED', 'PARTIAL', 'REJECTED', 'POSTED', 'CANCELLED'].map((x) => <option key={x} value={x}>{x.replace('_', ' ').toLowerCase()}</option>)}
          </select>
        </div>
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['GRN no', 'Date', 'Status', 'DC', 'Process', 'Process unit', 'Jobs', 'Output cones', 'Good KG', 'Reject KG', 'Loss KG', 'Challan', 'Billed'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|cones/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(r.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{r.inward_no}{r.is_reprocess ? <span className="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-800">Reprocess</span> : null}</td>
                  <td className="px-3 py-2">{fmtDate(r.inward_date)}</td><td className="px-3 py-2"><YpStatus value={r.status} /></td><td className="px-3 py-2 font-mono">{r.ypo_no}</td>
                  <td className="px-3 py-2">{r.process_name || r.process_code}</td><td className="px-3 py-2">{r.vendor_name}</td><td className="px-3 py-2">{r.jobs || '—'}</td>
                  <td className="px-3 py-2 text-right">{r.cone_count}</td><td className="px-3 py-2 text-right text-emerald-700">{kg(r.good_kg)}</td><td className="px-3 py-2 text-right text-red-700">{kg(r.reject_kg)}</td>
                  <td className="px-3 py-2 text-right text-amber-700">{kg(r.loss_kg)}</td><td className="px-3 py-2">{r.challan_no || '—'}</td>
                  <td className="px-3 py-2">{r.bill_id ? <YpStatus value="BILLED" /> : r.is_reprocess ? '—' : <span className="text-slate-400">No</span>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">No GRNs yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function InwardEditor({ editId, ypoId: ypoParam, onBack, onDone, onPickDc }: { editId?: number; ypoId: number | null; onBack: () => void; onDone: (id: number) => void; onPickDc: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { user, can } = useAuth() as any;
  const warehouses = useLookup('warehouses');
  const yarns = useLookup('yarns');
  const reasons = useReasons();
  const existing = useQuery({ queryKey: ['yarn-process', 'inward', editId], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/inward/${editId}`)).data, enabled: !!editId });
  const ypoId = editId ? (existing.data ? Number(existing.data.ypo_id) : null) : ypoParam;
  const open = useQuery({ queryKey: ['yarn-process', 'outward', 'open'], queryFn: async () => (await http.get<{ data: any[] }>('/yarn-process/outward?open=1')).data ?? [] });
  const dc = useQuery({ queryKey: ['yarn-process', 'outward', ypoId], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/outward/${ypoId}`)).data, enabled: !!ypoId });
  const d = dc.data;
  const mode: string = d?.process_mode ?? 'CONE_TO_CONE';
  const many = mode === 'MANY_TO_ONE';
  const [head, setHead] = useState({ inward_date: today(), challan_no: '', vehicle_no: '', received_by: '', warehouse_id: '', reject_warehouse_id: '', loss_override_reason: '', remarks: '' });
  const [outs, setOuts] = useState<Out[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (user && !head.received_by) setHead((h) => ({ ...h, received_by: user.full_name || user.username || '' })); }, [user]);
  useEffect(() => {
    const whs = warehouses.data ?? [];
    if (whs.length && !head.warehouse_id) setHead((h) => ({ ...h, warehouse_id: String((whs.find((w: any) => /yarn/i.test(w.label)) ?? whs.find((w: any) => /raw/i.test(w.label)) ?? whs.find((w: any) => !/finish|reject|fg/i.test(w.label)) ?? whs[0]).id), reject_warehouse_id: String((whs.find((w: any) => /reject/i.test(w.label)) ?? whs[0]).id) }));
  }, [warehouses.data]);
  useEffect(() => {
    if (!d) return;
    const dr = existing.data?.draft;
    if (editId && dr) {
      setHead({ inward_date: String(dr.inward_date ?? '').slice(0, 10), challan_no: dr.challan_no ?? '', vehicle_no: dr.vehicle_no ?? '', received_by: dr.received_by ?? '', warehouse_id: String(dr.warehouse_id ?? ''),
        reject_warehouse_id: dr.reject_warehouse_id ? String(dr.reject_warehouse_id) : '', loss_override_reason: dr.loss_override_reason ?? '', remarks: dr.remarks ?? '' });
      setOuts(dr.outputs.map((o: any) => blank({ inputs: o.inputs.map((i: any) => ({ ypo_line_id: String(i.ypo_line_id), input_kg: i.input_kg, cone_no: i.cone_no ?? '' })), output_cone_no: o.output_cone_no ?? '',
        output_lot_no: o.output_lot_no ?? '', shade: o.shade ?? '', ply: o.ply ?? '', no_of_cones: o.no_of_cones || '', yarn_id: o.yarn_id ? String(o.yarn_id) : '', good_kg: o.good_kg, reject_kg: o.reject_kg || '', loss_kg: o.loss_kg || '', reject_reason: o.reject_reason ?? '' })));
      return;
    }
    if (many) { setOuts([]); return; }
    setOuts((d.lines ?? []).filter((l: any) => n(l.balance_kg) > 0.0005).map((l: any) => blank({ inputs: [{ ypo_line_id: String(l.id), input_kg: '', cone_no: l.cone_no ?? '' }], shade: l.target_shade || l.shade || '' })));
  }, [d, existing.data]);

  const lineOf = (lid: string) => (d?.lines ?? []).find((l: any) => String(l.id) === lid);
  const outIn = (o: Out) => (many ? o.inputs.reduce((a, i) => a + n(i.input_kg), 0) : n(o.good_kg) + n(o.reject_kg) + n(o.loss_kg));
  const usedOf = (lid: string) => outs.reduce((a, o) => a + (many ? o.inputs.filter((i) => i.ypo_line_id === lid).reduce((x, i) => x + n(i.input_kg), 0) : (o.inputs[0]?.ypo_line_id === lid ? outIn(o) : 0)), 0);
  const used = outs.filter((o) => n(o.good_kg) + n(o.reject_kg) + n(o.loss_kg) > 0);
  const tot = { good: used.reduce((a, o) => a + n(o.good_kg), 0), rej: used.reduce((a, o) => a + n(o.reject_kg), 0), loss: used.reduce((a, o) => a + n(o.loss_kg), 0) };
  const lossPct = tot.good + tot.rej + tot.loss > 0 ? (tot.loss / (tot.good + tot.rej + tot.loss)) * 100 : 0;
  const tol = n(d?.loss_tolerance_pct);
  const set = (k: string, p: Partial<Out>) => setOuts((os) => os.map((o) => {
    if (o.key !== k) return o;
    const x = { ...o, ...p };
    // twisting: loss = inputs − good − reject
    if (many && ('good_kg' in p || 'reject_kg' in p || 'inputs' in p)) x.loss_kg = r3(Math.max(0, x.inputs.reduce((a, i) => a + n(i.input_kg), 0) - n(x.good_kg) - n(x.reject_kg)));
    return x;
  }));
  const split = (o: Out) => setOuts((os) => { const i = os.findIndex((x) => x.key === o.key); const c = [...os]; c.splice(i + 1, 0, blank({ inputs: [{ ...o.inputs[0], input_kg: '' }], shade: o.shade })); return c; });
  const addTwist = () => { const ply = Number(d?.default_ply) || 2; setOuts((os) => [...os, blank({ ply, inputs: Array.from({ length: ply }, () => ({ ypo_line_id: '', input_kg: '', cone_no: '' })) })]); };
  const fillGood = () => setOuts((os) => os.map((o) => {
    if (many || n(o.good_kg) + n(o.reject_kg) + n(o.loss_kg) > 0) return o;
    const l = lineOf(o.inputs[0].ypo_line_id); if (!l) return o;
    const others = os.filter((x) => x.key !== o.key && x.inputs[0]?.ypo_line_id === o.inputs[0].ypo_line_id).reduce((a, x) => a + outIn(x), 0);
    return { ...o, good_kg: r3(Math.max(0, n(l.balance_kg) - others)) };
  }));
  const groups = useMemo(() => groupByJob(outs.map((o) => ({ ...o, io_no: lineOf(o.inputs[0]?.ypo_line_id ?? '')?.io_no ?? (many ? 'Output cones' : 'STOCK') }))), [outs, d]);

  const save = async (action: 'POST' | 'DRAFT' | 'QC') => {
    if (!d) return;
    if (!used.length) { toast('Enter good / reject / loss KG for the output cones received', 'warning'); return; }
    if (!head.received_by.trim()) { toast('Received by is required', 'warning'); return; }
    for (const o of used) {
      if (many && o.inputs.some((i) => !i.ypo_line_id || n(i.input_kg) <= 0)) { toast(`Output ${o.output_cone_no || ''}: choose each input cone and its KG`, 'warning'); return; }
      if (n(o.reject_kg) > 0 && !o.reject_reason) { toast(`Output ${o.output_cone_no || ''}: choose the reject reason`, 'warning'); return; }
    }
    const over = (d.lines ?? []).find((l: any) => usedOf(String(l.id)) > n(l.balance_kg) + 0.0005);
    if (over) { toast(`Lot ${over.lot_no}${over.cone_no ? ` / ${over.cone_no}` : ''}: more than the open ${kg(over.balance_kg)} KG`, 'warning'); return; }
    if (tol > 0 && lossPct > tol && !head.loss_override_reason.trim()) { toast(`Loss ${lossPct.toFixed(2)}% is above the ${tol}% tolerance — give the reason`, 'warning'); return; }
    setBusy(true);
    try {
      const payload = {
        action, ypo_id: d.id, ...head, warehouse_id: Number(head.warehouse_id), reject_warehouse_id: head.reject_warehouse_id ? Number(head.reject_warehouse_id) : null, loss_override_reason: head.loss_override_reason || null,
        outputs: used.map((o) => ({
          inputs: many ? o.inputs.map((i) => ({ ypo_line_id: Number(i.ypo_line_id), input_kg: n(i.input_kg), cone_no: i.cone_no || null })) : [{ ypo_line_id: Number(o.inputs[0].ypo_line_id), input_kg: r3(outIn(o)), cone_no: o.inputs[0].cone_no || null }],
          output_cone_no: o.output_cone_no || null, output_lot_no: o.output_lot_no || null, shade: o.shade || null, ply: many ? Number(o.ply) || null : null, no_of_cones: n(o.no_of_cones),
          yarn_id: o.yarn_id ? Number(o.yarn_id) : null, good_kg: n(o.good_kg), reject_kg: n(o.reject_kg), loss_kg: n(o.loss_kg), reject_reason: o.reject_reason || null,
        })),
      };
      const r = editId ? await http.put<{ data: any; message: string }>(`/yarn-process/inward/${editId}`, payload) : await http.post<{ data: any; message: string }>('/yarn-process/inward', payload);
      toast((r as any).message, 'success'); void qc.invalidateQueries({ queryKey: ['yarn-process'] }); onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };

  const inp = 'input py-0.5 text-xs';
  const rejReasons = (reasons.data ?? []).filter((x) => x.kind !== 'BILLING');
  const dcLines = (d?.lines ?? []).filter((l: any) => n(l.balance_kg) > 0.0005);
  return (
    <div>
      <YpTitle no={2} title={editId ? `Edit GRN ${existing.data?.inward_no ?? ''}` : 'New Yarn Process GRN'} sub={d ? `${d.process_name} · ${MODE_LABEL[mode]}${Number(d.requires_qc) ? ' · QC required before posting' : ''}` : 'Load the outward DC'}
        actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Select label="Outward DC *" disabled={!!editId} value={ypoId ? String(ypoId) : ''} placeholder="— Load DC —" onChange={(e) => e.target.value && onPickDc(Number(e.target.value))}
          options={(open.data ?? []).map((o) => ({ value: o.id, label: `${o.ypo_no} · ${o.vendor_name} · ${o.process_name ?? o.process_code} · bal ${kg(o.balance_kg)} KG` }))} />
        <Input label="GRN date *" type="date" value={head.inward_date} onChange={(e) => setHead({ ...head, inward_date: e.target.value })} />
        <Input label="Process unit" value={d?.vendor_name ?? ''} disabled />
        <Input label="Unit challan no" value={head.challan_no} onChange={(e) => setHead({ ...head, challan_no: e.target.value })} />
        <Input label="Vehicle no" value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} />
        <Input label="Received by *" value={head.received_by} onChange={(e) => setHead({ ...head, received_by: e.target.value })} />
        <Select label="Store for good cones *" value={head.warehouse_id} onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })} options={toOptions(warehouses.data)} />
        <Select label="Reject store" value={head.reject_warehouse_id} onChange={(e) => setHead({ ...head, reject_warehouse_id: e.target.value })} options={toOptions(warehouses.data)} />
        <Textarea label="Remarks" className="col-span-2 md:col-span-4" rows={1} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </div>
      {!ypoId && <div className="card p-10 text-center text-sm text-slate-400">Choose the outward DC to load its lots / cones</div>}
      {ypoId && dc.isLoading && <LoadingBlock />}
      {d && (
        <>
          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-4 py-2.5">
              <h3 className="text-[13px] font-semibold text-slate-800">{many ? `Twisting — each output cone from ${d.default_ply ?? 'n'} input cones (ply)` : mode === 'ONE_TO_MANY' ? 'Winding — one input lot / cone → many output cones (use ⑂ to add cones)' : 'Input cone → output cone (split with ⑂)'}</h3>
              <div className="flex gap-2">
                {many ? <Button size="sm" onClick={addTwist}><Plus size={13} className="mr-1" /> Add output cone</Button> : <Button size="sm" variant="secondary" onClick={fillGood}>Fill open KG as good</Button>}
              </div>
            </div>
            <div className="max-h-[55vh] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500"><tr>
                  {[many ? 'Input cones (ply)' : 'Input lot / cone', many ? 'Input KG' : 'Open KG', 'Output cone', 'Output lot (blank = auto)', 'Shade', many ? 'Output yarn' : null, 'Cones', 'Good KG', 'Reject KG', 'Loss KG', 'Reject reason', ''].filter((x) => x !== null)
                    .map((h, i) => <th key={i} className={`px-2 py-2 ${/KG|Cones/.test(String(h)) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={g.io_no}>{!many && <tr className="bg-sky-50/70"><td colSpan={12} className="px-2 py-1.5 text-[11.5px] font-semibold text-sky-900">Job {g.io_no}</td></tr>}
                      {g.rows.map((o, idx) => {
                        const l = lineOf(o.inputs[0]?.ypo_line_id ?? '');
                        const first = many || idx === 0 || g.rows[idx - 1].inputs[0]?.ypo_line_id !== o.inputs[0]?.ypo_line_id;
                        const overL = !many && l && usedOf(String(l.id)) > n(l.balance_kg) + 0.0005;
                        return (
                          <tr key={o.key} className={`border-t border-slate-100 align-top ${overL ? 'bg-red-50' : ''}`}>
                            <td className="px-2 py-1">{many ? (
                              <div className="space-y-1">
                                <div className="flex items-center gap-1"><span className="text-slate-500">Ply</span>
                                  <input type="number" min={1} className={`${inp} w-12`} value={o.ply} onChange={(e) => { const p = Math.max(1, Number(e.target.value) || 1); set(o.key, { ply: p, inputs: Array.from({ length: p }, (_, k) => o.inputs[k] ?? { ypo_line_id: '', input_kg: '', cone_no: '' }) }); }} /></div>
                                {o.inputs.map((i, k) => (
                                  <div key={k} className="flex gap-1">
                                    <select className={`${inp} w-52`} value={i.ypo_line_id} onChange={(e) => set(o.key, { inputs: o.inputs.map((x, j) => (j === k ? { ...x, ypo_line_id: e.target.value } : x)) })}>
                                      <option value="">— input cone —</option>
                                      {dcLines.map((x: any) => <option key={x.id} value={x.id}>{x.io_no || 'STOCK'} · {x.lot_no}{x.cone_no ? `/${x.cone_no}` : ''} · open {kg(x.balance_kg)}</option>)}
                                    </select>
                                    <input className={`${inp} w-16`} placeholder="cone" value={i.cone_no} onChange={(e) => set(o.key, { inputs: o.inputs.map((x, j) => (j === k ? { ...x, cone_no: e.target.value } : x)) })} />
                                    <input type="number" step="0.001" className={`${inp} w-20 text-right`} placeholder="KG" value={i.input_kg} onChange={(e) => set(o.key, { inputs: o.inputs.map((x, j) => (j === k ? { ...x, input_kg: e.target.value === '' ? '' : Number(e.target.value) } : x)) })} />
                                  </div>
                                ))}
                              </div>
                            ) : (first ? <span className="font-mono">{l?.lot_no}{l?.cone_no ? ` / ${l.cone_no}` : ''}<span className="ml-1 font-sans text-slate-400">{l?.yarn_name}</span></span> : <span className="text-slate-400">↳ more cones</span>)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">{many ? kg(outIn(o)) : first ? kg(l?.balance_kg) : ''}</td>
                            <td className="px-1 py-1"><input className={`${inp} w-24`} value={o.output_cone_no} onChange={(e) => set(o.key, { output_cone_no: e.target.value })} /></td>
                            <td className="px-1 py-1"><input className={`${inp} w-28`} value={o.output_lot_no} onChange={(e) => set(o.key, { output_lot_no: e.target.value })} /></td>
                            <td className="px-1 py-1"><input className={`${inp} w-20`} value={o.shade} onChange={(e) => set(o.key, { shade: e.target.value })} /></td>
                            {many && <td className="px-1 py-1"><select className={`${inp} w-36`} value={o.yarn_id} onChange={(e) => set(o.key, { yarn_id: e.target.value })}><option value="">Same as input</option>{(yarns.data ?? []).map((y: any) => <option key={y.id} value={y.id}>{y.label}</option>)}</select></td>}
                            <td className="px-1 py-1"><input type="number" className={`${inp} w-14 text-right`} value={o.no_of_cones} onChange={(e) => set(o.key, { no_of_cones: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                            {(['good_kg', 'reject_kg', 'loss_kg'] as const).map((k) => (
                              <td key={k} className="px-1 py-1"><input type="number" step="0.001" disabled={many && k === 'loss_kg'} className={`${inp} w-[84px] text-right ${k === 'good_kg' ? 'text-emerald-700' : k === 'reject_kg' ? 'text-red-700' : 'text-amber-700'}`} value={o[k]}
                                onChange={(e) => set(o.key, { [k]: e.target.value === '' ? '' : Number(e.target.value) } as Partial<Out>)} /></td>
                            ))}
                            <td className="px-1 py-1"><select className={`${inp} w-36 ${n(o.reject_kg) > 0 && !o.reject_reason ? 'border-red-400' : ''}`} value={o.reject_reason} onChange={(e) => set(o.key, { reject_reason: e.target.value })}>
                              <option value="">{n(o.reject_kg) > 0 ? '— reason * —' : '—'}</option>{rejReasons.map((r) => <option key={r.id} value={r.reason}>{r.reason}</option>)}</select></td>
                            <td className="whitespace-nowrap px-1 py-1">
                              {!many && <button title="Add another output cone from this input" className="p-1 text-slate-400 hover:text-sky-700" onClick={() => split(o)}><Split size={13} /></button>}
                              {(many || !first) && <button className="p-1 text-slate-400 hover:text-red-600" onClick={() => setOuts((os) => os.filter((x) => x.key !== o.key))}><Trash2 size={13} /></button>}
                            </td>
                          </tr>
                        );
                      })}</Fragment>
                  ))}
                  {!outs.length && <tr><td colSpan={12} className="px-3 py-8 text-center text-slate-400">{many ? 'Click “Add output cone” and pick its input cones' : 'Every lot of this DC is already received'}</td></tr>}
                </tbody>
                <tfoot className="sticky bottom-0 bg-slate-100 font-bold"><tr><td colSpan={many ? 7 : 6} className="px-2 py-2 text-right">This GRN</td><td className="px-2 py-2 text-right text-emerald-800">{kg(tot.good)}</td><td className="px-2 py-2 text-right text-red-700">{kg(tot.rej)}</td><td className="px-2 py-2 text-right text-amber-700">{kg(tot.loss)}</td><td colSpan={2} className="px-2 py-2 text-left text-[11px] font-normal">{tot.good + tot.rej + tot.loss > 0 ? `loss ${lossPct.toFixed(2)}%${tol ? ` (tolerance ${tol}%)` : ''}` : ''}</td></tr></tfoot>
              </table>
            </div>
          </div>
          {tol > 0 && lossPct > tol && (
            <div className="card mt-3 flex flex-wrap items-end gap-3 border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              <span>Process loss {lossPct.toFixed(2)}% is above the {tol}% tolerance for {d.process_name}.</span>
              <Input label="Reason to accept the loss *" className="w-96" value={head.loss_override_reason} onChange={(e) => setHead({ ...head, loss_override_reason: e.target.value })} />
            </div>
          )}
          <div className="card mt-3 p-4"><h3 className="mb-2 text-[13px] font-semibold text-slate-800">DC {d.ypo_no} reconciliation (posted GRNs)</h3><ReconCards t={d.reconciliation.total} /></div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" onClick={onBack}>Cancel</Button>
            <Button variant="secondary" loading={busy} onClick={() => save('DRAFT')}><Save size={14} className="mr-1" /> Save Draft</Button>
            <Button variant="secondary" loading={busy} onClick={() => save('QC')}><Send size={14} className="mr-1" /> Send for QC</Button>
            {!Number(d.requires_qc) && can('YARN_PROCESS.CONFIRM') && !editId && <Button loading={busy} onClick={() => save('POST')}><CheckCircle2 size={14} className="mr-1" /> Confirm GRN</Button>}
          </div>
        </>
      )}
    </div>
  );
}

function InwardView({ id, onBack, onEdit }: { id: number; onBack: () => void; onEdit: () => void }) {
  const q = useQuery({ queryKey: ['yarn-process', 'inward', id], queryFn: async () => (await http.get<{ data: any }>(`/yarn-process/inward/${id}`)).data });
  const g = q.data;
  if (!g) return <LoadingBlock />;
  if (g.status !== 'POSTED') return <DraftView g={g} onBack={onBack} onEdit={onEdit} />;
  const print = () => {
    const body = groupByJob(g.outputs as any[]).map((j) => `<tr class="grp"><td colspan="8">Job ${esc(j.io_no)}</td></tr>` + j.rows.map((o: any) =>
      `<tr><td>${esc(o.inputs ?? '')}</td><td>${esc(o.output_cone_no ?? '')}</td><td>${esc(o.output_lot_no)}</td><td>${esc(o.shade ?? '')}</td><td class="r">${kg(o.input_kg)}</td><td class="r">${kg(o.good_kg)}</td><td class="r">${kg(o.reject_kg)}</td><td class="r">${kg(o.loss_kg)}</td></tr>`).join('')).join('');
    printDoc(g.inward_no, `<h1>YARN PROCESS GRN — ${esc(g.process_name ?? g.process_code)}</h1><table class="meta"><tr><td><b>GRN:</b> ${esc(g.inward_no)}</td><td><b>Date:</b> ${esc(fmtDate(g.inward_date))}</td><td><b>DC:</b> ${esc(g.ypo_no)}</td></tr>
      <tr><td><b>Process unit:</b> ${esc(g.vendor_name)}</td><td><b>Challan:</b> ${esc(g.challan_no ?? '—')}</td><td><b>Received by:</b> ${esc(g.received_by ?? '')}</td></tr></table>`,
      `<table><thead><tr><th>Input cone(s)</th><th>Output cone</th><th>Output lot</th><th>Shade</th><th class="r">Input</th><th class="r">Good</th><th class="r">Reject</th><th class="r">Loss</th></tr></thead><tbody>${body}
       <tr class="sub"><td colspan="5">Total</td><td class="r">${kg(g.good_kg)}</td><td class="r">${kg(g.reject_kg)}</td><td class="r">${kg(g.loss_kg)}</td></tr></tbody></table>`);
  };
  return (
    <div>
      <YpTitle no={2} title={`Yarn Process GRN — ${g.inward_no}`} sub={`${g.process_name ?? g.process_code} · ${MODE_LABEL[g.process_mode] ?? ''} · DC ${g.ypo_no} · ${g.vendor_name}`}
        actions={<><YpStatus value={g.bill_id ? 'BILLED' : 'POSTED'} /><Button variant="secondary" onClick={print}><Printer size={14} className="mr-1" /> Print GRN</Button><Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 text-xs md:grid-cols-6">
        {[['GRN date', fmtDate(g.inward_date)], ['Challan', g.challan_no || '—'], ['Vehicle', g.vehicle_no || '—'], ['Received by', g.received_by || '—'], ['Store', g.warehouse_name], ['Reject store', g.reject_store || '—']].map(([k, v]) => (
          <div key={k}><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div><div className="font-semibold">{v}</div></div>))}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'Input cone(s) (KG)', 'Output cone', 'Output lot', 'Yarn', 'Shade', 'Ply', 'Cones', 'Input KG', 'Good KG', 'Reject KG', 'Loss KG', 'Reject reason'].map((h) => <th key={h} className={`px-2 py-2 ${/KG|Cones|Ply/.test(h) && !/cone\(s\)/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{g.outputs.map((o: any) => (
            <tr key={o.id} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{o.io_no || 'STOCK'}</td><td className="px-2 py-1 font-mono">{o.inputs}</td><td className="px-2 py-1 font-mono">{o.output_cone_no || '—'}</td>
              <td className="px-2 py-1 font-mono">{o.output_lot_no}</td><td className="px-2 py-1">{o.yarn_name}</td><td className="px-2 py-1">{o.shade || '—'}</td><td className="px-2 py-1 text-right">{o.ply || '—'}</td><td className="px-2 py-1 text-right">{o.no_of_cones || '—'}</td>
              <td className="px-2 py-1 text-right">{kg(o.input_kg)}</td><td className="px-2 py-1 text-right text-emerald-700">{kg(o.good_kg)}</td><td className="px-2 py-1 text-right text-red-700">{kg(o.reject_kg)}</td>
              <td className="px-2 py-1 text-right text-amber-700">{kg(o.loss_kg)}</td><td className="px-2 py-1">{o.reject_reason || '—'}</td></tr>
          ))}</tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={8} className="px-2 py-2 text-right">Total</td><td className="px-2 py-2 text-right">{kg(g.input_kg)}</td><td className="px-2 py-2 text-right">{kg(g.good_kg)}</td><td className="px-2 py-2 text-right">{kg(g.reject_kg)}</td><td className="px-2 py-2 text-right">{kg(g.loss_kg)}</td><td /></tr></tfoot>
        </table>
      </div>
      <div className="card mt-3 p-4"><h3 className="mb-2 text-[13px] font-semibold text-slate-800">DC {g.ypo_no} reconciliation</h3><ReconCards t={g.reconciliation.total} /></div>
    </div>
  );
}

const QC_STATES = ['QC_PENDING', 'ACCEPTED', 'PARTIAL', 'REJECTED'];
function DraftView({ g, onBack, onEdit }: { g: any; onBack: () => void; onEdit: () => void }) {
  const toast = useToast();
  const qcl = useQueryClient();
  const { can } = useAuth();
  const [busy, setBusy] = useState('');
  const outs: any[] = g.draft?.outputs ?? [];
  const params: any[] = g.qc_params ?? [];
  const goodIdx = outs.filter((o) => n(o.good_kg) > 0).map((o) => o.line_index as number);
  const [vals, setVals] = useState<Record<number, Record<string, string>>>(() => Object.fromEntries(outs.map((o) => [o.line_index, Object.fromEntries(Object.entries(o.qc?.values ?? {}).map(([k, v]) => [k, v === null ? '' : String(v)]))])));
  const [stat, setStat] = useState<Record<number, string>>(() => Object.fromEntries(outs.map((o) => [o.line_index, o.qc?.status ?? ''])));
  const [qcRemarks, setQcRemarks] = useState(g.qc_remarks ?? '');
  const result = (p: any, raw?: string) => (raw === undefined || raw === '' ? 'NA' : ((p.min_value !== null && Number(raw) < Number(p.min_value)) || (p.max_value !== null && Number(raw) > Number(p.max_value)) ? 'FAIL' : 'PASS'));
  const fails = (k: number) => params.filter((p) => result(p, vals[k]?.[String(p.id)]) === 'FAIL').length;
  const editable = ['DRAFT', ...QC_STATES].includes(g.status);
  const qcOpen = QC_STATES.includes(g.status) && can('YARN_PROCESS.QC');
  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    try { const r = await fn(); toast(r?.message ?? 'Done', 'success'); void qcl.invalidateQueries({ queryKey: ['yarn-process'] }); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(''); }
  };
  const canPost = can('YARN_PROCESS.CONFIRM') && g.status !== 'QC_PENDING' && g.status !== 'CANCELLED' && !(g.requires_qc && g.status === 'DRAFT');
  const inp = 'input py-0.5 text-xs';
  return (
    <div>
      <YpTitle no={2} title={`Yarn Process GRN — ${g.inward_no}`} sub={`${g.process_name ?? g.process_code} · DC ${g.ypo_no} · ${g.vendor_name}${g.requires_qc ? ' · QC required' : ''}`}
        actions={<>
          <YpStatus value={g.status} />
          {editable && can('YARN_PROCESS.EDIT_DRAFT') && <Button variant="secondary" onClick={onEdit}><Pencil size={14} className="mr-1" /> Edit</Button>}
          {g.status === 'DRAFT' && can('YARN_PROCESS.CREATE') && <Button variant="secondary" loading={busy === 'send'} onClick={() => act('send', () => http.post(`/yarn-process/inward/${g.id}/submit-qc`, {}))}><Send size={14} className="mr-1" /> Send for QC</Button>}
          {editable && can('YARN_PROCESS.EDIT_DRAFT') && <Button variant="secondary" loading={busy === 'cancel'} onClick={() => { if (window.confirm(`Cancel ${g.inward_no}?`)) void act('cancel', () => http.post(`/yarn-process/inward/${g.id}/cancel`, {})); }}><XCircle size={14} className="mr-1" /> Cancel GRN</Button>}
          {editable && canPost && <Button loading={busy === 'post'} onClick={() => act('post', () => http.post(`/yarn-process/inward/${g.id}/post`, {}))}><CheckCircle2 size={14} className="mr-1" /> Post GRN</Button>}
          <Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>
        </>} />
      {g.status === 'QC_PENDING' && <div className="mb-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2 text-xs text-orange-900">Waiting for QC — no stock has moved. Record the QC result per output cone, then post.</div>}
      {g.status === 'DRAFT' && <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-700">Draft — no stock has moved.{g.requires_qc ? ' This process requires QC: send it for QC before posting.' : ''}</div>}
      <div className="card overflow-x-auto">
        <div className="flex items-center gap-2 px-4 pt-3 text-[13px] font-semibold text-slate-800"><ClipboardCheck size={15} /> Output cones{params.length ? ' & QC' : ''}</div>
        <table className="mt-2 w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>
            {['Job', 'Input cone(s)', 'Output cone', 'Lot', 'Shade', 'Good KG', 'Reject KG', 'Loss KG'].map((h) => <th key={h} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
            {params.map((p) => <th key={p.id} className="px-2 py-2 text-left">{p.param_name}{p.uom ? ` (${p.uom})` : ''}{p.is_mandatory ? ' *' : ''}<div className="font-normal normal-case text-slate-400">{p.min_value ?? '…'} – {p.max_value ?? '…'}</div></th>)}
            <th className="px-2 py-2 text-left">QC status</th>
          </tr></thead>
          <tbody>
            {outs.map((o) => {
              const k = o.line_index as number; const good = n(o.good_kg) > 0; const f = fails(k);
              return (
                <tr key={k} className={`border-t border-slate-100 ${f ? 'bg-red-50/60' : ''}`}>
                  <td className="px-2 py-1 font-semibold">{o.io_no || 'STOCK'}</td><td className="px-2 py-1 font-mono">{o.input_text}</td><td className="px-2 py-1 font-mono">{o.output_cone_no || '—'}</td>
                  <td className="px-2 py-1 font-mono">{o.output_lot_no || <span className="text-slate-400">auto</span>}</td><td className="px-2 py-1">{o.shade || '—'}</td>
                  <td className="px-2 py-1 text-right text-emerald-700">{kg(o.good_kg)}</td><td className="px-2 py-1 text-right text-red-700">{kg(o.reject_kg)}</td><td className="px-2 py-1 text-right text-amber-700">{kg(o.loss_kg)}</td>
                  {params.map((p) => {
                    const raw = vals[k]?.[String(p.id)]; const rs = result(p, raw);
                    return <td key={p.id} className="px-1 py-1">{good ? (qcOpen
                      ? <input type="number" step="0.001" className={`${inp} w-20 text-right ${rs === 'FAIL' ? 'border-red-400 text-red-700' : rs === 'PASS' ? 'text-emerald-700' : ''}`} value={raw ?? ''} onChange={(e) => setVals((v) => ({ ...v, [k]: { ...(v[k] ?? {}), [String(p.id)]: e.target.value } }))} />
                      : <span className={rs === 'FAIL' ? 'font-semibold text-red-700' : ''}>{raw || '—'}{rs !== 'NA' ? ` · ${rs}` : ''}</span>) : <span className="text-slate-300">—</span>}</td>;
                  })}
                  <td className="px-1 py-1">{good ? (qcOpen
                    ? <select className={`${inp} w-28`} value={stat[k] ?? ''} onChange={(e) => setStat((x) => ({ ...x, [k]: e.target.value }))}><option value="">{f ? 'Auto: Rejected' : 'Auto: Accepted'}</option><option value="ACCEPTED">Accepted</option><option value="REJECTED">Rejected</option></select>
                    : (o.qc ? <YpStatus value={o.qc.status} /> : <span className="text-slate-400">—</span>)) : <span className="text-slate-300">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {qcOpen && (
          <div className="flex flex-wrap items-end justify-end gap-2 border-t border-surface-border p-3">
            {!params.length && <span className="mr-auto text-[11.5px] text-slate-500">No QC parameters for this process — set them on Yarn Process Types; you can still accept / reject each cone.</span>}
            <Input label="QC remarks" className="w-72" value={qcRemarks} onChange={(e) => setQcRemarks(e.target.value)} />
            <Button loading={busy === 'qc'} onClick={() => act('qc', () => http.post(`/yarn-process/inward/${g.id}/qc`, { remarks: qcRemarks || null,
              results: goodIdx.map((k) => ({ line_index: k, qc_status: stat[k] || undefined, values: Object.fromEntries(params.map((p) => [String(p.id), vals[k]?.[String(p.id)] === undefined || vals[k]?.[String(p.id)] === '' ? null : Number(vals[k][String(p.id)])])) })) }))}>
              <ClipboardCheck size={14} className="mr-1" /> Save QC result</Button>
          </div>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-slate-500">On posting, QC-rejected cones go to the reject store (eligible for reprocess) with the failed parameters as the reason.</p>
      <div className="card mt-3 p-4"><h3 className="mb-2 text-[13px] font-semibold text-slate-800">DC {g.ypo_no} reconciliation (posted GRNs)</h3><ReconCards t={g.reconciliation.total} /></div>
    </div>
  );
}
