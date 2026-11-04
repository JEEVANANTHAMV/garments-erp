/**
 * Knitting – Yarn Issue / Delivery Challan PDF (C-ONE ERP specification, 04-Nov-2026).
 *
 * A4 portrait only (595.28 × 841.89 pt), ~10 mm margins, premium Navy #12345A / #0D2B4D + Champagne Gold #D9A441
 * on white, geometric footer motif. Order: branding → DC details → e-way bill panel (only when required) → item
 * grid → total row → three signature panels → footer.
 *
 * Grid: S.No · Job No. · Yarn Description · Fabric Description · Lot No. · Cones · Net Weight (KG). Column widths
 * are worked out from the content at render time (descriptions get the spare width, fabric first); every cell is
 * measured before its row is drawn and the row grows to the tallest cell — text wraps, never clipped or cut with an
 * ellipsis, body 8.5 pt. A row that does not fit goes to the next A4 portrait page, which repeats the grid header
 * with the DC No. and page number. The last item row, the total row and the signatures are kept together on the
 * final page. Colour is never the only carrier of meaning (solid fills, bold type, borders), so B/W prints read.
 * No rate, amount, gross weight, buyer PO or style is printed.
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { pdfText as T } from '../purchaseDocs/poPdf.js';

export interface YarnIssueDcPdf {
  company: { name: string; address: string; gstin: string | null };
  dc: {
    dc_no: string; dc_date: string; doc_status: string; contractor: string | null; contractor_address: string | null;
    contractor_gstin: string | null; vehicle_no: string | null; purpose: string | null; cancel_reason?: string | null;
  };
  lines: { job_no: string; yarn: string; fabric: string; lot_no: string | null; cones: number; net_kg: number }[];
  eway: null | {
    eway_bill_no: string | null; date_text: string | null; valid_until_text: string | null; expired: boolean; distance_km: number | null;
    transport_mode: string | null; transporter_name: string | null; transporter_gstin: string | null; vehicle_no: string | null;
    qr_payload: string | null; status: string;
  };
  print: { reprint_no: number; printed_at: string; printed_by: string | null };
}

const A4_W = 595.28;
const A4_H = 841.89;
const M = 26;                       // ≈ 9 mm margin
const X0 = M;
const X1 = A4_W - M;
const W = X1 - X0;
const FOOTER_H = 34;
const BOTTOM = A4_H - M - FOOTER_H; // content must stay above this

const NAVY = '#12345A';
const NAVY_D = '#0D2B4D';
const GOLD = '#D9A441';
const GOLD_L = '#FBF1DC';
const INK = '#0F1B2D';
const MUTED = '#4A5A70';
const ALT = '#EDF1F7';
const PANEL = '#F5F7FB';
const LINE = '#7D8BA0';
const BORDER = '#B8C4D4';

const FS = 8.5;                     // body / grid text
const PAD_X = 4;
const PAD_Y = 3.5;

const fmtQty = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

type Doc = PDFKit.PDFDocument;

/* ---------- small vector icons (navy line art on a light tile) ---------- */
function tile(pdf: Doc, x: number, y: number, s = 15) {
  pdf.save().roundedRect(x, y, s, s, 3).fill('#E4EAF3').restore();
}
function icon(pdf: Doc, kind: string, x: number, y: number) {
  tile(pdf, x, y);
  pdf.save().lineWidth(0.9).strokeColor(NAVY);
  const cx = x + 7.5; const cy = y + 7.5;
  switch (kind) {
    case 'doc': pdf.rect(x + 4, y + 3, 7, 9).stroke(); pdf.moveTo(x + 5.5, y + 6).lineTo(x + 9.5, y + 6).moveTo(x + 5.5, y + 8).lineTo(x + 9.5, y + 8).moveTo(x + 5.5, y + 10).lineTo(x + 8, y + 10).stroke(); break;
    case 'cal': pdf.rect(x + 3.5, y + 4, 8, 7.5).stroke(); pdf.moveTo(x + 3.5, y + 6.3).lineTo(x + 11.5, y + 6.3).stroke(); pdf.moveTo(x + 5.5, y + 3).lineTo(x + 5.5, y + 5).moveTo(x + 9.5, y + 3).lineTo(x + 9.5, y + 5).stroke(); break;
    case 'bldg': pdf.rect(x + 3.5, y + 6, 4, 6).stroke(); pdf.rect(x + 7.5, y + 3.5, 4, 8.5).stroke(); break;
    case 'pin': pdf.circle(cx, y + 6, 2.6).stroke(); pdf.moveTo(cx - 2.6, y + 6.6).lineTo(cx, y + 12).lineTo(cx + 2.6, y + 6.6).stroke(); break;
    case 'truck': pdf.rect(x + 2.5, y + 5, 6.5, 4.5).stroke(); pdf.moveTo(x + 9, y + 6.5).lineTo(x + 11, y + 6.5).lineTo(x + 12.5, y + 8).lineTo(x + 12.5, y + 9.5).lineTo(x + 9, y + 9.5).stroke(); pdf.circle(x + 5, y + 11, 1.1).stroke(); pdf.circle(x + 10.5, y + 11, 1.1).stroke(); break;
    case 'target': pdf.circle(cx, cy, 4.5).stroke(); pdf.circle(cx, cy, 2).stroke(); pdf.moveTo(cx, cy).lineTo(cx + 5, cy - 5).stroke(); break;
    case 'pen': pdf.moveTo(x + 4, y + 11).lineTo(x + 11, y + 4).lineTo(x + 12, y + 5).lineTo(x + 5, y + 12).closePath().stroke(); pdf.moveTo(x + 3, y + 13).lineTo(x + 12, y + 13).stroke(); break;
    case 'check': pdf.circle(cx, cy, 4.8).stroke(); pdf.moveTo(cx - 2.3, cy).lineTo(cx - 0.6, cy + 1.8).lineTo(cx + 2.5, cy - 2).stroke(); break;
    default: break;
  }
  pdf.restore();
}

