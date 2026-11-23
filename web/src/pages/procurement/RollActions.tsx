import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Plus, Printer, Scissors, Trash2 } from 'lucide-react';
import { http } from '../../lib/api';
import { Button, FormSection, Input, Modal, Select, useDebounced } from '../../components/ui';
import { useToast } from '../../hooks/useToast';
import { errText } from '../production/fabricProcess/shared';
import { printRollLabels, ROLL_LABEL_LAYOUTS } from './rollLabels';

/**
 * Fabric roll actions (client doc "Fabric Roll Management", voice note 23-Nov-2026):
 *   RollSplitModal     cut a roll into 2+ pieces — every piece a roll of its own, KG conserved, loss never silent
 *   RollTransferModal  move rolls to another store / bin
 *   RollLabelModal     print labels (first print / reprint with reason)
 */

const n = (v: unknown) => Number(v ?? 0) || 0;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const kg = (v: unknown) => r3(n(v)).toFixed(3);

export const SPLIT_REASON_LABEL: Record<string, string> = {
  PROCESS_ISSUE: 'Part for a process (dyeing, compacting …)',
  CONTRACTOR_ISSUE: 'Part for a contractor / job work',
  CUTTING: 'Part for cutting',
  DAMAGE_REMOVAL: 'Remove a damaged part',
  STORE_TRANSFER: 'Part to keep in another store',
  QC_SEPARATION: 'Separate a QC-hold part',
  OTHER: 'Other',
  AUTO_DC: 'Cut on a DC (automatic)',
};
export const OUTPUT_LABEL: Record<string, string> = { STORE: 'In store (available)', ISSUE: 'Sent on DC', QC_HOLD: 'QC hold', DAMAGE: 'Damaged / rejected' };

interface Piece { kg: string; meters: string; output_type: string; warehouse_id: string; location_bin: string; remarks: string }
const blank = (kgv = '', wh = ''): Piece => ({ kg: kgv, meters: '', output_type: 'STORE', warehouse_id: wh, location_bin: '', remarks: '' });

function useWarehouses() {
  return useQuery({ queryKey: ['lookup-warehouses'], staleTime: 300_000,
    queryFn: async () => (await http.get<{ data: { id: number; code: string; label: string }[] }>('/lookups/warehouses')).data ?? [] });
}

// ------------------------------------------------------------------ split

