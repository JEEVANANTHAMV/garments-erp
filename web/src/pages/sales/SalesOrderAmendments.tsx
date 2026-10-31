import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FilePlus2, FileMinus2, Plus, Trash2, Layers, RefreshCw, Ban, Lock, ChevronDown, ChevronRight } from 'lucide-react';
import { http, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../hooks/useToast';
import { useStyleSkus, type StyleSku } from '../../hooks/useLookup';
import { Modal, FormSection, Input, Select, Textarea, Button, Badge, LoadingBlock, EmptyState } from '../../components/ui';
import { fmtDate, fmtNumber, today } from '../../lib/format';

/* Sales order amendments (client call 14-Oct): additional / cancelled quantity on a running order,
 * the materials it needs, and order closure (cancel / short close / complete). */

export interface SoLineLite {
  id: number; style_id: number; style_code: string; style_name?: string; color_id: number | null; color_name?: string | null;
  order_qty: number; cancelled_qty?: number; is_additional?: number; amendment_no?: string | null;
  /** set entry lines (client 29-Oct-2026): one line per part, linked by set_group */
  part_name?: string | null; set_group?: string | null; qty_per_set?: number | null; set_rate?: number | string | null; set_color_map?: any;
  skus: { sku_id: number; qty: number; color_id: number; size_id: number; size_code: string; color_name: string; sort_order: number }[];
}

const err = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

/* ============================================================ AMEND MODAL */

interface AddRow { key: string; style_id: number | ''; color_id: number | ''; qty: Record<number, number | ''> }
let rowSeq = 0;

/**
 * The set entry of a style on the order (its first part's line = the set colour), if the style was ordered in sets:
 * additional quantity of it is added in SETS at the same rate and contrast colours (client 29-Oct-2026).
 */
function setOfStyle(lines: SoLineLite[], styleId: number | '', colorId: number | '') {
  const leads = lines.filter((l) => l.style_id === styleId && l.set_group && !lines.some((x) => x.set_group === l.set_group && x.id < l.id));
  if (!leads.length) return null;
  const lead = leads.find((l) => l.skus.some((k) => k.color_id === colorId)) ?? leads[0];
  const group = lines.filter((x) => x.set_group === lead.set_group);
  const color_map: Record<string, Record<string, number>> = {};
  for (const g of group) {
    const m = typeof g.set_color_map === 'string' ? JSON.parse(g.set_color_map) : g.set_color_map;
    if (m && Object.keys(m).length && g.part_name) color_map[g.part_name] = m;
  }
  return { rate: Number(lead.set_rate) || 0, color_map, label: group.map((g) => `${Number(g.qty_per_set) > 1 ? `${g.qty_per_set} ` : ''}${g.part_name}`).join(' + ') };
}

export function AmendOrderModal({ soId, soNo, lines, initialMode = 'ADDITIONAL', onClose, onPosted }: {
  soId: number; soNo: string; lines: SoLineLite[]; initialMode?: 'ADDITIONAL' | 'CANCEL';
  onClose: () => void; onPosted: (a: { id: number; amendment_no: string; amendment_type: string }) => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<'ADDITIONAL' | 'CANCEL'>(initialMode);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const [buyerRef, setBuyerRef] = useState('');
  const [saving, setSaving] = useState(false);

  // Styles / colours already on the order (additional quantity is normally for them)
  const styleOpts = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of lines) m.set(l.style_id, `${l.style_code}${l.style_name ? ` — ${l.style_name}` : ''}`);
    return [...m].map(([value, label]) => ({ value, label }));
  }, [lines]);
  const firstLine = lines.find((l) => !l.is_additional) ?? lines[0];
  const [rows, setRows] = useState<AddRow[]>(() => [{ key: `r${++rowSeq}`, style_id: firstLine?.style_id ?? '', color_id: firstLine?.color_id ?? '', qty: {} }]);
  // CANCEL: so_line_id|sku_id → qty
  const [cancel, setCancel] = useState<Record<string, number | ''>>({});

  const addTotal = rows.reduce((a, r) => a + Object.values(r.qty).reduce<number>((b, q) => b + (Number(q) || 0), 0), 0);
  const cancelTotal = Object.values(cancel).reduce<number>((a, q) => a + (Number(q) || 0), 0);

  const submit = async () => {
    setSaving(true);
    try {
      let body: any;
      if (mode === 'ADDITIONAL') {
        const ls = rows.filter((r) => r.style_id).map((r) => {
          const set = setOfStyle(lines, r.style_id, r.color_id);
          return {
            // a set entry is sent without a colour (sets span colours) and with its rate / contrast colours
            style_id: Number(r.style_id), color_id: set || r.color_id === '' ? null : Number(r.color_id),
            skus: Object.entries(r.qty).filter(([, q]) => Number(q) > 0).map(([sku_id, q]) => ({ sku_id: Number(sku_id), qty: Number(q) })),
            ...(set ? { set: { rate: set.rate, color_map: set.color_map } } : {}),
          };
        }).filter((l) => l.skus.length);
        if (!ls.length) { toast('Enter the additional quantity in the size grid', 'error'); setSaving(false); return; }
        body = { amendment_type: 'ADDITIONAL', amendment_date: date, reason: reason || null, buyer_ref: buyerRef || null, lines: ls };
      } else {
        const ls = Object.entries(cancel).filter(([, q]) => Number(q) > 0).map(([k, q]) => {
          const [lineId, skuId] = k.split('|');
          return { so_line_id: Number(lineId), sku_id: skuId ? Number(skuId) : null, qty: Number(q) };
        });
        if (!ls.length) { toast('Enter the quantity to cancel', 'error'); setSaving(false); return; }
        if (!reason.trim()) { toast('Give the reason for cancelling the quantity', 'error'); setSaving(false); return; }
        body = { amendment_type: 'CANCEL', amendment_date: date, reason, buyer_ref: buyerRef || null, lines: ls };
      }
      const res = await http.post<{ data: any; message?: string }>(`/sales-orders/${soId}/amendments`, body);
      toast(res.message ?? `Amendment ${res.data.amendment_no} posted`);
      onPosted(res.data);
    } catch (e) {
      toast(err(e, 'Could not post the amendment'), 'error');
    } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} size="full" icon={mode === 'ADDITIONAL' ? <FilePlus2 size={16} /> : <FileMinus2 size={16} />}
      title={`Amend order ${soNo}`}
      subtitle={mode === 'ADDITIONAL'
        ? 'Additional quantity is added as separate lines — the original lines stay as they are'
        : 'Reduce the quantity per colour × size; it cannot go below what is already cut / produced'}
      footerStart={<span id="amend-total" className="text-body text-ink-secondary">
        {mode === 'ADDITIONAL' ? 'Adding' : 'Cancelling'} <strong className="tabular-nums">{fmtNumber(mode === 'ADDITIONAL' ? addTotal : cancelTotal)}</strong>{' '}
        {mode === 'ADDITIONAL' && rows.some((r) => setOfStyle(lines, r.style_id, r.color_id)) ? 'sets' : 'pcs'}
      </span>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="amend-post" variant={mode === 'CANCEL' ? 'danger' : 'primary'} loading={saving} onClick={() => void submit()}>
          {mode === 'ADDITIONAL' ? 'Post additional qty' : 'Post cancellation'}
        </Button>
      </>}>
      <div className="mb-4 inline-flex rounded-lg border border-surface-border p-0.5" role="tablist">
        {(['ADDITIONAL', 'CANCEL'] as const).map((m) => (
          <button key={m} id={`amend-mode-${m.toLowerCase()}`} type="button" onClick={() => setMode(m)}
            className={`rounded-md px-3 py-1.5 text-body font-semibold ${mode === m ? (m === 'CANCEL' ? 'bg-red-600 text-white' : 'bg-brand-600 text-white') : 'text-ink-secondary hover:bg-surface-muted'}`}>
            {m === 'ADDITIONAL' ? 'Add quantity' : 'Cancel quantity'}
          </button>
        ))}
      </div>

      <FormSection title="Amendment" cols={3}>
        <Input label="Amendment date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        <Input label="Buyer reference" placeholder="Mail / revised PO ref" value={buyerRef} onChange={(e) => setBuyerRef(e.target.value)} />
        <Input id="amend-reason" label="Reason" required={mode === 'CANCEL'} placeholder={mode === 'ADDITIONAL' ? 'e.g. Buyer added 500 pcs' : 'e.g. Buyer reduced to 3000'}
          value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormSection>

      {mode === 'ADDITIONAL' ? (
        <FormSection title="Additional quantity (colour × size)" cols={1}
          actions={<Button size="sm" variant="secondary" onClick={() => setRows((s) => [...s, { key: `r${++rowSeq}`, style_id: firstLine?.style_id ?? '', color_id: '', qty: {} }])}>
            <Plus size={13} /> Add style / colour
          </Button>}>
          <div className="space-y-3">
            {rows.map((r) => (
              <AddRowGrid key={r.key} row={r} styleOpts={styleOpts} canRemove={rows.length > 1} set={setOfStyle(lines, r.style_id, r.color_id)}
                onChange={(p) => setRows((s) => s.map((x) => (x.key === r.key ? { ...x, ...p } : x)))}
                onRemove={() => setRows((s) => s.filter((x) => x.key !== r.key))} />
            ))}
          </div>
        </FormSection>
      ) : (
        <FormSection title="Quantity to cancel" cols={1}>
          <CancelGrid lines={lines} value={cancel} onChange={setCancel} />
        </FormSection>
      )}
    </Modal>
  );
}