/* ---------- branding ---------- */
function brandMark(pdf: Doc, x: number, y: number, s: number) {
  // isometric cube: navy faces + a gold face (C-ONE mark)
  const h = s / 2;
  pdf.save();
  pdf.polygon([x + h, y], [x + s, y + s * 0.25], [x + h, y + s * 0.5], [x, y + s * 0.25]).fill(NAVY);
  pdf.polygon([x, y + s * 0.25], [x + h, y + s * 0.5], [x + h, y + s], [x, y + s * 0.75]).fill(NAVY_D);
  pdf.polygon([x + h, y + s * 0.5], [x + s, y + s * 0.25], [x + s, y + s * 0.75], [x + h, y + s]).fill(GOLD);
  pdf.restore();
}

function cones(pdf: Doc, x: number, y: number) {
  // three restrained yarn cones (navy, cream, light grey)
  const one = (cx: number, base: number, h: number, fill: string, edge: string) => {
    pdf.save();
    pdf.polygon([cx - 7, base], [cx + 7, base], [cx + 4, base - h], [cx - 4, base - h]).fillAndStroke(fill, edge);
    pdf.ellipse(cx, base, 7, 2).fillAndStroke(fill, edge);
    pdf.rect(cx - 1.2, base - h - 4, 2.4, 4).fill('#C9B48A');
    pdf.restore();
  };
  one(x + 9, y + 36, 26, '#2B5A9E', NAVY_D);
  one(x + 27, y + 32, 26, '#F1E6CF', '#B9A57E');
  one(x + 44, y + 37, 24, '#E9EDF2', '#9AA6B6');
}

