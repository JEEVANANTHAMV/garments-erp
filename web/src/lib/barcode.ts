/**
 * Code 128 (set B) barcode as an SVG string — scannable by any bundle scanner,
 * no external library. Covers printable ASCII (space … ~), which is what bundle
 * numbers and barcodes use.
 */
const PATTERNS = [
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
const START_B = 104;
const STOP = 106;

/** Module widths (bar, space, bar, …) for the text, including start, checksum and stop. */
export function code128Modules(text: string): number[] {
  const codes = [START_B];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    codes.push(c >= 32 && c <= 126 ? c - 32 : 0);
  }
  let sum = START_B;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103, STOP);
  return codes.flatMap((c) => PATTERNS[c].split('').map(Number));
}

/** SVG markup for the barcode; `height` in px, quiet zone of 10 modules each side. */
export function code128Svg(text: string, { height = 40, module = 1.4, showText = false } = {}): string {
  const mods = code128Modules(text);
  const total = mods.reduce((a, b) => a + b, 0) + 20;
  let x = 10;
  let bars = '';
  mods.forEach((w, i) => {
    if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`;
    x += w;
  });
  const textH = showText ? 12 : 0;
  const safe = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total * module}" height="${height + textH}" viewBox="0 0 ${total} ${height + textH}" preserveAspectRatio="none" shape-rendering="crispEdges">`
    + `<g fill="#000">${bars}</g>`
    + (showText ? `<text x="${total / 2}" y="${height + 10}" font-family="monospace" font-size="9" text-anchor="middle">${safe}</text>` : '')
    + `</svg>`;
}
