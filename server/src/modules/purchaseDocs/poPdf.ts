/**
 * A4 purchase order PDF (pdfkit, built-in Helvetica — no font files to ship).
 * Built-in fonts have no ₹ glyph, so amounts carry the currency code ("INR") and "Rs." is used in words.
 * Letterhead · supplier + PO details · line table (repeated header on every page, long text wrapped) ·
 * GST breakup + charges + round off + grand total · amount in words · remarks / terms · signatory ·
 * "Page x of y" footer · DRAFT / CANCELLED watermark.
 */
import PDFDocument from 'pdfkit';
import { amountWords } from '../invoice/invoiceWords.js';
import type { PoDocument } from './poDocument.js';

const A4_W = 595.28;
const A4_H = 841.89;
const M = 36;                       // page margin
const W = A4_W - 2 * M;             // content width
const BOTTOM = A4_H - M - 22;       // last y for content (footer below)
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#9ca3af';
const HEAD_BG = '#eef2f7';

/** Built-in fonts are WinAnsi: keep Latin-1 + common punctuation, ₹ → Rs., anything else → '?'. */
const ALLOWED_EXTRA = new Set(['—', '–', '‘', '’', '“', '”', '•', '…', '€', '™']);
export function pdfText(v: unknown): string {
  return String(v ?? '')
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('')
    .map((ch) => (ch === '\n' || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0xff) || ALLOWED_EXTRA.has(ch) ? ch : '?'))
    .join('');
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below100(n: number) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`; }
function below1000(n: number) {
  const h = Math.floor(n / 100); const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}
/** Indian numbering: 1,25,000.50 → "Rupees One Lakh Twenty Five Thousand and Fifty Paise Only". */
export function inrWords(amount: number): string {
  const neg = amount < 0;
  const paiseTotal = Math.round(Math.abs(amount) * 100);
  let n = Math.floor(paiseTotal / 100); const paise = paiseTotal % 100;
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${crore >= 1000 ? inrWords(crore).replace(/^Rupees |\sOnly$/g, '') : below1000(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  const words = parts.join(' ') || 'Zero';
  return `${neg ? 'Minus ' : ''}Rupees ${words}${paise ? ` and ${below100(paise)} Paise` : ''} Only`;
}

const money = (v: number, code: string) => {
  const locale = code === 'INR' ? 'en-IN' : 'en-US';
  return (Number(v) || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const qtyFmt = (v: number) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const rateFmt = (v: number) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const dmy = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : d ?? '-');

interface Col { key: string; label: string; w: number; align: 'left' | 'right' | 'center' }

export function renderPoPdf(doc: PoDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4', margins: { top: M, bottom: 10, left: M, right: M }, bufferPages: true,
      info: { Title: `${doc.title} ${doc.no}`, Author: doc.company.name, Subject: `Purchase order ${doc.no} to ${doc.supplier.name}`, Creator: 'Garment ERP' },
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    try {
      draw(pdf, doc);
      pdf.end();
    } catch (e) {
      reject(e);
    }
  });
}

function draw(pdf: PDFKit.PDFDocument, doc: PoDocument) {
  const cur = doc.currency.code || 'INR';
  const T = (v: unknown) => pdfText(v);
  pdf.lineWidth(0.6).strokeColor(LINE).fillColor(INK);

  // ---------------------------------------------------------------- letterhead
  let y = M;
  let textX = M;
  if (doc.company.logoFile) {
    try { pdf.image(doc.company.logoFile, M, y, { fit: [64, 64] }); textX = M + 74; } catch { /* unreadable logo: print without it */ }
  }
  const headW = W - (textX - M) - 170;
  pdf.font('Helvetica-Bold').fontSize(14).text(T(doc.company.name), textX, y, { width: headW });
  if (doc.company.tradeName) pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(T(`(${doc.company.tradeName})`), textX, pdf.y, { width: headW });
  pdf.font('Helvetica').fontSize(8.5).fillColor(INK);
  for (const a of doc.company.address) pdf.text(T(a), textX, pdf.y, { width: headW });
  const ids = [doc.company.gstin ? `GSTIN: ${doc.company.gstin}` : null, doc.company.pan ? `PAN: ${doc.company.pan}` : null].filter(Boolean).join('   ');
  if (ids) pdf.font('Helvetica-Bold').text(T(ids), textX, pdf.y, { width: headW });
  const contact = [doc.company.phone ? `Ph: ${doc.company.phone}` : null, doc.company.email, doc.company.website].filter(Boolean).join('  |  ');
  if (contact) pdf.font('Helvetica').text(T(contact), textX, pdf.y, { width: headW });
  const leftBottom = Math.max(pdf.y, doc.company.logoFile ? y + 64 : y);

  // title box (right)
  const boxX = M + W - 160;
  pdf.rect(boxX, y, 160, 46).fillAndStroke(HEAD_BG, LINE);
  pdf.fillColor(INK).font('Helvetica-Bold').fontSize(13).text('PURCHASE ORDER', boxX, y + 8, { width: 160, align: 'center' });
  pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED)
    .text(T(doc.title.replace(/ ?PURCHASE ORDER$/, '') || 'Purchase order'), boxX, y + 26, { width: 160, align: 'center' });
  pdf.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(T(doc.no), boxX, pdf.y + 1, { width: 160, align: 'center' });

  y = Math.max(leftBottom, y + 50) + 8;
  pdf.moveTo(M, y).lineTo(M + W, y).lineWidth(1.2).strokeColor(INK).stroke();
  pdf.lineWidth(0.6).strokeColor(LINE);
  y += 8;

  // ---------------------------------------------------------------- supplier + PO details
  const half = W / 2;
  const pad = 6;
  const supTop = y;
  pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('SUPPLIER / VENDOR', M + pad, y + pad, { width: half - 2 * pad });
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(T(doc.supplier.name), M + pad, pdf.y + 1, { width: half - 2 * pad });
  pdf.font('Helvetica').fontSize(8.5);
  for (const a of doc.supplier.address) pdf.text(T(a), M + pad, pdf.y, { width: half - 2 * pad });
  if (doc.supplier.gstin) pdf.font('Helvetica-Bold').text(T(`GSTIN: ${doc.supplier.gstin}`), M + pad, pdf.y + 1, { width: half - 2 * pad }).font('Helvetica');
  const sc = [doc.supplier.phone ? `Ph: ${doc.supplier.phone}` : null, doc.supplier.email].filter(Boolean).join('  |  ');
  if (sc) pdf.text(T(sc), M + pad, pdf.y, { width: half - 2 * pad });
  const supBottom = pdf.y + pad;

  const details: [string, string][] = [
    ['PO No', doc.no],
    ['PO Date', dmy(doc.date)],
    ...(doc.deliveryDate ? [['Delivery Date', dmy(doc.deliveryDate)] as [string, string]] : []),
    ['Payment Terms', doc.paymentTerms ?? '-'],
    ...doc.meta,
    ['Currency', cur === 'INR' ? 'INR' : `${cur} (exchange rate ${doc.exchangeRate})`],
    ['Tax', doc.isInterstate ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)'],
    ['Status', doc.status.charAt(0) + doc.status.slice(1).toLowerCase()],
  ];
  let dy = y + pad;
  const lx = M + half + pad;
  const lw = 78;
  for (const [k, v] of details) {
    pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(T(k), lx, dy, { width: lw });
    pdf.font('Helvetica-Bold').fillColor(INK).text(T(v), lx + lw, dy, { width: half - lw - 2 * pad });
    dy = Math.max(pdf.y, dy + 11) + 1;
  }
  const boxBottom = Math.max(supBottom, dy + pad - 2);
  pdf.rect(M, supTop, W, boxBottom - supTop).stroke();
  pdf.moveTo(M + half, supTop).lineTo(M + half, boxBottom).stroke();
  y = boxBottom + 6;

  // deliver to / bill to (yarn & fabric POs carry them)
  if (doc.shippingAddress || doc.billingAddress) {
    const parts: [string, string | null][] = [['DELIVER TO', doc.shippingAddress], ['BILL TO', doc.billingAddress]];
    const shown = parts.filter(([, v]) => v);
    const cw = W / shown.length;
    let maxH = 0;
    shown.forEach(([k, v], i) => {
      pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(k, M + i * cw + pad, y + pad, { width: cw - 2 * pad });
      pdf.font('Helvetica').fontSize(8.5).fillColor(INK).text(T(v), M + i * cw + pad, pdf.y + 1, { width: cw - 2 * pad });
      maxH = Math.max(maxH, pdf.y - y + pad);
    });
    pdf.rect(M, y, W, maxH).stroke();
    if (shown.length === 2) pdf.moveTo(M + cw, y).lineTo(M + cw, y + maxH).stroke();
    y += maxH + 6;
  }

  // ---------------------------------------------------------------- line table
  const fixed: Col[] = [
    { key: 'sn', label: '#', w: 18, align: 'center' },
    { key: 'desc', label: 'Item / Description', w: 0, align: 'left' },
    { key: 'job', label: 'IO / Job', w: 68, align: 'left' },
    { key: 'hsn', label: 'HSN', w: 42, align: 'left' },
    { key: 'qty', label: 'Qty', w: 56, align: 'right' },
    { key: 'uom', label: 'UOM', w: 30, align: 'center' },
    { key: 'rate', label: `Rate (${cur})`, w: 56, align: 'right' },
    { key: 'gst', label: 'GST%', w: 30, align: 'right' },
    { key: 'amt', label: `Amount (${cur})`, w: 70, align: 'right' },
  ];
  fixed[1].w = W - fixed.reduce((s, c) => s + c.w, 0);
  const cols = fixed;
  const cellPad = 3;

  const tableHeader = () => {
    const h = 18;
    pdf.rect(M, y, W, h).fillAndStroke(HEAD_BG, LINE);
    let x = M;
    pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(INK);
    for (const c of cols) {
      pdf.text(T(c.label), x + cellPad, y + 5, { width: c.w - 2 * cellPad, align: c.align, lineBreak: false, ellipsis: true });
      x += c.w;
    }
    x = M;
    for (const c of cols.slice(0, -1)) { x += c.w; pdf.moveTo(x, y).lineTo(x, y + h).stroke(); }
    y += h;
  };
  const continuationHeader = () => {
    pdf.addPage();
    y = M;
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(T(`${doc.company.name}  -  ${doc.title} ${doc.no} (continued)`), M, y, { width: W });
    y = pdf.y + 6;
  };

  tableHeader();
  const descW = cols[1].w - 2 * cellPad;
  doc.lines.forEach((l, i) => {
    const cells: Record<string, string> = {
      sn: String(i + 1), job: l.job ?? '-', hsn: l.hsn ?? '-', qty: qtyFmt(l.qty), uom: l.uom || '-',
      rate: rateFmt(l.rate), gst: l.gstRate ? `${Number(l.gstRate)}` : '-', amt: money(l.taxable, cur),
    };
    pdf.font('Helvetica-Bold').fontSize(8.5);
    const dH = pdf.heightOfString(T(l.description), { width: descW });
    pdf.font('Helvetica').fontSize(7.5);
    const detailText = T(l.details.join('\n'));
    const detH = l.details.length ? pdf.heightOfString(detailText, { width: descW }) + 1 : 0;
    let otherH = 0;
    for (const c of cols) {
      if (c.key === 'desc' || c.key === 'sn') continue;
      pdf.font('Helvetica').fontSize(8);
      otherH = Math.max(otherH, pdf.heightOfString(T(cells[c.key]), { width: c.w - 2 * cellPad }));
    }
    const rowH = Math.max(dH + detH, otherH) + 2 * cellPad + 1;
    if (y + rowH > BOTTOM) { continuationHeader(); tableHeader(); }
    // a single row taller than a page is clipped by pdfkit's own page flow; real PO lines never get there
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(T(l.description), M + cols[0].w + cellPad, y + cellPad, { width: descW });
    if (l.details.length) pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(detailText, M + cols[0].w + cellPad, pdf.y + 1, { width: descW });
    let x = M;
    pdf.fillColor(INK);
    for (const c of cols) {
      if (c.key !== 'desc') {
        pdf.font(c.key === 'amt' ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
          .text(T(cells[c.key]), x + cellPad, y + cellPad, { width: c.w - 2 * cellPad, align: c.align });
      }
      x += c.w;
    }
    pdf.rect(M, y, W, rowH).stroke();
    x = M;
    for (const c of cols.slice(0, -1)) { x += c.w; pdf.moveTo(x, y).lineTo(x, y + rowH).stroke(); }
    y += rowH;
  });
  if (!doc.lines.length) {
    pdf.rect(M, y, W, 20).stroke();
    pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('No items on this purchase order', M, y + 6, { width: W, align: 'center' });
    y += 20;
  }
  // quantity total
  const totQty = doc.lines.reduce((s, l) => s + l.qty, 0);
  const uoms = new Set(doc.lines.map((l) => l.uom));
  pdf.rect(M, y, W, 16).fillAndStroke('#f8fafc', LINE);
  pdf.fillColor(INK).font('Helvetica-Bold').fontSize(8)
    .text(`Total${uoms.size === 1 ? `  ${qtyFmt(totQty)} ${T([...uoms][0])}` : ''}`, M + cellPad, y + 4, { width: W / 2 })
    .text(money(doc.totals.taxable, cur), M + W - cols[cols.length - 1].w + cellPad, y + 4, { width: cols[cols.length - 1].w - 2 * cellPad, align: 'right' });
  y += 22;

  // ---------------------------------------------------------------- totals + words
  const t = doc.totals;
  const rows: [string, number, boolean?][] = [['Taxable value', t.taxable]];
  if (t.gst) {
    if (doc.isInterstate) rows.push(['IGST', t.igst]);
    else { rows.push(['CGST', t.cgst]); rows.push(['SGST', t.sgst]); }
  }
  for (const [k, v] of t.charges) rows.push([k, v]);
  if (t.tcs) rows.push(['TCS', t.tcs]);
  if (t.roundOff) rows.push(['Round off', t.roundOff]);
  rows.push([`Grand Total (${cur})`, t.grandTotal, true]);

  const words = cur === 'INR' ? inrWords(t.grandTotal) : amountWords(t.grandTotal, cur);
  const breakup = t.gstGroups.filter((g) => g.rate || g.tax).map((g) => doc.isInterstate
    ? `IGST @ ${g.rate}% on ${money(g.taxable, cur)} = ${money(g.tax, cur)}`
    : `CGST @ ${g.rate / 2}% + SGST @ ${g.rate / 2}% on ${money(g.taxable, cur)} = ${money(g.tax, cur)}`);
  const totW = 210;
  const leftW = W - totW - 12;
  pdf.font('Helvetica').fontSize(8.5);
  const wordsH = pdf.heightOfString(T(words), { width: leftW }) + 14 + (breakup.length ? breakup.length * 11 + 14 : 0);
  const blockH = Math.max(rows.length * 15 + 4, wordsH);
  if (y + blockH > BOTTOM) { continuationHeader(); }

  let ty = y;
  for (const [k, v, bold] of rows) {
    if (bold) { pdf.rect(M + W - totW, ty - 2, totW, 17).fillAndStroke(HEAD_BG, LINE); pdf.fillColor(INK); }
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 9.5 : 8.5)
      .text(T(k), M + W - totW + 6, ty + (bold ? 2 : 0), { width: 120 })
      .text(money(v, cur), M + W - 90, ty + (bold ? 2 : 0), { width: 84, align: 'right' });
    ty += bold ? 19 : 14;
  }
  pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('AMOUNT IN WORDS', M, y, { width: leftW });
  pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(T(words), M, pdf.y + 1, { width: leftW });
  if (breakup.length) {
    pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('GST BREAKUP', M, pdf.y + 6, { width: leftW });
    pdf.font('Helvetica').fontSize(8).fillColor(INK);
    for (const b of breakup) pdf.text(T(b), M, pdf.y + 1, { width: leftW });
  }
  y = Math.max(ty, pdf.y) + 10;

  // ---------------------------------------------------------------- remarks / terms
  const terms = [
    `Please quote our PO number ${doc.no} on your invoice, delivery challan and all correspondence.`,
    'Goods are accepted subject to our inspection; rejected goods will be returned at the supplier\'s cost.',
    ...(doc.deliveryDate ? [`Delivery on or before ${dmy(doc.deliveryDate)}.`] : []),
  ];
  const termsText = (doc.remarks ? `Remarks: ${doc.remarks}\n` : '') + terms.map((x, i) => `${i + 1}. ${x}`).join('\n');
  pdf.font('Helvetica').fontSize(8);
  const termsH = pdf.heightOfString(T(termsText), { width: W - 12 }) + 22;
  if (y + Math.min(termsH, 200) > BOTTOM) continuationHeader();
  pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('TERMS & REMARKS', M, y, { width: W });
  pdf.font('Helvetica').fontSize(8).fillColor(INK).text(T(termsText), M, pdf.y + 2, { width: W });
  y = pdf.y + 14;

  // ---------------------------------------------------------------- signatures
  if (y + 70 > BOTTOM) { continuationHeader(); }
  pdf.font('Helvetica').fontSize(8.5).fillColor(INK)
    .text(T(`Prepared by: ${doc.preparedBy ?? ''}`), M, y + 40, { width: W / 2 });
  pdf.font('Helvetica-Bold').fontSize(9).text(T(`For ${doc.company.name}`), M + W / 2, y, { width: W / 2, align: 'right' });
  pdf.moveTo(M + W - 170, y + 48).lineTo(M + W, y + 48).strokeColor(INK).stroke();
  pdf.font('Helvetica').fontSize(8.5).text('Authorised Signatory', M + W - 170, y + 52, { width: 170, align: 'right' });

  // ---------------------------------------------------------------- footer + watermark on every page
  const range = pdf.bufferedPageRange();
  const mark = doc.isCancelled ? doc.status : doc.isDraft ? 'DRAFT' : null;
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(T(`${doc.no}  |  This is a computer generated purchase order.`), M, A4_H - M + 2, { width: W / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, M + W / 2, A4_H - M + 2, { width: W / 2, align: 'right', lineBreak: false });
    if (mark) {
      pdf.save();
      pdf.rotate(-35, { origin: [A4_W / 2, A4_H / 2] });
      pdf.fillColor('#dc2626').opacity(0.12).font('Helvetica-Bold').fontSize(110)
        .text(mark, 0, A4_H / 2 - 55, { width: A4_W, align: 'center', lineBreak: false });
      pdf.restore();
      pdf.opacity(1);
    }
  }
}
