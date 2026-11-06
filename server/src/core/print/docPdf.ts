/**
 * ONE print engine for every business document (POs, DCs, invoices …) — client voice notes 05-Nov-2026:
 * "same design for everything", light professional colours (or classic black & white), OUR company logo + name +
 * address on top, no software branding, billing AND shipping address on POs (DCs print only the supplier's own
 * address + the e-way bill — 06-Nov-2026), title in a centred band under the company, three signature panels,
 * nothing ever cut (columns size to their content, text wraps, rows grow, pages break), e-way bill QR only from a
 * verified payload. A4 portrait, built-in Helvetica (clean, Tally-like; amounts say "Rs." / the currency code).
 *
 * ───────────────────────────────────────────── API ─────────────────────────────────────────────
 *   import { renderDocPdf, type DocSpec } from '../../core/print/docPdf.js';
 *   import { loadPrintCompany, resolvePrintTemplate, companyAddressLines } from '../../core/print/printCompany.js';
 *   import { amountInWords, fmtMoney, fmtQty, fmtDate } from '../../core/print/printText.js';
 *
 *   const pdf: Buffer = await renderDocPdf({
 *     template: await resolvePrintTemplate(companyId, req.query.template),   // 'COLOUR' | 'BW'
 *     company: await loadPrintCompany(companyId),        // logo (uploads/…png|jpg), name, address[], GSTIN, phone, email
 *     title: 'DELIVERY CHALLAN', subtitle: 'Fabric Process',   // title band (subtitle optional)
 *     docNoLabel: 'DC No.', docNo: 'FDC-00012',          // printed in the details box, the footer and continuation pages
 *     party: { heading: 'Issued to', name: 'ABC Dyeing', lines: ['GSTIN: …', 'Ph: …'] },   // optional, left of details
 *     details: [['DC No.', 'FDC-00012'], ['DC Date', '05-Nov-2026'], ['Vehicle No.', 'TN 39 AB 1234']],
 *                                                         // key / value pairs; the FIRST one is printed large
 *     barcode: { value: 'FDC-00012', caption: 'Scan at gate' },    // optional Code 128 under the details
 *     banner: 'CANCELLED — wrong lot',                    // optional one-line notice under the title band
 *     addresses: [                                        // POs: billing | shipping / delivery (DCs: omit — 06-Nov)
 *       { heading: 'BILLING ADDRESS', name: company.name, lines: companyAddressLines(company) },
 *       { heading: 'SHIPPING / DELIVERY ADDRESS', name: party.name, lines: [...] },
 *     ],
 *     eway: { fields: [['E-Way Bill No.', '…'], …], qrPayload: verifiedPayloadOrNull },   // optional panel
 *     table: {
 *       columns: [
 *         { key: 'sn', label: 'S.No', align: 'center', wrap: false },
 *         { key: 'desc', label: 'Description', weight: 3 },          // wraps; gets most of the spare width
 *         { key: 'qty', label: 'Qty', align: 'right', wrap: false },  // numbers never wrap
 *       ],
 *       rows: [['1', { text: 'Main line', sub: ['detail line', 'another'] }, '12.000 KG']],
 *       total: { label: 'Total', values: { qty: '12.000 KG' } },     // optional bold total row
 *       emptyText: 'No items',
 *     },
 *     summary: {                                          // optional box under the table
 *       notes: [['Remarks', '…']], amountInWords: amountInWords(1234.5, { code: 'USD' }),
 *       rows: [['Taxable Value', '1,000.00'], ['IGST @ 5%', '50.00']], grand: ['Net Amount', 'USD 1,050.00'],
 *     },
 *     signatures: [{ label: 'Prepared By', name: 'Priya' }, { label: 'Checked By' }, { label: 'Received By' }],
 *     signFor: 'Coimbatore Knitwear Exports Pvt Ltd',     // optional "For <company>" in the LAST signature panel
 *     footerNote: 'Goods sent for processing only — not for sale',   // optional line above the signatures
 *     watermark: 'DRAFT' | 'CANCELLED' | null, reprint: 'Reprint 2' | null,
 *     printedBy: 'Admin', printedAt: '05-Nov-2026 10:24 AM',
 *     meta: { title: 'Fabric Process DC FDC-00012', subject: '…' },
 *   });
 *
 * Cells are a string or { text, sub?: string | string[], bold? } — `sub` lines print smaller under the text
 * (specs, colour, HSN …). '\n' in any text starts a new line. Column widths come from the content: a non-wrapping
 * column (numbers) is as wide as its widest value; wrapping columns share the rest by `weight` (default 1), never
 * narrower than their longest word (`minWidth` / `maxWidth` optional). Every cell is measured and the row grows to
 * the tallest; a row that does not fit goes to the next page, which repeats the company strip, title, doc no,
 * "Page x of y" and the table header. The last row, total row, summary and signatures stay together on the last
 * page (signatures sit at the bottom of it). Footer on every page: doc no · printed at / by · reprint · page x of y.
 * Nothing here knows about POs or DCs — the callers map their documents onto this spec.
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { pdfSafe as T } from './printText.js';

export type PrintTemplate = 'COLOUR' | 'BW';
export const PRINT_TEMPLATES: readonly PrintTemplate[] = ['COLOUR', 'BW'];

export interface PrintCompany {
  name: string;
  tradeName?: string | null;
  address: string[];
  gstin?: string | null;
  pan?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  /** absolute path of a PNG / JPEG (see printCompany.logoFile); null = no logo */
  logoFile?: string | null;
}
export type KV = [label: string, value: string];
export interface PartyBlock { heading: string; name?: string | null; lines: string[] }
export interface Column {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  /** wrap long text (default true); false = always one line, width = widest value (numbers, codes) */
  wrap?: boolean;
  /** share of the spare width among wrapping columns (default 1) */
  weight?: number;
  minWidth?: number;
  maxWidth?: number;
  /** main text bold in every row */
  bold?: boolean;
}
export type Cell = string | { text: string; sub?: string | string[] | null; bold?: boolean };
export interface TableSpec {
  columns: Column[];
  rows: Cell[][];
  total?: { label: string; values: Record<string, string> } | null;
  emptyText?: string;
}
export interface SummarySpec {
  notes?: KV[];
  amountInWords?: string | null;
  rows?: KV[];
  grand?: KV | null;
}
export interface EwaySpec { title?: string; fields: KV[]; qrPayload?: string | null; qrCaption?: string }
export interface SignatureSpec { label: string; name?: string | null; caption?: string }
export interface DocSpec {
  template: PrintTemplate;
  company: PrintCompany;
  title: string;
  subtitle?: string | null;
  docNoLabel: string;
  docNo: string;
  party?: PartyBlock | null;
  details: KV[];
  barcode?: { value: string; caption?: string } | null;
  banner?: string | null;
  /** billing | shipping blocks (POs). DCs leave it out — the party block carries the supplier's address. */
  addresses?: [PartyBlock, PartyBlock] | null;
  eway?: EwaySpec | null;
  table: TableSpec;
  summary?: SummarySpec | null;
  signatures: SignatureSpec[];
  signFor?: string | null;
  footerNote?: string | null;
  watermark?: string | null;
  reprint?: string | null;
  printedBy?: string | null;
  printedAt?: string | null;
  meta?: { title?: string; subject?: string };
}

