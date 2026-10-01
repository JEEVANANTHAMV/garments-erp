import { useEffect, useMemo, useState } from 'react';
import { GateEntryPicker } from '../../../components/ProcessPickers';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, CheckCircle2, Printer, Trash2, Split, Save, Send, Pencil, XCircle, ClipboardCheck } from 'lucide-react';
import { http } from '../../../lib/api';
import { useLookup, toOptions } from '../../../hooks/useLookup';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../lib/auth';
import { Button, Input, Select, Textarea, SearchInput, LoadingBlock, Tabs } from '../../../components/ui';
import { fmtDate, today } from '../../../lib/format';
import { FpTitle, FpStatus, ReconCards, useReasons, useProcessTypes, errText, kg, n, r3, esc, printDoc, groupByJob } from './shared';

/**
 * Fabric Process — Inward / GRN (doc §6): load the outward DC, then per input roll one or more
 * output rolls with Good / Reject / Loss KG (job-wise; partial receipt allowed). Good goes to the
 * processed store, reject to the reject store; the reconciliation shows Outward = Good + Reject + Loss + Balance.
 * Status flow (doc §16): Draft → QC Pending → Accepted / Partial / Rejected → Posted; stock moves only on Post.
 * A process type marked "requires QC" cannot be posted without QC.
 */
interface Line {
  key: string; roll_in_id: number; io_no: string; buyer_po_no: string | null; style_code: string | null; input_roll: string; input_kg: number; open_kg: number;
  output_roll_no: string; color_name: string; good_kg: number | ''; reject_kg: number | ''; loss_kg: number | ''; meters: number | ''; gsm: string; dia: string; shade_no: string; reject_reason: string;
}
let seq = 0;

export default function FabricProcessInwardPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  const fpo = params.get('fpo');
  const edit = params.get('edit');
  if (edit) return <InwardEditor editId={Number(edit)} fpoId={null} onBack={() => setParams({ id: edit })} onDone={(x) => setParams({ id: String(x) })} onPickDc={() => undefined} />;
  if (id) return <InwardView id={Number(id)} onBack={() => setParams({})} onEdit={() => setParams({ edit: id })} />;
  if (fpo !== null) return <InwardEditor fpoId={fpo ? Number(fpo) : null} onBack={() => setParams({})} onDone={(x) => setParams({ id: String(x) })} onPickDc={(x) => setParams({ fpo: String(x) })} />;
  return <InwardList onOpen={(x) => setParams({ id: String(x) })} onNew={() => setParams({ fpo: '' })} />;
}