function brandHeader(pdf: Doc, d: YarnIssueDcPdf, first: boolean, page: number) {
  let y = M;
  if (!first) {
    // continuation: compact strip with the DC No. (page no is written once the page count is known)
    brandMark(pdf, X0, y, 18);
    pdf.font('Helvetica-Bold').fontSize(12).fillColor(NAVY).text('C-ONE', X0 + 24, y + 3, { continued: true }).fillColor(GOLD).text(' ERP');
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(NAVY_D).text('KNITTING – YARN ISSUE / DELIVERY CHALLAN (continued)', X0 + 120, y + 5, { width: W - 120, align: 'right' });
    y += 22;
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(T(`DC No. ${d.dc.dc_no}`), X0, y, { continued: true })
      .font('Helvetica').fillColor(MUTED).text(`   ·   Page ${page} of `, { continued: false });
    pdf.save().moveTo(X0, y + 13).lineTo(X1, y + 13).lineWidth(1.2).strokeColor(NAVY).stroke()
      .moveTo(X0, y + 14.5).lineTo(X0 + 90, y + 14.5).lineWidth(1).strokeColor(GOLD).stroke().restore();
    return { y: y + 20, pageNoAt: { x: 0, y } };
  }
  brandMark(pdf, X0, y + 2, 34);
  pdf.font('Helvetica-Bold').fontSize(21).fillColor(NAVY).text('C-ONE', X0 + 42, y + 2, { continued: true, lineBreak: false }).fillColor(GOLD).text(' ERP', { lineBreak: false });
  pdf.font('Helvetica').fontSize(7.8).fillColor(MUTED).text('Garment Manufacturing Solutions', X0 + 43, y + 26, { lineBreak: false });
  // divider
  pdf.save().moveTo(X0 + 196, y + 2).lineTo(X0 + 196, y + 38).lineWidth(0.8).strokeColor(BORDER).stroke().restore();
  // title block: navy text line + navy parallelogram band with gold slants
  const tx = X0 + 206;
  pdf.font('Helvetica-Bold').fontSize(11).fillColor(NAVY_D).text('KNITTING – YARN ISSUE', tx + 10, y + 1, { lineBreak: false });
  const by = y + 17; const bh = 22; const bx = tx; const bw = X1 - 62 - bx;
  pdf.save();
  pdf.polygon([bx + 10, by], [bx + bw, by], [bx + bw - 10, by + bh], [bx, by + bh]).fill(NAVY);
  pdf.polygon([bx + 2, by], [bx + 8, by], [bx - 2, by + bh], [bx - 8, by + bh]).fill(GOLD);
  pdf.polygon([bx + bw + 2, by], [bx + bw + 8, by], [bx + bw - 2, by + bh], [bx + bw - 8, by + bh]).fill(GOLD);
  pdf.restore();
  pdf.font('Helvetica-Bold').fontSize(13.5).fillColor('#FFFFFF').text('DELIVERY CHALLAN', bx + 16, by + 5, { width: bw - 26, lineBreak: false });
  cones(pdf, X1 - 54, y);
  y += 44;
  // consignor (our company) — small line under the branding
  const co = [d.company.name, d.company.address, d.company.gstin ? `GSTIN ${d.company.gstin}` : ''].filter(Boolean).join('  ·  ');
  pdf.font('Helvetica').fontSize(7.6).fillColor(MUTED);
  const ch = pdf.heightOfString(T(co), { width: W });
  pdf.text(T(co), X0, y, { width: W });
  y += ch + 3;
  pdf.save().moveTo(X0, y).lineTo(X1, y).lineWidth(1.2).strokeColor(NAVY).stroke()
    .moveTo(X0, y + 1.6).lineTo(X0 + 110, y + 1.6).lineWidth(1).strokeColor(GOLD).stroke().restore();
  return { y: y + 7, pageNoAt: null };
}

