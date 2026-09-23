import XLSX from 'xlsx';
import type { ComputedList, SummaryGroup, PlType, RowOut } from './packingListCalc.js';

/**
 * Excel export in the client's packing-list layout (packinglist.xlsx):
 *   - common export header block (exporter / invoice / buyer order / consignee /
 *     notify party / countries / pre-carriage / vessel / ports / terms)
 *   - carton table whose columns depend on the list type
 *       ASSORTED  CTN NO | ORDER NO | COLOUR | sizes | PCS/CTN | TOTAL Ctns | Total Qty | Net Wt | Gr.Wt | Total Net Wt | Total Grs Wt
 *       SOLID     CTN NO | ORDER NO | STYLE NAME | COLOUR | sizes | PCS/CTN | TOT CTNS | TOT PCS | WEIGHT/CTN NETT/GROSS | TOTAL WEIGHT NETT/GROSS
 *       MIXED     CTN NO | Order no | style no | COLOUR | sizes | PCS/PACK | PACK/CTNS (pcs, packs) | TOT Ctns | Total Qty | Net Wt | Gr.Wt | Total Net Wt | Total Grs Wt
 *   - block separator rows carrying the next block's label + size labels and the
 *     previous block's sub-totals, a final sub-total and a grand-total row
 *   - Order / Shipped / Diff summary per order/style/colour
 *   - TOTAL CARTONS / PIECES / NET / GROSS / CARTONS MEASUREMENT / CBM footer
 * Derived cells are written as live formulas (with cached values) like the
 * client's sheet, so the file keeps working when they edit it in Excel.
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

type Cell = { v: string | number; f?: string };

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

class SheetBuilder {
  cells = new Map<string, Cell>();
  merges: XLSX.Range[] = [];
  maxR = 0; maxC = 0;
  set(r: number, c: number, v: string | number | null | undefined, f?: string) {
    if (v == null || v === '') { if (!f) return; v = 0; }
    this.cells.set(ref(r, c), f ? { v, f } : { v });
    this.maxR = Math.max(this.maxR, r); this.maxC = Math.max(this.maxC, c);
  }
  merge(r1: number, c1: number, r2: number, c2: number) {
    if (r1 === r2 && c1 === c2) return;
    this.merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  }
  toSheet(widths: number[]): XLSX.WorkSheet {
    const ws: XLSX.WorkSheet = {};
    for (const [a, cell] of this.cells) {
      ws[a] = typeof cell.v === 'number'
        ? { t: 'n', v: cell.v, ...(cell.f ? { f: cell.f } : {}) }
        : { t: 's', v: cell.v, ...(cell.f ? { f: cell.f } : {}) };
    }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: this.maxR, c: this.maxC } });
    ws['!merges'] = this.merges;
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    return ws;
  }
}

export function buildPackingListWorkbook(h: PlHeaderForExport, c: ComputedList, summary: SummaryGroup[]): Buffer {
  const type = h.pl_type;
  const sb = new SheetBuilder();

  // ---------- column plan
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
  sb.set(0, 0, 'PACKING LIST'); sb.merge(0, 0, 0, lastCol);
  sb.set(1, 0, 'Exporter'); sb.set(1, R, 'Invoice No. & Date');
  lines(h.exporter_details).slice(0, 5).forEach((l, i) => sb.set(2 + i, 0, l));
  if (h.invoice_no || h.invoice_date) sb.set(2, R, `${h.invoice_no ?? ''}${h.invoice_date ? `  DT: ${dmy(h.invoice_date)}` : ''}`.trim());
  if (h.buyer_order_no || h.buyer_order_date) sb.set(4, R, `PO NO: ${h.buyer_order_no ?? ''}${h.buyer_order_date ? `  DT: ${dmy(h.buyer_order_date)}` : ''}`);
  sb.set(5, R, 'Other Reference(s)');
  lines(h.other_references).slice(0, 1).forEach((l, i) => sb.set(6 + i, R, l));
  sb.set(7, 0, 'Consignee'); sb.set(7, R, h.notify_label || 'Notify Party :-');
  lines(h.consignee_details).slice(0, 5).forEach((l, i) => sb.set(8 + i, 0, l));
  lines(h.notify_details).slice(0, 3).forEach((l, i) => sb.set(8 + i, R, l));
  sb.set(11, R, 'Country of origin of goods'); sb.set(11, R + 4, 'Country of final destination');
  sb.set(12, R, h.country_of_origin || 'INDIA'); sb.set(12, R + 4, h.country_of_destination);
  sb.merge(12, R, 12, R + 3); sb.merge(12, R + 4, 12, lastCol);
  sb.set(13, 0, 'Pre-carriage by'); sb.set(13, MID, 'Place of receipt by pre-carrier'); sb.set(13, R, 'Terms of Delivery and Payment');
  sb.set(14, 0, h.pre_carriage_by); sb.set(14, MID, h.place_of_receipt);
  const terms = [...lines(h.terms_of_delivery).map((l, i) => (i === 0 && !/^DELIVERY/i.test(l) ? `DELIVERY: ${l}` : l)),
                 ...lines(h.terms_of_payment).map((l, i) => (i === 0 && !/^PAYMENT/i.test(l) ? `PAYMENT TERMS: ${l}` : l))];
  terms.slice(0, 5).forEach((l, i) => sb.set(14 + i, R, l));
  sb.set(15, 0, 'Vessel/Flight No.'); sb.set(15, MID, 'Port of Loading');
  sb.set(16, 0, h.vessel_flight_no); sb.set(16, MID, h.port_of_loading);
  sb.set(17, 0, 'Port of Discharge'); sb.set(17, MID, 'Final Destination');
  sb.set(18, 0, h.port_of_discharge); sb.set(18, MID, h.final_destination);
  for (const r of [14, 16, 18]) { sb.merge(r, 0, r, MID - 1); sb.merge(r, MID, r, R - 1); }

  // ---------- table header (rows 19, 20)
  const H1 = 19, H2 = 20;
  sb.set(H1, 0, 'CTN NO'); sb.merge(H1, 0, type === 'SOLID' ? H2 : H1, 2);
  leftTitles.forEach((t, i) => { sb.set(H1, 3 + i, t); if (type === 'SOLID') sb.merge(H1, 3 + i, H2, 3 + i); });
  sb.set(H1, S0, type === 'SOLID' ? 'QUANTITY  / SIZE' : 'SIZE'); sb.merge(H1, S0, H1, S0 + nSizes - 1);
  if (type === 'MIXED') {
    sb.set(H1, K.pack, 'PCS/ PACK'); sb.set(H1, K.pcs, 'PACK/ CTNS'); sb.merge(H1, K.pcs, H1, K.packs);
    sb.set(H1, K.ctns, 'TOT Ctns'); sb.set(H1, K.qty, 'Total Qty');
    sb.set(H1, K.net, 'Net Wt'); sb.set(H1, K.gross, 'Gr.Wt'); sb.set(H1, K.tnet, 'Total   Net Wt'); sb.set(H1, K.tgross, 'Total  Grs Wt');
  } else if (type === 'SOLID') {
    sb.set(H1, K.pcs, 'PCS/ CTN'); sb.set(H1, K.ctns, 'TOT CTNS'); sb.set(H1, K.qty, 'TOT PCS');
    for (const k of [K.pcs, K.ctns, K.qty]) sb.merge(H1, k, H2, k);
    sb.set(H1, K.net, 'WEIGHT/CTN'); sb.merge(H1, K.net, H1, K.gross);
    sb.set(H1, K.tnet, 'TOTAL WEIGHT'); sb.merge(H1, K.tnet, H1, K.tgross);
    sb.set(H2, K.net, 'NETT'); sb.set(H2, K.gross, 'GROSS'); sb.set(H2, K.tnet, 'NETT'); sb.set(H2, K.tgross, 'GROSS');
  } else {
    sb.set(H1, K.pcs, 'PCS/ CTN'); sb.set(H1, K.ctns, 'TOTAL Ctns'); sb.set(H1, K.qty, 'Total Qty');
    sb.set(H1, K.net, 'Net Wt'); sb.set(H1, K.gross, 'Gr.Wt'); sb.set(H1, K.tnet, 'Total   Net Wt'); sb.set(H1, K.tgross, 'Total  Grs Wt');
  }
  const writeSizeLabels = (r: number, labels: string[]) => labels.forEach((l, i) => sb.set(r, SZ(i), sizeVal(l)));
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
    if (type === 'ASSORTED') { if (lbl) { sb.set(H2, 0, lbl); sb.merge(H2, 0, H2, S0 - 1); } }
    else if (lbl) { r += 1; sb.set(r, 0, lbl); sb.merge(r, 0, r, S0 - 1); }
  }
  r += 1;

  // ---------- rows per block
  const subtotalRefs: number[] = [];
  const writeSubtotals = (at: number, from: number, to: number) => {
    for (const k of [K.ctns, K.qty, K.tnet, K.tgross]) {
      const b = c.blocks[subtotalRefs.length];
      const v = k === K.ctns ? b.total_cartons : k === K.qty ? b.total_qty : k === K.tnet ? b.total_net_wt : b.total_gross_wt;
      sb.set(at, k, v, to >= from ? `SUM(${ref(from, k)}:${ref(to, k)})` : undefined);
    }
    subtotalRefs.push(at);
  };

  const writeRow = (row: RowOut) => {
    const top = r;
    const n = row.items.length;
    row.items.forEach((it, ii) => {
      const rr = top + ii;
      sb.set(rr, colOrder.order, it.order_no);
      if (colOrder.style >= 0) sb.set(rr, colOrder.style, type === 'SOLID' ? (it.style_no || it.style_name) : [it.style_no, it.style_name].filter(Boolean).join(' - '));
      sb.set(rr, colOrder.colour, it.colour);
      const heads = currentHeads;
      heads.forEach((hd, i) => { const q = it.size_qty[hd]; if (q) sb.set(rr, SZ(i), q); });
      if (type === 'MIXED' && row.packs_per_ctn) sb.set(rr, K.pack, it.unit_qty, `SUM(${ref(rr, SZ(0))}:${ref(rr, SZ(nSizes - 1))})`);
    });
    const bottom = top + n - 1;
    sb.set(top, 0, row.ctn_from); sb.set(top, 1, '-');
    sb.set(top, 2, row.ctn_to, `${ref(top, 0)}+${ref(top, K.ctns)}-1`);
    if (type === 'MIXED') {
      if (row.packs_per_ctn) {
        sb.set(top, K.pcs, row.pcs_per_pack!, `SUM(${ref(top, K.pack)}:${ref(bottom, K.pack)})`);
        sb.set(top, K.packs, row.packs_per_ctn);
        sb.set(top, K.qty, row.total_qty, `${ref(top, K.pcs)}*${ref(top, K.packs)}*${ref(top, K.ctns)}`);
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

  let currentHeads: string[] = [];
  c.blocks.forEach((b, bi) => {
    currentHeads = b.effective_size_headers;
    const first = r;
    b.rows.forEach(writeRow);
    const last = r - 1;
    r += 1;                                  // blank line like the client's sheet
    const nb = c.blocks[bi + 1];
    if (nb) {                                // separator: next label + sizes, this block's sub-totals
      const lbl = blockLabel(nb);
      if (lbl) { sb.set(r, 0, lbl); sb.merge(r, 0, r, S0 - 1); }
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
    sb.set(grandRow, k, v, subtotalRefs.length ? `SUM(${subtotalRefs.map((x) => ref(x, k)).join(',')})` : undefined);
  }
  r = grandRow + 2;

  // ---------- Order / Shipped / Diff summary
  const withOrder = summary.filter((g) => g.order_source !== 'NONE');
  if (withOrder.length || type === 'ASSORTED') {
    const labelCol = S0 - 1;
    for (const g of summary) {
      const sizes = g.sizes.slice(0, nSizes);
      const totCol = SZ(sizes.length);
      sb.set(r, labelCol, [g.style_no || g.style_name, g.colour].filter(Boolean).join(' / '));
      writeSizeLabels(r, sizes); sb.set(r, totCol, 'TOTAL');
      const rows: [string, (h: string) => number | null, number][] = [
        ['ORDER Qty', (hd) => g.order[hd] ?? 0, g.order_total],
        ['Shipped Qty', (hd) => g.shipped[hd] ?? 0, g.shipped_total],
      ];
      rows.forEach(([lbl, fn, tot], i) => {
        const rr = r + 1 + i;
        sb.set(rr, labelCol, lbl);
        sizes.forEach((hd, j) => sb.set(rr, SZ(j), fn(hd) ?? 0));
        sb.set(rr, totCol, tot, `SUM(${ref(rr, SZ(0))}:${ref(rr, SZ(sizes.length - 1))})`);
      });
      const dr = r + 3;
      sb.set(dr, labelCol, 'Diff');
      sizes.forEach((hd, j) => sb.set(dr, SZ(j), g.diff[hd] ?? 0, `${ref(r + 1, SZ(j))}-${ref(r + 2, SZ(j))}`));
      sb.set(dr, totCol, g.diff_total, `${ref(r + 1, totCol)}-${ref(r + 2, totCol)}`);
      r += 5;
    }
    r += 1;
  }

  // ---------- footer totals
  const V = 5;
  const foot: [string, number, string, number][] = [
    ['TOTAL CARTONS            :', T.total_cartons, 'CTNS', K.ctns],
    ['TOTAL PIECES             :', T.total_qty, 'PCS', K.qty],
    ['TOTAL NET WEIGHT         :', r3(T.total_net_wt), 'KGS', K.tnet],
    ['TOTAL GROSS WEIGHT       :', r3(T.total_gross_wt), 'KGS', K.tgross],
  ];
  foot.forEach(([lbl, v, unit, k], i) => {
    sb.set(r + i, 0, lbl); sb.merge(r + i, 0, r + i, V - 1);
    sb.set(r + i, V, v, ref(grandRow, k)); sb.merge(r + i, V, r + i, V + 1);
    sb.set(r + i, V + 2, unit);
  });
  sb.set(r + 1, Math.max(R + 2, lastCol - 5), 'Signature & Date');
  r += foot.length;
  const meas = c.measurements.map((m) => `${m.dims} - CM - ${m.cartons} CTNS`).join(' / ');
  sb.set(r, 0, 'CARTONS MEASUREMENT      :'); sb.merge(r, 0, r, V - 1);
  sb.set(r, V, meas || '-'); sb.merge(r, V, r, lastCol);
  sb.set(r + 1, 0, 'CBM'); sb.set(r + 1, V, Number(T.total_cbm.toFixed(4))); sb.set(r + 1, V + 2, 'CBM');

  // ---------- widths
  const widths: number[] = [];
  for (let i = 0; i <= lastCol; i++) {
    if (i === 0 || i === 2) widths.push(6);
    else if (i === 1) widths.push(2);
    else if (i < S0) widths.push(i === colOrder.style ? 30 : 14);
    else if (i < after) widths.push(6);
    else widths.push(9);
  }
  const ws = sb.toSheet(widths);
  const wb = XLSX.utils.book_new();
  const name = { ASSORTED: 'Packinglist-assorted', SOLID: 'Packinglist-solid', MIXED: 'Packinglist-mixed' }[type];
  XLSX.utils.book_append_sheet(wb, ws, name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
