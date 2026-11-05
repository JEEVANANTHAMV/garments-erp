/**
 * Text helpers shared by every printout: WinAnsi-safe text for the built-in PDF fonts, money / qty formats and
 * currency-aware amount in words (client voice notes 05-Nov-2026: "US Dollars … and … Cents Only" for a USD PO,
 * Indian Rupees with lakh / crore for INR, any other currency from cfg_currency handled generically).
 */

/** Built-in PDF fonts are WinAnsi: keep Latin-1 + common punctuation, ₹ → "Rs.", anything else → '?'. */
const ALLOWED_EXTRA = new Set(['—', '–', '‘', '’', '“', '”', '•', '…', '€', '™', '·']);
export function pdfSafe(v: unknown): string {
  return String(v ?? '')
    .replace(/₹\s?/g, 'Rs. ')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('')
    .map((ch) => (ch === '\n' || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0xff) || ALLOWED_EXTRA.has(ch) ? ch : '?'))
    .join('');
}

/* ------------------------------------------------------------------ numbers */
export const fmtMoney = (v: number, code = 'INR', decimals = 2) =>
  (Number(v) || 0).toLocaleString(code === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const fmtQty = (v: number, decimals = 3) =>
  (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const fmtRate = (v: number) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const fmtPct = (v: number) => `${Number((Number(v) || 0).toFixed(2))}`;
/** "2026-11-05" → "05-Nov-2026" (anything else is returned as it is). */
export function fmtDate(d: string | null | undefined): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return d ?? '-';
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1] ?? d.slice(5, 7);
  return `${d.slice(8, 10)}-${m}-${d.slice(0, 4)}`;
}

/* ------------------------------------------------------------------ words */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const below100 = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
function below1000(n: number) {
  const h = Math.floor(n / 100); const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? `${h ? 'and ' : ''}${below100(r)}` : ''].filter(Boolean).join(' ');
}

/** Indian grouping: 41328 → "Forty One Thousand Three Hundred and Twenty Eight"; 1,25,00,000 → "One Crore Twenty Five Lakh". */
export function indianWords(whole: number): string {
  let n = Math.floor(Math.abs(whole));
  if (!n) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(n < 100 && parts.length ? `and ${below100(n)}` : below1000(n));
  return parts.join(' ');
}

/** International grouping (thousand / million / billion): 1234567 → "One Million Two Hundred and Thirty Four Thousand Five Hundred and Sixty Seven". */
export function internationalWords(whole: number): string {
  let n = Math.floor(Math.abs(whole));
  if (!n) return 'Zero';
  const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];
  const groups: number[] = [];
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  const out: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (!g) continue;
    const w = i === 0 && groups.length > 1 && g < 100 ? `and ${below100(g)}` : below1000(g);
    out.push(`${w}${scales[i] ? ` ${scales[i]}` : ''}`);
  }
  return out.join(' ');
}

/** Currency names for the words line: [major (plural), minor (plural), decimals]. Others come from cfg_currency. */
const CURRENCY_WORDS: Record<string, [string, string, number]> = {
  INR: ['Indian Rupees', 'Paise', 2], USD: ['US Dollars', 'Cents', 2], EUR: ['Euros', 'Cents', 2], GBP: ['Pounds Sterling', 'Pence', 2],
  AED: ['UAE Dirhams', 'Fils', 2], AUD: ['Australian Dollars', 'Cents', 2], CAD: ['Canadian Dollars', 'Cents', 2], JPY: ['Japanese Yen', 'Sen', 0],
  SEK: ['Swedish Kronor', 'Ore', 2], DKK: ['Danish Kroner', 'Ore', 2], NOK: ['Norwegian Kroner', 'Ore', 2], CHF: ['Swiss Francs', 'Rappen', 2],
  SGD: ['Singapore Dollars', 'Cents', 2], HKD: ['Hong Kong Dollars', 'Cents', 2], CNY: ['Chinese Yuan', 'Fen', 2], BDT: ['Bangladeshi Taka', 'Poisha', 2],
  LKR: ['Sri Lankan Rupees', 'Cents', 2], NZD: ['New Zealand Dollars', 'Cents', 2], ZAR: ['South African Rand', 'Cents', 2],
};

export interface WordsCurrency {
  code: string;
  /** cfg_currency.name ("Indian Rupee") — used for currencies not in the built-in list */
  name?: string | null;
  /** cfg_currency.decimal_place */
  decimals?: number | null;
}

/**
 * Amount in words in the document's currency:
 *   INR 41328.5  → "Indian Rupees Forty One Thousand Three Hundred and Twenty Eight and Fifty Paise Only"
 *   USD 1234.56  → "US Dollars One Thousand Two Hundred and Thirty Four and Fifty Six Cents Only"
 *   JPY 1200     → "Japanese Yen One Thousand Two Hundred Only"
 * Codes not in the list print cfg_currency.name as stored ("Thai Baht … and … Cents Only").
 */
export function amountInWords(amount: number, cur: WordsCurrency | string): string {
  const c: WordsCurrency = typeof cur === 'string' ? { code: cur } : cur;
  const code = String(c.code || 'INR').toUpperCase();
  const known = CURRENCY_WORDS[code];
  const decimals = known ? known[2] : Math.max(0, Math.min(3, Number(c.decimals ?? 2)));
  const major = known ? known[0] : String(c.name || code).trim();
  const minor = known ? known[1] : 'Cents';
  const scale = 10 ** decimals;
  const totalMinor = Math.round(Math.abs(Number(amount) || 0) * scale);
  const whole = Math.floor(totalMinor / scale);
  const frac = decimals ? totalMinor % scale : 0;
  const words = code === 'INR' ? indianWords(whole) : internationalWords(whole);
  const fracWords = frac ? (code === 'INR' ? indianWords(frac) : internationalWords(frac)) : '';
  return `${amount < 0 ? 'Minus ' : ''}${major} ${words}${frac ? ` and ${fracWords} ${minor}` : ''} Only`;
}