/* ---------- DC information panel ---------- */
function infoPanel(pdf: Doc, d: YarnIssueDcPdf, y: number) {
  const split = X0 + W * 0.56;
  const lw = 56; // label width
  const leftVX = X0 + 26 + lw + 8;
  const leftVW = split - 10 - leftVX;
  const rightLX = split + 34;
  const rightVX = rightLX + 66;
  const rightVW = X1 - 8 - rightVX;
  const rowsL: [string, string, string, boolean][] = [
    ['doc', 'DC No.', d.dc.dc_no, true],
    ['cal', 'DC Date', d.dc.dc_date, false],
    ['bldg', 'Contractor', d.dc.contractor ?? '-', false],
    ['pin', 'Address', [d.dc.contractor_address, d.dc.contractor_gstin ? `GSTIN: ${d.dc.contractor_gstin}` : ''].filter(Boolean).join('\n') || '-', false],
  ];
  // measure
  const hL = rowsL.map(([, , v, big]) => {
    pdf.font('Helvetica-Bold').fontSize(big ? 12 : 9);
    return Math.max(17, pdf.heightOfString(T(v), { width: leftVW }) + 4);
  });
  pdf.font('Helvetica-Bold').fontSize(9);
  const vehH = Math.max(18, pdf.heightOfString(T(d.dc.vehicle_no || '-'), { width: rightVW }) + 4);
  pdf.font('Helvetica-Bold').fontSize(10);
  const purH = pdf.heightOfString(T(d.dc.purpose || '-'), { width: X1 - 10 - rightLX - 12 }) + 10;
  const hR = 8 + vehH + 8 + 14 + purH + 6;
  const h = Math.max(hL.reduce((a, b) => a + b, 0) + 10, hR);
  pdf.save().roundedRect(X0, y, W, h, 6).lineWidth(0.9).strokeColor(BORDER).stroke().restore();
  pdf.save().moveTo(split, y + 8).lineTo(split, y + h - 8).lineWidth(0.8).strokeColor(BORDER).stroke().restore();
  let ry = y + 5;
  rowsL.forEach(([ic, label, v, big], i) => {
    icon(pdf, ic, X0 + 7, ry + 1);
    pdf.font('Helvetica-Bold').fontSize(8.6).fillColor(NAVY_D).text(label, X0 + 26, ry + 3, { width: lw, lineBreak: false });
    pdf.font('Helvetica-Bold').fontSize(8.6).fillColor(INK).text(':', X0 + 26 + lw, ry + 3, { lineBreak: false });
    pdf.font(big ? 'Helvetica-Bold' : 'Helvetica').fontSize(big ? 12 : 9).fillColor(INK).text(T(v), leftVX, ry + (big ? 1 : 3), { width: leftVW });
    ry += hL[i];
  });
  // right: vehicle + purpose
  let yy = y + 8;
  icon(pdf, 'truck', split + 12, yy);
  pdf.font('Helvetica-Bold').fontSize(8.6).fillColor(NAVY_D).text('Vehicle No.', rightLX, yy + 3, { width: 56, lineBreak: false });
  pdf.text(':', rightLX + 58, yy + 3, { lineBreak: false });
  pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(T(d.dc.vehicle_no || '-'), rightVX, yy + 3, { width: rightVW });
  yy += vehH + 8;
  icon(pdf, 'target', split + 12, yy);
  pdf.font('Helvetica-Bold').fontSize(8.6).fillColor(NAVY_D).text('Purpose', rightLX, yy + 3, { width: 48, lineBreak: false });
  yy += 16;
  pdf.save().roundedRect(rightLX - 4, yy - 2, X1 - 8 - rightLX + 4, purH, 4).fill(GOLD_L).restore();
  pdf.save().rect(rightLX - 4, yy - 2, 2.2, purH).fill(GOLD).restore();
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(NAVY_D).text(T(d.dc.purpose || '-'), rightLX + 4, yy + 3, { width: X1 - 10 - rightLX - 12 });
  return y + h + 8;
}

