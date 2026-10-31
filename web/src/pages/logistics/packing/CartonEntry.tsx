import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Printer, ScanLine, Pencil, Wand2, Save, ShieldCheck, Send, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { PageHeader, Card, Button, LoadingBlock, EmptyState, Modal, FormSection, Input, Select } from '../../../components/ui';
import { http } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useToast } from '../../../hooks/useToast';
import { fmtNumber } from '../../../lib/format';
import { PackingNav, PkStatus, OrderPicker, useOrder, usePackingMeta, CartonEditor, ReasonModal, printCartonLabel, errMsg, n, Stat, type Order, type CartonRow } from './packingShared';

type Dims = { net: string; gross: string; l: string; w: string; h: string };
const DIM_KEYS: [keyof Dims, keyof CartonRow, string][] = [
  ['net', 'net_weight_kg', 'Net kg'], ['gross', 'gross_weight_kg', 'Gross kg'], ['l', 'length_cm', 'L cm'], ['w', 'width_cm', 'W cm'], ['h', 'height_cm', 'H cm'],
];
const str = (v: unknown) => (v == null || v === '' ? '' : String(Number(v)));
/** "Black/S:2, Black/M:4" → "Black · S2 M4" (one short line per colour, so 100 cartons stay readable). */
const shortContents = (v: string | null) => {
  if (!v) return '';
  const by = new Map<string, string[]>();
  for (const part of v.split(', ')) {
    const m = /^(.*)\/([^/:]+):(\d+)$/.exec(part.trim());
    if (!m) return v;
    by.set(m[1], [...(by.get(m[1]) ?? []), `${m[2]}${m[3]}`]);
  }
  return [...by].map(([c, xs]) => `${c} · ${xs.join(' ')}`).join(' | ');
};
const editable = (c: CartonRow) => ['DRAFT', 'OPEN'].includes(c.carton_status) && !n(c.is_posted);

/**
 * Screen C — Carton box entry. Cartons are made one at a time (New carton) or all at once (Generate cartons: every carton
 * the order still needs, in the size ratio / to the carton capacity — client call 21-Oct-2026), then worked as a grid:
 * tick, fill weights / dimensions for many, save, verify + seal, post, or delete the ones not needed.
 */
