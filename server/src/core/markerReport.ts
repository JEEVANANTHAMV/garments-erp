/**
 * CAD marker report reader (client voice note 05-Oct-2026): the CAD prints a "Marker report" PDF per marker — marker
 * width / length / efficiency, the size ratio, fabric usage and the marker layout picture that goes to cutting.
 * Uploading that PDF on a marker keeps the PDF, pulls out the layout picture (a small JPEG, shown beside the marker)
 * and reads the figures so the marker can be filled from it.
 *
 * Small, dependency-free PDF reader: objects + streams (raw / Flate), text by position (Td / Tm / TJ / Tj), DCT images.
 * Written for the Gemini (Lectra) marker report; other CAD reports still give their picture and whatever labels match.
 */
import { inflateSync } from 'node:zlib';

interface PdfObject { num: number; dict: string; stream: Buffer | null }
export interface PdfImage { name: string; width: number; height: number; jpeg: Buffer }
interface TextItem { x: number; y: number; text: string }

function readObjects(buf: Buffer): PdfObject[] {
  const s = buf.toString('latin1');
  const out: PdfObject[] = [];
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    let dict = body;
    let stream: Buffer | null = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)![0].length;
      const lenM = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      let dataEnd = lenM ? dataStart + Number(lenM[1]) : -1;
      if (dataEnd < 0 || dataEnd > buf.length || s.slice(dataEnd, dataEnd + 40).indexOf('endstream') < 0) dataEnd = s.indexOf('endstream', dataStart);
      let raw = buf.subarray(dataStart, dataEnd);
      if (/\/FlateDecode/.test(dict)) { try { raw = inflateSync(raw); } catch { /* leave raw */ } }
      stream = raw;
    }
    out.push({ num: Number(m[1]), dict, stream });
    re.lastIndex = end;
  }
  return out;
}

function pdfString(lit: string): string {
  return lit.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e;
  });
}

/** Text runs with their position from a content stream. */
function textItems(content: string): TextItem[] {
  const items: TextItem[] = [];
  const blocks = content.match(/BT[\s\S]*?ET/g) ?? [];
  for (const b of blocks) {
    let x = 0; let y = 0;
    const tok = /(-?[\d.]+)\s+(-?[\d.]+)\s+Td|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|\((?:\\.|[^\\)])*\)\s*Tj|\[((?:\\.|[^\]])*)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj/g;
    let t: RegExpExecArray | null;
    while ((t = tok.exec(b))) {
      if (t[1] !== undefined) { x += Number(t[1]); y += Number(t[2]); continue; }
      if (t[3] !== undefined) { x = Number(t[7]); y = Number(t[8]); continue; }
      let text = '';
      if (t[0].startsWith('(')) text = pdfString(t[0].slice(1, t[0].lastIndexOf(')')));
      else if (t[9] !== undefined) text = (t[9].match(/\((?:\\.|[^\\)])*\)/g) ?? []).map((p) => pdfString(p.slice(1, -1))).join('');
      else if (t[10] !== undefined) { const h = t[10].replace(/\s/g, ''); for (let i = 0; i + 1 < h.length; i += 2) text += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); }
      if (text.trim()) items.push({ x, y, text: text.trim() });
    }
  }
  return items;
}

/** Rows of cells, top to bottom, each row left to right. */
function rows(items: TextItem[]): string[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const out: { y: number; cells: TextItem[] }[] = [];
  for (const it of sorted) {
    const r = out.find((o) => Math.abs(o.y - it.y) <= 2.5);
    if (r) r.cells.push(it); else out.push({ y: it.y, cells: [it] });
  }
  return out.map((r) => r.cells.sort((a, b) => a.x - b.x).map((c) => c.text));
}

export interface MarkerReport {
  source: 'GEMINI' | 'UNKNOWN';
  order_name: string | null; model: string | null; report_time: string | null;
  marker_width_in: number | null; marker_length_m: number | null; efficiency_pct: number | null;
  sizes: string[]; quantities: number[]; pieces: number[];
  /** sizes actually on the marker (quantity > 0) and their ratio */
  ratio_sizes: string[]; ratios: number[];
  /** garments one marker cuts (Σ size quantity) and the panels placed on it */
  garments_per_marker: number | null; panels_per_marker: number | null; products: number | null;
  used_sqm: number | null; wasted_sqm: number | null; average_m: number | null;
  rows: string[][];
}

