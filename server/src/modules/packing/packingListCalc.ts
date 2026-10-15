import { z } from 'zod';
import { BadRequest } from '../../core/errors.js';
import { s } from '../resources/schemas.js';

/**
 * Packing list formats (client packinglist.xlsx):
 *
 *   ASSORTED  every carton of a range holds the same size ratio
 *             (S1 M2 L3 XL3 XXL2 XXXL1 = 12 pcs/ctn × 285 ctns = 3420 pcs)
 *   SOLID     one size per carton (numeric sizes 36..52), blocks per colour
 *   MIXED     kids + adult size sets on one list; PCS/PACK × PACK/CTN rows,
 *             cartons mixing several colours / styles, plus loose rows
 *
 * Everything the sheet derives with a formula (carton-to, pcs/ctn, total qty,
 * total weights, CBM, sub-totals, grand totals, Order/Shipped/Diff) is derived
 * HERE, on the server. Client totals are never trusted.
 */

export const PL_TYPES = ['ASSORTED', 'SOLID', 'MIXED'] as const;
export type PlType = typeof PL_TYPES[number];

const sizeLabel = z.string().trim().min(1, 'Size label is required').max(20);
const sizeHeaders = z.array(sizeLabel).min(1, 'At least one size column is required').max(40);
const qty = z.coerce.number().int('Quantity must be a whole number').min(0, 'Quantity cannot be negative');
const kg = z.union([z.coerce.number().min(0, 'Weight cannot be negative').max(10000), z.literal(''), z.null()])
  .transform((v) => (v === '' || v == null ? null : v)).nullish();
const cm = z.union([z.coerce.number().min(0).max(1000), z.literal(''), z.null()])
  .transform((v) => (v === '' || v == null || v === 0 ? null : v)).nullish();
const optInt = z.union([z.coerce.number().int().min(0), z.literal(''), z.null()])
  .transform((v) => (v === '' || v == null ? null : v)).nullish();

export const itemSchema = z.object({
  so_id: s.id(),
  order_no: s.nullableStr(60),
  style_id: s.id(),
  style_no: s.nullableStr(80),
  style_name: s.nullableStr(200),
  color_id: s.id(),
  colour: s.nullableStr(80),
  size_qty: z.record(z.string(), qty).default({}),
});

export const rowSchema = z.object({
  row_type: z.enum(PL_TYPES).nullish(),
  ctn_from: optInt,
  ctn_to: optInt,
  no_of_ctns: z.coerce.number().int().min(1, 'No. of cartons must be at least 1').max(100000),
  pcs_per_pack: optInt,
  packs_per_ctn: optInt,
  pcs_per_ctn: optInt,
  net_wt_per_ctn: kg,
  gross_wt_per_ctn: kg,
  length_cm: cm,
  width_cm: cm,
  height_cm: cm,
  remarks: s.nullableStr(255),
  source_carton_ids: z.array(z.coerce.number().int().positive()).nullish(),
  items: z.array(itemSchema).min(1, 'Each carton row needs at least one item line'),
});

export const blockSchema = z.object({
  label: s.nullableStr(200),
  size_headers: sizeHeaders.nullish(),
  rows: z.array(rowSchema).default([]),
});

export type ItemIn = z.infer<typeof itemSchema>;
export type RowIn = z.infer<typeof rowSchema>;
export type BlockIn = z.infer<typeof blockSchema>;

export interface ItemOut {
  so_id: number | null; order_no: string | null; style_id: number | null;
  style_no: string | null; style_name: string | null; color_id: number | null; colour: string | null;
  size_qty: Record<string, number>; size_qty_per_ctn: Record<string, number>;
  unit_qty: number; qty_per_ctn: number; total_qty: number;
}
export interface RowOut {
  id?: number;
  row_type: PlType; ctn_from: number; ctn_to: number; no_of_ctns: number;
  pcs_per_pack: number | null; packs_per_ctn: number | null; pcs_per_ctn: number; total_qty: number;
  net_wt_per_ctn: number | null; gross_wt_per_ctn: number | null;
  total_net_wt: number; total_gross_wt: number;
  length_cm: number | null; width_cm: number | null; height_cm: number | null;
  cbm_per_ctn: number | null; total_cbm: number;
  remarks: string | null; source_carton_ids: number[] | null;
  items: ItemOut[];
}
export interface BlockTotals { total_cartons: number; total_qty: number; total_net_wt: number; total_gross_wt: number; total_cbm: number }
export interface BlockOut extends BlockTotals {
  id?: number;
  block_no: number; label: string | null;
  size_headers: string[] | null;           // as stored (NULL = list default)
  effective_size_headers: string[];        // what the columns show
  rows: RowOut[];
}
export interface ComputedList {
  blocks: BlockOut[];
  totals: BlockTotals;
  measurements: { dims: string; length_cm: number; width_cm: number; height_cm: number; cartons: number; cbm: number }[];
  warnings: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r5 = (n: number) => Math.round(n * 100000) / 100000;
const norm = (v: string) => v.trim().toUpperCase();

/** Validate & normalise an ordered size-header list (trimmed, no duplicates). */
export function normaliseSizeHeaders(list: string[], where: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const l = String(raw).trim();
    if (!l) continue;
    if (seen.has(norm(l))) throw BadRequest(`${where}: size "${l}" appears more than once`);
    seen.add(norm(l));
    out.push(l);
  }
  if (!out.length) throw BadRequest(`${where}: at least one size column is required`);
  return out;
}

