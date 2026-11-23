import { code128Svg } from '../../lib/barcode';

/**
 * Fabric roll labels (client doc "Fabric Roll Management" §8): every roll and every cut piece gets its own sticker —
 * roll no as a Code 128 barcode (the store scanners read roll nos), fabric, lot / shade, GSM / Dia, KG in store,
 * meter, job and where the piece was cut from. The server logs every print / reprint (POST /inventory/fabric-rolls/labels).
 */
export const ROLL_LABEL_LAYOUTS: Record<string, { label: string; cols: number; widthMm: number; heightMm: number }> = {
  A4_2: { label: 'A4 sheet · 2 across (100 × 50 mm)', cols: 2, widthMm: 100, heightMm: 50 },
  A4_3: { label: 'A4 sheet · 3 across (70 × 37 mm)', cols: 3, widthMm: 70, heightMm: 37 },
  ROLL_100x50: { label: 'Label roll · 100 × 50 mm', cols: 1, widthMm: 100, heightMm: 50 },
};

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const kg = (v: unknown) => (Math.round((Number(v) || 0) * 1000) / 1000).toFixed(3);

export function printRollLabels(rows: any[], layoutKey = 'A4_2') {
  if (!rows.length) return;
  const L = ROLL_LABEL_LAYOUTS[layoutKey] ?? ROLL_LABEL_LAYOUTS.A4_2;
  const roll = L.cols === 1;
  const small = L.heightMm < 45;
  const labels = rows.map((r) => {
    const gsm = r.actual_gsm || r.gsm;
    const spec = [gsm ? `${Math.round(Number(gsm))} GSM` : null, r.dia ? `Dia ${r.dia}` : null].filter(Boolean).join(' · ');
    const lotShade = [r.lot_no, r.shade || r.color_name].filter(Boolean).join(' / ');
    return `<div class="lbl">
      <div class="r1"><b>${esc(r.fabric_name ?? 'Fabric')}</b><span>${esc(r.job_no ?? '')}</span></div>
      <div class="r2">${esc(lotShade || '—')}${spec ? ` · ${esc(spec)}` : ''}</div>
      <div class="bc">${code128Svg(String(r.roll_no), { height: small ? 30 : 38 })}</div>
      <div class="r3"><b>${esc(r.roll_no)}</b></div>
      <div class="r4"><span><b>${esc(kg(r.balance_kg))} KG</b>${Number(r.meters) > 0 && !small ? ` · ${esc(Number(r.meters).toFixed(1))} M` : ''}</span>
        <span>${r.parent_roll_no ? `cut from ${esc(r.parent_roll_no)}` : esc(r.grn_no ?? '')}</span></div>
      ${small ? '' : `<div class="r5">${esc(r.warehouse_name ?? '')}${r.location_bin ? ` / ${esc(r.location_bin)}` : ''}${r.supplier_roll_no ? ` · supplier roll ${esc(r.supplier_roll_no)}` : ''}</div>`}
    </div>`;
  }).join('');
  const w = window.open('', '_blank', 'width=1000,height=800');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Roll labels (${rows.length})</title>
<style>
  @page { ${roll ? `size: ${L.widthMm}mm ${L.heightMm}mm; margin: 0;` : 'size: A4; margin: 8mm;'} }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, sans-serif; color: #000; }
  .sheet { display: grid; grid-template-columns: repeat(${L.cols}, ${L.widthMm}mm); gap: ${roll ? 0 : '2mm'}; }
  .lbl { width: ${L.widthMm}mm; height: ${L.heightMm}mm; padding: 1.5mm 2.5mm; border: ${roll ? 'none' : '1px dashed #bbb'};
         overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; page-break-inside: avoid; break-inside: avoid; }
  ${roll ? '.lbl { page-break-after: always; }' : ''}
  .r1, .r4 { display: flex; justify-content: space-between; gap: 2mm; font-size: ${small ? 7 : 9}pt; white-space: nowrap; overflow: hidden; }
  .r2, .r5 { font-size: ${small ? 6.5 : 7.5}pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bc { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
  .bc svg { width: 100%; height: 100%; max-height: ${small ? 11 : 15}mm; }
  .r3 { text-align: center; font-size: ${small ? 8 : 10}pt; letter-spacing: 0.5px; }
  .bar { position: sticky; top: 0; background: #f1f5f9; padding: 8px; font-size: 13px; display: flex; gap: 12px; align-items: center; }
  @media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><b>${rows.length} roll label(s)</b> · ${esc(L.label)} <button onclick="window.print()">Print</button></div>
<div class="sheet">${labels}</div>
<script>window.onload = () => setTimeout(() => window.print(), 300);</script>
</body></html>`);
  w.document.close();
}
