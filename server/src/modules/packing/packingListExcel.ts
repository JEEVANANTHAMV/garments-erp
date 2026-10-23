import XLSX from 'xlsx';
import type { ComputedList, SummaryGroup, PlType, RowOut } from './packingListCalc.js';

/**
 * ONE layout for the packing list in the client's template (packinglist.xlsx), used by
 * BOTH the Excel download and the on-screen / printed preview (GET /packing-lists/:id
 * returns it as `layout`), so the print view, the Excel file and the template agree cell
 * for cell.
 *
 *   ASSORTED = sheet "Packinglist-assat"  (Model 1 — carton range + size ratio)
 *     CTN NO | ORDER NO | COLOUR | sizes | PCS/ CTN | TOTAL Ctns | Total Qty | Net Wt | Gr.Wt | Total Net Wt | Total Grs Wt
 *   SOLID    = sheet "VANPUR-solid"       (Model 2 — carton-wise size grid, block per style / colour)
 *     CTN NO | ORDER NO | STYLE NAME | COLOUR | QUANTITY / SIZE | PCS/ CTN | TOT CTNS | TOT PCS | WEIGHT/CTN NETT GROSS | TOTAL WEIGHT NETT GROSS
 *   MIXED    = sheet "PACKINGLIST- 3"     (Model 3 — assortment / pack ratio)
 *     CTN NO | Order no | style no | COLOUR | sizes | PCS/ PACK | PACK/ CTNS (pcs/pack, packs/ctn) | TOT Ctns | Total Qty | Net Wt | Gr.Wt | Total Net Wt | Total Grs Wt
 *
 * Common: export header block, block separator rows (next block's label + size labels +
 * previous block's sub-totals), last sub-total and grand-total rows, ORDER / Shipped / Diff
 * per style (Diff = Order − Shipped, as on the sheet; an "Excess" row is added only when
 * shipped > order so over-shipment is never hidden in a negative Diff), and the footer
 * (TOTAL CARTONS / PIECES / NET / GROSS / CARTONS MEASUREMENT / CBM) in each sheet's order.
 * Derived cells carry live formulas (with server-computed cached values) like the client's
 * sheet; every number comes from the server calculation (packingListCalc.ts).
 */

export interface PlHeaderForExport {
  pl_no: string; pl_type: PlType;
  exporter_details: string | null;
  invoice_no: string | null; invoice_date: string | null;
  buyer_order_no: string | null; buyer_order_date: string | null;
  other_references: string | null;
  consignee_details: string | null;
  notify_label: string | null; notify_details: string | null;
  country_of_origin: string | null; country_of_destination: string | null;
  pre_carriage_by: string | null; place_of_receipt: string | null;
  vessel_flight_no: string | null; port_of_loading: string | null;
  port_of_discharge: string | null; final_destination: string | null;
  terms_of_delivery: string | null; terms_of_payment: string | null;
}

/** Cell style tag (Excel ignores it; the preview uses it). c = centred, r = right, b = bold, sm = small print. */
export type CellStyle = 'title' | 'lbl' | 'th' | 'sub' | 'grand' | 'blk' | 'c' | 'cb' | 'r' | 'rb' | 'b' | 'sm' | 'smb';
/** d = decimals shown (preview) / written as the Excel number format */
type Cell = { v: string | number; f?: string; s?: CellStyle; d?: number };
export interface PlLayout {
  type: string; n_rows: number; n_cols: number; widths: number[];
  cells: { r: number; c: number; v: string | number; s?: CellStyle; rs?: number; cs?: number; d?: number }[];
  /** grid = every cell bordered (carton table, summary); box = outline only (header boxes) */
  boxes: { r1: number; c1: number; r2: number; c2: number; mode: 'grid' | 'box' }[];
}