/* ---------- e-way bill panel ---------- */
async function ewayPanel(pdf: Doc, e: NonNullable<YarnIssueDcPdf['eway']>, y: number) {
  const qr = e.qr_payload ? await QRCode.toBuffer(e.qr_payload, { errorCorrectionLevel: 'M', margin: 0, width: 240 }) : null;
  const qrW = qr ? 70 : 0;
  const zoneW = (W - 16 - (qr ? qrW + 14 : 0)) / 2;
  const lx = X0 + 10; const mx = lx + zoneW + 8;
  const left: [string, string][] = [
    ['E-Way Bill No.', e.eway_bill_no || (e.status === 'PENDING' ? 'Pending details' : '-')],
    ['E-Way Bill Date', e.date_text || '-'],
    ['Valid Until', e.valid_until_text ? `${e.valid_until_text}${e.expired ? '  (EXPIRED)' : ''}` : '-'],
    ['Approx. Distance', e.distance_km != null ? `${fmtQty(e.distance_km).replace(/\.00$/, '')} KM` : '-'],
  ];
  const mid: [string, string][] = [
    ['Transport Mode', e.transport_mode || '-'],
    ['Transporter', e.transporter_name || '-'],
    ['Transporter GSTIN', e.transporter_gstin || '-'],
    ['Vehicle No.', e.vehicle_no || '-'],
  ];
  const lab = 88; const vw = zoneW - lab - 8;
  const rowH = (k: string, v: string, bold: boolean) => { pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.6); return Math.max(13, pdf.heightOfString(T(v), { width: vw }) + 3); };
  const hs = left.map(([k, v], i) => Math.max(rowH(k, v, i === 0), rowH(mid[i][0], mid[i][1], false)));
  const bodyH = Math.max(hs.reduce((a, b) => a + b, 0), qr ? qrW + 12 : 0);
  const tabH = 17;
  const h = tabH + 6 + bodyH + 6;
  // panel + tab
  pdf.save().roundedRect(X0, y + 4, W, h - 4, 6).fillAndStroke(PANEL, BORDER).restore();
  pdf.save().polygon([X0, y], [X0 + 168, y], [X0 + 156, y + tabH], [X0, y + tabH]).fill(NAVY).restore();
  pdf.save().polygon([X0 + 170, y], [X0 + 175, y], [X0 + 163, y + tabH], [X0 + 158, y + tabH]).fill(GOLD).restore();
  pdf.save().lineWidth(0.9).strokeColor('#FFFFFF');
  pdf.rect(X0 + 8, y + 5, 8, 6).stroke(); pdf.moveTo(X0 + 16, y + 7).lineTo(X0 + 19, y + 7).lineTo(X0 + 20.5, y + 9).lineTo(X0 + 20.5, y + 11).lineTo(X0 + 16, y + 11).stroke();
  pdf.restore();
  pdf.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF').text('E-Way Bill Details', X0 + 26, y + 4, { lineBreak: false });
  let ry = y + tabH + 6;
  for (let i = 0; i < 4; i++) {
    const [k, v] = left[i]; const [k2, v2] = mid[i];
    pdf.font('Helvetica-Bold').fontSize(8.2).fillColor(NAVY_D).text(k, lx, ry, { width: lab, lineBreak: false }).text(':', lx + lab - 4, ry, { lineBreak: false });
    pdf.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.6).fillColor(INK).text(T(v), lx + lab + 4, ry, { width: vw });
    pdf.font('Helvetica-Bold').fontSize(8.2).fillColor(NAVY_D).text(k2, mx, ry, { width: lab, lineBreak: false }).text(':', mx + lab - 4, ry, { lineBreak: false });
    pdf.font('Helvetica').fontSize(8.6).fillColor(INK).text(T(v2), mx + lab + 4, ry, { width: vw });
    ry += hs[i];
  }
  pdf.save().moveTo(mx - 6, y + tabH + 4).lineTo(mx - 6, y + h - 6).lineWidth(0.7).strokeColor(BORDER).stroke().restore();
  if (qr) {
    const qx = X1 - 10 - qrW; const qy = y + tabH + 4;
    pdf.save().moveTo(qx - 8, y + tabH + 4).lineTo(qx - 8, y + h - 6).lineWidth(0.7).strokeColor(BORDER).stroke().restore();
    pdf.save().rect(qx - 2, qy - 2, qrW + 4, qrW + 4).fillAndStroke('#FFFFFF', BORDER).restore();
    pdf.image(qr, qx, qy, { width: qrW, height: qrW });
    pdf.font('Helvetica').fontSize(7.4).fillColor(MUTED).text('E-Way Bill QR', qx - 6, qy + qrW + 3, { width: qrW + 12, align: 'center' });
  }
  return y + h + 8;
}

/* ---------- grid ---------- */
const HEADERS = ['S.No', 'Job No.', 'Yarn Description', 'Fabric Description', 'Lot No.', 'Cones', 'Net Weight (KG)'];
const ALIGN: ('left' | 'center' | 'right')[] = ['center', 'center', 'left', 'left', 'center', 'center', 'right'];