/* ============================================================ theme tokens */
interface Theme {
  ink: string; muted: string; accent: string; soft: string; border: string; grid: string;
  headFill: string | null; headInk: string; alt: string | null; totalFill: string | null; gold: string | null;
  /** BW: sections are stacked bordered boxes (old-software style); COLOUR: separate rounded panels */
  boxed: boolean; radius: number; gap: number; watermarkInk: string;
}
const THEMES: Record<PrintTemplate, Theme> = {
  COLOUR: {
    ink: '#1F2937', muted: '#5B6573', accent: '#1F4E79', soft: '#EEF3F8', border: '#C7D2DE', grid: '#D3DBE5',
    headFill: '#E2EAF3', headInk: '#1B3A5C', alt: '#F8FAFC', totalFill: '#EEF3F8', gold: '#C9A15A',
    boxed: false, radius: 4, gap: 8, watermarkInk: '#8A99AD',
  },
  BW: {
    ink: '#000000', muted: '#333333', accent: '#000000', soft: '#FFFFFF', border: '#000000', grid: '#000000',
    headFill: null, headInk: '#000000', alt: null, totalFill: null, gold: null,
    boxed: true, radius: 0, gap: 0, watermarkInk: '#000000',
  },
};

/* ============================================================ geometry */
const A4_W = 595.28;
const A4_H = 841.89;
const M = 28;
const X0 = M;
const X1 = A4_W - M;
const W = X1 - X0;
const FOOTER_Y = A4_H - M - 6;          // footer text baseline area
const BOTTOM = FOOTER_Y - 10;           // content must end above this
const FS = 8.5;                          // body / table text
const FS_SUB = 7.6;                      // sub lines under a cell
const FS_HEAD = 8;                       // table header
const PX = 4;                            // cell padding x
const PY = 3.2;                          // cell padding y
const LG = 0.6;                          // line gap
const CONT_H = 30;                       // continuation strip height
const SIG_H = 66;

const B = 'Helvetica-Bold';
const R = 'Helvetica';
type Doc = PDFKit.PDFDocument;

interface Ctx { pdf: Doc; th: Theme; s: DocSpec; y: number }

/* ============================================================ small helpers */
const cellText = (c: Cell | undefined) => (c == null ? '' : typeof c === 'string' ? c : c.text ?? '');
const cellSub = (c: Cell | undefined): string[] => {
  if (!c || typeof c === 'string' || !c.sub) return [];
  return (Array.isArray(c.sub) ? c.sub : [c.sub]).map((x) => String(x ?? '')).filter((x) => x.trim() !== '');
};
const cellBold = (c: Cell | undefined, col: Column) => (c && typeof c !== 'string' && c.bold != null ? c.bold : !!col.bold);

function hText(pdf: Doc, text: string, w: number, font: string, size: number) {
  pdf.font(font).fontSize(size);
  return pdf.heightOfString(T(text) || ' ', { width: Math.max(1, w), lineGap: LG });
}
function maxLineWidth(pdf: Doc, text: string, font: string, size: number) {
  pdf.font(font).fontSize(size);
  return Math.max(0, ...T(text).split('\n').map((l) => pdf.widthOfString(l)));
}
function maxWordWidth(pdf: Doc, text: string, font: string, size: number) {
  pdf.font(font).fontSize(size);
  return Math.max(0, ...T(text).split(/\s+/).filter(Boolean).map((w) => pdf.widthOfString(w)));
}
function box(c: Ctx, x: number, y: number, w: number, h: number, fill?: string | null) {
  const { pdf, th } = c;
  pdf.save().lineWidth(th.boxed ? 0.7 : 0.8).strokeColor(th.border);
  if (th.radius) pdf.roundedRect(x, y, w, h, th.radius); else pdf.rect(x, y, w, h);
  if (fill) pdf.fillAndStroke(fill, th.border); else pdf.stroke();
  pdf.restore();
}
function vline(c: Ctx, x: number, y0: number, y1: number, color?: string) {
  c.pdf.save().moveTo(x, y0).lineTo(x, y1).lineWidth(c.th.boxed ? 0.7 : 0.7).strokeColor(color ?? c.th.border).stroke().restore();
}
function hline(c: Ctx, x0: number, x1: number, y: number, color?: string, w = 0.7) {
  c.pdf.save().moveTo(x0, y).lineTo(x1, y).lineWidth(w).strokeColor(color ?? c.th.border).stroke().restore();
}
/** Small upper-case section heading. */
function heading(c: Ctx, text: string, x: number, y: number, w: number) {
  c.pdf.font(B).fontSize(7.4).fillColor(c.th.boxed ? c.th.ink : c.th.accent).text(T(text.toUpperCase()), x, y, { width: w, characterSpacing: 0.3, lineGap: LG });
  return c.pdf.y;
}

/* ============================================================ header */
function companyContact(co: PrintCompany) {
  return [co.gstin ? `GSTIN: ${co.gstin}` : null, co.pan ? `PAN: ${co.pan}` : null, co.phone ? `Ph: ${co.phone}` : null, co.email ? co.email : null]
    .filter(Boolean) as string[];
}

