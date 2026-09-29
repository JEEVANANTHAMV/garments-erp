import { code128Svg } from '../../lib/barcode';

/**
 * Bundle barcode labels printed in one go (client call 29-Sep-2026): every
 * bundle generated comes out as a compact sticker with a scannable Code 128
 * barcode, laid out label after label on the sheet — not one big card per page.
 * Opens its own print window so only the labels print.
 */
export type LabelLayout = { cols: number; widthMm: number; heightMm: number };
export const LABEL_LAYOUTS: Record<string, LabelLayout & { label: string }> = {
  A4_3: { label: 'A4 sheet · 3 across (70 × 37 mm)', cols: 3, widthMm: 70, heightMm: 37 },
  A4_2: { label: 'A4 sheet · 2 across (100 × 50 mm)', cols: 2, widthMm: 100, heightMm: 50 },
  ROLL_50x25: { label: 'Label roll · 50 × 25 mm', cols: 1, widthMm: 50, heightMm: 25 },
};

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function printBundleLabels(bundles: any[], layoutKey = 'A4_3') {
  if (!bundles.length) return;
  const L = LABEL_LAYOUTS[layoutKey] ?? LABEL_LAYOUTS.A4_3;
  const roll = L.cols === 1;
  const small = L.heightMm < 30;
  const labels = bundles.map((b) => {
    const code = String(b.barcode || b.bundle_no);
    const seq = b.bundle_seq ? `${String(b.bundle_seq).padStart(2, '0')}/${b.total_bundles || '?'}` : '';
    return `<div class="lbl">
      <div class="r1"><b>${esc(b.io_no ?? '')}</b><span>${esc((b.part_name || 'TOP').toUpperCase())}${seq ? ` · #${esc(seq)}` : ''}</span></div>
      ${small ? '' : `<div class="r2">${esc(b.style_code ?? '')} · ${esc(b.color_name ?? '')} · <b>${esc(b.size_code ?? '')}</b> · <b>${esc(b.qty)} PCS</b></div>`}
      <div class="bc">${code128Svg(code, { height: small ? 28 : 34 })}</div>
      <div class="r3">${esc(code)}${small ? ` · ${esc(b.size_code ?? '')} · ${esc(b.qty)}P` : ''}</div>
    </div>`;
  }).join('');
  const w = window.open('', '_blank', 'width=1000,height=800');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Bundle labels (${bundles.length})</title>
<style>
  @page { ${roll ? `size: ${L.widthMm}mm ${L.heightMm}mm; margin: 0;` : 'size: A4; margin: 8mm;'} }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, sans-serif; color: #000; }
  .sheet { display: grid; grid-template-columns: repeat(${L.cols}, ${L.widthMm}mm); gap: ${roll ? 0 : '2mm'}; }
  .lbl { width: ${L.widthMm}mm; height: ${L.heightMm}mm; padding: 1.5mm 2mm; border: ${roll ? 'none' : '1px dashed #bbb'};
         overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; page-break-inside: avoid; break-inside: avoid; }
  ${roll ? '.lbl { page-break-after: always; }' : ''}
  .r1 { display: flex; justify-content: space-between; font-size: ${small ? 7 : 9}pt; }
  .r2 { font-size: 7.5pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bc { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
  .bc svg { width: 100%; height: 100%; max-height: ${small ? 11 : 16}mm; }
  .r3 { text-align: center; font-family: monospace; font-size: ${small ? 6.5 : 7.5}pt; white-space: nowrap; overflow: hidden; }
  .bar { position: sticky; top: 0; background: #f1f5f9; padding: 8px; font-size: 13px; display: flex; gap: 12px; align-items: center; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><b>${bundles.length} bundle label(s)</b> · ${esc(L.label)} <button onclick="window.print()">Print</button></div>
<div class="sheet">${labels}</div>
<script>window.onload = () => setTimeout(() => window.print(), 300);</script>
</body></html>`);
  w.document.close();
}