function AddRowGrid({ row, styleOpts, onChange, onRemove, canRemove, set }: {
  row: AddRow; styleOpts: { value: number; label: string }[]; set?: ReturnType<typeof setOfStyle>;
  onChange: (p: Partial<AddRow>) => void; onRemove: () => void; canRemove: boolean;
}) {
  const skus = useStyleSkus(row.style_id ? Number(row.style_id) : null);
  const colors = useMemo(() => {
    const m = new Map<number, string>();
    for (const k of skus.data ?? []) m.set(k.color_id, k.color_name);
    return [...m].map(([value, label]) => ({ value, label }));
  }, [skus.data]);
  const sizes: StyleSku[] = (skus.data ?? []).filter((k) => row.color_id !== '' && k.color_id === Number(row.color_id))
    .sort((a, b) => a.sort_order - b.sort_order);
  const rowTotal = Object.values(row.qty).reduce<number>((a, q) => a + (Number(q) || 0), 0);
  return (
    <div className="rounded-lg border border-surface-border p-3" data-amend-row>
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-[1fr_1fr_auto] items-end">
        <Select label="Style" required options={styleOpts} placeholder="— Select style —" value={row.style_id}
          onChange={(e) => onChange({ style_id: e.target.value ? Number(e.target.value) : '', color_id: '', qty: {} })} />
        <Select label={set ? 'Set colour' : 'Colour'} required options={colors} placeholder="— Select colour —" value={row.color_id}
          onChange={(e) => onChange({ color_id: e.target.value ? Number(e.target.value) : '', qty: {} })} />
        {canRemove && (
          <button type="button" onClick={onRemove} className="mb-1 rounded-md p-2 text-ink-muted hover:bg-red-50 hover:text-red-600" title="Remove">
            <Trash2 size={15} />
          </button>
        )}
      </div>
      {set && (
        <p className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-small text-indigo-800" data-amend-set>
          Ordered as a set (SET = {set.label}) — enter <strong>sets</strong>; every part is added (pieces = sets × pieces per set) at the set rate and the order's contrast colours.
        </p>
      )}
      {row.color_id !== '' && (
        sizes.length ? (
          <div className="mt-3 overflow-x-auto">
            <table className="text-body">
              <thead><tr>
                {sizes.map((k) => <th key={k.id} className="px-1.5 pb-1 text-center font-semibold text-ink-secondary">{k.size_code}</th>)}
                <th className="px-2 pb-1 text-right font-semibold text-ink-secondary">Total</th>
              </tr></thead>
              <tbody><tr>
                {sizes.map((k) => (
                  <td key={k.id} className="px-1">
                    <input type="number" min={0} className="input w-20 text-right tabular-nums" data-size={k.size_code}
                      value={row.qty[k.id] ?? ''} placeholder="0"
                      onChange={(e) => onChange({ qty: { ...row.qty, [k.id]: e.target.value === '' ? '' : Math.max(0, Math.floor(Number(e.target.value))) } })} />
                  </td>
                ))}
                <td className="px-2 text-right font-bold tabular-nums">{fmtNumber(rowTotal)}</td>
              </tr></tbody>
            </table>
          </div>
        ) : <p className="mt-2 text-small text-ink-secondary">No sizes set up for this colour.</p>
      )}
    </div>
  );
}

