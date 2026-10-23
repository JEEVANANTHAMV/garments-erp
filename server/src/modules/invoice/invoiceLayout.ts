import XLSX from 'xlsx';
import { SheetBuilder, type PlLayout } from '../packing/packingListExcel.js';
import { amountWords, qtyWords } from './invoiceWords.js';
import { gstEndorsement, hsnSummary } from './invoiceRules.js';

/**
 * The commercial invoice in the client's shipping format (FK-087.xls, 23-Oct-2026). One cell grid feeds the screen /
 * print preview and the Excel download, so they match each other and the client's sheet: columns A–K with the sheet's
 * widths, the same boxes, captions and row order.
 *
 *   BUYER ("BUYER INVOICE")  header boxes · marks & packages · goods (order no / SKU / buyer item / supplier mat no,
 *                            qty, rate, amount) · totals + ship-to · quantity and amount in words · bank details +
 *                            REX declaration · signature · declaration
 *   IGST  ("IGST INVOICE")   same goods + charge lines (hanger cost: qty under the item references so the quantity
 *                            total stays the goods quantity) · FOB / exchange rate / FOB INR / GST paid per rate ·
 *                            footer note (import bond) · signature · declaration. The Excel also carries the sheet's
 *                            working columns L–R (ex. rate, INR rate, INR value, IGST, value with IGST, HSN, description).
 */

export interface InvoiceDoc {
  invoice_no: string; invoice_date: string | null; invoice_format: 'BUYER' | 'IGST';
  currency_code: string; exchange_rate: number;
  exporter_details: string | null; exporter_ref: string | null; buyer_order_ref: string | null; other_references: string | null;
  consignee_details: string | null; buyer_details: string | null; ship_to_details: string | null;
  country_origin_text: string | null; country_dest_text: string | null;
  pre_carriage_by: string | null; place_of_receipt: string | null; vessel_flight_no: string | null;
  port_of_loading: string | null; port_of_discharge: string | null; final_destination: string | null;
  terms_of_delivery: string | null; terms_of_payment: string | null;
  marks_nos: string | null; packages_text: string | null; goods_heading: string | null; item_ref_label: string | null;
  qty_unit: string; rate_basis: string | null;
  total_cartons: number | null; total_pcs: number | null; total_pcs_unit: string | null; net_weight_kg: number | null; gross_weight_kg: number | null;
  qty_words: string | null; amount_words: string | null;
  bank_details: string | null; rex_declaration: string | null; declaration: string | null; footer_note: string | null;
  goods_gst_rate: number | null; charges_gst_rate: number | null;
  gst_supply_type?: string | null; lut_arn?: string | null;
  eway_bill?: { ewb_no: string | null; ewb_date: string | null; generated: boolean } | null;
  lines: InvoiceDocLine[];
}
export interface InvoiceDocLine {
  line_kind: 'GOODS' | 'CHARGE'; description: string | null; order_no: string | null; buyer_sku_no: string | null;
  buyer_item_no: string | null; supplier_mat_no: string | null; hsn_code: string | null;
  qty: number; unit_price: number; amount: number; gst_rate: number | null; uqc?: string | null;
  style_ref?: string | null; colour?: string | null; size_text?: string | null;
}

// A–K: the header boxes of FK-087 over the client's goods table (S.NO … Total, 23-Oct-2026)
const WIDTHS = [6, 12, 11, 10, 34, 12, 14, 9, 6, 9, 12];
const WORK_WIDTHS = [9, 10, 13.7, 12.3, 12.3, 10.9, 40];                                   // L–R (IGST working columns)
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const lines = (t: string | null | undefined) => String(t ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
const dmy = (d: string | null | undefined) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? '')); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
/** Long text in rows of about `width` characters (as the sheet types it — Excel cannot wrap without styles). */
const wrap = (t: string | null | undefined, width: number) => {
  const out: string[] = [];
  for (const para of lines(t)) {
    if (para.length <= width) { out.push(para); continue; }   // a line typed to fit stays as typed
    let cur = '';
    for (const w of para.split(/\s+/)) {
      if ((cur + ' ' + w).trim().length > width && cur) { out.push(cur); cur = w; } else cur = `${cur} ${w}`.trim();
    }
    if (cur) out.push(cur);
  }
  return out;
};

