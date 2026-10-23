import { createRequire } from 'node:module';

/**
 * Reads the customs shipping bill PDF (ICEGATE "LET EXPORT COPY", 14–15 pages) — client voice note 23-Oct-2026:
 * "import the PDF, pick the fields automatically, we correct what is wrong". Only pages 1–2 are read (Part I summary
 * and Part II invoice details); every value sits in the cell under its caption, so a value is the nearest text just
 * below the caption and inside its width. The PDF itself is only stored (a file), never read again — no load on the
 * screens. A scanned / non-ICEGATE PDF returns nothing and the fields are entered by hand.
 */
const require = createRequire(import.meta.url);
// legacy build: runs on Node 20 (prod) without browser APIs
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

interface Item { p: number; x: number; y: number; w: number; s: string }

const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
/** 13-OCT-26 / 13-OCT-2026 / 12/10/2026 → 2026-10-13 */
export function sbDate(s: string | null | undefined) {
  const t = String(s ?? '').trim().toUpperCase();
  let m = /^(\d{1,2})-([A-Z]{3})-(\d{2,4})$/.exec(t);
  if (m && MONTHS[m[2]]) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
const num = (s: string | null | undefined) => {
  if (s == null) return null;
  const m = /-?\d[\d,]*(\.\d+)?/.exec(String(s));
  return m ? Number(m[0].replace(/,/g, '')) : null;
};

async function readItems(buf: Buffer, maxPages = 2) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const items: Item[] = [];
  for (let p = 1; p <= Math.min(maxPages, doc.numPages); p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    for (const it of tc.items as any[]) {
      const s = String(it.str ?? '').trim();
      if (s) items.push({ p, x: it.transform[4], y: it.transform[5], w: it.width, s });
    }
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { items, pages };
}

/** The value in the cell under a caption: nearest text 4–18 pt lower whose centre lies inside the caption's width. */
function below(items: Item[], page: number, label: RegExp, opts: { slack?: number; maxDy?: number; pick?: RegExp } = {}) {
  const lab = items.find((i) => i.p === page && label.test(i.s));
  if (!lab) return null;
  const slack = opts.slack ?? 14;
  const cands = items.filter((i) => i.p === page && i !== lab && i.y < lab.y - 3 && i.y > lab.y - (opts.maxDy ?? 18)
    && i.x + i.w / 2 >= lab.x - slack && i.x + i.w / 2 <= lab.x + lab.w + slack && !/^\d+\.\s?[A-Z]/.test(i.s) && (!opts.pick || opts.pick.test(i.s)));
  cands.sort((a, b) => (lab.y - a.y) - (lab.y - b.y) || Math.abs(a.x + a.w / 2 - (lab.x + lab.w / 2)) - Math.abs(b.x + b.w / 2 - (lab.x + lab.w / 2)));
  return cands[0]?.s ?? null;
}

export interface SbPdfFields {
  sb_no: string | null; sb_date: string | null; port_code: string | null; mode: 'AIR' | 'SEA' | null;
  invoice_no: string | null; invoice_date: string | null; invoice_value_fc: number | null; currency_code: string | null;
  exchange_rate: number | null; fob_inr: number | null; freight_inr: number | null; insurance_inr: number | null;
  drawback_amount: number | null; igst_value: number | null; igst_amount: number | null; rodtep_amount: number | null; rosctl_amount: number | null;
  leo_date: string | null;
}

export async function extractShippingBill(buf: Buffer): Promise<{ fields: SbPdfFields; pages: number; found: number }> {
  const { items, pages } = await readItems(buf, 2);
  if (!items.some((i) => /^SB No$/i.test(i.s)) || !items.some((i) => /SHIPPING BILL SUMMARY|INDIAN CUSTOMS EDI SYSTEM/i.test(i.s))) {
    throw new Error(items.length ? 'This is not an ICEGATE shipping bill (LET EXPORT COPY) — the fields could not be read' : 'The PDF has no text (scanned?) — enter the fields by hand');
  }
  const p1 = (re: RegExp, o?: Parameters<typeof below>[3]) => below(items, 1, re, o);
  const p2 = (re: RegExp, o?: Parameters<typeof below>[3]) => below(items, 2, re, o);
  const mode = (p1(/^1\.MODE$/i) ?? '').toUpperCase();
  const invNoDt = p2(/^2\.INVOICE No\. & Dt\.?$/i) ?? '';
  const xr = p2(/^9\.EXCHANGE RATE$/i, { maxDy: 18 });
  const xrM = /^1\s+([A-Z]{3})\s+INR\s+([\d.]+)/i.exec(xr ?? '');
  const fields: SbPdfFields = {
    sb_no: p1(/^SB No$/i, { pick: /^\d{5,}$/ }),
    sb_date: sbDate(p1(/^SB Date$/i)),
    port_code: p1(/^Port Code$/i, { pick: /^[A-Z]{5}\d?$/ }),
    mode: mode === 'AIR' ? 'AIR' : mode === 'SEA' ? 'SEA' : null,
    invoice_no: p1(/^2\.INV NO\.?$/i) ?? (invNoDt.split(/\s+/)[0] || null),
    invoice_date: sbDate(invNoDt.split(/\s+/)[1]),
    invoice_value_fc: num(p1(/^3\.\s?INV AMT\.?$/i)),
    currency_code: (p1(/^4\.CURRENC/i, { pick: /^[A-Z]{3}$/ }) ?? xrM?.[1] ?? null)?.toUpperCase() ?? null,
    exchange_rate: xrM ? Number(xrM[2]) : null,
    fob_inr: num(p1(/^1\.FOB VALUE$/i)),
    freight_inr: num(p1(/^2\.FREIGHT$/i)),
    insurance_inr: num(p1(/^3\.INSURANC/i)),
    drawback_amount: num(p1(/^1\.DBK CLAIM$/i)),
    igst_amount: num(p1(/^2\.\s?IGST AMT$/i)),
    igst_value: num(p1(/^4\.IGST VALUE$/i)),
    rodtep_amount: num(p1(/^5\.RODTEP AMT$/i)),
    rosctl_amount: num(p1(/^6\.ROSCTL AMT$/i)),
    leo_date: sbDate(p1(/^6\.LEO Date\.?$/i, { slack: 120 })),
  };
  const found = Object.values(fields).filter((v) => v != null).length;
  return { fields, pages, found };
}
