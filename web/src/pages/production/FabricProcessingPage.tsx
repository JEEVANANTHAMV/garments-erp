import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Send, PackageCheck, Ban, Printer, RefreshCw, Trash2 } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useLookup, toOptions } from '../../hooks/useLookup';
import { useToast } from '../../hooks/useToast';
import { PageHeader, Button, Modal, Input, Select, Checkbox, StatusBadge, SearchInput, LoadingBlock, Textarea } from '../../components/ui';
import { fmtDate, fmtDecimal, today } from '../../lib/format';

/**
 * Fabric processing linked to store stock (client voice note 30-Sep-2026):
 *   Store roll (fabric GRN / knitting inward / earlier processing)
 *     → Processing DC to the dyer / washer / printer (store KG goes down, KG is "at the processor")
 *     → Receive processed fabric: a GRN + new store rolls (DYED / WASHED / PRINTED …, with colour)
 *     → Fabric issue to cutting picks those rolls up (Cutting › Fabric DC).
 */
const PROCESSES = [
  ['DYEING', 'Dyeing'], ['WASHING', 'Washing'], ['PRINTING', 'Printing'], ['COMPACTING', 'Compacting'],
  ['HEAT_SETTING', 'Heat setting'], ['STENTERING', 'Stentering'], ['RELAX_DRYER', 'Relax dryer'],
  ['TUMBLE_DRYER', 'Tumble dryer'], ['BITTING_SLITTING', 'Bitting / slitting'], ['COMMON_PROCESS', 'Common process'],
] as const;
const procLabel = (v: string) => PROCESSES.find((p) => p[0] === v)?.[1] ?? v;
const n = (v: unknown) => Number(v ?? 0) || 0;
const errText = (e: unknown) => {
  if (e instanceof ApiError) {
    const det = Array.isArray(e.details) ? (e.details as any[]).map((d) => `${d.field}: ${d.message}`).join('; ') : '';
    return `${e.message}${det ? ` — ${det}` : ''}`;
  }
  return (e as any)?.message || 'Failed';
};

interface StoreRoll {
  id: number; roll_no: string; lot_no: string | null; fabric_id: number; fabric_name: string; weight_kg: number; meters: number;
  balance_kg: number; gsm: number | null; dia: string | null; color_name: string | null; process_state: string;
  warehouse_name: string | null; grn_no: string; grn_date: string; io_no: string | null;
}
interface Job { id: number; job_no: string; styles: { style_id: number; style_code: string; style_name: string }[] }