/**
 * Validate the rows of a packing list and compute every derived figure.
 * Collects all problems and throws one BadRequest listing them (with a
 * `field` path per problem so the UI can point at the cell).
 */
export function computePackingList(input: {
  pl_type: PlType;
  size_headers: string[];
  allow_ctn_gaps: boolean;
  blocks: BlockIn[];
}): ComputedList {
  const errors: { field: string; message: string }[] = [];
  const warnings: string[] = [];
  const listHeaders = normaliseSizeHeaders(input.size_headers, 'Size headers');
  const blocks: BlockOut[] = [];
  let nextCtn = 1;

  input.blocks.forEach((b, bi) => {
    const bPath = `blocks.${bi}`;
    let headers = listHeaders;
    let storedHeaders: string[] | null = null;
    if (b.size_headers && b.size_headers.length) {
      try {
        storedHeaders = normaliseSizeHeaders(b.size_headers, `Block ${bi + 1} size headers`);
        headers = storedHeaders;
      } catch (e: any) {
        errors.push({ field: `${bPath}.size_headers`, message: e.message });
      }
    }
    const headerByNorm = new Map(headers.map((h) => [norm(h), h]));
    const rows: RowOut[] = [];

    b.rows.forEach((r, ri) => {
      const rPath = `${bPath}.rows.${ri}`;
      const label = `Block ${bi + 1}, row ${ri + 1}`;
      const packed = r.packs_per_ctn != null && r.packs_per_ctn > 0;

      // ---- items & sizes
      const items: ItemOut[] = [];
      r.items.forEach((it, ii) => {
        const sq: Record<string, number> = {};
        for (const [k, v] of Object.entries(it.size_qty || {})) {
          const h = headerByNorm.get(norm(k));
          if (!h) {
            if (Number(v) > 0) errors.push({ field: `${rPath}.items.${ii}.size_qty.${k}`, message: `${label}: size "${k}" is not a column of this block (${headers.join(', ')})` });
            continue;
          }
          if (Number(v) > 0) sq[h] = (sq[h] || 0) + Number(v);
        }
        // keep the block's column order
        const ordered: Record<string, number> = {};
        for (const h of headers) if (sq[h]) ordered[h] = sq[h];
        const unit = Object.values(ordered).reduce((a, n) => a + n, 0);
        if (unit <= 0) errors.push({ field: `${rPath}.items.${ii}.size_qty`, message: `${label}, line ${ii + 1}: enter a quantity for at least one size` });
        const mult = packed ? r.packs_per_ctn! : 1;
        const perCtn: Record<string, number> = {};
        for (const [h, q] of Object.entries(ordered)) perCtn[h] = q * mult;
        items.push({
          so_id: it.so_id ?? null, order_no: it.order_no ?? null,
          style_id: it.style_id ?? null, style_no: it.style_no ?? null, style_name: it.style_name ?? null,
          color_id: it.color_id ?? null, colour: it.colour ?? null,
          size_qty: ordered, size_qty_per_ctn: perCtn,
          unit_qty: unit, qty_per_ctn: unit * mult, total_qty: unit * mult * r.no_of_ctns,
        });
        if (!it.style_no && !it.style_name && !it.style_id) errors.push({ field: `${rPath}.items.${ii}.style_no`, message: `${label}, line ${ii + 1}: style no / name is required` });
        if (!it.colour && !it.color_id) errors.push({ field: `${rPath}.items.${ii}.colour`, message: `${label}, line ${ii + 1}: colour is required` });
      });

      // ---- pack arithmetic
      const unitSum = items.reduce((a, i) => a + i.unit_qty, 0);
      const pcsPerPack = packed ? unitSum : null;
      const pcsPerCtn = packed ? unitSum * r.packs_per_ctn! : unitSum;
      if (packed && r.pcs_per_pack != null && r.pcs_per_pack !== unitSum)
        errors.push({ field: `${rPath}.pcs_per_pack`, message: `${label}: PCS/PACK ${r.pcs_per_pack} does not match the size quantities (${unitSum})` });
      if (!packed && r.pcs_per_pack != null && r.pcs_per_pack > 0)
        errors.push({ field: `${rPath}.packs_per_ctn`, message: `${label}: PCS/PACK is set but PACK/CTN is empty` });
      if (r.pcs_per_ctn != null && r.pcs_per_ctn !== pcsPerCtn)
        errors.push({ field: `${rPath}.pcs_per_ctn`, message: packed
          ? `${label}: PCS/PACK ${unitSum} × PACK/CTN ${r.packs_per_ctn} = ${pcsPerCtn}, not ${r.pcs_per_ctn}`
          : `${label}: sum of size quantities is ${pcsPerCtn}, not PCS/CTN ${r.pcs_per_ctn}` });

      // ---- row type rules
      const nonZeroSizes = items.reduce((a, i) => a + Object.keys(i.size_qty).length, 0);
      let rowType: PlType = r.row_type
        ?? (items.length > 1 || packed ? 'MIXED' : nonZeroSizes === 1 ? 'SOLID' : 'ASSORTED');
      if (rowType === 'SOLID') {
        if (items.length !== 1 || nonZeroSizes !== 1 || packed)
          errors.push({ field: rPath, message: `${label}: a SOLID carton holds exactly one colour in one size` });
      } else if (rowType === 'ASSORTED') {
        if (items.length !== 1 || packed)
          errors.push({ field: rPath, message: `${label}: an ASSORTED carton holds one style/colour in a size ratio (use a MIXED row for packs or several colours)` });
      }
      // Model 2 (size grid): a carton holds one style / colour; normally one size, several sizes only
      // when the buyer packing rule allows mixed sizes (the grid prints them the same way)
      if (input.pl_type === 'SOLID' && rowType === 'MIXED')
        errors.push({ field: rPath, message: `${label}: a SOLID packing list holds one style / colour per carton (use a MIXED list for packs or several colours)` });
      if (input.pl_type === 'ASSORTED' && rowType === 'MIXED')
        errors.push({ field: rPath, message: `${label}: MIXED cartons are only allowed on a MIXED packing list` });

      // ---- carton range
      const from = r.ctn_from ?? nextCtn;
      if (from < 1) errors.push({ field: `${rPath}.ctn_from`, message: `${label}: carton numbers start at 1` });
      const to = from + r.no_of_ctns - 1;
      if (r.ctn_to != null && r.ctn_to !== to)
        errors.push({ field: `${rPath}.ctn_to`, message: `${label}: carton range ${from}-${r.ctn_to} is ${r.ctn_to - from + 1} cartons, but No. of cartons is ${r.no_of_ctns}` });
      nextCtn = to + 1;

      // ---- weights & dims
      const net = r.net_wt_per_ctn ?? null;
      const gross = r.gross_wt_per_ctn ?? null;
      if (net != null && gross != null && net > gross)
        errors.push({ field: `${rPath}.net_wt_per_ctn`, message: `${label}: net weight ${net} kg is more than gross weight ${gross} kg` });
      const dimsSet = [r.length_cm, r.width_cm, r.height_cm].filter((d) => d != null).length;
      if (dimsSet > 0 && dimsSet < 3)
        errors.push({ field: `${rPath}.length_cm`, message: `${label}: enter all three carton dimensions (L × W × H cm) or none` });
      const cbm = dimsSet === 3 ? r5((r.length_cm! * r.width_cm! * r.height_cm!) / 1_000_000) : null;

      rows.push({
        row_type: rowType, ctn_from: from, ctn_to: to, no_of_ctns: r.no_of_ctns,
        pcs_per_pack: pcsPerPack, packs_per_ctn: packed ? r.packs_per_ctn! : null,
        pcs_per_ctn: pcsPerCtn, total_qty: pcsPerCtn * r.no_of_ctns,
        net_wt_per_ctn: net, gross_wt_per_ctn: gross,
        total_net_wt: r3((net ?? 0) * r.no_of_ctns), total_gross_wt: r3((gross ?? 0) * r.no_of_ctns),
        length_cm: r.length_cm ?? null, width_cm: r.width_cm ?? null, height_cm: r.height_cm ?? null,
        cbm_per_ctn: cbm, total_cbm: r5((cbm ?? 0) * r.no_of_ctns),
        remarks: r.remarks ?? null, source_carton_ids: r.source_carton_ids?.length ? r.source_carton_ids : null,
        items,
      });
    });

    blocks.push({
      block_no: bi + 1, label: b.label ?? null, size_headers: storedHeaders, effective_size_headers: headers,
      rows, ...sumRows(rows),
    });
  });

  // ---- carton ranges across the whole list: no overlaps, no gaps
  const ranges = blocks.flatMap((b) => b.rows.map((r, ri) => ({ ...r, where: `Block ${b.block_no}, row ${ri + 1}`, path: `blocks.${b.block_no - 1}.rows.${ri}` })))
    .sort((a, b) => a.ctn_from - b.ctn_from);
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1], cur = ranges[i];
    if (cur.ctn_from <= prev.ctn_to) {
      errors.push({ field: `${cur.path}.ctn_from`, message: `${cur.where}: cartons ${cur.ctn_from}-${cur.ctn_to} overlap ${prev.where} (${prev.ctn_from}-${prev.ctn_to})` });
    } else if (cur.ctn_from > prev.ctn_to + 1) {
      const msg = `${cur.where}: cartons ${prev.ctn_to + 1}-${cur.ctn_from - 1} are missing between ${prev.where} and ${cur.where}`;
      if (input.allow_ctn_gaps) warnings.push(msg);
      else errors.push({ field: `${cur.path}.ctn_from`, message: `${msg} (tick "allow carton-number gaps" if intentional)` });
    }
  }

  if (errors.length) {
    const head = errors.slice(0, 3).map((e) => e.message).join('; ');
    throw BadRequest(errors.length > 3 ? `${head}; and ${errors.length - 3} more problem(s)` : head, errors);
  }

  return { blocks, ...summarise(blocks), warnings };
}