function drawLogo(c: Ctx, x: number, y: number, size: number): boolean {
  if (!c.s.company.logoFile) return false;
  try { c.pdf.image(c.s.company.logoFile, x, y, { fit: [size, size], align: 'center', valign: 'center' }); return true; } catch { return false; }
}

/**
 * Colour header (client 06-Nov-2026): logo on the left, our company name / address / contact centred, and the
 * document title moved off the top-right corner into a centred band under the rule ("PURCHASE ORDER · Yarn").
 */
function headerColour(c: Ctx) {
  const { pdf, th, s } = c;
  const co = s.company;
  const y0 = M;
  const LOGO = 52;
  const hasLogo = drawLogo(c, X0, y0, LOGO);
  const inset = hasLogo ? LOGO + 12 : 0;   // symmetric, so the text stays centred on the page
  const tx = X0 + inset;
  const tw = W - 2 * inset;
  pdf.font(B).fontSize(15).fillColor(th.accent).text(T(co.name), tx, y0, { width: tw, align: 'center', lineGap: LG });
  if (co.tradeName) pdf.font(R).fontSize(8).fillColor(th.muted).text(T(`(${co.tradeName})`), tx, pdf.y, { width: tw, align: 'center' });
  pdf.font(R).fontSize(8.4).fillColor(th.ink).text(T(co.address.join(', ')), tx, pdf.y + 2, { width: tw, align: 'center', lineGap: LG });
  // contact items packed into lines without splitting an item ("GSTIN … | PAN … | Ph …" / "e-mail")
  pdf.font(R).fontSize(8.2).fillColor(th.muted);
  const packed: string[] = [];
  for (const it of companyContact(co)) {
    const cur = packed.length ? `${packed[packed.length - 1]}   |   ${it}` : it;
    if (packed.length && pdf.widthOfString(T(cur)) <= tw) packed[packed.length - 1] = cur; else packed.push(it);
  }
  if (packed.length) pdf.text(T(packed.join('\n')), tx, pdf.y + 1, { width: tw, align: 'center', lineGap: LG });
  let y = Math.max(pdf.y, hasLogo ? y0 + LOGO : 0) + 6;
  hline(c, X0, X1, y, th.accent, 1.1);
  if (th.gold) hline(c, A4_W / 2 - 40, A4_W / 2 + 40, y + 2, th.gold, 1);
  y += 7;
  // title band
  const BAND = 20;
  pdf.save().roundedRect(X0, y, W, BAND, th.radius).fill(th.soft).restore();
  pdf.font(B).fontSize(11.5);
  const tW = pdf.widthOfString(T(s.title), { characterSpacing: 0.8 });
  const sub = s.subtitle ? `   ·   ${s.subtitle}` : '';
  pdf.font(R).fontSize(9.4);
  const sW = sub ? pdf.widthOfString(T(sub)) : 0;
  const x = X0 + Math.max(0, (W - tW - sW) / 2);
  pdf.font(B).fontSize(11.5).fillColor(th.accent).text(T(s.title), x, y + 5, { lineBreak: false, characterSpacing: 0.8 });
  if (sub) pdf.font(R).fontSize(9.4).fillColor(th.muted).text(T(sub), x + tW, y + 6.4, { lineBreak: false });
  c.y = y + BAND + th.gap;
}

function headerBw(c: Ctx) {
  const { pdf, th, s } = c;
  const co = s.company;
  let y = M + 6;
  const LOGO = 46;
  const hasLogo = drawLogo(c, X0 + 6, y, LOGO);
  const inset = hasLogo ? LOGO + 14 : 10;
  pdf.font(B).fontSize(15).fillColor(th.ink).text(T(co.name), X0 + inset, y, { width: W - 2 * inset, align: 'center', lineGap: LG });
  if (co.tradeName) pdf.font(R).fontSize(8).text(T(`(${co.tradeName})`), X0 + inset, pdf.y, { width: W - 2 * inset, align: 'center' });
  pdf.font(R).fontSize(8.6).text(T(co.address.join(', ')), X0 + inset, pdf.y + 2, { width: W - 2 * inset, align: 'center', lineGap: LG });
  y = Math.max(pdf.y + 4, hasLogo ? y + LOGO + 2 : 0);
  const left = co.gstin ? `GSTIN: ${co.gstin}` : '';
  const right = [co.phone ? `Phone: ${co.phone}` : null, co.email].filter(Boolean).join('   ');
  pdf.font(B).fontSize(8.4).text(T(left), X0 + 6, y, { width: W / 2 - 6 });
  const lb = pdf.y;
  pdf.font(B).fontSize(8.4).text(T(right), X0 + W / 2, y, { width: W / 2 - 6, align: 'right' });
  y = Math.max(lb, pdf.y) + 3;
  // title strip under the company (client 06-Nov-2026: not in the top corner)
  hline(c, X0, X1, y);
  const title = s.subtitle ? `${s.title} — ${s.subtitle}` : s.title;
  pdf.font(B).fontSize(10).fillColor(th.ink).text(T(title.toUpperCase()), X0, y + 4, { width: W, align: 'center', characterSpacing: 0.5 });
  c.y = pdf.y + 3;
}

/** Page 2+: company, title, doc no and page x/y (page numbers are written once the count is known). */
function continuationStrip(c: Ctx, page: number, total: number) {
  const { pdf, th, s } = c;
  const y = M;
  pdf.font(B).fontSize(10).fillColor(th.accent).text(T(s.company.name), X0 + (th.boxed ? 6 : 0), y + 4, { width: W * 0.5, lineBreak: false, ellipsis: true });
  pdf.font(B).fontSize(9).fillColor(th.ink).text(T(`${s.title}${s.subtitle ? ` — ${s.subtitle}` : ''} (continued)`), X0 + W * 0.45, y + 2, { width: W * 0.55 - (th.boxed ? 6 : 0), align: 'right', lineBreak: false });
  pdf.font(R).fontSize(8.4).fillColor(th.muted).text(T(`${s.docNoLabel} ${s.docNo}   ·   Page ${page} of ${total}`), X0 + W * 0.3, y + 14, { width: W * 0.7 - (th.boxed ? 6 : 0), align: 'right', lineBreak: false });
  hline(c, X0, X1, y + CONT_H - 4, th.boxed ? th.border : th.accent, th.boxed ? 0.7 : 1);
}

