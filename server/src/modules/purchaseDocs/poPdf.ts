/**
 * A4 purchase order PDF (pdfkit, built-in Helvetica — no font files to ship).
 * Layout follows the client's old-software PO prints (04-Nov-2026, "yarn po.pdf" / "fabric po.pdf" / "trims po.pdf" /
 * "general po.pdf"): one framed page · "PURCHASE ORDER" · company name, address, GST IN, phone · To: supplier with
 * address + GST IN | PO No / PO Date · Billing + Shipping (delivery) address · line table whose columns run down to
 * the totals (columns per PO type as in the samples; "Job No" is printed as "IO No") · Total · CGST / SGST / IGST @ % ·
 * charges · Round Off · amount in words "Rupees … Only" + net amount · For <COMPANY> · the sample's signature labels.
 * Built-in fonts have no ₹ glyph: amounts carry the currency code and words say "Rupees".
 * Page breaks repeat the table header; "Page x of y" on every page; DRAFT / CANCELLED watermark.
 */
import PDFDocument from 'pdfkit';
import { amountWords } from '../invoice/invoiceWords.js';
import type { PoDocument, PoLine, PoType } from './poDocument.js';

const A4_W = 595.28;
const A4_H = 841.89;
const M = 28;                        // page margin (frame edge)
const W = A4_W - 2 * M;              // frame width
const FRAME_BOTTOM = A4_H - M - 14;  // frame bottom (page number below it)
const P = 6;                         // inner padding
const INK = '#111827';
const MUTED = '#4b5563';
const RULE = '#6b7280';
const HEAD_BG = '#f1f5f9';

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
  return [h ? `${ONES[h]} Hundred` : '', r ? `${h ? 'and ' : ''}${below100(r)}` : ''].filter(Boolean).join(' ');
}
/** Indian numbering, as on the client's prints: 3021 → "Rupees Three Thousand and Twenty One Only". */
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
  if (n) parts.push(n < 100 && parts.length ? `and ${below100(n)}` : below1000(n));
  const words = parts.join(' ') || 'Zero';
  return `${neg ? 'Minus ' : ''}Rupees ${words}${paise ? ` and ${below100(paise)} Paise` : ''} Only`;
}

const money = (v: number, code: string) =>
  (Number(v) || 0).toLocaleString(code === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (v: number) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const rateFmt = (v: number) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const pct = (v: number) => `${Number((Number(v) || 0).toFixed(2))}`;
const dmy = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d ?? '-');

interface Col {
  key: string; label: string; w: number; align: 'left' | 'right' | 'center';
  /** cell text; the flexible column (w = 0) gets the item + its details */
  cell?: (l: PoLine, i: number) => string;
}

/** Line columns per PO type — the set on the client's sample prints (Job No → IO No). */
function columnsFor(type: PoType, cur: string): Col[] {
  const io: Col = { key: 'io', label: 'IO No', w: 72, align: 'left', cell: (l) => l.job ?? '' };
  const qtyU: Col = { key: 'qty', label: 'Quantity', w: 84, align: 'right', cell: (l) => `${qtyFmt(l.qty)} ${l.uom}`.trim() };
  const rate: Col = { key: 'rate', label: 'Rate', w: 58, align: 'right', cell: (l) => rateFmt(l.rate) };
  const amt = (label: string): Col => ({ key: 'amt', label: cur === 'INR' ? label : `${label} (${cur})`, w: 72, align: 'right', cell: (l) => money(l.taxable, cur) });
  const gst: Col = { key: 'gst', label: 'GST %', w: 32, align: 'center', cell: (l) => (l.gstRate ? pct(l.gstRate) : '') };
  if (type === 'trim') {
    return [
      { ...io, w: 66 }, { key: 'desc', label: 'Accessory', w: 0, align: 'left' },
      { key: 'color', label: 'Color', w: 56, align: 'left', cell: (l) => l.color ?? '' },
      { key: 'size', label: 'Size', w: 40, align: 'center', cell: (l) => l.size ?? '' },
      gst, { ...qtyU, label: 'Qty', w: 70 }, rate, amt('Amount'),
    ];
  }
  if (type === 'general') {
    return [
      { key: 'sn', label: 'S.No', w: 30, align: 'center', cell: (_l, i) => String(i + 1) },
      { key: 'desc', label: 'Particulars', w: 0, align: 'left' },
      { ...qtyU, label: 'Qty', w: 80 }, gst, { ...rate, w: 64 }, amt('Value'),
    ];
  }
  return [io, { key: 'desc', label: 'Description', w: 0, align: 'left' }, qtyU, rate, amt('Amount')];
}