/** Grand totals and the carton-measurement summary ("55 X 40 X 20 - 285 CARTONS"). */
export function summarise(blocks: BlockOut[]): Pick<ComputedList, 'totals' | 'measurements'> {
  const dimMap = new Map<string, ComputedList['measurements'][number]>();
  for (const b of blocks) for (const r of b.rows) {
    if (r.cbm_per_ctn == null) continue;
    const dims = `${fmtDim(r.length_cm!)} X ${fmtDim(r.width_cm!)} X ${fmtDim(r.height_cm!)}`;
    const m = dimMap.get(dims) ?? { dims, length_cm: r.length_cm!, width_cm: r.width_cm!, height_cm: r.height_cm!, cartons: 0, cbm: 0 };
    m.cartons += r.no_of_ctns; m.cbm = r5(m.cbm + r.total_cbm);
    dimMap.set(dims, m);
  }
  return { totals: sumBlocks(blocks), measurements: [...dimMap.values()] };
}

const fmtDim = (n: number) => String(Number(n.toFixed(2)));

export function sumRows(rows: RowOut[]): BlockTotals {
  return {
    total_cartons: rows.reduce((a, r) => a + r.no_of_ctns, 0),
    total_qty: rows.reduce((a, r) => a + r.total_qty, 0),
    total_net_wt: r3(rows.reduce((a, r) => a + r.total_net_wt, 0)),
    total_gross_wt: r3(rows.reduce((a, r) => a + r.total_gross_wt, 0)),
    total_cbm: r5(rows.reduce((a, r) => a + r.total_cbm, 0)),
  };
}
function sumBlocks(blocks: BlockTotals[]): BlockTotals {
  return {
    total_cartons: blocks.reduce((a, b) => a + b.total_cartons, 0),
    total_qty: blocks.reduce((a, b) => a + b.total_qty, 0),
    total_net_wt: r3(blocks.reduce((a, b) => a + b.total_net_wt, 0)),
    total_gross_wt: r3(blocks.reduce((a, b) => a + b.total_gross_wt, 0)),
    total_cbm: r5(blocks.reduce((a, b) => a + b.total_cbm, 0)),
  };
}

