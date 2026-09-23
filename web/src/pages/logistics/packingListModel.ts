/**
 * Client-side model of the packing list (ASSORTED / SOLID / MIXED) used for
 * live totals in the editor. The server recomputes and validates everything on
 * save (server/src/modules/packing/packingListCalc.ts) — these numbers are a
 * preview only and are never sent as authoritative totals.
 */

export type PlType = 'ASSORTED' | 'SOLID' | 'MIXED';

export interface ItemS {
  key: string;
  so_id?: number | null; style_id?: number | null; color_id?: number | null;
  order_no: string; style_no: string; style_name: string; colour: string;
  size_qty: Record<string, string>;            // raw input text per size
}
export interface RowS {
  key: string;
  ctn_from: string;                            // '' = continue from previous row
  no_of_ctns: string;
  packs_per_ctn: string;                       // MIXED pack rows
  net_wt_per_ctn: string; gross_wt_per_ctn: string;
  length_cm: string; width_cm: string; height_cm: string;
  remarks: string;
  source_carton_ids?: number[] | null;
  items: ItemS[];
}
export interface BlockS { key: string; label: string; size_headers: string[] | null; rows: RowS[] }

export interface RowCalc {
  ctn_from: number; ctn_to: number; ctns: number; packed: boolean;
  pcs_per_pack: number | null; pcs_per_ctn: number; total_qty: number;
  total_net: number; total_gross: number; cbm: number;
  inferred: PlType; issues: string[];
  itemUnits: number[];
}
export interface BlockCalc { headers: string[]; rows: RowCalc[]; ctns: number; qty: number; net: number; gross: number; cbm: number }

let seq = 0;
export const uid = () => `k${Date.now().toString(36)}${(++seq).toString(36)}`;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r5 = (x: number) => Math.round(x * 100000) / 100000;
export const normKey = (v: unknown) => String(v ?? '').trim().toUpperCase();

export const emptyItem = (from?: Partial<ItemS>): ItemS => ({
  key: uid(), order_no: from?.order_no ?? '', style_no: from?.style_no ?? '', style_name: from?.style_name ?? '',
  colour: from?.colour ?? '', so_id: from?.so_id ?? null, style_id: from?.style_id ?? null, color_id: from?.color_id ?? null,
  size_qty: {},
});

/** New row continuing the previous one (same order/style/colour/weights/dims, like the sheet's ditto marks). */
export const newRowAfter = (prev?: RowS): RowS => ({
  key: uid(), ctn_from: '', no_of_ctns: '1', packs_per_ctn: prev?.packs_per_ctn ?? '',
  net_wt_per_ctn: prev?.net_wt_per_ctn ?? '', gross_wt_per_ctn: prev?.gross_wt_per_ctn ?? '',
  length_cm: prev?.length_cm ?? '', width_cm: prev?.width_cm ?? '', height_cm: prev?.height_cm ?? '',
  remarks: '', items: [emptyItem(prev?.items[0])],
});

export const newBlock = (label = ''): BlockS => ({ key: uid(), label, size_headers: null, rows: [newRowAfter()] });

/** Accepts the array mysql2 returns, a JSON string (older rows) or null. */
export function parseHeaders(v: unknown): string[] | null {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : null; } catch { return null; } }
  return null;
}