/* ============================================================ title band (colour) / details box */
function titleBand(c: Ctx) {
  const { pdf, th, s } = c;
  if (!s.banner) return;
  const h = hText(pdf, s.banner, W - 16, B, 9) + 8;
  if (th.boxed) { box(c, X0, c.y, W, h); } else {
    pdf.save().roundedRect(X0, c.y, W, h, th.radius).fill('#FDF2F2').restore();
  }
  pdf.font(B).fontSize(9).fillColor(th.boxed ? th.ink : '#9B1C1C').text(T(s.banner), X0 + 8, c.y + 4, { width: W - 16, lineGap: LG });
  c.y += h + th.gap;
}

// Code 128 (set B) — same symbology as the app's printed DCs (web/src/lib/barcode.ts)
const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const BAR_H = 22;
const barcodeOk = (v: string) => /^[\x20-\x7e]{1,40}$/.test(v);
function drawBarcode(c: Ctx, value: string, caption: string | undefined, x: number, y: number, maxW: number) {
  const { pdf, th } = c;
  const codes = [104];
  for (const ch of value) codes.push(ch.charCodeAt(0) - 32);
  let sum = 104;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103, 106);
  const mods = codes.flatMap((k) => C128[k].split('').map(Number));
  const total = mods.reduce((a, b) => a + b, 0);
  const m = Math.min(1, (maxW - 70) / total);
  let bx = x;
  pdf.save().fillColor('#000000');
  mods.forEach((w, i) => { if (i % 2 === 0) pdf.rect(bx, y, w * m, BAR_H).fill(); bx += w * m; });
  pdf.restore();
  pdf.font(B).fontSize(8).fillColor(th.ink).text(T(value), bx + 6, y + 3, { lineBreak: false });
  if (caption) pdf.font(R).fontSize(7.4).fillColor(th.muted).text(T(caption), bx + 6, y + 13, { lineBreak: false });
}

/** Key / value list in a column; returns the bottom y. First pair large when `lead`. */
function kvList(c: Ctx, pairs: KV[], x: number, y: number, w: number, lead: boolean, measureOnly = false) {
  const { pdf, th } = c;
  pdf.font(R).fontSize(8.2);
  const lw = Math.min(w * 0.42, Math.max(40, ...pairs.map(([k]) => pdf.widthOfString(T(k)))) + 4);
  const vx = x + lw + 8;
  const vw = w - lw - 8;
  let yy = y;
  pairs.forEach(([k, v], i) => {
    const big = lead && i === 0;
    const vf = big ? 11 : 8.6;
    const hk = hText(pdf, k, lw, R, 8.2);
    const hv = hText(pdf, v || '-', vw, B, vf);
    if (!measureOnly) {
      pdf.font(R).fontSize(8.2).fillColor(th.muted).text(T(k), x, yy + (big ? 2 : 0.5), { width: lw, lineGap: LG });
      pdf.font(R).fontSize(8.2).fillColor(th.muted).text(':', x + lw + 1, yy + (big ? 2 : 0.5), { lineBreak: false });
      pdf.font(B).fontSize(vf).fillColor(th.ink).text(T(v || '-'), vx, yy, { width: vw, lineGap: LG });
    }
    yy += Math.max(hk, hv) + (big ? 4 : 2.6);
  });
  return yy;
}

function partyLines(c: Ctx, p: PartyBlock, x: number, y: number, w: number, measureOnly = false) {
  const { pdf, th } = c;
  let yy = y;
  const hh = hText(pdf, p.heading.toUpperCase(), w, B, 7.4);
  if (!measureOnly) heading(c, p.heading, x, yy, w);
  yy += hh + 2;
  if (p.name) {
    const h = hText(pdf, p.name, w, B, 9.6);
    if (!measureOnly) pdf.font(B).fontSize(9.6).fillColor(th.ink).text(T(p.name), x, yy, { width: w, lineGap: LG });
    yy += h + 1;
  }
  const body = p.lines.filter((l) => String(l ?? '').trim() !== '').join('\n');
  if (body) {
    const h = hText(pdf, body, w, R, 8.4);
    if (!measureOnly) pdf.font(R).fontSize(8.4).fillColor(th.ink).text(T(body), x, yy, { width: w, lineGap: LG });
    yy += h;
  }
  return yy;
}

function detailsBox(c: Ctx) {
  const { th, s } = c;
  const pad = 8;
  const top = c.y;
  const hasParty = !!s.party;
  const split = hasParty ? X0 + W * 0.54 : X0 + W / 2;
  const bc = s.barcode && barcodeOk(s.barcode.value) ? s.barcode : null;
  let leftBottom: number; let rightBottom: number;
  const measure = (only: boolean) => {
    if (hasParty) {
      leftBottom = partyLines(c, s.party!, X0 + pad, top + pad, split - X0 - 2 * pad, only);
      rightBottom = kvList(c, s.details, split + pad, top + pad, X1 - split - 2 * pad, true, only);
    } else {
      const half = Math.ceil(s.details.length / 2);
      leftBottom = kvList(c, s.details.slice(0, half), X0 + pad, top + pad, split - X0 - 2 * pad, true, only);
      rightBottom = kvList(c, s.details.slice(half), split + pad, top + pad, X1 - split - 2 * pad, false, only);
    }
    if (bc) rightBottom += 4 + BAR_H;
  };
  measure(true);
  const h = Math.max(leftBottom!, rightBottom!) - top + pad - 2;
  box(c, X0, top, W, h);
  vline(c, split, top + (th.boxed ? 0 : 6), top + h - (th.boxed ? 0 : 6));
  measure(false);
  if (bc) drawBarcode(c, bc.value, bc.caption, split + pad, top + h - pad + 2 - BAR_H - 2, X1 - split - 2 * pad);
  c.y = top + h + th.gap;
}