/* ------------------------------------------------------------------
   Order / Shipped / Diff summary
------------------------------------------------------------------ */
export interface SummaryGroup {
  group_key: string; order_no: string | null; so_id: number | null;
  style_id: number | null; style_no: string | null; style_name: string | null;
  color_id: number | null; colour: string | null;
  sizes: string[];
  shipped: Record<string, number>; order: Record<string, number>; diff: Record<string, number>;
  shipped_total: number; order_total: number; diff_total: number;
  /** Over-shipment, shown separately: shipped − order where shipped is MORE than ordered (always >= 0) */
  excess: Record<string, number>; excess_total: number;
  order_source: 'SALES_ORDER' | 'MANUAL' | 'NONE';
}

/** Stable key for one order/style/colour line of the summary. */
export const groupKeyOf = (it: { order_no?: string | null; style_no?: string | null; style_name?: string | null; colour?: string | null }) =>
  [it.order_no ?? '', it.style_no || it.style_name || '', it.colour ?? ''].map((v) => norm(String(v))).join('|');

/** Shipped quantities per order/style/colour and size, in first-seen order. */
export function shippedGroups(c: ComputedList): SummaryGroup[] {
  const map = new Map<string, SummaryGroup>();
  for (const b of c.blocks) for (const r of b.rows) for (const it of r.items) {
    const key = groupKeyOf(it);
    let g = map.get(key);
    if (!g) {
      g = { group_key: key, order_no: it.order_no, so_id: it.so_id, style_id: it.style_id, style_no: it.style_no,
            style_name: it.style_name, color_id: it.color_id, colour: it.colour, sizes: [],
            shipped: {}, order: {}, diff: {}, shipped_total: 0, order_total: 0, diff_total: 0,
            excess: {}, excess_total: 0, order_source: 'NONE' };
      map.set(key, g);
    }
    for (const h of b.effective_size_headers) if (!g.sizes.includes(h)) g.sizes.push(h);
    for (const [h, q] of Object.entries(it.size_qty_per_ctn)) {
      g.shipped[h] = (g.shipped[h] || 0) + q * r.no_of_ctns;
      g.shipped_total += q * r.no_of_ctns;
    }
  }
  return [...map.values()];
}