const numOf = (v: string | undefined | null) => { const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

export function readMarkerReport(pdf: Buffer): { report: MarkerReport; images: PdfImage[] } {
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Not a PDF file');
  const objs = readObjects(pdf);
  const images: PdfImage[] = [];
  let content = '';
  for (const o of objs) {
    if (!o.stream) continue;
    if (/\/Subtype\s*\/Image/.test(o.dict)) {
      if (/\/DCTDecode/.test(o.dict)) {
        images.push({ name: (o.dict.match(/\/Name\s*\/(\w+)/)?.[1]) ?? `IMG${o.num}`, width: Number(o.dict.match(/\/Width\s+(\d+)/)?.[1] ?? 0),
          height: Number(o.dict.match(/\/Height\s+(\d+)/)?.[1] ?? 0), jpeg: Buffer.from(o.stream) });
      }
      continue;
    }
    if (/\/Type\s*\/(Font|FontDescriptor|XObject)|\/Length1/.test(o.dict)) continue;
    const txt = o.stream.toString('latin1');
    if (/\bBT\b/.test(txt) && /\bET\b/.test(txt)) content += `\n${txt}`;
  }
  const rs = rows(textItems(content));
  const flat = rs.map((r) => r.join(' | '));
  // value cell right after a label cell (labels are cut short by the CAD: "Quantitie", "No. piec", "Total number of p")
  const after = (label: RegExp) => { for (const r of rs) { const i = r.findIndex((c) => label.test(c)); if (i >= 0 && i + 1 < r.length) return r[i + 1]; } return null; };
  const rowAfter = (label: RegExp) => { const r = rs.find((x) => label.test(x[0] ?? '')); return r ? r.slice(1) : []; };
  const sizes = rowAfter(/^Sizes?$/i);
  const quantities = rowAfter(/^Quantit/i).map((v) => numOf(v) ?? 0);
  const pieces = rowAfter(/^No\.?\s*pie/i).map((v) => numOf(v) ?? 0);
  const usedRow = rs.find((r) => /^Surface$/i.test(r[0] ?? '')) ?? [];
  const ratioSizes: string[] = []; const ratios: number[] = [];
  sizes.forEach((sz, i) => { if ((quantities[i] ?? 0) > 0) { ratioSizes.push(sz); ratios.push(quantities[i]); } });
  const gemini = flat.some((l) => /Marker report/i.test(l)) && flat.some((l) => /Marker efficiency/i.test(l));
  const report: MarkerReport = {
    source: gemini ? 'GEMINI' : 'UNKNOWN',
    order_name: after(/^Order name$/i), model: (rs.find((r) => /^Model:?$/i.test(r[0] ?? ''))?.[1]) ?? null, report_time: after(/^Date\/Time$/i),
    marker_width_in: numOf(after(/^Marker width$/i)), marker_length_m: numOf(after(/^Marker length$/i)), efficiency_pct: numOf(after(/^Marker efficiency$/i)),
    sizes, quantities, pieces, ratio_sizes: ratioSizes, ratios,
    garments_per_marker: ratios.length ? ratios.reduce((a, b) => a + b, 0) : numOf(after(/^Number products$/i)),
    panels_per_marker: numOf(after(/^Number of placed/i)) ?? numOf(after(/^Total number of p/i)), products: numOf(after(/^Number products$/i)),
    used_sqm: numOf(usedRow[1]), wasted_sqm: numOf(usedRow[2]), average_m: numOf(usedRow[3]),
    rows: rs,
  };
  // the order name can sit before its label on some reports
  if (!report.order_name) { const r = rs.find((x) => x.some((c) => /^Order name$/i.test(c))); if (r) report.order_name = r.find((c) => !/^Order name$/i.test(c) && !/Date\/Time/.test(c)) ?? null; }
  return { report, images: images.sort((a, b) => b.width * b.height - a.width * a.height) };
}
