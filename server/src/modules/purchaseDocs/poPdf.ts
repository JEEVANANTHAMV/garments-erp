/**
 * A4 purchase order PDF (yarn / fabric / trim / general) on the shared print engine (core/print/docPdf.ts) —
 * client voice notes 05-Nov-2026: one design family for every PO and DC, Colour or Black & White template,
 * our logo + company on top (no software branding), supplier | PO details, billing AND shipping address,
 * the line table (nothing cut: widths from the content, text wraps, pages break with the header repeated),
 * taxes + Net Amount + amount in words in the PO's currency, Prepared By / Checked By / Authorised Signatory.
 *
 * Columns per PO type ("IO No", never "Job No"; client 06-Nov-2026: IO No + Style per line — one PO carries
 * several IOs / styles, so neither prints in the header; no item codes; the typed description / specification and
 * the HSN print under the item):
 *   yarn    S.No | IO No | Style | Yarn | Count | Weight (KG) | Rate | Amount
 *   fabric  S.No | IO No | Style | Fabric | Colour | GST % | Qty | Rate | Amount
 *   trim    S.No | IO No | Style | Trims & Accessories | Colour | Size | GST % | Qty | Rate | Amount
 *   general S.No | [IO No] | Particulars | GST % | Qty | Rate | Amount
 * Header details: PO No / date / delivery date / payment terms (days only — "30 Days", not "30 Days Net") /
 * quotation / currency. No IO No, style, order type or status (draft / cancelled show as the watermark).
 * Rates / amounts / taxes are the PO's stored line values (as priced from the approved quotation on the PO screens).
 */
import { renderDocPdf, type Cell, type Column, type DocSpec, type KV, type PrintTemplate } from '../../core/print/docPdf.js';
import { amountInWords, fmtDate, fmtMoney, fmtPct, fmtQty, fmtRate, indianWords, pdfSafe } from '../../core/print/printText.js';
import type { PoDocument, PoLine } from './poDocument.js';

/** @deprecated use pdfSafe from core/print/printText.ts */
export const pdfText = pdfSafe;
/** "Rupees … Only" (Indian numbering) — kept for older callers; new code uses amountInWords(). */
export const inrWords = (amount: number) => `Rupees ${indianWords(amount)} Only`;

export interface PoPdfOptions { template: PrintTemplate; printedBy?: string | null; printedAt?: string | null }

const istNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod ?? '').toUpperCase()}`.trim();
};

/** Sub lines under the item: typed description / spec, HSN, and the line's IO No when the IO has no column. */
function subLines(l: PoLine, ioInColumn: boolean) {
  const out = [...l.details];
  if (!ioInColumn && l.job) out.push(`IO No: ${l.job}`);
  if (l.hsn) out.push(`HSN: ${l.hsn}`);
  return out;
}

/** HEADER_HIDDEN: per-line facts that must not print in the PO header (client 06-Nov-2026). */
const HEADER_HIDDEN = /^(IO No|IO \/ Job No|Style|Order type)$/i;

/** "30 Days Net" / "30 days credit" / "Net 30" → "30 Days"; anything else as typed. */
export function paymentTermsText(v: string): string {
  const t = v.replace(/\b(net|credit)\b/gi, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,-]+|[\s,-]+$/g, '').trim();
  if (!t) return v.trim();
  if (/^\d+$/.test(t)) return `${t} Days`;
  return t.replace(/\b(\d+)\s*days?\b/gi, (_m, d) => `${d} Days`);
}

/** A typed address block: its first line prints bold as the name when it reads like one (no door / pin numbers). */
function addressBlock(heading: string, lines: string[], fallbackName: string) {
  if (!lines.length) return { heading, name: fallbackName, lines: [] };
  const first = lines[0];
  return !/\d/.test(first) && first.length <= 80 ? { heading, name: first, lines: lines.slice(1) } : { heading, name: null, lines };
}

export function poDocSpec(doc: PoDocument, opts: PoPdfOptions): DocSpec {
  const cur = doc.currency.code || 'INR';
  const dec = Number.isFinite(doc.currency.decimals) ? doc.currency.decimals : 2;
  const money = (v: number) => fmtMoney(v, cur, dec);
  const amtLabel = cur === 'INR' ? 'Amount' : `Amount (${cur})`;
  const rateLabel = cur === 'INR' ? 'Rate' : `Rate (${cur})`;
  const anyJob = doc.lines.some((l) => l.job);
  // weights / lengths keep 3 decimals; counted units (PCS, NOS, SET …) print whole numbers when whole
  const measured = (uom: string) => /^(kg|kgs|g|gm|gms|mtr|mtrs|m|yds?|ltr|l|cm|mm)$/i.test(uom);
  const qtyNum = (q: number, uom: string) => (!measured(uom) && Number.isInteger(Math.round(q * 1000) / 1000) ? fmtQty(q, 0) : fmtQty(q));
  const qtyText = (l: PoLine) => `${qtyNum(l.qty, l.uom)} ${l.uom}`.trim();

  const sn: Column = { key: 'sn', label: 'S.No', align: 'center', wrap: false };
  const io: Column = { key: 'io', label: 'IO No', align: 'left', weight: 0.6, maxWidth: 96 };
  const style: Column = { key: 'style', label: 'Style', align: 'left', weight: 0.5, maxWidth: 80 };
  const gst: Column = { key: 'gst', label: 'GST %', align: 'center', wrap: false };
  const qty: Column = { key: 'qty', label: 'Qty', align: 'right', wrap: false };
  const rate: Column = { key: 'rate', label: rateLabel, align: 'right', wrap: false };
  const amt: Column = { key: 'amt', label: amtLabel, align: 'right', wrap: false, bold: true };

  let columns: Column[];
  let cells: (l: PoLine, i: number) => Record<string, Cell>;
  if (doc.type === 'yarn') {
    const kgOnly = doc.lines.every((l) => !l.uom || /^kgs?$/i.test(l.uom));
    columns = [sn, io, style, { key: 'item', label: 'Yarn', weight: 3 }, { key: 'count', label: 'Count', align: 'center', wrap: false },
      { ...qty, label: kgOnly ? 'Weight (KG)' : 'Weight / Qty' }, rate, amt];
    cells = (l) => ({
      item: { text: l.description, sub: subLines(l, true), bold: true },
      count: l.count ?? '',
      qty: kgOnly ? fmtQty(l.qty) : qtyText(l),
    });
  } else if (doc.type === 'fabric') {
    columns = [sn, io, style, { key: 'item', label: 'Fabric', weight: 3 }, { key: 'color', label: 'Colour', weight: 0.8, maxWidth: 110 }, gst, qty, rate, amt];
    cells = (l) => ({ item: { text: l.description, sub: subLines(l, true), bold: true }, color: l.color ?? '' });
  } else if (doc.type === 'trim') {
    columns = [sn, io, style, { key: 'item', label: 'Trims & Accessories', weight: 3 }, { key: 'color', label: 'Colour', weight: 0.8, maxWidth: 100 },
      { key: 'size', label: 'Size', align: 'center', weight: 0.4, maxWidth: 70 }, gst, qty, rate, amt];
    cells = (l) => ({ item: { text: l.description, sub: subLines(l, true), bold: true }, color: l.color ?? '', size: l.size ?? '' });
  } else {
    columns = [sn, ...(anyJob ? [io] : []), { key: 'item', label: 'Particulars', weight: 3 }, gst, qty, rate, amt];
    cells = (l) => ({ item: { text: l.description, sub: subLines(l, anyJob), bold: true } });
  }
  const rows: Cell[][] = doc.lines.map((l, i) => {
    const base: Record<string, Cell> = {
      sn: String(i + 1), io: l.job ?? '', style: l.style ?? '', gst: l.gstRate ? fmtPct(l.gstRate) : '', qty: qtyText(l),
      rate: fmtRate(l.rate), amt: money(l.taxable), ...cells(l, i),
    };
    return columns.map((c) => base[c.key] ?? '');
  });

  // totals
  const t = doc.totals;
  const uoms = new Set(doc.lines.map((l) => l.uom));
  const totQty = doc.lines.reduce((s, l) => s + l.qty, 0);
  const totalVals: Record<string, string> = { amt: money(t.taxable) };
  if (uoms.size <= 1) totalVals.qty = doc.type === 'yarn' && columns.find((c) => c.key === 'qty')?.label === 'Weight (KG)'
    ? fmtQty(totQty) : `${qtyNum(totQty, [...uoms][0] ?? '')}${uoms.size === 1 ? ` ${[...uoms][0]}` : ''}`.trim();
  const sumRows: KV[] = [['Taxable Value', money(t.taxable)]];
  for (const g of t.gstGroups.filter((x) => x.tax)) {
    if (doc.isInterstate) sumRows.push([`IGST @ ${fmtPct(g.rate)}%`, money(g.tax)]);
    else {
      const c = Math.round((g.tax / 2) * 100) / 100;
      sumRows.push([`CGST @ ${fmtPct(g.rate / 2)}%`, money(c)]);
      sumRows.push([`SGST @ ${fmtPct(g.rate / 2)}%`, money(Math.round((g.tax - c) * 100) / 100)]);
    }
  }
  for (const [k, v] of t.charges) sumRows.push([k, money(v)]);
  if (t.tcs) sumRows.push(['TCS', money(t.tcs)]);
  sumRows.push(['Round Off', money(t.roundOff)]);

  const notes: KV[] = [];   // no "Mill Name" — the supplier block already names the mill (06-Nov-2026)
  if (doc.remarks) notes.push(['Remarks', doc.remarks]);

  const details: KV[] = [['PO No.', doc.no], ['PO Date', fmtDate(doc.date)]];
  if (doc.deliveryDate) details.push(['Delivery Date', fmtDate(doc.deliveryDate)]);
  if (doc.paymentTerms) details.push(['Payment Terms', paymentTermsText(doc.paymentTerms)]);
  // IO No / style / order type are per line (a PO carries several) — never in the header; no status row
  for (const [k, v] of doc.meta) if (!HEADER_HIDDEN.test(k)) details.push([k, v]);
  if (cur !== 'INR') details.push(['Currency', `${cur}${doc.exchangeRate && doc.exchangeRate !== 1 ? ` @ ${doc.exchangeRate}` : ''}`]);

  const supplierLines = [...doc.supplier.address, doc.supplier.gstin ? `GSTIN: ${doc.supplier.gstin}` : null,
    [doc.supplier.phone ? `Ph: ${doc.supplier.phone}` : null, doc.supplier.email].filter(Boolean).join('   |   ') || null].filter(Boolean) as string[];
  const lines = (txt: string) => txt.split('\n').map((x) => x.trim()).filter(Boolean);
  const bill = lines(doc.billingAddress);
  const ship = lines(doc.shippingAddress);

  return {
    template: opts.template,
    company: doc.company,
    title: 'PURCHASE ORDER',
    subtitle: { yarn: 'Yarn', fabric: 'Fabric', trim: 'Trims & Accessories', general: 'General' }[doc.type],
    docNoLabel: 'PO No.', docNo: doc.no,
    party: { heading: 'Supplier', name: doc.supplier.name, lines: supplierLines },
    details,
    addresses: [
      addressBlock('Billing Address', bill, doc.company.name),
      addressBlock(doc.shipSameAsBilling ? 'Shipping / Delivery Address (same as billing)' : 'Shipping / Delivery Address', ship.length ? ship : bill, doc.company.name),
    ],
    table: {
      columns, rows, emptyText: 'No items on this purchase order',
      total: { label: 'Total', values: totalVals },
    },
    summary: {
      notes, amountInWords: amountInWords(t.grandTotal, { code: cur, name: doc.currency.name, decimals: dec }),
      rows: sumRows, grand: ['Net Amount', `${cur} ${money(t.grandTotal)}`],
    },
    signatures: [{ label: 'Prepared By', name: doc.preparedBy }, { label: 'Checked By' }, { label: 'Authorised Signatory' }],
    signFor: doc.company.name,
    watermark: doc.isCancelled ? doc.status : doc.isDraft ? 'DRAFT' : null,
    printedBy: opts.printedBy ?? null,
    printedAt: opts.printedAt ?? istNow(),
    meta: { title: `Purchase Order ${doc.no}`, subject: `Purchase order ${doc.no} to ${doc.supplier.name}` },
  };
}

export function renderPoPdf(doc: PoDocument, opts: PoPdfOptions = { template: 'COLOUR' }): Promise<Buffer> {
  return renderDocPdf(poDocSpec(doc, opts));
}