export default function FabricProcessingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const orders = useQuery({
    queryKey: ['fabric-processing', 'orders'],
    queryFn: async () => (await http.get<{ data: any[] }>('/fabric-processing/orders')).data ?? [],
  });
  const shown = useMemo(() => (orders.data ?? []).filter((o) =>
    (!status || o.status === status) &&
    (!search || [o.fpo_no, o.io_no, o.vendor_name, o.fabric_name, o.color_name].some((x) => String(x ?? '').toLowerCase().includes(search.toLowerCase())))),
  [orders.data, search, status]);
  const kpi = useMemo(() => {
    const live = (orders.data ?? []).filter((o) => o.status !== 'CANCELLED');
    const sent = live.reduce((a, o) => a + n(o.input_weight_kg), 0);
    const back = live.reduce((a, o) => a + n(o.output_weight_kg), 0);
    const atVendor = live.filter((o) => o.status !== 'COMPLETED').reduce((a, o) => a + Math.max(0, n(o.input_weight_kg) - n(o.output_weight_kg)), 0);
    return { dcs: live.length, sent, back, atVendor };
  }, [orders.data]);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['fabric-processing'] }); };

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={['Production', 'Fabric Processing']}
        title="Fabric Processing"
        subtitle="Store rolls → dyeing / washing / printing → processed rolls back to the store → cutting"
        actions={<>
          <Button variant="secondary" onClick={refresh}><RefreshCw size={14} className="mr-1" /> Refresh</Button>
          <Button onClick={() => setCreating(true)}><Plus size={14} className="mr-1" /> New Processing DC</Button>
        </>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Processing DCs', kpi.dcs, ''], ['KG sent', fmtDecimal(kpi.sent, 2), 'KG'], ['KG received back', fmtDecimal(kpi.back, 2), 'KG'], ['At processors', fmtDecimal(kpi.atVendor, 2), 'KG pending']].map(([k, v, u]) => (
          <div key={k as string} className="card p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{k}</div>
            <div className="text-lg font-bold text-slate-900">{v} <span className="text-xs font-normal text-slate-500">{u}</span></div>
          </div>
        ))}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-surface-border p-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search DC, IO, processor, fabric, colour…" className="w-72" />
          <select className="input w-44 py-1.5 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['DISPATCHED', 'IN_PROCESS', 'COMPLETED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </div>
        {orders.isLoading ? <LoadingBlock /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {['DC no', 'Date', 'IO', 'Process', 'Processor', 'Fabric', 'Colour', 'Rolls', 'Sent KG', 'Received KG', 'Pending KG', 'Loss %', 'Status'].map((h) => (
                    <th key={h} className={`px-3 py-2 ${/KG|%|Rolls/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const pend = o.status === 'COMPLETED' || o.status === 'CANCELLED' ? 0 : Math.max(0, n(o.input_weight_kg) - n(o.output_weight_kg));
                  return (
                    <tr key={o.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setOpenId(o.id)}>
                      <td className="px-3 py-2 font-mono font-semibold text-brand-700">{o.fpo_no}</td>
                      <td className="px-3 py-2">{fmtDate(o.fpo_date)}</td>
                      <td className="px-3 py-2">{o.io_no}</td>
                      <td className="px-3 py-2">{procLabel(o.sub_process)}</td>
                      <td className="px-3 py-2">{o.vendor_name || '—'}</td>
                      <td className="px-3 py-2">{o.fabric_name || '—'}</td>
                      <td className="px-3 py-2">{o.color_name || '—'}</td>
                      <td className="px-3 py-2 text-right">{o.total_input_rolls}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtDecimal(o.input_weight_kg, 3)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtDecimal(o.output_weight_kg, 3)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pend > 0 ? 'font-semibold text-amber-700' : 'text-slate-400'}`}>{fmtDecimal(pend, 3)}</td>
                      <td className="px-3 py-2 text-right">{n(o.output_weight_kg) > 0 ? `${fmtDecimal(o.process_loss_pct, 2)}%` : '—'}</td>
                      <td className="px-3 py-2"><StatusBadge value={o.status} /></td>
                    </tr>
                  );
                })}
                {!shown.length && <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-400">No processing DCs yet — click “New Processing DC” and pick rolls from the store</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && <NewDcModal onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); refresh(); setOpenId(id); }} />}
      {openId !== null && <DcDetailModal id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </div>
  );
}