export function CartonEntryPage() {
  const [sp, setSp] = useSearchParams();
  const orderId = sp.get('order') ? Number(sp.get('order')) : null;
  const order = useOrder(orderId);
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Record<number, Partial<Dims>>>({});
  const [fill, setFill] = useState<Dims>({ net: '', gross: '', l: '', w: '', h: '' });
  const [busy, setBusy] = useState('');
  const [voiding, setVoiding] = useState(false);
  const o = order.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['packing-order', orderId] }); qc.invalidateQueries({ queryKey: ['packing-orders'] }); };
  const openEdit = async (id: number) => {
    try { setEditing((await http.get<{ data: any }>(`/packing/cartons/${id}`)).data); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const cartons = (o?.cartons ?? []);
  const live = cartons.filter((c) => c.carton_status !== 'VOID');
  const working = !!o && ['APPROVED', 'IN_PROGRESS'].includes(o.order_status);
  const valOf = (c: CartonRow, k: keyof Dims, f: keyof CartonRow) => edits[c.id]?.[k] ?? str(c[f]);
  const dirty = useMemo(() => cartons.filter((c) => editable(c) && DIM_KEYS.some(([k, f]) => edits[c.id]?.[k] !== undefined && edits[c.id]![k] !== str(c[f]))), [cartons, edits]);
  const selectable = live.filter((c) => !n(c.is_posted));
  const selected = selectable.filter((c) => sel.has(c.id));   // a carton posted / voided since it was ticked drops out
  const toggle = (id: number) => setSel((x) => { const y = new Set(x); if (y.has(id)) y.delete(id); else y.add(id); return y; });

  const bulk = async (action: string, extra: Record<string, unknown>, done: (d: any) => string) => {
    if (!o) return;
    setBusy(action);
    try {
      const r = await http.post<{ data: any }>(`/packing/orders/${o.id}/cartons/bulk`, { action, ...extra });
      toast(done(r.data)); refresh(); return true;
    } catch (e) { toast(errMsg(e), 'error'); return false; } finally { setBusy(''); }
  };
  const saveAll = async () => {
    const items = dirty.map((c) => {
      const e = edits[c.id] ?? {};
      const out: Record<string, unknown> = { id: c.id };
      for (const [k, f] of DIM_KEYS) if (e[k] !== undefined && e[k] !== str(c[f])) out[f] = e[k] === '' ? null : Number(e[k]);
      return out;
    });
    if (await bulk('save', { items }, (d) => `${d.cartons.length} carton(s) saved`)) setEdits({});
  };
  // draft / open → verify + seal; already verified → seal
  const verifySeal = async () => {
    const open = selected.filter((c) => ['DRAFT', 'OPEN'].includes(c.carton_status)).map((c) => c.id);
    const verified = selected.filter((c) => c.carton_status === 'VERIFIED').map((c) => c.id);
    if (!open.length && !verified.length) { toast('The selected cartons are already sealed', 'warning'); return; }
    if (open.length && !(await bulk('verify_seal', { ids: open }, (d) => `${d.cartons.length} carton(s) verified and sealed`))) return;
    if (verified.length) await bulk('seal', { ids: verified }, (d) => `${d.cartons.length} verified carton(s) sealed`);
  };
  const applyFill = () => {
    const targets = selected.filter(editable);
    if (!targets.length) { toast('Tick the cartons to fill first', 'warning'); return; }
    setEdits((cur) => {
      const next = { ...cur };
      for (const c of targets) { const e = { ...(next[c.id] ?? {}) }; for (const [k] of DIM_KEYS) if (fill[k] !== '') e[k] = fill[k]; next[c.id] = e; }
      return next;
    });
  };

  return (
    <div>
      <PageHeader title="Carton box entry" breadcrumb={['Logistics', 'Packing']}
        subtitle="Make the cartons one by one (New carton) or all at once (Generate cartons), then fill weights, verify, seal and post — for many cartons together."
        actions={working && can('PACKING.CREATE') && <div className="flex gap-2">
          <Button id="gen-cartons" variant="secondary" onClick={() => setGenerating(true)}><Wand2 size={15} />Generate cartons</Button>
          <Button id="new-carton" onClick={() => setEditing('new')}><Plus size={15} />New carton</Button>
        </div>} />
      <PackingNav active="/logistics/packing/cartons" />
      <Card className="mb-4"><div className="grid items-end gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,420px)_1fr]">
        <OrderPicker value={orderId} onChange={(v) => { setSel(new Set()); setEdits({}); setSp(v ? { order: String(v) } : {}); }} />
        {o && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Planned" value={fmtNumber(o.planned_qty)} hint={`${o.planned_cartons} cartons`} />
          <Stat label="In cartons" value={fmtNumber(n(o.pieces_posted) + n(o.pieces_unposted))} hint={`${live.length} cartons`} />
          <Stat label="Posted" value={fmtNumber(o.pieces_posted)} tone="green" />
          <Stat label="Can add" value={fmtNumber((o.lines ?? []).reduce((a, l) => a + l.available, 0))} />
        </div>}
      </div></Card>
      {!orderId ? <EmptyState title="Pick a packing order" message="Cartons are packed against an approved packing order." /> : order.isLoading ? <LoadingBlock /> : (
        <Card>
          {!cartons.length ? <EmptyState title="No cartons yet" message="Use Generate cartons to make every carton the order needs at once, or New carton for one." /> : (
            <>
              {/* bulk bar: fill weights / dimensions for the ticked cartons, save, verify + seal, post, delete */}
              <div className="flex flex-wrap items-end gap-2 border-b border-surface-border p-3 text-body" id="bulk-bar">
                <span className="mr-1 self-center text-slate-600"><b>{selected.length}</b> selected</span>
                {DIM_KEYS.map(([k, , label]) => (
                  <label key={k} className="flex flex-col text-caption text-slate-500">{label}
                    <input className="input !h-8 w-20 text-right" inputMode="decimal" id={`fill-${k}`} value={fill[k]} onChange={(e) => setFill({ ...fill, [k]: e.target.value.replace(/[^0-9.]/g, '') })} /></label>
                ))}
                <Button size="sm" variant="secondary" id="fill-apply" disabled={!selected.length} onClick={applyFill}>Fill selected</Button>
                <span className="mx-1 h-6 w-px self-center bg-slate-200" />
                <Button size="sm" id="bulk-save" disabled={!dirty.length} loading={busy === 'save'} onClick={saveAll}><Save size={13} />Save changes{dirty.length ? ` (${dirty.length})` : ''}</Button>
                {can('PACKING.UPDATE') && <>
                  <Button size="sm" variant="secondary" id="bulk-verify-seal" disabled={!selected.length || !!dirty.length} loading={busy === 'verify_seal'}
                    title={dirty.length ? 'Save the changes first' : ''}
                    onClick={verifySeal}>
                    <ShieldCheck size={13} />Verify &amp; seal</Button>
                  <Button size="sm" variant="secondary" id="bulk-post" disabled={!selected.length || !!dirty.length} loading={busy === 'post'}
                    onClick={() => bulk('post', { ids: selected.map((c) => c.id) }, (d) => `${d.posted} carton(s) posted${d.skipped ? `, ${d.skipped} skipped` : ''}`)}><Send size={13} />Post</Button>
                </>}
                <Button size="sm" variant="danger" id="bulk-void" disabled={!selected.length} onClick={() => setVoiding(true)}><Trash2 size={13} />Delete</Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-body" id="carton-list">
                  <thead><tr>
                    <th className="th w-8"><input type="checkbox" id="sel-all" checked={!!selectable.length && selectable.every((c) => sel.has(c.id))}
                      onChange={(e) => setSel(e.target.checked ? new Set(selectable.map((c) => c.id)) : new Set())} /></th>
                    <th className="th">#</th><th className="th">Carton no</th><th className="th">Contents</th><th className="th text-right">Pcs</th><th className="th text-right">Polybags (std)</th>
                    {DIM_KEYS.map(([k, , label]) => <th key={k} className="th text-right">{label}</th>)}
                    <th className="th">Status</th><th className="th" /></tr></thead>
                  <tbody>{cartons.map((c) => {
                    const ed = editable(c);
                    return (
                      <tr key={c.id} className={clsx(c.carton_status === 'VOID' && 'opacity-50', sel.has(c.id) && 'bg-brand-50/40')} data-row={c.carton_no}>
                        <td className="td">{c.carton_status !== 'VOID' && !n(c.is_posted) && <input type="checkbox" data-sel={c.carton_no} checked={sel.has(c.id)} onChange={() => toggle(c.id)} />}</td>
                        <td className="td">{c.carton_seq}</td>
                        <td className="td tabular-nums">{c.carton_no}{c.pl_plan_no && <div className="font-sans text-caption text-blue-700" data-plan-ctn={c.carton_no}>{c.pl_plan_no} · ctn {c.pl_ctn_no}</div>}</td>
                        <td className="td whitespace-nowrap" title={c.contents ?? ''}>{shortContents(c.contents)}</td>
                        <td className="td text-right">{c.pieces_total}{n(c.is_partial) ? <span className="ml-1 text-caption text-amber-700">partial</span> : null}</td>
                        <td className="td text-right">{c.polybag_qty} <span className="text-slate-400">({c.std_polybag_qty})</span></td>
                        {DIM_KEYS.map(([k, f]) => (
                          <td key={k} className="td w-20 text-right">{ed
                            ? <input className={clsx('input !h-7 w-20 text-right', edits[c.id]?.[k] !== undefined && edits[c.id]![k] !== str(c[f]) && '!border-amber-400 !bg-amber-50')}
                                inputMode="decimal" data-dim={`${k}-${c.carton_no}`} value={valOf(c, k, f)}
                                onChange={(e) => setEdits((x) => ({ ...x, [c.id]: { ...(x[c.id] ?? {}), [k]: e.target.value.replace(/[^0-9.]/g, '') } }))} />
                            : (c[f] == null ? '—' : String(c[f]))}</td>
                        ))}
                        <td className="td"><PkStatus value={c.carton_status} posted={c.is_posted} /></td>
                        <td className="td whitespace-nowrap text-right">
                          {ed && can('PACKING.UPDATE') &&
                            <button className="mr-2 inline-flex items-center gap-1 text-slate-600 hover:underline" data-edit={c.carton_no} onClick={() => openEdit(c.id)}><Pencil size={13} />Edit</button>}
                          <Link className="mr-2 inline-flex items-center gap-1 text-brand-700 hover:underline" to={`/logistics/packing/verify?code=${encodeURIComponent(c.carton_no)}`}><ScanLine size={13} />Verify</Link>
                          {c.carton_status !== 'VOID' && <button className="inline-flex items-center gap-1 text-slate-600 hover:underline" onClick={() => printCartonLabel(c.id)}><Printer size={13} />Label</button>}
                        </td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}
      {editing && o && <CartonEditor order={o} carton={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
        onSaved={(c) => { setEditing(null); toast(`Carton ${c.carton_no} saved (${c.carton_status})`); refresh(); }} />}
      {generating && o && <GenerateModal order={o} onClose={() => setGenerating(false)}
        onDone={(k) => { setGenerating(false); toast(`${k} carton(s) made — fill the weights, then verify & seal`); refresh(); }} />}
      <ReasonModal open={voiding} title={`Delete ${selected.length} carton(s)`} subtitle="The cartons are voided — their numbers are never reused. A verified / sealed carton needs a supervisor."
        confirm="Delete cartons" danger busy={busy === 'void'} onClose={() => setVoiding(false)}
        onSubmit={async (reason) => { if (await bulk('void', { ids: selected.map((c) => c.id), reason }, (d) => `${d.cartons.length} carton(s) deleted`)) { setVoiding(false); setSel(new Set()); } }} />
    </div>
  );
}

/** Generate cartons: preview every carton the order still needs (size ratio / capacity), then make them all as drafts. */
function GenerateModal({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: (count: number) => void }) {
  const meta = usePackingMeta();
  const toast = useToast();
  const rule = order.rule!;
  const colours = [...new Map((order.lines ?? []).filter((l) => l.planned > 0).map((l) => [l.color_id, l.color_name])).entries()];
  const [f, setF] = useState({ color_id: '', carton_trim_id: String(rule.carton_trim_id ?? ''), polybag_trim_id: String(rule.polybag_trim_id ?? ''),
    net_weight_kg: '', gross_weight_kg: '', length_cm: '', width_cm: '', height_cm: '' });
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const num = (v: string) => (v === '' ? null : Number(v));
  const body = () => ({ color_id: num(f.color_id), carton_trim_id: num(f.carton_trim_id), polybag_trim_id: num(f.polybag_trim_id),
    net_weight_kg: num(f.net_weight_kg), gross_weight_kg: num(f.gross_weight_kg), length_cm: num(f.length_cm), width_cm: num(f.width_cm), height_cm: num(f.height_cm) });
  const run = async (doPreview: boolean) => {
    setErr(''); setBusy(true);
    try {
      const r = await http.post<{ data: any }>(`/packing/orders/${order.id}/cartons/generate`, { ...body(), preview: doPreview });
      if (doPreview) setPreview(r.data); else onDone(r.data.created.length);
    } catch (e) { setErr(errMsg(e)); if (!doPreview) toast(errMsg(e), 'error'); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: any) => { setF((x) => ({ ...x, [k]: e.target.value })); if (k === 'color_id') setPreview(null); };
  const trims = meta.data?.trims ?? [];
  const ratio = order.size_ratio ?? [];
  return (
    <Modal open onClose={onClose} size="xl" icon={<Wand2 size={16} />} title={`Generate cartons · ${order.pack_no}`}
      subtitle={`${rule.standard_pieces_per_carton} pcs / carton${ratio.length ? ` · size ratio ${ratio.map((x) => `${x.size_code} ${x.per_carton}`).join(' · ')}` : ''} — made from what can go into a carton now${order.packing_mode === 'INDIVIDUAL_PIECE' ? ' (bagged pieces)' : ''}`}
      footerStart={preview && <span id="gen-summary"><b>{preview.cartons.length}</b> carton(s): {preview.full} full + {preview.partial} partial · <b>{fmtNumber(preview.pieces)}</b> pcs
        {preview.more ? <span className="text-amber-700"> · {preview.more} more after these</span> : null}</span>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" id="gen-preview" loading={busy && !preview} onClick={() => run(true)}>Preview</Button>
        <Button id="gen-create" loading={busy && !!preview} disabled={!preview?.cartons?.length} onClick={() => run(false)}>Make {preview?.cartons?.length ?? ''} cartons</Button>
      </>}>
      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-body text-red-700" id="gen-error">{err}</div>}
      <FormSection title="What to make" cols={3}>
        <Select id="gen-colour" label="Colour" value={f.color_id} onChange={set('color_id')} placeholder="All colours" options={colours.map(([c, name]) => ({ value: c, label: name }))} />
        <Select label="Carton type" value={f.carton_trim_id} onChange={set('carton_trim_id')} placeholder="— Carton item —"
          options={trims.filter((t) => t.trim_type === 'CARTON').map((t) => ({ value: t.id, label: `${t.trim_name} (stock ${fmtNumber(t.stock_qty)})` }))} />
        <Select label="Polybag type" value={f.polybag_trim_id} onChange={set('polybag_trim_id')} placeholder="— Polybag item —"
          options={trims.filter((t) => t.trim_type === 'POLYBAG').map((t) => ({ value: t.id, label: `${t.trim_name} (stock ${fmtNumber(t.stock_qty)})` }))} />
      </FormSection>
      <FormSection title="Same for every carton (optional — can be changed per carton after)" cols={3}>
        <Input id="gen-net" label="Net kg" inputMode="decimal" value={f.net_weight_kg} onChange={set('net_weight_kg')} />
        <Input id="gen-gross" label="Gross kg" inputMode="decimal" value={f.gross_weight_kg} onChange={set('gross_weight_kg')} />
        <Input label="Length cm" inputMode="decimal" value={f.length_cm} onChange={set('length_cm')} />
        <Input label="Width cm" inputMode="decimal" value={f.width_cm} onChange={set('width_cm')} />
        <Input label="Height cm" inputMode="decimal" value={f.height_cm} onChange={set('height_cm')} />
      </FormSection>
      {preview && (!preview.cartons.length
        ? <EmptyState title="Nothing to put in cartons" message={order.packing_mode === 'INDIVIDUAL_PIECE' ? 'Every bagged piece is already in a carton — bag more on the Polybag screen.' : 'The planned pieces are already in cartons.'} />
        : <div className="max-h-80 overflow-auto"><table className="w-full text-body" id="gen-table">
            <thead><tr><th className="th">#</th><th className="th">Contents</th><th className="th text-right">Pcs</th><th className="th" /></tr></thead>
            <tbody>{preview.cartons.map((c: any) => (
              <tr key={c.seq}><td className="td">{c.seq}</td><td className="td">{c.lines.map((l: any) => `${l.color_name} ${l.size_code} ${l.qty}`).join(' · ')}</td>
                <td className="td text-right">{c.total}</td><td className="td">{c.partial ? <span className="text-caption text-amber-700">partial</span> : <span className="text-caption text-emerald-700">full</span>}</td></tr>
            ))}</tbody>
          </table></div>)}
      {preview?.skipped_not_in_ratio > 0 && <p className="mt-2 text-small text-amber-700">{preview.skipped_not_in_ratio} pcs are of sizes not in the size ratio — pack them with New carton.</p>}
    </Modal>
  );
}