export function invoiceTotals(doc: Pick<InvoiceDoc, 'lines' | 'exchange_rate' | 'goods_gst_rate' | 'charges_gst_rate'>) {
  const goods = doc.lines.filter((l) => l.line_kind === 'GOODS');
  const charges = doc.lines.filter((l) => l.line_kind === 'CHARGE');
  const sum = (a: InvoiceDocLine[], k: 'qty' | 'amount') => r2(a.reduce((t, l) => t + Number(l[k] || 0), 0));
  const xr = Number(doc.exchange_rate) || 0;
  const gstOf = (a: InvoiceDocLine[], dflt: number | null) => r2(a.reduce((t, l) => t + r2(Number(l.amount) * xr) * (Number(l.gst_rate ?? dflt ?? 0) / 100), 0));
  return {
    goods_qty: sum(goods, 'qty'), goods_amount: sum(goods, 'amount'), charges_amount: sum(charges, 'amount'),
    total_amount: r2(sum(goods, 'amount') + sum(charges, 'amount')),
    goods_inr: r2(sum(goods, 'amount') * xr), charges_inr: r2(sum(charges, 'amount') * xr),
    goods_gst: gstOf(goods, doc.goods_gst_rate), charges_gst: gstOf(charges, doc.charges_gst_rate),
  };
}