/** Fill order qty and Diff (= Order − Shipped, as on the client's sheet). */
export function applyOrderQty(g: SummaryGroup, order: Record<string, number>, source: SummaryGroup['order_source']) {
  g.order = {}; g.order_total = 0; g.order_source = source;
  for (const [h, q] of Object.entries(order)) {
    if (!(q > 0)) continue;
    let label = g.sizes.find((x) => norm(x) === norm(h));
    if (!label) { label = h; g.sizes.push(h); }   // ordered but not shipped at all
    g.order[label] = (g.order[label] || 0) + q;
    g.order_total += q;
  }
  g.diff = {}; g.diff_total = 0; g.excess = {}; g.excess_total = 0;
  for (const h of g.sizes) {
    const d = (g.order[h] || 0) - (g.shipped[h] || 0);
    g.diff[h] = d;
    // over-shipment only means something when an order qty is known
    if (source !== 'NONE' && d < 0) { g.excess[h] = -d; g.excess_total += -d; }
  }
  g.diff_total = g.order_total - g.shipped_total;
}

/* ------------------------------------------------------------------
   Build carton rows from physical cartons (trx_carton / _content)
------------------------------------------------------------------ */
export interface CartonForBuild {
  id: number; carton_no: string;
  net_weight_kg: number | null; gross_weight_kg: number | null;
  length_cm: number | null; width_cm: number | null; height_cm: number | null;
  /** polybags in the carton (packing engine) — cartons with a different polybag count never share a row */
  polybag_qty?: number | null;
  contents: { style_id: number; style_code: string; style_name: string | null; color_id: number; color_name: string; size_code: string; qty: number }[];
}

/**
 * Consecutive cartons with identical contents, weights and dimensions become
 * one carton-range row (e.g. cartons 1..285 of S1 M2 L3 XL3 XXL2 XXXL1).
 */