export function calcList(plType: PlType, listHeaders: string[], blocks: BlockS[]) {
  let next = 1;
  const out: BlockCalc[] = blocks.map((b) => {
    const headers = b.size_headers?.length ? b.size_headers : listHeaders;
    const rows = b.rows.map((r): RowCalc => {
      const ctns = Math.max(0, Math.trunc(n(r.no_of_ctns)));
      const packs = Math.trunc(n(r.packs_per_ctn));
      const packed = packs > 0;
      const itemUnits = r.items.map((it) => headers.reduce((a, h) => a + Math.max(0, Math.trunc(n(it.size_qty[h]))), 0));
      const unit = itemUnits.reduce((a, x) => a + x, 0);
      const pcsPerCtn = packed ? unit * packs : unit;
      const from = r.ctn_from.trim() !== '' ? Math.trunc(n(r.ctn_from)) : next;
      const to = from + Math.max(ctns, 1) - 1;
      next = to + 1;
      const net = n(r.net_wt_per_ctn), gross = n(r.gross_wt_per_ctn);
      const dims = [r.length_cm, r.width_cm, r.height_cm].map(n);
      const cbm = dims.every((d) => d > 0) ? r5((dims[0] * dims[1] * dims[2]) / 1_000_000) : 0;
      const sizesUsed = r.items.reduce((a, it) => a + headers.filter((h) => n(it.size_qty[h]) > 0).length, 0);
      const inferred: PlType = r.items.length > 1 || packed ? 'MIXED' : sizesUsed === 1 ? 'SOLID' : 'ASSORTED';
      const issues: string[] = [];
      if (ctns < 1) issues.push('No. of cartons must be at least 1');
      itemUnits.forEach((u, i) => { if (u <= 0) issues.push(`Line ${i + 1}: enter a quantity`); });
      if (r.net_wt_per_ctn && r.gross_wt_per_ctn && net > gross) issues.push('Net weight is more than gross weight');
      if (plType === 'SOLID' && inferred !== 'SOLID') issues.push('Solid list: one colour in one size per carton');
      if (plType === 'ASSORTED' && inferred === 'MIXED') issues.push('Packs / several colours need a MIXED list');
      r.items.forEach((it, i) => { if (!it.colour.trim()) issues.push(`Line ${i + 1}: colour is required`); if (!it.style_no.trim() && !it.style_name.trim()) issues.push(`Line ${i + 1}: style is required`); });
      return {
        ctn_from: from, ctn_to: to, ctns, packed, pcs_per_pack: packed ? unit : null, pcs_per_ctn: pcsPerCtn,
        total_qty: pcsPerCtn * ctns, total_net: r3(net * ctns), total_gross: r3(gross * ctns), cbm: r5(cbm * ctns),
        inferred, issues, itemUnits,
      };
    });
    return {
      headers, rows,
      ctns: rows.reduce((a, r) => a + r.ctns, 0), qty: rows.reduce((a, r) => a + r.total_qty, 0),
      net: r3(rows.reduce((a, r) => a + r.total_net, 0)), gross: r3(rows.reduce((a, r) => a + r.total_gross, 0)),
      cbm: r5(rows.reduce((a, r) => a + r.cbm, 0)),
    };
  });
  // carton range checks across the list
  const all = out.flatMap((b, bi) => b.rows.map((r, ri) => ({ r, bi, ri }))).sort((a, b) => a.r.ctn_from - b.r.ctn_from);
  for (let i = 1; i < all.length; i++) {
    const p = all[i - 1].r, c = all[i].r;
    if (c.ctn_from <= p.ctn_to) { c.issues.push(`Cartons ${c.ctn_from}-${c.ctn_to} overlap ${p.ctn_from}-${p.ctn_to}`); }
    else if (c.ctn_from > p.ctn_to + 1) c.issues.push(`Gap: cartons ${p.ctn_to + 1}-${c.ctn_from - 1} missing`);
  }
  return {
    blocks: out,
    totals: {
      ctns: out.reduce((a, b) => a + b.ctns, 0), qty: out.reduce((a, b) => a + b.qty, 0),
      net: r3(out.reduce((a, b) => a + b.net, 0)), gross: r3(out.reduce((a, b) => a + b.gross, 0)),
      cbm: r5(out.reduce((a, b) => a + b.cbm, 0)),
    },
    issueCount: out.reduce((a, b) => a + b.rows.reduce((x, r) => x + r.issues.length, 0), 0),
  };
}

export const groupKeyOf = (it: { order_no?: string | null; style_no?: string | null; style_name?: string | null; colour?: string | null }) =>
  [it.order_no ?? '', it.style_no || it.style_name || '', it.colour ?? ''].map(normKey).join('|');

/** Shipped qty per order/style/colour and size (live). */
export function shippedGroups(blocks: BlockS[], calc: ReturnType<typeof calcList>) {
  const map = new Map<string, { key: string; label: string; sizes: string[]; shipped: Record<string, number>; total: number }>();
  blocks.forEach((b, bi) => b.rows.forEach((r, ri) => {
    const rc = calc.blocks[bi].rows[ri];
    const mult = (rc.packed ? Math.trunc(n(r.packs_per_ctn)) : 1) * rc.ctns;
    for (const it of r.items) {
      const key = groupKeyOf(it);
      let g = map.get(key);
      if (!g) { g = { key, label: [it.order_no, it.style_no || it.style_name, it.colour].filter(Boolean).join(' / '), sizes: [], shipped: {}, total: 0 }; map.set(key, g); }
      for (const h of calc.blocks[bi].headers) {
        if (!g.sizes.includes(h)) g.sizes.push(h);
        const q = Math.max(0, Math.trunc(n(it.size_qty[h]))) * mult;
        if (q) { g.shipped[h] = (g.shipped[h] || 0) + q; g.total += q; }
      }
    }
  }));
  return [...map.values()];
}