const col = (c: number) => XLSX.utils.encode_col(c);
const ref = (r: number, c: number) => `${col(c)}${r + 1}`;      // 0-based → A1
const lines = (t: string | null | undefined) => (t ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const dmy = (d: string | null | undefined) => {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(d);
};
const sizeVal = (s: string): string | number => (/^\d+$/.test(s) ? Number(s) : s);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r5 = (n: number) => Math.round(n * 100000) / 100000;

export class SheetBuilder {
  cells = new Map<string, Cell & { r: number; c: number }>();
  merges: XLSX.Range[] = [];
  boxes: PlLayout['boxes'] = [];
  maxR = 0; maxC = 0;
  set(r: number, c: number, v: string | number | null | undefined, f?: string, s?: CellStyle, d?: number) {
    if (v == null || v === '') { if (!f && !s) return; v = f ? 0 : ''; }
    this.cells.set(ref(r, c), { r, c, v, ...(f ? { f } : {}), ...(s ? { s } : {}), ...(d != null && typeof v === 'number' ? { d } : {}) });
    this.maxR = Math.max(this.maxR, r); this.maxC = Math.max(this.maxC, c);
  }
  merge(r1: number, c1: number, r2: number, c2: number) {
    if (r1 === r2 && c1 === c2) return;
    this.merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  }
  box(r1: number, c1: number, r2: number, c2: number, mode: 'grid' | 'box') { this.boxes.push({ r1, c1, r2, c2, mode }); }
  toSheet(widths: number[]): XLSX.WorkSheet {
    const ws: XLSX.WorkSheet = {};
    for (const [a, cell] of this.cells) {
      if (cell.v === '' && !cell.f) continue;
      ws[a] = typeof cell.v === 'number'
        ? { t: 'n', v: cell.v, ...(cell.f ? { f: cell.f } : {}), ...(cell.d != null ? { z: cell.d ? `0.${'0'.repeat(cell.d)}` : '0' } : {}) }
        : { t: 's', v: cell.v, ...(cell.f ? { f: cell.f } : {}) };
    }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: this.maxR, c: this.maxC } });
    ws['!merges'] = this.merges;
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    return ws;
  }
  toLayout(type: string, widths: number[]): PlLayout {
    const span = new Map<string, { rs: number; cs: number }>();
    for (const m of this.merges) span.set(ref(m.s.r, m.s.c), { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 });
    const cells: PlLayout['cells'] = [];
    for (const [a, cell] of this.cells) {
      const sp = span.get(a);
      cells.push({ r: cell.r, c: cell.c, v: cell.v, ...(cell.s ? { s: cell.s } : {}), ...(cell.d != null ? { d: cell.d } : {}), ...(sp && sp.rs > 1 ? { rs: sp.rs } : {}), ...(sp && sp.cs > 1 ? { cs: sp.cs } : {}) });
    }
    // merged ranges without a value still need their span in the preview
    for (const m of this.merges) {
      const a = ref(m.s.r, m.s.c);
      if (!this.cells.has(a)) cells.push({ r: m.s.r, c: m.s.c, v: '', rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 });
    }
    cells.sort((x, y) => x.r - y.r || x.c - y.c);
    return { type, n_rows: this.maxR + 1, n_cols: widths.length, widths, cells, boxes: this.boxes };
  }
}