// ---------------------------------------------------------------- New DC
function NewDcModal({ onClose, onSaved }: { onClose: () => void; onSaved: (id: number) => void }) {
    const toast = useToast();
    const qc = useQueryClient();
    const suppliers = useLookup('suppliers');
    const fabrics = useLookup('fabrics');
    const colors = useLookup('colors');
    const jobs = useQuery({ queryKey: ['procurement-jobs'], queryFn: async () => (await http.get<{ data: Job[] }>('/procurement/jobs')).data ?? [] });
    const [head, setHead] = useState({
      fpo_date: today(), so_id: '', style_id: '', fabric_id: '', sub_process: 'DYEING', vendor_id: '', color_name: '', shade_code: '',
      target_dia: '', target_gsm: '', expected_return_date: '', vehicle_no: '', remarks: '',
    });
    const [picked, setPicked] = useState<Record<number, number>>({});   // roll id → KG to send
    const [rollQ, setRollQ] = useState('');
    const [saving, setSaving] = useState(false);
    const job = (jobs.data ?? []).find((j) => String(j.id) === head.so_id);
    const rolls = useQuery({
      queryKey: ['fabric-processing', 'store-rolls', head.fabric_id],
      queryFn: async () => (await http.get<{ data: StoreRoll[] }>(`/fabric-processing/store-rolls${head.fabric_id ? `?fabric_id=${head.fabric_id}` : ''}`)).data ?? [],
    });
    const list = (rolls.data ?? []).filter((r) => !rollQ || [r.roll_no, r.lot_no, r.grn_no, r.io_no, r.fabric_name].some((x) => String(x ?? '').toLowerCase().includes(rollQ.toLowerCase())));
    const pickedRows = (rolls.data ?? []).filter((r) => picked[r.id] !== undefined);
    const totalKg = pickedRows.reduce((a, r) => a + n(picked[r.id]), 0);
    const mixed = new Set(pickedRows.map((r) => r.fabric_id)).size > 1;

    const toggle = (r: StoreRoll) => setPicked((p) => {
      const next = { ...p };
      if (next[r.id] !== undefined) delete next[r.id]; else next[r.id] = r.balance_kg;
      return next;
    });
    const save = async () => {
      if (!head.vendor_id) { toast('Choose the processor', 'warning'); return; }
      if (!pickedRows.length) { toast('Pick the rolls to send', 'warning'); return; }
      if (mixed) { toast('Rolls of different fabrics — send one fabric per DC (filter by fabric)', 'warning'); return; }
      const over = pickedRows.find((r) => n(picked[r.id]) <= 0 || n(picked[r.id]) > r.balance_kg + 1e-6);
      if (over) { toast(`Roll ${over.roll_no}: KG must be between 0 and ${over.balance_kg}`, 'warning'); return; }
      setSaving(true);
      try {
        const fabricId = head.fabric_id || String(pickedRows[0].fabric_id);
        const r = await http.post<{ data: { id: number; fpo_no: string } }>('/fabric-processing/orders', {
          ...head, fabric_id: Number(fabricId), so_id: head.so_id ? Number(head.so_id) : null, style_id: head.style_id ? Number(head.style_id) : null,
          vendor_id: Number(head.vendor_id), expected_return_date: head.expected_return_date || null,
          input_rolls: pickedRows.map((x) => ({ fabric_roll_id: x.id, roll_no: x.roll_no, lot_no: x.lot_no, weight_kg: n(picked[x.id]),
            meters: x.weight_kg > 0 ? Math.round((x.meters || 0) * (n(picked[x.id]) / x.weight_kg) * 100) / 100 : 0 })),
        });
        toast(`Processing DC ${r.data.fpo_no} issued — ${fmtDecimal(totalKg, 3)} KG sent to ${procLabel(head.sub_process).toLowerCase()}`, 'success');
        void qc.invalidateQueries({ queryKey: ['fabric-processing'] });
        onSaved(r.data.id);
      } catch (e) { toast(errText(e), 'error'); } finally { setSaving(false); }
    };

    return (
      <Modal open onClose={onClose} size="full" title="New Processing DC — send store rolls to the processor"
        footer={<>
          <span className="mr-auto self-center text-xs text-slate-600"><b>{pickedRows.length}</b> roll(s) · <b>{fmtDecimal(totalKg, 3)}</b> KG{mixed && <span className="ml-2 font-semibold text-red-600">different fabrics picked</span>}</span>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={saving} onClick={save}><Send size={13} className="mr-1" /> Issue DC</Button>
        </>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <Input label="DC date" type="date" value={head.fpo_date} onChange={(e) => setHead({ ...head, fpo_date: e.target.value })} />
          <Select label="Process" value={head.sub_process} onChange={(e) => setHead({ ...head, sub_process: e.target.value })}
            options={PROCESSES.map(([v, l]) => ({ value: v, label: l }))} />
          <Select label="Processor *" value={head.vendor_id} placeholder="— Dyer / washer / printer —" onChange={(e) => setHead({ ...head, vendor_id: e.target.value })}
            options={toOptions(suppliers.data)} />
          <Select label="Job / IO" value={head.so_id} placeholder="— Stock / general —"
            onChange={(e) => { const j = (jobs.data ?? []).find((x) => String(x.id) === e.target.value); setHead({ ...head, so_id: e.target.value, style_id: j && j.styles.length === 1 ? String(j.styles[0].style_id) : '' }); }}
            options={(jobs.data ?? []).map((j) => ({ value: j.id, label: j.job_no }))} />
          <Select label="Style" value={head.style_id} placeholder="—" onChange={(e) => setHead({ ...head, style_id: e.target.value })}
            options={(job?.styles ?? []).map((st) => ({ value: st.style_id, label: `${st.style_code} — ${st.style_name}` }))} />
          <Select label="Fabric (filters rolls)" value={head.fabric_id} placeholder="— All fabrics —" onChange={(e) => { setHead({ ...head, fabric_id: e.target.value }); setPicked({}); }}
            options={toOptions(fabrics.data)} />
          <Select label={head.sub_process === 'DYEING' || head.sub_process === 'PRINTING' ? 'Colour to dye / print' : 'Colour'} value={head.color_name} placeholder="—"
            onChange={(e) => setHead({ ...head, color_name: e.target.value })}
            options={(colors.data ?? []).map((c: any) => ({ value: c.label, label: c.label }))} />
          <Input label="Shade / lab dip ref" value={head.shade_code} onChange={(e) => setHead({ ...head, shade_code: e.target.value })} />
          <Input label="Target dia" value={head.target_dia} placeholder='e.g. 34"' onChange={(e) => setHead({ ...head, target_dia: e.target.value })} />
          <Input label="Target GSM" value={head.target_gsm} onChange={(e) => setHead({ ...head, target_gsm: e.target.value })} />
          <Input label="Expected return" type="date" value={head.expected_return_date} onChange={(e) => setHead({ ...head, expected_return_date: e.target.value })} />
          <Input label="Vehicle no" value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} />
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <h4 className="text-[13px] font-semibold text-slate-800">Rolls in the store <span className="font-normal text-slate-500">(QC accepted, KG left — a roll can be sent in part)</span></h4>
          <SearchInput value={rollQ} onChange={setRollQ} placeholder="Roll, lot, GRN, IO…" className="w-64" />
        </div>
        <div className="mt-2 max-h-[46vh] overflow-auto rounded border border-slate-200">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 text-slate-500">
              <tr>{['', 'Roll', 'Lot', 'Fabric', 'State', 'Colour', 'GSM', 'Dia', 'GRN', 'IO', 'Store', 'In store KG', 'Send KG'].map((h) => <th key={h} className={`px-2 py-1.5 ${/KG/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rolls.isLoading && <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">Loading store rolls…</td></tr>}
              {list.map((r) => {
                const on = picked[r.id] !== undefined;
                return (
                  <tr key={r.id} className={`border-t border-slate-100 ${on ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}>
                    <td className="px-2 py-1"><input type="checkbox" checked={on} onChange={() => toggle(r)} /></td>
                    <td className="px-2 py-1 font-mono font-semibold">{r.roll_no}</td>
                    <td className="px-2 py-1">{r.lot_no || '—'}</td>
                    <td className="px-2 py-1">{r.fabric_name}</td>
                    <td className="px-2 py-1"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${r.process_state === 'GREY' ? 'bg-slate-100 text-slate-600' : 'bg-purple-100 text-purple-800'}`}>{r.process_state}</span></td>
                    <td className="px-2 py-1">{r.color_name || '—'}</td>
                    <td className="px-2 py-1">{r.gsm || '—'}</td>
                    <td className="px-2 py-1">{r.dia || '—'}</td>
                    <td className="px-2 py-1 font-mono">{r.grn_no}</td>
                    <td className="px-2 py-1">{r.io_no || '—'}</td>
                    <td className="px-2 py-1">{r.warehouse_name || '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{fmtDecimal(r.balance_kg, 3)}</td>
                    <td className="px-2 py-1 text-right">
                      {on ? <input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={picked[r.id]}
                        onChange={(e) => setPicked((p) => ({ ...p, [r.id]: Number(e.target.value) }))} /> : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                );
              })}
              {!rolls.isLoading && !list.length && <tr><td colSpan={13} className="px-2 py-6 text-center text-slate-400">No rolls with KG left in the store{head.fabric_id ? ' for this fabric' : ''} — receive fabric on a Fabric GRN / knitting inward first</td></tr>}
            </tbody>
          </table>
        </div>
        <Textarea label="Remarks" className="mt-3" rows={2} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
      </Modal>
    );
  }

// ---------------------------------------------------------------- DC detail + receive
function DcDetailModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
    const toast = useToast();
    const warehouses = useLookup('warehouses');
    const d = useQuery({
      queryKey: ['fabric-processing', 'order', id],
      queryFn: async () => (await http.get<{ data: any }>(`/fabric-processing/orders/${id}`)).data,
    });
    const [receiving, setReceiving] = useState(false);
    const [busy, setBusy] = useState(false);
    const o = d.data;
    const sentKg = n(o?.summary?.total_input_weight_kg);
    const backKg = n(o?.summary?.total_output_weight_kg);
    const pendKg = o && !['COMPLETED', 'CANCELLED'].includes(o.status) ? Math.max(0, sentKg - backKg) : 0;
    const open = o && !['COMPLETED', 'CANCELLED'].includes(o.status);

    const cancel = async () => {
      if (!window.confirm(`Cancel ${o.fpo_no}? The rolls go back to the store.`)) return;
      setBusy(true);
      try {
        const r = await http.post<{ message: string }>(`/fabric-processing/orders/${id}/cancel`, {});
        toast((r as any).message || 'Cancelled', 'success');
        void d.refetch(); onChanged();
      } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
    };
    const print = () => {
      const w = window.open('', '_blank', 'width=900,height=1000'); if (!w) return;
      const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
      w.document.write(`<!doctype html><html><head><title>${esc(o.fpo_no)}</title><style>body{font:12px Arial;margin:24px}h1{font-size:18px;margin:0}
        table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #999;padding:4px 6px;text-align:left}th{background:#eee}.r{text-align:right}
        .sign{display:flex;justify-content:space-between;margin-top:50px}.sign div{border-top:1px solid #000;width:30%;text-align:center;padding-top:4px}</style></head><body>
        <h1>DELIVERY CHALLAN — FABRIC ${esc(procLabel(o.sub_process).toUpperCase())}</h1>
        <p><b>DC No:</b> ${esc(o.fpo_no)} &nbsp; <b>Date:</b> ${esc(fmtDate(o.fpo_date))} &nbsp; <b>To:</b> ${esc(o.vendor_name)} &nbsp; <b>IO:</b> ${esc(o.io_no)}<br/>
        <b>Fabric:</b> ${esc(o.fabric_name)} &nbsp; <b>Colour:</b> ${esc(o.color_name || '—')} &nbsp; <b>Shade:</b> ${esc(o.shade_code || '—')} &nbsp; <b>Target dia / GSM:</b> ${esc(o.target_dia || '—')} / ${esc(o.target_gsm || '—')}
        ${o.vehicle_no ? `&nbsp; <b>Vehicle:</b> ${esc(o.vehicle_no)}` : ''}</p>
        <table><thead><tr><th>#</th><th>Roll</th><th>Lot</th><th class="r">KG</th><th class="r">Metres</th></tr></thead><tbody>
        ${o.input_rolls.map((r: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(r.roll_no)}</td><td>${esc(r.lot_no || '')}</td><td class="r">${fmtDecimal(r.weight_kg, 3)}</td><td class="r">${fmtDecimal(r.meters, 2)}</td></tr>`).join('')}
        <tr><th colspan="3">Total — ${o.input_rolls.length} roll(s)</th><th class="r">${fmtDecimal(sentKg, 3)}</th><th></th></tr></tbody></table>
        <p>Goods sent for job work (${esc(procLabel(o.sub_process))}) and to be returned after processing — not for sale. ${esc(o.remarks || '')}</p>
        <div class="sign"><div>Prepared by</div><div>Security</div><div>Receiver</div></div><script>window.onload=()=>window.print()</script></body></html>`);
      w.document.close();
    };

    return (
      <Modal open onClose={onClose} size="xl" title={o ? `${o.fpo_no} — ${procLabel(o.sub_process)} at ${o.vendor_name ?? '—'}` : 'Processing DC'}
        footer={o && <>
          <span className="mr-auto self-center"><StatusBadge value={o.status} /></span>
          <Button variant="secondary" onClick={print}><Printer size={13} className="mr-1" /> Print DC</Button>
          {open && !(o.output_rolls?.length) && <Button variant="danger" loading={busy} onClick={cancel}><Ban size={13} className="mr-1" /> Cancel DC</Button>}
          {open && <Button onClick={() => setReceiving(true)}><PackageCheck size={13} className="mr-1" /> Receive processed fabric</Button>}
        </>}>
        {!o ? <LoadingBlock /> : (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[['IO', o.io_no], ['Fabric', o.fabric_name], ['Colour / shade', [o.color_name, o.shade_code].filter(Boolean).join(' / ') || '—'], ['Target dia / GSM', `${o.target_dia || '—'} / ${o.target_gsm || '—'}`],
                ['Sent', `${fmtDecimal(sentKg, 3)} KG · ${o.input_rolls.length} rolls`], ['Received back', `${fmtDecimal(backKg, 3)} KG · ${o.output_rolls.length} rolls`],
                ['Pending at processor', `${fmtDecimal(pendKg, 3)} KG`], ['Process loss', backKg > 0 ? `${fmtDecimal(o.summary.process_loss_kg, 3)} KG (${fmtDecimal(o.summary.process_loss_pct, 2)}%)` : '—']].map(([k, v]) => (
                <div key={k as string}><div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{k}</div><div className="font-semibold text-slate-900">{v}</div></div>
              ))}
            </div>
            <div>
              <h4 className="mb-1 font-semibold text-slate-800">Rolls sent</h4>
              <table className="w-full"><thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1 text-left">Roll</th><th className="px-2 py-1 text-left">Lot</th><th className="px-2 py-1 text-right">KG</th><th className="px-2 py-1 text-right">Metres</th></tr></thead>
                <tbody>{o.input_rolls.map((r: any) => <tr key={r.id} className="border-t border-slate-100"><td className="px-2 py-1 font-mono">{r.roll_no}</td><td className="px-2 py-1">{r.lot_no || '—'}</td><td className="px-2 py-1 text-right">{fmtDecimal(r.weight_kg, 3)}</td><td className="px-2 py-1 text-right">{fmtDecimal(r.meters, 2)}</td></tr>)}</tbody></table>
            </div>
            <div>
              <h4 className="mb-1 font-semibold text-slate-800">Processed rolls received <span className="font-normal text-slate-500">(in the store, ready for Fabric DC to cutting)</span></h4>
              <table className="w-full"><thead className="bg-slate-50 text-slate-500"><tr>{['Roll', 'Lot', 'Date', 'Party DC', 'Dia', 'GSM', 'KG', 'Metres', 'QC'].map((h) => <th key={h} className={`px-2 py-1 ${/KG|Metres/.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
                <tbody>
                  {o.output_rolls.map((r: any) => (
                    <tr key={r.id} className="border-t border-slate-100"><td className="px-2 py-1 font-mono">{r.roll_no}</td><td className="px-2 py-1">{r.lot_no}</td><td className="px-2 py-1">{fmtDate(r.finish_date)}</td><td className="px-2 py-1">{r.party_dc_no || '—'}</td>
                      <td className="px-2 py-1">{r.dia || '—'}</td><td className="px-2 py-1">{r.gsm || '—'}</td><td className="px-2 py-1 text-right">{fmtDecimal(r.weight_kg, 3)}</td><td className="px-2 py-1 text-right">{fmtDecimal(r.meters, 2)}</td><td className="px-2 py-1"><StatusBadge value={r.qc_status} /></td></tr>
                  ))}
                  {!o.output_rolls.length && <tr><td colSpan={9} className="px-2 py-4 text-center text-slate-400">Nothing received yet</td></tr>}
                </tbody></table>
            </div>
          </div>
        )}
        {receiving && o && <ReceiveModal o={o} pendKg={pendKg} warehouses={warehouses.data ?? []} onClose={() => setReceiving(false)}
          onDone={() => { setReceiving(false); void d.refetch(); onChanged(); }} />}
      </Modal>
    );
  }

function ReceiveModal({ o, pendKg, warehouses, onClose, onDone }: { o: any; pendKg: number; warehouses: any[]; onClose: () => void; onDone: () => void }) {
    const toast = useToast();
    const blank = () => ({ roll_no: '', weight_kg: '' as number | '', meters: '' as number | '', dia: o.target_dia || '', gsm: o.target_gsm || '', qc_status: 'ACCEPTED', shrinkage_length_pct: 0, shrinkage_width_pct: 0 });
    const [head, setHead] = useState({ receipt_date: today(), party_dc_no: '', warehouse_id: warehouses[0]?.id ? String(warehouses[0].id) : '', vehicle_no: '', color_name: o.color_name || '', complete: false });
    const [rows, setRows] = useState([blank()]);
    const [saving, setSaving] = useState(false);
    const kg = rows.reduce((a, r) => a + n(r.weight_kg), 0);
    const set = (i: number, p: any) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));
    const save = async () => {
      if (!head.party_dc_no.trim()) { toast("Enter the processor's DC no", 'warning'); return; }
      if (!head.warehouse_id) { toast('Choose the receiving store', 'warning'); return; }
      const good = rows.filter((r) => n(r.weight_kg) > 0);
      if (!good.length) { toast('Enter the KG of each roll received', 'warning'); return; }
      setSaving(true);
      try {
        const r = await http.post<{ data: any }>(`/fabric-processing/orders/${o.id}/receive`, {
          ...head, warehouse_id: Number(head.warehouse_id),
          rolls: good.map((x) => ({ ...x, roll_no: x.roll_no || null, weight_kg: n(x.weight_kg), meters: n(x.meters) })),
        });
        toast(`${r.data.grn_no}: ${fmtDecimal(r.data.received_kg, 3)} KG ${r.data.process_state.toLowerCase()} fabric in store · ${fmtDecimal(r.data.pending_kg, 3)} KG still at the processor`, 'success');
        onDone();
      } catch (e) { toast(errText(e), 'error'); } finally { setSaving(false); }
    };
    return (
      <Modal open onClose={onClose} size="xl" title={`Receive processed fabric — ${o.fpo_no}`}
        footer={<>
          <span className="mr-auto self-center text-xs text-slate-600">Receiving <b>{fmtDecimal(kg, 3)}</b> KG · pending before this <b>{fmtDecimal(pendKg, 3)}</b> KG</span>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={saving} onClick={save}><PackageCheck size={13} className="mr-1" /> Post to store</Button>
        </>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Input label="Receipt date" type="date" value={head.receipt_date} onChange={(e) => setHead({ ...head, receipt_date: e.target.value })} />
          <Input label="Processor DC no *" value={head.party_dc_no} onChange={(e) => setHead({ ...head, party_dc_no: e.target.value })} />
          <Select label="Receiving store *" value={head.warehouse_id} onChange={(e) => setHead({ ...head, warehouse_id: e.target.value })} options={toOptions(warehouses)} />
          <Input label="Colour" value={head.color_name} onChange={(e) => setHead({ ...head, color_name: e.target.value })} />
          <Input label="Vehicle no" value={head.vehicle_no} onChange={(e) => setHead({ ...head, vehicle_no: e.target.value })} />
        </div>
        <table className="mt-3 w-full text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr>{['#', 'Roll no (blank = auto)', 'KG *', 'Metres', 'Dia', 'GSM', 'Shrink L %', 'Shrink W %', 'QC', ''].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-2 py-1 text-slate-400">{i + 1}</td>
                <td className="px-1 py-1"><input className="input py-0.5 text-xs" value={r.roll_no} onChange={(e) => set(i, { roll_no: e.target.value })} /></td>
                <td className="px-1 py-1"><input type="number" step="0.001" className="input w-24 py-0.5 text-right text-xs" value={r.weight_kg} onChange={(e) => set(i, { weight_kg: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                <td className="px-1 py-1"><input type="number" step="0.01" className="input w-24 py-0.5 text-right text-xs" value={r.meters} onChange={(e) => set(i, { meters: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                <td className="px-1 py-1"><input className="input w-20 py-0.5 text-xs" value={r.dia} onChange={(e) => set(i, { dia: e.target.value })} /></td>
                <td className="px-1 py-1"><input className="input w-20 py-0.5 text-xs" value={r.gsm} onChange={(e) => set(i, { gsm: e.target.value })} /></td>
                <td className="px-1 py-1"><input type="number" step="0.1" className="input w-16 py-0.5 text-right text-xs" value={r.shrinkage_length_pct} onChange={(e) => set(i, { shrinkage_length_pct: Number(e.target.value) })} /></td>
                <td className="px-1 py-1"><input type="number" step="0.1" className="input w-16 py-0.5 text-right text-xs" value={r.shrinkage_width_pct} onChange={(e) => set(i, { shrinkage_width_pct: Number(e.target.value) })} /></td>
                <td className="px-1 py-1"><select className="input py-0.5 text-xs" value={r.qc_status} onChange={(e) => set(i, { qc_status: e.target.value })}>{['ACCEPTED', 'HOLD', 'REJECTED'].map((q) => <option key={q}>{q}</option>)}</select></td>
                <td className="px-1 py-1"><button className="p-1 text-slate-400 hover:text-red-600" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}><Trash2 size={13} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex items-center justify-between">
          <Button size="sm" variant="secondary" onClick={() => setRows((rs) => [...rs, blank()])}><Plus size={13} className="mr-1" /> Add roll</Button>
          <Checkbox label="Complete the DC (any KG still pending is process loss)" checked={head.complete} onChange={(v) => setHead({ ...head, complete: v })} />
        </div>
      </Modal>
    );
  }

