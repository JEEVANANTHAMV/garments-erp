// Same as server/src/modules/invoice/invoiceWords.ts — the editor shows the words live (client 24-Oct-2026).
/**
 * Numbers in words for the commercial invoice, in the style of the client's FK-087 sheet (British "and", upper case,
 * international thousands / millions): 17850 → "SEVENTEEN THOUSAND EIGHT HUNDRED AND FIFTY".
 */
const ONES = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN',
  'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
const SCALES = ['', 'THOUSAND', 'MILLION', 'BILLION'];

function below1000(n: number, andBefore: boolean) {
  const h = Math.floor(n / 100); const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} HUNDRED`);
  if (rest) {
    const t = rest < 20 ? ONES[rest] : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? ` ${ONES[rest % 10]}` : ''}`;
    parts.push(h || andBefore ? `AND ${t}` : t);
  }
  return parts.join(' ');
}

export function intWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'ZERO';
  const groups: number[] = [];
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  const out: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    // "… THOUSAND AND FIFTY" when the last group has no hundreds
    const w = below1000(groups[i], i === 0 && groups.length > 1 && groups[i] < 100);
    out.push(`${w}${SCALES[i] ? ` ${SCALES[i]}` : ''}`);
  }
  return out.join(' ');
}

const CURRENCY: Record<string, [string, string]> = {
  USD: ['U.S. DOLLARS', 'CENTS'], EUR: ['EUROS', 'CENTS'], GBP: ['POUNDS STERLING', 'PENCE'], INR: ['INDIAN RUPEES', 'PAISE'],
  AED: ['UAE DIRHAMS', 'FILS'], AUD: ['AUSTRALIAN DOLLARS', 'CENTS'], CAD: ['CANADIAN DOLLARS', 'CENTS'], JPY: ['JAPANESE YEN', 'SEN'],
  SEK: ['SWEDISH KRONOR', 'ORE'], DKK: ['DANISH KRONER', 'ORE'], NOK: ['NORWEGIAN KRONER', 'ORE'], CHF: ['SWISS FRANCS', 'RAPPEN'],
};

/** "TOTAL IN U.S. DOLLARS: SEVENTEEN THOUSAND EIGHT HUNDRED AND FIFTY ONLY" (cents when there are any). */
export function amountWords(amount: number, currency: string | null | undefined) {
  const [name, sub] = CURRENCY[String(currency ?? '').toUpperCase()] ?? [String(currency ?? '').toUpperCase(), 'CENTS'];
  const cents = Math.round(Math.abs(amount) * 100) % 100;
  const whole = Math.floor(Math.round(Math.abs(amount) * 100) / 100);
  return `TOTAL IN ${name}: ${intWords(whole)}${cents ? ` AND ${sub} ${intWords(cents)}` : ''} ONLY`;
}

/** "(TOTAL PCS: TWO THOUSAND EIGHT HUNDRED ONLY.)" */
export function qtyWords(qty: number, unit: string | null | undefined) {
  return `(TOTAL ${String(unit || 'PCS').toUpperCase()}: ${intWords(Math.round(qty))} ONLY.)`;
}