function addressBox(c: Ctx) {
  const { th, s } = c;
  const pad = 8;
  const top = c.y;
  const half = W / 2;
  const [a, b] = s.addresses!;
  const hb = Math.max(partyLines(c, a, X0 + pad, top + pad, half - 2 * pad, true), partyLines(c, b, X0 + half + pad, top + pad, half - 2 * pad, true));
  const h = hb - top + pad - 2;
  box(c, X0, top, W, h, th.boxed ? null : null);
  vline(c, X0 + half, top + (th.boxed ? 0 : 6), top + h - (th.boxed ? 0 : 6));
  partyLines(c, a, X0 + pad, top + pad, half - 2 * pad);
  partyLines(c, b, X0 + half + pad, top + pad, half - 2 * pad);
  c.y = top + h + th.gap;
}

async function ewayBox(c: Ctx) {
  const { pdf, th, s } = c;
  const e = s.eway!;
  const pad = 8;
  const top = c.y;
  const qr = e.qrPayload ? await QRCode.toBuffer(e.qrPayload, { errorCorrectionLevel: 'M', margin: 0, width: 220 }) : null;
  const QR = 62;
  const qrZone = qr ? QR + 2 * pad : 0;
  const headH = 15;
  const innerW = W - qrZone;
  const half = Math.ceil(e.fields.length / 2);
  const colW = innerW / 2 - 2 * pad;
  const bodyTop = top + headH + 5;
  const lb = kvList(c, e.fields.slice(0, half), X0 + pad, bodyTop, colW, false, true);
  const rb = kvList(c, e.fields.slice(half), X0 + innerW / 2 + pad, bodyTop, colW, false, true);
  const h = Math.max(lb, rb, qr ? bodyTop + QR + 12 : 0) - top + 4;
  box(c, X0, top, W, h);
  if (th.boxed) hline(c, X0, X1, top + headH);
  else pdf.save().rect(X0 + 0.5, top + 0.5, W - 1, headH).fill(th.soft).restore();
  heading(c, e.title ?? 'E-Way Bill', X0 + pad, top + 4.5, W - 2 * pad);
  kvList(c, e.fields.slice(0, half), X0 + pad, bodyTop, colW, false);
  kvList(c, e.fields.slice(half), X0 + innerW / 2 + pad, bodyTop, colW, false);
  vline(c, X0 + innerW / 2, top + headH + (th.boxed ? 0 : 4), top + h - (th.boxed ? 0 : 4), th.boxed ? th.border : th.grid);
  if (qr) {
    const qx = X1 - pad - QR;
    vline(c, qx - pad, top + headH + (th.boxed ? 0 : 4), top + h - (th.boxed ? 0 : 4), th.boxed ? th.border : th.grid);
    pdf.image(qr, qx, bodyTop, { width: QR, height: QR });
    pdf.font(R).fontSize(7).fillColor(th.muted).text(T(e.qrCaption ?? 'E-Way Bill QR'), qx - 6, bodyTop + QR + 2, { width: QR + 12, align: 'center', lineBreak: false });
  }
  c.y = top + h + th.gap;
}

/* ============================================================ table */
/** Column widths from the content (see the header comment). */
export function layoutColumns(pdf: Doc, cols: Column[], rows: Cell[][], total?: TableSpec['total']): number[] {
  const n = cols.length;
  const nat: number[] = []; const min: number[] = [];
  cols.forEach((col, i) => {
    const wrap = col.wrap !== false;
    const headWord = maxWordWidth(pdf, col.label, B, FS_HEAD);
    const headLine = maxLineWidth(pdf, col.label, B, FS_HEAD);
    let contentNat = 0; let contentWord = 0;
    const cells = rows.map((r) => r[i]);
    for (const cell of cells) {
      const bold = cellBold(cell, col);
      const t = cellText(cell);
      contentNat = Math.max(contentNat, maxLineWidth(pdf, t, bold ? B : R, FS));
      if (wrap) contentWord = Math.max(contentWord, maxWordWidth(pdf, t, bold ? B : R, FS));
      for (const sub of cellSub(cell)) {
        contentNat = Math.max(contentNat, maxLineWidth(pdf, sub, R, FS_SUB));
        if (wrap) contentWord = Math.max(contentWord, maxWordWidth(pdf, sub, R, FS_SUB));
      }
    }
    const tv = total?.values?.[col.key];
    if (tv) { contentNat = Math.max(contentNat, maxLineWidth(pdf, tv, B, FS)); contentWord = Math.max(contentWord, maxWordWidth(pdf, tv, B, FS)); }
    const pad = 2 * PX + 1;
    if (wrap) {
      nat[i] = Math.max(contentNat, headLine) + pad;
      min[i] = Math.max(contentWord, headWord, (col.minWidth ?? 0) - pad, 18) + pad;
    } else {
      // short headers ("GST %", "Weight (KG)") stay on one line; long ones wrap at words
      nat[i] = Math.max(contentNat, headLine <= 56 ? headLine : headWord, (col.minWidth ?? 0) - pad) + pad;
      min[i] = nat[i];
    }
    if (col.maxWidth && wrap) { nat[i] = Math.min(nat[i], Math.max(col.maxWidth, min[i])); }
  });
  const wrapIdx = cols.map((c, i) => (c.wrap !== false ? i : -1)).filter((i) => i >= 0);
  const weight = (i: number) => (cols[i].wrap === false ? 0 : cols[i].weight ?? 1);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  let w: number[];
  if (sum(nat) <= W) {
    w = [...nat];
    let spare = W - sum(w);
    const takers = wrapIdx.filter((i) => weight(i) > 0 && !(cols[i].maxWidth && w[i] >= cols[i].maxWidth!));
    const tw = sum(takers.map(weight));
    if (takers.length && tw > 0) { for (const i of takers) w[i] += (spare * weight(i)) / tw; spare = 0; }
    if (spare > 0.5) { const t = sum(w); w = w.map((x) => x + (spare * x) / t); }
  } else {
    w = [...min];
    let rem = W - sum(w);
    if (rem >= 0) {
      // water-filling: the spare width is shared by weight; a column whose whole text fits in its share gets exactly
      // its natural width (short colour / size / IO columns stop wrapping) and the rest goes round again
      let open = wrapIdx.filter((i) => nat[i] > w[i] + 0.5);
      while (open.length && rem > 0.5) {
        const tw = sum(open.map((i) => Math.max(0.2, weight(i))));
        const done = open.filter((i) => nat[i] - w[i] <= (rem * Math.max(0.2, weight(i))) / tw);
        if (!done.length) { open.forEach((i) => { w[i] += (rem * Math.max(0.2, weight(i))) / tw; }); rem = 0; break; }
        for (const i of done) { rem -= nat[i] - w[i]; w[i] = nat[i]; }
        open = open.filter((i) => !done.includes(i));
      }
      rem = W - sum(w);
      if (rem > 0.5) { const tw = sum(wrapIdx.map(weight)) || 1; wrapIdx.forEach((i) => { w[i] += (rem * (weight(i) || 0)) / tw; }); }
      rem = W - sum(w);
      if (Math.abs(rem) > 0.5) { const t = sum(w); w = w.map((x) => x + (rem * x) / t); }
    } else {
      // pathological (very long words): scale every wrap column down; pdfkit breaks long words inside a cell
      const fixed = sum(cols.map((c, i) => (c.wrap === false ? w[i] : 0)));
      const flex = sum(wrapIdx.map((i) => w[i]));
      const avail = Math.max(W - fixed, wrapIdx.length * 24);
      wrapIdx.forEach((i) => { w[i] = (w[i] * avail) / flex; });
      const t = sum(w);
      if (t > W) w = w.map((x) => (x * W) / t);
    }
  }
  return w.slice(0, n);
}

