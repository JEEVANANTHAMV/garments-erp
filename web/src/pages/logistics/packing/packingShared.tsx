import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Package, Rows3, Shirt, ScanLine, BarChart3, Settings2, ListChecks } from 'lucide-react';
import clsx from 'clsx';
import { Badge, Button, Input, Select, Modal, FormSection } from '../../../components/ui';
import { api, http } from '../../../lib/api';
import { code128Svg } from '../../../lib/barcode';
import { fmtNumber } from '../../../lib/format';

/* ─────────────────────────────────────────────── types */

export interface Rule {
  id: number; rule_code: string; rule_name: string; buyer_id: number | null; style_id: number | null; so_id: number | null;
  packing_mode: 'BUNDLE_QUANTITY' | 'INDIVIDUAL_PIECE'; pieces_per_polybag: number; polybag_trim_id: number | null; carton_trim_id: number | null;
  standard_pieces_per_carton: number; allow_mixed_sizes: number; allow_mixed_colours: number; allow_partial_carton: number; allow_overpack: number;
  label_template: string | null; effective_from: string | null; effective_to: string | null; is_active: number; revision: number; remarks?: string | null;
  buyer_name?: string; style_code?: string; job_no?: string; buyer_po_no?: string; polybag_trim_name?: string; carton_trim_name?: string; used_by?: number; scope?: string;
}
export interface EligRow {
  color_id: number; size_id: number; color_name: string; size_code: string; sku_id: number | null; order_qty: number; ready: number;
  reserved_other: number; eligible: number; planned: number; posted: number; draft: number; available: number; balance: number;
  bagged: number; bagged_open: number; qc_pending: number; awaiting_fg?: number;
}
export interface Variance {
  tolerance_pct: number; beyond_tolerance: boolean;
  polybags: { expected: number; actual: number; variance: number; variance_pct: number };
  cartons: { expected: number; actual: number; variance: number; variance_pct: number };
}
export interface CartonRow {
  id: number; carton_no: string; carton_seq: number; carton_status: string; is_posted: number; pieces_total: number; polybag_qty: number;
  std_polybag_qty: number; is_partial: number; net_weight_kg: number | null; gross_weight_kg: number | null; contents: string | null;
  carton_trim_name?: string; polybag_trim_name?: string; seal_no?: string | null; posted_at?: string | null;
}
export interface Order {
  id: number; pack_no: string; pack_date: string; so_id: number; io_no: string; job_no: string; so_no: string; buyer_po_no: string | null;
  buyer_name: string | null; style_id: number; style_code: string; style_name: string; part_name: string | null; order_status: string;
  packing_mode: string; planned_qty: number; planned_polybags: number; planned_cartons: number; target_date: string | null; warehouse_id: number | null;
  warehouse_name: string | null; remarks: string | null; approved_at: string | null; approved_by_name: string | null; cancel_reason: string | null;
  variance_approved_at: string | null; variance_note: string | null; cartons_total: number; cartons_posted: number; pieces_posted: number; pieces_unposted: number;
  rule?: Rule; lines?: EligRow[]; cartons?: CartonRow[]; variance?: Variance; variance_needs_approval?: boolean; rule_revision?: number;
}
export interface Trim { id: number; trim_code: string; trim_name: string; trim_type: 'POLYBAG' | 'CARTON'; uom: string; stock_qty: number }
export interface Meta { trims: Trim[]; settings: Record<string, string>; can_approve: boolean }

export const n = (v: unknown) => Number(v ?? 0) || 0;
export const errMsg = (e: unknown) => (e as any)?.message ?? String(e);

/* ─────────────────────────────────────────────── data hooks */

export function usePackingMeta() {
  return useQuery({ queryKey: ['packing-meta'], queryFn: async () => (await http.get<{ data: Meta }>('/packing/meta')).data, staleTime: 30_000 });
}
export function useOrders(params: Record<string, string | number | undefined> = {}) {
  return useQuery({
    queryKey: ['packing-orders', params],
    queryFn: async () => (await http.get<{ data: Order[] }>('/packing/orders', params)).data,
  });
}
export function useOrder(id: number | null | undefined) {
  return useQuery({
    queryKey: ['packing-order', id], enabled: !!id,
    queryFn: async () => (await http.get<{ data: Order }>(`/packing/orders/${id}`)).data,
  });
}