function InwardList({ onOpen, onNew }: { onOpen: (id: number) => void; onNew: () => void }) {
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['fabric-process', 'inward'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/inward')).data ?? [] });
  const rows = (list.data ?? []).filter((r) => (!st || (st === 'OPEN' ? !['POSTED', 'CANCELLED'].includes(r.status) : r.status === st)) && (!q || [r.inward_no, r.fpo_no, r.vendor_name, r.jobs, r.challan_no].some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase()))));
  return (
    <div>
      <FpTitle no={2} title="Process Inward / GRN" sub="Receive processed fabric job-wise against the outward DC · Draft → QC → Posted"
        actions={can('FABRIC_PROCESS.CREATE') ? <Button onClick={onNew}><Plus size={14} className="mr-1" /> New GRN</Button> : null} />
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-surface-border p-3">
          <SearchInput value={q} onChange={setQ} placeholder="GRN, DC, supplier / vendor, job, challan…" className="w-72" />
          <select className="input w-44 py-1 text-xs" value={st} onChange={(e) => setSt(e.target.value)}>
            <option value="">All statuses</option><option value="OPEN">Not posted (draft / QC)</option>
            {['DRAFT', 'QC_PENDING', 'ACCEPTED', 'PARTIAL', 'REJECTED', 'POSTED', 'CANCELLED'].map((x) => <option key={x} value={x}>{x.replace('_', ' ').toLowerCase()}</option>)}
          </select>
        </div>
        {list.isLoading ? <LoadingBlock /> : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr>{['GRN no', 'Date', 'Status', 'Outward DC', 'Process', 'Supplier / Vendor', 'Jobs', 'Rolls', 'Good KG', 'Reject KG', 'Loss KG', 'Challan', 'Billed'].map((h) => <th key={h} className={`px-3 py-2 ${/KG|Rolls/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(r.id)}>
                  <td className="px-3 py-2 font-mono font-semibold text-brand-700">{r.inward_no}{r.is_reprocess ? <span className="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-800">Reprocess</span> : null}</td>
                  <td className="px-3 py-2">{fmtDate(r.inward_date)}</td><td className="px-3 py-2"><FpStatus value={r.status} /></td><td className="px-3 py-2 font-mono">{r.fpo_no}</td><td className="px-3 py-2">{r.process_name || r.sub_process}</td>
                  <td className="px-3 py-2">{r.vendor_name}</td><td className="px-3 py-2">{r.jobs || '—'}</td><td className="px-3 py-2 text-right">{r.roll_count}</td>
                  <td className="px-3 py-2 text-right text-emerald-700">{kg(r.good_kg)}</td><td className="px-3 py-2 text-right text-red-700">{kg(r.reject_kg)}</td><td className="px-3 py-2 text-right text-amber-700">{kg(r.loss_kg)}</td>
                  <td className="px-3 py-2">{r.challan_no || '—'}</td><td className="px-3 py-2">{r.bill_id ? <FpStatus value="BILLED" /> : r.is_reprocess ? '—' : <span className="text-slate-400">No</span>}</td>
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

function InwardEditor({ editId, fpoId: fpoParam, onBack, onDone, onPickDc }: { editId?: number; fpoId: number | null; onBack: () => void; onDone: (id: number) => void; onPickDc: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { user, can } = useAuth() as any;
  const types = useProcessTypes();
  const existing = useQuery({ queryKey: ['fabric-process', 'inward', editId], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/inward/${editId}`)).data, enabled: !!editId });
  const fpoId = editId ? (existing.data ? Number(existing.data.fpo_id) : null) : fpoParam;
  const warehouses = useLookup('warehouses');
  const reasons = useReasons();
  const open = useQuery({ queryKey: ['fabric-process', 'outward', 'open'], queryFn: async () => (await http.get<{ data: any[] }>('/fabric-process/outward?open=1')).data ?? [] });
  const dc = useQuery({ queryKey: ['fabric-process', 'outward', fpoId], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/outward/${fpoId}`)).data, enabled: !!fpoId });
  const d = dc.data;
  const [head, setHead] = useState({ inward_date: today(), challan_no: '', vehicle_no: '', received_by: '', warehouse_id: '', reject_warehouse_id: '', remarks: '', gate_inward_id: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [tab, setTab] = useState('entry');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (user && !head.received_by) setHead((h) => ({ ...h, received_by: user.full_name || user.username || '' })); }, [user]);
  useEffect(() => {
    const whs = warehouses.data ?? [];
    if (whs.length && !head.warehouse_id) setHead((h) => ({ ...h, warehouse_id: String((whs.find((w: any) => /raw|fabric/i.test(w.label)) ?? whs[0]).id), reject_warehouse_id: String((whs.find((w: any) => /reject/i.test(w.label)) ?? whs[0]).id) }));
  }, [warehouses.data]);
  // editing a draft: header + lines from the draft
  useEffect(() => {
    const x = existing.data;
    if (!x?.draft) return;
    const dr = x.draft;
    setHead({ inward_date: String(dr.inward_date ?? '').slice(0, 10), challan_no: dr.challan_no ?? '', vehicle_no: dr.vehicle_no ?? '', received_by: dr.received_by ?? '',
      warehouse_id: String(dr.warehouse_id ?? ''), reject_warehouse_id: dr.reject_warehouse_id ? String(dr.reject_warehouse_id) : '', remarks: dr.remarks ?? '', gate_inward_id: dr.gate_inward_id ? String(dr.gate_inward_id) : '' });
  }, [existing.data]);
  useEffect(() => {
    if (!d) return;
    if (editId) {
      const dl: any[] = existing.data?.draft?.lines ?? [];
      setLines(dl.map((l) => {
        const r = (d.rolls ?? []).find((x: any) => Number(x.id) === Number(l.roll_in_id));
        return { key: `l${++seq}`, roll_in_id: l.roll_in_id, io_no: r?.io_no || 'STOCK', buyer_po_no: r?.buyer_po_no ?? null, style_code: r?.style_code ?? null, input_roll: r?.roll_no ?? l.input_roll_no, input_kg: n(r?.weight_kg), open_kg: n(r?.balance_kg),
          output_roll_no: l.output_roll_no ?? '', color_name: l.color_name ?? '', good_kg: l.good_kg ?? '', reject_kg: l.reject_kg || '', loss_kg: l.loss_kg || '', meters: l.meters || '', gsm: l.gsm ?? '', dia: l.dia ?? '', shade_no: l.shade_no ?? '', reject_reason: l.reject_reason ?? '' };
      }));
      return;
    }
    setLines((d.rolls ?? []).filter((r: any) => n(r.balance_kg) > 0.0005).map((r: any) => ({
      key: `l${++seq}`, roll_in_id: r.id, io_no: r.io_no || 'STOCK', buyer_po_no: r.buyer_po_no, style_code: r.style_code, input_roll: r.roll_no, input_kg: n(r.weight_kg), open_kg: n(r.balance_kg),
      output_roll_no: '', color_name: r.color_name || d.color_name || '', good_kg: '', reject_kg: '', loss_kg: '', meters: '', gsm: r.gsm ?? d.target_gsm ?? '', dia: r.dia ?? d.target_dia ?? '', shade_no: d.shade_code ?? '', reject_reason: '',
    })));
  }, [d, existing.data]);
  const requiresQc = !!Number((types.data ?? []).find((t) => t.code === d?.sub_process)?.requires_qc);

  const set = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const split = (l: Line) => setLines((ls) => { const i = ls.findIndex((x) => x.key === l.key); const c = [...ls]; c.splice(i + 1, 0, { ...l, key: `l${++seq}`, output_roll_no: '', good_kg: '', reject_kg: '', loss_kg: '', meters: '' }); return c; });
  const accounted = (rid: number) => lines.filter((l) => l.roll_in_id === rid).reduce((a, l) => a + n(l.good_kg) + n(l.reject_kg) + n(l.loss_kg), 0);
  const used = lines.filter((l) => n(l.good_kg) + n(l.reject_kg) + n(l.loss_kg) > 0);
  const tot = { good: used.reduce((a, l) => a + n(l.good_kg), 0), rej: used.reduce((a, l) => a + n(l.reject_kg), 0), loss: used.reduce((a, l) => a + n(l.loss_kg), 0) };
  const recon = useMemo(() => {
    if (!d) return null;
    const t = d.reconciliation.total;
    const good = t.good_kg + tot.good, rej = t.reject_kg + tot.rej, loss = t.loss_kg + tot.loss;
    return { outward_kg: t.outward_kg, good_kg: r3(good), reject_kg: r3(rej), loss_kg: r3(loss), balance_kg: r3(Math.max(0, t.outward_kg - good - rej - loss)) };
  }, [d, tot.good, tot.rej, tot.loss]);
  const jobSummary = useMemo(() => groupByJob(lines).map((g) => {
    const rolls = [...new Set(g.rows.map((r) => r.roll_in_id))];
    const input = rolls.reduce((a, rid) => a + (g.rows.find((r) => r.roll_in_id === rid)?.open_kg ?? 0), 0);
    const good = g.rows.reduce((a, r) => a + n(r.good_kg), 0), rej = g.rows.reduce((a, r) => a + n(r.reject_kg), 0), loss = g.rows.reduce((a, r) => a + n(r.loss_kg), 0);
    return { io_no: g.io_no, rolls: rolls.length, open: input, good, rej, loss, bal: Math.max(0, input - good - rej - loss) };
  }), [lines]);

  const fillGood = () => setLines((ls) => ls.map((l) => {
    const others = ls.filter((x) => x.roll_in_id === l.roll_in_id && x.key !== l.key).reduce((a, x) => a + n(x.good_kg) + n(x.reject_kg) + n(x.loss_kg), 0);
    return n(l.good_kg) + n(l.reject_kg) + n(l.loss_kg) > 0 ? l : { ...l, good_kg: r3(Math.max(0, l.open_kg - others)) };
  }));
  const save = async (action: 'POST' | 'DRAFT' | 'QC') => {
    if (!d) return;
    if (!used.length) { toast('Enter good / reject / loss KG for the rolls received', 'warning'); return; }
    if (!head.received_by.trim()) { toast('Received by is required', 'warning'); return; }
    const over = [...new Set(used.map((l) => l.roll_in_id))].find((rid) => accounted(rid) > (lines.find((l) => l.roll_in_id === rid)?.open_kg ?? 0) + 0.0005);
    if (over) { const l = lines.find((x) => x.roll_in_id === over)!; toast(`Roll ${l.input_roll}: good + reject + loss is more than the open ${kg(l.open_kg)} KG`, 'warning'); return; }
    const noReason = used.find((l) => n(l.reject_kg) > 0 && !l.reject_reason);
    if (noReason) { toast(`Roll ${noReason.input_roll}: choose the reject reason`, 'warning'); return; }
    setBusy(true);
    try {
      const payload = {
        action, fpo_id: d.id, ...head, gate_inward_id: head.gate_inward_id ? Number(head.gate_inward_id) : null, warehouse_id: Number(head.warehouse_id), reject_warehouse_id: head.reject_warehouse_id ? Number(head.reject_warehouse_id) : null,
        lines: used.map((l) => ({ roll_in_id: l.roll_in_id, output_roll_no: l.output_roll_no || null, good_kg: n(l.good_kg), reject_kg: n(l.reject_kg), loss_kg: n(l.loss_kg), meters: n(l.meters),
          gsm: l.gsm || null, dia: l.dia || null, color_name: l.color_name || null, shade_no: l.shade_no || null, reject_reason: l.reject_reason || null })),
      };
      const r = editId ? await http.put<{ data: any; message: string }>(`/fabric-process/inward/${editId}`, payload) : await http.post<{ data: any; message: string }>('/fabric-process/inward', payload);
      toast((r as any).message, 'success');
      void qc.invalidateQueries({ queryKey: ['fabric-process'] });
      onDone(r.data.id);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <div>
      <FpTitle no={2} title={editId ? `Edit GRN ${existing.data?.inward_no ?? ''}` : 'New Process Inward / GRN'} sub={requiresQc ? 'This process requires QC: save, send for QC, then post' : 'Load the outward DC and receive job-wise'}
        actions={<Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 md:grid-cols-6">
        <Select label="Outward DC *" disabled={!!editId} value={fpoId ? String(fpoId) : ''} placeholder="— Load DC —" onChange={(e) => e.target.value && onPickDc(Number(e.target.value))}
          options={(open.data ?? []).map((o) => ({ value: o.id, label: `${o.fpo_no} · ${o.vendor_name} · ${o.process_name ?? o.sub_process} · bal ${kg(o.balance_kg)} KG` }))} />
        <Input label="GRN date *" type="date" value={head.inward_date} onChange={(e) => setHead({ ...head, inward_date: e.target.value })} />
        <Input label="Process" value={d?.process_name ?? ''} disabled />
        <Input label="Process unit (Supplier / Vendor)" value={d?.vendor_name ?? ''} disabled />
        <Input label="Process unit challan no" value={head.challan_no} onChange={(e) => setHead({ ...head, challan_no: e.target.value })} />
        <Input label="Vehicle no" value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} />
        <div className="col-span-2"><GateEntryPicker partyId={d?.vendor_id} value={head.gate_inward_id} idPrefix="pin"
          onChange={(v) => setHead((x) => ({ ...x, gate_inward_id: v }))}
          onPick={(g) => setHead((x) => ({ ...x, gate_inward_id: String(g.id), vehicle_no: x.vehicle_no || g.vehicle_no || '', challan_no: x.challan_no || g.supplier_dc_no || '' }))} /></div>
        <Input label="Received by *" value={head.received_by} onChange={(e) => setHead({ ...head, received_by: e.target.value })} />
        <Select label="Processed fabric store *" value={head.warehouse_id} onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })} options={toOptions(warehouses.data)} />
        <Select label="Reject store" value={head.reject_warehouse_id} onChange={(e) => setHead({ ...head, reject_warehouse_id: e.target.value })} options={toOptions(warehouses.data)} />
        <Textarea label="Remarks" className="col-span-2 md:col-span-3" rows={1} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </div>
      {!fpoId && <div className="card p-10 text-center text-sm text-slate-400">Choose the outward DC to load its rolls</div>}
      {fpoId && dc.isLoading && <LoadingBlock />}
      {d && (
        <>
          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-2">
              <Tabs tabs={[{ key: 'entry', label: 'Input vs output entry', count: lines.length }, { key: 'jobs', label: 'Job-wise summary', count: jobSummary.length }]} active={tab} onChange={setTab} />
              <Button size="sm" variant="secondary" className="mb-4" onClick={fillGood}>Fill open KG as good</Button>
            </div>
            {tab === 'entry' ? (
              <div className="max-h-[55vh] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500"><tr>
                    {['Job', 'PO', 'Input roll', 'Open KG', 'Output roll (blank = auto)', 'Colour', 'Good KG', 'Reject KG', 'Loss KG', 'Reject reason', 'Mtr', 'GSM', 'Dia', 'Shade', ''].map((h) => <th key={h} className={`px-2 py-2 ${/KG|Mtr/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {groupByJob(lines).map((g) => (
                      <GrnJobRows key={g.io_no} g={g} reasons={(reasons.data ?? []).filter((x) => x.kind !== 'BILLING')} set={set} split={split} accounted={accounted}
                        remove={(k) => setLines((ls) => ls.filter((l) => l.key !== k))} />
                    ))}
                    {!lines.length && <tr><td colSpan={15} className="px-3 py-8 text-center text-slate-400">Every roll of this DC is already received</td></tr>}
                  </tbody>
                  <tfoot className="sticky bottom-0 bg-slate-100 font-bold">
                    <tr><td colSpan={6} className="px-2 py-2 text-right">This GRN</td><td className="px-2 py-2 text-right text-emerald-800">{kg(tot.good)}</td><td className="px-2 py-2 text-right text-red-700">{kg(tot.rej)}</td><td className="px-2 py-2 text-right text-amber-700">{kg(tot.loss)}</td><td colSpan={6} /></tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'Rolls', 'Open KG', 'Good KG', 'Reject KG', 'Loss KG', 'Balance after GRN'].map((h) => <th key={h} className={`px-3 py-2 ${h === 'Job' ? 'text-left' : 'text-right'}`}>{h}</th>)}</tr></thead>
                <tbody>{jobSummary.map((j) => (
                  <tr key={j.io_no} className="border-t border-slate-100"><td className="px-3 py-1.5 font-semibold">{j.io_no}</td><td className="px-3 py-1.5 text-right">{j.rolls}</td><td className="px-3 py-1.5 text-right">{kg(j.open)}</td>
                    <td className="px-3 py-1.5 text-right text-emerald-700">{kg(j.good)}</td><td className="px-3 py-1.5 text-right text-red-700">{kg(j.rej)}</td><td className="px-3 py-1.5 text-right text-amber-700">{kg(j.loss)}</td>
                    <td className={`px-3 py-1.5 text-right ${j.bal > 0.0005 ? 'font-semibold text-orange-700' : ''}`}>{kg(j.bal)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>
          {recon && <div className="card mt-3 p-4"><h3 className="mb-2 text-[13px] font-semibold text-slate-800">Reconciliation with DC {d.fpo_no} (after this GRN)</h3><ReconCards t={recon} /></div>}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" onClick={onBack}>Cancel</Button>
            <Button variant="secondary" loading={busy} onClick={() => save('DRAFT')}><Save size={14} className="mr-1" /> Save Draft</Button>
            <Button variant="secondary" loading={busy} onClick={() => save('QC')}><Send size={14} className="mr-1" /> Send for QC</Button>
            {!requiresQc && can('FABRIC_PROCESS.CONFIRM') && !editId && <Button loading={busy} onClick={() => save('POST')}><CheckCircle2 size={14} className="mr-1" /> Confirm GRN</Button>}
          </div>
        </>
      )}
    </div>
  );
}

function GrnJobRows({ g, reasons, set, split, remove, accounted }: { g: { io_no: string; rows: Line[] }; reasons: { id: number; reason: string }[]; set: (k: string, p: Partial<Line>) => void; split: (l: Line) => void; remove: (k: string) => void; accounted: (rid: number) => number }) {
  const inp = 'input py-0.5 text-xs';
  return (
    <>
      <tr className="bg-sky-50/70"><td colSpan={15} className="px-2 py-1.5 text-[11.5px] font-semibold text-sky-900">Job {g.io_no}{g.rows[0].buyer_po_no ? ` · PO ${g.rows[0].buyer_po_no}` : ''}{g.rows[0].style_code ? ` · Style ${g.rows[0].style_code}` : ''}</td></tr>
      {g.rows.map((l, i) => {
        const first = i === 0 || g.rows[i - 1].roll_in_id !== l.roll_in_id;
        const over = accounted(l.roll_in_id) > l.open_kg + 0.0005;
        return (
          <tr key={l.key} className={`border-t border-slate-100 ${over ? 'bg-red-50' : ''}`}>
            <td className="px-2 py-1">{first ? l.io_no : ''}</td><td className="px-2 py-1">{first ? (l.buyer_po_no || '—') : ''}</td>
            <td className="px-2 py-1 font-mono">{first ? l.input_roll : <span className="text-slate-400">↳ split</span>}</td>
            <td className="px-2 py-1 text-right tabular-nums">{first ? kg(l.open_kg) : ''}</td>
            <td className="px-1 py-1"><input className={`${inp} w-28`} value={l.output_roll_no} onChange={(e) => set(l.key, { output_roll_no: e.target.value })} /></td>
            <td className="px-1 py-1"><input className={`${inp} w-20`} value={l.color_name} onChange={(e) => set(l.key, { color_name: e.target.value })} /></td>
            {(['good_kg', 'reject_kg', 'loss_kg'] as const).map((k) => (
              <td key={k} className="px-1 py-1"><input type="number" step="0.001" className={`${inp} w-[84px] text-right ${k === 'good_kg' ? 'text-emerald-700' : k === 'reject_kg' ? 'text-red-700' : 'text-amber-700'}`} value={l[k]}
                onChange={(e) => set(l.key, { [k]: e.target.value === '' ? '' : Number(e.target.value) } as Partial<Line>)} /></td>
            ))}
            <td className="px-1 py-1">
              <select className={`${inp} w-36 ${n(l.reject_kg) > 0 && !l.reject_reason ? 'border-red-400' : ''}`} value={l.reject_reason} onChange={(e) => set(l.key, { reject_reason: e.target.value })}>
                <option value="">{n(l.reject_kg) > 0 ? '— reason * —' : '—'}</option>
                {reasons.map((r) => <option key={r.id} value={r.reason}>{r.reason}</option>)}
              </select>
            </td>
            <td className="px-1 py-1"><input type="number" step="0.01" className={`${inp} w-20 text-right`} value={l.meters} onChange={(e) => set(l.key, { meters: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
            <td className="px-1 py-1"><input className={`${inp} w-14`} value={l.gsm} onChange={(e) => set(l.key, { gsm: e.target.value })} /></td>
            <td className="px-1 py-1"><input className={`${inp} w-14`} value={l.dia} onChange={(e) => set(l.key, { dia: e.target.value })} /></td>
            <td className="px-1 py-1"><input className={`${inp} w-16`} value={l.shade_no} onChange={(e) => set(l.key, { shade_no: e.target.value })} /></td>
            <td className="whitespace-nowrap px-1 py-1">
              <button title="Split into another output roll" className="p-1 text-slate-400 hover:text-sky-700" onClick={() => split(l)}><Split size={13} /></button>
              {!first && <button className="p-1 text-slate-400 hover:text-red-600" onClick={() => remove(l.key)}><Trash2 size={13} /></button>}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function InwardView({ id, onBack, onEdit }: { id: number; onBack: () => void; onEdit: () => void }) {
  const q = useQuery({ queryKey: ['fabric-process', 'inward', id], queryFn: async () => (await http.get<{ data: any }>(`/fabric-process/inward/${id}`)).data });
  const g = q.data;
  if (!g) return <LoadingBlock />;
  if (g.status !== 'POSTED') return <DraftView g={g} onBack={onBack} onEdit={onEdit} />;
  const print = () => {
    const body = groupByJob(g.lines as any[]).map((j) => `<tr class="grp"><td colspan="9">Job ${esc(j.io_no)}</td></tr>` + j.rows.map((l: any) =>
      `<tr><td>${esc(l.input_roll_no)}</td><td>${esc(l.roll_no)}</td><td>${esc(l.color_name ?? '')}</td><td class="r">${kg(l.input_kg)}</td><td class="r">${kg(l.weight_kg)}</td><td class="r">${kg(l.reject_kg)}</td><td class="r">${kg(l.loss_kg)}</td><td>${esc(l.gsm ?? '')}</td><td>${esc(l.dia ?? '')}</td></tr>`).join('')).join('');
    printDoc(g.inward_no, `<h1>PROCESS INWARD / GRN — ${esc(g.process_name ?? g.sub_process)}</h1><table class="meta"><tr><td><b>GRN:</b> ${esc(g.inward_no)}</td><td><b>Date:</b> ${esc(fmtDate(g.inward_date))}</td><td><b>DC:</b> ${esc(g.fpo_no)}</td></tr>
      <tr><td><b>Supplier / Vendor:</b> ${esc(g.vendor_name)}</td><td><b>Challan:</b> ${esc(g.challan_no ?? '—')}</td><td><b>Received by:</b> ${esc(g.received_by ?? '')}</td></tr></table>`,
      `<table><thead><tr><th>Input roll</th><th>Output roll</th><th>Colour</th><th class="r">Input KG</th><th class="r">Good</th><th class="r">Reject</th><th class="r">Loss</th><th>GSM</th><th>Dia</th></tr></thead><tbody>${body}
       <tr class="sub"><td colspan="4">Total</td><td class="r">${kg(g.good_kg)}</td><td class="r">${kg(g.reject_kg)}</td><td class="r">${kg(g.loss_kg)}</td><td colspan="2"></td></tr></tbody></table>`);
  };
  return (
    <div>
      <FpTitle no={2} title={`Process GRN — ${g.inward_no}`} sub={`${g.process_name ?? g.sub_process} · DC ${g.fpo_no} · ${g.vendor_name}`}
        actions={<><FpStatus value={g.bill_id ? 'BILLED' : 'POSTED'} /><Button variant="secondary" onClick={print}><Printer size={14} className="mr-1" /> Print GRN</Button><Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button></>} />
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 text-xs md:grid-cols-6">
        {[['GRN date', fmtDate(g.inward_date)], ['Challan', g.challan_no || '—'], ['Vehicle', g.vehicle_no || '—'], ['Received by', g.received_by || '—'], ['Store', g.warehouse_name], ['Reject store', g.reject_store || '—']].map(([k, v]) => (
          <div key={k}><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div><div className="font-semibold">{v}</div></div>))}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['Job', 'PO', 'Style', 'Input roll', 'Output roll', 'Colour', 'Input KG', 'Good KG', 'Reject KG', 'Loss KG', 'Reject reason', 'GSM', 'Dia'].map((h) => <th key={h} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>{g.lines.map((l: any) => (
            <tr key={l.id} className="border-t border-slate-100"><td className="px-2 py-1 font-semibold">{l.io_no}</td><td className="px-2 py-1">{l.buyer_po_no || '—'}</td><td className="px-2 py-1">{l.style_code || '—'}</td>
              <td className="px-2 py-1 font-mono">{l.input_roll_no}</td><td className="px-2 py-1 font-mono">{l.roll_no}</td><td className="px-2 py-1">{l.color_name || '—'}</td>
              <td className="px-2 py-1 text-right">{kg(l.input_kg)}</td><td className="px-2 py-1 text-right text-emerald-700">{kg(l.weight_kg)}</td><td className="px-2 py-1 text-right text-red-700">{kg(l.reject_kg)}</td>
              <td className="px-2 py-1 text-right text-amber-700">{kg(l.loss_kg)}</td><td className="px-2 py-1">{l.reject_reason || '—'}</td><td className="px-2 py-1">{l.gsm || '—'}</td><td className="px-2 py-1">{l.dia || '—'}</td></tr>
          ))}</tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={7} className="px-2 py-2 text-right">Total</td><td className="px-2 py-2 text-right">{kg(g.good_kg)}</td><td className="px-2 py-2 text-right">{kg(g.reject_kg)}</td><td className="px-2 py-2 text-right">{kg(g.loss_kg)}</td><td colSpan={3} /></tr></tfoot>
        </table>
      </div>
      <div className="card mt-3 p-4"><h3 className="mb-2 text-[13px] font-semibold text-slate-800">DC {g.fpo_no} reconciliation</h3><ReconCards t={g.reconciliation.total} /></div>
    </div>
  );
}

const QC_STATES = ['QC_PENDING', 'ACCEPTED', 'PARTIAL', 'REJECTED'];
/** A GRN not posted yet: its lines, QC entry (process type parameters) and the Draft → QC → Post actions. */
function DraftView({ g, onBack, onEdit }: { g: any; onBack: () => void; onEdit: () => void }) {
  const toast = useToast();
  const qcl = useQueryClient();
  const { can } = useAuth();
  const [busy, setBusy] = useState('');
  const lines: any[] = g.draft?.lines ?? [];
  const params: any[] = g.qc_params ?? [];
  const goodIdx = lines.filter((l) => n(l.good_kg) > 0).map((l) => l.line_index as number);
  const [vals, setVals] = useState<Record<number, Record<string, string>>>(() => Object.fromEntries(lines.map((l) => [l.line_index, Object.fromEntries(Object.entries(l.qc?.values ?? {}).map(([k, v]) => [k, v === null ? '' : String(v)]))])));
  const [stat, setStat] = useState<Record<number, string>>(() => Object.fromEntries(lines.map((l) => [l.line_index, l.qc?.status ?? ''])));
  const [lineRem, setLineRem] = useState<Record<number, string>>(() => Object.fromEntries(lines.map((l) => [l.line_index, l.qc?.remarks ?? ''])));
  const [qcRemarks, setQcRemarks] = useState(g.qc_remarks ?? '');
  const result = (p: any, raw: string | undefined) => {
    if (raw === undefined || raw === '') return 'NA';
    const v = Number(raw);
    return (p.min_value !== null && v < Number(p.min_value)) || (p.max_value !== null && v > Number(p.max_value)) ? 'FAIL' : 'PASS';
  };
  const fails = (k: number) => params.filter((p) => result(p, vals[k]?.[String(p.id)]) === 'FAIL').map((p) => p.param_name);
  const editable = ['DRAFT', ...QC_STATES].includes(g.status);
  const qcOpen = QC_STATES.includes(g.status) && can('FABRIC_PROCESS.QC');
  const act = async (key: string, fn: () => Promise<any>) => {
    setBusy(key);
    try { const r = await fn(); toast(r?.message ?? 'Done', 'success'); void qcl.invalidateQueries({ queryKey: ['fabric-process'] }); }
    catch (e) { toast(errText(e), 'error'); } finally { setBusy(''); }
  };
  const saveQc = () => act('qc', () => http.post(`/fabric-process/inward/${g.id}/qc`, {
    remarks: qcRemarks || null,
    results: goodIdx.map((k) => ({ line_index: k, qc_status: stat[k] || undefined, remarks: lineRem[k] || null,
      values: Object.fromEntries(params.map((p) => [String(p.id), vals[k]?.[String(p.id)] === undefined || vals[k]?.[String(p.id)] === '' ? null : Number(vals[k][String(p.id)])])) })),
  }));
  const canPost = can('FABRIC_PROCESS.CONFIRM') && g.status !== 'QC_PENDING' && g.status !== 'CANCELLED' && !(g.requires_qc && g.status === 'DRAFT');
  const inp = 'input py-0.5 text-xs';
  return (
    <div>
      <FpTitle no={2} title={`Process GRN — ${g.inward_no}`} sub={`${g.process_name ?? g.sub_process} · DC ${g.fpo_no} · ${g.vendor_name}${g.requires_qc ? ' · QC required' : ''}`}
        actions={<>
          <FpStatus value={g.status} />
          {editable && can('FABRIC_PROCESS.EDIT_DRAFT') && <Button variant="secondary" onClick={onEdit}><Pencil size={14} className="mr-1" /> Edit</Button>}
          {g.status === 'DRAFT' && can('FABRIC_PROCESS.CREATE') && <Button variant="secondary" loading={busy === 'send'} onClick={() => act('send', () => http.post(`/fabric-process/inward/${g.id}/submit-qc`, {}))}><Send size={14} className="mr-1" /> Send for QC</Button>}
          {editable && can('FABRIC_PROCESS.EDIT_DRAFT') && <Button variant="secondary" loading={busy === 'cancel'} onClick={() => { if (window.confirm(`Cancel ${g.inward_no}?`)) void act('cancel', () => http.post(`/fabric-process/inward/${g.id}/cancel`, {})); }}><XCircle size={14} className="mr-1" /> Cancel GRN</Button>}
          {editable && canPost && <Button loading={busy === 'post'} onClick={() => act('post', () => http.post(`/fabric-process/inward/${g.id}/post`, {}))}><CheckCircle2 size={14} className="mr-1" /> Post GRN</Button>}
          <Button variant="secondary" onClick={onBack}><ArrowLeft size={14} className="mr-1" /> Back</Button>
        </>} />
      {g.status === 'QC_PENDING' && <div className="mb-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2 text-xs text-orange-900">Waiting for QC — no stock has moved. Record the QC result below, then post.</div>}
      {g.status === 'DRAFT' && <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-700">Draft — no stock has moved.{g.requires_qc ? ' This process requires QC: send it for QC before posting.' : ''}</div>}
      <div className="card mb-3 grid grid-cols-2 gap-3 p-4 text-xs md:grid-cols-6">
        {[['GRN date', fmtDate(g.inward_date)], ['Challan', g.challan_no || '—'], ['Vehicle', g.vehicle_no || '—'], ['Received by', g.received_by || '—'], ['Store', g.warehouse_name], ['QC', g.qc_at ? `${fmtDate(g.qc_at)}${g.qc_remarks ? ` · ${g.qc_remarks}` : ''}` : '—']].map(([k, v]) => (
          <div key={k}><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div><div className="font-semibold">{v}</div></div>))}
      </div>
      <div className="card overflow-x-auto">
        <div className="flex items-center gap-2 px-4 pt-3 text-[13px] font-semibold text-slate-800"><ClipboardCheck size={15} /> Received rolls{params.length ? ' & QC' : ''}</div>
        <table className="mt-2 w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>
            {['Job', 'Input roll', 'Output roll', 'Colour', 'Good KG', 'Reject KG', 'Loss KG'].map((h) => <th key={h} className={`px-2 py-2 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
            {params.map((p) => <th key={p.id} className="px-2 py-2 text-left" title={`min ${p.min_value ?? '—'} / max ${p.max_value ?? '—'}`}>{p.param_name}{p.uom ? ` (${p.uom})` : ''}{p.is_mandatory ? ' *' : ''}<div className="font-normal normal-case text-slate-400">{p.min_value ?? '…'} – {p.max_value ?? '…'}</div></th>)}
            <th className="px-2 py-2 text-left">QC status</th><th className="px-2 py-2 text-left">QC remarks</th>
          </tr></thead>
          <tbody>
            {lines.map((l) => {
              const k = l.line_index as number; const good = n(l.good_kg) > 0; const f = fails(k);
              return (
                <tr key={k} className={`border-t border-slate-100 ${f.length ? 'bg-red-50/60' : ''}`}>
                  <td className="px-2 py-1 font-semibold">{l.io_no || 'STOCK'}</td><td className="px-2 py-1 font-mono">{l.input_roll_no}</td><td className="px-2 py-1 font-mono">{l.output_roll_no || <span className="text-slate-400">auto</span>}</td>
                  <td className="px-2 py-1">{l.color_name || '—'}</td><td className="px-2 py-1 text-right text-emerald-700">{kg(l.good_kg)}</td><td className="px-2 py-1 text-right text-red-700">{kg(l.reject_kg)}</td><td className="px-2 py-1 text-right text-amber-700">{kg(l.loss_kg)}</td>
                  {params.map((p) => {
                    const raw = vals[k]?.[String(p.id)]; const rs = result(p, raw);
                    return <td key={p.id} className="px-1 py-1">{good ? (qcOpen
                      ? <input type="number" step="0.001" className={`${inp} w-20 text-right ${rs === 'FAIL' ? 'border-red-400 text-red-700' : rs === 'PASS' ? 'text-emerald-700' : ''}`} value={raw ?? ''}
                          onChange={(e) => setVals((v) => ({ ...v, [k]: { ...(v[k] ?? {}), [String(p.id)]: e.target.value } }))} />
                      : <span className={rs === 'FAIL' ? 'font-semibold text-red-700' : ''}>{raw || '—'}{rs !== 'NA' ? ` · ${rs}` : ''}</span>) : <span className="text-slate-300">—</span>}</td>;
                  })}
                  <td className="px-1 py-1">{good ? (qcOpen
                    ? <select className={`${inp} w-28`} value={stat[k] ?? ''} onChange={(e) => setStat((x) => ({ ...x, [k]: e.target.value }))}>
                        <option value="">{f.length ? 'Auto: Rejected' : 'Auto: Accepted'}</option><option value="ACCEPTED">Accepted</option><option value="HOLD">Hold</option><option value="REJECTED">Rejected</option>
                      </select>
                    : (l.qc ? <FpStatus value={l.qc.status} /> : <span className="text-slate-400">—</span>)) : <span className="text-slate-300">—</span>}</td>
                  <td className="px-1 py-1">{good && qcOpen ? <input className={`${inp} w-36`} value={lineRem[k] ?? ''} onChange={(e) => setLineRem((x) => ({ ...x, [k]: e.target.value }))} /> : (l.qc?.remarks || '')}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-slate-100 font-bold"><tr><td colSpan={4} className="px-2 py-2 text-right">Total</td><td className="px-2 py-2 text-right">{kg(g.good_kg)}</td><td className="px-2 py-2 text-right">{kg(g.reject_kg)}</td><td className="px-2 py-2 text-right">{kg(g.loss_kg)}</td><td colSpan={params.length + 2} /></tr></tfoot>
        </table>
        {qcOpen && (
          <div className="flex flex-wrap items-end justify-end gap-2 border-t border-surface-border p-3">
            {!params.length && <span className="mr-auto text-[11.5px] text-slate-500">No QC parameters for this process — set them on Process Types & QC; you can still accept / hold / reject each roll.</span>}
            <Input label="QC remarks" className="w-72" value={qcRemarks} onChange={(e) => setQcRemarks(e.target.value)} />
            <Button loading={busy === 'qc'} onClick={saveQc}><ClipboardCheck size={14} className="mr-1" /> Save QC result</Button>
          </div>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-slate-500">On posting, QC-rejected rolls go to the reject store with the failed parameters as the reason; rolls on hold go to the store on QC hold.</p>
      <div className="card mt-3 p-4"><h3 className="mb-2 text-[13px] font-semibold text-slate-800">DC {g.fpo_no} reconciliation (posted GRNs)</h3><ReconCards t={g.reconciliation.total} /></div>
    </div>
  );
}