export function groupCartons(cartons: CartonForBuild[], orderNo: string | null, soId: number | null) {
  const numOf = (c: CartonForBuild) => { const m = /(\d+)\s*$/.exec(c.carton_no); return m ? Number(m[1]) : NaN; };
  const nums = cartons.map(numOf);
  const numeric = nums.every((n) => Number.isFinite(n) && n > 0) && new Set(nums).size === nums.length;
  const sorted = cartons.map((c, i) => ({ c, n: numeric ? nums[i] : i + 1 }))
    .sort((a, b) => (numeric ? a.n - b.n : a.c.carton_no.localeCompare(b.c.carton_no, undefined, { numeric: true })));
  if (!numeric) sorted.forEach((x, i) => { x.n = i + 1; });

  const sig = (c: CartonForBuild) => JSON.stringify([
    [...c.contents].sort((a, b) => `${a.style_id}|${a.color_id}|${a.size_code}`.localeCompare(`${b.style_id}|${b.color_id}|${b.size_code}`))
      .map((x) => [x.style_id, x.color_id, x.size_code, Number(x.qty)]),
    Number(c.net_weight_kg ?? 0), Number(c.gross_weight_kg ?? 0),
    Number(c.length_cm ?? 0), Number(c.width_cm ?? 0), Number(c.height_cm ?? 0), Number(c.polybag_qty ?? 0)]);

  const rows: (RowIn & { ctn_from: number })[] = [];
  let prevSig = '', prevN = -1;
  for (const { c, n } of sorted) {
    const sg = sig(c);
    const last = rows[rows.length - 1];
    if (last && sg === prevSig && n === prevN + 1) {
      last.no_of_ctns += 1;
      last.source_carton_ids!.push(c.id);
    } else {
      const byItem = new Map<string, ItemIn>();
      for (const x of c.contents) {
        const k = `${x.style_id}|${x.color_id}`;
        let it = byItem.get(k);
        if (!it) {
          it = { so_id: soId, order_no: orderNo, style_id: x.style_id, style_no: x.style_code, style_name: x.style_name,
                 color_id: x.color_id, colour: x.color_name, size_qty: {} };
          byItem.set(k, it);
        }
        it.size_qty[x.size_code] = (it.size_qty[x.size_code] || 0) + Number(x.qty);
      }
      rows.push({
        ctn_from: n, ctn_to: null, no_of_ctns: 1, row_type: null,
        pcs_per_pack: null, packs_per_ctn: null, pcs_per_ctn: null,
        net_wt_per_ctn: c.net_weight_kg != null ? Number(c.net_weight_kg) : null,
        gross_wt_per_ctn: c.gross_weight_kg != null ? Number(c.gross_weight_kg) : null,
        length_cm: c.length_cm != null ? Number(c.length_cm) : null,
        width_cm: c.width_cm != null ? Number(c.width_cm) : null,
        height_cm: c.height_cm != null ? Number(c.height_cm) : null,
        remarks: null, source_carton_ids: [c.id], items: [...byItem.values()],
      });
    }
    prevSig = sg; prevN = n;
  }
  return rows;
}


/**
 * Polybag arithmetic on rows built from cartons (MIXED lists only, where a row
 * may be PCS/PACK × PACK/CTN): a carton of N polybags whose every size qty
 * divides by N becomes N packs of (size qty / N). Other list types keep the
 * per-carton size quantities; the polybag count is shown beside the row.
 */
export function applyPolybagPacks(rows: RowIn[], polybagsOf: (row: RowIn) => number) {
  for (const r of rows) {
    const bags = polybagsOf(r);
    if (!(bags > 1)) continue;
    const all = r.items.flatMap((it) => Object.values(it.size_qty));
    if (!all.length || all.some((q) => q % bags !== 0)) continue;
    for (const it of r.items) for (const k of Object.keys(it.size_qty)) it.size_qty[k] = it.size_qty[k] / bags;
    r.packs_per_ctn = bags;
  }
  return rows;
}


/* ------------------------------------------------------------------
   AUTO-FILL: posted cartons → blocks / rows for the chosen format
   (client packinglist.xlsx = the template; spec "three models"):
     ASSORTED (Model 1)  one block per style ("Product Code:…"); consecutive
                         cartons with the identical size ratio → one range row
     SOLID    (Model 2)  one block per style + colour (label "STYLE NAME COLOUR"),
                         carton-wise rows (identical consecutive cartons grouped),
                         block sub-total per style / colour
     MIXED    (Model 3)  one block per style set, own size columns per block when
                         the size sets differ (kids / adult / women); pack rows from
                         the packing-rule snapshot: PCS/PACK = pieces per polybag,
                         PACK/CTN = polybags in the carton, size qty stored PER PACK
                         (size_qty) and per carton (size_qty_per_ctn) — never both
                         multiplied
   Weights / dimensions come from each carton; cartons only group when their
   contents, weights, dims and polybags are identical.
------------------------------------------------------------------ */
export interface CartonForFormat extends CartonForBuild {
  packing_id: number;
  carton_seq?: number | null;
  /** packing-rule snapshot of the carton's packing order (null = legacy packing without a rule) */
  pieces_per_polybag?: number | null;
  rule_code?: string | null;
  contents: (CartonForBuild['contents'][number] & { size_rank?: number })[];
}
export type CtnNumbering = 'SEQUENCE' | 'CARTON_NO';