function build(doc: InvoiceDoc, withWorkingColumns: boolean) {
  const sb = new SheetBuilder();
  const igst = doc.invoice_format === 'IGST';
  const T = invoiceTotals(doc);
  const L = 10; // last column K
  const box = (r1: number, c1: number, r2_: number, c2: number) => sb.box(r1, c1, r2_, c2, 'box');

  // ---------- title + header boxes (rows 1–20 of the sheet)
  sb.set(0, 0, 'COMMERCIAL INVOICE', undefined, 'title'); sb.merge(0, 0, 0, L); box(0, 0, 0, L);
  sb.set(1, 0, 'Exporter', undefined, 'sm'); sb.set(1, 5, 'Invoice No. & Date', undefined, 'sm'); sb.set(1, 9, "Exporter's  Ref.", undefined, 'sm');
  lines(doc.exporter_details).slice(0, 5).forEach((l, i) => sb.set(2 + i, 0, l, undefined, i === 0 || /GST/i.test(l) ? 'b' : undefined));
  sb.set(2, 5, `${doc.invoice_no}${doc.invoice_date ? ` DT: ${dmy(doc.invoice_date)}` : ''}`, undefined, 'b');
  lines(doc.exporter_ref).slice(0, 3).forEach((l, i) => { sb.set(2 + i, 9, l, undefined, 'b'); if (i === 0) sb.merge(2, 9, 2, L); });
  sb.set(3, 5, "Buyer's Order No. & Date.", undefined, 'sm');
  sb.set(4, 5, lines(doc.buyer_order_ref).join('  /  '), undefined, 'b'); sb.merge(4, 5, 4, L);
  sb.set(5, 5, 'Other Reference(s)', undefined, 'sm');
  lines(doc.other_references).slice(0, 1).forEach((l) => { sb.set(6, 5, l, undefined, 'b'); sb.merge(6, 5, 6, 9); });
  box(1, 0, 6, 4); box(1, 5, 2, 8); box(1, 9, 3, L); box(3, 5, 4, L); box(5, 5, 6, L);

  sb.set(7, 0, 'Consignee', undefined, 'sm'); sb.set(7, 5, 'Buyer', undefined, 'sm');
  lines(doc.consignee_details).slice(0, 6).forEach((l, i) => sb.set(8 + i, 0, l, undefined, i === 0 ? 'b' : undefined));
  lines(doc.buyer_details).slice(0, 4).forEach((l, i) => sb.set(8 + i, 5, l, undefined, i === 0 ? 'b' : undefined));
  box(7, 0, 13, 4); box(7, 5, 11, L);
  sb.set(12, 5, 'Country of Origin of Goods', undefined, 'sm'); sb.set(12, 9, 'Country of Final Destination', undefined, 'sm');
  sb.set(13, 5, doc.country_origin_text, undefined, 'cb'); sb.merge(13, 5, 13, 8);
  sb.set(13, 9, doc.country_dest_text, undefined, 'cb'); sb.merge(13, 9, 13, L);
  box(12, 5, 13, 8); box(12, 9, 13, L);

  sb.set(14, 0, 'Pre-Carriage by', undefined, 'sm'); sb.set(14, 3, 'Place of Receipt by Pre-carrier', undefined, 'sm');
  sb.set(15, 0, doc.pre_carriage_by, undefined, 'b'); sb.set(15, 3, doc.place_of_receipt, undefined, 'b');
  sb.set(16, 0, 'Vessel / Flight No.', undefined, 'sm'); sb.set(16, 3, 'Port of Loading', undefined, 'sm');
  sb.set(17, 0, doc.vessel_flight_no, undefined, 'cb'); sb.merge(17, 0, 17, 2);
  sb.set(17, 3, doc.port_of_loading, undefined, 'cb'); sb.merge(17, 3, 17, 4);
  sb.set(18, 0, 'Port of Discharge', undefined, 'sm'); sb.set(18, 3, 'Final Destination', undefined, 'sm');
  sb.set(19, 0, doc.port_of_discharge, undefined, 'cb'); sb.merge(19, 0, 19, 2);
  sb.set(19, 3, doc.final_destination, undefined, 'cb'); sb.merge(19, 3, 19, 4);
  for (const rr of [14, 16, 18]) { box(rr, 0, rr + 1, 2); box(rr, 3, rr + 1, 4); }
  sb.set(14, 5, 'Terms of Delivery and Payment', undefined, 'sm');
  [...lines(doc.terms_of_delivery), ...lines(doc.terms_of_payment)].slice(0, 5).forEach((l, i) => sb.set(15 + i, 5, l, undefined, 'b'));
  box(14, 5, 19, L);

  // ---------- marks / packages / description heading band (rows 21–)
  sb.set(20, 0, 'Marks & Nos./Container No.', undefined, 'sm'); sb.set(20, 4, 'No. & Kind of Pkgs.', undefined, 'sm');
  sb.set(20, 6, 'Description of Goods', undefined, 'sm');
  const marks = lines(doc.marks_nos);
  const pkgs = lines(doc.packages_text);
  const heading = lines(doc.goods_heading);
  marks.forEach((m, i) => sb.set(21 + i, 0, m, undefined, 'sm'));
  pkgs.forEach((m, i) => sb.set(21 + i, 4, m, undefined, 'b'));
  heading.forEach((m, i) => sb.set(21 + i, 6, m, undefined, 'b'));
  const bandEnd = 20 + Math.max(marks.length, pkgs.length, heading.length, 1);
  box(20, 0, bandEnd, 3); box(20, 4, bandEnd, 5); box(20, 6, bandEnd, L);

  // ---------- goods table in the shipping bill's item pattern (ICEGATE Part II: S.No | HS CD | Description | Quantity |
  // UQC | Rate | Value) with Colour + Size (customs and buyer copies show them) and Order No + Style/Ref on every line —
  // one invoice can carry 2–3 orders of a buyer (client 23-Oct-2026)
  let r = bandEnd + 1;
  const tableTop = r;
  const head: [number, string][] = [[0, 'S.NO'], [1, 'Order No.'], [2, 'Style/Ref No.'], [3, 'HS Code'], [4, 'Description of Goods'], [5, 'Colour'], [6, 'Size'],
    [7, 'Quantity'], [8, 'UQC'], [9, `Rate (${doc.rate_basis || doc.currency_code})`], [10, `Value (${doc.currency_code})`]];
  for (const [c, h] of head) sb.set(r, c, h, undefined, 'th');
  r++;
  const goods = doc.lines.filter((l) => l.line_kind === 'GOODS');
  const charges = doc.lines.filter((l) => l.line_kind === 'CHARGE');
  const workRows: { r: number; l: InvoiceDocLine }[] = [];
  let sno = 0;
  for (const l of [...goods, ...charges]) {
    const descRows = wrap(l.description, 34);
    sb.set(r, 0, ++sno, undefined, 'c', 0);
    if (l.line_kind === 'GOODS') {
      sb.set(r, 1, l.order_no); sb.set(r, 2, l.style_ref ?? l.supplier_mat_no); sb.set(r, 5, l.colour); sb.set(r, 6, l.size_text, undefined, 'c');
    }
    sb.set(r, 3, l.hsn_code, undefined, 'c');
    sb.set(r, 4, descRows[0] ?? '');
    sb.set(r, 7, Number(l.qty), undefined, 'r', 0); sb.set(r, 8, l.uqc || doc.qty_unit || 'PCS', undefined, 'c');
    sb.set(r, 9, Number(l.unit_price), undefined, 'r', 2); sb.set(r, 10, r2(Number(l.amount)), undefined, 'r', 2);
    workRows.push({ r, l }); r++;
    // a long description goes on below, as the shipping bill prints it
    for (const extra of descRows.slice(1)) { sb.set(r, 4, extra); r++; }
  }
  sb.set(r, 0, 'TOTAL', undefined, 'rb'); sb.merge(r, 0, r, 6);
  sb.set(r, 7, T.goods_qty, undefined, 'rb', 0); sb.set(r, 10, T.total_amount, undefined, 'rb', 2);
  sb.box(tableTop, 0, r, L, 'grid');
  const goodsEnd = Math.max(r + 2, 34);

  // ---------- totals + ship-to
  r = goodsEnd;
  const tot = [
    ['TOTAL CARTONS            :', doc.total_cartons, 'CTNS'], ['TOTAL PCS                        :', doc.total_pcs, doc.total_pcs_unit || doc.qty_unit || 'PCS'],
    ['Net Weight                     :', doc.net_weight_kg, 'KGS'], ['Gross Weight                 :', doc.gross_weight_kg, 'KGS'],
  ] as const;
  tot.forEach(([lbl, v, u], i) => {
    sb.set(r + i, 0, lbl, undefined, 'b'); sb.merge(r + i, 0, r + i, 1);
    sb.set(r + i, 2, v == null ? null : Number(v), undefined, 'rb', i >= 2 ? 3 : 0); sb.set(r + i, 3, u, undefined, 'b');
  });
  const ship = lines(doc.ship_to_details);
  if (ship.length) {
    sb.set(r, 4, 'SHIP TO (DELIVERY ADDRESS)', undefined, 'smb');
    ship.slice(0, 3).forEach((l, i) => sb.set(r + 1 + i, 4, l, undefined, 'b'));
    box(r, 4, r + 3, 7);
  }
  r += 4;
  sb.set(r, 0, doc.qty_words || qtyWords(T.goods_qty, doc.qty_unit), undefined, 'b'); sb.merge(r, 0, r, 7);
  sb.set(r, 8, T.goods_qty, undefined, 'cb', 0); sb.set(r, 10, T.total_amount, undefined, 'rb', 2);
  sb.box(r, 8, r, 8, 'box'); sb.box(r, 10, r, 10, 'box');
  const goodsBottom = r;
  r++;
  sb.set(r, 0, 'Amount Chargeable', undefined, 'sm'); sb.set(r, 9, 'Total', undefined, 'c');
  sb.set(r, 10, T.total_amount, undefined, 'rb', 2); sb.merge(r, 10, r + 1, 10); sb.box(r, 10, r + 1, 10, 'box');
  sb.set(r + 1, 0, '(In Words)', undefined, 'sm');
  sb.set(r + 1, 1, doc.amount_words || amountWords(T.total_amount, doc.currency_code), undefined, 'b'); sb.merge(r + 1, 1, r + 1, 9);
  box(goodsEnd, 0, goodsBottom, L);
  box(r, 0, r + 1, L);
  r += 2;
  // GST export endorsement (CGST rule 46) — a row of its own when the export type is set
  const endorse = gstEndorsement(doc.gst_supply_type, doc.lut_arn);
  if (endorse) { sb.set(r, 0, endorse, undefined, 'cb'); sb.merge(r, 0, r, L); box(r, 0, r, L); r++; }
  // the e-way bill made from this invoice (the QR prints on the screen / PDF print; the sheet carries the number)
  if (doc.eway_bill?.generated && doc.eway_bill.ewb_no) {
    sb.set(r, 0, `E-WAY BILL NO: ${doc.eway_bill.ewb_no}${doc.eway_bill.ewb_date ? `   DT: ${doc.eway_bill.ewb_date}` : ''}`, undefined, 'b'); sb.merge(r, 0, r, L); box(r, 0, r, L); r++;
  }

  // ---------- footer
  let sigTop: number;
  if (!igst) {
    sb.set(r, 0, 'OUR BANK DETAILS:-', undefined, 'b'); sb.set(r, 7, 'REX DECLARATION', undefined, 'b');
    const bank = lines(doc.bank_details).slice(0, 7);
    const rex = wrap(doc.rex_declaration, 90).slice(0, 8);
    // the signature box starts on the last bank line, under the REX text (sheet: REX E51–E55, Signature & Date I56)
    const n = Math.max(bank.length, rex.length + 1, 2);
    bank.forEach((l, i) => sb.set(r + 1 + i, 0, l, undefined, i === 0 || /A\/C|BENEFICIARY/i.test(l) ? 'b' : undefined));
    rex.forEach((l, i) => sb.set(r + 1 + i, 4, l, undefined, 'sm'));
    box(r, 0, r + n, 3); box(r, 4, r + n - 1, L);
    sigTop = r + n;
    r += n + 1;
  } else {
    const hasCharges = T.charges_amount !== 0;
    const gr = Number(doc.goods_gst_rate ?? 0); const cr = Number(doc.charges_gst_rate ?? 0);
    const rows: [string, number, string, string, number, string][] = [
      ['FOB :', T.goods_amount, doc.currency_code, 'FOB :', T.charges_amount, doc.currency_code],
      ['EX.RATE : RS:', Number(doc.exchange_rate), doc.currency_code, 'EX.RATE : RS:', Number(doc.exchange_rate), doc.currency_code],
      ['FOB VALUE :', T.goods_inr, 'INR', 'FOB VALUE :', T.charges_inr, 'INR'],
      [`GST PAID ${gr}% :`, T.goods_gst, 'INR', `GST PAID ${cr}% :`, T.charges_gst, 'INR'],
    ];
    r++;
    rows.forEach((x, i) => {
      sb.set(r + i, 0, x[0], undefined, 'rb'); sb.merge(r + i, 0, r + i, 1); sb.set(r + i, 2, x[1], undefined, 'rb', i === 1 ? 4 : 2); sb.set(r + i, 3, x[2], undefined, 'b');
      sb.box(r + i, 0, r + i, 1, 'box'); sb.box(r + i, 2, r + i, 2, 'box'); sb.box(r + i, 3, r + i, 3, 'box');
      if (hasCharges) {
        sb.set(r + i, 4, x[3], undefined, 'b'); sb.set(r + i, 5, x[4], undefined, 'rb', i === 1 ? 4 : 2); sb.merge(r + i, 5, r + i, 6); sb.set(r + i, 7, x[5], undefined, 'b');
        sb.box(r + i, 4, r + i, 4, 'box'); sb.box(r + i, 5, r + i, 6, 'box'); sb.box(r + i, 7, r + i, 7, 'box');
      }
    });
    r += rows.length;
    const note = wrap(doc.footer_note, 95).slice(0, 2);
    if (note.length) { sb.set(r, 0, note.join(' '), undefined, 'b'); sb.merge(r, 0, r + 1, 7); box(r, 0, r + 1, 7); }
    sigTop = r + 1;
    r += 2;
  }
  // signature box (I–K) and the declaration
  sb.set(sigTop, 8, 'Signature & Date', undefined, 'b');
  sb.set(r, 0, 'Declaration', undefined, 'sm');
  const decl = wrap(doc.declaration, 125).slice(0, 4);
  decl.forEach((l, i) => sb.set(r + 1 + i, 0, l, undefined, 'smb'));
  const end = Math.max(r + Math.max(decl.length, 2), sigTop + 3);
  // "for <exporter>" … "Authorised Signatory", as every exporter signs
  const exporterName = lines(doc.exporter_details)[0];
  if (exporterName) { sb.set(sigTop + 1, 8, `for ${exporterName}`, undefined, 'smb'); sb.merge(sigTop + 1, 8, sigTop + 1, L); }
  sb.set(end, 8, 'Authorised Signatory', undefined, 'cb'); sb.merge(end, 8, end, L);
  box(sigTop, 8, end, L);
  box(0, 0, end, L);

  // ---------- IGST working columns (Excel only) — as the sheet's L–R
  if (igst && withWorkingColumns) {
    const xr = Number(doc.exchange_rate) || 0;
    sb.set(20, 11, 'EX.RATE', undefined, 'b'); sb.set(20, 12, 'RATE INR', undefined, 'b'); sb.set(20, 13, 'VALUE INR', undefined, 'b');
    sb.set(20, 14, 'IGST', undefined, 'b'); sb.set(20, 15, 'VALUE + IGST', undefined, 'b'); sb.set(20, 16, 'HSN', undefined, 'b'); sb.set(20, 17, 'DESCRIPTION', undefined, 'b');
    let tv = 0, tg = 0;
    for (const { r: rr, l } of workRows) {
      const rate = Number(l.gst_rate ?? (l.line_kind === 'CHARGE' ? doc.charges_gst_rate : doc.goods_gst_rate) ?? 0);
      const v = r2(Number(l.amount) * xr); const g = r2(v * rate / 100);
      tv += v; tg += g;
      sb.set(rr, 11, xr, undefined, undefined, 4); sb.set(rr, 12, r2(Number(l.unit_price) * xr), undefined, undefined, 2);
      sb.set(rr, 13, v, undefined, undefined, 2); sb.set(rr, 14, g, undefined, undefined, 2); sb.set(rr, 15, r2(v + g), undefined, undefined, 2);
      sb.set(rr, 16, l.hsn_code); sb.set(rr, 17, l.description);
    }
    const tr = workRows.length ? workRows[workRows.length - 1].r + 1 : 23;
    sb.set(tr, 13, r2(tv), undefined, 'b', 2); sb.set(tr, 14, r2(tg), undefined, 'b', 2); sb.set(tr, 15, r2(tv + tg), undefined, 'b', 2);
  }
  return { sb, widths: igst && withWorkingColumns ? [...WIDTHS, ...WORK_WIDTHS] : WIDTHS };
}