function CancelGrid({ lines, value, onChange }: {
  lines: SoLineLite[]; value: Record<string, number | ''>; onChange: (v: Record<string, number | ''>) => void;
}) {
  const live = lines.filter((l) => Number(l.order_qty) > 0);
  if (!live.length) return <p className="text-body text-ink-secondary">No open quantity left on this order.</p>;
  const set = (k: string, max: number, v: string) =>
    onChange({ ...value, [k]: v === '' ? '' : Math.min(max, Math.max(0, Math.floor(Number(v)))) });
  return (
    <div className="space-y-3">
      {live.map((l) => (
        <div key={l.id} className="rounded-lg border border-surface-border p-3" data-cancel-line={l.id}>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-body">
            <span className="font-semibold text-ink">{l.style_code}</span>
            {l.color_name && <span className="text-ink-secondary">{l.color_name}</span>}
            {l.is_additional ? <Badge tone="amber">Additional · {l.amendment_no}</Badge> : null}
            {l.set_group ? (
              <span className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-caption font-semibold text-indigo-800" data-cancel-set
                title="Cancelling here cancels whole sets on every part of the set">
                {l.part_name} · set {l.set_group}{Number(l.qty_per_set) > 1 ? ` · ${l.qty_per_set} per set` : ''} — the other parts follow
              </span>
            ) : l.part_name ? <span className="text-ink-secondary">{l.part_name}</span> : null}
            <span className="ml-auto text-ink-secondary">On order <strong className="tabular-nums text-ink">{fmtNumber(l.order_qty)}</strong></span>
          </div>
          {l.skus.length ? (
            <div className="overflow-x-auto">
              <table className="text-body">
                <thead><tr>
                  <th className="pr-2 text-left font-medium text-ink-secondary" />
                  {l.skus.map((s) => <th key={s.sku_id} className="px-1.5 text-center font-semibold text-ink-secondary">{s.size_code}</th>)}
                </tr></thead>
                <tbody>
                  <tr>
                    <td className="pr-2 text-ink-secondary">Order</td>
                    {l.skus.map((s) => <td key={s.sku_id} className="px-1.5 text-center tabular-nums text-ink">{fmtNumber(s.qty)}</td>)}
                  </tr>
                  <tr>
                    <td className="pr-2 font-medium text-red-700">Cancel</td>
                    {l.skus.map((s) => {
                      const k = `${l.id}|${s.sku_id}`;
                      return (
                        <td key={s.sku_id} className="px-1">
                          <input type="number" min={0} max={s.qty} className="input w-20 text-right tabular-nums" data-size={s.size_code}
                            value={value[k] ?? ''} placeholder="0" disabled={!s.qty} onChange={(e) => set(k, Number(s.qty), e.target.value)} />
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <Input label="Cancel qty" type="number" min={0} max={l.order_qty} className="max-w-[160px]"
              value={value[`${l.id}|`] ?? ''} onChange={(e) => set(`${l.id}|`, Number(l.order_qty), e.target.value)} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ============================================================ REQUIREMENT */

export function AmendmentRequirementModal({ soId, amendment, onClose }: {
  soId: number; amendment: { id: number; amendment_no: string; amendment_type: string }; onClose: () => void;
}) {
  const toast = useToast();
  const { canAny } = useAuth();
  const [snapping, setSnapping] = useState(false);
  const q = useQuery({
    queryKey: ['sales-orders', soId, 'amendment-req', amendment.id],
    queryFn: async () => (await http.get<{ data: any }>(`/sales-orders/${soId}/amendments/${amendment.id}/requirement`)).data,
  });
  const add = amendment.amendment_type === 'ADDITIONAL';
  const refreshSnapshot = async () => {
    setSnapping(true);
    try {
      const r = await http.post<{ data: any; message?: string }>(`/jobs/${soId}/requirement-snapshot`, { remarks: `After amendment ${amendment.amendment_no}` });
      toast(r.message ?? 'Job requirement snapshot refreshed');
    } catch (e) { toast(err(e, 'Could not refresh the snapshot'), 'error'); } finally { setSnapping(false); }
  };
  const d = q.data;
  return (
    <Modal open onClose={onClose} size="xl" icon={<Layers size={16} />}
      title={`${add ? 'Materials needed' : 'Materials released'} · ${amendment.amendment_no}`}
      subtitle={add ? 'Materials needed for this additional quantity (BOM × plan-cut pieces of the added cells, + wastage)'
        : 'Materials no longer needed for the cancelled quantity'}
      footerStart={d ? <span className="text-body text-ink-secondary">{d.lines.length} material line{d.lines.length === 1 ? '' : 's'} · {fmtNumber(d.styles.reduce((a: number, s: any) => a + s.plan_cut, 0))} plan-cut pcs</span> : undefined}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {canAny('BOM.UPDATE', 'BOM.CREATE', 'PRODUCTION.CREATE') && (
          <Button id="amend-snapshot" loading={snapping} onClick={() => void refreshSnapshot()}>
            <RefreshCw size={14} /> Refresh job requirement snapshot
          </Button>
        )}
      </>}>
      {q.isLoading ? <LoadingBlock /> : q.error ? <p className="text-body text-red-600">{err(q.error, 'Could not load')}</p> : (
        <div id="amend-requirement">
          {d.warnings?.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-body text-amber-900">
              {d.warnings.map((w: string, i: number) => <div key={i}>{w}</div>)}
            </div>
          )}
          {!d.lines.length ? (
            <EmptyState title="No materials to show" message={d.reason ?? 'The BOM has no per-piece lines for these cells'} />
          ) : (
            <table className="w-full text-body">
              <thead><tr>
                <th className="th">Type</th><th className="th">Material</th><th className="th">Colour / size</th>
                <th className="th text-right">Pcs</th><th className="th text-right">Cons.</th><th className="th text-right">Waste %</th>
                <th className="th text-right">{add ? 'Needed' : 'Released'}</th>
              </tr></thead>
              <tbody>
                {d.lines.map((l: any, i: number) => (
                  <tr key={i} className="row-hover">
                    <td className="td"><Badge tone={l.material_type === 'FABRIC' ? 'blue' : l.material_type === 'YARN' ? 'emerald' : 'slate'}>{l.material_type}</Badge></td>
                    <td className="td font-medium text-ink">{l.material_name}<div className="text-caption text-ink-muted">{l.style_code} · {l.bom_no}</div></td>
                    <td className="td text-ink-secondary">{[l.purchase_color_name || l.color_name, l.size_code].filter(Boolean).join(' / ') || 'All'}</td>
                    <td className="td text-right tabular-nums">{fmtNumber(l.pieces)}</td>
                    <td className="td text-right tabular-nums">{l.consumption}{l.consumption_basis === 'PER_DOZEN' ? '/dz' : ''}</td>
                    <td className="td text-right tabular-nums">{l.wastage_pct}</td>
                    <td className="td text-right font-semibold tabular-nums">{l.required_qty} <span className="text-caption font-normal text-ink-secondary">{l.uom_code}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ============================================================ HISTORY TAB */

export function AmendmentsTab({ soId, amendments, canAmend, onAmend, onChanged }: {
  soId: number; amendments: any[]; canAmend: boolean; onAmend: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [req, setReq] = useState<any | null>(null);
  const [voiding, setVoiding] = useState<any | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [busy, setBusy] = useState(false);
  const doVoid = async () => {
    setBusy(true);
    try {
      await http.post(`/sales-orders/${soId}/amendments/${voiding.id}/void`, { reason: voidReason });
      toast(`${voiding.amendment_no} cancelled`);
      setVoiding(null); setVoidReason(''); onChanged();
    } catch (e) { toast(err(e, 'Could not cancel the amendment'), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card overflow-hidden" id="amendments-tab">
      <div className="flex items-center justify-between border-b border-surface-divider px-4 py-3">
        <span className="text-small font-semibold uppercase tracking-wider text-ink-secondary">Quantity amendments</span>
        {canAmend && <Button size="sm" onClick={onAmend}><FilePlus2 size={13} /> Amend order</Button>}
      </div>
      {!amendments.length ? (
        <EmptyState title="No amendments" message="Additional or cancelled quantity on this running order will be listed here." />
      ) : (
        <table className="w-full text-body">
          <thead><tr>
            <th className="th w-8" /><th className="th">No</th><th className="th">Date</th><th className="th">Type</th>
            <th className="th text-right">Qty</th><th className="th">Reason</th><th className="th">By</th><th className="th">Status</th><th className="th text-right" />
          </tr></thead>
          <tbody>
            {amendments.map((a) => (
              <FragmentRow key={a.id} a={a} open={!!open[a.id]} toggle={() => setOpen((s) => ({ ...s, [a.id]: !s[a.id] }))}
                onReq={() => setReq(a)} onVoid={can('SALES_ORDER.APPROVE') && a.status === 'POSTED' && canAmend ? () => setVoiding(a) : undefined} />
            ))}
          </tbody>
        </table>
      )}
      {req && <AmendmentRequirementModal soId={soId} amendment={req} onClose={() => setReq(null)} />}
      <Modal open={!!voiding} onClose={() => setVoiding(null)} size="sm" icon={<Ban size={16} />}
        title={`Cancel amendment ${voiding?.amendment_no ?? ''}`}
        subtitle={voiding?.amendment_type === 'ADDITIONAL' ? 'Removes the additional lines (only while nothing downstream uses them)' : 'Puts the cancelled quantity back on the order'}
        footer={<>
          <Button variant="secondary" onClick={() => setVoiding(null)}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!voidReason.trim()} onClick={() => void doVoid()}>Cancel amendment</Button>
        </>}>
        <Textarea label="Reason" required value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
      </Modal>
    </div>
  );
}

function FragmentRow({ a, open, toggle, onReq, onVoid }: { a: any; open: boolean; toggle: () => void; onReq: () => void; onVoid?: () => void }) {
  const add = a.amendment_type === 'ADDITIONAL';
  return (
    <>
      <tr className="row-hover cursor-pointer" onClick={toggle} data-amendment={a.amendment_no}>
        <td className="td text-ink-muted">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
        <td className="td tabular-nums font-semibold text-brand-700">{a.amendment_no}</td>
        <td className="td">{fmtDate(a.amendment_date)}</td>
        <td className="td"><Badge tone={add ? 'emerald' : 'red'}>{add ? 'Additional' : 'Cancel'}</Badge></td>
        <td className={`td text-right font-semibold tabular-nums ${add ? 'text-emerald-700' : 'text-red-700'}`}>{add ? '+' : '−'}{fmtNumber(a.total_qty)}</td>
        <td className="td text-ink-secondary">{a.reason || '—'}{a.buyer_ref ? <div className="text-caption text-ink-muted">Ref: {a.buyer_ref}</div> : null}</td>
        <td className="td text-ink-secondary">{a.created_by_name || '—'}</td>
        <td className="td">{a.status === 'POSTED' ? <Badge tone="blue">Posted</Badge> : <Badge tone="slate">Cancelled</Badge>}</td>
        <td className="td text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="secondary" onClick={onReq}><Layers size={13} /> Materials</Button>
          {onVoid && <Button size="sm" variant="ghost" className="ml-1 text-red-600" onClick={onVoid}>Cancel</Button>}
        </td>
      </tr>
      {open && (
        <tr><td colSpan={9} className="bg-surface-muted/60 px-10 py-2">
          <table className="text-small">
            <thead><tr className="text-ink-secondary">
              <th className="pr-4 text-left font-medium">Style</th><th className="pr-4 text-left font-medium">Colour</th><th className="pr-4 text-left font-medium">Size</th>
              <th className="pr-4 text-right font-medium">Qty</th><th className="pr-4 text-right font-medium">Before</th><th className="pr-4 text-right font-medium">After</th>
            </tr></thead>
            <tbody>
              {a.lines.map((l: any) => (
                <tr key={l.id}>
                  <td className="pr-4">{l.style_code}</td><td className="pr-4">{l.color_name ?? '—'}</td><td className="pr-4">{l.size_code ?? '—'}</td>
                  <td className="pr-4 text-right tabular-nums">{fmtNumber(l.qty)}</td>
                  <td className="pr-4 text-right tabular-nums text-ink-secondary">{fmtNumber(l.before_qty)}</td>
                  <td className="pr-4 text-right tabular-nums font-semibold">{fmtNumber(l.after_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {a.status === 'CANCELLED' && <p className="mt-1 text-small text-ink-secondary">Cancelled {fmtDate(a.voided_at)}: {a.void_reason}</p>}
        </td></tr>
      )}
    </>
  );
}

/* ============================================================ CLOSE ORDER */

export function CloseOrderModal({ soId, soNo, state, onClose, onDone }: {
  soId: number; soNo: string; state: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const running = ['APPROVED', 'ON_HOLD'].includes(state);
  const [action, setAction] = useState<'CANCEL' | 'SHORT_CLOSE' | 'COMPLETE'>(running ? 'SHORT_CLOSE' : 'CANCEL');
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await http.post(`/sales-orders/${soId}/close`, { action, closed_date: date, reason: reason || null });
      toast(action === 'CANCEL' ? 'Order cancelled' : action === 'SHORT_CLOSE' ? 'Order short closed' : 'Order completed');
      onDone();
    } catch (e) { toast(err(e, 'Could not close the order'), 'error'); } finally { setBusy(false); }
  };
  const opts = [
    ...(running ? [{ value: 'SHORT_CLOSE', label: 'Short close — balance will not be produced / shipped' }, { value: 'COMPLETE', label: 'Complete — order fully executed' }] : []),
    { value: 'CANCEL', label: 'Cancel the whole order' },
  ];
  return (
    <Modal open onClose={onClose} size="md" icon={<Lock size={16} />} title={`Close order ${soNo}`}
      subtitle="Records the closure status, date and reason — used by the cancelled / closed orders report"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="close-order-confirm" variant={action === 'CANCEL' ? 'danger' : 'primary'} loading={busy}
          disabled={action !== 'COMPLETE' && !reason.trim()} onClick={() => void submit()}>
          {action === 'CANCEL' ? 'Cancel order' : action === 'SHORT_CLOSE' ? 'Short close' : 'Mark complete'}
        </Button>
      </>}>
      <FormSection cols={2}>
        <Select id="close-action" label="Action" required className="sm:col-span-2" options={opts} value={action} onChange={(e) => setAction(e.target.value as any)} />
        <Input label="Closure date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="hidden sm:block" />
        <Textarea id="close-reason" label="Reason" required={action !== 'COMPLETE'} className="sm:col-span-2" value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormSection>
    </Modal>
  );
}

export const CLOSURE_LABEL: Record<string, string> = { CANCELLED: 'Cancelled', SHORT_CLOSED: 'Short closed', COMPLETED: 'Completed' };