/** Server block → editor state. Carton-from is left blank where it simply continues. */
export function blocksFromServer(blocks: any[]): BlockS[] {
  let prevTo: number | null = null;
  return (blocks || []).map((b: any) => ({
    key: uid(), label: b.label ?? '', size_headers: parseHeaders(b.size_headers),
    rows: (b.rows || []).map((r: any) => {
      const from = Number(r.ctn_from);
      const cont = prevTo == null ? from === 1 : from === prevTo + 1;
      prevTo = Number(r.ctn_to ?? from + Number(r.no_of_ctns) - 1);
      const s = (v: unknown) => (v == null ? '' : String(v));
      return {
        key: uid(), ctn_from: cont ? '' : String(from), no_of_ctns: s(r.no_of_ctns), packs_per_ctn: s(r.packs_per_ctn),
        net_wt_per_ctn: s(r.net_wt_per_ctn), gross_wt_per_ctn: s(r.gross_wt_per_ctn),
        length_cm: s(r.length_cm), width_cm: s(r.width_cm), height_cm: s(r.height_cm), remarks: s(r.remarks),
        source_carton_ids: r.source_carton_ids ?? null,
        items: (r.items || []).map((it: any) => ({
          key: uid(), so_id: it.so_id ?? null, style_id: it.style_id ?? null, color_id: it.color_id ?? null,
          order_no: s(it.order_no), style_no: s(it.style_no), style_name: s(it.style_name), colour: s(it.colour),
          size_qty: Object.fromEntries(Object.entries(it.size_qty || {}).map(([k, v]) => [k, String(v)])),
        })),
      } as RowS;
    }),
  }));
}

/** Editor state → API payload (quantities as numbers, no client totals). */
export function blocksToPayload(blocks: BlockS[], listHeaders: string[]) {
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  return blocks.map((b) => {
    const headers = b.size_headers?.length ? b.size_headers : listHeaders;
    // a completely blank row (no quantity in any size) is just an unused editor line
    const used = b.rows.filter((r) => r.items.some((it) => headers.some((h) => n(it.size_qty[h]) > 0)));
    return {
      label: b.label.trim() || null,
      size_headers: b.size_headers?.length ? b.size_headers : null,
      rows: used.map((r) => ({
        ctn_from: num(r.ctn_from), no_of_ctns: Number(r.no_of_ctns || 0),
        packs_per_ctn: num(r.packs_per_ctn),
        net_wt_per_ctn: num(r.net_wt_per_ctn), gross_wt_per_ctn: num(r.gross_wt_per_ctn),
        length_cm: num(r.length_cm), width_cm: num(r.width_cm), height_cm: num(r.height_cm),
        remarks: r.remarks.trim() || null, source_carton_ids: r.source_carton_ids ?? null,
        items: r.items.map((it) => ({
          so_id: it.so_id ?? null, style_id: it.style_id ?? null, color_id: it.color_id ?? null,
          order_no: it.order_no.trim() || null, style_no: it.style_no.trim() || null,
          style_name: it.style_name.trim() || null, colour: it.colour.trim() || null,
          size_qty: Object.fromEntries(headers.map((h) => [h, Math.trunc(n(it.size_qty[h]))]).filter(([, q]) => (q as number) > 0)),
        })),
      })),
    };
  });
}

export const STANDARD_PRESETS: { name: string; sizes: string[] }[] = [
  { name: 'Alpha S – XXXL', sizes: ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'] },
  { name: 'Numeric 36 – 52', sizes: ['36', '38', '40', '42', '44', '46', '48', '50', '52'] },
  { name: 'Kids 3A – 14A + Adult S – XXL', sizes: ['3A', '4A', '6A', '8A', '10A', '12A', '14A', 'S', 'M', 'L', 'XL', 'XXL'] },
];