function cellHeight(pdf: Doc, cell: Cell | undefined, col: Column, w: number) {
  const iw = w - 2 * PX;
  let h = hText(pdf, cellText(cell), iw, cellBold(cell, col) ? B : R, FS);
  const sub = cellSub(cell);
  if (sub.length) h += 1 + hText(pdf, sub.join('\n'), iw, R, FS_SUB);
  return h;
}

function headerHeight(pdf: Doc, cols: Column[], cw: number[]) {
  return Math.max(...cols.map((c, i) => hText(pdf, c.label, cw[i] - 2 * PX, B, FS_HEAD))) + 2 * PY + 2;
}

function drawTableHeader(c: Ctx, cols: Column[], cw: number[]) {
  const { pdf, th } = c;
  const hh = headerHeight(pdf, cols, cw);
  const y = c.y;
  if (th.headFill) pdf.save().rect(X0, y, W, hh).fill(th.headFill).restore();
  let x = X0;
  cols.forEach((col, i) => {
    const t = hText(pdf, col.label, cw[i] - 2 * PX, B, FS_HEAD);
    pdf.font(B).fontSize(FS_HEAD).fillColor(th.headInk)
      .text(T(col.label), x + PX, y + (hh - t) / 2 + 0.5, { width: cw[i] - 2 * PX, align: col.align === 'right' ? 'right' : col.align === 'center' ? 'center' : 'left', lineGap: LG });
    x += cw[i];
  });
  gridLines(c, cw, y, hh, true);
  if (!th.boxed) hline(c, X0, X1, y + hh, th.accent, 0.9);
  c.y = y + hh;
}

function gridLines(c: Ctx, cw: number[], y: number, h: number, isHead = false) {
  const { pdf, th } = c;
  const color = th.boxed ? th.border : isHead ? th.border : th.grid;
  pdf.save().lineWidth(th.boxed ? 0.6 : 0.5).strokeColor(color);
  let x = X0;
  for (let i = 0; i < cw.length - 1; i++) { x += cw[i]; pdf.moveTo(x, y).lineTo(x, y + h); }
  pdf.moveTo(X0, y).lineTo(X0, y + h).moveTo(X1, y).lineTo(X1, y + h);
  pdf.moveTo(X0, y + h).lineTo(X1, y + h);
  if (isHead) pdf.moveTo(X0, y).lineTo(X1, y);
  pdf.stroke().restore();
}

function drawRow(c: Ctx, cols: Column[], cw: number[], row: Cell[], h: number, alt: boolean) {
  const { pdf, th } = c;
  const y = c.y;
  if (alt && th.alt) pdf.save().rect(X0, y, W, h).fill(th.alt).restore();
  let x = X0;
  cols.forEach((col, i) => {
    const cell = row[i];
    const iw = cw[i] - 2 * PX;
    const align = col.align ?? 'left';
    const bold = cellBold(cell, col);
    pdf.font(bold ? B : R).fontSize(FS).fillColor(th.ink).text(T(cellText(cell)), x + PX, y + PY, { width: iw, align, lineGap: LG });
    const sub = cellSub(cell);
    if (sub.length) pdf.font(R).fontSize(FS_SUB).fillColor(th.muted).text(T(sub.join('\n')), x + PX, pdf.y + 1, { width: iw, align, lineGap: LG });
    x += cw[i];
  });
  gridLines(c, cw, y, h);
  c.y = y + h;
}

function totalRowHeight(c: Ctx, t: NonNullable<TableSpec['total']>, cols: Column[], cw: number[]) {
  const fi = cols.findIndex((col) => t.values[col.key] != null);
  const labelW = cw.slice(0, fi < 0 ? cols.length : Math.max(1, fi)).reduce((a, b) => a + b, 0);   // no values: the label spans the row
  let h = hText(c.pdf, t.label, labelW - 2 * PX, B, 9);
  cols.forEach((col, i) => { const v = t.values[col.key]; if (v != null) h = Math.max(h, hText(c.pdf, v, cw[i] - 2 * PX, B, FS)); });
  return h + 2 * PY + 3;
}