export function RollSplitModal({ rollId, open, onClose, onDone }: { rollId: number | null; open: boolean; onClose: () => void; onDone?: (r: any) => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const whs = useWarehouses();
  const info = useQuery({ queryKey: ['roll-split-info', rollId], enabled: open && !!rollId,
    queryFn: async () => (await http.get<{ data: any }>(`/inventory/fabric-rolls/${rollId}/split-info`)).data });
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [reason, setReason] = useState('PROCESS_ISSUE');
  const [source, setSource] = useState('WEIGHING_SCALE');
  const [remarks, setRemarks] = useState('');
  const [cutKg, setCutKg] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any | null>(null);
  const [labelsFor, setLabelsFor] = useState<number[] | null>(null);
  const left = n(info.data?.left_kg);
  const parentWh = info.data?.roll?.warehouse_id ? String(info.data.roll.warehouse_id) : '';

  useEffect(() => {
    if (!open) { setDone(null); setPieces([]); setRemarks(''); setCutKg(''); return; }
    if (info.data && !pieces.length) {
      const half = r3(left / 2);
      setPieces([blank(String(half), parentWh), blank(String(r3(left - half)), parentWh)]);
    }
  }, [open, info.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = useMemo(() => ({
    reason_code: reason, measurement_source: source, remarks: remarks.trim() || null,
    pieces: pieces.map((p) => ({ kg: n(p.kg), meters: p.meters.trim() ? n(p.meters) : null, output_type: p.output_type,
      warehouse_id: p.warehouse_id ? Number(p.warehouse_id) : null, location_bin: p.location_bin.trim() || null, remarks: p.remarks.trim() || null })),
  }), [pieces, reason, source, remarks]);
  const dBody = useDebounced(body, 400);
  const total = r3(pieces.reduce((a, p) => a + n(p.kg), 0));
  const loss = r3(left - total);
  const ready = open && !!rollId && pieces.length >= 2 && pieces.every((p) => n(p.kg) > 0) && !done;
  const preview = useQuery({ queryKey: ['roll-split-preview', rollId, dBody], enabled: ready, retry: false,
    queryFn: async () => (await http.post<{ data: any }>(`/inventory/fabric-rolls/${rollId}/split-preview`, dBody)).data });
  const pv = preview.data;

  const setP = (i: number, k: keyof Piece, v: string) => setPieces(pieces.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const equal = (count: number) => {
    const each = Math.floor(left / count * 1000) / 1000;
    setPieces(Array.from({ length: count }, (_, i) => ({ ...(pieces[i] ?? blank('', parentWh)), kg: String(i === count - 1 ? r3(left - each * (count - 1)) : each) })));
  };
  const cutOff = () => {
    const c = n(cutKg);
    if (!(c > 0 && c < left)) { toast(`Enter a KG between 0 and ${kg(left)}`, 'error'); return; }
    setPieces([{ ...blank(String(r3(c)), parentWh), remarks: 'Cut piece' }, { ...blank(String(r3(left - c)), parentWh), remarks: 'Left in store' }]);
  };
  const fillLast = () => {
    if (pieces.length < 2) return;
    const others = r3(pieces.slice(0, -1).reduce((a, p) => a + n(p.kg), 0));
    setP(pieces.length - 1, 'kg', String(r3(Math.max(0, left - others))));
  };

  const post = async () => {
    setBusy(true);
    try {
      const r = await http.post<any>(`/inventory/fabric-rolls/${rollId}/split`, body);
      toast(r.message, 'success');
      setDone(r.data);
      void qc.invalidateQueries();
      onDone?.(r.data);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };

  const r = info.data?.roll;
  const res = info.data?.reservations;
  const waits = !!pv?.will_wait_for_approval;
  return (
    <>
      <Modal open={open} onClose={onClose} size="xl" icon={<Scissors size={16} />}
        title={done ? `Roll cut — ${done.split_no}` : `Cut roll ${r?.roll_no ?? ''}`}
        subtitle={done ? undefined : 'Each piece becomes a roll of its own (new roll no + label). The roll is closed as SPLIT and stays in the genealogy; the KG is not issued — stock stays the same.'}
        footerStart={!done && info.data ? <span className="text-caption">
          Roll <b>{kg(left)} KG</b> · pieces <b>{kg(total)} KG</b>
          {Math.abs(loss) > 0.0005 && <> · <span className={loss < 0 ? 'text-red-700' : 'text-amber-700'}>{loss < 0 ? 'over by' : 'cutting loss'} <b>{kg(Math.abs(loss))} KG</b></span></>}
          {' '}· tolerance {kg(info.data.tolerance.effective_kg)} KG
        </span> : undefined}
        footer={done ? <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {done.status === 'POSTED' && <Button onClick={() => setLabelsFor(done.children.map((c: any) => c.id))} id="split-print-labels"><Printer size={14} /> Print piece labels</Button>}
        </> : <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={post} loading={busy} id="btn-roll-split" disabled={!pv || !pv.can_post || preview.isFetching}>
            {waits ? 'Send for approval' : 'Cut roll'}
          </Button>
        </>}>
        {info.isLoading && <p className="text-body text-ink-muted">Loading roll…</p>}
        {info.error && <p className="text-body text-red-700">{errText(info.error)}</p>}
        {done && (
          <div className="space-y-3 text-body" id="split-result">
            {done.status === 'POSTED' ? <>
              <p><b>{done.parent_roll_no}</b> is now <b>SPLIT</b>. New rolls:</p>
              <table className="w-full text-xs"><thead className="bg-surface-muted text-ink-secondary"><tr>{['Piece', 'New roll no', 'KG', 'Type'].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                <tbody>{done.children.map((c: any) => <tr key={c.id} className="border-t border-surface-divider" data-child={c.roll_no}><td className="px-2 py-1">{c.line_no}</td><td className="px-2 py-1 font-semibold tabular-nums">{c.roll_no}</td>
                  <td className="px-2 py-1 tabular-nums">{kg(c.weight_kg)}</td><td className="px-2 py-1">{OUTPUT_LABEL[c.output_type] ?? c.output_type}</td></tr>)}</tbody></table>
              {n(done.variance_kg) > 0 && <p className="text-amber-700">Cutting loss {kg(done.variance_kg)} KG booked out of stock.</p>}
            </> : <p className="text-amber-800">The cutting loss is above tolerance, so <b>{done.split_no}</b> is waiting for a store supervisor's approval. The roll is unchanged until then (Fabric Roll Cutting → Approvals).</p>}
          </div>
        )}
        {!done && r && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-surface-muted p-3 text-caption md:grid-cols-4">
              <div>Fabric: <b>{r.fabric_name}</b></div><div>Lot / shade: <b>{[r.lot_no, r.shade || r.color_name].filter(Boolean).join(' / ') || '—'}</b></div>
              <div>GSM / Dia: <b>{r.gsm ?? '—'} / {r.dia ?? '—'}</b></div><div>Job: <b>{r.job_no ?? 'General'}</b></div>
              <div>Store: <b>{r.warehouse_name ?? '—'}{r.location_bin ? ` / ${r.location_bin}` : ''}</b></div><div>GRN: <b>{r.grn_no}</b></div>
              <div>Roll KG: <b>{kg(r.weight_kg)}</b>{n(r.issued_kg) > 0 && <> · issued {kg(r.issued_kg)}</>}</div><div>KG to cut: <b id="split-left">{kg(left)}</b></div>
            </div>
            {(res?.lays?.length > 0 || res?.quotes?.length > 0) && (
              <p className="rounded bg-sky-50 px-3 py-2 text-caption text-sky-900">
                Reserved on this roll: {[...res.lays.map((l: any) => `${kg(l.alloc_kg)} KG for lay ${l.lay_no}`), ...res.quotes.map((q: any) => `${kg(q.open_kg)} KG on quotation ${q.quotation_no}`)].join('; ')}.
                {' '}The reservation moves to a store piece big enough to hold it.
              </p>)}
            {(res?.drafts?.length > 0 || res?.pending?.length > 0) && (
              <p className="rounded bg-red-50 px-3 py-2 text-caption text-red-800">
                {res.drafts.length > 0 && <>On draft process DC {res.drafts.join(', ')} — confirm or remove it first. </>}
                {res.pending.length > 0 && <>Split {res.pending.join(', ')} is already waiting for approval.</>}
              </p>)}
            <FormSection title="Why" cols={4}>
              <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} id="split-reason-code"
                options={(info.data.reasons as string[]).map((x) => ({ value: x, label: SPLIT_REASON_LABEL[x] ?? x }))} />
              <Select label="Weighed on" value={source} onChange={(e) => setSource(e.target.value)} id="split-source"
                options={[{ value: 'WEIGHING_SCALE', label: 'Weighing scale' }, { value: 'MANUAL', label: 'Manual estimate' }]} />
              <Input label="Remarks" className="md:col-span-2" value={remarks} onChange={(e) => setRemarks(e.target.value)} id="split-remarks" placeholder="e.g. 25 KG for compacting" />
            </FormSection>
            <FormSection title="Pieces" cols={1} actions={<div className="flex flex-wrap items-end gap-2">
              <Input label="Cut off KG" className="w-28" inputMode="decimal" value={cutKg} onChange={(e) => setCutKg(e.target.value)} id="split-cut-kg" />
              <Button size="sm" variant="secondary" onClick={cutOff} id="btn-split-cutoff">Cut off</Button>
              <Button size="sm" variant="secondary" onClick={() => equal(2)}>2 equal</Button>
              <Button size="sm" variant="secondary" onClick={() => equal(3)}>3 equal</Button>
            </div>}>
              <table className="w-full text-xs" id="split-pieces">
                <thead className="bg-surface-muted text-ink-secondary"><tr>{['#', 'KG *', 'Measured meter', 'Piece goes to', 'Store', 'Bin', 'Note', ''].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                <tbody>
                  {pieces.map((p, i) => (
                    <tr key={i} className="border-t border-surface-divider align-top">
                      <td className="px-2 py-1.5">{i + 1}</td>
                      <td className="px-2 py-1"><input className="input w-24 text-right" inputMode="decimal" value={p.kg} id={`split-kg-${i}`} onChange={(e) => setP(i, 'kg', e.target.value)} /></td>
                      <td className="px-2 py-1"><input className="input w-24 text-right" inputMode="decimal" value={p.meters} placeholder="optional" id={`split-m-${i}`} onChange={(e) => setP(i, 'meters', e.target.value)} /></td>
                      <td className="px-2 py-1"><select className="input" data-native-select value={p.output_type} id={`split-type-${i}`} onChange={(e) => setP(i, 'output_type', e.target.value)}>
                        {(info.data.output_types as string[]).map((t) => <option key={t} value={t}>{OUTPUT_LABEL[t] ?? t}</option>)}</select></td>
                      <td className="px-2 py-1"><select className="input" data-native-select value={p.warehouse_id} id={`split-wh-${i}`} onChange={(e) => setP(i, 'warehouse_id', e.target.value)}>
                        {(whs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</select></td>
                      <td className="px-2 py-1"><input className="input w-24" value={p.location_bin} onChange={(e) => setP(i, 'location_bin', e.target.value)} /></td>
                      <td className="px-2 py-1"><input className="input w-36" value={p.remarks} onChange={(e) => setP(i, 'remarks', e.target.value)} />
                        {pv?.pieces?.[i]?.carries?.length > 0 && <div className="mt-0.5 text-micro text-sky-800">Carries {pv.pieces[i].carries.join(', ')}</div>}</td>
                      <td className="px-2 py-1.5">{pieces.length > 2 && <button title="Remove piece" className="text-ink-muted hover:text-red-600" onClick={() => setPieces(pieces.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}</td>
                    </tr>))}
                </tbody>
              </table>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setPieces([...pieces, blank('', parentWh)])} disabled={pieces.length >= 20}><Plus size={13} /> Piece</Button>
                <Button size="sm" variant="secondary" onClick={fillLast}>Last piece = rest of the roll</Button>
              </div>
            </FormSection>
            <div className="space-y-1 text-caption" id="split-preview">
              {preview.isFetching && <p className="text-ink-muted">Checking…</p>}
              {preview.error && <p className="text-red-700">{errText(preview.error)}</p>}
              {pv?.problems?.map((x: string) => <p key={x} className="text-red-700">✗ {x}</p>)}
              {pv?.warnings?.map((x: string) => <p key={x} className="text-amber-700">⚠ {x}</p>)}
              {pv && !pv.problems.length && !pv.warnings.length && <p className="text-emerald-700">✓ Pieces add up to the roll — no loss.</p>}
              {waits && <p className="text-amber-800">You can't approve this loss yourself — it will wait for a store supervisor (Inventory Adjust).</p>}
            </div>
          </div>
        )}
      </Modal>
      <RollLabelModal rollIds={labelsFor} open={!!labelsFor} onClose={() => setLabelsFor(null)} />
    </>
  );
}

// ------------------------------------------------------------------ transfer

export function RollTransferModal({ rolls, open, onClose, onDone }: { rolls: any[]; open: boolean; onClose: () => void; onDone?: () => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const whs = useWarehouses();
  const [wh, setWh] = useState('');
  const [bin, setBin] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setWh(''); setBin(''); setReason(''); } }, [open]);
  const total = r3(rolls.reduce((a, r) => a + n(r.balance_kg), 0));
  const go = async () => {
    setBusy(true);
    try {
      const r = await http.post<any>('/inventory/fabric-rolls/transfer', { roll_ids: rolls.map((x) => x.id), to_warehouse_id: Number(wh), to_location_bin: bin.trim() || null, reason });
      toast(r.message, 'success'); void qc.invalidateQueries(); onDone?.(); onClose();
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} size="md" icon={<ArrowRightLeft size={16} />} title={`Move ${rolls.length} roll(s)`}
      subtitle="The rolls go to another store or bin. Store stock moves with them (transfer out / in); the roll nos stay."
      footerStart={<span className="text-caption">{rolls.length} roll(s) · <b>{kg(total)} KG</b></span>}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={go} loading={busy} disabled={!wh || reason.trim().length < 3} id="btn-roll-transfer">Move rolls</Button></>}>
      <div className="space-y-3">
        <p className="text-caption text-ink-secondary">{rolls.map((r) => `${r.roll_no} (${kg(r.balance_kg)} KG${r.warehouse_name ? `, ${r.warehouse_name}` : ''})`).join(' · ')}</p>
        <FormSection title="To" cols={3}>
          <Select label="Store *" value={wh} onChange={(e) => setWh(e.target.value)} id="transfer-wh" placeholder="— Store —"
            options={(whs.data ?? []).map((w) => ({ value: w.id, label: w.label }))} />
          <Input label="Bin" value={bin} onChange={(e) => setBin(e.target.value)} id="transfer-bin" placeholder="e.g. RACK-02-B" />
          <Input label="Reason *" value={reason} onChange={(e) => setReason(e.target.value)} id="transfer-reason" placeholder="e.g. moved to cutting store" />
        </FormSection>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ labels

export function RollLabelModal({ rollIds, reprint, open, onClose }: { rollIds: number[] | null; reprint?: boolean; open: boolean; onClose: () => void }) {
  const toast = useToast(); const qc = useQueryClient();
  const [layout, setLayout] = useState('A4_2');
  const [reason, setReason] = useState('');
  const [needReason, setNeedReason] = useState(!!reprint);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setReason(''); setNeedReason(!!reprint); } }, [open, reprint]);
  const go = async () => {
    if (!rollIds?.length) return;
    setBusy(true);
    try {
      const r = await http.post<{ data: any[] }>('/inventory/fabric-rolls/labels', { roll_ids: rollIds, reprint_reason: reason.trim() || null });
      printRollLabels(r.data, layout);
      void qc.invalidateQueries({ queryKey: ['fabric-rolls'] });
      onClose();
    } catch (e) {
      const msg = errText(e);
      if (/already printed/i.test(msg)) setNeedReason(true);
      toast(msg, 'error');
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} size="sm" icon={<Printer size={16} />} title={`Print ${rollIds?.length ?? 0} roll label(s)`}
      subtitle="Roll no barcode (Code 128), fabric, lot / shade, GSM / Dia, KG in store. Every print is logged."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={go} loading={busy} id="btn-roll-labels" disabled={needReason && reason.trim().length < 3}>Print</Button></>}>
      <div className="space-y-3">
        <Select label="Label size" value={layout} onChange={(e) => setLayout(e.target.value)} id="label-layout"
          options={Object.entries(ROLL_LABEL_LAYOUTS).map(([k, v]) => ({ value: k, label: v.label }))} />
        {needReason && <Input label="Reprint reason *" value={reason} onChange={(e) => setReason(e.target.value)} id="label-reason" placeholder="e.g. label torn" hint="A roll printed before needs the reason (needs the Inventory Update right)." />}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ family (genealogy of pieces)

/** The original roll and every piece cut / returned / merged from it, indented by generation, with where each one is now. */
export function RollFamilyPanel({ rollId }: { rollId: number }) {
  const fam = useQuery({ queryKey: ['roll-family', rollId], queryFn: async () => (await http.get<{ data: any }>(`/inventory/fabric-rolls/${rollId}/family`)).data });
  if (!fam.data) return null;
  const nodes: any[] = fam.data.nodes ?? [];
  if (nodes.length < 2) return null;
  const depth = new Map<number, number>();
  for (const x of nodes) depth.set(Number(x.id), x.parent_roll_id && depth.has(Number(x.parent_roll_id)) ? depth.get(Number(x.parent_roll_id))! + 1 : 0);
  const ordered: any[] = [];
  const walk = (id: number) => { const x = nodes.find((y) => Number(y.id) === id); if (!x) return; ordered.push(x); nodes.filter((y) => Number(y.parent_roll_id) === id && Number(y.id) !== id).forEach((c) => walk(Number(c.id))); };
  walk(Number(fam.data.root_id));
  const status = (x: any) => (['SPLIT', 'MERGED', 'CLOSED'].includes(x.stock_status) ? x.stock_status.toLowerCase() : n(x.balance_kg) > 0.0005 ? `${kg(x.balance_kg)} KG in store` : 'issued');
  return (
    <div className="card p-4 text-xs" id="roll-family">
      <h3 className="mb-1 text-body font-semibold">Roll pieces (genealogy)</h3>
      <p className="mb-2 text-ink-secondary">{fam.data.pieces_in_store} piece(s) in store · {kg(fam.data.balance_kg)} KG — received {kg(ordered[0]?.original_weight_kg)} KG as {ordered[0]?.roll_no}</p>
      {ordered.map((x) => (
        <div key={x.id} className="flex flex-wrap items-center gap-2 border-t border-surface-divider py-1" style={{ paddingLeft: (depth.get(Number(x.id)) ?? 0) * 18 }} data-family={x.roll_no}>
          <span className="font-semibold tabular-nums">{x.roll_no}</span>
          <span className="text-ink-secondary">{x.roll_origin === 'RECEIPT' ? 'received' : x.roll_origin === 'SPLIT' ? `cut piece${x.split_no ? ` (${x.split_no})` : ''}` : x.roll_origin.toLowerCase()}</span>
          <span className="tabular-nums">{kg(x.original_weight_kg)} KG</span>
          <span className={['SPLIT', 'MERGED'].includes(x.stock_status) ? 'text-violet-700' : n(x.balance_kg) > 0.0005 ? 'text-emerald-700' : 'text-ink-muted'}>→ {status(x)}</span>
          {x.warehouse_name && <span className="text-ink-muted">{x.warehouse_name}</span>}
        </div>))}
    </div>
  );
}

// ------------------------------------------------------------------ mix warning on DCs

/**
 * Warning (never a block) when the rolls picked for one DC mix lots, shades / colours, grey with processed fabric, Dia, or
 * GSM beyond tolerance within the same job + fabric — mixed lots in one dye batch or lay show as shade variation.
 */
export function RollMixWarning({ rollIds, context = 'DC' }: { rollIds: number[]; context?: string }) {
  const ids = useMemo(() => [...new Set(rollIds.filter((x) => x > 0))].sort((a, b) => a - b), [rollIds]);
  const dIds = useDebounced(ids, 400);
  const chk = useQuery({ queryKey: ['roll-mix', dIds], enabled: dIds.length > 1, staleTime: 30_000,
    queryFn: async () => (await http.post<{ data: any }>('/inventory/fabric-rolls/mix-check', { roll_ids: dIds })).data });
  if (ids.length < 2 || !chk.data || chk.data.ok) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-caption text-amber-900" id="roll-mix-warning" role="alert">
      <b>⚠ Check before sending — these rolls on one {context} are not alike:</b>
      {chk.data.groups.map((g: any, i: number) => (
        <div key={i} className="mt-1">
          <span className="font-semibold">{g.job_no} · {g.fabric_name}</span> ({g.rolls} rolls):{' '}
          {g.issues.map((x: any) => <span key={x.kind} data-mix={x.kind} className="mr-2">{x.text};</span>)}
        </div>))}
      <div className="mt-1 text-amber-800">Mixed lots / shades in one dye batch or lay show up as shade variation in the garments. You can still save if this is intended.</div>
    </div>
  );
}