/** Signature row per sample (yarn's "computer generated" note; fabric Verified By; trims Receiver's; general three). */
function signatures(doc: PoDocument): { left: string[]; centre?: string[]; right: string[]; note?: string } {
  if (doc.type === 'yarn') return { left: [], right: ['Authorised Signatory'], note: '*This is a Computer generated Yarn PO and it does not require any signature' };
  if (doc.type === 'fabric') return { left: ['Verified By'], right: ['Authorised Signatory'] };
  if (doc.type === 'trim') return { left: ["Receiver's Signatory"], right: ['Authorised Signatory'] };
  return { left: ['Order Accepted By'], centre: [doc.preparedBy ?? '', 'Prepared By'], right: ['Authorised Signature'] };
}

export function renderPoPdf(doc: PoDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: 'A4', margins: { top: M, bottom: 4, left: M, right: M }, bufferPages: true,
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
  const X0 = M;
  const X1 = M + W;
  const hline = (yy: number, x0 = X0, x1 = X1) => pdf.moveTo(x0, yy).lineTo(x1, yy).lineWidth(0.6).strokeColor(RULE).stroke();
  const vline = (x: number, y0: number, y1: number) => pdf.moveTo(x, y0).lineTo(x, y1).lineWidth(0.6).strokeColor(RULE).stroke();
  pdf.fillColor(INK);

  // ================================================================ header (first page)
  let y = M + 5;
  pdf.font('Helvetica-Bold').fontSize(8.5).text('PURCHASE ORDER', X0, y, { width: W, align: 'center', underline: true });
  y = pdf.y + 3;
  if (doc.company.logoFile) {
    try { pdf.image(doc.company.logoFile, X0 + P, y, { fit: [52, 52] }); } catch { /* unreadable logo: print without it */ }
  }
  pdf.font('Helvetica-Bold').fontSize(15).text(T(doc.company.name), X0 + 64, y, { width: W - 128, align: 'center' });
  if (doc.company.tradeName) pdf.font('Helvetica').fontSize(8).fillColor(MUTED).text(T(`(${doc.company.tradeName})`), X0 + 64, pdf.y, { width: W - 128, align: 'center' });
  pdf.font('Helvetica').fontSize(8.5).fillColor(INK).text(T(doc.company.address.join(', ')), X0 + 64, pdf.y + 1, { width: W - 128, align: 'center' });
  y = Math.max(pdf.y + 4, doc.company.logoFile ? y + 54 : 0);
  pdf.font('Helvetica-Bold').fontSize(8.5)
    .text(T(`GST IN.: ${doc.company.gstin ?? '-'}`), X0 + P, y, { width: W / 2 - P })
    .text(T(doc.company.phone ? `Phone No: ${doc.company.phone}` : doc.company.email ?? ''), X0 + W / 2, y, { width: W / 2 - P, align: 'right' });
  y = pdf.y + 3;
  hline(y);

  // ================================================================ To: supplier | PO No / Date
  const splitX = X0 + W * 0.6;
  const toTop = y;
  pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('To', X0 + P, y + 4);
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(T(doc.supplier.name), X0 + P + 14, y + 4, { width: splitX - X0 - 2 * P - 14 });
  pdf.font('Helvetica').fontSize(8.5);
  for (const a of doc.supplier.address) pdf.text(T(a), X0 + P + 14, pdf.y, { width: splitX - X0 - 2 * P - 14 });
  pdf.font('Helvetica-Bold').text(T(`GST IN : ${doc.supplier.gstin ?? '-'}`), X0 + P + 14, pdf.y + 1, { width: splitX - X0 - 2 * P - 14 });
  const sc = [doc.supplier.phone ? `Ph: ${doc.supplier.phone}` : null, doc.supplier.email].filter(Boolean).join('  |  ');
  if (sc) pdf.font('Helvetica').text(T(sc), X0 + P + 14, pdf.y, { width: splitX - X0 - 2 * P - 14 });
  const leftBottom = pdf.y + 4;

  const right: [string, string, boolean?][] = [
    ['PO No', doc.no, true],
    ['PO Date', dmy(doc.date), true],
    ...(doc.deliveryDate ? [['Delivery Date', dmy(doc.deliveryDate)] as [string, string]] : []),
    ...(doc.paymentTerms ? [['Payment Terms', doc.paymentTerms] as [string, string]] : []),
    ...doc.meta.map(([k, v]) => [k === 'IO / Job No' ? 'IO No' : k, v] as [string, string]),
    ...(cur !== 'INR' ? [['Currency', `${cur} @ ${doc.exchangeRate}`] as [string, string]] : []),
    ...(doc.status !== 'APPROVED' ? [['Status', doc.status.charAt(0) + doc.status.slice(1).toLowerCase()] as [string, string]] : []),
  ];
  let ry = y + 4;
  const lw = 66;
  for (const [k, v, big] of right) {
    pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(T(k), splitX + P, ry + (big ? 1 : 0), { width: lw });
    pdf.font('Helvetica-Bold').fontSize(big ? 10 : 8.5).fillColor(INK).text(T(`: ${v}`), splitX + P + lw, ry, { width: X1 - splitX - lw - 2 * P });
    ry = Math.max(pdf.y, ry + 11) + 2;
  }
  y = Math.max(leftBottom, ry + 2);
  vline(splitX, toTop, y);
  hline(y);

  // ================================================================ billing | shipping address
  const half = W / 2;
  const addrTop = y;
  const ship = doc.shipSameAsBilling ? `${doc.shippingAddress}` : doc.shippingAddress;
  pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('BILLING ADDRESS', X0 + P, y + 4, { width: half - 2 * P });
  pdf.font('Helvetica').fontSize(8).fillColor(INK).text(T(doc.billingAddress), X0 + P, pdf.y + 1, { width: half - 2 * P });
  const bb = pdf.y;
  pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED)
    .text(doc.shipSameAsBilling ? 'SHIPPING / DELIVERY ADDRESS (same as billing)' : 'SHIPPING / DELIVERY ADDRESS', X0 + half + P, y + 4, { width: half - 2 * P });
  pdf.font('Helvetica').fontSize(8).fillColor(INK).text(T(ship), X0 + half + P, pdf.y + 1, { width: half - 2 * P });
  y = Math.max(bb, pdf.y) + 4;
  vline(X0 + half, addrTop, y);
  hline(y);

  // ================================================================ line table
  const cols = columnsFor(doc.type, cur);
  cols[cols.findIndex((c) => c.w === 0)].w = W - cols.reduce((s, c) => s + c.w, 0);
  const colX: number[] = [];
  { let x = X0; for (const c of cols) { colX.push(x); x += c.w; } }
  const descIdx = cols.findIndex((c) => c.key === 'desc');
  const cp = 3;

  let segTop = y;   // top of this page's table section (for the column rules)
  const tableHeader = () => {
    pdf.rect(X0, y, W, 17).fill(HEAD_BG);
    pdf.fillColor(INK).font('Helvetica-Bold').fontSize(8);
    cols.forEach((c, i) => pdf.text(T(c.label), colX[i] + cp, y + 5, { width: c.w - 2 * cp, align: c.align === 'left' ? 'left' : 'center', lineBreak: false, ellipsis: true }));
    hline(y); hline(y + 17);
    y += 17;
  };
  const closeSegment = (bottom: number) => {
    for (let i = 1; i < cols.length; i++) vline(colX[i], segTop, bottom);
    hline(bottom);
  };
  const newPage = () => {
    pdf.addPage();
    y = M + 6;
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(T(`${doc.company.name}  -  PURCHASE ORDER ${doc.no} (continued)`), X0 + P, y, { width: W - 2 * P });
    y = pdf.y + 5;
    hline(y);
    segTop = y;
    tableHeader();
  };

  tableHeader();
  const descText = (l: PoLine) => {
    const extra = [...l.details];
    if (doc.type === 'general' && l.job) extra.push(`IO No: ${l.job}`);
    if (l.hsn) extra.push(`HSN: ${l.hsn}`);
    return extra;
  };
  const descW = cols[descIdx].w - 2 * cp;
  doc.lines.forEach((l, i) => {
    const extra = descText(l);
    pdf.font('Helvetica-Bold').fontSize(8.5);
    const h1 = pdf.heightOfString(T(l.description), { width: descW });
    pdf.font('Helvetica').fontSize(7.5);
    const h2 = extra.length ? pdf.heightOfString(T(extra.join('\n')), { width: descW }) + 1 : 0;
    let hc = 0;
    pdf.font('Helvetica').fontSize(8.5);
    cols.forEach((c) => { if (c.cell) hc = Math.max(hc, pdf.heightOfString(T(c.cell(l, i)), { width: c.w - 2 * cp })); });
    const rowH = Math.max(h1 + h2, hc) + 2 * cp + 2;
    if (y + rowH > FRAME_BOTTOM) { closeSegment(FRAME_BOTTOM); newPage(); }
    const dx = colX[descIdx] + cp;
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(T(l.description), dx, y + cp, { width: descW });
    if (extra.length) pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(T(extra.join('\n')), dx, pdf.y + 1, { width: descW });
    pdf.fillColor(INK);
    cols.forEach((c, ci) => {
      if (!c.cell) return;
      pdf.font(c.key === 'amt' ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
        .text(T(c.cell(l, i)), colX[ci] + cp, y + cp, { width: c.w - 2 * cp, align: c.align });
    });
    y += rowH;
  });
  if (!doc.lines.length) {
    pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('No items on this purchase order', X0, y + 6, { width: W, align: 'center' });
    y += 22;
  }

  // ---------------------------------------------------------------- footer block (anchored to the frame bottom)
  const t = doc.totals;
  const taxRows: [string, number][] = [];
  for (const g of t.gstGroups.filter((x) => x.tax)) {
    if (doc.isInterstate) taxRows.push([`IGST @ ${pct(g.rate)}%`, g.tax]);
    else {
      const c = Math.round((g.tax / 2) * 100) / 100;
      taxRows.push([`CGST @ ${pct(g.rate / 2)}%`, c]);
      taxRows.push([`SGST @ ${pct(g.rate / 2)}%`, Math.round((g.tax - c) * 100) / 100]);
    }
  }
  for (const [k, v] of t.charges) taxRows.push([k, v]);
  if (t.tcs) taxRows.push(['TCS', t.tcs]);
  taxRows.push(['Round Off', t.roundOff]);

  const leftNotes: string[] = [];
  if (doc.type === 'yarn') leftNotes.push(`Mill Name: ${doc.supplier.name}`);
  if (doc.remarks) leftNotes.push(`Remarks: ${doc.remarks}`);
  const leftW = W * 0.55 - 2 * P;
  pdf.font('Helvetica').fontSize(8.5);
  const notesH = leftNotes.length ? pdf.heightOfString(T(leftNotes.join('\n')), { width: leftW }) : 0;
  const words = cur === 'INR' ? inrWords(t.grandTotal) : amountWords(t.grandTotal, cur);
  pdf.font('Helvetica-Bold').fontSize(8.5);
  const wordsH = pdf.heightOfString(T(words), { width: W - 150 - 2 * P });
  const sig = signatures(doc);
  const totalRowH = 17;
  const taxH = Math.max(taxRows.length * 12, notesH) + 10;
  const netH = Math.max(wordsH, 12) + 12;
  const signH = 64;
  const footerH = totalRowH + taxH + netH + signH;

  if (y + footerH > FRAME_BOTTOM) { closeSegment(FRAME_BOTTOM); newPage(); }
  let fy = FRAME_BOTTOM - footerH;
  closeSegment(fy);                         // column rules run down to the Total row (like the samples)

  // Total row: qty under the qty column, taxable value under the amount column
  const qIdx = cols.findIndex((c) => c.key === 'qty');
  const aIdx = cols.findIndex((c) => c.key === 'amt');
  const uoms = new Set(doc.lines.map((l) => l.uom));
  const totQty = doc.lines.reduce((s, l) => s + l.qty, 0);
  pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK)
    .text('Total', colX[descIdx] + cp, fy + 5, { width: cols[descIdx].w - 2 * cp, align: 'right' });
  if (qIdx >= 0) pdf.text(`${qtyFmt(totQty)}${uoms.size === 1 ? ` ${T([...uoms][0])}` : ''}`, colX[qIdx] + cp, fy + 5, { width: cols[qIdx].w - 2 * cp, align: 'right' });
  pdf.text(money(t.taxable, cur), colX[aIdx] + cp, fy + 5, { width: cols[aIdx].w - 2 * cp, align: 'right' });
  for (let i = 1; i < cols.length; i++) vline(colX[i], fy, fy + totalRowH);
  fy += totalRowH;
  hline(fy);

  // tax lines (right) + mill name / remarks (left)
  let ty = fy + 5;
  for (const [k, v] of taxRows) {
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
      .text(T(`${k} :`), X1 - 230, ty, { width: 140, align: 'right' })
      .text(money(v, cur), X1 - 86, ty, { width: 80, align: 'right' });
    ty += 12;
  }
  if (leftNotes.length) pdf.font('Helvetica').fontSize(8.5).fillColor(INK).text(T(leftNotes.join('\n')), X0 + P, fy + 5, { width: leftW });
  fy += taxH;
  hline(fy);

  // amount in words | net amount
  pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(T(words), X0 + P, fy + 6, { width: W - 150 - 2 * P });
  pdf.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('Net Amount :', X1 - 150, fy + 6, { width: 62, align: 'right' });
  pdf.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(money(t.grandTotal, cur), X1 - 86, fy + 5, { width: 80, align: 'right' });
  fy += netH;
  hline(fy);

  // For <COMPANY> + signature labels
  pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(T(`For ${doc.company.name}`), X0 + P, fy + 6, { width: W - 2 * P, align: 'right' });
  const sy = FRAME_BOTTOM - 14;
  pdf.font('Helvetica').fontSize(8.5).fillColor(INK);
  if (sig.left.length) pdf.text(T(sig.left.join('\n')), X0 + P, sy, { width: W / 3 });
  if (sig.centre) {
    const [name, label] = sig.centre;
    if (name) pdf.font('Helvetica').fontSize(8).fillColor(MUTED).text(T(name), X0 + W / 3, sy - 11, { width: W / 3, align: 'center' });
    pdf.font('Helvetica').fontSize(8.5).fillColor(INK).text(T(label), X0 + W / 3, sy, { width: W / 3, align: 'center' });
  }
  if (sig.note) pdf.font('Helvetica-Bold').fontSize(7.5).text(T(sig.note), X0 + P, sy + 1, { width: W * 0.62 });
  pdf.font('Helvetica').fontSize(8.5).text(T(sig.right.join('\n')), X1 - W / 3 - P, sy, { width: W / 3, align: 'right' });

  // ================================================================ every page: frame, page number, watermark
  const range = pdf.bufferedPageRange();
  const mark = doc.isCancelled ? doc.status : doc.isDraft ? 'DRAFT' : null;
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    pdf.rect(X0, M, W, FRAME_BOTTOM - M).lineWidth(0.9).strokeColor(INK).stroke();
    pdf.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(T(`${doc.title} ${doc.no}`), X0, FRAME_BOTTOM + 3, { width: W / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, X0 + W / 2, FRAME_BOTTOM + 3, { width: W / 2, align: 'right', lineBreak: false });
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