function drawTotalRow(c: Ctx, t: NonNullable<TableSpec['total']>, cols: Column[], cw: number[]) {
  const { pdf, th } = c;
  const h = totalRowHeight(c, t, cols, cw);
  const y = c.y;
  const fi = cols.findIndex((col) => t.values[col.key] != null);
  const first = fi < 0 ? cols.length : Math.max(1, fi);   // no values: the label spans the row
  const labelW = cw.slice(0, first).reduce((a, b) => a + b, 0);
  if (th.totalFill) pdf.save().rect(X0, y, W, h).fill(th.totalFill).restore();
  pdf.font(B).fontSize(9).fillColor(th.ink).text(T(t.label), X0 + PX, y + PY + 1, { width: labelW - 2 * PX, align: 'right' });
  let x = X0 + labelW;
  for (let i = first; i < cols.length; i++) {
    const v = t.values[cols[i].key];
    if (v != null) pdf.font(B).fontSize(FS).fillColor(th.ink).text(T(v), x + PX, y + PY + 1.5, { width: cw[i] - 2 * PX, align: cols[i].align ?? 'right', lineGap: LG });
    x += cw[i];
  }
  // borders: outer + the value columns' rules (label cell spans the columns before the first value)
  pdf.save().lineWidth(th.boxed ? 0.6 : 0.5).strokeColor(th.boxed ? th.border : th.grid);
  pdf.moveTo(X0, y).lineTo(X0, y + h).moveTo(X1, y).lineTo(X1, y + h).moveTo(X0, y + h).lineTo(X1, y + h);
  x = X0 + labelW;
  for (let i = first; i < cols.length; i++) { pdf.moveTo(x, y).lineTo(x, y + h); x += cw[i]; }
  pdf.stroke().restore();
  if (!th.boxed) hline(c, X0, X1, y, th.accent, 0.8);
  c.y = y + h;
}

/* ============================================================ summary / signatures */
function summaryLayout(c: Ctx) {
  const { pdf } = c;
  const sm = c.s.summary;
  if (!sm) return null;
  const hasRight = !!(sm.rows?.length || sm.grand);
  const pad = 8;
  const rightW = hasRight ? 230 : 0;
  const leftW = W - rightW - 2 * pad;
  let lh = 0;
  if (sm.notes?.length) lh += kvList(c, sm.notes, 0, 0, leftW, false, true);
  if (sm.amountInWords) lh += (lh ? 6 : 0) + hText(pdf, 'AMOUNT IN WORDS', leftW, B, 7.4) + 2 + hText(pdf, sm.amountInWords, leftW, B, 8.8);
  const rowH = (k: string, v: string, big: boolean) => Math.max(hText(pdf, k, rightW * 0.58 - pad, big ? B : R, big ? 9.6 : 8.6), hText(pdf, v, rightW * 0.42 - pad, B, big ? 10.5 : 8.6)) + (big ? 9 : 3.4);
  let rh = 0;
  for (const [k, v] of sm.rows ?? []) rh += rowH(k, v, false);
  const grandH = sm.grand ? rowH(sm.grand[0], sm.grand[1], true) : 0;
  const h = Math.max(lh + 2 * pad - 2, rh + grandH + pad + 4, 20);
  return { h, rightW, leftW, pad, rowH, grandH };
}

function drawSummary(c: Ctx) {
  const L = summaryLayout(c);
  if (!L) return;
  const { pdf, th } = c;
  const sm = c.s.summary!;
  const top = c.y;
  box(c, X0, top, W, L.h);
  let ly = top + L.pad;
  const lx = X0 + L.pad;
  if (sm.notes?.length) ly = kvList(c, sm.notes, lx, ly, L.leftW, false);
  if (sm.amountInWords) {
    if (sm.notes?.length) ly += 6;
    ly = heading(c, 'Amount in words', lx, ly, L.leftW) + 2;
    pdf.font(B).fontSize(8.8).fillColor(th.ink).text(T(sm.amountInWords), lx, ly, { width: L.leftW, lineGap: LG });
  }
  if (L.rightW) {
    const rx = X1 - L.rightW;
    vline(c, rx, top + (th.boxed ? 0 : 0), top + L.h);
    let ry = top + 5;
    for (const [k, v] of sm.rows ?? []) {
      pdf.font(R).fontSize(8.6).fillColor(th.muted).text(T(k), rx + L.pad, ry, { width: L.rightW * 0.58 - L.pad, lineGap: LG });
      pdf.font(B).fontSize(8.6).fillColor(th.ink).text(T(v), rx + L.rightW * 0.58, ry, { width: L.rightW * 0.42 - L.pad, align: 'right', lineGap: LG });
      ry += L.rowH(k, v, false);
    }
    if (sm.grand) {
      const gy = top + L.h - L.grandH;
      if (th.boxed) hline(c, rx, X1, gy);
      else {
        pdf.save().rect(rx + 0.5, gy, L.rightW - 1, L.grandH - 0.5).fill(th.soft).restore();
        hline(c, rx, X1, gy, th.accent, 0.9);
      }
      pdf.font(B).fontSize(9.6).fillColor(th.ink).text(T(sm.grand[0]), rx + L.pad, gy + 5.5, { width: L.rightW * 0.5 - L.pad, lineGap: LG });
      pdf.font(B).fontSize(10.5).fillColor(th.boxed ? th.ink : th.accent).text(T(sm.grand[1]), rx + L.rightW * 0.42, gy + 5, { width: L.rightW * 0.58 - L.pad, align: 'right', lineGap: LG });
    }
  }
  c.y = top + L.h + (th.boxed ? 0 : th.gap);
}

function footerNoteHeight(c: Ctx) {
  return c.s.footerNote ? hText(c.pdf, c.s.footerNote, W - 16, R, 7.8) + 6 : 0;
}

