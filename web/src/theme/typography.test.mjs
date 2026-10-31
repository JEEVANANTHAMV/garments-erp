import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Dedicated print layouts keep fixed px sizes until the client finalises print formats.
const PRINT_LAYOUTS = new Set(['JobWorkInvoicePrint.tsx', 'BomPrint.tsx', 'PackingListPrint.tsx', 'InvoiceDocument.tsx']);
const src = new URL('..', import.meta.url).pathname;
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.tsx') && !PRINT_LAYOUTS.has(e.name) ? [join(dir, e.name)] : []);

const offenders = (pattern, allow = () => false) => files(src).flatMap((file) =>
  readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
    pattern.test(line) && !allow(line) ? [`${file.slice(src.length)}:${i + 1}`] : []));

test('screens use the theme font, not monospace (code / JSON blocks excepted)', () => {
  assert.deepEqual(offenders(/\bfont-mono\b/, (l) => /<pre|<code|JSON\.stringify/.test(l)), []);
});

test('screens use the type scale instead of hard-coded px sizes', () => {
  // 23px brand wordmark and 26px e-way bill number are deliberate display sizes.
  assert.deepEqual(offenders(/\btext-\[\d+(\.\d+)?px\]/, (l) => /text-\[(23|26)px\]/.test(l)), []);
});

test('screens use regular / medium / semibold / bold weights only', () => {
  assert.deepEqual(offenders(/\bfont-(black|extrabold|thin|extralight)\b/), []);
});

test('screens use theme colour tokens instead of generic light greys (dark code / overlay shades excepted)', () => {
  assert.deepEqual(offenders(/(?<![\w-])(text-slate-(300|400|500|600|700|800|900)|(bg|border|divide|ring)-slate-(50|100|200|300))(?![\d])/), []);
});