/** Cell grid for the screen / print preview (columns A–K). */
export function buildInvoiceLayout(doc: InvoiceDoc): PlLayout {
  const { sb, widths } = build(doc, false);
  return sb.toLayout(`INVOICE_${doc.invoice_format}`, widths);
}

/** Excel in the FK-087 layout (sheet name as in the client's file). */
export function buildInvoiceWorkbook(doc: InvoiceDoc): Buffer {
  const { sb, widths } = build(doc, true);
  const ws = sb.toSheet(widths);
  ws['!pageSetup'] = { orientation: 'portrait', paperSize: 9 } as any;
  (ws as any)['!print'] = { area: `A1:K${sb.maxR + 1}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, doc.invoice_format === 'IGST' ? 'IGST INVOICE' : 'BUYER INVOICE');
  // HSN-wise summary — for the shipping bill and GSTR-1 (exports)
  const hs = hsnSummary(doc.lines as any, Number(doc.exchange_rate) || 0, doc.goods_gst_rate, doc.charges_gst_rate);
  const rows: (string | number)[][] = [[`HSN-WISE SUMMARY — ${doc.invoice_no}`], [],
    ['HSN', 'DESCRIPTION', 'UQC', 'QTY', `VALUE ${doc.currency_code}`, 'EX. RATE', 'TAXABLE VALUE INR', 'IGST %', 'IGST INR']];
  for (const h of hs) rows.push([h.hsn_code, h.description, h.uqc, h.qty, h.value_fc, Number(doc.exchange_rate) || 0, h.value_inr, h.gst_rate, h.gst_inr]);
  rows.push(['TOTAL', '', '', hs.reduce((a, h) => a + h.qty, 0), r2(hs.reduce((a, h) => a + h.value_fc, 0)), '', r2(hs.reduce((a, h) => a + h.value_inr, 0)), '', r2(hs.reduce((a, h) => a + h.gst_inr, 0))]);
  const hws = XLSX.utils.aoa_to_sheet(rows);
  hws['!cols'] = [10, 50, 6, 10, 14, 10, 18, 8, 14].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, hws, 'HSN SUMMARY');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