function drawSignatures(c: Ctx, y: number) {
  const { pdf, th, s } = c;
  const n = Math.max(1, s.signatures.length);
  const gap = th.boxed ? 0 : 10;
  const w = (W - gap * (n - 1)) / n;
  if (th.boxed) box(c, X0, y, W, SIG_H);
  s.signatures.forEach((sig, i) => {
    const x = X0 + i * (w + gap);
    if (th.boxed) { if (i > 0) vline(c, x, y, y + SIG_H); } else {
      box(c, x, y, w, SIG_H);
      pdf.save().rect(x + 0.5, y + 0.5, w - 1, 17).fill(th.soft).restore();
    }
    pdf.font(B).fontSize(8.6).fillColor(th.boxed ? th.ink : th.accent).text(T(sig.label), x + 8, y + 5, { width: w - 16, lineBreak: false, ellipsis: true });
    if (th.boxed) hline(c, x, x + w, y + 17);
    if (i === n - 1 && s.signFor) pdf.font(R).fontSize(7.6).fillColor(th.muted).text(T(`For ${s.signFor}`), x + 8, y + 21, { width: w - 16, lineGap: LG });
    if (sig.name) pdf.font(R).fontSize(8.2).fillColor(th.ink).text(T(sig.name), x + 8, y + SIG_H - 29, { width: w - 16, align: 'center', lineBreak: false, ellipsis: true });
    hline(c, x + 12, x + w - 12, y + SIG_H - 18, th.ink, 0.6);
    pdf.font(R).fontSize(7.4).fillColor(th.muted).text(T(sig.caption ?? 'Signature & Date'), x, y + SIG_H - 13, { width: w, align: 'center', lineBreak: false });
  });
}

/* ============================================================ page furniture */
function footer(c: Ctx, page: number, total: number) {
  const { pdf, th, s } = c;
  const y = FOOTER_Y - 4;
  hline(c, X0, X1, y - 3, th.boxed ? th.border : th.grid, 0.5);
  const mid = [s.printedAt ? `Printed ${s.printedAt}${s.printedBy ? ` by ${s.printedBy}` : ''}` : null, s.reprint].filter(Boolean).join('   ·   ');
  pdf.font(R).fontSize(7.2).fillColor(th.muted);
  pdf.text(T(`${s.docNoLabel} ${s.docNo}`), X0, y, { width: W * 0.3, lineBreak: false });
  if (mid) pdf.text(T(mid), X0 + W * 0.2, y, { width: W * 0.6, align: 'center', lineBreak: false });
  pdf.font(B).fontSize(7.2).fillColor(th.ink).text(`Page ${page} of ${total}`, X0 + W * 0.7, y, { width: W * 0.3, align: 'right', lineBreak: false });
}

function watermark(c: Ctx, text: string) {
  const { pdf, th } = c;
  pdf.save();
  pdf.rotate(-35, { origin: [A4_W / 2, A4_H / 2] });
  pdf.font(B).fontSize(96).fillColor(th.watermarkInk).opacity(th.boxed ? 0.1 : 0.14)
    .text(T(text), 0, A4_H / 2 - 50, { width: A4_W, align: 'center', lineBreak: false });
  pdf.restore();
  pdf.opacity(1);
}

/* ============================================================ render */
export async function renderDocPdf(s: DocSpec): Promise<Buffer> {
  const th = THEMES[s.template] ?? THEMES.COLOUR;
  const pdf = new PDFDocument({
    size: 'A4', layout: 'portrait', margin: 0, bufferPages: true,
    info: { Title: T(s.meta?.title ?? `${s.title} ${s.docNo}`), Author: T(s.company.name), Subject: T(s.meta?.subject ?? s.title), Creator: T(s.company.name), Producer: T(s.company.name),
      Keywords: `print-template:${s.template}` },
  });
  const chunks: Buffer[] = [];
  pdf.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<Buffer>((resolve, reject) => { pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });

  const c: Ctx = { pdf, th, s, y: M };
  try {
    // ---------------- first page blocks
    if (th.boxed) headerBw(c); else headerColour(c);
    titleBand(c);
    detailsBox(c);
    if (s.addresses) addressBox(c);
    if (s.eway) await ewayBox(c);

    // ---------------- table
    const { columns: cols, rows } = s.table;
    const cw = layoutColumns(pdf, cols, rows, s.table.total);
    const heights = rows.map((r) => Math.max(...cols.map((col, i) => cellHeight(pdf, r[i], col, cw[i]))) + 2 * PY + 1);
    const totalH = s.table.total ? totalRowHeight(c, s.table.total, cols, cw) : 0;
    const sumL = summaryLayout(c);
    const tail = totalH + (sumL ? (th.boxed ? 0 : th.gap) + sumL.h : 0) + footerNoteHeight(c) + 12 + SIG_H;
    const newPage = () => {
      pdf.addPage({ size: 'A4', layout: 'portrait', margin: 0 });
      c.y = M + CONT_H + 2;
      drawTableHeader(c, cols, cw);
    };
    drawTableHeader(c, cols, cw);
    let rowsOnPage = 0;
    rows.forEach((r, i) => {
      const last = i === rows.length - 1;
      const need = heights[i] + (last ? tail : 0);
      if (c.y + need > BOTTOM && (rowsOnPage > 0 || c.y + heights[i] > BOTTOM)) { newPage(); rowsOnPage = 0; }
      drawRow(c, cols, cw, r, heights[i], i % 2 === 1);
      rowsOnPage += 1;
    });
    if (!rows.length) {
      const eh = 22;
      if (c.y + eh + tail > BOTTOM) newPage();
      pdf.font(R).fontSize(FS).fillColor(th.muted).text(T(s.table.emptyText ?? 'No items'), X0, c.y + 7, { width: W, align: 'center' });
      gridLines(c, [W], c.y, eh);
      c.y += eh;
    }
    if (c.y + tail > BOTTOM) newPage();   // (only when the table was empty and something odd happened)
    if (s.table.total) drawTotalRow(c, s.table.total, cols, cw);
    if (sumL) { c.y += th.boxed ? 0 : th.gap; drawSummary(c); }
    if (s.footerNote) {
      pdf.font(R).fontSize(7.8).fillColor(th.muted).text(T(s.footerNote), X0 + 8, c.y + 3, { width: W - 16, lineGap: LG });
      c.y = pdf.y + 3;
    }
    drawSignatures(c, Math.max(c.y + 12, BOTTOM - SIG_H));

    // ---------------- every page: continuation strip, footer, watermark (page count known now)
    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(range.start + i);
      if (th.boxed) pdf.save().rect(X0, M, W, BOTTOM - M).lineWidth(0.9).strokeColor(th.border).stroke().restore();
      if (i > 0) continuationStrip(c, i + 1, range.count);
      footer(c, i + 1, range.count);
      if (s.watermark) watermark(c, s.watermark);
    }
    pdf.end();
  } catch (e) {
    pdf.end();
    throw e;
  }
  return done;
}