/** Column widths from the content: fixed narrow numbers, job / lot as wide as their longest value (within limits), descriptions share the rest — fabric first. */
export function columnWidths(pdf: Doc, rows: string[][]): number[] {
  const nat = (col: number, bold = false) => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS);
    return Math.max(...rows.map((r) => Math.max(...String(r[col] ?? '').split('\n').map((s) => pdf.widthOfString(T(s))))), 0) + 2 * PAD_X + 1;
  };
  pdf.font('Helvetica-Bold').fontSize(FS);
  const head = (col: number) => pdf.widthOfString(HEADERS[col]) + 2 * PAD_X + 1;
  const sno = Math.max(24, nat(0), head(0));
  const cones = Math.max(38, nat(5), head(5));
  const net = Math.max(56, nat(6), pdf.widthOfString('Net Weight') + 2 * PAD_X + 2);
  let job = Math.min(104, Math.max(58, nat(1, true), head(1)));
  let lot = Math.min(84, Math.max(46, nat(4), head(4)));
  const MIN_DESC = 104;
  let rest = W - sno - cones - net - job - lot;
  if (rest < 2 * MIN_DESC) {
    // give back from job / lot (they wrap) before the descriptions go below their minimum
    const need = 2 * MIN_DESC - rest;
    const fromJob = Math.min(need / 2, job - 58); job -= fromJob;
    const fromLot = Math.min(need - fromJob, lot - 46); lot -= fromLot;
    rest = W - sno - cones - net - job - lot;
  }
  const ny = nat(2); const nf = nat(3) * 1.15;      // fabric description has priority for spare width
  let yarn: number; let fab: number;
  if (ny + nf <= rest) {
    const spare = rest - ny - nf;
    yarn = ny + spare * 0.38; fab = rest - yarn;
  } else {
    yarn = Math.max(MIN_DESC, rest * ny / (ny + nf));
    fab = rest - yarn;
    if (fab < MIN_DESC) { fab = MIN_DESC; yarn = rest - fab; }
  }
  return [sno, job, yarn, fab, lot, cones, net];
}

function cellHeight(pdf: Doc, text: string, w: number, bold: boolean) {
  pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS);
  return pdf.heightOfString(T(text) || ' ', { width: w - 2 * PAD_X });
}

function drawGridHeader(pdf: Doc, cw: number[], y: number) {
  pdf.font('Helvetica-Bold').fontSize(FS);
  const hh = Math.max(...HEADERS.map((h, i) => pdf.heightOfString(h, { width: cw[i] - 2 * PAD_X }))) + 2 * PAD_Y + 2;
  pdf.save().rect(X0, y, W, hh).fill(NAVY).restore();
  let x = X0;
  HEADERS.forEach((h, i) => {
    const th = pdf.heightOfString(h, { width: cw[i] - 2 * PAD_X });
    pdf.fillColor('#FFFFFF').text(h, x + PAD_X, y + (hh - th) / 2, { width: cw[i] - 2 * PAD_X, align: 'center' });
    if (i > 0) pdf.save().moveTo(x, y).lineTo(x, y + hh).lineWidth(0.6).strokeColor('#5D7896').stroke().restore();
    x += cw[i];
  });
  pdf.save().rect(X0, y + hh - 1.4, W, 1.4).fill(GOLD).restore();
  return y + hh;
}

function drawRow(pdf: Doc, cw: number[], cells: string[], y: number, h: number, alt: boolean) {
  if (alt) pdf.save().rect(X0, y, W, h).fill(ALT).restore();
  let x = X0;
  cells.forEach((c, i) => {
    const bold = i === 1;
    if (i === 1 && c) {
      // job no. on a light gold tag
      pdf.save().roundedRect(x + 2, y + 2, cw[i] - 4, h - 4, 2.5).fill(GOLD_L).restore();
    }
    const th = cellHeight(pdf, c, cw[i], bold);
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FS).fillColor(INK)
      .text(T(c), x + PAD_X, y + (h - th) / 2, { width: cw[i] - 2 * PAD_X, align: ALIGN[i] });
    x += cw[i];
  });
  // grid lines
  pdf.save().lineWidth(0.5).strokeColor(LINE);
  x = X0;
  for (let i = 0; i < cw.length - 1; i++) { x += cw[i]; pdf.moveTo(x, y).lineTo(x, y + h); }
  pdf.moveTo(X0, y + h).lineTo(X1, y + h);
  pdf.moveTo(X0, y).lineTo(X0, y + h).moveTo(X1, y).lineTo(X1, y + h);
  pdf.stroke().restore();
}