function buildSheet(h: PlHeaderForExport, c: ComputedList, summary: SummaryGroup[]) {
  const type = h.pl_type;
  const sb = new SheetBuilder();

  // ---------- column plan (as the three sheets)
  const leftTitles = type === 'ASSORTED' ? ['ORDER NO', 'COLOUR']
    : type === 'SOLID' ? ['ORDER NO', 'STYLE NAME', 'COLOUR'] : ['Order no', 'style no', 'COLOUR'];
  const nSizes = Math.max(1, ...c.blocks.map((b) => b.effective_size_headers.length));
  const S0 = 3 + leftTitles.length;                 // first size column
  const SZ = (i: number) => S0 + i;
  const after = S0 + nSizes;
  const K = type === 'MIXED'
    ? { pack: after, pcs: after + 1, packs: after + 2, ctns: after + 3, qty: after + 4, net: after + 5, gross: after + 6, tnet: after + 7, tgross: after + 8 }
    : { pack: -1, pcs: after, packs: -1, ctns: after + 1, qty: after + 2, net: after + 3, gross: after + 4, tnet: after + 5, tgross: after + 6 };
  const lastCol = K.tgross;
  const colOrder = type === 'ASSORTED' ? { order: 3, style: -1, colour: 4 } : { order: 3, style: 4, colour: 5 };

  // ---------- header block (rows 0..18)
  const R = Math.max(9, Math.floor((lastCol + 1) * 0.5) + 1);   // right-hand column
  const MID = S0;                                               // middle column
  sb.set(0, 0, 'PACKING LIST', undefined, 'title'); sb.merge(0, 0, 0, lastCol);
  sb.set(1, 0, 'Exporter', undefined, 'lbl'); sb.set(1, R, 'Invoice No. & Date', undefined, 'lbl');
  lines(h.exporter_details).slice(0, 5).forEach((l, i) => sb.set(2 + i, 0, l, undefined, i === 0 ? 'blk' : undefined));
  if (h.invoice_no || h.invoice_date) sb.set(2, R, `${h.invoice_no ?? ''}${h.invoice_date ? `   DT: ${dmy(h.invoice_date)}` : ''}`.trim());
  sb.set(3, R, "Buyer's Order No. & Date.", undefined, 'lbl');
  if (h.buyer_order_no || h.buyer_order_date) sb.set(4, R, `PO NO: ${h.buyer_order_no ?? ''}${h.buyer_order_date ? `  DT: ${dmy(h.buyer_order_date)}` : ''}`);
  else if (type === 'MIXED') sb.set(4, R, 'AS PER BELOW');
  sb.set(5, R, 'Other Reference(s)', undefined, 'lbl');
  lines(h.other_references).slice(0, 1).forEach((l, i) => sb.set(6 + i, R, l));
  sb.set(7, 0, 'Consignee', undefined, 'lbl'); sb.set(7, R, h.notify_label || 'Notify Party :-', undefined, 'lbl');
  lines(h.consignee_details).slice(0, 5).forEach((l, i) => sb.set(8 + i, 0, l, undefined, i === 0 ? 'blk' : undefined));
  lines(h.notify_details).slice(0, 3).forEach((l, i) => sb.set(8 + i, R, l));
  sb.set(11, R, 'Country of origin of goods', undefined, 'lbl'); sb.set(11, R + 4, 'Country of final destination', undefined, 'lbl');
  sb.set(12, R, h.country_of_origin || 'INDIA'); sb.set(12, R + 4, h.country_of_destination);
  sb.merge(12, R, 12, R + 3); sb.merge(12, R + 4, 12, lastCol);
  sb.set(13, 0, 'Pre-carriage by', undefined, 'lbl'); sb.set(13, MID, 'Place of receipt by pre-carrier', undefined, 'lbl'); sb.set(13, R, 'Terms of Delivery and Payment', undefined, 'lbl');
  sb.set(14, 0, h.pre_carriage_by); sb.set(14, MID, h.place_of_receipt);
  // printed exactly as entered (sheet 1 "CPT BY AIR -BRUSSELS", sheet 2 "DELIVERY: FOB …", sheet 3 "T/T PAYMENT")
  const terms = [...lines(h.terms_of_delivery), ...lines(h.terms_of_payment)];
  terms.slice(0, 5).forEach((l, i) => sb.set(14 + i, R, l));
  sb.set(15, 0, 'Vessel/Flight No.', undefined, 'lbl'); sb.set(15, MID, 'Port of Loading', undefined, 'lbl');
  sb.set(16, 0, h.vessel_flight_no); sb.set(16, MID, h.port_of_loading);
  sb.set(17, 0, 'Port of Discharge', undefined, 'lbl'); sb.set(17, MID, 'Final Destination', undefined, 'lbl');
  sb.set(18, 0, h.port_of_discharge); sb.set(18, MID, h.final_destination);
  for (const r of [14, 16, 18]) { sb.merge(r, 0, r, MID - 1); sb.merge(r, MID, r, R - 1); }
  // header boxes as on the sheet
  sb.box(1, 0, 6, R - 1, 'box'); sb.box(1, R, 4, lastCol, 'box'); sb.box(5, R, 6, lastCol, 'box');
  sb.box(7, 0, 12, R - 1, 'box'); sb.box(7, R, 10, lastCol, 'box'); sb.box(11, R, 12, R + 3, 'box'); sb.box(11, R + 4, 12, lastCol, 'box');
  for (const r of [13, 15, 17]) { sb.box(r, 0, r + 1, MID - 1, 'box'); sb.box(r, MID, r + 1, R - 1, 'box'); }
  sb.box(13, R, 18, lastCol, 'box');

  // ---------- table header (rows 19, 20)
  const H1 = 19, H2 = 20;
  sb.set(H1, 0, 'CTN NO', undefined, 'th'); sb.merge(H1, 0, type === 'SOLID' ? H2 : H1, 2);
  leftTitles.forEach((t, i) => { sb.set(H1, 3 + i, t, undefined, 'th'); if (type === 'SOLID') sb.merge(H1, 3 + i, H2, 3 + i); });
  sb.set(H1, S0, type === 'SOLID' ? 'QUANTITY  / SIZE' : 'SIZE', undefined, 'th'); sb.merge(H1, S0, H1, S0 + nSizes - 1);
  if (type === 'MIXED') {
    sb.set(H1, K.pack, 'PCS/ PACK', undefined, 'th'); sb.set(H1, K.pcs, 'PACK/ CTNS', undefined, 'th'); sb.merge(H1, K.pcs, H1, K.packs);
    sb.set(H1, K.ctns, 'TOT Ctns', undefined, 'th'); sb.set(H1, K.qty, 'Total Qty', undefined, 'th');
    sb.set(H1, K.net, 'Net Wt', undefined, 'th'); sb.set(H1, K.gross, 'Gr.Wt', undefined, 'th');
    sb.set(H1, K.tnet, 'Total   Net Wt', undefined, 'th'); sb.set(H1, K.tgross, 'Total  Grs Wt', undefined, 'th');
  } else if (type === 'SOLID') {
    sb.set(H1, K.pcs, 'PCS/ CTN', undefined, 'th'); sb.set(H1, K.ctns, 'TOT CTNS', undefined, 'th'); sb.set(H1, K.qty, 'TOT PCS', undefined, 'th');
    for (const k of [K.pcs, K.ctns, K.qty]) sb.merge(H1, k, H2, k);
    sb.set(H1, K.net, 'WEIGHT/CTN', undefined, 'th'); sb.merge(H1, K.net, H1, K.gross);
    sb.set(H1, K.tnet, 'TOTAL WEIGHT', undefined, 'th'); sb.merge(H1, K.tnet, H1, K.tgross);
    sb.set(H2, K.net, 'NETT', undefined, 'th'); sb.set(H2, K.gross, 'GROSS', undefined, 'th');
    sb.set(H2, K.tnet, 'NETT', undefined, 'th'); sb.set(H2, K.tgross, 'GROSS', undefined, 'th');
  } else {
    sb.set(H1, K.pcs, 'PCS/ CTN', undefined, 'th'); sb.set(H1, K.ctns, 'TOTAL Ctns', undefined, 'th'); sb.set(H1, K.qty, 'Total Qty', undefined, 'th');
    sb.set(H1, K.net, 'Net Wt', undefined, 'th'); sb.set(H1, K.gross, 'Gr.Wt', undefined, 'th');
    sb.set(H1, K.tnet, 'Total   Net Wt', undefined, 'th'); sb.set(H1, K.tgross, 'Total  Grs Wt', undefined, 'th');
  }
  const writeSizeLabels = (r: number, labels: string[]) => labels.forEach((l, i) => sb.set(r, SZ(i), sizeVal(l), undefined, 'th'));
  const blockLabel = (b: ComputedList['blocks'][number]) => {
    if (b.label) return b.label;
    const it = b.rows[0]?.items[0];
    if (type === 'ASSORTED' && it) return `Product Code:${it.style_no ?? it.style_name ?? ''}`;
    return null;
  };

  let r = H2;
  if (c.blocks[0]) {
    writeSizeLabels(H2, c.blocks[0].effective_size_headers);
    const lbl = blockLabel(c.blocks[0]);
    if (type === 'ASSORTED') { if (lbl) { sb.set(H2, 0, lbl, undefined, 'th'); sb.merge(H2, 0, H2, S0 - 1); } }
    else if (lbl) { r += 1; sb.set(r, 0, lbl, undefined, 'blk'); sb.merge(r, 0, r, S0 - 1); }
  }
  r += 1;

  // ---------- rows per block
  const subtotalRefs: number[] = [];
  const writeSubtotals = (at: number, from: number, to: number) => {
    const b = c.blocks[subtotalRefs.length];
    for (const k of [K.ctns, K.qty, K.tnet, K.tgross]) {
      const v = k === K.ctns ? b.total_cartons : k === K.qty ? b.total_qty : k === K.tnet ? b.total_net_wt : b.total_gross_wt;
      sb.set(at, k, v, to >= from ? `SUM(${ref(from, k)}:${ref(to, k)})` : undefined, 'sub');
    }
    subtotalRefs.push(at);
  };

  let currentHeads: string[] = [];
  let prevItem: { order: string; style: string; colour: string } | null = null;   // SOLID ditto marks
  const styleText = (it: RowOut['items'][number]) => (type === 'SOLID' ? (it.style_no || it.style_name) : [it.style_no, it.style_name].filter(Boolean).join(' - ')) ?? '';
  const writeRow = (row: RowOut) => {
    const top = r;
    const n = row.items.length;
    row.items.forEach((it, ii) => {
      const rr = top + ii;
      const cur = { order: it.order_no ?? '', style: styleText(it), colour: it.colour ?? '' };
      // the solid sheet repeats style / colour with a ditto mark (") under the first row of the block
      const ditto = (k: 'order' | 'style' | 'colour') => (type === 'SOLID' && prevItem && cur[k] && prevItem[k] === cur[k] ? '"' : cur[k]);
      sb.set(rr, colOrder.order, ditto('order'));
      if (colOrder.style >= 0) sb.set(rr, colOrder.style, ditto('style'));
      sb.set(rr, colOrder.colour, ditto('colour'));
      prevItem = cur;
      currentHeads.forEach((hd, i) => { const q = it.size_qty[hd]; if (q) sb.set(rr, SZ(i), q); });
      if (type === 'MIXED' && row.packs_per_ctn) sb.set(rr, K.pack, it.unit_qty, `SUM(${ref(rr, SZ(0))}:${ref(rr, SZ(nSizes - 1))})`);
      // MIXED carton without packs holding several lines: pieces per line under PACK/CTNS (sheet 3, carton 23)
      if (type === 'MIXED' && !row.packs_per_ctn && n > 1) {
        sb.set(rr, K.pcs, it.qty_per_ctn, `SUM(${ref(rr, SZ(0))}:${ref(rr, SZ(nSizes - 1))})`);
        sb.merge(rr, K.pcs, rr, K.packs);
      }
    });
    const bottom = top + n - 1;
    sb.set(top, 0, row.ctn_from); sb.set(top, 1, '-');
    sb.set(top, 2, row.ctn_to, `${ref(top, 0)}+${ref(top, K.ctns)}-1`);
    if (type === 'MIXED') {
      if (row.packs_per_ctn) {
        sb.set(top, K.pcs, row.pcs_per_pack!, `SUM(${ref(top, K.pack)}:${ref(bottom, K.pack)})`);
        sb.set(top, K.packs, row.packs_per_ctn);
        sb.set(top, K.qty, row.total_qty, `${ref(top, K.pcs)}*${ref(top, K.packs)}*${ref(top, K.ctns)}`);
      } else if (n > 1) {
        sb.set(top, K.qty, row.total_qty, `SUM(${ref(top, K.pcs)}:${ref(bottom, K.pcs)})*${ref(top, K.ctns)}`);
      } else {
        sb.set(top, K.pcs, row.pcs_per_ctn, `SUM(${ref(top, SZ(0))}:${ref(bottom, SZ(nSizes - 1))})`);
        sb.merge(top, K.pcs, top, K.packs);
        sb.set(top, K.qty, row.total_qty, `${ref(top, K.ctns)}*${ref(top, K.pcs)}`);
      }
    } else {
      sb.set(top, K.pcs, row.pcs_per_ctn, `SUM(${ref(top, SZ(0))}:${ref(top, SZ(nSizes - 1))})`);
      sb.set(top, K.qty, row.total_qty, `${ref(top, K.pcs)}*${ref(top, K.ctns)}`);
    }
    sb.set(top, K.ctns, row.no_of_ctns);
    sb.set(top, K.net, row.net_wt_per_ctn ?? 0);
    sb.set(top, K.gross, row.gross_wt_per_ctn ?? 0);
    sb.set(top, K.tnet, row.total_net_wt, `${ref(top, K.ctns)}*${ref(top, K.net)}`);
    sb.set(top, K.tgross, row.total_gross_wt, `${ref(top, K.ctns)}*${ref(top, K.gross)}`);
    if (n > 1) {
      const vcols = [0, 1, 2, ...(type === 'MIXED' ? (row.packs_per_ctn ? [K.pcs, K.packs] : []) : [K.pcs]), K.ctns, K.qty, K.net, K.gross, K.tnet, K.tgross];
      for (const k of vcols) sb.merge(top, k, bottom, k);
    }
    r = bottom + 1;
  };

  c.blocks.forEach((b, bi) => {
    currentHeads = b.effective_size_headers;
    prevItem = null;
    const first = r;
    b.rows.forEach(writeRow);
    const last = r - 1;
    r += 1;                                  // blank line like the client's sheet
    const nb = c.blocks[bi + 1];
    if (nb) {                                // separator: next label + sizes, this block's sub-totals
      const lbl = blockLabel(nb);
      if (lbl) { sb.set(r, 0, lbl, undefined, 'blk'); sb.merge(r, 0, r, S0 - 1); }
      writeSizeLabels(r, nb.effective_size_headers);
      writeSubtotals(r, first, last);
      r += 1;
    } else {
      writeSubtotals(r, first, last);
      r += 1;
    }
  });
  const grandRow = r;
  const T = c.totals;
  for (const k of [K.ctns, K.qty, K.tnet, K.tgross]) {
    const v = k === K.ctns ? T.total_cartons : k === K.qty ? T.total_qty : k === K.tnet ? T.total_net_wt : T.total_gross_wt;
    sb.set(grandRow, k, v, subtotalRefs.length ? `SUM(${subtotalRefs.map((x) => ref(x, k)).join(',')})` : undefined, 'grand');
  }
  sb.box(H1, 0, grandRow, lastCol, 'grid');
  r = grandRow + 2;

  // ---------- Order / Shipped / Diff summary (sheet 1; other formats when the order qty is known)
  const withOrder = summary.filter((g) => g.order_source !== 'NONE');
  if (withOrder.length || type === 'ASSORTED') {
    const labelCol = S0 - 1;
    const styleCount = new Map<string, number>();
    for (const g of summary) { const k = g.style_no || g.style_name || ''; styleCount.set(k, (styleCount.get(k) ?? 0) + 1); }
    for (const g of summary) {
      const sizes = g.sizes.slice(0, Math.max(nSizes, g.sizes.length));
      const totCol = SZ(sizes.length);
      const st = g.style_no || g.style_name || '';
      sb.set(r, labelCol, (styleCount.get(st) ?? 0) > 1 ? [st, g.colour].filter(Boolean).join(' / ') : sizeVal(st), undefined, 'th');
      writeSizeLabels(r, sizes); sb.set(r, totCol, 'TOTAL', undefined, 'th');
      const rows: [string, (h: string) => number, number][] = [
        ['ORDER Qty', (hd) => g.order[hd] ?? 0, g.order_total],
        ['Shipped Qty', (hd) => g.shipped[hd] ?? 0, g.shipped_total],
      ];
      rows.forEach(([lbl, fn, tot], i) => {
        const rr = r + 1 + i;
        sb.set(rr, labelCol, lbl, undefined, 'lbl');
        sizes.forEach((hd, j) => sb.set(rr, SZ(j), fn(hd)));
        sb.set(rr, totCol, tot, `SUM(${ref(rr, SZ(0))}:${ref(rr, SZ(sizes.length - 1))})`, 'sub');
      });
      const dr = r + 3;
      sb.set(dr, labelCol, 'Diff', undefined, 'lbl');
      sizes.forEach((hd, j) => sb.set(dr, SZ(j), g.diff[hd] ?? 0, `${ref(r + 1, SZ(j))}-${ref(r + 2, SZ(j))}`));
      sb.set(dr, totCol, g.diff_total, `${ref(r + 1, totCol)}-${ref(r + 2, totCol)}`, 'sub');
      let endRow = dr;
      if (g.excess_total > 0) {           // over-shipment shown on its own row, never only as a negative Diff
        const er = dr + 1;
        sb.set(er, labelCol, 'Excess (Shipped > Order)', undefined, 'lbl');
        sizes.forEach((hd, j) => sb.set(er, SZ(j), g.excess[hd] ?? 0, `MAX(0,${ref(r + 2, SZ(j))}-${ref(r + 1, SZ(j))})`));
        sb.set(er, totCol, g.excess_total, `SUM(${ref(er, SZ(0))}:${ref(er, SZ(sizes.length - 1))})`, 'sub');
        endRow = er;
      }
      sb.box(r, labelCol, endRow, totCol, 'grid');
      r = endRow + 2;
    }
    r += 1;
  }

  // ---------- footer totals, in each sheet's order / columns
  const meas = c.measurements;
  const cbm = Number(r5(T.total_cbm).toFixed(5));
  const totalsFoot = {
    CARTONS: ['TOTAL CARTONS', T.total_cartons, type === 'SOLID' ? 'CARTONS' : 'CTNS', K.ctns] as const,
    PIECES: ['TOTAL PIECES', T.total_qty, 'PCS', K.qty] as const,
    NET: ['TOTAL NET WEIGHT', r3(T.total_net_wt), 'KGS', K.tnet] as const,
    GROSS: ['TOTAL GROSS WEIGHT', r3(T.total_gross_wt), 'KGS', K.tgross] as const,
  };
  const order = type === 'SOLID' ? ['PIECES', 'CARTONS', 'NET', 'GROSS'] as const : ['CARTONS', 'PIECES', 'NET', 'GROSS'] as const;
  const V = type === 'ASSORTED' ? 5 : type === 'SOLID' ? 6 : 4;            // value column F / G / E
  const sigCol = type === 'ASSORTED' ? lastCol - 5 : lastCol - 3;
  const sigRow = type === 'SOLID' ? 2 : 1;
  order.forEach((k, i) => {
    const [lbl, v, unit, kc] = totalsFoot[k];
    sb.set(r + i, 0, `${lbl}  :`, undefined, 'lbl'); sb.merge(r + i, 0, r + i, V - 1);
    sb.set(r + i, V, v, ref(grandRow, kc), 'sub'); if (type !== 'MIXED') sb.merge(r + i, V, r + i, V + 1);
    sb.set(r + i, type === 'MIXED' ? V + 1 : V + 2, unit);
  });
  sb.set(r + sigRow, sigCol, 'Signature & Date', undefined, 'lbl');
  // sheet 1 shows the CBM beside the net weight
  if (type === 'ASSORTED') { sb.set(r + 2, V + 5, cbm, undefined, 'sub'); sb.set(r + 2, V + 6, 'CBM'); }
  r += order.length;
  if (type === 'ASSORTED') {
    const txt = meas.map((m) => `${m.dims} - ${m.cartons} CARTONS`).join(' / ') || '-';
    sb.set(r, 0, `CARTONS MEASUREMENT  :   ${txt}`, undefined, 'lbl'); sb.merge(r, 0, r, lastCol);
  } else if (type === 'SOLID') {
    const txt = meas.map((m) => `${m.dims} - CM - ${m.cartons} CTNS`).join(' / ') || '-';
    sb.set(r, 0, 'CARTONS MEASUREMENT  :', undefined, 'lbl'); sb.merge(r, 0, r, V - 1);
    sb.set(r, V, txt); sb.merge(r, V, r, lastCol);
    sb.set(r + 1, 0, 'CBM', undefined, 'lbl'); sb.set(r + 1, 4, ':'); sb.set(r + 1, V, cbm, undefined, 'sub'); sb.set(r + 1, V + 1, 'CBM');
  } else {
    const txt = meas.map((m) => `${m.dims} - CM - ${m.cartons} CTNS`).join(' / ') || '-';
    sb.set(r, 0, `CARTONS MEASUREMENT:   ${txt}`, undefined, 'lbl'); sb.merge(r, 0, r, 5);
    sb.set(r, 6, cbm, undefined, 'sub'); sb.set(r, 7, 'CBM');
  }

  // ---------- widths
  const widths: number[] = [];
  for (let i = 0; i <= Math.max(lastCol, sb.maxC); i++) {
    if (i === 0 || i === 2) widths.push(6);
    else if (i === 1) widths.push(2);
    else if (i < S0) widths.push(i === colOrder.style ? 30 : 14);
    else if (i < after) widths.push(6);
    else widths.push(9);
  }
  return { sb, widths };
}

/** Cell grid of the packing list for the preview / print view (same cells as the Excel). */
export function buildPackingListLayout(h: PlHeaderForExport, c: ComputedList, summary: SummaryGroup[]): PlLayout {
  const { sb, widths } = buildSheet(h, c, summary);
  return sb.toLayout(h.pl_type, widths);
}

export function buildPackingListWorkbook(h: PlHeaderForExport, c: ComputedList, summary: SummaryGroup[]): Buffer {
  const { sb, widths } = buildSheet(h, c, summary);
  const ws = sb.toSheet(widths);
  ws['!pageSetup'] = { orientation: 'landscape' } as any;
  const wb = XLSX.utils.book_new();
  // sheet names as in packinglist.xlsx
  const name = { ASSORTED: 'Packinglist-assat', SOLID: 'Packinglist-solid', MIXED: 'PACKINGLIST- 3' }[h.pl_type];
  XLSX.utils.book_append_sheet(wb, ws, name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