export function buildFormatBlocks(cartons: CartonForFormat[], opts: {
  format?: PlType | null; numbering?: CtnNumbering; start?: number;
  orderNo: string | null; soId: number | null;
}) {
  const numbering: CtnNumbering = opts.numbering ?? 'SEQUENCE';
  const start = Math.max(1, Math.trunc(opts.start ?? 1));
  const trailing = (c: CartonForFormat) => { const m = /(\d+)\s*$/.exec(c.carton_no); return m ? Number(m[1]) : NaN; };
  // physical order: packing order, carton sequence inside it, then carton number
  const phys = [...cartons].sort((a, b) => (a.packing_id - b.packing_id)
    || ((a.carton_seq ?? trailing(a) ?? 0) - (b.carton_seq ?? trailing(b) ?? 0))
    || a.carton_no.localeCompare(b.carton_no, undefined, { numeric: true }));

  // size order (mst_size.sort_order) across all cartons
  const rank = new Map<string, number>();
  for (const c of phys) for (const x of c.contents) {
    const r = x.size_rank ?? 9999;
    if (!rank.has(x.size_code) || r < rank.get(x.size_code)!) rank.set(x.size_code, r);
  }
  const sizeSort = (a: string, b: string) => (rank.get(a)! - rank.get(b)!) || a.localeCompare(b, undefined, { numeric: true });

  const lines = (c: CartonForFormat) => new Set(c.contents.map((x) => `${x.style_id}|${x.color_id}`));
  const sizesOf = (c: CartonForFormat) => new Set(c.contents.map((x) => x.size_code));
  let format = opts.format ?? null;
  if (!format) {
    const multi = phys.some((c) => lines(c).size > 1);
    const oneSize = phys.every((c) => sizesOf(c).size === 1);
    format = multi ? 'MIXED' : oneSize ? 'SOLID' : 'ASSORTED';
  }
  const problems: string[] = [];
  if (format !== 'MIXED') {
    const mixedCtns = phys.filter((c) => lines(c).size > 1);
    if (mixedCtns.length) problems.push(`${mixedCtns.length} carton(s) (${mixedCtns.slice(0, 5).map((c) => c.carton_no).join(', ')}) hold several styles / colours — use the Mixed format (Model 3)`);
  }

  // ---- blocks
  const first = (c: CartonForFormat) => c.contents[0];
  const keyOf = (c: CartonForFormat) => format === 'ASSORTED' ? `${first(c).style_id}`
    : format === 'SOLID' ? `${first(c).style_id}|${first(c).color_id}`
    : [...new Set(c.contents.map((x) => x.style_id))].sort((a, b) => a - b).join('+');
  const labelOf = (c: CartonForFormat) => {
    const x = first(c);
    if (format === 'ASSORTED') return `Product Code:${x.style_code}`;
    if (format === 'SOLID') return `${x.style_name || x.style_code} ${x.color_name}`.trim();
    return null;
  };
  const blockMap = new Map<string, { label: string | null; cartons: CartonForFormat[] }>();
  for (const c of phys) {
    const k = keyOf(c);
    const b = blockMap.get(k) ?? { label: labelOf(c), cartons: [] };
    b.cartons.push(c); blockMap.set(k, b);
  }
  const blocksIn = [...blockMap.values()];

  // ---- carton numbers on the list
  const numOf = new Map<number, number>();
  const physNums = phys.map(trailing);
  const physUsable = physNums.every((n) => Number.isFinite(n) && n > 0) && new Set(physNums).size === physNums.length;
  if (numbering === 'CARTON_NO' && physUsable) phys.forEach((c, i) => numOf.set(c.id, physNums[i]));
  else { let n = start; for (const b of blocksIn) for (const c of b.cartons) numOf.set(c.id, n++); }

  const sig = (c: CartonForFormat) => JSON.stringify([
    [...c.contents].sort((a, b) => `${a.style_id}|${a.color_id}|${a.size_code}`.localeCompare(`${b.style_id}|${b.color_id}|${b.size_code}`))
      .map((x) => [x.style_id, x.color_id, x.size_code, Number(x.qty)]),
    Number(c.net_weight_kg ?? 0), Number(c.gross_weight_kg ?? 0),
    Number(c.length_cm ?? 0), Number(c.width_cm ?? 0), Number(c.height_cm ?? 0), Number(c.polybag_qty ?? 0), Number(c.pieces_per_polybag ?? 0)]);

  const allSizes = [...rank.keys()].sort(sizeSort);
  const out: { label: string | null; size_headers: string[] | null; rows: (RowIn & { ctn_from: number })[] }[] = [];
  const blockSizeSets: string[][] = [];
  for (const b of blocksIn) {
    const rows: (RowIn & { ctn_from: number })[] = [];
    let prevSig = '', prevN = -1;
    const used = new Set<string>();
    for (const c of b.cartons) {
      const n = numOf.get(c.id)!;
      const sg = sig(c);
      const last = rows[rows.length - 1];
      for (const x of c.contents) used.add(x.size_code);
      if (last && sg === prevSig && n === prevN + 1) {
        last.no_of_ctns += 1; last.source_carton_ids!.push(c.id);
      } else {
        const byItem = new Map<string, ItemIn>();
        for (const x of [...c.contents].sort((a, b2) => sizeSort(a.size_code, b2.size_code))) {
          const k = `${x.style_id}|${x.color_id}`;
          let it = byItem.get(k);
          if (!it) {
            it = { so_id: opts.soId, order_no: opts.orderNo, style_id: x.style_id, style_no: x.style_code, style_name: x.style_name,
                   color_id: x.color_id, colour: x.color_name, size_qty: {} };
            byItem.set(k, it);
          }
          it.size_qty[x.size_code] = (it.size_qty[x.size_code] || 0) + Number(x.qty);
        }
        const row: RowIn & { ctn_from: number } = {
          ctn_from: n, ctn_to: null, no_of_ctns: 1, row_type: null,
          pcs_per_pack: null, packs_per_ctn: null, pcs_per_ctn: null,
          net_wt_per_ctn: c.net_weight_kg != null ? Number(c.net_weight_kg) : null,
          gross_wt_per_ctn: c.gross_weight_kg != null ? Number(c.gross_weight_kg) : null,
          length_cm: c.length_cm != null ? Number(c.length_cm) : null,
          width_cm: c.width_cm != null ? Number(c.width_cm) : null,
          height_cm: c.height_cm != null ? Number(c.height_cm) : null,
          remarks: null, source_carton_ids: [c.id], items: [...byItem.values()],
        };
        if (format === 'MIXED') applyRulePack(row, Number(c.polybag_qty || 0), c.pieces_per_polybag ?? null, c.rule_code ?? null);
        rows.push(row);
      }
      prevSig = sg; prevN = n;
    }
    blockSizeSets.push([...used].sort(sizeSort));
    out.push({ label: b.label, size_headers: null, rows });
  }
  // Model 3: blocks with different size sets (kids 3A–14A / adult S–XXL / women 1–5) carry their own size columns
  if (format === 'MIXED' && new Set(blockSizeSets.map((s) => s.join('|'))).size > 1)
    out.forEach((b, i) => { b.size_headers = blockSizeSets[i]; });
  const sorted = out.flatMap((b) => b.rows).sort((a, b) => a.ctn_from - b.ctn_from);
  const hasGaps = sorted.some((r, i) => i > 0 && r.ctn_from !== sorted[i - 1].ctn_from + sorted[i - 1].no_of_ctns);
  return { pl_type: format, size_headers: allSizes, blocks: out, has_gaps: hasGaps, problems,
           numbering: numbering === 'CARTON_NO' && !physUsable ? 'SEQUENCE' as CtnNumbering : numbering };
}

/**
 * Model 3 pack row from the packing rule: pieces per polybag (PCS/PACK) × polybags in the
 * carton (PACK/CTN). Only when the carton is exactly full polybags (pcs = PCS/PACK × PACK/CTN)
 * and every size qty divides by the polybag count; otherwise the row stays a size-ratio
 * carton (PCS/CTN). Without a rule (legacy packing) the polybag count alone decides.
 */
export function applyRulePack(r: RowIn, bags: number, piecesPerBag: number | null, ruleCode: string | null) {
  if (!(bags > 1)) return r;
  const all = r.items.flatMap((it) => Object.values(it.size_qty));
  const total = all.reduce((a, q) => a + q, 0);
  if (!all.length || all.some((q) => q % bags !== 0)) return r;
  const perPack = total / bags;
  if (piecesPerBag != null && (piecesPerBag <= 1 || perPack !== piecesPerBag)) return r;
  for (const it of r.items) for (const k of Object.keys(it.size_qty)) it.size_qty[k] = it.size_qty[k] / bags;
  r.packs_per_ctn = bags;
  r.remarks = `Pack basis: ${perPack} pcs/pack × ${bags} packs/ctn${ruleCode ? ` (rule ${ruleCode})` : ''}`;
  return r;
}