function drawTotal(pdf: Doc, cw: number[], y: number, cones: number, net: number) {
  const h = 22;
  const xc = X0 + cw.slice(0, 5).reduce((a, b) => a + b, 0);
  pdf.save().rect(X0, y, W, h).fill(NAVY_D).restore();
  // gold band behind the totals with a slanted lead-in
  pdf.save().polygon([xc - 14, y + h], [xc, y], [X1, y], [X1, y + h]).fill(GOLD).restore();
  pdf.save().moveTo(xc + cw[5], y + 3).lineTo(xc + cw[5], y + h - 3).lineWidth(0.8).strokeColor(NAVY_D).stroke().restore();
  pdf.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF').text('Total', X0, y + 6, { width: xc - X0 - 22, align: 'right' });
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(NAVY_D)
    .text(fmtInt(cones), xc + PAD_X, y + 6.5, { width: cw[5] - 2 * PAD_X, align: 'center' })
    .text(fmtQty(net), xc + cw[5] + PAD_X, y + 6.5, { width: cw[6] - 2 * PAD_X, align: 'right' });
  return y + h;
}

const SIG_H = 74;
function drawSignatures(pdf: Doc, y: number) {
  const gap = 12; const w = (W - 2 * gap) / 3;
  const items: [string, string][] = [['pen', 'Prepared By'], ['check', 'Checked By'], ['truck', 'Received By (Contractor)']];
  items.forEach(([ic, label], i) => {
    const x = X0 + i * (w + gap);
    pdf.save().roundedRect(x, y, w, SIG_H, 5).lineWidth(0.9).strokeColor(BORDER).stroke().restore();
    pdf.save().rect(x + 0.5, y + 0.5, w - 1, 20).fill(ALT).restore();
    icon(pdf, ic, x + 8, y + 3);
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(NAVY_D).text(label, x + 28, y + 6.5, { width: w - 34, lineBreak: false });
    pdf.save().moveTo(x + 12, y + SIG_H - 22).lineTo(x + w - 12, y + SIG_H - 22).lineWidth(0.7).strokeColor(INK).stroke().restore();
    pdf.font('Helvetica').fontSize(8).fillColor(MUTED).text('Signature & Date', x, y + SIG_H - 16, { width: w, align: 'center' });
  });
  return y + SIG_H;
}

function footer(pdf: Doc) {
  const y = A4_H - M - 14;
  pdf.save();
  pdf.polygon([0, y], [96, y], [80, y + 14], [0, y + 14]).fill(NAVY);
  pdf.polygon([102, y], [116, y], [100, y + 14], [86, y + 14]).fill(GOLD);
  pdf.polygon([A4_W, y], [A4_W - 96, y], [A4_W - 80, y + 14], [A4_W, y + 14]).fill(NAVY);
  pdf.polygon([A4_W - 102, y], [A4_W - 116, y], [A4_W - 100, y + 14], [A4_W - 86, y + 14]).fill(GOLD);
  pdf.moveTo(132, y + 7).lineTo(A4_W / 2 - 52, y + 7).lineWidth(1).strokeColor(GOLD).stroke();
  pdf.moveTo(A4_W / 2 + 52, y + 7).lineTo(A4_W - 132, y + 7).lineWidth(1).strokeColor(GOLD).stroke();
  pdf.restore();
  pdf.font('Helvetica-Bold').fontSize(10).fillColor(NAVY).text('C-ONE  ERP', A4_W / 2 - 50, y + 2, { width: 100, align: 'center', characterSpacing: 2, lineBreak: false });
}

function watermark(pdf: Doc, text: string) {
  pdf.save();
  pdf.rotate(-35, { origin: [A4_W / 2, A4_H / 2] });
  pdf.font('Helvetica-Bold').fontSize(86).fillColor('#9AA6B6').opacity(0.18)
    .text(text, 0, A4_H / 2 - 50, { width: A4_W, align: 'center', lineBreak: false });
  pdf.restore();
  pdf.opacity(1);
}