/* ─────────────────────────────────────────────── chrome */

const TABS = [
  { to: '/logistics/packing/orders', label: 'Packing orders', icon: Package },
  { to: '/logistics/packing/polybag', label: 'Piece / polybag entry', icon: Shirt },
  { to: '/logistics/packing/cartons', label: 'Carton box entry', icon: Rows3 },
  { to: '/logistics/packing/verify', label: 'Verify / seal', icon: ScanLine },
  { to: '/logistics/packing/reports', label: 'Reports', icon: BarChart3 },
  { to: '/logistics/packing/rules', label: 'Packing rules', icon: Settings2 },
  { to: '/logistics/packing-lists', label: 'Packing lists', icon: ListChecks },
];

/** Step strip shared by the packing screens (order → polybag → carton → verify → reports). */
export function PackingNav({ active }: { active: string }) {
  return (
    <div className="mb-4 flex flex-wrap gap-1.5" id="packing-nav">
      {TABS.map((t) => (
        <Link key={t.to} to={t.to}
          className={clsx('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium',
            active === t.to ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-surface-border bg-white text-slate-600 hover:bg-surface-hover')}>
          <t.icon size={14} />{t.label}
        </Link>
      ))}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'slate', APPROVED: 'blue', IN_PROGRESS: 'amber', COMPLETED: 'green', CANCELLED: 'red',
  OPEN: 'amber', VERIFIED: 'blue', SEALED: 'indigo', DISPATCHED: 'green', VOID: 'red',
};
export function PkStatus({ value, posted }: { value: string; posted?: number | boolean }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={STATUS_TONE[value] ?? 'slate'}>{value.replace('_', ' ')}</Badge>
      {posted !== undefined && n(posted) ? <Badge tone="green">POSTED</Badge> : null}
    </span>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'red' | 'green' | 'amber' }) {
  return (
    <div className="rounded-lg border border-surface-border bg-white px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={clsx('text-[18px] font-semibold', tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : 'text-slate-900')}>{value}</div>
      {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
    </div>
  );
}

export const TableHead = ({ title, actions }: { title: string; actions?: ReactNode }) => (
  <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-1.5">
    <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

/** Open packing orders (approved / in progress) picker. */
export function OrderPicker({ value, onChange, id = 'packing-order-pick', label = 'Packing order' }: {
  value: number | null; onChange: (id: number | null) => void; id?: string; label?: string;
}) {
  const orders = useOrders({ open: '1' });
  return (
    <Select id={id} label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      placeholder={orders.isLoading ? 'Loading…' : '— Pick an approved packing order —'}
      options={(orders.data ?? []).map((o) => ({ value: o.id, label: `${o.pack_no} · ${o.job_no} · ${o.style_code}${o.buyer_po_no ? ` · PO ${o.buyer_po_no}` : ''}` }))} />
  );
}

/* ─────────────────────────────────────────────── reason popup */

export function ReasonModal({ open, title, subtitle, label = 'Reason', confirm, danger, onClose, onSubmit, busy }: {
  open: boolean; title: string; subtitle?: string; label?: string; confirm: string; danger?: boolean; busy?: boolean;
  onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button id="reason-confirm" variant={danger ? 'danger' : 'primary'} loading={busy} disabled={reason.trim().length < 3} onClick={() => onSubmit(reason.trim())}>{confirm}</Button>
      </>}>
      <FormSection cols={1}>
        <Input id="reason-input" label={label} required value={reason} onChange={(e) => setReason(e.target.value)} autoFocus hint="At least 3 characters — kept in the carton history" />
      </FormSection>
    </Modal>
  );
}

/* ─────────────────────────────────────────────── carton editor (Screen C) */

interface LineDraft { key: string; color_id: number | ''; size_id: number | ''; qty: string; polybag_qty: string }
const lk = (c: unknown, s: unknown) => `${c}:${s}`;

/**
 * New / edit carton box popup: carton no, carton & polybag type, colour × size lines (mixed per the rule),
 * pieces, polybags (actual vs standard), weights and dimensions. Totals and capacity in the footer.
 */
export function CartonEditor({ order, carton, onClose, onSaved }: {
  order: Order; carton?: any | null; onClose: () => void; onSaved: (c: any) => void;
}) {
  const meta = usePackingMeta();
  const rule = order.rule!;
  const ppp = Math.max(n(rule.pieces_per_polybag), 1);
  const cap = n(rule.standard_pieces_per_carton);
  const lines = (order.lines ?? []).filter((l) => l.planned > 0);
  const [f, setF] = useState(() => ({
    carton_no: carton?.carton_no ?? '', carton_trim_id: String(carton?.carton_trim_id ?? rule.carton_trim_id ?? ''),
    polybag_trim_id: String(carton?.polybag_trim_id ?? rule.polybag_trim_id ?? ''),
    net_weight_kg: carton?.net_weight_kg ?? '', gross_weight_kg: carton?.gross_weight_kg ?? '',
    length_cm: carton?.length_cm ?? '', width_cm: carton?.width_cm ?? '', height_cm: carton?.height_cm ?? '',
    seal_no: carton?.seal_no ?? '', remarks: carton?.remarks ?? '',
  }));
  const [rows, setRows] = useState<LineDraft[]>(() => carton?.lines?.length
    ? carton.lines.map((l: any, i: number) => ({ key: `l${i}`, color_id: Number(l.color_id), size_id: Number(l.size_id), qty: String(l.qty), polybag_qty: String(l.polybag_qty) }))
    : [{ key: 'l0', color_id: '', size_id: '', qty: '', polybag_qty: '' }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: any) => setF((s) => ({ ...s, [k]: e.target.value }));
  const own = useMemo(() => new Map<string, number>((carton?.lines ?? []).map((l: any) => [lk(l.color_id, l.size_id), n(l.qty)])), [carton]);

  const total = rows.reduce((a, r) => a + n(r.qty), 0);
  const stdBags = rows.reduce((a, r) => a + (n(r.qty) ? Math.ceil(n(r.qty) / ppp) : 0), 0);
  const bags = rows.reduce((a, r) => a + (r.polybag_qty === '' ? (n(r.qty) ? Math.ceil(n(r.qty) / ppp) : 0) : n(r.polybag_qty)), 0);
  const sizes = new Set(rows.filter((r) => r.size_id).map((r) => r.size_id)); const colours = new Set(rows.filter((r) => r.color_id).map((r) => r.color_id));
  const warn = [
    sizes.size > 1 && !n(rule.allow_mixed_sizes) ? 'Mixed sizes are not allowed by the rule' : '',
    colours.size > 1 && !n(rule.allow_mixed_colours) ? 'Mixed colours are not allowed by the rule' : '',
    cap && total > cap && !n(rule.allow_overpack) ? `Above carton capacity ${cap}` : '',
    n(f.gross_weight_kg) && n(f.net_weight_kg) && n(f.gross_weight_kg) < n(f.net_weight_kg) ? 'Gross weight is below net weight' : '',
  ].filter(Boolean);

  const save = async (draft: boolean) => {
    setErr(''); setBusy(true);
    const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
    const body = {
      carton_no: f.carton_no || null, carton_trim_id: num(f.carton_trim_id), polybag_trim_id: num(f.polybag_trim_id),
      net_weight_kg: num(f.net_weight_kg), gross_weight_kg: num(f.gross_weight_kg), length_cm: num(f.length_cm), width_cm: num(f.width_cm), height_cm: num(f.height_cm),
      seal_no: f.seal_no || null, remarks: f.remarks || null, save_as_draft: draft,
      lines: rows.filter((r) => r.color_id && r.size_id && n(r.qty)).map((r) => ({ color_id: r.color_id, size_id: r.size_id, qty: n(r.qty), polybag_qty: r.polybag_qty === '' ? null : n(r.polybag_qty) })),
    };
    try {
      const res = carton ? await http.put<{ data: any }>(`/packing/cartons/${carton.id}`, body) : await http.post<{ data: any }>(`/packing/orders/${order.id}/cartons`, body);
      onSaved(res.data);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  const trims = meta.data?.trims ?? [];
  return (
    <Modal open onClose={onClose} size="xl" icon={<Rows3 size={16} />}
      title={carton ? `Edit carton ${carton.carton_no}` : `New carton · ${order.pack_no}`}
      subtitle={`${order.job_no} · ${order.style_code}${order.buyer_po_no ? ` · PO ${order.buyer_po_no}` : ''} · rule ${rule.rule_code}: ${cap} pcs / carton, ${ppp} pc / polybag${n(rule.allow_mixed_sizes) ? ', mixed sizes' : ''}${n(rule.allow_mixed_colours) ? ', mixed colours' : ''}`}
      footerStart={<span id="carton-totals">
        <b>{fmtNumber(total)}</b> pcs{cap ? <> of {cap} ({total === cap ? 'full' : total < cap ? 'partial' : 'overpack'})</> : null}
        {' · '}polybags <b>{bags}</b> vs std {stdBags}{bags !== stdBags ? <span className="text-amber-700"> ({bags - stdBags > 0 ? '+' : ''}{bags - stdBags})</span> : null}
      </span>}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" id="carton-save-draft" loading={busy} onClick={() => save(true)}>Save draft</Button>
        <Button id="carton-save" loading={busy} onClick={() => save(false)}>Save carton</Button>
      </>}>
      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700" id="carton-error">{err}</div>}
      <FormSection title="Carton" cols={3}>
        <Input id="carton-no" label="Carton no" value={f.carton_no} onChange={set('carton_no')} disabled={!!carton} hint={carton ? 'Never changes' : 'Blank = next number (never reused)'} />
        <Select id="carton-trim" label="Carton type" required value={f.carton_trim_id} onChange={set('carton_trim_id')} placeholder="— Carton item —"
          options={trims.filter((t) => t.trim_type === 'CARTON').map((t) => ({ value: t.id, label: `${t.trim_name} (stock ${fmtNumber(t.stock_qty)})` }))} />
        <Select id="polybag-trim" label="Polybag type" value={f.polybag_trim_id} onChange={set('polybag_trim_id')} placeholder="— Polybag item —"
          options={trims.filter((t) => t.trim_type === 'POLYBAG').map((t) => ({ value: t.id, label: `${t.trim_name} (stock ${fmtNumber(t.stock_qty)})` }))} />
      </FormSection>
      <section className="mb-4">
        <TableHead title="Colour / size lines" actions={
          <Button size="sm" variant="secondary" id="carton-add-line" onClick={() => setRows((r) => [...r, { key: `l${Date.now()}`, color_id: '', size_id: '', qty: '', polybag_qty: '' }])}>Add line</Button>} />
        <table className="w-full text-[12.5px]">
          <thead><tr><th className="th">Colour / size</th><th className="th text-right">Available</th><th className="th text-right">Pieces</th><th className="th text-right">Polybags (std)</th><th className="th" /></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const el = lines.find((l) => lk(l.color_id, l.size_id) === lk(r.color_id, r.size_id));
              const avail = el ? el.available + (own.get(lk(r.color_id, r.size_id)) ?? 0) : null;
              const std = n(r.qty) ? Math.ceil(n(r.qty) / ppp) : 0;
              return (
                <tr key={r.key}>
                  <td className="td">
                    <select className="input" data-line={i} value={r.color_id && r.size_id ? lk(r.color_id, r.size_id) : ''}
                      onChange={(e) => { const [c, s] = e.target.value.split(':').map(Number); setRows((x) => x.map((y) => (y.key === r.key ? { ...y, color_id: c || '', size_id: s || '' } : y))); }}>
                      <option value="">— Colour / size —</option>
                      {lines.map((l) => <option key={lk(l.color_id, l.size_id)} value={lk(l.color_id, l.size_id)}>{l.color_name} / {l.size_code}</option>)}
                    </select>
                  </td>
                  <td className="td text-right tabular-nums">{avail == null ? '—' : fmtNumber(avail)}</td>
                  <td className="td w-28"><input className="input text-right" data-qty={i} inputMode="numeric" value={r.qty}
                    onChange={(e) => setRows((x) => x.map((y) => (y.key === r.key ? { ...y, qty: e.target.value.replace(/\D/g, '') } : y)))} /></td>
                  <td className="td w-36"><div className="flex items-center gap-1.5"><input className="input text-right" data-bags={i} inputMode="numeric" placeholder={String(std)} value={r.polybag_qty}
                    onChange={(e) => setRows((x) => x.map((y) => (y.key === r.key ? { ...y, polybag_qty: e.target.value.replace(/\D/g, '') } : y)))} /><span className="text-slate-400">({std})</span></div></td>
                  <td className="td w-10 text-right">{rows.length > 1 && <button className="text-[12px] text-red-600 hover:underline" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}>Remove</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {warn.length > 0 && <div className="mt-2 text-[12px] text-amber-700">{warn.join(' · ')}</div>}
      </section>
      <FormSection title="Dimensions, weight & seal" cols={3} description="Optional. Gross must be at least net.">
        <Input label="Length (cm)" inputMode="decimal" value={f.length_cm} onChange={set('length_cm')} />
        <Input label="Width (cm)" inputMode="decimal" value={f.width_cm} onChange={set('width_cm')} />
        <Input label="Height (cm)" inputMode="decimal" value={f.height_cm} onChange={set('height_cm')} />
        <Input id="carton-net" label="Net weight (kg)" inputMode="decimal" value={f.net_weight_kg} onChange={set('net_weight_kg')} />
        <Input id="carton-gross" label="Gross weight (kg)" inputMode="decimal" value={f.gross_weight_kg} onChange={set('gross_weight_kg')} />
        <Input label="Seal no" value={f.seal_no} onChange={set('seal_no')} />
      </FormSection>
      <FormSection title="Remarks" cols={1}>
        <Input label="Remarks" value={f.remarks} onChange={set('remarks')} />
      </FormSection>
    </Modal>
  );
}

/* ─────────────────────────────────────────────── carton label (Code 128) */

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Print the carton label from the carton's actual detail lines (never the plan). Returns false if the popup was blocked. */
export async function printCartonLabel(cartonId: number): Promise<boolean> {
  const w = window.open('', '_blank', 'width=520,height=720');
  if (!w) return false;
  w.document.write('<p style="font:13px Arial">Preparing label…</p>');
  const d = (await http.get<{ data: any }>(`/packing/cartons/${cartonId}/label`)).data;
  const rows = d.lines.map((l: any) => `<tr><td>${esc(l.color)}</td><td>${esc(l.size)}</td><td style="text-align:right">${esc(l.qty)}</td></tr>`).join('');
  w.document.open();
  w.document.write(`<!doctype html><html><head><title>Carton ${esc(d.carton_no)}</title><style>
    body{font:12px Arial;margin:0;padding:14px} .lbl{border:2px solid #000;padding:10px;width:400px}
    h1{font-size:18px;margin:0 0 4px} .row{display:flex;justify-content:space-between} table{width:100%;border-collapse:collapse;margin-top:6px}
    td,th{border:1px solid #000;padding:3px 5px;font-size:12px} th{text-align:left;background:#eee} .big{font-size:22px;font-weight:bold}
    @media print{body{padding:0}}</style></head><body><div class="lbl">
    <div class="row"><h1>${esc(d.buyer ?? '')}</h1><div class="big">${esc(d.seq ?? '')} of ${esc(d.of)}</div></div>
    <div class="row"><div>PO: <b>${esc(d.buyer_po ?? '—')}</b></div><div>Job: <b>${esc(d.job)}</b></div></div>
    <div class="row"><div>Style: <b>${esc(d.style)}</b> ${esc(d.style_name ?? '')}</div></div>
    <table><thead><tr><th>Colour</th><th>Size</th><th style="text-align:right">Pcs</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><th colspan="2">Pieces in carton</th><th style="text-align:right">${esc(d.pieces)}</th></tr></tfoot></table>
    <div class="row" style="margin-top:6px"><div>Net ${esc(d.net_weight_kg ?? '—')} kg · Gross ${esc(d.gross_weight_kg ?? '—')} kg</div>
    <div>${d.dims?.every((x: any) => x) ? esc(d.dims.join(' × ')) + ' cm' : ''}</div></div>
    <div style="text-align:center;margin-top:8px">${code128Svg(d.barcode, { height: 60, module: 1.6 })}<div style="font:bold 14px monospace;letter-spacing:1px">${esc(d.carton_no)}</div></div>
    </div><script>setTimeout(function(){window.print()},300)</script></body></html>`);
  w.document.close();
  api.post(`/packing/cartons/${cartonId}/label-printed`).catch(() => {});
  return true;
}