/** Renders the DC; resolves to the PDF bytes. */
export async function renderYarnIssueDcPdf(d: YarnIssueDcPdf): Promise<Buffer> {
  const pdf = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 0, bufferPages: true, autoFirstPage: true,
    info: { Title: `Knitting Yarn Issue DC ${d.dc.dc_no}`, Author: d.company.name, Subject: 'Knitting – Yarn Issue / Delivery Challan' } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });

  const stamp = d.dc.doc_status === 'CANCELLED' ? 'CANCELLED' : d.dc.doc_status === 'DRAFT' ? 'DRAFT' : null;
  const contPageNo: { page: number; y: number }[] = [];
  let page = 1;
  const newPage = () => {
    pdf.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
    page += 1;
    if (stamp) watermark(pdf, stamp);
    footer(pdf);
    const hd = brandHeader(pdf, d, false, page);
    contPageNo.push({ page, y: hd.pageNoAt!.y });
    return hd.y;
  };

  if (stamp) watermark(pdf, stamp);
  footer(pdf);
  let y = brandHeader(pdf, d, true, 1).y;
  if (d.dc.doc_status === 'CANCELLED' && d.dc.cancel_reason) {
    pdf.font('Helvetica-Bold').fontSize(8.6).fillColor(INK).text(T(`CANCELLED — ${d.dc.cancel_reason}`), X0, y, { width: W });
    y = pdf.y + 4;
  }
  y = infoPanel(pdf, d, y);
  if (d.eway) y = await ewayPanel(pdf, d.eway, y);

  const rows = d.lines.map((l, i) => [String(i + 1), l.job_no, l.yarn, l.fabric, l.lot_no ?? '', fmtInt(l.cones), fmtQty(l.net_kg)]);
  const cw = columnWidths(pdf, rows.length ? rows : [['', '', '', '', '', '', '']]);
  y = drawGridHeader(pdf, cw, y);
  const heights = rows.map((r) => Math.max(...r.map((c, i) => cellHeight(pdf, c, cw[i], i === 1))) + 2 * PAD_Y);
  const TOTAL_H = 22;
  const tail = TOTAL_H + 14 + SIG_H;   // total row + gap + signatures (kept with the last item row)
  rows.forEach((r, i) => {
    const last = i === rows.length - 1;
    const need = heights[i] + (last ? tail : 0);
    if (y + need > BOTTOM) {
      y = newPage();
      y = drawGridHeader(pdf, cw, y);
    }
    drawRow(pdf, cw, r, y, heights[i], i % 2 === 1);
    y += heights[i];
  });
  if (!rows.length && y + tail > BOTTOM) { y = newPage(); y = drawGridHeader(pdf, cw, y); }
  y = drawTotal(pdf, cw, y, d.lines.reduce((a, l) => a + (Number(l.cones) || 0), 0), d.lines.reduce((a, l) => a + (Number(l.net_kg) || 0), 0));
  // signatures together at the bottom of the final page
  const sigY = Math.max(y + 14, BOTTOM - SIG_H - 4);
  drawSignatures(pdf, sigY);

  // page numbers (count known now): footer line on every page, "Page n of N" in the continuation strips
  const range = pdf.bufferedPageRange();
  const total = range.count;
  for (let i = 0; i < total; i++) {
    pdf.switchToPage(range.start + i);
    const info = `DC No. ${d.dc.dc_no}  ·  Page ${i + 1} of ${total}` +
      (d.print.reprint_no > 1 ? `  ·  Reprint ${d.print.reprint_no}` : '') + `  ·  Printed ${d.print.printed_at}${d.print.printed_by ? ` by ${d.print.printed_by}` : ''}`;
    pdf.font('Helvetica').fontSize(7.2).fillColor(MUTED).text(T(info), X0, A4_H - M - 27, { width: W, align: 'right', lineBreak: false });
    const c = contPageNo.find((x) => x.page === i + 1);
    if (c) {
      pdf.font('Helvetica-Bold').fontSize(9).fillColor(INK);
      const pre = pdf.widthOfString(T(`DC No. ${d.dc.dc_no}`));
      pdf.font('Helvetica').fontSize(9);
      const mid = pdf.widthOfString(`   ·   Page ${i + 1} of `);
      pdf.fillColor(MUTED).text(String(total), X0 + pre + mid, c.y, { lineBreak: false });
    }
  }
  pdf.end();
  return done;
}

